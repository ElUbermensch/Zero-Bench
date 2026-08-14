-- ============================================================================
-- 0002: shared leaderboard.
--
-- Everything in 0001 is private-per-user. These two tables are the deliberate
-- exception: READ is open to every signed-in user, WRITE is still owner-only.
-- Publishing is an explicit act in the app -- nothing from the private tables
-- leaks here on its own.
--
-- Honesty caveat, stated where it belongs: scores are self-reported. The
-- constraints below bound them to *plausible* (a 10-shot string cannot score
-- 700), but no schema can make them *true*. A leaderboard among people who
-- know each other is the actual enforcement mechanism.
-- ============================================================================

-- One public identity per account. Keyed by the user id itself.
create table public.leaderboard_profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  handle      text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint handle_shape check (handle ~ '^[A-Za-z0-9_-]{3,24}$')
);

-- Case-insensitive uniqueness: "Jaxon" and "jaxon" are the same person or a
-- spoof attempt; either way, one of them.
create unique index ux_lb_handle on public.leaderboard_profiles (lower(handle));

create table public.leaderboard_entries (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  occurred_on   date not null,
  position      text not null default 'Unspecified',   -- Standing / Kneeling / Prone / ...
  target_name   text not null,
  distance_yd   numeric(7,1) not null check (distance_yd > 0),
  shot_count    integer not null check (shot_count >= 2),
  score         integer not null check (score >= 0),
  x_count       integer not null default 0 check (x_count >= 0),
  mr_moa        numeric(7,3) check (mr_moa >= 0),
  es_moa        numeric(7,3) check (es_moa >= 0),
  source_app    text not null default 'zero' check (source_app in ('zero','tracker')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  -- plausibility bounds: X counts as 10, so score <= 10/shot; X's are a subset
  constraint score_plausible check (score <= shot_count * 10),
  constraint xs_within_shots check (x_count <= shot_count)
);

create index ix_lb_entries_class on public.leaderboard_entries
  (position, distance_yd, shot_count) where deleted_at is null;
create index ix_lb_entries_sync on public.leaderboard_entries (user_id, updated_at desc);

-- updated_at stamping, same trigger as everything else
create trigger leaderboard_profiles_set_updated_at before update on public.leaderboard_profiles
  for each row execute function public.set_updated_at();
create trigger leaderboard_entries_set_updated_at before update on public.leaderboard_entries
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- RLS
-- The asymmetry IS the feature: select true, mutate own-only.
alter table public.leaderboard_profiles enable row level security;
alter table public.leaderboard_profiles force row level security;
create policy lbp_select_all  on public.leaderboard_profiles for select using (true);
create policy lbp_insert_own  on public.leaderboard_profiles for insert with check (auth.uid() = id);
create policy lbp_update_own  on public.leaderboard_profiles for update
  using (auth.uid() = id) with check (auth.uid() = id);
create policy lbp_delete_own  on public.leaderboard_profiles for delete using (auth.uid() = id);

alter table public.leaderboard_entries enable row level security;
alter table public.leaderboard_entries force row level security;
create policy lbe_select_all  on public.leaderboard_entries for select using (true);
create policy lbe_insert_own  on public.leaderboard_entries for insert with check (auth.uid() = user_id);
create policy lbe_update_own  on public.leaderboard_entries for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy lbe_delete_own  on public.leaderboard_entries for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------- view
-- security_invoker still required: the base tables' SELECT policy happens to
-- be open, but an owner-privilege view would ALSO bypass the soft-delete
-- filter discipline and any future tightening. Same rule as 0001: every view
-- is invoker, no exceptions.
create view public.v_leaderboard
with (security_invoker = true) as
select
  e.id, e.user_id,
  coalesce(p.handle, 'anon') as handle,
  e.occurred_on, e.position, e.target_name,
  e.distance_yd, e.shot_count, e.score, e.x_count,
  e.mr_moa, e.es_moa, e.source_app
from public.leaderboard_entries e
left join public.leaderboard_profiles p on p.id = e.user_id
where e.deleted_at is null;

grant select, insert, update, delete on
  public.leaderboard_profiles, public.leaderboard_entries to authenticated;
grant select on public.v_leaderboard to authenticated;
