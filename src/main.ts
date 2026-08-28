import './style.css'
import * as arena from './arena'
import * as flags from './flags'
import { CHOPPER_MS } from './chopper'
import { SUIT_MS } from './suit'
import { layoutForBlock, layoutName, setLayout } from './arena'
import { Sfx } from './audio'
import { BlockClock } from './blocks'
import { BOT_COUNT, MAX_BOTS } from './bots'
import { Game, KILLCAM_MS, NUKE_FLASH_MS, STRIKE_GAP, STRIKE_RADIUS, bombsFor, LOADOUT_TIERS, TIER_LABELS, DEFAULT_LOADOUT, parseLoadout, rewardsForTier } from './game'
import type { FeedParty, Loadout } from './game'
import { Input, PLAYER_TWO, SOLO, type Scheme } from './input'
import { TouchSticks } from './touch'

import { DEFAULT_RELAYS, Identity, Net, mergeRelays } from './nostr'
import { type RelayProbe, checkRelay, parseRelayList } from './relays'
import { Renderer, TankPreview, type ViewMode } from './render'
import type { ClockDirection } from './nostr'
import type { Event as NostrEvent } from 'nostr-tools'
import { modifierForBlock } from './modifiers'
import { MAG_SIZE, RELOAD } from './sim'
import { SKINS, PATTERNS, FINISHES, skinFor, patternOf, finishOf, asSkin } from './skins'
import {
  type CustomSkin,
  SKIN_D_PREFIX,
  SKIN_TAG,
  encodeArt,
  isSafeArt,
  isSlug,
  parseSkinContent,
  slugify,
} from './customskins'
import type { Pattern, FinishId } from './skins'
import { CARDS, DEFAULT_CARD, asCard, cardArt, cardOf, noCareer, unlocked } from './cards'
import { STICKER_CATALOG, STICKER_SLOTS, asStickers } from './stickers'
import type { CardId, Career } from './cards'
import { type Buffs, PICKUPS, type PickupKind, iconSvg } from './pickups'
import { type Profile, Profiles, shortNpub } from './profiles'
import {
  type LiveRoom,
  type Role,
  type RoomMode,
  BEACON_EVERY_MS,
  SEATS,
  asRoomMode,
  fetchLiveRooms,
  publishPresence,
  seatFor,
  withStanding,
} from './rooms'
import {
  type BlockWall,
  type ScoreRow,
  type SeasonRow,
  EPOCH_BLOCKS,
  fetchBlockScores,
  seasonOf,
  fetchBlockWall,
  fetchCareer,
  fetchScores,
  fetchSeasons,
  publishScore,
  seasonWinners,
} from './scores'

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

/**
 * A segmented control that answers to `.value`, the way the `<select>` it
 * replaced did.
 *
 * Deliberately the same interface: every read and write in this file already
 * spoke `.value`, and a redesign that also rewrites nine call sites is a
 * redesign that breaks something on the way. `aria-pressed` carries the state
 * for both the stylesheet and a screen reader, so there is no separate class to
 * keep in sync with the truth.
 */
function segmented(id: string): { value: string } {
  const root = $(id)
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('button[data-value]')]
  let current = buttons[0]?.dataset.value ?? ''
  const paint = () => {
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.value === current))
  }
  for (const b of buttons) {
    b.addEventListener('click', () => {
      current = b.dataset.value ?? current
      paint()
    })
  }
  paint()
  return {
    get value() {
      return current
    },
    set value(v: string) {
      if (buttons.some((b) => b.dataset.value === v)) current = v
      paint()
    },
  }
}

const schemeInput = segmented('scheme')
const soundInput = segmented('sound')
// Built from `SKINS` before `segmented()` reads the DOM: the picker's options
// *are* the skin table, so adding a finish is one edit rather than two that can
// disagree.
// Two rows, not one long list: the catalog is a matrix now (pattern ×
// finish, 36 reachable skins), and the dropdown that replaced the button row
// would have needed seven optgroups to hold it. Picking on two axes keeps
// every skin two taps away, and adding a pattern adds one button rather than
// six entries. Both rows are built from the skins tables, so the picker and
// the catalog cannot disagree.
for (const p of PATTERNS) {
  const b = document.createElement('button')
  b.type = 'button'
  b.dataset.value = p
  b.textContent = p === 'solid' ? 'Solid' : SKINS[p].label
  $('skin-pattern').appendChild(b)
}
for (const f of FINISHES) {
  const b = document.createElement('button')
  b.type = 'button'
  b.dataset.value = f
  b.textContent = SKINS[f].label
  $('skin-finish').appendChild(b)
}
const patternInput = segmented('skin-pattern')
const finishInput = segmented('skin-finish')
/**
 * Carbon's trick — hue on the trim, hull near-black — hides any pattern, so
 * the cell does not exist in the catalog and the button says so under a
 * pattern rather than silently painting something else.
 */
const paintCarbonButton = () => {
  const carbon = $('skin-finish').querySelector<HTMLButtonElement>('button[data-value="carbon"]')!
  const off = patternInput.value !== 'solid'
  carbon.disabled = off
  carbon.title = off ? 'Carbon hides the hull — no pattern survives it' : ''
  if (off && finishInput.value === 'carbon') finishInput.value = 'plastic'
}
const skinInput = {
  get value() {
    return skinFor(patternInput.value as Pattern, finishInput.value as FinishId)
  },
  set value(v: string) {
    const id = asSkin(v)
    patternInput.value = patternOf(id)
    finishInput.value = finishOf(id)
    paintCarbonButton()
  },
}
const paintSkinBlurb = () => {
  const worn = wornCustomSkin()
  $('skin-blurb').textContent = worn
    ? `${worn.name} — your own art. The hue moves to the trim.`
    : SKINS[asSkin(skinInput.value)].blurb
}
$('skin-pattern').addEventListener('click', () => {
  wearCustom(null)
  paintCarbonButton()
  paintSkinBlurb()
})
$('skin-finish').addEventListener('click', () => {
  wearCustom(null)
  paintSkinBlurb()
})


const playersInput = segmented('players')

/**
 * The glass. One per page, alive from load, because the first thing it has to
 * answer is "is this a phone" and that is answered by a finger arriving.
 */
const sticks = new TouchSticks(canvas, $('touch'))

/**
 * Two-player-on-one-screen is a couch feature and there is no couch on a phone.
 *
 * Left in the DOM and hidden rather than removed, because the answer can change
 * inside a session: a tablet with a keyboard is a desk until somebody picks it
 * up, and a laptop with a touchscreen is a desk that occasionally gets poked.
 */
function paintTouchAffordances(): void {
  if (!sticks.touched) return
  $('row-players').hidden = true
  playersInput.value = '1'
  $('controls-hint').hidden = true
  // Retired the moment a stick has been raised. An instruction that stays on
  // screen after it has been followed is not an instruction any more, it is
  // furniture — and on a 393px-tall phone it is furniture sitting on top of the
  // buttons.
  $('touch-hint').hidden = sticks.used
  paintRotate()
  // A touchscreen that also reports a fine pointer only becomes knowable here.
  paintHudCompact()
}

/**
 * Portrait on a touch device gets a full-stop, not a squeezed layout.
 *
 * Gated on three things, and each one is load-bearing. A finger must have been
 * seen, so a narrow desktop window is never told to turn a phone it does not
 * have. The game must be running, because the lobby reads perfectly well in
 * portrait and blocking it would mean typing a callsign sideways before you
 * have decided to play. And the window must actually be taller than it is
 * wide, which is the only one of the three anybody would have guessed.
 */
function paintRotate(): void {
  const portrait = window.innerHeight > window.innerWidth
  $('rotate').hidden = !(running && sticks.touched && portrait)
}
window.addEventListener('resize', paintRotate)
window.addEventListener('orientationchange', paintRotate)
// Cheap, and it is the only way to notice the first touch: nothing else on the
// page is listening for one before the game starts.
window.addEventListener('pointerdown', paintTouchAffordances, { passive: true })

/**
 * Register the service worker, which is what makes the game installable.
 *
 * Failure is not worth reporting to a player: without it the game still runs,
 * it simply cannot be added to a home screen and will not open offline. Vite
 * emits the file to the site root untouched — see `public/sw.js`.
 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(() => {})
  })
}

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

// ------------------------------------------------------- custom skins

/**
 * The player's own art, worn over the hull. The design decisions — the image
 * lives *inside* the skin event as a bounded data URL, one event per skin,
 * the hue survives by the carbon rule — are written down in customskins.ts.
 *
 * The collection lives in localStorage and is republished to the relays at
 * play time (one addressable event per skin, alongside the attestation that
 * names it, so the signer asks once). Peers resolve the marker through
 * `resolvePeerArt` below.
 */
let customSkins: CustomSkin[] = (() => {
  try {
    const v = JSON.parse(stored('tank.customskins') ?? '[]') as unknown
    if (!Array.isArray(v)) return []
    return v.filter(
      (s): s is CustomSkin =>
        !!s && typeof s === 'object' && isSlug((s as CustomSkin).slug ?? '') &&
        typeof (s as CustomSkin).name === 'string' && isSafeArt((s as CustomSkin).art),
    )
  } catch {
    return []
  }
})()
let wornSlug: string | null = (() => {
  const v = stored('tank.wornskin')
  return v && customSkins.some((s) => s.slug === v) ? v : null
})()

const wornCustomSkin = (): CustomSkin | null =>
  customSkins.find((s) => s.slug === wornSlug) ?? null

function wearCustom(slug: string | null): void {
  wornSlug = slug && customSkins.some((s) => s.slug === slug) ? slug : null
  store('tank.wornskin', wornSlug ?? '')
  paintCustomRack()
  if (running) {
    const g = running.players[0].game
    g.wornCustom = wornSlug
    g.customArt = wornCustomSkin()?.art ?? null
  }
}

// `escapeHtml` lives far below and calling it during module init is the
// temporal-dead-zone crash paintLoadout documents — and unlike the tables
// there, skin names ARE input (filenames). A local escaper, hoisted.
function escAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function paintCustomRack(): void {
  const rack = $('custom-rack')
  rack.innerHTML = customSkins
    .map(
      (s) =>
        `<span class="custom-card">` +
        // The art is our own saved data URL, validated on the way in.
        `<button type="button" class="custom-wear" data-slug="${s.slug}" ` +
        `aria-pressed="${s.slug === wornSlug}" title="${escAttr(s.name)}">` +
        `<img src="${s.art}" alt="${escAttr(s.name)}"></button>` +
        `<button type="button" class="custom-del" data-del="${s.slug}" ` +
        `aria-label="delete ${escAttr(s.name)}">&times;</button></span>`,
    )
    .join('')
  rack.hidden = customSkins.length === 0
}

const customNote = (text: string) => {
  const n = $('custom-note')
  n.textContent = text
  n.hidden = !text
}

$('custom-upload').addEventListener('click', () => $('custom-file').click())
$('custom-file').addEventListener('change', async () => {
  const input = $('custom-file') as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const art = await encodeArt(file)
  if (!art) {
    customNote('That image would not compress to a texture — try a simpler one.')
    return
  }
  const name = (file.name.replace(/\.[a-z0-9]+$/i, '') || 'my skin').slice(0, 24)
  let slug = slugify(name) || 'skin'
  // A re-upload of the same name replaces it, which is what a person fixing
  // their art expects; only a *different* skin needs a fresh slug.
  const existing = customSkins.find((s) => s.slug === slug)
  if (existing) existing.art = art
  else customSkins.push({ slug, name, art })
  if (customSkins.length > 12) customSkins.shift()
  store('tank.customskins', JSON.stringify(customSkins))
  customNote('')
  wearCustom(slug)
  paintSkinBlurb()
  paintPreview()
})
$('custom-rack').addEventListener('click', (e) => {
  const del = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-del]')
  if (del) {
    customSkins = customSkins.filter((s) => s.slug !== del.dataset.del)
    store('tank.customskins', JSON.stringify(customSkins))
    if (wornSlug === del.dataset.del) wearCustom(null)
    else paintCustomRack()
    paintSkinBlurb()
    paintPreview()
    return
  }
  const wear = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-slug]')
  if (!wear) return
  wearCustom(wear.dataset.slug === wornSlug ? null : (wear.dataset.slug ?? null))
  paintSkinBlurb()
  paintPreview()
})
paintCustomRack()

/** Publish the worn skin as its addressable event. See the design notes above. */
async function publishWornSkin(game: Game): Promise<void> {
  const worn = wornCustomSkin()
  if (!worn || game.watching) return
  try {
    const signed = await game.identity.signAsSelf({
      kind: 30078,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['d', SKIN_D_PREFIX + worn.slug],
        ['t', SKIN_TAG],
      ],
      content: JSON.stringify({ name: worn.name, art: worn.art }),
    })
    game.net.publish(signed)
    // The SAME signed event again, twice, on a short tail. Publishing is
    // fire-and-forget and this one is a one-shot at the busiest moment of a
    // connection's life — a drop here would leave every peer unable to dress
    // this tank for the whole session. A relay that already has it answers
    // "duplicate", which costs nothing, and no new signature is asked for.
    setTimeout(() => game.net.publish(signed), 15_000)
    setTimeout(() => game.net.publish(signed), 60_000)
  } catch {
    // A declined signer means peers see plastic in the right hue. The local
    // art is untouched, and nothing downstream depends on this send.
  }
}

/**
 * Resolve peers' custom art off the relays.
 *
 * One bounded query per (pubkey, slug), retried at most twice more with a
 * 15-second spacing — the event is addressable and tiny, but a wearer whose
 * publish was declined or dropped would otherwise cost a REQ every poll
 * forever, and the relay budget is a house rule. Misses fail soft: the tank
 * keeps wearing plastic in its own hue.
 */
const artTried = new Map<string, { tries: number; nextAt: number }>()
setInterval(() => {
  if (!running) return
  const now = performance.now()
  const game = running.players[0].game
  for (const peer of game.peers.values()) {
    if (!peer.customSkin || peer.customArt || !peer.pubkey) continue
    if (game.isBot(peer.session)) continue
    const slug = peer.customSkin
    const key = `${peer.pubkey}/${slug}`
    const state = artTried.get(key) ?? { tries: 0, nextAt: 0 }
    if (state.tries >= 3 || now < state.nextAt) continue
    artTried.set(key, { tries: state.tries + 1, nextAt: now + 15_000 })
    void game.net
      .list({ kinds: [30078], authors: [peer.pubkey], '#d': [SKIN_D_PREFIX + slug] })
      .then((events) => {
        const latest = [...events].sort((a, b) => b.created_at - a.created_at)[0]
        const parsed = latest ? parseSkinContent(latest.content, slug) : null
        // Applied to whoever wears that outfit *now* — the peer object may
        // have been replaced while the query was in flight.
        if (!parsed) return
        for (const p of game.peers.values()) {
          if (p.pubkey === latest.pubkey && p.customSkin === slug) p.customArt = parsed.art
        }
      })
      .catch(() => {
        // The retry budget above already covers a relay that timed out.
      })
  }
}, 2_000)

nameInput.value = stored('tank.name') ?? ''
roomInput.value = params.get('room') ?? stored('tank.room') ?? 'lobby'
relayInput.value = mergeRelays(stored('tank.relays'), stored('tank.relays.offered')).join('\n')
schemeInput.value = stored('tank.scheme') === 'tank' ? 'tank' : 'direct'
playersInput.value = stored('tank.players') === '2' ? '2' : '1'
skinInput.value = asSkin(stored('tank.skin'))
paintSkinBlurb()

/* ------------------------------------------------------- the compact hud */

/**
 * On a phone the board is the screen and everything else is a chip.
 *
 * The scoreboard and the status panel are two opaque rectangles in the two
 * corners a top-down arena most needs. Collapsed, they become a row of chips
 * that still carry the one number each panel exists for — your K/D, and
 * whether the relays are behaving — so the collapsed state is informative
 * rather than merely absent.
 */
type HudPanel = '' | 'score' | 'status' | 'menu'

const HUD_SHEETS: Record<Exclude<HudPanel, ''>, string> = {
  score: 'scoreboard',
  status: 'status',
  menu: 'hud-actions',
}

/** Which sheet is open, or none. Persisted; none is the default, deliberately. */
let hudOpen: HudPanel = (() => {
  const v = stored('tank.hud.open')
  return v === 'score' || v === 'status' || v === 'menu' ? v : ''
})()

/** Whether the HUD is in its collapsed form at all. */
let hudCompactOn = false

/**
 * Three signals, and each catches a case the others miss.
 *
 * A coarse pointer is what a phone reports *before* anybody touches it, which
 * is what keeps the HUD from painting open on the first frame and collapsing a
 * moment later. A seen finger catches a touchscreen that reports a fine pointer
 * because a mouse is also attached. And a viewport this small has the problem
 * whatever it is being pointed at — a 600px browser window has the panels over
 * the board exactly as a phone does, so it gets the same answer.
 */
function hudShouldCompact(): boolean {
  let coarse = false
  try {
    coarse = window.matchMedia('(pointer: coarse)').matches
  } catch {
    /* older engines: fall through to the other two signals */
  }
  return sticks.touched || coarse || window.innerWidth <= 700 || window.innerHeight <= 480
}

/**
 * Paint the collapsed/expanded state.
 *
 * Note this sets `hidden` rather than a class: `[hidden] { display: none
 * !important }` at the top of the stylesheet is what makes that stick against
 * `.panel`'s own `display`, and it is there because this exact bug has shipped
 * twice in this repo.
 */
function paintHudCompact(): void {
  hudCompactOn = hudShouldCompact()
  document.body.classList.toggle('hud-compact', hudCompactOn)
  for (const [panel, id] of Object.entries(HUD_SHEETS) as [Exclude<HudPanel, ''>, string][]) {
    const open = !hudCompactOn || hudOpen === panel
    $(id).hidden = hudCompactOn && !open
    $(`chip-${panel}`).setAttribute('aria-expanded', String(hudCompactOn && hudOpen === panel))
  }
}

/** Open a sheet, or close it if it is the one already open. One at a time. */
function toggleHudPanel(panel: Exclude<HudPanel, ''>): void {
  hudOpen = hudOpen === panel ? '' : panel
  store('tank.hud.open', hudOpen)
  paintHudCompact()
}

for (const panel of ['score', 'status', 'menu'] as const) {
  $(`chip-${panel}`).addEventListener('click', () => toggleHudPanel(panel))
}

/*
 * A sheet closes the moment a thumb goes back to the board.
 *
 * Without this the panel a player opened to read is the panel their driving
 * thumb lands on for the rest of the round — the sheet takes pointer events,
 * so it is not merely in the way, it eats the input. Opening it is a glance,
 * not a mode.
 */
canvas.addEventListener(
  'pointerdown',
  () => {
    if (!hudCompactOn || !hudOpen) return
    hudOpen = ''
    store('tank.hud.open', hudOpen)
    paintHudCompact()
  },
  { passive: true },
)

window.addEventListener('resize', paintHudCompact)
window.addEventListener('orientationchange', paintHudCompact)
paintHudCompact()

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

/**
 * Publish this round's score when the block closes, or leave it to the button.
 *
 * This is the fix for "the block winner is decided only among players who
 * published a score". The podium at the end of a round was always right — it
 * reads the live roster and covers everybody in the room — but the leaderboard
 * wall is built from signed kind-30078 records, and a record only exists if
 * somebody clicked. So most blocks were won by whoever remembered.
 *
 * The default is split, because the cost of publishing is not the same for
 * everybody:
 *
 *   - A **guest** plays on an ephemeral key this client holds itself. Signing
 *     is free, silent, and asks nobody anything, so a guest who never opens a
 *     menu should still land on the wall. On.
 *   - An **npub login** signs through a NIP-07 extension, which puts a dialog
 *     in front of the player roughly every ten minutes for as long as they play.
 *     That is not a default anybody would choose for themselves. Off, with the
 *     reason said out loud once, and one click to change it.
 *
 * Remembered per browser either way, and the stored value beats the default —
 * so a player who turns it on stays on across a reload and a signer change.
 */
