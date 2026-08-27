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
 *
 * `water` and `cliff` are terrain wearing the cover machinery, and that is a
 * choice rather than a shortcut: a rect in `WALLS` already knows how to stop a
 * tank, stop a shell, and be agreed on by every client, which is everything a
 * river or a mesa edge needs. Water is a `low` rect that cannot be destroyed —
 * tanks stop at the bank, shells fly over. A cliff is a `solid` rect that is
 * the *edge* of high ground; what makes it different from a rock is that a
 * shell fired from up there passes over it. See `pointInShellWall`.
 */
export type CoverKind = 'rock' | 'crate' | 'barrel' | 'sandbag' | 'hedge' | 'fence' | 'water' | 'cliff'

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
  /**
   * How beaten up this looks: 0 intact, 3 about to go.
   *
   * A *display* tier rather than a second copy of `hp`, and the difference
   * matters. `hp` is local — every client re-simulates every shell, and a
   * client that missed one has a healthier crate than everybody else. `dmg` is
   * the highest tier anybody has reported, unioned off the state tick exactly
   * as `gone` is, so the board looks the same on every screen even where the
   * local hit counts have drifted apart. It only ever goes up inside a round.
   */
  dmg?: number
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
 *
 * Water joined the set with the terrain pass: a tank stops at the bank, a
 * shell crosses the river. Same two answers as a sandbag line, which is why it
 * is a membership here and not a third mechanism. The difference between them
 * is entirely in the renderer.
 */
const LOW_KINDS: ReadonlySet<CoverKind> = new Set<CoverKind>(['sandbag', 'water'])

/**
 * What a rect does to the things that run into it.
 *
 * This file used to say, in as many words:
 *
 * > Two predicates rather than a height on the rect because there are exactly
 * > two questions anything in this game asks, and a number invites a third that
 * > nobody has designed. Whoever adds a genuinely half-height wall later should
 * > pay for the height field then.
 *
 * Puzz asked for the third question — rubble that slows a tank crossing it —
 * so this is the bill. One enumeration, and both original predicates are now
 * *derived* from it rather than sitting beside it. That is the part worth
 * insisting on: three parallel booleans can disagree with each other, and the
 * disagreement would be a tank standing on ground a shell flies through.
 *
 *   - `solid`  — stops a tank, stops a shell. Rocks, hedges, crates, drums.
 *   - `low`    — stops a tank, shells go over. Sandbags.
 *   - `rubble` — stops neither, but a tank crossing it is slowed. What a
 *                destroyed crate or barrel leaves behind.
 *   - `clear`  — nothing at all.
 */
export type Passing = 'solid' | 'low' | 'rubble' | 'clear'

export function passing(r: Rect): Passing {
  // Only cover that could be destroyed leaves anything behind; `gone` is never
  // set on anything else. The `clear` branch is the honest answer for a rect
  // that was removed some other way rather than a case that exists today.
  if (r.gone) return r.hp !== undefined ? 'rubble' : 'clear'
  return r.kind !== undefined && LOW_KINDS.has(r.kind) ? 'low' : 'solid'
}

/** True if shells pass over this rect. Tanks are stopped by it regardless. */
export const isLow = (r: Rect): boolean => passing(r) === 'low'

/**
 * How fast a tank crosses rubble, as a fraction of its normal forward speed.
 *
 * Puzz: "we want rubble to slow a tank crossing it." Fifty-five per cent,
 * which is the number that makes cutting through a breach a *decision* — you
 * arrive later than the man who went round, and you arrive somewhere he is not
 * looking. Much lower and it reads as being stuck; much higher and breaching a
 * wall is a free shortcut and cover stops meaning anything.
 *
 * Forward speed only. Turning is untouched, because a tank that cannot turn
 * while it is on debris reads as broken rather than as slowed.
 */
export const RUBBLE_SPEED = 0.55

