import './style.css'
import { layoutForBlock, layoutName, setLayout } from './arena'
import { Sfx } from './audio'
import { BlockClock } from './blocks'
import { Game } from './game'
import { Input, PLAYER_TWO, SOLO, type Scheme } from './input'

import { DEFAULT_RELAYS, Identity, Net } from './nostr'
import { Renderer } from './render'
import type { ClockDirection } from './nostr'
import { modifierForBlock } from './modifiers'
import { type Buffs, PICKUPS, type PickupKind } from './pickups'
import { type Profile, Profiles, shortNpub } from './profiles'
import { fetchBlockScores, fetchScores, publishScore } from './scores'

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing #${id}`)
  return el as T
}

const canvas = $<HTMLCanvasElement>('stage')
const lobby = $('lobby')
const hud = $('hud')
const board = $('board')
const nameInput = $<HTMLInputElement>('name')
const roomInput = $<HTMLInputElement>('room')
const relayInput = $<HTMLTextAreaElement>('relays')
const schemeInput = $<HTMLSelectElement>('scheme')
const soundInput = $<HTMLSelectElement>('sound')
const playersInput = $<HTMLSelectElement>('players')
const lobbyError = $('lobby-error')

const params = new URLSearchParams(location.search)
const stored = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const store = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* private mode, not worth failing over */
  }
}

nameInput.value = stored('tank.name') ?? ''
roomInput.value = params.get('room') ?? stored('tank.room') ?? 'lobby'
relayInput.value = (stored('tank.relays') ?? DEFAULT_RELAYS.join('\n')).trim()
schemeInput.value = stored('tank.scheme') === 'tank' ? 'tank' : 'direct'
playersInput.value = stored('tank.players') === '2' ? '2' : '1'

/**
 * One AudioContext for the page, built on the first real click.
 *
 * Browsers refuse to start audio before a gesture and leave an early context
 * `suspended` for good, so this is created from the lobby button rather than at
 * module load — and `M` toggles it mid-match, because a shooter you cannot mute
 * is a shooter people close the tab on.
 */
const sfx = new Sfx()
soundInput.value = sfx.muted ? 'off' : 'on'

function paintSoundButton(): void {
  $('sound-toggle').textContent = sfx.muted ? 'Sound: off' : 'Sound: on'
}
paintSoundButton()

$('sound-toggle').addEventListener('click', () => {
  sfx.toggle()
  soundInput.value = sfx.muted ? 'off' : 'on'
  paintSoundButton()
})

window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyM' || e.repeat) return
  const target = e.target as HTMLElement | null
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
  sfx.toggle()
  soundInput.value = sfx.muted ? 'off' : 'on'
  paintSoundButton()
})

function readRelays(): string[] {
  const list = relayInput.value
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('ws://') || s.startsWith('wss://'))
  return list.length ? list : DEFAULT_RELAYS
}

function fail(message: string): void {
  lobbyError.textContent = message
  lobbyError.hidden = false
}

$('play-nip07').addEventListener('click', () => {
  void begin(async () => {
    if (!window.nostr) {
      throw new Error(
        'No NIP-07 signer found. Install Alby or nos2x, or hit "Play as guest" instead.',
      )
    }
    return Identity.fromExtension()
  })
})

$('play-guest').addEventListener('click', () => {
  void begin(async () => Identity.guest())
})

/** One human. Two of these is the whole of local two-player. */
interface Player {
  game: Game
  input: Input
}

let running: {
  /** Player one is always `players[0]`, and owns the mouse, the HUD and the ear. */
  players: Player[]
  renderer: Renderer
  clock: BlockClock
  profiles: Profiles
} | null = null

/**
 * An avatar, or the coloured initial that stands in for one.
 *
 * `onerror` matters more than it looks: profile pictures are arbitrary URLs on
 * arbitrary hosts and a good share of them are dead. A broken image icon in
 * four scoreboard rows looks like the game is broken, so a failed load falls
 * back to the same initial that was there before it tried.
 */
function avatar(profile: Profile | null, name: string, hue: number, size = 22): string {
  const initial = escapeHtml((name.trim()[0] ?? '?').toUpperCase())
  const fallback = `<span class="avatar fallback" style="--av:${size}px;background:hsl(${hue} 45% 32%)">${initial}</span>`
  if (!profile?.picture) return fallback
  return (
    `<img class="avatar" style="--av:${size}px" src="${escapeHtml(profile.picture)}" alt="" ` +
    `loading="lazy" onerror="this.outerHTML=${escapeHtml(JSON.stringify(fallback))}" />`
  )
}

