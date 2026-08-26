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

-- ============================================================================
-- The relay face, and the comparison that decides whether to draw it (0009).
--
-- Three claims:
--   1. the paper is fetchable ONCE, by a participant and nobody else
--   2. each shooter's own target travels with them, like their own distance
--   3. the feed stops handing every participant the author's auth id
--
-- (3) is not new behaviour, it is a leak being closed: every other payload in
-- relay_state is built column by column precisely so co-participants never
-- learn each other's ids. The messages used `to_jsonb(m)` and carried user_id
-- to everyone in the relay.
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off

insert into auth.users (id, email) values
  ('77777777-7777-7777-7777-777777777777', 'overlay-coach@example.com'),
  ('88888888-8888-8888-8888-888888888888', 'overlay-partner@example.com'),
  ('99999999-9999-9999-9999-999999999999', 'overlay-stranger@example.com')
on conflict do nothing;

set role authenticated;

-- =========================================================== the host goes live
select test.as_user('11111111-1111-1111-1111-111111111111');
do $$
declare r public.relays; t text;
begin
  select * into r from public.create_relay(
    'Jaxon', 'Overlay test', 'SR',
    '{"rings":[{"score":"X","diam":3.0},{"score":"10","diam":7.0},{"score":"9","diam":13.0}]}'::jsonb,
    200);

  select target_name into t from public.relay_participants
   where relay_id = r.id and user_id = auth.uid();
  perform test.check(t = 'SR',
    'the starter''s own target is recorded on their participant row, not only on the relay');

  create temporary table _ov as select r.id as id, r.code as code;
end $$;

-- ================================================ a partner joins on the same paper
select test.as_user('88888888-8888-8888-8888-888888888888');
do $$
declare c text; res jsonb; t text; d numeric;
begin
  select code into c from _ov;
  res := public.join_relay(c, 'Pete', 'shooter', 200, 'SR');
  perform test.check((res->>'ok')::boolean, 'the partner joins');

  select target_name, distance_yd into t, d from public.relay_participants
   where relay_id = (select id from _ov) and user_id = auth.uid();
  perform test.check(t = 'SR' and d = 200, 'their own target and distance are stored');

  -- A rejoin after a dropped signal often omits both. Neither may be erased:
  -- the overlay would flip to "different targets" mid-string.
  res := public.join_relay(c, 'Pete', 'shooter', null, null);
  select target_name, distance_yd into t, d from public.relay_participants
   where relay_id = (select id from _ov) and user_id = auth.uid();
  perform test.check(t = 'SR' and d = 200,
    'a rejoin that omits them keeps what was already known');
end $$;

-- ======================================================= the face, and who gets it
select test.as_user('77777777-7777-7777-7777-777777777777');
do $$
declare c text; res jsonb; face jsonb; rid uuid;
begin
  select id, code into rid, c from _ov;

  -- Not a participant yet.
  begin
    face := public.relay_face(rid);
    perform test.check(false, 'a non-participant must not be able to read the face');
  exception when insufficient_privilege then
    perform test.check(true, 'the face is refused to anyone not in the relay');
  end;

  res := public.join_relay(c, 'Coach', 'coach', null, null);
  perform test.check((res->>'ok')::boolean, 'the coach joins');

  face := public.relay_face(rid);
  perform test.check(jsonb_array_length(face->'target_rings'->'rings') = 3,
    'a participant gets the ring geometry — the whole point of the overlay');
  perform test.check(face->>'target_name' = 'SR', '...and the name of the paper');
  perform test.check((face->>'distance_yd')::numeric = 200, '...and the relay distance');
end $$;

-- ============================================ a stranger with the relay id gets nothing
select test.as_user('99999999-9999-9999-9999-999999999999');
do $$
declare rid uuid; face jsonb;
begin
  select id into rid from _ov;
  begin
    face := public.relay_face(rid);
    perform test.check(false, 'possession of a relay id must not be possession of the relay');
  exception when insufficient_privilege then
    perform test.check(true, 'a stranger holding the id is still refused the face');
  end;
end $$;

-- ================================================== what relay_state now carries
select test.as_user('77777777-7777-7777-7777-777777777777');
do $$
declare rid uuid; st jsonb; parts jsonb; msgs jsonb;
begin
  select id into rid from _ov;

  -- The coach writes a wind call, so there is a message to inspect.
  insert into public.relay_messages (relay_id, author_name, kind, body)
  values (rid, 'Coach', 'wind', 'half a minute left');

  st := public.relay_state(rid);
  parts := st->'participants';
  msgs := st->'messages';

  perform test.check(
    (select count(*) from jsonb_array_elements(parts) p
      where p->>'target_name' = 'SR') = 3,
    'every participant reports a target — the coach inherits the relay''s');

  perform test.check(jsonb_array_length(msgs) = 1, 'the feed carries the message');
  perform test.check(not (msgs->0 ? 'user_id'),
    'and NOT the author''s auth id — the one payload here that used to leak it');
  perform test.check(msgs->0->>'author_name' = 'Coach',
    'the author name is the one recorded with the line');
  perform test.check((msgs->0->>'is_self')::boolean,
    'is_self is what a device uses to pick out its own lines, instead of an id');

  -- The geometry stays OUT of the poll: it is static, and re-sending it every
  -- 2.5 seconds to every participant for a whole match is pure waste.
  perform test.check(not (st->'relay' ? 'target_rings'),
    'the poll still does not carry the rings — that is what relay_face is for');
end $$;

-- ===================================== a shooter on different paper is visible as such
select test.as_user('88888888-8888-8888-8888-888888888888');
do $$
declare c text; res jsonb;
begin
  select code into c from _ov;
  -- Same line, different face. The client refuses the overlay on exactly this.
  res := public.join_relay(c, 'Pete', 'shooter', 200, 'MR-1');
  perform test.check((res->>'ok')::boolean, 'the rejoin succeeds');
end $$;

select test.as_user('77777777-7777-7777-7777-777777777777');
do $$
declare rid uuid; st jsonb; n integer;
begin
  select id into rid from _ov;
  st := public.relay_state(rid);
  select count(distinct p->>'target_name') into n
    from jsonb_array_elements(st->'participants') p
   where p->>'role' = 'shooter';
  perform test.check(n = 2,
    'the shooters now report two different targets, which is what the coach''s '
    || 'plot reads to decide it cannot draw one face');
end $$;

reset role;
\echo ''
\echo 'RELAY FACE ASSERTIONS PASSED'
