// Keyboard + mouse for a desk, gamepad for a couch. Both produce the same
// four numbers the tank simulation cares about.

import { angleDelta } from './sim'

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

export class Input {
  /** Default is `direct`: it is the one people can drive without being told. */
  scheme: Scheme = 'direct'
  private keys = new Set<string>()
  private mouseDown = false
  /** Mouse position in world coordinates, kept up to date by the renderer. */
  mouseWorld: { x: number; y: number } | null = null
  private usingGamepad = false

  constructor(private canvas: HTMLCanvasElement) {
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
    const pad = this.readPad(tank)
    if (pad) return pad

    const has = (...codes: string[]) => codes.some((c) => this.keys.has(c))
    const x = (has('KeyD', 'ArrowRight') ? 1 : 0) - (has('KeyA', 'ArrowLeft') ? 1 : 0)
    const y = (has('KeyS', 'ArrowDown') ? 1 : 0) - (has('KeyW', 'ArrowUp') ? 1 : 0)

    const aim = this.mouseWorld
      ? Math.atan2(this.mouseWorld.y - tank.y, this.mouseWorld.x - tank.x)
      : null
    const fire = this.mouseDown || this.keys.has('Space')

    if (this.scheme === 'tank') {
      return { throttle: -y, steer: x, aim, fire }
    }
    return { ...this.toHeading(x, y, tank.hull), aim, fire }
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
    const pads = navigator.getGamepads?.() ?? []
    for (const pad of pads) {
      if (!pad) continue
      const lx = deadzone(pad.axes[0] ?? 0)
      const ly = deadzone(pad.axes[1] ?? 0)
      const rx = deadzone(pad.axes[2] ?? 0)
      const ry = deadzone(pad.axes[3] ?? 0)
      const trigger = pad.buttons[7]?.value ?? 0
      const aButton = pad.buttons[0]?.pressed ?? false
      const rb = pad.buttons[5]?.pressed ?? false
      const touched = lx || ly || rx || ry || trigger > 0.1 || aButton || rb
      if (!touched && !this.usingGamepad) continue
      if (touched) this.usingGamepad = true

      // Right stick sets absolute gun angle; if it is centred the gun holds.
      const aim = rx || ry ? Math.atan2(ry, rx) : null
      const fire = trigger > 0.35 || aButton || rb
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

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    this.canvas.removeEventListener('mousedown', this.onMouseDown)
    window.removeEventListener('mouseup', this.onMouseUp)
    window.removeEventListener('blur', this.onBlur)
  }
}
