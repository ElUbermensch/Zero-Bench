/* End-to-end tests against the built PWA, served over HTTP because that is how
 * it ships: file:// gives a null origin, no service worker, and unrepresentative
 * storage behaviour. */
import { chromium } from 'playwright';
/* Use the preinstalled browser when present (this dev sandbox sets
 * PLAYWRIGHT_BROWSERS_PATH); otherwise fall back to whatever Playwright
 * installed, which is what CI and a normal checkout will have. */
import fsx from 'node:fs';
const CHROME = '/opt/pw-browsers/chromium';
const LAUNCH_OPTS = fsx.existsSync(CHROME) ? { executablePath: CHROME } : {};
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml' };

/* Bench deploys to /bench/, not to the root, so the harness serves it there.
 * Serving it at / would test a layout that is never shipped -- and the things
 * that break in a subdirectory (an absolute path in the shell, a manifest
 * scope, a service worker's reach) are exactly the things that look fine at
 * the root. */
const PREFIX = '/bench/';
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (!p.startsWith(PREFIX)) { res.writeHead(404); return res.end('outside /bench/'); }
  p = p.slice(PREFIX.length - 1);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('nope');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
const BASE = ORIGIN + PREFIX;

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const section = (s) => console.log('\n' + s);

const browser = await chromium.launch(LAUNCH_OPTS);
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

fs.mkdirSync('shots', { recursive: true });
const shot = (n) => page.screenshot({ path: `shots/${n}.png`, fullPage: true });

const tapText = async (text) => {
  const el = page.locator(`button:has-text("${text}")`).first();
  await el.click();
  await page.waitForTimeout(140);
};
const fill = async (name, value) => {
  await page.fill(`[name="${name}"]`, String(value));
};
const submit = async () => { await page.click('#frm button[type=submit]'); await page.waitForTimeout(200); };
/* Destructive actions take two taps -- see the confirmation test below. Tests
 * that are about what a delete DOES, rather than about the asking, go through
 * here so the confirmation is exercised everywhere without being restated. */
const destroy = async (selector) => {
  await page.click(selector);
  await page.waitForTimeout(160);
  await page.click(selector);
  await page.waitForTimeout(250);
};

await page.goto(BASE);
await page.waitForTimeout(400);

/* ================================================================= empty */

/* Firing is a session now, not a counter. `fire(batchId, n)` records one, which
 * is what actually moves rounds out of a box and wear onto the brass. */
const fire = (bid, n) => page.evaluate(([b, r]) => {
  DB.sessions.push({ id: 'se' + Math.random().toString(36).slice(2, 8), batch: b,
    date: '2026-08-10', rounds: r, distance: 100, pressureSigns: 'none' });
  save();
}, [bid, n]);
const unfire = (bid) => page.evaluate((b) => {
  DB.sessions = DB.sessions.filter(s => s.batch !== b); save();
}, bid);

section('starts empty');
{
  const db = await page.evaluate(() => DB);
  const total = ['cartridges', 'firearms', 'componentLots', 'brassLots', 'recipes', 'batches', 'sessions']
    .reduce((n, k) => n + db[k].length, 0);
  ok(total === 0, 'no records of any kind on a fresh install');
  const lookupTxt = await page.textContent('#view');
  ok(lookupTxt.includes('No brass lots recorded yet') && lookupTxt.includes('By serial'),
     'the Identify screen renders an honest empty state, not a picker over nothing');
  await shot('01-empty');

  // every tab must render without data
  for (const t of ['brass', 'ammo', 'more']) {
    await page.click(`[data-act="tab"][data-arg="${t}"]`);
    await page.waitForTimeout(150);
    const len = (await page.innerHTML('#view')).length;
    ok(len > 50, `the ${t} tab renders when empty`);
  }
  for (const v of ['inventory', 'recipes', 'firearms', 'settings', 'data']) {
    await page.evaluate(x => reset(x), v);
    await page.waitForTimeout(120);
    ok((await page.innerHTML('#view')).length > 50, `the ${v} page renders when empty`);
  }
  await shot('02-empty-ammo');
}

/* ================================================= one route per destination */
section('navigation');
{
  // Count every element in the whole app that opens each creation form.
  const routes = await page.evaluate(() => {
    const views = ['lookup', 'brass', 'ammo', 'more', 'inventory', 'recipes',
                   'firearms', 'settings', 'data'];
    const counts = {};
    for (const v of views) {
      reset(v);
      document.querySelectorAll('#view [data-act="new"]').forEach(el => {
        counts[el.dataset.arg] = (counts[el.dataset.arg] || 0) + 1;
      });
    }
    return counts;
  });
  const dupes = Object.entries(routes).filter(([, n]) => n > 1);
  ok(dupes.length === 0,
     'each creation form has exactly one entry point' + (dupes.length ? ' — ' + JSON.stringify(dupes) : ''));
  ok(Object.keys(routes).sort().join(',') === 'brass,component,firearm,recipe',
     `creation routes reachable from an empty install (${Object.keys(routes).sort().join(',')})`);
  ok(!(await page.evaluate(() => reset('ammo'))) &&
     !(await page.locator('[data-act="new"][data-arg="batch"]').count()),
     'New batch is withheld until a recipe exists, rather than opening a form that cannot be completed');

  const tabs = await page.locator('nav.tabs button').count();
  ok(tabs === 4, 'four tabs, no separate Add tab duplicating the list buttons');
}

/* ==================================================== cartridges, free text */
section('cartridges');
{
  await page.evaluate(() => reset('firearms'));
  await page.waitForTimeout(120);
  await tapText('New firearm');
  await fill('name', 'Bolt gun 24in');
  // with nothing recorded, the only option is to add one
  await fill('cartridge__new', '6.5 Creedmoor');
  await fill('barrel', '24');
  await fill('twist', '1:8');
  await fill('sightHeight', '1.75');
  await fill('zeroRange', '100');
  await submit();
  const carts = await page.evaluate(() => DB.cartridges.map(c => c.name));
  ok(carts.length === 1 && carts[0] === '6.5 Creedmoor', 'free text creates the cartridge');
  await shot('03-firearm-saved');

  // second firearm: the cartridge now appears as a choice
  await tapText('New firearm');
  const opts = await page.locator('[name="cartridge"] option').allTextContents();
  ok(opts.some(o => o.includes('6.5 Creedmoor')), 'an existing cartridge is offered in the list');
  ok(opts.some(o => o.includes('Add new cartridge')), '...alongside an option to add another');

  // choosing "add new" reveals the free-text field
  await page.selectOption('[name="cartridge"]', '__new');
  await page.waitForTimeout(150);
  const shown = await page.locator('[name="cartridge__new"]').isVisible();
  ok(shown, 'selecting "add new" reveals the free-text field');

  await fill('name', 'AR-15');
  await fill('cartridge__new', '.223 Remington');
  await submit();
  ok((await page.evaluate(() => DB.cartridges.length)) === 2, 'the second cartridge is added');

  // duplicates differing only in case and spacing must not create a new record
  await tapText('New firearm');
  await page.selectOption('[name="cartridge"]', '__new');
  await page.waitForTimeout(120);
  await fill('name', 'Dupe test');
  await fill('cartridge__new', '  6.5   CREEDMOOR ');
  await submit();
  const after = await page.evaluate(() => DB.cartridges.map(c => c.name));
  ok(after.length === 2, `case and spacing variants reuse the existing cartridge (${after.join(' | ')})`);
}

/* ============================================== the case is the right shape */
/* The drawing used to be one hardcoded silhouette with a flange standing proud
 * at the head -- a RIMMED case. Almost nothing a precision shooter loads is
 * rimmed; a bottleneck rifle case is rimless, with an extractor groove cut in
 * ahead of a head the same diameter as the body. The picture is held against
 * a real case, so being wrong about that is the one thing it cannot be. */
section('a case is drawn as the case it actually is');
{
  const geo = await page.evaluate(() => ({
    def: caseGeom(null),
    rimmed: caseGeom({ shape: 'bottleneck', head: 'rimmed' }),
    belted: caseGeom({ shape: 'bottleneck', head: 'belted' }),
    straight: caseGeom({ shape: 'straight', head: 'rimless' }),
  }));

  ok(geo.def.head === 'rimless' && geo.def.shape === 'bottleneck',
     'the default is a rimless bottleneck, which is what almost everything is');

  /* The groove is the whole point: an indent, drawn by stepping the outline IN
   * to a smaller diameter and back out, rather than a flange stepping out. */
  ok(/L226,24 L240,24/.test(geo.def.path),
     'a rimless case has an extractor groove cut into its outline');
  ok(!/,11 /.test(geo.def.path) && !/,77/.test(geo.def.path),
     '...and nothing standing proud of the body');
  ok(geo.def.baseY0 === 17 && geo.def.baseY1 === 71,
     'its head is the same diameter as its body');

  ok(/L242,11/.test(geo.rimmed.path) && geo.rimmed.baseY0 === 11,
     'a rimmed case has a flange standing proud instead');
  ok(geo.rimmed.sepAt === 242, '...with a line where the flange meets the body');
  ok(geo.def.sepAt === null, 'a rimless case needs no such line — the groove is the break');

  ok(/L208,14 L224,14/.test(geo.belted.path), 'a belted case has a belt ahead of its groove');
  ok(/L224,24 L238,24/.test(geo.belted.path), '...and still has the groove');

  ok(!/L78,28/.test(geo.straight.path), 'a straight-walled case has no neck');
  ok(/^M40,17/.test(geo.straight.path), '...its body runs full diameter to the mouth');

  /* Marks must not be painted over a groove or a belt: a band there is a band
   * that cannot exist on the real case. */
  ok(geo.def.bandX1 < 226 && geo.belted.bandX1 < 208,
     `the markable body stops short of the head features (${geo.def.bandX1}, ${geo.belted.bandX1})`);

  const drawn = await page.evaluate(() => [
    caseSvg({}, { cart: { shape: 'bottleneck', head: 'rimmed' } }),
    caseSvg({}, { cart: { shape: 'straight', head: 'belted' } }),
  ]);
  ok(/data-head="rimmed"/.test(drawn[0]) && /data-shape="straight"/.test(drawn[1]),
     'the drawing reports what it drew, so a screenshot is checkable');
}

/* ============================ choosing the case shape when naming a cartridge */
section('a new cartridge carries its case shape');
{
  await page.evaluate(() => reset('firearms'));
  await page.waitForTimeout(150);
  await tapText('New firearm');
  await page.waitForTimeout(200);

  // The controls appear with the free-text box, because they belong to the
  // act of creating one rather than to picking an existing one.
  await page.selectOption('[name="cartridge"]', '__new');
  await page.waitForTimeout(150);
  ok(await page.locator('[name="cartridge__shape"]').isVisible(),
     'naming a new cartridge offers its case shape');
  ok(await page.locator('[name="cartridge__head"]').isVisible(), '...and its head');

  await fill('name', 'Lee Enfield');
  await fill('cartridge__new', '.303 British');
  await page.selectOption('[name="cartridge__shape"]', 'bottleneck');
  await page.selectOption('[name="cartridge__head"]', 'rimmed');
  await submit();
  await page.waitForTimeout(200);

  const saved = await page.evaluate(() =>
    DB.cartridges.find(c => c.name === '.303 British'));
  ok(saved && saved.head === 'rimmed' && saved.shape === 'bottleneck',
     `the cartridge records what was chosen (${saved && saved.shape}/${saved && saved.head})`);

  /* Re-typing an existing name REFERS to it. Silently restyling every brass
   * lot in .303 British because someone left the default selected is not
   * something a text field should be able to do. */
  const idBefore = saved.id;
  await tapText('New firearm');
  await page.waitForTimeout(200);
  await page.selectOption('[name="cartridge"]', '__new');
  await page.waitForTimeout(120);
  await fill('name', 'Second Enfield');
  await fill('cartridge__new', '.303 british');
  await page.selectOption('[name="cartridge__head"]', 'rimless');
  await submit();
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => DB.cartridges.filter(c => /303/i.test(c.name)));
  ok(after.length === 1 && after[0].id === idBefore, 'the name resolves to the same cartridge');
  ok(after[0].head === 'rimmed', '...and its case shape is not overwritten by the default');
}

/* ================================= and an existing cartridge can be corrected */
section('the cartridges already recorded can be given a shape');
{
  await page.click('[data-act="tab"][data-arg="more"]');
  await page.waitForTimeout(150);
  ok((await page.textContent('#view')).includes('Cartridges'),
     'More lists the cartridges — the feature is useless if it only applies to new ones');
  await page.click('[data-act="nav"][data-arg="cartridges"]');
  await page.waitForTimeout(250);

  const sel = page.locator('[data-act="cartHead"]').first();
  await sel.selectOption('belted');
  await page.waitForTimeout(250);
  const head = await page.evaluate(() => DB.cartridges[0].head);
  ok(head === 'belted', 'changing it saves immediately');
  const shown = await page.locator('svg.case').first().getAttribute('data-head');
  ok(shown === 'belted', '...and the drawing on the same screen redraws to match');
}

