// Calling cards: the badge on the screen of whoever you just killed.
//
// Puzz asked for "calling cards" and "player cards and stats". The issue that
// filed it demanded one decision be made explicitly rather than fudged: either
// unlocks are checkable by other clients, or they are decoration anybody can
// claim — pick one and write it down. The answer this suite holds to the fire:
//
//   **Every condition is arithmetic over the player's own signed score events.**
//
// So the checks below are mostly about that. Not "is there a picker" but: does
// the grid show what you have *not* earned, does a locked card refuse the
// click, does a card fall off when the history no longer supports it, and does
// the badge reach the other player's death screen.
//
//   npm run build && npx vite preview --port 4351 &
//   npm run test:cards

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4351/'
const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!CHROME) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2) }

const FLAGS = [
  '--no-sandbox', '--window-size=1280,900', '--use-gl=angle', '--use-angle=swiftshader',
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
async function until(fn, ms = 12_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await wait(80)
  }
  return null
}

const PEER = 'd1'.repeat(32)
const HASH = 'ab'.repeat(30) + '0300'

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

/** The picker as rendered. */
const grid = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('#card-grid button[data-card]')].map((b) => ({
      id: b.dataset.card,
      locked: b.classList.contains('locked'),
      disabled: b.disabled,
      on: b.getAttribute('aria-pressed') === 'true',
      rule: b.querySelector('.card-rule')?.textContent ?? '',
      art: !!b.querySelector('svg'),
      w: Math.round(b.getBoundingClientRect().width),
    })),
  )

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  // ------------------------------------------- 1. the grid, before any history

  const cold = await until(async () => {
    const g = await grid()
    return g.length ? g : null
  })
  check('the garage has a card for every card in the table', (cold?.length ?? 0) === 10, `${cold?.length}`)
  check('each one is drawn, not just named', cold?.every((c) => c.art), JSON.stringify(cold?.filter((c) => !c.art)))
  check(
    'and they are real buttons on the glass rather than a collapsed grid',
    cold?.every((c) => c.w > 60),
    JSON.stringify(cold?.map((c) => c.w)),
  )
  const free = cold?.filter((c) => !c.locked) ?? []
  const locked = cold?.filter((c) => c.locked) ?? []
  check(
    'a player with no published history gets the free ones and no more',
    free.length === 3 && locked.length === 7,
    `${free.length} free, ${locked.length} locked`,
  )
  check(
    'the locked ones show what it takes rather than hiding',
    locked.every((c) => c.rule.length > 3 && !/earned/.test(c.rule)),
    JSON.stringify(locked.map((c) => c.rule)),
  )
  check('exactly one is worn', (cold?.filter((c) => c.on).length ?? 0) === 1, JSON.stringify(cold?.filter((c) => c.on)))

  // ---------------------------------------- 2. a locked card cannot be claimed

  const beforeClick = await page.evaluate(() => document.querySelector('#card-grid [aria-pressed="true"]')?.dataset.card)
  await page.evaluate(() => {
    const b = document.querySelector('#card-grid button.locked')
    // A real click, not the handler: `disabled` is the first line of defence
    // and the guard behind it is the second, and this has to exercise both.
    b?.click()
  })
  await wait(300)
  const afterClick = await page.evaluate(() => document.querySelector('#card-grid [aria-pressed="true"]')?.dataset.card)
  check(
    'clicking a locked card does nothing at all',
    beforeClick === afterClick,
    `${beforeClick} -> ${afterClick}`,
  )

  // A free one does work, and it sticks.
  await page.evaluate(() => document.querySelector('#card-grid button[data-card="scrapper"]')?.click())
  const picked = await until(async () => {
    const g = await grid()
    return g.find((c) => c.id === 'scrapper')?.on ? g : null
  }, 4000)
  check('picking a free card takes', !!picked)
  const storedPick = await page.evaluate(() => localStorage.getItem('tank.card'))
  check('and it is remembered for next time', storedPick === '"scrapper"' || storedPick === 'scrapper', String(storedPick))

  // ------------------------------------- 3. history unlocks, and it comes back out

  const withHistory = await page.evaluate(async () => {
    // The unlock rule, exercised through the same pure function the picker and
    // any outside checker would use. Not a poke at the DOM: the point of the
    // design is that this is arithmetic over published events, so the check is
    // the arithmetic.
    const api = window.__cards
    if (!api) return { why: 'no card api' }
    const none = [...api.unlocked(api.noCareer())]
    const veteran = [...api.unlocked({ rounds: 4, kills: 60, deaths: 20, bestStreak: 4, blocksWon: 0 })]
    const streaky = [...api.unlocked({ rounds: 4, kills: 10, deaths: 20, bestStreak: 26, blocksWon: 0 })]
    const champ = [...api.unlocked({ rounds: 40, kills: 300, deaths: 90, bestStreak: 12, blocksWon: 6 })]
    return { none, veteran, streaky, champ }
  })
  check(
    'fifty career kills earns Veteran and nothing above it',
    withHistory.veteran?.includes('veteran') && !withHistory.veteran?.includes('centurion'),
    JSON.stringify(withHistory.veteran),
  )
  check(
    'a twenty-five streak earns Apex, and Unbroken under it',
    withHistory.streaky?.includes('apex') && withHistory.streaky?.includes('unbroken'),
    JSON.stringify(withHistory.streaky),
  )
  check(
    'five blocks won earns Champion and Blockrunner',
    withHistory.champ?.includes('champion') && withHistory.champ?.includes('blockrunner'),
    JSON.stringify(withHistory.champ),
  )
  // The control that makes the three above mean something: an empty history
  // earns exactly the free set, so the rules are gates rather than decoration.
  check(
    'and an empty history earns only the free three',
    withHistory.none?.length === 3,
    JSON.stringify(withHistory.none),
  )

  // -------------------------------- 4. the badge reaches the other player's screen

  await page.type('#name', 'cards')
  await page.type('#room', 'cards' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game, { timeout: 25_000 })
    .then(() => true).catch(() => false)
  check('a game is running', started)
  if (!started) throw new Error('the game never started')

  await page.evaluate((hash) => {
    window.__clock.accept({ height: 900000, hash, time: Math.floor(Date.now() / 1000) - 30 })
    window.__clock.accept = () => {}
    const g = window.__game
    g.beginRound(900000, hash)
    g.beginRound = () => {}
    g.botsWanted = 0
    g.bots = []
    document.getElementById('podium').hidden = true
  }, HASH)
  await wait(800)

  const worn = await page.evaluate(() => window.__game.card)
  check('the card you picked is the one the game carries', worn === 'scrapper', String(worn))

  // A peer with a card of their own kills us, and their badge is on the card.
  const killed = await page.evaluate((PEER) => {
    const g = window.__game
    const peer = g.ensurePeer(PEER)
    peer.name = 'Hardhat'
    peer.card = 'champion'
    g.tank.dead = false
    g.tank.hp = 1
    g.die(PEER)
    g.tank.respawnAt = performance.now() + 60_000
    return g.lastDeath?.card ?? null
  }, PEER)
  check('the killer\'s card is captured with the death', killed === 'champion', String(killed))
  const badge = await until(async () =>
    page.evaluate(() => {
      const n = document.querySelector('#death .death-card-slot')
      if (!n) return null
      const box = n.getBoundingClientRect()
      return { text: n.textContent.trim(), art: !!n.querySelector('svg'), w: Math.round(box.width) }
    }))
  check(
    'and it is on their death screen, drawn and named',
    !!badge && /Champion/.test(badge.text) && badge.art && badge.w > 40,
    JSON.stringify(badge),
  )

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))

  if (process.env.TANK_SHOT) {
    await page.screenshot({ path: process.env.TANK_SHOT })
    console.log(`      wrote ${process.env.TANK_SHOT}`)
  }
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
console.log('All calling-card checks passed.')
