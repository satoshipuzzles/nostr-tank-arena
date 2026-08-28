// Something to shoot at when nobody else turned up.
//
// Puzz's backlog: "Bot tanks, so a solo player has something to shoot at."
//
// A room in this game is a string two people agreed on. There is no
// matchmaking, no lobby queue and no server holding people until four have
// arrived — which means the overwhelmingly common first experience is an empty
// arena with one tank in it and nothing to do. That is the single cheapest
// thing standing between this build and being fun for thirty seconds, which is
// the only test that matters on a cartridge.
//
// Three decisions, and the first is the one everything else follows from.
//
// **Bots are local.** They never touch a relay, never publish an event, and
// nobody else can see them. Two clients in the same room would each spawn their
// own three, and there is no honest way to reconcile six invisible tanks across
// two screens — so the rule is simply that bots exist only while the room has
// no real opponents, and they leave the moment one arrives. A bot in a populated
// room is a divergence bug wearing a hat.
//
// **They ride in `Game.peers`.** A bot writes the same `view` a remote player's
// interpolator writes, under a synthetic 64-hex session key, so the renderer,
// the scoreboard, the spawn-placement search and the shell collision all work on
// them with no changes at all. The alternative — a parallel list of entities the
// renderer also has to know about — is the same feature and four more places to
// forget one.
//
// **Bot kills do not touch your published score.** Anyone can spawn free kills
// here, so a leaderboard that counted them would be measuring patience. They
// count for the feed, the sound and the streak, because practising a streak is
// most of what a bot room is for; they do not count for `ks`, `ds` or the block
// winner. `Game` owns that split — see `isBot`.

import { ARENA_H, ARENA_W, SPAWNS, groundSpeed, hasLineOfSight, pointInTallWall } from './arena'
import {
  GUN_TURN_RATE,
  MAX_HP,
  RELOAD,
  RESPAWN_DELAY,
  SHELL_SPEED,
  TANK_RADIUS,
  angleDelta,
} from './sim'
import { SEATS } from './rooms'
import type { LocalTank } from './sim'

/**
 * How many tanks a solo player is dropped in with, unless they say otherwise.
 *
 * Three because that is what a four-player board wanted, and it stayed three
 * when a room grew to eight — which is the right default rather than an
 * oversight: three is a firefight you can win, and seven is a firing squad.
 * The number is now a preference, so anybody who wants the squad can have it.
 */
export const BOT_COUNT = 3

/**
 * The most a player can ask for.
 *
 * `SEATS - 1`, because a bot fills a seat and the player is in one of them.
 * Deriving it rather than writing 7 is the lesson from the last time a room
 * grew: four seats and four spawn points were the same number for no reason,
 * and eight players stacked two tanks on one spawn.
 */
export const MAX_BOTS = SEATS - 1

/**
 * The range a bot tries to hold.
 *
 * Well inside a shell's reach, and deliberately not point blank. A bot that
 * drives all the way in is trivially circle-strafed and reads as broken; one
 * that snipes from the far wall is a pixel you can ignore. This is roughly the
 * distance at which the arena's cover starts to matter, which is where the
 * interesting fights already happen.
 */
const HOLD_RANGE = 320
const HOLD_BAND = 90

/**
 * How wrong a bot's aim is, in radians, at its worst.
 *
 * The lead calculation below is exact — it solves for where the target will be
 * when the shell arrives — and an exact solution fired every 1.05 seconds is
 * not a game, it is a hazard. The error is what makes a bot beatable, and it
 * shrinks as the bot's own hull goes down so a wounded one is dangerous rather
 * than free. Per-bot, so three of them are not one opponent with three bodies.
 */
const AIM_ERROR = 0.2

/** Only shoot when the gun is roughly on target; the turret slews, like yours. */
const FIRE_CONE = 0.13

/** Names, so the feed reads like a game rather than like a test fixture. */
const NAMES = ['Rust', 'Bolt', 'Cinder', 'Gravel', 'Tinny', 'Scrap']

