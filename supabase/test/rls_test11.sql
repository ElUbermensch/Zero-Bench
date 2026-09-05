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
-- Adversarial test: the beta gate from 0021.
--
-- Every other suite in this directory switches the gate OFF for its fixtures,
-- because they are about ownership and the gate would refuse their users for
-- the wrong reason. This is the one that leaves it on. It asserts:
--
--   1. filing is not optional -- a sign-up gets a pending row from a trigger,
--      not from a client call it could decline to make
--   2. pending means NOTHING: no read, no write, on any table the apps use
--   3. approved means what it did before 0021 and no more
--   4. revoking takes it back, in the same breath
--   5. no self-service. A waiting user cannot approve themselves through the
--      table, through the RPC, or through the marketing form
--   6. the owner's power is gated on the second factor, the same as the
--      analytics, and cannot be exercised without leaving an audit row
--   7. pair fire still works for anonymous guests, and only for them --
--      including through create_relay/join_relay, which are security definer
--      and never see a policy at all
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off

-- ---------------------------------------------------------------- fixtures
/* The metadata on the pending user is the point of the first assertion: this
 * is the shape GoTrue writes when the sign-up form passes `data`, and the
 * trigger has to find the answers there rather than being told them. */
insert into auth.users (id, email, raw_user_meta_data, is_anonymous) values
  ('a1000000-0000-0000-0000-0000000000a1', 'gate-owner@example.com',
   '{}'::jsonb, false),
  ('a2000000-0000-0000-0000-0000000000a2', 'gate-pending@example.com',
   '{"heard_from":"Podcast","heard_detail":"The Bullet Points, ep. 44"}'::jsonb, false),
  ('a3000000-0000-0000-0000-0000000000a3', 'gate-approved@example.com',
   '{}'::jsonb, false),
  ('a4000000-0000-0000-0000-0000000000a4', 'gate-revoked@example.com',
   '{}'::jsonb, false),
  ('a5000000-0000-0000-0000-0000000000a5', null, '{}'::jsonb, true)
on conflict do nothing;

insert into public.profiles (id, display_name, is_admin) values
  ('a1000000-0000-0000-0000-0000000000a1', 'Gate Owner', true)
on conflict (id) do update set is_admin = excluded.is_admin;

/* Defined here as well as in rls_test9 and rls_test10, for the reason
 * rls_test10 gives: a suite that only passes because an earlier one happened
 * to run is a suite that breaks the next time anything reorders them. */
create or replace function test.as_user(u uuid, anon boolean default false) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u::text, false);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', u::text, 'role', 'authenticated',
                       'is_anonymous', anon)::text, false);
end $$;

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

-- ================================================== 1. the trigger filed them
do $$
declare r public.access_request;
declare n integer;
begin
  select * into r from public.access_request
   where user_id = 'a2000000-0000-0000-0000-0000000000a2';
  perform test.check(r.user_id is not null,
    'a sign-up files an access request without the client asking');
  perform test.check(r.status = 'pending',
    '...and it starts pending, not approved');
  perform test.check(r.email = 'gate-pending@example.com',
    '...carrying the address, so the owner has something to decide about');
  perform test.check(r.heard_from = 'Podcast',
    '...and the marketing answer out of the sign-up metadata');
  perform test.check(r.heard_detail = 'The Bullet Points, ep. 44',
    '...including the free-text half, which is the actionable one');
  perform test.check(r.balance_cents = 0,
    'balance starts at zero -- nothing owed, nothing paid');

  select count(*) into n from public.access_request
   where user_id = 'a5000000-0000-0000-0000-0000000000a5';
  perform test.check(n = 0,
    'an anonymous pair-fire guest files nothing -- there is nobody to approve');
end $$;

-- Seed one row per gated table shape as postgres, so the reads below are
-- testing the GATE and not testing an empty table.
insert into public.firearms (id, user_id, name, cartridge) values
  ('a2f00000-0000-0000-0000-0000000000f1',
   'a2000000-0000-0000-0000-0000000000a2', 'Pending Rifle', '.308 Win'),
  ('a3f00000-0000-0000-0000-0000000000f2',
   'a3000000-0000-0000-0000-0000000000a3', 'Approved Rifle', '.308 Win')
on conflict (id) do nothing;

-- A published score, so "the board is still public" is a real assertion.
insert into public.leaderboard_profiles (id, handle) values
  ('a3000000-0000-0000-0000-0000000000a3', 'GateApproved')
on conflict (id) do nothing;

-- ============================================ 2. pending is refused everything
set role authenticated;
select test.as_user('a2000000-0000-0000-0000-0000000000a2');

