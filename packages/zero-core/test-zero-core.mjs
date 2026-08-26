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

  /* Deliberately NOT awaited: sign-out is fire-and-forget in both apps, which
   * re-render on the next tick. If the local session outlives the promise, the
   * UI redraws showing the user still signed in. */
  const outPromise = c.signOut();
  ok(!c.isSignedIn(), 'signOut clears the session before the network call, not after');
  await outPromise;
  ok(!c.isSignedIn(), '...and it stays cleared once the request settles');
  const out = events.find(([e]) => e === c.EVENTS.AUTH_SIGNED_OUT);
  ok(out && out[1].reason === 'user', 'signOut reports reason "user"');

  const bad = await c.signIn('jaxon@example.com', 'wrong');
  ok(!bad.ok, 'signIn with a wrong password fails');
  ok(!c.isSignedIn(), '...and does not leave a session behind');

  const good = await c.signIn('jaxon@example.com', 'hunter2');
  ok(good.ok && c.isSignedIn(), 'signIn with the right password succeeds');
}

/* ========================== a confirmation link arrives with a session in it */
/* Supabase's confirm-your-email link lands on the Site URL carrying
 * `#access_token=...&refresh_token=...&type=signup`. Nothing read it, so a new
 * user clicked the link and watched the app load as a stranger. */
