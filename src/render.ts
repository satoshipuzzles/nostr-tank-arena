// The board, in three.js.
//
// The camera never scrolls. Everybody sees the whole arena at once, the way
// four people see the same television — that is the couch-multiplayer feel this
// game is built around, and it survives the move to 3D unchanged. What 3D buys
// is the toy-box look: a chunky board floating in daylight, plastic tanks with
// real shadows, and confetti when somebody dies.
//
// The simulation is still two-dimensional and stays that way. Arena (x, y) maps
// to world (x, height, y), so the ground plane is XZ and nothing in `sim.ts`,
// `arena.ts`, or the netcode had to learn about a third axis. A 2D heading θ
// points along (cos θ, sin θ), which in world space is (cos θ, 0, sin θ) — and
// a mesh whose nose is +x reaches that by rotating -θ about Y. That minus sign
// is the entire conversion.
//
// Effects are derived by diffing state between frames rather than by adding
// callbacks to the game: a shell id that is new means somebody just fired, an
// id that vanished means it hit something, and a tank that flipped to dead
// means confetti. The renderer stays a pure function of game state plus its own
// particle pool, which keeps `game.ts` free of anything that knows what a
// sprite is.

import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import {
  ARENA_H,
  ARENA_W,
  DAMAGE_TIERS,
  WALLS,
  coverGeneration,
  damageTier,
  onLayoutChange,
  pointInTallWall,
} from './arena'
import { CHOPPER_ALT, CHOPPER_SPREAD } from './chopper'
import { FLAG_REACH, FLAG_TEAMS, baseFor } from './flags'
import { CAPTURE_S, POINT_RADIUS } from './domination'
import type { CoverKind, Rect } from './arena'
import type { Game, Peer } from './game'
import { LOB_APEX, LOB_BLAST, MAX_HP, RELOAD, TANK_RADIUS, shellHeight } from './sim'
import { ICON_POLYS, PICKUPS, hasBuff } from './pickups'
import type { PickupKind } from './pickups'
import { Avatar } from './avatars'
import { DEFAULT_SKIN, SKINS, type CamoId, type Skin, type SkinId } from './skins'

// Board furniture, in arena units so it stays in scale with the simulation.
const WALL_H = 58
const FENCE_H = 96
const BOARD_DROP = 110
const RIM = 46
/** Where the aim raycast meets the world — turret height, so pointing at a
 *  tank's turret aims at that tank rather than at the ground behind it. */
const AIM_PLANE_Y = 22

/** Field of view for the board camera, which frames the whole arena. */
const BOARD_FOV = 40
/** Wider inside the tank, because a 40-degree cockpit is a letterbox. */
const COCKPIT_FOV = 76
/**
 * Eye height, inside the turret rather than over it.
 *
 * The gun is at y=28, so an eye here looks very slightly *down* the barrel
 * rather than at the top of it — which is the whole reason the dome comes off
 * in this view. Well under WALL_H either way: a driver who can see over the
 * cover is not playing the same board as everybody else.
 */
const EYE_Y = 50
/**
 * How far back along the barrel the eye sits.
 *
 * The hull is 44 long, so this is a little way off the back of it, and that is
 * deliberate: from inside the hull the barrel is a stub pointing straight at
 * the camera and reads as nothing at all. From here it converges on the
 * crosshair and the hull sits under it, which is what makes the view feel like
 * a vehicle rather than a floating eye. `placeEye` gives it back when there is
 * something solid in the way.
 */
const EYE_BACK = 40
/** Closest the eye is ever pulled in, when a wall is behind the tank. */
const EYE_BACK_MIN = 10
/** How far the cockpit camera looks past the barrel, and how far it looks down. */
const EYE_REACH = 900
const EYE_DROP = 95
/**
 * Half the arc the mouse can swing the turret through in cockpit view.
 *
 * Wider than the field of view on purpose: the gun is allowed to leave the
 * frame's centre and the camera follows it, so this is a limit on how far the
 * turret can be from *the hull*, not on what you can see.
 */
const AIM_ARC = (105 * Math.PI) / 180

/** Overhead board, or down the barrel. */
export type ViewMode = 'board' | 'cockpit'

const TAU = Math.PI * 2

/** Reused by the chopper's beam orientation; allocating one a frame is waste. */
const UP = new THREE.Vector3(0, 1, 0)

// --------------------------------------------------------------- materials

const toy = (color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.02, ...extra })

/**
 * The cartoon outline: the same shape again, slightly larger, inside out, in
 * near-black. Two extra draw calls per tank, and it is the single thing that
 * makes the tanks read as toys rather than as untextured geometry.
 */
const INK = new THREE.MeshBasicMaterial({ color: 0x141a26, side: THREE.BackSide })

/**
 * A vertical gradient, used as the sky.
 *
 * Was three steps of swimming-pool cyan, which is a lovely colour and is not a
 * colour the sky is. This is the real thing: a deep blue overhead that thins
 * out and goes warm at the horizon, where the air you are looking through is
 * thickest. The bottom stop is also the fog colour, so the far end of a
 * 2000-unit board dissolves into the haze instead of stopping against it.
 */
function skyTexture(): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createLinearGradient(0, 0, 0, 256)
  grad.addColorStop(0, '#5b8ec4')
  grad.addColorStop(0.5, '#9dbdd6')
  grad.addColorStop(1, '#e2dccc')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 4, 256)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/**
 * The top of the board, in world units.
 *
 * One constant because two different meshes learned this the hard way. The
 * felt used to be at 2.5 while the ring under your tank was at 1.2 and every
 * pickup pad at 1.5 — both *inside* the board, drawn every frame, never
 * reaching a pixel. Nothing in a scene graph complains about a mesh hidden in
 * the floor, and no structural test catches it either: `visible` was `true` the
 * whole time. Anything that lies flat on the board is `GROUND_Y + DECAL_LIFT`.
 */
export const GROUND_Y = 2.5
/** How far a flat decal floats above the felt to avoid z-fighting with it. */
export const DECAL_LIFT = 0.9

/**
 * A tiny deterministic generator, so the turf looks the same every load.
 *
 * `Math.random` would work and would also mean the board has a slightly
 * different grain each refresh, which is the sort of thing that makes a
 * screenshot comparison useless and a "did that change?" question unanswerable.
 */
function noise(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2545f491) + 0x9e3779b9) >>> 0
    return s / 4294967296
  }
}

/**
 * The board's turf.
 *
 * Was two flat greens in a checker, which read as a spreadsheet from the board
 * camera — the arena had no surface, just an area. This keeps the checker,
 * because it is what gives distance a unit you can count, and lays grain over
 * it: a few thousand blade strokes and a mow direction per square. It doubles
 * as the material's bump map, so the sun actually catches the texture instead
 * of it being a flat picture of texture.
 */
function feltTexture(): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const rnd = noise(0x7a4b19)

  // Grass, not felt. The two greens were #8ed57a and #7cc767 — a mini-golf
  // mat, several steps more saturated than any lawn, and close enough in hue
  // to the green player tank that the two competed. Real turf is darker, much
  // less saturated, and slightly yellow.
  ctx.fillStyle = '#6f9455'
  ctx.fillRect(0, 0, 256, 256)
  ctx.fillStyle = '#65894c'
  ctx.fillRect(0, 0, 128, 128)
  ctx.fillRect(128, 128, 128, 128)

  // Mow lines, one direction per square, the way a real pitch is cut.
  ctx.globalAlpha = 0.11
  for (let sq = 0; sq < 4; sq++) {
    const ox = (sq % 2) * 128
    const oy = Math.floor(sq / 2) * 128
    const vertical = sq % 2 === 0
    ctx.fillStyle = '#ffffff'
    for (let i = 6; i < 128; i += 16) {
      if (vertical) ctx.fillRect(ox + i, oy, 7, 128)
      else ctx.fillRect(ox, oy + i, 128, 7)
    }
  }

  // Grain. Short strokes rather than dots: a dot field reads as noise, and a
  // stroke field reads as grass.
  ctx.globalAlpha = 0.16
  for (let i = 0; i < 5200; i++) {
    const x = rnd() * 256
    const y = rnd() * 256
    // Highlight is a pale yellow-green rather than white: white blades on
    // green read as frost, and the sun on this board is warm.
    ctx.strokeStyle = rnd() > 0.5 ? '#c9d99a' : '#3f5c30'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + (rnd() - 0.5) * 3, y - 1 - rnd() * 3)
    ctx.stroke()
  }

  // Worn patches. A pitch that four tanks have been driving over is not
  // uniform, and a handful of bare-earth scuffs is the cheapest thing that
  // stops a tiling texture from reading as a tile.
  for (let i = 0; i < 22; i++) {
    const x = rnd() * 256
    const y = rnd() * 256
    const r = 5 + rnd() * 16
    const patch = ctx.createRadialGradient(x, y, 0, x, y, r)
    patch.addColorStop(0, 'rgba(146,122,86,0.34)')
    patch.addColorStop(1, 'rgba(146,122,86,0)')
    ctx.globalAlpha = 1
    ctx.fillStyle = patch
    ctx.beginPath()
    ctx.arc(x, y, r, 0, TAU)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(ARENA_W / 320, ARENA_H / 320)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

/**
 * Chalk on the pitch: an inset touchline, a centre circle, and a corner arc at
 * every spawn.
 *
 * Not decoration. On a 2000-unit board with no landmarks the only way to judge
 * "can I make that gap before he reloads" is by counting checker squares, and
 * the centre circle turns the middle of the map into a place people can name.
 * Drawn per layout at the board's own aspect, so nothing stretches when the
 * next block picks a different-sized arena.
 */
function chalkTexture(): THREE.Texture {
  const W = 1024
  const H = Math.round((1024 * ARENA_H) / ARENA_W)
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  const sx = W / ARENA_W
  const inset = 70 * sx

  // Warm white at lower alpha. Pure white at 0.42 was the brightest thing on
  // the old board after the fence, and on natural turf it looked like tape
  // rather than chalk.
  ctx.strokeStyle = 'rgba(246,241,228,0.34)'
  ctx.lineWidth = Math.max(2, 5 * sx)
  ctx.strokeRect(inset, inset, W - inset * 2, H - inset * 2)

  ctx.beginPath()
  ctx.moveTo(W / 2, inset)
  ctx.lineTo(W / 2, H - inset)
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(W / 2, H / 2, 230 * sx, 0, Math.PI * 2)
  ctx.stroke()

  ctx.fillStyle = 'rgba(246,241,228,0.34)'
  ctx.beginPath()
  ctx.arc(W / 2, H / 2, 9 * sx, 0, Math.PI * 2)
  ctx.fill()

  for (const [cx, cy, from] of [
    [inset, inset, 0],
    [W - inset, inset, Math.PI / 2],
    [W - inset, H - inset, Math.PI],
    [inset, H - inset, -Math.PI / 2],
  ]) {
    ctx.beginPath()
    ctx.arc(cx, cy, 60 * sx, from, from + Math.PI / 2)
    ctx.stroke()
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

/**
 * A gunship: hull, tail, rotor, the beam of rounds, and the circle they land in.
 *
 * Toy-scaled to match everything else on this board. It is drawn three hundred
 * units up and seen from a camera two thousand back, so it is deliberately
 * chunky — a scale model of a helicopter at this distance is a smudge, and what
 * has to read in a quarter of a second is "that is a chopper and it is over
 * there".
 */
interface ChopperRig {
  root: THREE.Group
  body: THREE.Group
  rotor: THREE.Mesh
  beam: THREE.Mesh
  splash: THREE.Mesh
  shadow: THREE.Mesh
  wasX: number
  wasZ: number
}

// Sized against the tanks, not against a real helicopter.
//
// The first cut had a 150-unit rotor over a 30-unit hull and photographed as a
// flat purple X on the felt: at this camera distance the blades were the only
// thing with any area and the body was three pixels underneath them. A tank is
// 44 long and reads fine, so the hull is built to about that and the rotor is
// only half again as wide — the disc still says helicopter, and now there is a
// body under it saying whose.
const CHOPPER_GEO = {
  hull: new THREE.CapsuleGeometry(17, 34, 5, 12),
  cabin: new THREE.SphereGeometry(15, 14, 12),
  tail: new THREE.BoxGeometry(9, 9, 52),
  fin: new THREE.BoxGeometry(4, 22, 12),
  rotor: new THREE.BoxGeometry(96, 3, 9),
  rotor2: new THREE.BoxGeometry(9, 3, 96),
  disc: new THREE.CircleGeometry(52, 26),
  mast: new THREE.CylinderGeometry(3, 3, 16, 8),
  beam: new THREE.CylinderGeometry(4, 11, 1, 10, 1, true),
  splash: new THREE.RingGeometry(CHOPPER_SPREAD - 9, CHOPPER_SPREAD, 30),
  shadow: new THREE.CircleGeometry(30, 22),
}

function makeChopper(hue: number): ChopperRig {
  const root = new THREE.Group()
  const body = new THREE.Group()
  const paint = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(hue / 360, 0.62, 0.54),
    roughness: 0.55,
    metalness: 0.05,
  })
  const dark = new THREE.MeshStandardMaterial({ color: 0x2b3242, roughness: 0.7 })

  const hull = new THREE.Mesh(CHOPPER_GEO.hull, paint)
  hull.rotation.x = Math.PI / 2
  hull.castShadow = true
  const cabin = new THREE.Mesh(CHOPPER_GEO.cabin, paint)
  cabin.position.set(0, 2, -22)
  cabin.scale.set(1, 0.85, 1.1)
  const tail = new THREE.Mesh(CHOPPER_GEO.tail, paint)
  tail.position.set(0, 4, 44)
  const fin = new THREE.Mesh(CHOPPER_GEO.fin, dark)
  fin.position.set(0, 14, 64)
  const mast = new THREE.Mesh(CHOPPER_GEO.mast, dark)
  mast.position.y = 20
  const rotor = new THREE.Mesh(CHOPPER_GEO.rotor, dark)
  rotor.position.y = 28
  const rotor2 = new THREE.Mesh(CHOPPER_GEO.rotor2, dark)
  rotor.add(rotor2)
  // A faint disc under the blades. Two crossed bars at four frames a second
  // read as a spinning cross; a translucent circle behind them reads as a rotor
  // whatever the frame rate does, which on a phone is the point.
  const disc = new THREE.Mesh(
    CHOPPER_GEO.disc,
    new THREE.MeshBasicMaterial({
      color: 0xcfd8e6, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide,
    }),
  )
  disc.rotation.x = -Math.PI / 2
  disc.position.y = 27
  body.add(hull, cabin, tail, fin, mast, disc, rotor)
  root.add(body)

  // The altitude cue. Nothing else on this board is off the ground, so without
  // a mark underneath it a chopper at three hundred units reads as a tank
  // parked somewhere slightly wrong.
  const shadow = new THREE.Mesh(
    CHOPPER_GEO.shadow,
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false }),
  )
  shadow.rotation.x = -Math.PI / 2
  root.add(shadow)

  // Unlit and depth-tested off nothing: it is a beam of light, and shading it
  // would make it a grey tube.
  const beam = new THREE.Mesh(
    CHOPPER_GEO.beam,
    new THREE.MeshBasicMaterial({
      color: 0xffd68a,
      transparent: true,
      opacity: 0.7,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  beam.visible = false
  root.add(beam)

  // The ring on the felt is the important half. A player under a gunship is not
  // looking up; what they need is the circle they are standing in.
  const splash = new THREE.Mesh(
    CHOPPER_GEO.splash,
    new THREE.MeshBasicMaterial({
      color: 0xff9d4d,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  splash.rotation.x = -Math.PI / 2
  splash.visible = false
  root.add(splash)

  return { root, body, rotor, beam, splash, shadow, wasX: 0, wasZ: 0 }
}

/** Only the per-rig materials; the geometry above is shared and stays. */
function disposeChopper(rig: ChopperRig): void {
  rig.root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const m = mesh.material
    if (Array.isArray(m)) m.forEach((x) => x.dispose())
    else m.dispose()
  })
}

/**
 * A flag base: a pole, its cloth, and a ring on the felt.
 *
 * The ring is the load-bearing part rather than the pole. What a defender needs
 * to read from across the arena is "our base is empty", and a missing rectangle
 * of cloth on a 300-unit-tall pole seen from two thousand units back is not a
 * signal — a pulsing 90-unit ring on the grass is.
 */
interface FlagRig {
  root: THREE.Group
  cloth: THREE.Mesh
  ring: THREE.Mesh
}

/**
 * Side colours, shared with the HUD.
 *
 * The same five hues `TEAM_HUES` uses in main.ts, and index 0 is unused for the
 * same reason teams are 1-indexed everywhere else — zero is nobody's side, and
 * a palette that quietly gave it a colour would draw a base for it.
 */
const TEAM_HUE = [0, 356, 210, 132, 44, 285]

const FLAG_GEO = {
  pole: new THREE.CylinderGeometry(3.5, 3.5, 120, 8),
  cloth: new THREE.BoxGeometry(46, 30, 3),
  ring: new THREE.RingGeometry(FLAG_REACH - 10, FLAG_REACH, 40),
  knob: new THREE.SphereGeometry(6, 10, 8),
}

function makeFlag(hue: number): FlagRig {
  const root = new THREE.Group()
  const metal = new THREE.MeshStandardMaterial({ color: 0xd8dee9, roughness: 0.5, metalness: 0.2 })
  const cloth = new THREE.Mesh(
    FLAG_GEO.cloth,
    new THREE.MeshStandardMaterial({
      color: new THREE.Color().setHSL((hue % 360) / 360, 0.74, 0.55),
      roughness: 0.7,
      side: THREE.DoubleSide,
    }),
  )
  const pole = new THREE.Mesh(FLAG_GEO.pole, metal)
  pole.position.y = 60
  pole.castShadow = true
  const knob = new THREE.Mesh(FLAG_GEO.knob, metal)
  knob.position.y = 122
  cloth.position.set(25, 102, 0)
  cloth.castShadow = true

  const ring = new THREE.Mesh(
    FLAG_GEO.ring,
    new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL((hue % 360) / 360, 0.8, 0.6),
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.y = GROUND_Y + DECAL_LIFT

  root.add(pole, knob, cloth, ring)
  return { root, cloth, ring }
}

/** A flag flying off a tank that is carrying one. */
function makeCarried(): THREE.Group {
  const g = new THREE.Group()
  const pole = new THREE.Mesh(
    FLAG_GEO.pole,
    new THREE.MeshStandardMaterial({ color: 0xd8dee9, roughness: 0.5 }),
  )
  pole.scale.set(0.7, 0.5, 0.7)
  pole.position.y = 46
  const cloth = new THREE.Mesh(
    FLAG_GEO.cloth,
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, side: THREE.DoubleSide }),
  )
  cloth.scale.setScalar(0.72)
  cloth.position.set(18, 72, 0)
  g.add(pole, cloth)
  // Behind the turret so it does not sit over the driver's head, and clear of
  // the name plate stack, which runs from y=7 to y=133.
  g.position.set(-8, 0, 0)
  return g
}

/** Per-rig materials only; the geometry above is shared and stays. */
function disposeFlag(rig: FlagRig): void {
  rig.root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const m = mesh.material
    if (Array.isArray(m)) m.forEach((x) => x.dispose())
    else m.dispose()
  })
}

