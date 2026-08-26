// Wire protocol for Nostr Tank Arena.
//
// Everything the game needs travels as Nostr events. There is no game server.
// High-frequency data uses ephemeral kinds (20000-29999) which relays forward
// but never store — exactly right for tick data. The only thing that persists
// is a player's signed score record.
//
// Every event carries ["t", roomTag(room)] so a client can subscribe to one
// arena with a single `#t` filter.

export const KIND_SESSION = 21003 // ephemeral: binds a session key to a real npub
export const KIND_STATE = 21000 // ephemeral: tank state tick
export const KIND_SHELL = 21001 // ephemeral: a shell was fired
export const KIND_DEATH = 21002 // ephemeral: victim reports its own death
export const KIND_STRIKE = 21004 // ephemeral: a kill-streak air strike was called
export const KIND_SCORE = 30078 // addressable (NIP-78): persistent score record
/**
 * Pickup claim. Same NIP-78 kind, different `d` namespace — and stored rather
 * than ephemeral on purpose: relays forward ephemeral events only to whoever is
 * connected at that instant and cannot be asked for them afterwards, so a
 * client that joined a moment later would see pickups that are not there. It
 * carries a NIP-40 `expiration` so the relay drops it once it stops meaning
 * anything.
 */
export const KIND_CLAIM = 30078

export const SCORE_D_TAG = 'nostr-tank-arena/score'

/**
 * The addressable slot for one player's result in one block's round.
 *
 * Addressable events are keyed by (kind, pubkey, d), so a `d` that carries the
 * block height gives every player exactly one record per round — repost a
 * correction and it replaces, play the next block and it does not.
 */
export const blockScoreTag = (height: number) => `nostr-tank-arena/score/${height}`

export const roomTag = (room: string) => `tankarena-${room}`

/** Indexed so a whole block's results are one `#t` query. Single letter on purpose. */
export const blockTag = (height: number) => `tankblock-${height}`

/** Session attestation: "session pubkey S is playing as me until `exp`." */
export interface SessionPayload {
  s: string // session pubkey (hex)
  name: string // display name
  color: number // hue 0-359
  exp: number // unix seconds
  /**
   * Chosen skin id. Absent means the default, so an old client is not a
   * missing tank, it is a plastic one.
   *
   * On the attestation rather than on the state tick because it changes about
   * once a session: re-transmitting a lobby setting ten times a second forever
   * would be paying a tick-stream price for something nobody ever changes
   * mid-round. See `src/skins.ts`.
   */
  sk?: string
}

/**
 * Tank state tick. Signed by the session key, ~10x/second.
 *
 * `k` rides along because a streak is only worth having if the rest of the room
 * can see it. It costs a handful of bytes on an event that was already going
 * out, needs no new kind, and is exactly as trustworthy as the HP in the same
 * payload — which is to say the sender decides it, and always could.
 */
