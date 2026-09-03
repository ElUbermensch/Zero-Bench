/* Owner dashboard for Zero and Bench.
 *
 * Read-only, and deliberately the thinnest thing that answers the question. It
 * signs in with the same zero-core both apps carry, asks the server whether
 * this account is an admin, and then reads four rollup views. It never writes.
 *
 * Two decisions worth stating out loud:
 *
 * 1. `telemetry: false`. This app must not appear in its own numbers. An owner
 *    checking the dashboard every morning would otherwise show up as the most
 *    engaged user of a product they are not using.
 *
 * 2. The is_admin() call is a COURTESY, not the boundary. RLS on
 *    analytics_event is what actually decides -- a non-admin who skips this
 *    page and calls the REST API directly gets an empty array, because there is
 *    no select policy that would give them a row. What the check buys is an
 *    honest screen instead of a dashboard full of zeroes.
 */
const CORE = (() => {
  try {
    if (!SHARED_SUPABASE?.url || !SHARED_SUPABASE?.anonKey) return null;
    return ZeroCore.create({
      url: SHARED_SUPABASE.url, anonKey: SHARED_SUPABASE.anonKey,
      appId: 'admin',
      /* Also keeps source_app honest: the column is CHECKed to ('bench','zero')
       * and this app is neither. */
      telemetry: false,
      autoSyncMs: 0,
    });
  } catch (e) { return null; }
})();

const APPS = ['bench', 'zero'];
const COLOR = { bench: 'var(--bench)', zero: 'var(--zero)' };
const LABEL = { bench: 'Bench', zero: 'Zero' };

const UI = { range: 30, tab: 'apps', view: 'loading', error: null, data: null, busy: false,
             mfa: null };   // { factorId, qr, secret, uri, challengeId, fresh }

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString());

/* Days are the SERVER's dates (UTC), which is what the views group on. Shown
 * as given rather than shifted into the reader's zone: a dashboard that
 * silently re-buckets is a dashboard whose totals stop adding up. */
const isoDay = (d) => d.toISOString().slice(0, 10);
const dayList = (n) => {
  const out = [];
  const end = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(isoDay(d));
  }
  return out;
};
const shortDay = (iso) => iso.slice(5).replace('-', '/');

/* Durations as h/m/s rather than a raw second count.
 *
 * "4920s" is a number the reader has to do arithmetic on before it means
 * anything; "1h 22m" is the same fact already understood. Seconds are kept at
 * the small end, where they are the honest unit -- a 45-second visit is a
 * 45-second visit, not "0h 0m 45s" -- and dropped at the large end, where a
 * trailing seconds figure on an hour-long average is false precision over an
 * estimate. Two units at most, always the two that carry the magnitude. */
function hms(totalSeconds) {
  const s = Math.max(0, Math.round(+totalSeconds || 0));
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return sec > 0 ? `${m}m ${sec}s` : `${m}m`;
}

/* ------------------------------------------------------------------ loading */
async function load() {
  const from = dayList(UI.range)[0];
  const q = (extra) => `select=*&day=gte.${from}&order=day.asc${extra || ''}`;
  /* The customer list comes from the edge function, not a view: auth.users is
   * not exposed through PostgREST, and should not be. */
  if (UI.tab === 'support') {
    const r = await ownerTool('list', '');
    if (!r.ok) throw new Error(r.code === 'aal2_required'
      ? 'This needs a second factor verified in this session — sign out and back in.'
      : r.error);
    return { customers: r.data.users || [], truncated: !!r.data.truncated };
  }
  const views = UI.tab === 'site' ? {
    /* The marketing site's own tables. Loaded only when that tab is open: an
     * owner watching app usage should not pay for four extra reads a minute
     * on a page they are not looking at. */
    siteDaily: 'v_site_daily',
    siteSources: 'v_site_sources',
    sitePages: 'v_site_pages',
    siteDevices: 'v_site_devices',
  } : {
    active: 'v_analytics_daily_active',
    signups: 'v_analytics_new_users',
    events: 'v_analytics_events_by_name',
    visits: 'v_analytics_visits',
  };
  const out = {};
  for (const [key, view] of Object.entries(views)) {
    const res = await CORE.selectView(view, q());
    /* A 404 here means the migrations have not been applied, which is a
     * different problem from "no data yet" and must not be reported as an
     * empty dashboard. */
    if (!res.ok) {
      const st = res.status;
      throw new Error(st === 404
        ? `The view ${view} does not exist — apply migration ${view.startsWith('v_site') ? '0019' : '0015 and 0016'} to the Supabase project first.`
        : `Could not read ${view}${st ? ` (HTTP ${st})` : ''}.`);
    }
    out[key] = res.data || [];
  }
  return out;
}

/* --------------------------------------------------------------- SVG charts */
/* Hand-rolled, for the same reason the rest of the suite is: no CDN, no chart
 * library, nothing that has to keep working in five years but its own code. */

const W = 760, PADL = 44, PADR = 58, PADT = 12;

