-- ============================================================================
-- LOCAL TEST FIXTURE. NOT A MIGRATION.
--
-- The deploy procedure is "open the file on GitHub, click Raw, copy, paste into
-- the Supabase SQL Editor" -- and this directory sits next to the one that
-- procedure is about. The SQL Editor runs as `postgres`, which bypasses RLS
-- entirely, so a mis-paste here is not a failed query: `delete from
-- public.account_backups;` removes every customer's device backup, and
-- harness.sql replaces auth.uid() with a stub that breaks every policy at once.
--
-- So the files say so themselves, rather than relying on a warning in a
-- markdown file nobody has open at the time. run_tests.sh and CI both build a
-- database called `shooting`; anything else is assumed to be real.
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
-- Adversarial test: revoking reaches EVERY account, 0022.
--
-- 0021 made the owner's approval the thing that lets somebody in, and got the
-- precedence of the admin exemption wrong: has_access() read `is_admin() OR
-- approved`, so setting an admin's row to `revoked` changed the row and
-- nothing else. The one account most worth being able to switch off was the
-- one the switch could not reach.
--
-- What is asserted here:
--
--   1. an explicit refusal beats the admin bypass, for `revoked` and `denied`
--   2. it is REVERSIBLE by the same owner, from the same screen, with no SQL --
--      a kill switch that cannot be un-flipped is one nobody dares use
--   3. revoking does not touch the dashboard. is_admin_mfa() is a separate
--      predicate: an owner who revokes themselves loses the apps and keeps the
--      Access tab, which is the only thing that makes (2) true
--   4. an account with no request row at all can still be refused -- the
--      corner that would otherwise be answered with "I cannot revoke that one"
--   5. the hold screen agrees with the policies. An app that says "you are in"
--      while every table refuses turns a clear decision into a sync bug report
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, email, raw_user_meta_data, is_anonymous) values
  ('b1000000-0000-0000-0000-0000000000b1', 'revoke-owner@example.com',  '{}'::jsonb, false),
  ('b2000000-0000-0000-0000-0000000000b2', 'revoke-second@example.com', '{}'::jsonb, false),
  ('b3000000-0000-0000-0000-0000000000b3', 'revoke-member@example.com', '{}'::jsonb, false)
on conflict do nothing;

/* Two admins, because "revoke any account" is only interesting when there is
 * somebody with the exemption other than the person pressing the button. */
insert into public.profiles (id, display_name, is_admin) values
  ('b1000000-0000-0000-0000-0000000000b1', 'Owner',        true),
  ('b2000000-0000-0000-0000-0000000000b2', 'Second Admin', true)
on conflict (id) do update set is_admin = excluded.is_admin;

create or replace function test.as_user_aal(u uuid, lvl text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u::text, false);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', u::text, 'role', 'authenticated',
                       'is_anonymous', false, 'aal', lvl)::text, false);
end $$;

create or replace function test.check(ok boolean, label text) returns void
language plpgsql as $$
begin
  if ok then
    raise notice 'PASS  %', label;
  else
    raise exception 'FAIL  %', label;
  end if;
end $$;

-- Something for each of them to lose.
insert into public.firearms (id, user_id, name, cartridge) values
  ('b2f00000-0000-0000-0000-0000000000f1',
   'b2000000-0000-0000-0000-0000000000b2', 'Second Admin Rifle', '.308 Win'),
  ('b3f00000-0000-0000-0000-0000000000f2',
   'b3000000-0000-0000-0000-0000000000b3', 'Member Rifle', '6.5 CM')
on conflict (id) do nothing;

set role authenticated;

-- ============================================ 1. the second admin is let in
select test.as_user_aal('b2000000-0000-0000-0000-0000000000b2', 'aal1');

do $$
declare n integer;
begin
  perform test.check(public.has_access(),
    'an admin has access without an approved row — that exemption is deliberate');
  select count(*) into n from public.firearms;
  perform test.check(n = 1, '...and sees their own rows');
end $$;

-- ============================================ 2. the owner revokes them
select test.as_user_aal('b1000000-0000-0000-0000-0000000000b1', 'aal2');

do $$
declare r jsonb;
begin
  r := public.decide_access('b2000000-0000-0000-0000-0000000000b2', 'revoked',
                            'stepped back from the project');
  perform test.check(r ->> 'status' = 'revoked', 'the owner revokes another admin');
end $$;

select test.as_user_aal('b2000000-0000-0000-0000-0000000000b2', 'aal1');

