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
const CACHE = 'zero-a0d4b96d929b';
/* FONT_FILES is spliced in by the build: the faces have to be precached or an
 * offline launch falls back to a system face, which is the exact difference
 * self-hosting them was meant to remove. */
const SHELL = ['./', './index.html', './bundle.js', './manifest.webmanifest',
               './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
               './icons/icon-maskable-512.png'].concat(["./fonts/dm-sans-latin-400-normal.woff2","./fonts/dm-sans-latin-500-normal.woff2","./fonts/dm-sans-latin-700-normal.woff2","./fonts/space-mono-latin-400-normal.woff2","./fonts/space-mono-latin-700-normal.woff2"]);

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
 * Expressed as "not the OTHER app's", not as "starts with mine". The
 * difference matters: Bench once shipped a cache called `reloading-v1`, and a
 * mine-only sweep can never reclaim a name like that -- while `caches.match()`,
 * which both fetch handlers use, is the CacheStorage-level API and scans caches
 * in CREATION order. So the orphan is not merely leaked, it WINS: an old shell
 * shadows the current one forever, and since index.html is cache-first and the
 * registration's ?v= is read out of it, nothing can dislodge it. Sweeping
 * everything except the known sibling keeps old names reclaimable. */
const SIBLINGS = ['zero-', 'bench-'];
const MINE = CACHE.split('-')[0] + '-';
const theirs = (k) => SIBLINGS.some(s => s !== MINE && k.startsWith(s));
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys
        .filter(k => k !== CACHE && !theirs(k))
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
