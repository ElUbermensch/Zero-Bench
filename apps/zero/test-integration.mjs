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

const MIME = { '.html': 'text/html', '.js': 'text/javascript',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };
/* Set true to make the harness DROP the connection instead of answering.
 * A 404 is not the failure mode that matters: a service worker only reaches
 * its offline fallback when fetch REJECTS, and a 404 resolves. Playwright's
 * offline emulation does not apply to loopback, so the only honest way to
 * reproduce "no signal" here is to kill the socket. */
let deadNetwork = false;
const server = http.createServer((req, res) => {
  if (deadNetwork) { req.socket.destroy(); return; }
  const p = req.url.split('?')[0];
  const f = OUT + '/' + (p === '/' ? 'index.html' : p.slice(1));
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  const ext = f.slice(f.lastIndexOf('.'));
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
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

/* Firearms is a submenu under More now, not a tab. Zero carried five tabs and
 * still had nowhere to put sync, backup or the Bench importer -- they were
 * stacked under the session list. Four tabs and a menu of submenus is the
 * shape Bench already uses. */
const openMore = async (title) => {
  await page.click('.tabbar button:has-text("More")');
  await page.waitForTimeout(250);
  await page.click(`button:has-text("${title}")`);
  await page.waitForTimeout(400);
};

console.log('\nboot');
{
  const home = await page.textContent('body');
  ok(home.includes('league night'), 'the seeded session renders');

  /* The complaint this answers: "Zero feels super crowded especially on
   * sessions." The sync panel, the cloud backup card and the file backup card
   * all rendered under the session list, so the sessions were a strip at the
   * top of a page about plumbing. None of the three belongs on the screen you
   * open to look at what you shot. */
  ok(!home.includes('Data backup'), 'the backup cards are NOT on the sessions screen');
  ok(!/⤓ Export|⤒ Restore/.test(home), '...nor an export or restore button, one thumb from the session list');
  /* Checked by its heading, not by its button: signed out the card renders a
   * "sign in first" line with no button at all, so asserting on the button
   * would pass with the card sitting right there. */
  ok(!home.includes('Cloud backup'), '...nor the cloud backup card');

  /* Signing in is the exception, and only while signed out. The email field
   * was put on the home screen precisely so nobody has to hunt for it to
   * answer "where is the sync button"; hiding it under More would undo that.
   * Signed in it becomes a status readout, and that belongs in the menu --
   * asserted below, after this suite signs in. */
  ok(home.includes('Cloud sync'), 'but the sign-in card stays while signed out');

  const tabs = await page.$$eval('.tabbar button', bs => bs.map(b => b.textContent.trim()));
  ok(tabs.length === 4, `four tabs, not five (${tabs.length})`);
  ok(tabs.some(t => /More/.test(t)), '...and one of them is More');

  await page.click('.tabbar button:has-text("More")');
  await page.waitForTimeout(300);
  const menu = await page.textContent('body');
  for (const dest of ['Firearms & loads', 'Targets', 'Cloud sync', 'Backup & data']) {
    ok(menu.includes(dest), `More lists ${dest}`);
  }
  /* A menu that only says where things are is worse than the tabs it replaced.
   * Each row says what is behind it before you spend a tap on it. */
  ok(/1 firearm|0 firearms/.test(menu), '...with a count on the row, so the tap is informed');

  await page.click('.tabbar button:has-text("Sessions")');
  await page.waitForTimeout(300);
}

/* ============================================================ vertical rhythm */
/* "Padding above on zero's more tab... in loads and firearms it has some
 * weirdness with the spacing that feels inconsistent."
 *
 * Neither is visible to a suite that asserts on content: every element was
 * present and correct, and the screen still looked wrong. These measure the
 * two things a reader actually registers — where content starts, and whether
 * the painted panels line up with each other. */
console.log('\nvertical rhythm');
{
  const geometry = async () => page.evaluate(() => {
    const scope = document.querySelector('.content');
    const hdr = document.querySelector('.hdr');
    const vw = document.documentElement.clientWidth;
    const cards = [];
    (function walk(node, d) {
      for (const el of node.children) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || r.height <= 0) continue;
        const card = parseFloat(cs.borderRadius) >= 6 && r.width >= vw * 0.6
          && (!/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)
              || parseFloat(cs.borderTopWidth) > 0);
        if (card) { cards.push({ top: r.top, bottom: r.bottom,
                                 l: Math.round(r.left), r: Math.round(vw - r.right) }); continue; }
        if (d < 5) walk(el, d + 1);
      }
    })(scope, 0);
    return { headerBottom: hdr.getBoundingClientRect().bottom, cards };
  });

  const screens = [['More menu', async () => {
                     await page.click('.tabbar button:has-text("More")'); }],
                   ['Firearms & loads', async () => {
                     await page.click('.tabbar button:has-text("More")');
                     await page.waitForTimeout(200);
                     await page.click('button:has-text("Firearms & loads")'); }],
                   ['Backup & data', async () => {
                     await page.click('.tabbar button:has-text("More")');
                     await page.waitForTimeout(200);
                     await page.click('button:has-text("Backup & data")'); }]];

  for (const [label, go] of screens) {
    await go(); await page.waitForTimeout(400);
    const g = await geometry();
    ok(g.cards.length > 0, `${label}: renders cards`);
    const top = Math.round(g.cards[0].top - g.headerBottom);
    /* The reported bug: the first card's top edge sat flush against the
     * header's bottom border, which reads as a rendering fault rather than a
     * layout choice. */
    ok(top >= 6, `${label}: content starts ${top}px below the header, not flush against it`);
    const insets = new Set(g.cards.map(c => `${c.l}/${c.r}`));
    ok(insets.size === 1,
       `${label}: every card shares one edge inset (${[...insets].join(', ')})`);
    ok([...insets][0].split('/')[0] === [...insets][0].split('/')[1],
       `${label}: ...and it is the same on both sides`);
  }

  /* Back belongs in the header, where every other back control in this app
   * already lives. As a button in the content it cost a row of vertical space
   * on every submenu and was the one place the two apps disagreed. */
  await page.click('.tabbar button:has-text("More")');
  await page.waitForTimeout(200);
  await page.click('button:has-text("Targets")');
  await page.waitForTimeout(300);
  ok(await page.locator('.hdr .bback').count() === 1,
     'a More submenu puts its back control in the header');
  ok(await page.locator('.content button:has-text("‹ More")').count() === 0,
     '...and not floating in the content');
  ok((await page.textContent('.hdr')).includes('Targets'),
     '...with the name of where you are, so the header is not still saying "Zero"');
  await page.click('.hdr .bback');
  await page.waitForTimeout(300);
  ok((await page.textContent('body')).includes('Firearms & loads'),
     'and it goes back to the menu');
}

/* ============================================ backup export, on both paths */
/* `<a download>` is not honoured in a home-screen PWA on iOS: the tap does
 * nothing, or opens the JSON in place with no way to keep it. The button
 * looked like it worked and produced no file -- which is also why moving data
 * to a second device failed, because there was never a file to move. Where a
 * share sheet exists the file goes through it instead. */