section('a session in the URL fragment');
{
  const store = memStore();
  const seed = mkClient(store);
  await seed.signUp('confirm@example.com', 'pw');
  const tok = seed.getSession();

  // A fresh browser: no stored session, an auth callback in the fragment.
  const fresh = memStore();
  const loc = { hash: `#access_token=${tok.access_token}&refresh_token=${tok.refresh_token}`
                    + '&expires_in=3600&token_type=bearer&type=signup',
                pathname: '/', search: '' };
  globalThis.location = loc;
  globalThis.history = { replaceState: (a, b, url) => { loc.hash = ''; loc.replaced = url; } };

  const c = mkClient(fresh);
  ok(c.isSignedIn(), 'the app comes up signed in rather than as a stranger');
  ok(loc.hash === '', 'and the token is stripped from the URL, not left in history');
  ok(loc.replaced === '/', '...replacing rather than pushing');

  /* A Bench deep link lives in the same fragment. Touching it would send a
   * scanned label to the wrong screen. */
  const loc2 = { hash: '#/s/B26H13-01D', pathname: '/bench/', search: '' };
  globalThis.location = loc2;
  const c2 = mkClient(memStore());
  ok(!c2.isSignedIn() && loc2.hash === '#/s/B26H13-01D',
     'a deep link in the same fragment is left completely alone');

  delete globalThis.location; delete globalThis.history;
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

  /* No apply handler: nobody consumed the rows, so advancing the cursor would
   * discard them. A pull whose result goes nowhere must not be recorded as
   * having been received -- that is how a caller that syncs before it is ready
   * to apply silently loses every row written before it woke up. */
  await c.sync({ trigger: 'test' });
  ok(c.cursors.firearms === undefined,
     'a pull with no apply handler does not advance the cursor');

  /* The handler must SAY it consumed the table -- returning a value is the
   * signal. A handler that returns nothing is one that did not recognise the
   * table, and its rows must stay on the wrong side of the cursor. */
  await c.sync({ trigger: 'test', apply: () => ({ ok: true }) });
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

/* ================================= one bad row does not take the table with it */
/* The poison-pill test above put the doomed row in a DIFFERENT table from the
 * good one, so it only ever proved that a bad table does not stop a good one.
 * Everything queued for the same table went up in one PostgREST array, one
 * statement, one verdict -- and the 4xx that verdict produced dead-lettered
 * every row in it. A batch referencing a recipe that had not been pushed yet
 * would silently discard every other batch queued behind it. */
section('a refusal is isolated to the row that caused it');
{
  const c = mkClient();
  await c.signUp('isolate@example.com', 'pw');

  const recipeId = c.uuid();
  c.upsert('recipes', { id: recipeId, name: 'good recipe', charge_gr: 41.5 });
  await c.sync({ trigger: 'test', apply: () => {} });

  const goodIds = [c.uuid(), c.uuid(), c.uuid(), c.uuid()];
  const badId = c.uuid();
  // Interleaved, not appended: if isolation is done by "drop everything after
  // the first failure" the tail would vanish and this would still look fine.
  c.upsert('batches', { id: goodIds[0], recipe_id: recipeId, serial: 'A' });
  c.upsert('batches', { id: goodIds[1], recipe_id: recipeId, serial: 'B' });
  c.upsert('batches', { id: badId, recipe_id: c.uuid(), serial: 'ORPHAN' });
  c.upsert('batches', { id: goodIds[2], recipe_id: recipeId, serial: 'C' });
  c.upsert('batches', { id: goodIds[3], recipe_id: recipeId, serial: 'D' });

  const rejects = [];
  c.on(c.EVENTS.OUTBOX_REJECTED, p => rejects.push(p));
  const r = await c.sync({ trigger: 'test', apply: () => {} });

  const server = mock.state.rows.get('batches');
  const landed = goodIds.filter(id => server.get(id));
  ok(landed.length === 4, `every good row in the same table landed (${landed.length}/4)`);
  ok(!server.get(badId), 'the orphan did not');
  ok(c.rejectedList().length === 1 && c.rejectedList()[0].id === badId,
     'exactly one row is dead-lettered, and it is the offender');
  ok(rejects.length === 1 && rejects[0].ids.length === 1,
     'the rejection event names one id, not the whole queue');
  ok(r.ok && c.pendingCount() === 0, 'the sync succeeds and the queue drains');

  // Bisection, not one-at-a-time: 5 rows with a single offender should cost a
  // handful of requests, nowhere near one per row. This is a cost assertion,
  // not a correctness one, and it is loose on purpose.
  ok(mock.state.hits.push.batches <= 8,
     `isolating it took ${mock.state.hits.push.batches} requests, not one per row`);
}

/* =========================== two apps, one origin, one localStorage between them */
/* Zero is served from / and Bench from /bench/ on the SAME host, so the two
 * share a storage area. Everything zero-core kept there was unnamespaced. */
section('two apps sharing one storage area');
{
  const shared = memStore();
  const zero = mkClient(shared, { appId: 'zero' });
  const bench = mkClient(shared, { appId: 'bench' });

  await zero.signUp('both@example.com', 'pw');
  ok(bench.isSignedIn() === false,
     'a client already constructed does not retroactively see the new session');

  // A client built after the sign-in picks it up: the session is shared on
  // purpose, so signing in to one app signs you in to the other.
  const bench2 = mkClient(shared, { appId: 'bench' });
  ok(bench2.isSignedIn() && bench2.getUser().email === 'both@example.com',
     'the session IS shared — one sign-in serves both apps');

  /* Every check below constructs the second app's client AFTER the first has
   * written, because that is the real sequence: two pages, each reading
   * storage when it loads. A client built earlier holds its queue and cursors
   * in memory, which hides the sharing completely -- an earlier version of
   * this test did exactly that and passed against the bug. */
  zero.upsert('firearms', { id: zero.uuid(), name: 'Zero gun', cartridge: '6mm' });
  ok(zero.pendingCount() === 1, 'the write is queued in the app that made it');
  ok(mkClient(shared, { appId: 'bench' }).pendingCount() === 0,
     '...and a Bench page opened afterwards does not find it in ITS queue');

  /* The cursor is the destructive half. Zero syncs, consumes the rows, and
   * advances its cursor; a Bench page opened later must still see them, or a
   * firearm entered in one app is marked delivered before the other ever
   * asks for it. */
  const uidZ = zero.getUser().id;
  mock.state.clock = 5_000_000;
  const gunId = bench2.uuid();
  mock.seed('firearms', { id: gunId, user_id: uidZ, name: 'From the other side', cartridge: '.308' });

  let zeroSaw = [], benchSaw = [];
  await zero.sync({ trigger: 'test', apply: (t, rows) => { if (t === 'firearms') zeroSaw = rows; } });
  const benchLater = mkClient(shared, { appId: 'bench' });
  await benchLater.sync({ trigger: 'test', apply: (t, rows) => { if (t === 'firearms') benchSaw = rows; } });

  ok(zeroSaw.some(r => r.id === gunId), 'the app that syncs first sees the row');
  ok(benchSaw.some(r => r.id === gunId),
     'and so does the one opened afterwards — its cursor was not advanced by the first');
}

/* ============================ an install that predates the namespaced keys */
section('upgrading an install that has the old shared keys');
{
  const shared = memStore();
  const pendingRow = { id: '33333333-4444-5555-6666-777777777777',
                       name: 'Queued before the upgrade', cartridge: '6.5 CM' };
  shared.set('zerocore.outbox', [{ table: 'firearms', row: pendingRow, op: 'upsert', queuedAt: 1 }]);
  shared.set('zerocore.cursors', { firearms: '2026-01-01T00:00:00.000Z' });

  const c = mkClient(shared, { appId: 'bench' });
  ok(c.pendingCount() === 1, 'unsent work from before the upgrade is adopted, not stranded');
  ok(shared.get('zerocore.outbox') != null,
     'the legacy copy is left in place — it is the CLAIM that is exclusive, not the data');

  /* The half this section used to assert as desired, and should not have.
   *
   * A cursor is a claim that rows were already DELIVERED, and the legacy value
   * cannot say delivered to which app: pre-namespacing both apps shared one
   * cursor, so it is the maximum of what *some* app pulled. Adopting it copies
   * that corruption into both namespaces and silently exempts every row that
   * existed at upgrade time -- on precisely the installs that lived through the
   * bug. The shooter sees Bench's rifle picker come up empty beside a Zero
   * showing three rifles, on one account, and re-syncing does nothing. */
  ok(c.cursors.firearms === undefined,
     'the cursor is NOT adopted — it cannot say which app the rows were delivered to');

  /* And the queue is claimed ONCE. Both apps adopting it was called safe on the
   * grounds that every write is an id-keyed upsert, but idempotence is not
   * safety: the entry is a whole-row upsert of stale content, the server stamps
   * the replay as now, and nothing expires it. Zero pushes the adopted row, the
   * shooter corrects the name, and Bench -- opened later for something else --
   * replays its copy over the correction. No conflict is raised: SYNC_CONFLICT
   * only fires for pulled rows. */
  const second = mkClient(shared, { appId: 'zero' });
  ok(second.pendingCount() === 0,
     'a second app opened afterwards does NOT adopt the same queue a second time');
  ok(shared.get('zerocore.legacy-claimed') === 'bench',
     '...and the claim records which app took it');

  /* Negative control on the control: an app that finds the claim already taken
   * must still be a working client, not a crippled one. */
  second.upsert('firearms', { id: '99999999-4444-5555-6666-777777777777',
                              name: 'its own work', cartridge: '.223' });
  ok(second.pendingCount() === 1, '...but its own writes queue normally');
}

/* ---- and a claim made BEFORE the sentinel existed still counts ---- */
/* Namespacing shipped four days before the sentinel did, so there are devices
 * where one app adopted the legacy queue under the old code and left no record.
 * Checking only the sentinel, the second app finds it absent and adopts the
 * same stale rows a second time -- the exact double-push the sentinel exists to
 * stop, on precisely the installs that lived through the window. */
{
  const shared = memStore();
  const row = { id: '44444444-4444-5555-6666-777777777777',
                name: 'Queued before the upgrade', cartridge: '6.5 CM' };
  const legacy = [{ table: 'firearms', row, op: 'upsert', queuedAt: 1 }];
  shared.set('zerocore.outbox', legacy);
  // Bench adopted under the OLD code: namespaced key written, no sentinel.
  shared.set('zerocore.bench.outbox', legacy);

  ok(shared.get('zerocore.legacy-claimed') == null,
     'the device carries an adoption with no sentinel to show for it');
  const zero = mkClient(shared, { appId: 'zero' });
  ok(zero.pendingCount() === 0,
     'an outbox already holding the legacy rows is read as a claim, sentinel or not');
  ok(shared.get('zerocore.legacy-claimed') === 'pre-sentinel',
     '...and is recorded as one, so the question is only asked once');
}

/* ---- the same thing end to end: the correction, and the replay over it ---- */
{
  const shared = memStore();
  const c0 = mkClient(shared, { appId: 'zero' });
  await c0.signUp('legacy@example.com', 'pw');
  const gun = c0.uuid();

  // A row queued weeks ago, under the old un-namespaced key.
  shared.set('zerocore.outbox', [{ table: 'firearms', op: 'upsert', queuedAt: 1,
    row: { id: gun, name: 'STALE, queued weeks ago', cartridge: '6.5 CM' } }]);

  const zero = mkClient(shared, { appId: 'zero' });
  await zero.sync({ trigger: 'test', tables: [] });          // pushes the adopted row

  // The shooter notices the name is wrong and fixes it, today, in Zero.
  zero.upsert('firearms', { id: gun, name: 'CORRECT, typed today', cartridge: '6.5 CM' });
  await zero.sync({ trigger: 'test', tables: [] });

  // Bench is opened later for something else and syncs on its own.
  const bench = mkClient(shared, { appId: 'bench' });
  await bench.sync({ trigger: 'test', tables: [] });

  const rows = [...(mock.state.rows.get('firearms')?.values() || [])];
  const row = rows.find(r => r.id === gun);
  ok(row && row.name === 'CORRECT, typed today',
     `the correction stands — Bench had no second copy to replay over it (${row ? row.name : 'row missing'})`);
}

/* ======================== rows of different shapes in the same table's queue */
/* PostgREST builds one column list for a bulk insert and refuses a mixed array
 * with PGRST102. Two things make that routine rather than exotic: a tombstone
 * is {id, deleted_at} while an edit is a whole row, and the two apps
 * deliberately write different columns of `firearms` so neither erases fields
 * it does not model. Both end up in one device's queue. */
section('a table whose queue holds more than one row shape');
{
  const c = mkClient();
  await c.signUp('shapes@example.com', 'pw');

  const keepId = c.uuid(), goneId = c.uuid(), leanId = c.uuid();
  c.upsert('firearms', { id: keepId, name: 'Keeper', cartridge: '6.5 CM',
                         barrel_in: 26, twist: '1:8' });
  c.upsert('firearms', { id: goneId, name: 'Doomed', cartridge: '.308 Win' });
  await c.sync({ trigger: 'test', apply: () => {} });

  // Now: a tombstone, a full edit, and a row carrying only the other app's
  // columns — three shapes, one table, one sync.
  c.remove('firearms', goneId);
  c.upsert('firearms', { id: keepId, name: 'Keeper', cartridge: '6.5 CM',
                         barrel_in: 26, twist: '1:8.5' });
  c.upsert('firearms', { id: leanId, name: 'From the other app', cartridge: '.223 Rem',
                         barrel_life_rounds: 3000 });

  const before = mock.state.hits.push.firearms || 0;
  const beforePatch = mock.state.hits.patch.firearms || 0;
  const r = await c.sync({ trigger: 'test', apply: () => {} });
  const requests = (mock.state.hits.push.firearms || 0) - before;
  const patches = (mock.state.hits.patch.firearms || 0) - beforePatch;
  const t = mock.state.rows.get('firearms');

  ok(r.ok, 'the sync succeeds');
  /* Three shapes should cost three requests. Bisection would also get the
   * rows there -- splitting a PGRST102 eventually reaches single-row requests,
   * which are trivially uniform -- so this is the assertion that says the
   * queue was grouped up front rather than sorted out by trial and error.
   * A tombstone is common enough that paying 2n requests for it is not
   * acceptable just because the result is right. */
  ok(requests === 2, `one upsert request per row shape (${requests}), not a bisection`);
  /* The tombstone is not among them: it goes as a PATCH, because an upsert of
   * {id, deleted_at} fails the table's NOT NULL columns on the insert branch
   * before Postgres ever looks for the conflict. */
  ok(patches === 1, `and the tombstone went as one PATCH (${patches})`);
  ok(c.pendingCount() === 0, 'and the queue drains');
  ok(c.rejectedList().length === 0, 'nothing was dead-lettered');
  ok(t.get(keepId)?.twist === '1:8.5', 'the edit landed');
  ok(!!t.get(goneId)?.deleted_at, 'the tombstone landed');
  ok(t.get(leanId)?.barrel_life_rounds === 3000, 'so did the row with the other shape');

  /* The point of the fix, not just its effect: a row that carries only SOME of
   * a table's columns must leave the rest of that row alone on the server.
   * This is what lets the two apps share a firearm without either erasing the
   * fields it does not model. */
  /* "Partial" means a subset that still carries the NOT NULL columns -- which
   * is what both apps send, because name and cartridge are the two fields they
   * share. A payload without them is refused outright, insert branch first,
   * even for a row that already exists. */
  c.upsert('firearms', { id: keepId, name: 'Keeper', cartridge: '6.5 CM',
                         barrel_life_rounds: 2200 });
  await c.sync({ trigger: 'test', apply: () => {} });
  const after = mock.state.rows.get('firearms').get(keepId);
  ok(after.barrel_life_rounds === 2200 && after.twist === '1:8.5' && after.barrel_in === 26,
     'a partial write updates its own columns and preserves the others');
}

/* ============================================================== live relay */
/* ================== a client newer than the server it is talking to */
/* Migration 0009 adds a parameter to join_relay and a relay_face function. A
 * phone updates itself; a database does not. PostgREST resolves an RPC by the
 * keys in the body, so the new client's join would 404 against a server that
 * has not been migrated -- pair fire simply stops working, on a match morning,
 * for a reason nobody on the firing line can diagnose. */
section('joining a server that predates the target-overlay migration');
{
  mock.state.legacyRelayRpc = true;
  const host = mkClient(), partner = mkClient();
  const made = await host.createRelay({ hostName: 'Old Server', targetName: 'SR', distanceYd: 200 });
  ok(made.ok, 'going live still works');

  const j = await partner.joinRelay(made.relay.code, 'Pete', 'shooter',
                                    { distanceYd: 200, targetName: 'SR' });
  ok(j.ok, 'and joining still works — the client retries without the new argument');
  ok(j.slot === 2, '...with a real firing point, not a degraded seat');

  const st = await partner.pollRelayOnce();
  ok(st.ok, 'the relay polls normally');
  /* No face, and that is the correct outcome: the plot falls back to the bare
   * grid it drew before, rather than the app failing. */
  ok(partner.relayInfo() && !partner.relayInfo().face,
     'there is simply no target geometry, which the plot handles by drawing a grid');

  host.stopRelay(); partner.stopRelay();
  mock.state.legacyRelayRpc = false;
}

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

/* ======================================== connectivity is read, not remembered */
section('a client that starts offline can still sync later');
{
  /* `online` was read from navigator.onLine once, at construction, and nothing
   * ever wrote to it again -- neither app called setOnline or
   * attachBrowserListeners. A phone opened at a range with no signal latched
   * false and refused every sync for the life of the process: drive home, full
   * signal, tap Sync now, "offline". Only killing the app cleared it. */
  /* navigator is a getter-only property on globalThis in Node, so it is
   * redefined rather than assigned, and restored the same way. */
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let fakeOnline = false;
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, get: () => ({ get onLine() { return fakeOnline; } }),
  });
  try {
    const c = mkClient();                       // constructed while "offline"
    await c.signUp('net@example.com', 'pw12345');
    c.upsert('firearms', { name: 'Offline rifle', cartridge: '.308 Win' });

    const r1 = await c.sync({ trigger: 'test' });
    ok(!r1.ok && r1.reason === 'offline', 'a sync refuses while the device is offline');
    ok(c.pendingCount() === 1, '...and the write stays queued');

    fakeOnline = true;                          // signal comes back
    const r2 = await c.sync({ trigger: 'test' });
    ok(r2.ok, 'the very next sync succeeds — no restart, no setOnline call');
    ok(c.pendingCount() === 0, '...and the queued write lands');
    ok(c.isOnline === true, 'isOnline reports what sync() actually acts on');
  } finally {
    if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc);
    else delete globalThis.navigator;
  }
}

