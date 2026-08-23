// Does the game actually make a sound?
//
// `two-player.mjs` already checks that the game *asks* for sounds, which is the
// right check for the netcode side of audio. This is the other half, and it is
// the half that catches silence.
//
// The two ways Web Audio really fails are a node nobody connected to the
// destination and a context nobody resumed. Both of those accept every
// scheduling call without throwing, so a spy on the sink stays green while the
// game plays nothing at all. The only way to tell the difference is to look at
// samples.
//
// So this taps the master gain with an analyser and measures what comes out of
// `Sfx.play()` for real — through the panner, the distance falloff, the
// envelopes and the mute, in a live browser. Nothing in `src/` changes.
//
//   npm run build && npm run preview &
//   npm run test:sound
//
// ## On the autoplay policy, honestly
//
// This suite deliberately does NOT pass --autoplay-policy=no-user-gesture-
// required, and it still cannot prove the gesture rule. Chrome under Puppeteer
// reports `navigator.userActivation.hasBeenActive === true` before anything is
// clicked — headless, headful, and even with `user-gesture-required` set — so a
// context here always starts running whatever the page does. An assertion that
// cannot fail is not worth the line it is written on.
//
// What is checked instead is the invariant that produces the right outcome: the
// page must not construct an AudioContext until a gesture has happened. Every
// construction is counted from before the page's own scripts run. That one does
// fail when it is broken, which is the whole point.

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL = process.env.TANK_URL ?? 'http://localhost:4173/'

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
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

/** Every member of the `Sound` union in src/audio.ts. */
const SOUNDS = [
  'fire', 'hit', 'shield', 'kill', 'death',
  'pickup', 'scatter', 'siege', 'streak', 'block', 'respawn',
]

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}
const round = (n, d = 4) => Number(n.toFixed(d))

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS })
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('  page error:', e.message))

