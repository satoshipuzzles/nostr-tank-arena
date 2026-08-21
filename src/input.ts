// Keyboard + mouse for a desk, gamepad for a couch. Both produce the same
// four numbers the tank simulation cares about.

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

export class Input {
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

  read(tank: { x: number; y: number; gun: number }): Controls {
    const pad = this.readPad(tank)
    if (pad) return pad

    const has = (...codes: string[]) => codes.some((c) => this.keys.has(c))
    const throttle =
      (has('KeyW', 'ArrowUp') ? 1 : 0) - (has('KeyS', 'ArrowDown') ? 1 : 0)
    const steer = (has('KeyD', 'ArrowRight') ? 1 : 0) - (has('KeyA', 'ArrowLeft') ? 1 : 0)

    const aim = this.mouseWorld
      ? Math.atan2(this.mouseWorld.y - tank.y, this.mouseWorld.x - tank.x)
      : null

    return { throttle, steer, aim, fire: this.mouseDown || this.keys.has('Space') }
  }

  private readPad(tank: { gun: number }): Controls | null {
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
      // With no right stick input the gun tracks the hull, which is what you
      // want on a d-pad-only controller.
      return {
        throttle: -ly,
        steer: lx,
        aim: aim ?? (rx === 0 && ry === 0 ? null : tank.gun),
        fire: trigger > 0.35 || aButton || rb,
      }
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
