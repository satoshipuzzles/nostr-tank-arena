// Team deathmatch: a score you can see, and one that agrees with the other
// player's screen.
//
// Puzz: *"team death match isnt really working."*
//
// Two things were wrong and the first one is the reason the mode felt broken
// rather than merely quiet:
//
//   1. **The standings disagreed between clients.** Bots are local — each
//      client spawns its own and puts them on sides relative to itself — and
//      they were counted in the team tally. Measured with two real clients in
//      one room at the same moment: one screen showed Red 2 / Blue 2, the other
//      showed Red 1 / Blue 2 / *Green 1*. A phantom side made of somebody
//      else's practice tank.
//   2. **There was no score on screen.** The flag race has a strip and
//      domination has one; the mode whose whole content is which side is ahead
//      kept its tally inside a panel you open between rounds.
//
// So this checks the tally counts people, that a side made only of bots is not
// a side, that the strip is on the glass with real width, that the lead is
// called out when it changes and only then, and that it stays out of the way of
// the modes that have their own score.
//
//   npm run build && npx vite preview --port 4350 &
//   npm run test:tdm

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4350/'
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

const HASH = 'ab'.repeat(30) + '0300'
const FOE = 'd1'.repeat(32)
const MATE = 'd2'.repeat(32)

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

/** The strip as rendered, not as modelled. */
const strip = () =>
  page.evaluate(() => {
    const n = document.getElementById('tdm')
    if (!n) return { missing: true }
    const box = n.getBoundingClientRect()
    return {
      hidden: !!n.hidden,
      display: getComputedStyle(n).display,
      text: (n.textContent ?? '').replace(/\s+/g, ' ').trim(),
      sides: [...n.querySelectorAll('.tdm-side')].map((e) => ({
        text: e.textContent.replace(/\s+/g, ' ').trim(),
        ours: e.classList.contains('ours'),
        ahead: e.classList.contains('ahead'),
      })),
      w: Math.round(box.width),
      h: Math.round(box.height),
    }
  })

/** A peer on a side, with a score they claim themselves. */
const peer = (session, team, kills, deaths, bot = false) =>
  page.evaluate(
    ({ session, team, kills, deaths, bot }) => {
      const g = window.__game
      const p = g.ensurePeer(session)
      p.name = bot ? 'Rust' : 'Foe'
      p.bot = bot
      p.view.team = team
      p.claimed = { kills, deaths }
      p.lastSeen = performance.now()
      return true
    },
    { session, team, kills, deaths, bot },
  )

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'tdm')
  await page.type('#room', 'tdm' + Math.floor(Math.random() * 1e6))
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
    g.peers.clear()
    g.team = 0
    g.flagsOn = false
    g.pointsOn = false
    document.getElementById('podium').hidden = true
  }, HASH)
  await wait(900)

  // ------------------------------------------------- 1. a free-for-all has none

  const ffa = await until(async () => {
    const s = await strip()
    return s.hidden === true ? s : null
  })
  check('a free-for-all has no team score, because there are no teams', !!ffa, JSON.stringify(ffa))

  // ------------------------------- 2. a side made only of practice tanks is not a side

  await page.evaluate(() => { window.__game.team = 1 })
  await peer('b0' + '1'.repeat(54) + '0'.repeat(8), 2, 0, 0, true)
  const botOnly = await until(async () => {
    const s = await strip()
    return s.hidden === true ? s : null
  }, 4000)
  check(
    'one player and a bot on the other side is still a free-for-all',
    !!botOnly,
    JSON.stringify(await strip()),
  )

  // ------------------------------------------------- 3. two people make a match

  await peer(FOE, 2, 3, 1)
  const two = await until(async () => {
    const s = await strip()
    return s.hidden === false ? s : null
  })
  check('two sides with people on them put the score on the glass', !!two, JSON.stringify(two))
  check(
    'both sides are named with their score',
    (two?.sides.length ?? 0) === 2 && /Blue 3/.test(two?.text ?? ''),
    JSON.stringify(two?.text),
  )
  check('your own side is marked as yours', two?.sides.some((s) => s.ours), JSON.stringify(two?.sides))
  check(
    'and the side that is ahead is the one marked ahead',
    two?.sides.find((s) => s.ahead)?.text.includes('Blue'),
    JSON.stringify(two?.sides),
  )
  check(
    'the strip is on the glass rather than a sliver',
    (two?.w ?? 0) > 90 && (two?.h ?? 0) > 16,
    JSON.stringify({ w: two?.w, h: two?.h }),
  )
  check(
    'and it says what the bots are, since they are on the board and not in the score',
    /practice tank/.test(two?.text ?? ''),
    JSON.stringify(two?.text),
  )

  // The tally itself: people only, and the bot counted separately.
  const tally = await page.evaluate(() => window.__game.teamStandings())
  check(
    'the tally counts people, and counts the practice tanks apart from them',
    tally?.length === 2 &&
      tally.every((t) => t.players === 1) &&
      tally.reduce((n, t) => n + t.bots, 0) === 1,
    JSON.stringify(tally),
  )

  // ----------------------------------------------------- 4. the lead is called

  const feedHas = (re) =>
    page.evaluate((src) => {
      const rx = new RegExp(src)
      return [...document.querySelectorAll('#feed div')].some((d) => rx.test(d.textContent ?? ''))
    }, re.source)

  await page.evaluate(() => { window.__game.kills = 5 })
  const led = await until(async () => ((await feedHas(/your side leads 5-3/)) ? true : null), 6000)
  check('taking the lead is said out loud, once', !!led)
  // And not repeated every frame while the lead holds — the feed keeps six
  // lines, so a per-frame announcement would be the only thing in it.
  await wait(700)
  // *This* line, not any line containing "leads". Blue legitimately took the
  // lead when it arrived with three kills, so counting the word matched two
  // different announcements and read as a repeat — the check has to name the
  // event it is about.
  const lines = await page.evaluate(() =>
    [...document.querySelectorAll('#feed div')]
      .filter((d) => /your side leads 5-3/.test(d.textContent ?? '')).length)
  check('and not once a frame while it holds', lines === 1, `${lines} lines`)

  // The other direction: it is a *change* that is announced, not a state.
  await page.evaluate(() => {
    const g = window.__game
    const foe = [...g.peers.values()].find((p) => !p.bot)
    foe.claimed = { kills: 9, deaths: 1 }
  })
  const flipped = await until(async () => ((await feedHas(/Blue leads 9-5/)) ? true : null), 6000)
  check('and the lead changing hands is announced too', !!flipped)

  // ------------------------------------- 5. it keeps out of the other modes' way

  await page.evaluate(() => { window.__game.flagsOn = true })
  const inCtf = await until(async () => {
    const s = await strip()
    return s.hidden === true ? s : null
  }, 5000)
  check(
    'a flag round has its own score, so this one stands down',
    !!inCtf,
    JSON.stringify(await strip()),
  )
  await page.evaluate(() => { const g = window.__game; g.flagsOn = false; g.pointsOn = true })
  const inDom = await until(async () => {
    const s = await strip()
    return s.hidden === true ? s : null
  }, 5000)
  check('and so does a domination round', !!inDom, JSON.stringify(await strip()))

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))

  if (process.env.TANK_SHOT) {
    await page.evaluate(() => {
      const g = window.__game
      g.pointsOn = false
      g.kills = 7
      const foe = [...g.peers.values()].find((p) => !p.bot)
      foe.claimed = { kills: 5, deaths: 4 }
    })
    await wait(700)
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
console.log('All team-deathmatch checks passed.')
