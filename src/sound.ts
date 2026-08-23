// Every sound in the game, synthesised at runtime. No .wav files, no fetch, no
// loading screen — the bundle is the same size with audio as it was without it.
//
// Two decisions drive the shape of this file:
//
//   * **Voices are pure functions of (context, destination, startTime).** They
//     never read a singleton and never touch the clock themselves. That is what
//     lets the test render them into an OfflineAudioContext and measure the
//     samples that come out. A sound test that only asserts "the function was
//     called" proves nothing at all — the thing that breaks is a disconnected
//     node or an envelope that never opens, and both of those still call fine.
//
//   * **Nothing here is allowed to throw.** Audio is garnish. A browser with no
//     AudioContext, a tab that refuses to resume, an OS with no output device —
//     all of them must end with a silent game, not a broken one. Every public
//     method is wrapped, and `Sfx` with a null context is a complete no-op.

/** White noise, one second of it, made once per context and reused. */
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>()

function noise(ctx: BaseAudioContext): AudioBuffer {
  let buf = noiseCache.get(ctx)
  if (!buf) {
    buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate), ctx.sampleRate)
    const d = buf.getChannelData(0)
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
    noiseCache.set(ctx, buf)
  }
  return buf
}

/**
 * Percussive gain envelope: silent, snap open, decay away.
 *
 * `exponentialRampToValueAtTime` cannot ramp to zero — it is a multiply, so
 * zero is unreachable and Chrome throws on the attempt. Ramp to a floor and
 * cut with `setValueAtTime` instead, which is also why every voice below has
 * an explicit stop time.
 */
function env(
  ctx: BaseAudioContext,
  peak: number,
  t0: number,
  attack: number,
  decay: number,
): GainNode {
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay)
  g.gain.setValueAtTime(0, t0 + attack + decay)
  return g
}

function tone(
  ctx: BaseAudioContext,
  type: OscillatorType,
  from: number,
  to: number,
  t0: number,
  dur: number,
): OscillatorNode {
  const o = ctx.createOscillator()
  o.type = type
  o.frequency.setValueAtTime(from, t0)
  if (to !== from) o.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t0 + dur)
  o.start(t0)
  o.stop(t0 + dur + 0.02)
  return o
}

function burst(
  ctx: BaseAudioContext,
  t0: number,
  dur: number,
  filter: { type: BiquadFilterType; freq: number; q?: number },
): AudioBufferSourceNode {
  const src = ctx.createBufferSource()
  src.buffer = noise(ctx)
  src.loop = true
  // Start at a random offset so two shots fired together are not the identical
  // waveform twice, which reads as a single louder shot rather than two.
  src.start(t0, Math.random() * 0.8, dur + 0.05)
  const bq = ctx.createBiquadFilter()
  bq.type = filter.type
  bq.frequency.setValueAtTime(filter.freq, t0)
  if (filter.q !== undefined) bq.Q.setValueAtTime(filter.q, t0)
  src.connect(bq)
  // The caller connects the filter onward; returning the source keeps the
  // signature honest about what has to be stopped.
  ;(src as AudioBufferSourceNode & { out?: AudioNode }).out = bq
  return src
}

const outOf = (src: AudioBufferSourceNode): AudioNode =>
  (src as AudioBufferSourceNode & { out?: AudioNode }).out ?? src

// --------------------------------------------------------------- the voices
//
// Each returns the time it finishes, so the offline test knows how long to
// render and the caller can chain if it ever wants to.

/** Your own gun. Body thump under a cracking transient. */
export function voiceFire(ctx: BaseAudioContext, dest: AudioNode, t0: number, gain = 1): number {
  const dur = 0.3

  const body = tone(ctx, 'triangle', 190, 42, t0, 0.22)
  const bodyEnv = env(ctx, 0.5 * gain, t0, 0.004, 0.2)
  body.connect(bodyEnv).connect(dest)

  const crack = burst(ctx, t0, 0.12, { type: 'highpass', freq: 900 })
  const crackEnv = env(ctx, 0.34 * gain, t0, 0.002, 0.1)
  outOf(crack).connect(crackEnv).connect(dest)

  return t0 + dur
}

/** Somebody else's gun, heard across the arena. Same shot, less crack. */
export function voiceRemoteFire(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t0: number,
  gain = 1,
): number {
  const body = tone(ctx, 'triangle', 150, 38, t0, 0.24)
  const bodyEnv = env(ctx, 0.42 * gain, t0, 0.006, 0.22)
  body.connect(bodyEnv).connect(dest)

  const crack = burst(ctx, t0, 0.1, { type: 'bandpass', freq: 620, q: 0.9 })
  const crackEnv = env(ctx, 0.22 * gain, t0, 0.003, 0.09)
  outOf(crack).connect(crackEnv).connect(dest)

  return t0 + 0.3
}

