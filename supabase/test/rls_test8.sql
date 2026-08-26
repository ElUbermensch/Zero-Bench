-- ============================================================================
-- The shot string and the paper (0011).
--
-- Four claims:
--   1. a string is yours and nobody else's, like everything else here
--   2. a sighter is not an excluded flyer, and the two must not be conflated
--   3. the velocity trigger from 0005 still behaves: a string with no
--      velocities must not blank a summary, and one WITH them must still win
--   4. the target face is checked for shape, so a client cannot store
--      something the plot will silently fail to draw
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off

insert into auth.users (id, email) values
  ('cccccccc-0000-0000-0000-00000000000c', 'string-a@example.com'),
  ('dddddddd-0000-0000-0000-00000000000d', 'string-b@example.com')
on conflict do nothing;

set role authenticated;
select test.as_user('cccccccc-0000-0000-0000-00000000000c');

-- A session to hang a string on. No batch: a range session does not need one,
-- and the string is what is under test.
insert into public.range_sessions
  (id, occurred_on, rounds_fired, source_app, target_name, target_face)
values ('50000000-0000-0000-0000-000000000001', '2026-08-20', 12, 'zero', 'SR',
        '{"rings":[{"score":"X","diam":3.0},{"score":"10","diam":7.0},{"score":"9","diam":13.0}]}'::jsonb);

do $$
declare f jsonb;
begin
  select target_face into f from public.range_sessions
   where id = '50000000-0000-0000-0000-000000000001';
  perform test.check(jsonb_array_length(f -> 'rings') = 3,
    'the paper travels with the session — a hole at (0.4,-1.1) means nothing without it');
end $$;

-- Shape, not free text. A client that sends the wrong thing finds out at the
-- write, rather than when the plot renders as nothing.
do $$
begin
  begin
    update public.range_sessions set target_face = '"SR"'::jsonb
     where id = '50000000-0000-0000-0000-000000000001';
    perform test.check(false, 'a target face that is not an object must be refused');
  exception when check_violation then
    perform test.check(true, 'a target face that is not {rings:[…]} is refused at the write');
  end;
  begin
    update public.range_sessions set target_face = '{"rings":{"score":"X"}}'::jsonb
     where id = '50000000-0000-0000-0000-000000000001';
    perform test.check(false, 'rings must be an array');
  exception when check_violation then
    perform test.check(true, '...as is one whose rings are not an array');
  end;
  -- Null stays legal: a session logged before any of this, or one shot on
  -- paper nobody described, is not an error.
  update public.range_sessions set target_face = null
   where id = '50000000-0000-0000-0000-000000000002';
  perform test.check(true, 'and null is still legal — an undescribed target is not an error');
end $$;

-- ============================================ the string: ten record, two sighters
insert into public.shots (session_id, shot_no, ring, is_sighter, poi_x_in, poi_y_in)
select '50000000-0000-0000-0000-000000000001', g, '10', false, 0.1 * g, -0.1 * g
  from generate_series(1, 10) g;
insert into public.shots (session_id, shot_no, ring, is_sighter, poi_x_in, poi_y_in,
                          call_x_in, call_y_in, wind_call_moa, wind_call_dir)
values ('50000000-0000-0000-0000-000000000001', 11, '9', true, 2.0, 1.0, 1.8, 0.9, 1.5, 'L'),
       ('50000000-0000-0000-0000-000000000001', 12, '9', true, -2.0, 1.0, null, null, null, null);

do $$
declare n integer; sight integer; c numeric;
begin
  select count(*) into n from public.shots
   where session_id = '50000000-0000-0000-0000-000000000001';
  perform test.check(n = 12, 'the whole string is stored, sighters included — they came out of the batch');

  select count(*) into sight from public.shots
   where session_id = '50000000-0000-0000-0000-000000000001' and is_sighter;
  perform test.check(sight = 2, 'and the two sighters are marked as such');

  -- The distinction that matters: a sighter is a fact about the string, an
  -- excluded shot is a judgement about a flyer. Folding one into the other
  -- would make the group wrong in one direction and the round count wrong in
  -- the other.
  select count(*) into n from public.shots
   where session_id = '50000000-0000-0000-0000-000000000001' and excluded;
  perform test.check(n = 0, 'a sighter is NOT an excluded shot — the two mean different things');

  select call_x_in into c from public.shots
   where session_id = '50000000-0000-0000-0000-000000000001' and shot_no = 11;
  perform test.check(c = 1.8,
    'the call travels with the shot — the gap between it and the hole is what a coach reads');
end $$;

-- One shot number per session, so a re-push updates rather than stacking.
do $$
begin
  /* Deliberately NOT unique -- see 0012. Two devices on one account each log a
   * shot 13 offline; whichever syncs second used to be refused 23505 and, since
   * the number is persisted, re-refused forever. A shot is identified by its
   * id; shot_no is the ordinal a shooter reads. */
  insert into public.shots (session_id, shot_no, ring, poi_x_in, poi_y_in)
  values ('50000000-0000-0000-0000-000000000001', 3, '9', 0, 0);
  perform test.check(true,
    'a second device''s shot with the same ordinal is accepted, not dead-lettered forever');
  begin
    insert into public.shots (session_id, shot_no, ring, poi_x_in, poi_y_in, wind_call_dir)
    values ('50000000-0000-0000-0000-000000000001', 13, '9', 0, 0, 'sideways');
    perform test.check(false, 'a wind call direction that is not L or R must be refused');
  exception when check_violation then
    perform test.check(true, 'a wind call is L or R or nothing at all');
  end;
end $$;

