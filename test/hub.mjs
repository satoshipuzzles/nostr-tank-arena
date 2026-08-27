// The lobby as a hub: modes you can see, and a tank you can look at.
//
// Puzz asked for a landing page "like a Call of Duty page" — modes to pick
// from, a loadout you edit before you play, and a skin that shows you what the
// tank will look like. This covers the shell of that: the mode cards, the side
// picker they reveal, and the garage.
//
// Two claims are worth more than the rest, and both of them are about lying:
//
//   1. Picking a mode has to reach the *game*, not just the button. A card
//      with an `.on` class and no effect is the easiest thing in the world to
//      ship and the hardest to notice, so every mode check drives the real
//      start and reads `window.__game.team`.
//   2. The preview has to be a tank. This repo has shipped meshes that were
//      `visible === true` for weeks while drawn inside the floor, so "the
//      canvas exists" proves nothing: these read the pixels, and they require
//      the pixels to *change* when the finish changes. A static picture would
//      pass every check that stopped at the first one.
//
//   npm run build && npx vite preview --port 4207 &
//   npm run test:hub

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const SITE = process.env.TANK_URL ?? 'http://localhost:4207/'
const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!CHROME) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2) }

const FLAGS = [
  '--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--mute-audio', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
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
    await wait(100)
  }
  return null
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: FLAGS })

/** A page with nothing remembered, which is what a first visit is. */
async function freshPage(w = 1280, h = 900) {
  const page = await browser.newPage()
  await page.setViewport({ width: w, height: h })
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.evaluate(() => localStorage.clear())
  await page.reload({ waitUntil: 'domcontentloaded' })
  return page
}

/** The canvas, as bytes. Needs `preserveDrawingBuffer` on the preview. */
const previewPixels = (page) =>
  page.evaluate(() => {
    const c = document.getElementById('tank-cam')
    if (!c || c.hidden) return null
    const url = c.toDataURL('image/png')
    // Not the image itself — a hash of it. What every check here asks is
    // "is this different from that", and a 40KB data URL per sample makes the
    // failure output unreadable for no gain.
    let h = 0
    for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0
    return { hash: h, len: url.length }
  })

/**
 * How much of the canvas is not background.
 *
 * Read through a 2D context so this is counting *pixels*, not trusting a flag.
 * The background is a dark radial gradient; a tank is a bright toy, so a frame
 * with a tank in it has a real spread of luminance and an empty one does not.
 */
const previewInk = (page) =>
  page.evaluate(() => {
    const c = document.getElementById('tank-cam')
    const off = document.createElement('canvas')
    off.width = c.width
    off.height = c.height
    const ctx = off.getContext('2d')
    ctx.drawImage(c, 0, 0)
    const { data } = ctx.getImageData(0, 0, off.width, off.height)
    let lit = 0
    let total = 0
    let max = 0
    let sat = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const l = (r + g + b) / 3
      total++
      if (l > max) max = l
      if (l <= 90) continue
      lit++
      // Saturation of the lit pixels is the one number that separates a finish
      // from the tank simply being at a different angle. See the comment on the
      // finish check below: `litFraction` is dominated by rotation and cannot
      // carry that claim.
      const mx = Math.max(r, g, b)
      const mn = Math.min(r, g, b)
      sat += mx ? (mx - mn) / mx : 0
    }
    return {
      litFraction: lit / total,
      meanSat: lit ? sat / lit : 0,
      max,
      w: off.width,
      h: off.height,
    }
  })

/**
 * Several frames of it, because the tank is turning.
 *
 * The spread across the samples is this check's own control: it is how much the
 * number moves for reasons that have nothing to do with the skin. A difference
 * between two finishes only means anything if it is bigger than that.
 */
async function previewSeries(page, n = 6) {
  const out = []
  for (let i = 0; i < n; i++) {
    out.push(await previewInk(page))
    await wait(140)
  }
  const sats = out.map((s) => s.meanSat)
  return {
    mean: sats.reduce((a, b) => a + b, 0) / sats.length,
    spread: Math.max(...sats) - Math.min(...sats),
  }
}