{
  // An explicit setOnline still wins, because a host that drives connectivity
  // itself must not be second-guessed by a navigator flag.
  const navDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, get: () => ({ onLine: true }),
  });
  try {
    const c = mkClient();
    await c.signUp('force@example.com', 'pw12345');
    c.setOnline(false);
    const r = await c.sync({ trigger: 'test' });
    ok(!r.ok && r.reason === 'offline',
       'an explicit setOnline(false) is honoured even when the browser says online');
  } finally {
    if (navDesc) Object.defineProperty(globalThis, 'navigator', navDesc);
    else delete globalThis.navigator;
  }
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

/* ================================================ the cursor is per table */
/* `consuming` used to be one boolean for the whole sync: `!!o.apply`. Both apps
 * pass a handler, but each understands only a few of the seventeen tables --
 * Zero's takes firearms and returns early for the rest, Bench's takes four. So
 * every sync pulled the other thirteen, discarded them, and moved the cursor
 * past them. The rows stay on the server; this device is simply never offered
 * them again, which means the day one of those tables grows an inverse it
 * starts from the cursor and never sees anything written before that day. */
section('the cursor moves per table, not per sync');
{
  const c = mkClient();
  await c.signUp('percursor@example.com', 'pw');
  const uid = c.getUser().id;
  mock.state.clock = 5_000_000;
  mock.seed('firearms', { id: c.uuid(), user_id: uid, name: 'understood', cartridge: '.308' });
  mock.seed('recipes',  { id: c.uuid(), user_id: uid, name: 'not understood' });

  // A handler that understands firearms and nothing else — both apps' shape.
  await c.sync({ trigger: 'test', apply: (t) => (t === 'firearms' ? { ok: true } : undefined) });

  ok(c.cursors.firearms === new Date(5_000_000).toISOString(),
     'the table the handler understood advances');
  ok(c.cursors.recipes === undefined,
     'the table it did not understand does NOT — those rows are still owed to this device');

  /* And the proof that it is owed: a later handler that DOES understand
   * recipes is handed the row that was pulled and discarded before it existed. */
  let seen = 0;
  await c.sync({ trigger: 'test', apply: (t, rows) => { if (t === 'recipes') { seen = rows.length; return { ok: true }; } } });
  ok(seen === 1, `a handler wired up later still receives the row (${seen})`);
  ok(c.cursors.recipes === new Date(5_000_000).toISOString(),
     '...and only now does its cursor move');
}