/**
 * Cover that can be shot away, and how many hits each kind takes.
 *
 * Puzz: "Walls and obstacles can be damaged and blown up. Barrels can be blown
 * up after x amount of hits. Walls can be shot through after x amount of hits."
 *
 * Two kinds, and what is *not* on this list matters as much as what is. Rocks
 * and hedges are the skeleton of a layout — they are what stop a round from
 * dissolving into an open field by minute eight — and the fence is the board.
 * Timber and steel drums are the things a player already expects to give way.
 *
 * The two numbers are the design:
 *
 *   - A **barrel** is three hits, which is a magazine minus one, and it goes up
 *     when it does — anything inside a lob's blast radius goes with it. One
 *     shell is an accident, three is a decision, and clearing a lane costs a
 *     reload you have to survive.
 *   - A **crate** is eight, and it just breaks. Two full magazines is most of
 *     twenty seconds of standing still and shooting a box, which is exactly the
 *     price a *wall* should carry: breaching one is a plan you commit to at the
 *     start of a round, not something you do in passing on the way past.
 *
 * The split is also the tactical difference between them. You shoot a barrel
 * because somebody is standing next to it. You shoot a crate because you want
 * the lane behind it.
 */
const DESTRUCTIBLE: ReadonlyMap<CoverKind, number> = new Map<CoverKind, number>([
  ['barrel', 3],
  ['crate', 8],
])

/**
 * How many steps of visible damage a piece of cover goes through.
 *
 * Puzz: "we want to see them get messed up with each shot and eventual break
 * but not completely disappear."
 *
 * Three, and they are spaced by *fraction of hp lost* rather than by hits, so
 * one number covers a three-hit barrel and an eight-hit crate without either
 * being special-cased. A crate reaches the first tier on the first hit, the
 * second at three, and the third at six — which means the answer to "how many
 * more shells does this need" is on the board rather than in the player's
 * memory, and a crate somebody else has been working on is legible the moment
 * you drive past it.
 */
export const DAMAGE_TIERS = 3

/** Bits per piece on the wire. Three tiers plus intact fits in three. */
const TIER_BITS = 3
/**
 * How many pieces the damage mask can carry.
 *
 * `31 / 3` — the ceiling is what a JavaScript bitwise operator holds, same as
 * the destroyed mask above it. The widest layout has eight breakables, so
 * there is room, but this one is tighter than the 31 that mask gets and it is
 * worth knowing where the wall is before somebody designs a board with a dozen
 * crates on it.
 */
const TIER_SLOTS = Math.floor(31 / TIER_BITS)

/**
 * The tier a rect's own hit count implies.
 *
 * Local, and therefore not authoritative on its own — see `Rect.dmg`.
 */
function tierFromHp(r: Rect): number {
  const full = r.kind === undefined ? undefined : DESTRUCTIBLE.get(r.kind)
  if (full === undefined || full <= 0 || r.hp === undefined) return 0
  if (r.gone) return DAMAGE_TIERS
  const lost = 1 - r.hp / full
  return Math.max(0, Math.min(DAMAGE_TIERS, Math.ceil(lost * DAMAGE_TIERS)))
}

/** What to draw: the worst anybody has seen, never less than our own count. */
export const damageTier = (r: Rect): number => Math.max(r.dmg ?? 0, tierFromHp(r))

/** Kept as a name because the blast is a barrel's alone. See `explodes`. */
export const BARREL_HP = 3
export const CRATE_HP = 8

/** True if destroying this rect should take everything nearby with it. */
export const explodes = (r: Rect): boolean => r.kind === 'barrel'

/**
 * Every destructible rect on the current board, in `WALLS` order.
 *
 * The bitmask on the state tick indexes into this, so its length is the number
 * of bits a round needs. The widest layout carries eight — six crates and two
 * barrels — against the 31 a JavaScript bitwise operator holds, so there is
 * room for a board four times as cluttered as anything here.
 */
export const BREAKABLE: Rect[] = []

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

