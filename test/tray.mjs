// Kill streaks you spend, rather than ones that happen to you.
//
// Puzz: "killstreaks should have to be triggered once obtained. you should have
// a icons showing your kill streaks and should be able to select them by
// clicking on them or something to activate."
//
// Four claims, and they fail in different ways — a build that got the first
// right and the second wrong would look completely finished:
//
//   1. Reaching a rung puts an icon on the HUD.
//   2. Reaching a rung **does not fire the reward**. This is the one that
//      matters and the one a screenshot cannot show, so it is checked against
//      the thing the reward actually does — no strike in the air, no chopper,
//      no hull repaired.
//   3. Clicking the icon fires it, and the icon goes.
//   4. What is held survives death and does not survive the round.
//
// Everything climbs through the real kill path — a peer publishes a death
// naming us as the killer, which is what `onDeath` -> `onOwnKill` reads.
// Handing `earn` a rung directly would test the tray given an answer; it could
// not test whether a kill ever produces one.
//
//   npm run build && npx vite preview --port 4340 &
//   npm run test:tray

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4340/'
const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!CHROME) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2) }

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
await page.setViewport({ width: 1280, height: 800 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

/** The tray, off the screen rather than off the model. */
const tray = () =>
  page.evaluate(() => {
    const n = document.getElementById('tray')
    return {
      hidden: !!n?.hidden,
      slots: [...(n?.querySelectorAll('.reward') ?? [])].map((b) => ({
        at: Number(b.dataset.at),
        name: b.querySelector('.reward-name')?.textContent ?? '',
        key: b.querySelector('.reward-key')?.textContent ?? '',
        disabled: b.disabled,
        icon: !!b.querySelector('svg'),
      })),
    }
  })

/** What the game says the reward *did*, which is the claim the tray hides. */
const world = () =>
  page.evaluate(() => {
    const g = window.__game
    return {
      hp: g.tank.hp,
      maxHp: g.maxHp,
      strikes: g.strikes.size,
      flying: !!g.flying,
      siege: g.buffs.siegeUntil > performance.now(),
      shield: g.buffs.shieldUntil > performance.now(),
      streak: g.streak,
      dead: !!g.tank.dead,
      respawnIn: Math.round(g.tank.respawnAt - performance.now()),
      earned: g.earned.slice(),
    }
  })

/** One kill, through the death path. */
const kill = () =>
  page.evaluate((PEER) => {
    const g = window.__game
    g.tank.dead = false
    g.onEvent({
      id: 'a' + Math.random().toString(16).slice(2),
      pubkey: PEER, kind: 21002, created_at: Math.floor(Date.now() / 1000), tags: [],
      sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), k: g.identity.sessionPubkey, x: 400, y: 400 }),
    }, false)
  }, PEER)

