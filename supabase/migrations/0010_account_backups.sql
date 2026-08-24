-- ============================================================================
-- 0010 — whole-device backups, so a second phone is a restore and not a retype
--
-- WHY THIS IS NOT MORE SYNC TABLES
--
-- The per-record sync in 0001 covers the records both apps genuinely share: a
-- firearm, a batch, a session, a group. It deliberately does not cover Zero's
-- targets, matches, dope cards, drills or settings, because Bench has no
-- concept of any of them and a table nobody reads is a table nobody maintains.
--
-- Moving to a second device needed all of it anyway, and the only mechanism
-- for that was a JSON file the user had to carry across by hand -- which on a
-- home-screen PWA on iOS mostly meant it could not be carried across at all.
--
-- So: one row per account per app, holding one snapshot. Not a sync. It has no
-- cursor, no outbox, no conflict resolution and no partial application. It is
-- the file that used to live in Downloads, kept somewhere the other phone can
-- reach.
--
-- WHAT BOUNDS IT
--
-- The stated worry was that letting people import data could eventually put
-- enough of it on the server to bring it down. Note first that the file import
-- never touched the server at all -- it was local, start to finish -- so the
-- risk was never there. Where unbounded growth IS possible is the per-record
-- tables, which accept as many rows as a client cares to send.
--
-- This table is the opposite of that, and deliberately:
--
--   * `unique (user_id, app, slot)` with a small fixed slot vocabulary means
--     an account holds a fixed, countable number of backup rows. A thousand
--     backups overwrite one row a thousand times; they do not accumulate.
--   * `octet_length(payload) <= 8 MiB` is a hard ceiling per row, enforced by
--     the database rather than by the client that is trying to exceed it.
--
-- Ceiling per account is therefore bytes, not rows: 2 apps x 4 slots x 8 MiB.
-- For scale, a bench of 300 batches or four seasons of scored sessions is a
-- low single-digit number of megabytes before compression.
-- ============================================================================

create table if not exists public.account_backups (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid()
                  references auth.users(id) on delete cascade,

  -- Which app wrote it. The two models are unrelated: restoring a Bench
  -- snapshot into Zero would be nonsense, so they cannot collide by accident.
  app           text not null check (app in ('zero', 'bench')),

  -- A small fixed vocabulary rather than free text, which is what makes the
  -- row count per account bounded. 'auto' is the one the app writes without
  -- being asked; the numbered slots are for a user keeping a known-good copy
  -- before doing something drastic.
  slot          text not null default 'default'
                  check (slot in ('default', 'auto', 'slot2', 'slot3')),

  -- Whose phone this came off, for the restore screen. Free text and purely
  -- descriptive: nothing keys off it.
  device_label  text,

  -- The snapshot, as the JSON text the app already knows how to read. Text
  -- rather than jsonb on purpose: the cap below has to be immutable to sit in
  -- a check constraint, and it is the transported size that matters, not the
  -- parsed one. The app never queries inside it.
  payload       text not null
                  check (octet_length(payload) <= 8388608),

  -- What is in there, so the restore screen can say "412 sessions, 38 batches"
  -- before pulling megabytes down a phone connection. Written by the client
  -- and advisory only -- it is a label on a box, not an index.
  counts        jsonb not null default '{}'::jsonb,

  -- Which build wrote it, for the case where an old snapshot meets a newer
  -- app and something has to decide whether it can be read.
  app_build     text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (user_id, app, slot)
);

comment on table public.account_backups is
  'One whole-device snapshot per (account, app, slot). Not a sync surface: no cursor, no merge, no partial application.';

create index if not exists account_backups_user_idx
  on public.account_backups (user_id, app, updated_at desc);

-- The generic stamp trigger from 0001. A restore compares timestamps to decide
-- which of two devices backed up more recently, so the server has to own them.
drop trigger if exists account_backups_set_updated_at on public.account_backups;
create trigger account_backups_set_updated_at
  before update on public.account_backups
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------------- RLS
alter table public.account_backups enable row level security;

-- Your own backups, all four verbs, and nobody else's under any of them. There
-- is no sharing story here and there should not be: this row is the entire
-- contents of someone's phone.
drop policy if exists account_backups_select_own on public.account_backups;
create policy account_backups_select_own on public.account_backups
  for select using (user_id = auth.uid());

drop policy if exists account_backups_insert_own on public.account_backups;
create policy account_backups_insert_own on public.account_backups
  for insert with check (user_id = auth.uid());

drop policy if exists account_backups_update_own on public.account_backups;
create policy account_backups_update_own on public.account_backups
  for update using (user_id = auth.uid())
           with check (user_id = auth.uid());

drop policy if exists account_backups_delete_own on public.account_backups;
create policy account_backups_delete_own on public.account_backups
  for delete using (user_id = auth.uid());

-- An anonymous device exists for the relay: it is a throwaway identity created
-- to shoot one pair-fire string, and it must not be able to park 8 MiB per
-- slot on the server. RESTRICTIVE, so it ANDs with the policies above rather
-- than offering an alternative route past them.
drop policy if exists account_backups_no_anon on public.account_backups;
create policy account_backups_no_anon on public.account_backups
  as restrictive for all
  using ((select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)) is false)
  with check ((select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)) is false);

grant select, insert, update, delete on public.account_backups to authenticated;

-- ------------------------------------------------------------------ index
-- The restore screen lists what is available WITHOUT downloading it. Selecting
-- every column but `payload` does that, and this view makes it one name rather
-- than a column list each caller has to keep in step with the table.
--
-- security_invoker, like every other view here: the view must not become a way
-- to read rows the policies above would refuse.
create or replace view public.v_account_backups
with (security_invoker = true) as
select id, user_id, app, slot, device_label, counts, app_build,
       octet_length(payload) as bytes,
       created_at, updated_at
from public.account_backups;

grant select on public.v_account_backups to authenticated;
