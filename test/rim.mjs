// The Drop: the first edgeless board, and the fall off its rim.
//
// Two halves, because the rules live in two places. The arithmetic half proves
// the geometry and the sim: no fence, rails on the vaults, a hull that keeps
// driving past the line where every other board clamps it, a shell that dies
// past the rim instead of flying its whole four seconds into nothing. The
// browser half proves the *ruling* — the thing the kill-cam and strafing-run
// family taught us arithmetic cannot see: that a tank over the line actually
// dies in the real game, that the death rides the wire with `f: 1` and the
// right killer, that the feed and the card say "fell" rather than
// "self-destructed", that the tumble the renderer draws actually MOVES (a
// static rig is a parked tank in the sky), and that a walled board still
// clamps — the control that says the fall is the board's rule and not a new
// way for every board to kill people.
//
//   npm run build && npx vite preview --port 4381 --strictPort &
//   node test/rim.mjs

import { build } from 'esbuild'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

// ------------------------------------------------------------ the arithmetic

const out = '.scratch/rim-bundle.mjs'
mkdirSync('.scratch', { recursive: true })
await build({
  entryPoints: ['test/rim-entry.ts'],
  bundle: true,
  format: 'esm',
  outfile: out,
  logLevel: 'silent',
  external: ['three', 'nostr-tools'],
})
const sim = await import('../' + out)
rmSync(out)

const {
  LAYOUTS, WALLS, setLayout, arenaEdgelessNow,
  TANK_RADIUS, RIM_SHELL_MARGIN, SHELL_LIFETIME,
  stepTank, stepShell, spawnShell,
} = { ...sim, arenaEdgelessNow: () => sim.arenaEdgeless }

const drop = LAYOUTS.findIndex((l) => l.name === 'The Drop')
check('The Drop is in the rotation', drop >= 0, `${LAYOUTS.length} boards`)
// Not pinned to a count: boards keep landing, and a rotation that shrank is
// the only thing this canary exists to catch. The rubble sweep learned the
// same lesson about a hardcoded eight.
check('the rotation did not shrink', LAYOUTS.length >= 15, `${LAYOUTS.length}`)
check('it is the only edgeless board', LAYOUTS.filter((l) => l.edgeless).length === 1)

setLayout(drop)
check('the live binding follows the board', arenaEdgelessNow() === true)

// The fence is gone, except the two vault rails. Every walled board carries
// four ring pieces; an edgeless one carries exactly the rails that keep the
// caches sealed, and nothing else.
const fences = WALLS.filter((w) => w.kind === 'fence')
check('no ring — only the two vault rails', fences.length === 2,
  `${fences.length} fence rects`)
check('the rails hug the rims', fences.every((w) => w.y === 0 || w.y + w.h === LAYOUTS[drop].h),
  JSON.stringify(fences.map((w) => [w.x, w.y, w.w, w.h])))

// A hull driven at the rim keeps going. The same drive on Crossroads stops at
// the clamp — the control that says the sim reads the board, not a new
// freedom every tank everywhere just gained.
const drive = () => {
  const t = { x: 60, y: 620, hull: Math.PI, gun: 0, hp: 3, dead: false,
    respawnAt: 0, reloadAt: 0, ammo: 4, reloadingFrom: 0, reloadingUntil: 0 }
  for (let i = 0; i < 120; i++) stepTank(t, 1, 0, null, 1 / 60)
  return t.x
}
const offTheEdge = drive()
check('a hull drives past the rim of The Drop', offTheEdge < 0, `x ended at ${Math.round(offTheEdge)}`)
setLayout(0)
check('the binding follows it back', arenaEdgelessNow() === false)
const clamped = drive()
check('the same drive on Crossroads stops at the wall', clamped >= TANK_RADIUS,
  `x ended at ${Math.round(clamped)}`)

// A flat shell fired into the void dies at the margin instead of flying its
// whole four seconds. On Crossroads the same shot meets the fence and comes
// back — same trajectory, different board, different fate.
setLayout(drop)
const fireWest = () => {
  const s = spawnShell('rim-test', 'nobody', 100, 620, Math.PI)
  let flew = 0
  while (!s.dead && flew < SHELL_LIFETIME + 1) { stepShell(s, 1 / 60); flew += 1 / 60 }
  return { x: s.x, age: s.age }
}
const gone = fireWest()
check('a shell off the rim dies at the margin', gone.age < 1 && gone.x <= -RIM_SHELL_MARGIN + 12,
  `died at x=${Math.round(gone.x)} after ${gone.age.toFixed(2)}s`)
setLayout(0)
const bounced = fireWest()
check('the same shot on Crossroads never leaves the board', bounced.x > 0,
  `x=${Math.round(bounced.x)}`)

