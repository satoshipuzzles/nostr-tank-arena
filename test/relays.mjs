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
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
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
/** Poll until it holds. See the tick check for why no fixed window works here. */
async function until(fn, ms = 12_000, step = 200) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() > deadline) return false
    await wait(step)
  }
}

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
  future: () => ({ ok: false, msg: 'invalid: created_at too far in the future' }),
  // strfry's wording, measured against relay.primal.net, purplerelay.com and
  // relay.mostr.pub. `too late` contains neither "future" nor "expired".
  strfryBehind: () => ({ ok: false, msg: 'invalid: ephemeral event expired' }),
  strfryAhead: () => ({ ok: false, msg: 'invalid: created_at too late' }),
  // Rejected on shape, before the relay ever looked at the timestamp.
  tagcount: () => ({ ok: false, msg: 'invalid: too many tags: 5' }),
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
  // Refuses everything, but names a cap far above the tick rate. So it gets
  // paced rather than muted, pacing never actually throttles it, and it stays
  // in every target set refusing forever — which is what a genuinely paced
  // relay looks like on a publish where the x1.1 probe has just overshot.
  fastlimit: () => ({
    ok: false,
    msg: 'rate-limited: publishing too fast (limit 6000 events/min); slow down or AUTH for higher limits',
  }),
  // newlay as cowboy measured it half an hour ago, with the exemption applied:
  // the four ephemeral netcode kinds are through the web-of-trust gate, and the
  // durable pickup claim is still behind it. Accepting ten events a second while
  // refusing one kind forever is the exact shape no counter in `nostr.ts` could
  // see, because a per-relay strike streak is reset by every tick that lands.
  wotexempt: (e) =>
    e.kind === 30078
      ? { ok: false, msg: "restricted: not in this relay's web of trust" }
      : { ok: true, msg: '' },
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
  const state = { behaviour: 'bucket', received: 0, accepted: 0, connections: 0, byKind: {}, perMin }
  let tokens = perMin
  let last = Date.now()
  // Lets a test raise the cap mid-run, which is the only way to check that the
  // probe still discovers a relay that has forgiven us — a "fix" that simply
  // stopped probing would pass every other check in this file.
  state.setCap = (n) => {
    state.perMin = n
    tokens = n
  }
  wss.on('connection', (ws) => {
    state.connections++
    ws.on('message', (raw) => {
      let msg
      try { msg = JSON.parse(raw.toString()) } catch { return }
      if (msg[0] === 'REQ') return ws.send(JSON.stringify(['EOSE', msg[1]]))
      if (msg[0] !== 'EVENT') return
      state.received++
      state.byKind[msg[1].kind] = (state.byKind[msg[1].kind] ?? 0) + 1
      const now = Date.now()
      tokens = Math.min(state.perMin, tokens + ((now - last) / 60_000) * state.perMin)
      last = now
      if (tokens >= 1) {
        tokens -= 1
        state.accepted++
        return ws.send(JSON.stringify(['OK', msg[1].id, true, '']))
      }
      ws.send(JSON.stringify([
        'OK', msg[1].id, false,
        `rate-limited: publishing too fast (limit ${state.perMin} events/min); slow down or AUTH for higher limits`,
      ]))
    })
  })
  servers.push(wss)
  state.url = `ws://localhost:${wss.address().port}`
  return state
}

