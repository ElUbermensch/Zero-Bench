-- ============================================================================
-- 0003: keepalive probe.
--
-- Supabase pauses a free project after ~7 days of low activity. A few real
-- database queries a day prevents it. This is the cheapest legitimate query
-- that exists: it touches no table, returns one timestamp, and is safe to
-- expose to the anon role precisely because it reveals nothing.
--
-- NOTE this solves project PAUSING only -- a 7-day timescale. It does nothing
-- for a connection dropping mid-session; see docs/PAIR-FIRE.md for why those
-- are different problems with opposite fixes.
-- ============================================================================

create or replace function public.keepalive()
returns timestamptz
language sql
stable
as $$ select now() $$;

comment on function public.keepalive is
  'Cheapest possible real query, for the scheduled anti-pause ping. Reveals nothing.';

-- Deliberately granted to anon: the scheduled job is unauthenticated, and this
-- function exposes nothing an attacker could want.
grant execute on function public.keepalive() to anon, authenticated;