export interface StatePayload {
  t: number // sender clock, ms
  x: number
  y: number
  h: number // hull heading, radians
  g: number // gun heading, radians
  hp: number
  d: boolean // dead / respawning
  k?: number // kills in a row, for the streak glow
  /**
   * The sender's own round tally: kills and deaths.
   *
   * These are here because the scoreboard cannot be built out of the death
   * events alone. Deaths are ephemeral (kind 21002), so nothing stores them:
   * a client that joins mid-round has received none of the ones that already
   * happened and shows a room full of veterans at 0/0 forever, and a death
   * event that reaches three relays out of four is counted by whoever was
   * subscribed to those three. Every client's tally was its own, and no two
   * agreed.
   *
   * A tick, by contrast, arrives constantly and from the one client that
   * cannot be missing its own kills. So each tank reports its own score and
   * everybody else believes it, exactly like `hp` and `k` directly above.
   * Self-reported means forgeable — the README's "How to cheat this" section
   * says so plainly, and it is the same exposure the leaderboard already had.
   */
  ks?: number // kills this round
  ds?: number // deaths this round
  /**
   * Which block's round `ks`/`ds` belong to.
   *
   * Nobody is the host, so every client rolls the round when it personally
   * sees the new tip, and those moments are seconds apart. Without a round
   * stamp, a peer who has not rolled yet keeps sending last round's tally into
   * a scoreboard that has just reset, and everyone reads a stale, inflated
   * number for as long as the boundary takes to settle. A tally from a round
   * we are not playing is dropped rather than shown.
   */
  r?: number
  /**
   * Which barrels this client has seen destroyed, as a bitmask.
   *
   * Unioned on receipt, never replaced — see `applyCoverBits` in `arena.ts` for
   * why that choice is the whole consensus design. Short version: a union is
   * order-independent and idempotent, so a lost tick costs nothing and a late
   * joiner is caught up within 100ms by the next one, which a one-off
   * "barrel destroyed" event could never do.
   *
   * Omitted while nothing is destroyed, which is most of a round, so the common
   * tick is exactly the size it was before this existed.
   */
  b?: number
  /**
   * How chewed up each surviving piece of cover looks, three bits each.
   *
   * A thermometer code, so `|` is `max` and this unions exactly like `b` —
   * see `coverDamageBits` in `arena.ts`. Its own field rather than more bits in
   * `b` on purpose: a client that is already deployed ignores what it does not
   * know and simply draws no scuffs, where widening `b` would have made it read
   * "this crate is damaged" as "these crates are destroyed" and blank cover
   * that is still standing.
   *
   * Omitted while the board is untouched, which is the first minute of most
   * rounds.
   */
  cd?: number
  /**
   * Milliseconds of chopper time this client has left, when it is flying one.
   *
   * The whole gunship rides on this tick rather than on events of its own. A
   * machinegun is ten rounds a second and ten fire events a second on top of an
   * already-10Hz position stream is past what most public relays will accept —
   * so while `c` is set, `x`/`y` are the chopper instead of the tank and
   * `cx`/`cy` are the point on the ground it is shooting at. The tracers in
   * between are drawn by each client for itself and are not on the wire at all.
   *
   * A duration rather than a deadline, so it needs no clock agreement: a
   * receiver adds it to its own `now`. It is clamped on receipt, because a
   * hostile client claiming an hour of gunship is claiming a tank nobody can
   * shoot for an hour.
   */
  c?: number
  /** Where its rounds are landing, absent when it is flying but not firing. */
  cx?: number
  cy?: number
  /**
   * The team this tank has declared, 1..5, or absent for a free-for-all.
   *
   * **Self-declared, and that is the design rather than a shortcut.** There is
   * no host to assign teams, and deriving them from the roster is the one thing
   * that cannot work here: two clients with different relay visibility would
   * compute different sides for the same player, which is worse than lopsided
   * teams. Deriving them from the pubkey would work and would take the choice
   * away, which is the half of team play people actually want.
   *
   * So it is exactly as trustworthy as the `hp` beside it, and it happens to be
   * the one self-reported field with no exploit in it. Claiming somebody's team
   * makes their shells pass through you *and yours pass through them* — the
   * rule is applied by whoever is being shot, so a false claim buys a mutual
   * truce rather than immunity. See "Teams" in the README.
   */
  tm?: number
  /**
   * The flag this tank says it is carrying, 1..5, or absent.
   *
   * A flag is only ever at a base or on a tank — see `src/flags.ts` — so this
   * one number is the whole of the world state that moves. There is no
   * "dropped at" for two clients to disagree about, no pickup radius for
   * anybody to lie about, and nothing for a late joiner to have missed.
   *
   * Self-declared and resolved identically everywhere: two players claiming one
   * flag is settled on the lower session key, so a disagreement lasts exactly
   * as long as it takes both ticks to arrive and never becomes state.
   */
  f?: number
  /**
   * Captures this round, which is the only score a flag game keeps.
   *
   * Sits beside `ks`/`ds` and is exactly as trustworthy: self-reported by the
   * one client that cannot be missing its own captures, believed by everybody
   * else, and stamped with the same round `r` so last round's does not leak
   * into this one's.
   */
  cap?: number
  /**
   * Shells left in the sender's magazine, 0 while reloading.
   *
   * On the wire for a gameplay reason rather than a bookkeeping one: an empty
   * magazine is only a real cost if the tank across the arena can see it. A
   * reload nobody can read is a private pause; a reload everybody can read is
   * the two and a half seconds in which the right play is to close the
   * distance. Self-reported, exactly like the `hp` above it.
   */
  a?: number
  /**
   * 1 while this tank's recon sweep is running, absent otherwise.
   *
   * Recon is the one streak reward that helps a side rather than its earner:
   * while it runs, every enemy is marked through cover — for the earner *and*
   * for teammates. The flag is how a teammate knows to light the markers up.
   * Sent as a flag rather than a deadline for exactly the reason `sh` below
   * is: the markers go out when the ticks stop saying `rn`, and no receiver
   * ever has to read the sender's clock. A client too old to know the field
   * ignores it and simply draws no markers, which degrades to "recon helps
   * only the earner" rather than to anything wrong.
   */
  rn?: number
  /**
   * 1 while a shield is up, absent otherwise.
   *
   * Here for the same reason `a` is: a defensive buff nobody else can see is
   * not a tactical fact, it is a private surprise. Knowing the tank you are
   * lining up is currently eating one shot for free changes whether you take
   * that shot or wait fourteen seconds, and that decision is most of what
   * makes contesting a shield pad worth it.
   *
   * Sent as a flag rather than a deadline. A remaining-time number would have
   * to be read against the *sender's* clock, and this game has already been
   * bitten once by putting one client's clock into something another client
   * evaluates — the bubble simply pops when the ticks stop saying `sh`.
   */
  sh?: 1
}

