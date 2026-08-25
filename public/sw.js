// Just enough service worker to be installable, and no more.
//
// A game whose whole point is live relay traffic has nothing useful to serve
// from a cache while offline — there is no single-player mode to fall back to.
// So this does not try to be an offline game. What it does is make the shell
// (the HTML, the bundle, the stylesheet) available without a network round
// trip, which is the requirement for "add to home screen" and is also why the
// game opens instantly on a phone the second time.
//
// Network-first, cache-as-a-fallback. The other order is how a PWA ships a
// stale bundle to somebody for a week: a cache-first shell keeps serving the
// old JavaScript long after a deploy, and this project deploys several times a
// day. Fresh when the network answers, last-known-good when it does not.

const CACHE = 'tank-arena-v2'

/**
 * The one cache key every navigation is stored under.
 *
 * A navigation to `/?room=lobby` and one to `/?room=cornychat` are the same
 * document, and this game *rewrites the address bar* to `?room=...` the moment
 * you join — so the URL somebody adds to their home screen is almost never the
 * bare origin. Keyed by request URL, the cache would hold one entry per room
 * anybody had ever opened and still miss on the next invite link.
 */
const SHELL = './'

self.addEventListener('install', (e) => {
  // Precache the shell — one entry, no hashed filenames in it.
  //
  // "No precache list, the runtime handler will fill it" was the previous plan
  // and it does not survive contact with a first visit: the worker is not
  // controlling the page that installed it, so nothing on that visit goes
  // through the fetch handler and nothing lands in the cache. A player who
  // opens the game once, adds it to their home screen and gets on a plane had
  // an empty cache the whole time.
  e.waitUntil(caches.open(CACHE).then((c) => c.add(SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  // Only our own shell. Relay sockets are not fetches, but profile pictures are
  // — arbitrary URLs on arbitrary hosts, which is exactly what should not end
  // up in a cache this file is responsible for evicting.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return

  // A navigation is stored and retrieved under `SHELL`, never under its own
  // URL. The old code did the obvious thing — `cache.put(req)` then
  // `caches.match(req)` — and it could not work: the query string is part of a
  // cache key, so the only room URL that ever hit was the exact one you had
  // already opened, and the `/index.html` written as the last-resort fallback
  // was a URL nothing in this app ever requests. Both misses landed on
  // `Response.error()`.
  //
  // That it *looked* fine for so long is the interesting part, and the reason
  // is in the harness rather than in the browser: Chrome's offline emulation is
  // scoped to the target it is sent to, and a service worker is its own target.
  // With the page switched to offline the worker went on fetching from a server
  // that was still running, so every URL loaded and an unreachable fallback
  // looked like a working offline mode. Only killing the origin outright shows
  // the difference — see the note at the top of test/pwa.mjs.
  const navigation = req.mode === 'navigate'
  const key = navigation ? SHELL : req

  e.respondWith(
    fetch(req)
      .then((res) => {
        // Only store a real answer. Caching a 404 or a 502 under the shell key
        // is how a bad deploy becomes permanent for everybody who was unlucky.
        if (res.ok && res.type === 'basic') {
          const copy = res.clone()
          void caches.open(CACHE).then((c) => c.put(key, copy))
        }
        return res
      })
      .catch(() =>
        caches
          .match(key)
          .then((hit) => hit ?? (navigation ? undefined : caches.match(SHELL)))
          .then((hit) => hit ?? Response.error()),
      ),
  )
})