do $$
declare n integer;
declare blocked boolean := false;
begin
  perform test.check(not public.has_access(),
    'a pending account does not have access');

  select count(*) into n from public.firearms;
  perform test.check(n = 0,
    'and cannot read its OWN rows -- the restrictive policy is on select too');

  begin
    insert into public.firearms (user_id, name, cartridge)
    values ('a2000000-0000-0000-0000-0000000000a2', 'Sneaked In', '6.5 CM');
    perform test.check(false, 'a pending account must not be able to write');
  exception when insufficient_privilege then blocked := true;
  end;
  perform test.check(blocked, 'a pending account cannot insert');

  update public.firearms set name = 'Renamed'
   where id = 'a2f00000-0000-0000-0000-0000000000f1';
  perform test.check(not found,
    '...cannot update the row it owns, because it cannot see it');

  delete from public.firearms where id = 'a2f00000-0000-0000-0000-0000000000f1';
  perform test.check(not found, '...and cannot delete it either');

  blocked := false;
  begin
    insert into public.account_backups (user_id, app, payload)
    values ('a2000000-0000-0000-0000-0000000000a2', 'zero', '{}');
    perform test.check(false, 'a pending account must not be able to back up');
  exception when insufficient_privilege then blocked := true;
  end;
  perform test.check(blocked, '...and cannot write a device backup');

  blocked := false;
  begin
    insert into public.leaderboard_profiles (id, handle)
    values ('a2000000-0000-0000-0000-0000000000a2', 'ShouldNotExist');
    perform test.check(false, 'a pending account must not be able to publish');
  exception when insufficient_privilege then blocked := true;
  end;
  perform test.check(blocked, '...and cannot claim a leaderboard handle');

  /* The board itself stays readable, and that is not an oversight. It is the
   * one screen a stranger is meant to see and the marketing site links to it;
   * a gate that emptied it would be advertising an empty product. */
  select count(*) into n from public.leaderboard_profiles;
  perform test.check(n > 0,
    'but the public leaderboard is still readable -- writes are gated, reads are not');
end $$;

-- ============================================= 3. pending cannot self-approve
do $$
declare n integer;
declare blocked boolean := false;
begin
  select count(*) into n from public.access_request;
  perform test.check(n = 0,
    'a waiting user cannot read the request table at all -- not even their own row');

  /* Two refusals, and the suite does not care which one fires. The privilege
   * is revoked (permission denied) AND there is no policy (zero rows
   * affected); 0021 says why it is both. What must never happen is the row
   * moving. */
  begin
    update public.access_request set status = 'approved'
     where user_id = 'a2000000-0000-0000-0000-0000000000a2';
    perform test.check(not found,
      'a waiting user cannot update themselves into approval');
  exception when insufficient_privilege then
    perform test.check(true,
      'a waiting user is not even granted UPDATE on the request table');
  end;

  begin
    insert into public.access_request (user_id, email, status)
    values ('a2000000-0000-0000-0000-0000000000a2', 'x@example.com', 'approved');
    perform test.check(false, 'a waiting user must not be able to file an approved row');
  exception when insufficient_privilege then blocked := true;
       when unique_violation then blocked := true;
  end;
  perform test.check(blocked, '...nor insert a fresh approved one over the top');

  -- What they CAN see is their own status, through the function written for it.
  perform test.check(public.my_access_status() ->> 'status' = 'pending',
    'my_access_status() tells them they are waiting');
  perform test.check(not (public.my_access_status() ? 'note'),
    '...without the owner''s private note, which the table could not have withheld');
  perform test.check(not (public.my_access_status() ? 'balance_cents'),
    '...nor the billing columns');

  blocked := false;
  begin
    perform public.decide_access('a2000000-0000-0000-0000-0000000000a2', 'approved');
    perform test.check(false, 'a waiting user must not be able to call decide_access');
  exception when insufficient_privilege then blocked := true;
  end;
  perform test.check(blocked, '...and the owner RPC refuses them outright');
end $$;

-- The marketing form is the one thing they may still submit.
do $$
declare r jsonb;
begin
  r := public.submit_access_details('Forum', 'Snipers Hide, the F-class thread');
  perform test.check(r ->> 'heard_from' = 'Forum',
    'a waiting user may correct how they heard about it');
  perform test.check(r ->> 'status' = 'pending',
    '...and doing so does not move their status a millimetre');
end $$;

