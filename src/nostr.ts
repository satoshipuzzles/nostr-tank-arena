import {
  SimplePool,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  type Event,
  type EventTemplate,
  type Filter,
} from 'nostr-tools'

/**
 * Relays that will actually carry this game's traffic.
 *
 * Measured, not guessed. Fifteen public relays were sent 400 ephemeral
 * kind-21000 events at 10Hz — forty seconds of exactly what one player's tick
 * stream looks like — and their OK frames counted
 * (`.scratch/relay-probe.mjs`, 2026-08-23):
 *
 *   relay.primal.net          400/400 accepted
 *   nostr.mom                 400/400
 *   purplerelay.com           400/400
 *   relay.fountain.fm         400/400
 *   relay.nostr.net            60/400  "rate-limited: too many events from
 *                                       this key (60/60s)"
 *   nostr-pub.wellorder.net    13/400  "blocked: spam not permitted"
 *
 * Three of the four relays this game shipped with were failing outright:
 *
 *   relay.damus.io   "rate-limited: you are noting too much", and 503 on the
 *                    day of the measurement
 *   nos.lol          "pow: 28 bits needed" — NIP-13 proof of work, which a
 *                    position tick is never going to pay
 *   relay.nostr.band connection timeouts, and no OK frame either way
 *
 * In a live game that came to **69.8% of publishes rejected**, and none of it
 * was visible: the old `publish()` swallowed every rejection, so a dropped tick
 * looked like a laggy opponent rather than like a relay saying no.
 *
 * The general lesson, since these lists rot: a tick stream is 10 events per
 * second per player, and most public relays cap a key far below that —
 * relay.nostr.net's limit works out to exactly one per second. A relay you run
 * yourself has no cap you did not set, which is why the README recommends one.
 */
export const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://purplerelay.com',
  'wss://relay.fountain.fm',
]

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>
      signEvent(event: EventTemplate): Promise<Event>
    }
  }
}

/**
 * A player has two keys.
 *
 * `pubkey` is who they actually are — an npub from a NIP-07 extension, or a
 * throwaway generated on the spot for guests. It signs exactly twice per match:
 * once to attest the session key, once to publish the final score.
 *
 * `sessionPubkey` signs the ~12Hz tick traffic. Routing every position update
 * through a browser extension would mean an approval dialog per frame, so the
 * session key does that work and the attestation ties it back to the real npub.
 * It never leaves memory and expires with the tab.
 */
export class Identity {
  readonly pubkey: string
  readonly isGuest: boolean
  readonly sessionSecret: Uint8Array
  readonly sessionPubkey: string
  private guestSecret: Uint8Array | null

  private constructor(pubkey: string, isGuest: boolean, guestSecret: Uint8Array | null) {
    this.pubkey = pubkey
    this.isGuest = isGuest
    this.guestSecret = guestSecret
    this.sessionSecret = generateSecretKey()
    this.sessionPubkey = getPublicKey(this.sessionSecret)
  }

  static async fromExtension(): Promise<Identity> {
    if (!window.nostr) throw new Error('No NIP-07 extension found')
    const pubkey = await window.nostr.getPublicKey()
    return new Identity(pubkey, false, null)
  }

  static guest(): Identity {
    const sk = generateSecretKey()
    return new Identity(getPublicKey(sk), true, sk)
  }

  get npub(): string {
    return nip19.npubEncode(this.pubkey)
  }

  /** Sign with the real identity. Prompts the extension for non-guests. */
  async signAsSelf(template: EventTemplate): Promise<Event> {
    if (this.guestSecret) return finalizeEvent(template, this.guestSecret)
    if (!window.nostr) throw new Error('No NIP-07 extension found')
    return window.nostr.signEvent(template)
  }

  /** Sign with the in-memory session key. No prompt, safe to call at tick rate. */
  signAsSession(template: EventTemplate): Event {
    return finalizeEvent(template, this.sessionSecret)
  }
}

/** What a relay has been saying about our publishes lately. */
export interface RelayTrouble {
  url: string
  /** The relay's own words from the OK frame, e.g. "rate-limited: slow down". */
  reason: string
  count: number
  at: number
}

export class Net {
  private pool = new SimplePool()
  private closers: { close(): void }[] = []
  readonly relays: string[]

