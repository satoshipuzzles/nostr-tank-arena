// Damage you can see *past*, from inside the tank.
//
// Puzz: "the damaged tanks UI in first person is too much cant see."
//
// He was looking at a real thing. The plume emitter puts its puffs 20 units
// behind the hull at y=18..46; the cockpit eye sits at y=50, EYE_BACK units
// back along the barrel, with a near plane of 3. So a burning tank in first
// person spawns 46 particles a second directly into its own lens. A screenshot
// of that is a 1280x800 rectangle of cream and orange with one corner of green
// felt visible in the bottom left — not "hard to see through", no arena at all.
//
// Two halves to this suite and both are needed:
//
//   1. The board comes back. Read the *WebGL framebuffer* in the middle of the
//      screen — where a driver aims — and a burning tank must look like a
//      healthy one there. probePixels reads the canvas, so the DOM vignette
//      cannot contaminate this number, which is exactly why the check lives
//      here rather than in a screenshot diff.
//
//   2. The information is still delivered. A fix that only deletes the plume
//      makes the cockpit lie about your hull. So the edge glow is asserted on
//      *computed style* — the resolved box-shadow, with its calc() and its
//      var() evaluated by the browser. I have shipped a stylesheet edit that
//      matched nothing and told Puzz the feature worked because a DOM test was
//      green. `getComputedStyle` is the cheapest thing that cannot be fooled
//      that way.
//
//   npm run build && npm run preview &
//   npm run test:fpv

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

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'fpv')
  await page.type('#room', 'fpv' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game && !!window.__renderer, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  check('a game is running', started)
  if (!started) throw new Error('the game never started')

  // Pin the round and nail `beginRound` shut. The first live tip lands a few
  // seconds after joining and restores a full hull on purpose, so a suite that
  // parks a tank at 1 hp is otherwise racing a heal it cannot see — the reading
  // is honest, the tank really is healthy, and the failure points at the wrong
  // file. This cost an evening the first time. Same line, same reason, as
  // test/damage.mjs.
  await page.evaluate(() => {
    const g = window.__game
    g.beginRound(900000, 'ab'.repeat(30) + '0300')
    g.beginRound = () => {}
    document.getElementById('podium').hidden = true
  })
  const maxHp = await page.evaluate(() => window.__game.maxHp)
  check('the pinned round gives a hull worth damaging', maxHp >= 3, `maxHp=${maxHp}`)

  await page.keyboard.press('v')
  await wait(500)
  const inCockpit = await page.evaluate(() => window.__renderer.viewMode)
  check('V puts us in the cockpit', inCockpit === 'cockpit', inCockpit)

  /**
   * Park at a hull and keep parking. Re-applied on a timer rather than set
   * once: `update` runs every frame and there is no state here that stops
   * something else putting the hull back.
   */
  const park = (hp) => page.evaluate((hp) => {
    const g = window.__game
    g.tank.dead = false
    g.tank.x = 800
    g.tank.y = 600
    g.tank.hull = Math.PI
    g.tank.gun = Math.PI
    g.tank.hp = hp
    g.buffs.shieldUntil = 0
    g.buffs.speedUntil = 0
    // Pin the hull colour at the source. Guest keys are ephemeral so the
    // palette slot changes every run, and the palette contains an orange that
    // satisfies "bright and red-dominant" on its own.
    g.color = 190
  }, hp)

  const hold = async (hp, ms = 2600) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      await park(hp)
      await wait(180)
    }
  }

  // ------------------------------------------------- 1. the board comes back

  /**
   * Flame and smoke pixels in the middle of the screen, straight off the
   * WebGL framebuffer.
   *
   * A centre box on purpose. The fix moves damage to the *edges*, so a reading
   * that included them would go up when the fix works and prove nothing. This
   * box is the part of the frame a driver aims through, and the claim being
   * tested is that it looks the same at one hull as at three.
   *
   * Accumulated over frames rather than sampled once: the emitter is a rate,
   * and one frame under swiftshader can fall between two puffs. A window that
   * cannot contain the behaviour cannot report on it.
   */
  const readCentre = async (frames = 12) => {
    let board = 0
    let total = 0
    for (let i = 0; i < frames; i++) {
      const one = await page.evaluate(() => {
        const r = window.__renderer
        // 560x360 about the crosshair on a 1280x800 viewport.
        const px = r.probePixels(360, 220, 560, 360)
        let board = 0
        for (let i = 0; i < px.length; i += 4) {
          const [red, green, blue] = [px[i], px[i + 1], px[i + 2]]
          // Count what the *arena* is made of rather than what the plume is.
          //
          // This is the second classifier here. The first counted plume-
          // coloured pixels — grey-dark exhaust and red-dominant flame, the
          // bands test/damage.mjs uses against the felt — and it read 19% on a
          // healthy cockpit and 20% on a burning one, so the assertion it fed
          // passed against both the fix and the bug. Two reasons, and both are
          // about this being a *first-person* frame: the dark band of arena
          // wall across the middle of any cockpit shot lands in the exhaust
          // band, and the plume seen from three units away is not grey or
          // orange at all, it is a blown-out cream that misses both bands
          // entirely. Measuring the accused was the wrong instrument.
          //
          // Green-dominant is the felt and nothing else on this board: the sky
          // is blue, the walls and rocks are neutral-to-warm, the shells are
          // pale, the tank's own hull is pinned to a cyan where blue leads. A
          // plume in the lens is opaque, so it takes the felt away — which is
          // exactly the complaint, stated as a number.
          if (green > red + 12 && green > blue + 12) board++
        }
        return { board, total: px.length / 4 }
      })
      board += one.board
      total += one.total
    }
    return { board, total, pct: (board / total) * 100 }
  }

  await hold(maxHp)
  const healthy = await readCentre()
  await hold(1)
  const burning = await readCentre()

  console.log(
    `      felt visible through the middle of the frame: ` +
      `healthy ${healthy.pct.toFixed(2)}%  burning ${burning.pct.toFixed(2)}%`,
  )

  // The control comes first, because a ratio against a control that is already
  // near zero is arithmetic rather than evidence. If a healthy cockpit cannot
  // see the felt either, nothing below this line can distinguish the fix from
  // the bug.
  check(
    'a healthy cockpit can see the felt, so the reading below means something',
    healthy.pct > 8,
    `healthy=${healthy.pct.toFixed(2)}%`,
  )

  // The fix, stated as the thing a driver cares about: at one hull from dead
  // you can still see the arena you are aiming at. A ratio against the control
  // rather than an absolute, because where the tank stands decides how much
  // felt is in frame at all and the map is drawn from the live chain tip.
  check(
    'a burning tank does not fill its own cockpit',
    burning.board > healthy.board * 0.6,
    `healthy=${healthy.board} burning=${burning.board}`,
  )

  // -------------------------------------------- 2. the damage still reads

  /** Everything the browser actually resolved for the edge glow. */
  const readGlow = () => page.evaluate(() => {
    const g = window.__game
    const el = document.getElementById('damage')
    // Tolerated rather than dereferenced, so a bundle that predates this
    // element reaches the assertions instead of throwing. A crash only proves
    // the markup changed; the checks below are what carry the claim.
    if (!el) return { missing: true, hidden: null, display: null, shadow: '', animation: '', alpha: null, wear: '' }
    const cs = getComputedStyle(el)
    // The alpha of the first inset shadow, which is where `--wear` lands. If
    // the calc() or the var() failed to parse, this is absent or frozen.
    const alpha = /rgba?\([^)]*?,\s*([0-9.]+)\s*\)/.exec(cs.boxShadow)
    return {
      hidden: el.hidden,
      display: cs.display,
      shadow: cs.boxShadow,
      animation: cs.animationName,
      alpha: alpha ? Number(alpha[1]) : null,
      wear: el.style.getPropertyValue('--wear'),
      hp: g.tank.hp,
      maxHp: g.maxHp,
      dead: g.tank.dead,
      watching: g.watching,
      view: window.__renderer.viewMode,
    }
  })

  await hold(maxHp, 900)
  const glowFull = await readGlow()
  await hold(maxHp - 1, 900)
  const glowHurt = await readGlow()
  await hold(1, 900)
  const glowBurn = await readGlow()

  for (const [label, g] of [['full', glowFull], ['hurt', glowHurt], ['burn', glowBurn]]) {
    console.log(
      `      ${label}: hp=${g.hp}/${g.maxHp} dead=${g.dead} watching=${g.watching} ` +
        `view=${g.view} display=${g.display} wear=${g.wear} alpha=${g.alpha} anim=${g.animation}`,
    )
  }

  check(
    'no edge glow at all on a full hull',
    glowFull.hidden === true && glowFull.display === 'none',
    JSON.stringify({ hidden: glowFull.hidden, display: glowFull.display }),
  )

  // `display: none` has to come from the `[hidden]` rule beating this element's
  // own `display: block`. The UA sheet's `[hidden] { display: none }` loses to
  // any author rule that sets display, however weak the selector — which is a
  // bug I have shipped twice in this codebase, on the login screen and on the
  // podium.
  check(
    'the glow is a painted box when it is shown, not a bare element',
    glowHurt.hidden === false && glowHurt.display === 'block' &&
      glowHurt.shadow !== 'none' && glowHurt.shadow.includes('inset'),
    `display=${glowHurt.display} shadow=${glowHurt.shadow.slice(0, 60)}`,
  )

  // The rule that proves the calc() and the custom property both resolved.
  // A stylesheet that matched nothing, or a var() that fell back, gives the
  // same shadow at every hull — and the whole feature is the gradient.
  check(
    'the glow gets stronger as the hull goes down',
    glowHurt.alpha !== null && glowBurn.shadow !== glowHurt.shadow,
    `hurt=${glowHurt.alpha} burnShadow=${glowBurn.shadow.slice(0, 48)}`,
  )

  check(
    'one hit from dead, the edge pulses',
    glowBurn.animation === 'damage-pulse',
    glowBurn.animation,
  )

  // Board view already says all of this with the tank itself, and a glow round
  // the outside of a shared four-player board would be one player's private
  // state painted over everybody's picture.
  await page.keyboard.press('v')
  await wait(400)
  await hold(1, 900)
  const board = await readGlow()
  const view = await page.evaluate(() => window.__renderer.viewMode)
  check(
    'the edge glow is a cockpit thing and never reaches the board view',
    view === 'board' && board.hidden === true && board.display === 'none',
    `view=${view} display=${board.display}`,
  )

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall good')
process.exit(failures.length ? 1 : 0)