/** The NIP-05, with its tick only if the domain actually vouched for the key. */
function nip05Badge(profile: Profile | null): string {
  if (!profile?.nip05) return ''
  const cls = profile.nip05Verified === true ? 'nip05 ok' : 'nip05'
  const mark = profile.nip05Verified === true ? ' ✓' : ''
  const title =
    profile.nip05Verified === true
      ? 'NIP-05 checked against the domain'
      : profile.nip05Verified === false
        ? 'The domain does not map this name to this key'
        : 'Not checked — the domain did not answer'
  const bad = profile.nip05Verified === false ? ' bad' : ''
  return `<span class="${cls}${bad}" title="${escapeHtml(title)}">${escapeHtml(profile.nip05)}${mark}</span>`
}

async function begin(makeIdentity: () => Promise<Identity>): Promise<void> {
  lobbyError.hidden = true
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('.row button')]
  buttons.forEach((b) => (b.disabled = true))
  try {
    const identity = await makeIdentity()
    const room = (roomInput.value.trim() || 'lobby').toLowerCase().replace(/[^a-z0-9-]/g, '')
    const name = (nameInput.value.trim() || `tank-${identity.pubkey.slice(0, 4)}`).slice(0, 16)
    const relays = readRelays()

    store('tank.name', name)
    store('tank.room', room)
    store('tank.relays', relays.join('\n'))

    // Hue seeded from the real pubkey. Game.spreadColors() snaps it to a
    // palette slot and resolves clashes with whoever else is in the room.
    const color = parseInt(identity.pubkey.slice(0, 4), 16) % 360

    // This runs inside the click handler, which is the only place a browser
    // will let an AudioContext start.
    if (soundInput.value === 'off' && !sfx.muted) sfx.toggle()
    if (soundInput.value === 'on' && sfx.muted) sfx.toggle()
    sfx.unlock()
    paintSoundButton()

    // Built before anything that needs to read it: both games take their pickup
    // anchor from it, and player two is constructed before the old position of
    // this line.
    const clock = new BlockClock(params.get('blocks'))

    const twoPlayer = playersInput.value === '2'
    store('tank.players', twoPlayer ? '2' : '1')

    const net = new Net(relays)
    const profiles = new Profiles(net)
    const game = new Game(identity, net, room, name, color)
    // Only player one has an ear. Two local players share one set of speakers,
    // and every event player two publishes is already heard here as a peer —
    // positioned, through the same code a remote player's shot goes through. A
    // second sink would play the same shot twice.
    game.sfx = (sound, opts) => sfx.play(sound, opts)
    await game.start()

    const players: Player[] = [{ game, input: new Input(canvas, { ...SOLO }) }]

    if (twoPlayer) {
      // A throwaway key, deliberately. Player two is a real npub in the room
      // with their own signed events and their own leaderboard entry — the only
      // thing they share with player one is the socket and the screen. Asking a
      // second person to produce a NIP-07 signer to play on a couch is how a
      // couch mode does not get used.
      const second = await Identity.guest()
      // A second `Net`, not a shared one, and this is not a detail.
      //
      // Sharing was the obvious choice — one pool, one socket per relay, less
      // of everything. cowboy found what it costs: every failure counter in
      // `Net` is keyed by URL and written when one player is the only publisher
      // on it. `strikes` resets on any success, so a relay refusing *player
      // two's key* and accepting player one's never accumulates fifteen in a
      // row and never mutes. Player two's `restricted:` reason lands in
      // `trouble` and player one's next success wipes it. `rejected` climbs and
      // cannot say whose.
      //
      // And the local mirror is what makes that invisible rather than obvious.
      // Without it, a fully-rejected player two is a tank player one cannot see
      // either — noticed in a second on the couch. With it, both people see a
      // perfectly correct room while the rest of the world sees one tank where
      // there should be two, and nobody in the room has any way to find out.
      //
      // Two sockets also mean two per-connection budgets, which is the other
      // half of the same argument: newlay allocates its token bucket and its
      // behaviour score per connection, so on one socket the two players share
      // a throttle and one player's rejections decay the other's rate.
      //
      // It costs a second subscription and double inbound. Worth it.
      const secondNet = new Net(relays)
      const p2 = new Game(second, secondNet, room, `${name}-2`, (color + 137) % 360)
      p2.chainClock = () => ({ seconds: clock.chainSeconds(), pending: clock.chainPending })
      await p2.start()
      // Each is an ordinary peer of the other, through the same signed events —
      // just delivered without the round trip. See `Game.localMirror`.
      game.localMirror.push(p2)
      p2.localMirror.push(game)
      players.push({ game: p2, input: new Input(canvas, { ...PLAYER_TWO }) })
      // Player one gives up the arrow keys and the roaming pad claim: with two
      // people at one keyboard, "either half drives me" is the same collision
      // as "any pad drives me".
      players[0].input.binding.keys = 'wasd'
      players[0].input.binding.pad = 0
    }

    // The round clock. Starting it before the first frame means the board is
    // already the right one for the current block by the time anybody drives.
    // The pickup schedule reads its clock from the chain, not from when this
    // client happened to poll. The wave index ends up inside the pickup id, so
    // a local origin means two clients compute different ids for the same pad
    // and every claim between them is discarded without a word.
    game.chainClock = () => ({ seconds: clock.chainSeconds(), pending: clock.chainPending })
    clock.onBlock((tip, previous) => {
      setLayout(layoutForBlock(tip.hash))
      if (!previous) {
        // First tip of the session — this is the round we joined, not a new one.
        for (const p of players) p.game.beginRound(tip.height, tip.hash)
        return
      }
      // Every local player banks their own round; only player one's podium is
      // shown, because there is one screen.
      let shown: ReturnType<Game['endRound']> | null = null
      for (const p of players) {
        const result = p.game.endRound(tip.height, layoutName)
        if (!shown) shown = result
        p.game.beginRound(tip.height, tip.hash)
      }
      if (shown) showPodium(shown)
    })
    void clock.start()

    // The board is WebGL now. A browser that cannot give us a context needs to
    // hear that in words, not as "Error creating WebGL context" from a library
    // it has never heard of.
    let renderer: Renderer
    try {
      renderer = new Renderer(canvas)
    } catch (err) {
      for (const p of players) p.game.dispose()
      throw new Error(
        'This browser could not open a WebGL context, so the 3D board cannot draw. ' +
          'Check that hardware acceleration is on, or try another browser. ' +
          (err instanceof Error ? `(${err.message})` : ''),
      )
    }
    const scheme = schemeInput.value as Scheme
    for (const p of players) p.input.scheme = scheme
    store('tank.scheme', scheme)
    running = { players, renderer, clock, profiles }
    $('hint-p2').hidden = !twoPlayer
    // A profile landing has to repaint immediately: the HUD throttles itself to
    // eight frames a second and would otherwise show the npub for another beat
    // after the picture was already in hand.
    profiles.onChange(() => {
      hudAt = 0
    })
    // Exposed on purpose: the two-player smoke test in test/ drives the match
    // through this handle, and it is genuinely useful in the console.
    ;(window as unknown as { __game: Game; __renderer: Renderer }).__game = game
    ;(window as unknown as { __renderer: Renderer }).__renderer = renderer
    ;(window as unknown as { __clock: BlockClock }).__clock = clock
    ;(window as unknown as { __sfx: Sfx }).__sfx = sfx
    ;(window as unknown as { __profiles: Profiles }).__profiles = profiles
    ;(window as unknown as { __players: Player[] }).__players = players

    canvas.addEventListener('mousemove', (e) => {
      const world = renderer.toWorld(e.clientX, e.clientY)
      for (const p of players) if (p.input.binding.mouse) p.input.mouseWorld = world
    })

    const url = new URL(location.href)
    url.searchParams.set('room', room)
    history.replaceState(null, '', url)

    lobby.hidden = true
    hud.hidden = false
    loop()
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  } finally {
    buttons.forEach((b) => (b.disabled = false))
  }
}

