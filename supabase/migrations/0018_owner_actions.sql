-- ============================================================================
-- A record of what the owner did to somebody else's account.
--
-- The support tools reach across the RLS boundary every other table in this
-- schema is built on: looking a customer up by email, sending them a reset
-- link. That is a capability worth having and worth writing down, because the
-- one thing an unlogged admin power guarantees is that nobody -- including the
-- admin -- can later say what was done with it.
--
-- Written by the edge function under the service role, which bypasses RLS, so
-- the policies here govern READING it. There is no insert policy at all: the
-- only writer is the function, and a client that could file its own entries
-- could file false ones.
-- ============================================================================
create table public.owner_action_log (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid references auth.users(id) on delete set null,
  action       text not null check (action in
                 ('lookup', 'send_reset', 'resend_confirmation')),
  -- Who it was done to. Nullable because a lookup that finds nobody is still
  -- a lookup that happened, and is the interesting half of a support audit.
  subject_id   uuid references auth.users(id) on delete set null,
  -- The address as TYPED, which is the thing that was searched for. A typo is
  -- what you are looking for when a customer says "nothing arrived".
  subject_email text,
  ok           boolean not null default true,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index owner_action_log_created_idx on public.owner_action_log (created_at desc);
create index owner_action_log_subject_idx on public.owner_action_log (subject_email, created_at desc);

comment on table public.owner_action_log is
  'Append-only record of owner support actions. Written by the owner-tools edge '
  'function under the service role; readable only by an admin with a verified '
  'second factor.';

alter table public.owner_action_log enable row level security;
alter table public.owner_action_log force row level security;

/* Read requires the second factor, the same as the analytics.
 *
 * This table is arguably more sensitive than analytics_event: it is a list of
 * customer email addresses alongside the times somebody went looking for them.
 * Gating it any more weakly than the numbers would be the wrong way round. */
create policy owner_action_log_select_admin on public.owner_action_log
  for select to authenticated
  using (public.is_admin_mfa());

-- No insert, update or delete policy for anyone. The service role ignores RLS
-- and is the only writer; nothing else may add, alter or erase an entry --
-- including the admin whose actions it records.

grant select on public.owner_action_log to authenticated;
