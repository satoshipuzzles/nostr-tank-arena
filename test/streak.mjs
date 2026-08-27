// The streak strip: what the next kill buys you.
//
// cloudfodder, mid-match, in #tank-issues: "how am I supposed to get to the
// choppa?" The ladder had worked for days and nothing on the screen had ever
// admitted it existed. So the claim under test is not "a reward fires" —
// test/chopper-browser.mjs already proves that — it is "the screen tells you
// what the next kill buys, and what it says is what the game then hands over."
//
// Everything here climbs the ladder through the *real* kill path: a peer
// publishes a death naming us as the killer, which is what `onDeath` ->
// `onOwnKill` -> the ladder reads. Setting `game.streak` and then reading the
// strip would test the strip given an answer; it could not test whether a kill
// ever produces one. The one place a streak is set directly is to skip *up* to
// the rung under test, and the kill that lands on the rung is still real.
//
//   npm run build && npx vite preview --port 4203 &
//   npm run test:streak

import { existsSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4203/'
const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!executablePath) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2) }

const FLAGS = [
  '--no-sandbox', '--window-size=1280,800', '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--disable-gpu-sandbox', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
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
    await wait(80)
  }
  return null
}

const PEER = 'd1'.repeat(32)
// A pinned tip. Anything derived from the live chain — the map, the rules —
// makes a run non-deterministic, and a strip that reads correctly against one
// block and not another is a test that fails on a Tuesday.
const HASH = 'ab'.repeat(30) + '0300'

const browser = await puppeteer.launch({ executablePath, headless: 'new', args: FLAGS })
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800 })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

// Read the strip the way a player does: off the screen, not off the model.
const strip = () =>
  page.evaluate(() => {
    const n = document.getElementById('streak')
    if (!n || n.hidden) return { hidden: true }
    const bar = n.querySelector('.streak-bar i')
    return {
      hidden: false,
      text: (n.textContent ?? '').replace(/\s+/g, ' ').trim(),
      next: n.querySelector('.streak-next')?.textContent?.trim() ?? '',
      cls: n.className,
      bar: bar ? bar.style.width : null,
      // A strip drawn behind the magazine or off the bottom of the screen is
      // the failure this repo keeps shipping: visible in the DOM, never a pixel.
      box: (() => {
        const r = n.getBoundingClientRect()
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width) }
      })(),
    }
  })

/**
 * Wait for the strip to be showing a particular streak.
 *
 * Not for `window.__game.streak` to reach it, and not for a fixed number of
 * milliseconds. The HUD repaints eight times a second, so reading the model and
 * then returning a snapshot of the DOM returns *last* frame's strip — which is
 * how the first version of this file passed a check about "1 more" against the
 * previous rung's leftovers. Poll on the exact number the strip should be
 * showing; a shared substring matches the case before it.
 */
const stripShowing = (streak) =>
  until(async () => {
    const s = await strip()
    if (s.hidden) return null
    const want = streak === 0 ? /no streak/ : new RegExp(`(^|\\D)${streak} in a row`)
    return want.test(s.text) ? s : null
  })

// One kill, through the death path.
const kill = async (expectStreak) => {
  await page.evaluate((PEER) => {
    const g = window.__game
    g.tank.dead = false
    g.onEvent({
      id: 'a' + Math.random().toString(16).slice(2),
      pubkey: PEER, kind: 21002, created_at: Math.floor(Date.now() / 1000), tags: [], sig: '0'.repeat(128),
      content: JSON.stringify({ t: Date.now(), k: g.identity.sessionPubkey, x: 400, y: 400 }),
    }, false)
  }, PEER)
  return stripShowing(expectStreak)
}

