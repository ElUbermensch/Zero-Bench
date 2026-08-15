/* zero-core test suite. Each case manufactures a specific failure mode; the
 * naive implementation of each is noted so it is clear what is being guarded. */
import { createRequire } from 'node:module';
import { startMock } from './mock-supabase.mjs';
const require = createRequire(import.meta.url);
const ZeroCore = require('./zero-core.js');

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fail++; console.log('  FAIL  ' + label); }
};
const section = (s) => console.log('\n' + s);

const memStore = () => {
  const m = new Map();
  return { get: k => (m.has(k) ? JSON.parse(m.get(k)) : null),
           set: (k, v) => { m.set(k, JSON.stringify(v)); return true; },
           _dump: m };
};

const mock = await startMock({ ttlSec: 3600 });
const mkClient = (store, extra = {}) => ZeroCore.create(Object.assign({
  url: mock.url, anonKey: 'anon-key-public', appId: 'bench',
  storage: store || memStore(), pageSize: 2,
}, extra));

/* ===================================================================== auth */
section('auth');
{
  const events = [];
  const c = mkClient();
  Object.values(ZeroCore.EVENTS).forEach(e => c.on(e, (p) => events.push([e, p])));

  await c.signUp('jaxon@example.com', 'hunter2');
  ok(c.isSignedIn(), 'signUp establishes a session');
  ok(events.some(([e]) => e === c.EVENTS.AUTH_SIGNED_IN), 'signUp emits auth:signed-in');

  await c.signOut();
  ok(!c.isSignedIn(), 'signOut clears the session');
  const out = events.find(([e]) => e === c.EVENTS.AUTH_SIGNED_OUT);
  ok(out && out[1].reason === 'user', 'signOut reports reason "user"');

  const bad = await c.signIn('jaxon@example.com', 'wrong');
  ok(!bad.ok, 'signIn with a wrong password fails');
  ok(!c.isSignedIn(), '...and does not leave a session behind');

  const good = await c.signIn('jaxon@example.com', 'hunter2');
  ok(good.ok && c.isSignedIn(), 'signIn with the right password succeeds');
}

/* ======================================================= token refresh */
section('token refresh');
{
  const c = mkClient();
  await c.signUp('a@example.com', 'pw');
  const before = mock.state.hits.refresh;

  // Expire the token, then fire ten requests at once. The naive design
  // refreshes per request: ten calls, nine of which present a rotated token.
  mock.advance(3600 * 1000 + 1000);
  const results = await Promise.all(
    Array.from({ length: 10 }, () => c.selectView('firearms', 'select=*'))
  );
  const refreshes = mock.state.hits.refresh - before;
  ok(refreshes === 1, `ten concurrent expired requests trigger exactly one refresh (got ${refreshes})`);
  ok(results.every(r => r.ok), '...and all ten requests still succeed');
  ok(c.isSignedIn(), '...and the session survives');
}

{
  const c = mkClient();
  await c.signUp('b@example.com', 'pw');
  const events = [];
  c.on(c.EVENTS.AUTH_SIGNED_OUT, p => events.push(p));

  mock.state.failRefresh = true;
  mock.advance(3600 * 1000 + 1000);
  const r = await c.selectView('firearms', 'select=*');
  mock.state.failRefresh = false;

  ok(!r.ok, 'a request fails when the refresh token is rejected');
  ok(!c.isSignedIn(), 'a rejected refresh token signs the user out');
  ok(events.length === 1 && events[0].reason === 'refresh-failed',
     'sign-out reason distinguishes refresh-failure from a user action');
}

/* ============================================================ offline queue */
section('offline writes');
{
  const c = mkClient();
  await c.signUp('c@example.com', 'pw');
  c.setOnline(false);

  const rid = c.upsert('recipes', { name: 'offline load', cartridge: '.223 Rem',
                                    charge_gr: 24.2, source_name: 'Hodgdon' });
  c.upsert('batches', { serial: 'B26H13-01D', recipe_id: rid, qty_loaded: 50, qty_remaining: 50 });
  ok(c.pendingCount() === 2, 'writes queue while offline');

  const r = await c.sync({ trigger: 'test' });
  ok(!r.ok && r.reason === 'offline', 'sync refuses to run while offline');
  ok(c.pendingCount() === 2, '...and nothing is lost');

  // editing the same row again must replace the queued entry, not append
  c.upsert('recipes', { id: rid, name: 'offline load v2', cartridge: '.223 Rem',
                        charge_gr: 24.4, source_name: 'Hodgdon' });
  ok(c.pendingCount() === 2, 'a second edit to a queued row replaces its entry');

  c.setOnline(true, { autoSync: false });
  const r2 = await c.sync({ trigger: 'test' });
  ok(r2.ok, 'sync succeeds once back online');
  ok(c.pendingCount() === 0, 'the outbox drains');
  ok(mock.state.rows.get('recipes').get(rid).name === 'offline load v2',
     'the server receives the LATEST version, not the stale queued snapshot');
}

