// Two real browsers, two guest npubs, one room, live public relays.
//
// There is no way to fake this one: it drives the actual built game, waits for
// the two clients to find each other through relays, shoots one tank with the
// other, and asserts that the kill came back through the death event. Run it
// against a preview build:
//
//   npm run build && npm run preview &
//   npm run test:live
//
// Set TANK_URL to point somewhere else, e.g. the deployed site.

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL = process.env.TANK_URL ?? 'http://localhost:4173/'
const ROOM = 'smoke' + Math.floor(Math.random() * 1e6)

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!executablePath) {
  console.error('No Chrome found. Set CHROME_PATH.')
  process.exit(2)
}

const FLAGS = [
  '--no-sandbox',
  '--window-size=1280,800',
  // The board is three.js now, so headless Chrome has to produce a real WebGL
  // context or the game never leaves the lobby. `--use-gl=swiftshader` alone
  // stopped being enough: current Chrome refuses the software rasteriser
  // without --enable-unsafe-swiftshader and reports only
  // "BindToCurrentSequence failed", which looks like a game bug and is not.
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox',
  // Chrome only gives requestAnimationFrame to the frontmost tab. Without
  // these the "other player" silently stops simulating and the test proves
  // nothing at all.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

// Separate browsers, not separate tabs: independent localStorage and renderers.
const browsers = [
  await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS }),
  await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS }),
]

const pageErrors = []

async function join(browser, label, name) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  page.on('pageerror', (e) => pageErrors.push(`[${label}] ${e.message}`))
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'networkidle0' })
  await page.evaluate(() => {
    document.querySelector('#name').value = ''
    document.querySelector('#room').value = ''
  })
  await page.type('#name', name)
  await page.type('#room', ROOM)
  await page.click('#play-guest')
  try {
    await page.waitForSelector('#hud:not([hidden])', { timeout: 15000 })
  } catch {
    const why = await page.evaluate(() => document.getElementById('lobby-error')?.textContent)
    throw new Error(`${label} never got past the lobby: ${why || 'no message'}`)
  }
  return page
}

const snap = (p) =>
  p.evaluate(() => {
    const g = window.__game
    return {
      hp: g.tank.hp,
      dead: g.tank.dead,
      kills: g.kills,
      deaths: g.deaths,
      shells: g.shells.size,
      feed: g.feed.map((f) => f.text),
      peers: [...g.peers.values()].map((pe) => ({
        name: pe.name,
        verified: pe.pubkey !== null,
        x: Math.round(pe.view.x),
        y: Math.round(pe.view.y),
      })),
    }
  })

