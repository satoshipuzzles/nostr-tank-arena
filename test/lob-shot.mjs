// The half of the lob that arithmetic cannot answer: does it reach a pixel.
//
// Three frames — charging, mid-arc, and the crater — photographed and checked
// for the two things a scene-graph assertion cannot see. `npm run test:lob`
// proves the trajectory; this proves you can look at the board and tell what
// is about to happen to you.
//
//   npm run build && npx vite preview --port 4188 &
//   node test/lob-shot.mjs

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL = process.env.TANK_URL ?? 'http://localhost:4188/'
const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!executablePath) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2) }

const FLAGS = [
  '--no-sandbox', '--window-size=1280,800', '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--mute-audio',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}
const until = async (fn, ms = 25_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 90)) }
  return null
}

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'lob')
  await page.type('#room', 'lob' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page.waitForFunction(
    () => !!window.__game && !!window.__renderer, { timeout: 25_000 },
  ).then(() => true).catch(() => false)
  check('a game is running', started)
  if (!started) throw new Error('never started')

  // Pin the round, and nail it shut. `beginRound` fires again on the first live
  // tip and resets the hull; anything this suite sets up before then is undone
  // a few seconds in, silently. See test/damage.mjs — this cost an evening.
  await page.evaluate(() => {
    const g = window.__game
    g.beginRound(900000, 'ab'.repeat(30) + '0300')
    g.beginRound = () => {}
  })

  const park = () => page.evaluate(() => {
    const g = window.__game
    g.peers.clear(); g.tank.dead = false
    g.tank.x = 700; g.tank.y = 600; g.tank.hull = 0; g.tank.gun = 0
    g.tank.hp = g.maxHp; g.tank.ammo = 4; g.tank.reloadAt = 0; g.tank.reloadingUntil = 0
    g.buffs.shieldUntil = 0
  })
  await park()

  // ------------------------------------------------------------ the ring

  // Counted in a box around where the ring must be, from the game's own
  // `lobAim` — not from a coordinate typed in here, which would go stale the
  // first time the range constants move.
  const amber = async () => page.evaluate(() => {
    const g = window.__game, r = window.__renderer
    const aim = g.lobAim
    if (!aim) return null
    const p = r.toScreen(aim.x, 6, aim.y)
    if (!p) return null
    const px = r.probePixels(Math.round(p.x) - 90, Math.round(p.y) - 60, 180, 120)
    let hot = 0
    for (let i = 0; i < px.length; i += 4) {
      const [red, green, blue] = [px[i], px[i + 1], px[i + 2]]
      // Amber through red, and brighter than the felt underneath it.
      if (red > 150 && red - blue > 70 && red - green > 25) hot++
    }
    return { hot, x: Math.round(aim.x), y: Math.round(aim.y), charge: aim.charge }
  })

  // Control first: nothing is charging, so there must be no ring anywhere near
  // where one would go. Without this, "the ring is on screen" is a sentence
  // about a pickup pad that happened to be orange.
  const restingSpot = await page.evaluate(() => {
    const r = window.__renderer, g = window.__game
    const p = r.toScreen(g.tank.x + 400, 6, g.tank.y)
    if (!p) return null
    const px = r.probePixels(Math.round(p.x) - 90, Math.round(p.y) - 60, 180, 120)
    let hot = 0
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] > 150 && px[i] - px[i + 2] > 70 && px[i] - px[i + 1] > 25) hot++
    }
    return hot
  })
  check('with nothing charging, that patch of felt is not orange', restingSpot !== null && restingSpot < 60, `hot=${restingSpot}`)
  check('and the game reports no lob aim at rest', (await page.evaluate(() => window.__game.lobAim)) === null)

  await page.keyboard.down('q')
  const charging = await until(async () => {
    const a = await amber()
    return a && a.hot > 200 ? a : null
  })
  check('holding Q puts a landing ring on the felt', !!charging, charging ? `${charging.hot} px, charge ${charging.charge.toFixed(2)}` : 'never appeared')
  await page.screenshot({ path: '/tmp/lob-charging.png' })

  // The range has to wind up with the hold. Read against a *pinned* charge
  // start rather than against the wall clock: this page runs at a handful of
  // frames a second under swiftshader, so a single round trip into the page
  // costs more than the whole 900ms charge window, and the first version of
  // this check read a fully wound 1.00 for both its "early" and "late" samples
  // and concluded the range never moved. Pinning the origin measures the thing
  // under test — the getter's arithmetic and the mesh it drives — instead of
  // racing the renderer.
  //
  // Set on the live game rather than passed to a pure function on purpose: this
  // has to go through the same `lobAim` the renderer reads every frame, or it
  // proves an equation nobody calls.
  const band = await page.evaluate(() => {
    const g = window.__game
    const at = (heldMs) => {
      g.lobFrom = performance.now() - heldMs
      const aim = g.lobAim
      return aim && { x: Math.round(aim.x), charge: aim.charge }
    }
    const tap = at(40)
    const held = at(2000)
    const ringAt = (() => { const r = window.__renderer; return { x: Math.round(r.lobRing.position.x), on: r.lobRing.visible } })()
    return { tap, held, ringAt }
  })
  check(
    'a longer hold puts the ring further out',
    !!band?.tap && !!band?.held && band.held.x > band.tap.x + 200,
    band?.tap && band?.held ? `x ${band.tap.x} at charge ${band.tap.charge.toFixed(2)} -> ${band.held.x} at ${band.held.charge.toFixed(2)}` : 'no reading',
  )
  check(
    'and the charge saturates rather than running away past full range',
    !!band?.held && band.held.charge === 1,
    `charge after a 2s hold on a ${900}ms wind-up: ${band?.held?.charge}`,
  )

  await page.keyboard.up('q')

  // -------------------------------------------------------- the arc

  // A shell in the air, drawn above the board rather than on it. Measured as a
  // height in world units off the renderer's own mesh, because "the shell is
  // higher up the screen" is also what a shell further away looks like.
  // Accumulated across the whole flight, not sampled once. A lob leaves the
  // muzzle at ground level and comes back to it, so a single reading taken at
  // whatever moment the poll happened to land is as likely to catch it at
  // y=38 as at its apex — which is exactly what the first run of this did, and
  // it read as "the arc never leaves the deck".
  let peak = 0
  let sawShadow = false
  let sawArc = false
  let shotFrom = null
  let shadowCleared = null
  // Bounded by wall-clock, generously, and not by a sample count.
  //
  // `draw` clamps its delta to 50ms so a backgrounded tab cannot teleport the
  // world, which is right in a game and brutal in a headless browser: swiftshader
  // renders this page at three or four frames a second, so the simulation
  // advances at roughly a sixth of real time and a two-second flight takes
  // fifteen. A loop of 220 samples ran out mid-arc with the shell still
  // climbing. Sampling more slowly also helps — every `evaluate` competes with
  // the render loop for the same thread.
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const s = await page.evaluate(() => {
      const g = window.__game, r = window.__renderer
      for (const sh of g.shells.values()) {
        if (sh.lob > 0) {
          const mesh = r.shells.get(sh.id)
          return { live: true, y: mesh ? mesh.position.y : 0, shadow: r.lobShadow.visible, lob: sh.lob }
        }
      }
      return { live: false, shadow: r.lobShadow.visible }
    })
    if (s.live) {
      sawArc = true
      shotFrom = s.lob
      peak = Math.max(peak, s.y)
      if (s.shadow) sawShadow = true
    } else if (sawArc) {
      shadowCleared = s.shadow === false
      break
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  check('releasing Q puts a shell in the air, not on the deck', sawArc && peak > 90, `apex mesh y=${Math.round(peak)}, range ${shotFrom}`)
  check('and it casts a shadow on the ground under it', sawShadow)
  // `null` is its own failure, not a pass. The first cut of this loop ran out
  // of iterations while the shell was still in the air, so the check simply
  // never executed and the suite printed nine passes and no ninth line — which
  // reads exactly like a clean run if you are not counting.
  check(
    'the shadow goes away when the shell does',
    shadowCleared === true,
    shadowCleared === null ? 'the shell never landed inside the sampling window' : `shadow=${!shadowCleared}`,
  )
  await page.screenshot({ path: '/tmp/lob-arc.png' })
  check('and the ring is gone once the key is up', (await page.evaluate(() => window.__renderer.lobRing.visible)) === false)
  await page.screenshot({ path: '/tmp/lob-landed.png' })

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall good')
process.exit(failures.length ? 1 : 0)
