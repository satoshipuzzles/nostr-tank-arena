// The Bitcoin chain tip, used as the game clock.
//
// A round lasts one block. That is not a gimmick — it is the only round timer
// available to a game with no server. Every client can independently discover
// the same number at roughly the same moment, nobody has to be the host, nobody
// has to announce "round over", and a player who joins halfway through knows
// exactly which round they joined. The block hash then picks the map, so the
// arena also changes every round with no message passing at all.
//
// ## What this trusts, stated plainly
//
// A block explorer over HTTPS. That is a real dependency and it is worth being
// honest about what it can do:
//
//   - It can be wrong or offline. Then the round simply never ends and the game
//     falls back to the default map. Nothing breaks, the match just becomes the
//     endless deathmatch it was before.
//   - It can lie about the height. Everyone reading the same explorer agrees
//     anyway, so a lie shifts when rounds flip rather than desynchronising
//     anybody. Two clients on two explorers can disagree for a few seconds at a
//     boundary, which costs nothing.
//   - It cannot affect the simulation, hit detection, or scores. It picks a
//     round number and a map index.
//
// Two sources are queried, and the higher tip wins: a chain tip only ever goes
// up, so "higher" is the one that has seen more of the chain. If your own node
// is nicer, `?blocks=https://your.node/api` overrides both.

/**
 * What is known about one block's mined-at time.
 *
 * `unavailable` is deliberately terminal per hash and is never retried. A
 * successful retry mid-round would be exactly the reshuffle this type exists to
 * prevent — a round that has fallen back to the shared-unix clock stays there
 * until the next block, which costs nothing and keeps every client on one
 * timeline for the whole round.
 */
export type TimeState =
  | { state: 'pending' }
  | { state: 'known'; time: number }
  | { state: 'unavailable' }

export interface Tip {
  height: number
  hash: string
  /**
   * When the block was mined, unix seconds. Optional because the tip is useful
   * without it: the height picks the round and the hash picks the map and the
   * rules, and none of that waits on a third request. It arrives a beat later
   * and turns the HUD's block line into a clock.
   */
  time?: number
}

const SOURCES = ['https://mempool.space/api', 'https://blockstream.info/api']

/** Blocks are ten minutes apart on average; this is responsive without being rude. */
const POLL_MS = 20_000

/**
 * When a block was mined.
 *
 * A separate request, and deliberately not awaited alongside the tip: a player
 * needs the height and the hash to start playing, and does not need the clock
 * for another second. Failing here costs the count-up display and nothing else.
 */
async function readTime(base: string, hash: string, signal: AbortSignal): Promise<number | null> {
  try {
    const block = (await fetch(`${base}/block/${hash}`, { signal }).then((r) =>
      r.ok ? r.json() : Promise.reject(new Error(String(r.status))),
    )) as { timestamp?: number }
    const t = Number(block?.timestamp)
    // Sanity bound: a wrong timestamp would render as a clock counting from
    // 1970 or from the future, which reads as a broken game rather than a
    // broken explorer.
    if (!Number.isFinite(t) || t < 1_200_000_000 || t > Date.now() / 1000 + 7200) return null
    return t
  } catch {
    return null
  }
}

async function readTip(base: string, signal: AbortSignal): Promise<Tip | null> {
  try {
    const height = await fetch(`${base}/blocks/tip/height`, { signal }).then((r) =>
      r.ok ? r.text() : Promise.reject(new Error(String(r.status))),
    )
    const hash = await fetch(`${base}/blocks/tip/hash`, { signal }).then((r) =>
      r.ok ? r.text() : Promise.reject(new Error(String(r.status))),
    )
    const n = Number(height.trim())
    const h = hash.trim().toLowerCase()
    if (!Number.isInteger(n) || n <= 0 || !/^[0-9a-f]{64}$/.test(h)) return null
    return { height: n, hash: h }
  } catch {
    return null
  }
}

export class BlockClock {
  tip: Tip | null = null
  /** Set once a fetch has come back, successfully or not. Drives the HUD. */
  reachable = false
  private timer: ReturnType<typeof setInterval> | null = null
  private controller = new AbortController()
  private listeners: ((tip: Tip, previous: Tip | null) => void)[] = []
  /**
   * What we know about each block's mined-at time.
   *
   * Three states, and the third one is load-bearing. This used to be
   * `Map<string, number | null>` where `null` meant both "the request is in
   * flight" and "no explorer would tell me" — and the pickup schedule cannot
   * treat those the same. Anything reading a `null` takes the shared-unix
   * fallback, so a schedule that starts on the fallback and then gets a real
   * timestamp 200ms later recomputes `elapsed` from about 1.79 billion down to
   * about 300, changes every pickup id at once, and reshuffles the board — at
   * each client's own HTTP latency, which is two clients on two timelines
   * again. `pending` is what lets the caller wait instead of guessing.
   */
  private timeFor = new Map<string, TimeState>()
  /** Local clock when this client first saw the current tip, as a fallback. */
  private sawTipAt = Date.now()
  private readonly sources: string[]

