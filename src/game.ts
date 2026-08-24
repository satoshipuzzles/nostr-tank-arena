// The game: local simulation plus everything that arrives from relays.
//
// Authority model, stated once because it drives every decision below:
//   * Your own tank is authoritative for its position and its HP.
//   * Shells are authoritative from the shooter, but only as "fired at (x, y, a)
//     at t0" — every client re-simulates the flight path itself.
//   * A kill only counts when the *victim* signs a death event. You cannot
//     claim a kill; you can only be told you died.
// The cheat that survives this is a client that refuses to die. See README.

import type { Event } from 'nostr-tools'
import type { PublishOutcome } from './nostr'
import { ARENA_H, ARENA_W, SPAWNS, hasLineOfSight } from './arena'
import {
  PICKUPS,
  PICKUP_RADIUS,
  applyPickup,
  claimTag,
  clearBuffs,
  hasBuff,
  noBuffs,
  scheduleFor,
  waveClock,
  type Buffs,
  type ClaimPayload,
  type Pickup,
} from './pickups'
import { Identity, Net } from './nostr'
import {
  KIND_CLAIM,
  KIND_DEATH,
  KIND_SESSION,
  KIND_SHELL,
  KIND_STATE,
  type DeathPayload,
  type SessionPayload,
  type ShellPayload,
  type StatePayload,
  parsePayload,
  roomTag,
} from './protocol'
import {
  MUZZLE_OFFSET,
  RELOAD,
  RESPAWN_DELAY,
  type LocalTank,
  type Shell,
  lerpAngle,
  shellHits,
  spawnShell,
  stepShell,
  stepTank,
} from './sim'
import type { Controls } from './input'
import { DEFAULT_MODIFIER, type Modifier, modifierForBlock } from './modifiers'
import { type PlayOpts, type Sound, type SoundSink, silence } from './audio'

const TICK_MS = 100 // 10Hz state broadcast
/** Half-angle of a Scattershot fan, radians. Wide enough to matter up close. */
const SCATTER_SPREAD = 0.16
/**
 * Claims in a row that two relays must call expired before the screen says so.
 *
 * Two, not five. A claim is published at most a few times a minute rather than
 * ten times a second, so a long streak would take a whole session to reach —
 * and the confidence here comes from the quorum inside each verdict, not from
 * repetition. There is also no benign cause: the claim is signed and published
 * in the same turn, so outliving a ten-minute expiration means a clock, not a
 * slow network.
 */
const EXPIRED_CLAIM_STREAK = 2

/**
 * How long inbound silence has to last before the HUD says the ear is gone.
 *
 * Generously longer than a tick interval and shorter than `PEER_TIMEOUT_MS` *
 * 1.5, so it fires before every peer has quietly aged out and left a player
 * staring at an arena that looks merely empty.
 */
const READ_SILENCE_MS = 12_000

/**
 * Below this age, a dropped pre-EOSE event was almost certainly live.
 *
 * The two populations are hundreds of seconds apart, so this only has to land
 * somewhere in the gap — it is not a threshold anybody tuned, and it is
 * deliberately far from both edges.
 */
const FRESH_DROP_MS = 2_000

/** The most damage one shell may claim, however the event was written. */
const MAX_HULL = 3
/**
 * How many stored claims to ask a relay for on join.
 *
 * Generous on purpose. Once an unrecognised claim is buffered rather than
 * discarded, asking for too many costs a few hundred bytes and asking for too
 * few is a pad that shows as live when it is gone — which is silent, and looks
 * like netcode.
 */
/**
 * How much of the room's recent traffic to ask a relay for on join: as close to
 * none as a filter allows.
 *
 * This started as `since: now - 30` and cowboy found both halves of why that was
 * wrong. First the clock: a subscriber's `since` is matched by the relay against
 * `created_at` written by everybody else, so a client thirty seconds fast made
 * the floor later than every event in the room and received nothing — and the
 * loopback self-check passed the whole time, because our own `created_at` and
 * our own `since` come off the same broken clock.
 *
 * Replacing it with a count fixed the clock and removed the only thing keeping a
 * *finished match* out of a fresh join. A count never binds: it does not drop
 * until the relay's store drops it, and the real bound turned out to be
 * `ephemeralEventsLifetimeSeconds`, a default in three config files we do not
 * own. A firefight arrived intact three and a half minutes after it ended.
 *
 * So neither a clock nor a count decides this — `onEvent` drops everything that
 * arrives before EOSE, which is exact, per relay, and needs nothing from
 * anybody. This number only exists because a filter always gets some store pass
 * on the way to EOSE, and one event is the smallest honest way to ask for none.
 */
const LIVE_BACKFILL = 1

const CLAIM_BACKFILL = 250
/**
 * How long a relay is asked to keep a claim, in seconds.
 *
 * Longer than it looks like it needs to be, and cowboy found why. NIP-40 is
 * evaluated against the **relay's** clock, not the publisher's: newlay drops an
 * event whose `expiration <= now` on arrival and answers
 * `invalid: event expired`. So this number is really headroom against the gap
 * between our clock and theirs, and a pad only lives 32 seconds.
 *
 * At 120s a client two minutes slow had every claim refused, forever, and one
 * that was 100s slow was worse — its claims died before its pads did, which
 * looks exactly like the ordering bug rather than a clock. Ten minutes is about
 * one block, so it is still one round's worth of litter, and it costs nothing
 * now that unknown claims buffer and ids carry the block hash.
 */
const CLAIM_TTL = 600
/** Kills in a row that earn a full repair. */
const STREAK_REPAIR = 3
/** Kills in a row that earn rapid fire, and a glow so everyone can see it. */
const STREAK_RAPID = 5
/** How long the streak reward's rapid fire lasts. */
const STREAK_RAPID_MS = 14_000
/** How long the podium sits between rounds. */
export const INTERMISSION_MS = 9_000
const SESSION_REBROADCAST_MS = 12_000
/**
 * How often to re-announce ourselves while somebody in the room is unnamed.
 *
 * Both sides do this, so two clients that join together converge in about a
 * second and a half rather than in twelve. It costs one extra event each while
 * anyone is a stranger and nothing at all once the room is settled.
 */
const SESSION_HELLO_MS = 1_500
/** How long to wait after a new arrival before re-announcing, to batch them. */
const HELLO_COALESCE_MS = 250
const INTERP_MS = 130
const MAX_EXTRAPOLATE_MS = 260
const PEER_TIMEOUT_MS = 9_000
const SESSION_TTL_S = 3600

export interface Peer {
  session: string
  pubkey: string | null // verified real npub, null until the attestation lands
  name: string
  color: number // hue the peer published
  displayColor: number // hue we actually draw, after collision spreading
  offset: number // localMs - senderMs, minimum observed
  hasOffset: boolean
  lastSeen: number
  buffer: StateSample[]
  view: { x: number; y: number; hull: number; gun: number; hp: number; dead: boolean }
  kills: number
  deaths: number
  /** Their kills in a row, from the state tick, so their glow is visible here too. */
  streak: number
}

interface StateSample {
  t: number // already shifted into local time
  x: number
  y: number
  hull: number
  gun: number
  hp: number
  dead: boolean
}

export interface FeedEntry {
  text: string
  at: number
}

/** A finished round, kept so the podium has something to show. */
export interface Standing {
  name: string
  kills: number
  deaths: number
  color: number
  you: boolean
  /** Real npub, so the scoreboard can put a face to it. Null until attested. */
  pubkey: string | null
}

