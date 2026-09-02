// Sound, synthesised on the spot.
//
// Not a single audio file. Every noise in this game is a handful of
// oscillators and a burst of filtered white noise, built when it is played and
// thrown away afterwards. That is a deliberate trade and worth stating: a set
// of samples would sound better, and it would also be half a megabyte of
// assets to download before the first shot, a build step to manage them, and a
// licence to check on every one. The game already loads on a TV browser in a
// couple of seconds and this keeps it that way.
//
// ## The gesture rule
//
// Every browser refuses to start an AudioContext until the user has clicked
// something, and a context created too early lands in `suspended` and stays
// there — silently. So the context is built from the lobby button, which is a
// real click by definition, and `resume()` is retried on the next one if the
// browser was still unconvinced.
//
// ## Distance
//
// A shell fired across the map should not be as loud as the one under your
// hull. Peer sounds carry a world position, which becomes gain and stereo pan
// relative to your own tank. It is not HRTF and it is not trying to be — it is
// enough to make you turn toward gunfire.

export type Sound =
  | 'fire'
  | 'hit'
  | 'shield'
  | 'kill'
  | 'death'
  | 'pickup'
  | 'scatter'
  | 'siege'
  | 'streak'
  | 'block'
  | 'respawn'
  | 'dry'
  | 'reload'
  | 'siren'
  | 'blast'
  | 'rattle'
  | 'fall'

export interface PlayOpts {
  /** Where it happened, in arena pixels. Omit for something that happened to you. */
  at?: { x: number; y: number }
  /** Listener position, i.e. your own tank. Required for `at` to mean anything. */
  ear?: { x: number; y: number }
  /** Extra multiplier, e.g. hue-tinted pickups. */
  gain?: number
}

/** Past this many pixels a sound is inaudible. Roughly one board width. */
const EARSHOT = 1400

const STORAGE_KEY = 'tank.sound'
const VOLUME_KEY = 'tank.volume'

/**
 * Where the master gain sat before there was a way to move it.
 *
 * The slider is a fraction of *full scale*, not of this, so the default is
 * exactly what the game has always sounded like and a player who wants it
 * louder can have that too. Anything above about 0.8 clips on a laptop
 * speaker when a nuke goes off, which is a thing they are allowed to choose.
 */
const DEFAULT_VOLUME = 0.5

export class Sfx {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noiseBuffer: AudioBuffer | null = null
  muted: boolean
  /** Master level, 0..1. Persisted, and applied live while a round is running. */
  private level: number

  constructor() {
    let saved: string | null = null
    try {
      saved = localStorage.getItem(STORAGE_KEY)
    } catch {
      /* private mode */
    }
    this.muted = saved === 'off'
    let vol: string | null = null
    try {
      vol = localStorage.getItem(VOLUME_KEY)
    } catch {
      /* private mode */
    }
    const parsed = vol === null ? NaN : Number(vol)
    // A stored value that is not a number in range is treated as absent rather
    // than clamped to an edge: someone else's key, or a half-written one, must
    // not silently mute the game or pin it to full.
    this.level = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : DEFAULT_VOLUME
  }

  /** Master level, 0..1. */
  get volume(): number {
    return this.level
  }

  /**
   * Move the master level, now rather than at the next sound.
   *
   * Applied to the live gain node so a slider is audible while it is being
   * dragged — a volume control you have to fire a shell to hear is a volume
   * control nobody trusts. Muted stays muted: the two are independent, so
   * unmuting returns you to the level you chose rather than to the default.
   */
  setVolume(v: number): void {
    this.level = Math.max(0, Math.min(1, v))
    try {
      localStorage.setItem(VOLUME_KEY, String(this.level))
    } catch {
      /* private mode */
    }
    if (this.master && !this.muted) this.master.gain.value = this.level
  }

