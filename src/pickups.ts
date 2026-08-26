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
 * The icon for each pickup, as polygons on a 32x32 grid with y pointing down.
 *
 * Geometry rather than an SVG string or a PNG, because the same six shapes have
 * to appear in two completely different renderers: an `<svg>` in the HUD chip
 * and an extruded mesh standing on the pad. A path string would mean drawing
 * each icon twice and the two drifting the first time one of them is tweaked —
 * the pad would show a bolt and the timer a lightning-free rectangle, and
 * nothing would flag it. One table, two consumers, no way to disagree.
 *
 * Six colours were never enough on their own. A pad read from the far end of a
 * 2000-unit board is a few dozen pixels of one hue, and telling orange from red
 * at that size is a coin flip for anybody and impossible for a good share of
 * players. A silhouette survives the distance and survives a screenshot.
 */
export type IconPolys = number[][][]

export const ICON_POLYS: Record<PickupKind, IconPolys> = {
  // A first-aid cross.
  repair: [
    [
      [12, 2], [20, 2], [20, 12], [30, 12], [30, 20], [20, 20],
      [20, 30], [12, 30], [12, 20], [2, 20], [2, 12], [12, 12],
    ],
  ],
  // A lightning bolt.
  rapid: [[[18, 2], [6, 18], [13, 18], [10, 30], [26, 12], [18, 12]]],
  // A heraldic shield.
  shield: [[[16, 2], [29, 7], [29, 17], [16, 30], [3, 17], [3, 7]]],
  // Two chevrons, the speedometer of icons.
  speed: [
    [[2, 5], [11, 5], [20, 16], [11, 27], [2, 27], [11, 16]],
    [[13, 5], [22, 5], [31, 16], [22, 27], [13, 27], [22, 16]],
  ],
  // Three shells leaving the barrel at once.
  scatter: [
    [[16, 1], [21, 11], [16, 16], [11, 11]],
    [[5, 11], [10, 20], [5, 29], [0, 20]],
    [[27, 11], [32, 20], [27, 29], [22, 20]],
  ],
  // A heavy shell coming down on you.
  siege: [[[11, 2], [21, 2], [21, 15], [29, 15], [16, 30], [3, 15], [11, 15]]],
}

/** The icon as inline SVG, for the HUD. Sized by CSS, coloured by `currentColor`. */
export function iconSvg(kind: PickupKind, cls = 'pico'): string {
  const polys = ICON_POLYS[kind]
    .map((poly) => `<polygon points="${poly.map(([x, y]) => `${x},${y}`).join(' ')}" />`)
    .join('')
  return `<svg class="${cls}" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">${polys}</svg>`
}

export const PICKUPS: Record<
  PickupKind,
  { label: string; blurb: string; hue: number; seconds: number }
> = {
  repair: { label: 'Repair', blurb: 'full hull', hue: 130, seconds: 0 },
  rapid: { label: 'Rapid fire', blurb: 'reload in a blink', hue: 20, seconds: 12 },
  shield: { label: 'Shield', blurb: 'one shot bounces off', hue: 200, seconds: 14 },
  speed: { label: 'Overdrive', blurb: 'move like you stole it', hue: 285, seconds: 10 },
  scatter: { label: 'Scattershot', blurb: 'three shells a shot', hue: 55, seconds: 14 },
  siege: { label: 'Siege shells', blurb: 'double damage', hue: 350, seconds: 10 },
}

const KINDS: PickupKind[] = ['repair', 'rapid', 'shield', 'speed', 'scatter', 'siege']

/**
 * Seconds in one spawn *frame*. Not the gap between spawns — see `spawnAt`.
 *
 * Raised from 34 because an item you can count on is not worth crossing the map
 * for, and lifted again to 52 when the board dropped from three pads a wave to
 * one or two. Scarcity is the whole point: at roughly one item a minute on a
 * four-player board, the spawn is an event that pulls everyone into the open
 * rather than scenery you drive over on the way somewhere.
 */
export const WAVE_SECONDS = 52

/** How the round's modifier bends the schedule. Both come from the block hash. */
export interface WaveRules {
  /** Length of one spawn frame, in seconds. */
  waveSeconds: number
  /** How many pads are stocked when a wave lands. */
  padsPerWave: number
}
export const DEFAULT_WAVES: WaveRules = { waveSeconds: WAVE_SECONDS, padsPerWave: 0 }

/** How long a pickup sits unclaimed before it goes away again. */
export const PICKUP_LINGER = 18

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
 *
 * Note what this rules out for everything below: `elapsed` may be ~1.7e9 on the
 * fallback path, so nothing here may walk waves from zero to find the current
 * one. Every derivation is O(1) in the wave index.
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
 * How many pads a wave stocks, when the modifier does not say.
 *
 * One most of the time and two now and then. A board where every pad lights up
 * on a metronome is a board where nobody contests anything — you take the one
 * nearest you and so does everyone else. One item means somebody does not get
 * it, and that is the whole fight.
 */
function padCount(hash: string, wave: number, rules: WaveRules): number {
  const fixed = Math.floor(rules.padsPerWave)
  if (fixed > 0) return Math.min(fixed, WINDOW)
  return mix(hash, wave, 4242) % 3 === 0 ? 2 : 1
}

/**
 * Where in its frame a wave actually lands.
 *
 * The frame is fixed so the wave index stays O(1) from `elapsed`; the spawn
 * *moment* moves inside it. That is what removes the metronome — consecutive
 * spawns sit anywhere from about 26 to about 78 seconds apart on a 52-second
 * frame, so you cannot count to the next one.
 */
