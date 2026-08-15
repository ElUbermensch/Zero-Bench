-- ============================================================================
-- 0007 — the process controls, not just the recipe
-- ============================================================================
--
-- What a precision handloader changes between batches is mostly not the load
-- data. It is the sizing: how far the shoulder was bumped off the fired case,
-- which bushing was used and therefore what neck tension the bullet sees, how
-- deep the primer sits, and where the bullet sits relative to the lands. Those
-- are per-BATCH measurements, taken with a comparator at the press, and they
-- are the first things anyone changes when velocity ES goes bad or the bolt
-- starts closing hard.
--
-- 0001 gave brass_lots a `bump_in` and stopped there, which models bump as a
-- property of the lot. It is not: the same lot sized on two different days,
-- or with the die backed off a thou, produces two different batches. Bench
-- records these on the batch, so that is where they go here too. The lot's
-- `bump_in` is left alone -- it is a reasonable place for a lot's standing
-- target and dropping it would break anything already reading it.
--
-- Trim length gets the same treatment in reverse: 0001's `last_trim_len_in`
-- records what a lot was last trimmed TO, which is a measurement. The spec --
-- the length you trim to and the length at which a case is too long -- is a
-- decision about the lot, and it is what a warning has to compare against.

alter table public.batches
  add column if not exists cbto_mean_in     numeric(7,4),
  add column if not exists bump_in          numeric(6,4),
  add column if not exists bushing          text,
  add column if not exists primer_depth_in  numeric(6,4);

alter table public.brass_lots
  add column if not exists trim_to_in       numeric(7,4),
  add column if not exists max_length_in    numeric(7,4),
  add column if not exists weight_sort      text,
  -- Firings between anneals, as the shooter works to it. 0 disables the
  -- reminder for people who do not anneal; NULL means "never said", which the
  -- client reads as every firing.
  add column if not exists anneal_every     integer check (anneal_every >= 0);

-- The measured CBTO belongs in the ballistic profile alongside the recipe's.
-- Zero's seating figure should be what was actually loaded, falling back to
-- what the recipe specified -- which is already how COAL behaves. Adding a
-- column to a view means replacing it, so this repeats 0001's select with the
-- three new columns appended; `create or replace view` refuses a column
-- reorder, which is why they go on the end rather than next to cbto_in.
--
-- Replacing rather than altering also means the RLS story is unchanged:
-- security_invoker stays on, so the view reads with the caller's privileges
-- and the underlying tables' policies still do all the work.

create or replace view public.v_ballistic_profiles
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
  -- The recipe as a shooter says it out loud. Zero was importing a batch and
  -- leaving powder and charge blank, which meant the load it listed could not
  -- be told apart from any other load of the same bullet.
  pw.id                         as powder_id,
  concat_ws(' ', pw.maker, pw.name)   as powder_name,
  pw.temp_stable                as powder_temp_stable,
  r.charge_gr,
  b.charge_actual_gr,
  b.charge_sd_gr,
  pr.id                         as primer_id,
  concat_ws(' ', pr.maker, pr.model)  as primer_name,
  r.id                          as recipe_id,
  -- Safety citation travels with the load. A number without its source is not
  -- something to hand to a ballistic solver.
  r.source_name,
  r.source_edition,
  r.source_page,
  r.source_max_gr,
  r.self_developed,
  b.quarantine_reason,
  b.qty_remaining,
  b.qty_loaded,
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
  -- The charge that went in the case, not the one the recipe intended. The
  -- client had the same bug: a batch weighed over a cited maximum reported
  -- itself as under it, because only the recipe was consulted.
  (r.source_max_gr is not null
     and coalesce(b.charge_actual_gr, r.charge_gr) > r.source_max_gr) as over_published_max,
  r.status                      as recipe_status,
  -- 0007: the sizing actually used on this batch.
  coalesce(b.cbto_mean_in, r.cbto_in) as cbto_loaded_in,
  b.bump_in                     as batch_bump_in,
  b.bushing,
  b.primer_depth_in
from public.batches b
join public.recipes r          on r.id = b.recipe_id and r.deleted_at is null
left join public.bullet_products bp on bp.id = r.bullet_id and bp.deleted_at is null
left join public.powder_products pw on pw.id = r.powder_id and pw.deleted_at is null
left join public.primer_products pr on pr.id = r.primer_id and pr.deleted_at is null
left join public.firearms f    on f.id = r.firearm_id and f.deleted_at is null
left join lateral (
  select s.* from public.range_sessions s
  where s.batch_id = b.id and s.deleted_at is null and s.velocity_avg_fps is not null
  order by s.occurred_on desc, s.created_at desc
  limit 1
) v on true
where b.deleted_at is null;
