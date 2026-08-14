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
    hits: { refresh: 0, signin: 0, push: {}, pull: {} },
    failRefresh: false,
    ttlSec: opts.ttlSec ?? 3600,
    pushOrder: [],               // tables in the order they were pushed to
    lastPush: {},                // table -> the exact payload the client sent
    // tables whose rows must reference an existing parent row
    fk: { shots: ['session_id', 'range_sessions'],
          groups: ['session_id', 'range_sessions'],
          batches: ['recipe_id', 'recipes'] },
    // RLS `using (true)` stand-in: reads cross user boundaries here
    publicTables: new Set(['leaderboard_profiles', 'leaderboard_entries', 'v_leaderboard']),
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

  function issue(userId, email) {
    const access = 'at_' + randomUUID();
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

      /* ------------------------------------------------------------ rest */
      if (p.startsWith('/rest/v1/')) {
        const t = p.slice('/rest/v1/'.length);
        const a = auth(req);
        if (!a || a.expired) return json(res, 401, { message: 'JWT expired' });

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
          const fk = state.fk[t];
          const saved = [];
          for (const row of incoming) {
            // RLS write guard stand-in for the public tables: B may read A's
            // rows but a write against a row owned by someone else is refused.
            if (t === 'leaderboard_profiles' && row.id && row.id !== a.userId) {
              return json(res, 403, { code: '42501', message: 'RLS: not your profile' });
            }
            if (t === 'leaderboard_entries') {
              const prior = table(t).get(row.id);
              if (prior && prior.user_id !== a.userId) {
                return json(res, 403, { code: '42501', message: 'RLS: not your entry' });
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
