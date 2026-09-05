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
-- Adversarial test: user B must not be able to read, modify, delete or
-- impersonate user A -- through tables OR through the cross-app views.
-- Runs as the non-superuser `authenticated` role, which is what PostgREST uses.
-- Any failure raises, so a green run means every assertion below held.
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off

-- ---------------------------------------------------------------- fixtures
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'b@example.com')
on conflict do nothing;

/* 0021 files every new sign-up as `pending`, and a pending account is refused
 * by a restrictive policy on every table these suites touch. They are about
 * OWNERSHIP -- can B read A rows -- so the beta gate is switched off for their
 * fixtures and tested on its own in rls_test11. Left on, every assertion below
 * would still pass, and would pass for the wrong reason: refused, but by the
 * gate rather than by the owner check the suite is measuring. */
update public.access_request set status = 'approved';


/* Impersonate a user. `anon` marks the session as an ANONYMOUS sign-in, which
 * Supabase signals with an is_anonymous JWT claim. */
create or replace function test.as_user(u uuid, anon boolean default false) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', u::text, false);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', u::text, 'role', 'authenticated',
                       'is_anonymous', anon)::text, false);
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

-- ============================================================ user A's data
set role authenticated;
select test.as_user('11111111-1111-1111-1111-111111111111');

insert into public.bullet_products (id, model, weight_gr, diameter_in, bc_g1, bc_g7)
values ('aa000000-0000-0000-0000-0000000000b1', 'Berger 140 Hybrid', 140, 0.264, 0.607, 0.311);

insert into public.firearms (id, name, cartridge, barrel_in, twist, sight_height_in, zero_range_yd)
values ('aa000000-0000-0000-0000-0000000000f1', 'Bolt gun', '6.5 Creedmoor', 24, '1:8', 1.75, 100);

insert into public.recipes (id, name, cartridge, bullet_id, firearm_id, charge_gr,
                            source_name, source_max_gr, status)
values ('aa000000-0000-0000-0000-0000000000c1', '6.5CM / 140 / H4350', '6.5 Creedmoor',
        'aa000000-0000-0000-0000-0000000000b1', 'aa000000-0000-0000-0000-0000000000f1',
        41.5, 'Hodgdon online', 42.0, 'proven');

insert into public.batches (id, serial, recipe_id, qty_loaded, qty_remaining, coal_mean_in)
values ('aa000000-0000-0000-0000-00000000ba01', 'B26H13-01D',
        'aa000000-0000-0000-0000-0000000000c1', 60, 60, 2.810);

insert into public.range_sessions (id, batch_id, firearm_id, occurred_on, temp_f, source_app)
values ('aa000000-0000-0000-0000-00000000ce01', 'aa000000-0000-0000-0000-00000000ba01',
        'aa000000-0000-0000-0000-0000000000f1', date '2026-08-12', 86, 'zero');

-- a known shot string, so the derived statistics can be checked by hand
insert into public.shots (session_id, shot_no, velocity_fps) values
  ('aa000000-0000-0000-0000-00000000ce01', 1, 2700),
  ('aa000000-0000-0000-0000-00000000ce01', 2, 2710),
  ('aa000000-0000-0000-0000-00000000ce01', 3, 2705),
  ('aa000000-0000-0000-0000-00000000ce01', 4, 2695),
  ('aa000000-0000-0000-0000-00000000ce01', 5, 2715);

insert into public.groups (session_id, distance_yd, shot_count, group_es_in, mean_radius_in, source_app)
values ('aa000000-0000-0000-0000-00000000ce01', 100, 5, 0.42, 0.16, 'zero');

-- ================================================== derived velocity numbers
do $$
declare s record;
begin
  select * into s from public.range_sessions
   where id = 'aa000000-0000-0000-0000-00000000ce01';
  -- mean 2705, ES 20, sample SD sqrt(250/4) = 7.90569...
  perform test.check(s.velocity_n = 5,                    'trigger: shot count = 5');
  perform test.check(s.velocity_avg_fps = 2705.00,        'trigger: average = 2705');
  perform test.check(s.velocity_es_fps = 20.00,           'trigger: velocity ES = 20');
  perform test.check(round(s.velocity_sd_fps, 3) = 7.906, 'trigger: sample SD = 7.906');
end $$;

-- excluding a shot must change the statistics without deleting the row
update public.shots set excluded = true
 where session_id = 'aa000000-0000-0000-0000-00000000ce01' and shot_no = 5;
do $$
declare s record;
begin
  select * into s from public.range_sessions
   where id = 'aa000000-0000-0000-0000-00000000ce01';
  perform test.check(s.velocity_n = 4,          'exclude: n drops to 4');
  perform test.check(s.velocity_es_fps = 15.00, 'exclude: ES recomputed to 15');
  perform test.check(
    (select count(*) from public.shots
      where session_id = 'aa000000-0000-0000-0000-00000000ce01') = 5,
    'exclude: the shot row is retained, not deleted');
