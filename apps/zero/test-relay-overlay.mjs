/* The coach's overlay: one target face, both strings — and the check that
 * decides whether that picture is honest.
 *
 * In competition a pair is on the same paper at the same distance, and a coach
 * calls corrections off the rings and the grid. They were getting two coloured
 * dots on an empty square, because relay_state strips `target_rings` from every
 * poll (correctly — it is static geometry) and nothing ever fetched it any
 * other way. Migration 0009 adds `relay_face()` for the paper, and
 * `relay_participants.target_name` so "same target" is a question that can be
 * asked at all.
 *
 * test-relay.mjs covers the refusal — its two shooters are deliberately on
 * different lines. This one covers the two cases that file cannot: agreement,
 * where the face must be drawn, and a disagreement about the TARGET rather
 * than the distance.
 *
 * Three devices, real browser profiles, driving real buttons. Nothing calls
 * the relay API to make something appear.
 */
import { chromium } from 'playwright';
import fsx from 'node:fs';
import http from 'node:http';
import fs from 'node:fs';
import { startMock } from '../../packages/zero-core/mock-supabase.mjs';
import { buildZero } from './build.mjs';

const CHROME = '/opt/pw-browsers/chromium';
const LAUNCH_OPTS = fsx.existsSync(CHROME) ? { executablePath: CHROME } : {};

const mock = await startMock({ ttlSec: 3600 });
const OUT = 'dist-test-overlay';
await buildZero({ url: mock.url, anonKey: 'anon-key', outdir: OUT, single: false });
const server = http.createServer((req, res) => {
  const f = OUT + '/' + (req.url.split('?')[0] === '/' ? 'index.html' : req.url.slice(1));
  if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : 'text/html' });
  res.end(fs.readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const section = s => console.log('\n' + s);

const browser = await chromium.launch(LAUNCH_OPTS);
const errs = [];

async function device(label, { seed, email } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(`${label}: ${e.message}`));
  await page.goto(BASE);
  await page.evaluate(s => {
    localStorage.clear();
    if (s) localStorage.setItem('sessions_v1', JSON.stringify(s));
  }, seed || null);
  await page.reload();
  await page.waitForTimeout(700);
  if (email) {
    await page.fill('input[placeholder="email"]', email);
    await page.fill('input[placeholder="password"]', 'pw12345');
    await page.click('button:has-text("create account")');
    await page.waitForTimeout(700);
  }
  return { ctx, page, label };
}

const mkSession = (id, name, yards, targetId) => ([{
  id, name, date: '2026-08-22', type: 'Score',
  position: 'Standing', targetId, rangeYards: yards,
  rangeLocation: 'club', rifleId: '', ammoId: '', ts: 1, matchId: null,
  shots: [0, 1, 2].map(i => ({
    id: id + '-s' + i, ring: '10', clockH: 12, clockM: 0,
    xy: { x: i * 0.2 - 0.2, y: 0.3 }, callXY: { x: 0, y: 0 }, elev: 0, wind: 0,
  })),
}]);

const codeFrom = (page) => page.evaluate(() => {
  const el = [...document.querySelectorAll('div')]
    .find(d => /^[2-9BCDFGHJKMNPQRSTVWXZ]{4}$/.test(d.textContent.trim()) && !d.children.length);
  return el ? el.textContent.trim() : null;
});

const faceShown = async (pg) =>
  (await pg.locator('.tcard:has-text("Both strings") [data-face]').count()) > 0;
const plotText = (pg) => pg.locator('.tcard:has-text("Both strings")').textContent();

/* ════════════════════════════ same target, same line — the competition case */
section('two shooters on the same target at the same distance');

const A = await device('A', { seed: mkSession('sA', 'Sunday league', 200, 'sr'), email: 'ov-a@example.com' });
await A.page.click('text=Sunday league');
await A.page.waitForTimeout(400);
await A.page.fill('input[placeholder="your name"]', 'Jaxon');
await A.page.click('button:has-text("go live")');
await A.page.waitForTimeout(1200);
const code = await codeFrom(A.page);
ok(!!code, `A is live with a code (${code})`);

const B = await device('B', { seed: mkSession('sB', 'Same firing point', 200, 'sr'), email: 'ov-b@example.com' });
await B.page.click('text=Same firing point');
await B.page.waitForTimeout(400);
await B.page.click('button:text-is("join")');
await B.page.waitForTimeout(300);
await B.page.fill('input[placeholder="CODE"]', code);
await B.page.fill('input[placeholder="your name"]', 'Partner Pete');
await B.page.click('button:has-text("join live")');
await B.page.waitForTimeout(1500);