export interface RoundResult {
  height: number
  layout: string
  /** The rules that round played under, banked before the next block changes them. */
  modifier: string
  standings: Standing[]
  endedAt: number
}

/** Six hues nobody can confuse for each other, even as 40px tanks. */
const PALETTE = [48, 190, 320, 100, 20, 265]

const randomId = () => {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('')
}

export class Game {
  readonly tank: LocalTank
  readonly peers = new Map<string, Peer>()
  readonly shells = new Map<string, Shell>()
  readonly feed: FeedEntry[] = []
  kills = 0
  deaths = 0
  /** Consecutive kills without dying. Resets on death, drives the repair. */
  streak = 0
  bestStreak = 0
  /** The block this round belongs to. 0 until the chain tip arrives. */
  round = 0
  /** The tip's hash, which seeds the pickup schedule. */
  roundHash = ''
  /** performance.now() when this round started. Local, and for local things only. */
  roundStartedAt = performance.now()
  /**
   * Seconds since the current block was mined, from `BlockClock`.
   *
   * Wired in by `main.ts`. This is what the pickup schedule is anchored to, and
   * it has to be: the wave index goes into the pickup id, so a client measuring
   * from its own first sighting of the tip computes different ids for the same
   * pad and every claim it sends or receives is silently discarded. Default is
   * `null`, which `waveClock` turns into absolute unix seconds — still a shared
   * timeline, unlike a local performance origin.
   */
  chainClock: () => { seconds: number | null; pending: boolean } = () => ({
    seconds: null,
    pending: false,
  })
  /**
   * Pickup ids claimed by somebody, whether or not that pad exists here yet.
   *
   * The missing half of the stored-claim design. A late joiner `REQ`s the
   * round's claims and they arrive *before* the local schedule has caught up to
   * the wave they belong to — and matching a claim only against the pickups that
   * happen to exist this frame threw every one of them away. Remembered here and
   * applied when the pad appears.
   */
  private claimed = new Set<string>()
  /**
   * Pads this client already consumed but could not tell anybody about.
   *
   * A pad restored by `settleClaim` is live for the room again, which is the
   * point — but it is not live for *us*, because we already took it. Without
   * that distinction the restored pad is immediately re-swept by the tank still
   * parked on it.
   */
  private spent = new Set<string>()
  /**
   * Pads this client swept up itself, as opposed to hearing about.
   *
   * `claimed` cannot tell the two apart — it holds every id anybody claimed —
   * and a rollback must not undo a grab that this player genuinely made.
   */
  private minePads = new Set<string>()
  private lastExpiredReason = ''
  /**
   * Diagnostics for the claim path. Both numbers, because either alone lies.
   *
   * `unmatchedClaims` counts claims that arrived before their pad existed —
   * which is normal during backfill and a sign of clock drift afterwards. On its
   * own it reads a healthy zero in the worst case there is: a backfill that
   * fetched nothing at all, where there were no claims to mismatch. So the total
   * is kept beside it, and a client that joined mid-round with `claimsReceived`
   * at zero is the reading to be suspicious of.
   */
  unmatchedClaims = 0
  claimsReceived = 0
  /** Claims every relay refused, so the pad was put back. Non-zero is worth reading. */
  refusedClaims = 0
  /**
   * True when the most recent claim reached nobody, for any reason.
   *
   * Read by the HUD, which names the *symptom* rather than the cause. A player
   * whose clock is a minute slow sees other tanks frozen and pads working
   * perfectly; one whose clock is a quarter of an hour fast sees both break.
   * Those are different sentences and the direction alone does not distinguish
   * them.
   */
  claimsReachingNobody = false
  /**
   * Consecutive claims two or more relays rejected as already expired.
   *
   * This is the slow half of the clock diagnosis, and it needs its own signal
   * because `Net`'s all-malformed streak can never see it. cowboy traced why:
   * `invalid: event expired` is the NIP-40 gate, which only fires for an event
   * that actually carries an `expiration` tag — and in this whole game exactly
   * one does. Every state tick, shell and death goes out with a `t` tag and
   * nothing else, and a slow clock puts their `created_at` in the *past*, where
   * the tolerance is 365 days rather than fifteen minutes. So the ticks land,
   * ten a second, and each acceptance resets a streak that needs five in a row.
   *
   * What that costs a player is the worst failure in the system precisely
   * because it is free: no rate limit, no behaviour penalty, no rejected
   * ticks — the game looks perfectly normal, and every single pickup they grab
   * comes straight back, all session, with nothing on screen to explain it.
   */
  private expiredClaimStreak = 0
  /** Total accepted publishes when the last claim settled, as a liveness control. */
  private acceptedAtLastClaim = 0
  /** Pickups currently on the board, by id. Derived, never received. */
  readonly pickups = new Map<string, Pickup>()
  /** Timed effects on our own tank. */
  readonly buffs: Buffs = noBuffs()
  /** A big centre-screen message. The HUD clears it after a couple of seconds. */
  notice: { text: string; sub: string; hue: number; at: number } | null = null
  /** Set when a block lands; the podium is up until it clears. */
  lastRound: RoundResult | null = null
  intermissionUntil = 0
  /** Our own hue after spreading. Always gets first pick, so it never moves. */
  displayColor: number
  /** Set when a relay subscription has produced at least one event. */
  sawTraffic = false
  /**
   * Events dropped for arriving before EOSE. See `onEvent` for why that is a
   * trade rather than a fact, and why this number is worth being able to read.
   */
  storedDropped = 0
  /** Of those, the ones that looked live. See `onEvent` — age, not rate. */
  storedFresh = 0
  /** performance.now() of the last event any relay delivered. Drives the watchdog. */
  lastInboundAt = 0
  /**
   * The rule change this block is playing under, derived from the same hash
   * that picks the map. Nothing is announced and nobody agrees to it — every
   * client computes it from the tip.
   */
  modifier: Modifier = DEFAULT_MODIFIER
  /**
   * Where sound comes out. A no-op by default, so nothing in the netcode or
   * the simulation depends on audio existing — the smoke test runs the whole
   * match through the default sink without an AudioContext anywhere.
   */
  sfx: SoundSink = silence
  /**
   * Other `Game`s running in this same tab, for local two-player.
   *
   * Everything one player publishes is handed to these directly, in the same
   * turn, as well as going out to the relays. That is the whole of local
   * two-player's netcode and it is worth being precise about why it is not a
   * shortcut around the protocol: the event delivered is the *same signed
   * event* that goes on the wire, through the same `onEvent`. Nothing is
   * special-cased downstream, the two tanks agree for the same reasons two
   * strangers do, and a remote player sees exactly what they would have.
   *
   * What it removes is the round trip. Two people on one couch should not be
   * watching each other at 150ms — that is the one latency in this game that
   * has no excuse, because the sender and the receiver are the same process.
   * `onEvent` already de-duplicates by event id, so the relay's echo a moment
   * later is ignored.
   */
  readonly localMirror: Game[] = []

  private seen = new Set<string>()
  private seenPrev = new Set<string>()
  private lastTick = 0
  private lastSessionBroadcast = 0
  /** When to re-announce because somebody new turned up. 0 when nothing is due. */
  private helloAt = 0
  private disposed = false

