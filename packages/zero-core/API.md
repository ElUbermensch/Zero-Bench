# zero-core — shared auth + sync layer for the Zero PWA family

**Status:** implemented and tested. 47 assertions pass against a mock GoTrue +
PostgREST, including the concurrency and cursor failure modes that only appear under
manufactured conditions. Two real bugs were found and fixed by that suite (§7).

One file, embedded byte-identically in every app. No SDK, no build step, no
dependencies — plain `fetch` against Supabase's REST endpoints, so each PWA stays
self-contained and degrades cleanly with no signal.

```js
const core = ZeroCore.create({
  url: 'https://<ref>.supabase.co',
  anonKey: '<public anon key>',
  appId: 'zero',            // or 'bench' — lands in source_app
  autoSyncMs: 60_000,       // 0 disables
});
```

---

## 1. Events — the complete list

Nothing outside this list is emitted, and nothing in it is emitted from anywhere else.
Both apps can treat it as total. Subscribe with `core.on(evt, fn)`, which returns an
unsubscribe function; `core.off(evt, fn)` also works.

A listener that throws is caught and ignored — one app's broken handler must not abort
a sync or an auth transition. (Tested.)

| Constant | Event | Payload | Fires when |
|---|---|---|---|
| `AUTH_SIGNED_IN` | `auth:signed-in` | `{ user }` | sign-in, sign-up, or session restored from storage |
| `AUTH_SIGNED_OUT` | `auth:signed-out` | `{ reason }` | `reason` is `'user'`, `'refresh-failed'` or `'revoked'` |
| `AUTH_TOKEN_REFRESHED` | `auth:token-refreshed` | `{ expiresAt }` | access token rotated |
| `AUTH_ERROR` | `auth:error` | `{ phase, error }` | `phase`: `signUp`/`signIn`/`signInWithOtp`/`refresh` |
| `NET_ONLINE` | `net:online` | `{}` | connectivity restored |
| `NET_OFFLINE` | `net:offline` | `{}` | connectivity lost |
| `SYNC_START` | `sync:start` | `{ trigger }` | `manual` / `interval` / `reconnect` / your own string |
| `SYNC_PULLED` | `sync:pulled` | `{ table, rows, cursor }` | per table, after a successful pull |
| `SYNC_PUSHED` | `sync:pushed` | `{ table, rows }` | per table, after a successful push |
| `SYNC_CONFLICT` | `sync:conflict` | `{ table, id, resolution }` | a pulled row was skipped; see §5 |
| `SYNC_DONE` | `sync:done` | `{ pulled, pushed, conflicts, ms }` | a sync run completed |
| `SYNC_ERROR` | `sync:error` | `{ phase, table, error }` | `phase`: `pull`/`push`/`select`/`sync` |
| `OUTBOX_CHANGED` | `outbox:changed` | `{ pending }` | queue depth changed — drive your sync badge from this |
| `DATA_CHANGED` | `data:changed` | `{ table, ids, origin }` | `origin` is `'local'` or `'remote'` — re-render on this |

**Both apps should render from `data:changed` and `outbox:changed`, not from sync
return values.** That way a row arriving from the other app updates the UI the same way
a local edit does.

---

## 2. Auth functions

| Function | Returns | Notes |
|---|---|---|
| `signUp(email, password)` | `{ ok, session?, needsConfirmation?, user?, error? }` | `needsConfirmation` is true when email confirmation is on and no tokens came back |
| `signIn(email, password)` | `{ ok, session?, error? }` | |
| `signInWithOtp(email)` | `{ ok, error? }` | magic link; needs mail delivery configured |
| `signOut()` | `Promise<void>` | clears session and cursors, **keeps the outbox** |
| `refresh()` | `Promise<boolean>` | single-flight; rarely called directly |
| `getSession()` / `getUser()` / `isSignedIn()` | | synchronous |

Sessions persist through `storage` (localStorage, or memory if the browser blocks it),
so a reload stays signed in. Tokens refresh automatically 60 s before expiry and on any
401.

**`signOut()` deliberately keeps unsent writes.** They're the user's work, not the
session's; signing back in should still deliver them. Only `reason: 'refresh-failed'`
indicates a session that died on its own.

