// The live-games board, against a relay whose answers this file chose.
//
//   npm run build && npm run preview &
//   node test/lobby.mjs
//
// The lobby is a claim about other people: "three of eight seats taken in room
// `pit`". There is no server holding that, so it is assembled from presence
// beacons other clients signed — which means the only way to check it is to be
// the one who signed them.
//
// What matters here and is easy to get wrong:
//
//   * a player who republished is one player, not two (addressable events come
//     back in both versions);
//   * a full table offers a queue rather than a seat, and an empty one does not;
//   * spectators and queuers are not seated, so they never eat a seat;
//   * a beacon far past its expiry is a ghost and does not hold a chair.

import { existsSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import puppeteer from 'puppeteer-core'

const SITE = process.env.TANK_URL ?? 'http://localhost:4173/'
if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(SITE)) {
  console.log(`SKIP  the lobby checks need a plain-http origin; TANK_URL is ${SITE}`)
  console.log('      the ws:// fake relay is blocked as mixed content from https.')
  process.exit(0)
}

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]
  .filter(Boolean)
  .find((p) => existsSync(p))
if (!CHROME) {
  console.error('No Chrome found. Set CHROME_PATH.')
  process.exit(2)
}

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 15_000, step = 200) {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) return null
    await wait(step)
  }
}

const KIND_PRESENCE = 30078
const KIND_STATE = 21000
const KIND_SESSION = 21003
/** Every event kind this relay was handed, in order. The spectator control. */
const seen = []
const PRESENCE_D = 'nostr-tank-arena/here'
const PRESENCE_TAG = 'tankarena-live'
const TTL = 120

const now = Math.floor(Date.now() / 1000)
const key = () => {
  const sk = generateSecretKey()
  return { sk, pk: getPublicKey(sk) }
}

const beacon = (who, room, name, role, at = now, extra = {}) =>
  finalizeEvent(
    {
      kind: KIND_PRESENCE,
      created_at: at,
      tags: [
        ['d', PRESENCE_D],
        ['t', PRESENCE_TAG],
        ['t', `tankarena-${room}`],
        ['expiration', String(at + TTL)],
      ],
      content: JSON.stringify({
        room,
        name,
        hue: 200,
        role,
        at,
        layout: 'Pillars',
        block: 913000,
        ...extra,
      }),
    },
    who.sk,
  )

// `pit` is full: every seat taken, one person waiting and one watching.
// `yard` has two seats gone. `stale` had one player an hour ago and nobody now.
const SEATS = 8 // mirrors SEATS in src/rooms.ts
const pit = Array.from({ length: SEATS }, key)
const waiting = key()
const watcher = key()
const yard = ['e', 'f'].map(key)
const ghost = key()
const twice = pit[0]

const BEACONS = [
  ...pit.map((k, i) => beacon(k, 'pit', `pit${i}`, 'seat')),
  // The same player again, newer. An addressable event legitimately comes back
  // in both versions, and counting it twice would make a full room show one
  // person too many and lose a chair.
  beacon(twice, 'pit', 'pit0', 'seat', now - 5),
  beacon(waiting, 'pit', 'queued', 'queue'),
  beacon(watcher, 'pit', 'lurker', 'watch'),
  ...yard.map((k, i) => beacon(k, 'yard', `yard${i}`, 'seat')),
  // Three TTLs old. A relay that kept it past its expiration must not be able
  // to hold a seat with it.
  beacon(ghost, 'stale', 'ghost', 'seat', now - TTL * 4),
]

const wss = new WebSocketServer({ port: 0 })
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg[0] === 'EVENT') {
      seen.push(msg[1].kind)
      return ws.send(JSON.stringify(['OK', msg[1].id, true, '']))
    }
    if (msg[0] !== 'REQ') return
    const [, id, ...filters] = msg
    for (const f of filters) {
      const tags = f['#t'] ?? []
      if (tags.includes(PRESENCE_TAG)) {
        for (const e of BEACONS) ws.send(JSON.stringify(['EVENT', id, e]))
      }
    }
    ws.send(JSON.stringify(['EOSE', id]))
  })
})
const relayUrl = `ws://localhost:${wss.address().port}`

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--mute-audio',
  ],
})