const axisText = (x, y, s, anchor, cls) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor || 'middle'}" font-size="10"
     font-family="var(--fm)" fill="${cls || 'var(--ink3)'}">${esc(s)}</text>`;

/* Round ticks, so the gridlines land on numbers a person would choose. */
function niceMax(v) {
  if (v <= 4) return Math.max(1, Math.ceil(v));
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  return Math.ceil(v / (pow / 2)) * (pow / 2);
}

/**
 * Multi-series line chart with a crosshair. One y-axis, always: two measures of
 * different scale get two charts, never a second axis.
 */
function lineChart(days, series, opts) {
  const H = (opts && opts.height) || 210;
  const max = niceMax(Math.max(1, ...series.flatMap(s => s.values.filter(v => v != null))));
  const plotW = W - PADL - PADR, plotH = H - PADT - 26;
  const x = (i) => PADL + (days.length === 1 ? plotW / 2 : (i / (days.length - 1)) * plotW);
  const y = (v) => PADT + plotH - (v / max) * plotH;

  let g = '';
  for (let t = 0; t <= 4; t++) {
    const v = (max / 4) * t, yy = y(v);
    g += `<line x1="${PADL}" x2="${PADL + plotW}" y1="${yy}" y2="${yy}"
            stroke="var(--line)" stroke-width="1" opacity="${t ? .5 : 1}"/>`;
    /* The axis speaks the series' own unit. A duration chart labelled 900,
     * 1800, 2700 asks the reader to divide by sixty on every gridline. */
    g += axisText(PADL - 8, yy + 3, (opts && opts.fmt) ? opts.fmt(v) : Math.round(v), 'end');
  }

  // Selective date labels: never one per point.
  const step = Math.max(1, Math.ceil(days.length / 6));
  for (let i = 0; i < days.length; i += step) {
    g += axisText(x(i), H - 8, shortDay(days[i]));
  }

  let marks = '';
  for (const s of series) {
    const pts = s.values.map((v, i) => (v == null ? null : [x(i), y(v)])).filter(Boolean);
    if (!pts.length) continue;
    marks += `<polyline fill="none" stroke="${s.color}" stroke-width="2"
                stroke-linejoin="round" stroke-linecap="round"
                points="${pts.map(p => p.join(',')).join(' ')}"/>`;
    // A single point has no line to be, so it needs a mark of its own.
    if (pts.length === 1) {
      marks += `<circle cx="${pts[0][0]}" cy="${pts[0][1]}" r="4" fill="${s.color}"/>`;
    }
    /* Direct label at the series end. With two series this is what makes
     * identity survive a colourblind reader, a greyscale print, and forced
     * colours -- the legend alone would not. */
    const last = pts[pts.length - 1];
    marks += `<text x="${last[0] + 8}" y="${last[1] + 4}" font-size="11"
                font-family="var(--fh)" fill="var(--ink2)">${esc(s.label)}</text>`;
  }

  /* One transparent column per day, so the hit target is the whole column
   * rather than a 2px line. */
  let hit = '';
  const colW = days.length > 1 ? plotW / (days.length - 1) : plotW;
  days.forEach((d, i) => {
    const unit = (opts && opts.fmt) || fmt;
    const vals = series.map(s => `${s.label} ${s.values[i] == null ? '—' : unit(s.values[i])}`)
      .join('  ·  ');
    hit += `<rect x="${x(i) - colW / 2}" y="${PADT}" width="${colW}" height="${plotH}"
              fill="transparent" data-tip="${esc(d + '  —  ' + vals)}"
              data-x="${x(i)}"/>`;
  });

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" role="img">
    <g>${g}</g><g>${marks}</g>
    <line class="cross" x1="0" x2="0" y1="${PADT}" y2="${PADT + plotH}"
      stroke="var(--ink3)" stroke-width="1" opacity="0"/>
    <g>${hit}</g></svg>`;
}

/** Grouped bars: one group per day, one bar per app. */
function barChart(days, series, opts) {
  const H = (opts && opts.height) || 190;
  const max = niceMax(Math.max(1, ...series.flatMap(s => s.values)));
  const plotW = W - PADL - PADR, plotH = H - PADT - 26;
  const groupW = plotW / days.length;
  // 2px of surface between adjacent bars, so two fills never touch.
  const barW = Math.max(2, (groupW - 6) / series.length - 2);

  let g = '';
  for (let t = 0; t <= 4; t++) {
    const v = (max / 4) * t, yy = PADT + plotH - (v / max) * plotH;
    g += `<line x1="${PADL}" x2="${PADL + plotW}" y1="${yy}" y2="${yy}"
            stroke="var(--line)" stroke-width="1" opacity="${t ? .5 : 1}"/>`;
    g += axisText(PADL - 8, yy + 3, Math.round(v), 'end');
  }
  const step = Math.max(1, Math.ceil(days.length / 6));
  for (let i = 0; i < days.length; i += step) {
    g += axisText(PADL + groupW * (i + .5), H - 8, shortDay(days[i]));
  }

  let marks = '';
  days.forEach((d, i) => {
    series.forEach((s, k) => {
      const v = s.values[i] || 0;
      if (!v) return;
      const h = (v / max) * plotH;
      const bx = PADL + groupW * i + 3 + k * (barW + 2);
      /* 4px rounded ends on the DATA end only; the baseline end stays square,
       * because a bar that is rounded where it meets the axis reads as
       * floating. */
      const r = Math.min(4, h);
      marks += `<path d="M${bx} ${PADT + plotH}
                  V${PADT + plotH - h + r}
                  q0 ${-r} ${r} ${-r}
                  h${barW - 2 * r}
                  q${r} 0 ${r} ${r}
                  V${PADT + plotH} Z"
                fill="${s.color}"
                data-tip="${esc(`${d}  —  ${s.label} ${fmt(v)}`)}"/>`;
    });
  });

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" role="img">
    <g>${g}</g><g>${marks}</g></svg>`;
}

/** Horizontal bars for a ranked list. One measure, one hue. */
function rankChart(rows, opts) {
  const rowH = 26, H = Math.max(40, rows.length * rowH + 8);
  const labelW = (opts && opts.labelW) || 190;
  const plotW = W - labelW - 70;
  const max = Math.max(1, ...rows.map(r => r.value));
  let out = '';
  rows.forEach((r, i) => {
    const y = i * rowH + 4;
    const w = Math.max(2, (r.value / max) * plotW);
    const rr = Math.min(4, w);
    out += `<text x="${labelW - 10}" y="${y + 14}" text-anchor="end" font-size="12"
              font-family="var(--fh)" fill="var(--ink2)">${esc(r.label)}</text>`;
    out += `<path d="M${labelW} ${y + 3}
              h${w - rr} q${rr} 0 ${rr} ${rr}
              v${12 - 2 * rr} q0 ${rr} ${-rr} ${rr}
              h${-(w - rr)} Z"
            fill="${r.color || 'var(--zero)'}"
            data-tip="${esc(`${r.label} — ${fmt(r.value)}${r.sub ? '  ·  ' + r.sub : ''}`)}"/>`;
    out += `<text x="${labelW + w + 8}" y="${y + 14}" font-size="11"
              font-family="var(--fm)" fill="var(--ink3)">${fmt(r.value)}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" role="img">${out}</svg>`;
}

/* ------------------------------------------------------------------ shaping */
/* One row per (app, day) becomes one series per app over a dense day axis, so a
 * day with no activity is a zero in the line rather than a gap the eye reads as
 * a straight run between the days either side of it. */
function seriesFor(rows, days, field) {
  return APPS.map(app => {
    const byDay = new Map(rows.filter(r => r.source_app === app).map(r => [r.day, +r[field] || 0]));
    return { key: app, label: LABEL[app], color: COLOR[app],
             values: days.map(d => byDay.get(d) || 0) };
  });
}
const sum = (rows, field, app) => rows
  .filter(r => !app || r.source_app === app)
  .reduce((a, r) => a + (+r[field] || 0), 0);


