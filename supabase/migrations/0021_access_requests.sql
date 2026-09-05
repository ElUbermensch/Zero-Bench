-- ============================================================================
-- The beta gate: an account is not an entitlement.
--
-- Every table in this schema has answered one question since 0001 -- "is this
-- row yours?" -- and answered it the same way for everybody who could sign up.
-- Signing up WAS the entitlement. This migration inserts a second question in
-- front of the first: "has the owner let you in yet?"
--
-- The reason it is a table and a policy rather than a screen is that a screen
-- is not a gate. Both apps are static bundles served with the publishable key;
-- an "access denied" card in the JavaScript is a card whose condition can be
-- edited in devtools, and the REST endpoint underneath it never heard about
-- the card at all. So the hold screen in the apps is the COURTESY, and what is
-- below is the enforcement. They are deliberately two different mechanisms
-- saying the same thing, and only one of them is load-bearing.
--
-- Shape of the thing:
--
--   * every non-anonymous sign-up gets a row, written by a trigger on
--     auth.users, so there is no path to an account that does not also file a
--     request. A client that skips the call cannot skip the trigger.
--   * the row starts `pending` and nothing but an owner RPC moves it. There is
--     no update policy for anybody, including the owner -- approving goes
--     through decide_access(), which writes the audit entry in the same
--     transaction as the decision. An approval that is not in the log is one
--     that did not happen.
--   * has_access() is then folded into every data table as a RESTRICTIVE
--     policy, which is the only kind that can take access away. A permissive
--     policy added beside the 0001 ones would be OR-ed with them and would
--     have granted MORE, not less -- the classic way to write this backwards.
--
-- Monetisation is next, and this table is shaped for it now rather than being
-- widened under a live paywall. Approval is already the moment money would be
-- checked, so the amounts live on the row the approval reads: `balance_cents`
-- is due minus paid, and "the balance is met" is `<= 0`. The decision stays a
-- human one -- nothing here auto-approves on payment -- but the owner sees the
-- number next to the button.
-- ============================================================================

create table public.access_request (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  -- Copied from auth.users at sign-up rather than joined at read time. The
  -- dashboard reads this table under RLS and cannot see auth.users at all;
  -- without the address a pending row is an opaque uuid, which is not
  -- something an owner can make a decision about.
  email        text,
  status       text not null default 'pending'
                 check (status in ('pending', 'approved', 'denied', 'revoked')),

  /* Marketing. `heard_from` is the bucket the sign-up form offered and is what
   * gets counted; `heard_detail` is the free text behind it -- WHICH podcast,
   * WHICH forum -- and is the half that is actually actionable. Capped rather
   * than constrained to a fixed list: a CHECK against the options the current
   * build happens to show would start refusing sign-ups the day the form gains
   * an option, and a refused sign-up is a lost customer over a taxonomy. */
  heard_from   text check (heard_from is null or length(heard_from) <= 60),
  heard_detail text check (heard_detail is null or length(heard_detail) <= 280),

  requested_at timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid references auth.users(id) on delete set null,
  -- The owner's note, and the reason users get no select policy on this table.
  -- RLS is row-level; there is no way to hand somebody their own row while
  -- withholding a column of it. my_access_status() below exists for that.
  note         text,

  /* ------------------------------------------------- monetisation, staged */
  plan              text,
  amount_due_cents  integer not null default 0 check (amount_due_cents  >= 0),
  amount_paid_cents integer not null default 0 check (amount_paid_cents >= 0),
  -- Stored, not computed on read, so it can be sorted and indexed: "who has
  -- paid and is still waiting" is the query that matters on a busy morning.
  balance_cents integer
    generated always as (amount_due_cents - amount_paid_cents) stored,

  updated_at   timestamptz not null default now()
);

comment on table public.access_request is
  'One row per non-anonymous account: whether the owner has let them into the '
  'beta, how they found the product, and what they owe. Written only by the '
  'auth.users trigger and the owner RPCs below.';
comment on column public.access_request.balance_cents is
  'Due minus paid. The balance is met at <= 0. Approval never reads this '
  'automatically -- it is shown beside the button, and a person presses it.';

create index access_request_status_idx on public.access_request (status, requested_at desc);
create index access_request_email_idx  on public.access_request (email);

create trigger access_request_set_updated_at before update on public.access_request
  for each row execute function public.set_updated_at();

