/* Owner support tools.
 *
 * The dashboard cannot do any of this itself. It is a static page served with
 * the publishable key, and every action here needs the SERVICE ROLE key, which
 * ignores row-level security entirely. A service key in a browser bundle is not
 * a leak waiting to happen; it is the leak, already happened, readable with
 * View Source. So the key stays here, in an environment only the server sees,
 * and the browser gets an endpoint instead.
 *
 * That makes THIS FILE the security boundary for the whole feature. Everything
 * below the authorisation block runs with unrestricted database access, so the
 * authorisation block has to be right:
 *
 *   1. the caller's token is verified BY SUPABASE, not parsed here. A JWT this
 *      function decoded itself would be a JWT an attacker could write itself:
 *      the signature is the only part that is hard to forge, and checking it
 *      means asking the issuer.
 *   2. the account must be flagged is_admin.
 *   3. the token must carry aal2 -- a second factor verified in this session,
 *      not merely enrolled on the account. Same rule the analytics read is
 *      under, and it must be checked here too: an edge function is a second
 *      front door, and a door that skips the lock the other one has is the one
 *      an attacker uses.
 *
 * verify_jwt is off at the gateway ON PURPOSE: it would reject the CORS
 * preflight, which carries no Authorization header, and browsers send that
 * before every cross-origin POST. The check it would have performed is done
 * below, against the issuer, and then twice more.
 *
 * What it deliberately cannot do: read or set a password (they are hashed, and
 * a reset link is the correct instrument anyway), return a session or token for
 * another user, or delete anything. Support means helping someone back into
 * their own account, not entering it on their behalf.
 */

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status, headers: { ...CORS, 'Content-Type': 'application/json' },
  });