// ------------------------------------------------------------------- loop

let last = 0

function loop(now = performance.now()): void {
  if (!running) return
  requestAnimationFrame(loop)
  // Clamp so a backgrounded tab does not teleport everything on return.
  const dt = Math.min(0.05, last ? (now - last) / 1000 : 0)
  last = now

  const { players, renderer } = running
  // Every local player steps in the same frame, before anything is drawn.
  // Player two's events reach player one's game inside `update` — see
  // `Game.localMirror` — so drawing after both have stepped is what makes the
  // couch latency actually zero rather than one frame.
  for (const p of players) p.game.update(dt, p.input.read(p.game.tank))
  const local = new Set(players.map((p) => p.game.identity.sessionPubkey))
  renderer.draw(players[0].game, local)
  drawHud(players[0].game)
  drawSecondPlayer(players[1] ?? null, now)
}

let hudAt = 0

/** Which buff timer each pickup runs. `repair` is instant and has none. */
const BUFF_TIMERS: Partial<Record<PickupKind, keyof Buffs>> = {
  rapid: 'rapidUntil',
  shield: 'shieldUntil',
  speed: 'speedUntil',
  scatter: 'scatterUntil',
  siege: 'siegeUntil',
}

function drawHud(game: Game): void {
  const now = performance.now()
  if (now - hudAt < 120) return
  hudAt = now

  // The scoreboard is a card per player now: their kind 0 picture, the callsign
  // they chose for the match, and their verified NIP-05 underneath it. A guest
  // key has no profile to fetch and falls back to a coloured initial, which is
  // the point — playing without an identity stays a first-class option.
  const profiles = running?.profiles
  $('scoreboard').innerHTML = game
    .scoreboard()
    .map((r) => {
      const profile = r.pubkey ? (profiles?.get(r.pubkey) ?? null) : null
      const badge = nip05Badge(profile)
      const real = profile && r.pubkey && profile.name !== shortNpub(r.pubkey) ? profile.name : ''
      return `<div class="score-row card${r.you ? ' you' : ''}">
           <span class="who">${avatar(profile, r.name, r.color)}
           <span class="ident"><span class="name" style="color:hsl(${r.color} 70% 70%)">${escapeHtml(r.name)}</span>
           ${badge || (real ? `<span class="nip05">${escapeHtml(real)}</span>` : '')}</span></span>
           <span class="kd">${r.kills} / ${r.deaths}</span>
         </div>`
    })
    .join('')

  drawRules(game)
  drawClockAlarm()

  const others = game.peers.size
  const clock = running?.clock
  // The relay line earns its place: a rate-limited publish used to be silent,
  // and silent dropped ticks look exactly like a peer with a bad connection.
  // Every local player's uplink, not just player one's. With a `Net` each, a
  // relay that refuses only player two says so on player two's counters — and
  // reading only the first would put the whole point of splitting them back in
  // the dark.
  const trouble = (running?.players ?? [])
    .map((p, i) => {
      const line = p.game.net.troubleSummary()
      return line ? (i === 0 ? line : `P${i + 1}: ${line}`) : ''
    })
    .filter(Boolean)
    .join(' · ')
  $('status').innerHTML = [
    clock?.tip
      ? `block <b>${clock.tip.height}</b> ${blockClock(clock)}`
      : clock?.reachable === false
        ? 'block <b>?</b>'
        : 'block <b>…</b>',
    `map <b id="hud-map">${escapeHtml(layoutName)}</b>`,
    `rules <b id="hud-rules">${escapeHtml(game.modifier.name)}</b>`,
    `room <b>${escapeHtml(game.room)}</b>`,
    `${others} opponent${others === 1 ? '' : 's'}`,
    game.streak >= 2 ? `<b>${game.streak} in a row</b>` : '',
    game.identity.isGuest ? 'guest key' : escapeHtml(game.identity.npub.slice(0, 16) + '…'),
    trouble
      ? `<span class="bad">${escapeHtml(trouble)}</span>`
      : `${game.net.relays.length} relays${(running?.players.length ?? 1) > 1 ? ' ×2' : ''}`,
  ]
    .filter(Boolean)
    .join('<br>')

  $('feed').innerHTML = game.feed
    .map((f) => `<div>${escapeHtml(f.text)}</div>`)
    .join('')

  drawNotice(game, now)
  drawBuffs(game, now)
}