/** A capture point: a fixed ring, and a disc that fills as it turns. */
interface PointRig {
  root: THREE.Group
  outer: THREE.Mesh
  fill: THREE.Mesh
}

const POINT_GEO = {
  ring: new THREE.RingGeometry(POINT_RADIUS - 9, POINT_RADIUS, 44),
  fill: new THREE.CircleGeometry(POINT_RADIUS - 12, 40),
}

function makePoint(): PointRig {
  const root = new THREE.Group()
  const outer = new THREE.Mesh(
    POINT_GEO.ring,
    new THREE.MeshBasicMaterial({
      color: 0xd7dde8,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  outer.rotation.x = -Math.PI / 2
  const fill = new THREE.Mesh(
    POINT_GEO.fill,
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.34,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  fill.rotation.x = -Math.PI / 2
  // A hair above the ring, or the two z-fight on a board seen from two thousand
  // units back and the point flickers.
  fill.position.y = 0.4
  fill.visible = false
  root.add(outer, fill)
  return { root, outer, fill }
}

/** Per-rig materials only; the geometry above is shared. */
function disposePoint(rig: PointRig): void {
  for (const m of [rig.outer, rig.fill]) (m.material as THREE.Material).dispose()
}

/** A name plate. Redrawn only when the name or colour actually changes. */
/**
 * The name plate — and, when `dry`, the "this tank is reloading" state.
 *
 * The empty-magazine marker lives *here*, on the plate, after two attempts at
 * a mesh above the tank failed for the same reason in two different places.
 * A 46x6 slab at y=101 was inside the plate sprite (152x38 centred on 114
 * covers 95 to 133) and never reached a pixel; moved to y=64 it landed inside
 * the driver's face sprite instead. `visible` was `true` both times and a DOM
 * assertion would have called it shipped. There is no clear air above a tank:
 * the head, the pips and the plate already use all of it, and above the plate
 * is past what `framesBoard` keeps on screen for a tank in a corner.
 *
 * The plate is the one thing on a tank that is guaranteed to be legible — it
 * is a `depthTest: false` sprite drawn over everything, and it is the element
 * players are already reading to tell each other apart. So it carries the
 * state: the plate goes charcoal with an amber rim and amber text. That is a
 * change no tank hue can imitate, because hues come from a fixed palette of
 * six saturated colours and this is neither saturated nor coloured.
 */
function labelTexture(
  name: string,
  hue: number,
  verified: boolean,
  dry: boolean,
  held: number,
): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const text = verified ? name : `${name} ?`

  ctx.font = '700 62px ui-monospace, Menlo, monospace'
  const w = Math.min(480, ctx.measureText(text).width + 56)
  const x = (512 - w) / 2

  ctx.fillStyle = dry ? '#1b212c' : `hsl(${hue}, 70%, 42%)`
  ctx.strokeStyle = dry ? '#f0b23c' : '#141a26'
  ctx.lineWidth = dry ? 10 : 8
  roundRect(ctx, x, 22, w, 84, 26)
  ctx.fill()
  ctx.stroke()

  ctx.font = '700 52px ui-monospace, Menlo, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = dry ? '#f0b23c' : verified ? '#ffffff' : '#e2d3a8'
  ctx.fillText(text, 256, 66)

  // Banked rewards, as a badge riding the plate's top-right corner. The tray
  // is the earner's private HUD; this is the room's copy of the only part it
  // needs — that this tank is sitting on something. Amber like the pips, a
  // count rather than icons, because from two thousand units back one bright
  // digit reads and five tiny glyphs do not.
  if (held > 0) {
    const bx = Math.min(512 - 34, x + w - 6)
    ctx.beginPath()
    ctx.arc(bx, 30, 28, 0, Math.PI * 2)
    ctx.fillStyle = '#f0b23c'
    ctx.fill()
    ctx.strokeStyle = '#141a26'
    ctx.lineWidth = 7
    ctx.stroke()
    ctx.font = '800 42px ui-monospace, Menlo, monospace'
    ctx.fillStyle = '#141a26'
    ctx.fillText(String(held), bx, 32)
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// ------------------------------------------------------------------ scenery

/**
 * How tall a barricade stands. Well under `WALL_H`, and under `EYE_Y` too.
 *
 * A sandbag line has to *look* like something you can shoot over from every
 * camera this game has, because that is what it does. From the board it reads
 * as low because everything next to it is twice the height; from the cockpit
 * the eye is at 50 and the top of the bags is at 27, so you are plainly
 * looking down at it. If someone later raises this past `EYE_Y` the geometry
 * will start telling a lie the simulation does not agree with.
 */
const LOW_H = 27

/** One masonry block of the perimeter wall, near enough. */
const FENCE_BLOCK = 74

/**
 * A per-rect seed.
 *
 * Every scatter below — which way a boulder is turned, which crates are
 * doubled, where the worn patches fall — comes out of this, so a board looks
 * identical on every load and in every screenshot. `Math.random` here would
 * mean "did that change?" is a question nobody can answer from an image, and
 * an image is how this pass gets checked.
 *
 * It is emphatically *not* on the wire: scenery is decoration, two clients
 * disagreeing about the tilt of a rock costs nothing. Which rects are low is
 * the part that matters and that comes from the layout.
 */
function rectSeed(r: Rect): number {
  return (
    (Math.imul(r.x | 0, 0x9e3779b1) ^
      Math.imul(r.y | 0, 0x85ebca6b) ^
      Math.imul(r.w | 0, 0xc2b2ae35) ^
      Math.imul(r.h | 0, 0x27d4eb2f)) >>>
    0
  )
}

/** A small painted canvas, tiled per face. */
function paint(draw: (ctx: CanvasRenderingContext2D, rnd: () => number) => void, seed: number): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  draw(canvas.getContext('2d')!, noise(seed))
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return texture
}

/** Sawn timber: planks across, grain along them. */
const woodTexture = () =>
  paint((ctx, rnd) => {
    ctx.fillStyle = '#9d7846'
    ctx.fillRect(0, 0, 128, 128)
    for (let y = 0; y < 128; y += 32) {
      ctx.fillStyle = `rgba(0,0,0,${0.05 + rnd() * 0.06})`
      ctx.fillRect(0, y, 128, 32)
      ctx.fillStyle = 'rgba(40,26,12,0.45)'
      ctx.fillRect(0, y, 128, 2)
    }
    for (let i = 0; i < 420; i++) {
      const y = rnd() * 128
      ctx.strokeStyle = rnd() > 0.5 ? 'rgba(60,40,18,0.20)' : 'rgba(214,182,132,0.20)'
      ctx.beginPath()
      ctx.moveTo(rnd() * 128, y)
      ctx.lineTo(rnd() * 128, y)
      ctx.stroke()
    }
  }, 0x51a3)

/** Weathered granite: mottled, not noisy. Blobs read as stone, dots read as sand. */
const stoneTexture = () =>
  paint((ctx, rnd) => {
    ctx.fillStyle = '#8b877e'
    ctx.fillRect(0, 0, 128, 128)
    for (let i = 0; i < 160; i++) {
      const x = rnd() * 128
      const y = rnd() * 128
      const r = 3 + rnd() * 14
      ctx.fillStyle = rnd() > 0.5 ? 'rgba(160,155,145,0.30)' : 'rgba(96,92,84,0.32)'
      ctx.beginPath()
      ctx.arc(x, y, r, 0, TAU)
      ctx.fill()
    }
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = rnd() > 0.5 ? 'rgba(220,216,206,0.16)' : 'rgba(48,46,42,0.16)'
      ctx.fillRect(rnd() * 128, rnd() * 128, 1, 1)
    }
  }, 0x9c14)

/** Leaves. Short strokes in four greens, for the same reason the turf uses them. */
const foliageTexture = () =>
  paint((ctx, rnd) => {
    ctx.fillStyle = '#47632f'
    ctx.fillRect(0, 0, 128, 128)
    const greens = ['#5c7d3c', '#3a5227', '#6d9047', '#4f6c33']
    for (let i = 0; i < 2600; i++) {
      const x = rnd() * 128
      const y = rnd() * 128
      ctx.fillStyle = greens[(rnd() * greens.length) | 0]
      ctx.beginPath()
      ctx.ellipse(x, y, 1.6 + rnd() * 2.4, 1 + rnd() * 1.4, rnd() * TAU, 0, TAU)
      ctx.fill()
    }
  }, 0x3ea7)

/** Hessian: a visible weave, because a smooth sandbag is a pillow. */
const canvasTexture = () =>
  paint((ctx, rnd) => {
    ctx.fillStyle = '#a8a173'
    ctx.fillRect(0, 0, 128, 128)
    for (let i = 0; i < 128; i += 4) {
      ctx.fillStyle = 'rgba(88,72,44,0.16)'
      ctx.fillRect(i, 0, 2, 128)
      ctx.fillStyle = 'rgba(226,208,166,0.14)'
      ctx.fillRect(0, i, 128, 2)
    }
    for (let i = 0; i < 700; i++) {
      ctx.fillStyle = rnd() > 0.5 ? 'rgba(70,56,32,0.20)' : 'rgba(232,216,178,0.16)'
      ctx.fillRect(rnd() * 128, rnd() * 128, 2, 1)
    }
  }, 0x77b2)

/** Painted steel that has been outside a while. */
const drumTexture = () =>
  paint((ctx, rnd) => {
    ctx.fillStyle = '#6b6455'
    ctx.fillRect(0, 0, 128, 128)
    ctx.fillStyle = 'rgba(150,84,42,0.55)'
    ctx.fillRect(0, 46, 128, 22)
    for (let i = 0; i < 260; i++) {
      const x = rnd() * 128
      const y = rnd() * 128
      ctx.fillStyle = 'rgba(122,64,30,0.34)'
      ctx.beginPath()
      ctx.ellipse(x, y, 1 + rnd() * 5, 2 + rnd() * 11, 0, 0, TAU)
      ctx.fill()
    }
  }, 0x2d61)

/**
 * One material per kind, built fresh with the board.
 *
 * Fresh rather than module-level because `buildBoard` runs again on every
 * block that changes the layout, and a texture whose owner has been disposed
 * is a black mesh. Cheap enough: five canvases of 128px, once a block.
 */
function coverMaterials(): Record<CoverKind, THREE.MeshStandardMaterial> {
  const stone = stoneTexture()
  return {
    // Desaturated on purpose, and this is the same argument the pastels were
    // making, just made properly. The six player hues are the most saturated
    // things in the scene; scenery has to stay out of their way. Earth
    // pigments do that far better than pastels, because a pastel is a
    // saturated hue with white in it and still competes for the same corner
    // of the wheel.
    rock: new THREE.MeshStandardMaterial({ map: stone, bumpMap: stone, bumpScale: 1.6, color: 0x9e988e, roughness: 0.94 }),
    fence: new THREE.MeshStandardMaterial({ map: stone, color: 0x8d8479, roughness: 0.96 }),
    crate: new THREE.MeshStandardMaterial({ map: woodTexture(), color: 0xb08a55, roughness: 0.82 }),
    barrel: new THREE.MeshStandardMaterial({ map: drumTexture(), color: 0x847c6b, roughness: 0.52, metalness: 0.3 }),
    sandbag: new THREE.MeshStandardMaterial({ map: canvasTexture(), color: 0xbdb583, roughness: 0.98 }),
    hedge: new THREE.MeshStandardMaterial({ map: foliageTexture(), color: 0x7a9455, roughness: 0.95 }),
  }
}

/**
 * Build scenery with the rect's long axis along +x, then turn it if it is not.
 *
 * Every builder below would otherwise need to know which way round its rect
 * is and swap width for depth in about six places each. Doing it once at the
 * end is the whole reason a row of sandbags can be written as a row.
 */
function longAxis(r: Rect) {
  const horizontal = r.w >= r.h
  return { horizontal, long: horizontal ? r.w : r.h, short: horizontal ? r.h : r.w }
}

/** Collects parts, all non-indexed so `mergeGeometries` will take them together. */
function partBag() {
  const parts: THREE.BufferGeometry[] = []
  return {
    parts,
    put(g: THREE.BufferGeometry) {
      if (g.index) {
        const flat = g.toNonIndexed()
        g.dispose()
        parts.push(flat)
      } else parts.push(g)
    },
  }
}

/**
 * A weathered outcrop: faceted boulders, packed dense enough along the rect
 * that there is no gap a player could think a shell might fit through. The
 * shell bounces off the whole rectangle, so the silhouette has to fill it.
 */
function rockParts(r: Rect, rnd: () => number, bag: ReturnType<typeof partBag>): void {
  const { long, short } = longAxis(r)
  const n = Math.min(9, Math.max(2, Math.round(long / (short * 0.78))))
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1) - 0.5
    const hgt = WALL_H * (0.74 + rnd() * 0.36)
    const rad = short * 0.62
    const g = new THREE.IcosahedronGeometry(1, 0)
    g.scale(rad * (0.86 + rnd() * 0.3), hgt * 0.56, rad * (0.86 + rnd() * 0.3))
    g.rotateY(rnd() * TAU)
    g.rotateX((rnd() - 0.5) * 0.34)
    g.translate(t * (long - short) * 0.98, hgt * 0.4, (rnd() - 0.5) * short * 0.3)
    bag.put(g)
  }
  // Scree. Three chips at the base is what stops an outcrop from looking like
  // it was dropped on the grass a second ago.
  for (let i = 0; i < 3; i++) {
    const rad = short * (0.1 + rnd() * 0.12)
    const g = new THREE.IcosahedronGeometry(rad, 0)
    g.scale(1, 0.6, 1)
    g.rotateY(rnd() * TAU)
    g.translate((rnd() - 0.5) * long * 0.9, rad * 0.3, (rnd() - 0.5) * short * 0.85)
    bag.put(g)
  }
}

/**
 * Stacked timber. The bottom course fills the footprint and the top course
 * does not, which is what makes it a stack rather than a wall with a texture.
 */
function crateParts(r: Rect, rnd: () => number, bag: ReturnType<typeof partBag>): void {
  const { long, short } = longAxis(r)
  const side = short * 0.97
  const cH = WALL_H * 0.47
  const cols = Math.max(1, Math.round(long / side))
  for (let i = 0; i < cols; i++) {
    const t = cols === 1 ? 0 : i / (cols - 1) - 0.5
    const x = t * (long - side)
    const base = new RoundedBoxGeometry(side, cH, side, 2, Math.min(3, side * 0.08))
    base.rotateY((rnd() - 0.5) * 0.14)
    base.translate(x, cH * 0.5 - 1, (rnd() - 0.5) * short * 0.04)
    bag.put(base)
    if (rnd() < 0.62) {
      const s2 = side * (0.6 + rnd() * 0.22)
      const top = new RoundedBoxGeometry(s2, cH * 0.94, s2, 2, Math.min(3, s2 * 0.08))
      top.rotateY((rnd() - 0.5) * 0.8)
      top.translate(x + (rnd() - 0.5) * side * 0.18, cH * 1.45, (rnd() - 0.5) * short * 0.14)
      bag.put(top)
    }
  }
}

/**
 * Oil drums, laid out on a grid so a square footprint gets a cluster and a
 * long one gets a row without either case being special-cased.
 */
function barrelParts(r: Rect, rnd: () => number, bag: ReturnType<typeof partBag>): void {
  const { long, short } = longAxis(r)
  const rad = Math.min(short * 0.44, 22)
  const hgt = WALL_H * 0.86
  const cols = Math.max(1, Math.round(long / (rad * 2.05)))
  const rows = Math.max(1, Math.round(short / (rad * 2.05)))
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = (cols === 1 ? 0 : i / (cols - 1) - 0.5) * (long - rad * 2)
      const z = (rows === 1 ? 0 : j / (rows - 1) - 0.5) * (short - rad * 2)
      const jx = x + (rnd() - 0.5) * rad * 0.3
      const jz = z + (rnd() - 0.5) * rad * 0.3
      const body = new THREE.CylinderGeometry(rad * 0.94, rad * 0.94, hgt, 12, 1)
      body.rotateY(rnd() * TAU)
      body.translate(jx, hgt * 0.5, jz)
      bag.put(body)
      // Rolling hoops. Two thin wider rings are the entire read of "drum".
      for (const at of [0.3, 0.72]) {
        const hoop = new THREE.CylinderGeometry(rad, rad, hgt * 0.07, 12, 1)
        hoop.translate(jx, hgt * at, jz)
        bag.put(hoop)
      }
    }
  }
}

/**
 * Three staggered courses of bags. Short of `WALL_H` by design — see `LOW_H`.
 */
function sandbagParts(r: Rect, rnd: () => number, bag: ReturnType<typeof partBag>): void {
  const { long, short } = longAxis(r)
  const courses = 3
  const bagH = LOW_H / courses
  const bagLen = 26
  const depth = short * 0.9
  for (let c = 0; c < courses; c++) {
    const offset = (c % 2) * bagLen * 0.5
    const n = Math.max(1, Math.floor((long - offset) / bagLen))
    for (let i = 0; i < n; i++) {
      const x = -long / 2 + offset + bagLen * (i + 0.5)
      const g = new RoundedBoxGeometry(bagLen * 0.98, bagH * 1.2, depth, 2, bagH * 0.46)
      g.rotateY((rnd() - 0.5) * 0.14)
      g.translate(x, bagH * (c + 0.5), (rnd() - 0.5) * short * 0.06)
      bag.put(g)
    }
  }
}

/**
 * A clipped hedge with a ragged top. The mass does the collision-shaped work
 * and the blobs stop the silhouette from being a box, which on a 520-unit
 * hedgerow is the difference between scenery and a green wall.
 */
function hedgeParts(r: Rect, rnd: () => number, bag: ReturnType<typeof partBag>): void {
  const { long, short } = longAxis(r)
  const hgt = WALL_H * 0.9
  const mass = new RoundedBoxGeometry(long * 0.99, hgt, short * 0.99, 3, Math.min(13, short * 0.3))
  mass.translate(0, hgt * 0.5 - 2, 0)
  bag.put(mass)
  const blobs = Math.min(30, Math.max(3, Math.round(long / 30)))
  for (let i = 0; i < blobs; i++) {
    const rad = short * (0.24 + rnd() * 0.24)
    const g = new THREE.SphereGeometry(rad, 7, 5)
    g.scale(1, 0.72, 1)
    g.translate(
      (rnd() - 0.5) * (long - rad),
      hgt - rad * 0.3,
      (rnd() - 0.5) * (short - rad * 1.2),
    )
    bag.put(g)
  }
}

