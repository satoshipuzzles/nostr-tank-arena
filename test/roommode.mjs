// The mode is the room's, against a relay whose answers this file chose.
//
//   npm run build && npm run preview &
//   node test/roommode.mjs
//
// Deathmatch is the ambient game; everything else is a created game. That
// promise lives in three mechanisms, and each is checked here end to end:
//
//   * the beacon carries the room's mode (absent = dm, so a beacon written
//     before the field existed still parses as the ambient game);
//   * the live board labels every table and always contains a deathmatch room
//     with an open seat — the standing chain `lobby`, `lobby-2`, …;
//   * a joiner lands in the room's rules, through every door: the room card,
//     a typed room name, and an invite link carrying `?mode=`.

import { existsSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import puppeteer from 'puppeteer-core'

const SITE = process.env.TANK_URL ?? 'http://localhost:4173/'
if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(SITE)) {
  console.log(`SKIP  the room-mode checks need a plain-http origin; TANK_URL is ${SITE}`)
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
const PRESENCE_D = 'nostr-tank-arena/here'
const PRESENCE_TAG = 'tankarena-live'
const TTL = 120
const SEATS = 8 // mirrors SEATS in src/rooms.ts

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
      content: JSON.stringify({ room, name, hue: 200, role, at, ...extra }),
    },
    who.sk,
  )

// Relay one: `pit` is a CTF game — three declared beacons plus one from a
// pre-mode client whose beacon is the NEWEST in the room and says nothing.
// `yard` is two people playing plain deathmatch, no mode field anywhere.
const BEACONS_1 = [
  ...[0, 1, 2].map((i) => beacon(key(), 'pit', `pit${i}`, 'seat', now - 10, { mode: 'ctf' })),
  beacon(key(), 'pit', 'oldtimer', 'seat', now),
  ...[0, 1].map((i) => beacon(key(), 'yard', `yard${i}`, 'seat')),
]
// Relay two: the standing room itself is full, so the chain must offer the
// next name.
const BEACONS_2 = Array.from({ length: SEATS }, (_, i) =>
  beacon(key(), 'lobby', `lob${i}`, 'seat'),
)

/** Presence events pages publish to relay one, parsed. The beacon control. */
const published = []
const serve = (beacons) => {
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
        if (msg[1].kind === KIND_PRESENCE) {
          try {
            published.push(JSON.parse(msg[1].content))
          } catch {}
        }
        return ws.send(JSON.stringify(['OK', msg[1].id, true, '']))
      }
      if (msg[0] !== 'REQ') return
      const [, id, ...filters] = msg
      for (const f of filters) {
        if ((f['#t'] ?? []).includes(PRESENCE_TAG)) {
          for (const e of beacons) ws.send(JSON.stringify(['EVENT', id, e]))
        }
      }
      ws.send(JSON.stringify(['EOSE', id]))
    })
  })
  return { wss, url: `ws://localhost:${wss.address().port}` }
}
const relay1 = serve(BEACONS_1)
const relay2 = serve(BEACONS_2)

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

const readRooms = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.live-room')].map((n) => ({
      room: n.querySelector('.lr-name')?.textContent ?? null,
      mode: n.querySelector('.lr-mode')?.textContent ?? null,
      seats: n.querySelector('.lr-seats')?.textContent ?? null,
      free: n.querySelectorAll('.seat.free').length,
      fine: n.querySelector('.lr-fine')?.textContent ?? null,
      join: n.querySelector('[data-join]')?.textContent ?? null,
    })),
  )

const openLobby = async (page, relayUrl, url = SITE) => {
  await page.setViewport({ width: 900, height: 1000 })
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.$eval('#relays', (el, v) => { el.value = v }, relayUrl)
  await page.click('#live-refresh')
  return until(async () => {
    const list = await readRooms(page)
    return list.length >= 2 ? list : null
  })
}