/**
 * Time since the tip was mined, counting up.
 *
 * There is no countdown to show, and that is the honest thing about mining:
 * the next block is a coin flip every second, not a timer running out. So this
 * counts up. Past ten minutes — the average, not a deadline — it goes amber,
 * which is the game saying "this could end on any tick" rather than "something
 * is wrong".
 *
 * When the explorer would not give a timestamp it counts from when this client
 * first saw the block instead, and says so with a `~`. That is a lower bound
 * rather than a guess dressed up as a fact.
 */
function blockClock(clock: BlockClock): string {
  const seconds = clock.secondsSinceTip()
  if (seconds === null) return ''
  const mm = Math.floor(seconds / 60)
  const ss = Math.floor(seconds % 60)
  const text = `${clock.tipTimeKnown ? '' : '~'}${mm}:${String(ss).padStart(2, '0')}`
  return `<span class="clock${seconds >= 600 ? ' due' : ''}">${text}</span>`
}

/**
 * "Your clock is wrong", when every relay says so.
 *
 * This is the only failure in the whole game a player can go and fix, which is
 * why it gets the middle of the screen and does not time out. Everything else
 * the HUD warns about is somebody else's machine — a relay refusing, a peer
 * dropping — and the honest response to those is to keep playing.
 *
 * The relay's own words are quoted rather than paraphrased. `created_at too far
 * in the future (window 900000 ms)` is a sentence a player can act on; "network
 * error" is not, and inventing a friendlier version would throw away the only
 * part with a number in it.
 *
 * Every local player's uplink is checked. Two players on one machine share a
 * clock by definition, so either alarm is the same alarm — but reading only
 * player one's would miss it entirely if player two happened to publish first.
 */
