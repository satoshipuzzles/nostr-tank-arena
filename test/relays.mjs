// How the client reacts to relays that behave badly, in four specific ways.
//
// This one does not use public relays. It stands up four fake ones on
// localhost that each fail a different way on purpose, because the behaviour
// under test is precisely what a relay does when it is unhappy — and you cannot
// ask a real relay to start rate-limiting on cue, or to accept an event and
// then never acknowledge it.
//
//   npm run build && npm run preview &
//   npm run test:relays
//
// The distinction being tested, restated because it is the whole point:
//
//   refused     OK false. The relay looked at the event and said no. A run of
//               these is a policy, and giving up on the relay is correct.
//   no-verdict  silence. No OK frame at all. The relay has not refused
//               anything — refusing is a frame — and purplerelay.com was
//               measured doing exactly this while still forwarding 98% of what
//               it never acknowledged.
//   malformed   `invalid: ...`. Our event was bad. Not the relay's fault, and
//               striking it for our own clock skew would mute the whole set.

import { existsSync } from 'node:fs'
import { WebSocketServer } from 'ws'
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

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// --------------------------------------------------------------- fake relays
//
// Just enough NIP-01 to be a relay: answer REQ with EOSE so subscriptions
// settle, and answer EVENT however this particular fake is supposed to.

const BEHAVIOURS = {
  good: () => ({ ok: true, msg: '' }),
  ratelimited: () => ({ ok: false, msg: 'rate-limited: slow down' }),
  pow: () => ({ ok: false, msg: 'pow: 28 bits needed' }),
  blocked: () => ({ ok: false, msg: 'blocked: spam not permitted' }),
  expired: () => ({ ok: false, msg: 'invalid: event expired' }),
  silent: () => null, // accept the frame, answer nothing, ever
}

const servers = []
function startRelay(behaviour) {
  const wss = new WebSocketServer({ port: 0 })
  const state = { behaviour, received: 0, connections: 0 }
  wss.on('connection', (ws) => {
    state.connections++
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg[0] === 'REQ') {
        ws.send(JSON.stringify(['EOSE', msg[1]]))
        return
      }
      if (msg[0] === 'EVENT') {
        state.received++
        const verdict = BEHAVIOURS[state.behaviour]()
        if (!verdict) return // silence, on purpose
        ws.send(JSON.stringify(['OK', msg[1].id, verdict.ok, verdict.msg]))
      }
    })
  })
  servers.push(wss)
  state.url = `ws://localhost:${wss.address().port}`
  return state
}

