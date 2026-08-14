-- ============================================================================
-- Pair fire proper: TWO shooters and a coach, all three watching each other.
--
-- The claim under test is that mutual visibility and per-row write control are
-- independent. Everyone sees everything; each shooter owns exactly one string.
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off

insert into auth.users (id, email) values
  ('55555555-5555-5555-5555-555555555555', 'shooter_b@example.com'),
  ('66666666-6666-6666-6666-666666666666', 'coach2@example.com'),
  ('77777777-7777-7777-7777-777777777777', 'shooter_c@example.com')
on conflict do nothing;

set role authenticated;

-- =============================================================== A goes live
select test.as_user('11111111-1111-1111-1111-111111111111');
do $$
declare r public.relays; s smallint;
begin
  select * into r from public.create_relay('Jaxon', 'Pairs match', 'NRA B-8', null, 200);
  create temporary table _pair as select r.id as id, r.code as code;

  select slot into s from public.relay_participants
   where relay_id = r.id and user_id = auth.uid();
  perform test.check(s = 1, 'the shooter who starts the relay takes firing point 1');

  insert into public.relay_shots (relay_id, shot_no, ring, x_in, y_in, call_x_in, call_y_in)
  values (r.id, 1, '10', 0.10, 0.05, 0.00, 0.00),
         (r.id, 2, 'X',  0.02, 0.03, 0.05, 0.05);
end $$;

-- ============================================================ B joins to SHOOT
select test.as_user('55555555-5555-5555-5555-555555555555');
do $$
declare code text; rid uuid; res jsonb; n integer;
begin
  select _pair.code, _pair.id into code, rid from _pair;

  res := public.join_relay(code, 'Partner Pete', 'shooter');
  perform test.check((res ->> 'ok') = 'true', 'a partner can join as a shooter');
  perform test.check((res ->> 'slot')::int = 2, '...and is given firing point 2');
  perform test.check((res ->> 'role') = 'shooter', '...with the shooter role');

  -- mutual visibility, immediately
  select count(*) into n from public.relay_shots where relay_id = rid;
  perform test.check(n = 2, 'the partner sees the first shooter''s string');

  -- and can write their OWN, using the same shot numbers
  insert into public.relay_shots (relay_id, shot_no, ring, x_in, y_in)
  values (rid, 1, '9', -0.40, 0.20), (rid, 2, '10', -0.10, 0.15);
  perform test.check(true,
    'both shooters number their shots 1 and 2 without colliding');

  select count(*) into n from public.relay_shots where relay_id = rid;
  perform test.check(n = 4, 'four shots on the relay, two strings of two');
end $$;

-- ============================================ a shooter owns ONE string only
do $$
declare rid uuid; a_uid uuid := '11111111-1111-1111-1111-111111111111';
begin
  select id into rid from _pair;

  -- forge a row attributed to the partner
  begin
    insert into public.relay_shots (relay_id, user_id, shot_no, ring, x_in, y_in)
    values (rid, a_uid, 3, 'X', 0, 0);
    perform test.check(false, 'a shooter must not be able to write their partner''s string');
  exception when insufficient_privilege then
    perform test.check(true, 'a shooter cannot write their partner''s string');
  end;

  -- or rewrite one of the partner's existing rows. Guard first: `not found`
  -- below only means something if the rows are genuinely visible and the
  -- WHERE clause genuinely matches them.
  perform test.check(
    (select count(*) from public.relay_shots
      where relay_id = rid and user_id = a_uid) = 2,
    'the two rows about to be attacked are visible to the attacker');

  update public.relay_shots set ring = '5'
   where relay_id = rid and user_id = a_uid;
  perform test.check(not found, 'a shooter cannot rewrite their partner''s shots');

  delete from public.relay_shots where relay_id = rid and user_id = a_uid;
  perform test.check(not found, 'a shooter cannot delete their partner''s shots');
end $$;