function drawClockAlarm(): void {
  const node = $('alarm')
  const players = running?.players ?? []
  // The loud one first: a quorum of relays refusing our events outright on a
  // timestamp reason. That covers a fast clock either way, and a slow clock on
  // any relay whose tolerance for an *old* event is tighter than our own claim
  // deadline — which is the common case, because the four relays this game
  // ships with give an ephemeral event sixty seconds.
  const fast = players.map((p) => p.game.net.clockAlarm).find((a) => a !== null)
  // And the quiet one, which `Net` structurally cannot see. Where the relay's
  // tolerance for an old event is *looser* than our claim's deadline, the only
  // thing that dies is the claim — every tick lands, ten a second, resetting
  // any streak `Net` might have built. The game looks perfectly normal and
  // every pickup comes straight back.
  const slow = fast ? null : players.map((p) => p.game.slowClockAlarm).find((a) => a != null)

  if (!fast && !slow) {
    node.hidden = true
    return
  }
  node.hidden = false
  if (fast) {
    node.innerHTML =
      `<b>THIS MACHINE'S CLOCK IS ${fast.direction === 'ahead' ? 'AHEAD' : 'BEHIND'}</b>` +
      `<span>${clockAdvice(fast.direction, fast.reason, fast.agreed)}</span>` +
      `<code>${escapeHtml(fast.reason)}</code>`
    return
  }
  // The number here is ours rather than the relay's, and it is a *lower bound*
  // that the signal's own precondition establishes: a claim only outlives its
  // deadline if we are behind by more than that deadline, and the ticks landing
  // prove the relay would have taken it otherwise. Said as "more than", because
  // that is exactly what is known — it could be an hour.
  const minutes = Math.round(slow!.behindBySeconds / 60)
  node.innerHTML =
    `<b>THIS MACHINE'S CLOCK IS BEHIND</b>` +
    `<span>By more than ${minutes} minutes. The game plays fine, ` +
    `but <b>every pickup you take comes straight back</b> — the relays drop the claim as ` +
    `already expired before anyone else hears it. Set the clock, or turn on automatic ` +
    `time, and this will clear itself.</span>` +
    `<code>${escapeHtml(slow!.reason)}</code>`
}

/**
 * Turn a quorum of rejections into something a person can act on.
 *
 * Which *way* the clock is wrong is the first thing somebody needs, and the
 * direction is **counted rather than read**. This used to regex the reason for
 * "future" or "expired" — and three of the four relays this game actually ships
 * with say `created_at too late`, which contains neither. The branch worked in
 * the suite, was broken in both directions to prove it, and never once ran in
 * production, because the suite spoke a different relay's dialect. `Net` decides
 * direction by counting distinct relays that named the timestamp, so a wording
 * nobody anticipated cannot silence it.
 *
 * The window is quoted when a relay gives one, and it is worth knowing why that
 * number can be trusted where it appears: `created_at_msecs_ahead` is one of the
 * fields a relay's behaviour scaling never touches. Most relays give no number
 * at all, so the sentence has to work without it.
 */
