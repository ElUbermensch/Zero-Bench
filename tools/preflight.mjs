#!/usr/bin/env node
/* Everything that can be checked without a network, checked before you push.
 *
 *   node tools/preflight.mjs
 *
 * This deliberately does NOT run the test suites — `npm test` does that, takes
 * minutes, and you want this answer in a second. It checks the things that are
 * easy to get wrong and silent when wrong: an unfilled backend, a secret key
 * about to be committed, a missing icon, a workflow that no longer matches the
 * scripts it calls.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadConfig, CONFIG_PATH } from './config.mjs';
/* Data, not behaviour: importing the mock starts no server, and zero-core is
 * required only for its TABLES list -- the tables the client actually syncs,
 * which is the set the mock has to be honest about. */
import { SCHEMA } from '../packages/zero-core/mock-supabase.mjs';
const SYNCED = createRequire(import.meta.url)('../packages/zero-core/zero-core.js').TABLES;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => path.relative(ROOT, p) || p;

let fail = 0, warn = 0;
const ok = (c, l, hint) => {
  if (c) console.log('  \x1b[32m✓\x1b[0m ' + l);
  else { fail++; console.log('  \x1b[31m✗\x1b[0m ' + l + (hint ? `\n      → ${hint}` : '')); }
};
const soft = (c, l, hint) => {
  if (c) console.log('  \x1b[32m✓\x1b[0m ' + l);
  else { warn++; console.log('  \x1b[33m!\x1b[0m ' + l + (hint ? `\n      → ${hint}` : '')); }
};
const has = (p) => fs.existsSync(path.join(ROOT, p));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const section = (s) => console.log('\n' + s);

console.log('\nPreflight');

/* ─────────────────────────────────────────────────────────────── backend */
section('backend configuration');
const cfg = loadConfig();
/* A fork has no backend and never will, so THIS assertion is skippable -- and
 * it is the only reason CI used to run the whole of preflight as
 * `|| true`, throwing away every structural check with it. One env var buys
 * back the other twenty-odd. */
if (process.env.PREFLIGHT_SKIP_CONFIG === '1') {
  console.log(`      (backend config not checked — PREFLIGHT_SKIP_CONFIG=1)`);
} else {
  ok(cfg.ok, `${rel(CONFIG_PATH)} is filled in`,
     `${cfg.reason}. Both apps read this one file; without it they ask each user to type a server address.`);
  if (cfg.url) console.log(`      ${cfg.url}`);
}

/* The one thing that must never be committed. */
section('secrets');
const allText = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (/node_modules|\.git$|dist$|shots$/.test(e.name)) continue;
    if (e.isDirectory()) walk(p);
    else if (/\.(js|mjs|jsx|json|md|yml|html|sql|sh)$/.test(e.name)) {
      allText.push([p, read(p)]);
    }
  }
};
walk('.');
const secretHits = allText.filter(([p, t]) =>
  /sb_secret_[A-Za-z0-9_-]{10,}/.test(t) ||
  /"service_role"\s*:\s*"ey/.test(t) ||
  /\bSUPABASE_SERVICE_ROLE_KEY\s*=\s*ey/.test(t));
ok(secretHits.length === 0, 'no service_role / secret key anywhere in the repo',
   `found in: ${secretHits.map(([p]) => p).join(', ')}. That key bypasses RLS entirely and must never ship in a PWA.`);

const jwtLike = allText.filter(([p, t]) => p !== 'supabase.config.json' && /eyJ[A-Za-z0-9_-]{30,}\.eyJ/.test(t));
soft(jwtLike.length === 0, 'no stray JWTs outside the config file',
   `found in: ${jwtLike.map(([p]) => p).join(', ')}`);

/* ────────────────────────────────────────────────────────────── migrations */
section('migrations');
const migs = fs.readdirSync(path.join(ROOT, 'supabase/migrations')).filter(f => f.endsWith('.sql')).sort();
ok(migs.length >= 4, `${migs.length} migrations present, applied in name order`);
console.log('      ' + migs.join('\n      '));
ok(!migs.some(m => /harness/.test(m)), 'the test harness is not among them',
   'harness.sql stubs the auth schema and must never be run against a real project');

