/* End-to-end: patched Zero + mock Supabase, through the real UI. */
import { chromium } from 'playwright';
/* Use the preinstalled browser when present (this dev sandbox sets
 * PLAYWRIGHT_BROWSERS_PATH); otherwise fall back to whatever Playwright
 * installed, which is what CI and a normal checkout will have. */
import fsx from 'node:fs';
const CHROME = '/opt/pw-browsers/chromium';
const LAUNCH_OPTS = fsx.existsSync(CHROME) ? { executablePath: CHROME } : {};
import { startMock } from '../../packages/zero-core/mock-supabase.mjs';
import { buildZero } from './build.mjs';
import http from 'node:http';
import fs from 'node:fs';

const mock = await startMock({ ttlSec: 3600 });

/* Build the way a deploy builds: backend baked in at build time.
 *
 * With a backend configured the app correctly hides the manual server-address
 * fields, so the suites used to fail the moment supabase.config.json was
 * filled in -- they had only ever passed against an unconfigured build. Point
 * the bundle at this run's mock instead and the shipped path is what is under
 * test. */
const OUT = 'dist-test';
await buildZero({ url: mock.url, anonKey: 'anon-key', outdir: OUT, single: false });

const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  const f = OUT + '/' + (p === '/' ? 'index.html' : p.slice(1));
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };

const BATCH_ID = '11111111-2222-3333-4444-555555555555';

const browser = await chromium.launch(LAUNCH_OPTS);
const page = await browser.newPage({ viewport: { width: 430, height: 900 } });
const errs = [];
page.on('pageerror', e => errs.push(e.message));

/* Seed Zero's local model: one linked load + one session shot with it.
 * Two record shots at (0,0) and (0.42,0): ES 0.42", MR 0.21". */
await page.goto(BASE);
await page.evaluate(({ BATCH_ID }) => {
  localStorage.clear();
  const ammo = [{ id: 'am1', name: 'Linked load', bullet: 'Berger 140', batchId: BATCH_ID,
                  batchSerial: 'B26H13-01D', ts: 1 }];
  const sessions = [{ id: 's1', name: 'league night', date: '2026-08-13', type: 'Score',
    targetId: 'any', rangeYards: 100, rangeLocation: 'home range', rifleId: '', ammoId: 'am1',
    temp: '86', ts: 1, matchId: null,
    shots: [
      { id: 'x1', ring: '10', clockH: 12, clockM: 0, xy: { x: 0, y: 0 }, elev: 0, wind: 0 },
      { id: 'x2', ring: '9',  clockH: 3,  clockM: 0, xy: { x: 0.42, y: 0 }, elev: 0, wind: 0 },
    ] }];
  localStorage.setItem('sessions_v1', JSON.stringify(sessions));
  localStorage.setItem('ammo_v1', JSON.stringify(ammo));
}, { BATCH_ID });
await page.reload();
await page.waitForTimeout(700);

console.log('\nboot');
ok((await page.textContent('body')).includes('league night'), 'the seeded session renders');
ok((await page.textContent('body')).includes('Cloud sync'), 'the sync card is present on the home screen');

console.log('\nserver config + account');
await page.waitForTimeout(300);
await page.fill('input[placeholder="email"]', 'jaxon@example.com');
await page.fill('input[placeholder="password"]', 'hunter2');
await page.click('button:has-text("create account")');
await page.waitForTimeout(500);
ok((await page.textContent('body')).includes('jaxon@example.com'), 'signed in, email shown');
ok((await page.textContent('body')).includes('1 load linked'), 'the linked-load count is reported');

console.log('\npush');
await page.click('button:has-text("Sync now")');
await page.waitForTimeout(900);
const rs = [...(mock.state.rows.get('range_sessions')?.values() || [])];
const gs = [...(mock.state.rows.get('groups')?.values() || [])];
ok(rs.length === 1, `one range_session pushed (${rs.length})`);
ok(gs.length === 1, `one group pushed (${gs.length})`);
const s0 = rs[0] || {}, g0 = gs[0] || {};
ok(s0.batch_id === BATCH_ID, 'the session carries Bench batch id');
ok(s0.source_app === 'zero' && s0.occurred_on === '2026-08-13' && s0.temp_f === 86,
   `session fields map (source=${s0.source_app}, date=${s0.occurred_on}, temp=${s0.temp_f})`);
ok(g0.group_es_in === 0.42, `group ES pushed in INCHES (${g0.group_es_in})`);
ok(g0.mean_radius_in === 0.21, `mean radius pushed in inches (${g0.mean_radius_in})`);
ok(g0.distance_yd === 100 && g0.shot_count === 2, 'distance and shot count map');
ok(g0.session_id === s0.id, 'the group references its session');

