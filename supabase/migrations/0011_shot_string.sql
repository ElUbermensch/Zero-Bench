-- ============================================================================
-- 0011 — the shot string, and the paper it was shot on
--
-- WHY
--
-- Bench could see that a batch had been fired and how big the group was. That
-- is a summary of a summary. "This is a string data analytics program at
-- heart" — and the string never left Zero.
--
-- `shots` has existed since 0001 with impact coordinates in inches, and no
-- client has ever written to it. Zero pushed the session and one `groups` row
-- and stopped. So Bench knew a load shot 0.42" at 100 and could not say
-- whether that was five in a cloverleaf and one flyer, or six in a line, which
-- is the difference between a load problem and a wind call.
--
-- WHAT IS ADDED
--
-- Three things the existing table cannot express, all of which Zero already
-- records and the relay already transmits:
--
--   * WHICH RING the shot took. Group size is geometry; the score is the ring,
--     and a 10 that broke into the 9 is a different piece of information from
--     a 0.9" group.
--   * WHETHER IT WAS A SIGHTER. Sighters are fired, so they come out of the
--     batch, and they are NOT scored and must not enter the group. Folding
--     them into `excluded` would be wrong in both directions: `excluded` means
--     "this is a flyer I am setting aside", which is a judgement about the
--     data, while a sighter is a fact about the string. Conflating them would
--     also make the velocity trigger in 0005 silently drop sighter velocities.
--   * WHERE THE SHOOTER CALLED IT. The gap between where the sights were when
--     the shot broke and where the hole is, is the single most useful number a
--     coach reads off a live string, and pair fire already sends it.
--
-- And on the session, the paper itself. A hole at (0.4, -1.1) means nothing
-- without knowing whether that is an SR at 200 or an F-class target at 600.
-- Bench has no target library and should not grow one — it is a loading bench,
-- it does not own targets — so the face travels WITH the session that was shot
-- on it, denormalised on purpose. The alternative, a shared targets table, is
-- a whole second sync surface with an edit-conflict story, in service of a
-- picture.
-- ============================================================================

-- ------------------------------------------------------------- the string
alter table public.shots
  add column if not exists ring          text,
  add column if not exists is_sighter    boolean not null default false,
  add column if not exists call_x_in     numeric(7,3),
  add column if not exists call_y_in     numeric(7,3),
  add column if not exists wind_call_moa numeric(5,2),
  add column if not exists wind_call_dir text;

do $$ begin
  alter table public.shots
    add constraint shots_wind_call_dir_check
    check (wind_call_dir is null or wind_call_dir in ('L', 'R'));
exception when duplicate_object then null; end $$;

comment on column public.shots.is_sighter is
  'Fired but not scored. Distinct from `excluded`, which is a judgement about a flyer; this is a fact about the string.';

-- The plot reads a whole string at once, in order, for one session.
create index if not exists shots_session_no_idx
  on public.shots (session_id, shot_no)
  where deleted_at is null;

-- ------------------------------------------------------------- the paper
alter table public.range_sessions
  add column if not exists target_name text,
  add column if not exists target_face jsonb;

comment on column public.range_sessions.target_face is
  'The ring geometry the string was shot on: {"rings":[{"score":"X","diam":3.0,"color":"#1a1814"},…]} with diameters in INCHES, same shape the relay sends. Denormalised deliberately — a hole at (0.4,-1.1) is meaningless without the paper, and Bench has no business owning a target library.';

-- A face is a shape, not free text, and a client that sends the wrong shape
-- should find out at the write rather than when the plot renders as nothing.
-- Deliberately shallow: it checks that `rings` is an array of objects, not
-- that every diameter is sane, because the client that draws it is the one
-- that knows what sane means and the database refusing a working target is
-- worse than a slightly odd one getting through.
do $$ begin
  alter table public.range_sessions
    add constraint range_sessions_target_face_shape
    check (
      target_face is null
      or (jsonb_typeof(target_face) = 'object'
          and jsonb_typeof(target_face -> 'rings') = 'array')
    );