/* ============================ a row the handler could not place holds the cursor */
/* The per-table cursor above fixed half of this and, by fixing it, hid the other
 * half. "The handler returned something" was read as "the handler kept every
 * row", and Bench's readers do not keep every row: a range session whose batch
 * this device has never had hits `if (!batch) continue`, a shot whose session
 * was therefore never stored hits `if (!s) continue`, and the stat object comes
 * back {added:0,updated:0,removed:0} all the same. The cursor stepped over them
 * PERMANENTLY. Load the batch on this phone tomorrow and the forty sessions
 * fired with it are already behind the cursor: they are on the server, they are
 * paid for, and this device will never be offered them again.
 *
 * So a handler may now say which rows it could not place, and the cursor stops
 * short of the oldest of them. */
section('a row the handler could not place holds the cursor short of it');
{
  const c = mkClient();
  await c.signUp('deferred@example.com', 'pw');
  const uid = c.getUser().id;

  const at = {};
  for (const [name, t] of [['early', 1_000_000], ['stuck', 2_000_000], ['late', 3_000_000]]) {
    mock.state.clock = t;
    mock.seed('firearms', { id: c.uuid(), user_id: uid, name, cartridge: '.308' });
    at[name] = new Date(t).toISOString();
  }

  // The handler places everything except 'stuck' -- Bench's `if (!batch) continue`.
  const holdStuck = (t, rows) => {
    if (t !== 'firearms') return undefined;
    const stat = { added: 0, updated: 0, removed: 0, deferred: [] };
    for (const r of rows) {
      if (r.name === 'stuck') stat.deferred.push(r.updated_at);
      else stat.added++;
    }
    return stat;
  };

  await c.sync({ trigger: 'test', tables: ['firearms'], apply: holdStuck });
  ok(c.cursors.firearms === at.early,
     `the cursor stops below the row that could not be placed (${c.cursors.firearms})`);
  ok(c.floors.firearms && c.floors.firearms.at === at.stuck && c.floors.firearms.tries === 1,
     '...and records what it is waiting on, so the wait is visible');

  /* The whole point: it is offered AGAIN. Note 'late' comes back too -- it is
   * above the held row, and re-applying a row that is already local is a
   * no-op upsert, which is the price of not losing the one below it. */
  let offered = [];
  await c.sync({ trigger: 'test', tables: ['firearms'],
                 apply: (t, rows) => { if (t !== 'firearms') return undefined;
                                       offered = rows.map(r => r.name); return { added: rows.length }; } });
  ok(offered.includes('stuck'),
     `the held row is offered again on the next sync (${offered.join(', ') || 'nothing'})`);
  ok(c.cursors.firearms === at.late && !c.floors.firearms,
     '...and once it is placed the cursor catches up and the floor clears');
}

