// The arena. Static within a round, and identical on every client — which is
// what lets shells be re-simulated locally from a single "I fired" event
// instead of streaming their positions.
//
// Which board is in play comes out of the current Bitcoin block hash. That is
// the whole synchronisation mechanism: nobody votes, nobody announces a map,
// there is no host to trust, and two clients that agree on the tip agree on the
// geometry because the geometry is a pure function of it.
//
// Boards are different *sizes* as well as different shapes. `ARENA_W` and
// `ARENA_H` are therefore live bindings rather than constants — an ES module
// export that is reassigned updates everywhere it was imported, so the
// simulation clamps to the new board and the renderer refits its camera without
// anything being passed around. `WALLS`, `SPAWNS` and `PADS` are mutated in
// place for the same reason.

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Pt {
  x: number
  y: number
}

const BORDER = 24

/** The outer fence, sized to the board. */
const ring = (w: number, h: number): Rect[] => [
  { x: 0, y: 0, w, h: BORDER },
  { x: 0, y: h - BORDER, w, h: BORDER },
  { x: 0, y: 0, w: BORDER, h },
  { x: w - BORDER, y: 0, w: BORDER, h },
]

/** Mirror through the centre, which is what makes a board fair. */
const flip = (r: Rect, w: number, h: number): Rect => ({
  x: w - r.x - r.w,
  y: h - r.y - r.h,
  w: r.w,
  h: r.h,
})

const flipPt = (p: Pt, w: number, h: number): Pt => ({ x: w - p.x, y: h - p.y })

export interface LayoutSpec {
  name: string
  w: number
  h: number
  /** Half the cover. The other half is this, rotated 180 degrees. */
  cover: (w: number, h: number) => Rect[]
  spawns: (w: number, h: number) => Pt[]
  /** Where pickups can appear. Mirrored, so no corner is closer to more of them. */
  pads: (w: number, h: number) => Pt[]
}

const corners = (w: number, h: number): Pt[] => [
  { x: 175, y: 175 },
  { x: w - 175, y: 175 },
  { x: 175, y: h - 175 },
  { x: w - 175, y: h - 175 },
]

/**
 * Four boards, three of them bigger than the original.
 *
 * Size is part of the variety: 1600x1200 is a knife fight with four players in
 * it, and 2000x1500 gives you somewhere to go. Every board is 180-degree
 * rotationally symmetric, because with a round that lasts a whole block an
 * unfair spawn is not something anyone can play around.
 */
