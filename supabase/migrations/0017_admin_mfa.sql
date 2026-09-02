-- ============================================================================
-- A second factor for the analytics, enforced by the database.
--
-- 0016 gave an admin read access to every user's usage history. That is the
-- most sensitive read in this project, and until now one password stood in
-- front of it. This adds "and a TOTP code verified in this session".
--
-- The point of doing it HERE rather than in the dashboard is that the
-- dashboard is a static page served with the public key. A check it performs
-- is a check it can be asked to skip -- open devtools, call the REST endpoint
-- directly, and a client-side MFA gate is not there. The policy below is
-- somewhere the browser cannot reach.
--
-- `aal` is GoTrue's Authenticator Assurance Level, a claim on the access
-- token: aal1 after a password sign-in, aal2 once a second factor has been
-- verified in that session. Verifying a factor mints a NEW token; there is no
-- way to acquire the claim without going through the check.
-- ============================================================================

/*
 * Deliberately a SEPARATE function from is_admin() rather than a stricter
 * version of it.
 *
 * The dashboard has to tell three states apart to say anything useful:
 * not an admin, an admin who has not enrolled or verified a factor, and an
 * admin who has. Folding the aal test into is_admin() would collapse the
 * first two into one answer, and the honest screen for "you need your
 * authenticator" would become the same wrong screen as "you are not an
 * admin".
 *
 * Enrolment therefore stays reachable at aal1, which is not an oversight: an
 * admin who has never enrolled has no way to reach aal2, so requiring aal2 in
 * order to enrol would lock the only admin out of their own dashboard with no
 * path back that does not involve hand-editing the database.
 */
create or replace function public.is_admin_mfa()
returns boolean
language sql
stable
as $$
  select public.is_admin()
     and coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;

comment on function public.is_admin_mfa is
  'Admin AND a second factor verified in this session. What the analytics read '
  'is gated on. is_admin() alone stays available so the dashboard can tell '
  '"not an admin" from "go and get your authenticator".';

revoke all on function public.is_admin_mfa() from public;
grant execute on function public.is_admin_mfa() to authenticated;

/*
 * Replace, not add.
 *
 * Policies of the same command are OR-ed together: leaving 0016's
 * analytics_event_select_admin in place beside a new aal2 policy would mean a
 * password-only admin still satisfied the old one, and the second factor would
 * be decoration. It has to be the same policy, tightened.
 */
drop policy if exists analytics_event_select_admin on public.analytics_event;

create policy analytics_event_select_admin on public.analytics_event
  for select to authenticated
  using (public.is_admin_mfa());

/*
 * Scoped to SELECT, and that scoping is load-bearing.
 *
 * Every shooter's app inserts telemetry on an ordinary aal1 session. A blanket
 * aal2 requirement on this table -- the shape the Supabase docs show, `as
 * restrictive ... using (auth.jwt()->>'aal' = 'aal2')` with no command given --
 * applies to INSERT as well, and would silently refuse every event either app
 * ever tried to record. The dashboard would then be perfectly secured around a
 * table that stays empty.
 */