/* --- negative control: the same run with the old "a stat means I took them all" --- */
{
  const c = mkClient();
  await c.signUp('nocontrol@example.com', 'pw');
  const uid = c.getUser().id;
  mock.state.clock = 1_000_000;
  mock.seed('firearms', { id: c.uuid(), user_id: uid, name: 'early', cartridge: '.308' });
  mock.state.clock = 2_000_000;
  mock.seed('firearms', { id: c.uuid(), user_id: uid, name: 'stuck', cartridge: '.308' });

  // Reports nothing about what it dropped -- exactly what Bench's readers did.
  await c.sync({ trigger: 'test', tables: ['firearms'],
                 apply: (t) => (t === 'firearms' ? { added: 0, updated: 0, removed: 0 } : undefined) });
  ok(c.cursors.firearms === new Date(2_000_000).toISOString(),
     'negative control: a handler that reports no deferrals still advances to the newest row');

  let offered = null;
  await c.sync({ trigger: 'test', tables: ['firearms'],
                 apply: (t, rows) => { if (t !== 'firearms') return undefined;
                                       offered = rows.length; return { added: rows.length }; } });
  ok(offered === 0,
     'negative control: and the row it silently dropped is never offered again — the bug, reproduced');
}

/* --- the escape hatch, which matters as much as the rule --- */
/* Some rows are not late, they are never coming: a session for a batch that
 * lived only on a phone the user has since wiped. Held strictly, one of those
 * pins the cursor at 1970 and every sync re-downloads the whole table forever,
 * on cellular, at a range. A floor that has not moved in DEFER_MAX_TRIES syncs
 * is abandoned -- loudly. */
{
  const c = mkClient();
  await c.signUp('forever@example.com', 'pw');
  const uid = c.getUser().id;
  mock.state.clock = 1_000_000;
  mock.seed('firearms', { id: c.uuid(), user_id: uid, name: 'orphan', cartridge: '.308' });
  mock.state.clock = 2_000_000;
  mock.seed('firearms', { id: c.uuid(), user_id: uid, name: 'fine', cartridge: '.308' });

  const events = [];
  c.on(c.EVENTS.SYNC_DEFERRED, p => events.push(p));
  const holdForever = (t, rows) => {
    if (t !== 'firearms') return undefined;
    return { added: 0, deferred: rows.filter(r => r.name === 'orphan').map(r => r.updated_at) };
  };

  for (let i = 0; i < 3; i++) await c.sync({ trigger: 'test', tables: ['firearms'], apply: holdForever });
  /* 'orphan' is the oldest row there is, so there is nothing below it to
   * commit to and the cursor is pinned at the epoch -- which is exactly the
   * cost the escape hatch below exists to bound. */
  ok(c.cursors.firearms < new Date(1_000_000).toISOString()
     && c.floors.firearms && c.floors.firearms.tries === 3,
     `three syncs in it is still holding, and the cursor has not passed the row (${c.cursors.firearms})`);
  ok(events.length === 3 && events.every(e => !e.abandoned),
     `each attempt is reported and none has given up yet (${events.length})`);

  await c.sync({ trigger: 'test', tables: ['firearms'], apply: holdForever });
  ok(events.length === 4 && events[3].abandoned === true,
     'the fourth gives up rather than re-downloading the table forever');
  ok(c.cursors.firearms === new Date(2_000_000).toISOString() && !c.floors.firearms,
     '...and the cursor is released, so a permanently unplaceable row is bounded, not fatal');
}

