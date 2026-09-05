/* Bench → the shared schema, through the real UI and a mock backend.
 *
 * The claim under test is that a bench full of records arrives as something
 * Zero can actually read. Not "rows were written" — the specific shape Zero's
 * v_ballistic_profiles depends on: a product separate from its purchase, a
 * recipe pointing at both, a batch pointing at the recipe and its lots.
 */
import { chromium } from 'playwright';
/* Invitation-only since migration 0021: signed out, Bench paints a gate and
 * nothing else, so this suite could not reach the Cloud sync screen it is
 * about. It boots as an approved account instead. The gate itself is driven
 * from the outside in test-sync-ui.mjs. */
import { useBetaFixture } from '../../tools/test-beta-session.mjs';
import fsx from 'node:fs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startMock } from '../../packages/zero-core/mock-supabase.mjs';

const CHROME = '/opt/pw-browsers/chromium';
const LAUNCH_OPTS = fsx.existsSync(CHROME) ? { executablePath: CHROME } : {};

const mock = await startMock({ ttlSec: 3600 });

/* Build the way a deploy builds, with the backend baked in — pointed at this
 * run's mock. Bench hides the sync screen entirely when no backend is
 * configured, so testing against an unconfigured build would test nothing. */
execFileSync(process.execPath, [path.resolve('build.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, SUPABASE_URL: mock.url, SUPABASE_ANON_KEY: 'anon-key' },
});

const ROOT = path.resolve('dist');
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const section = (s) => console.log('\n' + s);

const browser = useBetaFixture(await chromium.launch(LAUNCH_OPTS), mock.issueSession('jaxon@example.com'));
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));

const rows = (t) => [...(mock.state.rows.get(t)?.values() || [])];

await page.goto(BASE);
await page.waitForTimeout(500);

/* A bench with one of everything, plus two deliberate problems. */
await page.evaluate(() => {
  DB.cartridges = [{ id: 'ca1', name: '6.5 Creedmoor' }];
  DB.firearms = [{ id: 'f1', name: 'Tikka T3x', cartridge: 'ca1', barrel: 24,
                   twist: '1:8', sightHeight: 1.75, zeroRange: 100 }];
  DB.componentLots = [
    { id: 'cl1', serial: 'C-1', kind: 'bullet', name: 'Berger 140gr Hybrid', lot: 'BG-0326',
      qty: 500, unit: 'ea', cost: 289, weightGr: 140, bcG1: 0.607, bcG7: 0.311 },
    { id: 'cl2', serial: 'C-2', kind: 'powder', name: 'Hodgdon H4350', lot: 'H-1177',
      qty: 8, unit: 'lb', cost: 311.2 },
    { id: 'cl3', serial: 'C-3', kind: 'primer', name: 'Fed GM210M', lot: 'GM-K3',
      qty: 1000, unit: 'ea', cost: 119.99 },
    // a second purchase of the SAME bullet: two lots, one product
    { id: 'cl4', serial: 'C-4', kind: 'bullet', name: 'Berger 140gr Hybrid', lot: 'BG-0417',
      qty: 500, unit: 'ea', cost: 305, weightGr: 140, bcG7: 0.311 },
    // problem 1: a bullet with no weight cannot become a product
    { id: 'cl5', serial: 'C-5', kind: 'bullet', name: 'Mystery 6.5', qty: 100, unit: 'ea', cost: 40 },
  ];
  DB.brassLots = [{ id: 'bl1', serial: 'R-7K2', marks: { neck: 'R', head: 'K' },
    cartridge: 'ca1', headstamp: 'LAPUA', maker: 'Lapua', initialQty: 200, qty: 196,
    firings: 1, expectedFirings: 8, cost: 239.98, origin: 'new', acquired: '2026-05-01',
    trimTo: 1.910, maxLength: 1.920, weightSort: '±0.5', annealEvery: 2,
    lastAnneal: null, retired: false, culls: [{ id: 'c1', n: 4, reason: 'sep', date: '2026-07-14' }] }];
  DB.recipes = [
    { id: 'r1', name: '6.5CM / 140 Hybrid / H4350', cartridge: 'ca1',
      bullet: 'Berger 140gr Hybrid', powder: 'Hodgdon H4350', primer: 'Fed GM210M',
      charge: 41.5, coal: 2.81, cbto: 2.245, source: 'Hodgdon 2024', page: '112', sourceMax: 43 },
    // problem 2: names a bullet no lot matches
    { id: 'r2', name: 'orphan load', cartridge: 'ca1', bullet: 'Sierra 142 MK',
      powder: 'Hodgdon H4350', primer: 'Fed GM210M', charge: 40, source: 'Sierra 6th' },
  ];
  DB.batches = [{ id: 'ba1', serial: 'B26H01-01F', recipe: 'r1', brassLot: 'bl1',
    bulletLot: 'cl1', powderLot: 'cl2', primerLot: 'cl3', date: '2026-08-01',
    qty: 100, adjust: [{ id: 'aj1', n: 50, reason: 'pulled', date: '2026-08-06' }],
    chargeActual: 41.52, chargeSd: 0.02, coalMean: 2.809, quarantine: false }];
  // 100 loaded, 10 fired, 50 pulled down -> 40 left. The server gets the
  // derived figure; there is no stored counter to disagree with it.
  DB.sessions = [{ id: 'se1', batch: 'ba1', firearm: 'f1', date: '2026-08-05',
    rounds: 10, distance: 100, vAvg: 2712, vSd: 7.4, vEs: 20, group: 0.42, temp: 72 }];
  save(); reset('more');
});
await page.waitForTimeout(200);