// ------------------------------------------------------------- the real game

const URL_ = process.env.TANK_URL ?? 'http://localhost:4381/'
const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!executablePath) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2) }

const PEER = 'f'.repeat(63) + '1'

const browser = await puppeteer.launch({
  executablePath, headless: 'new',
  args: ['--no-sandbox', '--window-size=1280,800', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--mute-audio',
    '--disable-background-timer-throttling'],
})
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(e.message))
  await page.goto(`${URL_}?room=rim${Math.floor(Math.random() * 1e6)}`)
  await page.type('#name', 'rim')
  await page.click('#play-guest')
  await page.waitForFunction(() => !!window.__game && !!window.__arena, { timeout: 20_000 })

  // Pin The Drop with the clock, not a bare setLayout — the moonlob lesson: a
  // live chain tip calls setLayout straight back, and a block accepted above
  // the real tip is the only thing every later real tip is lower than.
  await page.evaluate(() => {
    const a = window.__arena
    const i = a.LAYOUTS.findIndex((l) => l.name === 'The Drop')
    const suffix = '03' + i.toString(16).padStart(2, '0')
    window.__clock.accept({ height: 999_000, hash: 'ab'.repeat(30) + suffix,
      time: Math.floor(Date.now() / 1000) - 30 })
    window.__clock.accept = () => {}
    const g = window.__game
    g.beginRound = () => {}
    g.botsWanted = 0
    g.bots = []
    const p = document.getElementById('podium')
    if (p) p.hidden = true
  })
  await page.waitForFunction(() => window.__arena.layoutName === 'The Drop',
    { timeout: 25_000, polling: 100 })
  check('the real game is on The Drop', true)

  // Instrument before anything falls: every publish and every sound, so the
  // wire and the audio are read off what the game actually did.
  await page.evaluate(() => {
    const g = window.__game
    window.__sent = []
    const orig = g.publishAsSession.bind(g)
    g.publishAsSession = (kind, payload) => { window.__sent.push({ kind, payload }); return orig(kind, payload) }
    window.__sounds = []
    const osound = g.sound.bind(g)
    g.sound = (name, opts) => { window.__sounds.push(name); return osound(name, opts) }
  })

  const fallNow = () =>
    page.evaluate(() => {
      const g = window.__game
      g.tank.dead = false
      g.tank.hp = 3
      // Past the west line. `stepTank` no longer clamps here, so the next
      // update's rim check is what rules — the same code a real drive hits.
      g.tank.x = -1
      g.tank.y = 620
    })
  const deadState = () =>
    page.waitForFunction(() => window.__game.tank.dead, { timeout: 5_000, polling: 50 })
      .then(() => page.evaluate(() => {
        const g = window.__game
        return {
          // Not `?? 'missing'`: a fall nobody caused has killer NULL, and the
          // coalesce would eat exactly the value under test.
          killer: g.lastDeath ? g.lastDeath.killer : 'no-death-card',
          fell: g.lastDeath?.fell ?? false,
          falls: g.falls.length,
          feed: g.feed.map((f) => f.text),
          deaths: window.__sent.filter((s) => s.payload && 'k' in s.payload).map((s) => s.payload),
          sounds: window.__sounds.slice(),
        }
      }))
      .catch(() => null)

  // ------------------------------------------------- 1. the unforced fall
  await fallNow()
  const un = await deadState()
  check('driving off the rim kills you', !!un)
  if (un) {
    check('nobody gets the credit for an unforced fall', un.killer === null, String(un.killer))
    check('the card knows it was a fall', un.fell === true)
    check('the death rides the wire with f:1',
      un.deaths.length > 0 && un.deaths[un.deaths.length - 1].f === 1 && un.deaths[un.deaths.length - 1].k === null,
      JSON.stringify(un.deaths[un.deaths.length - 1] ?? null))
    check('the feed says fell, not self-destructed',
      un.feed.some((t) => t === 'you drove off the board') && !un.feed.some((t) => t === 'you self-destructed'),
      JSON.stringify(un.feed))
    check('a tumble is booked for the renderer', un.falls >= 1, `${un.falls}`)
    check('the scream plays and the blast does not',
      un.sounds.includes('fall') && !un.sounds.includes('death'), JSON.stringify(un.sounds))
  }

  // The tumble MOVES. A rig that is visible but parked is the strafing-run
  // lesson wearing a fourth costume: sampled once, "there is a tank" and "the
  // tank is falling" are the same photograph. And the sampling itself carries
  // the kill-cam lesson: the rig only moves when a frame renders, and under a
  // software rasteriser a fixed sleep can span less than one frame — so the
  // second sample is POLLED for, not slept for, off a fresh fall so there is
  // a whole tumble ahead of it.
  // Let the first fall's tumble finish so the probe below can only ever be
  // watching the fresh one.
  await page.waitForFunction(() => !window.__renderer.fallRigs.some((x) => x.root.visible),
    { timeout: 3_000, polling: 60 })
  const t1 = await page.evaluate(() => {
    const g = window.__game
    g.tank.dead = false
    g.tank.hp = 3
    g.tank.x = 620
    g.tank.y = -1
    return new Promise((resolve) => {
      const probe = () => {
        const r = window.__renderer.fallRigs.find((x) => x.root.visible)
        if (r) return resolve({ y: r.root.position.y, x: r.root.position.x, z: r.root.position.z })
        requestAnimationFrame(probe)
      }
      probe()
    })
  })
  const t2 = await page.waitForFunction((t1) => {
    const r = window.__renderer.fallRigs.find((x) => x.root.visible)
    if (!r) return null
    const at = { y: r.root.position.y, x: r.root.position.x, z: r.root.position.z }
    return at.y < t1.y - 5 && at.z < t1.z - 3 ? at : null
  }, { timeout: 2_000, polling: 60 }, t1).then((h) => h.jsonValue()).catch(() => null)
  check('the renderer is tumbling a tank', !!t1, JSON.stringify(t1))
  check('and the tumble moves — down and out', !!t2, JSON.stringify({ t1, t2 }))
  mkdirSync('.scratch/shots', { recursive: true })
  await page.screenshot({ path: '.scratch/shots/rim-tumble.png' })
  await page.waitForFunction(() => !window.__game.tank.dead, { timeout: 8_000, polling: 100 })

  // -------------------------------------------- 2. the credited fall
  await page.waitForFunction(() => !window.__game.tank.dead, { timeout: 8_000, polling: 100 })
  await page.evaluate((PEER) => {
    const g = window.__game
    const peer = g.ensurePeer(PEER)
    peer.name = 'Hardhat'
    // The last hit, seconds ago but inside the window — the panicked reverse.
    g.hitBy(PEER)
  }, PEER)
  await fallNow()
  const cred = await deadState()
  check('a fall under fire is their kill', !!cred && cred.killer === PEER,
    String(cred?.killer).slice(0, 12))
  check('and still tells as a fall on the wire',
    !!cred && cred.deaths[cred.deaths.length - 1]?.f === 1 && cred.deaths[cred.deaths.length - 1]?.k === PEER,
    JSON.stringify(cred?.deaths[cred?.deaths.length - 1] ?? null))
  check('the feed credits them', !!cred && cred.feed.some((t) => t === 'Hardhat killed you'),
    JSON.stringify(cred?.feed))

  // -------------------------------------------- 3. the credit window closes
  await page.waitForFunction(() => !window.__game.tank.dead, { timeout: 8_000, polling: 100 })
  await page.evaluate((PEER) => {
    const g = window.__game
    g.hitBy(PEER, performance.now() - 5000)
  }, PEER)
  await fallNow()
  const stale = await deadState()
  check('a hit from an old fight does not claim the fall', !!stale && stale.killer === null,
    String(stale?.killer).slice(0, 12))

  // -------------------------------------------- 4. somebody else falls
  const remote = await page.evaluate((PEER) => {
    const g = window.__game
    const before = g.falls.length
    g.onDeath({
      pubkey: PEER,
      content: JSON.stringify({ t: performance.now(), k: null, x: 1701, y: 300, f: 1 }),
    })
    return { grew: g.falls.length > before, feed: g.feed.map((f) => f.text) }
  }, PEER)
  check('a peer fall books a tumble too', remote.grew)
  check('and the feed says they fell', remote.feed.some((t) => t.endsWith('drove off the board')),
    JSON.stringify(remote.feed))

  // -------------------------------------------- 5. the control: a walled board
  await page.evaluate(() => {
    const a = window.__arena
    a.setLayout(0)
    const g = window.__game
    g.tank.dead = false
    g.tank.hp = 3
    g.tank.x = -1
    g.tank.y = 620
  })
  await new Promise((r) => setTimeout(r, 700))
  const walled = await page.evaluate(() => ({
    dead: window.__game.tank.dead, x: window.__game.tank.x,
  }))
  check('the same position on Crossroads is a clamp, not a death',
    !walled.dead && walled.x >= TANK_RADIUS, JSON.stringify(walled))

  check('no page errors', pageErrors.length === 0, pageErrors.join('; '))
} finally {
  await browser.close()
}

console.log(failures ? `\n${failures} failed` : '\nall good')
process.exit(failures ? 1 : 0)