console.log('\nbackup export');
{
  // Share sheet available: the file must go through it, and the download
  // fallback must NOT also fire.
  await page.evaluate(() => {
    window.__shared = null; window.__downloads = 0;
    navigator.share = async (d) => { window.__shared = d; };
    navigator.canShare = (d) => !!(d && d.files && d.files.length);
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { window.__downloads++; return; }
      return click.apply(this, arguments);
    };
  });
  await openMore('Backup & data');
  await page.click('button:has-text("⤓ Export")');
  await page.waitForTimeout(400);
  const shared = await page.evaluate(() => ({
    name: window.__shared?.files?.[0]?.name || null,
    type: window.__shared?.files?.[0]?.type || null,
    downloads: window.__downloads,
  }));
  ok(/^zero-backup-\d{4}-\d{2}-\d{2}\.json$/.test(shared.name || ''),
     `the backup goes to the share sheet as a named file (${shared.name})`);
  ok(shared.type === 'application/json', '...typed so the receiving app knows what it is');
  ok(shared.downloads === 0, '...and the download path does not also fire');

  // A dismissed sheet is a cancel, not a reason to try a download that would
  // silently do nothing on the platform where the sheet exists.
  await page.evaluate(() => {
    window.__downloads = 0;
    navigator.share = async () => { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; };
  });
  await page.click('button:has-text("⤓ Export")');
  await page.waitForTimeout(400);
  ok((await page.evaluate(() => window.__downloads)) === 0,
     'dismissing the share sheet cancels, rather than falling through to a silent download');

  // No share sheet: the download is the right answer and must still happen.
  await page.evaluate(() => {
    window.__downloads = 0;
    delete navigator.share; delete navigator.canShare;
  });
  await page.click('button:has-text("⤓ Export")');
  await page.waitForTimeout(400);
  ok((await page.evaluate(() => window.__downloads)) === 1,
     'with no share sheet it falls back to a download');
}

console.log('\nbuild stamp');
{
  const stamped = await page.evaluate(() => window.__BUILD__ || null);
  ok(typeof stamped === 'string' && stamped.length > 4,
     `the page carries a build stamp (${stamped})`);
  /* At the foot of the More menu, one tap from any tab. It used to be on the
   * home screen inside the sync card; when that card moved, a stamp two taps
   * deep inside Cloud sync would have been the wrong place for the first
   * question anyone asks when a fix seems not to have landed. */
  await page.click('.tabbar button:has-text("More")');
  await page.waitForTimeout(300);
  const shown = await page.textContent('body');
  ok(shown.includes(stamped), 'and the More menu shows it, so it is readable from a phone');
}

console.log('\nserver config + account');
/* Back to Sessions, where the sign-in card lives while signed out. */
await page.click('.tabbar button:has-text("Sessions")');
await page.waitForTimeout(300);
await page.fill('input[placeholder="email"]', 'jaxon@example.com');
await page.fill('input[placeholder="password"]', 'hunter2');
await page.click('button:has-text("create account")');
await page.waitForTimeout(500);
/* The other half of the placement rule: once there IS an account the panel is
 * a status readout and gets out of the way. Which means the card the user just
 * typed into vanishes -- and a card that vanishes with no acknowledgement
 * reads as a failure, so signing in carries them to the screen it became. */
{
  const after = await page.textContent('body');
  ok(after.includes('jaxon@example.com'), 'signed in, email shown');
  ok(/Sync now/.test(after), '...on the sync screen, which sign-in lands on');

  await page.click('.tabbar button:has-text("Sessions")');
  await page.waitForTimeout(300);
  const home = await page.textContent('body');
  ok(!/Sync now/.test(home), 'and the panel is gone from the sessions screen');

  await openMore('Cloud sync');
  const syncScreen = await page.textContent('body');
  ok(syncScreen.includes('1 load linked'), 'the linked-load count is reported');
}

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

/* ================================================ the string, not just the group */
/* "This is a string data analytics program at heart." Bench could see that a
 * batch had been fired and how big the group was — a summary of a summary.
 * 0.42" at 100 is five in a cloverleaf and one flyer, or six in a line, and
 * those are a load problem and a wind problem. */
console.log('\nthe shot string goes up');
{
  const shots = [...(mock.state.rows.get('shots')?.values() || [])];
  ok(shots.length === 2, `every hole is a row (${shots.length})`);
  const byNo = shots.slice().sort((a, b) => a.shot_no - b.shot_no);
  ok(byNo[0].shot_no === 1 && byNo[1].shot_no === 2,
     'numbered across the whole string, because (session, shot_no) is the key');
  ok(Number(byNo[1].poi_x_in) === 0.42 && Number(byNo[1].poi_y_in) === 0,
     `impacts travel in target inches (${byNo[1].poi_x_in}, ${byNo[1].poi_y_in})`);
  ok(byNo[0].ring === '10' && byNo[1].ring === '9',
     'with the ring each took — the score is not derivable from the geometry');
  ok(byNo.every(x => x.is_sighter === false), 'and none of these were sighters');
  ok(byNo.every(x => x.velocity_fps == null),
     'no velocities: Zero records holes in paper, a chronograph is Bench\'s instrument');

  const sess = [...(mock.state.rows.get('range_sessions')?.values() || [])][0] || {};
  ok(sess.target_name, `the paper travels with the string (${sess.target_name})`);
  ok(sess.target_face && Array.isArray(sess.target_face.rings) && sess.target_face.rings.length > 2,
     '...as ring geometry, so a hole at (0.4,-1.1) can be drawn where it landed');
  ok(sess.target_face.rings.every(r => typeof r.score === 'string' && Number.isFinite(r.diam)),
     '...in the shape the check constraint demands');
}

console.log('\nidempotency across sync AND reload');
await page.click('button:has-text("Sync now")');
await page.waitForTimeout(700);
await page.reload();                      // remote ids must have been persisted
await page.waitForTimeout(700);
await openMore('Cloud sync');             // a reload lands on Sessions
await page.click('button:has-text("Sync now")');
await page.waitForTimeout(700);
ok((mock.state.rows.get('range_sessions')?.size || 0) === 1,
   'three syncs + a reload still yield exactly one range_session');
ok((mock.state.rows.get('groups')?.size || 0) === 1, '...and exactly one group');
/* The failure this guards: shots are keyed (session_id, shot_no), so a client
 * minting a fresh uuid per push sends row after row claiming shot 1 of the
 * same session. The server refuses with 23505; a mock that did not model the
 * key would have stacked six holes on a two-shot target instead. */
