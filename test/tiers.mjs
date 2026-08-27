// Five rewards per tier, and the rungs they build.
//
// Puzz: "Some kill streaks should only be available at each streak level, we
// should have 5 to choose from for each tier. The killstreaks should be more
// powerful and cooler the higher the kill streak."
//
// What this file has to prove, and the order matters because the later claims
// are worthless if the earlier ones are wrong:
//
//   1. The pools exist and partition the rewards — five per tier, no reward in
//      two tiers, and the lobby paints the pool rather than one shared menu.
//   2. A loadout that crosses tiers is refused, so a stored one written by the
//      previous build cannot put an air strike on the apex rung.
//   3. Picking a reward moves the *rung*, checked by what the reward does and
//      never by the label the picker shows.
//   4. The three genuinely new mechanics work, and — this is the half that is
//      easy to skip — stop working when they are supposed to. A bulwark that
//      re-armed after it expired would pass every "does it come back" check.
//
// Everything climbs through the real kill path: a peer publishes a death
// naming us, which is what `onDeath` -> `onOwnKill` reads. Handing `earn` a
// rung directly tests the tray given an answer; it cannot test whether a kill
// ever produces one.
//
//   npm run build && npx vite preview --port 4340 &
//   npm run test:tiers

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
// A pinned tip. Anything derived from the live chain — the map, the hull, the
// pickup wave — makes this suite a coin flip: Glass Cannon gives a tank one
// hull point, and half the checks below are about hull points.
const HASH = 'ab'.repeat(30) + '0300'

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

/** The picker as the player sees it: rows of buttons, not the table behind them. */
const picker = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('#loadout-rows .loadout-row')].map((row) => ({
      tier: row.querySelector('.loadout-tier')?.textContent ?? '',
      hue: row.style.getPropertyValue('--tier').trim(),
      rewards: [...row.querySelectorAll('button[data-reward]')].map((b) => ({
        id: b.dataset.reward,
        name: b.querySelector('span')?.textContent ?? '',
        icon: !!b.querySelector('svg'),
        on: b.getAttribute('aria-pressed') === 'true',
        box: b.getBoundingClientRect().width,
      })),
    })),
  )

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

