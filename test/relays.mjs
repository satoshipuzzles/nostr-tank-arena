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

// The fakes are plain `ws://` on localhost, and a browser will not open one from
// an https page — mixed content, blocked, and the failure surfaces as a socket
// that never answers. Which is genuinely indistinguishable from the silent
// relay this suite deliberately stands up, so against a deployed build every
// relay reads as `no-verdict` and sixteen checks fail for a reason that has
// nothing to do with the client.
//
// Skipped loudly rather than quietly. A suite that prints "passed" without
// having observed anything is the failure this whole file exists to catch.
if (!/^http:\/\/(localhost|127\.0\.0\.1)/.test(URL)) {
  console.log(`SKIP  relay behaviour needs a plain-http origin; TANK_URL is ${URL}`)
  console.log('      ws:// fakes are blocked as mixed content from https, so every')
  console.log('      relay would read as silent and nothing would actually be tested.')
  console.log('      Run it against `npm run preview` instead.')
  process.exit(0)
}

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
  // newlay's per-event moderation gate. The reason contains the words "timed
  // out", which an earlier substring-first classifier read as silence — so the
  // single most explicit per-pubkey refusal there is could never mute.
  timedout: () => ({ ok: false, msg: 'restricted: you are timed out until 1799999999' }),
  // The relay already has the event. A rejected promise, but not a failure.
  duplicate: () => ({ ok: false, msg: 'duplicate: already have this event' }),
  // NIP-01's catch-all. Ambiguous, and muting is the destructive direction.
  unknownerr: () => ({ ok: false, msg: 'error: unknown error' }),
  // newlay's per-IP gate. Same `rate-limited:` prefix, deliberately no figure —
  // that absence is the discriminator between a cap two sockets would fix and
  // one they would not, so there is nothing here to pace to.
  perip: () => ({ ok: false, msg: 'rate-limited: too many events from your IP; slow down' }),
  // newlay's ninth reject prefix, which is not in NIP-01.
  muted: () => ({ ok: false, msg: 'mute: you have been muted by a moderator' }),
  silent: () => null, // accept the frame, answer nothing, ever
}

const servers = []

/**
 * A relay with a real token bucket, which is the only way to reproduce the
 * behaviour that matters: newlay's bucket refills continuously, so a client
 * hammering past the cap gets a steady *trickle* of acceptances rather than a
 * clean run of refusals. That trickle is what resets the consecutive-strike
 * counter, which is why the relay never gets muted and the client hammers it
 * all session — the thing pacing exists to stop.
 */
function startBucketRelay(perMin) {
  const wss = new WebSocketServer({ port: 0 })
  const state = { behaviour: 'bucket', received: 0, accepted: 0, connections: 0, perMin }
  let tokens = perMin
  let last = Date.now()
  wss.on('connection', (ws) => {
    state.connections++
    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg[0] === 'REQ') return ws.send(JSON.stringify(['EOSE', msg[1]]))
      if (msg[0] !== 'EVENT') return
      state.received++
      const now = Date.now()
      tokens = Math.min(perMin, tokens + ((now - last) / 60_000) * perMin)
      last = now
      if (tokens >= 1) {
        tokens -= 1
        state.accepted++
        return ws.send(JSON.stringify(['OK', msg[1].id, true, '']))
      }
      ws.send(JSON.stringify([
        'OK', msg[1].id, false,
        `rate-limited: publishing too fast (limit ${perMin} events/min); slow down or AUTH for higher limits`,
      ]))
    })
  })
  servers.push(wss)
  state.url = `ws://localhost:${wss.address().port}`
  return state
}

