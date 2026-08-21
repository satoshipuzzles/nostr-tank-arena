// Leaderboard. Every entry is a score record signed by the player themselves —
// there is no server to ask, so there is nobody to lie to except each other.
// The honest framing of what that means lives in the README.

import type { Event } from 'nostr-tools'
import { nip19 } from 'nostr-tools'
import type { Identity, Net } from './nostr'
import { KIND_SCORE, SCORE_D_TAG, parsePayload } from './protocol'

export interface ScorePayload {
  kills: number
  deaths: number
  room: string
  at: number // unix seconds
}

export interface ScoreRow {
  pubkey: string
  npub: string
  kills: number
  deaths: number
  at: number
}

export async function publishScore(
  identity: Identity,
  net: Net,
  room: string,
  kills: number,
  deaths: number,
): Promise<void> {
  const payload: ScorePayload = { kills, deaths, room, at: Math.floor(Date.now() / 1000) }
  const signed = await identity.signAsSelf({
    kind: KIND_SCORE,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', SCORE_D_TAG],
      ['t', 'nostr-tank-arena'],
    ],
    content: JSON.stringify(payload),
  })
  net.publish(signed)
}

export async function fetchScores(net: Net, limit = 25): Promise<ScoreRow[]> {
  const events: Event[] = await net.list({
    kinds: [KIND_SCORE],
    '#d': [SCORE_D_TAG],
    limit: 200,
  })
  const best = new Map<string, ScoreRow>()
  for (const e of events) {
    const p = parsePayload<ScorePayload>(e.content)
    if (!p || typeof p.kills !== 'number' || typeof p.deaths !== 'number') continue
    // Addressable events replace by (kind, pubkey, d), so keep the newest.
    const existing = best.get(e.pubkey)
    if (existing && existing.at >= e.created_at) continue
    best.set(e.pubkey, {
      pubkey: e.pubkey,
      npub: nip19.npubEncode(e.pubkey),
      kills: Math.max(0, Math.floor(p.kills)),
      deaths: Math.max(0, Math.floor(p.deaths)),
      at: e.created_at,
    })
  }
  return [...best.values()]
    .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
    .slice(0, limit)
}
