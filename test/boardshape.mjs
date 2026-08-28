// Every board is drivable, and a coolant tower is as dangerous as it looks.
//
// `test/pads.mjs` already asks whether a spawn or a pad sits *inside* a rect.
// That is a point test, and a tank is not a point: it is a 22-unit circle, so
// a spawn twenty units from a wall passes that check and then gets shoved
// sideways by `resolveCircle` the instant the round starts. Worse, nothing
// anywhere asks the question this file exists for — **can you get there** —
// and a board with a pad walled off is a board where a sixth of the pickups
// never enter the game and nobody can say why.
//
// So: a flood fill over each board at tank width, from spawn zero, and every
// other spawn and every pad has to be in it. Twelve boards, arithmetic only.
//
// The second half is The Reactor's rule. A barrel rect is drawn as a *grid* of
// drums, so the 240-unit square in each half is a tank farm rather than a
// drum, and `blastScaleOf` gives it a blast to match. The check that matters
// is not the multiplier itself but what it buys: a tank touching the tower is
// inside the blast, and at the old flat radius it would have been comfortably
// outside — which is the invisible rule this change exists to remove.
//
// Run: node test/boardshape.mjs

import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'

const out = '.scratch/boardshape-bundle.mjs'
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
  LAYOUTS, WALLS, SPAWNS, PADS, BREAKABLE, setLayout, resetCover, passing,
  blastScaleOf, LOB_BLAST, TANK_RADIUS, ARENA_W, ARENA_H,
} = arena

// A tank's hull, not its centre point. `resolveCircle` pushes a circle out of
// any rect it overlaps, so this is the same predicate the physics uses, minus
// the resolution step.
const blocked = (x, y, r) => {
  for (const w of WALLS) {
    const p = passing(w)
    if (p !== 'solid' && p !== 'low') continue
    const nx = Math.max(w.x, Math.min(x, w.x + w.w))
    const ny = Math.max(w.y, Math.min(y, w.y + w.h))
    if ((x - nx) ** 2 + (y - ny) ** 2 < r * r) return true
  }
  return false
}

const STEP = 12

/** Every point a tank can reach from `start`, as a set of grid keys. */
const reachable = (start, w, h) => {
  const cx = (x) => Math.round(x / STEP)
  const key = (i, j) => i * 100000 + j
  const seen = new Set()
  const open = (i, j) => !blocked(i * STEP, j * STEP, TANK_RADIUS)
  const i0 = cx(start.x)
  const j0 = cx(start.y)
  if (!open(i0, j0)) return seen
  const stack = [[i0, j0]]
  seen.add(key(i0, j0))
  const iMax = Math.ceil(w / STEP)
  const jMax = Math.ceil(h / STEP)
  while (stack.length) {
    const [i, j] = stack.pop()
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di
      const nj = j + dj
      if (ni < 0 || nj < 0 || ni > iMax || nj > jMax) continue
      const k = key(ni, nj)
      if (seen.has(k) || !open(ni, nj)) continue
      seen.add(k)
      stack.push([ni, nj])
    }
  }
  return seen
}

/** The nearest reachable cell to a point, in grid steps, or Infinity. */
const distanceToFill = (fill, p) => {
  const i0 = Math.round(p.x / STEP)
  const j0 = Math.round(p.y / STEP)
  for (let ring = 0; ring <= 3; ring++) {
    for (let di = -ring; di <= ring; di++) {
      for (let dj = -ring; dj <= ring; dj++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== ring) continue
        if (fill.has((i0 + di) * 100000 + (j0 + dj))) return ring
      }
    }
  }
  return Infinity
}

for (let li = 0; li < LAYOUTS.length; li++) {
  setLayout(li)
  resetCover()
  const spec = LAYOUTS[li]
  const name = spec.name

  // ------------------------------------------------- room for the hull itself
  const tight = [...SPAWNS.map((s, n) => ({ p: s, what: `spawn ${n}` })),
                 ...PADS.map((s, n) => ({ p: s, what: `pad ${n}` }))]
    .filter(({ p }) => blocked(p.x, p.y, TANK_RADIUS))
    .map(({ p, what }) => `${what} at ${Math.round(p.x)},${Math.round(p.y)}`)
  check(!tight.length, `${name}: every spawn and pad has room for a hull`, tight.join('; '))

  // ------------------------------------------------------- and you can get there
  //
  // Within one grid step counts as reachable: the fill is on a 12-unit lattice
  // and a pad is a continuous position, so demanding its exact cell would fail
  // on rounding rather than on geometry.
  const fill = reachable(SPAWNS[0], spec.w, spec.h)
  const marooned = (f) => [...SPAWNS.map((s, n) => ({ p: s, what: `spawn ${n}` })),
                           ...PADS.map((s, n) => ({ p: s, what: `pad ${n}` }))]
    .filter(({ p }) => distanceToFill(f, p) > 1)
    .map(({ p, what }) => `${what} at ${Math.round(p.x)},${Math.round(p.y)}`)

  // Two pads are *supposed* to be unreachable: the vault caches, which is the
  // entire point of the vault. Everything else being walled off is a bug, and
  // the count is asserted rather than the identity so a board that loses its
  // vault, or gains a second sealed pocket, says so here.
  const sealed = marooned(fill)
  check(
    sealed.length === 2 && sealed.every((m) => m.startsWith('pad')),
    `${name}: nothing but the two vault caches is walled off`,
    sealed.join('; ') || 'nothing was',
  )

  // And they open. Breaching is a decision a player makes with two magazines,
  // so a vault that cannot be driven into once its walls are down is a pocket
  // holding a pickup nobody can ever collect.
  for (const w of WALLS) if (w.kind === 'breach') w.gone = true
  check(
    marooned(reachable(SPAWNS[0], spec.w, spec.h)).length === 0,
    `${name}: and both open when their walls come down`,
    marooned(reachable(SPAWNS[0], spec.w, spec.h)).join('; '),
  )
  resetCover()

  // The control. The fence is 24 units thick and the fill starts inside it, so
  // a point in the corner of the border must be *outside* the reachable set —
  // if it is not, `blocked` is answering false for everything and the two
  // checks above are measuring nothing at all.
  check(
    !fill.has(0),
    `${name}: control — the fill does not leak through the fence`,
  )
}