ok((mock.state.rows.get('shots')?.size || 0) === 2,
   `...and exactly two shots, not two per sync (${mock.state.rows.get('shots')?.size || 0})`);
{
  const shot = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('sessions_v1'))[0].shots[0].remoteId);
  ok(!!shot && mock.state.rows.get('shots').has(shot),
     'each shot carries the remote id it was pushed under, persisted locally');
}
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
/* A FIREARM IS ADDED FIRST, deliberately.
 *
 * FirearmsTab returns from two places -- an empty state and a populated one --
 * and the populated branch dropped the `core` prop when it was written out by
 * hand a second time. Every cloud control in the ammunition section is gated
 * on `core && core.isSignedIn()`, so the "⇣ Bench" button, the refresh button
 * and the import card all disappeared the moment a user added their first
 * firearm. This suite never saw it because it ran the whole picker flow with
 * no firearms recorded, which is the one state a real user is never in for
 * long. It runs in the populated branch now. */
await page.evaluate(() => {
  const list = JSON.parse(localStorage.getItem('rifles_v1') || '[]');
  list.push({ id: 'r-fixture', name: 'Leander SR-01', caliber: '.223 Wylde',
              barrelLife: 4000, roundsAtStart: 310, notes: '', ts: 1, mtime: 1 });
  localStorage.setItem('rifles_v1', JSON.stringify(list));
});
await page.reload();
await page.waitForTimeout(800);
await openMore('Firearms & loads');
ok((await page.textContent('body')).includes('Leander SR-01'), 'the firearm is there');
ok(await page.locator('button:has-text("⇣ Bench")').count() > 0,
   'the Bench importer is still offered once a firearm exists');
/* The big call-to-action card is for someone who has linked NOTHING. This
 * fixture already has one linked load, so its absence here is the rule
 * working, not the bug above: the small chip is the affordance once you know
 * the feature exists. */
ok(await page.locator('button:has-text("Import batches from Bench")').count() === 0,
   '...and the first-run card steps aside once a load is already linked');

await page.click('button:has-text("⇣ Bench")');
await page.waitForTimeout(600);
const body1 = await page.textContent('body');
ok(body1.includes('B26H14-02X'), 'Bench batch appears in the picker');

/* Opened from the AMMUNITION header, which is the screen the user screenshotted
 * with the buttons crushed into vertical slivers. Same structural check as on
 * Targets+: the panel is a sibling of that header, not a flex item inside it. */
const hdrLayout = await page.evaluate(() => {
  const panel = document.querySelector('[data-bench-picker]');
  const btn = [...document.querySelectorAll('button')].find(b => /⇣ Bench/.test(b.textContent));
  let el = panel && panel.parentElement, inRow = false;
  while (el && el !== document.body) {
    const cs = getComputedStyle(el);
    if (cs.display === 'flex' && cs.flexDirection === 'row') { inRow = true; break; }
    el = el.parentElement;
  }
  const r = btn && btn.getBoundingClientRect();
  return { inRow, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
           btnW: r ? Math.round(r.width) : 0, btnH: r ? Math.round(r.height) : 0 };
});
ok(!hdrLayout.inRow, 'the picker opened from the ammunition header is not inside that header');
ok(hdrLayout.overflow <= 0, `...and the page does not scroll sideways (${hdrLayout.overflow}px)`);
ok(hdrLayout.btnW > hdrLayout.btnH,
   `...and "⇣ Bench" stays a button rather than a vertical sliver (${hdrLayout.btnW}×${hdrLayout.btnH})`);
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
  /* The CONTENTS, not merely the key. This asserted `!== null`, which is
   * satisfied by copying forward an empty array -- and that passes on launch
   * one, because the value the migration RETURNS to the caller is still the
   * legacy one. The logbook is destroyed on launch two, when the bare key is
   * read and found empty while the prefixed copy sits on disk, permanently
   * shadowed. This is the single path every pre-prefix user's whole history
   * travels through, exactly once.
   *
   * So: what crossed, and does it survive the launch after the migration. */
  const carried = await p2.evaluate(() =>
    JSON.parse(localStorage.getItem('sessions_v1') || 'null'));
  ok(Array.isArray(carried) && carried.length === 1 && carried[0].id === 'leg1'
     && (carried[0].shots || []).length === 1,
     `...and the copy carries the logbook, not just the key (${
       Array.isArray(carried) ? carried.length + ' sessions' : String(carried)})`);
  await p2.reload(); await p2.waitForTimeout(700);
  ok((await p2.textContent('body')).includes('prefixed build'),
     '...and it is still there on the launch AFTER the migration, which is when a bad copy shows up');
  await ctx2.close();
}

/* ================== the solver, fed by sessions rather than by a form */
/* The point of reading the anchors out of logged sessions is that the shooter
 * never types a ballistic profile: the sight height is on the firearm, the
 * velocity and BC are on the Bench batch, and the confirmed zeros are in their
 * own log. A solver that asks for all of it again is asking them to maintain
 * the same fact twice, and the second copy is the one that goes stale. */
console.log('\nthe trajectory solver');
{
  const c = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const p = await c.newPage();
  const boom = [];
  p.on('pageerror', e => boom.push(e.message));
  await p.goto(BASE);

  /* Three prone sessions at 200, 300 and 600, each ending on a dialled
     elevation — which is exactly what a season of range trips leaves behind.
     Sight settings are in CLICKS at a quarter minute each, as the app stores
     them: 8 clicks = 2 MOA, 18 = 4.5, 58 = 14.5. */
  await p.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('rifles_v1', JSON.stringify([{
      id: 'r1', name: 'Palma rifle', caliber: '.308', sightHeight: 1.9, zeroRange: 100, ts: 1 }]));
    const sess = (id, yd, clicks) => ({
      id, name: `${yd} prone`, date: '2026-08-01', type: 'Score', position: 'Prone',
      targetId: 'any', rangeYards: yd, rangeLocation: 'home range', rifleId: 'r1',
      ammoId: '', ts: yd, matchId: null,
      shots: [
        { id: id + 'a', ring: '10', clockH: 12, clockM: 0, xy: { x: 0, y: 0 }, elev: clicks, wind: 0 },
        { id: id + 'b', ring: '10', clockH: 3, clockM: 0, xy: { x: 0.3, y: 0 }, elev: clicks, wind: 0 },
      ],
    });
    localStorage.setItem('sessions_v1', JSON.stringify([
      sess('s200', 200, 8), sess('s300', 300, 18), sess('s600', 600, 58),
    ]));
  });
  await p.reload(); await p.waitForTimeout(900);

  await p.click('.tabbar button:has-text("More")');
  await p.waitForTimeout(250);
  await p.click('button:has-text("Trajectory")');
  await p.waitForTimeout(1500);          // the fit runs a few hundred trajectories

  const body = await p.textContent('body');
  ok(/Anchors · 3/.test(body),
     'it finds the three confirmed zeros in the log without being told about them');
  ok(/trued to your rifle/.test(body),
     '...and three anchors over four hundred yards is enough to true');
  ok(!/not trued/.test(body), '...so it does not fall back to the box numbers');

  /* The answer for a distance never shot, which is the entire point. */
  const rows = await p.$$eval('table.rt tbody tr', trs => trs.map(tr =>
    [...tr.children].map(td => td.textContent.trim())));
  const at = (yd) => rows.find(r => r[0].startsWith(String(yd)));
  ok(rows.length >= 10, `a come-up table (${rows.length} distances)`);
  const r1000 = at(1000);
  ok(!!r1000, 'including 1000, which this shooter has never fired');
  const moa1000 = parseFloat(r1000[1]);
  /* 58 clicks = 14.5 MOA at 600 for a .308 is a slow Palma load; 1000 lands in
     the mid-thirties. A wide band, because this asserts the answer is in the
     right universe rather than to a hundredth -- the arithmetic is pinned in
     test-solver.mjs against a rifle whose truth is known. */
  ok(moa1000 > 25 && moa1000 < 50,
     `and the number is a plausible come-up for the load (${moa1000} MOA)`);
  ok(/±/.test(r1000[1]), '...carrying an interval rather than a bare figure');
  ok(/past your furthest/.test(r1000[3]),
     '...and saying plainly that it is extrapolated');

  const r300 = at(300);
  ok(/confirmed/.test(r300[3]), 'a distance with a zero is marked confirmed, not predicted');

  ok(boom.length === 0, `no JavaScript errors${boom.length ? ' — ' + boom[0] : ''}`);
  await c.close();
}