function clockAdvice(direction: ClockDirection, reason: string, agreed: number): string {
  // The direction comes from `Net`, which decided it by counting relays rather
  // than by reading words off one string. That distinction is not cosmetic: this
  // used to regex the reason for "future" or "expired", and three of the four
  // relays this game actually ships with say `created_at too late`, which
  // contains neither. The branch worked in the suite and never once ran in
  // production.
  const window = reason.match(/window (\d+) ms/)
  const by = window ? ` by more than ${Math.round(Number(window[1]) / 60_000)} minutes` : ''
  const which =
    direction === 'ahead'
      ? `the clock here is <b>ahead</b>${by}`
      : 'the clock here is <b>behind</b> — our events arrive already out of date'
  return (
    `${agreed} relays agree: ${which}. ` +
    'Nothing you do in the game will fix it — set the clock, or turn on automatic time, ' +
    'and this will clear itself.'
  )
}

/**
 * The round's rule change, parked under the scoreboard for the whole round.
 *
 * It is not a banner, because it is not an event — it is a fact about the block
 * you are playing in, and someone who joins ninety seconds late needs to see it
 * as much as the person who was there when it landed. Straight Deathmatch shows
 * nothing at all: the default needs no billboard.
 */
function drawRules(game: Game): void {
  const node = $('rules')
  const mod = game.modifier
  if (mod.id === 'standard') {
    node.hidden = true
    return
  }
  node.hidden = false
  node.style.setProperty('--rules-hue', String(mod.hue))
  node.innerHTML = `<b>${escapeHtml(mod.name)}</b><span>${escapeHtml(mod.blurb)}</span>`
}

/**
 * The banner.
 *
 * A streak or a pickup landing in a six-line feed at the bottom of the screen
 * is something you read afterwards, not something you notice. This is the same
 * information where your eyes already are.
 */
function drawNotice(game: Game, now: number): void {
  const node = $('notice')
  const notice = game.notice
  if (!notice || now - notice.at > 2200) {
    node.hidden = true
    return
  }
  const age = (now - notice.at) / 2200
  node.hidden = false
  node.style.opacity = String(age > 0.7 ? 1 - (age - 0.7) / 0.3 : 1)
  node.style.setProperty('--notice-hue', String(notice.hue))
  node.innerHTML = `<b>${escapeHtml(notice.text)}</b><span>${escapeHtml(notice.sub)}</span>`
}

/**
 * Player two's panel.
 *
 * One screen, so player two does not get a second HUD — they get the numbers
 * that are theirs and nobody else's: hull, score, and whatever is ticking down.
 * Everything else about them is already visible. They are a peer of player one,
 * so their name sits on the scoreboard like anybody in the room, and their tank
 * carries its own pips and streak ring out on the board.
 */
function drawSecondPlayer(p2: Player | null, now: number): void {
  const node = $('p2')
  if (!p2) {
    node.hidden = true
    return
  }
  const g = p2.game
  // Player one's view of player two's colour, not player two's own. Hues are
  // spread to a palette per client, so the two can disagree — and the panel has
  // to match the tank on *this* screen or it is labelling the wrong player.
  const hue =
    running?.players[0].game.peers.get(g.identity.sessionPubkey)?.displayColor ?? g.displayColor
  const hull = Array.from(
    { length: g.maxHp },
    (_, i) =>
      `<i class="${i < g.tank.hp && !g.tank.dead ? 'on' : ''}" style="--pip:hsl(${hue} 75% 60%)"></i>`,
  ).join('')
  const timers = Object.entries(BUFF_TIMERS)
    .map(([kind, key]) => {
      const left = (g.buffs[key] - now) / 1000
      if (left <= 0) return ''
      const spec = PICKUPS[kind as PickupKind]
      return `<span class="buff" style="--buff-hue:${spec.hue}">${escapeHtml(spec.label)} <b>${left.toFixed(1)}s</b></span>`
    })
    .filter(Boolean)
    .join('')
  node.hidden = false
  node.innerHTML =
    `<div class="p2-row"><b style="color:hsl(${hue} 75% 68%)">P2</b>` +
    `<span class="pips">${hull}</span>` +
    `<span class="kd">${g.kills} / ${g.deaths}</span></div>` +
    (timers ? `<div class="p2-row">${timers}</div>` : '')
}