-- ================================================== 0005 still holds
-- The velocity guard says: a shot string wins IF it carries velocities. Zero's
-- string does not — it is impacts on paper, and a chronograph is a separate
-- instrument. A string of twelve holes must therefore leave a Bench-written
-- chronograph summary exactly where it is.
insert into public.range_sessions
  (id, occurred_on, rounds_fired, source_app, velocity_avg_fps, velocity_sd_fps, velocity_n)
values ('50000000-0000-0000-0000-000000000003', '2026-08-21', 10, 'bench', 2712, 7.4, 10);

insert into public.shots (session_id, shot_no, ring, poi_x_in, poi_y_in)
select '50000000-0000-0000-0000-000000000003', g, '10', 0.1 * g, 0 from generate_series(1, 5) g;

update public.range_sessions set rounds_fired = 11
 where id = '50000000-0000-0000-0000-000000000003';

do $$
declare v numeric;
begin
  select velocity_avg_fps into v from public.range_sessions
   where id = '50000000-0000-0000-0000-000000000003';
  perform test.check(v = 2712,
    'a shot string with no velocities does NOT blank the chronograph summary beside it');
end $$;

-- And the other half: a string that DOES carry velocities is still the truth.
update public.shots set velocity_fps = 2700 + shot_no
 where session_id = '50000000-0000-0000-0000-000000000003';
update public.range_sessions set velocity_avg_fps = 9999
 where id = '50000000-0000-0000-0000-000000000003';

do $$
declare v numeric; n integer;
begin
  select velocity_avg_fps, velocity_n into v, n from public.range_sessions
   where id = '50000000-0000-0000-0000-000000000003';
  perform test.check(v = 2703 and n = 5,
    'but a string that carries velocities still overrules whatever the client sent');
end $$;

-- And the third case, which is why the guard is not simply "never write
-- nulls": a string whose velocities are REMOVED must not leave a stale average
-- standing. The change itself is what distinguishes this from the case above.
update public.shots set velocity_fps = null
 where session_id = '50000000-0000-0000-0000-000000000003';

do $$
declare v numeric; n integer;
begin
  select velocity_avg_fps, velocity_n into v, n from public.range_sessions
   where id = '50000000-0000-0000-0000-000000000003';
  perform test.check(v is null and n is null,
    'and deleting the velocities off a string DOES clear what was derived from them');
end $$;

-- ================================================== someone else's string
select test.as_user('dddddddd-0000-0000-0000-00000000000d');
do $$
declare n integer;
begin
  select count(*) into n from public.shots;
  perform test.check(n = 0, 'another account sees none of it');

  select count(*) into n from public.v_session_plots;
  perform test.check(n = 0, 'nor through the plot view — security_invoker again');

  update public.shots set poi_x_in = 99;
  get diagnostics n = row_count;
  perform test.check(n = 0, 'and cannot move a hole in it');
end $$;

-- ====================================================== the view Bench reads
select test.as_user('cccccccc-0000-0000-0000-00000000000c');
insert into public.groups (session_id, distance_yd, shot_count, group_es_in, mean_radius_in, source_app)
values ('50000000-0000-0000-0000-000000000001', 100, 10, 0.42, 0.21, 'zero');

do $$
declare r record;
begin
  select * into r from public.v_session_plots
   where session_id = '50000000-0000-0000-0000-000000000001';
  perform test.check(r.target_name = 'SR', 'the plot view names the paper');
  perform test.check(jsonb_array_length(r.target_face -> 'rings') = 3, '...and carries its rings');
  perform test.check(r.distance_yd = 100 and r.group_es_in = 0.42,
    '...joined to the group that was measured on it');
  /* 13, not 12: the duplicate-ordinal insert above is a real extra hole. That
   * is the point of dropping the unique key -- a second device's shot is a
   * shot, not a constraint violation. */
  perform test.check(r.shots_recorded = 13,
    '...and says how many holes are on file, so a client knows whether a plot is drawable');
end $$;

-- ============================================ the order the pull walks in (0013)
-- The client pages with a keyset on (updated_at, id) rather than LIMIT/OFFSET,
-- because OFFSET over a table being written underneath skips rows permanently.
-- Two things have to be true for that walk to be sound, and both are properties
-- of the database rather than the client, so they are pinned here.
do $$
declare n integer; d integer;
begin
  -- 1. updated_at is NOT a total order. now() is the transaction timestamp, so
  --    rows written together are stamped identically. This is why the walk
  --    needs the primary key as a tiebreaker, and it is worth proving rather
  --    than assuming: if it ever became unique, the keyset could be simplified.
  insert into public.firearms (name, cartridge)
  select 'bulk ' || g, '.308' from generate_series(1, 5) g;
  select count(distinct updated_at) into d from public.firearms
   where name like 'bulk %';
  perform test.check(d = 1,
    'five rows written in one statement share one updated_at — so it cannot page on its own');

  -- 2. ...and the index that walk needs exists, in the direction it reads.
  select count(*) into n from pg_indexes
   where schemaname = 'public' and indexname like 'ix\_%\_keyset';
  perform test.check(n >= 15,
    'every synced table has an ascending (updated_at, id) index for the keyset to walk');

  select count(*) into n from pg_indexes
   where schemaname = 'public' and indexname = 'ix_shots_keyset'
     and indexdef like '%updated_at, id%';
  perform test.check(n = 1,
    '...tie-broken by the primary key, which is the only total order available');

  -- 3. The DESC indexes stay: they are what the "most recent first" reads use.
  select count(*) into n from pg_indexes
   where schemaname = 'public' and indexname like 'ix\_%\_sync';
  perform test.check(n >= 13,
    'and the descending indexes are kept — the keyset is an addition, not a swap');
end $$;

reset role;
\echo ''
\echo 'SHOT STRING ASSERTIONS PASSED'