/**
 * A difficulty level, expressed the one honest way for a game with no server to
 * arbitrate a fight: a **reaction delay** and an **aim error**, and never a
 * health or damage multiplier. That is Puzz's own constraint on the bot issue —
 * "a bot that takes five shells to kill is not harder, it is longer." A harder
 * bot reacts sooner and aims truer; it does not soak more shells or hit for
 * more, because either of those moves the time-to-kill the whole game is
 * balanced around and turns a duel into a chore.
 */
export interface BotSkill {
  id: string
  /** Peak aim error in radians — the bound on the per-shot wobble. */
  aimError: number
  /**
   * How long a target has to stay in view before this bot will fire at it, in
   * real milliseconds. It is the perception lag a person has and the exact-lead
   * solution below does not: without it the hardest bot is not hard, it is
   * precognitive. On the real clock next to the reload it gates, for the same
   * reason the reload is — it is the gun's clock, not the drive's — and cleared
   * the instant sight is lost, so ducking behind cover makes a bot wind up
   * again, which is where a reaction actually reads as one.
   */
  reactionMs: number
  /**
   * Multiplies the random pause between shots above the reload floor. One is
   * today's cadence; lower is a bot that presses its reload, higher is one that
   * lets you breathe. It only ever lengthens the wait — see `stepBot`, where it
   * scales the pause *on top of* a full reload — so no level can fire faster
   * than a player, which is the one rule the bot's gun has always kept.
   */
  cadence: number
}

/**
 * Four rungs, easy to hard. `regular` is exactly the bot that shipped before
 * difficulty existed — the same aim error, no reaction gate, the same cadence —
 * so turning the feature on and leaving it at the default changes nothing that
 * was tuned against it. Above `regular` the lever is aim and cadence, not
 * reaction: you cannot react faster than the instant the gun bears, which is
 * already when the shipped bot fires.
 */
export const BOT_SKILLS: readonly BotSkill[] = [
  { id: 'recruit', aimError: 0.42, reactionMs: 620, cadence: 1.55 },
  { id: 'regular', aimError: AIM_ERROR, reactionMs: 0, cadence: 1 },
  { id: 'veteran', aimError: 0.1, reactionMs: 0, cadence: 0.74 },
  { id: 'elite', aimError: 0.05, reactionMs: 0, cadence: 0.55 },
]

/** The rung a room sits at until somebody moves it: the shipped bot. */
export const DEFAULT_SKILL = 1

/** Clamp an index to a real rung, so a stored or wire value can never crash. */
export const botSkillFor = (index: number): BotSkill =>
  BOT_SKILLS[Math.max(0, Math.min(BOT_SKILLS.length - 1, Math.floor(index)))]

