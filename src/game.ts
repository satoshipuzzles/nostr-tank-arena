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
import {
  PICKUPS,
  PICKUP_RADIUS,
  applyPickup,
  claimTag,
  clearBuffs,
  hasBuff,
  noBuffs,
  scheduleFor,
  type Buffs,
  type ClaimPayload,
  type Pickup,
} from './pickups'
import { Identity, Net } from './nostr'
import {
  KIND_CLAIM,
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
import { DEFAULT_MODIFIER, type Modifier, modifierForBlock } from './modifiers'
import { type PlayOpts, type Sound, type SoundSink, silence } from './audio'

const TICK_MS = 100 // 10Hz state broadcast
/** Half-angle of a Scattershot fan, radians. Wide enough to matter up close. */
const SCATTER_SPREAD = 0.16
/** The most damage one shell may claim, however the event was written. */
const MAX_HULL = 3
/** Kills in a row that earn a full repair. */
const STREAK_REPAIR = 3
/** Kills in a row that earn rapid fire, and a glow so everyone can see it. */
const STREAK_RAPID = 5
/** How long the streak reward's rapid fire lasts. */
const STREAK_RAPID_MS = 14_000
/** How long the podium sits between rounds. */
export const INTERMISSION_MS = 9_000
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
  /** Their kills in a row, from the state tick, so their glow is visible here too. */
  streak: number
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

/** A finished round, kept so the podium has something to show. */
export interface Standing {
  name: string
  kills: number
  deaths: number
  color: number
  you: boolean
  /** Real npub, so the scoreboard can put a face to it. Null until attested. */
  pubkey: string | null
}

export interface RoundResult {
  height: number
  layout: string
  /** The rules that round played under, banked before the next block changes them. */
  modifier: string
  standings: Standing[]
  endedAt: number
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
  /** Consecutive kills without dying. Resets on death, drives the repair. */
  streak = 0
  bestStreak = 0
  /** The block this round belongs to. 0 until the chain tip arrives. */
  round = 0
  /** The tip's hash, which seeds the pickup schedule. */
  roundHash = ''
  /** performance.now() when this round started, for the pickup clock. */
  roundStartedAt = performance.now()
  /** Pickups currently on the board, by id. Derived, never received. */
  readonly pickups = new Map<string, Pickup>()
  /** Timed effects on our own tank. */
  readonly buffs: Buffs = noBuffs()
  /** A big centre-screen message. The HUD clears it after a couple of seconds. */
  notice: { text: string; sub: string; hue: number; at: number } | null = null
  /** Set when a block lands; the podium is up until it clears. */
  lastRound: RoundResult | null = null
  intermissionUntil = 0
  /** Our own hue after spreading. Always gets first pick, so it never moves. */
  displayColor: number
  /** Set when a relay subscription has produced at least one event. */
  sawTraffic = false
  /**
   * The rule change this block is playing under, derived from the same hash
   * that picks the map. Nothing is announced and nobody agrees to it — every
   * client computes it from the tip.
   */
  modifier: Modifier = DEFAULT_MODIFIER
  /**
   * Where sound comes out. A no-op by default, so nothing in the netcode or
   * the simulation depends on audio existing — the smoke test runs the whole
   * match through the default sink without an AudioContext anywhere.
   */
  sfx: SoundSink = silence

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
      hp: DEFAULT_MODIFIER.maxHp,
      dead: false,
      respawnAt: 0,
      reloadAt: 0,
    }
  }

  /** Subscribe to the room and publish the session attestation. */
  async start(): Promise<void> {
    const since = Math.floor(Date.now() / 1000) - 30
    const filter: Filter = {
      // KIND_CLAIM is stored rather than ephemeral, so `since` genuinely
      // backfills it for a client that just connected — which is the entire
      // reason it is not on an ephemeral kind like everything else here.
      kinds: [KIND_SESSION, KIND_STATE, KIND_SHELL, KIND_DEATH, KIND_CLAIM],
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
      case KIND_CLAIM:
        return this.onClaim(e)
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
        view: { x: ARENA_W / 2, y: ARENA_H / 2, hull: 0, gun: 0, hp: this.maxHp, dead: false },
        kills: 0,
        deaths: 0,
        streak: 0,
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
      hp: typeof p.hp === 'number' ? p.hp : this.maxHp,
      dead: !!p.d,
    }
    // Cosmetic and self-reported, exactly like the HP beside it. A streak you
    // cannot see on the tank that has it is a number in somebody else's HUD.
    peer.streak = typeof p.k === 'number' && p.k > 0 ? Math.min(99, Math.floor(p.k)) : 0
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

    const bounces = typeof p.b === 'number' && p.b >= 0 ? Math.min(8, Math.floor(p.b)) : 1
    // Capped rather than trusted. Damage is the one number a shooter sends that
    // the victim then applies to itself, so it gets a ceiling: a malformed or
    // hostile event can take a full hull off, and no more than that.
    const damage =
      typeof p.d === 'number' && p.d >= 1 ? Math.min(MAX_HULL, Math.floor(p.d)) : 1
    const shell = spawnShell(p.id, e.pubkey, p.x, p.y, p.a, bounces, damage)
    this.sound('fire', { at: { x: p.x, y: p.y } })
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

    victim.streak = 0
    this.sound('death', { at: { x: p.x, y: p.y } })
    if (p.k === this.identity.sessionPubkey) {
      this.kills++
      this.sound('kill')
      this.onOwnKill()
    } else if (p.k) {
      const killer = this.peers.get(p.k)
      if (killer) killer.kills++
    }

    this.pushFeed(
      killerName ? `${killerName} killed ${victim.name}` : `${victim.name} self-destructed`,
    )
  }

  /**
   * A kill we were credited with.
   *
   * The repair is deliberately self-authoritative: our own HP is the one number
   * this client is already allowed to decide, so a streak reward needs no new
   * trust, no new event kind and no agreement with anybody. It rides out in the
   * next state tick like any other HP change, and a cheater who hands themselves
   * hull points was already able to do exactly that.
   */
  private onOwnKill(): void {
    const now = performance.now()
    this.streak++
    this.bestStreak = Math.max(this.bestStreak, this.streak)

    if (this.streak === STREAK_REPAIR) {
      this.tank.hp = this.maxHp
      this.repairedAt = now
      this.sound('streak')
      this.announce(`${STREAK_REPAIR} IN A ROW`, 'hull repaired', 130)
    } else if (this.streak === STREAK_RAPID) {
      this.sound('streak')
      this.buffs.rapidUntil = Math.max(this.buffs.rapidUntil, now) + STREAK_RAPID_MS
      this.announce(`${STREAK_RAPID} IN A ROW`, 'rapid fire — and everyone can see you', 20)
    } else if (this.streak > STREAK_RAPID) {
      this.announce(`${this.streak} IN A ROW`, 'unstoppable', 45)
    } else {
      this.pushFeed(`${this.streak} in a row`)
    }
  }

  /** A banner, and a line in the feed. Bigger than the feed alone deserves. */
  private announce(text: string, sub: string, hue: number): void {
    this.notice = { text, sub, hue, at: performance.now() }
    this.pushFeed(`${text.toLowerCase()} — ${sub}`)
  }

  /** Set when a repair lands, so the renderer can show it. */
  repairedAt = 0

  /** Hull points this round. Glass Cannon makes it 1. */
  get maxHp(): number {
    return this.modifier.maxHp
  }

  /** Sound that happened somewhere on the board, attenuated from our own tank. */
  private sound(name: Sound, opts: PlayOpts = {}): void {
    this.sfx(name, opts.at ? { ...opts, ear: { x: this.tank.x, y: this.tank.y } } : opts)
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
      const boost = (hasBuff(this.buffs, 'speedUntil', now) ? 1.45 : 1) * this.modifier.speed
      stepTank(this.tank, controls.throttle, controls.steer, controls.aim, dt, boost)
      if (controls.fire && now >= this.tank.reloadAt) this.fire(now)
      this.sweepPickups(now)
    }
    this.refreshPickups(now)

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
      // A shield eats the shot and is spent. Same authority as HP: our own
      // tank decides what happened to it, and the result rides out in the next
      // state tick like any other change.
      if (hasBuff(this.buffs, 'shieldUntil', performance.now())) {
        this.buffs.shieldUntil = 0
        this.sound('shield')
        this.announce('SHIELD BROKE', 'that one was free', 200)
        return
      }
      this.tank.hp -= shell.damage
      if (this.tank.hp > 0) this.sound('hit')
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

  /**
   * Pull the trigger.
   *
   * Scattershot makes this three shells rather than one, which means three fire
   * events instead of one — and that is the reason it is a 14-second pickup and
   * not a permanent weapon. A shot is roughly one event a second per player; a
   * position tick is ten. Tripling the rarer of the two for a quarter of a
   * minute is a rounding error against the tick stream, and worth checking
   * before adding anything that multiplies events.
   */
  private fire(now: number): void {
    const rapid = hasBuff(this.buffs, 'rapidUntil', now) ? 0.42 : 1
    this.tank.reloadAt = now + RELOAD * 1000 * rapid * this.modifier.reload
    const bounces = this.modifier.bounces
    const damage = hasBuff(this.buffs, 'siegeUntil', now) ? 2 : 1
    const spread = hasBuff(this.buffs, 'scatterUntil', now) ? [-SCATTER_SPREAD, 0, SCATTER_SPREAD] : [0]
    for (const offset of spread) {
      const angle = this.tank.gun + offset
      const x = this.tank.x + Math.cos(angle) * MUZZLE_OFFSET
      const y = this.tank.y + Math.sin(angle) * MUZZLE_OFFSET
      const shell = spawnShell(randomId(), this.identity.sessionPubkey, x, y, angle, bounces, damage)
      this.shells.set(shell.id, shell)
      // Bounce budget and damage go out with the shell rather than being looked
      // up on arrival: one so a shell outlives a block boundary under the rules
      // it was fired under, the other because the victim applies the damage and
      // cannot see the shooter's buffs.
      const payload: ShellPayload = { id: shell.id, t0: now, x, y, a: angle, b: bounces, d: damage }
      this.publishAsSession(KIND_SHELL, payload)
    }
    this.sound('fire')
  }

  private die(killer: string | null): void {
    this.tank.dead = true
    this.tank.hp = 0
    this.streak = 0
    clearBuffs(this.buffs)
    this.tank.respawnAt = performance.now() + RESPAWN_DELAY * 1000 * this.modifier.respawn
    this.deaths++
    this.sound('death')
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
    this.tank.hp = this.maxHp
    this.tank.dead = false
    this.sound('respawn')
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
      ...(this.streak > 0 ? { k: this.streak } : {}),
    }
    this.publishAsSession(KIND_STATE, payload)
  }

  /**
   * A block landed: bank the round and start the next one.
   *
   * Everything resets except who is in the room. Nobody sends a "round over"
   * message and nobody is the host — every client is watching the same chain
   * tip, so they all do this within a few seconds of each other. That is the
   * whole reason the block is the clock.
   */
  /** A new block: reset the round clock and the derived pickup schedule. */
  beginRound(height: number, hash: string): void {
    this.round = height
    this.roundHash = hash
    this.roundStartedAt = performance.now()
    this.pickups.clear()
    this.modifier = modifierForBlock(hash)
    // Glass Cannon narrows the hull; a tank carrying three points into a
    // one-hit round would be invincible for two shots and nobody would know
    // why. Coming the other way, a full hull is the fair read of "new round".
    this.tank.hp = this.tank.dead ? 0 : this.maxHp
    if (this.modifier.id !== 'standard') {
      this.pushFeed(`${this.modifier.name.toLowerCase()} — ${this.modifier.blurb.toLowerCase()}`)
    }
  }

  endRound(height: number, layoutName: string): RoundResult {
    const result: RoundResult = {
      height: this.round || height - 1,
      layout: layoutName,
      modifier: this.modifier.name,
      standings: this.scoreboard(),
      endedAt: Date.now(),
    }
    this.lastRound = result
    this.intermissionUntil = performance.now() + INTERMISSION_MS
    this.round = height
    this.kills = 0
    this.deaths = 0
    this.streak = 0
    this.bestStreak = 0
    clearBuffs(this.buffs)
    // Peer tallies are ours to keep, not theirs to send, so they reset here too.
    for (const peer of this.peers.values()) {
      peer.kills = 0
      peer.deaths = 0
      peer.streak = 0
    }
    this.sound('block')
    this.pushFeed(`block ${height} — new round on ${layoutName}`)
    return result
  }

  // ---------------------------------------------------------------- pickups

  /**
   * Rebuild the set of live pickups from the round clock.
   *
   * Derived every frame rather than stored, because "derived" is what makes it
   * agree across clients with nothing on the wire. `taken` is the only piece of
   * state that is not a function of the block hash, and it is carried forward
   * across rebuilds so a claimed pad stays empty until the next wave.
   */
  private refreshPickups(now: number): void {
    if (!this.roundHash) return
    const elapsed = (now - this.roundStartedAt) / 1000
    const want = scheduleFor(this.roundHash, elapsed, {
      waveSeconds: this.modifier.waveSeconds,
      emptyPads: this.modifier.emptyPads,
    })
    const wanted = new Set(want.map((p) => p.id))

    for (const id of [...this.pickups.keys()]) {
      if (!wanted.has(id)) this.pickups.delete(id)
    }
    for (const pickup of want) {
      const existing = this.pickups.get(pickup.id)
      if (existing) continue
      this.pickups.set(pickup.id, pickup)
    }
  }

  /** Anything we are standing on, taken immediately and announced afterwards. */
  private sweepPickups(now: number): void {
    for (const pickup of this.pickups.values()) {
      if (pickup.taken) continue
      const dx = pickup.at.x - this.tank.x
      const dy = pickup.at.y - this.tank.y
      if (dx * dx + dy * dy > PICKUP_RADIUS * PICKUP_RADIUS) continue

      pickup.taken = true
      const spec = PICKUPS[pickup.kind]
      if (pickup.kind === 'repair') {
        this.tank.hp = this.maxHp
        this.repairedAt = now
      } else {
        applyPickup(this.buffs, pickup.kind, now)
      }
      this.sound('pickup')
      this.announce(
        spec.label.toUpperCase(),
        pickup.kind === 'repair' ? spec.blurb : `${spec.blurb} — ${spec.seconds}s`,
        spec.hue,
      )
      this.publishClaim(pickup)
    }
  }

  /**
   * Tell the room a pad is gone.
   *
   * Stored, not ephemeral, and that is the whole point: an ephemeral claim
   * never reaches a client that connected a moment later and cannot be asked
   * for afterwards, so late joiners would see pickups that are not there. The
   * NIP-40 `expiration` keeps the relay from holding game litter — the pad is
   * meaningless two minutes after the wave that made it.
   *
   * The `d` tag names the claimant as well as the pickup, so two claims on the
   * same pad coexist instead of one replacing the other. A relay that kept only
   * the last one would be quietly deciding who won.
   */
  private publishClaim(pickup: Pickup): void {
    const payload: ClaimPayload = { p: pickup.id, kind: pickup.kind }
    this.net.publish(
      this.identity.signAsSession({
        kind: KIND_CLAIM,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', claimTag(pickup.id, this.identity.sessionPubkey)],
          ['t', roomTag(this.room)],
          ['expiration', String(Math.floor(Date.now() / 1000) + 120)],
        ],
        content: JSON.stringify(payload),
      }),
    )
  }

  private onClaim(e: Event): void {
    if (e.pubkey === this.identity.sessionPubkey) return
    const p = parsePayload<ClaimPayload>(e.content)
    if (!p || typeof p.p !== 'string') return
    const pickup = this.pickups.get(p.p)
    if (!pickup || pickup.taken) return
    pickup.taken = true
    const who = this.peers.get(e.pubkey)?.name ?? 'someone'
    this.pushFeed(`${who} took ${PICKUPS[pickup.kind]?.label ?? 'a pickup'}`)
  }

  /** True while the podium is up. */
  get intermission(): boolean {
    return performance.now() < this.intermissionUntil
  }

  scoreboard(): Standing[] {
    const rows: Standing[] = [
      {
        name: this.name,
        kills: this.kills,
        deaths: this.deaths,
        color: this.displayColor,
        you: true,
        pubkey: this.identity.pubkey,
      },
      ...[...this.peers.values()].map((p) => ({
        name: p.name,
        kills: p.kills,
        deaths: p.deaths,
        color: p.displayColor,
        you: false,
        pubkey: p.pubkey,
      })),
    ]
    return rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths)
  }

  dispose(): void {
    this.disposed = true
    this.net.close()
  }
}
