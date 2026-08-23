-- ============================================================================
-- The coach gets the target face — when, and only when, it means the same
-- thing for everybody on the relay.
--
-- `RelayPlot` in Zero has always been able to draw the real paper: it takes
-- `target.rings` and falls back to a bare grid when there are none. It never
-- got any, because `relay_state` returns `to_jsonb(r) - 'target_rings'` on
-- every poll and `join_relay` strips it too. So a coach who is used to calling
-- corrections off the rings and the grid was handed two coloured dots on an
-- empty square.
--
-- Stripping it from the POLL is right and stays: the rings are a static blob
-- of geometry, and re-sending them every 2.5 seconds to every participant for
-- the length of a match is pure waste. What was missing is a way to fetch them
-- once. `relay_face()` is that, gated on participation like everything else.
--
-- The overlay is only honest when both shooters are on the same target at the
-- same distance, which in competition they nearly always are — but "nearly"
-- is not "always", and inches drawn onto a face they were not fired at is a
-- coach reading a correction off the wrong picture. The relay knew each
-- shooter's DISTANCE already (0004, for the minute conversion) but not their
-- target, so there was nothing to compare. `relay_participants.target_name`
-- is that missing half.
--
-- Also fixed here, since it is the same function: `relay_state` returned
-- messages as `to_jsonb(m)`, which carries `user_id`. Every other payload in
-- this file is deliberately built column by column so that co-participants
-- never learn each other's auth ids — the messages were the one place that
-- leaked, by using the shortcut.
-- ============================================================================

alter table public.relay_participants
  add column if not exists target_name text;

comment on column public.relay_participants.target_name is
  'The target face this shooter is actually on. Compared against the others to decide whether one overlay is honest; never used to draw by itself.';

-- --------------------------------------------------------------- create_relay
create or replace function public.create_relay(
  p_host_name text default 'Shooter',
  p_title text default null,
  p_target_name text default null,
  p_target_rings jsonb default null,
  p_distance_yd numeric default null
) returns public.relays
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.relays;
  c text;
  tries integer := 0;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;

  update public.relays set status = 'ended', ended_at = now()
   where host_id = auth.uid() and status = 'live';

  loop
    tries := tries + 1;
    c := public.gen_relay_code();
    begin
      insert into public.relays (code, host_id, host_name, title, target_name,
                                 target_rings, distance_yd)
      values (c, auth.uid(), coalesce(nullif(btrim(p_host_name), ''), 'Shooter'),
              p_title, p_target_name, p_target_rings, p_distance_yd)
      returning * into r;
      exit;
    exception when unique_violation then
      if tries >= 12 then raise exception 'could not allocate a relay code'; end if;
    end;
  end loop;

  -- The host's own target travels onto their participant row, so the same
  -- comparison works for them as for anyone who joins later.
  insert into public.relay_participants (relay_id, user_id, name, role, slot,
                                         distance_yd, target_name)
  values (r.id, auth.uid(), r.host_name, 'shooter', 1, p_distance_yd, p_target_name);

  return r;
end $$;

-- ----------------------------------------------------------------- join_relay
/* The old four-argument version is DROPPED first, and that is not tidiness.
 *
 * `create or replace function` matches on the SIGNATURE. Adding a parameter
 * creates an overload rather than replacing anything, so both versions exist
 * and every existing call — `join_relay(code, name, role, distance)` — becomes
 * "function public.join_relay(text, unknown, unknown, numeric) is not unique"
 * and fails outright. Pair fire would have stopped joining the moment this
 * migration was applied, for everyone, including clients that had not been
 * updated. The SQL suite caught it; nothing else would have until a match.
 *
 * Dropping loses the grant with it, so it is re-granted below.
 */
drop function if exists public.join_relay(text, text, text, numeric);

-- Reproduced from 0004 with two additions and nothing else: the new
-- p_target_name parameter, appended so existing callers still resolve, and the
-- column it writes. Every error code, message and throttle behaviour below is
-- byte-for-byte the original -- the SQL suite asserts on those strings, and a
-- "tidy-up" while passing through is how a rewrite breaks a caller silently.

create or replace function public.join_relay(
  p_code text,
  p_name text default 'Guest',
  p_role text default 'coach',
  p_distance_yd numeric default null,
  -- New in 0009, and last in the list so every existing caller still resolves
  -- to this function unchanged.
  p_target_name text default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  r public.relays;
  recent_fails integer;
  v_role text;
  v_slot smallint;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'error', 'not_signed_in');
  end if;

  -- Throttle BEFORE the lookup, so a blocked guesser learns nothing about
  -- whether the code they tried was close.
  select count(*) into recent_fails
    from public.relay_join_attempts
   where user_id = auth.uid()
     and not ok
     and attempted_at > now() - interval '15 minutes';
  if recent_fails >= 10 then
    return jsonb_build_object('ok', false, 'error', 'throttled',
      'message', 'Too many attempts. Wait a few minutes.');
  end if;

  select * into r from public.relays
   where code = upper(btrim(p_code))
     and status = 'live'
     and expires_at > now();

  if r.id is null then
    insert into public.relay_join_attempts (ok) values (false);
    return jsonb_build_object('ok', false, 'error', 'not_found',
      'message', 'No live relay with that code.');
  end if;

  insert into public.relay_join_attempts (ok) values (true);

  v_role := case when p_role in ('coach','shooter') then p_role else 'coach' end;

  -- Keep any slot already held: rejoining after a dropped signal must not
  -- change your colour on everyone else's screen mid-string.
  select slot into v_slot from public.relay_participants
   where relay_id = r.id and user_id = auth.uid();

  if v_role = 'shooter' and v_slot is null then
    -- Take the lowest free firing point rather than max+1, so a shooter who
    -- leaves and is replaced does not push the numbering upward forever.
    select min(g) into v_slot from generate_series(1, 4) g
     where not exists (select 1 from public.relay_participants p
                        where p.relay_id = r.id and p.slot = g);
    if v_slot is null then
      return jsonb_build_object('ok', false, 'error', 'full',
        'message', 'This relay already has four shooters. Join as a coach.');
    end if;
  end if;

  insert into public.relay_participants (relay_id, user_id, name, role, slot,
                                         distance_yd, target_name)
  values (r.id, auth.uid(),
          coalesce(nullif(btrim(p_name), ''), 'Guest'), v_role, v_slot,
          p_distance_yd, p_target_name)
  on conflict (relay_id, user_id) do update
    set name = excluded.name, role = excluded.role, slot = excluded.slot,
        -- keep a known distance if a later join omits it
        distance_yd = coalesce(excluded.distance_yd, relay_participants.distance_yd),
        -- and a known target, for the same reason
        target_name = coalesce(excluded.target_name, relay_participants.target_name),
        last_seen_at = now(), updated_at = now();

  return jsonb_build_object('ok', true, 'slot', v_slot, 'role', v_role,
                            'relay', to_jsonb(r) - 'target_rings');
