// Two players, one machine, one screen.
//
// This is the mode the game is named after, and almost nothing about it is
// visible from a structural test. Everything that can break here breaks
// *quietly*: an input that belongs to nobody, a pad that is never read, a second
// tank that exists in memory and never reaches a pixel.
//
// Fizz measured three of these before the feature was written, against the
// single-player code, and every one of them would have shipped:
//
//   - player one holding W froze a pad that was actively being pushed, through
//     two separate `Input` objects, because both read a set filled from one
//     shared `window` listener
//   - a second pad was inert: `readPad()` returned whoever answered first, and a
//     *centred* pad zero was enough to shadow a pushed pad one
//   - a pad first seen while somebody was already pushing it calibrated the push
//     as its resting position and read zero until they let go
//
// So this suite hands the page two pads and measures whether two tanks move
// independently.
//
//   npm run build && npm run preview &
//   npm run test:couch

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL = process.env.TANK_URL ?? 'http://localhost:4173/'

const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p))
if (!executablePath) {
  console.error('No Chrome found. Set CHROME_PATH.')
  process.exit(2)
}

const FLAGS = [
  '--no-sandbox',
  '--window-size=1280,800',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
/** Far enough that nothing but a driven tank gets there. */
const MOVED = 40
/** Close enough that a tank which was never asked to move counts as parked. */
const PARKED = 20

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

try {
  // Two fake pads, from Fizz's probe. Installed before any page script runs.
  await page.evaluateOnNewDocument(() => {
    window.__pads = []
    navigator.getGamepads = () =>
      window.__pads.map((p, i) => ({
        id: `Fake Pad ${i}`,
        index: i,
        connected: true,
        mapping: 'standard',
        timestamp: performance.now(),
        axes: p.axes,
        buttons: p.buttons.map((v) => ({ pressed: v > 0.5, touched: v > 0.1, value: v })),
      }))
  })

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  // Both pads centred before anybody plays. Calibration learns a resting
  // position from what it sees first, so a pad that is *only* ever seen pushed
  // teaches it the wrong centre — which is Fizz's third finding, and it cost
  // them three false-zero runs before they spotted it.
  await page.evaluate(() => {
    window.__pads = [
      { axes: [0, 0, 0, 0], buttons: new Array(8).fill(0) },
      { axes: [0, 0, 0, 0], buttons: new Array(8).fill(0) },
    ]
  })

  await page.type('#name', 'couch')
  await page.type('#room', 'couch' + Math.floor(Math.random() * 1e6))
  await page.select('#players', '2')
  await page.click('#play-guest')

  const started = await page
    .waitForFunction(() => window.__players?.length === 2, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  check('two players start from one lobby', started)
  if (!started) throw new Error('cannot measure a couch match without two players')
  await wait(2500)

  // Pin the board. Without this the map comes from the real chain tip, and the
  // parking spots below stop being open lanes — which reads as "player two
  // cannot drive" when what actually happened is that player two drove into a
  // wall. It cost three failing runs before the map was the suspect.
  // `05` is Straight Deathmatch, `00` is Crossroads.
  await page.evaluate((t) => {
    window.__clock.accept({ height: 999999, hash: 'ab'.repeat(30) + '0500', time: t })
    document.getElementById('podium').hidden = true
  }, Math.floor(Date.now() / 1000))
  await wait(1200)
  const board = await page.evaluate(() => document.getElementById('hud-map')?.textContent)
  check('the board is pinned to a known map', board === 'Crossroads', String(board))

  const ids = await page.evaluate(() => ({
    keys: window.__players.map((p) => p.input.binding.keys),
    pads: window.__players.map((p) => p.input.binding.pad),
    mouse: window.__players.map((p) => p.input.binding.mouse),
    npubs: window.__players.map((p) => p.game.identity.pubkey.slice(0, 8)),
  }))
  check('they own different halves of the keyboard and different pads',
    ids.keys[0] !== ids.keys[1] && ids.pads[0] !== ids.pads[1], JSON.stringify(ids))
  check('and only one of them has the mouse', ids.mouse[0] && !ids.mouse[1], JSON.stringify(ids))
  // Player two is a real npub in the room, not a puppet of player one's key.
  check('player two signs with a key of their own', ids.npubs[0] !== ids.npubs[1],
    JSON.stringify(ids.npubs))

  // Zero relay latency between them is the whole point, so it gets checked
  // rather than assumed: each has to appear in the other's peer list, and that
  // must not take a round trip.
  const sees = await page.evaluate(() => ({
    oneSeesTwo: [...window.__players[0].game.peers.keys()].includes(
      window.__players[1].game.identity.sessionPubkey),
    twoSeesOne: [...window.__players[1].game.peers.keys()].includes(
      window.__players[0].game.identity.sessionPubkey),
  }))
  check('each is a peer of the other', sees.oneSeesTwo && sees.twoSeesOne, JSON.stringify(sees))

  // ------------------------------------------------- one uplink each, not one
  //
  // They share the screen and the machine; they must not share a `Net`. Every
  // failure counter in it is keyed by relay URL and written as though one
  // publisher owned the socket — `strikes` resets on any success, so a relay
  // refusing *player two's key* and accepting player one's never accumulates
  // fifteen in a row and never mutes, and player two's rejection reason is
  // wiped from `trouble` by player one's next success.
  //
  // The local mirror is what turns that from obvious into invisible: both
  // people on the couch see a perfectly correct room, because player two's
  // events reach player one without a relay at all. Only the rest of the world
  // sees one tank where there should be two.
  const uplinks = await page.evaluate(() => {
    const [one, two] = window.__players
    const realOne = one.game.net.publish.bind(one.game.net)
    const realTwo = two.game.net.publish.bind(two.game.net)
    const sent = { one: [], two: [] }
    one.game.net.publish = (e) => { sent.one.push(e.pubkey); return realOne(e) }
    two.game.net.publish = (e) => { sent.two.push(e.pubkey); return realTwo(e) }
    return new Promise((r) =>
      setTimeout(() => {
        one.game.net.publish = realOne
        two.game.net.publish = realTwo
        const k1 = one.game.identity.sessionPubkey
        const k2 = two.game.identity.sessionPubkey
        r({
          separate: one.game.net !== two.game.net,
          oneOnlyOwnKey: sent.one.length > 0 && sent.one.every((k) => k === k1 || k === one.game.identity.pubkey),
          twoOnlyOwnKey: sent.two.length > 0 && sent.two.every((k) => k === k2 || k === two.game.identity.pubkey),
          counts: [sent.one.length, sent.two.length],
        })
      }, 2500),
    )
  })
  check('the two players have an uplink each rather than sharing one',
    uplinks.separate, JSON.stringify(uplinks))
  // The property that makes the counters attributable at all: nothing player one
  // publishes can clear a strike earned by player two, because it never travels
  // on player two's socket.
  check("and nothing of player one's goes out over player two's socket",
    uplinks.oneOnlyOwnKey && uplinks.twoOnlyOwnKey, JSON.stringify(uplinks))

  // Both tanks in the clear edge lanes of Crossroads — all of its cover sits
  // between x=300 and x=1300 — already pointing up the lane, so nothing here
  // measures the time a hull takes to turn around.
  const UP = -Math.PI / 2
  const park = () => page.evaluate((hull) => {
    const spots = [
      { x: 120, y: 1000 },
      { x: 1480, y: 1000 },
    ]
    window.__players.forEach((p, i) => {
      p.game.tank.dead = false
      p.game.tank.hp = p.game.maxHp
      p.game.tank.reloadAt = 0
      p.game.tank.x = spots[i].x
      p.game.tank.y = spots[i].y
      p.game.tank.hull = hull
      p.game.tank.gun = hull
    })
  }, UP)
  const where = () => page.evaluate(() =>
    window.__players.map((p) => ({ x: p.game.tank.x, y: p.game.tank.y })))
  const moved = (from, to, i) => Math.hypot(to[i].x - from[i].x, to[i].y - from[i].y)

  /**
   * Hold an input and watch until somebody has actually gone somewhere.
   *
   * Polled rather than waited out. Under software rasterisation the whole
   * simulation runs in slow motion and by a different factor on every run, so
   * any single fixed duration is a guess that eventually reads a working tank as
   * a broken one. `watch` is which player has to move for the run to be over.
   */
  const drive = async (hold, release, watch) => {
    const before = await where()
    await hold()
    let after = before
    for (let i = 0; i < 16; i++) {
      await wait(500)
      after = await where()
      if (moved(before, after, watch) > MOVED) break
    }
    await release()
    await wait(250)
    after = await where()
    return { one: Math.round(moved(before, after, 0)), two: Math.round(moved(before, after, 1)) }
  }

  // ------------------------------------------------------------- the big one
  //
  // Player one holds a key while player two pushes a pad. Before the split,
  // player one's W suppressed the pad outright — through two `Input` objects,
  // because the backstop read a page-wide key set.
  await park()
  const both = await drive(
    async () => {
      await page.keyboard.down('KeyW')
      await page.evaluate(() => { window.__pads[1].axes = [0, -0.9, 0, 0] })
    },
    async () => {
      await page.keyboard.up('KeyW')
      await page.evaluate(() => { window.__pads[1].axes = [0, 0, 0, 0] })
    },
    1,
  )
  check('player one on the keyboard moves', both.one > MOVED, JSON.stringify(both))
  check('and player two on a pad moves at the same time', both.two > MOVED, JSON.stringify(both))

  // The second pad on its own. A centred pad zero used to be enough to shadow
  // it entirely, because the first pad to answer was returned every frame.
  await park()
  const solo = await drive(
    () => page.evaluate(() => {
      window.__pads[0].axes = [0, 0, 0, 0]
      window.__pads[1].axes = [0, -0.9, 0, 0]
    }),
    () => page.evaluate(() => { window.__pads[1].axes = [0, 0, 0, 0] }),
    1,
  )
  check('pad two drives player two past a centred pad one', solo.two > MOVED, JSON.stringify(solo))
  check('and player one stays put', solo.one < PARKED, JSON.stringify(solo))

  // Player two on the arrow keys, for a couch with only one pad in it.
  await page.evaluate(() => { window.__players[1].input.binding.pad = null })
  await park()
  const keys = await drive(
    () => page.keyboard.down('ArrowUp'),
    () => page.keyboard.up('ArrowUp'),
    1,
  )
  check('player two can drive on the arrow keys instead', keys.two > MOVED, JSON.stringify(keys))
  check("and player one's tank does not answer to them", keys.one < PARKED, JSON.stringify(keys))
  await page.evaluate(() => { window.__players[1].input.binding.pad = 1 })

  // A player with no mouse and no right stick still has to be able to shoot
  // somebody: the gun follows the hull.
  const aimed = await page.evaluate(async () => {
    const p2 = window.__players[1]
    p2.game.tank.dead = false
    p2.game.tank.hull = 1.2
    p2.game.tank.gun = -2.5
    for (let i = 0; i < 60; i++) {
      p2.game.update(1 / 60, p2.input.read(p2.game.tank))
    }
    return { gun: p2.game.tank.gun, hull: p2.game.tank.hull }
  })
  const gap = Math.abs(Math.atan2(Math.sin(aimed.gun - aimed.hull), Math.cos(aimed.gun - aimed.hull)))
  check('a player with no mouse aims along the hull rather than never turning',
    gap < 0.3, `gun ${aimed.gun.toFixed(2)} hull ${aimed.hull.toFixed(2)}`)

  // ------------------------------------------------------------ the shortcut
  //
  // Local players skip the relay entirely. Checked by cutting the relays off at
  // the knees — if a shot still arrives, it did not come from a socket.
  const offline = await page.evaluate(async () => {
    const [one, two] = window.__players
    const sent = []
    // Returns a resolved outcome rather than nothing: `publishClaim` waits on
    // this now, and a wrapper that returns undefined throws on `.then`.
    const nowhere = () =>
      Promise.resolve({ sent: 0, accepted: 0, refused: 0, unclear: 0, unanimouslyRefused: false, reason: null })
    one.game.net.publish = (e) => { sent.push(e.kind); return nowhere() }
    two.game.net.publish = (e) => { sent.push(e.kind); return nowhere() }
    two.game.tank.dead = false
    two.game.tank.reloadAt = 0
    const before = one.game.shells.size
    two.game.update(1 / 60, { throttle: 0, steer: 0, aim: 0, fire: true })
    // Same turn. Not "soon", not "next frame".
    return { arrived: one.game.shells.size - before, published: sent.length }
  })
  check("player two's shot reaches player one with the relays cut off",
    offline.arrived > 0, JSON.stringify(offline))
  check('and it was still published for anyone remote', offline.published > 0,
    JSON.stringify(offline))

  // On screen, not just in memory. Player two is an ordinary peer of player one,
  // so without being told they are local they render as a stranger.
  const drawn = await page.evaluate(() => {
    const [one, two] = window.__players
    const rig = window.__renderer.rigs.get(two.game.identity.sessionPubkey)
    return {
      rigged: !!rig,
      ring: rig ? rig.ring.visible : null,
      onBoard: rig ? Math.round(rig.root.position.x) : null,
      p2Panel: !document.getElementById('p2').hidden,
      panelDisplay: getComputedStyle(document.getElementById('p2')).display,
    }
  })
  check('player two has a tank on the board', drawn.rigged, JSON.stringify(drawn))
  check('and it wears a local ring rather than rendering as a stranger',
    drawn.ring === true, JSON.stringify(drawn))
  check('and their panel is actually on the page', drawn.p2Panel && drawn.panelDisplay !== 'none',
    JSON.stringify(drawn))

  // ------------------------------------------ a rollback has to reach both
  //
  // `publishClaim` mirrors before publishing, so player two already marked that
  // pad taken. Rolling back only the game that published leaves player one
  // agreeing with the room and player two not — and it does not heal, because
  // player two keeps the id in `claimed` and re-marks the pad on every rebuild.
  // The pad ends up dead for both people, in two different ways, on the one
  // screen where you can see both.
  const rollback = await page.evaluate(async () => {
    const [one, two] = window.__players
    const g = one.game
    const pad = [...g.pickups.values()].find((p) => !p.taken && !g.spent.has(p.id))
    if (!pad) return { skipped: true }

    const real = g.net.publish.bind(g.net)
    g.net.publish = (e) =>
      e.kind === 30078 && e.tags.some((t) => t[0] === 'expiration')
        ? Promise.resolve({
            sent: 4, accepted: 0, refused: 4, malformed: 0, unclear: 0,
            unanimouslyRefused: true, definitelyNowhere: true,
            reason: 'blocked: not accepted here',
          })
        : real(e)

    g.tank.dead = false
    g.tank.x = pad.at.x
    g.tank.y = pad.at.y
    await new Promise((r) => setTimeout(r, 1200))
    const mid = { twoSawIt: two.claimed?.has?.(pad.id) ?? null }
    await new Promise((r) => setTimeout(r, 1200))
    g.net.publish = real
    return {
      skipped: false,
      id: pad.id,
      mid,
      oneBack: !!one.game.pickups.get(pad.id) && !one.game.pickups.get(pad.id).taken,
      twoBack: !!two.game.pickups.get(pad.id) && !two.game.pickups.get(pad.id).taken,
      twoStillClaims: two.game.claimed.has(pad.id),
    }
  })
  if (rollback.skipped) {
    check('a rollback reaches both local players', false, 'no free pad to test with')
  } else {
    check('a refused claim puts the pad back for player one', rollback.oneBack,
      JSON.stringify(rollback))
    // The half that was missing. Player two heard the claim through the mirror,
    // so player two has to hear the rollback the same way.
    check('and for player two, who only ever heard about it through the mirror',
      rollback.twoBack, JSON.stringify(rollback))
    // Otherwise `refreshPickups` re-marks it taken on every rebuild and the pad
    // stays dead for player two long after player one has it back.
    check('and player two is not still holding the claim that was withdrawn',
      !rollback.twoStillClaims, JSON.stringify(rollback))
  }

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
}

if (failures.length) {
  console.log(`\n${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nAll couch checks passed.')
