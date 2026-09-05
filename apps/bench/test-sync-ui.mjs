/* The sync surface, against a stub backend.
 *
 * apps/bench/test.mjs runs against a build with no backend configured, which
 * is the honest default for a checkout but means CORE is null and every
 * cloud-facing control is absent. Everything about "can a new user find sign
 * in, and does signing in actually do something" is therefore invisible to it.
 *
 * This file fills that hole. It serves the SAME dist/index.html, with the one
 * generated line that carries the backend rewritten to point at a stub GoTrue
 * + PostgREST implemented below. Nothing about the app is mocked: it runs its
 * own zero-core, its own fetches, its own auto-sync.
 *
 * What is asserted is the user's question, not the implementation: a signed
 * out user sees the email field without navigating anywhere, signing in makes
 * records move without a second button, and the header says which state you
 * are in from every screen.
 */
import { chromium } from 'playwright';
/* No beta fixture here, deliberately. This is the one suite that drives the
 * gate from the OUTSIDE -- a stranger arriving, asking, waiting and being let
 * in -- so it must start signed out. Its stub backend answers
 * my_access_status itself. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = '/opt/pw-browsers/chromium';
const LAUNCH_OPTS = fs.existsSync(CHROME) ? { executablePath: CHROME } : {};

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l); } };
const section = (s) => console.log('\n' + s);

/* ----------------------------------------------------------- stub backend */
/* Only the endpoints zero-core actually calls. CORS matters here and would not
 * in production: the app and the API share an origin there and do not here. */
const hits = { token: 0, signup: 0, access: 0, push: [], pull: [] };
/* The owner's verdict, as a mutable fixture. A new sign-up is `pending` --
 * which is what migration 0021's trigger files -- and the suite moves it to
 * `approved` at the point the owner would have, so both sides of the gate are
 * exercised against the same running app rather than against two builds. */
const access = { status: 'pending', heardFrom: null };
const USER = { id: '11111111-2222-3333-4444-555555555555', email: 'shooter@example.com' };
const TOKENS = {
  access_token: 'stub-access', refresh_token: 'stub-refresh',
  expires_in: 3600, token_type: 'bearer', user: USER,
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey,authorization,content-type,prefer,x-client-info',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Expose-Headers': 'content-range',
};

const api = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json', ...CORS });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

  const url = new URL(req.url, 'http://x');
  let raw = '';
  req.on('data', d => { raw += d; });
  req.on('end', () => {
    if (url.pathname === '/auth/v1/token') { hits.token++; return send(200, TOKENS); }
    if (url.pathname === '/auth/v1/signup') { hits.signup++; return send(200, TOKENS); }
    if (url.pathname === '/auth/v1/logout') { return send(204, {}); }
    /* The beta gate's one read. `access.status` is a variable rather than a
     * constant because this suite drives the gate from both sides: a stranger
     * who is refused, and the same account once the owner has said yes. */
    if (url.pathname === '/rest/v1/rpc/my_access_status') {
      hits.access++;
      return send(200, { status: access.status, requested_at: '2026-09-01T00:00:00Z',
                         decided_at: null, heard_from: access.heardFrom,
                         heard_detail: null });
    }
    if (url.pathname === '/rest/v1/rpc/submit_access_details') {
      let b = {}; try { b = JSON.parse(raw); } catch { b = {}; }
      access.heardFrom = b.p_heard_from || null;
      return send(200, { status: access.status, heard_from: access.heardFrom });
    }
    const m = /^\/rest\/v1\/([a-z_]+)$/.exec(url.pathname);
    if (m) {
      if (req.method === 'GET') { hits.pull.push(m[1]); return send(200, []); }
      let rows = [];
      try { rows = JSON.parse(raw); } catch { rows = []; }
      hits.push.push({ table: m[1], n: Array.isArray(rows) ? rows.length : 1 });
      // PostgREST with return=representation echoes the rows back, stamped.
      const at = new Date().toISOString();
      return send(201, (Array.isArray(rows) ? rows : [rows])
        .map(r => ({ ...r, updated_at: at, created_at: at })));
    }
    send(404, { message: 'stub has no ' + url.pathname });
  });
});
await new Promise(r => api.listen(0, '127.0.0.1', r));
const API = `http://127.0.0.1:${api.address().port}`;

/* ------------------------------------------------------------- app server */
/* The shipped file, with only the generated backend line rewritten. Rebuilding
 * into a temp directory would be the other option; it would also leave a
 * dist/ configured against a stub, which is a worse thing to leave lying
 * around than a one-token substitution done in memory. */
