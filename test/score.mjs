// The scoreboard, and whether four clients would show the same one.
//
// Puzz: "k/d — Kill/death ratios need to be accurate and coherent across all
// players." They were not, and could not have been. Every client built its
// scoreboard by counting kind-21002 death events it personally received, and
// those are ephemeral — no relay stores them. A client that joined mid-round
// had received none of the deaths that already happened and showed a room full
// of veterans at 0/0 forever. A death event that reached three relays out of
// four was counted by whoever was subscribed to those three. There was no
// shared source of truth in the room at all.
//
// The fix puts each tank's own tally on its state tick, stamped with the round
// it belongs to, and the scoreboard prefers a peer's own count over the one we
// assembled locally. This suite drives real events through the real handler and
// asserts the *numbers on the scoreboard*, not a counter of how many events
// were processed — a tally of "how many deaths we handled" moves whether the
// handling was right or wrong and cannot tell the bug from the fix.
//
// Every case here starts from a **fresh peer map**, because that is the state
// the bugs live in. A client that has been in the room for a minute has a peer
// entry for everybody and none of this reproduces.
//
//   npm run build && npm run preview &
//   npm run test:score

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
  '--no-sandbox',
  '--window-size=1280,800',
  '--use-gl=angle',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
]

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

try {
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'scorer')
  await page.type('#room', 'score' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game, { timeout: 25_000 })
    .then(() => true)
    .catch(() => false)
  check('a game is running', started)
  if (!started) throw new Error('the game never started')

  // Pin the round. Everything about the tally is stamped with a block height,
  // and the live chain tip would move under the suite — the whole point of
  // `pads.mjs` and the shot script pinning a tip is that a test whose input is
  // the real blockchain is a test whose result is a coincidence.
  await page.evaluate(() => {
    window.__game.beginRound(900000, 'ab'.repeat(30) + '0300')
  })

  // --- the machinery -------------------------------------------------------
  //
  // Events built here are the same shape `publishAsSession` puts on the wire
  // and go through the same public `onEvent`. Nothing reaches into a private
  // field to set a score: if the handler does not produce the number, the check
  // does not see it. `stored` stays false because a stored event is dropped by
  // design and would make every case here pass by never being handled at all.
  await page.evaluate(() => {
    let n = 0
    window.__mk = (session, kind, payload) => ({
      id: 'ev' + ++n + Math.random().toString(16).slice(2),
      pubkey: session,
      kind,
      created_at: Math.floor(Date.now() / 1000),
      tags: [],
      content: JSON.stringify(payload),
      sig: '0'.repeat(128),
    })
    window.__feed = (session, kind, payload) =>
      window.__game.onEvent(window.__mk(session, kind, payload), false)
    window.__rowFor = (session) => {
      // Peers are keyed by session pubkey; the scoreboard is keyed by display
      // name, and `ensurePeer` names an unattested peer `tank-<first four>`.
      const name = 'tank-' + session.slice(0, 4)
      return window.__game.scoreboard().find((r) => r.name === name) ?? null
    }
    window.__forget = () => window.__game.peers.clear()
  })

  const KIND_STATE = 21000
  const KIND_DEATH = 21002
  const A = 'a1'.repeat(32) // killer, never heard from
  const B = 'b2'.repeat(32) // victim
  const C = 'c3'.repeat(32) // a peer with a tally of its own

  // --- the dropped kill ----------------------------------------------------
  //
  // `src/game.ts` used to read:
  //
  //     } else if (p.k) {
  //       const killer = this.peers.get(p.k)
  //       if (killer) killer.kills++
  //     }
  //
  // A death naming a killer this client had never had a tick from was silently
  // discarded — guaranteed for a late joiner, and for anyone whose first act
  // after joining is a kill, because their tick and their victim's death report
  // race across relays with no ordering between them.
  const dropped = await page.evaluate(
    (A, B, KIND_DEATH) => {
      window.__forget()
      window.__feed(B, KIND_DEATH, { t: Date.now(), k: A, x: 100, y: 100 })
      return { killer: window.__rowFor(A), victim: window.__rowFor(B) }
    },
    A, B, KIND_DEATH,
  )
  check(
    'a kill by a tank we have never had a tick from is still counted',
    dropped.killer?.kills === 1,
    JSON.stringify(dropped.killer),
  )
  check(
    'and the victim it names gets the death',
    dropped.victim?.deaths === 1,
    JSON.stringify(dropped.victim),
  )

  // The guard that replaced `if (killer)` is a shape check, and a shape check
  // that lets anything through is not one. A self-destruct carries `k: null`
  // and must not conjure a killer out of it.
  const selfDestruct = await page.evaluate(
    (B, KIND_DEATH) => {
      window.__forget()
      window.__feed(B, KIND_DEATH, { t: Date.now(), k: null, x: 100, y: 100 })
      return { rows: window.__game.scoreboard().length, victim: window.__rowFor(B) }
    },
    B, KIND_DEATH,
  )
  check(
    'a self-destruct makes no killer out of nothing',
    selfDestruct.rows === 2 && selfDestruct.victim?.deaths === 1,
    JSON.stringify(selfDestruct),
  )

  // --- the late joiner -----------------------------------------------------
  //
  // This is the case Puzz would have been looking at: open the game on a phone
  // three minutes into a round and everyone shows 0/0 because their deaths
  // happened before you were subscribed. Nothing can replay them — the events
  // are ephemeral and no relay kept one.
  const late = await page.evaluate(
    (C, KIND_STATE) => {
      window.__forget()
      const tick = (extra) => ({
        t: Date.now(), x: 100, y: 100, h: 0, g: 0, hp: 3, d: false, ...extra,
      })
      // First, the old client: a tick with no tally on it at all.
      window.__feed(C, KIND_STATE, tick({}))
      const old = window.__rowFor(C)
      // Then the same peer on a build that reports its score.
      window.__feed(C, KIND_STATE, tick({ ks: 7, ds: 2, r: window.__game.round }))
      return { old, now: window.__rowFor(C) }
    },
    C, KIND_STATE,
  )
  check(
    'a peer three minutes into a round arrives with its score, not at 0/0',
    late.now?.kills === 7 && late.now?.deaths === 2,
    JSON.stringify(late.now),
  )
  // The fallback has to still be there, or this change breaks every client that
  // has not reloaded yet — and both tanks are in the same room during a deploy.
  check(
    'and a client too old to send one still shows up, counted locally',
    late.old?.kills === 0 && late.old?.deaths === 0,
    JSON.stringify(late.old),
  )

  // The whole claim: their number wins over ours. Feed a death we *did* see,
  // so the local count is 1 and non-zero, then a tick claiming 5. If the local
  // count won, this reads 1 — and 1 is what every client used to disagree over.
  const prefers = await page.evaluate(
    (C, B, KIND_STATE, KIND_DEATH) => {
      window.__forget()
      window.__feed(B, KIND_DEATH, { t: Date.now(), k: C, x: 10, y: 10 })
      const counted = window.__rowFor(C)
      window.__feed(C, KIND_STATE, {
        t: Date.now(), x: 100, y: 100, h: 0, g: 0, hp: 3, d: false,
        ks: 5, ds: 1, r: window.__game.round,
      })
      return { counted, claimed: window.__rowFor(C) }
    },
    C, B, KIND_STATE, KIND_DEATH,
  )
  check(
    'a peer we have undercounted is corrected by its own tick',
    prefers.counted?.kills === 1 && prefers.claimed?.kills === 5,
    `locally ${prefers.counted?.kills}, then ${prefers.claimed?.kills}`,
  )

  // --- the round boundary --------------------------------------------------
  //
  // Nobody is the host, so every client rolls the round when it personally sees
  // the new tip and those moments are seconds apart. A peer still on the old
  // block keeps sending last round's tally into a scoreboard that has just
  // reset. Showing it would put a stale, inflated number in front of everyone;
  // dropping it costs that peer one second of reading 0/0.
  const boundary = await page.evaluate(
    (C, KIND_STATE) => {
      window.__forget()
      const round = window.__game.round
      window.__feed(C, KIND_STATE, {
        t: Date.now(), x: 100, y: 100, h: 0, g: 0, hp: 3, d: false,
        ks: 9, ds: 0, r: round - 1,
      })
      const stale = window.__rowFor(C)
      window.__feed(C, KIND_STATE, {
        t: Date.now(), x: 100, y: 100, h: 0, g: 0, hp: 3, d: false,
        ks: 1, ds: 0, r: round,
      })
      return { stale, fresh: window.__rowFor(C) }
    },
    C, KIND_STATE,
  )
  check(
    "last round's tally does not leak into this round's scoreboard",
    boundary.stale?.kills === 0,
    JSON.stringify(boundary.stale),
  )
  check(
    'and the same peer counts normally once it has rolled over',
    boundary.fresh?.kills === 1,
    JSON.stringify(boundary.fresh),
  )

  // A claim is self-reported and therefore forgeable — the README says so. What
  // it must not be is *unbounded*, because the scoreboard sorts on it and a
  // NaN or an Infinity there takes the whole panel out rather than merely
  // lying in it.
  const junk = await page.evaluate(
    (C, KIND_STATE) => {
      window.__forget()
      window.__feed(C, KIND_STATE, {
        t: Date.now(), x: 100, y: 100, h: 0, g: 0, hp: 3, d: false,
        ks: 1e12, ds: -5, r: window.__game.round,
      })
      const wild = window.__rowFor(C)
      window.__feed(C, KIND_STATE, {
        t: Date.now(), x: 100, y: 100, h: 0, g: 0, hp: 3, d: false,
        ks: 'lots', ds: null, r: window.__game.round,
      })
      return { wild, junk: window.__rowFor(C) }
    },
    C, KIND_STATE,
  )
  check(
    'a hostile tally is clamped rather than believed',
    junk.wild?.kills === 9999 && junk.wild?.deaths === 0,
    JSON.stringify(junk.wild),
  )
  check(
    'and a malformed one leaves the last good number alone',
    junk.junk?.kills === 9999,
    JSON.stringify(junk.junk),
  )

  // --- what we send --------------------------------------------------------
  //
  // The read path and the write path are two different questions and this suite
  // has only asked one of them so far. If our own tick does not carry a tally,
  // every check above passes and no two clients still agree — everyone would be
  // faithfully believing a number nobody sends.
  const sent = await page.evaluate(() => {
    const g = window.__game
    // Re-pinned here rather than trusting the pin at the top: the chain poller
    // is still running, and a real tip landing mid-suite rolls the round and
    // resets the tally underneath us. Everything from here to `publishState` is
    // synchronous, so nothing can move in between.
    g.beginRound(900000, 'ab'.repeat(30) + '0300')
    const seen = []
    const real = g.publishAsSession.bind(g)
    g.publishAsSession = (kind, payload) => {
      seen.push({ kind, payload })
      return real(kind, payload)
    }
    g.kills = 3
    g.deaths = 1
    g.publishState(performance.now())
    g.publishAsSession = real
    return seen.find((s) => s.kind === 21000)?.payload ?? null
  })
  check(
    'our own tick carries our tally, stamped with the round',
    sent?.ks === 3 && sent?.ds === 1 && sent?.r === 900000,
    JSON.stringify(sent),
  )
  // Zero is a fact, not an absence. An omitted tally is indistinguishable from
  // a client that cannot report one, which is exactly the case the fallback is
  // for — so a fresh player must say 0/0 out loud.
  const zero = await page.evaluate(() => {
    const g = window.__game
    let out = null
    const real = g.publishAsSession.bind(g)
    g.publishAsSession = (kind, payload) => {
      if (kind === 21000) out = payload
      return real(kind, payload)
    }
    g.kills = 0
    g.deaths = 0
    g.publishState(performance.now())
    g.publishAsSession = real
    return out
  })
  check(
    'and says 0/0 out loud rather than omitting it',
    zero?.ks === 0 && zero?.ds === 0,
    JSON.stringify(zero),
  )

  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '))
} catch (err) {
  check('the run completed', false, err.message)
} finally {
  await browser.close()
}

if (failures.length) {
  console.log(`\n${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nAll score checks passed.')