export interface Bot {
  /**
   * Synthetic session key. 64 hex characters because everything downstream —
   * the peer map, the kill credit in a death payload, the scoreboard sort —
   * treats a session as an opaque 64-char string, and a bot that did not look
   * like one would find the one place that checks.
   *
   * `b0` prefix so `Game.isBot` is a string compare rather than a set lookup
   * that has to be kept in sync with the spawn and the sweep.
   */
  session: string
  name: string
  color: number
  tank: LocalTank
  /**
   * The bot's own clock, in **simulated** seconds — the sum of every `dt` it
   * has been stepped with, not wall-clock milliseconds.
   *
   * This distinction is the whole reason the first cut of this did not move a
   * pixel in a real browser while passing every check in Node. `Game.update`
   * clamps its delta to 50ms so a backgrounded tab cannot teleport the world,
   * so on a device rendering at four frames a second the simulation advances at
   * a fifth of real time. A "give up on this goal after 700ms" written against
   * `performance.now()` therefore fires after 140ms of *driving*, which is less
   * time than it takes to turn — so the bot re-picked a goal three times a
   * second, spun on the spot forever, and never travelled anywhere. Probed in
   * the browser: hull 5.50, 5.75, 5.50, 5.62, position identical to the pixel.
   *
   * Every deadline about the bot's own movement is in these seconds. Only the
   * reload stays on the real clock, because it is compared against the same
   * `performance.now()` the player's own gun is.
   */
  clock: number
  /** Where it is driving. Null means "pick somewhere", which happens a lot. */
  goal: { x: number; y: number } | null
  /** `clock` at which to give up on the goal whether or not it was reached. */
  goalUntil: number
  /** Its own aim error, resampled per shot so it is not a constant bias. */
  wobble: number
  kills: number
  deaths: number
  /** Where it was a moment ago, to notice it has driven into a wall. */
  wasAt: { x: number; y: number }
  /**
   * Simulated seconds spent *trying to drive* and not getting anywhere.
   *
   * Trying is the load-bearing word. A bot turning on the spot toward a goal
   * behind it is making progress and must not be counted as wedged, or the
   * escape hatch fires mid-turn, picks another goal ninety degrees away, and
   * the bot spins between two headings it never reaches. Only frames with the
   * throttle actually open count.
   */
  stuckFor: number
  /**
   * Real-clock ms at which the current target came into view, or 0 for "not in
   * view". The reaction delay is measured from here — see `BotSkill.reactionMs`.
   * On the real clock rather than `clock`, because it gates the gun, which runs
   * on the same `performance.now()` the reload does.
   */
  sawSince: number
}

let seq = 0

/**
 * A bot's name and colour, by index.
 *
 * Pure functions, and exported because the wire relies on it: the owner sends
 * six numbers a tank and every other client derives the identity from the
 * index rather than being told it ten times a second. `makeBot` reads them too,
 * so there is one table and no way for the two sides to disagree.
 */
export const botNameFor = (index: number): string => NAMES[index % NAMES.length]
export const botColorFor = (index: number): number => (35 + index * 97) % 360

export function makeBot(index: number, now: number): Bot {
  seq++
  // Deterministic in shape, unique in value. The suffix is a counter rather
  // than a random string so a bot that appears in a log can be told apart from
  // the one that replaced it after a round change.
  const session = ('b0' + seq.toString(16).padStart(4, '0')).padEnd(64, '0')
  const spot = SPAWNS[(index * 3 + 1) % Math.max(1, SPAWNS.length)] ?? { x: 400, y: 400 }
  return {
    session,
    name: botNameFor(index),
    // Spread around the wheel away from the usual player hues.
    color: botColorFor(index),
    tank: {
      x: spot.x,
      y: spot.y,
      hull: Math.random() * Math.PI * 2,
      gun: 0,
      hp: MAX_HP,
      dead: false,
      respawnAt: 0,
      reloadAt: now + 600 + index * 250,
      ammo: 99,
      reloadingFrom: 0,
      reloadingUntil: 0,
    },
    clock: 0,
    goal: null,
    goalUntil: 0,
    wobble: 0,
    kills: 0,
    deaths: 0,
    wasAt: { x: spot.x, y: spot.y },
    stuckFor: 0,
    sawSince: 0,
  }
}

export interface BotTarget {
  x: number
  y: number
  /** World velocity, px/s. The lead below is the only thing that reads it. */
  vx: number
  vy: number
  dead: boolean
}

/** What a bot decided to do this frame. `fire` is a bearing, or null. */
export interface BotAction {
  fire: number | null
}

/**
 * Step one bot.
 *
 * Written as a free function taking the world it needs rather than as a method
 * on something that owns the game, so the whole of a bot's behaviour can be run
 * in Node against a fake target — which is what test/bots.mjs does. Nothing in
 * here reads a clock it was not handed or a relay at all.
 */