function spawnOffset(hash: string, wave: number, period: number): number {
  const room = Math.max(0, period - PICKUP_LINGER - 4)
  if (room <= 0) return 0
  return 4 + (mix(hash, wave, 77) % room)
}

/**
 * How many pads one wave may light at most. Also the width of the rotating
 * window below, which is what makes "never the same pad twice running" a
 * property of the construction rather than a filter applied afterwards.
 */
const WINDOW = 2

/**
 * A permutation of the pads for one *cycle* of waves.
 *
 * ## Why a cycle, and why a permutation
 *
 * The requirement is that consecutive waves never share a pad, on a schedule
 * every client derives independently with no messages. The obvious version —
 * shuffle per wave, then drop anything the previous wave used — cannot be
 * written: asking what the previous wave used means asking what the wave before
 * *that* used, and on the unix-seconds fallback clock (`waveClock`) the wave
 * index is around fifty million. Nothing here may walk backwards.
 *
 * So the disjointness is structural. Waves come in cycles of `floor(n / WINDOW)`
 * and wave `w` takes window `w % windows` of this permutation: windows within a
 * cycle are disjoint slices of the same permutation, so no pad can appear in
 * two consecutive waves inside a cycle, for free.
 *
 * That leaves exactly one seam — the last wave of one cycle against the first
 * wave of the next — and it is closed by `avoid`: the incoming permutation
 * moves any pad from the outgoing cycle's *final* window out of its own first
 * window. The swap only ever touches positions before the final window, which
 * is what keeps this O(1): the final window of any cycle is the raw shuffle,
 * untouched by that cycle's own seam fix, so the next cycle can reconstruct it
 * without knowing anything about the cycle before it.
 */
function permutation(hash: string, cycle: number, windows: number, rules: WaveRules): number[] {
  const perm = PADS.map((_, pad) => pad).sort(
    (a, b) => mix(hash, cycle, a) - mix(hash, cycle, b) || a - b,
  )
  if (cycle <= 0 || windows < 3) return perm
  const previous = rawTail(hash, cycle - 1, windows, rules)
  const last = (windows - 1) * WINDOW
  for (let i = 0; i < WINDOW; i++) {
    if (!previous.has(perm[i])) continue
    // Somewhere before the final window there is a pad the outgoing wave did
    // not use — there are only WINDOW pads to avoid and more than WINDOW slots
    // to look in — so this always finds a partner.
    for (let j = WINDOW; j < last; j++) {
      if (previous.has(perm[j])) continue
      ;[perm[i], perm[j]] = [perm[j], perm[i]]
      break
    }
  }
  return perm
}

/**
 * The pads the final wave of a cycle lit. Deliberately reads the *raw* shuffle:
 * the seam fix never touches the final window, so this is exact, and it does
 * not recurse.
 */
function rawTail(hash: string, cycle: number, windows: number, rules: WaveRules): Set<number> {
  const perm = PADS.map((_, pad) => pad).sort(
    (a, b) => mix(hash, cycle, a) - mix(hash, cycle, b) || a - b,
  )
  const start = (windows - 1) * WINDOW
  const wave = cycle * windows + windows - 1
  return new Set(perm.slice(start, start + padCount(hash, wave, rules)))
}

/**
 * The pickups that should exist right now.
 *
 * `elapsed` is seconds on the shared round clock. Pure: given the same block
 * hash and the same elapsed time, every client in the room builds the same
 * list, in the same order, with the same ids.
 */
export function scheduleFor(
  blockHash: string,
  elapsed: number,
  rules: WaveRules = DEFAULT_WAVES,
): Pickup[] {
  if (!PADS.length) return []
  const period = Math.max(8, rules.waveSeconds)
  const wave = Math.floor(elapsed / period)
  const born = wave * period + spawnOffset(blockHash, wave, period)
  const age = elapsed - born
  // Before the spawn moment there is nothing, and an untouched pickup clears
  // after PICKUP_LINGER — so most of a frame is empty board, which is what
  // makes a spawn an event instead of scenery.
  if (age < 0 || age > PICKUP_LINGER) return []

  const windows = Math.max(1, Math.floor(PADS.length / WINDOW))
  const perm = permutation(blockHash, Math.floor(wave / windows), windows, rules)
  const slot = ((wave % windows) + windows) % windows
  const count = Math.min(padCount(blockHash, wave, rules), PADS.length)
  const pads = perm.slice(slot * WINDOW, slot * WINDOW + count)

  const out: Pickup[] = []
  let previousKind = -1
  for (const pad of pads) {
    // Two pads in the same wave never hand out the same thing: a wave that is
    // two shields is one choice with two locations, not two choices.
    let k = mix(blockHash, wave * 131 + pad, 13) % KINDS.length
    if (k === previousKind) k = (k + 1) % KINDS.length
    previousKind = k
    out.push({
      id: `${blockHash.slice(-8)}:${wave}:${pad}`,
      pad,
      at: PADS[pad],
      kind: KINDS[k],
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
  /** Recon sweep: enemies marked through cover. A streak reward, not a pad. */
  reconUntil: number
}

export const noBuffs = (): Buffs => ({
  rapidUntil: 0,
  shieldUntil: 0,
  speedUntil: 0,
  scatterUntil: 0,
  siegeUntil: 0,
  reconUntil: 0,
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