const ROOT = path.resolve('dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2' };
const PREFIX = '/bench/';
const CONF_RE = /const SHARED_SUPABASE = \{[^}]*\};/;

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
if (!CONF_RE.test(html)) {
  console.error('  the built page no longer contains the generated SHARED_SUPABASE line');
  process.exit(1);
}
const patched = html.replace(CONF_RE,
  () => `const SHARED_SUPABASE = ${JSON.stringify({ url: API, anonKey: 'sb_publishable_stub' })};`);

const app = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (!p.startsWith(PREFIX)) { res.writeHead(404); return res.end('outside /bench/'); }
  p = p.slice(PREFIX.length - 1);
  if (p === '/' || p === '') p = '/index.html';
  if (p === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(patched);
  }
  /* No service worker in this harness. It would cache the patched page, which
   * is harmless, but it also introduces an activation race into a run whose
   * whole subject is what happens in the first two seconds after load. The
   * worker itself is covered in test.mjs. The app treats a failed registration
   * as a non-event, which is exactly what a static host without one looks
   * like, so a 404 is the honest way to say "not here". */
  if (p === '/sw.js') { res.writeHead(404); return res.end('no worker in this harness'); }
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('nope');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise(r => app.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${app.address().port}${PREFIX}`;

/* ------------------------------------------------------------------- run */
const browser = await chromium.launch(LAUNCH_OPTS);
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
/* The harness serves no sw.js on purpose (see above), and the browser logs the
 * failed registration itself -- the app already swallows the rejection. That
 * one message is expected here and nothing else is. */
const expected = (t) => /bad HTTP response code \(404\).*script|ServiceWorker.*404/i.test(t);
page.on('pageerror', e => { if (!expected(e.message)) errors.push(e.message); });
page.on('console', m => { if (m.type() === 'error' && !expected(m.text())) errors.push(m.text()); });

await page.goto(BASE);
await page.waitForTimeout(400);

const chip = () => page.evaluate(() => {
  const el = document.getElementById('syncchip');
  const r = el.getBoundingClientRect();
  return { cls: el.className, text: el.textContent.trim(),
           label: el.getAttribute('aria-label') || '', w: r.width, h: r.height };
});

/* ============================================== signed out, first launch */
section('a stranger gets the gate and nothing else');
{
  /* This section used to assert that the sign-in card was on the first screen
     with nothing tapped. It is not any more, and the reason is not that the
     card moved: since migration 0021 there is no first screen. An account the
     owner has not approved cannot see the app at all, so what a stranger meets
     is the gate -- and the thing worth asserting is that it is a wall rather
     than a banner over a working interface. */
  ok(await page.locator('#g-email').isVisible(),
     'the gate asks for an email with nothing tapped');
  ok(await page.locator('#g-pw').isVisible(), 'and a password');

  const tabs = await page.locator('#tabs button').count();
  ok(tabs === 0, `no tab bar behind it (${tabs} tabs)`);
  ok(await page.locator('#syncchip').isHidden(), '...and no sync chip in the header');

  /* The load-bearing one: none of the user's own records are reachable, by
     navigation or by reading the DOM. A gate that leaves the view painted
     underneath is a screenshot away from being no gate at all. */
  const view = await page.textContent('#view');
  ok(!/Brass|Batches|Recipes/.test(view), 'nothing of the app is rendered behind the gate');

  await page.click('[data-act="gatemode"][data-arg="up"]');
  await page.waitForTimeout(150);
  ok(await page.locator('#g-pw2').isVisible(),
     'requesting access asks for the password twice');
  ok(await page.locator('#g-heard').isVisible(),
     '...and how they heard about it, which is the only other thing asked');
  await page.click('[data-act="gatemode"][data-arg="in"]');
  await page.waitForTimeout(150);

  /* Legibility on the credential fields, moved here from test-sync.mjs.
     It measured #sy-email and #sy-pw on the Cloud sync screen while signed
     out; that screen is behind an approved account now, so the only place
     those two boxes are ever seen is the gate. A password field nobody can
     read is the same bug wherever it is painted. */
  const relLum = (css) => {
    const [r, g, b] = css.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number)
      .map(v => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [x, y] = [relLum(a), relLum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };
  const readable = await page.evaluate(() => {
    const out = {};
    for (const id of ['g-email', 'g-pw']) {
      const el = document.getElementById(id);
      if (!el) { out[id] = null; continue; }
      const cs = getComputedStyle(el);
      let bg = cs.backgroundColor, n = el;
      while (/rgba\(0, 0, 0, 0\)|transparent/.test(bg) && n.parentElement) {
        n = n.parentElement; bg = getComputedStyle(n).backgroundColor;
      }
      out[id] = { color: cs.color, bg };
    }
    return out;
  });
  for (const [id, v] of Object.entries(readable)) {
    ok(v && contrast(v.color, v.bg) >= 4.5,
       `${id} is legible against its own background (${v ? contrast(v.color, v.bg).toFixed(1) : 'missing'}:1)`);
  }
}

/* ====================================================== waiting for approval */
section('signed in, not yet approved');
{
  await page.fill('#g-email', 'shooter@example.com');
  await page.fill('#g-pw', 'correct-horse');
  await page.click('[data-act="gateauth"]');
  await page.waitForTimeout(900);

  ok(hits.token === 1, 'the password grant was called exactly once');
  ok(hits.access > 0, 'and the app asked whether this account is in the beta');

  const body = await page.textContent('#view');
  ok(/on the list|approved/i.test(body), 'a pending account is told it is waiting');
  ok((await page.locator('#tabs button').count()) === 0,
     'signing in is not the same as being let in — still no tab bar');
  ok(!hits.push.length, '...and nothing was pushed on behalf of an account with no access');
}

/* ========================================================== the owner says yes */
section('approved');
{
  // Something local to send, so "did anything move" has an answer.
  await page.evaluate(() => {
    DB.firearms.push({ id: 'fa-test', name: 'Test rifle', cartridge: DB.cartridges[0]?.id || null });
    save();
  });

  access.status = 'approved';               // the owner, in the dashboard
  await page.click('[data-act="gaterecheck"]');
  await page.waitForTimeout(900);

  ok((await page.locator('#tabs button').count()) > 0,
     'checking again lets them in, without signing in a second time');
  ok(hits.push.length > 0, 'records were pushed WITHOUT a second button being pressed');
  ok(hits.pull.length > 0, '...and a pull ran in the same pass');

  await page.click('#syncchip');
  await page.waitForTimeout(250);

  const body = await page.textContent('#view');
  ok(/shooter@example\.com/.test(body), 'the signed-in email is on the screen the user is already looking at');
  ok(/Sync now/.test(body), 'and so is the sync button');

  const c = await chip();
  ok(c.text.startsWith('⇅'), 'the header chip switched to the sync glyph');
  ok(!/act/.test(c.cls), 'and stopped advertising sign-in');
}

/* ============================================== relaunch picks up by itself */
section('relaunch');
{
  const beforePush = hits.push.length, beforePull = hits.pull.length;
  await page.evaluate(() => {
    DB.firearms.push({ id: 'fa-test-2', name: 'Second rifle', cartridge: DB.cartridges[0]?.id || null });
    save();
  });
  await page.goto('about:blank');
  await page.goto(BASE);
  await page.waitForTimeout(1600);          // boot sync is deferred ~800ms

  ok(hits.pull.length > beforePull, 'opening the app syncs on its own');
  ok(hits.push.length > beforePush, '...pushing what was recorded since last time');
  ok(/shooter@example\.com/.test(await page.textContent('#view')),
     'the session survived the reload and the email is still shown');
  ok((await chip()).text.startsWith('⇅'), 'the header reflects it immediately');
}

/* ==================================================== sign out and back out */
section('signing out');
{
  await page.click('[data-act="tab"][data-arg="more"]');
  await page.waitForTimeout(120);
  await page.click('[data-act="nav"][data-arg="sync"]');
  await page.waitForTimeout(150);
  await page.click('button[data-act="syOut"]');
  await page.waitForTimeout(200);

  /* Signing out no longer returns you to a usable app with a sign-in card on
     it -- it returns you to the gate, which is the same thing a stranger sees.
     The header chip is part of the app and goes with it. */
  ok(await page.locator('#syncchip').isHidden(),
     'the sync chip goes with the app, rather than sitting over the gate');
  ok(await page.locator('#g-email').isVisible(),
     'and signing out puts the gate back, not a sign-in card on a working app');
  ok((await page.locator('#tabs button').count()) === 0,
     '...with the tab bar gone again');
}

/* ================================================================ hygiene */
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
  const over = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(over <= 0, `no horizontal overflow (${over}px)`);
  ok(errors.length === 0, 'no JavaScript errors across the whole run' +
     (errors.length ? ' — ' + errors.slice(0, 2).join(' | ') : ''));
}

await browser.close();
api.close(); app.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