  /**
   * A spectator: in the room, on the wire, with no tank.
   *
   * Watching is the honest answer to a full table. The alternative was refusing
   * the join, and a game you cannot look at is a game nobody waits for — a
   * fifth player who can see the round in progress is a fifth player who is
   * still there when a seat frees up.
   *
   * It is a flag rather than a subclass because a spectator is exactly an
   * ordinary client with three things switched off: it does not drive, it does
   * not publish state, and it does not attest a session — so nobody else's
   * scoreboard, roster or spawn logic learns it exists. Everything a spectator
   * *does* do, it does through the same code a player does.
   */
  constructor(
    readonly identity: Identity,
    readonly net: Net,
    readonly room: string,
    readonly name: string,
    readonly color: number,
    /**
     * Mutable, because the waiting list is exactly this flag being turned off.
     * A queued player is a spectator holding a place; when a seat frees they
     * become an ordinary client mid-round, which is the whole point of letting
     * them wait rather than bouncing them.
     */
    public watching = false,
  ) {
    this.displayColor = color
    const spawn = SPAWNS[Math.floor(Math.random() * SPAWNS.length)]
    this.tank = {
      x: spawn.x,
      y: spawn.y,
      hull: Math.atan2(ARENA_H / 2 - spawn.y, ARENA_W / 2 - spawn.x),
      gun: Math.atan2(ARENA_H / 2 - spawn.y, ARENA_W / 2 - spawn.x),
      hp: DEFAULT_MODIFIER.maxHp,
      dead: false,
      respawnAt: 0,
      reloadAt: 0,
    }
  }

  /**
   * Subscribe to the room and publish the session attestation.
   *
   * Two subscriptions, split by how much a missed event costs, and **neither
   * carries a `since`** — a subscriber's clock has no business in a filter the
   * *relay* evaluates.
   *
   * The claim went first, because it is published exactly once and is the only
   * kind here where a wrong answer is permanent for the round. `since = now -
   * 30` was narrower than a pad's 32-second life, and it was computed from this
   * client's clock while the relay matches it against `created_at` written by
   * other clients — so a joiner sixty seconds fast asked for events from the
   * future and backfilled nothing at all.
   *
   * The live stream had the identical bug and it is far worse, because this one
   * is not merely a backfill window: a relay applies the filter to live events
   * too. See `LIVE_BACKFILL`. The reason it survived a round of fixing is that
   * ephemeral traffic self-heals within seconds *when it arrives at all*, which
   * made `since` look like a courtesy rather than a gate.
   *
   * Both are bounded by `limit` now. A claim's NIP-40 expiration already caps
   * how long a relay keeps it, so that window is enforced where it can be
   * enforced honestly — by the publisher, in the event — rather than by a
   * subscriber guessing with a clock nobody else shares. Over-fetching is free
   * now that an unknown claim is buffered rather than dropped: one for a pad
   * that never materialises just ages out.
   */
  async start(): Promise<void> {
    this.net.subscribe(
      {
        kinds: [KIND_SESSION, KIND_STATE, KIND_SHELL, KIND_DEATH],
        '#t': [roomTag(this.room)],
        // Deliberately tiny. Nothing on this subscription is worth replaying —
        // `onEvent` drops everything that arrives before EOSE — so this only
        // exists because a filter always gets *some* store pass, and asking for
        // one event is the smallest honest way to say "none, thank you".
        limit: LIVE_BACKFILL,
      },
      (e, stored) => this.onEvent(e, stored),
    )
    this.net.subscribe(
      { kinds: [KIND_CLAIM], '#t': [roomTag(this.room)], limit: CLAIM_BACKFILL },
      // A claim is *meant* to be read from the store — that is the whole reason
      // it is not an ephemeral event. It is the one kind here where an old copy
      // is the point rather than a hazard.
      (e) => this.onEvent(e, false),
    )
    await this.broadcastSession()
  }

  private async broadcastSession(): Promise<void> {
    // A spectator has no tank to attest, and a session attestation is what puts
    // a name on the scoreboard. Gated here rather than only at the call sites,
    // because `start()` sends one too and a spectator appearing in the roster
    // as a tank nobody can see is worse than not appearing at all.
    if (this.watching) return
    const payload: SessionPayload = {
      s: this.identity.sessionPubkey,
      name: this.name,
      color: this.color,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
    }
    const signed = await this.identity.signAsSelf({
      kind: KIND_SESSION,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', roomTag(this.room)]],
      content: JSON.stringify(payload),
    })
    this.net.publish(signed)
    this.mirror(signed)
    this.lastSessionBroadcast = performance.now()
  }

  private publishAsSession(kind: number, payload: unknown): void {
    const event = this.identity.signAsSession({
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', roomTag(this.room)]],
      content: JSON.stringify(payload),
    })
    this.net.publish(event)
    this.mirror(event)
  }

  /** Hand a freshly signed event to the other local players, without a relay. */
  private mirror(event: Event): void {
    for (const other of this.localMirror) other.onEvent(event)
  }

  // ---------------------------------------------------------------- inbound

  /**
   * `stored` is true for anything a relay replayed out of its store on join.
   *
   * That distinction has to exist and it cannot be a time window. Dropping
   * `since` from the live filter fixed a clock bug and removed the only thing
   * keeping a *finished match* out of a fresh join — `limit` never binds,
   * because the count does not drop until the relay's store drops it, and the
   * bound turned out to be `ephemeralEventsLifetimeSeconds` in somebody else's
   * config. cowboy measured a firefight arriving intact three and a half
   * minutes after it ended, on all three relays.
   *
   * What that did to a joining player: shells from a match that was over
   * spawning at the muzzle and taking hull points off them, somebody else's
   * deaths in their kill feed and on their scoreboard, and ghost tanks standing
   * in the arena for the nine seconds of `PEER_TIMEOUT_MS`.
   *
   * The fast-forward in `onShell` looks like it bounds this and cannot: for a
   * peer never seen before, `updateOffset` sets `peer.offset` from that very
   * event, so `lateMs` is exactly zero and a shell fired minutes ago arrives
   * with its full four seconds of flight and its full damage. **A staleness
   * check whose reference is derived from the stale data** — the same shape as
   * a loopback that passes because both sides come off the same broken clock.
   *
   * EOSE is the honest boundary: every relay sends it when its store is
   * exhausted, it is exact, and it needs no clock, no `since`, and nothing
   * agreed with anybody. A shell fired before we joined is not a shell, it is a
   * record that one was fired — there is no such thing as a late one.
   *
   * ## Where this is a trade rather than a fact
   *
   * "Pre-EOSE means stored" is true of strfry and cowboy measured it holding
   * with a second to spare — forty shells published during a deliberately slow
   * store pass, none delivered early, none lost. It is **not** true of newlay,
   * which registers a subscription before running the query (deliberately, to
   * close the gap where a live event falls between the scan and the live path)
   * and flushes that buffer *before* sending EOSE. On newlay a shell fired at
   * you while your subscription is opening arrives pre-EOSE, and this line
   * throws it away.
   *
   * Kept anyway, because the two errors are not the same size. Dropping a live
   * event costs a few milliseconds of a window that only exists while joining,
   * and every kind here survives it: a tick is replaced 100ms later, an
   * attestation is re-announced when a new peer appears, a missed shell means a
   * hit that never lands on a victim who is authoritative over its own hull
   * anyway. Accepting a stored one costs a ghost match — shells with full
   * damage, somebody else's deaths in the feed, phantom tanks.
   *
   * `storedDropped` counts them so the trade is observable, and `storedFresh`
   * is the half that says which population they came from.
   *
   * Rate does not distinguish the two, which is a correction cowboy made to an
   * earlier version of this comment. A relay that flushes its live buffer onto
   * the stored side does it **once per subscription registration** and then goes
   * live — bounded by however long its historical query took, exactly the same
   * shape as a stored replay: a burst at join, then nothing. So a *sustained*
   * climb is not ordering at all, it is churn: something resubscribing over and
   * over, each pass re-opening its own little pre-EOSE window.
   *
   * **Age is the discriminator.** A stored ghost is seconds to minutes old; a
   * live event flushed early is milliseconds old, and no plausible clock skew
   * closes a gap that wide. Read as a relative signal only — the subtraction is
   * against our own clock, so a skewed client shifts every reading by its own
   * offset, which is the exact failure this game spent a day on.
   */
  onEvent(e: Event, stored = false): void {
    if (this.disposed) return
    // Nothing on the ephemeral subscription survives the store, not even the
    // roster. A stored tick names somebody who *was* here and does not place
    // them: creating a peer from it stands a ghost tank in the middle of the
    // arena for the nine seconds of `PEER_TIMEOUT_MS`, and its timestamp would
    // seed `peer.offset` off a minutes-old clock, which is what made the shell
    // fast-forward read zero. Anyone genuinely present rebroadcasts their
    // session attestation every `SESSION_REBROADCAST_MS` and ticks ten times a
    // second, so the roster rebuilds from live traffic within moments — at the
    // cost of nothing, because a stale roster entry is a lie about who is here.
    if (stored) {
      this.storedDropped++
      // Milliseconds old rather than minutes: this was a live event the relay
      // put on the wrong side of EOSE, and dropping it is the cost of the trade
      // rather than the point of it.
      if (Date.now() - e.created_at * 1000 < FRESH_DROP_MS) this.storedFresh++
      return
    }
    if (this.seen.has(e.id) || this.seenPrev.has(e.id)) return
    this.seen.add(e.id)
    if (this.seen.size > 3000) {
      // Rotate rather than clear: a clear would let a redelivered death event
      // count a second time.
      this.seenPrev = this.seen
      this.seen = new Set()
    }
    this.sawTraffic = true
    this.lastInboundAt = performance.now()

    switch (e.kind) {
      case KIND_SESSION:
        return this.onSession(e)
      case KIND_STATE:
        return this.onState(e)
      case KIND_SHELL:
        return this.onShell(e)
      case KIND_DEATH:
        return this.onDeath(e)
      case KIND_CLAIM:
        return this.onClaim(e)
    }
  }