/** Dry-stone coursing plus a cap, rather than one very long stretched box. */
function fenceParts(r: Rect, rnd: () => number, bag: ReturnType<typeof partBag>): void {
  const { long, short } = longAxis(r)
  const n = Math.max(1, Math.round(long / FENCE_BLOCK))
  const len = long / n
  for (let i = 0; i < n; i++) {
    const h = FENCE_H * (0.93 + rnd() * 0.07)
    const g = new RoundedBoxGeometry(len * 1.02, h, short, 2, 3)
    g.translate(-long / 2 + len * (i + 0.5), h * 0.5, 0)
    bag.put(g)
  }
  const cap = new RoundedBoxGeometry(long, 9, short + 7, 2, 3)
  cap.translate(0, FENCE_H + 1, 0)
  bag.put(cap)
}

/**
 * What is left when a piece of cover comes apart.
 *
 * Puzz: "the walls should break eventually but the remains should stay."
 * Before this, breaking a crate deleted it — the lane opened and the board
 * simply had a hole in it where a stack of timber had been a second earlier,
 * which reads as a rendering fault rather than as something you did.
 *
 * Low on purpose, and this is a decision worth stating rather than a number
 * that happened. `arena.ts` says out loud that there are exactly two questions
 * anything in this game asks a rect — does it stop a tank, does it stop a
 * shell — and that a third invites a height field nobody has designed. Rubble
 * is *cosmetic*: shells pass over it and tanks drive across it exactly as they
 * do over the empty ground today, so breaching still opens the lane for both
 * and nothing about the rules moved. Keeping it under a hull's belly is what
 * makes driving through look like driving over debris instead of like a bug.
 *
 * If rubble should also slow a tank, that is a genuine rules change and it
 * wants its own issue and its own height field, not a quiet extra predicate.
 */
const RUBBLE_H = WALL_H * 0.2

/**
 * The hard ceiling on a pile, in world units.
 *
 * A cap rather than a hope, because the parts below are *rotated*: tipping a
 * chunk that is 120 units long by a quarter of a radian lifts its far corner
 * far above the height it was built at, and how long a chunk is depends on the
 * rect it came from. The first cut of this looked right on a square crate and
 * measured 59 units on a long one — a wall, exactly the thing rubble is not.
 * Scaling the merged geometry to fit is the only version of "under a hull"
 * that is true for every footprint on every board.
 *
 * Sixteen is the top of a tank's hull mesh, so a pile is never taller than the
 * thing driving over it.
 */
const RUBBLE_CAP = 16

function rubbleParts(r: Rect, rnd: () => number, bag: ReturnType<typeof partBag>): void {
  const { long, short } = longAxis(r)
  // Enough chunks to read as a pile from the board camera and few enough that
  // eight of them on a board is not a second layout's worth of geometry.
  const n = Math.max(4, Math.round(long / 34))
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1) - 0.5
    const w = short * (0.24 + rnd() * 0.34)
    const h = RUBBLE_H * (0.42 + rnd() * 0.62)
    const g = new RoundedBoxGeometry(w * (1 + rnd()), h, w, 1, Math.min(2, h * 0.3))
    // Tipped over rather than stacked. A pile whose pieces are all level reads
    // as a low wall, which is the thing this is explicitly not.
    g.rotateY(rnd() * TAU)
    g.rotateZ((rnd() - 0.5) * 0.9)
    g.rotateX((rnd() - 0.5) * 0.7)
    g.translate(t * (long - w) * 0.92, h * 0.36, (rnd() - 0.5) * short * 0.62)
    bag.put(g)
  }
  // Splinters flat on the ground around the footprint, which is what stops the
  // pile from looking like it was placed there.
  for (let i = 0; i < 3; i++) {
    const len = short * (0.2 + rnd() * 0.3)
    const g = new RoundedBoxGeometry(len, RUBBLE_H * 0.18, len * 0.35, 1, 1)
    g.rotateY(rnd() * TAU)
    g.translate((rnd() - 0.5) * long * 1.02, RUBBLE_H * 0.09, (rnd() - 0.5) * short * 1.02)
    bag.put(g)
  }
}

const SCENERY: Record<CoverKind, (r: Rect, rnd: () => number, bag: ReturnType<typeof partBag>) => void> = {
  rock: rockParts,
  crate: crateParts,
  barrel: barrelParts,
  sandbag: sandbagParts,
  hedge: hedgeParts,
  fence: fenceParts,
}

/**
 * One merged geometry per rect, so a board full of boulders is still one draw
 * call per piece of cover.
 *
 * The Pillars board has fourteen pieces of cover and a rock outcrop is a dozen
 * meshes; unmerged that is a couple of hundred draw calls with shadows on, on
 * hardware that includes phones. Merging costs a few milliseconds once a block.
 */
function coverGeometry(r: Rect): THREE.BufferGeometry {
  const bag = partBag()
  SCENERY[r.kind ?? 'rock'](r, noise(rectSeed(r)), bag)
  const merged = mergeGeometries(bag.parts, false)!
  for (const g of bag.parts) g.dispose()
  if (!longAxis(r).horizontal) merged.rotateY(Math.PI / 2)
  return merged
}

/**
 * The pile that replaces it, seeded off the same rect.
 *
 * Same seed as the cover it came from, so the debris sits where the stack was
 * rather than being re-scattered every time the board is rebuilt — and so two
 * clients that rebuild at different moments see the same pile.
 */
function rubbleGeometry(r: Rect): THREE.BufferGeometry {
  const bag = partBag()
  rubbleParts(r, noise(rectSeed(r) ^ 0x9e37), bag)
  const merged = mergeGeometries(bag.parts, false)!
  for (const g of bag.parts) g.dispose()
  if (!longAxis(r).horizontal) merged.rotateY(Math.PI / 2)
  // Measured, then flattened if it needs it. See `RUBBLE_CAP`.
  merged.computeBoundingBox()
  const top = merged.boundingBox?.max.y ?? 0
  if (top > RUBBLE_CAP) merged.scale(1, RUBBLE_CAP / top, 1)
  return merged
}

// ------------------------------------------------------------------- tanks

/** Everything about one tank that the renderer owns. */
interface TankRig {
  root: THREE.Group
  /**
   * The flag this tank is carrying, built the first time it picks one up.
   *
   * Optional and lazy because most tanks in most rounds never touch one, and a
   * pole plus a cloth on eight rigs that will never show them is geometry
   * allocated for nothing.
   */
  flag?: THREE.Group
  /** Bounces and squashes. Purely cosmetic, sits between root and the body. */
  bob: THREE.Group
  hull: THREE.Group
  turret: THREE.Group
  label: THREE.Sprite
  /** The character in the hatch. Rides the turret, so the driver faces the gun. */
  driver: THREE.Group
  /**
   * The turret dome and its ink outline.
   *
   * Held separately because they come off in cockpit view. The barrel sits at
   * y=28 and the dome's top is at 36, so from any eye high enough to see over
   * the dome your own gun is behind it — the first cut of the cockpit showed a
   * screen-filling wedge of turret roof with two inches of barrel tip poking
   * out of the far side of it. You are inside this thing; it should not be
   * between you and the board.
   */
  domeParts: THREE.Mesh[]
  /** The npub's picture, billboarded above the hatch. */
  face: THREE.Sprite
  avatar: Avatar
  pips: THREE.Mesh[]
  ring: THREE.Mesh
  body: THREE.MeshStandardMaterial
  trim: THREE.MeshStandardMaterial
  labelKey: string
  /**
   * The shield bubble, one per tank rather than one for the local player.
   *
   * It used to be a single mesh parked on whichever tank was you, which meant
   * a shield was a fact only its owner could see. A defensive buff nobody can
   * read is not a tactic, it is a private surprise — see `StatePayload.sh`.
   */
  bubble: THREE.Mesh
  /** The recon ping over this tank. Visible only while a sweep marks it. */
  ping: THREE.Mesh
  /**
   * Fractional puffs owed to the plume emitter.
   *
   * Carried across frames so the smoke rate is per second rather than per
   * frame: without it a 120Hz machine smokes twice as hard as a 60Hz one, and
   * a machine that has degraded to `lean` barely smokes at all — exactly the
   * device that most needs the damage to be legible.
   */
  smokeOwed: number
  /** Set when firing, decays to 0 — drives recoil and the muzzle flash. */
  recoil: number
  flash: THREE.Mesh
  /** Eased toward -14 while dead. Kept as a number so the idle bounce can be
   *  added on top without the two fighting over `bob.position.y`. */
  sink: number
}

const HULL_GEO = new RoundedBoxGeometry(44, 21, 30, 3, 5)
const TREAD_GEO = new RoundedBoxGeometry(48, 13, 9, 2, 4)
const DOME_GEO = new THREE.CylinderGeometry(13.5, 15, 16, 16)
const BARREL_GEO = new RoundedBoxGeometry(36, 7, 7, 2, 3)
const PIP_GEO = new RoundedBoxGeometry(13, 13, 13, 2, 4)
const FLASH_GEO = new THREE.SphereGeometry(11, 10, 8)
const TORSO_GEO = new RoundedBoxGeometry(15, 15, 17, 3, 4)
/** What a burning hull's emissive is pulled toward. */
const FIRE_GLOW = new THREE.Color(0xff7a1f)
const BUBBLE_GEO = new THREE.SphereGeometry(TANK_RADIUS + 16, 20, 14)
// Shared across every rig: all shields look the same, so one material is one
// less thing to dispose and one less draw-call state change.
const BUBBLE_MAT = new THREE.MeshBasicMaterial({
  color: 0x7fd4ff,
  transparent: true,
  opacity: 0.42,
  depthWrite: false,
  side: THREE.DoubleSide,
})
/**
 * The lattice inside the bubble.
 *
 * A flat 28%-opacity sphere over a tank the board camera draws forty units
 * tall was measurable and not legible — it tinted the tank rather than
 * announcing anything, and a defensive buff that has to be squinted at is a
 * buff nobody plays around. The panel lines give it an edge that survives
 * being small, and they read as a shield rather than as a blue tank.
 */
const BUBBLE_WIRE_GEO = new THREE.IcosahedronGeometry(TANK_RADIUS + 17, 2)
/**
 * The recon ping: a spinning diamond hung high over an enemy tank, drawn with
 * `depthTest` off so it reads through rocks and hedges — that is the whole
 * reward. High and small rather than an outline of the hull: an outline needs
 * the hull's silhouette re-rendered per skin, a diamond needs one mesh, and
 * from the board camera "there, behind that rock" is the information.
 */
const PING_GEO = new THREE.OctahedronGeometry(9)
const PING_MAT = new THREE.MeshBasicMaterial({
  color: 0xff5340,
  transparent: true,
  opacity: 0.95,
  depthTest: false,
})

const BUBBLE_WIRE_MAT = new THREE.MeshBasicMaterial({
  color: 0xd6f4ff,
  wireframe: true,
  transparent: true,
  opacity: 0.85,
  depthWrite: false,
})

/** Everything the renderer needs about one tank for one frame. */
interface TankView {
  x: number
  y: number
  hull: number
  gun: number
  hp: number
  /** This round's hull maximum, which Glass Cannon changes. */
  maxHp: number
  /** Shells left in their magazine. 0 means empty or mid-reload. */
  ammo: number
  /** Streak rewards banked in their tray, drawn as a badge on the plate. */
  held: number
  /** True while a shield is up, for them as well as for you. */
  shield: boolean
  dead: boolean
  hue: number
  name: string
  /** kind 0 picture URL for this player, or null while it has not arrived. */
  picture: string | null
  verified: boolean
  streak: number
  /** The finish this tank wears. See `src/skins.ts`. */
  skin: SkinId
  /** True for the local player, whose ring is always drawn. */
  mine: boolean
  /**
   * Declared side, 1..5, or 0. Drawn as a ring on the felt when it matches
   * ours, and not at all when it does not.
   *
   * A friend marked and an enemy unmarked, rather than a colour per side on
   * every tank. Two reasons. The hue is how you find yourself and how you tell
   * eight tanks apart, and painting a second colour over it costs the thing
   * that matters most; and what a player actually needs to know in the half
   * second before pulling a trigger is not "which of five sides is that", it is
   * "can I shoot it".
   */
  team: number
  /** Our own side, so a rig can tell whether `team` is a friend or a stranger. */
  ourTeam: number
}

/**
 * Paint one tank in its chosen finish, without losing its colour.
 *
 * The hue is the player's identity — it comes from their pubkey and is spread
 * across a fixed six-colour palette so four tanks are obviously four colours.
 * That is the most load-bearing piece of legibility in the game, so every skin
 * here changes the *finish* and keeps the hue: lightness, metalness, roughness
 * and how much the hull glows.
 *
 * `carbon` is the exception that proves the rule. Its hull is nearly black, so
 * putting the usual desaturated gunmetal on the trim would produce a tank with
 * no colour anywhere — the one thing a cosmetic is not allowed to do. Below a
 * lightness of 0.4 the trim takes the hue instead, at full saturation, so the
 * colour moves rather than disappearing.
 */
/**
 * A deterministic PRNG, so every client paints the same blotches. Seeded from
 * the camo id alone — a pattern that differed per screen would be two tanks
 * wearing different coats and calling it netcode.
 */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The camouflage painter. Tones are shades of the tank's own hue — "every
 * colour camo" without ever taking the player's colour away — and the shapes
 * are the pattern. Cached per (camo, hue): eight players in every pattern is
 * still under a hundred small canvases a session.
 */
const camoCache = new Map<string, THREE.CanvasTexture>()

function camoTexture(camo: CamoId, hue: number): THREE.CanvasTexture {
  const key = `${camo}|${hue}`
  const held = camoCache.get(key)
  if (held) return held

  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const tone = (sat: number, l: number) => `hsl(${hue}, ${sat}%, ${l}%)`
  // Per-pattern recipe: [base, ...blotch tones], plus a shape style.
  const recipes: Record<CamoId, { tones: string[]; style: 'blob' | 'pixel' | 'stripe' }> = {
    woodland: { tones: [tone(45, 32), tone(50, 18), tone(38, 44), 'hsl(0, 0%, 12%)'], style: 'blob' },
    desert: { tones: [tone(38, 62), tone(30, 48), tone(45, 74), tone(20, 55)], style: 'blob' },
    digital: { tones: [tone(40, 40), tone(45, 22), tone(35, 58), 'hsl(0, 0%, 25%)'], style: 'pixel' },
    tiger: { tones: [tone(55, 45), 'hsl(0, 0%, 10%)'], style: 'stripe' },
    navy: { tones: [tone(55, 24), tone(60, 13), tone(45, 34)], style: 'blob' },
    urban: { tones: ['hsl(0, 0%, 42%)', 'hsl(0, 0%, 25%)', 'hsl(0, 0%, 60%)', tone(65, 45)], style: 'blob' },
  }
  const { tones, style } = recipes[camo]
  const rand = mulberry32([...camo].reduce((a, c) => a * 31 + c.charCodeAt(0), 7))

  ctx.fillStyle = tones[0]
  ctx.fillRect(0, 0, size, size)
  if (style === 'pixel') {
    const cell = 8
    for (let y = 0; y < size; y += cell) {
      for (let x = 0; x < size; x += cell) {
        ctx.fillStyle = tones[Math.floor(rand() * tones.length)]
        ctx.fillRect(x, y, cell, cell)
      }
    }
  } else if (style === 'stripe') {
    ctx.strokeStyle = tones[1]
    ctx.lineCap = 'round'
    for (let i = 0; i < 14; i++) {
      ctx.lineWidth = 5 + rand() * 9
      ctx.beginPath()
      const x = rand() * size * 1.4 - size * 0.2
      ctx.moveTo(x, -8)
      ctx.bezierCurveTo(
        x - 18 + rand() * 36, size * 0.33,
        x - 18 + rand() * 36, size * 0.66,
        x + rand() * 30 - 15, size + 8,
      )
      ctx.stroke()
    }
  } else {
    for (let i = 0; i < 46; i++) {
      ctx.fillStyle = tones[1 + Math.floor(rand() * (tones.length - 1))]
      const x = rand() * size
      const y = rand() * size
      const r = 6 + rand() * 15
      ctx.beginPath()
      ctx.ellipse(x, y, r, r * (0.5 + rand() * 0.6), rand() * Math.PI, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  camoCache.set(key, texture)
  return texture
}

function applySkin(rig: TankRig, skin: Skin, hue: number): void {
  const h = hue / 360
  const light = Math.max(0.08, Math.min(0.95, 0.58 * skin.light))
  if (skin.camo) {
    // The tones live in the texture; `color` becomes the light/soot dial the
    // rest of the pipeline (wear's multiply, the skin's own `light`) turns.
    const tex = camoTexture(skin.camo, hue)
    if (rig.body.map !== tex) {
      rig.body.map = tex
      rig.body.needsUpdate = true
    }
    rig.body.color.setHSL(0, 0, Math.min(0.95, 0.95 * skin.light))
  } else {
    if (rig.body.map) {
      rig.body.map = null
      rig.body.needsUpdate = true
    }
    rig.body.color.setHSL(h, 0.78, light)
  }
  rig.body.metalness = skin.metalness
  rig.body.roughness = skin.roughness
  rig.body.emissive.setHSL(h, 0.9, skin.emissive * 0.45)
  if (!skin.camo && light < 0.4) {
    rig.trim.color.setHSL(h, 0.85, 0.55)
  } else if (skin.trim !== null) {
    rig.trim.color.setHex(skin.trim)
  } else {
    rig.trim.color.setHSL(h, 0.4, 0.26)
  }
}

function makeTank(): TankRig {
  const root = new THREE.Group()
  const bob = new THREE.Group()
  root.add(bob)

  const body = toy(0xffffff)
  const trim = toy(0x333a48, { roughness: 0.85 })

  const hull = new THREE.Group()
  const hullMesh = new THREE.Mesh(HULL_GEO, body)
  hullMesh.position.y = 16
  hullMesh.castShadow = true
  const hullInk = new THREE.Mesh(HULL_GEO, INK)
  hullInk.position.y = 16
  hullInk.scale.setScalar(1.07)
  hull.add(hullMesh, hullInk)

  for (const side of [-1, 1]) {
    const tread = new THREE.Mesh(TREAD_GEO, trim)
    tread.position.set(0, 7, side * 17)
    tread.castShadow = true
    hull.add(tread)
  }

  const turret = new THREE.Group()
  turret.position.y = 28
  const dome = new THREE.Mesh(DOME_GEO, body)
  dome.castShadow = true
  const domeInk = new THREE.Mesh(DOME_GEO, INK)
  domeInk.scale.setScalar(1.09)
  const barrel = new THREE.Mesh(BARREL_GEO, trim)
  barrel.position.x = 26
  barrel.castShadow = true
  turret.add(dome, domeInk, barrel)
  const domeParts = [dome, domeInk]

  const flash = new THREE.Mesh(
    FLASH_GEO,
    new THREE.MeshBasicMaterial({ color: 0xffe9a8, transparent: true, opacity: 0 }),
  )
  flash.position.x = 46
  flash.visible = false
  turret.add(flash)

  // The driver, and the thing that makes a hull read as somebody's tank rather
  // than as a box. It hangs off the turret, so the character turns to look
  // wherever the gun is pointing.
  //
  // The head is the npub's picture and nothing else — a sphere *and* a portrait
  // is two heads at the same height, which is what the first cut of this drew:
  // a grey ball sitting in front of the face it was supposed to be. So the
  // shoulders are geometry and the head is a billboard, which is also the only
  // version that stays legible, because the board is seen from one fixed high
  // angle and a portrait mapped onto a sphere is edge-on from most of it.
  const driver = new THREE.Group()
  const torso = new THREE.Mesh(TORSO_GEO, trim)
  torso.position.y = 6
  torso.castShadow = true
  const torsoInk = new THREE.Mesh(TORSO_GEO, INK)
  torsoInk.position.y = 6
  torsoInk.scale.setScalar(1.1)
  driver.add(torso, torsoInk)
  driver.position.set(-9, 8, 0)
  turret.add(driver)

  bob.add(hull, turret)

  // Sits on the ground under whoever you are, so you can find yourself in a
  // four-way scramble without reading name plates.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(TANK_RADIUS + 8, TANK_RADIUS + 16, 32),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  )
  ring.rotation.x = -Math.PI / 2
  ring.position.y = GROUND_Y + DECAL_LIFT
  ring.visible = false
  root.add(ring)

  const label = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }))
  label.scale.set(152, 38, 1)
  // The stack, bottom to top: hatch, face, hull pips, name. 133 is the ceiling —
  // `framesBoard` only guarantees everything below FENCE_H + 40 stays in frame,
  // so a plate any higher than this clips on a tank parked in a corner.
  label.position.y = 114
  root.add(label)

  const avatar = new Avatar()
  const face = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: avatar.texture, transparent: true }),
  )
  // Big for the shoulders under it, on purpose. This is a toy, and a head you
  // can recognise across a television is worth more than one in proportion.
  face.scale.set(30, 30, 1)
  face.position.y = 22
  driver.add(face)

  // On `root`, not on `bob`: the bob group tips a dead tank onto its side, and
  // a shield that rolls over with the wreck is a strange thing to look at. It
  // is hidden while dead anyway; this is belt and braces.
  const bubble = new THREE.Mesh(BUBBLE_GEO, BUBBLE_MAT)
  bubble.position.y = 26
  bubble.visible = false
  // A child, so `visible` and the pulse on the parent carry it without a
  // second thing to remember to hide.
  bubble.add(new THREE.Mesh(BUBBLE_WIRE_GEO, BUBBLE_WIRE_MAT))
  root.add(bubble)

  // On `root` like the bubble, and for the same reason: a marker that tips
  // over with a wreck reads wrong, and it is hidden while dead anyway.
  const ping = new THREE.Mesh(PING_GEO, PING_MAT)
  ping.position.y = 108
  ping.scale.set(1, 1.6, 1)
  ping.visible = false
  ping.renderOrder = 30
  root.add(ping)

  const pips: THREE.Mesh[] = []
  for (let i = 0; i < MAX_HP; i++) {
    const pip = new THREE.Mesh(PIP_GEO, toy(0xffffff))
    // Above the face, which now occupies everything from the hatch up to ~75.
    pip.position.set((i - (MAX_HP - 1) / 2) * 19, 86, 0)
    root.add(pip)
    pips.push(pip)
  }

  return {
    root,
    bob,
    hull,
    turret,
    label,
    driver,
    domeParts,
    face,
    avatar,
    pips,
    ring,
    body,
    trim,
    bubble,
    ping,
    smokeOwed: 0,
    labelKey: '',
    recoil: 0,
    flash,
    sink: 0,
  }
}

