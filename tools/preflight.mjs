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
import { loadConfig, CONFIG_PATH } from './config.mjs';

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
ok(cfg.ok, `${rel(CONFIG_PATH)} is filled in`,
   `${cfg.reason}. Both apps read this one file; without it they ask each user to type a server address.`);
if (cfg.url) console.log(`      ${cfg.url}`);

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

/* ──────────────────────────────────────────────────────────────── the apps */
section('apps');
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
}

/* ──────────────────────────────────────────── the embedded core, and CI */
section('consistency');
const embedded = read('apps/zero/Zero.jsx');
ok(embedded.includes('//#region zero-core'), 'Zero embeds zero-core in a generated region');
ok(/__SUPABASE_CONFIG__/.test(embedded), 'Zero takes its backend from the build, not a hand-edited constant');

const wf = read('.github/workflows/test.yml');
for (const t of ['rls_test.sql', 'rls_test2.sql', 'rls_test3.sql', 'rls_test4.sql']) {
  ok(wf.includes(t), `CI runs supabase/test/${t}`, 'a suite that CI does not run is a suite that rots');
}
const deploy = read('.github/workflows/deploy.yml');
const site = read('tools/build-site.mjs');
ok(deploy.includes('build:site'),
   'the Pages workflow assembles the site through the shared script',
   'inlining the copy here means Pages and Vercel can drift apart silently');
ok(site.includes('apps/bench/dist') && site.includes('apps/zero/dist'),
   'that script publishes both apps');
if (has('vercel.json')) {
  const v = JSON.parse(read('vercel.json'));
  ok(v.buildCommand === 'npm run build:site' && v.outputDirectory === 'site',
     'vercel.json builds and publishes the same thing',
     'Vercel and Pages must serve identical output or a bug reproduces on only one');
  ok(JSON.stringify(v.headers || []).includes('must-revalidate'),
     'vercel.json stops service workers being served stale',
     'a cached sw.js can pin a returning user to an old build indefinitely');

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
   * any name is caught. */
  const HEADER_KEYS = new Set(['source', 'headers', 'has', 'missing']);
  const strays = [];
  (v.headers || []).forEach((h, i) => {
    Object.keys(h).forEach(k => { if (!HEADER_KEYS.has(k)) strays.push(`headers[${i}].${k}`); });
  });
  ok(strays.length === 0,
     `vercel.json carries no properties the schema will reject${strays.length ? ' — ' + strays.join(', ') : ''}`,
     'Vercel validates this at deploy time, so a stray key fails the build rather than the checkout');
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
