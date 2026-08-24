/* Pair fire, end to end, across THREE genuinely separate browser profiles:
 * two shooters and a coach, all watching each other.
 *
 * The claim under test is the user's own description: "two shooters and one
 * coach all visibly seeing each other's work. The coach would have a screen to
 * see both calls and shots; both shooters would have their normal things and
 * then their teammates in a different colour."
 *
 * So the test drives the actual UI on all three devices. It never calls the
 * relay API to make something appear -- if a button is not wired, this fails.
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

/** A fresh context is a separate device, not a second tab: separate storage,
 *  separate zero-core instance, separate identity. */
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
  await page.waitForTimeout(600);
  await page.waitForTimeout(300);
  if (email) {
    await page.fill('input[placeholder="email"]', email);
    await page.fill('input[placeholder="password"]', 'pw12345');
    await page.click('button:has-text("create account")');
    await page.waitForTimeout(600);
    /* Signing in from the home screen now lands on More -> Cloud sync: the
     * card that was typed into belongs in the menu once there is an account,
     * and vanishing with no acknowledgement would read as a failure. Come
     * back to the sessions, which is what these tests are about. */
    await page.click('.tabbar button:has-text("Sessions")');
    await page.waitForTimeout(300);
  }
  return { ctx, page, label };
}

/** Log one shot through the real ShotEntry screen. Default ring, 12 o'clock:
 *  the point under test is the mirroring, not coordinate entry. */
async function logShot(page) {
  await page.click('button:has-text("+ shot")');
  await page.waitForTimeout(300);
  await page.click('button:has-text("Log & done")');
  await page.waitForTimeout(500);
}

/* 1 MOA is 1.0472 inches at 100 yards, so an impact exactly that far above
 * its call is exactly 1.00 minute — the coach's card is asserted against an
 * arithmetic answer rather than against whatever it happens to print. */
const MOA_IN = 1.0472;

const mkSession = (id, name, shots, yards) => ([{
  id, name, date: '2026-08-14', type: 'Score',
  position: 'Standing', targetId: 'any', rangeYards: yards || 100,
  rangeLocation: 'club', rifleId: '', ammoId: '', ts: 1, matchId: null,
  shots: shots.map((sh, i) => ({
    id: id + '-s' + i, ring: String(sh.ring), clockH: 12, clockM: 0,
    xy: sh.xy, callXY: sh.call, elev: 0, wind: 0,
  })),
}]);

/* Shooter A: every impact exactly 1 MOA above and 0.5 MOA right of its own
 * call. Correction is unambiguous — dial 1.00 down and 0.50 left — and the
 * radial call miss is hypot(1, 0.5) = 1.12 MOA, a third distinct number, so
 * no assertion below can pass by matching the wrong cell. */
const A_SHOTS = [0, 1, 2, 3].map(i => ({
  ring: 10,
  xy:   { x: i * 0.1 + MOA_IN / 2, y: MOA_IN },
  call: { x: i * 0.1,              y: 0 },
}));

/* Shooter B: calls missed by half an inch, alternating high and low. The mean
 * is zero and the spread is not, which is the case a naive implementation
 * reports as "dial 0.00" and a correct one reports as nothing to dial. */
const B_SHOTS = [0, 1, 2, 3].map(i => ({
  ring: 9, xy: { x: 0, y: i % 2 ? 0.5 : -0.5 }, call: { x: 0, y: 0 },
}));

/* ══════════════════════════════════════════════════════ shooter A goes live */
section('shooter A goes live');
const A = await device('A', { seed: mkSession('sA', 'Sunday league', A_SHOTS, 100), email: 'a@example.com' });
await A.page.click('text=Sunday league');
await A.page.waitForTimeout(400);

ok(await A.page.locator('button:has-text("go live")').count() === 1,
   'the session offers "go live"');
ok(await A.page.locator('button:text-is("join")').count() === 1,
   '...and "join", for the second shooter of a pair');

