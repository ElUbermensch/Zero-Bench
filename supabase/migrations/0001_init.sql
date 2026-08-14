-- ============================================================================
-- Shared backend for the Reloading Batch Tracker and Zero (ballistics PWA).
--
-- Both apps are browser PWAs talking to PostgREST with the PUBLIC anon key.
-- That key is visible to anyone who opens devtools, so row level security is
-- not a hardening step here -- it is the entire access control system. Every
-- table below is RLS-enabled and scoped to auth.uid(). A table added later
-- without RLS is world-readable.
--
-- Sync model: offline-first clients. Rows carry client-generated UUIDs so a
-- create works with no network, `updated_at` for last-write-wins reconciliation,
-- and `deleted_at` for soft deletes so a deletion propagates to other devices
-- (a hard DELETE is invisible to a client that was offline when it happened).
-- ============================================================================

-- ---------------------------------------------------------------- extensions
create extension if not exists pgcrypto;      -- gen_random_uuid()

-- ------------------------------------------------------------------ helpers
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

comment on function public.set_updated_at is
  'Stamps updated_at server-side. Never trust a client clock for sync ordering.';

/*
 * Expected value of the extreme spread of n samples from a normal distribution
 * is d2(n) * sigma. d2 grows with n, so a 5-shot ES and a 20-shot ES are not
 * comparable numbers -- the 20-shot string will read larger from the same
 * ammunition. Dividing by d2 converts an ES back to a sigma estimate that IS
 * comparable across string lengths.
 *
 * Values 2..30 are the standard control-chart constants. Above 30 we fall back
 * to the extreme-value asymptotic, which is good to roughly 1% there.
 */
create or replace function public.es_to_sigma(es numeric, n integer)
returns numeric language plpgsql immutable as $$
declare d2 numeric;
begin
  if es is null or n is null or n < 2 then return null; end if;
  d2 := case n
    when 2 then 1.128 when 3 then 1.693 when 4 then 2.059 when 5 then 2.326
    when 6 then 2.534 when 7 then 2.704 when 8 then 2.847 when 9 then 2.970
    when 10 then 3.078 when 11 then 3.173 when 12 then 3.258 when 13 then 3.336
    when 14 then 3.407 when 15 then 3.472 when 16 then 3.532 when 17 then 3.588
    when 18 then 3.640 when 19 then 3.689 when 20 then 3.735 when 21 then 3.778
    when 22 then 3.819 when 23 then 3.858 when 24 then 3.895 when 25 then 3.931
    when 26 then 3.964 when 27 then 3.997 when 28 then 4.027 when 29 then 4.057
    when 30 then 4.086
    else null end;
  if d2 is null then
    d2 := 2 * sqrt(2 * ln(n::numeric))
        - (ln(ln(n::numeric)) + ln(4 * pi())) / (2 * sqrt(2 * ln(n::numeric)));
  end if;
  return round(es / d2, 4);
end $$;

comment on function public.es_to_sigma is
  'Converts an extreme spread over n shots into a comparable sigma estimate.';

-- ============================================================================
-- Reference and equipment
-- ============================================================================