end $$;
update public.shots set excluded = false
 where session_id = 'aa000000-0000-0000-0000-00000000ce01' and shot_no = 5;

-- ================================= source_app accepts what the apps send (0006)
-- The JS mock backend does not enforce check constraints, so a Bench sync suite
-- can be entirely green against a value the real database refuses. It has to be
-- asserted here or not at all.
do $$
declare rejected boolean := false;
begin
  begin
    insert into public.range_sessions (id, batch_id, firearm_id, occurred_on, source_app)
    values ('aa000000-0000-0000-0000-00000000ce09',
            'aa000000-0000-0000-0000-00000000ba01',
            'aa000000-0000-0000-0000-0000000000f1', '2026-08-07', 'bench');
  exception when check_violation then rejected := true;
  end;
  perform test.check(not rejected,
    'source_app: the literal Bench actually sends is accepted');
  delete from public.range_sessions where id = 'aa000000-0000-0000-0000-00000000ce09';

  rejected := false;
  begin
    insert into public.groups (session_id, distance_yd, shot_count, group_es_in, source_app)
    values ('aa000000-0000-0000-0000-00000000ce01', 100, 5, 0.5, 'bench');
  exception when check_violation then rejected := true;
  end;
  perform test.check(not rejected, 'source_app: ...on groups too, which is where Bench''s sizes go');
  delete from public.groups where source_app = 'bench';

  rejected := false;
  begin
    insert into public.range_sessions (id, batch_id, firearm_id, occurred_on, source_app)
    values ('aa000000-0000-0000-0000-00000000ce0a',
            'aa000000-0000-0000-0000-00000000ba01',
            'aa000000-0000-0000-0000-0000000000f1', '2026-08-07', 'Bench');
  exception when check_violation then rejected := true;
  end;
  perform test.check(rejected,
    'source_app: and only one spelling is legal, so the trap cannot be reset');
end $$;

-- ======================================= who owns the velocity summary (0005)
-- Zero writes a shot string; Bench writes only the chronograph's readout. Both
-- land in the same four columns, and the row itself has to decide which one is
-- allowed to win.
do $$
declare s record;
begin
  -- A session that HAS shots: whatever the client claims is discarded.
  update public.range_sessions
     set velocity_avg_fps = 9999, velocity_sd_fps = 9999,
         velocity_es_fps = 9999, velocity_n = 9999
   where id = 'aa000000-0000-0000-0000-00000000ce01';
  select * into s from public.range_sessions
   where id = 'aa000000-0000-0000-0000-00000000ce01';
  perform test.check(s.velocity_avg_fps = 2705.00,
    'guard: a hand-written summary cannot overwrite a derived one');
  perform test.check(s.velocity_n = 5,
    'guard: ...and the shot count still comes from the shots');
end $$;

do $$
declare s record;
begin
  -- A session with NO shots is Bench's case: the readout is all there is, so
  -- it must survive both the insert and a later edit.
  insert into public.range_sessions
    (id, batch_id, firearm_id, occurred_on, source_app,
     velocity_avg_fps, velocity_sd_fps, velocity_es_fps, velocity_n)
  values ('aa000000-0000-0000-0000-00000000ce02',
          'aa000000-0000-0000-0000-00000000ba01',
          'aa000000-0000-0000-0000-0000000000f1',
          '2026-08-06', 'bench', 2712.00, 7.400, 20.00, 10);
  select * into s from public.range_sessions
   where id = 'aa000000-0000-0000-0000-00000000ce02';
  perform test.check(s.velocity_avg_fps = 2712.00,
    'guard: a chronograph readout survives when there is no shot string');
  perform test.check(s.velocity_n = 10 and s.velocity_sd_fps = 7.400,
    'guard: ...spread and sample size included');

  update public.range_sessions set temp_f = 68
   where id = 'aa000000-0000-0000-0000-00000000ce02';
  select * into s from public.range_sessions
   where id = 'aa000000-0000-0000-0000-00000000ce02';
  perform test.check(s.velocity_avg_fps = 2712.00,
    'guard: an unrelated edit does not blank the readout');
end $$;

