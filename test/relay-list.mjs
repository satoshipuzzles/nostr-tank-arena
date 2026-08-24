// A new default relay has to reach a browser that has already played.
//
// The bug this guards: `main.ts` saves the relay list to localStorage on every
// start and reads the saved list in preference to `DEFAULT_RELAYS`. So the
// first match a browser ever plays pins its relay list forever, and coolfeed
// shipped as the first default three times without ever reaching the person
// who asked for it. "It's in the bundle" was true and useless.
//
// Two halves, and the second is the one that matters: the merge rule as
// arithmetic, then the actual lobby in an actual browser with a stale saved
// list in storage, which is the state every returning player is in.
//
//   npm run build && npm run preview &
//   node test/relay-list.mjs

import { build } from 'esbuild'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import puppeteer from 'puppeteer-core'

const URL = process.env.TANK_URL ?? 'http://localhost:4173/'
const OLD = ['wss://relay.mostr.pub', 'wss://relay.primal.net', 'wss://purplerelay.com']

let failures = 0
const check = (ok, label, detail = '') => {
  if (ok) console.log(`  ok   ${label}`)
  else { failures++; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

mkdirSync('.scratch', { recursive: true })
await build({
  entryPoints: ['src/nostr.ts'],
  bundle: true, format: 'esm', outfile: '.scratch/nostr-bundle.mjs',
  logLevel: 'silent', external: ['nostr-tools'],
})
const { DEFAULT_RELAYS, mergeRelays } = await import('../.scratch/nostr-bundle.mjs')
rmSync('.scratch/nostr-bundle.mjs')

console.log('merge rule')
check(mergeRelays(null, null).join() === DEFAULT_RELAYS.join(),
  'a browser that has never played gets the defaults')

// The migration case: played before, so a saved list, and no record of what it
// was offered. Everything new to it merges in, ahead of the saved list.
const migrated = mergeRelays(OLD.join('\n'), null)
for (const r of DEFAULT_RELAYS) {
  check(migrated.includes(r), `${r} reaches a browser that played before`)
}
check(migrated[0] === DEFAULT_RELAYS[0],
  'the fastest default leads the merged list', migrated[0])
check(OLD.every((r) => migrated.includes(r)), 'nothing the player had is dropped')

// A relay the player was offered and deleted stays deleted. Without this the
// merge is just "defaults always win" and the relay box stops being editable.
const pruned = mergeRelays('wss://relay.primal.net', DEFAULT_RELAYS.join('\n'))
check(pruned.join() === 'wss://relay.primal.net',
  'a default the player removed on purpose stays removed', pruned.join())

// And a browser fully up to date is left exactly alone.
const current = mergeRelays(DEFAULT_RELAYS.join('\n'), DEFAULT_RELAYS.join('\n'))
check(current.join() === DEFAULT_RELAYS.join(), 'an up-to-date list is untouched')

console.log('the real lobby, with a stale list in storage')
const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!executablePath) {
  console.log('  SKIP no Chrome found — set CHROME_PATH. The browser half did not run.')
  process.exit(failures ? 1 : 0)
}
const browser = await puppeteer.launch({
  executablePath, headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
try {
  const page = await browser.newPage()
  await page.goto(URL)
  // Exactly the state Puzz's browser was in: an old list saved by a previous
  // match, and no record of which defaults it had been shown.
  await page.evaluate((old) => {
    localStorage.setItem('tank.relays', old.join('\n'))
    localStorage.removeItem('tank.relays.offered')
  }, OLD)
  await page.reload()
  const box = await page.$eval('#relays', (el) => el.value)
  const lines = box.split('\n').map((s) => s.trim()).filter(Boolean)
  check(lines.includes(DEFAULT_RELAYS[0]),
    'the lobby box shows the new default after a reload', box.replace(/\n/g, ' | '))
  check(lines[0] === DEFAULT_RELAYS[0], 'and shows it first', lines[0])
  check(OLD.every((r) => lines.includes(r)), 'and keeps the relays already saved')
} finally {
  await browser.close()
}
process.exit(failures ? 1 : 0)
