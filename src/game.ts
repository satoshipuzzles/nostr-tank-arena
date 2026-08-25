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
import { DEFAULT_SKIN, asSkin, type SkinId } from './skins'
import {
  KIND_CLAIM,
  KIND_DEATH,
  KIND_STRIKE,
  KIND_SESSION,
  KIND_SHELL,
  KIND_STATE,
  type DeathPayload,
  type SessionPayload,
  type ShellPayload,
  type StrikePayload,
  type StatePayload,
  parsePayload,
  roomTag,
} from './protocol'
import { BOT_COUNT, MAX_BOTS, killBot, makeBot, stepBot } from './bots'
import {
  WALLS,
  applyCoverBits,
  applyCoverDamageBits,
  coverBits,
  coverDamageBits,
  damageCover,
  explodes,
  resetCover,
} from './arena'
import {
  CHOPPER_DAMAGE,
  CHOPPER_HIT_MS,
  CHOPPER_MS,
  chopperAim,
  stepChopper,
  underFire,
} from './chopper'
import type { Rect } from './arena'
import type { Bot } from './bots'
import {
  LOB_BLAST,
  LOB_CHARGE_MS,
  LOB_MAX,
  LOB_MIN,
  MUZZLE_OFFSET,
  MAG_RELOAD,
  TANK_RADIUS,
  MAG_SIZE,
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
/**
 * The kill-streak ladder.
 *
 * Puzz asked for tiers at 5, 10, 15, 20 and 25. The repair at 3 stays under
 * them as the first rung, because a ladder whose bottom step is five kills is
 * a ladder almost nobody in a four-player room ever stands on — most rounds
 * are a block long and three in a row is already a good round.
 *
 * Everything except the air strike is *self-authoritative*: it changes only
 * our own HP and our own buffs, which this client is already allowed to
 * decide, so a reward needs no new trust, no new event kind and no agreement
 * with anybody. It rides out in the next state tick like any other HP change.
 * The air strike is the one that reaches across the arena, and that is exactly
 * why it is the one with a wire format.
 */
const STREAK_REPAIR = 3
/** Kills in a row that call an air strike. The marquee reward. */
const STREAK_STRIKE = 5
/** Rapid fire and a fresh hull. */
const STREAK_OVERDRIVE = 10
/** Siege shells: every shot takes two hull points instead of one. */
const STREAK_SIEGE = 15
/** Shield and speed together, which is the "come and try it" tier. */
const STREAK_JUGGERNAUT = 20
/** A second, longer air strike. Nothing beyond this changes; 25 is the top. */
const STREAK_CARPET = 25

/**
 * The ladder as a table, because two places have to agree about it.
 *
 * cloudfodder, mid-match: "how am I supposed to get to the choppa?" Every rung
 * above worked perfectly and nothing on the screen ever mentioned that they
 * existed, so a reward was a surprise the first time and invisible after that.
 * The HUD strip that fixes it has to name the same rungs `onOwnKill` awards,
 * and the way to guarantee that is to have one list rather than two — a
 * hand-written copy in the HUD is a promise that nobody will ever retune the
 * ladder, and this ladder has already been retuned twice.
 *
 * `name` is what the HUD shows while you are climbing toward it. `detail` is
 * the subtitle on the banner when you land on it, which stays longer because
 * there is a moment to read it.
 */
export interface StreakRung {
  at: number
  name: string
  detail: string
}

export const STREAK_LADDER: readonly StreakRung[] = [
  { at: STREAK_REPAIR, name: 'hull repair', detail: 'hull repaired' },
  { at: STREAK_STRIKE, name: 'air strike', detail: 'air strike inbound' },
  { at: STREAK_OVERDRIVE, name: 'chopper', detail: 'chopper — ten seconds of gun' },
  { at: STREAK_SIEGE, name: 'siege shells', detail: 'siege shells — two hull a hit' },
  { at: STREAK_JUGGERNAUT, name: 'juggernaut', detail: 'juggernaut — shielded and fast' },
  { at: STREAK_CARPET, name: 'carpet bombing', detail: 'carpet bombing' },
]

/** The rung a given streak is climbing toward, or null at the top of the ladder. */
export function nextRung(streak: number): StreakRung | null {
  return STREAK_LADDER.find((r) => r.at > streak) ?? null
}

/**
 * The rung below, so the meter fills across one step rather than across the
 * whole ladder. Nineteen kills is one away from juggernaut, and a bar that
 * reads 76% there is measuring the wrong thing.
 */
export function rungFloor(streak: number): number {
  let floor = 0
  for (const r of STREAK_LADDER) if (r.at <= streak) floor = r.at
  return floor
}

/** The banner subtitle for a rung, read from the same table the HUD reads. */
const detailAt = (at: number): string => STREAK_LADDER.find((r) => r.at === at)?.detail ?? ''

/**
 * How many sides there are.
 *
 * Five, because Puzz asked for "duos with 5 teams" — a full room of eight is
 * four duos, and five leaves a spare side for an odd number rather than forcing
 * somebody onto a team of three.
 */
const TEAMS = 5
/** How long the streak reward's rapid fire lasts. */
const STREAK_SIEGE_MS = 20_000
const STREAK_JUGGER_MS = 12_000

/**
 * Bombs in a five-kill strike, and in the twenty-five-kill one.
 *
 * Sized so the line is *continuous*. The first version dropped nine across a
 * 1728-unit run, which is one bomb every 216 units against a 64-unit blast
 * radius — so two thirds of the lane was safe ground and a tank standing still
 * in the middle of the strike usually took nothing at all. It looked
 * spectacular and did nothing, which is the worst thing a kill streak can be.
 * At fourteen the gaps close and standing in the lane is fatal, which is what
 * makes the warning stripe and the two seconds of siren mean something.
 */
const STRIKE_BOMBS = 14
const CARPET_BOMBS = 22
/** Seconds between one bomb and the next, and the hull each one takes off. */
const STRIKE_STEP_MS = 190
const STRIKE_DAMAGE = 2
/**
 * How close a bomb has to land.
 *
 * A tank is 22 units across and the board is 1600 wide, so 64 is "you were in
 * the lane" rather than "you were unlucky". Wide enough that standing in the
 * open on the wrong row is a decision with a consequence, tight enough that
 * driving out of the lane is a real answer — which is the whole reason the
 * bombs walk instead of landing all at once.
 */
const STRIKE_RADIUS = 64
/** How long after its last bomb a finished strike is kept around. */
const STRIKE_LINGER_MS = 1_500
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
  view: {
    x: number
    y: number
    hull: number
    gun: number
    hp: number
    dead: boolean
    /** Shells left in their magazine; 0 means empty or reloading. */
    ammo: number
    /** True while their ticks say a shield is up. See `StatePayload.sh`. */
    shield: boolean
    /**
     * When their chopper comes down, in our clock, or 0.
     *
     * A deadline here even though the wire carries a duration: the tick says
     * "eight more seconds" and every receiver turns that into its own `now`
     * plus eight, which needs no clock agreement between them. See
     * `StatePayload.c`.
     */
    chopperUntil: number
    /** Where their chopper's rounds are landing, or null. */
    chopperAt: { x: number; y: number } | null
    /** The team they say they are on, 1..5, or 0 for a free-for-all. */
    team: number
  }
  /** What we counted for them out of the death events we personally received. */
  kills: number
  deaths: number
  /**
   * What they say their score is, off their own state tick.
   *
   * This is the number the scoreboard shows, and `kills`/`deaths` above are the
   * fallback for a peer whose client is too old to send one. The locally
   * counted pair can only ever undercount — it is built from ephemeral death
   * events, so it is missing every death that happened before we joined and
   * every one that took a relay we were not reading. The peer's own count is
   * the only one that cannot be missing their kills.
   *
   * Null until their first tick, so "not heard from yet" and "genuinely 0/0"
   * stay distinguishable and the fallback is only used when it is really the
   * best we have.
   */
  claimed: { kills: number; deaths: number } | null
  /** Their kills in a row, from the state tick, so their glow is visible here too. */
  streak: number
  /** The finish they picked. Purely cosmetic; see `src/skins.ts`. */
  skin: SkinId
  /**
   * A local practice tank rather than somebody on a relay.
   *
   * Read by the renderer, which otherwise draws the `?` it puts on any peer
   * whose npub attestation has not landed. On a bot that mark is true and
   * useless: it says "this name is unverified" about a name this client made
   * up, and a player reads it as a stranger who has not signed in yet.
   */
  bot?: boolean
}

