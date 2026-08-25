// Capture the flag, with nobody to hold the flag.
//
// Puzz: "Capture the flag 2v2 and 3v3 and 4v4."
//
// A flag is world state that moves, which is the thing this game has spent
// every feature avoiding. The design that makes it work is one rule: **a flag
// is never anywhere except a base or a tank.** No dropped-at position, so
// nothing for two clients to disagree about; no pickup radius anywhere but a
// base whose position everybody derives from the layout; nothing stored, so a
// late joiner reads the current tick stream and knows where every flag is.
//
// So the checks that matter are the ones about *convergence*, and they are the
// ones with teeth:
//
//   - Two clients hearing the same claims name the same carrier, including
//     when two people claim one flag at once.
//   - A carrier who stops publishing loses it everywhere at the same moment,
//     because everybody runs the same expiry against their own clock.
//   - The carrier is read back *out of* that resolution rather than remembered,
//     so a player who loses a tie is not holding a flag on their own screen
//     either.
//
// Everything else is a rule with a control: you cannot take your own flag, you
// cannot score while yours is out, and a flag on a tank that has left the board
// goes home.
//
//   npm run build && npx vite preview --port 4208 &
//   npm run test:flags

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4208/'
const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!executablePath) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2) }

const FLAGS_ARGV = [
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

// Deliberately ordered: `LOW` sorts before `HIGH` as a hex string, which is how
// a tie between two claimants is settled.
const LOW = '11'.repeat(32)
const HIGH = 'ee'.repeat(32)
const HASH = 'ab'.repeat(30) + '0300'

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS_ARGV })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'flag')
  await page.type('#room', 'ctf' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game && !!window.__renderer, { timeout: 25_000 })
    .then(() => true).catch(() => false)
  check('a game is running', started)
  if (!started) throw new Error('the game never started')

  await page.evaluate((hash) => {
    window.__clock.accept({ height: 900000, hash, time: Math.floor(Date.now() / 1000) - 30 })
    window.__clock.accept = () => {}
    const g = window.__game
    g.beginRound(900000, hash)
    g.beginRound = () => {}
    g.botsEnabled = false
    document.getElementById('podium').hidden = true
    g.team = 1
  }, HASH)
  await wait(800)

  // ---------------------------------------------------------------- the bases

  const bases = await page.evaluate(() => {
    const A = window.__arena
    const out = []
    for (let t = 1; t <= window.__flags.FLAG_TEAMS; t++) {
      const b = window.__flags.baseFor(t)
      out.push(b ? { t, x: Math.round(b.x), y: Math.round(b.y), inWall: !!A.pointInWall(b.x, b.y) } : null)
    }
    // A fifth side has no base: the spawn list is four corners then four edge
    // midpoints, so a fifth base always sits on the line between two others.
    return { out, fifth: window.__flags.baseFor(5) }
  })
  check('four sides have a base', bases.out.length === 4 && bases.out.every((b) => b !== null),
    JSON.stringify(bases.out))
  check('the control: a fifth side has none, so flags stay a four-corner game',
    bases.fifth === null, JSON.stringify(bases.fifth))
  check('the control: and none of them is inside the scenery',
    bases.out.every((b) => b && !b.inWall), JSON.stringify(bases.out.map((b) => b?.inWall)))

  const spread = (() => {
    let closest = Infinity
    for (let a = 0; a < bases.out.length; a++) {
      for (let b = a + 1; b < bases.out.length; b++) {
        closest = Math.min(closest, Math.hypot(bases.out[a].x - bases.out[b].x, bases.out[a].y - bases.out[b].y))
      }
    }
    return Math.round(closest)
  })()
  check('the control: and no two bases overlap their own reach',
    spread > 2 * 90, `closest pair ${spread} apart against a 90 reach`)

  // A base must not sit on a spawn. `respawn` picks the spawn furthest from
  // everybody alive, so a shared position is a base somebody can respawn onto
  // and take the flag from in the frame they came back — which is exactly what
  // the first cut of this did.
  const offSpawn = await page.evaluate(() => {
    const A = window.__arena, F = window.__flags
    let closest = Infinity
    for (let t = 1; t <= F.FLAG_TEAMS; t++) {
      const b = F.baseFor(t)
      for (const sp of A.SPAWNS) closest = Math.min(closest, Math.hypot(b.x - sp.x, b.y - sp.y))
    }
    return Math.round(closest)
  })
  check('the control: and no base is close enough to a spawn to be taken on respawn',
    offSpawn > 90, `closest base-to-spawn ${offSpawn} against a 90 reach`)

  /** Stand on a base, on a side, alive. */
  const stand = (team, onBase) => page.evaluate(({ team, onBase }) => {
    const g = window.__game
    const b = window.__flags.baseFor(onBase)
    g.team = team
    g.tank.dead = false
    g.tank.hp = 3
    g.tank.x = b.x
    g.tank.y = b.y
    return { at: [Math.round(b.x), Math.round(b.y)] }
  }, { team, onBase })

  const step = (n = 4) => page.evaluate((n) => {
    const g = window.__game
    for (let i = 0; i < n; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
    }
    return { carrying: g.carrying, captures: g.captures }
  }, n)

  // ------------------------------------------------------------- taking one

  await stand(1, 2)
  const took = await step()
  check('standing on an enemy base takes their flag',
    took.carrying === 2, JSON.stringify(took))

  // The control that makes it a rule rather than a radius: your own base does
  // nothing. Taking your own flag is not a move, it is a way to hide it.
  await page.evaluate(() => { window.__game.carrying = 0; window.__game.claims?.clear?.() })
  await stand(1, 1)
  const own = await step()
  check('the control: standing on your own base takes nothing',
    own.carrying === 0, JSON.stringify(own))

  // And distance matters. Halfway between two bases is nowhere.
  // Somewhere genuinely away from every base. Picked by searching rather than
  // by taking a midpoint: the first version used the midpoint of bases one and
  // two, which on Crossroads was 25 units from base five's — the test was
  // standing on a base and reporting that standing between bases picks a flag
  // up.
  const between = await page.evaluate(() => {
    const g = window.__game, F = window.__flags, A = window.__arena
    let spot = null
    let best = 0
    for (let x = 200; x < A.ARENA_W - 200 && !spot; x += 60) {
      for (let y = 200; y < A.ARENA_H - 200; y += 60) {
        if (A.pointInWall(x, y)) continue
        let closest = Infinity
        for (let t = 1; t <= F.FLAG_TEAMS; t++) {
          const b = F.baseFor(t)
          closest = Math.min(closest, Math.hypot(b.x - x, b.y - y))
        }
        if (closest > best) { best = closest; spot = { x, y } }
      }
    }
    g.tank.x = spot.x
    g.tank.y = spot.y
    for (let i = 0; i < 4; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
    }
    return { carrying: g.carrying, spot, clearance: Math.round(best) }
  })
  check('the control: and standing clear of every base takes nothing',
    between.carrying === 0, JSON.stringify(between))

  // ---------------------------------------------------------------- scoring

  await stand(1, 2)
  await step()
  const carried = await page.evaluate(() => window.__game.carrying)
  check('picked one up again to run it home', carried === 2, String(carried))

  const scored = await page.evaluate(() => {
    const g = window.__game
    const home = window.__flags.baseFor(1)
    g.tank.x = home.x
    g.tank.y = home.y
    const before = g.captures
    for (let i = 0; i < 4; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
    }
    return { before, after: g.captures, carrying: g.carrying }
  })
  check('running it to your own base scores',
    scored.after === scored.before + 1 && scored.carrying === 0, JSON.stringify(scored))

  // The classic rule, and the control that shows it is enforced: you cannot
  // score while your own flag is out. Without it a pair of duos trade flags
  // forever and neither ever has to defend.
  const blocked = await page.evaluate((HIGH) => {
    const g = window.__game
    // A stranger on side 2 is carrying *our* flag.
    g.onEvent({
      id: 'a' + Math.random().toString(16).slice(2),
      pubkey: HIGH, kind: 21000, created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({
        t: Date.now(), x: 400, y: 400, h: 0, g: 0, hp: 3, d: false,
        ks: 0, ds: 0, r: g.round, tm: 2, f: 1,
      }),
    }, false)
    // And we are on theirs with their flag.
    const theirs = window.__flags.baseFor(2)
    g.tank.x = theirs.x
    g.tank.y = theirs.y
    for (let i = 0; i < 4; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
    }
    const grabbed = g.carrying
    const home = window.__flags.baseFor(1)
    g.tank.x = home.x
    g.tank.y = home.y
    const before = g.captures
    for (let i = 0; i < 6; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
    }
    return { grabbed, before, after: g.captures, stillCarrying: g.carrying }
  }, HIGH)
  check('you cannot score while your own flag is out',
    blocked.grabbed === 2 && blocked.after === blocked.before && blocked.stillCarrying === 2,
    JSON.stringify(blocked))

  // ------------------------------------------------------ ties and expiry

  // Two claimants, one flag. Every client settles it the same way — lower
  // session key — so this is the check that two screens never show two people
  // carrying one flag.
  const tie = await page.evaluate(({ LOW, HIGH }) => {
    const now = performance.now()
    const F = window.__flags
    const one = F.carriers([
      { who: HIGH, flag: 3, at: now },
      { who: LOW, flag: 3, at: now },
    ], now)
    // The same two claims in the other order, which is what a second client
    // with a different relay would see.
    const two = F.carriers([
      { who: LOW, flag: 3, at: now },
      { who: HIGH, flag: 3, at: now },
    ], now)
    return { one: one.get(3), two: two.get(3), low: LOW, agree: one.get(3) === two.get(3) }
  }, { LOW, HIGH })
  check('two clients who heard the claims in different orders agree',
    tie.agree === true && tie.one === tie.low, JSON.stringify({ one: tie.one?.slice(0, 4), two: tie.two?.slice(0, 4) }))

  const expiry = await page.evaluate(({ LOW }) => {
    const now = performance.now()
    const F = window.__flags
    const fresh = F.carriers([{ who: LOW, flag: 4, at: now - 200 }], now)
    const stale = F.carriers([{ who: LOW, flag: 4, at: now - F.CLAIM_TTL_MS - 200 }], now)
    return { fresh: fresh.get(4) ?? null, stale: stale.get(4) ?? null, ttl: F.CLAIM_TTL_MS }
  }, { LOW })
  check('a claim that stopped arriving expires, and the flag goes home',
    expiry.fresh !== null && expiry.stale === null, JSON.stringify(expiry))
  check('the control: and it survives a dropped tick or two first',
    expiry.ttl >= 1000, `${expiry.ttl}ms against a 100ms tick`)

  // Leaving the board drops it. A flag on a tank that is dead, spectating or
  // flying is the dropped-flag state this design exists to avoid.
  const died = await page.evaluate(() => {
    const g = window.__game
    const theirs = window.__flags.baseFor(2)
    g.tank.dead = false
    g.tank.x = theirs.x
    g.tank.y = theirs.y
    for (let i = 0; i < 4; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
    }
    const holding = g.carrying
    g.tank.dead = true
    // And *stay* dead. `update` respawns the moment `respawnAt` has passed, and
    // it had — so the tank came straight back, landed near a base and took the
    // flag again inside the same four frames this was measuring.
    g.tank.respawnAt = performance.now() + 60_000
    for (let i = 0; i < 4; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
    }
    const after = { carrying: g.carrying, held: [...g.flagCarriers().keys()] }
    g.tank.dead = false
    return { holding, after }
  })
  check('dying sends the flag home rather than dropping it',
    died.holding === 2 && died.after.carrying === 0 && !died.after.held.includes(2),
    JSON.stringify(died))

  // ------------------------------------------------------------ on the board

  const drawn = await page.evaluate(async () => {
    const g = window.__game, r = window.__renderer
    g.team = 1
    // A clean board. Earlier phases left us carrying one flag and a stranger
    // carrying another, so "the cloth is on the pole" was being asked about two
    // flags that were correctly out — green would have been the bug.
    g.carrying = 0
    g.claims.clear()
    g.tank.dead = false
    g.tank.respawnAt = 0
    const away = window.__flags.baseFor(3)
    g.tank.x = away.x + 400
    g.tank.y = away.y
    // A stranger on side 2, so both bases exist.
    g.onEvent({
      id: 'a' + Math.random().toString(16).slice(2),
      pubkey: 'cc'.repeat(32), kind: 21000, created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({
        t: Date.now(), x: 500, y: 500, h: 0, g: 0, hp: 3, d: false,
        ks: 0, ds: 0, r: g.round, tm: 2,
      }),
    }, false)
    for (let i = 0; i < 25; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
      await new Promise((res) => setTimeout(res, 40))
    }
    const out = []
    for (const t of [1, 2]) {
      const rig = r.flagRigAt(t)
      if (!rig) { out.push({ t, rig: null }); continue }
      const p = r.toScreen(rig.root.position.x, 100, rig.root.position.z)
      out.push({
        t,
        cloth: rig.cloth.visible,
        screen: p ? [Math.round(p.x), Math.round(p.y)] : null,
      })
    }
    return out
  })
  check('both bases have a pole on the board',
    drawn.every((d) => d.rig !== null && d.screen), JSON.stringify(drawn))
  check('and the cloth is on the pole while the flag is home',
    drawn.every((d) => d.cloth === true), JSON.stringify(drawn.map((d) => d.cloth)))

  const outFlag = await page.evaluate(async () => {
    const g = window.__game, r = window.__renderer
    const theirs = window.__flags.baseFor(2)
    g.tank.dead = false
    g.tank.x = theirs.x
    g.tank.y = theirs.y
    for (let i = 0; i < 25; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
      await new Promise((res) => setTimeout(res, 40))
    }
    return {
      carrying: g.carrying,
      cloth: r.flagRigAt(2)?.cloth.visible ?? null,
      onTank: r.youFlagVisible(),
    }
  })
  check('taking it strips the cloth from their pole',
    outFlag.carrying === 2 && outFlag.cloth === false, JSON.stringify(outFlag))
  check('and puts it on the tank carrying it',
    outFlag.onTank === true, String(outFlag.onTank))

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall good')
process.exit(failures.length ? 1 : 0)