/** Climb to a rung for real, then spend what it banked. */
async function earnAndSpend(at) {
  await page.evaluate((n) => { window.__game.streak = n - 1 }, at)
  await kill()
  const held = await until(() => page.evaluate((n) => window.__game.holding(n), at), 6000)
  if (!held) return false
  return page.evaluate((n) => window.__game.spend(n), at)
}

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  // ------------------------------------------- 1. the pools, and the picker
  //
  // Read off the screen before the game starts, because the picker is a lobby
  // control and the whole issue is about what a player can choose *before*
  // they play.

  const rows = await picker()
  check('the picker has one row per tier', rows.length === 4, JSON.stringify(rows.map((r) => r.tier)))
  // Five is the floor Puzz asked for, not a cap: the apex pool grew to six
  // when the nuke landed, and a check written as `=== 5` would have made the
  // next reward a test failure rather than a reward.
  check(
    'and every tier offers at least five',
    rows.every((r) => r.rewards.length >= 5),
    JSON.stringify(rows.map((r) => r.rewards.length)),
  )
  check(
    'the tiers are the streak levels, named and coloured',
    rows.map((r) => r.tier).join('|') === '5Skirmish|10Power|15Heavy|25Apex' &&
      new Set(rows.map((r) => r.hue)).size === 4,
    JSON.stringify(rows.map((r) => [r.tier, r.hue])),
  )
  check(
    'every reward card has a picture on it, not just a word',
    rows.every((r) => r.rewards.every((x) => x.icon)),
    JSON.stringify(rows.flatMap((r) => r.rewards.filter((x) => !x.icon).map((x) => x.id))),
  )
  // The cards are laid out, not stacked into a 1px column by a stylesheet that
  // matched nothing. A DOM test cannot see CSS; a box measurement can.
  check(
    'and the cards have real width on the glass',
    rows.every((r) => r.rewards.every((x) => x.box > 40)),
    JSON.stringify(rows[0]?.rewards.map((x) => Math.round(x.box))),
  )
  const ids = rows.flatMap((r) => r.rewards.map((x) => x.id))
  check(
    'no reward appears in two tiers — the pools partition the rewards',
    new Set(ids).size === ids.length && ids.length >= 20,
    `${ids.length} cards, ${new Set(ids).size} distinct`,
  )
  check(
    'exactly one card per row is chosen',
    rows.every((r) => r.rewards.filter((x) => x.on).length === 1),
    JSON.stringify(rows.map((r) => r.rewards.filter((x) => x.on).map((x) => x.id))),
  )

  // Clicking a card moves the choice, and only within its own row.
  await page.click('#loadout-rows .loadout-row:nth-child(4) button[data-reward="armageddon"]')
  const picked = await picker()
  check(
    'clicking a card in a tier changes that tier and leaves the others alone',
    picked[3].rewards.find((x) => x.on)?.id === 'armageddon' &&
      picked.slice(0, 3).every((r, i) => r.rewards.find((x) => x.on)?.id === rows[i].rewards.find((x) => x.on)?.id),
    JSON.stringify(picked.map((r) => r.rewards.find((x) => x.on)?.id)),
  )

  // --------------------------------------------- 2. a cross-tier loadout is refused

  const parsed = await page.evaluate(() => {
    const g = window.__loadout
    return {
      // The default, round-tripped: the only shape that should survive.
      good: g.parseLoadout(['strike', 'chopper', 'jugger', 'carpet']),
      // Every id here is real, distinct and known — and every one of them is
      // in the wrong tier. The old check passed this, which is the bug.
      crossed: g.parseLoadout(['carpet', 'strike', 'emp', 'recon']),
      // What the previous build wrote to local storage.
      stale: g.parseLoadout(['strike', 'recon', 'chopper', 'emp']),
      short: g.parseLoadout(['strike', 'chopper', 'jugger']),
    }
  })
  check(
    'a loadout with one reward per tier is accepted',
    Array.isArray(parsed.good) && parsed.good.join(',') === 'strike,chopper,jugger,carpet',
    JSON.stringify(parsed.good),
  )
  check(
    'a loadout of real rewards in the wrong tiers is refused',
    parsed.crossed === null,
    JSON.stringify(parsed.crossed),
  )
  check(
    "and so is the previous build's, so a stale save falls back rather than half-loading",
    parsed.stale === null && parsed.short === null,
    JSON.stringify([parsed.stale, parsed.short]),
  )

  // ------------------------------------------------------------ the game

  await page.type('#name', 'tiers')
  await page.type('#room', 'tiers' + Math.floor(Math.random() * 1e6))
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

  // --------------------------------- 3. the pick moves the rung, not the menu
  //
  // Asserted on what each reward *does*. A check that read the rung's name off
  // `game.ladder` would pass against a build where `spend` still dispatched the
  // old fixed ladder, which is exactly the bug this rework could introduce.

  const kitted = await page.evaluate(() => {
    const g = window.__game
    g.setLoadout(['buck', 'blitz', 'hunter', 'blackout'])
    return g.ladder.map((r) => `${r.at}:${r.id}`).join(' ')
  })
  check(
    'the ladder is three plus the four tiers, in order',
    kitted === '3:repair 5:buck 10:blitz 15:hunter 25:blackout',
    kitted,
  )

  const effects = {}
  for (const at of [5, 10, 15, 25]) {
    await page.evaluate(() => {
      const g = window.__game
      g.tank.dead = false
      g.tank.hp = g.maxHp
      for (const k of Object.keys(g.buffs)) g.buffs[k] = 0
      g.__sent = []
      if (!g.__wrapped) {
        const real = g.publishAsSession.bind(g)
        g.publishAsSession = (kind, payload) => { if (kind === 21004) g.__sent.push(payload); return real(kind, payload) }
        g.__wrapped = true
      }
    })
    const ok = await earnAndSpend(at)
    effects[at] = await page.evaluate((spent) => {
      const g = window.__game
      const now = performance.now()
      return {
        spent,
        scatter: g.buffs.scatterUntil > now,
        speed: g.buffs.speedUntil > now,
        rapid: g.buffs.rapidUntil > now,
        recon: g.buffs.reconUntil > now,
        siege: g.buffs.siegeUntil > now,
        emps: (g.__sent ?? []).filter((p) => p && p.k === 'emp').length,
        runs: (g.__sent ?? []).filter((p) => p && p.k !== 'emp').length,
      }
    }, ok)
  }
  check('buckshot on the skirmish rung loads scatter shells', effects[5].scatter && !effects[5].speed,
    JSON.stringify(effects[5]))
  check('blitz on the power rung is speed and reload together', effects[10].speed && effects[10].rapid,
    JSON.stringify(effects[10]))
  check('hunter on the heavy rung marks the room and doubles the shell',
    effects[15].recon && effects[15].siege, JSON.stringify(effects[15]))
  check('blackout on the apex rung blinds them and lights them up',
    effects[25].emps === 1 && effects[25].recon, JSON.stringify(effects[25]))

  // ------------------------------------------------ 4a. the bulwark comes back

  const bulwark = await page.evaluate(async () => {
    const g = window.__game
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    g.tank.dead = false
    g.tank.hp = g.maxHp
    for (const k of Object.keys(g.buffs)) g.buffs[k] = 0
    g.setLoadout(['buck', 'blitz', 'bulwark', 'blackout'])
    g.streak = 14
    g.earned = []
    g.onEvent({
      id: 'b' + Math.random().toString(16).slice(2),
      pubkey: 'd1'.repeat(32), kind: 21002, created_at: Math.floor(Date.now() / 1000), tags: [],
      sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), k: g.identity.sessionPubkey, x: 400, y: 400 }),
    }, false)
    g.spend(15)
    const up = g.buffs.shieldUntil > performance.now()
    // Take a hit on the shield through the real path: a lobbed shell landing on
    // us is one of the four places that pop it.
    g.popShield()
    const downNow = g.buffs.shieldUntil > performance.now()
    await sleep(2400)
    // `stepRewards` runs from `update`, so let the loop turn rather than
    // calling it here — a re-arm that only happens when a test calls it is not
    // a re-arm.
    const back = g.buffs.shieldUntil > performance.now()
    return { up, downNow, back, warranty: g.buffs.bulwarkUntil > performance.now() }
  })
  check('bulwark puts a shield up', bulwark.up, JSON.stringify(bulwark))
  check('a hit still breaks it — it is a shield, not immunity', bulwark.downNow === false,
    JSON.stringify(bulwark))
  check('and it comes back a couple of seconds later, on its own', bulwark.back,
    JSON.stringify(bulwark))

  // The other direction, which is the one a "does it come back" check cannot
  // see: once the warranty runs out, a broken shield stays broken. Without
  // this, a bulwark that re-armed forever would pass everything above.
  const expired = await page.evaluate(async () => {
    const g = window.__game
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const now = performance.now()
    g.tank.dead = false
    g.buffs.bulwarkUntil = now + 300
    g.buffs.shieldUntil = now + 300
    g.popShield()
    await sleep(2400)
    return { shield: g.buffs.shieldUntil > performance.now(), warranty: g.buffs.bulwarkUntil > performance.now() }
  })
  check(
    'but once the warranty has run out the shield stays broken',
    expired.shield === false && expired.warranty === false,
    JSON.stringify(expired),
  )

  // ----------------------------------------------------- 4b. the repair drone

  const drone = await page.evaluate(async () => {
    const g = window.__game
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    g.tank.dead = false
    for (const k of Object.keys(g.buffs)) g.buffs[k] = 0
    g.tank.hp = 1
    const max = g.maxHp
    g.setLoadout(['buck', 'drone', 'bulwark', 'blackout'])
    g.streak = 9
    g.earned = []
    g.onEvent({
      id: 'c' + Math.random().toString(16).slice(2),
      pubkey: 'd1'.repeat(32), kind: 21002, created_at: Math.floor(Date.now() / 1000), tags: [],
      sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), k: g.identity.sessionPubkey, x: 400, y: 400 }),
    }, false)
    g.spend(10)
    const start = g.tank.hp
    await sleep(2500)
    const oneTick = g.tank.hp
    await sleep(2500)
    const twoTicks = g.tank.hp
    // Cap: it heals to full and then stops, rather than running the hull past
    // the modifier's maximum where nothing else in the game expects it.
    g.tank.hp = max
    await sleep(2500)
    const capped = g.tank.hp
    return { start, oneTick, twoTicks, capped, max }
  })
  check('the drone puts a hull point back', drone.oneTick === drone.start + 1,
    JSON.stringify(drone))
  check('and keeps going while it runs', drone.twoTicks === Math.min(drone.max, drone.start + 2),
    JSON.stringify(drone))
  check('but never past a full hull', drone.capped === drone.max, JSON.stringify(drone))

  // ------------------------------------------- 4c. thermite walks the other way

  const lane = await page.evaluate(async () => {
    const g = window.__game
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    g.tank.dead = false
    g.strikes.clear()
    g.__sent = []
    g.setLoadout(['buck', 'drone', 'thermite', 'blackout'])
    g.streak = 14
    g.earned = []
    g.onEvent({
      id: 'd' + Math.random().toString(16).slice(2),
      pubkey: 'd1'.repeat(32), kind: 21002, created_at: Math.floor(Date.now() / 1000), tags: [],
      sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), k: g.identity.sessionPubkey, x: 400, y: 400 }),
    }, false)
    // Record every blast as it is queued rather than sampling the queue. The
    // renderer empties `blasts` on each frame it draws, so a poll — at any
    // interval — is a window that may contain no bomb at all even while
    // fifteen of them are going off. This was not a hypothetical: sampling
    // every 100ms saw zero of fifteen.
    const seen = []
    const push = g.blasts.push
    g.blasts.push = function (...items) {
      for (const b of items) seen.push({ x: Math.round(b.x), y: Math.round(b.y) })
      return push.apply(this, items)
    }
    g.spend(15)
    const sent = (g.__sent ?? []).slice(-1)[0]
    const strike = [...g.strikes.values()].slice(-1)[0]
    // The run starts two seconds out — that lead is the warning stripe — so
    // poll until bombs have actually landed instead of waiting a fixed beat.
    for (let i = 0; i < 90 && seen.length < 4; i++) await sleep(100)
    g.blasts.push = push
    return {
      sent,
      axis: strike?.axis,
      lane: Math.round(strike?.y ?? -1),
      seen,
      tankX: Math.round(g.tank.x),
    }
  })
  check(
    'thermite publishes a lane run: an x, and deliberately no y',
    lane.sent?.k === 'lane' && typeof lane.sent?.x === 'number' && lane.sent?.y === undefined,
    JSON.stringify(lane.sent),
  )
  check('the local copy walks the vertical axis', lane.axis === 'v', JSON.stringify({ axis: lane.axis }))
  check(
    'and the bombs walk down a column: the x stays put, the y moves',
    lane.seen.length >= 2 &&
      lane.seen.every((b) => Math.abs(b.x - lane.lane) < 2) &&
      new Set(lane.seen.map((b) => b.y)).size > 1,
    JSON.stringify(lane.seen),
  )
  check(
    'the lane is picked away from the caller, like every other bomb run',
    Math.abs(lane.lane - lane.tankX) > 200,
    `lane x ${lane.lane}, tank x ${lane.tankX}`,
  )

  // --------------------------------------- 4d. salvo warns about both of its runs
  //
  // The stripe is the reward's safety rail: two runs with one stripe is one run
  // arriving unannounced. Counted off the scene, because a stripe that is
  // present but sitting under the felt is invisible and would pass a DOM check.

  const salvo = await page.evaluate(async () => {
    const g = window.__game
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    g.tank.dead = false
    g.strikes.clear()
    g.setLoadout(['buck', 'drone', 'salvo', 'blackout'])
    g.streak = 14
    g.earned = []
    g.onEvent({
      id: 'e' + Math.random().toString(16).slice(2),
      pubkey: 'd1'.repeat(32), kind: 21002, created_at: Math.floor(Date.now() / 1000), tags: [],
      sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), k: g.identity.sessionPubkey, x: 400, y: 400 }),
    }, false)
    g.spend(15)
    const runs = [...g.strikes.values()].map((s) => ({ y: Math.round(s.y), dir: s.dir }))
    // Let the renderer draw at least once — it is what owns the stripes.
    await sleep(600)
    const lanes = window.__renderer
      ? window.__renderer.strikeLanes.filter((m) => m.visible && m.material.opacity > 0.05).length
      : -1
    return { runs, lanes }
  })
  check('salvo puts two runs on the board, one per half', salvo.runs.length === 2 &&
    salvo.runs[0].y !== salvo.runs[1].y, JSON.stringify(salvo.runs))
  check('running opposite ways', salvo.runs[0]?.dir === -salvo.runs[1]?.dir, JSON.stringify(salvo.runs))
  check(
    'and both of them are warned about — one stripe would hide half the reward',
    salvo.lanes === 2,
    `${salvo.lanes} stripes visible`,
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
console.log('All tier-pool checks passed.')