let autoPublishSet = stored('tank.autopublish')
const autoPublishDefault = (): boolean => running?.players[0].game.identity.isGuest ?? true
const autoPublishOn = (): boolean =>
  autoPublishSet === null ? autoPublishDefault() : autoPublishSet === 'on'

function paintAutoPublish(): void {
  const btn = $('autopublish-toggle')
  const on = autoPublishOn()
  btn.textContent = on ? 'Auto-publish: on' : 'Auto-publish: off'
  btn.title = on
    ? 'Your score is signed and published when each block closes'
    : 'Scores are only published when you press the button'
}

function setAutoPublish(on: boolean): void {
  autoPublishSet = on ? 'on' : 'off'
  store('tank.autopublish', autoPublishSet)
  paintAutoPublish()
  // Said once, when it is turned on by somebody who will feel it. A guest sees
  // nothing because a guest is charged nothing.
  const guest = running?.players[0].game.identity.isGuest ?? true
  if (on && !guest) {
    running?.players[0].game.pushFeed('auto-publish on — your signer will ask once a block')
  }
}

$('autopublish-toggle').addEventListener('click', () => setAutoPublish(!autoPublishOn()))

/**
 * Publish the round that just closed, if the player has asked us to.
 *
 * Deliberately silent about success and about failure. This runs at a block
 * boundary while the next round is already live underneath the podium, and a
 * player who is driving does not need a toast telling them a relay accepted an
 * event. A refused signature is the same: they chose the setting, the podium
 * still has its button, and interrupting a fight to report it would be worse
 * than the miss.
 *
 * A round nobody scored in is skipped. Publishing 0/0 puts a record on four
 * relays that changes no leaderboard and adds a name to a block nobody played.
 */
function autoPublishRound(result: import('./game').RoundResult): void {
  if (!running || !autoPublishOn()) return
  const game = running.players[0].game
  if (game.watching) return
  const me = result.standings.find((r) => r.you)
  if (!me || (me.kills === 0 && me.deaths === 0)) return
  void publishScore(
    game.identity,
    game.net,
    game.room,
    me.kills,
    me.deaths,
    result.height,
    result.layout,
    // `result.bestStreak`, not `game.bestStreak`. `endRound` banks the round
    // and then resets the live counter, and everything that publishes runs
    // after that — which is why the podium's manual button has signed a best
    // streak of zero for every round it has ever published. Broken on purpose
    // to check: test/autopublish.mjs goes red on exactly this line.
    result.bestStreak,
    result.mode,
  ).catch(() => {})
}

/**
 * Which side you are on. None, or one of five.
 *
 * Picked in the lobby, locked the moment a match starts. It used to be a
 * mid-round toggle — "a side is something you change when somebody asks you
 * to" — but a side you can change under fire is also a side you change *to
 * dodge*: claim the shooter's team and their shells pass through you. Puzz
 * called it: team and mode are settled before you roll out, and the HUD
 * button becomes a badge that says which side that was.
 *
 * Remembered, because "we're red" survives a reload and re-picking it every
 * time you rejoin is the thing that makes people not bother.
 */
const TEAM_NAMES = ['none', 'Red', 'Blue', 'Green', 'Gold', 'Violet']
const TEAM_HUES = [0, 356, 210, 132, 44, 285]
let teamPick = Math.max(0, Math.min(5, Number(stored('tank.team') ?? 0) || 0))
// Flips at match start and never back — there is no way out of a match except
// a reload. Its own flag rather than a read of `running`, which is declared
// further down and would be a dead-zone read from the initial paint here.
let sideLocked = false

/** The team pennant, in a given hue — the side buttons and the toggle agree. */
const sideBanner = (hue: number): string =>
  `<svg class="side-ico" viewBox="0 0 24 24" aria-hidden="true" ` +
  `style="fill:hsl(${hue} 72% 62%)"><path d="M5 2h14v18l-7-5-7 5Z"/></svg>`

function paintTeamButton(): void {
  const btn = $('team-toggle')
  // TEAM_NAMES is this repo's own constant, not input — same escapeHtml
  // temporal-dead-zone hazard as paintLoadout documents.
  btn.innerHTML = teamPick
    ? `${sideBanner(TEAM_HUES[teamPick])}Team: ${TEAM_NAMES[teamPick]}`
    : `Team: ${TEAM_NAMES[teamPick]}`
  btn.style.borderColor = teamPick ? `hsl(${TEAM_HUES[teamPick]} 72% 58%)` : ''
  btn.style.color = teamPick ? `hsl(${TEAM_HUES[teamPick]} 78% 72%)` : ''
  btn.classList.toggle('locked', sideLocked)
  btn.title = sideLocked
    ? 'Sides are locked once the match starts'
    : 'Pick a side, or none for a free-for-all (T)'
}

function setTeam(next: number): void {
  if (sideLocked) {
    running?.players[0].game.pushFeed('sides are locked — pick a team in the lobby')
    return
  }
  teamPick = ((next % 6) + 6) % 6
  store('tank.team', String(teamPick))
  paintTeamButton()
}

paintTeamButton()
$('team-toggle').addEventListener('click', () => setTeam(teamPick + 1))
window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyT' || e.repeat) return
  const target = e.target as HTMLElement | null
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
  setTeam(teamPick + 1)
})

/* -------------------------------------------------------------- the hub */

/**
 * Mode select, on the way in — and the mode is the ROOM's, not yours.
 *
 * Puzz: "deathmatch the default should always be ongoing... the other modes
 * need to be specifically spun up." The mode used to be a per-client lobby
 * preference that never left this file: two players in one room could be
 * running CTF and DOM at once, each seeing rules the other did not. Now the
 * room's rules ride the presence beacon (`RoomMode` in rooms.ts, absent = dm),
 * the live board says what each table is playing, and a joiner adopts the
 * rules of the room they walk into. The picker below still exists for the
 * player who *starts* a room — the first one in is the creator, and their
 * pick becomes the room's.
 */
type Mode = RoomMode

/** Remembered, and consistent with the side that was remembered next to it. */
let mode: Mode = ((): Mode => {
  const v = stored('tank.mode')
  if (v === 'tdm' || v === 'dm' || v === 'ctf' || v === 'dom') return v
  // First run after this shipped: somebody who had already picked a side with
  // `T` is plainly playing a team game, so do not throw that away.
  return teamPick ? 'tdm' : 'dm'
})()

// An invite link can carry the rules: `?room=den&mode=ctf` lands a friend in
// the right game even before the creator's first beacon is queryable. Not
// persisted — the link speaks for this visit, the stored pick is still yours.
{
  const fromUrl = asRoomMode(params.get('mode'))
  if (fromUrl) {
    mode = fromUrl
    teamPick = mode === 'dm' ? 0 : teamPick || 1
    paintTeamButton()
  }
}

for (let i = 1; i < TEAM_NAMES.length; i++) {
  const b = document.createElement('button')
  b.type = 'button'
  b.dataset.value = String(i)
  b.innerHTML = `${sideBanner(TEAM_HUES[i])}${TEAM_NAMES[i]}`
  b.style.setProperty('--side-hue', String(TEAM_HUES[i]))
  $('side').appendChild(b)
}

/**
 * One icon per mode, in the house icon style — flat single-colour silhouettes
 * on a 24×24 grid, chunky enough to read at 20px, two-tone only through
 * `fill-opacity`. Same style as `REWARD_PATHS`; anything new (seats, relays,
 * pickup chips) should match these two tables rather than invent a third look.
 */
const MODE_PATHS: Record<Mode, string> = {
  // A kill burst: deathmatch is everyone shooting everyone.
  dm: '<path d="M12 1l2.3 6.4 6.7-1.9-4.5 5.5 4.5 5.5-6.7-1.9L12 21l-2.3-6.4-6.7 1.9 4.5-5.5-4.5-5.5 6.7 1.9Z"/>',
  // Two banners, one faded: two sides of the same fight.
  tdm: '<path d="M3 3h8v12l-4 3-4-3Z"/><path d="M13 6h8v12l-4 3-4-3Z" fill-opacity="0.5"/>',
  // The flag itself.
  ctf: '<path d="M6 2h2.5v20H6Z"/><path d="M8.5 4h11l-3.6 4 3.6 4h-11Z"/>',
  // Three points, one contested.
  dom: '<circle cx="12" cy="6" r="3.6"/><circle cx="5.5" cy="17.5" r="3.6" fill-opacity="0.5"/><circle cx="18.5" cy="17.5" r="3.6"/>',
}
for (const [id, path] of Object.entries(MODE_PATHS)) {
  $(`mode-${id}`).insertAdjacentHTML(
    'afterbegin',
    `<svg class="mode-ico" viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`,
  )
}

function paintModes(): void {
  for (const id of ['dm', 'tdm', 'ctf', 'dom'] as const) {
    const on = id === mode
    const card = $(`mode-${id}`)
    card.classList.toggle('on', on)
    card.setAttribute('aria-pressed', String(on))
  }
  // Both team modes need a side; only capture the flag puts flags out.
  $('row-side').hidden = mode === 'dm'
  for (const b of $('side').querySelectorAll('button')) {
    const on = b.dataset.value === String(teamPick)
    b.setAttribute('aria-pressed', String(on))
  }
}

function setMode(next: Mode): void {
  // The lobby is hidden while a match runs, so this cannot fire mid-game —
  // but the mode lock is a rule, not a layout accident, so it holds here too.
  if (sideLocked) return
  mode = next
  store('tank.mode', mode)
  // The mode is not a third piece of state — it *is* the side, expressed the
  // way somebody picking a game thinks about it. Deathmatch means no side;
  // team deathmatch means a side, and Red if you have never picked one.
  setTeam(mode === 'dm' ? 0 : teamPick || 1)
  paintModes()
}

$('mode-dm').addEventListener('click', () => setMode('dm'))
$('mode-tdm').addEventListener('click', () => setMode('tdm'))
$('mode-ctf').addEventListener('click', () => setMode('ctf'))
$('mode-dom').addEventListener('click', () => setMode('dom'))
$('side').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-value]')
  if (!b) return
  setTeam(Number(b.dataset.value))
  paintModes()
})
paintModes()

/**
 * The tank in the garage.
 *
 * The real rig, the real `applySkin`, spinning slowly in its own small WebGL
 * context — not a picture of a tank. A drawing of "chrome" is a second
 * description of a number in `SKINS`, and second descriptions drift.
 *
 * One honest limitation, said out loud under the picker rather than papered
 * over: the *colour* is dealt from your pubkey when you sit down, so the
 * garage cannot know it. A preview that invented a colour would be lying about
 * the one thing on a tank that is not cosmetic — your hue is how eight players
 * tell each other apart. So the garage shows the finish, and says so.
 */
/**
 * Stickers: one tap on, one tap off.
 *
 * The grid is the whole interaction — a worn sticker is lit, tapping it peels
 * it off, tapping a fresh one takes the next free deck corner (of four; see
 * `src/stickers.ts` for why four). No slot-then-emoji two-step: on a phone
 * that is a mode, and a mode in a lobby is a thing to get stuck in.
 */
let stickerPicks: string[] = (() => {
  try {
    return asStickers(JSON.parse(stored('tank.stickers') ?? '[]'))
  } catch {
    return []
  }
})()

for (const emoji of STICKER_CATALOG) {
  const b = document.createElement('button')
  b.type = 'button'
  b.dataset.value = emoji
  b.textContent = emoji
  $('sticker-grid').appendChild(b)
}

function paintStickers(): void {
  for (const b of $('sticker-grid').querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(stickerPicks.includes(b.dataset.value!)))
  }
  $('sticker-count').textContent = `${stickerPicks.length}/${STICKER_SLOTS}`
}

$('sticker-grid').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-value]')
  if (!b) return
  const emoji = b.dataset.value!
  const worn = stickerPicks.indexOf(emoji)
  if (worn >= 0) stickerPicks.splice(worn, 1)
  else if (stickerPicks.length < STICKER_SLOTS) stickerPicks.push(emoji)
  else return
  store('tank.stickers', JSON.stringify(stickerPicks))
  paintStickers()
  paintPreview()
  // Mid-match too: the field is read on the next attestation rebroadcast, so
  // the room re-dresses the tank without anything being restarted.
  if (running) running.players[0].game.stickers = [...stickerPicks]
})
paintStickers()

const PREVIEW_HUE = 48
let preview: TankPreview | null = null
try {
  preview = new TankPreview($<HTMLCanvasElement>('tank-cam'))
  // The suites reach the preview the way they reach the game and the
  // renderer: pixels prove a cosmetic, and the garage is where a cosmetic
  // stands still long enough to be measured.
  ;(window as unknown as { __preview: TankPreview }).__preview = preview
} catch {
  // No WebGL in the lobby is survivable — the canvas simply stays empty and
  // every other control still works. Failing to start the *game* is a
  // different matter and is reported where it happens.
  $('tank-cam').hidden = true
}

function paintPreview(): void {
  if (!preview) return
  preview.setSkin(asSkin(skinInput.value), PREVIEW_HUE, wornCustomSkin()?.art ?? null)
  preview.setStickers(stickerPicks)
  preview.setDriver(nameInput.value.trim() || 'tank', null, PREVIEW_HUE)
}
$('skin-pattern').addEventListener('click', paintPreview)
$('skin-finish').addEventListener('click', paintPreview)
nameInput.addEventListener('input', paintPreview)
window.addEventListener('resize', () => preview?.resize())
paintPreview()

/**
 * Practice tanks: how many, before the match and during it.
 *
 * Puzz: "ability to add bots to the game both in pre game screen and while in
 * game." It was a boolean, which cannot say three — and three was the only
 * number the game had, chosen when a room held four. A room holds eight now,
 * so seven is a legitimate thing to want and it was unreachable.
 *
 * Remembered, because the common first run of this game is one person joining
 * a room string nobody else has typed and an empty arena is not a game. The
 * `Game` decides whether any of them actually appear — bots only exist while no
 * real player is in the room — so this is a preference, and the label says what
 * is *wanted* rather than what is on the board this second.
 *
 * Changing it mid-match is free by construction: bots are entirely local and
 * publish nothing, so adding one is not a thing anybody else has to agree to.
 * That is the whole reason this can be a live control rather than a setting you
 * restart for.
 */
let botsWanted = ((): number => {
  const raw = stored('tank.bots')
  // `'on'`/`'off'` are what this preference used to be. Somebody who set it
  // before today still has one of those in storage, and reading it as NaN
  // would silently hand them an empty arena.
  if (raw === 'off') return 0
  if (raw === 'on' || raw === null) return BOT_COUNT
  const n = Number(raw)
  return Number.isFinite(n) ? Math.max(0, Math.min(MAX_BOTS, Math.floor(n))) : BOT_COUNT
})()
// The invite link can say how crewed the room should feel, like it says the
// mode and the board. Applied to the variable directly: `setBots` reaches for
// `running`, which is declared further down, and calling it during module
// init is a temporal-dead-zone crash that takes the whole lobby with it.
{
  const fromUrl = params.get('bots')
  if (fromUrl !== null && Number.isFinite(Number(fromUrl))) {
    botsWanted = Math.max(0, Math.min(MAX_BOTS, Math.floor(Number(fromUrl))))
  }
}

/** What the middle button restores when it is clicked back on. */
let botsLast = botsWanted || BOT_COUNT

for (let i = 0; i <= MAX_BOTS; i++) {
  const b = document.createElement('button')
  b.type = 'button'
  b.dataset.value = String(i)
  b.textContent = String(i)
  $('bots').appendChild(b)
}
const botsInput = segmented('bots')

function paintBotsButton(): void {
  $('bots-toggle').textContent = botsWanted ? `Bots: ${botsWanted}` : 'Bots: off'
  // A control that cannot go further should say so rather than doing nothing.
  $<HTMLButtonElement>('bots-less').disabled = botsWanted <= 0
  $<HTMLButtonElement>('bots-more').disabled = botsWanted >= MAX_BOTS
  botsInput.value = String(botsWanted)
}

function setBots(n: number): void {
  botsWanted = Math.max(0, Math.min(MAX_BOTS, Math.floor(n)))
  if (botsWanted) botsLast = botsWanted
  store('tank.bots', String(botsWanted))
  paintBotsButton()
  // Player one's game only: player two's bots would be invisible on the shared
  // screen and still shoot. Same rule as the push at match start.
  if (running) running.players[0].game.botsWanted = botsWanted
}
// `paintBotsButton`, not `setBots`: `setBots` reaches for `running`, which is
// declared further down this file, and calling it during module init is a
// temporal-dead-zone crash that takes the whole lobby with it. Nothing needs
// setting here anyway — the value was just read from storage.
paintBotsButton()

$('bots-toggle').addEventListener('click', () => setBots(botsWanted ? 0 : botsLast))
$('bots-less').addEventListener('click', () => setBots(botsWanted - 1))
$('bots-more').addEventListener('click', () => setBots(botsWanted + 1))
$('bots').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-value]')
  if (b) setBots(Number(b.dataset.value))
})

// -------------------------------------------------- the rest of create-a-game

/**
 * `The Bluff` → `the-bluff`. The slug is the wire name of a pinned board — the
 * index would be shorter, but a board inserted mid-list would silently repoint
 * every old invite link at a different arena.
 */
const boardSlug = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

function boardIndexOf(slug: string | null | undefined): number | null {
  if (!slug) return null
  const i = arena.LAYOUTS.findIndex((l) => boardSlug(l.name) === slug)
  return i >= 0 ? i : null
}

/**
 * The board picker, built from `LAYOUTS` so it cannot drift from the boards
 * the build actually ships. Following the chain is the first entry and the
 * default: a pinned board is the created-game exception, not the norm.
 */
const boardSelect = $<HTMLSelectElement>('board-pick')
{
  const chain = document.createElement('option')
  chain.value = ''
  chain.textContent = 'Follow the chain — a new board every block'
  boardSelect.appendChild(chain)
  for (const l of arena.LAYOUTS) {
    const o = document.createElement('option')
    o.value = boardSlug(l.name)
    o.textContent = l.name
    boardSelect.appendChild(o)
  }
}

/** Listed on the live board, or reachable only by the invite link. */
const visibilityInput = segmented('visibility')

// The invite link can pin a board and demand privacy, the same way it carries
// the mode: a friend handed `?room=den&mode=ctf&board=the-bluff&private=1`
// lands in exactly the game that was made, with nothing to configure.
{
  const pinned = boardIndexOf(params.get('board'))
  if (pinned !== null) boardSelect.value = boardSlug(arena.LAYOUTS[pinned].name)
  if (params.get('private') === '1') visibilityInput.value = 'private'
}

// ----------------------------------------------------------- reward icons

/**
 * One icon per reward *id*, drawn once, read everywhere: the loadout picker,
 * the ladder strip, the tray pills and the buff chips. Keyed by id and not by
 * rung number, because the loadout made rung numbers a choice — the old
 * at-keyed table showed the air-strike star on rung 5 no matter what the
 * player had actually slotted there.
 */