/** Service-role REST call. Everything it touches ignores RLS. */
const admin = (path: string, init: RequestInit = {}) =>
  fetch(`${URL_}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE,
      Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

/* The `aal` claim is read from the token body for the LEVEL only, after
 * Supabase has already vouched for the token's authenticity above. Decoding is
 * safe once the signature has been checked by the issuer; it would be
 * worthless before. */
function aalOf(jwt: string): string {
  try {
    const p = JSON.parse(atob(jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return p.aal || 'aal1';
  } catch { return 'aal1'; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const auth = req.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return json({ error: 'not signed in' }, 401);

  // 1. Is this token real, and whose is it? Asked of the issuer.
  const who = await fetch(`${URL_}/auth/v1/user`, {
    headers: { apikey: ANON, Authorization: `Bearer ${token}` },
  });
  if (!who.ok) return json({ error: 'not signed in' }, 401);
  const actor = await who.json();

  // 2. Is that account an admin? Read under the service role, because the
  //    caller cannot be trusted to report their own privileges.
  const prof = await admin(
    `/rest/v1/profiles?id=eq.${actor.id}&select=is_admin`);
  const profRows = prof.ok ? await prof.json() : [];
  if (!profRows[0]?.is_admin) return json({ error: 'not an admin' }, 403);

  // 3. Did they clear the second factor in THIS session?
  if (aalOf(token) !== 'aal2') {
    return json({ error: 'second factor required', code: 'aal2_required' }, 403);
  }

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* handled below */ }
  const action = String(body.action || '');
  const email = String(body.email || '').trim().toLowerCase();

  const record = async (ok: boolean, subjectId: string | null, detail: unknown) => {
    await admin('/rest/v1/owner_action_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        actor_id: actor.id, action, subject_id: subjectId,
        subject_email: email || null, ok, detail: detail ?? {},
      }),
    });
  };

  if (!['list', 'lookup', 'send_reset', 'resend_confirmation'].includes(action)) {
    return json({ error: 'unknown action' }, 400);
  }

  /* The whole customer list, for the support table.
   *
   * Paged through server-side and capped, because the admin users endpoint
   * returns 50 at a time and an owner should not have to click "next" to find
   * somebody. The cap is a real limit rather than a promise: past it the table
   * says so instead of quietly showing a prefix of the truth.
   *
   * Sorted alphabetically HERE so every caller gets the same order, and
   * carrying only the columns the table shows -- no app metadata, no identity
   * provider payloads, nothing that would turn a support screen into a data
   * export. */
  if (action === 'list') {
    const MAX_PAGES = 20;              // 20 x 200 = 4000 accounts
    const users: unknown[] = [];
    let truncated = false;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const r = await admin(`/auth/v1/admin/users?page=${page}&per_page=200`);
      if (!r.ok) break;
      const batch = (await r.json()).users || [];
      users.push(...batch.map((u: Record<string, unknown>) => ({
        id: u.id,
        email: u.email,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at,
        email_confirmed: !!(u.email_confirmed_at || u.confirmed_at),
        is_anonymous: !!u.is_anonymous,
        mfa_factors: ((u.factors as { status?: string }[]) || [])
          .filter((f) => f.status === 'verified').length,
      })));
      if (batch.length < 200) break;
      if (page === MAX_PAGES) truncated = true;
    }
    /* Leaderboard handles, fetched once for the whole table rather than once
     * per row. The handle is often the only name an owner knows a customer by
     * -- a match report says "Ubermensch shot a 197", not an email address --
     * so a support table without it cannot answer "who is that". */
    const lb = await admin('/rest/v1/leaderboard_profiles?select=id,handle&limit=5000');
    const handles = new Map<string, string>();
    if (lb.ok) for (const r of await lb.json()) handles.set(r.id, r.handle);
    for (const u of users as { id: string; handle?: string | null }[]) {
      u.handle = handles.get(u.id) || null;
    }

    users.sort((a: { email?: string }, b: { email?: string }) =>
      String(a.email || '').localeCompare(String(b.email || '')));
    await record(true, null, { listed: users.length });
    return json({ users, truncated });
  }

  if (!email || !email.includes('@')) return json({ error: 'an email address is required' }, 400);

  /* Find the account. The admin users endpoint is paginated and its filter is
   * a substring match, so the exact address is re-checked here rather than
   * trusting the first row back. */
  const list = await admin(
    `/auth/v1/admin/users?page=1&per_page=20&filter=${encodeURIComponent(email)}`);
  const users = list.ok ? ((await list.json()).users || []) : [];
  const user = users.find((u: { email?: string }) =>
    (u.email || '').toLowerCase() === email) || null;

  if (action === 'lookup') {
    if (!user) {
      await record(true, null, { found: false });
      return json({ found: false });
    }
    /* Counts, not contents. Whether somebody has been using the apps is what a
     * support question needs; what they logged is theirs. */
    const ev = await admin(
      `/rest/v1/analytics_event?user_id=eq.${user.id}&select=source_app&limit=1000`);
    const evRows = ev.ok ? await ev.json() : [];
    const perApp: Record<string, number> = {};
    for (const r of evRows) perApp[r.source_app] = (perApp[r.source_app] || 0) + 1;

    const factors = (user.factors || []).filter(
      (f: { status?: string }) => f.status === 'verified').length;

    /* One row at most: the table is keyed by the user id, and the handle is
     * case-insensitively unique across the project. */
    const lb = await admin(
      `/rest/v1/leaderboard_profiles?id=eq.${user.id}&select=handle`);
    const lbRows = lb.ok ? await lb.json() : [];

    await record(true, user.id, { found: true });
    return json({
      found: true,
      user: {
        id: user.id,
        email: user.email,
        created_at: user.created_at,
        last_sign_in_at: user.last_sign_in_at,
        // The question behind "my link never arrived" is almost always this one.
        email_confirmed: !!(user.email_confirmed_at || user.confirmed_at),
        is_anonymous: !!user.is_anonymous,
        providers: (user.app_metadata?.providers) || [],
        mfa_factors: factors,
        handle: lbRows[0]?.handle || null,
        recent_events: evRows.length,
        events_by_app: perApp,
      },
    });
  }

  // Both remaining actions send mail to a real person, so a missing account is
  // an error rather than a silent success.
  if (!user) {
    await record(false, null, { found: false });
    return json({ error: 'no account with that email address' }, 404);
  }

  if (action === 'send_reset') {
    /* GoTrue's own recovery flow, so the link, its expiry and its one-time use
     * are the ones Supabase maintains. Sent with the ANON key deliberately:
     * this is the same request the app's own "forgot password" makes, and
     * routing it through the service role would only bypass the rate limits
     * that exist to stop this endpoint being used to mailbomb somebody. */
    const r = await fetch(`${URL_}/auth/v1/recover`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const ok = r.ok;
    await record(ok, user.id, { status: r.status });
    return ok ? json({ sent: true })
              : json({ error: 'Supabase refused to send it — check that email is configured, '
                            + 'and that this address has not been sent one in the last minute.',
                       status: r.status }, 502);
  }

  if (action === 'resend_confirmation') {
    const r = await fetch(`${URL_}/auth/v1/resend`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'signup', email }),
    });
    const ok = r.ok;
    await record(ok, user.id, { status: r.status });
    return ok ? json({ sent: true })
              : json({ error: 'Supabase refused to send it.', status: r.status }, 502);
  }

  return json({ error: 'unknown action' }, 400);
});