/* And the fixtures say it themselves, because the documented deploy procedure
 * is "open the file on GitHub, click Raw, copy, paste into the SQL Editor" --
 * and supabase/test/ sits right next to supabase/migrations/ in that listing.
 * The SQL Editor runs as `postgres`, which bypasses RLS entirely, so a
 * mis-paste is not a failed query: one of these files contains an unqualified
 * `delete from public.account_backups;` and harness.sql replaces auth.uid()
 * with a stub that breaks every policy at once. A warning in a markdown file
 * nobody has open does not survive one paste. */
const fixtures = fs.readdirSync(path.join(ROOT, 'supabase/test')).filter(f => f.endsWith('.sql'));
const unguarded = fixtures.filter(f => !read(`supabase/test/${f}`).includes('REFUSED:'));
ok(unguarded.length === 0,
   `all ${fixtures.length} SQL fixtures refuse to run against anything but the scratch database`,
   `unguarded: ${unguarded.join(', ')}`);

/* ──────────────────────────────────────────────────────────────── the apps */
section('apps');
/* The one background the whole product is painted in. Both apps' palettes were
 * merged to it; the manifest colours and the theme-color meta were the two
 * places that kept the old value, and they are precisely the two iOS reads to
 * paint the splash screen and the status bar. */
const PRODUCT_BG = '#0f1117';

for (const [app, files] of [
  ['apps/zero', ['src/shell.html', 'src/sw.js', 'src/manifest.webmanifest',
                 'src/icons/icon-192.png', 'src/icons/icon-512.png', 'src/icons/icon-maskable-512.png']],
  ['apps/bench', ['src/shell.html', 'src/sw.js', 'src/manifest.webmanifest',
                  'src/icons/icon-192.png', 'src/icons/icon-512.png', 'src/icons/icon-maskable-512.png']],
]) {
  for (const f of files) ok(has(`${app}/${f}`), `${app}/${f}`, 'an installable PWA needs this');
  const m = JSON.parse(read(`${app}/src/manifest.webmanifest`));
  ok(m.icons.some(i => i.purpose === 'maskable'), `${app} declares a maskable icon`,
     'without one, Android crops the icon into a circle and clips it');
  ok(m.start_url === './' && m.scope === './', `${app} uses relative start_url and scope`,
     'absolute paths break when the app is served from a subdirectory (Bench is, at /bench/)');
  ok(/__CACHE_VERSION__/.test(read(`${app}/src/sw.js`)),
     `${app} service worker takes its cache name from the build`,
     'a hand-bumped cache version is a deploy step someone forgets');

  /* The precache sweep must be scoped. CacheStorage is per ORIGIN, and these
   * two apps share one -- an unscoped `k !== CACHE` deletes the other app's
   * precache, so whichever activated last is the only one that opens at a
   * range with no signal. */
  const sw = read(`${app}/src/sw.js`);
  ok(/SIBLINGS/.test(sw) && /caches\.delete/.test(sw),
     `${app} sweeps only its own caches`,
     'CacheStorage is per origin: an unscoped sweep deletes the other app\'s offline copy');

  /* The maskable icon has to be precached too, or a first install with no
   * signal falls back to the icon Android crops into a circle. */
  ok(/icon-maskable-512\.png/.test(sw), `${app} precaches its maskable icon`,
     'an install performed offline otherwise gets the croppable one');

  /* One product, one launch screen. The manifest colours and the theme-color
   * meta are what iOS paints the splash and the status bar from, and they were
   * left behind when the palettes were merged -- so Bench flashed one grey and
   * settled to another on every cold launch, beside a Zero that did not. */
  const shell = read(`${app}/src/shell.html`);
  const themeMeta = (/<meta name="theme-color" content="([^"]+)"/.exec(shell) || [])[1];
  ok(m.theme_color === PRODUCT_BG && m.background_color === PRODUCT_BG
     && (themeMeta || '').toLowerCase() === PRODUCT_BG,
     `${app} paints its launch screen and status bar the app's own colour`,
     `manifest ${m.theme_color}/${m.background_color}, meta ${themeMeta}, expected ${PRODUCT_BG}`);
}

/* The dashboard is checked separately, and shorter, because it is installable
 * without being offline-capable. Every service-worker assertion above is
 * deliberately inapplicable: it ships no worker, since a cached shell over a
 * page whose every number is a query could only ever show stale figures. What
 * it does need is an identity -- a manifest and icons -- or saving it to a home
 * screen gets you a screenshot of the page instead of an icon, which is what
 * it did on the first deploy. */