const REWARD_PATHS: Record<string, string> = {
  repair:
    '<path d="M14 3a5 5 0 0 0-4.6 7L3 16.4V21h4.6l6.4-6.4A5 5 0 1 0 14 3Z"/>',
  strike:
    '<path d="M9 2h6l-2 5h-2Z"/><circle cx="12" cy="15" r="6.5"/>',
  recon:
    '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.5"/>' +
    '<circle cx="12" cy="12" r="3"/>' +
    '<path d="M12 1v4M12 19v4M1 12h4M19 12h4" stroke="currentColor" stroke-width="2.5"/>',
  chopper:
    '<path d="M3 6h18v2H13v3l6 4v2H5v-2l6-4V8H3Z"/><circle cx="12" cy="19" r="2"/>',
  spitfire:
    '<path d="M11 2h2l1.2 6.5L22 12v2.5l-7.8-1.3v4.3l2.8 2V22l-5-1-5 1v-2.5l2.8-2v-4.3L2 14.5V12l7.8-3.5Z"/>',
  siege:
    '<path d="M9 2h6v9h4.5L12 22 4.5 11H9Z"/>',
  emp:
    '<path d="M13.5 2 6 13.5h4L8 22l9.5-12h-4Z"/>' +
    '<path d="M12 0a12 12 0 0 0 0 24" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 5"/>' +
    '<path d="M12 0a12 12 0 0 1 0 24" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="3 5"/>',
  jugger:
    '<path d="M12 2 3 6v6c0 5 3.8 9.2 9 10 5.2-.8 9-5 9-10V6Z"/>',
  // --- tier 5 -------------------------------------------------------------
  patch:
    '<path d="M12 2 3 6v6c0 5 3.8 9.2 9 10 5.2-.8 9-5 9-10V6Z"/>' +
    '<path d="M10.4 5.6h3.2v3.2h3.2v3.2h-3.2v3.2h-3.2v-3.2H7.2V8.8h3.2Z" fill="#0b0e13"/>',
  cache:
    '<path d="M3 8h18v12H3Z"/><path d="M6 4h12l2 3H4Z"/>' +
    '<path d="M9 11h2v6H9Zm4 0h2v6h-2Z" fill="#0b0e13"/>',
  buck:
    // Three fat pellets leaving one muzzle. Drawn heavy on purpose: at the
    // 16px the picker renders these at, a thin spray reads as noise.
    '<path d="M10 19h4v4h-4Z"/>' +
    '<circle cx="12" cy="10" r="3.4"/><circle cx="4" cy="6" r="3"/><circle cx="20" cy="6" r="3"/>',
  // --- tier 10 ------------------------------------------------------------
  blitz:
    '<path d="M13.5 2 6 13.5h4L8 22l9.5-12h-4Z"/>' +
    '<path d="M2 4h3l4 8-4 8H2l4-8Z" opacity="0.55"/>',
  drone:
    '<path d="M4 5h5v2H4Zm11 0h5v2h-5Z"/><path d="M6 7h1.5v3H6Zm10.5 0H18v3h-1.5Z"/>' +
    '<path d="M8 10h8v8H8Z"/>' +
    '<path d="M11.2 11.6h1.6v1.8h1.8v1.6h-1.8v1.8h-1.6v-1.8H9.4v-1.6h1.8Z" fill="#0b0e13"/>',
  // --- tier 15 ------------------------------------------------------------
  salvo:
    '<path d="M2 4h4v4H2Zm6 0h4v4H8Zm6 0h4v4h-4Z"/>' +
    '<path d="M2 13h4v4H2Zm6 0h4v4H8Zm6 0h4v4h-4Z"/>' +
    '<path d="M20 3v6l3-3Zm0 9v6l3-3Z"/>',
  hunter:
    '<circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.2"/>' +
    '<path d="M12 0v5M12 19v5M0 12h5M19 12h5" stroke="currentColor" stroke-width="2.2"/>' +
    '<path d="M12 8.5 14 12l-2 3.5L10 12Z"/>',
  thermite:
    '<path d="M9 1h2v5H9Zm4 0h2v5h-2Z"/>' +
    '<path d="M12 7c3 2.4 4.5 4.6 4.5 7A4.5 4.5 0 0 1 12 18.5 4.5 4.5 0 0 1 7.5 14c0-2.4 1.5-4.6 4.5-7Z"/>' +
    '<path d="M9 20h6v3H9Z" opacity="0.6"/>',
  bulwark:
    '<path d="M12 2 3 6v6c0 5 3.8 9.2 9 10 5.2-.8 9-5 9-10V6Z"/>' +
    '<path d="M5.5 8h13v1.6h-13Zm0 3.4h13V13h-13Z" fill="#0b0e13"/>' +
    '<path d="M11.2 6.4h1.6V8h-1.6Zm-3.6 3.4h1.6v1.6H7.6Zm7.2 0h1.6v1.6h-1.6Z" fill="#0b0e13"/>',
  // --- tier 25 ------------------------------------------------------------
  armageddon:
    // Three bombs on the way down, and nothing else — the ground line and the
    // blast that used to be under them turned the whole icon to mush at 16px.
    '<path d="M3 2h3v6H3Zm0 7.5a3 3 0 1 0 3 3 3 3 0 0 0-3-3Z"/>' +
    '<path d="M10.5 5h3v6h-3Zm0 7.5a3 3 0 1 0 3 3 3 3 0 0 0-3-3Z"/>' +
    '<path d="M18 8h3v6h-3Zm0 7.5a3 3 0 1 0 3 3 3 3 0 0 0-3-3Z"/>',
  blackout:
    // An eclipse: everyone else's screen goes out, and you can see. A monitor
    // with a bolt in it was the first attempt and it read as a grey box.
    '<circle cx="12" cy="12" r="10"/><circle cx="17" cy="9" r="8" fill="#0b0e13"/>' +
    '<circle cx="17" cy="9" r="2.2"/>',
  ironclad:
    // A shield with a plate riveted across it. Three nested shields was more
    // faithful to the name and unreadable at the size it is actually drawn.
    '<path d="M12 2 3 6v6c0 5 3.8 9.2 9 10 5.2-.8 9-5 9-10V6Z"/>' +
    '<path d="M4.4 9.4h15.2v3.4H4.4Z" fill="#0b0e13"/>' +
    '<circle cx="7.4" cy="11.1" r="1.1"/><circle cx="16.6" cy="11.1" r="1.1"/>',
  nuke:
    // A mushroom. Cap, stem, and the ring of debris at the base — the one
    // silhouette in this table that everybody already knows, which is the
    // whole reason it can be read at sixteen pixels.
    '<path d="M12 1c5.2 0 9 2.6 9 4.6S17.2 9 12 9 3 7.2 3 5.6 6.8 1 12 1Z"/>' +
    '<path d="M9.6 10h4.8l1.2 8H8.4Z"/>' +
    '<path d="M4 20h16v3H4Z"/>',
  firestorm:
    '<path d="M2 10h20v3H2Z"/>' +
    '<path d="M10.5 2h3v20h-3Z" opacity="0.45"/>' +
    '<path d="M12 6c2.6 2.2 4 4.2 4 6.4A4 4 0 0 1 12 16.4a4 4 0 0 1-4-4c0-2.2 1.4-4.2 4-6.4Z"/>',
  carpet:
    '<path d="M5 2h3v7H5Zm5.5 0h3v7h-3ZM16 2h3v7h-3ZM4 12h16l-8 10Z"/>',
}

/** The icon as inline SVG. Same contract as `iconSvg` for pickups. */
function rewardIcon(id: string, cls = 'ricon'): string {
  const paths = REWARD_PATHS[id]
  if (!paths) return ''
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${paths}</svg>`
}

/**
 * An icon for whatever id the game handed the HUD — a reward, the repair, or
 * a pickup kind. The banner and the feed carry ids from both tables, and the
 * caller should not have to know which table an id came out of. Unknown ids
 * draw nothing, which is the right failure for decoration.
 */
function anyIcon(id: string, cls = 'ricon'): string {
  const reward = rewardIcon(id, cls)
  if (reward) return reward
  if (id in PICKUPS) return iconSvg(id as PickupKind, cls)
  return ''
}

// ---------------------------------------------------------------- loadout

/**
 * Which reward sits on which rung, arranged in the lobby.
 *
 * Local storage rather than the npub for now, and the card says so — a named
 * multi-slot loadout that follows the npub across devices is the umbrella
 * issue (258910a0) and rides a replaceable event; this is the first thing
 * worth putting in it. Four slots, five rewards, no duplicates: picking a
 * reward another slot holds swaps the two, which keeps every arrangement
 * legal without ever telling the player "no".
 */
let loadout: Loadout = (() => {
  try {
    const saved = parseLoadout(JSON.parse(stored('tank.loadout') ?? ''))
    if (saved) return saved
  } catch {
    // Unreadable is the same as unset.
  }
  return [...DEFAULT_LOADOUT] as Loadout
})()

function paintLoadout(): void {
  $('loadout-rows').innerHTML = LOADOUT_TIERS.map((tier, i) => {
    const label = TIER_LABELS[tier]
    return (
      `<div class="loadout-row" style="--tier: ${label.hue}">` +
      `<span class="loadout-tier"><b>${tier}</b>${label.name}</span>` +
      `<div class="seg">` +
      rewardsForTier(tier)
        .map(
          (r) =>
            `<button type="button" data-slot="${i}" data-reward="${r.id}" ` +
            // The names, details and hues are this repo's own constants, not
            // input — and `escapeHtml` lives far below this line, where calling
            // it during module init is a temporal-dead-zone crash that takes
            // the whole lobby with it. Same trap `paintBotsButton` documents.
            `title="${r.detail}" aria-pressed="${loadout[i] === r.id}">` +
            `${rewardIcon(r.id)}<span>${r.name}</span></button>`,
        )
        .join('') +
      `</div></div>`
    )
  }).join('')
}

function setLoadoutSlot(slot: number, reward: string): void {
  const tier = LOADOUT_TIERS[slot]
  // Per tier now, not one menu shared by four rungs: a reward belongs to
  // exactly one tier, so a click can only ever set the slot it came from and
  // the old swap-on-duplicate dance has nothing left to resolve. Pools being
  // disjoint is what buys that — the check is here so a stale DOM node (a
  // click landing on the previous paint) cannot write an id this rung does
  // not offer.
  if (tier === undefined) return
  const def = rewardsForTier(tier).find((r) => r.id === reward)
  if (!def) return
  loadout[slot] = def.id
  store('tank.loadout', JSON.stringify(loadout))
  paintLoadout()
  if (running) for (const p of running.players) p.game.setLoadout(loadout)
}

paintLoadout()
// The loadout table, exposed before a game exists. The picker is a *lobby*
// control, so the suite that checks it — test/tiers.mjs — runs before anything
// is on `window.__game`, and a stale loadout in storage is refused here rather
// than in the game. A suite has to be able to ask the build it is looking at
// rather than the table it was written against.
;(window as unknown as { __loadout: unknown }).__loadout = {
  parseLoadout,
  LOADOUT_TIERS,
  rewardsForTier,
}
$('loadout-rows').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-slot]')
  if (b) setLoadoutSlot(Number(b.dataset.slot), b.dataset.reward ?? '')
})

window.addEventListener('keydown', (e) => {
  if (e.repeat) return
  const target = e.target as HTMLElement | null
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
  // B still toggles, because that is the thing people press mid-fight. The
  // brackets are the fine adjustment, next to each other on every layout this
  // game has been played on.
  if (e.code === 'KeyB') setBots(botsWanted ? 0 : botsLast)
  else if (e.code === 'BracketLeft') setBots(botsWanted - 1)
  else if (e.code === 'BracketRight') setBots(botsWanted + 1)
})

window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyM' || e.repeat) return
  const target = e.target as HTMLElement | null
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
  sfx.toggle()
  soundInput.value = sfx.muted ? 'off' : 'on'
  paintSoundButton()
})

/**
 * Board view or cockpit.
 *
 * Kept on the page rather than inside `start()` so the choice survives a
 * rematch, and remembered across sessions: somebody who plays in the cockpit
 * wants to be in the cockpit next time without hunting for the button.
 */
let view: ViewMode = stored('tank.view') === 'cockpit' ? 'cockpit' : 'board'
/**
 * False during a couch match.
 *
 * There is one camera and two people looking at it. The board view is the whole
 * arena, so it is genuinely a shared picture; a cockpit is one player's eyes and
 * leaves the other driving a tank they cannot see. Split-screen would fix it and
 * is a bigger change than this — until then the toggle is off rather than
 * quietly ruining player two's match.
 */
let cockpitAllowed = true

function paintView(): void {
  const button = $('view-toggle') as HTMLButtonElement
  button.textContent = view === 'cockpit' ? 'View: cockpit' : 'View: board'
  button.disabled = !cockpitAllowed
  button.title = cockpitAllowed
    ? 'Board view or cockpit (V)'
    : 'Cockpit is single-player for now — there is only one camera'
  // Only meaningful while a match is on screen; the HUD itself is hidden in the
  // lobby, and this lives inside it.
  $('crosshair').hidden = view !== 'cockpit'
}

function setView(next: ViewMode): void {
  if (next === 'cockpit' && !cockpitAllowed) return
  view = next
  store('tank.view', view)
  running?.renderer.setView(view)
  applyViewToInput()
  paintView()
}

/**
 * Tell every local `Input` whether its sticks are being read from inside a tank.
 *
 * A gamepad's right stick and a phone's aim stick set an *absolute* gun angle,
 * because screen space and board space line up in board view. In the cockpit
 * they do not: the camera yaws with the gun, so a stick pushed up the glass has
 * to mean "ahead of this vehicle" or the pad is aiming at a compass the player
 * cannot see. The mouse is unaffected — `Renderer.toWorld` already answers with
 * a point on the aim arc.
 *
 * Only in a single-player match, which is the only place a cockpit is offered.
 */
function applyViewToInput(): void {
  if (!running) return
  for (const p of running.players) p.input.hullRelative = view === 'cockpit'
}
paintView()

$('view-toggle').addEventListener('click', () => {
  setView(view === 'cockpit' ? 'board' : 'cockpit')
})

window.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyV' || e.repeat) return
  const target = e.target as HTMLElement | null
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
  setView(view === 'cockpit' ? 'board' : 'cockpit')
})

function readRelays(): string[] {
  const list = parseRelayList(relayInput.value)
  return list.length ? list : DEFAULT_RELAYS
}

// ------------------------------------------------------- the relay editor
/**
 * Add, remove, reorder, test, save.
 *
 * The textarea is still the model and every existing caller still reads it;
 * the rows are a view of it and "Edit as text" hands it straight back for a
 * paste. What is new is that saving is a button rather than a side effect of
 * pressing Play — the old design meant a player could edit this box, close the
 * tab, and lose the edit, and it meant the *only* moment the list was written
 * was the moment it was also being used.
 *
 * Order is meaningful — `DEFAULT_RELAYS` is sorted by measured delivery
 * latency and the game reads the list in order — so a row can move up. There
 * is no "move down" because every list is short enough that moving the other
 * one up is the same gesture with one less button on a phone.
 */
const relayRows = $('relay-rows')
const relayAddUrl = $<HTMLInputElement>('relay-add-url')
const relayMsg = $('relay-msg')
const relaySave = $<HTMLButtonElement>('relay-save')
const relayTest = $<HTMLButtonElement>('relay-test')

/** Probe results by URL, so a repaint does not throw away what we learned. */
const relayProbes = new Map<string, RelayProbe>()
/**
 * The list as it stood when it was last loaded or saved.
 *
 * Dirty is measured against this rather than against `localStorage`, because
 * on load the list can legitimately differ from storage: `mergeRelays` folds
 * in defaults this browser has never been offered. Comparing to storage would
 * have every returning player open the panel to an "unsaved changes" badge for
 * a change they did not make.
 */
let relaySnapshot: string[] = []

function relayListNow(): string[] {
  return parseRelayList(relayInput.value)
}

function setRelayList(list: string[]): void {
  relayInput.value = list.join('\n')
  paintRelays()
}

function say(text: string, tone: 'good' | 'bad' | 'plain' = 'plain'): void {
  relayMsg.textContent = text
  relayMsg.className = `relay-msg${tone === 'plain' ? '' : ` ${tone}`}`
  relayMsg.hidden = !text
}

/** What the rows currently show, so a status update need not rebuild them. */
let relayPainted: string[] = []

function paintRelays(): void {
  const list = relayListNow()
  $('relay-count').textContent = String(list.length)
  paintSaveButton(list)

  // A probe finishing must not tear down the list. Rebuilding on every dot
  // meant that during "Test all" — the exact moment a player is deciding which
  // relay to delete — every row was replaced under their thumb, and a tap
  // landed on a button that no longer existed. Only the statuses change here
  // unless the list itself did.
  if (list.join('\n') === relayPainted.join('\n')) {
    for (const url of list) {
      const row = relayRows.querySelector<HTMLElement>(`.relay-row[data-url="${cssEscape(url)}"]`)
      if (!row) continue
      const probe = relayProbes.get(url)
      row.dataset.status = probe?.status ?? 'unknown'
      const state = row.querySelector('.state')
      if (state) state.textContent = probe ? probe.detail : 'not tested'
    }
    return
  }
  relayPainted = list
  relayRows.replaceChildren()

  for (const [i, url] of list.entries()) {
    const probe = relayProbes.get(url)
    const row = document.createElement('li')
    row.className = 'relay-row'
    row.dataset.status = probe?.status ?? 'unknown'
    row.dataset.url = url

    const dot = document.createElement('span')
    dot.className = 'dot'
    dot.setAttribute('aria-hidden', 'true')

    const label = document.createElement('span')
    label.className = 'url'
    // textContent, never innerHTML: this string came from a paste box.
    label.textContent = url.replace(/^wss:\/\//, '')
    label.title = url

    const up = document.createElement('button')
    up.type = 'button'
    up.className = 'up'
    up.textContent = '\u2191'
    up.title = 'Move up'
    up.setAttribute('aria-label', `Move ${url} up`)
    up.disabled = i === 0
    up.addEventListener('click', () => {
      const next = relayListNow()
      ;[next[i - 1], next[i]] = [next[i], next[i - 1]]
      setRelayList(next)
      say('Order changed. Press Save to keep it.')
    })

    const del = document.createElement('button')
    del.type = 'button'
    del.className = 'del'
    del.textContent = '\u00d7'
    del.title = 'Remove'
    del.setAttribute('aria-label', `Remove ${url}`)
    del.addEventListener('click', () => {
      setRelayList(relayListNow().filter((r) => r !== url))
      say(`Removed ${url}. Press Save to keep it that way.`)
    })

    const state = document.createElement('span')
    state.className = 'state'
    state.textContent = probe ? probe.detail : 'not tested'

    row.append(dot, label, up, del, state)
    relayRows.append(row)
  }
}

function paintSaveButton(list: string[]): void {
  const dirty = list.join('\n') !== relaySnapshot.join('\n')
  relaySave.disabled = !dirty
  relaySave.textContent = dirty ? 'Save changes' : 'Saved'
}

/**
 * Escape a relay URL for the quoted part of an attribute selector.
 *
 * URLs contain a quote or a backslash about as often as never, and "about as
 * often as never" is how a thrown SyntaxError gets shipped.
 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&')
}

async function probeRelay(url: string): Promise<void> {
  relayProbes.set(url, { status: 'checking', detail: 'testing\u2026' })
  paintRelays()
  relayProbes.set(url, await checkRelay(url))
  paintRelays()
}

async function testAllRelays(): Promise<void> {
  const list = relayListNow()
  if (!list.length) return
  relayTest.disabled = true
  relayTest.textContent = 'Testing\u2026'
  try {
    await Promise.all(list.map(probeRelay))
    const ok = list.filter((r) => relayProbes.get(r)?.status === 'ok').length
    say(
      ok === list.length
        ? `All ${ok} answered.`
        : `${ok} of ${list.length} answered. A red dot is a relay this browser cannot reach.`,
      ok === list.length ? 'good' : 'bad',
    )
  } finally {
    relayTest.disabled = false
    relayTest.textContent = 'Test all'
  }
}

function addTypedRelay(): void {
  const typed = relayAddUrl.value.trim()
  if (!typed) return
  const wanted = parseRelayList(typed)
  if (!wanted.length) {
    say(`"${typed}" is not a relay address. It wants to look like wss://relay.example.com.`, 'bad')
    return
  }
  const have = relayListNow()
  const fresh = wanted.filter((r) => !have.includes(r))
  if (!fresh.length) {
    say(wanted.length === 1 ? 'Already in the list.' : 'All of those are already in the list.', 'bad')
    return
  }
  relayAddUrl.value = ''
  setRelayList([...have, ...fresh])
  say(`Added ${fresh.join(', ')}. Press Save to keep it.`)
  // Test what was just added straight away: the commonest reason to add a
  // relay by hand is a typo waiting to happen, and a dot two seconds later is
  // a cheaper way to find it than an empty arena.
  void Promise.all(fresh.map(probeRelay))
}

relayAddUrl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return
  e.preventDefault()
  addTypedRelay()
})
$('relay-add-go').addEventListener('click', addTypedRelay)
relayTest.addEventListener('click', () => void testAllRelays())
// Hand editing through "Edit as text" keeps the rows in step.
relayInput.addEventListener('input', () => paintRelays())

