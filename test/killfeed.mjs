// The kill feed: killer's face, skull, victim's face — Puzz's ask verbatim.
//
// The loop under test: a death event between two attested peers becomes a
// `.feed-kill` card with both names and a skull; the killer's kind 0 picture
// resolves through the profiles cache onto the line (a real <img> from a real
// HTTP server, so it loads and stays); a victim with no npub keeps the same
// coloured-initial fallback the scoreboard uses; a self-destruct stays a text
// line. Plus the two guards the pixels can't state: the built stylesheet
// actually styles `.feed-kill` (a class the script creates at runtime — the
// lesson from the tooltip that shipped unstyled), and the per-frame HUD paint
// does not churn the feed DOM when nothing changed (recreating an <img> every
// frame re-runs onerror against dead URLs forever).
//
//   npm run build && npx vite preview --port 4381 --strictPort &
//   TANK_URL=http://localhost:4381/ node test/killfeed.mjs

import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import puppeteer from 'puppeteer-core'

const SITE = process.env.TANK_URL ?? 'http://localhost:4381/'
if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(SITE)) {
  console.log(`SKIP  needs a plain-http origin; TANK_URL is ${SITE}`)
  process.exit(0)
}
const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!CHROME) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2) }

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 15_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) return null
    await wait(150)
  }
}

// -------------------------------------------- a relay, and a picture host

const published = []
const matches = (f, e) =>
  (!f.kinds || f.kinds.includes(e.kind)) &&
  (!f.authors || f.authors.includes(e.pubkey)) &&
  (!f['#t'] || e.tags.some((t) => t[0] === 't' && f['#t'].includes(t[1])))

const wss = new WebSocketServer({ port: 0 })
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    if (msg[0] === 'EVENT') {
      published.push(msg[1])
      return ws.send(JSON.stringify(['OK', msg[1].id, true, '']))
    }
    if (msg[0] !== 'REQ') return
    const [, id, ...filters] = msg
    for (const e of published) if (filters.some((f) => matches(f, e))) ws.send(JSON.stringify(['EVENT', id, e]))
    ws.send(JSON.stringify(['EOSE', id]))
  })
})
const relayUrl = `ws://localhost:${wss.address().port}`

// A 1x1 PNG over real HTTP, so the killer's <img> loads and never falls back.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const pictures = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'image/png', 'access-control-allow-origin': '*' })
  res.end(PNG)
})
await new Promise((r) => pictures.listen(0, r))
const PICTURE_URL = `http://localhost:${pictures.address().port}/killer.png`

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--mute-audio'],
})

