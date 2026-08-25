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

export function parsePayload<T>(content: string): T | null {
  try {
    const v = JSON.parse(content)
    return v && typeof v === 'object' ? (v as T) : null
  } catch {
    return null
  }
}