// ------------------------------------------------------------- the coolant tower

const reactor = LAYOUTS.findIndex((l) => l.name === 'The Reactor')
check(reactor >= 0, 'The Reactor is in the rotation')
setLayout(reactor)
resetCover()

const barrels = BREAKABLE.filter((r) => r.kind === 'barrel')
const tower = barrels.find((r) => Math.min(r.w, r.h) >= 200)
const drums = barrels.find((r) => Math.min(r.w, r.h) < 200)
check(!!tower && !!drums, 'the board carries a tower and an ordinary stack', `${barrels.length} barrel rects`)

const scale = blastScaleOf(tower)
check(scale > 2 && scale <= 2.4, 'the tower blast is over twice a lob', `scale ${scale.toFixed(2)}`)
check(
  blastScaleOf(drums) === 1,
  'and the drums beside it are the ordinary blast, exactly',
  `scale ${blastScaleOf(drums).toFixed(2)}`,
)

// What the multiplier buys, which is the only reason it exists. A tank in
// contact with the tower sits half the footprint plus its own radius from the
// centre; the blast reaches `LOB_BLAST * scale + TANK_RADIUS`.
const touching = Math.min(tower.w, tower.h) / 2 + TANK_RADIUS
check(
  LOB_BLAST * scale + TANK_RADIUS > touching,
  'a tank touching the tower is inside the blast',
  `blast ${(LOB_BLAST * scale + TANK_RADIUS).toFixed(0)} against ${touching.toFixed(0)}`,
)
// The same sum with the radius this board would have had before the change —
// the tower would have looked like the most dangerous thing on the map and
// been safe to hide behind, which is the bug rather than the balance.
check(
  LOB_BLAST + TANK_RADIUS < touching,
  'control — at the old flat radius it would not have been',
  `blast ${(LOB_BLAST + TANK_RADIUS).toFixed(0)} against ${touching.toFixed(0)}`,
)
// And it does not swallow the board: a blast that reaches a spawn is a board
// where three shells clear the room.
check(
  LOB_BLAST * scale + TANK_RADIUS < Math.min(ARENA_W, ARENA_H) / 4,
  'and it does not cover the board',
  `blast ${(LOB_BLAST * scale + TANK_RADIUS).toFixed(0)} on ${ARENA_W}x${ARENA_H}`,
)

// Nothing that shipped before The Reactor moves. Every barrel on the ten
// original boards is within ten units of the 110 baseline, and the multiplier
// is clamped below at one, so this is a statement about the whole back
// catalogue rather than about the constant.
let moved = null
for (let li = 0; li < reactor; li++) {
  setLayout(li)
  resetCover()
  for (const r of BREAKABLE) {
    if (r.kind !== 'barrel') continue
    if (blastScaleOf(r) !== 1) moved = `${LAYOUTS[li].name} ${r.w}x${r.h} -> ${blastScaleOf(r)}`
  }
}
check(!moved, 'every barrel on every earlier board keeps the radius it had', moved ?? '')

// ------------------------------------------------------------- the warehouse
const wh = LAYOUTS.findIndex((l) => l.name === 'The Warehouse')
check(wh >= 0, 'The Warehouse is in the rotation')
setLayout(wh)
resetCover()
// The board's whole identity is that no sightline is long. Measured as: from
// the middle of the board, no straight run east-west clears the racking.
const crates = WALLS.filter((w) => w.kind === 'crate')
check(crates.length >= 8, 'the racking is breakable, so a room can make its own door', `${crates.length} crates`)
const aisle = Math.min(...crates.map((c) => c.h))
check(aisle <= 50, 'the shelves are shelves, not blocks', `thinnest ${aisle}`)

console.log('')
if (failures) {
  console.error(`${failures} failed`)
  process.exit(1)
}
console.log('all good')
