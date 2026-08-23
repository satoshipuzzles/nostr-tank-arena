// Keyboard + mouse for a desk, gamepad for a couch. Both produce the same
// four numbers the tank simulation cares about.
//
// ## One of these per player, not one per page
//
// That distinction is the whole reason local two-player works. An `Input` used
// to own the keyboard outright: a `window` keydown listener filling one set, a
// "any held key beats the pad" backstop reading that set, and a `readPad()` that
// returned whichever pad answered first. All three are correct for one human
// with a keyboard and a pad in front of them, and all three break the moment
// there are two humans — Fizz measured it before split-screen was written:
//
//   - player one holding W froze player two's pad completely, and splitting into
//     two `Input` objects did not help, because both were listening to the same
//     `window` and both concluded somebody was driving
//   - a second pad was inert: the first pad to claim was returned every frame,
//     and a *centred* pad zero was enough to shadow a pushed pad one
//
// So an `Input` now has a `Binding`: which half of the keyboard it reads, which
// pad index it owns, and whether it gets the mouse. Nothing is shared.

import { angleDelta } from './sim'
import type { TouchSticks } from './touch'

export interface Controls {
  /** -1 reverse .. 1 forward */
  throttle: number
  /** -1 left .. 1 right, hull rotation */
  steer: number
  /** Absolute gun angle in world radians, or null to hold the current one. */
  aim: number | null
  fire: boolean
}

const DEADZONE = 0.22
/**
 * How hard a stick has to be pushed before we conclude the player has picked
 * the pad up, as opposed to the pad merely existing. Larger than DEADZONE:
 * reading a stick and deciding to ignore the keyboard are different questions
 * and they do not deserve the same threshold. Kept close to it so a deliberate
 * push still registers on the first frame.
 */
const CLAIM = 0.35
/** Triggers rest a little off zero on plenty of pads. Match the fire threshold. */
const TRIGGER_FIRE = 0.35

const deadzone = (v: number) => (Math.abs(v) < DEADZONE ? 0 : v)
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/**
 * How WASD and the left stick are interpreted.
 *
 * `tank` is the original: A and D rotate the hull, W and S drive it. Authentic,
 * and the thing everybody bounced off — you spend the first minute pointing the
 * wrong way instead of shooting anybody.
 *
 * `direct` treats the keys as a direction on the board. Press up-left and the
 * tank turns toward up-left and goes. The hull still has to physically rotate
 * at `TURN_RATE`, so nothing about the simulation or the feel of a heavy tank
 * changes — what changes is that the input describes where you want to be
 * rather than which way to spin.
 */
export type Scheme = 'direct' | 'tank'

/** Which physical controls belong to this player. Nothing here is shared. */
export interface Binding {
  /**
   * `both` is the solo default. In two-player, one takes `wasd` and the other
   * takes `arrows`, so a key held by one player is invisible to the other.
   */
  keys: 'both' | 'wasd' | 'arrows' | 'none'
  /**
   * `any` means "the first pad that gets picked up", which is right when there
   * is one player and no way to know which pad they will reach for. With two
   * players each names an index, or pad one shadows pad zero forever.
   */
  pad: number | 'any' | null
  /** Only one player can have the mouse, and it is whoever is at the keyboard. */
  mouse: boolean
}

/**
 * Screen space and board space line up, which is why the sticks can be read raw.
 *
 * The camera sits south of the board and above it, pitched over, with no roll —
 * `Renderer.frameBoard` builds it from a single pitch and never rotates around
 * the board. Work the basis out from that and screen-right is world +x, screen-
 * down is world +z, and world z is what this game calls y. So a thumb pushed
 * up-right on the glass is a tank driving up-right on the felt, with no
 * transform in between.
 *
 * Written down because it is a fact about the camera, not about the input, and
 * the day somebody swings the camera round the board this file starts lying
 * without a test failing.
 */


export const SOLO: Binding = { keys: 'both', pad: 'any', mouse: true }
/**
 * Player two: the arrow keys, or pad one, and no mouse.
 *
 * Deliberately mutable per instance — `main.ts` narrows player one to WASD and
 * pad zero at the same moment, because with two people at one keyboard "either
 * half drives me" is the same collision as "any pad drives me".
 */
export const PLAYER_TWO: Binding = { keys: 'arrows', pad: 1, mouse: false }

const DRIVE_KEYS: Record<
  Binding['keys'],
  { up: string[]; down: string[]; left: string[]; right: string[]; fire: string[] }
> = {
  both: {
    up: ['KeyW', 'ArrowUp'],
    down: ['KeyS', 'ArrowDown'],
    left: ['KeyA', 'ArrowLeft'],
    right: ['KeyD', 'ArrowRight'],
    fire: ['Space'],
  },
  wasd: { up: ['KeyW'], down: ['KeyS'], left: ['KeyA'], right: ['KeyD'], fire: ['Space'] },
  // Right hand on the arrows, thumb on Enter or right shift. Several, because
  // which one is comfortable depends entirely on the keyboard.
  arrows: {
    up: ['ArrowUp'],
    down: ['ArrowDown'],
    left: ['ArrowLeft'],
    right: ['ArrowRight'],
    fire: ['Enter', 'NumpadEnter', 'ShiftRight', 'NumpadAdd'],
  },
  none: { up: [], down: [], left: [], right: [], fire: [] },
}

