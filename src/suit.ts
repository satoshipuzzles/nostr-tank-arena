// Fifteen kills and you get *out* of the tank — on foot, in something worse.
//
// Puzz: "juggernaut where player gets this huge metal gear solid looking suit
// and can walk around with machine guns spitting out dozens of bullets per
// second."
//
// The juggernaut used to be a buff: full hull, a shield and a speed boost for
// twelve seconds, which is three numbers going up and nothing to look at. This
// makes it the second vehicle swap in the game after the chopper, and the two
// are deliberately opposites — the gunship takes your tank *off* the board and
// makes you untouchable, and the suit leaves you standing in the middle of it
// where everyone can shoot at you. That is the trade the tier is for.
//
// Three decisions, all of them shaped by the same constraint the chopper had.
//
// **Nothing new goes on the wire.** "Dozens of bullets per second" is dozens of
// events per second on top of a 10Hz position tick, which is past what any
// public relay will take. So the suit rides the tick that is already going
// out: `j` is the milliseconds left, `jx`/`jy` are the point the guns are
// hosing. The tracers between are drawn by each client for itself and are not
// on the wire at all — exactly like the chopper's.
//
// **Damage is applied by the victim.** Nobody is told they were hit. Each
// client reads the suits it can see and asks "am I standing in that", which is
// the same rule as a shell and needs no new trust.
//
// **You are still on the board.** Your `x`/`y` are still yours, you can still
// be shot, and the armour is what keeps you standing rather than absence. The
// suit is slower than the tank, so the cost of all that firepower is that you
// cannot leave — a juggernaut who picks the wrong ground is a juggernaut who
// dies in it.
//
// The gun is not a shell gun: no magazine, no reload, no lob. Holding fire
// hoses a point and keeps hosing it.

import { ARENA_H, ARENA_W } from './arena'

/**
 * How long you are out of the tank.
 *
 * Fourteen seconds, up from the twelve the old buff ran for. A vehicle swap
 * needs long enough to *use*: the first two seconds go on realising what
 * happened and turning to face something, and a reward that ends there is a
 * reward nobody remembers.
 */
export const SUIT_MS = 14_000

/**
 * How fast the suit walks, as a fraction of the tank's speed.
 *
 * Slower, and it has to be. The suit hits harder than anything else on the
 * ground and it is the only thing on the board that can fire continuously; if
 * it also moved like a tank there would be no counterplay except a better
 * suit. At 0.62 a tank can still choose the range — which is the counterplay,
 * and it is one a player can find on their own within a second of trying.
 */
export const SUIT_SPEED = 0.62

/**
 * How far the guns reach, and how wide the rounds land.
 *
 * Shorter than the chopper's 520 — you are standing on the same felt as your
 * targets rather than three hundred units above it, so a reach that crossed
 * half the board would make the tier-15 reward a sniper rifle that also cannot
 * be killed. The spread is tighter than the chopper's for the same reason: this
 * one is aimed rather than flown.
 */
export const SUIT_REACH = 300
export const SUIT_SPREAD = 44

/**
 * Time between hits on the same target, in ms.
 *
 * Not the fire rate. The fire rate is cosmetic — a stream of tracers each
 * client draws for itself, which is the "dozens of bullets per second" half of
 * the ask. This is the only number that decides how fast the guns kill, and it
 * is one hull point per interval: a full tank goes down in about a second of
 * being held in the stream, and a tank that breaks contact immediately lives.
 *
 * Faster than the chopper's 520 because the chopper cannot be shot back at and
 * this can.
 */
export const SUIT_HIT_MS = 340

/** What one burst takes off. */
export const SUIT_DAMAGE = 1

/** How high off the felt the muzzles sit, for the renderer and nothing else. */
export const SUIT_MUZZLE = 34

/**
 * Where a suit's rounds are landing, given where it stands and where it aims.
 *
 * Clamped to the board and to the gun's reach, and clamped **here** rather than
 * at the call sites, because this runs on every client for every suit on the
 * board: the one wearing it, and everybody deciding whether they are standing
 * in it. A reach enforced only by the shooter is a reach a modified client does
 * not have. Same shape as `chopperAim`, deliberately.
 */
export function suitAim(
  x: number,
  y: number,
  aimX: number,
  aimY: number,
): { x: number; y: number } {
  const dx = aimX - x
  const dy = aimY - y
  const d = Math.hypot(dx, dy)
  const k = d > SUIT_REACH ? SUIT_REACH / d : 1
  return {
    x: Math.max(0, Math.min(ARENA_W, x + dx * k)),
    y: Math.max(0, Math.min(ARENA_H, y + dy * k)),
  }
}

/** Is a tank at (tx, ty) standing in the rounds landing at (ax, ay)? */
export function underSuitFire(ax: number, ay: number, tx: number, ty: number): boolean {
  return (tx - ax) ** 2 + (ty - ay) ** 2 <= SUIT_SPREAD * SUIT_SPREAD
}