relaySave.addEventListener('click', () => {
  const list = relayListNow()
  if (!list.length) {
    say('You need at least one relay — an empty list would just fall back to the defaults.', 'bad')
    return
  }
  saveRelays(list)
  say(`Saved. ${list.length} relay${list.length === 1 ? '' : 's'}, in this order, from now on.`, 'good')
})

$('relay-reset').addEventListener('click', () => {
  setRelayList([...DEFAULT_RELAYS])
  say('Defaults restored. Press Save to keep them.')
})

/**
 * Write the list, and record that these defaults have now been offered.
 *
 * Both keys move together or the merge rule breaks: `tank.relays.offered` is
 * what stops a default the player deleted on purpose from coming back on the
 * next load, and it is what lets a default added later reach them at all.
 */
function saveRelays(list: string[]): void {
  store('tank.relays', list.join('\n'))
  store('tank.relays.offered', DEFAULT_RELAYS.join('\n'))
  relaySnapshot = list
  paintRelays()
}

relaySnapshot = relayListNow()
paintRelays()

// Nothing is probed until the panel is open. Four sockets on every page load
// would be four sockets per player per load asked of volunteer infrastructure
// for a dot nobody is looking at.
let relaysProbed = false
$('advanced').addEventListener('toggle', () => {
  if (relaysProbed || !($('advanced') as HTMLDetailsElement).open) return
  relaysProbed = true
  void testAllRelays()
})

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

// ------------------------------------------------------- the live-games board

/**
 * Open tables, the way a poker site shows them.
 *
 * A room here is just a string two people agreed on, which is why it needs no
 * server and why nobody can find one. This is the notice board: every client in
 * a room publishes a short-lived presence record, and this adds them up into
 * "three of four seats taken on Pillars, block 912345".
 *
 * Nothing about it is enforced and the footnote says so. A room saying it has a
 * seat free is four people's word, exactly like every number on the
 * leaderboard. The cost of being wrong is that you drive into a busy room,
 * which is a game rather than a crash.
 */
let lobbyNet: Net | null = null
let liveTimer: ReturnType<typeof setInterval> | null = null
let liveRooms: LiveRoom[] = []
/** Set by the Watch button, read once by `begin`, and cleared straight after. */
let watchMode = false

/**
 * A relay pool for the lobby only, built from whatever is in the textarea.
 *
 * Rebuilt when that list changes. Caching it on first use was the obvious
 * thing and was wrong in a way nobody would have reported as a bug: edit your
 * relays in the lobby, hit Refresh, and the pool built at page load keeps
 * querying the relays you just replaced. The list is short and comparing it is
 * free, so there is no reason to be clever about it.
 */
let lobbyRelays = ''
function lobbyPool(): Net {
  const want = readRelays()
  const key = want.join('\n')
  if (lobbyNet && key === lobbyRelays) return lobbyNet
  lobbyNet?.close()
  lobbyRelays = key
  lobbyNet = new Net(want)
  return lobbyNet
}

async function loadLiveRooms(): Promise<void> {
  const rows = $('live-rows')
  try {
    // The standing deathmatch is appended here, not in the fetch: it is a
    // promise the lobby screen makes, not a beacon anybody signed.
    liveRooms = withStanding(await fetchLiveRooms(lobbyPool()))
  } catch {
    rows.textContent = 'Could not reach the relays to look for games.'
    return
  }
  for (const room of liveRooms) {
    for (const o of [...room.players, ...room.queue]) profilePeek(o.pubkey)
  }
  paintLiveRooms()
}

/**
 * Profiles for the lobby, before there is a `Profiles` instance.
 *
 * `Profiles` belongs to a running match and does not exist yet on this screen,
 * so the lobby keeps its own tiny cache. Faces are a nice-to-have here and the
 * list renders without waiting for one — the seat count is the thing people are
 * reading.
 */
const lobbyFaces = new Map<string, Profile | null>()
let facePending = false
function profilePeek(pubkey: string): void {
  if (lobbyFaces.has(pubkey)) return
  lobbyFaces.set(pubkey, null)
  if (facePending) return
  facePending = true
  // One batch a beat later, so twelve players in four rooms is one request.
  setTimeout(() => {
    facePending = false
    const want = [...lobbyFaces].filter(([, v]) => v === null).map(([k]) => k)
    if (!want.length) return
    void lobbyPool()
      .list({ kinds: [0], authors: want.slice(0, 40), limit: 40 })
      .then((events) => {
        let changed = false
        for (const e of events) {
          try {
            const meta = JSON.parse(e.content) as Profile
            lobbyFaces.set(e.pubkey, meta)
            changed = true
          } catch {
            // A kind-0 with unparseable content is one broken profile, not a
            // broken lobby.
          }
        }
        if (changed) paintLiveRooms()
      })
      .catch(() => {})
  }, 400)
}

// ---------------------------------------------------------------- profile

/**
 * The driver's card, in the garage, before there is a game.
 *
 * Puzz: "Users should be able to see their tank and kind 0 info on the
 * landing page and customize their profile and save (publish to the relays)."
 *
 * Connect reads the npub over NIP-07 without starting anything; the kind 0 is
 * fetched over the same `lobbyPool()` the live board uses. Save merges the
 * edited fields OVER the profile as the relays have it — nip05, lud16, banner
 * and anything else this card does not edit survive the publish untouched,
 * because a profile editor that silently strips fields it never showed is a
 * data-loss bug wearing a save button. Guests are told the truth: the
 * dressing room needs a real key, the table never does.
 */
let profilePubkey: string | null = null
let profileMeta: Record<string, unknown> = {}
/**
 * What this npub's own published history adds up to, and the cards it earns.
 *
 * Empty for a guest, and that is the honest reading rather than a punishment:
 * the conditions are defined in terms of what an npub has *published*, and a
 * guest has published nothing. The free cards are free for exactly that reason.
 */
let career: Career = noCareer()
let cardPick: CardId = asCard(stored('tank.card'))

function paintCards(): void {
  const open = unlocked(career)
  $('card-grid').innerHTML = CARDS.map((c) => {
    const has = open.has(c.id)
    // A locked card is shown rather than hidden. "What is there to play for"
    // is most of the value of an achievement, and a grid that only lists what
    // you already have answers it with silence.
    return (
      `<button type="button" data-card="${c.id}" style="--card:${c.hue}" ` +
      `class="card-pick${has ? '' : ' locked'}" ${has ? '' : 'disabled '}` +
      `title="${c.rule}" aria-pressed="${cardPick === c.id}">` +
      `${cardArt(c.id)}<span class="card-name">${c.name}</span>` +
      `<span class="card-rule">${has && !c.free ? 'earned' : c.rule}</span></button>`
    )
  }).join('')
  const mine = cardOf(cardPick)
  $('card-note').textContent = profilePubkey
    ? `Wearing ${mine.name}. Earned cards come from your own signed score records — anyone can check them.`
    : 'Connect an npub to earn cards. A guest wears the free ones, because the conditions are things you publish.'
}

/** Load the career for a connected npub, then repaint what it unlocks. */
async function loadCareer(pubkey: string): Promise<void> {
  try {
    career = await fetchCareer(lobbyPool(), pubkey)
  } catch {
    // A relay that would not answer is not an empty career, so say nothing
    // rather than showing zeros as if they were a result.
    $('profile-career').hidden = true
    return
  }
  const line = $('profile-career')
  line.hidden = false
  line.textContent =
    `${career.rounds} rounds · ${career.kills} kills · ${career.deaths} deaths · ` +
    `best streak ${career.bestStreak} · ${career.blocksWon} blocks won (recent)`
  // A card you no longer qualify for is not a card you keep: the picker is the
  // only place the claim is checked, so it has to re-check on new evidence.
  if (!unlocked(career).has(cardPick)) cardPick = DEFAULT_CARD
  paintCards()
}

paintCards()
// The unlock rules, exposed for the suite. They are pure functions of a career
// — which is itself a pure function of published events — so a test that drives
// them is testing the same thing an outside checker would run, rather than a
// second implementation of the same table.
;(window as unknown as { __cards: unknown }).__cards = { unlocked, noCareer, CARDS }
// And a way to hand the picker a history, for the suite and for a screenshot.
// It goes through the same repaint the real fetch does, so what a picture shows
// is what a player with that record would see rather than a mock of it.
;(window as unknown as { __setCareer: (c: Career) => void }).__setCareer = (c) => {
  career = c
  if (!unlocked(career).has(cardPick)) cardPick = DEFAULT_CARD
  paintCards()
}
$('card-grid').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-card]')
  if (!b || b.disabled) return
  const id = asCard(b.dataset.card)
  if (!unlocked(career).has(id)) return
  cardPick = id
  store('tank.card', id)
  paintCards()
  if (running) for (const p of running.players) p.game.card = id
})

function paintProfileIdent(name: string, picture: string | null, sub: string): void {
  $('profile-name').textContent = name
  $('profile-npub').textContent = sub
  const img = $<HTMLImageElement>('profile-pic')
  if (picture) {
    img.src = picture
    img.hidden = false
  } else {
    img.hidden = true
  }
}

async function connectProfile(): Promise<void> {
  const note = $('profile-note')
  if (!window.nostr) {
    note.textContent =
      'No NIP-07 extension found — a profile follows a real npub. Guest play needs nothing.'
    return
  }
  try {
    const pk = await window.nostr.getPublicKey()
    profilePubkey = pk
    $('profile-connect').hidden = true
    note.textContent = 'looking for your profile…'
    const events = await lobbyPool().list({ kinds: [0], authors: [pk], limit: 4 })
    let newest: NostrEvent | null = null
    for (const e of events) {
      if (e.pubkey === pk && (!newest || e.created_at > newest.created_at)) newest = e
    }
    profileMeta = {}
    if (newest) {
      try {
        const parsed = JSON.parse(newest.content)
        if (parsed && typeof parsed === 'object') profileMeta = parsed as Record<string, unknown>
      } catch {
        // A malformed profile is a missing profile, same rule as `Profiles`.
      }
    }
    void loadCareer(pk)
    const display =
      typeof profileMeta.display_name === 'string' && profileMeta.display_name.trim()
        ? profileMeta.display_name.trim()
        : typeof profileMeta.name === 'string'
          ? profileMeta.name.trim()
          : ''
    const picture = typeof profileMeta.picture === 'string' ? profileMeta.picture : null
    paintProfileIdent(display || shortNpub(pk), picture, shortNpub(pk))
    $<HTMLInputElement>('profile-name-input').value = display
    $<HTMLInputElement>('profile-picture-input').value = picture ?? ''
    $<HTMLInputElement>('profile-about-input').value =
      typeof profileMeta.about === 'string' ? profileMeta.about : ''
    $('profile-edit').hidden = false
    note.textContent = newest
      ? 'This is your kind 0 as the relays have it.'
      : 'No profile on these relays yet — write one.'
  } catch {
    note.textContent = 'Could not read your npub — the extension said no.'
  }
}

async function saveProfile(): Promise<void> {
  if (!window.nostr || !profilePubkey) return
  const note = $('profile-note')
  const name = $<HTMLInputElement>('profile-name-input').value.trim()
  const picture = $<HTMLInputElement>('profile-picture-input').value.trim()
  const about = $<HTMLInputElement>('profile-about-input').value.trim()
  const content: Record<string, unknown> = { ...profileMeta }
  if (name) content.display_name = name
  else delete content.display_name
  if (picture) content.picture = picture
  else delete content.picture
  if (about) content.about = about
  else delete content.about
  note.textContent = 'waiting for the extension…'
  try {
    const signed = await window.nostr.signEvent({
      kind: 0,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify(content),
    })
    const outcome = await lobbyPool().publish(signed)
    profileMeta = content
    paintProfileIdent(name || shortNpub(profilePubkey), picture || null, shortNpub(profilePubkey))
    note.textContent =
      outcome.accepted > 0
        ? `Published — ${outcome.accepted} relay${outcome.accepted === 1 ? '' : 's'} took it.`
        : 'No relay accepted it. Check the list under Controllers and relays.'
  } catch {
    note.textContent = 'Signing was declined.'
  }
}

$('profile-connect').addEventListener('click', () => void connectProfile())
$('profile-save').addEventListener('click', () => void saveProfile())

/** Chip text for a room card, and the words behind it. `pit — CTF 3/8`. */
const MODE_CHIPS: Record<Mode, string> = { dm: 'DM', tdm: 'TDM', ctf: 'CTF', dom: 'DOM' }
const MODE_TITLES: Record<Mode, string> = {
  dm: 'Deathmatch — every tank for itself',
  tdm: 'Team deathmatch',
  ctf: 'Capture the flag',
  dom: 'Domination — hold the points',
}

function paintLiveRooms(): void {
  const rows = $('live-rows')
  if (!liveRooms.length) {
    rows.innerHTML =
      `<p class="fine">No open games right now. Type a room name and start one — ` +
      `whoever you send the link to lands in it, and it will show up here for everyone else.</p>`
    return
  }
  rows.innerHTML = liveRooms
    .slice(0, 8)
    .map((room) => {
      const seats = Array.from({ length: SEATS }, (_, i) => {
        const who = room.players[i]
        // A faint tank in the dashed ring, so an open seat reads as "a tank
        // could be here" rather than as a hole in the row. House icon style.
        if (!who)
          return (
            `<span class="seat free" title="open seat">` +
            `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">` +
            `<rect x="6" y="9" width="12" height="10" rx="2"/>` +
            `<rect x="10.7" y="3" width="2.6" height="8"/>` +
            `<circle cx="12" cy="14" r="3" fill-opacity="0.5"/>` +
            `</svg></span>`
          )
        const face = lobbyFaces.get(who.pubkey) ?? null
        return `<span class="seat taken" title="${escapeHtml(who.name)}">${avatar(
          face,
          face?.name ?? who.name,
          who.hue,
          24,
        )}</span>`
      }).join('')
      const bits: string[] = []
      if (room.layout) bits.push(escapeHtml(room.layout))
      if (room.block) bits.push(`block ${room.block}`)
      if (room.queue.length) bits.push(`${room.queue.length} waiting`)
      if (room.watchers.length) bits.push(`${room.watchers.length} watching`)
      // A placeholder has no beacons to describe it, so it says what it is.
      if (room.standing) bits.push('the standing game — always open')
      const full = room.open === 0
      return (
        `<div class="live-room">` +
        `<div class="lr-top"><b class="lr-name">${escapeHtml(room.room)}</b>` +
        `<span class="lr-mode ${room.mode}" title="${MODE_TITLES[room.mode]}">${MODE_CHIPS[room.mode]}</span>` +
        `<span class="lr-seats ${full ? 'full' : 'open'}">${SEATS - room.open}/${SEATS}</span></div>` +
        `<div class="lr-faces">${seats}</div>` +
        `<div class="lr-fine">${bits.join(' · ') || 'warming up'}</div>` +
        `<div class="lr-actions">` +
        `<button class="tiny" data-join="${escapeHtml(room.room)}">${
          full ? 'Join the queue' : 'Take a seat'
        }</button>` +
        `<button class="tiny ghost" data-watch="${escapeHtml(room.room)}">Watch</button>` +
        `</div></div>`
      )
    })
    .join('')
}

$('live-rows').addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest('button')
  if (!target) return
  const join = target.dataset.join
  const watch = target.dataset.watch
  if (!join && !watch) return
  roomInput.value = join ?? watch ?? ''
  watchMode = Boolean(watch)
  // The card said what this table is playing; clicking it means playing that.
  // Without this, a joiner carried their own remembered mode into someone
  // else's game — the exact per-client drift this rework removes.
  const info = liveRooms.find((r) => r.room === roomInput.value)
  if (info) setMode(info.mode)
  // Guest, because a click on a room in the lobby should put you in it. Anyone
  // who wants their npub on the board uses the button above; a spectator has
  // nothing to sign anyway.
  void begin(async () => Identity.guest())
})

$('live-refresh').addEventListener('click', () => {
  $('live-rows').textContent = 'looking for open tables…'
  void loadLiveRooms()
})

/** Poll while the lobby is on screen, and stop the moment it is not. */
function watchLobby(on: boolean): void {
  if (liveTimer) clearInterval(liveTimer)
  liveTimer = null
  if (!on) return
  void loadLiveRooms()
  // Slow on purpose. A lobby refresh is a REQ to every relay in the pool, the
  // beacons it reads only change every thirty seconds, and this game has spent
  // real debugging time on being a noisy client.
  liveTimer = setInterval(() => void loadLiveRooms(), 15_000)
}

watchLobby(true)


/**
 * Kills and deaths, as two facts rather than as a fraction.
 *
 * `3 / 1` is a ratio, and it is read as one — which is wrong, because a round
 * where you killed three and died once is not "three over one", it is two
 * separate numbers that happen to sit next to each other. A crosshair and a
 * skull say which is which at a glance and stop the slash doing work it was
 * never doing.
 *
 * The icons are inline SVG in `currentColor` on purpose: no request, no font,
 * and they inherit the colour of the row they sit in, so the winner's line and
 * a dimmed line do not need two copies.
 */
const ICONS = {
  // Drawn for twelve pixels, not for a style guide. The first version was a
  // fine crosshair — a thin ring with four ticks — and at the size it is
  // actually rendered it read as a smudge. Fewer, fatter, filled shapes.
  kills:
    '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="8" cy="8" r="1.9" fill="currentColor"/></svg>',
  deaths:
    '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2c-3.2 0-5.6 2.3-5.6 5.3 0 1.8.9 3.1 1.9 3.9v1.6c0 1 .8 1.8 1.8 1.8h3.8c1 0 1.8-.8 1.8-1.8v-1.6c1-.8 1.9-2.1 1.9-3.9 0-3-2.4-5.3-5.6-5.3z" fill="currentColor"/><circle cx="5.8" cy="6.6" r="1.6" fill="#0b0f18"/><circle cx="10.2" cy="6.6" r="1.6" fill="#0b0f18"/><path d="M7.2 10.4h1.6v3h-1.6z" fill="#0b0f18"/></svg>',
}

/** One row's kills and deaths, iconised. `extra` is appended verbatim. */
const kd = (kills: number, deaths: number, extra = ''): string =>
  `<span class="kd"><span class="stat kills" title="kills">${ICONS.kills}${kills}</span>` +
  `<span class="stat deaths" title="deaths">${ICONS.deaths}${deaths}</span>${extra}</span>`

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

/**
 * Keep saying we are here, so the lobby can show this room to somebody else.
 *
 * The role is decided *once*, at join, against the lobby list we already had —
 * not recomputed each beacon. Recomputing would mean a player's own seat
 * flickering between `seat` and `queue` as beacons expire and land, and the
 * lobby would show a table whose size changes every thirty seconds.
 *
 * The one exception is a queued player: they are watching for a seat, and when
 * one frees up they take it. That is the waiting list, and it is honest about
 * being advisory — two queued players can both see the same seat open and both
 * take it, which makes a five-tank room for one round rather than a crash.
 */
