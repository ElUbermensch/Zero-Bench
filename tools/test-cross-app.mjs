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
/* Zero's sync panel lives under More -> Cloud sync now: signed in it is a
 * status readout, and a status readout has no business sitting under the
 * session list. Navigating each time is what a user does, and it also proves
 * the destination survives a reload. */
const zeroMore = async (title) => {
  await zero.click('.tabbar button:has-text("More")');
  await zero.waitForTimeout(250);
  await zero.click(`button:has-text("${title}")`);
  await zero.waitForTimeout(350);
};
const zeroSync = async () => {
  if (!(await zero.locator('button:has-text("Sync now")').count())) await zeroMore('Cloud sync');
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

/* ============================================ Zero shoots it, Bench counts it */
/* The other direction of the same account, and the one the user reported
 * missing: Bench loads the ammunition, Zero records what happened to it, and
 * Bench never heard about it. A batch that was shot up still read as full,
 * every barrel-wear figure in Bench was blind to the rounds Zero logged, and
 * the group -- the only thing that says whether the load is any good -- lived
 * in an app that cannot see the recipe that produced it. */
section('rounds fired in Zero come back to the bench');
{
  /* A minimal but real bench: the batch has to descend from a recipe and its
   * lots, because that is the chain the push walks and a batch invented
   * without one would test a row the app cannot produce. */
  await bench.evaluate(() => {
    const ca = (DB.cartridges.find(c => c.name === '6.5 Creedmoor') || {}).id;
    DB.componentLots = [
      { id: 'cl1', serial: 'C-1', kind: 'bullet', name: 'Berger 140gr Hybrid', lot: 'BG-0326',
        qty: 500, unit: 'ea', cost: 289, weightGr: 140, bcG7: 0.311 },
      { id: 'cl2', serial: 'C-2', kind: 'powder', name: 'Hodgdon H4350', lot: 'H-1177',
        qty: 8, unit: 'lb', cost: 311.2 },
      { id: 'cl3', serial: 'C-3', kind: 'primer', name: 'Fed GM210M', lot: 'GM-K3',
        qty: 1000, unit: 'ea', cost: 119.99 },
    ];
    DB.recipes = [{ id: 'r1', name: '6.5CM / 140 / H4350', cartridge: ca,
      bullet: 'Berger 140gr Hybrid', powder: 'Hodgdon H4350', primer: 'Fed GM210M',
      charge: 41.5, coal: 2.81, source: 'Hodgdon 2024', sourceMax: 43 }];
    DB.batches = [{ id: 'ba1', serial: 'B26H01-01F', recipe: 'r1', bulletLot: 'cl1',
      powderLot: 'cl2', primerLot: 'cl3', date: '2026-08-01', qty: 100 }];
    DB.sessions = [];
    save();
  });
  later();
  await benchSync();
  const batch = await bench.evaluate(() => {
    const b = DB.batches[0];
    return { remote: b.remote, serial: b.serial, left: roundsLeft(b) };
  });
  ok(!!batch.remote && batch.left === 100, 'the batch is on the server and nothing is fired yet');

  /* Zero's side, seeded the way its own suite seeds it: a NEW rifle, a load
   * linked to that batch, and one string shot with it -- twelve rounds down
   * the barrel, ten of them scored. The two numbers differ on purpose.
   *
   * The rifle is new here deliberately. A session carries `firearm_id`, and a
   * rifle entered on this device has no remote id until the push mints one, so
   * a sync that built its sessions before its firearms sent this session
   * unattributed. Everything below happens in ONE sync for that reason. */
  const gunId = 'r2';
  await zero.evaluate(({ batchId, gunId }) => {
    localStorage.setItem('rifles_v1', JSON.stringify([{
      id: gunId, name: 'Bergara B14 HMR', caliber: '6.5 Creedmoor',
      barrelLife: 2200, roundsAtStart: 0, ts: 2,
    }]));
    const shot = (i, x) => ({ id: 'x' + i, ring: '10', clockH: 12, clockM: 0,
      xy: { x, y: 0 }, elev: 0, wind: 0, isSighter: i > 10 });
    const shots = [];
    for (let i = 1; i <= 10; i++) shots.push(shot(i, i === 10 ? 0.42 : 0));
    shots.push(shot(11, 0), shot(12, 0));            // two sighters, not scored
    localStorage.setItem('ammo_v1', JSON.stringify([{ id: 'am1', name: 'Linked load',
      bullet: 'Berger 140', batchId, batchSerial: 'B26H01-01F', ts: 1 }]));
    localStorage.setItem('sessions_v1', JSON.stringify([{ id: 's1', name: 'load workup',
      date: '2026-08-13', type: 'Score', targetId: 'any', rangeYards: 100,
      rangeLocation: 'home range', rifleId: gunId || '', ammoId: 'am1', temp: '72',
      ts: 1, matchId: null, shots }]));
  }, { batchId: batch.remote, gunId });
  await zero.reload();
  await zero.waitForTimeout(700);
  later();
  await zeroSync();

  const srv = [...(mock.state.rows.get('range_sessions')?.values() || [])];
  ok(srv.length === 1, `Zero pushed the session (${srv.length} row)`);
  const s0 = srv[0] || {};
  ok(s0.batch_id === batch.remote, 'attributed to the batch that loaded the ammunition');
  const gunRow = firearmRows().find(f => f.name === 'Bergara B14 HMR');
  ok(!!gunRow && s0.firearm_id === gunRow.id,
     '...and to the rifle, in the same sync that first pushed that rifle');
  /* The bug this pins: `rounds_fired` used to carry the RECORD shot count, so
   * a twelve-round string drew ten rounds out of the batch and Zero's own
   * barrel counter -- which counts every shot -- disagreed with the server
   * about the same rifle. */
  ok(s0.rounds_fired === 12,
     `every round consumed is reported, sighters included (${s0.rounds_fired})`);
  const g0 = [...(mock.state.rows.get('groups')?.values() || [])][0] || {};
  ok(g0.shot_count === 10, '...while the group is still measured over the ten scored shots');
  ok(g0.distance_yd === 100 && Math.abs((g0.group_es_in || 0) - 0.42) < 0.01,
     'the group goes up in inches at the distance it was shot');

  later();
  await benchSync();
  const after = await bench.evaluate(() => {
    const b = DB.batches[0];
    const s = (DB.sessions || []).find(x => x.batch === b.id) || null;
    return {
      n: (DB.sessions || []).length, left: roundsLeft(b),
      session: s && { rounds: s.rounds, distance: s.distance, group: s.group,
                      date: s.date, firearm: (DB.firearms.find(f => f.id === s.firearm) || {}).name || null },
    };
  });
  ok(after.n === 1, 'the session arrives in Bench without being typed again');
  ok(after.session && after.session.rounds === 12,
     `...carrying the rounds it burned (${after.session && after.session.rounds})`);
  ok(after.left === 88, `so the batch reports what is actually left (${after.left} of 100)`);
  ok(after.session && after.session.distance === 100 && Math.abs((after.session.group || 0) - 0.42) < 0.01,
     'the group and its distance arrive too — what the load actually did');
  ok(after.session && /Bergara/.test(after.session.firearm || ''),
     'and it is attributed to the rifle, not to nobody — in the same sync that first pushed that rifle');

  /* ---- the string itself, which is the whole point of the exercise -------
   * "The range data should be completely shown in bench. Not just a few
   * stats. This is a string data analytics program at heart." A group size is
   * a summary of a summary: 0.42" at 100 is five in a cloverleaf and one
   * flyer, or six in a line, and Bench could not tell those apart. */
  const drawn = await bench.evaluate(() => {
    const s = (DB.sessions || []).find(x => (x.shots || []).length) || null;
    if (!s) return { found: false };
    const svg = targetPlot(s);
    const el = document.createElement('div');
    el.innerHTML = svg;
    const node = el.firstElementChild;
    return {
      found: true,
      shots: s.shots.length,
      sighters: s.shots.filter(x => x.sighter).length,
      ordered: s.shots.every((x, i) => i === 0 || x.n >= s.shots[i - 1].n),
      rings: (s.targetFace && s.targetFace.rings || []).length,
      targetName: s.targetName,
      hasSvg: !!node && node.tagName.toLowerCase() === 'svg',
      circles: node ? node.querySelectorAll('circle').length : 0,
      viewBox: node ? node.getAttribute('viewBox') : null,
      table: /<table/.test(stringTable(s)),
    };
  });
  ok(drawn.found, 'the string reaches Bench at all');
  ok(drawn.shots === 12, `every hole crosses, sighters included (${drawn.shots})`);
  ok(drawn.sighters === 2, '...and the two sighters are still marked as sighters');
  ok(drawn.ordered, '...in the order they were fired, not the order they were paged');
  ok(drawn.rings >= 3 && drawn.targetName,
     `...with the paper they were shot on (${drawn.targetName}, ${drawn.rings} rings)`);
  ok(drawn.hasSvg && drawn.circles >= drawn.shots + drawn.rings,
     `Bench draws it: one mark per hole and one per ring (${drawn.circles} circles)`);
  /* The crop is the difference between a readable plot and one pixel: an SR
   * face is 37 inches across and this group is under half an inch. */
  const vb = (drawn.viewBox || '').split(/\s+/).map(Number);
  ok(vb.length === 4 && vb[2] > 0 && vb[2] < 8,
     `...cropped to the group rather than the whole 37-inch face (${vb[2]?.toFixed?.(1)}" wide)`);
  ok(drawn.table, 'and the string is readable as numbers too, in firing order');

  /* Bench must not now push Zero's session back up through its own narrower
   * mapping: Bench has no shot string and no group in inches to send, so a
   * re-push would overwrite both with nulls on the next pull. */
  later();
  await benchSync();
  const back = [...(mock.state.rows.get('groups')?.values() || [])][0] || {};
  const s1 = [...(mock.state.rows.get('range_sessions')?.values() || [])][0] || {};
  ok([...(mock.state.rows.get('range_sessions')?.values() || [])].length === 1,
     'a second Bench sync does not duplicate the session');
  ok(s1.rounds_fired === 12 && Math.abs((back.group_es_in || 0) - 0.42) < 0.01,
     '...nor flatten what Zero recorded — Bench leaves rows it did not author alone');
}

/* ================================================ a second device, same account */
/* The reported failure, in the user's words: "the multi device signed into the
 * same email and restoring data is not working."
 *
 * It was not working because there was nothing to restore FROM. Only four
 * record types sync -- the ones Bench also understands -- and everything else
 * (targets, matches, and the sessions' own shot strings on a device with no
 * linked load) lived in one browser and left it only as a JSON file the user
 * had to carry across by hand. On a home-screen PWA on iOS that file mostly
 * could not be produced, let alone carried.
 *
 * The second device here is the same page with its local data wiped and its
 * session kept, which is exactly what a fresh install signed into the same
 * account looks like. */
section('a second device, same account');
{
  await zeroMore('Backup & data');
  await zero.click('button:has-text("⤒ Back up now")');
  await zero.waitForTimeout(700);
  const bodyAfterUp = await zero.textContent('body');
  ok(/Backed up/.test(bodyAfterUp), 'Zero backs the whole log up in one tap');

  const stored = [...(mock.state.rows.get('account_backups')?.values() || [])];
  ok(stored.length === 1, `one row holds it (${stored.length})`);
  ok(stored[0] && stored[0].app === 'zero' && stored[0].slot === 'default',
     '...keyed by app and slot, so Bench cannot overwrite it and a second backup replaces it');
  const snap = JSON.parse(stored[0].payload || '{}');
  ok((snap.data?.sessions_v1 || []).length === 1 && (snap.data?.rifles_v1 || []).length === 1,
     'the snapshot carries the sessions and the rifles');
  ok(Array.isArray(snap.data?.custom_targets_v1) && Array.isArray(snap.data?.matches_v1),
     '...and the collections the per-record sync deliberately does not cover');

  /* The second device. Session kept, everything else gone -- and one session
   * logged HERE that the backup has never heard of, because that is the case a
   * restore must not destroy: a range day logged offline on the phone. */
  await zero.evaluate(() => {
    const session = localStorage.getItem('zerocore.session');
    localStorage.clear();
    if (session) localStorage.setItem('zerocore.session', session);
    localStorage.setItem('sessions_v1', JSON.stringify([{ id: 'local-only',
      name: 'logged on this device', date: '2026-08-20', type: 'Practice',
      targetId: 'any', rangeYards: 200, rifleId: '', ammoId: '', ts: 9, shots: [] }]));
  });
  await zero.reload();
  await zero.waitForTimeout(900);
  /* The account is a status readout now and lives in the More menu, not under
   * the session list. Which is the point of the restructure, so the check
   * looks where a user would. */
  await zero.click('.tabbar button:has-text("More")');
  await zero.waitForTimeout(300);
  ok((await zero.textContent('body')).includes('both@example.com'),
     'the second device is signed in to the same account');
  ok((await zeroFirearms()).length === 0, '...and starts with none of the data');

  await zeroMore('Backup & data');
  await zero.click('button:has-text("⤓ Restore")');
  await zero.waitForTimeout(900);
  const after = await zero.evaluate(() => ({
    sessions: JSON.parse(localStorage.getItem('sessions_v1') || '[]'),
    firearms: JSON.parse(localStorage.getItem('rifles_v1') || '[]'),
    ammo: JSON.parse(localStorage.getItem('ammo_v1') || '[]'),
  }));
  ok(after.firearms.length === 1 && after.firearms[0].name === 'Bergara B14 HMR',
     'the rifle comes down');
  ok(after.ammo.length === 1 && !!after.ammo[0].batchId,
     '...and the load, still linked to its Bench batch');
  ok(after.sessions.some(s => s.id === 's1'),
     '...and the session that was only on the first device');
  ok(after.sessions.some(s => s.id === 'local-only'),
     'while the session logged HERE survives — a restore adds, it does not replace');
  ok(after.sessions.filter(s => s.id === 's1').length === 1,
     'and restoring does not duplicate what it already brought');

  /* Idempotence is the property that makes the button safe to press when you
   * are not sure whether you pressed it. */
  await zero.click('button:has-text("⤓ Restore")');
  await zero.waitForTimeout(700);
  const twice = await zero.evaluate(() =>
    JSON.parse(localStorage.getItem('sessions_v1') || '[]').length);
  ok(twice === after.sessions.length, `restoring twice changes nothing (${twice})`);
  ok(/Already up to date/.test(await zero.textContent('body')),
     '...and says so rather than claiming to have restored again');
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