/**
 * A drivable slope between ground level and a mesa top.
 *
 * `dir` names the *high* side — the edge that touches the mesa. A tank
 * crossing the rect toward that edge is at a fraction of full height given by
 * how far across it is, which is what `elevationAt` returns and what the
 * renderer uses to carry a tank smoothly up the slope. Nothing in the physics
 * reads the fraction: a ramp is open ground to tanks and shells alike, and the
 * cliff rects either side of it are what keep the climb honest.
 */
export interface Ramp extends Rect {
  dir: 'n' | 's' | 'e' | 'w'
}

export interface LayoutSpec {
  name: string
  w: number
  h: number
  /** Half the cover. The other half is this, rotated 180 degrees. */
  cover: (w: number, h: number) => Rect[]
  spawns: (w: number, h: number) => Pt[]
  /** Where pickups can appear. Mirrored, so no corner is closer to more of them. */
  pads: (w: number, h: number) => Pt[]
  /**
   * High ground, as footprints. Mirrored like cover, except that a rect which
   * mirrors onto itself — a centred plateau — is kept once rather than twice.
   *
   * The footprint includes the cliff band around its edge on purpose: a tank
   * at the rim fires from a muzzle 26 units in front of its centre, which can
   * be over the cliff rect, and a muzzle that measured ground level there
   * would have its own shell bounce off its own parapet.
   */
  mesas?: (w: number, h: number) => Rect[]
  /** The slopes up. Mirrored, with the high side swapping like the geometry. */
  ramps?: (w: number, h: number) => Ramp[]
}

/**
 * Eight spawns: the four corners, then the middle of each edge.
 *
 * Four was the room size and four was the spawn count, and the two were the
 * same number by coincidence rather than by design — `respawn` picks the spot
 * furthest from everybody alive, so a room of eight sharing four spawns puts
 * two tanks on top of each other about as often as not.
 *
 * The order is corners first, deliberately. `makeBot` and anything else that
 * takes "the first few spawns" gets the four that are furthest apart, and the
 * edge spawns are the overflow rather than the default. Still 180-degree
 * rotationally symmetric, which is what makes a board fair — every one of these
 * has an opposite number the same distance from the middle.
 */