export function stepBot(
  bot: Bot,
  target: BotTarget | null,
  dt: number,
  now: number,
  maxHp: number,
  reloadMul: number,
  skill: BotSkill = BOT_SKILLS[DEFAULT_SKILL],
): BotAction {
  const t = bot.tank

  if (t.dead) {
    if (now >= t.respawnAt) {
      t.dead = false
      t.hp = maxHp
      const spot = SPAWNS[Math.floor(Math.random() * SPAWNS.length)] ?? { x: 400, y: 400 }
      t.x = spot.x
      t.y = spot.y
      bot.goal = null
      bot.stuckFor = 0
      bot.sawSince = 0
      bot.wasAt = { x: t.x, y: t.y }
      // A fresh gun has no carried lead. `stepTank` adopts the short way round
      // when it sees a stale one, but respawning also moves the tank, and the
      // cheapest correct thing is to say so explicitly.
      t.aimPrev = undefined
      t.gunLead = 0
    }
    return { fire: null }
  }

  const live = target && !target.dead ? target : null
  const dist = live ? Math.hypot(live.x - t.x, live.y - t.y) : Infinity
  const sees = live ? hasLineOfSight(t.x, t.y, live.x, live.y) : false

  // The reaction wind-up. A target has to be *held* in view for the level's
  // delay before the bot will shoot at it, and losing the line resets it — so a
  // Recruit that just rounded a corner onto you gets a beat before it fires,
  // and an Elite does not. `regular` and up run at zero here, which is the
  // shipped behaviour of firing the moment the gun bears.
  if (live && sees) {
    if (bot.sawSince === 0) bot.sawSince = now
  } else {
    bot.sawSince = 0
  }
  const reacted = bot.sawSince > 0 && now - bot.sawSince >= skill.reactionMs

  // ------------------------------------------------------------------ aiming

  // Lead the target rather than pointing at it. A shell takes `dist/SPEED`
  // seconds to arrive and the target is moving; firing at where somebody is
  // means missing everybody who is not standing still, which is a bot that
  // never lands a shot and reads as decoration. The lead is one iteration, not
  // a solved quadratic, because the shell is three times faster than a tank and
  // the second iteration moves the answer by less than the aim error below.
  let want = t.gun
  if (live) {
    const flight = dist / SHELL_SPEED
    want = Math.atan2(
      live.y + live.vy * flight - t.y,
      live.x + live.vx * flight - t.x,
    )
  }

  // Slew at the same rate a player's turret does. A bot whose gun snapped to a
  // bearing would be a different weapon from the one the player is holding, and
  // the turret lag is most of what makes a flanking move work.
  const lead = angleDelta(t.gun, want)
  const max = GUN_TURN_RATE * dt
  t.gun += Math.abs(lead) < max ? lead : Math.sign(lead) * max

  // ----------------------------------------------------------------- driving

  // Re-pick a goal when the old one expired, was reached, or the bot has been
  // grinding against a wall. `stepTank` resolves collisions by refusing to move
  // rather than by sliding, so a bot pointed into a rock will sit there
  // indefinitely with a perfectly sensible-looking heading — the stuck check is
  // not a nicety, it is the difference between three opponents and three
  // ornaments.
  bot.clock += dt
  const moved = Math.hypot(t.x - bot.wasAt.x, t.y - bot.wasAt.y)
  if (moved > 4) {
    bot.wasAt = { x: t.x, y: t.y }
    bot.stuckFor = 0
  }
  const stuck = bot.stuckFor > 0.7
  const arrived = bot.goal && Math.hypot(bot.goal.x - t.x, bot.goal.y - t.y) < 60
  if (!bot.goal || arrived || stuck || bot.clock > bot.goalUntil) {
    // A goal picked *because the last one was unreachable* has to be somewhere
    // else, not somewhere else in the same direction. `pickGoal` samples around
    // the bearing to the target, which is exactly the bearing that just failed,
    // so being stuck hands it a hard sideways push instead and commits to it
    // for a beat. Without this the sliding above still gets out of most things
    // and takes far longer over the ones with a corner in them.
    bot.goal = stuck ? unstick(t) : pickGoal(t, live, dist, sees)
    bot.goalUntil = bot.clock + (stuck ? 1.6 : 1.4 + Math.random() * 1.6)
    bot.stuckFor = 0
    bot.wasAt = { x: t.x, y: t.y }
  }

  const goal = bot.goal!
  const bearing = Math.atan2(goal.y - t.y, goal.x - t.x)
  const off = angleDelta(t.hull, bearing)
  // Steer proportionally and stop driving forward while the turn is wide, so a
  // bot corners rather than spiralling round its goal at full throttle.
  const steer = Math.max(-1, Math.min(1, off * 2.4))
  // Never fully zero. The first cut cut the throttle dead past 1.2 radians,
  // which turns a bot pointed the wrong way into a stationary object for as
  // long as the turn takes — and on a device where the simulation runs at a
  // fifth of real time, that is seconds. A crawl keeps it a moving target and,
  // more importantly, keeps the wedged-detector below honest: a tank that is
  // trying to drive and going nowhere is wedged, and one that is standing
  // still by choice is not, and those must not be the same reading.
  const throttle = Math.max(0.18, 1 - Math.abs(off) * 0.62)

  t.hull += steer * 2.5 * dt
  // The same ground rule the player drives on. A bot that crossed a breach at
  // full speed would make rubble a rule that only applies to humans, which is
  // both unfair and the kind of asymmetry that reads as the feature being
  // broken rather than as the bot cheating.
  const speed = throttle * 175 * groundSpeed(t.x, t.y)
  const dx = Math.cos(t.hull) * speed * dt
  const dy = Math.sin(t.hull) * speed * dt
  const beforeX = t.x
  const beforeY = t.y

  // Slide along what it cannot drive through.
  //
  // The first cut of this refused the whole move whenever the destination was
  // inside a wall, on the theory that the stuck timer above would notice and
  // pick a new heading. It does notice. It does not help: every new heading is
  // sampled around the bearing to the target, so a bot with a rock between it
  // and the player picks the same blocked direction again, and again. Probed at
  // 60fps it drove 180px and then sat at exactly (300, 330) for the remaining
  // eight seconds, re-picking a goal three times a second and never moving a
  // pixel. Three of those is not an arena full of opponents, it is scenery.
  //
  // Axis-at-a-time is the cheapest thing that fixes it and it is what makes a
  // bot look like it is going *around* something: blocked diagonally, it keeps
  // whichever component is clear and rubs along the face until the corner runs
  // out. `blocked` tests a point out at the hull's leading edge as well as the
  // centre, because a centre-only test lets a bot bury half its tank in a rock
  // and then the shell that was aimed at it hits the rock.
  if (!blocked(t.x + dx, t.y + dy, t.hull)) {
    t.x = t.x + dx
    t.y = t.y + dy
  } else if (!blocked(t.x + dx, t.y, t.hull)) {
    t.x = t.x + dx
  } else if (!blocked(t.x, t.y + dy, t.hull)) {
    t.y = t.y + dy
  }
  t.x = Math.max(TANK_RADIUS, Math.min(ARENA_W - TANK_RADIUS, t.x))
  t.y = Math.max(TANK_RADIUS, Math.min(ARENA_H - TANK_RADIUS, t.y))

  // Wedged, in simulated seconds and only while the throttle is open. Compared
  // against the distance it *asked* to travel rather than against a constant,
  // so this reads the same on a machine stepping 16ms frames and one stepping
  // the 50ms clamp.
  const wanted = Math.hypot(dx, dy)
  const got = Math.hypot(t.x - beforeX, t.y - beforeY)
  if (wanted > 0.5 && got < wanted * 0.35) bot.stuckFor += dt

  // ------------------------------------------------------------------ firing

  let fire: number | null = null
  if (live && sees && reacted && now >= t.reloadAt && Math.abs(angleDelta(t.gun, want)) < FIRE_CONE) {
    // Resampled per shot rather than held as a per-bot bias, so a bot that is
    // missing to the left is not missing to the left all match. The bound is
    // the level's, so a Recruit sprays and an Elite threads it.
    const hurt = 1 - Math.max(0, Math.min(1, t.hp / Math.max(1, maxHp)))
    bot.wobble = (Math.random() - 0.5) * 2 * skill.aimError * (1 - hurt * 0.55)
    fire = t.gun + bot.wobble
    // A full reload plus a random beat, and `cadence` scales only that beat —
    // the `1 +` keeps the wait at or above one reload no matter the level, so a
    // harder bot fires more often but never faster than a player can.
    t.reloadAt = now + RELOAD * 1000 * reloadMul * (1 + (0.5 + Math.random() * 0.9) * skill.cadence)
  }

  return { fire }
}