try {
  // Count every AudioContext the page builds, from before its scripts run.
  await page.evaluateOnNewDocument(() => {
    const Real = window.AudioContext
    window.__ctxBuilt = 0
    window.AudioContext = class extends Real {
      constructor(...args) {
        super(...args)
        window.__ctxBuilt++
      }
    }
  })
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForSelector('#play-guest')

  // `new Sfx()` happens at module load, and that is fine — it only reads
  // localStorage. What must not happen at module load is the context itself.
  const builtEarly = await page.evaluate(() => window.__ctxBuilt)
  check('no AudioContext exists before a gesture', builtEarly === 0, `${builtEarly} built`)

  await page.type('#name', 'sfxtest')
  await page.type('#room', 'sfx' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game && !!window.__sfx, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  check('game starts as guest', started, started ? '' : 'never reached the arena')
  if (!started) throw new Error('cannot measure audio without a match')

  const builtAfter = await page.evaluate(() => window.__ctxBuilt)
  check('the Play click builds exactly one context', builtAfter === 1, `${builtAfter} built`)

  const state = await page.evaluate(() => ({
    running: window.__sfx.running,
    muted: window.__sfx.muted,
    hasMaster: !!window.__sfx.master,
  }))
  check('it is running, not suspended', state.running === true)
  check('it starts unmuted', state.muted === false)
  check(
    'the master gain is reachable for tapping',
    state.hasMaster,
    state.hasMaster ? '' : 'Sfx.master was renamed — this suite needs updating',
  )
  if (!state.hasMaster) throw new Error('no master gain to tap')

  // Tap the master output with an AudioWorklet.
  //
  // An analyser polled from requestAnimationFrame is the obvious way to do
  // this and it does not work: under swiftshader the page runs at about six
  // frames a second, so a 140ms gunshot falls entirely between two polls and
  // measures as silence. The first version of this suite reported nine failures
  // that were all the harness missing the sound rather than the sound missing.
  // A worklet runs on the audio thread and sees every sample.
  await page.evaluate(async () => {
    const sfx = window.__sfx
    const ctx = sfx.ctx ?? sfx.master.context
    const source = `
      class Tap extends AudioWorkletProcessor {
        constructor() {
          super()
          this.reset()
          this.port.onmessage = (e) => {
            if (e.data === 'reset') return this.reset()
            this.port.postMessage({
              peak: this.peak,
              rms: this.n ? Math.sqrt(this.sumSq / this.n) : 0,
              startedAfterMs: this.first < 0 ? -1 : (this.first / sampleRate) * 1000,
              audibleForMs: this.last < 0 ? 0 : ((this.last - this.first) / sampleRate) * 1000,
            })
          }
        }
        reset() { this.peak = 0; this.sumSq = 0; this.n = 0; this.first = -1; this.last = -1 }
        process(inputs) {
          const ch = inputs[0] && inputs[0][0]
          if (!ch) { this.n += 128; return true }
          for (let i = 0; i < ch.length; i++) {
            const v = ch[i]
            const a = v < 0 ? -v : v
            if (a > this.peak) this.peak = a
            this.sumSq += v * v
            // -54 dBFS. Below this is dither, not something anybody hears.
            if (a > 0.002) { if (this.first < 0) this.first = this.n; this.last = this.n }
            this.n++
          }
          return true
        }
      }
      registerProcessor('tap', Tap)
    `
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    await ctx.audioWorklet.addModule(url)
    const tap = new AudioWorkletNode(ctx, 'tap')
    // An extra connection from master does not change what the speakers get,
    // so this measures the real signal path: envelopes, panner, distance
    // falloff and the mute gain all included. The silent leg to the
    // destination is only there because a node nothing pulls is never run.
    const silent = ctx.createGain()
    silent.gain.value = 0
    sfx.master.connect(tap)
    tap.connect(silent).connect(ctx.destination)

    window.__measure = (sound, opts, budgetMs = 2200) =>
      new Promise((resolve) => {
        tap.port.postMessage('reset')
        sfx.play(sound, opts)
        setTimeout(() => {
          tap.port.onmessage = (e) => resolve(e.data)
          tap.port.postMessage('read')
        }, budgetMs)
      })
  })

  // ------------------------------------------------------------ every voice

  for (const sound of SOUNDS) {
    const m = await page.evaluate((s) => window.__measure(s, {}, s === 'block' ? 2200 : 1200), sound)
    check(
      `${sound}: reaches the master bus`,
      m.peak > 0.005 && m.rms > 0.0002,
      `peak ${round(m.peak)} rms ${round(m.rms)} audible ${Math.round(m.audibleForMs)}ms`,
    )
    check(`${sound}: does not clip`, m.peak <= 1.2, `peak ${round(m.peak)}`)
    check(
      `${sound}: starts promptly and stops`,
      m.startedAfterMs >= 0 && m.startedAfterMs < 120 && m.audibleForMs < 2000,
      `starts +${Math.round(m.startedAfterMs)}ms, lasts ${Math.round(m.audibleForMs)}ms`,
    )
  }

  // -------------------------------------------------------------- controls
  //
  // Three ways the measurement above is required to return zero. Without these
  // it is only known that the number is large, not that it means anything.

  const far = await page.evaluate(() =>
    window.__measure('fire', { at: { x: 0, y: 0 }, ear: { x: 4000, y: 4000 } }, 900),
  )
  check(
    'control: a sound past earshot is silent',
    far.peak < 0.002,
    `peak ${round(far.peak)} — proves distance falloff gates it`,
  )

  const near = await page.evaluate(() =>
    window.__measure('fire', { at: { x: 100, y: 100 }, ear: { x: 120, y: 120 } }, 900),
  )
  check('control: the same sound up close is loud', near.peak > 0.005, `peak ${round(near.peak)}`)
  check(
    'distance actually attenuates',
    near.peak > far.peak * 20,
    `near ${round(near.peak)} vs far ${round(far.peak)}`,
  )

  await page.click('#sound-toggle')
  const whileMuted = await page.evaluate(async () => {
    const results = []
    for (const s of ['fire', 'death', 'block']) results.push(await window.__measure(s, {}, 900))
    return { muted: window.__sfx.muted, peak: Math.max(...results.map((r) => r.peak)) }
  })
  check('mute: the button mutes', whileMuted.muted === true)
  check(
    'control: nothing reaches the bus while muted',
    whileMuted.peak < 0.002,
    `peak ${round(whileMuted.peak)}`,
  )

  // 'M' is the other half of the same switch.
  await page.keyboard.press('m')
  const afterUnmute = await page.evaluate(async () => ({
    muted: window.__sfx.muted,
    ...(await window.__measure('fire', {}, 900)),
  }))
  check('mute: M toggles it back', afterUnmute.muted === false)
  check(
    'sound returns after unmuting',
    afterUnmute.peak > 0.005,
    `peak ${round(afterUnmute.peak)} — toggle() has to rebuild the gain, not just the flag`,
  )

  // ---------------------------------------------------------------- wiring
  //
  // Voices that work and a game that never calls them is the other failure.
  // Drive one real frame with the fire button held. This replaces game.sfx, so
  // it goes last.

  const wiring = await page.evaluate((SOUNDS_IN_PAGE) => {
    const game = window.__game
    const heard = []
    game.sfx = (sound, opts) => heard.push({ sound, opts })

    game.tank.dead = false
    game.tank.reloadAt = 0
    game.update(0.016, { throttle: 1, steer: 0, aim: null, fire: true })
    const afterFrame = heard.length

    game.endRound((game.round || 1) + 1, 'Crossroads')
    return {
      fromFrame: heard.slice(0, afterFrame).map((h) => h.sound),
      fromBlock: heard.slice(afterFrame).map((h) => h.sound),
      unknown: heard.map((h) => h.sound).filter((s) => !SOUNDS_IN_PAGE.includes(s)),
    }
  }, SOUNDS)
  check('wiring: firing plays the gun', wiring.fromFrame.includes('fire'), wiring.fromFrame.join(', ') || 'nothing')
  check('wiring: a new block rings the bell', wiring.fromBlock.includes('block'), wiring.fromBlock.join(', ') || 'nothing')
  check(
    'wiring: the game only asks for sounds that exist',
    wiring.unknown.length === 0,
    wiring.unknown.length ? `unknown: ${wiring.unknown.join(', ')}` : '',
  )
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
console.log('All sound checks passed.')
