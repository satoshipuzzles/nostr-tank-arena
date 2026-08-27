// Create-a-game, against a relay whose answers this file chose.
//
//   npm run build && npm run preview &
//   node test/creategame.mjs
//
// A created game is four decisions — mode, board, bots, listed or not — and
// every one of them has to survive three journeys: onto the wire (the beacon),
// into the link (copy-invite), and into the next client's rules (adoption).
//
// The relay here is stateful on purpose: it stores what pages publish and
// answers REQs with a real #t filter. That is what makes the privacy check
// honest — if a private beacon ever carries the lobby tag again, the second
// page's live board WILL show the room and the check WILL fail.

import { existsSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import puppeteer from 'puppeteer-core'

const SITE = process.env.TANK_URL ?? 'http://localhost:4173/'
if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(SITE)) {
  console.log(`SKIP  the create-game checks need a plain-http origin; TANK_URL is ${SITE}`)
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
const PRESENCE_TAG = 'tankarena-live'
const now = Math.floor(Date.now() / 1000)
const key = () => {
  const sk = generateSecretKey()
  return { sk, pk: getPublicKey(sk) }
}
const beacon = (room, name, extra = {}) =>
  finalizeEvent(
    {
      kind: KIND_PRESENCE,
      created_at: now,
      tags: [
        ['d', 'nostr-tank-arena/here'],
        ['t', PRESENCE_TAG],
        ['t', `tankarena-${room}`],
        ['expiration', String(now + 120)],
      ],
      content: JSON.stringify({ room, name, hue: 120, role: 'seat', at: now, ...extra }),
    },
    key().sk,
  )

// `mesa` is a created game somebody else is already in: CTF, pinned to The
// Bluff. The joiner below must land in both without touching a control.
const STATIC = [
  beacon('mesa', 'ada', { mode: 'ctf', board: 'the-bluff' }),
  beacon('mesa', 'bob', { mode: 'ctf', board: 'the-bluff' }),
]

/** Everything pages publish, kept and served back through a real #t filter. */
const stored = [...STATIC]
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
      stored.push(msg[1])
      return ws.send(JSON.stringify(['OK', msg[1].id, true, '']))
    }
    if (msg[0] !== 'REQ') return
    const [, id, ...filters] = msg
    for (const f of filters) {
      for (const e of stored) {
        if (f.kinds && !f.kinds.includes(e.kind)) continue
        if (f['#t']) {
          const tags = e.tags.filter((t) => t[0] === 't').map((t) => t[1])
          if (!f['#t'].some((v) => tags.includes(v))) continue
        }
        ws.send(JSON.stringify(['EVENT', id, e]))
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

const hideoutBeacons = () =>
  stored
    .filter((e) => e.kind === KIND_PRESENCE && e.tags.some((t) => t[0] === 't' && t[1] === 'tankarena-hideout'))
    .map((e) => ({
      live: e.tags.some((t) => t[0] === 't' && t[1] === PRESENCE_TAG),
      content: JSON.parse(e.content),
    }))

try {
  // --- the panel itself ----------------------------------------------------
  const page = await browser.newPage()
  page.on('pageerror', (err) => console.log('      page error:', err.message))
  await page.setViewport({ width: 900, height: 1200 })
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  const panel = await page.evaluate(() => ({
    open: document.getElementById('create')?.open ?? false,
    modesInside: !!document.querySelector('#create #modes'),
    botsInside: !!document.querySelector('#create #row-bots'),
    boards: [...document.querySelectorAll('#board-pick option')].map((o) => o.value),
    layouts: window.__arena ? -1 : [...document.querySelectorAll('#board-pick option')].length - 1,
    visibility: [...document.querySelectorAll('#visibility button')].map((b) => b.dataset.value),
    publicOn: document.querySelector('#visibility button[data-value="public"]')?.getAttribute('aria-pressed'),
  }))
  check('the create panel is on the hub, open', panel.open === true)
  check('and holds the mode cards and the bots', panel.modesInside && panel.botsInside)
  check(
    'the board picker leads with the chain and lists every board',
    panel.boards[0] === '' && panel.boards.length >= 11 && panel.boards.includes('the-bluff'),
    JSON.stringify(panel.boards),
  )
  check('public is the default listing', panel.publicOn === 'true', JSON.stringify(panel.visibility))

  // --- creating: private DOM on a pinned board -----------------------------
  await page.$eval('#relays', (el, v) => { el.value = v }, relayUrl)
  await page.click('#mode-dom')
  await page.select('#board-pick', 'the-bluff')
  await page.click('#visibility button[data-value="private"]')
  await page.$eval('#room', (el) => { el.value = 'hideout' })
  await page.click('#play-guest')
  const made = await page
    .waitForFunction(() => window.__game && window.__game.watching === false, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  check('creating the game starts it', made)
  if (made) {
    // The chain says Crossroads; the pin must say otherwise, round after round.
    await page.evaluate(() => window.__clock.accept({ height: 1, hash: 'a'.repeat(62) + '00' }))
    const first = await page.evaluate(() => window.__arena.layoutName)
    await page.evaluate(() => window.__closeBlock(2, 'b'.repeat(62) + '01'))
    const second = await page.evaluate(() => window.__arena.layoutName)
    check('the pinned board wins the first block', first === 'The Bluff', String(first))
    check('and every block after it', second === 'The Bluff', String(second))
    const state = await page.evaluate(() => ({
      points: window.__game.pointsOn,
      flags: window.__game.flagsOn,
      search: location.search,
    }))
    check('the rules are the created ones', state.points === true && state.flags === false, JSON.stringify(state))
    check(
      'the invite link carries the whole game',
      /room=hideout/.test(state.search) &&
        /mode=dom/.test(state.search) &&
        /board=the-bluff/.test(state.search) &&
        /private=1/.test(state.search),
      state.search,
    )
    const spoke = await until(() => (hideoutBeacons().length ? hideoutBeacons() : null), 20_000, 250)
    check(
      'the private beacon names the game but never the lobby',
      !!spoke &&
        spoke.every((b) => !b.live) &&
        spoke.every((b) => b.content.mode === 'dom' && b.content.board === 'the-bluff'),
      JSON.stringify(spoke?.[0]),
    )
  }
  const invite = made ? await page.evaluate(() => location.search) : ''

  // --- the private room is invisible, the public one is labeled ------------
  const page2 = await browser.newPage()
  await page2.setViewport({ width: 900, height: 1000 })
  await page2.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page2.$eval('#relays', (el, v) => { el.value = v }, relayUrl)
  await page2.click('#live-refresh')
  const rooms2 = await until(async () => {
    const list = await page2.evaluate(() =>
      [...document.querySelectorAll('.live-room')].map((n) => n.querySelector('.lr-name')?.textContent),
    )
    return list.includes('mesa') ? list : null
  })
  check('the public game is on the board', !!rooms2, JSON.stringify(rooms2))
  check(
    'the private one is not, though its beacons sit on the same relay',
    !!rooms2 && !rooms2.includes('hideout'),
    JSON.stringify(rooms2),
  )

  // --- adoption: joining the pinned public game ----------------------------
  await page2.evaluate(() => {
    const rooms = [...document.querySelectorAll('.live-room')]
    const mesa = rooms.find((n) => n.querySelector('.lr-name')?.textContent === 'mesa')
    mesa.querySelector('[data-join]').click()
  })
  const joined = await page2
    .waitForFunction(() => window.__game && window.__game.watching === false, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  if (joined) {
    // The chain hash points at board 0; the room's pin must override it.
    await page2.evaluate(() => window.__clock.accept({ height: 3, hash: 'c'.repeat(62) + '00' }))
  }
  const adopted = joined
    ? await page2.evaluate(() => ({
        room: window.__game.room,
        flags: window.__game.flagsOn,
        layout: window.__arena.layoutName,
      }))
    : null
  check(
    'a joiner lands on the room\'s board with the room\'s rules, no controls touched',
    joined && adopted?.room === 'mesa' && adopted?.flags === true && adopted?.layout === 'The Bluff',
    JSON.stringify(adopted),
  )
  await page2.close()

  // --- the invite loop: the copied link recreates the game -----------------
  const page3 = await browser.newPage()
  await page3.setViewport({ width: 900, height: 1000 })
  await page3.goto(`${SITE}${invite}`, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page3.$eval('#relays', (el, v) => { el.value = v }, relayUrl)
  const before = hideoutBeacons().length
  await page3.click('#play-guest')
  const arrived = await page3
    .waitForFunction(() => window.__game && window.__game.watching === false, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  if (arrived) {
    await page3.evaluate(() => window.__clock.accept({ height: 4, hash: 'd'.repeat(62) + '00' }))
  }
  const guest = arrived
    ? await page3.evaluate(() => ({
        room: window.__game.room,
        points: window.__game.pointsOn,
        layout: window.__arena.layoutName,
      }))
    : null
  check(
    'a friend opening the link lands in the made game — room, rules, board',
    arrived && guest?.room === 'hideout' && guest?.points === true && guest?.layout === 'The Bluff',
    JSON.stringify(guest),
  )
  const after = await until(() => (hideoutBeacons().length > before ? hideoutBeacons() : null), 20_000, 250)
  check(
    'and their beacon keeps the room off the lobby too',
    !!after && after.every((b) => !b.live),
    `${after?.length ?? 0} beacons, live-tagged: ${after?.filter((b) => b.live).length ?? '?'}`,
  )
} finally {
  await browser.close()
  wss.close()
}

console.log(failures.length ? `\n${failures.length} failed\n` : '\nAll create-game checks passed.\n')
process.exit(failures.length ? 1 : 0)
