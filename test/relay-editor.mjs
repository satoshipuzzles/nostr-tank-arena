// The relay editor: add, remove, reorder, test, save — and the save surviving
// a reload, which is the half the old textarea never did.
//
// Two bugs this exists for. The first is Puzz's: the relay box only wrote to
// storage when you pressed Play, so an edit you made and did not play was
// gone. The second is subtler and is why the dots exist at all — a relay that
// accepts a socket and never answers is not the same thing as one that refuses
// the socket, and the old UI had no way to say either. Collapsing those two
// into "offline" is how a mixed-content block reads as a dead relay.
//
//   npm run build
//   npx vite preview --port 4189 --strictPort &   # from THIS worktree
//   TANK_URL=http://localhost:4189/ node test/relay-editor.mjs

import { build } from 'esbuild'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import puppeteer from 'puppeteer-core'

const URL_ = process.env.TANK_URL ?? 'http://localhost:4173/'

let failures = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ok   ${label}`)
  else {
    failures++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ------------------------------------------------------------- the URL rules
mkdirSync('.scratch', { recursive: true })
await build({
  entryPoints: ['src/relays.ts'],
  bundle: true,
  format: 'esm',
  outfile: '.scratch/relays-bundle.mjs',
  logLevel: 'silent',
})
const { normalizeRelay, parseRelayList, blockedByMixedContent } = await import(
  '../.scratch/relays-bundle.mjs'
)
rmSync('.scratch/relays-bundle.mjs')

// The shipped defaults, so the seeded `offered` record can name them exactly.
// Anything else and `mergeRelays` correctly decides this browser has never been
// shown them and folds all four into the list — which is the feature working,
// not the editor misbehaving, and it took a failing run to notice.
await build({
  entryPoints: ['src/nostr.ts'],
  bundle: true,
  format: 'esm',
  outfile: '.scratch/nostr-bundle.mjs',
  logLevel: 'silent',
  external: ['nostr-tools'],
})
const { DEFAULT_RELAYS } = await import('../.scratch/nostr-bundle.mjs')
rmSync('.scratch/nostr-bundle.mjs')

console.log('what counts as a relay address')
check(normalizeRelay('wss://relay.example.com') === 'wss://relay.example.com', 'a wss URL is kept')
check(normalizeRelay('  wss://relay.example.com  ') === 'wss://relay.example.com', 'and trimmed')
check(
  normalizeRelay('wss://relay.example.com/') === 'wss://relay.example.com',
  'the trailing slash goes, or adding a default back makes a duplicate row',
  String(normalizeRelay('wss://relay.example.com/')),
)
check(
  normalizeRelay('relay.example.com') === 'wss://relay.example.com',
  'a bare hostname becomes wss — that is what a paste out of a profile looks like',
)
check(normalizeRelay('ws://localhost:7788') === 'ws://localhost:7788', 'ws:// is allowed')
check(
  normalizeRelay('wss://relay.example.com/nostr') === 'wss://relay.example.com/nostr',
  'a path is kept',
)
check(normalizeRelay('https://relay.example.com') === null, 'an https URL is refused, not rewritten')
check(normalizeRelay('') === null && normalizeRelay('   ') === null, 'empty is nothing')
check(normalizeRelay('not a url at all') === null, 'prose is refused', String(normalizeRelay('not a url at all')))
check(
  parseRelayList('wss://a.example\n wss://b.example, wss://a.example').join() ===
    'wss://a.example,wss://b.example',
  'a paste splits on whitespace and commas, and dedupes',
)

console.log('the mixed-content trap')
check(
  blockedByMixedContent('ws://relay.example.com', 'https:') === true,
  'ws:// from an https page is blocked by the browser and the row should say so',
)
check(
  blockedByMixedContent('wss://relay.example.com', 'https:') === false,
  'wss:// from https is fine',
)
check(blockedByMixedContent('ws://relay.example.com', 'http:') === false, 'ws:// from http is fine')
check(
  blockedByMixedContent('ws://localhost:4173', 'https:') === false,
  'localhost is the exception browsers make, and it is how this game is tested',
)

// ------------------------------------------------------------- fake relays
// Three, because the point is that the probe can tell them apart. A test where
// every relay answers cannot fail for the reason this feature exists.
const healthy = new WebSocketServer({ port: 0 })
healthy.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let frame
    try {
      frame = JSON.parse(String(raw))
    } catch {
      return
    }
    if (frame[0] === 'REQ') ws.send(JSON.stringify(['EOSE', frame[1]]))
  })
})
// Accepts the socket, answers nothing. This is the shape a hop that is not
// working takes, and it is not a refusal.
const silent = new WebSocketServer({ port: 0 })
silent.on('connection', () => {})

const HEALTHY = `ws://localhost:${healthy.address().port}`
const SILENT = `ws://localhost:${silent.address().port}`
const DEAD = 'ws://localhost:9' // discard port: nothing is listening
const SEED = [HEALTHY, SILENT, DEAD]

