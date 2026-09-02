// Capture the flag, with nobody to hold the flag.
//
// Puzz: "Capture the flag 2v2 and 3v3 and 4v4."
//
// A flag is a piece of world state that moves, and moving world state is the
// thing this game has spent every feature avoiding: the map comes from the
// block hash, the pickups come from the block hash, the rules come from the
// block hash, and the two exceptions — broken cover and the chopper — got there
// by riding a tick that was already going out. A flag has to do the same, and
// the design falls out of one decision.
//
// **A flag is never anywhere except a base or a tank.** There is no third
// state. Drop it and it goes home; die with it and it goes home; disconnect
// with it and it goes home, because the tick that was claiming it stops
// arriving and every client's clock runs the same 1.5 seconds out. That single
// rule removes every piece of state that would have needed agreeing:
//
//   - There is no "dropped at (x, y)" for two clients to disagree about.
//   - There is no pickup radius for a client to lie about, because there is
//     nothing to pick up anywhere except a base whose position everybody
//     derives from the layout.
//   - There is nothing to store, so a player who joins at minute six reads the
//     current tick stream and knows exactly where every flag is.
//
// What rides the wire is one number: `f` on the state tick, "the flag I am
// carrying". Self-declared, like a team and like a hull. Two players claiming
// the same flag is resolved by every client the same way — lowest session key
// wins — so the disagreement lasts exactly as long as it takes both ticks to
// arrive, and never becomes state.
//
// It also makes the game faster than a normal CTF and that is on purpose. A
// flag that lies on the ground where its carrier died is a game about standing
// in one place; a flag that goes home is a game about the run.

import { ARENA_H, ARENA_W, SPAWNS, pointInWall } from './arena'

/** How close you have to be to a base to take its flag, or to score on it. */
export const FLAG_REACH = 90

/**
 * How long a carrier's claim outlives their last tick.
 *
 * Long enough to ride out a dropped publish on a busy relay — ticks go out at
 * 10Hz and this is fifteen of them — and short enough that a player who closed
 * the tab is not still holding a flag when the round ends. Everybody runs the
 * same number against their own clock, so a carrier who vanishes returns their
 * flag on every screen within a frame or two of every other screen.
 */
export const CLAIM_TTL_MS = 1_500

export interface FlagBase {
  team: number
  x: number
  y: number
}

/**
 * How many sides have a flag base.
 *
 * Four, not the five a team game allows, and the reason is geometry rather
 * than arithmetic. The spawn list is four corners and then four edge
 * midpoints — so a fifth base is always *on the line between two others*, and
 * a player running from side one to side two would pass straight through it.
 * Measured on Crossroads: side five's base sat 25 units off that line. There
 * is no fair fifth position on a rectangle, so a fifth side plays deathmatch
 * and the flags stay a four-corner game. Puzz asked for "2v2 and 3v3 and 4v4",
 * all of which fit.
 */
export const FLAG_TEAMS = 4

/**
 * How far in front of the spawn the flag stands.
 *
 * Not *on* the spawn, and this is a rule rather than a nicety: `respawn` picks
 * the spawn furthest from everybody alive, so a base that shares a spawn is a
 * base somebody can respawn on top of and take the flag from in the same frame
 * they came back. Offset toward the middle of the board, which also reads
 * better — the flag is in front of the corner you came out of, with the corner
 * behind it to fall back to.
 */
const BASE_OFFSET = 150

/**
 * Where each side's flag lives, derived from the layout and nothing else.
 *
 * Off the spawn list, in order, pushed toward the centre. The spawns are
 * already 180-degree rotationally symmetric, already clear of the scenery, and
 * already the same on every client because they come from the map, which comes
 * from the block hash — and pushing every one of them the same distance toward
 * the same point keeps all three of those true. Inventing a second set of
 * authored positions would be four numbers per board that could drift from the
 * spawns, plus a fairness argument nobody can settle.
 *
 * Teams are 1-indexed and spawns are 0-indexed, which is the only fiddly part.
 */