try {
  const page = await browser.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.setViewport({ width: 1000, height: 1100 })
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForSelector('#relays', { timeout: 20_000 })
  await page.$eval('#relays', (el, v) => { el.value = v }, relayUrl)

  // The killer has a real npub with a kind 0 behind it, signed for real —
  // Profiles reads through the pool and the pool verifies signatures.
  const killerSk = generateSecretKey()
  const KILLER_NPUB = getPublicKey(killerSk)
  published.push(finalizeEvent({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({ name: 'reaper', picture: PICTURE_URL }),
  }, killerSk))

  await page.type('#name', 'witness')
  await page.type('#room', 'feed' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  await page.waitForFunction(() => !!window.__game, { timeout: 25_000 })

  // Killer (attested, npub above) and victim (session only — a guest).
  const KILLER_S = 'c1'.repeat(32)
  const VICTIM_S = 'c2'.repeat(32)
  await page.evaluate(([npub, ks, vs]) => {
    const g = window.__game
    const now = Math.floor(Date.now() / 1000)
    g.onEvent({
      id: 'd1'.repeat(16), pubkey: npub, kind: 21003, created_at: now, tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({ s: ks, name: 'reaper', color: 10, exp: now + 600 }),
    }, false)
    for (const [i, s] of [[2, ks], [3, vs]]) {
      g.onEvent({
        id: ('d' + i).repeat(16), pubkey: s, kind: 21000, created_at: now, tags: [], sig: '0'.repeat(128),
        content: JSON.stringify({ t: Date.now(), x: 400 + i * 100, y: 500, h: 0, g: 0, hp: 3, d: false }),
      }, false)
    }
    // The kill: the victim reports its own death and names the killer.
    g.onEvent({
      id: 'd4'.repeat(16), pubkey: vs, kind: 21002, created_at: now, tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), x: 500, y: 500, k: ks }),
    }, false)
  }, [KILLER_NPUB, KILLER_S, VICTIM_S])

  // ------------------------------------------------ 1. the card, with faces

  const card = await until(() =>
    page.evaluate((pic) => {
      const el = document.querySelector('#feed .feed-kill')
      if (!el) return null
      const img = el.querySelector('img.avatar')
      if (!img || !img.src.startsWith(pic.slice(0, 20))) return null // wait for the kind 0 to land
      const names = [...el.querySelectorAll('.feed-name')].map((n) => n.textContent)
      const fallback = el.querySelector('.avatar.fallback')
      const r = el.getBoundingClientRect()
      return {
        names,
        skull: el.querySelector('.feed-skull')?.textContent,
        imgSrc: img.src,
        imgLoaded: img.complete && img.naturalWidth > 0,
        fallbackText: fallback?.textContent ?? null,
        display: getComputedStyle(el).display,
        visible: r.width > 0 && r.height > 0,
      }
    }, PICTURE_URL), 25_000)
  check('a kill renders as a card: killer, skull, victim', !!card &&
    card.names?.[0] === 'reaper' && card.skull === '💀' && (card.names?.[1] ?? '').length > 0,
    JSON.stringify({ names: card?.names, skull: card?.skull }))
  check("the killer's kind 0 picture loads onto the line, over real HTTP",
    !!card && card.imgSrc === PICTURE_URL && card.imgLoaded, JSON.stringify({ src: card?.imgSrc, loaded: card?.imgLoaded }))
  check('the guest victim keeps the coloured-initial fallback, like the scoreboard',
    !!card && typeof card.fallbackText === 'string' && card.fallbackText.length === 1,
    JSON.stringify(card?.fallbackText))
  check('and the stylesheet actually styles the card the script creates',
    !!card && card.display === 'flex' && card.visible,
    JSON.stringify({ display: card?.display, visible: card?.visible }))

  // ---------------------------------------- 2. paint-on-change, not per-frame

  // Wait out the 6s feed expiry first: an entry ageing out mid-window is a
  // legitimate mutation and not the churn this check is about.
  await until(() => page.evaluate(() => document.querySelectorAll('#feed div').length === 0), 10_000)
  const churn = await page.evaluate(async () => {
    let mutations = 0
    const mo = new MutationObserver((list) => { mutations += list.length })
    mo.observe(document.getElementById('feed'), { childList: true, subtree: true, attributes: true })
    await new Promise((r) => setTimeout(r, 1500))
    mo.disconnect()
    return mutations
  })
  check('a quiet feed is not repainted every frame', churn === 0, `${churn} mutations in 1.5s`)

  // ------------------------------------------------- 3. self-destruct stays text

  await page.evaluate((vs) => {
    const g = window.__game
    g.onEvent({
      id: 'd5'.repeat(16), pubkey: vs, kind: 21002,
      created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), x: 500, y: 500, k: null }),
    }, false)
  }, VICTIM_S)
  const plain = await until(() =>
    page.evaluate(() => {
      const lines = [...document.querySelectorAll('#feed div')]
      const line = lines.find((l) => /self-destructed/.test(l.textContent ?? ''))
      return line ? { isCard: line.classList.contains('feed-kill') } : null
    }))
  check('a self-destruct stays a plain text line', !!plain && plain.isCard === false, JSON.stringify(plain))

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
  wss.close()
  pictures.close()
}

if (failures.length) {
  console.error(`\n${failures.length} failing: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nAll kill-feed checks passed.')