/**
 * The pickup's icon, extruded.
 *
 * Built from `ICON_POLYS` — the same polygons the HUD chip draws as an `<svg>`,
 * so the shape standing on the pad and the shape on the timer are the same
 * shape by construction rather than by two people drawing carefully. The icon
 * grid is 32 units with y pointing down, which is SVG's convention and the
 * opposite of three.js's, hence the flip.
 *
 * These are billboarded rather than spun. A spinning extrusion of a flat icon
 * goes edge-on twice a second and disappears, which is a strange thing to do to
 * the one object on the board whose entire job is to be identified from across
 * the arena.
 */
export function pickupGeometry(kind: PickupKind): THREE.BufferGeometry {
  // Sized so the silhouette survives the board camera. At 2.1 the shield read
  // as a coloured blob from the far end of The Lanes, which is the exact
  // failure the icons were added to fix.
  const SCALE = 2.8
  const shapes = ICON_POLYS[kind].map((poly) => {
    const shape = new THREE.Shape()
    poly.forEach(([x, y], i) => {
      const px = (x - 16) * SCALE
      const py = (16 - y) * SCALE
      if (i === 0) shape.moveTo(px, py)
      else shape.lineTo(px, py)
    })
    shape.closePath()
    return shape
  })
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth: 9,
    bevelEnabled: true,
    bevelSize: 2.2,
    bevelThickness: 2.2,
    bevelSegments: 2,
    curveSegments: 1,
  })
  geo.center()
  return geo
}

// --------------------------------------------------------------- particles

const PARTICLE_MAX = 320
const PARTICLE_GEO = new RoundedBoxGeometry(7, 7, 7, 1, 2)

const PLUME_MAX = 260
const PLUME_GEO = new RoundedBoxGeometry(21, 21, 21, 2, 3)
/**
 * A steady breeze across the arena, in world units per second.
 *
 * Two reasons, and the second is the important one. A plume that goes straight
 * up is a column standing in exactly the place the driver's head, the hull pips
 * and the name plate already occupy — this game has no clear air above a tank —
 * so the smoke would spend its whole life behind three sprites. Leaning it
 * downwind puts it over open felt where it can actually be seen, and gives the
 * board a direction, which is worth having for free.
 */
const WIND_X = 34
const WIND_Z = -11

interface Particle {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  spin: number
  life: number
  max: number
  size: number
  /** Carried on the particle, not written to its slot at spawn time: the pool
   *  shifts when it overflows, so a colour tied to an instance index would end
   *  up on somebody else's confetti. */
  color: THREE.Color
}

/**
 * One InstancedMesh for every spark, chip of confetti and puff of smoke in the
 * game. A party game wants a lot of them and they are all the same cube, so the
 * whole effects layer costs one draw call.
 */
class Confetti {
  readonly mesh: THREE.InstancedMesh
  private pool: Particle[] = []
  private dummy = new THREE.Object3D()

  constructor() {
    // Not transparent: particles fade by shrinking, which needs no depth
    // sorting and never flickers against the board.
    this.mesh = new THREE.InstancedMesh(
      PARTICLE_GEO,
      new THREE.MeshStandardMaterial({ roughness: 0.5 }),
      PARTICLE_MAX,
    )
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.count = PARTICLE_MAX
    // Everything starts collapsed to nothing, so unused slots draw no pixels.
    this.dummy.scale.setScalar(0)
    this.dummy.updateMatrix()
    for (let i = 0; i < PARTICLE_MAX; i++) this.mesh.setMatrixAt(i, this.dummy.matrix)
  }

  burst(
    x: number,
    z: number,
    count: number,
    hue: number,
    opts: { speed?: number; up?: number; y?: number; size?: number; life?: number } = {},
  ): void {
    const { speed = 190, up = 210, y = 22, size = 1, life = 1.1 } = opts
    for (let i = 0; i < count; i++) {
      if (this.pool.length >= PARTICLE_MAX) this.pool.shift()
      const a = Math.random() * TAU
      const s = speed * (0.35 + Math.random() * 0.9)
      // Hue jitter so a burst reads as confetti rather than as one flat colour.
      const spread = (((hue + (Math.random() - 0.5) * 44) % 360) + 360) % 360
      this.pool.push({
        x,
        y: y + Math.random() * 12,
        z,
        vx: Math.cos(a) * s,
        vy: up * (0.4 + Math.random()),
        vz: Math.sin(a) * s,
        spin: (Math.random() - 0.5) * 12,
        life: life * (0.6 + Math.random() * 0.7),
        max: life,
        size: size * (0.6 + Math.random() * 0.8),
        color: new THREE.Color().setHSL(spread / 360, 0.85, 0.6),
      })
    }
  }

  update(dt: number): void {
    for (let i = this.pool.length - 1; i >= 0; i--) {
      const p = this.pool[i]
      p.life -= dt
      if (p.life <= 0) {
        this.pool.splice(i, 1)
        continue
      }
      p.vy -= 620 * dt
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
      if (p.y < 3) {
        p.y = 3
        p.vy *= -0.32
        p.vx *= 0.7
        p.vz *= 0.7
      }
    }

    for (let i = 0; i < PARTICLE_MAX; i++) {
      const p = this.pool[i]
      if (!p) {
        this.dummy.scale.setScalar(0)
        this.dummy.position.set(0, -9999, 0)
        this.dummy.updateMatrix()
        this.mesh.setMatrixAt(i, this.dummy.matrix)
        continue
      }
      const fade = Math.min(1, p.life / (p.max * 0.5))
      this.dummy.position.set(p.x, p.y, p.z)
      this.dummy.rotation.set(p.x * 0.02 + p.spin, p.z * 0.02, p.spin)
      this.dummy.scale.setScalar(p.size * fade)
      this.dummy.updateMatrix()
      this.mesh.setMatrixAt(i, this.dummy.matrix)
      this.mesh.setColorAt(i, p.color)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }
}

/**
 * Engine smoke and flame for a tank that has been hit.
 *
 * Separate from `Confetti` because the physics are the opposite: confetti is
 * thrown outward and falls, a plume drifts upward and expands. Bending one
 * system to do both would mean a gravity term that is sometimes negative,
 * which is a worse thing to read than sixty lines of its own.
 *
 * Same trick for the fade, though. The pool is opaque and shrinks to nothing
 * rather than going transparent: hundreds of unsorted translucent cubes in one
 * InstancedMesh flicker against each other, and a puff that swells and then
 * collapses reads as smoke perfectly well without any of that.
 */
class Plumes {
  readonly mesh: THREE.InstancedMesh
  private pool: Particle[] = []
  private dummy = new THREE.Object3D()

  constructor() {
    this.mesh = new THREE.InstancedMesh(
      PLUME_GEO,
      // Basic, not standard. A lit material puts the hemisphere light's pale
      // cream on top of every puff, which washes the smoke toward the colour of
      // the sky behind it and takes the heat out of the flame — the two things
      // the plume exists to say. Unlit, a grey puff stays grey against the felt
      // and an orange one stays hot. It is also the cheaper material, on a mesh
      // that redraws 260 instances every frame.
      new THREE.MeshBasicMaterial(),
      PLUME_MAX,
    )
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    this.mesh.frustumCulled = false
    this.mesh.count = PLUME_MAX
    this.dummy.scale.setScalar(0)
    this.dummy.updateMatrix()
    for (let i = 0; i < PLUME_MAX; i++) this.mesh.setMatrixAt(i, this.dummy.matrix)
  }

  /** One puff at a point. `hot` makes it a flame rather than exhaust. */
  puff(x: number, y: number, z: number, hot: boolean): void {
    if (this.pool.length >= PLUME_MAX) this.pool.shift()
    const drift = hot ? 14 : 26
    const shade = hot
      ? new THREE.Color().setHSL((12 + Math.random() * 26) / 360, 1, 0.56 + Math.random() * 0.14)
      : new THREE.Color().setHSL(0, 0, 0.16 + Math.random() * 0.22)
    // Sized against the tank, which is 44 units long and renders about thirty
    // pixels wide from the board camera. The first cut of this used 9-unit
    // cubes at half scale — four world units, under three pixels — and the
    // screenshot showed a spotless tank while every counter in the emitter
    // said it was working perfectly.
    this.pool.push({
      x: x + (Math.random() - 0.5) * 11,
      y: y + (Math.random() - 0.5) * 6,
      z: z + (Math.random() - 0.5) * 11,
      vx: WIND_X + (Math.random() - 0.5) * drift,
      vy: hot ? 96 + Math.random() * 60 : 104 + Math.random() * 62,
      vz: WIND_Z + (Math.random() - 0.5) * drift,
      spin: (Math.random() - 0.5) * 3,
      life: hot ? 0.42 + Math.random() * 0.26 : 1.15 + Math.random() * 0.75,
      max: hot ? 0.68 : 1.9,
      size: hot ? 1.15 + Math.random() * 0.5 : 1.3 + Math.random() * 0.7,
      color: shade,
    })
  }

  update(dt: number): void {
    for (let i = this.pool.length - 1; i >= 0; i--) {
      const p = this.pool[i]
      p.life -= dt
      if (p.life <= 0) {
        this.pool.splice(i, 1)
        continue
      }
      // Rising smoke slows as it cools and spreads as it goes, which is the
      // whole silhouette. No ground bounce: none of these ever go down.
      p.vy *= 1 - Math.min(1, dt * 0.75)
      p.x += p.vx * dt
      p.y += p.vy * dt
      p.z += p.vz * dt
    }

    for (let i = 0; i < PLUME_MAX; i++) {
      const p = this.pool[i]
      if (!p) {
        this.dummy.scale.setScalar(0)
        this.dummy.position.set(0, -9999, 0)
        this.dummy.updateMatrix()
        this.mesh.setMatrixAt(i, this.dummy.matrix)
        continue
      }
      const age = 1 - p.life / p.max
      const collapse = Math.min(1, p.life / (p.max * 0.45))
      this.dummy.position.set(p.x, p.y, p.z)
      this.dummy.rotation.set(p.spin * age * 3, p.spin * age * 2, p.spin * age)
      // Starts at 0.7 rather than 0.45: the board camera renders a 44-unit tank
      // about thirty pixels wide, so a puff that begins at 0.45 of a 21-unit
      // cube is six pixels across for the first third of its life. In a
      // screenshot that is not smoke, it is noise on the felt.
      this.dummy.scale.setScalar(p.size * (0.7 + age * 1.4) * collapse)
      this.dummy.updateMatrix()
      this.mesh.setMatrixAt(i, this.dummy.matrix)
      this.mesh.setColorAt(i, p.color)
    }
    this.mesh.instanceMatrix.needsUpdate = true
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true
  }
}

// ---------------------------------------------------------------- renderer

export class Renderer {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private confetti = new Confetti()
  private plumes = new Plumes()

  private rigs = new Map<string, TankRig>()
  private you = makeTank()

  /**
   * Whether this client's own tank is on screen.
   *
   * Exposed because "a spectator draws no tank" is otherwise unobservable from
   * outside: the rig exists, the simulation steps it, and every structural
   * check on it reads exactly the same as a playing client's. This is the one
   * value that differs, so it is the one worth being able to read.
   */
  get ownTankVisible(): boolean {
    return this.you.root.visible
  }
  /**
   * Where a charging lob would land, drawn flat on the felt.
   *
   * At `GROUND_Y + DECAL_LIFT`, like every other decal in this file, and for a
   * specific reason: the ring under the player's tank and every pickup pad in
   * this game once sat *below* the felt for weeks, drawn on every frame with
   * `visible === true` and never reaching a pixel. Anything flat goes against
   * that constant or it goes into the floor.
   */
  private lobRing = (() => {
    const m = new THREE.Mesh(
      new THREE.RingGeometry(LOB_BLAST - 7, LOB_BLAST, 40),
      new THREE.MeshBasicMaterial({
        color: 0xffb347, transparent: true, opacity: 0.9,
        side: THREE.DoubleSide, depthWrite: false,
        // Drawn through the geometry, unlike every other decal here. The lob
        // exists to go over cover, so the crater is behind a wall or a hedge
        // most times it is used, and a depth-tested ring shows up as a stray
        // arc poking out from behind a bush — the half of it you most need to
        // see is the half the wall is hiding. This is an aiming aid, not a
        // thing in the world.
        depthTest: false,
      }),
    )
    m.rotation.x = -Math.PI / 2
    m.position.y = GROUND_Y + DECAL_LIFT
    m.visible = false
    m.renderOrder = 3
    return m
  })()

  /**
   * The shadow under a lob in the air.
   *
   * The arc is the read: without something on the ground, a shell 150 units up
   * is just a shell drawn slightly higher on the screen, and from the board
   * camera that is indistinguishable from one further away. The shadow is how
   * you know it is going over the wall and not into it.
   */
  private lobShadow = (() => {
    const m = new THREE.Mesh(
      // 16 rather than 10, and darker. The first cut was sized against the
      // shell mesh; what it actually has to be legible against is a board the
      // camera draws from two thousand units back, where ten units is six
      // pixels of grass-on-grass.
      new THREE.CircleGeometry(16, 24),
      new THREE.MeshBasicMaterial({
        color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false,
      }),
    )
    m.rotation.x = -Math.PI / 2
    m.position.y = GROUND_Y + DECAL_LIFT
    m.visible = false
    return m
  })()

  private shells = new Map<string, THREE.Mesh>()
  private shellGeo = new THREE.SphereGeometry(7, 12, 10)
  private siegeGeo = new THREE.SphereGeometry(11, 12, 10)
  private shellMine = new THREE.MeshBasicMaterial({ color: 0xffe8a3 })
  private shellTheirs = new THREE.MeshBasicMaterial({ color: 0xff9a6b })
  /**
   * A siege shell is bigger and angry-red on every screen, not just the
   * shooter's — the damage rides on the fire event, so everybody can see that
   * the thing coming at them takes two hull points instead of one. An
   * unreadable one-shot kill is a bad death; a visible one is a mistake you
   * made.
   */
  private shellSiege = new THREE.MeshBasicMaterial({ color: 0xff5470 })

