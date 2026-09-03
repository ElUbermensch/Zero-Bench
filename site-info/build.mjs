#!/usr/bin/env node
/* Publish the information page.
 *
 *   site-info/dist/index.html      the whole site
 *
 * It is one self-contained HTML file with one Google Fonts <link> and no other
 * assets, so this is a copy, not a build. The copy exists anyway for two
 * reasons: a build command gives the deploy something to fail on when the page
 * is empty or missing, and an output DIRECTORY means the deploy publishes the
 * page and nothing else -- with the source folder served directly, DEPLOY.md
 * and this script would be fetchable on the marketing domain.
 *
 * ── why this is not emitted into site/ ────────────────────────────────────
 *
 * site/ is the Zero+Bench origin, and Zero's service worker is registered from
 * the root, so its scope is `/` and its fetch handler answers for EVERY
 * same-origin GET except the one path it excludes by hand (`/bench`). A page
 * dropped at site/info/ would therefore be:
 *
 *   - runtime-cached by Zero's worker on first view, then served cache-first
 *     from that cache forever. Zero's cache name is a hash of Zero's BUNDLE, so
 *     editing the marketing page does not invalidate it: every user who has
 *     opened Zero would be pinned to whatever copy of this page they saw first,
 *     until Zero itself ships new code. A page whose entire job is to be
 *     updated cannot live behind a cache that only an unrelated app can bust.
 *
 *   - answered with ZERO'S SHELL when offline, under this page's URL, by the
 *     `.catch(() => caches.match('./index.html'))` fallback at the bottom of
 *     that same handler.
 *
 * The fix on that origin is one line in apps/zero/src/sw.js -- widen the
 * `/bench` exclusion -- and until that line exists the page belongs on an
 * origin with no service worker on it. That is also where a marketing page
 * wants to be when it gets a domain: attaching one to the app's project would
 * make Zero answer at that hostname too, which is a second origin, a second
 * localStorage, and a second installable PWA.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../tools/config.mjs';


/* ── the traffic beacon ────────────────────────────────────────────────────
 *
 * Injected here rather than written into the source page, for the same reason
 * the doctype is: the source doubles as a Claude Artifact, where a Supabase key
 * has no business being. It also means the key comes from the ONE config file
 * every other build reads, instead of a second copy someone has to remember.
 *
 * What it sends is a pageview and nothing else: the path, the referring HOST,
 * any utm tags on the link that was clicked, and whether the screen is a phone.
 * No IP, no cookie, no fingerprint, no full referrer, and an id that lives in
 * sessionStorage and dies with the tab -- so five pages in one sitting are one
 * visit, and tomorrow's sitting cannot be tied to today's.
 *
 * It is deliberately incapable of breaking the page: it never throws, never
 * blocks paint, never retries, and a failed send is simply a lost row. A
 * marketing counter that can take the marketing site down is a bad trade.
 */
const beaconFor = (cfg) => `<script>
(function () {
  try {
    var URL_ = ${JSON.stringify(cfg.url || '')};
    var KEY = ${JSON.stringify(cfg.anonKey || '')};
    if (!URL_ || !KEY) return;
    // Never count the people building the thing.
    var h = location.hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '' || location.protocol === 'file:') return;
    // Honour the two signals a reader has to say no. Both are one line to
    // respect and the alternative is collecting data from someone who asked.
    if (navigator.doNotTrack === '1' || window.doNotTrack === '1'
        || navigator.globalPrivacyControl === true) return;

    var K = 'zs.visit';
    var id = null;
    try { id = sessionStorage.getItem(K); } catch (e) {}
    if (!id) {
      id = (crypto && crypto.randomUUID) ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0;
            return (c === 'x' ? r : ((r & 3) | 8)).toString(16);
          });
      try { sessionStorage.setItem(K, id); } catch (e) {}
    }

    var q = new URLSearchParams(location.search);
    var refHost = null;
    try {
      // The HOST only. A full referrer can carry the reader's search terms.
      if (document.referrer) {
        var r = new URL(document.referrer);
        if (r.hostname !== location.hostname) refHost = r.hostname.slice(0, 120);
      }
    } catch (e) {}

    var w = window.innerWidth || 1024;
    var body = {
      visit_id: id,
      path: location.pathname.slice(0, 200) || '/',
      referrer_host: refHost,
      utm_source: (q.get('utm_source') || '').slice(0, 60) || null,
      utm_medium: (q.get('utm_medium') || '').slice(0, 60) || null,
      utm_campaign: (q.get('utm_campaign') || '').slice(0, 80) || null,
      device: w < 768 ? 'mobile' : (w < 1024 ? 'tablet' : 'desktop')
    };

    fetch(URL_ + '/rest/v1/site_visit', {
      method: 'POST',
      headers: { apikey: KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(body),
      keepalive: true,
      mode: 'cors'
    }).catch(function () {});
  } catch (e) { /* a counter must never break the page it counts */ }
})();
</script>`;

