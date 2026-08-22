/* Zero and Bench, together, on one origin and one account.
 *
 * Every other suite tests one app. That is exactly where the cross-app bugs
 * hide: each app's own tests pass, and the thing that is broken is the seam.
 * This one builds both against a single mock backend and serves them the way
 * they deploy -- Zero at /, Bench at /bench/, SAME ORIGIN, therefore one
 * localStorage between them -- and drives both in one browser.
 *
 * The claim under test is the one the user actually asked for: enter a firearm
 * once and have both apps know about it, without either app erasing the fields
 * the other owns.
 */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startMock } from '../packages/zero-core/mock-supabase.mjs';
import { buildZero } from '../apps/zero/build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/opt/pw-browsers/chromium';
const LAUNCH_OPTS = fs.existsSync(CHROME) ? { executablePath: CHROME } : {};

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const section = (s) => console.log('\n' + s);

const mock = await startMock({ ttlSec: 3600 });

/* Both apps built the way a deploy builds them, pointed at this run's mock.
 * Bench's build is a script rather than an export, so it runs as one -- it
 * reads the backend from the environment, which is the same path CI uses. */
await buildZero({ url: mock.url, anonKey: 'anon-key', outdir: 'dist-cross', single: false });
execFileSync(process.execPath, [path.join(ROOT, 'apps/bench/build.mjs')], {
  stdio: 'pipe',
  env: { ...process.env, SUPABASE_URL: mock.url, SUPABASE_ANON_KEY: 'anon-key' },
});

const ZERO_DIR = path.join(ROOT, 'apps/zero/dist-cross');
const BENCH_DIR = path.join(ROOT, 'apps/bench/dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  let dir = ZERO_DIR;
  if (p === '/bench' ) { res.writeHead(302, { Location: '/bench/' }); return res.end(); }
  if (p.startsWith('/bench/')) { dir = BENCH_DIR; p = p.slice('/bench'.length); }
  if (p === '/' || p === '') p = '/index.html';
  const f = path.join(dir, p);
  if (!f.startsWith(dir) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); return res.end('nope');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch(LAUNCH_OPTS);
/* ONE context: the two apps share an origin in production and therefore share
 * localStorage. Giving each its own context would test a separation that does
 * not exist and would have hidden the shared-cursor bug entirely. */
const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
const errs = [];
ctx.on('page', p => {
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
});

const zero = await ctx.newPage();
const bench = await ctx.newPage();

const firearmRows = () => [...(mock.state.rows.get('firearms')?.values() || [])];
const benchDb = () => bench.evaluate(() => ({
  firearms: DB.firearms.map(f => ({ id: f.id, remote: f.remote, name: f.name,
    cartridge: (DB.cartridges.find(c => c.id === f.cartridge) || {}).name || null,
    barrel: f.barrel, twist: f.twist, sightHeight: f.sightHeight,
    zeroRange: f.zeroRange, notes: f.notes })),
  cartridges: DB.cartridges.map(c => c.name),
}));
const zeroFirearms = () => zero.evaluate(() =>
  JSON.parse(localStorage.getItem('rifles_v1') || '[]'));

/* The mock's clock is frozen unless a test moves it, and `updated_at` is what
 * the pull cursor compares against: two edits at the same stamp are invisible
 * to the second puller. Real time passes between a user editing in one app and
 * syncing in the other, so the test moves the clock the same way. */
const later = (ms = 60_000) => { mock.state.clock += ms; };

const benchSync = async () => {
  await bench.click('[data-act="tab"][data-arg="lookup"]');
  await bench.waitForTimeout(120);
  await bench.click('button[data-act="sySync"]');
  await bench.waitForTimeout(900);
};
const zeroSync = async () => {
  await zero.click('button:has-text("Sync now")');
  await zero.waitForTimeout(900);
};

/* ============================================================ Zero: sign up */
section('one account, two apps');
{
  await zero.goto(BASE);
  await zero.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('rifles_v1', JSON.stringify([{
      id: 'r1', name: 'Tikka T3x', caliber: '6.5 Creedmoor',
      barrelLife: 2800, roundsAtStart: 120, notes: 'match barrel', ts: 1,
    }]));
  });
  await zero.reload();
  await zero.waitForTimeout(700);

  await zero.fill('input[placeholder="email"]', 'both@example.com');
  await zero.fill('input[placeholder="password"]', 'hunter2');
  await zero.click('button:has-text("create account")');
  await zero.waitForTimeout(700);
  ok((await zero.textContent('body')).includes('both@example.com'), 'Zero is signed in');

  /* The session is deliberately shared between the two apps: it is an
   * identity, not work in progress, and one sign-in for both apps is the whole
   * premise. The queue and the cursors are NOT shared, which is what the
   * firearm below actually depends on. */
  await bench.goto(BASE + 'bench/');
  await bench.waitForTimeout(800);
  const benchBody = await bench.textContent('body');
  ok(benchBody.includes('both@example.com'),
     'opening Bench afterwards finds it already signed in — no second sign-in');
}

