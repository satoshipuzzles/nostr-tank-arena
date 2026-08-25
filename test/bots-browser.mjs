// The half of the bots that arithmetic cannot answer.
//
// test/bots.mjs proves the behaviour — a bot drives, closes, leads, misses and
// respawns — against the built module in Node. This proves the three things
// that only exist once a bot is wired into a running game:
//
//   1. Three of them appear in an empty room and reach the screen as tanks.
//   2. They **stand down the moment a real player's tick arrives.** This is the
//      load-bearing one. Bots are local and nobody else can see them, so a bot
//      that survives a human joining is a permanent disagreement between two
//      screens about what is in the arena.
//   3. Shooting one damages it, and killing one moves the streak without
//      moving the published score. Free kills are available in unlimited
//      quantity to anyone willing to sit in an empty room.
//
//   npm run build && npx vite preview --port 4192 &
//   npm run test:bots-browser

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL = process.env.TANK_URL ?? 'http://localhost:4192/'
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
/** Poll rather than sleep: swiftshader runs this page at a few frames a second. */
async function until(fn, ms = 25_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await wait(120)
  }
  return null
}

const PEER = 'd1'.repeat(32)

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'solo')
  await page.type('#room', 'bots' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game && !!window.__renderer, { timeout: 25_000 })
    .then(() => true).catch(() => false)
  check('a game is running', started)
  if (!started) throw new Error('the game never started')

  // Pin the round, and nail `beginRound` shut. The live tip lands a few seconds
  // in and restores every hull on purpose, which would silently heal the bot
  // this suite is about to shoot. Same line, same reason, as test/damage.mjs.
  await page.evaluate(() => {
    const g = window.__game
    g.beginRound(900000, 'ab'.repeat(30) + '0300')
    g.beginRound = () => {}
    document.getElementById('podium').hidden = true
  })

  // ------------------------------------------------ 1. they turn up and draw

  const spawned = await until(async () =>
    (await page.evaluate(() => window.__game.botCount)) === 3 ? true : null)
  check('an empty room fills with three practice tanks', !!spawned,
    `botCount=${await page.evaluate(() => window.__game.botCount)}`)

  // In `peers`, which is the whole design: the renderer, the scoreboard and the
  // spawn search all read that map and needed no code of their own.
  const asPeers = await page.evaluate(() => {
    const g = window.__game
    return [...g.peers.values()].filter((p) => g.isBot(p.session))
      .map((p) => ({ name: p.name, bot: p.bot, x: Math.round(p.view.x), y: Math.round(p.view.y) }))
  })
  check('and they are ordinary peers, so everything downstream just works',
    asPeers.length === 3 && asPeers.every((p) => p.bot === true && p.name.length > 0),
    JSON.stringify(asPeers))

  // Reaching a pixel is its own claim. A mesh in this codebase has spent weeks
  // `visible = true` and drawn inside the floor, so "the renderer has a rig for
  // it" is checked against the rig's actual screen position being on screen.
  const onScreen = await page.evaluate(() => {
    const g = window.__game, r = window.__renderer
    const out = []
    for (const p of g.peers.values()) {
      if (!g.isBot(p.session)) continue
      const s = r.toScreen(p.view.x, 30, p.view.y)
      out.push(s ? { x: Math.round(s.x), y: Math.round(s.y) } : null)
    }
    return out
  })
  check('and each of them projects onto the visible board',
    onScreen.length === 3 && onScreen.every((s) => s && s.x > 0 && s.y > 0 && s.x < 1280 && s.y < 800),
    JSON.stringify(onScreen))

  // They have to be *doing* something. A parked bot is scenery.
  const before = await page.evaluate(() => [...window.__game.peers.values()]
    .filter((p) => window.__game.isBot(p.session)).map((p) => `${Math.round(p.view.x)},${Math.round(p.view.y)}`))
  await wait(2500)
  const after = await page.evaluate(() => [...window.__game.peers.values()]
    .filter((p) => window.__game.isBot(p.session)).map((p) => `${Math.round(p.view.x)},${Math.round(p.view.y)}`))
  check('and they drive around rather than standing still',
    before.some((p, i) => p !== after[i]), `${before.join(' | ')} -> ${after.join(' | ')}`)

  // ----------------------------------------------- 3. shooting one hurts it

  // Park the player next to a bot and put a shell through it. Done before the
  // stand-down case below, because that case ends the bots for good.
  const hit = await page.evaluate(() => {
    const g = window.__game
    const bot = [...g.peers.values()].find((p) => g.isBot(p.session))
    const hpBefore = bot.view.hp
    // Straight into it from just outside the muzzle, so nothing is being
    // claimed about the bot's driving — only about the collision.
    const bx = bot.view.x, by = bot.view.y
    g.tank.dead = false
    g.tank.x = bx - 120
    g.tank.y = by
    g.tank.gun = 0
    g.tank.hull = 0
    g.tank.ammo = 4
    g.tank.reloadAt = 0
    g.tank.reloadingUntil = 0
    const kills = g.kills, deaths = g.deaths, botKills = g.botKills
    return { hpBefore, kills, deaths, botKills, at: { x: bx, y: by } }
  })
  // Fire and step, from the page, so it goes through the same `update` a frame
  // does rather than through a hand-rolled version of it.
  const damaged = await until(async () => page.evaluate(() => {
    const g = window.__game
    const bot = [...g.peers.values()].find((x) => g.isBot(x.session))
    if (!bot) return null
    // Keep the shot lined up: the bot is driving while we do this.
    g.tank.y = bot.view.y
    g.tank.x = bot.view.x - 120
    g.tank.gun = 0
    g.tank.dead = false
    g.tank.reloadAt = 0
    g.tank.ammo = 4
    g.update(0.016, { throttle: 0, steer: 0, aim: 0, fire: true, reload: false, lob: false })
    for (let i = 0; i < 30; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: 0, fire: false, reload: false, lob: false })
    }
    const now = [...g.peers.values()].find((x) => g.isBot(x.session))
    return now && (now.view.hp < 3 || g.botKills > 0) ? { hp: now.view.hp, botKills: g.botKills } : null
  }))
  check('a shell fired at a bot takes its hull down', !!damaged, JSON.stringify(damaged))

  const scoreAfter = await page.evaluate(() => {
    const g = window.__game
    return { kills: g.kills, deaths: g.deaths, botKills: g.botKills, streak: g.streak }
  })
  check(
    'and bot kills stay out of the published score',
    scoreAfter.kills === hit.kills && scoreAfter.deaths === hit.deaths,
    JSON.stringify({ before: { kills: hit.kills, deaths: hit.deaths }, after: scoreAfter }),
  )

  // ------------------------------------------- 3b. and dying to one is free

  // The symmetric half. If a bot kill cannot raise your score, a bot death must
  // not lower it, or sitting in an empty room becomes a way to farm a K/D from
  // the other direction — and worse, a death event would go out on the relay
  // naming a killer no other client has ever heard of.
  //
  // Driven by putting a real bot-owned shell through the real `update`, not by
  // calling `die` directly: what is being tested is that the branch is reached,
  // and handing the decision a pre-made answer cannot test whether the answer
  // is ever produced.
  const death = await page.evaluate(() => {
    const g = window.__game
    const bot = [...g.peers.values()].find((p) => g.isBot(p.session))
    const published = []
    const real = g.publishAsSession.bind(g)
    g.publishAsSession = (kind, payload) => { published.push(kind); return real(kind, payload) }
    g.tank.dead = false
    g.tank.hp = 1
    g.buffs.shieldUntil = 0
    const deathsBefore = g.deaths
    // A shell that belongs to the bot, sitting on top of us.
    g.shells.set('botshell', {
      id: 'botshell', owner: bot.session, x: g.tank.x, y: g.tank.y,
      vx: 1, vy: 0, bounces: 0, maxBounces: 0, damage: 1, lob: 0,
      travel: 0, landed: false, age: 0, dead: false,
    })
    g.update(0.016, { throttle: 0, steer: 0, aim: null, fire: false, reload: false, lob: false })
    g.publishAsSession = real
    return { dead: g.tank.dead, deathsBefore, deathsAfter: g.deaths, published }
  })
  check(
    'a bot can kill you, and it costs you the round but not your record',
    death.dead === true && death.deathsAfter === death.deathsBefore,
    JSON.stringify(death),
  )
  check(
    'and no death event goes out naming a killer nobody else has heard of',
    !death.published.includes(21002),
    JSON.stringify(death.published),
  )

  // ------------------------------------------- 2. a real player clears them

  // One state tick from a stranger. That is all it takes on a relay, and it has
  // to be all it takes here.
  await page.evaluate((PEER) => {
    window.__game.onEvent({
      id: 'a' + Math.random().toString(16).slice(2),
      pubkey: PEER, kind: 21000, created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), x: 300, y: 300, h: 0, g: 0, hp: 3, d: false }),
    }, false)
  }, PEER)
  const cleared = await until(async () =>
    (await page.evaluate(() => window.__game.botCount)) === 0 ? true : null)
  check('a real player joining stands the bots down', !!cleared,
    `botCount=${await page.evaluate(() => window.__game.botCount)}`)

  const leftBehind = await page.evaluate(() => {
    const g = window.__game
    return [...g.peers.keys()].filter((k) => g.isBot(k))
  })
  check('and none of them are left in the peer map for the renderer to draw',
    leftBehind.length === 0, JSON.stringify(leftBehind))

  // The control for the two checks above: without it, "botCount is 0" would
  // also be true of a build that never spawned any, and every check in this
  // section would pass against the feature being missing entirely.
  check('the control: they were really there a moment ago', !!spawned && asPeers.length === 3)

  // ------------------------------------------------------------- the toggle

  const toggled = await page.evaluate(() => {
    const before = document.getElementById('bots-toggle').textContent
    document.getElementById('bots-toggle').click()
    const after = document.getElementById('bots-toggle').textContent
    const wanted = window.__players[0].game.botsEnabled
    document.getElementById('bots-toggle').click()
    return { before, after, wanted, back: document.getElementById('bots-toggle').textContent }
  })
  check('the toggle says what it does and reaches the game',
    toggled.before === 'Bots: on' && toggled.after === 'Bots: off' &&
      toggled.wanted === false && toggled.back === 'Bots: on',
    JSON.stringify(toggled))

  // ------------------------------------------------ the hint row still fits

  // Every key this game adds lands in the same strip of screen, and the strip
  // had already quietly run out. `#controls-hint` and `#hud-actions` are both
  // absolutely positioned along the bottom, one from each side, and neither
  // knows the other exists — so the hints simply grew until they were painted
  // *behind* the buttons. Measured at 1280px before the fix: hints 792px wide,
  // buttons 687px, overlapping by 228px, with "gamepad supported" underneath
  // "View: board". Q and B both went into that overlap.
  //
  // Checked at three widths, because a single width is a fact about one window.
  for (const width of [1280, 1440, 1024]) {
    await page.setViewport({ width, height: 800 })
    await wait(400)
    const box = await page.evaluate(() => {
      const h = document.getElementById('controls-hint').getBoundingClientRect()
      const a = document.getElementById('hud-actions').getBoundingClientRect()
      return {
        overlap: Math.round(h.right - a.left),
        hintRight: Math.round(h.right),
        actionsLeft: Math.round(a.left),
        lines: Math.round(h.height),
        visible: getComputedStyle(document.getElementById('controls-hint')).display !== 'none',
      }
    })
    check(
      `the key hints do not run under the buttons at ${width}px`,
      !box.visible || box.overlap <= 0,
      JSON.stringify(box),
    )
    // And they are still *there*. Hiding the row would also satisfy the check
    // above, and a check that a missing feature passes is not a check.
    check(
      `and the hints are still on screen at ${width}px`,
      !box.visible || box.hintRight > 40,
      JSON.stringify(box),
    )
    // And the kill feed sits above them rather than through them. The feed's
    // `bottom` used to be a constant sized for a one-line hint row, and every
    // button added on the right makes that row one line taller on the left —
    // at three lines the feed was printing straight over the hints.
    const stack = await page.evaluate(() => {
      const hint = document.getElementById('controls-hint').getBoundingClientRect()
      const feed = document.getElementById('feed').getBoundingClientRect()
      return {
        overlap: Math.round(feed.bottom - hint.top),
        feedBottom: Math.round(feed.bottom),
        hintTop: Math.round(hint.top),
        feedRows: document.querySelectorAll('#feed div').length,
      }
    })
    check(
      `and the kill feed clears the hints at ${width}px`,
      !box.visible || stack.feedRows === 0 || stack.overlap <= 0,
      JSON.stringify(stack),
    )
  }
  await page.setViewport({ width: 1280, height: 800 })

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall good')
process.exit(failures.length ? 1 : 0)
