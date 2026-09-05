-- ============================================================================
-- A refusal outranks everything, including being an admin.
--
-- 0021's has_access() reads:
--
--     is_admin() OR there is an approved row
--
-- which has a hole in it that only shows up when you try to use the feature it
-- was built for. The owner can revoke anybody -- except an admin. Setting an
-- admin's row to `revoked` changes the row and changes nothing else: the first
-- half of that OR is still true, so they keep every table. The one account
-- most worth being able to switch off is the one account the switch does not
-- reach.
--
-- The admin bypass itself is not the mistake and is not being removed. It is
-- there because an owner who has to approve themselves before they can approve
-- anybody is an owner locked out on day one, with no path back that does not
-- involve hand-editing SQL. What is wrong is its PRECEDENCE: a standing
-- exemption should not survive an explicit decision about the same account.
--
-- So the order becomes:
--
--     1. explicitly denied or revoked?   -> no, whoever you are
--     2. otherwise admin?                -> yes
--     3. otherwise approved?             -> yes
--     4. otherwise                       -> no
--
-- Step 1 is new and is the whole migration.
--
-- This does not lock an owner out of their own dashboard, and the difference
-- is worth being explicit about, because "revoke can reach the owner" would be
-- alarming if it did. The dashboard reads access_request and calls
-- decide_access() under is_admin_mfa(), which is a separate predicate and is
-- untouched here. A self-revoked owner loses the two APPS -- their logbook,
-- their sync -- and keeps the Access tab, where one button puts it back. The
-- mistake is recoverable by the person who made it, without SQL.
-- ============================================================================

create or replace function public.has_access()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select case
    /* An explicit refusal, first and unconditionally. `denied` is here as well
     * as `revoked` because the two differ only in history -- one never had
     * access, the other did -- and it would be strange for the harsher-sounding
     * of the two to be the one an admin could sit through. */
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
  'True when the caller has been let into the beta, or is the owner -- unless '
  'their request has been explicitly denied or revoked, which outranks both. '
  'The predicate every restrictive policy is built on.';

/*
 * my_access_status() gets the same correction, for a smaller but sharper
 * reason: it told an admin `approved` from a hard-coded branch when they had
 * no row, and it would have gone on saying `approved` to an admin whose row
 * said `revoked` -- because it reads the row first and the row is right there.
 * That much was already correct. What was not is the no-row case for an admin
 * who has since been revoked... which cannot happen, since a revoked row IS a
 * row. The real change is smaller: the fallback now agrees with has_access()
 * by construction rather than by both files happening to say the same thing.
 *
 * A hold screen that says "you are in" to somebody every table is refusing is
 * the single worst failure this feature can have -- it turns a clear refusal
 * into a bug report about sync.
 */
create or replace function public.my_access_status()
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (select jsonb_build_object(
        'status',       a.status,
        'requested_at', a.requested_at,
        'decided_at',   a.decided_at,
        'heard_from',   a.heard_from,
        'heard_detail', a.heard_detail)
       from public.access_request a where a.user_id = auth.uid()),
    jsonb_build_object('status', case when public.has_access() then 'approved'
                                      else 'unknown' end));
$$;

comment on function public.my_access_status is
  'The caller''s own beta status, without the owner''s note or the billing '
  'columns. Its no-row fallback defers to has_access() so the hold screen and '
  'the policies cannot disagree.';

/*
 * And an account that has never asked can be refused too.
 *
 * decide_access() updates an existing row and raises P0002 when there is not
 * one. Post-0021 every non-anonymous account has a row, so this is a corner --
 * but the corner is exactly the account somebody would want to shut off in a
 * hurry: one created while the migration was mid-deploy, or by a path that
 * bypassed the trigger. "I cannot revoke that one, it has no row" is not an
 * answer an owner should ever be given about their own product.
 *
 * Written as an upsert rather than a second function so the dashboard keeps
 * one verb, and so the audit row is still written by the same code path.
 */
create or replace function public.decide_access(
  p_user_id uuid, p_status text, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare r public.access_request;
begin
  if not public.is_admin_mfa() then
    raise exception 'not permitted' using errcode = '42501';
  end if;
  if p_status not in ('pending', 'approved', 'denied', 'revoked') then
    raise exception 'unknown status: %', p_status using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    raise exception 'no account with id %', p_user_id using errcode = 'P0002';
  end if;

  insert into public.access_request (user_id, email, status, note,
                                     decided_at, decided_by)
  select p_user_id, u.email, p_status,
         nullif(trim(coalesce(p_note, '')), ''), now(), auth.uid()
    from auth.users u where u.id = p_user_id
  on conflict (user_id) do update set
    status     = excluded.status,
    -- An empty note leaves the previous one standing. Clearing a note is not
    -- something the dashboard offers, and treating "I did not type anything"
    -- as "erase what is there" would quietly lose the reason for a decision
    -- every time somebody changed their mind about one.
    note       = coalesce(excluded.note, public.access_request.note),
    decided_at = now(),
    decided_by = auth.uid()
  returning * into r;

  insert into public.owner_action_log
    (actor_id, action, subject_id, subject_email, ok, detail)
  values (auth.uid(), 'access_decide', r.user_id, r.email, true,
          jsonb_build_object('status', r.status, 'note', r.note,
                             'balance_cents', r.balance_cents));

  return to_jsonb(r);
end $$;

revoke all on function public.has_access() from public;
revoke all on function public.my_access_status() from public;
revoke all on function public.decide_access(uuid, text, text) from public;
grant execute on function public.has_access() to anon, authenticated;
grant execute on function public.my_access_status() to authenticated;
grant execute on function public.decide_access(uuid, text, text) to authenticated;