/* ======================================================== editing a firearm */
/* A firearm was the one record with no way back into it. Everything about it
 * is the kind of thing that gets corrected -- a scope swap changes the sight
 * height, a rebarrel changes the twist -- and the only route was delete and
 * retype, which is also the route that loses the shared id and the sessions
 * attributed to it. */
section('a firearm can be corrected');
{
  await page.evaluate(() => reset('firearms'));
  await page.waitForTimeout(150);

  const before = await page.evaluate(() => DB.firearms.length);
  ok(await page.locator('[data-act="edit"][data-kind="firearm"]').first().isVisible(),
     'every firearm offers an Edit button');

  await page.click('[data-act="edit"][data-kind="firearm"]');
  await page.waitForTimeout(200);
  const prefilled = await page.inputValue('[name="name"]');
  ok(prefilled.length > 0, `the form opens pre-filled, not blank (${prefilled})`);
  const sh = await page.inputValue('[name="sightHeight"]');
  ok(sh === '1.75', `...including the numbers (sight height ${sh})`);

  await fill('name', 'Bolt gun, rebarrelled');
  await fill('twist', '1:7.5');
  await submit();
  await page.waitForTimeout(200);

  const rec = await page.evaluate(() =>
    DB.firearms.map(f => ({ name: f.name, twist: f.twist, sight: f.sightHeight })));
  ok(rec.some(f => f.name === 'Bolt gun, rebarrelled' && f.twist === '1:7.5'),
     'the edit is saved');
  ok((await page.evaluate(() => DB.firearms.length)) === before,
     'as an edit, not a second firearm');
  ok(rec.some(f => f.sight === 1.75 || f.sight === '1.75'),
     'fields the form did not touch are untouched');

  /* An edit has to mark the record dirty or it will never be pushed: the
   * sync only sends what changed here since the last agreement. */
  const stamped = await page.evaluate(() =>
    DB.firearms.some(f => f.name === 'Bolt gun, rebarrelled' && f.mtime > 0));
  ok(stamped, 'and stamps a local modification time, so the sync will carry it');
}

/* ==================================================== deleting takes two taps */
section('a delete asks first');
{
  await page.evaluate(() => reset('firearms'));
  await page.waitForTimeout(150);
  const before = await page.evaluate(() => DB.firearms.length);

  const del = page.locator('[data-act="delFirearm"]').first();
  const label = await del.textContent();
  await del.click();
  await page.waitForTimeout(200);

  ok((await page.evaluate(() => DB.firearms.length)) === before,
     'the first tap deletes nothing');
  const armed = await page.locator('[data-act="delFirearm"]').first().textContent();
  ok(armed !== label && /again/i.test(armed),
     `the button changes to say what the next tap does (${label.trim()} → ${armed.trim()})`);

  await page.locator('[data-act="delFirearm"]').first().click();
  await page.waitForTimeout(250);
  ok((await page.evaluate(() => DB.firearms.length)) === before - 1,
     'the second tap deletes');

  /* Leaving the screen must disarm it. A confirmation that survives a
   * navigation is a delete waiting for an unrelated tap in the same place. */
  const remaining = await page.evaluate(() => DB.firearms.length);
  if (remaining > 0) {
    await page.locator('[data-act="delFirearm"]').first().click();
    await page.waitForTimeout(150);
    await page.click('[data-act="tab"][data-arg="lookup"]');
    await page.waitForTimeout(150);
    await page.click('[data-act="tab"][data-arg="more"]');
    await page.click('[data-act="nav"][data-arg="firearms"]');
    await page.waitForTimeout(200);
    const back = await page.locator('[data-act="delFirearm"]').first().textContent();
    ok(!/again/i.test(back), 'walking away disarms it');
    ok((await page.evaluate(() => DB.firearms.length)) === remaining,
       '...and nothing was deleted on the way');
  }
}

/* ============================================================ full workflow */
section('workflow');
{
  await page.evaluate(() => reset('inventory'));
  await page.waitForTimeout(120);
  for (const c of [
    { kind: 'bullet', name: 'Berger 140gr Hybrid', lot: 'BG-0326', qty: 500, cost: 289, extra: true },
    { kind: 'powder', name: 'H4350', lot: 'H-1177', qty: 8, cost: 311.2, unit: 'lb' },
    { kind: 'primer', name: 'Fed GM210M', lot: 'GM-K3', qty: 1000, cost: 119.99 },
  ]) {
    await tapText('New component lot');
    await page.selectOption('[name="kind"]', c.kind);
    await page.waitForTimeout(160);
    await fill('name', c.name); await fill('lot', c.lot);
    await fill('qty', c.qty); await fill('cost', c.cost);
    if (c.unit) await page.selectOption('[name="unit"]', c.unit);
    if (c.extra) { await fill('weightGr', 140); await fill('bcG7', 0.311); }
    await submit();
  }
  ok((await page.evaluate(() => DB.componentLots.length)) === 3, 'three component lots recorded');
  ok((await page.evaluate(() => DB.componentLots.find(c => c.kind === 'bullet').bcG7)) === 0.311,
     'bullet-only fields appear for bullets and are saved');
  await shot('04-inventory');

  await page.evaluate(() => reset('recipes'));
  await page.waitForTimeout(120);
  await tapText('New recipe');
  await fill('name', '6.5CM / 140 Hybrid / H4350');
  await fill('bullet', 'Berger 140gr Hybrid');
  await fill('powder', 'H4350');
  await fill('primer', 'Fed GM210M');
  await fill('charge', '41.5');
  await fill('coal', '2.810');
  await fill('source', 'Hodgdon online');
  await fill('sourceMax', '42.0');
  await submit();
  ok((await page.evaluate(() => DB.recipes.length)) === 1, 'recipe saved');

  // the source citation is mandatory
  await tapText('New recipe');
  await fill('name', 'uncited'); await fill('bullet', 'x'); await fill('powder', 'y');
  await fill('primer', 'z'); await fill('charge', '40');
  await submit();
  ok((await page.textContent('#view')).includes('required'),
     'a recipe without a load-data source is refused');
  ok((await page.evaluate(() => DB.recipes.length)) === 1, '...and is not saved');
  await page.click('#back'); await page.waitForTimeout(150);

  await page.evaluate(() => reset('brass'));
  await page.waitForTimeout(120);
  await tapText('New brass lot');
  await page.click('[data-act="markpick"][data-pos="neck"][data-val="R"]');
  await page.waitForTimeout(120);
  await page.click('[data-act="markpick"][data-pos="head"][data-val="K"]');
  await page.waitForTimeout(120);
  await fill('headstamp', 'LAPUA'); await fill('maker', 'Lapua');
  await fill('initialQty', '100'); await fill('expectedFirings', '12');
  await fill('cost', '119.99');
  await submit();
  const brass = await page.evaluate(() => DB.brassLots[0]);
  ok(brass && brass.serial && brass.serial.startsWith('R-'), `brass lot issued a serial (${brass && brass.serial})`);
  ok(brass.marks.neck === 'R' && brass.marks.head === 'K', 'the colour code is stored');
  await shot('05-brass-detail');

  // duplicate colour code must be refused
  await page.evaluate(() => reset('brass'));
  await page.waitForTimeout(120);
  await tapText('New brass lot');
  await page.click('[data-act="markpick"][data-pos="neck"][data-val="R"]');
  await page.waitForTimeout(100);
  await page.click('[data-act="markpick"][data-pos="head"][data-val="K"]');
  await page.waitForTimeout(150);
  ok((await page.textContent('#view')).includes('Already used by'), 'a duplicate colour code is flagged');
  await fill('headstamp', 'dupe');
  await submit();
  ok((await page.evaluate(() => DB.brassLots.length)) === 1, '...and cannot be saved');
  await page.click('#back'); await page.waitForTimeout(150);

  await page.evaluate(() => reset('ammo'));
  await page.waitForTimeout(120);
  await tapText('New batch');
  await fill('qty', '60'); await fill('chargeActual', '41.52'); await fill('coalMean', '2.809');
  await submit();
  const batch = await page.evaluate(() => DB.batches[0]);
  ok(batch && /^B\d{2}[A-N]\d{2}-\d{2}.$/.test(batch.serial), `batch issued a serial (${batch && batch.serial})`);
  ok((await page.textContent('#view')).includes('Untested'), 'a new batch is flagged untested');
  await shot('06-batch');

  const cost = await page.evaluate(() => costPerRound(DB.batches[0]));
  // 289/500 + (311.2/(8*7000))*41.52 + 119.99/1000 + 119.99/(100*12)
  const expect = 289 / 500 + (311.2 / (8 * 7000)) * 41.52 + 119.99 / 1000 + 119.99 / (100 * 12);
  ok(Math.abs(cost.total - expect) < 1e-9, `cost per round computes exactly ($${cost.total.toFixed(4)})`);

  await tapText('Log range session');
  await fill('vAvg', '2712'); await fill('vSd', '6.1'); await fill('vEs', '17');
  await fill('group', '0.42'); await fill('rounds', '10');
  await submit();
  ok(!(await page.textContent('#view')).includes('Untested'), 'logging a session clears the untested flag');
  ok((await page.evaluate(() => roundsLeft(DB.batches[0]))) === 50,
     'rounds remaining is the loaded count less what the session fired');
}

/* ==================================== components actually leave the shelf */
section('loading a batch draws down the components');
{
  // State from the workflow above: 500 bullets, 8 lb H4350, 1000 primers,
  // 100 Lapua cases, and one 60-round batch at 41.52gr already loaded.
  const st = await page.evaluate(() => {
    const at = k => DB.componentLots.find(c => c.kind === k);
    return {
      bullets: lotLeft(at('bullet')), primers: lotLeft(at('primer')),
      powderLb: lotLeft(at('powder')),
      cases: brassAvailable(DB.brassLots[0]),
      committed: brassCommitted(DB.brassLots[0]),
    };
  });
  ok(st.bullets === 440, `60 rounds took 60 bullets off 500 (${st.bullets} left)`);
  ok(st.primers === 940, `...and 60 primers off 1000 (${st.primers} left)`);
  // 60 x 41.52gr = 2491.2gr = 0.35588... lb
  const expectLb = 8 - (60 * 41.52) / 7000;
  ok(Math.abs(st.powderLb - expectLb) < 1e-9,
     `...and 2491gr of powder, converted into the lot's pounds (${st.powderLb.toFixed(4)} lb left)`);
  // 60 were loaded and a session above fired 10 of them, so 50 are still
  // sitting loaded and 50 cases are free -- the 40 never used plus the 10 back.
  ok(st.committed === 50 && st.cases === 50,
     'cases are COMMITTED not consumed: 10 fired came back, 50 still sit loaded');

  await page.evaluate(() => reset('inventory'));
  await page.waitForTimeout(150);
  const inv = await page.textContent('#view');
  ok(inv.includes('440') && inv.includes('940'),
     'the inventory screen shows what is left, not what was bought');
  ok(inv.includes('used across 1 batch'), '...and says where it went');
  ok(/enough for \d+ × 6\.5CM/.test(inv),
     'powder is also quoted in rounds of a real recipe, which is the useful unit');

  // Firing the rest of the batch returns its brass to the pool.
  await page.evaluate(() => {
    const b = DB.batches[0];
    DB.sessions.push({ id: 'setmp', batch: b.id, date: '2026-08-11', rounds: 50,
                       distance: 100, pressureSigns: 'none' });
    save();
  });
  ok((await page.evaluate(() => brassAvailable(DB.brassLots[0]))) === 100,
     'firing a batch off returns its cases to the lot');
  await page.evaluate(() => { DB.sessions = DB.sessions.filter(s => s.id !== 'setmp'); save(); });

  // Deleting a batch must put everything back, with no restore code to forget.
  const before = await page.evaluate(() => lotLeft(DB.componentLots.find(c => c.kind === 'bullet')));
  await page.evaluate(() => { DB.batches = DB.batches.filter(b => b.id !== DB.batches[0].id); save(); });
  ok((await page.evaluate(() => lotLeft(DB.componentLots.find(c => c.kind === 'bullet')))) === 500,
     'deleting a batch returns its components, because stock is derived not stored');
  ok(before === 440, '...having genuinely been drawn down beforehand');
}

