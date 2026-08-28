// The juggernaut suit: out of the tank, and standing in the open.
//
// Puzz: *"juggernaut where player gets this huge metal gear solid looking suit
// and can walk around with machine guns spitting out dozens of bullets per
// second."*
//
// What has to be true, in the order the claims depend on each other:
//
//   1. Spending the rung *transforms* you. The old juggernaut was three buffs
//      going up, so a check that only looked at hull and shield would pass
//      against the thing this replaced — every check here is about the suit.
//   2. It is on the board, not off it. The chopper takes your tank away; this
//      leaves you standing where you were, which is what makes it fair.
//   3. The gun is continuous and it kills at the rate `SUIT_HIT_MS` says, not
//      at the rate the tracers suggest.
//   4. It rides the tick — `j`, `jx`, `jy` — and publishes nothing else. A
//      machinegun that published its rounds would work perfectly here and be
//      unusable on a real relay.
//   5. Somebody else's suit is drawn as a suit and can kill us, and the damage
//      is applied by us to ourselves like every shell.
//   6. It ends: the clock runs out, or you die, and either way you are back in
//      a tank rather than a mech that outlived the reward.
//
//   npm run build && npx vite preview --port 4344 &
//   npm run test:suit

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4344/'
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
async function until(fn, ms = 15_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await wait(80)
  }
  return null
}

const PEER = 'd1'.repeat(32)
// Pinned: the map, the hull and the pickup schedule all come off the tip, and
// Glass Cannon would make every hull assertion below mean something different.
const HASH = 'ab'.repeat(30) + '0300'

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

