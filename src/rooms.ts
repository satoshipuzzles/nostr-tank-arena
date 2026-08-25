// Which games are live, and whether there is a seat.
//
// Rooms in this game were always free — type a name, you are in it — which is
// great until you want to *find* one. There is no server holding a list of open
// tables, so the list has to be built the same way everything else here is:
// each client says where it is, and everyone else adds it up.
//
// ## Why a stored event and not an ephemeral one
//
// The room already broadcasts a session attestation on an ephemeral kind, and
// that is exactly the wrong shape for a lobby. Relays forward ephemeral events
// only to clients connected at that instant and cannot be asked for them
// afterwards — so a player sitting on the lobby screen would see a room appear
// only when somebody happened to re-announce, and a room that has been running
// for an hour would be invisible until then.
//
// So presence is an *addressable* record with a NIP-40 `expiration`: one slot
// per player (`d` is a constant, so switching rooms replaces rather than
// stacks), queryable by a client that just opened the page, and dropped by the
// relay on schedule instead of leaving the lobby full of ghosts.
//
// ## The expiry is headroom, not a tidy-up
//
// NIP-40 is evaluated against the *relay's* clock, not ours. A beacon written
// by a client whose clock is a minute fast against a relay whose clock is a
// minute slow has to survive that, so the TTL is a generous multiple of the
// republish interval and a fixed offset from `created_at`. A player who closes
// the tab lingers in the lobby for up to a couple of minutes, which is the
// right trade: a stale room in the list costs a wasted click, and a room that
// vanishes while somebody is in it costs a game.
//
// ## What this does not do
//
// It does not enforce anything. Nobody can stop a fifth player driving into a
// four-seat room, and a client can claim to be in a room it is not. This is a
// notice board, not a matchmaker — every count here is what people said about
// themselves, exactly like the leaderboard, and the UI says so.

import type { Event } from 'nostr-tools'
import { nip19 } from 'nostr-tools'
import type { Identity, Net } from './nostr'
import { parsePayload, roomTag } from './protocol'

/** Same NIP-78 kind as scores and claims, a different `d` namespace. */
export const KIND_PRESENCE = 30078
export const PRESENCE_D = 'nostr-tank-arena/here'
/** Indexed so the whole lobby is one `#t` query. Single letter on purpose. */
export const PRESENCE_TAG = 'tankarena-live'

/** How often a client in a room re-states that it is there. */
export const BEACON_EVERY_MS = 30_000
/**
 * How long a beacon is good for. Four republish intervals: enough that a
 * missed publish, a rate limit or a minute of clock skew between a player and a
 * relay does not blink a live room out of the lobby.
 */
export const PRESENCE_TTL_S = 120

/**
 * Seats in a room.
 *
 * Puzz: "We need to have rooms with more than 4 players and different map sizes
 * for different game types."
 *
 * Eight, and the number is bounded by the relay rather than by the game. Each
 * client publishes its own position tick at 10Hz no matter how many people are
 * in the room, so raising this does not change what anybody *sends* — what it
 * changes is what everybody receives, which goes up linearly: three peers at
 * 10Hz is thirty events a second, seven is seventy. Seventy is comfortable for
 * a socket and uncomfortable for a relay operator, and it is the honest ceiling
 * until the tick rate scales with occupancy.
 *
 * The board does not grow with the room, and that is deliberate. Board size
 * comes from the block hash — eight layouts from 1500x1100 to 2100x1550 — so
 * every client agrees on it without being told. Deriving it from *occupancy*
 * would mean two clients with different relay visibility playing different
 * board sizes, which is the one thing a shared arena cannot survive.
 *
 * This is a lobby number, not a rule. Nothing in the simulation enforces it:
 * `roleFor` hands a ninth arrival a place in the queue rather than a seat, and
 * a client that ignores that is a client that ignores it. The queue is a
 * courtesy, and it has always been one.
 */
export const SEATS = 8

export type Role = 'seat' | 'queue' | 'watch'

export interface PresencePayload {
  room: string
  name: string
  /** Hue 0-359, so the lobby can show the colour they are driving. */
  hue: number
  role: Role
  /** Block height they are playing, when they have a tip. */
  block?: number
  /** Board name, so the lobby can say what map is up without deriving it. */
  layout?: string
  /** Unix seconds, by the publisher's clock. Only used to age out ghosts. */
  at: number
}

export interface Occupant {
  pubkey: string
  npub: string
  name: string
  hue: number
  role: Role
  at: number
}

export interface LiveRoom {
  room: string
  players: Occupant[]
  queue: Occupant[]
  watchers: Occupant[]
  /** Seats not taken. Zero means the table is full. */
  open: number
  block?: number
  layout?: string
  /** Newest beacon in the room, so the list can sort by liveliness. */
  freshest: number
}