await A.page.fill('input[placeholder="your name"]', 'Jaxon');
await A.page.click('button:has-text("go live")');
await A.page.waitForTimeout(1200);

const bodyA1 = await A.page.textContent('body');
const code = await A.page.evaluate(() => {
  const el = [...document.querySelectorAll('div')]
    .find(d => /^[2-9BCDFGHJKMNPQRSTVWXZ]{4}$/.test(d.textContent.trim()) && !d.children.length);
  return el ? el.textContent.trim() : null;
});
ok(!!code, `a 4-character code is shown to read aloud (${code})`);
ok(bodyA1.includes('Jaxon') && bodyA1.includes('pt1'),
   'the roster shows the shooter on firing point 1');

const relayId = [...mock.state.relays.values()][0]?.id;
const shotsOn = () => [...(mock.state.rows.get('relay_shots')?.values() || [])]
  .filter(s => s.relay_id === relayId);
ok(shotsOn().length === 4, `the string already fired is backfilled (${shotsOn().length})`);
const relayRow = [...mock.state.relays.values()][0];
ok(Array.isArray(relayRow?.target_rings?.rings) && relayRow.target_rings.rings.length > 0,
   'the target geometry travels with the relay, so a coach can draw the real paper');
ok(shotsOn().every(s => s.call_x_in != null),
   "every shooter's call is mirrored alongside its impact");

/* ═══════════════════════════════════════ shooter B joins as the second shooter */
section('shooter B joins as the second shooter, from their own session');
const B = await device('B', { seed: mkSession('sB', 'Range day B', B_SHOTS, 200), email: 'b@example.com' });
await B.page.click('text=Range day B');
await B.page.waitForTimeout(400);
await B.page.click('button:text-is("join")');
await B.page.waitForTimeout(300);
ok(await B.page.locator('input[placeholder="CODE"]').count() === 1,
   'a shooter can join a relay from inside their own session');
ok(await B.page.locator('select').count() === 0,
   '...with no role to choose: joining from a session means shooting in it');

await B.page.fill('input[placeholder="CODE"]', code);
await B.page.fill('input[placeholder="your name"]', 'Partner Pete');
await B.page.click('button:has-text("join live")');
await B.page.waitForTimeout(1500);

const bodyB1 = await B.page.textContent('body');
ok(bodyB1.includes('pt2'), 'the partner is given firing point 2');
ok(bodyB1.includes(code), '...and sees the same code');
ok(bodyB1.includes('leave') && !bodyB1.includes('read this out'),
   'the partner is offered "leave", not "end" — only the shooter who started it ends a relay');

const bUid = mock.state.users.get('b@example.com').id;
ok(shotsOn().filter(s => s.user_id === bUid).length === 4,
   "the partner's own string is backfilled too");
ok(shotsOn().length === 8, 'eight shots on the relay: two strings of four, unmerged');

/* ══════════════════════════════════ each shooter sees the other, in colour */
section('each shooter sees the other, in a different colour');
await A.page.waitForTimeout(4000);
const bodyA2 = await A.page.textContent('body');
ok(bodyA2.includes('Partner Pete'), "shooter A sees the partner's name");
ok(bodyA2.includes('Dashed rings are relayed from your partner'),
   "...and the partner's string is drawn over A's own target, marked as relayed");
ok(await A.page.locator('svg circle.relayed').count() === 4,
   "exactly the partner's four impacts are overlaid, hollow so they read as context not as A's own");
ok(bodyA2.includes('36–0X'), "...with the partner's running score (36–0X)");
ok(bodyA2.includes('are not part of your group'),
   'the app says outright that relayed shots are excluded from your own statistics');

await B.page.waitForTimeout(3000);
ok((await B.page.textContent('body')).includes('Jaxon'), 'shooter B sees shooter A');
ok(await B.page.locator('svg circle.relayed').count() === 4,
   "...and A's four impacts drawn over B's own target");

await A.page.screenshot({ path: 'shots/relay-shooter.png', fullPage: true });