  private onSession(e: Event): void {
    const p = parsePayload<SessionPayload>(e.content)
    if (!p || typeof p.s !== 'string' || p.s.length !== 64) return
    if (p.s === this.identity.sessionPubkey) return
    if (typeof p.exp === 'number' && p.exp * 1000 < Date.now()) return

    // The attestation is signed by the real npub and names the session key, so
    // this binding is the one thing in the protocol we can actually verify.
    const peer = this.ensurePeer(p.s)
    peer.pubkey = e.pubkey
    peer.name = typeof p.name === 'string' && p.name ? p.name.slice(0, 20) : peer.name
    peer.color = typeof p.color === 'number' ? p.color % 360 : peer.color
  }

  private ensurePeer(session: string): Peer {
    let peer = this.peers.get(session)
    if (!peer) {
      peer = {
        session,
        pubkey: null,
        name: 'tank-' + session.slice(0, 4),
        color: (parseInt(session.slice(0, 4), 16) || 0) % 360,
        displayColor: (parseInt(session.slice(0, 4), 16) || 0) % 360,
        offset: 0,
        hasOffset: false,
        lastSeen: performance.now(),
        buffer: [],
        view: { x: ARENA_W / 2, y: ARENA_H / 2, hull: 0, gun: 0, hp: this.maxHp, dead: false },
        kills: 0,
        deaths: 0,
        streak: 0,
      }
      this.peers.set(session, peer)
      // Somebody just arrived, and they missed everything we have already said.
      // Coalesced through a deadline rather than published here, so four tanks
      // joining at once produce one hello each instead of four.
      if (!this.helloAt) this.helloAt = performance.now() + HELLO_COALESCE_MS
    }
    return peer
  }

  /**
   * Track the offset between a peer's clock and ours. The minimum of
   * (ourNow - theirStamp) is the least-delayed sample we have seen, so it is
   * the closest thing to the true offset without a round trip.
   */
  private updateOffset(peer: Peer, senderMs: number): void {
    const sample = performance.now() - senderMs
    if (!peer.hasOffset || sample < peer.offset) {
      peer.offset = sample
      peer.hasOffset = true
    }
  }

  private onState(e: Event): void {
    const p = parsePayload<StatePayload>(e.content)
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return
    if (e.pubkey === this.identity.sessionPubkey) return

    const peer = this.ensurePeer(e.pubkey)
    peer.lastSeen = performance.now()
    this.updateOffset(peer, p.t)

    const sample: StateSample = {
      t: p.t + peer.offset,
      x: p.x,
      y: p.y,
      hull: p.h,
      gun: p.g,
      hp: typeof p.hp === 'number' ? p.hp : this.maxHp,
      dead: !!p.d,
    }
    // Cosmetic and self-reported, exactly like the HP beside it. A streak you
    // cannot see on the tank that has it is a number in somebody else's HUD.
    peer.streak = typeof p.k === 'number' && p.k > 0 ? Math.min(99, Math.floor(p.k)) : 0
    // Relays deliver out of order often enough to matter; keep the buffer sorted.
    const b = peer.buffer
    let i = b.length
    while (i > 0 && b[i - 1].t > sample.t) i--
    b.splice(i, 0, sample)
    if (b.length > 20) b.splice(0, b.length - 20)
  }

  private onShell(e: Event): void {
    const p = parsePayload<ShellPayload>(e.content)
    if (!p || typeof p.x !== 'number' || typeof p.a !== 'number') return
    if (e.pubkey === this.identity.sessionPubkey) return
    if (this.shells.has(p.id)) return

    const peer = this.ensurePeer(e.pubkey)
    peer.lastSeen = performance.now()
    this.updateOffset(peer, p.t0)

    const bounces = typeof p.b === 'number' && p.b >= 0 ? Math.min(8, Math.floor(p.b)) : 1
    // Capped rather than trusted. Damage is the one number a shooter sends that
    // the victim then applies to itself, so it gets a ceiling: a malformed or
    // hostile event can take a full hull off, and no more than that.
    const damage =
      typeof p.d === 'number' && p.d >= 1 ? Math.min(MAX_HULL, Math.floor(p.d)) : 1
    const shell = spawnShell(p.id, e.pubkey, p.x, p.y, p.a, bounces, damage)
    this.sound('fire', { at: { x: p.x, y: p.y } })
    // Fast-forward by however long the event spent in flight, so the shell
    // appears where the shooter already sees it rather than at the muzzle.
    const lateMs = performance.now() - (p.t0 + peer.offset)
    stepShell(shell, Math.max(0, Math.min(1500, lateMs)) / 1000)
    if (!shell.dead) this.shells.set(shell.id, shell)
  }

  private onDeath(e: Event): void {
    const p = parsePayload<DeathPayload>(e.content)
    if (!p) return
    // Relays echo our own publishes straight back. Without this guard we would
    // create a peer for ourselves and count the death twice.
    if (e.pubkey === this.identity.sessionPubkey) return
    const victim = this.ensurePeer(e.pubkey)
    victim.lastSeen = performance.now()
    victim.deaths++

    const killerName =
      p.k === this.identity.sessionPubkey
        ? this.name
        : p.k
          ? (this.peers.get(p.k)?.name ?? 'someone')
          : null

    victim.streak = 0
    this.sound('death', { at: { x: p.x, y: p.y } })
    if (p.k === this.identity.sessionPubkey) {
      this.kills++
      this.sound('kill')
      this.onOwnKill()
    } else if (p.k) {
      const killer = this.peers.get(p.k)
      if (killer) killer.kills++
    }

    this.pushFeed(
      killerName ? `${killerName} killed ${victim.name}` : `${victim.name} self-destructed`,
    )
  }