/* ============================ forty targets, and the three you actually shoot */
/* The library is the right size and the wrong list to scroll at a firing point.
 * Pinning is what makes it usable: the handful this shooter uses sit at the top
 * of every picker, and the other thirty-seven are grouped by discipline behind
 * them. Per shooter, and it rides the backup, because it is a fact about the
 * person rather than about the data. */
console.log('\nthe target library');
{
  const c = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const p = await c.newPage();
  const boom = [];
  p.on('pageerror', e => boom.push(e.message));
  await p.goto(BASE);
  await p.evaluate(() => localStorage.clear());
  await p.reload(); await p.waitForTimeout(800);

  await p.click('.tabbar button:has-text("More")');
  await p.waitForTimeout(250);
  await p.click('button:has-text("Targets")');
  await p.waitForTimeout(500);

  const body = await p.textContent('body');
  for (const [name, why] of [['SR-3', 'High Power'], ['MR-1 F-Class', 'F-Class'],
                             ['A-23', 'Smallbore'], ['B-8', 'Pistol'], ['LR', 'Long Range']]) {
    ok(body.includes(name), `the library has the ${name} (${why})`);
  }
  ok(/High Power/.test(body) && /Smallbore/.test(body) && /Pistol/.test(body),
     '...grouped by discipline rather than as one flat list of forty');

  /* A new shooter starts with the three conventional High Power targets
     pinned, so the picker is useful before they have told it anything. */
  ok(/Yours/.test(body), 'and a group of the shooter\'s own at the top');
  const pinnedAtStart = await p.evaluate(() =>
    JSON.parse(localStorage.getItem('pinned_targets_v1') || 'null'));
  ok(pinnedAtStart === null, '...defaulted rather than written, so it is not a choice they made');

  /* Pin one, and check it reaches the picker a session is actually started
     from -- which is the only place pinning matters. */
  const pinBtn = p.locator('button:has-text("☆ pin")').first();
  await pinBtn.scrollIntoViewIfNeeded();
  await pinBtn.click();
  await p.waitForTimeout(400);
  const pinned = await p.evaluate(() => JSON.parse(localStorage.getItem('pinned_targets_v1') || '[]'));
  ok(pinned.length === 4, `pinning writes the choice (${pinned.join(', ')})`);

  await p.click('.tabbar button:has-text("Sessions")');
  await p.waitForTimeout(300);
  await p.click('button:has-text("+ session")');
  await p.waitForTimeout(500);
  /* The TARGET dropdown specifically — the form has half a dozen selects and
     reading them all together returns the type and position lists first, which
     is how the first version of this assertion managed to look at "Score |
     Sight adjustment" and call it a target order. */
  const opts = await p.$$eval('select.inp', sels => {
    const t = sels.find(s => [...s.options].some(o => /^SR\b|^MR-1\b/.test(o.textContent.trim())));
    return t ? [...t.options].map(o => o.textContent.trim()) : [];
  });
  ok(opts.length > 30, `the new-session target picker is populated (${opts.length} targets)`);
  const first = opts.slice(0, 4);
  ok(first.length === 4 && first.every(t => /^(SR|SR-3|MR-1)\b/.test(t)),
     `...with the pinned targets at the top, in pin order (${first.join(' | ')})`);
  // The option text carries the description too, so match on the name prefix.
  const at = (name) => opts.findIndex(o => o.startsWith(name + ' '));
  ok(at('A-23') > 10 && at('B-8') > 10,
     `...and the other disciplines behind them (A-23 at ${at('A-23')}, B-8 at ${at('B-8')})`);
  await p.click('button.bback');
  await p.waitForTimeout(300);

  ok(boom.length === 0, `no JavaScript errors${boom.length ? ' — ' + boom[0] : ''}`);
  await c.close();
}

/* ==================== a shot that could not be written to the card says so */
/* `localStorage.setItem` throws when the card is full, and every save in
 * Zero.jsx is wrapped in a bare `catch {}`. So React state kept the shot, the
 * screen kept the shot, and the disk did not: the shooter logged a 10, saw it
 * in the string, closed the app, and it was gone. Nothing was ever said.
 *
 * The read side of this app is careful about the difference between "empty" and
 * "unreadable" -- bootFailed exists for exactly that. The write side had no
 * notion of "unwritten" at all. Bench has said "in memory only, not saved to
 * this device" for a while; Zero said nothing.
 *
 * Its own context, because it deliberately breaks storage. */
console.log('\na card with no room left on it');
{
  const c = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const p = await c.newPage();
  await p.goto(BASE);
  await p.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('sessions_v1', JSON.stringify([{
      id: 'full', name: 'card is full', date: '2026-08-13', type: 'Score',
      targetId: 'any', rangeYards: 100, rifleId: '', ammoId: '', ts: 1, matchId: null,
      shots: [{ id: 'f1', ring: '10', clockH: 12, clockM: 0, xy: { x: 0, y: 0 }, elev: 0, wind: 0 }],
    }]));
  });
  await p.reload();
  await p.waitForTimeout(800);

  // The card fills up. Only the logbook write fails, as a real quota does:
  // the key that is about to grow is the one that cannot fit.
  await p.evaluate(() => {
    const real = Storage.prototype.setItem;
    window.__refused = 0;
    Storage.prototype.setItem = function (k, v) {
      if (k === 'sessions_v1') {
        window.__refused++;
        const e = new Error('exceeded the quota'); e.name = 'QuotaExceededError';
        throw e;
      }
      return real.call(this, k, v);
    };
  });

  await p.getByText('card is full').first().click();
  await p.waitForTimeout(400);
  await p.click('button:has-text("+ shot")');
  await p.waitForTimeout(400);
  await p.click('button:has-text("Log & done")');
  await p.waitForTimeout(700);

  ok(await p.evaluate(() => window.__refused) > 0,
     'the logbook write was refused, as a full card refuses it');
  await p.click('button.bback');
  await p.waitForTimeout(500);
  const body = await p.textContent('body');
  ok(/out of storage|could not be saved/i.test(body),
     'the app says the change was NOT saved, rather than showing it as logged');
  ok(/in memory only/i.test(body),
     '...and says what that means for what is on screen right now');

  /* The consequence, so this is not merely a banner test. */
  const onDisk = await p.evaluate(() =>
    JSON.parse(localStorage.getItem('sessions_v1'))[0].shots.length);
  ok(onDisk === 1,
     `the shot really is not on the device (${onDisk} on disk) — which is why saying so matters`);
  await c.close();
}