/* ═════════════════════════════════════════════ the coach sees both strings */
section('the coach sees both strings and both calls');
const C = await device('C');                     // no email, no password
await C.page.click('button:has-text("● join")');
await C.page.waitForTimeout(300);

// wrong code first: the door must stay shut
await C.page.fill('input[placeholder="CODE"]', 'BBBB');
await C.page.fill('input[placeholder="your name"]', 'Coach Ruth');
await C.page.click('button:has-text("join live")');
await C.page.waitForTimeout(700);
ok((await C.page.textContent('body')).includes('No live relay with that code'),
   'a wrong code is refused with a readable reason');

await C.page.fill('input[placeholder="CODE"]', code);
await C.page.selectOption('select', 'coach');
await C.page.click('button:has-text("join live")');
await C.page.waitForTimeout(1500);

const bodyC1 = await C.page.textContent('body');
ok(bodyC1.includes('Jaxon') && bodyC1.includes('Partner Pete'),
   'the coach sees both shooters');
ok(bodyC1.includes('Both strings'),
   '...on one target first, which is the comparison a coach is actually making');
ok(bodyC1.includes('40–0X') && bodyC1.includes('36–0X'),
   '...and both scores, computed independently (40–0X and 36–0X)');
ok(await C.page.locator('svg circle').count() >= 8, 'both strings are plotted');
/* The overlay, and the check that guards it.
 *
 * These two shooters are deliberately on DIFFERENT LINES -- 100 and 200 yards,
 * which is what makes the per-shooter minute conversion below testable. The
 * same fact makes one target face a lie: the same inch is a different fraction
 * of the paper at each distance, and a coach reading a correction off a face
 * that was not fired at is worse off than one reading a plain grid, because
 * the picture looks authoritative.
 *
 * `data-face` is on the paper only. This used to count every circle in the
 * svg, which eight impacts and eight call rings satisfy by themselves -- so it
 * passed throughout the period when relay_state was stripping the geometry and
 * the coach saw no face at all. */
const faceShown = async (pg) =>
  (await pg.locator('.tcard:has-text("Both strings") [data-face]').count()) > 0;

ok(!(await faceShown(C.page)),
   'shooters on different lines get NO target face — inches do not share a frame');
const gridNote = await C.page.locator('.tcard:has-text("Both strings")').textContent();
ok(/different distances/i.test(gridNote) && /100yd/.test(gridNote) && /200yd/.test(gridNote),
   'and the plot says which distances disagree, rather than silently degrading');
ok(await C.page.locator('svg line[opacity="0.5"]').count() === 8,
   'a call is drawn joined to its impact, once per called shot');

/* ══════════════════════════════ the correction, in minutes, or none at all */
section('call error in minutes — the number the coach dials on');
const cardA = C.page.locator('.tcard', { hasText: 'Jaxon' }).last();
const cardB = C.page.locator('.tcard', { hasText: 'Partner Pete' }).last();
const textA = await cardA.textContent();
const textB = await cardB.textContent();

ok(textA.includes('Call vs impact'), 'the coach gets a call-vs-impact panel per shooter');
ok(textA.includes('4 called · 100yd'),
   '...stating how many calls it is built on, and at what distance');
// impacts are exactly 1.0472" above their calls at 100yd = exactly 1.00 MOA
ok(/1\.00\s*DOWN/.test(textA),
   'A lands 1 MOA above his own call, so the card reads 1.00 DOWN');
ok(/0\.50\s*LEFT/.test(textA),
   '...and 0.5 MOA right of it, so 0.50 LEFT — the sign is flipped into an instruction');
ok(textA.includes('Dial 1.00 down and 0.50 left'),
   '...spelled out as a sentence a coach can say out loud');
ok(/±0\.00/.test(textA), '...with the interval on that mean beside it');
ok(!textA.includes('unconfirmed'),
   "...and no 'unconfirmed' mark, because A's offset clears its own interval");