reset role;
do $$
declare n integer;
begin
  select count(*) into n from public.access_request
   where user_id = 'a2000000-0000-0000-0000-0000000000a2'
     and heard_from = 'Forum'
     and heard_detail = 'Snipers Hide, the F-class thread';
  perform test.check(n = 1, 'the answer landed on the caller''s row');

  select count(*) into n from public.access_request
   where user_id <> 'a2000000-0000-0000-0000-0000000000a2'
     and heard_from = 'Forum';
  perform test.check(n = 0,
    '...and on nobody else''s — the update is scoped to auth.uid(), not to an argument');

  select count(*) into n from public.access_request
   where user_id = 'a2000000-0000-0000-0000-0000000000a2' and status = 'pending';
  perform test.check(n = 1, '...and did not move the status while it was there');
end $$;

-- ================================================== 4. the owner, and the lock
set role authenticated;
select test.as_user_aal('a1000000-0000-0000-0000-0000000000a1', 'aal1');

do $$
declare n integer;
declare blocked boolean := false;
begin
  perform test.check(public.is_admin(),
    'the owner is an admin on a password-only session');
  perform test.check(not public.is_admin_mfa(),
    '...but has not cleared the second factor');

  select count(*) into n from public.access_request;
  perform test.check(n = 0,
    'so the request queue -- every customer address in one list -- reads nothing');

  begin
    perform public.decide_access('a3000000-0000-0000-0000-0000000000a3', 'approved');
    perform test.check(false, 'approving on a password-only session must be refused');
  exception when insufficient_privilege then blocked := true;
  end;
  perform test.check(blocked,
    '...and approving is refused until the authenticator comes out');

  blocked := false;
  begin
    perform public.set_access_billing('a3000000-0000-0000-0000-0000000000a3', 'beta', 4900, 0);
    perform test.check(false, 'billing on a password-only session must be refused');
  exception when insufficient_privilege then blocked := true;
  end;
  perform test.check(blocked, '...as is touching the money');
end $$;

select test.as_user_aal('a1000000-0000-0000-0000-0000000000a1', 'aal2');

do $$
declare n integer;
declare r jsonb;
begin
  perform test.check(public.is_admin_mfa(), 'with the second factor, the owner is through');

  select count(*) into n from public.access_request;
  perform test.check(n >= 4, '...and the queue is readable');

  perform test.check(public.has_access(),
    'the owner has access without approving themselves — otherwise nobody could approve anybody');

  -- The money first, because that is the order it happens in: the payment
  -- lands, and then a person decides.
  r := public.set_access_billing('a3000000-0000-0000-0000-0000000000a3', 'beta', 4900, 4900);
  perform test.check((r ->> 'balance_cents')::integer = 0,
    'a paid-in-full account shows a balance of zero — "the balance is met"');
  perform test.check(r ->> 'status' = 'pending',
    '...and taking the payment did not, on its own, let them in');

  r := public.set_access_billing('a4000000-0000-0000-0000-0000000000a4', null, 4900, 0);
  perform test.check((r ->> 'balance_cents')::integer = 4900,
    'an unpaid account carries the balance the owner would be looking at');
  perform test.check(r ->> 'plan' is null,
    'a null argument leaves a field alone rather than blanking it');

  r := public.decide_access('a3000000-0000-0000-0000-0000000000a3', 'approved', 'paid up');
  perform test.check(r ->> 'status' = 'approved', 'the owner approves');
  perform test.check(r ->> 'note' = 'paid up', '...with the reason recorded on the row');

  r := public.decide_access('a4000000-0000-0000-0000-0000000000a4', 'approved');
  perform test.check(r ->> 'status' = 'approved', 'and approves the second account');

  -- An empty note must not erase the one already there.
  r := public.decide_access('a3000000-0000-0000-0000-0000000000a3', 'approved', '   ');
  perform test.check(r ->> 'note' = 'paid up',
    'a blank note leaves the previous reason standing rather than wiping it');

  select count(*) into n from public.owner_action_log
   where action = 'access_decide'
     and subject_id = 'a3000000-0000-0000-0000-0000000000a3';
  perform test.check(n >= 2,
    'every decision left an audit row, in the same transaction as the decision');

  select count(*) into n from public.owner_action_log where action = 'access_billing';
  perform test.check(n >= 2, '...and so did every touch of the money');
end $$;

-- An unknown status is refused rather than stored, or the CHECK on the column
-- would be the only thing standing between a typo and a broken gate.
do $$
declare blocked boolean := false;
begin
  begin
    perform public.decide_access('a3000000-0000-0000-0000-0000000000a3', 'aproved');
    perform test.check(false, 'a misspelled status must be refused');
  exception when others then blocked := true;
  end;
  perform test.check(blocked, 'decide_access refuses a status it does not know');

  blocked := false;
  begin
    perform public.decide_access('99999999-9999-9999-9999-999999999999', 'approved');
    perform test.check(false, 'approving a stranger must be refused');
  exception when others then blocked := true;
  end;
  perform test.check(blocked, '...and refuses an account that filed no request');
