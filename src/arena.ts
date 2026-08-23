// The arena. Static within a round, and identical on every client — which is
// what lets shells be re-simulated locally from a single "I fired" event
// instead of streaming their positions.
//
// "Identical on every client" used to be easy: there was one map, compiled in.
// Now there are four, and which one is in play comes out of the current Bitcoin
// block hash. That is the whole synchronisation mechanism. Nobody votes, nobody
// announces a map, and there is no host to trust — two clients that agree on
// the tip agree on the geometry, because the geometry is a pure function of it.
//
// `WALLS` and `SPAWNS` are therefore mutable arrays rather than constants, and
// they are mutated **in place** so that every module holding a reference (the
// simulation, the renderer) sees the new layout without re-importing anything.

export const ARENA_W = 1600
export const ARENA_H = 1200

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const BORDER = 24

/** Mirror a rect through the arena centre, giving 180-degree rotational symmetry. */
const flip = (r: Rect): Rect => ({
  x: ARENA_W - r.x - r.w,
  y: ARENA_H - r.y - r.h,
  w: r.w,
  h: r.h,
})

/** Every layout gets the same outer fence. */
const RING: Rect[] = [
  { x: 0, y: 0, w: ARENA_W, h: BORDER },
  { x: 0, y: ARENA_H - BORDER, w: ARENA_W, h: BORDER },
  { x: 0, y: 0, w: BORDER, h: ARENA_H },
  { x: ARENA_W - BORDER, y: 0, w: BORDER, h: ARENA_H },
]

/** Half a layout, mirrored through the centre to guarantee it is fair. */
const symmetric = (half: Rect[]): Rect[] => [...RING, ...half, ...half.map(flip)]

export interface Layout {
  name: string
  walls: Rect[]
  spawns: { x: number; y: number }[]
}

const CORNERS = [
  { x: 170, y: 170 },
  { x: ARENA_W - 170, y: 170 },
  { x: 170, y: ARENA_H - 170 },
  { x: ARENA_W - 170, y: ARENA_H - 170 },
]

/**
 * Four boards. Each is 180-degree rotationally symmetric, so no corner is a
 * better place to spawn than any other — with four players and a block-long
 * round, an unfair map is not something anyone can play around.
 */
export const LAYOUTS: Layout[] = [
  {
    // The original. Long sightlines broken by a cross you have to commit to.
    name: 'Crossroads',
    walls: symmetric([
      { x: ARENA_W / 2 - 150, y: ARENA_H / 2 - 24, w: 150, h: 48 },
      { x: ARENA_W / 2 - 24, y: ARENA_H / 2 - 150, w: 48, h: 150 },
      { x: 300, y: 240, w: 220, h: 48 },
      { x: 300, y: 240, w: 48, h: 220 },
      { x: 1080, y: 240, w: 220, h: 48 },
      { x: 1252, y: 240, w: 48, h: 220 },
      { x: 760, y: 300, w: 80, h: 80 },
    ]),
    spawns: CORNERS,
  },
  {
    // Open middle, heavy cover on the flanks. Rewards crossing fast.
    name: 'The Lanes',
    walls: symmetric([
      { x: 260, y: 380, w: 420, h: 48 },
      { x: 260, y: 620, w: 420, h: 48 },
      { x: 700, y: 150, w: 48, h: 300 },
      { x: ARENA_W / 2 - 90, y: ARENA_H / 2 - 24, w: 90, h: 48 },
    ]),
    spawns: CORNERS,
  },
  {
    // A forest of pillars. Shells bounce once, so this one is about ricochets.
    name: 'Pillars',
    walls: symmetric([
      { x: 300, y: 260, w: 96, h: 96 },
      { x: 620, y: 260, w: 96, h: 96 },
      { x: 300, y: 540, w: 96, h: 96 },
      { x: 620, y: 540, w: 96, h: 96 },
      { x: 940, y: 260, w: 96, h: 96 },
      { x: 460, y: 400, w: 96, h: 96 },
    ]),
    spawns: CORNERS,
  },
  {
    // A ring you fight around, with four gaps. Closest thing to a board game.
    name: 'The Ring',
    walls: symmetric([
      { x: 440, y: 320, w: 340, h: 48 },
      { x: 440, y: 320, w: 48, h: 220 },
      { x: 1112, y: 320, w: 48, h: 220 },
      { x: ARENA_W / 2 - 60, y: ARENA_H / 2 - 60, w: 120, h: 120 },
    ]),
    spawns: [
      { x: 170, y: ARENA_H / 2 },
      { x: ARENA_W - 170, y: ARENA_H / 2 },
      { x: ARENA_W / 2, y: 150 },
      { x: ARENA_W / 2, y: ARENA_H - 150 },
    ],
  },
]

/**
 * Which board a block hash calls for.
 *
 * The last byte, so it moves every block and no client has to be told. A hash
 * we do not have yet (offline, or the tip is still loading) falls back to
 * layout 0, which is the map this game shipped with.
 */
export function layoutForBlock(hash: string | null): number {
  if (!hash || !/^[0-9a-f]{8,}$/i.test(hash)) return 0
  return parseInt(hash.slice(-2), 16) % LAYOUTS.length
}

/**
 * The geometry in play. Mutated in place on purpose — `sim.ts` and `render.ts`
 * both hold this exact array, and re-assigning the binding would leave them
 * colliding against the previous board.
 */
export const WALLS: Rect[] = []
export const SPAWNS: { x: number; y: number }[] = []

/** Name of the layout currently loaded, for the HUD. */
export let layoutName = ''

/** Listeners that need to rebuild something when the board changes. */
const listeners: ((index: number) => void)[] = []

export function onLayoutChange(fn: (index: number) => void): void {
  listeners.push(fn)
}

let currentLayout = -1

export function setLayout(index: number): void {
  const next = ((index % LAYOUTS.length) + LAYOUTS.length) % LAYOUTS.length
  if (next === currentLayout) return
  currentLayout = next
  const layout = LAYOUTS[next]
  WALLS.length = 0
  WALLS.push(...layout.walls)
  SPAWNS.length = 0
  SPAWNS.push(...layout.spawns)
  layoutName = layout.name
  for (const fn of listeners) fn(next)
}

export const currentLayoutIndex = (): number => currentLayout

// Load the default board at import time, so a client that never reaches a block
// API still has a playable arena.
setLayout(0)

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