/**
 * Is a tank centred here inside cover?
 *
 * Two probes: the centre, and a point out at the leading edge along the hull.
 * A centre-only test is passable by half a tank, and a tank half inside a rock
 * is one the player's shells hit the rock instead of.
 */
function blocked(x: number, y: number, hull: number): boolean {
  if (x < TANK_RADIUS || y < TANK_RADIUS || x > ARENA_W - TANK_RADIUS || y > ARENA_H - TANK_RADIUS) {
    return true
  }
  if (pointInTallWall(x, y)) return true
  return !!pointInTallWall(x + Math.cos(hull) * TANK_RADIUS, y + Math.sin(hull) * TANK_RADIUS)
}

/** A hard turn away from whatever is in the way, committed to for a moment. */
function unstick(t: LocalTank): { x: number; y: number } {
  const away = t.hull + (Math.random() < 0.5 ? 1 : -1) * (Math.PI / 2 + Math.random() * 0.9)
  return {
    x: Math.max(60, Math.min(ARENA_W - 60, t.x + Math.cos(away) * 300)),
    y: Math.max(60, Math.min(ARENA_H - 60, t.y + Math.sin(away) * 300)),
  }
}

/** Kill a bot. Separate from the step so the caller owns the credit. */
export function killBot(bot: Bot, now: number, respawnMul: number): void {
  bot.tank.dead = true
  bot.tank.hp = 0
  bot.deaths++
  bot.tank.respawnAt = now + RESPAWN_DELAY * 1000 * respawnMul
}

