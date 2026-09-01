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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'index.html');
const DIST = path.join(HERE, 'dist');

/* Refuse to publish an empty page rather than deploying a blank origin. The
 * number is deliberately far below the real page (~35 KB) -- it is a smoke
 * alarm for a truncated write or an accidental `> index.html`, not a size
 * assertion that has to be maintained. */
if (!fs.existsSync(SRC)) {
  /* Spelled out rather than left to statSync's ENOENT, because build:site calls
   * this and a stack trace here would be the last thing in the APP's deploy log. */
  console.error('site-info/build: site-info/index.html is missing — nothing to publish.');
  process.exit(1);
}
const bytes = fs.statSync(SRC).size;
if (bytes < 1024) {
  console.error(`site-info/build: refusing to publish ${bytes} bytes — `
    + 'site-info/index.html looks empty or truncated.');
  process.exit(1);
}

/* ── the document wrapper, and why this build adds it ─────────────────────
 *
 * The page has TWO hosts, and they disagree about who owns the document.
 *
 * As a Claude Artifact it is WRAPPED at publish time: the host supplies the
 * doctype, <html>, <head>, the charset and the viewport meta, and the source
 * is explicitly required NOT to carry its own — a second <html> or <head> in
 * the body is a parse error waiting to happen.
 *
 * Served as a plain file from a static host there is no wrapper at all, and
 * each missing line is a visible defect rather than a nicety:
 *
 *   <!doctype html>   without it the browser renders in QUIRKS MODE
 *   charset=utf-8     the copy is not ASCII; without a declared encoding the
 *                     page is at the mercy of the server's Content-Type
 *   viewport          without it a phone lays the page out at 980px and zooms
 *                     out — on a marketing page, the whole point, unreadable
 *
 * So the source cannot satisfy both, and the wrapper is not an editorial
 * decision the next person should have to remember: it is the difference
 * between the two hosts. This build supplies it, exactly once, and refuses
 * to double it if the source ever grows one of its own. The source stays
 * Artifact-shaped, which is also the shape it is easiest to preview in. */
const raw = fs.readFileSync(SRC, 'utf8');
const head = raw.slice(0, 4096).toLowerCase();
const has = (re) => re.test(head);

if (has(/<html[\s>]/) || has(/<body[\s>]/)) {
  console.error('site-info/build: the source carries its own <html>/<body>. '
    + 'It must stay Artifact-shaped — remove them, or teach this script to '
    + 'stop wrapping.');
  process.exit(1);
}

/* The source is head content (<title>, the font <link>, one <style>) followed
 * by body content, with no marker between them. `</style>` is that marker:
 * there is exactly one style block and everything after it is flow content.
 * Asserted rather than assumed, because a second <style> added later would
 * put the whole page inside <head> and render a blank white document. */
const styleEnd = raw.indexOf('</style>');
if (styleEnd < 0 || raw.indexOf('</style>', styleEnd + 1) >= 0) {
  console.error('site-info/build: expected exactly one </style> to mark the '
    + `head/body boundary, found ${raw.split('</style>').length - 1}. `
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
  '</body>',
  '</html>',
  '',
].filter(l => l !== null).join('\n');

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
fs.writeFileSync(path.join(DIST, 'index.html'), out);

console.log(`site-info/dist assembled — index.html, ${out.length} bytes `
  + `(${bytes} of source + document wrapper)`);
