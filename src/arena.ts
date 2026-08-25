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

/**
 * What a piece of cover is made of.
 *
 * Not decoration, and not colour-coding wearing a costume. Four players
 * shouting at one television need to be able to *name* a place, and the
 * material is the name: "behind the crates", "the far hedge", "the boulder in
 * the middle". The board used to do this job with pastel paint — a pink cross,
 * yellow pillars, blue corner Ls — which named things by a property the eye
 * has to compare against the tanks, and the tanks are the six most saturated
 * things on the board. A stack of timber crates is legible next to a cyan
 * tank in a way that a yellow block is not.
 *
 * `fence` is the board's outer ring and is generated, never authored.
 */
export type CoverKind = 'rock' | 'crate' | 'barrel' | 'sandbag' | 'hedge' | 'fence'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
  /** Absent on the generated fence pieces until `ring` stamps them. */
  kind?: CoverKind
  /**
   * Position in `WALLS`, stamped by `setLayout`.
   *
   * Every client builds `WALLS` from the same layout in the same order, and the
   * layout comes from the block hash — so this index means the same rect on
   * every screen for as long as the round lasts. That is what makes it safe to
   * put on the wire, and it is the only reason a barrel can be destroyed
   * without shipping its coordinates around.
   */
  id?: number
  /**
   * Hits left. Present only on the kinds that can be destroyed.
   *
   * `undefined` is "indestructible" rather than "zero", which is why every read
   * of it is a `!== undefined` and not a truthiness check — a barrel on its
   * last legs has `hp === 1` and a rock has no hp at all.
   */
  hp?: number
  /** Blown up. Still in `WALLS`, and skipped by everything that collides. */
  gone?: boolean
}

/**
 * Barricades: a tank is stopped, a shell goes over.
 *
 * The one piece of this pass that is a rules change rather than a paint job,
 * and it is deliberately a single kind rather than a height field. Sandbags
 * channel where tanks can drive without creating anywhere to hide, which turns
 * the middle of Crossroads from a wall you circle into a line you duel across.
 *
 * It is safe on the wire for the same reason the map is: cover comes from the
 * layout, the layout comes from the block hash, and two clients that agree on
 * the tip agree on which rects are low. Nothing about it is derived locally.
 *
 * The flip side, and it is in the README too: standing behind sandbags does
 * nothing for you. They are a movement obstacle, not cover, and a player who
 * expects otherwise learns it the hard way. Naming them after the one thing
 * on a battlefield you actually can shoot over is the best signpost available.
 */
const LOW_KINDS: ReadonlySet<CoverKind> = new Set<CoverKind>(['sandbag'])

/** True if shells pass over this rect. Tanks are stopped by it regardless. */
export const isLow = (r: Rect): boolean => r.kind !== undefined && LOW_KINDS.has(r.kind)

/**
 * Cover that can be shot away, and how many hits it takes.
 *
 * Puzz: "Walls and obstacles can be damaged and blown up. Barrels can be blown
 * up after x amount of hits."
 *
 * Barrels only, for now. They are the one kind already scattered as single
 * blocks rather than as walls, so removing one opens a lane without turning a
 * board into a different board — and a barrel is the thing on a battlefield
 * everybody already expects to go up. Rocks and hedges are the skeleton of a
 * layout and are what stop a round from dissolving into an open field by
 * minute eight.
 *
 * Three hits: one shell is an accident, three is a decision. It is also a whole
 * magazine minus one, so clearing a lane costs a reload you have to survive.
 */
const DESTRUCTIBLE: ReadonlySet<CoverKind> = new Set<CoverKind>(['barrel'])
export const BARREL_HP = 3

/** Every destructible rect on the current board, in `WALLS` order. */
export const BARRELS: Rect[] = []

/**
 * Bumped whenever a barrel's state changes, including a layout swap.
 *
 * The renderer holds meshes for the board and rebuilds them when this moves,
 * rather than checking sixty rects a frame for a flag that changes twice a
 * round. An epoch is also what makes "the board changed" a single comparison
 * for a test that wants to wait for it.
 */
let coverEpoch = 0
export const coverGeneration = (): number => coverEpoch

// Declared here rather than beside the rest of the destruction API at the foot
// of this file, and that is load-bearing: `setLayout(0)` runs at module load to
// give the game a playable board before any block arrives, and it bumps this.
// A `let` further down the file is in its temporal dead zone at that moment, so
// the whole module threw "Cannot access before initialization" and the game
// never started at all.

export interface Pt {
  x: number
  y: number
}

const BORDER = 24

