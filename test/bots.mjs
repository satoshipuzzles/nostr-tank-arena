// Practice tanks.
//
// Puzz's backlog: "Bot tanks, so a solo player has something to shoot at."
//
// The behaviour is pure arithmetic against the arena, so most of this runs in
// Node against the built module. What it has to establish is not "a bot exists"
// — that is a `length` — but that a bot is an *opponent*: it moves, it closes
// the distance, it leads a moving target, it misses sometimes, and it gives up
// its seat one for one as real players arrive (that half lives in
// test/bots-browser.mjs, where a running Game exists to count them).
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
const {
  BOT_COUNT, makeBot, stepBot, killBot, SPAWNS, ARENA_W, ARENA_H, hasLineOfSight, pointInWall,
  angleDelta,
} = await import(out)

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

const DT = 1 / 60
/** Run a bot for `seconds`, collecting every shot it took. */
/**
 * Step a bot for a while, collecting what it did.
 *
 * `pin` holds it in place. Two checks below are about the *gun* — does it fire
 * when it can see something, does it respect the reload — and `stepBot` drives
 * as well as aiming, so without the pin the bot wanders out of the lane the
 * check set up for it and the measurement becomes "how long did it happen to
 * keep the target in view". That is what "a bot in range opens fire" was really
 * measuring when it failed with 2 shots in 12 seconds. Whether a bot closes the
 * range is its own check, above, with its own control.
 */
