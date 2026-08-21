// The game: local simulation plus everything that arrives from relays.
//
// Authority model, stated once because it drives every decision below:
//   * Your own tank is authoritative for its position and its HP.
//   * Shells are authoritative from the shooter, but only as "fired at (x, y, a)
//     at t0" — every client re-simulates the flight path itself.
//   * A kill only counts when the *victim* signs a death event. You cannot
//     claim a kill; you can only be told you died.
// The cheat that survives this is a client that refuses to die. See README.

import type { Event, Filter } from 'nostr-tools'
import { ARENA_H, ARENA_W, SPAWNS, hasLineOfSight } from './arena'
import { Identity, Net } from './nostr'
import {
  KIND_DEATH,
  KIND_SESSION,
  KIND_SHELL,
  KIND_STATE,
  type DeathPayload,
  type SessionPayload,
  type ShellPayload,
  type StatePayload,
  parsePayload,
  roomTag,
} from './protocol'
import {
  MAX_HP,
  MUZZLE_OFFSET,
  RELOAD,
  RESPAWN_DELAY,
  type LocalTank,
  type Shell,
  lerpAngle,
  shellHits,
  spawnShell,
  stepShell,
  stepTank,
} from './sim'
import type { Controls } from './input'

const TICK_MS = 100 // 10Hz state broadcast
const SESSION_REBROADCAST_MS = 12_000
const INTERP_MS = 130
const MAX_EXTRAPOLATE_MS = 260
const PEER_TIMEOUT_MS = 9_000
const SESSION_TTL_S = 3600

export interface Peer {
  session: string
  pubkey: string | null // verified real npub, null until the attestation lands
  name: string
  color: number // hue the peer published
  displayColor: number // hue we actually draw, after collision spreading
  offset: number // localMs - senderMs, minimum observed
  hasOffset: boolean
  lastSeen: number
  buffer: StateSample[]
  view: { x: number; y: number; hull: number; gun: number; hp: number; dead: boolean }
  kills: number
  deaths: number
}

interface StateSample {
  t: number // already shifted into local time
  x: number
  y: number
  hull: number
  gun: number
  hp: number
  dead: boolean
}

export interface FeedEntry {
  text: string
  at: number
}

/** Six hues nobody can confuse for each other, even as 40px tanks. */
const PALETTE = [48, 190, 320, 100, 20, 265]

const randomId = () => {
  const b = new Uint8Array(8)
  crypto.getRandomValues(b)
  return Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('')
}

export class Game {
  readonly tank: LocalTank
  readonly peers = new Map<string, Peer>()
  readonly shells = new Map<string, Shell>()
  readonly feed: FeedEntry[] = []
  kills = 0
  deaths = 0
  /** Our own hue after spreading. Always gets first pick, so it never moves. */
  displayColor: number
  /** Set when a relay subscription has produced at least one event. */
  sawTraffic = false

  private seen = new Set<string>()
  private seenPrev = new Set<string>()
  private lastTick = 0
  private lastSessionBroadcast = 0
  private disposed = false

  constructor(
    readonly identity: Identity,
    readonly net: Net,
    readonly room: string,
    readonly name: string,
    readonly color: number,
  ) {
    this.displayColor = color
    const spawn = SPAWNS[Math.floor(Math.random() * SPAWNS.length)]
    this.tank = {
      x: spawn.x,
      y: spawn.y,
      hull: Math.atan2(ARENA_H / 2 - spawn.y, ARENA_W / 2 - spawn.x),
      gun: Math.atan2(ARENA_H / 2 - spawn.y, ARENA_W / 2 - spawn.x),
      hp: MAX_HP,
      dead: false,
      respawnAt: 0,
      reloadAt: 0,
    }
  }

  /** Subscribe to the room and publish the session attestation. */
  async start(): Promise<void> {
    const since = Math.floor(Date.now() / 1000) - 30
    const filter: Filter = {
      kinds: [KIND_SESSION, KIND_STATE, KIND_SHELL, KIND_DEATH],
      '#t': [roomTag(this.room)],
      since,
    }
    this.net.subscribe(filter, (e) => this.onEvent(e))
    await this.broadcastSession()
  }

