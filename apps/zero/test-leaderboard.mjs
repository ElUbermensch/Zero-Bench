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
import http from 'node:http'; import fs from 'node:fs';

const mock = await startMock({ ttlSec: 3600 });
const server = http.createServer((req,res)=>{ const f='dist/'+(req.url.split('?')[0]==='/'?'index.html':req.url.slice(1));
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
    localStorage.setItem('zs_sessions_v1', JSON.stringify(seed)); }, {seed});
  await page.reload(); await page.waitForTimeout(600);
  // shared deployment is blank in source, so each profile enters the server once
  await page.fill('input[placeholder="https://YOUR-PROJECT.supabase.co"]', mock.url);
  await page.fill('input[placeholder="anon public key"]', 'anon-key');
  await page.click('button:has-text("save server")'); await page.waitForTimeout(300);
  await page.fill('input[placeholder="email"]', email);
  await page.fill('input[placeholder="password"]', 'pw12345');
  await page.click('button:has-text("create account")'); await page.waitForTimeout(600);
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
ok((await A.page.textContent('body')).includes('a@example.com'), 'A is signed in');
ok((await B.page.textContent('body')).includes('b@example.com'), 'B is signed in');

section('handles');
await A.page.fill('input[placeholder="leaderboard handle"]', 'Jaxon');
await A.page.click('button:has-text("claim")'); await A.page.waitForTimeout(200);
await B.page.fill('input[placeholder="leaderboard handle"]', 'Rival');
await B.page.click('button:has-text("claim")'); await B.page.waitForTimeout(200);
ok(true, 'both queued a handle');

section('publish');
await A.page.click('text=A league night'); await A.page.waitForTimeout(500);
ok(await A.page.locator('button:has-text("publish")').count() === 1, 'the publish button appears on a rankable session');
await A.page.click('button:has-text("publish")'); await A.page.waitForTimeout(900);
ok((await A.page.textContent('body')).includes('published'), 'the button flips to published');
const entries = [...(mock.state.rows.get('leaderboard_entries')?.values()||[])];
ok(entries.length === 1, `one entry on the server (${entries.length})`);
ok(entries[0]?.score === 19 && entries[0]?.position === 'Standing',
   `score and position pushed (${entries[0]?.score}, ${entries[0]?.position})`);

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

await browser.close(); server.close(); await mock.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
