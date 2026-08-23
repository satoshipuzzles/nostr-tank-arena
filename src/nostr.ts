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
 *   purplerelay.com           400/400
 *   relay.fountain.fm         400/400
 *   relay.mostr.pub           250/250
 *   relay.nostr.net            60/400  "rate-limited: too many events from
 *                                       this key (60/60s)"
 *   nostr-pub.wellorder.net    13/400  "blocked: spam not permitted"
 *   nostr21.com                  0/250
 *   relay.nostrplebs.com         0/250  needs their NIP-05
 *   nostr.land                   0/250  paid
 *   nostr.einundzwanzig.space    0/250  needs NIP-05
 *   relay.nostr.wirednet.jp      —      "blocked: ... ephemeral kind range"
 *
 * `nostr.mom` took 400/400 from Node and then demanded 28-bit proof of work
 * from a browser, twice. Measure in the environment the thing actually runs in.
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
  'wss://purplerelay.com',
  'wss://relay.fountain.fm',
  'wss://relay.mostr.pub',
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

/**
 * Why a publish failed, which is three different questions wearing one coat.
 *
 * The distinction is the whole point of this file's last revision. `publish()`
 * used to treat every rejected promise the same and mute a relay for the rest
 * of the session after fifteen in a row, on the reasoning that a run of
 * refusals "is a policy, not a bad minute". That reasoning is sound for an
 * `OK false` frame and false for the other two:
 *
 *   * `refused` — the relay sent `["OK", id, false, "..."]`. It looked at the
 *     event and said no. Rate cap, proof of work, an allowlist, a web of trust.
 *     A run of these really is a policy, and muting is right.
 *
 *   * `no-verdict` — no answer at all: the client's publish timeout expired, or
 *     the socket dropped. The relay has not refused anything, because refusing
 *     is a *frame* and silence is not one. purplerelay.com was measured timing
 *     out on hundreds of publishes while a separate subscriber confirmed it was
 *     still forwarding 246 of 251 of them. Muting on this throws away a working
 *     relay because the acknowledgement was slow.
 *
 *   * `malformed` — the relay says the event itself is bad (`invalid: ...`),
 *     which is almost always *our* fault, not the relay's. A clock far enough
 *     behind makes every NIP-40 `expiration` arrive already spent and every
 *     relay answer `invalid: event expired`. Striking the relays for that would
 *     mute the entire set over a local clock problem.
 */
export type FailureKind = 'refused' | 'no-verdict' | 'malformed' | 'unknown'

/**
 * NIP-01's machine-readable OK prefixes, plus `auth-required:` from NIP-42.
 *
 * The set is closed, which is the whole reason to match on it. The previous
 * version of this function searched for substrings anywhere in the message and
 * got three of newlay's real frames backwards, all in the dangerous direction:
 *
 *   `restricted: you are timed out until 1799999999`   contains "timed out"
 *   `rate-limited: too many open connections from your IP`   contains "connection"
 *   `rate-limited: connection attempts too fast; slow down`  same
 *
 * All three read as `no-verdict`, which never strikes — so the client would
 * hammer, for the whole session, a relay that had explicitly and per-pubkey
 * told it to stop. A moderation timeout is the most literal "it has a policy,
 * not a bad minute" frame that exists, and it was the one being ignored.
 *
 * Prefix first, heuristics only when there is no prefix. A relay's own reason
 * can then never be overridden by a word that happens to appear inside it.
 */
const OK_PREFIX: Record<string, FailureKind | 'accepted'> = {
  // The relay already has the event. Publishing succeeded in every sense that
  // matters, so this is not a failure at all — and it is the single worst thing
  // on the list to strike a relay for.
  'duplicate:': 'accepted',
  'pow:': 'refused',
  'blocked:': 'refused',
  'rate-limited:': 'refused',
  'restricted:': 'refused',
  'auth-required:': 'refused',
  'invalid:': 'malformed',
  // NIP-01 defines `error:` as "any other reason" — the catch-all. That is the
  // weakest possible basis for writing a relay off, so it does not mute.
  'error:': 'unknown',
}

