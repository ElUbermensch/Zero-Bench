-- ============================================================================
-- LOCAL TEST FIXTURE. NOT A MIGRATION.
--
-- The deploy procedure is "open the file on GitHub, click Raw, copy, paste into
-- the Supabase SQL Editor" -- and this directory sits next to the one that
-- procedure is about. The SQL Editor runs as `postgres`, which bypasses RLS
-- entirely, so a mis-paste here is not a failed query: `delete from
-- public.analytics_event;` erases the entire usage history, and harness.sql
-- replaces auth.uid() with a stub that breaks every policy at once.
-- ============================================================================
do $$
begin
  if current_database() <> 'shooting' then
    raise exception
      'REFUSED: % is a LOCAL TEST fixture and must never run against a real project (database is %, expected "shooting")',
      current_setting('application_name', true), current_database();
  end if;
end $$;

-- ============================================================================
-- The admin role (0015) and product telemetry (0016).
--
-- analytics_event is the only table in this schema whose owner cannot read it
-- back, so the usual "you see yours and not theirs" shape is not what is under
-- test. Five claims:
--
--   1. you may write your own events and may not write anybody else's
--   2. you may not READ your own events -- write-only is the point, because
--      telemetry a user can page through is telemetry they can mine, and
--      telemetry a user can delete is not evidence of anything
--   3. nobody updates or deletes, admin included: the table is append-only,
--      and 0001's blanket grant to authenticated is inert without a policy
--   4. an admin reads everything, the is_admin flag is what decides, and
--      clearing it closes the door again with no policy change anywhere.
--      (Since 0017 an admin READ also needs aal2, which is why the owner is
--      impersonated at that level below. rls_test10 is where that is the
--      thing under test rather than a precondition.)
--   5. the rollup views inherit that. security_invoker is the load-bearing
--      word in 0016: an owner-rights view would hand the whole event stream to
--      whoever asked.
--
-- Role switches stay at statement level, the way every suite here does them. A
-- SET ROLE inside a DO block outlives the block and makes the next section's
-- identity depend on where the previous one happened to stop.
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off

insert into auth.users (id, email) values
  ('a0000000-0000-0000-0000-00000000000a', 'shooter@example.com'),
  ('b0000000-0000-0000-0000-00000000000b', 'other@example.com'),
  ('c0000000-0000-0000-0000-00000000000c', 'owner@example.com')
on conflict do nothing;

/* as_user() from rls_test.sql always claims aal1, and since 0017 reading the
 * analytics also demands aal2 -- so every admin READ below has to say which
 * assurance level it asks at. A separate function rather than a third
 * parameter on as_user(): an optional argument would make every existing
 * single-argument call ambiguous against the old signature.
 *
 * rls_test10 is where aal2 is itself under test. Here it is a precondition,
 * stated out loud so this suite goes on testing what it is about -- who may
 * read the analytics -- instead of quietly becoming a second test of 0017. */
create or replace function test.as_user_aal(u uuid, lvl text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u::text, false);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', u::text, 'role', 'authenticated',
                       'is_anonymous', false, 'aal', lvl)::text, false);
end $$;

-- Written as postgres, before any role is assumed: there is deliberately no
-- in-app path that can set is_admin, so there is none here either.
insert into public.profiles (id, display_name, is_admin) values
  ('a0000000-0000-0000-0000-00000000000a', 'Shooter', false),
  ('b0000000-0000-0000-0000-00000000000b', 'Other',   false),
  ('c0000000-0000-0000-0000-00000000000c', 'Owner',   true)
on conflict (id) do update set is_admin = excluded.is_admin;

-- ======================================================= 1. writing your own
set role authenticated;
select test.as_user('a0000000-0000-0000-0000-00000000000a');

-- Lands, or ON_ERROR_STOP takes the suite down. Proven read-side in section 4,
-- where the admin counts it.
insert into public.analytics_event (id, user_id, source_app, event_name, usage_session_id, metadata)
values ('e0000000-0000-0000-0000-000000000001',
        'a0000000-0000-0000-0000-00000000000a', 'bench', 'app_open',
        '11111111-0000-0000-0000-000000000001', '{}'::jsonb);

-- Attributing an event to someone else is the whole attack: a client that can
-- write rows as another account can forge that account's usage history.
do $$
declare denied boolean := false;
begin
  begin
    insert into public.analytics_event (user_id, source_app, event_name)
    values ('b0000000-0000-0000-0000-00000000000b', 'bench', 'app_open');
  exception when insufficient_privilege then denied := true;
  end;
  perform test.check(denied, 'an event cannot be attributed to another user');
end $$;

-- user_id carries no auth.uid() default here, unlike the domain tables, so a
-- client that simply omits it must be refused rather than silently anonymous.
do $$
declare denied boolean := false;
begin
  begin
    insert into public.analytics_event (source_app, event_name)
    values ('bench', 'app_open');
  exception when insufficient_privilege then denied := true;
  end;
  perform test.check(denied, 'nor recorded with no owner at all');
end $$;

-- The lower-case convention from 0006, pinned on this table from day one
-- rather than fixed in a migration afterwards.
do $$
declare denied boolean := false;
begin
  begin
    insert into public.analytics_event (user_id, source_app, event_name)
    values ('a0000000-0000-0000-0000-00000000000a', 'Bench', 'app_open');
  exception when check_violation then denied := true;
  end;
  perform test.check(denied, 'source_app is lower-case only, as it has been since 0006');
end $$;

-- ==================================================== 2. not reading your own
do $$
declare n integer;
begin
  select count(*) into n from public.analytics_event;
  perform test.check(n = 0,
    'a user cannot read back even the event they just wrote — there is no select policy for an owner');
