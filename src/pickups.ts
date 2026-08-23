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
// ## Which clock, and why it matters more than it looks
//
// "The round clock" has to mean a clock the *chain* supplies, not one each
// client starts for itself. This code originally measured `elapsed` from
// `performance.now()` at the moment that client's poll first saw the tip — and
// cowboy found what that costs. The wave index is inside the pickup id, so two
// clients whose 20-second polls are out of phase compute *different ids for the
// same pad*, `onClaim` finds no match, and the claim is dropped in silence. The
// pad stays live on one screen and gone on the other, all round. A player
// joining six minutes into a block was at `elapsed ≈ 0` against everyone else's
// `≈ 360` — a different wave, guaranteed, for their entire first round.
//
// So `elapsed` now comes from `BlockClock.secondsSinceTip()`: seconds since the
// block was *mined*, which every client reads from the same explorer field. The
// block timestamp is miner-chosen and may legally sit two hours off real time.
// That does not matter here — the requirement is that everyone agrees, not that
// the number is accurate, and they are all reading the same one.
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

export type PickupKind = 'repair' | 'rapid' | 'shield' | 'speed' | 'scatter' | 'siege'

/**
 * `shape` is the renderer's cue. Six pickups that were all the same octahedron
 * in six colours meant reading the pad from across the board was a colour-match
 * puzzle; six silhouettes are legible at arena zoom and stay legible to anyone
 * who cannot tell orange from red.
 */
export const PICKUPS: Record<
  PickupKind,
  { label: string; blurb: string; hue: number; seconds: number; shape: string }
> = {
  repair: { label: 'Repair', blurb: 'full hull', hue: 130, seconds: 0, shape: 'cross' },
  rapid: { label: 'Rapid fire', blurb: 'reload in a blink', hue: 20, seconds: 12, shape: 'bolt' },
  shield: { label: 'Shield', blurb: 'one shot bounces off', hue: 200, seconds: 14, shape: 'dome' },
  speed: { label: 'Overdrive', blurb: 'move like you stole it', hue: 285, seconds: 10, shape: 'ring' },
  scatter: { label: 'Scattershot', blurb: 'three shells a shot', hue: 55, seconds: 14, shape: 'star' },
  siege: { label: 'Siege shells', blurb: 'double damage', hue: 350, seconds: 10, shape: 'spike' },
}

const KINDS: PickupKind[] = ['repair', 'rapid', 'shield', 'speed', 'scatter', 'siege']

/**
 * Seconds between spawn waves.
 *
 * Raised from 22 because an item you can count on is not worth crossing the map
 * for. At half a minute the good pads are a decision — go for it and be exposed
 * on open ground, or hold the lane you already own — and that decision is the
 * whole reason pickups are in the game.
 */
export const WAVE_SECONDS = 34
/** How the round's modifier bends the schedule. Both come from the block hash. */
export interface WaveRules {
  /** Seconds between waves. */
  waveSeconds: number
  /** How many pads stay empty each wave. */
  emptyPads: number
}
export const DEFAULT_WAVES: WaveRules = { waveSeconds: WAVE_SECONDS, emptyPads: 1 }

/** How long a pickup sits unclaimed before the board clears for the next wave. */
export const PICKUP_LINGER = 20

/**
 * The wave clock, in seconds, on a timeline every client agrees on.
 *
 * `sinceTip` is seconds since the block was mined, when the explorer gave us a
 * timestamp. When it did not, this falls back to absolute unix seconds — which
 * is *also* a shared timeline, and that is the whole requirement. It shifts
 * where wave zero begins, and no client disagrees with any other about which
 * wave it is now, which is the only property the pickup id needs.
 *
 * What it must never fall back to is a local `performance.now()` origin. That
 * is a timeline of one.
 */
export function waveClock(sinceTip: number | null, nowMs = Date.now()): number {
  return sinceTip === null ? nowMs / 1000 : sinceTip
}

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
export function scheduleFor(
  blockHash: string,
  elapsed: number,
  rules: WaveRules = DEFAULT_WAVES,
): Pickup[] {
  if (!PADS.length) return []
  const period = Math.max(2, rules.waveSeconds)
  const wave = Math.floor(elapsed / period)
  const born = wave * period
  // An untouched pickup clears well before the next wave, so there is always a
  // stretch of empty board rather than one item silently becoming another. With
  // a 34-second period that is 20 seconds of contest and 14 of nothing, which
  // is what makes the spawn an event instead of scenery.
  if (elapsed - born > Math.min(PICKUP_LINGER, period - 2)) return []

  // Normally one pad per wave stays empty, so the board is never fully stocked
  // and there is a reason to contest the ones that are. Supply Run stocks the
  // lot.
  const skip = rules.emptyPads > 0 ? mix(blockHash, wave, 999) % PADS.length : -1
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
  scatterUntil: number
  siegeUntil: number
}

export const noBuffs = (): Buffs => ({
  rapidUntil: 0,
  shieldUntil: 0,
  speedUntil: 0,
  scatterUntil: 0,
  siegeUntil: 0,
})

/** Which timer each pickup runs. `repair` has none — it is instant. */
const BUFF_KEY: Partial<Record<PickupKind, keyof Buffs>> = {
  rapid: 'rapidUntil',
  shield: 'shieldUntil',
  speed: 'speedUntil',
  scatter: 'scatterUntil',
  siege: 'siegeUntil',
}

export function applyPickup(buffs: Buffs, kind: PickupKind, now: number): void {
  const key = BUFF_KEY[kind]
  if (!key) return
  buffs[key] = Math.max(buffs[key], now) + PICKUPS[kind].seconds * 1000
}

export const hasBuff = (buffs: Buffs, key: keyof Buffs, now: number): boolean => buffs[key] > now

/** Everything off. Death and a new block both end every timer you were running. */
export function clearBuffs(buffs: Buffs): void {
  for (const key of Object.keys(buffs) as (keyof Buffs)[]) buffs[key] = 0
}

/** How close you have to be to sweep one up. Generous: this is a party game. */
export const PICKUP_RADIUS = 42
