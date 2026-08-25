// Damage states and the shield bubble.
//
// Puzz: "Tanks should start looking beat up and catch fire wen 1 shot or start
// smoking. We need icons and something representing when shield is activated."
//
// The hard part of this feature is not the rule, it is that the rule reaches a
// pixel. This game has shipped meshes that were `visible = true` on every frame
// of every match for weeks and were drawn inside the board, where nothing in a
// scene graph complains and no structural assertion can tell the difference.
// So the smoke and the flame are checked by reading the framebuffer behind the
// tank, and every reading is taken against a control frame of the same tank at
// full health in the same place — a number with nothing to compare it to
// measures nothing.
//
//   npm run build && npm run preview &
//   npm run test:damage

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
  '--no-sandbox', '--window-size=1280,800', '--use-gl=angle',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox',
  '--autoplay-policy=no-user-gesture-required', '--mute-audio',
  '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

/** Poll rather than sleep: swiftshader runs this page at a few frames a second. */
async function until(fn, ms = 30_000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await new Promise((r) => setTimeout(r, 100))
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
  await page.type('#name', 'damage')
  await page.type('#room', 'damage' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game && !!window.__renderer, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  check('a game is running', started)
  if (!started) throw new Error('the game never started')

  // Pin the round, and keep it pinned. The hull maximum is a block modifier —
  // Glass Cannon plays at maxHp 1 — and every threshold here is a ratio against
  // it, so a suite run against whatever the live chain happens to be serving is
  // true by accident.
  //
  // Nailing `beginRound` shut afterwards is not belt and braces, it is the
  // whole pin. The first live tip lands a few seconds after the page joins, and
  // `beginRound` puts the hull back to full on purpose — carrying three points
  // into a one-hit round would be invisible invincibility. So a suite that
  // parks a tank at 1 hp and then waits for smoke is racing a heal it cannot
  // see: the tank is at full health by the time the plume would have risen, the
  // reading is honest, and the failure it reports is not in the code under
  // test. This cost an evening. Every suite that pins a round needs this line.
  await page.evaluate(() => {
    const g = window.__game
    g.beginRound(900000, 'ab'.repeat(30) + '0300')
    g.beginRound = () => {}
  })
  const maxHp = await page.evaluate(() => window.__game.maxHp)
  check('the pinned round gives a hull worth damaging', maxHp >= 3, `maxHp=${maxHp}`)

  // ---------------------------------------------------------------- the wire

  const outgoing = await page.evaluate(() => {
    const g = window.__game
    let out = null
    const real = g.publishAsSession.bind(g)
    g.publishAsSession = (kind, payload) => {
      if (kind === 21000) out = payload
      return real(kind, payload)
    }
    g.buffs.shieldUntil = 0
    g.publishState(performance.now())
    const bare = out
    g.buffs.shieldUntil = performance.now() + 9000
    g.publishState(performance.now())
    const shielded = out
    g.buffs.shieldUntil = 0
    g.publishAsSession = real
    return { bare: bare?.sh ?? null, shielded: shielded?.sh ?? null }
  })
  check(
    'our tick says when a shield is up and stays quiet when it is not',
    outgoing.shielded === 1 && outgoing.bare === null,
    JSON.stringify(outgoing),
  )

  // Remote tanks are drawn INTERP_MS in the past, so the two ticks of a case
  // have to be genuinely 200ms apart in wall-clock time — and the read has to
  // happen while the render clock sits between them. Firing four ticks inside
  // one `evaluate` stamps them all at the same millisecond, and the reader then
  // takes the *oldest* sample every time, which is correct behaviour for a
  // render clock 130ms in the past and tells you nothing about the feature.
  // The offset estimator pins the least-delayed sample to now by construction,
  // so no amount of arithmetic on the stamps substitutes for the wait.
  const tick = (extra) => page.evaluate((PEER, extra) => {
    window.__game.onEvent({
      id: 'a' + Math.random().toString(16).slice(2),
      pubkey: PEER, kind: 21000, created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), x: 300, y: 300, h: 0, g: 0, hp: 3, d: false, ...extra }),
    }, false)
  }, PEER, extra)
  const readShield = () => page.evaluate(() => {
    const g = window.__game
    g.update(0.016, { throttle: 0, steer: 0, aim: null, fire: false, reload: false })
    return [...g.peers.values()][0]?.view.shield
  })
  const clearPeers = () => page.evaluate(() => window.__game.peers.clear())
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))

  /** Two ticks 200ms apart, read while the render clock is between them. */
  const between = async (first, second) => {
    await clearPeers()
    await tick(first)
    await wait(200)
    await tick(second)
    return readShield()
  }

  const peerShield = {
    up: await between({ sh: 1 }, { sh: 1 }),
    down: await between({}, {}),
    // The one that matters: the newer of the pair says nothing, so the bubble
    // comes off even though a shielded sample is still sitting in the buffer.
    expired: await between({ sh: 1 }, {}),
  }
  // And once their ticks stop entirely, the reader leaves the interpolation
  // branch for the extrapolation one — a different assignment, which has its
  // own chance to keep a stale bubble alive.
  await clearPeers()
  await tick({ sh: 1 })
  await wait(200)
  await tick({})
  await wait(400)
  peerShield.stale = await readShield()

  check(
    "a peer's shield is on our board, and it pops when their ticks stop saying so",
    peerShield.up === true &&
      peerShield.down === false &&
      peerShield.expired === false &&
      peerShield.stale === false,
    JSON.stringify(peerShield),
  )

  // A client too old to send the flag must read as unshielded. The other way
  // round paints a bubble on a tank that is not protected, and a shot held back
  // for a shield that was never there is the worse of the two lies.
  check('a client too old to report a shield is not shielded', peerShield.down === false)

  // ------------------------------------------------------------- the pixels

  // Park in the middle of the arena facing **west**, so the rear deck — where
  // the plume comes off — is downwind of the hull rather than upwind of it. The
  // wind in render.ts blows toward +x; a tank facing +x has its own silhouette
  // sitting in exactly the air its smoke drifts through.
  // Where the tank stands is picked below, not hardcoded: the spawn this client
  // is dealt is random, and the arena is full of rock columns and hedges whose
  // ink outlines read as exhaust. Parked on the default spawn the control frame
  // scored 46186 "smoke" pixels off a healthy tank, because the measuring box
  // was sitting on a rock.
  let spot = { x: 800, y: 600 }
  let best = spot

  const park = async (hp) => page.evaluate(({ hp, spot }) => {
    const g = window.__game
    g.peers.clear()
    g.tank.dead = false
    g.tank.x = spot.x
    g.tank.y = spot.y
    g.tank.hull = Math.PI
    g.tank.gun = Math.PI
    g.tank.hp = hp
    g.buffs.shieldUntil = 0
    g.buffs.speedUntil = 0
    // Pin the hull colour, at the source. Guest keys are ephemeral, so the
    // palette slot this client lands in changes every run — and the palette
    // contains 20, an orange that satisfies the flame test's "bright and
    // red-dominant" on its own. A suite that passes or fails on which colour
    // it was dealt is not a suite.
    //
    // Set on `color`, not on `displayColor`: `spreadColors()` recomputes the
    // display hue from `color` on every single update, so pinning the derived
    // value would survive exactly until the next frame.
    g.color = 190
  }, { hp, spot })

  /**
   * Count smoke-coloured and flame-coloured pixels around the tank.
   *
   * Two boxes, because the two things live in different places. Flame is short
   * (under 0.7s) and barely drifts, so it is read at the nozzle. Smoke lives
   * for two seconds and rides the wind, so it is read a good way downwind —
   * and it has to be, because the first version of this check read one box over
   * the hull and scored 6015 on a **healthy** tank. That was the tank's own
   * black ink outline, and no plume was ever going to double it.
   *
   * Sampled repeatedly and accumulated rather than read once: the emitter is a
   * rate, and a single frame under swiftshader can easily fall between two
   * puffs. A window that cannot contain the behaviour cannot report on it.
   */
  const readPlume = async (frames = 14) => {
    let smoke = 0
    let flame = 0
    for (let i = 0; i < frames; i++) {
      const one = await page.evaluate(() => {
        const g = window.__game
        const r = window.__renderer
        // The rear deck, in world units, matching `wear()` in render.ts.
        const bx = g.tank.x - Math.cos(g.tank.hull) * 20
        const bz = g.tank.y - Math.sin(g.tank.hull) * 20
        const count = (wx, wy, wz, w, h) => {
          const p = r.toScreen(wx, wy, wz)
          if (!p) return null
          const px = r.probePixels(Math.round(p.x) - w / 2, Math.round(p.y) - h / 2, w, h)
          let smoke = 0
          let flame = 0
          for (let i = 0; i < px.length; i += 4) {
            const [red, green, blue] = [px[i], px[i + 1], px[i + 2]]
            const max = Math.max(red, green, blue)
            const min = Math.min(red, green, blue)
            // Grey and dark: exhaust. The felt behind it is a saturated green
            // and the sky is a pale cream, so neither can be mistaken for this.
            if (max < 105 && max - min < 26) smoke++
            // Hot: strongly red-dominant and bright, which nothing else on the
            // board is — the shells are pale and the pads are their own hues.
            else if (red > 165 && red - blue > 95 && red - green > 40) flame++
          }
          return { smoke, flame }
        }
        // Downwind and up the column, clear of the hull, the driver's head and
        // the name plate.
        const drift = count(bx + 62, 92, bz - 20, 96, 84)
        // At the nozzle, where the flame actually is.
        const nozzle = count(bx, 60, bz, 56, 48)
        if (!drift || !nozzle) return null
        return { smoke: drift.smoke, flame: nozzle.flame }
      })
      if (one) {
        smoke += one.smoke
        flame += one.flame
      }
      await new Promise((r) => setTimeout(r, 90))
    }
    return { smoke, flame }
  }

  // Find open air. The measuring box is a fixed world offset downwind of the
  // rear deck, so where the tank stands decides what is behind it — and "The
  // Lanes" is a board of rock columns and hedges whose ink outlines are dark
  // grey at exactly the threshold exhaust is. Every candidate is scored by the
  // control frame itself, a healthy tank in that spot, and the quietest wins.
  // The point is not to hunt for a passing number: whichever spot is chosen,
  // the control assertions below still have to hold, and they are what fails
  // if the board leaves no clear air at all.
  const CANDIDATES = [
    { x: 800, y: 600 }, { x: 560, y: 760 }, { x: 980, y: 880 }, { x: 380, y: 520 },
    { x: 1120, y: 420 }, { x: 700, y: 320 }, { x: 1040, y: 660 }, { x: 460, y: 980 },
  ]
  let healthy = null
  const scored = []
  for (const candidate of CANDIDATES) {
    spot = candidate
    await park(maxHp)
    await new Promise((r) => setTimeout(r, 250))
    const control = await readPlume(4)
    scored.push(`${candidate.x},${candidate.y}=${control.smoke}`)
    // Scale to the full-length reading the cases below take.
    if (!healthy || control.smoke < healthy.smoke) {
      healthy = control
      best = candidate
    }
  }
  spot = best
  console.log(`      parked at ${best.x},${best.y}  (${scored.join(' ')})`)

  await park(maxHp)
  await new Promise((r) => setTimeout(r, 900))
  healthy = await readPlume()

  // One hit in, not one hit from dead. This is the case a half-hull threshold
  // gets wrong: at the standard three hull there is no state between "below
  // half" and "burning", so a rule written that way describes a tank that
  // cannot exist and the middle tier silently never ships.
  await park(maxHp - 1)
  const hurt = await until(async () => {
    const r = await readPlume()
    return r.smoke > healthy.smoke * 2 + 120 ? r : null
  }, 25_000)
  check(
    'a tank that has taken a hit smokes, and a healthy one in the same spot does not',
    !!hurt,
    `healthy=${healthy.smoke} damaged=${hurt ? hurt.smoke : 'never rose'}`,
  )

  await park(1)
  const burning = await until(async () => {
    const r = await readPlume()
    return r.flame > 40 ? r : null
  }, 25_000)
  check(
    'one hit from dead, it is on fire',
    !!burning,
    `flame=${burning ? burning.flame : 0} (healthy control ${healthy.flame})`,
  )
  check(
    'and the healthy control frame had no flame in it',
    healthy.flame < 12,
    `healthy flame=${healthy.flame}`,
  )
  // Stated as a share of the box rather than as a raw count. What this check is
  // for is that the control is not *saturated* — a box already full of dark
  // pixels cannot show a plume arriving, which is exactly how the first version
  // of this suite failed, at 41% occupancy off a rock column. An absolute
  // "under 120" would instead be demanding a perfectly empty box, which no spot
  // on a board of hedges and stone gives you, and tuning that number until it
  // passed would be tuning away the only thing standing between this suite and
  // the bug it exists to catch.
  const sampled = 96 * 84 * 14
  check(
    'and the healthy control frame is nowhere near saturated with dark pixels',
    healthy.smoke < sampled * 0.04,
    `healthy smoke=${healthy.smoke} of ${sampled} (${((healthy.smoke / sampled) * 100).toFixed(2)}%)`,
  )

  // The scorch. Asserted as the quantity that changes rather than as a flag:
  // the hull material is read straight off the rig after a frame.
  const paint = await page.evaluate(async () => {
    const g = window.__game
    const r = window.__renderer
    const read = (hp) => {
      g.tank.hp = hp
      g.tank.dead = false
      r.draw(g)
      const c = r.you.body.color
      return { r: c.r, g: c.g, b: c.b, lum: c.r * 0.3 + c.g * 0.6 + c.b * 0.1 }
    }
    const full = read(g.maxHp)
    const hurt = read(1)
    return { full: full.lum, hurt: hurt.lum }
  })
  check(
    'the paint darkens as the hull takes hits',
    paint.hurt < paint.full * 0.85,
    `full=${paint.full.toFixed(3)} hurt=${paint.hurt.toFixed(3)}`,
  )

  // A one-hull round is never "damaged" — every hit kills — so it must never
  // scorch. This is the case that a threshold written in hit points rather than
  // in ratios gets wrong, and it is a whole block's worth of rounds.
  const glass = await page.evaluate(() => {
    const g = window.__game
    const r = window.__renderer
    const was = g.modifier
    g.modifier = { ...was, maxHp: 1 }
    g.tank.hp = 1
    g.tank.dead = false
    r.draw(g)
    const c = r.you.body.color
    const lum = c.r * 0.3 + c.g * 0.6 + c.b * 0.1
    const owed = r.you.smokeOwed
    g.modifier = was
    return { lum, owed }
  })
  check(
    'a Glass Cannon hull at 1 is pristine, not burning',
    glass.lum > paint.full * 0.95 && glass.owed === 0,
    JSON.stringify(glass),
  )

  // ------------------------------------------------------------- the bubble

  const bubble = await page.evaluate(() => {
    const g = window.__game
    const r = window.__renderer
    g.tank.hp = g.maxHp
    g.tank.dead = false
    g.buffs.shieldUntil = performance.now() + 9000
    r.setView('board')
    r.draw(g)
    const board = r.you.bubble.visible
    r.setView('cockpit')
    r.draw(g)
    const cockpit = r.you.bubble.visible
    r.setView('board')
    r.draw(g)
    const dead = (() => { g.tank.dead = true; r.draw(g); return r.you.bubble.visible })()
    g.tank.dead = false
    g.buffs.shieldUntil = 0
    r.draw(g)
    const off = r.you.bubble.visible
    return { board, cockpit, dead, off }
  })
  check(
    'the bubble is up in board view, off inside the cockpit, off when dead, off with no shield',
    bubble.board === true && bubble.cockpit === false && bubble.dead === false && bubble.off === false,
    JSON.stringify(bubble),
  )

  // And it reaches a pixel. `visible === true` is exactly the assertion that
  // passed for weeks over a ring buried in the felt.
  const bubblePixels = await page.evaluate(() => {
    const g = window.__game
    const r = window.__renderer
    g.tank.hp = g.maxHp
    g.tank.dead = false
    r.setView('board')
    const count = () => {
      r.draw(g)
      const p = r.toScreen(g.tank.x, 26, g.tank.y)
      if (!p) return -1
      const px = r.probePixels(Math.round(p.x) - 40, Math.round(p.y) - 40, 80, 80)
      let blue = 0
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 2] > 120 && px[i + 2] - px[i] > 40 && px[i + 2] >= px[i + 1]) blue++
      }
      return blue
    }
    g.buffs.shieldUntil = 0
    const off = count()
    g.buffs.shieldUntil = performance.now() + 9000
    const on = count()
    g.buffs.shieldUntil = 0
    return { off, on }
  })
  check(
    'and the shield is actually on the screen, not just visible in the graph',
    bubblePixels.on > bubblePixels.off + 300,
    JSON.stringify(bubblePixels),
  )

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall green')
process.exit(failures.length ? 1 : 0)