/**
 * Why a publish failed, which is several different questions wearing one coat.
 *
 * The distinction is the point of this file. `publish()` used to treat every
 * rejected promise the same and mute a relay for the rest of the session after
 * fifteen in a row, on the reasoning that a run of refusals "is a policy, not a
 * bad minute". That reasoning holds for exactly one of these:
 *
 *   * `refused` — the relay looked at the event and said no. Rate cap, proof of
 *     work, an allowlist, a web of trust, a moderation timeout. A run of these
 *     really is a policy, and giving up on the relay is right.
 *
 *   * `no-verdict` — no answer at all: the client's 4400ms publish timeout
 *     expired, or the socket dropped. The relay has not refused anything,
 *     because refusing is a *frame* and silence is not one. purplerelay.com was
 *     measured timing out on hundreds of publishes while a separate subscriber
 *     confirmed it was still forwarding 246 of 251 of them.
 *
 *   * `malformed` — the relay says the event itself is bad (`invalid: ...`),
 *     which is almost always *our* fault. A clock far enough behind makes every
 *     NIP-40 `expiration` arrive already spent and every relay answer
 *     `invalid: event expired`; striking for that mutes the entire set over a
 *     local clock problem.
 *
 *   * `unknown` — the relay said something, and we do not recognise it. It gets
 *     reported in the relay's own words and never mutes, because muting is the
 *     destructive direction and an unparsed string is no evidence for it.
 */
export function classifyFailure(reason: string): FailureKind | 'accepted' {
  const r = reason.trim().toLowerCase()
  for (const prefix of Object.keys(OK_PREFIX)) {
    if (r.startsWith(prefix)) return OK_PREFIX[prefix]
  }
  // No machine-readable prefix. Now, and only now, guess from the shape —
  // these are the client's own messages rather than any relay's.
  if (
    r.includes('timed out') ||
    r.includes('timeout') ||
    r.includes('websocket') ||
    r.includes('connection') ||
    r.includes('socket') ||
    r.includes('closed')
  ) {
    return 'no-verdict'
  }
  return 'unknown'
}

// Exposed the same way and for the same reason as `__game` and `__sfx`: the
// classifier is pure string matching against messages relays actually send, and
// string matching is exactly the kind of thing that rots silently. This lets
// test/relays.mjs check the whole table directly, including the frames the fake
// relays do not produce. Attached here rather than in main.ts to keep this
// change inside one file.
if (typeof window !== 'undefined') {
  ;(window as unknown as { __classifyFailure: typeof classifyFailure }).__classifyFailure =
    classifyFailure
}

/** What a relay has been saying about our publishes lately. */
export interface RelayTrouble {
  url: string
  /** The relay's own words from the OK frame, e.g. "rate-limited: slow down". */
  reason: string
  kind: FailureKind
  count: number
  at: number
}

/**
 * A per-relay tally that never expires.
 *
 * `trouble` is for the HUD and is deliberately forgetful — a complaint ages out
 * after twenty seconds so the status line reflects now rather than the whole
 * session. That makes it useless for answering "what happened during that
 * round": ticks outrun everything else roughly 150:1, so the successful publish
 * that clears the complaint is always a few hundred milliseconds away, while a
 * pickup wave is thirty-four seconds long. This one keeps the count.
 */
