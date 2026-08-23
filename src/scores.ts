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
