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
-- Live relay: the code is a capability, and the capability must be narrow.
-- Three actors: HOST (shooter), COACH (invited), STRANGER (has no code).
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off

insert into auth.users (id, email) values
  ('33333333-3333-3333-3333-333333333333', 'coach@example.com'),
  ('44444444-4444-4444-4444-444444444444', 'stranger@example.com')
on conflict do nothing;

set role authenticated;

-- ============================================================== host goes live
select test.as_user('11111111-1111-1111-1111-111111111111');

do $$
declare r public.relays; n integer;
begin
  select * into r from public.create_relay('Jaxon', 'Sunday league', 'NRA B-8', null, 100);
  perform test.check(r.code ~ '^[2-9BCDFGHJKMNPQRSTVWXZ]{4}$',
                     'code is 4 chars from the unambiguous, vowel-free alphabet: ' || r.code);
  perform test.check(r.status = 'live', 'the relay starts live');
  perform test.check(r.expires_at > now(), 'the relay has an expiry');

  -- the host is automatically a participant, so one policy set covers everyone
  select count(*) into n from public.relay_participants
   where relay_id = r.id and user_id = auth.uid();
  perform test.check(n = 1, 'the host joins their own relay automatically');

  -- stash for later blocks
  create temporary table _relay as select r.id as id, r.code as code;
end $$;

-- host logs shots
do $$
declare rid uuid;
begin
  select id into rid from _relay;
  insert into public.relay_shots (relay_id, shot_no, ring, x_in, y_in)
  values (rid, 1, '10', 0.0, 0.0), (rid, 2, 'X', 0.30, 0.10), (rid, 3, '9', -0.55, 0.20);
  perform test.check(true, 'the host can log shots into the relay');
end $$;

-- ============================================================ starting a second
do $$
declare r2 public.relays; live_count integer;
begin
  select * into r2 from public.create_relay('Jaxon', 'Second string');
  select count(*) into live_count from public.relays
   where host_id = auth.uid() and status = 'live';
  perform test.check(live_count = 1,
    'going live again ends the previous relay -- one live relay per shooter');
  -- put things back: end the new one, restart the original for the rest of the tests
  perform public.end_relay(r2.id);
end $$;

do $$
declare r public.relays;
begin
  select * into r from public.create_relay('Jaxon', 'Sunday league', 'NRA B-8', null, 100);
  delete from _relay;
  insert into _relay select r.id, r.code;
  insert into public.relay_shots (relay_id, shot_no, ring, x_in, y_in)
  values (r.id, 1, '10', 0.0, 0.0), (r.id, 2, 'X', 0.30, 0.10), (r.id, 3, '9', -0.55, 0.20);
end $$;

-- ================================================================ the stranger
select test.as_user('44444444-4444-4444-4444-444444444444');
do $$
declare n integer; rid uuid; blocked boolean := false;
begin
  select id into rid from _relay;

  select count(*) into n from public.relays;
  perform test.check(n = 0, 'a stranger cannot list relays at all');

  select count(*) into n from public.relays where id = rid;
  perform test.check(n = 0, 'a stranger cannot read the relay even knowing its id');

  select count(*) into n from public.relay_shots where relay_id = rid;
  perform test.check(n = 0, 'a stranger cannot read the shot string');

  select count(*) into n from public.relay_participants where relay_id = rid;
  perform test.check(n = 0, 'a stranger cannot enumerate participants');

  -- and cannot force their way in by writing a participant row directly
  begin
    insert into public.relay_participants (relay_id, user_id, name, role)
    values (rid, auth.uid(), 'gatecrasher', 'coach');
    perform test.check(false, 'a stranger must not be able to self-insert a participant row');
  exception when insufficient_privilege then
    perform test.check(true, 'a stranger cannot self-insert a participant row -- join_relay is the only door');
  end;

  -- a wrong code is refused
  perform test.check((public.join_relay('ZZZZ', 'gatecrasher', 'coach') ->> 'ok') = 'false',
                     'a bad code is refused');
end $$;

-- ============================================================ throttling works
do $$
declare i integer; throttled boolean := false;
begin
  -- 10 failures is the budget; the 11th must be refused on the throttle, not
  -- on the lookup, so a determined guesser gains nothing by continuing.
  for i in 1..12 loop
    if (public.join_relay('BBBB', 'x', 'coach') ->> 'error') = 'throttled' then
      throttled := true;
    end if;
  end loop;
  perform test.check(throttled, 'repeated wrong codes trip the per-user throttle');
end $$;

-- The attempts table is readable by nobody (that is the point), so verify the
-- rows actually persisted from outside RLS. This is the regression test for
-- the RAISE-rolls-back-the-insert bug: with a RAISE, this count was zero and
-- the throttle could never trip.
reset role;
do $$
declare n integer;
begin
  select count(*) into n from public.relay_join_attempts where not ok;
  perform test.check(n >= 10,
    'failed attempts persist (a RAISE would have rolled every one of them back)');
end $$;
set role authenticated;
select test.as_user('44444444-4444-4444-4444-444444444444');