const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
]
  .filter(Boolean)
  .find((p) => existsSync(p))
if (!executablePath) {
  console.log('  SKIP no Chrome found — set CHROME_PATH. The browser half did not run at all.')
  healthy.close()
  silent.close()
  process.exit(failures ? 1 : 0)
}

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})

const rows = (page) =>
  page.$$eval('#relay-rows .relay-row', (els) => els.map((el) => el.dataset.url))
const statuses = (page) =>
  page.$$eval('#relay-rows .relay-row', (els) =>
    Object.fromEntries(els.map((el) => [el.dataset.url, el.dataset.status])),
  )
const msg = (page) => page.$eval('#relay-msg', (el) => el.textContent.trim())
const until = async (page, fn, ms = 12000) => {
  const stop = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() > stop) return false
    await new Promise((r) => setTimeout(r, 120))
  }
}

try {
  const page = await browser.newPage()
  await page.setViewport({ width: 900, height: 1600 })
  await page.goto(URL_)
  await page.evaluate((seed) => {
    localStorage.setItem('tank.relays', seed.list.join('\n'))
    // Pretend every shipped default has already been offered, so the merge
    // rule leaves this list alone and the test is about the editor.
    localStorage.setItem('tank.relays.offered', seed.offered.join('\n'))
  }, { list: SEED, offered: DEFAULT_RELAYS })
  await page.reload()

  console.log('the rows are the list')
  check((await rows(page)).join() === SEED.join(), 'one row per saved relay, in order', (await rows(page)).join(' | '))
  check(
    (await page.$eval('#relay-count', (el) => el.textContent)) === '3',
    'and the count agrees',
  )
  check(
    (await page.$eval('#relay-save', (el) => el.disabled)) === true,
    'nothing is dirty on load, so Save is disabled',
  )

  console.log('opening the panel tests the relays, and tells the three apart')
  await page.$eval('#advanced', (d) => {
    d.open = true
    d.dispatchEvent(new Event('toggle'))
  })
  const settled = await until(page, async () => {
    const s = await statuses(page)
    return Object.values(s).every((v) => v !== 'unknown' && v !== 'checking')
  })
  check(settled, 'every dot resolves')
  const s1 = await statuses(page)
  check(s1[HEALTHY] === 'ok', 'a relay that answers reads ok', s1[HEALTHY])
  check(s1[DEAD] === 'refused', 'a port with nothing on it reads refused', s1[DEAD])
  check(
    s1[SILENT] === 'silent',
    'a relay that takes the socket and says nothing is silent, not refused',
    s1[SILENT],
  )
  check(
    (await page.$eval(`#relay-rows .relay-row[data-url="${HEALTHY}"] .state`, (el) => el.textContent)).includes('ms'),
    'and the healthy row carries the round trip',
  )

  // A probe landing must not rebuild the list. It used to, and mid-"Test all"
  // — exactly when a player is deciding what to delete — a tap landed on a
  // button that had just been replaced. Puppeteer found it first, as "Node is
  // detached from document".
  console.log('a dot changing does not tear the rows down')
  const marked = await page.evaluate(() => {
    document.querySelectorAll('#relay-rows .relay-row').forEach((el, i) => (el.dataset.mark = String(i)))
    return document.querySelectorAll('#relay-rows .relay-row').length
  })
  await page.click('#relay-test')
  await until(page, async () => (await page.$eval('#relay-test', (el) => el.disabled)) === false)
  const survived = await page.$$eval('#relay-rows .relay-row', (els) =>
    els.filter((el) => el.dataset.mark !== undefined).length,
  )
  check(survived === marked, 'the same row elements are still there after every probe returns', `${survived}/${marked}`)

  console.log('add')
  await page.type('#relay-add-url', 'wss://added.example.com')
  await page.click('#relay-add-go')
  check((await rows(page)).includes('wss://added.example.com'), 'a typed relay lands in the list')
  check(
    (await page.$eval('#relay-save', (el) => el.disabled)) === false,
    'and the Save button wakes up',
  )
  check(
    (await page.$eval('#relay-add-url', (el) => el.value)) === '',
    'and the box clears so the next one can be typed',
  )

  await page.$eval('#relay-add-url', (el) => (el.value = ''))
  await page.type('#relay-add-url', 'wss://added.example.com/')
  await page.click('#relay-add-go')
  check(
    (await rows(page)).filter((r) => r === 'wss://added.example.com').length === 1,
    'the same relay with a trailing slash is not a second row',
  )
  check((await msg(page)).includes('Already'), 'and it says so', await msg(page))

  const before = (await rows(page)).length
  await page.$eval('#relay-add-url', (el) => (el.value = ''))
  await page.type('#relay-add-url', 'https://relay.example.com')
  await page.click('#relay-add-go')
  check((await rows(page)).length === before, 'an https URL is refused rather than added')
  check((await msg(page)).includes('not a relay address'), 'and it says why', await msg(page))
  await page.$eval('#relay-add-url', (el) => (el.value = ''))

  console.log('reorder')
  await page.click(`#relay-rows .relay-row[data-url="${DEAD}"] .up`)
  check(
    (await rows(page))[1] === DEAD,
    'a row moves up one place',
    (await rows(page)).join(' | '),
  )
  check(
    (await page.$eval('#relay-rows .relay-row:first-child .up', (el) => el.disabled)) === true,
    'the top row cannot move up',
  )

  console.log('remove')
  await page.click(`#relay-rows .relay-row[data-url="${SILENT}"] .del`)
  check(!(await rows(page)).includes(SILENT), 'the × takes the row out')
  check(
    (await page.$eval('#relays', (el) => el.value)).includes(SILENT) === false,
    'and out of the text model behind it',
  )

  console.log('save, and the reload that is the whole point')
  const wanted = await rows(page)
  await page.click('#relay-save')
  check((await msg(page)).startsWith('Saved'), 'Save says so', await msg(page))
  check(
    (await page.$eval('#relay-save', (el) => el.disabled)) === true,
    'and goes quiet again',
  )
  const written = await page.evaluate(() => localStorage.getItem('tank.relays'))
  check(written === wanted.join('\n'), 'storage holds exactly the rows', String(written))

  await page.reload()
  const after = await rows(page)
  check(after.join() === wanted.join(), 'and a reload brings back the same list, in the same order', after.join(' | '))
  check(
    !after.includes(SILENT),
    'the relay removed on purpose stays removed',
  )

  console.log('restore defaults')
  await page.$eval('#advanced', (d) => (d.open = true))
  await page.click('#relay-reset')
  const restored = await rows(page)
  check(restored.length >= 4 && restored.every((r) => r.startsWith('wss://')), 'the shipped defaults come back', restored.join(' | '))
  check(
    (await page.$eval('#relay-save', (el) => el.disabled)) === false,
    'as an unsaved change, so a misclick is one reload away from undone',
  )

  console.log('an empty list is refused rather than silently reverted')
  for (const url of await rows(page)) {
    await page.click(`#relay-rows .relay-row[data-url="${url}"] .del`)
  }
  check((await rows(page)).length === 0, 'all rows removed')
  await page.click('#relay-save')
  check((await msg(page)).includes('at least one'), 'Save refuses an empty list', await msg(page))
  check(
    (await page.evaluate(() => localStorage.getItem('tank.relays'))) !== '',
    'and storage is untouched',
  )

  // The case that actually needs `tank.relays.offered`: a browser with no
  // record of what it has been offered, which is every browser until it plays.
  // Remove a shipped default, save, reload. If Save writes only the list, the
  // merge rule correctly decides this browser has never seen that default and
  // puts it straight back — and the player's removal is silently undone.
  //
  // The earlier reload check cannot see this: it seeds `offered` itself, so it
  // passes whether or not Save writes it.
  console.log('a default removed and saved stays removed on a browser that has never played')
  const fresh = await browser.newPage()
  await fresh.setViewport({ width: 900, height: 1600 })
  // No sockets leave this machine for this case. It is about what Save writes,
  // and probing four public relays to find that out would be rude and flaky.
  await fresh.evaluateOnNewDocument(() => {
    class DeadSocket {
      static OPEN = 1
      constructor() {
        this.readyState = 3
        setTimeout(() => this.onerror && this.onerror({}), 0)
      }
      send() {}
      close() {}
    }
    window.WebSocket = DeadSocket
  })
  await fresh.goto(URL_)
  await fresh.evaluate(() => localStorage.clear())
  await fresh.reload()
  const shipped = await rows(fresh)
  check(shipped.join() === DEFAULT_RELAYS.join(), 'a never-played browser opens on the defaults', shipped.join(' | '))
  await fresh.$eval('#advanced', (d) => (d.open = true))
  const doomed = shipped[0]
  await fresh.click(`#relay-rows .relay-row[data-url="${doomed}"] .del`)
  await fresh.click('#relay-save')
  await fresh.reload()
  const kept = await rows(fresh)
  check(!kept.includes(doomed), `${doomed} stays removed across a reload`, kept.join(' | '))
  check(kept.join() === shipped.slice(1).join(), 'and the rest is untouched', kept.join(' | '))
  await fresh.close()

  console.log('the game still reads the same box')
  await page.reload()
  const used = await page.evaluate(() => {
    const box = document.getElementById('relays')
    return box.value.split('\n').filter(Boolean)
  })
  check(used.length > 0, 'readRelays still has a list to read', used.join(' | '))
} finally {
  await browser.close()
  healthy.close()
  silent.close()
}
process.exit(failures ? 1 : 0)
