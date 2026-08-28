// Every board in the rotation, photographed from the board camera.
//
// The map is a pure function of the block hash, so a board nobody has looked at
// is a board that will turn up in somebody's round with a spawn inside a crate
// or a pad behind a hedge. `test/pads.mjs` checks that as arithmetic; this is
// the half of the question arithmetic cannot answer — whether it reads.
//
//   npm run build && npm run preview &
//   node test/boards.mjs
import { existsSync, mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL = process.env.TANK_URL ?? 'http://localhost:4173/'
const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!executablePath) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2) }
mkdirSync('.scratch/shots/boards', { recursive: true })

const browser = await puppeteer.launch({
  executablePath, headless: 'new',
  args: ['--no-sandbox', '--window-size=1280,800', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--mute-audio',
    '--disable-background-timer-throttling'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  await page.goto(`${URL}?room=boards${Math.floor(Math.random() * 1e6)}`)
  await page.type('#name', 'board')
  await page.click('#play-guest')
  await new Promise((r) => setTimeout(r, 4500))
  const count = await page.evaluate(() => window.__game.pickups && 1)
  void count
  // The board changes on a round transition, and the podium sits over it for
  // nine seconds afterwards. Polling for the name to actually change is the
  // only honest wait here — a fixed sleep photographs the previous map, which
  // is exactly what the first run of this did.
  const seen = new Map()
  let previous = await page.$eval('#hud-map', (el) => el.textContent.trim())
  // The rotation's own length, not a literal. This file said 12 when 12 was
  // all there were, and the three boards added since were never photographed —
  // the same stale-literal failure test/rubble.mjs had at eight.
  const boards = await page.evaluate(() => window.__arena.LAYOUTS.length)
  for (let i = 0; i < boards; i++) {
    const suffix = '03' + i.toString(16).padStart(2, '0')
    await page.evaluate((sfx) => {
      window.__clock.accept({ height: 999000 + parseInt(sfx.slice(2), 16),
        hash: 'ab'.repeat(30) + sfx, time: Math.floor(Date.now() / 1000) - 30 })
    }, suffix)
    // Heights have to climb past the real tip or `accept` ignores them, and an
    // ignored tip looks exactly like a map that did not change.
    const deadline = Date.now() + 25_000
    let map = previous
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400))
      await page.evaluate(() => { const p = document.getElementById('podium'); if (p) p.hidden = true })
      map = await page.$eval('#hud-map', (el) => el.textContent.trim())
      if (map !== previous) break
    }
    previous = map
    if (seen.has(map)) { console.log(suffix, map, '(already photographed)'); continue }
    await new Promise((r) => setTimeout(r, 600))
    await page.evaluate(() => { const p = document.getElementById('podium'); if (p) p.hidden = true })
    const file = `.scratch/shots/boards/${map.replace(/\s+/g, '-')}.png`
    await page.screenshot({ path: file })
    seen.set(map, file)
    console.log(suffix, '->', file)
  }
  console.log(`${seen.size} distinct boards photographed of ${boards} in the rotation`)
} finally { await browser.close() }
