-- Local-only stand-in for the parts of Supabase that don't exist in vanilla
-- Postgres. NOT part of the migration -- Supabase provides all of this.
-- Its only job is to let the real migration run and be tested here.

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique
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