/**
 * Little timers for whatever is currently running on your tank.
 *
 * Driven off the pickup table rather than a hand-written list, so adding a
 * seventh pickup is one entry in `PICKUPS` and not an edit here that somebody
 * forgets — which is exactly how a buff ends up running invisibly.
 */
function drawBuffs(game: Game, now: number): void {
  const node = $('buffs')
  const live: string[] = []
  for (const [kind, spec] of Object.entries(PICKUPS) as [PickupKind, (typeof PICKUPS)[PickupKind]][]) {
    const key = BUFF_TIMERS[kind]
    if (!key) continue
    const left = (game.buffs[key] - now) / 1000
    if (left <= 0) continue
    live.push(
      `<span class="buff" style="--buff-hue:${spec.hue}">${escapeHtml(spec.label)} <b>${left.toFixed(1)}s</b></span>`,
    )
  }
  node.hidden = live.length === 0
  node.innerHTML = live.join('')
}

// ------------------------------------------------------------------ podium

let podiumTimer: ReturnType<typeof setTimeout> | null = null

function showPodium(result: import('./game').RoundResult): void {
  const panel = $('podium')
  $('podium-title').textContent = `Block ${result.height} — round over`
  const next = running?.clock.tip ? modifierForBlock(running.clock.tip.hash) : null
  $('podium-sub').textContent = `Next round is live on ${layoutName}. Drive whenever you like.`
  // The block that just closed picked the next round's rules at the same moment
  // it picked the next map, so the podium can already say what changed.
  $('podium-rules').textContent = next
    ? next.id === 'standard'
      ? `That round played ${result.modifier}. This one is a straight deathmatch.`
      : `That round played ${result.modifier}. This one is ${next.name} — ${next.blurb.toLowerCase()}`
    : `That round played ${result.modifier}.`
  $('podium-note').textContent =
    'Publishing signs a record with your npub and puts it on the relays under this block height. ' +
    'Nothing publishes itself.'

  const rows = result.standings
  $('podium-rows').innerHTML = rows.length
    ? rows
        .map(
          (r, i) =>
            `<div class="score-row${i === 0 && r.kills > 0 ? ' win' : ''}${r.you ? ' you' : ''}">
               <span class="who"><span class="rank">${i + 1}</span>
               ${avatar(r.pubkey ? (running?.profiles.get(r.pubkey) ?? null) : null, r.name, r.color, 26)}
               <span class="ident"><span class="name">${escapeHtml(r.name)}</span>
               ${nip05Badge(r.pubkey ? (running?.profiles.get(r.pubkey) ?? null) : null)}</span></span>
               <span class="kd">${r.kills} / ${r.deaths}</span>
             </div>`,
        )
        .join('')
    : '<div class="fine">Nobody scored.</div>'

  const publish = $<HTMLButtonElement>('podium-publish')
  publish.disabled = false
  publish.textContent = 'Sign and publish this round'
  publish.onclick = async () => {
    if (!running) return
    publish.disabled = true
    publish.textContent = 'Signing…'
    try {
      const me = rows.find((r) => r.you)
      await publishScore(
        running.players[0].game.identity,
        running.players[0].game.net,
        running.players[0].game.room,
        me?.kills ?? 0,
        me?.deaths ?? 0,
        result.height,
        result.layout,
        running.players[0].game.bestStreak,
      )
      publish.textContent = 'Published'
    } catch {
      publish.textContent = 'Signing failed'
      publish.disabled = false
    }
  }

  panel.hidden = false
  if (podiumTimer) clearTimeout(podiumTimer)
  // It closes itself, because the next round is already running underneath it.
  podiumTimer = setTimeout(() => (panel.hidden = true), 9000)
}

$('podium-close').addEventListener('click', () => {
  if (podiumTimer) clearTimeout(podiumTimer)
  $('podium').hidden = true
})

// -------------------------------------------------------------- controllers