const corners = (w: number, h: number): Pt[] => [
  { x: 175, y: 175 },
  { x: w - 175, y: 175 },
  { x: 175, y: h - 175 },
  { x: w - 175, y: h - 175 },
  { x: w / 2, y: 150 },
  { x: w / 2, y: h - 150 },
  { x: 150, y: h / 2 },
  { x: w - 150, y: h / 2 },
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
      // The overflow four, for a room bigger than the board was drawn for.
      // Corners on this layout rather than edges, because this is the one board
      // whose four authored spawns are already on the edges.
      { x: 210, y: 210 },
      { x: w - 210, y: 210 },
      { x: 210, y: h - 210 },
      { x: w - 210, y: h - 210 },
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
  {
    name: 'The Shallows',
    w: 1800,
    h: 1300,
    // The water showcase. A river crosses the whole board with two fords, so
    // every drive to the other half funnels through one of two 140-unit gaps —
    // but a *shell* does not care, which is the mechanic: the river is a moat
    // for tanks and open air for gunnery, a sandbag line drawn in blue and
    // scaled up to a terrain feature. The pond pair in the quarters does the
    // small version of the same thing around the flanks.
    cover: (_w, h) => [
      { x: 24, y: h / 2 - 70, w: 436, h: 140, kind: 'water' },
      { x: 600, y: h / 2 - 70, w: 300, h: 140, kind: 'water' },
      { x: 280, y: 220, w: 260, h: 170, kind: 'water' },
      // The fords are the fight, so the cover faces them.
      { x: 470, y: 430, w: 120, h: 48, kind: 'crate' },
      { x: 860, y: 300, w: 90, h: 90, kind: 'rock' },
      { x: 620, y: 210, w: 180, h: 48, kind: 'sandbag' },
      { x: 180, y: 820, w: 100, h: 100, kind: 'barrel' },
    ],
    // Not `corners`: the default mid-edge spawns at (150, h/2) sit in the
    // river. The side spawns move up and down the bank instead, still as a
    // 180-degree pair.
    spawns: (w, h) => [
      { x: 175, y: 175 },
      { x: w - 175, y: 175 },
      { x: 175, y: h - 175 },
      { x: w - 175, y: h - 175 },
      { x: w / 2, y: 150 },
      { x: w / 2, y: h - 150 },
      { x: 150, y: 380 },
      { x: w - 150, y: 920 },
    ],
    pads: (w, h) => [
      { x: w / 2, y: 210 },
      // On the ford itself. Standing on the one strip of dry crossing to
      // collect a pickup is exactly the exposed moment the board is about.
      { x: 530, y: h / 2 },
      { x: w / 2, y: 490 },
    ],
  },
  {
    name: 'The Bluff',
    w: 1900,
    h: 1400,
    // The height showcase. A mesa holds the middle: cliffs all round, one ramp
    // up from each short side, and both mesa pads on top. A tank up there
    // shoots out over its own cliff edge — `pointInShellWall` lets a shell
    // fired from high ground cross `cliff` rects — while a tank below has to
    // put shells through a ramp mouth or climb. King of the hill, where the
    // hill actually works like a hill.
    cover: () => [
      // The mesa's retaining wall, minus the two ramp mouths at y 640..760.
      { x: 670, y: 520, w: 560, h: 40, kind: 'cliff' },
      { x: 670, y: 560, w: 40, h: 80, kind: 'cliff' },
      { x: 670, y: 760, w: 40, h: 120, kind: 'cliff' },
      // Curbs either side of the west ramp, so the only way onto the slope is
      // the low end and the climb fraction is always the drive fraction.
      { x: 550, y: 600, w: 120, h: 40, kind: 'cliff' },
      { x: 550, y: 760, w: 120, h: 40, kind: 'cliff' },
      // The plains: something to fight from while contesting the ramps.
      { x: 280, y: 260, w: 130, h: 130, kind: 'rock' },
      { x: 360, y: 620, w: 48, h: 180, kind: 'sandbag' },
      { x: 820, y: 280, w: 260, h: 48, kind: 'crate' },
      { x: 1350, y: 300, w: 100, h: 100, kind: 'barrel' },
    ],
    spawns: corners,
    pads: (w, h) => [
      { x: w / 2, y: 620 },
      { x: 250, y: h / 2 },
      { x: w / 2, y: 380 },
    ],
    mesas: (w, h) => [{ x: w / 2 - 280, y: h / 2 - 180, w: 560, h: 360 }],
    ramps: (_w, h) => [{ x: 550, y: h / 2 - 60, w: 120, h: 120, dir: 'e' }],
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

/**
 * High ground on the current board, as footprints. Empty on a flat board.
 *
 * Like `WALLS`, mutated in place by `setLayout` so every importer sees the
 * current board. Unlike `WALLS`, nothing here collides: the mesa's edge is
 * made of `cliff` rects that live in `WALLS` like any other cover, and these
 * footprints only answer "how high is the ground at (x, y)" — for the
 * renderer, and for stamping a shell's elevation when it is fired.
 */
export const MESAS: Rect[] = []
export const RAMPS: Ramp[] = []

/**
 * How high the ground is at a point, as a fraction of one mesa tier.
 *
 * 1 on a mesa, 0 on the flat, and the drive fraction on a ramp — which is
 * what lets the renderer carry a tank up a slope without a step in it. A pure
 * function of the layout, so every client agrees on it the same way they
 * agree on the walls.
 */
export function elevationAt(x: number, y: number): number {
  for (const m of MESAS) {
    if (x >= m.x && x <= m.x + m.w && y >= m.y && y <= m.y + m.h) return 1
  }
  for (const r of RAMPS) {
    if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue
    switch (r.dir) {
      case 'e': return (x - r.x) / r.w
      case 'w': return (r.x + r.w - x) / r.w
      case 's': return (y - r.y) / r.h
      case 'n': return (r.y + r.h - y) / r.h
    }
  }
  return 0
}

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
  BREAKABLE.length = 0
  for (let i = 0; i < WALLS.length; i++) {
    const w = WALLS[i]
    w.id = i
    w.gone = false
    const hp = w.kind === undefined ? undefined : DESTRUCTIBLE.get(w.kind)
    if (hp !== undefined) {
      w.hp = hp
      BREAKABLE.push(w)
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

  // Mirrored like cover, except that a centred footprint mirrors onto itself
  // and must not be kept twice — the physics would not notice, but the
  // renderer would build two identical slabs z-fighting for the same air.
  const sameRect = (a: Rect, b: Rect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
  const mesas = spec.mesas?.(spec.w, spec.h) ?? []
  MESAS.length = 0
  MESAS.push(...mesas)
  for (const m of mesas) {
    const f = flip(m, spec.w, spec.h)
    if (!MESAS.some((o) => sameRect(o, f))) MESAS.push(f)
  }

  const ramps = spec.ramps?.(spec.w, spec.h) ?? []
  const flipDir = { n: 's', s: 'n', e: 'w', w: 'e' } as const
  RAMPS.length = 0
  RAMPS.push(...ramps)
  for (const r of ramps) {
    const f: Ramp = { ...flip(r, spec.w, spec.h), dir: flipDir[r.dir] }
    if (!RAMPS.some((o) => sameRect(o, f) && o.dir === f.dir)) RAMPS.push(f)
  }

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
    const p = passing(w)
    if (p !== 'solid' && p !== 'low') continue
    if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return w
  }
  return null
}

/**
 * What stops a *shell fired from the flat*. The same rects minus the
 * barricades and the water.
 *
 * Still the predicate for sight lines and for bots, both of which reason from
 * ground level. A shell in flight asks `pointInShellWall` instead, which is
 * this plus one exception for high ground.
 */
export function pointInTallWall(x: number, y: number): Rect | null {
  for (const w of WALLS) {
    if (passing(w) !== 'solid') continue
    if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return w
  }
  return null
}

/**
 * What stops a shell whose muzzle was at elevation `elev`.
 *
 * The one place height changes the rules: a shell fired *from* a mesa crosses
 * `cliff` rects — its own parapet on the way out, and any other mesa's edge on
 * the way past — where a shell fired from the flat bounces off them like any
 * wall. Everything else is unchanged: rocks and crates are tall from every
 * height, water and sandbags stop nothing.
 *
 * `elev` is stamped on the shell at fire time from `elevationAt`, so it is a
 * pure function of the fire event's own coordinates and every client
 * re-simulating that shell agrees on it without a byte on the wire.
 */
export function pointInShellWall(x: number, y: number, elev = 0): Rect | null {
  for (const w of WALLS) {
    if (passing(w) !== 'solid') continue
    if (elev >= 1 && w.kind === 'cliff') continue
    if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return w
  }
  return null
}

/**
 * The debris a tank is standing on, if any.
 *
 * The third predicate, and the reason `passing` exists — it is derived from the
 * same enumeration as the other two rather than being a fourth loop with its
 * own idea of what `gone` means.
 */
export function pointInRubble(x: number, y: number): Rect | null {
  for (const w of WALLS) {
    if (passing(w) !== 'rubble') continue
    if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return w
  }
  return null
}

/**
 * What the ground here does to a tank's forward speed.
 *
 * A multiplier rather than a boolean so callers do not each get to decide what
 * "on rubble" costs — there is one number and it lives next to the enumeration
 * that produced it.
 *
 * Derived entirely from the destroyed mask, which every client already unions,
 * so two clients that agree about the board agree about this. It is applied
 * only to tanks a client is *simulating* — its own and its bots — never to a
 * remote tank, whose position is somebody else's self-report being interpolated
 * and is not ours to second-guess.
 */
export const groundSpeed = (x: number, y: number): number =>
  pointInRubble(x, y) ? RUBBLE_SPEED : 1

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
  if (w.hp > 0) {
    // Raised, never lowered. Two clients whose hit counts have drifted must
    // still draw the same crate, and the one that has seen more damage is the
    // one telling the truth about how much this thing has taken.
    w.dmg = Math.max(w.dmg ?? 0, tierFromHp(w))
    return false
  }
  w.hp = 0
  w.gone = true
  w.dmg = DAMAGE_TIERS
  return true
}

/**
 * Which pieces of breakable cover are gone, as a bitmask over `BREAKABLE`.
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
  for (let i = 0; i < BREAKABLE.length && i < 31; i++) if (BREAKABLE[i].gone) bits |= 1 << i
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
  for (const w of BREAKABLE) {
    const full = w.kind === undefined ? undefined : DESTRUCTIBLE.get(w.kind)
    if (full === undefined) continue
    if (!w.gone && w.hp === full && !w.dmg) continue
    w.gone = false
    w.hp = full
    w.dmg = 0
    changed = true
  }
  if (changed) coverEpoch++
}

/**
 * How chewed up each piece of cover is, as a mask over `BREAKABLE`.
 *
 * A **thermometer** code — tier 2 is `0b011`, tier 3 is `0b111` — three bits
 * per piece, and that encoding is the whole point. It makes `|` mean `max`, so
 * this mask unions exactly like the destroyed one above: order-independent,
 * idempotent, impossible to walk backwards, and self-healing for somebody who
 * joins at minute six. A plain two-bit integer per piece would need a
 * per-field maximum on receipt, and the moment a merge is not a single `|`
 * somebody eventually writes `=` instead.
 *
 * It rides in its own field rather than being packed alongside `b`. A client
 * already deployed reads `b` and ignores anything it does not know, so it
 * keeps working and simply does not draw the scuffs — where widening `b` would
 * have made an old client read "this crate is damaged" as "these three crates
 * are destroyed" and blank cover that is still standing.
 */
export function coverDamageBits(): number {
  let bits = 0
  for (let i = 0; i < BREAKABLE.length && i < TIER_SLOTS; i++) {
    const tier = damageTier(BREAKABLE[i])
    if (tier > 0) bits |= ((1 << tier) - 1) << (i * TIER_BITS)
  }
  return bits
}

/** Union somebody else's damage into ours. Returns true if anything changed. */
export function applyCoverDamageBits(bits: number): boolean {
  let changed = false
  for (let i = 0; i < BREAKABLE.length && i < TIER_SLOTS; i++) {
    const field = (bits >> (i * TIER_BITS)) & ((1 << TIER_BITS) - 1)
    // Popcount of a thermometer field is the tier it encodes. A field with a
    // gap in it — 0b101 — is not something this encoder can produce, and
    // counting bits rather than matching patterns means a garbled one lands on
    // a real tier instead of being thrown away or trusted whole.
    let tier = 0
    for (let b = 0; b < TIER_BITS; b++) if (field & (1 << b)) tier++
    if (tier <= (BREAKABLE[i].dmg ?? 0)) continue
    BREAKABLE[i].dmg = Math.min(DAMAGE_TIERS, tier)
    changed = true
  }
  if (changed) coverEpoch++
  return changed
}

/** Union somebody else's mask into ours. Returns the barrels this took out. */
export function applyCoverBits(bits: number): Rect[] {
  const taken: Rect[] = []
  for (let i = 0; i < BREAKABLE.length && i < 31; i++) {
    if (!(bits & (1 << i)) || BREAKABLE[i].gone) continue
    BREAKABLE[i].hp = 0
    BREAKABLE[i].gone = true
    BREAKABLE[i].dmg = DAMAGE_TIERS
    taken.push(BREAKABLE[i])
  }
  if (taken.length) coverEpoch++
  return taken
}
