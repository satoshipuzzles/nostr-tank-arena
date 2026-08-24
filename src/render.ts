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
import { ARENA_H, ARENA_W, WALLS, onLayoutChange, pointInWall } from './arena'
import type { Game, Peer } from './game'
import { MAX_HP, RELOAD, TANK_RADIUS } from './sim'
import { ICON_POLYS, PICKUPS, hasBuff } from './pickups'
import type { PickupKind } from './pickups'
import { Avatar } from './avatars'

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

// --------------------------------------------------------------- materials

const toy = (color: THREE.ColorRepresentation, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.02, ...extra })

/**
 * The cartoon outline: the same shape again, slightly larger, inside out, in
 * near-black. Two extra draw calls per tank, and it is the single thing that
 * makes the tanks read as toys rather than as untextured geometry.
 */
const INK = new THREE.MeshBasicMaterial({ color: 0x141a26, side: THREE.BackSide })

/** A vertical gradient, used as the sky. */
function skyTexture(): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = 4
  canvas.height = 256
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createLinearGradient(0, 0, 0, 256)
  grad.addColorStop(0, '#4fb8e8')
  grad.addColorStop(0.55, '#9fdcf5')
  grad.addColorStop(1, '#e8f6ef')
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

  ctx.fillStyle = '#8ed57a'
  ctx.fillRect(0, 0, 256, 256)
  ctx.fillStyle = '#7cc767'
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
    ctx.strokeStyle = rnd() > 0.5 ? '#ffffff' : '#3f7a37'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x + (rnd() - 0.5) * 3, y - 1 - rnd() * 3)
    ctx.stroke()
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

  ctx.strokeStyle = 'rgba(255,255,255,0.42)'
  ctx.lineWidth = Math.max(2, 5 * sx)
  ctx.strokeRect(inset, inset, W - inset * 2, H - inset * 2)

  ctx.beginPath()
  ctx.moveTo(W / 2, inset)
  ctx.lineTo(W / 2, H - inset)
  ctx.stroke()

  ctx.beginPath()
  ctx.arc(W / 2, H / 2, 230 * sx, 0, Math.PI * 2)
  ctx.stroke()

  ctx.fillStyle = 'rgba(255,255,255,0.42)'
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

/** A name plate. Redrawn only when the name or colour actually changes. */
function labelTexture(name: string, hue: number, verified: boolean): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const text = verified ? name : `${name} ?`

  ctx.font = '700 62px ui-monospace, Menlo, monospace'
  const w = Math.min(480, ctx.measureText(text).width + 56)
  const x = (512 - w) / 2

  ctx.fillStyle = `hsl(${hue}, 70%, 42%)`
  ctx.strokeStyle = '#141a26'
  ctx.lineWidth = 8
  roundRect(ctx, x, 22, w, 84, 26)
  ctx.fill()
  ctx.stroke()

  ctx.font = '700 52px ui-monospace, Menlo, monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = verified ? '#ffffff' : '#e2d3a8'
  ctx.fillText(text, 256, 66)

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

// ------------------------------------------------------------------- tanks