end $$;

-- ==================================================== 5. approved works again
select test.as_user('a3000000-0000-0000-0000-0000000000a3');

do $$
declare n integer;
begin
  perform test.check(public.has_access(), 'an approved account has access');

  select count(*) into n from public.firearms;
  perform test.check(n = 1, '...and sees its own rows, exactly as before 0021');

  insert into public.firearms (user_id, name, cartridge)
  values ('a3000000-0000-0000-0000-0000000000a3', 'Second Rifle', '6.5 CM');
  perform test.check(true, '...and can write');

  select count(*) into n from public.firearms
   where user_id = 'a2000000-0000-0000-0000-0000000000a2';
  perform test.check(n = 0,
    'approval is not a promotion — it still sees nobody else''s rows');

  perform test.check(public.my_access_status() ->> 'status' = 'approved',
    'and is told so');
end $$;

-- ======================================================= 6. revoking takes it
reset role;
set role authenticated;
select test.as_user_aal('a1000000-0000-0000-0000-0000000000a1', 'aal2');

do $$
declare r jsonb;
begin
  r := public.decide_access('a4000000-0000-0000-0000-0000000000a4', 'revoked',
                            'chargeback');
  perform test.check(r ->> 'status' = 'revoked', 'the owner revokes');
end $$;

select test.as_user('a4000000-0000-0000-0000-0000000000a4');

do $$
declare n integer;
declare blocked boolean := false;
begin
  perform test.check(not public.has_access(),
    'a revoked account loses access immediately — no session to wait out');

  select count(*) into n from public.firearms;
  perform test.check(n = 0, '...and its rows go dark, without being deleted');

  begin
    insert into public.firearms (user_id, name, cartridge)
    values ('a4000000-0000-0000-0000-0000000000a4', 'After Revoke', '.223 Rem');
    perform test.check(false, 'a revoked account must not be able to write');
  exception when insufficient_privilege then blocked := true;
  end;
  perform test.check(blocked, '...and cannot write');

  perform test.check(public.my_access_status() ->> 'status' = 'revoked',
    'and is told which of the two refusals this is — revoked, not denied');

  /* The distinction earns its keep here. Both refuse; only one of them
   * answers "it worked yesterday". */
  perform test.check(public.my_access_status() ->> 'decided_at' is not null,
    '...and when it happened, which is the first thing support asks');
end $$;

-- ================================================= 7. pair fire still works
reset role;

/* The relay fixtures are built as postgres because create_relay is the only
 * way in and it is what we are about to test. */
set role authenticated;
select test.as_user('a3000000-0000-0000-0000-0000000000a3');

do $$
declare rel public.relays;
begin
  perform test.check(public.may_relay(), 'an approved account may open a relay');
  rel := public.create_relay('Approved', 'Test Relay', 'F-Class', null, 100);
  perform test.check(rel.code is not null, '...and does');
  perform set_config('test.relay_code', rel.code, false);
end $$;

-- The guest: anonymous, never approved, and the whole point of the exception.
select test.as_user('a5000000-0000-0000-0000-0000000000a5', true);

do $$
begin
  perform test.check(public.may_relay(),
    'an anonymous guest may join — they have no account to approve');
  perform test.check(not public.has_access(),
    '...while still having no access to anything else');

  perform public.join_relay(current_setting('test.relay_code'), 'Guest', 'coach', null);
  perform test.check(true, 'and the join goes through');
end $$;

-- The account that has not been let in: refused, even though create_relay is
-- security definer and never sees a policy.
select test.as_user('a2000000-0000-0000-0000-0000000000a2');

do $$
declare blocked boolean := false;
begin
  perform test.check(not public.may_relay(), 'a pending account may not relay');

  begin
    perform public.create_relay('Pending', 'Sneak', 'F-Class', null, 100);
    perform test.check(false,
      'a pending account must not open a relay through the definer function');
  exception when insufficient_privilege then blocked := true;
  end;
  perform test.check(blocked,
    'create_relay is refused by the trigger, which definer rights cannot skip');

  blocked := false;
  begin
    perform public.join_relay(current_setting('test.relay_code'), 'Sneak', 'coach', null);
    perform test.check(false, 'a pending account must not join a relay either');
  exception when insufficient_privilege then blocked := true;
       when others then blocked := true;
  end;
  perform test.check(blocked, '...and joining is refused the same way');
end $$;

reset role;

do $$
begin
  raise notice 'ASSERTIONS COMPLETE  rls_test11 (beta access gate)';
end $$;