try {
  const page = await browser.newPage()
  // Forwarded because the beacon path deliberately swallows publish failures —
  // a refused beacon is not worth a message on top of a game — and this is the
  // only place that decision is debuggable from.
  page.on('pageerror', (err) => console.log('      page error:', err.message))
  await page.setViewport({ width: 900, height: 1000 })
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  // The lobby polls with whatever is in the relay box, so this has to land
  // before the next poll rather than before the first one.
  await page.$eval('#relays', (el, v) => { el.value = v }, relayUrl)
  await page.click('#live-refresh')

  const rooms = await until(async () => {
    const list = await page.evaluate(() =>
      [...document.querySelectorAll('.live-room')].map((n) => ({
        room: n.querySelector('.lr-name')?.textContent ?? null,
        seats: n.querySelector('.lr-seats')?.textContent ?? null,
        full: n.querySelector('.lr-seats')?.classList.contains('full') ?? false,
        free: n.querySelectorAll('.seat.free').length,
        taken: n.querySelectorAll('.seat.taken').length,
        fine: n.querySelector('.lr-fine')?.textContent ?? null,
        join: n.querySelector('[data-join]')?.textContent ?? null,
        watch: n.querySelector('[data-watch]')?.textContent ?? null,
      })),
    )
    return list.length ? list : null
  })
  check('the lobby finds live games', !!rooms, JSON.stringify(rooms))
  if (!rooms) throw new Error('no rooms rendered')

  // A free seat is a rendered thing now (the faint tank in the dashed ring),
  // so the count above proving the *class* exists is no longer the whole
  // claim — the icon has to have made it into the markup too.
  const freeSeatIcons = await page.evaluate(() => {
    const svgs = [...document.querySelectorAll('.seat.free svg')]
    // Sized as well as present: an svg the stylesheet never matched renders
    // at the 300×150 SVG default and blows the row apart.
    const w = svgs[0] ? Math.round(svgs[0].getBoundingClientRect().width) : 0
    return { count: svgs.length, w }
  })
  const freeSeats = rooms.reduce((n, r) => n + r.free, 0)
  check('every free seat draws its tank silhouette, at seat size',
    freeSeatIcons.count === freeSeats && freeSeatIcons.w >= 8 && freeSeatIcons.w <= 24,
    `${freeSeatIcons.count} icons (${freeSeatIcons.w}px) for ${freeSeats} free seats`)

  if (process.env.TANK_SHOT) {
    await page.evaluate(() => {
      const open = [...document.querySelectorAll('.live-room')].find((n) => n.querySelector('.seat.free'))
      open?.scrollIntoView({ block: 'center' })
    })
    await page.screenshot({ path: process.env.TANK_SHOT })
    console.log(`      wrote ${process.env.TANK_SHOT}`)
  }

  const byName = Object.fromEntries(rooms.map((r) => [r.room, r]))
  check('a room nobody has been in for hours is not live', !byName.stale, JSON.stringify(Object.keys(byName)))
  check('the busy room is listed first', rooms[0].room === 'pit', rooms.map((r) => r.room).join(','))

  check(
    'a full table reads as full',
    byName.pit?.seats === `${SEATS}/${SEATS}` && byName.pit?.full === true,
    JSON.stringify(byName.pit),
  )
  check(
    'one player republishing is still one player',
    byName.pit?.taken === SEATS && byName.pit?.free === 0,
    `${byName.pit?.taken} taken, ${byName.pit?.free} free — ${SEATS + 1} beacons from ${SEATS} people`,
  )
  check(
    'a queued player does not take a seat',
    byName.pit?.fine?.includes('1 waiting'),
    String(byName.pit?.fine),
  )
  check(
    'and neither does a spectator',
    byName.pit?.fine?.includes('1 watching'),
    String(byName.pit?.fine),
  )
  check(
    'a full table offers the queue, not a seat',
    byName.pit?.join === 'Join the queue',
    String(byName.pit?.join),
  )

  check(
    'a room with space shows the empty chairs',
    byName.yard?.seats === `2/${SEATS}` && byName.yard?.free === SEATS - 2 && byName.yard?.taken === 2,
    JSON.stringify(byName.yard),
  )
  check(
    'and offers a seat rather than a queue',
    byName.yard?.join === 'Take a seat' && byName.yard?.full === false,
    String(byName.yard?.join),
  )
  check(
    'the room says what is being played on it',
    byName.yard?.fine?.includes('Pillars') && byName.yard?.fine?.includes('913000'),
    String(byName.yard?.fine),
  )
  check('every room can be watched', rooms.every((r) => r.watch === 'Watch'))

  // --- spectating, and its control -----------------------------------------
  //
  // A spectator is in the room and on the wire with no tank. The claim worth
  // checking is not that they render differently, it is that they do not
  // *publish*: a spectator that ticks is a ninth tank in an eight-seat room,
  // drawn on everybody's board.
  //
  // "No ticks arrived" is a number that also reads zero when the client never
  // connected to this relay at all, so it cannot carry the claim alone. The
  // second half of this section joins a seat instead and requires ticks to
  // arrive, which is what makes the zero above mean something.

  seen.length = 0
  await page.click('.live-room [data-watch]')
  const watching = await page
    .waitForFunction(() => window.__game?.watching === true, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  check('watching a room puts you in it without a tank', watching)

  if (watching) {
    // Wait for the beacon rather than for a stopwatch. This is the window every
    // assertion below is measured over, and a fixed sleep is not one: a
    // four-second wait was long enough on one machine and not on this one, and
    // the failure mode is a suite that reports "the spectator published
    // nothing" about a socket that had not finished connecting. Waiting for a
    // publish that must happen proves the window can contain a publish at all,
    // which is what makes the zeroes underneath it mean something.
    const beaconed = await until(
      () => (seen.filter((k) => k === KIND_PRESENCE).length > 0 ? true : null),
      20_000,
      250,
    )
    check('a spectator says it is watching, so the room can show one', beaconed === true)
    const room = await page.evaluate(() => window.__game.room)
    check('and it is the room that was clicked', room === 'pit', String(room))
    const hidden = await page.evaluate(() => window.__renderer.ownTankVisible === false)
    check('the spectator draws no tank of their own', hidden === true, String(hidden))
    // Same window, now known to be live. A tank would have ticked twenty times
    // in it.
    const ticks = seen.filter((k) => k === KIND_STATE).length
    const attests = seen.filter((k) => k === KIND_SESSION).length
    check('the spectator publishes no ticks', ticks === 0, `${ticks} state events`)
    check('and does not put itself on anybody\'s roster', attests === 0, `${attests} attestations`)
  }

  // The control. Same relay, same page, a seat instead of a gallery — if this
  // does not tick, the zero above was measuring a dead socket.
  const page2 = await browser.newPage()
  await page2.setViewport({ width: 900, height: 1000 })
  await page2.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page2.$eval('#relays', (el, v) => { el.value = v }, relayUrl)
  await page2.click('#live-refresh')
  const seatable = await until(async () =>
    (await page2.evaluate(() => !!document.querySelector('.live-room [data-join]'))) || null)
  check('the control page also sees the lobby', !!seatable)
  seen.length = 0
  await page2.evaluate(() => {
    const rooms = [...document.querySelectorAll('.live-room')]
    const yard = rooms.find((n) => n.querySelector('.lr-name')?.textContent === 'yard')
    yard.querySelector('[data-join]').click()
  })
  const seated = await page2
    .waitForFunction(() => window.__game?.watching === false, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  check('taking a seat starts an ordinary game', seated)
  if (seated) {
    const ticked = await until(
      () => (seen.filter((k) => k === KIND_STATE).length > 0 ? true : null),
      20_000,
      250,
    )
    const ticks = seen.filter((k) => k === KIND_STATE).length
    check(
      'a seated player does tick, which is what makes the zero above mean something',
      ticked === true,
      `${ticks} state events`,
    )
    const drawn = await page2.evaluate(() => window.__renderer.ownTankVisible === true)
    check('and their tank is on the board', drawn === true, String(drawn))
  }

} finally {
  await browser.close()
  wss.close()
}

console.log(failures.length ? `\n${failures.length} failed\n` : '\nAll lobby checks passed.\n')
process.exit(failures.length ? 1 : 0)
