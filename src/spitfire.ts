// The spitfire: a strafing run you aim but do not fly.
//
// Puzz: "one streak could be flying a spitfire plane with machine gun (slower
// bullets than chopper) and autopilot flies around the map in a predetermined
// route diagonally across the map, player chooses which corner/direction."
//
// The chopper is a vehicle — twenty seconds of stick time. This is the other
// kind of air support: you pick one of the four corners, the plane enters
// there on autopilot, crosses the board along the diagonal with its guns
// raking the ground beneath it, and leaves. One pass, no controls, gone.
//
// Everything here is pure arithmetic so it can run in Node — same discipline
// as chopper.ts. The wire carries only a corner and a start time; every
// client walks the same line from the same numbers, which is what makes a
// plane nobody steers a thing two screens can agree about.

import { ARENA_H, ARENA_W } from './arena'

/** 0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left. */
export type Corner = 0 | 1 | 2 | 3

export function asCorner(v: unknown): Corner | null {
  return v === 0 || v === 1 || v === 2 || v === 3 ? v : null
}

/**
 * Ground speed, px/s. Faster than the chopper's 340 — a plane that hovers is
 * a chopper with worse art — but slow enough that the pass is dodgeable by a
 * tank that reads the siren and moves off the diagonal.
 */
export const SPITFIRE_SPEED = 620
/** Altitude. Below the chopper's 300: it is making a strafing pass, not orbiting. */
export const SPITFIRE_ALT = 240
/**
 * The gun's footprint on the ground, centred under the plane. Wider than the
 * chopper's 54 because the plane never lingers — one pass has one chance at
 * whatever it crosses.
 */
export const SPITFIRE_SPREAD = 90
/**
 * One hull point per victim per this many ms. The chopper hits every 520;
 * "slower bullets than chopper" is this number — a tank the pass crosses
 * takes one, and only a tank driving *with* the plane down the diagonal
 * stays under the guns long enough to take more.
 */
export const SPITFIRE_HIT_MS = 600
export const SPITFIRE_DAMAGE = 1
/** Siren-to-arrival. Shorter than a strike's 2000 — a plane is already inbound. */
export const SPITFIRE_LEAD_MS = 1200
/** How far outside the fence the plane spawns and despawns. */
export const SPITFIRE_MARGIN = 260

/** The corner's board coordinate, on whichever board is up right now. */
export function cornerAt(c: Corner): { x: number; y: number } {
  return {
    x: c === 1 || c === 2 ? ARENA_W : 0,
    y: c === 2 || c === 3 ? ARENA_H : 0,
  }
}

/**
 * Where the plane is `t` ms into its run, and which way it points.
 *
 * The run is the corner-to-opposite-corner diagonal, extended `MARGIN` past
 * both fences so the plane flies in from off the board and leaves the same
 * way. `done` is the only lifecycle the caller needs: a pass that has flown
 * its length is over.
 */
export function spitfirePos(
  c: Corner,
  t: number,
): { x: number; y: number; angle: number; done: boolean } {
  const from = cornerAt(c)
  const to = cornerAt(((c + 2) % 4) as Corner)
  const dx = to.x - from.x
  const dy = to.y - from.y
  const diag = Math.hypot(dx, dy)
  const ux = dx / diag
  const uy = dy / diag
  const len = diag + SPITFIRE_MARGIN * 2
  const along = (t / 1000) * SPITFIRE_SPEED
  return {
    x: from.x - ux * SPITFIRE_MARGIN + ux * along,
    y: from.y - uy * SPITFIRE_MARGIN + uy * along,
    angle: Math.atan2(uy, ux),
    done: along > len,
  }
}

/** Is a tank under the guns right now? Same squared-circle test as the chopper. */
export function underStrafe(px: number, py: number, tx: number, ty: number): boolean {
  const dx = tx - px
  const dy = ty - py
  return dx * dx + dy * dy <= SPITFIRE_SPREAD * SPITFIRE_SPREAD
}