/* ============ a shot fired into a string that has no numbers yet goes on the END */
/* A shot's number is minted once and kept. The trap is a string that has none
 * at all -- logged before numbers existed, imported from a file, restored from
 * a backup written then -- which is the ordinary case for anyone upgrading.
 *
 * Minting for the NEW shot alone reads as correct and is worse than what it
 * replaced: `max(shotNo) + 1` over five unnumbered shots is 1, so the newcomer
 * takes 1 and the push-time back-fill numbers the five that came BEFORE it from
 * 2 up. The string goes up as 2,3,4,5,6,1 and Bench -- which sorts on that
 * number under the heading "in the order they were fired" -- draws the newest
 * shot first. The coach's live numbers invert the same way.
 *
 * Locally it is invisible: the chips renumber by position. Which is the exact
 * silence the stable-number work exists to remove, reintroduced one layer down.
 * So the whole string is numbered, not just the newcomer. */
console.log('\na shot fired into an unnumbered string');
{
  await page.evaluate(() => {
    localStorage.setItem('sessions_v1', JSON.stringify([{
      id: 'legacy', name: 'logged before numbers existed', date: '2026-08-13',
      type: 'Score', targetId: 'any', rangeYards: 100, rifleId: '', ammoId: '',
      ts: 1, matchId: null,
      shots: [1, 2, 3, 4, 5].map(i => ({
        id: 'old' + i, ring: '10', clockH: 12, clockM: 0,
        xy: { x: 0.1 * i, y: 0 }, elev: 0, wind: 0,
      })),
    }]));
  });
  await page.reload();
  await page.waitForTimeout(800);

  const numbersBefore = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('sessions_v1'))[0].shots.map(s => s.shotNo));
  ok(numbersBefore.every(n => n === undefined),
     'the seeded string carries no numbers at all, as an upgraded logbook does');

  await page.getByText('logged before numbers existed').first().click();
  await page.waitForTimeout(500);
  await page.click('button:has-text("+ shot")');
  await page.waitForTimeout(400);
  await page.click('button:has-text("Log & done")');
  await page.waitForTimeout(700);

  const after = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('sessions_v1'))[0].shots.map(s => ({ id: s.id, n: s.shotNo })));
  ok(after.length === 6, `the shot is logged (${after.length} shots)`);
  ok(after.map(s => s.n).join(',') === '1,2,3,4,5,6',
     `the whole string is numbered in firing order (${after.map(s => s.n).join(',')})`);
  ok(after[5].n === 6,
     '...and the new shot is LAST, not first — it was fired last');
  await page.click('button.bback');
  await page.waitForTimeout(300);
}

/* ================================== the date defaults to the shooter's day, not UTC's */
/* `new Date().toISOString().slice(0,10)` is the day in Greenwich. Every place
 * Zero needed "today" used it, and everywhere west of UTC that is wrong for the
 * whole evening -- which on a range is most of a summer session. A string shot
 * at 8pm in California was filed under tomorrow: it sorted above shots fired
 * after it, and the DOPE entry landed on a day the shooter was not at the range.
 *
 * Frozen at an instant where the two answers differ, so this cannot pass by
 * accident on a machine that happens to run in UTC or at noon. */
console.log('\nthe date a shooter is standing in');
{
  // 2026-08-02T03:30:00Z is 2026-08-01, 20:30 in Los Angeles. UTC says August 2.
  const FROZEN = Date.UTC(2026, 7, 2, 3, 30, 0);
  const mkTzPage = async (tz) => {
    const c = await browser.newContext({ timezoneId: tz, viewport: { width: 430, height: 900 } });
    await c.addInitScript((t) => {
      const Real = Date;
      const Frozen = new Proxy(Real, {
        construct: (T, a) => (a.length ? new T(...a) : new T(t)),
        apply: () => new Real(t).toString(),
      });
      Frozen.now = () => t;
      window.Date = Frozen;
    }, FROZEN);
    const p = await c.newPage();
    await p.goto(BASE);
    await p.waitForTimeout(600);
    return [c, p];
  };
  const defaultDate = async (p) => {
    await p.click('button:has-text("+ session")');
    await p.waitForTimeout(400);
    return p.inputValue('input[type="date"]');
  };

  const [cW, pW] = await mkTzPage('America/Los_Angeles');
  const west = await defaultDate(pW);
  ok(west === '2026-08-01',
     `an evening session west of UTC is dated today, not tomorrow (${west})`);
  /* Non-vacuity: prove the two answers actually differ at this instant, so the
   * assertion above is not passing because the harness happens to run in UTC. */
  ok(await pW.evaluate(() => new Date().toISOString().slice(0, 10)) === '2026-08-02',
     '...and the UTC day at that same instant is the 2nd — the answer the old code gave');
  await cW.close();

  /* And the other side of the line, because a fix that just subtracts a day is
   * a different bug: Tokyo is UTC+9, so that same instant is already the 2nd
   * there and the local answer is the LATER date. */
  const [cE, pE] = await mkTzPage('Asia/Tokyo');
  const east = await defaultDate(pE);
  ok(east === '2026-08-02',
     `and east of UTC the local day is the later one, not a blanket day back (${east})`);
  await cE.close();
}

/* ============================ Zero owns the root, so its worker is the broad one */
console.log('\nservice worker scope');
{
  const ctx3 = await browser.newContext();
  const p3 = await ctx3.newPage();
  await p3.goto(BASE);
  await p3.waitForTimeout(900);

  const scope = await p3.evaluate(() =>
    navigator.serviceWorker.ready.then(r => r.scope).catch(() => 'none'));
  ok(scope.endsWith('/'), `Zero's worker is registered at the root (${scope})`);

  /* Bench lives at /bench/ on this same origin, INSIDE that scope. Bench
   * registers a worker of its own and its narrower scope wins -- but only
   * after Bench has been opened at least once. On a device that has opened
   * Zero and never opened Bench, Zero's worker is the only one there, and its
   * offline fallback would hand back Zero's shell for a /bench/ URL. Someone
   * scanning an ammo box label at a range with no signal would get Zero.
   *
   * The guard in apps/zero/src/sw.js declines /bench/ outright. Assert on what
   * comes back rather than on the transport: this harness has no Bench to
   * serve, so a 404 is the correct answer and proves the request reached the
   * network instead of Zero's cache. */
  deadNetwork = true;                       // a range with no signal
  const strayed = await p3.evaluate(async () => {
    try {
      const r = await fetch('/bench/index.html');
      return r.ok ? 'body:' + (await r.text()).slice(0, 300) : `status:${r.status}`;
    } catch (e) { return 'network-error'; }
  });
  deadNetwork = false;
  // With the guard: Zero's worker declines, the browser tries the dead socket,
  // fetch rejects. Without it: the worker catches that rejection and hands
  // back its own cached shell -- Zero appearing where Bench should be.
  const servedZero = strayed.startsWith('body:');
  ok(!servedZero,
     `...and does not answer for /bench/ out of its own cache (${strayed.slice(0, 60)})`);

  errs.splice(0, errs.length,
    ...errs.filter(e => !/status of 404|Failed to load|ERR_/.test(e)));
  await ctx3.close();
}

