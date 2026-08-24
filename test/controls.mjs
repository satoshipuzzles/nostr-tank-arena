// What the keys and the pad actually do, measured rather than assumed.
//
// This exists because of a bug nobody would have found by reading the file.
// `Input.read()` used to call `readPad()` first and return its answer outright,
// and a pad counted as "in use" the moment any axis left a 0.22 deadzone. Worn
// sticks do not return to zero. So a controller sitting on a desk, untouched,
// took the keyboard away from a player who was never using it — and a *right*
// stick did it too, an axis that only aims, so you could lose the ability to
// drive to a stick that does not steer. A resting trigger did both at once:
// dead keyboard, and a tank firing on its own.
//
// None of that shows up in a structural test. Nothing throws, `Input` looks
// correct in isolation, and with no pad plugged into CI it never happens. The
// only way to see it is to hand the page a pad and measure whether W still
// moves the tank.
//
//   npm run build && npm run preview &
//   npm run test:controls

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL = process.env.TANK_URL ?? 'http://localhost:4173/'

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!executablePath) {
  console.error('No Chrome found. Set CHROME_PATH.')
  process.exit(2)
}

const FLAGS = [
  '--no-sandbox',
  '--window-size=1280,800',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
/**
 * Half a second of a 60fps match.
 *
 * Deliberately short. The old `wait(2600)` asked for 2.6 seconds and, starved
 * of frames, delivered about 44px of travel — which is what the >40px
 * thresholds below were tuned against. Ask for the 2.6 seconds in *frames* and
 * the tank crosses 450px, which on a small board is a wall, and the reading
 * becomes a measurement of the arena. 30 frames is 87px: comfortably over the
 * threshold, close enough to the old distance that nothing downstream moves.
 */
const HOLD_FRAMES = 30
const norm = (d) => ((d + 540) % 360) - 180

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
page.on('pageerror', (e) => console.log('  page error:', e.message))

try {
  // A fake pad, installed before any page script runs. Driven from window.__pad
  // so a single match can be replayed against several kinds of broken hardware.
  await page.evaluateOnNewDocument(() => {
    window.__pad = null
    navigator.getGamepads = () =>
      window.__pad
        ? [
            {
              id: 'Fake Pad (Vendor: 0000 Product: 0000)',
              index: window.__pad.index ?? 0,
              connected: true,
              mapping: 'standard',
              timestamp: performance.now(),
              axes: window.__pad.axes,
              buttons: window.__pad.buttons.map((v) => ({
                pressed: v > 0.5,
                touched: v > 0.1,
                value: v,
              })),
            },
          ]
        : []
  })

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'controls')
  await page.type('#room', 'ctl' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game && !!window.__renderer, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  check('game starts as guest', started, started ? '' : 'never reached the arena')
  if (!started) throw new Error('cannot measure controls without a match')
  await wait(2000)

  // Screen->world basis from the renderer's own unprojection, inverted so a
  // world delta can be reported as the direction a player would see.
  const basis = await page.evaluate(() => {
    const r = window.__renderer
    const cx = window.innerWidth / 2
    const cy = window.innerHeight / 2
    const o = r.toWorld(cx, cy)
    const px = r.toWorld(cx + 100, cy)
    const py = r.toWorld(cx, cy + 100)
    return { sx: { x: px.x - o.x, y: px.y - o.y }, sy: { x: py.x - o.x, y: py.y - o.y } }
  })
  const det = basis.sx.x * basis.sy.y - basis.sy.x * basis.sx.y
  const screenAngle = (dx, dy) =>
    (Math.atan2((dy * basis.sx.x - dx * basis.sx.y) / det, (dx * basis.sy.y - dy * basis.sy.x) / det) *
      180) /
    Math.PI

  /**
   * Run n animation frames in the page.
   *
   * Frames, never milliseconds. Under swiftshader on a loaded machine this page
   * runs a long way under 60fps, so a fixed `wait(2600)` buys a handful of
   * frames and every reading below becomes a measurement of the renderer rather
   * than of the controls. It made this suite fail six of its own checks on an
   * unmodified main — the tank really had only travelled 20px, because it had
   * only been stepped a dozen times.
   */
  const frames = (n) =>
    page.evaluate(
      (k) =>
        new Promise((res) => {
          let i = 0
          const tick = () => {
            i += 1
            if (i >= k) return res()
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        }),
      n,
    )

  /** Wait until the gun has not moved across four consecutive frames. */
  const gunSettled = (cap = 240) =>
    page.evaluate(
      (max) =>
        new Promise((res) => {
          let last = null
          let still = 0
          let seen = 0
          const tick = () => {
            const g = window.__game.tank.gun
            if (last !== null && Math.abs(g - last) < 1e-4) still += 1
            else still = 0
            last = g
            seen += 1
            if (still >= 4 || seen >= max) return res(g)
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        }),
      cap,
    )

  // Pin the board before anything is measured.
  //
  // The map is `blockHash % LAYOUTS.length` off the live chain tip, so without
  // this every reading below is taken on whichever of eight arenas the last
  // block happened to pick — and the parking spot stops being an open lane.
  // While the holds were starved of frames the tank only crawled 44px and it
  // never mattered; asking for real travel made it matter immediately, with
  // "S drives down the screen" reading 54px against W's 254px. That is a wall,
  // not a control. `05` is Straight Deathmatch, the trailing `05` is The
  // Quarry — the emptiest board, chosen for exactly this.
  await page.evaluate((t) => {
    window.__clock.accept({ height: 999999, hash: 'ab'.repeat(30) + '0505', time: t })
  }, Math.floor(Date.now() / 1000))
  await frames(30)
  const boardName = await page.evaluate(() => document.getElementById('hud-map')?.textContent)
  check('the board is pinned to a known map', boardName === 'The Quarry', String(boardName))

  // The middle of The Quarry, which has 300px of clear ground in all four
  // directions — checked against the layout's cover list and its 180° mirror,
  // not eyeballed.
  const park = (hull) =>
    page.evaluate((h) => {
      const g = window.__game
      g.tank.x = 1050
      g.tank.y = 775
      g.tank.hull = h
      g.tank.gun = h
      g.tank.dead = false
      g.tank.reloadAt = 0
    }, hull)

  // Each scenario gets its own pad index, because each one stands for a
  // different piece of hardware. Calibration is per-pad and deliberately
  // remembers the lowest reading it has ever seen, so reusing one index would
  // mean scenario three inherits scenario one's idea of where centre is — and a
  // trigger that "rests" at 0.6 on a pad previously seen at 0.0 is a player
  // pulling it, which is the opposite of the case under test.
  let padIndex = 0
  // Returns the new index *and* leaves it current, so the calls that follow
  // land on the same pad rather than silently minting another one.
  const newPad = () => ++padIndex
  const setPad = (axes, buttons = [0, 0, 0, 0, 0, 0, 0, 0], index = padIndex) =>
    page.evaluate((p) => (window.__pad = p.axes ? p : null), { axes, buttons, index })

  /** Hold a key for a beat and report how far and which way the tank went. */
  const holdKey = async (key, hull) => {
    await park(hull)
    await frames(12)
    const a = await page.evaluate(() => ({ ...window.__game.tank }))
    await page.keyboard.down(key)
    await frames(HOLD_FRAMES)
    await page.keyboard.up(key)
    await frames(10)
    const b = await page.evaluate(() => ({ ...window.__game.tank }))
    const dx = b.x - a.x
    const dy = b.y - a.y
    return { dist: Math.hypot(dx, dy), angle: screenAngle(dx, dy) }
  }

  /** The same, but the input is the fake pad rather than a key. */
  const holdPad = async (axes, hull, buttons) => {
    await park(hull)
    await setPad(axes, buttons)
    await frames(12)
    const a = await page.evaluate(() => ({ ...window.__game.tank }))
    await frames(HOLD_FRAMES)
    const b = await page.evaluate(() => ({ ...window.__game.tank }))
    const dx = b.x - a.x
    const dy = b.y - a.y
    return { dist: Math.hypot(dx, dy), angle: screenAngle(dx, dy) }
  }

  // ------------------------------------------------- the keys point the right way
  //
  // Hull pre-aligned each time, so this measures the steady travel direction
  // and not the arc of turning into it — otherwise every reading is dominated
  // by whichever way the tank happened to be facing.

  await setPad(null)
  const IDEAL = { KeyW: -90, KeyA: 180, KeyS: 90, KeyD: 0 }
  const HULL = { KeyW: -Math.PI / 2, KeyA: Math.PI, KeyS: Math.PI / 2, KeyD: 0 }
  const baseline = {}
  for (const [key, ideal] of Object.entries(IDEAL)) {
    const m = await holdKey(key, HULL[key])
    baseline[key] = m.dist
    check(
      `${key.slice(3)} drives ${ideal === -90 ? 'up' : ideal === 90 ? 'down' : ideal === 0 ? 'right' : 'left'} the screen`,
      m.dist > 40 && Math.abs(norm(m.angle - ideal)) < 12,
      `${m.angle.toFixed(0)}° (ideal ${ideal}°), ${m.dist.toFixed(0)}px`,
    )
  }

  // ------------------------------------------- a bad pad must not take the keyboard
  //
  // Every one of these was a dead or crippled keyboard before the drift
  // calibration went in. The right-stick and trigger cases measured 0px.

  const BAD_PADS = [
    { label: 'a centred pad', axes: [0, 0, 0, 0], buttons: undefined },
    { label: 'left-stick drift 0.25', axes: [0.25, 0, 0, 0], buttons: undefined },
    { label: 'left-stick drift 0.45', axes: [0, -0.45, 0, 0], buttons: undefined },
    { label: 'right-stick drift 0.30 (aims, cannot steer)', axes: [0, 0, 0.3, 0], buttons: undefined },
    { label: 'a trigger resting at 0.15', axes: [0, 0, 0, 0], buttons: [0, 0, 0, 0, 0, 0, 0, 0.15] },
    { label: 'a trigger resting at 0.6', axes: [0, 0, 0, 0], buttons: [0, 0, 0, 0, 0, 0, 0, 0.6] },
  ]

  for (const bad of BAD_PADS) {
    await setPad(bad.axes, bad.buttons, newPad())
    const m = await holdKey('KeyW', -Math.PI / 2)
    check(
      `W still drives with ${bad.label}`,
      m.dist > baseline.KeyW * 0.6 && Math.abs(norm(m.angle - -90)) < 20,
      `${m.dist.toFixed(0)}px at ${m.angle.toFixed(0)}° vs ${baseline.KeyW.toFixed(0)}px clean`,
    )
  }

  // A resting trigger is also the fire button. It must not shoot by itself.
  await setPad([0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0.6], newPad())
  await park(0)
  const ghostFire = await page.evaluate(async () => {
    const g = window.__game
    const before = g.shells.size
    await new Promise((r) => setTimeout(r, 1500))
    return { before, after: g.shells.size }
  })
  check(
    'a resting trigger does not fire on its own',
    ghostFire.after <= ghostFire.before,
    `shells ${ghostFire.before} -> ${ghostFire.after}`,
  )

  // ---------------------------------------------------- the pad still has to work
  //
  // The fix would be worthless if it made the controller unusable, which is the
  // obvious way to overshoot it.

  await setPad([0, 0, 0, 0], undefined, newPad())
  await frames(20)
  const padDrive = await holdPad([0, -0.9, 0, 0], -Math.PI / 2)
  check(
    'a pushed left stick drives the tank',
    padDrive.dist > 40 && Math.abs(norm(padDrive.angle - -90)) < 20,
    `${padDrive.dist.toFixed(0)}px at ${padDrive.angle.toFixed(0)}°`,
  )

  // ...and it must still work on a pad that drifts, which is the whole point of
  // calibrating rather than just raising the threshold.
  await setPad([0.25, 0, 0, 0], undefined, newPad())
  await frames(20)
  const driftyDrive = await holdPad([0.25, -0.9, 0, 0], -Math.PI / 2)
  check(
    'a pushed stick works on a pad that also drifts',
    driftyDrive.dist > 40,
    `${driftyDrive.dist.toFixed(0)}px at ${driftyDrive.angle.toFixed(0)}°`,
  )

  await park(0)
  await setPad([0, 0, 0, 0], undefined, newPad())
  await frames(20)
  await setPad([0, 0, 0, 0], [1, 0, 0, 0, 0, 0, 0, 0]) // A button
  const padFire = await page.evaluate(async () => {
    const g = window.__game
    await new Promise((r) => setTimeout(r, 1200))
    return g.shells.size
  })
  check('the A button fires', padFire > 0, `${padFire} shells`)

  await park(0)
  // Resting first, then pulled — a trigger already held when the pad is first
  // seen calibrates as its rest position, same as a stick, and needs one
  // release. That is the honest sequence.
  await setPad([0, 0, 0, 0], undefined, newPad())
  await frames(20)
  await setPad([0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0.9]) // trigger, pushed
  const triggerFire = await page.evaluate(async () => {
    const g = window.__game
    await new Promise((r) => setTimeout(r, 1200))
    return g.shells.size
  })
  check('a pulled trigger fires', triggerFire > 0, `${triggerFire} shells`)

  // The right stick aims. Push it and the gun should come round to match.
  await park(0)
  await setPad([0, 0, 0, 0], undefined, newPad())
  await frames(20)
  await setPad([0, 0, 0, 0.9], [0, 0, 0, 0, 0, 0, 0, 0])
  const gun = await gunSettled()
  check(
    'the right stick aims the gun',
    Math.abs(norm((gun * 180) / Math.PI - 90)) < 25,
    `gun at ${((gun * 180) / Math.PI).toFixed(0)}°, asked for 90°`,
  )
  // ------------------------------- the same stick, seen from inside the tank
  //
  // In board view the right stick sets an absolute angle on the board, because
  // screen space and board space line up. In the cockpit they do not — the
  // camera yaws with the gun — so a stick pushed up the glass has to mean
  // "ahead of this vehicle" instead.
  //
  // Every case below starts the gun 90 degrees away from the right answer *and*
  // 90 degrees away from the wrong one, so the turret can reach either inside
  // the window and arriving at one is a real choice rather than a slew rate. An
  // earlier draft parked the gun where the correct answer already was, which
  // would have passed against a build that ignored the stick entirely.
  const stickGun = async (hullDeg, gunDeg) => {
    await page.evaluate(
      ({ h, g }) => {
        const t = window.__game.tank
        t.x = 1400
        t.y = 1100
        t.hull = h
        t.gun = g
        t.dead = false
        t.reloadAt = 0
      },
      { h: (hullDeg * Math.PI) / 180, g: (gunDeg * Math.PI) / 180 },
    )
    await setPad([0, 0, 0, 0], undefined, newPad())
    await frames(20)
    // Straight up the glass.
    await setPad([0, 0, 0, -0.9], [0, 0, 0, 0, 0, 0, 0, 0])
    await gunSettled()
    return page.evaluate(() => (window.__game.tank.gun * 180) / Math.PI)
  }

  const boardUp = await stickGun(0, 0)
  check(
    'in board view the right stick is an angle on the board',
    Math.abs(norm(boardUp + 90)) < 25,
    `gun at ${boardUp.toFixed(0)}°, asked for -90°`,
  )

  await page.evaluate(() => document.getElementById('view-toggle').click())
  await wait(200)
  const inCockpit = await page.evaluate(() => window.__renderer.viewMode)
  check('the view toggle reaches the cockpit', inCockpit === 'cockpit', inCockpit)

  // Hull across the board from screen-up: the right answer and the board-space
  // answer are 180 degrees apart, which no tolerance can blur.
  const cockpitUp = await stickGun(90, 0)
  check(
    'in the cockpit the right stick is a bearing off the hull',
    Math.abs(norm(cockpitUp - 90)) < 25,
    `gun at ${cockpitUp.toFixed(0)}°, hull at 90°, board-space answer is -90°`,
  )

  // Again with the hull somewhere else, because a check that only ever sees one
  // heading cannot tell "follows the hull" from "happens to land on 90".
  const cockpitAgain = await stickGun(-45, 45)
  check(
    'and it follows the hull when the hull moves',
    Math.abs(norm(cockpitAgain + 45)) < 25,
    `gun at ${cockpitAgain.toFixed(0)}°, hull at -45°, board-space answer is -90°`,
  )

  await page.evaluate(() => document.getElementById('view-toggle').click())
} catch (err) {
  check('the run completed', false, err.message)
} finally {
  await browser.close()
}

console.log('')
if (failures.length) {
  console.error(`${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('All control checks passed.')
