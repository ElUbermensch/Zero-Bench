/* Pair fire, end to end, across two genuinely separate browser profiles.
 *
 * The claim under test is the user's own spec: "The shooter taps go live, gets
 * a code; a viewer taps join live, enters the code + name + role, and sees the
 * shooter's shot string, group plot, score and mean radius update as shots are
 * logged, plus a shared text feed."
 *
 * So the test drives the actual UI on both sides. It never calls the relay API
 * directly to make something appear -- if a button is not wired, this fails.
 */
import { chromium } from 'playwright';
import fsx from 'node:fs';
import http from 'node:http';
import fs from 'node:fs';
import { startMock } from '../../packages/zero-core/mock-supabase.mjs';

const CHROME = '/opt/pw-browsers/chromium';
const LAUNCH_OPTS = fsx.existsSync(CHROME) ? { executablePath: CHROME } : {};

const mock = await startMock({ ttlSec: 3600 });
const server = http.createServer((req, res) => {
  const f = 'dist/' + (req.url.split('?')[0] === '/' ? 'index.html' : req.url.slice(1));
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

/** A fresh context is a separate device, not a second tab: separate storage,
 *  separate zero-core instance, separate identity. */
async function device(label, { seed, email } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(`${label}: ${e.message}`));
  await page.goto(BASE);
  await page.evaluate(s => {
    localStorage.clear();
    if (s) localStorage.setItem('zs_sessions_v1', JSON.stringify(s));
  }, seed || null);
  await page.reload();
  await page.waitForTimeout(600);
  await page.fill('input[placeholder="https://YOUR-PROJECT.supabase.co"]', mock.url);
  await page.fill('input[placeholder="anon public key"]', 'anon-key');
  await page.click('button:has-text("save server")');
  await page.waitForTimeout(300);
  if (email) {
    await page.fill('input[placeholder="email"]', email);
    await page.fill('input[placeholder="password"]', 'pw12345');
    await page.click('button:has-text("create account")');
    await page.waitForTimeout(600);
  }
  return { ctx, page, label };
}

/** Log one shot through the real ShotEntry screen. Default ring, 12 o'clock:
 *  the point is the mirroring, not the coordinate entry. */
async function logShot(page) {
  await page.click('button:has-text("+ shot")');
  await page.waitForTimeout(300);
  await page.click('button:has-text("Log & done")');
  await page.waitForTimeout(500);
}

const HOST_SESSION = [{
  id: 'sHost', name: 'Sunday league', date: '2026-08-14', type: 'Score',
  position: 'Standing', targetId: 'any', rangeYards: 100, rangeLocation: 'club',
  rifleId: '', ammoId: '', ts: 1, matchId: null,
  shots: [
    { id: 's1', ring: '10', clockH: 12, clockM: 0, xy: { x: 0, y: 0 }, elev: 0, wind: 0 },
    { id: 's2', ring: '9', clockH: 3, clockM: 0, xy: { x: 0.4, y: 0 }, elev: 0, wind: 0 },
  ],
}];

/* ══════════════════════════════════════════════════════════ the shooter */
section('the shooter goes live');
const host = await device('host', { seed: HOST_SESSION, email: 'host@example.com' });
await host.page.click('text=Sunday league');
await host.page.waitForTimeout(400);

ok(await host.page.locator('button:has-text("go live")').count() === 1,
   'the session offers "go live"');

await host.page.fill('input[placeholder="your name"]', 'Jaxon');
await host.page.click('button:has-text("go live")');
await host.page.waitForTimeout(1200);

const hostBody1 = await host.page.textContent('body');
const code = (hostBody1.match(/read this out\s*([2-9BCDFGHJKMNPQRSTVWXZ]{4})/) || [])[1]
  || await host.page.evaluate(() => {
       const el = [...document.querySelectorAll('div')]
         .find(d => /^[2-9BCDFGHJKMNPQRSTVWXZ]{4}$/.test(d.textContent.trim())
                 && d.children.length === 0);
       return el ? el.textContent.trim() : null;
     });
ok(!!code && /^[2-9BCDFGHJKMNPQRSTVWXZ]{4}$/.test(code || ''),
   `a 4-character code is shown to read aloud (${code})`);
ok(hostBody1.includes('Nobody has joined yet'), 'the host is told nobody is watching yet');

// the two already-fired shots must be backfilled, or a coach joining mid-string
// sees an empty target
const relayId = [...mock.state.relays.values()][0]?.id;
ok(mock.state.relays.size === 1 && [...mock.state.relays.values()][0].status === 'live',
   'exactly one live relay exists on the server');
const backfilled = [...(mock.state.rows.get('relay_shots')?.values() || [])]
  .filter(s => s.relay_id === relayId);
ok(backfilled.length === 2, `the string already fired is backfilled (${backfilled.length})`);

await host.page.screenshot({ path: 'shots/relay-host.png', fullPage: true });

/* ══════════════════════════════════════════════════════════════ the coach */
section('the coach joins with the code and no account');
const coach = await device('coach');           // note: no email, no password
await coach.page.click('button:has-text("● join")');
await coach.page.waitForTimeout(300);
ok(await coach.page.locator('input[placeholder="CODE"]').count() === 1,
   'the join form is reachable from the home screen');

// wrong code first: the door must stay shut
await coach.page.fill('input[placeholder="CODE"]', 'BBBB');
await coach.page.fill('input[placeholder="your name"]', 'Coach Dave');
await coach.page.click('button:has-text("join live")');
await coach.page.waitForTimeout(700);
ok((await coach.page.textContent('body')).includes('No live relay with that code'),
   'a wrong code is refused with a readable reason');

await coach.page.fill('input[placeholder="CODE"]', code);
await coach.page.selectOption('select', 'coach');
await coach.page.click('button:has-text("join live")');
await coach.page.waitForTimeout(1500);

const coachBody1 = await coach.page.textContent('body');
ok(coachBody1.includes('Jaxon'), "the coach sees the shooter's name");
ok(coachBody1.includes('Sunday league'), '...and the session title');
ok(coachBody1.includes('● live'), '...and that the relay is live');
ok(await coach.page.locator('svg circle').count() > 0,
   'the group plot renders the backfilled shots');
// 10 + 9 = 19, mean radius of two points 0.4" apart = 0.20"
ok(coachBody1.includes('19\u20130X'), 'the score is computed from the relayed rings (19\u20130X)');
ok(coachBody1.includes('0.20'), 'mean radius is computed from the relayed coordinates (0.20")');
// 'Coach Dave' can only have come from the participant list -- nothing else
// on this screen knows the viewer's own name.
ok(coachBody1.includes('Coach Dave'), 'the participant list names everyone watching');

// the coach signed in anonymously -- "no accounts" is implemented, not implied
const anon = await coach.page.evaluate(() =>
  JSON.parse(localStorage.getItem('zerocore.session') || '{}')?.user?.is_anonymous);
ok(anon === true, 'the coach is on an anonymous identity, having created no account');

await coach.page.screenshot({ path: 'shots/relay-coach.png', fullPage: true });

/* ═════════════════════════════════════════════════════ shots flow forward */
section('shots reach the coach as they are logged');
// RelayPlot draws one circle per impact plus the dashed mean-radius ring, so
// the count is exact: 2 impacts + 1 ring, then 3 impacts + 1 ring.
const circlesBefore = await coach.page.locator('svg circle').count();
ok(circlesBefore === 3, `the plot starts at two impacts (${circlesBefore} circles)`);
await logShot(host.page);
await coach.page.waitForTimeout(4000);         // ~2 poll ticks at 2.5s
const coachBody2 = await coach.page.textContent('body');
const circlesAfter = await coach.page.locator('svg circle').count();
ok(circlesAfter === circlesBefore + 1,
   `one shot logged on the shooter's phone draws exactly one more impact on the coach's (${circlesAfter})`);
ok(await coach.page.locator('svg text').count() === 4,
   'the plot numbers three impacts');

/* ═══════════════════════════════════════════════════════ the feed is two-way */
section('the feed carries wind calls both ways');
await coach.page.fill('input[placeholder="message"]', 'half value from 4, hold 0.5L');
await coach.page.click('button:has-text("wind")');
await coach.page.waitForTimeout(4000);
const hostBody2 = await host.page.textContent('body');
ok(hostBody2.includes('half value from 4'), "the coach's wind call reaches the shooter");
ok(hostBody2.includes('Coach Dave'), '...attributed to the coach');
ok(!hostBody2.includes('Nobody has joined yet'), 'the host now shows a watcher');

await host.page.fill('input[placeholder="message"]', 'seen, dialling');
await host.page.click('button:has-text("send")');
await host.page.waitForTimeout(4000);
ok((await coach.page.textContent('body')).includes('seen, dialling'),
   "the shooter's reply reaches the coach");

/* ═══════════════════════════════════════════════════ only the host writes */
section('the coach cannot fabricate the string');
const forged = await coach.page.evaluate(async ({ base, rid }) => {
  const s = JSON.parse(localStorage.getItem('zerocore.session'));
  const r = await fetch(base + '/rest/v1/relay_shots', {
    method: 'POST',
    headers: { apikey: 'anon-key', Authorization: 'Bearer ' + s.access_token,
               'Content-Type': 'application/json' },
    body: JSON.stringify([{ relay_id: rid, shot_no: 99, ring: 'X', x_in: 0, y_in: 0 }]),
  });
  return r.status;
}, { base: mock.url, rid: relayId });
ok(forged === 403, `a viewer's own token is refused when writing shots (${forged})`);

/* ══════════════════════════════════════════════════════════ ending it */
section('ending the relay');
await host.page.click('button:text-is("end")');   // not "send", in the feed
await host.page.waitForTimeout(4000);
const coachBody3 = await coach.page.textContent('body');
ok(coachBody3.includes('ended'), 'the coach is told the relay ended rather than silently stalling');
ok(coachBody3.includes('final state'), '...and that what they are looking at is final');
ok((await host.page.locator('button:has-text("go live")').count()) === 1,
   'the shooter can go live again');

// the code is dead the moment the relay ends
const stranger = await device('stranger');
await stranger.page.click('button:has-text("● join")');
await stranger.page.waitForTimeout(300);
await stranger.page.fill('input[placeholder="CODE"]', code);
await stranger.page.fill('input[placeholder="your name"]', 'late');
await stranger.page.click('button:has-text("join live")');
await stranger.page.waitForTimeout(800);
ok((await stranger.page.textContent('body')).includes('No live relay with that code'),
   'the code stops working once the relay ends');

/* ══════════════════════════════════════════════════════════════ hygiene */
section('hygiene');
ok(errs.length === 0, errs.length ? 'JS errors: ' + errs.join(' | ') : 'no JavaScript errors on either device');

await browser.close(); server.close(); await mock.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
