// The spitfire wired into a running game.
//
//   npm run build && npx vite preview --port 4209 &
//   npm run test:spitfire-browser
//
// test/spitfire.mjs proves the flight plan; this proves the wiring that only
// exists in a browser: the loadout offers it, spending it asks a second
// question (the corner pad — the first reward in the game with one), the
// answer goes out as ONE strike-kind event with no `y`, the renderer flies a
// rig along the same line the sim damages with, and a peer's pass puts real
// hull damage on a tank that stands on the diagonal.

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4209/'
const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!executablePath) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2) }

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 15_000, step = 150) {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) return null
    await wait(step)
  }
}

const HASH = 'e'.repeat(62) + '00'
const PEER = 'd7'.repeat(32)

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: [
    '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
  ],
})

try {
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (err) => errors.push(err.message))
  await page.setViewport({ width: 1280, height: 800 })
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'spit')
  await page.type('#room', 'spit' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game, { timeout: 25_000 })
    .then(() => true).catch(() => false)
  check('a game is running', started)
  if (!started) throw new Error('the game never started')

  await page.evaluate((hash) => {
    window.__clock.accept({ height: 900001, hash, time: Math.floor(Date.now() / 1000) - 30 })
    window.__clock.accept = () => {}
    const g = window.__game
    g.beginRound(900001, hash)
    g.botsWanted = 0
    g.bots = []
    window.__arena.setLayout(window.__arena.layoutForBlock(hash))
    document.getElementById('podium').hidden = true
  }, HASH)
  await wait(600)

  // ------------------------------------------ 1. the pool offers it, tier 10
  const inPool = await page.evaluate(() =>
    window.__loadout.rewardsForTier(10).some((r) => r.id === 'spitfire'))
  check('the power tier offers the spitfire', inPool === true)

  // ------------------------------------------------- 2. earn it, for real
  await page.evaluate(() => {
    window.__game.setLoadout(['strike', 'spitfire', 'jugger', 'carpet'])
    window.__game.streak = 9
  })
  await page.evaluate((PEER) => {
    const g = window.__game
    g.onEvent({
      id: 'k' + Math.random().toString(16).slice(2),
      pubkey: PEER, kind: 21002, created_at: Math.floor(Date.now() / 1000), tags: [],
      sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), k: g.identity.sessionPubkey, x: 400, y: 400 }),
    }, false)
  }, PEER)
  const held = await until(() => page.evaluate(() => window.__game.earned.includes(10) || null))
  check('ten kills bank it', held === true,
    `earned=${JSON.stringify(await page.evaluate(() => window.__game.earned))}`)

  // --------------------------- 3. the spend asks its second question
  const published = await page.evaluate(() => {
    const g = window.__game
    window.__published = []
    const real = g.publishAsSession.bind(g)
    g.publishAsSession = (kind, payload) => { window.__published.push({ kind, payload }); return real(kind, payload) }
    g.spend(10)
    return { pending: g.pendingStrafe, strafes: g.strafes.size, sent: window.__published.length }
  })
  check('spending arms the corner question and fires nothing yet',
    published.pending === true && published.strafes === 0 && published.sent === 0,
    JSON.stringify(published))

  const pad = await until(() => page.evaluate(() => {
    const btns = [...document.querySelectorAll('#tray button[data-corner]')]
    return btns.length === 4 ? btns.map((b) => b.dataset.corner) : null
  }))
  check('the tray becomes a four-corner pad', !!pad && pad.join(',') === '0,1,2,3', JSON.stringify(pad))

  // ----------------------------- 4. the answer is one event with no `y`
  await page.evaluate(() => {
    document.querySelector('#tray button[data-corner="2"]').click()
  })
  const call = await page.evaluate(() => ({
    pending: window.__game.pendingStrafe,
    strafes: window.__game.strafes.size,
    sent: window.__published.filter((p) => p.kind === 21004),
  }))
  check('picking a corner publishes exactly one strike-kind event',
    call.pending === false && call.strafes === 1 && call.sent.length === 1,
    JSON.stringify({ pending: call.pending, strafes: call.strafes, events: call.sent.length }))
  const p = call.sent[0]?.payload ?? {}
  check('and the payload is the strafe shape an old client drops',
    p.k === 'strafe' && p.c === 2 && typeof p.t0 === 'number' && !('y' in p),
    JSON.stringify(p))

  // ------------------------------ 5. the renderer flies the same line
  const rig = await until(() => page.evaluate(() => {
    const rigs = window.__renderer.spitfireRigs()
    return rigs.length ? rigs[0] : null
  }), 8000)
  check('a plane rig is in the air', !!rig, JSON.stringify(rig))
  if (rig) {
    // Corner 2 is bottom-right: the run heads for the top-left, so the rig
    // must sit on the corner-to-corner diagonal, give or take the fence.
    const online = await page.evaluate(() => {
      const A = window.__arena
      const r = window.__renderer.spitfireRigs()[0]
      if (!r) return null
      // Distance from the point to the (0,0)-(W,H) diagonal.
      const len = Math.hypot(A.ARENA_W, A.ARENA_H)
      const miss = Math.abs(r.x * A.ARENA_H - r.y * A.ARENA_W) / len
      return { miss: Math.round(miss), x: Math.round(r.x), y: Math.round(r.y) }
    })
    check('and it is on the diagonal the corner named', !!online && online.miss < 5, JSON.stringify(online))
  }
  const gone = await until(() => page.evaluate(() =>
    (window.__game.strafes.size === 0 && window.__renderer.spitfireRigs().length === 0) || null), 12_000)
  check('one pass, then gone — sim and screen agree', gone === true)

  // -------------------------------- 6. a peer's pass draws real blood
  const before = await page.evaluate(() => {
    const g = window.__game
    // Park on the diagonal near the NW corner: a corner-0 pass crosses the
    // fence there moments after t0, so the suite is not waiting out a flight.
    g.tank.dead = false
    g.tank.hp = 3
    g.tank.x = 40
    g.tank.y = Math.round((40 / window.__arena.ARENA_W) * window.__arena.ARENA_H)
    g.buffs.shieldUntil = 0
    return { hp: g.tank.hp }
  })
  await page.evaluate((PEER) => {
    window.__game.onEvent({
      id: 's' + Math.random().toString(16).slice(2),
      pubkey: PEER, kind: 21004, created_at: Math.floor(Date.now() / 1000), tags: [],
      sig: '0'.repeat(128),
      content: JSON.stringify({ k: 'strafe', t0: Date.now(), c: 0, d: 1 }),
    }, false)
  }, PEER)
  const bled = await until(() => page.evaluate(() => {
    const g = window.__game
    // Hold the tank on the spot — respawns and drift would move it off the line.
    g.tank.x = 40
    g.tank.y = Math.round((40 / window.__arena.ARENA_W) * window.__arena.ARENA_H)
    return g.tank.hp < 3 ? g.tank.hp : null
  }), 10_000)
  check('a peer\'s strafing run costs a tank on the diagonal real hull',
    bled !== null && bled < before.hp, `hp ${before.hp} -> ${bled}`)

  check('no page errors', errors.length === 0, errors.join(' | '))
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} failed\n` : '\nAll spitfire-browser checks passed.\n')
process.exit(failures.length ? 1 : 0)
