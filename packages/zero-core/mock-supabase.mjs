/* Minimal stand-in for GoTrue + PostgREST, enough to exercise zero-core's
 * failure modes: token expiry, refresh rotation, RLS-style per-user isolation,
 * foreign-key rejection, paging, and upsert-on-conflict.
 *
 * It counts endpoint hits so tests can assert on things like "exactly one
 * refresh happened", which is the whole point of the single-flight logic. */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

export function startMock(opts = {}) {
  const state = {
    users: new Map(),            // email -> { id, password }
    tokens: new Map(),           // access_token -> { userId, expiresAt }
    refreshTokens: new Map(),    // refresh_token -> userId
    rows: new Map(),             // table -> Map(id -> row)
    clock: 1_000_000,            // server clock, ms; tests advance it by hand
    hits: { refresh: 0, signin: 0, push: {}, pull: {}, patch: {}, rpc: {} },
    failRefresh: false,
    ttlSec: opts.ttlSec ?? 3600,
    pushOrder: [],               // tables in the order they were pushed to
    lastPush: {},                // table -> the exact payload the client sent
    /* Columns the real schema declares NOT NULL, for the tables the clients
     * write both ways. An upsert is INSERT ... ON CONFLICT: Postgres forms the
     * insert tuple before it detects the conflict, so a payload missing one of
     * these is refused even when the row already exists. That is not a detail
     * -- it is why a delete cannot be expressed as an upsert of
     * {id, deleted_at}, which is exactly the bug this mock failed to catch
     * until it learned the constraint. */
    notNull: { firearms: ['name', 'cartridge'] },
    // tables whose rows must reference an existing parent row
    fk: { shots: ['session_id', 'range_sessions'],
          groups: ['session_id', 'range_sessions'],
          batches: ['recipe_id', 'recipes'] },
    // RLS `using (true)` stand-in: reads cross user boundaries here
    publicTables: new Set(['leaderboard_profiles', 'leaderboard_entries', 'v_leaderboard']),
    relays: new Map(),          // id -> relay
    relayParts: new Map(),      // relayId -> Map(userId -> participant)
    joinFails: new Map(),       // userId -> count
    anonUsers: new Set(),       // user ids created by anonymous sign-in
    /* Pretend to be a server that predates migration 0009: no relay_face, and
     * a join_relay that does not know p_target_name. PostgREST resolves an RPC
     * by the keys in the body, so the extra key is a 404 rather than an
     * ignored argument -- which is a client that cannot join at all if it does
     * not handle it. */
    legacyRelayRpc: false,
  };

  const stamp = () => new Date(state.clock).toISOString();
  const table = (t) => {
    if (!state.rows.has(t)) state.rows.set(t, new Map());
    return state.rows.get(t);
  };

  const json = (res, code, body) => {
    const s = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(s);
  };

  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  function issue(userId, email) {
    // JWT-shaped, so a client that decodes the token (rather than reading the
    // user object) exercises a realistic path.
    const anon = state.anonUsers.has(userId);
    const access = [b64u({ alg: 'HS256', typ: 'JWT' }),
                    b64u({ sub: userId, role: 'authenticated', is_anonymous: anon }),
                    'sig'].join('.');
    const refresh = 'rt_' + randomUUID();
    state.tokens.set(access, { userId, expiresAt: state.clock + state.ttlSec * 1000 });
    state.refreshTokens.set(refresh, userId);
    // Real GoTrue includes the email on the user object; clients display it.
    return { access_token: access, refresh_token: refresh, expires_in: state.ttlSec,
             user: { id: userId, email: email || [...state.users].find(([, v]) => v.id === userId)?.[0] || null } };
  }

  function auth(req) {
    const h = req.headers.authorization || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!tok) return null;
    const rec = state.tokens.get(tok);
    if (!rec) return null;
    if (rec.expiresAt <= state.clock) return { expired: true };
    return rec;
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      const u = new URL(req.url, 'http://mock');
      const p = u.pathname;

      // Browsers preflight cross-origin JSON requests; real Supabase answers
      // with permissive CORS, so the mock must too. Handled BEFORE routing --
      // an OPTIONS falling through to /signup would create a phantom user.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, apikey, content-type, prefer');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch { payload = {}; }

      /* ------------------------------------------------------------ auth */
      if (p === '/auth/v1/signup') {
        const id = randomUUID();
        // No email => anonymous sign-in, exactly as @supabase/auth-js sends it.
        if (!payload.email) {
          state.anonUsers.add(id);
          const s2 = issue(id, null);
          s2.user.is_anonymous = true;
          return json(res, 200, s2);
        }
        state.users.set(payload.email, { id, password: payload.password });
        return json(res, 200, issue(id, payload.email));
      }

      if (p === '/auth/v1/token') {
        const grant = u.searchParams.get('grant_type');
        if (grant === 'password') {
          state.hits.signin++;
          const rec = state.users.get(payload.email);
          if (!rec || rec.password !== payload.password) {
            return json(res, 400, { error: 'invalid_grant' });
          }
          return json(res, 200, issue(rec.id, payload.email));
        }
        if (grant === 'refresh_token') {
          state.hits.refresh++;
          if (state.failRefresh) return json(res, 400, { error: 'invalid_grant' });
          const userId = state.refreshTokens.get(payload.refresh_token);
          if (!userId) return json(res, 400, { error: 'invalid_grant' });
          state.refreshTokens.delete(payload.refresh_token);  // rotate
          return json(res, 200, issue(userId));
        }
        return json(res, 400, { error: 'unsupported_grant_type' });
      }

      if (p === '/auth/v1/logout') return json(res, 204, {});

      /* ------------------------------------------------------------- rpc */
      if (p.startsWith('/rest/v1/rpc/')) {
        const fn = p.slice('/rest/v1/rpc/'.length);
        state.hits.rpc[fn] = (state.hits.rpc[fn] || 0) + 1;
        const a = auth(req);
        const CODE_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXZ';

        // keepalive is granted to `anon`, so it answers with the bare
        // publishable key and no user session. That is the whole point of it:
        // a scheduled job holds no account. The mock used to demand a session
        // here, which made it stricter than the database and would have hidden
        // a real grant mistake.
        if (fn === 'keepalive') return json(res, 200, stamp());

        if (!a || a.expired) return json(res, 401, { message: 'JWT expired' });

        if (fn === 'create_relay') {
          for (const r of state.relays.values()) {
            if (r.host_id === a.userId && r.status === 'live') r.status = 'ended';
          }
          let code;
          do {
            code = Array.from({ length: 4 }, () =>
              CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
          } while ([...state.relays.values()].some(r => r.status === 'live' && r.code === code));
          const relay = { id: randomUUID(), code, host_id: a.userId,
            host_name: payload.p_host_name || 'Shooter', title: payload.p_title || null,
            target_name: payload.p_target_name || null,
            // The face geometry, so a viewer can draw the real paper without
            // owning the same custom target.
            target_rings: payload.p_target_rings || null,
            distance_yd: payload.p_distance_yd || null,
            status: 'live', started_at: stamp(), expires_at: null,
            created_at: stamp(), updated_at: stamp() };
          state.relays.set(relay.id, relay);
          state.relayParts.set(relay.id, new Map([[a.userId,
            { user_id: a.userId, name: relay.host_name, role: 'shooter',
              slot: 1, last_seen_at: stamp(),
              distance_yd: payload.p_distance_yd ?? null,
              target_name: payload.p_target_name ?? null }]]));
          return json(res, 200, relay);
        }

        if (fn === 'join_relay' && state.legacyRelayRpc && 'p_target_name' in payload) {
          return json(res, 404, { code: 'PGRST202',
            message: 'Could not find the function public.join_relay('
                     + Object.keys(payload).sort().join(', ') + ') in the schema cache' });
        }
        if (fn === 'relay_face' && state.legacyRelayRpc) {
          return json(res, 404, { code: 'PGRST202',
            message: 'Could not find the function public.relay_face(p_relay) in the schema cache' });
        }

        if (fn === 'join_relay') {
          const fails = state.joinFails.get(a.userId) || 0;
          if (fails >= 10) {
            return json(res, 200, { ok: false, error: 'throttled',
              message: 'Too many attempts. Wait a few minutes.' });
          }
          const code = String(payload.p_code || '').trim().toUpperCase();
          const relay = [...state.relays.values()]
            .find(r => r.code === code && r.status === 'live');
          if (!relay) {
            state.joinFails.set(a.userId, fails + 1);
            return json(res, 200, { ok: false, error: 'not_found',
              message: 'No live relay with that code.' });
          }
          const parts = state.relayParts.get(relay.id) || new Map();
          const role = payload.p_role === 'shooter' ? 'shooter' : 'coach';
          // Keep any slot already held (rejoin), else take the lowest free one.
          let slot = parts.get(a.userId)?.slot ?? null;
          if (role === 'shooter' && slot == null) {
            const taken = new Set([...parts.values()].map(p => p.slot).filter(Boolean));
            slot = [1, 2, 3, 4].find(g => !taken.has(g)) ?? null;
            if (slot == null) {
              return json(res, 200, { ok: false, error: 'full',
                message: 'This relay already has four shooters. Join as a coach.' });
            }
          }
          parts.set(a.userId, { user_id: a.userId, name: payload.p_name || 'Guest',
            role, slot, last_seen_at: stamp(),
            distance_yd: payload.p_distance_yd ?? parts.get(a.userId)?.distance_yd ?? null,
            target_name: payload.p_target_name ?? parts.get(a.userId)?.target_name ?? null });
          state.relayParts.set(relay.id, parts);
          // join_relay returns `to_jsonb(r) - 'target_rings'`. Handing the
          // geometry back here would let a client draw paper the real server
          // never sends -- which is exactly the divergence that hid the empty
          // coach plot for a month.
          const { target_rings, ...relayLean } = relay;
          return json(res, 200, { ok: true, relay: relayLean, slot, role });
        }

        /* The paper, fetched once. Participation-gated like relay_state. */
        if (fn === 'relay_face') {
          const relay = state.relays.get(payload.p_relay);
          const parts = state.relayParts.get(payload.p_relay);
          if (!relay || !parts || !parts.has(a.userId)) {
            return json(res, 403, { code: '42501', message: 'not a participant' });
          }
          return json(res, 200, { target_name: relay.target_name ?? null,
                                  target_rings: relay.target_rings ?? null,
                                  distance_yd: relay.distance_yd ?? null });
        }

        if (fn === 'relay_state') {
          const relay = state.relays.get(payload.p_relay);
          const parts = state.relayParts.get(payload.p_relay);
          if (!relay || !parts || !parts.has(a.userId)) {
            return json(res, 403, { code: '42501', message: 'not a participant' });
          }
          parts.get(a.userId).last_seen_at = stamp();
          // >= to match the migration: rows tying the cursor are re-sent, not lost
          const since = (rows, cur) => rows.filter(x => x.created_at >= cur);
          // Same strip as the migration: target_rings never rides the poll.
          const { target_rings: _rings, ...relayLean } = relay;
          return json(res, 200, {
            relay: relayLean,
            shots: since([...table('relay_shots').values()]
              .filter(x => x.relay_id === payload.p_relay), payload.p_since_shot || '')
              .map(({ user_id, ...x }) => ({ ...x,
                slot: parts.get(user_id)?.slot ?? null,
                shooter: parts.get(user_id)?.name ?? null,
                is_self: user_id === a.userId })),
            // Built field by field, like the migration: to_jsonb(m) carried
            // user_id to every participant.
            messages: since([...table('relay_messages').values()]
              .filter(x => x.relay_id === payload.p_relay), payload.p_since_msg || '')
              .map(({ user_id, ...m }) => ({ ...m,
                slot: parts.get(user_id)?.slot ?? null,
                is_self: user_id === a.userId })),
            participants: [...parts.values()].map(x => ({ name: x.name, role: x.role,
              slot: x.slot ?? null, distance_yd: x.distance_yd ?? relay.distance_yd ?? null,
              target_name: x.target_name ?? relay.target_name ?? null,
              last_seen_at: x.last_seen_at, is_self: x.user_id === a.userId })),
            server_time: stamp(),
          });
        }

        if (fn === 'end_relay') {
          const relay = state.relays.get(payload.p_relay);
          if (!relay || relay.host_id !== a.userId) {
            return json(res, 403, { code: '42501', message: 'only the host can end a relay' });
          }
          relay.status = 'ended'; relay.ended_at = stamp();
          return json(res, 200, null);
        }

        return json(res, 404, { message: 'no such function: ' + fn });
      }

      /* PostgREST answers its root with an OpenAPI document to any caller
       * holding a valid apikey — which is how a client tells "wrong key" (401)
       * apart from "project asleep" (5xx). */
      if (p === '/rest/v1/' || p === '/rest/v1') return json(res, 200, { swagger: '2.0' });

      /* ------------------------------------------------------------ rest */
      if (p.startsWith('/rest/v1/')) {
        const t = p.slice('/rest/v1/'.length);
        const a = auth(req);
        if (!a || a.expired) return json(res, 401, { message: 'JWT expired' });

        /* Leaving a relay is the only DELETE the clients issue. Scoped to the
         * caller's own participant row, mirroring relay_part_delete_self. */
        /* A real DELETE, scoped by RLS. Retracting a leaderboard entry is one:
         * a soft delete left the row world-readable after the app had said it
         * was gone, and a SELECT policy that hides tombstones cannot coexist
         * with the UPDATE that creates them. */
        if (req.method === 'DELETE' && t !== 'relay_participants') {
          /* Filter-general, not id-only. Retracting a relay shot is scoped by
           * (relay_id, user_id, shot_no, is_sighter) -- there is no id to hand
           * over, because the shooter knows the shot by its ordinal and not by
           * the row it landed in. A mock that only understood `id=eq.` would
           * answer that DELETE with 204 and remove nothing, and the ghost row
           * it left behind is exactly the bug under test. */
          const eqs = [], iss = [];
          for (const [k, v] of u.searchParams) {
            if (k === 'select' || k === 'limit' || k === 'offset' || k === 'order') continue;
            if (v.startsWith('eq.')) eqs.push([k, v.slice(3)]);
            else if (v.startsWith('is.')) iss.push([k, v.slice(3)]);
          }
          const matches = (r) =>
            eqs.every(([k, v]) => String(r[k] == null ? '' : r[k]) === v) &&
            iss.every(([k, v]) => (v === 'null' ? r[k] == null : !!r[k] === (v === 'true')));
          // Another account's row is invisible, not forbidden: PostgREST
          // answers a filter matching nothing with 204 and no rows removed.
          const own = (r) => r.user_id === undefined || r.user_id === a.userId;
          for (const [key, row] of [...table(t).entries()]) {
            if (own(row) && matches(row)) table(t).delete(key);
          }
          return json(res, 204, null);
        }

        if (req.method === 'DELETE' && t === 'relay_participants') {
          const rid = (u.searchParams.get('relay_id') || '').replace(/^eq\./, '');
          const parts = state.relayParts.get(rid);
          if (parts) parts.delete(a.userId);
          return json(res, 204, null);
        }

        /* PATCH, which is how a tombstone travels.
         *
         * It cannot be an upsert of {id, deleted_at}: Postgres builds the
         * insert tuple before it detects the conflict, so a partial row fails
         * the table's NOT NULL columns and the delete is refused outright.
         * That bug shipped and was invisible here until this mock learned to
         * answer PATCH -- so the shape is modelled, filter and all, rather
         * than waved through. */
        if (req.method === 'PATCH') {
          const idFilter = (u.searchParams.get('id') || '').replace(/^eq\./, '');
          state.hits.patch[t] = (state.hits.patch[t] || 0) + 1;
          const row = table(t).get(idFilter);
          // RLS: another account's row is invisible, not forbidden. PostgREST
          // answers a filter matching nothing with 204 and no rows changed.
          if (!row || row.user_id !== a.userId) return json(res, 204, null);
          // The size ceiling is a table constraint, so it applies to an UPDATE
          // exactly as it does to an INSERT -- and the update is the common
          // path, since a slot is written over and over.
          if (t === 'account_backups' && payload && payload.payload !== undefined
              && Buffer.byteLength(String(payload.payload || ''), 'utf8') > 8388608) {
            return json(res, 400, { code: '23514',
              message: 'new row violates check constraint "account_backups_payload_check"' });
          }
          Object.assign(row, payload, { updated_at: stamp() });
          return json(res, 204, null);
        }

        if (req.method === 'GET') {
          state.hits.pull[t] = (state.hits.pull[t] || 0) + 1;
          /* A seam for the one thing a paged pull has to survive and cannot be
           * tested without: the table CHANGING between two pages of the same
           * walk. Called before the rows are read, so a hook can re-stamp or
           * insert exactly as another device would mid-sync. */
          if (typeof state.onPull === 'function') {
            try { state.onPull(t, u); } catch (e) { /* a hook's problem */ }
          }
          /* `gt.` and `gte.` both, because the keyset walk uses `gte.` for a
           * start-of-timestamp position. A mock that stripped only `gt.` would
           * compare every row against the literal string "gte.1970-…" and
           * answer every such request with nothing -- a silent empty pull. */
          const uaRaw = u.searchParams.get('updated_at') || '';
          const gte = uaRaw.startsWith('gte.') ? uaRaw.slice(4) : '';
          const gt = uaRaw.startsWith('gt.') ? uaRaw.slice(3) : '';
          const limit = parseInt(u.searchParams.get('limit') || '1000', 10);
          const offset = parseInt(u.searchParams.get('offset') || '0', 10);

          /* The compound keyset the pull walks with:
           *   or=(updated_at.gt.T,and(updated_at.eq.T,id.gt.ID))
           * PostgREST has no row-value comparison, so `(updated_at, id) > (T,
           * ID)` is spelled as that disjunction. Modelled here because a mock
           * that ignored it would answer every keyset page with the whole table
           * and the client would look correct while asking for something the
           * real server narrows -- which is precisely the class of mistake the
           * `eq` handling below was added to stop. */
          const orRaw = u.searchParams.get('or') || '';
          const ks = /^\(updated_at\.gt\.([^,]+),and\(updated_at\.eq\.([^,]+),id\.gt\.([^)]*)\)\)$/
            .exec(orRaw);
          /* `id` is a uuid column on every synced table, and Postgres refuses
           * to cast an empty string to uuid AT PARSE TIME -- the unreachable
           * branch of the OR does not save it, the whole request is a 400.
           *
           * This mock used to match the empty id with `[^)]*` and answer 200,
           * which let a client ship that issued exactly that URL on every first
           * sync, every legacy cursor and every reset: pull dead permanently,
           * push still working, so data went up and nothing came down. Every
           * test was green. A mock that is more permissive than the server is
           * not a convenience, it is a blind spot with a suite attached. */
          if (ks && !/^[0-9a-fA-F-]{36}$/.test(ks[3])) {
            return json(res, 400, { code: '22P02', message:
              `invalid input syntax for type uuid: "${ks[3]}"` });
          }
          const keyset = ks ? { at: ks[1], id: ks[3] } : null;
          const afterKeyset = (r) => !keyset ||
            r.updated_at > keyset.at ||
            (r.updated_at === keyset.at && String(r.id == null ? '' : r.id) > keyset.id);

          /* `order=updated_at.asc,id.asc` is a TOTAL order; `order=updated_at
           * .asc` alone is not, because updated_at defaults to now() -- the
           * transaction timestamp -- so a bulk insert stamps every row it
           * writes identically. Sorting by the declared columns rather than
           * assuming one keeps that distinction visible. */
          const orderBy = (u.searchParams.get('order') || '').split(',')
            .map(s => s.trim()).filter(Boolean)
            .map(s => { const [col, dir] = s.split('.'); return { col, desc: dir === 'desc' }; });
          const byOrder = (x, y) => {
            for (const { col, desc } of orderBy) {
              const a2 = x[col], b2 = y[col];
              if (a2 === b2) continue;
              return (a2 < b2 ? -1 : 1) * (desc ? -1 : 1);
            }
            return 0;
          };

          // v_leaderboard is a view: synthesize the entries+profiles join,
          // exactly like the Postgres definition (left join, coalesce anon,
          // deleted filtered).
          if (t === 'v_leaderboard') {
            const profs = table('leaderboard_profiles');
            const rows2 = [...table('leaderboard_entries').values()]
              .filter(r => !r.deleted_at)
              .map(e => ({ ...e, handle: [...profs.values()].find(p => p.id === e.user_id)?.handle || 'anon' }));
            return json(res, 200, rows2.slice(offset, offset + limit));
          }

          // relay tables are participant-scoped, not user-scoped
          if (t === 'relay_shots' || t === 'relay_messages') {
            const rows2 = [...table(t).values()].filter(r => {
              const parts = state.relayParts.get(r.relay_id);
              return parts && parts.has(a.userId);
            });
            return json(res, 200, rows2.slice(offset, offset + limit));
          }

          /* Every other `col=eq.value` in the query string. The pull only ever
           * filters on updated_at, so this used to be all the mock knew --
           * which meant a request for ONE backup slot was answered with every
           * row in the table and the client appeared to work while asking for
           * something the real server would have narrowed. */
          const eqs = [];
          for (const [k, v] of u.searchParams) {
            if (k === 'updated_at' || k === 'select' || k === 'limit' ||
                k === 'offset' || k === 'order' || k === 'on_conflict') continue;
            if (v.startsWith('eq.')) eqs.push([k, v.slice(3)]);
          }


          const isPublic = state.publicTables.has(t);
          let rows = [...table(t).values()]
            .filter(r => isPublic || r.user_id === a.userId)   // RLS stand-in
            .filter(r => !gt || r.updated_at > gt)
            .filter(r => !gte || r.updated_at >= gte)
            .filter(afterKeyset)
            .filter(r => eqs.every(([k, v]) => String(r[k] == null ? '' : r[k]) === v))
            .sort(orderBy.length
              ? byOrder
              /* No `order` asked for: deliberately NOT a stable sort by
               * updated_at. Postgres gives no ordering guarantee without one,
               * and a mock that quietly provides a consistent one hides every
               * bug that depends on not having it. */
              : ((x, y) => (x.updated_at < y.updated_at ? -1 : 1)));
          /* A view over a table, not a second store: `bytes` is derived and
           * `payload` is absent, which is the whole reason the view exists. */
          if (t === 'v_account_backups') {
            rows = [...table('account_backups').values()]
              .filter(r => r.user_id === a.userId)
              .filter(r => eqs.every(([k, v]) => String(r[k] == null ? '' : r[k]) === v))
              .map(({ payload, ...rest }) => ({ ...rest,
                bytes: Buffer.byteLength(String(payload || ''), 'utf8') }))
              .sort((x, y) => (x.updated_at < y.updated_at ? 1 : -1));
          }
          return json(res, 200, rows.slice(offset, offset + limit));
        }

        if (req.method === 'POST') {
          state.hits.push[t] = (state.hits.push[t] || 0) + 1;
          state.pushOrder.push(t);
          const incoming = Array.isArray(payload) ? payload : [payload];
          state.lastPush[t] = incoming;   // verbatim, before any merging

          /* PostgREST builds ONE column list for a bulk insert, so every
           * object in the array has to carry the same keys; a mixed array is
           * refused outright with PGRST102. Modelled here because the client
           * hits it naturally -- a tombstone is {id, deleted_at} and an edit
           * is a whole row -- and a mock that quietly accepted the mixture
           * would have every test pass against a request the real server
           * rejects. */
          if (incoming.length > 1) {
            const sig = (r) => Object.keys(r).sort().join(',');
            const first = sig(incoming[0]);
            if (incoming.some(r => sig(r) !== first)) {
              return json(res, 400, { code: 'PGRST102',
                message: 'All object keys must match' });
            }
          }
          const required = state.notNull[t];
          if (required) {
            for (const row of incoming) {
              const missing = required.filter(c => row[c] === undefined || row[c] === null);
              if (missing.length) {
                return json(res, 400, { code: '23502',
                  message: `null value in column "${missing[0]}" of relation "${t}" `
                           + 'violates not-null constraint' });
              }
            }
          }
          const fk = state.fk[t];
          const saved = [];
          for (const row of incoming) {
            // RLS write guard stand-in for the public tables: B may read A's
            // rows but a write against a row owned by someone else is refused.
            if (t === 'leaderboard_profiles' && row.id && row.id !== a.userId) {
              return json(res, 403, { code: '42501', message: 'RLS: not your profile' });
            }
            if (t === 'leaderboard_entries' || t === 'leaderboard_profiles') {
              // Mirrors the RESTRICTIVE policy in 0004: anonymous devices exist
              // for the relay and must not be able to publish, or the board is
              // spammable by anyone who can reach the signup endpoint.
              if (state.anonUsers.has(a.userId)) {
                return json(res, 403, { code: '42501', message: 'RLS: anonymous devices cannot publish' });
              }
            }
            if (t === 'leaderboard_entries') {
              const prior = table(t).get(row.id);
              if (prior && prior.user_id !== a.userId) {
                return json(res, 403, { code: '42501', message: 'RLS: not your entry' });
              }
            }
            // A shooter writes their OWN string and nobody else's, and only
            // while the relay is live. Mirrors relay_shots_insert_own.
            if (t === 'relay_shots') {
              const relay = state.relays.get(row.relay_id);
              const me = state.relayParts.get(row.relay_id)?.get(a.userId);
              const prior = row.id ? table(t).get(row.id) : null;
              if (!relay || relay.status !== 'live' || !me || me.role !== 'shooter'
                  || (row.user_id && row.user_id !== a.userId)
                  || (prior && prior.user_id !== a.userId)) {
                return json(res, 403, { code: '42501',
                  message: 'a shooter may only write their own string, on a live relay' });
              }
            }
            if (t === 'relay_messages') {
              const parts = state.relayParts.get(row.relay_id);
              if (!parts || !parts.has(a.userId)) {
                return json(res, 403, { code: '42501', message: 'not a participant' });
              }
            }
            /* account_backups is the one table with a size ceiling and a
             * compound unique key, and both are the point of it. A mock that
             * accepted an oversized payload would let a client ship a backup
             * button that fails only on a real phone with real data, and one
             * that ignored the unique key would let a second backup stack a
             * second eight-megabyte row where the schema allows exactly one. */
            if (t === 'account_backups') {
              if (state.anonUsers.has(a.userId)) {
                return json(res, 403, { code: '42501',
                  message: 'RLS: anonymous devices cannot back up' });
              }
              if (Buffer.byteLength(String(row.payload || ''), 'utf8') > 8388608) {
                return json(res, 400, { code: '23514',
                  message: 'new row violates check constraint "account_backups_payload_check"' });
              }
              const clash = [...table(t).values()].find(x => x.user_id === a.userId
                && x.app === row.app && x.slot === row.slot && x.id !== row.id);
              if (clash) {
                return json(res, 409, { code: '23505',
                  message: 'duplicate key value violates unique constraint '
                           + '"account_backups_user_id_app_slot_key"' });
              }
            }
            /* shots are keyed (session_id, shot_no) in the schema, not by the
             * client's uuid. A push that re-sends a string must therefore
             * UPDATE the row that already holds that number rather than
             * inserting a second one under a fresh id -- which is exactly what
             * a client that mints a new uuid per push would do, and the real
             * server would refuse with 23505 while this mock happily stacked
             * twelve more holes on the target. */
            if (t === 'shots' && row.session_id && row.shot_no != null) {
              /* (session_id, shot_no) is NOT unique any more -- see 0012. Two
               * devices on one account cannot coordinate a number offline, and
               * uniqueness let the second one to sync dead-letter itself
               * forever. A shot is identified by its id. */
              if (row.wind_call_dir != null && !['L', 'R'].includes(row.wind_call_dir)) {
                return json(res, 400, { code: '23514',
                  message: 'new row violates check constraint "shots_wind_call_dir_check"' });
              }
            }
            /* The face is a shape, not free text: {rings:[…]}. A client that
             * sends the target's NAME here, or an array, gets a 400 rather
             * than a plot that renders as nothing. */
            if (t === 'range_sessions' && row.target_face != null) {
              const f = row.target_face;
              if (typeof f !== 'object' || Array.isArray(f) || !Array.isArray(f.rings)) {
                return json(res, 400, { code: '23514',
                  message: 'new row violates check constraint "range_sessions_target_face_shape"' });
              }
            }
            if (fk && row[fk[0]]) {
              const parent = table(fk[1]).get(row[fk[0]]);
              if (!parent) {
                return json(res, 409, {
                  code: '23503',
                  message: `insert on "${t}" violates foreign key "${fk[0]}"`,
                });
              }
            }
            /* The server defaults this column; a client that has never backed
             * up before does not know an id to send. */
            if (!row.id && (t === 'account_backups' || t === 'shots')) row.id = randomUUID();
            if (!row.id && (t === 'relay_shots' || t === 'relay_messages')) {
              const key = t === 'relay_shots'
                ? [...table(t).values()].find(x => x.relay_id === row.relay_id
                    && x.user_id === a.userId
                    && x.shot_no === row.shot_no && !!x.is_sighter === !!row.is_sighter)
                : null;
              row.id = key ? key.id : randomUUID();
            }
            const existing = table(t).get(row.id) || {};
            const merged = Object.assign({}, existing, row, {
              user_id: a.userId,
              created_at: existing.created_at || stamp(),
              updated_at: stamp(),        // SERVER stamps it, always
            });
            table(t).set(row.id, merged);
            saved.push(merged);
          }
          return json(res, 201, saved);
        }
      }

      json(res, 404, { message: 'not found' });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        state,
        stop: () => new Promise(r => server.close(r)),
        advance: (ms) => { state.clock += ms; },
        seed: (t, row) => {
          const m = table(t);
          m.set(row.id, Object.assign({ created_at: stamp(), updated_at: stamp() }, row));
        },
      });
    });
  });
}
