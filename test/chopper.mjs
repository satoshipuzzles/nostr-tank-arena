// The gunship's arithmetic.
//
// Puzz: "10kills — Chopper: Man a machinegun flying over the map for 10
// seconds."
//
// Everything here is about the two numbers that cross the wire — where the
// chopper is and where its rounds are landing — because those are the only
// things another client is given and everything else it draws or suffers is
// derived from them. In particular the reach is clamped by `chopperAim`, which
// runs on the shooter *and* on every receiver: a reach enforced only by the
// client doing the shooting is a reach a modified client does not have, and
// that is the one rule in this feature a cheater would go for first.
//
// Every check has a control, and the controls are the point: "a tank at the
// aim point is hit" means nothing without "a tank a little further out is not".
//
//   npm run test:chopper

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const out = join(mkdtempSync(join(tmpdir(), 'chop-')), 'chopper.mjs')
await build({
  entryPoints: ['test/chopper-entry.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'error',
})
const {
  CHOPPER_ALT, CHOPPER_HIT_MS, CHOPPER_MS, CHOPPER_REACH, CHOPPER_SPEED, CHOPPER_SPREAD,
  chopperAim, stepChopper, underFire, ARENA_W, ARENA_H, setLayout,
} = await import(out)

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

setLayout(0)

// ------------------------------------------------------------------ the numbers

// Twenty, not the ten this originally asserted: Puzz asked for it to be
// doubled after calling the chopper "the funniest thing ever", and `CHOPPER_MS`
// says so in a comment above the constant. The assertion is kept rather than
// deleted — the intent, that the duration is a decision somebody made on
// purpose and not a number that drifts, is still worth guarding. Not my change;
// found red on main while shipping the juggernaut suit.
check('it is up for the twenty seconds Puzz asked for', CHOPPER_MS === 20_000, `${CHOPPER_MS}ms`)
check('and it moves faster than a tank, or it is a tank you cannot shoot',
  CHOPPER_SPEED > 175, `${CHOPPER_SPEED} vs a tank's 175`)
check('and it flies above the cover rather than through it',
  CHOPPER_ALT > 100, `${CHOPPER_ALT} up`)
// One hull point per interval, so three intervals kill a full tank. Anything
// much faster and a target that starts running immediately still dies, which
// removes the only counterplay this weapon has.
check('a full hull survives long enough to run out from under it',
  CHOPPER_HIT_MS * 3 > 1200, `3 hits takes ${(CHOPPER_HIT_MS * 3) / 1000}s`)
check('and the gun does not reach the whole board, so flying is still the job',
  CHOPPER_REACH < Math.min(ARENA_W, ARENA_H), `${CHOPPER_REACH} on a ${ARENA_W}x${ARENA_H} board`)

// -------------------------------------------------------------------- the reach

{
  const x = 800
  const y = 600
  // Inside the reach: the point is exactly what was asked for.
  const near = chopperAim(x, y, x + 200, y)
  check('a point inside the reach is aimed at exactly',
    Math.round(near.x) === x + 200 && Math.round(near.y) === y, JSON.stringify(near))

  // Outside: pulled back to the ring, on the same bearing. Both halves matter —
  // a clamp that lands the rounds somewhere else entirely would be a different
  // bug wearing the same green tick.
  const far = chopperAim(x, y, x + 5000, y)
  const d = Math.hypot(far.x - x, far.y - y)
  check('a point past the reach is pulled back to it',
    Math.abs(d - CHOPPER_REACH) < 1, `${d.toFixed(1)} against ${CHOPPER_REACH}`)
  check('and stays on the bearing it was asked for',
    Math.abs(far.y - y) < 1 && far.x > x, JSON.stringify(far))

  // Diagonally, where a naive per-axis clamp gives a different answer.
  const diag = chopperAim(x, y, x + 4000, y + 4000)
  const dd = Math.hypot(diag.x - x, diag.y - y)
  const bearing = Math.atan2(diag.y - y, diag.x - x)
  check('the clamp is radial, not per-axis',
    Math.abs(dd - CHOPPER_REACH) < 1 && Math.abs(bearing - Math.PI / 4) < 0.01,
    `${dd.toFixed(1)} at ${bearing.toFixed(3)} rad`)

  // Never off the board, even when the reach would allow it.
  const corner = chopperAim(60, 60, -9000, -9000)
  check('and it never lands off the board',
    corner.x >= 0 && corner.y >= 0 && corner.x <= ARENA_W && corner.y <= ARENA_H,
    JSON.stringify(corner))

  // The claim this whole function exists for: a receiver clamping the same
  // numbers gets the same answer as the shooter. If it did not, the person
  // being shot and the person shooting would disagree about where the rounds
  // are, and the person being shot is the one who applies the damage.
  const shooter = chopperAim(x, y, x + 5000, y + 1200)
  const receiver = chopperAim(x, y, x + 5000, y + 1200)
  check('shooter and receiver clamp to the same point',
    shooter.x === receiver.x && shooter.y === receiver.y, JSON.stringify(shooter))
  // And a receiver handed an *unclamped* claim reaches the same place as one
  // handed the clamped version — which is what makes it safe to trust neither.
  const relayed = chopperAim(x, y, shooter.x, shooter.y)
  check('and re-clamping an already-clamped point changes nothing',
    Math.abs(relayed.x - shooter.x) < 0.001 && Math.abs(relayed.y - shooter.y) < 0.001,
    JSON.stringify(relayed))
}

// -------------------------------------------------------------------- the spread

{
  const ax = 700
  const ay = 500
  check('a tank on the aim point is under it', underFire(ax, ay, ax, ay))
  check('and one just inside the ring is too',
    underFire(ax, ay, ax + CHOPPER_SPREAD - 2, ay))
  check('the control: one just outside is not',
    underFire(ax, ay, ax + CHOPPER_SPREAD + 2, ay) === false)
  // Radial again — the corner of the bounding box is outside the circle, and a
  // square hitbox here would quietly make the gun 40% wider on the diagonal.
  const diag = CHOPPER_SPREAD * 0.75
  check('the control: the corner of the box is not the edge of the circle',
    underFire(ax, ay, ax + diag, ay + diag) === false,
    `${Math.round(Math.hypot(diag, diag))} out against a ${CHOPPER_SPREAD} radius`)
  check('and it is wider than a tank, so a moving target is hit sometimes',
    CHOPPER_SPREAD > 22, `${CHOPPER_SPREAD} against a 22 tank radius`)
}

// --------------------------------------------------------------------- the flying

{
  const pos = { x: 800, y: 600 }
  const dt = 1 / 60
  // Screen-space: push right, go right. There is no hull to be relative to.
  for (let i = 0; i < 60; i++) stepChopper(pos, 0, 1, dt)
  check('pushing right moves it right and nowhere else',
    pos.x > 800 + CHOPPER_SPEED * 0.8 && Math.abs(pos.y - 600) < 1, JSON.stringify(pos))

  const up = { x: 800, y: 600 }
  for (let i = 0; i < 60; i++) stepChopper(up, 1, 0, dt)
  check('and pushing up moves it up the board',
    up.y < 600 - CHOPPER_SPEED * 0.8 && Math.abs(up.x - 800) < 1, JSON.stringify(up))

  // Diagonal must not be faster than straight, which is what an unnormalised
  // stick read gives you — and it is the classic way a vehicle ends up with a
  // 41% speed boost nobody designed.
  const straight = { x: 800, y: 600 }
  const angled = { x: 800, y: 600 }
  for (let i = 0; i < 60; i++) {
    stepChopper(straight, 0, 1, dt)
    stepChopper(angled, 1, 1, dt)
  }
  const sd = Math.hypot(straight.x - 800, straight.y - 600)
  const ad = Math.hypot(angled.x - 800, angled.y - 600)
  check('the control: flying diagonally is not faster than flying straight',
    ad <= sd + 1, `${ad.toFixed(1)} diagonal against ${sd.toFixed(1)} straight`)

  // The board holds it. A gunship off the map is a player who cannot see
  // anything for the rest of their ten seconds.
  const runaway = { x: 800, y: 600 }
  for (let i = 0; i < 600; i++) stepChopper(runaway, -1, -1, dt)
  check('and it cannot fly off the board',
    runaway.x > 0 && runaway.y > 0 && runaway.x < ARENA_W && runaway.y < ARENA_H,
    JSON.stringify(runaway))

  // A stick at rest does nothing, which is not as obvious as it sounds: the
  // normalisation above divides by the magnitude.
  const still = { x: 800, y: 600 }
  for (let i = 0; i < 60; i++) stepChopper(still, 0, 0, dt)
  check('the control: a stick at rest leaves it where it is',
    still.x === 800 && still.y === 600, JSON.stringify(still))
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall good')
process.exit(failures.length ? 1 : 0)