try {
  // ------------------------------------------------------------ mode cards

  const page = await freshPage()
  const cards = await page.evaluate(() =>
    [...document.querySelectorAll('#modes .mode')].map((b) => ({
      id: b.id,
      name: b.querySelector('.mode-name')?.textContent?.trim(),
      fine: b.querySelector('.mode-fine')?.textContent?.trim(),
      on: b.classList.contains('on'),
      disabled: b.disabled,
    })))
  // `>= 3` rather than `=== 3`. This is another session's check and the intent
  // is unchanged — the lobby offers modes rather than only a room name — but
  // Domination made it four, and a count that has to be edited every time a
  // mode ships is a check about the roadmap rather than about the lobby.
  check('the lobby offers modes rather than only a room name', cards.length >= 3,
    JSON.stringify(cards.map((c) => c.name)))
  check('deathmatch is the one a first visit lands on', cards[0]?.on === true && cards[0]?.id === 'mode-dm',
    JSON.stringify(cards.map((c) => [c.id, c.on])))
  // Capture the flag went live, so these two flipped. The *intent* is unchanged
  // and worth keeping stated: a card must not lie about its own state. It used
  // to be `disabled` with "In build. Not playable yet." and these asserted
  // exactly that; now it is playable and they assert exactly that instead. A
  // card that is live while claiming to be in build loses somebody who would
  // have played it, which is the same failure as the other way round.
  check('capture the flag is playable rather than advertised',
    cards[2]?.disabled === false, JSON.stringify(cards[2]))
  check('and its blurb describes the game rather than saying it is not ready',
    !/not playable|in build/i.test(cards[2]?.fine ?? '') && (cards[2]?.fine ?? '').length > 10,
    JSON.stringify(cards[2]?.fine))
  // And clicking it selects it, which is the part "not disabled" does not prove.
  const ctfSelects = await page.evaluate(() => {
    document.getElementById('mode-ctf').click()
    const on = document.getElementById('mode-ctf').classList.contains('on')
    const side = !document.getElementById('row-side').hidden
    document.getElementById('mode-dm').click()
    return { on, side }
  })
  check('and picking it selects it and asks for a side',
    ctfSelects.on === true && ctfSelects.side === true, JSON.stringify(ctfSelects))

  // A mode card that wraps its name reads as two modes. Measured, not eyeballed.
  const nameFits = await page.evaluate(() =>
    [...document.querySelectorAll('#modes .mode-name')].every((n) => n.scrollWidth <= n.clientWidth + 1))
  // At whatever the grid lands on — `auto-fit` puts three across at 520px and
  // wraps four to two rows, and either way a name that wraps reads as two modes.
  check('every mode name holds one line, whatever the grid does', nameFits)

  // The side picker belongs to team modes only.
  const sideHiddenAtStart = await page.evaluate(() => document.getElementById('row-side').hidden)
  check('a deathmatch does not offer a side to pick', sideHiddenAtStart === true)

  await page.click('#mode-tdm')
  const sides = await page.evaluate(() => ({
    hidden: document.getElementById('row-side').hidden,
    options: [...document.querySelectorAll('#side button')].map((b) => b.textContent),
    picked: [...document.querySelectorAll('#side button')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.textContent),
  }))
  check('team deathmatch reveals the sides', sides.hidden === false && sides.options.length === 5,
    JSON.stringify(sides.options))
  check('and pre-picks one, so the mode is playable without a second decision',
    sides.picked.length === 1, JSON.stringify(sides.picked))

  await page.click('#side button[data-value="2"]')

  // ------------------------------------------------ the card reaches the game
  //
  // The whole point. `game.team` is what makes a shell pass through a
  // teammate; a card that sets a class and nothing else would pass every
  // check above this line.

  await page.type('#name', 'hub')
  await page.type('#room', 'hub' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page.waitForFunction(() => !!window.__game, { timeout: 25_000 })
    .then(() => true).catch(() => false)
  check('the game starts from the hub', started)
  const team = await page.evaluate(() => window.__game.team)
  check('the side picked in the lobby is the side you spawn on', team === 2, `game.team = ${team}`)

  // And the garage gives its context back rather than spinning behind a match.
  const afterA = await previewPixels(page)
  await wait(700)
  const afterB = await previewPixels(page)
  check(
    'the garage stops rendering once a match is running',
    afterA !== null && afterB !== null && afterA.hash === afterB.hash,
    'two samples 700ms apart, identical',
  )
  await page.close()

  // The control for that: while the lobby is still up, it does *not* hold
  // still. Without this, "identical" above would be satisfied by a preview
  // that never drew anything.
  const spinPage = await freshPage()
  await wait(600)
  const spinA = await previewPixels(spinPage)
  await wait(700)
  const spinB = await previewPixels(spinPage)
  check(
    'the control: on the lobby it is still turning',
    spinA !== null && spinB !== null && spinA.hash !== spinB.hash,
    `${spinA?.hash} then ${spinB?.hash}`,
  )

  // ------------------------------------------------------------- the garage

  const ink = await previewInk(spinPage)
  check(
    'there is a tank in the garage, not an empty canvas',
    ink.litFraction > 0.02 && ink.max > 140,
    JSON.stringify(ink),
  )

  // The claim that matters: the preview is driven by the finish. Chrome and
  // matte are the two furthest apart in `SKINS` — one is metal, one has no
  // sheen at all — so if the picker changed nothing, these two would match.
  //
  // The first version of this check compared how much of the canvas was lit and
  // very nearly shipped as a false negative: matte read 0.1258 against chrome's
  // 0.1292, a gap smaller than the frame-to-frame wobble of a tank that is
  // *turning*. The metric was measuring rotation, not finish. Saturation of the
  // lit pixels is what actually separates them — a metal hull takes the hue out
  // of itself — and the sample spread underneath is the control that says so.
  await spinPage.click('#skin-finish button[data-value="matte"]')
  await wait(500)
  const matte = await previewSeries(spinPage)
  await spinPage.click('#skin-finish button[data-value="chrome"]')
  await wait(500)
  const chrome = await previewSeries(spinPage)
  const noise = Math.max(matte.spread, chrome.spread)
  check(
    'and the finish you pick is the finish it shows',
    Math.abs(matte.mean - chrome.mean) > 4 * noise,
    `matte ${matte.mean.toFixed(4)} against chrome ${chrome.mean.toFixed(4)}, ` +
      `with the tank's own wobble at ${noise.toFixed(4)}`,
  )
  check(
    'the blurb follows the picker too',
    /chrome|mirror|polish/i.test(await spinPage.evaluate(() =>
      document.getElementById('skin-blurb').textContent ?? '')),
    await spinPage.evaluate(() => document.getElementById('skin-blurb').textContent),
  )

  // The pattern axis, same discipline as the finish axis above: measured on
  // the pixels, not the model. A camo hull is blotches in several tones, so
  // the lightness VARIANCE of the lit pixels separates it from a solid hull
  // the way saturation separated chrome from matte — and like there, the
  // wobble of a turning tank is sampled as the control.
  const litLightSd = () =>
    spinPage.evaluate(() => {
      const c = document.getElementById('tank-cam')
      const off = document.createElement('canvas')
      off.width = c.width
      off.height = c.height
      const ctx = off.getContext('2d')
      ctx.drawImage(c, 0, 0)
      const { data } = ctx.getImageData(0, 0, off.width, off.height)
      let n = 0
      let mean = 0
      let m2 = 0
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        if ((r + g + b) / 3 <= 90) continue
        const l = (Math.max(r, g, b) + Math.min(r, g, b)) / 2
        n++
        const d = l - mean
        mean += d / n
        m2 += d * (l - mean)
      }
      return Math.sqrt(m2 / Math.max(1, n))
    })
  const sdSeries = async () => {
    const a = await litLightSd()
    await wait(400)
    const b = await litLightSd()
    return { mean: (a + b) / 2, spread: Math.abs(a - b) }
  }
  await spinPage.click('#skin-pattern button[data-value="solid"]')
  await spinPage.click('#skin-finish button[data-value="plastic"]')
  await wait(500)
  const solidSd = await sdSeries()
  await spinPage.click('#skin-pattern button[data-value="tiger"]')
  await wait(500)
  const tigerSd = await sdSeries()
  const sdNoise = Math.max(solidSd.spread, tigerSd.spread, 0.5)
  check(
    'and the pattern you pick is painted on the tank it shows',
    tigerSd.mean - solidSd.mean > 4 * sdNoise,
    `solid sd ${solidSd.mean.toFixed(2)} against tiger ${tigerSd.mean.toFixed(2)}, wobble ${sdNoise.toFixed(2)}`,
  )
  check(
    'and the garage admits it cannot know your colour',
    /npub/i.test(await spinPage.evaluate(() =>
      document.getElementById('garage-note').textContent ?? '')),
  )
  await spinPage.close()

  // ------------------------------------------------------------ it is remembered

  const memoryPage = await freshPage()
  await memoryPage.click('#mode-tdm')
  await memoryPage.click('#side button[data-value="4"]')
  await memoryPage.reload({ waitUntil: 'domcontentloaded' })
  await wait(400)
  const remembered = await memoryPage.evaluate(() => ({
    tdm: document.getElementById('mode-tdm').classList.contains('on'),
    sideShown: !document.getElementById('row-side').hidden,
    picked: [...document.querySelectorAll('#side button')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.dataset.value),
  }))
  check(
    'the mode and the side survive a reload',
    remembered.tdm && remembered.sideShown && remembered.picked[0] === '4',
    JSON.stringify(remembered),
  )

  // Back to a deathmatch, and that has to reach the game as well — a toggle
  // tested in one direction is half a toggle.
  await memoryPage.click('#mode-dm')
  const sideGone = await memoryPage.evaluate(() => document.getElementById('row-side').hidden)
  check('going back to a deathmatch takes the side picker away', sideGone === true)
  await memoryPage.type('#name', 'ffa')
  await memoryPage.type('#room', 'ffa' + Math.floor(Math.random() * 1e6))
  await memoryPage.click('#play-guest')
  await memoryPage.waitForFunction(() => !!window.__game, { timeout: 25_000 }).catch(() => {})
  const ffaTeam = await memoryPage.evaluate(() => window.__game?.team)
  check('and a deathmatch spawns you on nobody’s side', ffaTeam === 0, `game.team = ${ffaTeam}`)
  await memoryPage.close()

  // ------------------------------------------------------------------ a phone

  const phone = await freshPage(390, 844)
  await phone.evaluate(() => window.scrollTo(0, 0))
  const fit = await phone.evaluate(() => {
    const card = document.querySelector('#lobby .card')
    const r = card.getBoundingClientRect()
    const spill = [...document.querySelectorAll('#modes .mode, #tank-cam')].filter((el) => {
      const b = el.getBoundingClientRect()
      return b.right > r.right + 1 || b.left < r.left - 1
    }).map((el) => el.id || el.className)
    return { left: Math.round(r.left), right: Math.round(r.right), vw: innerWidth, spill }
  })
  check('the hub fits a phone', fit.right <= fit.vw && fit.left >= 0, JSON.stringify(fit))
  check('and no mode card or preview hangs off the side of it', fit.spill.length === 0,
    JSON.stringify(fit.spill))
  const phoneInk = await until(async () => {
    const v = await previewInk(phone)
    return v.litFraction > 0.02 ? v : null
  })
  check('the tank renders on a phone too', !!phoneInk, JSON.stringify(phoneInk))
  if (process.env.TANK_PHONE_SHOT) {
    await phone.screenshot({ path: process.env.TANK_PHONE_SHOT, fullPage: true })
    console.log(`      wrote ${process.env.TANK_PHONE_SHOT}`)
  }
  await phone.close()
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
console.log('All hub checks passed.')