export interface RelayLedger {
  /**
   * Keyed by relay URL alone, which is only correct because **one `Net` serves
   * exactly one session key.**
   *
   * That invariant is load-bearing and was briefly untrue: local split-screen
   * first shipped with both players sharing a `Net`, and a relay that refused
   * player two while accepting player one then read as `{accepted: n,
   * refused: n}` — indistinguishable from both players being throttled at 50%,
   * which needs the opposite fix. `restricted:` and `blocked:` are per-pubkey
   * by definition, so a web-of-trust gate or a moderation timeout hits exactly
   * one of the two people on the couch. Player two has its own `Net` now
   * (`main.ts`), so attribution comes free. Share one again and this map goes
   * blind in a way nothing here will report.
   */
  url: string
  accepted: number
  refused: number
  noVerdict: number
  malformed: number
  unknown: number
  /** Times this relay has been muted, so a flapping relay is distinguishable. */
  mutes: number
  lastReason: string
  lastAt: number
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
  private muted = new Map<string, { until: number; span: number }>()
  /** How long the next mute lasts, per relay. Outlives the prune in `publish`. */
  private muteSpan = new Map<string, number>()
  private strikes = new Map<string, number>()
  private static readonly MUTE_AFTER = 15
  /**
   * How long a muted relay sits out before it gets another chance.
   *
   * Muting used to be permanent for the session, which is too strong even for a
   * genuine refusal: a rate cap is a statement about the last minute, not about
   * the next hour, and a relay that was reloading when we met it is written off
   * until the tab closes. The wait doubles each time so a relay with a real
   * policy costs fifteen wasted events per attempt and then goes quiet for
   * longer and longer, while one that was briefly unhappy comes straight back.
   */
  private static readonly MUTE_MS = 60_000
  private static readonly MUTE_MS_MAX = 15 * 60_000
  /** Per-relay counts that survive the whole session. */
  readonly ledger = new Map<string, RelayLedger>()

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
    const now = Date.now()
    for (const [url, m] of this.muted) if (now >= m.until) this.muted.delete(url)
    const targets = this.relays.filter((url) => !this.muted.has(url))
    if (!targets.length) return
    const results = this.pool.publish(targets, event)
    this.published += results.length
    results.forEach((p, i) => {
      const url = targets[i]
      p.then(
        () => {
          this.strikes.set(url, 0)
          this.entry(url).accepted++
          const known = this.trouble.get(url)
          // One clean publish is not proof the relay is happy, but a run of
          // them is: let an old complaint age out rather than sticking forever.
          if (known && Date.now() - known.at > 20_000) this.trouble.delete(url)
        },
        (err: unknown) => {
          const reason = (err instanceof Error ? err.message : String(err)).slice(0, 120)
          const kind = classifyFailure(reason)
          if (kind === 'accepted') {
            // `duplicate:` — the relay has the event. It arrives as a rejected
            // promise and is not a failure, so it is not counted as one.
            this.strikes.set(url, 0)
            this.entry(url).accepted++
            return
          }
          this.rejected++
          const known = this.trouble.get(url)
          this.trouble.set(url, {
            url,
            reason,
            kind,
            count: known && known.reason === reason ? known.count + 1 : 1,
            at: Date.now(),
          })
          const led = this.entry(url)
          led.lastReason = reason
          led.lastAt = Date.now()
          if (kind === 'refused') led.refused++
          else if (kind === 'no-verdict') led.noVerdict++
          else if (kind === 'malformed') led.malformed++
          else led.unknown++

          // Only an actual refusal counts toward giving up on a relay. Silence
          // is not a verdict, our own bad event is not the relay's fault, and a
          // message we cannot parse is not evidence for the destructive option.
          if (kind !== 'refused') return
          const strikes = (this.strikes.get(url) ?? 0) + 1
          this.strikes.set(url, strikes)
          if (strikes >= Net.MUTE_AFTER) this.mute(url)
        },
      )
    })
  }

  private entry(url: string): RelayLedger {
    let led = this.ledger.get(url)
    if (!led) {
      led = {
        url, accepted: 0, refused: 0, noVerdict: 0, malformed: 0, unknown: 0,
        mutes: 0, lastReason: '', lastAt: 0,
      }
      this.ledger.set(url, led)
    }
    return led
  }

  private mute(url: string): void {
    // `span` lives in its own map because `publish()` prunes `muted` on entry,
    // and that delete took the previous span with it — so `prev` was always
    // undefined, every wait was sixty seconds, and MUTE_MS_MAX was unreachable.
    // The docstring promised a doubling that could not happen. It does not
    // decay: a relay muted repeatedly within one session has earned the wait.
    const prev = this.muteSpan.get(url)
    const span = Math.min(prev ? prev * 2 : Net.MUTE_MS, Net.MUTE_MS_MAX)
    this.muteSpan.set(url, span)
    this.muted.set(url, { until: Date.now() + span, span })
    this.strikes.set(url, 0)
    this.entry(url).mutes++
  }

  /** Relays we are not publishing to right now. */
  get mutedRelays(): string[] {
    const now = Date.now()
    return [...this.muted].filter(([, m]) => now < m.until).map(([url]) => url)
  }

  /** A one-line summary for the HUD, or '' when every relay is taking events. */
  troubleSummary(): string {
    const stillMuted = this.mutedRelays
    if (stillMuted.length) {
      const hosts = stillMuted.map((u) => {
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
    // A relay that has not answered has not refused anything, and saying it did
    // sends whoever reads the HUD looking for a policy that does not exist.
    const verb = worst.kind === 'no-verdict' ? 'not answering' : worst.reason
    const host = (() => {
      try {
        return new URL(worst.url).host
      } catch {
        return worst.url
      }
    })()
    const others = recent.length > 1 ? ` (+${recent.length - 1} more)` : ''
    return `${host}: ${verb}${others}`
  }

  /**
   * Share of publishes that failed, over the whole session and every relay.
   *
   * Read `ledger` instead when the question is about a particular relay. This
   * number hides two things by construction: a muted relay stops contributing
   * to both halves of the fraction, so one that died in the first seconds of a
   * long run shows up as a fraction of a percent; and a relay refusing half of
   * everything never accumulates fifteen consecutive strikes, so it never mutes
   * and never appears anywhere else either.
   */
  rejectRate(): number {
    return this.published ? this.rejected / this.published : 0
  }

  close(): void {
    for (const c of this.closers) c.close()
    this.closers = []
    this.pool.close(this.relays)
  }
}
