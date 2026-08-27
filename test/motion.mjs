// Motion defaults: panels rise, chips drop, banners punch, rows deal in.
//
// From the art umbrella (71e33493): "Motion defaults: panels slide/fade in,
// banners punch, pills pop on earn. CSS-first; the game loop is not the
// animation engine."
//
// What has to be true, and why each check is shaped the way it is:
//
//   1. Every animated surface's ENTRY ANIMATION RESOLVES FROM THE BUILT
//      STYLESHEET — computed `animation-name` on the revealed element, not the
//      presence of a rule in the source. A selector that matches nothing ships
//      a page with no motion and a green suite, which is exactly how the
//      tooltip bug shipped on another project: jsdom-level checks cannot fail
//      for "the CSS silently missed".
//   2. The notice banner PUNCHES ONCE PER NOTICE, not once per HUD frame.
//      `drawNotice` runs every frame and `innerHTML` replaces children even
//      when the string is identical, so the punch on `#notice b` survives only
//      if the rewrite is guarded. The check is node identity across frames: a
//      marker property set on the <b> must still be there half a second later,
//      and must be GONE after a new notice replaces it.
//   3. `prefers-reduced-motion: reduce` turns all of it off.
//
// Revealed through real paths where one exists: the death card through
// `g.die()`, the podium through `__closeBlock` (a second block closing), the
// leaderboard through its button. The notice is set on the public `game.notice`
// field — the exact input `drawNotice` reads.
//
//   npm run build && npx vite preview --port 4381 --strictPort &
//   npm run test:motion

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4381/'
const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!CHROME) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2) }

const FLAGS = [
  '--no-sandbox', '--window-size=1280,900', '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
]

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms = 12_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await wait(80)
  }
  return null
}

const PEER = 'd1'.repeat(32)
const HASH = 'ab'.repeat(30) + '0300'
const HASH2 = 'cd'.repeat(30) + '0500'

