#!/usr/bin/env node
/* Check a REAL Supabase project, not the mock.
 *
 * Every other suite in this repo runs against packages/zero-core/mock-supabase.mjs,
 * which encodes an understanding of Supabase's endpoints — and that understanding
 * is exactly the thing that could be wrong. This is the test that counts.
 *
 * It is read-mostly and cleans up after itself: it creates one anonymous user
 * and one relay, and ends the relay when it is done. It writes nothing to your
 * own tables and cannot see them.
 *
 *   node tools/verify-live.mjs
 */
import { loadConfig } from './config.mjs';

const cfg = loadConfig();
if (!cfg.ok) {
  console.error(`\n  supabase.config.json: ${cfg.reason}\n`);
  process.exit(2);
}

let pass = 0, fail = 0, warn = 0;
const ok = (c, l, hint) => {
  if (c) { pass++; console.log('  \x1b[32mPASS\x1b[0m  ' + l); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m  ' + l + (hint ? `\n        → ${hint}` : '')); }
};
const note = (l) => { warn++; console.log('  \x1b[33mNOTE\x1b[0m  ' + l); };
const section = (s) => console.log('\n' + s);

/* Headers exactly as zero-core sends them: `apikey` always, and an
 * Authorization bearer ONLY once there is a session token.
 *
 * This used to fall back to `Authorization: Bearer <anonKey>` when there was no
 * session, which no part of either app ever does. Supabase's newer publishable
 * keys (sb_publishable_...) are documented as not valid in an Authorization
 * header at all, save for the narrow case of exactly matching `apikey` -- so
 * the verifier was exercising a header combination the product never sends,
 * against a rule that only applies to the verifier. A tool that checks a live
 * backend has to make the same requests the client makes, or a pass means
 * nothing and a failure sends you looking for a problem that is not there. */
const H = (tok) => {
  const h = { apikey: cfg.anonKey, 'Content-Type': 'application/json' };
  if (tok) h.Authorization = 'Bearer ' + tok;
  return h;
};
const get = (p, tok) => fetch(cfg.url + p, { headers: H(tok) });
const rpc = (fn, body, tok) => fetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
  method: 'POST', headers: H(tok), body: JSON.stringify(body || {}) });

console.log(`\nVerifying ${cfg.url}`);

/* ─────────────────────────────────────────────────────── reachable at all */
section('the project answers');
/* Probe a TABLE, not the PostgREST root.
 *
 * `/rest/v1/` returns the OpenAPI description of the entire schema, which is
 * introspection, and Supabase requires a secret key for it: a publishable key
 * is refused there with "Secret API key required". This check therefore
 * reported every correctly-configured project as having a bad key -- and since
 * it is the first check that runs, it sent people hunting through the
 * dashboard for a problem that did not exist.
 *
 * A plain table read is what the apps actually do, and it separates the three
 * states cleanly: 401 means the key is genuinely wrong, 404 means the schema
 * was never applied, and 200 with an empty array is the correct answer for a
 * valid key with RLS doing its job. */
let root;
try { root = await get('/rest/v1/range_sessions?select=id&limit=1'); } catch (e) {
  console.error(`\n  Could not reach ${cfg.url} — ${e.message}\n`);
  process.exit(1);
}
/* A 401 here is the single most common setup failure and the old message
 * guessed at three causes without distinguishing them. The server says which
 * one it is; print it, plus enough of the key to compare against the dashboard
 * without putting the whole thing in a terminal someone may screenshot. */
if (root.status === 401) {
  let why = '';
  try { const b = await root.clone().json(); why = b.message || b.msg || b.error || ''; }
  catch { try { why = (await root.clone().text()).slice(0, 200); } catch {} }
  const k = String(cfg.anonKey || '');
  const shape = /^sb_publishable_/.test(k) ? 'a new-style publishable key'
    : /^sb_secret_/.test(k) ? 'a SECRET key — this must never be used here or shipped to a client'
    : /^ey[A-Za-z0-9_-]+\./.test(k) ? 'a legacy JWT key'
    : 'an unrecognised format';
  console.log(`        → server said: ${why || '(no message)'}`);
  console.log(`        → key looks like ${shape}, ${k.length} chars, `
    + `starts ${k.slice(0, 12)}… ends …${k.slice(-4)}`);
  console.log(`        → project ref in the URL: ${(cfg.url.match(/\/\/([^.]+)\./) || [])[1] || '?'}`);
  console.log('        → compare both against Supabase → Project Settings → API Keys.');
}
ok(root.status !== 401, 'the publishable key is accepted',
   'the key and the URL must come from the SAME project, and it must be the publishable/anon key');
ok(root.status < 500, 'the API is awake',
   'a 5xx here usually means the project is PAUSED — restore it in the dashboard');
ok(root.status !== 404, 'the schema is present',
   'migration 0001 has not been applied to this project');