do $$
declare n integer;
declare blocked boolean := false;
begin
  /* The assertion 0021 would have failed. */
  perform test.check(not public.has_access(),
    'an explicit revoke outranks being an admin — the switch reaches every account');

  select count(*) into n from public.firearms;
  perform test.check(n = 0, '...their rows go dark, without being deleted');

  begin
    insert into public.firearms (user_id, name, cartridge)
    values ('b2000000-0000-0000-0000-0000000000b2', 'After Revoke', '.223 Rem');
    perform test.check(false, 'a revoked admin must not be able to write');
  exception when insufficient_privilege then blocked := true;
  end;
  perform test.check(blocked, '...and they cannot write');

  perform test.check(not public.may_relay(),
    '...nor open a relay, which is gated on the same predicate');

  perform test.check(public.my_access_status() ->> 'status' = 'revoked',
    'and the app tells them the truth rather than "approved"');

  /* 3. The dashboard is a SEPARATE predicate, and must not have moved. This is
   * what makes the revoke reversible without SQL. */
  perform test.check(public.is_admin(),
    'they are still an admin — revoke is about the apps, not the dashboard');
  select count(*) into n from public.access_request;
  perform test.check(n = 0,
    '...though reading the queue still needs the second factor');
end $$;

select test.as_user_aal('b2000000-0000-0000-0000-0000000000b2', 'aal2');

do $$
declare n integer;
begin
  perform test.check(public.is_admin_mfa(),
    'with their second factor they still reach the dashboard');
  select count(*) into n from public.access_request;
  perform test.check(n >= 3,
    '...and can still read the Access tab — which is the way back');
  perform test.check(not public.has_access(),
    'while the apps stay shut: the two predicates are genuinely separate');
end $$;

-- ================================================== 2b. and it is reversible
select test.as_user_aal('b1000000-0000-0000-0000-0000000000b1', 'aal2');

do $$
declare r jsonb;
begin
  r := public.decide_access('b2000000-0000-0000-0000-0000000000b2', 'approved');
  perform test.check(r ->> 'status' = 'approved', 'the owner puts it back');
end $$;

select test.as_user_aal('b2000000-0000-0000-0000-0000000000b2', 'aal1');

do $$
declare n integer;
begin
  perform test.check(public.has_access(), 'and they are in again');
  select count(*) into n from public.firearms;
  perform test.check(n = 1, '...with their rows exactly as they left them');
end $$;

-- ================================================= 1b. denied does it too
select test.as_user_aal('b1000000-0000-0000-0000-0000000000b1', 'aal2');
do $$
begin
  perform public.decide_access('b2000000-0000-0000-0000-0000000000b2', 'denied');
end $$;

select test.as_user_aal('b2000000-0000-0000-0000-0000000000b2', 'aal1');
do $$
begin
  perform test.check(not public.has_access(),
    '`denied` refuses an admin as well — the harsher word is not the weaker one');
end $$;

-- Put them back, so nothing after this file inherits a broken admin.
select test.as_user_aal('b1000000-0000-0000-0000-0000000000b1', 'aal2');
do $$
begin
  perform public.decide_access('b2000000-0000-0000-0000-0000000000b2', 'approved');
end $$;

-- ============================================ 4. an account with no row
reset role;
delete from public.access_request
 where user_id = 'b3000000-0000-0000-0000-0000000000b3';
set role authenticated;

select test.as_user_aal('b3000000-0000-0000-0000-0000000000b3', 'aal1');
do $$
begin
  perform test.check(not public.has_access(),
    'an account with no request row has no access — fail closed');
  perform test.check(public.my_access_status() ->> 'status' = 'unknown',
    '...and is told "unknown", which the apps hold exactly like pending');
end $$;

select test.as_user_aal('b1000000-0000-0000-0000-0000000000b1', 'aal2');
do $$
declare r jsonb;
begin
  /* 0021's decide_access() raised P0002 here: it could only UPDATE. "I cannot
   * revoke that one, it has no row" is not an answer an owner should be given
   * about their own product. */
  r := public.decide_access('b3000000-0000-0000-0000-0000000000b3', 'revoked',
                            'refused before they ever asked');
  perform test.check(r ->> 'status' = 'revoked',
    'an account that never filed a request can still be refused');
  perform test.check(r ->> 'email' = 'revoke-member@example.com',
    '...and the row it creates carries the address, so the queue still reads');
end $$;

-- And a genuine stranger is still refused, so the upsert did not become a way
-- to invent rows for accounts that do not exist.
do $$
declare blocked boolean := false;
begin
  begin
    perform public.decide_access('cccccccc-cccc-cccc-cccc-cccccccccccc', 'approved');
    perform test.check(false, 'deciding about a non-existent account must fail');
  exception when others then blocked := true;
  end;
  perform test.check(blocked, 'deciding about an account that does not exist is refused');
end $$;

-- ==================================== 5. and every decision is on the record
do $$
declare n integer;
begin
  select count(*) into n from public.owner_action_log
   where action = 'access_decide'
     and subject_id = 'b2000000-0000-0000-0000-0000000000b2';
  perform test.check(n >= 4,
    'every revoke and every restoration left an audit row');
end $$;

reset role;

do $$
begin
  raise notice 'ASSERTIONS COMPLETE  rls_test12 (revoke reaches every account)';
end $$;
