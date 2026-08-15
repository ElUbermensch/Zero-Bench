-- ============================================================================
-- 0005 — the shot string wins, but only when there is one
-- ============================================================================
--
-- Two apps now write range_sessions and they disagree about where a velocity
-- summary comes from.
--
--   Zero  records every shot. `shots_refresh_velocity` (0001) derives the
--         session summary from that string on every shot change, so the summary
--         is a cache of the shots and nothing else may set it.
--
--   Bench records no shot string at all. It has the chronograph's own readout —
--         ten rounds over the sky screens, avg/SD/ES straight off the device —
--         and nothing for a trigger to derive from. If the client cannot write
--         the summary directly, the session has no velocity, and every ballistic
--         profile built on that batch loses its muzzle velocity.
--
-- The old client-side rule ("never transmit velocity columns") served Zero and
-- silently destroyed Bench's only velocity data. The fix is not to trust the
-- client instead — that just inverts the failure, letting a stale hand-computed
-- summary sit on top of a live shot string until the next shot edit settles it.
--
-- The rule belongs here, because this is the only place that can see whether a
-- shot string exists:
--
--   shots present  → the client's summary is ignored and the derived one wins
--   no shots       → the client's summary is taken at face value
--
-- Note this is BEFORE, on range_sessions, and returns NEW: it rewrites the row
-- on its way in rather than issuing a second UPDATE, so it cannot recurse with
-- the AFTER trigger on shots.

create or replace function public.guard_session_velocity()
returns trigger language plpgsql
set search_path = public, pg_temp as $$
declare t record;
begin
  select count(*)                                   as n,
         round(avg(velocity_fps), 2)                as avg_v,
         round(stddev_samp(velocity_fps), 3)        as sd_v,
         round(max(velocity_fps) - min(velocity_fps), 2) as es_v
    into t
    from public.shots
   where session_id = new.id and not excluded
     and deleted_at is null and velocity_fps is not null;

  -- A shot string exists: it is the source of truth, whatever the client sent.
  if t.n > 0 then
    new.velocity_avg_fps := t.avg_v;
    new.velocity_sd_fps  := t.sd_v;
    new.velocity_es_fps  := t.es_v;
    new.velocity_n       := t.n;
  end if;

  return new;
end $$;

drop trigger if exists range_sessions_guard_velocity on public.range_sessions;
create trigger range_sessions_guard_velocity
before insert or update on public.range_sessions
for each row execute function public.guard_session_velocity();
