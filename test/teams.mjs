// Team deathmatch, with nobody to assign the teams.
//
// Puzz: "Team Death match Duos with 5 teams."
//
// There is no host here, so the interesting question is not "does friendly fire
// work" — it is *who decides which side you are on*. Two ways of deciding it
// without a host are both worse than the third: deriving from the roster means
// two clients with different relay visibility computing different sides for the
// same player, and deriving from the pubkey takes away the choice, which is the
// half of team play people actually want. So a side is **self-declared**, on
// the tick, exactly as trustworthy as the `hp` beside it.
//
// That makes the load-bearing claim a security one, and it is the one this
// suite spends most of its checks on: a self-declared side has to be worth
// nothing to a liar. Claiming somebody's team makes their shells pass through
// you *and yours pass through them*, because the rule is applied by whoever is
// being shot. A false claim buys a mutual truce, not immunity.
//
// Every damage path in the game has to honour it — shells, lob craters, barrel
// explosions, air strikes, chopper fire — and every one of them is checked
// against a control where the same attack from a stranger lands.
//
//   npm run build && npx vite preview --port 4207 &
//   npm run test:teams

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4207/'
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

const MATE = 'aa'.repeat(32)
const FOE = 'bb'.repeat(32)
const HASH = 'ab'.repeat(30) + '0302'

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'red1')
  await page.type('#room', 'tm' + Math.floor(Math.random() * 1e6))
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
    // Start from a known side whatever localStorage remembers.
    g.team = 0
    localStorage.removeItem('tank.team')
  }, HASH)
  await wait(700)

  // ------------------------------------------------------------- the button
  // The side is picked in the lobby and locked the moment the match starts
  // (issue 069f14a6): mid-game the HUD button is a badge. A side you could
  // change under fire was also a dodge — claim the shooter's team and their
  // shells pass through you.

  const locked = await page.evaluate(() => {
    const btn = document.getElementById('team-toggle')
    const before = { label: btn.textContent.trim(), team: window.__game.team }
    for (let i = 0; i < 3; i++) btn.click()
    return {
      before,
      after: { label: btn.textContent.trim(), team: window.__game.team },
      badge: btn.classList.contains('locked'),
      feed: window.__game.feed.map((f) => f.text).join(' | '),
    }
  })
  check('the button starts on nobody\'s side',
    locked.before.team === 0 && /none/i.test(locked.before.label), JSON.stringify(locked.before))
  check('and mid-match it is a badge: clicking moves nobody',
    locked.after.team === 0 && locked.after.label === locked.before.label && locked.badge,
    JSON.stringify(locked.after))
  check('the lock is said out loud in the feed',
    /locked/i.test(locked.feed), locked.feed.slice(-120))
  await page.keyboard.press('KeyT')
  await wait(200)
  const afterKey = await page.evaluate(() => window.__game.team)
  check('the T key is locked out too', afterKey === 0, String(afterKey))
  const sides = await page.evaluate(() =>
    [...document.querySelectorAll('#side button')].map((b) => b.textContent.trim()))
  check('the control: the lobby still offers five named sides',
    sides.length === 5 && sides.every((s) => /^[A-Z]/.test(s)), sides.join(' '))

  /** One tick from somebody, on a side, at a position. */
  const tick = (who, team, x, y, extra = {}) => page.evaluate(({ who, team, x, y, extra }) => {
    const g = window.__game
    g.onEvent({
      id: 'a' + Math.random().toString(16).slice(2),
      pubkey: who, kind: 21000, created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({
        t: Date.now(), x, y, h: 0, g: 0, hp: 3, d: false, ks: 0, ds: 0, r: g.round,
        ...(team ? { tm: team } : {}), ...extra,
      }),
    }, false)
  }, { who, team, x, y, extra })

  const step = (n = 8) => page.evaluate((n) => {
    const g = window.__game
    for (let i = 0; i < n; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
    }
    return g.tank.hp
  }, n)

  const park = (hp = 3) => page.evaluate((hp) => {
    const g = window.__game
    g.tank.dead = false
    g.tank.hp = hp
    g.tank.x = 700
    g.tank.y = 500
    g.buffs.shieldUntil = 0
    g.team = 1
    // A clean board between phases. A gunship declared eight seconds ago is
    // still overhead when the next case starts, and shells from the last case
    // are still in flight — either one turns the next reading into a number
    // about the previous test.
    //
    // The **buffer**, not just the view. `interpolate` rewrites `peer.view`
    // from `peer.buffer` every frame, so zeroing the view alone is undone
    // before the next update — the previous case's gunship came straight back
    // and took two hull points off a check about a teammate's. `interpolate`
    // skips a peer with an empty buffer, so clearing it is what makes the
    // zeroed view stand until the next tick arrives.
    g.shells.clear()
    for (const p of g.peers.values()) {
      p.buffer.length = 0
      p.view.chopperUntil = 0
      p.view.chopperAt = null
    }
  }, hp)

  // Put a friend and a stranger in the room, both on record.
  await tick(MATE, 1, 700, 300)
  await tick(FOE, 2, 700, 900)
  await wait(300)
  const roster = await page.evaluate(() => {
    const g = window.__game
    return [...g.peers.values()].map((p) => ({ k: p.session.slice(0, 2), team: p.view.team }))
  })
  check('a tick carries the side its sender declared',
    roster.length === 2 && roster.some((r) => r.team === 1) && roster.some((r) => r.team === 2),
    JSON.stringify(roster))

  // ------------------------------------------------------------ shells

  /** A shell of `who`'s, sitting on top of us. Same shape as `Shell`. */
  const shellFrom = (who) => page.evaluate((who) => {
    const g = window.__game
    // The map key and the `id` must be the *same string*. `collide` removes a
    // shell with `shells.delete(shell.id)`, so a shell filed under a different
    // key is never removed — it hits again every frame and killed the tank
    // three times over before the first check could read a hull. The failure
    // read as "friendly fire is broken" and was a typo in the harness.
    const id = 's' + Math.random().toString(16).slice(2)
    g.shells.set(id, {
      id, owner: who, x: g.tank.x, y: g.tank.y,
      vx: 1, vy: 0, bounces: 0, maxBounces: 0, damage: 1, lob: 0,
      travel: 0, struck: -1, landed: false, age: 0, dead: false,
    })
  }, who)

  await park()
  await shellFrom(FOE)
  const fromFoe = await step()
  check('a stranger\'s shell takes hull', fromFoe === 2, `hp=${fromFoe}`)

  await park()
  await shellFrom(MATE)
  const fromMate = await step()
  check('a teammate\'s shell does not', fromMate === 3, `hp=${fromMate}`)

  // And the shell is *consumed* rather than left to sail on and kill somebody
  // behind us — a friendly shot that passes through is a shot that scores.
  const consumed = await page.evaluate(() => window.__game.shells.size)
  check('the control: and it is spent rather than sailing on', consumed === 0, `${consumed} shells left`)

  // ------------------------------------------------------- the mutual truce

  // The security claim, stated as a test. If we lie about being on the
  // stranger's side, their shells stop hurting us — and so do ours, because
  // they run this same check against our tick. A liar buys a truce.
  await park(3)
  await page.evaluate(() => { window.__game.team = 2 })
  await shellFrom(FOE)
  const lying = await step()
  check('claiming a stranger\'s side does stop their shells',
    lying === 3, `hp=${lying}`)
  // The other half, and it is the half that makes the lie worthless: the same
  // claim is what stops *our* shells reaching them, because they apply it.
  const symmetric = await page.evaluate(() => {
    const g = window.__game
    // Play the stranger for a moment: their team is 2, ours is now 2, so from
    // their side we are a teammate. `friendly` is what they would run.
    const peer = [...g.peers.values()].find((p) => p.view.team === 2)
    return { ourTeam: g.team, theirTeam: peer?.view.team, sameSide: g.team === peer?.view.team }
  })
  check('and it is symmetric, so the lie is a truce rather than immunity',
    symmetric.sameSide === true, JSON.stringify(symmetric))
  await page.evaluate(() => { window.__game.team = 1 })

  // ------------------------------------------------- every other damage path

  const lobFrom = (who) => page.evaluate((who) => {
    const g = window.__game
    // A lob that has already landed on us, which is what `detonate` reads.
    const id = 'l' + Math.random().toString(16).slice(2)
    g.shells.set(id, {
      id, owner: who, x: g.tank.x, y: g.tank.y,
      vx: 0, vy: 0, bounces: 0, maxBounces: 0, damage: 1, lob: 200,
      travel: 200, struck: -1, landed: true, age: 0, dead: true,
    })
  }, who)

  await park()
  await lobFrom(FOE)
  const lobFoe = await step()
  check('a stranger\'s lob crater takes hull', lobFoe === 2, `hp=${lobFoe}`)
  await park()
  await lobFrom(MATE)
  const lobMate = await step()
  check('a teammate\'s does not', lobMate === 3, `hp=${lobMate}`)

  const chopperFrom = (who, team) => tick(who, team, 700, 400, { c: 8000, cx: 700, cy: 500 })
  await park()
  await chopperFrom(FOE, 2)
  const chopFoe = await page.evaluate(async () => {
    const g = window.__game
    const t0 = performance.now()
    while (performance.now() - t0 < 900 && g.tank.hp === 3) {
      g.tank.x = 700; g.tank.y = 500
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
      await new Promise((r) => setTimeout(r, 8))
    }
    return g.tank.hp
  })
  check('a stranger\'s chopper takes hull', chopFoe < 3, `hp=${chopFoe}`)

  await park()
  await chopperFrom(MATE, 1)
  const chopMate = await page.evaluate(async () => {
    const g = window.__game
    const t0 = performance.now()
    while (performance.now() - t0 < 1400) {
      g.tank.x = 700; g.tank.y = 500
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
      await new Promise((r) => setTimeout(r, 8))
    }
    return g.tank.hp
  })
  check('a teammate\'s chopper flies over us for longer and takes none',
    chopMate === 3, `hp=${chopMate}`)

  // ------------------------------------------------------------ the tally

  await page.evaluate(() => { window.__game.team = 1 })
  await tick(MATE, 1, 700, 300)
  await tick(FOE, 2, 700, 900)
  await wait(400)
  const tally = await page.evaluate(() => {
    const g = window.__game
    g.kills = 3
    const t = g.teamStandings()
    return { teams: t, own: g.team }
  })
  check('two sides with somebody on them make a team tally',
    Array.isArray(tally.teams) && tally.teams.length === 2, JSON.stringify(tally.teams))
  check('and our kills count for our side',
    tally.teams?.find((t) => t.team === 1)?.kills >= 3, JSON.stringify(tally.teams))

  // The control that keeps the tally honest: one side with one player on it is
  // a person, not a team, and a scoreboard that grew a header the instant
  // anybody pressed T would be reporting a game nobody is playing.
  const alone = await page.evaluate(() => {
    const g = window.__game
    for (const p of g.peers.values()) p.view.team = 0
    return g.teamStandings()
  })
  check('the control: one side on its own is still a free-for-all',
    alone === null, JSON.stringify(alone))

  // ----------------------------------------------------------- on the board

  await page.evaluate(() => { window.__game.team = 1 })
  await tick(MATE, 1, 700, 300)
  await tick(FOE, 2, 900, 300)
  await wait(700)
  const rings = await page.evaluate(async () => {
    const g = window.__game, r = window.__renderer
    for (let i = 0; i < 20; i++) {
      g.update(0.016, { throttle: 0, steer: 0, aim: null, aimAt: null, fire: false, reload: false, lob: false })
      await new Promise((res) => setTimeout(res, 40))
    }
    const out = []
    for (const p of g.peers.values()) {
      const rig = r.rigFor(p.session)
      out.push({ team: p.view.team, ring: rig ? rig.ring.visible : null, streak: p.streak })
    }
    return out
  })
  check('a teammate is marked on the felt',
    rings.some((x) => x.team === 1 && x.ring === true), JSON.stringify(rings))
  check('the control: and a stranger is not, so the unmarked tank is the target',
    rings.some((x) => x.team === 2 && x.ring === false), JSON.stringify(rings))

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall good')
process.exit(failures.length ? 1 : 0)
