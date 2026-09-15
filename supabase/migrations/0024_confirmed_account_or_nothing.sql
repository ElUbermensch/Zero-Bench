-- ============================================================================
-- Nothing in the suite without an account, and no account without a confirmed
-- email.
--
-- Numbered 0024, not 0022. The five-part spec this implements was written
-- against a database whose newest migration was 0021, and called itself 0022.
-- 0022 was taken in the meantime -- by `revoke_is_absolute`, which rewrote the
-- very function part 2 touches -- and 0023 by the sight-unit work. The spec is
-- unchanged; only the number and the baseline it edits are.
--
-- Five things, one of which (part 2) is the requirement and four of which are
-- holes found while checking whether part 2 would be enough. It would not:
--
--   1. profiles.is_admin is column-UPDATE-grantable to anon and authenticated,
--      and RLS cannot scope by column. Any approved user could PATCH their own
--      row to is_admin=true, self-enrol TOTP for aal2, and become the owner.
--   2. has_access() admits anonymous identities and unconfirmed emails.
--   3. may_relay() is `is_anonymous OR has_access()`, so pair fire was gated in
--      the UI and open at the API.
--   4. analytics_event has no restrictive policy at all, and the two
--      leaderboard SELECT policies are USING (true).
--   5. is_admin_mfa() and enforce_relay_access() have a mutable search_path.
--      is_admin_mfa() is the highest-privilege predicate in the system.
--
-- NOT done here, because SQL cannot: turn off anonymous sign-ins in the
-- Supabase Auth dashboard. Part 3 makes an anonymous identity useless, but the
-- client still mints one before it finds that out -- zero-core's createRelay()
-- and joinRelay() both call ensureIdentity(), which signs in anonymously when
-- signed out. Until that toggle is off, every pair-fire tap by a signed-out
-- user still creates a permanent auth.users row for free and then fails.
-- There are 13 such rows already.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Refuse to run if it would lock the owner out.
--
-- Part 2 makes a confirmed email a precondition for everything. If no admin
-- account satisfies it, applying this migration locks every human out of the
-- product and out of the dashboard that could undo it, with no path back that
-- does not involve hand-editing SQL as the postgres role.
--
-- Checked first, and fatal. Nothing below has run when this raises.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
      from public.profiles p
      join auth.users u on u.id = p.id
     where p.is_admin
       and coalesce(u.is_anonymous, false) = false
       and u.email_confirmed_at is not null
  ) then
    raise exception
      'ABORT 0024: no non-anonymous, email-confirmed admin account exists. '
      'Confirm the owner''s email address and re-run. Nothing has changed.'
      using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 1. is_admin stops being a column the client can write.
--
-- Both halves are needed and neither is redundant.
--
-- The revoke alone leaves the delete-then-reinsert path open: profiles carries
-- a permissive INSERT policy with CHECK (auth.uid() = id) and a permissive
-- DELETE policy with USING (auth.uid() = id), so a user who cannot UPDATE the
-- column can still drop their row and insert a replacement carrying it.
--
-- The trigger alone is undone by a future `grant all on public.profiles`,
-- which is one careless line in a later migration and leaves no trace at the
-- call site.
-- ---------------------------------------------------------------------------
revoke update (is_admin) on public.profiles from anon, authenticated;
revoke insert (is_admin) on public.profiles from anon, authenticated;

create or replace function public.profiles_guard_admin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  /* Only a request that came through PostgREST has an auth.uid(). A direct SQL
   * session -- the dashboard editor, a migration, psql as postgres -- has none,
   * and has to stay able to appoint the first admin; otherwise the bootstrap
   * path is "disable this trigger first", which is worse than the hole. Anyone
   * with a direct connection owns the database already. */
  if auth.uid() is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if coalesce(new.is_admin, false) and not public.is_admin_mfa() then
      new.is_admin := false;
    end if;
  else
    if new.is_admin is distinct from old.is_admin
       and not public.is_admin_mfa() then
      new.is_admin := old.is_admin;
    end if;
  end if;
  return new;
end $$;

comment on function public.profiles_guard_admin is
  'Reverts any change to profiles.is_admin that did not come from an admin at '
  'aal2. Silent rather than raising: the apps never send this column, so a '
  'request that does is not a user mistake to report back.';

drop trigger if exists profiles_guard_admin on public.profiles;
create trigger profiles_guard_admin
  before insert or update on public.profiles
  for each row execute function public.profiles_guard_admin();