function run(bot, target, seconds, now0 = 0, pin = null) {
  const shots = []
  const path = []
  let now = now0
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    now += DT * 1000
    if (pin) {
      bot.tank.x = pin.x
      bot.tank.y = pin.y
    }
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
  // **A target the bot can actually see.**
  //
  // This check was flaky for two seasons and neither round of medicine touched
  // the cause. It parked the target in the far corner and started the bot in
  // the near one — and on Crossroads those two corners cannot see each other.
  // Measured: the "hunter" had the target in sight for 0% of a twenty-second
  // run, seven runs out of eight. A bot only hunts what it can see, so the
  // check named "a bot closes on a target it can see" was watching a bot that
  // could not, and the difference it found between hunters and wanderers was
  // whatever residue was left over. That is why the margin was thin enough to
  // flip about half the time: the mechanism under test was never running.
  //
  // So the pair is *found* rather than assumed, and the premise is its own
  // check. If a board change ever breaks the sight line again, this file says
  // so instead of reporting that the bots stopped hunting.
  const grid = []
  for (let x = 100; x < ARENA_W - 100; x += 80) {
    for (let y = 100; y < ARENA_H - 100; y += 80) {
      if (!pointInWall(x, y)) grid.push({ x, y })
    }
  }
  let home = null
  let mark = null
  let bestD = 0
  for (const a of grid) {
    for (const b of grid) {
      const d = Math.hypot(b.x - a.x, b.y - a.y)
      if (d <= bestD) continue
      if (!hasLineOfSight(a.x, a.y, b.x, b.y)) continue
      bestD = d
      home = a
      mark = b
    }
  }
  check(
    'the bot and its target can see each other, which is what makes this a hunt',
    !!home && bestD > 1000,
    home ? `${Math.round(bestD)}px apart, ${home.x},${home.y} -> ${mark.x},${mark.y}` : 'no visible pair',
  )
  const far = still(mark.x, mark.y)

  // **The median of twelve, and the statistic is "does it arrive and stay".**
  //
  // Distance-to-target was the wrong quantity even with the sight line fixed:
  // a wanderer's distance to an arbitrary point is noise, so the *wanderers*
  // were the noisy population and the margin between the two means still swung
  // by hundreds of units between trials. Time spent inside engagement range is
  // the thing that is actually deterministic — a hunter closes and then holds,
  // which is the behaviour, and a wanderer only ever passes through.
  //
  // Measured over twenty-four runs a side: hunters spend 100% of their last ten
  // seconds within 500 units (lower quartile also 100%), wanderers 0% (upper
  // quartile 8%). The occasional hunter that wedges on cover reads 0, which is
  // exactly what a median is for — one bot stuck on a rock is a fact about the
  // rock, not about hunting.
  const N = 12
  const SECONDS = 20
  const TAIL = 10
  const RANGE = 500
  const median = (a) => {
    const v = [...a].sort((x, y) => x - y)
    const m = v.length >> 1
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
  }
  const sample = (withTarget) => {
    const held = []
    const ends = []
    for (let i = 0; i < N; i++) {
      const b = makeBot(0, 0)
      b.tank.x = home.x
      b.tank.y = home.y
      const { path } = run(b, withTarget ? far : null, SECONDS)
      const tail = path.slice(-Math.round(TAIL / DT))
      const d = tail.map((p) => Math.hypot(far.x - p.x, far.y - p.y))
      held.push(d.filter((v) => v < RANGE).length / d.length)
      ends.push(d[d.length - 1])
    }
    return { held: median(held), end: median(ends) }
  }
  const hunters = sample(true)
  const wanderers = sample(false)
  check(
    'a bot closes on a target it can see and then holds the range',
    hunters.held > 0.8,
    `inside ${RANGE}px for ${Math.round(hunters.held * 100)}% of the last ${TAIL}s, ending at ${Math.round(hunters.end)}px`,
  )
  // The control, and it is the half that makes the line above mean anything: a
  // bot that drove at the middle of the board for twenty seconds regardless of
  // whether it had a target would satisfy the check above on this board.
  check(
    'the control: one with no target does not',
    wanderers.held < 0.3 && wanderers.end > hunters.end + 200,
    `inside ${RANGE}px for ${Math.round(wanderers.held * 100)}% of the last ${TAIL}s, ending at ${Math.round(wanderers.end)}px`,
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
  const { shots } = run(bot, still(spot.x, spot.y), 12, 0, { x: 400, y: 400 })
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
  // Pinned, like the fire-rate check above and for the same reason: this is
  // about where the shots go, and a bot that drives out of the lane spends the
  // window not shooting instead of shooting inaccurately.
  const { shots } = run(bot, target, 40, 0, { x: 400, y: 400 })
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
  // The gun against the *direct bearing to the target*, not against another
  // run's gun.
  //
  // This check used to read the raw `gun` angle from two separate runs and
  // require the moving one to be larger, and it failed about every other run —
  // which is exactly what it should have done, because it was not measuring
  // the lead. `makeBot` gives each bot a random hull, and four seconds of
  // `stepBot` *drives* it: by the time the turret had settled the two bots were
  // standing in different places, so the two bearings differed for a reason
  // that has nothing to do with leading a target. Parked bearings ranged from
  // -0.82 to -1.77 rad across runs of identical code.
  //
  // So: hold the bot still, which isolates the turret from the drive — whether
  // a bot closes the range is a different claim with its own check above — and
  // express the answer as the signed angle between the gun and the bearing to
  // where the target *is*. That number is zero for a parked target and positive
  // for one crossing to the right, on every run, because it is arithmetic
  // rather than a race between two random walks.
  const at = { x: 800, y: 300 }
  const HOME = { x: 800, y: 700 }
  const readLead = (vx) => {
    const b = makeBot(0, 0)
    b.tank.gun = -Math.PI / 2
    const target = { ...at, vx, vy: 0, dead: false }
    for (let i = 0; i < 240; i++) {
      // Pinned every frame. `stepBot` drives as well as aims, and a measurement
      // that lets it wander is measuring the drive.
      b.tank.x = HOME.x
      b.tank.y = HOME.y
      stepBot(b, target, DT, i * DT * 1000, 3, 1)
    }
    const direct = Math.atan2(at.y - HOME.y, at.x - HOME.x)
    return angleDelta(direct, b.tank.gun)
  }
  const parked = readLead(0)
  const right = readLead(160)
  const left = readLead(-160)
  check(
    'it points straight at a target that is standing still',
    Math.abs(parked) < 0.02,
    `${parked.toFixed(3)} rad off the direct bearing`,
  )
  check(
    'and leads one crossing to the right',
    right > 0.05,
    `lead ${right.toFixed(3)} rad`,
  )
  // The other direction, because a bot with the sign flipped — or one that
  // simply always aims a fixed amount clockwise — passes the check above and
  // misses every target moving the other way.
  check(
    'and the other way for one crossing left',
    left < -0.05 && Math.abs(left + right) < 0.05,
    `left ${left.toFixed(3)} against right ${right.toFixed(3)} rad`,
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
