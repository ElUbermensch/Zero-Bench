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

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('nope');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

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
  ok(/x="248"[^>]*fill="#d92b2b"/.test(svg),
     'a marked case head paints the base of the case in the diagram');
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
  const heights = [...svg2.matchAll(/x="248" y="([\d.]+)" width="14" height="([\d.]+)"/g)];
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
  await page.evaluate(() => {
    DB.batches.push({ ...DB.batches[0], id: 'bx2', serial: 'BX2',
      date: '2026-09-01', qty: 97 });
    DB.sessions.push({ id: 'sf6', batch: 'bx2',
                       date: '2026-09-02', rounds: 97, distance: 100, pressureSigns: 'none' });
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

  await page.click(`[data-act="delSession"][data-arg="${sid}"]`);
  await page.waitForTimeout(250);
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
  await page.click('[data-act="unadjust"]');
  await page.waitForTimeout(200);
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
  await shot('07-label');
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
  ok((await page.evaluate(() => DB.batches.length)) === 1, '...with data intact');

  // Both apps are served from one origin -- Bench at /, Zero at /zero/ -- so
  // this worker's scope contains Zero's. Its offline fallback must not answer
  // for Zero, or a phone with no signal shows Bench when you opened Zero.
  const errsBefore = errors.length;
  const strayed = await page.evaluate(async () => {
    try {
      const r = await fetch('zero/index.html');
      return r.ok ? (await r.text()).slice(0, 400) : `status:${r.status}`;
    } catch (e) { return 'network-error'; }
  });
  // 'network-error' means this worker declined to handle it at all, which is
  // the invariant that matters. Without the scope guard the worker intercepts
  // and answers ('status:404' here, and Bench's own cached page on a real
  // deploy where /zero/ is a sibling directory rather than a missing file).
  ok(strayed === 'network-error',
     `Bench's worker declines requests under /zero/ entirely (${strayed})`);
  // That probe deliberately fetches with the network off, and the browser logs
  // the failed load. Drop exactly those entries rather than muting the hygiene
  // check, which would then miss a real error raised anywhere else.
  errors.splice(errsBefore, errors.length - errsBefore,
    ...errors.slice(errsBefore).filter(e => !/ERR_INTERNET_DISCONNECTED/.test(e)));
  await shot('08-offline');
  await ctx.setOffline(false);
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

await browser.close();
server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
