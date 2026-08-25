// Holding ground, with nobody to referee it.
//
// Puzz asked about "taking over a territory" while describing team deathmatch.
// That is this mode, and it is the one of the three that fits this game's
// netcode best — because ownership is **derived rather than published**.
//
// Every client already receives every tank's position ten times a second. Who
// is standing on a point is a function of that stream and nothing else, so
// nobody sends "I took point B": each client works it out from the same inputs
// and reaches the same answer. That is the rule the map and the pickup schedule
// already run on, and it is what the first half of this suite is about — the
// same inputs in a different order give the same result, and two clients a
// tenth of a second apart disagree about *when* and never about *what*.
//
// The second half is the rules, and each has a control, because most of them
// are decisions rather than arithmetic: a drive-by must not flip a point, a
// contested point must stall rather than reverse, and stepping off for a moment
// must not throw the progress away.
//
//   npm run test:domination

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const out = join(mkdtempSync(join(tmpdir(), 'dom-')), 'dom.mjs')
await build({
  entryPoints: ['test/domination-entry.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'error',
})
const {
  CAPTURE_S, POINT_COUNT, POINT_RADIUS,
  freshState, heldBy, holderOn, onPoint, points, stepPoint,
  setLayout, pointInWall, ARENA_W, ARENA_H,
} = await import(out)

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

// ------------------------------------------------------------------ the board

{
  const counts = []
  const clearances = []
  const buried = []
  for (let i = 0; i < 8; i++) {
    setLayout(i)
    const ps = points()
    counts.push(ps.length)
    buried.push(ps.filter((p) => pointInWall(p.x, p.y)).length)
    let closest = Infinity
    for (let a = 0; a < ps.length; a++) {
      for (let b = a + 1; b < ps.length; b++) {
        closest = Math.min(closest, Math.hypot(ps[a].x - ps[b].x, ps[a].y - ps[b].y))
      }
    }
    clearances.push(ps.length > 1 ? Math.round(closest) : 0)
  }
  check('every board has points', counts.every((c) => c === POINT_COUNT), JSON.stringify(counts))
  check('the control: and none of them is inside the scenery',
    buried.every((b) => b === 0), JSON.stringify(buried))
  // Overlapping points would let one tank hold two, which is not a mode.
  check('the control: and no two overlap, so one tank cannot hold two',
    clearances.every((c) => c > 2 * POINT_RADIUS), JSON.stringify(clearances))
  // Odd, on purpose. Two sides cannot split three evenly, so somebody is always
  // behind and somebody always has to move.
  check('there is an odd number of them, so a stalemate is not a resting state',
    POINT_COUNT % 2 === 1, String(POINT_COUNT))
  setLayout(0)
}

const P = { i: 0, x: 800, y: 600 }
const tank = (x, y, team, dead = false) => ({ x, y, team, dead })

// ----------------------------------------------------------- who is standing

{
  check('a tank on the point is on it', onPoint(P, tank(800, 600, 1)))
  check('and one just inside the radius is too', onPoint(P, tank(800 + POINT_RADIUS - 4, 600, 1)))
  check('the control: one just outside is not',
    onPoint(P, tank(800 + POINT_RADIUS + 4, 600, 1)) === false)
  // Radial, not a box: the corner of the bounding square is outside the circle,
  // and a square would quietly make every point 40% wider on the diagonal.
  const d = POINT_RADIUS * 0.78
  check('the control: and the corner of the box is not the edge of the circle',
    onPoint(P, tank(800 + d, 600 + d, 1)) === false,
    `${Math.round(Math.hypot(d, d))} out against a ${POINT_RADIUS} radius`)
  check('the control: a dead tank holds nothing', onPoint(P, tank(800, 600, 1, true)) === false)
}

// ------------------------------------------------------------- who holds it

{
  check('one side alone holds it', holderOn(P, [tank(800, 600, 1)]) === 1)
  check('two of the same side still hold it',
    holderOn(P, [tank(800, 600, 1), tank(820, 610, 1)]) === 1)
  // Contested is nobody, not "whoever brought more". A headcount would let a
  // duo walk a point out from under a lone defender without shooting them,
  // which turns the mode into a race rather than a fight over ground.
  check('the control: two sides on it is a fight, not a majority',
    holderOn(P, [tank(800, 600, 1), tank(810, 605, 2), tank(815, 602, 1)]) === 0)
  check('the control: an empty point is held by nobody', holderOn(P, []) === 0)
  // A tank on nobody's side is ignored rather than treated as a third party,
  // or standing still in a free-for-all would freeze the mode for everyone.
  check('the control: a tank with no side does not contest it',
    holderOn(P, [tank(800, 600, 1), tank(805, 601, 0)]) === 1)
  check('the control: and cannot take it either', holderOn(P, [tank(800, 600, 0)]) === 0)
}

// ------------------------------------------------------------- taking one

const run = (s, holder, seconds, dt = 1 / 60) => {
  let took = 0
  for (let t = 0; t < seconds; t += dt) took = stepPoint(s, holder, dt) || took
  return took
}

{
  const s = freshState()
  const early = run(s, 1, CAPTURE_S - 0.5)
  check(`nothing turns before ${CAPTURE_S} seconds`, early === 0 && s.owner === 0,
    JSON.stringify(s))
  const took = run(s, 1, 0.7)
  check('and it turns once the time is up', took === 1 && s.owner === 1, JSON.stringify(s))
  check('the control: and the progress resets rather than carrying over',
    s.progress === 0 && s.taking === 0, JSON.stringify(s))

  // The owner standing on their own point is not a job.
  const before = { ...s }
  run(s, 1, 2)
  check('the control: holding a point you already own does nothing',
    s.owner === before.owner && s.progress === 0, JSON.stringify(s))

  // And the other side has to do the whole three seconds to take it back.
  const back = run(s, 2, CAPTURE_S - 0.5)
  check('the control: and the other side does not get it for free',
    back === 0 && s.owner === 1, JSON.stringify(s))
  const flipped = run(s, 2, 0.7)
  check('but does take it if they stay', flipped === 2 && s.owner === 2, JSON.stringify(s))
}

// ------------------------------------------------- a drive-by does not flip it

{
  const s = freshState()
  // Two seconds on, then off — the shape of driving across a point.
  run(s, 1, 2)
  const partial = s.progress
  run(s, 0, 0.4)
  check('stepping off decays the progress rather than binning it',
    s.progress > 0 && s.progress < partial, `${partial.toFixed(2)} -> ${s.progress.toFixed(2)}`)
  run(s, 0, 5)
  check('the control: and long enough away, it is gone',
    s.progress === 0 && s.taking === 0 && s.owner === 0, JSON.stringify(s))
}

// ------------------------------------------------ contested stalls, not resets

{
  const s = freshState()
  run(s, 1, 2)
  const held = s.progress
  run(s, 0, 0) // no-op, keeps the shape of the test honest
  // Contested: `holderOn` returns 0, so this is the same call as empty — which
  // is why the decay above is a *decay* rather than a reset. A point you nearly
  // took stays nearly taken while you fight over it.
  run(s, 0, 0.3)
  check('a contested point keeps most of its progress',
    s.progress > held - 0.5 && s.progress < held, `${held.toFixed(2)} -> ${s.progress.toFixed(2)}`)
}

// ------------------------------------------------------------- convergence

{
  // The claim the whole design rests on: two clients reading the same positions
  // reach the same owner, whatever order they read them in and whatever frame
  // rate they run at.
  const occupants = [tank(800, 600, 2), tank(790, 610, 2), tank(1400, 200, 1)]
  const forward = holderOn(P, occupants)
  const backward = holderOn(P, [...occupants].reverse())
  check('two clients that read the tanks in different orders agree',
    forward === backward && forward === 2, `${forward} vs ${backward}`)

  // And different frame rates reach the same outcome, because progress is
  // accumulated in seconds rather than in frames.
  const fast = freshState()
  const slow = freshState()
  run(fast, 1, CAPTURE_S + 0.2, 1 / 120)
  run(slow, 1, CAPTURE_S + 0.2, 1 / 20)
  check('and a 120fps client and a 20fps one both end up owning it',
    fast.owner === 1 && slow.owner === 1, JSON.stringify({ fast: fast.owner, slow: slow.owner }))

  // The control: a client that only watched half as long has *not* taken it,
  // which is what makes the check above about the rate rather than about
  // `stepPoint` returning 1 whatever you feed it.
  const half = freshState()
  run(half, 1, CAPTURE_S / 2, 1 / 60)
  check('the control: and one that watched half as long has not',
    half.owner === 0, JSON.stringify(half))
}

// ------------------------------------------------------------------ the tally

{
  const states = [
    { owner: 1, taking: 0, progress: 0 },
    { owner: 2, taking: 0, progress: 0 },
    { owner: 1, taking: 0, progress: 0 },
  ]
  const by = heldBy(states)
  check('the tally counts points per side', by.get(1) === 2 && by.get(2) === 1,
    JSON.stringify([...by]))
  check('the control: and a neutral point belongs to nobody',
    heldBy([freshState()]).size === 0)
}

void ARENA_W
void ARENA_H

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall good')
process.exit(failures.length ? 1 : 0)