/* ============================================== brass wears out fractionally */
section('brass life counts partial firings');
{
  await page.evaluate(() => {
    // 100 cases, nothing fired yet, no prior life.
    DB.brassLots[0].qty = 100; DB.brassLots[0].initialQty = 100;
    DB.brassLots[0].firings = 0; DB.brassLots[0].expectedFirings = 6;
    DB.batches = []; DB.sessions = []; save();
  });
  const life0 = await page.evaluate(() => brassLife(DB.brassLots[0]));
  ok(life0.mean === 0, 'a fresh lot is at zero firings');

  // Load 50, fire none: the cases are committed but unworn.
  await page.evaluate(() => {
    DB.batches = [{ id: 'bx', serial: 'BX', recipe: DB.recipes[0].id, brassLot: DB.brassLots[0].id,
      bulletLot: DB.componentLots.find(c=>c.kind==='bullet').id,
      powderLot: DB.componentLots.find(c=>c.kind==='powder').id,
      primerLot: DB.componentLots.find(c=>c.kind==='primer').id,
      date: '2026-08-01', qty: 50, chargeActual: 41.5, quarantine: false }];
    save();
  });
  ok((await page.evaluate(() => brassLife(DB.brassLots[0]).mean)) === 0,
     'loading brass does not wear it — only firing does');

  // Fire all 50 of the 100-case lot: half a firing, exactly.
  await page.evaluate(() => { DB.sessions = [{ id: 'sf1', batch: DB.batches[0].id,
      date: '2026-08-02', rounds: 50, distance: 100, pressureSigns: 'none' }]; save(); });
  const half = await page.evaluate(() => brassLife(DB.brassLots[0]));
  ok(half.mean === 0.5, `firing 50 of 100 puts the lot at 0.5 firings (${half.mean})`);
  ok(half.fired === 50, '...from 50 rounds fired');
  // partial draw => the cases are NOT all equal
  ok(Math.abs(half.sd - 0.5) < 1e-9,
     'a half-lot draw leaves a real spread: some cases went twice as often as the mean');
  ok(Math.abs(half.hi - (0.5 + 1.96 * 0.5)) < 1e-9,
     '...so the most-fired case is estimated well above the mean');

  // Fire the other 50 and the lot reaches exactly one firing.
  await page.evaluate(() => {
    DB.batches.push({ ...DB.batches[0], id: 'by', serial: 'BY', qty: 50 });
    DB.sessions.push({ id: 'sf2', batch: 'by', date: '2026-08-03', rounds: 50,
                       distance: 100, pressureSigns: 'none' });
    save();
  });
  ok((await page.evaluate(() => brassLife(DB.brassLots[0]).mean)) === 1,
     'firing the other 50 brings the lot to exactly 1.0 — they were mixed back together');

  // A full-lot draw adds no uncertainty at all.
  await page.evaluate(() => {
    DB.batches = [{ ...DB.batches[0], id: 'bz', serial: 'BZ', qty: 100 }];
    DB.sessions = [{ id: 'sf3', batch: 'bz', date: '2026-08-04', rounds: 100,
                     distance: 100, pressureSigns: 'none' }];
    save();
  });
  const full = await page.evaluate(() => brassLife(DB.brassLots[0]));
  ok(full.mean === 1 && full.sd === 0,
     'a whole-lot firing is 1.0 with no spread — every case went exactly once');

  // Prior life is a baseline the batches add to, not a total they replace.
  await page.evaluate(() => { DB.brassLots[0].firings = 2; save(); });
  ok((await page.evaluate(() => brassLife(DB.brassLots[0]).mean)) === 3,
     'firings recorded before the lot was tracked are a baseline, added to');

  const detail = await page.evaluate(() => {
    reset('brassDetail'); go('brassDetail', DB.brassLots[0].id);
    return document.getElementById('view').textContent;
  });
  await page.waitForTimeout(200);
  const d = await page.textContent('#view');
  ok(d.includes('3.00 of 6 expected firings'), 'the detail screen shows the fractional count');
  ok(d.includes('mean per case'), '...and says outright that it is a mean, because the cases are mixed');
  ok(/\d+ loaded · \d+ free/.test(d),
     '...alongside how many cases are committed versus free');

  // and the life warning fires off the tail, not the average
  await page.evaluate(() => {
    DB.brassLots[0].firings = 0; DB.brassLots[0].expectedFirings = 6;
    DB.batches = [];
    DB.sessions = [];
    for (let i = 0; i < 9; i++) {
      DB.batches.push({ id: 'q'+i, serial: 'Q'+i,
        recipe: DB.recipes[0].id, brassLot: DB.brassLots[0].id,
        bulletLot: DB.componentLots.find(c=>c.kind==='bullet').id,
        powderLot: DB.componentLots.find(c=>c.kind==='powder').id,
        primerLot: DB.componentLots.find(c=>c.kind==='primer').id,
        date: '2026-08-01', qty: 50, chargeActual: 41.5, quarantine: false });
      DB.sessions.push({ id: 'sq'+i, batch: 'q'+i, date: '2026-08-05', rounds: 50,
                         distance: 100, pressureSigns: 'none' });
    }
    save(); reset('brass');
  });
  await page.waitForTimeout(200);
  const lifeN = await page.evaluate(() => brassLife(DB.brassLots[0]));
  ok(lifeN.mean === 4.5 && lifeN.hi > 6,
     `mean ${lifeN.mean} is under the 6-firing limit but the worst case is over it`);
  ok((await page.textContent('#view')).includes('Some cases at limit'),
     'the lot is flagged on the worst case rather than on the average — brass failure is a safety event');

  await page.evaluate(() => { DB.batches = []; DB.brassLots[0].firings = 0; save(); });
}

/* ============================================== marking the case head itself */
section('the case head is a marking position, not just a band');
{
  await page.evaluate(() => { reset('settings'); });
  await page.waitForTimeout(200);
  ok((await page.textContent('#view')).includes('Add case head'),
     'the scheme offers a case-head position alongside bands');

  const before = await page.evaluate(() => scheme().positions.length);
  await tapText('+ Add case head');
  await page.waitForTimeout(250);
  const added = await page.evaluate(() => scheme().positions.at(-1));
  ok(added.kind === 'head', 'adding one records it as a head position');
  ok(added.at === null,
     '...with no place along the case, because the base does not have one');
  ok((await page.evaluate(() => scheme().positions.length)) === before + 1,
     '...and it counts toward the code space like any other position');

  const view = await page.textContent('#view');
  ok(view.includes('nothing to slide'),
     'the placement slider is replaced by an explanation rather than left dead');

  // It has to actually be drawable, or a lot marked there cannot be identified.
  const svg = await page.evaluate(() => caseSvg({ [scheme().positions.at(-1).id]: 'R' }));
  /* Asserted against the geometry the renderer reports, not against a
   * coordinate typed into the test. The base moved when the case stopped being
   * drawn as a rimmed one, and a hardcoded x="248" only proved that nothing
   * had changed -- not that the mark lands on the head. */
  const baseX = await page.evaluate(() => caseGeom(null).baseX0);
  ok(new RegExp(`x="${baseX}"[^>]*fill="#d92b2b"`).test(svg),
     `a marked case head paints the base of the case in the diagram (x=${baseX})`);
  ok(/Case head/.test(svg), '...and the diagram labels it');
  // The label lives under the rim. Centred beside the case it ran off the
  // 300-unit viewBox and was clipped, which is invisible until you look.
  const labelX = +(svg.match(/<text x="([\d.]+)"[^>]*>Case head</) || [])[1];
  ok(labelX > 0 && labelX < 285,
     `the case-head label sits inside the drawing rather than off its edge (x=${labelX})`);

  // Two head positions must not overprint each other.
  await tapText('+ Add case head');
  await page.waitForTimeout(250);
  const ids = await page.evaluate(() => scheme().positions.filter(p => p.kind === 'head').map(p => p.id));
  const svg2 = await page.evaluate((ids2) =>
    caseSvg({ [ids2[0]]: 'R', [ids2[1]]: 'B' }), ids);
  const heights = [...svg2.matchAll(
    new RegExp(`x="${baseX}" y="([\\d.]+)" width="[\\d.]+" height="([\\d.]+)"`, 'g'))];
  ok(heights.length === 2 && heights[0][1] !== heights[1][1],
     'two head marks split the base into stripes rather than overprinting');

  // Codes and lookup must treat it like any other position.
  const code = await page.evaluate((ids2) => codeOf({ [ids2[0]]: 'R', [ids2[1]]: 'B' }), ids);
  ok(code.split('/').length === (await page.evaluate(() => scheme().positions.length)),
     'the colour code carries a slot for every position including the head');

  await page.evaluate(() => {
    scheme().positions = scheme().positions.filter(p => p.kind !== 'head');
    save(); reset('brass');
  });
}