try {
  console.log(`room ${ROOM} @ ${URL}`)
  const a = await join(browsers[0], 'A', 'alpha')
  const b = await join(browsers[1], 'B', 'bravo')

  // Discovery: each side has to learn the other exists, and verify the session
  // attestation that binds the tick key to a real npub.
  await wait(6000)
  const seenA = await snap(a)
  const seenB = await snap(b)
  check('A sees bravo', seenA.peers.some((p) => p.name === 'bravo'), JSON.stringify(seenA.peers))
  check('B sees alpha', seenB.peers.some((p) => p.name === 'alpha'), JSON.stringify(seenB.peers))
  check('sessions verified', seenA.peers.every((p) => p.verified) && seenB.peers.every((p) => p.verified))
  check('no ghost peers', seenA.peers.length === 1 && seenB.peers.length === 1)

  // Movement propagates.
  const beforeMove = (await snap(b)).peers[0]
  // Long enough to clear the threshold even when the renderer is in software
  // and the simulation is therefore running at a fraction of wall-clock speed.
  await a.keyboard.down('KeyW')
  await wait(3200)
  await a.keyboard.up('KeyW')
  await wait(1800)
  const afterMove = (await snap(b)).peers[0]
  const moved = beforeMove && afterMove ? Math.hypot(afterMove.x - beforeMove.x, afterMove.y - beforeMove.y) : 0
  check('B sees A move', moved > 60, `${Math.round(moved)}px`)

  // Regen off for the duel. With it on, the victim heals between shells under
  // software rasterisation and no kill ever lands — which is a real interaction
  // between two features, not a flaky test, so it is turned off explicitly here
  // and asserted on its own below.
  await b.evaluate(() => (window.__game.regenAfter = 9999))

  // Duel: park them in a clear lane and put three shells into bravo.
  for (let i = 0; i < 5; i++) {
    await a.evaluate(() => {
      const g = window.__game
      g.tank.x = 300
      g.tank.y = 600
      g.tank.hull = 0
      g.tank.gun = 0
      g.tank.reloadAt = 0
    })
    await b.evaluate(() => {
      const g = window.__game
      if (!g.tank.dead) {
        g.tank.x = 520
        g.tank.y = 600
      }
    })
    await a.keyboard.down('Space')
    await wait(240)
    await a.keyboard.up('Space')
    await wait(2600)
    if ((await snap(b)).deaths > 0) break
  }
  // RESPAWN_DELAY is 2.5s and the death is detected at the end of a poll, so a
  // 2s wait here was a coin flip on whether bravo was back yet.
  await wait(3800)

  const finalA = await snap(a)
  const finalB = await snap(b)
  check('bravo died', finalB.deaths >= 1, JSON.stringify(finalB.feed))
  check('alpha credited with the kill', finalA.kills >= 1, JSON.stringify(finalA.feed))
  check('kill feed names the killer', finalA.feed.some((t) => t.includes('alpha') && t.includes('bravo')))
  check('bravo respawned at full hp', !finalB.dead && finalB.hp === 3, `hp=${finalB.hp} dead=${finalB.dead}`)
  // Now the other half of that interaction: a hull point comes back after a
  // spell without being hit.
  await b.evaluate(() => {
    const g = window.__game
    g.tank.hp = 1
    g.tank.dead = false
    g.regenAfter = 1
  })
  await wait(3000)
  const healed = await b.evaluate(() => ({ hp: window.__game.tank.hp, feed: window.__game.feed.map((f) => f.text) }))
  check('a tank left alone patches itself up', healed.hp > 1, `hp=${healed.hp}`)
  check('and says so in the feed', healed.feed.some((t) => /patched up/.test(t)), JSON.stringify(healed.feed))

  // A round is one Bitcoin block. Nobody announces the change and nobody is the
  // host: both clients watch the same chain tip and both act on it. Driven here
  // through `BlockClock.accept`, which is the same entry point a real poll uses,
  // because waiting ten minutes for the chain is not a test.
  const beforeBlock = await Promise.all([a, b].map((p) => p.evaluate(() => ({
    kills: window.__game.kills,
    deaths: window.__game.deaths,
    map: document.getElementById('hud-map')?.textContent ?? '',
  }))))
  check('alpha has kills to lose', beforeBlock[0].kills >= 1, JSON.stringify(beforeBlock))

  // A hash ending 00 and one ending 03 pick different boards, so this also
  // proves the map is a pure function of the tip rather than a broadcast.
  const HEIGHT = 999001
  await Promise.all([a, b].map((p) => p.evaluate((h) => {
    window.__clock.accept({ height: h, hash: 'ab'.repeat(31) + '03' })
  }, HEIGHT)))
  await wait(1200)

  const afterBlock = await Promise.all([a, b].map((p) => p.evaluate(() => ({
    kills: window.__game.kills,
    deaths: window.__game.deaths,
    round: window.__game.round,
    podium: !document.getElementById('podium').hidden,
    shown: getComputedStyle(document.getElementById('podium')).display !== 'none',
    map: document.getElementById('hud-map')?.textContent ?? '',
    rows: document.getElementById('podium-rows').textContent.replace(/\s+/g, ' ').trim(),
  }))))
  check('a block ends the round on both clients',
    afterBlock.every((r) => r.round === HEIGHT), JSON.stringify(afterBlock.map((r) => r.round)))
  check('and resets the scores', afterBlock.every((r) => r.kills === 0 && r.deaths === 0),
    JSON.stringify(afterBlock.map((r) => `${r.kills}/${r.deaths}`)))
  check('and both land on the same map, without telling each other',
    afterBlock[0].map === afterBlock[1].map && afterBlock[0].map === 'The Ring',
    afterBlock.map((r) => r.map).join(' vs '))
  check('the podium shows the round that just ended',
    afterBlock.every((r) => r.podium && r.shown), JSON.stringify(afterBlock.map((r) => [r.podium, r.shown])))
  check('and names who was in it', /alpha|bravo/.test(afterBlock[0].rows), afterBlock[0].rows)

  // `hidden` is not enough on its own: an author `display` rule outranks the
  // UA sheet's `[hidden] { display: none }`, and this podium is `display: grid`.
  // It sat permanently over the board until a rule with `!important` was added,
  // so the check has to ask for the computed style, not the attribute.
  await a.click('#podium-close')
  await wait(300)
  const closed = await a.evaluate(() => {
    const n = document.getElementById('podium')
    return { attr: n.hidden, display: getComputedStyle(n).display, h: n.getBoundingClientRect().height }
  })
  check('and closing it actually removes it from the page',
    closed.attr && closed.display === 'none' && closed.h === 0, JSON.stringify(closed))

  // The board renders in WebGL, and the aim is a ray cast through the cursor
  // onto a plane rather than a divide. Both are new, and both fail silently: a
  // dead context still runs the simulation, and a wrong unprojection just aims
  // somewhere plausible.
  //
  // Last in the run, deliberately. Moving the mouse leaves the gun tracking
  // wherever the cursor ended up, and the duel above needs it pointed down the
  // lane — an earlier version of this block quietly turned alpha's turret away
  // and the kill checks failed for a reason that had nothing to do with them.
  const gl = await a.evaluate(() => {
    const c = document.getElementById('stage')
    return { w: c.width, h: c.height, ctx: !!(c.getContext('webgl2') || c.getContext('webgl')) }
  })
  check('the 3D board has a live WebGL context', gl.ctx && gl.w > 0 && gl.h > 0, `${gl.w}x${gl.h}`)

  // Two pixels at the same height: one out at the edge where only sky can be,
  // one in the middle where the board has to be. The sky is a vertical
  // gradient, so an empty scene makes these two identical — the board is the
  // only thing that can make them differ.
  const [sky, mid] = await a.evaluate(() => [
    window.__renderer.probePixels(40, 400),
    window.__renderer.probePixels(640, 400),
  ])
  const apart = Math.abs(sky[0] - mid[0]) + Math.abs(sky[1] - mid[1]) + Math.abs(sky[2] - mid[2])
  check('and the board is actually on the screen', sky[3] > 0 && mid[3] > 0 && apart > 60,
    `sky ${sky.join()} board ${mid.join()} apart ${apart}`)

  // Does the cursor point where it looks like it points?
  //
  // Comparing the gun angle against `toWorld` would prove nothing — that is the
  // function under test, and an unprojection that is wrong in a self-consistent
  // way passes it. (It did: a deliberately broken flat mapping sailed through
  // an earlier version of this check.) So close the loop through the rendered
  // image instead. Send the tank to the spot under a chosen pixel, and look at
  // that pixel: if the unprojection is right, the tank is now there and the
  // pixels changed. If it is wrong, the tank is somewhere else on the board and
  // that patch of grass looks exactly as it did.
  const PIXEL = [380, 400]
  const PATCH = [PIXEL[0] - 22, PIXEL[1] - 34, 44, 44]
  const park = (x, y) => a.evaluate(([px, py]) => {
    const g = window.__game
    g.tank.x = px
    g.tank.y = py
    g.tank.dead = false
    g.tank.hp = 3
  }, [x, y])
  const patch = () => a.evaluate((r) => window.__renderer.probePixels(r[0], r[1], r[2], r[3]), PATCH)
  const spread = (u, v) => u.reduce((acc, n, i) => acc + Math.abs(n - v[i]), 0) / u.length

  await park(1430, 170)
  await wait(500)
  const empty = await patch()
  const aimed = await a.evaluate((p) => window.__renderer.toWorld(p[0], p[1]), PIXEL)
  await park(aimed.x, aimed.y)
  await wait(500)
  const occupied = await patch()
  const landed = await a.evaluate(() => ({ x: window.__game.tank.x, y: window.__game.tank.y }))
  check('a tank sent to where a pixel points appears at that pixel',
    spread(empty, occupied) > 12,
    `arena ${Math.round(aimed.x)},${Math.round(aimed.y)} → landed ${Math.round(landed.x)},${Math.round(landed.y)}, pixels moved ${spread(empty, occupied).toFixed(1)}`)

  // And with the unprojection trusted, the gun follows the cursor to it.
  const angleGap = (x, y) => Math.abs(Math.atan2(Math.sin(x - y), Math.cos(x - y)))
  // Generous waits: under software rasterisation a frame can take 200ms, and
  // `main.ts` clamps the simulation step to 50ms so a backgrounded tab cannot
  // teleport everyone — which means a slow renderer also simulates in slow
  // motion. On a real GPU this settles in a fraction of the time.
  for (const [px, py, where] of [[900, 250, 'up and right'], [300, 620, 'down and left']]) {
    await park(400, 300)
    await a.mouse.move(px, py)
    await wait(2600)
    const r = await a.evaluate(([x, y]) => {
      const g = window.__game
      const w = window.__renderer.toWorld(x, y)
      return { gun: g.tank.gun, want: Math.atan2(w.y - g.tank.y, w.x - g.tank.x) }
    }, [px, py])
    check(`the gun swings to the cursor ${where}`, angleGap(r.gun, r.want) < 0.25,
      `gun ${r.gun.toFixed(2)} want ${r.want.toFixed(2)}`)
  }

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '))

  // Not a pass/fail: on a GPU this stays 'full', and under swiftshader it is
  // expected to drop. Printed so a slow run is legible rather than mysterious.
  console.log('      render quality settled at:', await a.evaluate(() => window.__renderer.renderQuality))

  if (process.env.TANK_SHOTS) {
    await a.screenshot({ path: process.env.TANK_SHOTS + '/alpha.png' })
    await b.screenshot({ path: process.env.TANK_SHOTS + '/bravo.png' })
  }
} finally {
  for (const br of browsers) await br.close()
}

console.log(failures.length ? `\n${failures.length} failed: ${failures.join(', ')}` : '\nall checks passed')
process.exit(failures.length ? 1 : 0)