/* ------------------------------------------------------- the customers tab */
/*
 * Every account, alphabetically, filtered as you type.
 *
 * A table rather than a search box alone, because the two support questions
 * need different things. "Here is my email, I cannot get in" is a lookup; but
 * "how many people have never confirmed" and "who signed up last week and never
 * came back" are questions you can only ask of a list you can see. The filter
 * matches on the address as typed, so a half-remembered domain still finds
 * somebody.
 *
 * Filtering happens in the browser, over a list already fetched. That is the
 * right trade at this size -- a few thousand rows is nothing to hold, and it
 * means typing does not put a request on the wire per keystroke against an
 * endpoint that holds the service key.
 *
 * Confirmation state leads, after the address, because an unconfirmed account
 * is the single most common cause of "it will not let me in" and the one thing
 * on this screen that has a one-click fix.
 */
function supportTab() {
  const d = UI.data || {};
  const all = d.customers || [];
  const s = UI.support || {};
  const q = (s.filter || '').trim().toLowerCase();
  /* The filter matches the handle as well as the address, because the name a
   * customer is known by in a match report is the handle, and "who is
   * Ubermensch" is the question a support screen has to be able to answer. */
  const rows = (q ? all.filter(u =>
    (u.email || '').toLowerCase().includes(q) ||
    (u.handle || '').toLowerCase().includes(q)) : all.slice())
    /* Sorted here as well as in the function. The order is a promise this
     * screen makes to the reader, so it should not depend on an endpoint
     * continuing to keep it. Guests have no address and sort last, where they
     * do not interrupt a run of names. */
    .sort((a, b) => String(a.email || '￿').localeCompare(String(b.email || '￿')));

  const unconfirmed = all.filter(u => !u.email_confirmed && !u.is_anonymous).length;
  const anon = all.filter(u => u.is_anonymous).length;
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString() : '—');

  return `
  <main>
    <section>
      <h2>Customers</h2>
      <p class="note">Every account on the project, alphabetically. Anonymous entries are
        pair-fire guests, not sign-ups — they have no address and nothing to reset.</p>
      <div class="tiles">
        ${tile('Accounts', fmt(all.length - anon), 'real sign-ups')}
        ${tile('Never confirmed', fmt(unconfirmed),
               unconfirmed ? 'usually the reason someone cannot get in' : 'all confirmed')}
        ${tile('Guests', fmt(anon), 'anonymous pair-fire devices')}
      </div>
      ${d.truncated ? `<div class="banner warn">More accounts exist than this screen
        loads. Everything below is the first few thousand by address.</div>` : ''}
    </section>

    <section>
      <div class="card">
        <form id="cfilter" class="support" onsubmit="return false">
          <input id="cfilter-q" type="search" placeholder="Filter by email or handle…"
                 value="${esc(s.filter || '')}" autocomplete="off" spellcheck="false">
          ${q ? `<button type="button" data-act="clearfilter">Clear</button>` : ''}
        </form>
        ${s.error ? `<div class="banner bad">${esc(s.error)}</div>` : ''}
        ${s.notice ? `<div class="banner ok">${esc(s.notice)}</div>` : ''}
        <p class="note">${q ? `${fmt(rows.length)} of ${fmt(all.length)} shown`
                            : `${fmt(all.length)} accounts`}</p>
        <div class="scroll"><table>
          <thead><tr>
            <th>Email</th><th>Handle</th><th>Confirmed</th><th>Joined</th>
            <th>Last seen</th><th>2FA</th><th></th>
          </tr></thead>
          <tbody>${rows.length ? rows.map(u => `<tr>
            <td>${u.is_anonymous ? '<span class="chip">guest</span>' : esc(u.email || '—')}</td>
            <td>${u.handle ? esc(u.handle)
                 : '<span style="color:var(--ink3)">—</span>'}</td>
            <td>${u.is_anonymous ? '—'
                 : (u.email_confirmed ? 'yes'
                    : '<span class="chip" style="color:var(--warn)">no</span>')}</td>
            <td>${esc(when(u.created_at))}</td>
            <td>${esc(when(u.last_sign_in_at))}</td>
            <td>${u.mfa_factors ? 'yes' : '—'}</td>
            <td>${u.is_anonymous ? ''
                 : `<button data-pick="${esc(u.email || '')}">Open</button>`}</td>
          </tr>`).join('')
            : `<tr><td colspan="7" class="empty">${q ? 'No account matches that.'
                                                     : 'No accounts yet.'}</td></tr>`}
          </tbody></table></div>
      </div>
    </section>

    ${s.result ? supportDetail(s.result) : ''}
  </main>`;
}

/* The detail for one customer, opened from the table. Kept separate from the
 * list so the list stays scannable: a table with seven columns of detail per
 * row is one nobody reads. */
function supportDetail(u) {
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : 'never');
  const s = UI.support || {};
  return `
    <section>
      <h2>${esc(u.email || '')}</h2>
      <p class="note">Every action here is written to <code>owner_action_log</code>.</p>
      <div class="card">
        <table class="kv">
          <tr><th>Confirmed</th><td>${u.email_confirmed
            ? 'yes' : '<strong>no — this is usually the whole problem</strong>'}</td></tr>
          <tr><th>Account created</th><td>${esc(when(u.created_at))}</td></tr>
          <tr><th>Last signed in</th><td>${esc(when(u.last_sign_in_at))}</td></tr>
          <tr><th>Leaderboard handle</th><td>${u.handle
            ? esc(u.handle) : 'has not published a score'}</td></tr>
          <tr><th>Second factor</th><td>${u.mfa_factors
            ? `${u.mfa_factors} verified` : 'none'}</td></tr>
          <tr><th>Sign-in method</th><td>${esc((u.providers || []).join(', ') || 'email')}</td></tr>
          <tr><th>Recent activity</th><td>${u.recent_events
            ? `${fmt(u.recent_events)} events — ${Object.entries(u.events_by_app || {})
                .map(([a, n]) => `${LABEL[a] || a} ${fmt(n)}`).join(', ')}`
            : 'nothing recorded'}</td></tr>
        </table>
        <div class="support-actions">
          <button data-mail="send_reset" ${s.busy ? 'disabled' : ''}>Send password reset</button>
          ${u.email_confirmed ? ''
            : `<button data-mail="resend_confirmation" ${s.busy ? 'disabled' : ''}>Resend confirmation</button>`}
        </div>
        <p class="note">Both send mail to the customer, and both are rate-limited by
          Supabase — roughly one a minute per address.</p>
      </div>
    </section>`;
}

/* "Last 1 days" is the kind of thing that makes a reader doubt the numbers
 * underneath it. */