/** A shell of yours struck someone. Short, bright, unmistakably a hit. */
export function voiceStruck(ctx: BaseAudioContext, dest: AudioNode, t0: number, gain = 1): number {
  const ping = tone(ctx, 'square', 1180, 880, t0, 0.09)
  const pingEnv = env(ctx, 0.16 * gain, t0, 0.002, 0.08)
  ping.connect(pingEnv).connect(dest)

  const tick = burst(ctx, t0, 0.05, { type: 'bandpass', freq: 2600, q: 2 })
  const tickEnv = env(ctx, 0.14 * gain, t0, 0.001, 0.045)
  outOf(tick).connect(tickEnv).connect(dest)

  return t0 + 0.12
}

/**
 * You took a hit. Deliberately the ugliest sound in the game: a metallic clang
 * with a detuned partial so it beats against itself, over a low thud you feel
 * more than hear. It has to cut through your own gunfire, because the whole
 * point of it is telling you to break off.
 */
export function voiceHit(ctx: BaseAudioContext, dest: AudioNode, t0: number, gain = 1): number {
  const clang = tone(ctx, 'square', 420, 240, t0, 0.26)
  const clangEnv = env(ctx, 0.3 * gain, t0, 0.002, 0.24)
  clang.connect(clangEnv).connect(dest)

  const beat = tone(ctx, 'square', 437, 251, t0, 0.26)
  const beatEnv = env(ctx, 0.16 * gain, t0, 0.002, 0.24)
  beat.connect(beatEnv).connect(dest)

  const thud = tone(ctx, 'sine', 110, 55, t0, 0.2)
  const thudEnv = env(ctx, 0.45 * gain, t0, 0.005, 0.18)
  thud.connect(thudEnv).connect(dest)

  const shrapnel = burst(ctx, t0, 0.22, { type: 'highpass', freq: 1500 })
  const shrapnelEnv = env(ctx, 0.2 * gain, t0, 0.003, 0.2)
  outOf(shrapnel).connect(shrapnelEnv).connect(dest)

  return t0 + 0.32
}

/** You died. Long, falling, and the only sound allowed to take half a second. */
export function voiceDeath(ctx: BaseAudioContext, dest: AudioNode, t0: number, gain = 1): number {
  const boom = tone(ctx, 'sawtooth', 160, 28, t0, 0.65)
  const boomEnv = env(ctx, 0.5 * gain, t0, 0.01, 0.62)
  boom.connect(boomEnv).connect(dest)

  const blast = burst(ctx, t0, 0.7, { type: 'lowpass', freq: 900 })
  const blastEnv = env(ctx, 0.42 * gain, t0, 0.006, 0.66)
  outOf(blast).connect(blastEnv).connect(dest)

  return t0 + 0.75
}

/** Somebody else died, somewhere on the board. The same blast, further away. */
export function voiceRemoteDeath(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t0: number,
  gain = 1,
): number {
  const boom = tone(ctx, 'sawtooth', 120, 30, t0, 0.45)
  const boomEnv = env(ctx, 0.3 * gain, t0, 0.01, 0.42)
  boom.connect(boomEnv).connect(dest)

  const blast = burst(ctx, t0, 0.45, { type: 'lowpass', freq: 520 })
  const blastEnv = env(ctx, 0.28 * gain, t0, 0.008, 0.42)
  outOf(blast).connect(blastEnv).connect(dest)

  return t0 + 0.5
}

/** A kill credited to you. Two notes up — the only unambiguously good news. */
export function voiceKill(ctx: BaseAudioContext, dest: AudioNode, t0: number, gain = 1): number {
  for (const [i, f] of [660, 990].entries()) {
    const at = t0 + i * 0.08
    const o = tone(ctx, 'triangle', f, f, at, 0.13)
    o.connect(env(ctx, 0.26 * gain, at, 0.004, 0.12)).connect(dest)
  }
  return t0 + 0.24
}

/**
 * A kill streak. The arpeggio climbs a scale degree per kill and then stops
 * climbing, because a streak of eleven should sound impressive rather than
 * like a kettle.
 */
