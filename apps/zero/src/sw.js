/* Zero's shell is precached so the app opens with no signal — which is the
 * normal condition at a range, not an edge case.
 *
 * CACHE is rewritten at build time with a hash of the bundle. It used to be a
 * hand-bumped string, and a hand-bumped cache version is a deploy step someone
 * eventually forgets; the failure mode is returning users pinned to an old
 * build with no way to tell.
 *
 * The API is deliberately NOT cached. Stale sessions or a stale relay would be
 * worse than an error: the whole point of the relay is that it is current.
 */
const CACHE = '__CACHE_VERSION__';
/* FONT_FILES is spliced in by the build: the faces have to be precached or an
 * offline launch falls back to a system face, which is the exact difference
 * self-hosting them was meant to remove. */
const SHELL = ['./', './index.html', './bundle.js', './manifest.webmanifest',
               './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
               './icons/icon-maskable-512.png'].concat(__FONT_URLS__);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

/* Sweep MY OWN old caches, and only mine.
 *
 * CacheStorage is scoped to the ORIGIN, not to a worker's scope. Bench lives at
 * /bench/ on this same origin, so `caches.keys()` hands this worker Bench's
 * precache too -- and `k !== CACHE` is true of it, so the old sweep deleted it.
 * Bench's worker did the same to Zero's. Whichever app activated last was the
 * only one that still worked offline, and any deploy re-activated both, as did
 * simply opening the second app for the first time.
 *
 * Which means: two apps on one home screen, a drive to a range with no signal,
 * and the other icon opens Safari's "no internet connection" page inside a
 * standalone window -- with the data still on the device and no way to tell.
 * The exact failure both apps exist to prevent.
 *
 * Prefixing is enough because both names have always been `<app>-<hash>`. */
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
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;          // never touch Supabase
  /* Bench is served from /bench/ on the SAME origin, inside this worker's
   * scope, and registers a worker of its own. Bench's narrower scope wins once
   * it has registered -- but not before, and not on a device that has opened
   * Zero and never opened Bench. Until then the offline fallback at the bottom
   * of this handler would answer a request for Bench with ZERO'S page. Offline,
   * on a phone, that looks like Bench has been replaced by the wrong app.
   *
   * This guard moved here from Bench's worker when the two swapped places. It
   * belongs to whichever app sits at the root, because that is the one whose
   * scope covers the other. */
  /* `(\/|$)`, not `\/`: the trailing-slash-less `/bench` is redirected at the
   * edge when there is a network, and answered by THIS worker's offline
   * fallback when there is not -- with Zero's page, under Bench's URL. */
  if (/(^|\/)bench(\/|$)/.test(url.pathname)) return;
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req).then(res => {
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match('./index.html')))
  );
});