/** Computed animation on the first element the selector matches. */
const anim = (selector) =>
  page.evaluate((sel) => {
    const n = document.querySelector(sel)
    if (!n) return { missing: sel }
    const cs = getComputedStyle(n)
    return { name: cs.animationName, duration: cs.animationDuration, hidden: !!n.closest('[hidden]') }
  }, selector)

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  // ------------------------------------------------ 1. the lobby rises on load

  const lobby = await anim('.lobby-card')
  check('the lobby card has an entry animation from the built stylesheet',
    lobby.name === 'panel-rise', JSON.stringify(lobby))

  await page.type('#name', 'motion')
  await page.type('#room', 'motion' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game, { timeout: 25_000 })
    .then(() => true).catch(() => false)
  check('a game is running', started)
  if (!started) throw new Error('the game never started')

  await page.evaluate((hash) => {
    window.__clock.accept({ height: 900000, hash, time: Math.floor(Date.now() / 1000) - 30 })
    window.__clock.accept = () => {}
    const g = window.__game
    g.beginRound(900000, hash)
    g.botsWanted = 0
    g.bots = []
    document.getElementById('podium').hidden = true
  }, HASH)
  await wait(600)

  // -------------------------------------- 2. the death card slams, for real

  await page.evaluate((PEER) => {
    const g = window.__game
    const peer = g.ensurePeer(PEER)
    peer.name = 'Hardhat'
    g.tank.dead = false
    g.tank.hp = 1
    g.watching = false
    g.die(PEER)
  }, PEER)
  const death = await until(async () => {
    const a = await anim('#death')
    return a.name && a.name !== 'none' && !a.hidden ? a : null
  }, 4000)
  check('the death card animates in through the real kill path',
    death?.name === 'card-slam', JSON.stringify(death))

  // Respawn and settle before the podium check so the card is gone.
  await until(() => page.evaluate(() => !window.__game.tank.dead), 6000)

  // ---------------------------------- 3. the podium: card rises, rows deal in

  await page.evaluate((hash2) => window.__closeBlock(900001, hash2), HASH2)
  const podium = await until(async () => {
    const a = await anim('#podium .card')
    return !a.hidden && a.name !== 'none' ? a : null
  }, 4000)
  check('the podium card rises through the real block-close path',
    podium?.name === 'panel-rise', JSON.stringify(podium))

  const rows = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#podium-rows .score-row')]
    return rows.map((r) => {
      const cs = getComputedStyle(r)
      return { name: cs.animationName, delay: cs.animationDelay }
    })
  })
  check('podium standings animate', rows.length > 0 && rows.every((r) => r.name === 'row-in'),
    JSON.stringify(rows))
  if (rows.length > 1) {
    check('later podium rows are staggered behind the first',
      rows[0].delay === '0s' && rows.slice(1).every((r, i) => parseFloat(r.delay) > i * 0.01),
      JSON.stringify(rows.map((r) => r.delay)))
  }
  await page.evaluate(() => { document.getElementById('podium').hidden = true })

  // ------------------------------------------- 4. the leaderboard, by its button

  await page.click('#show-board')
  const board = await anim('.board-card')
  check('the leaderboard card rises when opened by its button',
    board.name === 'panel-rise' && !board.hidden, JSON.stringify(board))
  await page.click('#board-close')

  // ------------------------- 5. the banner punches once per notice, not per frame

  const first = await page.evaluate(() => {
    window.__game.notice = { text: 'DOUBLE KILL', sub: 'two in four seconds', hue: 45, at: performance.now() }
  })
  void first
  const punched = await until(async () => {
    const a = await anim('#notice b')
    return a.name === 'banner-punch' && !a.hidden ? a : null
  }, 3000)
  check('the notice text punches from the built stylesheet', !!punched, JSON.stringify(punched))

  // Mark the live <b>. If drawNotice rewrites per frame, the marked node is
  // replaced within one HUD frame (125ms); it must survive half a second.
  await page.evaluate(() => { document.querySelector('#notice b').__mark = true })
  await wait(500)
  const held = await page.evaluate(() => {
    const b = document.querySelector('#notice b')
    return { same: !!(b && b.__mark), hidden: !!document.getElementById('notice').hidden }
  })
  check('the same notice does not rebuild its node across HUD frames (no strobe)',
    held.same && !held.hidden, JSON.stringify(held))

  // A NEW notice must replace the node, or the second banner never punches.
  await page.evaluate(() => {
    window.__game.notice = { text: 'TRIPLE KILL', sub: 'three in six seconds', hue: 10, at: performance.now() }
  })
  const replaced = await until(() => page.evaluate(() => {
    const b = document.querySelector('#notice b')
    return b && !b.__mark && b.textContent === 'TRIPLE KILL'
  }), 2000)
  check('a new notice replaces the node so the punch fires again', !!replaced)

  // And the old JS fade near end-of-life still runs on top of the punch.
  await page.evaluate(() => {
    // Aged 1.8s of its 2.2s life: opacity ≈ 0.6, with 400ms left before it
    // hides — wide enough for the 8fps HUD and the 80ms poll to meet.
    window.__game.notice = { text: 'FADING', sub: 'late life', hue: 100, at: performance.now() - 1800 }
  })
  const fading = await until(() => page.evaluate(() => {
    const n = document.getElementById('notice')
    return !n.hidden && n.textContent.includes('FADING') && parseFloat(n.style.opacity) < 0.8
  }), 2000)
  check('the late-life fade still runs on the container', !!fading)

  // ----------------------------------- 6. chips carry their entry animations

  // #rules and #ctf are round-state driven; what must hold is that the built
  // stylesheet resolves an animation for them at all — checked against the
  // CSSOM the browser actually parsed, so a typoed selector or a dropped
  // keyframes block fails here.
  const chips = await page.evaluate(() => {
    const found = { rules: null, ctf: null, keyframes: [] }
    for (const sheet of document.styleSheets) {
      for (const rule of sheet.cssRules) {
        if (rule.type === CSSRule.KEYFRAMES_RULE) found.keyframes.push(rule.name)
        if (rule.type === CSSRule.STYLE_RULE && rule.style.animationName && rule.style.animationName !== 'none') {
          const sel = rule.selectorText
          if (/#rules\b/.test(sel)) found.rules = rule.style.animationName
          if (/#ctf\b/.test(sel)) found.ctf = rule.style.animationName
        }
      }
    }
    return found
  })
  check('the rules and ctf chips are animated by parsed CSS, and the keyframes exist',
    chips.rules === 'chip-drop' && chips.ctf === 'chip-drop' && chips.keyframes.includes('chip-drop'),
    JSON.stringify(chips))

  // ------------------------------------------ 7. reduced motion turns it off

  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  const calmed = await page.evaluate(() => {
    const picks = ['.lobby-card', '#death', '#notice b', '#podium .card']
    return picks.map((sel) => {
      const n = document.querySelector(sel)
      return n ? getComputedStyle(n).animationName : 'missing'
    })
  })
  check('prefers-reduced-motion stills every entry animation',
    calmed.every((n) => n === 'none'), JSON.stringify(calmed))
  await page.emulateMediaFeatures([])

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} catch (e) {
  check('suite ran to the end', false, String(e))
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nALL PASS')
process.exit(failures.length ? 1 : 0)