/* ================================== importing is a read, and has its own home */
/* "Import could be a separate button so we're not running the whole thing to
 * sync every single time." It always was a single read of one view -- but the
 * only way to reach it was inside the ammunition list, so it read as part of
 * syncing. It has a home on Targets+ now, and this pins the claim that using
 * it pushes nothing. */
console.log('\nimport is its own button, and its own request');
{
  /* Back to the home screen first. Earlier sections leave the app inside a
   * session detail, where the tab bar is not what is on screen. */
  await page.reload();
  await page.waitForTimeout(900);
  await openMore('Loads from Bench');
  const onTargets = await page.textContent('body');
  ok(onTargets.includes('Loads from Bench'),
     'More carries the Bench importer as its own destination');
  ok(onTargets.includes('does not push anything and is not a sync'),
     '...and says plainly that it is a read');

  /* An earlier section quarantined B26H14-02X to pin the warning, and a
   * quarantined batch is deliberately not offered for import -- you do not
   * want it selectable as a load. So there is a second, good batch to find,
   * and the quarantined one must NOT be in the list beside it.
   *
   * This was passing for the wrong reason until the mock learned to honour a
   * `col=eq.value` filter: it was returning every row whatever was asked for,
   * so the picker appeared to work while the request it actually sends was
   * never tested. */
  mock.seed('v_ballistic_profiles', {
    id: 'p2', user_id: userId, batch_id: '99999999-8888-7777-6666-555555555533',
    serial: 'B26H20-03K', load_name: '6.5CM / 140 Hybrid', cartridge: '6.5 Creedmoor',
    bullet_name: 'Berger 140gr Hybrid', bullet_weight_gr: 140, bc_g7: 0.315,
    powder_name: 'Hodgdon H4350', charge_gr: 41.5, primer_name: 'CCI BR-2',
    coal_mean_in: 2.81, muzzle_velocity_fps: 2705, qty_remaining: 100, qty_loaded: 100,
    loaded_on: '2026-08-02', quarantined: false, untested: true,
    over_published_max: false, recipe_status: 'workup',
  });

  const pushesBefore = JSON.stringify(mock.state.hits.push);
  const pullsBefore = { ...mock.state.hits.pull };
  await page.click('button:has-text("⇣ Import batches")');
  await page.waitForTimeout(700);

  const picked = await page.textContent('body');
  ok(picked.includes('B26H20-03K'), 'the batch list comes back');
  ok(!picked.includes('B26H14-02X'),
     '...without the quarantined batch, which is filtered server-side and not offered as a load');

  /* The panel must be a SIBLING of the header, never a child of it. Dropped
   * into the ammunition header -- a flex row -- it became a flex item, squeezed
   * the two buttons into one-character-wide vertical slivers and pushed the
   * page into horizontal scroll. Asserted structurally, because "it looks
   * wrong" is not something a suite can see. */
  const laidOut = await page.evaluate(() => {
    const panel = document.querySelector('[data-bench-picker]');
    if (!panel) return { found: false };
    const flexParent = (() => {
      let el = panel.parentElement;
      while (el && el !== document.body) {
        if (getComputedStyle(el).display === 'flex') return el;
        el = el.parentElement;
      }
      return null;
    })();
    return {
      found: true,
      insideFlexRow: !!(flexParent && getComputedStyle(flexParent).flexDirection === 'row'),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      panelWidth: Math.round(panel.getBoundingClientRect().width),
      viewport: document.documentElement.clientWidth,
    };
  });
  ok(laidOut.found, 'the picker panel is in the document');
  ok(!laidOut.insideFlexRow,
     'and is NOT inside a flex row, where it would squash whatever shares it');
  ok(laidOut.overflow <= 0, `no horizontal overflow (${laidOut.overflow}px)`);
  ok(laidOut.panelWidth > laidOut.viewport * 0.5,
     `the panel gets real width rather than a sliver (${laidOut.panelWidth} of ${laidOut.viewport})`);
  ok(JSON.stringify(mock.state.hits.push) === pushesBefore,
     'and NOTHING was pushed to get it');
  const pulled = Object.keys(mock.state.hits.pull)
    .filter(t => (mock.state.hits.pull[t] || 0) > (pullsBefore[t] || 0));
  ok(pulled.length === 1 && pulled[0] === 'v_ballistic_profiles',
     `exactly one view was read (${pulled.join(', ') || 'none'})`);
}


console.log('\nhygiene');
ok(errs.length === 0, 'no JS errors across the whole run'
   + (errs.length ? ' — ' + errs.slice(0, 3).join(' | ') : ''));

/* ============================================ matches, which nothing tested */
/* A course of fire is several sessions grouped as one match — four stages of an
 * NMC, or a two-day Across-the-Course. It has ~67 references in the app and had
 * ZERO assertions in any suite; every fixture set matchId: null. Everything
 * downstream of "a match and its sessions stopped agreeing with each other" was
 * broken, and one shape of it bricked the app on every launch.
 *
 * Its own context: these seed deliberately damaged collections. */