ok(/1\.12[\s\S]{0,40}MOA call miss/.test(textA),
   'the radial call miss (1.12 MOA) is a separate number from either correction');

// B: half an inch either way. The mean is zero and the spread is not. The
// number is still printed -- the coach can see the string and decides.
ok(/0\.00/.test(textB),
   "B's offset is printed even though it is inside its own noise");
ok(textB.includes('±0.32'),
   '...next to the interval that makes it untrustworthy (±0.32 MOA)');
ok(textB.includes('unconfirmed'), '...explicitly marked unconfirmed rather than withheld');
ok(textB.includes('trend to watch rather than a number to dial'),
   '...and spelled out in words, so nobody dials 0.00 by mistake');
ok(!/\bhold\b/.test(textB), 'nothing is hidden behind a dash or a "hold"');
// B is on the 200yd line, A on the 100. Half an inch is 0.48 MOA at 100 and
// 0.24 at 200 -- if minutes came from the relay rather than from each
// shooter, this reads 0.48 and the coach corrects the wrong man.
ok(textB.includes('4 called · 200yd'),
   "B's card is computed at B's own distance, not the relay starter's");
ok(/0\.24[\s\S]{0,40}MOA call miss/.test(textB),
   '...so the same half inch is 0.24 MOA for B where it is 0.48 for A');

const anon = await C.page.evaluate(() =>
  JSON.parse(localStorage.getItem('zerocore.session') || '{}')?.user?.is_anonymous);
ok(anon === true, 'the coach is on an anonymous identity, having created no account');
ok(await C.page.locator('input[placeholder="message"]').count() === 1,
   'the coach can talk to the line');
ok(await C.page.locator('button:has-text("+ shot")').count() === 0,
   '...but is offered no way to log a shot');

await C.page.screenshot({ path: 'shots/relay-coach.png', fullPage: true });

/* ══════════════════════════════════════════ shots flow forward, both ways */
section('shots flow forward from both shooters');
const cCircles = await C.page.locator('svg circle').count();
await logShot(A.page);
await logShot(B.page);
await C.page.waitForTimeout(5000);
ok(await C.page.locator('svg circle').count() >= cCircles + 2,
   'a shot from each shooter reaches the coach');
ok(shotsOn().length === 10, `ten shots on the relay, five each (${shotsOn().length})`);

await A.page.waitForTimeout(3000);
ok(await A.page.locator('svg circle.relayed').count() === 5,
   "B's fifth shot appears on A's target");

/* ══════════════════════ the partner is visible WHILE you are on the gun */
section('a partner\'s shots show on the target you are aiming at');
{
  // The whole point of pair fire: their last shot is your wind call. Seeing it
  // only after the string is over is too late to be worth anything.
  await A.page.click('button:has-text("+ shot")');
  await A.page.waitForTimeout(500);
  const onTap = await A.page.locator('svg circle.relayed').count();
  ok(onTap === 5, `the partner's five impacts are on the tap target (${onTap})`);

  // and in the ring+clock view too, which is the other way in
  await A.page.click('button:has-text("Ring + clock")');
  await A.page.waitForTimeout(400);
  const onClassic = await A.page.locator('svg circle.relayed').count();
  const offFrame = await A.page.locator('svg circle.relayed-edge').count();
  ok(onClassic === 5, `...and on the classic view's live preview (${onClassic})`);
  // The frame is scaled to YOUR shots only, so a partner's wide one can fall
  // outside it. It is clamped to the edge rather than dropped: you lose the
  // exact position and keep the fact and the bearing.
  ok(offFrame === 1,
     `a partner shot outside the frame is marked at the edge, not dropped (${offFrame})`);
  await A.page.screenshot({ path: 'shots/relay-shooting.png', fullPage: true });
  await A.page.click('button.bback');          // leave without logging
  await A.page.waitForTimeout(400);
}