/** Announce where you are. Signed by your real npub, so the face is yours. */
export async function publishPresence(
  identity: Identity,
  net: Net,
  room: string,
  name: string,
  hue: number,
  role: Role,
  block?: number,
  layout?: string,
): Promise<void> {
  const at = Math.floor(Date.now() / 1000)
  const payload: PresencePayload = {
    room,
    name: name.slice(0, 16),
    hue,
    role,
    at,
    ...(block ? { block } : {}),
    ...(layout ? { layout } : {}),
  }
  const signed = await identity.signAsSelf({
    kind: KIND_PRESENCE,
    created_at: at,
    tags: [
      ['d', PRESENCE_D],
      ['t', PRESENCE_TAG],
      ['t', roomTag(room)],
      // A fixed offset from our own `created_at`, never a wall-clock deadline:
      // the relay judges this against its clock and ours may be wrong.
      ['expiration', String(at + PRESENCE_TTL_S)],
    ],
    content: JSON.stringify(payload),
  })
  net.publish(signed)
}

/**
 * Every room somebody says they are in, busiest first.
 *
 * No `since` filter, deliberately. A `since` is our clock matched by the relay
 * against `created_at` values other people wrote, so a client running a minute
 * fast receives an empty lobby and has no way to tell that from a quiet night.
 * Bound with `limit`, let NIP-40 do the expiring, and drop obvious ghosts here.
 */
export async function fetchLiveRooms(net: Net, limit = 300): Promise<LiveRoom[]> {
  const events: Event[] = await net.list({
    kinds: [KIND_PRESENCE],
    '#t': [PRESENCE_TAG],
    limit,
  })
  return groupRooms(events)
}

/**
 * Beacons to rooms. Exported so it can be tested without a relay.
 *
 * `nowSeconds` is only used to age out beacons a relay kept past their
 * expiration, with a wide margin — this is a second line of defence against
 * ghosts, not a clock the protocol depends on.
 */
export function groupRooms(events: Event[], nowSeconds = Math.floor(Date.now() / 1000)): LiveRoom[] {
  /** room -> pubkey -> their newest beacon. */
  const rooms = new Map<string, Map<string, Occupant & { block?: number; layout?: string }>>()
  const cutoff = nowSeconds - PRESENCE_TTL_S * 3
  for (const e of events) {
    const p = parsePayload<PresencePayload>(e.content)
    if (!p || typeof p.room !== 'string') continue
    const room = p.room.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24)
    if (!room) continue
    if (e.created_at < cutoff) continue
    const role: Role = p.role === 'queue' || p.role === 'watch' ? p.role : 'seat'
    let occupants = rooms.get(room)
    if (!occupants) rooms.set(room, (occupants = new Map()))
    const held = occupants.get(e.pubkey)
    // Addressable events replace, but a relay can still hand back an old copy
    // alongside the new one. Newest signature wins, so one player is one seat.
    if (held && held.at >= e.created_at) continue
    occupants.set(e.pubkey, {
      pubkey: e.pubkey,
      npub: nip19.npubEncode(e.pubkey),
      name: typeof p.name === 'string' && p.name.trim() ? p.name.slice(0, 16) : 'tank',
      hue: Number.isFinite(p.hue) ? ((Math.floor(p.hue) % 360) + 360) % 360 : 200,
      role,
      at: e.created_at,
      block: typeof p.block === 'number' ? Math.floor(p.block) : undefined,
      layout: typeof p.layout === 'string' ? p.layout.slice(0, 32) : undefined,
    })
  }

  const out: LiveRoom[] = []
  for (const [room, occupants] of rooms) {
    const all = [...occupants.values()].sort((a, b) => a.at - b.at || a.pubkey.localeCompare(b.pubkey))
    const players = all.filter((o) => o.role === 'seat')
    const queue = all.filter((o) => o.role === 'queue')
    const watchers = all.filter((o) => o.role === 'watch')
    // The block and board come from whoever spoke most recently, because a
    // player who joined thirty seconds ago knows the current round and one who
    // has been sitting in a stale tab does not.
    const newest = all.reduce((best, o) => (o.at > best.at ? o : best), all[0])
    out.push({
      room,
      players,
      queue,
      watchers,
      open: Math.max(0, SEATS - players.length),
      block: newest?.block,
      layout: newest?.layout,
      freshest: newest?.at ?? 0,
    })
  }
  // Rooms with people in them first, then the ones with a seat going spare,
  // then whatever is freshest. A lobby sorted by name buries the live game.
  return out.sort(
    (a, b) =>
      b.players.length - a.players.length ||
      b.open - a.open ||
      b.freshest - a.freshest ||
      a.room.localeCompare(b.room),
  )
}

/**
 * Where a player joining this room should sit.
 *
 * Purely advisory — nothing stops a client ignoring it, and the honest framing
 * is in the module header. `queue` is what a full table hands you: you are in
 * the room, you can see the game, and you take the next seat that frees up.
 */
export function seatFor(room: LiveRoom | undefined, wantWatch: boolean): Role {
  if (wantWatch) return 'watch'
  if (!room) return 'seat'
  return room.open > 0 ? 'seat' : 'queue'
}
