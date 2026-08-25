// Practice tanks.
//
// Puzz's backlog: "Bot tanks, so a solo player has something to shoot at."
//
// The behaviour is pure arithmetic against the arena, so most of this runs in
// Node against the built module. What it has to establish is not "a bot exists"
// — that is a `length` — but that a bot is an *opponent*: it moves, it closes
// the distance, it leads a moving target, it misses sometimes, and it stops
// existing the moment a real player is in the room.
//
// The last one is the load-bearing check and it is the one with teeth. Bots are
// local: nobody else on the relay can see them. Two clients in the same room
// each spawn their own, so a bot that outlives the arrival of a real player is
// a permanent divergence between two screens — the local player is shooting at
// something the other client will never render and will never agree died.
//
// Every check here has a control. A bot that drives is only interesting against
// one that was asked to drive nowhere; a lead is only a lead if it differs from
// pointing straight at the target.
//
//   npm run test:bots

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const out = join(mkdtempSync(join(tmpdir(), 'bots-')), 'bots.mjs')
await build({
  entryPoints: ['test/bots-entry.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'error',
})
const { BOT_COUNT, makeBot, stepBot, killBot, SPAWNS, ARENA_W, ARENA_H, hasLineOfSight } =
  await import(out)

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

const DT = 1 / 60
/** Run a bot for `seconds`, collecting every shot it took. */
function run(bot, target, seconds, now0 = 0) {
  const shots = []
  const path = []
  let now = now0
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    now += DT * 1000
    const a = stepBot(bot, target, DT, now, 3, 1)
    if (a.fire !== null) shots.push({ at: now, angle: a.fire, from: { x: bot.tank.x, y: bot.tank.y } })
    path.push({ x: bot.tank.x, y: bot.tank.y })
  }
  return { shots, path, now }
}

const still = (x, y) => ({ x, y, vx: 0, vy: 0, dead: false })

// ------------------------------------------------------------------ it moves

{
  const bot = makeBot(0, 0)
  const start = { x: bot.tank.x, y: bot.tank.y }
  const { path } = run(bot, null, 6)
  const travelled = path.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - path[i - 1].x, p.y - path[i - 1].y) : 0), 0)
  check(
    'a bot with nobody to fight still drives around',
    travelled > 300,
    `travelled ${Math.round(travelled)}px from ${Math.round(start.x)},${Math.round(start.y)}`,
  )
}

// ------------------------------------------------------- it closes the range

{
  // Park a target in the far corner and see whether the gap shrinks — against a
  // control of the same bot given no target at all.
  //
  // Averaged over eight runs each, not decided on one. A wanderer's distance to
  // an arbitrary point is noise: it picks spawn points at random, and a single
  // run of it finished *closer to the corner than the hunter did* while the
  // hunter was working correctly. One sample of a quantity that moves for
  // unrelated reasons cannot carry the claim; the difference in the means can.
  //
  // The window matters as much as the averaging. At ten seconds the two
  // populations still overlap: a wanderer starting in the near corner drifts
  // *toward* the far one, because from a corner almost every direction is
  // toward it, and this check used to fail on that about every other run. At
  // twenty seconds the hunter has arrived and holds engagement range while the
  // wanderer is still anywhere, so the claim is made on where each bot *ends
  // up* — the mean over the final five seconds — not on where a snapshot
  // caught it.
  const far = still(ARENA_W - 120, ARENA_H - 120)
  const N = 8
  const SECONDS = 20
  const TAIL = 5
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length
  const settled = (withTarget) => {
    const out = []
    for (let i = 0; i < N; i++) {
      const b = makeBot(0, 0)
      b.tank.x = 120
      b.tank.y = 120
      const { path } = run(b, withTarget ? far : null, SECONDS)
      const tail = path.slice(-Math.round(TAIL / DT))
      out.push(mean(tail.map((p) => Math.hypot(far.x - p.x, far.y - p.y))))
    }
    return out
  }
  const start = Math.hypot(far.x - 120, far.y - 120)
  const hunters = settled(true)
  const wanderers = settled(false)
  check(
    'a bot closes on a target it can see, and one with no target does not',
    mean(hunters) < 700 && mean(wanderers) > mean(hunters) + 300,
    `from ${Math.round(start)}: hunters settle at mean ${Math.round(mean(hunters))} ` +
      `(worst ${Math.round(Math.max(...hunters))}), wanderers at mean ${Math.round(mean(wanderers))}`,
  )
}

// ----------------------------------------------------------------- it shoots

{
  const bot = makeBot(0, 0)
  bot.tank.x = 400
  bot.tank.y = 400
  // Somewhere it can actually see, or the check is about the arena rather than
  // about the bot. Scan for an open spot at roughly its preferred range.
  let spot = null
  for (let a = 0; a < 32 && !spot; a++) {
    const th = (a / 32) * Math.PI * 2
    const p = { x: 400 + Math.cos(th) * 320, y: 400 + Math.sin(th) * 320 }
    if (p.x > 60 && p.y > 60 && p.x < ARENA_W - 60 && p.y < ARENA_H - 60 &&
        hasLineOfSight(400, 400, p.x, p.y)) spot = p
  }
  check('found an open lane to test shooting in', !!spot, spot ? `${Math.round(spot.x)},${Math.round(spot.y)}` : 'none')
  const { shots } = run(bot, still(spot.x, spot.y), 12)
  check('a bot in range of a target it can see opens fire', shots.length >= 3, `${shots.length} shots in 12s`)

  // And not faster than a player can. The magazine is the balance of this
  // whole game; a bot that ignored the reload would be a different weapon.
  const gaps = shots.slice(1).map((s, i) => s.at - shots[i].at)
  check(
    'and it respects a reload at least as long as a player\'s',
    gaps.length > 0 && Math.min(...gaps) >= 1050,
    `shortest gap ${Math.round(Math.min(...gaps))}ms against a 1050ms reload`,
  )
}

