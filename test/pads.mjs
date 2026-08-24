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

const { LAYOUTS, PADS, setLayout, pointInWall, scheduleFor, DEFAULT_WAVES, PICKUP_LINGER } = arena

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