/* Contrast on the one form a user meets before they have any data.
 *
 * The input rule used to enumerate text/number/date and so missed email and
 * password -- the only two fields here. They fell back to a white browser
 * default while inheriting the app's near-white text, so the sign-in screen
 * was unreadable. It is the FIRST screen anyone sees, on a phone, often
 * outdoors, and it was the last one anything tested. */
const relLum = (c) => {
  const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
    const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [x, y] = [relLum(a), relLum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

section('the sync screen exists once a backend is configured');
ok((await page.textContent('#view')).includes('Cloud sync'),
   'Cloud sync appears in More when the build has a backend');
await page.click('button:has-text("Cloud sync")');
await page.waitForTimeout(300);
/* The legibility check on the credential fields moved to test-sync-ui.mjs.
 *
 * It used to run here on #sy-email and #sy-pw, which were on this screen while
 * signed out. Since the beta gate this suite cannot BE signed out -- the Cloud
 * sync screen is behind an approved account -- so those fields are never
 * rendered here and the assertion was checking two elements that do not exist.
 * The same fields are now the gate's, and that is where they are measured, on
 * the suite that actually visits them. `contrast` stays defined above: the
 * chip contrast assertions further down still use it. */

/* The account is already established, because since the beta gate there is no
   way to reach this screen without one. What is still worth asserting is that
   the screen knows whose it is -- everything below files records under that
   account and would be meaningless attributed to somebody else. */
ok((await page.textContent('#view')).includes('jaxon@example.com'), 'signed in');

section('a whole bench goes up');
await page.click('button:has-text("Sync now")');
await page.waitForTimeout(1500);
const body = await page.textContent('#view');
ok(/Sent \d+ record/.test(body), `the sync reports what it sent (${(body.match(/Sent [^.]*\./) || [])[0]})`);

ok(rows('firearms').length === 1, 'the firearm arrives');
ok(rows('brass_lots').length === 1, 'the brass lot arrives');
ok(rows('brass_lots')[0].marks?.neck === 'R',
   '...carrying its colour code, which is what makes the lot identifiable');
ok(rows('brass_lots')[0].qty_on_hand === 196 && rows('brass_lots')[0].qty_initial === 200,
   '...and both case counts, so the culls are reflected');
ok(rows('brass_lots')[0].trim_to_in === 1.910 && rows('brass_lots')[0].anneal_every === 2,
   "...and the lot's own prep spec, which is what a warning compares against");

section('a component lot becomes a product AND a purchase');
// This is the whole modelling difference. A recipe references the product; it
// is the purchase that runs out.
ok(rows('bullet_products').length === 1,
   `two purchases of one bullet are ONE product (${rows('bullet_products').length})`);
ok(rows('component_lots').filter(l => l.kind === 'bullet').length === 2,
   '...and two component lots');
ok(rows('bullet_products')[0].weight_gr === 140 && rows('bullet_products')[0].bc_g7 === 0.311,
   'the product carries the ballistics Zero needs');
const powderLot = rows('component_lots').find(l => l.kind === 'powder');
ok(powderLot.unit === 'lb' && powderLot.qty_purchased === 8,
   'powder keeps the unit it was bought in, so the number means something');
ok(powderLot.qty_remaining < 8,
   `...and reports what is actually left, not what was bought (${powderLot.qty_remaining})`);

section('the recipe points at products, not at strings');
const rec = rows('recipes')[0];
ok(rows('recipes').length === 1, 'the one resolvable recipe arrives');
ok(rec.bullet_id === rows('bullet_products')[0].id,
   'its bullet is a foreign key to the product, resolved from the free-text name');
ok(rec.powder_id && rec.primer_id, '...as are the powder and primer');
ok(rec.source_name === 'Hodgdon 2024' && rec.source_max_gr === 43,
   'the load-data citation travels, which is what makes over-max detectable');

section('the batch and its session');
const bat = rows('batches')[0];
ok(bat && bat.recipe_id === rec.id, 'the batch points at the recipe');
ok(bat.bullet_lot_id && bat.powder_lot_id && bat.primer_lot_id && bat.brass_lot_id,
   '...and at every lot that went into it, which is the point of the app');
ok(bat.qty_loaded === 100 && bat.qty_remaining === 40, 'round counts map');
ok(bat.charge_actual_gr === 41.52, 'the as-weighed charge maps, not just the recipe target');

const ses = rows('range_sessions')[0];
ok(ses && ses.batch_id === bat.id, 'the session points at the batch');
ok(ses.velocity_avg_fps === 2712 && ses.velocity_sd_fps === 7.4,
   'chronograph summaries are written directly — no shot string means no trigger to fight');
ok(ses.source_app === 'bench', 'the row records which app wrote it');
const grp = rows('groups')[0];
ok(grp && grp.group_es_in === 0.42 && grp.distance_yd === 100 && grp.shot_count === 10,
   'the group goes up in inches, at its distance');

section('what could not go, and why');
ok(body.includes('could not be represented'), 'the screen says some records did not go');
const notSent = await page.textContent('#view');
ok(/Mystery 6\.5/.test(notSent) && /bullet weight/.test(notSent),
   'a bullet with no weight is named, with the reason');
ok(/orphan load/.test(notSent) && /Sierra 142 MK/.test(notSent),
   'a recipe naming an unrecorded component is named, with the component');
ok(rows('recipes').length === 1,
   '...and neither was invented: the orphan recipe is absent rather than guessed at');
ok(rows('firearms').length === 1 && rows('batches').length === 1,
   'everything else still went — one bad record does not strand a bench');
await page.screenshot({ path: 'shots/09-sync.png', fullPage: true });

section('syncing twice does not duplicate');
await page.click('button:has-text("Sync now")');
await page.waitForTimeout(1500);
ok(rows('batches').length === 1 && rows('bullet_products').length === 1
   && rows('component_lots').length === 4 && rows('range_sessions').length === 1,
   'a second sync updates the same rows rather than adding more');

// The ids have to survive a reload, or the next sync mints new ones.
const before = rows('batches')[0].id;
await page.reload();
await page.waitForTimeout(700);
const kept = await page.evaluate(() => DB.batches[0].remote);
ok(kept === before, 'remote ids are persisted locally, so they survive a reload');

/* ============================================ the whole bench, to a second device */
/* The per-record sync above is lossy on purpose: it maps Bench's model onto
 * the schema Zero reads, so a component lot becomes two rows and a marking
 * scheme has no equivalent at all. None of that is a backup, and none of it
 * gets a new phone to the state the old one is in. This does. */
/* ==================================== the cursor actually moves, and only here */
/* The contract that bit: zero-core commits a table's cursor only when the apply
 * handler RETURNS something for it. Bench's handler computed its result and
 * forgot to return it, so every sync re-downloaded all seventeen tables from
 * 1970 and reported thousands of rows "pulled" that changed nothing. Nothing
 * failed — it just got slower forever, on a phone, on someone's data plan.
 *
 * Asserted two ways, because either alone is satisfiable by accident. */
section('the pull cursor');
{
  const cursors = await page.evaluate(() => CORE.cursors);
  ok(Object.keys(cursors).length > 0,
     `the sync moved at least one cursor (${Object.keys(cursors).join(', ') || 'none'})`);
  ok(!!cursors.firearms,
     'firearms — a table Bench has an inverse for — advanced');
  /* And the other half: a table Bench cannot apply must not be pulled at all,
   * let alone skipped past. The public leaderboard is the one that matters —
   * it grows with the whole customer base and is nobody's to hold locally. */
  ok(!cursors.leaderboard_entries,
     'the public leaderboard was never pulled, so there is no cursor for it');

  const before = { ...mock.state.hits.pull };
  await page.click('[data-act="tab"][data-arg="lookup"]');
  await page.waitForTimeout(150);
  await page.click('button[data-act="sySync"]');
  await page.waitForTimeout(1200);
  const touched = Object.keys(mock.state.hits.pull)
    .filter(t => (mock.state.hits.pull[t] || 0) > (before[t] || 0));
  ok(!touched.includes('leaderboard_entries') && !touched.includes('recipes'),
     `a second sync pulls only what Bench applies (${touched.join(', ') || 'nothing'})`);
}

const syncNow = async () => {
  await page.click('[data-act="tab"][data-arg="lookup"]');
  await page.waitForTimeout(150);
  await page.click('button[data-act="sySync"]');
  await page.waitForTimeout(1200);
};

/* ================= the ammo count is current, not one range trip behind */
/* `batches.qty_remaining` is DERIVED from the sessions on the batch, and the
 * push runs before the pull. So every sync sent a figure computed from the
 * sessions this device knew about a moment before it learned about more, and
 * only corrected it on the NEXT sync.
 *
 * Zero reads that column through v_ballistic_profiles and prints it on the load
 * card, so the number a shooter saw was one range trip behind every time they
 * looked at it: fire 40 rounds in Zero, open Bench, tap sync — and the count
 * goes back UP to what it was before the trip. It only reads true after a
 * second sync with no shooting in between, which is not how anyone uses it. */
section('a range trip pulled in is reflected in the count that goes back up');
{
  const userId = rows('firearms')[0].user_id;
  const batchRemote = await page.evaluate(() => DB.batches[0].remote);
  const before = rows('batches').find(b => b.id === batchRemote);
  ok(!!before, 'the batch is on the server to begin with');
  const loaded = before.qty_loaded;

  // Zero logs a range trip against that batch, on another device.
  mock.advance(60_000);
  mock.seed('range_sessions', { id: 'ffffffff-6666-4666-8666-ffffffffffff', user_id: userId,
    batch_id: batchRemote, occurred_on: '2026-08-05', rounds_fired: 12, source_app: 'zero' });

  await syncNow();

  const after = rows('batches').find(b => b.id === batchRemote);
  const localLeft = await page.evaluate(() => roundsLeft(DB.batches[0]));
  ok(localLeft < loaded,
     `Bench itself knows the rounds are gone (${localLeft} of ${loaded})`);
  ok(after.qty_remaining === localLeft,
     `and the server carries the SAME number in the same sync (${after.qty_remaining} vs ${localLeft})`);

  /* The shape of the old bug, stated as its own assertion: the figure on the
   * server must not still be the pre-trip one. */
  ok(after.qty_remaining !== before.qty_remaining,
     `...rather than the count from before the trip (${before.qty_remaining})`);

  // And an ordinary sync that pulls nothing does not pay for a second round trip.
  const pushesBefore = mock.state.hits.push.batches || 0;
  await syncNow();
  ok((mock.state.hits.push.batches || 0) - pushesBefore <= 1,
     'a sync that pulls nothing new still costs one push, not two');
}

/* ============================ a session Bench cannot file must not be skipped past */
/* The half the fix above hid. Bench's readers return a stat object whether or
 * not they kept anything, and they routinely keep nothing: a range session
 * whose batch this device has never had hits `if (!batch) continue`, because
 * Bench files every session under the batch it was fired with and there is
 * nowhere else to put one. The cursor advanced over those rows PERMANENTLY.
 * Load that batch onto this phone tomorrow — restore a backup, sync from the
 * other device — and the sessions fired with it are already behind the cursor.
 * They are on the server. This device is simply never offered them again.
 *
 * Both directions are asserted, because the hold is only interesting if the
 * ordinary case still runs at full speed. */
section('a pulled session Bench cannot place holds the cursor');
{
  const userId = rows('firearms')[0].user_id;
  const knownBatch = await page.evaluate(() => DB.batches[0].remote);

  // --- the ordinary case: a session for a batch this device HAS ---
  mock.advance(60_000);
  const okStamp = new Date(mock.state.clock).toISOString();
  mock.seed('range_sessions', { id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', user_id: userId,
    batch_id: knownBatch, occurred_on: '2026-08-01', rounds_fired: 20, source_app: 'zero' });
  await syncNow();
  ok(await page.evaluate(() => CORE.cursors.range_sessions) === okStamp,
     'a session whose batch is here is filed and the cursor moves to it');
  ok(!await page.evaluate(() => CORE.floors.range_sessions),
     '...with nothing held back — the ordinary case still runs at full speed');

  // --- the case that was silently dropped: a batch this device has never had ---
  mock.advance(60_000);
  const heldStamp = new Date(mock.state.clock).toISOString();
  mock.seed('range_sessions', { id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', user_id: userId,
    batch_id: 'cccccccc-3333-4333-8333-cccccccccccc', occurred_on: '2026-08-02',
    rounds_fired: 40, source_app: 'zero' });
  await syncNow();

  const floor = await page.evaluate(() => CORE.floors.range_sessions);
  ok(floor && floor.at === heldStamp,
     `the unplaceable session is held rather than dropped (${floor ? floor.at : 'not held'})`);
  ok(await page.evaluate(() => CORE.cursors.range_sessions) < heldStamp,
     '...and the cursor stops below it, so it is still owed to this device');

  /* The proof that "still owed" means something: it comes back down the wire
   * on the next sync rather than living only on the server. */
  const beforePull = mock.state.hits.pull.range_sessions || 0;
  await syncNow();
  ok((mock.state.hits.pull.range_sessions || 0) > beforePull
     && await page.evaluate(() => CORE.cursors.range_sessions) < heldStamp,
     'it is offered again on the sync after that, and again held');
}

section('cloud backup');
const openData = async () => {
  await page.click('[data-act="tab"][data-arg="more"]');
  await page.waitForTimeout(200);
  await page.click('[data-act="nav"][data-arg="data"]');
  await page.waitForTimeout(500);
};
await openData();
ok((await page.textContent('#view')).includes('Cloud backup'),
   'the backup card is on the data screen, beside the file export');

await page.click('button[data-act="cbUp"]');
await page.waitForTimeout(900);
ok(/Backed up/.test(await page.textContent('#view')), 'one tap puts the whole bench up');
const backups = rows('account_backups');
ok(backups.length === 1 && backups[0].app === 'bench',
   `one row holds it, labelled as Bench's (${backups.length})`);
const snap = JSON.parse(backups[0].payload || '{}');
ok((snap.brassLots || []).length === 1 && (snap.componentLots || []).length === 5,
   "it is Bench's own JSON — every lot, including the one the shared schema refused");
ok(snap.recipes && snap.recipes.length === 2,
   '...and the orphan recipe the sync could not represent, which is exactly what a backup is for');

/* A second device: same account, empty bench, plus one lot loaded here that
 * the backup has never seen. */
await page.evaluate(() => {
  const keep = localStorage.getItem('zerocore.session');
  localStorage.clear();
  if (keep) localStorage.setItem('zerocore.session', keep);
});
await page.reload();
await page.waitForTimeout(700);
await page.evaluate(() => {
  DB.componentLots = [{ id: 'local1', serial: 'C-9', kind: 'primer', name: 'CCI BR2',
    lot: 'L-1', qty: 1000, unit: 'ea', cost: 99 }];
  save();
});
await openData();
await page.click('button[data-act="cbMerge"]');
await page.waitForTimeout(900);

const merged = await page.evaluate(() => ({
  lots: DB.componentLots.map(l => l.id),
  brass: DB.brassLots.length, recipes: DB.recipes.length, batches: DB.batches.length,
  scheme: DB.meta && DB.meta.scheme ? Object.keys(DB.meta.scheme).length : 0,
}));
ok(merged.brass === 1 && merged.recipes === 2 && merged.batches === 1,
   'the bench comes down onto the second device');
ok(merged.lots.includes('local1'),
   '...without taking the lot that was only on this device — restore adds, it does not replace');
ok(merged.lots.filter(x => x === 'cl1').length === 1, '...and does not duplicate what it brought');

await page.click('button[data-act="cbMerge"]');
await page.waitForTimeout(800);
const again = await page.evaluate(() => DB.componentLots.length);
ok(again === merged.lots.length, `restoring twice changes nothing (${again} lots)`);
ok(/Already up to date/.test(await page.textContent('#view')),
   '...and says so rather than claiming to have restored again');

/* ================== one remote row, two local ids, and a restore between them */
/* The union was on the LOCAL id, and a local id is minted by whichever device
 * first saw the record. A record that arrived over the per-record sync is
 * minted fresh on each device -- `{ id: helpers.uid('se'), remote: row.id }` in
 * sync.js -- so one Zero range session is `se8bikre2` on the tablet and
 * `ser5iirkc` on the phone. Two ids, one row. Restore the phone's backup onto
 * the tablet and the union saw two strangers and kept both.
 *
 * Not a cosmetic duplicate: rounds fired and brass wear are SUMS over the
 * sessions on a batch, so a box of 100 with 20 fired read 60 left instead of
 * 80, and the brass read twice the firings it had -- and brass wear is the
 * number the retire warning is built on. Nothing healed it either: a later
 * sync updates only the first match by remote id, and the duplicate carries
 * mtime 0 so it is never pushed. Silent, local, permanent. */
section('a session that came down the sync, restored from another device');
{
  const REMOTE = 'dddddddd-4444-4444-8444-dddddddddddd';
  const OTHER  = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
  const seed = (localId) => page.evaluate(({ localId, REMOTE, OTHER }) => {
    DB.batches = [{ id: 'ba_dup', serial: 'B26H01-01A', recipe: null, qty: 100,
                    date: '2026-08-01', mtime: 0, syncedAt: Date.now() }];
    DB.sessions = [
      { id: localId, remote: REMOTE, batch: 'ba_dup', date: '2026-08-02', rounds: 20,
        mtime: 0, syncedAt: Date.now() },
      // A control that must still cross: a different row, not just a different id.
      ...(localId === 'seA'
        ? [{ id: 'seOnlyThere', remote: OTHER, batch: 'ba_dup', date: '2026-08-03',
             rounds: 5, mtime: 0, syncedAt: Date.now() }]
        : []),
    ];
    save();
  }, { localId, REMOTE, OTHER });

  // The other device backs up, holding the row under ITS local id.
  await seed('seA');
  await openData();
  await page.click('button[data-act="cbUp"]');
  await page.waitForTimeout(900);

  // This device holds the same remote row under a local id of its own.
  await page.evaluate(() => {
    const keep = localStorage.getItem('zerocore.session');
    localStorage.clear();
    if (keep) localStorage.setItem('zerocore.session', keep);
  });
  await page.reload();
  await page.waitForTimeout(700);
  await seed('seB');

  await openData();
  await page.click('button[data-act="cbMerge"]');
  await page.waitForTimeout(900);

  const after = await page.evaluate(() => ({
    ids: DB.sessions.map(s => s.id),
    remotes: DB.sessions.map(s => s.remote),
    fired: roundsFired(DB.batches[0]),
    left: roundsLeft(DB.batches[0]),
  }));
  ok(after.remotes.filter(r => r === REMOTE).length === 1,
     `the same remote row arrives under a different local id and is recognised (${after.ids.join(', ')})`);
  ok(after.ids.includes('seB') && !after.ids.includes('seA'),
     '...with the local copy kept, which is the rule the restore has always followed');
  ok(after.fired === 25 && after.left === 75,
     `so the rounds fired are counted once (${after.fired} fired, ${after.left} left of 100)`);
  /* The control, without which the fix could be "drop everything": a row this
   * device genuinely has not seen still crosses. */
  ok(after.remotes.includes(OTHER),
     '...while a row this device has never seen still comes down');
}

/* ========================== erasing the bench erases what says it was delivered */
/* "Erase all data" removed Bench's own record store and nothing else, which
 * made it the exact wrong move for the user most likely to press it. The pull
 * cursor survived, still claiming every row on the server had already been
 * delivered here -- so the next sync brought back nothing and the app sat empty
 * against a full account, with the nuclear option already spent.
 *
 * Erasing the local copy is a statement that nothing here is delivered any
 * more. The cursor has to agree. */
section('erase all data, then sync');
{
  const before = await page.evaluate(() => Object.keys(CORE.cursors).length);
  ok(before > 0, `there is a cursor to lose (${before} tables)`);

  page.once('dialog', d => d.accept());
  await page.click('[data-act="tab"][data-arg="more"]');
  await page.waitForTimeout(200);
  await page.click('[data-act="nav"][data-arg="data"]');
  await page.waitForTimeout(400);
  await page.click('button[data-act="wipe"]');
  await page.waitForTimeout(500);

  ok(await page.evaluate(() => DB.batches.length + DB.brassLots.length) === 0,
     'the bench is erased');
  ok(await page.evaluate(() => Object.keys(CORE.cursors).length) === 0,
     '...and so is the cursor, so the account can be pulled down again');
  ok(await page.evaluate(() => CORE.isSignedIn()),
     '...while the sign-in stands — erasing the bench is not signing out');

  await syncNow();
  ok(await page.evaluate(() => DB.firearms.length) > 0,
     'and the next sync brings the account back rather than finding nothing to do');
}

section('hygiene');
ok(errors.length === 0, 'no JS errors' + (errors.length ? ' — ' + errors.slice(0, 3).join(' | ') : ''));

await browser.close(); server.close(); await mock.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