-- ============================================================================
-- Every sign-up files a request, whether or not the client asks it to.
-- ============================================================================

/*
 * Anonymous users are skipped, and that is the one exception in the whole
 * migration. A pair-fire guest is a device that scanned a four-character code
 * to watch somebody else's string -- it has no email, nobody to approve, and
 * no way to be told the outcome. Filing pending rows for them would bury the
 * real queue under a row per relay join. What keeps that from being a hole is
 * that a guest is not being granted anything: 0004 and 0010 already refuse
 * anonymous sessions the leaderboard and backups, and may_relay() below is
 * what lets them do the one thing they came for.
 *
 * definer because the row must be written under a trigger fired by GoTrue's
 * own insert, and search_path is pinned for the reason 0015 gives: a definer
 * function that resolves its own tables through a caller-controlled path is
 * the textbook escalation.
 *
 * It deliberately does NOT swallow errors. A failure here fails the sign-up,
 * which is loud and recoverable; the alternative -- an account with no request
 * row -- is an account that has_access() refuses forever and that never
 * appears in the owner's queue to be fixed. Fail-closed and invisible is the
 * worse of the two.
 */
create or replace function public.handle_new_user_access_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.is_anonymous, false) then
    return new;
  end if;
  insert into public.access_request (user_id, email, heard_from, heard_detail)
  values (
    new.id,
    new.email,
    -- The sign-up form's answers, carried in the `data` field of the GoTrue
    -- signup call and landing in raw_user_meta_data. Read here rather than
    -- POSTed separately by the client because a second call is a call that can
    -- fail to happen: with email confirmation on, sign-up returns no session
    -- at all, so there is no authenticated moment in which to make it.
    nullif(left(trim(coalesce(new.raw_user_meta_data ->> 'heard_from',   '')),  60), ''),
    nullif(left(trim(coalesce(new.raw_user_meta_data ->> 'heard_detail', '')), 280), ''))
  on conflict (user_id) do nothing;
  return new;
end $$;

comment on function public.handle_new_user_access_request is
  'Files a pending access_request for every non-anonymous sign-up. The reason '
  'a client cannot create an account that skips the queue.';

create trigger on_auth_user_created_access_request
  after insert on auth.users
  for each row execute function public.handle_new_user_access_request();

-- ============================================================================
-- The gate itself.
-- ============================================================================

/*
 * definer for the same reason is_admin() is: access_request carries FORCE row
 * level security and grants users no select policy, so a policy that read it
 * as the calling user would find nothing and refuse everyone -- including the
 * approved.
 *
 * The owner is let through on is_admin() rather than on a row of their own.
 * An owner who has to approve themselves before they can approve anybody is
 * an owner locked out on the first day, and the recovery is hand-editing SQL.
 */
create or replace function public.has_access()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.is_admin()
      or exists (select 1 from public.access_request a
                  where a.user_id = auth.uid() and a.status = 'approved');
$$;

comment on function public.has_access is
  'True when the caller has been let into the beta, or is the owner. The '
  'predicate every restrictive policy below is built on.';

/*
 * Pair fire is the one capability that must survive the gate.
 *
 * A relay is two shooters and a coach on a four-character code, and the
 * guests sign in anonymously -- they have no account to approve. Gating the
 * relay tables on has_access() alone would mean an approved user could open a
 * relay that nobody could join, which is the same as not having the feature.
 * What it still refuses is the case that matters: a real account that has not
 * been let in yet cannot use the relay either.
 */
create or replace function public.may_relay()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select (select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false))
      or public.has_access();
$$;

comment on function public.may_relay is
  'has_access(), plus anonymous pair-fire guests, who have no account to '
  'approve and are granted nothing else anywhere in the schema.';

revoke all on function public.has_access() from public;
revoke all on function public.may_relay() from public;
grant execute on function public.has_access() to anon, authenticated;
grant execute on function public.may_relay() to anon, authenticated;

-- ============================================================================
-- Folding it into the tables.
--
-- RESTRICTIVE is the whole trick. Postgres OR-s permissive policies together
-- and AND-s restrictive ones on top, so this reads as "everything 0001 said,
-- AND the owner has let you in". Written permissively it would have been a
-- fifteenth way to be allowed rather than a first way to be refused -- and it
-- would have looked right in review, because the predicate is identical.
--
-- No TO clause, on purpose. 0001's policies have none either, so they apply to
-- `anon` as well; a restrictive policy scoped `to authenticated` would leave a
-- gap in exactly the role that has no session. anon cannot satisfy the 0001
-- predicates anyway, but a gate with a role-shaped hole in it is not a gate.
-- ============================================================================

