/* Two independent browser profiles against one shared backend:
 * A publishes, B must see it. That is the whole feature. */
import { chromium } from 'playwright';
/* Use the preinstalled browser when present (this dev sandbox sets
 * PLAYWRIGHT_BROWSERS_PATH); otherwise fall back to whatever Playwright
 * installed, which is what CI and a normal checkout will have. */
import fsx from 'node:fs';
const CHROME = '/opt/pw-browsers/chromium';
const LAUNCH_OPTS = fsx.existsSync(CHROME) ? { executablePath: CHROME } : {};
import { startMock } from '../../packages/zero-core/mock-supabase.mjs';
import { buildZero } from './build.mjs';
import http from 'node:http'; import fs from 'node:fs';

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
const server = http.createServer((req,res)=>{ const f=OUT+'/'+(req.url.split('?')[0]==='/'?'index.html':req.url.slice(1));
  if(!fs.existsSync(f)){res.writeHead(404);return res.end();}
  res.writeHead(200,{'Content-Type':f.endsWith('.js')?'text/javascript':'text/html'}); res.end(fs.readFileSync(f)); });
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

let pass=0, fail=0;
const ok=(c,l)=>{ if(c){pass++;console.log('  PASS  '+l);} else {fail++;console.log('  FAIL  '+l);} };
const section=(s)=>console.log('\n'+s);

const browser = await chromium.launch(LAUNCH_OPTS);
const errs = [];

/** A fresh browser profile = a genuinely separate user, not a second tab. */
async function shooter(email, seed) {
  const ctx = await browser.newContext({ viewport:{width:430,height:900} });
  const page = await ctx.newPage();
  page.on('pageerror', e=>errs.push(`${email}: ${e.message}`));
  await page.goto(BASE);
  await page.evaluate(({seed})=>{ localStorage.clear();
    localStorage.setItem('sessions_v1', JSON.stringify(seed)); }, {seed});
  await page.reload(); await page.waitForTimeout(600);
  await page.fill('input[placeholder="email"]', email);
  await page.fill('input[placeholder="password"]', 'pw12345');
  await page.click('button:has-text("create account")'); await page.waitForTimeout(600);
  /* Sign-in lands on More -> Cloud sync now; these tests are about the
   * sessions and the board, so come back to them. */
  await page.click('.tabbar button:has-text("Sessions")');
  await page.waitForTimeout(300);
  return { ctx, page };
}

const mkSession = (id, name, score) => ([{
  id, name, date:'2026-08-13', type:'Score', position:'Standing', targetId:'any',
  rangeYards:100, rangeLocation:'club', rifleId:'', ammoId:'', ts:1, matchId:null,
  // two record shots; ring values drive the score
  shots:[ {id:'s1',ring:String(score[0]),clockH:12,clockM:0,xy:{x:0,y:0},elev:0,wind:0},
          {id:'s2',ring:String(score[1]),clockH:3,clockM:0,xy:{x:0.4,y:0},elev:0,wind:0} ],
}]);

section('two shooters, one backend');
const A = await shooter('a@example.com', mkSession('sA','A league night',[10,9]));
const B = await shooter('b@example.com', mkSession('sB','B league night',[9,9]));
/* The account is a status readout now, so it lives in the More menu rather
 * than on the sessions screen -- which is also where the menu row says who you
 * are without spending a tap to find out. */
const signedInAs = async (page) => {
  await page.click('.tabbar button:has-text("More")');
  await page.waitForTimeout(250);
  const t = await page.textContent('body');
  await page.click('.tabbar button:has-text("Sessions")');
  await page.waitForTimeout(200);
  return t;
};
ok((await signedInAs(A.page)).includes('a@example.com'), 'A is signed in');
ok((await signedInAs(B.page)).includes('b@example.com'), 'B is signed in');

section('handles');
/* The handle is claimed on the sync screen -- it is an account property, and
 * the account moved into the More menu when it stopped being something you set
 * up and started being something you have. */
const toSync = async (page) => {
  await page.click('.tabbar button:has-text("More")');
  await page.waitForTimeout(250);
  await page.click('button:has-text("Cloud sync")');
  await page.waitForTimeout(350);
};
await toSync(A.page); await toSync(B.page);
await A.page.fill('input[placeholder="leaderboard handle"]', 'Jaxon');
await A.page.click('button:has-text("claim")'); await A.page.waitForTimeout(200);
await B.page.fill('input[placeholder="leaderboard handle"]', 'Rival');
await B.page.click('button:has-text("claim")'); await B.page.waitForTimeout(200);
/* `ok(true, …)` stood here, which is a label claiming a fact it never checked.
 * Breaking claimHandle left it green and failed three assertions two sections
 * later instead, mislocalising the cause. */
/* Read from the outbox on disk rather than from a page global: Zero's bundle is
 * a module, so `CORE` is not reachable from evaluate the way Bench's is. */
const handlesQueued = (page) => page.evaluate(() =>
  (JSON.parse(localStorage.getItem('zerocore.zero.outbox') || '[]'))
    .filter(e => e && e.table === 'leaderboard_profiles')
    .map(e => e.row && e.row.handle));
const queued = await Promise.all([handlesQueued(A.page), handlesQueued(B.page)]);
ok(queued[0].includes('Jaxon') && queued[1].includes('Rival'),
   `both queued a handle (${queued.map(q => q.join('/') || 'none').join(', ')})`);

