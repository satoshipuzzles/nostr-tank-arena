// The leaderboard, against a relay whose answers this file chose.
//
//   npm run build && npm run preview &
//   npm run test:board
//
// Every number on this screen comes from a signed event somebody else
// published, which makes it the one part of the game that cannot be tested
// against the live network: the assertion "the winner of block 912345 is this
// npub" is only checkable if this file decided who published what.
//
// So there is one fake relay, it answers exactly the records below, and the
// checks are about the *grouping* — who won a block, how many players it says
// were in it, where a season boundary lands. That grouping is the whole of the
// new code; the rendering is a template around it.

import { existsSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { nip19 } from 'nostr-tools'
import puppeteer from 'puppeteer-core'

const SITE = process.env.TANK_URL ?? 'http://localhost:4173/'
if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(SITE)) {
  console.log(`SKIP  the board checks need a plain-http origin; TANK_URL is ${SITE}`)
  console.log('      the ws:// fake relay is blocked as mixed content from https.')
  process.exit(0)
}

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
]
  .filter(Boolean)
  .find((p) => existsSync(p))
if (!CHROME) {
  console.error('No Chrome found. Set CHROME_PATH.')
  process.exit(2)
}

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 12_000, step = 150) {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) return null
    await wait(step)
  }
}

// -------------------------------------------------------------- the players

const KIND_SCORE = 30078
const KIND_METADATA = 0
const EPOCH = 2016
// Two heights inside one epoch and one in the next, so exactly one season
// boundary falls inside the wall. Multiplying the epoch keeps the arithmetic
// visible rather than hiding it in a magic height.
const SEASON = 452
const BLOCKS = { first: SEASON * EPOCH + 10, second: SEASON * EPOCH + 11, next: (SEASON + 1) * EPOCH + 3 }

const people = ['ace', 'brick', 'cinder'].map((name) => {
  const sk = generateSecretKey()
  return { name, sk, pk: getPublicKey(sk) }
})
const [ace, brick, cinder] = people
/** Exactly what the UI prints for a pubkey with no profile. See `shortNpub`. */
const short = (pk) => {
  const npub = nip19.npubEncode(pk)
  return `${npub.slice(0, 10)}…${npub.slice(-4)}`
}

const now = Math.floor(Date.now() / 1000)
const score = (who, block, kills, deaths, at = now) =>
  finalizeEvent(
    {
      kind: KIND_SCORE,
      created_at: at,
      tags: [
        ['d', `nostr-tank-arena/score/${block}`],
        ['t', 'nostr-tank-arena'],
        ['t', `tankblock-${block}`],
      ],
      content: JSON.stringify({ kills, deaths, room: 'lobby', at, block, layout: 'Crossroads' }),
    },
    who.sk,
  )

const RECORDS = [
  // Block one: brick wins on kills outright.
  score(ace, BLOCKS.first, 2, 4),
  score(brick, BLOCKS.first, 5, 1),
  score(cinder, BLOCKS.first, 1, 6),
  // Block two: ace and cinder tie on kills, ace died less. Ace takes it.
  score(ace, BLOCKS.second, 3, 1),
  score(cinder, BLOCKS.second, 3, 5),
  // ...and brick published the same block twice, which is one player and not
  // two. An addressable event can legitimately come back in both versions.
  score(brick, BLOCKS.second, 1, 2, now - 400),
  score(brick, BLOCKS.second, 2, 2, now - 100),
  // A block in the next difficulty epoch, so a season boundary lands in between.
  score(cinder, BLOCKS.next, 9, 0),
]

const PROFILES = [
  finalizeEvent(
    {
      kind: KIND_METADATA,
      created_at: now,
      tags: [],
      content: JSON.stringify({ display_name: 'Brick', name: 'brick' }),
    },
    brick.sk,
  ),
  finalizeEvent(
    {
      kind: KIND_METADATA,
      created_at: now,
      tags: [],
      content: JSON.stringify({ display_name: 'Cinder', name: 'cinder' }),
    },
    cinder.sk,
  ),
]