/* ======================================================= cases leave the lot */
section('removing cases changes the count and nothing else');
{
  await page.evaluate(() => {
    DB.brassLots[0].qty = 100; DB.brassLots[0].initialQty = 100;
    DB.brassLots[0].firings = 0; DB.brassLots[0].expectedFirings = 6;
    DB.brassLots[0].culls = [];
    DB.batches = [{ id: 'bx', serial: 'BX', recipe: DB.recipes[0].id, brassLot: DB.brassLots[0].id,
      bulletLot: DB.componentLots.find(c=>c.kind==='bullet').id,
      powderLot: DB.componentLots.find(c=>c.kind==='powder').id,
      primerLot: DB.componentLots.find(c=>c.kind==='primer').id,
      date: '2026-08-01', qty: 50, chargeActual: 41.5, quarantine: false }];
    DB.sessions = [{ id: 'sf5', batch: 'bx', date: '2026-08-06', rounds: 50,
                     distance: 100, pressureSigns: 'none' }];
    save(); go('brassDetail', DB.brassLots[0].id);
  });
  await page.waitForTimeout(200);
  const before = await page.evaluate(() => brassLife(DB.brassLots[0]));
  ok(before.mean === 0.5, 'lot starts at 0.5 firings from 50 of 100 fired');

  await tapText('Remove cases');
  await page.waitForTimeout(250);
  ok((await page.textContent('#view')).includes('Cases removed'), 'the remove-cases form opens');
  const reasons = await page.locator('[name="reason"] option').allTextContents();
  ok(reasons.join('|') === 'Case separation|Lost|Other — see note|No reason given',
     `the reason list is exactly the four options (${reasons.join(', ')})`);

  await fill('n', '3');
  await page.selectOption('[name="reason"]', 'sep');
  await fill('note', 'bright rings above the web');
  await submit();

  const after = await page.evaluate(() => ({
    onHand: brassOnHand(DB.brassLots[0]),
    life: brassLife(DB.brassLots[0]),
    culls: DB.brassLots[0].culls,
    qty: DB.brassLots[0].qty,
  }));
  ok(after.onHand === 97, `three cases leave the count (${after.onHand} on hand)`);
  ok(after.culls.length === 1 && after.culls[0].reason === 'sep' && after.culls[0].n === 3,
     'the removal is recorded with its reason');
  ok(after.qty === 97, 'the stored quantity is kept in step for exports');

  // THE point of the change: the survivors are no more worn than they were.
  ok(after.life.mean === 0.5,
     `the firing average is untouched — still ${after.life.mean}, not 50/97`);
  ok(after.life.sd === before.sd, '...including its spread');

  const dv = await page.textContent('#view');
  ok(dv.includes('97 of 100') && dv.includes('3 removed'), 'the detail shows both counts');
  ok(dv.includes('Case separation') && dv.includes('bright rings above the web'),
     'the reason and note are listed');
  ok(dv.includes('fired exactly as often as they had been'),
     'and the screen says outright that removal did not age the survivors');

  // A later firing measures against the smaller lot, because that is the lot
  // that was actually in circulation.
  /* Dated FROM THE CULL, not from a literal. The cull is stamped today(), and
   * lotPopulationAt counts only culls dated on or before the batch -- so a
   * hardcoded date is a fit for exactly the day it was typed on. This test was
   * written on 2026-09-01 with the batch dated 2026-09-01, and on 2026-09-02 it
   * started failing at 1.47: the cull now sorted AFTER the batch, so the firing
   * measured against 100 cases (97/100 = 0.97) instead of the 97 that were
   * actually in circulation. The assertion was right and the fixture had a
   * shelf life. */
  await page.evaluate(() => {
    const cull = DB.brassLots[0].culls[0];
    const after = (iso, days) => {
      const d = new Date(iso + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().slice(0, 10);
    };
    DB.batches.push({ ...DB.batches[0], id: 'bx2', serial: 'BX2',
      date: after(cull.date, 1), qty: 97 });
    DB.sessions.push({ id: 'sf6', batch: 'bx2', date: after(cull.date, 2),
                       rounds: 97, distance: 100, pressureSigns: 'none' });
    save();
  });
  const later = await page.evaluate(() => brassLife(DB.brassLots[0]));
  ok(Math.abs(later.mean - 1.5) < 1e-9,
     `a firing after the cull counts against the 97 that were left (${later.mean.toFixed(2)})`);

  // Cases inside loaded rounds are not on the bench to be culled.
  await page.evaluate(() => {
    DB.batches = [{ ...DB.batches[0], id: 'bl2', serial: 'BL2', qty: 90 }]; DB.sessions = [];
    save(); go('brassDetail', DB.brassLots[0].id);
  });
  await page.waitForTimeout(200);
  await tapText('Remove cases');
  await page.waitForTimeout(200);
  await fill('n', '20');
  await submit();
  const err = await page.textContent('#view');
  ok(err.includes('are free') && err.includes('inside loaded rounds'),
     'culling cases that are sitting in loaded rounds is refused, and says why');
  ok((await page.evaluate(() => brassOnHand(DB.brassLots[0]))) === 97, '...and nothing is removed');
  await page.click('#back'); await page.waitForTimeout(200);

  await page.evaluate(() => { DB.batches = []; DB.brassLots[0].culls = [];
    DB.brassLots[0].qty = 100; save(); });
}

/* ================================= the form says so before you commit to it */
section('the batch form shows the draw while you type');
{
  await page.evaluate(() => reset('ammo'));
  await page.waitForTimeout(140);
  await tapText('New batch');
  await page.waitForTimeout(200);
  await fill('qty', '100');
  await page.waitForTimeout(250);
  const pv = await page.textContent('#drawpv');
  ok(pv.includes('This batch will use'), 'the form shows what the batch will consume');
  ok(pv.includes('100ea'), '...100 bullets and 100 primers');
  // 100 x 41.5 (recipe charge, nothing measured yet) = 4150gr = 0.593 lb
  ok(pv.includes('4150gr') || pv.includes('0.593'),
     '...and the powder in both grains and the pounds it was bought in');
  ok(/max \d+ rounds/.test(pv), '...and the most these lots can make');
  ok(pv.includes('Limited by'), '...naming which component is the binding constraint');

  // typing a measured charge must move the numbers
  await fill('chargeActual', '41.52');
  await page.waitForTimeout(250);
  const pv2 = await page.textContent('#drawpv');
  ok(pv2.includes('4152gr') || pv2.includes('0.593'),
     'the measured charge replaces the recipe target in the preview');

  // and asking for more than exists is refused, with the number you can have
  await fill('qty', '2000');
  await page.waitForTimeout(250);
  const pv3 = await page.textContent('#drawpv');
  ok(pv3.includes('Not enough on hand'), 'asking for more than exists is called out before saving');
  await submit();
  const err = await page.textContent('#view');
  ok(err.includes('Not enough'), '...and refused on save');
  ok(/will make \d+ rounds/.test(err), '...stating how many these lots WILL make');
  ok((await page.evaluate(() => DB.batches.length)) === 0, '...with nothing saved');

  // the number it offered must actually work
  const cap = await page.evaluate(() => {
    const m = document.getElementById('view').textContent.match(/will make (\d+) rounds/);
    return m ? +m[1] : -1;
  });

  // Tapping the figure fills the field. This regressed once: blurring the
  // count field fired `change`, which repainted the panel, which destroyed the
  // button between mousedown and mouseup so the click never landed.
  await fill('qty', '2000');
  await page.waitForTimeout(250);
  await page.click('[data-act="fillmax"]');
  await page.waitForTimeout(250);
  ok((await page.inputValue('[name="qty"]')) === String(cap),
     `tapping "max ${cap} rounds" fills the count, even though tapping it blurs the field`);
  ok(!(await page.textContent('#drawpv')).includes('Not enough'),
     `the count it offered (${cap}) is genuinely loadable`);
  await submit();
  ok((await page.evaluate(() => DB.batches.length)) === 1,
     '...and saves, so the message is an instruction rather than a complaint');
  const leftAfter = await page.evaluate(() => lotLeft(DB.componentLots.find(c => c.kind === 'primer')));
  ok(leftAfter === 1000 - cap, `stock lands exactly where the form said (${leftAfter} primers)`);
}

/* ============================================ failed saves leave no residue */
section('failed saves');
{
  const before = await page.evaluate(() => DB.cartridges.length);
  await page.evaluate(() => reset('brass'));
  await page.waitForTimeout(150);
  await tapText('New brass lot');
  await page.selectOption('[name="cartridge"]', '__new');
  await page.waitForTimeout(120);
  await fill('cartridge__new', 'Totally New Wildcat');
  // headstamp deliberately left blank -> the save must be rejected
  await submit();
  ok((await page.textContent('#view')).includes('required'), 'the incomplete save is rejected');
  ok((await page.evaluate(() => DB.cartridges.length)) === before,
     'a rejected save creates no cartridge as a side effect');
  ok(!(await page.evaluate(() => DB.cartridges.some(c => c.name === 'Totally New Wildcat'))),
     '...specifically, the half-typed cartridge is not persisted');
  await page.click('#back'); await page.waitForTimeout(150);
}

/* ================================= the app is honest when it cannot persist */
section('storage warning');
{
  ok(!(await page.textContent('#view')).includes('Not saving to this device'),
     'no warning when storage works');
  const shown = await page.evaluate(() => {
    Object.defineProperty(Store, 'persistent', { get: () => false, configurable: true });
    render();
    const t = document.getElementById('view').textContent;
    return t.includes('Not saving to this device') && t.includes('vanish when the page reloads');
  });
  ok(shown, 'an unmissable warning appears on every screen when storage is blocked');
  await page.evaluate(() => {
    Object.defineProperty(Store, 'persistent', { get: () => true, configurable: true });
    render();
  });
}

/* ================================ the safety checks read the actual ammunition */
section('over max is judged on the charge that went in the case');
{
  // A recipe under its own published maximum, loaded over it. The old check
  // compared recipe.charge to sourceMax and never looked at what was weighed.
  await page.evaluate(() => {
    DB.recipes[0].charge = 41.5; DB.recipes[0].sourceMax = 42.0;
    DB.batches = [{ id: 'bx1', serial: 'B26H01-99A', recipe: DB.recipes[0].id,
      brassLot: DB.brassLots[0].id, bulletLot: DB.componentLots.find(c => c.kind === 'bullet').id,
      powderLot: DB.componentLots.find(c => c.kind === 'powder').id,
      primerLot: DB.componentLots.find(c => c.kind === 'primer').id,
      date: '2026-08-01', qty: 20, chargeActual: 43.0, quarantine: false }];
    DB.sessions = [];
    save(); reset('ammo');
  });
  await page.waitForTimeout(150);
  ok(await page.evaluate(() => isOverMax(DB.batches[0])),
     '43.0 gr against a 42.0 gr cited max is over max, whatever the recipe intended');
  ok(!(await page.evaluate(() => recipeOverMax(DB.recipes[0]))),
     '...while the recipe itself is still within its own maximum — a different claim');

  await page.click('[data-act="ammoDetail"]');
  await page.waitForTimeout(200);
  const det = await page.textContent('#view');
  ok(det.includes('Charge exceeds the published maximum'), 'the detail screen says so');
  ok(det.includes('43') && det.includes('as weighed'),
     '...naming the charge actually thrown, and that it was weighed rather than intended');
  ok(/102\.4%/.test(det), '...and the percentage is computed from it (102.4% of max)');
  ok(det.includes('recipe called for 41.5'),
     '...while still reporting what the recipe asked for, so the gap is visible');

  await tapText('Label');
  await page.waitForTimeout(300);
  ok((await page.textContent('.lbl')).includes('OVER PUBLISHED MAX'),
     'the box label carries the band, which is the copy that goes to the range');
  await page.click('#back'); await page.waitForTimeout(150);

  // Take the measured charge away and the recipe target governs again.
  await page.evaluate(() => { DB.batches[0].chargeActual = null; save(); render(); });
  ok(!(await page.evaluate(() => isOverMax(DB.batches[0]))),
     'with nothing weighed, the recipe target governs and 41.5 is under max');
}

section('a batch that contradicts its recipe says so');
{
  await page.evaluate(() => {
    DB.componentLots.push({ id: 'clx', serial: 'C-9', kind: 'powder', name: 'Hodgdon Varget',
      lot: 'V-1', qty: 8, unit: 'lb', cost: 300 });
    DB.batches[0].chargeActual = 41.52;
    save();
  });
  // Naming is fuzzy, so check the matcher on its own terms first.
  const m = await page.evaluate(() => ({
    same: namesAgree('Hodgdon H4350', 'H4350'),
    spaced: namesAgree('Berger 140gr Hybrid', 'Berger 140 gr Hybrid Target'),
    diff: namesAgree('Hodgdon H4350', 'Hodgdon Varget'),
    blank: namesAgree('', 'H4350'),
    weight: namesAgree('Berger 140gr Hybrid', 'Berger 140gr VLD'),
    catalogue: namesAgree('Fed GM210M', 'Federal 210M'),
    maker: namesAgree('Lapua', 'Lapua'),
  }));
  ok(m.same === true, 'a maker prefix is not a mismatch: "Hodgdon H4350" matches "H4350"');
  ok(m.spaced === true, '...nor is 140gr against 140 gr, or a trailing "Target"');
  ok(m.diff === false, 'H4350 and Varget are a mismatch, which is the one that matters');
  ok(m.blank === null, 'an unnamed component is an absence, not a mismatch');
  ok(m.weight === false,
     'a 140 Hybrid and a 140 VLD do not pass on the shared weight — different bullet, different seating');
  ok(m.catalogue === true, 'GM210M and 210M are the same primer written two ways');
  ok(m.maker === true, 'a name that is nothing but a maker still matches itself');

  await page.evaluate(() => { DB.batches[0].powderLot = 'clx'; save(); reset('ammo'); });
  await page.waitForTimeout(150);
  const mm = await page.evaluate(() => batchMismatches(DB.batches[0]));
  ok(mm.length === 1 && mm[0].what === 'Powder' && mm[0].severity === 'stop',
     'loading Varget into an H4350 recipe is flagged, at stop severity');
  await page.click('[data-act="ammoDetail"]');
  await page.waitForTimeout(200);
  const dt = await page.textContent('#view');
  ok(dt.includes('does not match its recipe'), 'the detail screen leads with it');
  ok(/recipe calls for <b>H4350<\/b>/.test(await page.innerHTML('#view'))
     && dt.includes('Hodgdon Varget'),
     '...naming both, because "mismatch" alone tells you nothing');
  ok(dt.includes('Charge weights are not transferable'),
     '...and why it matters, which is the whole point of the warning');
  await tapText('Label');
  await page.waitForTimeout(300);
  ok((await page.textContent('.lbl')).includes('DOES NOT MATCH RECIPE'),
     'the label carries it too');
  await page.click('#back'); await page.waitForTimeout(150);
  await page.evaluate(() => {
    DB.batches[0].powderLot = DB.componentLots.find(c => c.kind === 'powder').id;
    DB.componentLots = DB.componentLots.filter(c => c.id !== 'clx');
    save(); render();
  });
  ok((await page.evaluate(() => batchMismatches(DB.batches[0]))).length === 0,
     'putting the right powder back clears it — the warning is derived, not a flag');
}

section('the label prints the brass life, not the baseline');
{
  await page.evaluate(() => {
    // A lot bought new: baseline 0 firings, 100 cases, one 40-round batch fired.
    const l = DB.brassLots[0];
    l.firings = 0; l.initialQty = 100; l.qty = 100; l.culls = [];
    DB.batches[0].qty = 40;
    DB.sessions = [{ id: 'sf7', batch: DB.batches[0].id, date: '2026-08-08', rounds: 40,
                     distance: 100, pressureSigns: 'none' }];
    save(); reset('ammo');
  });
  await page.waitForTimeout(150);
  await page.click('[data-act="ammoDetail"]');
  await page.waitForTimeout(200);
  await tapText('Label');
  await page.waitForTimeout(300);
  const lbl = await page.textContent('.lbl');
  ok(/0\.4f/.test(lbl),
     `40 of 100 cases fired prints 0.4f, the figure every other screen shows (${
       (lbl.match(/[\d.]+f/) || [])[0]})`);
  ok(!/·\s*0f/.test(lbl),
     '...not 0f, which is what the baseline field says and what used to be printed');
  await page.click('#back'); await page.waitForTimeout(150);
}

/* ============================================ what is left in the box is derived */
section('rounds left come from the sessions, so a typo is fixable');
{
  await page.evaluate(() => {
    DB.brassLots[0].firings = 0; DB.brassLots[0].initialQty = 100;
    DB.brassLots[0].qty = 100; DB.brassLots[0].culls = []; DB.brassLots[0].retired = false;
    DB.brassLots[0].expectedFirings = 6; DB.brassLots[0].anneals = []; DB.brassLots[0].annealEvery = 1;
    DB.batches = [{ id: 'bd1', serial: 'B26H01-77C', recipe: DB.recipes[0].id,
      brassLot: DB.brassLots[0].id, bulletLot: DB.componentLots.find(c => c.kind === 'bullet').id,
      powderLot: DB.componentLots.find(c => c.kind === 'powder').id,
      primerLot: DB.componentLots.find(c => c.kind === 'primer').id,
      date: '2026-08-01', qty: 100, adjust: [], chargeActual: 41.5, quarantine: false }];
    DB.sessions = []; save(); reset('ammo');
  });
  await page.waitForTimeout(150);
  await page.click('[data-act="ammoDetail"]');
  await page.waitForTimeout(200);

  // The classic fat-finger: 100 typed where 10 was meant.
  await tapText('Log range session');
  await fill('rounds', '100');
  await submit();
  ok((await page.evaluate(() => roundsLeft(DB.batches[0]))) === 0, 'a 100-round session empties the box');
  ok((await page.evaluate(() => brassLife(DB.brassLots[0]).mean)) === 1,
     '...and puts a full cycle on the brass, which used to be the unrecoverable part');

  // Under the old model this was permanent. Now the session is a record.
  const sid = await page.evaluate(() => DB.sessions[0].id);
  await page.click(`[data-act="editSession"][data-arg="${sid}"]`);
  await page.waitForTimeout(250);
  ok((await page.inputValue('[name="rounds"]')) === '100',
     'the edit form opens seeded with what was actually saved');
  await fill('rounds', '10');
  await submit();
  ok((await page.evaluate(() => roundsLeft(DB.batches[0]))) === 90,
     'correcting the session corrects the round count');
  ok(Math.abs(await page.evaluate(() => brassLife(DB.brassLots[0]).mean) - 0.1) < 1e-9,
     '...and the brass wear with it — both were derived from the same record');

  await destroy(`[data-act="delSession"][data-arg="${sid}"]`);
  ok((await page.evaluate(() => roundsLeft(DB.batches[0]))) === 100
     && (await page.evaluate(() => brassLife(DB.brassLots[0]).mean)) === 0,
     'deleting it puts everything back, with no restore code to forget');
}

section('rounds that left without being fired');
{
  await page.click('[data-act="adjustRounds"]');
  await page.waitForTimeout(250);
  const reasons = await page.locator('[name="reason"] option').allTextContents();
  ok(reasons.join('|') === 'Pulled down|Given away|Lost|Other — see note|No reason given',
     `the reasons say where rounds actually go (${reasons.join(', ')})`);
  await fill('n', '12');
  await page.selectOption('[name="reason"]', 'pulled');
  await fill('note', 'seating depth test, components recovered');
  await submit();
  ok((await page.evaluate(() => roundsLeft(DB.batches[0]))) === 88,
     'twelve pulled rounds leave the box');
  ok((await page.evaluate(() => brassLife(DB.brassLots[0]).mean)) === 0,
     '...and put no wear on the brass, because nothing was fired');
  const dv = await page.textContent('#view');
  ok(dv.includes('Pulled down') && dv.includes('seating depth test'),
     'the batch says where they went, rather than just showing a smaller number');
  ok(dv.includes('Otherwise gone'), '...and separates them from rounds actually fired');
  await destroy('[data-act="unadjust"]');
  ok((await page.evaluate(() => roundsLeft(DB.batches[0]))) === 100, 'and it can be undone');
}

/* ================================================ everything can be corrected */
section('records can be edited');
{
  await page.evaluate(() => { reset('brass'); });
  await page.waitForTimeout(150);
  await page.click('[data-act="brassDetail"]');
  await page.waitForTimeout(200);
  await page.click('[data-act="edit"][data-kind="brass"]');
  await page.waitForTimeout(250);
  ok((await page.textContent('#view')).includes('The serial does not change'),
     'the edit screen is explicit that the serial is fixed — labels are already in boxes');
  ok((await page.inputValue('[name="headstamp"]')).length > 0, 'the form is seeded from the record');
  const marksOn = await page.locator('.sw.on').count();
  ok(marksOn >= 1, 'the colour code is seeded too, rather than silently cleared');

  const serialBefore = await page.evaluate(() => DB.brassLots[0].serial);
  await fill('initialQty', '200');
  await fill('headstamp', 'LAPUA');
  await submit();
  const after = await page.evaluate(() => ({
    n: DB.brassLots.length, qty: DB.brassLots[0].initialQty,
    hs: DB.brassLots[0].headstamp, serial: DB.brassLots[0].serial,
  }));
  ok(after.n === 1, 'editing changes the record rather than adding a second one');
  ok(after.qty === 200 && after.hs === 'LAPUA', '...and the changes land');
  ok(after.serial === serialBefore, '...and the serial is untouched');

  // A colour code collides with every OTHER lot, not with itself.
  await page.click('[data-act="edit"][data-kind="brass"]');
  await page.waitForTimeout(250);
  await fill('cost', '250');
  await submit();
  ok((await page.evaluate(() => DB.brassLots[0].cost)) === 250,
     'saving an edit that leaves the colour code alone is not rejected as a duplicate');

  // But it must not be shrunk below what is already spoken for.
  await page.evaluate(() => {
    DB.brassLots[0].culls = [{ id: 'c9', n: 10, reason: 'sep', date: '2026-08-01' }];
    save();
  });
  await page.click('[data-act="edit"][data-kind="brass"]');
  await page.waitForTimeout(250);
  await fill('initialQty', '5');
  await submit();
  ok((await page.textContent('#view')).includes('cannot be smaller'),
     'a lot cannot be edited smaller than the cases already removed and loaded');
  await page.click('#back'); await page.waitForTimeout(200);
}

section('brass can be retired, and retired brass is not offered');
{
  await page.evaluate(() => {
    DB.brassLots[0].culls = []; DB.sessions = []; DB.batches = []; save();
    go('brassDetail', DB.brassLots[0].id);
  });
  await page.waitForTimeout(200);
  await tapText('Retire lot');
  await page.waitForTimeout(200);
  ok((await page.evaluate(() => DB.brassLots[0].retired)) === true, 'the lot is retired');
  ok((await page.textContent('#view')).includes('Retired'), '...and says so');
  const offered = await page.evaluate(() =>
    FORMS.batch.fields.find(f => f.k === 'brassLot').ref().length);
  ok(offered === 0, 'a retired lot is no longer offered when building a batch');
  await tapText('Return to service');
  await page.waitForTimeout(200);
  ok((await page.evaluate(() => DB.brassLots[0].retired)) === false, 'and it can come back');

  // Retiring brass that is inside loaded rounds would strand those rounds.
  await page.evaluate(() => {
    DB.batches = [{ id: 'bd2', serial: 'B26H01-78D', recipe: DB.recipes[0].id,
      brassLot: DB.brassLots[0].id, date: '2026-08-01', qty: 40, adjust: [],
      chargeActual: 41.5, quarantine: false }];
    DB.sessions = []; save(); go('brassDetail', DB.brassLots[0].id);
  });
  await page.waitForTimeout(200);
  await tapText('Retire lot');
  await page.waitForTimeout(250);
  ok((await page.evaluate(() => DB.brassLots[0].retired)) === false
     && (await page.textContent('body')).includes('still in loaded rounds'),
     'retiring is refused while cases are inside loaded ammunition, and says why');
}

section('annealing is an interval, not a single date');
{
  await page.evaluate(() => {
    // Batches with nothing fired out of them put no wear on the lot, so the
    // baseline alone drives this section -- no need to delete them.
    DB.sessions = [];
    Object.assign(DB.brassLots[0], { firings: 4, annealEvery: 2, anneals: [], retired: false });
    save(); go('brassDetail', DB.brassLots[0].id);
  });
  await page.waitForTimeout(200);
  ok((await page.textContent('#view')).includes('Never annealed'), 'four firings, never annealed: flagged');
  await tapText('Log anneal');
  await page.waitForTimeout(250);
  await fill('note', 'AMP 118');
  await submit();
  const v1 = await page.textContent('#view');
  ok(!v1.includes('Anneal due') && !v1.includes('Never annealed'), 'logging one clears the flag');
  ok(v1.includes('AMP 118') && v1.includes('at 4.0f'),
     'the anneal is a dated record with the firing count it was done at');

  // The old check was `!lastAnneal && mean >= 3` — one anneal silenced it forever.
  await page.evaluate(() => { DB.brassLots[0].firings = 5; save(); render(); });
  ok(!(await page.textContent('#view')).includes('Anneal due'),
     'one firing later, with an interval of two, nothing is due yet');
  await page.evaluate(() => { DB.brassLots[0].firings = 6; save(); render(); });
  ok((await page.textContent('#view')).includes('Anneal due'),
     'two firings past the last anneal, it is due again — the warning does not die after the first one');
  await page.evaluate(() => { DB.brassLots[0].annealEvery = 0; save(); render(); });
  ok(!(await page.textContent('#view')).includes('Anneal due'),
     'an interval of zero turns the nag off for people who do not anneal');
}

section('an old database survives an actual page LOAD');
{
  /* The migration test below calls loadDb() from the console, which runs long
   * after the script has finished evaluating. The path a real user takes is
   * different and was never covered: the page LOADS with an old database
   * already in localStorage, so loadDb() -> migrate() runs during module
   * evaluation.
   *
   * migrate() called uid() and today(), which were declared with `const`
   * further down the file. `const` is not hoisted like a function declaration;
   * it sits in the temporal dead zone until its own line executes. So the
   * migration threw `Cannot access 'uid' before initialization` at the top
   * level: render() never ran, nothing bound, blank page -- and because
   * nothing was saved, it re-crashed on every reload. A permanent brick,
   * reachable only by users who already had data, which is the worst possible
   * population to break.
   *
   * This seeds an old database and RELOADS, which is the only way to catch it. */
  const before = errors.length;
  // Replaces the whole database and reloads, so it snapshots first and puts it
  // back afterwards -- every later section asserts on the bench built above.
  const snapshot = await page.evaluate(() => localStorage.getItem('reloading.Bench'));
  await page.evaluate(() => {
    localStorage.setItem('reloading.Bench', JSON.stringify({
      meta: { schema: 2 },
      cartridges: [{ id: 'c1', name: '6.5 Creedmoor' }], firearms: [], componentLots: [],
      brassLots: [{ id: 'l1', serial: 'R-1', marks: {}, cartridge: 'c1', headstamp: 'LAPUA',
                    initialQty: 100, qty: 100, firings: 0, expectedFirings: 6, culls: [],
                    lastAnneal: '2026-06-01' }],
      recipes: [], sessions: [],
      batches: [{ id: 'b1', serial: 'B1', brassLot: 'l1', qty: 100, remaining: 40, date: '2026-07-01' }],
    }));
  });
  await page.reload();
  await page.waitForTimeout(700);

  const fresh = errors.slice(before);
  ok(fresh.length === 0,
     'loading with a schema-2 database on disk throws nothing'
     + (fresh.length ? ' — ' + fresh[0] : ''));
  ok((await page.innerHTML('#view')).length > 50,
     '...and the app actually renders rather than showing a blank shell');
  ok((await page.evaluate(() => DB.meta.schema)) === 3, '...having migrated on the way in');
  ok((await page.evaluate(() => DB.brassLots[0].anneals.length)) === 1,
     '...including the parts of the migration that need uid() and today()');
  ok((await page.evaluate(() => DB.batches[0].adjust.length)) === 1,
     '...and the adjustment carried over from the stored round count');

  await page.evaluate((snap) => { localStorage.setItem('reloading.Bench', snap); }, snapshot);
  await page.reload();
  await page.waitForTimeout(600);
}

section('a stored round count is migrated, not discarded');
{
  // This one replaces the whole database to stand up a schema-2 bench, so it
  // puts the real one back afterwards -- later sections assert on it.
  const snapshot = await page.evaluate(() => JSON.stringify(DB));
  const got = await page.evaluate(() => {
    // A schema-2 bench: batches carrying a stored `remaining`, one explained by
    // a session and one not.
    const db = {
      meta: { schema: 2 },
      cartridges: [{ id: 'c1', name: '6.5 Creedmoor' }], firearms: [], componentLots: [],
      brassLots: [{ id: 'l1', serial: 'R-1', marks: {}, cartridge: 'c1', headstamp: 'LAPUA',
                    initialQty: 100, qty: 100, firings: 0, expectedFirings: 6, culls: [],
                    lastAnneal: '2026-06-01' }],
      recipes: [], batches: [
        { id: 'b1', serial: 'B1', brassLot: 'l1', qty: 100, remaining: 90, date: '2026-07-01' },
        { id: 'b2', serial: 'B2', brassLot: 'l1', qty: 100, remaining: 40, date: '2026-07-02' },
      ],
      sessions: [{ id: 's1', batch: 'b1', rounds: 10, date: '2026-07-05' }],
    };
    Store.save(db);
    DB = loadDb(); save();
    return {
      schema: DB.meta.schema,
      b1: { left: roundsLeft(DB.batches[0]), adj: DB.batches[0].adjust.length,
            stored: 'remaining' in DB.batches[0] },
      b2: { left: roundsLeft(DB.batches[1]), adj: DB.batches[1].adjust,
            stored: 'remaining' in DB.batches[1] },
      anneals: DB.brassLots[0].anneals,
      every: DB.brassLots[0].annealEvery,
    };
  });
  ok(got.schema === 3, 'the bench is migrated to the new schema');
  ok(got.b1.left === 90 && got.b1.adj === 0,
     'a count the sessions already explain is left alone — no phantom adjustment');
  ok(got.b2.left === 40 && got.b2.adj.length === 1 && got.b2.adj[0].n === 60,
     'a count nothing explains is preserved as an adjustment rather than silently handed back');
  ok(/Carried over/.test(got.b2.adj[0].note),
     '...with a note saying where the number came from, so it is not a mystery');
  ok(!got.b1.stored && !got.b2.stored, 'the stored counter is gone, so it cannot drift again');
  ok(got.anneals.length === 1 && got.anneals[0].date === '2026-06-01' && got.every === 1,
     'a single anneal date becomes the first entry in the history');
  await page.evaluate((snap) => { Store.save(JSON.parse(snap)); DB = loadDb(); render(); }, snapshot);
  await page.waitForTimeout(150);
}

/* ================================================== the shell holds its shape */
section('the tab bar sits at the bottom on every screen');
{
  /* The bar was `position:fixed; bottom:0`, which pins it to the VIEWPORT --
   * and on iOS the viewport moves: Safari hides its bottom toolbar once a page
   * scrolls, so a long screen grew the viewport and dropped the bar while a
   * short screen kept the toolbar and left it high. Two different results from
   * one stylesheet.
   *
   * It is the last row of a 100dvh flex column now, so it is at the bottom of
   * whatever space exists regardless of what the browser does. That is testable
   * where the old arrangement was not: assert it on a screen with far too
   * little content to scroll AND on one with far too much, and require the same
   * answer from both. */
  const geom = async (label) => {
    await page.waitForTimeout(200);
    return page.evaluate(() => {
      const n = document.querySelector('nav.tabs').getBoundingClientRect();
      const m = document.querySelector('main');
      const h = document.querySelector('header').getBoundingClientRect();
      return {
        gapBelow: Math.round(innerHeight - n.bottom),
        headerTop: Math.round(h.top),
        scroller: m.scrollHeight > m.clientHeight,
        bodyScrolls: document.body.scrollHeight > innerHeight + 1,
        navOverlapsMain: Math.round(n.top) < Math.round(m.getBoundingClientRect().bottom) - 1,
      };
    });
  };

  // Empties and then floods a collection, so it snapshots first — later
  // sections assert on the bench built above.
  const lotsBefore = await page.evaluate(() => JSON.stringify(DB.componentLots));
  await page.evaluate(() => { DB.componentLots = []; save(); reset('inventory'); });
  const short = await geom('short');
  await page.evaluate(() => {
    // Far more than fits, so the middle genuinely scrolls.
    DB.componentLots = Array.from({ length: 60 }, (_, i) => ({
      id: 'z' + i, serial: 'C-' + i, kind: 'bullet', name: 'Filler ' + i,
      qty: 100, unit: 'ea', cost: 10, weightGr: 140 }));
    save(); reset('inventory');
  });
  const long = await geom('long');

  ok(short.gapBelow === 0, `on a screen too short to scroll, the bar is at the bottom (gap ${short.gapBelow}px)`);
  ok(long.gapBelow === 0, `on a screen long enough to scroll, likewise (gap ${long.gapBelow}px)`);
  ok(short.gapBelow === long.gapBelow,
     'the bar does not move between the two, which is the whole complaint');
  ok(short.headerTop === 0 && long.headerTop === 0, 'the header stays put in both');
  ok(long.scroller, 'the long screen scrolls its MIDDLE');
  ok(!long.bodyScrolls && !short.bodyScrolls,
     '...and the page itself never scrolls, so browser chrome cannot move under us');
  ok(!short.navOverlapsMain && !long.navOverlapsMain,
     'the bar sits below the content rather than covering it — nothing hides under it');

  await page.evaluate((prev) => {
    DB.componentLots = JSON.parse(prev); save(); reset('lookup');
  }, lotsBefore);
  await page.waitForTimeout(150);
}

/* ============================================ every field must be readable */
section('no field is invisible');
{
  /* The sign-in form was light grey on white: the input rule listed
   * text/number/date and so missed email and password, which fell back to a
   * white browser default while inheriting near-white text.
   *
   * Asserting on the two known fields would fix today and miss the next field
   * type someone adds. This walks EVERY input on every screen that has one and
   * computes real contrast from the resolved colours, so a field that is
   * unreadable for any reason -- unstyled, wrong variable, inherited white --
   * fails regardless of which type it is. */
  const relLum = (c) => {
    const [r, g, b] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
      const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [relLum(a), relLum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };

  const screens = ['sync', 'settings', 'data'];
  const found = [];
  for (const v of screens) {
    await page.evaluate(x => reset(x), v);
    await page.waitForTimeout(200);
    const fields = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('#view input, #view select, #view textarea').forEach(el => {
        const t = (el.getAttribute('type') || 'text').toLowerCase();
        if (['checkbox','radio','range','file','button','submit'].includes(t)) return;
        if (el.offsetParent === null) return;                 // not visible
        const cs = getComputedStyle(el);
        // Walk up for an effective background: transparent means "whatever is
        // behind me", and what is behind me is what the text sits on.
        let bg = cs.backgroundColor, node = el;
        while (/rgba\(0, 0, 0, 0\)|transparent/.test(bg) && node.parentElement) {
          node = node.parentElement; bg = getComputedStyle(node).backgroundColor;
        }
        out.push({ t, id: el.id || el.name || el.placeholder || '(unnamed)',
                   color: cs.color, bg });
      });
      return out;
    });
    for (const f of fields) found.push({ ...f, screen: v });
  }

  ok(found.length >= 2, `found ${found.length} visible fields to check`);
  const bad = found.filter(f => ratio(f.color, f.bg) < 4.5);
  ok(bad.length === 0,
     'every visible field has readable contrast'
     + (bad.length ? ' — ' + bad.map(f =>
         `${f.screen}/${f.id} (${f.t}) ${ratio(f.color, f.bg).toFixed(1)}:1`).join(', ') : ''));

  // The sign-in form only exists when the build has a backend, which this
  // suite deliberately does not have. Its fields are checked in test-sync.mjs,
  // against a build pointed at the mock.
}

