// Terrain, checked as arithmetic: water and high ground are pure functions of
// the layout, which is exactly the shape that can be proven without a browser.
//
// What it has to hold:
//
//   1. Water is a moat, not a wall: a tank is stopped at the bank and pushed
//      back out of it, while a shell simulated with the real `stepShell`
//      crosses the whole river and reaches the far bank. The fords are dry.
//   2. High ground blocks shots the way tall walls do — a shell fired from the
//      flat bounces off the mesa's cliff — and does NOT block a shell fired
//      from the mesa top, which crosses its own parapet and lands out in the
//      open board. Both through `stepShell`, because the exception lives in
//      the collision the shell actually runs, not in a predicate on the side.
//   3. `elevationAt` is 1 on the mesa, 0 on the flat, and climbs monotonically
//      up a ramp; `spawnShell` stamps `elev` from it, rounding a ramp to the
//      nearer level. The mirrored ramp climbs the mirrored way.
//   4. The new boards keep the contract every board signs: 180-degree
//      rotational symmetry rect for rect, spawns and pads on open ground.
//
// Run: node test/terrain.mjs

import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'

const out = '.scratch/terrain-bundle.mjs'
mkdirSync('.scratch', { recursive: true })
await build({
  entryPoints: ['test/terrain-entry.ts'],
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
  LAYOUTS, WALLS, MESAS, RAMPS, SPAWNS, PADS, setLayout,
  pointInWall, pointInTallWall, pointInShellWall, elevationAt, resolveCircle,
  spawnShell, stepShell, TANK_RADIUS,
} = arena

const layoutIndex = (name) => {
  const i = LAYOUTS.findIndex((l) => l.name === name)
  if (i < 0) throw new Error(`no layout named ${name}`)
  return i
}

// Walk a shell with the real simulation and record how far it ranged. The
// extremes, not the death point: a shell that crossed the river and then died
// bouncing off the far fence still crossed the river.
const flyShell = (x, y, angle) => {
  const s = spawnShell('t', 'tester', x, y, angle)
  let minY = y
  let maxY = y
  let firstStruck = -1
  for (let i = 0; i < 600 && !s.dead; i++) {
    stepShell(s, 1 / 60)
    minY = Math.min(minY, s.y)
    maxY = Math.max(maxY, s.y)
    if (firstStruck < 0 && s.struck >= 0) firstStruck = s.struck
  }
  return { s, minY, maxY, firstStruck }
}

// ------------------------------------------------------------- The Shallows

console.log('The Shallows: water')
setLayout(layoutIndex('The Shallows'))
const shallows = LAYOUTS[layoutIndex('The Shallows')]
const { w: SW, h: SH } = shallows

// A point in the middle of the west river arm.
const river = { x: 240, y: SH / 2 }
check(pointInWall(river.x, river.y)?.kind === 'water', 'the river stops a tank')
check(pointInTallWall(river.x, river.y) === null, 'the river does not stop a shell')

// A tank pushed into the river is pushed back out.
const tank = { x: river.x, y: SH / 2 - 70 + 4 }
resolveCircle(tank, TANK_RADIUS)
check(pointInWall(tank.x, tank.y) === null, 'resolveCircle puts a tank back on the bank',
  JSON.stringify(tank))

// The west ford is dry ground all the way across the river band.
const fordDry = [SH / 2 - 60, SH / 2, SH / 2 + 60].every((y) => pointInWall(530, y) === null)
check(fordDry, 'the west ford is dry all the way across')

// A shell fired due south across the river from the north bank ranges past the
// far bank — simulated with stepShell, so this is the trajectory players get.
// x=350 is a column with no cover in it on either side of the water.
const crossing = flyShell(350, SH / 2 - 140, Math.PI / 2)
check(crossing.maxY > SH / 2 + 90, 'a shell fired across the river reaches the far bank',
  `ranged to y=${Math.round(crossing.maxY)}`)

// --------------------------------------------------------------- The Bluff

console.log('The Bluff: high ground')
setLayout(layoutIndex('The Bluff'))
const bluff = LAYOUTS[layoutIndex('The Bluff')]
const { w: BW, h: BH } = bluff

check(MESAS.length === 1, 'the centred mesa is kept once, not twice', `${MESAS.length} mesas`)
check(RAMPS.length === 2, 'the authored ramp and its mirror', `${RAMPS.length} ramps`)
check(RAMPS.some((r) => r.dir === 'e') && RAMPS.some((r) => r.dir === 'w'),
  'the mirrored ramp climbs the mirrored way')

check(elevationAt(200, 200) === 0, 'flat ground is at elevation 0')
check(elevationAt(BW / 2, BH / 2) === 1, 'the mesa top is at elevation 1')
const climb = [0.1, 0.35, 0.65, 0.9].map((t) => elevationAt(550 + 120 * t, BH / 2))
check(climb.every((v, i) => i === 0 || v > climb[i - 1]) && climb[0] > 0 && climb[3] < 1,
  'the west ramp climbs monotonically', climb.map((v) => v.toFixed(2)).join(' -> '))

// spawnShell stamps elevation from the muzzle, rounding a ramp to the nearer level.
check(spawnShell('a', 'p', 200, 200, 0).elev === 0, 'a shell fired on the flat is low')
check(spawnShell('b', 'p', BW / 2, BH / 2, 0).elev === 1, 'a shell fired on the mesa is high')
check(spawnShell('c', 'p', 560, BH / 2, 0).elev === 0, 'the bottom of the ramp counts as low')
check(spawnShell('d', 'p', 660, BH / 2, 0).elev === 1, 'the top of the ramp counts as high')

// The cliff band itself: a low shell is stopped there, a high one is not.
const cliffPt = { x: BW / 2, y: BH / 2 - 170 }
check(pointInShellWall(cliffPt.x, cliffPt.y, 0)?.kind === 'cliff', 'a cliff stops a low shell')
check(pointInShellWall(cliffPt.x, cliffPt.y, 1) === null, 'a cliff does not stop a high shell')
check(pointInTallWall(cliffPt.x, cliffPt.y)?.kind === 'cliff', 'sight lines still treat cliffs as walls')

// Fired from the flat, due south at the mesa's north face, in a column (x=750)
// with nothing else in the lane: the shell never gets past the cliff band.
const fromBelow = flyShell(750, 300, Math.PI / 2)
check(fromBelow.maxY < BH / 2 - 140, 'a shell from the flat never gets past the cliff',
  `ranged to y=${Math.round(fromBelow.maxY)}`)
check(WALLS[fromBelow.firstStruck]?.kind === 'cliff', 'and the first rect it struck was the cliff',
  `struck kind=${WALLS[fromBelow.firstStruck]?.kind}`)

// Fired from the mesa top, due north, same column: crosses its own parapet and
// ranges far out onto the open board.
const fromAbove = flyShell(750, BH / 2, -Math.PI / 2)
check(fromAbove.s.elev === 1, 'the mesa shell was stamped high')
check(fromAbove.minY < BH / 2 - 220, 'a shell from the mesa crosses its own cliff edge',
  `ranged to y=${Math.round(fromAbove.minY)}`)

// ------------------------------------------------- both boards, board contract

for (const name of ['The Shallows', 'The Bluff']) {
  console.log(`${name}: board contract`)
  setLayout(layoutIndex(name))
  const spec = LAYOUTS[layoutIndex(name)]

  // 180-degree rotational symmetry, rect for rect, kind for kind.
  const key = (r) => `${r.x},${r.y},${r.w},${r.h},${r.kind}`
  const all = new Set(WALLS.map(key))
  const unpaired = WALLS.filter((r) => {
    const f = { x: spec.w - r.x - r.w, y: spec.h - r.y - r.h, w: r.w, h: r.h, kind: r.kind }
    return !all.has(key(f))
  })
  check(unpaired.length === 0, 'every rect has a 180-degree partner of the same kind',
    unpaired.slice(0, 3).map(key).join(' | '))

  const wetSpawns = SPAWNS.filter((s) => pointInWall(s.x, s.y))
  check(wetSpawns.length === 0, 'every spawn is on open ground', JSON.stringify(wetSpawns))
  const wetPads = PADS.filter((p) => pointInWall(p.x, p.y))
  check(wetPads.length === 0, 'every pad is on open ground', JSON.stringify(wetPads))
  const dupPads = new Set(PADS.map((p) => `${p.x},${p.y}`))
  check(dupPads.size === PADS.length, 'no two pads share a position')
}

console.log(failures ? `\n${failures} FAILED` : '\nall green')
process.exit(failures ? 1 : 0)