/** One air strike being re-simulated locally. See `StrikePayload`. */
interface Strike {
  id: string
  /** Session pubkey of whoever called it, so a kill is credited correctly. */
  owner: string
  /** Start of the run, already shifted into *our* clock. */
  t0: number
  y: number
  dir: 1 | -1
  n: number
  damage: number
  /**
   * Which bombs have already gone off here.
   *
   * Indices rather than a counter: a client that tabs out and comes back finds
   * six bombs due at once, and a counter would fire one and silently drop the
   * rest — the same "record first, match second" bug that used to throw away
   * kills from unknown peers, in a different costume.
   */
  fired: Set<number>
}

interface StateSample {
  t: number // already shifted into local time
  x: number
  y: number
  hull: number
  gun: number
  hp: number
  dead: boolean
  ammo: number
  shield: boolean
  /** Deadline in our clock, or 0. See `StatePayload.c`. */
  chopperUntil: number
  /** Ground point their rounds are landing on, or null. */
  chopperAt: { x: number; y: number } | null
  /** Declared team, 1..5, or 0. */
  team: number
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
  /** Declared side, 1..5, or 0 for a free-for-all. */
  team: number
}

export interface RoundResult {
  height: number
  layout: string
  /** The rules that round played under, banked before the next block changes them. */
  modifier: string
  standings: Standing[]
  /**
   * Longest streak of the round, banked here because `endRound` resets it.
   *
   * On the result rather than read off the game afterwards for exactly that
   * reason: anything that publishes this round has to run after the boundary,
   * by which time the live counter is already counting the next one.
   */
  bestStreak: number
  endedAt: number
}

/**
 * Hues nobody can confuse for each other, even as 40px tanks.
 *
 * Ten, for a room of eight plus headroom. The first six are unchanged and in
 * the same order, so a player who has been driving amber keeps driving amber —
 * `spreadColors` walks this list from the slot nearest a player's chosen hue
 * and takes the first free one, so appending rather than reordering is what
 * keeps colours stable across a deploy while two tanks are in the same room.
 *
 * The four new ones are chosen for distance from the six, not for prettiness:
 * a spring green between the amber and the lime, a violet, a rose, and a
 * teal. Every pair on this list is at least 25 degrees apart, which is the gap
 * at which two 40px tanks stop being the same colour on a phone.
 */
const PALETTE = [48, 190, 320, 100, 20, 265, 160, 295, 350, 225]

const randomId = () => {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('')
}

