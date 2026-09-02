// Bot difficulty levels.
//
// Puzz's constraint on the bot issue is the whole design and so it is the whole
// test: "Difficulty is a reaction delay and an aim error, not a health or a
// damage multiplier. A bot that takes five shells to kill is not harder, it is
// longer." So there is nothing here about hull or shell damage — there is
// nothing there to test, on purpose. What a level changes is three things and
// each has a control:
//
//   1. The default rung is the bot that shipped before difficulty existed, so
//      the feature turned on and left alone changes nothing that was tuned.
//   2. A harder bot's aim is tighter — the worst miss shrinks as the rung
//      climbs, measured against the true bearing rather than against another
//      run's gun.
//   3. A harder bot reacts sooner — with the same line of sight from the same
//      instant, a Recruit holds fire for its wind-up and an Elite does not.
//   4. A harder bot fires more often, and *still* never faster than a player:
//      every gap between shots is at least one reload, on every level.
//
//   npm run test:botskill

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const out = join(mkdtempSync(join(tmpdir(), 'botskill-')), 'bots.mjs')
await build({
  entryPoints: ['test/bots-entry.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'error',
})
const {
  makeBot, stepBot, BOT_SKILLS, DEFAULT_SKILL, botSkillFor,
  ARENA_W, ARENA_H, hasLineOfSight,
} = await import(out)

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

const DT = 1 / 60
const RELOAD_MS = 1050
const skill = (id) => BOT_SKILLS.find((s) => s.id === id)

/** An open lane out of (400,400): a spot at the bot's preferred range it can see. */
function lane() {
  for (let a = 0; a < 64; a++) {
    const th = (a / 64) * Math.PI * 2
    const p = { x: 400 + Math.cos(th) * 320, y: 400 + Math.sin(th) * 320 }
    if (p.x > 60 && p.y > 60 && p.x < ARENA_W - 60 && p.y < ARENA_H - 60 &&
        hasLineOfSight(400, 400, p.x, p.y)) return p
  }
  return null
}
const spot = lane()
check('found an open lane to fight in', !!spot, spot ? `${Math.round(spot.x)},${Math.round(spot.y)}` : 'none')
const target = { x: spot.x, y: spot.y, vx: 0, vy: 0, dead: false }

/**
 * Pin a bot at (400,400) with its gun already on the target and its reload
 * clear, then fire for `seconds` and collect every shot. Pinning and pre-aiming
 * isolate the thing under test — the aim error and the reaction delay — from the
 * drive and the turret slew, which have their own checks in test/bots.mjs.
 */
function fireFor(s, seconds) {
  const bot = makeBot(0, 0)
  bot.tank.x = 400
  bot.tank.y = 400
  bot.tank.gun = Math.atan2(target.y - 400, target.x - 400)
  bot.tank.reloadAt = 0
  const shots = []
  let now = 0
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    now += DT * 1000
    bot.tank.x = 400
    bot.tank.y = 400
    const a = stepBot(bot, target, DT, now, 3, 1, s)
    if (a.fire !== null) {
      const true_ = Math.atan2(target.y - 400, target.x - 400)
      let d = a.fire - true_
      while (d > Math.PI) d -= Math.PI * 2
      while (d < -Math.PI) d += Math.PI * 2
      shots.push({ at: now, err: d })
    }
  }
  return shots
}

const median = (a) => {
  const v = [...a].sort((x, y) => x - y)
  const m = v.length >> 1
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

// ----------------------------------------------------- the default is the old bot

{
  const d = BOT_SKILLS[DEFAULT_SKILL]
  check(
    'the default rung is the shipped bot: no reaction gate, unit cadence, its aim error',
    d.id === 'regular' && d.reactionMs === 0 && d.cadence === 1 && Math.abs(d.aimError - 0.2) < 1e-9,
    `${d.id}: aim ${d.aimError}, reaction ${d.reactionMs}ms, cadence ${d.cadence}`,
  )
  // The knobs move the right way across the whole ladder: aim tightens, and no
  // level reacts slower than an easier one. A table that climbed in aim but
  // dipped in reaction in the middle would pass every behaviour check below on
  // its endpoints and still be misordered.
  let ordered = true
  for (let i = 1; i < BOT_SKILLS.length; i++) {
    if (BOT_SKILLS[i].aimError > BOT_SKILLS[i - 1].aimError) ordered = false
    if (BOT_SKILLS[i].reactionMs > BOT_SKILLS[i - 1].reactionMs) ordered = false
  }
  check('the ladder is ordered: aim and reaction fall as the rung climbs', ordered,
    BOT_SKILLS.map((s) => `${s.id}:${s.aimError}/${s.reactionMs}`).join(' '))
  check(
    'botSkillFor clamps an out-of-range index to a real rung',
    botSkillFor(-5).id === BOT_SKILLS[0].id &&
      botSkillFor(99).id === BOT_SKILLS[BOT_SKILLS.length - 1].id &&
      botSkillFor(DEFAULT_SKILL).id === 'regular',
    `${botSkillFor(-5).id} .. ${botSkillFor(99).id}`,
  )
}

// -------------------------------------------------------------- a harder bot aims truer

{
  const worst = (id) => {
    const shots = fireFor(skill(id), 60)
    return { n: shots.length, worst: Math.max(...shots.map((x) => Math.abs(x.err))) }
  }
  const recruit = worst('recruit')
  const elite = worst('elite')
  check('a recruit and an elite both take enough shots to measure', recruit.n >= 6 && elite.n >= 6,
    `recruit ${recruit.n}, elite ${elite.n}`)
  check(
    'an elite threads it — worst miss well inside a recruit\'s',
    elite.worst < 0.12 && recruit.worst > 0.25 && elite.worst < recruit.worst,
    `elite worst ${elite.worst.toFixed(3)} rad vs recruit ${recruit.worst.toFixed(3)} rad`,
  )
}

// ------------------------------------------------------------ a harder bot reacts sooner

{
  // Same lane, same line of sight from frame one, the only difference the rung.
  // The reload was cleared, so what stands between sighting and the first shot
  // is the reaction wind-up and nothing else.
  const first = (id) => {
    const shots = fireFor(skill(id), 3)
    return shots.length ? shots[0].at : Infinity
  }
  const recruit = first('recruit')
  const elite = first('elite')
  check(
    'an elite fires almost at once when the gun already bears',
    elite < 120,
    `first shot at ${Math.round(elite)}ms`,
  )
  check(
    'a recruit holds fire for its wind-up first',
    recruit >= skill('recruit').reactionMs && recruit > elite + 300,
    `recruit first shot ${Math.round(recruit)}ms against a ${skill('recruit').reactionMs}ms wind-up, elite ${Math.round(elite)}ms`,
  )
}

// ------------------------------------------------- more often, but never faster than you

{
  const gaps = (id) => {
    const shots = fireFor(skill(id), 90)
    return shots.slice(1).map((s, i) => s.at - shots[i].at)
  }
  const recruitGaps = gaps('recruit')
  const eliteGaps = gaps('elite')
  const minGap = Math.min(...recruitGaps, ...eliteGaps)
  check(
    'no level fires faster than a player reloads',
    minGap >= RELOAD_MS - 5,
    `shortest gap ${Math.round(minGap)}ms against a ${RELOAD_MS}ms reload`,
  )
  check(
    'and the elite presses its reload harder than the recruit does',
    median(eliteGaps) < median(recruitGaps),
    `elite median gap ${Math.round(median(eliteGaps))}ms vs recruit ${Math.round(median(recruitGaps))}ms`,
  )
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall good')
process.exit(failures.length ? 1 : 0)