/** Everything about one tank that the renderer owns. */
interface TankRig {
  root: THREE.Group
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

/** Everything the renderer needs about one tank for one frame. */
interface TankView {
  x: number
  y: number
  hull: number
  gun: number
  hp: number
  /** This round's hull maximum, which Glass Cannon changes. */
  maxHp: number
  dead: boolean
  hue: number
  name: string
  /** kind 0 picture URL for this player, or null while it has not arrived. */
  picture: string | null
  verified: boolean
  streak: number
  /** True for the local player, whose ring is always drawn. */
  mine: boolean
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
function pickupGeometry(kind: PickupKind): THREE.BufferGeometry {
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

// ---------------------------------------------------------------- renderer

export class Renderer {
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private confetti = new Confetti()

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
   * throwable-away. Geometries are disposed on the way out — four boards an
   * hour for as long as a tab stays open is exactly the shape of leak that
   * looks fine in a five-minute test.
   */
  private board = new THREE.Group()
  private lastRepairAt = 0
  /** One group per live pickup, keyed by the id the schedule derived. */
  private pickupMeshes = new Map<string, THREE.Group>()
  /** The bubble that shows a shield is up. One, reused. */
  private shield: THREE.Mesh

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.outputColorSpace = THREE.SRGBColorSpace

    this.scene.background = skyTexture()
    this.scene.fog = new THREE.Fog(0xd4eefb, 4400, 9000)

    this.camera = new THREE.PerspectiveCamera(BOARD_FOV, 1, 60, 8000)
    this.scene.add(this.camera)

    this.scene.add(this.board)
    this.buildBoard()
    onLayoutChange(() => this.buildBoard())
    this.buildLights()
    this.scene.add(this.confetti.mesh)
    this.scene.add(this.you.root)
    this.you.ring.visible = true

    this.shield = new THREE.Mesh(
      new THREE.SphereGeometry(TANK_RADIUS + 16, 20, 14),
      new THREE.MeshBasicMaterial({
        color: 0x7fd4ff,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    this.shield.visible = false
    this.scene.add(this.shield)

    this.reloadBar = new THREE.Mesh(
      new THREE.BoxGeometry(1, 7, 7),
      new THREE.MeshBasicMaterial({ color: 0xffc44d, depthTest: false }),
    )
    this.reloadBar.renderOrder = 2
    this.reloadBar.visible = false
    this.scene.add(this.reloadBar)

    this.resize()
    window.addEventListener('resize', this.resize)
  }

  // ------------------------------------------------------------- the board

  private buildBoard(): void {
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
      toy(0xe8d3a6, { roughness: 0.9 }),
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

    // The outer ring is the board's fence and gets its own height and colour;
    // the inner cover is what you actually hide behind.
    const isFence = (w: (typeof WALLS)[number]) =>
      w.x === 0 || w.y === 0 || w.x + w.w >= ARENA_W || w.y + w.h >= ARENA_H

    // Cover is colour-coded by what it is for, which is a board-game habit and
    // also a legibility one: "meet me at the red cross" is a thing four players
    // can say to each other, "meet me at the blue block" is not.
    const coverColour = (w: (typeof WALLS)[number]) => {
      const cx = w.x + w.w / 2
      const cy = w.y + w.h / 2
      const middle = Math.abs(cx - ARENA_W / 2) < 200 && Math.abs(cy - ARENA_H / 2) < 200
      // Pastel, deliberately. Tanks are saturated and the scenery is not, so a
      // cyan tank never disappears against a cyan wall — the six player hues
      // include one close to every colour worth painting a board with.
      if (middle) return 0xf7a293 // the centre cross
      if (w.w === w.h) return 0xffdf9b // the mid pillars
      return 0xaed3f2 // the corner Ls
    }

    for (const w of WALLS) {
      const fence = isFence(w)
      const height = fence ? FENCE_H : WALL_H
      const radius = Math.min(9, Math.min(w.w, w.h) * 0.35)
      const mesh = new THREE.Mesh(
        new RoundedBoxGeometry(w.w, height, w.h, 3, radius),
        toy(fence ? 0xf4f8fb : coverColour(w), { roughness: fence ? 0.9 : 0.55 }),
      )
      mesh.position.set(w.x + w.w / 2, height / 2, w.y + w.h / 2)
      mesh.castShadow = !fence
      mesh.receiveShadow = true
      this.board.add(mesh)
    }
  }

  private buildLights(): void {
    this.scene.add(new THREE.HemisphereLight(0xd6f0ff, 0x6f9a5c, 1.5))

    const sun = new THREE.DirectionalLight(0xfff4dc, 2.1)
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
    const maxHp = game.maxHp
    this.applyTank(this.you, dt, now, {
      x: game.tank.x,
      y: game.tank.y,
      hull: game.tank.hull,
      gun: game.tank.gun,
      hp: game.tank.hp,
      maxHp,
      dead: game.tank.dead,
      hue: game.displayColor,
      name: game.name,
      picture: this.pictures(game.identity.isGuest ? null : game.identity.pubkey),
      verified: true,
      streak: game.streak,
      mine: true,
    })
    // A spectator's tank exists in the simulation — it is where the board
    // camera and `toWorld` measure from — but it must never reach a pixel.
    // Everything under `this.you` comes off together, including the ring, the
    // plate and the driver, because half a hidden tank is a ghost.
    this.you.root.visible = !game.watching

    for (const peer of game.peers.values()) {
      const rig = this.rigs.get(peer.session)
      if (!rig) continue
      this.applyTank(rig, dt, now, {
        x: peer.view.x,
        y: peer.view.y,
        hull: peer.view.hull,
        gun: peer.view.gun,
        hp: peer.view.hp,
        maxHp,
        dead: peer.view.dead,
        hue: peer.displayColor,
        name: peer.name,
        picture: this.pictures(peer.pubkey),
        verified: peer.pubkey !== null,
        streak: peer.streak,
        mine: localSessions?.has(peer.session) ?? false,
      })
    }

    this.syncShells(game)
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
    }
    // No `else`: `applyTank` runs before this every frame and has already put
    // every one of them back the way board view wants them.

    this.shield.visible =
      !cockpit && hasBuff(game.buffs, 'shieldUntil', now) && !game.tank.dead
    if (this.shield.visible) {
      this.shield.position.set(game.tank.x, 26, game.tank.y)
      this.shield.scale.setScalar(1 + Math.sin(now / 180) * 0.04)
    }
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

    if (cockpit) this.placeEye(game)

    this.confetti.update(dt)
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

  private applyTank(rig: TankRig, dt: number, now: number, v: TankView): void {
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
    } else {
      rig.body.color.setHSL(hue / 360, 0.78, 0.58)
      rig.trim.color.setHSL(hue / 360, 0.4, 0.26)
    }

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

    const key = `${name}|${hue}|${verified}`
    if (rig.labelKey !== key) {
      rig.labelKey = key
      const material = rig.label.material as THREE.SpriteMaterial
      material.map?.dispose()
      material.map = labelTexture(name, hue, verified)
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
    const ringMat = rig.ring.material as THREE.MeshBasicMaterial
    const hot = v.streak >= 3
    rig.ring.visible = !dead && (v.mine || hot)
    if (hot) {
      ringMat.color.setHSL(((now / 12) % 360) / 360, 0.9, 0.6)
      ringMat.opacity = 0.85
      rig.ring.scale.setScalar(1.15 + Math.sin(now / 140) * 0.08)
    } else {
      ringMat.color.setHex(0xffffff)
      ringMat.opacity = 0.55
      rig.ring.scale.setScalar(1)
    }
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
      mesh.position.set(shell.x, 24, shell.y)
      mesh.rotation.y += 0.3
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
    let back = EYE_BACK
    while (back > EYE_BACK_MIN) {
      const x = t.x - dirX * back
      const y = t.y - dirZ * back
      if (!pointInWall(x, y) && x > 8 && y > 8 && x < ARENA_W - 8 && y < ARENA_H - 8) break
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

/** Re-exported so callers can keep treating the peer view as opaque. */
export type { Peer }
