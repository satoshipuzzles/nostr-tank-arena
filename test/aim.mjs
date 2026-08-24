// Can the turret reach every bearing, and does it go the way you point?
//
// Two separate faults were reported as one — "the turret gets stuck after 180
// degrees" — and both are arithmetic, so both belong here rather than in a
// browser suite. Neither is view-specific and neither needs a renderer.
//
//   1. A stick is a direction. Deadzoning each axis on its own throws the
//      *angle* away, not noise: zero one axis while the other survives and the
//      vector points exactly along the survivor. The turret then has four
//      positions at a gentle push and sits on 180° across five consecutive
//      stick bearings. Measured in a real browser on the shipped build before
//      the fix: full deflection reached 24 of 24 fifteen-degree sectors, half
//      deflection 16, a gentle push 9.
//
//   2. The gun slews at a fixed rate and used to chase the commanded bearing by
//      the shortest path, recomputed each frame. A thumb can rotate a stick
//      faster than the turret turns, so the gap grows, and the moment it passes
//      half a circle the shortest way round is backwards. The turret reverses.
//
// Run: node test/aim.mjs

import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'

const out = '.scratch/aim-bundle.mjs'
mkdirSync('.scratch', { recursive: true })
await build({
  entryPoints: ['test/aim-entry.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'silent',
  external: ['three', 'nostr-tools'],
})
const mod = await import('../' + out)
rmSync(out)

const { stick, stepTank, GUN_TURN_RATE } = mod

let failures = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const deg = (r) => (r * 180) / Math.PI
const rad = (d) => (d * Math.PI) / 180
const norm = (d) => (((d % 360) + 540) % 360) - 180
const fresh = () => ({
  x: 900, y: 700, hull: 0, gun: 0, hp: 3, dead: false, respawnAt: 0, reloadAt: 0,
})

// ------------------------------------------------------------------- the stick
console.log('\nthe stick keeps its angle')

// Every whole-degree bearing, at three pushes: the one just past the deadzone is
// the one the old per-axis code destroyed almost completely.
for (const mag of [0.24, 0.28, 0.5, 1.0]) {
  let worst = 0
  for (let a = 0; a < 360; a++) {
    const s = stick(Math.cos(rad(a)) * mag, Math.sin(rad(a)) * mag)
    worst = Math.max(worst, Math.abs(norm(deg(Math.atan2(s.y, s.x)) - a)))
  }
  check(worst < 1e-9, `a push of ${mag} points where it is pushed`, `worst error ${worst.toExponential(1)}°`)
}

// The failure this replaced, stated as the thing that must not come back: count
// how many distinct bearings survive a full turn of the stick. Per-axis
// deadzoning at 0.28 leaves nine.
for (const mag of [0.28, 0.5, 1.0]) {
  const seen = new Set()
  for (let a = 0; a < 360; a += 15) {
    const s = stick(Math.cos(rad(a)) * mag, Math.sin(rad(a)) * mag)
    seen.add(Math.round(((deg(Math.atan2(s.y, s.x)) + 360) % 360) / 15) % 24)
  }
  check(seen.size === 24, `a push of ${mag} reaches all 24 sectors`, `${seen.size}/24`)
}

check(stick(0, 0).mag === 0, 'a resting stick is no push at all')
check(stick(0.15, 0.1).mag === 0, 'inside the deadzone is no push at all')
// Rescaled from the edge of the deadzone rather than passed through, so
// engaging the stick does not jump the output straight to a fifth of a push.
const edge = stick(0.23, 0)
check(edge.mag > 0 && edge.mag < 0.02, 'the deadzone edge is a small push, not a step', `mag ${edge.mag.toFixed(4)}`)
check(Math.abs(stick(1, 0).mag - 1) < 1e-9, 'full deflection is still full deflection')

// -------------------------------------------------------------- the turret
console.log('\nthe turret goes the way you point')

/** A thumb rotating the stick at a steady rate for two full turns, at 60fps. */
function spin(thumbDps) {
  const t = fresh()
  const dt = 1 / 60
  let travel = 0
  let reversals = 0
  let lastDir = 0
  let prev = t.gun
  const steps = Math.round(((360 * 2) / thumbDps) * 60)
  for (let i = 0; i < steps; i++) {
    stepTank(t, 0, 0, rad(thumbDps * i * dt), dt)
    const d = norm(deg(t.gun - prev))
    if (Math.abs(d) > 1e-9) {
      const dir = Math.sign(d)
      if (lastDir && dir !== lastDir) reversals++
      lastDir = dir
      travel += d
    }
    prev = t.gun
  }
  return { travel, reversals, t }
}

// The gun may lag a fast thumb — that is what a slew rate is — but it may never
// turn around. 420°/s reversed twice before the fix, 900°/s three times.
for (const dps of [60, 180, 240, 300, 420, 600, 900, 1400]) {
  const { travel, reversals } = spin(dps)
  check(reversals === 0, `${dps}°/s never reverses`, `${reversals} reversals, ${travel.toFixed(0)}° of 720°`)
}

// Anything the turret can keep up with, it keeps up with all the way round.
for (const dps of [60, 180, 235]) {
  const { travel } = spin(dps)
  check(Math.abs(travel - 720) < 30, `${dps}°/s tracks the whole way round`, `${travel.toFixed(0)}° of 720°`)
}

// Lagging is only acceptable because it ends: stop the stick and the gun must
// arrive on the commanded bearing, not somewhere a lap away from it.
{
  const { t } = spin(900)
  const target = rad(900 * 2) // where the thumb finished
  for (let i = 0; i < 600; i++) stepTank(t, 0, 0, target, 1 / 60)
  const off = Math.abs(norm(deg(t.gun) - deg(target)))
  check(off < 0.5, 'the gun arrives once the thumb stops', `${off.toFixed(2)}° off`)
}

// A flick from rest has no direction of travel behind it, so it is still the
// short way round — 270° to the right is 90° to the left, and always was.
{
  const t = fresh()
  for (let i = 0; i < 600; i++) stepTank(t, 0, 0, rad(270), 1 / 60)
  check(Math.abs(norm(deg(t.gun) - 270)) < 0.5, 'a flick from rest takes the short way', `${norm(deg(t.gun)).toFixed(1)}°`)
}

// Respawn points the gun down the hull behind the sim's back. The carried lead
// is stale the moment that happens and must not drag the gun back round.
{
  const t = fresh()
  for (let i = 0; i < 60; i++) stepTank(t, 0, 0, rad(150), 1 / 60)
  t.gun = rad(-90) // respawned facing somewhere else entirely
  for (let i = 0; i < 600; i++) stepTank(t, 0, 0, rad(-60), 1 / 60)
  check(Math.abs(norm(deg(t.gun) + 60)) < 0.5, 'a gun moved by a respawn re-aims from where it was put', `${norm(deg(t.gun)).toFixed(1)}°`)
}

// Releasing the stick and picking it up somewhere else is a new command, not a
// continuation of the old lap.
{
  const t = fresh()
  for (let i = 0; i < 30; i++) stepTank(t, 0, 0, rad(120), 1 / 60)
  stepTank(t, 0, 0, null, 1 / 60)
  const before = t.gun
  stepTank(t, 0, 0, rad(deg(before) - 10), 1 / 60)
  check(norm(deg(t.gun - before)) < 0, 'letting go and re-aiming takes the short way', `${norm(deg(t.gun - before)).toFixed(2)}°`)
}

check(Math.abs(deg(GUN_TURN_RATE) - 241) < 2, 'the slew rate these numbers were measured at has not moved', `${deg(GUN_TURN_RATE).toFixed(0)}°/s`)

console.log(failures ? `\n${failures} failed\n` : '\nall good\n')
process.exit(failures ? 1 : 0)