function rangeTitle() {
  const n = UI.range;
  if (n === 1) return 'Last 24 hours';
  if (n === 365) return 'Last year';
  if (n % 30 === 0 && n >= 60) return `Last ${n / 30} months`;
  return `Last ${n} days`;
}

/* ----------------------------------------------------------------- rendering */
function tile(k, v, s) {
  return `<div class="tile"><div class="k">${esc(k)}</div>
    <div class="v">${v}</div>${s ? `<div class="s">${esc(s)}</div>` : ''}</div>`;
}

function legend() {
  return `<div class="legend">${APPS.map(a =>
    `<span><i style="background:${COLOR[a]}"></i>${LABEL[a]}</span>`).join('')}</div>`;
}

function dashboard(d) {
  const days = dayList(UI.range);
  const active = seriesFor(d.active, days, 'active_users');
  const visits = seriesFor(d.visits, days, 'visits');
  const signups = seriesFor(d.signups, days, 'new_users');
  /* Null, not zero, on a day when no visit reported a close. Zero would draw a
   * line down to the axis and read as "visits were instant that day", which is
   * a measurement nobody took. lineChart skips nulls. */
  const durSeries = APPS.map(app => {
    const byDay = new Map(d.visits.filter(r => r.source_app === app && +r.visits_with_duration > 0)
      .map(r => [r.day, +r.avg_duration_s || 0]));
    return { key: app, label: LABEL[app], color: COLOR[app],
             values: days.map(dd => (byDay.has(dd) ? byDay.get(dd) : null)) };
  });

  /* Distinct people cannot be summed across days -- the same shooter on
   * Monday and Tuesday is one user, and adding the columns would report two.
   * The honest headline from a per-day rollup is the peak day, and it says so
   * on the tile rather than being labelled "users" and quietly meaning
   * something else. */
  const peakActive = Math.max(0, ...active.flatMap(s => s.values));
  const totalVisits = sum(d.visits, 'visits');
  const totalSignups = sum(d.signups, 'new_users');
  const totalEvents = sum(d.active, 'events');

  const withDur = d.visits.filter(r => +r.visits_with_duration > 0);
  const durNote = withDur.length
    ? `${Math.round(100 * sum(d.visits, 'visits_with_duration') / Math.max(1, totalVisits))}% of visits reported one`
    : 'no visit reported one yet';
  const avgDur = withDur.length
    ? (withDur.reduce((a, r) => a + (+r.avg_duration_s || 0), 0) / withDur.length)
    : null;

  // Feature usage: everything that is not the automatic auth/lifecycle spine.
  const SPINE = new Set(['app_open', 'app_background', 'sign_in', 'sign_up',
                         'sign_out', 'sign_in_anonymous']);
  const byName = new Map();
  for (const r of d.events) {
    const key = r.source_app + ' ' + r.event_name;
    const cur = byName.get(key) || { app: r.source_app, name: r.event_name, count: 0, users: 0 };
    cur.count += +r.event_count || 0;
    cur.users = Math.max(cur.users, +r.user_count || 0);
    byName.set(key, cur);
  }
  const all = [...byName.values()].sort((a, b) => b.count - a.count);
  const features = all.filter(r => !SPINE.has(r.name)).slice(0, 20);

  const empty = !d.active.length;

  return `
  <main>
    ${empty ? `<div class="banner warn">No events in ${rangeTitle().toLowerCase()}.
      If the apps have just been rebuilt, this fills in as people use them —
      a visit is recorded on the first sign-in, not on a signed-out page load.</div>` : ''}

    <section>
      <h2>${rangeTitle()}</h2>
      <p class="note">Days are UTC, the axis the database groups on.</p>
      <div class="tiles">
        ${tile('Visits', fmt(totalVisits), 'app opens, both apps')}
        ${tile('Busiest day', fmt(peakActive), 'people active — daily counts cannot be summed')}
        ${tile('New sign-ups', fmt(totalSignups), 'accounts created')}
        ${tile('Events recorded', fmt(totalEvents), 'every tracked action')}
        ${tile('Typical visit', avgDur == null ? '—' : hms(avgDur), durNote)}
      </div>
    </section>

    <section>
      <h2>People per day</h2>
      <p class="note">Distinct accounts that did anything at all, per app.</p>
      <div class="card">${legend()}<div class="scroll">${lineChart(days, active)}</div></div>
    </section>

    <section>
      <h2>Visits per day</h2>
      <p class="note">One visit is one app open. This is the reliable traffic number —
        visit <em>duration</em> is not, because a phone browser may kill a backgrounded
        tab without running anything.</p>
      <div class="card">${legend()}<div class="scroll">${lineChart(days, visits)}</div></div>
    </section>

    <section>
      <h2>New sign-ups</h2>
      <p class="note">Counted on the sign-up itself. An account created while email
        confirmation is pending is counted when it first signs in.</p>
      <div class="card">${legend()}<div class="scroll">${barChart(days, signups)}</div></div>
    </section>

    <section>
      <h2>How long a visit lasts</h2>
      <p class="note">Averaged over the visits that reported a close, per day. Mobile
        browsers routinely kill a backgrounded tab without running anything, so this is an
        estimate over a self-selected sample — the visit COUNT above is the reliable one.</p>
      <div class="card">${legend()}<div class="scroll">${lineChart(days, durSeries, { fmt: hms })}</div></div>
    </section>

    <section>
      <h2>What people actually do</h2>
      <p class="note">Feature actions only — sign-ins and app opens are the spine and are
        reported above.</p>
      <div class="card">${features.length
        ? `<div class="scroll">${rankChart(features.map(r => ({
            label: `${LABEL[r.app]} · ${r.name.replace(/_/g, ' ')}`,
            value: r.count, color: COLOR[r.app],
            sub: `${fmt(r.users)} ${r.users === 1 ? 'person' : 'people'}`,
          })))}</div>`
        : '<div class="empty">Nothing tracked yet.</div>'}</div>
    </section>

    <section>
      <h2>Every event</h2>
      <p class="note">The whole table, spine included, so a number above can always be
        traced to what produced it.</p>
      <div class="card"><div class="scroll"><table>
        <thead><tr><th>App</th><th>Event</th><th class="n">Count</th>
          <th class="n">People (peak day)</th></tr></thead>
        <tbody>${all.length ? all.map(r => `<tr>
          <td><span class="chip" style="color:${COLOR[r.app]}">${LABEL[r.app]}</span></td>
          <td>${esc(r.name)}</td>
          <td class="n">${fmt(r.count)}</td>
          <td class="n">${fmt(r.users)}</td></tr>`).join('')
          : '<tr><td colspan="4" class="empty">Nothing tracked yet.</td></tr>'}
        </tbody></table></div></div>
    </section>
  </main>`;
}

