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
          Object.assign(row, payload, { updated_at: stamp() });
          return json(res, 204, null);
        }

        if (req.method === 'GET') {
          state.hits.pull[t] = (state.hits.pull[t] || 0) + 1;
          const gt = (u.searchParams.get('updated_at') || '').replace(/^gt\./, '');
          const limit = parseInt(u.searchParams.get('limit') || '1000', 10);
          const offset = parseInt(u.searchParams.get('offset') || '0', 10);

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

          const isPublic = state.publicTables.has(t);
          let rows = [...table(t).values()]
            .filter(r => isPublic || r.user_id === a.userId)   // RLS stand-in
            .filter(r => !gt || r.updated_at > gt)
            .sort((x, y) => (x.updated_at < y.updated_at ? -1 : 1));
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
            if (fk && row[fk[0]]) {
              const parent = table(fk[1]).get(row[fk[0]]);
              if (!parent) {
                return json(res, 409, {
                  code: '23503',
                  message: `insert on "${t}" violates foreign key "${fk[0]}"`,
                });
              }
            }
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
