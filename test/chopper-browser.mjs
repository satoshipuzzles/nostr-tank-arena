// The gunship, in a running game.
//
// test/chopper.mjs proves the arithmetic. This proves the parts that only exist
// once it is wired in:
//
//   1. Ten kills *through the real kill path* puts you in it. Setting a flag
//      and asserting the flag is set would test nothing — the claim is that a
//      streak reaching ten produces a chopper.
//   2. Your tank leaves the board and a chopper reaches a pixel. This codebase
//      has shipped meshes that were `visible = true` for weeks while drawn
//      inside the floor.
//   3. The whole thing rides the state tick: `c` counting down, `cx`/`cy` where
//      the rounds land, and `x`/`y` being the chopper rather than the parked
//      tank. Nothing new on the wire is the entire netcode design.
//   4. Somebody else's chopper takes your hull — applied by you, on their tick,
//      at the rate the constant says and not faster.
//   5. It ends, and you come back.
//
//   npm run build && npx vite preview --port 4202 &
//   npm run test:chopper-browser

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4202/'
const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!executablePath) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2) }

const FLAGS = [
  '--no-sandbox', '--window-size=1280,800', '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
]

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 20_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await wait(100)
  }
  return null
}

const PEER = 'd1'.repeat(32)
const HASH = 'ab'.repeat(30) + '0300'

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'heli')
  await page.type('#room', 'heli' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game && !!window.__renderer, { timeout: 25_000 })
    .then(() => true).catch(() => false)
  check('a game is running', started)
  if (!started) throw new Error('the game never started')

  await page.evaluate((hash) => {
    window.__clock.accept({ height: 900000, hash, time: Math.floor(Date.now() / 1000) - 30 })
    window.__clock.accept = () => {}
    const g = window.__game
    g.beginRound(900000, hash)
    g.beginRound = () => {}
    g.botsEnabled = false
    document.getElementById('podium').hidden = true
  }, HASH)
  await wait(800)

  // ------------------------------------------------- 1. ten kills, the real way

  const boarded = await page.evaluate((PEER) => {
    const g = window.__game
    g.tank.dead = false
    g.tank.x = 800
    g.tank.y = 600
    g.streak = 9
    const before = { flying: g.flying, streak: g.streak }
    // Through the real death path: a peer reports dying and names us as the
    // killer, which is what `onDeath` -> `onOwnKill` -> the streak ladder reads.
    // Handing `onOwnKill` a pre-made streak would test the ladder given an
    // answer; it could not test whether ten kills ever produces one.
    g.onEvent({
      id: 'a' + Math.random().toString(16).slice(2),
      pubkey: PEER, kind: 21002, created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), k: g.identity.sessionPubkey, x: 400, y: 400 }),
    }, false)
    return {
      before,
      streak: g.streak,
      flying: g.flying,
      left: g.chopperLeft,
      at: { x: Math.round(g.chopper.x), y: Math.round(g.chopper.y) },
    }
  }, PEER)
  check('the control: we were not flying a moment ago', boarded.before.flying === false)
  check('a tenth kill in a row puts us in the chopper',
    boarded.streak === 10 && boarded.flying === true, JSON.stringify(boarded))
  check('and it starts over our own tank rather than at a map edge',
    Math.abs(boarded.at.x - 800) < 2 && Math.abs(boarded.at.y - 600) < 2, JSON.stringify(boarded.at))
  check('with ten seconds on it', boarded.left > 9 && boarded.left <= 10, String(boarded.left))

  // ------------------------------------------------- 2. it reaches a pixel

  const drawn = await until(async () => page.evaluate(() => {
    const r = window.__renderer, g = window.__game
    const rig = r.chopperRigAt(g.identity.sessionPubkey)
    if (!rig) return null
    const p = r.toScreen(g.chopper.x, 300, g.chopper.y)
    return {
      visible: rig.root.visible,
      y: Math.round(rig.root.position.y),
      screen: p ? { x: Math.round(p.x), y: Math.round(p.y) } : null,
      tank: r.youVisible(),
    }
  }))
  check('a chopper rig exists and is above the board', !!drawn && drawn.y > 100, JSON.stringify(drawn))
  check('and it projects onto the visible screen',
    !!drawn?.screen && drawn.screen.x > 0 && drawn.screen.x < 1280 &&
      drawn.screen.y > 0 && drawn.screen.y < 800, JSON.stringify(drawn?.screen))
  check('and our tank has left the board, so there is no target nothing can hit',
    drawn?.tank === false, String(drawn?.tank))

  // ------------------------------------------------- 3. it rides the tick

  const flown = await page.evaluate(() => {
    const g = window.__game
    const from = { x: g.chopper.x, y: g.chopper.y }
    // Drive it right for a beat, through the real update.
    for (let i = 0; i < 40; i++) {
      g.update(0.016, { throttle: 0, steer: 1, aim: null, aimAt: null, fire: false, reload: false, lob: false })
    }
    const moved = { x: g.chopper.x, y: g.chopper.y }
    // Then hold fire at a point on the ground.
    const target = { x: g.chopper.x + 200, y: g.chopper.y + 60 }
    for (let i = 0; i < 6; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: target, fire: true, reload: false, lob: false })
    }
    let tick = null
    const real = g.publishAsSession.bind(g)
    g.publishAsSession = (kind, payload) => { if (kind === 21000) tick = payload; return real(kind, payload) }
    g.publishState(performance.now())
    g.publishAsSession = real
    return { from, moved, target, tick, tank: { x: g.tank.x, y: g.tank.y } }
  })
  check('driving moves the chopper', flown.moved.x > flown.from.x + 50, JSON.stringify(flown.moved))
  check('the tick carries the time it has left',
    typeof flown.tick?.c === 'number' && flown.tick.c > 0 && flown.tick.c <= 10_400,
    String(flown.tick?.c))
  check('and where the rounds are landing',
    typeof flown.tick?.cx === 'number' && typeof flown.tick?.cy === 'number',
    JSON.stringify({ cx: flown.tick?.cx, cy: flown.tick?.cy }))
  check(
    "and its x/y is the chopper, not the parked tank",
    Math.abs(flown.tick.x - flown.moved.x) < 2 && Math.abs(flown.tick.x - flown.tank.x) > 20,
    JSON.stringify({ tick: flown.tick.x, chopper: Math.round(flown.moved.x), tank: Math.round(flown.tank.x) }),
  )

  // ------------------------------------------- 4. somebody else's chopper hurts

  // Land ours first, so what follows is only about theirs.
  await page.evaluate(() => { window.__game.chopperUntil = 0 })
  await page.evaluate(() => {
    const g = window.__game
    g.tank.dead = false
    g.tank.hp = 3
    g.tank.x = 700
    g.tank.y = 500
    g.buffs.shieldUntil = 0
  })

  /** One tick from a stranger flying a gunship, aimed wherever we say. */
  const theirTick = (aimX, aimY) => page.evaluate(({ PEER, aimX, aimY }) => {
    window.__game.onEvent({
      id: 'a' + Math.random().toString(16).slice(2),
      pubkey: PEER, kind: 21000, created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({
        t: Date.now(), x: 700, y: 300, h: 0, g: 0, hp: 3, d: false,
        ks: 0, ds: 0, r: window.__game.round,
        c: 8000, cx: aimX, cy: aimY,
      }),
    }, false)
  }, { PEER, aimX, aimY })

  // Aimed well away from us: the control. If this took hull, everything below
  // would be measuring a gunship that hits the whole board.
  await theirTick(200, 1000)
  const away = await page.evaluate(() => {
    const g = window.__game
    for (let i = 0; i < 40; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
    }
    return g.tank.hp
  })
  check('the control: a chopper shooting somewhere else does not touch us',
    away === 3, `hp=${away}`)

  // Now aimed at us.
  await theirTick(700, 500)
  const hit = await until(async () => page.evaluate(() => {
    const g = window.__game
    g.tank.x = 700
    g.tank.y = 500
    for (let i = 0; i < 10; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
    }
    return g.tank.hp < 3 ? g.tank.hp : null
  }))
  check('standing under one takes hull', hit !== null, `hp=${hit}`)

  // The rate, measured as the interval between hits rather than as a window.
  //
  // Two earlier versions of this check were worthless. The first hammered
  // `update` 120 times inside one `evaluate` and asserted the hull had not
  // dropped by more than one — it had not dropped at all, because the cooldown
  // runs against `performance.now()` and a synchronous loop advances it by
  // about a millisecond. Green against a build with no cooldown at all. The
  // second waited 300ms and asserted no second hit, which failed on correct
  // code: each `evaluate` is a round trip and under a software rasteriser six
  // of them cost most of the window, so "300ms after we noticed" was most of a
  // second after the hit.
  //
  // Timing the gaps in the page removes both problems. `hp` is set high on
  // purpose so the tank survives long enough to produce four of them — one
  // interval is a number, four is a rate.
  await theirTick(700, 500)
  const rate = await page.evaluate(async () => {
    const g = window.__game
    g.tank.dead = false
    g.tank.hp = 99
    g.buffs.shieldUntil = 0
    const hits = []
    let last = g.tank.hp
    const t0 = performance.now()
    while (performance.now() - t0 < 2600) {
      g.tank.x = 700
      g.tank.y = 500
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
      if (g.tank.hp !== last) {
        hits.push(Math.round(performance.now() - t0))
        last = g.tank.hp
      }
      await new Promise((r) => setTimeout(r, 8))
    }
    return { hits, gaps: hits.slice(1).map((v, i) => v - hits[i]) }
  })
  check('it keeps hitting for as long as you stand there',
    rate.gaps.length >= 3, JSON.stringify(rate.hits))
  check(
    'and every gap is the interval, so grinding the loop cannot speed it up',
    rate.gaps.length >= 3 && rate.gaps.every((g) => g >= 500 && g <= 560),
    JSON.stringify(rate.gaps) + ' against a 520ms interval',
  )
  // The control for the control: a tank standing where nothing is landing takes
  // nothing at all over the same span, so the gaps above are a rate rather than
  // a description of how often `update` was called.
  const clear = await page.evaluate(async () => {
    const g = window.__game
    g.tank.hp = 99
    const before = g.tank.hp
    const t0 = performance.now()
    while (performance.now() - t0 < 1400) {
      g.tank.x = 120
      g.tank.y = 1100
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
      await new Promise((r) => setTimeout(r, 8))
    }
    return { before, after: g.tank.hp }
  })
  check('the control: standing clear of it for the same span costs nothing',
    clear.after === clear.before, JSON.stringify(clear))

  // ------------------------------------------------------------ 5. it ends

  await page.evaluate(() => {
    const g = window.__game
    g.streak = 9
    g.tank.dead = false
    g.onEvent({
      id: 'a' + Math.random().toString(16).slice(2),
      pubkey: 'e2'.repeat(32), kind: 21002, created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), k: g.identity.sessionPubkey, x: 400, y: 400 }),
    }, false)
    // Wind the clock to the last moment rather than waiting ten real seconds.
    g.chopperUntil = performance.now() + 60
  })
  const landed = await until(async () => page.evaluate(() => {
    const g = window.__game
    g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
    return g.flying ? null : { flying: g.flying, dead: g.tank.dead, hp: g.tank.hp }
  }))
  check('it ends on its own', !!landed, JSON.stringify(landed))
  check('and puts the tank back, alive', landed?.dead === false && landed?.hp > 0, JSON.stringify(landed))
  const gone = await until(async () => page.evaluate(() => {
    const r = window.__renderer, g = window.__game
    return r.chopperRigAt(g.identity.sessionPubkey) === null && r.youVisible() === true ? true : null
  }))
  check('and the chopper comes off the board while the tank comes back', !!gone)

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall good')
process.exit(failures.length ? 1 : 0)