-- ================================================== the coach sees, writes none
select test.as_user('66666666-6666-6666-6666-666666666666');
do $$
declare code text; rid uuid; res jsonb; st jsonb; n integer; slots int[];
begin
  select _pair.code, _pair.id into code, rid from _pair;

  res := public.join_relay(code, 'Coach Ruth', 'coach');
  perform test.check((res ->> 'ok') = 'true', 'the coach joins with the same code');
  perform test.check(res ->> 'slot' is null, '...and takes no firing point');

  st := public.relay_state(rid);
  perform test.check(jsonb_array_length(st->'shots') = 4,
    'the coach sees both strings in one round trip');
  perform test.check(jsonb_array_length(st->'participants') = 3,
    'the coach sees all three people');

  -- every shot is attributed, or the coach cannot tell the strings apart
  select array_agg(distinct (x->>'slot')::int order by (x->>'slot')::int)
    into slots from jsonb_array_elements(st->'shots') x;
  perform test.check(slots = array[1,2],
    'every relayed shot carries the firing point that fired it');

  perform test.check(
    (select count(*) from jsonb_array_elements(st->'shots') x
      where x->>'shooter' is not null) = 4,
    '...and the name of the shooter, so the coach reads names not numbers');

  -- calls travel too: call vs impact is what a coach actually reads
  perform test.check(
    (select count(*) from jsonb_array_elements(st->'shots') x
      where x->>'call_x_in' is not null) = 2,
    'the shooter''s called position travels with the shot');

  -- auth ids do NOT travel
  perform test.check(
    (select count(*) from jsonb_array_elements(st->'shots') x
      where x ? 'user_id') = 0,
    'no auth user id is exposed to co-participants');

  -- is_self lets a device find its own string without one
  perform test.check(
    (select count(*) from jsonb_array_elements(st->'shots') x
      where (x->>'is_self')::boolean) = 0,
    'none of the shots are the coach''s own');

  -- the coach writes nothing at all
  begin
    insert into public.relay_shots (relay_id, shot_no, ring, x_in, y_in)
    values (rid, 9, 'X', 0, 0);
    perform test.check(false, 'a coach must not be able to log shots');
  exception when insufficient_privilege then
    perform test.check(true, 'a coach cannot log shots for anybody');
  end;

  -- but the feed is theirs: calling wind is the job
  insert into public.relay_messages (relay_id, author_name, kind, body)
  values (rid, 'Coach Ruth', 'wind', 'picking up from 3, both of you hold 0.75L');
  perform test.check(true, 'the coach can call wind to both shooters at once');
end $$;

-- ======================================================= a shooter sees theirs
select test.as_user('55555555-5555-5555-5555-555555555555');
do $$
declare rid uuid; st jsonb; mine integer; theirs integer;
begin
  select id into rid from _pair;
  st := public.relay_state(rid);

  select count(*) filter (where (x->>'is_self')::boolean),
         count(*) filter (where not (x->>'is_self')::boolean)
    into mine, theirs
    from jsonb_array_elements(st->'shots') x;
  perform test.check(mine = 2, 'a shooter can pick out their own two shots');
  perform test.check(theirs = 2, '...and their partner''s two, to draw in another colour');

  perform test.check(
    (select count(*) from jsonb_array_elements(st->'messages') x
      where x->>'kind' = 'wind') = 1,
    'the coach''s wind call reaches the shooter');
end $$;

-- ================================================== slots are stable and reused
select test.as_user('55555555-5555-5555-5555-555555555555');
do $$
declare code text; res jsonb;
begin
  select _pair.code into code from _pair;
  -- a dropped signal means rejoining; that must not reshuffle colours mid-string
  res := public.join_relay(code, 'Partner Pete', 'shooter');
  perform test.check((res ->> 'slot')::int = 2,
    'rejoining after a dropped signal keeps the same firing point');
end $$;

-- a third shooter takes 3; if 2 leaves, the next taker gets 2 back, not 4
select test.as_user('77777777-7777-7777-7777-777777777777');
do $$
declare code text; rid uuid; res jsonb;
begin
  select _pair.code, _pair.id into code, rid from _pair;
  res := public.join_relay(code, 'Third', 'shooter');
  perform test.check((res ->> 'slot')::int = 3, 'a third shooter takes firing point 3');
end $$;

select test.as_user('55555555-5555-5555-5555-555555555555');
do $$
declare rid uuid;
begin
  select id into rid from _pair;
  delete from public.relay_participants where relay_id = rid and user_id = auth.uid();
  perform test.check(found, 'a shooter can leave the relay');
end $$;

select test.as_user('66666666-6666-6666-6666-666666666666');
do $$
declare code text; res jsonb;
begin
  select _pair.code into code from _pair;
  res := public.join_relay(code, 'Coach Ruth', 'shooter');   -- coach picks up a rifle
  perform test.check((res ->> 'slot')::int = 2,
    'the vacated firing point is reused rather than numbering climbing forever');
end $$;

-- ======================================================== ending it, per role
select test.as_user('55555555-5555-5555-5555-555555555555');
do $$
declare rid uuid;
begin
  select id into rid from _pair;
  begin
    perform public.end_relay(rid);
    perform test.check(false, 'a partner must not be able to end the relay');
  exception when others then
    perform test.check(true, 'only the shooter who started it can end the relay');
  end;
end $$;

select test.as_user('11111111-1111-1111-1111-111111111111');
do $$
declare rid uuid; n integer;
begin
  select id into rid from _pair;
  perform public.end_relay(rid);

  -- and once ended, nobody appends -- not even the owner of the string
  begin
    insert into public.relay_shots (relay_id, shot_no, ring, x_in, y_in)
    values (rid, 9, '10', 0, 0);
    perform test.check(false, 'an ended relay must not accept more shots');
  exception when insufficient_privilege then
    perform test.check(true, 'an ended relay accepts no further shots from anyone');
  end;

  select count(*) into n from public.relay_shots where relay_id = rid;
  perform test.check(n = 4, 'the strings already fired survive the relay ending');
end $$;

reset role;
\echo ''
\echo 'PAIR ASSERTIONS PASSED'