console.log('\nmatches');
{
  const c = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const p = await c.newPage();
  const boom = [];
  p.on('pageerror', e => boom.push(e.message));

  const seed = (state) => p.evaluate((s) => {
    localStorage.clear();
    for (const [k, v] of Object.entries(s)) localStorage.setItem(k, JSON.stringify(v));
  }, state);
  const stage = (id, matchId, date, ts, name) => ({
    id, name, date, type: 'Score', targetId: 'any', rangeYards: 200,
    rifleId: '', ammoId: '', ts, matchId,
    shots: [{ id: id + 'a', ring: '10', clockH: 12, clockM: 0, xy: { x: 0, y: 0 }, elev: 0, wind: 0 },
            { id: id + 'b', ring: '9', clockH: 3, clockM: 0, xy: { x: 0.4, y: 0 }, elev: 0, wind: 0 }],
  });

  await p.goto(BASE);

  /* ---- a null in matches_v1 used to be a permanent brick.
   * `matches.map(m => m.id)` throws during render, there is one boundary for
   * the whole tree, and the row is on disk — so it crashed on EVERY launch,
   * after a restore that had already replaced the local data and reported
   * success. */
  await seed({
    matches_v1: [null, { id: 'M1', name: 'Camp Perry', type: 'NMC', date: '2026-08-01', ts: 1 }],
    sessions_v1: [stage('s1', 'M1', '2026-08-01', 10, 'Stage 1')],
  });
  await p.reload(); await p.waitForTimeout(900);
  ok(!/hit a bug and stopped/.test(await p.textContent('body')),
     'a null row in the match list does not take the app down');
  ok(/Camp Perry/.test(await p.textContent('body')),
     '...and the real match beside it still renders');
  await p.reload(); await p.waitForTimeout(800);
  ok(!/hit a bug and stopped/.test(await p.textContent('body')),
     '...on the launch after, too — the bad row is dropped, not merely survived');

  /* ---- a stage whose match is gone used to vanish from the log entirely.
   * Not deleted — Analytics still counted it — just in neither bucket: not a
   * stage of any listed match, and not standalone either. Reachable without
   * touching a file: "remove match" does two separate writes, and if the second
   * fails the sessions keep a matchId whose match is gone. */
  await seed({
    matches_v1: [],
    sessions_v1: [stage('orphan', 'GHOST', '2026-08-02', 20, 'the 600 yard line')],
  });
  await p.reload(); await p.waitForTimeout(900);
  ok(/the 600 yard line/.test(await p.textContent('body')),
     'a stage whose match is gone still appears, as an ordinary session');

  /* ---- an empty match used to be invisible AND unremovable.
   * It was dropped from the list, and its "remove match" button lives inside
   * the card that was not rendered. The cloud merge manufactures this state:
   * deletes do not cross a merge, so a match removed here comes back while its
   * stages stay detached — and it then rides every backup from then on. */
  await seed({
    matches_v1: [{ id: 'M2', name: 'came back from the cloud', type: 'NMC', date: '2026-08-03', ts: 2 }],
    sessions_v1: [stage('solo', null, '2026-08-04', 30, 'unrelated')],
  });
  await p.reload(); await p.waitForTimeout(900);
  const emptyBody = await p.textContent('body');
  ok(/came back from the cloud/.test(emptyBody),
     'a match with no stages is listed rather than hidden on disk forever');
  await p.getByText('came back from the cloud').first().click();
  await p.waitForTimeout(400);
  ok(await p.locator('text=/remove match/i').count() > 0,
     '...so the button that removes it can actually be reached');

  /* ---- the date on the card is the match's, not the form's.
   * refDate was computed and thrown away; the header rendered match.date, the
   * value typed into the creation form, which never moves again. And subs were
   * sorted by ts — the order stages were ENTERED — so a two-day match whose 600
   * was logged first listed day two above day one. */
  await seed({
    matches_v1: [{ id: 'M3', name: 'Two-day Regional', type: 'NMC', date: '2026-09-09', ts: 3 }],
    sessions_v1: [
      stage('day2', 'M3', '2026-08-02', 100, 'the 600, fired on day two'),
      stage('day1', 'M3', '2026-08-01', 200, 'the 200, fired on day one'),
    ],
  });
  await p.reload(); await p.waitForTimeout(900);
  const dated = await p.textContent('body');
  ok(/2026-08-01/.test(dated) && !/2026-09-09/.test(dated),
     'the card is dated by its earliest stage, not by whatever the form said');
  await p.getByText('Two-day Regional').first().click();
  await p.waitForTimeout(400);
  const order = await p.textContent('body');
  ok(order.indexOf('day one') < order.indexOf('day two'),
     '...and the stages are in firing order, not entry order');

  /* ---- a match everyone missed still shows a score. Gating on points made a
   * zero look exactly like a match not yet shot. */
  await seed({
    matches_v1: [{ id: 'M4', name: 'Bad day', type: 'NMC', date: '2026-08-05', ts: 4 }],
    sessions_v1: [{ id: 'miss', name: 'Stage 1', date: '2026-08-05', type: 'Score',
      targetId: 'any', rangeYards: 200, rifleId: '', ammoId: '', ts: 40, matchId: 'M4',
      shots: [{ id: 'm1', ring: 'M', clockH: 12, clockM: 0, xy: { x: 20, y: 0 }, elev: 0, wind: 0 },
              { id: 'm2', ring: 'M', clockH: 6, clockM: 0, xy: { x: -20, y: 0 }, elev: 0, wind: 0 }] }],
  });
  await p.reload(); await p.waitForTimeout(900);
  ok(/0–0X/.test(await p.textContent('body')),
     'a match where every shot missed shows a zero, not a blank');
  ok(/of 50 for a class/.test(await p.textContent('body')),
     '...and does not hand out a classification off two shots');

  /* ---- an expanded match can have a stage added to it.
   * `onAddToMatch` and `onNewSessionInMatch` were both passed to SessionsList
   * and neither was destructured, so the handler they pointed at was
   * unreachable and a match card had no "+ stage" at all. The only route was
   * + session -> "Add to existing", which means knowing the feature is there. */
  await p.getByText('Bad day').first().click();
  await p.waitForTimeout(400);
  ok(await p.locator('text=/\\+ stage/').count() > 0, 'an expanded match offers to add a stage');
  await p.locator('text=/\\+ stage/').first().click();
  await p.waitForTimeout(500);
  ok(/New session/i.test(await p.textContent('body')),
     '...and the button goes somewhere, rather than to a screen that does not exist');
  await p.click('button.bback');
  await p.waitForTimeout(300);

  /* ---- a template un-hides the paper it needs.
   * Templates name their targets by id, the user can hide any built-in, and
   * `getTarget` falls back to allTargets[0] rather than failing -- so a hidden
   * MR-1 meant a 600-yard stage was scored, plotted and COACHED against a
   * 200-yard SR face, with an invented zero error and advice to go chase it. */
  await seed({ deleted_builtins_v1: ['mr1', 'sr3', 'b8'], matches_v1: [], sessions_v1: [] });
  await p.reload(); await p.waitForTimeout(800);
  await p.click('button:has-text("+ match")');
  await p.waitForTimeout(500);
  ok(/National Match Course/i.test(await p.textContent('body')),
     'the course-of-fire templates are reachable');
  await p.locator('button.bprim').first().click();
  await p.waitForTimeout(700);

  const hiddenAfter = await p.evaluate(() =>
    JSON.parse(localStorage.getItem('deleted_builtins_v1') || '[]'));
  ok(!hiddenAfter.includes('mr1') && !hiddenAfter.includes('sr3'),
     `a template un-hides the paper its stages are shot on (${hiddenAfter.join(', ') || 'none hidden'})`);
  ok(hiddenAfter.includes('b8'),
     '...and only that paper — a target no stage needs stays hidden');

  /* The consequence, which is the reason it matters: the 600-yard stage is
   * measured against MR-1 and not against whatever target happened to be
   * first in the list. */
  const stages = await p.evaluate(() => JSON.parse(localStorage.getItem('sessions_v1')));
  const six = stages.find(s => s.rangeYards === 600);
  ok(six && six.targetId === 'mr1',
     `the 600-yard stage is on MR-1 (${six ? six.targetId : 'no 600 stage'})`);
  await p.getByText(/National Match Course/).first().click();   // cards start collapsed
  await p.waitForTimeout(400);
  await p.getByText(/Prone slow · 600/).first().click();
  await p.waitForTimeout(700);
  ok(/MR-?1/i.test(await p.textContent('body')),
     '...and opens against MR-1, rather than silently falling back to a 200-yard face');
  await p.click('button.bback');
  await p.waitForTimeout(300);

  ok(boom.length === 0, `no JavaScript errors through any of it${boom.length ? ' — ' + boom[0] : ''}`);
  await c.close();
}

