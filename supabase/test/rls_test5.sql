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
-- Firearms: the one record both apps own.
--
-- Zero writes barrel life and the starting round count; Bench writes barrel
-- length, twist, sight height and zero range. Neither app models the other's
-- fields, so the whole arrangement rests on one claim: a write that names only
-- SOME of a row's columns leaves the rest alone.
--
-- That claim is checked here in SQL, against the statement PostgREST actually
-- generates for an upsert -- INSERT ... ON CONFLICT (id) DO UPDATE SET, with
-- the column list built from the keys present in the payload. What this file
-- proves is the database half: given that statement, the other app's columns
-- survive. That PostgREST emits exactly that statement is the client's half,
-- and is covered by tools/test-cross-app.mjs driving both real apps.
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off

insert into auth.users (id, email) values
  ('66666666-6666-6666-6666-666666666666', 'other@example.com')
on conflict do nothing;

set role authenticated;
select test.as_user('11111111-1111-1111-1111-111111111111');

-- ================================================= the columns and their limits
do $$
declare fid uuid;
begin
  insert into public.firearms (name, cartridge, barrel_life_rounds, rounds_at_start)
  values ('Tikka T3x', '6.5 Creedmoor', 2800, 120)
  returning id into fid;
  perform test.check(fid is not null, 'a firearm carries barrel life and a starting count');

  begin
    insert into public.firearms (name, cartridge, barrel_life_rounds)
    values ('Bad', '.308 Win', 0);
    perform test.check(false, 'a barrel life of zero must be refused');
  exception when check_violation then
    perform test.check(true, 'barrel life must be positive or absent, never zero');
  end;

  begin
    insert into public.firearms (name, cartridge, rounds_at_start)
    values ('Bad', '.308 Win', -1);
    perform test.check(false, 'a negative starting count must be refused');
  exception when check_violation then
    perform test.check(true, 'the starting round count cannot be negative');
  end;

  -- Absent, not zero: a rifle whose expected life nobody has decided yet.
  insert into public.firearms (name, cartridge) values ('Unknown life', '.223 Rem');
  perform test.check(
    (select barrel_life_rounds is null and rounds_at_start = 0
       from public.firearms where name = 'Unknown life'),
    'barrel life defaults to unknown and the starting count to zero');

  create temporary table _gun as select fid as id;
end $$;

-- ======================= a partial write touches its own columns and no others
do $$
declare gid uuid; r public.firearms;
begin
  select id into gid from _gun;

  -- BENCH's write: geometry only. This is the shape PostgREST builds from a
  -- payload of {id, name, cartridge, barrel_in, twist, sight_height_in,
  -- zero_range_yd, notes} -- note that barrel_life_rounds is absent, and so
  -- must not appear in the SET list.
  insert into public.firearms as f (id, name, cartridge, barrel_in, twist,
                                    sight_height_in, zero_range_yd, notes)
  values (gid, 'Tikka T3x', '6.5 Creedmoor', 24, '1:8', 1.75, 100, 'match barrel')
  on conflict (id) do update set
    name = excluded.name, cartridge = excluded.cartridge,
    barrel_in = excluded.barrel_in, twist = excluded.twist,
    sight_height_in = excluded.sight_height_in,
    zero_range_yd = excluded.zero_range_yd, notes = excluded.notes;

  select * into r from public.firearms where id = gid;
  perform test.check(r.barrel_in = 24 and r.twist = '1:8', 'Bench''s geometry landed');
  perform test.check(r.barrel_life_rounds = 2800 and r.rounds_at_start = 120,
    'and Zero''s barrel life survived a write that never mentioned it');

  -- ZERO's write: its own columns only, over the top of Bench's.
  insert into public.firearms as f (id, name, cartridge, notes,
                                    barrel_life_rounds, rounds_at_start)
  values (gid, 'Tikka T3x', '6.5 Creedmoor', 'match barrel', 3000, 120)
  on conflict (id) do update set
    name = excluded.name, cartridge = excluded.cartridge, notes = excluded.notes,
    barrel_life_rounds = excluded.barrel_life_rounds,
    rounds_at_start = excluded.rounds_at_start;

  select * into r from public.firearms where id = gid;
  perform test.check(r.barrel_life_rounds = 3000, 'Zero''s rebarrel landed');
  perform test.check(r.barrel_in = 24 and r.twist = '1:8' and r.sight_height_in = 1.75,
    'and Bench''s geometry survived in turn — neither app can erase the other');
end $$;

-- ===================================================== the stamp is the server's
do $$
declare gid uuid; before timestamptz; after timestamptz;
begin
  select id into gid from _gun;
  select updated_at into before from public.firearms where id = gid;
  perform pg_sleep(0.01);
  update public.firearms set notes = 'restamped' where id = gid;
  select updated_at into after from public.firearms where id = gid;
  perform test.check(after > before,
    'updated_at is moved by the server on every write — it is what the pull cursor reads');
end $$;

-- ============================================ a shared row is still a private row
select test.as_user('66666666-6666-6666-6666-666666666666');
do $$
declare gid uuid; n integer;
begin
  select id into gid from _gun;
  select count(*) into n from public.firearms where id = gid;
  perform test.check(n = 0, 'another account cannot read this firearm');

  update public.firearms set name = 'stolen' where id = gid;
  select count(*) into n from public.firearms where id = gid and name = 'stolen';
  perform test.check(n = 0, 'nor rename it — RLS is what makes one shared table safe');
end $$;

-- ============================================== a tombstone is an UPDATE, not an upsert
-- This is the assertion that found a shipped bug. zero-core queued a delete as
-- an upsert of {id, deleted_at}; an upsert is INSERT ... ON CONFLICT, Postgres
-- forms the insert tuple BEFORE it looks for the conflict, and the tuple has no
-- name. Every delete was refused, dead-lettered as permanently unacceptable,
-- and silently dropped -- while the queue drained and the app reported success.
select test.as_user('11111111-1111-1111-1111-111111111111');
do $$
declare gid uuid;
begin
  select id into gid from _gun;

  begin
    insert into public.firearms as f (id, deleted_at)
    values (gid, now())
    on conflict (id) do update set deleted_at = excluded.deleted_at;
    perform test.check(false,
      'a partial upsert must not be able to stand in for a delete');
  exception when not_null_violation then
    perform test.check(true,
      'an upsert carrying only {id, deleted_at} is refused: the insert branch has no name');
  end;

  -- What the client does now.
  update public.firearms set deleted_at = now() where id = gid;

  perform test.check(
    (select deleted_at is not null from public.firearms where id = gid),
    'a delete is a tombstone the other app can pull, not a row that vanishes');
  perform test.check(
    (select name from public.firearms where id = gid) = 'Tikka T3x',
    'and it does not disturb the rest of the row');
end $$;

reset role;
\echo ''
\echo 'FIREARM SHARING ASSERTIONS PASSED'