/* ================== paging through a table that is being written underneath */
/* The pull used to page with `limit` and `offset`, which is sound only over a
 * result set whose ordering holds still for the whole walk. It does not:
 * set_updated_at re-stamps an edited row, which moves it to the END of an
 * ascending order, and everything after it shifts down a slot -- so the row
 * sitting on the next offset boundary is stepped over. The cursor then advances
 * to the newest row the pull DID return, and `gt.` excludes the skipped one
 * forever. Not "eventually consistent": gone, for that device.
 *
 * The second page is only reached when a table has more than a page of rows
 * newer than the cursor -- a first sync on a new phone, a restore, a reset.
 * Which is to say, exactly the moments a shooter is watching a year of data
 * come down and counting on all of it. */
section('paging a table that changes underneath the walk');
{
  const c = mkClient(undefined, { pageSize: 2 });   // three pages of two
  await c.signUp('paging@example.com', 'pw');
  const uid = c.getUser().id;

  const ids = [];
  for (let i = 1; i <= 6; i++) {
    mock.state.clock = 10_000_000 + i * 1000;
    const id = c.uuid();
    ids.push(id);
    mock.seed('firearms', { id, user_id: uid, name: `rifle ${i}`, cartridge: '.308' });
  }

  /* Another device edits rifle 2 between page one and page two, exactly as a
   * second phone syncing at the same moment would. Re-stamping moves it to the
   * end of the order, which is what shifts everything below it up a slot. */
  let pulls = 0;
  mock.state.onPull = (t) => {
    if (t !== 'firearms') return;
    // On the request for page TWO: page one has been served, page two has not.
    if (++pulls !== 2) return;
    mock.state.clock = 11_000_000;
    const row = mock.state.rows.get('firearms').get(ids[1]);
    row.updated_at = new Date(mock.state.clock).toISOString();
  };

  let saw = [];
  await c.sync({ trigger: 'test', tables: ['firearms'],
                 apply: (t, rows) => { if (t !== 'firearms') return undefined;
                                       saw = saw.concat(rows.map(r => r.name)); return { added: rows.length }; } });
  mock.state.onPull = null;

  const missing = ['rifle 1', 'rifle 3', 'rifle 4', 'rifle 5', 'rifle 6']
    .filter(n => !saw.includes(n));
  ok(missing.length === 0,
     `a row re-stamped mid-walk does not push another off the page (missing: ${missing.join(', ') || 'none'})`);

  // And the harder half: nothing is owed afterwards either.
  let later = [];
  await c.sync({ trigger: 'test', tables: ['firearms'],
                 apply: (t, rows) => { if (t !== 'firearms') return undefined;
                                       later = rows.map(r => r.name); return { added: rows.length }; } });
  ok(later.length === 0,
     `and the walk finished — nothing is still owed after it (${later.join(', ') || 'nothing'})`);
}

