-- Local-only stand-in for the parts of Supabase that don't exist in vanilla
-- Postgres. NOT part of the migration -- Supabase provides all of this.
-- Its only job is to let the real migration run and be tested here.

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique
);

-- Supabase reads the subject claim out of the request JWT. Locally we set the
-- same GUC by hand so RLS policies can be exercised as different users.
create or replace function auth.uid()
returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
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