  private reloadBar: THREE.Mesh
  /** The ground stripe warning that an air strike is walking down this row. */
  private strikeLane: THREE.Mesh
  private lastShellSeen = new Map<string, { x: number; y: number }>()
  private wasDead = new Map<string, boolean>()
  private lastHp = MAX_HP
  private shake = 0
  /** Exponential moving average of frame time, in ms. Drives `degrade()`. */
  private frameMs = 16
  private slowFor = 0
  private quality: 'full' | 'lean' = 'full'
  private clock = new THREE.Clock()
  /** The camera's resting position, before shake is added. */
  private home = new THREE.Vector3()
  private target = new THREE.Vector3(ARENA_W / 2, 0, ARENA_H / 2)
  private aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -AIM_PLANE_Y)
  private raycaster = new THREE.Raycaster()
  /** Scratch camera used to test a candidate framing without disturbing the real one. */
  private probe = new THREE.PerspectiveCamera()
  private view: ViewMode = 'board'
  /** Where the cockpit camera sits and looks this frame, before shake. */
  private eye = new THREE.Vector3()
  private gaze = new THREE.Vector3()
  /**
   * The local tank's hull heading and position as of the last frame drawn.
   *
   * `toWorld` needs both and is called from a mousemove handler that has no
   * game in hand, so the draw loop leaves them here.
   */
  private youHull = 0
  private youAt = new THREE.Vector2(ARENA_W / 2, ARENA_H / 2)
  /** True while a recon sweep (ours or a teammate's) lights enemies up. */
  private reconLit = false
  /** The viewer's declared side while it does, 0 in a free-for-all. */
  private viewerTeam = 0
  /**
   * Where a real npub's kind 0 picture comes from. Injected rather than
   * imported: the renderer has no business knowing what a relay is, and the
   * default keeps every avatar on its initials disc if nobody wires it up.
   */
  private pictures: (pubkey: string | null) => string | null = () => null
  /**
   * Everything the board is made of, in one group.
   *
   * The layout changes every Bitcoin block now, so the scenery has to be
   * throwable-away. Geometries are disposed on the way out — six boards an
   * hour for as long as a tab stays open is exactly the shape of leak that
   * looks fine in a five-minute test.
   */
  private board = new THREE.Group()
  private lastRepairAt = 0
  /** One group per live pickup, keyed by the id the schedule derived. */
  private pickupMeshes = new Map<string, THREE.Group>()
  /**
   * Destructible cover, by `Rect.id`, so a barrel that is gone can come off.
   *
   * Rebuilt with the board. A layout swap replaces every mesh in it, which is
   * why this is cleared in `buildBoard` rather than pruned here — a stale entry
   * would be a mesh belonging to a previous board, holding a reference that
   * `disposeBoard` has already freed.
   */
  private coverMeshes = new Map<number, THREE.Mesh>()
  /**
   * The pile each destructible rect leaves behind, by `Rect.id`.
   *
   * Built with the board and hidden, rather than created when something breaks:
   * merging a geometry mid-round is a few milliseconds inside the one frame
   * where a barrel is already exploding, and that is the worst possible frame
   * to spend them in.
   */
  private rubbleMeshes = new Map<number, THREE.Mesh>()
  /**
   * The tier each destructible mesh is currently painted at, by `Rect.id`.
   *
   * So a frame where the epoch moved for some other reason — one of eight
   * barrels going up — does not rewrite eight materials that already say the
   * right thing.
   */
  private coverPainted = new Map<number, number>()
  /** Last `coverGeneration()` drawn, so the board is only walked when it moves. */
  private coverEpoch = -1

  /** Shared across every mesh of a kind, so `buildBoard` disposes them itself. */
  private coverMats: THREE.MeshStandardMaterial[] = []

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.scene.background = skyTexture()
    // The same warm haze the sky gradient ends on, so the far edge of a
    // 2000-unit board fades into the horizon instead of terminating against it.
    this.scene.fog = new THREE.Fog(0xe2dccc, 4200, 9000)

    this.camera = new THREE.PerspectiveCamera(BOARD_FOV, 1, 60, 8000)
    this.scene.add(this.camera)

    this.scene.add(this.board)
    this.buildBoard()
    onLayoutChange(() => this.buildBoard())
    this.buildLights()
    this.scene.add(this.confetti.mesh)
    this.scene.add(this.plumes.mesh)
    this.scene.add(this.you.root)
    this.you.ring.visible = true


    this.reloadBar = new THREE.Mesh(
      new THREE.BoxGeometry(1, 7, 7),
      new THREE.MeshBasicMaterial({ color: 0xffc44d, depthTest: false }),
    )
    this.reloadBar.renderOrder = 2
    this.reloadBar.visible = false
    this.scene.add(this.reloadBar)

    // A flat stripe the full width of the board, at `GROUND_Y + DECAL_LIFT`
    // like every other decal. The lift is not decoration: the felt is at
    // GROUND_Y and a decal placed at the same height z-fights, or worse, ends
    // up *under* it and is drawn every frame for nobody.
    this.strikeLane = new THREE.Mesh(
      // Exactly the board's width. The first version was ARENA_W + 200 so the
      // ends would not stop short, and the overhang painted an orange smear on
      // the sky either side of the fence — the stripe is a mark on the felt and
      // it has no business outside it.
      new THREE.PlaneGeometry(ARENA_W, 128),
      new THREE.MeshBasicMaterial({
        color: 0xff6a3d,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    this.strikeLane.rotation.x = -Math.PI / 2
    this.strikeLane.visible = false
    this.scene.add(this.strikeLane)
    this.scene.add(this.lobRing)
    this.scene.add(this.lobShadow)

    this.resize()
    window.addEventListener('resize', this.resize)
  }

  // ------------------------------------------------------------- the board

  private buildBoard(): void {
    // Cover materials are shared between meshes, so the per-child dispose below
    // cannot own them — it would dispose the crate material while three more
    // crates still point at it, and it would never touch the canvas textures,
    // which a material does not own either. A layout change every block adds up.
    for (const m of this.coverMats) {
      m.map?.dispose()
      m.bumpMap?.dispose()
      m.dispose()
    }
    this.coverMats = []

    for (const child of [...this.board.children]) {
      this.board.remove(child)
      const mesh = child as THREE.Mesh
      mesh.geometry?.dispose()
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined
      if (Array.isArray(material)) material.forEach((m) => m.dispose())
      else material?.dispose()
    }

    // A slab with a rim, so the arena reads as a physical board sitting in the
    // world rather than as a floor that happens to stop.
    const base = new THREE.Mesh(
      new RoundedBoxGeometry(ARENA_W + RIM * 2, BOARD_DROP, ARENA_H + RIM * 2, 4, 22),
      // Dry earth under the turf, not cream plastic. The slab still reads as a
      // board sitting in the world; it just reads as a piece of ground now.
      toy(0xa8916d, { roughness: 0.95 }),
    )
    base.position.set(ARENA_W / 2, -BOARD_DROP / 2 + 2, ARENA_H / 2)
    base.receiveShadow = true
    this.board.add(base)

    const turf = feltTexture()
    const felt = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA_W, ARENA_H),
      // The same canvas as the bump map, so the grain is lit rather than
      // painted. It is one texture upload and the sun does the rest.
      new THREE.MeshStandardMaterial({ map: turf, bumpMap: turf, bumpScale: 3, roughness: 0.95 }),
    )
    felt.rotation.x = -Math.PI / 2
    felt.position.set(ARENA_W / 2, GROUND_Y, ARENA_H / 2)
    felt.receiveShadow = true
    this.board.add(felt)

    // Chalk sits between the felt and everything else that lies flat, so a
    // pickup ring still draws over a touchline rather than fighting it.
    const chalk = new THREE.Mesh(
      new THREE.PlaneGeometry(ARENA_W, ARENA_H),
      new THREE.MeshBasicMaterial({
        map: chalkTexture(),
        transparent: true,
        depthWrite: false,
      }),
    )
    chalk.rotation.x = -Math.PI / 2
    chalk.position.set(ARENA_W / 2, GROUND_Y + DECAL_LIFT * 0.4, ARENA_H / 2)
    this.board.add(chalk)

    // Cover is what it is made of, and `arena.ts` says which. The board used to
    // decide here, by measuring a rect: near the middle meant the pink cross,
    // square meant a yellow pillar, anything else was a blue L. That worked
    // right up until a layout wanted two different things the same shape, and
    // it put a board's visual identity in the renderer where a level designer
    // could not reach it.
    const mats = coverMaterials()
    this.coverMats = Object.values(mats)

    this.coverMeshes.clear()
    this.rubbleMeshes.clear()
    this.coverPainted.clear()
    // Force the next `syncCover` to walk the new meshes rather than trusting a
    // generation number that belongs to the board we just threw away.
    this.coverEpoch = -1
    for (const w of WALLS) {
      const kind = w.kind ?? 'rock'
      const breakable = w.hp !== undefined && w.id !== undefined
      // A destructible rect gets its *own* material so it can be scorched
      // without dragging every other crate on the board down with it. Six
      // clones on the widest layout, and they go into `coverMats` so
      // `disposeBoard` frees them with the rest.
      const mat = breakable ? mats[kind].clone() : mats[kind]
      if (breakable) this.coverMats.push(mat)
      const mesh = new THREE.Mesh(coverGeometry(w), mat)
      // Only the destructible ones are worth remembering. `syncCover` walks
      // this map rather than all sixty rects, and the map being small is what
      // makes "check the board every frame" not worth avoiding.
      if (breakable) {
        this.coverMeshes.set(w.id!, mesh)
        const rubble = new THREE.Mesh(rubbleGeometry(w), mat)
        rubble.position.set(w.x + w.w / 2, 0, w.y + w.h / 2)
        rubble.castShadow = true
        rubble.receiveShadow = true
        rubble.visible = false
        this.rubbleMeshes.set(w.id!, rubble)
        this.board.add(rubble)
      }
      mesh.position.set(w.x + w.w / 2, 0, w.y + w.h / 2)
      // The fence is the one thing a shadow buys nothing on: it rings the
      // board, so its shadow falls outward onto the rim and off the world.
      mesh.castShadow = kind !== 'fence'
      mesh.receiveShadow = true
      this.board.add(mesh)
    }
  }

  private buildLights(): void {
    // Sky above, grass below. The ground colour is what puts a green bounce on
    // the underside of a tank and on the shaded face of every boulder, and it
    // moved with the turf — a lawn does not bounce mini-golf green.
    this.scene.add(new THREE.HemisphereLight(0xc6d9ea, 0x5f7742, 1.35))

    const sun = new THREE.DirectionalLight(0xfff0d2, 2.15)
    sun.position.set(ARENA_W / 2 + 700, 1500, ARENA_H / 2 - 900)
    sun.target.position.copy(this.target)
    sun.castShadow = true
    // A smaller map on a phone. The board is lit by one directional light and
    // nothing here needs a crisp shadow edge, so this is the cheapest knob
    // there is on the devices most likely to need it.
    const shadowRes = Math.min(window.innerWidth, window.innerHeight) < 720 ? 1024 : 2048
    sun.shadow.mapSize.set(shadowRes, shadowRes)
    const cam = sun.shadow.camera
    cam.left = -1150
    cam.right = 1150
    cam.top = 1150
    cam.bottom = -1150
    cam.near = 200
    cam.far = 4200
    cam.updateProjectionMatrix()
    sun.shadow.bias = -0.0008
    this.scene.add(sun, sun.target)
  }

  /**
   * Frame the whole board, whatever shape the window is.
   *
   * The obvious fit — put the arena's bounding sphere inside the field of view
   * — leaves the board floating in a sea of sky, because a 1600x1200 rectangle
   * seen from an angle is nowhere near as big as the sphere that contains it.
   * So this pulls in until a corner is about to leave the frustum instead:
   * binary search on distance, testing the eight corners of the board's
   * bounding box each time. Thirty iterations on resize, and the board fills
   * the window at every aspect ratio including a portrait phone.
   */
  private resize = (): void => {
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()

    // Looking down the board from slightly "south", tilted well over so the
    // walls have visible sides. Flatter than this and it is the old top-down
    // view with extra steps; steeper and it is the old top-down view exactly.
    const pitch = (51 * Math.PI) / 180
    const dir = new THREE.Vector3(0, Math.sin(pitch), Math.cos(pitch))

    let lo = 400
    let hi = 12000
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2
      if (this.framesBoard(dir, mid)) hi = mid
      else lo = mid
    }