/* ===================================================== foreign-key ordering */
section('foreign-key ordering');
{
  const c = mkClient();
  await c.signUp('d@example.com', 'pw');
  c.setOnline(false);

  // queue the CHILD first, deliberately: insertion order is the wrong order
  const sid = c.uuid();
  c.upsert('shots', { session_id: sid, shot_no: 1, velocity_fps: 2700 });
  c.upsert('range_sessions', { id: sid, occurred_on: '2026-08-13', source_app: 'zero' });
  ok(c.outbox[0].table === 'shots', 'the child was queued before the parent');

  mock.state.pushOrder.length = 0;
  c.setOnline(true, { autoSync: false });
  const r = await c.sync({ trigger: 'test' });

  const order = mock.state.pushOrder;
  ok(r.ok, 'sync succeeds despite the queue being in the wrong order');
  ok(order.indexOf('range_sessions') < order.indexOf('shots'),
     'the parent table is pushed before the child, regardless of queue order');
  ok(c.pendingCount() === 0, 'both rows land');
}

/* ============================================ server-owned + derived columns */
section('server-owned and derived columns');
{
  const c = mkClient();
  await c.signUp('e@example.com', 'pw');

  const sid = c.upsert('range_sessions', {
    occurred_on: '2026-08-13',
    updated_at: '1999-01-01T00:00:00Z',      // a client trying to set the clock
    created_at: '1999-01-01T00:00:00Z',
    velocity_avg_fps: 2705,                   // see the note below
    velocity_es_fps: 20,
    source_app: 'zero',
  });
  await c.sync({ trigger: 'test' });
  const saved = mock.state.rows.get('range_sessions').get(sid);
  // Assert on what the CLIENT SENT, not on what the server stored -- the server
  // overwrites these columns anyway, so checking the stored row would pass even
  // if the client were happily transmitting them.
  const sent = mock.state.lastPush.range_sessions.find(r => r.id === sid);

  ok(!('updated_at' in sent), 'client-supplied updated_at is never transmitted');
  ok(!('created_at' in sent), 'client-supplied created_at is never transmitted');
  ok(sent.source_app === 'zero', 'ordinary columns are transmitted untouched');
  // Velocity summaries used to be stripped here as trigger-derived. They are
  // not any more: Bench has a chronograph readout and no shot string, so a
  // client-side strip left those sessions with no velocity at all and no
  // trigger to supply one. The authority question moved to where it can
  // actually be answered -- migration 0005, which can see whether shots exist.
  ok(sent.velocity_avg_fps === 2705 && sent.velocity_es_fps === 20,
     'velocity summaries are transmitted; the server decides whether to keep them');
  ok(saved.updated_at === new Date(mock.state.clock).toISOString(),
     'the stored updated_at is the server stamp');
}

/* ================================================== pull cursor correctness */
section('pull cursor');
{
  const c = mkClient();
  await c.signUp('f@example.com', 'pw');
  const uid = c.getUser().id;

  mock.state.clock = 2_000_000;
  mock.seed('firearms', { id: c.uuid(), user_id: uid, name: 'rifle A', cartridge: '.223 Rem' });
  await c.sync({ trigger: 'test' });
  const cursorAfterFirst = c.cursors.firearms;
  ok(cursorAfterFirst === new Date(2_000_000).toISOString(),
     'the cursor is the greatest updated_at the server returned, not the local clock');

  // A row written while that sync was in flight carries a LATER server stamp.
  // A client-clock cursor would already be past it and skip the row forever.
  mock.state.clock = 2_000_500;
  const lateId = c.uuid();
  mock.seed('firearms', { id: lateId, user_id: uid, name: 'rifle B', cartridge: '6.5 CM' });

  let pulled = [];
  await c.sync({ trigger: 'test', apply: (t, rows) => { if (t === 'firearms') pulled = rows; } });
  ok(pulled.some(r => r.id === lateId), 'a row written mid-sync is picked up on the next pull');
}