  /**
   * Rejected publishes, by relay.
   *
   * This exists because the previous version of `publish()` did
   * `p.catch(() => {})` on every relay promise — which meant an
   * `["OK", <id>, false, "rate-limited: ..."]` frame was indistinguishable from
   * success. Public relays commonly cap a few events per second per pubkey, and
   * this game publishes a position tick ten times a second, so that cap is not
   * hypothetical. Dropped ticks look exactly like a peer lagging or a shell
   * that never existed, and nothing in the client would have said otherwise.
   */
  readonly trouble = new Map<string, RelayTrouble>()
  private published = 0
  private rejected = 0
  /**
   * Relays we have stopped publishing to.
   *
   * A relay that has refused this many in a row is not having a bad minute, it
   * has a policy — proof of work, or an allowlist, or a rate cap far below tick
   * rate. Continuing to send it ten events a second wastes a third of the
   * uplink and delays the relays that are listening. Subscriptions stay open:
   * refusing to take our events says nothing about whether it will forward
   * somebody else's.
   */
  private muted = new Set<string>()
  private strikes = new Map<string, number>()
  private static readonly MUTE_AFTER = 15

  constructor(relays: string[] = DEFAULT_RELAYS) {
    this.relays = relays
  }

  subscribe(filter: Filter, onevent: (e: Event) => void): void {
    this.closers.push(this.pool.subscribeMany(this.relays, filter, { onevent }))
  }

  /** One-shot query across all relays. Used for the leaderboard, never in the loop. */
  async list(filter: Filter): Promise<Event[]> {
    return this.pool.querySync(this.relays, filter, { maxWait: 4000 })
  }

  /**
   * Publish, and listen to what the relay says back.
   *
   * Still fire-and-forget in the sense that nothing is retried — a tick that
   * missed is worthless by the time we could send it again, and the next one is
   * 100ms away. What changed is that the refusal is counted and attributed, so
   * "why is everyone teleporting" has an answer on screen instead of being a
   * mystery about the netcode.
   */
  publish(event: Event): void {
    const targets = this.relays.filter((url) => !this.muted.has(url))
    if (!targets.length) return
    const results = this.pool.publish(targets, event)
    this.published += results.length
    results.forEach((p, i) => {
      const url = targets[i]
      p.then(
        () => {
          this.strikes.set(url, 0)
          const known = this.trouble.get(url)
          // One clean publish is not proof the relay is happy, but a run of
          // them is: let an old complaint age out rather than sticking forever.
          if (known && Date.now() - known.at > 20_000) this.trouble.delete(url)
        },
        (err: unknown) => {
          this.rejected++
          const reason = (err instanceof Error ? err.message : String(err)).slice(0, 120)
          const known = this.trouble.get(url)
          this.trouble.set(url, {
            url,
            reason,
            count: known && known.reason === reason ? known.count + 1 : 1,
            at: Date.now(),
          })
          const strikes = (this.strikes.get(url) ?? 0) + 1
          this.strikes.set(url, strikes)
          if (strikes >= Net.MUTE_AFTER) this.muted.add(url)
        },
      )
    })
  }

  /** Relays we gave up publishing to this session. */
  get mutedRelays(): string[] {
    return [...this.muted]
  }

  /** A one-line summary for the HUD, or '' when every relay is taking events. */
  troubleSummary(): string {
    if (this.muted.size) {
      const hosts = [...this.muted].map((u) => {
        try {
          return new URL(u).host
        } catch {
          return u
        }
      })
      return `not publishing to ${hosts.join(', ')} — it refuses our events`
    }
    const recent = [...this.trouble.values()].filter((t) => Date.now() - t.at < 20_000)
    if (!recent.length) return ''
    const worst = recent.sort((a, b) => b.count - a.count)[0]
    const host = (() => {
      try {
        return new URL(worst.url).host
      } catch {
        return worst.url
      }
    })()
    const others = recent.length > 1 ? ` (+${recent.length - 1} more)` : ''
    return `${host}: ${worst.reason}${others}`
  }

  /** Share of publishes a relay refused. Above a few percent is a real problem. */
  rejectRate(): number {
    return this.published ? this.rejected / this.published : 0
  }

  close(): void {
    for (const c of this.closers) c.close()
    this.closers = []
    this.pool.close(this.relays)
  }
}
