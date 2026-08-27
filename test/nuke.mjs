// The nuke at twenty-five: the whole board goes up.
//
// Puzz: *"25 kills without dying should be a nuke and atomic bomb drops and the
// whole board blows up like an atomic bomb."*
//
// The apex reward is the one that can end a round for everybody at once, so
// the claims worth checking are mostly about restraint:
//
//   1. It is a *choice* in the apex pool, not a rung handed out at 25.
//   2. Spending it publishes one event and nothing else happens yet. The five
//      seconds of countdown are the whole reason it is not a random death, and
//      a board that went up on the spend would pass every "did it kill things"
//      check below.
//   3. When it lands: enemies dead, every piece of cover flattened, screen
//      white. Checked on the board, not on a flag.
//   4. The caller and the caller's side live. A reward that kills the person
//      who earned it is not a reward.
//   5. Somebody else's nuke kills *us* — the victim applies its own death,
//      which is the same trust model as a shell, and it is the half that a
//      single-client test cannot see by accident.
//   6. The flattened cover rides out in the state tick's `b` union, so a
//      client that never received the event still converges on the crater.
//
//   npm run build && npx vite preview --port 4340 &
//   npm run test:nuke

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4340/'
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
async function until(fn, ms = 15_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await wait(80)
  }
  return null
}

const PEER = 'd1'.repeat(32)
// Pinned, like every other suite here: the map, the hull and the pickup wave
// all come off the tip, and a live block landing mid-run changes the board
// under a check about what is left of it.
const HASH = 'ab'.repeat(30) + '0300'

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 900 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

/** The board, as the game and the arena see it. */
const world = () =>
  page.evaluate(() => {
    const g = window.__game
    const a = window.__arena
    return {
      dead: !!g.tank.dead,
      hp: g.tank.hp,
      streak: g.streak,
      nukeIn: g.nukeIn,
      flashing: g.nukeFlashAt > 0 && performance.now() - g.nukeFlashAt < 2600,
      bots: g.bots.map((b) => ({ dead: !!b.tank.dead, team: b.team ?? 0 })),
      cover: a.BREAKABLE.map((r) => !!r.gone),
      coverBits: a.coverBits(),
    }
  })

/** What the countdown looks like on the glass. */
const doomsday = () =>
  page.evaluate(() => {
    const n = document.getElementById('doomsday')
    if (!n || n.hidden) return null
    const box = n.getBoundingClientRect()
    return {
      cls: n.className,
      text: n.textContent ?? '',
      white: getComputedStyle(n).backgroundColor,
      w: Math.round(box.width),
      h: Math.round(box.height),
    }
  })

