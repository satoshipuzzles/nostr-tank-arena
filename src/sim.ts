// Tank and shell simulation. Deliberately slow and heavy: shells travel at
// roughly 2.5x tank speed, so at 150-300ms of relay latency the correct play is
// to lead your target. Latency becomes a skill instead of a stutter.

import {
  ARENA_H,
  ARENA_W,
  WALLS,
  arenaGravity,
  elevationAt,
  pointInShellWall,
  reflects,
  resolveCircle,
} from './arena'

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

/**
 * Lobbed shots — hold Q, let go, and the shell goes *over* the wall.
 *
 * Puzz: "Hold Q to lob shots over obstacles."
 *
 * A lob is a different weapon rather than a modified shell, and the difference
 * is worth naming: a flat shell is a ray that bounces, and a lob is a point on
 * the ground that will be dangerous in about a second. It cannot bounce, it
 * cannot be blocked, and it does not care where you were aiming when it lands.
 * That is the whole trade — cover stops being cover, and in exchange you give
 * up the instant hit and telegraph exactly where you are about to hit.
 *
 * The range comes from how long the key was held, and it rides out on the fire
 * event, because the landing point has to be a pure function of the same inputs
 * on every client. A lob whose range each client computed from its own charge
 * timer would land in a different crater on every screen, and the victim is the
 * one who applies the damage.
 */
export const LOB_MIN = 150
export const LOB_MAX = 620

/**
 * How far a lob goes for a given charge, on the board we are actually on.
 *
 * The one place gravity is read. Half gravity throws twice as far, which is
 * Moon Base and nothing else — every other layout leaves `arenaGravity` at 1
 * and this returns exactly what the two constants above always meant.
 *
 * It is also the *bound* the receiver clamps an incoming lob against, and that
 * is the part worth being careful about: the range rides the wire, so if the
 * shooter could charge to 1240 and the receiver clamped at 620, the crater
 * would land in two different places and the victim — who is the one who
 * applies the damage — would be applying the wrong one. Both sides derive the
 * board from `blockHash % LAYOUTS.length`, so both sides derive the same
 * bound, which is the same rule every other shared quantity in this game
 * follows.
 */
export const lobRange = (charge: number): number =>
  (LOB_MIN + (LOB_MAX - LOB_MIN) * Math.max(0, Math.min(1, charge))) / arenaGravity
/** How long the key is held to go from minimum range to maximum. */
export const LOB_CHARGE_MS = 900
/** Travel speed along the ground. Slower than a shell: you can see it coming. */
export const LOB_SPEED = 300
/** Apex of the arc, in world units, for the renderer. */
export const LOB_APEX = 150
/**
 * Blast radius on landing.
 *
 * Wider than a tank because a mortar you have to place perfectly is a mortar
 * nobody lands, and the two-second flight already gives the target time to walk
 * out of it. Sized so that a stationary tank is dead and a moving one is fine.
 */
export const LOB_BLAST = 62
export const RELOAD = 1.05 // seconds, between shots inside a magazine
export const RESPAWN_DELAY = 2.5 // seconds
/**
 * Shells in a magazine, and how long a full reload takes.
 *
 * Until now "reload" was only a cooldown, so a tank could never be caught
 * empty and the correct play with a target in the open was to hold the trigger
 * forever. A magazine is what makes ammo a resource: four shells is one
 * exchange, and the 2.4 seconds after the fourth is a window where the other
 * tank gets to close the distance for free. That window is the whole point —
 * it is what makes cover, positioning and the rapid-fire pickup matter, and it
 * is why the count is published on the state tick rather than kept private.
 *
 * Four and 2.4s are tuned against the 1.05s between shots: a magazine takes
 * about 3.2 seconds to empty, so the reload is roughly three quarters of the
 * time you spent shooting. Long enough to be a real loss, short enough that a
 * miss is not a death sentence.
 */
export const MAG_SIZE = 4
export const MAG_RELOAD = 2.4 // seconds
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
  /**
   * Ground range of a lobbed shot, or 0 for an ordinary flat shell.
   *
   * On the shell rather than looked up per client, for the same reason as the
   * bounce budget: everybody re-simulates this trajectory and everybody has to
   * agree where the crater is.
   */
  lob: number
  /** Distance covered, which is what a lob dies at rather than a wall. */
  travel: number
  /**
   * `Rect.id` of the last piece of cover this shell struck, or -1.
   *
   * Recorded here rather than acted on, because `sim.ts` does not know what a
   * barrel is and should not: this is the arithmetic layer, and "that rect has
   * two hits left" is a rule. `Game` reads it after every step.
   *
   * Set on the bounce as well as on the death, so the first two hits on a
   * barrel count even though the shell survives them.
   */
  struck: number
  /**
   * Set on the step the lob lands, before it is removed.
   *
   * A flat shell's damage happens where the shell is; a lob's happens where the
   * shell *stopped*, to everyone nearby including people it never touched. The
   * update loop needs to be able to tell those apart on the frame the shell
   * dies, and `dead` alone cannot — a lob that timed out mid-air and a lob that
   * arrived are both dead.
   */
  landed: boolean
  /**
   * The elevation of the muzzle this left, from `elevationAt` — 1 if fired on
   * high ground. Derived at spawn from the fire event's own coordinates, so
   * every client stamps the same value without it riding the wire. A high
   * shell crosses cliff edges instead of bouncing off them; see
   * `pointInShellWall`.
   */
  elev: number
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
  lob = 0,
): Shell {
  const speed = lob > 0 ? LOB_SPEED : SHELL_SPEED
  return {
    id,
    owner,
    x,
    y,
    vx: Math.cos(angle) * speed,
    vy: Math.sin(angle) * speed,
    bounces: 0,
    maxBounces,
    damage,
    lob,
    travel: 0,
    struck: -1,
    landed: false,
    // Rounded, not the raw fraction: a shell fired halfway up a ramp is
    // treated as fired from whichever level it was closer to, and every
    // client rounds the same way because the fraction is a pure function of
    // the layout and the fire coordinates.
    elev: elevationAt(x, y) >= 0.5 ? 1 : 0,
    age: 0,
    dead: false,
  }
}

