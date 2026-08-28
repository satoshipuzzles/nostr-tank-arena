// Bot difficulty, wired to a running lobby.
//
// test/botskill.mjs proves the *behaviour* — that a harder rung aims tighter,
// reacts sooner and never out-fires a player — against the module in Node. What
// it cannot see is the half that only exists in a browser: the lobby control,
// the remembered preference, and the pick actually reaching the one game that
// steps the bots. A level nobody can select, or one that is selected and then
// dropped on the floor between the button and `Game.botSkillIndex`, passes every
// Node check and ships a dead control. So this drives the real page.
//
//   npm run build && npx vite preview --port 4192 &
//   npm run test:botskill-browser

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

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
const URL = process.env.TANK_URL ?? 'http://localhost:4192/'

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS })
const pageErrors = []
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  page.on('pageerror', (e) => pageErrors.push(String(e.message ?? e)))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })

  // Built from BOT_SKILLS, so the picker cannot drift from the levels the game
  // has: one labelled button per rung, in order.
  const buttons = await page.evaluate(() =>
    [...document.querySelectorAll('#botskill button[data-value]')].map((b) => b.textContent))
  check('the lobby offers a rung per difficulty, easy to hard',
    buttons.join(',') === 'Recruit,Regular,Veteran,Elite', JSON.stringify(buttons))

  // Stored by id, not index — the note in main.ts is that re-ordering the table
  // one day must not silently repoint an old preference at the wrong rung.
  await page.click('#botskill button[data-value="3"]')
  const stored = await page.evaluate(() => localStorage.getItem('tank.botskill'))
  check('picking Elite is remembered by id', stored === 'elite', `tank.botskill=${stored}`)

  // The whole point: the pick reaches the game that steps the bots. `__game` is
  // player one's, the one that owns them.
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game, { timeout: 25_000 })
    .then(() => true).catch(() => false)
  check('a game starts from the lobby', started)
  check('and it is stepping the bots at the chosen rung',
    (await page.evaluate(() => window.__game.botSkillIndex)) === 3,
    `botSkillIndex=${await page.evaluate(() => window.__game.botSkillIndex)}`)

  // A solo room, so the bots are actually in — the rung has something to drive.
  const spawned = await (async () => {
    for (let i = 0; i < 200; i++) {
      if ((await page.evaluate(() => window.__game.botCount)) === 3) return true
      await wait(120)
    }
    return false
  })()
  check('three practice tanks are in with you to fight', spawned,
    `botCount=${await page.evaluate(() => window.__game.botCount)}`)

  // Live, like the count: bots publish nothing, so retuning them is nobody
  // else's business and takes no restart.
  await page.evaluate(() => document.querySelector('#botskill button[data-value="0"]').click())
  await wait(200)
  check('and dropping to Recruit mid-match reaches the game with no restart',
    (await page.evaluate(() => window.__game.botSkillIndex)) === 0,
    `botSkillIndex=${await page.evaluate(() => window.__game.botSkillIndex)}`)

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall good')
process.exit(failures.length ? 1 : 0)