/* ================================================================ crash floor */
/* A single-file React app with no route boundaries: ANY throw during render
 * unmounts the whole tree. White screen, on a phone, at a range, and the only
 * escape a user knows is deleting the app -- which deletes their data, because
 * the data lives in this browser.
 *
 * Not hypothetical twice over. A useState placed after a conditional return in
 * SessionDetail took the app down on "+ shot". And a session record whose
 * `shots` is a string rather than an array -- a shape a partial write or an
 * older export can produce -- takes it down at boot, before the user can reach
 * anything at all.
 *
 * The boundary is the floor. The export button ON the boundary is the point:
 * a crash must never hold someone's season hostage. */
console.log('\ncrash floor');
{
  /* First, the case that should never REACH the boundary. A session whose
   * `shots` is a string is the likeliest corruption — a partial write, an
   * older export, a hand-edited backup — and it used to take the whole app
   * down at boot, before the user could reach anything at all. It is repaired
   * on load now: the string goes, the session stays. */
  await page.evaluate(() => {
    localStorage.setItem('sessions_v1',
      '[{"id":"boom","name":"survivor","shots":"not-an-array","targetId":"any",'
      + '"rangeYards":100,"date":"2026-08-13","ts":1}]');
  });
  await page.reload();
  await page.waitForTimeout(900);
  {
    const b = await page.textContent('body');
    ok(!/hit a bug and stopped/.test(b),
       'a session with a corrupt shot string is repaired at boot, not crashed on');
    ok(/survivor/.test(b),
       '...and the session itself survives — losing the string beats losing the session');
  }

  /* A target with no rings, which is the same class of bug reached a different
   * way. The editor cannot produce one -- removeRing floors at one row and the
   * save refuses a ring with no diameter -- but the backup importer and the
   * cloud restore both wrote `customTargets` through unvalidated, and a target
   * is the scale every hole is measured against. `rings[rings.length-1].diam`
   * on an empty array threw out of GroupPlot, so EVERY session shot on that
   * paper opened the crash screen, every time, forever. The app booted clean
   * and the session list rendered fine, so nothing pointed at the target.
   *
   * Dropped on the way in rather than repaired: there is no diameter to
   * invent, and `getTarget` already falls back to a real target for a session
   * whose paper is gone. A mis-scaled plot beats a dead app. */
  await page.evaluate(() => {
    localStorage.setItem('custom_targets_v1',
      JSON.stringify([{ id: 't_bad', name: 'RINGLESS', rings: [] }]));
    localStorage.setItem('sessions_v1', JSON.stringify([{
      id: 'ringless', name: 'shot on ringless paper', date: '2026-08-13', type: 'Score',
      targetId: 't_bad', rangeYards: 100, rifleId: '', ammoId: '', ts: 1, matchId: null,
      shots: [
        { id: 'r1', ring: '10', clockH: 12, clockM: 0, xy: { x: 0, y: 0 }, elev: 0, wind: 0 },
        { id: 'r2', ring: '9', clockH: 3, clockM: 0, xy: { x: 0.42, y: 0 }, elev: 0, wind: 0 },
      ] }]));
  });
  await page.reload();
  await page.waitForTimeout(900);
  {
    ok(!/hit a bug and stopped/.test(await page.textContent('body')),
       'a ringless target does not crash the app at boot');
    await openMore('Targets');
    ok(!/RINGLESS/.test(await page.textContent('body')),
       '...because it is dropped on the way in — a target with no rings has no scale to measure against');

    // The crash was on OPENING the session, which is where the plot is drawn.
    await page.click('.tabbar button:has-text("Sessions")');
    await page.waitForTimeout(300);
    await page.getByText('shot on ringless paper').first().click();
    await page.waitForTimeout(700);
    const b = await page.textContent('body');
    ok(!/hit a bug and stopped/.test(b),
       '...and the session shot on it opens rather than landing on the boundary');
    ok(/0\.42|MOA|ES/.test(b),
       '...with its group still measured, against the target it fell back to');
  }

  /* Then the floor itself.
   *
   * This used to use an ammo list holding a null, and that is guarded now --
   * along with matches, firearms and targets, after a null in `matches_v1`
   * turned out to brick the app on every launch. So the fixture moved DOWN a
   * level, to a null inside a session's shot string: the session-level filter
   * checks the session object, not the shots inside it.
   *
   * The point of this section is not any particular corruption. It is that
   * there is always another one, and the boundary is what stands between the
   * next one and a white screen with a season behind it. */
  await page.evaluate(() => {
    localStorage.setItem('sessions_v1', JSON.stringify([{
      id: 'nullshot', name: 'a hole in the string', date: '2026-08-13', type: 'Score',
      targetId: 'any', rangeYards: 100, rifleId: '', ammoId: '', ts: 1, matchId: null,
      shots: [null, { id: 'g1', ring: '10', clockH: 12, clockM: 0, xy: { x: 0, y: 0 }, elev: 0, wind: 0 }],
    }]));
  });
  await page.reload();
  await page.waitForTimeout(900);

  const body = await page.textContent('body');
  ok(/hit a bug and stopped/.test(body),
     'an unguarded corruption lands on the boundary instead of a white screen');
  ok(/still on this device/.test(body),
     '...saying the data is still there, which is the first thing anyone needs to know');

  /* The rescue has to work when React is dead, so it reads localStorage
   * directly. Assert the file actually comes out. */
  await page.evaluate(() => {
    window.__downloads = 0; window.__shared = null;
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) { window.__downloads++; return; }
      return click.apply(this, arguments);
    };
  });
  await page.click('button:has-text("Save my data")');
  await page.waitForTimeout(400);
  ok(await page.evaluate(() => window.__downloads) === 1,
     'and the rescue export produces a file from the crashed app');

  ok(await page.locator('button:has-text("Reload")').count() === 1,
     '...with a way back that is not "delete the app"');

  await page.evaluate(() => {
    localStorage.removeItem('sessions_v1'); localStorage.removeItem('ammo_v1');
  });
  await page.reload();
  await page.waitForTimeout(800);
  ok(!/hit a bug and stopped/.test(await page.textContent('body')),
     'and the app comes back once the bad record is gone');
}


await browser.close(); server.close(); await mock.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
