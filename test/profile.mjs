// Where the frame goes.
//
// Puzz reported "game is getting laggy", then said it might be his machine
// running hot; cloudfodder did not see it. So this is not a hunt for a
// regression, it is a measurement — and the first thing it has to be honest
// about is what it can and cannot measure.
//
// **It runs on swiftshader**, a software rasteriser, because that is what a
// headless Chrome has. So:
//
//   - **Draw calls, triangles and resident geometry are real.** They are the
//     same numbers a real GPU gets handed, and they are the thing that decides
//     whether a phone can keep up.
//   - **JavaScript time is real and comparable.** `game.update` does not touch
//     the GPU; a millisecond there is a millisecond anywhere.
//   - **Milliseconds inside `renderer.draw` are not a frame budget.** Under a
//     software rasteriser they are perhaps an order of magnitude out. What they
//     are good for is *ratios* — this scene against that one, on the same box,
//     in the same minute.
//
// Every number is therefore reported as a comparison against a control scene
// rather than as an absolute, and the summary says which is which. A profile
// that hands somebody "62fps" measured on swiftshader is worse than no profile.
//
//   npm run build && npx vite preview --port 4320 &
//   npm run profile

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4320/'
const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!CHROME) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2) }

/**
 * `TANK_REAL_GPU=1` runs headful on the machine's actual GPU.
 *
 * Worth the extra window: swiftshader can tell you how much geometry there is
 * and cannot tell you how long a frame takes, and "how long does a frame take"
 * is the entire question somebody asks when they say the game feels laggy. The
 * structural numbers agree between the two modes; only the milliseconds move,
 * and the report says which mode produced them.
 */
const REAL_GPU = process.env.TANK_REAL_GPU === '1'
const FLAGS = [
  '--no-sandbox', '--window-size=1280,800', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
  ...(REAL_GPU
    ? []
    : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox']),
]

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const HASH = 'ab'.repeat(30) + '0300'
const PEERS = Array.from({ length: 7 }, (_, i) => (10 + i).toString(16).padStart(2, '0').repeat(32))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: REAL_GPU ? false : 'new',
  args: FLAGS,
})
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })

/**
 * Wrap the two things a frame is made of, and count them.
 *
 * `game.update` and `renderer.draw` are called from `loop` in main.ts, once
 * each per animation frame, so wrapping them measures the real loop rather
 * than a re-implementation of it. `renderer.info` is reset by three on every
 * render, so `stats()` read straight after a draw describes *that* frame.
 */
async function instrument() {
  await page.evaluate(() => {
    const g = window.__game
    const r = window.__renderer
    const m = {
      frames: 0,
      update: [],
      draw: [],
      gaps: [],
      calls: 0,
      triangles: 0,
      last: 0,
    }
    window.__m = m
    const realUpdate = g.update.bind(g)
    g.update = (dt, controls) => {
      const t0 = performance.now()
      realUpdate(dt, controls)
      m.update.push(performance.now() - t0)
    }
    const realDraw = r.draw.bind(r)
    r.draw = (game, local) => {
      const t0 = performance.now()
      realDraw(game, local)
      const t1 = performance.now()
      m.draw.push(t1 - t0)
      if (m.last) m.gaps.push(t1 - m.last)
      m.last = t1
      const s = r.stats()
      m.calls = s.calls
      m.triangles = s.triangles
      m.frames++
    }
  })
}

const median = (a) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}
const pct = (a, p) => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor((s.length * p) / 100))]
}

/** Watch for a while, then hand back what the frames cost. */
async function sample(ms = 4000) {
  await page.evaluate(() => {
    const m = window.__m
    m.update.length = 0
    m.draw.length = 0
    m.gaps.length = 0
    m.frames = 0
    m.last = 0
  })
  await wait(ms)
  return page.evaluate(() => {
    const m = window.__m
    const s = window.__renderer.stats()
    return {
      frames: m.frames,
      update: m.update.slice(),
      draw: m.draw.slice(),
      gaps: m.gaps.slice(),
      calls: m.calls,
      triangles: m.triangles,
      geometries: s.geometries,
      textures: s.textures,
      programs: s.programs,
    }
  })
}

function summarise(name, s, seconds) {
  return {
    scene: name,
    fps: +(s.frames / seconds).toFixed(1),
    'update ms (median)': +median(s.update).toFixed(2),
    'update ms (p95)': +pct(s.update, 95).toFixed(2),
    'draw ms (median)': +median(s.draw).toFixed(2),
    'draw ms (p95)': +pct(s.draw, 95).toFixed(2),
    'draw calls': s.calls,
    triangles: s.triangles,
    geometries: s.geometries,
    textures: s.textures,
  }
}

