import { KIND_STATE } from './protocol'
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
/**
 * Three relays, and it used to be four.
 *
 * `wss://relay.fountain.fm` was in this list and is not a relay for this game.
 * Measured with two sockets — one subscribed to the room before anything was
 * published, one publishing — because an `OK` is only worth what a separate
 * subscriber can see:
 *
 *   relay.primal.net    kind 21000   OK true    delivered true
 *   purplerelay.com     kind 21000   OK true    delivered true
 *   relay.mostr.pub     kind 21000   OK true    delivered true
 *   relay.fountain.fm   kind 21000   OK true    delivered FALSE
 *
 * And asked to read rather than write, it answers
 * `["CLOSED", id, "kinds not supported"]` for 21000, 21001, 21003 and 30078 —
 * every kind this game uses — while serving 0, 3, 30023 and 30311 happily. It
 * is a podcast relay. It took a quarter of the traffic and printed a receipt.
 *
 * Worth stating what that receipt cost beyond bandwidth: an `OK true` from a
 * relay that never parsed the event is not weak evidence of a healthy clock,
 * it is no evidence at all, and it was enough to acquit three relays that had
 * read the timestamp and named the same fault.
 */
export const DEFAULT_RELAYS = [
  'wss://relay.primal.net',
  'wss://purplerelay.com',
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
 * What happened to one event across every relay it was sent to.
 *
 * `publish()` stays fire-and-forget for the ten-times-a-second traffic — a tick
 * that lands nowhere is replaced by the next tick and nobody needs to be told.
 * This exists for the one kind that is published exactly **once**, where the
 * difference between "everybody refused it" and "nobody answered yet" decides
 * whether local state is wrong.
 *
 * `refused` here means *unanimously* refused: every relay that was asked looked
 * at the event and said no. Anything else — one acceptance, one silence, one
 * relay we could not classify — is not grounds for acting, because the event may
 * well have landed.
 */
/**
 * Set when every relay we asked called the event itself invalid.
 *
 * `malformed` from one relay is that relay being odd. `malformed` from all of
 * them is a fact about this machine, and the two need opposite responses.
 * Muting is wrong — the relays are fine and there would be none left — but so
 * is carrying on, and carrying on is what the client did: the classifier is
 * correctly not striking, so it hammers every relay for the whole session.
 *
 * The realistic cause is the clock. newlay's window is asymmetric —
 * `createdAtMsecsAgo` is 365 days, `createdAtMsecsAhead` is fifteen minutes —
 * so a clock *behind* costs only the NIP-40 claim, while a clock more than
 * fifteen minutes *ahead* makes every event `invalid: created_at too far in the
 * future`, and that path books a -4 rather than a rate hit's -2. At the
 * measured 6.3 events/sec that is roughly -25 a second: floored inside three
 * seconds, before the player has finished reading the lobby.
 *
 * It is also the only failure in this game a player can go and fix, which is
 * the argument for stopping and saying so rather than retrying into a wall.
 */
/**
 * Which way a relay says our timestamp is wrong, and only when it says so.
 *
 * Not every `invalid:` is a verdict on the clock. Both implementations reject
 * on shape *before* they look at the timestamp — newlay's `too many tags`,
 * `content too long` and `missing required tag`, strfry's `too many tags` — and
 * counting those as votes about the clock is the accuser bug with its own fix
 * applied to half of it. Two relays configured tighter than the tick is two
 * relays agreeing, quorum satisfied, and the screen telling a player to fix a
 * clock that is correct.
 *
 * So the rule is positive rather than a blocklist: only an `invalid:` that names
 * the timestamp votes on the timestamp.
 *
 * The strings, measured against the four relays this game ships with rather
 * than read from one implementation's source:
 *
 *   strfry   invalid: ephemeral event expired          behind, 60s window
 *            invalid: created_at too early             behind, stored kinds
 *            invalid: created_at too late              ahead
 *   newlay   invalid: created_at too far in the past    behind
 *            invalid: created_at too far in the future  ahead
 *   NIP-40   invalid: event expired                     behind, our own deadline
 *
 * `created_at too late` is the one worth noticing: it contains neither "future"
 * nor "expired", so a client that reads direction by looking for those words
 * gets nothing from three of the four relays in the shipped list.
 */
export type ClockDirection = 'behind' | 'ahead'

export function clockVerdict(reason: string): ClockDirection | null {
  const r = reason.trim().toLowerCase()
  if (!r.startsWith('invalid:')) return null
  if (r.includes('too late') || r.includes('in the future') || r.includes('too far ahead')) {
    return 'ahead'
  }
  if (r.includes('expired') || r.includes('too early') || r.includes('in the past')) {
    return 'behind'
  }
  return null
}

export interface ClockAlarm {
  /** The relay's own words, so the screen can quote rather than paraphrase. */
  reason: string
  /** Consecutive publishes that carried a quorum on the same direction. */
  streak: number
  /**
   * Which way, decided by the relays rather than by reading words off one
   * string. Never null while the alarm is up: no direction, no quorum.
   */
  direction: ClockDirection
  /** How many distinct relays named it. Never below two. */
  agreed: number
}

export interface PublishOutcome {
  /** Relays the event was actually sent to. Zero when everything is muted. */
  sent: number
  accepted: number
  refused: number
  /** Every relay said `invalid:` — the event itself was bad. */
  malformed: number
  /** Silence, timeouts, and reasons we could not classify. */
  unclear: number
  /** True only when every relay asked refused it outright. */
  unanimouslyRefused: boolean
  /**
   * True when this event is definitely nowhere, and it is a different question.
   *
   * `unanimouslyRefused` answers "should I give up on these relays" — only a
   * policy refusal counts, because that is the only kind that says anything
   * about the relay. This one answers "does this event exist anywhere", and for
   * that `malformed` is a *stronger* guarantee than `refused`, not a weaker
   * one: `invalid:` is emitted before storage, the event is never stored and
   * never forwarded, and a bad event is bad at every relay — including the
   * muted ones that were never asked. A refusal only tells you about the relays
   * in `targets`.
   *
   * Which is why a claim rejected everywhere as `invalid: event expired` — the
   * one total publish failure anybody in this thread has actually observed —
   * has to count. `sent === 0`, everything muted, is definitively nowhere too.
   */
  definitelyNowhere: boolean
  /** The last refusal reason, in the relay's own words. */
  reason: string | null
}

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
  // Not in NIP-01. newlay carries a ninth prefix in `RejectPrefix.kt`, and at
  // 267a2f3 it is an enum constant with no emitter — reserved for something
  // somebody will wire up. Without a row here it would fall past the closed
  // set, miss every heuristic, and land on `unknown`, which never strikes:
  // the exact shape of the bug this table was rewritten to fix.
  'mute:': 'refused',
  // Worth knowing about the two connection-flavoured `rate-limited:` messages:
  // newlay writes them as HTTP 429 bodies before the websocket upgrade, so they
  // never arrive as an OK frame and never reach this function. Classifying them
  // correctly costs nothing and their absence from a ledger proves nothing.
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
/**
 * True when a relay actually said this, rather than the library inventing it.
 *
 * NIP-01's machine-readable prefix set is closed and a relay's `CLOSED` reason
 * carries one. Everything nostr-tools writes itself carries none — which makes
 * the prefix, not the wording, the honest way to tell a verdict from silence.
 */
export function isRelayVerdict(reason: string): boolean {
  const r = reason.trim().toLowerCase()
  return Object.keys(OK_PREFIX).some((prefix) => r.startsWith(prefix))
}

/**
 * True when nostr-tools wrote this string rather than a relay.
 *
 * Routing on the NIP-01 prefix alone is the obvious answer and it is wrong in
 * the live direction: NIP-01 says a `CLOSED` reason *should* carry a
 * machine-readable prefix and relays do not have to. `relay.fountain.fm`
 * answers `CLOSED ... "kinds not supported"` — a real verdict, no prefix — and
 * a prefix-only rule retries that forever. Measured at five REQs a second.
 *
 * So the transport wordings are matched explicitly, without the `relay `
 * anchor, because the same library uses both forms depending on whether the
 * socket ever opened:
 *
 *   nothing listening / DNS failure   "connection failed"
 *   black hole                        "connection timed out"
 *   died after connecting             "relay connection closed"
 *
 * Everything else is taken to be a relay speaking. That is the safer default of
 * the two — an unrecognised string is far more likely to be an unprefixed
 * verdict than a wording nostr-tools invented — and the cost of being wrong is
 * capped rather than permanent, because a verdict is retried once in a long
 * while rather than never. See `VERDICT_RETRY_MS`.
 */
export function isTransportSilence(reason: string): boolean {
  return /^(relay )?connection (closed|failed|timed out)$/i.test(reason.trim())
}

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
  ;(window as unknown as { __parseRateLimit: typeof parseRateLimit }).__parseRateLimit =
    parseRateLimit
}