  /**
   * A kill we were credited with.
   *
   * The repair is deliberately self-authoritative: our own HP is the one number
   * this client is already allowed to decide, so a streak reward needs no new
   * trust, no new event kind and no agreement with anybody. It rides out in the
   * next state tick like any other HP change, and a cheater who hands themselves
   * hull points was already able to do exactly that.
   */
  private onOwnKill(): void {
    const now = performance.now()
    this.streak++
    this.bestStreak = Math.max(this.bestStreak, this.streak)

    if (this.streak === STREAK_REPAIR) {
      this.tank.hp = this.maxHp
      this.repairedAt = now
      this.sound('streak')
      this.announce(`${STREAK_REPAIR} IN A ROW`, 'hull repaired', 130)
    } else if (this.streak === STREAK_RAPID) {
      this.sound('streak')
      this.buffs.rapidUntil = Math.max(this.buffs.rapidUntil, now) + STREAK_RAPID_MS
      this.announce(`${STREAK_RAPID} IN A ROW`, 'rapid fire — and everyone can see you', 20)
    } else if (this.streak > STREAK_RAPID) {
      this.announce(`${this.streak} IN A ROW`, 'unstoppable', 45)
    } else {
      this.pushFeed(`${this.streak} in a row`)
    }
  }

  /** A banner, and a line in the feed. Bigger than the feed alone deserves. */
  private announce(text: string, sub: string, hue: number): void {
    this.notice = { text, sub, hue, at: performance.now() }
    this.pushFeed(`${text.toLowerCase()} — ${sub}`)
  }

  /** Set when a repair lands, so the renderer can show it. */
  repairedAt = 0

  /**
   * "Our clock is behind", when the only events carrying a deadline die of it.
   *
   * The evidence is a fingerprint rather than a tally, and the shape of it is
   * what makes it trustworthy: two or more relays rejected the last claims as
   * already expired **while state ticks from this same session are being
   * accepted**. The ticks landing are not noise to filter out, they are the
   * control — they prove the relays are reachable, that they are reading our
   * events, and that nothing else about this client is wrong. A relay that
   * takes a tick and refuses a claim carrying `created_at + CLAIM_TTL` has told
   * us one thing and only one thing.
   *
   * Two relays, not one, for the same reason the fast alarm needs two: one
   * relay disagreeing about the time is the relay.
   *
   * The threshold is ours rather than theirs, which is why the reason carries no
   * `window` for the fast path's regex to find. `CLAIM_TTL` is the number that
   * had to be outlived, so it is also the number to put on the screen.
   *
   * Honest limit: this is a *relative* verdict. It says our clock and theirs
   * disagree by more than `CLAIM_TTL` in that direction, which is what a player
   * needs, but it cannot rule out two relays that are both fast. The quorum is
   * what makes that unlikely.
   */
  get slowClockAlarm(): { behindBySeconds: number; reason: string } | null {
    return this.expiredClaimStreak >= EXPIRED_CLAIM_STREAK
      ? { behindBySeconds: CLAIM_TTL, reason: this.lastExpiredReason }
      : null
  }

  /**
   * True when nothing has come back from any relay for a while.
   *
   * One check that covers every read-path failure in this game, and the reason
   * it works is that **relays echo our own events to our own subscription.**
   * `onEvent` discards our ticks a few lines later, but they arrive — ten a
   * second, from every relay that is still listening — so a healthy read path
   * is never quiet, whether or not anybody else is in the room. Silence means
   * the ear is gone, not that the arena is empty.
   *
   * Which covers a dropped socket, a `CLOSED` we could not act on, and a filter
   * that matches nothing — three failures with three unrelated causes and one
   * symptom, and every one of them used to be completely invisible: still
   * publishing, still on everybody else's screen, seeing nothing.
   *
   * `sawTraffic` and `lastInboundAt` were both already wired up. Nothing read
   * them, which is its own lesson — an instrument with no consumer is not an
   * instrument.
   */
  get readPathStalled(): boolean {
    if (!this.sawTraffic || this.tank.dead) return false
    return performance.now() - this.lastInboundAt > READ_SILENCE_MS
  }

  /** Hull points this round. Glass Cannon makes it 1. */
  get maxHp(): number {
    return this.modifier.maxHp
  }

  /** Sound that happened somewhere on the board, attenuated from our own tank. */
  private sound(name: Sound, opts: PlayOpts = {}): void {
    this.sfx(name, opts.at ? { ...opts, ear: { x: this.tank.x, y: this.tank.y } } : opts)
  }

  private pushFeed(text: string): void {
    this.feed.push({ text, at: performance.now() })
    if (this.feed.length > 6) this.feed.shift()
  }

  // ----------------------------------------------------------------- update

  update(dt: number, controls: Controls): void {
    const now = performance.now()

    if (this.watching) {
      // No tank to step, no pad to sweep, nothing to say. The rest of `update`
      // still runs: shells, interpolation, the roster and the pickup schedule
      // are what a spectator came to see.
    } else if (this.tank.dead) {
      if (now >= this.tank.respawnAt) this.respawn()
    } else {
      const boost = (hasBuff(this.buffs, 'speedUntil', now) ? 1.45 : 1) * this.modifier.speed
      stepTank(this.tank, controls.throttle, controls.steer, controls.aim, dt, boost)
      if (controls.fire && now >= this.tank.reloadAt) this.fire(now)
      this.sweepPickups(now)
    }
    this.refreshPickups()

    for (const shell of this.shells.values()) {
      stepShell(shell, dt)
      if (shell.dead) {
        this.shells.delete(shell.id)
        continue
      }
      this.collide(shell)
    }

    this.interpolate(now)
    this.prunePeers(now)
    this.spreadColors()

    if (now - this.lastTick >= TICK_MS) {
      this.lastTick = now
      this.publishState(now)
    }
    // Say hello again whenever somebody new turns up, and rebroadcast on a slow
    // timer otherwise.
    //
    // The attestation is the only thing binding a tick key to a real npub, so an
    // unverified peer renders as `tank-1a2b` with a `?` after it. That used to
    // be papered over by the relay's store, which handed a joining client
    // everyone's last attestation for free. Nothing is replayed now — a stored
    // tick is a ghost and a stored death is somebody else's scoreboard — so the
    // roster has to be built from live traffic.
    //
    // The trigger has to be *a new peer*, not "somebody here is unverified".
    // The first version used the latter and was one-sided in exactly the way
    // that matters: the player who arrived first sees the newcomer's attestation
    // immediately, so they have no strangers, no reason to speak, and the
    // newcomer sits looking at an anonymous tank until the twelve-second timer
    // comes round. The one who needs to be re-announced to is the one who cannot
    // tell they are missing anything.
    if (this.watching) {
      while (this.feed.length && now - this.feed[0].at > 6000) this.feed.shift()
      return
    }
    if (this.helloAt && now >= this.helloAt && now - this.lastSessionBroadcast >= SESSION_HELLO_MS) {
      this.helloAt = 0
      void this.broadcastSession()
    } else if (now - this.lastSessionBroadcast >= SESSION_REBROADCAST_MS) {
      void this.broadcastSession()
    }
    while (this.feed.length && now - this.feed[0].at > 6000) this.feed.shift()
  }

