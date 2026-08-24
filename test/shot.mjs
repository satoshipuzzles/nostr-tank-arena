// One browser, one room, a pinned block, photographed.
//
// This exists because a passing structural test is not a picture. The ring
// under your tank and every pickup pad spent weeks at y=1.2 and y=1.5 while the
// board's felt sits at y=2.5 — drawn every frame, inside the board, never once
// reaching a pixel. `visible` was `true` the whole time and no DOM assertion
// could have told the difference. A screenshot could, and did.
//
//   npm run build && npm run preview &
//   node test/shot.mjs .scratch/shots/pickups.png [hash-suffix]
//
// The suffix is the last four hex digits of the pretend block hash: the first
// two pick the rules, the last two pick the map. `0300` is Supply Run on
// Crossroads, which stocks every pad and is the frame worth looking at.

import { existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import puppeteer from 'puppeteer-core'

const OUT = process.argv[2] ?? '.scratch/shots/board.png'
const SUFFIX = process.argv[3] ?? '0300'

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

mkdirSync(dirname(OUT), { recursive: true })

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
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--disable-background-timer-throttling',
  ],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  const url = process.env.TANK_URL ?? 'http://localhost:4173/'
  await page.goto(`${url}?room=shot${Math.floor(Math.random() * 1e6)}`)
  await page.type('#name', 'shot')
  // `node test/shot.mjs out.png 0300 2` photographs a couch match.
  if (process.argv[4] === '2') await page.click('#players button[data-value="2"]')
  await page.click('#play-guest')
  await new Promise((r) => setTimeout(r, 5000))

  await page.evaluate((suffix) => {
    // With a `time`, or the clock sits `chainPending` forever and the pickup
    // schedule — which refuses to derive a wave it cannot anchor — never spawns
    // anything. An injected tip has to carry the mined-at the poller would fetch.
    window.__clock.accept({
      height: 999999,
      hash: 'ab'.repeat(30) + suffix,
      time: Math.floor(Date.now() / 1000) - 30,
    })
  }, SUFFIX)
  await new Promise((r) => setTimeout(r, 1200))
  // The podium covers the board for nine seconds after a block lands.
  await page.evaluate(() => { document.getElementById('podium').hidden = true })
  await new Promise((r) => setTimeout(r, 2500))

  // Wait for a wave rather than assuming one. Pickups no longer land on a
  // metronome — the spawn moment moves inside its frame and most of a frame is
  // empty board on purpose — so a fixed sleep photographs an empty arena about
  // half the time and the picture proves nothing about the icons on the pads.
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const live = await page.evaluate(() => window.__game.pickups.size)
    if (live > 0) break
    await new Promise((r) => setTimeout(r, 500))
  }

  console.log(await page.evaluate(() => ({
    map: document.getElementById('hud-map')?.textContent,
    rules: window.__game.modifier.name,
    pickups: [...window.__game.pickups.values()].map((p) => p.kind),
  })))
  await page.screenshot({ path: OUT })
  console.log('wrote', OUT)
} finally {
  await browser.close()
}
