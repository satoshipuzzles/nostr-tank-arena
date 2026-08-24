// The turret sweep, in a browser, on the built bundle, in top-down view.
//
// test/aim.mjs proves the arithmetic. This proves the arithmetic is what the
// game is running: a fake pad, a real match, the right stick pushed round the
// full circle, and the gun read out of the live tank at every step.
//
// It is deliberately a *gentle* push. At full deflection the old per-axis
// deadzone reached all 24 sectors and this suite would have gone green against
// the bug — the fault only shows when the stick is not at the rim.
//
// Settling is counted in animation frames, never in milliseconds. Under
// swiftshader this page runs a long way under 60fps, and a fixed wait becomes
// one frame: the gun moves its per-frame cap, stops, and the reading says
// "cannot reach that bearing" when the truth is "no frame happened".
//
//   npm run build && npx vite preview --port 4189 --strictPort &
//   TANK_URL=http://localhost:4189/ node test/aim-browser.mjs

import { existsSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4173/'
const PUSH = 0.28
const SECTORS = 24

let failures = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
]
  .filter(Boolean)
  .find((p) => existsSync(p))
if (!executablePath) {
  console.log('  SKIP no Chrome found — set CHROME_PATH. Nothing was measured.')
  process.exit(0)
}

// A relay of our own, so a control test does not lean on volunteer
// infrastructure and does not fail when somebody else's relay is busy.
const relay = new WebSocketServer({ port: 0 })
relay.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let f
    try {
      f = JSON.parse(String(raw))
    } catch {
      return
    }
    if (f[0] === 'REQ') ws.send(JSON.stringify(['EOSE', f[1]]))
    if (f[0] === 'EVENT') ws.send(JSON.stringify(['OK', f[1].id, true, '']))
  })
})
const RELAY = `ws://localhost:${relay.address().port}`

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const norm = (d) => (((d % 360) + 540) % 360) - 180

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  page.on('pageerror', (e) => console.log('  page error:', e.message))
  await page.evaluateOnNewDocument(() => {
    window.__pad = null
    navigator.getGamepads = () =>
      window.__pad
        ? [
            {
              id: 'Fake Pad (Vendor: 0000 Product: 0000)',
              index: 0,
              connected: true,
              mapping: 'standard',
              timestamp: performance.now(),
              axes: window.__pad.axes,
              buttons: (window.__pad.buttons ?? [0, 0, 0, 0, 0, 0, 0, 0]).map((v) => ({
                pressed: v > 0.5,
                touched: v > 0.1,
                value: v,
              })),
            },
          ]
        : []
  })
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.$eval('#relays', (el, v) => (el.value = v), RELAY)
  await page.type('#name', 'sweep')
  await page.type('#room', 'aim' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game && !!window.__renderer, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  check(started, 'a match starts in top-down view')
  if (!started) throw new Error('nothing to sweep')

  // Screen -> world, from the renderer's own unprojection. The board camera is
  // a fixed pitch, but reading the basis rather than assuming one is what keeps
  // this honest if the camera ever moves.
  const basis = await page.evaluate(() => {
    const r = window.__renderer
    const cx = window.innerWidth / 2
    const cy = window.innerHeight / 2
    const o = r.toWorld(cx, cy)
    const px = r.toWorld(cx + 100, cy)
    const py = r.toWorld(cx, cy + 100)
    return { sx: { x: px.x - o.x, y: px.y - o.y }, sy: { x: py.x - o.x, y: py.y - o.y } }
  })
  /** Where a stick push (rx, ry) is pointing, in world degrees. */
  const expected = (rx, ry) => {
    const wx = basis.sx.x * rx + basis.sy.x * ry
    const wy = basis.sx.y * rx + basis.sy.y * ry
    return (Math.atan2(wy, wx) * 180) / Math.PI
  }

  // Claim the pad first. A stick just past the deadzone deliberately does not
  // claim it — "a stick sitting just past the deadzone is not somebody asking
  // to play" — so a gentle-push sweep on an unclaimed pad measures nothing at
  // all, and reads exactly like a turret that cannot move. Press a button once,
  // which is what a player does before they aim anyway.
  await page.evaluate(() => (window.__pad = { axes: [0, 0, 0, 0], buttons: [1] }))
  await page.waitForFunction(() => window.__players?.[0]?.input?.gamepadActive === true, { timeout: 10_000 })
  await page.evaluate(() => (window.__pad = { axes: [0, 0, 0, 0], buttons: [] }))

  await page.evaluate(() => {
    const t = window.__game.tank
    t.x = 1400
    t.y = 1100
    t.hull = 0
    t.gun = 0
    t.dead = false
    t.reloadAt = 0
  })

  /** Wait until the gun has not moved across four consecutive frames. */
  const settle = (cap = 900) =>
    page.evaluate(
      (max) =>
        new Promise((res) => {
          let last = null
          let still = 0
          let frames = 0
          const tick = () => {
            const g = window.__game.tank.gun
            if (last !== null && Math.abs(g - last) < 1e-4) still += 1
            else still = 0
            last = g
            frames += 1
            if (still >= 4) return res({ gun: g, frames, capped: false })
            if (frames >= max) return res({ gun: g, frames, capped: true })
            requestAnimationFrame(tick)
          }
          requestAnimationFrame(tick)
        }),
      cap,
    )

  const seen = new Set()
  let worst = 0
  let capped = 0
  let reversals = 0
  let prev = null
  for (let i = 0; i <= SECTORS; i += 1) {
    const bearing = (i * 360) / SECTORS
    const rx = Math.cos((bearing * Math.PI) / 180) * PUSH
    const ry = Math.sin((bearing * Math.PI) / 180) * PUSH
    await page.evaluate((p) => (window.__pad = p), { axes: [0, 0, rx, ry], buttons: [] })
    const { gun, capped: hit } = await settle()
    if (hit) capped += 1
    const deg = (gun * 180) / Math.PI
    const want = expected(rx, ry)
    const err = Math.abs(norm(deg - want))
    if (err > worst) worst = err
    seen.add(Math.round(norm(deg) / (360 / SECTORS)) % SECTORS)
    if (prev !== null) {
      const moved = norm(deg - prev)
      // Every step of this sweep asks for +15°. A negative move is the turret
      // going the wrong way, which is the whole bug.
      if (moved < -1) reversals += 1
    }
    prev = deg
  }

  check(capped === 0, 'every settle finished on its own rather than running out of frames', `${capped} capped`)
  check(
    seen.size === SECTORS,
    `a gentle push (${PUSH}) reaches all ${SECTORS} sectors of the circle`,
    `${seen.size}/${SECTORS}`,
  )
  check(reversals === 0, 'and the gun never travels the wrong way round', `${reversals} reversals`)
  check(worst < 8, 'the gun ends up where the stick is pointing', `worst error ${worst.toFixed(1)}°`)

  // Let go: the pad stops claiming the aim, and the gun stays put rather than
  // snapping anywhere.
  await page.evaluate(() => (window.__pad = { axes: [0, 0, 0, 0], buttons: [] }))
  const rest1 = await settle()
  const rest2 = await settle()
  check(
    Math.abs(norm(((rest2.gun - rest1.gun) * 180) / Math.PI)) < 0.5,
    'and it holds its bearing when the stick is released',
  )
} finally {
  await browser.close()
  relay.close()
}
process.exit(failures ? 1 : 0)