/** Wear the suit for real: reach the rung with a kill, then spend it. */
const wearSuit = () =>
  page.evaluate((PEER) => {
    const g = window.__game
    g.setLoadout(['strike', 'chopper', 'jugger', 'carpet'])
    g.tank.dead = false
    g.tank.hp = 1
    g.streak = 14
    g.earned = []
    g.onEvent({
      id: 'a' + Math.random().toString(16).slice(2),
      pubkey: PEER, kind: 21002, created_at: Math.floor(Date.now() / 1000), tags: [],
      sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), k: g.identity.sessionPubkey, x: 400, y: 400 }),
    }, false)
    const banked = g.holding(15)
    const spent = banked ? g.spend(15) : false
    return { banked, spent, suited: g.suited, left: g.suitLeft, hp: g.tank.hp, max: g.maxHp }
  }, PEER)

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'suit')
  await page.type('#room', 'suit' + Math.floor(Math.random() * 1e6))
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
    window.__arena.setLayout(window.__arena.layoutForBlock(hash))
    document.getElementById('podium').hidden = true
  }, HASH)
  await wait(1000)

  // ------------------------------------------------- 1. the rung transforms you

  const worn = await wearSuit()
  check('fifteen in a row banks the juggernaut', worn.banked, JSON.stringify(worn))
  check(
    'and spending it puts you in the suit rather than handing you buffs',
    worn.suited && worn.left > 12,
    JSON.stringify(worn),
  )
  check('the hull comes back with it', worn.hp === worn.max, `${worn.hp} of ${worn.max}`)

  // The armour: a shield that comes back rather than a one-shot bubble. That is
  // the whole of "huge and armoured" on the wire — everybody already draws a
  // shield off `sh`, so the suit reads as armoured on every screen.
  const armour = await page.evaluate(async () => {
    const g = window.__game
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const now = performance.now()
    const up = g.buffs.shieldUntil > now
    g.popShield()
    const down = g.buffs.shieldUntil > performance.now()
    // Polled, not slept. The re-arm is booked for two seconds and `stepRewards`
    // runs from the render loop, which is a quarter speed under a software
    // rasteriser — so a 2.4s sleep is 400ms of headroom against a frame gap
    // that can be 250ms on its own. Seen failing once and passing twice
    // straight after, which is what a window that barely contains the
    // behaviour looks like from outside.
    let back = false
    for (let i = 0; i < 80 && !back; i++) {
      await sleep(100)
      back = g.buffs.shieldUntil > performance.now()
    }
    return { up, down, back, suited: g.suited }
  })
  check('the plating holds a shot', armour.up && armour.down === false, JSON.stringify(armour))
  check('and comes back a couple of seconds later', armour.back && armour.suited, JSON.stringify(armour))

  // ---------------------------------------------- 2. you are still on the board

  const onBoard = await page.evaluate(() => {
    const g = window.__game
    return {
      flying: !!g.flying,
      dead: !!g.tank.dead,
      // The renderer draws the *rig* — hull off, suit on. A suit that existed
      // in the model and not in the scene would pass every other check here.
      rig: (() => {
        const r = window.__renderer.you
        return { suit: !!r.suit && r.suit.visible, hull: r.hull.visible, root: r.root.visible }
      })(),
    }
  })
  check(
    'the tank is still on the board — this is not the chopper',
    onBoard.flying === false && onBoard.dead === false && onBoard.rig.root === true,
    JSON.stringify(onBoard),
  )
  check(
    'and it is drawn as a suit: the mech is on, the hull is off',
    onBoard.rig.suit === true && onBoard.rig.hull === false,
    JSON.stringify(onBoard.rig),
  )

  // The suit is slower. Measured by driving, not by reading a constant.
  const speeds = await page.evaluate(async () => {
    const g = window.__game
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const a = window.__arena
    // From a spawn, driving at the middle of the board. The first cut started
    // at (300, 300) with the hull pointing east, which on Crossroads is *inside
    // a crate* — both runs moved 24 units into it and the suit looked exactly as
    // fast as the tank. Spawns are the one place the board guarantees is open.
    const spawn = a.SPAWNS[0]
    const cx = a.ARENA_W / 2
    const cy = a.ARENA_H / 2
    const heading = Math.atan2(cy - spawn.y, cx - spawn.x)
    const run = async () => {
      g.tank.x = spawn.x
      g.tank.y = spawn.y
      g.tank.hull = heading
      g.tank.gun = heading
      const from = { x: g.tank.x, y: g.tank.y }
      const t0 = performance.now()
      // Synchronously, with no `await` anywhere in the loop. The render loop
      // calls `update` with the *player's* controls — throttle 0 — every frame
      // it draws, so a measurement that yields to it is measuring a tank being
      // braked between every one of its own steps. The first cut of this
      // yielded every twelfth frame and both runs came back at 24 units, which
      // reads exactly like a speed factor that is not applied.
      // Forty frames, not ninety. There is no acceleration in `stepTank` —
      // speed is instantaneous — so a clean run is exactly the speed ratio, and
      // the only thing that can spoil it is one of the two runs reaching cover
      // that the other did not. Ninety frames put the faster run into
      // something and read 0.77 for a factor of 0.62.
      for (let i = 0; i < 40; i++) {
        g.update(0.016, { throttle: 1, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
      }
      void t0
      void sleep
      return Math.hypot(g.tank.x - from.x, g.tank.y - from.y)
    }
    const suited = await run()
    g.suitUntil = 0
    g.suitAt = null
    const plain = await run()
    return { suited: Math.round(suited), plain: Math.round(plain) }
  })
  // The ratio, not just "smaller": `SUIT_SPEED` is 0.62 and an unobstructed
  // run is exactly that, so this reads the constant off the board rather than
  // asserting the vague direction a typo would still satisfy.
  const ratio = speeds.plain ? speeds.suited / speeds.plain : 0
  check(
    'the suit walks at the speed it says it does, not just slower',
    speeds.plain > 40 && ratio > 0.55 && ratio < 0.7,
    JSON.stringify({ ...speeds, ratio: Math.round(ratio * 100) / 100 }),
  )

  // ------------------------------------------------- 3. the gun, and 4. the wire

  const gun = await page.evaluate(async () => {
    const g = window.__game
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    // A fresh suit, and a room with bots in it to shoot at.
    g.peers.clear()
    g.botsWanted = 3
    // The bots stand down while a human peer is in the room and come back a
    // moment after the room empties. Wait for one rather than reading an empty
    // list and reporting every check below as a failure of the gun.
    for (let i = 0; i < 120 && g.bots.length < 1; i++) await sleep(100)
    if (!g.bots.length) return { why: 'no bots came back to shoot at' }
    g.tank.dead = false
    g.tank.hp = g.maxHp
    g.suitUntil = performance.now() + 14_000
    const bot = g.bots[0]
    bot.tank.dead = false
    bot.tank.hp = 3
    bot.tank.x = g.tank.x + 120
    bot.tank.y = g.tank.y
    const sent = []
    const real = g.publishAsSession.bind(g)
    g.publishAsSession = (kind, payload) => { sent.push({ kind, payload }); return real(kind, payload) }
    // Hold the trigger on the bot, and keep it parked so this measures the gun
    // rather than its pathfinding.
    const aimAt = { x: bot.tank.x, y: bot.tank.y }
    const hp = []
    // Sampled inside the loop, not after it. The render loop calls `update`
    // with the *player's* controls — trigger up — on every frame it draws, so
    // `suitAt` after the last iteration is whatever the browser did last, not
    // what this test asked for. Reading it afterwards failed about one run in
    // three against a gun that was working perfectly.
    let aimed = false
    // Death is accumulated, not read at the end: a bot killed by the stream
    // respawns on full hull a couple of seconds later, and the last sample of a
    // loop this long can easily be the tank that came back.
    let killed = false
    for (let i = 0; i < 120; i++) {
      bot.tank.x = aimAt.x
      bot.tank.y = aimAt.y
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt, fire: true, reload: false, lob: false })
      aimed = aimed || !!g.suitAt
      killed = killed || bot.tank.dead
      hp.push(bot.tank.hp)
      await sleep(12)
    }
    g.publishState(performance.now())
    g.publishAsSession = real
    return {
      aimed,
      botHp: bot.tank.hp,
      botDead: killed,
      minHp: Math.min(...hp),
      // Shells are kind 21003; a suit that fired shells would show up here.
      shells: sent.filter((e) => e.kind === 21003).length,
      ticks: sent.filter((e) => e.kind === 21000).length,
      // Any tick that carried the aim, for the same reason: the ticks that go
      // out between the render loop's own updates legitimately have `j` and no
      // `jx`, because at that instant the trigger was up.
      lastTick:
        sent.filter((e) => e.kind === 21000 && e.payload?.jx !== undefined).slice(-1)[0]?.payload ??
        sent.filter((e) => e.kind === 21000).slice(-1)[0]?.payload ??
        null,
      ammo: g.tank.ammo,
    }
  })
  check('holding fire aims the guns somewhere', gun.aimed === true, gun.why ?? JSON.stringify(gun))
  check(
    'and the stream kills what it is held on',
    gun.botDead === true,
    JSON.stringify({ hp: gun.botHp, dead: gun.botDead }),
  )
  check(
    'without firing a single shell — the rounds are not on the wire',
    gun.shells === 0 && gun.ammo === 4,
    JSON.stringify({ shells: gun.shells, ammo: gun.ammo }),
  )
  check(
    'the suit rides the state tick: j, and where it is hosing',
    typeof gun.lastTick?.j === 'number' && gun.lastTick.j > 0 &&
      typeof gun.lastTick?.jx === 'number' && typeof gun.lastTick?.jy === 'number',
    JSON.stringify(gun.lastTick),
  )

  // -------------------------------------------- 5. somebody else's suit hurts us

  const theirs = await page.evaluate(async (PEER) => {
    const g = window.__game
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    g.suitUntil = 0
    g.suitAt = null
    g.tank.dead = false
    g.tank.hp = g.maxHp
    g.team = 0
    for (const k of Object.keys(g.buffs)) g.buffs[k] = 0
    // The bots from the previous section are still on the board and still
    // shooting, and a control that reads "we took damage" cannot tell their
    // shells from the suit's rounds — it failed three runs out of three for
    // exactly that reason. Clear the board so the only thing that can hurt us
    // is the thing under test.
    g.botsWanted = 0
    g.bots = []
    g.shells.clear()
    g.tank.x = 800
    g.tank.y = 800
    // Their tick: a suit, hosing the ground we are standing on.
    const tick = (jx, jy) => ({
      t: Date.now(), x: 700, y: 800, h: 0, g: 0, hp: 3, d: false,
      ks: 0, ds: 0, r: g.round, a: 4, j: 9000, jx, jy,
    })
    const send = (payload) =>
      g.onEvent({
        id: 's' + Math.random().toString(16).slice(2),
        pubkey: PEER, kind: 21000, created_at: Math.floor(Date.now() / 1000), tags: [],
        sig: '0'.repeat(128), content: JSON.stringify(payload),
      }, false)
    // A real peer publishes ten times a second, and so does this one. The first
    // cut sent four ticks and then ran a loop that takes several seconds under
    // a software rasteriser — their suit had expired long before the loop
    // ended, and the *last* sample said they were never wearing one.
    let sawSuit = false
    let sawAt = null
    for (let i = 0; i < 4; i++) { send(tick(800, 800)); await sleep(60) }
    const before = g.tank.hp
    for (let i = 0; i < 90; i++) {
      if (i % 8 === 0) send(tick(800, 800))
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
      // By *suit*, not by index. Bots have peer entries too, so `peers[0]` is
      // usually one of them — which is how this read "no suit anywhere" on a
      // client that was visibly taking damage from one.
      const p0 = [...g.peers.values()].find(
        (p) => p.view.suitUntil > performance.now() && p.view.suitAt,
      )
      if (p0) {
        sawSuit = true
        sawAt = { x: Math.round(p0.view.suitAt.x), y: Math.round(p0.view.suitAt.y) }
      }
      await sleep(12)
    }
    const hit = g.tank.hp < before || g.tank.dead
    // The control: the same suit hosing the far corner takes nothing off us.
    //
    // A *fresh* peer, after clearing the room, rather than turning the first
    // one away from us. Peer state is interpolated out of a buffer of past
    // ticks, so a suit that switches aim mid-stream keeps landing on us for as
    // long as the old samples are still being played out — the control failed
    // three runs in a row on damage from the case it was the control for.
    // Isolating it is both easier to reason about and the only version that
    // cannot be polluted by what came before.
    g.peers.clear()
    g.tank.dead = false
    for (let i = 0; i < 6; i++) { send(tick(200, 200)); await sleep(60) }
    let moved = false
    for (let i = 0; i < 40 && !moved; i++) {
      if (i % 4 === 0) send(tick(200, 200))
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
      const p = [...g.peers.values()].find((x) => x.view.suitAt)
      moved = !!p?.view.suitAt && p.view.suitAt.x < 600
      await sleep(20)
    }
    g.tank.hp = g.maxHp
    const before2 = g.tank.hp
    for (let i = 0; i < 90; i++) {
      if (i % 8 === 0) send(tick(200, 200))
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
      await sleep(12)
    }
    return {
      hit,
      missed: g.tank.hp === before2 && !g.tank.dead,
      moved,
      suited: sawSuit,
      at: sawAt,
    }
  }, PEER)
  check("a peer's suit is read off their tick", theirs.suited && !!theirs.at, JSON.stringify(theirs))
  check(
    'standing in their stream costs us hull — we apply it to ourselves',
    theirs.hit,
    JSON.stringify(theirs),
  )
  check(
    'the control: the same suit hosing the far corner does not',
    theirs.missed,
    JSON.stringify(theirs),
  )

  // ------------------------------------------------------------ 6. and it ends

  const ends = await page.evaluate(async () => {
    const g = window.__game
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    g.tank.dead = false
    g.tank.hp = g.maxHp
    g.suitUntil = performance.now() + 400
    g.suitAt = { x: 100, y: 100 }
    for (let i = 0; i < 60 && g.suited; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
      await sleep(40)
    }
    const afterClock = { suited: g.suited, at: g.suitAt }
    // And the other way out: dying in it.
    g.suitUntil = performance.now() + 14_000
    g.die('someone')
    return { afterClock, afterDeath: { suited: g.suited, at: g.suitAt } }
  })
  check(
    'the clock runs out and you are back in the tank',
    ends.afterClock.suited === false && ends.afterClock.at === null,
    JSON.stringify(ends.afterClock),
  )
  check(
    'and dying in it ends it too, rather than leaving a mech where the wreck is',
    ends.afterDeath.suited === false && ends.afterDeath.at === null,
    JSON.stringify(ends.afterDeath),
  )

  // The HUD says which of the two vehicles you are in.
  const hud = await page.evaluate(async () => {
    const g = window.__game
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    g.tank.dead = false
    g.suitUntil = performance.now() + 14_000
    for (let i = 0; i < 40; i++) {
      const n = document.getElementById('suit')
      if (n && !n.hidden) {
        const box = n.getBoundingClientRect()
        return { text: n.textContent ?? '', w: Math.round(box.width), h: Math.round(box.height) }
      }
      await sleep(80)
    }
    return null
  })
  check(
    'the HUD shows a juggernaut clock, on the glass',
    !!hud && /JUGGERNAUT/.test(hud.text) && hud.w > 100 && hud.h > 20,
    JSON.stringify(hud),
  )

  // -------------------- the hoses are rounds now, and you can hear them

  // A fresh peer suit hosing a fixed point, aimed away from us: the subject
  // is the picture and the sound, not the damage, and the peer's view state
  // persists on its own so the page's loop draws it without any manual
  // trigger-holding.
  await page.evaluate((PEER) => {
    const g = window.__game
    g.peers.clear()
    g.tank.dead = false
    g.tank.x = 1400
    g.tank.y = 200
    g.sfx = (name, opts) => {
      window.__sfxLog = window.__sfxLog ?? []
      window.__sfxLog.push({ name, at: opts?.at ?? null })
    }
    const send = () => g.onEvent({
      id: 's' + Math.random().toString(16).slice(2),
      pubkey: PEER, kind: 21000, created_at: Math.floor(Date.now() / 1000), tags: [],
      sig: '0'.repeat(128),
      content: JSON.stringify({
        t: Date.now(), x: 700, y: 800, h: 0, g: 0, hp: 3, d: false,
        ks: 0, ds: 0, r: g.round, a: 4, j: 9000, jx: 500, jy: 800,
      }),
    }, false)
    send()
    window.__keepSuit = setInterval(send, 120)
  }, PEER)
  const hose = await until(() => page.evaluate(() => {
    const stream = window.__renderer.suitStreamAt(0)
    if (!stream || !stream.visible) return null
    return { count: stream.count }
  }), 10_000)
  check('a hosing suit shows a stream of tracer rounds',
    !!hose && hose.count >= 6, JSON.stringify(hose))
  const hosePos = () => page.evaluate(() => {
    const stream = window.__renderer.suitStreamAt(0)
    if (!stream || !stream.visible) return null
    const m = stream.instanceMatrix.array
    return [0, 1, 2].map((i) => ({
      x: Math.round(m[i * 16 + 12]), y: Math.round(m[i * 16 + 13]), z: Math.round(m[i * 16 + 14]),
    }))
  })
  const hoseBefore = await hosePos()
  const hoseMoved = await until(async () => {
    const nowPos = await hosePos()
    if (!hoseBefore || !nowPos) return null
    const d = nowPos.map((q, i) =>
      Math.hypot(q.x - hoseBefore[i].x, q.y - hoseBefore[i].y, q.z - hoseBefore[i].z))
    return Math.max(...d) > 8 ? { d } : null
  }, 8000)
  check('and the rounds march between frames — the solid bar is gone',
    !!hoseMoved, JSON.stringify({ hoseBefore, hoseMoved }))
  // Polled, not slept: frames arrive four a second under a software
  // rasteriser and the tape delays the first one, so a fixed window measures
  // the environment. The claim is that rattles keep coming while it hoses.
  await until(() => page.evaluate(() =>
    ((window.__sfxLog ?? []).filter((e) => e.name === 'rattle').length >= 3) || null), 12_000)
  const hoseHeard = await page.evaluate(() => {
    clearInterval(window.__keepSuit)
    return (window.__sfxLog ?? []).filter((e) => e.name === 'rattle')
  })
  check('the hose rattles out of the sound sink, positioned at the suit',
    hoseHeard.length >= 3 &&
      hoseHeard.every((e) => e.at && Math.abs(e.at.x - 700) < 60 && Math.abs(e.at.y - 800) < 60),
    `${hoseHeard.length} rattles, first at ${JSON.stringify(hoseHeard[0]?.at)}`)
  await page.evaluate(() => { window.__game.sfx = () => {} })

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))

  if (process.env.TANK_SHOT) {
    await page.evaluate(() => {
      const g = window.__game
      g.tank.dead = false
      g.tank.hp = g.maxHp
      g.suitUntil = performance.now() + 14_000
      g.suitAt = { x: g.tank.x + 220, y: g.tank.y + 60 }
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
console.log('All juggernaut-suit checks passed.')
