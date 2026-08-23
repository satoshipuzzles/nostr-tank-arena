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
/** The top of the board's felt, from `render.ts`. Anything flat must be above it. */
const FELT_Y = 2.5
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
  // The game only starts its AudioContext from a click, which puppeteer does
  // make — but a headless Chrome with no output device still refuses unless
  // told not to care. Without this the sound checks can never pass, and would
  // be testing the flag rather than the game.
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
]

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Read the same thing off every page until a condition holds, then hand back
 * the last sample whether it held or not.
 *
 * A fixed `wait()` is a bet that some window contains the behaviour, and a
 * headless renderer runs this whole simulation at roughly a third speed — on a
 * loaded machine the bet stops paying and the suite reports a bug that is not
 * there. A block transition that had simply not landed yet has failed here
 * twice now, and the second time it left the pickup set empty and crashed the
 * run on `spawned[0][…].id`, costing every check downstream of it.
 *
 * `settled` is deliberately the *transition* and not the assertion: wait for
 * the round to move off the value it had, then let the checks say what it moved
 * to. Polling until the assertion itself passes would leave a check that can
 * only ever fail by timeout.
 */
const until = async (pages, read, settled, timeout = 15_000) => {
  const deadline = Date.now() + timeout
  let last = await Promise.all(pages.map((p) => p.evaluate(read)))
  while (!settled(last) && Date.now() < deadline) {
    await wait(150)
    last = await Promise.all(pages.map((p) => p.evaluate(read)))
  }
  return last
}

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

// Separate browsers, not separate tabs: independent localStorage and renderers.
const browsers = [
  await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS }),
  await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS }),
  // The third is the late joiner, launched here and not used until the backfill
  // check — it must arrive *after* a claim has been published, which is the
  // whole point of it.
  await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS }),
  // The fourth runs five minutes fast.
  await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS }),
]

const pageErrors = []

async function join(browser, label, name, skewSeconds = 0) {
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 800 })
  if (skewSeconds) {
    // A wrong wall clock, installed before any page script runs. `Date.now` and
    // `new Date()` both move; `performance.now` deliberately does not, because a
    // machine with a wrong clock still has a working monotonic timer and every
    // animation in the game rides on it.
    await page.evaluateOnNewDocument((ms) => {
      const realNow = Date.now
      Date.now = () => realNow() + ms
      const RealDate = Date
      // eslint-disable-next-line no-global-assign
      Date = class extends RealDate {
        constructor(...args) {
          super(...(args.length ? args : [realNow() + ms]))
        }
        static now() {
          return realNow() + ms
        }
      }
    }, skewSeconds * 1000)
  }
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

/** Everything the checks read off a page, in one shape. Runs in the browser. */
const SNAP = () => {
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
}

const snap = (p) => p.evaluate(SNAP)