/** The outer fence, sized to the board. */
const ring = (w: number, h: number): Rect[] => [
  { x: 0, y: 0, w, h: BORDER, kind: 'fence' },
  { x: 0, y: h - BORDER, w, h: BORDER, kind: 'fence' },
  { x: 0, y: 0, w: BORDER, h, kind: 'fence' },
  { x: w - BORDER, y: 0, w: BORDER, h, kind: 'fence' },
]

/** Mirror through the centre, which is what makes a board fair. */
const flip = (r: Rect, w: number, h: number): Rect => ({
  x: w - r.x - r.w,
  y: h - r.y - r.h,
  w: r.w,
  h: r.h,
  // Carried, not dropped. Symmetry is what makes a board fair, and a mirrored
  // rect that came back a different material would be a rect shells treat
  // differently on one half of the board than the other.
  kind: r.kind,
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
 * Eight boards, and the size range is as much of the variety as the shapes are.
 *
 * 1500x1100 is a knife fight with four players in it; 2100x1550 gives you
 * somewhere to go and three seconds to watch somebody come and get you. Every
 * board is 180-degree rotationally symmetric, because with a round that lasts a
 * whole block an unfair spawn is not something anyone can play around.
 *
 * Eight rather than four because the map comes off the block hash and nothing
 * else: at four, a given board turns up every other block or so and an evening
 * is mostly two arenas. `layoutForBlock` takes the count from this array's
 * length, so adding a board here is the whole change.
 */
export const LAYOUTS: LayoutSpec[] = [
  {
    name: 'Crossroads',
    w: 1600,
    h: 1200,
    // The cross in the middle is sandbags, which is the biggest single change
    // to how this board plays: it used to be the wall everybody circled, and
    // now it is a line four tanks can shoot across and none of them can drive
    // through. The corner cover stays solid so there is still somewhere to go.
    cover: (w, h) => [
      { x: w / 2 - 150, y: h / 2 - 24, w: 150, h: 48, kind: 'sandbag' },
      { x: w / 2 - 24, y: h / 2 - 150, w: 48, h: 150, kind: 'sandbag' },
      { x: 300, y: 240, w: 220, h: 48, kind: 'crate' },
      { x: 300, y: 240, w: 48, h: 220, kind: 'crate' },
      { x: 1080, y: 240, w: 220, h: 48, kind: 'hedge' },
      { x: 1252, y: 240, w: 48, h: 220, kind: 'hedge' },
      { x: 760, y: 300, w: 80, h: 80, kind: 'rock' },
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
    // Long hedgerows make the lanes read as lanes from the board camera, where
    // two 520-unit walls of the same grey are just a corridor you can get lost
    // in. The boulder at 880 is the one landmark on the way through.
    cover: (w, h) => [
      { x: 300, y: 430, w: 520, h: 48, kind: 'hedge' },
      { x: 300, y: 730, w: 520, h: 48, kind: 'hedge' },
      { x: 880, y: 160, w: 48, h: 380, kind: 'rock' },
      { x: w / 2 - 110, y: h / 2 - 24, w: 110, h: 48, kind: 'sandbag' },
      { x: 1180, y: 430, w: 220, h: 48, kind: 'crate' },
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
    // Seven identical squares was the board that needed this most: from the
    // board camera it was a grid of blocks with nothing to call any of them.
    // Same seven footprints, three different things standing on them, and the
    // fight over the middle now happens at "the barrels".
    cover: () => [
      { x: 330, y: 300, w: 104, h: 104, kind: 'rock' },
      { x: 700, y: 300, w: 104, h: 104, kind: 'crate' },
      { x: 330, y: 640, w: 104, h: 104, kind: 'rock' },
      { x: 700, y: 640, w: 104, h: 104, kind: 'barrel' },
      { x: 1070, y: 300, w: 104, h: 104, kind: 'rock' },
      { x: 515, y: 470, w: 104, h: 104, kind: 'barrel' },
      { x: 885, y: 470, w: 104, h: 104, kind: 'crate' },
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
    // The long arm is the barricade here rather than the middle, because this
    // board spawns two players on the short edges facing each other down the
    // centre line and a wall across it made that opening thirty seconds of
    // driving. Now it is a shot.
    cover: (w, h) => [
      { x: 520, y: 380, w: 420, h: 48, kind: 'sandbag' },
      { x: 520, y: 380, w: 48, h: 260, kind: 'hedge' },
      { x: w - 568, y: 380, w: 48, h: 260, kind: 'crate' },
      { x: w / 2 - 70, y: h / 2 - 70, w: 140, h: 140, kind: 'rock' },
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
  {
    name: 'The Yard',
    w: 1500,
    h: 1100,
    // The small one. Four tanks on 1500x1100 is a knife fight, and the cover is
    // stacked close enough that most exchanges start inside one reload — which
    // is the point, because the four boards above it all reward driving and
    // none of them reward standing still. The sandbag line through the middle
    // is the only long shot on the board and everybody can take it at once.
    cover: () => [
      { x: 250, y: 250, w: 180, h: 48, kind: 'crate' },
      { x: 250, y: 250, w: 48, h: 180, kind: 'crate' },
      { x: 620, y: 170, w: 48, h: 230, kind: 'crate' },
      { x: 380, y: 500, w: 260, h: 48, kind: 'sandbag' },
      { x: 880, y: 430, w: 130, h: 48, kind: 'barrel' },
      { x: 1120, y: 620, w: 110, h: 110, kind: 'rock' },
    ],
    spawns: corners,
    pads: (w, h) => [
      { x: w / 2, y: 150 },
      { x: 170, y: h / 2 },
      { x: 760, y: 720 },
    ],
  },
  {
    name: 'The Quarry',
    w: 2100,
    h: 1550,
    // The big one, and deliberately the emptiest. Two boulders, a spine of
    // rock, and a great deal of nothing — a board where you can see somebody
    // coming for three seconds before they arrive, which is a completely
    // different game from The Yard and worth having in the rotation for that
    // alone. The sandbag runs are the only way to break a sight line without
    // going all the way around a boulder.
    cover: () => [
      { x: 380, y: 300, w: 190, h: 190, kind: 'rock' },
      { x: 780, y: 620, w: 150, h: 150, kind: 'rock' },
      { x: 240, y: 820, w: 48, h: 260, kind: 'sandbag' },
      { x: 1150, y: 260, w: 48, h: 300, kind: 'rock' },
      { x: 1400, y: 700, w: 240, h: 48, kind: 'sandbag' },
      { x: 620, y: 180, w: 190, h: 48, kind: 'crate' },
    ],
    spawns: corners,
    pads: (w) => [
      { x: w / 2, y: 240 },
      { x: 300, y: 560 },
      { x: 700, y: 1180 },
    ],
  },
  {
    name: 'The Hedges',
    w: 1800,
    h: 1350,
    // Hedgerows in a broken spiral, with one gate through the middle about
    // eighty units wide — a tank is forty-four across, so going through it is a
    // decision rather than a corridor. The two sandbag stubs are the release
    // valve: you cannot drive them, and if somebody has parked on the gate you
    // can still make them regret it from the wrong side of a hedge.
    cover: () => [
      { x: 300, y: 300, w: 420, h: 48, kind: 'hedge' },
      { x: 300, y: 300, w: 48, h: 300, kind: 'hedge' },
      { x: 720, y: 300, w: 48, h: 180, kind: 'sandbag' },
      { x: 560, y: 620, w: 300, h: 48, kind: 'hedge' },
      { x: 1080, y: 180, w: 48, h: 340, kind: 'hedge' },
      { x: 1240, y: 520, w: 220, h: 48, kind: 'sandbag' },
    ],
    spawns: corners,
    pads: (w, h) => [
      { x: w / 2, y: 200 },
      { x: 180, y: h / 2 },
      { x: 960, y: 420 },
    ],
  },
  {
    name: 'The Depot',
    w: 1700,
    h: 1250,
    // Oil drums and crate walls. The two sandbag runs across the middle are
    // staggered rather than aligned, so the centre is a pair of overlapping
    // firing lines with no way to drive straight through — the fight over the
    // middle pad happens at range and from behind something, every time.
    cover: () => [
      { x: 250, y: 200, w: 200, h: 48, kind: 'crate' },
      { x: 250, y: 430, w: 48, h: 200, kind: 'crate' },
      { x: 640, y: 240, w: 110, h: 110, kind: 'barrel' },
      { x: 560, y: 560, w: 260, h: 48, kind: 'sandbag' },
      { x: 1000, y: 330, w: 110, h: 110, kind: 'barrel' },
      { x: 1150, y: 700, w: 48, h: 200, kind: 'rock' },
    ],
    spawns: corners,
    pads: (w) => [
      { x: w / 2, y: 180 },
      { x: 170, y: 800 },
      { x: 430, y: 900 },
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

  // Stamp identity and hulls. Order is `ring`, then the authored half, then its
  // mirror — the same on every client, because the layout came from the block
  // hash and nothing here is random.
  BARRELS.length = 0
  for (let i = 0; i < WALLS.length; i++) {
    const w = WALLS[i]
    w.id = i
    w.gone = false
    if (w.kind !== undefined && DESTRUCTIBLE.has(w.kind)) {
      w.hp = BARREL_HP
      BARRELS.push(w)
    } else {
      w.hp = undefined
    }
  }
  coverEpoch++

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
      if (w.gone) continue
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

/**
 * What stops a *tank* here, if anything. Every rect does, barricades included.
 *
 * Still the predicate `resolveCircle` is built on, and still the one a test
 * asking "is this pad inside the scenery" wants.
 */
export function pointInWall(x: number, y: number): Rect | null {
  for (const w of WALLS) {
    if (w.gone) continue
    if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return w
  }
  return null
}

/**
 * What stops a *shell*. The same rects minus the barricades.
 *
 * Two predicates rather than a height on the rect because there are exactly
 * two questions anything in this game asks, and a number invites a third that
 * nobody has designed. Whoever adds a genuinely half-height wall later should
 * pay for the height field then.
 */
export function pointInTallWall(x: number, y: number): Rect | null {
  for (const w of WALLS) {
    if (isLow(w) || w.gone) continue
    if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return w
  }
  return null
}

/**
 * True if a straight line between two points is unobstructed. Used for spawn picking.
 *
 * Deliberately the tall predicate: the question this answers is "can that
 * player shoot me the instant I appear", and a sandbag line does not stop a
 * shell. Spawning behind a barricade in someone's sights is exactly the spawn
 * this function exists to avoid picking.
 */
export function hasLineOfSight(ax: number, ay: number, bx: number, by: number): boolean {
  const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / 16)
  for (let i = 1; i < steps; i++) {
    const t = i / steps
    if (pointInTallWall(ax + (bx - ax) * t, ay + (by - ay) * t)) return false
  }
  return true
}

// ------------------------------------------------------------ destructible cover


/**
 * Put `n` hits into a barrel. Returns true if this is the hit that destroyed it.
 *
 * Idempotent past zero on purpose: three clients all re-simulating the same
 * shell will all call this, and the second and third calls must be worth
 * nothing rather than taking out the barrel behind it.
 */
export function damageCover(id: number, n = 1): boolean {
  const w = WALLS[id]
  if (!w || w.gone || w.hp === undefined) return false
  w.hp -= n
  coverEpoch++
  if (w.hp > 0) return false
  w.hp = 0
  w.gone = true
  return true
}

/**
 * Which barrels are gone, as a bitmask over `BARRELS` order.
 *
 * On the wire in every state tick, and unioned rather than replaced on receipt.
 * That choice is the whole consensus design and it is worth stating plainly:
 *
 *   - Union is **order-independent and idempotent**, so it does not matter
 *     which tick arrives first, whether one is lost, or how many times a client
 *     re-sends the same bits. Every client converges on the same set as long as
 *     it hears from anybody who saw the barrel go.
 *   - It is **self-healing for a late joiner**, which a one-off "barrel
 *     destroyed" event is not. Somebody who joins at minute six of a block hears
 *     the current mask on the next tick — 100ms — rather than being permanently
 *     out of step with a board everybody else is playing.
 *   - It **cannot be un-set**, so a client whose own simulation missed a hit
 *     cannot resurrect a barrel under somebody who is driving through the gap.
 *
 * The price is that a hostile client can clear the board by sending all ones.
 * That is the same trust model as everything else here — a client that lies
 * about its own position or its own kills is already possible, the README says
 * so, and a bitmask that can only remove cover is a smaller lever than either.
 * A board with eight barrels needs eight bits; the ceiling is the 31 a JavaScript
 * bitwise operator can hold, which is four times the most any layout has.
 */
export function coverBits(): number {
  let bits = 0
  for (let i = 0; i < BARRELS.length && i < 31; i++) if (BARRELS[i].gone) bits |= 1 << i
  return bits
}

/**
 * Put every barrel back. Called at a round boundary, not at a layout swap.
 *
 * `setLayout` already does this, and relying on it would be a bug waiting for
 * the right block: the map is `blockHash % 8`, so two rounds in a row land on
 * the same board about one time in eight, and `setLayout` returns early when
 * the index has not changed. A round that inherited the previous round's holes
 * would be a different board from the one its own hash describes — and a late
 * joiner, who *would* get a fresh layout, would disagree with everybody.
 */
export function resetCover(): void {
  let changed = false
  for (const w of BARRELS) {
    if (!w.gone && w.hp === BARREL_HP) continue
    w.gone = false
    w.hp = BARREL_HP
    changed = true
  }
  if (changed) coverEpoch++
}

/** Union somebody else's mask into ours. Returns the barrels this took out. */
export function applyCoverBits(bits: number): Rect[] {
  const taken: Rect[] = []
  for (let i = 0; i < BARRELS.length && i < 31; i++) {
    if (!(bits & (1 << i)) || BARRELS[i].gone) continue
    BARRELS[i].hp = 0
    BARRELS[i].gone = true
    taken.push(BARRELS[i])
  }
  if (taken.length) coverEpoch++
  return taken
}
