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

  // Pin the round before anything is measured.
  //
  // The first tip comes from a real explorer, and the real hash picks the real
  // rules — so without this the duel below runs under Glass Cannon or Ricochet
  // roughly two runs in five, and "bravo died" starts failing for reasons that
  // have nothing to do with the kill path. `0500` is Crossroads and Straight
  // Deathmatch. The point of block-derived rules is that they are a pure
  // function of the hash, which is exactly what makes them pinnable here.
  await Promise.all([a, b].map((p) => p.evaluate(() => {
    window.__clock.accept({ height: 999000, hash: 'ef'.repeat(30) + '0500' })
    document.getElementById('podium').hidden = true
  })))
  await wait(600)
  const pinned = await Promise.all([a, b].map((p) => p.evaluate(() => ({
    rules: window.__game.modifier.id,
    maxHp: window.__game.maxHp,
  }))))
  check('the round is pinned to standard rules before anything is measured',
    pinned.every((r) => r.rules === 'standard' && r.maxHp === 3), JSON.stringify(pinned))

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
    rules: window.__game.modifier.id,
    maxHp: window.__game.maxHp,
    hp: window.__game.tank.hp,
    dead: window.__game.tank.dead,
    chip: document.getElementById('rules').hidden
      ? ''
      : document.getElementById('rules').textContent.replace(/\s+/g, ' ').trim(),
    rows: document.getElementById('podium-rows').textContent.replace(/\s+/g, ' ').trim(),
  }))))
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
  await Promise.all([a, b].map((p) => p.evaluate((h) => {
    window.__clock.accept({ height: h, hash: 'cd'.repeat(30) + '0501' })
  }, HEIGHT + 1)))
  await wait(1400)
  const secondBlock = await Promise.all([a, b].map((p) => p.evaluate(() => ({
    rules: window.__game.modifier.id,
    maxHp: window.__game.maxHp,
    map: document.getElementById('hud-map')?.textContent ?? '',
    chipHidden: document.getElementById('rules').hidden,
    chipDisplay: getComputedStyle(document.getElementById('rules')).display,
  }))))
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
  const spawned = await Promise.all([a, b].map((p) => p.evaluate(() =>
    [...window.__game.pickups.values()].map((x) => ({ id: x.id, kind: x.kind, x: Math.round(x.at.x), y: Math.round(x.at.y) })),
  )))
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

  // Drive alpha onto one and watch what happens on both sides.
  const target = spawned[0][0]
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

  // ------------------------------------------------------- siege and scatter
  //
  // Damage is the one number a shooter sends that the *victim* then applies to
  // its own hull, because the victim is authoritative over its HP and cannot
  // see what the shooter picked up ten seconds ago. Two separate claims, so two
  // separate checks: it has to cross the wire, and it has to be applied and
  // capped on arrival.
  await a.evaluate(() => {
    const g = window.__game
    for (const k of Object.keys(g.buffs)) g.buffs[k] = 0
    g.tank.dead = false
    g.tank.hp = 3
    g.tank.reloadAt = 0
    g.buffs.siegeUntil = performance.now() + 20000
  })
  await b.evaluate(() => { window.__game.shells.clear() })
  await a.keyboard.down('Space')
  await wait(600)
  await a.keyboard.up('Space')
  await wait(2200)
  const wire = await b.evaluate(() => {
    const g = window.__game
    const theirs = [...g.shells.values()].filter((s) => s.owner !== g.identity.sessionPubkey)
    return { count: theirs.length, damage: theirs.map((s) => s.damage) }
  })
  check('a siege shell arrives at the other client carrying its damage',
    wire.count > 0 && wire.damage.every((d) => d === 2), JSON.stringify(wire))

  // Applying it, without depending on two tanks having line of sight on a board
  // the block hash picked. The shell is injected through the same inbound path
  // a relay would deliver it on, sitting on bravo's hull.
  const applied = await b.evaluate(() => {
    const g = window.__game
    for (const k of Object.keys(g.buffs)) g.buffs[k] = 0
    g.tank.dead = false
    g.tank.hp = 3
    const send = (id, d) => g.onEvent({
      id: id + Math.random(),
      kind: 21001,
      pubkey: 'ff'.repeat(32),
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify({ id, t0: performance.now(), x: g.tank.x, y: g.tank.y, a: 0, d }),
    })
    send('siegeshell', 2)
    return { before: 3 }
  })
  await wait(700)
  const hurt = await b.evaluate(() => ({ hp: window.__game.tank.hp, dead: window.__game.tank.dead }))
  check('and takes two hull points off the tank it hits, not one',
    hurt.hp === 1 && !hurt.dead, `${JSON.stringify(applied)} -> ${JSON.stringify(hurt)}`)

  // A malformed or hostile fire event must not be able to claim more than a
  // full hull. The cap is applied where the shell is rebuilt from the wire.
  const capped = await b.evaluate(() => {
    const g = window.__game
    g.tank.dead = false
    g.tank.hp = 3
    const before = g.shells.size
    g.onEvent({
      id: 'cap' + Math.random(),
      kind: 21001,
      pubkey: 'ff'.repeat(32),
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify({ id: 'capshell', t0: performance.now(), x: 900, y: 900, a: 0, d: 99 }),
    })
    const shell = [...g.shells.values()].find((s) => s.id === 'capshell')
    return { grew: g.shells.size > before, damage: shell?.damage ?? null }
  })
  check('and a shell claiming 99 damage is capped at a full hull',
    capped.grew && capped.damage === 3, JSON.stringify(capped))

  // Scattershot is three fire events instead of one, which is why it is a
  // 14-second pickup rather than a weapon: a shot is about one event a second
  // and a position tick is ten, so tripling the rarer one briefly is a rounding
  // error against the tick stream.
  await a.evaluate(() => {
    const g = window.__game
    for (const k of Object.keys(g.buffs)) g.buffs[k] = 0
    g.tank.dead = false
    g.tank.hp = 3
    g.shells.clear()
    g.buffs.scatterUntil = performance.now() + 20000
    g.tank.reloadAt = 0
  })
  await a.keyboard.down('Space')
  await wait(700)
  await a.keyboard.up('Space')
  await wait(300)
  const fanned = await a.evaluate(() => {
    const g = window.__game
    const mine = [...g.shells.values()].filter((s) => s.owner === g.identity.sessionPubkey)
    return { count: mine.length, angles: [...new Set(mine.map((s) => Math.round(Math.atan2(s.vy, s.vx) * 100) / 100))] }
  })
  check('Scattershot puts three shells in the air, not one',
    fanned.count >= 3 && fanned.angles.length >= 3, JSON.stringify(fanned))
  await a.evaluate(() => { window.__game.buffs.scatterUntil = 0 })

  // ------------------------------------------------------------- block clock
  //
  // There is nothing honest to count down to — the next block is a coin flip
  // every second, not a timer running out — so it counts up. When the explorer
  // would not give a timestamp it counts from when this client first saw the
  // block and marks that with a `~`, which is a lower bound rather than a guess
  // dressed up as a fact.
  const clock1 = await a.evaluate(() => ({
    seconds: window.__clock.secondsSinceTip(),
    text: document.querySelector('#status .clock')?.textContent ?? '',
  }))
  await wait(2500)
  const clock2 = await a.evaluate(() => ({
    seconds: window.__clock.secondsSinceTip(),
    text: document.querySelector('#status .clock')?.textContent ?? '',
  }))
  check('the HUD shows time since the block, counting up',
    /^~?\d+:\d\d$/.test(clock2.text) && clock2.seconds > clock1.seconds,
    `${clock1.text} -> ${clock2.text}`)

  // ---------------------------------------------------------------- profiles
  //
  // A hex pubkey is not a person. Kind 0 turns a signed score into a face and a
  // name — but the `nip05` field inside it is a claim the account made about
  // itself, and it does not earn its tick until the domain says the same thing.
  const cards = await a.evaluate(() => {
    const rows = [...document.querySelectorAll('#scoreboard .score-row')]
    return {
      rows: rows.length,
      avatars: rows.filter((r) => r.querySelector('.avatar')).length,
      fallbacks: rows.filter((r) => r.querySelector('.avatar.fallback')).length,
    }
  })
  check('every scoreboard row is a card with a face on it',
    cards.rows >= 2 && cards.avatars === cards.rows, JSON.stringify(cards))
  // Both players signed in with throwaway keys, which have no kind 0 anywhere,
  // so both must fall back rather than showing a broken image.
  check('and a guest key falls back to an initial instead of a dead image',
    cards.fallbacks === cards.rows, JSON.stringify(cards))

  // The verification itself, driven against a stubbed well-known file so the
  // answer does not depend on a stranger's web server being up. Both directions
  // are checked: a domain that agrees, and one that names a different key.
  const nip05 = await a.evaluate(async () => {
    const profiles = window.__profiles
    const real = window.fetch
    const key = 'aa'.repeat(32)
    const other = 'bb'.repeat(32)
    const answer = (mapped) => async () => ({
      ok: true,
      json: async () => ({ names: { alice: mapped } }),
    })
    const offline = async () => { throw new Error('offline') }
    const run = async (stub) => {
      window.fetch = stub
      const profile = { pubkey: key, name: 'alice', picture: null, nip05: 'alice@example.com', nip05Verified: null }
      await profiles.verify(profile)
      return profile.nip05Verified
    }
    const good = await run(answer(key))
    const bad = await run(answer(other))
    const unreachable = await run(offline)
    window.fetch = real
    return { good, bad, unreachable }
  })
  check('a NIP-05 the domain confirms is verified', nip05.good === true, JSON.stringify(nip05))
  check('one the domain maps elsewhere is marked wrong', nip05.bad === false, JSON.stringify(nip05))
  // The important one. Most failures here are a missing CORS header on somebody
  // else's static host, which is indistinguishable from the domain being down
  // and is emphatically not proof of a fake.
  check('and an unreachable domain stays unverified rather than false',
    nip05.unreachable === null, JSON.stringify(nip05))

  // Regen is gone: Puzz asked for it out, and a tank sitting still must not heal.
  await b.evaluate(() => {
    const g = window.__game
    g.tank.dead = false
    g.tank.hp = 1
  })
  await wait(4000)
  const stillHurt = await b.evaluate(() => window.__game.tank.hp)
  check('a tank left alone does not heal by itself any more', stillHurt === 1, `hp=${stillHurt}`)

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
