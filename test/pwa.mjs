// Add to home screen, end to end.
//
// Puzz: "First thing we need is mobile. most users will be on iphone. we need
// this to work as a PWA."
//
// Everything an installable app needs is already in the repo — a manifest, four
// icons, `apple-mobile-web-app-capable`, a service worker. None of that had ever
// been *run*, and the pieces of a PWA fail silently by design: a manifest with a
// bad icon path installs a blank square, and a service worker whose offline
// fallback misses just serves a network error to somebody who tapped the icon
// on their home screen. There is no console anybody is looking at on a phone.
//
// So this asks the questions in the order the phone asks them:
//
//   1. Is the manifest served, parseable, and pointing at icons that exist and
//      are the size they claim?
//   2. Do the iOS-specific tags exist? iOS ignores the manifest's `display` and
//      reads `apple-mobile-web-app-capable` instead, so a manifest that is
//      perfect on Android can still open in a Safari tab with a URL bar.
//   3. Does the service worker actually take control?
//   4. **With the network gone, does the app still open?** Both at `/` and at
//      the URL somebody actually has on their home screen, which for this game
//      is `/?room=something` — the game rewrites the address bar the moment you
//      join, so that is the URL that gets bookmarked.
//
// The last one is the whole point. Everything above it can be right while the
// app that was added to a home screen shows an error page in a lift.
//
//   npm run build && npx vite preview --port 4197 &
//   npm run test:pwa

import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import puppeteer from 'puppeteer-core'

/**
 * The suite serves `dist/` itself, so it can *stop* serving it.
 *
 * This is the only honest way to test the offline path, and getting here took
 * three wrong controls. Chrome's `Network.emulateNetworkConditions offline` is
 * scoped to the target you send it to, and a service worker is its own target:
 * with the page offline the worker went on fetching from a server that was
 * still running, so every URL loaded and the suite reported a working offline
 * mode against a fallback that could not possibly have run. `setCacheDisabled`
 * and `clearBrowserCache` did not help either, for the same reason.
 *
 * Killing the origin needs no cooperation from anybody's network stack. If the
 * server is gone and the document still arrives, it came out of Cache Storage.
 *
 * Set TANK_URL to point at a deployment instead; the offline section then skips
 * loudly, because a live origin cannot be switched off from here.
 */
const EXTERNAL = process.env.TANK_URL ?? null
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
}
let server = null
let sockets = new Set()
let port = 0
async function serveDist() {
  const root = 'dist'
  if (!existsSync(root)) {
    console.error('No dist/. Run `npm run build` first.')
    process.exit(2)
  }
  server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    let file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''))
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html')
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      // No HTTP caching at all. What is being tested is Cache Storage, and a
      // disk-cache hit is indistinguishable from a Cache Storage hit at the
      // point where it matters.
      'cache-control': 'no-store',
    })
    createReadStream(file).pipe(res)
  })
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)) })
  // The same port every time it comes back. The second control below needs a
  // live page on the *same origin* to unregister the worker from, and a page
  // whose navigation has genuinely failed has no execution context to run
  // anything in — so the origin is brought back, the page reloaded, the worker
  // removed, and the origin taken away again.
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  port = server.address().port
  return `http://127.0.0.1:${port}/`
}
/** Stop answering, and drop the keep-alive sockets so nothing is in flight. */
async function killServer() {
  if (!server) return
  for (const s of sockets) s.destroy()
  await new Promise((r) => server.close(r))
  server = null
}

const URL_ = EXTERNAL ?? (await serveDist())
const executablePath = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].filter(Boolean).find((p) => existsSync(p))
if (!executablePath) { console.error('No Chrome found. Set CHROME_PATH.'); process.exit(2) }

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures.push(name)
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// A service worker will not install over plain http on a non-localhost origin,
// so an https preview or a deployed URL has to be reachable by name. Say so
// rather than reporting a pass against a page that never registered one.
const origin = new URL(URL_).origin
const secure = origin.startsWith('https://') || /^https?:\/\/(localhost|127\.0\.0\.1)/.test(origin)

const browser = await puppeteer.launch({
  executablePath,
  headless: 'new',
  args: ['--no-sandbox', '--window-size=852,393', '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--mute-audio', '--autoplay-policy=no-user-gesture-required'],
})
const page = await browser.newPage()
// A phone, because that is the device this feature is for.
await page.setViewport({ width: 852, height: 393, hasTouch: true, isMobile: true })
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(e.message))

