// The cockpit camera and the npub faces, checked where they can actually fail.
//
//   npm run build && npm run preview &
//   node test/cockpit.mjs
//
// Four things are worth a guard here, and the interesting one is the third.
//
//  1. **The camera really moves into the hatch.** `visible` flags and a green
//     DOM suite cannot tell a cockpit from a board camera that changed its fov.
//     So: measure the distance from the camera to the tank and the angle
//     between where it looks and where the gun points.
//
//  2. **Your own barrel is in front of the near plane.** The board camera's
//     near plane is 60 and the gun ends ~45 units from the eye — get this wrong
//     and the cockpit is a floating eye with no tank attached, which renders
//     perfectly and looks like nothing is wrong.
//
//  3. **Aim is measured off the hull, not off the camera.** This is the bug
//     this file exists for. In cockpit the camera yaws with the gun, so reading
//     the cursor against the *camera's* yaw is a loop with no fixed point: a
//     cursor a little off centre turns the turret, which turns the camera,
//     which leaves the cursor exactly as far off centre as it was, forever. The
//     symptom is a turret that spins while the mouse sits perfectly still.
//
//     Note what is asserted: the gun angle **settles**, not that it moved.
//     "The turret responded to the mouse" is true of both the fix and the bug —
//     an assertion consistent with both cannot carry the claim. Total travel
//     over the last second is the quantity that differs: bounded for a bearing
//     off the hull, a full turn per second for a bearing off the camera.
//
//  4. **A face is a face.** An avatar whose picture never loads must still be a
//     disc with initials on it, and one whose picture does load must not still
//     be that disc. Both are read off the canvas the texture is painted from,
//     because a `CanvasTexture` with nothing drawn on it is as `visible` as any
//     other.

import { existsSync, mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_BASE = process.env.TANK_URL ?? 'http://localhost:4173/'
const SHOTS = '.scratch/shots'

const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p))
if (!executablePath) {
  console.error('No Chrome found. Set CHROME_PATH.')
  process.exit(2)
}
mkdirSync(SHOTS, { recursive: true })