/* --- negative control: the cursor bug this guards against, reproduced --- */
{
  const c = mkClient();
  await c.signUp('g@example.com', 'pw');
  const uid = c.getUser().id;
  mock.state.clock = 3_000_000;
  mock.seed('firearms', { id: c.uuid(), user_id: uid, name: 'A', cartridge: 'x' });

  await c.pullTable('firearms');
  // simulate the naive implementation: cursor = client "now", which is ahead
  // of the server stamps because time passed during the request
  const naive = new Date(3_000_400).toISOString();

  mock.state.clock = 3_000_200;
  const missedId = c.uuid();
  mock.seed('firearms', { id: missedId, user_id: uid, name: 'B', cartridge: 'y' });

  const correct = await c.pullTable('firearms');            // uses the real cursor
  c.resetCursors();
  const withNaive = await (async () => {
    const res = await c.selectView('firearms', `select=*&updated_at=gt.${encodeURIComponent(naive)}`);
    return res.data;
  })();

  ok(correct.some(r => r.id === missedId), 'server-stamp cursor finds the row');
  ok(!withNaive.some(r => r.id === missedId),
     'negative control: a client-clock cursor would have skipped it permanently');
}

/* ================================================ conflicts and soft deletes */
section('conflicts and soft deletes');
{
  const c = mkClient();
  await c.signUp('h@example.com', 'pw');
  const uid = c.getUser().id;

  mock.state.clock = 4_000_000;
  const id = c.uuid();
  mock.seed('firearms', { id, user_id: uid, name: 'server version', cartridge: '.308 Win' });

  // local edit not yet pushed, then a pull that carries the server's older copy
  c.setOnline(false);
  c.upsert('firearms', { id, name: 'local edit', cartridge: '.308 Win' });
  c.setOnline(true, { autoSync: false });

  const conflicts = [];
  c.on(c.EVENTS.SYNC_CONFLICT, p => conflicts.push(p));
  const rows = await c.pullTable('firearms');
  const { applied, skipped } = c.reconcile('firearms', rows);

  ok(skipped.includes(id), 'a pulled row with an unsent local edit is not applied');
  ok(conflicts.length === 1 && conflicts[0].resolution === 'kept-local-pending',
     'the conflict is reported rather than resolved silently');
  ok(applied.length === 0, 'nothing else was applied in this case');

  await c.sync({ trigger: 'test' });
  ok(mock.state.rows.get('firearms').get(id).name === 'local edit',
     'the local edit reaches the server intact');

  // soft delete
  c.remove('firearms', id);
  await c.sync({ trigger: 'test' });
  const row = mock.state.rows.get('firearms').get(id);
  ok(row.deleted_at != null, 'remove() writes a tombstone');
  ok(row.name === 'local edit', '...and retains the row so the deletion can propagate');
}

/* ================================================== leaderboard: shared surface */
section('leaderboard');
{
  const a = mkClient(); await a.signUp('lb-a@example.com', 'pw');
  const b = mkClient(); await b.signUp('lb-b@example.com', 'pw');

  a.claimHandle('Jaxon');
  const entryId = a.uuid();
  a.publishEntry({ id: entryId, occurred_on: '2026-08-13', position: 'Standing',
    target_name: 'NRA B-8', distance_yd: 100, shot_count: 10, score: 95, x_count: 3,
    mr_moa: 1.42, es_moa: 3.1, source_app: 'zero' });
  await a.sync({ trigger: 'test' });

  // THE FEATURE: a different account reads it
  const seen = await b.leaderboard();
  ok(seen.ok, 'a second account can query the leaderboard');
  const row = (seen.data || []).find(r => r.id === entryId);
  ok(!!row, 'B sees the entry A published');
  ok(row && row.handle === 'Jaxon', 'the entry carries A\'s public handle, not a raw user id');
  ok(row && row.score === 95, 'the score comes through intact');

  // ...while the private tables stay private
  let bPrivate = [];
  await b.sync({ trigger: 'test', apply: (t2, rows) => { if (t2 === 'recipes') bPrivate = rows; } });
  ok(bPrivate.length === 0, 'opening the leaderboard did not open the private tables');

  // B cannot rewrite A's entry: the outbox must NOT silently drop it either
  b.upsert('leaderboard_entries', { id: entryId, occurred_on: '2026-08-13',
    position: 'Standing', target_name: 'stolen', distance_yd: 100,
    shot_count: 10, score: 100, source_app: 'zero' });
  // queue a legitimate write alongside the doomed one: it must still get out
  b.claimHandle('Rival');
  const rejects = [];
  b.on(b.EVENTS.OUTBOX_REJECTED, p => rejects.push(p));
  const r = await b.sync({ trigger: 'test' });

  ok(mock.state.rows.get('leaderboard_entries').get(entryId).score === 95,
     'A\'s score is unchanged on the server');
  ok(rejects.length === 1 && rejects[0].status === 403,
     'the refused write is dead-lettered with its status, not retried forever');
  ok(b.rejectedList().length === 1, 'it is retrievable for the UI to show');

  // The poison-pill test: one permanently-rejected row must not block the rest.
  ok(r.ok, 'the sync as a whole still succeeds');
  ok(b.pendingCount() === 0, 'the outbox drains rather than jamming on the bad row');
  ok(mock.state.rows.get('leaderboard_profiles').get(b.getUser().id)?.handle === 'Rival',
     'B\'s own legitimate write got through in the same sync');

  // and a later sync is not still poisoned
  b.claimHandle('Rival2');
  const r2 = await b.sync({ trigger: 'test' });
  ok(r2.ok && b.pendingCount() === 0, 'subsequent syncs are unaffected');
  b.clearRejected();
  ok(b.rejectedList().length === 0, 'the diagnostic list can be cleared');
}

