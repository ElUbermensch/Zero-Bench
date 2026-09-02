-- ============================================================================
-- Admin role.
--
-- The suite has had exactly one privilege level since 0001: you see your own
-- rows and nobody else's. This adds a second one, for exactly one purpose --
-- reading the product-usage analytics in 0016. It deliberately does NOT grant
-- an admin any access to another user's shooting or reloading records. Those
-- policies are untouched, and widening them would be a separate migration with
-- its own adversarial test pass.
-- ============================================================================

alter table public.profiles
  add column is_admin boolean not null default false;

comment on column public.profiles.is_admin is
  'Grants read access to the analytics rollups in 0016. Nothing else. '
  'Set by hand in SQL -- there is no in-app path to it, by design.';

/*
 * security definer is load-bearing and is the reason this is a function rather
 * than an inline subquery in every policy.
 *
 * profiles carries FORCE row level security, so a policy on analytics_event
 * that read profiles directly would be evaluated as the calling user against
 * profiles' own policies. That works for reading your OWN is_admin flag, but it
 * makes every future policy that wants an admin check depend on the exact shape
 * of profiles' RLS -- and a definer function is the standard, auditable way to
 * express "this one predicate is allowed to look".
 *
 * search_path is pinned because a definer function that resolves `profiles`
 * through a caller-controlled search_path is the classic privilege-escalation
 * bug: the caller creates their own profiles table in a schema earlier on the
 * path and the function happily reads it.
 *
 * It is stable rather than volatile so the planner may call it once per
 * statement instead of once per row.
 */
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (select p.is_admin from public.profiles p where p.id = auth.uid()),
    false);
$$;

comment on function public.is_admin is
  'True when the calling user carries profiles.is_admin. Definer-rights so an '
  'analytics policy need not be granted a general read over profiles.';

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;