export function voiceStreak(
  ctx: BaseAudioContext,
  dest: AudioNode,
  t0: number,
  streak: number,
  gain = 1,
): number {
  const step = Math.min(Math.max(streak - 2, 0), 6)
  const root = 392 * Math.pow(2, step / 12)
  const notes = [root, root * 1.25, root * 1.5, root * 2]
  let at = t0
  for (const f of notes) {
    const o = tone(ctx, 'square', f, f, at, 0.1)
    const g = env(ctx, 0.13 * gain, at, 0.005, 0.09)
    // Soften the square into something closer to a chiptune bell.
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.setValueAtTime(f * 3.5, at)
    o.connect(lp).connect(g).connect(dest)
    at += 0.07
  }
  return at + 0.12
}

/** Hull repaired. Warm and rising, no percussion — it is a relief, not an event. */
export function voiceRepair(ctx: BaseAudioContext, dest: AudioNode, t0: number, gain = 1): number {
  const o = tone(ctx, 'sine', 330, 660, t0, 0.3)
  o.connect(env(ctx, 0.22 * gain, t0, 0.05, 0.26)).connect(dest)
  const shimmer = tone(ctx, 'sine', 990, 1320, t0 + 0.05, 0.22)
  shimmer.connect(env(ctx, 0.07 * gain, t0 + 0.05, 0.04, 0.2)).connect(dest)
  return t0 + 0.38
}

/** Back on the board. A short upward whoosh, filtered noise only. */
export function voiceRespawn(ctx: BaseAudioContext, dest: AudioNode, t0: number, gain = 1): number {
  const src = burst(ctx, t0, 0.35, { type: 'bandpass', freq: 300, q: 1.2 })
  const bq = outOf(src) as BiquadFilterNode
  bq.frequency.exponentialRampToValueAtTime(2400, t0 + 0.33)
  bq.connect(env(ctx, 0.3 * gain, t0, 0.08, 0.26)).connect(dest)
  return t0 + 0.4
}

/** You drove over a pickup. Bright, clean, obviously a reward. */
export function voicePickup(ctx: BaseAudioContext, dest: AudioNode, t0: number, gain = 1): number {
  for (const [i, f] of [880, 1320, 1760].entries()) {
    const at = t0 + i * 0.055
    const o = tone(ctx, 'sine', f, f, at, 0.16)
    o.connect(env(ctx, 0.2 * gain, at, 0.004, 0.15)).connect(dest)
  }
  return t0 + 0.3
}

/**
 * A block landed and the round turned over.
 *
 * The one sound with a job beyond feedback: it is the round clock made audible.
 * Everybody in the room hears it within a few seconds of everybody else without
 * a single message passing between them, because they are all watching the same
 * chain tip. So it is a bell — five inharmonic partials, long decay — and it is
 * the loudest thing in the mix.
 */
export function voiceBlock(ctx: BaseAudioContext, dest: AudioNode, t0: number, gain = 1): number {
  const partials: [number, number, number][] = [
    // frequency, level, decay
    [523.25, 0.3, 1.6],
    [1046.5, 0.18, 1.3],
    [1567.98, 0.1, 0.9],
    [2093.0, 0.06, 0.7],
    [784.0, 0.12, 1.5],
  ]
  for (const [f, level, decay] of partials) {
    const o = tone(ctx, 'sine', f, f, t0, decay)
    o.connect(env(ctx, level * gain, t0, 0.006, decay - 0.01)).connect(dest)
  }
  // A soft strike transient so it reads as struck rather than faded in.
  const strike = burst(ctx, t0, 0.08, { type: 'bandpass', freq: 3200, q: 1.5 })
  outOf(strike).connect(env(ctx, 0.1 * gain, t0, 0.001, 0.07)).connect(dest)
  return t0 + 1.7
}

/** Every voice, by name. The test iterates this, so adding one tests it too. */
export const VOICES: Record<string, (c: BaseAudioContext, d: AudioNode, t: number) => number> = {
  fire: (c, d, t) => voiceFire(c, d, t),
  remoteFire: (c, d, t) => voiceRemoteFire(c, d, t),
  struck: (c, d, t) => voiceStruck(c, d, t),
  hit: (c, d, t) => voiceHit(c, d, t),
  death: (c, d, t) => voiceDeath(c, d, t),
  remoteDeath: (c, d, t) => voiceRemoteDeath(c, d, t),
  kill: (c, d, t) => voiceKill(c, d, t),
  streak: (c, d, t) => voiceStreak(c, d, t, 4),
  repair: (c, d, t) => voiceRepair(c, d, t),
  respawn: (c, d, t) => voiceRespawn(c, d, t),
  pickup: (c, d, t) => voicePickup(c, d, t),
  block: (c, d, t) => voiceBlock(c, d, t),
}

// ------------------------------------------------------------------- engine

