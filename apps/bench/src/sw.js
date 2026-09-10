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
 * which requests this worker ANSWERS. Nothing scopes what it can delete.
 *
 * Expressed as "not the OTHER app's", not as "starts with mine". This app once
 * shipped a cache called `reloading-v1`, and a mine-only sweep could never
 * reclaim it -- while `caches.match()` below is the CacheStorage-level API and
 * scans in CREATION order, so that orphan would not merely leak, it would WIN:
 * the old shell shadowing the current one, permanently, on a cache-first
 * index.html nothing can dislodge. */
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

/* This worker's own directory, taken from where it was served rather than
 * hardcoded, so moving the app moves the guard with it. */
const HERE = new URL('./', self.location).pathname;

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  /* Leave everything outside /bench/ to the network.
   *
   * This guard was removed once, on the reasoning that "a scoped worker
   * physically cannot answer for a sibling directory". That is wrong, and it
   * is wrong in the way that matters: **scope decides which CLIENTS a worker
   * controls, not which request URLs it is asked about.** Once /bench/index.html
   * is a controlled client, EVERY fetch that document makes arrives here --
   * including one for /index.html, which is Zero's.
   *
   * On its own that would be harmless, because the cache lookup below misses
   * and the request goes to the network. What makes it a bug is the `.catch`
   * at the end: offline, `fetch(req)` REJECTS, and the fallback hands back
   * Bench's own shell. A phone with no signal that asks for Zero is shown
   * Bench -- indistinguishable, on a home-screen icon, from Zero having been
   * replaced by the wrong app.
   *
   * Zero's worker has carried the mirror image of this guard all along
   * (`/(^|\/)(bench|admin)(\/|$)/`). Only this side lost it.
   *
   * Why it hid: with the network merely emulated-offline, Chromium on some
   * platforms still reaches loopback, so the test harness answered 404 -- a
   * resolved response, not a rejection, so the `.catch` never ran and the
   * assertion passed. It reproduces deterministically by ABORTING the request
   * instead, which is what the suite does now. */
  if (!url.pathname.startsWith(HERE)) return;
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
