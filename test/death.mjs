// The death card: who killed you, and what they were on when they did.
//
// Puzz: *"When a player dies, show a replay recording from the view of the
// player who killed you. It should display the killer's profile picture and
// calling card."*
//
// This is the card half. What has to be true:
//
//   1. It appears when you die and it is *gone* when you respawn. A card that
//      outlives the respawn is a screen you have to dismiss mid-firefight, and
//      it is the failure this repo has shipped twice — a `[hidden]` element
//      with a `display` rule that beats the UA stylesheet.
//   2. It names the killer, wears their colour and shows their picture.
//   3. It is captured at the moment of death, not read live: the killer keeps
//      playing, and a card whose numbers moved while you read it would be
//      describing a different moment than the one it is about.
//   4. Self-destructs and practice tanks read honestly rather than being
//      squeezed into the same sentence as a player kill.
//
// Checked on the rendered card — text, computed style and box — rather than on
// `game.lastDeath`, because a card built correctly and styled into a 1px sliver
// passes every model-level check there is.
//
//   npm run build && npx vite preview --port 4346 &
//   npm run test:death

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4346/'
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

/** The card as it is rendered, not as it is modelled. */
const card = () =>
  page.evaluate(() => {
    const n = document.getElementById('death')
    if (!n) return { missing: true }
    const cs = getComputedStyle(n)
    const box = n.getBoundingClientRect()
    return {
      hidden: !!n.hidden,
      display: cs.display,
      text: (n.textContent ?? '').replace(/\s+/g, ' ').trim(),
      hue: n.style.getPropertyValue('--killer').trim(),
      borderColor: cs.borderTopColor,
      w: Math.round(box.width),
      h: Math.round(box.height),
      avatars: n.querySelectorAll('.avatar').length,
      slot: n.querySelectorAll('.death-card-slot').length,
    }
  })

/** Die to a peer, through the real damage path rather than by setting a flag. */
const killedBy = (streak, kills) =>
  page.evaluate(
    ({ PEER, streak, kills }) => {
      const g = window.__game
      const peer = g.ensurePeer(PEER)
      peer.name = 'Hardhat'
      peer.streak = streak
      peer.claimed = { kills, deaths: 2 }
      g.tank.dead = false
      g.tank.hp = 1
      g.watching = false
      // `die` is what the real damage paths call once hull reaches zero.
      g.die(PEER)
      return { at: g.lastDeath?.at ?? 0, name: g.lastDeath?.name ?? '' }
    },
    { PEER, streak, kills },
  )

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'death')
  await page.type('#room', 'death' + Math.floor(Math.random() * 1e6))
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
  await wait(900)

  // -------------------------------------------------- 1. nothing before a death

  const cold = await card()
  check('there is no card before anybody has died', cold.hidden === true, JSON.stringify(cold))

  // ------------------------------------------------- 2. it names who did it

  await killedBy(7, 9)
  // Hold the corpse still: the respawn is 2.5s and the HUD paints at 8fps, so
  // a fixed wait here is a race with the thing being measured.
  await page.evaluate(() => { window.__game.tank.respawnAt = performance.now() + 60_000 })
  const up = await until(async () => {
    const c = await card()
    return c.hidden === false ? c : null
  })
  check('dying puts a card on the screen', !!up, JSON.stringify(up))
  check('it names the killer', /Hardhat/.test(up?.text ?? ''), JSON.stringify(up?.text))
  check(
    'and says what they were on — a streak is the fact worth having',
    /on a 7 streak/.test(up?.text ?? ''),
    JSON.stringify(up?.text),
  )
  check('it shows their picture, or the fallback for it', (up?.avatars ?? 0) === 1, JSON.stringify(up))
  check('the calling card slot is there for when that lands', (up?.slot ?? 0) === 1)
  check(
    "it wears the killer's own colour rather than a generic one",
    !!up?.hue && up.borderColor !== 'rgba(0, 0, 0, 0)',
    JSON.stringify({ hue: up?.hue, border: up?.borderColor }),
  )
  // A card can be perfectly built and styled into nothing. Measure the box.
  check(
    'and it is a card on the glass, not a sliver',
    (up?.w ?? 0) > 200 && (up?.h ?? 0) > 90,
    JSON.stringify({ w: up?.w, h: up?.h }),
  )
  check('the respawn clock counts', /back in/.test(up?.text ?? ''), JSON.stringify(up?.text))

  // ------------------------------------- 3. it describes the moment it is about

  const frozen = await page.evaluate((PEER) => {
    const g = window.__game
    // The killer plays on. The card must not follow them.
    const peer = g.ensurePeer(PEER)
    peer.streak = 21
    peer.claimed = { kills: 30, deaths: 2 }
    return g.lastDeath?.streak ?? -1
  }, PEER)
  await wait(500)
  const still = await card()
  check(
    'the card is the moment you died, not a live feed of the killer',
    frozen === 7 && /on a 7 streak/.test(still.text) && !/21/.test(still.text),
    JSON.stringify({ frozen, text: still.text }),
  )

  // ------------------------------------------------------ 4. it goes away again

  await page.evaluate(() => {
    const g = window.__game
    g.tank.respawnAt = performance.now() - 1
  })
  const gone = await until(async () => {
    const c = await card()
    return c.hidden === true ? c : null
  })
  check('respawning takes the card away', !!gone, JSON.stringify(gone))
  // The trap this repo has shipped twice: an author `display` rule beats the UA
  // stylesheet's `[hidden] { display: none }`, so the element stays on screen
  // with its attribute set. Assert the *computed* style, never the attribute.
  check(
    'and it is really gone — computed display, not the hidden attribute',
    gone?.display === 'none',
    JSON.stringify({ hidden: gone?.hidden, display: gone?.display }),
  )

  // -------------------------------------------- 5. the two honest special cases

  const selfCard = await until(async () => {
    await page.evaluate(() => {
      const g = window.__game
      g.tank.dead = false
      g.tank.hp = 1
      g.die(null)
      g.tank.respawnAt = performance.now() + 60_000
    })
    const c = await card()
    return c.hidden === false ? c : null
  })
  check(
    'blowing yourself up says so, and credits nobody',
    /YOU BLEW YOURSELF UP/.test(selfCard?.text ?? '') && (selfCard?.avatars ?? 0) === 0,
    JSON.stringify(selfCard?.text),
  )

  const botCard = await until(async () => {
    await page.evaluate(() => {
      const g = window.__game
      g.botsWanted = 3
      g.tank.dead = false
      g.tank.hp = 1
      const bot = g.bots[0]
      if (!bot) return
      g.die(bot.session)
      g.tank.respawnAt = performance.now() + 60_000
    })
    const c = await card()
    return c.hidden === false && /practice tank/.test(c.text) ? c : null
  }, 15_000)
  check(
    'and a practice tank says it costs you nothing, because the board will not move',
    !!botCard,
    JSON.stringify(botCard?.text),
  )

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))

  if (process.env.TANK_SHOT) {
    await page.evaluate((PEER) => {
      const g = window.__game
      const peer = g.ensurePeer(PEER)
      peer.name = 'Hardhat'
      peer.streak = 11
      peer.claimed = { kills: 14, deaths: 3 }
      g.tank.dead = false
      g.tank.hp = 1
      g.die(PEER)
      g.tank.respawnAt = performance.now() + 60_000
    }, PEER)
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
console.log('All death-card checks passed.')