  private collide(shell: Shell): void {
    // Only our own tank's HP is authoritative, so that is the only hit that
    // changes game state. Hits on remote tanks just remove the shell locally
    // so it does not sail visually through someone.
    if (
      shell.owner !== this.identity.sessionPubkey &&
      !this.tank.dead &&
      shellHits(shell, this.tank.x, this.tank.y)
    ) {
      this.shells.delete(shell.id)
      // A shield eats the shot and is spent. Same authority as HP: our own
      // tank decides what happened to it, and the result rides out in the next
      // state tick like any other change.
      if (hasBuff(this.buffs, 'shieldUntil', performance.now())) {
        this.buffs.shieldUntil = 0
        this.sound('shield')
        this.announce('SHIELD BROKE', 'that one was free', 200)
        return
      }
      this.tank.hp -= shell.damage
      if (this.tank.hp > 0) this.sound('hit')
      if (this.tank.hp <= 0) this.die(shell.owner)
      return
    }

    for (const peer of this.peers.values()) {
      if (peer.session === shell.owner || peer.view.dead) continue
      if (shellHits(shell, peer.view.x, peer.view.y)) {
        this.shells.delete(shell.id)
        return
      }
    }
  }

  /**
   * Pull the trigger.
   *
   * Scattershot makes this three shells rather than one, which means three fire
   * events instead of one — and that is the reason it is a 14-second pickup and
   * not a permanent weapon. A shot is roughly one event a second per player; a
   * position tick is ten. Tripling the rarer of the two for a quarter of a
   * minute is a rounding error against the tick stream, and worth checking
   * before adding anything that multiplies events.
   */
  private fire(now: number): void {
    const rapid = hasBuff(this.buffs, 'rapidUntil', now) ? 0.42 : 1
    this.tank.reloadAt = now + RELOAD * 1000 * rapid * this.modifier.reload
    const bounces = this.modifier.bounces
    const damage = hasBuff(this.buffs, 'siegeUntil', now) ? 2 : 1
    const spread = hasBuff(this.buffs, 'scatterUntil', now) ? [-SCATTER_SPREAD, 0, SCATTER_SPREAD] : [0]
    for (const offset of spread) {
      const angle = this.tank.gun + offset
      const x = this.tank.x + Math.cos(angle) * MUZZLE_OFFSET
      const y = this.tank.y + Math.sin(angle) * MUZZLE_OFFSET
      const shell = spawnShell(randomId(), this.identity.sessionPubkey, x, y, angle, bounces, damage)
      this.shells.set(shell.id, shell)
      // Bounce budget and damage go out with the shell rather than being looked
      // up on arrival: one so a shell outlives a block boundary under the rules
      // it was fired under, the other because the victim applies the damage and
      // cannot see the shooter's buffs.
      const payload: ShellPayload = { id: shell.id, t0: now, x, y, a: angle, b: bounces, d: damage }
      this.publishAsSession(KIND_SHELL, payload)
    }
    this.sound('fire')
  }

  private die(killer: string | null): void {
    this.tank.dead = true
    this.tank.hp = 0
    this.streak = 0
    clearBuffs(this.buffs)
    this.tank.respawnAt = performance.now() + RESPAWN_DELAY * 1000 * this.modifier.respawn
    this.deaths++
    this.sound('death')
    const payload: DeathPayload = {
      t: performance.now(),
      k: killer,
      x: this.tank.x,
      y: this.tank.y,
    }
    this.publishAsSession(KIND_DEATH, payload)
    const killerName = killer ? (this.peers.get(killer)?.name ?? 'someone') : null
    this.pushFeed(killerName ? `${killerName} killed you` : 'you self-destructed')
  }

  /** Spawn as far from live opponents as possible, preferring no line of sight. */
  /**
   * Stop watching and drive.
   *
   * The tank has existed the whole time — it was constructed, it just never
   * published or moved — so this is a respawn rather than a birth. Respawning
   * matters: the spectator's tank has been parked on whatever spawn it drew at
   * construction for however long the wait lasted, and dropping into the round
   * on top of somebody is a worse welcome than the wait was.
   */
  takeSeat(): void {
    if (!this.watching) return
    this.watching = false
    this.respawn()
    this.pushFeed('you are in — take a seat')
    // Say hello immediately rather than on the twelve-second timer: until the
    // attestation lands, everyone else sees an unnamed tank appear from nowhere.
    void this.broadcastSession()
  }

  private respawn(): void {
    const live = [...this.peers.values()].filter((p) => !p.view.dead)
    let best = SPAWNS[0]
    let bestScore = -Infinity
    for (const s of SPAWNS) {
      let score = Infinity
      for (const p of live) {
        let d = Math.hypot(p.view.x - s.x, p.view.y - s.y)
        if (hasLineOfSight(s.x, s.y, p.view.x, p.view.y)) d *= 0.4
        score = Math.min(score, d)
      }
      if (score > bestScore) {
        bestScore = score
        best = s
      }
    }
    this.tank.x = best.x
    this.tank.y = best.y
    this.tank.hp = this.maxHp
    this.tank.dead = false
    this.sound('respawn')
    this.tank.hull = Math.atan2(ARENA_H / 2 - best.y, ARENA_W / 2 - best.x)
    this.tank.gun = this.tank.hull
  }

  /**
   * Draw remote tanks INTERP_MS in the past so there is always a pair of
   * samples to blend between. If the buffer runs dry we extrapolate briefly
   * rather than freezing, then give up and let the tank sit still.
   */
  private interpolate(now: number): void {
    const renderAt = now - INTERP_MS
    for (const peer of this.peers.values()) {
      const b = peer.buffer
      if (b.length === 0) continue
      const newest = b[b.length - 1]

      if (renderAt >= newest.t) {
        const ahead = Math.min(renderAt - newest.t, MAX_EXTRAPOLATE_MS)
        const prev = b.length >= 2 ? b[b.length - 2] : null
        let vx = 0
        let vy = 0
        if (prev && newest.t > prev.t) {
          vx = (newest.x - prev.x) / (newest.t - prev.t)
          vy = (newest.y - prev.y) / (newest.t - prev.t)
        }
        peer.view.x = newest.x + vx * ahead
        peer.view.y = newest.y + vy * ahead
        peer.view.hull = newest.hull
        peer.view.gun = newest.gun
        peer.view.hp = newest.hp
        peer.view.dead = newest.dead
        continue
      }

      let a = b[0]
      let bb = b[0]
      for (let i = 0; i < b.length - 1; i++) {
        if (b[i].t <= renderAt && b[i + 1].t >= renderAt) {
          a = b[i]
          bb = b[i + 1]
          break
        }
      }
      const span = bb.t - a.t
      const t = span > 0 ? (renderAt - a.t) / span : 0
      peer.view.x = a.x + (bb.x - a.x) * t
      peer.view.y = a.y + (bb.y - a.y) * t
      peer.view.hull = lerpAngle(a.hull, bb.hull, t)
      peer.view.gun = lerpAngle(a.gun, bb.gun, t)
      peer.view.hp = bb.hp
      peer.view.dead = bb.dead
      while (b.length > 2 && b[1].t < renderAt) b.shift()
    }
  }