console.log('\nidempotency across sync AND reload');
await page.click('button:has-text("Sync now")');
await page.waitForTimeout(700);
await page.reload();                      // remote ids must have been persisted
await page.waitForTimeout(700);
await page.click('button:has-text("Sync now")');
await page.waitForTimeout(700);
ok((mock.state.rows.get('range_sessions')?.size || 0) === 1,
   'three syncs + a reload still yield exactly one range_session');
ok((mock.state.rows.get('groups')?.size || 0) === 1, '...and exactly one group');
const remoteId = await page.evaluate(() =>
  JSON.parse(localStorage.getItem('sessions_v1'))[0].remoteId);
ok(remoteId === [...mock.state.rows.get('range_sessions').keys()][0],
   'the remote id is persisted on the local session record');

console.log('\nbatch picker');
const userId = mock.state.users.get('jaxon@example.com').id;
const NEW_BATCH = '99999999-8888-7777-6666-555555555544';
mock.seed('v_ballistic_profiles', {
  id: 'p1', user_id: userId, batch_id: NEW_BATCH,
  serial: 'B26H14-02X', load_name: '6.5CM / 140 Hybrid', cartridge: '6.5 Creedmoor',
  bullet_name: 'Berger 140gr Hybrid', bullet_weight_gr: 140, bc_g7: 0.315, bc_g1: 0.607,
  powder_name: 'Hodgdon H4350', charge_gr: 41.5, charge_actual_gr: 41.52, charge_sd_gr: 0.02,
  primer_name: 'CCI BR-2', coal_mean_in: 2.81, cbto_in: 2.245,
  muzzle_velocity_fps: 2712, velocity_sd_fps: 7.4, velocity_es_fps: 20,
  velocity_n: 5, velocity_es_sigma_fps: 8.6, velocity_measured_on: '2026-08-01',
  firearm_name: 'Tikka T3x', barrel_in: 24, twist: '1:8',
  sight_height_in: 1.75, zero_range_yd: 100,
  source_name: 'Hodgdon', source_edition: '2024', source_page: '112', source_max_gr: 43.0,
  qty_remaining: 60, qty_loaded: 100, loaded_on: '2026-07-30',
  quarantined: false, untested: true, over_published_max: false, recipe_status: 'workup',
});
await page.click('button:has-text("Firearms")');
await page.waitForTimeout(400);
await page.click('button:has-text("⇣ Bench")');
await page.waitForTimeout(600);
const body1 = await page.textContent('body');
ok(body1.includes('B26H14-02X'), 'Bench batch appears in the picker');
ok(body1.includes('UNTESTED'), 'the untested safety flag is shown');
ok(body1.includes('41.52gr Hodgdon H4350'),
   'the picker shows the charge and powder, so two loads of one bullet are distinguishable');
ok(body1.includes('2712fps'), '...and the measured velocity');
await page.click('button:has-text("import")');
await page.waitForTimeout(400);
const ammoNow = await page.evaluate(() => JSON.parse(localStorage.getItem('ammo_v1')));
const imported = ammoNow.find(a => a.batchSerial === 'B26H14-02X');
ok(ammoNow.length === 2 && imported, 'importing creates a linked local load');
ok((await page.textContent('body')).includes('linked'), 'the picker marks it as linked');
ok((await page.textContent('body')).includes('⛓ B26H14-02X'), 'the ammo card shows the batch serial');

console.log('\nwhat the import actually carries');
// The old import kept name/bullet/OAL and dropped the rest. Each of these was
// silently lost before, and each is something a ballistic solution needs.
ok(imported.powder === 'Hodgdon H4350' && +imported.charge === 41.52,
   'powder and the AS-WEIGHED charge come across, not just the recipe target');
ok(imported.batch.bcG7 === 0.315 && imported.batch.bulletWeightGr === 140,
   'BC and bullet weight come across');
ok(imported.batch.mvFps === 2712 && imported.batch.sdFps === 7.4,
   'muzzle velocity and its SD come across — SD is what drives vertical dispersion');
ok(imported.batch.esSigmaFps === 8.6,
   'ES normalised to a comparable sigma comes across, not just raw ES');
ok(imported.batch.sightHeightIn === 1.75 && imported.batch.zeroRangeYd === 100
   && imported.batch.barrelIn === 24 && imported.batch.twist === '1:8',
   'firearm geometry comes across — a solver cannot work without it');
ok(imported.batch.source === 'Hodgdon 2024 p.112',
   'the load data citation travels with the load');
ok(imported.batch.untested === true && imported.batch.quarantined === false,
   'safety flags arrive as booleans the app can act on, not as words in a notes field');