/* Says when the numbers were last read, because a dashboard that refreshes
 * itself is indistinguishable from one that has quietly stopped. A failed
 * refresh keeps the old figures and labels them, rather than blanking the page
 * or -- worse -- leaving a stale number looking current. */
function freshness() {
  if (UI.view !== 'ready') return '';
  if (UI.refreshing) return `<span class="fresh">updating…</span>`;
  if (UI.staleError) {
    return `<span class="fresh stale" title="${esc(UI.staleError)}">could not refresh — showing the last good read</span>`;
  }
  if (!UI.lastLoaded) return '';
  const secs = Math.round((Date.now() - UI.lastLoaded) / 1000);
  const ago = secs < 10 ? 'just now'
            : secs < 90 ? `${secs}s ago`
            : `${Math.round(secs / 60)}m ago`;
  return `<span class="fresh">updated ${ago}</span>`;
}


/* ---------------------------------------------------- the marketing website */
/*
 * A separate screen, because it answers a separate question. The app tabs ask
 * "are people using this"; this one asks "did what we did on Thursday bring
 * anybody" -- and the two must not be added together, since a stranger reading
 * a page and a shooter logging a string are not comparable events.
 *
 * Built around ATTRIBUTION rather than volume. A total pageview count tells you
 * almost nothing you can act on; the same number broken down by the campaign
 * tag on the link tells you which post to write again. So the source table is
 * the centre of this screen and everything else is context around it.
 *
 * These rows are written by anonymous visitors using a key printed in the page,
 * which is said on screen rather than only in the migration: a number a
 * stranger can inflate should not be presented with the same confidence as one
 * behind an auth check.
 */
function siteDashboard(d) {
  const days = dayList(UI.range);

  const daily = d.siteDaily || [];
  const byDay = new Map(daily.map(r => [r.day, r]));
  const visitSeries = [{ key: 'site', label: 'Visits', color: 'var(--zero)',
    values: days.map(x => (byDay.get(x) ? +byDay.get(x).visits || 0 : 0)) }];
  const viewSeries = [{ key: 'site', label: 'Pageviews', color: 'var(--bench)',
    values: days.map(x => (byDay.get(x) ? +byDay.get(x).pageviews || 0 : 0)) }];

  const totalVisits = sum(daily, 'visits');
  const totalViews = sum(daily, 'pageviews');
  const perVisit = totalVisits ? (totalViews / totalVisits) : 0;
  const busiest = daily.reduce((a, r) => (+r.visits > (a ? +a.visits : -1) ? r : a), null);

  // Sources, campaigns first: the tagged ones are the ones you chose to run.
  const srcMap = new Map();
  for (const r of (d.siteSources || [])) {
    const cur = srcMap.get(r.source) || { source: r.source, medium: r.medium, visits: 0 };
    cur.visits += +r.visits || 0;
    srcMap.set(r.source, cur);
  }
  const sources = [...srcMap.values()].sort((a, b) => b.visits - a.visits);
  const campaigns = sources.filter(r => r.source !== 'direct');

  const pageMap = new Map();
  for (const r of (d.sitePages || [])) {
    const cur = pageMap.get(r.path) || { path: r.path, views: 0, visits: 0 };
    cur.views += +r.views || 0; cur.visits += +r.visits || 0;
    pageMap.set(r.path, cur);
  }
  const pages = [...pageMap.values()].sort((a, b) => b.views - a.views).slice(0, 15);

  const devMap = new Map();
  for (const r of (d.siteDevices || [])) {
    devMap.set(r.device, (devMap.get(r.device) || 0) + (+r.visits || 0));
  }
  const devices = [...devMap.entries()].sort((a, b) => b[1] - a[1]);

  const empty = !daily.length;

  return `
  <main>
    ${empty ? `<div class="banner warn">No website traffic recorded in ${rangeTitle().toLowerCase()}.
      If the site has only just been rebuilt, this fills in as people visit —
      and visitors who send Do Not Track are never counted.</div>` : ''}

    <section>
      <h2>${rangeTitle()} — the information site</h2>
      <p class="note">Anonymous pageviews. No IP, no cookie, no fingerprint: a visit id
        lives in the tab and dies with it, so the same person tomorrow is a new visit.
        <strong>These rows are written by the public</strong> using the key printed in the
        page, so treat a sudden spike as a claim rather than a fact until a source
        explains it.</p>
      <div class="tiles">
        ${tile('Visits', fmt(totalVisits), 'separate tabs, not people')}
        ${tile('Pageviews', fmt(totalViews), 'pages read')}
        ${tile('Pages per visit', totalVisits ? perVisit.toFixed(1) : '—',
               'how far past the first page they got')}
        ${tile('Busiest day', busiest ? fmt(busiest.visits) : '—',
               busiest ? busiest.day : 'nothing yet')}
        ${tile('Tagged arrivals', fmt(sum(campaigns, 'visits')),
               'came from a campaign or a referrer')}
      </div>
    </section>

    <section>
      <h2>Visits per day</h2>
      <p class="note">The line to watch on the day of a post, a video, or a range-day
        handout. A campaign that worked shows up here within hours.</p>
      <div class="card"><div class="scroll">${lineChart(days, visitSeries)}</div></div>
    </section>

    <section>
      <h2>Where they came from</h2>
      <p class="note">Attributed once per visit, from the FIRST page — the tag is only on
        the link that was clicked, so counting every page would credit the campaign once
        and “direct” four times for the same person. Add
        <code>?utm_campaign=spring-match</code> to a link to make it appear here by name.</p>
      <div class="card">${sources.length
        ? `<div class="scroll">${rankChart(sources.slice(0, 15).map(r => ({
            label: r.source === 'direct' ? 'direct / untagged' : r.source,
            value: r.visits,
            color: r.source === 'direct' ? 'var(--ink3)' : 'var(--zero)',
            sub: r.medium || '',
          })))}</div>`
        : '<div class="empty">Nothing yet.</div>'}</div>
    </section>

    <section>
      <h2>Pageviews per day</h2>
      <div class="card"><div class="scroll">${barChart(days, viewSeries)}</div></div>
    </section>

    <section>
      <h2>What they read</h2>
      <div class="card"><div class="scroll"><table>
        <thead><tr><th>Page</th><th class="n">Views</th><th class="n">Visits</th></tr></thead>
        <tbody>${pages.length ? pages.map(r => `<tr>
          <td>${esc(r.path)}</td>
          <td class="n">${fmt(r.views)}</td>
          <td class="n">${fmt(r.visits)}</td></tr>`).join('')
          : '<tr><td colspan="3" class="empty">Nothing yet.</td></tr>'}
        </tbody></table></div></div>
    </section>

    <section>
      <h2>What they read it on</h2>
      <p class="note">A page that converts on a desktop and not on a phone has a layout
        problem, not a copy problem.</p>
      <div class="card">${devices.length
        ? `<div class="scroll">${rankChart(devices.map(([k, v]) => ({
            label: k, value: v, color: 'var(--bench)', sub: '' })))}</div>`
        : '<div class="empty">Nothing yet.</div>'}</div>
    </section>
  </main>`;
}