try {
  console.log(`room ${ROOM} @ ${URL}`)
  const a = await join(browsers[0], 'A', 'alpha')
  const b = await join(browsers[1], 'B', 'bravo')

  // Discovery: each side has to learn the other exists, and verify the session
  // attestation that binds the tick key to a real npub.
  //
  // Polled, not waited out, for the same reason as everything else in here: six
  // seconds is a bet, and on a machine already running four headless Chromes it
  // is a bet that loses. When it lost, discovery had simply not finished — and
  // every check downstream of it failed too, so one slow join reads as eleven
  // broken features.
  //
  // The condition is that each side has *a verified peer*, which is discovery
  // finishing. What that peer is called, whether there is exactly one of them,
  // and whether the attestation bound it to a real npub are left to the checks.
  const [seenA, seenB] = await until([a, b], SNAP,
    (r) => r.every((x) => x.peers.some((pe) => pe.verified)), 30_000)
  check('A sees bravo', seenA.peers.some((p) => p.name === 'bravo'), JSON.stringify(seenA.peers))
  check('B sees alpha', seenB.peers.some((p) => p.name === 'alpha'), JSON.stringify(seenB.peers))
  check('sessions verified', seenA.peers.every((p) => p.verified) && seenB.peers.every((p) => p.verified))
  check('no ghost peers', seenA.peers.length === 1 && seenB.peers.length === 1)

  // Pin the round before anything is measured.
  //
  // The first tip comes from a real explorer, and the real hash picks the real
  // rules — so without this the duel below runs under Glass Cannon or Ricochet
  // roughly two runs in five, and "bravo died" starts failing for reasons that
  // have nothing to do with the kill path. `0500` is Crossroads and Straight
  // Deathmatch. The point of block-derived rules is that they are a pure
  // function of the hash, which is exactly what makes them pinnable here.
  // Every fake tip here carries a `time`, because that is the production path:
  // the pickup wave is anchored to when the block was *mined*, and a tip
  // without one falls back to absolute unix seconds — shared between clients,
  // but at an arbitrary phase, which would make "is there a pickup right now"
  // a coin flip in this suite.
  await Promise.all([a, b].map((p) => p.evaluate((t) => {
    window.__clock.accept({ height: 999000, hash: 'ef'.repeat(30) + '0500', time: t })
    document.getElementById('podium').hidden = true
  }, Math.floor(Date.now() / 1000))))
  await wait(600)
  const pinned = await Promise.all([a, b].map((p) => p.evaluate(() => ({
    rules: window.__game.modifier.id,
    maxHp: window.__game.maxHp,
  }))))
  check('the round is pinned to standard rules before anything is measured',
    pinned.every((r) => r.rules === 'standard' && r.maxHp === 3), JSON.stringify(pinned))

  // Movement propagates.
  const beforeMove = (await snap(b)).peers[0]
  // Polled, not waited out. Under software rasterisation the simulation runs in
  // slow motion by a factor that varies with the load on the machine, so any
  // fixed duration is a window that eventually stops containing the behaviour —
  // which is the flake I have hit more than any other in this suite.
  await a.keyboard.down('KeyW')
  let moved = 0
  // Everything alpha's feed has ever said, accumulated across the polls.
  //
  // Sampling it once is a race against two separate evictions: entries expire
  // after 6000ms *and* the feed keeps only the last six lines, so a busy round
  // can push a kill out by count before it ages out by time. A line that
  // appeared and then scrolled away still appeared.
  const feedSeen = new Set()
  const soakFeed = async () => {
    for (const line of (await snap(a)).feed) feedSeen.add(line)
  }
  for (let i = 0; i < 14; i++) {
    await wait(700)
    const now = (await snap(b)).peers[0]
    moved = beforeMove && now ? Math.hypot(now.x - beforeMove.x, now.y - beforeMove.y) : 0
    if (moved > 60) break
  }
  await a.keyboard.up('KeyW')
  await wait(600)
  check('B sees A move', moved > 60, `${Math.round(moved)}px`)

  // Duel: park them in a clear lane and put three shells into bravo.
  //
  // Attempts rather than a fixed budget, and generous: under software
  // rasterisation the whole simulation runs in slow motion, so a shell that
  // crosses 220px in a quarter of a second on a GPU can take most of a second
  // here. This is the check most likely to fail for a reason that is not a bug.
  for (let i = 0; i < 14; i++) {
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
    await wait(300)
    await a.keyboard.up('Space')
    await wait(1300)
    await soakFeed()
    await wait(1300)
    await soakFeed()
    if ((await snap(b)).deaths > 0) break
  }
  await soakFeed()
  // Snapshot the feed the moment the death lands, not after the respawn wait.
  //
  // Feed entries expire after 6000ms (`game.ts`), and the poll above can detect
  // the death up to 2600ms after the shot — so reading it 3800ms later put the
  // sample at up to 6400ms and turned a real check into a coin flip. Fizz lost
  // an hour to it hunting a regression that was not there, and found it by
  // running the same probe against the base commit and comparing *rates*: four
  // passes on the branch, three on main.
  const atDeath = { a: await snap(a), b: await snap(b) }
  // RESPAWN_DELAY is 2.5s and the death is detected at the end of a poll, so a
  // 2s wait here was a coin flip on whether bravo was back yet.
  await wait(3800)

  const finalA = await snap(a)
  const finalB = await snap(b)
  check('bravo died', finalB.deaths >= 1, JSON.stringify(atDeath.b.feed))
  check('alpha credited with the kill', finalA.kills >= 1, JSON.stringify(atDeath.a.feed))
  check('kill feed names the killer',
    [...feedSeen].some((t) => t.includes('alpha') && t.includes('bravo')),
    JSON.stringify([...feedSeen]))
  check('bravo respawned at full hp', !finalB.dead && finalB.hp === 3, `hp=${finalB.hp} dead=${finalB.dead}`)

  // -------------------------------------------------------------------- sound
  //
  // Two separate claims, and they fail for different reasons, so they are two
  // checks. First: an AudioContext actually reached `running`. A context built
  // before a user gesture lands in `suspended` and stays there forever, which
  // is silent in every sense — no error, no sound, nothing in the console.
  //
  // Second: the game emits the right event at the right moment. That is tested
  // through the sink rather than by listening, because "did a speaker move" is
  // not answerable from here and is not the part that breaks.
  const audioLive = await Promise.all([a, b].map((p) => p.evaluate(() => window.__sfx?.running === true)))
  check('an AudioContext is actually running, not suspended', audioLive.every(Boolean),
    JSON.stringify(audioLive))

  await Promise.all([a, b].map((p) => p.evaluate(() => {
    const g = window.__game
    window.__heard = []
    const real = g.sfx
    g.sfx = (sound, opts) => {
      window.__heard.push(sound)
      real(sound, opts)
    }
  })))
  // Retried, because a tank that is mid-respawn cannot pull a trigger and the
  // duel above may have just got itself killed. What is being tested is that
  // firing emits, not that a keypress lands on the first attempt.
  let heard = [[], []]
  for (let i = 0; i < 8; i++) {
    await a.evaluate(() => {
      const g = window.__game
      g.tank.dead = false
      g.tank.hp = g.maxHp
      g.tank.x = 300
      g.tank.y = 600
      g.tank.hull = 0
      g.tank.gun = 0
      g.tank.reloadAt = 0
    })
    await a.keyboard.down('Space')
    await wait(400)
    await a.keyboard.up('Space')
    await wait(1800)
    heard = await Promise.all([a, b].map((p) => p.evaluate(() => window.__heard)))
    if (heard[0].includes('fire') && heard[1].includes('fire')) break
  }
  check('firing makes a noise', heard[0].includes('fire'), JSON.stringify(heard[0]))
  // The interesting half: a shell fired on the other machine has to arrive as a
  // sound here, positioned, or the room is silent except for your own gun.
  check("and the other client hears somebody else's shot", heard[1].includes('fire'),
    JSON.stringify(heard[1]))

  const muted = await a.evaluate(() => {
    document.getElementById('sound-toggle').click()
    const off = window.__sfx.muted
    window.__heard = []
    window.__sfx.play('fire')
    return { off, label: document.getElementById('sound-toggle').textContent }
  })
  check('and the toggle mutes it', muted.off && /off/i.test(muted.label), JSON.stringify(muted))
  await a.evaluate(() => document.getElementById('sound-toggle').click())

  // ------------------------------------------------------------- streak glow
  //
  // A streak used to be a number in your own HUD. It now rides in the state
  // tick, which is the one event already going out ten times a second, so the
  // rest of the room can see who is on a run and gang up on them. Same trust as
  // the HP in the same payload: self-reported, and always was.
  await a.evaluate(() => { window.__game.streak = 4 })
  await wait(1600)
  const glow = await b.evaluate(() => {
    const g = window.__game
    const peer = [...g.peers.values()].find((p) => p.name === 'alpha')
    const rig = window.__renderer?.rigs?.get(peer?.session)
    return { streak: peer?.streak ?? 0, ring: rig ? rig.ring.visible : null }
  })
  // Compared against alpha's own number rather than the literal 4: alpha can
  // land another kill in the 1.6 seconds this waits, and a check that breaks
  // when the game works is worse than no check.
  const alphaStreak = await a.evaluate(() => window.__game.streak)
  check("a rival's streak reaches the other client",
    glow.streak === alphaStreak && alphaStreak >= 4,
    `${JSON.stringify(glow)} vs alpha ${alphaStreak}`)
  check('and lights their ring up on this screen', glow.ring === true, JSON.stringify(glow))

  // `visible === true` is not the same as "reaches a pixel", and this exact
  // pair of meshes proved it: the ring under your tank sat at y=1.2 and every
  // pickup pad at y=1.5, while the board's felt is at y=2.5. Both were drawn
  // every frame, inside the board, for weeks. A screenshot found it; nothing
  // structural could have. So the invariant is asserted directly, against the
  // live mesh positions rather than against the constant they are set from.
  const ringY = await a.evaluate(() => window.__renderer.you.ring.position.y)
  check('the ring under your tank is drawn on the board, not inside it',
    ringY > FELT_Y, `ring y=${ringY}, felt y=${FELT_Y}`)
  await a.evaluate(() => { window.__game.streak = 0 })
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
  // proves the map is a pure function of the tip rather than a broadcast. The
  // two hex digits before those pick the round's rule change, independently —
  // `ab` is 171, and 171 % 5 lands on Glass Cannon.
  const HEIGHT = 999001
  await Promise.all([a, b].map((p) => p.evaluate(([h, t]) => {
    window.__clock.accept({ height: h, hash: 'ab'.repeat(31) + '03', time: t })
  }, [HEIGHT, Math.floor(Date.now() / 1000)])))

  const afterBlock = await until([a, b], () => ({
    kills: window.__game.kills,
    deaths: window.__game.deaths,
    round: window.__game.round,
    podium: !document.getElementById('podium').hidden,
    shown: getComputedStyle(document.getElementById('podium')).display !== 'none',
    map: document.getElementById('hud-map')?.textContent ?? '',
    rules: window.__game.modifier.id,
    maxHp: window.__game.maxHp,
    hp: window.__game.tank.hp,
    dead: window.__game.tank.dead,
    chip: document.getElementById('rules').hidden
      ? ''
      : document.getElementById('rules').textContent.replace(/\s+/g, ' ').trim(),
    rows: document.getElementById('podium-rows').textContent.replace(/\s+/g, ' ').trim(),
    // Settle on the model *and* the view: `drawHud` throttles to 120ms, so a
    // round that has changed under a HUD that has not repainted yet would have
    // the next checks reading the previous block's map off the screen.
  }), (r) => r.every((x) => x.round === HEIGHT && x.map && x.map !== beforeBlock[0].map))
  check('a block ends the round on both clients',
    afterBlock.every((r) => r.round === HEIGHT), JSON.stringify(afterBlock.map((r) => r.round)))
  check('and resets the scores', afterBlock.every((r) => r.kills === 0 && r.deaths === 0),
    JSON.stringify(afterBlock.map((r) => `${r.kills}/${r.deaths}`)))
  check('and both land on the same map, without telling each other',
    afterBlock[0].map === afterBlock[1].map && afterBlock[0].map === 'The Ring',
    afterBlock.map((r) => r.map).join(' vs '))
  // The rules come out of the same number as the map and are not sent anywhere,
  // so two clients agreeing on them is the same proof as two clients agreeing
  // on the board.
  check('the block picked the round rules too, and both clients picked the same ones',
    afterBlock[0].rules === afterBlock[1].rules && afterBlock[0].rules === 'glass',
    afterBlock.map((r) => r.rules).join(' vs '))
  // A tank caught mid-respawn sits at 0, which is not a failure of the rule.
  check('and Glass Cannon actually narrowed the hull to one hit',
    afterBlock.every((r) => r.maxHp === 1 && (r.dead || r.hp === 1)),
    JSON.stringify(afterBlock.map((r) => [r.maxHp, r.hp, r.dead])))
  check('and the HUD says which rules are running', /Glass Cannon/.test(afterBlock[0].chip),
    afterBlock[0].chip)
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

  // A second block, chosen to land on different rules and a different board.
  // `05` is 5, and 5 % 5 is Straight Deathmatch; `01` picks The Lanes. Nothing
  // was sent between the two clients to make either of them agree.
  await Promise.all([a, b].map((p) => p.evaluate(([h, t]) => {
    window.__clock.accept({ height: h, hash: 'cd'.repeat(30) + '0501', time: t })
  }, [HEIGHT + 1, Math.floor(Date.now() / 1000)])))
  const secondBlock = await until([a, b], () => ({
    round: window.__game.round,
    rules: window.__game.modifier.id,
    maxHp: window.__game.maxHp,
    map: document.getElementById('hud-map')?.textContent ?? '',
    chipHidden: document.getElementById('rules').hidden,
    chipDisplay: getComputedStyle(document.getElementById('rules')).display,
  }), (r) => r.every((x) => x.round === HEIGHT + 1 && x.map && x.map !== afterBlock[0].map))
  check('the next block changes the rules again, in step, with nothing on the wire',
    secondBlock.every((r) => r.rules === 'standard' && r.maxHp === 3) &&
      secondBlock[0].map === secondBlock[1].map && secondBlock[0].map === 'The Lanes',
    JSON.stringify(secondBlock))
  // Straight Deathmatch is the default and gets no billboard — and `hidden`
  // alone would not have removed it, since #rules is display:grid.
  check('and a standard round shows no rules chip at all',
    secondBlock.every((r) => r.chipHidden && r.chipDisplay === 'none'), JSON.stringify(secondBlock))
  await Promise.all([a, b].map((p) => p.evaluate(() => { document.getElementById('podium').hidden = true })))

  // ------------------------------------------------------------------ pickups
  //
  // Nothing about a pickup is sent: its pad, its type and its wave are derived
  // from the block hash both clients already have. The only thing on the wire
  // is the claim, and the claim is a *stored* event precisely so a client that
  // connected a moment later still learns the pad is empty.
  const spawned = await until([a, b], () =>
    [...window.__game.pickups.values()].map((x) => ({ id: x.id, kind: x.kind, x: Math.round(x.at.x), y: Math.round(x.at.y) })),
    (r) => r.every((x) => x.length > 0),
  )
  check('pickups appear on the board', spawned[0].length > 0, JSON.stringify(spawned[0]))
  // Same invariant as the tank ring, on the other mesh that had the same bug.
  const padY = await a.evaluate(() => {
    const pad = [...window.__renderer.pickupMeshes.values()][0]?.getObjectByName('pad')
    return pad ? pad.position.y : null
  })
  check('and their pads sit on the board rather than inside it',
    padY !== null && padY > FELT_Y, `pad y=${padY}, felt y=${FELT_Y}`)
  check('and both clients derived the identical set, having sent nothing',
    JSON.stringify(spawned[0]) === JSON.stringify(spawned[1]),
    `${JSON.stringify(spawned[0])} vs ${JSON.stringify(spawned[1])}`)

  // Everything below reaches into that set, and a run where it came back empty
  // died on `.id` and took every remaining check with it — sixty per cent of the
  // suite, reported as one crash. A missing pad is one loud failure and the rest
  // of the run still happens.
  const lastPadId = spawned[0][spawned[0].length - 1]?.id ?? null
  // Stand-in coordinates rather than `null`, so the checks below fail on their
  // own terms — "the pad was not taken" — instead of throwing inside evaluate,
  // which is the crash this is here to prevent.
  const firstPad = spawned[0][0] ?? { id: null, kind: null, x: 0, y: 0 }
  if (!lastPadId) {
    check('a board with pads on it to run the claim checks against', false,
      JSON.stringify(spawned[0]))
  }

  // The late joiner, which is where this used to break every single time.
  //
  // The wave index is inside the pickup id, and it used to be measured from
  // `performance.now()` at the moment *this* client's poll first saw the tip.
  // Someone joining six minutes into a block sat at elapsed≈0 against everyone
  // else's ≈360 — a different wave, so different ids for the same pads, so
  // every claim they sent or received matched nothing and was dropped without a
  // word. They took every pickup on the board and nobody else saw it happen.
  //
  // Simulated by moving one client's local round origin a long way. If the
  // schedule is anchored to the chain, moving it changes nothing at all.
  await b.evaluate(() => { window.__game.roundStartedAt = performance.now() - 400_000 })
  // Give the bug room to appear, counted in frames rather than milliseconds.
  //
  // `refreshPickups` runs once a frame, so the broken version reshuffles the
  // board on the very next one — but a headless renderer under swiftshader runs
  // at a handful of frames a second, and a wall-clock wait short enough to keep
  // the suite quick is not reliably long enough to contain one. Waiting on the
  // frames themselves is the same guarantee without the bet: if the schedule is
  // anchored to the chain it has now had every chance to move and has not.
  await b.evaluate(() => Promise.race([
    new Promise((r) => {
      let n = 0
      const tick = () => (++n >= 5 ? r(n) : requestAnimationFrame(tick))
      requestAnimationFrame(tick)
    }),
    new Promise((r) => setTimeout(() => r(-1), 10_000)),
  ]))
  const skewed = await Promise.all([a, b].map((p) => p.evaluate(() =>
    [...window.__game.pickups.keys()].sort(),
  )))
  check('a client whose local clock started 400s earlier derives the same pads',
    skewed[0].length > 0 && JSON.stringify(skewed[0]) === JSON.stringify(skewed[1]),
    `${JSON.stringify(skewed[0])} vs ${JSON.stringify(skewed[1])}`)

  // The other half of the stored-claim design, and it was missing.
  //
  // Claims were matched only against the pads that happened to exist that
  // frame, so a claim arriving before its pad was derived — which is *always*
  // the case for a late joiner's REQ backfill — was thrown away. The whole
  // reason the claim is a stored event rather than an ephemeral one is that a
  // late joiner can ask for it; dropping it on arrival made that pointless.
  const early = await b.evaluate((id) => {
    const g = window.__game
    // Forget the pad entirely, then hear about the claim. This is the backfill
    // ordering: claim first, schedule second.
    g.pickups.delete(id)
    g.onEvent({
      id: 'early' + Math.random(),
      kind: 30078,
      pubkey: 'ee'.repeat(32),
      created_at: Math.floor(Date.now() / 1000),
      tags: [['d', 'x'], ['t', 'x']],
      content: JSON.stringify({ p: id, kind: 'shield' }),
    })
    return { gone: !g.pickups.has(id), unmatched: g.unmatchedClaims }
  }, lastPadId)
  await wait(900)
  const backfilled = await b.evaluate((id) => {
    const p = window.__game.pickups.get(id)
    return { back: !!p, taken: !!p?.taken }
  }, lastPadId)
  check('a claim that arrives before its pad does is remembered, not dropped',
    early.gone && backfilled.back && backfilled.taken,
    `${JSON.stringify(early)} -> ${JSON.stringify(backfilled)}`)

  // Drive alpha onto one and watch what happens on both sides.
  const target = firstPad
  await a.evaluate((t) => {
    const g = window.__game
    g.tank.dead = false
    g.tank.hp = 1
    g.tank.x = t.x
    g.tank.y = t.y
  }, target)
  await wait(1400)

  const grabbed = await a.evaluate((id) => {
    const g = window.__game
    const p = g.pickups.get(id)
    return {
      taken: !!p?.taken,
      kind: p?.kind,
      hp: g.tank.hp,
      maxHp: g.maxHp,
      buffs: { ...g.buffs },
      notice: g.notice?.text ?? '',
    }
  }, target.id)
  const gotSomething =
    grabbed.kind === 'repair'
      ? grabbed.hp === grabbed.maxHp
      : Object.values(grabbed.buffs).some((v) => v > 0)
  check('driving over one takes it', grabbed.taken, JSON.stringify(grabbed))
  check(`and ${target.kind} actually does something`, gotSomething, JSON.stringify(grabbed))
  check('and it is announced on the banner, not just in the feed', !!grabbed.notice, grabbed.notice)

  // The claim travelling is the only networked part of the whole mechanism.
  const seen = await b.evaluate((id) => {
    const p = window.__game.pickups.get(id)
    return { taken: !!p?.taken, feed: window.__game.feed.map((f) => f.text) }
  }, target.id)
  check('and the other client sees that pad go empty', seen.taken,
    JSON.stringify(seen.feed.slice(-3)))

  // A fresh board with every pad stocked, because the checks below consume one
  // pad each and a standard round leaves one deliberately empty. `03` is Supply
  // Run, `01` is The Lanes — four pads, none skipped.
  await Promise.all([a, b].map((p) => p.evaluate(([h, t]) => {
    window.__clock.accept({ height: h, hash: 'ab'.repeat(30) + '0301', time: t })
    document.getElementById('podium').hidden = true
  }, [HEIGHT + 2, Math.floor(Date.now() / 1000)])))
  await wait(1500)
  const stocked = await a.evaluate(() => window.__game.pickups.size)
  check('a stocked board for the rollback checks', stocked >= 4, `${stocked} pads`)

  // ------------------------------------------------ a claim nobody accepted
  //
  // The claim is the one thing this game publishes exactly once, so it is the
  // one thing with nothing to self-heal it — and `sweepPickups` marks the pad
  // taken *before* publishing, because grabbing an item cannot stall for a round
  // trip. So a claim nobody accepted leaves this client alone in believing that
  // pad is gone, while every remote player still sees it live.
  //
  // Rolled back only on a unanimous refusal. Silence must not roll anything
  // back: the event may well have landed, and putting the pad back would be
  // inventing a divergence rather than repairing one. Both directions are
  // checked, because only asserting the first would pass against a rollback
  // that fires on everything.
  const forceOutcome = (outcome) =>
    a.evaluate((o) => {
      const g = window.__game
      if (!window.__realPublish) window.__realPublish = g.net.publish.bind(g.net)
      g.net.publish = (e) => {
        const p = window.__realPublish(e)
        // Only the claim is forced; the tick stream must keep behaving normally
        // or the rest of the match stops working underneath the check.
        return e.kind === 30078 && e.tags.some((t) => t[0] === 'expiration')
          ? Promise.resolve(o)
          : p
      }
    }, outcome)

  // Polled, because a wave clears the board for a stretch between spawns and
  // "no pad right now" is not the same as "no pad available". A fixed attempt
  // reads the gap as a broken board.
  const refusals = () => a.evaluate(() => window.__game.refusedClaims)
  // Counted as a delta, never as a total. `grabAnother` polls across wave
  // boundaries, and a tank parked on a pad while a new wave spawns one under it
  // sweeps that too — so the absolute tally drifts for reasons that have nothing
  // to do with the pad under test.
  const grabAnother = async () => {
    for (let i = 0; i < 14; i++) {
      const id = await a.evaluate(() => {
        const g = window.__game
        // Skip anything already consumed-but-unannounced: a pad restored by the
        // rollback is live for the room and not for us, so parking on it again
        // publishes nothing and the next check would measure the wrong pad.
        const next = [...g.pickups.values()].find((p) => !p.taken && !g.spent.has(p.id))
        if (!next) return null
        g.tank.dead = false
        g.tank.hp = g.maxHp
        g.tank.x = next.at.x
        g.tank.y = next.at.y
        return next.id
      })
      if (id) return id
      await wait(1000)
    }
    return null
  }

  await forceOutcome({
    sent: 4, accepted: 0, refused: 4, malformed: 0, unclear: 0,
    unanimouslyRefused: true, definitelyNowhere: true,
    reason: 'blocked: not accepted here',
  })
  const beforeRefused = await refusals()
  const refusedId = await grabAnother()
  await wait(1600)
  const rolled = refusedId
    ? await a.evaluate((id) => {
        const g = window.__game
        const p = g.pickups.get(id)
        return {
          back: !!p && !p.taken,
          refusedClaims: g.refusedClaims,
          keptSomething: Object.values(g.buffs).some((v) => v > performance.now()) || g.tank.hp === g.maxHp,
          feed: g.feed.map((f) => f.text).slice(-2),
        }
      }, refusedId)
    : null
  check('a claim every relay refused puts the pad back',
    !!rolled && rolled.back && rolled.refusedClaims > beforeRefused, JSON.stringify(rolled))
  // Nobody outside this client ever saw the grab, so nothing out there disagrees
  // about the effect — and a game that confiscates a shield for a network reason
  // feels broken in a way leaving it does not.
  check('and does not confiscate what the player already picked up',
    !!rolled && rolled.keptSomething, JSON.stringify(rolled))
  check('and says so rather than silently reshuffling the board',
    !!rolled && rolled.feed.some((t) => t.includes('claim refused')), JSON.stringify(rolled))

  await forceOutcome({
    sent: 4, accepted: 0, refused: 0, malformed: 0, unclear: 4,
    unanimouslyRefused: false, definitelyNowhere: false, reason: null,
  })
  const beforeSilent = await refusals()
  const silentId = await grabAnother()
  await wait(1600)
  const held = silentId
    ? await a.evaluate((id) => {
        const g = window.__game
        return { stillTaken: !!g.pickups.get(id)?.taken, refusedClaims: g.refusedClaims }
      }, silentId)
    : null
  check('a claim nobody answered is left alone, because it may well have landed',
    !!held && held.stillTaken && held.refusedClaims === beforeSilent,
    `${JSON.stringify(held)} was ${beforeSilent}`)

  // The case the rollback exists for, and the one it used to miss.
  //
  // `invalid:` is a *stronger* verdict than a policy refusal, not a weaker one:
  // the relay rejects it before storage, never forwards it, and a bad event is
  // bad at every relay including the muted ones nobody asked. A clock far enough
  // behind makes every claim expire on arrival — the one total publish failure
  // anybody in this thread has actually observed — and counting only `refused`
  // let it through untouched.
  await forceOutcome({
    sent: 4, accepted: 0, refused: 0, malformed: 4, unclear: 0,
    unanimouslyRefused: false, definitelyNowhere: true,
    reason: 'invalid: event expired',
  })
  const beforeExpired = await refusals()
  const expiredId = await grabAnother()
  await wait(1600)
  const expired = expiredId
    ? await a.evaluate((id) => {
        const g = window.__game
        return { back: !!g.pickups.get(id) && !g.pickups.get(id).taken, refusedClaims: g.refusedClaims }
      }, expiredId)
    : null
  check('a claim every relay called invalid puts the pad back too',
    !!expired && expired.back && expired.refusedClaims > beforeExpired,
    `${JSON.stringify(expired)} was ${beforeExpired}`)

  // Everything muted is also definitively nowhere, and used to answer `false`.
  await forceOutcome({
    sent: 0, accepted: 0, refused: 0, malformed: 0, unclear: 0,
    unanimouslyRefused: false, definitelyNowhere: true, reason: null,
  })
  const beforeMuted = await refusals()
  const mutedId = await grabAnother()
  await wait(1600)
  const noneSent = mutedId
    ? await a.evaluate((id) => {
        const g = window.__game
        return { back: !!g.pickups.get(id) && !g.pickups.get(id).taken, refusedClaims: g.refusedClaims }
      }, mutedId)
    : null
  check('and so is a claim that went to no relay at all',
    !!noneSent && noneSent.back && noneSent.refusedClaims > beforeMuted,
    `${JSON.stringify(noneSent)} was ${beforeMuted}`)

  // ------------------------------------------- the clock that is merely behind
  //
  // The quietest failure in the whole system, and it is quiet *because* it is
  // free. `invalid: event expired` is the NIP-40 gate, so it only fires for an
  // event carrying an `expiration` tag — and exactly one kind here does. A slow
  // clock puts every tick's `created_at` in the past, where the tolerance is 365
  // days rather than fifteen minutes, so the ticks land, ten a second, and each
  // acceptance resets a streak that needs five in a row. `Net`'s alarm can never
  // reach it.
  //
  // What the player gets is a game that looks perfectly normal in which every
  // pickup they take comes straight back, all session, with nothing on screen.
  const expiredOutcome = {
    sent: 4, accepted: 0, refused: 0, malformed: 4, unclear: 0,
    unanimouslyRefused: false, definitelyNowhere: true,
    reason: 'invalid: event expired',
  }
  await forceOutcome(expiredOutcome)
  await grabAnother()
  await wait(1600)
  const afterOne = await a.evaluate(() => window.__game.slowClockAlarm)
  // One is not a pattern. A single expired claim has too many benign readings.
  check('one expired claim is not enough to accuse the clock', afterOne === null,
    JSON.stringify(afterOne))

  await grabAnother()
  await wait(1600)
  const afterTwo = await a.evaluate(() => window.__game.slowClockAlarm)
  check('two relays calling two claims expired, while ticks land, does it',
    afterTwo !== null && afterTwo.behindBySeconds === 600, JSON.stringify(afterTwo))

  // The model has the alarm by now — the check above just read it — but the
  // panel is painted in the frame loop, and a headless renderer gets through a
  // handful of frames a second. Poll for the paint rather than assuming the
  // evaluate above bought enough time for one.
  const [behind] = await until([a], () => {
    const n = document.getElementById('alarm')
    return { display: getComputedStyle(n).display, text: n.textContent.replace(/\s+/g, ' ').trim() }
  }, (r) => r.every((x) => x.display !== 'none' && x.text.length > 0))
  // The quiet regime gets the opposite headline, because the opposite thing is
  // broken: the match is fine and only the pads misbehave.
  check('the quiet failure leads with the pads, not the clock',
    behind.display !== 'none' &&
      /EVERY PICKUP YOU TAKE COMES STRAIGHT BACK/.test(behind.text) &&
      /match is fine/.test(behind.text) &&
      /behind/.test(behind.text) &&
      /10 minutes/.test(behind.text),
    behind.text.slice(0, 190))

  // The control, and the reason this signal is trustworthy at all: the ticks
  // landing prove the relays are reachable and reading our events. Take that
  // away and the same claim verdicts mean "something is broken", which is a
  // different diagnosis and not one to put on a player's screen.
  //
  // Driven through `noteClaimVerdict` with the accepted-count pinned, because
  // the real tick stream is landing throughout this suite — setting the
  // watermark once only suppresses the next claim, and the one after it sees
  // the counter moving again.
  const noControl = await a.evaluate(() => {
    const g = window.__game
    const proto = Object.getPrototypeOf(g)
    const real = Object.getOwnPropertyDescriptor(proto, 'acceptedSoFar')
    Object.defineProperty(proto, 'acceptedSoFar', { configurable: true, get: () => 0 })
    g.expiredClaimStreak = 0
    g.acceptedAtLastClaim = 0
    const expired = {
      sent: 4, accepted: 0, refused: 0, malformed: 4, unclear: 0,
      unanimouslyRefused: false, definitelyNowhere: true,
      reason: 'invalid: event expired',
    }
    for (let i = 0; i < 5; i++) g.noteClaimVerdict(expired)
    const after = g.slowClockAlarm
    if (real) Object.defineProperty(proto, 'acceptedSoFar', real)
    g.expiredClaimStreak = 0
    return after
  })
  check('expired claims with nothing else landing do NOT accuse the clock',
    noControl === null, JSON.stringify(noControl))
  await wait(400)
  const cleared2 = await a.evaluate(() => window.__game.slowClockAlarm)
  check('and it clears once the streak is broken', cleared2 === null, JSON.stringify(cleared2))

  // And an accepted claim ends it, because the evidence is consecutive.
  await a.evaluate(() => {
    window.__game.acceptedAtLastClaim = 0
  })
  await forceOutcome(expiredOutcome)
  await grabAnother()
  await wait(1600)
  await grabAnother()
  await wait(1600)
  const raised = await a.evaluate(() => window.__game.slowClockAlarm !== null)
  await forceOutcome({
    sent: 4, accepted: 4, refused: 0, malformed: 0, unclear: 0,
    unanimouslyRefused: false, definitelyNowhere: false, reason: null,
  })
  await grabAnother()
  await wait(1600)
  const afterGood = await a.evaluate(() => window.__game.slowClockAlarm)
  check('and one accepted claim ends it', raised && afterGood === null,
    `raised ${raised}, then ${JSON.stringify(afterGood)}`)


  // One relay saying it must never be enough, and this goes last because it
  // rewrites the streak state the checks above depend on. A relay disagreeing
  // about the time is the relay — and the same filter bias that let one relay
  // accuse the clock on the fast path applies here, since a relay that only ever
  // answers `invalid:` is exactly the one muting can never remove.
  const single = await a.evaluate(() => {
    const g = window.__game
    g.expiredClaimStreak = 0
    g.acceptedAtLastClaim = 0
    const solo = {
      sent: 1, accepted: 0, refused: 0, malformed: 1, unclear: 0,
      unanimouslyRefused: false, definitelyNowhere: true,
      reason: 'invalid: event expired',
    }
    for (let i = 0; i < 4; i++) g.noteClaimVerdict(solo)
    const after = g.slowClockAlarm
    g.expiredClaimStreak = 0
    return after
  })
  check('one relay calling four claims expired never accuses the clock',
    single === null, JSON.stringify(single))

  await a.evaluate(() => {
    window.__game.net.publish = window.__realPublish
    window.__game.expiredClaimStreak = 0
  })
  await wait(400)

  // ------------------------------------------------------- backfill, for real
  //
  // The check the other two cannot make. A and B were both in the room when the
  // claim went out, so they saw it live; nothing about them exercises the `REQ`
  // that a client joining afterwards depends on. This one arrives late, asks the
  // relay for the round's claims, and has to conclude that pad is gone.
  //
  // It covers three separate failures at once, and every one of them is silent:
  // a `since` window narrower than a pad's life, a `since` computed from a clock
  // the relay does not share, and a claim wiped by the `beginRound` that fires
  // moments after the subscription opens.
  //
  // A fresh block first, mined *now*, so the pads are at the start of their wave
  // — and then the wave is pinned open, because "start of the wave" was never
  // enough. A pad lives twenty seconds; publishing the claim, measuring the
  // NIP-40 headroom and launching a third browser costs more than that on a
  // loaded machine, and when it does the pad rolls to the next wave, both ids
  // change, and a backfill that worked perfectly reports `derived: false`.
  //
  // The wave length is a schedule input, identical on every client by
  // construction, so widening it here changes nothing about what is being
  // measured and removes a stopwatch nobody meant to be running. Same rule as
  // pinning the tip: the environment gets fixed before the behaviour is
  // measured, or the measurement is of the environment.
  const LATE_MINED = Math.floor(Date.now() / 1000)
  const PIN_WAVE = 600
  await Promise.all([a, b].map((p) => p.evaluate(([h, t, w]) => {
    // After `accept`, not before: the tip starts the round, and starting a round
    // reads the modifier back off the block hash. Overriding first would be
    // overwritten a line later and the pin would silently do nothing.
    window.__clock.accept({ height: h, hash: 'da'.repeat(30) + '0500', time: t })
    window.__realWave = window.__game.modifier.waveSeconds
    window.__game.modifier = { ...window.__game.modifier, waveSeconds: w }
    document.getElementById('podium').hidden = true
  }, [HEIGHT + 3, LATE_MINED, PIN_WAVE])))
  await wait(1500)

  const fresh = await a.evaluate(() =>
    [...window.__game.pickups.values()].map((p) => ({ id: p.id, x: Math.round(p.at.x), y: Math.round(p.at.y) })))
  check('a fresh block puts pads back on the board', fresh.length > 0, JSON.stringify(fresh))
  const lateTarget = fresh[0]

  await a.evaluate((t) => {
    const g = window.__game
    g.tank.dead = false
    g.tank.hp = g.maxHp
    g.tank.x = t.x
    g.tank.y = t.y
  }, lateTarget)
  await wait(1500)
  const claimedByA = await a.evaluate((id) => !!window.__game.pickups.get(id)?.taken, lateTarget.id)
  check('alpha takes it and publishes the claim', claimedByA, lateTarget.id)

  // NIP-40 is evaluated against the *relay's* clock, so the expiration is really
  // headroom against the gap between our clock and theirs — and it has to be a
  // fixed offset from `created_at` rather than a second reading of `Date.now()`
  // straddling the signature. A pad lives 32 seconds; a client two minutes slow
  // used to have every claim refused on arrival, forever.
  const ttl = await a.evaluate(() => {
    const g = window.__game
    const real = g.net.publish.bind(g.net)
    let seen = null
    // Returns the real promise — `publishClaim` waits on it now, and a wrapper
    // that swallows the return value makes it throw on `undefined.then`.
    g.net.publish = (e) => {
      if (e.kind === 30078 && e.tags.some((t) => t[0] === 'expiration')) seen = e
      return real(e)
    }
    // Take another pad so a fresh claim goes out under the wrapper.
    const next = [...g.pickups.values()].find((p) => !p.taken)
    if (next) {
      g.tank.dead = false
      g.tank.x = next.at.x
      g.tank.y = next.at.y
    }
    return new Promise((r) =>
      setTimeout(() => {
        g.net.publish = real
        const exp = seen && Number(seen.tags.find((t) => t[0] === 'expiration')[1])
        r(seen ? { ttl: exp - seen.created_at } : null)
      }, 1800),
    )
  })
  check('the claim asks the relay to keep it far longer than the pad lives',
    ttl !== null && ttl.ttl === 600, JSON.stringify(ttl))

  const c = await join(browsers[2], 'C', 'charlie')
  await c.evaluate(([h, t, w]) => {
    // Same block *and* the same wave length as the other two, so it derives the
    // same pads. The wave is part of the schedule input: a client on a different
    // one computes different ids and matches nobody, which is the exact bug the
    // anchor work was about.
    window.__clock.accept({ height: h, hash: 'da'.repeat(30) + '0500', time: t })
    window.__realWave = window.__game.modifier.waveSeconds
    window.__game.modifier = { ...window.__game.modifier, waveSeconds: w }
    document.getElementById('podium').hidden = true
  }, [HEIGHT + 3, LATE_MINED, PIN_WAVE])

  let late = null
  for (let i = 0; i < 8; i++) {
    await wait(1200)
    late = await c.evaluate((id) => {
      const g = window.__game
      const p = g.pickups.get(id)
      return {
        derived: !!p,
        taken: !!p?.taken,
        received: g.claimsReceived,
        unmatched: g.unmatchedClaims,
      }
    }, lateTarget.id)
    if (late.derived && late.taken) break
  }
  // Reported alongside, so "the pad expired before charlie got here" is
  // distinguishable from "charlie never learned it was taken".
  const stillLive = await b.evaluate((id) => !!window.__game.pickups.get(id), lateTarget.id)
  check('a client joining afterwards backfills the claim and sees the pad as gone',
    late.derived && late.taken, `${JSON.stringify(late)}, pad still on B: ${stillLive}`)
  // The counter that would otherwise read a healthy zero for a backfill that
  // fetched nothing at all.
  check('and it actually received claims rather than quietly fetching none',
    late.received > 0, JSON.stringify(late))

  // Hand the wave back before anything else runs against these clients.
  //
  // A pin that outlives the thing it was pinned for is a fixture leaking into
  // the next check, and this one leaked: the fallback-clock check below waits up
  // to twenty seconds for a board, which is patience against a 34-second wave
  // and no patience at all against a ten-minute one. It failed with `pads 0`
  // against a client whose schedule I had quietly stopped.
  await Promise.all([a, b, c].map((p) => p.evaluate(() => {
    if (window.__realWave !== undefined) {
      window.__game.modifier = { ...window.__game.modifier, waveSeconds: window.__realWave }
    }
  })))

  // The other half of the anchor: what the schedule does while it does not yet
  // know when the block was mined.
  //
  // `fillTime` runs in the background, so every round starts with the timestamp
  // in flight. If that reads the same as "no explorer would tell me", the board
  // spawns on the shared-unix fallback at wave ~52,000,000 and then reshuffles
  // to wave 0 the instant the real timestamp lands — at each client's own HTTP
  // latency, which is two clients on two timelines again. So pending has to
  // mean wait, and only a genuinely unavailable timestamp may take the fallback.
  //
  // Driven through `chainClock` rather than through the explorer, because the
  // three states are the thing under test and a real fetch gives you whichever
  // one it feels like.
  const guarded = await c.evaluate(async () => {
    const g = window.__game
    const real = g.chainClock
    g.pickups.clear()
    g.chainClock = () => ({ seconds: null, pending: true })
    await new Promise((r) => setTimeout(r, 900))
    const whilePending = g.pickups.size
    // A known anchor, three seconds into wave zero: pads must be back. Without
    // this the check above would also pass against a schedule that had simply
    // stopped working.
    g.chainClock = () => ({ seconds: 3, pending: false })
    await new Promise((r) => setTimeout(r, 700))
    const whenKnown = g.pickups.size
    g.chainClock = real
    return { whilePending, whenKnown }
  })
  check('no pads are derived while the block time is still in flight',
    guarded.whilePending === 0, JSON.stringify(guarded))
  check('and they come straight back once the anchor is known',
    guarded.whenKnown > 0, JSON.stringify(guarded))

  // And the degraded path: no timestamp available at all, ever. The schedule has
  // to keep running on absolute unix seconds rather than stopping — that branch
  // exists precisely so an explorer that will not answer costs a shifted wave
  // phase and nothing more. Patient, because the fallback lands at an arbitrary
  // point in the 34-second wave and up to fourteen of those are empty board.
  let fallbackPads = 0
  await c.evaluate(() => {
    window.__game.pickups.clear()
    window.__game.chainClock = () => ({ seconds: null, pending: false })
  })
  for (let i = 0; i < 20; i++) {
    await wait(1000)
    fallbackPads = await c.evaluate(() => window.__game.pickups.size)
    if (fallbackPads > 0) break
  }
  check('an explorer that never answers still gets a board, on the shared unix clock',
    fallbackPads > 0, `pads ${fallbackPads}`)

  // Regen is gone: Puzz asked for it out, and a tank sitting still must not heal.
  await b.evaluate(() => {
    const g = window.__game
    g.tank.dead = false
    g.tank.hp = 1
  })
  await wait(4000)
  const stillHurt = await b.evaluate(() => window.__game.tank.hp)
  check('a tank left alone does not heal by itself any more', stillHurt === 1, `hp=${stillHurt}`)

  // The production path. Every fake tip above omits `time`, so the schedule has
  // been running on the absolute-unix fallback — shared, but not the real thing.
  // A tip that carries a mined-at timestamp must anchor the wave to it, on both
  // clients, from the same explorer field.
  const MINED = Math.floor(Date.now() / 1000) - 111
  await Promise.all([a, b].map((p) => p.evaluate(([h, t]) => {
    window.__clock.accept({ height: h, hash: 'be'.repeat(30) + '0500', time: t })
    document.getElementById('podium').hidden = true
  }, [HEIGHT + 4, MINED])))
  await wait(1200)
  const anchored = await Promise.all([a, b].map((p) => p.evaluate(() => ({
    chain: Math.round(window.__clock.chainSeconds() ?? -1),
    waves: [...window.__game.pickups.keys()].map((id) => id.split(':')[1]),
  }))))
  check('a tip that knows when it was mined anchors the wave to the chain',
    anchored.every((r) => r.chain >= 111 && r.chain < 130) &&
      anchored.every((r) => r.waves.every((w) => Number(w) === 3)) &&
      JSON.stringify(anchored[0].waves) === JSON.stringify(anchored[1].waves),
    JSON.stringify(anchored))

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
    // Polled rather than waited out. The turret turns at a fixed rate in
    // simulation time, and simulation time crawls under software rasterisation,
    // so any single fixed wait is a guess that eventually loses.
    let r
    for (let i = 0; i < 12; i++) {
      await wait(700)
      r = await a.evaluate(([x, y]) => {
        const g = window.__game
        const w = window.__renderer.toWorld(x, y)
        return { gun: g.tank.gun, want: Math.atan2(w.y - g.tank.y, w.x - g.tank.x) }
      }, [px, py])
      if (angleGap(r.gun, r.want) < 0.25) break
    }
    check(`the gun swings to the cursor ${where}`, angleGap(r.gun, r.want) < 0.25,
      `gun ${r.gun.toFixed(2)} want ${r.want.toFixed(2)}`)
  }

  // ------------------------------------------------- what the alarm says
  //
  // `test/relays.mjs` proves the alarm *arises* from real frames. This checks
  // what it then puts in front of a person, which is a different question and
  // the one that decides whether the alarm is any use.
  //
  // Which way the clock is wrong is the first thing somebody needs, and the
  // relay always says it: `too far in the future` is a fast clock, `event
  // expired` is a slow one. Telling a player only that their clock is "wrong"
  // leaves them guessing at the exact thing they came here to fix.
  //
  // The window is quoted because `created_at_msecs_ahead` is one of the fields
  // a relay's behaviour scaling never touches — rate limits move underneath you
  // as your standing changes and the tolerance does not, so the one number this
  // screen is built on is the one number that cannot be stale.
  // Polled for the expected direction rather than sampled once. The HUD repaints
  // on a throttle, and the read-path warning outranks the clock one — so a
  // single read 400ms later is a guess about two timers at once.
  const alarmText = async (direction, reason, agreed = 3) =>
    a.evaluate(async ([d, r, n]) => {
      const net = window.__game.net
      Object.defineProperty(net, 'clockAlarm', {
        configurable: true,
        get: () => ({ reason: r, streak: 5, direction: d, agreed: n }),
      })
      const el = document.getElementById('alarm')
      let seen = null
      for (let i = 0; i < 12; i++) {
        // Keep the ear alive: the read-path warning is deliberately louder than
        // this one, and it would otherwise win whenever inbound went quiet.
        window.__game.lastInboundAt = performance.now()
        await new Promise((res) => setTimeout(res, 250))
        seen = {
          display: getComputedStyle(el).display,
          text: el.textContent.replace(/\s+/g, ' ').trim(),
        }
        // Match on the *reason*, not the direction: the panel quotes it verbatim,
        // and two consecutive cases can share a direction — so breaking on the
        // direction alone can return the previous case's text, complete with the
        // number that case had and this one does not.
        if (seen.text.includes(r)) break
      }
      return seen
    }, [direction, reason, agreed])

  const fast = await alarmText('ahead', 'invalid: created_at too far in the future (window 900000 ms)')
  // The headline is the symptom, not the cause. A player is looking at an arena
  // where nobody moves; "your clock is wrong" answers a question they did not
  // ask, and reads as a lie next to what is on their screen.
  check('the headline names what is broken rather than what caused it',
    fast.display !== 'none' && /OTHER PLAYERS CAN'T SEE YOU/.test(fast.text),
    fast.text.slice(0, 90))
  check('a fast clock is named as fast, with the relay\'s window when it gives one',
    /ahead/.test(fast.text) && /15 minutes/.test(fast.text),
    fast.text.slice(0, 190))

  // The one that matters, and the one the old code got wrong in production.
  // Three of the four relays this game ships with say `created_at too late` —
  // which contains neither "future" nor "expired", so reading direction off the
  // words silently produced no direction at all. Counted rather than read now.
  const strfry = await alarmText('ahead', 'invalid: created_at too late')
  check('and a wording with neither keyword in it is still named as fast',
    strfry.display !== 'none' && /ahead/.test(strfry.text) && !/behind/i.test(strfry.text),
    strfry.text.slice(0, 190))
  check('without inventing a number the relay never gave',
    !/\d+ minutes/.test(strfry.text), strfry.text.slice(0, 150))

  const slow = await alarmText('behind', 'invalid: ephemeral event expired')
  check('and a slow clock is named as slow rather than just "wrong"',
    slow.display !== 'none' && /behind/.test(slow.text) && !/ahead/.test(slow.text),
    slow.text.slice(0, 190))

  check('and the screen says how many relays agreed', /3 relays agree/.test(slow.text),
    slow.text.slice(0, 90))

  await a.evaluate(() => {
    delete window.__game.net.clockAlarm
  })
  await wait(400)
  // Polled: the HUD repaints on a throttle, so "is it gone yet" a fixed moment
  // after the state changed is a guess about a timer.
  let cleared = null
  for (let i = 0; i < 12; i++) {
    cleared = await a.evaluate(() => ({
      attr: document.getElementById('alarm').hidden,
      display: getComputedStyle(document.getElementById('alarm')).display,
      text: document.getElementById('alarm').textContent.replace(/\s+/g, ' ').trim().slice(0, 70),
      stalled: window.__game.readPathStalled,
      slow: window.__game.slowClockAlarm,
    }))
    if (cleared.attr && cleared.display === 'none') break
    await wait(300)
  }
  check('and it leaves the page entirely once the alarm clears',
    cleared.attr && cleared.display === 'none', JSON.stringify(cleared))

  // --------------------------------------------- a clock nobody complains about
  //
  // The widest silent failure in the game, and it was arithmetic on a number we
  // chose rather than any relay's policy. The live subscription carried
  // `since: now - 30`, so a clock ahead by more than thirty seconds made `since`
  // later than the `created_at` every other player stamps — and a relay applies
  // a filter to live events, not just to backfill. Five minutes fast: every
  // other tank invisible, your own tank on all of their screens, every shell you
  // fire landing. Nothing refuses anything, because these relays tolerate
  // fifteen minutes forward on the write path.
  //
  // The obvious self-check gives a false all-clear, which is why this needs a
  // *second* client to be believed: our own ticks come back, always, because our
  // `created_at` and our `since` are computed from the same broken clock. The
  // filter selects exactly the events stamped wrong.
  const SKEW = 300
  const fastClock = await join(browsers[3], 'D', 'delta', SKEW)
  const skewReal = await fastClock.evaluate(
    ([s]) => Math.round(Date.now() / 1000) - s,
    [Math.round(Date.now() / 1000)],
  )
  check('the fourth client really is running fast', Math.abs(skewReal - SKEW) < 5,
    `${skewReal}s ahead, wanted ${SKEW}`)

  let sees = null
  for (let i = 0; i < 14; i++) {
    await wait(1500)
    sees = await fastClock.evaluate(() => ({
      peers: [...window.__game.peers.values()].map((p) => p.name),
      ownTicks: window.__game.sawTraffic,
    }))
    if (sees.peers.length) break
  }
  check('a client five minutes fast can still see the room',
    !!sees && sees.peers.length > 0, JSON.stringify(sees))
  // And the other direction of the same failure: the room has to see them too,
  // which it always did — that asymmetry is what made it invisible.
  // Polled: delta being visible *here* is a second discovery, and sampling it
  // the instant delta's own loop broke measures the round trip rather than the
  // asymmetry. The bug this guards is a direction that never arrives, so a
  // bounded poll still catches it.
  const [seenBack] = await until([a], () =>
    [...window.__game.peers.values()].map((p) => p.name),
    (r) => r[0].includes('delta'), 20_000)
  check('and the room can see them, which it always could',
    seenBack.includes('delta'), JSON.stringify(seenBack))

  // ------------------------------------------- nothing replayed from the store
  //
  // Dropping `since` fixed a clock bug and removed the only thing keeping a
  // finished match out of a fresh join. `limit` never binds — the count does not
  // drop until the relay's store drops it — so a joining player was handed
  // somebody else's firefight in full: shells spawning at the muzzle with their
  // full damage, deaths in their kill feed, ghost tanks in the arena.
  //
  // EOSE is the boundary, and it needs no clock. Everything before it is a
  // record that something happened; only a live event is a thing happening.
  const replay = await a.evaluate(() => {
    const g = window.__game
    const before = { shells: g.shells.size, feed: g.feed.length, peers: g.peers.size }
    const droppedBefore = g.storedDropped
    const freshBefore = g.storedFresh
    const stamp = () => Math.floor(Date.now() / 1000)
    const ghost = 'aa'.repeat(32)
    // Exactly what a relay hands back out of its store on join.
    g.onEvent({
      id: 'rs' + Math.random(), kind: 21001, pubkey: ghost, created_at: stamp(),
      tags: [], content: JSON.stringify({ id: 'ghostshell', t0: performance.now(), x: 500, y: 500, a: 0, d: 3 }),
    }, true)
    g.onEvent({
      id: 'rd' + Math.random(), kind: 21002, pubkey: ghost, created_at: stamp(),
      tags: [], content: JSON.stringify({ t: performance.now(), k: null, x: 500, y: 500 }),
    }, true)
    g.onEvent({
      id: 'rt' + Math.random(), kind: 21000, pubkey: ghost, created_at: stamp(),
      tags: [], content: JSON.stringify({ t: performance.now(), x: 500, y: 500, h: 0, g: 0, hp: 3, d: false }),
    }, true)
    return {
      before,
      after: { shells: g.shells.size, feed: g.feed.length, peers: g.peers.size },
      ghostPeer: g.peers.has(ghost),
      dropped: g.storedDropped - droppedBefore,
      fresh: g.storedFresh - freshBefore,
    }
  })
  check('a shell replayed out of the store does not become a shell',
    replay.after.shells === replay.before.shells, JSON.stringify(replay))
  check("and somebody else's death does not land in your kill feed",
    replay.after.feed === replay.before.feed, JSON.stringify(replay))
  check('and a stored tick does not stand a ghost tank in the arena',
    !replay.ghostPeer && replay.after.peers === replay.before.peers, JSON.stringify(replay))
  // The counter exists because "pre-EOSE means stored" is true of strfry and
  // false of newlay, which flushes its live buffer before EOSE — so this is a
  // trade rather than a fact, and a trade should be countable. A number still
  // climbing long after the join is a relay ordering its buffer the other way.
  check('and the drop is counted rather than silent', replay.dropped === 3,
    `${replay.dropped} dropped`)
  // Those three were stamped `now`, so they are the population a relay
  // flushing live events onto the stored side would produce — which is the case
  // that says the trade is costing something, as opposed to the case where it
  // is earning its keep. Rate cannot tell them apart; age can.
  check('and a drop that looked live is counted apart from a stale one',
    replay.fresh === 3, `${replay.fresh} of ${replay.dropped} looked live`)

  const stale = await a.evaluate(() => {
    const g = window.__game
    const before = { dropped: g.storedDropped, fresh: g.storedFresh }
    g.onEvent({
      id: 'old' + Math.random(), kind: 21001, pubkey: 'cc'.repeat(32),
      // Four minutes old: strfry will hand you up to five minutes of this.
      created_at: Math.floor(Date.now() / 1000) - 240,
      tags: [], content: JSON.stringify({ id: 'oldshell', t0: performance.now(), x: 500, y: 500, a: 0 }),
    }, true)
    return { dropped: g.storedDropped - before.dropped, fresh: g.storedFresh - before.fresh }
  })
  check('while a four-minute-old one counts as the ghost it is',
    stale.dropped === 1 && stale.fresh === 0, JSON.stringify(stale))

  // A counter nothing displays is not an instrument, and this suite is the only
  // thing that has ever read `storedFresh`. Poll for the line rather than
  // sampling once: drawHud throttles to 120ms and a headless renderer runs the
  // whole simulation at roughly a third speed.
  //
  // Both halves are read in one evaluate, and the poll is on them *agreeing*.
  // The counter is live and the line is whatever the last paint left behind —
  // `drawHud` throttles to 120ms — so a single sample compares a number to a
  // stale render of an older one, and this check duly failed with `fresh: 4`
  // against a line reading `1`. It is not polling until the assertion passes:
  // the failure this guards is a counter that never reaches the screen at all,
  // and that one never agrees, however long you wait.
  const [shown] = await until([a], () => {
    const line = document.getElementById('hud-ghosted')?.textContent ?? null
    return { fresh: window.__game.storedFresh, line }
  }, (r) => r[0].line !== null && r[0].line.startsWith(`${r[0].fresh} live update`))
  // Asserted against the counter rather than the literal 3: a real relay may
  // flush one of our own events onto the stored side at any moment, and the
  // claim under test is that whatever the number is, it reaches a person.
  check('and the count reaches the screen, in the words of what was lost',
    shown.line !== null && shown.line.startsWith(`${shown.fresh} live update`) &&
      shown.line.includes('dropped'),
    JSON.stringify(shown))

  // The other direction, as a biconditional so it holds whichever way player
  // two's session went: no drops, no line. A warning that is always on screen
  // is not a warning.
  const quiet = await b.evaluate(() => ({
    fresh: window.__game.storedFresh,
    present: document.getElementById('hud-ghosted') !== null,
  }))
  check('and a session that lost nothing is not warned about it',
    quiet.present === (quiet.fresh > 0), JSON.stringify(quiet))

  // The other direction: a *live* event of the same shape must still work, or
  // "nothing replays" would pass against a client that had stopped listening.
  const liveOne = await a.evaluate(() => {
    const g = window.__game
    const before = g.shells.size
    g.onEvent({
      id: 'ls' + Math.random(), kind: 21001, pubkey: 'bb'.repeat(32), created_at: Math.floor(Date.now() / 1000),
      tags: [], content: JSON.stringify({ id: 'liveshell', t0: performance.now(), x: 520, y: 520, a: 0 }),
    }, false)
    return { before, after: g.shells.size }
  })
  check('while a live one of exactly the same shape still does',
    liveOne.after > liveOne.before, JSON.stringify(liveOne))

  // ------------------------------------------------- the ear, not the mouth
  //
  // Relays echo our own events back to our own subscription, so a healthy read
  // path is never silent — even alone in a room. That is what makes one check
  // cover a dropped socket, a CLOSED we could not act on, and a filter matching
  // nothing: three causes, one symptom, all of them previously invisible.
  const healthy = await a.evaluate(() => ({
    stalled: window.__game.readPathStalled,
    quietFor: Math.round(performance.now() - window.__game.lastInboundAt),
  }))
  check('a live client is not deaf, because its own echo comes back',
    healthy.stalled === false && healthy.quietFor < 12_000, JSON.stringify(healthy))

  // Inbound has to actually stop. Backdating `lastInboundAt` on its own proves
  // nothing — the echo overwrites it ten times a second, which is a control the
  // thing under test rewrites, the same trap as the accepted-count watermark
  // earlier in this file. The ear is unplugged instead.
  const wentQuiet = await a.evaluate(async () => {
    const g = window.__game
    const realOnEvent = g.onEvent.bind(g)
    g.onEvent = () => {}
    const n = document.getElementById('alarm')
    let seen = null
    // Polled, and the tank is kept alive each pass: `readPathStalled` stands
    // down while you are respawning, and with inbound unplugged the shells
    // already in flight can still land on you.
    for (let i = 0; i < 16; i++) {
      g.lastInboundAt = performance.now() - 20_000
      g.tank.dead = false
      g.tank.hp = g.maxHp
      await new Promise((r) => setTimeout(r, 300))
      seen = {
        stalled: g.readPathStalled,
        dead: g.tank.dead,
        clockAlarm: g.net.clockAlarm?.direction ?? null,
        display: getComputedStyle(n).display,
        text: n.textContent.replace(/\s+/g, ' ').trim(),
      }
      if (/STOPPED HEARING THE ROOM/.test(seen.text)) break
    }
    g.onEvent = realOnEvent
    return seen
  })
  check('and twelve seconds of silence puts it on the screen',
    wentQuiet.stalled && wentQuiet.display !== 'none' &&
      /STOPPED HEARING THE ROOM/.test(wentQuiet.text),
    JSON.stringify({ ...wentQuiet, text: wentQuiet.text.slice(0, 60) }))
  check('and it says this side died rather than blaming the room',
    /may still see you/.test(wentQuiet.text), wentQuiet.text.slice(0, 200))
  // Polled for the same reason as above: the state clears on the next inbound
  // event and the panel clears on the next HUD repaint, which are two timers.
  let recovered = null
  for (let i = 0; i < 12; i++) {
    await wait(300)
    recovered = await a.evaluate(() => ({
      stalled: window.__game.readPathStalled,
      hidden: document.getElementById('alarm').hidden,
    }))
    if (!recovered.stalled && recovered.hidden) break
  }
  check('and it clears the moment anything arrives',
    !recovered.stalled && recovered.hidden, JSON.stringify(recovered))

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