/* --- the URL the walk actually sends, because the mock was more forgiving --- */
/* `id` is a uuid column on every synced table, and `id.gt.` with nothing after
 * it makes Postgres try to cast '' to uuid -- which it refuses at PARSE time,
 * so the unreachable branch of the OR does not save it and the whole request is
 * a 400. That is the shape a start-of-timestamp position produced: the first
 * sync on a new phone, every already-installed device whose cursor is still a
 * bare timestamp, and every device after a reset, a sign-out, or Bench's "erase
 * all data". pullTable throws, the table loop aborts, and the cursor can only
 * become a position via a pull that succeeds -- so pull was dead permanently
 * while push kept working. Data went up, nothing came down, and every test in
 * this file was green, because the mock matched the empty id and answered 200.
 *
 * So this asserts the WIRE FORMAT, not the outcome. An outcome assertion is
 * exactly what missed it. */
section('the shape of the keyset request');
{
  const seen = [];
  const spy = async (url, init) => { seen.push(String(url)); return fetch(url, init); };
  const c = ZeroCore.create({ url: mock.url, anonKey: 'anon-key-public', appId: 'bench',
                              storage: memStore(), pageSize: 2, fetch: spy });
  await c.signUp('wire@example.com', 'pw');
  const uid = c.getUser().id;
  mock.state.clock = 30_000_000;
  for (let i = 0; i < 3; i++) {
    mock.seed('firearms', { id: c.uuid(), user_id: uid, name: `w${i}`, cartridge: '.308' });
  }

  seen.length = 0;
  const r = await c.sync({ trigger: 'test', tables: ['firearms'],
                           apply: (t, rows) => (t === 'firearms' ? { added: rows.length } : undefined) });
  ok(r.ok, `a first sync from an empty cursor succeeds (${r.ok ? 'ok' : r.reason})`);

  const pulls = seen.filter(u => u.includes('/rest/v1/firearms?select='));
  ok(pulls.length > 0, `and it issued a pull (${pulls.length})`);
  ok(!pulls.some(u => /id\.gt\.(&|$|\))/.test(u)),
     'no request asks for id.gt. with nothing after it — Postgres refuses that cast outright');
  ok(pulls.some(u => /updated_at=gte\./.test(u)),
     '...a start-of-timestamp position is spelled updated_at=gte. instead');
  ok(pulls.slice(1).every(u => /id\.gt\.[0-9a-fA-F-]{36}/.test(u) || /updated_at=gte\./.test(u)),
     '...and every later page carries a real uuid to resume from');

  /* And the mock is no longer the more forgiving of the two: the malformed URL
   * is refused here the way the server refuses it, so this cannot regress into
   * a green suite again. */
  const bad = await fetch(mock.url +
    '/rest/v1/firearms?select=*&or=(updated_at.gt.1970-01-01T00:00:00Z,and(updated_at.eq.1970-01-01T00:00:00Z,id.gt.))',
    { headers: { apikey: 'anon-key-public', Authorization: 'Bearer ' + c.getSession().access_token } });
  ok(bad.status === 400,
     `the mock refuses an empty uuid the way Postgres does (${bad.status})`);
}