/** Climb to a rung for real: set the streak one short, then land a kill. */
async function earn(at) {
  await page.evaluate((n) => { window.__game.streak = n - 1 }, at)
  await kill()
  return until(async () => {
    const t = await tray()
    return t.slots.some((s) => s.at === at) ? t : null
  })
}

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'tray')
  await page.type('#room', 'tray' + Math.floor(Math.random() * 1e6))
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
    g.botsWanted = 0
    g.bots = []
    window.__arena.setLayout(window.__arena.layoutForBlock(hash))
    document.getElementById('podium').hidden = true
  }, HASH)
  await wait(900)

  // ------------------------------------------------------- 1. it starts empty

  const cold = await tray()
  check('the tray is not on screen before anything is earned', cold.hidden === true,
    JSON.stringify(cold))

  // ------------------------------- 2. earning does not fire — the whole point

  // Hurt on purpose. A repair that fires by itself is invisible on a full hull,
  // so without this the most important check in the file would pass against the
  // old behaviour.
  await page.evaluate(() => { window.__game.tank.hp = 1 })
  const before = await world()
  const three = await earn(3)
  const after = await world()
  check('reaching a rung puts an icon in the tray', !!three && three.slots.length === 1,
    JSON.stringify(three?.slots))
  check('the icon has a picture, a name and a number key on it',
    three?.slots[0]?.icon === true && /repair/.test(three.slots[0].name) && three.slots[0].key === '1',
    JSON.stringify(three?.slots[0]))
  check(
    'and the reward does NOT fire on its own — the hull is still the hull it was',
    after.hp === before.hp && before.hp === 1,
    `${before.hp} -> ${after.hp} of ${after.maxHp}`,
  )

  // The same claim for the one that reaches across the board, because a repair
  // and an air strike fail differently and only one of them is visible.
  const five = await earn(5)
  const afterFive = await world()
  check('a second rung stacks a second icon', five?.slots.length === 2,
    JSON.stringify(five?.slots.map((s) => s.at)))
  check(
    'and no strike is in the air until somebody asks for one',
    afterFive.strikes === 0,
    `${afterFive.strikes} strikes`,
  )

  // --------------------------------------------------- 3. clicking spends it

  await page.click('.reward[data-at="3"]')
  const spent = await until(async () => {
    const t = await tray()
    return t.slots.every((s) => s.at !== 3) ? t : null
  })
  const healed = await world()
  check('clicking an icon spends it and the icon goes', !!spent && spent.slots.length === 1,
    JSON.stringify(spent?.slots.map((s) => s.at)))
  check('and the reward actually happens', healed.hp === healed.maxHp,
    `${healed.hp} of ${healed.maxHp}`)
  check(
    'the numbers close up, so the key row stays 1..n',
    spent?.slots[0]?.key === '1' && spent.slots[0].at === 5,
    JSON.stringify(spent?.slots[0]),
  )

  // The keyboard is the other half of "select them by clicking or something".
  await page.keyboard.press('Digit1')
  const struck = await until(async () => {
    const w = await world()
    return w.strikes > 0 ? w : null
  })
  check('the number key spends the slot too', !!struck, `${struck?.strikes} strikes in the air`)
  const emptied = await tray()
  check('and the tray empties when the last one goes', emptied.hidden === true,
    JSON.stringify(emptied.slots))

  // -------------------------------------- 4. what happens to it when you die

  await earn(10)
  await page.evaluate(() => {
    const g = window.__game
    // The real death path, not a flag: `die` is what resets the streak, and
    // whether it also empties the tray is the design decision under test.
    g.die('someone')
    // This game respawns you almost instantly, which is a selling point and a
    // race for anything asking "what does the HUD look like while dead". Hold
    // the corpse still rather than hoping the read wins.
    g.tank.respawnAt = performance.now() + 60_000
  })
  // Poll for the repaint rather than waiting a fixed 400ms. The HUD redraws at
  // eight frames a second and this page runs at four under a software
  // rasteriser, so a fixed wait is one or two frames and a coin toss.
  const deadTray = (await until(async () => {
    const t = await tray()
    return t.slots.length && t.slots[0].disabled ? t : null
  }, 8000)) ?? (await tray())
  const dead = await world()
  check('dying resets the streak', dead.streak === 0, `streak ${dead.streak}`)
  check(
    'but what you already earned is still yours',
    dead.earned.includes(10) && deadTray.slots.some((s) => s.at === 10),
    JSON.stringify({ earned: dead.earned, slots: deadTray.slots.map((s) => s.at) }),
  )
  check(
    'and it is shown greyed rather than hidden, because a missing icon reads as lost',
    deadTray.hidden === false && deadTray.slots[0]?.disabled === true,
    JSON.stringify({ slot: deadTray.slots[0], dead: dead.dead, respawnIn: dead.respawnIn }),
  )
  // A reward spent from the respawn screen is one you cannot see land.
  const beforeDeadClick = (await world()).flying
  await page.evaluate(() => window.__game.spend(10))
  const afterDeadClick = await world()
  check(
    'spending while dead is refused rather than wasted',
    beforeDeadClick === false && afterDeadClick.flying === false && afterDeadClick.earned.includes(10),
    JSON.stringify(afterDeadClick.earned),
  )

  // ------------------------------------------------ 5. the round takes it back

  await page.evaluate(() => {
    window.__game.beginRound(900001, 'cd'.repeat(30) + '0400')
  })
  const cleared = await until(async () => {
    const t = await tray()
    return t.hidden ? t : null
  })
  check('a new block clears the tray', !!cleared, JSON.stringify((await world()).earned))

  // ----------------------------------------------------- 6. one of each, only

  await page.evaluate(() => {
    const g = window.__game
    g.tank.dead = false
    g.tank.respawnAt = 0
    g.streak = 0
    g.earned = []
  })
  await earn(3)
  await page.evaluate(() => { window.__game.streak = 2 })
  await kill()
  await wait(500)
  const twice = await tray()
  check(
    'earning a rung you are already holding does not stack a second copy',
    twice.slots.filter((s) => s.at === 3).length === 1,
    JSON.stringify(twice.slots.map((s) => s.at)),
  )

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))

  if (process.env.TANK_SHOT) {
    // Something in every slot, for the picture.
    await page.evaluate(() => {
      const g = window.__game
      g.tank.dead = false
      g.earned = [5, 10, 20]
    })
    await wait(400)
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
console.log('All streak-tray checks passed.')