do $$
declare s record;
begin
  -- ...and the moment a shot string appears, authority transfers. This is the
  -- direction that actually bites: a Bench session someone later shoots into.
  insert into public.shots (session_id, shot_no, velocity_fps) values
    ('aa000000-0000-0000-0000-00000000ce02', 1, 2800),
    ('aa000000-0000-0000-0000-00000000ce02', 2, 2810);
  select * into s from public.range_sessions
   where id = 'aa000000-0000-0000-0000-00000000ce02';
  perform test.check(s.velocity_avg_fps = 2805.00,
    'guard: adding shots takes the summary back from the client');

  update public.range_sessions set velocity_avg_fps = 2712
   where id = 'aa000000-0000-0000-0000-00000000ce02';
  select * into s from public.range_sessions
   where id = 'aa000000-0000-0000-0000-00000000ce02';
  perform test.check(s.velocity_avg_fps = 2805.00,
    'guard: ...and will not give it back');

  delete from public.shots
   where session_id = 'aa000000-0000-0000-0000-00000000ce02';
  delete from public.range_sessions
   where id = 'aa000000-0000-0000-0000-00000000ce02';
end $$;

-- ================================== case prep reaches the profile (0007)
do $$
declare p record;
begin
  update public.batches set cbto_mean_in = 2.2455, bump_in = 0.0020,
         bushing = '.289', primer_depth_in = 0.004, charge_actual_gr = 43.5
   where id = 'aa000000-0000-0000-0000-00000000ba01';
  select * into p from public.v_ballistic_profiles
   where batch_id = 'aa000000-0000-0000-0000-00000000ba01';
  perform test.check(p.cbto_loaded_in = 2.2455,
    'prep: the CBTO actually loaded reaches Zero, not just the recipe''s');
  perform test.check(p.batch_bump_in = 0.0020 and p.bushing = '.289',
    'prep: the sizing that produced this batch travels with it');
  -- The view had the same fault the client did: it compared the RECIPE's
  -- charge to the published maximum and ignored what was weighed.
  perform test.check(p.over_published_max,
    'over max: the view reads the charge that went in the case');

  update public.batches set charge_actual_gr = null
   where id = 'aa000000-0000-0000-0000-00000000ba01';
  select * into p from public.v_ballistic_profiles
   where batch_id = 'aa000000-0000-0000-0000-00000000ba01';
  perform test.check(not p.over_published_max,
    'over max: with nothing weighed it falls back to the recipe, which is under');
  perform test.check(p.cbto_loaded_in = 2.2455,
    'prep: ...and the loaded CBTO is unaffected by that');
end $$;

-- ==================================================== d2 / sigma conversion
do $$
begin
  -- 20 fps ES over 5 shots -> 20 / d2(5) = 20 / 2.326 = 8.5985
  perform test.check(public.es_to_sigma(20, 5) = 8.5985,  'es_to_sigma: 5-shot');
  -- the same sigma should produce a LARGER raw ES over more shots:
  -- 10 shots, d2 = 3.078 -> an ES of 26.5 is the same quality as 20 over 5
  perform test.check(public.es_to_sigma(26.5, 10) between 8.5 and 8.7,
                     'es_to_sigma: a 10-shot ES of 26.5 matches a 5-shot ES of 20');
  perform test.check(public.es_to_sigma(20, 1) is null,   'es_to_sigma: n<2 is undefined');
end $$;

-- ============================================== safety constraint on recipes
do $$
declare blocked boolean := false;
begin
  begin
    insert into public.recipes (name, cartridge, charge_gr)
    values ('uncited', '.308 Win', 43.0);
  exception when check_violation then blocked := true;
  end;
  perform test.check(blocked, 'constraint: a recipe with no source and no acknowledgement is rejected');

  insert into public.recipes (name, cartridge, charge_gr, self_developed)
  values ('acknowledged', '.308 Win', 43.0, true);
  perform test.check(true, 'constraint: self_developed = true is accepted');
end $$;

-- ============================================================ user B's data
select test.as_user('22222222-2222-2222-2222-222222222222');

insert into public.recipes (id, name, cartridge, charge_gr, source_name, source_max_gr)
values ('bb000000-0000-0000-0000-0000000000c1', 'B load', '.223 Rem', 24.2, 'Hodgdon', 24.8);
-- deliberately the SAME serial A used: serials are unique per user, not globally
insert into public.batches (id, serial, recipe_id, qty_loaded, qty_remaining)
values ('bb000000-0000-0000-0000-00000000ba01', 'B26H13-01D',
        'bb000000-0000-0000-0000-0000000000c1', 50, 50);

do $$
begin
  perform test.check(true, 'isolation: two users may hold the same serial');
end $$;