function header() {
  const u = CORE && CORE.getUser();
  return `<header>
    <h1>Zero Suite</h1>
    <span class="sub">owner dashboard</span>
    <span class="spacer"></span>
    <span class="tabs">
      <button data-tab="apps" aria-pressed="${UI.tab === 'apps'}">Apps</button>
      <button data-tab="site" aria-pressed="${UI.tab === 'site'}">Website</button>
      <button data-tab="support" aria-pressed="${UI.tab === 'support'}">Customers</button>
    </span>
    ${UI.tab === 'support' ? '' : `<span class="range">
      ${RANGES.map(([n, label]) => `<button data-range="${n}"
        aria-pressed="${UI.range === n}">${label}</button>`).join('')}
    </span>`}
    ${freshness()}
    <button data-act="refresh">${UI.busy || UI.refreshing ? 'Loading…' : 'Refresh'}</button>
    ${u ? `<button data-act="signout">Sign out</button>` : ''}
  </header>`;
}

function gate(msg, kind) {
  return `<div class="gate"><div class="card">
    <h1 style="font-size:16px;margin:0 0 4px">Zero Suite</h1>
    <p class="note">Owner dashboard.</p>
    ${msg ? `<div class="banner ${kind || 'bad'}">${esc(msg)}</div>` : ''}
    <form id="signin">
      <label for="em">Email</label>
      <input id="em" type="email" autocomplete="username" required>
      <label for="pw">Password</label>
      <input id="pw" type="password" autocomplete="current-password" required>
      <button type="submit" style="width:100%;margin-top:14px">Sign in</button>
    </form>
  </div></div>`;
}

/* ------------------------------------------------------------------- MFA */
/* The dashboard reads every user's usage history, so it asks for a TOTP code
 * on top of the password. Microsoft Authenticator, Google Authenticator, Authy
 * and 1Password all speak the same standard; nothing here is tied to one.
 *
 * This screen is a CONVENIENCE, not the boundary. The boundary is the policy
 * in 0017: analytics_event's select policy demands `aal2`, a claim that only
 * exists on a token GoTrue mints after it has checked a code. Skipping this
 * page and calling the REST API with a password-only token returns an empty
 * array, which is the same answer it gives everyone else.
 */
function mfaScreen() {
  const m = UI.mfa || {};
  const enrolling = !!m.qr;
  /* Rendered from the otpauth URI with the same encoder Bench prints labels
   * with, rather than injecting the SVG string the server hands back: the
   * server's copy would be markup from the network going straight into
   * innerHTML, and the encoder is already in the repo. */
  const qr = enrolling && m.uri
    ? QR.toSvg(m.uri, { ecc: 'M', quietZone: 2, dark: '#0f1117', light: '#ffffff' })
    : '';

  return `<div class="gate"><div class="card">
    <h1 style="font-size:16px;margin:0 0 4px">${enrolling ? 'Set up your authenticator' : 'Second factor'}</h1>
    <p class="note">${enrolling
      ? 'Scan this with Microsoft Authenticator — <em>Add account → Other</em> — then enter the six digits it shows.'
      : 'Open Microsoft Authenticator and enter the six digits for Zero Suite.'}</p>
    ${UI.error ? `<div class="banner bad">${esc(UI.error)}</div>` : ''}
    ${qr ? `<div class="qr">${qr}</div>
      <p class="note" style="text-align:center">Cannot scan? Enter this key by hand:<br>
        <code class="key">${esc(m.secret || '')}</code></p>` : ''}
    <form id="mfa">
      <label for="code">Six-digit code</label>
      <input id="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]*"
             maxlength="7" required
             style="font-family:var(--fm);font-size:20px;letter-spacing:.3em;text-align:center">
      <button type="submit" style="width:100%;margin-top:14px">${UI.busy ? 'Checking…' : 'Verify'}</button>
    </form>
    <button data-act="signout" style="width:100%;margin-top:8px;background:none;border:none;color:var(--ink3)">
      Sign out</button>
  </div></div>`;
}

/** Decide which of the two MFA screens to show, and prepare it. */
async function startMfa() {
  UI.busy = true; UI.error = null;
  const f = await CORE.mfaFactors();
  if (!f.ok) {
    UI.view = 'error';
    UI.error = 'Could not check this account for a second factor.';
    UI.busy = false; return render();
  }
  /* No challenge is started here, in either branch.
   *
   * A challenge expires, and this screen is one a person reads: they fetch a
   * phone, open an app, scan a code, wait for the digits to roll over. One
   * minted now is stale by the time it is used, and the failure it produces is
   * indistinguishable on screen from a wrong code. The submit handler takes a
   * fresh one per attempt instead. */
  if (f.verified.length) {
    /* Already enrolled: challenge the existing factor. No QR -- showing one
     * again would enrol a SECOND factor and leave the first as a way in. */
    UI.mfa = { factorId: f.verified[0].id, challengeId: null };
  } else {
    /* Clear any half-finished enrolment before starting a new one.
     *
     * An enrolment that was never verified is worthless by definition: nobody
     * has proved they hold its secret. But GoTrue refuses to issue a second
     * UNVERIFIED factor, so leaving one behind meant the next attempt got a
     * 422 -- and the only way out was deleting a row by hand in SQL. A failed
     * scan is an ordinary thing to happen once; it must not turn into a
     * database chore.
     *
     * Deleted rather than reused, because it cannot be reused: the secret and
     * the otpauth URI come back from `enroll` and are never retrievable again,
     * so there is no way to put the QR back on screen for an existing factor.
     * A fresh enrolment with a fresh secret is the only honest recovery, and
     * it is also what the user expects after a scan that did not take. */
    for (const stale of f.factors.filter(x => x.status !== 'verified')) {
      await CORE.mfaUnenroll(stale.id);
    }

    /* Enrolment runs on the password-only session, deliberately: an admin who
     * has never enrolled has no way to reach aal2, so requiring it here would
     * lock the only admin out with no path back. */
    const e = await CORE.mfaEnroll('Zero Suite dashboard');
    if (!e.ok) {
      UI.view = 'error';
      UI.error = e.status === 422
        ? 'Supabase is still holding a half-finished enrolment for this account and would '
          + 'not replace it. Run this once in the Supabase SQL editor, then reload:\n\n'
          + 'delete from auth.mfa_factors where status <> \'verified\';'
        : 'Could not start enrolment.';
      UI.busy = false; return render();
    }
    UI.mfa = { factorId: e.factorId, qr: e.qr, secret: e.secret, uri: e.uri,
               challengeId: null, fresh: true };
  }
  UI.view = 'mfa';
  UI.busy = false;
  render();
}

