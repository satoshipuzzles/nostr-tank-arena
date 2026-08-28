// Cover that gets messed up, and remains that stay.
//
// Puzz: "damage to walls should be designed and function better, we want to see
// them get messed up with each shot and eventual break but not completely
// disappear — the walls should break eventually but the remains should stay."
//
// Two halves, and they fail in different ways:
//
//   1. **The picture.** Every claim here is measured off the scene graph — the
//      material's colour, the mesh's height, the bounding box of the pile —
//      because this repo has shipped meshes that were `visible === true` for
//      weeks while drawn inside the floor. "There is a rubble mesh" is not the
//      claim; "the pile is short and it is where the crate was" is.
//   2. **The wire.** A crate that looks battered only to the player who did it
//      is two boards again. The damage tiers ride their own field on the state
//      tick and union exactly as the destroyed mask does, so these drive a peer
//      tick in and read our own tick out, and check that a *lower* incoming
//      tier cannot walk one backwards.
//
// The damage itself goes through `damageCover`, which is the same function the
// shell path calls — test/barrels.mjs and test/barrels-browser.mjs already
// prove a real shell gets there, and re-proving it here would be a claim about
// lane-finding rather than about rubble.
//
//   npm run build && npx vite preview --port 4211 &
//   npm run test:rubble

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4211/'
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
async function until(fn, ms = 12_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await wait(90)
  }
  return null
}

const PEER = 'e5'.repeat(32)
// Pinned, because the board — and therefore how much breakable cover exists —
// comes from the block hash. A suite that reads the live tip is a suite that
// passes on a Monday.
const HASH = 'ab'.repeat(30) + '0300'
const WALL_H = 58

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

/** Every breakable, as the *scene* has it. */
const board = () =>
  page.evaluate(() => {
    const a = window.__arena
    const r = window.__renderer
    return a.BREAKABLE.map((b) => {
      const mesh = r.coverMeshAt(b.id)
      const rubble = r.rubbleMeshAt(b.id)
      // The geometry's own bounds rather than a Box3 walk of the scene: the
      // mesh is unscaled and sits at the rect's centre, so local bounds are
      // the pile's real size and this needs nothing from three at all.
      if (rubble) rubble.geometry.computeBoundingBox()
      const box = rubble ? rubble.geometry.boundingBox : null
      return {
        id: b.id,
        kind: b.kind,
        hp: b.hp,
        gone: !!b.gone,
        tier: a.damageTier(b),
        mesh: mesh
          ? {
              visible: mesh.visible,
              y: Number(mesh.position.y.toFixed(3)),
              lean: Number(mesh.rotation.z.toFixed(4)),
              colour: mesh.material.color.getHex(),
              rough: Number(mesh.material.roughness.toFixed(3)),
            }
          : null,
        rubble: rubble
          ? {
              visible: rubble.visible,
              height: box ? Number((box.max.y - box.min.y).toFixed(2)) : null,
              cx: Math.round(rubble.position.x),
              cz: Math.round(rubble.position.z),
              tris: rubble.geometry.attributes.position.count,
            }
          : null,
        centre: { x: Math.round(b.x + b.w / 2), z: Math.round(b.y + b.h / 2) },
      }
    })
  })

const at = (rows, id) => rows.find((b) => b.id === id)

/**
 * Wait for the *scene* to say something, not the model.
 *
 * Every early failure in this file was the same mistake: `damageCover` moves
 * the rect synchronously, so polling `b.tier` returns true on the first sample
 * and hands back a snapshot of a frame the renderer has not drawn yet. The
 * whole point of this suite is the view, so every wait here has to be a
 * predicate about the view.
 */
