// Does this game work on a phone?
//
//   npm run build && npm run preview &
//   npm run test:mobile
//
// Three questions, and they fail in three different ways:
//
//   1. Is it installable — manifest, service worker, icons that exist.
//   2. Do the touch controls drive the tank. Not "is a stick drawn", which is a
//      div and proves nothing; whether a thumb dragged across the glass moves
//      the tank in the direction the thumb went.
//   3. Does any of it leak onto a desk. A mouse-and-keyboard session must be
//      exactly what it was before, including no rotate screen in a tall window.
//
// The second one is the reason this file exists rather than a screenshot. A
// touch layer that renders beautifully and never reaches `Input.read` looks
// identical in a picture to one that works.

import { existsSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import puppeteer from 'puppeteer-core'

const SITE = process.env.TANK_URL ?? 'http://localhost:4173/'

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
/**
 * Poll until it is true, rather than sleeping for a guess.
 *
 * Under swiftshader this game simulates at a fraction of real time and the
 * fraction depends on what else the machine is doing. Every fixed `wait()` in
 * front of an assertion is a window that stops containing the behaviour on a
 * loaded laptop, which is a test that fails for a reason that has nothing to do
 * with the code.
 */
async function until(fn, ms = 12_000, step = 150) {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) return null
    await wait(step)
  }
}

// A relay that accepts everything, so nothing in this file is measuring the
// public network. It is not asked about behaviour anywhere — the game simply
// needs somewhere for its ticks to go.
const wss = new WebSocketServer({ port: 0 })
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (msg[0] === 'REQ') ws.send(JSON.stringify(['EOSE', msg[1]]))
    else if (msg[0] === 'EVENT') ws.send(JSON.stringify(['OK', msg[1].id, true, '']))
  })
})
const relayUrl = `ws://localhost:${wss.address().port}`
const localOrigin = /^http:\/\/(localhost|127\.0\.0\.1)/.test(SITE)

const IPHONE = {
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  viewport: { width: 852, height: 393, deviceScaleFactor: 2, isMobile: true, hasTouch: true, isLandscape: true },
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--mute-audio',
  ],
})