let failures = 0
const ok = (name, pass, detail = '') => {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
  if (!pass) failures++
}

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--window-size=1280,800',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--mute-audio',
    '--disable-background-timer-throttling',
  ],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  page.on('pageerror', (e) => { console.log('FAIL page error', e.message); failures++ })
  await page.goto(`${URL_BASE}?room=cockpit${Math.floor(Math.random() * 1e6)}`)
  await page.type('#name', 'cockpit')
  await page.click('#play-guest')

  // Pin the chain. Anything derived from the live tip — the map, the rules —
  // makes the arena a different shape every run, and the tank's start position
  // moves with it.
  await page.waitForFunction(() => window.__renderer && window.__game, { timeout: 20_000 })
  await page.evaluate(() => {
    window.__clock.accept({ height: 999999, hash: 'ab'.repeat(30) + '0300' })
  })
  await page.waitForFunction(() => document.getElementById('podium'), { timeout: 10_000 })
  await new Promise((r) => setTimeout(r, 1500))
  await page.evaluate(() => { document.getElementById('podium').hidden = true })

  // ------------------------------------------------------- board is the default
  const board = await page.evaluate(() => ({
    mode: window.__renderer.viewMode,
    y: window.__renderer.camera.position.y,
    near: window.__renderer.camera.near,
    crosshair: getComputedStyle(document.getElementById('crosshair')).display,
  }))
  ok('board view is the default', board.mode === 'board', `mode=${board.mode}`)
  ok('board camera is above the arena', board.y > 900, `y=${Math.round(board.y)}`)
  // Computed style, not the attribute: `#crosshair { display: grid }` beats the
  // UA `[hidden]` rule unless the stylesheet marks it important, and the
  // attribute reads `true` either way.
  ok('crosshair is not painted in board view', board.crosshair === 'none', board.crosshair)
  await page.screenshot({ path: `${SHOTS}/view-board.png` })

  // ------------------------------------------------------------- into the hatch
  await page.keyboard.press('KeyV')
  await new Promise((r) => setTimeout(r, 700))

  const cockpit = await page.evaluate(() => {
    const r = window.__renderer
    const t = window.__game.tank
    const cam = r.camera
    // Where the camera is looking, taken off its own matrix rather than off the
    // value we handed `lookAt` — that is the only version the GPU sees.
    const v = cam.getWorldDirection(new cam.position.constructor())
    const dir = { x: v.x, y: v.y, z: v.z }
    return {
      mode: r.viewMode,
      near: cam.near,
      fov: cam.fov,
      cam: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
      tank: { x: t.x, y: t.y, gun: t.gun },
      dir,
      crosshair: getComputedStyle(document.getElementById('crosshair')).display,
      label: r.you.label.visible,
      pips: r.you.pips.map((p) => p.visible),
    }
  })

  const dx = cockpit.cam.x - cockpit.tank.x
  const dz = cockpit.cam.z - cockpit.tank.y
  const dist = Math.hypot(dx, dz)
  ok('V puts the camera in the hatch', cockpit.mode === 'cockpit', `mode=${cockpit.mode}`)
  ok('camera sits on the tank, not over the board', dist < 60 && cockpit.cam.y < 90,
     `dist=${dist.toFixed(1)} y=${cockpit.cam.y.toFixed(1)}`)
  // The barrel ends about 45 units ahead of the eye. A near plane of 60 clips
  // the whole tank away and the view still renders, just with nothing in it.
  ok('near plane is in front of the eye, not past the barrel', cockpit.near < 20,
     `near=${cockpit.near}`)
  ok('field of view opens up inside the tank', cockpit.fov > 60, `fov=${cockpit.fov}`)

  // Looking down the gun: the camera's forward vector against the gun bearing.
  const camYaw = Math.atan2(cockpit.dir.z, cockpit.dir.x)
  let off = camYaw - cockpit.tank.gun
  while (off > Math.PI) off -= Math.PI * 2
  while (off < -Math.PI) off += Math.PI * 2
  ok('camera looks down the barrel', Math.abs(off) < 0.12,
     `off=${(off * 180 / Math.PI).toFixed(1)}deg`)
  ok('crosshair is painted in cockpit view', cockpit.crosshair === 'grid', cockpit.crosshair)
  ok('name plate comes off in the cockpit', cockpit.label === false)
  ok('hull pips come off in the cockpit', cockpit.pips.every((v) => v === false))

  await page.screenshot({ path: `${SHOTS}/view-cockpit.png` })

  // ------------------------------------ the turret settles under a still cursor
  //
  // Hold the mouse well off centre and leave it there. A bearing measured off
  // the hull reaches its commanded angle and stops. A bearing measured off the
  // camera never stops, because the camera moved to wherever the last frame put
  // the gun.
  //
  // The first version of this counted degrees travelled over a fixed 1.4s and
  // passed against a build with the loop deliberately put back — because the
  // turret slews at a fixed rate and 1.4s of swiftshader frames is not long
  // enough for the *working* build to arrive either. Both cases travelled 48
  // degrees. A window that cannot contain the behaviour cannot report on it.
  //
  // So: poll until it stops moving, and then assert the angle it stopped at.
  // That is the quantity that differs. "The turret responded to the mouse" is
  // true of the bug as well as the fix and cannot carry the claim alone.
  const AIM_ARC_DEG = 105
  const MOUSE_X = 1120
  await page.mouse.move(MOUSE_X, 400)
  const settle = await page.evaluate(async (mouseX) => {
    const bearing = () => {
      let d = window.__game.tank.gun - window.__game.tank.hull
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      return (d * 180) / Math.PI
    }
    let prev = bearing()
    let still = 0
    let frames = 0
    const t0 = performance.now()
    // Twelve seconds of wall clock, not a frame count: under swiftshader the
    // page runs at a small fraction of 60fps and a count is a different amount
    // of simulated time on every machine.
    while (performance.now() - t0 < 12_000) {
      await new Promise((r) => requestAnimationFrame(r))
      frames++
      const now = bearing()
      still = Math.abs(now - prev) < 0.6 ? still + 1 : 0
      prev = now
      if (still >= 8) break
    }
    const rect = document.querySelector('canvas').getBoundingClientRect()
    return {
      settled: still >= 8,
      bearing: prev,
      frames,
      ndcX: ((mouseX - rect.left) / rect.width) * 2 - 1,
    }
  }, MOUSE_X)
  ok('the turret stops moving under a still cursor', settle.settled,
     `bearing=${settle.bearing.toFixed(1)}deg after ${settle.frames} frames`)
  // The angle it stopped at, against the arc the cursor commanded. This is what
  // separates "aims where you point" from "drifted somewhere and stalled".
  const want = settle.ndcX * AIM_ARC_DEG
  ok('it stops at the bearing the cursor asked for', Math.abs(settle.bearing - want) < 8,
     `bearing=${settle.bearing.toFixed(1)}deg want=${want.toFixed(1)}deg`)

  // -------------------------------------------------------------- the faces
  //
  // Driven through `setPictureSource` and the draw loop, not by calling the
  // avatar directly. The first version of this test called `rig.avatar.set()`
  // by hand and read the canvas — and passed against a canvas the draw loop had
  // already repainted from the game's own identity on the next frame. Handing a
  // component its input tests the component; it cannot test whether anything
  // ever hands it that input.
  //
  // A guest has no npub and so is deliberately given no picture. Promote this
  // client to a signed-in identity so the local tank goes down the real lookup.
  const faces = await page.evaluate(async () => {
    const rig = window.__renderer.you
    const canvas = rig.avatar.canvas
    const ctx = canvas.getContext('2d')
    const mid = canvas.width / 2
    const read = () => {
      const p = ctx.getImageData(mid - 24, mid - 24, 48, 48).data
      let r = 0, g = 0, b = 0, a = 0
      const n = p.length / 4
      for (let i = 0; i < p.length; i += 4) { r += p[i]; g += p[i + 1]; b += p[i + 2]; a += p[i + 3] }
      r /= n; g /= n; b /= n; a /= n
      // Spread of luminance across the patch. A flat fill is ~0; white initials
      // on a coloured disc are not. This is what tells a rendered glyph from a
      // blank disc, which no average colour can.
      let varsum = 0
      for (let i = 0; i < p.length; i += 4) {
        const l = (p[i] + p[i + 1] + p[i + 2]) / 3
        varsum += (l - (r + g + b) / 3) ** 2
      }
      return { r, g, b, a, sd: Math.sqrt(varsum / n) }
    }

    window.__game.identity.isGuest = false
    window.__game.identity.pubkey = 'de'.repeat(32)
    window.__game.name = 'npub1zqwertyu'

    // A host that sends no CORS headers, which is a good share of them in the
    // wild. The load fails outright and must not look like a broken profile.
    window.__renderer.setPictureSource(() => 'https://example.invalid/nobody.png')
    await new Promise((r) => setTimeout(r, 1200))
    const fallback = read()

    // One that does load. A data URL is same-origin, so this exercises the draw
    // path without depending on anybody's image host being up today.
    const red = 'data:image/svg+xml;base64,' + btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#ff0000"/></svg>',
    )
    window.__renderer.setPictureSource(() => red)
    await new Promise((r) => setTimeout(r, 1200))
    const loaded = read()
    return { fallback, loaded }
  })
  const rgb = (c) => [c.r, c.g, c.b].map((n) => n.toFixed(0)).join(',')
  ok('a picture that will not load still paints a disc', faces.fallback.a > 200,
     `alpha=${faces.fallback.a.toFixed(0)}`)
  ok('the disc has initials on it, not just colour', faces.fallback.sd > 25,
     `sd=${faces.fallback.sd.toFixed(1)} rgb=${rgb(faces.fallback)}`)
  ok('a picture that loads replaces the disc',
     faces.loaded.r > 200 && faces.loaded.g < 70 && faces.loaded.b < 70,
     `rgb=${rgb(faces.loaded)}`)

  // ---------------------------------------------------------- and back again
  await page.keyboard.press('KeyV')
  await new Promise((r) => setTimeout(r, 700))
  const back = await page.evaluate(() => ({
    mode: window.__renderer.viewMode,
    y: window.__renderer.camera.position.y,
    near: window.__renderer.camera.near,
    label: window.__renderer.you.label.visible,
    pips: window.__renderer.you.pips.some((p) => p.visible),
    crosshair: getComputedStyle(document.getElementById('crosshair')).display,
  }))
  ok('V goes back to the board', back.mode === 'board' && back.y > 900,
     `mode=${back.mode} y=${Math.round(back.y)}`)
  ok('the board near plane comes back', back.near > 20, `near=${back.near}`)
  ok('name plate and pips come back', back.label === true && back.pips === true)
  ok('crosshair goes away again', back.crosshair === 'none', back.crosshair)
  await page.screenshot({ path: `${SHOTS}/view-board-again.png` })
} finally {
  await browser.close()
}

console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)