/* ===================================================================== label */
section('label');
{
  // navigate explicitly rather than inheriting whatever screen the previous
  // section happened to leave behind
  await page.evaluate(() => reset('ammo'));
  await page.waitForTimeout(150);
  await page.click('[data-act="ammoDetail"]');
  await page.waitForTimeout(200);
  await tapText('Label');
  await page.waitForTimeout(300);
  ok((await page.locator('.lbl .qr svg').count()) === 1, 'the label renders a QR');
  const fitv = await page.evaluate(() => {
    const el = document.querySelector('.lbl');
    const r = el.getBoundingClientRect();
    return { h: Math.round(r.height), sh: el.scrollHeight, w: Math.round(r.width), sw: el.scrollWidth };
  });
  ok(fitv.sh <= fitv.h && fitv.sw <= fitv.w,
     `label content fits its 2.5x1.5in box (${fitv.sw}x${fitv.sh} in ${fitv.w}x${fitv.h})`);
  await page.locator('.lbl .qr').first().screenshot({ path: 'shots/qr.png' });

  /* The marking scheme prints as a DRAWING OF A CASE, not a row of dots.
   *
   * The label is read at a bench with a box open and a case in the other hand.
   * The question is "is this the brass in this box", which means matching a
   * band at a position -- and a row of circles turns that into a counting
   * exercise, with no place at all to show a mark on the case head. */
  const caseOnLabel = await page.locator('.lbl svg.case').count();
  ok(caseOnLabel === 1, `the label draws the case, not a row of dots (${caseOnLabel})`);
  ok((await page.locator('.lbl .marks i').count()) === 0, 'the dot row is gone');

  const marked = await page.evaluate(() => {
    const sc = scheme();
    const lot = DB.brassLots.find(l => l.id === DB.batches[0].brassLot);
    const want = sc.positions.map(p => lot.marks[p.id]).filter(Boolean)
      .map(id => sc.palette.find(c => c.id === id).hex.toLowerCase());
    const got = [...document.querySelectorAll('.lbl svg.case rect[fill]')]
      .map(r => r.getAttribute('fill').toLowerCase())
      .filter(f => f !== 'none');
    return { want, got, code: codeOf(lot.marks) };
  });
  ok(marked.want.length > 0 && marked.want.every(h => marked.got.includes(h)),
     `every mark is painted in its own colour at its own position (${marked.want.join(', ')})`);

  const labelText = await page.textContent('.lbl');
  ok(labelText.includes(marked.code),
     `the letter code prints too (${marked.code}) — a mono printer turns every colour into a grey`);

  /* Backgrounds are dropped when printing unless the page asks otherwise, and
   * this label has one that carries a safety meaning. A quarantine banner that
   * prints white is worse than none: the label looks complete. */
  const adj = await page.evaluate(() =>
    getComputedStyle(document.querySelector('.lbl')).printColorAdjust
    || getComputedStyle(document.querySelector('.lbl')).webkitPrintColorAdjust);
  ok(adj === 'exact', `the label forces colours to print (${adj})`);

  /* And with a warning band, which adds a sixth of an inch of padding at the
   * top. The fit above has two pixels of slack; a banner eats sixteen. This is
   * the case that actually clips, and it is the label you least want clipped. */
  await page.evaluate(() => { DB.batches[0].quarantine = 'seating depth suspect'; save(); render(); });
  await page.waitForTimeout(250);
  const fitBand = await page.evaluate(() => {
    const el = document.querySelector('.lbl');
    const r = el.getBoundingClientRect();
    return { h: Math.round(r.height), sh: el.scrollHeight, banded: el.classList.contains('hasband') };
  });
  ok(fitBand.banded, 'a quarantined batch prints with its warning band');
  ok(fitBand.sh <= fitBand.h,
     `...and still fits the label (${fitBand.sh} in ${fitBand.h})`);
  await shot('07b-label-banded');
  await page.evaluate(() => { delete DB.batches[0].quarantine; save(); render(); });
  await page.waitForTimeout(200);

  /* A sheet of eight. Each case drawing carries its own <clipPath id>, and the
   * bands are painted through it -- so if two labels on one page shared an id,
   * every case after the first would clip against the wrong path and the marks
   * would land somewhere else or vanish. Eight labels, eight distinct ids. */
  await page.click('[data-act="printSheet"]');
  await page.waitForTimeout(300);
  const sheet = await page.evaluate(() => {
    const cases = [...document.querySelectorAll('#sheet .lbl svg.case')];
    const ids = cases.map(c => c.querySelector('clipPath')?.id).filter(Boolean);
    const used = cases.map(c => c.querySelector('g[clip-path]')?.getAttribute('clip-path'));
    return { n: cases.length, unique: new Set(ids).size,
             matched: cases.every((c, i) => used[i] === `url(#${ids[i]})`) };
  });
  ok(sheet.n === 8, `the sheet prints eight labels (${sheet.n})`);
  ok(sheet.unique === 8, `each case drawing has its own clip id (${sheet.unique} distinct)`);
  ok(sheet.matched, '...and each one clips against its own, not a neighbour\'s');

  await shot('07-label');
}