/* ═══════════════════════════════════ nobody writes anybody else's string */
section('each shooter owns exactly one string');
const aUid = mock.state.users.get('a@example.com').id;
const forged = await B.page.evaluate(async ({ base, rid, victim }) => {
  const s = JSON.parse(localStorage.getItem('zerocore.session'));
  const r = await fetch(base + '/rest/v1/relay_shots', {
    method: 'POST',
    headers: { apikey: 'anon-key', Authorization: 'Bearer ' + s.access_token,
               'Content-Type': 'application/json' },
    body: JSON.stringify([{ relay_id: rid, user_id: victim, shot_no: 9, ring: 'X', x_in: 0, y_in: 0 }]),
  });
  return r.status;
}, { base: mock.url, rid: relayId, victim: aUid });
ok(forged === 403, `a shooter's own token is refused when writing their partner's string (${forged})`);

const coachForged = await C.page.evaluate(async ({ base, rid }) => {
  const s = JSON.parse(localStorage.getItem('zerocore.session'));
  const r = await fetch(base + '/rest/v1/relay_shots', {
    method: 'POST',
    headers: { apikey: 'anon-key', Authorization: 'Bearer ' + s.access_token,
               'Content-Type': 'application/json' },
    body: JSON.stringify([{ relay_id: rid, shot_no: 9, ring: 'X', x_in: 0, y_in: 0 }]),
  });
  return r.status;
}, { base: mock.url, rid: relayId });
ok(coachForged === 403, `a coach's token is refused when writing any string (${coachForged})`);
ok(shotsOn().length === 10, 'neither forgery landed');

/* ═════════════════════════════════════════════════ the feed carries calls */
section('one feed, three people');
await C.page.fill('input[placeholder="message"]', 'picking up from 3, both of you hold 0.75L');
await C.page.click('button:has-text("wind")');
await C.page.waitForTimeout(4500);
ok((await A.page.textContent('body')).includes('picking up from 3'),
   "the coach's wind call reaches shooter A");
ok((await B.page.textContent('body')).includes('picking up from 3'),
   '...and shooter B, in the same breath');

await A.page.fill('input[placeholder="message"]', 'seen, dialling');
await A.page.click('button:has-text("send")');
await A.page.waitForTimeout(4500);
ok((await C.page.textContent('body')).includes('seen, dialling'),
   "the shooter's reply reaches the coach");
ok((await B.page.textContent('body')).includes('seen, dialling'),
   '...and their partner');

/* ══════════════════════════════════════════════ leaving versus ending it */
section('leaving versus ending');
await B.page.click('button:text-is("leave")');
await B.page.waitForTimeout(3500);
ok(await B.page.locator('button:has-text("go live")').count() === 1,
   'the partner who leaves is back to an ordinary session');
ok(mock.state.relays.get(relayId).status === 'live',
   '...and the relay survives their leaving');
ok((await C.page.textContent('body')).includes('Jaxon'),
   "...and the coach still has the remaining shooter's string");

await A.page.click('button:text-is("end")');       // not "send", in the feed
await A.page.waitForTimeout(4000);
const bodyC2 = await C.page.textContent('body');
ok(bodyC2.includes('ended'), 'the coach is told the relay ended rather than silently stalling');
ok(bodyC2.includes('final state'), '...and that what they are looking at is final');
ok(await A.page.locator('button:has-text("go live")').count() === 1,
   'the shooter can go live again');

const D = await device('D');
await D.page.click('button:has-text("● join")');
await D.page.waitForTimeout(300);
await D.page.fill('input[placeholder="CODE"]', code);
await D.page.fill('input[placeholder="your name"]', 'late');
await D.page.click('button:has-text("join live")');
await D.page.waitForTimeout(800);
ok((await D.page.textContent('body')).includes('No live relay with that code'),
   'the code stops working once the relay ends');

/* ══════════════════════════════════════════════════════════════ hygiene */
section('hygiene');
ok(errs.length === 0, errs.length ? 'JS errors: ' + errs.join(' | ') : 'no JavaScript errors on any device');

await browser.close(); server.close(); await mock.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
