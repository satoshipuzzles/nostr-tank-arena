import {
  SimplePool,
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  nip19,
  type Event,
  type EventTemplate,
  type Filter,
} from 'nostr-tools'

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
]

declare global {
  interface Window {
    nostr?: {
      getPublicKey(): Promise<string>
      signEvent(event: EventTemplate): Promise<Event>
    }
  }
}

/**
 * A player has two keys.
 *
 * `pubkey` is who they actually are — an npub from a NIP-07 extension, or a
 * throwaway generated on the spot for guests. It signs exactly twice per match:
 * once to attest the session key, once to publish the final score.
 *
 * `sessionPubkey` signs the ~12Hz tick traffic. Routing every position update
 * through a browser extension would mean an approval dialog per frame, so the
 * session key does that work and the attestation ties it back to the real npub.
 * It never leaves memory and expires with the tab.
 */
export class Identity {
  readonly pubkey: string
  readonly isGuest: boolean
  readonly sessionSecret: Uint8Array
  readonly sessionPubkey: string
  private guestSecret: Uint8Array | null

  private constructor(pubkey: string, isGuest: boolean, guestSecret: Uint8Array | null) {
    this.pubkey = pubkey
    this.isGuest = isGuest
    this.guestSecret = guestSecret
    this.sessionSecret = generateSecretKey()
    this.sessionPubkey = getPublicKey(this.sessionSecret)
  }

  static async fromExtension(): Promise<Identity> {
    if (!window.nostr) throw new Error('No NIP-07 extension found')
    const pubkey = await window.nostr.getPublicKey()
    return new Identity(pubkey, false, null)
  }

  static guest(): Identity {
    const sk = generateSecretKey()
    return new Identity(getPublicKey(sk), true, sk)
  }

  get npub(): string {
    return nip19.npubEncode(this.pubkey)
  }

  /** Sign with the real identity. Prompts the extension for non-guests. */
  async signAsSelf(template: EventTemplate): Promise<Event> {
    if (this.guestSecret) return finalizeEvent(template, this.guestSecret)
    if (!window.nostr) throw new Error('No NIP-07 extension found')
    return window.nostr.signEvent(template)
  }

  /** Sign with the in-memory session key. No prompt, safe to call at tick rate. */
  signAsSession(template: EventTemplate): Event {
    return finalizeEvent(template, this.sessionSecret)
  }
}

export class Net {
  private pool = new SimplePool()
  private closers: { close(): void }[] = []
  readonly relays: string[]

  constructor(relays: string[] = DEFAULT_RELAYS) {
    this.relays = relays
  }

  subscribe(filter: Filter, onevent: (e: Event) => void): void {
    this.closers.push(this.pool.subscribeMany(this.relays, filter, { onevent }))
  }

  /** One-shot query across all relays. Used for the leaderboard, never in the loop. */
  async list(filter: Filter): Promise<Event[]> {
    return this.pool.querySync(this.relays, filter, { maxWait: 4000 })
  }

  publish(event: Event): void {
    // Fire and forget. A tick that fails to reach one relay is worthless by the
    // time we could retry it, and the next tick is 80ms away.
    for (const p of this.pool.publish(this.relays, event)) p.catch(() => {})
  }

  close(): void {
    for (const c of this.closers) c.close()
    this.closers = []
    this.pool.close(this.relays)
  }
}
