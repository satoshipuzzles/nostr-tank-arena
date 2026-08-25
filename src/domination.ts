// Hold ground instead of counting kills.
//
// Puzz, asking about team deathmatch: *"shouldnt we see when capturing a flag
// and taking over a territory or is that not how that mode works"*. It is not —
// that is this, and it is the mode that fits this game's netcode best of the
// three.
//
// **Ownership is derived, not published.** Every client already receives every
// tank's position ten times a second; who is standing on a point is a function
// of that stream and nothing else. So nobody sends "I took point B" — each
// client works it out from the same inputs and reaches the same answer, which
// is the rule the pickup schedule and the map already run on: *anything derived
// from the round's rules that another client also derives must be anchored to
// the same input on both.*
//
// The anchor is the tick stream. It is not perfect — remote tanks are drawn
// `INTERP_MS` in the past, so two clients disagree about the exact instant a
// capture completes by about a tenth of a second — but they cannot disagree
// about *the outcome*, because they are reading the same positions a moment
// apart rather than each making a decision the other has to accept.
//
// **The score is a capture, not a stopwatch.** Holding-time would have to be
// accumulated from the moment a round began, so anybody joining at minute six
// could never catch up and would have no honest number to publish. A capture is
// an event: it happens once, the client it happened to counts it, and it rides
// the tick in the `cap` field the flag game already uses. That also makes the
// two modes score the same way, which is one fewer thing to explain.

import { ARENA_H, ARENA_W, PADS, pointInWall } from './arena'

/** How close you have to be to stand on a point. */
export const POINT_RADIUS = 110

/**
 * Seconds of standing alone on a point before it turns.
 *
 * Long enough that a drive-by does not flip it and short enough that holding
 * one is a decision rather than a shift. Contested — anybody from another side
 * inside the radius — stops the clock rather than reversing it: a point you
 * nearly took stays nearly taken while you fight over it, which is what makes
 * a three-way scramble round a point worth having.
 */
export const CAPTURE_S = 3

/** How many points a board carries. */
export const POINT_COUNT = 3

export interface Point {
  /** Index into the board's point list. Stable for the round. */
  i: number
  x: number
  y: number
}

/**
 * Where the points are, derived from the layout like everything else.
 *
 * Off the pickup pads rather than a fresh set of authored numbers. The pads are
 * already mirrored through the centre — which is what makes a board fair — and
 * already clear of the scenery, and they are already the same on every client
 * because they come from the map, which comes from the block hash.
 *
 * Three of the six, evenly spaced through the list so they are spread rather
 * than clustered on one half. Three because an odd number cannot be split
 * evenly between two sides: somebody is always behind, and a mode where both
 * sides can sit on two points each and wait is not a mode.
 */
export function points(): Point[] {
  const out: Point[] = []
  const pads = PADS.length ? PADS : []
  for (let n = 0; n < POINT_COUNT && pads.length; n++) {
    const pad = pads[Math.floor((n * pads.length) / POINT_COUNT) % pads.length]
    const x = Math.max(80, Math.min(ARENA_W - 80, pad.x))
    const y = Math.max(80, Math.min(ARENA_H - 80, pad.y))
    // A point inside a rock is a point nobody can take. The pads are clear, but
    // this is cheap and the alternative is a round with two playable points.
    if (pointInWall(x, y)) continue
    out.push({ i: out.length, x, y })
  }
  return out
}

/** A tank as this file needs to see it: where it is and whose side it is on. */
export interface Occupant {
  x: number
  y: number
  team: number
  dead: boolean
}

/** Is this tank standing on this point? */
export function onPoint(p: Point, o: Occupant): boolean {
  if (o.dead) return false
  return (o.x - p.x) ** 2 + (o.y - p.y) ** 2 <= POINT_RADIUS * POINT_RADIUS
}

/**
 * Which single side is standing on a point, or 0.
 *
 * Zero for empty, and zero for contested — two sides on one point is not "the
 * side with more tanks", it is a fight. Making it a headcount would mean a duo
 * could walk a point out from under a lone defender without shooting them,
 * which turns the mode into a race rather than a fight over ground.
 *
 * Tanks on nobody's side are ignored entirely rather than treated as a third
 * party. In a mode that is only ever played in team modes there should not be
 * any, and if there are, standing on a point should not let them stop everybody
 * else from playing.
 */
export function holderOn(p: Point, occupants: Iterable<Occupant>): number {
  let side = 0
  for (const o of occupants) {
    if (!o.team || !onPoint(p, o)) continue
    if (side && o.team !== side) return 0
    side = o.team
  }
  return side
}

/** Per-point state: who owns it, and how far along the current capture is. */
export interface PointState {
  /** The side that owns it, or 0 for neutral. */
  owner: number
  /** The side currently taking it, or 0. */
  taking: number
  /** Seconds of uninterrupted progress toward `taking`, 0..CAPTURE_S. */
  progress: number
}

export const freshState = (): PointState => ({ owner: 0, taking: 0, progress: 0 })

/**
 * Advance one point by `dt`, given who is standing on it.
 *
 * Returns the side that just captured it, or 0. The caller scores that — see
 * the note at the top about why a capture is an event rather than a stopwatch.
 *
 * The rules in order, and each one is a decision:
 *
 *   - Nobody there: progress decays rather than resetting. Stepping off for a
 *     moment to dodge should not throw away three seconds of work, and a decay
 *     means a point left alone drifts back to where it was rather than
 *     snapping.
 *   - The owner standing on their own point: nothing to do. Reinforcing a point
 *     you already hold is not a job, and making it one would reward camping.
 *   - Somebody else, uncontested: progress toward them.
 *   - Contested: the clock stops. Not reverses — see `CAPTURE_S`.
 */
export function stepPoint(s: PointState, holder: number, dt: number): number {
  if (!holder) {
    s.progress = Math.max(0, s.progress - dt)
    if (s.progress === 0) s.taking = 0
    return 0
  }
  if (holder === s.owner) {
    s.taking = 0
    s.progress = 0
    return 0
  }
  if (s.taking !== holder) {
    s.taking = holder
    s.progress = 0
  }
  s.progress += dt
  if (s.progress < CAPTURE_S) return 0
  s.owner = holder
  s.taking = 0
  s.progress = 0
  return holder
}

/** Points held per side, for the HUD. */
export function heldBy(states: readonly PointState[]): Map<number, number> {
  const out = new Map<number, number>()
  for (const s of states) {
    if (!s.owner) continue
    out.set(s.owner, (out.get(s.owner) ?? 0) + 1)
  }
  return out
}
