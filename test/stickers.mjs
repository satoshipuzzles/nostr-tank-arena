// Emoji stickers: pick them in the garage, the room sees them, junk is refused.
//
// The loop under test is the whole feature: the grid is one-tap on/off with a
// four-slot cap, the preview's deck actually paints the pick (proven on
// pixels, and proven able to fail by peeling the sticker back off), starting a
// game puts `em` on the session attestation, a peer's attestation dresses
// their tank, and a hand-rolled payload keeps only catalog entries — a
// sticker is a picture, not a text field, so a free string must not survive
// to anybody's screen.
//
//   npm run build && npx vite preview --port 4381 --strictPort &
//   TANK_URL=http://localhost:4381/ node test/stickers.mjs
//
// Like test/customskin.mjs this runs its own relay, because the only way to
// check what was published is to be the relay it was published to.

import { existsSync } from 'node:fs'
import { WebSocketServer } from 'ws'
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

// ------------------------------------------------ the relay that remembers

const published = []
const matches = (f, e) =>
  (!f.kinds || f.kinds.includes(e.kind)) &&
  (!f.authors || f.authors.includes(e.pubkey)) &&
  (!f['#d'] || e.tags.some((t) => t[0] === 'd' && f['#d'].includes(t[1]))) &&
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
  await page.waitForSelector('#sticker-grid button', { timeout: 20_000 })
  await page.$eval('#relays', (el, v) => { el.value = v }, relayUrl)

  // ------------------------------------------------------- 1. the picker

  const tap = (emoji) =>
    page.$$eval('#sticker-grid button', (bs, e) => {
      const b = bs.find((x) => x.dataset.value === e)
      if (b) b.click()
      return !!b
    }, emoji)

  await tap('💙')
  await tap('🔥')
  const picked = await page.evaluate(() => ({
    on: [...document.querySelectorAll('#sticker-grid button[aria-pressed="true"]')].map((b) => b.dataset.value),
    count: document.getElementById('sticker-count').textContent,
    saved: localStorage.getItem('tank.stickers'),
  }))
  check('two taps wear two stickers, counted and saved',
    picked.on.length === 2 && picked.on.includes('💙') && picked.on.includes('🔥') &&
      picked.count === '2/4' && picked.saved === JSON.stringify(['💙', '🔥']),
    JSON.stringify(picked))

  // The cap: two more fill the deck, a sixth tap bounces off.
  await tap('💀')
  await tap('🎯')
  await tap('👑')
  const capped = await page.evaluate(() => JSON.parse(localStorage.getItem('tank.stickers')))
  check('the deck holds four; a fifth pick is refused, not silently swapped',
    capped.length === 4 && !capped.includes('👑'), JSON.stringify(capped))
  await tap('💀')
  await tap('🎯')

  // ---------------------------------------------- 2. the preview's pixels

  // 💙 is a blue no plastic hull at the preview hue (48, amber) produces, so
  // its share of the lit pixels is the sticker being *drawn*, not merely
  // being state. Measured, peeled off, measured again: the second half is the
  // proof this check can fail.
  const blueShare = () =>
    page.evaluate(() => {
      const c = document.getElementById('tank-cam')
      const off = document.createElement('canvas')
      off.width = c.width; off.height = c.height
      const ctx = off.getContext('2d')
      ctx.drawImage(c, 0, 0)
      const { data } = ctx.getImageData(0, 0, off.width, off.height)
      let blue = 0, lit = 0
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2]
        if ((r + g + b) / 3 <= 45) continue
        lit++
        if (b > 110 && b > r * 1.45 && b > g * 1.25) blue++
      }
      return lit ? blue / lit : 0
    })
  const worn = await until(async () => ((await blueShare()) > 0.012 ? await blueShare() : null))
  check('the garage preview paints the blue heart on the deck', worn !== null,
    `blue share ${worn ?? (await blueShare())}`)
  await tap('💙')
  await wait(700)
  const peeled = await blueShare()
  check('and peeling it off takes the blue with it (the check can fail)',
    peeled < 0.006, `blue share ${peeled}`)
  await tap('💙')

  // ------------------------------------------------------- 3. the wire

  await page.type('#name', 'decals')
  await page.type('#room', 'stick' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  await page.waitForFunction(() => !!window.__game, { timeout: 25_000 })

  const att = await until(() => {
    const e = published.find((ev) => ev.kind === 21003 && JSON.parse(ev.content).em)
    return e ? JSON.parse(e.content) : null
  }, 40_000)
  check('the attestation carries the stickers, slot by slot',
    !!att && JSON.stringify(att.em) === JSON.stringify(['🔥', '💙']), JSON.stringify(att?.em))

  // ------------------------------------- 4. a peer's stickers, and junk ones

  // Hand-built attestations, injected the way customskin.mjs does: the parse
  // under test is the receiver's, and `asStickers` is the whole gate.
  await page.evaluate(() => {
    const g = window.__game
    const mk = (id, session, em) => g.onEvent({
      id, pubkey: 'f1'.repeat(32), kind: 21003,
      created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({ s: session, name: 'peer', color: 200,
        exp: Math.floor(Date.now() / 1000) + 600, em }),
    }, false)
    mk('b1'.repeat(16), 'e2'.repeat(32), ['💀', '🎯'])
    mk('b2'.repeat(16), 'e4'.repeat(32),
      ['FREE MONEY at scam.example', '🔥', 12, '💩', '⚡', '👻', '👑', '🍕'])
  })
  const peers = await page.evaluate(() => ({
    honest: window.__game.peers.get('e2'.repeat(32))?.stickers,
    junk: window.__game.peers.get('e4'.repeat(32))?.stickers,
  }))
  check("a peer's attestation dresses their tank", JSON.stringify(peers.honest) === JSON.stringify(['💀', '🎯']),
    JSON.stringify(peers.honest))
  check('junk entries are dropped one by one; the cap holds; catalog is the gate',
    JSON.stringify(peers.junk) === JSON.stringify(['🔥', '⚡', '👻', '👑']), JSON.stringify(peers.junk))

  // ------------------------------------------------- 5. live re-dress

  await page.evaluate(() => document.querySelector('#sticker-grid button[data-value="🍩"]')?.click())
  const live = await page.evaluate(() => window.__game.stickers)
  check('a mid-match pick reaches the running game for the next attestation',
    Array.isArray(live) && live.includes('🍩'), JSON.stringify(live))

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
  wss.close()
}

if (failures.length) {
  console.error(`\n${failures.length} failing: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nAll sticker checks passed.')
