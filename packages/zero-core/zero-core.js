/* ============================================================================
 * zero-core — shared auth + sync layer for the Zero PWA family
 *
 * One module, embedded byte-identically in every app (Zero, the reloading
 * tracker, anything later). No SDK, no build step, no dependencies: it talks to
 * Supabase's GoTrue and PostgREST endpoints with fetch, so each app stays a
 * single self-contained file and still works with no signal.
 *
 * Design commitments, each of which exists because the obvious version is wrong:
 *
 *   - A 401 triggers ONE refresh shared by every in-flight request. Naive
 *     per-request refresh stampedes: ten parallel requests become ten refresh
 *     calls, nine of which present an already-rotated token and fail.
 *   - The outbox flushes in declared table order, which IS foreign-key order.
 *     Pushing a `shots` row before its `range_sessions` parent is a 409.
 *   - The pull cursor advances to the greatest `updated_at` actually returned by
 *     the server, never to the client's clock. Using local `now()` silently
 *     drops every row written between the query and the cursor write.
 *   - `updated_at` is never sent. The server stamps it; phone clocks drift and a
 *     device offline since yesterday would otherwise win every conflict.
 *   - A pull never clobbers a row with unsent local edits.
 * ==========================================================================*/
'use strict';

const ZeroCore = (() => {

  /* ---------------------------------------------------------------- events */
  /** Every event this module emits. Nothing else is emitted; nothing here is
   *  emitted from anywhere else. Both apps can rely on this list being total. */
  const EVENTS = Object.freeze({
    AUTH_SIGNED_IN:      'auth:signed-in',      // { user }
    AUTH_SIGNED_OUT:     'auth:signed-out',     // { reason: 'user'|'refresh-failed'|'revoked' }
    AUTH_TOKEN_REFRESHED:'auth:token-refreshed',// { expiresAt }
    AUTH_ERROR:          'auth:error',          // { phase, error }
    NET_ONLINE:          'net:online',          // {}
    NET_OFFLINE:         'net:offline',         // {}
    SYNC_START:          'sync:start',          // { trigger }
    SYNC_PULLED:         'sync:pulled',         // { table, rows, cursor }
    SYNC_PUSHED:         'sync:pushed',         // { table, rows }
    SYNC_CONFLICT:       'sync:conflict',       // { table, id, resolution }
    SYNC_DONE:           'sync:done',           // { pulled, pushed, conflicts, ms }
    SYNC_ERROR:          'sync:error',          // { phase, table, error }
    OUTBOX_CHANGED:      'outbox:changed',      // { pending, rejected }
    OUTBOX_REJECTED:     'outbox:rejected',     // { table, ids, status, error }
    DATA_CHANGED:        'data:changed',        // { table, ids, origin }
  });

  /** Declared parent-before-child. Push and pull both walk this order, so a
   *  child row can never reach the server before the parent it references. */
  const TABLES = Object.freeze([
    'profiles',
    'firearms',
    'bullet_products', 'powder_products', 'primer_products',
    'component_lots',
    'brass_lots', 'brass_events',
    'recipes',
    'batches',
    'range_sessions',
    'shots', 'groups', 'dope_entries',
    // Shared surface: public-read, own-write. Writes ride the same outbox so
    // publishing works offline at a match; reads go through leaderboard().
    'leaderboard_profiles', 'leaderboard_entries',
  ]);

  /** Columns the server owns. Sending them is at best ignored and at worst
   *  lets a client clock decide conflict resolution. */
  const SERVER_OWNED = Object.freeze(['updated_at', 'created_at']);

  /** Velocity summaries are derived by a database trigger from `shots`. A
   *  client that writes them is writing a value the next shot insert erases. */
  const DERIVED = Object.freeze({
    range_sessions: ['velocity_avg_fps', 'velocity_sd_fps', 'velocity_es_fps', 'velocity_n'],
  });

  /* --------------------------------------------------------------- helpers */
  const nowMs = () => Date.now();
  const uuid = () => (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : ((r & 0x3) | 0x8)).toString(16);
      });

  const stripServerOwned = (table, row) => {
    const out = {};
    const drop = new Set([...SERVER_OWNED, ...(DERIVED[table] || [])]);
    for (const k of Object.keys(row)) if (!drop.has(k)) out[k] = row[k];
    return out;
  };

  /* ------------------------------------------------------------- instance */
  function create(options) {
    const cfg = Object.assign({
      url: null,              // https://<ref>.supabase.co
      anonKey: null,
      appId: 'unknown',       // 'zero' | 'tracker' — lands in source_app
      tables: TABLES,
      storage: null,          // injectable; defaults to localStorage or memory
      fetch: (globalThis.fetch ? globalThis.fetch.bind(globalThis) : null),
      pageSize: 500,
      refreshSkewMs: 60_000,  // refresh this long before the token actually dies
      autoSyncMs: 0,          // 0 disables the periodic sync
    }, options || {});

    if (!cfg.url || !cfg.anonKey) throw new Error('zero-core: url and anonKey are required');
    if (!cfg.fetch) throw new Error('zero-core: no fetch available');

    const store = cfg.storage || defaultStorage();
    const K = {
      session: 'zerocore.session',
      cursors: 'zerocore.cursors',
      outbox:  'zerocore.outbox',
      rejected:'zerocore.rejected',
    };

    /* -------------------------------------------------------- event bus */
    const listeners = new Map();
    function on(evt, fn) {
      if (!listeners.has(evt)) listeners.set(evt, new Set());
      listeners.get(evt).add(fn);
      return () => off(evt, fn);
    }
    function off(evt, fn) {
      const s = listeners.get(evt);
      if (s) s.delete(fn);
    }
    function emit(evt, payload) {
      const s = listeners.get(evt);
      if (!s) return;
      // A throwing listener must not abort a sync or an auth transition.
      for (const fn of [...s]) {
        try { fn(payload || {}, evt); } catch (e) { /* listener's problem */ }
      }
    }

    /* ------------------------------------------------------------- state */
    let session = store.get(K.session) || null;   // { access_token, refresh_token, expires_at, user }
    let cursors = store.get(K.cursors) || {};     // { table: iso-timestamp }
    let outbox  = store.get(K.outbox)  || [];     // [{ id, table, row, op, queuedAt }]
    let rejected = store.get(K.rejected) || [];   // dead-lettered writes, see pushTable
    let online  = (typeof navigator === 'undefined') ? true : navigator.onLine !== false;
    let refreshInFlight = null;                    // the single shared refresh
    let syncInFlight = null;
    let autoTimer = null;

    const persistOutbox = () => {
      store.set(K.outbox, outbox);
      store.set(K.rejected, rejected);
      emit(EVENTS.OUTBOX_CHANGED, { pending: outbox.length, rejected: rejected.length });
    };

    /* ---------------------------------------------------------- transport */
    async function raw(path, init) {
      const res = await cfg.fetch(cfg.url + path, init);
      return res;
    }

    function authHeaders(extra) {
      const h = Object.assign({
        apikey: cfg.anonKey,
        'Content-Type': 'application/json',
      }, extra || {});
      if (session && session.access_token) {
        h.Authorization = 'Bearer ' + session.access_token;
      }
      return h;
    }

    /**
     * Authenticated request with a single-flight refresh on 401.
     * `retry` guards against a refresh that succeeds but still yields 401,
     * which would otherwise recurse forever.
     */
    async function authed(path, init, retry = true) {
      if (session && session.expires_at &&
          session.expires_at - cfg.refreshSkewMs <= nowMs()) {
        await refresh();                     // proactive; still single-flight
      }
      const tokenUsed = session && session.access_token;
      const res = await raw(path, Object.assign({}, init, {
        headers: authHeaders(init && init.headers),
      }));
      if (res.status === 401 && retry && session && session.refresh_token) {
        // Requests do NOT all fail at the same instant. A straggler whose 401
        // lands after someone else's refresh already completed must not kick
        // off a second refresh -- single-flight alone does not cover this,
        // because by then the shared promise has been cleared. If the token in
        // hand differs from the one this request used, a refresh already
        // happened; just retry with the new one.
        if (session.access_token !== tokenUsed) return authed(path, init, false);
        const ok = await refresh();
        if (ok) return authed(path, init, false);
      }
      return res;
    }

    /* -------------------------------------------------------------- auth */
    function setSession(s, reason) {
      session = s;
      store.set(K.session, s);
      if (s) emit(EVENTS.AUTH_SIGNED_IN, { user: s.user });
      else emit(EVENTS.AUTH_SIGNED_OUT, { reason: reason || 'user' });
    }

    function shapeSession(json) {
      // GoTrue returns expires_in (seconds). Absolute ms is what we can compare.
      const ttl = (json.expires_in != null ? json.expires_in : 3600) * 1000;
      return {
        access_token: json.access_token,
        refresh_token: json.refresh_token,
        expires_at: nowMs() + ttl,
        user: json.user || null,
      };
    }

    async function signUp(email, password) {
      const res = await raw('/auth/v1/signup', {
        method: 'POST',
        headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        emit(EVENTS.AUTH_ERROR, { phase: 'signUp', error: json });
        return { ok: false, error: json };
      }
      // With email confirmation on, signup returns a user but no tokens.
      if (json.access_token) setSession(shapeSession(json));
      return { ok: true, session, needsConfirmation: !json.access_token, user: json.user };
    }

    async function signIn(email, password) {
      const res = await raw('/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        emit(EVENTS.AUTH_ERROR, { phase: 'signIn', error: json });
        return { ok: false, error: json };
      }
      setSession(shapeSession(json));
      return { ok: true, session };
    }

    /** Magic link / OTP. No password to lose, but needs mail delivery working. */
    async function signInWithOtp(email) {
      const res = await raw('/auth/v1/otp', {
        method: 'POST',
        headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, create_user: true }),
      });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        emit(EVENTS.AUTH_ERROR, { phase: 'signInWithOtp', error });
        return { ok: false, error };
      }
      return { ok: true };
    }

    /**
     * Single-flight token refresh. Every caller awaits the same promise, so N
     * concurrent 401s produce exactly one network call. A failed refresh is
     * terminal: the refresh token has been rotated or revoked, and the only
     * correct response is to sign out rather than retry with a dead token.
     */
    function refresh() {
      if (refreshInFlight) return refreshInFlight;
      if (!session || !session.refresh_token) return Promise.resolve(false);

      refreshInFlight = (async () => {
        try {
          const res = await raw('/auth/v1/token?grant_type=refresh_token', {
            method: 'POST',
            headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ refresh_token: session.refresh_token }),
          });
          if (!res.ok) {
            setSession(null, 'refresh-failed');
            emit(EVENTS.AUTH_ERROR, { phase: 'refresh', error: { status: res.status } });
            return false;
          }
          const json = await res.json();
          session = shapeSession(json);
          store.set(K.session, session);
          emit(EVENTS.AUTH_TOKEN_REFRESHED, { expiresAt: session.expires_at });
          return true;
        } catch (e) {
          // A network failure is NOT a dead token: stay signed in and retry later.
          emit(EVENTS.AUTH_ERROR, { phase: 'refresh', error: String(e) });
          return false;
        } finally {
          refreshInFlight = null;
        }
      })();
      return refreshInFlight;
    }

    async function signOut() {
      if (session && session.access_token) {
        try {
          await raw('/auth/v1/logout', { method: 'POST', headers: authHeaders() });
        } catch (e) { /* local sign-out proceeds regardless */ }
      }
      setSession(null, 'user');
      cursors = {};
      store.set(K.cursors, cursors);
      // The outbox is deliberately NOT cleared: unsent work belongs to the user,
      // not the session, and signing back in should still deliver it.
    }

    const getSession = () => session;
    const getUser = () => (session && session.user) || null;
    const isSignedIn = () => !!(session && session.access_token);

    /* -------------------------------------------------------------- outbox */
    /**
     * Queue a write. The row is stored whole, so a later flush sends the latest
     * state rather than replaying a stale snapshot: a second edit to the same
     * row replaces the queued entry instead of appending another.
     */
    function enqueue(table, row, op) {
      if (!cfg.tables.includes(table)) throw new Error('zero-core: unknown table ' + table);
      if (!row.id) row.id = uuid();
      const clean = stripServerOwned(table, row);
      const at = outbox.findIndex(e => e.table === table && e.row.id === row.id);
      const entry = { table, row: clean, op: op || 'upsert', queuedAt: nowMs() };
      if (at >= 0) outbox[at] = entry; else outbox.push(entry);
      persistOutbox();
      emit(EVENTS.DATA_CHANGED, { table, ids: [row.id], origin: 'local' });
      return row.id;
    }

    const upsert = (table, row) => enqueue(table, row, 'upsert');

    /** Soft delete: a tombstone, so a device that was offline learns about it. */
    const remove = (table, id) =>
      enqueue(table, { id, deleted_at: new Date().toISOString() }, 'upsert');

    const pendingCount = () => outbox.length;
    const rejectedList = () => rejected.map(r => ({ table: r.table, id: r.row.id,
      status: r.status, error: r.error, rejectedAt: r.rejectedAt }));
    const clearRejected = () => { rejected = []; persistOutbox(); };
    const pendingFor = (table) => outbox.filter(e => e.table === table).length;

    /* ---------------------------------------------------------------- pull */
    async function pullTable(table) {
      const since = cursors[table] || '1970-01-01T00:00:00Z';
      let offset = 0, all = [];
      for (;;) {
        const q = `/rest/v1/${table}` +
          `?select=*&updated_at=gt.${encodeURIComponent(since)}` +
          `&order=updated_at.asc&limit=${cfg.pageSize}&offset=${offset}`;
        const res = await authed(q, { method: 'GET' });
        if (!res.ok) {
          const error = await res.text().catch(() => '');
          emit(EVENTS.SYNC_ERROR, { phase: 'pull', table, error: { status: res.status, body: error } });
          throw new Error(`pull ${table}: ${res.status}`);
        }
        const page = await res.json();
        all = all.concat(page);
        if (page.length < cfg.pageSize) break;
        offset += cfg.pageSize;
      }

      // Advance the cursor to the newest row the SERVER actually returned.
      // Using a local timestamp here loses every row written mid-sync.
      if (all.length) {
        const newest = all.reduce((m, r) => (r.updated_at > m ? r.updated_at : m), since);
        cursors[table] = newest;
        store.set(K.cursors, cursors);
      }
      emit(EVENTS.SYNC_PULLED, { table, rows: all, cursor: cursors[table] || since });
      return all;
    }

    /**
     * Apply pulled rows to local state. A row with an unsent local edit is left
     * alone -- the pending write is newer by definition and would be lost.
     */
    function reconcile(table, rows, apply) {
      const pending = new Set(outbox.filter(e => e.table === table).map(e => e.row.id));
      const applied = [], skipped = [];
      for (const r of rows) {
        if (pending.has(r.id)) {
          skipped.push(r.id);
          emit(EVENTS.SYNC_CONFLICT, { table, id: r.id, resolution: 'kept-local-pending' });
          continue;
        }
        applied.push(r);
      }
      if (apply) apply(table, applied);
      if (applied.length) {
        emit(EVENTS.DATA_CHANGED, { table, ids: applied.map(r => r.id), origin: 'remote' });
      }
      return { applied, skipped };
    }

    /* ---------------------------------------------------------------- push */
    async function pushTable(table) {
      const mine = outbox.filter(e => e.table === table);
      if (!mine.length) return 0;
      const body = mine.map(e => e.row);

      const res = await authed(`/rest/v1/${table}?on_conflict=id`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const error = await res.text().catch(() => '');
        /*
         * A 4xx here is the server saying "this row will never be accepted":
         * RLS refused it (403), a constraint rejected it (400), the payload is
         * malformed (422). Retrying forever would be pointless AND actively
         * harmful -- the failed push aborts the whole sync, so one poisoned
         * row permanently blocks every other pending write from ever leaving
         * the device. Dead-letter it instead, surface it, and keep going.
         *
         * 5xx and network failures are NOT dead-lettered: those are transient
         * and the row deserves another attempt.
         */
        if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) {
          const ids = new Set(mine.map(e => e.row.id));
          outbox = outbox.filter(e => !(e.table === table && ids.has(e.row.id)));
          rejected = rejected.concat(mine.map(e => ({
            table, row: e.row, status: res.status, error: String(error).slice(0, 400),
            rejectedAt: nowMs(),
          }))).slice(-100);                    // bounded: this is a diagnostic, not a queue
          persistOutbox();
          emit(EVENTS.OUTBOX_REJECTED, { table, ids: [...ids], status: res.status, error });
          emit(EVENTS.SYNC_ERROR, { phase: 'push', table, error: { status: res.status, body: error } });
          return 0;                            // sync continues; other tables still flush
        }
        emit(EVENTS.SYNC_ERROR, { phase: 'push', table, error: { status: res.status, body: error } });
        throw new Error(`push ${table}: ${res.status}`);
      }
      const saved = await res.json().catch(() => body);

      // Only drop the entries we actually sent. Anything queued while the
      // request was in flight stays, or that edit is silently lost.
      const sent = new Set(mine.map(e => e.row.id));
      outbox = outbox.filter(e => !(e.table === table && sent.has(e.row.id) &&
                                    mine.find(m => m.row.id === e.row.id) === e));
      persistOutbox();
      emit(EVENTS.SYNC_PUSHED, { table, rows: saved });
      return mine.length;
    }

    /* ---------------------------------------------------------------- sync */
    /**
     * Push then pull, both in declared table order. Push first so a row created
     * offline is on the server before the pull that would otherwise report it
     * missing. Concurrent calls share one run.
     */
    function sync(opts) {
      if (syncInFlight) return syncInFlight;
      const o = opts || {};
      const empty = { pulled: 0, pushed: 0, conflicts: 0, ms: 0 };

      // These guards MUST sit outside the async body. An async function runs
      // synchronously until its first await, so a guard that returned from
      // inside would clear syncInFlight before the assignment below set it --
      // leaving a resolved failure promise cached forever, and every later
      // sync() returning that same stale result.
      if (!isSignedIn()) return Promise.resolve({ ok: false, reason: 'signed-out', stats: empty });
      if (!online)       return Promise.resolve({ ok: false, reason: 'offline',    stats: empty });

      const run = async () => {
        const started = nowMs();
        const stats = { pulled: 0, pushed: 0, conflicts: 0, ms: 0 };
        emit(EVENTS.SYNC_START, { trigger: o.trigger || 'manual' });
        try {
          for (const t of cfg.tables) stats.pushed += await pushTable(t);
          for (const t of cfg.tables) {
            const rows = await pullTable(t);
            const { applied, skipped } = reconcile(t, rows, o.apply);
            stats.pulled += applied.length;
            stats.conflicts += skipped.length;
          }
          stats.ms = nowMs() - started;
          emit(EVENTS.SYNC_DONE, stats);
          return { ok: true, stats };
        } catch (e) {
          stats.ms = nowMs() - started;
          emit(EVENTS.SYNC_ERROR, { phase: 'sync', error: String(e) });
          return { ok: false, reason: String(e), stats };
        }
      };

      const p = run().finally(() => { if (syncInFlight === p) syncInFlight = null; });
      syncInFlight = p;
      return p;
    }

    /* --------------------------------------------------------- connectivity */
    function setOnline(v, opts) {
      const was = online;
      online = !!v;
      if (was === online) return;
      emit(online ? EVENTS.NET_ONLINE : EVENTS.NET_OFFLINE, {});
      if (online && (!opts || opts.autoSync !== false) && isSignedIn() && outbox.length) {
        sync({ trigger: 'reconnect', apply: (opts || {}).apply });
      }
    }

    function attachBrowserListeners(apply) {
      if (typeof window === 'undefined') return () => {};
      const up = () => setOnline(true, { apply });
      const down = () => setOnline(false);
      window.addEventListener('online', up);
      window.addEventListener('offline', down);
      return () => {
        window.removeEventListener('online', up);
        window.removeEventListener('offline', down);
      };
    }

    function startAutoSync(apply) {
      stopAutoSync();
      if (!cfg.autoSyncMs) return;
      autoTimer = setInterval(() => {
        if (isSignedIn() && online) sync({ trigger: 'interval', apply });
      }, cfg.autoSyncMs);
    }
    function stopAutoSync() {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    }

    /* -------------------------------------------------------- convenience */
    /** Read-only query for the cross-app views. */
    async function selectView(view, query) {
      const res = await authed(`/rest/v1/${view}?${query || 'select=*'}`, { method: 'GET' });
      if (!res.ok) {
        const error = await res.text().catch(() => '');
        emit(EVENTS.SYNC_ERROR, { phase: 'select', table: view, error: { status: res.status, body: error } });
        return { ok: false, error };
      }
      return { ok: true, data: await res.json() };
    }

    /** Claim (or change) the public handle. Keyed by the user id, so it is
     *  naturally one-per-account and an upsert renames rather than duplicates.
     *  Server enforces shape and case-insensitive uniqueness. */
    function claimHandle(handle) {
      const u = getUser();
      if (!u) throw new Error('zero-core: not signed in');
      return upsert('leaderboard_profiles', { id: u.id, handle });
    }

    /** Queue a leaderboard entry. Caller supplies a STABLE id per underlying
     *  session (minted once, persisted locally) so republishing updates the
     *  same row instead of stacking duplicates. */
    function publishEntry(entry) {
      if (!entry || !entry.id) throw new Error('zero-core: entry.id is required');
      return upsert('leaderboard_entries', entry);
    }

    /** Retract an entry: tombstone, so it vanishes for every viewer. */
    const retractEntry = (id) => remove('leaderboard_entries', id);

    const leaderboard = (extra) =>
      selectView('v_leaderboard', 'select=*&' + (extra || 'order=score.desc'));

    const ballisticProfiles = (extra) =>
      selectView('v_ballistic_profiles', 'select=*&' + (extra || 'order=loaded_on.desc'));
    const batchPerformance = (extra) =>
      selectView('v_batch_performance', 'select=*&' + (extra || ''));

    function resetCursors() { cursors = {}; store.set(K.cursors, cursors); }

    return {
      EVENTS, TABLES,
      on, off, emit,
      signUp, signIn, signInWithOtp, signOut, refresh,
      getSession, getUser, isSignedIn,
      upsert, remove, enqueue, pendingCount, pendingFor, rejectedList, clearRejected,
      sync, pullTable, pushTable, reconcile, resetCursors,
      setOnline, attachBrowserListeners, startAutoSync, stopAutoSync,
      selectView, ballisticProfiles, batchPerformance,
      claimHandle, publishEntry, retractEntry, leaderboard,
      uuid,
      get isOnline() { return online; },
      get cursors() { return Object.assign({}, cursors); },
      get outbox() { return outbox.map(e => ({ table: e.table, id: e.row.id, op: e.op })); },
      _config: cfg,
    };
  }

  /* ---------------------------------------------------------------- storage */
  function defaultStorage() {
    let ok = false;
    try {
      localStorage.setItem('zerocore.probe', '1');
      localStorage.removeItem('zerocore.probe');
      ok = true;
    } catch (e) { ok = false; }
    if (ok) {
      return {
        get(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; }
                 catch (e) { return null; } },
        set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; }
                    catch (e) { return false; } },
      };
    }
    const mem = new Map();
    return {
      get: (k) => (mem.has(k) ? JSON.parse(mem.get(k)) : null),
      set: (k, v) => { mem.set(k, JSON.stringify(v)); return true; },
    };
  }

  return { create, EVENTS, TABLES, defaultStorage };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ZeroCore;