/**
 * Pull the effective cap out of a `rate-limited:` reason.
 *
 * newlay answers a too-fast publisher with its own number:
 *
 *   rate-limited: publishing too fast (limit 180 events/min); slow down or AUTH
 *
 * and that number is the *behaviour-scaled* cap, not the configured one — the
 * profile is folded as `DEFAULTS ⊕ TIER ⊕ BEHAVIOR×m` and retuned on every
 * score change. So a tier configured at 1800 answering `limit 180` is a relay
 * telling you, in the only channel it has, that it has walked you down to the
 * 0.1x band. NIP-65535 LIMITS cannot carry this: rate fields are excluded from
 * the payload by the spec, and behaviour retunes deliberately never push a
 * frame. The OK string is it.
 *
 * Returns null when there is no number, which is itself the discriminator that
 * matters: newlay's per-IP gate says `rate-limited: too many events from your
 * IP; slow down` with no figure at all. Per-connection carries a limit; per-IP
 * never does — so a cap two sockets would fix is separable from one they would
 * not, by whether this function finds anything.
 */
export function parseRateLimit(reason: string): number | null {
  const m = /limit\s+(\d+)\s*events?\/min/i.exec(reason)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * What one event costs against a `publishing_rate_limit`.
 *
 * The cap is denominated in *tokens*, not events, and an event is not
 * necessarily one token:
 *
 *   cost = 1 + tags.count / 50 + content.length / 8192
 *
 * — the tag *count*, not tag bytes. A position tick carries one tag and about
 * 88 characters of payload, so it costs 1.03. Pacing at 0.9 events per token of
 * allowance therefore spends 0.927 of the cap rather than 0.9 of it, and the
 * margin that was supposed to be ten percent is seven. It grows worse as tags
 * do. Not broken, but the number being protected was not the number in the
 * constant, so the pace is against cost now.
 */
export function eventCost(event: { tags: string[][]; content: string }): number {
  return 1 + event.tags.length / 50 + event.content.length / 8192
}

/**
 * What we have agreed to slow down to for one relay.
 *
 * Muting a rate-limiting relay is the wrong response when it has told us its
 * number, and against newlay it is actively harmful. The bucket refills
 * continuously, so a hammering client gets a steady trickle of acceptances —
 * roughly one in eleven at stock 60/min against a 12Hz tick — and every one of
 * them resets the consecutive-strike counter. The relay is therefore *never*
 * muted, and the client hammers it all session at an 8% accept rate. Each
 * rejection is a −2 on a behaviour score that recovers at +2 per *clean*
 * minute, so continuing to publish is precisely what pins the multiplier at its
 * floor and keeps the cap a tenth of what it was configured to be.
 *
 * Pacing inverts that. A client publishing under the cap takes no rate hits, so
 * its minutes are clean, so the score climbs and the number in the string goes
 * back up while you watch. For an anonymous key it is the only path back inside
 * a session: the other recovery credit is authed-only and ephemeral session
 * keys never AUTH.
 */
interface RelayPace {
  /** Events per minute we are currently allowing ourselves. */
  allowance: number
  /** The last figure the relay reported. */
  reported: number
  /** The lowest it ever reported — how far down the spiral went. */
  lowest: number
  /** Earliest we may send this relay another disposable event. */
  nextAt: number
  /** Last time this relay refused us, for deciding when to probe faster. */
  lastRefusalAt: number
  /** Last time we escalated. Separate from the above, and that separation is the fix. */
  lastProbeAt: number
  /** Refusals since pacing began. The valve for when pacing is not working. */
  refusalsWhilePaced: number
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
  /** Lowest events/min this relay has reported, or 0 if it never gave a number. */
  lowestLimit: number
  /** Set when the relay closed our subscription, in its own words. */
  subscriptionClosed: string | null
  /** Times the socket died under us and we rebuilt the subscription. */
  reconnects: number
  /** Events/min we are pacing ourselves to right now, or 0 when unpaced. */
  pacedTo: number
  /** Times this relay has been muted, so a flapping relay is distinguishable. */
  mutes: number
  lastReason: string
  lastAt: number
}

/**
 * Ids already delivered, bounded the way `Game.onEvent`'s set is and for the
 * same reason: a redelivered death event must not count twice. Rotated rather
 * than cleared, so the older half survives one rotation.
 */
function boundedIdSet(): { have(id: string): boolean } {
  let now = new Set<string>()
  let prev = new Set<string>()
  return {
    have(id: string): boolean {
      if (now.has(id) || prev.has(id)) return true
      now.add(id)
      if (now.size > 5000) {
        prev = now
        now = new Set()
      }
      return false
    },
  }
}

export class Net {
  /**
   * Reconnecting, which it was not, and that made the read path one-way.
   *
   * nostr-tools defaults `enableReconnect` to false. A hard close then runs
   * `closeAllSubscriptions(reason)` with nothing behind it, and nothing in this
   * file resubscribes — `subscribe()` is called twice, from `Game.start()`, and
   * never again. Publishing recovers on its own, because `ensureRelay()` builds
   * a fresh socket for the next publish. Reading does not.
   *
   * So one wifi change, one laptop sleep, one edge cycling the connection, and
   * that relay is write-only for the rest of the session: publishing ten a
   * second into a game we cannot see, with no error, no refusal, no streak and
   * nothing on the screen. Take all three at once, which is what a sleep does,
   * and the arena is empty forever.
   *
   * With it on, a drop schedules a backoff reconnect and every open
   * subscription is re-fired — and nostr-tools rewrites each filter's `since`
   * to `lastEmitted + 1` on the way, so the replay is bounded by what we have
   * already seen rather than by the relay's retention.
   */
  /**
   * Reconnection is ours, not the library's, and the difference is a filter.
   *
   * `enableReconnect: true` does resubscribe — measured in Chrome, both a close
   * frame and a TCP-level drop come back. What it also does is rewrite the
   * filter on the way: `sub.filters[f].since = sub.lastEmitted + 1`. And
   * `lastEmitted` is the maximum `created_at` *received*, set outside the
   * `matchFilters` branch, so it is not "the newest event we accepted" — it is
   * the furthest-ahead clock in the room.
   *
   * One peer stamped 300 seconds fast, which no relay refuses because it is
   * inside every forward window, and the resubscribe asks for `since: now+301`.
   * That is the `since` bug this game deleted from `game.ts`, coming back
   * through the library on somebody else's clock.
   *
   * Worse, the filter object is shared across the per-relay subscriptions and
   * `matchFilters` runs client-side on every inbound event. Measured with two
   * relays and only one of them dropped:
   *
   *   filter before any drop        {kinds, #t}
   *   filter after A reconnected    {kinds, #t, since: now+301}
   *   B's REQ on the wire           {kinds, #t}          <- never resubscribed
   *   B's events delivered after    false                <- discarded locally
   *
   * One relay's reconnect blinds all of them, against a filter B never sent.
   *
   * So: the library does not reconnect, this class does, with a filter it built
   * — and a clone per relay besides, because one object three subscriptions can
   * mutate is a hazard whoever is writing to it.
   */
  private pool = new SimplePool({ enableReconnect: false })
  private closers = new Map<string, { close(): void }>()
  private resubTimers = new Set<ReturnType<typeof setTimeout>>()
  private resubAttempts = new Map<string, number>()
  private subGroups = 0
  /**
   * How long to leave a relay that declined our filter before asking again.
   *
   * A verdict is a verdict and resubscribing at socket speed is a loop. But
   * "never again for the whole session" is the wrong end of the trade for
   * something decided by string matching, so it is slow rather than permanent.
   */
  private static readonly VERDICT_RETRY_MS = 5 * 60_000
  private disposed = false
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
  /** Relays that closed our subscription rather than serving it. */
  private closedSubs = new Map<string, string>()
  /**
   * Relays we cannot reach, and are still trying.
   *
   * Kept apart from `closedSubs` deliberately. That one holds a verdict and is
   * safe to quote; this one holds nostr-tools' description of a silence, and
   * putting it on a screen as "the relay said" would be inventing a speaker.
   */
  private unreachable = new Map<string, string>()
  /** Relays that told us their number, and what we are doing about it. */
  private pace = new Map<string, RelayPace>()
  /** Consecutive publishes that every asked relay called malformed. */
  private allMalformedStreak = 0
  private lastMalformedReason = ''
  /** The direction a quorum last agreed on, and a reason two of them gave. */
  private clockDirection: ClockDirection | null = null
  private clockAgreed = 0
  /**
   * The relays that formed the accusation, and the only ones allowed to undo it.
   *
   * An acquittal has to come from a relay that could have convicted. That is
   * the general form of why a relay with no timestamp gate cannot outvote three
   * that have one — and it was still unenforced on the clearing side, where any
   * acceptance from any relay zeroed the streak.
   *
   * It mattered because of the round-robin probe: while the alarm is up exactly
   * one relay is asked per cycle, and a relay that never refuses never mutes, so
   * it never leaves the rotation. Every Nth cycle its acceptance cleared the
   * alarm, publishing resumed at ten a second into relays refusing every event,
   * and the quorum raised it again half a second later. The probe answered "has
   * the clock been fixed?" with "yes" one time in N regardless of the clock.
   */
  private clockWitnesses = new Set<string>()
  private lastMalformedProbeAt = 0
  /**
   * How many all-relay rejections before we stop and blame the machine.
   *
   * Low, because the signal is unambiguous — every relay independently refusing
   * to store the same event is not a coincidence — and because each one costs
   * -4 on newlay rather than a rate hit's -2.
   */
  private static readonly MALFORMED_STREAK = 5
  /**
   * While the alarm is up, let one event through this often to notice a fix.
   *
   * An instance field rather than a static so a test can compress it. That is
   * not a convenience: a check whose window is shorter than this interval
   * cannot observe a probe at all, and would report "publishing has stopped"
   * about a mechanism it never gave a chance to run.
   */
  private malformedProbeMs = 60_000
  /** Which relay gets the next probe. Rotates, so no single one is hammered. */
  private malformedProbeAt = 0
  /**
   * How long a paced relay must go without refusing before we try it faster.
   *
   * Without this the pace is a one-way ratchet: a client obeying the cap never
   * gets refused, so it never sees a new number, so it never learns the relay
   * has forgiven it — which is the whole point of pacing rather than muting.
   */
  /**
   * How long a paced relay must be quiet before we try it faster.
   *
   * This was thirty seconds and a x1.5 step, and it undid the thing pacing was
   * for. newlay credits recovery per *clean minute* — `advanceMinute` decrements
   * the clean count if the minute contained any violation at all, not partially
   * — and for an anonymous session key that is the only recovery channel there
   * is. So a probe that overshoots the cap even briefly spoils the entire
   * minute. Escalating every thirty seconds meant every minute was dirty, the
   * score was pushed down -2 at a time and pinned at the floor, and the
   * reported `limit N` could never grow: the spiral pacing was written to end,
   * at lower amplitude and self-inflicted.
   *
   * It was also compounding rather than probing, because escalating reset
   * `lastRefusalAt` — so the quiet test kept passing against a clock the probe
   * itself had just moved. `lastProbeAt` is separate now.
   *
   * Five minutes and x1.1. The arithmetic has to come out positive: one probe
   * cycle costs a handful of refusals and one dirty minute, and nine clean
   * minutes at +2 pays for it several times over. At x1.1 the first step from
   * 0.9x lands at 0.99x — still under the cap, so it is free — and only the
   * second overshoots, by nine percent.
   */
  private paceProbeMs = 5 * 60_000
  /**
   * Multiplicative step. Small on purpose: an overshoot is paid for in refusals
   * against a score that only heals in whole clean minutes.
   */
  private static readonly PACE_STEP = 1.1
  /** Ceiling past which pacing is pointless; we tick well below this. */
  private static readonly PACE_UNCAP = 1_500
  /**
   * Refusals to tolerate while paced before falling back to muting.
   *
   * If we are obeying the number and still being refused, the number is not the
   * problem — a per-IP cap, or a limit walking down faster than we adapt — and
   * continuing to pace would be its own version of hammering.
   */
  private static readonly PACE_GIVE_UP = 40
  /**
   * Aim just under the number rather than exactly at it.
   *
   * A token bucket refilling at the same rate we spend it sits on the boundary,
   * and jitter alone then produces refusals — each one a −2 on the score we are
   * pacing to protect. Ninety percent costs one event in ten and stops the
   * client tripping the very limit it is trying to respect.
   */
  private static readonly PACE_MARGIN = 0.9
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

  /**
   * Subscribe, one subscription per relay, so a relay that hangs up is visible.
   *
   * `subscribeMany` takes a single `onclose` and only calls it once *every*
   * relay has closed, which is exactly the case that does not need reporting.
   * The case that does is one relay quietly dropping out of a set that is
   * otherwise fine — and it happens on a correct clock, today: a relay can
   * answer `["CLOSED", id, "kinds not supported"]` for every kind this game
   * uses while still returning `OK true` to publishes of those same kinds.
   * Read refused, write accepted, nothing stored.
   *
   * Discarding that frame makes such a relay permanently silent and
   * indistinguishable from a quiet one, while the publish path goes on counting
   * it as live. One subscription each costs nothing extra on the wire — the
   * pool still dedupes connections by URL — and duplicate deliveries were
   * already handled, because relays echo and `Game.onEvent` keys on event id.
   */
  /**
   * `stored` tells the caller which side of EOSE an event arrived on.
   *
   * Every relay sends `EOSE` when it has finished replaying its store, so it is
   * an exact, clock-free boundary between "this already happened" and "this is
   * happening" — and it is per relay, which is why one subscription each matters
   * for more than seeing a `CLOSED`. Tracked here rather than in the caller
   * because only this side knows which relay an event came from.
   */
  subscribe(filter: Filter, onevent: (e: Event, stored: boolean) => void): void {
    // One dedupe set per call, shared across that call's relays and no further.
    //
    // It was one set for the whole `Net`, and that is wrong in a way nothing
    // else here would have shown: nostr-tools consults `alreadyHaveEvent`
    // *before* it runs `matchFilters`. `subscribe()` is called twice with
    // disjoint filters — the live kinds and the stored claim — and both run on
    // the same socket, so whichever subscription sees an event first marks it
    // seen, and if its own filter then rejects it the other subscription is
    // never offered it at all. Every claim could be swallowed by the live
    // subscription and every tick by the claim one.
    const seen = boundedIdSet()
    // `subscribe()` is called more than once with different filters, so a
    // subscription is identified by which call it belongs to *and* which relay
    // — not by the relay alone. Keying on the URL made the second call close
    // the first one's subscription on every relay, which is the read path going
    // dark by way of the code written to keep it alive.
    const group = this.subGroups++
    for (const url of this.relays) this.openSub(group, url, filter, onevent, seen)
  }

  private openSub(
    group: number,
    url: string,
    filter: Filter,
    onevent: (e: Event, stored: boolean) => void,
    seen: { have(id: string): boolean },
  ): void {
    if (this.disposed) return
    let live = false
    const key = `${group}:${url}`
    this.closers.get(key)?.close()
    this.closers.set(
      key,
      // A clone, so nothing downstream can reach the caller's object or any
      // other relay's copy of it.
      this.pool.subscribeMany([url], { ...filter }, {
        onevent: (e: Event) => onevent(e, !live),
        oneose: () => {
          live = true
          // The relay took the filter. Whatever went wrong before is over.
          this.resubAttempts.set(key, 0)
          this.unreachable.delete(url)
        },
          // One subscription per relay costs nostr-tools' cross-relay dedupe:
          // its `_knownIds` is allocated per `subscribeMany` call, so three
          // calls means three sets and every event arrives about three times.
          // `Game.onEvent` already keys on id and catches them — but its set
          // rotates on a fixed *count*, so three times the traffic is a third
          // of the dedupe window in time. Harmless while nothing replays;
          // reconnection replays. One shared set puts the window back.
        alreadyHaveEvent: (id: string) => seen.have(id),
        onclose: (reasons: { url: string; reason: string }[]) => {
          const reason = reasons?.[0]?.reason ?? 'closed without a reason'
          if (this.disposed || /closed by (us|caller)/i.test(reason)) return

          // Route on whether a relay spoke, not on how the library phrased it.
          //
          // This matched `/^relay connection/i` and that only covers a socket
          // that died *after* connecting. A relay that was never there fails a
          // different way and the string has no `relay ` on it at all —
          // measured against nostr-tools 2.24.3:
          //
          //   nothing listening        "connection failed"
          //   DNS does not resolve     "connection failed"
          //   black hole, times out    "connection timed out"
          //   died after connecting    "relay connection closed"
          //
          // So the ordinary case — a tab opened before the wifi associated, a
          // relay in maintenance, a captive portal — fell through to the
          // verdict branch: never retried for the whole session, and quoted on
          // screen as the relay's own words when no relay had spoken.
          //
          // The prefix inverts the default to the safe side. A wording nobody
          // anticipated becomes a retry instead of a permanent execution, and
          // NIP-01's set cannot be changed by a library bump.
          if (isTransportSilence(reason)) {
            // Nobody said anything: the socket died, or was never there.
            // Silence, not a verdict, and ours to keep trying.
            this.unreachable.set(url, reason)
            const attempt = (this.resubAttempts.get(key) ?? 0) + 1
            this.resubAttempts.set(key, attempt)
            this.entry(url).reconnects++
            // The library's own backoff starts at ten seconds, which is ten
            // seconds blind for a wifi blip. Start fast, give up slowly.
            const delay = Math.min(400 * 2 ** (attempt - 1), 15_000)
            const t = setTimeout(() => {
              this.resubTimers.delete(t)
              this.openSub(group, url, filter, onevent, seen)
            }, delay)
            this.resubTimers.add(t)
            return
          }

          // A `CLOSED` frame is a verdict: the relay read the filter and
          // declined it, in its own words. Resubscribing to that loops forever
          // — which is exactly what the relay removed two PRs ago would have
          // made this client do, on every kind it uses.
          this.unreachable.delete(url)
          this.closedSubs.set(url, reason)
          this.entry(url).subscriptionClosed = reason
          // Not never. A relay reconfigured, or a wording this file guessed
          // wrong about, should not cost the whole session — but retrying a
          // real verdict at socket speed is the hammering this branch exists to
          // avoid, so it is one attempt every few minutes and no faster.
          const slow = setTimeout(() => {
            this.resubTimers.delete(slow)
            this.openSub(group, url, filter, onevent, seen)
          }, Net.VERDICT_RETRY_MS)
          this.resubTimers.add(slow)
        },
      }),
    )
  }

  /** Relays that declined our filter, in their own words. Safe to quote. */
  get deafRelays(): { url: string; reason: string }[] {
    return [...this.closedSubs].map(([url, reason]) => ({ url, reason }))
  }

  /**
   * Relays we have not managed to reach, and are still retrying.
   *
   * Not the same thing as a relay that declined us, and not quotable: the
   * wording is the library's account of a silence, not anything a relay said.
   */
  get unreachableRelays(): { url: string; reason: string }[] {
    return [...this.unreachable].map(([url, reason]) => ({ url, reason }))
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
  /**
   * Send an event to every relay that is not currently muted.
   *
   * Returns a promise so a caller with something to undo can wait for the
   * verdict — see `PublishOutcome`. It never rejects: a publish that failed
   * everywhere is a result, not an exception, and the ten-per-second callers
   * ignore it entirely.
   */
  publish(event: Event): Promise<PublishOutcome> {
    const now = Date.now()
    for (const [url, m] of this.muted) if (now >= m.until) this.muted.delete(url)
    // Only the position tick is disposable. It is ten a second and the next one
    // is always 100ms away, so dropping one to stay under a relay's stated cap
    // costs nothing. Everything else — the shell, the death, the claim
    // published exactly once — goes regardless of the pace, because skipping it
    // to save a rate limit would trade a throttle for a divergence.
    const disposable = event.kind === KIND_STATE
    // While the alarm is up, hold — but probe one relay per cycle rather than
    // all of them.
    //
    // The first version broadcast to every relay every twenty seconds, which is
    // the pace probe's bug again at twice the price. newlay credits recovery
    // per *clean* minute and the created_at gate books -4 rather than a rate
    // hit's -2, so three probes a minute is -12/min against a recovery that
    // never accrues: floored in three and a half minutes and pinned there. The
    // cruelty is the timing — the alarm exists because the clock is the one
    // thing a player can go and fix, and this made fixing it cost twenty-five
    // minutes of 0.1x multiplier afterwards.
    //
    // A cycle of M minutes nets 2(M-1) - 4, so M must be at least four to come
    // out positive. Round-robin gets that without slowing detection: any single
    // acceptance clears the streak, so one relay per minute finds a corrected
    // clock exactly as fast as all four would, at a quarter of the cost each.
    if (this.clockAlarm && now - this.lastMalformedProbeAt < this.malformedProbeMs) {
      return Promise.resolve({
        sent: 0, accepted: 0, refused: 0, malformed: 0, unclear: 0,
        unanimouslyRefused: false, definitelyNowhere: true, reason: this.lastMalformedReason,
      })
    }
    const probing = this.clockAlarm !== null
    if (probing) this.lastMalformedProbeAt = now
    const live = this.relays.filter(
      (url) => !this.muted.has(url) && (!disposable || this.paceAllows(url, now)),
    )
    // One relay per probe, rotating, so the -4 is spread instead of multiplied.
    const targets = probing && live.length
      ? [live[this.malformedProbeAt++ % live.length]]
      : live
    const outcome: PublishOutcome = {
      sent: targets.length,
      accepted: 0,
      refused: 0,
      malformed: 0,
      unclear: 0,
      unanimouslyRefused: false,
      definitelyNowhere: false,
      reason: null,
    }
    if (!targets.length) return Promise.resolve(outcome)
    if (disposable) {
      const cost = eventCost(event)
      for (const url of targets) this.paceSpend(url, now, cost)
    }
    const results = this.pool.publish(targets, event)
    this.published += results.length
    // Refusals split by which side of the created_at gate they came from. One
    // prefix out of eight means the opposite of the other seven.
    let belowClockGate = 0
    const passedClockGate = new Set<string>()
    // Distinct relays naming the timestamp, by direction. A URL can only vote
    // once per publish, so a relay answering twice cannot form its own quorum.
    const saidBehind = new Map<string, string>()
    const saidAhead = new Map<string, string>()
    const acceptedBy = new Set<string>()
    const settled = results.map((p, i) => {
      const url = targets[i]
      return p.then(
        () => {
          this.strikes.set(url, 0)
          this.entry(url).accepted++
          outcome.accepted++
          acceptedBy.add(url)
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
            outcome.accepted++
            acceptedBy.add(url)
            return
          }
          if (kind === 'refused') {
            outcome.refused++
            // `rate-limited:` is the only refusal newlay can emit from above
            // the created_at gate — the events bucket and the per-IP gate both
            // run before the timestamp is looked at. So it is positive proof
            // the relay never examined the clock. Every other prefix comes from
            // below that line: `blocked:`, `restricted:`, `auth-required:` and
            // `pow:` all mean created_at was examined and passed, which makes
            // them *stronger* evidence the clock is fine than an acceptance is.
            // Only refusals from below the created_at gate count as evidence
            // the timestamp was read. `rate-limited:` is the one prefix emitted
            // above it — and the count of those used to be kept alongside, but
            // the positive rule subsumed it: a rate limit is neither a clock
            // verdict nor an acquittal, which is the same behaviour reached by
            // better means. Removed rather than left for somebody to build on.
            if (!reason.trim().toLowerCase().startsWith('rate-limited:')) {
              belowClockGate++
              passedClockGate.add(url)
            }
            outcome.reason = reason
          } else if (kind === 'malformed') {
            outcome.malformed++
            outcome.reason = reason
          } else {
            outcome.unclear++
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
          else if (kind === 'malformed') {
            led.malformed++
            const verdict = clockVerdict(reason)
            if (verdict === 'behind') saidBehind.set(url, reason)
            else if (verdict === 'ahead') saidAhead.set(url, reason)
          }
          else led.unknown++

          // Only an actual refusal counts toward giving up on a relay. Silence
          // is not a verdict, our own bad event is not the relay's fault, and a
          // message we cannot parse is not evidence for the destructive option.
          if (kind !== 'refused') return

          // A rate limit that names its number is the one refusal with an
          // instruction in it. Obey the instruction rather than writing the
          // relay off — see RelayPace for why muting makes this strictly worse.
          const limit = parseRateLimit(reason)
          if (limit !== null && this.startPacing(url, limit)) {
            this.strikes.set(url, 0)
            return
          }

          const strikes = (this.strikes.get(url) ?? 0) + 1
          this.strikes.set(url, strikes)
          if (strikes >= Net.MUTE_AFTER) this.mute(url)
        },
      )
    })
    return Promise.all(settled).then(() => {
      outcome.unanimouslyRefused = outcome.refused === outcome.sent && outcome.sent > 0
      outcome.definitelyNowhere =
        outcome.sent === 0 || outcome.refused + outcome.malformed === outcome.sent
      // Every relay we asked said the event itself was bad — but "every relay
      // we asked" is not the same as "every relay", and the difference is
      // biased in exactly the wrong direction.
      //
      // A relay that only ever answers `invalid:` can never be muted, by
      // design: malformed does not strike, because our own bad event is not the
      // relay's fault. Relays that *refuse* us do get muted. So the mute filter
      // systematically removes the relays that would contradict the alarm and
      // keeps the one raising it — the odd relay is the survivor by
      // construction. One relay configured with a lower `max_event_tags` than
      // the tick needs, three muted on something ordinary, and the screen tells
      // the player their clock is wrong when it is fine.
      //
      // So: at least two distinct relays have to agree, and at least half the
      // configured list has to have been asked. If we cannot see the others we
      // cannot tell, and "cannot tell" is not "blame the machine".
      // A probe asks exactly one relay, so it can never satisfy this. That is
      // deliberate: a probe should be able to *clear* the alarm and never to
      // deepen it, or the thing that holds publishing down would also be the
      // thing feeding itself.
      // Only relays that actually examined the timestamp get a vote. A
      // `rate-limited:` refusal is not a dissenting opinion about the clock —
      // it is a relay that never reached the question, and counting it as
      // disagreement is what made this bug deterministic rather than a race.
      //
      // The pacer *manufactures* that refusal on purpose: escalating x1.1 and
      // snapping back on the next refusal is the feedback signal, and without
      // it we never learn a relay has forgiven us. So on any paced relay a
      // rate limit arrives periodically, forever. Four relays, a clock fifteen
      // minutes ahead, one of them paced: that one answers `rate-limited:`, the
      // other three answer `invalid:`, and under the old rule the sample was
      // "not unanimous" *and* the streak was zeroed on every publish. The
      // player's clock is wrong, three relays refuse everything at -4 apiece,
      // and the screen says nothing for the whole session.
      // Quorum, not unanimity — and the difference is not academic.
      //
      // Measured against the four relays this game ships with: at 61 seconds
      // behind, `relay.primal.net`, `purplerelay.com` and `relay.mostr.pub` all
      // answer `invalid: ephemeral event expired`, and `relay.fountain.fm`
      // accepts the same event happily — it took a backdate of an hour and a
      // forward date of thirty minutes without complaint. It has no timestamp
      // gate at all.
      //
      // Under a unanimity rule that one acceptance sank the alarm on every
      // single publish, and `accepted > 0` cleared the streak besides. Three
      // quarters of the relay list refusing every event, the game invisible to
      // everyone not connected through the fourth, and the screen silent.
      //
      // An acceptance is weak evidence: it means the relay did not object, and
      // a relay with no gate never will. Two relays independently naming the
      // same direction is strong. So the quorum wins.
      const behind = saidBehind.size
      const ahead = saidAhead.size
      // Only a witness can recant: an acceptance clears the alarm only if it
      // came from a relay that had named the fault itself.
      const recanted = [...acceptedBy].some((url) => this.clockWitnesses.has(url))
      // The same rule for the other kind of acquittal. `belowClockGate` is any
      // refusal that is not `rate-limited:` — `blocked:`, `restricted:`,
      // `auth-required:`, `pow:` — and a relay answering one of those to every
      // publish never reads the timestamp, so it never becomes a witness and
      // would clear the alarm on every cycle forever. Inert against three stock
      // strfry; not inert the moment a relay with a write allowlist is in the
      // list, because a pubkey that is not on it gets exactly that, every time.
      const witnessPassedTheClock = [...passedClockGate].some((url) =>
        this.clockWitnesses.has(url),
      )
      const winner: ClockDirection | null =
        behind >= 2 && behind >= ahead ? 'behind' : ahead >= 2 ? 'ahead' : null
      const enoughVisible = outcome.sent * 2 >= this.relays.length
      if (winner && enoughVisible) {
        this.allMalformedStreak++
        this.clockDirection = winner
        const votes = winner === 'behind' ? saidBehind : saidAhead
        this.clockAgreed = votes.size
        // Quote a reason at least two relays actually gave, rather than
        // whichever string happened to land last. The counter used to record
        // the kind and not the cause: relay A rejecting on `max_event_tags` and
        // relay B on the timestamp read as agreement, and the screen quoted
        // either one at random.
        const tally = new Map<string, number>()
        for (const r of votes.values()) tally.set(r, (tally.get(r) ?? 0) + 1)
        const shared = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]
        this.lastMalformedReason = shared[0]
        for (const url of votes.keys()) this.clockWitnesses.add(url)
      } else if (
        behind + ahead === 0 &&
        (this.clockWitnesses.size === 0
          ? outcome.accepted > 0 || belowClockGate > 0
          : recanted || witnessPassedTheClock)
      ) {
        // Cleared only when nobody named the timestamp on this publish *and*
        // somebody gave us evidence of any kind. A relay that told us to slow
        // down has not vouched for us, and silence never did.
        // Anything the relays engaged with normally clears it. Silence does
        // not: an unreachable relay is no evidence the clock came right.
        this.allMalformedStreak = 0
        this.clockDirection = null
        this.clockAgreed = 0
        this.clockWitnesses.clear()
      }
      return outcome
    })
  }

  // ------------------------------------------------------------------ pacing

  /** True when this relay is due another disposable event. */
  private paceAllows(url: string, now: number): boolean {
    const p = this.pace.get(url)
    if (!p) return true
    if (now < p.nextAt) return false
    // Quiet for a while: try a little faster, so a relay that has forgiven us
    // can be noticed. Multiplicative up, snap back down on the next refusal.
    // Both clocks have to be old: quiet since the last refusal *and* since the
    // last escalation. Reusing one for both is what made this compound.
    if (now - p.lastRefusalAt > this.paceProbeMs && now - p.lastProbeAt > this.paceProbeMs) {
      p.allowance = Math.min(p.allowance * Net.PACE_STEP, Net.PACE_UNCAP)
      p.lastProbeAt = now
      if (p.allowance >= Net.PACE_UNCAP) {
        this.pace.delete(url)
        this.entry(url).pacedTo = 0
        return true
      }
      this.entry(url).pacedTo = Math.round(p.allowance)
    }
    return true
  }

  private paceSpend(url: string, now: number, cost: number): void {
    const p = this.pace.get(url)
    // Charge the interval by what the event costs the relay's bucket, not by
    // counting events — see `eventCost`.
    if (p) p.nextAt = now + (60_000 * cost) / p.allowance
  }

  /**
   * Start (or tighten) a pace for a relay that named its cap.
   *
   * Returns false when pacing is not the answer after all, which hands the
   * caller back to the strike-and-mute path.
   */
  private startPacing(url: string, limit: number): boolean {
    const now = Date.now()
    let p = this.pace.get(url)
    if (!p) {
      p = {
        allowance: limit * Net.PACE_MARGIN,
        reported: limit,
        lowest: limit,
        nextAt: now,
        lastRefusalAt: now,
        lastProbeAt: now,
        refusalsWhilePaced: 0,
      }
      this.pace.set(url, p)
    } else {
      p.refusalsWhilePaced++
      // Obeying the number and still refused: the number is not the problem.
      if (p.refusalsWhilePaced > Net.PACE_GIVE_UP) {
        this.pace.delete(url)
        this.entry(url).pacedTo = 0
        return false
      }
      p.allowance = limit * Net.PACE_MARGIN
      p.reported = limit
      p.lowest = Math.min(p.lowest, limit)
      p.lastRefusalAt = now
    }
    const led = this.entry(url)
    led.pacedTo = Math.round(p.allowance)
    led.lowestLimit = led.lowestLimit ? Math.min(led.lowestLimit, p.lowest) : p.lowest
    return true
  }

  private entry(url: string): RelayLedger {
    let led = this.ledger.get(url)
    if (!led) {
      led = {
        url, accepted: 0, refused: 0, noVerdict: 0, malformed: 0, unknown: 0,
        lowestLimit: 0, pacedTo: 0, subscriptionClosed: null, reconnects: 0,
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

  /**
   * Raised when every relay has called our events invalid, several in a row.
   *
   * Read by the HUD. While it is set, publishing stops except for an occasional
   * probe, because at that point the relay list is not the problem and no
   * amount of retrying will fix a wrong clock.
   */
  get clockAlarm(): ClockAlarm | null {
    return this.allMalformedStreak >= Net.MALFORMED_STREAK && this.clockDirection
      ? {
          reason: this.lastMalformedReason,
          streak: this.allMalformedStreak,
          direction: this.clockDirection,
          agreed: this.clockAgreed,
        }
      : null
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
    // Set first: a socket torn down by `pool.close` reports as a dropped one,
    // and without this the reconnect loop would fight the shutdown.
    this.disposed = true
    for (const t of this.resubTimers) clearTimeout(t)
    this.resubTimers.clear()
    for (const c of this.closers.values()) c.close()
    this.closers.clear()
    this.pool.close(this.relays)
  }
}
