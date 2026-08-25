// Kill-streak rewards that actually kill things, and teams that have two sides.
//
// Puzz: *"air strike didnt really work"* and *"team death match isnt really
// working"*. Two reports, one shape of cause, and both were found by reading
// rather than by testing — which is why this suite exists now.
//
// The strike damage block only ever touched `this.tank`. It was written before
// bots existed and never learned about them, so a solo player earned an air
// strike at five kills, fourteen bombs walked the board, and nothing died. The
// chopper reads so much better for exactly this reason: `rakeBots` came after
// bots and does hit them. That contrast is the tell, and it is the first check
// below — the chopper is the control the strike is measured against.
//
// Teams had the same shape: bots were hard-coded to nobody's side, so picking
// Red in a solo room left three tanks on no team and the mode played as a
// deathmatch with extra paperwork.
//
// Every check has a control, and the controls here are unusually load-bearing:
// "the strike killed a bot" means nothing without "a bot outside the lane
// lived", because a strike that kills everything on the board is a different
// bug wearing the same green tick.
//
//   npm run build && npx vite preview --port 4230 &
//   npm run test:rewards

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4230/'
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
  await page.type('#name', 'streak')
  await page.type('#room', 'rw' + Math.floor(Math.random() * 1e6))
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
    document.getElementById('podium').hidden = true
  }, HASH)
  await wait(1200)

  const spawned = await page.evaluate(() => window.__game.botCount)
  check('three bots are on the board to shoot at', spawned === 3, `botCount=${spawned}`)

  // --------------------------------------------------- the strike kills bots

  /**
   * Call a strike and run the clock forward through the whole run.
   *
   * Bots are parked *in the lane* on purpose. `callStrike` picks the lane on
   * the far half of the board from the caller, so where the bots happen to be
   * driving is not something this check should depend on — it reads the lane
   * out of the live strike and puts them on it.
   */
  const runStrike = () => page.evaluate(async () => {
    const g = window.__game
    g.tank.dead = false
    g.tank.x = 200
    g.tank.y = 200
    g.streak = 4
    const before = g.bots.map((b) => b.tank.hp)
    // Reach the fifth kill by *killing a bot*, not by feeding a death event
    // from a stranger. A stranger's event creates a peer, and a peer standing
    // down the bots is the whole point of `syncBots` — the first version of
    // this stood the board down and then read `g.bots[0]` off an empty list.
    // Killing a bot runs `onOwnKill` through the same ladder, and adds nobody.
    const victim = g.bots[0]
    victim.tank.dead = false
    victim.tank.hp = 1
    const id = 'k' + Math.random().toString(16).slice(2)
    g.shells.set(id, {
      id, owner: g.identity.sessionPubkey, x: victim.tank.x, y: victim.tank.y,
      vx: 1, vy: 0, bounces: 0, maxBounces: 0, damage: 1, lob: 0,
      travel: 0, struck: -1, landed: false, age: 0, dead: false,
    })
    for (let i = 0; i < 6; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
    }
    const strike = [...g.strikes.values()][0]
    if (!strike) return { called: false }
    // Two on the lane, one well off it — the control.
    // Bots one and two go in the lane; bot zero was just killed to earn this
    // and is respawning, so it is not a witness to anything.
    g.bots[1].tank.x = 400; g.bots[1].tank.y = strike.y; g.bots[1].tank.dead = false; g.bots[1].tank.hp = 3
    g.bots[2].tank.x = 900; g.bots[2].tank.y = strike.y; g.bots[2].tank.dead = false; g.bots[2].tank.hp = 3
    // And bot zero is the control, parked well off the lane once it is back.
    const offLaneY = strike.y > 600 ? 140 : 1060
    g.bots[0].tank.dead = false; g.bots[0].tank.hp = 3
    g.bots[0].tank.x = 900; g.bots[0].tank.y = offLaneY
    const offLane = { x: 900, y: offLaneY }

    // Let the whole run walk. Bots drive, so they are re-parked every frame —
    // otherwise this measures their pathfinding rather than the bombs.
    const t0 = performance.now()
    let firstHitAt = null
    while (performance.now() - t0 < 6000) {
      g.bots[1].tank.x = 400; g.bots[1].tank.y = strike.y
      g.bots[2].tank.x = 900; g.bots[2].tank.y = strike.y
      g.bots[0].tank.x = offLane.x; g.bots[0].tank.y = offLane.y
      g.bots[0].tank.dead = false
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
      if (firstHitAt === null && [1, 2].some((i) => g.bots[i].tank.hp < 3 || g.bots[i].tank.dead)) {
        firstHitAt = Math.round(performance.now() - t0)
      }
      await new Promise((r) => setTimeout(r, 8))
    }
    return {
      called: true,
      before,
      inLane: [1, 2].map((i) => ({ hp: g.bots[i].tank.hp, dead: g.bots[i].tank.dead })),
      offLane: { hp: g.bots[0].tank.hp, dead: g.bots[0].tank.dead },
      firstHitAt,
      botKills: g.botKills,
    }
  })

  const strike = await runStrike()
  check('a fifth kill in a row calls an air strike', strike.called === true, JSON.stringify(strike))
  check(
    'and the bombs kill the bots standing in the lane',
    strike.inLane?.every((b) => b.dead || b.hp < 3),
    JSON.stringify(strike.inLane),
  )
  // The control that makes the line above mean something. A strike that killed
  // everything on the board would satisfy it too, and would be a worse bug.
  check(
    'the control: and a bot well off the lane is untouched',
    strike.offLane?.hp === 3 && strike.offLane?.dead === false,
    JSON.stringify(strike.offLane),
  )
  check('and the kills are credited', strike.botKills > 0, `botKills=${strike.botKills}`)

  // The warning. `callStrike` used to stamp `t0 = now`, so bomb zero landed on
  // the same frame the siren played and the lane lit up under a tank that was
  // already dead. Two seconds is what the code comment always claimed.
  check(
    'and the first bomb lands about two seconds after the siren, not with it',
    strike.firstHitAt !== null && strike.firstHitAt >= 1700,
    `first hit at ${strike.firstHitAt}ms`,
  )

  // --------------------------------------------------- bots take sides

  const sides = await page.evaluate(async () => {
    const g = window.__game
    g.team = 1
    for (let i = 0; i < 30; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
      await new Promise((r) => setTimeout(r, 8))
    }
    const teams = g.bots.map((b) => g.peers.get(b.session)?.view.team ?? 0)
    return { ours: g.team, teams }
  })
  check('in a team mode the bots take sides',
    sides.teams.every((t) => t > 0), JSON.stringify(sides))
  check('one of them is with us',
    sides.teams.filter((t) => t === sides.ours).length >= 1, JSON.stringify(sides))
  check('and the rest are against us, so there is a team to fight',
    sides.teams.filter((t) => t !== sides.ours).length >= 1, JSON.stringify(sides))

  // The control: in a free-for-all they are on nobody's side, which is what
  // makes a deathmatch a deathmatch.
  const ffa = await page.evaluate(async () => {
    const g = window.__game
    g.team = 0
    for (let i = 0; i < 30; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
      await new Promise((r) => setTimeout(r, 8))
    }
    return g.bots.map((b) => g.peers.get(b.session)?.view.team ?? 0)
  })
  check('the control: in a free-for-all nobody has a side', ffa.every((t) => t === 0), JSON.stringify(ffa))

  // ------------------------------------------- a friendly bot is a teammate

  const friendly = await page.evaluate(async () => {
    const g = window.__game
    g.team = 1
    for (let i = 0; i < 20; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
      await new Promise((r) => setTimeout(r, 8))
    }
    const mate = g.bots.find((b) => (g.peers.get(b.session)?.view.team ?? 0) === g.team)
    const foe = g.bots.find((b) => {
      const t = g.peers.get(b.session)?.view.team ?? 0
      return t && t !== g.team
    })
    if (!mate || !foe) return { ok: false }
    const shoot = (bot) => {
      bot.tank.dead = false
      bot.tank.hp = 3
      const id = 's' + Math.random().toString(16).slice(2)
      g.shells.set(id, {
        id, owner: g.identity.sessionPubkey, x: bot.tank.x, y: bot.tank.y,
        vx: 1, vy: 0, bounces: 0, maxBounces: 0, damage: 1, lob: 0,
        travel: 0, struck: -1, landed: false, age: 0, dead: false,
      })
      for (let i = 0; i < 6; i++) {
        g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
      }
      return bot.tank.hp
    }
    const mateHp = shoot(mate)
    const foeHp = shoot(foe)
    // Ours only. The bots are shooting too, so `g.shells.size` counts their
    // rounds as well and reported two left over from a pair of shells that had
    // both been consumed correctly.
    const mine = [...g.shells.values()].filter((sh) => sh.owner === g.identity.sessionPubkey).length
    return { ok: true, mateHp, foeHp, shellsLeft: mine }
  })
  check('a shell into a teammate bot does nothing', friendly.ok && friendly.mateHp === 3,
    JSON.stringify(friendly))
  check('the control: and the same shell into an enemy bot lands',
    friendly.ok && friendly.foeHp === 2, JSON.stringify(friendly))
  check('and it is consumed either way, so it cannot sail on',
    friendly.shellsLeft === 0, `${friendly.shellsLeft} shells left`)

  // ------------------------------------------------------- the chopper clock

  const chop = await page.evaluate(() => {
    const g = window.__game
    g.team = 0
    g.streak = 9
    g.tank.dead = false
    // Same reason as the strike: kill a bot rather than inventing a peer, or
    // the bots stand down and there is nothing left to kill.
    const victim = g.bots.find((b) => !b.tank.dead) ?? g.bots[0]
    victim.tank.dead = false
    victim.tank.hp = 1
    const id = 'k' + Math.random().toString(16).slice(2)
    g.shells.set(id, {
      id, owner: g.identity.sessionPubkey, x: victim.tank.x, y: victim.tank.y,
      vx: 1, vy: 0, bounces: 0, maxBounces: 0, damage: 1, lob: 0,
      travel: 0, struck: -1, landed: false, age: 0, dead: false,
    })
    for (let i = 0; i < 6; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
    }
    return { flying: g.flying, left: g.chopperLeft, streak: g.streak }
  })
  check('the chopper runs for twenty seconds now',
    chop.flying === true && chop.left > 19 && chop.left <= 20, JSON.stringify(chop))

  // And the bar tracks it. It divided by a hardcoded 10, so at twenty seconds
  // it clamped to full for the whole first half of the reward.
  // Poll for the HUD to paint rather than waiting a fixed 600ms. `paintChopper`
  // runs from the render loop, and against a deployed origin that loop competes
  // with everything else the page is doing on first load — this read `hidden:
  // true` once against production while the game itself said `flying`.
  let bar = { hidden: true, left: '' }
  for (let i = 0; i < 40; i++) {
    bar = await page.evaluate(() => {
      const el = document.getElementById('chopper')
      return { hidden: el.hidden, left: el.style.getPropertyValue('--left') }
    })
    if (!bar.hidden && bar.left) break
    await wait(100)
  }
  check('and the countdown bar is not pinned full at the start',
    bar.hidden === false && Number(bar.left) < 0.999 && Number(bar.left) > 0.9,
    JSON.stringify(bar))

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall good')
process.exit(failures.length ? 1 : 0)