end $$;

-- ================================================== 3. append-only, for all
do $$
declare touched integer;
begin
  update public.analytics_event set event_name = 'tampered'
   where id = 'e0000000-0000-0000-0000-000000000001';
  get diagnostics touched = row_count;
  perform test.check(touched = 0, 'a user cannot rewrite an event');

  delete from public.analytics_event
   where id = 'e0000000-0000-0000-0000-000000000001';
  get diagnostics touched = row_count;
  perform test.check(touched = 0, '...nor delete one, which is what makes the record evidence');
end $$;

-- A second user, a second app, and the same invisibility.
select test.as_user('b0000000-0000-0000-0000-00000000000b');

insert into public.analytics_event (user_id, source_app, event_name, usage_session_id)
values ('b0000000-0000-0000-0000-00000000000b', 'zero', 'sign_up',
        '22222222-0000-0000-0000-000000000002');

/* source_name is not optional decoration: 0001's recipe_cites_a_source refuses
 * a recipe that neither cites a manual nor is explicitly marked
 * self-developed. The safety model is the point of that constraint, so the
 * fixture satisfies it rather than working around it. */
insert into public.recipes (id, user_id, name, cartridge, charge_gr, source_name)
values ('e0000000-0000-0000-0000-0000000000bb',
        'b0000000-0000-0000-0000-00000000000b', 'Other load', '6.5 CM', 41.0,
        'Hodgdon Annual 2025');

do $$
declare n integer;
begin
  select count(*) into n from public.analytics_event;
  perform test.check(n = 0, 'and one user cannot see another user''s events either');
end $$;

-- ====================================================== 4. the admin reads
set role authenticated;
select test.as_user_aal('c0000000-0000-0000-0000-00000000000c', 'aal2');

do $$
declare n integer;
begin
  perform test.check(public.is_admin(), 'the owner account reports as admin');

  select count(*) into n from public.analytics_event;
  perform test.check(n = 2, 'an admin reads every event, from both apps');

  -- The reach stops there. 0015 deliberately left the domain policies alone,
  -- and a later migration that widens them should have to say so out loud.
  select count(*) into n from public.recipes
   where id = 'e0000000-0000-0000-0000-0000000000bb';
  perform test.check(n = 0,
    'an admin still cannot read another user''s reloading data — 0015 grants analytics and nothing else');
end $$;

-- Revoking the flag revokes the access, with no policy change anywhere.
reset role;
update public.profiles set is_admin = false
 where id = 'c0000000-0000-0000-0000-00000000000c';

set role authenticated;
select test.as_user_aal('c0000000-0000-0000-0000-00000000000c', 'aal2');

do $$
declare n integer;
begin
  perform test.check(not public.is_admin(), 'clearing the flag clears the answer');
  select count(*) into n from public.analytics_event;
  perform test.check(n = 0, '...and closes the door again');
end $$;

reset role;
update public.profiles set is_admin = true
 where id = 'c0000000-0000-0000-0000-00000000000c';

-- ======================================================= 5. the rollup views
set role authenticated;
select test.as_user_aal('c0000000-0000-0000-0000-00000000000c', 'aal2');

do $$
declare n integer;
begin
  select count(*) into n
    from pg_class c
    join pg_namespace ns on ns.oid = c.relnamespace
   where ns.nspname = 'public'
     and c.relkind = 'v'
     and c.relname like 'v\_analytics\_%'
     and c.reloptions @> array['security_invoker=true'];
  perform test.check(n = 4,
    'every analytics view runs with invoker rights — an owner-rights view would bypass the RLS above');
end $$;

do $$
declare n integer;
begin
  select count(*) into n from public.v_analytics_daily_active;
  perform test.check(n = 2, 'an admin sees a day per app in the rollup');

  select count(*) into n from public.v_analytics_new_users;
  perform test.check(n = 1, 'sign_up is what counts as a new user, and only that');

  select count(*) into n from public.v_analytics_events_by_name;
  perform test.check(n = 2, 'feature usage rolls up per app per event');

  select count(*) into n from public.v_analytics_visits;
  perform test.check(n = 1, 'a visit is an app_open, so only the app that opened is listed');
end $$;

-- The same views, asked by somebody who is not an admin.
select test.as_user('a0000000-0000-0000-0000-00000000000a');

do $$
declare n integer;
begin
  select count(*) into n from public.v_analytics_daily_active;
  perform test.check(n = 0, 'a non-admin gets an empty rollup rather than everyone''s numbers');

  select count(*) into n from public.v_analytics_events_by_name;
  perform test.check(n = 0, '...on every view, because the base table is what decides');
end $$;

-- metadata is free-form jsonb straight off a client, so a duration that is not
-- a number is reachable. It must be skipped, not fatal to the whole view.
reset role;
insert into public.analytics_event (user_id, source_app, event_name, usage_session_id, metadata)
values ('a0000000-0000-0000-0000-00000000000a', 'bench', 'app_background',
        '11111111-0000-0000-0000-000000000001', '{"duration_ms":"not-a-number"}'::jsonb);

set role authenticated;
select test.as_user_aal('c0000000-0000-0000-0000-00000000000c', 'aal2');

do $$
declare n integer;
declare d numeric;
begin
  select count(*) into n from public.v_analytics_visits;
  perform test.check(n = 1, 'a non-numeric duration is skipped, not fatal to the whole view');

  select avg_duration_s into d from public.v_analytics_visits where source_app = 'bench';
  perform test.check(d is null,
    '...and the visit still counts, with no duration rather than a wrong one');
end $$;

reset role;
\echo ''
\echo 'ANALYTICS AND ADMIN ASSERTIONS PASSED'