function startRelay(behaviour, opts = {}) {
  const wss = new WebSocketServer(opts.port ? { port: opts.port } : { port: 0 })
  const state = {
    behaviour, received: 0, accepted: 0, connections: 0,
    // Per kind, because "received 40 events" cannot answer the only question a
    // kind-scoped policy raises: did the client stop sending the *one* kind
    // this relay refuses, and keep sending the rest.
    byKind: {},
    // Every `d` tag seen, so a check that hand-publishes addressable probes can
    // count *its own* events rather than a kind the game also emits — the
    // presence beacon is kind 30078 too, and it photobombed a count of eight
    // probe claims as "9 of 8" whenever the beacon timer fired in the window.
    dTags: [],
    closeSubs: !!opts.closeSubs,
    // Every REQ filter this relay was sent, so a test can see what the client
    // asked for rather than only what it did with the answer.
    reqFilters: [],
  }
  // sockets -> the subscription ids each has open, so this fake can push an
  // event the way a real relay does rather than only answering publishes.
  const subs = new Map()
  state.inject = (ev) => {
    let sent = 0
    for (const [ws, ids] of subs) {
      if (ws.readyState !== 1) continue
      for (const id of ids) { ws.send(JSON.stringify(['EVENT', id, ev])); sent++ }
    }
    return sent
  }
  /** Yank every socket out from under the client, the way a wifi change does. */
  state.dropAll = () => {
    let n = 0
    for (const ws of subs.keys()) if (ws.readyState === 1) { ws.terminate(); n++ }
    subs.clear()
    return n
  }
  wss.on('connection', (ws) => {
    state.connections++
    subs.set(ws, new Set())
    ws.on('close', () => subs.delete(ws))
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg[0] === 'CLOSE') { subs.get(ws)?.delete(msg[1]); return }
      if (msg[0] === 'REQ') {
        state.reqFilters.push(msg[2])
        if (!state.closeSubs) subs.get(ws)?.add(msg[1])
        // A relay can refuse to read the kinds it happily accepts writes for.
        // relay.fountain.fm answers exactly this for 21000, 21001, 21003 and
        // 30078 while returning `OK true` when you publish them.
        if (state.closeSubs) ws.send(JSON.stringify(['CLOSED', msg[1], 'kinds not supported']))
        else ws.send(JSON.stringify(['EOSE', msg[1]]))
        return
      }
      if (msg[0] === 'EVENT') {
        state.received++
        state.byKind[msg[1].kind] = (state.byKind[msg[1].kind] ?? 0) + 1
        const d = (msg[1].tags ?? []).find((t) => t[0] === 'd')
        if (d) state.dTags.push(d[1])
        const verdict = BEHAVIOURS[state.behaviour](msg[1])
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

  // The other direction, so "the alarm shows" cannot pass by always showing:
  // this session is publishing to twelve relays that mostly work, and the panel
  // must be absent from the page rather than merely empty.
  const quiet = await page.evaluate(() => {
    const n = document.getElementById('alarm')
    return { attr: n.hidden, display: getComputedStyle(n).display }
  })
  check('no clock alarm on a session whose events are landing',
    quiet.attr && quiet.display === 'none', JSON.stringify(quiet))

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
    // These two are HTTP 429 bodies, written before the websocket upgrade, so
    // they never reach a publish promise and never reach classifyFailure. The
    // rows are right and worth keeping — but their absence from a ledger is
    // evidence of nothing, so nobody should read it as a clean bill of health.
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
  const baseSpan = (await page.evaluate(
    (u) => {
      const m = window.__game.net.muted
      if (!(m instanceof Map)) return null
      const e = m.get(u)
      return e ? e.span : null
    },
    limited.url,
  )) ?? 0
  check(
    'the first mute is the base wait',
    Math.abs(baseSpan - 60_000) < 1000,
    `${(baseSpan / 1000).toFixed(0)}s`,
  )

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
    // The ledger knowing is not the player knowing. Pacing sheds exactly the
    // disposable state ticks that carry position and hull, so the HUD line
    // has to say it — by symptom and by number, while the pace is live. This
    // was the gap in the phantom-bot night: the client was tracking pacing
    // the whole time and nothing on screen ever said so.
    const pacedLine = await page.evaluate(() => window.__game.net.troubleSummary())
    check(
      'and the HUD line names the pacing, its number, and the symptom',
      /paced by /.test(pacedLine) && /\/min\)/.test(pacedLine) && /damage updates will lag/.test(pacedLine),
      JSON.stringify(pacedLine),
    )
    check(
      'and the lowest cap the relay ever reported',
      b && b.lowestLimit === 60,
      b ? `lowest ${b.lowestLimit}/min` : 'no ledger entry',
    )
  }

  // ------------------------------------------------- what the probe costs
  //
  // Pacing without probing is a ratchet, so there has to be a probe. But newlay
  // credits recovery per *clean minute* — one violation anywhere in a minute
  // and the minute is worth nothing, not a reduced amount — and for an
  // anonymous key that is the only recovery channel. So a probe that overshoots
  // often enough to dirty every minute pins the score at the floor and undoes
  // the thing pacing was for.
  //
  // The measurable form of that: refusals per minute against a relay whose cap
  // is not moving. A well-behaved pace produces almost none.

  // Measured in two segments, and only the second one is asserted on.
  //
  // `TokenBucket(perMin, perMin)` means the burst allowance is a whole minute's
  // worth, and pacing at 90% keeps it nearly full — so the first overshoot
  // spends banked tokens rather than tripping policy, and draws no refusal for
  // a minute and a half. A window that stops there reports a relay that is
  // perfectly happy about a client that is about to be throttled into the
  // floor. The bank is gone by the second segment, which is where the steady
  // state actually shows.
  const readLedger = () =>
    page.evaluate(
      (u) => {
        const n = window.__game.net
        return n.ledger ? (n.ledger.get ? n.ledger.get(u) : null) : null
      },
      bucket.url,
    )
  const BANK_DRAIN = 90_000
  const HARM_WINDOW = 60_000
  await wait(BANK_DRAIN)
  const harmStart = { received: bucket.received, refused: (await readLedger())?.refused ?? 0 }
  await wait(HARM_WINDOW)
  const harmLedger = await readLedger()
  const refusedInWindow = (harmLedger?.refused ?? 0) - harmStart.refused
  const perMinute = refusedInWindow / (HARM_WINDOW / 60_000)
  const rateInWindow = (bucket.received - harmStart.received) / (HARM_WINDOW / 1000)
  console.log(
    `\n  steady state (after ${BANK_DRAIN / 1000}s of bank drain, measured over ` +
      `${HARM_WINDOW / 1000}s): ${rateInWindow.toFixed(1)} sent/s, ` +
      `${refusedInWindow} refusals (${perMinute.toFixed(1)}/min)\n`,
  )
  check(
    'the probe does not dirty every minute',
    perMinute < 3,
    `${perMinute.toFixed(1)} refusals/min — anything regular pins the score at the floor`,
  )
  check(
    'and the send rate stays near the cap rather than climbing',
    rateInWindow < 2.0,
    `${rateInWindow.toFixed(1)}/s against a 1.0/s cap`,
  )

  // ------------------------------------------- but the probe still has to work
  //
  // Shorten the interval and raise the relay's cap. If the client never notices,
  // pacing is a one-way ratchet and "quiet" is indistinguishable from "fixed by
  // deleting the probe".

  await page.evaluate(() => {
    window.__game.net.paceProbeMs = 3000
  })
  bucket.setCap(1200)
  // Let it climb, then measure the last stretch. Averaging across the ramp
  // reports something between the old rate and the new one and understates
  // both — the question is where it ended up, not what the mean of the
  // journey was.
  // Long enough for the x1.1 steps to be unambiguously past the old cap rather
  // than a hair over it — a knife-edge threshold is its own kind of flake.
  await wait(40_000)
  const probeStart = bucket.received
  await wait(10_000)
  const probedRate = (bucket.received - probeStart) / 10
  console.log(`  after the cap rose to 1200/min: ${probedRate.toFixed(1)} sent/s\n`)
  check(
    'the probe finds a relay that has forgiven us',
    probedRate > rateInWindow * 2,
    `${probedRate.toFixed(1)}/s, up from ${rateInWindow.toFixed(1)}/s`,
  )

  // ------------------------------------------------------------- recovery
  //
  // A mute is a wait, not a life sentence. Rather than idle for a real minute,
  // expire it directly and confirm the relay is published to again — the point
  // under test is that the mute is time-bounded and reversible at all.

  // `baseSpan` was sampled long before this point, because by now the first
  // mute has expired and re-fired at twice the wait — reading it here and
  // calling it "the first" would be measuring the third.
  const firstSpan = (await page.evaluate(
    (u) => {
      const m = window.__game.net.muted
      if (!(m instanceof Map)) return null
      const e = m.get(u)
      return e ? { span: e.span } : null
    },
    limited.url,
  )) ?? { span: 0 }

  const before = limited.received
  await page.evaluate(() => {
    const muted = window.__game.net.muted
    // Old builds used a Set of urls with no expiry at all; nothing to expire.
    if (muted instanceof Map) for (const m of muted.values()) m.until = Date.now() - 1
  })
  // Fifteen refusals at the tick rate is about 2.3s, so a 2.5s window sat on
  // the boundary and flaked. Give the re-mute room to actually happen.
  await wait(6000)
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
  // ------------------------------------------------- when it is not the relays
  //
  // `malformed` from one relay is that relay being odd. `malformed` from every
  // relay is a fact about this machine — realistically the clock, since newlay's
  // window is 365 days behind and only fifteen minutes ahead. Muting is wrong
  // (there would be no relays left) and so is carrying on.
  //
  // Two sessions, because the interesting half is the one that must NOT fire.

  const openAgainst = async (urls, tag) => {
    const pg = await browser.newPage()
    // Foreground, explicitly. These sessions publish from the game's rAF loop,
    // and a tab that loses frontmost status when a sibling closes gets its rAF
    // frozen — the gate section below sat at zero publishes for twenty seconds
    // that way, which read as "the quorum never outvoted" when the page had
    // never been given a frame to publish from.
    await pg.bringToFront()
    await pg.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await pg.$eval('#relays', (el, v) => { el.value = v }, urls.join('\n'))
    await pg.type('#name', tag)
    await pg.type('#room', tag + Math.floor(Math.random() * 1e6))
    await pg.click('#play-guest')
    const ok = await pg
      .waitForFunction(() => !!window.__game, { timeout: 25_000 })
      .then(() => true)
      .catch(() => false)
    return ok ? pg : null
  }

  // --- the false accusation, which nothing here could previously see --------
  //
  // One relay that only ever says `invalid:` and three that refuse on something
  // ordinary. The three get muted; the odd one cannot be, because malformed
  // does not strike. So the target set narrows to exactly the relay that raises
  // the alarm, and a client reading `malformed === sent` blames the player's
  // clock on a sample of one. The filter removes the witnesses and keeps the
  // accuser.
  const oddOne = startRelay('expired')
  const noisy = [startRelay('blocked'), startRelay('blocked'), startRelay('blocked')]
  const biasPage = await openAgainst([oddOne.url, ...noisy.map((r) => r.url)], 'bias')
  check('a session with one odd relay and three refusers starts', biasPage !== null)

  if (biasPage) {
    await wait(14_000)
    const biased = await biasPage.evaluate(() => ({
      alarm: window.__game.net.clockAlarm ?? null,
      muted: window.__game.net.mutedRelays.length,
      relays: window.__game.net.relays.length,
    }))
    check(
      'the three refusers are muted, leaving the odd one alone',
      biased.muted === 3,
      `${biased.muted} of ${biased.relays} muted`,
    )
    check(
      'one relay calling it invalid does NOT accuse the clock',
      biased.alarm === null,
      biased.alarm ? `ALARM RAISED on a sample of one: ${biased.alarm.reason}` : 'no alarm',
    )
    // Polled rather than sampled once, same reasoning as the tick-stream check
    // below: under swiftshader the frame loop — and with it the publish rate —
    // runs at whatever fraction of real time the machine allows, so "more than
    // ten events in six seconds" was a claim about the laptop, not the client.
    // What is being asserted is that the stream did not *stop*: held publishing
    // means one probe a minute, so eight more events is unreachable held and
    // trivial unheld.
    const keptStart = oddOne.received
    const kept = await until(() => oddOne.received - keptStart >= 8, 20_000)
    check(
      'and publishing is not held on that relay',
      kept,
      `${oddOne.received - keptStart} more events reached it`,
    )
    await biasPage.close()
  }

  // --- one relay must not be able to acquit either ---------------------------
  //
  // `rate-limited:` is the only refusal newlay emits from *above* the created_at
  // gate — the events bucket and the per-IP gate both run before the timestamp
  // is looked at. So it is proof the relay never examined the clock, while
  // every other prefix means created_at was checked and passed.
  //
  // The old rule cleared the streak on any refusal, and the pacer manufactures
  // this one on purpose: escalating x1.1 and snapping back on the next refusal
  // is the feedback signal. So on a paced relay it arrives periodically,
  // forever. Three relays refusing every event because the clock is fifteen
  // minutes ahead, one paced relay saying "slow down", and the alarm could
  // never raise: not unanimous, and zeroed on every publish.
  const acquitInvalid = [startRelay('future'), startRelay('future'), startRelay('expired')]
  const acquitRate = startRelay('fastlimit')
  const acquitPage = await openAgainst(
    [...acquitInvalid.map((r) => r.url), acquitRate.url],
    'acquit',
  )
  check('a session with three invalid relays and one rate-limiter starts', acquitPage !== null)

  if (acquitPage) {
    await wait(9000)
    const st = await acquitPage.evaluate(() => ({
      alarm: window.__game.net.clockAlarm ?? null,
      muted: window.__game.net.mutedRelays.length,
    }))
    check(
      'a "slow down" does not vouch for the clock',
      st.alarm !== null,
      st.alarm
        ? `alarm up: ${st.alarm.reason}`
        : 'no alarm — one rate limit acquitted three relays that read the timestamp',
    )
    check(
      'and the rate-limiter is paced, not muted, so it stays in every publish',
      st.muted === 0,
      `${st.muted} muted`,
    )
    await acquitPage.close()
  }

  // --- but a refusal from below the gate really does acquit ------------------
  //
  // `blocked:` comes after the created_at check, so the relay examined the
  // timestamp and passed it before refusing for another reason. That is
  // stronger evidence the clock is fine than an acceptance is.
  const gateInvalid = [startRelay('expired'), startRelay('expired'), startRelay('expired')]
  const gateBlocked = startRelay('blocked')
  const gatePage = await openAgainst(
    [...gateInvalid.map((r) => r.url), gateBlocked.url],
    'gate',
  )
  check('a session with three invalid relays and one blocker starts', gatePage !== null)

  if (gatePage) {
    // Five all-malformed publishes raise the alarm and fifteen refusals mute a
    // relay, so the alarm always lands first — but *when* it lands depends on
    // the publish rate, which under swiftshader is whatever fraction of real
    // time the machine allows. A fixed 1.5s sample read "no alarm" on a page
    // that had simply not published five times yet. So: poll until either the
    // alarm is up or the blocker got muted, and judge whichever came first —
    // the outvote claim needs the alarm to arrive while the blocker is live.
    // The deadline is measured in *publishes*, not seconds: the alarm needs
    // five all-refused publishes, so the poll only gives up once the page has
    // demonstrably made well more than five (7 publishes x 4 relays of
    // rejections) and still raised nothing — at which point the outvote
    // genuinely failed, and the detail says what the netcode had counted.
    let early = { alarm: null, muted: 0, rejected: -1, published: -1 }
    await until(async () => {
      early = await gatePage.evaluate(() => ({
        alarm: window.__game.net.clockAlarm ?? null,
        muted: window.__game.net.mutedRelays.length,
        rejected: window.__game.net.rejected ?? 0,
        published: window.__game.net.published ?? 0,
      }))
      return early.alarm !== null || early.muted > 0 || early.rejected >= 28
    }, 60_000)
    // This used to assert the opposite, and the rule it encoded has been
    // superseded on purpose rather than deleted for being inconvenient.
    //
    // A `blocked:` refusal does mean the relay read the timestamp and passed
    // it, which is real evidence. But three relays independently naming the
    // clock is stronger than one relay's window being wide enough — exactly the
    // reasoning that stops relay.fountain.fm's acceptance sinking the alarm,
    // and a relay that passes a timestamp may simply have a laxer bound. So a
    // quorum outvotes it. Below-gate refusals still matter for *clearing*, when
    // nobody has named the timestamp at all.
    check(
      'a quorum on the clock outvotes one relay that passed the timestamp',
      early.alarm !== null && early.muted === 0,
      early.alarm
        ? `alarm up with the blocker still live: ${early.alarm.reason}`
        : `no alarm — one blocker vetoed three accusers ` +
          `(published ${early.published}, rejected ${early.rejected}, muted ${early.muted})`,
    )
    // And it has to be able to let go. A relay list that starts complaining and
    // then stops is a clock somebody just fixed, and an alarm that cannot clear
    // would make the fix invisible — which is the failure it exists to prevent,
    // inverted.
    for (const r of gateInvalid) r.behaviour = 'good'
    // While the alarm is up, publishing holds and one relay is probed per
    // cycle — sixty seconds by default. An eight-second window cannot contain a
    // sixty-second probe, so without compressing this the check reports "the
    // alarm never clears" about a mechanism it never let run. Rule four, in the
    // test written to prove rule four.
    await gatePage.evaluate(() => {
      window.__game.net.malformedProbeMs = 1200
    })
    await wait(9000)
    const cleared = await gatePage.evaluate(() => window.__game.net.clockAlarm ?? null)
    check(
      'and the alarm lets go once the relays stop naming the clock',
      cleared === null,
      cleared ? `still up: ${cleared.reason}` : 'cleared',
    )
    await gatePage.close()
  }

  // --- the production shape, measured rather than imagined -------------------
  //
  // At 61 seconds behind, three of the four shipped relays answer
  // `invalid: ephemeral event expired` and relay.fountain.fm accepts the same
  // event — it took a backdate of an hour and a forward date of half an hour
  // without complaint, so it has no timestamp gate at all. Under a unanimity
  // rule that single acceptance sank the alarm on every publish, and cleared
  // the streak besides.
  const prodBad = [startRelay('strfryBehind'), startRelay('strfryBehind'), startRelay('strfryBehind')]
  const prodGood = startRelay('good')
  const prodPage = await openAgainst([...prodBad.map((r) => r.url), prodGood.url], 'prod')
  check('a session shaped like the real relay list starts', prodPage !== null)

  if (prodPage) {
    await wait(8000)
    const st = await prodPage.evaluate(() => window.__game.net.clockAlarm ?? null)
    check(
      'three relays naming the clock outvote one that accepts',
      st !== null,
      st
        ? `alarm up, ${st.agreed} agreed, direction ${st.direction}`
        : 'no alarm — one relay with no timestamp gate sank three that have one',
    )
    check('and the direction is behind', st?.direction === 'behind', st?.direction ?? 'none')
    check(
      'and it quotes a reason the relays actually gave',
      st?.reason === 'invalid: ephemeral event expired',
      st?.reason ?? '',
    )
    await prodPage.close()
  }

  // --- strfry's "ahead" wording, which matches neither word a client looks for
  const aheadPage = await openAgainst(
    [startRelay('strfryAhead').url, startRelay('strfryAhead').url, startRelay('strfryAhead').url],
    'ahead',
  )
  if (aheadPage) {
    await wait(8000)
    const st = await aheadPage.evaluate(() => window.__game.net.clockAlarm ?? null)
    check(
      '`created_at too late` is read as ahead',
      st?.direction === 'ahead',
      st ? `${st.direction} — ${st.reason}` : 'no alarm',
    )
    await aheadPage.close()
  }

  // --- a shape rejection is not a verdict on the clock ------------------------
  //
  // Both implementations check tags and content length *before* the timestamp.
  // Two relays configured tighter than the tick is two relays agreeing, and
  // under a rule that counts the kind rather than the cause that is a quorum —
  // publishing held, and the screen telling a player to fix a correct clock.
  const shapePage = await openAgainst(
    [startRelay('tagcount').url, startRelay('tagcount').url, startRelay('tagcount').url],
    'shape',
  )
  check('a session where every relay rejects on shape starts', shapePage !== null)
  if (shapePage) {
    await wait(8000)
    const st = await shapePage.evaluate(() => ({
      alarm: window.__game.net.clockAlarm ?? null,
      muted: window.__game.net.mutedRelays.length,
    }))
    check(
      'rejecting on tag count does not accuse the clock',
      st.alarm === null,
      st.alarm ? `ALARM: ${st.alarm.reason} — the relay never read the timestamp` : 'no alarm',
    )
    await shapePage.close()
  }

  // --- the quorum has to agree on the cause, not just the kind ---------------
  const mixedTag = startRelay('tagcount')
  const mixedLate = [startRelay('strfryAhead'), startRelay('strfryAhead')]
  const mixedPage = await openAgainst([mixedTag.url, ...mixedLate.map((r) => r.url)], 'mixed')
  if (mixedPage) {
    await wait(8000)
    const st = await mixedPage.evaluate(() => window.__game.net.clockAlarm ?? null)
    check(
      'the quoted reason is one at least two relays gave',
      st !== null && st.reason === 'invalid: created_at too late',
      st ? `${st.reason} (${st.agreed} agreed)` : 'no alarm',
    )
    check(
      'and the relay that never read the timestamp is not counted',
      st?.agreed === 2,
      `${st?.agreed ?? 0} agreed of 3 rejecting`,
    )
    await mixedPage.close()
  }

  // --- only a witness can recant ---------------------------------------------
  //
  // While the alarm is up exactly one relay is probed per cycle, and a relay
  // that never refuses never mutes, so it never leaves the rotation. Under a
  // rule where any acceptance clears the streak, its turn came round and the
  // alarm blinked off — publishing resumed at ten a second into relays refusing
  // every event, and the quorum raised it again half a second later.
  const witBad = [startRelay('strfryBehind'), startRelay('strfryBehind'), startRelay('strfryBehind')]
  const witYes = startRelay('good', { closeSubs: true })
  const witPage = await openAgainst([...witBad.map((r) => r.url), witYes.url], 'witness')
  check('a session with three accusers and one blind acceptor starts', witPage !== null)

  if (witPage) {
    await wait(7000)
    const up = await witPage.evaluate(() => window.__game.net.clockAlarm ?? null)
    check('the alarm raises against three accusers', up !== null, up ? up.direction : 'no alarm')

    // Compress the cycle so the acceptor's turn comes round several times
    // inside the window — a twenty-second window cannot contain a sixty-second
    // rotation, and would report a steady alarm about a blink it never reached.
    await witPage.evaluate(() => {
      window.__game.net.malformedProbeMs = 1200
    })
    let blinks = 0
    let samples = 0
    const until = Date.now() + 22_000
    while (Date.now() < until) {
      const a = await witPage.evaluate(() => window.__game.net.clockAlarm ?? null)
      samples++
      if (a === null) blinks++
      await wait(250)
    }
    console.log(`\n  alarm sampled ${samples}x over 22s with a 1.2s probe cycle: ${blinks} blinks\n`)
    check(
      'a relay that never accused cannot clear the alarm',
      blinks === 0,
      `${blinks} of ${samples} samples had no alarm — each one resumes publishing into relays refusing everything`,
    )

    // But a witness recanting must still work, or the alarm could never clear.
    for (const r of witBad) r.behaviour = 'good'
    await wait(9000)
    const cleared = await witPage.evaluate(() => window.__game.net.clockAlarm ?? null)
    check(
      'and a relay that did accuse can still clear it',
      cleared === null,
      cleared ? `still up: ${cleared.reason}` : 'cleared',
    )

    // The blind acceptor closed every subscription it was given. That has to be
    // visible: a relay that hung up is permanently silent and looks identical
    // to a quiet one, while the publish path goes on counting it live.
    const deaf = await witPage.evaluate(() => window.__game.net.deafRelays ?? [])
    check(
      'a relay that closed our subscription is reported',
      deaf.some((d) => d.url === witYes.url && /kinds not supported/.test(d.reason)),
      JSON.stringify(deaf),
    )
    check(
      'and the relays that served it are not',
      !deaf.some((d) => witBad.some((r) => r.url === d.url)),
      `${deaf.length} deaf of 4`,
    )
    await witPage.close()
  }

  // --- the genuine case ------------------------------------------------------
  const alarmRelays = [
    startRelay('expired'), startRelay('future'), startRelay('expired'), startRelay('future'),
  ]
  const page2 = await openAgainst(alarmRelays.map((r) => r.url), 'clock')
  check('a session against only invalid-rejecting relays starts', page2 !== null)

  if (page2) {
    await wait(6000)
    const alarm = await page2.evaluate(() => window.__game.net.clockAlarm ?? null)
    check(
      'every relay calling the event invalid raises the alarm',
      alarm !== null && alarm.streak >= 5,
      alarm ? `streak ${alarm.streak}, reason ${JSON.stringify(alarm.reason)}` : 'no alarm',
    )
    check(
      'and the alarm quotes the relay rather than paraphrasing',
      !!alarm && /invalid:/.test(alarm.reason),
      alarm ? alarm.reason : '',
    )

    // Pinning the constant is worth doing and proves nothing on its own: it
    // reads the same whether the arithmetic works or not. The quantity that
    // matters is how many -4s each *connection* takes per minute, so that is
    // measured below and this only guards the shipped default.
    const defaultProbe = await page2.evaluate(() => window.__game.net.malformedProbeMs)
    check('the shipped probe cycle is 60s', defaultProbe === 60_000, `${defaultProbe}ms`)

    // Compressed so a probe cycle fits the window. Four relays and round-robin
    // means each one should see a quarter of the cycles.
    await page2.evaluate(() => {
      window.__game.net.malformedProbeMs = 2000
    })
    const before = alarmRelays.map((r) => r.received)
    const HOLD = 32_000
    await wait(HOLD)
    const got = alarmRelays.map((r, i) => r.received - before[i])
    const total = got.reduce((a, b) => a + b, 0)
    const cycles = HOLD / 2000
    const worstPerRelay = Math.max(...got)
    console.log(
      `\n  alarm up, 2s cycle over ${HOLD / 1000}s (${cycles} cycles): ` +
        `${got.join(' / ')} per relay, ${total} total\n`,
    )
    check(
      'publishing holds while the alarm is up',
      total / (HOLD / 1000) < 2,
      `${(total / (HOLD / 1000)).toFixed(2)}/s — was ~13/s per relay before the alarm existed`,
    )
    check(
      'but it does not go silent, so a corrected clock is noticed',
      total > 0,
      `${total} probes in ${HOLD / 1000}s`,
    )
    // The quantity that actually changed: broadcasting would hand every relay
    // one -4 per cycle. Round-robin gives each a quarter of them.
    check(
      'each relay takes a quarter of the probes, not all of them',
      worstPerRelay <= cycles * 0.6,
      `worst relay ${worstPerRelay} of ${cycles} cycles — broadcast would be ${cycles}`,
    )
    await page2.close()
  }

  // ------------------------------------------------- the read path survives
  //
  // Publishing recovers from a dropped socket on its own, because the next
  // publish builds a fresh one. Reading did not: nostr-tools defaults
  // `enableReconnect` to false, a hard close runs `closeAllSubscriptions`, and
  // nothing in this client resubscribes — `subscribe()` is called twice, from
  // `Game.start()`, and never again. One wifi change and the relay is
  // write-only for the rest of the session: ten publishes a second into a game
  // that cannot be seen, with no error, no refusal and nothing on the screen.

  const liveRelay = startRelay('good')
  const readPage = await openAgainst([liveRelay.url], 'read')
  check('a session against one delivering relay starts', readPage !== null)

  if (readPage) {
    await wait(4000)
    const roomTag = await readPage.evaluate(() => `tankarena-${window.__game.room}`)
    const peerSk = generateSecretKey()
    const peerPk = getPublicKey(peerSk)
    const tick = (t) =>
      finalizeEvent(
        {
          kind: 21000,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['t', roomTag]],
          content: JSON.stringify({ t, x: 900, y: 700, h: 0, g: 0, hp: 3, d: false }),
        },
        peerSk,
      )
    const sees = () =>
      readPage.evaluate((pk) => [...window.__game.peers.keys()].includes(pk), peerPk)

    liveRelay.inject(tick(1))
    await wait(2500)
    check('a peer tick arrives before the drop', await sees(), `peer ${peerPk.slice(0, 8)}`)

    // Forget the peer, or the check after the drop could pass on a stale entry
    // — the same shape as a control the thing under test can overwrite.
    await readPage.evaluate((pk) => window.__game.peers.delete(pk), peerPk)
    const dropped = liveRelay.dropAll()
    check('the socket was yanked out from under it', dropped > 0, `${dropped} closed`)

    // Backoff plus a resubscribe. Generous, because the question is whether it
    // comes back at all, not how quickly.
    await wait(10_000)
    liveRelay.inject(tick(2))
    await wait(3500)
    check(
      'and the read path comes back after the socket is dropped',
      await sees(),
      'nothing inbound after the drop — that relay is write-only for the session',
    )

    // Publishing was never the broken half. Assert it anyway, so a fix that
    // traded one direction for the other cannot pass.
    const before = liveRelay.received
    await wait(2500)
    check(
      'and publishing kept working across the drop',
      liveRelay.received > before,
      `${liveRelay.received - before} events in 2.5s`,
    )
    await readPage.close()
  }

  // ------------------------------ one relay's reconnect must not blind the rest
  //
  // nostr-tools rewrites a resubscribing filter's `since` to `lastEmitted + 1`,
  // and `lastEmitted` is the maximum `created_at` *received* — not accepted, so
  // an event the client-side filter already rejected still raises it. That is
  // the furthest-ahead clock in the room, not our own history.
  //
  // And `matchFilters` runs client-side on every inbound event, so a filter
  // object shared across the per-relay subscriptions means one relay's
  // reconnect discards the others' traffic against a filter they never sent.

  const relayA = startRelay('good')
  const relayB = startRelay('good')
  const twoPage = await openAgainst([relayA.url, relayB.url], 'twin')
  check('a session against two delivering relays starts', twoPage !== null)

  if (twoPage) {
    await wait(4000)
    const tag2 = await twoPage.evaluate(() => `tankarena-${window.__game.room}`)
    const sk2 = generateSecretKey()
    const pk2 = getPublicKey(sk2)
    const stamped = (offset) =>
      finalizeEvent(
        {
          kind: 21000,
          created_at: Math.floor(Date.now() / 1000) + offset,
          tags: [['t', tag2]],
          content: JSON.stringify({ t: 1, x: 800, y: 600, h: 0, g: 0, hp: 3, d: false }),
        },
        sk2,
      )

    // A peer whose clock is five minutes fast. Inside every relay's forward
    // window, so nothing refuses it and nothing anywhere complains.
    relayA.inject(stamped(300))
    await wait(2000)
    const reqsBefore = relayA.reqFilters.length
    relayA.dropAll()
    await wait(6000)

    const newReq = relayA.reqFilters.slice(reqsBefore)
    check(
      'the resubscribe asks for the filter we built, with no `since` in it',
      newReq.length > 0 && newReq.every((f) => f.since === undefined),
      JSON.stringify(newReq),
    )

    // B never dropped. Its traffic must survive A's reconnect.
    await twoPage.evaluate((pk) => window.__game.peers.delete(pk), pk2)
    relayB.inject(stamped(0))
    await wait(3000)
    check(
      "and the relay that never dropped still delivers",
      await twoPage.evaluate((pk) => [...window.__game.peers.keys()].includes(pk), pk2),
      'B is healthy and its events were discarded against a filter A mutated',
    )
    await twoPage.close()
  }

  // ------------------------------ a CLOSED verdict must not be retried forever
  //
  // A dropped socket is ours to restore. A relay that read the filter and
  // declined it is not — resubscribing to that loops for the whole session, and
  // the relay removed two PRs ago would have made this client do exactly that
  // on every kind it uses.

  const refuser = startRelay('good', { closeSubs: true })
  const refusePage = await openAgainst([refuser.url], 'refuse')
  if (refusePage) {
    await wait(9000)
    const reqs = refuser.reqFilters.length
    check(
      'a relay that declines the filter is asked once, not in a loop',
      reqs <= 4,
      `${reqs} REQs in 9s — one per Game.subscribe call is 2`,
    )
    check(
      'and it is reported rather than retried',
      (await refusePage.evaluate(() => window.__game.net.deafRelays ?? [])).length > 0,
      'not in deafRelays',
    )
    await refusePage.close()
  }

  // ----------------------------- a relay that was never there is not a verdict
  //
  // The router matched `/^relay connection/i`, which only covers a socket that
  // died *after* connecting. A relay that was never there fails a different way
  // and the string carries no `relay ` at all — measured against nostr-tools:
  //
  //   nothing listening      "connection failed"
  //   DNS does not resolve   "connection failed"
  //   black hole, times out  "connection timed out"
  //
  // So the ordinary case — a tab opened before the wifi associated, a relay in
  // maintenance, a captive portal — was filed as a `CLOSED` verdict: never
  // retried for the session, and quoted on screen as the relay's own words when
  // no relay had spoken.

  // Reserve a port by taking one and giving it straight back, so the game joins
  // against an address with nothing behind it.
  const placeholder = new WebSocketServer({ port: 0 })
  const deadPort = placeholder.address().port
  await new Promise((r) => placeholder.close(r))
  const deadUrl = `ws://localhost:${deadPort}`

  const gonePage = await openAgainst([deadUrl], 'gone')
  check('a session starts against a relay that is not there', gonePage !== null)

  if (gonePage) {
    await wait(6000)
    const st = await gonePage.evaluate(() => ({
      deaf: window.__game.net.deafRelays ?? [],
      unreachable: window.__game.net.unreachableRelays ?? [],
    }))
    check(
      'an unreachable relay is not quoted as having said anything',
      st.deaf.length === 0,
      JSON.stringify(st.deaf),
    )
    check(
      'it is reported as unreachable instead',
      st.unreachable.some((u) => u.url === deadUrl),
      JSON.stringify(st.unreachable),
    )

    // Now bring it up on the same address. A relay that was down when we joined
    // has to be picked up without a reload — this is the whole point of not
    // treating silence as a verdict.
    const late = startRelay('good', { port: deadPort })
    await wait(12_000)
    const tag3 = await gonePage.evaluate(() => `tankarena-${window.__game.room}`)
    const sk3 = generateSecretKey()
    const pk3 = getPublicKey(sk3)
    late.inject(
      finalizeEvent(
        {
          kind: 21000,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['t', tag3]],
          content: JSON.stringify({ t: 1, x: 700, y: 500, h: 0, g: 0, hp: 3, d: false }),
        },
        sk3,
      ),
    )
    await wait(3000)
    check(
      'and it is picked up once it comes up, with no reload',
      await gonePage.evaluate((pk) => [...window.__game.peers.keys()].includes(pk), pk3),
      `${late.connections} connections, ${late.reqFilters.length} REQs`,
    )
    check(
      'and it stops being reported as unreachable',
      !(await gonePage.evaluate(() => window.__game.net.unreachableRelays ?? [])).some(
        (u) => u.url === deadUrl,
      ),
      'still listed after it came up',
    )
    await gonePage.close()
  }

  // ------------------------------- one refused kind must not cost the others
  //
  // The gap cowboy found in the exemption, from this side of the wire. A relay
  // that takes 21000-21003 and refuses 30078 is not misbehaving and is not
  // useless — it is most of a working relay, and the old client's only two
  // settings were "keep sending forever" and "give up on the relay entirely."
  // Forever is what it did, because `strikes` is per relay and every tick that
  // lands resets it, so fifteen consecutive refusals never happen while the
  // game is running. Each of those refusals is a debit on a relay that scores
  // behaviour, and the throttle it buys lands on the exempt kinds.
  //
  // Only two relays here, both of which accept the netcode kinds, so nothing
  // gets muted wholesale and the HUD sentence under test is the only thing
  // that can be on the screen.
  const wot = startRelay('wotexempt')
  const alsoGood = startRelay('good')
  const wotPage = await openAgainst([wot.url, alsoGood.url], 'wot')
  check('a session against a relay that exempts only the tick kinds starts', wotPage !== null)

  if (wotPage) {
    // A background tab has its animation frames throttled to about one a
    // second, and this game publishes its tick from inside the frame loop. Every
    // earlier page in this file measures totals over long windows and never
    // noticed; the check below is a *rate* and it read 2 ticks in five seconds
    // until this line went in.
    await wotPage.bringToFront()
    // Let the tick stream establish itself first: the point of the fix is that
    // a refused claim does not disturb traffic that is already flowing.
    await wait(3000)
    const beforeHud = await wotPage.evaluate(() => window.__game.net.troubleSummary())
    check(
      'nothing is wrong before a claim is ever published',
      !/pickup/i.test(beforeHud),
      JSON.stringify(beforeHud),
    )
    const ticksBefore = wot.byKind[21000] ?? 0

    // Real signed claims down the real socket, so the relay's `restricted:`
    // frame is classified by the same code a live game runs. Eight of them —
    // comfortably more than the three-strike threshold, so a client that never
    // stopped would show it.
    const CLAIMS = 8
    await wotPage.evaluate(async (n) => {
      const g = window.__game
      for (let i = 0; i < n; i++) {
        const now = Math.floor(Date.now() / 1000)
        const ev = g.identity.signAsSession({
          kind: 30078,
          created_at: now,
          tags: [
            ['d', `kindmute-probe-${i}-${g.identity.sessionPubkey}`],
            ['t', `tankarena-${g.room}`],
            ['expiration', String(now + 600)],
          ],
          content: JSON.stringify({ p: `probe-${i}`, kind: 'shield' }),
        })
        await g.net.publish(ev)
      }
    }, CLAIMS)
    await wait(2500)

    // Two different counts on purpose. The refusing relay is judged by *kind*
    // — the game's own presence beacon is also 30078 and a refused beacon
    // burns a kind-strike exactly like a refused probe, so "stopped after
    // three" is a claim about every 30078 it saw. The accepting relay is
    // judged by the probes' own `d` tags, because a beacon landing inside the
    // window used to photobomb eight probe claims into "9 of 8".
    const claimsAtWot = wot.byKind[30078] ?? 0
    const claimsAtGood = alsoGood.dTags.filter((d) => String(d).startsWith('kindmute-probe-')).length
    // The quantity that changes. A counter of refusals would move either way —
    // it climbs whether the client learned or not. What only a client that
    // learned produces is a *stalled* count: three offered, five withheld.
    check(
      'the client stops offering a kind the relay keeps refusing',
      claimsAtWot === 3,
      `${claimsAtWot} of ${CLAIMS} claims reached it — expected to stop after 3`,
    )
    check(
      '...and the relay that accepts them still gets all of them',
      claimsAtGood === CLAIMS,
      `${claimsAtGood} of ${CLAIMS}`,
    )

    const wotState = await wotPage.evaluate(() => ({
      muted: window.__game.net.mutedRelays,
      kindMutes: window.__game.net.kindMutes ?? [],
      hud: window.__game.net.troubleSummary(),
    }))
    check(
      'the relay itself is NOT muted — one refused kind is not a bad relay',
      !wotState.muted.includes(wot.url),
      wotState.muted.includes(wot.url) ? 'MUTED — lost the netcode over one kind' : 'still publishing',
    )
    check(
      'the kind it refuses is recorded against it, not just counted',
      wotState.kindMutes.some((m) => m.url === wot.url && m.kind === 30078),
      JSON.stringify(wotState.kindMutes),
    )
    // Named by symptom. A player whose pads keep reappearing is looking at a
    // game that disagrees with the room, and "30078 restricted" is not a
    // sentence that tells them so.
    check(
      'and the HUD says what the player can actually see going wrong',
      /pickups are not syncing/i.test(wotState.hud),
      JSON.stringify(wotState.hud),
    )

    // The other direction, and it is not academic — the first version of this
    // fix failed it. A relay that refuses *everything* has no kind policy, it
    // simply does not want us, and withholding its kinds one at a time stops it
    // ever reaching fifteen consecutive strikes. Three relays that used to be
    // muted outright silently stopped being.
    const blanket = await page.evaluate(() => ({
      kindMutes: window.__game.net.kindMutes ?? [],
      muted: window.__game.net.mutedRelays,
    }))
    check(
      'a relay that refuses everything is muted outright, not kind by kind',
      !blanket.kindMutes.some((m) => m.url === blocked.url) && blanket.muted.includes(blocked.url),
      `${JSON.stringify(blanket.kindMutes.map((m) => m.url))} vs muted ${blanket.muted.includes(blocked.url)}`,
    )

    // The half that matters most: the exempt kinds are unaffected. This is the
    // whole reason not to mute the relay, and the reason the withholding has to
    // be per kind rather than per socket.
    // Polled rather than sampled once. Under swiftshader the frame loop runs at
    // a fraction of real time and the fraction depends on what else is on the
    // machine, so any fixed window is a guess that stops containing the
    // behaviour on a loaded laptop. What is being asserted is that the stream
    // did not *stop*, and twenty ticks is well under a second of a healthy one.
    const ticked = await until(() => (wot.byKind[21000] ?? 0) - ticksBefore > 20, 20_000)
    check(
      'the tick stream to that relay is untouched',
      ticked,
      `${(wot.byKind[21000] ?? 0) - ticksBefore} ticks after the claims were refused`,
    )
    await wotPage.close()
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