-- ---------------------------------------------------------------------------
-- 2. The requirement itself: a real, confirmed account or nothing.
--
-- Read from auth.users rather than from the is_anonymous JWT claim. The claim
-- is what may_relay() trusted, and a claim is a statement the token makes
-- about itself; email_confirmed_at is a fact the auth schema holds.
-- has_access() is already SECURITY DEFINER, so it can read auth.users and its
-- callers cannot.
--
-- The new precondition goes AHEAD of the refusal check, and the refusal check
-- stays ahead of the is_admin() limb -- that ordering is 0022 and it is what
-- makes a revoke outrank a self-made admin. Order, top to bottom:
--
--     1. anonymous, or email not confirmed?  -> no, whoever you are
--     2. explicitly denied or revoked?       -> no, whoever you are
--     3. otherwise admin?                    -> yes
--     4. otherwise approved?                 -> yes
--     5. otherwise                           -> no
--
-- Step 1 is new. Steps 2-5 are 0022, unchanged.
--
-- One live account is affected: approved on 2026-09-11, confirmation mail sent,
-- never confirmed and never once signed in. It loses nothing it was using, and
-- the confirmation link in its inbox still works -- clicking it sets
-- email_confirmed_at and step 1 passes. That is the requirement behaving as
-- intended, not a casualty of it.
-- ---------------------------------------------------------------------------
create or replace function public.has_access()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select case
    /* A confirmed email is the floor. An anonymous identity is free and
     * self-service, so anything it can reach is free and self-service too. */
    when not exists (select 1 from auth.users u
                      where u.id = auth.uid()
                        and coalesce(u.is_anonymous, false) = false
                        and u.email_confirmed_at is not null)
      then false
    /* An explicit refusal, ahead of the admin limb. See 0022. */
    when exists (select 1 from public.access_request a
                  where a.user_id = auth.uid()
                    and a.status in ('denied', 'revoked'))
      then false
    else public.is_admin()
      or exists (select 1 from public.access_request a
                  where a.user_id = auth.uid() and a.status = 'approved')
  end;
$$;

comment on function public.has_access is
  'True when the caller holds a non-anonymous account with a confirmed email '
  'AND has been let into the beta or is the owner -- unless their request has '
  'been explicitly denied or revoked, which outranks both. The predicate every '
  'restrictive policy is built on.';

-- ---------------------------------------------------------------------------
-- 3. Pair fire becomes an account-holder feature at the database, not the UI.
--
-- may_relay() read `is_anonymous OR has_access()`, so the relay tables were
-- open to any anonymous JWT -- which anyone can mint, unauthenticated, for
-- free. "Pair fire needs an account" was true of the join screen and false of
-- the four tables behind it.
--
-- The four restrictive policies that call this (relays, relay_participants,
-- relay_shots, relay_messages) need no edit; they gain the new meaning by
-- calling the same name. The two SECURITY DEFINER entry points, create_relay()
-- and join_relay(), check only `auth.uid() is null` and would have bypassed a
-- policy change -- but both insert into a table carrying the
-- enforce_relay_access BEFORE INSERT trigger (relays, relay_participants),
-- which calls may_relay(), so they are covered by this line too.
-- ---------------------------------------------------------------------------
create or replace function public.may_relay()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.has_access();
$$;

comment on function public.may_relay is
  'Pair fire is an account-holder feature. Kept as a separate name from '
  'has_access() so the relay policies and the trigger read as what they are, '
  'and so a future carve-out has one place to be argued for.';

-- ---------------------------------------------------------------------------
-- 4. The two tables the gate never reached.
--
-- analytics_event had no restrictive policy -- the only table without one,
-- which falsifies "0021 put restrictive policies on every table". Append-only
-- did hold (there is no permissive UPDATE or DELETE), but any identity
-- including a free anonymous one could insert unbounded rows into it.
--
-- The leaderboard's two SELECT policies were USING (true): readable with no
-- account at all, which exposed handle -> auth user UUID to anyone who asked.
-- Their INSERT/UPDATE/DELETE restrictive policies were already has_access();
-- SELECT was the one command with no restrictive policy over it, so USING
-- (true) stood unopposed.
--
-- site_visit is deliberately left alone. It is the marketing site's pageview
-- log, and gating it would gate the signup funnel itself -- the visit is
-- recorded before there is an account to record it against.
-- ---------------------------------------------------------------------------
drop policy if exists analytics_event_needs_access on public.analytics_event;
create policy analytics_event_needs_access on public.analytics_event
  as restrictive for all
  using (public.has_access())
  with check (public.has_access());

alter policy lbp_select_all on public.leaderboard_profiles
  using (public.has_access());
alter policy lbe_select_all on public.leaderboard_entries
  using (public.has_access());

-- ---------------------------------------------------------------------------
-- 5. The two functions with a mutable search_path that matter most.
--
-- is_admin_mfa() decides whether decide_access(), set_access_billing() and
-- every admin SELECT will run. enforce_relay_access() is a trigger that fires
-- inside two SECURITY DEFINER functions. Neither pinned its search_path.
--
-- Four others are still unpinned -- set_updated_at, es_to_sigma, keepalive,
-- gen_relay_code -- and are tracked as housekeeping. None of them decides
-- anything, so none is in this migration.
-- ---------------------------------------------------------------------------
alter function public.is_admin_mfa() set search_path = public;
alter function public.enforce_relay_access() set search_path = public;
