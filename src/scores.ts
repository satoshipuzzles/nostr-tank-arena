// Leaderboard. Every entry is a score record signed by the player themselves —
// there is no server to ask, so there is nobody to lie to except each other.
// The honest framing of what that means lives in the README.

import type { Event } from 'nostr-tools'
import { nip19 } from 'nostr-tools'
import type { Identity, Net } from './nostr'
import { KIND_SCORE, SCORE_D_TAG, blockScoreTag, blockTag, parsePayload } from './protocol'

export interface ScorePayload {
  kills: number
  deaths: number
  room: string
  at: number // unix seconds
  /** Block height of the round this result belongs to. Absent on old records. */
  block?: number
  /** Which board it was played on, for context on the leaderboard. */
  layout?: string
  /** Best kill streak in the round. */
  streak?: number
}

export interface ScoreRow {
  pubkey: string
  npub: string
  kills: number
  deaths: number
  at: number
  /** Which block's round this was, when the record says so. */
  block?: number
}

/**
 * Publish a result for one block's round.
 *
 * Two tags do two different jobs. `d` carries the block height, so the record
 * is one addressable slot per player per round and cannot be stacked. `t`
 * carries the height too, because only single-letter tags are indexed by
 * relays — `#t: ["tankblock-912345"]` is how the per-block board is queried,
 * and a `["block", "912345"]` tag would have looked right and been unqueryable.
 *
 * With no block height (the chain tip never arrived) it falls back to the
 * original all-time slot, so the button never becomes dead.
 */
export async function publishScore(
  identity: Identity,
  net: Net,
  room: string,
  kills: number,
  deaths: number,
  block?: number,
  layout?: string,
  streak?: number,
): Promise<void> {
  const payload: ScorePayload = {
    kills,
    deaths,
    room,
    at: Math.floor(Date.now() / 1000),
    ...(block ? { block } : {}),
    ...(layout ? { layout } : {}),
    ...(streak ? { streak } : {}),
  }
  const tags = block
    ? [
        ['d', blockScoreTag(block)],
        ['t', 'nostr-tank-arena'],
        ['t', blockTag(block)],
      ]
    : [
        ['d', SCORE_D_TAG],
        ['t', 'nostr-tank-arena'],
      ]
  const signed = await identity.signAsSelf({
    kind: KIND_SCORE,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: JSON.stringify(payload),
  })
  net.publish(signed)
}

/** Everyone's result for one block, newest signature per player. */
export async function fetchBlockScores(net: Net, height: number, limit = 25): Promise<ScoreRow[]> {
  const events: Event[] = await net.list({
    kinds: [KIND_SCORE],
    '#t': [blockTag(height)],
    limit: 200,
  })
  return rank(events, limit)
}

export async function fetchScores(net: Net, limit = 25): Promise<ScoreRow[]> {
  // Both shapes: the all-time slot older clients wrote, and every per-block
  // record. A player's best round is what they are ranked on.
  const events: Event[] = await net.list({
    kinds: [KIND_SCORE],
    '#t': ['nostr-tank-arena'],
    limit: 300,
  })
  const legacy: Event[] = await net.list({
    kinds: [KIND_SCORE],
    '#d': [SCORE_D_TAG],
    limit: 200,
  })
  return rank([...events, ...legacy], limit, 'best')
}

/**
 * Turn signed records into a table.
 *
 * `mode` decides what to do when one pubkey appears more than once: the
 * per-block board keeps their latest signature for that block, and the all-time
 * board keeps their best round. Neither is a defence against anything — every
 * number here was chosen by the player who signed it, which the UI says out
 * loud.
 */
function rank(events: Event[], limit: number, mode: 'latest' | 'best' = 'latest'): ScoreRow[] {
  const best = new Map<string, ScoreRow>()
  for (const e of events) {
    const p = parsePayload<ScorePayload>(e.content)
    if (!p || typeof p.kills !== 'number' || typeof p.deaths !== 'number') continue
    const row = {
      pubkey: e.pubkey,
      npub: nip19.npubEncode(e.pubkey),
      kills: Math.max(0, Math.floor(p.kills)),
      deaths: Math.max(0, Math.floor(p.deaths)),
      at: e.created_at,
      block: typeof p.block === 'number' ? p.block : undefined,
    }
    const existing = best.get(e.pubkey)
    if (existing) {
      const better = mode === 'best' ? row.kills > existing.kills : row.at > existing.at
      if (!better) continue
    }
    best.set(e.pubkey, row)
  }
  return [...best.values()]
    .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
    .slice(0, limit)
}