function startBeacon(
  game: Game,
  clock: BlockClock,
  role: Role,
  board?: string,
  listed = true,
): void {
  let current = role
  const send = () => {
    // A queued player takes the seat the moment the room has room for it.
    // `peers` is the live roster off the tick stream, which is a better witness
    // than the lobby's thirty-second beacons — it is literally the set of tanks
    // on screen. Two queued players can both see the same seat open and both
    // take it; that makes a five-tank room for one round, not a crash, and
    // there is no server here to arbitrate it.
    if (current === 'queue' && game.peers.size < SEATS) {
      current = 'seat'
      // `takeSeat` puts its own line in the feed, which is where a player is
      // already looking for "who took what" during a round.
      game.takeSeat()
    }
    void publishPresence(
      game.identity,
      game.net,
      game.room,
      game.name,
      game.displayColor,
      current,
      clock.tip?.height,
      layoutName,
      // The room's rules, restated every beacon: this is how the live board
      // labels the table and how the next joiner knows what game this is.
      mode,
      board,
      listed,
      // Read at send time, not captured at join: the stepper is live mid-game
      // and the room's declared crew should follow it.
      botsWanted,
    ).catch(() => {
      // A refused beacon costs this room a line in somebody's lobby for thirty
      // seconds. It is not worth a message on top of a game.
    })
  }
  send()
  const timer = setInterval(send, BEACON_EVERY_MS)
  window.addEventListener('pagehide', () => clearInterval(timer))
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
    // Pressing Play still saves the list — the Save button is an addition, not
    // a replacement. Through `saveRelays` so the editor's "unsaved changes"
    // badge clears instead of lying about a list that was just written.
    saveRelays(relays)

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

    // Read once and cleared, so a Watch click does not stick to the next join.
    const wantWatch = watchMode
    watchMode = false
    const live = liveRooms.find((r) => r.room === room)
    const occupied = !!live && live.players.length + live.queue.length + live.watchers.length > 0
    // The room's rules beat the remembered preference: mode is a property of
    // the room, declared by whoever is already in it. An empty room has no
    // rules yet — the first player through the door is the creator, and their
    // pick stands and goes out on their beacon.
    if (occupied) {
      setMode(live.mode)
      // The pin travels the same way. An occupied room that follows the chain
      // must also *clear* a leftover pick, or the joiner plays a different
      // board from everyone in it.
      boardSelect.value = live.board && boardIndexOf(live.board) !== null ? live.board : ''
      // And the crew: the room's declared bot count is how populated its
      // creator wants it to feel, and each human seat replaces one bot.
      if (live.bots !== undefined) setBots(live.bots)
    }
    // Settled for the whole match: the block callbacks below close over it.
    const pin = boardIndexOf(boardSelect.value || null)
    // A room that reached us through the lobby list is listed by definition —
    // one joiner's leftover Private pick must not make them the only player
    // whose beacon goes quiet.
    const listed = occupied || visibilityInput.value !== 'private'
    // The seat decision has to happen *before* the game is built, because a
    // queued player is constructed as a spectator and promoted later. Deciding
    // it afterwards would put a fifth tank on a four-seat board and then try to
    // take it away again.
    const role = seatFor(live, wantWatch)
    const watching = role !== 'seat'
    // Nobody watches on two screens at once, and a spectator has no tank for a
    // second player to share a keyboard with.
    const twoPlayer = playersInput.value === '2' && !watching
    store('tank.players', twoPlayer ? '2' : '1')

    const skin = asSkin(skinInput.value)
    store('tank.skin', skin)

    const net = new Net(relays)
    const profiles = new Profiles(net)
    const wornSkin = wornCustomSkin()
    const game = new Game(
      identity, net, room, name, color, watching, skin, cardPick,
      wornSkin?.slug ?? null, wornSkin?.art ?? null, [...stickerPicks],
    )
    // Only player one has an ear. Two local players share one set of speakers,
    // and every event player two publishes is already heard here as a peer —
    // positioned, through the same code a remote player's shot goes through. A
    // second sink would play the same shot twice.
    game.sfx = (sound, opts) => sfx.play(sound, opts)
    await game.start()
    // The worn art, republished so peers can dress this tank. Addressable and
    // tiny, sent at the same moment as the attestation so a NIP-07 signer
    // asks once per sitting rather than ambushing mid-round. A decline is a
    // costume that stays local — nothing else is affected.
    void publishWornSkin(game)

    const players: Player[] = [{ game, input: new Input(canvas, { ...SOLO }) }]
    // Player one owns the glass. There is no second thumb pair on a phone, and
    // the couch bindings never read this.
    players[0].input.touch = sticks

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
      // Player two wears the same skin. It is a setting on the machine, not on
      // the identity — there is one lobby and one picker in front of one couch.
      const p2 = new Game(second, secondNet, room, `${name}-2`, (color + 137) % 360, false, skin, cardPick)
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
    /**
     * A block closed: bank every local player's round, publish, show the podium.
     *
     * Pulled out of the `onBlock` callback so a suite can drive the real thing
     * rather than a re-implementation of it. test/autopublish.mjs calls this;
     * if it called `autoPublishRound` directly it would be testing the
     * publisher given a result, which cannot tell you whether a block closing
     * ever produces one.
     */
    const closeBlock = (height: number, hash: string): void => {
      // A pinned room plays its board every round; `setLayout` early-returns
      // on the repeat and `resetCover` in `beginRound` still restores the
      // barrels — the same path two chain rounds landing on one board take.
      setLayout(pin ?? layoutForBlock(hash))
      // Every local player banks their own round; only player one's podium is
      // shown, because there is one screen.
      let shown: ReturnType<Game['endRound']> | null = null
      for (const p of players) {
        const result = p.game.endRound(height, layoutName)
        if (!shown) shown = result
        p.game.beginRound(height, hash)
      }
      if (shown) {
        // Before the podium, not after: the podium closes itself after nine
        // seconds and a player who drives off does not come back to press it.
        autoPublishRound(shown)
        showPodium(shown)
      }
    }
    ;(window as unknown as { __closeBlock: typeof closeBlock }).__closeBlock = closeBlock

    clock.onBlock((tip, previous) => {
      if (!previous) {
        // First tip of the session — this is the round we joined, not a new one.
        setLayout(pin ?? layoutForBlock(tip.hash))
        for (const p of players) p.game.beginRound(tip.height, tip.hash)
        return
      }
      closeBlock(tip.height, tip.hash)
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
    // The garage hands its WebGL context back the moment a match starts. A
    // lobby preview still spinning behind a firefight is exactly the kind of
    // thing that surfaces as "the game got laggy".
    preview?.dispose()
    preview = null
    running = { players, renderer, clock, profiles }
    // The side is settled now: the HUD button flips from control to badge.
    sideLocked = true
    paintTeamButton()
    // The ladder, once, in the feed. The strip on the HUD says what is next;
    // this says what exists, which is a question you ask on the way in and
    // never again.
    announceLadder(game)
    $('hint-p2').hidden = !twoPlayer
    // A profile landing has to repaint immediately: the HUD throttles itself to
    // eight frames a second and would otherwise show the npub for another beat
    // after the picture was already in hand.
    profiles.onChange(() => {
      hudAt = 0
      // The board is a modal that renders once and then sits there. Without
      // this, a leaderboard opened a second before the kind-0 events landed
      // showed short npubs for as long as it stayed open.
      if (!board.hidden) paintBoard()
    })
    // Exposed on purpose: the two-player smoke test in test/ drives the match
    // through this handle, and it is genuinely useful in the console.
    ;(window as unknown as { __game: Game; __renderer: Renderer }).__game = game
    ;(window as unknown as { __renderer: Renderer }).__renderer = renderer
    ;(window as unknown as { __clock: BlockClock }).__clock = clock
    ;(window as unknown as { __sfx: Sfx }).__sfx = sfx
    ;(window as unknown as { __profiles: Profiles }).__profiles = profiles
    ;(window as unknown as { __players: Player[] }).__players = players
    // The live board, for test/barrels-browser.mjs. Destructible cover is the
    // one piece of shared state that is not derived from the block hash, so a
    // suite has to be able to read the actual rects rather than infer them.
    ;(window as unknown as { __arena: unknown }).__arena = arena
    // The room-shape constants, for test/rooms suites. `SEATS` is a lobby
    // number rather than a rule, and a suite has to be able to read the one the
    // build actually shipped rather than the one it was written against.
    ;(window as unknown as { __rooms: unknown }).__rooms = { SEATS }
    // The bomb-run rule, for test/arsenal.mjs. A suite that builds a fake
    // peer's strike has to build the one a real client would send on *this*
    // board, and a hand-written bomb count is a number that was true when there
    // was one board — see the note in `bombsFor`.
    ;(window as unknown as { __strike: unknown }).__strike = {
      bombsFor,
      STRIKE_GAP,
      STRIKE_RADIUS,
    }
    // The flag rules, for test/flags.mjs. `carriers` is the one function in the
    // game whose whole claim is that two clients hearing the same input agree,
    // and the only way to check that is to run it twice with the input in a
    // different order.
    ;(window as unknown as { __flags: unknown }).__flags = flags
    // Tuning constants a suite should not hardcode. `paintChopper` divided the
    // countdown by a literal 10 and sat pinned full for the first half of a
    // twenty-second reward; two checks in test/chopper-browser.mjs had the same
    // literal and went red on correct code. A duration written down in three
    // places is a duration that will disagree with itself.
    ;(window as unknown as { __tuning: unknown }).__tuning = { CHOPPER_MS }

    // Faces on the tanks. The renderer asks by pubkey and never learns what a
    // relay is; `Profiles.get` queues an unknown npub for the next batch and
    // answers with a placeholder, so calling it once per tank per frame is free.
    renderer.setPictureSource((pubkey) => (pubkey ? profiles.get(pubkey).picture : null))
    // The stored preference reaches the fresh `Game` — player one's only.
    // Bots replace humans one for one now, so a second game running its own
    // would no longer zero itself out — and player two's bots would be tanks
    // the shared screen never draws (only player one's game is rendered) that
    // still put real shells into player two. Invisible damage is not a game.
    players[0].game.botsWanted = botsWanted
    for (const p of players.slice(1)) p.game.botsWanted = 0
    // The remembered side reaches the fresh `Game`, and player two shares it —
    // two people on one couch are on one team unless they say otherwise, which
    // is what a couch is.
    for (const p of players) p.game.team = teamPick
    // The mode reaches the fresh `Game`. Flags are only on in the one mode that
    // has them, which is why this is not derived from `team`.
    for (const p of players) {
      p.game.flagsOn = mode === 'ctf'
      p.game.pointsOn = mode === 'dom'
      // The ladder the lobby arranged. A lobby setting like the two above.
      p.game.setLoadout(loadout)
    }
    // Repainted here rather than at module load: the default depends on whether
    // this session is a guest, and that is not known until a game exists.
    paintAutoPublish()
    cockpitAllowed = !twoPlayer
    if (!cockpitAllowed) view = 'board'
    renderer.setView(view)
    for (const p of players) p.input.hullRelative = view === 'cockpit'
    paintView()

    canvas.addEventListener('mousemove', (e) => {
      cursor = { x: e.clientX, y: e.clientY }
      const world = renderer.toWorld(e.clientX, e.clientY)
      for (const p of players) if (p.input.binding.mouse) p.input.mouseWorld = world
    })

    const url = new URL(location.href)
    url.searchParams.set('room', room)
    // The invite link carries the whole game. Copy-link copies `location.href`
    // verbatim, so a friend handed a CTF room lands in CTF on the right board
    // even before the first beacon reaches their relay — and a private room's
    // link keeps saying private, or the friend's own beacon would list it.
    // The defaults (dm, chain, public) are the absent values, same as on the
    // beacon.
    if (mode !== 'dm') url.searchParams.set('mode', mode)
    else url.searchParams.delete('mode')
    if (pin !== null) url.searchParams.set('board', boardSlug(arena.LAYOUTS[pin].name))
    else url.searchParams.delete('board')
    if (!listed) url.searchParams.set('private', '1')
    else url.searchParams.delete('private')
    if (botsWanted !== BOT_COUNT) url.searchParams.set('bots', String(botsWanted))
    else url.searchParams.delete('bots')
    history.replaceState(null, '', url)

    // The lobby's own relay pool and its poll are for the lobby. Leaving them
    // running would mean a second socket per relay for the whole match, and a
    // REQ every fifteen seconds behind a game that is already the noisiest
    // thing this client does.
    watchLobby(false)
    lobbyNet?.close()
    lobbyNet = null
    startBeacon(game, clock, role, pin !== null ? boardSlug(arena.LAYOUTS[pin].name) : undefined, listed)

    lobby.hidden = true
    hud.hidden = false
    paintTouchAffordances()
    // Best effort, and deliberately unreported. Android gives us the whole
    // screen and will hold the rotation; iOS Safari refuses both and the game
    // is played in the browser chrome, which is why the install prompt and the
    // rotate screen exist. Neither refusal is worth a message.
    if (sticks.touched) {
      void document.documentElement.requestFullscreen?.().then(
        () => {
          const orientation = screen.orientation as ScreenOrientation & {
            lock?: (o: string) => Promise<void>
          }
          void orientation?.lock?.('landscape').catch(() => {})
        },
        () => {},
      )
    }
    loop()
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  } finally {
    buttons.forEach((b) => (b.disabled = false))
  }
}

// ------------------------------------------------------------------- loop

let last = 0
/**
 * The last place the mouse was seen, in client pixels.
 *
 * Board view only needs this on `mousemove`, because the point the cursor picks
 * out on the board does not move when the tank does. Cockpit view does: the aim
 * arc is measured from the hull, and the hull turns while the cursor sits
 * perfectly still. Without re-reading it every frame the turret holds a stale
 * world angle and then snaps the next time the mouse twitches.
 */
let cursor: { x: number; y: number } | null = null

function loop(now = performance.now()): void {
  if (!running) return
  requestAnimationFrame(loop)
  // Clamp so a backgrounded tab does not teleport everything on return.
  const dt = Math.min(0.05, last ? (now - last) / 1000 : 0)
  last = now

  const { players, renderer } = running
  if (renderer.viewMode === 'cockpit' && cursor) {
    const world = renderer.toWorld(cursor.x, cursor.y)
    for (const p of players) if (p.input.binding.mouse) p.input.mouseWorld = world
  }
  // Every local player steps in the same frame, before anything is drawn.
  // Player two's events reach player one's game inside `update` — see
  // `Game.localMirror` — so drawing after both have stepped is what makes the
  // couch latency actually zero rather than one frame.
  for (const p of players) p.game.update(dt, p.input.read(p.game.tank))
  const local = new Set(players.map((p) => p.game.identity.sessionPubkey))
  // The kill cam, if one is running. The game keeps stepping and keeps
  // publishing underneath it — a client that stopped ticking for two and a half
  // seconds would go silent on everybody else's board at the exact moment it is
  // most interesting to them — and only the *drawing* comes from the tape.
  const cam = killcamFrame(players[0].game)
  if (cam) renderer.replay(players[0].game, cam.frame, cam.killer, cam.anchor)
  else renderer.draw(players[0].game, local)
  // The cockpit is a tank's eye. While the chopper is up there is no tank to
  // sit in, and the view a gunship needs is the one that shows the whole board
  // anyway — so it switches, and switches back on landing. The player's choice
  // is remembered and restored rather than overwritten.
  syncFlyingView(players[0].game, renderer)
  paintCrosshair(players[0].game, renderer.viewMode)
  paintChopper(players[0].game)
  paintDeath(players[0].game)
  paintSuit(players[0].game)
  paintEmp(players[0].game)
  paintDamage(players[0].game, renderer.viewMode)
  paintAmmo(players[0].game)
  drawHud(players[0].game)
  drawSecondPlayer(players[1] ?? null, now)
}

/**
 * The cockpit's reload readout, on the reticle itself.
 *
 * Board view puts a bar on the ground under the health pips. That bar draws
 * with `depthTest: false` at the tank's own position, so from inside the tank
 * it is a flat orange square stuck over the middle of the screen — the bug
 * Puzz reported as "a yellow box when shooting". The renderer hides it in
 * cockpit now, and this replaces the information rather than dropping it.
 *
 * The ticks bloom outward and close back as the gun loads, which is the oldest
 * reticle idiom there is and needs no legend. Painted from `loop` rather than
 * `drawHud`, because the HUD repaints on a 120ms throttle and a reload is
 * 1.05s — nine steps would read as a ratchet.
 */
const RELOAD_BLOOM = 9
function paintCrosshair(game: Game, view: ViewMode): void {
  const el = $('crosshair')
  if (view !== 'cockpit') {
    if (el.classList.contains('loading')) {
      el.classList.remove('loading')
      el.style.removeProperty('--bloom')
    }
    return
  }
  const remaining = game.tank.reloadAt - performance.now()
  const loading = remaining > 0 && !game.tank.dead
  el.classList.toggle('loading', loading)
  // `frac` is how much of the reload is left, so the bloom is widest at the
  // shot and zero at the moment the gun is ready.
  const frac = loading ? Math.min(1, remaining / (RELOAD * 1000)) : 0
  el.style.setProperty('--bloom', `${(frac * RELOAD_BLOOM).toFixed(1)}px`)
}

/**
 * Keep the key hints clear of the action buttons, whatever is in the row.
 *
 * Both are absolutely positioned along the bottom of the screen from opposite
 * sides and neither can see the other, so the hints used to be painted behind
 * the buttons. Reserving a fixed width in CSS fixed it for exactly one push —
 * the next button added put them back on top of each other by 145px. Measuring
 * the row and publishing it as `--actions-w` makes the reserve a fact rather
 * than a promise that nobody will add another button.
 *
 * A `ResizeObserver`, not a resize listener: the row changes width when its
 * *contents* change — a label going from "Bots: on" to "Bots: off", a button
 * appearing — and the window has not moved at all when that happens.
 */
function watchActionsWidth(): void {
  const row = $('hud-actions')
  const hint = $('controls-hint')
  const publish = () => {
    const w = Math.round(row.getBoundingClientRect().width)
    if (w > 0) document.documentElement.style.setProperty('--actions-w', `${w}px`)

    // Hidden outright when the reserve leaves too little to read. Clearing the
    // overlap is not the same as being legible: at a 1024px window with seven
    // buttons the hints had 51px of width, wrapped to one word a line and stood
    // 488px tall — a column of single words up the side of the board, with the
    // 999px pill radius rounding it into a dark circle. Below a readable width
    // they are worth less than the space they take.
    const room = document.documentElement.clientWidth - w - 30
    // 320, not 220. The bar has grown again — a bots stepper and a team button
    // since that number was picked — and at 240px of room the hints still
    // wrapped to five lines. The threshold is "enough to read a couple of hints
    // on one line", and it will need raising again the next time a button
    // lands, which is why the radius above no longer depends on it.
    hint.classList.toggle('cramped', room < 320)

    // And how tall they ended up, which the kill feed sits above. Every button
    // added on the right makes the hints one line taller on the left, and the
    // feed's `bottom` was a constant sized for one line — at three the feed
    // printed straight through them.
  }

  /**
   * The hint row's own height, published from its own observer.
   *
   * Separate from `publish` on purpose, and the two attempts before this are
   * why. Measuring in the same pass that toggles `cramped` reads the box as it
   * was — it wrote 56px for a row that had just become 102px. Deferring that
   * read to `requestAnimationFrame` swapped one bug for a worse one: `publish`
   * runs several times as the bar settles, so an early frame's callback lands
   * *after* a later one and overwrites the right answer with a stale one.
   *
   * A ResizeObserver on the element itself has neither problem. It fires after
   * layout, by definition, and only when this box actually changed size — which
   * includes the frame `cramped` takes it to zero and the frame it comes back.
   */
  const publishHeight = () => {
    let h = Math.round(hint.getBoundingClientRect().height)
    // A hidden hint row measures zero, and zero is the wrong reserve: with the
    // hints gone (a phone's `hud-compact`, or `cramped` on a narrow window)
    // the magazine is what lives along the bottom edge, and a feed that only
    // cleared the hints printed its kill lines straight through the ammo pips.
    // Reserve the magazine's height instead — measured, like everything else
    // here, because the pips and the word under them are two more layouts that
    // will not stay the same size forever.
    if (h === 0) h = Math.round($('ammo').getBoundingClientRect().height)
    document.documentElement.style.setProperty('--hint-h', `${h}px`)
  }

  publish()
  publishHeight()
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(publish).observe(row)
    new ResizeObserver(publishHeight).observe(hint)
    new ResizeObserver(publishHeight).observe($('ammo'))
  }
  window.addEventListener('resize', () => {
    publish()
    publishHeight()
  })
}
watchActionsWidth()

/**
 * The board camera, for as long as the chopper is up.
 *
 * The cockpit is a tank's eye, and while flying there is no tank to sit in.
 * What is stored is what the player *chose*, so a cockpit player is put back in
 * the cockpit the moment they land rather than quietly converted to a board
 * player by a reward.
 */
let viewBeforeFlight: ViewMode | null = null
function syncFlyingView(game: Game, renderer: Renderer): void {
  if (game.flying) {
    if (viewBeforeFlight === null && renderer.viewMode === 'cockpit') {
      viewBeforeFlight = 'cockpit'
      setView('board')
    }
    return
  }
  if (viewBeforeFlight !== null) {
    const back = viewBeforeFlight
    viewBeforeFlight = null
    if (cockpitAllowed) setView(back)
  }
}

