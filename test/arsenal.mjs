// Ammo, kill streaks, the air strike, and skins.
//
// Puzz: "can you get kill streaks and reloading and ammo and tank skins next?"
//
// Everything here is driven through the real paths — the real `update` loop for
// the magazine, the real `onEvent` for anything that crosses the wire — and
// asserts the quantity that would change rather than a counter of how often
// something ran. A tally of "how many bombs we processed" moves whether the
// processing was right or wrong.
//
// Three of these checks exist because of bugs this suite found while it was
// being written, and each one is noted where it sits.
//
//   npm run build && npm run preview &
//   npm run test:arsenal

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL = process.env.TANK_URL ?? 'http://localhost:4173/'

const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p))
if (!executablePath) {
  console.error('No Chrome found. Set CHROME_PATH.')
  process.exit(2)
}

const FLAGS = [
  '--no-sandbox', '--window-size=1280,800', '--use-gl=angle',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox',
  '--autoplay-policy=no-user-gesture-required', '--mute-audio',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

/**
 * Poll until a condition holds, rather than sleeping a fixed amount.
 *
 * Under swiftshader this page runs at a few frames a second, so every wall
 * clock guess eventually stops containing the behaviour on a loaded machine —
 * a 2.4-second reload can take six wall seconds to finish here.
 */
async function until(fn, ms = 45_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 100))
  }
  return null
}

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  // The garage ships folded shut, and the skin clicks below need real boxes.
  await page.evaluate(() => { document.getElementById('garage-fold').open = true })

  // --- skins: the lobby half ------------------------------------------------
  // The picker is two axes now — pattern × finish — because the catalog is a
  // matrix: 36 reachable skins, every one two taps away.
  const picker = await page.evaluate(() => ({
    patterns: [...document.querySelectorAll('#skin-pattern button')].map((b) => b.dataset.value),
    finishes: [...document.querySelectorAll('#skin-finish button')].map((b) => b.dataset.value),
    blurb: document.getElementById('skin-blurb').textContent,
  }))
  check(
    'the lobby offers both axes — every pattern, every finish',
    picker.patterns.length === 7 && picker.patterns[0] === 'solid' && picker.finishes.length === 6,
    `${picker.patterns.join(',')} × ${picker.finishes.join(',')}`,
  )
  check('and says what the selected one looks like', (picker.blurb ?? '').length > 8, picker.blurb)

  // A matrix cell: the composed entries exist and the blurb follows both axes.
  await page.click('#skin-pattern button[data-value="woodland"]')
  await page.click('#skin-finish button[data-value="chrome"]')
  const combo = await page.evaluate(() =>
    document.getElementById('skin-blurb').textContent)
  check('a pattern in a finish composes — woodland chrome is a skin', /woodland/i.test(combo) && /polish|shine/i.test(combo), combo)

  // The impossible cell says so instead of painting something else: carbon
  // hides the hull, so no pattern survives it.
  const carbonOff = await page.evaluate(() =>
    document.querySelector('#skin-finish button[data-value="carbon"]').disabled)
  check('carbon is refused under a pattern rather than lying', carbonOff === true)

  await page.click('#skin-pattern button[data-value="solid"]')
  await page.click('#skin-finish button[data-value="carbon"]')
  const afterPick = await page.evaluate(() =>
    document.getElementById('skin-blurb').textContent)
  check('picking one updates the blurb', /trim/i.test(afterPick), afterPick)

  await page.type('#name', 'arsenal')
  await page.type('#room', 'arsenal' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  check('a game is running', started)
  if (!started) throw new Error('the game never started')

  // Pin the round and the rules. The magazine reload and the strike are both
  // scaled by the block's modifier, and the live chain tip moves under the
  // suite — a fixed expectation against a rule set chosen by the blockchain is
  // a result that is true by coincidence.
  await page.evaluate(() => {
    window.__game.beginRound(900000, 'ab'.repeat(30) + '0300')
  })

  check(
    'the skin the lobby chose reached the game',
    (await page.evaluate(() => window.__game.skin)) === 'carbon',
  )
  check(
    'and it is on the session attestation, not only in memory',
    await page.evaluate(async () => {
      const g = window.__game
      let seen = null
      const real = g.identity.signAsSelf.bind(g.identity)
      g.identity.signAsSelf = async (t) => {
        if (t.kind === 21003) seen = JSON.parse(t.content).sk
        return real(t)
      }
      await g.broadcastSession()
      g.identity.signAsSelf = real
      return seen === 'carbon'
    }),
  )

  // --- ammo -----------------------------------------------------------------
  const mag = () => page.evaluate(() => ({
    ammo: window.__game.tank.ammo,
    reloading: window.__game.tank.reloadingUntil > performance.now(),
    pips: document.querySelectorAll('#ammo-pips .pip').length,
    lit: document.querySelectorAll('#ammo-pips .pip.live, #ammo-pips .pip.last').length,
    word: document.getElementById('ammo-word').textContent,
  }))

  const full = await mag()
  check('a fresh tank has a full magazine', full.ammo === 4 && full.pips === 4, JSON.stringify(full))
  check('and the HUD shows every shell lit', full.lit === 4, JSON.stringify(full))

  // Held on the canvas through the real mouse path, so the ammo gate inside
  // `update` is the thing under test rather than a direct call to `fire`.
  await page.mouse.move(900, 300)
  await page.mouse.down()
  const emptied = await until(async () => {
    const m = await mag()
    return m.reloading ? m : null
  })
  await page.mouse.up()
  check('holding the trigger runs the magazine dry', !!emptied, JSON.stringify(emptied))
  check(
    'and an empty magazine reloads itself — nobody is left on a dead trigger',
    emptied?.ammo === 0 && emptied?.word === 'reloading',
    JSON.stringify(emptied),
  )

  // The gate itself. Emptying the magazine is not evidence that the gate
  // exists: with the `ammo > 0` condition deleted, `fire()` still starts a
  // reload when the count reaches zero, so "the magazine ran dry" was true
  // against code with no gate at all. What only holds *with* the gate is that
  // a reloading tank cannot put a shell on the board and the count never goes
  // below zero.
  const gated = await page.evaluate(() => {
    const g = window.__game
    g.shells.clear()
    g.tank.dead = false
    g.tank.ammo = 0
    g.tank.reloadingUntil = performance.now() + 30_000
    g.tank.reloadAt = 0
    const held = { throttle: 0, steer: 0, aim: null, fire: true, reload: false }
    for (let i = 0; i < 40; i++) g.update(0.016, held)
    // *Our* shells, not every shell on the board. This check used to count
    // `g.shells.size`, and the practice tanks put their shots in the same map:
    // a bot whose reload deadline elapsed inside the window — a few
    // milliseconds normally, longer on a busy machine, which is why this
    // correlated with load — read as "the reloading tank fired". Caught by
    // asking who owned the shell: `{total: 1, mine: 0, bots: 1}`, with our own
    // gun silent and the reload still live.
    const shells = [...g.shells.values()].filter((s) => s.owner === g.identity.sessionPubkey)
    const out = {
      shells: shells.length,
      ammo: g.tank.ammo,
      // The premise, so this cannot pass by the reload quietly finishing and
      // the tank legitimately having nothing to be gated on.
      reloading: g.tank.reloadingUntil > performance.now(),
      bots: g.shells.size - shells.length,
    }
    g.tank.reloadingUntil = 0
    g.tank.ammo = 4
    return out
  })
  check(
    'a reloading tank cannot fire, and the count never goes negative',
    gated.reloading && gated.shells === 0 && gated.ammo >= 0,
    JSON.stringify(gated),
  )

  const back = await until(async () => {
    const m = await mag()
    return !m.reloading && m.ammo === 4 ? m : null
  })
  check('the reload finishes and the magazine comes back full', !!back, JSON.stringify(back))

  // The early reload. This is the interesting decision in the whole feature —
  // spend the time in cover now, or gamble that two shells is enough — and it
  // is the half a "does it reload when empty" test cannot reach.
  const early = await page.evaluate(async () => {
    const g = window.__game
    g.tank.ammo = 2
    g.tank.reloadingUntil = 0
    // Straight into `stepMagazine`, which is what the real `update` calls with
    // `controls.reload`. The key event itself is covered by test/controls.mjs.
    g.stepMagazine(performance.now(), true)
    return { reloading: g.tank.reloadingUntil > performance.now(), ammo: g.tank.ammo }
  })
  check('asking for a reload at two shells starts one', early.reloading, JSON.stringify(early))

  const noop = await page.evaluate(() => {
    const g = window.__game
    g.tank.ammo = 4
    g.tank.reloadingUntil = 0
    g.stepMagazine(performance.now(), true)
    return g.tank.reloadingUntil > performance.now()
  })
  // The other direction. A reload that fires on every press passes "does the
  // key work" and takes a full magazine away from anyone who leans on it.
  check('asking for one on a full magazine does nothing', !noop)

  // --- ammo on the wire -----------------------------------------------------
  const sent = await page.evaluate(() => {
    const g = window.__game
    let out = null
    const real = g.publishAsSession.bind(g)
    g.publishAsSession = (kind, payload) => {
      if (kind === 21000) out = payload
      return real(kind, payload)
    }
    g.tank.ammo = 3
    g.tank.reloadingUntil = 0
    g.publishState(performance.now())
    g.tank.reloadingUntil = performance.now() + 5000
    const loaded = out
    g.publishState(performance.now())
    g.publishAsSession = real
    g.tank.reloadingUntil = 0
    return { loaded: loaded?.a, reloading: out?.a }
  })
  check(
    'our tick carries the magazine, and reads 0 while reloading',
    sent.loaded === 3 && sent.reloading === 0,
    JSON.stringify(sent),
  )

  const PEER = 'e1'.repeat(32)
  const peerAmmo = await page.evaluate(
    (PEER) => {
      window.__game.peers.clear()
      const tick = (a) => window.__game.onEvent({
        id: 'a' + Math.random().toString(16).slice(2),
        pubkey: PEER, kind: 21000, created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
        content: JSON.stringify({ t: Date.now(), x: 300, y: 300, h: 0, g: 0, hp: 3, d: false, a }),
      }, false)
      tick(0)
      // Two samples: `interpolate` reads the newer of a pair and a single
      // sample takes the extrapolation branch instead, so one tick would test
      // a different code path than the one a real peer goes through.
      tick(0)
      window.__game.update(0.016, { throttle: 0, steer: 0, aim: null, fire: false, reload: false })
      return [...window.__game.peers.values()][0]?.view.ammo
    },
    PEER,
  )
  check('a peer that says it is empty is empty on our board', peerAmmo === 0, String(peerAmmo))

  const oldClient = await page.evaluate(
    (PEER) => {
      window.__game.peers.clear()
      window.__game.onEvent({
        id: 'b' + Math.random().toString(16).slice(2),
        pubkey: PEER, kind: 21000, created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
        content: JSON.stringify({ t: Date.now(), x: 300, y: 300, h: 0, g: 0, hp: 3, d: false }),
      }, false)
      return [...window.__game.peers.values()][0]?.buffer.at(-1)?.ammo
    },
    PEER,
  )
  // Both tanks are in the room during a deploy. Guessing "empty" for a client
  // too old to say would paint a reload marker over a tank about to shoot you,
  // which is worse than saying nothing.
  check('a client too old to report ammo is assumed loaded', oldClient === 4, String(oldClient))

  // --- kill streaks ---------------------------------------------------------
  //
  // Driven through `onOwnKill`, which is what the real death handler calls when
  // a victim's report names us. Asserting the rewards themselves — hull, buffs,
  // a published strike — not a count of how many rungs were climbed.
  const ladder = await page.evaluate(() => {
    const g = window.__game
    // Re-pinned, and every hull assertion is made against `g.maxHp` rather
    // than against the literal 3. The chain poller is still running and a real
    // tip landing mid-suite rolls the round into a different rule set — Glass
    // Cannon gives a tank one hull point, so "repaired" is 1 and not 3, and
    // three checks here went red for a reason that had nothing to do with kill
    // streaks. The reward is "your hull is full", not "your hull is three".
    g.beginRound(900000, 'ab'.repeat(30) + '0300')
    const maxHp = g.maxHp
    const strikes = []
    const emps = []
    const real = g.publishAsSession.bind(g)
    g.publishAsSession = (kind, payload) => {
      // The EMP rides the strike kind with `k: 'emp'` and no lane — counting
      // it as a bomb run would fail every rung above fifteen for the wrong
      // reason, and not counting it at all would leave rung fifteen unproven.
      if (kind === 21004) (payload && payload.k === 'emp' ? emps : strikes).push(payload)
      return real(kind, payload)
    }
    const out = {}
    g.streak = 0
    g.tank.dead = false
    for (let i = 1; i <= 25; i++) {
      g.tank.hp = 1
      g.buffs.rapidUntil = 0
      g.buffs.siegeUntil = 0
      g.buffs.shieldUntil = 0
      g.buffs.speedUntil = 0
      g.buffs.reconUntil = 0
      g.chopperUntil = 0
      g.onOwnKill()
      // Rewards are earned now and spent on a click — see `Game.spend` and
      // test/tray.mjs. This file is about *what each rung does*, so it still
      // walks the ladder and then spends whatever the rung put in the tray;
      // that a rung no longer fires on its own is the tray suite's claim, not
      // this one's, and asserting it in both places would mean changing it in
      // both places the next time it moves.
      if (g.holding(i)) g.spend(i)
      const now = performance.now()
      out[i] = {
        hp: g.tank.hp,
        rapid: g.buffs.rapidUntil > now,
        siege: g.buffs.siegeUntil > now,
        recon: g.buffs.reconUntil > now,
        shield: g.buffs.shieldUntil > now,
        chopper: g.chopperUntil > now,
        strikes: strikes.length,
        emps: emps.length,
        notice: g.notice?.sub ?? '',
      }
    }
    g.publishAsSession = real
    g.streak = 0
    g.chopperUntil = 0
    return { rungs: out, maxHp }
  })
  const rung = ladder.rungs
  const fullHull = ladder.maxHp
  // The default loadout, which is now one reward from each tier's pool of five
  // — strike at 5, chopper at 10, juggernaut at 15, carpet at 25. Seven and
  // twenty stopped being rungs when the tiers were rebuilt around the pools;
  // they are checked below as rungs that hand out nothing.
  check('3 in a row repairs the hull', rung[3].hp === fullHull, JSON.stringify(rung[3]))
  check('5 calls an air strike', rung[5].strikes === 1, JSON.stringify(rung[5]))
  check('10 boards the chopper', rung[10].chopper, JSON.stringify(rung[10]))
  check('15 is the juggernaut: shielded and repaired', rung[15].shield && rung[15].hp === fullHull,
    JSON.stringify(rung[15]))
  check('25 calls a second, bigger strike', rung[25].strikes === 2, JSON.stringify(rung[25]))
  // The rungs between are not rungs. A ladder that fired a reward on every kill
  // would pass every check above and be a completely different game.
  check(
    'and nothing in between hands out a reward',
    [4, 6, 7, 9, 11, 14, 16, 19, 20, 21, 24].every(
      (n) => rung[n].hp === 1 && rung[n].strikes === rung[n - 1].strikes,
    ),
    [4, 6, 7, 20].map((n) => `${n}:${rung[n].hp}`).join(' '),
  )

  // --- the loadout ----------------------------------------------------------
  //
  // The ladder above was the *default* loadout, which is why every check
  // passed without arranging anything. Now rearrange it and prove the rungs
  // follow: recon, siege, hunter and armageddon, none of them in the default,
  // one from each tier's pool. A cross-tier arrangement is not a rearrangement
  // any more — it is refused, and test/tiers.mjs is where that is checked.
  const kitted = await page.evaluate(() => {
    const g = window.__game
    g.setLoadout(['recon', 'siege', 'hunter', 'armageddon'])
    const real = g.publishAsSession.bind(g)
    const sent = []
    g.publishAsSession = (kind, payload) => {
      if (kind === 21004) sent.push(payload)
      return real(kind, payload)
    }
    const out = {}
    const rungAt = (n) => {
      g.streak = n - 1
      g.tank.dead = false
      g.tank.hp = 1
      g.buffs.siegeUntil = 0
      g.buffs.reconUntil = 0
      g.chopperUntil = 0
      g.onOwnKill()
      // Earn-then-spend, same as the default-ladder walk above.
      if (g.holding(n)) g.spend(n)
      const now = performance.now()
      return {
        siege: g.buffs.siegeUntil > now,
        recon: g.buffs.reconUntil > now,
        emps: sent.filter((p) => p && p.k === 'emp').length,
        strikes: sent.filter((p) => !p || p.k !== 'emp').length,
      }
    }
    out.at5 = rungAt(5)
    out.at10 = rungAt(10)
    out.at15 = rungAt(15)
    out.at25 = rungAt(25)
    out.ladder = g.ladder.map((r) => `${r.at}:${r.id}`).join(' ')
    g.publishAsSession = real
    g.setLoadout(['strike', 'chopper', 'jugger', 'carpet'])
    g.streak = 0
    return out
  })
  check(
    'a rearranged loadout moves the rungs, not just the menu',
    kitted.at5.recon &&
      kitted.at10.siege &&
      kitted.at15.recon &&
      kitted.at15.siege &&
      kitted.at25.strikes === 3,
    kitted.ladder,
  )

  // --- the air strike -------------------------------------------------------
  const IN_LANE = 'f2'.repeat(32)
  const strike = await page.evaluate(
    (IN_LANE) => {
      const g = window.__game
      g.strikes.clear()
      g.blasts.length = 0
      g.peers.clear()
      // And the practice tanks, for both halves of this pair. They shoot at a
      // parked tank, so on the positive control they can supply the damage the
      // strike was supposed to — the check passes for the wrong reason — and on
      // the caller's case below they take a hull point off a tank that its own
      // bombs correctly spared, which is the "does not hurt the caller" failure
      // that turned up about one run in three. The claim is about a strike, so
      // nothing else on the board may be able to do the damage.
      g.botsWanted = 0
      g.bots = []
      g.shells.clear()
      g.tank.dead = false
      g.tank.hp = 3
      g.buffs.shieldUntil = 0
      // Somebody else's strike, walking down the row we are parked on. Fed
      // through `onEvent` so the payload, the clock shift and the handler are
      // all the real ones.
      // Parked mid-lane at a fixed spot, and the caller's case below parks at
      // exactly the same one. These two are a matched pair — same lane, same
      // position, same bomb count — and the *only* difference between them is
      // who owns the strike. Without that the negative case proves nothing,
      // because a tank that was never in range takes no damage either way.
      const y = g.tank.y
      g.tank.x = 800
      // The bomb count a *real* client would send on this board, not a
      // hand-written fourteen.
      //
      // Fourteen was right when Crossroads was the only board. The boards are
      // 1500 to 2100 across now and the game derives the count from the width,
      // so fourteen on Pillars puts the bombs 160 apart against a 64-unit blast
      // radius — the nearest one lands 65 units from a tank parked at x=800 and
      // it takes nothing. That is not a strike that failed, it is a payload no
      // client would ever send. Measured: a real strike on the same board drops
      // 19 bombs, 115 apart, nearest 56, and the tank dies.
      //
      // The board comes off the chain tip, so this went red and green with the
      // *block* rather than with any commit — which is exactly what a bisect
      // against a moving environment looks like.
      const { bombsFor, STRIKE_GAP, STRIKE_RADIUS } = window.__strike
      const span = window.__arena.ARENA_W + STRIKE_RADIUS * 2
      const n = bombsFor(span, STRIKE_GAP)
      g.onEvent({
        id: 'strike' + Math.random().toString(16).slice(2),
        pubkey: IN_LANE, kind: 21004, created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
        content: JSON.stringify({ t0: performance.now(), y, dir: 1, n, d: 2 }),
      }, false)
      // Where the bombs will actually land, so the precondition below can be
      // asserted rather than assumed: the same walk `stepStrikes` does.
      const bombs = []
      for (let i = 0; i < n; i++) {
        const t = n > 1 ? i / (n - 1) : 0.5
        bombs.push(Math.round(-STRIKE_RADIUS + t * span))
      }
      const nearest = Math.min(...bombs.map((b) => Math.abs(b - 800)))
      return { known: g.strikes.size, hp: g.tank.hp, n, nearest, radius: STRIKE_RADIUS }
    },
    IN_LANE,
  )
  check('an air strike event is picked up and simulated', strike.known === 1, JSON.stringify(strike))
  // The precondition, named. Without this, a run of this board where the
  // victim happens to sit between two bombs reports "damage does not land",
  // which is a sentence about the game and not about the arithmetic that put
  // the tank in a gap.
  check(
    'and the tank really is under one of its bombs',
    strike.nearest < strike.radius,
    `nearest bomb ${strike.nearest} away, blast radius ${strike.radius}, ${strike.n} bombs`,
  )

  const hit = await until(async () =>
    page.evaluate(() => {
      const g = window.__game
      // The bombs walk across the whole board, so the one that reaches us is
      // several steps in. Stepping the real `update` is what advances them.
      g.update(0.016, { throttle: 0, steer: 0, aim: null, fire: false, reload: false })
      return g.tank.hp < 3 || g.tank.dead ? { hp: g.tank.hp, dead: g.tank.dead } : null
    }))
  check('a tank standing in the lane gets hit', !!hit, JSON.stringify(hit))

  const blasts = await page.evaluate(() => {
    const g = window.__game
    g.strikes.clear()
    g.blasts.length = 0
    // Same reason as the control above: this window is six seconds long and a
    // practice tank can put a shell into a parked target in that time.
    g.botsWanted = 0
    g.bots = []
    g.shells.clear()
    g.tank.dead = false
    g.tank.hp = 3
    g.buffs.shieldUntil = 0
    g.streak = 4
    g.onOwnKill() // fifth kill: earns the strike
    // ...and spending it is what calls it. The rung stopped firing on its own
    // when rewards became a tray you spend from; without this the strike set
    // below is empty and the next line reads `.y` off nothing, which is how
    // this file reported the change as "Cannot read properties of undefined".
    g.spend(5)
    // **Drive into our own lane.**
    //
    // Without this the check passed against code with the exemption deleted,
    // because `callStrike` picks the row furthest from the caller and we were
    // never in the blast radius to begin with. "He took no damage" was true
    // for the wrong reason — the geometry was doing the work and the rule
    // under test was never reached. Standing in the lane is the only way this
    // can distinguish the exemption from its absence.
    const ours = [...g.strikes.values()][0]
    g.tank.y = ours.y
    g.tank.x = 800 // the same spot the positive control above stood on
    let seen = 0
    const deadline = performance.now() + 6000
    while (performance.now() < deadline) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, fire: false, reload: false })
      seen += g.blasts.length
      g.blasts.length = 0
    }
    // How many of those bombs came down close enough to have hurt somebody
    // else standing here. If this is zero the case is vacuous and the check
    // below means nothing, so it is asserted rather than assumed.
    g.streak = 0
    return { lane: ours.y, seen, bombs: ours.n, hp: g.tank.hp, dead: g.tank.dead }
  })
  // The caller is exempt, and it has to be *seen* to be exempt — the bombs
  // really did go off, we really were in the arena, and we took nothing. A
  // check that only asserted "hp is 3" would pass just as well against a strike
  // that never detonated at all.
  check(
    'our own bombs go off, and we are standing in their lane',
    blasts.seen === blasts.bombs,
    JSON.stringify(blasts),
  )
  check(
    'and they do not hurt the tank that called them',
    blasts.hp === 3 && !blasts.dead,
    JSON.stringify(blasts),
  )

  const shielded = await page.evaluate(
    (IN_LANE) => {
      const g = window.__game
      g.strikes.clear()
      g.blasts.length = 0
      g.tank.dead = false
      g.tank.hp = 3
      g.buffs.shieldUntil = performance.now() + 30_000
      g.onEvent({
        id: 'sh' + Math.random().toString(16).slice(2),
        pubkey: IN_LANE, kind: 21004, created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
        content: JSON.stringify({ t0: performance.now(), y: g.tank.y, dir: 1, n: 14, d: 2 }),
      }, false)
      let seen = 0
      const deadline = performance.now() + 4000
      while (performance.now() < deadline) {
        g.update(0.016, { throttle: 0, steer: 0, aim: null, fire: false, reload: false })
        seen += g.blasts.length
        g.blasts.length = 0
      }
      g.buffs.shieldUntil = 0
      return { seen, hp: g.tank.hp }
    },
    IN_LANE,
  )
  check(
    'a shield turns the bombs aside, and the bombs really fell',
    shielded.seen > 0 && shielded.hp === 3,
    JSON.stringify(shielded),
  )

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '))
} catch (err) {
  check('the run completed', false, err.message)
} finally {
  await browser.close()
}

if (failures.length) {
  console.log(`\n${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nAll arsenal checks passed.')