section('publish');
await A.page.click('.tabbar button:has-text("Sessions")'); await A.page.waitForTimeout(300);
await A.page.click('text=A league night'); await A.page.waitForTimeout(500);
ok(await A.page.locator('button:has-text("publish")').count() === 1, 'the publish button appears on a rankable session');
await A.page.click('button:has-text("publish")'); await A.page.waitForTimeout(900);
ok((await A.page.textContent('body')).includes('published'), 'the button flips to published');
const entries = [...(mock.state.rows.get('leaderboard_entries')?.values()||[])];
ok(entries.length === 1, `one entry on the server (${entries.length})`);
ok(entries[0]?.score === 19 && entries[0]?.position === 'Standing',
   `score and position pushed (${entries[0]?.score}, ${entries[0]?.position})`);

await B.page.click('.tabbar button:has-text("Sessions")'); await B.page.waitForTimeout(300);
await B.page.click('text=B league night'); await B.page.waitForTimeout(500);
await B.page.click('button:has-text("publish")'); await B.page.waitForTimeout(900);
ok((mock.state.rows.get('leaderboard_entries')?.size||0) === 2, 'both shooters are on the board');

section('B sees A');
await B.page.click('button:has-text("sessions")').catch(()=>{});
await B.page.waitForTimeout(200);
await B.page.click('.tab:has-text("Analytics")'); await B.page.waitForTimeout(400);
await B.page.click('button:has-text("load")'); await B.page.waitForTimeout(900);
const lbText = await B.page.textContent('body');
ok(lbText.includes('Jaxon'), "B's leaderboard shows A's handle");
ok(lbText.includes('Rival'), '...and B\'s own');
const rowOrder = lbText.indexOf('Jaxon') < lbText.indexOf('Rival');
ok(rowOrder, 'A (19) outranks B (18) — sorted by score');
ok(lbText.includes('you'), "B's own row is marked");
await B.page.screenshot({ path:'shots/leaderboard.png', fullPage:true });

section('republish does not duplicate');
await A.page.click('button:has-text("← sessions")').catch(()=>{});
await A.page.waitForTimeout(200);
await A.page.click('text=A league night').catch(()=>{});
await A.page.waitForTimeout(400);
await A.page.click('button:has-text("published")'); await A.page.waitForTimeout(900);
ok((mock.state.rows.get('leaderboard_entries')?.size||0) === 2,
   'publishing the same session twice updates one row rather than adding another');

section('privacy');
// Seed a PRIVATE row for A, then have B hit the REST endpoint directly with
// B's own stored token. This exercises the real auth + RLS path rather than
// asserting something trivially true.
const aUserId = mock.state.users.get('a@example.com').id;
mock.seed('range_sessions', { id: '00000000-0000-4000-8000-00000000aaaa',
  user_id: aUserId, occurred_on: '2026-08-13', source_app: 'zero', location: 'A private range' });

const probe = await B.page.evaluate(async (base) => {
  const sess = JSON.parse(localStorage.getItem('zerocore.session'));
  const hit = async (path) => {
    const r = await fetch(base + path, { headers: { apikey: 'anon-key',
      Authorization: 'Bearer ' + sess.access_token } });
    return r.ok ? await r.json() : { error: r.status };
  };
  return { priv: await hit('/rest/v1/range_sessions?select=*'),
           pub:  await hit('/rest/v1/v_leaderboard?select=*') };
}, mock.url);

const sawAPrivate = Array.isArray(probe.priv) &&
  probe.priv.some(r => r.location === 'A private range');
ok(!sawAPrivate, "B's token cannot read A's private range_sessions row");
ok(Array.isArray(probe.pub) && probe.pub.length === 2,
   `...while the same token reads both public leaderboard rows (${probe.pub?.length})`);

section('hygiene');
ok(errs.length === 0, 'no JS errors' + (errs.length?' — '+errs.slice(0,3).join(' | '):''));

/* ======================================================= taking it back down */
/* `retractEntry` was implemented, exported, tested at the zero-core level —
 * and wired to no UI at all, so a published score could never be withdrawn. A
 * new user taps publish to find out what it does, or publishes a session they
 * then notice says 600 yards instead of 100, and there is no way back. Worse,
 * deleting the session left the entry live on a public board with the id that
 * addressed it gone. */
section('retracting');
{
  /* A is sitting in the session detail from the publish section above. */
  if (!(await A.page.locator('button:has-text("published")').count())) {
    await A.page.click('.tabbar button:has-text("Sessions")'); await A.page.waitForTimeout(300);
    await A.page.click('text=A league night'); await A.page.waitForTimeout(400);
  }

  ok(await A.page.locator('button:has-text("published")').count() === 1,
     'a published session shows it is published');

  A.page.once('dialog', d => d.accept());
  await A.page.click('button:has-text("published")');
  await A.page.waitForTimeout(900);

  /* Counted for A specifically: B has published too, and the point is that A's
   * row stopped existing rather than that the table emptied. */
  const aId = mock.state.users.get('a@example.com').id;
  const mine = [...(mock.state.rows.get('leaderboard_entries')?.values() || [])]
    .filter(r => r.user_id === aId);
  ok(mine.length === 0, `the entry is GONE from the table, not tombstoned (${mine.length} left)`);
  ok(!mine.some(r => r.deleted_at), '...not merely marked deleted and still readable');
  ok(await A.page.locator('button:has-text("⇧ publish")').count() === 1,
     '...and the button offers to publish again, so it is a state and not a one-way door');
  const lbId = await A.page.evaluate(() =>
    JSON.parse(localStorage.getItem('sessions_v1'))[0].lbId);
  ok(!lbId, 'the local record stops claiming to be published');
}

await browser.close(); server.close(); await mock.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
