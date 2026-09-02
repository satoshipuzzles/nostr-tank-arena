// The kill cam: the last couple of seconds, from behind whoever did it.
//
// Puzz: *"show a replay recording from the view of the player who killed you."*
//
// The claim that has to be proved is the one the word "replay" makes, and it is
// not "a camera moved". It is that **the board being drawn is the recorded one
// and not the live one** — so the load-bearing check here moves a peer *after*
// the death and requires their rig to stay where the tape says they were. A
// kill cam that quietly showed the present from a new angle would pass every
// other check in this file.
//
// The rest is restraint: a self-destruct has no camera to sit behind, a
// practice tank is not a killer worth a replay, nothing new goes on the wire
// while it runs, and it gives the camera back when it ends.
//
//   npm run build && npx vite preview --port 4370 &
//   npm run test:killcam

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4370/'
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

/** Put a peer on the board and let the tape fill with them on it. */
const arm = (seconds = 1.6) =>
  page.evaluate(
    async ({ PEER, seconds }) => {
      const g = window.__game
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
      const peer = g.ensurePeer(PEER)
      peer.name = 'Hardhat'
      g.tank.dead = false
      g.tank.hp = 3
      const steps = Math.round(seconds / 0.05)
      for (let i = 0; i < steps; i++) {
        peer.view.x = 400 + i * 8
        peer.view.y = 600
        peer.view.dead = false
        peer.lastSeen = performance.now()
        await sleep(50)
      }
      // Polled, not slept. The tape samples from the render loop, and how many
      // frames it holds after a fixed beat is a fact about how busy the machine
      // is — reported red on a loaded box while it was green on mine, which is
      // this fixture's window rather than the feature.
      //
      // And the peer stays *fresh* while we poll. This loop's length is also a
      // fact about the machine, and `lastSeen` was last touched up in the
      // movement loop above — on a loaded box the poll outlives
      // PEER_TIMEOUT_MS, the peer is pruned, the tape's final frames lose the
      // killer, and `killcamFrame` rightly refuses the replay. That was the
      // four-red run on clean main: the fixture letting its own actor expire,
      // not the feature.
      for (let i = 0; i < 60 && g.tape.length < 3; i++) {
        peer.lastSeen = performance.now()
        await sleep(100)
      }
      g.tank.x = 1100
      g.tank.y = 620
      return { tape: g.tape.length, peerAt: Math.round(peer.view.x) }
    },
    { PEER, seconds },
  )