try {
  // --- the board says what every table is playing --------------------------
  const page = await browser.newPage()
  page.on('pageerror', (err) => console.log('      page error:', err.message))
  const rooms = await openLobby(page, relay1.url)
  check('the lobby finds live games', !!rooms, JSON.stringify(rooms?.map((r) => r.room)))
  if (!rooms) throw new Error('no rooms rendered')
  const byName = Object.fromEntries(rooms.map((r) => [r.room, r]))

  check('a created game wears its mode', byName.pit?.mode === 'CTF', JSON.stringify(byName.pit))
  check(
    'a pre-mode beacon being newest does not flip the room back to deathmatch',
    byName.pit?.mode === 'CTF' && byName.pit?.seats === `4/${SEATS}`,
    `mode ${byName.pit?.mode}, seats ${byName.pit?.seats}`,
  )
  check('a room that says nothing is deathmatch', byName.yard?.mode === 'DM', String(byName.yard?.mode))

  // --- deathmatch is always on ---------------------------------------------
  check(
    'the standing deathmatch is on the board with nobody in it',
    byName.lobby?.mode === 'DM' && byName.lobby?.free === SEATS && byName.lobby?.join === 'Take a seat',
    JSON.stringify(byName.lobby),
  )
  check(
    'and says it is the standing game',
    byName.lobby?.fine?.includes('always open'),
    String(byName.lobby?.fine),
  )

  // --- door one: the room card ---------------------------------------------
  await page.evaluate(() => {
    const rooms = [...document.querySelectorAll('.live-room')]
    const pit = rooms.find((n) => n.querySelector('.lr-name')?.textContent === 'pit')
    pit.querySelector('[data-join]').click()
  })
  const joined = await page
    .waitForFunction(() => window.__game && window.__game.watching === false, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  check('clicking a CTF table starts a game', joined)
  if (joined) {
    const state = await page.evaluate(() => ({
      room: window.__game.room,
      flags: window.__game.flagsOn,
      points: window.__game.pointsOn,
      team: window.__game.team,
      search: location.search,
    }))
    check('and the joiner lands in the room\'s rules, not their own', state.flags === true && state.points === false, JSON.stringify(state))
    check('with a side, because CTF needs one', state.team > 0, `team ${state.team}`)
    check('and the address bar carries the rules for copy-invite', /mode=ctf/.test(state.search) && /room=pit/.test(state.search), state.search)
    const spoke = await until(() => (published.some((p) => p.room === 'pit') ? true : null), 20_000, 250)
    const ours = published.filter((p) => p.room === 'pit')
    check(
      'the joiner\'s own beacon restates the room\'s mode',
      spoke === true && ours.every((p) => p.mode === 'ctf'),
      JSON.stringify(ours[0]),
    )
  }

  // --- door two: a typed room name -----------------------------------------
  const page2 = await browser.newPage()
  // The first page just played CTF on this origin, so the remembered mode is
  // ctf and the remembered side is set. Force the preference back to plain
  // deathmatch so the adoption below is the room's doing, not a leftover.
  await page2.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page2.evaluate(() => {
    localStorage.setItem('tank.mode', 'dm')
    localStorage.setItem('tank.team', '0')
  })
  const rooms2 = await openLobby(page2, relay1.url)
  check('a second visitor sees the same board', !!rooms2)
  await page2.$eval('#room', (el) => { el.value = 'pit' })
  await page2.click('#play-guest')
  const joined2 = await page2
    .waitForFunction(() => window.__game && window.__game.watching === false, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  const state2 = joined2
    ? await page2.evaluate(() => ({ flags: window.__game.flagsOn, team: window.__game.team }))
    : null
  check(
    'typing an occupied room\'s name lands in its rules too',
    joined2 && state2?.flags === true && (state2?.team ?? 0) > 0,
    JSON.stringify(state2),
  )
  await page2.close()

  // --- door three: an invite link with the rules in it ---------------------
  const page3 = await browser.newPage()
  await page3.setViewport({ width: 900, height: 1000 })
  await page3.goto(`${SITE}?room=freshden&mode=dom`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page3.$eval('#relays', (el, v) => { el.value = v }, relay1.url)
  await page3.click('#play-guest')
  const joined3 = await page3
    .waitForFunction(() => window.__game && window.__game.watching === false, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  const state3 = joined3
    ? await page3.evaluate(() => ({
        room: window.__game.room,
        points: window.__game.pointsOn,
        flags: window.__game.flagsOn,
        search: location.search,
      }))
    : null
  check(
    'an invite link creates the game it names, rules included',
    joined3 && state3?.room === 'freshden' && state3?.points === true && state3?.flags === false,
    JSON.stringify(state3),
  )
  check('and the link survives the join for the next copy', /mode=dom/.test(state3?.search ?? ''), state3?.search ?? '')
  await page3.close()

  // --- the chain: a full standing room offers the next one -----------------
  const page4 = await browser.newPage()
  const rooms4 = await openLobby(page4, relay2.url)
  const by4 = Object.fromEntries((rooms4 ?? []).map((r) => [r.room, r]))
  check(
    'a full standing room reads as full',
    by4.lobby?.seats === `${SEATS}/${SEATS}`,
    JSON.stringify(by4.lobby),
  )
  check(
    'and the chain offers the next deathmatch with a seat',
    by4['lobby-2']?.mode === 'DM' && by4['lobby-2']?.free === SEATS && by4['lobby-2']?.join === 'Take a seat',
    JSON.stringify(by4['lobby-2']),
  )
  await page4.evaluate(() => {
    const rooms = [...document.querySelectorAll('.live-room')]
    const next = rooms.find((n) => n.querySelector('.lr-name')?.textContent === 'lobby-2')
    next.querySelector('[data-join]').click()
  })
  const joined4 = await page4
    .waitForFunction(() => window.__game && window.__game.watching === false, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  const state4 = joined4
    ? await page4.evaluate(() => ({
        room: window.__game.room,
        flags: window.__game.flagsOn,
        points: window.__game.pointsOn,
        team: window.__game.team,
      }))
    : null
  check(
    'the invented room is a real door: joining it is plain deathmatch',
    joined4 && state4?.room === 'lobby-2' && !state4?.flags && !state4?.points && state4?.team === 0,
    JSON.stringify(state4),
  )
} finally {
  await browser.close()
  relay1.wss.close()
  relay2.wss.close()
}

console.log(failures.length ? `\n${failures.length} failed\n` : '\nAll room-mode checks passed.\n')
process.exit(failures.length ? 1 : 0)
