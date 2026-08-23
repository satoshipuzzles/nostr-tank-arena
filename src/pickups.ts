// Pickups on the board.
//
// The hard part of an item in a server-less game is not the effect, it is
// agreeing that the item exists. This side-steps the problem entirely: a
// pickup's pad, its type and its spawn time are a pure function of the block
// hash and the round clock, so every client computes the same schedule from a
// number they already share. Nothing is announced, nothing is voted on, and a
// player who joins mid-round derives the same board state as everyone else
// from the tip alone.
//
// ## What is published, and what is not
//
// Only the claim. When your tank touches a live pickup you take it immediately
// and locally — no round trip, no waiting for consensus — and publish "I took
// pad 3 of block 912345". Everyone else hides that pad when the claim arrives.
//
// cowboy's two objections to the obvious design both apply and are both
// handled:
//
//   1. **Ephemeral events are not stored.** A claim on an ephemeral kind would
//      never reach a client that connected 200ms later, and there is no way to
//      ask for it afterwards. So a claim is a *stored* addressable record with
//      a NIP-40 `expiration`: a late joiner can REQ it, and the relay drops it
//      on schedule instead of keeping game litter forever.
//   2. **`created_at` is chosen by the publisher.** So nothing here is ordered
//      by it. A simultaneous double-grab is resolved by *not resolving it*:
//      both players get the pickup. That is a deliberate choice and not a
//      shrug — the window is one relay round trip, it happens rarely, and a
//      party game that occasionally hands two people a shield is better than
//      one where grabbing an item has 200ms of lag while the network decides.
//      There is nothing here worth backdating a timestamp for.
//
// The addressable `d` includes the claimant, so two claims for the same pad
// coexist rather than overwriting each other. A relay that only kept the last
// one would be silently picking a winner, which is exactly the kind of hidden
// authority this game does not want.

import { PADS } from './arena'
import type { Pt } from './arena'

export type PickupKind = 'repair' | 'rapid' | 'shield' | 'speed'

export const PICKUPS: Record<PickupKind, { label: string; hue: number; seconds: number }> = {
  repair: { label: 'Repair', hue: 130, seconds: 0 },
  rapid: { label: 'Rapid fire', hue: 20, seconds: 12 },
  shield: { label: 'Shield', hue: 200, seconds: 14 },
  speed: { label: 'Overdrive', hue: 285, seconds: 10 },
}

const KINDS: PickupKind[] = ['repair', 'rapid', 'shield', 'speed']

/** Seconds between spawn waves. Long enough that an item is worth crossing for. */
export const WAVE_SECONDS = 22
/** How long an untouched pickup stays on the board before the next wave. */
export const PICKUP_TTL = WAVE_SECONDS - 2

export interface Pickup {
  /** `<height>:<wave>:<padIndex>`. Unique for the whole round, and derivable. */
  id: string
  pad: number
  at: Pt
  kind: PickupKind
  /** Round-clock seconds when it appeared. */
  born: number
  taken: boolean
}

/**
 * A small deterministic hash. Not cryptography — this only has to turn a block
 * hash plus two integers into a stable, well-spread number, and every client
 * has to get the same answer from the same inputs.
 */
function mix(seed: string, a: number, b: number): number {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  h ^= Math.imul(a + 1, 2654435761)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= Math.imul(b + 1, 40503)
  h ^= h >>> 16
  return h >>> 0
}

/**
 * The pickups that should exist right now.
 *
 * `elapsed` is seconds since the round started. Pure: given the same block hash
 * and the same elapsed time, every client in the room builds the same list, in
 * the same order, with the same ids.
 */
export function scheduleFor(blockHash: string, elapsed: number): Pickup[] {
  if (!PADS.length) return []
  const wave = Math.floor(elapsed / WAVE_SECONDS)
  const born = wave * WAVE_SECONDS
  if (elapsed - born > PICKUP_TTL) return []

  // One pad per wave stays empty, so the board is never fully stocked and there
  // is a reason to contest the ones that are.
  const skip = mix(blockHash, wave, 999) % PADS.length
  const out: Pickup[] = []
  for (let pad = 0; pad < PADS.length; pad++) {
    if (pad === skip) continue
    const kind = KINDS[mix(blockHash, wave, pad) % KINDS.length]
    out.push({
      id: `${blockHash.slice(-8)}:${wave}:${pad}`,
      pad,
      at: PADS[pad],
      kind,
      born,
      taken: false,
    })
  }
  return out
}

/** What a claim event carries. Small on purpose — the rest is derivable. */
export interface ClaimPayload {
  /** Pickup id, exactly as `scheduleFor` produced it. */
  p: string
  kind: PickupKind
}

/** The addressable key for one player's claim on one pickup. */
export const claimTag = (pickupId: string, claimant: string) =>
  `nostr-tank-arena/claim/${pickupId}/${claimant.slice(0, 16)}`

/** Buffs currently running on a tank. Times are `performance.now()` deadlines. */
export interface Buffs {
  rapidUntil: number
  shieldUntil: number
  speedUntil: number
}

export const noBuffs = (): Buffs => ({ rapidUntil: 0, shieldUntil: 0, speedUntil: 0 })

export function applyPickup(buffs: Buffs, kind: PickupKind, now: number): void {
  const seconds = PICKUPS[kind].seconds * 1000
  if (kind === 'rapid') buffs.rapidUntil = Math.max(buffs.rapidUntil, now) + seconds
  if (kind === 'shield') buffs.shieldUntil = Math.max(buffs.shieldUntil, now) + seconds
  if (kind === 'speed') buffs.speedUntil = Math.max(buffs.speedUntil, now) + seconds
}

export const hasBuff = (buffs: Buffs, key: keyof Buffs, now: number): boolean => buffs[key] > now

/** How close you have to be to sweep one up. Generous: this is a party game. */
export const PICKUP_RADIUS = 42
