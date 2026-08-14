-- ============================================================================
-- Leaderboard RLS: the asymmetry must hold in BOTH directions.
-- Reads are open across accounts; writes are strictly own-rows.
-- Runs after rls_test.sql, as the non-superuser `authenticated` role.
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off

set role authenticated;

-- ============================================================ user A publishes
select test.as_user('11111111-1111-1111-1111-111111111111');

insert into public.leaderboard_profiles (id, handle)
values ('11111111-1111-1111-1111-111111111111', 'Jaxon');

insert into public.leaderboard_entries
  (id, occurred_on, position, target_name, distance_yd, shot_count, score, x_count, mr_moa, es_moa)
values
  ('ee000000-0000-0000-0000-000000000001', date '2026-08-13', 'Standing',
   'NRA B-8', 100, 10, 95, 3, 1.42, 3.10);

do $$
declare blocked boolean;
begin
  -- plausibility constraints
  blocked := false;
  begin
    insert into public.leaderboard_entries
      (occurred_on, position, target_name, distance_yd, shot_count, score)
    values (current_date, 'Prone', 'B-8', 100, 10, 700);
  exception when check_violation then blocked := true; end;
  perform test.check(blocked, 'constraint: a 10-shot 700 is rejected as implausible');

  blocked := false;
  begin
    insert into public.leaderboard_entries
      (occurred_on, position, target_name, distance_yd, shot_count, score, x_count)
    values (current_date, 'Prone', 'B-8', 100, 10, 90, 11);
  exception when check_violation then blocked := true; end;
  perform test.check(blocked, 'constraint: more X''s than shots is rejected');

  blocked := false;
  begin
    insert into public.leaderboard_profiles (id, handle)
    values ('11111111-1111-1111-1111-111111111111', 'bad handle!');
  exception when others then blocked := true; end;
  perform test.check(blocked, 'constraint: handle shape is enforced');
end $$;

-- ============================================================ user B's side
select test.as_user('22222222-2222-2222-2222-222222222222');

do $$
declare n integer; blocked boolean;
begin
  -- THE FEATURE: B reads A's public rows
  select count(*) into n from public.leaderboard_entries
   where user_id = '11111111-1111-1111-1111-111111111111';
  perform test.check(n = 1, 'public read: B sees A''s leaderboard entry via the table');

  select count(*) into n from public.v_leaderboard where handle = 'Jaxon';
  perform test.check(n = 1, 'public read: B sees A''s entry with A''s handle via the view');

  -- but PRIVATE tables are still private
  select count(*) into n from public.batches
   where user_id = '11111111-1111-1111-1111-111111111111';
  perform test.check(n = 0, 'isolation: the open leaderboard changed nothing for private tables');

  -- and B cannot touch A's public rows
  update public.leaderboard_entries set score = 0
   where id = 'ee000000-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  perform test.check(n = 0, 'write guard: B cannot rewrite A''s score');

  delete from public.leaderboard_entries
   where id = 'ee000000-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  perform test.check(n = 0, 'write guard: B cannot delete A''s entry');

  update public.leaderboard_profiles set handle = 'stolen'
   where id = '11111111-1111-1111-1111-111111111111';
  get diagnostics n = row_count;
  perform test.check(n = 0, 'write guard: B cannot rename A');

  blocked := false;
  begin
    insert into public.leaderboard_entries
      (user_id, occurred_on, position, target_name, distance_yd, shot_count, score)
    values ('11111111-1111-1111-1111-111111111111', current_date, 'Prone', 'B-8', 100, 10, 1);
  exception when insufficient_privilege then blocked := true; end;
  perform test.check(blocked, 'write guard: B cannot plant an entry under A''s account');

  -- handle squatting: case-insensitive collision
  blocked := false;
  begin
    insert into public.leaderboard_profiles (id, handle)
    values ('22222222-2222-2222-2222-222222222222', 'JAXON');
  exception when unique_violation then blocked := true; end;
  perform test.check(blocked, 'handles: case-insensitive uniqueness (JAXON = Jaxon)');

  insert into public.leaderboard_profiles (id, handle)
  values ('22222222-2222-2222-2222-222222222222', 'Rival');
  insert into public.leaderboard_entries
    (occurred_on, position, target_name, distance_yd, shot_count, score, x_count)
  values (current_date, 'Standing', 'NRA B-8', 100, 10, 97, 5);

  select count(*) into n from public.v_leaderboard
   where position = 'Standing' and distance_yd = 100;
  perform test.check(n = 2, 'the class view now holds both shooters'' entries');
end $$;

-- A retracts: soft delete hides it from everyone, keeps the tombstone
select test.as_user('11111111-1111-1111-1111-111111111111');
update public.leaderboard_entries set deleted_at = now()
 where id = 'ee000000-0000-0000-0000-000000000001';

select test.as_user('22222222-2222-2222-2222-222222222222');
do $$
declare n integer;
begin
  select count(*) into n from public.v_leaderboard where handle = 'Jaxon';
  perform test.check(n = 0, 'retraction: a soft-deleted entry leaves the leaderboard for everyone');
end $$;

reset role;
\echo ''
\echo 'LEADERBOARD ASSERTIONS PASSED'

-- ============================================================ keepalive probe
set role anon;
do $$
declare t timestamptz; n integer;
begin
  select public.keepalive() into t;
  perform test.check(t is not null, 'keepalive: callable by the anon role (the scheduled ping is unauthenticated)');

  -- it must remain a null-information function: anon still sees no data
  begin
    select count(*) into n from public.leaderboard_entries;
    perform test.check(false, 'keepalive grant must not have opened table access to anon');
  exception when insufficient_privilege then
    perform test.check(true, 'keepalive: granting anon EXECUTE did not open any table to anon');
  end;
end $$;
reset role;