for (const f of ['src/shell.html', 'src/manifest.webmanifest', 'src/icons/icon.svg',
                 'src/icons/icon-192.png', 'src/icons/icon-512.png',
                 'src/icons/icon-maskable-512.png']) {
  ok(has(`apps/admin/${f}`), `apps/admin/${f}`, 'the dashboard needs this to install cleanly');
}
{
  const m = JSON.parse(read('apps/admin/src/manifest.webmanifest'));
  const shell = read('apps/admin/src/shell.html');
  ok(m.icons.some(i => i.purpose === 'maskable'), 'apps/admin declares a maskable icon',
     'without one, Android crops the icon into a circle and clips it');
  ok(m.start_url === './' && m.scope === './', 'apps/admin uses relative start_url and scope',
     'the dashboard is served from /admin/, so an absolute path would leave its scope');
  ok(m.theme_color === PRODUCT_BG && m.background_color === PRODUCT_BG,
     'apps/admin paints its launch screen the app\'s own colour',
     `manifest ${m.theme_color}/${m.background_color}, expected ${PRODUCT_BG}`);
  ok(/rel="manifest"/.test(shell) && /rel="apple-touch-icon"/.test(shell),
     'apps/admin links its manifest and an apple-touch-icon',
     'iOS reads the link tag, not the manifest, when saving to a home screen');
  /* The one thing it must NOT have. Zero's worker declines /admin/ precisely
   * because nothing here would ever take that scope back. */
  ok(!has('apps/admin/src/sw.js'), 'apps/admin ships no service worker',
     'the dashboard is a page you open; a cached one would report yesterday');
}

/* ──────────────────────────────────────────── the embedded core, and CI */
section('consistency');
const embedded = read('apps/zero/Zero.jsx');
ok(embedded.includes('//#region zero-core'), 'Zero embeds zero-core in a generated region');
ok(/__SUPABASE_CONFIG__/.test(embedded), 'Zero takes its backend from the build, not a hand-edited constant');

/* Read from the FILESYSTEM, not from a list written here.
 *
 * This used to hard-code rls_test..rls_test6 and print six ticks -- against a
 * workflow that hard-coded the same six, and a run_tests.sh that ran eight. So
 * the check meant to catch "a suite CI does not run" shared the blind spot
 * exactly, and the two newest suites (account backups, the shot string) went
 * unrun on every pull request for as long as they had existed. */
const wf = read('.github/workflows/test.yml');
const suites = fs.readdirSync(path.join(ROOT, 'supabase/test'))
  .filter(f => /^rls_test\d*\.sql$/.test(f)).sort();
const runner = read('supabase/run_tests.sh');
ok(suites.length > 0, `${suites.length} RLS suites on disk`);
/* A glob in the workflow covers every current and future suite, which is why
 * it is accepted in place of naming them. */
const wfGlobs = /rls_test\*\.sql/.test(wf);
ok(wfGlobs || suites.every(t => wf.includes(t)),
   'CI runs every RLS suite on disk',
   `missing from the workflow: ${suites.filter(t => !wf.includes(t)).join(', ')}. `
   + 'A suite that CI does not run is a suite that rots.');
ok(/rls_test\*\.sql/.test(runner) || suites.every(t => runner.includes(t)),
   'and so does run_tests.sh',
   `missing from the runner: ${suites.filter(t => !runner.includes(t)).join(', ')}`);
const deploy = read('.github/workflows/deploy.yml');
const site = read('tools/build-site.mjs');
ok(deploy.includes('build:site'),
   'the Pages workflow assembles the site through the shared script',
   'inlining the copy here means Pages and Vercel can drift apart silently');
ok(site.includes('apps/bench/dist') && site.includes('apps/zero/dist'),
   'that script publishes both apps');
/* Vercel validates vercel.json against a schema that forbids unknown
 * properties, and it does so at DEPLOY time -- the file is fine locally, the
 * build never starts, and the error names a JSON path rather than a cause.
 *
 * This caught us with `"//"` keys used as comments inside `headers` entries.
 * JSON has no comments; that convention is tolerated by some tools and not
 * by this one. The reasoning those keys carried now lives in DEPLOY.md,
 * where a human deploying will actually read it.
 *
 * Checked structurally rather than by grepping for "//", so a stray key of
 * any name is caught. Written as a function because there are two of these
 * files now -- the app origin's, and the information page's. */
