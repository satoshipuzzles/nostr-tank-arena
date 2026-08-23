// Tank and shell simulation. Deliberately slow and heavy: shells travel at
// roughly 2.5x tank speed, so at 150-300ms of relay latency the correct play is
// to lead your target. Latency becomes a skill instead of a stutter.

import { ARENA_H, ARENA_W, WALLS, pointInWall, resolveCircle } from './arena'

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
    if (!pointInWall(nx, ny)) {
      s.x = nx
      s.y = ny
      continue
    }

    // Bounce off whichever axis we actually crossed this step.
    const hitX = pointInWall(nx, s.y) !== null
    const hitY = pointInWall(s.x, ny) !== null
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
}

/** Integrate the local player's tank. Remote tanks are interpolated, not stepped. */
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
    const d = angleDelta(t.gun, aim)
    const max = GUN_TURN_RATE * dt
    t.gun += Math.abs(d) < max ? d : Math.sign(d) * max
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
