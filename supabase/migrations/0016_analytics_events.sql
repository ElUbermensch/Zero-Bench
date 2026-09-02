-- ============================================================================
-- Product-usage analytics.
--
-- One append-only table plus admin-only rollups over it. This is the data
-- behind the owner dashboard: traffic, sign-ups, sign-ins, and which features
-- actually get used, per app.
--
-- Two things about the access shape, because they are not the pattern the rest
-- of this schema uses:
--
--   1. The client may INSERT its own events and may not read ANY of them back.
--      Telemetry a user can read is telemetry a user can page through; telemetry
--      a user can edit or delete is not evidence of anything. There is no
--      select/update/delete policy for the owner of a row, only for an admin,
--      and a grant without a policy denies.
--
--   2. anon still gets nothing. 0001 says "there is no public data in this
--      database" and that stays true -- an unauthenticated insert endpoint
--      reachable with the public key is a spam target. Supabase anonymous
--      sign-in produces a real auth.users row on the authenticated role, so
--      pair-fire guests are covered without opening anything up. Events tracked
--      while signed out simply wait in the client outbox, which is why
--      occurred_at exists.
-- ============================================================================

create table public.analytics_event (
  id               uuid primary key default gen_random_uuid(),
  -- set null, not cascade: deleting a user must not silently rewrite history.
  -- Every count in every rollup below would drop retroactively.
  user_id          uuid references auth.users(id) on delete set null,
  source_app       text not null check (source_app in ('bench','zero')),
  event_name       text not null,
  -- One per app load, client-generated. Groups the events of a single visit
  -- without implying anything about the domain's own "sessions" -- Zero has
  -- range_sessions and Bench has loading sessions, and this is neither.
  usage_session_id uuid,
  metadata         jsonb not null default '{}'::jsonb,
  -- The client's clock, kept because an event queued offline may not reach the
  -- server for days and created_at would then describe the sync, not the visit.
  -- Untrusted by construction: phone clocks drift and a client can send
  -- anything. Rollups below deliberately group on created_at.
  occurred_at      timestamptz,
  -- The server's clock. Stripped from every client payload by zero-core's
  -- SERVER_OWNED list, so this cannot be spoofed.
  created_at       timestamptz not null default now()
);

comment on table public.analytics_event is
  'Append-only product telemetry. Client writes, admin reads, nobody updates.';
comment on column public.analytics_event.occurred_at is
  'Client clock at the moment of the event. Untrusted; for offline forensics.';
comment on column public.analytics_event.created_at is
  'Server clock at insert. The trustworthy axis, and what the rollups group on.';

create index ix_analytics_created     on public.analytics_event (created_at desc);
create index ix_analytics_name_time   on public.analytics_event (event_name, created_at desc);
create index ix_analytics_user_time   on public.analytics_event (user_id, created_at desc);
create index ix_analytics_app_time    on public.analytics_event (source_app, created_at desc);

-- ---------------------------------------------------------------------- RLS
alter table public.analytics_event enable row level security;
alter table public.analytics_event force row level security;

-- Write your own events, attributed to yourself. Nothing else.
create policy analytics_event_insert_own on public.analytics_event
  for insert to authenticated
  with check (user_id = auth.uid());

-- Read is admin-only. There is deliberately no _select_own counterpart.
create policy analytics_event_select_admin on public.analytics_event
  for select to authenticated
  using (public.is_admin());

-- No update policy and no delete policy anywhere, including for admins. The
-- table is append-only, and 0001's blanket grant to authenticated is inert
-- without a policy to permit the row.

-- ============================================================================
-- Rollups.
--
-- security_invoker = true for the reason 0001 gives: an owner-rights view
-- bypasses the RLS of its base table and would serve the whole event stream to
-- every user. With invoker rights these views are readable by anyone and return
-- rows only to an admin, because analytics_event's policy is what decides.
--
-- Every rollup derives from analytics_event alone rather than joining profiles
-- or auth.users -- an admin has no read over another user's profile row (by
-- design, see 0015), so a join there would silently return one row.
--
-- `day` is the server's date, i.e. UTC on Supabase. A dashboard that wants
-- local days should shift client-side rather than have this bake in a zone.
-- ============================================================================

create view public.v_analytics_daily_active
with (security_invoker = true) as
select
  source_app,
  created_at::date                    as day,
  count(distinct user_id)             as active_users,
  count(distinct usage_session_id)    as visits,
  count(*)                            as events
from public.analytics_event
group by source_app, created_at::date;

comment on view public.v_analytics_daily_active is
  'Active users, visits and raw event volume per app per day.';

create view public.v_analytics_new_users
with (security_invoker = true) as
select
  source_app,
  created_at::date          as day,
  count(distinct user_id)   as new_users
from public.analytics_event
where event_name = 'sign_up'
group by source_app, created_at::date;

comment on view public.v_analytics_new_users is
  'Sign-ups per app per day. Counts the sign_up event, not profiles.created_at, '
  'because an admin cannot read another user''s profile row.';

create view public.v_analytics_events_by_name
with (security_invoker = true) as
select
  source_app,
  event_name,
  created_at::date          as day,
  count(*)                  as event_count,
  count(distinct user_id)   as user_count
from public.analytics_event
group by source_app, event_name, created_at::date;

comment on view public.v_analytics_events_by_name is
  'Feature usage: how often each tracked action happens, and how many people do it.';

/*
 * Visits are counted from app_open, which fires once per app load and is the
 * reliable number.
 *
 * Duration is NOT. It comes from app_background, which rides on
 * visibilitychange/pagehide -- events a mobile browser is free to skip entirely
 * when it kills a backgrounded tab. So a visit that produced no app_background
 * contributes to visits and not to duration, and the average below is over the
 * visits that reported, not over all of them. Treat it as a floor-ish estimate
 * and read visits as the headline.
 */
create view public.v_analytics_visits
with (security_invoker = true) as
with opens as (
  select source_app, created_at::date as day, usage_session_id
  from public.analytics_event
  where event_name = 'app_open'
),
closes as (
  select
    source_app,
    created_at::date as day,
    usage_session_id,
    max((metadata->>'duration_ms')::numeric) as duration_ms
  from public.analytics_event
  where event_name = 'app_background'
    and metadata ? 'duration_ms'
    -- jsonb->>'x' is text; a client sending a non-numeric value would abort the
    -- whole view rather than lose one row, so filter to what actually casts.
    and (metadata->>'duration_ms') ~ '^[0-9]+(\.[0-9]+)?$'
  group by source_app, created_at::date, usage_session_id
)
select
  o.source_app,
  o.day,
  count(distinct o.usage_session_id)                        as visits,
  count(distinct c.usage_session_id)                        as visits_with_duration,
  round(avg(c.duration_ms) / 1000.0, 1)                     as avg_duration_s,
  -- percentile_cont takes and returns double precision, and round(dp, int) does
  -- not exist -- only round(numeric, int). Back to numeric before rounding.
  round((percentile_cont(0.5) within group (order by c.duration_ms))::numeric / 1000.0, 1)
                                                            as median_duration_s
from opens o
left join closes c
  on c.usage_session_id = o.usage_session_id and c.source_app = o.source_app
group by o.source_app, o.day;

comment on view public.v_analytics_visits is
  'Visits per app per day. visits is reliable; the duration columns cover only '
  'the visits that reported a close, because mobile browsers routinely do not.';

-- ------------------------------------------------------------------- grants
grant select on
  public.v_analytics_daily_active,
  public.v_analytics_new_users,
  public.v_analytics_events_by_name,
  public.v_analytics_visits
to authenticated;