/**
 * Live list of pads, on the lobby.
 *
 * There is nothing to pair here and the panel says so: a browser will not
 * reveal a gamepad until a button on it has been pressed, which is the whole
 * handshake. What the panel is actually for is answering "is this thing
 * plugged in", which is the question people are really asking when they go
 * looking for controller settings.
 */
function watchPads(): void {
  const box = $('pads')
  const tick = () => {
    const pads = [...(navigator.getGamepads?.() ?? [])].filter(Boolean) as Gamepad[]
    box.innerHTML = pads.length
      ? pads
          .map((pad) => {
            const active =
              pad.buttons.some((b) => b.pressed) || pad.axes.some((a) => Math.abs(a) > 0.3)
            return `<div class="pad"><span>${escapeHtml(pad.id.slice(0, 44))}</span>
              <span class="${active ? 'lit' : ''}">${active ? 'input ✓' : 'idle'}</span></div>`
          })
          .join('')
      : 'No gamepad detected. Plug one in and press a button — browsers hide controllers until you do.'
    requestAnimationFrame(tick)
  }
  tick()
}
watchPads()

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )

// ---------------------------------------------------------------- actions

$('copy-link').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('copy-link')
  try {
    await navigator.clipboard.writeText(location.href)
    btn.textContent = 'Copied'
  } catch {
    btn.textContent = location.href
  }
  setTimeout(() => (btn.textContent = 'Copy invite link'), 1800)
})

$('publish-score').addEventListener('click', async () => {
  if (!running) return
  const btn = $<HTMLButtonElement>('publish-score')
  const game = running.players[0].game
  btn.disabled = true
  btn.textContent = 'Signing…'
  try {
    await publishScore(
      game.identity,
      game.net,
      game.room,
      game.kills,
      game.deaths,
      running.clock.tip?.height,
      layoutName,
      game.bestStreak,
    )
    btn.textContent = 'Published'
  } catch {
    btn.textContent = 'Signing failed'
  }
  setTimeout(() => {
    btn.textContent = 'Publish score'
    btn.disabled = false
  }, 2000)
})

async function loadBoard(scope: 'block' | 'all'): Promise<void> {
  const rows = $('board-rows')
  $('board-tab-block').classList.toggle('on', scope === 'block')
  $('board-tab-all').classList.toggle('on', scope === 'all')
  rows.textContent = 'loading…'
  if (!running) return
  const height = running.clock.tip?.height
  if (scope === 'block' && !height) {
    rows.textContent = 'No block height yet — the explorer has not answered.'
    return
  }
  try {
    const scores =
      scope === 'block'
        ? await fetchBlockScores(running.players[0].game.net, height!)
        : await fetchScores(running.players[0].game.net)
    // A signed score is only worth reading if you can tell whose it is. The
    // profile fetch is fire-and-forget: rows render with the npub immediately
    // and upgrade themselves to a face and a NIP-05 when the events land.
    for (const s of scores) running?.profiles.want(s.pubkey)
    rows.innerHTML = scores.length
      ? scores
          .map((s, i) => {
            const profile = running?.profiles.get(s.pubkey) ?? null
            const hue = parseInt(s.pubkey.slice(0, 4), 16) % 360
            const badge = nip05Badge(profile)
            return `<div class="score-row"><span class="who"><span class="rank">${i + 1}</span>
                ${avatar(profile, profile?.name ?? s.npub.slice(4), hue, 26)}
                <span class="ident"><span class="name">${escapeHtml(profile?.name ?? shortNpub(s.pubkey))}</span>
                ${badge}</span></span>
                <span class="kd">${s.kills} / ${s.deaths}${
                  scope === 'all' && s.block ? ` <span class="npub">#${s.block}</span>` : ''
                }</span></div>`
          })
          .join('')
      : scope === 'block'
        ? `Nothing published for block ${height} yet. Be the first.`
        : 'No scores published yet. Be the first.'
  } catch {
    rows.textContent = 'Could not reach the relays.'
  }
}

$('show-board').addEventListener('click', () => {
  board.hidden = false
  void loadBoard(running?.clock.tip ? 'block' : 'all')
})
$('board-tab-block').addEventListener('click', () => void loadBoard('block'))
$('board-tab-all').addEventListener('click', () => void loadBoard('all'))

$('board-close').addEventListener('click', () => {
  board.hidden = true
})
