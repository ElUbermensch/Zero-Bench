/* Screenshot the Bench batch screen with a real string on it, so the plot can
 * be looked at rather than described. Not part of the suite — a one-off the
 * suite's fixtures happen to make cheap. */
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startMock } from '../packages/zero-core/mock-supabase.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/opt/pw-browsers/chromium';
const LAUNCH = fs.existsSync(CHROME) ? { executablePath: CHROME } : {};

const mock = await startMock({ ttlSec: 3600 });
execFileSync(process.execPath, [path.join(ROOT, 'apps/bench/build.mjs')], {
  stdio: 'pipe', env: { ...process.env, SUPABASE_URL: mock.url, SUPABASE_ANON_KEY: 'anon-key' },
});

const DIR = path.join(ROOT, 'apps/bench/dist');
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const f = path.join(DIR, p);
  if (!f.startsWith(DIR) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); return res.end();
  }
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  fs.createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch(LAUNCH);
const page = await browser.newPage({ viewport: { width: 390, height: 1500 },
                                     deviceScaleFactor: 2 });
await page.goto(BASE);
await page.waitForTimeout(500);

/* A real string: ten record shots in a plausible group with one thrown left,
 * plus two sighters well off call. Coordinates are target inches. */
await page.evaluate(() => {
  const SR = { rings: [
    { score: 'X', diam: 3.0, color: '#1a1814' }, { score: '10', diam: 7.0, color: '#1a1814' },
    { score: '9', diam: 13.0, color: '#1a1814' }, { score: '8', diam: 19.0, color: '#ffffff' },
    { score: '7', diam: 25.0, color: '#ffffff' }, { score: '6', diam: 31.0, color: '#ffffff' },
    { score: '5', diam: 37.0, color: '#ffffff' } ] };
  const record = [
    [0.10, 0.22, 'X'], [-0.18, 0.05, 'X'], [0.31, -0.14, 'X'], [-0.05, -0.30, 'X'],
    [0.44, 0.36, '10'], [-0.40, 0.28, '10'], [0.22, -0.52, '10'], [-0.33, -0.44, '10'],
    [0.58, -0.08, '10'], [-1.42, 0.66, '9'],
  ];
  DB.cartridges = [{ id: 'ca1', name: '6.5 Creedmoor' }];
  DB.firearms = [{ id: 'f1', name: 'Bergara B14 HMR', cartridge: 'ca1', barrel: 24, twist: '1:8' }];
  DB.componentLots = [
    { id: 'cl1', serial: 'C-1', kind: 'bullet', name: 'Berger 140gr Hybrid', lot: 'BG-0326',
      qty: 500, unit: 'ea', cost: 289, weightGr: 140, bcG7: 0.311 },
    { id: 'cl2', serial: 'C-2', kind: 'powder', name: 'Hodgdon H4350', lot: 'H-1177',
      qty: 8, unit: 'lb', cost: 311.2 },
    { id: 'cl3', serial: 'C-3', kind: 'primer', name: 'Fed GM210M', lot: 'GM-K3',
      qty: 1000, unit: 'ea', cost: 119.99 },
  ];
  DB.recipes = [{ id: 'r1', name: '6.5CM / 140 Hybrid / H4350', cartridge: 'ca1',
    bullet: 'Berger 140gr Hybrid', powder: 'Hodgdon H4350', primer: 'Fed GM210M',
    charge: 41.5, coal: 2.81, source: 'Hodgdon 2024', page: '112', sourceMax: 43 }];
  DB.batches = [{ id: 'ba1', serial: 'B26H01-01F', recipe: 'r1', bulletLot: 'cl1',
    powderLot: 'cl2', primerLot: 'cl3', date: '2026-08-01', qty: 100,
    chargeActual: 41.52, chargeSd: 0.02, coalMean: 2.809 }];
  DB.sessions = [{
    id: 'se1', batch: 'ba1', firearm: 'f1', date: '2026-08-20', rounds: 12,
    distance: 100, group: 2.09, temp: 74, pressureSigns: 'none',
    vAvg: 2712, vSd: 7.4, vEs: 20,
    targetName: 'SR', targetFace: SR,
    notes: 'first string of the morning · switching wind',
    shots: [
      ...record.map(([x, y, ring], i) => ({ remote: 'r' + i, n: i + 1, x, y, ring,
        sighter: false, callX: x - 0.12, callY: y + 0.08 })),
      { remote: 'rs1', n: 11, x: 2.4, y: 1.7, ring: '9', sighter: true, callX: 0.2, callY: 0.1 },
      { remote: 'rs2', n: 12, x: -1.9, y: 1.2, ring: '9', sighter: true, callX: 0.1, callY: 0.0 },
    ],
  }];
  save();
  ACTIONS.ammoDetail('ba1');
});
await page.waitForTimeout(400);
await page.evaluate(() => {
  const d = document.querySelector('details');
  if (d) d.open = true;
});
await page.waitForTimeout(200);

const card = await page.locator('.card').filter({ hasText: 'Range results' }).first();
await card.screenshot({ path: path.join(ROOT, 'bench-shot-plot.png') });
console.log('wrote bench-shot-plot.png');

await browser.close(); server.close(); await mock.stop();