const bodyFacts = await page.textContent('body');
ok(bodyFacts.includes('2712') && bodyFacts.includes('7.4') && bodyFacts.includes('0.315'),
   'the load card shows MV, SD and BC rather than hiding them in the record');
ok(bodyFacts.includes('No chronograph data'),
   '...and states the untested warning in words on the card');

console.log('\nquarantine reaches Zero, and blocks new work');
// The load is already imported and already selectable. Quarantining happens on
// the bench, days later. A frozen copy of a boolean would never learn about it.
const prof = [...mock.state.rows.get('v_ballistic_profiles').values()][0];
prof.quarantined = true;
prof.quarantine_reason = 'suspected double charge in the last 20';
prof.qty_remaining = 40;
await page.click('button:has-text("⟳")');
await page.waitForTimeout(800);
const afterQ = await page.evaluate(() => JSON.parse(localStorage.getItem('ammo_v1')));
const q = afterQ.find(a => a.batchSerial === 'B26H14-02X');
ok(q.batch.quarantined === true, 'a refresh learns the batch was quarantined after import');
ok(q.batch.quarantineReason === 'suspected double charge in the last 20',
   '...and carries the reason, so the shooter is told why');
ok(q.batch.qtyRemaining === 40, '...and picks up the new round count');
ok(q.name === imported.name && q.rifleId === imported.rifleId,
   "...while leaving the user's own fields alone");
const bodyQ = await page.textContent('body');
ok(bodyQ.includes('suspected double charge'), 'the card shows the quarantine reason');

await page.click('button:has-text("Sessions")');
await page.waitForTimeout(300);
await page.click('button:has-text("+ session")');
await page.waitForTimeout(500);
const optQ = await page.locator('select:has(option:has-text("none / entered manually")) option')
  .filter({ hasText: 'B26H14-02X' }).first();
ok(await optQ.isDisabled(), 'a quarantined load cannot be selected for a NEW session');
ok((await optQ.textContent()).includes('quarantined'), '...and says so in the option itself');
const optOk = await page.locator('select:has(option:has-text("none / entered manually")) option')
  .filter({ hasText: 'Linked load' }).first();
ok(!(await optOk.isDisabled()), '...while an unquarantined load is still selectable');
await page.click('button.bback');            // NewSession's back reads "← back"
await page.waitForTimeout(400);
ok((await page.textContent('body')).includes('league night'),
   'the session already shot with that load is untouched — quarantining is evidence, not a delete');

/* ============================================ existing users' data is found */
console.log('\nlogbooks written by an earlier build');
{
  // The deployed Zero writes BARE keys. A build that prefixed them would show
  // every existing user an empty app with their logbook still on disk — nothing
  // would look broken, which is what makes it the dangerous kind of wrong.
  const ctx2 = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const p2 = await ctx2.newPage();
  await p2.goto(BASE);
  await p2.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('sessions_v1', JSON.stringify([{
      id: 'old1', name: 'club shoot 2024', date: '2024-06-01', type: 'Score',
      targetId: 'any', rangeYards: 100, rifleId: '', ammoId: '', ts: 1, matchId: null,
      shots: [{ id: 'o1', ring: '10', clockH: 12, clockM: 0, xy: { x: 0, y: 0 }, elev: 0, wind: 0 }],
    }]));
  });
  await p2.reload(); await p2.waitForTimeout(700);
  ok((await p2.textContent('body')).includes('club shoot 2024'),
     'a logbook written by the deployed app is read as-is, with no migration');

  // And anyone who used a prefixed build is carried forward once.
  await p2.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('zs_sessions_v1', JSON.stringify([{
      id: 'leg1', name: 'prefixed build', date: '2025-01-01', type: 'Score',
      targetId: 'any', rangeYards: 100, rifleId: '', ammoId: '', ts: 1, matchId: null,
      shots: [{ id: 'l1', ring: '9', clockH: 12, clockM: 0, xy: { x: 0, y: 0 }, elev: 0, wind: 0 }],
    }]));
  });
  await p2.reload(); await p2.waitForTimeout(700);
  ok((await p2.textContent('body')).includes('prefixed build'),
     'a logbook from a prefixed build is picked up too');
  ok(await p2.evaluate(() => localStorage.getItem('sessions_v1') !== null),
     '...and copied forward to the bare key, so the migration happens once');
  await ctx2.close();
}

console.log('\nhygiene');
ok(errs.length === 0, 'no JS errors across the whole run'
   + (errs.length ? ' — ' + errs.slice(0, 3).join(' | ') : ''));

await browser.close(); server.close(); await mock.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