---

## 3. Data functions

| Function | Notes |
|---|---|
| `upsert(table, row)` → `id` | queues a write, returns the id (generates a UUID if absent) |
| `remove(table, id)` | queues a **soft delete** — a tombstone, so other devices learn about it |
| `enqueue(table, row, op)` | lower-level form of the above |
| `pendingCount()` / `pendingFor(table)` | queue depth |
| `sync({ trigger, apply })` | push then pull, both in table order |
| `pullTable(table)` / `pushTable(table)` | single table, for targeted work |
| `reconcile(table, rows, apply)` | applies pulled rows, skipping ones with pending local edits |
| `selectView(view, query)` | read-only PostgREST query |
| `ballisticProfiles(query)` | `v_ballistic_profiles` — **what Zero calls to list loads** |
| `batchPerformance(query)` | `v_batch_performance` — what Bench calls for group data |
| `setOnline(bool, opts)` / `attachBrowserListeners(apply)` | connectivity |
| `startAutoSync(apply)` / `stopAutoSync()` | periodic sync |
| `resetCursors()` | forces a full re-pull |
| `uuid()` | client-side id generation |
| `track(event, metadata)` | queue a product-usage event; see §8 |
| `usageSessionId` | the id every event from this app load shares |

`apply(table, rows)` is your callback for writing pulled rows into local state. It is
passed through `sync`, `attachBrowserListeners` and `startAutoSync`.

Writes are **queued, never immediate**. `upsert` returns synchronously and always
succeeds; the network happens at the next sync. That's what makes the apps usable at
the range with no signal.

---

## 4. What the client never sends

`updated_at` and `created_at` are stripped from every payload — the server stamps them.
Phone clocks drift, and a device that has been offline since yesterday would otherwise
win every conflict.

`range_sessions.velocity_avg_fps / velocity_sd_fps / velocity_es_fps / velocity_n` are
also stripped. A database trigger derives them from the `shots` rows, so a
client-written summary would be silently overwritten on the next shot insert — and
would disagree with the underlying data until then. **Write the shot string; the
database does the statistics.**

Both are asserted against the actual transmitted payload, not the stored row. (Checking
the stored row would pass even if the client were happily transmitting them, since the
server overwrites regardless — that assertion was rewritten once for exactly this
reason.)

---

## 5. Sync semantics

**Order.** Push before pull, both walking `TABLES` in declared order, which is
parent-before-child. Insertion order into the outbox is irrelevant: queue a `shots` row
before its `range_sessions` parent and the parent still goes first. Otherwise the child
arrives at a foreign key that doesn't exist yet and takes a 409. (Tested by queuing the
child first on purpose.)

**Cursor.** Each table's pull cursor advances to the greatest `updated_at` the *server*
actually returned — never the client's clock. A row written while the pull was in
flight carries a later server stamp; a client-clock cursor would already be past it and
skip that row permanently. There's a negative control in the suite that reproduces the
bug to prove the guard does something.

**Conflicts.** Last-write-wins on the server's `updated_at`, with one exception: a
pulled row whose id has an unsent local edit is **not** applied, and a `sync:conflict`
with `resolution: 'kept-local-pending'` fires instead. The pending write is newer by
definition. Applying the remote copy would discard work the user has already done.

**Idempotency.** Client-generated UUID keys plus `Prefer: resolution=merge-duplicates`
make a retried push harmless. A second edit to an already-queued row *replaces* its
outbox entry, so the flush sends current state rather than replaying a stale snapshot.

**Deletes are soft.** A hard `DELETE` is invisible to a device that was offline when it
happened — it would resurrect the row on the next push. `remove()` writes `deleted_at`;
views filter it out, sync still carries the tombstone.

---

## 6. Wiring an app

