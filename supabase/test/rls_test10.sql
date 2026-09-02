-- ============================================================================
-- LOCAL TEST FIXTURE. NOT A MIGRATION.
--
-- The deploy procedure is "open the file on GitHub, click Raw, copy, paste into
-- the Supabase SQL Editor" -- and this directory sits next to the one that
-- procedure is about. The SQL Editor runs as `postgres`, which bypasses RLS
-- entirely, so a mis-paste here is not a failed query.
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
-- The second factor on the analytics (0017).
--
-- Four claims, and the last two are the ones worth the file:
--
--   1. an admin on a password-only session (aal1) reads nothing
--   2. the same admin with a verified factor (aal2) reads everything
--   3. aal2 is not a skeleton key -- it grants nothing to a non-admin, and it
--      does not widen an admin's reach into anyone's reloading data
--   4. ORDINARY USERS STILL WRITE. The aal2 requirement is scoped to SELECT
--      on purpose: every shooter's app inserts telemetry on an aal1 session,
--      and a blanket restrictive policy -- the shape the Supabase docs show --
--      would refuse every event either app ever recorded, leaving a dashboard
--      perfectly secured around an empty table.
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off

insert into auth.users (id, email) values
  ('d0000000-0000-0000-0000-00000000000d', 'mfa-owner@example.com'),
  ('e0000000-0000-0000-0000-00000000000e', 'mfa-shooter@example.com')
on conflict do nothing;

insert into public.profiles (id, display_name, is_admin) values
  ('d0000000-0000-0000-0000-00000000000d', 'MFA Owner',   true),
  ('e0000000-0000-0000-0000-00000000000e', 'MFA Shooter', false)
on conflict (id) do update set is_admin = excluded.is_admin;

/* Defined here as well as in rls_test9, and the duplication is deliberate.
 *
 * run_tests.sh orders the suites with `sort -V`, so rls_test9 comes first and
 * defines this. The CI workflow used a PLAIN glob, which is lexicographic:
 * rls_test10 sorted between rls_test.sql and rls_test2, ran second, and died
 * on a function that would not exist for another eight files. The workflow is
 * fixed to sort the same way -- but a suite that only passes when something
 * earlier happened to run is a suite that will break again the next time
 * anything reorders them, so this one no longer depends on that.
 *
 * `create or replace` makes running after rls_test9 harmless. */
create or replace function test.as_user_aal(u uuid, lvl text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u::text, false);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', u::text, 'role', 'authenticated',
                       'is_anonymous', false, 'aal', lvl)::text, false);
end $$;

-- ============================================== 4. writing is untouched, aal1
set role authenticated;
select test.as_user_aal('e0000000-0000-0000-0000-00000000000e', 'aal1');

insert into public.analytics_event (user_id, source_app, event_name, usage_session_id)
values ('e0000000-0000-0000-0000-00000000000e', 'zero', 'app_open',
        '33333333-0000-0000-0000-000000000003');

insert into public.analytics_event (user_id, source_app, event_name, usage_session_id)
values ('e0000000-0000-0000-0000-00000000000e', 'zero', 'shot_logged',
        '33333333-0000-0000-0000-000000000003');

do $$
declare n integer;
begin
  perform test.check(true,
    'an ordinary aal1 session still records events — the aal2 rule is scoped to select');

  -- ...and still cannot read them, for the reason 0016 gives.
  select count(*) into n from public.analytics_event;
  perform test.check(n = 0, '...and still cannot read any of them back');
end $$;

-- ================================================ 1. admin, password only
select test.as_user_aal('d0000000-0000-0000-0000-00000000000d', 'aal1');

do $$
declare n integer;
begin
  perform test.check(public.is_admin(),
    'a password-only admin is still an admin — the dashboard needs to know that to ask for a code');
  perform test.check(not public.is_admin_mfa(),
    '...but has not cleared the second factor');

  select count(*) into n from public.analytics_event;
  perform test.check(n = 0, 'so the analytics read nothing on a password-only session');

  select count(*) into n from public.v_analytics_daily_active;
  perform test.check(n = 0, '...including through the rollups');
end $$;

-- ==================================================== 2. admin, second factor
select test.as_user_aal('d0000000-0000-0000-0000-00000000000d', 'aal2');

do $$
declare n integer;
begin
  perform test.check(public.is_admin_mfa(), 'with a verified factor the admin clears both tests');

  select count(*) into n from public.analytics_event;
  perform test.check(n > 0, 'and the analytics open up');

  select count(*) into n from public.v_analytics_daily_active;
  perform test.check(n > 0, '...through the rollups too');
end $$;

-- ================================================== 3. aal2 is not a bypass
select test.as_user_aal('e0000000-0000-0000-0000-00000000000e', 'aal2');

do $$
declare n integer;
begin
  perform test.check(not public.is_admin_mfa(),
    'a second factor on a non-admin account grants nothing — it is an AND, not an OR');

  select count(*) into n from public.analytics_event;
  perform test.check(n = 0, '...and reads nothing');
end $$;

-- An admin with a factor still has no business in anyone's reloading records.
reset role;
-- source_name because 0001's recipe_cites_a_source demands a citation or an
-- explicit self-developed acknowledgment.
insert into public.recipes (id, user_id, name, cartridge, charge_gr, source_name)
values ('d0000000-0000-0000-0000-0000000000cc',
        'e0000000-0000-0000-0000-00000000000e', 'Shooter load', '308 Win', 41.5,
        'Sierra 6th Edition');

set role authenticated;
select test.as_user_aal('d0000000-0000-0000-0000-00000000000d', 'aal2');

do $$
declare n integer;
begin
  select count(*) into n from public.recipes
   where id = 'd0000000-0000-0000-0000-0000000000cc';
  perform test.check(n = 0,
    'aal2 does not widen an admin''s reach into another user''s reloading data');
end $$;

-- A token with no aal claim at all is treated as aal1, not as "unset, allow".
do $$
declare n integer;
begin
  perform set_config('request.jwt.claim.sub',
    'd0000000-0000-0000-0000-00000000000d', false);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', 'd0000000-0000-0000-0000-00000000000d',
                       'role', 'authenticated')::text, false);

  perform test.check(not public.is_admin_mfa(),
    'a token carrying no aal claim is treated as aal1 — a missing claim must not read as satisfied');

  select count(*) into n from public.analytics_event;
  perform test.check(n = 0, '...and reads nothing');
end $$;

-- Exactly one select policy on the table. 0017 REPLACED 0016's rather than
-- adding beside it: policies of one command are OR-ed, so the older
-- password-only policy left in place would have made the factor decoration.
do $$
declare n integer;
begin
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'analytics_event' and cmd = 'SELECT';
  perform test.check(n = 1,
    'one select policy, not two — an OR with the old one would have made the second factor optional');
end $$;

reset role;
\echo ''
\echo 'ADMIN MFA ASSERTIONS PASSED'