function render() {
  const app = $('app');
  if (!CORE) {
    app.innerHTML = gate('No backend is configured in this build — supabase.config.json '
      + 'was empty when it was built.', 'bad');
    return;
  }
  if (UI.view === 'signin')  { app.innerHTML = gate(UI.error, 'bad'); return; }
  if (UI.view === 'mfa')     { app.innerHTML = mfaScreen(); const c = $('code'); if (c) c.focus(); return; }
  if (UI.view === 'denied')  {
    app.innerHTML = header() + `<main><div class="banner bad">
      This account is not an admin, so there is nothing to show. Set
      <code>profiles.is_admin</code> to true for it in the Supabase SQL editor.
    </div></main>`;
    return;
  }
  if (UI.view === 'error')   {
    app.innerHTML = header() + `<main><div class="banner bad">${esc(UI.error)}</div></main>`;
    return;
  }
  if (UI.view === 'loading') { app.innerHTML = header() + '<main><p class="note">Loading…</p></main>'; return; }
  app.innerHTML = header() + (UI.tab === 'site' ? siteDashboard(UI.data)
    : UI.tab === 'support' ? supportTab() : dashboard(UI.data));
}

/* -------------------------------------------------------------------- flow */
/* ------------------------------------------------------------ auto-refresh */
/*
 * The dashboard reports a number that changes while you are looking at it, so
 * it refreshes itself rather than making the reader wonder whether it is live.
 *
 * A minute, not ten seconds. The events behind these views arrive in batches
 * when an app syncs -- zero-core flushes telemetry on an interval and when a
 * phone is backgrounded, not on every tap -- so polling at ten seconds would
 * issue six times the queries to redraw the same four charts, and the number
 * it painted would be no fresher. Four view reads a minute is already generous
 * against how fast the underlying data can actually move.
 *
 * Paused while the tab is hidden, and caught up immediately when it comes back:
 * a dashboard left open on a second monitor overnight should not spend the
 * night querying, and should not need a manual reload in the morning either.
 */
/* The windows to look through.
 *
 * 1d and 3d are here because the short end is where an owner actually watches:
 * "did the thing I shipped this morning change anything" is a question 7d
 * answers badly, since six of its seven days predate the question. 180d and
 * 365d because month-over-month is the shape a business asks about, and the
 * data only gets more useful as it accumulates.
 *
 * The day axis stays UTC throughout, because that is what the views group on;
 * a range measured in local days against buckets cut in UTC would put a
 * boundary in the middle of a bar. */
const RANGES = [[1, '24h'], [3, '3d'], [7, '7d'], [30, '30d'],
                [90, '90d'], [180, '180d'], [365, '1y']];

const REFRESH_MS = 60_000;
let refreshTimer = null;

async function refresh(reason) {
  // Never over the top of another read, and never while a screen that is not
  // the dashboard is up -- an auto-refresh must not interrupt MFA entry.
  if (UI.busy || UI.view !== 'ready') return;
  UI.refreshing = true; render();
  try {
    UI.data = await load();
    UI.lastLoaded = Date.now();
    UI.staleError = null;
  } catch (e) {
    /* A failed refresh keeps the numbers already on screen and says so. The
     * alternative -- replacing a working dashboard with an error page because
     * one poll timed out -- throws away good data over a transient blip. */
    UI.staleError = e.message || String(e);
  }
  UI.refreshing = false;
  render();
}

function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh('interval');
  }, REFRESH_MS);
}
function stopRefresh() { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }

document.addEventListener('visibilitychange', () => {
  // Coming back to a tab that has been hidden for a while: catch up at once
  // rather than showing yesterday until the next tick.
  if (document.visibilityState === 'visible' && UI.view === 'ready'
      && Date.now() - (UI.lastLoaded || 0) > REFRESH_MS) refresh('visible');
});

async function enter() {
  UI.view = 'loading'; UI.busy = true; render();
  /* Ask the server, every time. A stale "yes" cached on the device would keep
   * showing a dashboard shell after the flag was revoked -- empty, because RLS
   * still refuses the rows, but misleading about what this account can do. */
  const who = await CORE.rpc('is_admin');
  if (!who.ok) {
    UI.view = 'error';
    UI.error = who.status === 404
      ? 'The is_admin() function does not exist — apply migration 0015 to the Supabase project first.'
      : 'Could not reach the backend to check this account.';
    UI.busy = false; return render();
  }
  if (who.data !== true) { UI.view = 'denied'; UI.busy = false; return render(); }
  /* An admin, but the analytics need a second factor verified in THIS session.
   * Checked from the token's own aal claim, which is the same thing the policy
   * reads — asking the client's opinion of its own privileges would be the one
   * check that proves nothing. */
  if (CORE.aal() !== 'aal2') { UI.busy = false; return startMfa(); }
  try {
    UI.data = await load();
    UI.lastLoaded = Date.now();
    UI.view = 'ready';
    startRefresh();
  } catch (e) {
    UI.view = 'error'; UI.error = e.message || String(e);
    stopRefresh();
  }
  UI.busy = false;
  render();
}

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'support') {
    e.preventDefault();
    if (UI.support && UI.support.busy) return;
    const email = $('support-email').value.trim();
    if (email) runOwnerTool('lookup', email);
    return;
  }
  if (e.target.id === 'mfa') {
    e.preventDefault();
    if (UI.busy) return;
    const m = UI.mfa || {};
    // Spaces are how every authenticator app displays the code, so accept them.
    const code = $('code').value.replace(/\s+/g, '');
    UI.busy = true; UI.error = null; render();

    /* A challenge expires, and one is also spent by a failed attempt. Getting a
     * fresh one per submission means "wrong code, try again" is actually
     * retryable rather than failing forever against a dead challenge. */
    let challengeId = m.challengeId;
    if (!challengeId) {
      const c = await CORE.mfaChallenge(m.factorId);
      if (!c.ok) {
        UI.busy = false; UI.error = 'Could not start the check. Try again.'; return render();
      }
      challengeId = c.challengeId;
    }
    const v = await CORE.mfaVerify(m.factorId, challengeId, code);
    UI.mfa = { ...m, challengeId: null };
    if (!v.ok) {
      UI.busy = false;
      /* Naming the clock is worth the extra sentence. A TOTP code is derived
       * from the time, so a phone whose clock is set by hand and drifts by a
       * minute produces codes that are always wrong -- and every other symptom
       * is identical to mistyping, so people retype instead of looking at the
       * one setting that would fix it. */
      UI.error = v.status === 422 || v.status === 401
        ? 'That code was not accepted. Codes last about thirty seconds, so wait for the '
          + 'next one and enter it fresh. If they keep failing, check your phone\'s clock '
          + 'is set automatically — a code is computed from the time, and a clock that is '
          + 'off by a minute produces codes that never work.'
        : 'Could not check the code. Try again.';
      return render();
    }
    UI.mfa = null; UI.error = null; UI.busy = false;
    return enter();
  }
  if (e.target.id !== 'signin') return;
  e.preventDefault();
  UI.error = null;
  const r = await CORE.signIn($('em').value.trim(), $('pw').value);
  if (!r.ok) {
    UI.error = (r.error && (r.error.error_description || r.error.msg || r.error.message))
      || 'Sign-in failed.';
    return render();
  }
  enter();
});