export function baseFor(team: number): FlagBase | null {
  if (team < 1 || team > FLAG_TEAMS) return null
  const spot = SPAWNS[(team - 1) % Math.max(1, SPAWNS.length)]
  if (!spot) return null
  const cx = ARENA_W / 2
  const cy = ARENA_H / 2
  const dx = cx - spot.x
  const dy = cy - spot.y
  const d = Math.hypot(dx, dy) || 1
  const k = Math.min(1, BASE_OFFSET / d)
  let x = Math.max(60, Math.min(ARENA_W - 60, spot.x + dx * k))
  let y = Math.max(60, Math.min(ARENA_H - 60, spot.y + dy * k))
  // 150 toward the centre landed some bases inside the scenery, and the flags
  // suite never saw it because it samples one board — the chain tip's. On The
  // Warehouse every base was inside the racking; on The Shallows two were in
  // the water. So the base keeps walking the same ray until it stands on open
  // ground. Still a pure function of the layout — the walk is fixed steps
  // along a line both ends of which come off the map — so every client still
  // derives the same spot without a word on the wire. The centre of a board
  // is never inside cover (the middle is where the fights are authored to
  // happen), so the walk always finds ground before the ray runs out.
  const step = 12 / d
  for (let t = k; pointInWall(x, y) !== null && t < 1; t += step) {
    x = Math.max(60, Math.min(ARENA_W - 60, spot.x + dx * Math.min(1, t + step)))
    y = Math.max(60, Math.min(ARENA_H - 60, spot.y + dy * Math.min(1, t + step)))
  }
  return { team, x, y }
}

/** Are we close enough to a base to take from it or score on it? */
export function atBase(team: number, x: number, y: number): boolean {
  const b = baseFor(team)
  if (!b) return false
  return (x - b.x) ** 2 + (y - b.y) ** 2 <= FLAG_REACH * FLAG_REACH
}

/** One claim heard off the wire, or made locally. */
export interface Claim {
  /** Session key of whoever says they are carrying it. */
  who: string
  /** Which side's flag. */
  flag: number
  /** Our clock, when we last heard them say so. */
  at: number
}

/**
 * Who is carrying each flag, from every claim anybody has made.
 *
 * Two clients hearing the same claims produce the same answer, which is the
 * whole requirement. Ties break on the session key rather than on time: a
 * timestamp is a number two clients received at different moments and can order
 * differently, and a key is a string they both already have. The player who
 * "loses" a tie is holding a flag on nobody's screen including their own — the
 * carrier is read back out of this map rather than remembered — so the game
 * never shows two people carrying one flag.
 *
 * Expired claims are dropped rather than kept as "last known", because a last
 * known carrier is exactly the dropped-flag state this design exists to avoid.
 */
export function carriers(claims: Iterable<Claim>, now: number): Map<number, string> {
  const best = new Map<number, string>()
  for (const c of claims) {
    if (c.flag < 1 || c.flag > FLAG_TEAMS) continue
    if (now - c.at > CLAIM_TTL_MS) continue
    const held = best.get(c.flag)
    if (held === undefined || c.who < held) best.set(c.flag, c.who)
  }
  return best
}

/**
 * May this tank take this flag right now?
 *
 * Deliberately not "is it unclaimed and am I near it" — the *base* is the only
 * place a flag ever is, so being near the base is the whole of the position
 * test, and everything else is about sides. You cannot take your own flag
 * (that is not a move, it is a way to hide it) and you cannot take one somebody
 * is already carrying.
 */
export function canTake(
  team: number,
  flag: number,
  x: number,
  y: number,
  carried: ReadonlySet<number>,
): boolean {
  if (!team || !flag || flag === team) return false
  if (carried.has(flag)) return false
  return atBase(flag, x, y)
}

/**
 * Does carrying this flag, here, score?
 *
 * The classic rule: you have to be on your own base *and your own flag has to
 * be home*. Without the second half a pair of duos trade flags forever and
 * neither ever has to defend, which is a race rather than a game.
 */
export function canScore(
  team: number,
  carrying: number,
  x: number,
  y: number,
  carried: ReadonlySet<number>,
): boolean {
  if (!team || !carrying || carrying === team) return false
  if (carried.has(team)) return false
  return atBase(team, x, y)
}
