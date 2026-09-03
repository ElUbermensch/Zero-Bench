/* ============================================================================
 * zero-core — shared auth + sync layer for the Zero PWA family
 *
 * One module, embedded byte-identically in every app (Zero, the reloading
 * Bench, anything later). No SDK, no build step, no dependencies: it talks to
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
    SYNC_DEFERRED:       'sync:deferred',       // { table, at, tries, abandoned }
    OUTBOX_CHANGED:      'outbox:changed',      // { pending, rejected }
    OUTBOX_REJECTED:     'outbox:rejected',     // { table, ids, status, error }
    DATA_CHANGED:        'data:changed',        // { table, ids, origin }
    RELAY_STATE:         'relay:state',         // { relay, shots, messages, participants, face }
    RELAY_ENDED:         'relay:ended',         // { relayId }
    RELAY_ERROR:         'relay:error',         // { phase, error }
    /* Whether THIS DEVICE's own writes are reaching the relay -- { ok, phase }.
     * Distinct from RELAY_STATE, which says the relay is answering a poll: a
     * device can be reading the relay perfectly while every shot it writes is
     * refused, and that is exactly the failure that used to be invisible. A
     * successful read is not evidence of a successful write. */
    RELAY_MIRROR:        'relay:mirror',        // { ok, phase, error }
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
    /* Product telemetry. Write-only from a client: the server has an insert
     * policy and no select policy, so a pull would come back empty for
     * everyone except an admin -- and an admin reads the rollup views, not
     * this. It is listed here because push walks cfg.tables and that is the
     * only machinery it needs; no caller ever names it in sync's `tables`. */
    'analytics_event',
  ]);

  /** The one table in TABLES that is telemetry rather than the user's work.
   *  Carved out of the outbox badge and the data:changed fan-out below. */
  const TELEMETRY = 'analytics_event';

  /** Columns the server owns. Sending them is at best ignored and at worst
   *  lets a client clock decide conflict resolution. */
  const SERVER_OWNED = Object.freeze(['updated_at', 'created_at']);

  /* Columns a client must not send, because the server owns them.
   *
   * range_sessions' velocity summary USED to be listed here, on the reasoning
   * that a trigger recomputes it from `shots`. That reasoning only holds for a
   * session that HAS a shot string. Bench records a chronograph readout and no
   * per-shot velocities at all, so stripping its summary left the session with
   * no velocity anywhere -- and muzzle velocity is the first thing Zero reads
   * back out of v_ballistic_profiles.
   *
   * The real rule is narrower than the old one: never send a summary ALONGSIDE
   * a shot string, because then two sources of truth disagree until the trigger
   * settles it. Zero writes the string and no summary; Bench writes the summary
   * and no string. Both are honest, and zero-core's own suite pins that Zero
   * still sends no summary, so this stays true by test rather than by memory. */
  const DERIVED = Object.freeze({});

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
      appId: 'unknown',       // 'zero' or 'bench' — lands in source_app
      tables: TABLES,
      storage: null,          // injectable; defaults to localStorage or memory
      fetch: (globalThis.fetch ? globalThis.fetch.bind(globalThis) : null),
      pageSize: 500,
      refreshSkewMs: 60_000,  // refresh this long before the token actually dies
      autoSyncMs: 0,          // 0 disables the periodic sync
      /* Bounds every request, so a socket that hangs -- a captive portal, LTE
       * that associates but does not route -- cannot pin syncInFlight forever
       * and kill sync for the life of the page. Generous rather than tight: one
       * request is bounded by pageSize, and a slow range connection finishing
       * in 15s should finish, not be cut off. 0 disables it. */
      requestTimeoutMs: 20_000,
      /* A whole-device snapshot is up to eight megabytes and goes up in one
       * request, which on range cellular is legitimately slower than any sync
       * call. Cutting it at 20s would report "backup failed" for an upload
       * that was going to succeed -- and, worse, may already have -- to a user
       * whose reason for tapping the button was to be sure their season was
       * safe. Bounded, because an unbounded one is what wedged sync; just
       * bounded at a length an 8 MB upload can actually finish in. */
      uploadTimeoutMs: 120_000,
    }, options || {});

    if (!cfg.url || !cfg.anonKey) throw new Error('zero-core: url and anonKey are required');
    if (!cfg.fetch) throw new Error('zero-core: no fetch available');

    const store = cfg.storage || defaultStorage();

    /* Storage keys, and which of them the two apps are allowed to share.
     *
     * Zero is served from / and Bench from /bench/ ON THE SAME ORIGIN, so they
     * share one localStorage. Every key here used to be unnamespaced, which
     * meant they shared all of it:
     *
     *  - one OUTBOX, so Zero's sync pushed Bench's queued rows and reported
     *    them as its own;
     *  - one set of CURSORS, so whichever app synced first advanced the cursor
     *    past rows the other had never seen. Harmless while nothing consumed a
     *    pull, and immediately destructive once something did: the firearm you
     *    entered in Zero would be marked as delivered before Bench ever asked.
     *
     * The SESSION stays shared on purpose. It is an identity, not work in
     * progress, and signing in once for both apps is the entire premise of one
     * account across two apps. The queue is per app because the work is.
     *
     * Existing installs are adopted rather than reset: if the namespaced key
     * has nothing and the old shared one does, the old value is taken over.
     * The legacy copy is deliberately NOT deleted -- the other app has not
     * started yet and would find its own queue gone.
     *
     * That last sentence used to be followed by "both apps adopting the same
     * pending rows is safe, because every write is an upsert keyed by an id the
     * client minted", and it is wrong. Idempotence by id is not the same as
     * safety: a queued entry is a whole-row upsert of STALE content with no
     * timestamp guard -- pushTable strips updated_at and the server stamps the
     * write as now -- so replaying it is only a no-op if nothing changed in
     * between. Nothing bounds "in between": queuedAt is written and never read
     * for expiry, so an entry lives until it pushes or dead-letters. Reproduced:
     * Zero pushes the adopted row, the shooter notices the rifle's name is
     * wrong and fixes it, and then Bench -- opened later for an unrelated powder
     * lot -- replays ITS copy of the same weeks-old row and the correction is
     * gone from the server and every device. No conflict is reported, because
     * SYNC_CONFLICT only fires for PULLED rows; a stale push has nothing to
     * compare against. The edit simply un-does itself, and the app the shooter
     * blames is the one they made it in.
     *
     * So the queue is claimed ONCE, by whichever app loads first, with a
     * sentinel in a separate key. The legacy values themselves stay on disk, so
     * "left in place for the other app" is still true -- it is the claim that is
     * exclusive, not the data. Splitting the queue by app is not possible
     * (entries carry a table, not an app) and not necessary: what matters is
     * that a client-minted upsert is pushed once, not by whom.
     *
     * And the CURSOR is not adopted at all. A cursor is a claim that rows were
     * already delivered, and the legacy value cannot say delivered TO WHICH APP
     * -- it is the maximum of what *some* app pulled, which is exactly the
     * corruption namespacing exists to end. Copying it into both namespaces
     * silently exempted every row that existed at upgrade time, on precisely
     * the installs that lived through the bug. Reproduced: Bench's rifle picker
     * comes up empty next to a Zero that shows three rifles, on one account,
     * and re-syncing does nothing -- only the rifles that happen to be re-edited
     * in Zero ever appear, which makes the pattern look arbitrary rather than
     * diagnosable. Dropping the adoption costs one full re-pull per app.
     * Bandwidth, against correctness. */
    const ns = 'zerocore.' + (cfg.appId || 'unknown');
    const K = {
      session: 'zerocore.session',     // shared across both apps, deliberately
      cursors: ns + '.cursors',
      outbox:  ns + '.outbox',
      rejected:ns + '.rejected',
      /* Deliberately absent from LEGACY below: a floor is a statement about
       * rows THIS app could not place, and adopting another app's floors would
       * hold a cursor back for rows this handler has no trouble with. */
      floors:  ns + '.floors',
    };
    const LEGACY = { outbox: 'zerocore.outbox', rejected: 'zerocore.rejected' };
    const CLAIM = 'zerocore.legacy-claimed';
    /* A claim that was made before the sentinel existed still counts.
     *
     * Namespacing shipped four days before this sentinel did, so there are
     * devices where one app adopted the legacy queue under the old code and
     * left no record of it. Checking only the sentinel, the second app opens,
     * finds it absent, and adopts the same stale rows a second time -- the
     * exact double-push this is here to stop. So an outbox already sitting in
     * ANY app's namespace, holding the legacy value, is read as a claim. */
    if (store.get(CLAIM) == null) {
      const legacyOutbox = JSON.stringify(store.get(LEGACY.outbox));
      const alreadyTaken = ['zero', 'bench', cfg.appId || 'unknown']
        .some(app => JSON.stringify(store.get('zerocore.' + app + '.outbox')) === legacyOutbox
                     && legacyOutbox !== 'null' && legacyOutbox !== undefined);
      if (alreadyTaken) {
        store.set(CLAIM, 'pre-sentinel');
      } else {
        let claimed = false;
        for (const k of Object.keys(LEGACY)) {
          if (store.get(K[k]) == null) {
            const old = store.get(LEGACY[k]);
            if (old != null) { store.set(K[k], old); claimed = true; }
          }
        }
        if (claimed) store.set(CLAIM, cfg.appId || 'unknown');
      }
    }

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
    /* Sweep telemetry out of a rejected list written by an older build.
     *
     * deadLetter drops these now, but a device that already collected them is
     * still showing the count and would go on showing it: nothing removes a
     * rejected row except the user pressing dismiss. The first person to run
     * this had 168, every one of them an analytics row refused for an identity
     * mismatch, presented as their own work having failed to sync. */
    {
      const kept = rejected.filter(r => r.table !== TELEMETRY);
      if (kept.length !== rejected.length) { rejected = kept; store.set(K.rejected, rejected); }
    }
    /* { table: { at: iso, tries: n } } -- the oldest row this app's apply
     * handler pulled and could NOT place, and how many syncs in a row it has
     * been stuck there. See commitCursor. */
    let floors  = store.get(K.floors)   || {};
    /* Connectivity.
     *
     * This used to be read from navigator.onLine once, at construction, and
     * nothing ever wrote to it again -- neither app called setOnline or
     * attachBrowserListeners. A phone that opened the app at a range with no
     * signal latched `false` and then refused every sync for the rest of the
     * process's life: drive home, full LTE, tap Sync now, "Sync failed:
     * offline". Killing and relaunching the app was the only cure, and nothing
     * on screen suggested that.
     *
     * `isOnline()` reads the live value each time rather than trusting the
     * latch, because the online/offline events fire on interface changes and
     * not on the interesting cases -- a captive portal, a dead uplink behind a
     * connected wifi. The stored flag remains for tests and for callers that
     * set it explicitly. */
    let online  = (typeof navigator === 'undefined') ? true : navigator.onLine !== false;
    let onlineForced = false;      // setOnline() called explicitly: trust it
    const isOnline = () => {
      if (onlineForced) return online;
      if (typeof navigator === 'undefined' || typeof navigator.onLine !== 'boolean') return online;
      return navigator.onLine;
    };
    let refreshInFlight = null;                    // the single shared refresh
    let syncInFlight = null;
    let autoTimer = null;

    /* `store.set` RETURNS false when it could not write -- defaultStorage says
     * so explicitly, for the quota case -- and every caller discarded it.
     *
     * So a device with a full card queued a write, reported it as pending from
     * memory, and lost it on the next launch. Nothing reached the disk, nothing
     * reached the server, no event fired, and the rejected list both apps DO
     * surface stayed empty. The user saw a clean sync over a write that never
     * existed. The one-byte probe in defaultStorage succeeds on a card that is
     * 99.99% full, so the memory fallback never engaged either.
     *
     * Reported as a SYNC_ERROR with phase 'persist': it is not a rejected row
     * (the server never saw it) and it is not a network failure. Both apps
     * already listen for sync errors. */
    /* Queued rows that are the USER's work, i.e. everything but telemetry.
     * Declared here rather than beside pendingCount because persistOutbox runs
     * during startup, before the later consts exist. */
    const userPending = () =>
      outbox.reduce((n, e) => n + (e.table === TELEMETRY ? 0 : 1), 0);

    const persistOutbox = () => {
      const okOutbox = store.set(K.outbox, outbox) !== false;
      const okRejected = store.set(K.rejected, rejected) !== false;
      if (!okOutbox || !okRejected) {
        emit(EVENTS.SYNC_ERROR, { phase: 'persist', error: {
          message: 'the outbox could not be written to this device — '
                 + 'queued work is in memory only and will not survive a relaunch',
          pending: userPending() } });
      }
      emit(EVENTS.OUTBOX_CHANGED, { pending: userPending(), rejected: rejected.length,
                                    durable: okOutbox && okRejected });
    };

    /* ---------------------------------------------------------- transport */
    /* Every request is bounded. It was not, and one hung socket wedged sync for
     * the life of the page.
     *
     * `sync()` guards with `if (syncInFlight) return syncInFlight` and clears it
     * in `.finally()` -- correct for a promise that settles, and a promise that
     * never settles never reaches `.finally()`. So the first hung fetch pinned
     * `syncInFlight` forever: SYNC_START fired, SYNC_DONE and SYNC_ERROR never
     * did, and every later "Sync now" returned the same pending promise without
     * issuing a request. Not "nothing visible" -- literally nothing.
     *
     * The state that produces it is the ordinary one at a range: a captive
     * portal, or LTE that associates but does not route. `isOnline()` already
     * says in its own comment that it cannot detect that, and navigator.onLine
     * reads true throughout. The header chip goes busy and stays busy, tapping
     * sync does nothing, auto-sync is dead, and the only cure is force-quitting
     * the app -- which a user who just paid for it reads as data loss.
     *
     * A single request is bounded by pageSize, so 20s is generous rather than
     * tight; an aborted push leaves the outbox intact, because pushTable
     * already treats a throw as "not sent". */
    async function raw(path, init) {
      /* A big upload gets a longer leash than a sync call. `init.slow` is set
       * by the backup path, which sends up to eight megabytes in one request. */
      const ms = (init && init.slow) ? cfg.uploadTimeoutMs : cfg.requestTimeoutMs;
      // `slow` is ours, not fetch's. Stripped so it never reaches the network layer.
      const { slow, ...rest } = init || {};
      void slow;
      const AC = typeof AbortController !== 'undefined' ? AbortController : null;
      if (!ms || !AC || rest.signal) return cfg.fetch(cfg.url + path, rest);
      const ac = new AC();
      const t = setTimeout(() => ac.abort(), ms);
      try {
        return await cfg.fetch(cfg.url + path, Object.assign({}, rest, { signal: ac.signal }));
      } finally {
        clearTimeout(t);
      }
    }

    /* An auth call that could not reach the server returns a RESULT, not a
     * rejection.
     *
     * signIn and its siblings read `res.ok` and return `{ ok: false, error }`
     * for a refusal -- but a transport failure never produced a `res` at all,
     * so it threw straight out of the promise. Both apps call these from a
     * click handler and neither wraps them, so no-signal sign-in was an
     * unhandled rejection and a screen that did nothing, rather than "could not
     * reach the server". The timeout above turns a hang into exactly that kind
     * of failure, which makes the distinction matter far more than it did. */
    async function authRaw(phase, path, init) {
      try {
        return { res: await raw(path, init) };
      } catch (e) {
        const timedOut = e && e.name === 'AbortError';
        const error = { message: timedOut
          ? 'the server did not answer in time — check the connection and try again'
          : 'could not reach the server', transport: true, timedOut };
        emit(EVENTS.AUTH_ERROR, { phase, error });
        return { res: null, failure: { ok: false, error } };
      }
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
    /* Telemetry queued by an identity that is no longer signed in can never be
     * delivered, so it is dropped the moment the identity changes.
     *
     * The insert policy is `user_id = auth.uid()`, and the row carries the id
     * it was queued with. signOut() KEEPS the outbox on purpose -- unsent work
     * is the user's and should still go when they sign back in -- but that
     * reasoning does not extend to analytics. Zero also signs in anonymously
     * for pair fire, so a device that joins a relay and then signs into a real
     * account has a queue full of rows stamped with an identity the server
     * will refuse forever. Every one of them 403s on every sync from then on.
     *
     * Re-stamping them with the new user was the other option and is worse: it
     * would file one person's activity under another person's account.
     *
     * Only runs when the new identity is actually known. A token refresh can
     * return a session with no user object, and treating that as "nobody"
     * would throw away a signed-in user's queue on every rotation. */
    function dropOrphanTelemetry(uid) {
      const before = outbox.length;
      outbox = outbox.filter(e => e.table !== TELEMETRY || e.row.user_id === uid);
      if (outbox.length !== before) persistOutbox();
    }

    function setSession(s, reason) {
      const prevUid = session && session.user && session.user.id;
      const nextUid = s && s.user && s.user.id;
      session = s;
      store.set(K.session, s);
      /* On sign-IN, not on sign-out, and the difference is a real one.
       *
       * Signing out does not make a queued row undeliverable: the same user
       * signing back in can still send it, and `sign_out` itself is tracked
       * moments before the session is cleared, so purging here would throw
       * away the event that records the thing happening. It is signing in as
       * SOMEONE ELSE that strands them -- that is the point at which the
       * server will refuse those rows on every sync from then on. */
      if (nextUid && nextUid !== prevUid) dropOrphanTelemetry(nextUid);
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
      const t = await authRaw('signUp', '/auth/v1/signup', {
        method: 'POST',
        headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (t.failure) return t.failure;
      const res = t.res;
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        emit(EVENTS.AUTH_ERROR, { phase: 'signUp', error: json });
        return { ok: false, error: json };
      }
      // With email confirmation on, signup returns a user but no tokens.
      if (json.access_token) setSession(shapeSession(json));
      /* Tracked HERE rather than off AUTH_SIGNED_IN, which fires for a sign-up,
       * a sign-in and a session restored from storage alike -- the call site is
       * the only place that still knows which of the three this was.
       *
       * A signup awaiting email confirmation has no session, so track() drops
       * it and the account is counted when they first sign in instead. */
      trackOpen();
      track('sign_up', {});
      return { ok: true, session, needsConfirmation: !json.access_token, user: json.user };
    }

    async function signIn(email, password) {
      const t = await authRaw('signIn', '/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (t.failure) return t.failure;
      const res = t.res;
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        emit(EVENTS.AUTH_ERROR, { phase: 'signIn', error: json });
        return { ok: false, error: json };
      }
      setSession(shapeSession(json));
      trackOpen();
      track('sign_in', {});
      return { ok: true, session };
    }

    /**
     * Anonymous sign-in: a real auth.users row on the `authenticated` role,
     * carrying an is_anonymous JWT claim, with no email or password. This is
     * what makes "no accounts" true for the user while leaving RLS intact.
     *
     * The wire format is POST /auth/v1/signup with a body containing `data`
     * and no credentials -- taken from @supabase/auth-js, not guessed.
     *
     * Must be enabled in the dashboard (Auth > Providers > Anonymous), and
     * Supabase rate-limits it to 30 per hour per IP by default.
     */
    async function signInAnonymously() {
      const t = await authRaw('signInAnonymously', '/auth/v1/signup', {
        method: 'POST',
        headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: {}, gotrue_meta_security: {} }),
      });
      if (t.failure) return t.failure;
      const res = t.res;
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.access_token) {
        emit(EVENTS.AUTH_ERROR, { phase: 'signInAnonymously', error: json });
        return { ok: false, error: json };
      }
      setSession(shapeSession(json));
      trackOpen();
      track('sign_in_anonymous', {});
      return { ok: true, session };
    }

    /** The access token's payload, or null if it is not a readable JWT.
     *  Only for claims the server does not also put on the user object. */
    function jwtClaims() {
      if (!session || !session.access_token) return null;
      try {
        return JSON.parse(
          atob(session.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      } catch (e) {
        return null;
      }
    }

    /** True when the current session is an anonymous device rather than a
     *  real account. Anonymous users can relay but cannot publish scores. */
    function isAnonymous() {
      if (!session || !session.access_token) return false;
      // GoTrue puts is_anonymous on the user object; prefer it to picking the
      // token apart, which depends on the token staying a readable JWT.
      if (session.user && typeof session.user.is_anonymous === 'boolean') {
        return session.user.is_anonymous;
      }
      const payload = jwtClaims();
      if (payload) {
        return payload.is_anonymous === true;
      }
      {
        // Undecidable. Say "not anonymous": the server enforces this anyway via
        // a restrictive policy, so the worst case is offering a publish button
        // that fails, rather than hiding one that would have worked.
        return false;
      }
    }

    /* ---------------------------------------------------------------- MFA */
    /*
     * TOTP second factor. Used by the owner dashboard and nothing else: the
     * apps are offline-first and used at a range with no signal, where
     * demanding a rotating code to look at your own logbook would be a way of
     * locking people out of their data. The dashboard is a page you open on a
     * desk, and it is the thing worth a second factor.
     *
     * Endpoints are GoTrue's, taken from @supabase/auth-js rather than guessed:
     *   POST   /auth/v1/factors                       enroll
     *   POST   /auth/v1/factors/{id}/challenge        start a verification
     *   POST   /auth/v1/factors/{id}/verify           finish it, new session
     *   DELETE /auth/v1/factors/{id}                  unenroll
     *
     * The enrolment itself happens at aal1, deliberately -- otherwise an admin
     * could never obtain the aal2 the policy wants, having no way to enrol
     * without it. Only READING the analytics needs aal2.
     */
    async function mfaEnroll(friendlyName) {
      const res = await authed('/auth/v1/factors', {
        method: 'POST',
        body: JSON.stringify({
          factor_type: 'totp',
          friendly_name: friendlyName || 'Authenticator',
          issuer: 'Zero Suite',
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        emit(EVENTS.AUTH_ERROR, { phase: 'mfaEnroll', error: json });
        return { ok: false, status: res.status, error: json };
      }
      /* `secret` and `uri` are what a user types in by hand when the QR will
       * not scan, so both travel rather than only the image. */
      return { ok: true, factorId: json.id,
               qr: (json.totp && json.totp.qr_code) || null,
               secret: (json.totp && json.totp.secret) || null,
               uri: (json.totp && json.totp.uri) || null };
    }

    async function mfaChallenge(factorId) {
      const res = await authed(`/auth/v1/factors/${encodeURIComponent(factorId)}/challenge`, {
        method: 'POST', body: JSON.stringify({}),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        emit(EVENTS.AUTH_ERROR, { phase: 'mfaChallenge', error: json });
        return { ok: false, status: res.status, error: json };
      }
      return { ok: true, challengeId: json.id, expiresAt: json.expires_at };
    }

    /**
     * Verify a code against a challenge. On success GoTrue issues a NEW
     * session whose token carries `aal: 'aal2'` -- which is the entire point,
     * because the policy reads that claim and not anything this client says.
     * Adopting it is therefore not bookkeeping; it is the step that grants the
     * access.
     */
    async function mfaVerify(factorId, challengeId, code) {
      const res = await authed(`/auth/v1/factors/${encodeURIComponent(factorId)}/verify`, {
        method: 'POST',
        body: JSON.stringify({ challenge_id: challengeId, code: String(code || '').trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.access_token) {
        emit(EVENTS.AUTH_ERROR, { phase: 'mfaVerify', error: json });
        return { ok: false, status: res.status, error: json };
      }
      setSession(shapeSession(json));
      return { ok: true, session, aal: aal() };
    }

    async function mfaUnenroll(factorId) {
      const res = await authed(`/auth/v1/factors/${encodeURIComponent(factorId)}`,
                               { method: 'DELETE' });
      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        emit(EVENTS.AUTH_ERROR, { phase: 'mfaUnenroll', error });
        return { ok: false, status: res.status, error };
      }
      return { ok: true };
    }

    /** The factors on the account, refreshed from the server rather than from
     *  the cached user -- an enrolment made on another device is exactly the
     *  case this has to see. */
    async function mfaFactors() {
      const res = await authed('/auth/v1/user', { method: 'GET' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, status: res.status, error: json };
      const factors = (json.factors || []).filter(f => f.factor_type === 'totp');
      if (session && json && json.id) { session.user = json; store.set(K.session, session); }
      return { ok: true, factors,
               verified: factors.filter(f => f.status === 'verified') };
    }

    /**
     * 'aal1' after a password sign-in, 'aal2' once a second factor has been
     * verified in THIS session. Read off the token, because that is the same
     * claim the server's policies read -- anything else would be this client's
     * opinion of its own privileges.
     */
    function aal() {
      const c = jwtClaims();
      return (c && c.aal) || 'aal1';
    }

    /**
     * Send queued telemetry and nothing else.
     *
     * sync() pushes every table in declared order, and Zero only calls it when
     * the user taps sync or publishes a score -- so Zero's analytics sat in the
     * outbox indefinitely while Bench's went up after every edit, and the owner
     * dashboard showed one app's traffic and called it the product's. Raising
     * Zero to a full auto-sync would have fixed the symptom by changing what
     * the app does with the USER's data on a phone at a range, which is not a
     * decision telemetry gets to make.
     *
     * Failures are swallowed on purpose. This is a background errand: it must
     * not raise, must not emit a sync error, and must not be distinguishable
     * from nothing having happened.
     */
    async function flushTelemetry() {
      if (cfg.telemetry === false) return 0;
      if (!isSignedIn() || !isOnline()) return 0;
      if (!pendingFor(TELEMETRY)) return 0;
      try { return await pushTable(TELEMETRY); } catch (e) { return 0; }
    }

    /** Ensure SOME identity exists, without asking the user for anything.
     *  Relay entry points call this. */
    async function ensureIdentity() {
      if (isSignedIn()) return { ok: true, session };
      return signInAnonymously();
    }

    /** Magic link / OTP. No password to lose, but needs mail delivery working. */
    async function signInWithOtp(email) {
      const t = await authRaw('signInWithOtp', '/auth/v1/otp', {
        method: 'POST',
        headers: { apikey: cfg.anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, create_user: true }),
      });
      if (t.failure) return t.failure;
      const res = t.res;
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
            /* Only a REFUSAL kills the session. GoTrue answers 429 when it is
             * rate limiting and 5xx while it is being deployed, and treating
             * either as "your token is dead" signs every user out at once over
             * a transient server hiccup -- with their unsent work still in the
             * outbox and no idea why they are looking at a sign-in form. A
             * network exception is already handled that way below; an HTTP
             * error deserves the same reading. */
            const refused = res.status === 400 || res.status === 401 || res.status === 403;
            if (refused) setSession(null, 'refresh-failed');
            emit(EVENTS.AUTH_ERROR, { phase: 'refresh', error: { status: res.status },
                                      fatal: refused });
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
      /* Local first, network second.
       *
       * This used to await the logout POST before clearing anything, which
       * made "am I signed out" a question the server got to answer. Offline it
       * meant a full fetch timeout of the UI still showing the old email; a
       * caller that did not await -- which is every caller, because sign-out
       * is a fire-and-forget in both apps -- re-rendered against a session
       * that was still there and showed the user signed in after they had
       * pressed sign out.
       *
       * Revoking the refresh token remains worth doing, so it still happens;
       * it just cannot hold up the local state change. The token is captured
       * before the clear, since the request needs it. */
      const headers = (session && session.access_token) ? authHeaders() : null;
      /* Before the clear, not after: track() attributes to the CURRENT user and
       * there is about to not be one. The row then waits in the outbox until
       * somebody signs in again -- which is also why it carries occurred_at. */
      track('sign_out', {});
      setSession(null, 'user');
      cursors = {};
      store.set(K.cursors, cursors);
      floors = {};
      store.set(K.floors, floors);
      if (headers) {
        try { await raw('/auth/v1/logout', { method: 'POST', headers }); }
        catch (e) { /* best effort: the local session is already gone */ }
      }
      // The outbox is deliberately NOT cleared: unsent work belongs to the user,
      // not the session, and signing back in should still deliver it.
    }

    /** Take a session out of the URL fragment, if one is there. Returns true
     *  when it adopted one, so a caller can react (and a test can assert). */
    function adoptSessionFromUrl() {
      if (typeof location === 'undefined' || !location.hash) return false;
      const hash = location.hash.replace(/^#/, '');
      // Bench deep links live in this fragment too (#/s/SERIAL). Only touch it
      // when it is unmistakably an auth callback.
      if (!/(^|&)access_token=/.test(hash)) return false;
      const q = new URLSearchParams(hash);
      const access = q.get('access_token'), refresh = q.get('refresh_token');
      if (!access || !refresh) return false;
      const ttl = Number(q.get('expires_in') || 3600) * 1000;
      setSession({ access_token: access, refresh_token: refresh,
                   expires_at: nowMs() + ttl, user: null });
      /* Strip it before anything else can read it. replaceState rather than
       * assigning location.hash, which would leave an entry in history. */
      try {
        if (history.replaceState) history.replaceState(null, '', location.pathname + location.search);
      } catch (e) {}
      /* The token carries the user id in its payload but not the email, and
       * the UI shows an email. Fetching it is one request and only happens on
       * this path. */
      raw('/auth/v1/user', { method: 'GET', headers: authHeaders() })
        .then(r => (r.ok ? r.json() : null))
        .then(u => { if (u && u.id && session) { session.user = u; store.set(K.session, session);
                                                 emit(EVENTS.AUTH_SIGNED_IN, { user: u }); } })
        .catch(() => {});
      return true;
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
      /* Telemetry is not the user's data and must not look like it. Zero
       * re-renders on data:changed, so announcing an analytics row would
       * repaint the screen every time the app measured itself -- and a render
       * that tracks anything would then feed itself. */
      if (table !== TELEMETRY) {
        emit(EVENTS.DATA_CHANGED, { table, ids: [row.id], origin: 'local' });
      }
      return row.id;
    }

    const upsert = (table, row) => enqueue(table, row, 'upsert');

    /**
     * Soft delete: a tombstone, so a device that was offline learns about it.
     *
     * Queued as op 'delete', which is pushed as a PATCH rather than an upsert.
     * It used to be an upsert of {id, deleted_at}, and that CANNOT work: an
     * upsert is INSERT ... ON CONFLICT, Postgres forms the insert tuple before
     * it detects the conflict, and every one of these tables has NOT NULL
     * columns the tombstone does not carry. The write failed with 23502, got
     * dead-lettered as permanently refused, and the delete never left the
     * device -- while the queue drained and the UI said everything was sent.
     * The SQL suite is what found it; the mock had no NOT NULL to violate.
     */
    const remove = (table, id) =>
      enqueue(table, { id, deleted_at: new Date().toISOString() }, 'delete');

    /* The badge counts the user's unsent WORK. Telemetry rides the same queue
     * for the retry and chunking machinery, but a shooter looking at "3 items
     * not yet synced" means three of their records, and a number that never
     * reaches zero because the app keeps measuring itself is a number they
     * stop believing. */
    const pendingCount = () => userPending();
    /* How many refusals are kept. This is a retry queue now as well as a
     * diagnostic, so the cap is what a user can still get back. */
    const REJECTED_MAX = 500;
    const rejectedList = () => rejected.map(r => ({ table: r.table, id: r.row.id,
      status: r.status, error: r.error, rejectedAt: r.rejectedAt }));
    const clearRejected = () => { rejected = []; persistOutbox(); };

    /* Put refused rows back in the queue.
     *
     * A dead letter was a one-way door: deadLetter() takes the entry out of the
     * outbox and into a diagnostic list, and the only thing that could be done
     * with that list was clear it -- which discards the row for good. So a
     * record refused for a reason that has since been FIXED (a batch whose
     * recipe had not synced yet, a row refused while a migration was
     * mid-deploy, anything answered 4xx by a server that has since been
     * corrected) could never be sent, and the user's only evidence it had
     * existed was a count they were invited to dismiss.
     *
     * Retrying is safe by construction: every queued write is an upsert keyed
     * by an id the client minted, so a row that turns out to have landed after
     * all is re-applied rather than duplicated. A row that is still wrong is
     * refused again and dead-letters again, which is the same place it started
     * -- a retry cannot make things worse than not retrying.
     *
     * Returns how many went back, so a caller can say so. */
    const retryRejected = (ids) => {
      const want = Array.isArray(ids) && ids.length ? new Set(ids) : null;
      const back = rejected.filter(r => !want || want.has(r.row && r.row.id));
      if (!back.length) return 0;
      rejected = rejected.filter(r => back.indexOf(r) === -1);
      let n = 0;
      for (const r of back) {
        /* One entry per row, exactly as `enqueue` guarantees -- and a QUEUED
         * entry always wins over a retried one.
         *
         * A bare push broke both halves. The refused entry is a SNAPSHOT of the
         * row as it was when it was refused, and the user has been using the
         * app since: a batch refused at 50 rounds remaining, shot down to 12,
         * then retried, put both in the queue. PostgREST refuses a bulk upsert
         * carrying one id twice ("ON CONFLICT DO UPDATE command cannot affect
         * row a second time"), so pushChunk bisects them into separate
         * requests -- and whichever lands last wins. Measured: the server ended
         * up holding 50 after the user had shot it down to 12.
         *
         * "A retry cannot leave things worse than not retrying" is true about
         * duplication and was false about staleness. Skipping a row that
         * already has a queued entry makes it true about both: the newer state
         * is going up anyway, and it is the one the user can see. */
        const queued = outbox.findIndex(e => e.table === r.table
                                             && e.row && r.row && e.row.id === r.row.id);
        if (queued >= 0) continue;
        outbox.push({ table: r.table, row: r.row, op: r.op || 'upsert', queuedAt: nowMs() });
        n++;
      }
      persistOutbox();
      return n;
    };
    const pendingFor = (table) => outbox.filter(e => e.table === table).length;

    /* ----------------------------------------------------------- telemetry */
    /* One id per app load. Groups the events of a single visit without
     * borrowing the word "session", which both apps have already spent: Zero on
     * range_sessions and Bench on loading sessions. */
    const usageSessionId = uuid();
    const usageStartedMs = nowMs();
    let openTracked = false;

    /**
     * Record a product-usage event. Fire-and-forget: it queues like any other
     * write and leaves on the next sync, so it works at the range with no
     * signal.
     *
     * Every row carries the SAME keys, deliberately. pushTable groups the
     * outbox by key signature because PostgREST builds one column list for a
     * bulk insert, so an event that omitted `metadata` would be sent as its own
     * separate request rather than riding along with the others.
     *
     * Returns null when there is nobody to attribute the event to. The insert
     * policy is `user_id = auth.uid()`, so a signed-out event would queue,
     * fail, and land in the rejected list that BOTH apps show the user --
     * telemetry must never produce a scary number on someone's sync screen.
     * The cost is that a visit which never signs in is not counted.
     */
    function track(eventName, metadata) {
      if (cfg.telemetry === false || !eventName) return null;
      const u = getUser();
      if (!u || !u.id) return null;
      return enqueue(TELEMETRY, {
        id: uuid(),
        user_id: u.id,
        source_app: cfg.appId,
        event_name: String(eventName),
        usage_session_id: usageSessionId,
        metadata: (metadata && typeof metadata === 'object') ? metadata : {},
        // The client's clock, kept for events that queue offline for days. The
        // server stamps created_at and the rollups group on that.
        occurred_at: new Date().toISOString(),
      }, 'upsert');
    }

    /* Exactly one app_open per visit, and only once there is a user to hang it
     * on. A visit that starts signed out and then signs in still counts, which
     * is why the auth paths call this and not just create(). */
    function trackOpen() {
      if (openTracked) return;
      // Only a row that actually queued counts. A signed-out create() returns
      // null here, and the next sign-in is what finally opens the visit.
      if (track('app_open', {}) !== null) openTracked = true;
    }

    /**
     * Best-effort visit duration.
     *
     * visibilitychange and pagehide are the only signals a browser offers here
     * and neither is promised: a mobile browser reclaiming a backgrounded tab
     * is free to run nothing at all. So the duration this emits covers the
     * visits that got to report, not all of them -- v_analytics_visits says the
     * same thing in SQL. Visit COUNT comes from app_open and is reliable;
     * duration is an estimate over a self-selected sample.
     *
     * The write is a synchronous localStorage queue, not a request, which is
     * what makes it survivable in a pagehide handler at all.
     */
    function attachSessionListeners() {
      if (typeof document === 'undefined' || typeof window === 'undefined') return () => {};
      let reported = 0;
      const report = (force) => {
        if (!force && document.visibilityState !== 'hidden') return;
        const now = nowMs();
        // visibilitychange and pagehide both fire on the same departure. One
        // visit, one row.
        if (now - reported < 2000) return;
        reported = now;
        track('app_background', { duration_ms: now - usageStartedMs });
      };
      const onVisibility = () => report(false);
      const onPageHide = () => report(true);
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pagehide', onPageHide);

      /* Two chances to actually send what was measured.
       *
       * On the way out, because a visit that is never coming back is the one
       * whose events would otherwise wait for a sync that may be days away --
       * and the app_background row reporting the visit's length is written
       * moments earlier by report() above. It is a best-effort send from a
       * handler the browser may kill mid-flight, which is exactly what the
       * queue is for: anything that does not make it stays queued.
       *
       * And on an interval, for the long session that never backgrounds: a
       * phone propped on a bench for an afternoon is the normal case here.
       * Five minutes is chosen against the fact that this is a background
       * errand on a device that may be on cellular at a range -- often enough
       * that a dashboard is current, rare enough to be invisible. */
      const onIdleFlush = () => { flushTelemetry(); };
      document.addEventListener('visibilitychange', onIdleFlush);
      window.addEventListener('pagehide', onIdleFlush);
      const timer = setInterval(onIdleFlush, 300_000);

      return () => {
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener('pagehide', onPageHide);
        document.removeEventListener('visibilitychange', onIdleFlush);
        window.removeEventListener('pagehide', onIdleFlush);
        clearInterval(timer);
      };
    }

    /* ---------------------------------------------------------------- pull */
    /* `commit` is false when nobody is going to do anything with the rows.
     *
     * The cursor used to advance on every pull, whether or not the rows were
     * consumed -- and neither app passed an `apply` handler, so every sync
     * downloaded all seventeen tables, threw them away, and moved the cursor
     * past them. Sync was one-way in practice: a reinstall or a second device
     * recovered nothing, and the moment an apply handler was finally wired up
     * it would start from the cursor and never see anything written before
     * that day. Advancing a cursor over data nobody read is how a sync engine
     * quietly loses history. */
    /* Move one table's cursor to the newest row the server returned. Split out
     * of pullTable because the decision to commit cannot be made until the
     * apply handler has said whether it understood the table -- and that
     * happens after the rows are in hand. */
    /* `deferred` is the list of updated_at values for rows the handler pulled
     * and could NOT place -- a session whose batch this device has never had,
     * a shot whose session was therefore never stored. Returning a stat object
     * says "I understood this table"; it does not say "I kept every row in it",
     * and the two were conflated. Bench's readers skip rows they cannot place
     * (`if (!batch) continue`), reported {added:0,updated:0,removed:0} anyway,
     * and the cursor stepped over them PERMANENTLY: the batch arrives from the
     * other device tomorrow and the sessions that belong to it are already on
     * the wrong side of the cursor, so they are never offered again.
     *
     * So the cursor stops SHORT of the oldest row that could not be placed --
     * "commit up to the first row I could not consume" -- and everything from
     * there on is offered again next sync, by which time the batch may exist.
     *
     * The escape hatch matters as much as the rule. Some rows are not late,
     * they are never coming: a session for a batch that lives only on a device
     * the user has since wiped. Held strictly, one such row pins the cursor at
     * 1970 and every sync re-downloads the entire table forever -- on cellular,
     * at a range. So a floor that has not moved for DEFER_MAX_TRIES consecutive
     * syncs is abandoned and the cursor advances past it, with an event so the
     * skip is observable rather than silent. Three tries is a compromise, not a
     * derivation: long enough that a batch arriving on the next sync is caught,
     * short enough that the re-download is bounded. */
    const DEFER_MAX_TRIES = 3;
    const persistFloors = () => store.set(K.floors, floors);

    /* ------------------------------------------------- where a pull is up to
     *
     * A position, not a timestamp. `updated_at` is not unique and cannot be
     * made unique: `now()` is the TRANSACTION timestamp, so every row of one
     * bulk push carries the identical stamp -- seven firearms in one POST come
     * back with one distinct value between them. Ordering by it alone is a
     * partial order, and paging through a partial order is where rows go
     * missing.
     *
     * `(updated_at, id)` is total, because `id` is the primary key on every
     * synced table. Stored cursors from before this change are bare strings;
     * they read as `(that timestamp, '')`, which re-offers the rows sharing
     * that stamp exactly once and then behaves. */
    const EPOCH = { at: '1970-01-01T00:00:00Z', id: '' };
    const posOf = (v) => (v && typeof v === 'object')
      ? { at: v.at || EPOCH.at, id: v.id || '' }
      : (typeof v === 'string' && v ? { at: v, id: '' } : EPOCH);
    const posCmp = (a, b) =>
      a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    const posOfRow = (r) => ({ at: r.updated_at, id: String(r.id == null ? '' : r.id) });

    function commitCursor(table, rows, since, deferred) {
      if (!rows || !rows.length) return;
      const from = posOf(since || cursors[table]);
      const newest = rows.reduce(
        (m, r) => (posCmp(posOfRow(r), m) > 0 ? posOfRow(r) : m), from);
      const advance = (to) => { cursors[table] = to; store.set(K.cursors, cursors); };

      const oldest = (deferred || []).reduce(
        (m, t) => (t && (m === null || t < m) ? t : m), null);

      if (oldest === null) {                     // everything placed: full speed
        if (floors[table]) { delete floors[table]; persistFloors(); }
        return advance(newest);
      }

      const prev = floors[table];
      const tries = (prev && prev.at === oldest) ? prev.tries + 1 : 1;
      const abandoned = tries > DEFER_MAX_TRIES;
      emit(EVENTS.SYNC_DEFERRED, { table, at: oldest, tries, abandoned });

      if (abandoned) {
        delete floors[table]; persistFloors();
        return advance(newest);
      }
      floors[table] = { at: oldest, tries };
      persistFloors();

      /* Strictly BELOW the deferred row -- and below every row that shares its
       * stamp, since a handler reports the timestamp it could not place and
       * not which of the rows at that timestamp it was. Re-offering the whole
       * tie group is the safe direction: every apply handler merges by remote
       * id and is idempotent, so a row delivered twice costs nothing and a row
       * skipped once is gone for good.
       *
       * Floored at the cursor we came in with, so this can only ever stall --
       * never rewind. */
      const bar = { at: oldest, id: '' };
      advance(rows.reduce((m, r) => {
        const p = posOfRow(r);
        return (posCmp(p, bar) < 0 && posCmp(p, m) > 0) ? p : m;
      }, from));
    }

    async function pullTable(table, commit) {
      const since = posOf(cursors[table]);
      /* A KEYSET walk, not limit/offset.
       *
       * OFFSET is only sound over a result set whose ordering holds still for
       * the whole walk, and this one does not: `set_updated_at` re-stamps an
       * edited row, which moves it to the END of the ascending order, and
       * everything after it shifts down one slot -- so the row sitting on the
       * next offset boundary is stepped over. The cursor then advances to the
       * newest row the pull DID return, and `gt.` excludes the skipped one
       * forever. Reproduced with six rows and one concurrent edit: page 1 got
       * s1,s2, the edit moved s2, page 2 started at s4, and s3 was never seen
       * again by that device.
       *
       * It is not an everyday-sync bug -- the second page is only reached when
       * a table has more than a page of rows newer than the cursor, so: a first
       * sync on a new phone, a restore, a reset, or a table held behind a
       * deferred floor. Which is to say, exactly the moments a shooter is
       * watching a year of data come down and counting on all of it.
       *
       * The deferred floor does NOT cover this. A floor can only hold back a
       * row the handler saw and refused; a row lost to the offset window never
       * reaches the handler at all.
       *
       * PostgREST has no row-value comparison, so `(updated_at, id) > (T, ID)`
       * is spelled as the equivalent disjunction. */
      let walk = since, all = [];
      for (;;) {
        const at = encodeURIComponent(walk.at);
        /* An EMPTY id half means "the start of this timestamp", not "after some
         * row". It has to be spelled differently, and getting that wrong took
         * every pull down against a real server while every test passed.
         *
         * `id` is a uuid column on every synced table. `id.gt.` with nothing
         * after it makes Postgres try to cast '' to uuid, which it refuses at
         * PARSE time -- so the unreachable branch of the OR does not save it
         * and the whole request is a 400:
         *
         *   invalid input syntax for type uuid: ""
         *
         * That is the first sync on a new phone, every already-installed device
         * whose cursor is still a bare timestamp, and every device after a
         * reset, a sign-out, or Bench's "erase all data". pullTable throws,
         * which aborts the table loop, and the cursor can only become a
         * position via a pull that succeeds -- so pull was dead permanently
         * while push kept working. Data goes up, nothing comes down, silently.
         *
         * The mock matched the empty id with `[^)]*` and answered 200, so the
         * suite could not see it. It rejects the empty cast now, like Postgres.
         *
         * `gte.` on the timestamp is exactly right for a start-of-stamp
         * position: at the epoch it means everything, and at a deferred floor
         * it re-offers the whole tie group, which is what the floor is for. The
         * walk moves to a real (stamp, id) after the first page, so the
         * compound form takes over and there is no risk of re-serving a page. */
        const q = `/rest/v1/${table}` + (walk.id
          ? `?select=*&or=(updated_at.gt.${at},and(updated_at.eq.${at},id.gt.${encodeURIComponent(walk.id)}))`
          : `?select=*&updated_at=gte.${at}`) +
          `&order=updated_at.asc,id.asc&limit=${cfg.pageSize}`;
        const res = await authed(q, { method: 'GET' });
        if (!res.ok) {
          const error = await res.text().catch(() => '');
          emit(EVENTS.SYNC_ERROR, { phase: 'pull', table, error: { status: res.status, body: error } });
          throw new Error(`pull ${table}: ${res.status}`);
        }
        const page = await res.json();
        all = all.concat(page);
        if (page.length < cfg.pageSize) break;
        const last = page[page.length - 1];
        const next = posOfRow(last);
        /* A server that ignores the keyset would hand back the same page
         * forever. Bail rather than spin: the rows already in hand are still
         * applied, and the cursor simply does not advance past them. */
        if (posCmp(next, walk) <= 0) break;
        walk = next;
      }

      // Advance the cursor to the newest row the SERVER actually returned.
      // Using a local timestamp here loses every row written mid-sync.
      if (all.length && commit !== false) commitCursor(table, all, since);
      emit(EVENTS.SYNC_PULLED, { table, rows: all, cursor: posOf(cursors[table] || since).at });
      return all;
    }

    /**
     * Apply pulled rows to local state. A row with an unsent local edit is left
     * alone -- the pending write is newer by definition and would be lost.
     */
    function reconcile(table, rows, apply) {
      const pending = new Set(outbox.filter(e => e.table === table).map(e => e.row.id));
      const applied = [], skipped = [], deferred = [];
      for (const r of rows) {
        if (pending.has(r.id)) {
          skipped.push(r.id);
          /* Held rather than dropped. The local write wins for now and will be
           * pushed, but if it dead-letters, the server's version is the only
           * copy left -- and a cursor that stepped past it means this device
           * never sees it again. The pending set empties on push (success or
           * dead-letter alike), so this defers by at most a sync or two. */
          if (r.updated_at) deferred.push(r.updated_at);
          emit(EVENTS.SYNC_CONFLICT, { table, id: r.id, resolution: 'kept-local-pending' });
          continue;
        }
        applied.push(r);
      }
      /* What the handler RETURNS decides whether the cursor may move. A
       * handler that does not know this table returns nothing, and rows it
       * threw away must stay on the wrong side of the cursor.
       *
       * A handler that DOES know the table may still be unable to place some
       * of its rows; it says so with a `deferred` array of their updated_at
       * values. Omitting it keeps the old meaning -- "I took all of them" --
       * so a handler that never defers needs no changes. */
      const res = apply ? apply(table, applied) : undefined;
      const consumed = res !== undefined && res !== null;
      if (consumed && Array.isArray(res.deferred)) {
        for (const t of res.deferred) if (t) deferred.push(t);
      }
      if (applied.length) {
        emit(EVENTS.DATA_CHANGED, { table, ids: applied.map(r => r.id), origin: 'remote' });
      }
      return { applied, skipped, deferred, consumed };
    }

    /* ---------------------------------------------------------------- push */
    /* Drop a set of entries out of the outbox and into the diagnostic list.
     * Only ever called for rows the server has individually refused. */
    function deadLetter(table, entries, status, error) {
      const ids = new Set(entries.map(e => e.row.id));
      outbox = outbox.filter(e => !(e.table === table && ids.has(e.row.id) &&
                                    entries.indexOf(e) !== -1));
      /* A refused telemetry row is dropped, not kept.
       *
       * The rejected list is a thing BOTH apps put in front of the user, with
       * a count and a retry button, and it is meant to say "some of your work
       * did not reach the server". An analytics row is not their work. One
       * that cannot be delivered is worth exactly nothing, and showing it
       * turns a measurement the user never asked for into a fault they are
       * asked to care about.
       *
       * This is not hypothetical: 168 of them piled up in one account, which
       * is how the bug this guards against was found. */
      if (table === TELEMETRY) { persistOutbox(); return; }
      /* `op` is kept, and it matters more than it looks. A tombstone travels as
       * a PATCH; putting one back as an upsert of {id, deleted_at} is refused
       * outright, because Postgres builds the insert tuple before it detects
       * the conflict and a partial row fails the table's NOT NULL columns.
       * Without this a retried delete would fail for a completely different
       * reason than the one it was refused for. */
      rejected = rejected.concat(entries.map(e => ({
        table, row: e.row, op: e.op || 'upsert', status,
        error: String(error).slice(0, 400), rejectedAt: nowMs(),
      })));
      /* Bounded, but the bound is no longer free.
       *
       * "A diagnostic, not a queue" was true when the only thing that could be
       * done with this list was read it and clear it. Now it is the ONLY route
       * back for a refused row, so anything trimmed off the front is destroyed
       * with no record it existed -- and 150 refusals from one bad reference is
       * ordinary, because a batch whose recipe has not synced blocks every
       * session on it. Raised, and the overflow is reported rather than silent:
       * a count the user is invited to dismiss must not be quietly short. */
      if (rejected.length > REJECTED_MAX) {
        const lost = rejected.length - REJECTED_MAX;
        rejected = rejected.slice(-REJECTED_MAX);
        emit(EVENTS.SYNC_ERROR, { phase: 'dead-letter-overflow', table, error: {
          message: `${lost} refused row${lost === 1 ? '' : 's'} dropped from the retry list `
                 + `(it holds the most recent ${REJECTED_MAX})`, lost } });
      }
      persistOutbox();
      emit(EVENTS.OUTBOX_REJECTED, { table, ids: [...ids], status, error });
      emit(EVENTS.SYNC_ERROR, { phase: 'push', table, error: { status, body: error } });
    }

    /* Push one chunk of a table's queue, isolating a refusal down to the rows
     * that actually caused it.
     *
     * PostgREST takes the whole array as one statement, so a single row the
     * server will not accept fails the request for every row sent with it. The
     * first version of this dead-lettered the entire chunk on a 4xx, which
     * meant one malformed record -- say a session referencing a firearm that
     * never made it up -- silently discarded every other unsent record in that
     * table. The user's evidence for this was a queue that emptied and data
     * that never appeared.
     *
     * So a 4xx on a chunk of more than one row is not a verdict on those rows.
     * It is a signal to split the chunk and ask again. Bisecting costs about
     * 2·log2(n) extra requests to isolate a single offender rather than the n
     * a one-at-a-time retry would take, and it only happens on the failure
     * path. A row is dead-lettered only when it has been refused ALONE.
     *
     * 5xx, 401 and 429 are never dead-lettered at any size: those are
     * transient or an auth problem, and the row deserves another attempt. They
     * throw, which aborts the sync and leaves the queue intact. */
    /* A tombstone is an UPDATE, not an upsert. One request per row, which is
     * right for something as rare as a delete and avoids inventing a filter
     * that means "these ids, each with its own timestamp".
     *
     * A 404-shaped result -- PATCH matching no row -- is not an error here.
     * The row may have been deleted on another device already, and RLS makes a
     * row belonging to someone else simply invisible rather than forbidden.
     * Either way the local intent is satisfied. */
    async function pushTombstones(table, entries) {
      let n = 0;
      for (const e of entries) {
        const res = await authed(
          `/rest/v1/${table}?id=eq.${encodeURIComponent(e.row.id)}`,
          { method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ deleted_at: e.row.deleted_at }) });

        if (!res.ok) {
          const error = await res.text().catch(() => '');
          const permanent = res.status >= 400 && res.status < 500 &&
                            res.status !== 401 && res.status !== 429;
          if (!permanent) {
            emit(EVENTS.SYNC_ERROR, { phase: 'push', table, error: { status: res.status, body: error } });
            throw new Error(`push ${table}: ${res.status}`);
          }
          deadLetter(table, [e], res.status, error);
          continue;
        }
        outbox = outbox.filter(x => x !== e);
        persistOutbox();
        emit(EVENTS.SYNC_PUSHED, { table, rows: [e.row] });
        n++;
      }
      return n;
    }

    async function pushChunk(table, entries) {
      if (!entries.length) return 0;
      if (entries[0].op === 'delete') return pushTombstones(table, entries);
      const body = entries.map(e => e.row);

      const res = await authed(`/rest/v1/${table}?on_conflict=id`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const error = await res.text().catch(() => '');
        const permanent = res.status >= 400 && res.status < 500 &&
                          res.status !== 401 && res.status !== 429;
        if (!permanent) {
          emit(EVENTS.SYNC_ERROR, { phase: 'push', table, error: { status: res.status, body: error } });
          throw new Error(`push ${table}: ${res.status}`);
        }
        if (entries.length > 1) {
          const mid = Math.ceil(entries.length / 2);
          emit(EVENTS.SYNC_ERROR, { phase: 'push-split', table,
            error: { status: res.status, body: error, splitting: entries.length } });
          const a = await pushChunk(table, entries.slice(0, mid));
          const b = await pushChunk(table, entries.slice(mid));
          return a + b;
        }
        deadLetter(table, entries, res.status, error);
        return 0;                              // sync continues; the rest still flushes
      }

      const saved = await res.json().catch(() => body);
      // Only drop the entries we actually sent. Anything queued while the
      // request was in flight stays, or that edit is silently lost.
      outbox = outbox.filter(e => entries.indexOf(e) === -1);
      persistOutbox();
      emit(EVENTS.SYNC_PUSHED, { table, rows: saved });
      return entries.length;
    }

    async function pushTable(table) {
      const mine = outbox.filter(e => e.table === table);
      if (!mine.length) return 0;

      /* PostgREST requires every object in a bulk insert to carry the SAME
       * keys -- it builds one column list for the whole array -- and answers a
       * mixed array with 400 PGRST102. That is easy to hit the moment an app
       * both edits and deletes rows in the same table between syncs, because a
       * tombstone is {id, deleted_at} and an edit is the whole row.
       *
       * Grouping by key signature is also what makes "each app writes only its
       * own columns" work at all: Zero's firearm payload and Bench's carry
       * different columns on purpose, and a device that has both queued must
       * not have them merged into one malformed request.
       *
       * Relative order within a table is not preserved across groups. Nothing
       * in this schema has a self-reference, so the only ordering that matters
       * is between tables, which cfg.tables still fixes. */
      const groups = new Map();
      for (const e of mine) {
        /* Keyed by op as well as shape: a tombstone travels as a PATCH and an
         * edit as an upsert, and they must never share a request even when
         * their column lists happen to look alike. */
        const sig = (e.op || 'upsert') + '|' + Object.keys(e.row).sort().join(',');
        if (!groups.has(sig)) groups.set(sig, []);
        groups.get(sig).push(e);
      }
      let n = 0;
      for (const g of groups.values()) n += await pushChunk(table, g);
      return n;
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
      if (!isOnline())   return Promise.resolve({ ok: false, reason: 'offline',    stats: empty });

      const run = async () => {
        const started = nowMs();
        const stats = { pulled: 0, pushed: 0, conflicts: 0, ms: 0 };
        emit(EVENTS.SYNC_START, { trigger: o.trigger || 'manual' });
        try {
          for (const t of cfg.tables) stats.pushed += await pushTable(t);
          /* Only commit the cursor for tables somebody is actually consuming,
           * and that is decided PER TABLE rather than once for the whole sync.
           *
           * It used to be `const consuming = !!o.apply` -- a single boolean.
           * Both apps pass a handler, but each handler understands only a few
           * tables: Zero's takes firearms and returns early for everything
           * else, Bench's takes four and returns null for the rest. So every
           * sync pulled the other fifteen tables, threw them away, and moved
           * the cursor past them. The rows stay on the server, but this device
           * will never be offered them again -- so the day one of those tables
           * grows an inverse, it starts from the cursor and never sees
           * anything written before today. Advancing a cursor over data
           * nobody read is how a sync engine quietly loses history. */
          /* WHAT TO PULL is the caller's to declare. Left to itself this walked
           * every table in the schema on every sync, including the public
           * leaderboard -- world-readable by design, so "everything every
           * customer has ever posted", downloaded to a phone and discarded. A
           * table with no inverse should not be fetched at all, rather than
           * fetched and thrown away. */
          /* An EMPTY array means pull nothing. It used to fall through to
           * "pull everything", which is the opposite of what every caller in
           * the tree means by it -- all of them pass `tables: []` for a
           * push-only sync. Bench's derived-refresh did exactly that and
           * fetched all sixteen tables including `leaderboard_entries`, which
           * is world-readable by design: every score every customer has ever
           * posted, downloaded to a phone over range cellular and discarded.
           * And discarded really is forever-repeating, because no apply handler
           * is passed on that call, so the cursor never commits and the next
           * one starts from 1970 again.
           *
           * `undefined` still means "everything", which is the only reading
           * that makes sense for a caller that did not say. */
          const wanted = Array.isArray(o.tables)
            ? cfg.tables.filter(t => o.tables.includes(t))
            : cfg.tables;
          for (const t of wanted) {
            const rows = await pullTable(t, false);
            const { applied, skipped, deferred, consumed } = reconcile(t, rows, o.apply);
            if (consumed) commitCursor(t, rows, undefined, deferred);
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
      onlineForced = true;
      if (was === online) return;
      emit(online ? EVENTS.NET_ONLINE : EVENTS.NET_OFFLINE, {});
      if (online && (!opts || opts.autoSync !== false) && isSignedIn() && outbox.length) {
        sync({ trigger: 'reconnect', apply: (opts || {}).apply });
      }
    }

    /* Attached automatically below. Leaving this opt-in meant it was never opted
     * into: both apps shipped without it, and the flag it maintains was the one
     * thing standing between a queued write and the server. Opt OUT with
     * `autoNetwork: false` if a host needs to drive connectivity itself. */
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
        if (isSignedIn() && isOnline()) sync({ trigger: 'interval', apply });
      }, cfg.autoSyncMs);
    }
    function stopAutoSync() {
      if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    }

    /* -------------------------------------------------------- convenience */
    /** Call a Postgres function. Relay operations are all RPCs because the
     *  security lives in security-definer functions, not in table policies. */
    async function rpc(fn, args) {
      const res = await authed('/rest/v1/rpc/' + fn, {
        method: 'POST',
        body: JSON.stringify(args || {}),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) return { ok: false, status: res.status, error: body };
      return { ok: true, data: body };
    }

    /** Read-only query for the cross-app views. */
    async function selectView(view, query) {
      const res = await authed(`/rest/v1/${view}?${query || 'select=*'}`, { method: 'GET' });
      if (!res.ok) {
        const error = await res.text().catch(() => '');
        emit(EVENTS.SYNC_ERROR, { phase: 'select', table: view, error: { status: res.status, body: error } });
        /* The status travels with the failure. "Could not reach the backend"
         * is the same sentence for a missing view (404 -- migrations not
         * applied), an expired session (401) and a policy refusal (403), and
         * those need three different things done about them. */
        return { ok: false, status: res.status, error };
      }
      return { ok: true, data: await res.json() };
    }

    /* ---------------------------------------------- whole-device backups */
    /* A snapshot is NOT sync, and none of the machinery above applies to it.
     *
     * It does not go through the outbox. The outbox exists so a write made at
     * a range with no signal still lands eventually, and it retries forever to
     * make that true. A snapshot has the opposite requirement: it is eight
     * megabytes, the user is watching a button, and a backup that "will happen
     * later" is a backup they will believe they have and do not. So it is a
     * direct request that either succeeds now or reports why not.
     *
     * It has no cursor, because there is nothing incremental about it. It has
     * no conflict resolution, because two devices backing up to the same slot
     * is the user overwriting their own copy, which is what a slot IS.
     *
     * The payload is opaque here on purpose. zero-core has no business knowing
     * what a session or a brass lot looks like; each app hands over a string it
     * knows how to read back, and gets the same string out. */
    const BACKUP_MAX_BYTES = 8 * 1024 * 1024;

    /** The row id for one slot, or null. Two round trips rather than an upsert
     *  on a compound unique key: PostgREST can do the upsert, but only if the
     *  client names the conflict target correctly, and getting that wrong
     *  fails as a duplicate-key INSERT — a new backup silently not saved. The
     *  extra request is a few hundred bytes against a payload of megabytes. */
    async function backupRowId(app, slot) {
      const q = `select=id&app=eq.${encodeURIComponent(app)}`
              + `&slot=eq.${encodeURIComponent(slot)}&limit=1`;
      const res = await authed('/rest/v1/account_backups?' + q, { method: 'GET' });
      if (!res.ok) return { ok: false, status: res.status, error: await res.text().catch(() => '') };
      const rows = await res.json().catch(() => []);
      return { ok: true, id: (rows && rows[0] && rows[0].id) || null };
    }

    /** Write one snapshot. `payload` is a string; anything else is stringified
     *  here so a caller cannot accidentally send `[object Object]`. */
    async function backupPut({ app, slot, payload, counts, deviceLabel, appBuild }) {
      const u = getUser();
      if (!u) return { ok: false, reason: 'not signed in' };
      if (isAnonymous()) return { ok: false, reason: 'anonymous devices cannot back up' };
      const body = typeof payload === 'string' ? payload : JSON.stringify(payload);

      /* Checked here as well as in the database. The server's constraint is
       * the one that counts, but finding out by uploading eight megabytes over
       * a phone connection and being refused is a bad way to learn it. */
      const bytes = new TextEncoder().encode(body).length;
      if (bytes > BACKUP_MAX_BYTES) {
        return { ok: false, reason: 'too large', bytes, limit: BACKUP_MAX_BYTES };
      }

      const row = {
        user_id: u.id,
        app: app || cfg.appId || 'zero',
        slot: slot || 'default',
        payload: body,
        counts: counts || {},
        device_label: deviceLabel || null,
        app_build: appBuild || null,
      };

      const found = await backupRowId(row.app, row.slot);
      if (!found.ok) return { ok: false, reason: 'lookup failed', status: found.status };

      let res;
      if (found.id) {
        /* PATCH, not an upsert: `created_at` should keep saying when this slot
         * was first used, and an INSERT ... ON CONFLICT that omitted it would
         * be fine while one that included it would quietly reset it. */
        const { user_id, ...patch } = row;
        res = await authed('/rest/v1/account_backups?id=eq.' + encodeURIComponent(found.id),
          { method: 'PATCH', slow: true, body: JSON.stringify(patch) });
      } else {
        res = await authed('/rest/v1/account_backups',
          { method: 'POST', slow: true, body: JSON.stringify([row]) });
      }
      if (!res.ok) {
        const error = await res.text().catch(() => '');
        emit(EVENTS.SYNC_ERROR, { phase: 'backup', table: 'account_backups',
                                  error: { status: res.status, body: error } });
        return { ok: false, reason: 'refused', status: res.status, error };
      }
      return { ok: true, bytes, slot: row.slot, app: row.app };
    }

    /** What snapshots exist, WITHOUT their payloads. The restore screen can
     *  then say what is up there and how big it is before anyone commits to
     *  downloading it on a phone plan. */
    async function backupList(app) {
      const q = 'select=*&order=updated_at.desc'
              + (app ? `&app=eq.${encodeURIComponent(app)}` : '');
      return selectView('v_account_backups', q);
    }

    /** One snapshot, payload and all. */
    async function backupGet({ app, slot }) {
      const q = `select=*&app=eq.${encodeURIComponent(app || cfg.appId || 'zero')}`
              + `&slot=eq.${encodeURIComponent(slot || 'default')}&limit=1`;
      const res = await authed('/rest/v1/account_backups?' + q, { method: 'GET' });
      if (!res.ok) {
        const error = await res.text().catch(() => '');
        return { ok: false, status: res.status, error };
      }
      const rows = await res.json().catch(() => []);
      if (!rows || !rows.length) return { ok: true, found: false, row: null };
      return { ok: true, found: true, row: rows[0] };
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

    /** Retract an entry. A REAL delete, not a tombstone.
     *
     * The board is world-readable by design, and a soft delete left the row
     * sitting there for any account to read after the app had already told its
     * owner it was gone. The obvious repair — filtering tombstones in the
     * SELECT policy — is impossible: Postgres requires an updated row to stay
     * visible under the table's SELECT policies, so that policy would refuse
     * the very UPDATE that sets deleted_at.
     *
     * Nothing depends on the tombstone. A published entry is not synced: no
     * device pulls it, and re-publishing upserts the same persisted id. So the
     * row goes.
     *
     * Direct rather than queued, for the same reason a backup is: "it will be
     * withdrawn later" is not what a user asking to withdraw a score means. If
     * it fails they are told, and the entry is still there to try again. */
    async function retractEntry(id) {
      if (!id) return { ok: false, reason: 'no id' };
      if (!isSignedIn()) return { ok: false, reason: 'not signed in' };
      /* Drop any queued write for this entry first: publishing and then
       * retracting before a sync would otherwise re-create it afterwards. */
      const before = outbox.length;
      outbox = outbox.filter(e => !(e.table === 'leaderboard_entries' && e.row.id === id));
      if (outbox.length !== before) persistOutbox();

      const res = await authed('/rest/v1/leaderboard_entries?id=eq.' + encodeURIComponent(id),
        { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      if (!res.ok) {
        const error = await res.text().catch(() => '');
        emit(EVENTS.SYNC_ERROR, { phase: 'retract', table: 'leaderboard_entries',
                                  error: { status: res.status, body: error } });
        return { ok: false, reason: 'refused', status: res.status };
      }
      emit(EVENTS.DATA_CHANGED, { table: 'leaderboard_entries', ids: [id], origin: 'local' });
      return { ok: true };
    }

    const leaderboard = (extra) =>
      selectView('v_leaderboard', 'select=*&' + (extra || 'order=score.desc'));

    const ballisticProfiles = (extra) =>
      selectView('v_ballistic_profiles', 'select=*&' + (extra || 'order=loaded_on.desc'));
    const batchPerformance = (extra) =>
      selectView('v_batch_performance', 'select=*&' + (extra || ''));

    /* ==================================================================
     * Live relay client.
     *
     * Polling, not WebSockets, and that is the whole point. A coach's phone
     * spends the session backgrounded; browsers throttle background timers,
     * which stops a WebSocket heartbeat, which makes the server drop the
     * socket -- silently, so the UI still says "connected" over a dead pipe.
     * That is what killed the previous attempt. A plain request on resume
     * simply works, and there is no connection to have quietly died.
     * ================================================================== */
    let relay = null;   // { id, code, role, slot, name, isHost, sinceShot,
                        //   sinceMsg, shots:Map, messages:Map, timer, stopped }
                        //
                        // role decides whether this device may write shots.
                        // isHost decides only who may END the relay. They are
                        // separate on purpose: in a pair, BOTH people are
                        // shooters but only one started it.

    const RELAY_POLL_MS = 2500;
    const RELAY_BACKOFF_MAX_MS = 20000;

    async function createRelay(opts) {
      const o = opts || {};
      const id = await ensureIdentity();
      if (!id.ok) return { ok: false, error: id.error };
      const r = await rpc('create_relay', {
        p_host_name: o.hostName || 'Shooter',
        p_title: o.title || null,
        p_target_name: o.targetName || null,
        p_target_rings: o.targetRings || null,
        p_distance_yd: o.distanceYd || null,
      });
      if (!r.ok) { emit(EVENTS.RELAY_ERROR, { phase: 'create', error: r.error }); return r; }
      const row = Array.isArray(r.data) ? r.data[0] : r.data;
      startRelay({ id: row.id, code: row.code, isHost: true, slot: 1,
                   name: o.hostName || 'Shooter', role: 'shooter' });
      return { ok: true, relay: row, slot: 1, role: 'shooter' };
    }

    /** opts.distanceYd: YOUR firing distance, not the relay starter's. It is
     *  what turns your inches into minutes on the coach's screen, and a pair is
     *  not always on the same line. */
    async function joinRelay(code, name, role, opts) {
      const id = await ensureIdentity();
      if (!id.ok) return { ok: false, error: id.error };
      const d = Number((opts || {}).distanceYd);
      /* PostgREST resolves an RPC by the KEYS in the body, so sending
       * p_target_name to a server that predates migration 0009 is not ignored
       * -- it is a 404 (PGRST202, "could not find the function"), and joining
       * a relay stops working entirely. A front end can reach a phone before
       * its operator has run the migration; that must not take pair fire down
       * on a match morning. So: try with it, and if the server does not know
       * that shape, try again without.
       *
       * The retry is narrow on purpose. Only a 404/PGRST202 qualifies -- a
       * refusal, a throttle or a bad code must not be silently retried. */
      const send = (extra) => rpc('join_relay', Object.assign({
        p_code: String(code || '').trim(),
        p_name: name || 'Guest',
        p_role: role === 'shooter' ? 'shooter' : 'coach',
        p_distance_yd: Number.isFinite(d) && d > 0 ? d : null,
      }, extra));

      /* YOUR target, for the same reason as YOUR distance: the coach's
       * combined plot is only honest if everyone is on the same paper, and the
       * relay by itself only ever knew the starter's. */
      let r = await send({ p_target_name: (opts || {}).targetName || null });
      const unknownShape = !r.ok && (r.status === 404 ||
        /PGRST202|could not find the function/i.test(JSON.stringify(r.error || '')));
      if (unknownShape) r = await send({});

      if (!r.ok) { emit(EVENTS.RELAY_ERROR, { phase: 'join', error: r.error }); return r; }
      // join_relay returns a RESULT, not an exception: a bad code is ok:false,
      // which is how the server-side throttle can record the failed attempt.
      const res = r.data || {};
      if (!res.ok) return { ok: false, reason: res.error, message: res.message };
      // Trust the SERVER's answer on role and firing point, not the request:
      // a relay that is already full hands back a coach seat, and rejoining
      // returns the slot you already held rather than a fresh one.
      startRelay({ id: res.relay.id, code: res.relay.code, isHost: false,
                   name: name || 'Guest', role: res.role || 'coach',
                   slot: res.slot || null });
      return { ok: true, relay: res.relay, slot: res.slot || null,
               role: res.role || 'coach' };
    }

    /* The paper, fetched ONCE. relay_state deliberately strips target_rings
     * from every poll -- it is static geometry and re-sending it every 2.5s to
     * every participant for a whole match is waste -- so this is the only way
     * anyone but the starter ever sees it.
     *
     * A server without migration 0009 has no such function and answers 404.
     * That is not an error worth showing: the app simply draws the bare grid
     * it drew before, which is exactly what it did for the last month. */
    async function fetchRelayFace() {
      if (!relay) return null;
      const r = await rpc('relay_face', { p_relay: relay.id });
      if (!r.ok) { relay.face = null; return null; }
      relay.face = r.data || null;
      return relay.face;
    }

    function startRelay(meta) {
      stopRelay();
      relay = Object.assign({
        sinceShot: '1970-01-01T00:00:00Z',
        sinceMsg: '1970-01-01T00:00:00Z',
        shots: new Map(), messages: new Map(), participants: [],
        backoff: RELAY_POLL_MS, stopped: false, timer: null,
      }, meta);
      /* Deliberately not awaited: the first poll must not wait on geometry.
       * The plot draws a bare grid until it lands, then redraws with paper. */
      fetchRelayFace().then(() => { if (relay) pollRelayOnce().catch(() => {}); })
                      .catch(() => {});
      pumpRelay();
      attachRelayResume();
      return relay;
    }

    function stopRelay() {
      if (relay && relay.timer) clearTimeout(relay.timer);
      if (relay) relay.stopped = true;
      detachRelayResume();
      relay = null;
    }

    async function pollRelayOnce() {
      if (!relay || relay.stopped) return { ok: false, reason: 'no-relay' };
      const r = await rpc('relay_state', {
        p_relay: relay.id,
        p_since_shot: relay.sinceShot,
        p_since_msg: relay.sinceMsg,
      });
      if (!r.ok) { emit(EVENTS.RELAY_ERROR, { phase: 'poll', error: r.error }); return r; }
      /* The relay can END during the await above, and this function held a
       * reference from before it. stopRelay() sets `relay` to null -- from
       * endRelay, from a sign-out, or from the ended branch at the bottom of
       * this very function on an earlier tick -- and the next line would then
       * dereference null and take the whole poll loop down with an uncaught
       * TypeError inside a timer, where nothing is left to catch it.
       *
       * pumpRelay re-checks after ITS await for the same reason, one function
       * below. This one did not, and the guard at the top only covers the state
       * before the request went out. */
      if (!relay || relay.stopped) return { ok: false, reason: 'no-relay' };
      const st = r.data || {};

      /* Dedupe by id, because relay_state uses a >= cursor: rows sharing the
       * boundary timestamp are deliberately re-sent rather than dropped. */
      (st.shots || []).forEach(x => relay.shots.set(x.id, x));
      (st.messages || []).forEach(m => relay.messages.set(m.id, m));
      relay.participants = st.participants || [];

      const maxOf = (rows, cur) => rows.reduce(
        (m, x) => (x.created_at > m ? x.created_at : m), cur);
      relay.sinceShot = maxOf(st.shots || [], relay.sinceShot);
      relay.sinceMsg = maxOf(st.messages || [], relay.sinceMsg);

      // Ordered by firing point, then sighters before record, then number.
      // Two shooters both have a shot 1, so shot_no alone no longer orders.
      const shots = [...relay.shots.values()].sort((a, b) =>
        (a.slot || 0) - (b.slot || 0) ||
        (a.is_sighter === b.is_sighter ? 0 : (a.is_sighter ? -1 : 1)) ||
        a.shot_no - b.shot_no);
      const messages = [...relay.messages.values()]
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1));

      emit(EVENTS.RELAY_STATE, {
        relay: st.relay, shots, messages,
        participants: relay.participants, serverTime: st.server_time,
        /* Cached, not re-fetched. Consumers get it in the same shape on every
         * tick so they do not have to hold it themselves. */
        face: relay.face || null,
      });

      if (st.relay && st.relay.status === 'ended') {
        emit(EVENTS.RELAY_ENDED, { relayId: relay.id });
        stopRelay();
      }
      return { ok: true, shots, messages };
    }

    async function pumpRelay() {
      if (!relay || relay.stopped) return;
      const r = await pollRelayOnce();
      if (!relay || relay.stopped) return;
      // Back off on failure so a dead network does not hammer the API, and
      // snap back to the normal cadence the moment a poll succeeds.
      relay.backoff = r.ok ? RELAY_POLL_MS
        : Math.min(RELAY_BACKOFF_MAX_MS, Math.round(relay.backoff * 1.8));
      relay.timer = setTimeout(pumpRelay, relay.backoff);
    }

    /* Resume immediately when the tab comes back or the network returns,
     * rather than waiting out a backoff the user cannot see. */
    let relayResumeHandler = null;
    function attachRelayResume() {
      if (typeof document === 'undefined' || relayResumeHandler) return;
      relayResumeHandler = () => {
        if (!relay || relay.stopped) return;
        if (typeof document !== 'undefined' && document.hidden) return;
        if (relay.timer) clearTimeout(relay.timer);
        relay.backoff = RELAY_POLL_MS;
        pumpRelay();
      };
      document.addEventListener('visibilitychange', relayResumeHandler);
      if (typeof window !== 'undefined') window.addEventListener('online', relayResumeHandler);
    }
    function detachRelayResume() {
      if (!relayResumeHandler) return;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', relayResumeHandler);
      }
      if (typeof window !== 'undefined') window.removeEventListener('online', relayResumeHandler);
      relayResumeHandler = null;
    }

    /** Mirror one of YOUR OWN shots into the relay. Any participant holding
     *  the shooter role may do this; the server enforces that the row is
     *  attributed to the caller, so a partner cannot write your string.
     *
     *  Fire and forget -- a failure here must never block logging the shot
     *  locally, because the local session is the system of record. */
    async function relayPushShot(shot) {
      if (!relay) return { ok: false, reason: 'no-relay' };
      if (relay.role !== 'shooter') return { ok: false, reason: 'not-shooter' };
      const uid = session && session.user && session.user.id;
      // The conflict key includes user_id: re-pushing YOUR shot 3 updates your
      // row and never touches your partner's shot 3.
      const res = await authed(
        '/rest/v1/relay_shots?on_conflict=relay_id,user_id,shot_no,is_sighter', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify([{
          relay_id: relay.id,
          user_id: uid || undefined,
          shot_no: shot.shotNo,
          ring: shot.ring == null ? null : String(shot.ring),
          x_in: shot.x, y_in: shot.y,
          // The call is what a coach reads. Sending it is the difference
          // between "he shot a 9 at 4 o'clock" and "he called it centre".
          call_x_in: shot.callX == null ? null : shot.callX,
          call_y_in: shot.callY == null ? null : shot.callY,
          wind_call_moa: shot.windCallMoa == null ? null : shot.windCallMoa,
          wind_call_dir: shot.windCallDir === 'L' || shot.windCallDir === 'R'
            ? shot.windCallDir : null,
          is_sighter: !!shot.isSighter,
          note: shot.note || null,
        }]),
      });
      if (!res.ok) {
        const error = await res.text().catch(() => '');
        emit(EVENTS.RELAY_ERROR, { phase: 'push-shot', error });
        emit(EVENTS.RELAY_MIRROR, { ok: false, phase: 'push-shot', error });
        return { ok: false, error };
      }
      emit(EVENTS.RELAY_MIRROR, { ok: true, phase: 'push-shot' });
      pokeRelay();
      return { ok: true };
    }

    /** Take one of your own shots back off the relay.
     *
     *  Stable shot numbers stop a deleted shot's ordinal being handed to the
     *  next one, but they do not remove the row: the hole stays on the coach's
     *  target and keeps being scored. On a 5-shot string that is the difference
     *  between the coach reading 45 and the 48 the shooter actually shot, with
     *  a deleted 6 plotted three inches out.
     *
     *  Fire and forget like the push, and for the same reason: the local
     *  session is the system of record and a dead network must not block a
     *  delete. The cost is that a failed retraction leaves a ghost -- which is
     *  why the caller re-sends it on the next relay bind rather than firing
     *  once and hoping. */
    async function relayRetractShot(shotNo, isSighter) {
      if (!relay) return { ok: false, reason: 'no-relay' };
      if (relay.role !== 'shooter') return { ok: false, reason: 'not-shooter' };
      const uid = session && session.user && session.user.id;
      if (!uid || !Number.isFinite(shotNo)) return { ok: false, reason: 'no-shot' };
      const q = `/rest/v1/relay_shots?relay_id=eq.${encodeURIComponent(relay.id)}` +
        `&user_id=eq.${encodeURIComponent(uid)}` +
        `&shot_no=eq.${encodeURIComponent(String(shotNo))}` +
        `&is_sighter=is.${isSighter ? 'true' : 'false'}`;
      const res = await authed(q, { method: 'DELETE' });
      if (!res.ok) {
        const error = await res.text().catch(() => '');
        emit(EVENTS.RELAY_ERROR, { phase: 'retract-shot', error });
        emit(EVENTS.RELAY_MIRROR, { ok: false, phase: 'retract-shot', error });
        return { ok: false, error };
      }
      emit(EVENTS.RELAY_MIRROR, { ok: true, phase: 'retract-shot' });
      pokeRelay();
      return { ok: true };
    }

    async function relaySend(body, kind) {
      if (!relay) return { ok: false, reason: 'no-relay' };
      const text = String(body || '').trim();
      if (!text) return { ok: false, reason: 'empty' };
      const res = await authed('/rest/v1/relay_messages', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify([{
          relay_id: relay.id, author_name: relay.name,
          kind: kind === 'wind' ? 'wind' : 'chat', body: text.slice(0, 500),
        }]),
      });
      if (!res.ok) {
        const error = await res.text().catch(() => '');
        emit(EVENTS.RELAY_ERROR, { phase: 'send', error });
        return { ok: false, error };
      }
      pokeRelay();
      return { ok: true };
    }

    /** Poll now rather than waiting for the next tick, so your own writes
     *  appear immediately instead of up to 2.5s later. */
    function pokeRelay() {
      if (!relay || relay.stopped) return;
      if (relay.timer) clearTimeout(relay.timer);
      relay.timer = setTimeout(pumpRelay, 120);
    }

    async function endRelay() {
      if (!relay || !relay.isHost) return { ok: false, reason: 'not-host' };
      const r = await rpc('end_relay', { p_relay: relay.id });
      stopRelay();
      return r;
    }

    /** Leave without ending it for everyone else. Deletes the participant row
     *  rather than just stopping the poll, so the firing point is freed and
     *  the others stop seeing a name that will never come back. Best effort:
     *  a failed delete must not trap you in a relay you have walked away from. */
    async function leaveRelay() {
      if (!relay) return { ok: false, reason: 'no-relay' };
      if (relay.isHost) return endRelay();
      const id = relay.id;
      const uid = session && session.user && session.user.id;
      stopRelay();
      if (!uid) return { ok: true };
      try {
        await authed('/rest/v1/relay_participants?relay_id=eq.' + encodeURIComponent(id) +
                     '&user_id=eq.' + encodeURIComponent(uid), { method: 'DELETE' });
      } catch (_) { /* already gone, or offline -- either way we are out */ }
      return { ok: true };
    }

    const relayInfo = () => (relay
      ? { id: relay.id, code: relay.code, isHost: relay.isHost,
          name: relay.name, role: relay.role, slot: relay.slot,
          canShoot: relay.role === 'shooter',
          shotCount: relay.shots.size, participants: relay.participants,
          /* The paper, or null against a server without relay_face. Exposed
           * here as well as on the state event so a consumer can ask at any
           * time rather than waiting for the next poll. */
          face: relay.face || null }
      : null);

    function resetCursors() {
      cursors = {}; store.set(K.cursors, cursors);
      /* Floors go with them: a floor is a position in a cursor's history, and
       * keeping one against a cursor that has been rewound to 1970 would stall
       * the re-pull it exists to allow. */
      floors = {}; persistFloors();
    }

    const instance = {
      EVENTS, TABLES,
      on, off, emit,
      signUp, signIn, signInWithOtp, signOut, refresh,
      getSession, getUser, isSignedIn,
      upsert, remove, enqueue, pendingCount, pendingFor, rejectedList, clearRejected, retryRejected,
      track, attachSessionListeners, flushTelemetry,
      get usageSessionId() { return usageSessionId; },
      sync, pullTable, pushTable, reconcile, resetCursors,
      setOnline, attachBrowserListeners, startAutoSync, stopAutoSync,
      selectView, rpc, ballisticProfiles, batchPerformance,
      backupPut, backupGet, backupList, BACKUP_MAX_BYTES,
      adoptSessionFromUrl,
      signInAnonymously, isAnonymous, ensureIdentity,
      mfaEnroll, mfaChallenge, mfaVerify, mfaUnenroll, mfaFactors, aal,
      claimHandle, publishEntry, retractEntry, leaderboard,
      createRelay, joinRelay, stopRelay, endRelay, leaveRelay, pollRelayOnce,
      relayPushShot, relayRetractShot, relaySend, relayInfo,
      uuid,
      get isOnline() { return isOnline(); },
      /* The TIMESTAMP each table is up to, which is what a cursor has always
       * meant to a caller. Internally it is a `(updated_at, id)` position --
       * see pullTable -- but the id half is a tiebreaker for paging, not
       * information anyone outside asked for. */
      get cursors() {
        const out = {};
        for (const t of Object.keys(cursors)) out[t] = posOf(cursors[t]).at;
        return out;
      },
      /* The full positions, for anything that needs to resume a walk. */
      get cursorPositions() { return JSON.parse(JSON.stringify(cursors)); },
      /* Which tables are holding their cursor back, and for how long. A
       * diagnostic: "Bench has 40 sessions it cannot file" is otherwise
       * invisible until the user notices they are missing. */
      get floors() { return JSON.parse(JSON.stringify(floors)); },
      get outbox() { return outbox.map(e => ({ table: e.table, id: e.row.id, op: e.op })); },
      _config: cfg,
    };

    /* Track connectivity unless the host says it will. Opt-in was the wrong
     * default: it shipped un-opted-in from both apps, and the consequence was
     * a queued write that could never leave the device. */
    if (cfg.autoNetwork !== false) instance.detachNetwork = attachBrowserListeners();

    /* Telemetry attaches itself for the same reason connectivity does: the
     * comment above is the record of what opt-in got us last time. Opt OUT with
     * `telemetry: false`, which the SQL suite and the mock both use to keep
     * their outboxes to what they queued on purpose.
     *
     * trackOpen() runs after the session has been restored from storage, so a
     * returning user is counted on launch; a signed-out launch records nothing
     * until they sign in, and signIn/signUp call trackOpen() for that. */
    if (cfg.telemetry !== false) {
      instance.detachSession = attachSessionListeners();
      trackOpen();
    }

    /* A confirmation link lands here carrying a session in the URL fragment.
     *
     * Supabase's confirm-your-email link goes to the project's Site URL with
     * `#access_token=...&refresh_token=...&type=signup` on the end. Nothing
     * read it, so a new user clicked the link, watched the app load as a
     * stranger, and had to go and sign in by hand -- after a page that, with
     * Site URL left at its localhost default, does not resolve at all.
     *
     * Adopted and then STRIPPED from the URL immediately: a bearer token that
     * stays in the address bar is one that goes into history, gets shared in a
     * screenshot, and is read by anything that can see a referrer. This is the
     * same thing Supabase's own client calls detectSessionInUrl. */
    if (cfg.detectSessionInUrl !== false) { try { adoptSessionFromUrl(); } catch (e) {} }

    return instance;
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
