-- ============================================================================
-- 0013 — an index the pull can actually walk.
--
-- The client stopped paging with LIMIT/OFFSET. It had to: OFFSET is only sound
-- over a result set whose ordering holds still for the whole walk, and this one
-- does not. `set_updated_at` re-stamps an edited row, which moves it to the end
-- of an ascending order and shifts everything below it up a slot — so the row
-- sitting on the next offset boundary is stepped over, and because the cursor
-- then advances to the newest row the pull DID return, `updated_at > cursor`
-- excludes the skipped one forever. Not eventually consistent. Gone, for that
-- device, on the first sync of a new phone or a restore, which is exactly when
-- a shooter is watching a year of data come down.
--
-- The replacement walks a keyset on (updated_at, id):
--
--   order=updated_at.asc,id.asc
--   or=(updated_at.gt.T,and(updated_at.eq.T,id.gt.ID))
--
-- `id` is not decoration. `updated_at` defaults to now(), and now() is the
-- TRANSACTION timestamp, so every row of one bulk push carries an identical
-- stamp — seven firearms in one POST come back with one distinct value between
-- them. Ordering by updated_at alone is a partial order, and a page boundary
-- inside a tie group has no defined position to resume from. The primary key
-- completes it; nothing else in the schema can, since updated_at carries no
-- unique constraint anywhere and there is no other candidate.
--
-- The existing ix_*_sync indexes are (user_id, updated_at DESC), which the new
-- walk cannot use: wrong direction, and no tiebreaker, so Postgres range-scans
-- and then sorts. Correct but not free, and it degrades precisely on the big
-- first pull. These are the matching ascending, tie-broken pairs.
--
-- The DESC indexes are deliberately KEPT. They are what the "most recent first"
-- reads use, and dropping them to save space would trade a cheap index for a
-- sort on every screen that lists anything.
--
-- Safe to run twice, and safe to run before or after 0012.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'firearms','bullet_products','powder_products','primer_products',
    'component_lots','brass_lots','brass_events','recipes','batches',
    'range_sessions','shots','groups','dope_entries'
  ] loop
    execute format(
      'create index if not exists %I on public.%I (user_id, updated_at asc, id asc)',
      'ix_' || t || '_keyset', t);
  end loop;
end $$;

/* The leaderboard is world-readable and pulled without a user_id predicate, so
 * its keyset index is on the ordering columns alone. */
create index if not exists ix_lbe_keyset
  on public.leaderboard_entries (updated_at asc, id asc);
create index if not exists ix_lbp_keyset
  on public.leaderboard_profiles (updated_at asc, id asc);