/* ============================================================ load workups */
section('a ladder is built in one pass, and read as one table');
{
  await page.evaluate(() => {
    DB.componentLots.forEach(c => { if (c.kind === 'powder') { c.qty = 8; c.unit = 'lb'; }
                                    else c.qty = 1000; });
    Object.assign(DB.brassLots[0], { initialQty: 200, qty: 200, culls: [], firings: 0,
      retired: false, expectedFirings: 10, anneals: [], annealEvery: 0 });
    Object.assign(DB.recipes[0], { charge: 41.5, sourceMax: 42.0, cbto: 2.245 });
    DB.batches = []; DB.sessions = []; save(); reset('recipes');
  });
  await page.waitForTimeout(200);
  await page.click('[data-act="workup"]');
  await page.waitForTimeout(250);
  ok((await page.textContent('#view')).includes('Nothing loaded on this recipe yet'),
     'an empty workup says so and offers to build the rungs');

  await tapText('Build a ladder');
  await page.waitForTimeout(300);
  await fill('start', '40.6');
  await fill('step', '0.3');
  await fill('steps', '6');
  await fill('perStep', '3');
  await submit();
  await page.waitForTimeout(300);

  const built = await page.evaluate(() => DB.batches.map(b => ({
    charge: b.chargeActual, qty: b.qty, serial: b.serial, notes: b.notes })));
  ok(built.length === 6, 'six rungs, six batches');
  ok(built.every(b => b.qty === 3), '...three rounds each');
  ok(new Set(built.map(b => b.serial)).size === 6, '...each with its own serial, because each gets a label');
  ok(built.map(b => b.charge).join(',') === '40.6,40.9,41.2,41.5,41.8,42.1',
     `the charges step cleanly (${built.map(b => b.charge).join(', ')})`);
  ok(/Rung 1 of 6/.test(built[0].notes), '...and each rung says what it is');

  const drew = await page.evaluate(() =>
    lotLeft(DB.componentLots.find(c => c.kind === 'bullet')));
  ok(drew === 1000 - 18, `the whole ladder comes off the shelf at once (${drew} bullets left)`);

  const v = await page.textContent('#view');
  ok(v.includes('6 rungs'), 'the workup screen lists them');
  ok(v.includes('42.1') && v.includes('over max'),
     'the rung above the published maximum is built and flagged, not silently dropped');

  // Fire the ladder and read it back as a comparison.
  await page.evaluate(() => {
    const v0 = [2680, 2701, 2722, 2731, 2735, 2764];
    DB.batches.forEach((b, i) => DB.sessions.push({ id: 'lad' + i, batch: b.id,
      firearm: DB.firearms[0].id, date: '2026-08-20', rounds: 3, distance: 100,
      vAvg: v0[i], vSd: i === 3 ? 4.1 : 9.2, vEs: i === 3 ? 9 : 22,
      group: i === 3 ? 0.31 : 0.62, pressureSigns: i === 5 ? 'ejector mark' : 'none' }));
    save(); render();
  });
  await page.waitForTimeout(200);
  const w = await page.textContent('#view');
  ok(/2680[\s\S]*2701[\s\S]*2722[\s\S]*2731/.test(w.replace(/\s+/g, ' ')),
     'the rungs read in charge order, which is the only order a ladder makes sense in');
  ok(w.includes('ejector mark'), 'pressure signs are on the rung that showed them');
  // 2731 -> 2735 over 0.3 gr is 13 fps/gr; every other step is 30 or more.
  ok(/Flattest step/.test(w) && /41\.5 → 41\.8/.test(w) && /4 fps/.test(w),
     'the flattest step is named with its numbers (41.5 → 41.8 moved 4 fps)');
  ok(/not a recommendation/.test(w),
     '...and explicitly not offered as a recommendation, because three rounds a rung cannot settle it');
  await shot('10-workup');

  // A ladder that will not fit must build nothing rather than stop halfway.
  await tapText('Build a ladder');
  await page.waitForTimeout(300);
  await fill('start', '40.6');
  await fill('step', '0.3');
  await fill('steps', '40');
  await fill('perStep', '40');
  await submit();
  const err = await page.textContent('#view');
  ok(/Nothing was built/.test(err) && /1600 rounds/.test(err),
     'a ladder that outruns the shelf is refused whole, with the size of the problem');
  ok((await page.evaluate(() => DB.batches.length)) === 6,
     '...and leaves no half-built rungs or serial gaps behind');
  await page.click('#back'); await page.waitForTimeout(200);

  // Seating-depth tests sort on the axis that actually varies.
  await page.evaluate(() => {
    DB.batches = []; DB.sessions = [];
    [2.250, 2.235, 2.245].forEach((c, i) => DB.batches.push({ id: 'sd' + i, serial: 'SD' + i,
      recipe: DB.recipes[0].id, brassLot: DB.brassLots[0].id,
      bulletLot: DB.componentLots.find(x => x.kind === 'bullet').id,
      powderLot: DB.componentLots.find(x => x.kind === 'powder').id,
      primerLot: DB.componentLots.find(x => x.kind === 'primer').id,
      date: '2026-08-01', qty: 5, adjust: [], chargeActual: 41.5, cbtoMean: c,
      quarantine: false }));
    save(); go('workup', DB.recipes[0].id);
  });
  await page.waitForTimeout(250);
  const ax = await page.evaluate(() => workupRows(DB.recipes[0].id).axis);
  ok(ax === 'cbto',
     'with every charge identical and the seating varying, the table sorts on seating depth');
  const order = await page.evaluate(() => workupRows(DB.recipes[0].id).rows.map(r => r.cbto));
  ok(order.join(',') === '2.235,2.245,2.25', `...in order (${order.join(', ')})`);
}

