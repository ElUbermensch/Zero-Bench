/* End-to-end: patched Zero + mock Supabase, through the real UI. */
import { chromium } from 'playwright';
/* Use the preinstalled browser when present (this dev sandbox sets
 * PLAYWRIGHT_BROWSERS_PATH); otherwise fall back to whatever Playwright
 * installed, which is what CI and a normal checkout will have. */
import fsx from 'node:fs';
const CHROME = '/opt/pw-browsers/chromium';
const LAUNCH_OPTS = fsx.existsSync(CHROME) ? { executablePath: CHROME } : {};
import { startMock } from '../../packages/zero-core/mock-supabase.mjs';
import http from 'node:http';
import fs from 'node:fs';

const mock = await startMock({ ttlSec: 3600 });

const server = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  const f = 'dist/' + (p === '/' ? 'index.html' : p.slice(1));
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
  localStorage.setItem('zs_sessions_v1', JSON.stringify(sessions));
  localStorage.setItem('zs_ammo_v1', JSON.stringify(ammo));
}, { BATCH_ID });
await page.reload();
await page.waitForTimeout(700);

console.log('\nboot');
ok((await page.textContent('body')).includes('league night'), 'the seeded session renders');
ok((await page.textContent('body')).includes('Cloud sync'), 'the sync card is present on the home screen');

console.log('\nserver config + account');
await page.fill('input[placeholder="https://YOUR-PROJECT.supabase.co"]', mock.url);
await page.fill('input[placeholder="anon public key"]', 'anon-key');
await page.click('button:has-text("save server")');
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
ok(s0.batch_id === BATCH_ID, 'the session carries the tracker batch id');
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
  JSON.parse(localStorage.getItem('zs_sessions_v1'))[0].remoteId);
ok(remoteId === [...mock.state.rows.get('range_sessions').keys()][0],
   'the remote id is persisted on the local session record');

console.log('\nbatch picker');
const userId = mock.state.users.get('jaxon@example.com').id;
mock.seed('v_ballistic_profiles', {
  id: 'p1', user_id: userId, batch_id: '99999999-8888-7777-6666-555555555544',
  serial: 'B26H14-02X', load_name: '6.5CM / 140 Hybrid', cartridge: '6.5 Creedmoor',
  bullet_name: 'Berger 140gr Hybrid', coal_mean_in: 2.81, qty_remaining: 60,
  quarantined: false, untested: true, over_published_max: false,
});
await page.click('button:has-text("Firearms")');
await page.waitForTimeout(400);
await page.click('button:has-text("⇣ tracker")');
await page.waitForTimeout(600);
const body1 = await page.textContent('body');
ok(body1.includes('B26H14-02X'), 'the tracker batch appears in the picker');
ok(body1.includes('UNTESTED'), 'the untested safety flag is shown');
await page.click('button:has-text("import")');
await page.waitForTimeout(400);
const ammoNow = await page.evaluate(() => JSON.parse(localStorage.getItem('zs_ammo_v1')));
ok(ammoNow.length === 2 && ammoNow.some(a => a.batchSerial === 'B26H14-02X'),
   'importing creates a linked local load');
ok((await page.textContent('body')).includes('linked'), 'the picker marks it as linked');
ok((await page.textContent('body')).includes('⛓ B26H14-02X'), 'the ammo card shows the batch serial');

console.log('\nhygiene');
ok(errs.length === 0, 'no JS errors across the whole run'
   + (errs.length ? ' — ' + errs.slice(0, 3).join(' | ') : ''));

await browser.close(); server.close(); await mock.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