try {
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.type('#name', 'streak')
  await page.type('#room', 'stk' + Math.floor(Math.random() * 1e6))
  await page.click('#play-guest')
  const started = await page
    .waitForFunction(() => !!window.__game, { timeout: 25_000 })
    .then(() => true).catch(() => false)
  check('a game is running', started)
  if (!started) throw new Error('the game never started')

  await page.evaluate((hash) => {
    window.__clock.accept({ height: 900000, hash, time: Math.floor(Date.now() / 1000) - 30 })
    window.__clock.accept = () => {}
    const g = window.__game
    g.beginRound(900000, hash)
    g.beginRound = () => {}
    // Bots would earn kills of their own and move the number underneath us.
    g.botsEnabled = false
    g.bots = []
    document.getElementById('podium').hidden = true
  }, HASH)
  await wait(600)

  // --- 1. the cold state, which is the entire bug ---------------------------

  const cold = await until(async () => {
    const s = await strip()
    return s.hidden ? null : s
  })
  check('the strip is on screen before anybody has killed anything', !!cold && !cold.hidden)
  check(
    'and it names the first rung rather than waiting to be earned',
    /3 more/.test(cold?.next ?? '') && /hull repair/.test(cold?.next ?? ''),
    JSON.stringify(cold?.next),
  )
  check(
    'a cold strip says there is no streak rather than showing a zero',
    /no streak/.test(cold?.text ?? ''),
    JSON.stringify(cold?.text),
  )
  check(
    'and it is on the glass, not under the bottom edge',
    !!cold && cold.box.bottom < 800 && cold.box.top > 0 && cold.box.w > 60,
    JSON.stringify(cold?.box),
  )

  // The ladder is also announced once, in the feed, so a player can see the
  // whole thing on the way in without a permanent legend on the HUD.
  const feed = await page.evaluate(() =>
    [...document.querySelectorAll('#feed div')].map((d) => d.textContent).join(' | '))
  check(
    'the whole ladder is announced once on the way in',
    /streaks:/.test(feed) && /10 chopper/.test(feed) && /25 carpet bombing/.test(feed),
    JSON.stringify(feed.slice(0, 120)),
  )

  // --- 2. one real kill moves it -------------------------------------------

  const one = await kill(1)
  check('one kill reads as one in a row', /1 in a row/.test(one?.text ?? ''), JSON.stringify(one?.text))
  check(
    'and the promise counts down rather than staying put',
    /2 more/.test(one?.next ?? ''),
    JSON.stringify(one?.next),
  )
  check(
    'the bar fills across the rung, not across the ladder',
    one?.bar === '33%',
    `bar ${one?.bar} — one of three toward a rung at 3, not one of twenty-five`,
  )

  const two = await kill(2)
  check('one away lights up', two?.cls === 'close', JSON.stringify({ cls: two?.cls, next: two?.next }))
  check(
    'and says so in words, not only in colour',
    /1 more/.test(two?.next ?? ''),
    JSON.stringify(two?.next),
  )

  // --- 3. the rung lands, and the strip moves to the next one ---------------

  const three = await kill(3)
  check(
    'landing a rung moves the promise to the one above it',
    /2 more/.test(three?.next ?? '') && /air strike/.test(three?.next ?? ''),
    JSON.stringify(three?.next),
  )
  check('and the bar starts over from the rung it just left', three?.bar === '0%', String(three?.bar))
  check('a landed rung is not still being advertised', !/hull repair/.test(three?.next ?? ''))

  // --- 4. the strip and the ladder are the same table -----------------------
  //
  // The drift this guards: a HUD promising a chopper at ten while the ladder
  // hands out something else. So for every rung, read what the strip promised
  // one kill early, land the kill for real, and require the banner the game
  // then puts on screen to be about the thing that was promised.

  // The tiers moved when each one got its own pool of five: the rungs are now
  // three plus the four tiers a player fills, and 7 and 20 are not rungs at
  // all. Read from the game rather than written out again — the whole point of
  // section 4 is that the strip and the ladder are one table.
  const RUNGS = await page.evaluate(() => window.__game.ladder.map((r) => r.at))
  for (const at of RUNGS) {
    await page.evaluate((n) => { window.__game.streak = n - 1 }, at)
    const before = await stripShowing(at - 1)
    const promised = (before?.next ?? '').replace(/^1 more\s*→\s*/, '').trim()
    await kill(at)
    const banner = await until(() =>
      page.evaluate(() => {
        const n = document.getElementById('notice')
        if (!n || n.hidden) return null
        return { title: n.querySelector('b')?.textContent ?? '', sub: n.querySelector('span')?.textContent ?? '' }
      }))
    check(
      `the ${at}-kill banner delivers what the strip promised`,
      !!promised && !!banner && banner.sub.includes(promised) && banner.title.includes(String(at)),
      `promised ${JSON.stringify(promised)}, banner ${JSON.stringify(banner)}`,
    )
    // Let the banner expire so the next rung reads its own, not this one's.
    await page.evaluate(() => { if (window.__game.notice) window.__game.notice.at -= 5000 })
  }

  // --- 5. the top of the ladder stops promising -----------------------------

  await page.evaluate(() => { window.__game.streak = 25 })
  const top = await stripShowing(25)
  check(
    'past the last rung the strip stops making promises',
    top?.cls === 'top',
    JSON.stringify({ cls: top?.cls, text: top?.text }),
  )
  check(
    'and keeps counting instead',
    /25 in a row/.test(top?.text ?? '') && /unstoppable/.test(top?.text ?? ''),
    JSON.stringify(top?.text),
  )
  check('there is no next rung to advertise', !/more →/.test(top?.text ?? ''), JSON.stringify(top?.text))

  // --- 6. dying puts it back --------------------------------------------

  await page.evaluate(() => {
    const g = window.__game
    g.streak = 7
  })
  await stripShowing(7)
  await page.evaluate(() => { window.__game.streak = 0 })
  const reset = await stripShowing(0)
  check(
    'losing the streak puts the first rung back on the strip',
    !!reset && /3 more/.test(reset.next) && /hull repair/.test(reset.next),
    JSON.stringify(reset?.next),
  )

  // --- 7. and it survives a phone ------------------------------------------
  //
  // Bottom centre is free on a desk and contested on a phone: the magazine is
  // directly underneath and the thumb sticks are in the corners. A strip drawn
  // through the ammo pips is worse than no strip, and this repo has shipped
  // exactly that failure before — legible in a screenshot only if you already
  // knew where to look.

  const phone = await browser.newPage()
  await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  await phone.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await phone.type('#name', 'thumb')
  await phone.type('#room', 'thm' + Math.floor(Math.random() * 1e6))
  await phone.click('#play-guest')
  const phoneUp = await phone
    .waitForFunction(() => !!window.__game, { timeout: 25_000 })
    .then(() => true).catch(() => false)
  check('a game is running on a phone-sized screen', phoneUp)

  if (phoneUp) {
    await wait(900)
    const geo = await phone.evaluate(() => {
      const box = (id) => {
        const n = document.getElementById(id)
        if (!n || n.hidden) return null
        const r = n.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }
      }
      const overlaps = (a, b) =>
        !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
      const st = box('streak')
      return {
        streak: st,
        ammo: box('ammo'),
        overAmmo: overlaps(st, box('ammo')),
        vw: window.innerWidth,
        vh: window.innerHeight,
        text: (document.getElementById('streak')?.textContent ?? '').replace(/\s+/g, ' ').trim(),
      }
    })
    check(
      'the strip is on the glass on a phone too',
      !!geo.streak && geo.streak.left >= 0 && geo.streak.right <= geo.vw && geo.streak.bottom <= geo.vh,
      JSON.stringify(geo.streak),
    )
    check(
      'and it is not drawn through the magazine',
      geo.overAmmo === false,
      JSON.stringify({ streak: geo.streak, ammo: geo.ammo }),
    )
    check('and it still says what the next kill buys', /hull repair/.test(geo.text), JSON.stringify(geo.text))
    if (process.env.TANK_PHONE_SHOT) {
      await phone.screenshot({ path: process.env.TANK_PHONE_SHOT })
      console.log(`      wrote ${process.env.TANK_PHONE_SHOT}`)
    }
    await phone.close()
  }

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))

  if (process.env.TANK_SHOT) {
    await page.screenshot({ path: process.env.TANK_SHOT })
    console.log(`      wrote ${process.env.TANK_SHOT}`)
  }
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
console.log('All streak-strip checks passed.')