section('the QR on the label opens the record');
{
  const serial = await page.evaluate(() => DB.batches[0].serial);
  const encoded = await page.evaluate(() => {
    go('label', DB.batches[0].id);
    return (DB.meta.baseUrl || '') + '/#/s/' + DB.batches[0].serial;
  });
  await page.waitForTimeout(200);
  ok(/#\/s\//.test(encoded),
     'the label encodes a fragment, which needs no host rewrite and works offline');

  // Scan the box: a COLD load straight at the link. A hash-only goto is a
  // same-document navigation and never re-runs start-up, which would make this
  // assert on whatever screen the previous section left behind.
  await page.goto('about:blank');
  await page.goto(BASE + '#/s/' + encodeURIComponent(serial));
  await page.waitForTimeout(600);
  const v = await page.textContent('#view');
  ok(v.includes(serial), 'opening the link lands on that batch, not on the Identify screen');
  ok((await page.evaluate(() => location.hash)) === '',
     '...and the link is consumed, so a later reload does not drag you back to it');
  await page.click('#back');
  await page.waitForTimeout(200);
  ok((await page.textContent('#view')).includes('By serial'),
     'Back goes to Identify rather than out of the app');

  /* A serial this browser has never seen gets a SCREEN, not a toast.
   *
   * The cause is almost never a missing batch: a phone camera opens a scanned
   * URL in the browser, and on iOS an installed home-screen app keeps its own
   * storage container. So the browser that opens has no records at all, and
   * every scan landed on an app that looked wiped with a toast saying nothing
   * carries that serial -- true, useless, and reading like the record is gone. */
  await page.goto('about:blank');
  await page.goto(BASE + '#/s/B26Z99-99Z');
  await page.waitForTimeout(600);
  const scanned = await page.textContent('body');
  ok(scanned.includes('B26Z99-99Z'), 'the scanned serial is shown');
  ok(/camera opens the/i.test(scanned) && /home screen/i.test(scanned),
     'and the screen explains WHY this browser has no record of it');
  ok(await page.locator('[data-act="copySerial"]').count() === 1,
     'with a copy button, because pasting it into the real app is the next step');
  ok((await page.textContent('.serialbig')).trim() === 'B26Z99-99Z',
     '...and the serial is selectable by hand if the clipboard is refused');
  ok((await page.evaluate(() => location.hash)) === '',
     'the link is still consumed');
}

section('import cannot quietly replace a bench');
{
  await page.evaluate(() => reset('data'));
  await page.waitForTimeout(200);
  const outcome = await page.evaluate(async () => {
    const asked = [];
    const real = window.confirm;
    window.confirm = (m) => { asked.push(m); return false; };
    const before = JSON.stringify(DB);
    const file = new File([JSON.stringify({ meta: { schema: 3 }, cartridges: [],
      firearms: [], componentLots: [], brassLots: [], recipes: [], batches: [], sessions: [] })],
      'bench.json', { type: 'application/json' });
    const input = document.getElementById('importFile');
    const dt = new DataTransfer(); dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
    const after = JSON.stringify(DB);
    window.confirm = real;
    return { asked, unchanged: before === after };
  });
  ok(outcome.asked.length === 1, 'importing over an existing bench asks first');
  ok(/Replace everything/.test(outcome.asked[0] || ''), '...saying that it replaces rather than merges');
  ok(/batches: \d+ → 0/.test(outcome.asked[0] || ''),
     '...and counting both sides, because "0 batches" means nothing without "you have some"');
  ok(/cannot be undone/.test(outcome.asked[0] || ''), '...and that it is irreversible');
  ok(outcome.unchanged, 'declining leaves the bench exactly as it was');
}

/* =============================================================== persistence */
section('persistence across a real reload');
{
  const before = await page.evaluate(() => ({
    carts: DB.cartridges.length, firearms: DB.firearms.length, lots: DB.componentLots.length,
    brass: DB.brassLots.length, recipes: DB.recipes.length, batches: DB.batches.length,
    sessions: DB.sessions.length, serial: DB.batches[0].serial,
  }));
  ok((await page.evaluate(() => Store.persistent)) === true, 'storage reports itself as persistent');

  await page.reload();
  await page.waitForTimeout(500);

  const after = await page.evaluate(() => ({
    carts: DB.cartridges.length, firearms: DB.firearms.length, lots: DB.componentLots.length,
    brass: DB.brassLots.length, recipes: DB.recipes.length, batches: DB.batches.length,
    sessions: DB.sessions.length, serial: DB.batches[0].serial,
  }));
  ok(JSON.stringify(before) === JSON.stringify(after),
     'every record survives a reload' + (JSON.stringify(before) === JSON.stringify(after)
       ? '' : `\n        before ${JSON.stringify(before)}\n        after  ${JSON.stringify(after)}`));

  // and survives a brand new tab on the same origin
  const p2 = await ctx.newPage();
  await p2.goto(BASE);
  await p2.waitForTimeout(400);
  const other = await p2.evaluate(() => DB.batches[0].serial);
  ok(other === before.serial, 'the same data is visible in a new tab');
  await p2.close();

  // settings changes persist too
  await page.evaluate(() => reset('settings'));
  await page.waitForTimeout(150);
  await page.click('[data-act="palToggle"][data-idx="4"]');   // enable Yellow
  await page.waitForTimeout(150);
  await page.reload();
  await page.waitForTimeout(400);
  ok((await page.evaluate(() => DB.meta.scheme.palette[4].on)) === true,
     'a marking-scheme change survives a reload');
}

/* ============================================================ offline / PWA */
section('installable and offline');
{
  const manifest = await page.evaluate(async () => {
    const r = await fetch('manifest.webmanifest');
    return r.ok ? await r.json() : null;
  });
  ok(manifest && manifest.name && manifest.icons.length >= 3, 'the manifest is served and complete');
  ok(manifest.icons.some(i => i.purpose === 'maskable'), 'a maskable icon is declared');

  const swReady = await page.evaluate(() =>
    navigator.serviceWorker.ready.then(r => !!r.active).catch(() => false));
  ok(swReady, 'the service worker registers and activates');

  await ctx.setOffline(true);
  await page.reload();
  await page.waitForTimeout(600);
  const offlineOk = (await page.innerHTML('#view')).length > 50;
  ok(offlineOk, 'the app loads from cache with the network off');
  ok((await page.evaluate(() => DB.batches.length)) === 3
     && (await page.evaluate(() => DB.brassLots.length)) === 1,
     '...with data intact');

  // Zero owns the root of this origin. Bench's worker is registered from
  // /bench/, so its scope is /bench/ and it is never consulted about anything
  // above it -- which is what keeps a signal-less phone from being shown Bench
  // when it asked for Zero. Assert the scope rather than trusting the layout.
  const scope = await page.evaluate(() =>
    navigator.serviceWorker.ready.then(r => r.scope).catch(() => 'none'));
  ok(scope.endsWith('/bench/'),
     `Bench's worker is confined to /bench/ (${scope})`);

  const errsBefore = errors.length;
  const strayed = await page.evaluate(async () => {
    try {
      const r = await fetch('/index.html');           // Zero's territory
      return r.ok ? 'body:' + (await r.text()).slice(0, 300) : `status:${r.status}`;
    } catch (e) { return 'network-error'; }
  });
  /* What must NOT come back is Bench's own page.
   *
   * The first version of this asserted `strayed === 'network-error'` on the
   * reasoning that the context is offline. It is, but Chromium's offline
   * emulation does not apply to loopback, so the request reaches the harness
   * and gets an honest 404 -- there is no Zero in this harness to serve. That
   * 404 is the proof, not a failure: it means the request went to the NETWORK
   * rather than being answered out of Bench's cache.
   *
   * So the assertion is about the body, which is what a user would actually
   * be looking at. Anything that is not Bench's shell is a pass; Bench's shell
   * is the bug -- offline, on a phone, it is indistinguishable from Zero
   * having been replaced by the wrong app. */
  const servedBench = strayed.startsWith('body:') && /id="view"|Bench/.test(strayed);
  ok(!servedBench,
     `...so the root is not served out of Bench's cache (${strayed.slice(0, 60)})`);
  // That probe deliberately fetches with the network off, and the browser logs
  // the failed load. Drop exactly those entries rather than muting the hygiene
  // check, which would then miss a real error raised anywhere else.
  errors.splice(errsBefore, errors.length - errsBefore,
    ...errors.slice(errsBefore).filter(e =>
      !/ERR_INTERNET_DISCONNECTED|status of 404/.test(e)));
  await shot('08-offline');
  await ctx.setOffline(false);
}

/* ============================================================== build stamp */
/* Which build is on the phone, readable from the phone. Without it, "the fix
 * did not work" and "the fix is not on this device" look identical, and the
 * wrong half of the system gets debugged. */