```js
const core = ZeroCore.create({ url, anonKey, appId: 'zero', autoSyncMs: 60_000 });

core.on(core.EVENTS.DATA_CHANGED,   () => render());
core.on(core.EVENTS.OUTBOX_CHANGED, ({ pending }) => setBadge(pending));
core.on(core.EVENTS.AUTH_SIGNED_OUT, ({ reason }) => {
  showSignIn(reason === 'refresh-failed' ? 'Session expired, please sign in.' : null);
});

const apply = (table, rows) => mergeIntoLocalState(table, rows);
core.attachBrowserListeners(apply);
core.startAutoSync(apply);
if (core.isSignedIn()) core.sync({ trigger: 'startup', apply });
```

Zero listing selectable loads:

```js
const { data } = await core.ballisticProfiles('quarantined=eq.false&qty_remaining=gt.0');
```

Zero recording a string — write the shots, not the summary:

```js
const sid = core.upsert('range_sessions', {
  batch_id, firearm_id, occurred_on: today, temp_f, source_app: 'zero',
});
velocities.forEach((v, i) =>
  core.upsert('shots', { session_id: sid, shot_no: i + 1, velocity_fps: v }));
core.upsert('groups', { session_id: sid, distance_yd: 100, shot_count: 5,
                        group_es_in: 0.42, source_app: 'zero' });
await core.sync({ trigger: 'session-saved', apply });
```

---

## 7. Bugs this suite caught

Both were in my code, and neither is visible by reading it.

**A cached failure poisoned every later sync.** `syncInFlight = (async () => {…})()`
looks fine, but an async function body runs *synchronously up to its first `await`* —
and the offline guard returned before any await. So the body set `syncInFlight = null`
before the outer assignment overwrote it with the resolved promise. Every subsequent
`sync()` then short-circuited to that stale `{ok: false, reason: 'offline'}` forever,
including after connectivity returned. The guards now sit outside the async body.

**Single-flight refresh wasn't enough.** Ten parallel requests against an expired token
produced two refreshes, not one. Requests don't fail at the same instant: a straggler's
401 landed after the shared refresh had already completed and cleared itself, so it
started a second one — presenting a rotated refresh token. Fixed by capturing the token
each request used and, on 401, retrying immediately if the current token differs
instead of refreshing again.

---

## 8. Telemetry

`track(name, metadata)` queues a row on `analytics_event`, which the owner dashboard
reads through admin-only rollups. It rides the ordinary outbox, so it works offline
and pushes on the next sync like anything else.

```js
core.track('batch_created', { kind: 'batch' });
```

Four events are emitted by zero-core itself, so an app gets them for free:
`app_open` (once per visit), `sign_up`, `sign_in`, `sign_in_anonymous`, `sign_out`,
and `app_background` carrying `duration_ms`. Everything else is the app's own call.

**Opt out with `telemetry: false`.** The suite sets it, and so does the dashboard —
it must not appear in its own numbers.

Four things about it are deliberate and easy to undo by accident:

- **It never appears in `pendingCount()` or `outbox:changed`.** That number is the
  user's unsent *work*; a badge that never reaches zero because the app keeps
  measuring itself is a badge people stop believing.
- **It does not emit `data:changed`.** Zero re-renders on that event, so announcing
  telemetry would repaint the screen every time the app measured itself — and a
  render that tracks anything would then feed itself.
- **Every event carries the same keys.** `pushTable` groups the outbox by key
  signature, because PostgREST builds one column list for a bulk insert. An event
  that omitted `metadata` would be sent as its own request.
- **No user, no row.** `track()` returns `null` when signed out. The insert policy is
  `user_id = auth.uid()`, so the alternative is a queued write that is refused and
  lands in the rejected list both apps show the user. The cost is that a visit which
  never signs in is not counted, and that is the honest trade.

`created_at` is server-stamped and stripped from the payload like everywhere else;
`occurred_at` carries the client's clock, for events that queue offline for days. The
rollups group on `created_at`, the one a client cannot move.

## 9. Running the tests

```bash
node test-zero-core.mjs
```

`mock-supabase.mjs` is a small GoTrue + PostgREST stand-in with a virtual clock,
rotating refresh tokens, RLS-style per-user filtering, foreign-key rejection and hit
counters — so assertions like "exactly one refresh happened" are checkable.

The mock is **not** a substitute for testing against real Supabase before you trust it
with real data. It encodes my understanding of the endpoints, which is exactly the
thing that could be wrong.
