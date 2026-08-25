// The half of destructible barrels that arithmetic cannot answer.
//
// test/barrels.mjs proves the rules against the built module. This proves the
// two things that only exist once they are wired into a running game and a
// scene graph:
//
//   1. A destroyed barrel **stops being drawn**. This codebase has shipped
//      meshes that were `visible = true` on every frame for weeks while sitting
//      inside the floor, so "the rect says gone" is not the claim — the mesh is.
//   2. The destroyed set reaches the wire and comes back off it. A peer tick
//      carrying `b` has to take a barrel out here, and our own tick has to
//      carry ours, or two clients play on different boards.
//
//   npm run build && npx vite preview --port 4200 &
//   npm run test:barrels-browser

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4200/'
const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!executablePath) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2) }

const FLAGS = [
  '--no-sandbox', '--window-size=1280,800', '--use-gl=angle', '--use-angle=swiftshader',
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

const PEER = 'd1'.repeat(32)
// A pinned hash, and the last two digits are chosen rather than copied.
//
// `layoutForBlock` is `parseInt(hash.slice(-2), 16) % 8`, so the suffix picks
// the board. The other suites here use `0300` — Supply Run on Crossroads —
// and Crossroads has **no barrels on it**, which is how this suite first ran:
// a green "the board is intact" against a board with nothing to shoot. `02`
// is the same rules on a layout that carries four. Pinned rather than taken
// from the live chain for the usual reason: the map moves every block, and a
// suite that passes on one board and vanishes on the next is not a suite.
const HASH = 'ab'.repeat(30) + '0302'

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'barrel')
  await page.type('#room', 'brl' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game && !!window.__renderer, { timeout: 25_000 })
    .then(() => true).catch(() => false)
  check('a game is running', started)
  if (!started) throw new Error('the game never started')

  // Pin the round *through the clock*, not by calling `beginRound`.
  //
  // The board is not chosen by `Game`: `main.ts` watches the block clock and
  // calls `setLayout(layoutForBlock(hash))`. Calling `beginRound` by hand sets
  // the rules and the round number and leaves the arena on whatever it already
  // had — which is how the first run of this suite reported "no barrels" while
  // pointing at a hash that names a board with four. Then nail both shut, or
  // the first live tip lands mid-suite and rebuilds the board underneath a
  // check that is about to read it.
  await page.evaluate((hash) => {
    window.__clock.accept({ height: 900000, hash, time: Math.floor(Date.now() / 1000) - 30 })
    window.__clock.accept = () => {}
    const g = window.__game
    g.beginRound(900000, hash)
    g.beginRound = () => {}
    g.botsEnabled = false
    document.getElementById('podium').hidden = true
  }, HASH)
  await wait(1200)

  const board = await page.evaluate(() => ({
    barrels: window.__arena.BARRELS.length,
    map: document.getElementById('hud-map')?.textContent,
  }))
  check('the pinned board has barrels on it', board.barrels >= 2, JSON.stringify(board))
  if (!board.barrels) throw new Error('no barrels on the pinned board')

  // ------------------------------------------------- 1. it leaves the screen

  const drawn = () => page.evaluate(() => {
    const a = window.__arena, r = window.__renderer
    return a.BARRELS.map((b) => ({
      id: b.id, hp: b.hp, gone: b.gone,
      // The mesh, not the rect. This is the claim.
      visible: r.coverMeshAt(b.id)?.visible ?? null,
    }))
  })

  const before = await drawn()
  check('every barrel is intact and on screen to start with',
    before.every((b) => b.gone === false && b.visible === true), JSON.stringify(before))

  // Put a shell into one, through the real update loop, from a lane we pick at
  // runtime — where the barrels are depends on the board.
  const shot = await page.evaluate(() => {
    const g = window.__game, a = window.__arena
    // Whichever barrel has a lane, not barrel zero. Where the barrels sit is a
    // property of the board, and the board comes from the block hash.
    for (const b of a.BARRELS) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2
    // Find open ground to fire from, so nothing here is a claim about one
    // board's furniture.
    // Sixteen bearings, not four. The first cut tried the axes only and found
    // nothing on Pillars, where the barrels sit in the rock columns that give
    // the board its name — a lane exists, it just is not north, south, east or
    // west. A test that can only fire along an axis is making a claim about the
    // board rather than about barrels.
    let from = null
    for (let k = 0; k < 16 && !from; k++) {
      const dir = (k / 16) * Math.PI * 2
      for (let d = 110; d <= 360 && !from; d += 15) {
        const p = { x: cx - Math.cos(dir) * d, y: cy - Math.sin(dir) * d, a: dir }
        let clear =
          p.x > 60 && p.y > 60 && p.x < a.ARENA_W - 60 && p.y < a.ARENA_H - 60 &&
          !a.pointInWall(p.x, p.y)
        // Stop the probe *short of the barrel*, not short of its centre. `d` is
        // measured from the middle of the rect, so a ray walked to `d - 12`
        // ends up inside the barrel itself and reports the lane blocked by the
        // very thing it is a lane to. Every bearing failed on every board for
        // this reason, which reads exactly like "the arena has no open ground".
        const stop = d - Math.max(b.w, b.h) / 2 - 12
        for (let t = 0; t < stop && clear; t += 6) {
          if (a.pointInTallWall(p.x + Math.cos(dir) * t, p.y + Math.sin(dir) * t)) clear = false
        }
        if (clear) from = p
      }
    }
    if (!from) continue
    const hits = []
    for (let n = 0; n < 3; n++) {
      g.tank.dead = false
      g.tank.x = from.x
      g.tank.y = from.y
      g.tank.hull = from.a
      g.tank.gun = from.a
      g.tank.ammo = 4
      g.tank.reloadAt = 0
      g.tank.reloadingUntil = 0
      g.buffs.siegeUntil = 0
      g.update(0.016, { throttle: 0, steer: 0, aim: from.a, fire: true, reload: false, lob: false })
      for (let i = 0; i < 90; i++) {
        g.update(0.016, { throttle: 0, steer: 0, aim: from.a, fire: false, reload: false, lob: false })
      }
      hits.push({ hp: b.hp, gone: b.gone })
    }
    return { lane: true, hits, id: b.id, from: { x: Math.round(from.x), y: Math.round(from.y) } }
    }
    return { lane: false }
  })
  check('found a lane and put three shells into a barrel', shot.lane, JSON.stringify(shot))
  check(
    'three shells destroy it, and the first two do not',
    shot.hits && shot.hits[0].gone === false && shot.hits[1].gone === false && shot.hits[2].gone === true,
    JSON.stringify(shot.hits),
  )

  // Poll, do not wait a fixed 400ms. `syncCover` runs inside `draw`, and under
  // a software rasteriser this page renders at three or four frames a second —
  // so a fixed window is one or two frames and lands on the wrong side of the
  // repaint often enough to matter. This check went red once on a build that
  // was correct, which is the only kind of flake worth the time to remove.
  const drawnOnce = async (id, want) => {
    for (let i = 0; i < 60; i++) {
      const rows = await drawn()
      const row = rows.find((b) => b.id === id)
      if (row && row.visible === want) return rows
      await wait(100)
    }
    return drawn()
  }

  const after = await drawnOnce(shot.id, false)
  const hitOne = after.find((b) => b.id === shot.id)
  check('and the mesh comes off the board, not just the rect',
    hitOne?.gone === true && hitOne?.visible === false, JSON.stringify(hitOne))
  check('the control: the barrels nobody shot are still drawn',
    after.filter((b) => b.id !== shot.id).every((b) => b.gone === false && b.visible === true),
    JSON.stringify(after.filter((b) => b.id !== shot.id)))

  // ------------------------------------------------------- 2. it hits the wire

  const outgoing = await page.evaluate(() => {
    const g = window.__game
    let seen = null
    const real = g.publishAsSession.bind(g)
    g.publishAsSession = (kind, payload) => { if (kind === 21000) seen = payload; return real(kind, payload) }
    g.publishState(performance.now())
    g.publishAsSession = real
    return seen
  })
  const ourBits = await page.evaluate(() => window.__arena.coverBits())
  check('our tick carries the destroyed set',
    outgoing?.b === ourBits && ourBits > 0, JSON.stringify({ sent: outgoing?.b, board: ourBits }))

  // And the other direction: a peer says a barrel we have not shot is gone.
  const fromPeer = await page.evaluate((PEER, hash) => {
    const g = window.__game, a = window.__arena
    void hash
    // A different barrel from the one we shot, so this is about the union
    // rather than about re-destroying something already gone.
    const idx = a.BARRELS.findIndex((b) => !b.gone)
    const target = a.BARRELS[idx]
    const bit = 1 << idx
    g.onEvent({
      id: 'a' + Math.random().toString(16).slice(2),
      pubkey: PEER, kind: 21000, created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({
        t: Date.now(), x: 300, y: 300, h: 0, g: 0, hp: 3, d: false,
        ks: 0, ds: 0, r: g.round, b: bit,
      }),
    }, false)
    return { gone: target.gone, hp: target.hp, bits: a.coverBits(), id: target.id }
  }, PEER, HASH)
  check("a peer's tick takes out a barrel we never shot",
    fromPeer.gone === true && fromPeer.bits !== ourBits && (fromPeer.bits & ourBits) === ourBits,
    JSON.stringify({ ...fromPeer, ourBits }))

  const afterPeer = await drawnOnce(fromPeer.id, false)
  const peerOne = afterPeer.find((b) => b.id === fromPeer.id)
  check('and that one leaves the screen too',
    peerOne?.visible === false, JSON.stringify(peerOne))

  // The control that makes the two above mean something: a tick stamped with a
  // different round must not touch this board. Barrels come back every block,
  // so a stale mask would flatten a board that has just been rebuilt.
  const stale = await page.evaluate((PEER) => {
    const g = window.__game, a = window.__arena
    const idx = a.BARRELS.findIndex((b) => !b.gone)
    const target = a.BARRELS[idx]
    const was = a.coverBits()
    g.onEvent({
      id: 'a' + Math.random().toString(16).slice(2),
      pubkey: PEER, kind: 21000, created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({
        t: Date.now(), x: 300, y: 300, h: 0, g: 0, hp: 3, d: false,
        ks: 0, ds: 0, r: g.round - 1, b: 1 << idx,
      }),
    }, false)
    return { gone: target.gone, bits: a.coverBits(), was }
  }, PEER)
  check('the control: a mask stamped with another round is ignored',
    stale.gone === false && stale.bits === stale.was, JSON.stringify(stale))

  // --------------------------------------------------- 3. a new round rebuilds

  const rebuilt = await page.evaluate((hash) => {
    const g = window.__game, a = window.__arena, r = window.__renderer
    // `beginRound` was nailed shut above; call the real one off the prototype.
    Object.getPrototypeOf(g).beginRound.call(g, 900001, hash)
    return { bits: a.coverBits(), hp: a.BARRELS.map((b) => b.hp), gen: a.coverGeneration(), gone: a.BARRELS.map((b) => b.gone), firstId: a.BARRELS[0].id, _r: !!r }
  }, HASH)
  check('a new round puts every barrel back',
    rebuilt.bits === 0 && rebuilt.gone.every((g) => g === false), JSON.stringify(rebuilt))
  const afterRound = await drawnOnce(rebuilt.firstId, true)
  check('and they are all drawn again',
    afterRound.every((b) => b.visible === true), JSON.stringify(afterRound))

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall good')
process.exit(failures.length ? 1 : 0)
