// Ten kills and you get out of the tank.
//
// Puzz: "10kills — Chopper: Man a machinegun flying over the map for 10
// seconds."
//
// This is the first reward in the game that is not a buff. Everything above it
// changes a number on your tank — hull, reload, damage, speed — and this takes
// the tank away and hands you a different vehicle with a different job. That is
// the whole appeal and it is also why it needed thinking about rather than a
// new case in the streak switch.
//
// Three decisions, and the netcode one is the reason the other two are shaped
// the way they are.
//
// **Nothing new goes on the wire.** A machinegun is ten rounds a second; ten
// fire events a second, on top of a position tick that is already 10Hz, is
// past what most public relays will take at all. So the chopper rides the state
// tick that is already going out: while it is up, `x`/`y` are the chopper
// rather than the tank, `c` says how much time is left, and `cx`/`cy` are the
// point on the ground it is shooting at. Four optional fields on a tick that
// already carries seven, present for ten seconds out of a ten-minute block.
//
// **Damage is applied by the victim, exactly like a shell.** Nobody is told
// they were hit; each client reads the choppers it can see and asks "am I under
// that". Our own hull is the one number this client is allowed to decide, which
// is the same rule the rest of the game runs on and needs no new trust.
//
// **The tank leaves the board.** You cannot be shot while you are flying, and
// on the way down you respawn — so the reward is ten seconds of being dangerous
// and untouchable, and the cost is that your tank is not holding any ground
// while you enjoy it. It also removes the question nobody wants to answer at a
// glance: whether the thing on the ground with your name on it is you.
//
// The chopper cannot be shot down. Tanks in this game have no elevation and no
// anti-air, and inventing one for a ten-second window would be a whole weapon
// nobody asked for. It says so in the README rather than being a silent rule.

import { ARENA_H, ARENA_W } from './arena'

/**
 * How long you are up there.
 *
 * Twenty seconds, doubled from ten at Puzz's request after he called it "the
 * funniest thing ever". Worth watching: twenty seconds is a long time for a
 * tank to be out of play, and the tank being off the board is the whole cost
 * that balances being untouchable. If it starts reading as too long, the honest
 * lever is `CHOPPER_HIT_MS` rather than clawing the duration back — a shorter
 * reward that kills faster is a worse trade than a long one you have to aim.
 */
export const CHOPPER_MS = 20_000

/**
 * How fast the chopper crosses the board, in px/s.
 *
 * Twice a tank, because a chopper that handles like a tank is a tank you cannot
 * be shot in. The board is 1600 across, so this is about six seconds corner to
 * corner — long enough that where you go is a decision, short enough that you
 * can reach a fight you can see.
 */
export const CHOPPER_SPEED = 340

/** Height above the felt, for the renderer and for nothing else. */
export const CHOPPER_ALT = 300

/**
 * How far ahead of the chopper the gun can reach, and how wide it lands.
 *
 * The reach is deliberately not the whole board: a gunship that can hit
 * anything from anywhere never has to fly, and flying is the half of this that
 * is fun. The spread is wider than a tank so a moving target is hit sometimes
 * rather than always — the rate below is what makes it deadly, not precision.
 */
export const CHOPPER_REACH = 520
export const CHOPPER_SPREAD = 54

/**
 * Time between hits on the same target, in ms.
 *
 * Not the fire rate — the fire rate is cosmetic, a stream of tracers each
 * client draws for itself. This is the only number that decides how quickly the
 * gun kills, and it is one hull point per interval: three of these and a full
 * tank is gone, so a target that starts running immediately lives and one that
 * does not, does not. Deliberately slower than it looks, because it looks like
 * a machinegun.
 */
export const CHOPPER_HIT_MS = 520

/** What one hit takes off. */
export const CHOPPER_DAMAGE = 1

/**
 * Where a chopper's rounds are landing, given where it is and where it aims.
 *
 * Clamped to the board and to the gun's reach, and clamped **here** rather than
 * at the two call sites, because this runs on every client for every chopper in
 * the air: the one that is flying it, and everybody deciding whether they are
 * standing in it. A reach enforced only by the shooter is a reach a modified
 * client does not have.
 */
export function chopperAim(
  x: number,
  y: number,
  aimX: number,
  aimY: number,
): { x: number; y: number } {
  const dx = aimX - x
  const dy = aimY - y
  const d = Math.hypot(dx, dy)
  const k = d > CHOPPER_REACH ? CHOPPER_REACH / d : 1
  return {
    x: Math.max(0, Math.min(ARENA_W, x + dx * k)),
    y: Math.max(0, Math.min(ARENA_H, y + dy * k)),
  }
}

/** Is a tank at (tx, ty) standing in the rounds landing at (ax, ay)? */
export function underFire(ax: number, ay: number, tx: number, ty: number): boolean {
  return (tx - ax) ** 2 + (ty - ay) ** 2 <= CHOPPER_SPREAD * CHOPPER_SPREAD
}

/**
 * Step a chopper the player is flying.
 *
 * Free of the arena on purpose: it is three hundred units up, and a gunship
 * that bumps into a hedge is a joke rather than a reward. The board edge still
 * holds it, because flying off the map is not a place to be.
 */
export function stepChopper(
  pos: { x: number; y: number },
  throttle: number,
  steer: number,
  dt: number,
): void {
  // Screen-space, not hull-relative. There is no hull: the chopper has no
  // facing of its own and the player is looking straight down at a board, so
  // "push right, go right" is the only reading that is not a puzzle.
  const m = Math.hypot(throttle, steer)
  if (m > 1e-4) {
    const k = Math.min(1, m) / m
    pos.x += steer * k * CHOPPER_SPEED * dt
    pos.y -= throttle * k * CHOPPER_SPEED * dt
  }
  const margin = 40
  pos.x = Math.max(margin, Math.min(ARENA_W - margin, pos.x))
  pos.y = Math.max(margin, Math.min(ARENA_H - margin, pos.y))
}