const cfg = loadConfig();

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(HERE, 'dist');

/* The site is two pages: the overview at the root and the manual one level
 * down, so the manual's URL is /manual/ and the two can link to each other
 * with a plain relative href that works on any host. */
const PAGES = [
  { src: 'index.html',  out: 'index.html' },
  { src: 'manual.html', out: path.join('manual', 'index.html') },
];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

const built = [];
for (const page of PAGES) {
  const SRC = path.join(HERE, page.src);

  /* Refuse to publish an empty page rather than deploying a blank origin. The
   * number is deliberately far below the real pages -- it is a smoke alarm for
   * a truncated write or an accidental `> index.html`, not a size assertion
   * that has to be maintained. */
  if (!fs.existsSync(SRC)) {
    /* Spelled out rather than left to statSync's ENOENT, because build:site
     * calls this and a stack trace here would be the last thing in the APP's
     * deploy log. */
    console.error(`site-info/build: site-info/${page.src} is missing — nothing to publish.`);
    process.exit(1);
  }
  const bytes = fs.statSync(SRC).size;
  if (bytes < 1024) {
    console.error(`site-info/build: refusing to publish ${bytes} bytes — `
      + `site-info/${page.src} looks empty or truncated.`);
    process.exit(1);
  }

  /* ── the document wrapper, and why this build adds it ───────────────────
   *
   * Each page has TWO hosts, and they disagree about who owns the document.
   *
   * As a Claude Artifact a page is WRAPPED at publish time: the host supplies
   * the doctype, <html>, <head>, the charset and the viewport meta, and the
   * source is explicitly required NOT to carry its own — a second <html> or
   * <head> in the body is a parse error waiting to happen.
   *
   * Served as a plain file from a static host there is no wrapper at all, and
   * each missing line is a visible defect rather than a nicety:
   *
   *   <!doctype html>   without it the browser renders in QUIRKS MODE
   *   charset=utf-8     the copy is not ASCII; without a declared encoding the
   *                     page is at the mercy of the server's Content-Type
   *   viewport          without it a phone lays the page out at 980px and
   *                     zooms out — on a marketing page, the whole point
   *
   * So the source cannot satisfy both, and the wrapper is not an editorial
   * decision the next person should have to remember: it is the difference
   * between the two hosts. This build supplies it, exactly once, and refuses
   * to double it if a source ever grows one of its own. */
  const raw = fs.readFileSync(SRC, 'utf8');
  const all = raw.toLowerCase();
  const head = raw.slice(0, 1024).toLowerCase();
  const has = (re) => re.test(head);

  if (/<html[\s>]/.test(all) || /<body[\s>]/.test(all)) {
    console.error(`site-info/build: ${page.src} carries its own <html>/<body>. `
      + 'It must stay Artifact-shaped — remove them, or teach this script to '
      + 'stop wrapping.');
    process.exit(1);
  }

  /* Each source is head content (<title>, the font <link>, one <style>)
   * followed by body content, with no marker between them. `</style>` is that
   * marker: there is exactly one style block and everything after it is flow
   * content. Asserted rather than assumed, because a second <style> added
   * later would put the whole page inside <head> and render blank. */
  const styleEnd = raw.indexOf('</style>');
  if (styleEnd < 0 || raw.indexOf('</style>', styleEnd + 1) >= 0) {
    console.error(`site-info/build: expected exactly one </style> in ${page.src} to `
      + `mark the head/body boundary, found ${raw.split('</style>').length - 1}. `
      + 'Split the document explicitly rather than letting this guess.');
    process.exit(1);
  }
  const headSrc = raw.slice(0, styleEnd + '</style>'.length);
  const bodySrc = raw.slice(styleEnd + '</style>'.length);

  const out = [
    has(/<!doctype\s+html/) ? null : '<!doctype html>',
    '<html lang="en">',
    '<head>',
    has(/charset\s*=\s*["']?utf-8/) ? null : '<meta charset="utf-8">',
    has(/name\s*=\s*["']viewport["']/) ? null
      : '<meta name="viewport" content="width=device-width, initial-scale=1">',
    headSrc.trimStart(),
    '</head>',
    '<body>',
    bodySrc.trim(),
    beaconFor(cfg),
    '</body>',
    '</html>',
    '',
  ].filter(l => l !== null).join('\n');

  const dest = path.join(DIST, page.out);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, out);
  built.push(`${page.out} ${out.length}B`);
}

console.log(`site-info/dist assembled — ${built.join(', ')}`);