/* --- the tie group, which is not an edge case but the normal case --- */
/* `updated_at` defaults to now(), and now() is the TRANSACTION timestamp, so
 * every row of one bulk push carries an identical stamp. Ordering by it alone
 * is a partial order, and a page boundary inside a tie group has no defined
 * position to resume from: a naive `gt.<last stamp>` skips the rest of the
 * group, and `gte.` returns the same page forever. */
{
  const c = mkClient(undefined, { pageSize: 2 });
  await c.signUp('ties@example.com', 'pw');
  const uid = c.getUser().id;

  mock.state.clock = 20_000_000;                   // ONE stamp for all five
  const names = [];
  for (let i = 1; i <= 5; i++) {
    names.push(`tied ${i}`);
    mock.seed('firearms', { id: c.uuid(), user_id: uid, name: `tied ${i}`, cartridge: '.308' });
  }

  let saw = [];
  await c.sync({ trigger: 'test', tables: ['firearms'],
                 apply: (t, rows) => { if (t !== 'firearms') return undefined;
                                       saw = saw.concat(rows.map(r => r.name)); return { added: rows.length }; } });
  const stamps = new Set([...mock.state.rows.get('firearms').values()]
    .filter(r => /^tied /.test(r.name)).map(r => r.updated_at));
  ok(stamps.size === 1,
     `five rows written together share one timestamp (${stamps.size} distinct)`);
  ok(names.every(n => saw.includes(n)) && saw.length === 5,
     `a tie group larger than a page is walked exactly once (${saw.length} of 5, ${saw.join(', ')})`);

  let later = [];
  await c.sync({ trigger: 'test', tables: ['firearms'],
                 apply: (t, rows) => { if (t !== 'firearms') return undefined;
                                       later = rows.map(r => r.name); return { added: rows.length }; } });
  ok(later.length === 0,
     `...and does not repeat forever, which is what gte. would do (${later.length} again)`);
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

/* ========================================================= whole-device backup */
/* Moving to a second phone used to mean exporting a JSON file and carrying it
 * across by hand, which on a home-screen PWA on iOS mostly meant it could not
 * be carried across at all. A snapshot in one bounded row is the replacement.
 *
 * It is deliberately NOT the outbox: the outbox retries forever so a write
 * made with no signal still lands, and a backup that "will happen later" is
 * one the user believes they have and does not. */
section('whole-device backup');
{
  const c = mkClient(undefined, { appId: 'zero' });
  await c.signUp('backup@example.com', 'pw');

  const payload = JSON.stringify({ sessions_v1: [{ id: 's1' }], rifles_v1: [] });
  const put = await c.backupPut({ app: 'zero', payload, counts: { sessions: 1 },
                                  deviceLabel: 'iPhone', appBuild: 'test' });
  ok(put.ok, 'a snapshot goes up');
  ok(c.pendingCount() === 0,
     '...without touching the outbox — it is a direct write, not queued work');

  const got = await c.backupGet({ app: 'zero' });
  ok(got.ok && got.found && got.row.payload === payload,
     'and comes back byte for byte');
  ok(got.row.counts && got.row.counts.sessions === 1,
     'the record counts travel, so a restore screen can say what is in there');

  /* The failure this guards: a second backup that INSERTs rather than updates
   * leaves two rows in a table with one unique slot, and the restore reads
   * whichever the server happens to return first. */
  const p2 = JSON.stringify({ sessions_v1: [{ id: 's1' }, { id: 's2' }] });
  const put2 = await c.backupPut({ app: 'zero', payload: p2 });
  ok(put2.ok, 'a second backup succeeds');
  const list = await c.backupList('zero');
  ok(list.ok && list.data.length === 1,
     `...over the top of the first, not beside it (${list.ok ? list.data.length : '?'} row)`);
  const got2 = await c.backupGet({ app: 'zero' });
  ok(got2.row.payload === p2, 'and it is the newer snapshot that is stored');

  /* The list is what a restore screen renders before committing a phone to
   * downloading megabytes, so it must not contain the megabytes. */
  ok(list.data[0].payload === undefined, 'the listing carries no payload');
  ok(list.data[0].bytes === Buffer.byteLength(p2, 'utf8'),
     'but does say how big the snapshot is');

  /* Slots are separate rows, which is what makes "keep a known-good copy
   * before I do something drastic" possible at all. */
  await c.backupPut({ app: 'zero', slot: 'slot2', payload: '{"a":1}' });
  const list2 = await c.backupList('zero');
  ok(list2.data.length === 2, 'a second slot is a second row');
  ok((await c.backupGet({ app: 'zero' })).row.payload === p2,
     '...and writing it did not disturb the default slot');

  /* Bench and Zero share an account and must not share a snapshot: restoring
   * a bench into a shooting log would be nonsense. */
  const b = mkClient(undefined, { appId: 'bench' });
  await b.signIn('backup@example.com', 'pw');
  await b.backupPut({ app: 'bench', payload: '{"bench":true}' });
  ok((await c.backupGet({ app: 'zero' })).row.payload === p2,
     "Bench's snapshot does not overwrite Zero's");
  ok((await b.backupGet({ app: 'bench' })).row.payload === '{"bench":true}',
     '...and each app reads back its own');

  /* Refused BEFORE the upload, not after: finding out by sending eight
   * megabytes over a phone connection and being turned down is a bad way to
   * learn the limit. */
  const huge = 'x'.repeat(c.BACKUP_MAX_BYTES + 1);
  const big = await c.backupPut({ app: 'zero', slot: 'slot3', payload: huge });
  ok(!big.ok && big.reason === 'too large',
     'an oversized snapshot is refused, with the size and the limit');
  ok(big.bytes > big.limit, '...and says by how much');

  /* An anonymous device exists to shoot one pair-fire string. It must not be
   * able to park megabytes per slot on the server. */
  const anon = mkClient(undefined, { appId: 'zero' });
  await anon.signInAnonymously();
  const a = await anon.backupPut({ app: 'zero', payload: '{}' });
  ok(!a.ok, 'an anonymous device cannot back up');

  const none = mkClient(undefined, { appId: 'zero' });
  const n = await none.backupPut({ app: 'zero', payload: '{}' });
  ok(!n.ok && /signed in/.test(n.reason), 'nor can a device with no account');
}

await mock.stop();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
