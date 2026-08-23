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

export interface Tip {
  height: number
  hash: string
}

const SOURCES = ['https://mempool.space/api', 'https://blockstream.info/api']

/** Blocks are ten minutes apart on average; this is responsive without being rude. */
const POLL_MS = 20_000

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
    if (best) this.accept(best)
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
    this.tip = tip
    for (const fn of this.listeners) fn(tip, previous)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.controller.abort()
  }
}