-- ==================================================== the isolation checks
do $$
declare n integer; blocked boolean := false;
begin
  -- SELECT
  select count(*) into n from public.batches
   where id = 'aa000000-0000-0000-0000-00000000ba01';
  perform test.check(n = 0, 'RLS: B cannot select A''s batch');

  select count(*) into n from public.batches;
  perform test.check(n = 1, 'RLS: B sees only their own batch');

  select count(*) into n from public.shots;
  perform test.check(n = 0, 'RLS: B cannot select A''s shots');

  select count(*) into n from public.groups;
  perform test.check(n = 0, 'RLS: B cannot select A''s groups');

  -- UPDATE
  update public.batches set qty_remaining = 0
   where id = 'aa000000-0000-0000-0000-00000000ba01';
  get diagnostics n = row_count;
  perform test.check(n = 0, 'RLS: B cannot update A''s batch');

  -- DELETE
  delete from public.batches where id = 'aa000000-0000-0000-0000-00000000ba01';
  get diagnostics n = row_count;
  perform test.check(n = 0, 'RLS: B cannot delete A''s batch');

  -- IMPERSONATION: writing a row owned by someone else
  begin
    insert into public.firearms (user_id, name, cartridge)
    values ('11111111-1111-1111-1111-111111111111', 'planted', '.308 Win');
  exception when insufficient_privilege then blocked := true;
  end;
  perform test.check(blocked, 'RLS: B cannot insert a row owned by A');

  -- THE VIEWS. Without security_invoker these run as the view owner and leak
  -- every user's rows to every user.
  select count(*) into n from public.v_ballistic_profiles
   where batch_id = 'aa000000-0000-0000-0000-00000000ba01';
  perform test.check(n = 0, 'RLS: v_ballistic_profiles does not leak A''s batch to B');

  select count(*) into n from public.v_batch_performance
   where batch_id = 'aa000000-0000-0000-0000-00000000ba01';
  perform test.check(n = 0, 'RLS: v_batch_performance does not leak A''s batch to B');

  select count(*) into n from public.v_ballistic_profiles;
  perform test.check(n = 1, 'RLS: B sees exactly their own profile row');
end $$;

-- ======================================== the view content A actually gets
select test.as_user('11111111-1111-1111-1111-111111111111');
do $$
declare p record;
begin
  select * into p from public.v_ballistic_profiles
   where batch_id = 'aa000000-0000-0000-0000-00000000ba01';
  perform test.check(p.bullet_weight_gr = 140,        'view: bullet weight reaches Zero');
  perform test.check(p.bc_g7 = 0.311,                 'view: G7 BC reaches Zero');
  perform test.check(p.muzzle_velocity_fps = 2705.00, 'view: muzzle velocity reaches Zero');
  perform test.check(p.velocity_es_fps = 20.00,       'view: velocity ES reaches Zero');
  perform test.check(p.velocity_es_sigma_fps = 8.5985,'view: ES is also exposed as a comparable sigma');
  perform test.check(p.sight_height_in = 1.75,        'view: sight height reaches Zero');
  perform test.check(p.zero_range_yd = 100,           'view: zero range reaches Zero');
  perform test.check(p.untested = false,              'view: batch is not flagged untested');
  perform test.check(p.over_published_max = false,    'view: charge is under published max');
  perform test.check(p.quarantined = false,           'view: quarantine flag exposed');
end $$;

do $$
declare g record;
begin
  select * into g from public.v_batch_performance
   where batch_id = 'aa000000-0000-0000-0000-00000000ba01';
  perform test.check(g.group_count = 1,        'view: Bench sees Zero''s group');
  perform test.check(g.best_group_in = 0.42,   'view: group ES in inches reaches Bench');
  -- 0.42 in at 100 yd = 0.42 / 1.047 = 0.4012 MOA
  perform test.check(round(g.best_group_moa, 3) = 0.401, 'view: MOA uses 1.047 in/100 yd');
end $$;

-- quarantining in Bench must be visible to Zero immediately
update public.batches set quarantined = true, quarantine_reason = 'pulled'
 where id = 'aa000000-0000-0000-0000-00000000ba01';
do $$
declare q boolean;
begin
  select quarantined into q from public.v_ballistic_profiles
   where batch_id = 'aa000000-0000-0000-0000-00000000ba01';
  perform test.check(q, 'cross-app: a Bench quarantine is visible to Zero');
end $$;

-- soft delete must hide the row from both apps without losing history
update public.batches set deleted_at = now()
 where id = 'aa000000-0000-0000-0000-00000000ba01';
do $$
declare n integer;
begin
  select count(*) into n from public.v_ballistic_profiles
   where batch_id = 'aa000000-0000-0000-0000-00000000ba01';
  perform test.check(n = 0, 'soft delete: removed from the view');
  select count(*) into n from public.batches
   where id = 'aa000000-0000-0000-0000-00000000ba01';
  perform test.check(n = 1, 'soft delete: row retained for sync propagation');
end $$;

reset role;
\echo ''
\echo 'ALL ASSERTIONS PASSED'
