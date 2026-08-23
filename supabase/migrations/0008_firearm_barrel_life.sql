-- Firearms are the one record both apps genuinely own.
--
-- Bench records a firearm because a batch gets fired from it and the brass
-- comes back marked; Zero records the same firearm because a group is
-- attributed to it and its barrel is wearing out. Making the user enter it
-- twice is the redundancy this suite exists to remove -- but a shared row only
-- works if it can carry BOTH apps' fields. It could not: barrel life and the
-- starting round count are Zero's, and the table had nowhere to put them, so a
-- firearm that travelled to Bench and back came home with Zero's barrel-life
-- tracking erased.
--
-- `round_count` already existed and is NOT the same thing. It is a total, and
-- nothing maintains it; Zero derives the count from its sessions. What Zero
-- needs stored is the OFFSET -- rounds fired before the log existed -- plus the
-- expected life to measure against.
--
-- Both are nullable-or-defaulted so every existing row stays valid, and both
-- carry the same check constraints the app enforces in its form, because a
-- constraint that only lives in the client is a constraint the other client
-- does not have.

alter table public.firearms
  add column if not exists barrel_life_rounds integer,
  add column if not exists rounds_at_start    integer not null default 0;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'firearms_barrel_life_positive') then
    alter table public.firearms
      add constraint firearms_barrel_life_positive
      check (barrel_life_rounds is null or barrel_life_rounds > 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'firearms_rounds_at_start_nonneg') then
    alter table public.firearms
      add constraint firearms_rounds_at_start_nonneg
      check (rounds_at_start >= 0);
  end if;
end $$;

comment on column public.firearms.barrel_life_rounds is
  'Expected barrel life in rounds. Zero measures wear against this; Bench does not display it but must not destroy it.';
comment on column public.firearms.rounds_at_start is
  'Rounds through the barrel before it was logged. An offset, not a total: the live count is this plus what the sessions add up to.';
