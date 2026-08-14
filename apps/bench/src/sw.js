/* Precache the whole shell. The app has no runtime network dependencies, so
 * cache-first is right: once installed it works with no signal, forever.
 *
 * CACHE is rewritten at build time with a hash of what was actually built. It
 * used to be a hand-bumped string, and a hand-bumped cache version is a deploy
 * step someone eventually forgets -- the failure mode being returning users
 * pinned to an old build with no way to tell. */
const CACHE = '__CACHE_VERSION__';
const SHELL = ['./', './index.html', './manifest.webmanifest',
               './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
      // Only cache real, complete same-origin responses.
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