section('the build says which build it is');
{
  await page.click('[data-act="tab"][data-arg="more"]');
  await page.waitForTimeout(150);
  const more = await page.textContent('#view');
  ok(/build .+/.test(more), 'the More screen names the build');
  const id = await page.evaluate(() => (typeof BUILD_ID === 'string' ? BUILD_ID : null));
  ok(typeof id === 'string' && id.length > 4, `and it is injected at build time (${id})`);
  ok(more.includes(id), '...the same one the screen shows');

  /* The worker is registered at a URL that changes every build. A cache
   * anywhere in the chain -- browser, CDN, proxy -- can hold `sw.js`, and
   * holding THAT file means an installed app never learns a new build exists.
   * Observed in production: the bare URL served a previous deployment's worker
   * while the same path with any query string served the current one. */
  const swUrl = await page.evaluate(async () => {
    const rs = await navigator.serviceWorker.getRegistrations();
    return rs.map(r => (r.active || r.installing || r.waiting)?.scriptURL).find(Boolean) || null;
  });
  ok(!!swUrl && /sw\.js\?v=/.test(swUrl), `the worker is registered with a build query (${swUrl})`);
  ok(!!swUrl && swUrl.includes(encodeURIComponent(id).slice(0, 8)),
     '...carrying this build, so a new build cannot be answered from the old one');
  const scope = await page.evaluate(async () => {
    const rs = await navigator.serviceWorker.getRegistrations();
    return rs[0]?.scope || null;
  });
  ok(!!scope && scope.endsWith('/bench/'),
     `and the query does not move the scope, which comes from the path (${scope})`);
}

/* ================================ Identify survives a lot with no markings */
/* `l.marks[p.id]` on a lot that has no `marks` key at all. A lot recorded
 * before the marking scheme existed, or restored from a backup written then,
 * or imported from a file -- none of those paths validate the record, and
 * `migrate` backfills `anneals` and `annealEvery` but never `marks`.
 *
 * It did not throw on load: every position starts on '?', which short-circuits
 * before the access, so the screen painted and the counter read "2 of 2 match".
 * It threw on the first swatch tap -- the actual Identify gesture -- out of a
 * `.filter` over the WHOLE collection, so one bad lot killed matching for
 * every lot. And because the throw escaped before `innerHTML` was assigned,
 * the previous screen stayed put: no error, no crash screen, just a swatch
 * that would not light up. A dead control is the worst kind of bug to report,
 * because there is nothing to report.
 *
 * Its own context: this seeds a deliberately malformed database, and the
 * sections after this one read the bench the main page has been building. */
section('identify, with a lot that predates the marking scheme');
{
  const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await c.newPage();
  const thrown = [];
  p.on('pageerror', e => thrown.push(e.message));
  await p.goto(BASE);
  await p.evaluate(() => {
    localStorage.setItem('reloading.Bench', JSON.stringify({
      meta: { schema: 4 },
      cartridges: [], firearms: [], componentLots: [], recipes: [], batches: [], sessions: [],
      brassLots: [
        // The one that predates marking. No `marks` key at all.
        { id: 'bl_old', name: 'Lapua 6.5CM', qty: 100, headstamp: 'LAPUA', acquired: '2024-01-01' },
        { id: 'bl_new', name: 'Peterson 6.5CM', qty: 100, headstamp: 'PETERSON',
          acquired: '2025-01-01', marks: { neck: 'R', head: 'K' } },
      ],
    }));
  });
  await p.reload();
  await p.waitForTimeout(500);
  await p.click('[data-act="tab"][data-arg="lookup"]');
  await p.waitForTimeout(250);

  ok(thrown.length === 0, 'the Identify screen paints with an unmarked lot on the bench');

  // The gesture itself: a red neck band. bl_new matches, bl_old must not.
  await p.click('[data-act="pick"][data-pos="neck"][data-val="R"]');
  await p.waitForTimeout(250);
  ok(thrown.length === 0,
     `tapping a swatch does not throw (${thrown[0] || 'no error'})`);
  const body = await p.textContent('body');
  ok(/1 of 2 match/.test(body) && /PETERSON/.test(body),
     'the marked lot is identified — the control is live, not dead');
  ok(!/LAPUA/.test(body),
     '...and the unmarked lot does not match a colour it was never painted');

  /* And the source, not just the symptom: boot normalises the record, so every
   * other reader of `marks` gets an object rather than each one guarding. */
  ok(await p.evaluate(() => {
    const l = DB.brassLots.find(x => x.id === 'bl_old');
    return !!l && !!l.marks && typeof l.marks === 'object';
  }), 'and the lot itself was normalised on load, rather than guarded one call site at a time');
  await c.close();
}

/* ============================ the date defaults to the loader's day, not UTC's */
/* `today()` was the UTC day, and it defaults the date on every batch, session
 * and brass event. West of UTC that is wrong for the entire evening. The
 * batch serial is the consequence with teeth: it ENCODES the date, so a box
 * loaded at 8pm in Colorado was stamped with tomorrow's letter and the label
 * on the ammo can disagreed with the bench notes. `fmtDate` already pinned the
 * read side to noon local for exactly this reason; the write side never got it.
 *
 * Run in a context frozen at an instant where UTC and local disagree, so this
 * cannot pass by accident on a machine that happens to run in UTC. */
section('the day the loader is standing in');
{
  const FROZEN = Date.UTC(2026, 7, 2, 3, 30, 0);   // 2026-08-01 20:30 in Denver
  const dayIn = async (tz) => {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: tz });
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
    await p.waitForTimeout(500);
    const out = await p.evaluate(() => ({
      local: today(),
      utc: new Date().toISOString().slice(0, 10),
      serial: Serial.batchSerial(today(), new Set()),
    }));
    await c.close();
    return out;
  };

  const west = await dayIn('America/Denver');
  ok(west.local === '2026-08-01',
     `an evening at the bench west of UTC is dated today, not tomorrow (${west.local})`);
  ok(west.utc === '2026-08-02',
     '...and the UTC day at that same instant is the 2nd — the answer the old code gave');
  ok(/^B26H01/.test(west.serial),
     `so the serial stamped on the box carries the right day (${west.serial})`);

  /* The other side of the line, because a fix that just subtracts a day is a
   * different bug: that instant is already the 2nd in Tokyo. */
  const east = await dayIn('Asia/Tokyo');
  ok(east.local === '2026-08-02',
     `and east of UTC the local day is the later one, not a blanket day back (${east.local})`);
}

/* ================================================================== hygiene */
section('hygiene');
{
  const small = await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('button,input,select,a').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.height < 36 && el.type !== 'range') {
        bad.push(el.tagName + '.' + el.className);
      }
    });
    return bad;
  });
  ok(small.length === 0, `no touch target under 36px (${small.slice(0, 3).join(', ')})`);

  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(overflow === 0, `no horizontal overflow (${overflow}px)`);

  ok(errors.length === 0, 'no JavaScript errors across the whole run'
     + (errors.length ? '\n        ' + errors.slice(0, 4).join('\n        ') : ''));
}

/* ================================================ the wrong-powder warning */
/* THE most safety-relevant logic in either app. Bench compares the components a
 * batch was actually built with against the ones its recipe cites, and raises a
 * "DOES NOT MATCH RECIPE" band — on screen and on the printed box label —
 * because charge weights are not transferable between powders.
 *
 * It got this wrong in the one case that matters most. `coreTokens` strips the
 * maker as noise, which is right for bullets ("Berger 140 Hybrid" vs "140
 * Hybrid") and wrong for powder: strip the makers off "Hodgdon H4350" and "IMR
 * 4350" and you have `h4350` against `4350`, which the containment rule then
 * calls a match. Two different powders, different burn rates, and no warning
 * anywhere — while the batch is checked against the OTHER powder's published
 * maximum. H4350/IMR4350, H4831/IMR4831 and H4895/IMR4895 are exactly the pairs
 * a handloader confuses at the bench.
 *
 * Asserted as a battery rather than one case, because the fix has to hold a
 * line: strict enough to catch these, loose enough that "Fed GM210M" still
 * matches "Federal 210M" — a warning that cries wolf is a warning nobody
 * reads. */
console.log('\nthe wrong-powder warning');
{
  const cases = [
    ['Hodgdon H4350', 'IMR 4350', false, 'same number, DIFFERENT powder'],
    ['Hodgdon H4831', 'IMR 4831', false, '...and 4831'],
    ['Hodgdon H4895', 'IMR 4895', false, '...and 4895'],
    ['Alliant Reloder 16', 'Alliant Reloder 26', false, 'different Reloder'],
    ['Berger 140gr Hybrid', 'Berger 140gr VLD', false, 'same weight, different bullet'],
    ['Hodgdon H4350', 'H4350', true, 'a maker on one side only is not a contradiction'],
    ['Berger 140gr Hybrid', 'Berger 140 Hybrid', true, 'the same bullet spelled differently'],
    ['Fed GM210M', 'Federal 210M', true, 'one maker under two spellings'],
  ];
  const got = await page.evaluate((cs) => cs.map(([a, b]) => namesAgree(a, b)), cases);
  cases.forEach(([a, b, want, why], i) => {
    ok(got[i] === want,
       `${why}: ${a} vs ${b} -> ${got[i]}${got[i] === want ? '' : ` (want ${want})`}`);
  });

  /* And end to end, because agreeing on names is only half of it: the batch
   * screen has to actually raise the band. */
  const banner = await page.evaluate(() => {
    DB.cartridges = [{ id: 'cz', name: '6.5 Creedmoor' }];
    DB.componentLots = [{ id: 'lz', serial: 'C-Z', kind: 'powder', name: 'IMR 4350',
                          lot: 'X', qty: 8, unit: 'lb', cost: 300 }];
    DB.recipes = [{ id: 'rz', name: 'workup', cartridge: 'cz', powder: 'Hodgdon H4350',
                    bullet: 'Berger 140gr Hybrid', primer: 'Fed GM210M',
                    charge: 41.5, source: 'Hodgdon', sourceMax: 41.8 }];
    DB.batches = [{ id: 'bz', serial: 'B26Z01-01A', recipe: 'rz', powderLot: 'lz',
                    date: '2026-08-01', qty: 50 }];
    save();
    return batchMismatches(DB.batches[0]).map(m => `${m.what}:${m.severity}`);
  });
  ok(banner.includes('Powder:stop'),
     `the batch raises a STOP-severity powder mismatch (${banner.join(', ') || 'nothing'})`);
}

/* ============================================ the strip under the tab bar */
/* Bench's bar is the last row of a `height:100dvh` column. On iOS in
 * standalone mode that column can end ABOVE the physical bottom of the screen,
 * and the home-indicator strip beneath it then paints the PAGE background — a
 * dark band under the icons that reads as a misaligned bar. Zero does not have
 * it, because its bar is `position:fixed; bottom:0` and on the same device
 * that is the physical bottom. Two apps on one home screen, one visibly short.
 *
 * Chromium reports no safe-area insets, so `--safe-b` is 0 and this renders
 * perfectly headless whether it is fixed or not. Overriding the variable and
 * shortening the column reproduces the device: every rule involved reads the
 * inset through that variable, so this exercises exactly the code that was
 * getting it wrong. */
console.log('\nthe strip under the tab bar');
{
  await page.addStyleTag({ content: `:root{--safe-b:34px !important}
                                     body{height:calc(100dvh - 34px) !important}` });
  await page.waitForTimeout(200);
  const strip = await page.evaluate(() => {
    const h = document.documentElement.clientHeight;
    const bar = document.querySelector('nav.tabs');
    const barBottom = bar.getBoundingClientRect().bottom;
    const gap = Math.round(h - barBottom);
    const shim = document.querySelector('.tabshim');
    const r = shim && shim.getBoundingClientRect();
    const cs = shim && getComputedStyle(shim);
    return {
      gap,
      covers: !!(r && r.top <= barBottom + 1 && r.bottom >= h - 1),
      bg: cs && cs.backgroundColor,
      barBg: getComputedStyle(bar).backgroundColor,
      behind: cs && parseInt(cs.zIndex, 10) < parseInt(getComputedStyle(bar).zIndex, 10),
      taps: cs && cs.pointerEvents,
    };
  });
  ok(strip.gap > 1, `the shortened column leaves a ${strip.gap}px strip, as a notched phone does`);
  ok(strip.covers, '...and something paints it rather than letting the page show through');
  ok(strip.bg === strip.barBg, '...in the tab bar\'s own colour, so it reads as one bar');
  /* Behind, not over: where the column already reaches the physical bottom the
   * bar must cover the shim completely rather than the shim covering the
   * bottom of the buttons. */
  ok(strip.behind, '...behind the bar, so where there is no inset it costs nothing');
  ok(strip.taps === 'none', '...and it can never eat a tap meant for a tab');
}

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
