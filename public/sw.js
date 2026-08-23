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

const CACHE = 'tank-arena-v1'

self.addEventListener('install', (e) => {
  // No precache list. The build hashes its filenames, so a list written here is
  // wrong the moment vite runs — the runtime handler below fills the cache with
  // whatever this build actually asked for.
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
  e.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone()
        void caches.open(CACHE).then((c) => c.put(req, copy))
        return res
      })
      .catch(() =>
        caches.match(req).then((hit) => hit ?? caches.match('/index.html').then((i) => i ?? Response.error())),
      ),
  )
})