const camState = () =>
  page.evaluate(() => {
    const r = window.__renderer
    const n = document.getElementById('death')
    return {
      fov: Math.round(r.camera.fov),
      y: Math.round(r.camera.position.y),
      replaying: !!n && n.classList.contains('replaying'),
      running: !!window.__game.killcam,
    }
  })

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'cam')
  await page.type('#room', 'cam' + Math.floor(Math.random() * 1e6))
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
  await wait(1000)

  // ------------------------------------------------------- 1. the tape itself

  const armed = await arm()
  check('the board is being recorded', armed.tape > 2, `${armed.tape} frames`)
  const bounded = await page.evaluate(() => {
    const g = window.__game
    const span = g.tape.length ? g.tape[g.tape.length - 1].t - g.tape[0].t : 0
    return { frames: g.tape.length, span: Math.round(span) }
  })
  check(
    'and the tape is a window, not a log of the whole round',
    bounded.span <= 3200,
    JSON.stringify(bounded),
  )

  // ----------------------------------------- 2. a kill books it, a mistake does not

  const booked = await page.evaluate(async (PEER) => {
    const g = window.__game
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    // The two preconditions the feature documents, checked against the live
    // tape rather than assumed from the fixture a few evaluates ago: at least
    // two frames (`die` refuses fewer — the playhead needs somewhere to walk
    // from), and the killer in the final frame (`killcamFrame` refuses a
    // camera with no subject). Both decay with time on a starved machine —
    // the 3-second trim can thin the tape to one frame across a long enough
    // frame gap, and a stale peer drops out of `record` — so they are held
    // true here, at the moment of death, not just at arm time.
    const peer = g.ensurePeer(PEER)
    peer.view.x = 640
    peer.view.y = 600
    peer.view.dead = false
    for (let i = 0; i < 50; i++) {
      peer.lastSeen = performance.now()
      const last = g.tape[g.tape.length - 1]
      if (g.tape.length >= 2 && last && last.tanks.some((t) => t.s === PEER)) break
      await sleep(100)
    }
    g.tank.dead = false
    g.tank.hp = 1
    g.die(PEER)
    g.tank.respawnAt = performance.now() + 60_000
    return { on: !!g.killcam, killer: g.killcam?.killer === PEER, frames: g.killcam?.frames.length ?? 0 }
  }, PEER)
  check('a kill by another player books a replay', booked.on && booked.killer, JSON.stringify(booked))

  // **The device-speed case, which the fixture above was hiding.**
  //
  // The tape samples from the render loop, so how many frames the last three
  // seconds hold is a fact about the machine: a phone at a few frames a second
  // has two or three, and a gate of "more than four" silently means no kill cam
  // for anybody on a slow device. Two frames is the real requirement — the
  // camera anchors on the last one and the playhead needs somewhere to walk
  // from — and this is the check that says so.
  const thin = await page.evaluate((PEER) => {
    const g = window.__game
    g.killcam = null
    g.tape.length = 0
    const now = performance.now()
    for (const t of [now - 400, now - 100]) {
      g.tape.push({
        t,
        tanks: [
          { s: g.identity.sessionPubkey, x: 1100, y: 620, hull: 0, gun: 0, dead: false },
          { s: PEER, x: 500, y: 600, hull: 0, gun: 0, dead: false },
        ],
        shells: [],
      })
    }
    g.tank.dead = false
    g.tank.hp = 1
    g.die(PEER)
    g.tank.respawnAt = performance.now() + 60_000
    return { frames: g.tape.length, booked: !!g.killcam }
  }, PEER)
  check(
    'a tape of two frames is still a replay — a slow device gets one too',
    thin.frames === 2 && thin.booked,
    JSON.stringify(thin),
  )

  const live = await until(async () => {
    const c = await camState()
    return c.fov > 60 ? c : null
  }, 6000)
  check('the replay takes the camera', !!live, JSON.stringify(live))
  check('and the death card steps out of the middle for it', live?.replaying === true, JSON.stringify(live))

  // ------------------------------- 3. the load-bearing one: it is a *replay*
  //
  // Move the killer somewhere else *now*. If the rig follows, this is a camera
  // trick over live state rather than a replay of the tape.
  const posed = await page.evaluate(async (PEER) => {
    const g = window.__game
    const r = window.__renderer
    const sleep = (ms) => new Promise((x) => setTimeout(x, ms))
    // Hold the replay open: a capture under a software rasteriser is most of a
    // second and the replay is two and a half.
    const hold = setInterval(() => { if (g.killcam) g.killcam.from = performance.now() - 600 }, 60)
    const peer = g.peers.get(PEER)
    // Every position the tape holds for them, not just the last one: the
    // playhead is somewhere in the middle of the replay, so the rig should be
    // at *a* recorded position. Comparing against the final frame alone fails
    // for the right reason and reads like the wrong one — measured 472 against
    // a taped 648 while the live tank was at 60, which is the replay working.
    const taped = g.killcam.frames
      .map((f) => f.tanks.find((t) => t.s === PEER))
      .filter(Boolean)
      .map((t) => ({ x: Math.round(t.x), y: Math.round(t.y) }))
    // Teleport them across the board, live.
    peer.view.x = 60
    peer.view.y = 60
    let rigAt = null
    for (let i = 0; i < 30; i++) {
      await sleep(80)
      const rig = r.rigs.get(PEER)
      if (rig) rigAt = { x: Math.round(rig.root.position.x), z: Math.round(rig.root.position.z) }
    }
    clearInterval(hold)
    return { taped, rigAt, live: { x: 60, y: 60 } }
  }, PEER)
  const onTape =
    !!posed.rigAt &&
    posed.taped.some(
      (t) => Math.abs(t.x - posed.rigAt.x) < 20 && Math.abs(t.y - posed.rigAt.z) < 20,
    )
  const atLive =
    !!posed.rigAt && Math.abs(posed.rigAt.x - posed.live.x) < 60 && Math.abs(posed.rigAt.z - posed.live.y) < 60
  check(
    'the killer is drawn where the tape says they were, not where they are now',
    onTape && !atLive,
    JSON.stringify({ rigAt: posed.rigAt, live: posed.live, taped: posed.taped.slice(-4) }),
  )

  // --------------------------------------------- 4. it ends, and gives it back

  const ended = await until(async () => {
    const c = await camState()
    return c.running === false ? c : null
  }, 8000)
  check('the replay ends on its own', !!ended, JSON.stringify(ended))
  check(
    'and the board camera comes back',
    ended && ended.fov <= 60 && ended.y > 400,
    JSON.stringify(ended),
  )

  // ----------------------- 4b. the respawn race, which is the shipped blue sky
  //
  // RESPAWN_DELAY is 2.5 seconds and KILLCAM_MS is 2500 — the same length — so
  // on a real death the respawn ends the replay, not the expiry: `respawn()`
  // calls `endKillcam` a frame or so before the playhead runs out. The first
  // ordinary frame then finds the tank already alive, so the `deaths()` rising
  // edge that would have set a shake never fires, and the shake path's
  // `lookAt(target)` — the accidental heal that makes the expiry path above
  // look fine — never runs. Position comes home every frame regardless, but
  // nothing re-aims: the camera sits at altitude pointed over the killer's
  // shoulder at the horizon. Sky, no board, until the view is toggled. That is
  // the bug as reported, and this section reproduces the *production* timing —
  // the sections above pin `respawnAt` sixty seconds out precisely so their
  // replay ends by expiry, which is how this stayed green while players saw
  // sky.
  const raced = await page.evaluate(async (PEER) => {
    const g = window.__game
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const peer = g.ensurePeer(PEER)
    peer.view.x = 640
    peer.view.y = 600
    peer.view.dead = false
    for (let i = 0; i < 50; i++) {
      peer.lastSeen = performance.now()
      const last = g.tape[g.tape.length - 1]
      if (g.tape.length >= 2 && last && last.tanks.some((t) => t.s === PEER)) break
      await sleep(100)
    }
    g.tank.dead = false
    g.tank.hp = 1
    // Spend the shake left over from the section above — its expiry-path
    // death set one, and at this machine's frame rate it may not have decayed
    // yet. Live shake re-aims the camera every frame, which would heal the
    // first restored frame here the way production, where a death's shake is
    // gone within half a second, never does.
    window.__renderer.shake = 0
    g.die(PEER) // respawnAt left alone: 2.5 seconds, the length of the replay
    const booked = !!g.killcam
    // The *first* restored frame, caught in the act rather than polled for: a
    // polling window either misses the frame on a slow machine or stays open
    // long enough to admit an accidental heal (a stray shake, a quality
    // drop's resize) that production does not get. The player sees whatever
    // that first frame rendered, so that frame is the claim.
    const r = window.__renderer
    const origDraw = r.draw.bind(r)
    let firstDot = null
    r.draw = (...a) => {
      const out = origDraw(...a)
      if (firstDot === null && !g.killcam) {
        const cam = r.camera
        const fwd = cam.getWorldDirection(cam.position.clone())
        const to = {
          x: r.target.x - cam.position.x,
          y: r.target.y - cam.position.y,
          z: r.target.z - cam.position.z,
        }
        const len = Math.hypot(to.x, to.y, to.z) || 1
        firstDot = +((fwd.x * to.x + fwd.y * to.y + fwd.z * to.z) / len).toFixed(3)
      }
      return out
    }
    for (let i = 0; i < 200 && firstDot === null; i++) await sleep(80)
    r.draw = origDraw
    return { booked, alive: !g.tank.dead, dot: firstDot }
  }, PEER)
  check(
    'a respawn that ends the replay still gives the board back, aimed at the board',
    raced.booked && raced.alive && raced.dot > 0.999,
    JSON.stringify(raced),
  )

  // ------------------------------------------ 5. the cases that get no replay

  const selfKill = await page.evaluate(() => {
    const g = window.__game
    g.killcam = null
    g.tank.dead = false
    g.tank.hp = 1
    g.die(null)
    g.tank.respawnAt = performance.now() + 60_000
    return !!g.killcam
  })
  check('blowing yourself up gets no replay — there is nobody to sit behind', selfKill === false)

  const botKill = await page.evaluate(async () => {
    const g = window.__game
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    g.killcam = null
    // The fixture peer has to be gone first: bots stand down — all of them —
    // while anybody real is in the room, and how stale the peer is by now is a
    // fact about how long the sections above took on this machine.
    g.peers.clear()
    g.botsWanted = 1
    for (let i = 0; i < 60 && !g.bots.length; i++) await sleep(100)
    if (!g.bots.length) return { why: 'no bots' }
    g.tank.dead = false
    g.tank.hp = 1
    g.die(g.bots[0].session)
    g.tank.respawnAt = performance.now() + 60_000
    return { on: !!g.killcam }
  })
  check(
    'and a practice tank does not get one either — its kill costs nothing and shows nothing',
    botKill.on === false,
    JSON.stringify(botKill),
  )

  // --------------------------------- 6. nothing new goes on the wire for any of it

  const wire = await page.evaluate(async (PEER) => {
    const g = window.__game
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    g.botsWanted = 0
    g.bots = []
    const kinds = []
    const real = g.publishAsSession.bind(g)
    g.publishAsSession = (kind, payload) => { kinds.push(kind); return real(kind, payload) }
    g.tank.dead = false
    g.tank.hp = 1
    g.die(PEER)
    g.tank.respawnAt = performance.now() + 60_000
    await sleep(2600)
    g.publishAsSession = real
    // 21000 is the state tick and 21002 is the death itself. Anything else
    // would be a replay paying for itself in traffic, which is the design this
    // deliberately did not take.
    return { kinds: [...new Set(kinds)].sort() }
  }, PEER)
  check(
    'the replay publishes nothing — it is a local recording, not a broadcast',
    wire.kinds.every((k) => k === 21000 || k === 21002),
    JSON.stringify(wire.kinds),
  )

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
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
console.log('All kill-cam checks passed.')