do $$
declare t text;
begin
  foreach t in array array[
    'profiles','firearms','bullet_products','powder_products','primer_products',
    'component_lots','brass_lots','brass_events','recipes','batches',
    'range_sessions','shots','groups','dope_entries','account_backups'
  ] loop
    execute format(
      'create policy %I on public.%I as restrictive
         using (public.has_access()) with check (public.has_access())',
      t || '_needs_access', t);
  end loop;
end $$;

/*
 * The leaderboard is gated on WRITES only.
 *
 * lbp_select_all and lbe_select_all read `using (true)` because the board is
 * public -- it is the one screen in the suite a stranger is meant to see, and
 * the marketing site links to it. A restrictive policy `for all` would have
 * caught that select too and emptied the board for every signed-in visitor who
 * is not in the beta, which is both a regression and an odd way to advertise.
 *
 * So: three commands, not `for all`. Publishing a score is a capability;
 * reading the board is not.
 */
do $$
declare t text;
begin
  foreach t in array array['leaderboard_profiles','leaderboard_entries'] loop
    execute format(
      'create policy %I on public.%I as restrictive for insert
         with check (public.has_access())', t || '_needs_access_ins', t);
    execute format(
      'create policy %I on public.%I as restrictive for update
         using (public.has_access()) with check (public.has_access())',
      t || '_needs_access_upd', t);
    execute format(
      'create policy %I on public.%I as restrictive for delete
         using (public.has_access())', t || '_needs_access_del', t);
  end loop;
end $$;

-- Relay: everything, but may_relay() rather than has_access(), so guests pass.
do $$
declare t text;
begin
  foreach t in array array[
    'relays','relay_participants','relay_shots','relay_messages'
  ] loop
    execute format(
      'create policy %I on public.%I as restrictive
         using (public.may_relay()) with check (public.may_relay())',
      t || '_needs_access', t);
  end loop;
end $$;

/*
 * And a trigger, because on the relay the policies above are not enough.
 *
 * Nothing creates or joins a relay by INSERT. 0004 gives relays and
 * relay_participants no insert policy at all -- the only ways in are
 * create_relay() and join_relay(), which are SECURITY DEFINER because joining
 * by code has to read a row the joiner is not yet allowed to see. A definer
 * function runs as the owner, and the owner is not subject to row level
 * security: every restrictive policy in the block above is invisible to them.
 *
 * So an account the owner has never approved could still have opened a relay
 * and invited people into it, through a door that was never locked because
 * nobody noticed it was a door. The gate held on eleven tables and leaked on
 * the one feature with its own API.
 *
 * A trigger is the fix rather than a rewrite of the two functions: it applies
 * to every present and future path into these tables, definer or not, and it
 * does not require copying two hundred lines of relay logic into this file to
 * add one line at the top of each. auth.uid() and auth.jwt() read session
 * settings, which a definer context does not change, so may_relay() answers
 * about the CALLER here exactly as it does in a policy.
 */
create or replace function public.enforce_relay_access()
returns trigger
language plpgsql
as $$
begin
  if not public.may_relay() then
    raise exception 'this account has not been let into the beta yet'
      using errcode = '42501';
  end if;
  return new;
end $$;

comment on function public.enforce_relay_access is
  'Refuses relay creation and joining to an account that has not been '
  'approved. Exists because create_relay/join_relay are security definer and '
  'therefore never see the restrictive policies.';

create trigger relays_needs_access
  before insert on public.relays
  for each row execute function public.enforce_relay_access();

create trigger relay_participants_needs_access
  before insert on public.relay_participants
  for each row execute function public.enforce_relay_access();

/*
 * analytics_event is deliberately NOT gated.
 *
 * Its insert policy is what records that somebody signed up and came back --
 * which is precisely the population this migration creates: people who are
 * waiting. Gating it would blind the owner dashboard to the queue it is meant
 * to be working through, and the table holds event names and counts, not the
 * user's data. Same reasoning for site_visit, which is anonymous already.
 */

-- ============================================================================
-- Row level security on the request table itself.
-- ============================================================================

alter table public.access_request enable row level security;
alter table public.access_request force row level security;

/* Read is the owner's, and behind the second factor.
 *
 * This table is a list of every customer's address next to how they found the
 * product and what they owe. 0018 put the support log behind is_admin_mfa()
 * for less than that, and gating this more weakly would be the wrong way
 * round -- the same argument, one table along.
 *
 * Users get NO select policy. They are not being kept from their own status:
 * my_access_status() hands it to them, minus the owner's note and the billing
 * columns, which is a distinction RLS cannot draw on its own. */
create policy access_request_select_admin on public.access_request
  for select to authenticated
  using (public.is_admin_mfa());

-- No insert, update or delete policy for anyone at all. The trigger above and
-- the definer functions below are the only writers, and they are the only
-- writers that leave an audit trail behind them.

/*
 * And the privilege is revoked as well as the policy withheld, which is not
 * belt and braces for its own sake.
 *
 * 0001 ends with `alter default privileges in schema public grant select,
 * insert, update, delete on tables to authenticated`. That is not a statement
 * about the tables that existed in 0001 -- it is a standing instruction that
 * hands every table created in this schema from then on full DML to every
 * signed-in user, this one included, silently, at creation time.
 *
 * Row level security would still refuse all three, because there is no policy
 * for them. But that leaves the whole guarantee resting on the absence of
 * something, and the absence of a policy is exactly what a later migration
 * adds without meaning to. Two independent refusals, one of which is a
 * positive statement in this file.
 */
revoke insert, update, delete on public.access_request from authenticated;
grant select on public.access_request to authenticated;

-- ============================================================================
-- What the waiting user is allowed to know, and to say.
-- ============================================================================

/*
 * Their own status, as a small object rather than a row.
 *
 * `unknown` is returned rather than null when there is no row, and the apps
 * treat it exactly like `pending`. The case it covers is an account created
 * before this migration ran and missed by the backfill, or one whose trigger
 * ran during a deploy -- a user in that state should see "waiting on the
 * owner", not a crash and not a way in.
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
    jsonb_build_object('status', case when public.is_admin() then 'approved'
                                      else 'unknown' end));
$$;

comment on function public.my_access_status is
  'The caller''s own beta status, without the owner''s note or the billing '
  'columns. What the hold screen polls.';

/*
 * A second chance at the marketing question.
 *
 * The answer normally arrives in the sign-up metadata and the user never
 * touches this. It exists for the account that arrived without one -- an older
 * build, a sign-up whose metadata was dropped -- because the alternative is a
 * hold screen that asks a question it has no way to submit, and an owner
 * deciding on a blank row.
 *
 * Only while pending, and only those two columns. A definer function is how
 * you write a column-scoped update; an update POLICY cannot express it, and
 * one that tried would let a waiting user set their own status.
 */
create or replace function public.submit_access_details(
  p_heard_from text, p_heard_detail text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  update public.access_request a set
    heard_from   = nullif(left(trim(coalesce(p_heard_from,   '')),  60), ''),
    heard_detail = nullif(left(trim(coalesce(p_heard_detail, '')), 280), '')
  where a.user_id = auth.uid() and a.status = 'pending';
  return public.my_access_status();
end $$;

revoke all on function public.my_access_status() from public;
revoke all on function public.submit_access_details(text, text) from public;
grant execute on function public.my_access_status() to authenticated;
grant execute on function public.submit_access_details(text, text) to authenticated;

-- ============================================================================
-- What the owner does, and the record it leaves.
-- ============================================================================

/* 0018 enumerated the support verbs and 0020 added the fourth; these are the
 * fifth and sixth. The CHECK is the reason to touch it: a verb the constraint
 * does not know is a row the insert refuses, and decide_access() runs the log
 * write in the same transaction as the decision -- so an unlisted verb would
 * roll the approval back rather than merely go unrecorded. Loud, but only in
 * production, and only on the first approval. */
alter table public.owner_action_log
  drop constraint owner_action_log_action_check;

alter table public.owner_action_log
  add constraint owner_action_log_action_check check (action in
    ('list', 'lookup', 'send_reset', 'resend_confirmation',
     'access_decide', 'access_billing'));

/*
 * Approve, deny, revoke -- and the audit entry, in one transaction.
 *
 * The audit write is not a courtesy alongside the update; it is in the same
 * statement block precisely so that the two cannot come apart. An owner power
 * that reaches across every RLS boundary in the schema and leaves no trace is
 * one nobody -- including the owner, later, under question -- can account for.
 *
 * `revoked` is separate from `denied` on purpose, and the difference is
 * historical rather than functional: both refuse, but one of them means the
 * person was in and was removed, and a support screen that cannot tell those
 * apart cannot answer "it stopped working this morning".
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

  update public.access_request a set
    status     = p_status,
    -- An empty note leaves the previous one standing. Clearing a note is not
    -- something the dashboard offers, and treating "I did not type anything"
    -- as "erase what is there" would quietly lose the reason for a decision
    -- every time somebody changed their mind about one.
    note       = coalesce(nullif(trim(coalesce(p_note, '')), ''), a.note),
    decided_at = now(),
    decided_by = auth.uid()
  where a.user_id = p_user_id
  returning a.* into r;

  if r.user_id is null then
    raise exception 'no access request for %', p_user_id using errcode = 'P0002';
  end if;

  insert into public.owner_action_log
    (actor_id, action, subject_id, subject_email, ok, detail)
  values (auth.uid(), 'access_decide', r.user_id, r.email, true,
          jsonb_build_object('status', r.status, 'note', r.note,
                             'balance_cents', r.balance_cents));

  return to_jsonb(r);
end $$;

/*
 * The money, kept separate from the decision.
 *
 * Recording that somebody paid and letting them in are two different acts by
 * two different people at two different times -- the payment processor says
 * one, the owner decides the other. Folding them into one call would mean
 * either that marking a payment silently granted access, or that granting
 * access silently claimed a payment. Both are wrong in the direction that is
 * expensive to discover.
 */
create or replace function public.set_access_billing(
  p_user_id uuid, p_plan text default null,
  p_amount_due_cents integer default null,
  p_amount_paid_cents integer default null)
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
  if coalesce(p_amount_due_cents, 0) < 0 or coalesce(p_amount_paid_cents, 0) < 0 then
    raise exception 'amounts are in cents and cannot be negative'
      using errcode = '22023';
  end if;

  -- Nulls mean "leave it", not "zero it", so the dashboard can send one field.
  update public.access_request a set
    plan              = coalesce(nullif(trim(coalesce(p_plan, '')), ''), a.plan),
    amount_due_cents  = coalesce(p_amount_due_cents,  a.amount_due_cents),
    amount_paid_cents = coalesce(p_amount_paid_cents, a.amount_paid_cents)
  where a.user_id = p_user_id
  returning a.* into r;

  if r.user_id is null then
    raise exception 'no access request for %', p_user_id using errcode = 'P0002';
  end if;

  insert into public.owner_action_log
    (actor_id, action, subject_id, subject_email, ok, detail)
  values (auth.uid(), 'access_billing', r.user_id, r.email, true,
          jsonb_build_object('plan', r.plan, 'due', r.amount_due_cents,
                             'paid', r.amount_paid_cents,
                             'balance_cents', r.balance_cents));

  return to_jsonb(r);
end $$;

revoke all on function public.decide_access(uuid, text, text) from public;
revoke all on function public.set_access_billing(uuid, text, integer, integer) from public;
grant execute on function public.decide_access(uuid, text, text) to authenticated;
grant execute on function public.set_access_billing(uuid, text, integer, integer) to authenticated;

-- ============================================================================
-- Backfill: everybody who was already here stays in.
--
-- The alternative -- start every existing account at `pending` -- reads as the
-- stricter, safer default and is not. These are people who have a logbook in
-- the app already; locking them out retroactively is not a beta gate, it is an
-- outage, and the first thing the owner would do is approve all of them by
-- hand from a queue that arrived full. The gate is for who comes NEXT.
--
-- Marked with a note rather than left blank so the dashboard can tell a
-- grandfathered account from one the owner actually looked at.
-- ============================================================================
insert into public.access_request
  (user_id, email, status, requested_at, decided_at, note)
select u.id, u.email, 'approved', coalesce(u.created_at, now()), now(),
       'Grandfathered: account existed when the beta gate was introduced.'
  from auth.users u
 where coalesce(u.is_anonymous, false) = false
on conflict (user_id) do nothing;