  private async broadcastSession(): Promise<void> {
    const payload: SessionPayload = {
      s: this.identity.sessionPubkey,
      name: this.name,
      color: this.color,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S,
    }
    const signed = await this.identity.signAsSelf({
      kind: KIND_SESSION,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['t', roomTag(this.room)]],
      content: JSON.stringify(payload),
    })
    this.net.publish(signed)
    this.lastSessionBroadcast = performance.now()
  }

  private publishAsSession(kind: number, payload: unknown): void {
    this.net.publish(
      this.identity.signAsSession({
        kind,
        created_at: Math.floor(Date.now() / 1000),
        tags: [['t', roomTag(this.room)]],
        content: JSON.stringify(payload),
      }),
    )
  }

  // ---------------------------------------------------------------- inbound

  private onEvent(e: Event): void {
    if (this.disposed) return
    if (this.seen.has(e.id) || this.seenPrev.has(e.id)) return
    this.seen.add(e.id)
    if (this.seen.size > 3000) {
      // Rotate rather than clear: a clear would let a redelivered death event
      // count a second time.
      this.seenPrev = this.seen
      this.seen = new Set()
    }
    this.sawTraffic = true

    switch (e.kind) {
      case KIND_SESSION:
        return this.onSession(e)
      case KIND_STATE:
        return this.onState(e)
      case KIND_SHELL:
        return this.onShell(e)
      case KIND_DEATH:
        return this.onDeath(e)
    }
  }

  private onSession(e: Event): void {
    const p = parsePayload<SessionPayload>(e.content)
    if (!p || typeof p.s !== 'string' || p.s.length !== 64) return
    if (p.s === this.identity.sessionPubkey) return
    if (typeof p.exp === 'number' && p.exp * 1000 < Date.now()) return

    // The attestation is signed by the real npub and names the session key, so
    // this binding is the one thing in the protocol we can actually verify.
    const peer = this.ensurePeer(p.s)
    peer.pubkey = e.pubkey
    peer.name = typeof p.name === 'string' && p.name ? p.name.slice(0, 20) : peer.name
    peer.color = typeof p.color === 'number' ? p.color % 360 : peer.color
  }

  private ensurePeer(session: string): Peer {
    let peer = this.peers.get(session)
    if (!peer) {
      peer = {
        session,
        pubkey: null,
        name: 'tank-' + session.slice(0, 4),
        color: (parseInt(session.slice(0, 4), 16) || 0) % 360,
        displayColor: (parseInt(session.slice(0, 4), 16) || 0) % 360,
        offset: 0,
        hasOffset: false,
        lastSeen: performance.now(),
        buffer: [],
        view: { x: ARENA_W / 2, y: ARENA_H / 2, hull: 0, gun: 0, hp: MAX_HP, dead: false },
        kills: 0,
        deaths: 0,
      }
      this.peers.set(session, peer)
    }
    return peer
  }

  /**
   * Track the offset between a peer's clock and ours. The minimum of
   * (ourNow - theirStamp) is the least-delayed sample we have seen, so it is
   * the closest thing to the true offset without a round trip.
   */
  private updateOffset(peer: Peer, senderMs: number): void {
    const sample = performance.now() - senderMs
    if (!peer.hasOffset || sample < peer.offset) {
      peer.offset = sample
      peer.hasOffset = true
    }
  }

  private onState(e: Event): void {
    const p = parsePayload<StatePayload>(e.content)
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return
    if (e.pubkey === this.identity.sessionPubkey) return

    const peer = this.ensurePeer(e.pubkey)
    peer.lastSeen = performance.now()
    this.updateOffset(peer, p.t)

    const sample: StateSample = {
      t: p.t + peer.offset,
      x: p.x,
      y: p.y,
      hull: p.h,
      gun: p.g,
      hp: typeof p.hp === 'number' ? p.hp : MAX_HP,
      dead: !!p.d,
    }
    // Relays deliver out of order often enough to matter; keep the buffer sorted.
    const b = peer.buffer
    let i = b.length
    while (i > 0 && b[i - 1].t > sample.t) i--
    b.splice(i, 0, sample)
    if (b.length > 20) b.splice(0, b.length - 20)
  }

  private onShell(e: Event): void {
    const p = parsePayload<ShellPayload>(e.content)
    if (!p || typeof p.x !== 'number' || typeof p.a !== 'number') return
    if (e.pubkey === this.identity.sessionPubkey) return
    if (this.shells.has(p.id)) return

    const peer = this.ensurePeer(e.pubkey)
    peer.lastSeen = performance.now()
    this.updateOffset(peer, p.t0)

    const shell = spawnShell(p.id, e.pubkey, p.x, p.y, p.a)
    // Fast-forward by however long the event spent in flight, so the shell
    // appears where the shooter already sees it rather than at the muzzle.
    const lateMs = performance.now() - (p.t0 + peer.offset)
    stepShell(shell, Math.max(0, Math.min(1500, lateMs)) / 1000)
    if (!shell.dead) this.shells.set(shell.id, shell)
  }

  private onDeath(e: Event): void {
    const p = parsePayload<DeathPayload>(e.content)
    if (!p) return
    // Relays echo our own publishes straight back. Without this guard we would
    // create a peer for ourselves and count the death twice.
    if (e.pubkey === this.identity.sessionPubkey) return
    const victim = this.ensurePeer(e.pubkey)
    victim.lastSeen = performance.now()
    victim.deaths++

    const killerName =
      p.k === this.identity.sessionPubkey
        ? this.name
        : p.k
          ? (this.peers.get(p.k)?.name ?? 'someone')
          : null

    if (p.k === this.identity.sessionPubkey) this.kills++
    else if (p.k) {
      const killer = this.peers.get(p.k)
      if (killer) killer.kills++
    }

    this.pushFeed(
      killerName ? `${killerName} killed ${victim.name}` : `${victim.name} self-destructed`,
    )
  }

  private pushFeed(text: string): void {
    this.feed.push({ text, at: performance.now() })
    if (this.feed.length > 6) this.feed.shift()
  }

  // ----------------------------------------------------------------- update

  update(dt: number, controls: Controls): void {
    const now = performance.now()

    if (this.tank.dead) {
      if (now >= this.tank.respawnAt) this.respawn()
    } else {
      stepTank(this.tank, controls.throttle, controls.steer, controls.aim, dt)
      if (controls.fire && now >= this.tank.reloadAt) this.fire(now)
    }

    for (const shell of this.shells.values()) {
      stepShell(shell, dt)
      if (shell.dead) {
        this.shells.delete(shell.id)
        continue
      }
      this.collide(shell)
    }

    this.interpolate(now)
    this.prunePeers(now)
    this.spreadColors()

    if (now - this.lastTick >= TICK_MS) {
      this.lastTick = now
      this.publishState(now)
    }
    if (now - this.lastSessionBroadcast >= SESSION_REBROADCAST_MS) {
      void this.broadcastSession()
    }
    while (this.feed.length && now - this.feed[0].at > 6000) this.feed.shift()
  }

  private collide(shell: Shell): void {
    // Only our own tank's HP is authoritative, so that is the only hit that
    // changes game state. Hits on remote tanks just remove the shell locally
    // so it does not sail visually through someone.
    if (
      shell.owner !== this.identity.sessionPubkey &&
      !this.tank.dead &&
      shellHits(shell, this.tank.x, this.tank.y)
    ) {
      this.shells.delete(shell.id)
      this.tank.hp--
      if (this.tank.hp <= 0) this.die(shell.owner)
      return
    }

    for (const peer of this.peers.values()) {
      if (peer.session === shell.owner || peer.view.dead) continue
      if (shellHits(shell, peer.view.x, peer.view.y)) {
        this.shells.delete(shell.id)
        return
      }
    }
  }

  private fire(now: number): void {
    this.tank.reloadAt = now + RELOAD * 1000
    const x = this.tank.x + Math.cos(this.tank.gun) * MUZZLE_OFFSET
    const y = this.tank.y + Math.sin(this.tank.gun) * MUZZLE_OFFSET
    const shell = spawnShell(randomId(), this.identity.sessionPubkey, x, y, this.tank.gun)
    this.shells.set(shell.id, shell)
    const payload: ShellPayload = { id: shell.id, t0: now, x, y, a: this.tank.gun }
    this.publishAsSession(KIND_SHELL, payload)
  }

  private die(killer: string | null): void {
    this.tank.dead = true
    this.tank.hp = 0
    this.tank.respawnAt = performance.now() + RESPAWN_DELAY * 1000
    this.deaths++
    const payload: DeathPayload = {
      t: performance.now(),
      k: killer,
      x: this.tank.x,
      y: this.tank.y,
    }
    this.publishAsSession(KIND_DEATH, payload)
    const killerName = killer ? (this.peers.get(killer)?.name ?? 'someone') : null
    this.pushFeed(killerName ? `${killerName} killed you` : 'you self-destructed')
  }

  /** Spawn as far from live opponents as possible, preferring no line of sight. */
  private respawn(): void {
    const live = [...this.peers.values()].filter((p) => !p.view.dead)
    let best = SPAWNS[0]
    let bestScore = -Infinity
    for (const s of SPAWNS) {
      let score = Infinity
      for (const p of live) {
        let d = Math.hypot(p.view.x - s.x, p.view.y - s.y)
        if (hasLineOfSight(s.x, s.y, p.view.x, p.view.y)) d *= 0.4
        score = Math.min(score, d)
      }
      if (score > bestScore) {
        bestScore = score
        best = s
      }
    }
    this.tank.x = best.x
    this.tank.y = best.y
    this.tank.hp = MAX_HP
    this.tank.dead = false
    this.tank.hull = Math.atan2(ARENA_H / 2 - best.y, ARENA_W / 2 - best.x)
    this.tank.gun = this.tank.hull
  }

  /**
   * Draw remote tanks INTERP_MS in the past so there is always a pair of
   * samples to blend between. If the buffer runs dry we extrapolate briefly
   * rather than freezing, then give up and let the tank sit still.
   */
  private interpolate(now: number): void {
    const renderAt = now - INTERP_MS
    for (const peer of this.peers.values()) {
      const b = peer.buffer
      if (b.length === 0) continue
      const newest = b[b.length - 1]

      if (renderAt >= newest.t) {
        const ahead = Math.min(renderAt - newest.t, MAX_EXTRAPOLATE_MS)
        const prev = b.length >= 2 ? b[b.length - 2] : null
        let vx = 0
        let vy = 0
        if (prev && newest.t > prev.t) {
          vx = (newest.x - prev.x) / (newest.t - prev.t)
          vy = (newest.y - prev.y) / (newest.t - prev.t)
        }
        peer.view.x = newest.x + vx * ahead
        peer.view.y = newest.y + vy * ahead
        peer.view.hull = newest.hull
        peer.view.gun = newest.gun
        peer.view.hp = newest.hp
        peer.view.dead = newest.dead
        continue
      }

      let a = b[0]
      let bb = b[0]
      for (let i = 0; i < b.length - 1; i++) {
        if (b[i].t <= renderAt && b[i + 1].t >= renderAt) {
          a = b[i]
          bb = b[i + 1]
          break
        }
      }
      const span = bb.t - a.t
      const t = span > 0 ? (renderAt - a.t) / span : 0
      peer.view.x = a.x + (bb.x - a.x) * t
      peer.view.y = a.y + (bb.y - a.y) * t
      peer.view.hull = lerpAngle(a.hull, bb.hull, t)
      peer.view.gun = lerpAngle(a.gun, bb.gun, t)
      peer.view.hp = bb.hp
      peer.view.dead = bb.dead
      while (b.length > 2 && b[1].t < renderAt) b.shift()
    }
  }

  /**
   * Hues come from each player's own pubkey, so two people routinely turn up
   * the same colour — and nudging a hue by 30 degrees is not enough, two greens
   * 30 degrees apart still read as one green at arena zoom. So everyone snaps
   * to a fixed palette of six hues that are obviously different from each
   * other, and collisions take the next free slot.
   *
   * Purely local and purely cosmetic: your screen may colour a rival
   * differently to how they colour themselves, which matters far less than
   * being able to tell four tanks apart at a glance.
   */
  private spreadColors(): void {
    const used = new Set<number>()
    const take = (hue: number): number => {
      // Start from whichever palette slot is closest to their chosen hue.
      let start = 0
      let bestGap = Infinity
      for (let i = 0; i < PALETTE.length; i++) {
        const gap = Math.abs(((PALETTE[i] - hue + 540) % 360) - 180)
        if (gap < bestGap) {
          bestGap = gap
          start = i
        }
      }
      for (let i = 0; i < PALETTE.length; i++) {
        const slot = (start + i) % PALETTE.length
        if (!used.has(slot)) {
          used.add(slot)
          return PALETTE[slot]
        }
      }
      return PALETTE[start]
    }
    // We pick first so our own tank keeps one colour for the whole match, then
    // peers in a stable order so nobody swaps colour as the roster changes.
    this.displayColor = take(this.color)
    const ordered = [...this.peers.values()].sort((a, b) => (a.session < b.session ? -1 : 1))
    for (const p of ordered) p.displayColor = take(p.color)
  }

  private prunePeers(now: number): void {
    for (const [k, p] of this.peers) {
      if (now - p.lastSeen > PEER_TIMEOUT_MS) this.peers.delete(k)
    }
  }

  private publishState(now: number): void {
    const payload: StatePayload = {
      t: now,
      x: Math.round(this.tank.x * 10) / 10,
      y: Math.round(this.tank.y * 10) / 10,
      h: Math.round(this.tank.hull * 1000) / 1000,
      g: Math.round(this.tank.gun * 1000) / 1000,
      hp: this.tank.hp,
      d: this.tank.dead,
    }
    this.publishAsSession(KIND_STATE, payload)
  }

  scoreboard(): { name: string; kills: number; deaths: number; color: number; you: boolean }[] {
    const rows = [
      {
        name: this.name,
        kills: this.kills,
        deaths: this.deaths,
        color: this.displayColor,
        you: true,
      },
      ...[...this.peers.values()].map((p) => ({
        name: p.name,
        kills: p.kills,
        deaths: p.deaths,
        color: p.displayColor,
        you: false,
      })),
    ]
    return rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
  }

  dispose(): void {
    this.disposed = true
    this.net.close()
  }
}
