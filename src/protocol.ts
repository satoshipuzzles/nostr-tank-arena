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
}

/** Victim-authoritative death report. `k` is the session pubkey of the killer. */
export interface DeathPayload {
  t: number
  k: string | null // killer session pubkey, null for self-destruct
  x: number
  y: number
}

export function parsePayload<T>(content: string): T | null {
  try {
    const v = JSON.parse(content)
    return v && typeof v === 'object' ? (v as T) : null
  } catch {
    return null
  }
}
