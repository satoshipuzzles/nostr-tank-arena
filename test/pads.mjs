// The pickup schedule, checked as arithmetic rather than as a screenshot.
//
// Everything in `pickups.ts` is a pure function of the block hash and the round
// clock, which is exactly the shape that can be checked exhaustively without a
// browser or a relay. What it has to prove:
//
//   1. No pad carries a pickup in two consecutive waves. This is the thing the
//      construction exists for, and it is *structural* — the schedule may never
//      walk backwards through waves to enforce it, because on the fallback
//      clock the wave index is around fifty million.
//   2. Every pad gets used. A rotation that never lights pad 4 is a board with
//      five pads pretending to have six.
//   3. Spawn moments are not a metronome, and pickups are genuinely scarce.
//   4. Pads sit on open ground, and no two pads share a position.
//
// Run: node test/pads.mjs

import { build } from 'esbuild'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'

const out = '.scratch/pads-bundle.mjs'
mkdirSync('.scratch', { recursive: true })
await build({
  entryPoints: ['test/pads-entry.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'silent',
  external: ['three', 'nostr-tools'],
})
const arena = await import('../' + out)
rmSync(out)

let failures = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const {
  LAYOUTS, PADS, WALLS, setLayout, pointInWall, pointInTallWall, isLow,
  hasLineOfSight, spawnShell, stepShell, scheduleFor, DEFAULT_WAVES, PICKUP_LINGER,
} = arena

// Deterministic block hashes. Real ones, in shape: 64 lowercase hex digits.
const hashes = []
for (let i = 0; i < 40; i++) {
  let h = ''
  let x = 0x9e3779b9 ^ (i * 0x85ebca6b)
  for (let j = 0; j < 16; j++) {
    x = Math.imul(x ^ (x >>> 15), 0x2545f491) >>> 0
    h += x.toString(16).padStart(8, '0')
  }
  hashes.push(h.slice(0, 64))
}

// --------------------------------------------------------------- barricades
//
// Sandbags stop a tank and not a shell, which is the one thing in this pass
// that changes what happens rather than what it looks like. Three separate
// claims, and each is checked against a board that actually has barricades on
// it rather than against a hand-built rect, because the interesting failure is
// a layout that forgot to say `kind` at all.

console.log('\nbarricades')
{
  // Crossroads. Its centre cross is the barricade this exists for.
  setLayout(0)
  const low = WALLS.filter(isLow)
  const tall = WALLS.filter((w) => !isLow(w))
  check(low.length >= 2, 'a board with barricades on it exists to test', `${low.length} low rects`)
  check(tall.length > low.length, 'and most cover is still solid', `${tall.length} tall`)
  check(
    WALLS.every((w) => typeof w.kind === 'string'),
    'every rect on the board says what it is made of',
    JSON.stringify(WALLS.filter((w) => !w.kind)),
  )

  const bar = low[0]
  const cx = bar.x + bar.w / 2
  const cy = bar.y + bar.h / 2

  // The two predicates have to disagree about this point, or nothing below
  // means anything — a green run against `pointInTallWall === pointInWall`
  // would be green for the wrong reason.
  check(pointInWall(cx, cy) !== null, 'a tank is stopped by the middle of a barricade')
  check(pointInTallWall(cx, cy) === null, 'a shell is not')

  // Drive the real shell integrator through it, rather than asserting on the
  // predicate that the integrator happens to call. Fired from one side, far
  // enough back that it is travelling at speed when it arrives.
  const across = bar.w >= bar.h ? Math.PI / 2 : 0
  const startX = bar.w >= bar.h ? cx : bar.x - 90
  const startY = bar.w >= bar.h ? bar.y - 90 : cy
  const shell = spawnShell('t', 'test', startX, startY, across)
  for (let i = 0; i < 60 && !shell.dead; i++) stepShell(shell, 1 / 60)
  const past = bar.w >= bar.h ? shell.y > bar.y + bar.h : shell.x > bar.x + bar.w
  check(!shell.dead && shell.bounces === 0, 'a shell crosses a barricade without bouncing', `bounces ${shell.bounces}, dead ${shell.dead}`)
  check(past, 'and comes out the far side', `at ${Math.round(shell.x)},${Math.round(shell.y)}`)

  // The control. The same shot at a solid piece of cover has to bounce, or the
  // test above is only proving that this shell never hits anything.
  const solid = tall.find((w) => w.kind !== 'fence' && Math.min(w.w, w.h) >= 40)
  const sx = solid.x + solid.w / 2
  const sy = solid.y + solid.h / 2
  const dir = solid.w >= solid.h ? Math.PI / 2 : 0
  const from = solid.w >= solid.h ? [sx, solid.y - 90] : [solid.x - 90, sy]
  const control = spawnShell('c', 'test', from[0], from[1], dir)
  for (let i = 0; i < 60 && !control.dead; i++) stepShell(control, 1 / 60)
  check(control.bounces > 0 || control.dead, 'the same shot at solid cover does not', `bounces ${control.bounces}, dead ${control.dead}`)

  // Spawn safety reads the same way a shell does. A sight line that only
  // crosses barricades is not blocked.
  const a = bar.w >= bar.h ? [cx, bar.y - 120] : [bar.x - 120, cy]
  const c = bar.w >= bar.h ? [cx, bar.y + bar.h + 120] : [bar.x + bar.w + 120, cy]
  check(hasLineOfSight(a[0], a[1], c[0], c[1]), 'spawn picking can see through a barricade')
  const s2 = solid.w >= solid.h ? [sx, solid.y - 120] : [solid.x - 120, sy]
  const e2 = solid.w >= solid.h ? [sx, solid.y + solid.h + 120] : [solid.x + solid.w + 120, sy]
  check(!hasLineOfSight(s2[0], s2[1], e2[0], e2[1]), '...and cannot see through solid cover')

  // Mirroring carries the material through. A board where one half of a
  // symmetric pair is low and the other is not is unfair in the worst way:
  // invisibly, and only to whoever spawned on the wrong side.
  for (let li = 0; li < LAYOUTS.length; li++) {
    setLayout(li)
    const name = LAYOUTS[li].name
    // Live bindings: `setLayout` reassigns these, so read them each time.
    const w = arena.ARENA_W
    const h = arena.ARENA_H
    const kindAt = new Map()
    for (const r of WALLS) kindAt.set(`${r.x},${r.y},${r.w},${r.h}`, r.kind)
    let mismatch = null
    for (const r of WALLS) {
      const key = `${w - r.x - r.w},${h - r.y - r.h},${r.w},${r.h}`
      const other = kindAt.get(key)
      if (other !== undefined && other !== r.kind) mismatch = `${r.kind} vs ${other}`
    }
    check(!mismatch, `${name}: mirrored cover is made of the same thing`, mismatch ?? '')
  }
}

console.log('\nboard geometry')
for (let li = 0; li < LAYOUTS.length; li++) {
  setLayout(li)
  const name = LAYOUTS[li].name
  check(PADS.length >= 6, `${name}: at least six pads`, `has ${PADS.length}`)
  const seen = new Set()
  let dup = ''
  let inWall = ''
  for (const p of PADS) {
    const key = `${Math.round(p.x)},${Math.round(p.y)}`
    if (seen.has(key)) dup = key
    seen.add(key)
    // A pad the tank cannot stand on is a pickup nobody can take.
    for (const dx of [-46, 0, 46]) {
      for (const dy of [-46, 0, 46]) {
        if (pointInWall(p.x + dx, p.y + dy)) inWall = key
      }
    }
  }
  check(!dup, `${name}: no two pads in the same spot`, dup && `two pads at ${dup}`)
  check(!inWall, `${name}: every pad is on open ground`, inWall && `pad at ${inWall} is in cover`)

  // The same question for spawns, which had no check at all and needed one the
  // moment four new boards were authored by hand. A spawn inside cover is a
  // player who begins the round unable to move, and nothing else in the suite
  // would have said a word about it.
  let stuck = ''
  for (const p of arena.SPAWNS) {
    for (const dx of [-22, 0, 22]) {
      for (const dy of [-22, 0, 22]) {
        if (pointInWall(p.x + dx, p.y + dy)) stuck = `${Math.round(p.x)},${Math.round(p.y)}`
      }
    }
  }
  check(!stuck, `${name}: every spawn is on open ground`, stuck && `spawn at ${stuck} is in cover`)

  // Cover that *partly* overlaps its own mirror image is the shape that
  // quietly becomes a solid slab across the centre when the author meant two
  // staggered pieces — the boards below lean on staggered sandbag runs and
  // that is exactly the mistake they invite.
  //
  // A piece sitting dead on the centre point maps onto itself exactly, which is
  // a deliberate thing to do (The Ring's boulder) and not what this is looking
  // for. Only the partial case fails.
  let selfOverlap = ''
  const w = arena.ARENA_W
  const h = arena.ARENA_H
  for (const r of LAYOUTS[li].cover(w, h)) {
    const m = { x: w - r.x - r.w, y: h - r.y - r.h, w: r.w, h: r.h }
    const same = m.x === r.x && m.y === r.y
    const hits = r.x < m.x + m.w && m.x < r.x + r.w && r.y < m.y + m.h && m.y < r.y + r.h
    if (hits && !same) selfOverlap = `${r.x},${r.y} ${r.w}x${r.h}`
  }
  check(!selfOverlap, `${name}: no piece of cover part-overlaps its own mirror`, selfOverlap)
}

console.log('\nschedule')
setLayout(0)
const period = DEFAULT_WAVES.waveSeconds
let repeats = 0
let repeatExample = ''
const padUse = new Map()
const gaps = []
let waveCount = 0
let stockedSeconds = 0
const SECONDS = 40 * 60 // forty minutes of round clock per block, well past a block

for (const hash of hashes) {
  let previous = null
  let lastBorn = null
  for (let wave = 0; wave < Math.floor(SECONDS / period); wave++) {
    // Sample the whole frame a second at a time so this sees exactly what a
    // client sees, rather than trusting an internal notion of when a wave lands.
    let born = null
    const pads = new Set()
    for (let t = wave * period; t < (wave + 1) * period; t++) {
      const live = scheduleFor(hash, t)
      if (!live.length) continue
      stockedSeconds++
      born = live[0].born
      for (const p of live) {
        pads.add(p.pad)
        padUse.set(p.pad, (padUse.get(p.pad) ?? 0) + 1)
      }
    }
    if (!pads.size) continue
    waveCount++
    if (previous) {
      for (const pad of pads) {
        if (previous.has(pad)) {
          repeats++
          if (!repeatExample) repeatExample = `block ${hash.slice(-8)} wave ${wave} reused pad ${pad}`
        }
      }
    }
    if (lastBorn !== null) gaps.push(born - lastBorn)
    lastBorn = born
    previous = pads
  }
}

check(repeats === 0, 'no pad carries a pickup in two consecutive waves', repeatExample)
check(waveCount > 900, 'the sample is big enough to mean something', `${waveCount} waves`)

const unused = []
for (let pad = 0; pad < PADS.length; pad++) if (!padUse.has(pad)) unused.push(pad)
check(unused.length === 0, 'every pad gets used', unused.length ? `never used: ${unused}` : '')
const uses = [...padUse.values()]
const spread = Math.max(...uses) / Math.min(...uses)
check(spread < 1.6, 'no pad is starved relative to the others', `busiest/quietest = ${spread.toFixed(2)}`)

const minGap = Math.min(...gaps)
const maxGap = Math.max(...gaps)
const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
const distinct = new Set(gaps).size
check(minGap > PICKUP_LINGER, 'the board is always empty between waves', `shortest gap ${minGap}s`)
check(maxGap - minGap > 20, 'spawns are not on a metronome', `gaps run ${minGap}s to ${maxGap}s`)
check(distinct > 20, 'the gap is not one of a handful of values', `${distinct} distinct gaps`)
check(mean > 45, 'pickups are scarce', `mean gap ${mean.toFixed(1)}s`)

const duty = stockedSeconds / (waveCount * period)
check(duty < 0.45, 'most of the round has nothing on the board', `stocked ${(duty * 100).toFixed(0)}% of the time`)

// A wave is one or two pads, never three: two is a choice with two locations,
// three is a shopping trip.
let tooMany = 0
for (const hash of hashes.slice(0, 8)) {
  for (let t = 0; t < SECONDS; t++) {
    if (scheduleFor(hash, t).length > 2) tooMany++
  }
}
check(tooMany === 0, 'no wave stocks more than two pads')

// Determinism: the same inputs, twice, on a fresh call.
const a = JSON.stringify(scheduleFor(hashes[3], 812))
const b = JSON.stringify(scheduleFor(hashes[3], 812))
check(a === b, 'the schedule is a pure function of block and clock')

// The fallback clock hands `elapsed` absolute unix seconds. Nothing may walk
// waves from zero to answer that, so this has to return in microseconds.
const t0 = performance.now()
for (let i = 0; i < 2000; i++) scheduleFor(hashes[0], 1.77e9 + i)
const perCall = (performance.now() - t0) / 2000
check(perCall < 0.5, 'the unix-seconds fallback clock is O(1)', `${perCall.toFixed(3)}ms per call`)

console.log(failures ? `\n${failures} failed\n` : '\nall good\n')
process.exit(failures ? 1 : 0)