create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  display_name  text,
  units         text not null default 'imperial' check (units in ('imperial','metric')),
  marking_scheme jsonb not null default '{}'::jsonb,   -- tracker's colour scheme
  overhead_per_round numeric(10,4) not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.firearms (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name          text not null,
  cartridge     text not null,
  barrel_in     numeric(6,2),
  twist         text,                         -- '1:8'
  chamber       text,
  sight_height_in numeric(6,3),               -- Zero needs this for a solution
  zero_range_yd numeric(6,1),                 -- and this
  round_count   integer not null default 0 check (round_count >= 0),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

-- Bullet products carry the ballistic coefficients, so this table is the main
-- thing Zero reads when the user picks a bullet.
create table public.bullet_products (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  maker         text,
  model         text not null,
  weight_gr     numeric(7,2) not null check (weight_gr > 0),
  diameter_in   numeric(6,4) check (diameter_in > 0),
  length_in     numeric(6,4),
  bc_g1         numeric(6,4) check (bc_g1 > 0),
  bc_g7         numeric(6,4) check (bc_g7 > 0),
  construction  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create table public.powder_products (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  maker         text,
  name          text not null,
  form          text check (form in ('ball','extruded','flake')),
  temp_stable   boolean,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create table public.primer_products (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  maker         text,
  model         text not null,
  size          text check (size in ('SR','LR','SP','LP','SRM','LRM','SPM','LPM')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

-- ============================================================================
-- Consumable lots
-- ============================================================================

create table public.component_lots (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind          text not null check (kind in ('bullet','powder','primer')),
  bullet_id     uuid references public.bullet_products(id) on delete set null,
  powder_id     uuid references public.powder_products(id) on delete set null,
  primer_id     uuid references public.primer_products(id) on delete set null,
  lot_code      text,
  serial        text,                         -- C-9M4, printed on the shelf tag
  vendor        text,
  purchased_on  date,
  qty_purchased numeric(12,3) not null check (qty_purchased > 0),
  qty_remaining numeric(12,3) not null default 0 check (qty_remaining >= 0),
  unit          text not null check (unit in ('ea','lb','gr')),
  cost_total    numeric(12,2) not null default 0 check (cost_total >= 0),
  storage       text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  -- exactly one product reference, matching `kind`
  constraint component_lot_product_matches_kind check (
    (kind = 'bullet' and bullet_id is not null and powder_id is null and primer_id is null) or
    (kind = 'powder' and powder_id is not null and bullet_id is null and primer_id is null) or
    (kind = 'primer' and primer_id is not null and bullet_id is null and powder_id is null)
  )
);

comment on constraint component_lot_product_matches_kind on public.component_lots is
  'Three nullable FKs with a CHECK, rather than one polymorphic product_id: this '
  'keeps real referential integrity, which a (product_type, product_id) pair cannot have.';

create table public.brass_lots (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  serial        text not null,                -- R-3CK
  cartridge     text not null,
  headstamp     text not null,
  maker         text,
  nickel        boolean not null default false,
  marks         jsonb not null default '{}'::jsonb,  -- {"neck":"R","head":"K"}
  origin        text check (origin in ('new','once-fired','range pickup','harvested')),
  acquired_on   date,
  qty_initial   integer not null check (qty_initial > 0),
  qty_on_hand   integer not null check (qty_on_hand >= 0),
  firings       integer not null default 0 check (firings >= 0),
  expected_firings integer not null default 6 check (expected_firings > 0),
  cost_total    numeric(12,2) not null default 0 check (cost_total >= 0),
  last_trim_on  date,
  last_trim_len_in numeric(7,4),
  last_anneal_on date,
  sizing        text check (sizing in ('FL','bushing','neck','none')),
  bump_in       numeric(6,4),
  track_individual boolean not null default false,
  retired       boolean not null default false,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint brass_on_hand_within_initial check (qty_on_hand <= qty_initial)
);

-- Append-only audit trail. Firing count is derived from this, so it cannot
-- silently drift the way a mutable counter does.
create table public.brass_events (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  brass_lot_id  uuid not null references public.brass_lots(id) on delete cascade,
  occurred_on   date not null default current_date,
  kind          text not null check (kind in
                  ('acquired','loaded','fired','tumbled','annealed','sized',
                   'trimmed','pocket_uniformed','neck_turned','culled','retired')),
  qty_before    integer,
  qty_after     integer,
  firings_after integer,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

-- ============================================================================
-- Loads
-- ============================================================================

create table public.recipes (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name          text not null,
  cartridge     text not null,
  bullet_id     uuid references public.bullet_products(id) on delete set null,
  powder_id     uuid references public.powder_products(id) on delete set null,
  primer_id     uuid references public.primer_products(id) on delete set null,
  firearm_id    uuid references public.firearms(id) on delete set null,
  charge_gr     numeric(7,3) not null check (charge_gr > 0),
  charge_min_gr numeric(7,3),
  charge_max_gr numeric(7,3),
  coal_in       numeric(7,4),
  cbto_in       numeric(7,4),
  sizing        text,
  bump_in       numeric(6,4),
  crimp         text,
  -- Safety citation. A recipe either cites a published source or explicitly
  -- acknowledges that it does not; a blank field is not an allowed state.
  source_name   text,
  source_edition text,
  source_page   text,
  source_max_gr numeric(7,3),
  self_developed boolean not null default false,
  status        text not null default 'workup' check (status in ('workup','proven','retired')),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint recipe_cites_a_source check (
    self_developed = true or (source_name is not null and length(btrim(source_name)) > 0)
  )
);

create table public.batches (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  serial        text not null,                -- B26H13-01D, printed + in the QR
  recipe_id     uuid not null references public.recipes(id) on delete restrict,
  brass_lot_id  uuid references public.brass_lots(id) on delete set null,
  bullet_lot_id uuid references public.component_lots(id) on delete set null,
  powder_lot_id uuid references public.component_lots(id) on delete set null,
  primer_lot_id uuid references public.component_lots(id) on delete set null,
  loaded_on     date not null default current_date,
  qty_loaded    integer not null check (qty_loaded > 0),
  qty_remaining integer not null check (qty_remaining >= 0),
  charge_actual_gr numeric(7,3),
  charge_sd_gr  numeric(7,3),
  scale         text,
  weigh_mode    text,
  coal_mean_in  numeric(7,4),
  runout_in     numeric(6,4),
  press         text,
  dies          text,
  temp_f        numeric(6,2),
  humidity_pct  numeric(5,2),
  quarantined   boolean not null default false,
  quarantine_reason text,
  storage       text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  constraint batch_remaining_within_loaded check (qty_remaining <= qty_loaded)
);

-- ============================================================================
-- Results. These tables are the shared surface: the tracker writes loading
-- data, Zero writes what happened downrange, and both read the other's.
-- ============================================================================

create table public.range_sessions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  batch_id      uuid references public.batches(id) on delete set null,
  firearm_id    uuid references public.firearms(id) on delete set null,
  occurred_on   date not null default current_date,
  location      text,
  rounds_fired  integer check (rounds_fired >= 0),
  -- conditions, so a solver can correct for powder temperature sensitivity
  -- rather than assuming today matches the day the velocity was measured
  temp_f        numeric(6,2),
  humidity_pct  numeric(5,2),
  pressure_inhg numeric(6,2),
  altitude_ft   numeric(8,1),
  -- VELOCITY statistics, in fps. Named velocity_* throughout because "ES"
  -- means two different things in this domain and conflating them is a real
  -- source of error: this is muzzle velocity spread, NOT group size.
  velocity_avg_fps numeric(8,2),
  velocity_sd_fps  numeric(8,3),
  velocity_es_fps  numeric(8,2),
  velocity_n       integer check (velocity_n >= 0),
  chrono_model  text,
  pressure_signs text not null default 'none' check (pressure_signs in
                  ('none','flattened primers','cratered primers','ejector mark',
                   'stiff bolt lift','case head expansion')),
  source_app    text not null default 'tracker' check (source_app in ('tracker','zero')),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

-- Per-shot velocities. Having the string rather than a typed-in summary means
-- SD is computed, not transcribed, and a flyer stays visible.
create table public.shots (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  session_id    uuid not null references public.range_sessions(id) on delete cascade,
  shot_no       integer not null check (shot_no > 0),
  velocity_fps  numeric(8,2),
  poi_x_in      numeric(7,3),
  poi_y_in      numeric(7,3),
  excluded      boolean not null default false,  -- kept, not deleted; flyers are data
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (session_id, shot_no)
);

-- GROUP dispersion, in inches. Zero owns this: it is what the tracker reads
-- back to answer "which load actually shot best".
create table public.groups (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  session_id    uuid not null references public.range_sessions(id) on delete cascade,
  label         text,
  distance_yd   numeric(7,1) not null check (distance_yd > 0),
  shot_count    integer not null check (shot_count >= 2),
  -- group extreme spread: widest centre-to-centre distance, in INCHES.
  -- Distinct from range_sessions.velocity_es_fps.
  group_es_in   numeric(7,3) check (group_es_in >= 0),
  mean_radius_in numeric(7,3) check (mean_radius_in >= 0),
  vertical_in   numeric(7,3),
  horizontal_in numeric(7,3),
  source_app    text not null default 'zero' check (source_app in ('tracker','zero')),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

-- Confirmed dope, written by Zero after a solution is verified on steel.
create table public.dope_entries (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  batch_id      uuid references public.batches(id) on delete set null,
  firearm_id    uuid references public.firearms(id) on delete set null,
  distance_yd   numeric(7,1) not null check (distance_yd > 0),
  elevation_mil numeric(6,2),
  windage_mil   numeric(6,2),
  elevation_moa numeric(6,2),
  windage_moa   numeric(6,2),
  confirmed     boolean not null default false,
  temp_f        numeric(6,2),
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

-- ============================================================================
-- Derived velocity statistics
-- ============================================================================

/*
 * Recompute a session's velocity summary from its shot string. Runs on any
 * change to shots, so the summary can never disagree with the underlying data.
 * Excluded shots are left out of the statistics but stay in the table.
 */
create or replace function public.refresh_session_velocity()
returns trigger language plpgsql as $$
declare sid uuid;
begin
  sid := coalesce(new.session_id, old.session_id);
  update public.range_sessions s set
    velocity_avg_fps = t.avg_v,
    velocity_sd_fps  = t.sd_v,
    velocity_es_fps  = t.es_v,
    velocity_n       = t.n,
    updated_at       = now()
  from (
    select count(*)                      as n,
           round(avg(velocity_fps), 2)   as avg_v,
           round(stddev_samp(velocity_fps), 3) as sd_v,
           round(max(velocity_fps) - min(velocity_fps), 2) as es_v
    from public.shots
    where session_id = sid and not excluded
      and deleted_at is null and velocity_fps is not null
  ) t
  where s.id = sid;
  return null;
end $$;

create trigger shots_refresh_velocity
after insert or update or delete on public.shots
for each row execute function public.refresh_session_velocity();

-- ============================================================================
-- updated_at triggers
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','firearms','bullet_products','powder_products','primer_products',
    'component_lots','brass_lots','brass_events','recipes','batches',
    'range_sessions','shots','groups','dope_entries'
  ] loop
    execute format(
      'create trigger %I before update on public.%I
       for each row execute function public.set_updated_at()',
      t || '_set_updated_at', t);
  end loop;
end $$;

-- ============================================================================
-- Row level security. Enabled on EVERY table, no exceptions.
-- ============================================================================

do $$
declare t text; owner_col text;
begin
  foreach t in array array[
    'profiles','firearms','bullet_products','powder_products','primer_products',
    'component_lots','brass_lots','brass_events','recipes','batches',
    'range_sessions','shots','groups','dope_entries'
  ] loop
    -- profiles is keyed by the user id itself; everything else has user_id
    owner_col := case when t = 'profiles' then 'id' else 'user_id' end;
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format(
      'create policy %I on public.%I for select using (auth.uid() = %I)',
      t || '_select_own', t, owner_col);
    execute format(
      'create policy %I on public.%I for insert with check (auth.uid() = %I)',
      t || '_insert_own', t, owner_col);
    execute format(
      'create policy %I on public.%I for update using (auth.uid() = %I) with check (auth.uid() = %I)',
      t || '_update_own', t, owner_col, owner_col);
    execute format(
      'create policy %I on public.%I for delete using (auth.uid() = %I)',
      t || '_delete_own', t, owner_col);
  end loop;
end $$;

-- ============================================================================
-- Indexes. The (user_id, updated_at) pairs are what incremental sync pulls on.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'firearms','bullet_products','powder_products','primer_products',
    'component_lots','brass_lots','brass_events','recipes','batches',
    'range_sessions','shots','groups','dope_entries'
  ] loop
    execute format('create index %I on public.%I (user_id, updated_at desc)',
                   'ix_' || t || '_sync', t);
  end loop;
end $$;

create unique index ux_batches_serial     on public.batches (user_id, serial)
  where deleted_at is null;
create unique index ux_brass_lots_serial  on public.brass_lots (user_id, serial)
  where deleted_at is null;
create unique index ux_component_serial   on public.component_lots (user_id, serial)
  where deleted_at is null and serial is not null;
create index ix_shots_session   on public.shots (session_id);
create index ix_groups_session  on public.groups (session_id);
create index ix_sessions_batch  on public.range_sessions (batch_id);

-- ============================================================================
-- Cross-app views.
--
-- security_invoker = true is load-bearing. A view defaults to running with the
-- privileges of its OWNER, which means it silently bypasses the RLS on its
-- base tables and would serve every user's rows to every user.
-- ============================================================================

/*
 * What Zero reads when the user is choosing a bullet/load: one row per live
 * batch, carrying everything a trajectory solution needs plus the safety state
 * the tracker owns.
 */
create view public.v_ballistic_profiles
with (security_invoker = true) as
select
  b.id                          as batch_id,
  b.serial,
  b.user_id,
  r.cartridge,
  r.name                        as load_name,
  bp.id                         as bullet_id,
  concat_ws(' ', bp.maker, bp.model)  as bullet_name,
  bp.weight_gr                  as bullet_weight_gr,
  bp.diameter_in,
  bp.length_in                  as bullet_length_in,
  bp.bc_g1,
  bp.bc_g7,
  b.coal_mean_in,
  r.cbto_in,
  b.qty_remaining,
  b.loaded_on,
  -- velocity, taken from the most recent session that actually has a number
  v.velocity_avg_fps            as muzzle_velocity_fps,
  v.velocity_sd_fps,
  v.velocity_es_fps,
  v.velocity_n,
  public.es_to_sigma(v.velocity_es_fps, v.velocity_n) as velocity_es_sigma_fps,
  v.temp_f                      as velocity_temp_f,
  v.occurred_on                 as velocity_measured_on,
  f.id                          as firearm_id,
  f.name                        as firearm_name,
  f.barrel_in,
  f.twist,
  f.sight_height_in,
  f.zero_range_yd,
  -- safety state, so Zero can refuse to build a solution on quarantined ammo
  b.quarantined,
  (v.id is null)                as untested,
  (r.source_max_gr is not null and r.charge_gr > r.source_max_gr) as over_published_max,
  r.status                      as recipe_status
from public.batches b
join public.recipes r          on r.id = b.recipe_id and r.deleted_at is null
left join public.bullet_products bp on bp.id = r.bullet_id and bp.deleted_at is null
left join public.firearms f    on f.id = r.firearm_id and f.deleted_at is null
left join lateral (
  select s.* from public.range_sessions s
  where s.batch_id = b.id and s.deleted_at is null and s.velocity_avg_fps is not null
  order by s.occurred_on desc, s.created_at desc
  limit 1
) v on true
where b.deleted_at is null;

comment on view public.v_ballistic_profiles is
  'Zero reads this to list selectable loads. One row per batch, with bullet BC, '
  'muzzle velocity and its spread, firearm geometry, and tracker safety flags.';

/*
 * What the tracker reads back from Zero: how each batch actually shot.
 * group_es_in is group size in inches -- not the velocity ES above.
 */
create view public.v_batch_performance
with (security_invoker = true) as
select
  b.id                                   as batch_id,
  b.user_id,
  b.serial,
  count(distinct s.id)                   as session_count,
  count(g.id)                            as group_count,
  min(g.group_es_in)                     as best_group_in,
  round(avg(g.group_es_in), 3)           as avg_group_in,
  min(g.group_es_in / nullif(g.distance_yd, 0) * 100 / 1.047)  as best_group_moa,
  round(avg(g.group_es_in / nullif(g.distance_yd, 0) * 100 / 1.047), 3) as avg_group_moa,
  round(avg(g.mean_radius_in), 3)        as avg_mean_radius_in,
  max(s.occurred_on)                     as last_fired_on
from public.batches b
left join public.range_sessions s on s.batch_id = b.id and s.deleted_at is null
left join public.groups g         on g.session_id = s.id and g.deleted_at is null
where b.deleted_at is null
group by b.id, b.user_id, b.serial;

comment on view public.v_batch_performance is
  'Group dispersion per batch, written by Zero, read by the tracker. '
  'MOA uses the true minute of angle (1.047 in per 100 yd), not the shooter shorthand of 1 in.';

-- ============================================================================
-- Grants. PostgREST connects as anon (logged out) or authenticated (logged in).
-- anon gets nothing: there is no public data in this database.
-- ============================================================================

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on public.v_ballistic_profiles, public.v_batch_performance to authenticated;
grant execute on function public.es_to_sigma(numeric, integer) to authenticated;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