export const LAYOUTS: LayoutSpec[] = [
  {
    name: 'Crossroads',
    w: 1600,
    h: 1200,
    cover: (w, h) => [
      { x: w / 2 - 150, y: h / 2 - 24, w: 150, h: 48 },
      { x: w / 2 - 24, y: h / 2 - 150, w: 48, h: 150 },
      { x: 300, y: 240, w: 220, h: 48 },
      { x: 300, y: 240, w: 48, h: 220 },
      { x: 1080, y: 240, w: 220, h: 48 },
      { x: 1252, y: 240, w: 48, h: 220 },
      { x: 760, y: 300, w: 80, h: 80 },
    ],
    spawns: corners,
    pads: (w, h) => [
      { x: w / 2, y: 210 },
      { x: 420, y: h / 2 },
      { x: 540, y: 360 },
    ],
  },
  {
    name: 'The Lanes',
    w: 2000,
    h: 1400,
    cover: (w, h) => [
      { x: 300, y: 430, w: 520, h: 48 },
      { x: 300, y: 730, w: 520, h: 48 },
      { x: 880, y: 160, w: 48, h: 380 },
      { x: w / 2 - 110, y: h / 2 - 24, w: 110, h: 48 },
      { x: 1180, y: 430, w: 220, h: 48 },
    ],
    spawns: corners,
    pads: (w, h) => [
      { x: w / 2, y: h / 2 - 230 },
      { x: 560, y: 580 },
      { x: 600, y: 1120 },
    ],
  },
  {
    name: 'Pillars',
    w: 1950,
    h: 1450,
    cover: () => [
      { x: 330, y: 300, w: 104, h: 104 },
      { x: 700, y: 300, w: 104, h: 104 },
      { x: 330, y: 640, w: 104, h: 104 },
      { x: 700, y: 640, w: 104, h: 104 },
      { x: 1070, y: 300, w: 104, h: 104 },
      { x: 515, y: 470, w: 104, h: 104 },
      { x: 885, y: 470, w: 104, h: 104 },
    ],
    spawns: corners,
    // Not the exact centre: this board is 180-degree symmetric, so a pad on
    // the centre point mirrors onto itself and the board quietly ships with two
    // pads in the same hole.
    pads: (w, h) => [
      { x: w / 2, y: 200 },
      { x: 200, y: h / 2 },
      { x: 540, y: 1020 },
    ],
  },
  {
    name: 'The Ring',
    w: 1900,
    h: 1400,
    cover: (w, h) => [
      { x: 520, y: 380, w: 420, h: 48 },
      { x: 520, y: 380, w: 48, h: 260 },
      { x: w - 568, y: 380, w: 48, h: 260 },
      { x: w / 2 - 70, y: h / 2 - 70, w: 140, h: 140 },
    ],
    spawns: (w, h) => [
      { x: 190, y: h / 2 },
      { x: w - 190, y: h / 2 },
      { x: w / 2, y: 170 },
      { x: w / 2, y: h - 170 },
    ],
    pads: (w) => [
      { x: w / 2, y: 300 },
      { x: 330, y: 330 },
      { x: 640, y: 700 },
    ],
  },
]

/**
 * Which board a block hash calls for.
 *
 * The last byte, so it moves every block and nobody has to be told. A hash we
 * do not have yet falls back to layout 0, which is the map this game shipped
 * with.
 */
export function layoutForBlock(hash: string | null): number {
  if (!hash || !/^[0-9a-f]{8,}$/i.test(hash)) return 0
  return parseInt(hash.slice(-2), 16) % LAYOUTS.length
}

// --------------------------------------------------------- the current board

/** Live bindings. Reassigned by `setLayout`, and every importer sees it. */
export let ARENA_W = LAYOUTS[0].w
export let ARENA_H = LAYOUTS[0].h
export let layoutName = ''

export const WALLS: Rect[] = []
export const SPAWNS: Pt[] = []
/**
 * Pickup pads. Positions only — what spawns on them is decided in `pickups.ts`.
 *
 * Three mirrored pairs per board, six pads in total. The count is not
 * decorative: the spawn schedule rotates a two-wide window through a
 * permutation of these, so six pads means three windows in a cycle, which is
 * what lets "never the same pad twice running" hold without the schedule ever
 * looking backwards. Four pads would leave only two windows and the rotation
 * would be a visible flip-flop.
 */
export const PADS: Pt[] = []

const listeners: ((index: number) => void)[] = []

export function onLayoutChange(fn: (index: number) => void): void {
  listeners.push(fn)
}

let currentLayout = -1

export function setLayout(index: number): void {
  const next = ((index % LAYOUTS.length) + LAYOUTS.length) % LAYOUTS.length
  if (next === currentLayout) return
  currentLayout = next
  const spec = LAYOUTS[next]

  ARENA_W = spec.w
  ARENA_H = spec.h
  layoutName = spec.name

  const half = spec.cover(spec.w, spec.h)
  WALLS.length = 0
  WALLS.push(...ring(spec.w, spec.h), ...half, ...half.map((r) => flip(r, spec.w, spec.h)))

  SPAWNS.length = 0
  SPAWNS.push(...spec.spawns(spec.w, spec.h))

  const pads = spec.pads(spec.w, spec.h)
  PADS.length = 0
  PADS.push(...pads, ...pads.map((p) => flipPt(p, spec.w, spec.h)))

  for (const fn of listeners) fn(next)
}

export const currentLayoutIndex = (): number => currentLayout

// A playable board before any block arrives.
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