try {
  check('the origin can host a service worker at all', secure, origin)

  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 30_000 })

  // ------------------------------------------------------------ 1. manifest

  const head = await page.evaluate(() => ({
    manifest: document.querySelector('link[rel=manifest]')?.getAttribute('href') ?? null,
    themeColor: document.querySelector('meta[name=theme-color]')?.getAttribute('content') ?? null,
    appleCapable: document.querySelector('meta[name=apple-mobile-web-app-capable]')?.getAttribute('content') ?? null,
    appleTitle: document.querySelector('meta[name=apple-mobile-web-app-title]')?.getAttribute('content') ?? null,
    appleIcon: document.querySelector('link[rel=apple-touch-icon]')?.getAttribute('href') ?? null,
    viewport: document.querySelector('meta[name=viewport]')?.getAttribute('content') ?? null,
  }))
  check('the page links a manifest', !!head.manifest, JSON.stringify(head.manifest))

  const manifestUrl = new URL(head.manifest ?? '/manifest.webmanifest', URL_).toString()
  const manifest = await page.evaluate(async (u) => {
    const r = await fetch(u)
    return { status: r.status, type: r.headers.get('content-type'), body: await r.text() }
  }, manifestUrl)
  check('and it is actually served', manifest.status === 200, `${manifest.status} ${manifest.type}`)

  let parsed = null
  try { parsed = JSON.parse(manifest.body) } catch { /* reported below */ }
  check('and it parses as JSON', !!parsed)
  check(
    'and it names the app, a start url and a scope',
    !!parsed?.name && !!parsed?.short_name && !!parsed?.start_url && !!parsed?.scope,
    JSON.stringify({ name: parsed?.name, start_url: parsed?.start_url, scope: parsed?.scope }),
  )
  // Landscape, because this is a game played on a TV-shaped board and a portrait
  // phone shows about a third of it.
  check('and it asks for landscape', parsed?.orientation === 'landscape', String(parsed?.orientation))

  // ---------------------------------------------------------------- 2. icons

  // Every icon fetched and *decoded*, not merely 200. A 404 page served with a
  // 200 by a catch-all rewrite is the classic way an installed app ends up with
  // a blank square, and only decoding it tells the two apart.
  const icons = await page.evaluate(async (list, base) => {
    const out = []
    for (const icon of list) {
      const url = new URL(icon.src, base).toString()
      try {
        const r = await fetch(url)
        const blob = await r.blob()
        const bmp = await createImageBitmap(blob)
        out.push({ src: icon.src, claimed: icon.sizes, status: r.status, type: blob.type,
          real: `${bmp.width}x${bmp.height}`, purpose: icon.purpose ?? 'any' })
      } catch (e) {
        out.push({ src: icon.src, claimed: icon.sizes, error: String(e) })
      }
    }
    return out
  }, parsed?.icons ?? [], URL_)
  console.log('      ' + icons.map((i) => `${i.src} ${i.claimed}->${i.real ?? i.error}`).join('  '))
  check(
    'every manifest icon exists and is the size it claims',
    icons.length >= 2 && icons.every((i) => i.status === 200 && i.real === i.claimed),
    JSON.stringify(icons),
  )
  check(
    'and one of them is maskable, so Android does not letterbox it',
    icons.some((i) => (i.purpose ?? '').includes('maskable')),
    icons.map((i) => i.purpose).join(','),
  )

  // ------------------------------------------------------------- 3. the iOS bits

  // iOS ignores `display` in the manifest entirely. Without these three the app
  // opens in a Safari tab with a URL bar over the board, which on a 393px-tall
  // phone is a real fraction of the arena.
  check('iOS is told the app is standalone-capable', head.appleCapable === 'yes', String(head.appleCapable))
  check('and given a home-screen title', !!head.appleTitle, String(head.appleTitle))
  const appleIcon = head.appleIcon ? await page.evaluate(async (u) => {
    const r = await fetch(u)
    const b = await r.blob()
    const bmp = await createImageBitmap(b)
    return { status: r.status, size: `${bmp.width}x${bmp.height}` }
  }, new URL(head.appleIcon, URL_).toString()) : null
  check('and an apple-touch-icon that exists at 180x180',
    appleIcon?.status === 200 && appleIcon.size === '180x180', JSON.stringify(appleIcon))
  // The notch. Without `viewport-fit=cover` the safe-area insets the stylesheet
  // reads are all zero and the HUD sits in the black bars.
  check('and a viewport that covers the notch',
    (head.viewport ?? '').includes('viewport-fit=cover'), String(head.viewport))

  // -------------------------------------------------- 4. offline, the real test

  if (EXTERNAL) {
    console.log('SKIP  the offline checks: TANK_URL points at an origin this suite cannot switch off')
  } else {
    const controlled = await page.waitForFunction(
      () => navigator.serviceWorker && navigator.serviceWorker.controller !== null,
      { timeout: 20_000 },
    ).then(() => true).catch(() => false)
    check('a service worker takes control of the page', controlled)

    // Warm it the way a player does: open the game once, at the URL the game
    // itself puts in the address bar.
    const room = 'pwa' + Math.floor(Math.random() * 1e6)
    await page.goto(`${URL_}?room=${room}`, { waitUntil: 'load', timeout: 30_000 })
    await wait(1500)

    const cached = await page.evaluate(async () => {
      const names = await caches.keys()
      const out = []
      for (const n of names) out.push(...(await (await caches.open(n)).keys()).map((r) => r.url))
      return { names, urls: out }
    })
    console.log(`      cache ${cached.names.join(',')}: ${cached.urls.length} entries`)
    check(
      'and it has the shell and the bundle in a cache after one visit',
      cached.urls.some((u) => u.endsWith('.js')) && cached.urls.some((u) => u.endsWith('.css')),
      cached.urls.map((u) => u.replace(origin, '')).join(' '),
    )

    const openOffline = async (path) => {
      try {
        const res = await page.goto(`${URL_.replace(/\/$/, '')}${path}`, {
          waitUntil: 'domcontentloaded', timeout: 15_000,
        })
        const booted = await page.evaluate(() => !!document.getElementById('lobby'))
        return { status: res?.status() ?? null, booted }
      } catch (e) {
        return { status: null, booted: false, error: String(e).split('\n')[0].slice(0, 70) }
      }
    }

    // The server stops existing. Not emulated, not throttled: gone.
    await killServer()
    check('the origin is really down', await (async () => {
      try { await fetch(URL_); return false } catch { return true }
    })())

    const bare = await openOffline('/')
    check('offline, the app still opens at the site root', bare.booted, JSON.stringify(bare))

    // The one that matters. `Game` rewrites the address bar to `?room=...` the
    // moment you join, so that is the URL on somebody's home screen — and under
    // the old worker it was a different cache key from `/`.
    const withRoom = await openOffline(`/?room=${room}`)
    check('offline, it opens at the ?room= url the game puts in the address bar',
      withRoom.booted, JSON.stringify(withRoom))

    // A room it has never seen: somebody sends an invite link and you tap it on
    // the underground. Nothing about that URL is in any cache, and under the old
    // worker this was the case that returned a network error.
    const strange = await openOffline('/?room=never-visited-' + Math.floor(Math.random() * 1e6))
    check('offline, it opens at a room url it has never seen before',
      strange.booted, JSON.stringify(strange))

    // Two controls, because each rules out a different way of passing by
    // accident, and this suite has already passed for the wrong reason once.
    //
    // Each one brings the origin back, mutates from a live page, and takes the
    // origin away again. Uniform on purpose: a control that relies on the
    // *previous* offline navigation having succeeded cannot run at all against
    // a build where it did not — which is exactly the build being ruled out.
    // Against the old worker this suite died here with "execution context was
    // destroyed" instead of printing a red line, and a crash only proves the
    // page broke, not which claim was wrong.
    //
    // Retried, because coming back from a failed navigation the page settles
    // asynchronously and the context can be torn down mid-call.
    const mutate = async (label, fn) => {
      for (let i = 0; i < 4; i++) {
        try {
          await serveDist()
          await page.goto(URL_, { waitUntil: 'load', timeout: 20_000 })
          await wait(700)
          await page.evaluate(fn)
          await killServer()
          return true
        } catch {
          await wait(400)
        }
      }
      await killServer()
      check(`the ${label} control could be set up`, false)
      return false
    }

    // Without Cache Storage: proves Cache Storage is what answered, rather than
    // some other store nobody was thinking about.
    if (await mutate('empty-cache', async () => {
      for (const k of await caches.keys()) await caches.delete(k)
    })) {
      const noCache = await openOffline('/')
      check('the control: with Cache Storage emptied, the same load fails',
        noCache.booted === false, JSON.stringify(noCache))
    }

    // Without the worker: proves the worker is what reached into it.
    if (await mutate('no-worker', async () => {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map((r) => r.unregister()))
      for (const k of await caches.keys()) await caches.delete(k)
    })) {
      const noWorker = await openOffline('/')
      check('the control: with the worker gone, the same load fails',
        noWorker.booted === false, JSON.stringify(noWorker))
    }
  }

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
} finally {
  await browser.close()
  await killServer()
}

console.log(failures.length ? `\n${failures.length} FAILED` : '\nall good')
process.exit(failures.length ? 1 : 0)