/* ───────────────────────────────────────────────── migrations actually ran */
section('schema');
const keepalive = await rpc('keepalive');
ok(keepalive.ok, 'keepalive() exists and is callable by anon',
   'migration 0003 has not been applied');

for (const [view, mig] of [['v_ballistic_profiles', '0001'], ['v_batch_performance', '0001'],
                           ['v_leaderboard', '0002']]) {
  const r = await get(`/rest/v1/${view}?select=*&limit=1`);
  ok(r.status !== 404, `${view} exists`, `migration ${mig} has not been applied`);
}
const relayFns = await rpc('relay_state', { p_relay: '00000000-0000-0000-0000-000000000000' });
ok(relayFns.status !== 404, 'the relay RPCs exist', 'migration 0004 has not been applied');

/* ────────────────────────────── the anon key on its own must open nothing */
section('the anon key alone grants nothing — RLS is the access control');
for (const t of ['range_sessions', 'batches', 'brass_lots', 'recipes', 'shots', 'groups']) {
  const r = await get(`/rest/v1/${t}?select=*&limit=1`);
  const body = r.ok ? await r.json() : null;
  ok(!r.ok || (Array.isArray(body) && body.length === 0),
     `${t} returns nothing to an unauthenticated caller`,
     'RLS is not enabled on this table — anyone with the public key can read it');
}

/* ──────────────────────────────────────── anonymous sign-in, for the relay */
section('anonymous sign-in (pair fire needs this)');
const anonRes = await fetch(`${cfg.url}/auth/v1/signup`, {
  method: 'POST',
  headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ data: {}, gotrue_meta_security: {} }),
});
const anonBody = await anonRes.json().catch(() => ({}));
const anonEnabled = anonRes.ok && anonBody.access_token;
ok(anonEnabled, 'a device can sign in anonymously',
   'Dashboard → Authentication → Providers → Anonymous → enable. Without this, no coach can join a relay.');

let relayId = null, code = null;
if (anonEnabled) {
  const tok = anonBody.access_token;
  const claims = JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString());
  ok(claims.is_anonymous === true, '...and is flagged is_anonymous in its JWT',
     'the leaderboard guard depends on this claim');

  section('the relay works end to end');
  const made = await rpc('create_relay', { p_host_name: 'verify', p_title: 'preflight' }, tok);
  const relay = made.ok ? (await made.json()) : null;
  const row = Array.isArray(relay) ? relay[0] : relay;
  ok(made.ok && row && row.code, 'a relay can be created');
  if (row) {
    relayId = row.id; code = row.code;
    ok(/^[2-9BCDFGHJKMNPQRSTVWXZ]{4}$/.test(row.code),
       `the code is 4 sayable characters (${row.code})`);
    const st = await rpc('relay_state', { p_relay: row.id }, tok);
    ok(st.ok, 'relay_state answers for a participant');
    const bad = await rpc('join_relay', { p_code: 'BBBB', p_name: 'x', p_role: 'coach' }, tok);
    const badBody = bad.ok ? await bad.json() : {};
    ok(badBody.ok === false, 'a wrong code is refused as a result, not an exception',
       'if this raises instead, the join throttle silently never trips');
  }

  section('the leaderboard is public-read, and closed to anonymous devices');
  const lb = await get('/rest/v1/v_leaderboard?select=*&limit=1', tok);
  ok(lb.ok, 'the leaderboard is readable');
  const spam = await fetch(`${cfg.url}/rest/v1/leaderboard_entries`, {
    method: 'POST', headers: H(tok),
    body: JSON.stringify([{ occurred_on: '2026-01-01', position: 'Prone',
      target_name: 'x', distance_yd: 100, shot_count: 10, score: 100 }]),
  });
  ok(spam.status === 403 || spam.status === 401,
     `an anonymous device cannot publish a score (HTTP ${spam.status})`,
     'the RESTRICTIVE anon policy from migration 0004 is missing — the board is spammable');

  if (relayId) {
    await rpc('end_relay', { p_relay: relayId }, tok);
    const after = await rpc('join_relay', { p_code: code, p_name: 'late', p_role: 'coach' }, tok);
    const ab = after.ok ? await after.json() : {};
    ok(ab.ok === false, 'the code stops working once the relay ends');
  }
}

/* ────────────────────────────────────────────────────────── housekeeping */
section('housekeeping');
const emailProbe = await fetch(`${cfg.url}/auth/v1/signup`, {
  method: 'POST', headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: `verify+${Date.now()}@example.invalid`, password: 'x' }),
});
if (emailProbe.status === 422 || emailProbe.status === 400) {
  note('email signup rejected a throwaway address — fine, but confirm you can create YOUR account');
} else {
  note('email signup is open; if this project is public, consider turning on email confirmation');
}

console.log(`\n${pass} passed, ${fail} failed${warn ? `, ${warn} to look at` : ''}\n`);
if (fail) {
  console.log('Fix the failures above before deploying. Nothing here is cosmetic:');
  console.log('each one is something the apps depend on at runtime.\n');
}
process.exit(fail ? 1 : 0);