// ------------------------------------------------------------ it misses, too

{
  // A bot that never misses is a hazard, not an opponent. Fire a lot of shots
  // at a stationary target and check the bearings are scattered rather than
  // identical — the control is that the spread is real but bounded, so it is
  // aiming with error rather than not aiming.
  const bot = makeBot(0, 0)
  bot.tank.x = 400
  bot.tank.y = 400
  let spot = null
  for (let a = 0; a < 32 && !spot; a++) {
    const th = (a / 32) * Math.PI * 2
    const p = { x: 400 + Math.cos(th) * 320, y: 400 + Math.sin(th) * 320 }
    if (p.x > 60 && p.y > 60 && p.x < ARENA_W - 60 && p.y < ARENA_H - 60 &&
        hasLineOfSight(400, 400, p.x, p.y)) spot = p
  }
  const target = still(spot.x, spot.y)
  const { shots } = run(bot, target, 40)
  const errs = shots.map((s) => {
    const true_ = Math.atan2(target.y - s.from.y, target.x - s.from.x)
    let d = s.angle - true_
    while (d > Math.PI) d -= Math.PI * 2
    while (d < -Math.PI) d += Math.PI * 2
    return d
  })
  const spread = errs.length ? Math.max(...errs) - Math.min(...errs) : 0
  const worst = errs.length ? Math.max(...errs.map(Math.abs)) : 0
  check(
    'its aim has real error in it, so it is beatable',
    shots.length >= 6 && spread > 0.05,
    `${shots.length} shots, bearing spread ${spread.toFixed(3)} rad`,
  )
  check(
    'and the error is bounded, so it is aiming rather than spraying',
    worst < 0.7,
    `worst miss ${worst.toFixed(3)} rad`,
  )
}

// -------------------------------------------------------------- it leads you

{
  // The same geometry twice: a target standing still, and the same target
  // moving fast across the bot's line. A bot that points at where you are
  // rather than where you will be misses everybody who is not parked, so the
  // two bearings must differ — and the moving one must be ahead in the
  // direction of travel, not merely different.
  const at = { x: 800, y: 300 }
  const mk = () => {
    const b = makeBot(0, 0)
    b.tank.x = 800
    b.tank.y = 700
    b.tank.gun = -Math.PI / 2
    return b
  }
  const readAim = (target) => {
    const b = mk()
    // One frame is enough: the turret slews, so let it settle on the bearing.
    for (let i = 0; i < 240; i++) stepBot(b, target, DT, i * DT * 1000, 3, 1)
    return b.tank.gun
  }
  const parkedAim = readAim({ ...at, vx: 0, vy: 0, dead: false })
  const movingAim = readAim({ ...at, vx: 160, vy: 0, dead: false })
  const delta = movingAim - parkedAim
  check(
    'it leads a moving target rather than pointing at it',
    Math.abs(delta) > 0.05 && delta > 0,
    `parked ${parkedAim.toFixed(3)} vs crossing right ${movingAim.toFixed(3)} rad`,
  )
}

// --------------------------------------------------------------- it respawns

{
  const bot = makeBot(0, 0)
  killBot(bot, 1000, 1)
  check('a killed bot is dead and has a respawn booked', bot.tank.dead && bot.tank.respawnAt > 1000)
  const a = stepBot(bot, still(400, 400), DT, 1500, 3, 1)
  check('and it stays down and holds its fire while dead', bot.tank.dead && a.fire === null)
  stepBot(bot, still(400, 400), DT, bot.tank.respawnAt + 1, 3, 1)
  check('and it comes back with a full hull', !bot.tank.dead && bot.tank.hp === 3, `hp=${bot.tank.hp}`)
  check('and it comes back somewhere on the board', SPAWNS.length > 0 &&
    bot.tank.x > 0 && bot.tank.x < ARENA_W && bot.tank.y > 0 && bot.tank.y < ARENA_H)
}

// --------------------------------------------------------- it stays on board

{
  // Drive one at a wall for a long time and check it does not end up outside
  // the arena or wedged. The stuck timer is what turns "cannot go that way"
  // into a new heading, and without it a bot is an ornament.
  const bot = makeBot(0, 0)
  bot.tank.x = 60
  bot.tank.y = 60
  const { path } = run(bot, still(50, 50), 14)
  const outside = path.filter((p) => p.x < 0 || p.y < 0 || p.x > ARENA_W || p.y > ARENA_H)
  check('a bot never leaves the arena', outside.length === 0, `${outside.length} frames outside`)
  const last = path.slice(-240)
  const wiggle = last.reduce((s, p, i) => (i ? s + Math.hypot(p.x - last[i - 1].x, p.y - last[i - 1].y) : 0), 0)
  check(
    'and a bot pinned in a corner works its way out instead of grinding',
    wiggle > 120,
    `moved ${Math.round(wiggle)}px over the last 4s against a wall`,
  )
}

check('there are enough of them to make a board feel busy', BOT_COUNT >= 3, `BOT_COUNT=${BOT_COUNT}`)

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall good')
process.exit(failures.length ? 1 : 0)