  /**
   * Call from a click handler. Safe to call repeatedly — a context that was
   * created while the page was still untrusted comes back `suspended`, and the
   * only fix is to resume it from a later gesture.
   */
  unlock(): void {
    if (this.muted) return
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      try {
        this.ctx = new Ctor()
      } catch {
        return
      }
      this.master = this.ctx.createGain()
      this.master.gain.value = this.level
      this.master.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  /** True once a real, unsuspended AudioContext exists. Drives the lobby copy. */
  get running(): boolean {
    return !this.muted && this.ctx?.state === 'running'
  }

  toggle(): boolean {
    this.muted = !this.muted
    try {
      localStorage.setItem(STORAGE_KEY, this.muted ? 'off' : 'on')
    } catch {
      /* private mode */
    }
    if (this.muted) {
      if (this.master) this.master.gain.value = 0
    } else {
      this.unlock()
      if (this.master) this.master.gain.value = this.level
    }
    return this.muted
  }

  play(sound: Sound, opts: PlayOpts = {}): void {
    const ctx = this.ctx
    const master = this.master
    if (!ctx || !master || this.muted || ctx.state !== 'running') return

    let volume = opts.gain ?? 1
    let pan = 0
    if (opts.at && opts.ear) {
      const dx = opts.at.x - opts.ear.x
      const distance = Math.hypot(dx, opts.at.y - opts.ear.y)
      if (distance > EARSHOT) return
      // Falls off toward zero rather than snapping, so a tank driving out of
      // earshot fades instead of cutting.
      volume *= (1 - distance / EARSHOT) ** 1.6
      pan = Math.max(-0.85, Math.min(0.85, dx / (EARSHOT * 0.45)))
    }
    if (volume <= 0.01) return

    const out = this.panned(ctx, master, pan)
    const t = ctx.currentTime
    switch (sound) {
      case 'fire':
        // A crack and a thump: the noise is the muzzle, the falling square is
        // the weight behind it.
        this.noise(ctx, out, t, { dur: 0.09, gain: 0.5 * volume, from: 4200, to: 700 })
        this.tone(ctx, out, t, { type: 'square', from: 300, to: 80, dur: 0.14, gain: 0.28 * volume })
        break
      case 'hit':
        // Yours. Low, close, and unmistakable against a peer's shot.
        this.tone(ctx, out, t, { type: 'sawtooth', from: 190, to: 55, dur: 0.3, gain: 0.4 * volume })
        this.noise(ctx, out, t, { dur: 0.18, gain: 0.3 * volume, from: 1800, to: 300 })
        break
      case 'shield':
        this.tone(ctx, out, t, { type: 'triangle', from: 1250, to: 1250, dur: 0.35, gain: 0.22 * volume })
        this.tone(ctx, out, t, { type: 'triangle', from: 1878, to: 1878, dur: 0.32, gain: 0.16 * volume })
        break
      case 'kill':
        this.tone(ctx, out, t, { type: 'square', from: 660, to: 660, dur: 0.08, gain: 0.22 * volume })
        this.tone(ctx, out, t + 0.08, { type: 'square', from: 990, to: 990, dur: 0.14, gain: 0.22 * volume })
        break
      case 'death':
        this.noise(ctx, out, t, { dur: 0.65, gain: 0.75 * volume, from: 2600, to: 90 })
        this.tone(ctx, out, t, { type: 'sawtooth', from: 150, to: 35, dur: 0.55, gain: 0.35 * volume })
        break
      case 'pickup':
        for (const [i, f] of [523.25, 659.25, 987.77].entries()) {
          this.tone(ctx, out, t + i * 0.055, {
            type: 'triangle',
            from: f,
            to: f,
            dur: 0.16,
            gain: 0.24 * volume,
          })
        }
        break
      case 'scatter':
        // Three taps, because it is three shells. The sound tells you what
        // changed about your gun without reading the banner.
        for (const i of [0, 1, 2]) {
          this.noise(ctx, out, t + i * 0.045, { dur: 0.05, gain: 0.32 * volume, from: 5200, to: 1400 })
          this.tone(ctx, out, t + i * 0.045, {
            type: 'square',
            from: 900,
            to: 640,
            dur: 0.07,
            gain: 0.16 * volume,
          })
        }
        break
      case 'siege':
        // Heavy and low, and slower than anything else in the game. Siege
        // shells are the only pickup that changes what your shots do to
        // somebody else, so it gets the one sound with weight behind it.
        this.tone(ctx, out, t, { type: 'sawtooth', from: 120, to: 52, dur: 0.5, gain: 0.34 * volume })
        this.tone(ctx, out, t + 0.06, { type: 'triangle', from: 330, to: 330, dur: 0.34, gain: 0.14 * volume })
        this.noise(ctx, out, t, { dur: 0.28, gain: 0.26 * volume, from: 1500, to: 200 })
        break
      case 'streak':
        for (const [i, f] of [440, 587.33, 739.99, 1046.5].entries()) {
          this.tone(ctx, out, t + i * 0.07, {
            type: 'square',
            from: f,
            to: f,
            dur: 0.2,
            gain: 0.2 * volume,
          })
        }
        break
      case 'block':
        // The round bell. Long, clean, and nothing else in the game sounds
        // remotely like it, because it is the only sound that means "stop".
        for (const [i, f] of [523.25, 783.99, 1046.5].entries()) {
          this.tone(ctx, out, t + i * 0.012, {
            type: 'sine',
            from: f,
            to: f,
            dur: 1.5,
            gain: 0.3 * volume,
          })
        }
        break
      case 'respawn':
        this.tone(ctx, out, t, { type: 'triangle', from: 220, to: 440, dur: 0.22, gain: 0.22 * volume })
        break
      case 'dry':
        // The magazine ran out. A dull mechanical clack — deliberately not
        // musical, because it has to be legible under a firefight as "that was
        // the last one" rather than as another shot.
        this.noise(ctx, out, t, { dur: 0.05, gain: 0.32 * volume, from: 2600, to: 900 })
        this.tone(ctx, out, t, { type: 'square', from: 160, to: 90, dur: 0.07, gain: 0.16 * volume })
        break
      case 'siren':
        // The air-strike warning. A two-note rise and fall, long enough to be a
        // sentence rather than a blip: it is the only sound in the game that
        // means "move", and a player has about two seconds to act on it.
        this.tone(ctx, out, t, { type: 'sawtooth', from: 420, to: 620, dur: 0.5, gain: 0.2 * volume })
        this.tone(ctx, out, t + 0.5, { type: 'sawtooth', from: 620, to: 380, dur: 0.6, gain: 0.2 * volume })
        break
      case 'blast':
        // One bomb. Heavier and lower than a shell hit, and mostly noise —
        // a run of nine of these 190ms apart should read as a rolling wall
        // rather than as nine separate events.
        this.noise(ctx, out, t, { dur: 0.42, gain: 0.7 * volume, from: 1800, to: 60 })
        this.tone(ctx, out, t, { type: 'sawtooth', from: 110, to: 28, dur: 0.4, gain: 0.4 * volume })
        break
      case 'rattle':
        // One round out of the chopper's gun. Played about nine times a second
        // while it fires, so each one is deliberately tiny and mostly noise —
        // the rhythm is the machinegun, not any single report.
        this.noise(ctx, out, t, { dur: 0.045, gain: 0.34 * volume, from: 5200, to: 1000 })
        this.tone(ctx, out, t, { type: 'square', from: 230, to: 120, dur: 0.05, gain: 0.1 * volume })
        break
      case 'fall':
        // Off the rim of an edgeless board. A long dive — the pitch falls for
        // over a second, which is what sells distance — and a soft, late thud
        // from somewhere far below. Distinct from 'death' on purpose: no blast,
        // because nothing exploded; the tank just left.
        this.tone(ctx, out, t, { type: 'sawtooth', from: 640, to: 60, dur: 1.15, gain: 0.3 * volume })
        this.tone(ctx, out, t, { type: 'triangle', from: 880, to: 110, dur: 1.0, gain: 0.16 * volume })
        this.noise(ctx, out, t + 1.15, { dur: 0.3, gain: 0.35 * volume, from: 700, to: 50 })
        break
      case 'reload':
        // Two clacks and a rising note: the magazine going home. The rise is
        // what makes it read as *ready* rather than as one more empty click.
        this.noise(ctx, out, t, { dur: 0.04, gain: 0.22 * volume, from: 3000, to: 1200 })
        this.noise(ctx, out, t + 0.07, { dur: 0.05, gain: 0.26 * volume, from: 2200, to: 700 })
        this.tone(ctx, out, t + 0.07, { type: 'triangle', from: 330, to: 560, dur: 0.16, gain: 0.2 * volume })
        break
    }
  }

  private panned(ctx: AudioContext, master: GainNode, pan: number): AudioNode {
    if (pan === 0 || !ctx.createStereoPanner) return master
    const node = ctx.createStereoPanner()
    node.pan.value = pan
    node.connect(master)
    return node
  }

  private tone(
    ctx: AudioContext,
    out: AudioNode,
    at: number,
    o: { type: OscillatorType; from: number; to: number; dur: number; gain: number },
  ): void {
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = o.type
    osc.frequency.setValueAtTime(o.from, at)
    if (o.to !== o.from) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), at + o.dur)
    // Ramp rather than set: an envelope that starts at full volume clicks, and
    // a click on every shot is the whole reason synthesised audio sounds cheap.
    g.gain.setValueAtTime(0.0001, at)
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.gain), at + 0.008)
    g.gain.exponentialRampToValueAtTime(0.0001, at + o.dur)
    osc.connect(g).connect(out)
    osc.start(at)
    osc.stop(at + o.dur + 0.02)
  }

  private noise(
    ctx: AudioContext,
    out: AudioNode,
    at: number,
    o: { dur: number; gain: number; from: number; to: number },
  ): void {
    if (!this.noiseBuffer) {
      const frames = Math.floor(ctx.sampleRate * 1.2)
      const buf = ctx.createBuffer(1, frames, ctx.sampleRate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1
      this.noiseBuffer = buf
    }
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuffer
    // Start somewhere random in the buffer so twenty shells in a row are not
    // twenty copies of the same crackle.
    const offset = Math.random() * 0.5
    const filter = ctx.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(o.from, at)
    filter.frequency.exponentialRampToValueAtTime(Math.max(40, o.to), at + o.dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(Math.max(0.0002, o.gain), at)
    g.gain.exponentialRampToValueAtTime(0.0001, at + o.dur)
    src.connect(filter).connect(g).connect(out)
    src.start(at, offset, o.dur + 0.05)
  }
}

/** What `Game` calls. A no-op by default so the netcode never depends on audio. */
export type SoundSink = (sound: Sound, opts?: PlayOpts) => void
export const silence: SoundSink = () => {}