const good = startRelay('good')
const limited = startRelay('ratelimited')
const pow = startRelay('pow')
const blocked = startRelay('blocked')
const expired = startRelay('expired')
const silent = startRelay('silent')

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: [
    '--no-sandbox', '--window-size=1280,800',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--mute-audio',
  ],
})
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('  page error:', e.message))

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  // The lobby takes a relay list, so no source change is needed to point the
  // game at these. ws:// is only reachable because the preview is http://.
  const list = [good.url, limited.url, pow.url, blocked.url, expired.url, silent.url].join('\n')
  await page.$eval('#relays', (el, v) => { el.value = v }, list)
  await page.type('#name', 'relaytest')
  await page.type('#room', 'rl' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  check('game starts against six fake relays', started)
  if (!started) throw new Error('never reached the arena')

  const using = await page.evaluate(() => window.__game.net.relays)
  check('it is talking to the fakes, not the public set', using.every((u) => u.startsWith('ws://localhost')), using.length + ' relays')

  // ------------------------------------------------------- classification

  const cls = await page.evaluate(() =>
    window.__classifyFailure
      ? {
          rate: window.__classifyFailure('rate-limited: slow down'),
          pow: window.__classifyFailure('pow: 28 bits needed'),
          blocked: window.__classifyFailure('blocked: spam not permitted'),
          restricted: window.__classifyFailure("restricted: not in this relay's web of trust"),
          timeout: window.__classifyFailure('publish timed out'),
          socket: window.__classifyFailure('WebSocket connection closed'),
          expired: window.__classifyFailure('invalid: event expired'),
          badsig: window.__classifyFailure('invalid: bad signature'),
        }
      : null,
  )
  if (!cls) {
    check('classifyFailure is reachable for testing', false, 'window.__classifyFailure missing')
  } else {
    check('rate-limited counts as a refusal', cls.rate === 'refused', cls.rate)
    check('proof-of-work counts as a refusal', cls.pow === 'refused', cls.pow)
    check('blocked counts as a refusal', cls.blocked === 'refused', cls.blocked)
    check('web-of-trust counts as a refusal', cls.restricted === 'refused', cls.restricted)
    check('a timeout is not a refusal', cls.timeout === 'no-verdict', cls.timeout)
    check('a dropped socket is not a refusal', cls.socket === 'no-verdict', cls.socket)
    check('an expired event is our fault, not the relay\'s', cls.expired === 'malformed', cls.expired)
    check('a bad signature is our fault, not the relay\'s', cls.badsig === 'malformed', cls.badsig)
  }

  // ------------------------------------------------- what actually gets muted
  //
  // The game ticks at 10Hz, so fifteen consecutive refusals arrive in under two
  // seconds. Give every relay far longer than it needs to be given up on.

  await wait(12_000)

  // The ledger is new in this change. Read it if it is there and skip those
  // checks if it is not, so this suite still reports something meaningful when
  // pointed at the build from before the fix — the behaviour it is really
  // testing is which relays get muted, and that is observable either way.
  const state = await page.evaluate(() => {
    const n = window.__game.net
    return {
      muted: n.mutedRelays,
      ledger: n.ledger ? [...n.ledger.values()] : null,
      summary: n.troubleSummary(),
    }
  })
  const hasLedger = state.ledger !== null
  if (!hasLedger) console.log('  (no ledger on this build — running the mute checks only)')
  const led = (url) =>
    (hasLedger && state.ledger.find((l) => l.url === url)) ?? {
      accepted: 0, refused: 0, noVerdict: 0, malformed: 0, mutes: 0,
    }

  const g = led(good.url), l = led(limited.url), e = led(expired.url), s = led(silent.url)
  const pw = led(pow.url), bl = led(blocked.url)
  if (hasLedger) {
    console.log(
      `\n  ledger  good: ${g.accepted} ok | limited: ${l.refused} refused | expired: ${e.malformed} malformed | silent: ${s.noVerdict} no-verdict\n`,
    )
    check('the healthy relay is accepting', g.accepted > 20, `${g.accepted} accepted`)
  }
  check('the healthy relay is never muted', !state.muted.includes(good.url))
  check('we keep publishing to the healthy relay', good.received > 20, `${good.received} received`)

  for (const [label, url, entry] of [
    ['rate-limited', limited.url, l],
    ['proof-of-work', pow.url, pw],
    ['blocked', blocked.url, bl],
  ]) {
    if (hasLedger) {
      check(`the ${label} relay is counted as refusing`, entry.refused > 10, `${entry.refused} refused`)
    }
    check(`...and the ${label} one is muted for it`, state.muted.includes(url))
  }

  if (hasLedger) {
    check('the expired-event relay is counted as malformed', e.malformed > 10, `${e.malformed} malformed`)
  }
  check(
    '...and is NOT muted, because that is our bug not its policy',
    !state.muted.includes(expired.url),
    state.muted.includes(expired.url) ? 'MUTED — struck for our own bad event' : 'never muted',
  )

  if (hasLedger) {
    check('the silent relay is counted as no-verdict', s.noVerdict > 5, `${s.noVerdict} no-verdict`)
  }
  check(
    '...and is NOT muted, because silence is not a refusal',
    !state.muted.includes(silent.url),
    state.muted.includes(silent.url) ? 'MUTED — struck for not answering' : 'never muted',
  )

  // The relays kept receiving what we sent them, which is the other half of
  // "not muted" — it has to still be getting events, not just be absent from a
  // list. Counted server-side, so the client cannot flatter itself.
  check('we are still publishing to the silent relay', silent.received > 20, `${silent.received} received`)
  check('we are still publishing to the malformed-rejecting relay', expired.received > 20, `${expired.received} received`)

  check(
    'we stopped publishing to the muted one',
    limited.received < good.received,
    `${limited.received} vs ${good.received} to the healthy relay`,
  )

  check(
    'the HUD names the muted relay',
    state.summary.includes('localhost') && /refus/i.test(state.summary),
    JSON.stringify(state.summary),
  )

  // ------------------------------------------------------------- recovery
  //
  // A mute is a wait, not a life sentence. Rather than idle for a real minute,
  // expire it directly and confirm the relay is published to again — the point
  // under test is that the mute is time-bounded and reversible at all.

  const before = limited.received
  await page.evaluate(() => {
    const muted = window.__game.net.muted
    // Old builds used a Set of urls with no expiry at all; nothing to expire.
    if (muted instanceof Map) for (const m of muted.values()) m.until = Date.now() - 1
  })
  await wait(2500)
  check(
    'a muted relay is retried once its wait is up',
    limited.received > before,
    `${limited.received - before} more events after the mute expired`,
  )

  const remuted = await page.evaluate(() => window.__game.net.mutedRelays)
  check(
    'and is muted again if it is still refusing',
    remuted.includes(limited.url),
    remuted.length + ' muted',
  )
  if (hasLedger) {
    const after = await page.evaluate(
      (u) => [...window.__game.net.ledger.values()].find((l) => l.url === u),
      limited.url,
    )
    check('the backoff records the second mute', after.mutes >= 2, `${after.mutes} mutes`)
  }
} catch (err) {
  check('the run completed', false, err.message)
} finally {
  await browser.close()
  for (const wss of servers) wss.close()
}

console.log('')
if (failures.length) {
  console.error(`${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('All relay-behaviour checks passed.')