exception when duplicate_object then null; end $$;

-- ------------------------------------------- the trigger this would have broken
--
-- `refresh_session_velocity` (0001) recomputes the session's velocity summary
-- from the string on every shot change. It was written when only Zero wrote
-- shots and only Zero wrote sessions, and it recomputes UNCONDITIONALLY: with
-- no velocity-bearing shots the aggregate is all nulls and it writes those
-- nulls over whatever was there.
--
-- That was harmless while nothing wrote shots. It stops being harmless the
-- moment Zero pushes a string, because Zero's shots are HOLES IN PAPER and
-- carry no velocity at all — a chronograph is a separate instrument. Push
-- twelve impacts at a session that has a chronograph readout on it and the
-- readout is gone, silently, and every ballistic profile built on that batch
-- loses its muzzle velocity.
--
-- 0005 already settled the rule for the other direction: a shot string wins
-- only WHERE THERE IS ONE. The same rule belongs here. The subtlety is that
-- "no velocities" must still clear a summary when the change is what REMOVED
-- them — a string whose velocities were deleted should not leave a stale
-- average behind. `old.velocity_fps` distinguishes the two: this row used to
-- carry a velocity, so recompute and let the nulls land.
create or replace function public.refresh_session_velocity()
returns trigger language plpgsql
set search_path = public, pg_temp as $$
declare sid uuid; t record;
begin
  sid := coalesce(new.session_id, old.session_id);

  select count(*)                                        as n,
         round(avg(velocity_fps), 2)                     as avg_v,
         round(stddev_samp(velocity_fps), 3)             as sd_v,
         round(max(velocity_fps) - min(velocity_fps), 2) as es_v
    into t
    from public.shots
   where session_id = sid and not excluded
     and deleted_at is null and velocity_fps is not null;

  -- Nothing to derive from, and this change did not take anything away: the
  -- summary belongs to whoever wrote it (a chronograph, via Bench) and is not
  -- this trigger's to erase.
  if t.n = 0 and (old is null or old.velocity_fps is null) then
    return null;
  end if;

  update public.range_sessions s set
    velocity_avg_fps = t.avg_v,
    velocity_sd_fps  = t.sd_v,
    velocity_es_fps  = t.es_v,
    velocity_n       = nullif(t.n, 0),
    updated_at       = now()
  where s.id = sid;
  return null;
end $$;

-- ------------------------------------------------------------------ RLS
-- `shots` has carried its own policies since 0001 and they are unchanged:
-- adding columns to a table does not widen who can read it. This block asserts
-- that rather than assuming it — a table that quietly lost RLS between
-- migrations is the failure mode worth a few lines to rule out.
do $$
declare n integer;
begin
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'shots';
  if n = 0 then
    raise exception 'shots has no RLS policies — 0011 would be publishing every shot string on the server';
  end if;

  if not (select relrowsecurity from pg_class where oid = 'public.shots'::regclass) then
    raise exception 'row level security is not enabled on shots';
  end if;
end $$;

-- ------------------------------------------------------------------ view
-- What Bench renders per session: the summary columns it already had, plus the
-- paper. The string itself is read separately — it is one row per shot and
-- does not belong in a per-session view.
--
-- security_invoker, so the view cannot become a way around the policies.
create or replace view public.v_session_plots
with (security_invoker = true) as
select r.id                as session_id,
       r.user_id,
       r.batch_id,
       r.firearm_id,
       r.occurred_on,
       r.rounds_fired,
       r.target_name,
       r.target_face,
       g.id                as group_id,
       g.distance_yd,
       g.shot_count,
       g.group_es_in,
       g.mean_radius_in,
       (select count(*) from public.shots s
         where s.session_id = r.id and s.deleted_at is null) as shots_recorded
from public.range_sessions r
left join public.groups g
       on g.session_id = r.id and g.deleted_at is null
where r.deleted_at is null;

grant select on public.v_session_plots to authenticated;
