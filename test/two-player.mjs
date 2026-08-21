// Two real browsers, two guest npubs, one room, live public relays.
//
// There is no way to fake this one: it drives the actual built game, waits for
// the two clients to find each other through relays, shoots one tank with the
// other, and asserts that the kill came back through the death event. Run it
// against a preview build:
//
//   npm run build && npm run preview &
//   npm run test:live
//
// Set TANK_URL to point somewhere else, e.g. the deployed site.

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL = process.env.TANK_URL ?? 'http://localhost:4173/'
const ROOM = 'smoke' + Math.floor(Math.random() * 1e6)

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
  '--use-gl=swiftshader',
  // Chrome only gives requestAnimationFrame to the frontmost tab. Without
  // these the "other player" silently stops simulating and the test proves
  // nothing at all.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

// Separate browsers, not separate tabs: independent localStorage and renderers.
const browsers = [
  await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS }),
  await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS }),
]

const pageErrors = []

async function join(browser, label, name) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  page.on('pageerror', (e) => pageErrors.push(`[${label}] ${e.message}`))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'networkidle0' })
  await page.evaluate(() => {
    document.querySelector('#name').value = ''
    document.querySelector('#room').value = ''
  })
  await page.type('#name', name)
  await page.type('#room', ROOM)
  await page.click('#play-guest')
  await page.waitForSelector('#hud:not([hidden])', { timeout: 15000 })
  return page
}

const snap = (p) =>
  p.evaluate(() => {
    const g = window.__game
    return {
      hp: g.tank.hp,
      dead: g.tank.dead,
      kills: g.kills,
      deaths: g.deaths,
      shells: g.shells.size,
      feed: g.feed.map((f) => f.text),
      peers: [...g.peers.values()].map((pe) => ({
        name: pe.name,
        verified: pe.pubkey !== null,
        x: Math.round(pe.view.x),
        y: Math.round(pe.view.y),
      })),
    }
  })

try {
  console.log(`room ${ROOM} @ ${URL}`)
  const a = await join(browsers[0], 'A', 'alpha')
  const b = await join(browsers[1], 'B', 'bravo')

  // Discovery: each side has to learn the other exists, and verify the session
  // attestation that binds the tick key to a real npub.
  await wait(6000)
  const seenA = await snap(a)
  const seenB = await snap(b)
  check('A sees bravo', seenA.peers.some((p) => p.name === 'bravo'), JSON.stringify(seenA.peers))
  check('B sees alpha', seenB.peers.some((p) => p.name === 'alpha'), JSON.stringify(seenB.peers))
  check('sessions verified', seenA.peers.every((p) => p.verified) && seenB.peers.every((p) => p.verified))
  check('no ghost peers', seenA.peers.length === 1 && seenB.peers.length === 1)

  // Movement propagates.
  const beforeMove = (await snap(b)).peers[0]
  await a.keyboard.down('KeyW')
  await wait(1600)
  await a.keyboard.up('KeyW')
  await wait(1200)
  const afterMove = (await snap(b)).peers[0]
  const moved = beforeMove && afterMove ? Math.hypot(afterMove.x - beforeMove.x, afterMove.y - beforeMove.y) : 0
  check('B sees A move', moved > 60, `${Math.round(moved)}px`)

  // Duel: park them in a clear lane and put three shells into bravo.
  for (let i = 0; i < 5; i++) {
    await a.evaluate(() => {
      const g = window.__game
      g.tank.x = 300
      g.tank.y = 600
      g.tank.hull = 0
      g.tank.gun = 0
      g.tank.reloadAt = 0
    })
    await b.evaluate(() => {
      const g = window.__game
      if (!g.tank.dead) {
        g.tank.x = 520
        g.tank.y = 600
      }
    })
    await a.keyboard.down('Space')
    await wait(140)
    await a.keyboard.up('Space')
    await wait(1400)
    if ((await snap(b)).deaths > 0) break
  }
  await wait(2000)

  const finalA = await snap(a)
  const finalB = await snap(b)
  check('bravo died', finalB.deaths >= 1, JSON.stringify(finalB.feed))
  check('alpha credited with the kill', finalA.kills >= 1, JSON.stringify(finalA.feed))
  check('kill feed names the killer', finalA.feed.some((t) => t.includes('alpha') && t.includes('bravo')))
  check('bravo respawned at full hp', !finalB.dead && finalB.hp === 3, `hp=${finalB.hp} dead=${finalB.dead}`)
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '))

  if (process.env.TANK_SHOTS) {
    await a.screenshot({ path: process.env.TANK_SHOTS + '/alpha.png' })
    await b.screenshot({ path: process.env.TANK_SHOTS + '/bravo.png' })
  }
} finally {
  for (const br of browsers) await br.close()
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nall checks passed')
process.exit(failures.length ? 1 : 0)