// ---------------------------------------------------------------- the relay
//
// Answers score queries and profile queries and nothing else. Profiles are held
// back until a test asks for them, because "the tile upgrades when the face
// lands" is only observable if there is a moment when it has not landed.

let serveProfiles = false
const wss = new WebSocketServer({ port: 0 })
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg[0] === 'EVENT') {
      ws.send(JSON.stringify(['OK', msg[1].id, true, '']))
      return
    }
    if (msg[0] !== 'REQ') return
    const [, id, ...filters] = msg
    for (const f of filters) {
      const kinds = f.kinds ?? []
      if (kinds.includes(KIND_SCORE)) {
        for (const e of RECORDS) ws.send(JSON.stringify(['EVENT', id, e]))
      }
      if (kinds.includes(KIND_METADATA) && serveProfiles) {
        const want = new Set(f.authors ?? [])
        for (const e of PROFILES) if (want.has(e.pubkey)) ws.send(JSON.stringify(['EVENT', id, e]))
      }
    }
    ws.send(JSON.stringify(['EOSE', id]))
  })
})
const relayUrl = `ws://localhost:${wss.address().port}`

// -------------------------------------------------- a history that does not fit
//
// The wall shows the most recent 60 blocks. A season tally computed over a
// window that cut into a season is not incomplete, it is *wrong* — the oldest
// season on screen is missing however many blocks fell off the end, so
// "so-and-so leads with four" is a confident lie about a season with twenty
// more blocks in it. This relay has more history than fits, and the checks
// below are about the screen admitting that.
const DEEP_SEASON = 300
const DEEP_BASE = DEEP_SEASON * EPOCH
const DEEP = []
for (let i = 0; i < 70; i++) {
  // Ace takes every one of them. If the wall showed a season tally over its
  // window it would say "ace leads with 60", of a season with 70 blocks in it.
  DEEP.push(score(ace, DEEP_BASE + i, 4, 1, now - (70 - i)))
}
const deepWss = new WebSocketServer({ port: 0 })
deepWss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg[0] === 'EVENT') return ws.send(JSON.stringify(['OK', msg[1].id, true, '']))
    if (msg[0] !== 'REQ') return
    const [, id, ...filters] = msg
    for (const f of filters) {
      if ((f.kinds ?? []).includes(KIND_SCORE)) {
        for (const e of DEEP) ws.send(JSON.stringify(['EVENT', id, e]))
      }
    }
    ws.send(JSON.stringify(['EOSE', id]))
  })
})
const deepUrl = `ws://localhost:${deepWss.address().port}`

// ------------------------------------------------------------- seasons
//
// Two relays, because the two cases are the same code reaching two opposite
// conclusions and one relay cannot be both.
//
// Both cap a response at twenty events however large a limit is asked for,
// which is what real relays do and is the only way `until` paging is exercised
// at all: a relay that answers everything in one page never pages.

const CAP = 20
/** A relay that honours `until` and hands back at most `CAP` events a time. */
function startPagingRelay(records) {
  const server = new WebSocketServer({ port: 0 })
  const state = { pages: 0 }
  server.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg[0] === 'EVENT') return ws.send(JSON.stringify(['OK', msg[1].id, true, '']))
      if (msg[0] !== 'REQ') return
      const [, id, ...filters] = msg
      for (const f of filters) {
        if (!(f.kinds ?? []).includes(KIND_SCORE)) continue
        state.pages++
        const page = records
          .filter((e) => (f.until === undefined ? true : e.created_at <= f.until))
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, CAP)
        for (const e of page) ws.send(JSON.stringify(['EVENT', id, e]))
      }
      ws.send(JSON.stringify(['EOSE', id]))
    })
  })
  state.url = `ws://localhost:${server.address().port}`
  state.close = () => server.close()
  return state
}