/**
 * Height of a lobbed shell above the felt, 0 for a flat one.
 *
 * A parabola over the *fraction of the range covered*, not over elapsed time:
 * a client that receives the fire event 300ms late fast-forwards the shell by
 * distance, and an arc keyed to its own clock would pop the shell into the sky
 * at the moment it catches up.
 */
export function shellHeight(s: Shell): number {
  if (s.lob <= 0) return 0
  const u = Math.max(0, Math.min(1, s.travel / s.lob))
  return apexOf(s) * 4 * u * (1 - u)
}

/**
 * How high this particular lob goes.
 *
 * Scaled by the shell's own range rather than by the board's gravity, and that
 * is the point: the range rides the wire, so a client watching somebody else's
 * mortar draws the arc the shooter actually threw without needing to agree
 * about anything else. A shell within the ordinary maximum gets exactly
 * `LOB_APEX`, so nothing outside Moon Base moves by a pixel.
 */
export const apexOf = (s: Shell): number => LOB_APEX * Math.max(1, s.lob / LOB_MAX)

/** Is this shell high enough that walls and tanks are beneath it? */
export function shellAirborne(s: Shell): boolean {
  return s.lob > 0 && !s.landed
}

const SHELL_STEP = 1 / 120

/**
 * Advance a shell. Fixed sub-steps so that a client which receives the fire
 * event 200ms late can fast-forward it and land on the same trajectory as the
 * shooter — walls are static, so the path is a pure function of (x, y, angle, t).
 *
 * `pointInShellWall`, not `pointInWall`: sandbag barricades and water stop
 * tanks and not shells, and a shell fired from high ground crosses cliff
 * edges. That keeps the trajectory a pure function of the same inputs, because
 * which rects are low comes out of the layout, the layout comes out of the
 * block hash, and the shell's elevation comes out of its own fire coordinates
 * — every client re-simulating this shell already agrees on all three.
 */
export function stepShell(s: Shell, dt: number): void {
  // A lob is above the geometry for its whole flight, so it does not consult
  // the arena at all — it flies its range and then stops. Kept as its own loop
  // rather than as a branch inside the bounce loop because the two share almost
  // nothing: no walls, no reflection, no bounce budget, and a different reason
  // to die.
  if (s.lob > 0) {
    let left = dt
    while (left > 0 && !s.dead) {
      const step = Math.min(SHELL_STEP, left)
      left -= step
      s.age += step
      const speed = Math.hypot(s.vx, s.vy)
      const remain = s.lob - s.travel
      // Land on the exact point rather than wherever the last sub-step happened
      // to finish. This is not tidiness: a client that received the fire event
      // late fast-forwards by an arbitrary amount, so the sub-steps fall on
      // different boundaries on every screen, and taking one whole step past
      // the range put the crater up to 2.5px apart between clients. Small, and
      // still a divergence in the one number every client has to agree on.
      if (speed * step >= remain) {
        s.x += (s.vx / speed) * remain
        s.y += (s.vy / speed) * remain
        s.travel = s.lob
        s.landed = true
        s.dead = true
        return
      }
      s.x += s.vx * step
      s.y += s.vy * step
      s.travel += speed * step
      // A lob still has a lifetime, as a backstop. It cannot normally reach it
      // — LOB_MAX at LOB_SPEED is about two seconds — but a shell that somehow
      // outlives its range must not sit in the map forever.
      if (s.age > SHELL_LIFETIME) {
        s.dead = true
        return
      }
    }
    return
  }

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
    const wall = pointInShellWall(nx, ny, s.elev)
    if (!wall) {
      s.x = nx
      s.y = ny
      continue
    }
    // Which rect, for whoever cares. Every client re-simulating this shell from
    // the same fire event walks the same sub-steps into the same rect, so this
    // is the same number on every screen — which is what makes it usable as the
    // input to a rule other clients also apply.
    s.struck = wall.id ?? -1

    // Bounce off whichever axis we actually crossed this step.
    const hitX = pointInShellWall(nx, s.y, s.elev) !== null
    const hitY = pointInShellWall(s.x, ny, s.elev) !== null
    if (hitX) s.vx = -s.vx
    if (hitY) s.vy = -s.vy
    if (!hitX && !hitY) {
      // Clipped a corner exactly; reverse both.
      s.vx = -s.vx
      s.vy = -s.vy
    }
    // A mirrored panel does not charge for the ricochet. Everything else does,
    // and with a budget of one that is the difference between a shot that is
    // spent on the first wall it finds and a shot that keeps hunting down a
    // corridor of glass. See `reflects`.
    if (!reflects(wall)) {
      s.bounces++
      if (s.bounces > s.maxBounces) {
        s.dead = true
        return
      }
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
  /** When the next shot inside the current magazine is allowed. */
  reloadAt: number
  /** Shells left in the magazine. */
  ammo: number
  /** When the current magazine reload started, for the HUD's fill bar. */
  reloadingFrom: number
  /**
   * When a magazine reload finishes, or 0 when not reloading.
   *
   * Separate from `reloadAt` because they are different states and collapsing
   * them would make "one shell left, cooling down" indistinguishable from
   * "empty, reloading" — and the second is the one everybody else needs to be
   * able to see.
   */
  reloadingUntil: number
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