const HEADER_KEYS = new Set(['source', 'headers', 'has', 'missing']);
const strayHeaderKeys = (v) => (v.headers || []).flatMap((h, i) =>
  Object.keys(h).filter(k => !HEADER_KEYS.has(k)).map(k => `headers[${i}].${k}`));

/* And a BOM is the other way this file fails before a build starts. It is
 * invisible in an editor, it survives a copy-paste out of a document, and
 * `JSON.parse` throws on it -- which would take this check out with a stack
 * trace instead of a line, so it is asserted BEFORE the parse. */
const noBom = (p) => !read(p).startsWith('\uFEFF');

if (has('vercel.json')) {
  ok(noBom('vercel.json'), 'vercel.json has no byte-order mark',
     'Vercel cannot parse it and the deploy fails before the build starts');
  const v = JSON.parse(read('vercel.json'));
  ok(v.buildCommand === 'npm run build:site' && v.outputDirectory === 'site',
     'vercel.json builds and publishes the same thing',
     'Vercel and Pages must serve identical output or a bug reproduces on only one');
  ok(JSON.stringify(v.headers || []).includes('must-revalidate'),
     'vercel.json stops service workers being served stale',
     'a cached sw.js can pin a returning user to an old build indefinitely');
  const strays = strayHeaderKeys(v);
  ok(strays.length === 0,
     `vercel.json carries no properties the schema will reject${strays.length ? ' — ' + strays.join(', ') : ''}`,
     'Vercel validates this at deploy time, so a stray key fails the build rather than the checkout');
}

/* ──────────────────────────────────────────────── the information page */
section('the information page');

/* It is deployed by a Vercel project of its own, from site-info/, and NOT into
 * site/. Zero's worker is registered from the root, so its scope is `/` and its
 * fetch handler answers for every same-origin GET except `/bench`: a marketing
 * page under site/ would be runtime-cached into a cache that only a Zero code
 * deploy can bust, and answered with Zero's shell offline. So the thing to
 * check is not "did it reach site/" -- it is that the one assembly path still
 * produces it, and that what it produced is the page and not a stub. */
ok(site.includes('site-info/build.mjs'),
   'build:site builds the information page too',
   'one command has to produce everything, or the page silently stops being built');
ok(has('site-info/index.html') && has('site-info/build.mjs'),
   'the information page and its build are in the repo');

if (has('site-info/vercel.json')) {
  ok(noBom('site-info/vercel.json'), 'site-info/vercel.json has no byte-order mark',
     'Vercel cannot parse it and the deploy fails before the build starts');
  const iv = JSON.parse(read('site-info/vercel.json'));
  ok(iv.buildCommand === 'npm run build' && iv.outputDirectory === 'dist',
     'site-info/vercel.json builds and publishes the same thing site-info/build.mjs writes',
     'the info project reads THIS file, not the one at the repo root');
  ok(JSON.stringify(iv.headers || []).includes('must-revalidate'),
     'the page is served revalidating, not immutable',
     'a marketing page changes far more often than an app bundle');
  const istrays = strayHeaderKeys(iv);
  ok(istrays.length === 0,
     `site-info/vercel.json carries no properties the schema will reject${istrays.length ? ' — ' + istrays.join(', ') : ''}`,
     'Vercel validates this at deploy time, so a stray key fails the build rather than the checkout');
} else {
  ok(false, 'site-info/vercel.json exists',
     'without it the info project depends on dashboard settings nobody can review in a diff');
}

/* The page has two hosts that disagree about who owns the document. As a Claude
 * Artifact it is WRAPPED at publish time -- the host supplies the doctype,
 * <html>, <head>, charset and viewport, and the source must NOT carry its own.
 * Served as a plain file from Vercel none of that exists, and the viewport line
 * is the one that shows: a phone lays the page out at 980px and zooms out,
 * which on a marketing page is the whole page.
 *
 * So the contract is split, and both halves are checked: the SOURCE stays
 * Artifact-shaped, and the BUILD supplies the wrapper. Getting this backwards
 * in either direction is a silent, visible-only-on-a-phone defect. */