/**
 * A shell leaving a barrel. Peers re-simulate it deterministically from t0.
 *
 * `b` is the bounce budget and `d` is the damage, and both travel with the shell
 * rather than being read from local state on arrival. Damage has to: the victim
 * is authoritative over its own HP, and the victim cannot know what the shooter
 * had picked up ten seconds ago.
 *
 * The bounce budget is here for a subtler reason — it is read from the round's
 * modifier, not from a buff. The Ricochet block gives shells
 * three bounces instead of one; without this field, a shell fired a moment
 * before a block landed would bounce once on the shooter's screen and three
 * times on everybody else's for as long as the boundary took to settle.
 */
export interface ShellPayload {
  id: string
  t0: number // sender clock at spawn, ms
  x: number
  y: number
  a: number // angle, radians
  b?: number // wall bounces before it dies; defaults to 1
  d?: number // hull points it takes off; defaults to 1, capped at 3 on arrival
  /**
   * Ground range of a lobbed shot, in world units. Absent means a flat shell.
   *
   * The range is what makes a lob re-simulable, and it has to travel with the
   * shot for the same reason `b` does — harder, in fact. A flat shell's path is
   * decided by walls every client already agrees on. A lob's path is decided by
   * how long one player held a key down, which nobody else can observe at all.
   * Without this field a lob is the one thing in the game with no shared input,
   * and the crater lands somewhere different on every screen.
   */
  l?: number
}

/** Victim-authoritative death report. `k` is the session pubkey of the killer. */
export interface DeathPayload {
  t: number
  k: string | null // killer session pubkey, null for self-destruct
  x: number
  y: number
}

/**
 * An air strike, earned at five kills without dying.
 *
 * One event for the whole run rather than one per bomb. Every client
 * re-simulates the line deterministically from `t0`, exactly like a shell: the
 * bombs walk across the board at a fixed cadence and each one detonates at a
 * position anybody can compute. That keeps a twelve-bomb strike at a single
 * event instead of twelve, which matters — a strike is the loudest thing in
 * the game and it should not also be the heaviest thing on the relay.
 *
 * Damage travels in the payload for the same reason it travels on a shell: the
 * victim is the one who applies it, and the victim cannot see what the caller
 * had going on at the moment they earned it.
 */
export interface StrikePayload {
  t0: number // caller's clock when the run starts, ms
  /** The row the bombs walk along, in arena pixels. */
  y: number
  /** 1 for left-to-right, -1 for right-to-left. */
  dir: 1 | -1
  /** How many bombs in the run. */
  n: number
  /** Hull points each blast takes off. */
  d: number
}

/**
 * An EMP, riding the strike kind rather than earning a kind of its own.
 *
 * One publish, no position, no damage: every receiver that is not on the
 * caller's side blanks its own HUD for a few seconds, by the same
 * victim-applies-it-to-itself trust model as the bombs. Deliberately missing
 * the `y` a bomb run carries — `onStrike` on a client too old to know about
 * EMPs validates `y` before anything else, so to an old client this payload
 * is malformed and silently dropped, instead of being clamped into a
 * one-bomb strike along the top wall.
 */
export interface EmpPayload {
  k: 'emp'
  t0: number // caller's clock at detonation, ms
}

export function parsePayload<T>(content: string): T | null {
  try {
    const v = JSON.parse(content)
    return v && typeof v === 'object' ? (v as T) : null
  } catch {
    return null
  }
}
