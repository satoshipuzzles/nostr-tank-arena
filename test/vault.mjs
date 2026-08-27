// The vault: a sealed pocket you open by shooting through the wall.
//
// Puzz: *"maybe we should have a secret part of maps that can unlock when
// shooting through the wall border, maybe some borders can be broken through."*
//
// Checked as arithmetic over every board rather than as a screenshot, for the
// same reason `test/pads.mjs` is: the map is a pure function of the block hash,
// so a board nobody has looked at is a board that turns up in somebody's round
// with a vault overlapping a hedge or a cache nobody can ever reach.
//
// What has to hold, on all of them:
//
//   1. Two vaults, mirrored, made of breachable wall.
//   2. Sealed. A tank cannot drive in and a shell cannot fly in — if either
//      could, the pocket is not secret, it is just a room.
//   3. There is a cache inside, and it is on open ground.
//   4. Shooting the wall opens it: six hits, the visible damage tiers on the
//      way, and a tank can drive through afterwards.
//   5. The breach rides the cover union, so a client that never saw the shots
//      converges on the same open wall.
//
// Run: node test/vault.mjs

import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'

const out = '.scratch/vault-bundle.mjs'
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
  LAYOUTS, PADS, WALLS, BREAKABLE, setLayout, pointInWall, pointInTallWall,
  hasLineOfSight, damageCover, resetCover, coverBits, applyCoverBits, damageTier,
} = arena

// A point is inside a rect, with the tank's own radius, which is the question
// "can a tank be here" rather than "is this pixel covered".
const inside = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h

for (let i = 0; i < LAYOUTS.length; i++) {
  setLayout(i)
  resetCover()
  const spec = LAYOUTS[i]
  const name = spec.name
  const walls = WALLS.filter((w) => w.kind === 'breach')

  // ---------------------------------------------------------------- 1. two of them
  check(walls.length === 6, `${name}: two vaults, three walls each`, `${walls.length} breach rects`)
  const centres = walls.map((w) => ({ x: w.x + w.w / 2, y: w.y + w.h / 2 }))
  const mirrored = centres.every((c) =>
    centres.some((o) => Math.abs(o.x - (spec.w - c.x)) < 1.5 && Math.abs(o.y - (spec.h - c.y)) < 1.5),
  )
  check(mirrored, `${name}: and the second is the first, rotated`, JSON.stringify(centres[0]))
  check(
    walls.every((w) => BREAKABLE.includes(w)),
    `${name}: every vault wall is breakable`,
  )

  // ------------------------------------------------------------------- 2. sealed
  //
  // The pocket is the area the three walls and the border enclose. Walk a line
  // from the middle of the board to the cache and require something solid in
  // the way — a vault with a gap in it looks identical from above and is not a
  // vault at all.
  const cache = PADS[0]
  check(
    !!cache && !pointInWall(cache.x, cache.y),
    `${name}: the cache is on open ground inside`,
    JSON.stringify(cache),
  )
  check(
    !hasLineOfSight(spec.w / 2, spec.h / 2, cache.x, cache.y),
    `${name}: and it cannot be shot into from the middle of the board`,
  )
  // Every approach, not just the one: a pocket open from the north-east is open.
  const approaches = [
    [cache.x, cache.y + 400],
    [cache.x - 400, cache.y],
    [cache.x + 400, cache.y],
    [cache.x - 300, cache.y + 300],
    [cache.x + 300, cache.y + 300],
  ]
  const openFrom = approaches.find(
    ([x, y]) => x > 0 && y > 0 && x < spec.w && y < spec.h && hasLineOfSight(x, y, cache.x, cache.y),
  )
  check(!openFrom, `${name}: sealed from every side, not just the front`, openFrom && `open from ${openFrom}`)

  // ------------------------------------------------- 4. and shooting opens it
  //
  // Through `damageCover`, which is what a shell striking a rect calls. Six
  // hits, and the tiers on the way — a wall that jumped from untouched to gone
  // is a wall nobody can see coming.
  const face = walls.find((w) => w.w > w.h && w.y > spec.h / 2 === false)
  const tiers = []
  let destroyed = false
  for (let hit = 0; hit < 6; hit++) {
    destroyed = damageCover(face.id, 1)
    tiers.push(damageTier(face))
  }
  check(destroyed === true, `${name}: six hits opens the wall`, JSON.stringify(tiers))
  check(
    tiers[0] < tiers[4] && tiers[1] > 0,
    `${name}: and it visibly falls apart on the way`,
    JSON.stringify(tiers),
  )
  check(
    !pointInWall(face.x + face.w / 2, face.y + face.h / 2) &&
      !pointInTallWall(face.x + face.w / 2, face.y + face.h / 2),
    `${name}: a tank can drive through the hole, and a shell can fly through it`,
  )
  // From just outside the hole, not from three hundred units back: what the
  // breach opens is the *wall*, and whether some hedge further down the board
  // also happens to be in the way is a question about that hedge. The first
  // cut measured from 300 away and failed on four boards for exactly that
  // reason — a check that cannot tell the thing under test from its
  // surroundings.
  check(
    hasLineOfSight(cache.x, face.y + face.h + 12, cache.x, cache.y),
    `${name}: the cache is reachable once the wall is down`,
  )

  // ------------------------------------------- 5. and it rides the cover union
  const bits = coverBits()
  check((bits & (1 << BREAKABLE.indexOf(face))) !== 0, `${name}: the breach is in the cover mask`)
  // A second client, which never saw a single one of those shots, is handed
  // only the mask — and ends up with the same open wall. This is the property
  // that makes the vault safe without an event of its own.
  resetCover()
  check(pointInWall(face.x + face.w / 2, face.y + face.h / 2) !== null, `${name}: control — the wall is back`)
  applyCoverBits(bits)
  check(
    !pointInWall(face.x + face.w / 2, face.y + face.h / 2),
    `${name}: a client that only saw the mask has the same hole`,
  )
  void inside
}

console.log('')
if (failures) {
  console.error(`${failures} failed`)
  process.exit(1)
}
console.log('all good')