function startRelay(behaviour) {
  const wss = new WebSocketServer({ port: 0 })
  const state = { behaviour, received: 0, accepted: 0, connections: 0 }
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
const timedout = startRelay('timedout')
const duplicate = startRelay('duplicate')
const unknownerr = startRelay('unknownerr')
const perip = startRelay('perip')
const moderated = startRelay('muted')
const bucket = startBucketRelay(60)
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
  const list = [
    good.url, limited.url, pow.url, blocked.url,
    expired.url, timedout.url, duplicate.url, unknownerr.url,
    perip.url, moderated.url, bucket.url, silent.url,
  ].join('\n')
  await page.$eval('#relays', (el, v) => { el.value = v }, list)
  await page.type('#name', 'relaytest')
  await page.type('#room', 'rl' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  check('game starts against twelve fake relays', started)
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
          moderated: window.__classifyFailure('restricted: you are timed out until 1799999999'),
          ipconns: window.__classifyFailure('rate-limited: too many open connections from your IP'),
          connfast: window.__classifyFailure('rate-limited: connection attempts too fast; slow down'),
          authreq: window.__classifyFailure('auth-required: we only accept authenticated events'),
          dupe: window.__classifyFailure('duplicate: already have this event'),
          catchall: window.__classifyFailure('error: unknown error'),
          gibberish: window.__classifyFailure('something nobody has ever seen'),
          moderatorMute: window.__classifyFailure('mute: you have been muted by a moderator'),
          timeout: window.__classifyFailure('publish timed out'),
          socket: window.__classifyFailure('WebSocket connection closed'),
          expired: window.__classifyFailure('invalid: event expired'),
          badsig: window.__classifyFailure('invalid: bad signature'),
        }
      : null,
  )
  const rl = await page.evaluate(() =>
    window.__parseRateLimit
      ? {
          newlay: window.__parseRateLimit(
            'rate-limited: publishing too fast (limit 180 events/min); slow down or AUTH for higher limits',
          ),
          configured: window.__parseRateLimit('rate-limited: publishing too fast (limit 1800 events/min)'),
          perip: window.__parseRateLimit('rate-limited: too many events from your IP; slow down'),
          conns: window.__parseRateLimit('rate-limited: too many open connections from your IP'),
          nonsense: window.__parseRateLimit('blocked: spam not permitted'),
        }
      : null,
  )
  if (rl) {
    check('the effective cap is read out of the refusal', rl.newlay === 180, String(rl.newlay))
    check('...whatever the number is', rl.configured === 1800, String(rl.configured))
    // The absence of a figure is the per-IP signal, and per-IP is the cap that
    // two sockets do nothing about — so it must not look like a paceable one.
    check('a per-IP refusal carries no number', rl.perip === null, String(rl.perip))
    check('nor does the connection-count refusal', rl.conns === null, String(rl.conns))
    check('and a non-rate refusal carries none', rl.nonsense === null, String(rl.nonsense))
  } else {
    check('parseRateLimit is reachable for testing', false, 'window.__parseRateLimit missing')
  }

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
    // The prefix has to win over any word inside the message. All three of
    // these contain a substring an earlier version matched on first.
    check(
      'a moderation timeout is a refusal, not silence',
      cls.moderated === 'refused',
      `${cls.moderated} — the reason contains "timed out"`,
    )
    check(
      'too many connections is a refusal, not silence',
      cls.ipconns === 'refused',
      `${cls.ipconns} — the reason contains "connection"`,
    )
    check(
      'connecting too fast is a refusal, not silence',
      cls.connfast === 'refused',
      `${cls.connfast} — the reason contains "connection"`,
    )
    check('auth-required is a refusal', cls.authreq === 'refused', cls.authreq)
    check(
      'a duplicate is not a failure at all — the relay has the event',
      cls.dupe === 'accepted',
      cls.dupe,
    )
    check(
      "NIP-01's catch-all does not mute",
      cls.catchall === 'unknown',
      `${cls.catchall} — "error:" means "any other reason"`,
    )
    check(
      'an unrecognised message defaults to not muting',
      cls.gibberish === 'unknown',
      cls.gibberish,
    )
    check(
      "newlay's ninth prefix is a refusal, not an unknown",
      cls.moderatorMute === 'refused',
      `${cls.moderatorMute} — "mute:" is not in NIP-01`,
    )
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
    'the moderation-timeout relay IS muted — it refused us by name',
    state.muted.includes(timedout.url),
    state.muted.includes(timedout.url) ? '' : 'still publishing to a relay that told us to stop',
  )
  check(
    'the duplicate-reporting relay is NOT muted',
    !state.muted.includes(duplicate.url),
    state.muted.includes(duplicate.url) ? 'MUTED — struck for already having our event' : 'never muted',
  )
  check(
    'the per-IP relay IS muted — no number means nothing to pace to',
    state.muted.includes(perip.url),
    state.muted.includes(perip.url) ? '' : 'still hammering a per-IP cap',
  )
  check(
    'the moderator-mute relay IS muted',
    state.muted.includes(moderated.url),
    state.muted.includes(moderated.url) ? '' : '"mute:" fell through the prefix set',
  )
  check(
    'the catch-all-error relay is NOT muted',
    !state.muted.includes(unknownerr.url),
    state.muted.includes(unknownerr.url) ? 'MUTED — struck on an unparsed reason' : 'never muted',
  )
  check(
    'we keep publishing to the duplicate-reporting relay',
    duplicate.received > 20,
    `${duplicate.received} received`,
  )
  if (hasLedger) {
    const d = led(duplicate.url)
    check('a duplicate counts as accepted, not rejected', d.accepted > 20 && d.refused === 0, `${d.accepted} accepted, ${d.refused} refused`)
    check('the catch-all lands in its own bucket', led(unknownerr.url).unknown > 10, `${led(unknownerr.url).unknown} unknown`)
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

  // --------------------------------------------------------------- pacing
  //
  // The bucket relay caps at 60 events/min and refills continuously. Hammering
  // it produces a trickle of acceptances rather than a run of refusals, so the
  // strike counter keeps resetting and it is never muted — the client just
  // pounds it all session at a low accept rate, and every refusal is a −2 on a
  // behaviour score that only recovers during a clean minute.
  //
  // Measured in a steady-state window, after the client has had time to see the
  // number and slow to it.

  const paceStart = { received: bucket.received, accepted: bucket.accepted }
  const PACE_WINDOW = 14_000
  await wait(PACE_WINDOW)
  const sent = bucket.received - paceStart.received
  const took = bucket.accepted - paceStart.accepted
  const perSec = sent / (PACE_WINDOW / 1000)
  const acceptPct = sent ? (took / sent) * 100 : 0
  console.log(
    `\n  bucket relay (cap 60/min = 1.0/s): ${perSec.toFixed(1)} sent/s, ${acceptPct.toFixed(0)}% accepted\n`,
  )

  // Sampled after the window rather than before it: pacing has to have settled
  // for "not muted" to mean anything.
  const state2 = await page.evaluate(() => {
    const n = window.__game.net
    return { muted: n.mutedRelays, ledger: n.ledger ? [...n.ledger.values()] : null }
  })

  // The cap is 1.0/s and we aim at 90% of it. Anything near the tick rate means
  // we are still hammering; anything near zero means we throttled ourselves off.
  check(
    'we slowed to roughly the cap the relay named',
    perSec > 0.4 && perSec < 2.2,
    `${perSec.toFixed(1)}/s against a 1.0/s cap`,
  )
  check(
    'and almost everything we send is now accepted',
    acceptPct > 65,
    `${acceptPct.toFixed(0)}% accepted`,
  )
  // Read this one alongside the two above, never on its own. It passes against
  // the code without pacing too — for the opposite reason: the bucket's trickle
  // of acceptances keeps resetting the strike counter, so the relay is never
  // muted *because* the client is hammering it. "Not muted" is the same
  // observation for a healthy pace and for an unchecked flood; only the rate
  // and the accept ratio tell them apart.
  check(
    'the rate-limiting relay is NOT muted — it told us its number',
    !state2.muted.includes(bucket.url),
    state2.muted.includes(bucket.url) ? 'MUTED instead of paced' : 'paced, still publishing',
  )
  if (hasLedger) {
    const b = state2.ledger?.find((l) => l.url === bucket.url)
    check(
      'the ledger records what we paced ourselves to',
      b && b.pacedTo > 0 && b.pacedTo <= 60,
      b ? `pacedTo ${b.pacedTo}/min` : 'no ledger entry',
    )
    check(
      'and the lowest cap the relay ever reported',
      b && b.lowestLimit === 60,
      b ? `lowest ${b.lowestLimit}/min` : 'no ledger entry',
    )
  }

  // ------------------------------------------------------------- recovery
  //
  // A mute is a wait, not a life sentence. Rather than idle for a real minute,
  // expire it directly and confirm the relay is published to again — the point
  // under test is that the mute is time-bounded and reversible at all.

  // Read the first mute's wait before expiring it, so the second can be
  // compared against a real number rather than an assumed 60s.
  const firstSpan = (await page.evaluate(
    (u) => {
      const m = window.__game.net.muted
      if (!(m instanceof Map)) return null
      const e = m.get(u)
      return e ? { span: e.span } : null
    },
    limited.url,
  )) ?? { span: 0 }
  check(
    'the first mute is the base wait',
    Math.abs(firstSpan.span - 60_000) < 1000,
    `${(firstSpan.span / 1000).toFixed(0)}s`,
  )

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
  // Assert on the wait, not the tally. `mutes` increments identically whether
  // the backoff doubled or not — which is how the first version of this file
  // shipped a backoff that never doubled and a check that reported success.
  const spans = await page.evaluate(
    (u) => {
      const m = window.__game.net.muted
      if (!(m instanceof Map)) return null
      const e = m.get(u)
      return e ? { remaining: e.until - Date.now(), span: e.span } : null
    },
    limited.url,
  )
  check(
    'the second mute waits longer than the first',
    spans !== null && spans.span > firstSpan.span * 1.5,
    spans === null ? 'no mute recorded' : `first ${(firstSpan.span / 1000).toFixed(0)}s, second ${(spans.span / 1000).toFixed(0)}s`,
  )
  // ------------------------------------- a real frame driving a real rollback
  //
  // Everything above asserts what `classifyFailure` returns. Nothing until here
  // ran a relay's actual words all the way through to a decision the *game*
  // makes — so the gap cowboy found was invisible to a green suite by
  // construction: the claim rollback keyed on `unanimouslyRefused`, which counts
  // policy refusals only, and a claim every relay answers `invalid: event
  // expired` produced `refused: 0` and never rolled anything back. That is the
  // one total publish failure anybody has actually observed.
  //
  // Every relay but the expired one is muted by hand, so the claim goes to
  // exactly one fake and comes back malformed from all of it.
  const rolled = await page.evaluate(
    async ([keep, height, mined]) => {
      const g = window.__game
      const far = Date.now() + 600_000
      for (const url of g.net.relays) {
        if (url !== keep) g.net.muted.set(url, { until: far, span: 600_000 })
      }
      window.__clock.accept({ height, hash: 'ab'.repeat(30) + '0301', time: mined })
      document.getElementById('podium').hidden = true
      await new Promise((r) => setTimeout(r, 1500))

      const pad = [...g.pickups.values()].find((p) => !p.taken && !g.spent.has(p.id))
      if (!pad) return { skipped: 'no pad' }
      g.tank.dead = false
      g.tank.hp = g.maxHp
      g.tank.x = pad.at.x
      g.tank.y = pad.at.y
      await new Promise((r) => setTimeout(r, 2500))
      return {
        id: pad.id,
        back: !!g.pickups.get(pad.id) && !g.pickups.get(pad.id).taken,
        refusedClaims: g.refusedClaims,
        malformed: g.net.ledger.get(keep)?.malformed ?? 0,
      }
    },
    [expired.url, 999_500, Math.floor(Date.now() / 1000)],
  )
  check(
    'a claim the relay answers `invalid: event expired` rolls the pad back',
    !rolled.skipped && rolled.back && rolled.refusedClaims >= 1,
    JSON.stringify(rolled),
  )
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