// A season small enough that the paging runs out of history inside it, so the
// champion can be claimed. Brick posts the most *kills* and ace wins the most
// *blocks* — the season goes to ace, because a season measured in kills is a
// measure of who played the most rather than of who won.
const DONE_SEASON = 410
const DONE_BASE = DONE_SEASON * EPOCH
const DONE = []
for (let i = 0; i < 5; i++) DONE.push(score(ace, DONE_BASE + i, 2, 1, now - 900 + i))
for (let i = 5; i < 8; i++) DONE.push(score(brick, DONE_BASE + i, 40, 0, now - 900 + i))
for (let i = 0; i < 5; i++) DONE.push(score(brick, DONE_BASE + i, 1, 3, now - 900 + i))

// And a season with far more blocks than six pages of twenty can reach back
// through, so the paging stops inside it and nobody may be crowned.
const HUGE_SEASON = 411
const HUGE_BASE = HUGE_SEASON * EPOCH
const HUGE = []
for (let i = 0; i < 150; i++) HUGE.push(score(cinder, HUGE_BASE + i, 3, 1, now - 5000 + i))

const doneRelay = startPagingRelay(DONE)
const hugeRelay = startPagingRelay(HUGE)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--mute-audio',
  ],
})

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.$eval('#relays', (el, v) => { el.value = v }, relayUrl)
  await page.type('#name', 'boardtest')
  await page.type('#room', 'brd' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  check('the game starts against the fixture relay', started)
  if (!started) throw new Error('never reached the arena')

  await page.click('#show-board')
  // The chain view is the one worth landing on: it is the only one that shows
  // more than the current round without being a flat table.
  const onWall = await until(() =>
    page.evaluate(() => document.getElementById('board-tab-wall')?.classList.contains('on')))
  check('the leaderboard opens on the block wall', !!onWall)

  const tiles = await until(async () => {
    const n = await page.evaluate(() => document.querySelectorAll('.blocktile').length)
    return n > 0 ? n : null
  })
  check('every block anybody played is a tile', tiles === 3, `${tiles} tiles for 3 blocks`)

  const wall = await page.evaluate(() =>
    [...document.querySelectorAll('.wall > *')].map((n) => ({
      kind: n.className,
      height: n.querySelector('.bt-height')?.textContent ?? null,
      name: n.querySelector('.bt-name')?.textContent ?? null,
      // The kill count is an icon plus a number now, so the SVG's empty text
      // node comes along with it. Trimmed and compared whole rather than by
      // substring: `'3'` must not match a tile showing 13.
      kd: n.querySelector('.bt-kd')?.textContent?.trim() ?? null,
      players: n.querySelector('.bt-fine')?.textContent ?? null,
      season: n.querySelector('.season-name')?.textContent ?? null,
    })))

  const heights = wall.filter((n) => n.height).map((n) => Number(n.height.replace('#', '')))
  check(
    'newest block first, the way a chain is read',
    heights.length === 3 && heights[0] > heights[1] && heights[1] > heights[2],
    JSON.stringify(heights),
  )

  const tileFor = (h) => wall.find((n) => n.height === `#${h}`)
  // Not "a name is shown" — *which* name. The grouping is the entire feature
  // and a tile that renders the first record it saw would pass any check that
  // only asked whether something was there.
  const one = tileFor(BLOCKS.first)
  check(
    'the block goes to the most kills, not to whoever published first',
    one?.kd === '5' && one?.name === short(brick.pk),
    `${JSON.stringify(one)} — expected brick ${short(brick.pk)}`,
  )
  check('and it counts everybody who published for it', one?.players === '3 players', String(one?.players))

  const two = tileFor(BLOCKS.second)
  // The kill count cannot carry this one: both candidates claimed three, so
  // the number on the tile is the same whichever the tile picked. Only the name
  // distinguishes the tiebreak from a coin flip.
  check(
    'a tie on kills goes to whoever died less',
    two?.kd === '3' && two?.name === short(ace.pk),
    `${JSON.stringify(two)} — ace 3/1 (${short(ace.pk)}) vs cinder 3/5 (${short(cinder.pk)})`,
  )
  // Brick signed that height twice. An addressable event coming back in two
  // versions is one player, and counting it as two would silently inflate every
  // "N players" on the wall.
  check(
    'one player publishing a block twice is still one player',
    two?.players === '3 players',
    `${two?.players} — ace, brick (x2) and cinder`,
  )

  const separators = wall.filter((n) => n.season)
  check(
    'a difficulty adjustment breaks the chain into seasons',
    separators.length === 2,
    JSON.stringify(separators.map((s) => s.season)),
  )
  check(
    'and the seasons are numbered by epoch, not invented',
    separators.some((s) => s.season === `Season ${SEASON}`) &&
      separators.some((s) => s.season === `Season ${SEASON + 1}`),
    JSON.stringify(separators.map((s) => s.season)),
  )

  // --- faces arriving late ------------------------------------------------
  //
  // The tiles above rendered with short npubs because the relay was holding the
  // kind-0 events back. This is the half that used to be broken: the board is a
  // modal that rendered once, so a profile landing a second later changed
  // nothing until you closed it and opened it again.
  const beforeName = tileFor(BLOCKS.next)?.name ?? ''
  check(
    'a tile renders before any profile has landed',
    /^npub1/.test(beforeName),
    `${beforeName} — expected a short npub while profiles are withheld`,
  )
  serveProfiles = true
  await page.evaluate(() => void window.__profiles.want('0'.repeat(64)))
  const upgraded = await until(async () => {
    const name = await page.evaluate(
      () =>
        [...document.querySelectorAll('.blocktile')]
          .map((n) => n.querySelector('.bt-name')?.textContent ?? '')
          .find((t) => t === 'Cinder') ?? null,
    )
    return name
  })
  check('and upgrades itself to the face when the profile lands', upgraded === 'Cinder', String(upgraded))

  // --- one block's round ---------------------------------------------------
  //
  // The wall says who won a block. This is the screen that says what happened
  // in it, and every number on it comes out of records this file signed — which
  // is the only reason "brick went 5 and 1" is a checkable claim at all.

  await page.evaluate((h) => {
    document.querySelector(`.blocktile[data-block="${h}"]`).click()
  }, BLOCKS.first)
  const detail = await until(async () => {
    const rows = await page.evaluate(() => document.querySelectorAll('.detail-row').length)
    return rows > 0 ? rows : null
  })
  check('tapping a block opens that round', detail === 3, `${detail} rows for 3 players`)

  const round = await page.evaluate(() => ({
    title: document.querySelector('.detail-head h3')?.textContent ?? null,
    facts: [...document.querySelectorAll('.detail-facts span')].map((n) => n.textContent),
    rows: [...document.querySelectorAll('.detail-row')].map((n) => ({
      name: n.querySelector('.name')?.textContent ?? null,
      // Both are `.dr-num` spans; `:nth-of-type` counts spans among spans and
      // matches the rank, so index the class list instead.
      k: n.querySelectorAll('.dr-num')[0]?.textContent?.trim() ?? null,
      d: n.querySelectorAll('.dr-num')[1]?.textContent?.trim() ?? null,
      ratio: n.querySelector('.dr-ratio')?.textContent?.trim() ?? null,
    })),
  }))
  check('it names the block it is showing', round.title === `Block ${BLOCKS.first}`, String(round.title))
  check(
    'the round is ordered by kills, like the block it came from',
    round.rows.map((r) => r.k).join(',') === '5,2,1',
    JSON.stringify(round.rows.map((r) => r.k)),
  )
  check(
    "and it shows each player's deaths, not just their kills",
    round.rows.map((r) => r.d).join(',') === '1,4,6',
    JSON.stringify(round.rows.map((r) => r.d)),
  )
  check(
    'k/d is worked out per player',
    round.rows[0].ratio === '5.00' && round.rows[1].ratio === '0.50',
    JSON.stringify(round.rows.map((r) => r.ratio)),
  )
  check(
    'the round carries the map and the room the records named',
    round.facts.some((f) => f === 'Crossroads') && round.facts.some((f) => f === 'room lobby'),
    JSON.stringify(round.facts),
  )
  check(
    'and how many played it',
    round.facts.some((f) => f === '3 players'),
    JSON.stringify(round.facts),
  )

  await page.click('#detail-back')
  const backOnWall = await until(async () => {
    const n = await page.evaluate(() => document.querySelectorAll('.blocktile').length)
    return n > 0 ? n : null
  })
  check('and there is a way back to the chain', backOnWall === 3, `${backOnWall} tiles`)

  // --- the other tabs still work ------------------------------------------
  await page.click('#board-tab-all')
  const allRows = await until(async () => {
    const n = await page.evaluate(() => document.querySelectorAll('#board-rows .score-row').length)
    return n > 0 ? n : null
  })
  check('the all-time table is still there behind the wall', allRows === 3, `${allRows} rows`)
  await page.click('#board-tab-wall')
  const backToWall = await until(() =>
    page.evaluate(() => document.querySelectorAll('.blocktile').length === 3))
  check('and the wall comes back', !!backToWall)

  // A picture of the finished wall, because a grid that assembles correctly in
  // the DOM and looks wrong is the failure this project keeps hitting.
  if (process.env.TANK_SHOT) {
    await page.screenshot({ path: process.env.TANK_SHOT })
    console.log(`      wrote ${process.env.TANK_SHOT}`)
  }

  await page.close()

  // --- the same board on a phone -------------------------------------------
  //
  // Puzz reported the leaderboard as "not centered". It was centred; it was
  // also 591px wide inside a 390px screen, so the half of it you could see
  // was hard against the left edge and the rest was off the side of the glass.
  //
  // The cause is a CSS default rather than a layout mistake: a grid item's
  // automatic minimum size is its *min-content* width, which silently outranks
  // `width: min(880px, 100%)`. One wide row inside — the block wall — set the
  // floor. `.card { min-width: 0 }` puts the floor back at zero.
  //
  // These checks measure the card against the viewport rather than reading a
  // class or a computed `justify-items`, because the bug was never in the
  // alignment. Both of them go red against the parent commit.

  const phone = await browser.newPage()
  await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await phone.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await phone.$eval('#relays', (el, v) => { el.value = v }, relayUrl)
  await phone.type('#name', 'phonetest')
  await phone.type('#room', 'phn' + Math.floor(Math.random() * 1e6))

  // The lobby is the first thing a phone sees, and it had the same fault: the
  // skin row used to be six buttons wide and dragged the whole card
  // off-screen. It is a dropdown now, so the check is that the dropdown (and
  // the card around it) stays inside the glass — and that it is not empty.
  const lobbyFit = await phone.evaluate(() => {
    const card = document.querySelector('#lobby .card')
    const r = card.getBoundingClientRect()
    const sel = document.getElementById('skin-select')
    const sr = sel.getBoundingClientRect()
    return {
      left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth,
      selRight: Math.round(sr.right), options: sel.querySelectorAll('option').length,
    }
  })
  check(
    'the lobby card fits the phone it is being read on',
    lobbyFit.right <= lobbyFit.vw && lobbyFit.left >= 0,
    `card ${lobbyFit.left}..${lobbyFit.right} in ${lobbyFit.vw}`,
  )
  check(
    'and the skin picker is on the glass with a full rack behind it',
    lobbyFit.selRight <= lobbyFit.vw && lobbyFit.options >= 12,
    `picker ends at ${lobbyFit.selRight} in ${lobbyFit.vw}, ${lobbyFit.options} options`,
  )

  await phone.click('#play-guest')
  const phoneStarted = await phone
    .waitForFunction(() => !!window.__game, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  check('a session starts on a phone-sized screen', phoneStarted)

  if (phoneStarted) {
    // On a phone the actions row is collapsed behind the menu chip, so this is
    // the path a player actually takes to the leaderboard.
    await phone.evaluate(() => {
      if (document.getElementById('hud-actions').hidden) document.getElementById('chip-menu').click()
    })
    await phone.click('#show-board')
    const phoneWall = await until(() =>
      phone.evaluate(() => document.getElementById('board-tab-wall')?.classList.contains('on')))
    check('the leaderboard still opens on the blocks tab on a phone', !!phoneWall)
    await until(async () => {
      const n = await phone.evaluate(() => document.querySelectorAll('.blocktile').length)
      return n > 0 ? n : null
    })

    const fit = await phone.evaluate(() => {
      const card = document.querySelector('.board-card')
      const cr = card.getBoundingClientRect()
      // Anything sticking out of the card that cannot be scrolled to is
      // unreachable, which is the same fault one level down.
      const scrollable = (el) => {
        for (let n = el; n && n !== card.parentElement; n = n.parentElement) {
          const ox = getComputedStyle(n).overflowX
          if (ox === 'auto' || ox === 'scroll') return true
        }
        return false
      }
      const spilled = []
      for (const el of card.querySelectorAll('*')) {
        const r = el.getBoundingClientRect()
        if (!r.width) continue
        if ((r.right > cr.right + 1 || r.left < cr.left - 1) && !scrollable(el))
          spilled.push((el.id || el.className || el.tagName).toString().slice(0, 24))
      }
      return {
        left: Math.round(cr.left),
        right: Math.round(cr.right),
        vw: window.innerWidth,
        docScroll: document.documentElement.scrollWidth,
        spilled: spilled.slice(0, 6),
      }
    })
    check(
      'the leaderboard card fits inside the phone',
      fit.right <= fit.vw && fit.left >= 0,
      `card ${fit.left}..${fit.right} in ${fit.vw}`,
    )
    check(
      'and it is centred in it, not hard against one side',
      Math.abs(fit.left - (fit.vw - fit.right)) <= 2,
      `${fit.left}px left, ${fit.vw - fit.right}px right`,
    )
    check(
      'and the page itself does not scroll sideways',
      fit.docScroll <= fit.vw,
      `document ${fit.docScroll} against ${fit.vw}`,
    )
    check(
      'nothing inside the card is pushed off it without a way to scroll to it',
      fit.spilled.length === 0,
      fit.spilled.join(', '),
    )

    if (process.env.TANK_PHONE_SHOT) {
      await phone.screenshot({ path: process.env.TANK_PHONE_SHOT })
      console.log(`      wrote ${process.env.TANK_PHONE_SHOT}`)
    }
    await phone.close()
  }

  // --- more history than the wall holds ------------------------------------

  const deep = await browser.newPage()
  await deep.setViewport({ width: 1280, height: 900 })
  await deep.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await deep.$eval('#relays', (el, v) => { el.value = v }, deepUrl)
  await deep.type('#name', 'deeptest')
  await deep.type('#room', 'deep' + Math.floor(Math.random() * 1e6))
  await deep.click('#play-guest')
  const deepStarted = await deep
    .waitForFunction(() => !!window.__game, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  check('a session starts against a relay with more blocks than fit', deepStarted)

  if (deepStarted) {
    await deep.click('#show-board')
    const deepTiles = await until(async () => {
      const n = await deep.evaluate(() => document.querySelectorAll('.blocktile').length)
      return n > 0 ? n : null
    })
    check('the wall stops at its limit rather than rendering everything', deepTiles === 60,
      `${deepTiles} tiles from 70 blocks`)
    const note = await deep.evaluate(() => document.querySelector('.wall-note')?.textContent ?? '')
    // A cap nobody is told about reads as "this is all of it".
    check('and says so, rather than looking like the whole history',
      /older ones/.test(note), JSON.stringify(note))
    const leads = await deep.evaluate(() =>
      [...document.querySelectorAll('.season-fine')].map((n) => n.textContent))
    check(
      'no season tally is claimed for a season the window cut into',
      !leads.some((t) => /leads with/.test(t ?? '')),
      JSON.stringify(leads),
    )
    await deep.close()
  }
  // --- seasons -------------------------------------------------------------

  const openBoard = async (url, tag) => {
    const pg = await browser.newPage()
    await pg.setViewport({ width: 1280, height: 900 })
    await pg.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await pg.$eval('#relays', (el, v) => { el.value = v }, url)
    await pg.type('#name', tag)
    await pg.type('#room', tag + Math.floor(Math.random() * 1e6))
    await pg.click('#play-guest')
    const ok = await pg
      .waitForFunction(() => !!window.__game, { timeout: 25_000 })
      .then(() => true)
      .catch(() => false)
    if (!ok) return null
    await pg.click('#show-board')
    await pg.click('#board-tab-seasons')
    return pg
  }

  const donePage = await openBoard(doneRelay.url, 'season')
  check('a session starts against a relay with a finished season on it', donePage !== null)
  if (donePage) {
    const card = await until(async () => {
      const v = await donePage.evaluate(() => {
        const c = document.querySelector('.seasoncard')
        return c
          ? {
              partial: c.classList.contains('partial'),
              title: c.querySelector('.sn-title')?.textContent ?? null,
              range: c.querySelector('.sn-range')?.textContent ?? null,
              name: c.querySelector('.sn-name')?.textContent ?? null,
              won: c.querySelector('.sn-won')?.textContent ?? null,
            }
          : null
      })
      return v
    })
    check('a finished season gets a champion card', card && !card.partial, JSON.stringify(card))
    check(
      'the season is named and bounded by its epoch',
      card?.title === `Season ${DONE_SEASON}` && card?.range === `blocks ${DONE_BASE}–${DONE_BASE + EPOCH - 1}`,
      JSON.stringify(card),
    )
    // The whole point of the tiebreak. Brick claimed 120 kills across three
    // blocks; ace claimed 10 across five. A season measured in kills goes to
    // brick and measures who played the most, not who won.
    check(
      'the season goes to the most blocks won, not the most kills scored',
      card?.name === short(ace.pk),
      `${card?.name} — ace won 5 blocks with 10 kills, brick won 3 with 120 (${short(brick.pk)})`,
    )
    check('and it says how many of the season they took', card?.won === '5 of 8 blocks', String(card?.won))
    check('the relay was actually paged, not asked once', doneRelay.pages > 1, `${doneRelay.pages} REQs`)
    if (process.env.TANK_SHOT) {
      const seasonShot = process.env.TANK_SHOT.replace(/\.png$/, '-seasons.png')
      await donePage.screenshot({ path: seasonShot })
      console.log(`      wrote ${seasonShot}`)
    }
    await donePage.close()
  }

  const hugePage = await openBoard(hugeRelay.url, 'huge')
  check('a session starts against a season too long to page through', hugePage !== null)
  if (hugePage) {
    const partial = await until(async () =>
      hugePage.evaluate(() => {
        const c = document.querySelector('.seasoncard')
        return c ? { partial: c.classList.contains('partial'), text: c.textContent ?? '' } : null
      }))
    // Cinder won every block we can see. Crowning them would be the same lie
    // the block wall used to tell about season tallies, one screen over.
    check(
      'a season the paging could not reach the start of crowns nobody',
      partial?.partial === true && !/of \d+ blocks/.test(partial.text),
      JSON.stringify(partial),
    )
    check(
      'and says why, rather than showing an empty card',
      /not the whole season/.test(partial?.text ?? ''),
      JSON.stringify(partial?.text?.slice(0, 120)),
    )
    await hugePage.close()
  }

} catch (err) {
  check('the run completed', false, err.message)
} finally {
  await browser.close()
  wss.close()
  deepWss.close()
  doneRelay.close()
  hugeRelay.close()
}

console.log('')
if (failures.length) {
  console.error(`${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('All leaderboard checks passed.')