/**
 * The idling engine.
 *
 * Two detuned saws through a lowpass, pitch and cutoff following the throttle.
 * It is the only continuous sound in the game and it does more for the feel of
 * driving than any of the one-shots, because it is the only thing that responds
 * to input on every frame rather than on events.
 */
class Engine {
  private readonly osc: OscillatorNode[] = []
  private readonly gain: GainNode
  private readonly lp: BiquadFilterNode
  private running = false

  constructor(
    private readonly ctx: AudioContext,
    dest: AudioNode,
  ) {
    this.gain = ctx.createGain()
    this.gain.gain.value = 0
    this.lp = ctx.createBiquadFilter()
    this.lp.type = 'lowpass'
    this.lp.frequency.value = 260
    for (const detune of [-7, 5]) {
      const o = ctx.createOscillator()
      o.type = 'sawtooth'
      o.frequency.value = 46
      o.detune.value = detune
      o.connect(this.lp)
      this.osc.push(o)
    }
    this.lp.connect(this.gain).connect(dest)
  }

  /** `load` is 0 idling, 1 flat out. `alive` false silences it (you are dead). */
  set(load: number, alive: boolean): void {
    if (!this.running) {
      for (const o of this.osc) o.start()
      this.running = true
    }
    const t = this.ctx.currentTime
    const target = alive ? 0.05 + load * 0.13 : 0
    // Short ramps rather than jumps: a stepped gain on a saw is an audible
    // click, and this is set every frame.
    this.gain.gain.setTargetAtTime(target, t, 0.08)
    for (const o of this.osc) o.frequency.setTargetAtTime(44 + load * 40, t, 0.1)
    this.lp.frequency.setTargetAtTime(240 + load * 620, t, 0.1)
  }

  stop(): void {
    for (const o of this.osc) {
      try {
        o.stop()
      } catch {
        /* already stopped */
      }
    }
  }
}

// ---------------------------------------------------------------------- sfx

const STORE_KEY = 'tank.sound'

/** How far away a sound is still audible, in arena pixels. */
const EARSHOT = 1400

export interface Listener {
  x: number
  y: number
}

/**
 * The game's handle on all of the above.
 *
 * Positional calls take world coordinates and are attenuated and panned
 * relative to `listener`, which the game points at the local tank. It is not a
 * real spatialiser — the board is seen from above and slightly behind, so a
 * full HRTF would be a lie about a camera that is not your head. Distance
 * falloff plus stereo placement is the honest amount of positioning, and it is
 * enough to turn and look at a shot you did not see fired.
 */
export class Sfx {
  readonly ctx: AudioContext | null
  readonly listener: Listener = { x: 0, y: 0 }
  private master: GainNode | null = null
  private engineVoice: Engine | null = null
  private _muted = false
  /** Guards against a burst of identical events all landing in one frame. */
  private lastAt = new Map<string, number>()

  constructor(ctx?: AudioContext | null) {
    this.ctx = ctx ?? Sfx.makeContext()
    this._muted = Sfx.storedMute()
    if (!this.ctx) return
    const master = this.ctx.createGain()
    master.gain.value = this._muted ? 0 : 0.9
    // A firefight is four guns, several shells and a death all at once. Without
    // a compressor the sum clips, and clipping on cheap laptop speakers sounds
    // like the game is broken rather than loud.
    const comp = this.ctx.createDynamicsCompressor()
    comp.threshold.value = -18
    comp.ratio.value = 6
    comp.attack.value = 0.003
    comp.release.value = 0.2
    master.connect(comp).connect(this.ctx.destination)
    this.master = master
    this.engineVoice = new Engine(this.ctx, master)
  }

  private static makeContext(): AudioContext | null {
    try {
      const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      return Ctor ? new Ctor() : null
    } catch {
      return null
    }
  }

  private static storedMute(): boolean {
    try {
      return localStorage.getItem(STORE_KEY) === 'off'
    } catch {
      return false
    }
  }

  get muted(): boolean {
    return this._muted
  }

  /** True when audio is genuinely available, so the UI can say so honestly. */
  get available(): boolean {
    return this.ctx !== null
  }

