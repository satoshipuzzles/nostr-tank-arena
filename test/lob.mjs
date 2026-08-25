// Lobbed shots.
//
// Puzz: "Hold Q to lob shots over obstacles. (different on controllers)"
//
// Three claims worth proving, and they are not the same claim:
//
//   1. The shell goes *over* a wall a flat shell dies on. This is the feature.
//   2. Every client puts the crater in the same place. A lob's range comes from
//      how long one player held a key, which nobody else can observe, so it has
//      to ride the fire event — this is the check that would catch it being
//      recomputed locally.
//   3. A lob that finished its flight while the event was in the air still goes
//      off. That path is invisible on a fast connection and is the one a real
//      player on a slow relay lives in.
//
// The arithmetic lives in `sim.ts`, so most of this runs in Node against the
// built module rather than in a browser. The one thing Node cannot answer —
// does the arc reach a pixel — is the screenshot in test/lob-shot.mjs.
//
//   npm run test:lob

// Bundled rather than imported directly: node strips types happily enough, but
// this project's sources use extensionless relative imports, which node's ESM
// resolver will not follow. esbuild is already here as a vite dependency, so
// one bundle step buys a suite that runs in a second instead of one that needs
// a browser to answer questions that are pure arithmetic.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const out = join(mkdtempSync(join(tmpdir(), 'lob-')), 'sim.mjs')
await build({
  entryPoints: ['test/lob-entry.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'error',
})
const { LOB_BLAST, LOB_MAX, LOB_MIN, LOB_SPEED, SHELL_LIFETIME, spawnShell, stepShell,
        shellHeight, shellAirborne, setLayout, pointInTallWall } = await import(out)

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

/** Run a shell to death in small steps and report where it ended up. */
const flyToDeath = (shell, cap = 8) => {
  let t = 0
  while (!shell.dead && t < cap) {
    stepShell(shell, 1 / 120)
    t += 1 / 120
  }
  return { x: shell.x, y: shell.y, t, dead: shell.dead, landed: shell.landed }
}

// Pin the board. The map is chosen by the block hash, so a suite run against
// whatever the chain is serving is asking a different question every ten
// minutes — and this suite is entirely about where the walls are.
setLayout(0)

// --------------------------------------------------------- find a real wall

// A wall to shoot at, discovered rather than hardcoded: the layouts are data
// and a coordinate typed in here goes stale the first time one is edited.
let wall = null
for (let x = 200; x < 1400 && !wall; x += 8) {
  for (let y = 200; y < 1000; y += 8) {
    if (pointInTallWall(x, y)) { wall = { x, y }; break }
  }
}
check('layout 0 has a tall wall to shoot at', !!wall, wall ? `${wall.x},${wall.y}` : 'none found')
if (!wall) process.exit(1)

// Stand back from it along -x, so the shot travels +x into the wall face.
const from = { x: wall.x - 130, y: wall.y }
check(
  'and the firing position is in open ground',
  !pointInTallWall(from.x, from.y),
  `${from.x},${from.y}`,
)

// ------------------------------------------------------- 1. over, not into

// A flat shell with no bounce budget: it must die at the wall, well short of
// the far side. This is the control. Without it, "the lob got past the wall"
// is a sentence about a shell that had nothing in its way.
const flat = spawnShell('flat', 'me', from.x, from.y, 0, 0, 1, 0)
const flatEnd = flyToDeath(flat)
check(
  'a flat shell with no bounces dies at the wall',
  flatEnd.dead && flatEnd.x < wall.x + 40,
  `died at x=${Math.round(flatEnd.x)}, wall face at ${wall.x}`,
)

const over = spawnShell('over', 'me', from.x, from.y, 0, 0, 1, 420)
const overEnd = flyToDeath(over)
check(
  'a lob fired from the same spot lands past it',
  overEnd.landed && overEnd.x > wall.x + 60,
  `landed at x=${Math.round(overEnd.x)}, wall face at ${wall.x}`,
)

check(
  'and it lands at exactly the range it was given, not at the wall',
  Math.abs(Math.hypot(overEnd.x - from.x, overEnd.y - from.y) - 420) < 4,
  `flew ${Math.round(Math.hypot(overEnd.x - from.x, overEnd.y - from.y))} of 420`,
)

// The arc has to actually leave the ground, and has to come back to it. A lob
// drawn at a constant height is a shell with a strange sprite.
const arc = spawnShell('arc', 'me', from.x, from.y, 0, 0, 1, 420)
let peak = 0
let atLaunch = shellHeight(arc)
while (!arc.dead) {
  stepShell(arc, 1 / 120)
  peak = Math.max(peak, shellHeight(arc))
}
check('the arc starts on the ground', atLaunch === 0, `h=${atLaunch}`)
check('it gets meaningfully into the air', peak > 100, `apex ${Math.round(peak)}`)
check('and it is back down when it lands', shellHeight(arc) < 1, `h=${shellHeight(arc).toFixed(2)}`)
check('an airborne lob reports itself airborne, a landed one does not', (() => {
  const s = spawnShell('a', 'me', from.x, from.y, 0, 0, 1, 420)
  stepShell(s, 0.2)
  const mid = shellAirborne(s)
  flyToDeath(s)
  return mid === true && shellAirborne(s) === false
})())

// A flat shell must never claim to be airborne — that flag gates whether a
// shell can hit anyone on the way, so a false positive here is a weapon that
// passes through people.
const flatAir = spawnShell('fa', 'me', from.x, from.y, 0, 3, 1, 0)
stepShell(flatAir, 0.1)
check('a flat shell is never airborne', shellAirborne(flatAir) === false && shellHeight(flatAir) === 0)

// -------------------------------------------- 2. everyone gets one crater

// The same fire event, re-simulated by three clients that received it at
// different times, has to end in the same crater. This is the check that fails
// if the range is ever recomputed from a local charge timer instead of read
// off the event.
const craters = [0, 0.35, 1.1].map((late) => {
  const s = spawnShell('shared', 'them', from.x, from.y, 0.6, 0, 1, 500)
  stepShell(s, late)          // fast-forward, exactly as onShell does
  return flyToDeath(s)
})
const spread = Math.max(
  ...craters.map((c) => Math.hypot(c.x - craters[0].x, c.y - craters[0].y)),
)
check(
  'three clients that received the shot at different times agree on the crater',
  spread < 1,
  `worst disagreement ${spread.toFixed(3)}px across ${craters.length} clients`,
)

// And the guard has to be able to fail: a lob whose range differs by a hair
// must land somewhere else, or the check above is comparing two numbers that
// were always going to be equal.
const nudged = flyToDeath(spawnShell('nudge', 'them', from.x, from.y, 0.6, 0, 1, 540))
check(
  'and a shot fired at a different range lands somewhere else',
  Math.hypot(nudged.x - craters[0].x, nudged.y - craters[0].y) > 30,
  `${Math.round(Math.hypot(nudged.x - craters[0].x, nudged.y - craters[0].y))}px apart`,
)

// ------------------------------------------- 3. it arrives even when late

// A lob is about two seconds in the air at full range. An event that took
// longer than the flight has to detonate on arrival rather than be dropped,
// and `landed` is the flag that tells the receiver which it is.
const late = spawnShell('late', 'them', from.x, from.y, 0, 0, 1, LOB_MIN)
stepShell(late, 1.5) // longer than a minimum-range flight takes
check(
  'a lob that finished its flight during the trip is dead and landed, not just dead',
  late.dead && late.landed,
  JSON.stringify({ dead: late.dead, landed: late.landed }),
)

// The other half of that, and it is worth saying why it is written as a
// statement about the constants rather than as a flight.
//
// The first version of this check flew a maximum-range lob for thirty seconds
// and asserted it came back dead, meaning "it expired in mid-air and must not
// be flagged as landed". It passed — and it passed for the wrong reason. The
// shell had landed perfectly normally two seconds in, and `dead` is true for
// both outcomes, so the assertion could not tell the case it was written for
// from the case that actually happened. An observation consistent with both the
// behaviour and its opposite carries nothing.
//
// The honest version: a lob *cannot* time out, and that is a property of the
// numbers. Assert the property. If someone later slows the shell down or
// stretches the range, this goes red and the expiry path has to be thought
// about for real.
const longestFlight = LOB_MAX / LOB_SPEED
check(
  'no lob can outlive a shell, so there is no mid-air expiry to get wrong',
  longestFlight < SHELL_LIFETIME * 0.75,
  `longest flight ${longestFlight.toFixed(2)}s against a ${SHELL_LIFETIME}s shell lifetime`,
)

// ----------------------------------------------------------- blast radius

// The crater has to be worth landing. A blast the width of a tank is a mortar
// nobody hits with; a blast the width of the arena is not a weapon, it is
// weather.
check(
  'the blast is wider than a tank and far short of the board',
  LOB_BLAST > 40 && LOB_BLAST < 120,
  `LOB_BLAST=${LOB_BLAST}`,
)
check(
  'and the range band is a real choice, not a single distance',
  LOB_MAX > LOB_MIN * 2.5,
  `${LOB_MIN}..${LOB_MAX}`,
)

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall good')
process.exit(failures.length ? 1 : 0)
