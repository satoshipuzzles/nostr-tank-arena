// Barrels you can shoot away.
//
// Puzz: "Walls and obstacles can be damaged and blown up. Barrels can be blown
// up after x amount of hits."
//
// The interesting half of this is not "a counter goes down". It is that a
// destroyed barrel is a *change to the shared board*, and every other thing in
// this game that changes the shared board is derived from the block hash and
// therefore identical on every client by construction. This one is not: it
// comes from a shell somebody fired, so it has to converge on its own.
//
// Two mechanisms, and this suite exists to hold both of them honest:
//
//   1. Every client re-simulates every shell from the same fire event through
//      the same layout, so they all reach the same rect and all take the same
//      hits out of it. `damageCover` is idempotent past zero so the duplicate
//      calls cost nothing.
//   2. What (1) cannot cover is a shell one client deleted early — a hit on an
//      interpolated tank lands a few pixels apart on different screens, so a
//      barrel directly behind somebody can take a hit on one client and not on
//      another. The destroyed set therefore rides on the state tick as a
//      bitmask and is **unioned**, never replaced: order-independent,
//      idempotent, impossible to un-set, and self-healing for a late joiner.
//
// So the checks below are mostly about the union, and every one of them has a
// control — a barrel that should still be standing, a mask that should change
// nothing, a round boundary that should put everything back.
//
//   npm run test:barrels

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const out = join(mkdtempSync(join(tmpdir(), 'barrels-')), 'barrels.mjs')
await build({
  entryPoints: ['test/barrels-entry.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'error',
})
const {
  BARRELS, BARREL_HP, WALLS, applyCoverBits, coverBits, coverGeneration,
  damageCover, resetCover, setLayout, pointInTallWall, isLow,
  spawnShell, stepShell,
} = await import(out)

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

/** A layout that actually has barrels on it, or nothing below means anything. */
let layout = -1
for (let i = 0; i < 8 && layout < 0; i++) {
  setLayout(i)
  if (BARRELS.length >= 2) layout = i
}
check('there is a layout with barrels to shoot at', layout >= 0 && BARRELS.length >= 2,
  `layout ${layout}, ${BARRELS.length} barrels`)
setLayout(layout)
resetCover()

// -------------------------------------------------------------- the hit count

{
  const b = BARRELS[0]
  check('a barrel starts intact and full', b.gone === false && b.hp === BARREL_HP, `hp=${b.hp}`)

  // A rock in the same board must not be destructible, or this is a check about
  // `damageCover` returning false rather than about barrels being special.
  const rock = WALLS.find((w) => w.kind === 'rock')
  const rockGone = rock ? damageCover(rock.id, 99) : null
  check('the control: a rock takes no damage at all',
    rock !== undefined && rockGone === false && rock.gone === false && rock.hp === undefined,
    `kind=${rock?.kind} hp=${rock?.hp} gone=${rock?.gone}`)

  const steps = []
  for (let i = 0; i < BARREL_HP; i++) steps.push(damageCover(b.id, 1))
  check(
    `it takes exactly ${BARREL_HP} hits, and only the last one destroys it`,
    steps.slice(0, -1).every((v) => v === false) && steps[steps.length - 1] === true,
    JSON.stringify(steps),
  )
  check('and it is gone afterwards', b.gone === true && b.hp === 0, `hp=${b.hp}`)

  // Idempotent past zero. Every client simulating the same shell calls this, so
  // the extra calls have to be worth nothing rather than reaching further.
  check('extra hits on a destroyed barrel do nothing', damageCover(b.id, 5) === false)
}

// ---------------------------------------------------------------- collision

{
  resetCover()
  const b = BARRELS[1]
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  check('an intact barrel stops a shell', pointInTallWall(cx, cy) !== null)
  check('the control: and it was never a barricade shells fly over', isLow(b) === false)
  damageCover(b.id, BARREL_HP)
  check('and once it is gone, the same point is open air', pointInTallWall(cx, cy) === null)
  resetCover()
  check('the control: and it stops shells again after a round reset',
    pointInTallWall(cx, cy) !== null)
}

// ------------------------------------------------------------- a real shell

{
  resetCover()
  const b = BARRELS[0]
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  // Fire straight into it from clear ground to the west, far enough out that
  // the shell is genuinely travelling. Scan outward for a launch point with a
  // clear run, so this is not a claim about one board's furniture.
  let from = null
  for (let d = 120; d <= 400 && !from; d += 20) {
    const p = { x: cx - b.w / 2 - d, y: cy }
    let clear = p.x > 40
    for (let t = 0; t < d - 8 && clear; t += 8) if (pointInTallWall(p.x + t, p.y)) clear = false
    if (clear) from = p
  }
  check('found a clear lane into a barrel', !!from, from ? `${Math.round(from.x)},${Math.round(from.y)}` : 'none')

  const fire = () => {
    const s = spawnShell('s' + Math.random(), 'owner', from.x, from.y, 0, 1, 1, 0)
    for (let i = 0; i < 400 && !s.dead && s.struck < 0; i++) stepShell(s, 1 / 120)
    return s
  }
  const first = fire()
  check('a shell fired at a barrel reports which rect it hit',
    first.struck === b.id, `struck=${first.struck} barrel=${b.id}`)

  // And the control: with the barrel gone, the same shot must sail through it
  // rather than reporting the same id. This is what proves `struck` is reading
  // the live board and not the layout it was built from.
  damageCover(b.id, BARREL_HP)
  const after = fire()
  check('the control: with the barrel gone, the same shot no longer hits it',
    after.struck !== b.id, `struck=${after.struck}`)
  resetCover()
}

// ----------------------------------------------------------------- the union

{
  resetCover()
  check('the mask is empty on an intact board', coverBits() === 0)

  damageCover(BARRELS[0].id, BARREL_HP)
  const oneGone = coverBits()
  check('and it names the barrel that went', oneGone === 1, `bits=${oneGone}`)

  // Somebody else saw a different one go. Union, so both end up destroyed.
  const taken = applyCoverBits(1 << 1)
  check('a peer mask takes out a barrel we had not seen go',
    taken.length === 1 && BARRELS[1].gone === true, `${taken.length} taken`)
  check('and ours is still gone — a union cannot un-set',
    BARRELS[0].gone === true && coverBits() === 0b11, `bits=${coverBits()}`)

  // Idempotent and order-independent. Replaying an older, smaller mask must not
  // resurrect anything: relays deliver out of order, and a tick from before a
  // barrel went is guaranteed to arrive after one from after it.
  const before = coverBits()
  const again = applyCoverBits(1)
  check('replaying an older mask changes nothing',
    again.length === 0 && coverBits() === before, `bits=${coverBits()}`)

  // A barrel we have never heard of. The mask is over `BARRELS` order, so a bit
  // past the end of this board must be ignored rather than throwing or
  // wrapping onto a real barrel.
  const overflow = applyCoverBits(1 << 30)
  check('the control: a bit past the end of the board is ignored',
    overflow.length === 0 && coverBits() === before, `bits=${coverBits()}`)

  // A late joiner: fresh board, one tick, caught up.
  resetCover()
  check('the control: a fresh client starts with an intact board', coverBits() === 0)
  applyCoverBits(before)
  check('and one tick from anybody catches it up to the room',
    coverBits() === before, `bits=${coverBits()} wanted=${before}`)
}

// ------------------------------------------------------------ round boundary

{
  resetCover()
  damageCover(BARRELS[0].id, BARREL_HP)
  damageCover(BARRELS[1].id, 1)
  check('a partly-shot board reports its holes', coverBits() === 1 && BARRELS[1].hp === BARREL_HP - 1)
  resetCover()
  check('a new round puts every barrel back, including the dented one',
    coverBits() === 0 && BARRELS.every((b) => b.gone === false && b.hp === BARREL_HP))

  // The case that made `resetCover` necessary rather than leaving it to
  // `setLayout`: the map is `blockHash % 8`, so two rounds in a row land on the
  // same board about one time in eight, and `setLayout` returns early when the
  // index has not changed.
  damageCover(BARRELS[0].id, BARREL_HP)
  setLayout(layout)
  check('the control: re-selecting the same layout does NOT rebuild the board',
    coverBits() === 1, `bits=${coverBits()}`)
  resetCover()
  check('which is why a round reset is its own call', coverBits() === 0)
}

// --------------------------------------------------------------- generation

{
  resetCover()
  const a = coverGeneration()
  damageCover(BARRELS[0].id, 1)
  const b = coverGeneration()
  check('a hit moves the generation, so the renderer knows to look', b !== a, `${a} -> ${b}`)
  const c = coverGeneration()
  applyCoverBits(0)
  check('the control: a mask that changes nothing does not move it',
    coverGeneration() === c, `${c} -> ${coverGeneration()}`)
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall good')
process.exit(failures.length ? 1 : 0)
