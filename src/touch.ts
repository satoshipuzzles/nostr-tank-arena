// Twin-stick touch for a phone held sideways.
//
// ## Why floating sticks rather than fixed ones
//
// A fixed on-screen stick is drawn where the designer guessed the thumb would
// be. It never is: the thumb lands where the hand is holding the phone, which
// depends on the phone, the hand and how tired the arm is. Every miss is a
// frame where the tank does not move and the player concludes the controls are
// broken.
//
// So each stick has no home. The touch that starts it *is* its centre, and the
// knob is drawn there. Put a thumb down anywhere in the left half and you are
// driving from that spot; lift and put it down two centimetres over and the
// stick moved with you. Nothing to aim at means nothing to miss.
//
// ## Why the right thumb fires by holding rather than by a button
//
// The obvious layout is drive-stick, aim-stick, fire-button. It needs three
// thumbs. Every twin-stick shooter that works on a phone solves this the same
// way and this one is no different: **aiming is firing.** Hold the right thumb
// down and the gun tracks it and shoots as fast as it reloads. Lift to stop.
//
// That trades away the ability to line up a shot without taking it, which on a
// tank with a real reload is a genuine loss. It buys back the entire right
// thumb, and thirty seconds into a match nobody is thinking about it.
//
// ## Pointer events, not touch events
//
// `pointerdown`/`pointermove`/`pointerup` carry an id per contact, which is the
// whole problem here — two thumbs down at once, and each has to be tracked to
// the stick it started. `touchmove` gives a list that has to be diffed by
// `identifier` every frame to get the same information.

export interface TouchReading {
  /** Left stick, -1..1 on each axis, screen-space. Null when nobody is driving. */
  drive: { x: number; y: number } | null
  /** Right stick, screen-space, only while it is pushed clear of its centre. */
  aim: { x: number; y: number } | null
  /** True for as long as the right thumb is down, pushed or not. */
  fire: boolean
}

/**
 * How far the thumb travels from where it landed for full deflection.
 *
 * In CSS pixels, so it is the same physical distance on a phone and a tablet
 * rather than the same fraction of a screen. A stick whose full throw is a
 * quarter of an iPad is unusable and the same stick on a phone is fine.
 *
 * It also has to keep the knob inside its own ring, which is what a screenshot
 * caught and no test would have: at 56 against a 124px base the knob's edge sat
 * 21px outside the circle it is supposed to be travelling in, and the pair read
 * as two unrelated circles rather than as one control. Full throw is now
 * `(base - knob) / 2` exactly.
 */
const RADIUS = 40
/**
 * Below this the aim stick reports no direction, and the gun holds where it is.
 *
 * A thumb resting still is not a request to swing the turret to wherever the
 * contact patch happened to centre. It exists so tap-and-hold means "fire
 * where I am already pointing", which is the whole reason firing is separate
 * from aiming here.
 */
const AIM_DEADZONE = 12

interface Stick {
  pointer: number
  /** Where the thumb landed, in client coordinates. The centre of this stick. */
  ox: number
  oy: number
  /** Where it is now. */
  x: number
  y: number
  base: HTMLElement
  knob: HTMLElement
}

export class TouchSticks {
  private drive: Stick | null = null
  private aim: Stick | null = null
  /**
   * The resting pads: a D-pad ghost on the left, a turret ring on the right.
   *
   * Drawn only between touches, and they are furniture, not controls — the
   * floating stick underneath is still what reads the thumb, so landing a
   * centimetre off the picture costs nothing. They exist because the floating
   * design's one real cost is that a new player sees an empty screen: nothing
   * says "put your thumbs here" until a thumb has already guessed right. Puzz
   * asked for the picture by name — "transparent D-pad drawn on the left,
   * stick on the right" — and the analogue blend stays underneath it, so
   * steer and drive mix instead of snapping to eight directions.
   */
  private ghostDrive: HTMLElement
  private ghostAim: HTMLElement
  /** Whether a match is on. Set from outside; the lobby gets no pads. */
  private resting = false
  /**
   * Whether this device has ever produced a touch contact.
   *
   * Not `'ontouchstart' in window`, which is true on plenty of desks — every
   * Chrome with the device toolbar open, and every laptop with a touchscreen
   * nobody uses. Getting this wrong hides the mouse controls from somebody who
   * has a mouse, so it is answered by observation rather than by capability:
   * the layer stays out of the way until a finger actually arrives.
   */
  private seen = false

  constructor(
    private canvas: HTMLCanvasElement,
    private layer: HTMLElement,
  ) {
    // Two listeners, because they answer two different questions and the canvas
    // can only answer one of them. Sticks are born from a touch *on the board*,
    // so that one stays on the canvas — but "is this a phone" has to be
    // answerable from the lobby, and in the lobby the canvas is underneath a
    // full-screen card and never sees a finger at all. Without this the rotate
    // screen and the touch hint could not appear until after the first tap
    // inside a running game, which is one tap too late to be any use.
    window.addEventListener('pointerdown', this.onAnyPointer, { capture: true, passive: true })
    canvas.addEventListener('pointerdown', this.onDown)
    window.addEventListener('pointermove', this.onMove, { passive: false })
    window.addEventListener('pointerup', this.onUp)
    window.addEventListener('pointercancel', this.onUp)

    this.ghostDrive = document.createElement('div')
    this.ghostDrive.className = 'tghost drive'
    this.ghostDrive.innerHTML =
      '<div class="dpad"><span class="da up">▲</span><span class="da down">▼</span>' +
      '<span class="da west">◀</span><span class="da east">▶</span></div>'
    this.ghostAim = document.createElement('div')
    this.ghostAim.className = 'tghost aim'
    this.ghostAim.innerHTML = '<div class="tcross"></div>'
    this.ghostDrive.hidden = true
    this.ghostAim.hidden = true
    layer.appendChild(this.ghostDrive)
    layer.appendChild(this.ghostAim)
  }

