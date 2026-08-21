import './style.css'
import { Game } from './game'
import { Input } from './input'
import { DEFAULT_RELAYS, Identity, Net } from './nostr'
import { Renderer } from './render'
import { fetchScores, publishScore } from './scores'

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

let running: { game: Game; renderer: Renderer; input: Input } | null = null

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

    const renderer = new Renderer(canvas)
    const input = new Input(canvas)
    running = { game, renderer, input }
    // Exposed on purpose: the two-player smoke test in test/ drives the match
    // through this handle, and it is genuinely useful in the console.
    ;(window as unknown as { __game: Game }).__game = game

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
  $('status').innerHTML = [
    `room <b>${escapeHtml(game.room)}</b>`,
    `${others} opponent${others === 1 ? '' : 's'}`,
    game.identity.isGuest ? 'guest key' : escapeHtml(game.identity.npub.slice(0, 16) + '…'),
    `${game.net.relays.length} relays`,
  ].join('<br>')

  $('feed').innerHTML = game.feed
    .map((f) => `<div>${escapeHtml(f.text)}</div>`)
    .join('')
}

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
    await publishScore(game.identity, game.net, game.room, game.kills, game.deaths)
    btn.textContent = 'Published'
  } catch {
    btn.textContent = 'Signing failed'
  }
  setTimeout(() => {
    btn.textContent = 'Publish score'
    btn.disabled = false
  }, 2000)
})

$('show-board').addEventListener('click', async () => {
  board.hidden = false
  const rows = $('board-rows')
  rows.textContent = 'loading…'
  if (!running) return
  try {
    const scores = await fetchScores(running.game.net)
    rows.innerHTML = scores.length
      ? scores
          .map(
            (s) =>
              `<div class="score-row"><span class="npub">${escapeHtml(
                s.npub.slice(0, 20),
              )}…</span><span class="kd">${s.kills} / ${s.deaths}</span></div>`,
          )
          .join('')
      : 'No scores published yet. Be the first.'
  } catch {
    rows.textContent = 'Could not reach the relays.'
  }
})

$('board-close').addEventListener('click', () => {
  board.hidden = true
})
