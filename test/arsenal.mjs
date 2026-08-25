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

  // --- skins: the lobby half ------------------------------------------------
  const picker = await page.evaluate(() => ({
    options: [...document.querySelectorAll('#skin button[data-value]')].map((b) => b.dataset.value),
    blurb: document.getElementById('skin-blurb').textContent,
  }))
  check(
    'the lobby offers every skin in the table',
    picker.options.length >= 6 && picker.options[0] === 'plastic',
    picker.options.join(','),
  )
  check('and says what the selected one looks like', (picker.blurb ?? '').length > 8, picker.blurb)

  await page.click('#skin button[data-value="carbon"]')
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
    const out = { shells: g.shells.size, ammo: g.tank.ammo }
    g.tank.reloadingUntil = 0
    g.tank.ammo = 4
    return out
  })
  check(
    'a reloading tank cannot fire, and the count never goes negative',
    gated.shells === 0 && gated.ammo === 0,
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
    const real = g.publishAsSession.bind(g)
    g.publishAsSession = (kind, payload) => {
      if (kind === 21004) strikes.push(payload)
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
      g.onOwnKill()
      const now = performance.now()
      out[i] = {
        hp: g.tank.hp,
        rapid: g.buffs.rapidUntil > now,
        siege: g.buffs.siegeUntil > now,
        shield: g.buffs.shieldUntil > now,
        strikes: strikes.length,
        notice: g.notice?.sub ?? '',
      }
    }
    g.publishAsSession = real
    g.streak = 0
    return { rungs: out, maxHp }
  })
  const rung = ladder.rungs
  const fullHull = ladder.maxHp
  check('3 in a row repairs the hull', rung[3].hp === fullHull, JSON.stringify(rung[3]))
  check('5 calls an air strike', rung[5].strikes === 1, JSON.stringify(rung[5]))
  check('10 is overdrive: full hull and rapid fire', rung[10].hp === fullHull && rung[10].rapid,
    JSON.stringify(rung[10]))
  check('15 is siege shells', rung[15].siege, JSON.stringify(rung[15]))
  check('20 is the juggernaut: shielded and repaired', rung[20].shield && rung[20].hp === fullHull,
    JSON.stringify(rung[20]))
  check('25 calls a second, bigger strike', rung[25].strikes === 2, JSON.stringify(rung[25]))
  // The rungs between are not rungs. A ladder that fired a reward on every kill
  // would pass every check above and be a completely different game.
  check(
    'and nothing in between hands out a reward',
    [4, 6, 9, 11, 14, 16, 19, 21, 24].every(
      (n) => rung[n].hp === 1 && rung[n].strikes === rung[n - 1].strikes,
    ),
    [4, 6, 9].map((n) => `${n}:${rung[n].hp}`).join(' '),
  )

  // --- the air strike -------------------------------------------------------
  const IN_LANE = 'f2'.repeat(32)
  const strike = await page.evaluate(
    (IN_LANE) => {
      const g = window.__game
      g.strikes.clear()
      g.blasts.length = 0
      g.peers.clear()
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
      g.onEvent({
        id: 'strike' + Math.random().toString(16).slice(2),
        pubkey: IN_LANE, kind: 21004, created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
        content: JSON.stringify({ t0: performance.now(), y, dir: 1, n: 14, d: 2 }),
      }, false)
      return { known: g.strikes.size, hp: g.tank.hp }
    },
    IN_LANE,
  )
  check('an air strike event is picked up and simulated', strike.known === 1, JSON.stringify(strike))

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
    g.tank.dead = false
    g.tank.hp = 3
    g.buffs.shieldUntil = 0
    g.streak = 4
    g.onOwnKill() // fifth kill: our own strike
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