  /**
   * Show or hide the resting pads. Called with "is a match on" — the pads make
   * no sense over the lobby, and inside a match each one yields to the live
   * stick in its half and comes back when the thumb lifts.
   */
  rest(on: boolean): void {
    this.resting = on
    this.paintGhosts()
  }

  private paintGhosts(): void {
    this.ghostDrive.hidden = !this.resting || this.drive !== null
    this.ghostAim.hidden = !this.resting || this.aim !== null
  }

  /** True once a finger has been on the glass. Drives every mobile-only affordance. */
  get touched(): boolean {
    return this.seen
  }

  private onAnyPointer = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || this.seen) return
    this.seen = true
    this.layer.classList.add('live')
  }

  private onDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return
    this.onAnyPointer(e)
    // Left half drives, right half aims — but only as a default. A second thumb
    // landing on the left while the left stick is already taken gets the aim
    // stick, because the alternative is a touch that does nothing, and a touch
    // that does nothing on a game reads as a dropped input rather than as a
    // rule being enforced.
    const wantsDrive = e.clientX < window.innerWidth / 2
    if (wantsDrive && !this.drive) this.drive = this.begin(e, 'drive')
    else if (!this.aim) this.aim = this.begin(e, 'aim')
    else if (!this.drive) this.drive = this.begin(e, 'drive')
    else return
    this.paintGhosts()
    e.preventDefault()
  }

  /** True once a stick has actually been raised, which retires the hint. */
  get used(): boolean {
    return this.everUsed
  }

  private everUsed = false

  private begin(e: PointerEvent, kind: 'drive' | 'aim'): Stick {
    this.everUsed = true
    const base = document.createElement('div')
    base.className = `tstick ${kind}`
    const knob = document.createElement('div')
    knob.className = 'tknob'
    base.appendChild(knob)
    this.layer.appendChild(base)
    const stick: Stick = {
      pointer: e.pointerId,
      ox: e.clientX,
      oy: e.clientY,
      x: e.clientX,
      y: e.clientY,
      base,
      knob,
    }
    this.paint(stick)
    return stick
  }

  private onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return
    const stick = this.find(e.pointerId)
    if (!stick) return
    stick.x = e.clientX
    stick.y = e.clientY
    this.paint(stick)
    // Otherwise the browser takes the drag as a scroll or a pull-to-refresh and
    // the stick stops receiving moves halfway through a turn.
    e.preventDefault()
  }

  private onUp = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return
    const stick = this.find(e.pointerId)
    if (!stick) return
    stick.base.remove()
    if (this.drive === stick) this.drive = null
    if (this.aim === stick) this.aim = null
    this.paintGhosts()
  }

  private find(id: number): Stick | null {
    if (this.drive?.pointer === id) return this.drive
    if (this.aim?.pointer === id) return this.aim
    return null
  }

  private paint(stick: Stick): void {
    const { dx, dy } = clampToRadius(stick)
    stick.base.style.left = `${stick.ox}px`
    stick.base.style.top = `${stick.oy}px`
    stick.knob.style.transform = `translate(${dx}px, ${dy}px)`
  }

  read(): TouchReading {
    const drive = this.drive ? clampToRadius(this.drive) : null
    const aim = this.aim ? clampToRadius(this.aim) : null
    return {
      drive: drive && (drive.dx || drive.dy) ? { x: drive.dx / RADIUS, y: drive.dy / RADIUS } : null,
      aim: aim && Math.hypot(aim.dx, aim.dy) > AIM_DEADZONE ? { x: aim.dx, y: aim.dy } : null,
      fire: this.aim !== null,
    }
  }

  dispose(): void {
    window.removeEventListener('pointerdown', this.onAnyPointer, { capture: true })
    this.canvas.removeEventListener('pointerdown', this.onDown)
    window.removeEventListener('pointermove', this.onMove)
    window.removeEventListener('pointerup', this.onUp)
    window.removeEventListener('pointercancel', this.onUp)
    this.drive?.base.remove()
    this.aim?.base.remove()
    this.drive = null
    this.aim = null
    this.ghostDrive.remove()
    this.ghostAim.remove()
  }
}

/** Thumb travel from the stick's centre, capped at one full deflection. */
function clampToRadius(stick: { ox: number; oy: number; x: number; y: number }): {
  dx: number
  dy: number
} {
  const dx = stick.x - stick.ox
  const dy = stick.y - stick.oy
  const d = Math.hypot(dx, dy)
  if (d <= RADIUS) return { dx, dy }
  return { dx: (dx / d) * RADIUS, dy: (dy / d) * RADIUS }
}