/* ============================================================== live relay */
section('live relay');
{
  const host = mkClient(), coach = mkClient(), stranger = mkClient();

  // No sign-up call anywhere: the relay creates identities by itself.
  const created = await host.createRelay({ hostName: 'Jaxon', title: 'Sunday league',
    targetName: 'NRA B-8', distanceYd: 100 });
  ok(created.ok, 'going live works with no account');
  ok(host.isSignedIn(), '...by creating an anonymous identity behind the scenes');
  ok(host.isAnonymous(), '...which is flagged anonymous');
  const code = created.relay.code;
  ok(/^[2-9BCDFGHJKMNPQRSTVWXZ]{4}$/.test(code), `the code is 4 sayable characters (${code})`);

  // host logs three shots
  for (const [n, ring, x, y] of [[1,'10',0,0],[2,'X',0.3,0.1],[3,'9',-0.55,0.2]]) {
    await host.relayPushShot({ shotNo: n, ring, x, y });
  }

  const joined = await coach.joinRelay(code, 'Coach Dave', 'coach');
  ok(joined.ok, 'the coach joins with the code alone');

  const seen = await coach.pollRelayOnce();
  ok(seen.ok && seen.shots.length === 3, `the coach sees the shot string (${seen.shots?.length})`);
  ok(seen.shots[1].ring === 'X', '...in order, with ring values');

  // the numbers a coach actually watches are pure point geometry
  const pts = seen.shots.map(s2 => ({ x: +s2.x_in, y: +s2.y_in }));
  const cx = pts.reduce((a, p2) => a + p2.x, 0) / pts.length;
  const cy = pts.reduce((a, p2) => a + p2.y, 0) / pts.length;
  const mr = pts.reduce((a, p2) => a + Math.hypot(p2.x - cx, p2.y - cy), 0) / pts.length;
  ok(mr > 0 && Number.isFinite(mr), `mean radius is computable from the relayed points (${mr.toFixed(3)}")`);

  // feed both ways
  await coach.relaySend('half value from 4, hold 0.5L', 'wind');
  await host.relaySend('seen, sending it');
  const after = await coach.pollRelayOnce();
  ok(after.messages.length === 2, 'the feed carries both voices');
  ok(after.messages.some(m => m.kind === 'wind'), 'a wind call is tagged as one');

  // a coach must never be able to fabricate the shooter's string
  const forged = await coach.relayPushShot({ shotNo: 9, ring: 'X', x: 0, y: 0 });
  ok(!forged.ok, 'a coach cannot log shots');

  // a stranger with no code gets nothing
  const guessed = await stranger.joinRelay('BBBB', 'nosy', 'coach');
  ok(!guessed.ok && guessed.reason === 'not_found', 'a wrong code is refused');
  for (let i = 0; i < 11; i++) await stranger.joinRelay('BBBB', 'nosy', 'coach');
  const throttled = await stranger.joinRelay('BBBB', 'nosy', 'coach');
  ok(throttled.reason === 'throttled', 'repeated guesses are throttled');

  // dedupe: the >= cursor deliberately re-sends boundary rows
  const before = (await coach.pollRelayOnce()).shots.length;
  const again = await coach.pollRelayOnce();
  ok(again.shots.length === before,
     're-polling does not duplicate shots (the >= cursor overlap is deduped by id)');

  // ending is visible to the viewer, and stops its polling
  let endedSeen = false;
  coach.on(coach.EVENTS.RELAY_ENDED, () => { endedSeen = true; });
  await host.endRelay();
  await coach.pollRelayOnce();
  ok(endedSeen, 'the coach is told when the shooter ends the relay');
  ok(coach.relayInfo() === null, '...and stops polling a dead relay');

  const late = await stranger.joinRelay(code, 'late', 'coach');
  ok(!late.ok, 'the code stops working once the relay ends');
}