  setMuted(muted: boolean): void {
    this._muted = muted
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.9, this.ctx.currentTime, 0.02)
    }
    try {
      localStorage.setItem(STORE_KEY, muted ? 'off' : 'on')
    } catch {
      /* private mode */
    }
  }

  toggle(): boolean {
    this.setMuted(!this._muted)
    return this._muted
  }

  /**
   * Must be called from inside a user gesture.
   *
   * Every browser starts an AudioContext suspended until the page has been
   * interacted with, and a suspended context accepts every scheduling call
   * without complaint and plays nothing. That is the failure mode this whole
   * file is most likely to hit, so it is wired to the lobby's Play button —
   * the one click that is guaranteed to happen before any sound is wanted.
   */
  resume(): void {
    if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => {})
  }

  // -- positioning ---------------------------------------------------------

  private place(x: number, y: number): { dest: AudioNode; gain: number } | null {
    if (!this.ctx || !this.master) return null
    const dx = x - this.listener.x
    const dy = y - this.listener.y
    const dist = Math.hypot(dx, dy)
    if (dist > EARSHOT) return null
    // Inverse falloff, floored so a shot across the board is quiet, not gone.
    const gain = Math.max(0.12, 1 / (1 + dist / 420))
    let dest: AudioNode = this.master
    try {
      const pan = this.ctx.createStereoPanner()
      pan.pan.value = Math.max(-0.85, Math.min(0.85, dx / 620))
      pan.connect(this.master)
      dest = pan
    } catch {
      /* Safari < 14.1 and friends: centre it rather than drop it */
    }
    return { dest, gain }
  }

  /**
   * Rate limit per sound name.
   *
   * Relays redeliver, four tanks fire at once, and a shell can clip two peers
   * in the same frame. Without this, the compressor ducks the whole mix for a
   * quarter second and the game briefly goes quiet at exactly the loudest
   * moment — which sounds like a bug and is the opposite of one.
   */
  private throttled(name: string, minGapMs: number): boolean {
    const now = this.ctx ? this.ctx.currentTime * 1000 : 0
    const prev = this.lastAt.get(name) ?? -Infinity
    if (now - prev < minGapMs) return true
    this.lastAt.set(name, now)
    return false
  }

  private play(
    name: string,
    voice: (c: BaseAudioContext, d: AudioNode, t: number, g: number) => number,
    opts: { at?: { x: number; y: number }; gain?: number; minGapMs?: number } = {},
  ): void {
    if (!this.ctx || !this.master || this._muted) return
    if (this.ctx.state !== 'running') return
    if (this.throttled(name, opts.minGapMs ?? 30)) return
    try {
      const placed = opts.at ? this.place(opts.at.x, opts.at.y) : { dest: this.master, gain: 1 }
      if (!placed) return
      voice(this.ctx, placed.dest, this.ctx.currentTime, placed.gain * (opts.gain ?? 1))
    } catch {
      /* One bad voice must not take the game down. */
    }
  }

  // -- the game's vocabulary ------------------------------------------------

  fire(): void {
    this.play('fire', voiceFire, { minGapMs: 60 })
  }
  remoteFire(x: number, y: number): void {
    this.play('remoteFire', voiceRemoteFire, { at: { x, y }, minGapMs: 40 })
  }
  struck(x: number, y: number): void {
    this.play('struck', voiceStruck, { at: { x, y }, minGapMs: 40 })
  }
  hit(): void {
    this.play('hit', voiceHit, { minGapMs: 80 })
  }
  death(): void {
    this.play('death', voiceDeath, { minGapMs: 200 })
  }
  remoteDeath(x: number, y: number): void {
    this.play('remoteDeath', voiceRemoteDeath, { at: { x, y }, minGapMs: 120 })
  }
  kill(): void {
    this.play('kill', voiceKill, { minGapMs: 120 })
  }
  streak(n: number): void {
    this.play('streak', (c, d, t, g) => voiceStreak(c, d, t, n, g), { minGapMs: 200 })
  }
  repair(): void {
    this.play('repair', voiceRepair, { minGapMs: 200 })
  }
  respawn(): void {
    this.play('respawn', voiceRespawn, { minGapMs: 200 })
  }
  pickup(x?: number, y?: number): void {
    this.play('pickup', voicePickup, {
      at: x !== undefined && y !== undefined ? { x, y } : undefined,
      minGapMs: 80,
    })
  }
  block(): void {
    this.play('block', voiceBlock, { gain: 1.15, minGapMs: 1000 })
  }

  /** Called every frame from the game loop. Cheap: two setTargetAtTime calls. */
  engine(load: number, alive: boolean): void {
    if (!this.engineVoice || !this.ctx || this.ctx.state !== 'running') return
    try {
      this.engineVoice.set(this._muted ? 0 : Math.min(1, Math.abs(load)), alive && !this._muted)
    } catch {
      /* ignore */
    }
  }

  dispose(): void {
    try {
      this.engineVoice?.stop()
      void this.ctx?.close()
    } catch {
      /* ignore */
    }
  }
}
