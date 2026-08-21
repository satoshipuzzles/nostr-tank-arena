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

export const SCORE_D_TAG = 'nostr-tank-arena/score'

export const roomTag = (room: string) => `tankarena-${room}`

/** Session attestation: "session pubkey S is playing as me until `exp`." */
export interface SessionPayload {
  s: string // session pubkey (hex)
  name: string // display name
  color: number // hue 0-359
  exp: number // unix seconds
}

/** Tank state tick. Signed by the session key, ~12x/second. */
export interface StatePayload {
  t: number // sender clock, ms
  x: number
  y: number
  h: number // hull heading, radians
  g: number // gun heading, radians
  hp: number
  d: boolean // dead / respawning
}

/** A shell leaving a barrel. Peers re-simulate it deterministically from t0. */
export interface ShellPayload {
  id: string
  t0: number // sender clock at spawn, ms
  x: number
  y: number
  a: number // angle, radians
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