/* ======================================================= pair fire: two + one */
section('pair fire — two shooters and a coach');
{
  const a = mkClient(), b = mkClient(), coach = mkClient();

  const made = await a.createRelay({ hostName: 'Jaxon', title: 'Pairs', distanceYd: 200 });
  ok(made.slot === 1, 'the shooter who starts the relay takes firing point 1');
  const code = made.relay.code;

  const bj = await b.joinRelay(code, 'Partner Pete', 'shooter');
  ok(bj.ok && bj.role === 'shooter', 'a partner joins as a shooter');
  ok(bj.slot === 2, '...on firing point 2');
  ok(b.relayInfo().canShoot === true, '...and is allowed to log shots');

  const cj = await coach.joinRelay(code, 'Coach Ruth', 'coach');
  ok(cj.slot === null, 'the coach takes no firing point');
  ok(coach.relayInfo().canShoot === false, '...and may not log shots');

  // both shooters fire a string, both numbered from 1
  await a.relayPushShot({ shotNo: 1, ring: '10', x: 0.1, y: 0.05, callX: 0, callY: 0 });
  await b.relayPushShot({ shotNo: 1, ring: '9',  x: -0.4, y: 0.2 });
  await a.relayPushShot({ shotNo: 2, ring: 'X',  x: 0.02, y: 0.03 });
  await b.relayPushShot({ shotNo: 2, ring: '10', x: -0.1, y: 0.15,
                          windCallMoa: 0.75, windCallDir: 'L' });

  const seenByCoach = await coach.pollRelayOnce();
  ok(seenByCoach.shots.length === 4,
     `both strings reach the coach, unmerged (${seenByCoach.shots.length})`);
  ok(new Set(seenByCoach.shots.map(x => x.slot)).size === 2,
     'the coach can tell the two strings apart by firing point');
  ok(seenByCoach.shots.every(x => x.shooter),
     '...and reads names, not numbers');
  ok(seenByCoach.shots.every(x => x.user_id === undefined),
     'no auth user id is exposed to co-participants');
  ok(seenByCoach.shots.some(x => x.call_x_in != null),
     "the shooter's call travels with the shot");
  ok(seenByCoach.shots.some(x => x.wind_call_moa != null),
     '...as does the wind call it was fired on');

  // ordering: grouped by firing point, not interleaved by arrival
  ok(seenByCoach.shots.map(x => x.slot).join('') === '1122',
     'shots are ordered by firing point, not by the order they arrived');

  const seenByA = await a.pollRelayOnce();
  ok(seenByA.shots.filter(x => x.is_self).length === 2,
     'a shooter can pick out their own two shots');
  ok(seenByA.shots.filter(x => !x.is_self).length === 2,
     "...and their partner's two, to draw in another colour");

  // and the write gate is per row, not per relay
  const forgedByPartner = await b.relayPushShot({ shotNo: 1, ring: 'X', x: 0, y: 0 });
  ok(forgedByPartner.ok,
     "a partner re-pushing shot 1 updates THEIR row, not the other shooter's");
  const afterForge = await coach.pollRelayOnce();
  ok(afterForge.shots.length === 4 ||
     (await coach.pollRelayOnce()).shots.length === 4,
     '...so the relay still holds four shots, not five');
  const aShot1 = (await coach.pollRelayOnce()).shots.find(x => x.slot === 1 && x.shot_no === 1);
  ok(aShot1 && aShot1.ring === '10',
     "the first shooter's shot 1 is untouched by the partner's write");

  const coachForge = await coach.relayPushShot({ shotNo: 1, ring: 'X', x: 0, y: 0 });
  ok(!coachForge.ok && coachForge.reason === 'not-shooter',
     'a coach is refused before a request is even sent');

  // only the shooter who started it may end it
  const bEnd = await b.endRelay();
  ok(!bEnd.ok, 'a partner cannot end the relay');
  await a.endRelay();
  const lateShot = await b.relayPushShot({ shotNo: 3, ring: '9', x: 0, y: 0 });
  ok(!lateShot.ok, 'an ended relay accepts no further shots');
}

