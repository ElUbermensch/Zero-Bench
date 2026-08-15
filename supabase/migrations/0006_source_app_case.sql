-- ============================================================================
-- 0006 — source_app is lower case, everywhere, always
-- ============================================================================
--
-- 0001 wrote `check (source_app in ('Bench','zero'))`. One capital letter, and
-- it was never exercised: the JS mock backend does not enforce check
-- constraints, so every Bench test passed against a value the real database
-- rejects outright. Bench sends 'bench'. The first real sync would have failed
-- with a 400 on every range_session and every group — the chronograph data and
-- the group sizes, which is most of what Bench exists to record.
--
-- Case-sensitivity in an identifier column is a trap rather than a check, so
-- the fix is to normalise rather than to teach the client to shout: both apps
-- already emit lower case, and now the column only accepts it.

-- Existing rows first — the constraint swap below would reject them otherwise.
update public.range_sessions set source_app = lower(source_app)
 where source_app <> lower(source_app);
update public.groups         set source_app = lower(source_app)
 where source_app <> lower(source_app);

alter table public.range_sessions
  drop constraint if exists range_sessions_source_app_check;
alter table public.range_sessions
  alter column source_app set default 'bench',
  add constraint range_sessions_source_app_check
    check (source_app in ('bench','zero'));

alter table public.groups
  drop constraint if exists groups_source_app_check;
alter table public.groups
  alter column source_app set default 'zero',
  add constraint groups_source_app_check
    check (source_app in ('bench','zero'));

-- 0002's leaderboard carried the same typo. Nothing writes 'Bench' there today,
-- but leaving one table case-sensitive is how the trap gets reset.
update public.leaderboard_entries set source_app = lower(source_app)
 where source_app <> lower(source_app);
alter table public.leaderboard_entries
  drop constraint if exists leaderboard_entries_source_app_check;
alter table public.leaderboard_entries
  add constraint leaderboard_entries_source_app_check
    check (source_app in ('bench','zero'));
