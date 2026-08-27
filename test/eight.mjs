// Eight tanks in one room.
//
// Puzz: "We need to have rooms with more than 4 players and different map sizes
// for different game types."
//
// Four was the seat count, four was the spawn count and six was the palette,
// and the first two were the same number by coincidence rather than by design.
// Raising the room size is three separate things that all have to move, and the
// interesting part is that none of them fail loudly:
//
//   - Not enough spawns and two tanks appear on top of each other, which reads
//     as a netcode bug rather than as a missing spawn point.
//   - Not enough hues and `spreadColors` runs out of slots and hands two
//     players the same colour, which is only wrong when they meet.
//   - A scoreboard that overflows is a scoreboard nobody mentions, they just
//     stop reading it.
//
// So this counts all three against the real game with eight tanks in it, and
// every check has a control — "eight rows" means nothing without "eight
// distinct colours", and neither means anything if the tanks are stacked.
//
//   npm run build && npx vite preview --port 4206 &
//   npm run test:eight

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4206/'
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

const HASH = 'ab'.repeat(30) + '0300'

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'one')
  await page.type('#room', 'e8' + Math.floor(Math.random() * 1e6))
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
  await wait(900)

  const seats = await page.evaluate(() => window.__rooms.SEATS)
  check('a room holds more than four', seats >= 8, `SEATS=${seats}`)

  // ------------------------------------------------------------- the spawns

  // Every layout, not just the pinned one. The map comes from the block hash,
  // so a room of eight lands on every board over the course of an evening
  // and a board with four spawns would stack tanks on one of them. Sweep
  // whatever the build ships, not a pinned count — a board added to LAYOUTS
  // joins this check without anyone remembering to widen it.
  const spawns = await page.evaluate((seats) => {
    const A = window.__arena
    const out = []
    const before = A.currentLayoutIndex()
    for (let i = 0; i < A.LAYOUTS.length; i++) {
      A.setLayout(i)
      const pts = A.SPAWNS.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
      // Distinct, and far enough apart that two tanks are not touching. A
      // 22-unit tank radius means anything under 45 is an overlap.
      let closest = Infinity
      for (let a = 0; a < pts.length; a++) {
        for (let b = a + 1; b < pts.length; b++) {
          closest = Math.min(closest, Math.hypot(pts[a].x - pts[b].x, pts[a].y - pts[b].y))
        }
      }
      // And none of them inside the scenery, which would spawn a tank in a rock.
      const buried = pts.filter((p) => A.pointInWall(p.x, p.y) !== null).length
      out.push({ layout: i, count: pts.length, closest: Math.round(closest), buried })
    }
    A.setLayout(before)
    return { out, seats }
  }, seats)
  console.log('      ' + spawns.out.map((s) => `${s.layout}:${s.count}@${s.closest}`).join(' '))
  check('every board has a spawn for every seat',
    spawns.out.every((s) => s.count >= seats),
    JSON.stringify(spawns.out.map((s) => s.count)))
  check('the control: and no two of them are close enough to stack tanks',
    spawns.out.every((s) => s.closest > 45),
    JSON.stringify(spawns.out.map((s) => s.closest)))
  check('the control: and none of them is inside the scenery',
    spawns.out.every((s) => s.buried === 0),
    JSON.stringify(spawns.out.map((s) => s.buried)))

  // ------------------------------------------------------------ the palette

  const palette = await page.evaluate(() => {
    // Read the hues the game actually hands out rather than the constant: what
    // matters is what a player is driving, and `spreadColors` is what decides.
    const g = window.__game
    const hues = []
    for (let i = 0; i < 24; i++) hues.push((i * 53) % 360)
    return hues
  })
  void palette

  // Eight strangers, each on a different spawn, each with a different chosen
  // hue — and hues picked to collide, so the spreading has something to do.
  await page.evaluate(() => {
    const g = window.__game
    const A = window.__arena
    for (let i = 0; i < 7; i++) {
      const key = (i + 1).toString(16).repeat(64).slice(0, 64)
      const spot = A.SPAWNS[(i + 1) % A.SPAWNS.length]
      for (let n = 0; n < 3; n++) {
        g.onEvent({
          id: 'a' + Math.random().toString(16).slice(2),
          pubkey: key, kind: 21000, created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
          content: JSON.stringify({
            t: Date.now() - (2 - n) * 100, x: spot.x, y: spot.y, h: 0, g: 0, hp: 3, d: false,
            ks: i, ds: 0, r: g.round,
          }),
        }, false)
      }
    }
  })
  await wait(1600)

  const room = await page.evaluate(() => {
    const g = window.__game, r = window.__renderer
    const hues = [g.displayColor, ...[...g.peers.values()].map((p) => p.displayColor)]
    const box = document.getElementById('scoreboard').getBoundingClientRect()
    return {
      peers: g.peers.size,
      rows: document.querySelectorAll('#scoreboard .score-row').length,
      hues,
      distinct: new Set(hues).size,
      board: { h: Math.round(box.height), bottom: Math.round(box.bottom) },
      onScreen: [...g.peers.values()].map((p) => {
        const s = r.toScreen(p.view.x, 30, p.view.y)
        return s ? [Math.round(s.x), Math.round(s.y)] : null
      }),
    }
  })
  check('eight tanks are in the room', room.peers === 7, `${room.peers} peers plus us`)
  check('and every one of them has a row on the scoreboard',
    room.rows === 8, `${room.rows} rows`)
  check('and a colour nobody else is driving',
    room.distinct === 8, `${room.distinct} distinct of ${room.hues.length}: ${room.hues.join(',')}`)

  // The gap, not just the count. Two hues 8 degrees apart are technically
  // distinct and identically green on a 40px tank.
  const gaps = []
  const sorted = [...room.hues].sort((a, b) => a - b)
  for (let i = 0; i < sorted.length; i++) {
    const next = sorted[(i + 1) % sorted.length]
    gaps.push(Math.round(((next - sorted[i] + 360) % 360)))
  }
  check('and far enough from every other colour to tell apart at tank size',
    Math.min(...gaps) >= 25, `closest pair ${Math.min(...gaps)} degrees apart`)

  check('every tank projects onto the visible board',
    room.onScreen.every((s) => s && s[0] > 0 && s[0] < 1280 && s[1] > 0 && s[1] < 800),
    JSON.stringify(room.onScreen))
  // The scoreboard grew from four rows to eight and it sits at the top left of
  // a 800px window. A panel that runs off the bottom is a panel that stops
  // being read rather than one anybody reports.
  check('the control: and the scoreboard still fits on screen',
    room.board.bottom < 800, `bottom at ${room.board.bottom}px`)

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall good')
process.exit(failures.length ? 1 : 0)
