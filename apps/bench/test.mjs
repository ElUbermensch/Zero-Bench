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
  ok((await page.evaluate(() => DB.batches[0].remaining)) === 50, 'rounds remaining decrements');
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
  await page.evaluate(() => { const b = DB.batches[0]; b.remaining = 0; save(); });
  ok((await page.evaluate(() => brassAvailable(DB.brassLots[0]))) === 100,
     'firing a batch off returns its cases to the lot');
  await page.evaluate(() => { const b = DB.batches[0]; b.remaining = 50; save(); });

  // Deleting a batch must put everything back, with no restore code to forget.
  const before = await page.evaluate(() => lotLeft(DB.componentLots.find(c => c.kind === 'bullet')));
  await page.evaluate(() => { DB.batches = DB.batches.filter(b => b.id !== DB.batches[0].id); save(); });
  ok((await page.evaluate(() => lotLeft(DB.componentLots.find(c => c.kind === 'bullet')))) === 500,
     'deleting a batch returns its components, because stock is derived not stored');
  ok(before === 440, '...having genuinely been drawn down beforehand');
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
