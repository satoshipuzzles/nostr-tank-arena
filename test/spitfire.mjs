// The spitfire's flight plan, as arithmetic.
//
//   npm run test:spitfire
//
// The whole design rides on one claim: the pass is a pure function of a corner
// and a clock, so the plane every client draws and the gun every client ducks
// are the same object. That function has to enter off the board, cross it
// corner to corner, leave the far side, and say it is done — on every board,
// from every corner. And "slower bullets than the chopper" is a number, so it
// is checked as one.

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const out = join(mkdtempSync(join(tmpdir(), 'spitfire-')), 'spitfire.mjs')
await build({
  entryPoints: ['test/spitfire-entry.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'error',
})
const S = await import(out)

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

const onBoard = (p) => p.x >= 0 && p.x <= S.ARENA_W && p.y >= 0 && p.y <= S.ARENA_H

// ------------------------------------------------- the pass, on every board

for (const layout of [0, S.LAYOUTS.length - 1]) {
  S.setLayout(layout)
  const name = S.LAYOUTS[layout].name
  for (const corner of [0, 1, 2, 3]) {
    const from = S.cornerAt(corner)
    const to = S.cornerAt((corner + 2) % 4)
    const start = S.spitfirePos(corner, 0)
    check(
      `${name}, corner ${corner}: the plane starts off the board`,
      !onBoard(start) && Math.hypot(start.x - from.x, start.y - from.y) <= S.SPITFIRE_MARGIN + 1,
      `start ${Math.round(start.x)},${Math.round(start.y)} near ${from.x},${from.y}`,
    )
    // Walk the pass at 60fps and record what it does.
    let entered = false
    let exited = false
    let midMiss = Infinity
    let done = null
    for (let t = 0; t < 40_000; t += 1000 / 60) {
      const p = S.spitfirePos(corner, t)
      if (p.done) {
        done = { t, p }
        break
      }
      if (onBoard(p)) entered = true
      if (entered && !onBoard(p)) exited = true
      const mx = S.ARENA_W / 2
      const my = S.ARENA_H / 2
      midMiss = Math.min(midMiss, Math.hypot(p.x - mx, p.y - my))
    }
    check(`  and crosses the board`, entered, '')
    check(
      `  through the middle — it is the diagonal`,
      midMiss < 20,
      `closest approach to centre ${Math.round(midMiss)}`,
    )
    check(
      `  and leaves past the far corner before calling itself done`,
      exited && !!done && Math.hypot(done.p.x - to.x, done.p.y - to.y) >= S.SPITFIRE_MARGIN - 20,
      done ? `done at ${Math.round(done.t)}ms, ${Math.round(done.p.x)},${Math.round(done.p.y)}` : 'never done',
    )
    // The duration is length over speed — no hidden clock.
    const expect = ((Math.hypot(S.ARENA_W, S.ARENA_H) + 2 * S.SPITFIRE_MARGIN) / S.SPITFIRE_SPEED) * 1000
    check(
      `  in the time the speed says it should take`,
      !!done && Math.abs(done.t - expect) < 50,
      `${Math.round(done?.t ?? -1)}ms vs ${Math.round(expect)}ms`,
    )
  }
}
S.setLayout(0)

// ------------------------------------------------------------------- the gun

check(
  'the guns fire slower than the chopper\'s — that is the design brief',
  S.SPITFIRE_HIT_MS > S.CHOPPER_HIT_MS,
  `${S.SPITFIRE_HIT_MS}ms per hit vs the chopper's ${S.CHOPPER_HIT_MS}ms`,
)
check(
  'a tank under the plane is under the guns',
  S.underStrafe(500, 500, 500 + S.SPITFIRE_SPREAD - 1, 500) === true &&
    S.underStrafe(500, 500, 500 + S.SPITFIRE_SPREAD + 1, 500) === false,
  `footprint ${S.SPITFIRE_SPREAD}`,
)
check(
  'the corner survives the wire and garbage does not',
  S.asCorner(2) === 2 && S.asCorner(4) === null && S.asCorner('1') === null && S.asCorner(null) === null,
)

// One stationary tank on the diagonal takes exactly one hit from a clean pass:
// the footprint sweeps over it faster than the gun's cooldown. This is what
// "one pass, one chance" means as arithmetic.
{
  const windowMs = ((2 * S.SPITFIRE_SPREAD) / S.SPITFIRE_SPEED) * 1000
  check(
    'a crossed tank is under the guns for less than one cooldown — one hit, not a beam',
    windowMs < S.SPITFIRE_HIT_MS,
    `${Math.round(windowMs)}ms under fire vs ${S.SPITFIRE_HIT_MS}ms between hits`,
  )
}

console.log(failures.length ? `\n${failures.length} failed\n` : '\nAll spitfire checks passed.\n')
process.exit(failures.length ? 1 : 0)