const rows = []

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'perf')
  await page.type('#room', 'perf' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  await page.waitForFunction(() => !!window.__game && !!window.__renderer, { timeout: 25_000 })

  await page.evaluate((hash) => {
    window.__clock.accept({ height: 900000, hash, time: Math.floor(Date.now() / 1000) - 30 })
    window.__clock.accept = () => {}
    const g = window.__game
    g.beginRound(900000, hash)
    window.__arena.setLayout(window.__arena.layoutForBlock(hash))
    document.getElementById('podium').hidden = true
  }, HASH)
  await wait(1200)
  await instrument()

  // ---------------------------------------------------------- 1. the control
  //
  // An empty board with nobody on it. Everything below is read against this,
  // because a number with nothing to compare it to is a number, not a finding.

  await page.evaluate(() => {
    const g = window.__game
    g.botsWanted = 0
    g.bots = []
    g.peers.clear()
  })
  await wait(800)
  rows.push(summarise('empty board, no opponents', await sample(), 4))

  // ------------------------------------------------------------- 2. the bots

  await page.evaluate(() => {
    window.__game.botsWanted = 7
  })
  await page.waitForFunction(() => window.__game.botCount === 7, { timeout: 15_000 })
  await wait(600)
  rows.push(summarise('seven bots, full room', await sample(), 4))

  // ------------------------------------- 3. what a full eight-seat match costs
  //
  // Seven bots is what a solo player sees. Seven *remote* players is a
  // different load — every one of them is an interpolation buffer and a set of
  // meshes fed by a 10Hz tick — so this drives seven peers through the real
  // event path at the real rate.

  await page.evaluate((peers) => {
    const g = window.__game
    g.botsWanted = 0
    g.bots = []
    window.__peerTimer = setInterval(() => {
      const now = Date.now()
      peers.forEach((pk, i) => {
        const t = now / 1000 + i
        g.onEvent({
          id: 'p' + Math.random().toString(16).slice(2),
          pubkey: pk,
          kind: 21000,
          created_at: Math.floor(now / 1000),
          tags: [],
          sig: '0'.repeat(128),
          content: JSON.stringify({
            t: now,
            x: 900 + Math.cos(t) * 380,
            y: 500 + Math.sin(t * 0.8) * 260,
            h: t % 6.28,
            g: (t * 1.3) % 6.28,
            hp: 3,
            a: 4,
            r: g.round,
          }),
        }, false)
      })
    }, 100)
  }, PEERS)
  await wait(1500)
  rows.push(summarise('seven remote players at 10Hz', await sample(), 4))

  // -------------------------------------------- 4. with the board torn up too
  //
  // Damage tiers, rubble and smoke are all extra geometry and extra material
  // state. If cover is what costs, this is where it shows.

  await page.evaluate(() => {
    const a = window.__arena
    // Every piece taken to its last tier, then half of them broken outright, so
    // the scene carries both damaged cover and rubble at once.
    a.BREAKABLE.forEach((b, i) => a.damageCover(b.id, i % 2 === 0 ? 99 : 2))
    const g = window.__game
    g.tank.hp = 1 // smoke and fire on our own hull
  })
  await wait(900)
  rows.push(summarise('same, cover damaged and half of it rubble', await sample(), 4))

  // ----------------------------------------------- 5. everything at once
  //
  // A streak reward on top: the chopper is a second vehicle, a beam and a
  // particle system, and it is the most expensive thing this game can be doing.

  await page.evaluate(() => {
    const g = window.__game
    g.streak = 9
    g.tank.dead = false
    g.onEvent({
      id: 'k' + Math.random().toString(16).slice(2),
      pubkey: 'd1'.repeat(32),
      kind: 21002,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), k: g.identity.sessionPubkey, x: 400, y: 400 }),
    }, false)
  })
  await wait(600)
  const flying = await page.evaluate(() => window.__game.flying)
  rows.push(
    summarise(`everything, ${flying ? 'chopper up' : 'chopper failed to board'}`, await sample(3000), 3),
  )

  await page.evaluate(() => clearInterval(window.__peerTimer))

  // ----------------------------------------------------------------- a phone

  const phone = await browser.newPage()
  await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await phone.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await phone.type('#name', 'phone')
  await phone.type('#room', 'phn' + Math.floor(Math.random() * 1e6))
  await phone.click('#play-guest')
  await phone.waitForFunction(() => !!window.__game && !!window.__renderer, { timeout: 25_000 })
  await phone.evaluate((hash) => {
    window.__clock.accept({ height: 900000, hash, time: Math.floor(Date.now() / 1000) - 30 })
    window.__clock.accept = () => {}
    window.__game.beginRound(900000, hash)
    window.__arena.setLayout(window.__arena.layoutForBlock(hash))
    window.__game.botsWanted = 7
    document.getElementById('podium').hidden = true
  }, HASH)
  await phone.waitForFunction(() => window.__game.botCount === 7, { timeout: 15_000 }).catch(() => {})
  await wait(1500)
  const phoneStats = await phone.evaluate(() => {
    const s = window.__renderer.stats()
    return { calls: s.calls, triangles: s.triangles, geometries: s.geometries, textures: s.textures }
  })
  await phone.close()

  // ------------------------------------------------- where the triangles are
  //
  // "200,000 triangles" is a number. "The turf is 130,000 of them" is a
  // finding, and the difference is a walk of the scene graph. Grouped by what
  // a person would call the thing rather than by material, because the useful
  // question is "which piece of scenery is this" and not "which shader".

  const geometry = await page.evaluate(() => {
    const r = window.__renderer
    const scene = r.scene ?? null
    if (!scene) return null
    const tris = (o) => {
      const g = o.geometry
      if (!g) return 0
      const n = g.index ? g.index.count : (g.attributes.position?.count ?? 0)
      return Math.floor(n / 3)
    }
    // By individual mesh, not by name: almost nothing in this scene graph has a
    // name, so grouping by one put 99.6% of the geometry in a bucket called
    // "Mesh" — a breakdown that breaks nothing down. What a person actually
    // wants is "which object is the expensive one", and that is a list.
    const meshes = []
    let total = 0
    let shadowCasters = 0
    scene.traverse((o) => {
      if (!o.isMesh && !o.isSprite && !o.isPoints && !o.isLine) return
      const t = tris(o)
      if (!t) return
      total += t
      if (o.castShadow) shadowCasters += t
      const p = o.getWorldPosition(new o.position.constructor())
      meshes.push({
        what: `${o.geometry?.type ?? o.type} / ${o.material?.type ?? '?'}`,
        triangles: t,
        visible: o.visible,
        shadow: !!o.castShadow,
        at: `${Math.round(p.x)},${Math.round(p.y)},${Math.round(p.z)}`,
      })
    })
    meshes.sort((a, b) => b.triangles - a.triangles)
    return { total, shadowCasters, meshes: meshes.slice(0, 12), count: meshes.length }
  })

  // ------------------------------------------------------------------ report

  console.log('\nWhere the frame goes — nostr-tank-arena')
  if (REAL_GPU) {
    console.log('Headful Chrome on this machine\'s real GPU. Every number here is real,')
    console.log('including the milliseconds — but they describe *this* box, and a phone')
    console.log('is a different box.\n')
  } else {
    console.log('Chrome headless on swiftshader. Draw calls, triangles and geometry')
    console.log('counts are real. Milliseconds are comparable between rows and are NOT')
    console.log('a frame budget on real hardware — rerun with TANK_REAL_GPU=1 for those.\n')
  }
  console.table(rows)
  console.log('\nA phone-sized viewport, seven bots:', JSON.stringify(phoneStats))
  if (geometry) {
    console.log(
      `\nThe scene holds ${geometry.total.toLocaleString()} triangles across ` +
        `${geometry.count} drawable objects, of which ` +
        `${geometry.shadowCasters.toLocaleString()} cast a shadow — and a shadow caster is ` +
        `drawn twice, once into the shadow map and once for real. That is why the renderer ` +
        `reports more triangles per frame than the scene contains.`,
    )
    console.log('\nThe twelve most expensive objects in it:')
    console.table(
      geometry.meshes.map((m) => ({
        ...m,
        'share %': +((m.triangles / geometry.total) * 100).toFixed(1),
      })),
    )
  }
  const base = rows[0]
  const worst = rows[rows.length - 1]
  console.log(
    `\nWorst scene against the empty control: ` +
      `${(worst['draw calls'] / Math.max(1, base['draw calls'])).toFixed(2)}x the draw calls, ` +
      `${(worst.triangles / Math.max(1, base.triangles)).toFixed(2)}x the triangles, ` +
      `${(worst['update ms (median)'] / Math.max(0.01, base['update ms (median)'])).toFixed(2)}x the JS in update.`,
  )
} catch (err) {
  console.error('profile failed:', err.message)
  process.exitCode = 1
} finally {
  await browser.close()
}
