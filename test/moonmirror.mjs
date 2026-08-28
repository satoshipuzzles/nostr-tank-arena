// Two boards, two rules: free ricochets off glass, and half gravity on a lob.
//
// Both are arithmetic over the real simulation — `stepShell` and `lobRange`
// are pure functions of the board and the fire event, which is the only reason
// this game can be played over relays that store nothing. So they can be
// checked exhaustively without a browser, and they have to be, because both
// rules are the kind that fail *silently*: a mirror that charges for its
// bounce just looks like a shell that stopped, and a lob clamped by the
// receiver lands in a different crater on two screens and nobody sees a bug at
// all, only a shot that "missed".
//
// Run: node test/moonmirror.mjs

import { build } from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'

const out = '.scratch/moonmirror-bundle.mjs'
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
  LAYOUTS, WALLS, BREAKABLE, setLayout, resetCover, damageCover, reflects,
  spawnShell, stepShell, shellHeight, apexOf, lobRange,
  LOB_MIN, LOB_MAX, LOB_APEX, SHELL_BOUNCES, MIRROR_HP,
} = arena

// Read through the namespace, never destructured: `arenaGravity` is a live
// binding that `setLayout` reassigns, and a copy taken at import time is
// frozen at whatever board the module happened to load with. That copy read 1
// on the moon and the two checks against it failed while the game was in fact
// correct — the sort of green-or-red that is about the harness rather than the
// code, in both directions.
const gravity = () => arena.arenaGravity

const boardNamed = (name) => {
  const i = LAYOUTS.findIndex((l) => l.name === name)
  setLayout(i)
  resetCover()
  return i
}

// Fly a shell and report what became of it.
const fly = (x, y, angle, seconds = 3.5) => {
  const s = spawnShell('t' + Math.random(), 'me', x, y, angle)
  const struck = new Set()
  // Ricochets, counted by what they came off. `s.struck` holds the last rect
  // hit, so a change in it is a new impact — and the distinction between a
  // mirror impact and any other is the entire rule under test.
  let glass = 0
  let hard = 0
  let last = -1
  for (let i = 0; i < Math.round(seconds * 120) && !s.dead; i++) {
    const before = s.struck
    stepShell(s, 1 / 120)
    if (s.struck >= 0 && (s.struck !== last || s.struck !== before)) {
      struck.add(s.struck)
      // Only impacts the shell *survived*. Counting the fatal one too would
      // let "it came off the glass three times" pass against a build where the
      // third one killed it, which is exactly the bug this file is here for —
      // the tally would move either way and could not tell them apart.
      if (!s.dead) {
        if (WALLS[s.struck]?.kind === 'mirror') glass++
        else hard++
      }
      last = s.struck
    }
  }
  return { s, struck, glass, hard }
}

// ---------------------------------------------------------------- the solar farm

boardNamed('The Solar Farm')
const panels = WALLS.filter((w) => w.kind === 'mirror')
check(panels.length >= 8, 'the board is made of panels', `${panels.length} mirror rects`)
check(panels.every((p) => BREAKABLE.includes(p)), 'and every one of them can be broken')
check(
  panels.every((p) => p.hp === MIRROR_HP) && MIRROR_HP < 3,
  'glass is the softest thing on the board',
  `hp ${panels[0]?.hp} against a barrel's 3`,
)

// The corridor: the gap between the two long panels in the first half. A shell
// fired down it at a shallow angle has to survive more bounces than its budget.
const [top, bottom] = panels
  .filter((p) => p.w > p.h)
  .sort((a, b) => a.y - b.y)
  .slice(0, 2)
check(!!top && !!bottom && bottom.y > top.y + top.h, 'there is a corridor between two panel rows',
  top && bottom ? `${top.y + top.h} to ${bottom.y}` : 'no pair')

const mid = (top.y + top.h + bottom.y) / 2
const shot = fly(top.x + 12, mid, 0.34)
// The claim, stated as the thing that would change: the shell survives more
// ricochets off glass than its whole bounce budget. With SHELL_BOUNCES at one,
// two is already impossible for an ordinary wall.
check(
  shot.glass > SHELL_BOUNCES,
  'a shell survives more ricochets down the corridor than its whole budget',
  `${shot.glass} off glass, ${shot.hard} off anything else, budget ${SHELL_BOUNCES}`,
)
check(
  shot.s.bounces <= shot.hard,
  'and none of the glass was charged for',
  `bounces ${shot.s.bounces} against ${shot.hard} hard hits`,
)
check(
  shot.s.age > 1,
  'so it lives on rather than dying on the first panel',
  `dead ${shot.s.dead} at ${shot.s.age.toFixed(2)}s after ${shot.glass} panels`,
)