/**
 * The difficulty epoch a block belongs to, which is what this game calls a season.
 *
 * 2016 blocks, roughly a fortnight, and — the reason it is the right boundary
 * rather than a nice round number — it is *derived from the chain* rather than
 * announced by anybody. Every client computes the same season for the same
 * block with no server and no coordination, which is the same trick the round
 * clock already plays with the block hash.
 */
export const EPOCH_BLOCKS = 2016
export const seasonOf = (height: number): number => Math.floor(height / EPOCH_BLOCKS)

export interface BlockResult {
  height: number
  season: number
  /** Whoever posted the most kills for that block. Never null — a block with no
   *  records is not in this list at all. */
  winner: ScoreRow
  /** How many distinct players published a result for that block. */
  players: number
  /** Total kills anybody claimed in that round, which is the block's "size". */
  kills: number
}

/**
 * Every block anybody has played, newest first, with its winner.
 *
 * This is the leaderboard as a chain rather than as a table: one card per block
 * in the order the chain produced them, the way a block explorer shows blocks.
 * It reads the same signed records `fetchScores` does — no new event kind, no
 * new tag, nothing to publish. The per-block board was already one addressable
 * slot per player per height; this only groups them the other way round.
 *
 * The same caveat applies as everywhere else on this screen and it is worth
 * restating rather than assuming: every number here was chosen by the player
 * who signed it. Winning a block means having published the largest number, not
 * having scored it. The README's "How to cheat this" is the honest version.
 */
export interface BlockWall {
  blocks: BlockResult[]
  /**
   * True when the relays had more blocks than fit, so this is a window and not
   * the history.
   *
   * It exists because of what the caller does with it. A season tally computed
   * over a truncated window is *wrong*, not merely incomplete — the oldest
   * season in view is missing however many of its blocks fell off the end, and
   * a screen saying "so-and-so leads with four blocks" when it cannot see the
   * other twenty is a confident lie. The UI drops that line for the oldest
   * season rather than qualifying it.
   */
  truncated: boolean
}

export async function fetchBlockWall(net: Net, limit = 60): Promise<BlockWall> {
  const events: Event[] = await net.list({
    kinds: [KIND_SCORE],
    '#t': ['nostr-tank-arena'],
    limit: 500,
  })
  /** height -> pubkey -> that player's latest record for the block. */
  const byBlock = new Map<number, Map<string, ScoreRow>>()
  for (const e of events) {
    const p = parsePayload<ScorePayload>(e.content)
    if (!p || typeof p.block !== 'number' || typeof p.kills !== 'number') continue
    if (typeof p.deaths !== 'number') continue
    const height = Math.floor(p.block)
    if (!Number.isFinite(height) || height <= 0) continue
    const row: ScoreRow = {
      pubkey: e.pubkey,
      npub: nip19.npubEncode(e.pubkey),
      kills: Math.max(0, Math.floor(p.kills)),
      deaths: Math.max(0, Math.floor(p.deaths)),
      at: e.created_at,
      block: height,
    }
    let players = byBlock.get(height)
    if (!players) byBlock.set(height, (players = new Map()))
    const seen = players.get(e.pubkey)
    // One slot per player per block: a relay handing back both an old and a new
    // signature for the same addressable event must not count as two players.
    if (!seen || row.at > seen.at) players.set(e.pubkey, row)
  }
  const wall: BlockResult[] = []
  for (const [height, players] of byBlock) {
    const rows = [...players.values()]
    // Fewest deaths breaks a tie on kills, and the earlier signature breaks
    // that — so the order is the same on every client rather than being
    // whatever order the relay happened to answer in.
    rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.at - b.at)
    wall.push({
      height,
      season: seasonOf(height),
      winner: rows[0],
      players: rows.length,
      kills: rows.reduce((n, r) => n + r.kills, 0),
    })
  }
  wall.sort((a, b) => b.height - a.height)
  return { blocks: wall.slice(0, limit), truncated: wall.length > limit }
}

/**
 * Who took each season, from a wall that has already been fetched.
 *
 * Blocks won, not kills totalled. A season is a fortnight of rounds and the
 * thing worth being proud of is having taken more of them than anybody else —
 * totalling kills would hand the season to whoever played the most, which is a
 * measure of free time rather than of anything that happened in a match.
 */
export function seasonWinners(wall: BlockResult[]): { season: number; pubkey: string; blocks: number }[] {
  if (!wall.length) return []
  const bySeason = new Map<number, Map<string, number>>()
  for (const b of wall) {
    let tally = bySeason.get(b.season)
    if (!tally) bySeason.set(b.season, (tally = new Map()))
    tally.set(b.winner.pubkey, (tally.get(b.winner.pubkey) ?? 0) + 1)
  }
  return [...bySeason]
    .map(([season, tally]) => {
      const [pubkey, blocks] = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
      return { season, pubkey, blocks }
    })
    .sort((a, b) => b.season - a.season)
}
