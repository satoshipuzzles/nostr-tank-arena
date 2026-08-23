import './style.css'
import { layoutForBlock, layoutName, setLayout } from './arena'
import { BlockClock } from './blocks'
import { Game } from './game'
import { Input, type Scheme } from './input'
import { DEFAULT_RELAYS, Identity, Net } from './nostr'
import { Renderer } from './render'
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

let running: { game: Game; renderer: Renderer; input: Input; clock: BlockClock } | null = null

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

    const net = new Net(relays)
    const game = new Game(identity, net, room, name, color)
    await game.start()

    // The round clock. Starting it before the first frame means the board is
    // already the right one for the current block by the time anybody drives.
    const clock = new BlockClock(params.get('blocks'))
    clock.onBlock((tip, previous) => {
      setLayout(layoutForBlock(tip.hash))
      if (!previous) {
        // First tip of the session — this is the round we joined, not a new one.
        game.beginRound(tip.height, tip.hash)
        return
      }
      const result = game.endRound(tip.height, layoutName)
      game.beginRound(tip.height, tip.hash)
      showPodium(result)
    })
    void clock.start()

    // The board is WebGL now. A browser that cannot give us a context needs to
    // hear that in words, not as "Error creating WebGL context" from a library
    // it has never heard of.
    let renderer: Renderer
    try {
      renderer = new Renderer(canvas)
    } catch (err) {
      game.dispose()
      throw new Error(
        'This browser could not open a WebGL context, so the 3D board cannot draw. ' +
          'Check that hardware acceleration is on, or try another browser. ' +
          (err instanceof Error ? `(${err.message})` : ''),
      )
    }
    const input = new Input(canvas)
    input.scheme = schemeInput.value as Scheme
    store('tank.scheme', input.scheme)
    running = { game, renderer, input, clock }
    // Exposed on purpose: the two-player smoke test in test/ drives the match
    // through this handle, and it is genuinely useful in the console.
    ;(window as unknown as { __game: Game; __renderer: Renderer }).__game = game
    ;(window as unknown as { __renderer: Renderer }).__renderer = renderer
    ;(window as unknown as { __clock: BlockClock }).__clock = clock

    canvas.addEventListener('mousemove', (e) => {
      input.mouseWorld = renderer.toWorld(e.clientX, e.clientY)
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

  const { game, renderer, input } = running
  const controls = input.read(game.tank)
  game.update(dt, controls)
  renderer.draw(game)
  drawHud(game)
}

let hudAt = 0

function drawHud(game: Game): void {
  const now = performance.now()
  if (now - hudAt < 120) return
  hudAt = now

  $('scoreboard').innerHTML = game
    .scoreboard()
    .map(
      (r) =>
        `<div class="score-row${r.you ? ' you' : ''}">
           <span class="who"><span class="swatch" style="background:hsl(${r.color} 62% 52%)"></span>
           <span class="name">${escapeHtml(r.name)}</span></span>
           <span class="kd">${r.kills} / ${r.deaths}</span>
         </div>`,
    )
    .join('')

  const others = game.peers.size
  const clock = running?.clock
  // The relay line earns its place: a rate-limited publish used to be silent,
  // and silent dropped ticks look exactly like a peer with a bad connection.
  const trouble = game.net.troubleSummary()
  $('status').innerHTML = [
    clock?.tip
      ? `block <b>${clock.tip.height}</b>`
      : clock?.reachable === false
        ? 'block <b>?</b>'
        : 'block <b>…</b>',
    `map <b id="hud-map">${escapeHtml(layoutName)}</b>`,
    `room <b>${escapeHtml(game.room)}</b>`,
    `${others} opponent${others === 1 ? '' : 's'}`,
    game.streak >= 2 ? `<b>${game.streak} in a row</b>` : '',
    game.identity.isGuest ? 'guest key' : escapeHtml(game.identity.npub.slice(0, 16) + '…'),
    trouble
      ? `<span class="bad">${escapeHtml(trouble)}</span>`
      : `${game.net.relays.length} relays`,
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

/** Little timers for whatever is currently running on your tank. */
function drawBuffs(game: Game, now: number): void {
  const node = $('buffs')
  const live: string[] = []
  const bar = (label: string, until: number, hue: number) => {
    const left = (until - now) / 1000
    if (left <= 0) return
    live.push(
      `<span class="buff" style="--buff-hue:${hue}">${escapeHtml(label)} <b>${left.toFixed(1)}s</b></span>`,
    )
  }
  bar('Rapid', game.buffs.rapidUntil, 20)
  bar('Shield', game.buffs.shieldUntil, 200)
  bar('Overdrive', game.buffs.speedUntil, 285)
  node.hidden = live.length === 0
  node.innerHTML = live.join('')
}

// ------------------------------------------------------------------ podium

let podiumTimer: ReturnType<typeof setTimeout> | null = null

function showPodium(result: import('./game').RoundResult): void {
  const panel = $('podium')
  $('podium-title').textContent = `Block ${result.height} — round over`
  $('podium-sub').textContent = `Next round is live on ${layoutName}. Drive whenever you like.`
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
               <span class="swatch" style="background:hsl(${r.color} 62% 52%)"></span>
               <span class="name">${escapeHtml(r.name)}</span></span>
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
        running.game.identity,
        running.game.net,
        running.game.room,
        me?.kills ?? 0,
        me?.deaths ?? 0,
        result.height,
        result.layout,
        running.game.bestStreak,
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
  const { game } = running
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
        ? await fetchBlockScores(running.game.net, height!)
        : await fetchScores(running.game.net)
    rows.innerHTML = scores.length
      ? scores
          .map(
            (s, i) =>
              `<div class="score-row"><span class="who"><span class="rank">${i + 1}</span>
                <span class="npub">${escapeHtml(s.npub.slice(0, 18))}…</span></span>
                <span class="kd">${s.kills} / ${s.deaths}${
                  scope === 'all' && s.block ? ` <span class="npub">#${s.block}</span>` : ''
                }</span></div>`,
          )
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