export class Input {
  /** Default is `direct`: it is the one people can drive without being told. */
  scheme: Scheme = 'direct'
  private keys = new Set<string>()
  private mouseDown = false
  /** Mouse position in world coordinates, kept up to date by the renderer. */
  mouseWorld: { x: number; y: number } | null = null
  private usingGamepad = false
  /**
   * Where each pad's axes rest, learned rather than assumed.
   *
   * Worn sticks do not return to zero. A pad resting at 0.25 is outside the
   * deadzone on every frame, which used to read as a permanent hard-left and —
   * because `read()` returns the pad's answer outright — took the keyboard away
   * from a player who had never touched the thing. Right-stick drift did it too,
   * and that axis only aims, so you could lose the ability to drive to a stick
   * that does not steer.
   *
   * Each entry converges on the smallest magnitude that axis has ever reported.
   * A stick that genuinely passes through centre calibrates itself to zero; one
   * that never does calibrates to its true rest position. It cannot get stuck
   * high, because the only update is downward.
   */
  private neutral = new Map<number, number[]>()
  /**
   * The same treatment for the trigger, and for the same reason twice over: a
   * trigger that rests above zero is both a dead keyboard and a tank that fires
   * on its own, which is the worse half of the two.
   */
  private triggerRest = new Map<number, number>()

  /**
   * Set for whoever owns the glass, which is player one and nobody else.
   *
   * Two people cannot share a phone, so there is no touch equivalent of the
   * keyboard split. Player two on a touch device does not exist and the couch
   * bindings never look at this.
   */
  touch: TouchSticks | null = null

  constructor(
    private canvas: HTMLCanvasElement,
    readonly binding: Binding = SOLO,
  ) {
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    canvas.addEventListener('mousedown', this.onMouseDown)
    window.addEventListener('mouseup', this.onMouseUp)
    window.addEventListener('blur', this.onBlur)
  }

