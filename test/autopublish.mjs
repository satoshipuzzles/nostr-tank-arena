// Scores that publish themselves when the block closes.
//
// Puzz's bug list: the block winner is decided only among players who published
// a score. The podium was never the problem — it reads the live roster and
// covers everybody in the room. The *leaderboard wall* is built from signed
// kind-30078 records, and a record only exists if somebody clicked a button, so
// most blocks were won by whoever remembered.
//
// Four claims, and each has a control, because every one of them is a thing
// that could pass by simply never publishing anything:
//
//   1. A round with a score in it publishes when the block closes.
//   2. A round nobody scored in does **not** — a 0/0 record on four relays
//      changes no leaderboard and adds a name to a block nobody played.
//   3. Turning it off means nothing goes out at all.
//   4. The record carries the round that just *ended*, not the one that just
//      started, and the streak it carries is that round's rather than zero.
//
// The fourth is the one this suite was written to catch, and it was already
// wrong on the manual button: `endRound` banks the round and then resets
// `bestStreak`, and `showPodium` runs afterwards — so every score this game has
// ever signed from the podium claimed a best streak of zero.
//
//   npm run build && npx vite preview --port 4201 &
//   npm run test:autopublish

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4201/'
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

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'pub')
  await page.type('#room', 'pub' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game && !!window.__renderer, { timeout: 25_000 })
    .then(() => true).catch(() => false)
  check('a game is running', started)
  if (!started) throw new Error('the game never started')

  // Intercept at the signing boundary rather than at the socket. What is being
  // tested is whether an event is produced and what is in it — a relay's answer
  // is `Net`'s problem and has its own suite.
  await page.evaluate(() => {
    const g = window.__game
    window.__signed = []
    const real = g.identity.signAsSelf.bind(g.identity)
    g.identity.signAsSelf = async (draft) => {
      const ev = await real(draft)
      window.__signed.push(ev)
      return ev
    }
  })

  const guest = await page.evaluate(() => window.__game.identity.isGuest)
  check('this session is a guest, which is the on-by-default case', guest === true)

  const label = () => page.evaluate(() => document.getElementById('autopublish-toggle').textContent)
  check('and the toggle says so', (await label()) === 'Auto-publish: on', await label())

  /**
   * Close a block, the way the clock does.
   *
   * Through `endRound` + `beginRound` on the real game and then the real
   * round-end hook, rather than by calling the publisher — the claim is that
   * the hook fires, and handing the publisher its arguments directly would test
   * an equation nobody calls.
   */
  const closeBlock = (height, hash) => page.evaluate(({ height, hash }) => {
    window.__signed = []
    // `__closeBlock` is the same body the clock's onBlock handler runs.
    window.__closeBlock(height, hash)
    return null
  }, { height, hash })

  const signedScores = () => page.evaluate(() =>
    window.__signed.filter((e) => e.kind === 30078).map((e) => ({
      tags: e.tags,
      content: JSON.parse(e.content),
    })))

  // ------------------------------------------------- 1. a round with a score

  await page.evaluate(() => {
    const g = window.__game
    g.kills = 4
    g.deaths = 1
    g.bestStreak = 3
  })
  await closeBlock(900001, 'ab'.repeat(30) + '0302')
  await wait(900)
  const first = await signedScores()
  check('a round with a score in it publishes when the block closes',
    first.length === 1, JSON.stringify(first.map((s) => s.content)))
  check(
    'and it carries that round, not the one that just started',
    first[0]?.content?.block === 900000 &&
      first[0]?.tags?.some((t) => t[0] === 'd' && t[1].includes('900000')),
    JSON.stringify({ block: first[0]?.content?.block, d: first[0]?.tags?.find((t) => t[0] === 'd') }),
  )
  check('and the tally it just banked',
    first[0]?.content?.kills === 4 && first[0]?.content?.deaths === 1,
    JSON.stringify(first[0]?.content))
  // The one this suite exists for. `endRound` resets `bestStreak` and anything
  // publishing afterwards reads a zero unless the value was banked.
  check('and that round\'s best streak rather than a reset zero',
    first[0]?.content?.streak === 3, JSON.stringify(first[0]?.content?.streak))

  // ------------------------------------------------ 2. a round nobody played

  await page.evaluate(() => {
    const g = window.__game
    g.kills = 0
    g.deaths = 0
    g.bestStreak = 0
  })
  await closeBlock(900002, 'ab'.repeat(30) + '0302')
  await wait(900)
  const empty = await signedScores()
  check('a round nobody scored in publishes nothing',
    empty.length === 0, JSON.stringify(empty.map((s) => s.content)))

  // ------------------------------------------------------- 3. and switched off

  await page.evaluate(() => {
    const g = window.__game
    g.kills = 7
    g.deaths = 2
    g.bestStreak = 5
  })
  // The control for the control: prove the same state DOES publish while on,
  // so "nothing went out" below is about the toggle rather than about the
  // scores being unpublishable for some other reason.
  await closeBlock(900003, 'ab'.repeat(30) + '0302')
  await wait(900)
  const onceMore = await signedScores()
  check('the control: the same tally publishes while the toggle is on',
    onceMore.length === 1 && onceMore[0]?.content?.kills === 7,
    JSON.stringify(onceMore.map((s) => s.content)))

  await page.evaluate(() => document.getElementById('autopublish-toggle').click())
  check('the toggle flips', (await label()) === 'Auto-publish: off', await label())
  await page.evaluate(() => {
    const g = window.__game
    g.kills = 9
    g.deaths = 1
    g.bestStreak = 6
  })
  await closeBlock(900004, 'ab'.repeat(30) + '0302')
  await wait(900)
  const off = await signedScores()
  check('and with it off, a scoring round publishes nothing',
    off.length === 0, JSON.stringify(off.map((s) => s.content)))

  // Remembered, or it is a setting that lasts until a reload.
  const remembered = await page.evaluate(() => localStorage.getItem('tank.autopublish'))
  check('and the choice is remembered', remembered === 'off', String(remembered))

  // ------------------------------------------------------ 4. the podium note

  await page.evaluate(() => document.getElementById('autopublish-toggle').click())
  await page.evaluate(() => {
    const g = window.__game
    g.kills = 2
    g.deaths = 0
    g.bestStreak = 2
  })
  await closeBlock(900005, 'ab'.repeat(30) + '0302')
  await wait(900)
  const podium = await page.evaluate(() => ({
    hidden: document.getElementById('podium').hidden,
    note: document.getElementById('podium-note').textContent,
    button: document.getElementById('podium-publish').textContent,
  }))
  check('the podium stops claiming nothing publishes itself',
    /automatically/i.test(podium.note ?? ''), JSON.stringify(podium.note))
  check('and the manual button is still there, relabelled',
    /again/i.test(podium.button ?? ''), JSON.stringify(podium.button))

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall good')
process.exit(failures.length ? 1 : 0)
