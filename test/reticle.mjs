// No orange box on the screen when you shoot, and the cockpit still tells you
// the gun is reloading.
//
// Puzz: "I get a yellow box on my screen when shooting." It was `reloadBar` —
// an unlit `#ffc44d` box at the tank's own position, drawn with
// `depthTest: false`, so from the cockpit camera it sat a few units off the
// near plane and painted over everything for the whole 1.05s reload. It is
// correct and useful from the board camera, which is why it survived so long:
// every screenshot anyone took was a board screenshot.
//
// A structural test cannot see this. The mesh existed, was `visible`, was the
// right colour and in the right place — the only thing wrong was which camera
// was looking at it. So this counts pixels, and it counts them in both views,
// because the fix must not take the bar away from the board.
//
//   npm run build && npm run preview &
//   node test/reticle.mjs

import { existsSync, mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL = process.env.TANK_URL ?? 'http://localhost:4173/'
const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!executablePath) {
  console.log('  SKIP no Chrome found — set CHROME_PATH. This suite did not run.')
  process.exit(0)
}

let failures = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

mkdirSync('.scratch/shots', { recursive: true })
const browser = await puppeteer.launch({
  executablePath, headless: 'new',
  args: ['--no-sandbox', '--window-size=1280,800', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--mute-audio',
    '--disable-background-timer-throttling'],
})

/**
 * Count strongly-saturated amber pixels in the play area.
 *
 * The frame is read back by drawing the screenshot into a 2D canvas rather than
 * `readPixels` off the live WebGL context — the drawing buffer is not preserved
 * between frames, so a direct read comes back black and would pass everything.
 *
 * `skipCentre` cuts out the reticle, which is deliberately this colour while
 * reloading and would otherwise be indistinguishable from the bug.
 */
async function amberPixels(page, { skipCentre }) {
  const shot = await page.screenshot({ encoding: 'base64' })
  return page.evaluate(async (b64, skip) => {
    const img = new Image()
    img.src = 'data:image/png;base64,' + b64
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    // The HUD panels live above this band and the control hints below it, and
    // both use the same accent colour in text.
    const y0 = Math.round(c.height * 0.24)
    const y1 = Math.round(c.height * 0.86)
    const cx = c.width / 2
    const cy = c.height / 2
    let n = 0
    for (let y = y0; y < y1; y++) {
      for (let x = 0; x < c.width; x++) {
        if (skip && Math.abs(x - cx) < 40 && Math.abs(y - cy) < 40) continue
        const i = (y * c.width + x) * 4
        if (d[i] > 215 && d[i + 1] > 140 && d[i + 1] < 220 && d[i + 2] < 125) n++
      }
    }
    return n
  }, shot, skipCentre)
}

async function match(page, room) {
  await page.goto(`${URL}?room=${room}`)
  await page.evaluate(() => localStorage.setItem('tank.view', 'board'))
  await page.goto(`${URL}?room=${room}`)
  await page.type('#name', 'ret')
  await page.click('#play-guest')
  await new Promise((r) => setTimeout(r, 4000))
  // Pin the round. The map, the rules and the pickup schedule all come off the
  // live chain otherwise, and an amber Scattershot icon on a pad would be
  // counted as the bug on some runs and not others.
  await page.evaluate(() => window.__clock.accept({
    height: 999999, hash: 'cd'.repeat(30) + '0000',
    time: Math.floor(Date.now() / 1000) - 30,
  }))
  await new Promise((r) => setTimeout(r, 1200))
  await page.evaluate(() => { document.getElementById('podium').hidden = true })
  await new Promise((r) => setTimeout(r, 800))
}

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  await match(page, `ret${Math.floor(Math.random() * 1e6)}`)

  // --- cockpit: the bug ---
  await page.keyboard.press('KeyV')
  await new Promise((r) => setTimeout(r, 1000))
  check(await page.$eval('#crosshair', (el) => !el.hidden), 'cockpit shows the crosshair')

  const quiet = await amberPixels(page, { skipCentre: true })
  await page.keyboard.down('Space')
  await new Promise((r) => setTimeout(r, 400))
  const firing = await amberPixels(page, { skipCentre: true })
  await page.screenshot({ path: '.scratch/shots/reticle-cockpit-firing.png' })
  // Deliberately a delta, not a total: a pickup pad or a wall texture can put
  // a few dozen warm pixels on screen for reasons that have nothing to do with
  // the gun, and those are present in both samples.
  check(firing - quiet < 400,
    'firing paints no amber slab over the cockpit', `${quiet} idle → ${firing} firing`)

  const reticle = await page.evaluate(() => {
    const el = document.getElementById('crosshair')
    return { loading: el.classList.contains('loading'), bloom: el.style.getPropertyValue('--bloom') }
  })
  check(reticle.loading, 'the reticle says the gun is loading')
  check(parseFloat(reticle.bloom) > 0, 'and blooms while it loads', reticle.bloom)
  await page.keyboard.up('Space')

  // The gun is loaded again a second later, and the reticle has to come back.
  await new Promise((r) => setTimeout(r, 1600))
  const rested = await page.evaluate(() => {
    const el = document.getElementById('crosshair')
    return { loading: el.classList.contains('loading'), bloom: parseFloat(el.style.getPropertyValue('--bloom')) }
  })
  check(!rested.loading && rested.bloom === 0, 'and closes back when the gun is ready',
    JSON.stringify(rested))

  // --- board: the bar has to still be there ---
  await page.keyboard.press('KeyV')
  await new Promise((r) => setTimeout(r, 1000))
  const boardQuiet = await page.evaluate(() => window.__renderer.reloadBar.visible)
  await page.keyboard.down('Space')
  await new Promise((r) => setTimeout(r, 300))
  const boardFiring = await page.evaluate(() => window.__renderer.reloadBar.visible)
  await page.screenshot({ path: '.scratch/shots/reticle-board-firing.png' })
  await page.keyboard.up('Space')
  check(!boardQuiet && boardFiring, 'the board view still gets its reload bar',
    `idle ${boardQuiet}, firing ${boardFiring}`)
  check(await page.$eval('#crosshair', (el) => el.hidden), 'and no crosshair')
} finally {
  await browser.close()
}
process.exit(failures ? 1 : 0)