export class Game {
  readonly tank: LocalTank
  readonly peers = new Map<string, Peer>()
  readonly shells = new Map<string, Shell>()
  /**
   * Air strikes in progress, by event id. Re-simulated from the payload rather
   * than driven by per-bomb events, so a whole run costs one event.
   */
  readonly strikes = new Map<string, Strike>()
  /**
   * Blasts that went off since the renderer last looked.
   *
   * A queue rather than a flag, because two bombs can land inside one frame at
   * 190ms cadence on a machine dropping frames, and a flag would draw one
   * explosion for both. The renderer drains it.
   */
  readonly blasts: { x: number; y: number; mine: boolean }[] = []
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
    /** The finish this tank wears. Cosmetic only — see `src/skins.ts`. */
    public skin: SkinId = DEFAULT_SKIN,
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
      ammo: MAG_SIZE,
      reloadingFrom: 0,
      reloadingUntil: 0,
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
        kinds: [KIND_SESSION, KIND_STATE, KIND_SHELL, KIND_DEATH, KIND_STRIKE],
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
      sk: this.skin,
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
      case KIND_STRIKE:
        return this.onStrike(e)
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
    peer.skin = asSkin(p.sk)
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
        view: {
        x: ARENA_W / 2, y: ARENA_H / 2, hull: 0, gun: 0,
        hp: this.maxHp, dead: false,
        // Assume loaded until told otherwise: showing every peer as empty for
        // their first 100ms would flash a reload marker over every tank that
        // joins, and "empty" is the reading that changes how you play.
        ammo: MAG_SIZE,
        shield: false,
        chopperUntil: 0,
        chopperAt: null,
        team: 0,
      },
        kills: 0,
        deaths: 0,
        claimed: null,
        streak: 0,
        skin: DEFAULT_SKIN,
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
      // A client too old to send one is assumed loaded. Guessing "empty" for
      // an old client would put a reload marker over a tank that is about to
      // shoot you, which is worse than saying nothing.
      ammo: typeof p.a === 'number' ? Math.max(0, Math.min(MAG_SIZE, Math.floor(p.a))) : MAG_SIZE,
      // Absent means no shield, which is also what an old client sends — and
      // that is the safe way round. Guessing "shielded" for a client that
      // cannot say would paint a bubble on a tank that is not protected, and a
      // shot held back for a shield that was never there is a worse lie than a
      // shield that goes unadvertised.
      shield: p.sh === 1,
      // Clamped, and turned into a deadline in *our* clock. A hostile client
      // claiming an hour of gunship is claiming a tank nobody can shoot for an
      // hour, so the ceiling is the same window everybody else gets plus a
      // tick's worth of slack for the round trip.
      chopperUntil:
        typeof p.c === 'number' && p.c > 0
          ? performance.now() + Math.min(CHOPPER_MS + 400, p.c)
          : 0,
      // Clamped again on the way in, by the same function the shooter used.
      // A reach enforced only by whoever is flying is not enforced.
      chopperAt:
        typeof p.c === 'number' && p.c > 0 && typeof p.cx === 'number' && typeof p.cy === 'number'
          ? chopperAim(p.x, p.y, p.cx, p.cy)
          : null,
      // Clamped to the band a player can actually pick. A team index outside it
      // would put somebody on a side nothing draws and nobody can shoot.
      team:
        typeof p.tm === 'number' && p.tm >= 1 && p.tm <= TEAMS ? Math.floor(p.tm) : 0,
    }
    // Cosmetic and self-reported, exactly like the HP beside it. A streak you
    // cannot see on the tank that has it is a number in somebody else's HUD.
    peer.streak = typeof p.k === 'number' && p.k > 0 ? Math.min(99, Math.floor(p.k)) : 0
    // Their own tally, which beats ours. Ours is built from death events and
    // can only be short — theirs is the count kept by the one client that saw
    // every one of their kills. Recorded whenever the fields are present, so a
    // peer who genuinely has 0/0 says so rather than falling through to a
    // locally-counted zero that means "we have not been listening long enough".
    // A tally stamped with a round we are not playing is last round's, from a
    // peer who has not seen the new tip yet. Dropping it costs them a second of
    // showing 0/0; keeping it would show everybody a wrong number instead.
    const sameRound = (typeof p.r === 'number' ? p.r : 0) === this.round
    if (sameRound && typeof p.ks === 'number' && typeof p.ds === 'number') {
      peer.claimed = {
        kills: Math.max(0, Math.min(9999, Math.floor(p.ks))),
        deaths: Math.max(0, Math.min(9999, Math.floor(p.ds))),
      }
    }
    // Cover they have seen destroyed, unioned into ours. Gated on the round for
    // the same reason the tally is: barrels come back with every new block, and
    // a mask from the previous round would flatten the new board.
    //
    // Only from a peer in *our* round, and only additive — see `applyCoverBits`.
    // The visible effect of a mask carrying something we had not seen is a
    // barrel that vanishes with a puff rather than one that pops out of
    // existence, which is `takeCover` below.
    if (sameRound && typeof p.b === 'number' && p.b > 0) {
      for (const rect of applyCoverBits(p.b)) this.blewUp(rect, false)
    }
    // And the scuffs on what is still standing. Same round gate, same union,
    // no side effect beyond the paint — a tier cannot destroy anything, so
    // this one has nothing to announce.
    if (sameRound && typeof p.cd === 'number' && p.cd > 0) applyCoverDamageBits(p.cd)

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
    // A lob's range comes off the wire because nobody else can see how long the
    // key was held. Clamped, like the damage: the range decides where a crater
    // that hurts *us* appears, so a hostile event does not get to place one on
    // the far side of the map or at zero distance under our own tracks.
    const lob =
      typeof p.l === 'number' && p.l > 0 ? Math.min(LOB_MAX, Math.max(LOB_MIN, p.l)) : 0
    const shell = spawnShell(p.id, e.pubkey, p.x, p.y, p.a, bounces, damage, lob)
    this.sound('fire', { at: { x: p.x, y: p.y } })
    // Fast-forward by however long the event spent in flight, so the shell
    // appears where the shooter already sees it rather than at the muzzle.
    const lateMs = performance.now() - (p.t0 + peer.offset)
    stepShell(shell, Math.max(0, Math.min(1500, lateMs)) / 1000)
    // A lob that finished its flight inside the catch-up must still go off.
    // Dropping it because it arrived dead is how a shot that visibly landed on
    // you does nothing — the shell is gone, but the crater is the weapon.
    if (shell.landed) this.detonate(shell)
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
    } else if (typeof p.k === 'string' && p.k.length === 64) {
      // `ensurePeer`, not `peers.get`. A killer we have not had a tick from yet
      // is not an unknown player, it is a player whose first event happened to
      // be somebody else's death — guaranteed for a late joiner, and for anyone
      // whose first act after joining is a kill, because their tick and their
      // victim's death report race across relays with no ordering between them.
      // Looking them up and returning silently threw that kill away.
      this.ensurePeer(p.k).kills++
    }

    this.pushFeed(
      killerName ? `${killerName} killed ${victim.name}` : `${victim.name} self-destructed`,
    )
  }

  /**
   * The magazine clock: finish a reload that is running, or start one.
   *
   * Empty always reloads by itself. A player on a phone has no key to press and
   * a player who has not noticed the pips should never be left holding a dead
   * trigger wondering what broke — "the gun reloads when it runs out" is the
   * behaviour every shooter has trained people to expect. The manual reload is
   * for topping up *before* that, which is the interesting decision: spend two
   * and a half seconds in cover now, or gamble that two shells is enough.
   */
  private stepMagazine(now: number, asked: boolean): void {
    if (this.tank.reloadingUntil) {
      if (now >= this.tank.reloadingUntil) {
        this.tank.reloadingUntil = 0
        this.tank.ammo = MAG_SIZE
        // The next shot is available immediately: the reload *was* the wait.
        this.tank.reloadAt = 0
        this.sound('reload')
      }
      return
    }
    if (this.tank.ammo <= 0 || (asked && this.tank.ammo < MAG_SIZE)) {
      this.beginMagazineReload(now)
    }
  }

  private beginMagazineReload(now: number): void {
    if (this.tank.reloadingUntil) return
    // Rapid fire shortens the reload as well as the gap between shots. It would
    // be a strange buff that made you shoot twice as fast into the same dry
    // magazine and then stand still for the same two and a half seconds.
    const rapid = hasBuff(this.buffs, 'rapidUntil', now) ? 0.42 : 1
    this.tank.reloadingFrom = now
    this.tank.reloadingUntil = now + MAG_RELOAD * 1000 * rapid * this.modifier.reload
    this.tank.ammo = 0
    this.sound('dry')
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

    switch (this.streak) {
      case STREAK_REPAIR:
        this.tank.hp = this.maxHp
        this.repairedAt = now
        this.sound('streak')
        this.announce(`${STREAK_REPAIR} IN A ROW`, detailAt(STREAK_REPAIR), 130)
        return
      case STREAK_STRIKE:
        this.sound('streak')
        this.callStrike(now, STRIKE_BOMBS)
        this.announce(`${STREAK_STRIKE} IN A ROW`, detailAt(STREAK_STRIKE), 20)
        return
      case STREAK_OVERDRIVE:
        // Puzz asked for a chopper at ten, and a chopper is not a buff — it
        // takes the tank away and hands over a different vehicle. The rung used
        // to give Overdrive, which still exists as a pickup; what it does not
        // do any more is duplicate a pickup as a reward.
        this.sound('streak')
        this.boardChopper(now)
        this.announce(`${STREAK_OVERDRIVE} IN A ROW`, detailAt(STREAK_OVERDRIVE), 20)
        return
      case STREAK_SIEGE:
        this.sound('streak')
        this.buffs.siegeUntil = Math.max(this.buffs.siegeUntil, now) + STREAK_SIEGE_MS
        this.announce(`${STREAK_SIEGE} IN A ROW`, detailAt(STREAK_SIEGE), 300)
        return
      case STREAK_JUGGERNAUT:
        this.sound('streak')
        this.tank.hp = this.maxHp
        this.repairedAt = now
        this.buffs.shieldUntil = Math.max(this.buffs.shieldUntil, now) + STREAK_JUGGER_MS
        this.buffs.speedUntil = Math.max(this.buffs.speedUntil, now) + STREAK_JUGGER_MS
        this.announce(`${STREAK_JUGGERNAUT} IN A ROW`, detailAt(STREAK_JUGGERNAUT), 190)
        return
      case STREAK_CARPET:
        this.sound('streak')
        this.callStrike(now, CARPET_BOMBS)
        this.announce(`${STREAK_CARPET} IN A ROW`, detailAt(STREAK_CARPET), 0)
        return
    }
    if (this.streak > STREAK_CARPET) this.announce(`${this.streak} IN A ROW`, 'unstoppable', 45)
    else this.pushFeed(`${this.streak} in a row`)
  }

  /**
   * Call an air strike: a line of bombs walking across the board.
   *
   * The lane is chosen away from us — a reward that can kill the person who
   * earned it is not a reward, and "the bombs avoid the caller" is a rule a
   * player can see working rather than a hidden exemption. It is picked as the
   * row furthest from our own tank so the run still crosses the middle of the
   * arena, where everyone else is.
   *
   * One event for the whole run. Every client walks the same line from `t0`,
   * so twelve explosions cost one publish — worth stating because a strike is
   * already the loudest thing in the game and it should not also be the
   * heaviest thing on the relay.
   */
  private callStrike(now: number, bombs: number): void {
    const y = this.tank.y < ARENA_H / 2 ? ARENA_H * 0.72 : ARENA_H * 0.28
    const dir: 1 | -1 = this.tank.x < ARENA_W / 2 ? 1 : -1
    const payload: StrikePayload = { t0: now, y, dir, n: bombs, d: STRIKE_DAMAGE }
    const id = randomId()
    // Ours runs locally from the same numbers rather than waiting for the relay
    // to echo it back — otherwise the person who called it watches their own
    // strike arrive a round trip late, and on a bad relay not at all.
    this.strikes.set(id, {
      id,
      owner: this.identity.sessionPubkey,
      t0: now,
      y,
      dir,
      n: bombs,
      damage: STRIKE_DAMAGE,
      fired: new Set(),
    })
    this.publishAsSession(KIND_STRIKE, payload)
  }

  private onStrike(e: Event): void {
    const p = parsePayload<StrikePayload>(e.content)
    if (!p || typeof p.t0 !== 'number' || typeof p.y !== 'number') return
    if (this.strikes.has(e.id)) return
    const peer = this.ensurePeer(e.pubkey)
    peer.lastSeen = performance.now()
    this.updateOffset(peer, p.t0)
    this.strikes.set(e.id, {
      id: e.id,
      owner: e.pubkey,
      // Into our clock, like every other timestamp that crosses the wire.
      t0: p.t0 + peer.offset,
      y: Math.max(0, Math.min(ARENA_H, p.y)),
      dir: p.dir === -1 ? -1 : 1,
      n: Math.max(1, Math.min(40, Math.floor(p.n))),
      damage: Math.max(1, Math.min(MAX_HULL, Math.floor(p.d))),
      fired: new Set(),
    })
    this.sound('siren', { at: { x: ARENA_W / 2, y: p.y } })
    this.pushFeed(`${peer.name} called an air strike`)
  }

  /**
   * Walk every live strike forward and detonate whatever is due.
   *
   * Damage is applied the same way a shell's is — by the victim, to itself —
   * so a strike needs no more trust than the rest of the game already extends.
   * The caller is exempt.
   */
  private stepStrikes(now: number): void {
    for (const [id, strike] of this.strikes) {
      const span = ARENA_W + STRIKE_RADIUS * 2
      for (let i = 0; i < strike.n; i++) {
        if (strike.fired.has(i)) continue
        if (now < strike.t0 + i * STRIKE_STEP_MS) continue
        strike.fired.add(i)
        const t = strike.n > 1 ? i / (strike.n - 1) : 0.5
        const along = strike.dir === 1 ? t : 1 - t
        const x = -STRIKE_RADIUS + along * span
        const mine = strike.owner === this.identity.sessionPubkey
        this.blasts.push({ x, y: strike.y, mine })
        this.sound('blast', { at: { x, y: strike.y } })
        if (mine || this.watching || this.tank.dead) continue
        // A teammate's strike walks over us. The lane is picked away from the
        // caller already; on a team that exemption has to cover the side, or a
        // reward earned by one player is a punishment for their partner.
        if (this.friendly(strike.owner)) continue
        const dx = this.tank.x - x
        const dy = this.tank.y - strike.y
        if (dx * dx + dy * dy > STRIKE_RADIUS * STRIKE_RADIUS) continue
        if (hasBuff(this.buffs, 'shieldUntil', now)) {
          this.sound('shield')
          continue
        }
        this.tank.hp -= strike.damage
        this.sound('hit')
        if (this.tank.hp <= 0) this.die(strike.owner)
      }
      if (now > strike.t0 + strike.n * STRIKE_STEP_MS + STRIKE_LINGER_MS) this.strikes.delete(id)
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
   * When the current lob charge started, or 0 when the key is not down.
   *
   * Only the local player has one. A charge is not on the wire and never will
   * be: what other clients need is the range the shot went out at, which is one
   * number on the fire event, rather than a second stream of "still holding it"
   * ticks at 10Hz for as long as somebody leans on a key.
   */
  private lobFrom = 0

  /**
   * Local practice opponents. Empty whenever a real player is in the room.
   *
   * Held here rather than in `peers` because a bot needs a full `LocalTank` to
   * be stepped against, and a `Peer` only carries the interpolated `view` a
   * remote client publishes. `syncBots` writes one into the other every frame,
   * which is what makes the renderer, the scoreboard and the spawn search treat
   * a bot as an opponent with no code of their own.
   */
  private bots: Bot[] = []

  /**
   * How many practice tanks to fill an empty room with. Three by default.
   *
   * A solo player joining a string nobody else has typed is the overwhelmingly
   * common first run of this game, and an empty arena is not a game. Zero is
   * still one click away for anyone who wants the room they actually asked
   * for — and now so is seven, which is a very different practice session.
   *
   * A *want*, not a spawn count: `syncBots` decides what actually appears, and
   * bots only exist while no real player is in the room.
   */
  botsWanted = BOT_COUNT

  /**
   * The old on/off view of the same setting.
   *
   * Kept because half a dozen suites drive `botsEnabled = false` to get a
   * quiet arena, and because "off" is a real state a player asks for rather
   * than an implementation detail of a counter. Setting it back to `true`
   * restores the default rather than whatever was last picked, which is the
   * only sensible reading of "on" when the count it replaced is gone.
   */
  get botsEnabled(): boolean {
    return this.botsWanted > 0
  }

  set botsEnabled(on: boolean) {
    this.botsWanted = on ? BOT_COUNT : 0
  }

  /** Kills against bots. Deliberately not `kills` — see the note in bots.ts. */
  botKills = 0

  /**
   * The side this player has declared, 1..5, or 0 for a free-for-all.
   *
   * Puzz: "Team Death match Duos with 5 teams."
   *
   * Self-declared, always available, and it needs no agreement from anybody.
   * There is no host here to assign sides, and the two ways of deciding them
   * without one are both worse: deriving from the roster means two clients with
   * different relay visibility computing different sides for the same player,
   * and deriving from the pubkey takes away the choice, which is the half of
   * team play people actually want.
   *
   * So a room is in team mode when the people in it say it is. One player on a
   * side is still a deathmatch; two on the same side stop shooting each other.
   * Nothing is enforced and nothing has to be: see `friendly` for why claiming
   * somebody's side buys a truce rather than an advantage.
   */
  team = 0

  /**
   * Are we and the owner of this shell on the same side?
   *
   * Read by whoever is being shot, never by the shooter — which is what makes
   * a self-declared team safe. Think about what a liar gets: claiming somebody
   * else's side makes their shells pass through you, and *yours pass through
   * them*, because they are running this same check against your tick. A false
   * claim is a mutual truce, not immunity, and a mutual truce with somebody who
   * did not agree to it is a fight you cannot win rather than one you cannot
   * lose.
   *
   * Zero is nobody's side. Two players who have not picked a team are not
   * teammates, they are two people in a deathmatch, so a `0 === 0` shortcut
   * here would silently turn off friendly fire for the whole room the moment
   * anybody looked at this the wrong way.
   */
  private friendly(owner: string | null): boolean {
    if (!this.team || !owner) return false
    const peer = this.peers.get(owner)
    return !!peer && peer.view.team === this.team
  }

  /** How many sides a player can pick from. */
  static readonly TEAMS = TEAMS

  /**
   * The room's sides and what each has scored, or null in a free-for-all.
   *
   * Null rather than an empty array when nobody has picked, because "no teams"
   * and "teams with nothing in them" are different things and the HUD draws
   * them differently. One side with one player on it is also a free-for-all —
   * a team of one is a person.
   */
  teamStandings(): { team: number; kills: number; deaths: number; players: number }[] | null {
    const rows = this.scoreboard()
    const byTeam = new Map<number, { team: number; kills: number; deaths: number; players: number }>()
    for (const r of rows) {
      if (!r.team) continue
      const t = byTeam.get(r.team) ?? { team: r.team, kills: 0, deaths: 0, players: 0 }
      t.kills += r.kills
      t.deaths += r.deaths
      t.players++
      byTeam.set(r.team, t)
    }
    if (byTeam.size < 2) return null
    return [...byTeam.values()].sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.team - b.team)
  }

  /** Is this session key one of ours rather than a person on a relay? */
  isBot(session: string | null): boolean {
    return typeof session === 'string' && session.startsWith('b0') && session.endsWith('0'.repeat(8))
  }

  /** How many bots are in the arena right now. Read by the HUD and the tests. */
  get botCount(): number {
    return this.bots.length
  }

  /**
   * Spawn, step and retire the practice opponents.
   *
   * The retire branch is the load-bearing one. Bots are local: nobody else can
   * see them, so the instant a real player's tick arrives the two clients are
   * looking at different arenas, and the only honest fix is for the bots to
   * leave. Checked against peers that are *not* bots, because the bots are
   * themselves in `peers` by the time this runs a second time.
   */
  private syncBots(dt: number, now: number): void {
    const humans = [...this.peers.keys()].filter((k) => !this.isBot(k))
    const asked = Math.max(0, Math.min(MAX_BOTS, Math.floor(this.botsWanted)))
    const wanted = humans.length === 0 && !this.watching ? asked : 0

    if (this.bots.length > wanted) {
      // Retire from the end rather than clearing the lot. Dropping one bot used
      // to delete all three and respawn two, which reads as the arena blinking
      // — and it threw away the state of tanks the player was mid-fight with.
      const going = this.bots.splice(wanted)
      for (const bot of going) this.peers.delete(bot.session)
      if (wanted === 0 && humans.length > 0) this.pushFeed('a real player joined — bots stood down')
    }
    while (this.bots.length < wanted) this.bots.push(makeBot(this.bots.length, now))
    if (!this.bots.length) return

    // Velocity for the lead, measured rather than read off the controls: what a
    // bot has to solve for is where the tank will *be*, and throttle is not that
    // once a wall is involved.
    const target = this.watching
      ? null
      : {
          x: this.tank.x,
          y: this.tank.y,
          vx: dt > 0 ? (this.tank.x - this.lastTankAt.x) / dt : 0,
          vy: dt > 0 ? (this.tank.y - this.lastTankAt.y) / dt : 0,
          dead: this.tank.dead,
        }
    this.lastTankAt = { x: this.tank.x, y: this.tank.y }

    for (const bot of this.bots) {
      const action = stepBot(bot, target, dt, now, this.maxHp, this.modifier.reload)
      if (action.fire !== null) this.fireBot(bot, action.fire)

      // Straight into the peer record the renderer reads. No interpolation and
      // no buffer: a bot is stepped in this frame, on this machine, so the
      // freshest sample is also the correct one — the interpolation delay exists
      // to smooth a network, and there is no network here.
      const peer = this.ensurePeer(bot.session)
      peer.name = bot.name
      peer.color = bot.color
      peer.bot = true
      peer.lastSeen = now
      peer.claimed = { kills: bot.kills, deaths: bot.deaths }
      peer.view.x = bot.tank.x
      peer.view.y = bot.tank.y
      peer.view.hull = bot.tank.hull
      peer.view.gun = bot.tank.gun
      peer.view.hp = bot.tank.hp
      peer.view.dead = bot.tank.dead
      peer.view.ammo = MAG_SIZE
      peer.view.shield = false
      peer.view.chopperUntil = 0
      peer.view.chopperAt = null
      // Bots take the side of whoever they are practising against, so a player
      // on a team is not suddenly fighting three tanks that are all on it too.
      peer.view.team = 0
    }
  }

  private lastTankAt = { x: 0, y: 0 }

  /** A bot pulls its trigger. Same shell everybody else fires, different owner. */
  private fireBot(bot: Bot, angle: number): void {
    const x = bot.tank.x + Math.cos(angle) * MUZZLE_OFFSET
    const y = bot.tank.y + Math.sin(angle) * MUZZLE_OFFSET
    const shell = spawnShell(randomId(), bot.session, x, y, angle, this.modifier.bounces, 1, 0)
    this.shells.set(shell.id, shell)
    this.sound('fire', { at: { x, y } })
  }

  /**
   * A shell went into a piece of cover. Take a hit out of it if it is a barrel.
   *
   * Applied by **every** client that simulates the shell, not just the shooter,
   * and that is the design rather than an accident. Every client receives the
   * same fire event and re-simulates the same trajectory through the same
   * layout, so they all reach the same rect at the same sub-step and all call
   * this — which means the hit count converges without anybody publishing
   * anything about it. `damageCover` is idempotent past zero so the extra calls
   * are worth nothing.
   *
   * What is *not* guaranteed to converge is a shell one client deleted early —
   * a hit on an interpolated tank happens a few pixels apart on different
   * screens, so a barrel directly behind somebody can take a hit on one client
   * and not on another. That is what the bitmask on the state tick is for: the
   * destroyed set is unioned across everybody, so the first client to see a
   * barrel go takes it out for the whole room within 100ms. Hit *counts* can
   * drift; the outcome cannot.
   */
  private hitCover(shell: Shell): void {
    const rect = WALLS[shell.struck]
    if (!rect || rect.hp === undefined || rect.gone) return
    const boom = explodes(rect)
    const destroyed = damageCover(shell.struck, shell.damage)
    if (!destroyed) {
      this.sound('hit', { at: { x: shell.x, y: shell.y } })
      return
    }
    // The shell is spent in the cover rather than bouncing off a rect that no
    // longer exists. Without this it carries on through the hole it just made,
    // which reads as the thing never having been there.
    shell.dead = true
    this.blewUp(rect, true, boom)
    // A barrel is an explosion; a crate is a crate. Splitting them is the
    // tactical difference between the two: you shoot a barrel because somebody
    // is standing next to it, and you shoot a crate because you want the lane
    // behind it. A crate that killed people would make eight shells the best
    // weapon in the game rather than the slowest.
    if (boom) {
      this.blast(rect.x + rect.w / 2, rect.y + rect.h / 2, shell.owner)
    }
  }

  /**
   * A barrel is gone. Tell the renderer and the player.
   *
   * `mine` separates "a shell I simulated took it out" from "somebody else's
   * tick said it was already gone". Both remove the barrel; only the first is
   * worth a bang, because the second is a correction arriving up to a tick
   * late and a delayed explosion under a tank that has already driven through
   * the gap reads as a bug.
   */
  private blewUp(rect: Rect, mine: boolean, boom = explodes(rect)): void {
    this.coverBlasts.push({
      x: rect.x + rect.w / 2,
      y: rect.y + rect.h / 2,
      at: performance.now(),
      loud: mine,
      // Fire and smoke, or splinters. A crate coming apart in a fireball would
      // say "stand back" about a thing that is safe to stand next to.
      fire: boom,
    })
    if (this.coverBlasts.length > 12) this.coverBlasts.shift()
    if (mine) {
      this.sound(boom ? 'blast' : 'hit', { at: { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 } })
    }
  }

  /**
   * Barrels that have gone up recently, for the renderer to draw once.
   *
   * A list rather than a callback because the renderer is a pure function of
   * game state plus its own particle pool, and everything else it draws works
   * this way. Entries are read by timestamp and expire on their own.
   */
  readonly coverBlasts: { x: number; y: number; at: number; loud: boolean; fire: boolean }[] = []

  /**
   * Everything a barrel takes with it.
   *
   * Same radius and the same authority split as a lob: our own hull is the only
   * one we decide, remote tanks decide their own, and the bots are ours because
   * they exist nowhere else. Friendly fire included — a barrel does not know
   * who shot it, and a player who blows one up at point-blank range should find
   * that out.
   */
  private blast(x: number, y: number, owner: string): void {
    const r = LOB_BLAST + TANK_RADIUS
    for (const bot of this.bots) {
      if (bot.tank.dead) continue
      if ((bot.tank.x - x) ** 2 + (bot.tank.y - y) ** 2 > r * r) continue
      bot.tank.hp -= 1
      if (bot.tank.hp > 0) continue
      killBot(bot, performance.now(), this.modifier.respawn)
      this.sound('death', { at: { x: bot.tank.x, y: bot.tank.y } })
      if (owner === this.identity.sessionPubkey) {
        this.botKills++
        this.onOwnKill()
        this.pushFeed(`you killed ${bot.name}`)
      }
    }
    if (this.tank.dead || this.watching) return
    // A barrel a teammate shot still does not hurt us, which is the same rule
    // as their shell — and it means a team can use the barrels as a weapon
    // without having to check who is standing where first.
    if (this.friendly(owner)) return
    if ((this.tank.x - x) ** 2 + (this.tank.y - y) ** 2 > r * r) return
    if (hasBuff(this.buffs, 'shieldUntil', performance.now())) {
      this.buffs.shieldUntil = 0
      this.sound('shield')
      this.announce('SHIELD BROKE', 'that one was free', 200)
      return
    }
    this.tank.hp -= 1
    if (this.tank.hp > 0) this.sound('hit')
    // Credited to whoever shot the barrel, including ourselves — a player who
    // stands next to a barrel they are shooting has self-destructed, and the
    // feed should say so rather than blaming the last person who hit them.
    if (this.tank.hp <= 0) this.die(owner === this.identity.sessionPubkey ? null : owner)
  }

  // ------------------------------------------------------------------ chopper

  /**
   * When our chopper comes down, or 0 when we are in the tank.
   *
   * The tank is *out of play* for the whole window: it cannot be shot, it does
   * not collide, and it is not drawn. That is deliberate. The reward is being
   * dangerous and untouchable for ten seconds, and the cost is that your tank is
   * holding no ground while you enjoy it — you respawn on the way down.
   */
  chopperUntil = 0
  /** Where the chopper is. Not the tank's position; the tank is parked. */
  readonly chopper = { x: 0, y: 0 }
  /** Where its rounds are landing this frame, or null when it is not firing. */
  chopperAt: { x: number; y: number } | null = null
  /** When each victim may next be hit, keyed by chopper owner then victim. */
  private chopperHitAt = new Map<string, number>()

  /** Are we flying? Read by the renderer, the HUD and the input router. */
  get flying(): boolean {
    return this.chopperUntil > performance.now()
  }

  /** Seconds of gunship left, for the HUD. 0 when not flying. */
  get chopperLeft(): number {
    return Math.max(0, (this.chopperUntil - performance.now()) / 1000)
  }

  /**
   * Get in. Called from the streak ladder, and from nowhere else.
   *
   * Starts over our own tank rather than at a map edge: the ten seconds are the
   * reward, and spending two of them flying in from a corner is two seconds of
   * the reward spent on travel.
   */
  private boardChopper(now: number): void {
    this.chopperUntil = now + CHOPPER_MS
    this.chopper.x = this.tank.x
    this.chopper.y = this.tank.y
    this.chopperAt = null
    // Out of play. Not `dead` — dead books a respawn and puts a wreck on the
    // board, and neither is what is happening. `landChopper` respawns properly.
    this.tank.dead = false
    this.pushFeed('chopper — ten seconds of gun')
  }

  /**
   * Fly, shoot, and get out when the clock runs down.
   *
   * The aim point is clamped by `chopperAim` on the way in, and clamped again
   * by every client that reads it off the tick — a reach enforced only by the
   * shooter is a reach a modified client does not have.
   */
  private stepOwnChopper(dt: number, now: number, controls: Controls): void {
    if (now >= this.chopperUntil) {
      this.landChopper()
      return
    }
    stepChopper(this.chopper, controls.throttle, controls.steer, dt)
    if (controls.fire && controls.aimAt) {
      this.chopperAt = chopperAim(
        this.chopper.x,
        this.chopper.y,
        controls.aimAt.x,
        controls.aimAt.y,
      )
      this.rakeBots(now)
    } else {
      this.chopperAt = null
    }
  }

  /**
   * Put the tank back on the board.
   *
   * A respawn rather than a return to where it was parked. Ten seconds is long
   * enough that the ground under the old spot belongs to somebody else now, and
   * `respawn` already knows how to find the corner nobody is looking at.
   */
  private landChopper(): void {
    if (!this.chopperUntil) return
    this.chopperUntil = 0
    this.chopperAt = null
    this.respawn()
    this.pushFeed('back in the tank')
  }

  /** Bots under our own chopper. They are ours, so we apply it. */
  private rakeBots(now: number): void {
    if (!this.chopperAt) return
    for (const bot of this.bots) {
      if (bot.tank.dead) continue
      if (!underFire(this.chopperAt.x, this.chopperAt.y, bot.tank.x, bot.tank.y)) continue
      const key = 'self:' + bot.session
      if (now < (this.chopperHitAt.get(key) ?? 0)) continue
      this.chopperHitAt.set(key, now + CHOPPER_HIT_MS)
      bot.tank.hp -= CHOPPER_DAMAGE
      if (bot.tank.hp > 0) {
        this.sound('hit', { at: { x: bot.tank.x, y: bot.tank.y } })
        continue
      }
      killBot(bot, now, this.modifier.respawn)
      this.botKills++
      this.sound('kill')
      this.onOwnKill()
      this.pushFeed(`you killed ${bot.name}`)
    }
  }

  /**
   * Are we standing in somebody else's chopper fire?
   *
   * Asked rather than told, which is the same rule as a shell: our own hull is
   * the one number this client decides. Nobody sends "I hit you"; every client
   * reads the choppers it can see off the tick stream and works out for itself
   * whether it is underneath one.
   *
   * Per-chopper cooldown, keyed by owner, so two gunships up at once are twice
   * as dangerous rather than one being ignored — and so a single one cannot be
   * made to hit faster by publishing its tick more often.
   */
  private takeChopperFire(now: number): void {
    if (this.tank.dead || this.watching || this.flying) return
    for (const peer of this.peers.values()) {
      const at = peer.view.chopperAt
      if (!at || peer.view.chopperUntil <= now) continue
      if (this.team && peer.view.team === this.team) continue
      if (!underFire(at.x, at.y, this.tank.x, this.tank.y)) continue
      if (now < (this.chopperHitAt.get(peer.session) ?? 0)) continue
      this.chopperHitAt.set(peer.session, now + CHOPPER_HIT_MS)
      if (hasBuff(this.buffs, 'shieldUntil', now)) {
        this.buffs.shieldUntil = 0
        this.sound('shield')
        this.announce('SHIELD BROKE', 'that one was free', 200)
        continue
      }
      this.tank.hp -= CHOPPER_DAMAGE
      if (this.tank.hp > 0) this.sound('hit')
      if (this.tank.hp <= 0) {
        this.die(peer.session)
        return
      }
    }
  }

  /** Everything in the crater that is a bot. Same rules as `hitBot`. */
  private blastBots(shell: Shell): void {
    const r = LOB_BLAST + TANK_RADIUS
    for (const bot of this.bots) {
      if (bot.tank.dead) continue
      if ((bot.tank.x - shell.x) ** 2 + (bot.tank.y - shell.y) ** 2 > r * r) continue
      bot.tank.hp -= shell.damage
      if (bot.tank.hp > 0) continue
      killBot(bot, performance.now(), this.modifier.respawn)
      this.sound('death', { at: { x: bot.tank.x, y: bot.tank.y } })
      if (shell.owner === this.identity.sessionPubkey) {
        this.botKills++
        this.sound('kill')
        this.onOwnKill()
        this.pushFeed(`you killed ${bot.name}`)
      }
    }
  }

  /**
   * A shell of ours hitting a bot.
   *
   * We are the authority on a bot in a way we are never the authority on a
   * person: it exists only here. So this applies the damage rather than merely
   * removing the shell, which is what `collide` does for a remote tank.
   *
   * The kill does not touch `kills`. Free kills are available in unlimited
   * quantity to anyone willing to sit in an empty room, and a leaderboard that
   * counted them would be ranking patience. It does feed the streak, because
   * practising a streak is most of what a bot room is for, and it does go in
   * the feed so the player can see it happened.
   */
  private hitBot(shell: Shell): boolean {
    if (this.isBot(shell.owner)) return false
    for (const bot of this.bots) {
      if (bot.tank.dead) continue
      if (!shellHits(shell, bot.tank.x, bot.tank.y)) continue
      this.shells.delete(shell.id)
      bot.tank.hp -= shell.damage
      if (bot.tank.hp > 0) {
        this.sound('hit', { at: { x: bot.tank.x, y: bot.tank.y } })
        return true
      }
      killBot(bot, performance.now(), this.modifier.respawn)
      this.sound('death', { at: { x: bot.tank.x, y: bot.tank.y } })
      if (shell.owner === this.identity.sessionPubkey) {
        this.botKills++
        this.sound('kill')
        this.onOwnKill()
        this.pushFeed(`you killed ${bot.name}`)
      }
      return true
    }
    return false
  }

  /**
   * Where a charging lob would land right now, for the aiming ring, or null.
   *
   * Read by the renderer every frame. This is the honest half of the weapon:
   * the shooter sees exactly where the crater goes, and so does everybody who
   * can see the tank, because the ring is drawn from the same numbers on every
   * client once the shell is in the air.
   */
  get lobAim(): { x: number; y: number; r: number; charge: number } | null {
    if (!this.lobFrom || this.tank.dead) return null
    const charge = this.lobCharge(performance.now())
    const range = LOB_MIN + (LOB_MAX - LOB_MIN) * charge
    return {
      x: this.tank.x + Math.cos(this.tank.gun) * range,
      y: this.tank.y + Math.sin(this.tank.gun) * range,
      r: LOB_BLAST,
      charge,
    }
  }

  /** 0..1, how far the held key has wound the range up. */
  private lobCharge(now: number): number {
    if (!this.lobFrom) return 0
    return Math.max(0, Math.min(1, (now - this.lobFrom) / LOB_CHARGE_MS))
  }

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

  /**
   * A line in the kill feed.
   *
   * Public because the shell has things to say that `Game` has no business
   * knowing about — "auto-publish is on, your signer will ask once a block" is
   * a fact about a browser extension, not about a tank. The feed is the only
   * place in this UI for a sentence that does not deserve a banner.
   */
  pushFeed(text: string): void {
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
    } else if (this.chopperUntil) {
      // Flying. The tank is out of play — not stepped, not collided with, not
      // drawn — so none of the branch below applies and none of it should run.
      this.stepOwnChopper(dt, now, controls)
    } else if (this.tank.dead) {
      if (now >= this.tank.respawnAt) this.respawn()
    } else {
      const boost = (hasBuff(this.buffs, 'speedUntil', now) ? 1.45 : 1) * this.modifier.speed
      stepTank(this.tank, controls.throttle, controls.steer, controls.aim, dt, boost)
      this.stepMagazine(now, controls.reload)
      const armed = this.tank.ammo > 0 && !this.tank.reloadingUntil && now >= this.tank.reloadAt
      // The lob is checked before the trigger and takes precedence, so holding
      // Q with a finger still on the mouse charges rather than machine-gunning
      // flat shells past the wall you were trying to go over.
      if (controls.lob) {
        // Only start winding up when there is actually a shell to throw.
        // Charging a lob you cannot fire, and then having it not go off on
        // release, is the kind of thing a player reads as the key not working.
        if (!this.lobFrom && armed) this.lobFrom = now
      } else if (this.lobFrom) {
        const charge = this.lobCharge(now)
        this.lobFrom = 0
        if (armed) this.fire(now, LOB_MIN + (LOB_MAX - LOB_MIN) * charge)
      } else if (controls.fire && armed) {
        this.fire(now)
      }
      this.sweepPickups(now)
    }
    this.syncBots(dt, now)
    // Everybody else's gunships, before the shells: a hull that is about to be
    // taken to zero by a chopper should not also eat a shell in the same frame
    // and report two deaths.
    this.takeChopperFire(now)
    this.refreshPickups()

    for (const shell of this.shells.values()) {
      shell.struck = -1
      stepShell(shell, dt)
      // Cover first, because a shell that has just taken the last hit out of a
      // barrel should go off *there* rather than carrying on through the gap it
      // made. `struck` is set by the sim on the bounce as well as on the death,
      // so the first two hits count even though the shell survives them.
      if (shell.struck >= 0) this.hitCover(shell)
      if (shell.dead) {
        this.shells.delete(shell.id)
        if (shell.landed) this.detonate(shell)
        continue
      }
      this.collide(shell)
    }

    this.stepStrikes(now)
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

  /**
   * A lob has arrived. Everything inside the blast takes the hit.
   *
   * Only our own tank's HP is authoritative here, exactly as with a flat shell
   * — we work out whether *we* were caught and let the state tick carry the
   * result. The landing point is a pure function of the fire event, so every
   * client runs this with the same crater in the same place, and two players
   * standing together both take it.
   */
  private detonate(shell: Shell): void {
    this.sound('blast', { at: { x: shell.x, y: shell.y } })
    // Bots are inside the blast like anybody else. Separately from the branch
    // below, not instead of it: a lob is an area weapon, so one crater can take
    // a bot and the player who threw it standing too close, and an early return
    // after the first casualty would drop the rest.
    this.blastBots(shell)
    if (shell.owner === this.identity.sessionPubkey || this.tank.dead || this.watching) return
    if (this.friendly(shell.owner)) return
    const r = LOB_BLAST + TANK_RADIUS
    if ((this.tank.x - shell.x) ** 2 + (this.tank.y - shell.y) ** 2 > r * r) return
    if (hasBuff(this.buffs, 'shieldUntil', performance.now())) {
      this.buffs.shieldUntil = 0
      this.sound('shield')
      this.announce('SHIELD BROKE', 'that one was free', 200)
      return
    }
    this.tank.hp -= shell.damage
    if (this.tank.hp > 0) this.sound('hit')
    if (this.tank.hp <= 0) this.die(shell.owner)
  }

  private collide(shell: Shell): void {
    // A lob is over everybody's head for its whole flight. It hits nothing on
    // the way; `detonate` is the only thing it ever does.
    if (shell.lob > 0) return
    // Only our own tank's HP is authoritative, so that is the only hit that
    // changes game state. Hits on remote tanks just remove the shell locally
    // so it does not sail visually through someone.
    if (
      shell.owner !== this.identity.sessionPubkey &&
      !this.tank.dead &&
      shellHits(shell, this.tank.x, this.tank.y)
    ) {
      this.shells.delete(shell.id)
      // A teammate's shell stops here rather than passing through, so it does
      // not sail on and kill somebody behind us. Removed and forgotten: the
      // shot was still fired, it just did not land on a friend.
      if (this.friendly(shell.owner)) return
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

    // Bots first. A bot's peer record is in the loop below, and that branch only
    // deletes the shell — correct for a remote player, who decides their own
    // hull, and wrong for a bot, which has no client of its own to decide
    // anything. Reaching the loop first would swallow every shot fired at one.
    if (this.hitBot(shell)) return

    for (const peer of this.peers.values()) {
      if (peer.session === shell.owner || peer.view.dead) continue
      if (this.isBot(peer.session)) continue
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
  private fire(now: number, lob = 0): void {
    const rapid = hasBuff(this.buffs, 'rapidUntil', now) ? 0.42 : 1
    this.tank.reloadAt = now + RELOAD * 1000 * rapid * this.modifier.reload
    // One shell per pull, even when Scattershot turns it into three. Charging
    // three would leave a scattergun with one and a bit shots in the magazine,
    // which is not a pickup, it is a punishment.
    this.tank.ammo--
    if (this.tank.ammo <= 0) this.beginMagazineReload(now)
    const bounces = this.modifier.bounces
    const damage = hasBuff(this.buffs, 'siegeUntil', now) ? 2 : 1
    // Scattershot fans flat shells, not lobs. Three craters from one key press
    // is not a pickup, it is artillery, and the lob already ignores the cover
    // that makes Scattershot a close-range weapon.
    const spread =
      !lob && hasBuff(this.buffs, 'scatterUntil', now) ? [-SCATTER_SPREAD, 0, SCATTER_SPREAD] : [0]
    for (const offset of spread) {
      const angle = this.tank.gun + offset
      const x = this.tank.x + Math.cos(angle) * MUZZLE_OFFSET
      const y = this.tank.y + Math.sin(angle) * MUZZLE_OFFSET
      const shell = spawnShell(
        randomId(), this.identity.sessionPubkey, x, y, angle, bounces, damage, lob,
      )
      this.shells.set(shell.id, shell)
      // Bounce budget and damage go out with the shell rather than being looked
      // up on arrival: one so a shell outlives a block boundary under the rules
      // it was fired under, the other because the victim applies the damage and
      // cannot see the shooter's buffs.
      const payload: ShellPayload = { id: shell.id, t0: now, x, y, a: angle, b: bounces, d: damage }
      if (lob) payload.l = Math.round(lob)
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
    // A bot killing you costs you the round and the streak, which is the part
    // that makes practice mean anything — but it does not go on the wire and it
    // does not go in `deaths`. The symmetry with `hitBot` is the point: bot
    // kills do not inflate your score, so bot deaths must not deflate it, or
    // sitting in an empty room becomes a way to farm a K/D in the other
    // direction.
    const fromBot = this.isBot(killer)
    if (!fromBot) {
      this.deaths++
      const payload: DeathPayload = {
        t: performance.now(),
        k: killer,
        x: this.tank.x,
        y: this.tank.y,
      }
      this.publishAsSession(KIND_DEATH, payload)
    }
    this.sound('death')
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
    // Full magazine and no reload in progress. Respawning into the two seconds
    // that were left on a reload you died during is a punishment for dying that
    // the respawn delay has already handed out.
    this.tank.ammo = MAG_SIZE
    this.tank.reloadingUntil = 0
    this.tank.reloadAt = 0
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
        peer.view.ammo = newest.ammo
        peer.view.shield = newest.shield
        peer.view.chopperUntil = newest.chopperUntil
        peer.view.chopperAt = newest.chopperAt
        peer.view.team = newest.team
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
      // Taken from the newer of the two samples, like HP: a magazine count is a
      // step, not a slope, and half a shell is not a thing to draw.
      peer.view.ammo = bb.ammo
      peer.view.shield = bb.shield
      // The newer sample, like HP and ammo. A gunship is up or it is not, and
      // half a chopper is not a thing to draw or to be shot by. The *aim point*
      // is deliberately not interpolated either: it is where rounds are landing
      // right now, and a blend between two of them is a place nobody was
      // shooting at.
      peer.view.chopperUntil = bb.chopperUntil
      peer.view.chopperAt = bb.chopperAt
      // The newer sample. A side is a step, not a slope.
      peer.view.team = bb.team
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
      // The chopper's position while it is up, not the tank's. The tank is out
      // of play for those ten seconds and drawing it where it was parked would
      // put a target on the board that cannot be hit.
      x: Math.round((this.flying ? this.chopper.x : this.tank.x) * 10) / 10,
      y: Math.round((this.flying ? this.chopper.y : this.tank.y) * 10) / 10,
      h: Math.round(this.tank.hull * 1000) / 1000,
      g: Math.round(this.tank.gun * 1000) / 1000,
      hp: this.tank.hp,
      d: this.tank.dead,
      ...(this.streak > 0 ? { k: this.streak } : {}),
      // Always sent, including at 0/0. An omitted score is indistinguishable
      // from a client that has not scored yet, and the whole point of putting
      // the tally on the tick is that a late joiner can tell those apart.
      ks: this.kills,
      ds: this.deaths,
      r: this.round,
      // Ammo goes on the wire because being caught empty is only a real cost if
      // the other tank can *see* it. A reload you can hide is just a private
      // pause; a reload everyone can read is the window that makes cover and
      // positioning matter. Self-reported, like the HP beside it.
      a: this.tank.reloadingUntil ? 0 : this.tank.ammo,
      // Only when it is up, so the common case costs nothing on a tick that
      // goes out ten times a second.
      ...(hasBuff(this.buffs, 'shieldUntil', now) ? { sh: 1 as const } : {}),
      // Same reasoning: omitted while the board is intact, which is most of a
      // round. Unioned by whoever receives it, so a tick lost on the way costs
      // nothing and a late joiner is caught up by the next one.
      ...(coverBits() ? { b: coverBits() } : {}),
      // The scuffs, on the same terms as the holes: omitted while the board is
      // untouched, unioned by whoever receives it, and worth sending because a
      // crate that has taken six hits looks different to the player who put
      // them in and to everybody else only if it travels.
      ...(coverDamageBits() ? { cd: coverDamageBits() } : {}),
      // Absent in a free-for-all, which is most rounds, so the common tick is
      // the size it was before teams existed.
      ...(this.team ? { tm: this.team } : {}),
      // The whole gunship, on a tick that was going out anyway. A duration, so
      // a receiver adds it to its own clock and nobody has to agree on a
      // deadline. Absent for every tick of a round nobody earned one in.
      ...(this.flying
        ? {
            c: Math.round(this.chopperUntil - now),
            ...(this.chopperAt
              ? { cx: Math.round(this.chopperAt.x), cy: Math.round(this.chopperAt.y) }
              : {}),
          }
        : {}),
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
    // Every barrel back. Not left to `setLayout`, which returns early when the
    // new block lands on the same map — about one round in eight, since the map
    // is `blockHash % 8`. See `resetCover`.
    resetCover()
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
      bestStreak: this.bestStreak,
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
    // A strike called under the old block does not keep bombing the new one.
    this.strikes.clear()
    // Nor does a gunship. Ten seconds is a rung on a streak, and the streak is
    // reset three lines above this — carrying the reward across the boundary
    // would be a tank nobody can shoot on a board it did not earn.
    if (this.chopperUntil) this.landChopper()
    this.chopperHitAt.clear()
    this.blasts.length = 0
    // Peer tallies are ours to keep, not theirs to send, so they reset here too.
    for (const peer of this.peers.values()) {
      peer.kills = 0
      peer.deaths = 0
      // Back to "not heard from this round", not to a claimed zero. Their next
      // tick carries the new round's tally and re-fills this within 100ms.
      peer.claimed = null
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
        team: this.team,
      },
      // A peer's own count beats ours. See `Peer.claimed`: ours is assembled
      // from ephemeral death events and is short by everything that happened
      // before we joined, so preferring it is how four clients end up showing
      // four different scoreboards for the same round.
      ...[...this.peers.values()].map((p) => ({
        name: p.name,
        kills: p.claimed?.kills ?? p.kills,
        deaths: p.claimed?.deaths ?? p.deaths,
        color: p.displayColor,
        you: false,
        pubkey: p.pubkey,
        team: p.view.team,
      })),
    ]
    return rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
  }

  dispose(): void {
    this.disposed = true
    this.net.close()
  }
}
