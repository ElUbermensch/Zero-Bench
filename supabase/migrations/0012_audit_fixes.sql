-- ============================================================================
-- 0012 — two defects a pre-monetization audit found, both of which ship data
--        loss or a privacy leak to a paying user.
--
-- Neither was visible to 777 passing client assertions, because both live in
-- the gap between what the mock enforces and what Postgres enforces.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. A TOMBSTONED SHOT MUST NOT RESERVE ITS NUMBER FOREVER
--
-- `unique (session_id, shot_no)` (0001:343) is unconditional, and a soft delete
-- leaves the row in the table. So a deleted shot goes on holding its number
-- against every future write.
--
-- Concretely, and this is a real sequence a user performs: log a twelve-shot
-- string, notice shot 5 was scored wrong, delete it. The client tombstones that
-- row (PATCH deleted_at) and the remaining shots are pushed again. Shot 6 is
-- now the fifth surviving shot; it arrives claiming (session, 5); the
-- tombstoned row still holds it; Postgres answers 23505. A 23505 is a
-- permanent 4xx, so the outbox dead-letters the row rather than retrying — and
-- that session's string never syncs again, with no error the user ever sees.
--
-- The client half of this fix makes shot numbers stable, so the collision
-- cannot be provoked that way any more. This half makes the constraint say what
-- it actually means: a deleted shot is not occupying a number.
--
-- A partial unique INDEX rather than a constraint, because a UNIQUE CONSTRAINT
-- cannot carry a WHERE clause in Postgres. PostgREST's on_conflict does not
-- need one, and nothing in either client names the constraint.
alter table public.shots
  drop constraint if exists shots_session_id_shot_no_key;

create unique index if not exists shots_session_shot_no_live_idx
  on public.shots (session_id, shot_no)
  where deleted_at is null;

comment on index public.shots_session_shot_no_live_idx is
  'Partial on deleted_at: a tombstoned shot releases its number. An unconditional unique key made a mid-string delete permanently un-syncable.';

-- ---------------------------------------------------------------------------
-- 2. RETRACTING A LEADERBOARD ENTRY DID NOT RETRACT IT
--
-- `lbe_select_all ... for select using (true)` (0002:71) is deliberately
-- world-readable — that is what makes a shared board possible. But it has no
-- `deleted_at` predicate and `leaderboard_entries` is granted to
-- `authenticated` directly, not only through the view.
--
-- So: a shooter publishes a score, regrets it, taps retract. The client
-- soft-deletes the row. It vanishes from `v_leaderboard`, which is all the app
-- reads, so the UI honestly reports it gone — and any other account can still
-- read it with one request against the raw table.
--
-- THE OBVIOUS FIX DOES NOT WORK, and the reason is worth writing down because
-- it will be rediscovered otherwise. Adding `deleted_at is null` to the SELECT
-- policy makes the soft delete itself impossible: Postgres requires an updated
-- row to remain visible under the table's SELECT policies, so the UPDATE that
-- sets `deleted_at` is refused with "new row violates row-level security
-- policy". Verified directly on a scratch table, not reasoned about.
--
-- A soft delete and a SELECT policy that hides tombstones cannot coexist.
-- Something has to give, and here it should be the tombstone: a leaderboard
-- entry is PUBLISHED, not synced. Nothing pulls it, no other device needs to
-- learn it was withdrawn, and re-publishing mints the same id again. There is
-- nothing for a tombstone to do except keep the data readable.
--
-- So retract becomes a real DELETE, and the row stops existing. The policy
-- below is unchanged from 0002 and is restated only so this file is a complete
-- description of the end state.
drop policy if exists lbe_select_all on public.leaderboard_entries;
create policy lbe_select_all on public.leaderboard_entries for select using (true);

-- Rows retracted BEFORE this migration are still sitting there readable. The
-- app has already told those users the entries are gone, so make that true.
delete from public.leaderboard_entries where deleted_at is not null;

-- ---------------------------------------------------------------------------
-- 3. THE BACKUP CEILING APPLIED TO ONE COLUMN OF FOUR
--
-- 0010 justifies letting clients upload whole-device snapshots by bounding what
-- one account can store: 2 apps x 4 slots x 8 MiB. That bound is enforced on
-- `payload` alone. `counts`, `device_label` and `app_build` are unbounded, so
-- the same eight rows can carry gigabytes in the columns nobody thought to cap.
--
-- For a product paying for its own storage, an unmetered write endpoint behind
-- an ordinary sign-up is a bill, not just an untidiness.
do $$ begin
  alter table public.account_backups
    add constraint account_backups_meta_bounded
    check (octet_length(coalesce(device_label, '')) <= 120
       and octet_length(coalesce(app_build, ''))    <= 120
       and octet_length(counts::text)               <= 4096);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 4. A PARTICIPANT'S NAME IS RE-SENT TO EVERY DEVICE ON EVERY POLL
--
-- relay_messages.body is capped at 500 characters (0004:135). The participant
-- NAME beside it is uncapped, and relay_state emits every participant's name to
-- every device on a 2.5-second poll with no cursor. One PATCH turns that poll
-- into a multi-megabyte response for every phone on the relay, for as long as
-- the relay lives.
do $$ begin
  alter table public.relay_participants
    add constraint relay_participants_name_bounded
    check (name is null or char_length(name) <= 60);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- 5. A COACH COULD PROMOTE ITSELF TO SHOOTER
--
-- relay_shots_insert_own requires role = 'shooter', and 0004's comment claims
-- a coach therefore cannot fabricate a string. But relay_part_update_self's
-- WITH CHECK constrains only user_id, so a coach can PATCH its own row to
-- role='shooter' and walk straight through the gate.
--
-- Role and slot are assigned when you join. Keeping your own name and your own
-- distance current is the point of that policy; reassigning yourself a role is
-- not.
drop policy if exists relay_part_update_self on public.relay_participants;
create policy relay_part_update_self on public.relay_participants
  for update using (user_id = auth.uid())
  with check (user_id = auth.uid()
              and role = (select p.role from public.relay_participants p
                           where p.relay_id = relay_participants.relay_id
                             and p.user_id  = auth.uid())
              and slot is not distinct from (select p.slot from public.relay_participants p
                           where p.relay_id = relay_participants.relay_id
                             and p.user_id  = auth.uid()));