  /**
   * Hues come from each player's own pubkey, so two people routinely turn up
   * the same colour — and nudging a hue by 30 degrees is not enough, two greens
   * 30 degrees apart still read as one green at arena zoom. So everyone snaps
   * to a fixed palette of six hues that are obviously different from each
   * other, and collisions take the next free slot.
   *
   * Purely local and purely cosmetic: your screen may colour a rival
   * differently to how they colour themselves, which matters far less than
   * being able to tell four tanks apart at a glance.
   */
  private spreadColors(): void {
    const used = new Set<number>()
    const take = (hue: number): number => {
      // Start from whichever palette slot is closest to their chosen hue.
      let start = 0
      let bestGap = Infinity
      for (let i = 0; i < PALETTE.length; i++) {
        const gap = Math.abs(((PALETTE[i] - hue + 540) % 360) - 180)
        if (gap < bestGap) {
          bestGap = gap
          start = i
        }
      }
      for (let i = 0; i < PALETTE.length; i++) {
        const slot = (start + i) % PALETTE.length
        if (!used.has(slot)) {
          used.add(slot)
          return PALETTE[slot]
        }
      }
      return PALETTE[start]
    }
    // We pick first so our own tank keeps one colour for the whole match, then
    // peers in a stable order so nobody swaps colour as the roster changes.
    this.displayColor = take(this.color)
    const ordered = [...this.peers.values()].sort((a, b) => (a.session < b.session ? -1 : 1))
    for (const p of ordered) p.displayColor = take(p.color)
  }

  private prunePeers(now: number): void {
    for (const [k, p] of this.peers) {
      if (now - p.lastSeen > PEER_TIMEOUT_MS) this.peers.delete(k)
    }
  }

  private publishState(now: number): void {
    if (this.watching) return
    const payload: StatePayload = {
      t: now,
      x: Math.round(this.tank.x * 10) / 10,
      y: Math.round(this.tank.y * 10) / 10,
      h: Math.round(this.tank.hull * 1000) / 1000,
      g: Math.round(this.tank.gun * 1000) / 1000,
      hp: this.tank.hp,
      d: this.tank.dead,
      ...(this.streak > 0 ? { k: this.streak } : {}),
    }
    this.publishAsSession(KIND_STATE, payload)
  }

  /**
   * A block landed: bank the round and start the next one.
   *
   * Everything resets except who is in the room. Nobody sends a "round over"
   * message and nobody is the host — every client is watching the same chain
   * tip, so they all do this within a few seconds of each other. That is the
   * whole reason the block is the clock.
   */
  /** A new block: reset the round clock and the derived pickup schedule. */
  beginRound(height: number, hash: string): void {
    this.round = height
    this.roundHash = hash
    this.roundStartedAt = performance.now()
    this.pickups.clear()
    // The claim buffer is deliberately *not* cleared here.
    //
    // Claim ids carry the block hash, so last round's cannot collide with this
    // round's and keeping them costs a bounded few kilobytes. Clearing them
    // does cost something: `beginRound` fires on the first tip a session sees,
    // which is a few hundred milliseconds after `start()` opened the backfill
    // subscription — so a joiner's backfilled claims would be wiped by the very
    // call that first makes the pads they refer to derivable. That is the same
    // shape as dropping them on arrival, moved one step later.
    this.modifier = modifierForBlock(hash)
    // Glass Cannon narrows the hull; a tank carrying three points into a
    // one-hit round would be invincible for two shots and nobody would know
    // why. Coming the other way, a full hull is the fair read of "new round".
    this.tank.hp = this.tank.dead ? 0 : this.maxHp
    if (this.modifier.id !== 'standard') {
      this.pushFeed(`${this.modifier.name.toLowerCase()} — ${this.modifier.blurb.toLowerCase()}`)
    }
  }

  endRound(height: number, layoutName: string): RoundResult {
    const result: RoundResult = {
      height: this.round || height - 1,
      layout: layoutName,
      modifier: this.modifier.name,
      standings: this.scoreboard(),
      endedAt: Date.now(),
    }
    this.lastRound = result
    this.intermissionUntil = performance.now() + INTERMISSION_MS
    this.round = height
    this.kills = 0
    this.deaths = 0
    this.streak = 0
    this.bestStreak = 0
    clearBuffs(this.buffs)
    // Peer tallies are ours to keep, not theirs to send, so they reset here too.
    for (const peer of this.peers.values()) {
      peer.kills = 0
      peer.deaths = 0
      peer.streak = 0
    }
    this.sound('block')
    this.pushFeed(`block ${height} — new round on ${layoutName}`)
    return result
  }

  // ---------------------------------------------------------------- pickups

  /**
   * Rebuild the set of live pickups from the round clock.
   *
   * Derived every frame rather than stored, because "derived" is what makes it
   * agree across clients with nothing on the wire. `taken` is the only piece of
   * state that is not a function of the block hash, and it is carried forward
   * across rebuilds so a claimed pad stays empty until the next wave.
   */
  private refreshPickups(): void {
    if (!this.roundHash) return
    const anchor = this.chainClock()
    // Wait rather than guess. Spawning a board off the shared-unix fallback and
    // then recomputing it when the block's real timestamp lands changes every
    // pickup id at once, at each client's own HTTP latency — which is the
    // two-timelines bug this anchor was added to remove, reintroduced from the
    // inside. An empty board for one round trip is invisible.
    if (anchor.pending) return
    const elapsed = waveClock(anchor.seconds)
    const want = scheduleFor(this.roundHash, elapsed, {
      waveSeconds: this.modifier.waveSeconds,
      padsPerWave: this.modifier.padsPerWave,
    })
    const wanted = new Set(want.map((p) => p.id))

    for (const id of [...this.pickups.keys()]) {
      if (!wanted.has(id)) this.pickups.delete(id)
    }
    for (const pickup of want) {
      const existing = this.pickups.get(pickup.id)
      if (existing) continue
      // A claim may have arrived before this pad was derived — a late joiner's
      // backfill always does. Honour it now rather than spawning something
      // somebody already took.
      if (this.claimed.has(pickup.id)) pickup.taken = true
      this.pickups.set(pickup.id, pickup)
    }
  }

  /** Anything we are standing on, taken immediately and announced afterwards. */
  private sweepPickups(now: number): void {
    for (const pickup of this.pickups.values()) {
      if (pickup.taken || this.spent.has(pickup.id)) continue
      const dx = pickup.at.x - this.tank.x
      const dy = pickup.at.y - this.tank.y
      if (dx * dx + dy * dy > PICKUP_RADIUS * PICKUP_RADIUS) continue

      pickup.taken = true
      this.claimed.add(pickup.id)
      this.minePads.add(pickup.id)
      const spec = PICKUPS[pickup.kind]
      if (pickup.kind === 'repair') {
        this.tank.hp = this.maxHp
        this.repairedAt = now
      } else {
        applyPickup(this.buffs, pickup.kind, now)
      }
      // Scattershot and Siege change what your gun does rather than what your
      // tank does, and a shared chime made them indistinguishable at the moment
      // it matters — when you are already driving away.
      this.sound(pickup.kind === 'scatter' ? 'scatter' : pickup.kind === 'siege' ? 'siege' : 'pickup')
      this.announce(
        spec.label.toUpperCase(),
        pickup.kind === 'repair' ? spec.blurb : `${spec.blurb} — ${spec.seconds}s`,
        spec.hue,
      )
      this.publishClaim(pickup)
    }
  }

