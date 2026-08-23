// Does the game actually make a sound?
//
// This is a harder question than it looks, and the obvious test does not answer
// it. Asserting that `sfx.fire()` was called proves nothing: the two ways audio
// really breaks are a node that was never connected to the destination and a
// context that was never resumed, and both of those swallow every call without
// throwing. A green suite over that is worse than no suite.
//
// So this measures samples, in a real browser, three ways:
//
//   1. Every voice is rendered into an OfflineAudioContext and the resulting
//      buffer is measured for peak, RMS and audible duration.
//   2. The same render is repeated into a *disconnected* node. It must come
//      back silent — that is the proof that step 1 can fail, and it is checking
//      for exactly the mistake most likely to be made in that file.
//   3. The live AudioContext is tapped with an analyser and polled for signal,
//      and every construction of one is counted so that "no context exists
//      until a click makes one" is a checked fact rather than an intention.
//
// On the autoplay policy, honestly: Chrome under Puppeteer reports
// `navigator.userActivation.hasBeenActive === true` before anything is
// clicked, headless or headful, even with --autoplay-policy=user-gesture-
// required. So a context here always starts running and the suspended-context
// failure cannot be reproduced from this harness. What is checked instead is
// the invariant that prevents it: the page must not build an AudioContext
// until a user gesture has happened. That one does fail when it is broken.
//
//   npm run build && npm run preview &
//   npm run test:sound

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
  // Deliberately NOT --autoplay-policy=no-user-gesture-required. The click on
  // the Play button has to be what unlocks the context, because that is the
  // path a player takes and the one that silently fails if it is wired wrong.
]

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const round = (n, d = 3) => Number(n.toFixed(d))

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
  await page.waitForFunction(() => !!window.__voices, { timeout: 15_000 })

  // ---------------------------------------------------------------- offline

  const measured = await page.evaluate(async () => {
    // Measure one rendered buffer. Returned separately from the assertions so
    // the numbers land in the log even when a check fails.
    const analyse = (buf, sampleRate) => {
      const d = buf.getChannelData(0)
      let peak = 0
      let sumSq = 0
      let first = -1
      let last = -1
      let bad = 0
      for (let i = 0; i < d.length; i++) {
        const v = d[i]
        if (!Number.isFinite(v)) {
          bad++
          continue
        }
        const a = Math.abs(v)
        if (a > peak) peak = a
        sumSq += v * v
        // -54 dBFS. Below this is dither, not a sound anybody hears.
        if (a > 0.002) {
          if (first < 0) first = i
          last = i
        }
      }
      return {
        peak,
        rms: Math.sqrt(sumSq / d.length),
        bad,
        startsAt: first < 0 ? -1 : first / sampleRate,
        audibleFor: last < 0 ? 0 : (last - first) / sampleRate,
      }
    }

    const sr = 48_000
    const out = {}
    for (const [name, voice] of Object.entries(window.__voices)) {
      const ctx = new OfflineAudioContext(1, sr * 3, sr)
      const declaredEnd = voice(ctx, ctx.destination, 0)
      out[name] = { ...analyse(await ctx.startRendering(), sr), declaredEnd }
    }

    // The control. Same voices, same render, but into a gain node that was
    // never connected onward — the "forgot to .connect(dest)" bug. If this
    // comes back with signal, every measurement above is meaningless.
    const orphan = {}
    for (const [name, voice] of Object.entries(window.__voices)) {
      const ctx = new OfflineAudioContext(1, sr, sr)
      voice(ctx, ctx.createGain(), 0)
      orphan[name] = analyse(await ctx.startRendering(), sr).peak
    }

    return { out, orphan }
  })

  const names = Object.keys(measured.out)
  check('every voice is exported and renderable', names.length >= 10, `${names.length} voices`)

  for (const name of names) {
    const m = measured.out[name]
    const detail = `peak ${round(m.peak)} rms ${round(m.rms, 4)} audible ${round(m.audibleFor)}s of ${round(m.declaredEnd)}s`
    check(`${name}: produces signal`, m.peak > 0.01 && m.rms > 0.0004, detail)
    check(`${name}: no NaN or Inf samples`, m.bad === 0, m.bad ? `${m.bad} bad samples` : '')
    check(`${name}: does not clip`, m.peak <= 1.5, `peak ${round(m.peak)}`)
    check(`${name}: starts immediately`, m.startsAt >= 0 && m.startsAt < 0.06, `${round(m.startsAt)}s`)
    // The envelope has to close when the voice says it does. A note that runs
    // long is how a game ends up with a permanent drone nobody can locate.
    check(
      `${name}: envelope closes on schedule`,
      m.audibleFor > 0.02 && m.audibleFor <= m.declaredEnd + 0.25,
      `${round(m.audibleFor)}s vs declared ${round(m.declaredEnd)}s`,
    )
  }

  const leaky = names.filter((n) => measured.orphan[n] > 0.0001)
  check(
    'control: a disconnected destination renders silence',
    leaky.length === 0,
    leaky.length ? `leaked: ${leaky.join(', ')}` : 'so the checks above can fail',
  )

  // Two voices that are supposed to sound different should measure different.
  // Catches the copy-paste where a new voice is a duplicate of its neighbour.
  const fingerprint = (n) => `${round(measured.out[n].rms, 4)}:${round(measured.out[n].audibleFor, 2)}`
  const prints = new Map()
  for (const n of names) {
    const f = fingerprint(n)
    prints.set(f, [...(prints.get(f) ?? []), n])
  }
  const dupes = [...prints.values()].filter((g) => g.length > 1)
  check(
    'voices are distinguishable from each other',
    dupes.length === 0,
    dupes.length ? `identical: ${dupes.map((g) => g.join('/')).join(', ')}` : '',
  )

  // ------------------------------------------------------------- into a match
  //
  // The Play button is the real unlock: it is the click that creates and
  // resumes the context, and until it happens the HUD (and the mute button) is
  // hidden. So the live checks below run inside a started match, which is the
  // only state a player is ever in when a sound is wanted.

  // Before anything is clicked there must be no context at all. A page that
  // builds one at module load gets a suspended context in a real browser and
  // plays nothing, forever, with no error anywhere.
  const builtEarly = await page.evaluate(() => window.__ctxBuilt)
  check('no AudioContext exists before a gesture', builtEarly === 0, `${builtEarly} built`)

  await page.type('#name', 'sfxtest')
  await page.type('#room', 'sfx' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game, { timeout: 20_000 })
    .then(() => true)
    .catch(() => false)
  check('game starts as guest', started, started ? '' : 'never reached the arena')
  const builtAfter = await page.evaluate(() => window.__ctxBuilt)
  check('the Play click builds exactly one context', builtAfter === 1, `${builtAfter} built`)
  if (!started) throw new Error('cannot run the live checks without a match')

  // ------------------------------------------------------------------- live

  const live = await page.evaluate(async () => {
    const sfx = window.__sfx
    if (!sfx) return { error: 'no __sfx after the Play click' }
    const ctx = sfx.ctx
    if (!ctx) return { available: false, state: 'none', peak: 0, muted: sfx.muted }

    // Tap into a MediaStreamDestination rather than the speakers: this is a
    // measurement, and it should not depend on the machine having an output.
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    analyser.connect(ctx.createMediaStreamDestination())
    window.__voices.block(ctx, analyser, ctx.currentTime + 0.02)

    const frame = new Float32Array(analyser.fftSize)
    let peak = 0
    const until = performance.now() + 900
    while (performance.now() < until) {
      analyser.getFloatTimeDomainData(frame)
      for (const v of frame) if (Math.abs(v) > peak) peak = Math.abs(v)
      await new Promise((r) => setTimeout(r, 20))
    }
    return { available: sfx.available, state: ctx.state, peak, muted: sfx.muted, wired: sfx === window.__game.sfx }
  })

  if (live.error) {
    check('live: the Play click creates a context', false, live.error)
  } else {
    check('live: browser gave us an AudioContext', live.available === true)
    check('live: it is running, not suspended', live.state === 'running', `state ${live.state}`)
    check('live: the game holds that same context', live.wired === true)
    check('live: it starts unmuted', live.muted === false)
    // The one that offline rendering cannot answer: is the real audio clock
    // advancing and carrying signal?
    check('live: real context produces signal', live.peak > 0.005, `peak ${round(live.peak)}`)
  }

  // The mute button, now that the HUD is up.
  await page.click('#sound-toggle')
  await wait(120)
  const muted = await page.evaluate(() => ({
    flag: window.__sfx.muted,
    stored: localStorage.getItem('tank.sound'),
    label: document.getElementById('sound-toggle').textContent.trim(),
  }))
  check('mute: the button mutes', muted.flag === true, `label "${muted.label}"`)
  check('mute: it survives a reload', muted.stored === 'off', `tank.sound=${muted.stored}`)

  // 'M' is the other half of the same switch.
  await page.keyboard.press('m')
  await wait(120)
  const unmuted = await page.evaluate(() => ({
    flag: window.__sfx.muted,
    label: document.getElementById('sound-toggle').textContent.trim(),
  }))
  check('mute: M toggles it back', unmuted.flag === false, `label "${unmuted.label}"`)

  // ---------------------------------------------------------------- wiring
  //
  // Voices that work and a game that never calls them is the other half of the
  // failure. Drive one real frame with the fire button held and watch for it.
  // This replaces game.sfx, so it has to be the last thing that happens.

  const wiring = await page.evaluate(async () => {
    const game = window.__game
    const calls = []
    const record = (name) =>
      (...args) =>
        calls.push({ name, args })
    // Stand in for the real Sfx. Everything the game is allowed to call.
    game.sfx = {
      listener: { x: 0, y: 0 },
      fire: record('fire'),
      remoteFire: record('remoteFire'),
      struck: record('struck'),
      hit: record('hit'),
      death: record('death'),
      remoteDeath: record('remoteDeath'),
      kill: record('kill'),
      streak: record('streak'),
      repair: record('repair'),
      respawn: record('respawn'),
      pickup: record('pickup'),
      block: record('block'),
      engine: record('engine'),
    }

    const held = { throttle: 1, steer: 0, aim: null, fire: true }
    game.tank.dead = false
    game.tank.reloadAt = 0
    game.update(0.016, held)

    const beforeBlock = calls.length
    game.endRound((game.round || 1) + 1, 'Crossroads')

    return {
      names: [...new Set(calls.map((c) => c.name))],
      engineArgs: calls.find((c) => c.name === 'engine')?.args ?? null,
      blockAfter: calls.slice(beforeBlock).map((c) => c.name),
      listener: game.sfx.listener,
      tank: { x: game.tank.x, y: game.tank.y },
    }
  })

  check('wiring: firing plays the gun', wiring.names.includes('fire'), wiring.names.join(', '))
  check(
    'wiring: the engine is driven every frame',
    wiring.names.includes('engine') && wiring.engineArgs?.[0] === 1 && wiring.engineArgs?.[1] === true,
    `engine(${wiring.engineArgs?.join(', ')})`,
  )
  check(
    'wiring: the listener follows the tank',
    Math.abs(wiring.listener.x - wiring.tank.x) < 1 && Math.abs(wiring.listener.y - wiring.tank.y) < 1,
    `listener ${round(wiring.listener.x, 1)},${round(wiring.listener.y, 1)} tank ${round(wiring.tank.x, 1)},${round(wiring.tank.y, 1)}`,
  )
  check(
    'wiring: a new block rings the bell',
    wiring.blockAfter.includes('block'),
    wiring.blockAfter.join(', ') || 'nothing',
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