    this.home.copy(this.target).addScaledVector(dir, hi)
    // In cockpit the camera is somewhere else entirely and `draw` will place it
    // this frame. `home` is still computed, so switching back is instant.
    if (this.view === 'board') {
      this.camera.position.copy(this.home)
      this.camera.lookAt(this.target)
    }
  }

  /**
   * Overhead board, or down the barrel.
   *
   * Two things change besides the position. The field of view widens, because
   * the framing fov is chosen to fit a 1600x1200 board on screen and is far too
   * tight to sit inside; and the near plane comes in from 60 to 3, because your
   * own barrel ends about 45 units from your eye and at the board's near plane
   * it is simply not drawn.
   */
  setView(view: ViewMode): void {
    if (view === this.view) return
    this.view = view
    const cockpit = view === 'cockpit'
    this.camera.fov = cockpit ? COCKPIT_FOV : BOARD_FOV
    this.camera.near = cockpit ? 3 : 60
    this.camera.updateProjectionMatrix()
    if (!cockpit) {
      this.camera.position.copy(this.home)
      this.camera.lookAt(this.target)
    }
  }

  get viewMode(): ViewMode {
    return this.view
  }

  /** Hand the renderer a way to look up profile pictures by pubkey. */
  setPictureSource(fn: (pubkey: string | null) => string | null): void {
    this.pictures = fn
  }

  /** True when every corner of the board is inside the frustum at this distance. */
  private framesBoard(dir: THREE.Vector3, dist: number): boolean {
    const probe = this.probe
    // The board fov, not the live one: this answers "how far back does the
    // overhead camera have to be", and asking it through a 76-degree cockpit
    // lens would pull `home` in and frame nothing on the way back.
    probe.fov = BOARD_FOV
    probe.aspect = this.camera.aspect
    probe.near = this.camera.near
    probe.far = this.camera.far
    probe.position.copy(this.target).addScaledVector(dir, dist)
    probe.lookAt(this.target)
    probe.updateProjectionMatrix()
    probe.updateMatrixWorld(true)

    const vFov = (probe.fov * Math.PI) / 180
    // A little headroom, so nothing sits flush against the window edge and the
    // name plate above a corner tank is not clipped.
    const tanV = Math.tan(vFov / 2) * 0.96
    const tanH = tanV * probe.aspect
    const point = new THREE.Vector3()

    // Corners of the board including its underside and the top of the fence.
    for (const x of [-RIM, ARENA_W + RIM]) {
      for (const z of [-RIM, ARENA_H + RIM]) {
        // The playing surface and the fence have to fit; the board's underside
        // is allowed to run off the bottom of the window. Insisting on it cost
        // about a tenth of the board's on-screen size for a slab nobody looks at.
        for (const y of [0, FENCE_H + 40]) {
          point.set(x, y, z).applyMatrix4(probe.matrixWorldInverse)
          const depth = -point.z
          if (depth <= 1) return false
          if (Math.abs(point.x) > depth * tanH) return false
          if (Math.abs(point.y) > depth * tanV) return false
        }
      }
    }
    return true
  }

  /**
   * Screen coordinates to arena coordinates, for mouse aim.
   *
   * The 2D renderer could do this with a divide. Here it is a ray from the
   * camera through the cursor, met with a horizontal plane at turret height —
   * so the cursor lands where it looks like it lands, on top of a tank rather
   * than on the ground somewhere behind it.
   */
  toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1,
    )
    if (this.view === 'cockpit') return this.cockpitAim(ndc.x)
    this.raycaster.setFromCamera(ndc, this.camera)
    const hit = new THREE.Vector3()
    if (!this.raycaster.ray.intersectPlane(this.aimPlane, hit)) {
      return { x: this.target.x, y: this.target.z }
    }
    return { x: hit.x, y: hit.z }
  }

  /**
   * The other direction: a world point to a CSS pixel on this canvas.
   *
   * Added for the damage suite, which has to look at the actual pixels behind
   * a burning tank rather than at a count of how many puffs were spawned. A
   * particle emitter is exactly the kind of thing a counter cannot vouch for
   * — this game has already shipped meshes that were `visible = true` every
   * frame and drawn inside the board, where they never reached a pixel — so
   * the check needs to know where on screen to look.
   *
   * Null when the point is behind the camera, which is the honest answer
   * rather than the mirrored nonsense a raw projection returns there.
   */
  toScreen(x: number, y: number, z: number): { x: number; y: number } | null {
    const v = new THREE.Vector3(x, y, z)
    this.camera.updateMatrixWorld()
    v.project(this.camera)
    if (v.z > 1) return null
    const r = this.canvas.getBoundingClientRect()
    return {
      x: r.left + ((v.x + 1) / 2) * r.width,
      y: r.top + ((1 - v.y) / 2) * r.height,
    }
  }

  /**
   * Where the cursor points when you are sitting in the turret.
   *
   * The horizontal plane the board camera raycasts against is useless here: an
   * eye at height 50 looking a few degrees below level meets a plane at height
   * 22 hundreds of metres away, and meets it *behind* the camera the moment you
   * look up. So the cursor is read as an angle instead of a point.
   *
   * That angle is measured **from the hull, never from the camera.** The
   * cockpit camera yaws with the gun, so measuring the cursor against the
   * camera's own yaw is a feedback loop with no fixed point: a cursor held even
   * slightly off centre turns the turret, which turns the camera, which leaves
   * the cursor exactly as far off centre as it was. The turret spins until you
   * re-centre the mouse. The hull does not move because you moved the mouse,
   * which is what makes it the stable reference — and it is also the honest
   * one, because a real turret's traverse is a bearing relative to the vehicle.
   *
   * The far distance is arbitrary; `Input` only takes an `atan2` of it. It is
   * large enough that the tank's own movement between two mouse events does not
   * visibly bend the angle.
   */
  private cockpitAim(ndcX: number): { x: number; y: number } {
    const offset = Math.max(-1, Math.min(1, ndcX)) * AIM_ARC
    const angle = this.youHull + offset
    return {
      x: this.youAt.x + Math.cos(angle) * 4000,
      y: this.youAt.y + Math.sin(angle) * 4000,
    }
  }

  // -------------------------------------------------------------- the frame

  /**
   * `localSessions` names the tanks belonging to somebody sitting in this room.
   *
   * In local two-player the second player is an ordinary peer of the first —
   * same events, same interpolation — so without this they would render as a
   * stranger and go looking for a ring that is under the other player's tank.
   */
  draw(game: Game, localSessions?: ReadonlySet<string>): void {
    const dt = Math.min(0.05, this.clock.getDelta())
    const now = performance.now()

    this.syncPeers(game)
    // Left here for `toWorld`, which runs from a mousemove handler with no game
    // in hand and needs the hull to measure the cockpit aim arc against.
    this.youHull = game.tank.hull
    this.youAt.set(game.tank.x, game.tank.y)
    // Once per frame, not per rig: whether a sweep is lighting enemies up for
    // this viewer, and which side counts as "ours" while it is.
    this.reconLit = game.reconSees(now)
    this.viewerTeam = game.team
    const maxHp = game.maxHp
    this.applyTank(this.you, dt, now, {
      x: game.tank.x,
      y: game.tank.y,
      hull: game.tank.hull,
      gun: game.tank.gun,
      hp: game.tank.hp,
      maxHp,
      ammo: game.tank.reloadingUntil ? 0 : game.tank.ammo,
      held: game.earned.length,
      shield: hasBuff(game.buffs, 'shieldUntil', now),
      dead: game.tank.dead,
      hue: game.displayColor,
      name: game.name,
      picture: this.pictures(game.identity.isGuest ? null : game.identity.pubkey),
      verified: true,
      streak: game.streak,
      skin: game.skin,
      mine: true,
      team: game.team,
      ourTeam: game.team,
    }, true)
    // A spectator's tank exists in the simulation — it is where the board
    // camera and `toWorld` measure from — but it must never reach a pixel.
    // Everything under `this.you` comes off together, including the ring, the
    // plate and the driver, because half a hidden tank is a ghost.
    //
    // Same for a player in the chopper. The tank is out of play for those ten
    // seconds — it cannot be shot and it is not collided with — so leaving it
    // parked on the board would put a target on screen that nothing can hit,
    // which is worse than showing nothing.
    this.you.root.visible = !game.watching && !game.flying

    for (const peer of game.peers.values()) {
      const rig = this.rigs.get(peer.session)
      if (!rig) continue
      // Flying: `syncChoppers` draws them instead, and their `x`/`y` are the
      // gunship rather than the tank — so leaving the tank on would put a
      // second, wrong copy of them on the board directly under the first.
      if (peer.view.chopperUntil > now) {
        rig.root.visible = false
        continue
      }
      rig.root.visible = true
      this.applyTank(rig, dt, now, {
        x: peer.view.x,
        y: peer.view.y,
        hull: peer.view.hull,
        gun: peer.view.gun,
        hp: peer.view.hp,
        held: peer.view.held,
        maxHp,
        ammo: peer.view.ammo,
        shield: peer.view.shield,
        dead: peer.view.dead,
        hue: peer.displayColor,
        name: peer.name,
        picture: this.pictures(peer.pubkey),
        verified: peer.pubkey !== null || peer.bot === true,
        streak: peer.streak,
        skin: peer.skin,
        mine: localSessions?.has(peer.session) ?? false,
        team: peer.view.team,
        ourTeam: game.team,
      })
    }

    this.strikes(game, now)
    this.syncShells(game)
    this.syncLobAim(game)
    this.syncPickups(game, now)
    if (!game.watching) {
      this.deaths(game)
      this.reload(game, now)
    } else {
      this.reloadBar.visible = false
    }

    // Shield bubble and overdrive trail. Both have to be legible to the other
    // three players, not just to you — knowing who is currently hard to kill is
    // most of what makes a pickup worth contesting.
    // Everything you are wearing comes off in the cockpit. The name plate and
    // the hull pips are sprites a few units from the near plane and would fill
    // the screen; the shield bubble is a translucent sphere the camera sits
    // *inside*, which is a blue wash over the whole board rather than a bubble.
    // The HUD already says all three things in words.
    const cockpit = this.view === 'cockpit'
    if (cockpit) {
      this.you.label.visible = false
      this.you.driver.visible = false
      this.you.ring.visible = false
      for (const part of this.you.domeParts) part.visible = false
      for (const pip of this.you.pips) pip.visible = false
      // The reload bar belongs on this list and was missing from it, which is
      // the "yellow box when I shoot" Puzz reported. It is an unlit `#ffc44d`
      // box at the tank's own position with `depthTest: false`, so from inside
      // the tank it is a few units from the near plane and painted over every
      // other pixel — a flat orange square stuck to the screen for the whole
      // 1.05s reload. Correct and useful from the board camera, meaningless
      // from the hatch. `reload()` has already run this frame and turned it on,
      // so this has to come after it. The cockpit says the same thing on the
      // crosshair instead — see `paintCrosshair` in main.ts.
      this.reloadBar.visible = false
    }
    // No `else`: `applyTank` runs before this every frame and has already put
    // every one of them back the way board view wants them.

    // `applyTank` has already put your own bubble up if you are shielded. From
    // inside the cockpit it is a sphere the camera sits within, which paints
    // the whole board blue rather than reading as a bubble, so it comes off
    // with everything else you are wearing. The HUD chip still says it in
    // words and counts the seconds down.
    if (cockpit) this.you.bubble.visible = false
    if (hasBuff(game.buffs, 'speedUntil', now) && !game.tank.dead) {
      this.confetti.burst(game.tank.x, game.tank.y, 1, 285, {
        speed: 24,
        up: 40,
        y: 10,
        size: 0.45,
        life: 0.4,
      })
    }
    if (game.tank.hp < this.lastHp && !game.tank.dead) this.shake = Math.max(this.shake, 9)
    this.lastHp = game.tank.hp

    // Green, and rising rather than scattering, so a repair never reads as an
    // explosion. Same particle pool, different physics.
    if (game.repairedAt > this.lastRepairAt) {
      this.lastRepairAt = game.repairedAt
      this.confetti.burst(game.tank.x, game.tank.y, 18, 130, {
        speed: 60,
        up: 300,
        y: 30,
        size: 0.8,
        life: 1.0,
      })
    }

    this.syncCover(game, now)
    this.syncChoppers(game, now)
    this.syncFlags(game, now)
    this.syncTerritory(game, now)

    if (cockpit) this.placeEye(game)

    this.confetti.update(dt)
    this.plumes.update(dt)
    this.applyShake(dt)
    this.renderer.render(this.scene, this.camera)
    this.degrade(dt)
  }

  /**
   * Give up the expensive things on a device that cannot afford them.
   *
   * This is not only about looks. `main.ts` clamps the simulation step to 50ms
   * so a backgrounded tab cannot teleport everybody on return — which means a
   * client rendering at 5fps also *simulates* at a quarter speed, and its tank
   * crawls while everyone else's moves normally. Shadows are by far the most
   * expensive thing on the board and the least load-bearing, so they go first,
   * followed by the pixel ratio.
   *
   * One way only. A renderer that flips back and forth every few seconds looks
   * worse than one that settled on lean and stayed there.
   */
  private degrade(dt: number): void {
    if (this.quality === 'lean') return
    this.frameMs += (Math.min(500, dt * 1000) - this.frameMs) * 0.08
    this.slowFor = this.frameMs > 30 ? this.slowFor + dt : 0
    if (this.slowFor < 1.5) return
    this.quality = 'lean'
    this.renderer.shadowMap.enabled = false
    this.renderer.setPixelRatio(1)
    this.resize()
  }

  /** 'full' until the frame budget says otherwise. Read by the smoke test. */
  get renderQuality(): 'full' | 'lean' {
    return this.quality
  }

  /** Create a rig for anyone new, drop the rig of anyone who left. */
  private syncPeers(game: Game): void {
    for (const peer of game.peers.values()) {
      if (this.rigs.has(peer.session)) continue
      const rig = makeTank()
      this.scene.add(rig.root)
      this.rigs.set(peer.session, rig)
    }
    for (const [session, rig] of this.rigs) {
      if (game.peers.has(session)) continue
      this.scene.remove(rig.root)
      this.disposeRig(rig)
      this.rigs.delete(session)
      this.wasDead.delete(session)
    }
  }

  /**
   * `eye` marks the one rig the cockpit camera is sitting inside. Everything a
   * tank wears has to come off for that rig in cockpit view, and the plume is
   * the one piece of it that is not a child of the rig — see `wear`.
   */
  private applyTank(rig: TankRig, dt: number, now: number, v: TankView, eye = false): void {
    const { x, y, hull, gun, hp, dead, hue, name, verified } = v
    rig.root.position.set(x, 0, y)
    rig.hull.rotation.y = -hull
    rig.turret.rotation.y = -gun

    // setHSL, not setStyle: three's CSS parser only accepts the comma form of
    // hsl(), so `hsl(190 78% 58%)` silently fails to parse and leaves the
    // material white — every tank came out the same colour.
    if (dead) {
      rig.body.color.setHex(0x57606e)
      rig.trim.color.setHex(0x3a4049)
      rig.body.emissive.setHex(0x000000)
    } else {
      applySkin(rig, SKINS[v.skin] ?? SKINS[DEFAULT_SKIN], hue)
      this.wear(rig, v, now, dt, eye && this.view === 'cockpit')
    }

    if (dead) rig.smokeOwed = 0

    // A dead tank tips over and sinks rather than vanishing, so you can see
    // where somebody went down without needing a marker for it.
    const ease = Math.min(1, dt * 6)
    rig.sink += ((dead ? -14 : 0) - rig.sink) * ease
    rig.bob.rotation.z += ((dead ? 0.5 : 0) - rig.bob.rotation.z) * ease

    // Idle bounce, plus the recoil kick. Both cost nothing and they are most of
    // why the thing reads as a toy rather than as untextured geometry.
    rig.bob.position.y = rig.sink + (dead ? 0 : Math.sin(now / 240 + x * 0.02) * 1.6)
    rig.recoil = Math.max(0, rig.recoil - dt * 5)
    // Along the barrel, not along world x — the turret group's own rotation is
    // applied after its position, so the offset has to be rotated by hand.
    rig.turret.position.set(-Math.cos(gun) * rig.recoil * 6, 28, -Math.sin(gun) * rig.recoil * 6)
    const flashMat = rig.flash.material as THREE.MeshBasicMaterial
    flashMat.opacity = rig.recoil
    rig.flash.visible = rig.recoil > 0.02
    rig.flash.scale.setScalar(0.7 + rig.recoil * 0.8)

    // Cheap on repeat: `set` compares a key before it touches a canvas.
    rig.avatar.set(name, v.picture, hue)
    // The face is a child of `driver`, so hiding the driver hides it too.
    rig.driver.visible = !dead
    for (const part of rig.domeParts) part.visible = true

    // The empty magazine is part of the key, so the plate is rebuilt when a tank
    // runs dry and again when it reloads. That is two 512x128 canvases per
    // magazine cycle per tank — about one a second in a full four-tank room —
    // which is why the *previous* texture is disposed rather than left to the
    // collector.
    const magEmpty = !dead && v.ammo <= 0
    const key = `${name}|${hue}|${verified}|${magEmpty}|${v.held}`
    if (rig.labelKey !== key) {
      rig.labelKey = key
      const material = rig.label.material as THREE.SpriteMaterial
      material.map?.dispose()
      material.map = labelTexture(name, hue, verified, magEmpty, v.held)
      material.needsUpdate = true
    }
    rig.label.visible = !dead

    // Glass Cannon narrows the hull to one point, so the extra pips are not
    // drawn at all and the remaining ones re-centre. Three pips with two
    // permanently dark would read as damage rather than as the round's rules.
    for (let i = 0; i < rig.pips.length; i++) {
      const pip = rig.pips[i]
      pip.visible = !dead && i < v.maxHp
      pip.position.x = (i - (v.maxHp - 1) / 2) * 19
      const material = pip.material as THREE.MeshStandardMaterial
      if (i < hp) {
        material.color.setHSL(hue / 360, 0.85, 0.62)
        material.emissive.setHSL(hue / 360, 0.85, 0.22)
      } else {
        material.color.setHex(0x38404d)
        material.emissive.setHex(0x000000)
      }
      pip.rotation.y = now / 900 + i
    }

    // The streak glow. Yours is always on — it is how you find yourself in a
    // four-way scramble — and a rival's only lights up once they are on three,
    // which is the whole point of putting the streak on the wire: the room can
    // see who to gang up on without anyone opening a scoreboard.
    // Everyone's shield, not just yours. `draw` takes your own back off again
    // in cockpit view, where you are inside the sphere.
    rig.bubble.visible = !dead && v.shield
    if (rig.bubble.visible) rig.bubble.scale.setScalar(1 + Math.sin(now / 180) * 0.04)

    // The recon ping. Never on yourself — you know where you are — and never
    // on a teammate: the sweep marks the *enemy*, and in a free-for-all
    // everybody who is not you is one. Spins and bobs so it reads as a live
    // sweep rather than as scenery that happens to float.
    rig.ping.visible = this.reconLit && !eye && !dead &&
      (this.viewerTeam === 0 || v.team !== this.viewerTeam)
    if (rig.ping.visible) {
      rig.ping.rotation.y = now / 300
      rig.ping.position.y = 108 + Math.sin(now / 200) * 5
    }

    const ringMat = rig.ring.material as THREE.MeshBasicMaterial
    const hot = v.streak >= 3
    // A ring on a teammate, so "can I shoot this" is answerable at a glance
    // rather than by reading a name plate. Not on an enemy: a mark on everybody
    // is a mark on nobody, and the tank without one is the one you shoot.
    const friend = v.ourTeam > 0 && v.team === v.ourTeam && !v.mine
    rig.ring.visible = !dead && (v.mine || hot || friend)
    if (hot) {
      ringMat.color.setHSL(((now / 12) % 360) / 360, 0.9, 0.6)
      ringMat.opacity = 0.85
      rig.ring.scale.setScalar(1.15 + Math.sin(now / 140) * 0.08)
    } else if (friend) {
      // Green rather than the side's own colour. The question the ring answers
      // is binary — friend or not — and five shades of ring would put the
      // player back to matching hues under fire.
      ringMat.color.setHex(0x6ee7a0)
      ringMat.opacity = 0.8
      rig.ring.scale.setScalar(1.1)
    } else {
      ringMat.color.setHex(0xffffff)
      ringMat.opacity = 0.55
      rig.ring.scale.setScalar(1)
    }
  }

  /**
   * How beaten up a tank looks, from the HP that was already on the wire.
   *
   * Three states, and the thresholds are ratios rather than counts because
   * Glass Cannon rounds change the hull maximum. A one-hull tank is never
   * "damaged" — every hit kills it — so it never scorches and never smokes,
   * which is correct rather than a gap.
   *
   *   scorched  the paint darkens the moment anything lands
   *   smoking   any damage at all: grey exhaust off the engine deck
   *   burning   one hit from dead: flame, black smoke, and a glowing hull
   *
   * Smoke starts at the first hit rather than at half hull, because this game
   * has exactly two hull sizes: the standard three and Glass Cannon's one.
   * At three hull, "at or below half" is hp 1 — which is already the burning
   * tier — so a half-hull threshold reads beautifully and describes a state no
   * round of this game can ever be in. The rate carries the gradient instead:
   * a wisp at 2/3, a column at 1/3.
   *
   * The point of the last one is that it is readable from across the arena.
   * Knowing which of the three tanks in front of you dies to one more shell is
   * the difference between picking a fight and picking the right fight, and
   * until now the only place that lived was three small pips over a tank the
   * board camera renders forty units tall.
   *
   * The plume comes off the **rear deck**, not off the roof. There is no clear
   * air above a tank in this game — the driver's head, the hull pips and the
   * name plate stack from y=7 to y=133 — so smoke drawn straight up would
   * spend its life behind three sprites. Behind the hull it is against felt.
   *
   * `inside` is set for the tank the cockpit camera is sitting in, and it takes
   * the plume and the fire glow off. This is not a nicety. The rear deck is 20
   * units behind the hull; the eye is at y=50, `EYE_BACK` units back along the
   * barrel, near plane 3 — so a burning tank in first person spawns 46 puffs a
   * second directly into its own lens. Photographed, the whole 1280x800 frame
   * was cream and orange with one corner of green felt showing: not "hard to
   * see through", *no board at all*. Puzz reported it as "the damaged tanks UI
   * in first person is too much cant see", which is exactly what the picture
   * shows.
   *
   * The information does not get dropped, it moves to where a cockpit can carry
   * it — `paintDamage` in main.ts puts the same three tiers on the screen edges,
   * the same way this view already replaced the ground reload bar with a bloom
   * on the reticle. Other tanks keep every bit of their smoke: reading which of
   * the three in front of you dies to one more shell is the whole feature, and
   * none of them are inside your lens.
   */
  /**
   * Barrels that have been shot away, and the bang when one goes.
   *
   * Gated on `coverGeneration()` so the common frame — nothing destroyed —
   * costs one integer compare. The blast list is walked every frame because it
   * is almost always empty and each entry is claimed once by timestamp; a
   * generation cannot carry it, because two barrels can go in the same frame
   * and a counter would only say "something changed".
   */
  private syncCover(game: Game, now: number): void {
    void now
    const epoch = coverGeneration()
    if (epoch !== this.coverEpoch) {
      this.coverEpoch = epoch
      for (const [id, mesh] of this.coverMeshes) {
        const rect = WALLS[id]
        const broken = !!rect?.gone
        mesh.visible = !broken
        const rubble = this.rubbleMeshes.get(id)
        if (rubble) rubble.visible = broken
        const tier = rect ? damageTier(rect) : 0
        if (this.coverPainted.get(id) !== tier) {
          this.coverPainted.set(id, tier)
          this.paintDamage(mesh, tier)
        }
      }
    }
    for (const blast of game.coverBlasts) {
      if (blast.at <= this.lastCoverBlast) continue
      this.lastCoverBlast = blast.at
      // A barrel goes up; a crate comes apart. Orange and upward for the first,
      // timber-coloured and outward for the second — the two are the difference
      // between "stand back" and "the lane is open", and a crate that broke in
      // a fireball would say the wrong one.
      const fire = blast.fire
      this.confetti.burst(
        blast.x,
        blast.y,
        blast.loud ? (fire ? 26 : 20) : 10,
        fire ? 28 : 32,
        fire
          ? { speed: 150, up: 220, y: 26, size: 1.1, life: 0.75 }
          : { speed: 190, up: 90, y: 18, size: 0.95, life: 0.6 },
      )
      if (fire) {
        for (let i = 0; i < (blast.loud ? 14 : 6); i++) {
          this.plumes.puff(
            blast.x + (Math.random() - 0.5) * 46,
            20 + Math.random() * 60,
            blast.y + (Math.random() - 0.5) * 46,
            i < 6,
          )
        }
      }
      if (blast.loud) this.shake = Math.max(this.shake, fire ? 14 : 7)
    }
  }

  /** Timestamp of the last barrel blast drawn, so each one is claimed once. */
  private lastCoverBlast = 0

  /** One pole per side that has somebody on it, by team index. */
  private flagPoles = new Map<number, FlagRig>()

  /** One marker per capture point, by index. Built when a board first has them. */
  private pointRings = new Map<number, PointRig>()

  /**
   * Capture points on the felt, coloured by whoever owns them.
   *
   * Two rings: the outer one is the point and never moves, the inner one is the
   * capture in progress and sweeps as it fills. A player standing on a point
   * needs to know two things without looking away from the fight — whose it is,
   * and how close the other side is to taking it — and a ring that grows says
   * the second one without a number.
   */
  private syncTerritory(game: Game, now: number): void {
    const live = game.pointsOn ? game.territory : []
    for (const [i, rig] of this.pointRings) {
      if (i < live.length) continue
      this.scene.remove(rig.root)
      disposePoint(rig)
      this.pointRings.delete(i)
    }
    for (let i = 0; i < live.length; i++) {
      const { point, state } = live[i]
      let rig = this.pointRings.get(i)
      if (!rig) {
        rig = makePoint()
        this.scene.add(rig.root)
        this.pointRings.set(i, rig)
      }
      rig.root.position.set(point.x, GROUND_Y + DECAL_LIFT, point.y)

      const ownerHue = state.owner ? (TEAM_HUE[state.owner] ?? 0) : null
      const outer = rig.outer.material as THREE.MeshBasicMaterial
      if (ownerHue === null) {
        outer.color.setHex(0xd7dde8)
        outer.opacity = 0.3
      } else {
        outer.color.setHSL((ownerHue % 360) / 360, 0.78, 0.58)
        outer.opacity = 0.6
      }

      // The fill. Scaled from the middle outward so "nearly taken" reads as a
      // disc closing on the ring rather than as a colour getting slightly
      // stronger, which nobody can judge mid-fight.
      const taking = state.taking
      rig.fill.visible = taking > 0 && state.progress > 0
      if (rig.fill.visible) {
        const fillMat = rig.fill.material as THREE.MeshBasicMaterial
        fillMat.color.setHSL(((TEAM_HUE[taking] ?? 0) % 360) / 360, 0.8, 0.6)
        fillMat.opacity = 0.34 + Math.abs(Math.sin(now / 180)) * 0.16
        rig.fill.scale.setScalar(Math.max(0.05, Math.min(1, state.progress / CAPTURE_S)))
      }
    }
  }

  /**
   * Bases on the felt, and the flag on whoever is running with it.
   *
   * Drawn from exactly what the rules read — `baseFor` for the position and
   * `flagCarriers` for who has it — rather than from a second copy. A base with
   * its flag home shows the cloth on the pole; a base whose flag is out shows a
   * bare pole and a ring, which is the thing a defender is looking for.
   */
  private syncFlags(game: Game, now: number): void {
    // Only sides that have a base, and only in a flag round.
    //
    // The mode gate is not decoration: `syncFlags` drew a pole for every side
    // with somebody on it, so a *domination* round came up with flag poles
    // standing next to the capture points — promising a flag that `canTake`
    // will never hand over, in a mode that has no flags in it. Photographed
    // before it was noticed, which is the only way that kind of thing gets
    // noticed.
    //
    // A fifth side has no base either — see `FLAG_TEAMS`.
    const teams = new Set<number>()
    if (!game.flagsOn) {
      for (const [team, rig] of this.flagPoles) {
        this.scene.remove(rig.root)
        disposeFlag(rig)
        this.flagPoles.delete(team)
      }
      this.carriedOn(this.you, 0, now)
      for (const peer of game.peers.values()) {
        const rig = this.rigs.get(peer.session)
        if (rig) this.carriedOn(rig, 0, now)
      }
      return
    }
    if (game.team && game.team <= FLAG_TEAMS) teams.add(game.team)
    for (const peer of game.peers.values()) {
      if (peer.view.team && peer.view.team <= FLAG_TEAMS) teams.add(peer.view.team)
    }

    for (const [team, rig] of this.flagPoles) {
      if (teams.has(team)) continue
      this.scene.remove(rig.root)
      disposeFlag(rig)
      this.flagPoles.delete(team)
    }

    const held = game.flagCarriers(now)
    for (const team of teams) {
      const base = baseFor(team)
      if (!base) continue
      let rig = this.flagPoles.get(team)
      if (!rig) {
        rig = makeFlag(TEAM_HUE[team] ?? 0)
        this.scene.add(rig.root)
        this.flagPoles.set(team, rig)
      }
      rig.root.position.set(base.x, 0, base.y)
      const out = held.has(team)
      rig.cloth.visible = !out
      // The ring is the "this flag is out" mark, and it pulses so it reads from
      // across the arena — a defender needs to know their base is empty without
      // driving to it.
      const ringMat = rig.ring.material as THREE.MeshBasicMaterial
      ringMat.opacity = out ? 0.5 + Math.abs(Math.sin(now / 260)) * 0.35 : 0.28
      rig.ring.scale.setScalar(out ? 1 + Math.sin(now / 300) * 0.05 : 1)
      rig.cloth.rotation.y = Math.sin(now / 420) * 0.25
    }

    // And the flag on the tank carrying it. Parented to the rig so it inherits
    // the bob and the sink rather than needing its own copy of either.
    const carried = new Map<string, number>()
    for (const [flag, who] of held) carried.set(who, flag)
    const own = carried.get(game.identity.sessionPubkey)
    this.carriedOn(this.you, own ?? 0, now)
    for (const peer of game.peers.values()) {
      const rig = this.rigs.get(peer.session)
      if (rig) this.carriedOn(rig, carried.get(peer.session) ?? 0, now)
    }
  }

  /** Put a flag on a tank, or take it off. */
  private carriedOn(rig: TankRig, flag: number, now: number): void {
    if (!flag) {
      if (rig.flag) rig.flag.visible = false
      return
    }
    if (!rig.flag) {
      rig.flag = makeCarried()
      rig.bob.add(rig.flag)
    }
    rig.flag.visible = true
    const mat = (rig.flag.children[1] as THREE.Mesh).material as THREE.MeshStandardMaterial
    mat.color.setHSL(((TEAM_HUE[flag] ?? 0) % 360) / 360, 0.74, 0.55)
    rig.flag.rotation.y = Math.sin(now / 300) * 0.3
  }

  /**
   * One rig per chopper in the air, by owner.
   *
   * Built on demand and kept: a ten-second reward that arrives once every ten
   * kills does not deserve a pool, and rebuilding the geometry each time it is
   * earned would hitch the frame it lands on — which is the frame the player is
   * looking at hardest.
   */
  private choppers = new Map<string, ChopperRig>()

  /**
   * Draw every gunship anybody can see, and the ground under the ones shooting.
   *
   * Reads the same two numbers everybody else reads off the tick — where it is
   * and where its rounds are landing. Nothing here is told; a client that can
   * see the tick can draw the chopper, and a client that cannot, cannot, which
   * is the same visibility rule as a tank.
   */
  private syncChoppers(game: Game, now: number): void {
    const live = new Map<string, { x: number; y: number; at: { x: number; y: number } | null; hue: number; mine: boolean }>()
    if (game.flying) {
      live.set(game.identity.sessionPubkey, {
        x: game.chopper.x,
        y: game.chopper.y,
        at: game.chopperAt,
        hue: game.displayColor,
        mine: true,
      })
    }
    for (const peer of game.peers.values()) {
      if (peer.view.chopperUntil <= now) continue
      live.set(peer.session, {
        x: peer.view.x,
        y: peer.view.y,
        at: peer.view.chopperAt,
        hue: peer.displayColor,
        mine: false,
      })
    }

    for (const [key, rig] of this.choppers) {
      if (live.has(key)) continue
      this.scene.remove(rig.root)
      disposeChopper(rig)
      this.choppers.delete(key)
    }

    for (const [key, c] of live) {
      let rig = this.choppers.get(key)
      if (!rig) {
        rig = makeChopper(c.hue)
        this.scene.add(rig.root)
        this.choppers.set(key, rig)
      }
      rig.root.position.set(c.x, CHOPPER_ALT, c.y)
      // Rotor. Fast enough to blur into a disc at any frame rate this game
      // runs at, which is the whole reason a helicopter reads as a helicopter.
      rig.rotor.rotation.y = (now / 26) % (Math.PI * 2)
      // A little bank in the direction of travel, from the position delta
      // rather than from a heading — the chopper has no facing of its own and
      // this is the only thing on screen that says which way it is going.
      const dx = c.x - rig.wasX
      const dz = c.y - rig.wasZ
      rig.wasX = c.x
      rig.wasZ = c.y
      rig.body.rotation.z = Math.max(-0.42, Math.min(0.42, -dx * 0.05))
      rig.body.rotation.x = Math.max(-0.42, Math.min(0.42, dz * 0.05))

      // The mark on the felt directly beneath it, so three hundred units of
      // altitude is legible on a board where nothing else leaves the ground.
      rig.shadow.position.set(0, GROUND_Y + DECAL_LIFT - CHOPPER_ALT, 0)

      const at = c.at
      rig.beam.visible = !!at
      rig.splash.visible = !!at
      if (at) {
        // The rounds, as one cone from the gun to the ground. Cheaper than
        // tracers and, at this scale, more legible: what a player underneath
        // needs to read in a quarter of a second is *where*, not how many.
        //
        // Built in the rig's local space and oriented with a quaternion rather
        // than with `lookAt`. `lookAt` takes a **world** point, and this mesh is
        // a child of a group that has already been moved to the chopper — the
        // first cut passed it world coordinates after setting a local position
        // and the beam pointed off into the sky. It photographed as nothing at
        // all, which is how a missing effect usually looks.
        const dxx = at.x - c.x
        const dzz = at.y - c.y
        const dir = new THREE.Vector3(dxx, -CHOPPER_ALT + GROUND_Y, dzz)
        const len = dir.length()
        rig.beam.position.set(dxx / 2, (-CHOPPER_ALT + GROUND_Y) / 2, dzz / 2)
        rig.beam.quaternion.setFromUnitVectors(UP, dir.normalize())
        // The geometry is one unit tall, so the scale *is* the length.
        rig.beam.scale.set(1, len, 1)
        // Flicker, so it reads as a gun rather than as a laser.
        const mat = rig.beam.material as THREE.MeshBasicMaterial
        mat.opacity = 0.34 + Math.abs(Math.sin(now / 40)) * 0.34

        rig.splash.position.set(dxx, GROUND_Y + DECAL_LIFT - CHOPPER_ALT, dzz)
        rig.splash.scale.setScalar(1 + Math.sin(now / 90) * 0.06)
        // Sparks where it lands, on the ground, in world space — the pool is
        // not a child of the rig.
        if (Math.random() < 0.5) {
          this.confetti.burst(at.x, at.y, 2, 30, { speed: 90, up: 70, y: 8, size: 0.5, life: 0.28 })
        }
      }
    }
  }

  /**
   * Paint one piece of cover at a damage tier.
   *
   * Three things move together, because any one of them alone is ambiguous on
   * a board seen from this far away: it gets darker (soot), rougher (the
   * finish comes off), and it *settles* — sinking and leaning a little more
   * with each tier. The lean is what makes the difference readable in a
   * silhouette, which is how you see a crate you are driving past rather than
   * one you are staring at.
   *
   * The base colour is read off the material the first time and kept in
   * `userData`, so this is idempotent: painting tier 2 twice is the same as
   * painting it once, and painting tier 0 after tier 3 puts the crate back
   * exactly as it was. `resetCover` at a round boundary depends on that.
   */
  private paintDamage(mesh: THREE.Mesh, tier: number): void {
    const mat = mesh.material as THREE.MeshStandardMaterial
    const store = mat.userData as { baseColor?: THREE.Color; baseRough?: number }
    if (!store.baseColor) {
      store.baseColor = mat.color.clone()
      store.baseRough = mat.roughness
    }
    const t = Math.max(0, Math.min(DAMAGE_TIERS, tier)) / DAMAGE_TIERS
    mat.color.copy(store.baseColor).multiplyScalar(1 - 0.34 * t)
    mat.roughness = Math.min(1, (store.baseRough ?? 0.8) + 0.18 * t)
    mesh.position.y = -WALL_H * 0.12 * t
    mesh.rotation.z = 0.055 * t
    mesh.rotation.x = -0.03 * t
  }

  /**
   * The mesh for a piece of destructible cover, by `Rect.id`.
   *
   * Exists for test/barrels-browser.mjs, and it is the right thing to expose:
   * the claim worth checking is not "the rect says gone", it is that the mesh
   * left the board. This codebase has shipped meshes that were `visible = true`
   * on every frame for weeks while drawn inside the floor, and no assertion
   * about game state could have told the difference.
   */
  coverMeshAt(id: number): THREE.Mesh | null {
    return this.coverMeshes.get(id) ?? null
  }

  /**
   * What the last frame actually cost the GPU, and what is resident.
   *
   * Exists because `npm run profile` needs it, and it is added in the same
   * change as the thing that reads it — a counter nobody displays is not an
   * instrument, and this repo has had two of those sitting wired up and unread
   * for days.
   *
   * Draw calls and triangles are the honest half of a profile taken on a
   * software rasteriser: they are the same numbers a real GPU would be handed,
   * where milliseconds under swiftshader are not.
   */
  stats(): {
    calls: number
    triangles: number
    lines: number
    points: number
    geometries: number
    textures: number
    programs: number
  } {
    const info = this.renderer.info
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      lines: info.render.lines,
      points: info.render.points,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
    }
  }

  /**
   * The pile a broken piece leaves behind, by `Rect.id`.
   *
   * Same reasoning as `coverMeshAt`, and the same trap on the other side of it:
   * "the rubble mesh exists" is not the claim either — test/rubble.mjs measures
   * its bounding box, because a pile that is secretly as tall as the crate it
   * replaced is a wall, and a pile with no geometry in it is nothing at all.
   */
  rubbleMeshAt(id: number): THREE.Mesh | null {
    return this.rubbleMeshes.get(id) ?? null
  }

  /**
   * The gunship rig for an owner, or null. For test/chopper-browser.mjs.
   *
   * Same reasoning as `coverMeshAt`: what is worth checking is not that the
   * game thinks somebody is flying, it is that a mesh exists, is above the
   * board, and projects onto the screen.
   */
  chopperRigAt(owner: string): { root: THREE.Object3D } | null {
    return this.choppers.get(owner) ?? null
  }

  /** Whether our own tank is being drawn at all. Also for the suites. */
  youVisible(): boolean {
    return this.you.root.visible
  }

  /**
   * A peer's rig, for test/teams.mjs.
   *
   * The claim there is that a teammate is *marked on the felt* and a stranger
   * is not — which is a mesh being visible, not a flag in game state. Same
   * reasoning as `coverMeshAt` and `chopperRigAt`.
   */
  rigFor(session: string): { ring: THREE.Object3D } | null {
    return this.rigs.get(session) ?? null
  }

  /** A flag base's rig, for test/flags.mjs. See `coverMeshAt` for the reasoning. */
  flagRigAt(team: number): { root: THREE.Object3D; cloth: THREE.Mesh } | null {
    return this.flagPoles.get(team) ?? null
  }

  /** Whether our own tank is visibly carrying a flag. Also for the suite. */
  youFlagVisible(): boolean {
    return this.you.flag?.visible === true
  }

  private wear(rig: TankRig, v: TankView, now: number, dt: number, inside = false): void {
    const ratio = v.maxHp > 0 ? Math.max(0, v.hp) / v.maxHp : 1
    if (ratio >= 1) {
      rig.smokeOwed = 0
      return
    }
    const burning = v.hp === 1 && v.maxHp > 1

    // Soot, on top of whatever the skin painted. Multiplying keeps every skin
    // recognisable while damaged — a scorched Chrome is still obviously Chrome
    // — where setting a flat grey would erase the finish the player chose.
    const soot = 1 - (1 - ratio) * 0.58
    rig.body.color.multiplyScalar(soot)
    rig.trim.color.multiplyScalar(soot)

    if (burning && !inside) {
      // Flicker, so it reads as fire rather than as a tank painted orange.
      const flare = 0.42 + Math.sin(now / 70) * 0.12 + Math.sin(now / 23) * 0.06
      rig.body.emissive.lerp(FIRE_GLOW, Math.max(0, Math.min(1, flare)))
    }

    // The soot above is kept from inside — it is on the hull under the reticle,
    // it darkens rather than adds, and it is the one damage cue in this view
    // that costs no pixels of board. Everything below this line spawns geometry
    // in front of the eye, so it stops here.
    if (inside) {
      rig.smokeOwed = 0
      return
    }

    // Behind the hull, along its heading. Forward is +cos/+sin here, which is
    // the same convention the recoil offset above uses to push the turret back.
    const back = 20
    const px = v.x - Math.cos(v.hull) * back
    const pz = v.y - Math.sin(v.hull) * back

    // Rate rather than an on/off, so the plume itself says how hurt they are:
    // a thin trail at the first scratch, a steady column near death. Reading
    // that across the arena is the whole feature — and the first numbers here
    // were set by eye and failed it. At 8/s the middle tier was one puff in a
    // screenshot: technically smoking, invisible on a tank the board camera
    // draws thirty pixels wide, which is the state this tier exists to show.
    rig.smokeOwed += dt * (burning ? 46 : 18 + (1 - ratio) * 34)
    // Capped rather than looped to exhaustion: a tab that was in the background
    // for a minute comes back with one enormous dt, and without this it would
    // spend that frame spawning nine hundred puffs it is about to throw away.
    let budget = 6
    while (rig.smokeOwed >= 1 && budget-- > 0) {
      rig.smokeOwed -= 1
      // Flame on the deck, soot above it. Spawning both at the same height
      // reads as a tank in a bin bag rather than a tank on fire: the black
      // puffs land in front of the glowing hull and cover the one thing this
      // tier exists to show. Measured, not guessed — an even split at one
      // height scored zero flame pixels at the nozzle while the hull
      // underneath was fully lit.
      const hot = burning && Math.random() < 0.75
      const py = hot ? 18 + Math.random() * 10 : 32 + Math.random() * 14
      this.plumes.puff(px, py, pz, hot)
    }
    if (budget <= 0) rig.smokeOwed = 0
  }

  /**
   * Shells, and the two effects that come free with tracking them.
   *
   * A shell id we have not seen before means somebody just pulled a trigger, so
   * that is the muzzle flash. An id that disappeared means it hit a wall, a
   * tank, or its own lifetime, so that is the impact — and the last position we
   * saw it at is where to put the sparks.
   */
  private syncShells(game: Game): void {
    // Cleared first, set by the loop below. A visibility flag that is only ever
    // turned *on* is the shape of bug this codebase has shipped before: the
    // shadow of a shell that landed ten seconds ago sits on the felt forever,
    // and nothing in the scene graph objects.
    this.lobShadow.visible = false
    for (const shell of game.shells.values()) {
      let mesh = this.shells.get(shell.id)
      if (!mesh) {
        const heavy = shell.damage > 1
        mesh = new THREE.Mesh(
          heavy ? this.siegeGeo : this.shellGeo,
          heavy
            ? this.shellSiege
            : shell.owner === game.identity.sessionPubkey
              ? this.shellMine
              : this.shellTheirs,
        )
        this.scene.add(mesh)
        this.shells.set(shell.id, mesh)

        const firer =
          shell.owner === game.identity.sessionPubkey ? this.you : this.rigs.get(shell.owner)
        if (firer) firer.recoil = 1
        this.confetti.burst(shell.x, shell.y, 5, 45, { speed: 90, up: 60, y: 24, size: 0.55, life: 0.35 })
      }
      const height = shellHeight(shell)
      mesh.position.set(shell.x, 24 + height, shell.y)
      mesh.rotation.y += 0.3
      if (shell.lob > 0) {
        // Grow with the arc. A 7-unit sphere seen from the board camera two
        // thousand units back is four pixels, and photographed at apex the lob
        // was a yellow dot you had to be told was there — which loses the trade
        // the weapon is built on. A lob is slow and telegraphed *on purpose*:
        // the target is supposed to see it coming and walk out of the crater.
        // A round nobody can see is just a delayed shell.
        //
        // Keyed to height rather than to a constant, so the thing is largest at
        // the top of its arc, which is both when it is furthest from the camera
        // and when there is most time left to react to it.
        mesh.scale.setScalar(1 + (height / LOB_APEX) * 1.3)
        // One shadow, under whichever lob is highest. Two lobs at once is rare
        // enough that a second mesh is not worth the allocation, and the one in
        // the air is the one you need to walk away from.
        this.lobShadow.visible = true
        this.lobShadow.position.set(shell.x, GROUND_Y + DECAL_LIFT, shell.y)
        // Tightens as it comes down rather than spreading, which is backwards
        // for a real shadow and right for a marker: the thing it is telling you
        // is *where*, and it should be at its most precise the moment before it
        // matters. Read the height once, above — calling `shellHeight` a second
        // time here worked and invited the two to drift apart.
        const drop = 1 - height / LOB_APEX
        this.lobShadow.scale.setScalar(0.55 + drop * 0.85)
      }
    }

    for (const [id, mesh] of this.shells) {
      const live = game.shells.get(id)
      if (live) {
        this.lastShellSeen.set(id, { x: live.x, y: live.y })
        continue
      }
      const at = this.lastShellSeen.get(id) ?? { x: mesh.position.x, y: mesh.position.z }
      this.confetti.burst(at.x, at.y, 9, 35, { speed: 150, up: 130, y: 22, size: 0.7, life: 0.45 })
      this.scene.remove(mesh)
      this.shells.delete(id)
      this.lastShellSeen.delete(id)
    }
  }

  /**
   * The landing ring while a lob is being charged.
   *
   * Drawn only for the local player, because it is the only one whose charge we
   * know — a charge is deliberately not on the wire. Once the shot is away the
   * arc and its shadow tell everybody else the same story, which is the point:
   * a lob is the loudest thing you can do and everyone gets to see it coming.
   */
  private syncLobAim(game: Game): void {
    const aim = game.lobAim
    if (!aim) {
      this.lobRing.visible = false
      return
    }
    this.lobRing.visible = true
    this.lobRing.position.set(aim.x, GROUND_Y + DECAL_LIFT, aim.y)
    // Winds from amber to red as the range comes up, so the charge is readable
    // without looking away from the board to find a bar.
    const mat = this.lobRing.material as THREE.MeshBasicMaterial
    mat.color.setHSL((38 - aim.charge * 34) / 360, 1, 0.58)
    // A slow pulse, so a full charge sitting still still reads as *armed*
    // rather than as a decal somebody left on the grass.
    // `performance.now()`, not `clock.getElapsedTime()`: three's Clock advances
    // its own elapsed time by calling `getDelta` internally, and `draw` has
    // already taken this frame's delta off it. Reading it a second time here
    // would quietly eat part of the next frame's dt.
    this.lobRing.scale.setScalar(1 + Math.sin(performance.now() / 111) * 0.045)
  }

  /**
   * Pickups on their pads.
   *
   * Nothing here is received: the game derives the same schedule every client
   * derives, so this is drawing a pure function of the block hash and the round
   * clock. A pad that has been claimed keeps its ring and loses its prize, so
   * you can see where the good spots are even while they are empty.
   */
  private syncPickups(game: Game, now: number): void {
    for (const [id, group] of this.pickupMeshes) {
      if (game.pickups.has(id)) continue
      this.scene.remove(group)
      group.traverse((child) => {
        const mesh = child as THREE.Mesh
        mesh.geometry?.dispose()
        const material = mesh.material as THREE.Material | undefined
        material?.dispose()
      })
      this.pickupMeshes.delete(id)
    }

    for (const pickup of game.pickups.values()) {
      let group = this.pickupMeshes.get(pickup.id)
      if (!group) {
        const hue = PICKUPS[pickup.kind].hue / 360
        group = new THREE.Group()
        const gem = new THREE.Mesh(
          pickupGeometry(pickup.kind),
          new THREE.MeshStandardMaterial({
            color: new THREE.Color().setHSL(hue, 0.9, 0.62),
            // Lit hard on purpose. The camera sits a long way back and an item
            // that reads as a speck is an item nobody crosses the map for.
            emissive: new THREE.Color().setHSL(hue, 0.95, 0.4),
            roughness: 0.3,
            metalness: 0.1,
          }),
        )
        gem.castShadow = true
        gem.name = 'gem'
        const pad = new THREE.Mesh(
          new THREE.RingGeometry(36, 54, 30),
          new THREE.MeshBasicMaterial({
            color: new THREE.Color().setHSL(hue, 0.8, 0.6),
            transparent: true,
            opacity: 0.65,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        )
        pad.rotation.x = -Math.PI / 2
        pad.position.y = GROUND_Y + DECAL_LIFT
        pad.name = 'pad'
        // A column of light standing over the pad. Cheap, and it is what makes
        // a pickup visible over cover from the far end of a board rather than
        // something you find by driving into it.
        const beam = new THREE.Mesh(
          new THREE.CylinderGeometry(24, 44, 190, 16, 1, true),
          new THREE.MeshBasicMaterial({
            color: new THREE.Color().setHSL(hue, 0.9, 0.62),
            transparent: true,
            opacity: 0.2,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        )
        beam.position.y = 95
        beam.name = 'beam'
        group.add(gem, pad, beam)
        group.position.set(pickup.at.x, 0, pickup.at.y)
        this.scene.add(group)
        this.pickupMeshes.set(pickup.id, group)
      }

      const gem = group.getObjectByName('gem') as THREE.Mesh
      const pad = group.getObjectByName('pad') as THREE.Mesh
      const beam = group.getObjectByName('beam') as THREE.Mesh
      gem.visible = !pickup.taken
      // Face the camera, whichever camera is live — board or cockpit. An icon
      // is only an icon while you can see its outline, and this one has to
      // survive being read from the far corner of a 2000-unit board.
      gem.quaternion.copy(this.camera.quaternion)
      // A slow tilt so it is not a dead sticker, small enough that the
      // silhouette never goes edge-on.
      gem.rotateZ(Math.sin(now / 900) * 0.16)
      gem.position.y = 62 + Math.sin(now / 320) * 9
      ;(pad.material as THREE.MeshBasicMaterial).opacity = pickup.taken ? 0.14 : 0.65
      pad.scale.setScalar(pickup.taken ? 1 : 1 + Math.sin(now / 260) * 0.07)
      beam.visible = !pickup.taken
      ;(beam.material as THREE.MeshBasicMaterial).opacity = 0.16 + Math.sin(now / 400) * 0.07
    }
  }

  /** Confetti when anyone goes down — the party-game payoff for landing a shot. */
  /**
   * Air strikes: the warning lane, and the bombs going off.
   *
   * The lane is drawn as soon as a strike is known and *before* the first bomb
   * lands, because the whole design of the reward is that it is survivable if
   * you move. A strike you cannot see coming is not a kill streak, it is a
   * random death — and the two feel completely different even when the damage
   * numbers are identical.
   *
   * The blasts themselves come off `game.blasts`, which the simulation fills
   * and this drains. A queue rather than a flag: at 190ms between bombs on a
   * machine dropping frames, two can land inside one frame and a flag would
   * draw one explosion for both.
   */
  private strikes(game: Game, now: number): void {
    let lane: { y: number; warn: number } | null = null
    for (const strike of game.strikes.values()) {
      // Fade the lane in over the run so it is loudest before the first bomb
      // and gone by the last, rather than sitting on the board afterwards.
      const done = strike.fired.size / strike.n
      if (done >= 1) continue
      lane = { y: strike.y, warn: 1 - done * 0.8 }
    }
    if (lane) {
      this.strikeLane.visible = true
      this.strikeLane.position.set(ARENA_W / 2, GROUND_Y + DECAL_LIFT * 1.2, lane.y)
      const mat = this.strikeLane.material as THREE.MeshBasicMaterial
      // Floor of 0.30 rather than 0.22, and a shallower pulse. The first
      // version bottomed out at 0.05 opacity, which on a bright green board is
      // nothing at all — a warning stripe that is invisible for half of every
      // pulse is not a warning, and the whole design of this reward is that it
      // is survivable if you can see it coming.
      mat.opacity = lane.warn * (0.30 + 0.14 * Math.sin(now / 110))
    } else {
      this.strikeLane.visible = false
    }

    for (const blast of game.blasts) {
      this.confetti.burst(blast.x, blast.y, 26, 24, { speed: 300, up: 300, y: 14, size: 1.5, life: 0.9 })
      this.confetti.burst(blast.x, blast.y, 14, 0, { speed: 150, up: 210, y: 10, size: 2.1, life: 1.3 })
      // Shake scaled by how close it was, so a bomb at the far end of the board
      // is somebody else's problem and one beside you is not.
      const d = Math.hypot(blast.x - this.youAt.x, blast.y - this.youAt.y)
      if (d < 420) this.shake = Math.max(this.shake, 24 * (1 - d / 420))
    }
    game.blasts.length = 0
  }

  private deaths(game: Game): void {
    const check = (key: string, dead: boolean, x: number, y: number, hue: number, mine: boolean) => {
      const was = this.wasDead.get(key) ?? false
      if (dead && !was) {
        this.confetti.burst(x, y, 34, hue, { speed: 260, up: 340, y: 26, size: 1.15, life: 1.5 })
        this.confetti.burst(x, y, 16, 50, { speed: 120, up: 180, y: 26, size: 1.6, life: 0.7 })
        if (mine) this.shake = Math.max(this.shake, 22)
      }
      this.wasDead.set(key, dead)
    }

    check('you', game.tank.dead, game.tank.x, game.tank.y, game.displayColor, true)
    for (const peer of game.peers.values()) {
      check(peer.session, peer.view.dead, peer.view.x, peer.view.y, peer.displayColor, false)
    }
  }

  /** A bar on the ground in front of you while the gun is reloading. */
  private reload(game: Game, now: number): void {
    const remaining = game.tank.reloadAt - now
    if (game.tank.dead || remaining <= 0) {
      this.reloadBar.visible = false
      return
    }
    const frac = 1 - remaining / (RELOAD * 1000)
    const width = 58
    this.reloadBar.visible = true
    this.reloadBar.scale.x = width * frac
    // Directly under the health pips, so "am I loaded" and "am I alive" are one
    // glance rather than two.
    this.reloadBar.position.set(game.tank.x - width / 2 + (width * frac) / 2, 52, game.tank.y)
  }

  /** Decaying camera shake. Never moves where the camera is looking. */
  /**
   * Put the camera in the hatch, looking down the barrel.
   *
   * Behind the turret's centre rather than at it, so your own gun is in frame —
   * it is the only part of the tank you can see from in here and it is what
   * makes the view read as a cockpit instead of as a floating eye.
   *
   * The eye rides `rig.sink`, so going down tips the view into the board the
   * same way the hull does. It deliberately does *not* ride the idle bob: a
   * two-unit sine on the hull is charm, and the same sine on the camera is
   * motion sickness.
   */
  private placeEye(game: Game): void {
    const t = game.tank
    const dirX = Math.cos(t.gun)
    const dirZ = Math.sin(t.gun)
    const height = EYE_Y + this.you.sink

    // Reverse into a wall and the eye ends up inside it, looking out through
    // the back face at the board — cover you cannot see past is most of what
    // makes this arena work, and a camera that ignores it is not a smaller
    // problem than a bad frame rate. So walk it in until it is in the open.
    // Stepping rather than raycasting because the answer only has to be right
    // to within a few units and this runs every frame.
    //
    // Tall walls only. The eye is at EYE_Y and a barricade tops out at LOW_H,
    // so backing into sandbags never puts the camera inside anything — pulling
    // it in there would be the camera lurching forward at nothing.
    let back = EYE_BACK
    while (back > EYE_BACK_MIN) {
      const x = t.x - dirX * back
      const y = t.y - dirZ * back
      if (!pointInTallWall(x, y) && x > 8 && y > 8 && x < ARENA_W - 8 && y < ARENA_H - 8) break
      back -= 6
    }

    this.eye.set(t.x - dirX * back, height, t.y - dirZ * back)
    this.gaze.set(t.x + dirX * EYE_REACH, height - EYE_DROP, t.y + dirZ * EYE_REACH)
  }

  private applyShake(dt: number): void {
    const cockpit = this.view === 'cockpit'
    const home = cockpit ? this.eye : this.home
    const look = cockpit ? this.gaze : this.target
    if (this.shake <= 0.01) {
      this.camera.position.copy(home)
      if (cockpit) this.camera.lookAt(look)
      return
    }
    this.shake = Math.max(0, this.shake - dt * 42)
    // Half as much inside the tank: the same displacement is a nudge from 3000
    // units away and a punch in the face from the driver's seat.
    const amount = cockpit ? this.shake : this.shake * 2
    this.camera.position.set(
      home.x + (Math.random() - 0.5) * amount,
      home.y + (Math.random() - 0.5) * amount,
      home.z + (Math.random() - 0.5) * amount,
    )
    this.camera.lookAt(look)
  }

  /**
   * Render one frame and read pixels straight back out of the framebuffer.
   *
   * Exists because "is anything actually on the screen" is not answerable from
   * the DOM: a WebGL canvas with a live context and a scene full of geometry
   * looks identical to a broken one from the outside, and drawing it into a 2D
   * canvas afterwards yields transparent black, because the drawing buffer is
   * not preserved between frames. Reading back inside the same task is the one
   * way to ask. `test/two-player.mjs` is the caller.
   */
  probePixels(x: number, y: number, w = 1, h = 1): number[] {
    this.renderer.render(this.scene, this.camera)
    const gl = this.renderer.getContext()
    // Callers pass CSS pixels; the drawing buffer is scaled by the pixel ratio
    // and its origin is bottom-left rather than top-left.
    const ratio = this.renderer.getPixelRatio()
    const pw = Math.max(1, Math.round(w * ratio))
    const ph = Math.max(1, Math.round(h * ratio))
    const px = Math.round(x * ratio)
    const py = Math.round(gl.drawingBufferHeight - (y + h) * ratio)
    const out = new Uint8Array(pw * ph * 4)
    gl.readPixels(px, py, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, out)
    return Array.from(out)
  }

  private disposeRig(rig: TankRig): void {
    rig.avatar.dispose()
    rig.face.material.dispose()
    ;(rig.label.material as THREE.SpriteMaterial).map?.dispose()
    rig.label.material.dispose()
    rig.body.dispose()
    rig.trim.dispose()
    for (const pip of rig.pips) (pip.material as THREE.Material).dispose()
    ;(rig.ring.material as THREE.Material).dispose()
    rig.ring.geometry.dispose()
    ;(rig.flash.material as THREE.Material).dispose()
  }

  dispose(): void {
    window.removeEventListener('resize', this.resize)
    for (const rig of this.rigs.values()) this.disposeRig(rig)
    this.disposeRig(this.you)
    this.renderer.dispose()
  }
}

/**
 * The tank on the lobby, in the flesh.
 *
 * Puzz: "Skins should show a preview png, svg or whatever media file of what
 * the tank will look like." A picture would be a *second* description of the
 * tank, and second descriptions drift — the six finishes are numbers in
 * `SKINS`, and a hand-drawn swatch of "chrome" is a promise that nobody will
 * ever retune `metalness`. So this renders the real rig with the real
 * `applySkin`, in its own small context. What you see in the garage is the
 * mesh the board will draw, because it is literally the same code.
 *
 * Its own WebGL context, which is the cost. One extra context is well inside
 * every browser cap, and `dispose()` gives it back the moment a match starts —
 * a lobby preview still holding a context during a firefight is exactly the
 * kind of thing that shows up as "the game got laggy".
 */
export class TankPreview {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly rig: TankRig
  private raf = 0
  private disposed = false

  constructor(canvas: HTMLCanvasElement) {
    // `preserveDrawingBuffer` so the canvas can be *read*. Without it the
    // buffer is cleared on composite and `toDataURL` hands back a blank
    // image — which is how a preview that renders nothing at all would sail
    // through a test that only checked the canvas exists. It costs a copy of a
    // 132px surface and it also makes the tank right-click-saveable, which is
    // the closest thing to the "preview png" that was asked for.
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      preserveDrawingBuffer: true,
    })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    // The same two lights the board uses, at the same colours. A preview lit
    // differently from the arena is a preview that lies about the finish,
    // which is the one thing this element exists to be honest about.
    this.scene.add(new THREE.HemisphereLight(0xc6d9ea, 0x5f7742, 1.35))
    const sun = new THREE.DirectionalLight(0xfff0d2, 2.15)
    sun.position.set(120, 180, 90)
    this.scene.add(sun, sun.target)

    this.rig = makeTank()
    // The ring and the name plate belong to a tank on a board with other
    // tanks in the way; in a garage they are furniture. The driver stays —
    // your own face in the hatch is half of why a skin is worth choosing.
    this.rig.ring.visible = false
    this.rig.label.visible = false
    // Hull pips too. Three white squares floating over a tank in a garage read
    // as damage on a tank that has not been anywhere, and they were the only
    // thing the first framing managed to clip against the top of the canvas.
    for (const p of this.rig.pips) p.visible = false
    this.scene.add(this.rig.root)

    // Framed by measurement, not by eye: the driver's head is a billboard at
    // roughly y=60 and the first cut cropped it against the top of the canvas,
    // which is a preview of a tank with no driver in it.
    this.camera = new THREE.PerspectiveCamera(32, 1, 1, 2000)
    this.camera.position.set(132, 96, 146)
    this.camera.lookAt(0, 26, 0)

    this.resize()
    const spin = () => {
      if (this.disposed) return
      // Slow, and never stopped. A still three-quarter view hides what a
      // finish does with a moving highlight, which is most of what separates
      // chrome from matte.
      this.rig.root.rotation.y += 0.006
      this.rig.turret.rotation.y = Math.sin(this.rig.root.rotation.y * 0.7) * 0.35
      this.renderer.render(this.scene, this.camera)
      this.raf = requestAnimationFrame(spin)
    }
    spin()
  }

  /** Point it at a finish and a player colour. */
  setSkin(skin: SkinId, hue: number): void {
    if (this.disposed) return
    applySkin(this.rig, SKINS[skin] ?? SKINS[DEFAULT_SKIN], hue)
  }

  /** Who is driving: the callsign's initials, or the npub's picture once it lands. */
  setDriver(name: string, picture: string | null, hue: number): void {
    if (this.disposed) return
    this.rig.avatar.set(name, picture, hue)
  }

  resize(): void {
    if (this.disposed) return
    const el = this.renderer.domElement
    const w = el.clientWidth || 280
    const h = el.clientHeight || 170
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / Math.max(1, h)
    this.camera.updateProjectionMatrix()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.renderer.dispose()
  }
}

/** Re-exported so callers can keep treating the peer view as opaque. */
export type { Peer }