/* ================================== the velocity summary has one author */
section('a chronograph summary survives the trip');
{
  const c = mkClient();
  await c.signUp('vel@example.com', 'pw12345');

  // Bench's shape: a chronograph readout and no shots. Nothing on the server
  // can derive the summary for such a session, so if the client drops it the
  // velocity is gone for good -- and with it muzzle_velocity_fps on every
  // ballistic profile built from that batch. This is the regression that a
  // client-side "velocity is always derived" rule caused.
  const bid = c.upsert('range_sessions', { occurred_on: '2026-08-02', source_app: 'bench',
    velocity_avg_fps: 2712, velocity_sd_fps: 7.4, velocity_es_fps: 20, velocity_n: 10 });
  await c.sync({ trigger: 'test' });
  const row = (mock.state.lastPush['range_sessions'] || []).find(r => r.id === bid);
  ok(row && row.velocity_avg_fps === 2712,
     'a chronograph summary reaches the server when there is no shot string to derive it from');
  ok(row && row.velocity_sd_fps === 7.4 && row.velocity_n === 10,
     '...including the spread, which is what drives vertical dispersion');

  // Zero's shape still works, and the summary it does not set stays unset --
  // the client invents nothing, it only declines to censor.
  const sid = c.upsert('range_sessions', { occurred_on: '2026-08-01', source_app: 'zero' });
  c.upsert('shots', { session_id: sid, shot_no: 1, velocity_fps: 2710 });
  await c.sync({ trigger: 'test' });
  const zeroRow = (mock.state.lastPush['range_sessions'] || []).find(r => r.id === sid);
  ok(zeroRow && !('velocity_avg_fps' in zeroRow),
     'a session that was never given a summary does not acquire one in transit');
}

/* ============================================================ user isolation */
section('user isolation');
{
  const a = mkClient(); await a.signUp('iso-a@example.com', 'pw');
  const b = mkClient(); await b.signUp('iso-b@example.com', 'pw');

  a.upsert('firearms', { name: 'A rifle', cartridge: '.223 Rem' });
  await a.sync({ trigger: 'test' });

  let bSaw = [];
  await b.sync({ trigger: 'test', apply: (t, rows) => { if (t === 'firearms') bSaw = rows; } });
  ok(bSaw.length === 0, 'a second account pulls none of the first account\'s rows');
}

/* ============================================================ outbox durability */
section('outbox durability');
{
  const shared = memStore();
  const c1 = mkClient(shared);
  await c1.signUp('dur@example.com', 'pw');
  c1.setOnline(false);
  c1.upsert('firearms', { name: 'queued before reload', cartridge: '.223 Rem' });
  ok(c1.pendingCount() === 1, 'a write is queued');

  // a fresh client over the same storage stands in for a page reload
  const c2 = mkClient(shared);
  ok(c2.pendingCount() === 1, 'the outbox survives a reload');
  ok(c2.isSignedIn(), 'the session survives a reload');

  await c2.signOut();
  ok(c2.pendingCount() === 1,
     'signing out keeps unsent work: it belongs to the user, not the session');
}

/* ============================================================ event coverage */
section('event coverage');
{
  const c = mkClient();
  const seen = new Set();
  Object.values(ZeroCore.EVENTS).forEach(e => c.on(e, () => seen.add(e)));
  await c.signUp('ev@example.com', 'pw');
  c.setOnline(false); c.setOnline(true, { autoSync: false });
  c.upsert('firearms', { name: 'ev', cartridge: 'x' });
  await c.sync({ trigger: 'test' });

  const expected = ['auth:signed-in', 'net:offline', 'net:online', 'outbox:changed',
                    'sync:start', 'sync:pulled', 'sync:pushed', 'sync:done', 'data:changed'];
  const missing = expected.filter(e => !seen.has(e));
  ok(missing.length === 0, 'the documented events all fire in a normal run'
     + (missing.length ? ' — missing: ' + missing.join(', ') : ''));

  // a throwing listener must not break the caller
  const c2 = mkClient();
  c2.on(c2.EVENTS.AUTH_SIGNED_IN, () => { throw new Error('listener exploded'); });
  const r = await c2.signUp('boom@example.com', 'pw');
  ok(r.ok, 'a listener that throws does not break the operation that emitted');
}

await mock.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
