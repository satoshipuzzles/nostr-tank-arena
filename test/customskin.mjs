// Custom skins: upload your own art, wear it, and the room sees it.
//
// The loop under test is the whole feature: a file becomes a bounded JPEG
// data URL (encodeArt), the rack shows it, the preview wears it, starting a
// game publishes BOTH the attestation marker (`sk: "u:<slug>"`) and the skin
// event itself (kind 30078, `d: nostr-tank-arena/skin/<slug>`), and a client
// that sees a stranger's marker fetches their event and dresses their tank.
// Fail-soft is half the design, so it gets its own checks: a marker whose
// event never arrives stays plastic-in-hue and does not error, and a
// malicious "art" that is not a bounded data URL is refused by the parser.
//
//   npm run build && npx vite preview --port 4381 --strictPort &
//   TANK_URL=http://localhost:4381/ node test/customskin.mjs
//
// Like test/lobby.mjs this runs its own relay, because the only way to check
// what was published is to be the relay it was published to.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
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

// ------------------------------------------------ the relay that remembers

/** Everything published, and a matcher good enough for the filters we use. */
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
  // AFTER the app has painted, not merely after domcontentloaded: module init
  // rewrites #relays from storage, so a value written too early is replaced
  // by the defaults and the game quietly plays against the real network.
  await page.waitForSelector('#skin-pattern button', { timeout: 20_000 })
  await page.$eval('#relays', (el, v) => { el.value = v }, relayUrl)

  // ------------------------------------------------------------- 1. upload

  // The art is generated in the page (a magenta/cyan quadrant square, 400px —
  // bigger than ART_SIZE so the resample path actually runs) and written to
  // disk for the file input.
  mkdirSync('.scratch', { recursive: true })
  const pngB64 = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 400
    c.height = 400
    const g = c.getContext('2d')
    g.fillStyle = '#ff00cc'; g.fillRect(0, 0, 400, 400)
    g.fillStyle = '#00e5ff'; g.fillRect(0, 0, 200, 200); g.fillRect(200, 200, 200, 200)
    return c.toDataURL('image/png').split(',')[1]
  })
  writeFileSync('.scratch/upload-art.png', Buffer.from(pngB64, 'base64'))

  const fileInput = await page.$('#custom-file')
  await fileInput.uploadFile('.scratch/upload-art.png')
  const uploaded = await until(() =>
    page.evaluate(() => {
      const img = document.querySelector('#custom-rack .custom-wear img')
      if (!img) return null
      const worn = document.querySelector('#custom-rack .custom-wear[aria-pressed="true"]')
      return { art: img.getAttribute('src') ?? '', worn: !!worn,
        blurb: document.getElementById('skin-blurb').textContent }
    }))
  check('an upload lands in the rack, worn, and the blurb says whose art it is',
    !!uploaded && uploaded.worn && /your own art/i.test(uploaded.blurb ?? ''),
    JSON.stringify({ worn: uploaded?.worn, blurb: uploaded?.blurb }))
  check('and the saved art is a bounded JPEG data URL, resampled down',
    !!uploaded && /^data:image\/jpeg;base64,/.test(uploaded.art) && uploaded.art.length < 24_576 * 1.4,
    `${uploaded?.art?.slice(0, 30)}… ${uploaded?.art?.length} chars`)

  // The preview wears it: the art is magenta/cyan, hues no built-in skin has.
  const previewHue = () =>
    page.evaluate(() => {
      const c = document.getElementById('tank-cam')
      const off = document.createElement('canvas')
      off.width = c.width; off.height = c.height
      const ctx = off.getContext('2d')
      ctx.drawImage(c, 0, 0)
      const { data } = ctx.getImageData(0, 0, off.width, off.height)
      let magenta = 0, lit = 0
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2]
        if ((r + g + b) / 3 <= 60) continue
        lit++
        if (r > 120 && b > 120 && g < r * 0.6) magenta++
      }
      return lit ? magenta / lit : 0
    })
  const wearing = await until(async () => ((await previewHue()) > 0.08 ? await previewHue() : null))
  check('the garage preview paints the uploaded art on the hull',
    wearing !== null, `magenta fraction ${wearing ?? (await previewHue())}`)

  // ------------------------------------------- 2. the wire: marker and event

  await page.type('#name', 'artist')
  await page.type('#room', 'skin' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  await page.waitForFunction(() => !!window.__game, { timeout: 25_000 })

  const wire = await until(() => {
    const att = published.find((e) => e.kind === 21003 && (JSON.parse(e.content).sk ?? '').startsWith('u:'))
    const skin = published.find((e) => e.kind === 30078 &&
      e.tags.some((t) => t[0] === 'd' && t[1].startsWith('nostr-tank-arena/skin/')))
    return att && skin ? { att: JSON.parse(att.content), skin } : null
  }, 40_000)
  check('the attestation carries the marker, not the image', !!wire && /^u:[a-z0-9-]+$/.test(wire.att.sk),
    wire?.att?.sk)
  check('and the skin event itself is published, small, and self-contained',
    !!wire && JSON.stringify(wire.skin).length < 40_000 &&
      /^data:image\/jpeg;base64,/.test(JSON.parse(wire.skin.content).art ?? ''),
    `event ${wire ? JSON.stringify(wire.skin).length : '?'} bytes`)

  // ----------------------------------- 3. a stranger's art dresses their tank

  // A second wearer, hand-built: their skin event goes into the relay store,
  // then their attestation and tick arrive like any peer's. The client under
  // test has to notice the marker, fetch the event, and dress the tank.
  // Signed for real: the resolver reads through the pool, and the pool
  // verifies signatures — an unsigned fake dies there, which is itself the
  // system working.
  const peerSk = generateSecretKey()
  const PEER_NPUB = getPublicKey(peerSk)
  const PEER_SESSION = 'e2'.repeat(32)
  const art = uploaded.art
  published.push(finalizeEvent({
    kind: 30078,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', 'nostr-tank-arena/skin/vandal'], ['t', 'tankarena-skin']],
    content: JSON.stringify({ name: 'vandal', art }),
  }, peerSk))
  await page.evaluate(([npub, session]) => {
    const g = window.__game
    g.onEvent({
      id: 'a1'.repeat(16), pubkey: npub, kind: 21003,
      created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({ s: session, name: 'vandal', color: 200,
        exp: Math.floor(Date.now() / 1000) + 600, sk: 'u:vandal', cc: 'rookie' }),
    }, false)
    g.onEvent({
      id: 'a2'.repeat(16), pubkey: session, kind: 21000,
      created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), x: 500, y: 500, h: 0, g: 0, hp: 3, d: false }),
    }, false)
  }, [PEER_NPUB, PEER_SESSION])

  const dressed = await until(() =>
    page.evaluate((session) => {
      const p = window.__game.peers.get(session)
      return p?.customArt ? { slug: p.customSkin, len: p.customArt.length } : null
    }, PEER_SESSION))
  check("a stranger's marker resolves to their published art", !!dressed && dressed.slug === 'vandal',
    JSON.stringify(dressed))

  // ------------------------------------------------- 4. fail-soft, two ways

  // A wearer whose event never arrives: marker stands, art stays null, and
  // the page does not error — the tank simply keeps its plastic.
  const GHOST_NPUB = 'e3'.repeat(32)
  const GHOST_SESSION = 'e4'.repeat(32)
  await page.evaluate(([npub, session]) => {
    const g = window.__game
    g.onEvent({
      id: 'a3'.repeat(16), pubkey: npub, kind: 21003,
      created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({ s: session, name: 'ghost', color: 100,
        exp: Math.floor(Date.now() / 1000) + 600, sk: 'u:nothere', cc: 'rookie' }),
    }, false)
    g.onEvent({
      id: 'a4'.repeat(16), pubkey: session, kind: 21000,
      created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), x: 600, y: 500, h: 0, g: 0, hp: 3, d: false }),
    }, false)
  }, [GHOST_NPUB, GHOST_SESSION])
  await wait(5_000)
  const ghost = await page.evaluate((session) => {
    const p = window.__game.peers.get(session)
    return { skin: p?.skin, ref: p?.customSkin, art: p?.customArt }
  }, GHOST_SESSION)
  check('a marker with no event behind it stays plastic in the right hue',
    ghost.skin === 'plastic' && ghost.ref === 'nothere' && ghost.art === null,
    JSON.stringify(ghost))

  // Hostile art is refused by the receiver, not just never sent: a remote URL
  // in the art field would turn every viewer into a tracking pixel.
  // Signed for real, like the vandal above — unsigned it would die at the
  // pool's signature check and this check would pass without ever reaching
  // the validation it is about.
  const hostileSk = generateSecretKey()
  const HOSTILE_NPUB = getPublicKey(hostileSk)
  published.push(finalizeEvent({
    kind: 30078,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['d', 'nostr-tank-arena/skin/track'], ['t', 'tankarena-skin']],
    content: JSON.stringify({ name: 'track', art: 'https://evil.example/pixel.png' }),
  }, hostileSk))
  await page.evaluate((npub) => {
    const g = window.__game
    g.onEvent({
      id: 'a5'.repeat(16), pubkey: npub, kind: 21003,
      created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({ s: 'e6'.repeat(32), name: 'track', color: 40,
        exp: Math.floor(Date.now() / 1000) + 600, sk: 'u:track', cc: 'rookie' }),
    }, false)
    g.onEvent({
      id: 'a6'.repeat(16), pubkey: 'e6'.repeat(32), kind: 21000,
      created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), x: 700, y: 500, h: 0, g: 0, hp: 3, d: false }),
    }, false)
  }, HOSTILE_NPUB)
  await wait(5_000)
  const hostile = await page.evaluate(() => window.__game.peers.get('e6'.repeat(32))?.customArt ?? null)
  check('an event whose art is a remote URL is refused — no fetch, no dress-up',
    hostile === null, JSON.stringify(hostile))

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))

  if (process.env.TANK_SHOT) {
    await page.screenshot({ path: process.env.TANK_SHOT })
    console.log(`      wrote ${process.env.TANK_SHOT}`)
  }
} catch (err) {
  check('the run completed', false, err.message)
} finally {
  await browser.close()
  wss.close()
}

console.log('')
if (failures.length) {
  console.error(`${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('All custom-skin checks passed.')