/** Reach a rung for real: set the streak one short, then land a kill. */
const kill = () =>
  page.evaluate((PEER) => {
    const g = window.__game
    g.tank.dead = false
    g.onEvent({
      id: 'a' + Math.random().toString(16).slice(2),
      pubkey: PEER, kind: 21002, created_at: Math.floor(Date.now() / 1000), tags: [],
      sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), k: g.identity.sessionPubkey, x: 400, y: 400 }),
    }, false)
  }, PEER)

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  // --------------------------------------------- 1. it is a choice, not a rung

  const apex = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#loadout-rows .loadout-row')]
    const last = rows[rows.length - 1]
    return {
      tier: last?.querySelector('.loadout-tier')?.textContent ?? '',
      ids: [...last.querySelectorAll('button[data-reward]')].map((b) => b.dataset.reward),
      chosen: [...last.querySelectorAll('button[data-reward]')]
        .filter((b) => b.getAttribute('aria-pressed') === 'true')
        .map((b) => b.dataset.reward),
      icon: !!last.querySelector('button[data-reward="nuke"] svg'),
    }
  })
  check('the nuke is in the apex pool', apex.ids.includes('nuke'), JSON.stringify(apex.ids))
  check('at twenty-five, with the other apex rewards', /^25/.test(apex.tier), JSON.stringify(apex.tier))
  check('it has an icon like every other card', apex.icon)
  check(
    'and it is a choice rather than the default — the pool still offers alternatives',
    apex.chosen.length === 1 && apex.chosen[0] !== 'nuke' && apex.ids.length >= 5,
    JSON.stringify(apex),
  )

  await page.type('#name', 'nuke')
  await page.type('#room', 'nuke' + Math.floor(Math.random() * 1e6))
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
    g.beginRound = () => {}
    window.__arena.setLayout(window.__arena.layoutForBlock(hash))
    document.getElementById('podium').hidden = true
  }, HASH)
  await wait(1200)

  // ------------------------------------ 2. the spend is a countdown, not a bang

  const sent = await page.evaluate(() => {
    const g = window.__game
    g.__sent = []
    const real = g.publishAsSession.bind(g)
    g.publishAsSession = (kind, payload) => { if (kind === 21004) g.__sent.push(payload); return real(kind, payload) }
    g.setLoadout(['strike', 'chopper', 'jugger', 'nuke'])
    g.tank.dead = false
    g.tank.hp = g.maxHp
    g.streak = 24
    g.earned = []
    return true
  })
  check('the loadout takes the nuke on the apex rung', sent)
  await kill()
  const held = await until(() => page.evaluate(() => window.__game.holding(25)))
  check('twenty-five in a row banks it rather than firing it', !!held)
  const beforeSpend = await world()
  // The watcher, armed before the spend. It runs on the page's own animation
  // frames, so it samples the world on the frame the nuke lands rather than
  // whenever a round trip from the test happens to arrive.
  await page.evaluate(() => {
    const g = window.__game
    const a = window.__arena
    window.__nukeSnap = null
    let hpBefore = g.tank.hp
    const tick = () => {
      if (!g.nukeFlashAt) hpBefore = g.tank.hp
      else if (!window.__nukeSnap) {
        window.__nukeSnap = {
          bots: g.bots.map((b) => !!b.tank.dead),
          cover: a.BREAKABLE.map((r) => !!r.gone),
          coverBits: a.coverBits(),
          dead: !!g.tank.dead,
          hp: g.tank.hp,
          hpBefore,
          flash: null,
        }
      }
      // The HUD paints at eight frames a second, so the white-out is not up on
      // the same frame the bang is. Keep looking for it rather than deciding
      // on one sample.
      if (window.__nukeSnap && !window.__nukeSnap.flash) {
        const n = document.getElementById('doomsday')
        if (n && !n.hidden && n.className === 'blast') {
          window.__nukeSnap.flash = {
            cls: n.className,
            white: getComputedStyle(n).backgroundColor,
            w: Math.round(n.getBoundingClientRect().width),
          }
        }
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  await page.evaluate(() => window.__game.spend(25))
  const payload = await page.evaluate(() => (window.__game.__sent ?? []).slice(-1)[0])
  check(
    'spending publishes one nuke event: a time, and deliberately no y',
    payload?.k === 'nuke' && typeof payload?.t0 === 'number' && payload?.y === undefined,
    JSON.stringify(payload),
  )
  check(
    'and exactly one — the board going up is one publish, not one per victim',
    (await page.evaluate(() => (window.__game.__sent ?? []).length)) === 1,
    JSON.stringify(await page.evaluate(() => window.__game.__sent)),
  )

  // Nothing has happened yet, and that is the claim. Sampled about a second in,
  // which is inside the five and after any frame the spend could have run on.
  await wait(1100)
  const during = await world()
  const strip = await doomsday()
  check(
    'nothing dies while the siren runs — the countdown is the whole reward',
    during.bots.every((b) => !b.dead) && during.cover.every((c) => !c) && !during.flashing,
    JSON.stringify({ bots: during.bots.filter((b) => b.dead).length, cover: during.coverBits }),
  )
  check(
    'the countdown is on the glass and counting down',
    !!strip && /NUKE INBOUND/.test(strip.text) && during.nukeIn !== null && during.nukeIn < 4.5,
    JSON.stringify({ strip: strip?.text?.slice(0, 40), left: during.nukeIn }),
  )
  check(
    'and it covers the screen rather than sitting in a corner',
    !!strip && strip.w > 600 && strip.h > 400,
    JSON.stringify({ w: strip?.w, h: strip?.h }),
  )
  const ticking = await until(async () => {
    const w = await world()
    return w.nukeIn !== null && w.nukeIn < during.nukeIn - 0.4 ? w : null
  }, 4000)
  check('the number really moves', !!ticking, `${during.nukeIn} -> ${ticking?.nukeIn}`)

  // -------------------------------------------------------- 3. and then it lands

  // Watched from *inside* the page, on the frame it happens.
  //
  // Polling from Node cannot see this. The bots respawn a couple of seconds
  // after they die and the white-out clears in 2.6s, and under a software
  // rasteriser a `page.evaluate` round trip is most of a second — so a poll
  // that starts before the bang lands and reads "bots alive, no flash" is
  // reading the world after it has already been rebuilt. It looks exactly like
  // a nuke that did nothing.
  const landed = await until(() => page.evaluate(() => window.__nukeSnap), 12_000)
  check('it goes off on its own, without another click', !!landed, JSON.stringify(landed))
  check(
    'every piece of cover is flattened',
    !!landed && landed.cover.length > 0 && landed.cover.every(Boolean),
    JSON.stringify({ cover: landed?.cover, bits: landed?.coverBits }),
  )
  check(
    'and the caller lives — a reward that kills its earner is not a reward',
    !!landed && !landed.dead && landed.hp === landed.hpBefore,
    JSON.stringify({ dead: landed?.dead, hp: landed?.hp, before: landed?.hpBefore }),
  )
  const flash = await until(() => page.evaluate(() => window.__nukeSnap?.flash ?? null), 6000)
  // The alpha, not just the colour. `rgba(255,255,255,0)` is white in the same
  // sense that an unlit bulb is a light — and it is what this check found the
  // first time, because the fade had run to nothing before the HUD's first
  // frame after the bang.
  const alpha = flash?.white?.match(/rgba\(255,\s*255,\s*255,\s*([\d.]+)\)/)
  check(
    'the screen goes white — and the white is actually on the screen',
    !!flash && flash.cls === 'blast' && (!alpha || Number(alpha[1]) > 0.25),
    JSON.stringify(flash),
  )
  // The crater has to reach the other screens, and it does it through the union
  // every barrel already uses rather than through the nuke event — so a client
  // that missed the event still converges.
  const tick = await page.evaluate(() => {
    const g = window.__game
    let seen = null
    const real = g.publishAsSession.bind(g)
    g.publishAsSession = (kind, payload) => { if (kind === 21000) seen = payload; return real(kind, payload) }
    g.publishState(performance.now())
    g.publishAsSession = real
    return seen
  })
  check(
    'the crater rides out in the cover union, not in a second event',
    typeof tick?.b === 'number' && tick.b === (await page.evaluate(() => window.__arena.coverBits())),
    JSON.stringify({ b: tick?.b }),
  )

  // The flash is not permanent. A white screen that never cleared would pass
  // every check above and make the game unplayable for the rest of the round.
  const cleared = await until(async () => ((await doomsday()) === null ? true : null), 6000)
  check('and the white-out clears', !!cleared, JSON.stringify(await doomsday()))

  // ------------------------------------------------- 4. and it takes the bots
  //
  // Their own scenario, because a room with a human peer in it stands the
  // practice tanks down — the streak above was earned off a peer's death
  // event, which means there were no bots left on the board to kill. So: clear
  // the peers, let the tanks come back, and earn the rung off a bot instead.

  const botted = await page.evaluate(async () => {
    const g = window.__game
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    window.__arena.resetCover()
    g.peers.clear()
    g.botsWanted = 3
    g.nuke = null
    g.nukeFlashAt = 0
    g.tank.dead = false
    g.tank.hp = g.maxHp
    g.team = 0
    for (let i = 0; i < 60 && g.bots.length < 3; i++) await sleep(100)
    if (g.bots.length < 3) return { bots: [], why: 'no bots' }
    // Reach the rung by killing a bot, the same way test/rewards.mjs does.
    g.streak = 24
    g.earned = []
    const victim = g.bots[0]
    victim.tank.dead = false
    victim.tank.hp = 1
    const id = 'k' + Math.random().toString(16).slice(2)
    g.shells.set(id, {
      id, owner: g.identity.sessionPubkey, x: victim.tank.x, y: victim.tank.y,
      vx: 1, vy: 0, bounces: 0, maxBounces: 0, damage: 1, lob: 0,
      travel: 0, struck: -1, landed: false, age: 0, dead: false,
    })
    for (let i = 0; i < 6; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
    }
    if (!g.holding(25)) return { bots: [], why: 'never banked' }
    const killsBefore = g.botKills
    g.spend(25)
    // Sampled on the frame the flash lands, for the same reason as above: the
    // bots respawn a couple of seconds later and a late sample sees a full
    // board and calls the nuke a no-op.
    let snap = null
    for (let i = 0; i < 200 && !snap; i++) {
      if (g.nukeFlashAt) snap = { bots: g.bots.map((b) => !!b.tank.dead), kills: g.botKills - killsBefore }
      await sleep(50)
    }
    return snap ?? { bots: [], why: 'never went off' }
  })
  check(
    'every bot on the board is dead',
    botted.bots.length > 0 && botted.bots.every(Boolean),
    JSON.stringify(botted),
  )
  check(
    'and they are credited to whoever called it',
    botted.kills >= botted.bots.length,
    JSON.stringify(botted),
  )

  // ------------------------------------------ 5. somebody else's nuke kills us

  await page.evaluate((hash) => {
    const g = window.__game
    window.__arena.setLayout(window.__arena.layoutForBlock(hash))
    window.__arena.resetCover()
    g.tank.dead = false
    g.tank.hp = g.maxHp
    g.team = 0
    g.nuke = null
    g.nukeFlashAt = 0
  }, HASH)
  await wait(400)
  const beforeTheirs = await world()
  await page.evaluate((PEER) => {
    const g = window.__game
    g.onEvent({
      id: 'n' + Math.random().toString(16).slice(2),
      pubkey: PEER, kind: 21004, created_at: Math.floor(Date.now() / 1000), tags: [],
      sig: '0'.repeat(128),
      content: JSON.stringify({ k: 'nuke', t0: Date.now() + 600 }),
    }, false)
  }, PEER)
  const theirCountdown = await until(async () => {
    const w = await world()
    return w.nukeIn !== null ? w : null
  }, 4000)
  check("a peer's nuke arms a countdown here too", !!theirCountdown, JSON.stringify(theirCountdown?.nukeIn))
  const killedUs = await until(async () => {
    const w = await world()
    return w.dead ? w : null
  }, 8000)
  check(
    'and it kills us — the victim applies its own death, like every shell',
    !!killedUs && beforeTheirs.dead === false,
    JSON.stringify({ before: beforeTheirs.dead, after: killedUs?.dead }),
  )

  // -------------------------------------- 6. the control: a teammate's does not

  const friendly = await page.evaluate(async (PEER) => {
    const g = window.__game
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    window.__arena.resetCover()
    g.tank.dead = false
    g.tank.hp = g.maxHp
    g.nuke = null
    g.nukeFlashAt = 0
    // Same side as the caller. `friendly` is what a strike and an EMP already
    // ask, and the nuke has to ask it too or a team reward is a team wipe.
    g.team = 1
    const peer = g.ensurePeer(PEER)
    peer.view.team = 1
    g.onEvent({
      id: 'f' + Math.random().toString(16).slice(2),
      pubkey: PEER, kind: 21004, created_at: Math.floor(Date.now() / 1000), tags: [],
      sig: '0'.repeat(128),
      content: JSON.stringify({ k: 'nuke', t0: Date.now() + 500 }),
    }, false)
    await sleep(2600)
    return { dead: !!g.tank.dead, hp: g.tank.hp, cover: window.__arena.coverBits() }
  }, PEER)
  check(
    "a teammate's nuke spares us, and still levels the board",
    friendly.dead === false && friendly.cover !== 0,
    JSON.stringify(friendly),
  )

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))

  if (process.env.TANK_SHOT) {
    await page.evaluate(() => {
      const g = window.__game
      g.tank.dead = false
      g.team = 0
      g.nuke = null
      g.spend && g.setLoadout(['strike', 'chopper', 'jugger', 'nuke'])
      g.streak = 24
      g.earned = [25]
      g.spend(25)
    })
    await wait(3600)
    await page.screenshot({ path: process.env.TANK_SHOT })
    console.log(`      wrote ${process.env.TANK_SHOT}`)
  }
} catch (err) {
  check('the run completed', false, err.message)
} finally {
  await browser.close()
}

console.log('')
if (failures.length) {
  console.error(`${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('All nuke checks passed.')