const untilBoard = (fn, ms = 12_000) =>
  until(async () => {
    const rows = await board()
    return fn(rows) ? rows : null
  }, ms)

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'rubble')
  await page.type('#room', 'rub' + Math.floor(Math.random() * 1e6))
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
    g.botsEnabled = false
    g.bots = []
    // And force the board, rather than trusting that our fake tip beat the
    // real one. `main.ts` picks the layout off the clock, so a live block that
    // landed in the moment between "the game started" and this line would have
    // left us on a different map with a different amount of breakable cover.
    window.__arena.setLayout(window.__arena.layoutForBlock(hash))
    document.getElementById('podium').hidden = true
  }, HASH)
  await wait(1000)

  const start = await board()
  check('the pinned board has breakable cover on it', start.length >= 2, `${start.length} pieces`)
  if (!start.length) throw new Error('no breakable cover on the pinned board')

  // A crate if the board has one — eight hits gives every tier room to show —
  // and whatever else is there if it does not.
  const target = (start.find((b) => b.kind === 'crate') ?? start[0]).id
  const bystander = start.find((b) => b.id !== target)?.id ?? null
  check('there is a second piece to use as a control', bystander !== null)

  // ------------------------------------------------------ 1. it starts clean

  check(
    'nothing is damaged, sunk or leaning to start with',
    start.every((b) => b.tier === 0 && b.mesh.y === 0 && b.mesh.lean === 0),
    JSON.stringify(start.map((b) => [b.id, b.tier, b.mesh.y, b.mesh.lean])),
  )
  check(
    'and no rubble is on the board',
    start.every((b) => b.rubble && b.rubble.visible === false),
    JSON.stringify(start.map((b) => [b.id, b.rubble?.visible])),
  )
  check(
    'the piles exist and have geometry in them, hidden or not',
    start.every((b) => (b.rubble?.tris ?? 0) > 12),
    JSON.stringify(start.map((b) => b.rubble?.tris)),
  )

  // --------------------------------------------- 2. each hit shows on the box

  const clean = at(start, target)
  const steps = []
  // Zero, not -1. With -1 the first step's predicate was satisfied by the
  // *unpainted* frame it started from, which is how "one hit is already
  // visible" read a clean crate and called it damaged.
  let lastLean = 0
  for (const hits of [1, 3, 6]) {
    await page.evaluate(
      ([id, n]) => {
        const a = window.__arena
        const w = a.WALLS[id]
        // Back to full first, so each step is "n hits from new" rather than a
        // running total — the tiers are a fraction of hp lost, and a test that
        // accumulated would be asserting arithmetic it did itself.
        w.hp = w.kind === 'crate' ? a.CRATE_HP : a.BARREL_HP
        w.gone = false
        w.dmg = 0
        a.damageCover(id, n)
      },
      [target, hits],
    )
    // Wait for the *lean* to move past the previous step's, which is a
    // property only the drawn mesh has. Waiting on the tier would return the
    // frame before the repaint, which is exactly what it did the first time.
    const rows = await untilBoard((r) => at(r, target).mesh.lean > lastLean)
    if (!rows) throw new Error(`the mesh never repainted after ${hits} hits`)
    lastLean = at(rows, target).mesh.lean
    steps.push({ hits, ...at(rows, target) })
  }

  check(
    'one hit is already visible on the crate',
    steps[0].tier >= 1 && steps[0].mesh.colour !== clean.mesh.colour,
    JSON.stringify({ tier: steps[0].tier, from: clean.mesh.colour, to: steps[0].mesh.colour }),
  )
  check(
    'and it gets worse with every few more, never better',
    steps[0].tier < steps[1].tier && steps[1].tier < steps[2].tier,
    JSON.stringify(steps.map((s) => [s.hits, s.tier])),
  )
  check(
    'the damage is legible as a silhouette, not only as a colour',
    steps[0].mesh.y > steps[1].mesh.y && steps[1].mesh.y > steps[2].mesh.y &&
      steps[0].mesh.lean < steps[1].mesh.lean && steps[1].mesh.lean < steps[2].mesh.lean,
    JSON.stringify(steps.map((s) => [s.hits, s.mesh.y, s.mesh.lean])),
  )
  check(
    'and it goes darker and rougher rather than only moving',
    steps[2].mesh.colour < clean.mesh.colour && steps[2].mesh.rough > clean.mesh.rough,
    JSON.stringify({ clean: clean.mesh, worst: steps[2].mesh }),
  )

  // The control, and it is the important one: a per-rect material was the whole
  // reason for cloning. If the crates shared one, hitting this one would have
  // scorched every crate on the board.
  const withBystander = await board()
  const other = at(withBystander, bystander)
  check(
    'the control: the piece nobody shot is untouched',
    other.tier === 0 && other.mesh.y === 0 && other.mesh.lean === 0,
    JSON.stringify(other.mesh),
  )
  if (other.kind === clean.kind) {
    check(
      'and its material was not dragged down with the one that was hit',
      other.mesh.colour === clean.mesh.colour,
      `${other.mesh.colour} against a clean ${clean.mesh.colour}`,
    )
  }

  // ------------------------------------------ 3. it breaks and leaves remains

  await page.evaluate((id) => window.__arena.damageCover(id, 99), target)
  const broken = await untilBoard((r) => at(r, target).mesh.visible === false)
  if (!broken) throw new Error('the broken crate never left the screen')
  const wreck = at(broken, target)
  check('enough hits break it', wreck.gone === true && wreck.mesh.visible === false,
    JSON.stringify({ gone: wreck.gone, visible: wreck.mesh.visible }))
  check('and the remains stay on the board', wreck.rubble.visible === true)
  check(
    'the pile is where the crate was',
    wreck.rubble.cx === wreck.centre.x && wreck.rubble.cz === wreck.centre.z,
    JSON.stringify({ pile: [wreck.rubble.cx, wreck.rubble.cz], rect: [wreck.centre.x, wreck.centre.z] }),
  )
  // The thing that makes rubble rubble rather than a shorter wall: a hull can
  // drive over it and a shell goes straight through the space above it.
  check(
    'and it is debris, not a low wall',
    wreck.rubble.height > 1 && wreck.rubble.height < WALL_H * 0.5,
    `${wreck.rubble.height} units against a ${WALL_H}-unit wall`,
  )

  // Breaking it must not have changed what the *rules* say about that ground.
  // Rubble is cosmetic, deliberately — see the comment on `RUBBLE_H`.
  const passable = await page.evaluate((id) => {
    const a = window.__arena
    const w = a.WALLS[id]
    const cx = w.x + w.w / 2
    const cy = w.y + w.h / 2
    return { tank: a.pointInWall(cx, cy)?.id ?? null, shell: a.pointInTallWall(cx, cy)?.id ?? null }
  }, target)
  check(
    'the lane is open — rubble stops neither a tank nor a shell',
    passable.tank === null && passable.shell === null,
    JSON.stringify(passable),
  )

  // ------------------------------------------------ 3b. and it slows you down
  //
  // Puzz, after the cosmetic version shipped: "we want rubble to slow a tank
  // crossing it." So the lane is open and it costs something to take.
  //
  // Measured by stepping the tank from the same spot the same number of times
  // and summing how far each step carried it — position reset between steps so
  // the tank stays *on* the debris rather than driving off it after 3px and
  // averaging in open ground. The comparison point is real open ground on the
  // same board, so this is a ratio between two measurements rather than a
  // number checked against a constant the code also owns.

  const drag = await page.evaluate((id) => {
    const a = window.__arena
    const g = window.__game
    const w = a.WALLS[id]
    const on = { x: w.x + w.w / 2, y: w.y + w.h / 2 }

    // Somewhere with nothing on it at all, found rather than assumed.
    let clear = null
    for (let gx = 200; gx < 1600 && !clear; gx += 40) {
      for (let gy = 200; gy < 900; gy += 40) {
        if (!a.pointInWall(gx, gy) && !a.pointInRubble(gx, gy)) {
          clear = { x: gx, y: gy }
          break
        }
      }
    }
    if (!clear) return null

    const controls = (throttle, steer) => ({
      throttle, steer, aim: null, aimAt: null, fire: false, reload: false, lob: false,
    })
    const measure = (at, throttle, steer) => {
      g.tank.dead = false
      let moved = 0
      let turned = 0
      for (let i = 0; i < 24; i++) {
        g.tank.x = at.x
        g.tank.y = at.y
        g.tank.hull = 0
        g.update(0.016, controls(throttle, steer))
        moved += Math.hypot(g.tank.x - at.x, g.tank.y - at.y)
        turned += Math.abs(g.tank.hull)
      }
      return { moved, turned }
    }

    return {
      on: measure(on, 1, 0),
      clear: measure(clear, 1, 0),
      onTurn: measure(on, 0, 1),
      clearTurn: measure(clear, 0, 1),
      where: { on, clear },
      // What the arena itself says, so a failure can be read without guessing
      // whether the tank was standing where the test thought it was.
      onRubble: !!a.pointInRubble(on.x, on.y),
      clearRubble: !!a.pointInRubble(clear.x, clear.y),
    }
  }, target)

  check('there is open ground on this board to compare against', drag !== null)
  check(
    'the control: one measurement is on the debris and the other is not',
    drag?.onRubble === true && drag?.clearRubble === false,
    JSON.stringify({ on: drag?.onRubble, clear: drag?.clearRubble }),
  )
  const ratio = drag ? drag.on.moved / drag.clear.moved : 0
  check(
    'crossing rubble is slower than crossing grass',
    ratio > 0.4 && ratio < 0.75,
    `${(ratio * 100).toFixed(0)}% of open-ground speed (${drag?.on.moved.toFixed(1)} against ${drag?.clear.moved.toFixed(1)})`,
  )
  // The other half of the design, and the half that would read as a bug: a
  // tank that cannot turn on debris looks broken rather than slowed.
  check(
    'but turning is not slowed with it',
    !!drag && Math.abs(drag.onTurn.turned - drag.clearTurn.turned) < 1e-6,
    JSON.stringify({ on: drag?.onTurn.turned, clear: drag?.clearTurn.turned }),
  )
  // And the lane is still a lane: a shell goes through the space above it.
  const stillOpen = await page.evaluate((id) => {
    const a = window.__arena
    const w = a.WALLS[id]
    const cx = w.x + w.w / 2
    const cy = w.y + w.h / 2
    return {
      tank: a.pointInWall(cx, cy)?.id ?? null,
      shell: a.pointInTallWall(cx, cy)?.id ?? null,
      rubble: a.pointInRubble(cx, cy)?.id ?? null,
      passing: a.passing(w),
    }
  }, target)
  check(
    'slowing a tank did not close the lane for a shell',
    stillOpen.shell === null && stillOpen.tank === null && stillOpen.rubble === target &&
      stillOpen.passing === 'rubble',
    JSON.stringify(stillOpen),
  )

  // ------------------------------------------------------------- 4. the wire

  const ourBits = await page.evaluate(() => ({
    dmg: window.__arena.coverDamageBits(),
    gone: window.__arena.coverBits(),
  }))
  check('our own damage is on the mask', ourBits.dmg > 0, JSON.stringify(ourBits))

  // What we actually put on the tick, not what the encoder would have said if
  // asked. Wrapping the publisher is the only way to read the frame itself.
  const sent = await page.evaluate(async () => {
    const g = window.__game
    const seen = []
    const real = g.publishAsSession.bind(g)
    g.publishAsSession = (kind, payload) => {
      seen.push({ kind, payload })
      return real(kind, payload)
    }
    g.publishState(performance.now())
    g.publishAsSession = real
    return seen
  })
  const tick = sent.find((s) => s.payload && typeof s.payload.t === 'number')
  check(
    'and it rides the state tick, in its own field',
    typeof tick?.payload?.cd === 'number' && tick.payload.cd > 0,
    JSON.stringify({ b: tick?.payload?.b, cd: tick?.payload?.cd }),
  )

  // Somebody else's damage, on a piece we have not touched.
  const beforePeer = await board()
  const peerTarget = beforePeer.find((b) => b.id !== target && !b.gone)?.id ?? null
  check('there is an untouched piece to damage from the wire', peerTarget !== null)
  const peerTick = (cd) =>
    page.evaluate(
      ([PEER, cd]) => {
        const g = window.__game
        g.onEvent({
          id: 'a' + Math.random().toString(16).slice(2),
          pubkey: PEER, kind: 21000, created_at: Math.floor(Date.now() / 1000), tags: [],
          sig: '0'.repeat(128),
          content: JSON.stringify({
            t: Date.now(), x: 400, y: 400, hp: 5, r: g.round, cd,
          }),
        }, false)
      },
      [PEER, cd],
    )

  // Tier 2 on the peer target, thermometer-coded the way the encoder does it.
  const slot = await page.evaluate((id) => window.__arena.BREAKABLE.findIndex((b) => b.id === id), peerTarget)
  await peerTick(0b011 << (slot * 3))
  const afterPeer = await untilBoard((r) => at(r, peerTarget).mesh.lean > 0)
  check(
    "a peer's damage lands on our board too",
    !!afterPeer && at(afterPeer, peerTarget).tier === 2,
    JSON.stringify(afterPeer ? at(afterPeer, peerTarget).tier : null),
  )
  check(
    'and it repaints, rather than only moving a number',
    !!afterPeer && at(afterPeer, peerTarget).mesh.lean > 0,
    JSON.stringify(afterPeer ? at(afterPeer, peerTarget).mesh : null),
  )

  // The union property, in the direction that matters. A client whose own
  // simulation missed two hits must not be able to un-damage a crate under
  // somebody who has already seen it splinter.
  await peerTick(0b001 << (slot * 3))
  await wait(400)
  const afterLower = await board()
  check(
    'a lower tier from a laggier client cannot walk it back',
    at(afterLower, peerTarget).tier === 2,
    `still ${at(afterLower, peerTarget).tier}`,
  )
  // And the same bits twice are worth nothing, which is what makes a lost tick
  // free rather than a resync.
  await peerTick(0b011 << (slot * 3))
  await wait(300)
  check(
    'and the same tick twice changes nothing',
    at(await board(), peerTarget).tier === 2,
  )

  // An old client sends `b` and no `cd` at all. It has to keep working.
  const survives = await page.evaluate((PEER) => {
    const g = window.__game
    g.onEvent({
      id: 'a' + Math.random().toString(16).slice(2),
      pubkey: PEER, kind: 21000, created_at: Math.floor(Date.now() / 1000), tags: [],
      sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), x: 410, y: 410, hp: 5, r: g.round, b: 0 }),
    }, false)
    return true
  }, PEER)
  check('a tick from a client that has never heard of damage tiers is fine', survives === true)

  // ------------------------------------------------------- 5. the round ends

  await page.evaluate((hash) => {
    window.__arena.resetCover()
    window.__game.beginRound(900001, hash)
  }, 'cd'.repeat(30) + '0400')
  // Again the view: `resetCover` clears the rects immediately, and the frame
  // that puts the meshes back is the thing being tested.
  const fresh = await untilBoard((r) => r.every((b) => b.mesh.visible && !b.rubble.visible))
  check('a new block puts every piece back', !!fresh, JSON.stringify(fresh?.map((b) => b.gone)))
  check(
    'the scuffs go with them — nothing inherits last round’s damage',
    !!fresh && fresh.every((b) => b.tier === 0 && b.mesh.y === 0 && b.mesh.lean === 0),
    JSON.stringify(fresh?.map((b) => [b.id, b.tier, b.mesh.y])),
  )
  check(
    'and the rubble is cleared off the board',
    !!fresh && fresh.every((b) => b.rubble.visible === false),
    JSON.stringify(fresh?.map((b) => b.rubble.visible)),
  )
  check(
    'the material is back to exactly what it was, not approximately',
    !!fresh && at(fresh, target).mesh.colour === clean.mesh.colour &&
      at(fresh, target).mesh.rough === clean.mesh.rough,
    JSON.stringify({ now: at(fresh ?? [], target)?.mesh, was: clean.mesh }),
  )

  // ------------------------------------------- 6. every pile, on every board
  //
  // The check above passes on the pinned board whether or not the height cap
  // exists — I removed the cap on purpose and it stayed green, because this
  // board's crates are small. The cap only bites on a *long* rect, where
  // tipping a 120-unit chunk lifts its corner three times the height it was
  // built at, and which boards have long crates is a property of the layouts.
  //
  // So: walk them all. This is the check that would have caught the 59-unit
  // pile the first version of `rubbleParts` produced.
  const boards = await page.evaluate(() => window.__arena.LAYOUTS.map((l) => l.name))
  const tall = await page.evaluate(() => {
    const a = window.__arena
    const r = window.__renderer
    const bad = []
    const was = a.currentLayoutIndex()
    // Every board, not the first eight. This was written when eight was all
    // there were, and it stayed a literal through the terrain pass and the
    // themed boards — so the two tallest-cover layouts in the game were never
    // in it and the label said they were.
    for (let i = 0; i < a.LAYOUTS.length; i++) {
      a.setLayout(i)
      for (const b of a.BREAKABLE) {
        const mesh = r.rubbleMeshAt(b.id)
        if (!mesh) {
          bad.push({ layout: i, id: b.id, why: 'no pile at all' })
          continue
        }
        mesh.geometry.computeBoundingBox()
        const top = mesh.geometry.boundingBox.max.y
        if (top > 16.01) bad.push({ layout: i, id: b.id, top: Number(top.toFixed(2)) })
      }
    }
    a.setLayout(was)
    return bad
  })
  check(
    'no pile on any board in the rotation stands taller than a hull',
    tall.length === 0,
    tall.length ? JSON.stringify(tall.slice(0, 5)) : `${boards.length} boards checked`,
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
console.log('All rubble checks passed.')
