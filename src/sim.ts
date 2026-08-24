// Tank and shell simulation. Deliberately slow and heavy: shells travel at
// roughly 2.5x tank speed, so at 150-300ms of relay latency the correct play is
// to lead your target. Latency becomes a skill instead of a stutter.

import { ARENA_H, ARENA_W, WALLS, pointInTallWall, resolveCircle } from './arena'

export const TANK_RADIUS = 22
export const MAX_HP = 3
export const FORWARD_SPEED = 175 // px/s
export const REVERSE_SPEED = 105
export const TURN_RATE = 2.5 // rad/s
export const GUN_TURN_RATE = 4.2 // rad/s, the turret lags your aim on purpose
export const SHELL_SPEED = 430 // px/s
export const SHELL_RADIUS = 5
export const SHELL_LIFETIME = 4.0 // seconds
export const SHELL_BOUNCES = 1
export const RELOAD = 1.05 // seconds
export const RESPAWN_DELAY = 2.5 // seconds
export const MUZZLE_OFFSET = 26

export interface Shell {
  id: string
  owner: string // session pubkey of whoever fired
  x: number
  y: number
  vx: number
  vy: number
  bounces: number
  /**
   * Bounce budget, carried per shell rather than read from a global.
   *
   * The Ricochet block gives shells three. Keeping it on the shell means a
   * shell that was fired under the old rules keeps playing by them everywhere,
   * including on a client that has already seen the next block.
   */
  maxBounces: number
  /**
   * Hull points this shell takes off. Siege shells do two.
   *
   * Like the bounce budget, it belongs to the shell rather than to whoever is
   * looking at it — the *victim* applies the damage, and the victim has no way
   * to know what buffs the shooter had ten seconds ago.
   */
  damage: number
  age: number
  dead: boolean
}

/** Shortest signed angular difference from `a` to `b`. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d < -Math.PI) d += Math.PI * 2
  return d
}

export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDelta(a, b) * t
}

export function spawnShell(
  id: string,
  owner: string,
  x: number,
  y: number,
  angle: number,
  maxBounces = SHELL_BOUNCES,
  damage = 1,
): Shell {
  return {
    id,
    owner,
    x,
    y,
    vx: Math.cos(angle) * SHELL_SPEED,
    vy: Math.sin(angle) * SHELL_SPEED,
    bounces: 0,
    maxBounces,
    damage,
    age: 0,
    dead: false,
  }
}

const SHELL_STEP = 1 / 120

/**
 * Advance a shell. Fixed sub-steps so that a client which receives the fire
 * event 200ms late can fast-forward it and land on the same trajectory as the
 * shooter — walls are static, so the path is a pure function of (x, y, angle, t).
 *
 * `pointInTallWall`, not `pointInWall`: sandbag barricades stop tanks and not
 * shells. That keeps the trajectory a pure function of the same inputs, because
 * which rects are low comes out of the layout and the layout comes out of the
 * block hash — every client re-simulating this shell already agrees on it.
 */
export function stepShell(s: Shell, dt: number): void {
  let remaining = dt
  while (remaining > 0 && !s.dead) {
    const step = Math.min(SHELL_STEP, remaining)
    remaining -= step
    s.age += step
    if (s.age > SHELL_LIFETIME) {
      s.dead = true
      return
    }

    const nx = s.x + s.vx * step
    const ny = s.y + s.vy * step
    if (!pointInTallWall(nx, ny)) {
      s.x = nx
      s.y = ny
      continue
    }

    // Bounce off whichever axis we actually crossed this step.
    const hitX = pointInTallWall(nx, s.y) !== null
    const hitY = pointInTallWall(s.x, ny) !== null
    if (hitX) s.vx = -s.vx
    if (hitY) s.vy = -s.vy
    if (!hitX && !hitY) {
      // Clipped a corner exactly; reverse both.
      s.vx = -s.vx
      s.vy = -s.vy
    }
    s.bounces++
    if (s.bounces > s.maxBounces) {
      s.dead = true
      return
    }
    s.x += s.vx * step
    s.y += s.vy * step
  }
}

export function shellHits(s: Shell, x: number, y: number): boolean {
  const r = TANK_RADIUS + SHELL_RADIUS
  return (s.x - x) ** 2 + (s.y - y) ** 2 <= r * r
}