/**
 * Where to drive next.
 *
 * Three cases and they are all about range. Too far or blind, close in; too
 * close, back off to a spot on the far side of where you are; in the band with
 * a shot, sidestep so the bot is a moving target rather than a stationary one
 * exchanging shells until the arithmetic decides it.
 */
function pickGoal(
  t: LocalTank,
  live: BotTarget | null,
  dist: number,
  sees: boolean,
): { x: number; y: number } {
  const clamp = (p: { x: number; y: number }) => ({
    x: Math.max(60, Math.min(ARENA_W - 60, p.x)),
    y: Math.max(60, Math.min(ARENA_H - 60, p.y)),
  })
  if (!live) {
    // Nobody to fight: wander, so an empty board still has movement on it.
    const spot = SPAWNS[Math.floor(Math.random() * SPAWNS.length)]
    return clamp(spot ?? { x: ARENA_W / 2, y: ARENA_H / 2 })
  }
  const toward = Math.atan2(live.y - t.y, live.x - t.x)
  if (!sees || dist > HOLD_RANGE + HOLD_BAND) {
    // Close, but not straight down the middle: aim at a point beside them, so
    // three bots converging do not stack into one silhouette.
    const skew = toward + (Math.random() - 0.5) * 0.9
    const step = Math.min(dist - HOLD_RANGE * 0.6, 420)
    return clamp({ x: t.x + Math.cos(skew) * step, y: t.y + Math.sin(skew) * step })
  }
  if (dist < HOLD_RANGE - HOLD_BAND) {
    return clamp({ x: t.x - Math.cos(toward) * 260, y: t.y - Math.sin(toward) * 260 })
  }
  const side = toward + (Math.random() < 0.5 ? Math.PI / 2 : -Math.PI / 2)
  return clamp({ x: t.x + Math.cos(side) * 220, y: t.y + Math.sin(side) * 220 })
}