/* ================================================= Zero → the server → Bench */
section('a firearm entered once');
{
  await zeroSync();
  const rows = firearmRows();
  ok(rows.length === 1, `Zero pushed the firearm (${rows.length} row)`);
  const r0 = rows[0] || {};
  ok(r0.name === 'Tikka T3x' && r0.cartridge === '6.5 Creedmoor', 'name and chambering map');
  ok(r0.barrel_life_rounds === 2800 && r0.rounds_at_start === 120,
     'barrel life and the starting count travel — the columns Zero owns');

  await bench.reload();                 // a page that loads after the sync
  await bench.waitForTimeout(700);
  await benchSync();

  const db = await benchDb();
  const f = db.firearms.find(x => x.name === 'Tikka T3x');
  ok(!!f, 'it arrives in Bench without being typed again');
  ok(f && f.cartridge === '6.5 Creedmoor',
     'the chambering became a real Bench cartridge, matchable against brass and recipes');
  ok(db.cartridges.includes('6.5 Creedmoor'), '...and is in the cartridge list');
  ok(f && f.remote === r0.id, 'the local record carries the shared id, so edits update it');
}

/* ================================== Bench edits its own columns, and only those */
section('each app writes only what it owns');
{
  later();
  /* Through the app's real edit path, not by poking the record: the edit path
   * is what stamps the local modification time, and a test that set the fields
   * directly would be testing a state the app cannot actually produce. */
  await bench.evaluate(() => {
    const f = DB.firearms.find(x => x.name === 'Tikka T3x');
    applyEdit('firearm', f.id, { name: f.name, cartridge: f.cartridge,
      barrel: 24, twist: '1:8', sightHeight: 1.75, zeroRange: 100, notes: f.notes });
    save();
  });
  await benchSync();

  const r = firearmRows()[0] || {};
  ok(Number(r.barrel_in) === 24 && r.twist === '1:8',
     'Bench wrote the geometry Zero has no field for');
  ok(r.barrel_life_rounds === 2800 && r.rounds_at_start === 120,
     'and did NOT erase the barrel life Zero owns — the clobber this design exists to prevent');

  await zeroSync();
  const zf = (await zeroFirearms())[0] || {};
  ok(zf.barrelLife === 2800 && zf.roundsAtStart === 120,
     'Zero still has its own fields after the round trip');
  ok(zf.remoteId === r.id, 'and is still matched to the same shared row');
}

/* ================================================= a rename crosses both ways */
section('a rename crosses');
{
  later();
  await bench.evaluate(() => {
    const f = DB.firearms.find(x => x.name === 'Tikka T3x');
    applyEdit('firearm', f.id, { name: 'Tikka T3x (rebarrelled)', cartridge: f.cartridge,
      barrel: f.barrel, twist: f.twist, sightHeight: f.sightHeight,
      zeroRange: f.zeroRange, notes: f.notes });
    save();
  });
  await benchSync();
  await zero.reload();
  await zero.waitForTimeout(700);
  await zeroSync();

  const zf = (await zeroFirearms())[0] || {};
  ok(zf.name === 'Tikka T3x (rebarrelled)', 'Zero picked up the rename');
  ok((await zeroFirearms()).length === 1, 'as an update, not a second firearm');
}

/* ====================================================== deleting is not undone */
section('a delete stays deleted');
{
  const before = (await benchDb()).firearms.length;
  later();
  await bench.evaluate(() => {
    const f = DB.firearms.find(x => /Tikka/.test(x.name));
    ACTIONS.delFirearm(f.id);
  });
  await bench.waitForTimeout(200);
  await benchSync();

  const db = await benchDb();
  ok(db.firearms.length === before - 1, 'it is gone from Bench');
  ok(!!(firearmRows()[0] || {}).deleted_at, 'and tombstoned on the server, not merely dropped locally');

  await zeroSync();
  ok((await zeroFirearms()).length === 0, 'Zero honours the tombstone');

  /* The failure this guards: a delete with no tombstone leaves the row on the
   * server, the next pull finds no local match, and the firearm the user just
   * deleted reappears as a brand new one. */
  await benchSync();
  ok((await benchDb()).firearms.length === before - 1, 'and it does not come back on the next sync');
}

/* ==================================================================== hygiene */
section('hygiene');
{
  const real = errs.filter(e => !/404|Failed to load resource/i.test(e));
  ok(real.length === 0, 'no JavaScript errors in either app' +
     (real.length ? ' — ' + real.slice(0, 2).join(' | ') : ''));
}

await browser.close();
server.close();
mock.close && mock.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