  constructor(override?: string | null) {
    this.sources = override ? [override, ...SOURCES] : SOURCES
  }

  /** Fires on the first tip and on every height increase after it. */
  onBlock(fn: (tip: Tip, previous: Tip | null) => void): void {
    this.listeners.push(fn)
  }

  async start(): Promise<void> {
    await this.poll()
    this.timer = setInterval(() => void this.poll(), POLL_MS)
  }

  private async poll(): Promise<void> {
    const results = await Promise.all(
      this.sources.map((base) => readTip(base, this.controller.signal)),
    )
    // A tip only ever goes up, so the highest answer is the freshest one.
    const best = results.filter((t): t is Tip => t !== null).sort((a, b) => b.height - a.height)[0]
    this.reachable = !!best
    if (best) {
      this.accept(best)
      void this.fillTime(best.hash)
    }
  }

  /**
   * Fetch the mined-at time for a hash, once, in the background.
   *
   * Attached to the tip rather than passed around, and only if the tip has not
   * moved on in the meantime — a late answer for a block that is no longer the
   * tip would set the clock backwards.
   */
  private async fillTime(hash: string): Promise<void> {
    const held = this.timeFor.get(hash)
    if (held) {
      if (held.state === 'known' && this.tip?.hash === hash) this.tip.time = held.time
      return
    }
    this.timeFor.set(hash, { state: 'pending' })
    for (const base of this.sources) {
      const t = await readTime(base, hash, this.controller.signal)
      if (t === null) continue
      this.timeFor.set(hash, { state: 'known', time: t })
      if (this.tip?.hash === hash) this.tip.time = t
      return
    }
    // Every source refused. Terminal: see `TimeState` for why this is never
    // retried.
    this.timeFor.set(hash, { state: 'unavailable' })
  }

  /**
   * Seconds since the tip was mined.
   *
   * Falls back to when this client first saw the block, which is the honest
   * answer when the explorer would not give a timestamp: it is a lower bound,
   * and it still counts up at one second per second, which is the part that
   * makes the round feel like it has a clock.
   */
  secondsSinceTip(nowMs = Date.now()): number | null {
    if (!this.tip) return null
    const from = this.tip.time ? this.tip.time * 1000 : this.sawTipAt
    return Math.max(0, (nowMs - from) / 1000)
  }

  /** True when the count is measured rather than assumed. */
  get tipTimeKnown(): boolean {
    return typeof this.tip?.time === 'number'
  }

  /**
   * Seconds since the tip was mined, or `null` if that is not actually known.
   *
   * The difference from `secondsSinceTip()` is the whole point. That one is for
   * the HUD and falls back to local first-sighting, which is honest to show and
   * marked with a `~`. This one refuses to guess, because its caller is the
   * pickup schedule: a wave index computed from *when this client happened to
   * poll* is a timeline of one, and two clients out of phase then compute
   * different ids for the same pad and silently discard each other's claims.
   *
   * `null` is not a failure here — the caller has a shared fallback (absolute
   * unix seconds) that a local origin could never be.
   */
  chainSeconds(nowMs = Date.now()): number | null {
    const mined = this.tip?.time
    return typeof mined === 'number' ? Math.max(0, nowMs / 1000 - mined) : null
  }

  /**
   * True while we are still waiting to find out when this block was mined.
   *
   * The pickup schedule must not derive anything during this window. An empty
   * board for one HTTP round trip at the start of a round is invisible — wave
   * zero has barely begun — and it is strictly better than a board that spawns
   * on the fallback clock and reshuffles the instant the real timestamp lands.
   */
  get chainPending(): boolean {
    if (!this.tip || this.tip.time !== undefined) return false
    return (this.timeFor.get(this.tip.hash)?.state ?? 'pending') === 'pending'
  }

  /**
   * Take a tip from anywhere and, if it is newer, start a round on it.
   *
   * Public because polling a real explorer is not the only way to get one. The
   * smoke test drives a block transition through here rather than waiting ten
   * minutes for the chain, and it is the hook to use when developing against a
   * regtest node.
   */
  accept(tip: Tip): void {
    if (this.tip && tip.height <= this.tip.height) return
    const previous = this.tip
    const held = this.timeFor.get(tip.hash)
    const cached = held?.state === 'known' ? held.time : undefined
    this.tip = { ...tip, time: tip.time ?? cached }
    // A tip handed in with its own timestamp — the smoke test does this — is
    // known immediately and must not spend a round trip pending.
    if (this.tip.time !== undefined && !held) {
      this.timeFor.set(tip.hash, { state: 'known', time: this.tip.time })
    }
    this.sawTipAt = Date.now()
    for (const fn of this.listeners) fn(this.tip, previous)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.controller.abort()
  }
}
