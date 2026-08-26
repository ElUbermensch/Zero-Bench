/* Precache the whole shell. The app has no runtime network dependencies, so
 * cache-first is right: once installed it works with no signal, forever.
 *
 * CACHE is rewritten at build time with a hash of what was actually built. It
 * used to be a hand-bumped string, and a hand-bumped cache version is a deploy
 * step someone eventually forgets -- the failure mode being returning users
 * pinned to an old build with no way to tell. */
const CACHE = '__CACHE_VERSION__';
/* FONT_FILES is spliced in by the build: the faces have to be precached or an
 * offline launch falls back to a system face, which is the exact difference
 * self-hosting them was meant to remove. */
/* The maskable icon is precached too. Android reads it at install time, and an
 * install performed with no signal -- or an icon refresh after an eviction --
 * otherwise falls back to the non-maskable one and gets it cropped into a
 * circle, which is the exact outcome shipping a maskable icon prevents. */
const SHELL = ['./', './index.html', './manifest.webmanifest',
               './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
               './icons/icon-maskable-512.png'].concat(__FONT_URLS__);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

/* Sweep MY OWN old caches, and only mine.
 *
 * CacheStorage is scoped to the ORIGIN, not to this worker's /bench/ scope, so
 * `caches.keys()` returns Zero's precache as well -- and `k !== CACHE` is true
 * of it, so the old sweep deleted it. Zero's worker did the same to this one.
 * Whichever app activated last was the only one that opened at a range with no
 * signal; the other showed the browser's offline page inside a standalone
 * window, with all its data still sitting on the device.
 *
 * The scope guard in the fetch handler below does not help here: it is about
 * which requests this worker ANSWERS. Nothing scopes what it can delete. */
const MINE = CACHE.split('-')[0] + '-';
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(k => k.startsWith(MINE) && k !== CACHE)
        .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  /* Bench is served from /bench/, so this worker's scope is /bench/ and it is
   * not asked about anything above it. The guard that used to live here --
   * "leave the other app's directory alone" -- moved to Zero's worker when the
   * two swapped places, because it belongs to whichever app sits at the root.
   *
   * Nothing replaces it here. A scoped worker physically cannot answer for a
   * sibling directory, and a guard against something that cannot happen reads
   * as though it can. */
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