/**
 * The gunship clock, and what to do with it.
 *
 * Painted every frame rather than from `drawHud`: this is a ten-second window
 * and the HUD repaints on a 120ms throttle, which would show it counting down
 * in eight visible steps. The reticle bloom is on the same rule for the same
 * reason.
 */
/**
 * An enemy EMP: the HUD goes dark, the arena does not.
 *
 * Painted from `loop` rather than the throttled `drawHud`, because four
 * seconds of blackout that arrives 120ms late reads as a glitch rather than
 * as a hit. The class does the hiding in CSS — one toggle, not a dozen
 * elements to remember — and the `#emp` pill is the single thing left lit,
 * so the player knows they were hit rather than that the game broke.
 */
function paintEmp(game: Game): void {
  const down = game.empUntil > performance.now()
  document.body.classList.toggle('emp', down)
  $('emp').hidden = !down
}

/**
 * The juggernaut clock, in the same place and shape as the chopper's.
 *
 * Deliberately the same element style rather than a new one: both are "you are
 * not in your tank, and here is how long for", and a player who has learned to
 * read one should not have to learn the other. The hint line differs because
 * the controls do — there is no flying, and the trigger is held rather than
 * tapped.
 */
function paintSuit(game: Game): void {
  const el = $('suit')
  const left = game.suitLeft
  const up = left > 0
  el.hidden = !up
  if (!up) return
  el.innerHTML =
    `<b>JUGGERNAUT</b> <span class="chopper-clock">${left.toFixed(1)}s</span>` +
    `<span class="chopper-hint">walk it forward · hold fire to hose them down</span>`
  el.style.setProperty('--left', String(Math.max(0, Math.min(1, left / (SUIT_MS / 1000)))))
}

/**
 * The death card: who killed you, and what they were on when they did.
 *
 * Puzz asked for a kill cam — *"show a replay recording from the view of the
 * player who killed you. It should display the killer's profile picture and
 * calling card."* This is the card half, and the reason it is not the replay
 * half is written next to `Game.lastDeath`: a replay assembled from the
 * position ticks that happened to arrive is a plausible animation of something
 * that did not happen. What is on this card is all known for certain.
 *
 * Everything comes off `game.lastDeath`, which is captured at the instant of
 * death rather than read live — the killer is still playing, and a card that
 * updated their streak while the victim read it would be describing a different
 * moment than the one it is about.
 *
 * The calling card is a slot rather than a stub: when the calling-cards issue
 * lands, it goes under the name and nothing else here moves.
 */
function paintDeath(game: Game): void {
  const node = $('death')
  const d = game.lastDeath
  // Only while dead. A card that outlived the respawn would be a screen you
  // have to dismiss in the middle of a firefight.
  if (!d || !game.tank.dead || game.watching) {
    node.hidden = true
    return
  }
  const left = Math.max(0, (game.tank.respawnAt - performance.now()) / 1000)
  const profile = d.pubkey ? (running?.profiles.get(d.pubkey) ?? null) : null
  const self = d.killer === null
  // A fall is its own way to go. "YOU BLEW YOURSELF UP" over a tank that
  // quietly drove off the rim is the card calling the player a liar.
  const title = self ? (d.fell ? 'YOU FELL OFF THE BOARD' : 'YOU BLEW YOURSELF UP') : 'KILLED BY'
  // A bot kill costs nothing on the board and the card says so, because the
  // scoreboard not moving is otherwise the kind of thing that reads as a bug.
  const note = self
    ? 'nobody else takes the credit'
    : d.bot
      ? 'a practice tank — costs you nothing on the board'
      : d.streak > 2
        // "on a 11 streak" reads as a typo to everybody who sees it. Eight,
        // eleven, eighteen and anything starting with those take "an".
        ? `on ${/^(8|11|18)/.test(String(d.streak)) ? 'an' : 'a'} ${d.streak} streak`
        : `${d.kills} kills this round`
  node.hidden = false
  // Out of the middle while the replay is running: the centre of the screen is
  // where the kill cam's subject is, and a card parked over it is a card that
  // hides the thing it is describing.
  node.classList.toggle('replaying', !!game.killcam)
  node.style.setProperty('--killer', String(d.hue))
  node.innerHTML =
    `<span class="death-title">${title}</span>` +
    (self
      ? ''
      : `<span class="death-who">${avatar(profile, d.name, d.hue, 56)}` +
        `<span class="death-name">${escapeHtml(d.name)}${nip05Badge(profile)}</span>` +
        // The slot the card half of this issue left open, now filled: their
        // badge and its name, in its own colour. It is what they claim rather
        // than what this client verified — see `src/cards.ts` — and it is a
        // costume, so that is the right trade.
        `<span class="death-card-slot" style="--card:${cardOf(d.card).hue}">` +
        `${cardArt(d.card, 'card-art small')}${cardOf(d.card).name}</span></span>`) +
    `<span class="death-note">${escapeHtml(note)}</span>` +
    `<span class="death-clock">back in <b>${left.toFixed(1)}s</b></span>`
}

function paintChopper(game: Game): void {
  const el = $('chopper')
  const left = game.chopperLeft
  const up = left > 0
  el.hidden = !up
  if (!up) return
  el.innerHTML =
    `<b>CHOPPER</b> <span class="chopper-clock">${left.toFixed(1)}s</span>` +
    `<span class="chopper-hint">drive to fly · hold fire to rake the ground</span>`
  // Against the real duration, not a hardcoded ten. Doubling `CHOPPER_MS` to
  // twenty seconds left this dividing by 10, so the bar clamped to full for the
  // entire first half of the reward and only started moving at the halfway
  // point. Caught by P.F. Chang reading the diff rather than by me writing it.
  el.style.setProperty('--left', String(Math.max(0, Math.min(1, left / (CHOPPER_MS / 1000)))))
}

/**
 * Damage, on the edges of the screen, in cockpit view only.
 *
 * The board camera says this with the tank: soot, a smoke column off the rear
 * deck, then flame. From inside the tank that emitter is *behind the near
 * plane* — a burning tank in first person filled a 1280x800 screenshot with
 * cream and orange and left one corner of green felt, which is what Puzz was
 * looking at when he said the damage UI in first person is too much to see
 * through. `Renderer.wear` now takes the plume off your own tank in this view,
 * and this is where the information went instead.
 *
 * Same pattern as `paintCrosshair` above: the cockpit does not drop what the
 * board camera showed, it moves it somewhere a driver can look through. The
 * edges are the one part of a first-person frame nobody aims with.
 *
 * `--wear` is 0 at full hull and 1 at one hit from dead, so the glow rises with
 * the damage the way the plume's spawn rate does rather than snapping between
 * two states. A dead tank shows nothing — the death screen is its own thing and
 * a corpse is not "hurt".
 */
function paintDamage(game: Game, view: ViewMode): void {
  const el = $('damage')
  const { hp, dead } = game.tank
  const maxHp = game.maxHp
  // Glass Cannon plays at one hull, where every hit kills: there is no damaged
  // state to show, and the same reasoning is in `wear` for the plume.
  const hurt = view === 'cockpit' && !dead && !game.watching && maxHp > 1 && hp < maxHp && hp > 0
  el.hidden = !hurt
  if (!hurt) {
    el.classList.remove('burning')
    return
  }
  const wear = Math.min(1, Math.max(0, (maxHp - hp) / (maxHp - 1)))
  el.style.setProperty('--wear', wear.toFixed(2))
  el.classList.toggle('burning', hp === 1)
}

/**
 * The magazine, painted every frame.
 *
 * Every frame rather than from `drawHud`, for the same reason as the reticle
 * bloom above: the HUD repaints on a 120ms throttle, and a 2.4-second reload
 * drawn in twenty steps reads as a ratchet rather than as a bar. It is also the
 * one readout a player is watching *while* deciding whether to push, so a
 * tenth of a second of lag in it is a tenth of a second of lying.
 *
 * The pip elements are built once and reused. Rebuilding four nodes a frame is
 * cheap enough not to matter and still wrong: it throws away the CSS transition
 * on every repaint, so the fill would jump instead of sweeping.
 */
let ammoPips: HTMLElement[] = []
function paintAmmo(game: Game): void {
  const box = $('ammo')
  if (game.watching) {
    box.hidden = true
    return
  }
  box.hidden = false
  if (ammoPips.length !== MAG_SIZE) {
    const row = $('ammo-pips')
    row.innerHTML = ''
    ammoPips = Array.from({ length: MAG_SIZE }, () => {
      const pip = document.createElement('i')
      pip.className = 'pip'
      row.appendChild(pip)
      return pip
    })
  }

  const now = performance.now()
  const reloading = game.tank.reloadingUntil > now && !game.tank.dead
  const ammo = game.tank.dead ? MAG_SIZE : game.tank.ammo
  box.classList.toggle('reloading', reloading)
  box.classList.toggle('dry', !reloading && ammo === 0)
  if (reloading) {
    // How far *through* the reload we are, so the pips fill up rather than
    // draining — a bar that empties as you get closer to being ready is the
    // wrong way round and people read it without thinking.
    // Measured against the reload's *own* start and end rather than against the
    // nominal duration: rapid fire shortens the reload, and a bar scaled to the
    // full length would fill three fifths of the way and then jump.
    const span = game.tank.reloadingUntil - game.tank.reloadingFrom
    const done = span > 0 ? (now - game.tank.reloadingFrom) / span : 1
    box.style.setProperty('--load', String(Math.max(0, Math.min(1, done))))
  } else {
    box.style.removeProperty('--load')
  }
  for (const [i, pip] of ammoPips.entries()) {
    const live = !reloading && i < ammo
    pip.classList.toggle('live', live && ammo > 1)
    pip.classList.toggle('last', live && ammo === 1)
  }
  $('ammo-word').textContent = reloading ? 'reloading' : ammo === 0 ? 'empty' : ''
}

let hudAt = 0
/** Matches `READ_SILENCE_MS` in game.ts; only used for the sentence. */
const READ_SILENCE_S = 12
const host = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Which buff timer each pickup runs. `repair` is instant and has none. */
const BUFF_TIMERS: Partial<Record<PickupKind, keyof Buffs>> = {
  rapid: 'rapidUntil',
  shield: 'shieldUntil',
  speed: 'speedUntil',
  scatter: 'scatterUntil',
  siege: 'siegeUntil',
}

/** What the feed last painted, so per-frame paints only touch the DOM on change. */
let lastFeedHtml = ''

function drawHud(game: Game): void {
  const now = performance.now()
  if (now - hudAt < 120) return
  hudAt = now

  // The scoreboard is a card per player now: their kind 0 picture, the callsign
  // they chose for the match, and their verified NIP-05 underneath it. A guest
  // key has no profile to fetch and falls back to a coloured initial, which is
  // the point — playing without an identity stays a first-class option.
  const profiles = running?.profiles
  // Sides first, when there are any. Two rows of "Red 7 — Blue 5" above the
  // players is the only thing a team game needs that a deathmatch does not, and
  // it is drawn from the same standings rather than from a second tally.
  //
  // `teamStandings` returns null until at least two sides have somebody on
  // them, which is the right threshold: a team of one is a person, and a
  // scoreboard that grows a "Red 0 — 0" header the instant you press T would
  // be reporting a game nobody is playing.
  // Captures first when anybody has one. A flag game's score is not the kill
  // tally, and a scoreboard that led with kills would be reporting the wrong
  // game — but only once somebody has actually scored, so a team round that
  // nobody is playing flags in reads exactly as it did before.
  // Points held, when there are any. A domination score is "who holds what
  // *now*" as much as "who has taken most", and the second without the first is
  // a scoreboard that cannot tell you whether you are winning.
  const held = game.pointsOn ? game.territory : []
  const heldRows = held.length
    ? `<div class="team-tally points">${(() => {
        const by = new Map<number, number>()
        for (const t of held) if (t.state.owner) by.set(t.state.owner, (by.get(t.state.owner) ?? 0) + 1)
        const neutral = held.length - [...by.values()].reduce((a, b) => a + b, 0)
        const rows = [...by.entries()]
          .sort((a, b) => b[1] - a[1] || a[0] - b[0])
          .map(
            ([team, n]) =>
              `<div class="team-row"><span class="team-dot" style="background:hsl(${TEAM_HUES[team]} 72% 56%)"></span>` +
              `<span class="team-name">${escapeHtml(TEAM_NAMES[team] ?? String(team))}</span>` +
              `<span class="team-caps">${n}<i>&#9678;</i></span></div>`,
          )
        if (neutral > 0) {
          rows.push(
            `<div class="team-row"><span class="team-dot" style="background:#8d97a8"></span>` +
              `<span class="team-name">Neutral</span><span class="team-caps">${neutral}<i>&#9678;</i></span></div>`,
          )
        }
        return rows.join('')
      })()}</div>`
    : ''

  const flags = game.flagStandings()
  const flagRows = flags
    ? `<div class="team-tally flags">${flags
        .map(
          (t) =>
            `<div class="team-row"><span class="team-dot" style="background:hsl(${TEAM_HUES[t.team]} 72% 56%)"></span>` +
            `<span class="team-name">${escapeHtml(TEAM_NAMES[t.team] ?? String(t.team))}</span>` +
            `<span class="team-caps">${t.captures}<i>&#9873;</i></span></div>`,
        )
        .join('')}</div>`
    : ''

  const teams = game.teamStandings()
  const teamRows = teams
    ? `<div class="team-tally">${teams
        .map(
          (t) =>
            `<div class="team-row"><span class="team-dot" style="background:hsl(${TEAM_HUES[t.team]} 72% 56%)"></span>` +
            `<span class="team-name">${escapeHtml(TEAM_NAMES[t.team] ?? String(t.team))}</span>` +
            `<span class="team-n">${t.players}</span>${kd(t.kills, t.deaths)}</div>`,
        )
        .join('')}</div>`
    : ''

  $('scoreboard').innerHTML =
    heldRows +
    flagRows +
    teamRows +
    game
      .scoreboard()
      .map((r) => {
        const profile = r.pubkey ? (profiles?.get(r.pubkey) ?? null) : null
        const badge = nip05Badge(profile)
        const real = profile && r.pubkey && profile.name !== shortNpub(r.pubkey) ? profile.name : ''
        // A stripe in the team colour rather than recolouring the tank. The hue
        // is how you find yourself on a board of eight and it must not move;
        // the side is a second fact and gets a second mark.
        const stripe = r.team
          ? ` style="box-shadow:inset 3px 0 0 hsl(${TEAM_HUES[r.team]} 72% 56%)"`
          : ''
        return `<div class="score-row card${r.you ? ' you' : ''}"${stripe}>
           <span class="who">${avatar(profile, r.name, r.color)}
           <span class="ident"><span class="name" style="color:hsl(${r.color} 70% 70%)">${escapeHtml(r.name)}</span>
           ${badge || (real ? `<span class="nip05">${escapeHtml(real)}</span>` : '')}</span></span>
           ${kd(r.kills, r.deaths)}
         </div>`
      })
      .join('')

  drawRules(game)
  drawCtf(game)
  drawTdm(game)
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
  // The half of `storedDropped` that looked live is the half that cost a real
  // event, so that is the half that goes on screen. `storedDropped` on its own
  // is unreadable — a burst at join is the trade working exactly as intended —
  // and a counter nothing displays is not an instrument. Every local player's,
  // for the same reason the trouble line is.
  const ghosted = (running?.players ?? []).reduce((n, p) => n + p.game.storedFresh, 0)
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
    // Symptom first: the player is looking at updates that went missing, not at
    // a subscription boundary. The cause is one clause underneath, in the words
    // it would take to search for it.
    ghosted
      ? `<span class="bad" id="hud-ghosted">${ghosted} live update${ghosted === 1 ? '' : 's'} dropped &mdash; a relay filed them as replays</span>`
      : '',
  ]
    .filter(Boolean)
    .join('<br>')

  // The chips carry the one fact each collapsed panel exists for. A chip
  // reading "relays" tells a player nothing they could not have guessed; a chip
  // reading "2 opp" or going red is the panel doing its job while shut.
  $('chip-score').querySelector('.chip-text')!.textContent = `${game.kills}/${game.deaths}`
  const statusChip = $('chip-status')
  statusChip.querySelector('.chip-text')!.textContent = trouble
    ? 'relays'
    : `${others} opp${others === 1 ? '' : 's'}`
  statusChip.classList.toggle('bad', Boolean(trouble) || Boolean(ghosted))

  // The icon is resolved here from the entry's *id* — the feed model stays
  // text-plus-id and `escapeHtml` keeps guarding the text, which carries
  // player names off the wire. Kill lines resolve their pictures the same
  // way, from the profiles cache at paint time, so a face that arrives after
  // the kill still lands on the line.
  const feedPic = (p: FeedParty) =>
    avatar(p.pubkey ? (running?.profiles.get(p.pubkey) ?? null) : null, p.name, p.hue, 16)
  const feedHtml = game.feed
    .map((f) => {
      if (f.kill)
        return (
          `<div class="feed-kill">${feedPic(f.kill.killer)}` +
          `<span class="feed-name">${escapeHtml(f.kill.killer.name)}</span>` +
          `<span class="feed-skull">💀</span>` +
          `<span class="feed-name">${escapeHtml(f.kill.victim.name)}</span>` +
          `${feedPic(f.kill.victim)}</div>`
        )
      return `<div>${f.icon ? anyIcon(f.icon, 'ricon feed-ico') : ''}${escapeHtml(f.text)}</div>`
    })
    .join('')
  // Assigned only on change: this paints every frame, and recreating an <img>
  // sixty times a second re-runs `onerror` fallbacks against dead picture
  // URLs forever. A string compare is cheaper than the DOM churn it prevents.
  if (feedHtml !== lastFeedHtml) {
    lastFeedHtml = feedHtml
    $('feed').innerHTML = feedHtml
  }

  drawNotice(game, now)
  drawDoomsday(game, now)
  drawBuffs(game, now)
  drawStreak(game)
  drawTray(game)
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
  // Loudest first, and this one is loudest because it is the one the player
  // cannot infer. A dead read path looks exactly like an empty room.
  const deaf = players.find((p) => p.game.readPathStalled) ?? null
  const fast = players.map((p) => p.game.net.clockAlarm).find((a) => a !== null)
  // And the quiet one, which `Net` structurally cannot see. Where the relay's
  // tolerance for an old event is *looser* than our claim's deadline, the only
  // thing that dies is the claim — every tick lands, ten a second, resetting
  // any streak `Net` might have built. The game looks perfectly normal and
  // every pickup comes straight back.
  const slow = fast ? null : players.map((p) => p.game.slowClockAlarm).find((a) => a != null)

  if (!deaf && !fast && !slow) {
    node.hidden = true
    return
  }
  node.hidden = false
  if (deaf) {
    // Relays echo our own events back to our own subscription, so a healthy read
    // path is never silent even alone in a room. Silence means the ear is gone.
    //
    // Two different sentences, because they are two different facts and only one
    // of them has a speaker. A relay that declined our filter said something and
    // gets quoted; a relay we never reached said nothing at all, and rendering
    // the library's account of that silence as "the relay said" invents one.
    const declined = deaf.game.net.deafRelays
    const unreachable = deaf.game.net.unreachableRelays
    node.innerHTML =
      `<b>YOU HAVE STOPPED HEARING THE ROOM</b>` +
      `<span>Nothing has come back from any relay for ${READ_SILENCE_S} seconds. ` +
      `Other players may still see you — this side of the connection is the one that ` +
      `died. Reload to reconnect.</span>` +
      (declined.length
        ? `<code>${escapeHtml(declined.map((r) => `${host(r.url)} declined us: ${r.reason}`).join(' · '))}</code>`
        : '') +
      (unreachable.length
        ? `<code>${escapeHtml(
            `${unreachable.length === 1 ? '1 relay' : `${unreachable.length} relays`} unreachable, still retrying: ${unreachable.map((r) => host(r.url)).join(', ')}`,
          )}</code>`
        : '') +
      (declined.length || unreachable.length
        ? ''
        : '<code>no relay said why — the socket simply went quiet</code>')
    return
  }
  if (fast) {
    // Name what is broken, then what caused it. A player 61 seconds slow is
    // looking at an arena where nobody moves and every pad works perfectly —
    // "your clock is behind" is true and reads as a lie, because it answers a
    // question they did not ask. The symptom is the headline; the direction is
    // the fix, and it goes underneath.
    const alsoPickups = players.some((p) => p.game.claimsReachingNobody)
    node.innerHTML =
      `<b>OTHER PLAYERS CAN'T SEE YOU</b>` +
      `<span>The relays are refusing everything this game sends${
        alsoPickups ? ', and <b>every pickup you take comes straight back</b>' : ''
      }. ${clockAdvice(fast.direction, fast.reason, fast.agreed)}</span>` +
      `<code>${escapeHtml(fast.reason)}</code>`
    return
  }
  // The quiet regime: ticks are landing, so the room is fine and the only
  // casualty is the one event kind carrying a deadline of ours.
  const minutes = Math.round(slow!.behindBySeconds / 60)
  node.innerHTML =
    `<b>EVERY PICKUP YOU TAKE COMES STRAIGHT BACK</b>` +
    `<span>Other players can see you and the match is fine — but the relays drop ` +
    `every pickup claim as already expired before anyone else hears it. ` +
    `<b>This machine's clock is behind</b>, by more than ${minutes} minutes. ` +
    `Set the clock, or turn on automatic time, and this will clear itself.</span>` +
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
    'Set the clock, or turn on automatic time, and this will clear itself.'
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
    // Zero, not unset: `#ctf` sits at `--rules-h` below the same anchor, and a
    // stale height would leave a banner-sized hole under a banner that is gone.
    document.documentElement.style.setProperty('--rules-h', '0px')
    return
  }
  node.hidden = false
  node.style.setProperty('--rules-hue', String(mod.hue))
  node.innerHTML = `<b>${escapeHtml(mod.name)}</b><span>${escapeHtml(mod.blurb)}</span>`
  // Measured, not guessed, for the same reason as `--hint-h`: the banner wraps
  // differently at every width, and anything stacked under it needs the real
  // number rather than a constant that was true on one screen.
  document.documentElement.style.setProperty(
    '--rules-h',
    `${Math.round(node.getBoundingClientRect().height) + 6}px`,
  )
}

