// The arena. Static, deterministic, and identical on every client — which is
// what lets shells be re-simulated locally from a single "I fired" event
// instead of streaming their positions.

export const ARENA_W = 1600
export const ARENA_H = 1200

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Mirror a rect through the arena centre, giving 180-degree rotational symmetry. */
const flip = (r: Rect): Rect => ({
  x: ARENA_W - r.x - r.w,
  y: ARENA_H - r.y - r.h,
  w: r.w,
  h: r.h,
})

const BORDER = 24

const CORNER_COVER: Rect[] = [
  // Top-left L, and by symmetry the bottom-right one.
  { x: 300, y: 240, w: 220, h: 48 },
  { x: 300, y: 240, w: 48, h: 220 },
  // Top-right L, and by symmetry the bottom-left one.
  { x: 1080, y: 240, w: 220, h: 48 },
  { x: 1252, y: 240, w: 48, h: 220 },
]

export const WALLS: Rect[] = [
  // Outer ring.
  { x: 0, y: 0, w: ARENA_W, h: BORDER },
  { x: 0, y: ARENA_H - BORDER, w: ARENA_W, h: BORDER },
  { x: 0, y: 0, w: BORDER, h: ARENA_H },
  { x: ARENA_W - BORDER, y: 0, w: BORDER, h: ARENA_H },
  // Centre cross. Self-symmetric, breaks every long sightline through the middle.
  { x: ARENA_W / 2 - 150, y: ARENA_H / 2 - 24, w: 300, h: 48 },
  { x: ARENA_W / 2 - 24, y: ARENA_H / 2 - 150, w: 48, h: 300 },
  ...CORNER_COVER,
  ...CORNER_COVER.map(flip),
  // Mid pillars, something to strafe around on the way in.
  { x: 760, y: 300, w: 80, h: 80 },
  { x: 760, y: 820, w: 80, h: 80 },
]

/** Four spawns, one per corner, all equidistant from the centre. */
export const SPAWNS: { x: number; y: number }[] = [
  { x: 170, y: 170 },
  { x: ARENA_W - 170, y: 170 },
  { x: 170, y: ARENA_H - 170 },
  { x: ARENA_W - 170, y: ARENA_H - 170 },
]

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/**
 * Push a circle out of any wall it overlaps. Runs a couple of passes so a tank
 * wedged into an inside corner settles instead of oscillating between faces.
 */
export function resolveCircle(pos: { x: number; y: number }, radius: number): void {
  for (let pass = 0; pass < 3; pass++) {
    let moved = false
    for (const w of WALLS) {
      const nx = clamp(pos.x, w.x, w.x + w.w)
      const ny = clamp(pos.y, w.y, w.y + w.h)
      const dx = pos.x - nx
      const dy = pos.y - ny
      const d2 = dx * dx + dy * dy
      if (d2 >= radius * radius) continue

      if (d2 > 1e-6) {
        const d = Math.sqrt(d2)
        pos.x += (dx / d) * (radius - d)
        pos.y += (dy / d) * (radius - d)
      } else {
        // Centre is inside the box: eject along the shallowest face.
        const left = pos.x - w.x
        const right = w.x + w.w - pos.x
        const top = pos.y - w.y
        const bottom = w.y + w.h - pos.y
        const min = Math.min(left, right, top, bottom)
        if (min === left) pos.x = w.x - radius
        else if (min === right) pos.x = w.x + w.w + radius
        else if (min === top) pos.y = w.y - radius
        else pos.y = w.y + w.h + radius
      }
      moved = true
    }
    if (!moved) break
  }
}

export function pointInWall(x: number, y: number): Rect | null {
  for (const w of WALLS) {
    if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return w
  }
  return null
}

/** True if a straight line between two points is unobstructed. Used for spawn picking. */
export function hasLineOfSight(ax: number, ay: number, bx: number, by: number): boolean {
  const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / 16)
  for (let i = 1; i < steps; i++) {
    const t = i / steps
    if (pointInWall(ax + (bx - ax) * t, ay + (by - ay) * t)) return false
  }
  return true
}