-- ================================================================= the coach
select test.as_user('33333333-3333-3333-3333-333333333333');
do $$
declare code text; rid uuid; res jsonb; n integer; st jsonb;
begin
  select _relay.code, _relay.id into code, rid from _relay;

  res := public.join_relay(code, 'Coach Dave', 'coach');
  perform test.check((res ->> 'ok') = 'true', 'a valid code joins the relay');
  perform test.check((res -> 'relay' ->> 'id')::uuid = rid, '...and returns that relay');

  select count(*) into n from public.relay_shots where relay_id = rid;
  perform test.check(n = 3, 'the coach now sees the full shot string');

  -- lowercase and padding must still work: this gets read aloud on a firing line
  perform public.join_relay(lower('  ' || code || '  '), 'Coach Dave', 'coach');
  perform test.check(true, 'the code is accepted lowercase and padded');

  -- one round trip returns everything the viewer needs
  st := public.relay_state(rid);
  perform test.check(jsonb_array_length(st->'shots') = 3, 'relay_state returns the shots');
  perform test.check(jsonb_array_length(st->'participants') = 2, 'relay_state lists both people');
  perform test.check((st->'relay'->>'status') = 'live', 'relay_state reports status');

  -- the feed is two-way
  insert into public.relay_messages (relay_id, author_name, kind, body)
  values (rid, 'Coach Dave', 'wind', 'half value from 4, hold 0.5L');
  perform test.check(true, 'the coach can post to the feed');

  -- but a coach must never be able to fabricate the shooter's string
  begin
    insert into public.relay_shots (relay_id, shot_no, ring, x_in, y_in)
    values (rid, 99, 'X', 0, 0);
    perform test.check(false, 'a coach must not be able to log shots');
  exception when insufficient_privilege then
    perform test.check(true, 'a coach cannot log shots -- only the host writes the string');
  end;

  -- nor end someone else's relay
  begin
    perform public.end_relay(rid);
    perform test.check(false, 'a coach must not be able to end the relay');
  exception when others then
    perform test.check(true, 'only the host can end the relay');
  end;
end $$;

-- incremental polling: only what is new
do $$
declare rid uuid; cutoff timestamptz; st jsonb;
begin
  select id into rid from _relay;
  cutoff := now();
  perform pg_sleep(0.05);
  perform test.as_user('11111111-1111-1111-1111-111111111111');
  insert into public.relay_shots (relay_id, shot_no, ring, x_in, y_in)
  values (rid, 4, '10', 0.1, -0.2);

  perform test.as_user('33333333-3333-3333-3333-333333333333');
  st := public.relay_state(rid, cutoff, cutoff);
  perform test.check(jsonb_array_length(st->'shots') = 1,
                     'polling with a cursor returns only the new shot');

  -- the tie case that a strict > cursor drops on the floor
  perform test.as_user('11111111-1111-1111-1111-111111111111');
  insert into public.relay_shots (relay_id, shot_no, ring, x_in, y_in)
  values (rid, 5, '9', 0.4, 0.1), (rid, 6, '10', -0.1, 0.3);
  perform test.as_user('33333333-3333-3333-3333-333333333333');
  st := public.relay_state(rid, cutoff, cutoff);
  perform test.check(jsonb_array_length(st->'shots') = 3,
    'two shots sharing one timestamp both arrive (a strict > cursor loses them)');
end $$;

-- ============================================================ ending the relay
select test.as_user('11111111-1111-1111-1111-111111111111');
do $$
declare rid uuid; code text; n integer;
begin
  select id, _relay.code into rid, code from _relay;
  perform public.end_relay(rid);

  select count(*) into n from public.relays where id = rid and status = 'ended';
  perform test.check(n = 1, 'the host can end the relay');

  -- the code stops working the moment the relay ends
  perform test.as_user('44444444-4444-4444-4444-444444444444');
  perform test.check((public.join_relay(code, 'late', 'coach') ->> 'ok') = 'false',
                     'the code stops working once the relay ends');
end $$;

-- an expired relay is likewise unreachable
select test.as_user('11111111-1111-1111-1111-111111111111');
do $$
declare r public.relays;
begin
  select * into r from public.create_relay('Jaxon', 'stale');
  update public.relays set expires_at = now() - interval '1 minute' where id = r.id;

  perform test.as_user('33333333-3333-3333-3333-333333333333');
  perform test.check((public.join_relay(r.code, 'late', 'coach') ->> 'ok') = 'false',
                     'an expired relay is not joinable even while marked live');
end $$;

-- ================================================ anonymous users and the board
-- Anonymous devices exist so the relay needs no accounts. They must not be
-- able to publish scores, or the leaderboard is trivially spammable.
select test.as_user('11111111-1111-1111-1111-111111111111');
do $$
declare blocked boolean := false;
begin
  perform test.as_user('11111111-1111-1111-1111-111111111111', true);   -- anonymous
  begin
    insert into public.leaderboard_entries
      (occurred_on, position, target_name, distance_yd, shot_count, score)
    values (current_date, 'Standing', 'B-8', 100, 10, 99);
  exception when insufficient_privilege then blocked := true;
  end;
  perform test.check(blocked, 'an anonymous device cannot publish to the leaderboard');

  -- ...but the SAME user, signed in properly, still can
  perform test.as_user('11111111-1111-1111-1111-111111111111', false);
  insert into public.leaderboard_entries
    (occurred_on, position, target_name, distance_yd, shot_count, score)
  values (current_date, 'Prone', 'B-8', 100, 10, 98);
  perform test.check(true, '...while a permanent account still can');
end $$;

reset role;
\echo ''
\echo 'RELAY ASSERTIONS PASSED'
