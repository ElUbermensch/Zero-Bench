-- What a click is worth, on the row both apps share.
--
-- Zero stores every sight setting as integer CLICKS -- lossless, and what the
-- shooter actually does at the firing point. Decoding those clicks into an
-- angle needs the sight, and until now the sight was a single constant in
-- Zero's source (0.25 MOA), which is true of a standard target turret and of
-- nothing else: a 1/8-MOA benchrest scope, a 1/2-MOA match rear sight and a
-- 0.1-mil PRS scope were all read back as quarter minutes.
--
-- The sight belongs on the firearm because it is a property of the firearm,
-- and it belongs on the SHARED firearm row for the same reason barrel life
-- does (see 0008): a firearm that travels to Bench and back must come home
-- carrying everything Zero knows about it. Bench neither displays nor writes
-- these; PostgREST's merge-duplicates upsert only touches the columns in the
-- payload, and Bench's payload does not name them, so its pushes leave them
-- standing.
--
-- Elevation and windage are separate columns rather than one, because match
-- iron sights routinely move a different amount per click on each axis and a
-- single value would force one of the two to be wrong. Both nullable: a null
-- means "never stated", which the app reads as the pre-feature 1/4 MOA rather
-- than inventing a sight the shooter never described.
--
-- The stored numbers are in the firearm's OWN unit -- 0.25 with sight_unit
-- 'moa' is a quarter minute, 0.1 with 'mil' is a tenth of a milliradian.
-- Storing a normalised angle instead would round 0.1 mil to 0.3438 MOA and
-- the turret's own label would stop being recoverable from the row.

alter table public.firearms
  add column if not exists sight_unit text,
  add column if not exists click_elev numeric(6,4),
  add column if not exists click_wind numeric(6,4);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'firearms_sight_unit_valid') then
    alter table public.firearms
      add constraint firearms_sight_unit_valid
      check (sight_unit is null or sight_unit in ('moa', 'mil'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'firearms_click_elev_positive') then
    alter table public.firearms
      add constraint firearms_click_elev_positive
      check (click_elev is null or click_elev > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'firearms_click_wind_positive') then
    alter table public.firearms
      add constraint firearms_click_wind_positive
      check (click_wind is null or click_wind > 0);
  end if;
end $$;

comment on column public.firearms.sight_unit is
  'MOA or mil -- the unit this firearm''s sight is graduated in, and the unit Zero displays its dial in. Null = never stated; read as MOA.';
comment on column public.firearms.click_elev is
  'Elevation detent size, in sight_unit (0.25 = 1/4 MOA, 0.1 = one tenth mil). Null = never stated; read as 0.25 MOA.';
comment on column public.firearms.click_wind is
  'Windage detent size, in sight_unit. Separate from elevation because match iron sights often differ between the two axes.';
