// Kind 0 profiles: who these npubs actually are.
//
// A signed score is only meaningful if you can tell whose it is, and a hex
// pubkey is not a person. This fetches the kind 0 metadata event for each real
// npub in the room — picture, display name, NIP-05 — and hands it to the
// scoreboard and the leaderboard.
//
// ## Three things this is careful about
//
// **It never blocks the game.** A profile that has not arrived renders as the
// short npub, exactly as before, and quietly upgrades itself when the event
// lands. Nothing waits on a relay to draw a frame.
//
// **It asks once.** Requests are coalesced into a single `REQ` per batch across
// the whole pool, and every pubkey is remembered for the session — including
// the ones that came back empty, so a player with no profile is not queried
// again every time the scoreboard repaints.
//
// **A NIP-05 is not believed until it is checked.** The `nip05` field in a kind
// 0 event is a claim the account made about itself; anyone can put
// `jack@cash.app` in theirs. The name only earns its tick once
// `https://<domain>/.well-known/nostr.json?name=<local>` has been fetched and
// found to map that name back to this exact pubkey. Until then it is shown
// greyed, because hiding it entirely would be its own kind of lie.
//
// The check is a cross-origin request to somebody else's server. Plenty of them
// do not send CORS headers, which is indistinguishable from "the domain is
// down" and is emphatically not proof of a fake. Those stay unverified rather
// than being marked false.

import type { Event } from 'nostr-tools'
import { nip19 } from 'nostr-tools'
import type { Net } from './nostr'

export interface Profile {
  pubkey: string
  /** Best available human name: display_name, then name, then a short npub. */
  name: string
  picture: string | null
  nip05: string | null
  /** `true` verified, `false` provably wrong, `null` not checked or unreachable. */
  nip05Verified: boolean | null
}

const KIND_METADATA = 0

/** How long a batch waits for more pubkeys before it goes out. */
const BATCH_MS = 250

export const shortNpub = (pubkey: string): string => {
  try {
    const npub = nip19.npubEncode(pubkey)
    return `${npub.slice(0, 10)}…${npub.slice(-4)}`
  } catch {
    return pubkey.slice(0, 10) + '…'
  }
}

/** Only http(s) images, and never a `data:` URL from a stranger's profile. */
const safeImage = (url: unknown): string | null => {
  if (typeof url !== 'string' || url.length > 400) return null
  return /^https?:\/\//i.test(url) ? url : null
}

export class Profiles {
  private cache = new Map<string, Profile>()
  private pending = new Set<string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private listeners: (() => void)[] = []

  constructor(private readonly net: Net) {}

  /** Called whenever a profile lands, so the HUD can repaint. */
  onChange(fn: () => void): void {
    this.listeners.push(fn)
  }

  /**
   * What we know right now, plus a request for what we do not.
   *
   * Synchronous on purpose: the scoreboard repaints eight times a second and
   * must never await anything. The placeholder is a real Profile, so callers
   * have one shape to render rather than two.
   */
  get(pubkey: string | null): Profile {
    if (!pubkey) return { pubkey: '', name: 'guest', picture: null, nip05: null, nip05Verified: null }
    const known = this.cache.get(pubkey)
    if (known) return known
    this.want(pubkey)
    return {
      pubkey,
      name: shortNpub(pubkey),
      picture: null,
      nip05: null,
      nip05Verified: null,
    }
  }

  /** Queue a pubkey for the next batch. Repeat calls are free. */
  want(pubkey: string): void {
    if (this.cache.has(pubkey) || this.pending.has(pubkey)) return
    this.pending.add(pubkey)
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, BATCH_MS)
  }

  private async flush(): Promise<void> {
    const authors = [...this.pending]
    this.pending.clear()
    if (!authors.length) return

    let events: Event[] = []
    try {
      events = await this.net.list({ kinds: [KIND_METADATA], authors, limit: authors.length * 2 })
    } catch {
      events = []
    }

    // Relays can return several kind 0s per author; keep the newest.
    const newest = new Map<string, Event>()
    for (const e of events) {
      const held = newest.get(e.pubkey)
      if (!held || e.created_at > held.created_at) newest.set(e.pubkey, e)
    }

    for (const pubkey of authors) {
      const event = newest.get(pubkey)
      let meta: Record<string, unknown> = {}
      if (event) {
        try {
          const parsed = JSON.parse(event.content)
          if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>
        } catch {
          /* a malformed profile is a missing profile */
        }
      }
      const display = typeof meta.display_name === 'string' ? meta.display_name.trim() : ''
      const name = typeof meta.name === 'string' ? meta.name.trim() : ''
      const nip05 = typeof meta.nip05 === 'string' && meta.nip05.includes('@') ? meta.nip05.trim() : null
      const profile: Profile = {
        pubkey,
        name: (display || name || shortNpub(pubkey)).slice(0, 28),
        picture: safeImage(meta.picture),
        nip05,
        nip05Verified: null,
      }
      // Cached even when nothing came back, so an npub with no profile is asked
      // for once a session rather than once a repaint.
      this.cache.set(pubkey, profile)
      if (nip05) void this.verify(profile)
    }
    for (const fn of this.listeners) fn()
  }

  /**
   * Check a NIP-05 against the domain that claims it.
   *
   * A failed fetch leaves it `null`, not `false`. Most of the failures here are
   * missing CORS headers on somebody else's static file host, and marking a
   * real identity as fake because their web server is strict would be a much
   * worse bug than showing an unverified name.
   */
  private async verify(profile: Profile): Promise<void> {
    const [local, domain] = (profile.nip05 ?? '').split('@')
    if (!local || !domain || !/^[a-z0-9._-]+$/i.test(local) || !/^[a-z0-9.-]+$/i.test(domain)) {
      return
    }
    try {
      const url = `https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(local)}`
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) })
      if (!res.ok) return
      const body = (await res.json()) as { names?: Record<string, string> }
      const claimed = body?.names?.[local]
      if (typeof claimed !== 'string') return
      profile.nip05Verified = claimed.toLowerCase() === profile.pubkey.toLowerCase()
    } catch {
      return
    } finally {
      for (const fn of this.listeners) fn()
    }
  }
}