  /**
   * Tell the room a pad is gone.
   *
   * Stored, not ephemeral, and that is the whole point: an ephemeral claim
   * never reaches a client that connected a moment later and cannot be asked
   * for afterwards, so late joiners would see pickups that are not there. The
   * NIP-40 `expiration` keeps the relay from holding game litter — the pad is
   * meaningless two minutes after the wave that made it.
   *
   * The `d` tag names the claimant as well as the pickup, so two claims on the
   * same pad coexist instead of one replacing the other. A relay that kept only
   * the last one would be quietly deciding who won.
   */
  private publishClaim(pickup: Pickup): void {
    const payload: ClaimPayload = { p: pickup.id, kind: pickup.kind }
    // One reading of the clock for both numbers. Two calls to `Date.now()`
    // straddling a signature is a bug waiting to be written, and the whole
    // point of the expiration is that it is a fixed offset from `created_at`.
    const now = Math.floor(Date.now() / 1000)
    const event = this.identity.signAsSession({
      kind: KIND_CLAIM,
      created_at: now,
      tags: [
        ['d', claimTag(pickup.id, this.identity.sessionPubkey)],
        ['t', roomTag(this.room)],
        ['expiration', String(now + CLAIM_TTL)],
      ],
      content: JSON.stringify(payload),
    })
    // A pad taken by the player next to you must go empty on their screen now,
    // not after a round trip — otherwise two people on one couch routinely both
    // take the same item, which is the one case where the deliberate
    // both-players-get-it tie is not a fair trade.
    this.mirror(event)
    void this.net.publish(event).then((outcome) => this.settleClaim(pickup, outcome))
  }

  /**
   * What to do when a claim did not make it.
   *
   * The claim is the one thing this game publishes exactly once, so it is the
   * one thing with nothing to self-heal it. `sweepPickups` marks the pad taken
   * *before* publishing — it has to, or grabbing an item would stall for a
   * round trip — which means a claim nobody accepted leaves this client alone in
   * believing that pad is gone.
   *
   * Rolled back only on a **unanimous refusal**: every relay that was asked
   * looked at the event and said no. Never on silence or a timeout, because the
   * event may well have landed and putting the pad back would be inventing a
   * divergence rather than repairing one. That distinction is the whole reason
   * `classifyFailure` exists.
   *
   * The buff is deliberately *not* taken back. Nobody outside this client ever
   * saw the grab, so nothing out there disagrees about it, and a game that
   * confiscates a shield for a network reason feels broken in a way the
   * alternative does not. What is restored is the pad — which makes this client
   * agree with the room again, and lets the grab be retried by driving over it.
   */
  /**
   * Total events any relay has accepted from this client, from `Net`'s ledger.
   *
   * The liveness control for the slow-clock signal. Read rather than counted
   * here because the tick stream deliberately does not wait on its own
   * publishes — a tick that lands nowhere is replaced by the next one a tenth
   * of a second later, and awaiting ten promises a second to learn that would
   * be bookkeeping for its own sake.
   */
  private get acceptedSoFar(): number {
    let n = 0
    for (const led of this.net.ledger.values()) n += led.accepted
    return n
  }

  /**
   * Update the slow-clock evidence from one claim's verdict.
   *
   * `outcome.malformed` is a count of relays, one verdict per target per
   * publish, so `>= 2` is two distinct relays without needing their URLs.
   */
  private noteClaimVerdict(outcome: PublishOutcome): void {
    const accepted = this.acceptedSoFar
    const ticksLanding = accepted > this.acceptedAtLastClaim
    this.acceptedAtLastClaim = accepted

    const expired =
      outcome.malformed >= 2 && /expired/i.test(outcome.reason ?? '') && ticksLanding
    if (expired) {
      this.expiredClaimStreak++
      this.lastExpiredReason = outcome.reason ?? ''
      return
    }
    // Anything else about this claim — accepted anywhere, refused on policy,
    // or malformed for some other reason — is not evidence of a slow clock.
    if (outcome.accepted > 0 || outcome.malformed === 0) this.expiredClaimStreak = 0
  }

  private settleClaim(pickup: Pickup, outcome: PublishOutcome): void {
    this.noteClaimVerdict(outcome)
    this.claimsReachingNobody = outcome.definitelyNowhere
    // `definitelyNowhere`, not `unanimouslyRefused`. The two questions came
    // apart: whether to give up on a relay is answered by policy refusals
    // alone, but whether the event exists anywhere has to count `invalid:` as
    // well — that one is rejected before storage, never forwarded, and bad at
    // every relay including the ones we never asked. A claim every relay calls
    // `invalid: event expired` is the one total publish failure anybody here has
    // actually observed, and it used to slip straight past this line.
    if (!outcome.definitelyNowhere) return
    // Spent before the pad is restored, and that ordering is the whole of it.
    // `sweepPickups` runs every frame and the tank is still standing on the pad
    // — putting it back without this re-grabs it, re-publishes, is refused
    // again, and loops at frame rate. The first version of this did exactly
    // that: nine refusals in a second and a half before the test caught it.
    this.spent.add(pickup.id)
    // Our own rollback is unconditional — `unclaim` deliberately refuses to
    // undo a grab the caller made themselves, and here the caller *is* the
    // grabber. That guard is for the mirrors.
    this.claimed.delete(pickup.id)
    this.minePads.delete(pickup.id)
    const live = this.pickups.get(pickup.id)
    if (live) live.taken = false
    // The claim was mirrored to the other local players before it was
    // published, so they already marked that pad taken. Undoing it here only
    // would leave player one agreeing with the room and player two not — and it
    // would not heal, because player two keeps the id in `claimed` and re-marks
    // the pad on every rebuild. The rollback travels the same way the claim did.
    for (const other of this.localMirror) other.unclaim(pickup.id)
    this.refusedClaims++
    this.pushFeed(`claim refused — ${PICKUPS[pickup.kind]?.label ?? 'that pad'} is back`)
  }

  /**
   * Forget that a pad was claimed. Safe to call on a client that never saw it.
   *
   * Skipped for a player who took the pad themselves: they have their own claim
   * out, and undoing their grab because somebody else's failed would be a second
   * divergence rather than the repair of the first.
   */
  unclaim(id: string): void {
    if (this.minePads.has(id)) return
    this.claimed.delete(id)
    const live = this.pickups.get(id)
    if (live) live.taken = false
  }

  private onClaim(e: Event): void {
    if (e.pubkey === this.identity.sessionPubkey) return
    const p = parsePayload<ClaimPayload>(e.content)
    if (!p || typeof p.p !== 'string' || p.p.length > 64) return
    // Recorded first, matched second. The pad this names may not exist here yet
    // — for a late joiner's backfill it never does — and dropping the claim
    // because the schedule has not caught up is exactly the silent divergence
    // stored claims were supposed to end.
    this.claimsReceived++
    this.claimed.add(p.p)
    if (this.claimed.size > 400) this.claimed.delete(this.claimed.values().next().value as string)

    const pickup = this.pickups.get(p.p)
    if (!pickup) {
      this.unmatchedClaims++
      return
    }
    if (pickup.taken) return
    pickup.taken = true
    const who = this.peers.get(e.pubkey)?.name ?? 'someone'
    this.pushFeed(`${who} took ${PICKUPS[pickup.kind]?.label ?? 'a pickup'}`)
  }

  /** True while the podium is up. */
  get intermission(): boolean {
    return performance.now() < this.intermissionUntil
  }

  scoreboard(): Standing[] {
    const rows: Standing[] = [
      {
        name: this.name,
        kills: this.kills,
        deaths: this.deaths,
        color: this.displayColor,
        you: true,
        pubkey: this.identity.pubkey,
      },
      ...[...this.peers.values()].map((p) => ({
        name: p.name,
        kills: p.kills,
        deaths: p.deaths,
        color: p.displayColor,
        you: false,
        pubkey: p.pubkey,
      })),
    ]
    return rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
  }

  dispose(): void {
    this.disposed = true
    this.net.close()
  }
}