const infoSrc = read('site-info/index.html');
const infoTop = infoSrc.slice(0, 4096).toLowerCase();
ok(!/<html[\s>]/.test(infoTop) && !/<body[\s>]/.test(infoTop),
   'the source page stays Artifact-shaped — no <html>, no <body>',
   'an Artifact is wrapped by its host; a second <html> in the body is a parse error');
ok(/<\/style>/.test(infoSrc) && infoSrc.split('</style>').length === 2,
   'the source has exactly one </style>, which is where the build splits head from body',
   'a second style block would put the whole page inside <head> and render blank');

/* The emitted page, when there is one. site-info/dist/ is build output and
 * gitignored, so a preflight run before a build has nothing to look at -- and
 * preflight has never required a build to be useful. */
if (has('site-info/dist')) {
  const there = has('site-info/dist/index.html');
  const emitted = there ? read('site-info/dist/index.html') : '';
  const bytes = there ? fs.statSync(path.join(ROOT, 'site-info/dist/index.html')).size : 0;
  ok(bytes > 1024 && /<\/style>/.test(emitted),
     `site-info/dist/index.html carries the page — ${bytes} bytes`,
     'the publish directory exists but the page in it is missing, empty or truncated');
  /* doctype, charset and viewport have to be near the TOP to do their job --
   * a charset declared past the first kilobyte is one the parser has already
   * guessed around. <html> and <body> only have to exist, and <body> sits
   * after a stylesheet several kilobytes long, so it is looked for in the
   * whole document rather than in the opening slice. */
  const emittedTop = emitted.slice(0, 1024).toLowerCase();
  const emittedAll = emitted.toLowerCase();
  const wrapMissing = [
    [/^\s*<!doctype\s+html/, 'doctype', emittedTop],
    [/charset\s*=\s*["']?utf-8/, 'charset', emittedTop],
    [/name\s*=\s*["']viewport["']/, 'viewport', emittedTop],
    [/<html[\s>]/, '<html>', emittedAll],
    [/<body[\s>]/, '<body>', emittedAll],
  ].filter(([re, , hay]) => !re.test(hay)).map(([, n]) => n);
  ok(wrapMissing.length === 0,
     `and the build wrapped it as a real document${wrapMissing.length ? ' — missing: ' + wrapMissing.join(', ') : ''}`,
     'without a viewport meta a phone renders it at 980px and zooms out; without a doctype, in quirks mode');
  /* The wrapper is the only thing the build may add. Everything after the
   * source's </style> must survive verbatim, or something rewrote the copy. */
  const srcBody = read('site-info/index.html').split('</style>')[1].trim();
  ok(emitted.includes(srcBody),
     'and the page body reached the publish directory verbatim',
     'the build supplies a document wrapper and nothing else — any other edit is a bug');
} else {
  console.log('      (site-info/dist not built — run npm run build:site to check the emitted page)');
}

/* ──────────────────────────────────────────── the two bars must agree */
section('the two apps look like one product');
/* Bench reserved var(--safe-b) below its tab icons and Zero reserved nothing,
 * which sat Bench's row a third of an inch higher than Zero's. Nothing caught
 * it: each app's own suite only ever sees its own bar, and a headless viewport
 * has no insets to reserve in the first place.
 *
 * Whether to sit above the home indicator is a decision the two apps have to
 * make the SAME way. This does not care which way -- only that they agree. */
if (has('apps/bench/src/shell.html') && has('apps/zero/Zero.jsx')) {
  const bench = read('apps/bench/src/shell.html');
  const zero = read('apps/zero/Zero.jsx');
  const reserves = (css, sel) => {
    const rule = (css.match(new RegExp(sel + '\\{[^}]*\\}')) || [''])[0];
    return /padding-bottom\s*:\s*[^;}]*safe-area-inset-bottom|padding-bottom\s*:\s*[^;}]*--safe-b/.test(rule);
  };
  const b = reserves(bench, 'nav\\.tabs');
  const z = reserves(zero, '\\.tabbar');
  ok(b === z,
     `both tab bars treat the home indicator the same way (bench ${b ? 'reserves' : 'does not'}, zero ${z ? 'reserves' : 'does not'})`,
     'one bar sitting higher than the other is the kind of thing users read as unfinished');

  /* The greys have to match value for value. They drifted once already --
   * Bench's background was #16181c against Zero's #0f1117, with every surface
   * and border slightly off -- and side by side that reads as two products
   * rather than one. The ACCENT is deliberately excluded: brass in Bench,
   * orange in Zero, is what tells you which app you are in. */
  const varOf = (css, name) => {
    const m = css.match(new RegExp('--' + name + '\\s*:\\s*([^;}]+)'));
    return m ? m[1].trim().toLowerCase() : null;
  };
  const PAIRS = [['bg', 'bg'], ['panel', 'surf'], ['panel2', 'surf2'],
                 ['line', 'bdr'], ['ink', 'ink'], ['ink2', 'dim']];
  const off = PAIRS.filter(([bn, zn]) => varOf(bench, bn) !== varOf(zero, zn))
    .map(([bn, zn]) => `--${bn} ${varOf(bench, bn)} vs --${zn} ${varOf(zero, zn)}`);
  ok(off.length === 0,
     'the two palettes agree, value for value'
     + (off.length ? ' — ' + off.join('; ') : ''));

  /* A webfont pulled from a third-party host is a network dependency, and both
   * of these apps are built to work at a range with no signal. Zero has one:
   * an @import from Google Fonts. Proving it matters cost nothing -- adding the
   * same import to Bench hung Bench's own suite, because a blocking @import to
   * an unreachable host stalls rendering until it times out, which is precisely
   * what a phone with no reception does.
   *
   * This does not fail the build; the import predates the second app and
   * removing it changes a look people already know. It reports, so the cost
   * stays visible until the fonts are self-hosted and precached. */
  /* Comments are stripped first. The prose explaining WHY a network font is a
   * problem mentions fonts.googleapis.com, and matching that would have this
   * check report the very file that documents the decision not to do it. */
  const decomment = (css) => css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const remoteFonts = [['Zero', zero], ['Bench', bench]]
    .filter(([, css]) => /@import\s+url\(\s*['"]?https?:|<link[^>]+(googleapis|gstatic)/
      .test(decomment(css)))
    .map(([n]) => n);
  soft(remoteFonts.length === 0,
     remoteFonts.length
       ? `${remoteFonts.join(' and ')} load${remoteFonts.length === 1 ? 's' : ''} a webfont over the network`
       : 'neither app depends on a network font to render',
     'a blocking @import to an unreachable host stalls rendering, so the app looks '
     + 'different at a range than it does at home. Self-host the woff2 and precache it.');

  /* Sign-in has to be on the first screen in BOTH apps.
   *
   * Zero always put its sync panel on the home list. Bench put the same block
   * behind More > Cloud sync, two taps deep, and the result was a user asking
   * where the sync button was -- reasonably, because there was no way to learn
   * the feature existed without opening a menu that promises "more" of what
   * you already have. One account serves both apps, so whichever app the user
   * opens first has to be able to establish it.
   *
   * Source-level, and deliberately shallow: it checks that the home view
   * renders the block, not what the block looks like. The rendered behaviour
   * -- fields visible with nothing tapped, sign-in actually moving records --
   * is apps/bench/test-sync-ui.mjs, which needs a backend to exist at all. */
  const app = has('apps/bench/src/app.js') ? read('apps/bench/src/app.js') : '';
  const benchHome = /VIEWS\.lookup[\s\S]{0,4000}?syncCard\(/.test(app);
  /* Anchored on the CONDITION rather than on a character distance from
   * <SessionsList>. The distance version broke the moment an unrelated banner
   * was added between the two -- a false blocker on a screen that was fine,
   * which is how a checklist trains people to ignore it. What actually matters
   * is that the signed-out home screen renders the panel. */
  const zeroHome = /!core\.isSignedIn\(\)\s*&&\s*\(\s*<SyncPanel/.test(zero);
  ok(benchHome && zeroHome,
     'both apps offer sign-in on their first screen'
     + (benchHome && zeroHome ? '' : ` (bench ${benchHome ? 'does' : 'does NOT'}, zero ${zeroHome ? 'does' : 'does NOT'})`),
     'a sync feature nobody can find is a sync feature nobody uses');
}

/* ─────────────────────────────────────────────── safe areas on notched phones */
section('safe areas');
/* `viewport-fit=cover` is an opt-in: it says "let my page under the status bar
 * and the home indicator, I will handle the insets". Setting it and then not
 * paying an inset back is strictly worse than never setting it -- the content
 * simply sits under the hardware. Bench shipped with only the BOTTOM inset
 * compensated, so on every notched phone the header rode up under the clock.
 *
 * Checked in source rather than in a browser: Playwright cannot synthesise a
 * device notch, so a rendered test would pass on a machine with no insets and
 * catch nothing on the one device that matters. */
for (const [name, file] of [['Zero', 'apps/zero/src/shell.html'],
                            ['Bench', 'apps/bench/src/shell.html']]) {
  if (!has(file)) continue;
  const shell = read(file);
  const covers = /viewport-fit\s*=\s*cover/.test(shell);
  if (!covers) { ok(true, `${name} does not opt into the display cutout`); continue; }
  // Zero's stylesheet lives in Zero.jsx; Bench's is in its shell.
  const css = shell + (name === 'Zero' && has('apps/zero/Zero.jsx') ? read('apps/zero/Zero.jsx') : '');
  ok(/safe-area-inset-top/.test(css),
     `${name} pays back the TOP inset it opted into`,
     'viewport-fit=cover without safe-area-inset-top puts the header under the status bar');
  ok(/safe-area-inset-bottom/.test(css),
     `${name} pays back the bottom inset`,
     'the home indicator overlaps whatever sits at the bottom of the screen');
}

/* ────────────────────── the mock must not be softer than the server */
/* packages/zero-core/mock-supabase.mjs is the oracle every JS suite is graded
 * against. When it is more permissive than Postgres, a green suite means
 * nothing: the row the client just "successfully" pushed is a permanent 4xx on
 * the real server, and a permanent 4xx makes the client DEAD-LETTER the row --
 * out of the outbox, for good. A client can only be as disciplined as the
 * thing that judges it.
 *
 * So: every NOT NULL column in the migrations that has no default must appear
 * in the mock's NOT_NULL map. Read out of the SQL TEXT rather than out of a
 * live database, because preflight has to answer in a second with no network
 * and no Postgres -- the same reason it reads the workflow file instead of
 * running CI. `bash supabase/run_tests.sh` remains the authority; this is the
 * tripwire that fires on the pull request that introduces the drift. */
section('the mock agrees with the schema');

const notNullFromMigrations = () => {
  const dir = path.join(ROOT, 'supabase/migrations');
  const sql = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()
    .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n')
    .replace(/--[^\n]*/g, ' ');            // strip line comments, keep structure

  const cols = new Map();                  // "table.col" -> { table, col, notNull, dflt }
  const put = (t, c, patch) => {
    const k = `${t}.${c}`;
    cols.set(k, Object.assign({ table: t, col: c, notNull: false, dflt: false },
                              cols.get(k), patch));
  };

  /* CREATE TABLE bodies. Split on top-level commas only -- `numeric(6,2)` and
   * `check (x = any (array[…]))` both contain commas that are not column
   * boundaries, and a naive split invents a column called "2)". */
  const CT = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_]+)\s*\(/gi;
  let m;
  while ((m = CT.exec(sql))) {
    const t = m[1];
    let depth = 1, i = CT.lastIndex, start = i;
    const parts = [];
    for (; i < sql.length && depth > 0; i++) {
      const ch = sql[i];
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) parts.push(sql.slice(start, i)); }
      else if (ch === ',' && depth === 1) { parts.push(sql.slice(start, i)); start = i + 1; }
    }
    const pk = [];
    for (const raw of parts) {
      const d = raw.trim();
      /* A table constraint, not a column -- but `primary key (a, b)` still
       * makes its columns NOT NULL, so it is read rather than skipped. */
      if (/^(primary\s+key|unique|check|foreign\s+key|constraint|exclude|like)\b/i.test(d)) {
        const tpk = /^primary\s+key\s*\(([^)]*)\)/i.exec(d);
        if (tpk) pk.push(...tpk[1].split(',').map(x => x.trim()));
        continue;
      }
      const name = (/^([a-z_][a-z0-9_]*)/i.exec(d) || [])[1];
      if (!name) continue;
      /* PRIMARY KEY implies NOT NULL without saying the words, and that is
       * exactly how profiles.id and leaderboard_profiles.id are declared --
       * the two columns a plain search for "not null" silently misses. */
      put(t, name, { notNull: /\bnot\s+null\b/i.test(d) || /\bprimary\s+key\b/i.test(d),
                     dflt: /\bdefault\b/i.test(d) });
    }
    for (const c of pk) put(t, c, { notNull: true });
  }

  /* ALTER TABLE, so a column added or relaxed in a later migration wins over
   * the CREATE that introduced it. */
  const AT = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?([a-z_]+)([\s\S]*?);/gi;
  while ((m = AT.exec(sql))) {
    const t = m[1];
    for (const a of m[2].split(/,(?=\s*(?:add|alter|drop)\s)/i)) {
      let x;
      if ((x = /^\s*add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)([\s\S]*)$/i.exec(a)))
        put(t, x[1], { notNull: /\bnot\s+null\b/i.test(x[2]), dflt: /\bdefault\b/i.test(x[2]) });
      else if ((x = /^\s*alter\s+(?:column\s+)?([a-z_][a-z0-9_]*)\s+set\s+not\s+null/i.exec(a)))
        put(t, x[1], { notNull: true });
      else if ((x = /^\s*alter\s+(?:column\s+)?([a-z_][a-z0-9_]*)\s+drop\s+not\s+null/i.exec(a)))
        put(t, x[1], { notNull: false });
      else if ((x = /^\s*alter\s+(?:column\s+)?([a-z_][a-z0-9_]*)\s+set\s+default/i.exec(a)))
        put(t, x[1], { dflt: true });
      else if ((x = /^\s*alter\s+(?:column\s+)?([a-z_][a-z0-9_]*)\s+drop\s+default/i.exec(a)))
        put(t, x[1], { dflt: false });
      else if ((x = /^\s*drop\s+column\s+(?:if\s+exists\s+)?([a-z_][a-z0-9_]*)/i.exec(a)))
        cols.delete(`${t}.${x[1]}`);
    }
  }

  const out = {};
  for (const c of cols.values()) {
    if (!c.notNull || c.dflt) continue;
    (out[c.table] ||= []).push(c.col);
  }
  return out;
};

const declared = notNullFromMigrations();
const modelled = SCHEMA.notNull;
const counted = SYNCED.reduce((n, t) => n + (declared[t] || []).length, 0);
const gaps = SYNCED.flatMap(t => (declared[t] || [])
  .filter(c => !(modelled[t] || []).includes(c)).map(c => `${t}.${c}`));
ok(gaps.length === 0,
   `every NOT NULL column on the ${SYNCED.length} synced tables is modelled by the mock (${counted} columns)`,
   `missing from the notNull map in packages/zero-core/mock-supabase.mjs: ${gaps.join(', ')}. `
   + 'A column the oracle does not know is a row every suite will pass and the real '
   + 'server will dead-letter.');

/* The other direction is a warning, not a blocker. A column the mock demands
 * and the schema does not makes the suites pessimistic rather than blind --
 * but it usually means a migration relaxed something and the map was not told,
 * which is worth seeing before it becomes a test nobody can explain. */
const stale = Object.keys(modelled).flatMap(t => modelled[t]
  .filter(c => !(declared[t] || []).includes(c)).map(c => `${t}.${c}`));
soft(stale.length === 0,
     'and demands nothing the schema does not'
     + (stale.length ? ' — stale: ' + stale.join(', ') : ''),
     'a NOT NULL the migrations no longer declare makes the mock stricter than the server');

const pkg = JSON.parse(read('package.json'));
ok(/embed-core\.mjs --check/.test(pkg.scripts.test),
   'npm test fails if the embedded zero-core has drifted');

/* ───────────────────────────────────────────────────────────────── output */
console.log(`\n${fail ? `\x1b[31m${fail} blocking\x1b[0m` : '\x1b[32mno blockers\x1b[0m'}` +
            (warn ? `, ${warn} to look at` : '') + '\n');
if (!fail) {
  console.log('Next: npm test, then push. Once the project exists,');
  console.log('node tools/verify-live.mjs checks the real backend.\n');
}
process.exit(fail ? 1 : 0);