export interface LocalTank {
  x: number
  y: number
  hull: number
  gun: number
  hp: number
  dead: boolean
  respawnAt: number
  reloadAt: number
  /**
   * Where the turret is being told to point, kept as a signed offset from the
   * gun rather than as a bearing, so that a full turn ahead and no turns ahead
   * are different numbers. See the note above `stepTank`. Owned by `stepTank`;
   * nothing else should write them, and nothing needs to initialise them.
   */
  aimPrev?: number
  gunLead?: number
}

/** One full turn, in radians. */
const TAU = Math.PI * 2

/**
 * Drop whole turns out of a lead while keeping its sign.
 *
 * Winding up three turns ahead of the gun and winding up one turn ahead point
 * at the same bearing, and the two extra laps are travel nobody asked to
 * watch. What must survive is the *sign*, because that is the direction the
 * player has been turning.
 */
function windReduce(lead: number): number {
  return lead % TAU
}

/**
 * Integrate the local player's tank. Remote tanks are interpolated, not stepped.
 *
 * The turret used to take the shortest path from where it is to the bearing
 * you are asking for, recomputed from scratch every frame. That is right only
 * while it can keep up. It slews at 241°/s and a thumb can rotate a stick
 * faster than that, so the gap grows — and the instant the gap passes half a
 * circle the shortest way to the same bearing is *backwards*. The turret turns
 * around and drives away from where you are pointing. Measured on this sim at
 * a fixed 60fps: a steady 240°/s spin tracks all the way round, 420°/s covers
 * 273° of 720° and reverses twice, 900°/s covers 74° and reverses three times.
 *
 * Nothing about that is a rendering or an input problem, which is why it shows
 * up the same in the cockpit and on the board, with a pad or with a mouse.
 *
 * So the command is carried as a *lead* — a signed offset from the gun that is
 * allowed to be more than half a turn — and advanced by how far the command
 * moved this frame rather than re-derived from the bearing. The direction the
 * player is turning survives, the gun always travels the way they are asking,
 * and it arrives on the right bearing when they stop.
 */
export function stepTank(
  t: LocalTank,
  throttle: number,
  steer: number,
  aim: number | null,
  dt: number,
  /** Overdrive, from a pickup. 1 is the normal tank. */
  speedMul = 1,
): void {
  t.hull += steer * TURN_RATE * dt
  if (aim !== null) {
    // How far the command itself moved since the last frame. This is the only
    // quantity in here that can be measured the short way round without
    // ambiguity: a thumb spinning the stick at 900°/s covers 15° in a 60fps
    // frame, nowhere near the half circle where "which way did it go" stops
    // having an answer.
    const step = t.aimPrev === undefined ? 0 : angleDelta(t.aimPrev, aim)
    const shortest = angleDelta(t.gun, aim)
    // Carried lead, advanced by that step. It stays consistent with the gun
    // because we subtract below exactly what the gun travels — so if it ever
    // *isn't* consistent, something outside moved the gun (respawn points it
    // down the hull) and the carried value is stale. Adopt the short way round
    // in that case, which is right for a gun that has just been placed.
    const carried = (t.gunLead ?? 0) + step
    const stale = t.aimPrev === undefined || Math.abs(angleDelta(carried, shortest)) > 1e-6
    const lead = stale ? shortest : windReduce(carried)

    const max = GUN_TURN_RATE * dt
    const turn = Math.abs(lead) < max ? lead : Math.sign(lead) * max
    t.gun += turn
    t.gunLead = lead - turn
    t.aimPrev = aim
  } else {
    // Nothing is asking for a bearing, so there is no direction of travel to
    // remember. Letting go of the stick and picking it up somewhere else
    // should take the short way round, not resume an old lap.
    t.aimPrev = undefined
    t.gunLead = 0
  }

  const speed = (throttle >= 0 ? throttle * FORWARD_SPEED : throttle * REVERSE_SPEED) * speedMul
  t.x += Math.cos(t.hull) * speed * dt
  t.y += Math.sin(t.hull) * speed * dt

  resolveCircle(t, TANK_RADIUS)
  t.x = Math.max(TANK_RADIUS, Math.min(ARENA_W - TANK_RADIUS, t.x))
  t.y = Math.max(TANK_RADIUS, Math.min(ARENA_H - TANK_RADIUS, t.y))
}

/** Exported so the renderer can draw the same geometry the sim collides against. */
export { WALLS }