/**
 * The flag race, where your eyes already are.
 *
 * The scoreboard grows a captures tally once somebody has scored, but a flag
 * round is won or lost in the thirty seconds *before* that — and "somebody is
 * running our flag home" is exactly the fact the arena does not shout. Puzz
 * asked for both halves by name: the capture count, and the flag that is
 * being taken, COD-style. This strip is those two things and nothing else:
 * the capture race for every side that has anybody on it (zeros included,
 * because 0–0 is a score the moment the mode is flags), and one line per
 * flag currently off its pole, naming the runner when their tick gave us a
 * name. Your own flag's line is the loud one.
 */
function drawCtf(game: Game): void {
  const node = $('ctf')
  if (!game.flagsOn) {
    node.hidden = true
    return
  }
  const caps = new Map<number, number>()
  const note = (team: number, n: number) => {
    if (team) caps.set(team, (caps.get(team) ?? 0) + n)
  }
  note(game.team, game.captures)
  for (const p of game.peers.values()) note(p.view.team, p.captures)
  const race = [...caps.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .map(
      ([team, n]) =>
        `<span class="ctf-side" style="color:hsl(${TEAM_HUES[team]} 72% 62%)">` +
        `${escapeHtml(TEAM_NAMES[team] ?? String(team))} ${n}</span>`,
    )
    .join('<i class="ctf-dash">—</i>')

  const you = game.identity.sessionPubkey
  const runs = [...game.flagCarriers().entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([flag, who]) => {
      const side = escapeHtml(TEAM_NAMES[flag] ?? String(flag))
      const runner = who === you ? game.name : (game.peers.get(who)?.name ?? '')
      const ours = flag === game.team
      const label = ours ? 'YOUR flag is out' : `${side} flag taken`
      return (
        `<span class="ctf-run${ours ? ' ours' : ''}">` +
        `<i style="color:hsl(${TEAM_HUES[flag]} 72% 62%)">&#9873;</i> ${label}` +
        `${runner ? ` · ${escapeHtml(runner)}` : ''}</span>`
      )
    })
    .join('')

  node.hidden = false
  node.innerHTML = `<span class="ctf-race">${race || '<span class="ctf-side">no sides yet</span>'}</span>${runs}`
}

/**
 * Which recorded frame the kill cam should be showing, or null.
 *
 * Played back in real time from the tape's own timestamps rather than by frame
 * index: the tape was sampled at twenty a second and this loop runs at whatever
 * the device manages, so stepping an index per frame would play the replay at
 * the *renderer's* speed — fast on a desktop, slow motion on a phone, and never
 * the two and a half seconds it says it is.
 *
 * Ends by clearing the booking, so the next frame is the live board again.
 */
function killcamFrame(game: Game): {
  frame: { tanks: { s: string; x: number; y: number; hull: number; gun: number; dead: boolean }[] }
  killer: string
  anchor: { from: { x: number; y: number }; to: { x: number; y: number } }
} | null {
  const cam = game.killcam
  if (!cam || !cam.frames.length) return null
  const elapsed = performance.now() - cam.from
  if (elapsed > KILLCAM_MS || game.watching) {
    game.killcam = null
    return null
  }
  // The tape ends at the death, so the window is the last KILLCAM_MS of it and
  // the playhead walks forward through that.
  const frames = cam.frames
  const last = frames[frames.length - 1]
  const want = last.t - KILLCAM_MS + elapsed
  let frame = frames[0]
  for (const f of frames) if (f.t <= want) frame = f
  // The camera comes from the frame of the *kill*, not from the frame being
  // drawn: early frames may predate the killer appearing on this screen, and a
  // camera placed per frame spends the first second of the replay looking at
  // the board because its subject is not in the sample yet.
  const killerAt = last.tanks.find((t) => t.s === cam.killer)
  const victimAt = last.tanks.find((t) => t.s === game.identity.sessionPubkey)
  if (!killerAt) {
    // Nothing to sit behind. Better no replay than a camera pointed at the
    // middle of the board pretending to be one.
    game.killcam = null
    return null
  }
  return {
    frame,
    killer: cam.killer,
    anchor: {
      from: { x: killerAt.x, y: killerAt.y },
      to: victimAt ? { x: victimAt.x, y: victimAt.y } : { x: killerAt.x + 1, y: killerAt.y },
    },
  }
}

/**
 * The team score, where your eyes already are.
 *
 * Puzz reported team deathmatch as "not really working", and half of that is
 * that it had no score you could see. The flag race has a strip, domination has
 * one, and the mode whose entire content is *which side is ahead* had its tally
 * hidden inside a panel you open between rounds. A scoreboard you have to go
 * and look at is not a score, it is a receipt.
 *
 * So: every side with a person on it, your own lit, and the lead called out
 * when it changes hands — that last part is the "score moment" the issue asks
 * for, and it is the only thing on this strip that moves.
 *
 * Practice tanks are named but not scored (see `teamStandings`): they are local
 * to whoever spawned them, so counting them puts a different number on every
 * screen in the room.
 */
let lastLeader = 0
function drawTdm(game: Game): void {
  const node = $('tdm')
  // Flags and points have their own strips and their own scores; two team
  // scorelines stacked on one screen is a HUD arguing with itself.
  const teams = game.flagsOn || game.pointsOn ? null : game.teamStandings()
  if (!teams) {
    node.hidden = true
    lastLeader = 0
    return
  }
  const top = teams[0]
  const tied = teams.length > 1 && teams[1].kills === top.kills
  const leader = tied ? 0 : top.team
  if (leader !== lastLeader) {
    // Only once the round has actually started scoring: "Red leads 0-0" at the
    // whistle is noise, and it would fire on the first tick of every match.
    if (top.kills > 0) {
      const name = TEAM_NAMES[leader] ?? String(leader)
      const behind = teams.find((t) => t.team !== leader)
      game.pushFeed(
        leader === game.team
          ? `your side leads ${top.kills}-${behind?.kills ?? 0}`
          : `${name} leads ${top.kills}-${behind?.kills ?? 0}`,
      )
    }
    lastLeader = leader
  }
  const bots = teams.reduce((n, t) => n + t.bots, 0)
  node.hidden = false
  node.innerHTML =
    `<span class="tdm-race">${teams
      .map(
        (t) =>
          `<span class="tdm-side${t.team === game.team ? ' ours' : ''}` +
          `${t.team === leader ? ' ahead' : ''}" style="--side:${TEAM_HUES[t.team]}">` +
          `<i class="tdm-dot"></i>${escapeHtml(TEAM_NAMES[t.team] ?? String(t.team))} ` +
          `<b>${t.kills}</b></span>`,
      )
      .join('<i class="tdm-dash">—</i>')}</span>` +
    // Said out loud rather than left as a discrepancy for the player to notice:
    // the bots are on the board and they are not in the score.
    (bots ? `<span class="tdm-bots">+${bots} practice ${bots === 1 ? 'tank' : 'tanks'}, unscored</span>` : '')
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
  // Rewritten only when the notice itself changes. This runs every HUD frame,
  // and `innerHTML` replaces the children even when the string is identical —
  // which would restart the punch animation on `#notice b` at HUD rate and
  // turn it into a strobe. Keyed on `at` rather than the text, because two
  // consecutive "TRIPLE KILL"s are two different punches.
  if (node.dataset.at !== String(notice.at)) {
    node.dataset.at = String(notice.at)
    // The icon sits above the headline, medal-style. Same rebuild-once rule
    // as the text: an SVG replaced at HUD rate would restart its pop.
    const icon = notice.icon ? anyIcon(notice.icon, 'notice-ico') : ''
    node.innerHTML = `${icon}<b>${escapeHtml(notice.text)}</b><span>${escapeHtml(notice.sub)}</span>`
  }
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
      return (
        `<span class="buff" style="--buff-hue:${spec.hue}">${iconSvg(kind as PickupKind)}` +
        `${escapeHtml(spec.label)} <b>${left.toFixed(1)}s</b></span>`
      )
    })
    .filter(Boolean)
    .join('')
  node.hidden = false
  node.innerHTML =
    `<div class="p2-row"><b style="color:hsl(${hue} 75% 68%)">P2</b>` +
    `<span class="pips">${hull}</span>` +
    `${kd(g.kills, g.deaths)}</div>` +
    (timers ? `<div class="p2-row">${timers}</div>` : '')
}

/**
 * The buffs a kill streak grants, which no pickup does. See `drawBuffs`.
 *
 * `icon` is a reward id, so the chip on the HUD is the same picture as the
 * card in the loadout picker and the pill in the tray — a player who spent
 * "bulwark" should not have to work out which of the three timers on screen it
 * turned into.
 */
const STREAK_BUFFS: { key: 'reconUntil' | 'bulwarkUntil' | 'regenUntil'; label: string; icon: string; hue: number }[] = [
  { key: 'reconUntil', label: 'recon', icon: 'recon', hue: 155 },
  { key: 'bulwarkUntil', label: 'bulwark', icon: 'bulwark', hue: 200 },
  { key: 'regenUntil', label: 'drone', icon: 'drone', hue: 130 },
]

/**
 * The nuke: five seconds of countdown, then the screen goes white.
 *
 * Its own element and not a banner. A banner is something you read; this is
 * something that has to be impossible not to see, from any camera, while you
 * are driving — the whole design of the reward is that the last five seconds
 * of a round belong to it. The white-out is DOM for the same reason it is not
 * in the scene: it has to cover the HUD as well as the board, and in the
 * cockpit view a quad in the world would not.
 *
 * `nukeIn` counts down in the game's own clock, so a client that received the
 * event late shows a short countdown rather than a wrong one.
 */
function drawDoomsday(game: Game, now: number): void {
  const node = $('doomsday')
  const left = game.nukeIn
  const flash = game.nukeFlashAt ? now - game.nukeFlashAt : Infinity
  if (left !== null) {
    node.hidden = false
    node.className = 'counting'
    node.innerHTML =
      `<b>NUKE INBOUND</b><span>${left.toFixed(1)}</span>` +
      `<i>there is nowhere to go</i>`
    return
  }
  if (flash >= 0 && flash < NUKE_FLASH_MS) {
    node.hidden = false
    node.className = 'blast'
    // The white-out is the element's own background, driven from here rather
    // than from a CSS animation: an animation restarts on a class change, and
    // two nukes in one round would leave the second one flashing from
    // whatever point the first had reached.
    // Full white for the first fifth, then a fade — rather than a fade from the
    // first frame. The HUD paints eight times a second and the page can be
    // running at four, so a flash that starts decaying immediately can be
    // *entirely* over before the first frame that draws it: the check for it
    // passed against an alpha of zero, which is a white-out nobody sees.
    const t = flash / NUKE_FLASH_MS
    const white = t < 0.2 ? 1 : Math.max(0, 1 - (t - 0.2) / 0.5)
    node.style.setProperty('--white', String(white))
    node.innerHTML = t < 0.6 ? `<b>NUKE</b>` : ''
    return
  }
  node.hidden = true
  node.innerHTML = ''
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
      `<span class="buff" style="--buff-hue:${spec.hue}">${iconSvg(kind)}` +
        `${escapeHtml(spec.label)} <b>${left.toFixed(1)}s</b></span>`,
    )
  }
  // Some buffs are streak rewards rather than pickups, so the loop above never
  // sees them — but they are running buffs like any other and earn the same
  // chip. A table rather than three copies of this block: the tier pools added
  // two more of these in one change, and the reason recon needed its own case
  // for so long is that there was nowhere to put the second one.
  for (const spec of STREAK_BUFFS) {
    const left = (game.buffs[spec.key] - now) / 1000
    if (left <= 0) continue
    live.push(
      `<span class="buff" style="--buff-hue:${spec.hue}">${rewardIcon(spec.icon, 'ricon pico')}` +
        `${spec.label} <b>${left.toFixed(1)}s</b></span>`,
    )
  }
  // And the other side of that coin: an enemy's sweep has you lit through
  // cover. The `rn` flag was always on the wire for everybody; only the
  // earner's side was reading it. Knowing you are marked is half the
  // pressure of the reward — break line of sight, or stop mattering.
  if (game.markedByEnemy()) {
    live.push(`<span class="buff marked" style="--buff-hue:0">&#9673; you are marked</span>`)
  }
  node.hidden = live.length === 0
  node.innerHTML = live.join('')
}

/**
 * What the next kill buys you.
 *
 * cloudfodder asked "how am I supposed to get to the choppa?" in the middle of
 * a match, which is the whole bug: the ladder worked and nothing on the screen
 * admitted it existed. A reward you cannot see coming is a surprise once and
 * invisible forever after — and a player who knows the chopper is four kills
 * away plays the next four kills differently, which is the actual point.
 *
 * Always on screen during a round, including at zero, because zero is exactly
 * when a new player needs to be told there is a ladder at all. It reads as one
 * line and a bar rather than as a list of six tiers: a HUD element you have to
 * *study* during a firefight is decoration.
 *
 * The rung names come from `STREAK_LADDER` in game.ts — the same table
 * `onOwnKill` awards from — so retuning the ladder cannot leave this promising
 * a chopper the game does not hand over.
 */
function drawStreak(game: Game): void {
  const node = $('streak')
  const rung = game.nextRung(game.streak)
  if (!rung) {
    // Past the top of the ladder there is nothing left to earn, so the strip
    // stops making promises and just keeps count.
    node.hidden = false
    node.className = 'top'
    node.innerHTML =
      `<div class="streak-line"><b>${game.streak}</b> in a row` +
      `<span class="streak-next">unstoppable</span></div>`
    return
  }
  const floor = game.rungFloor(game.streak)
  const span = rung.at - floor
  const done = game.streak - floor
  const left = rung.at - game.streak
  node.hidden = false
  // One away is the moment worth lighting up: it is the difference between a
  // meter you ignore and a decision about whether to push.
  node.className = left === 1 ? 'close' : ''
  node.innerHTML =
    `<div class="streak-line">` +
    (game.streak > 0 ? `<b>${game.streak}</b> in a row` : `<span class="dim">no streak</span>`) +
    `<span class="streak-next">${left} more &rarr; ${rewardIcon(rung.id)}${escapeHtml(rung.name)}</span></div>` +
    `<div class="streak-bar"><i style="width:${Math.round((done / span) * 100)}%"></i></div>`
}

/**
 * The rewards you are holding, as icons you can spend.
 *
 * Puzz: "you should have a icons showing your kill streaks and should be able
 * to select them by clicking on them or something to activate. (like call of
 * duty)."
 *
 * One button per earned rung, in ladder order, each with its number key on it.
 * The number is the *position in the tray*, not the rung — holding an air
 * strike and a chopper means 1 and 2 whatever else you have earned, so a
 * player's fingers learn a row rather than a lookup table.
 *
 * Drawn from `game.earned` every frame rather than from a local copy: the tray
 * empties on a round boundary and on every spend, and a second copy of that
 * state is a second thing that can be wrong.
 */
// Reward icons live in `REWARD_PATHS` near the top of this file — keyed by
// reward id rather than rung number, because the loadout made rung numbers a
// choice, and read at module init by the picker, where a table down here is
// the temporal-dead-zone crash the picker already documents.

/**
 * What the tray currently shows, so it is only rebuilt when it changes.
 *
 * Not an optimisation — a correctness fix. The HUD repaints eight times a
 * second, and rewriting `innerHTML` every frame replaces the button under the
 * cursor mid-click: a `mousedown` on one node and a `mouseup` on its
 * replacement is not a click and the browser never fires one. At 8fps that is
 * a 125ms window on every press, and a control that eats one click in ten is
 * a control people stop trusting. The test caught it as "Node is detached from
 * document", which is the same bug wearing a stack trace.
 */
let trayKey = ''

/**
 * What the tray held at the last rebuild, so a spend can flash the pill out.
 *
 * The rebuild replaces the spent button wholesale, and a node that is gone
 * cannot animate its own exit — so the button is cloned where it stood and
 * the clone burns off. Only a single disappearance gets the flash: a spend
 * removes exactly one pill, while the round boundary sweeps the tray inside
 * the podium and owes no fireworks. The spitfire's corner pad is the other
 * excluded case — its spend already turns the whole tray into a question.
 */
let trayShown: number[] = []
let trayRound = -1

function flashSpent(node: HTMLElement, gone: number): void {
  const btn = node.querySelector<HTMLButtonElement>(`button[data-at="${gone}"]`)
  if (!btn) return
  const r = btn.getBoundingClientRect()
  const ghost = btn.cloneNode(true) as HTMLButtonElement
  ghost.className = 'reward reward-ghost'
  ghost.disabled = true
  ghost.style.left = `${r.left}px`
  ghost.style.top = `${r.top}px`
  document.body.appendChild(ghost)
  // animationend never fires under prefers-reduced-motion (the ghost is
  // display:none there), so the timer is the cleanup that always runs.
  ghost.addEventListener('animationend', () => ghost.remove())
  setTimeout(() => ghost.remove(), 600)
}