try {
  // ------------------------------------------------------------- installable

  const shell = await browser.newPage()
  const manifest = await shell.goto(new URL('/manifest.webmanifest', SITE).href)
  // Status alone cannot carry this. A dev server that falls back to index.html
  // for anything it does not recognise answers 200 for a manifest that does not
  // exist — measured, against this project's own `vite preview`. So the content
  // type is the assertion and the status is the detail.
  check(
    'the manifest is served',
    manifest.status() === 200 && /json|manifest/i.test(manifest.headers()['content-type'] ?? ''),
    `${manifest.status()} ${manifest.headers()['content-type']}`,
  )
  let mf = null
  try {
    mf = JSON.parse(await manifest.text())
  } catch (e) {
    check('the manifest is valid JSON', false, e.message)
  }
  if (mf) {
    check('the manifest is valid JSON', true)
    // Installability on Android is a checklist and these are the entries that
    // silently disqualify: no 192, no 512, or an icon URL that 404s. Chrome
    // reports none of it in the console.
    const sizes = (mf.icons ?? []).map((i) => i.sizes)
    check(
      'it declares the two icon sizes an install prompt requires',
      sizes.includes('192x192') && sizes.includes('512x512'),
      JSON.stringify(sizes),
    )
    check('and one of them is maskable, so Android does not crop the tank',
      (mf.icons ?? []).some((i) => i.purpose === 'maskable'),
      JSON.stringify((mf.icons ?? []).map((i) => i.purpose)))
    check('it opens fullscreen in landscape', mf.orientation === 'landscape', String(mf.orientation))

    for (const icon of mf.icons ?? []) {
      const res = await shell.goto(new URL(icon.src, SITE).href)
      // A manifest pointing at a missing icon is the single most common way a
      // PWA is quietly not installable, and nothing anywhere says so.
      check(`the ${icon.sizes} icon actually exists`, res.status() === 200, `${icon.src} ${res.status()}`)
    }
  }
  const sw = await shell.goto(new URL('/sw.js', SITE).href)
  const swText = await sw.text()
  check(
    'the service worker is served',
    sw.status() === 200 && /javascript/i.test(sw.headers()['content-type'] ?? ''),
    `${sw.status()} ${sw.headers()['content-type']}`,
  )
  // Cache-first would keep serving yesterday's bundle after a deploy, which on a
  // game that ships several times a day is worse than having no worker at all.
  check(
    'and it is network-first, so a deploy is not stuck behind a cache',
    /fetch\(req\)\s*\n?\s*\.then/.test(swText),
    `${swText.length} bytes`,
  )
  const iconLink = await (await browser.newPage().then(async (p) => {
    await p.goto(SITE, { waitUntil: 'domcontentloaded' })
    const v = await p.evaluate(() => ({
      apple: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') ?? null,
      manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null,
      theme: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
    }))
    await p.close()
    return v
  }))
  check('the page links its manifest', iconLink.manifest === '/manifest.webmanifest', String(iconLink.manifest))
  // iOS ignores the manifest's icons entirely; without this an added-to-home
  // -screen game gets a screenshot of the page as its icon.
  check('and carries an apple-touch-icon, which iOS uses instead of the manifest',
    iconLink.apple === '/icon-180.png', String(iconLink.apple))
  check('and a theme colour, so the notch bar is not white', iconLink.theme === '#0d1119', String(iconLink.theme))
  await shell.close()

  // ------------------------------------------------------------ on the glass

  if (!localOrigin) {
    console.log(`SKIP  the touch checks need a plain-http origin; TANK_URL is ${SITE}`)
    console.log('      the ws:// fake relay is blocked as mixed content from https.')
  } else {
    const page = await browser.newPage()
    await page.emulate({ name: 'iPhone', ...IPHONE })
    await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.$eval('#relays', (el, v) => { el.value = v }, relayUrl)
    await page.type('#name', 'thumbs')
    await page.type('#room', 'mob' + Math.floor(Math.random() * 1e6))

    // The lobby is where "is this a phone" has to be answered, and in the lobby
    // the canvas is underneath the card. A tap on a button is the only touch
    // this page will see before the game starts.
    await page.touchscreen.tap(430, 340)
    check(
      'a tap anywhere — not just on the board — is enough to know this is a phone',
      await page.evaluate(() => document.getElementById('touch')?.classList.contains('live') ?? false),
      'the touch layer goes live on the first touch anywhere on the page',
    )

    await page.click('#play-guest')
    const started = await page
      .waitForFunction(() => !!window.__game, { timeout: 25_000 })
      .then(() => true)
      .catch(() => false)
    check('the game starts on a phone-sized landscape viewport', started)
    if (!started) throw new Error('never reached the arena')

    // Pin the board, or the map comes from the live chain tip and the open lane
    // this test drives down may be a wall today. `05` is Straight Deathmatch.
    await page.evaluate((t) => {
      window.__clock.accept({ height: 999999, hash: 'ab'.repeat(30) + '0500', time: t })
      document.getElementById('podium').hidden = true
    }, Math.floor(Date.now() / 1000))
    await wait(800)

    const hints = await page.evaluate(() => ({
      touch: !document.getElementById('touch-hint').hidden,
      keyboard: !document.getElementById('controls-hint').hidden,
      players: document.getElementById('row-players').hidden,
    }))
    check('the phone is told about thumbs, not about WASD', hints.touch && !hints.keyboard, JSON.stringify(hints))
    check('and two-players-on-one-screen is not offered on a phone', hints.players)

    // --- the compact hud ---------------------------------------------------
    //
    // Puzz's ask: default to the full board canvas, collapse the stats and the
    // relay info, open them on a tap.
    //
    // Every assertion here reads the *computed* style rather than the `hidden`
    // attribute. That is not belt-and-braces — `[hidden] { display: none }` in
    // the UA stylesheet loses to any author rule that sets `display`, and both
    // `.panel` and `#hud-actions` set one. This project has shipped that exact
    // bug twice, both times with a green test asserting the attribute.
    const shown = (id) =>
      page.evaluate((i) => getComputedStyle(document.getElementById(i)).display !== 'none', id)

    check(
      'the stats and relay panels start collapsed on a phone',
      !(await shown('scoreboard')) && !(await shown('status')),
      `scoreboard ${await shown('scoreboard')}, status ${await shown('status')}`,
    )
    check('and so does the button bar', !(await shown('hud-actions')))
    check('the chip row is there instead', await shown('hud-chips'))

    // The claim is about pixels, not about the DOM. Sample a grid across the
    // board and ask the browser what is actually on top at each point: a panel
    // that is present, correct and covering the arena passes every structural
    // check ever written and is the entire bug.
    const covered = await page.evaluate(() => {
      const panels = ['scoreboard', 'status', 'hud-actions', 'controls-hint']
      const hits = []
      for (let x = 0.08; x <= 0.92; x += 0.12) {
        for (let y = 0.08; y <= 0.92; y += 0.12) {
          const el = document.elementFromPoint(
            Math.round(innerWidth * x),
            Math.round(innerHeight * y),
          )
          const id = el?.closest('[id]')?.id ?? ''
          if (panels.includes(id)) hits.push(`${id}@${x.toFixed(2)},${y.toFixed(2)}`)
        }
      }
      return hits
    })
    check(
      'and nothing covers the board — the canvas is the screen',
      covered.length === 0,
      covered.length ? covered.slice(0, 5).join(' ') : '64 sample points, all board',
    )

    // A chip that says "stats" tells a player nothing they could not guess. The
    // point of the collapsed state is that the panel keeps doing its job shut.
    const chipText = await page.evaluate(() => ({
      score: document.querySelector('#chip-score .chip-text').textContent,
      status: document.querySelector('#chip-status .chip-text').textContent,
      bad: document.getElementById('chip-status').classList.contains('bad'),
    }))
    // The status chip has two legitimate readings and a headless run can land
    // on either: the opponent count when the relays are fine, and "relays" when
    // they are not. Asserting only the first made this check fail on a run
    // where the chip was doing exactly its job. Both are accepted, and the
    // trouble reading has to be red — a chip that says "relays" in the ordinary
    // colour is the warning failing to warn.
    check(
      'the collapsed chips still carry the numbers',
      /^\d+\/\d+$/.test(chipText.score) &&
        (/^\d+ opps?$/.test(chipText.status) || (chipText.status === 'relays' && chipText.bad)),
      JSON.stringify(chipText),
    )

    // Centre of the chip, computed. A hardcoded coordinate here would be a test
    // that passes because the chip happens to be where it was last week.
    const chipAt = (id) =>
      page.evaluate((i) => {
        const r = document.getElementById(i).getBoundingClientRect()
        return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]
      }, id)
    const scoreChip = await chipAt('chip-score')
    await page.touchscreen.tap(...scoreChip)
    const opened = await until(async () => ((await shown('scoreboard')) ? true : null))
    check('tapping the score chip opens the scoreboard', !!opened)
    check(
      'and it has the players in it, not an empty box',
      (await page.evaluate(() => document.querySelectorAll('#scoreboard .score-row').length)) > 0,
    )
    // The other direction. A toggle that only ever opens passes "does it open".
    await page.touchscreen.tap(...scoreChip)
    const closedAgain = await until(async () => ((await shown('scoreboard')) ? null : true))
    check('tapping it again puts it away', !!closedAgain)

    // One sheet at a time: a phone in landscape has room for exactly one, and
    // two open panels is the covered-board bug again by a different route.
    await page.touchscreen.tap(...scoreChip)
    await until(async () => ((await shown('scoreboard')) ? true : null))
    await page.touchscreen.tap(...(await chipAt('chip-status')))
    const swapped = await until(async () =>
      (await shown('status')) && !(await shown('scoreboard')) ? true : null)
    check('opening the relay panel closes the scoreboard', !!swapped)

    // The sheet takes pointer events, so a panel left open is not merely in the
    // way of the board — it eats the driving thumb for the rest of the round.
    await page.touchscreen.tap(430, 320)
    const dismissed = await until(async () => ((await shown('status')) ? null : true))
    check('and touching the board puts the sheet away', !!dismissed)

    // --- the resting pads --------------------------------------------------
    //
    // With no thumb down, both halves show where a thumb should go: a D-pad
    // ghost on the left, a turret ring on the right. Checked on *computed*
    // style and geometry, not on the elements existing — a div with no CSS
    // behind it renders as invisible nothing and passes every existence check,
    // which is exactly how the tooltip bug shipped.
    const ghosts = await page.evaluate(() => {
      const read = (sel) => {
        const el = document.querySelector(sel)
        if (!el || el.hidden) return null
        const cs = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        return {
          dashed: cs.borderStyle.includes('dashed'),
          w: Math.round(r.width),
          cx: r.x + r.width / 2,
          cy: r.y + r.height / 2,
        }
      }
      const bar = getComputedStyle(document.querySelector('.dpad'), '::before')
      return {
        drive: read('.tghost.drive'),
        aim: read('.tghost.aim'),
        arrows: document.querySelectorAll('.tghost.drive .da').length,
        crossBar: parseFloat(bar.height) > 0 && bar.content !== 'none',
        vw: window.innerWidth,
        vh: window.innerHeight,
      }
    })
    check('the resting D-pad is drawn, dashed, and thumb-sized on the left',
      !!ghosts.drive && ghosts.drive.dashed && ghosts.drive.w === 140 &&
        ghosts.drive.cx < ghosts.vw / 2 && ghosts.drive.cy > ghosts.vh / 2,
      JSON.stringify(ghosts.drive))
    check('and the turret ring mirrors it on the right',
      !!ghosts.aim && ghosts.aim.dashed && ghosts.aim.cx > ghosts.vw / 2 &&
        ghosts.aim.cy > ghosts.vh / 2,
      JSON.stringify(ghosts.aim))
    check('and the D-pad cross is really painted, arrows and bars both',
      ghosts.arrows === 4 && ghosts.crossBar === true,
      JSON.stringify({ arrows: ghosts.arrows, crossBar: ghosts.crossBar }))

    // --- driving -----------------------------------------------------------
    //
    // The tank's own coordinates, before and after a thumb drag. Screen-right is
    // world +x and screen-down is world +y for this camera, so a thumb pushed
    // right and down is a tank that ends up right and down of where it started.
    const before = await page.evaluate(() => ({ x: window.__game.tank.x, y: window.__game.tank.y }))
    await page.touchscreen.touchStart(120, 250)
    // +60 across and +50 down: the `want` angle the hull check below uses.
    await page.touchscreen.touchMove(180, 300)
    const stickDrawn = await page.evaluate(() => document.querySelectorAll('#touch .tstick').length)
    check('a thumb on the left half raises a stick under it', stickDrawn === 1, `${stickDrawn} sticks`)
    // The ghost yields to the live stick — two pictures of the same control at
    // once reads as two controls — while the untouched half keeps its invite.
    const yielded = await page.evaluate(() => ({
      drive: document.querySelector('.tghost.drive').hidden,
      aim: document.querySelector('.tghost.aim').hidden,
    }))
    check('and the D-pad ghost yields to it while the turret ring stays',
      yielded.drive === true && yielded.aim === false, JSON.stringify(yielded))
    // Polled rather than waited on: under swiftshader this loop runs at a
    // fraction of real time and any fixed sleep is a guess about the machine.
    const moved = await until(async () => {
      const now = await page.evaluate(() => ({ x: window.__game.tank.x, y: window.__game.tank.y }))
      return Math.hypot(now.x - before.x, now.y - before.y) > 12 ? now : null
    })
    check('and dragging it drives the tank', moved !== null,
      moved ? `moved ${Math.round(Math.hypot(moved.x - before.x, moved.y - before.y))} units` : 'never moved')
    // Direction, not just motion — a tank drifting for some other reason would
    // pass "did it move" and fail the only question that matters.
    //
    // Asserted on the *hull angle*, not on the displacement, and that is not a
    // weakening. Where the tank ends up depends on the walls between it and
    // there: the map is pinned but the spawn is not, and a tank spawned in the
    // bottom-right corner cannot travel down-right however hard the thumb is
    // pushed. This failed exactly that way once. Which way the hull turns is
    // the input's answer and nothing else's.
    const want = Math.atan2(50, 60) // the drag below, in screen space
    const turned = await until(async () => {
      const hull = await page.evaluate(() => window.__game.tank.hull)
      let d = hull - want
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      return Math.abs(d) < 0.4 ? hull : null
    })
    check(
      '...and the hull turns toward the thumb rather than merely drifting',
      turned !== null,
      turned === null ? 'never came round' : `hull ${turned.toFixed(2)} against ${want.toFixed(2)}`,
    )
    await page.touchscreen.touchEnd()
    const cleared = await page.evaluate(() => document.querySelectorAll('#touch .tstick').length)
    check('lifting the thumb takes the stick away', cleared === 0, `${cleared} left on screen`)
    const ghostBack = await page.evaluate(() => document.querySelector('.tghost.drive').hidden)
    check('and the D-pad ghost comes back', ghostBack === false, `hidden=${ghostBack}`)

    // --- aiming and firing -------------------------------------------------
    //
    // One thumb on the right half both points the gun and pulls the trigger.
    const gunBefore = await page.evaluate(() => window.__game.tank.gun)
    const shellsBefore = await page.evaluate(() => window.__game.shells.size + window.__game.feed.length)
    await page.touchscreen.touchStart(700, 150)
    await page.touchscreen.touchMove(760, 130)
    const aimed = await until(async () => {
      const g = await page.evaluate(() => window.__game.tank.gun)
      return Math.abs(g - gunBefore) > 0.05 ? g : null
    })
    check('holding the right thumb swings the gun', aimed !== null,
      aimed === null ? 'gun never moved' : `${gunBefore.toFixed(2)} -> ${aimed.toFixed(2)}`)
    // Assert on the shell, not on a `fire` flag: a flag that is set and never
    // reaches the simulation is exactly the bug this is here to catch.
    const fired = await until(async () =>
      (await page.evaluate(() => window.__game.shells.size + window.__game.feed.length)) > shellsBefore)
    check('and holding it fires without a third thumb', !!fired)
    await page.touchscreen.touchEnd()

    // The other direction, so "it fires" cannot pass by always firing.
    await wait(600)
    const idle = await page.evaluate(() => window.__players[0].input.read(window.__game.tank).fire)
    check('lifting it stops firing', idle === false, `fire reads ${idle} with nothing on the glass`)

    // --- the rotate screen -------------------------------------------------
    check(
      'no rotate screen while the phone is already sideways',
      await page.evaluate(() => document.getElementById('rotate').hidden),
    )
    await page.setViewport({ ...IPHONE.viewport, width: 393, height: 852, isLandscape: false })
    const rotated = await until(async () =>
      page.evaluate(() => {
        const n = document.getElementById('rotate')
        // The attribute is not the question. `[hidden]` loses to any author rule
        // that sets `display`, and this element is a grid — so what matters is
        // what the browser computed, not what the attribute says.
        return !n.hidden && getComputedStyle(n).display !== 'none'
      }))
    check('turning the phone upright asks for it back', !!rotated)
    await page.setViewport(IPHONE.viewport)
    const backAgain = await until(async () =>
      page.evaluate(() => getComputedStyle(document.getElementById('rotate')).display === 'none'))
    check('and turning it sideways again puts it away', !!backAgain)
    await page.close()
  }

  // -------------------------------------------------------------- the desk

  // None of the above may reach a mouse-and-keyboard session. A desktop that
  // starts showing thumb hints is a regression nobody on a phone would notice.
  const desk = await browser.newPage()
  await desk.setViewport({ width: 900, height: 1000 })
  await desk.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  const deskState = await desk.evaluate(() => ({
    layer: getComputedStyle(document.getElementById('touch')).display,
    rotate: getComputedStyle(document.getElementById('rotate')).display,
    players: document.getElementById('row-players').hidden,
  }))
  // 900x1000 is portrait by the same test the phone uses, which is exactly why
  // the rotate screen cannot key on shape alone.
  check('a tall desktop window is never told to turn a phone it does not have',
    deskState.rotate === 'none', deskState.rotate)
  check('the touch layer is not drawn on a desk', deskState.layer === 'none', deskState.layer)
  check('and two-player couch mode is still offered', !deskState.players)
  // The compact HUD is a phone layout, not a new layout. A desk window this
  // size keeps the panels it always had and never sees a chip.
  const deskHud = await desk.evaluate(() => {
    const d = (i) => getComputedStyle(document.getElementById(i)).display
    return { chips: d('hud-chips'), score: d('scoreboard'), status: d('status') }
  })
  check('a desk keeps its scoreboard and status panel', deskHud.score !== 'none' && deskHud.status !== 'none',
    JSON.stringify(deskHud))
  check('and never sees the phone chips', deskHud.chips === 'none', deskHud.chips)
  await desk.close()
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
console.log('All mobile checks passed.')
