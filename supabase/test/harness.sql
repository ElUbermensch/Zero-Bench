-- ============================================================================
-- LOCAL TEST FIXTURE. NOT A MIGRATION.
--
-- The deploy procedure is "open the file on GitHub, click Raw, copy, paste into
-- the Supabase SQL Editor" -- and this directory sits next to the one that
-- procedure is about. The SQL Editor runs as `postgres`, which bypasses RLS
-- entirely, so a mis-paste here is not a failed query: `delete from
-- public.account_backups;` removes every customer's device backup, and
-- harness.sql replaces auth.uid() with a stub that breaks every policy at once.
--
-- So the files say so themselves, rather than relying on a warning in a
-- markdown file nobody has open at the time. run_tests.sh and CI both build a
-- database called `shooting`; anything else is assumed to be real.
-- ============================================================================
do $$
begin
  if current_database() <> 'shooting' then
    raise exception
      'REFUSED: % is a LOCAL TEST fixture and must never run against a real project (database is %, expected "shooting")',
      current_setting('application_name', true), current_database();
  end if;
end $$;

-- Local-only stand-in for the parts of Supabase that don't exist in vanilla
-- Postgres. NOT part of the migration -- Supabase provides all of this.
-- Its only job is to let the real migration run and be tested here.

create schema if not exists auth;

/* The columns are the ones the MIGRATIONS read, and no more.
 *
 * The real auth.users is forty-odd columns of GoTrue bookkeeping and none of
 * it belongs here -- a fixture that mirrors a table it does not own drifts
 * from it silently. These three arrived with 0021, whose trigger reads
 * raw_user_meta_data for the sign-up answers, skips is_anonymous rows, and
 * backfills from created_at. Without them the migration parses and then fails
 * at the first insert, which is a suite that cannot run rather than one that
 * fails an assertion.
 *
 * Defaults match GoTrue's: metadata is an empty object rather than null, and
 * an account is not anonymous unless it says so. A fixture whose defaults
 * differ from production is a fixture that green-lights the wrong branch. */
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  is_anonymous       boolean not null default false,
  created_at         timestamptz not null default now()
);

-- Supabase derives auth.uid() and auth.jwt() from the request JWT. Locally we
-- set the same GUC by hand so RLS policies can be exercised as different users
-- -- including as an ANONYMOUS user, which is what the relay depends on.
create or replace function auth.jwt()
returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create or replace function auth.uid()
returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    auth.jwt() ->> 'sub'
  )::uuid
$$;

-- PostgREST's two roles.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

-- Real Supabase grants these; the harness must too. auth.uid() now delegates to
-- auth.jwt(), and calling a function in the auth schema requires USAGE on it.
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated;
grant select on auth.users to anon, authenticated;