function drawTray(game: Game): void {
  const node = $('tray')
  const held = game.earned
  const usable = !game.tank.dead && !game.flying
  const key = `${held.join(',')}|${usable}|${game.pendingStrafe}`
  if (key === trayKey) return
  trayKey = key
  const gone = trayShown.filter((at) => !held.includes(at))
  // The round check is what keeps the block boundary quiet: `beginRound`
  // sweeps the tray, and a player holding exactly one reward at the buzzer
  // should not see it "spent" by the clock. A spend never changes the round;
  // the sweep always does.
  const swept = game.round !== trayRound
  trayRound = game.round
  if (!swept && gone.length === 1 && !game.pendingStrafe) flashSpent(node, gone[0])
  trayShown = [...held]
  // A spitfire waiting for its corner takes over the tray: the spend already
  // happened, and the only question left on screen is *which corner*. Four
  // buttons, one per corner, keys 1-4.
  if (game.pendingStrafe) {
    node.hidden = false
    const corners: [number, string, string][] = [
      [0, '↖', 'top left'],
      [1, '↗', 'top right'],
      [2, '↘', 'bottom right'],
      [3, '↙', 'bottom left'],
    ]
    node.innerHTML = corners
      .map(
        ([c, arrow, name], i) =>
          `<button type="button" class="reward corner" data-corner="${c}" ` +
          `title="spitfire from the ${name} — press ${i + 1}">` +
          `<span class="corner-arrow">${arrow}</span>` +
          `<span class="reward-name">${name}</span>` +
          `<span class="reward-key">${i + 1}</span>` +
          `</button>`,
      )
      .join('')
    return
  }
  node.hidden = held.length === 0
  if (!held.length) {
    node.innerHTML = ''
    return
  }
  // Dead or flying, the rewards are still yours and still shown — greyed,
  // because "where did my air strike go" is a worse question than "why is it
  // dim". `Game.spend` refuses in both states; this says so before the click.
  // Icon and number, no word — the pill reads like a COD medal row. The name
  // still travels with the button (tooltip and accessible name), it just
  // stops taking HUD width: the strip taught the icon on the climb up, and
  // the banner named it the moment it landed.
  node.innerHTML = held
    .map((at, i) => {
      const rung = game.ladder.find((r) => r.at === at)
      return (
        `<button type="button" class="reward" data-at="${at}"${usable ? '' : ' disabled'} ` +
        `aria-label="${escapeHtml(rung?.name ?? String(at))}" ` +
        `title="${escapeHtml(rung?.detail ?? '')} — press ${i + 1}">` +
        `${rewardIcon(rung?.id ?? '')}` +
        `<span class="reward-key">${i + 1}</span>` +
        `</button>`
      )
    })
    .join('')
}

/**
 * Spend by position, which is what a number key means.
 *
 * Read off `game.earned` at the moment of the press rather than off the drawn
 * tray: the HUD repaints eight times a second, so a key pressed in the frame
 * after a spend would otherwise address the button that *was* there.
 */
function spendSlot(game: Game, slot: number): void {
  const at = game.earned[slot]
  if (at === undefined) return
  game.spend(at)
  drawTray(game)
}

$('tray').addEventListener('click', (e) => {
  const corner = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-corner]')
  if (corner && running) {
    const game = running.players[0].game
    game.callSpitfire(Number(corner.dataset.corner) as 0 | 1 | 2 | 3)
    drawTray(game)
    return
  }
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-at]')
  if (!btn || !running) return
  const game = running.players[0].game
  game.spend(Number(btn.dataset.at))
  drawTray(game)
})

window.addEventListener('keydown', (e) => {
  if (e.repeat || !running) return
  const target = e.target as HTMLElement | null
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
  // Digit row only. Numpad is where a second player's hands are on a couch.
  const m = /^Digit([1-9])$/.exec(e.code)
  if (!m) return
  const game = running.players[0].game
  // While a spitfire waits for its corner, the digits mean the corners.
  if (game.pendingStrafe) {
    const c = Number(m[1]) - 1
    if (c <= 3) {
      game.callSpitfire(c as 0 | 1 | 2 | 3)
      drawTray(game)
    }
    return
  }
  spendSlot(game, Number(m[1]) - 1)
})

/**
 * The whole ladder, once, on the way in.
 *
 * The strip above answers "what is next"; this answers "what is there", which
 * is a question you only ask once per session. Six seconds in the feed rather
 * than a permanent panel, because a legend that never goes away is furniture.
 */
function announceLadder(game: Game): void {
  game.pushFeed('streaks: ' + game.ladder.map((r) => `${r.at} ${r.name}`).join(' · '))
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
  $('podium-note').textContent = autoPublishOn()
    ? 'This round was signed and published under its block height automatically. ' +
      'Auto-publish is on — turn it off in the buttons below the board.'
    : 'Publishing signs a record with your npub and puts it on the relays under this block height. ' +
      'Nothing publishes itself while auto-publish is off.'

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
               ${kd(r.kills, r.deaths)}
             </div>`,
        )
        .join('')
    : '<div class="fine">Nobody scored.</div>'

  const publish = $<HTMLButtonElement>('podium-publish')
  publish.disabled = false
  // Still here with auto-publish on, and worth keeping: a signature can be
  // refused, a relay can be down, and this is the one moment the player is
  // looking at the round it belongs to. The label says which case they are in.
  publish.textContent = autoPublishOn() ? 'Publish this round again' : 'Sign and publish this round'
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
        // `result.bestStreak`, not the live one. `endRound` banks the round and
        // then resets the counter, and `showPodium` runs after it — so this
        // published a streak of 0 for every round it has ever signed.
        result.bestStreak,
        result.mode,
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
      game.roundMode(),
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

/**
 * The leaderboard as a chain rather than as a table.
 *
 * One tile per block, newest first, with the face of whoever won it — the same
 * shape a block explorer uses, for the same reason: the chain is already the
 * ordering, and a table sorted by kills throws away the only axis this game
 * actually has. It reads records that were already being published; nothing new
 * is signed for this view.
 *
 * Seasons are difficulty epochs, 2016 blocks apiece. The boundary is drawn
 * between tiles rather than announced anywhere, because it is derived from the
 * height and every client computes the same one.
 */
function renderWall({ blocks, truncated }: BlockWall): string {
  if (!blocks.length) return 'No block has been played yet. Win one and it is the first tile here.'
  const champions = new Map(seasonWinners(blocks).map((s) => [s.season, s]))
  // The oldest season on screen is the one the window cut into, so its tally is
  // not a tally of the season — it is a tally of the part we can see. Saying
  // "leads with four" while twenty of its blocks are off the end is worse than
  // saying nothing, so that line is dropped rather than qualified.
  const clipped = truncated ? blocks[blocks.length - 1].season : null
  const tiles: string[] = []
  let season: number | null = null
  for (const b of blocks) {
    if (b.season !== season) {
      season = b.season
      const champ = season === clipped ? undefined : champions.get(season)
      // Named by the epoch's first block, which is a number anybody can check
      // against a block explorer, rather than by an ordinal this game invented.
      tiles.push(
        `<div class="season-sep"><span class="season-name">Season ${season}</span>` +
          `<span class="season-fine">from block ${season * EPOCH_BLOCKS}</span>` +
          (champ && champ.blocks > 1
            ? `<span class="season-fine">${escapeHtml(
                running?.profiles.get(champ.pubkey)?.name ?? shortNpub(champ.pubkey),
              )} leads with ${champ.blocks} blocks</span>`
            : '') +
          `</div>`,
      )
    }
    const profile = running?.profiles.get(b.winner.pubkey) ?? null
    const hue = parseInt(b.winner.pubkey.slice(0, 4), 16) % 360
    tiles.push(
      `<button type="button" class="blocktile" data-block="${b.height}" ` +
        `title="See how block ${b.height} was played">` +
        `<div class="bt-height">#${b.height}</div>` +
        `<div class="bt-face">${avatar(profile, profile?.name ?? b.winner.npub.slice(4), hue, 40)}</div>` +
        `<div class="bt-name">${escapeHtml(profile?.name ?? shortNpub(b.winner.pubkey))}</div>` +
        `<div class="bt-kd">${ICONS.kills}${b.winner.kills}</div>` +
        `<div class="bt-fine">${b.players} player${b.players === 1 ? '' : 's'}</div></button>`,
    )
  }
  return (
    `<div class="wall">${tiles.join('')}</div>` +
    `<p class="fine wall-note">Tap a block for that round. ` +
    `${blocks.length} block${blocks.length === 1 ? '' : 's'} played` +
    (truncated ? ', most recent first — there are older ones the relays did not return.' : '.') +
    `</p>`
  )
}

/**
 * What the board last fetched, so a face landing repaints without re-querying.
 *
 * Profiles arrive a second or two after the rows they belong to — that is the
 * whole design, and it is why nothing on this screen waits for them. But
 * nothing repainted either, so a leaderboard opened before the kind-0 events
 * landed showed short npubs until you closed it and opened it again. Rendering
 * from a cache separates "go and ask the relays" from "draw what we have",
 * which is what makes a repaint free.
 */
let boardCache:
  | { scope: 'detail'; height: number; rows: ScoreRow[] }
  | { scope: 'seasons'; seasons: SeasonRow[] }
  | { scope: 'wall'; wall: BlockWall }
  | { scope: 'block' | 'all'; scores: ScoreRow[]; height?: number }
  | null = null

/**
 * Which mode the table tabs (`block`, `all`) are filtered to, or `null` for
 * every mode mixed together. Only those two tabs read it — the wall and the
 * season chain rank blocks as a whole, not by mode, same scope cut the
 * per-mode leaderboard shipped with.
 */
let boardMode: RoomMode | null = null
let boardScope: 'block' | 'all' | 'wall' | 'seasons' = 'wall'

function paintBoard(): void {
  const rows = $('board-rows')
  if (!boardCache) return
  if (boardCache.scope === 'detail') {
    rows.innerHTML = renderBlockDetail(boardCache.height, boardCache.rows)
    return
  }
  if (boardCache.scope === 'seasons') {
    rows.innerHTML = renderSeasons(boardCache.seasons)
    return
  }
  if (boardCache.scope === 'wall') {
    rows.innerHTML = renderWall(boardCache.wall)
    return
  }
  const { scope, scores, height } = boardCache
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
              ${kd(
                s.kills,
                s.deaths,
                scope === 'all' && s.block ? `<span class="npub">#${s.block}</span>` : '',
              )}</div>`
        })
        .join('')
    : scope === 'block'
      ? `Nothing published for block ${height} yet. Be the first.`
      : 'No scores published yet. Be the first.'
}

/**
 * A season is a difficulty epoch, and its champion is derived rather than awarded.
 *
 * Nobody signs this. Every client computes it from the same public score events
 * and gets the same answer, which is the only reason it can exist in a game
 * with no server — there is no trophy to hand out, only an arithmetic anybody
 * can redo. That also means it is exactly as trustworthy as the records under
 * it, which is to say: everyone chose their own numbers. The card says so.
 *
 * A season that has not been paged back past is shown *without* a champion. A
 * tally over a partial season is not a smaller truth, it is a different claim,
 * and "four blocks" reads identically whether it is four out of six or four out
 * of two hundred.
 */
function renderSeasons(seasons: SeasonRow[]): string {
  if (!seasons.length) return 'No season has been played yet.'
  return (
    `<div class="seasons">` +
    seasons
      .map((s) => {
        const profile = s.champion ? (running?.profiles.get(s.champion.pubkey) ?? null) : null
        const hue = s.champion ? parseInt(s.champion.pubkey.slice(0, 4), 16) % 360 : 0
        const head =
          `<div class="sn-head"><span class="sn-title">Season ${s.season}</span>` +
          `<span class="sn-range">blocks ${s.from}–${s.to}</span></div>`
        if (!s.champion) {
          return `<div class="seasoncard empty">${head}<p class="fine">Nothing published yet.</p></div>`
        }
        if (!s.complete) {
          // Deliberately not a podium. Naming a leader here would be the same
          // lie the wall used to tell, one screen over.
          return (
            `<div class="seasoncard partial">${head}` +
            `<p class="fine">${s.played} block${s.played === 1 ? '' : 's'} in view, ` +
            `but not the whole season — the relays did not go back far enough to say who took it.</p></div>`
          )
        }
        return (
          `<div class="seasoncard">${head}` +
          `<div class="sn-champ">${avatar(profile, profile?.name ?? shortNpub(s.champion.pubkey), hue, 52)}` +
          `<div class="sn-who"><span class="sn-name">${escapeHtml(
            profile?.name ?? shortNpub(s.champion.pubkey),
          )}</span>` +
          `<span class="sn-won">${s.won} of ${s.played} block${s.played === 1 ? '' : 's'}</span></div></div></div>`
        )
      })
      .join('') +
    `</div>` +
    `<p class="fine">Champions are worked out from the same signed records the block wall shows — ` +
    `nobody awards them, so anybody can check one.</p>`
  )
}

/**
 * One block's round, in full.
 *
 * The wall answers "who won block 912345"; this answers "what happened in it".
 * Same signed records, no new event kind and nothing extra published — the
 * per-block records already carried a streak and a board name, and until now
 * the leaderboard threw both away.
 *
 * `k/d` is shown as two numbers and a ratio, because they say different things:
 * four and one is a good round, four and eleven is a busy one, and a single
 * fraction cannot tell you which you are looking at.
 */
function renderBlockDetail(height: number, rows: ScoreRow[]): string {
  const back =
    `<button type="button" class="ghost tiny" id="detail-back">&larr; All blocks</button>`
  if (!rows.length) {
    return (
      `<div class="detail-head">${back}<h3>Block ${height}</h3></div>` +
      `<p class="fine">Nobody published a result for this block.</p>`
    )
  }
  // The board is whatever most players' clients called it. They should all
  // agree — the map is a pure function of the block hash — so a disagreement
  // means somebody was on a different build, and the majority is the useful
  // answer rather than the first one the relay happened to return.
  const votes = new Map<string, number>()
  for (const r of rows) if (r.layout) votes.set(r.layout, (votes.get(r.layout) ?? 0) + 1)
  const layout = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0]
  const rooms = new Set(rows.map((r) => r.room).filter(Boolean))
  const played = Math.max(...rows.map((r) => r.at))
  const kills = rows.reduce((n, r) => n + r.kills, 0)
  const deaths = rows.reduce((n, r) => n + r.deaths, 0)

  const facts = [
    layout ? `<span>${escapeHtml(layout)}</span>` : '',
    `<span>${rows.length} player${rows.length === 1 ? '' : 's'}</span>`,
    rooms.size === 1
      ? `<span>room ${escapeHtml([...rooms][0] as string)}</span>`
      : rooms.size > 1
        ? `<span>${rooms.size} rooms</span>`
        : '',
    `<span>${ago(played)}</span>`,
    `<span>season ${seasonOf(height)}</span>`,
  ]
    .filter(Boolean)
    .join('')

  const table = rows
    .map((r, i) => {
      const profile = running?.profiles.get(r.pubkey) ?? null
      const hue = parseInt(r.pubkey.slice(0, 4), 16) % 360
      // Deaths of zero is a perfect round, not a division by zero. Showing the
      // kill count itself is the honest reading of "never died".
      const ratio = r.deaths ? (r.kills / r.deaths).toFixed(2) : r.kills ? `${r.kills}.00` : '—'
      return (
        `<div class="detail-row">` +
        `<span class="rank">${i + 1}</span>` +
        avatar(profile, profile?.name ?? r.npub.slice(4), hue, 28) +
        `<span class="dr-who"><span class="name">${escapeHtml(
          profile?.name ?? shortNpub(r.pubkey),
        )}</span>${nip05Badge(profile)}</span>` +
        `<span class="dr-num" title="kills">${ICONS.kills}${r.kills}</span>` +
        `<span class="dr-num" title="deaths">${ICONS.deaths}${r.deaths}</span>` +
        `<span class="dr-ratio" title="kills per death">${ratio}</span>` +
        `<span class="dr-streak" title="best kill streak">${
          r.streak ? `${r.streak}&times;` : '<span class="dim">—</span>'
        }</span></div>`
      )
    })
    .join('')

  return (
    `<div class="detail-head">${back}<h3>Block ${height}</h3></div>` +
    `<div class="detail-facts">${facts}</div>` +
    `<div class="detail-legend"><span class="rank"></span><span></span><span class="dr-who"></span>` +
    `<span class="dr-num">K</span><span class="dr-num">D</span>` +
    `<span class="dr-ratio">K/D</span><span class="dr-streak">best</span></div>` +
    `<div class="detail-table">${table}</div>` +
    `<p class="fine">${kills} kill${kills === 1 ? '' : 's'} and ${deaths} death${
      deaths === 1 ? '' : 's'
    } claimed across the round. ` +
    `Every line is signed by the player it describes — ` +
    `<a href="https://mempool.space/block/${height}" target="_blank" rel="noreferrer">` +
    `check the block itself</a>, but nobody can check these.</p>`
  )
}

/** "four minutes ago", for a unix-seconds timestamp. */
function ago(seconds: number): string {
  const delta = Math.max(0, Math.floor(Date.now() / 1000 - seconds))
  if (delta < 90) return 'just now'
  const minutes = Math.round(delta / 60)
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 36) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return `${Math.round(hours / 24)} days ago`
}

async function loadBlockDetail(height: number): Promise<void> {
  const rows = $('board-rows')
  rows.textContent = `loading block ${height}…`
  if (!running) return
  try {
    const scores = await fetchBlockScores(running.players[0].game.net, height, 64)
    for (const r of scores) running?.profiles.want(r.pubkey)
    boardCache = { scope: 'detail', height, rows: scores }
    paintBoard()
  } catch {
    rows.textContent = 'Could not reach the relays.'
  }
}

$('board-rows').addEventListener('click', (e) => {
  const target = e.target as HTMLElement
  if (target.closest('#detail-back')) {
    void loadBoard('wall')
    return
  }
  const tile = target.closest<HTMLElement>('.blocktile')
  if (tile?.dataset.block) void loadBlockDetail(Number(tile.dataset.block))
})

async function loadBoard(scope: 'block' | 'all' | 'wall' | 'seasons'): Promise<void> {
  const rows = $('board-rows')
  boardScope = scope
  $('board-tab-seasons').classList.toggle('on', scope === 'seasons')
  $('board-tab-wall').classList.toggle('on', scope === 'wall')
  $('board-tab-block').classList.toggle('on', scope === 'block')
  $('board-tab-all').classList.toggle('on', scope === 'all')
  $('board-mode-tabs').hidden = scope !== 'block' && scope !== 'all'
  rows.textContent = 'loading…'
  boardCache = null
  if (!running) return
  if (scope === 'seasons') {
    try {
      const seasons = await fetchSeasons(running.players[0].game.net)
      for (const s of seasons) if (s.champion) running?.profiles.want(s.champion.pubkey)
      boardCache = { scope, seasons }
      paintBoard()
    } catch {
      rows.textContent = 'Could not reach the relays.'
    }
    return
  }
  if (scope === 'wall') {
    try {
      const wall = await fetchBlockWall(running.players[0].game.net)
      // Faces arrive after the tiles do, exactly as on the other two tabs: the
      // wall renders with short npubs immediately and upgrades itself when the
      // kind-0 events land, so a slow profile relay never holds up the board.
      for (const b of wall.blocks) running?.profiles.want(b.winner.pubkey)
      boardCache = { scope, wall }
      paintBoard()
    } catch {
      rows.textContent = 'Could not reach the relays.'
    }
    return
  }
  const height = running.clock.tip?.height
  if (scope === 'block' && !height) {
    rows.textContent = 'No block height yet — the explorer has not answered.'
    return
  }
  try {
    const scores =
      scope === 'block'
        ? await fetchBlockScores(running.players[0].game.net, height!, 25, boardMode ?? undefined)
        : await fetchScores(running.players[0].game.net, 25, boardMode ?? undefined)
    // A signed score is only worth reading if you can tell whose it is. The
    // profile fetch is fire-and-forget: rows render with the npub immediately
    // and upgrade themselves to a face and a NIP-05 when the events land.
    for (const s of scores) running?.profiles.want(s.pubkey)
    boardCache = { scope, scores, height }
    paintBoard()
  } catch {
    rows.textContent = 'Could not reach the relays.'
  }
}

$('show-board').addEventListener('click', () => {
  board.hidden = false
  void loadBoard('wall')
})
$('board-tab-wall').addEventListener('click', () => void loadBoard('wall'))
$('board-tab-seasons').addEventListener('click', () => void loadBoard('seasons'))
$('board-tab-block').addEventListener('click', () => void loadBoard('block'))
$('board-tab-all').addEventListener('click', () => void loadBoard('all'))

$('board-mode-tabs').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-mode]')
  if (!btn) return
  boardMode = asRoomMode(btn.dataset.mode) ?? null
  for (const b of $('board-mode-tabs').querySelectorAll('button')) b.classList.toggle('on', b === btn)
  if (boardScope === 'block' || boardScope === 'all') void loadBoard(boardScope)
})

$('board-close').addEventListener('click', () => {
  board.hidden = true
})