end $$;

-- ----------------------------------------------------------------- relay_face
/* The static half of a relay: the paper, fetched once and cached by the
 * client. Kept out of relay_state on purpose — geometry does not change, and a
 * poll that carries it re-sends the same blob every 2.5 seconds to everyone.
 *
 * Participation-gated exactly like relay_state, so possession of a relay id is
 * not possession of the relay. */
create or replace function public.relay_face(p_relay uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare result jsonb;
begin
  if not public.is_relay_participant(p_relay) then
    raise exception 'not a participant' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'target_name', r.target_name,
    'target_rings', r.target_rings,
    'distance_yd', r.distance_yd
  ) into result
    from public.relays r
   where r.id = p_relay;

  return result;
end $$;

revoke all on function public.relay_face(uuid) from public;
grant execute on function public.relay_face(uuid) to authenticated;

-- ---------------------------------------------------------------- relay_state
create or replace function public.relay_state(
  p_relay uuid,
  p_since_shot timestamptz default '1970-01-01',
  p_since_msg timestamptz default '1970-01-01'
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare result jsonb;
begin
  if not public.is_relay_participant(p_relay) then
    raise exception 'not a participant' using errcode = '42501';
  end if;

  update public.relay_participants
     set last_seen_at = now()
   where relay_id = p_relay and user_id = auth.uid();

  select jsonb_build_object(
    'relay', (select to_jsonb(r) - 'target_rings' from public.relays r where r.id = p_relay),
    'shots', coalesce((select jsonb_agg(jsonb_build_object(
                         'id', s.id, 'shot_no', s.shot_no, 'ring', s.ring,
                         'x_in', s.x_in, 'y_in', s.y_in,
                         'call_x_in', s.call_x_in, 'call_y_in', s.call_y_in,
                         'wind_call_moa', s.wind_call_moa,
                         'wind_call_dir', s.wind_call_dir,
                         'is_sighter', s.is_sighter, 'note', s.note,
                         'created_at', s.created_at,
                         'slot', p.slot, 'shooter', p.name,
                         'is_self', s.user_id = auth.uid())
                       order by s.created_at, s.shot_no)
                       from public.relay_shots s
                       left join public.relay_participants p
                         on p.relay_id = s.relay_id and p.user_id = s.user_id
                       where s.relay_id = p_relay and s.created_at >= p_since_shot), '[]'::jsonb),
    -- Built column by column, like the shots above. `to_jsonb(m)` carried
    -- user_id to every participant -- the one payload in this schema that
    -- leaked an auth id, and only because it took the shortcut.
    'messages', coalesce((select jsonb_agg(jsonb_build_object(
                          'id', m.id, 'body', m.body, 'kind', m.kind,
                          'created_at', m.created_at,
                          -- author_name as WRITTEN, not the participant's
                          -- current name: a line in the feed said what it said
                          -- at the time, and renaming yourself must not rewrite
                          -- who said it. `slot` comes from the participant row
                          -- because that is what the feed colours by.
                          'author_name', m.author_name,
                          'slot', p.slot,
                          'is_self', m.user_id = auth.uid())
                          order by m.created_at, m.id)
                          from public.relay_messages m
                          left join public.relay_participants p
                            on p.relay_id = m.relay_id and p.user_id = m.user_id
                          where m.relay_id = p_relay and m.created_at >= p_since_msg), '[]'::jsonb),
    'participants', coalesce((select jsonb_agg(jsonb_build_object(
                          'name', p.name, 'role', p.role, 'slot', p.slot,
                          'distance_yd', coalesce(p.distance_yd,
                                                  (select r2.distance_yd from public.relays r2
                                                    where r2.id = p_relay)),
                          -- Falls back to the relay's target, which is the
                          -- honest default: a shooter who joined before this
                          -- column existed, or from a device that did not send
                          -- one, is on the relay's target as far as anyone
                          -- knows. Null here would read as "different".
                          'target_name', coalesce(p.target_name,
                                                  (select r2.target_name from public.relays r2
                                                    where r2.id = p_relay)),
                          'last_seen_at', p.last_seen_at,
                          'is_self', p.user_id = auth.uid())
                          order by p.slot nulls last, p.joined_at)
                       from public.relay_participants p where p.relay_id = p_relay), '[]'::jsonb),
    'server_time', now()
  ) into result;

  return result;
end $$;

-- ---------------------------------------------------------------- grants
-- join_relay was dropped and recreated above, which takes its grant with it.
grant execute on function
  public.join_relay(text, text, text, numeric, text),
  public.relay_face(uuid)
  to authenticated;