/* ------------------------------------------------------------ owner tools */
/*
 * Calls the owner-tools edge function, which holds the service-role key. This
 * page holds nothing privileged: it forwards the session token and the function
 * decides, re-checking admin AND the second factor server-side. The screen
 * below is a convenience over that decision, not the decision.
 */
async function ownerTool(action, email) {
  const s = CORE.getSession();
  if (!s || !s.access_token) return { ok: false, error: 'Not signed in.' };
  try {
    const r = await fetch(`${SHARED_SUPABASE.url}/functions/v1/owner-tools`, {
      method: 'POST',
      headers: {
        apikey: SHARED_SUPABASE.anonKey,
        Authorization: `Bearer ${s.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, email }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { ok: false, status: r.status,
               error: data.error || `The support endpoint returned ${r.status}.`,
               code: data.code };
    }
    return { ok: true, data };
  } catch (e) {
    /* A function that was never deployed fails as a network error here, not a
     * 404, because the browser cannot even reach an origin that does not
     * answer. Saying so beats "failed to fetch". */
    return { ok: false, error: 'Could not reach the support endpoint — check that the '
                            + 'owner-tools function is deployed to this project.' };
  }
}

async function runOwnerTool(action, email) {
  UI.support = { ...(UI.support || {}), busy: true, error: null, notice: null };
  render();
  const r = await ownerTool(action, email);
  const st = { busy: false, email, error: null, notice: null,
               filter: (UI.support && UI.support.filter) || '',
               result: (UI.support && UI.support.result) || null };
  if (!r.ok) {
    st.error = r.code === 'aal2_required'
      ? 'This needs a second factor verified in this session — sign out and back in.'
      : r.error;
    if (action === 'lookup') st.result = null;
  } else if (action === 'lookup') {
    st.result = r.data.found ? r.data.user : false;
    if (!r.data.found) st.notice = 'No account with that address.';
  } else {
    st.notice = action === 'send_reset'
      ? 'Password reset email sent.'
      : 'Confirmation email resent.';
  }
  UI.support = st;
  render();
}

/* Filtering is local and immediate — no request per keystroke against an
 * endpoint that holds the service key. */
document.addEventListener('input', (e) => {
  if (e.target.id !== 'cfilter-q') return;
  UI.support = { ...(UI.support || {}), filter: e.target.value };
  render();
  const el = $('cfilter-q');
  if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
});

document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.act === 'clearfilter') {
    UI.support = { ...(UI.support || {}), filter: '' };
    return render();
  }
  if (b.dataset.pick) return runOwnerTool('lookup', b.dataset.pick);
  if (b.dataset.range) { UI.range = +b.dataset.range; return enter(); }
  if (b.dataset.tab && b.dataset.tab !== UI.tab) {
    UI.tab = b.dataset.tab; UI.data = null; return enter();
  }
  if (b.dataset.act === 'refresh') return enter();
  if (b.dataset.act === 'signout') {
    CORE.signOut();
    UI.view = 'signin'; UI.data = null; UI.error = null; UI.support = null;
    stopRefresh();
    return render();
  }
  /* Both of these put an email in somebody's inbox, so both confirm first.
   * A support tool that fires on a single click is one that sends a stranger a
   * password-reset the moment a mistyped address happens to match. */
  if (b.dataset.mail) {
    const email = (UI.support && UI.support.email) || '';
    const what = b.dataset.mail === 'send_reset'
      ? `Send a password reset email to ${email}?`
      : `Resend the confirmation email to ${email}?`;
    if (!confirm(what)) return;
    return runOwnerTool(b.dataset.mail, email);
  }
});

/* One tooltip, driven by whatever mark is under the pointer. Bigger hit targets
 * than the marks themselves: the line charts carry a transparent column per
 * day, so a 2px line does not have to be hit exactly. */
(() => {
  const tip = $('tip');
  document.addEventListener('mousemove', (e) => {
    const t = e.target.closest('[data-tip]');
    if (!t) {
      tip.style.opacity = 0;
      document.querySelectorAll('.cross').forEach(c => (c.style.opacity = 0));
      return;
    }
    tip.textContent = t.dataset.tip;
    tip.style.opacity = 1;
    // Flip before the edge rather than after it, so the tip never leaves the page.
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(e.clientX + 14, innerWidth - w - 8) + 'px';
    tip.style.top = Math.max(8, e.clientY - h - 12) + 'px';
    const svg = t.ownerSVGElement;
    if (svg && t.dataset.x) {
      const cross = svg.querySelector('.cross');
      if (cross) {
        cross.setAttribute('x1', t.dataset.x);
        cross.setAttribute('x2', t.dataset.x);
        cross.style.opacity = .5;
      }
    }
  });
})();

if (CORE && CORE.isSignedIn()) enter();
else { UI.view = 'signin'; render(); }