// The control, and the reason the number above means anything: the same shot
// at ordinary cover spends its one bounce and dies on the second wall. If this
// passed too, `reflects` could be returning true for everything.
const rock = WALLS.find((w) => w.kind === 'rock')
const wall = fly(rock.x - 300, rock.y + rock.h / 2, 0)
check(
  wall.s.bounces >= 1 && wall.hard >= 1,
  'the control — an ordinary rect still charges for its ricochet',
  `bounces ${wall.s.bounces} off ${wall.hard} hard hits, budget ${SHELL_BOUNCES}`,
)

// And breaking the glass takes the geometry away, which is the counter-play.
const panel = panels[0]
damageCover(panel.id, MIRROR_HP)
check(panel.gone === true, 'two hits and a panel is gone', `hp ${panel.hp}`)
check(reflects(panel) === false, 'and a broken panel reflects nothing')
resetCover()
check(reflects(panels[0]) === true, 'a fresh one does', `kind ${panels[0].kind}`)
check(
  WALLS.filter((w) => w.kind !== 'mirror').every((w) => !reflects(w)),
  'and nothing else on any board does',
)

// ------------------------------------------------------------------ moon base

boardNamed('Moon Base')
check(gravity() === 0.5, 'the moon pulls half as hard', `gravity ${gravity()}`)
const moonMax = lobRange(1)
const moonMin = lobRange(0)
check(
  Math.abs(moonMax - LOB_MAX * 2) < 1 && Math.abs(moonMin - LOB_MIN * 2) < 1,
  'so the same charge throws about twice as far',
  `${Math.round(moonMin)}..${Math.round(moonMax)} against ${LOB_MIN}..${LOB_MAX}`,
)
// Twice as far at the same speed is twice as long in the air, which is the
// half of the ask a range on its own does not cover.
const hang = (range) => {
  const s = spawnShell('l' + Math.random(), 'me', 300, 300, 0, 1, 1, range)
  let t = 0
  while (!s.dead && t < 12) { stepShell(s, 1 / 120); t += 1 / 120 }
  return t
}
const moonHang = hang(moonMax)
const earthHang = hang(LOB_MAX)
check(
  moonHang > earthHang * 1.9,
  'and hangs about twice as long',
  `${moonHang.toFixed(2)}s against ${earthHang.toFixed(2)}s`,
)
// The arc goes with it. A 1240-unit lob drawn at the ordinary apex is a flat
// skim, which is the one thing a mortar must not look like.
const high = spawnShell('h', 'me', 300, 300, 0, 1, 1, moonMax)
high.travel = moonMax / 2
const flat = spawnShell('f', 'me', 300, 300, 0, 1, 1, LOB_MAX)
flat.travel = LOB_MAX / 2
check(
  shellHeight(high) > shellHeight(flat) * 1.9,
  'the arc is twice as high too',
  `${shellHeight(high).toFixed(0)} against ${shellHeight(flat).toFixed(0)}`,
)

// The thing that would be a divergence rather than a balance problem. The
// receiver clamps an incoming lob, and it has to clamp against *this board's*
// bound — a receiver still using 620 would put the crater 600 units short of
// where the shooter put it, and the victim is the one who applies the damage.
for (let i = 0; i < LAYOUTS.length; i++) {
  setLayout(i)
  const g = gravity()
  const bound = lobRange(1)
  if (Math.abs(bound - LOB_MAX / g) > 0.001) {
    check(false, `${LAYOUTS[i].name}: the clamp bound follows the board`, `${bound} for gravity ${g}`)
  }
}
check(true, 'every board clamps an incoming lob against its own gravity')

// Everywhere else is untouched, which is the claim that keeps this from being
// a balance change to thirteen boards.
let moved = null
for (let i = 0; i < LAYOUTS.length; i++) {
  setLayout(i)
  if (LAYOUTS[i].name === 'Moon Base') continue
  if (gravity() !== 1) moved = `${LAYOUTS[i].name} gravity ${gravity()}`
  if (Math.abs(lobRange(1) - LOB_MAX) > 0.001) moved = `${LAYOUTS[i].name} max ${lobRange(1)}`
  const s = spawnShell('e', 'me', 300, 300, 0, 1, 1, LOB_MAX)
  s.travel = LOB_MAX / 2
  if (Math.abs(apexOf(s) - LOB_APEX) > 0.001) moved = `${LAYOUTS[i].name} apex ${apexOf(s)}`
}
check(!moved, 'every other board throws exactly as far as it did', moved ?? '')

console.log('')
if (failures) {
  console.error(`${failures} failed`)
  process.exit(1)
}
console.log('all good')