const C = await device('C', { email: 'ov-c@example.com' });
await C.page.click('button:has-text("join")');
await C.page.waitForTimeout(300);
await C.page.fill('input[placeholder="CODE"]', code);
await C.page.selectOption('select', 'coach');
await C.page.click('button:has-text("join live")');
await C.page.waitForTimeout(2200);

const bodyC = await C.page.textContent('body');
ok(bodyC.includes('Jaxon') && bodyC.includes('Partner Pete'), 'the coach sees both shooters');
ok(await faceShown(C.page),
   'the combined plot draws the real target face, not a bare grid');

const note = await plotText(C.page);
ok(/same target, same line/i.test(note),
   'and says why it is entitled to: same target, same line');
ok(/SR/.test(note) && /200yd/.test(note),
   `naming the paper and the distance it is drawn at (${(note.match(/SR[^—]*/) || [''])[0].trim()})`);

/* The geometry must come from relay_face, not from the poll: relay_state
 * strips target_rings, and a mock that leaked it hid the empty coach plot for
 * a month. Assert on the wire, not on the picture alone. */
ok((mock.state.hits.rpc.relay_face || 0) >= 1,
   `the paper came from relay_face (${mock.state.hits.rpc.relay_face || 0} calls)`);
ok((mock.state.hits.rpc.relay_state || 0) > (mock.state.hits.rpc.relay_face || 0) * 2,
   `and NOT from the poll, which ran far more often (${mock.state.hits.rpc.relay_state} polls `
   + `vs ${mock.state.hits.rpc.relay_face} face fetches)`);
const relayRow = [...mock.state.relays.values()][0];
ok(Array.isArray(relayRow?.target_rings?.rings) && relayRow.target_rings.rings.length > 0,
   'the geometry is on the relay row, which is what relay_face reads');

/* ═══════════════════════════════ same line, DIFFERENT paper — must refuse */
section('a partner on a different target');

const A2 = await device('A2', { seed: mkSession('sA2', 'Second relay', 200, 'sr'), email: 'ov-a2@example.com' });
await A2.page.click('text=Second relay');
await A2.page.waitForTimeout(400);
await A2.page.fill('input[placeholder="your name"]', 'Host Two');
await A2.page.click('button:has-text("go live")');
await A2.page.waitForTimeout(1200);
const code2 = await codeFrom(A2.page);

// Same 200 yards, MR-1 paper instead of SR: the distance agrees and the target
// does not, which is the half test-relay.mjs cannot reach.
const B2 = await device('B2', { seed: mkSession('sB2', 'Other paper', 200, 'mr1'), email: 'ov-b2@example.com' });
await B2.page.click('text=Other paper');
await B2.page.waitForTimeout(400);
await B2.page.click('button:text-is("join")');
await B2.page.waitForTimeout(300);
await B2.page.fill('input[placeholder="CODE"]', code2);
await B2.page.fill('input[placeholder="your name"]', 'Wrong Paper Pete');
await B2.page.click('button:has-text("join live")');
await B2.page.waitForTimeout(1500);

const C2 = await device('C2', { email: 'ov-c2@example.com' });
await C2.page.click('button:has-text("join")');
await C2.page.waitForTimeout(300);
await C2.page.fill('input[placeholder="CODE"]', code2);
await C2.page.selectOption('select', 'coach');
await C2.page.click('button:has-text("join live")');
await C2.page.waitForTimeout(2200);

ok(!(await faceShown(C2.page)),
   'two shooters on different paper get NO face, even on the same line');
const note2 = await plotText(C2.page);
ok(/different targets/i.test(note2), 'the plot says the targets disagree');
ok(/SR/.test(note2) && /MR-1/.test(note2),
   `naming both, so the coach can see which shooter is on what (${(note2.match(/\\(([^)]*)\\)/) || [])[1] || ''})`);
ok(await C2.page.locator('.tcard:has-text("Both strings") svg circle').count() >= 6,
   'the strings are still plotted — refusing the face is not refusing the picture');

/* ══════════════════════════════════════════════════════════════════ hygiene */
section('hygiene');
ok(errs.length === 0, 'no JavaScript errors on any device' +
   (errs.length ? ' — ' + errs.slice(0, 2).join(' | ') : ''));

await browser.close();
server.close();
mock.close && mock.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