  private onKeyDown = (e: KeyboardEvent) => {
    // Don't eat typing in the lobby inputs.
    if (e.target instanceof HTMLInputElement) return
    this.keys.add(e.code)
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault()
    this.usingGamepad = false
  }

  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code)
  private onMouseDown = () => {
    this.mouseDown = true
    this.usingGamepad = false
  }
  private onMouseUp = () => {
    this.mouseDown = false
  }
  private onBlur = () => {
    this.keys.clear()
    this.mouseDown = false
  }

  /** True once a gamepad axis or button has actually been touched. */
  get gamepadActive(): boolean {
    return this.usingGamepad
  }

  read(tank: { x: number; y: number; gun: number; hull: number }): Controls {
    // A thumb on the glass outranks everything. On a phone there is no keyboard
    // to lose and no pad to shadow, and on a laptop with a touchscreen the
    // sticks do not exist until a finger has actually arrived — see
    // `TouchSticks.touched` for why that is observed rather than detected.
    const touched = this.touch?.read()
    if (touched && (touched.drive || touched.fire)) {
      const aim = touched.aim ? Math.atan2(touched.aim.y, touched.aim.x) : null
      const x = touched.drive?.x ?? 0
      const y = touched.drive?.y ?? 0
      if (this.scheme === 'tank') {
        return { throttle: -y, steer: x, aim, fire: touched.fire }
      }
      const drive = this.toHeading(x, y, tank.hull)
      // Scaled by how far the thumb is pushed, the same as a stick. A touch
      // control that is all-or-nothing is why phone games feel twitchy: there
      // is no way to nudge into a corner.
      const push = Math.min(1, Math.hypot(x, y))
      return { throttle: drive.throttle * push, steer: drive.steer, aim, fire: touched.fire }
    }

    const map = DRIVE_KEYS[this.binding.keys]
    const has = (codes: string[]) => codes.some((c) => this.keys.has(c))
    // A held key beats the pad, always — but only a key *this player* owns.
    // Reading the whole keyboard here is what let player one's W freeze player
    // two's pad, and it did so through two separate `Input` objects, because the
    // set behind it was filled from a shared `window` listener.
    const driving = has(map.up) || has(map.down) || has(map.left) || has(map.right)
    const pad = driving ? null : this.readPad(tank)
    if (pad) return pad

    const x = (has(map.right) ? 1 : 0) - (has(map.left) ? 1 : 0)
    const y = (has(map.down) ? 1 : 0) - (has(map.up) ? 1 : 0)

    const fire = (this.binding.mouse && this.mouseDown) || has(map.fire)
    const aim =
      this.binding.mouse && this.mouseWorld
        ? Math.atan2(this.mouseWorld.y - tank.y, this.mouseWorld.x - tank.x)
        : // No mouse and no right stick: the gun points where you drive. Not so
          // much a compromise as the other half of the arcade tradition — and a
          // second player on the arrow keys with a turret that never turns is
          // not playing a game.
          this.aimlessGun(x, y, tank)

    if (this.scheme === 'tank') {
      return { throttle: -y, steer: x, aim, fire }
    }
    return { ...this.toHeading(x, y, tank.hull), aim, fire }
  }

  /** Where a player with no aiming device is pointing: along the hull. */
  private aimlessGun(x: number, y: number, tank: { hull: number }): number | null {
    if (this.binding.mouse) return null
    return x || y ? Math.atan2(y, x) : tank.hull
  }

  /**
   * A direction on the board becomes a steer and a throttle.
   *
   * Throttle eases off while the hull is more than a right angle away from
   * where you asked it to go, so reversing direction pivots on the spot instead
   * of driving a long arc into a wall. It never reaches zero: a tank that stops
   * dead every time you change your mind feels broken rather than heavy.
   */
  private toHeading(x: number, y: number, hull: number): { throttle: number; steer: number } {
    if (!x && !y) return { throttle: 0, steer: 0 }
    const want = Math.atan2(y, x)
    const d = angleDelta(hull, want)
    return {
      steer: clamp(d * 3, -1, 1),
      throttle: Math.abs(d) > Math.PI / 2 ? 0.35 : 1,
    }
  }

  private readPad(tank: { gun: number; hull: number }): Controls | null {
    if (this.binding.pad === null) return null
    const pads = navigator.getGamepads?.() ?? []
    for (const pad of pads) {
      if (!pad) continue
      // An index means this pad and no other. Without it, `readPad` returns
      // whoever answers first — and once pad zero has latched `usingGamepad`,
      // pad one is never reached even when pad zero is sitting centred.
      if (this.binding.pad !== 'any' && pad.index !== this.binding.pad) continue
      const axis = this.calibrate(pad)
      const lx = deadzone(axis(0))
      const ly = deadzone(axis(1))
      const rx = deadzone(axis(2))
      const ry = deadzone(axis(3))
      const trigger = this.calibrateTrigger(pad)
      const aButton = pad.buttons[0]?.pressed ?? false
      const rb = pad.buttons[5]?.pressed ?? false
      const fire = trigger > TRIGGER_FIRE || aButton || rb
      // Claiming the input needs a deliberate push or a real button. A stick
      // sitting just past the deadzone is not somebody asking to play.
      const claimed =
        Math.hypot(lx, ly) > CLAIM || Math.hypot(rx, ry) > CLAIM || aButton || rb || trigger > TRIGGER_FIRE
      if (!claimed && !this.usingGamepad) continue
      if (claimed) this.usingGamepad = true

      // Right stick sets absolute gun angle; if it is centred the gun holds.
      const aim = rx || ry ? Math.atan2(ry, rx) : null
      // A stick already gives a direction, so `direct` is what it wants — and
      // it is what every twin-stick game on a couch has trained people to
      // expect from the left stick.
      if (this.scheme === 'direct') {
        const drive = this.toHeading(lx, ly, tank.hull)
        // Scale by how far the stick is pushed, so it is not all-or-nothing.
        const push = Math.min(1, Math.hypot(lx, ly))
        return { throttle: drive.throttle * push, steer: drive.steer, aim, fire }
      }
      return { throttle: -ly, steer: lx, aim, fire }
    }
    return null
  }

  /**
   * Per-pad drift compensation. Returns a reader that subtracts each axis's
   * learned rest position, so a worn stick reports zero when nobody is holding
   * it. See `neutral` for why the estimate only ever moves toward zero.
   */
  private calibrateTrigger(pad: Gamepad): number {
    const raw = pad.buttons[7]?.value ?? 0
    const rest = Math.min(this.triggerRest.get(pad.index) ?? raw, raw)
    this.triggerRest.set(pad.index, rest)
    return raw - rest
  }

  private calibrate(pad: Gamepad): (i: number) => number {
    let rest = this.neutral.get(pad.index)
    if (!rest || rest.length !== pad.axes.length) {
      // Seeded from the first reading only where that reading is plausibly a
      // resting one. Fizz caught this on their own probe three times over: a pad
      // first seen while somebody is already pushing it calibrates the push as
      // its centre and reads zero until they let go. Player two joining
      // mid-match with a thumb on the stick is the normal case, not the edge.
      // A large first reading is therefore assumed to be input rather than
      // drift; if it really was drift, the downward convergence below finds it
      // the moment the stick passes anywhere near centre.
      rest = pad.axes.map((v) => (Math.abs(v) < DEADZONE ? v : 0))
      this.neutral.set(pad.index, rest)
    }
    for (let i = 0; i < pad.axes.length; i++) {
      const v = pad.axes[i] ?? 0
      if (Math.abs(v) < Math.abs(rest[i])) rest[i] = v
    }
    return (i: number) => (pad.axes[i] ?? 0) - (rest![i] ?? 0)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.canvas.removeEventListener('mousedown', this.onMouseDown)
    window.removeEventListener('mouseup', this.onMouseUp)
    window.removeEventListener('blur', this.onBlur)
  }
}
