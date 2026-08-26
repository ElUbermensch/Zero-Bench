-- ============================================================================
-- 0014 — a second device on one account must not silently take the relay over.
--
-- `relay_participants` is unique on (relay_id, user_id), and `join_relay` did
-- `on conflict (relay_id, user_id) do update set role = excluded.role,
-- slot = excluded.slot`. So the row is the ACCOUNT's, not the device's, and
-- the last device to join rewrites it unconditionally.
--
-- 0004's header says "each device performs an anonymous sign-in", and that
-- stopped being true: `ensureIdentity()` uses the signed-in account whenever
-- there is one, and 0010 exists precisely so a second phone is a restore
-- rather than a retype. The product actively puts one account on two devices.
--
-- What that costs today, reproduced end to end: a shooter is live from their
-- phone, props a tablet on the bench to watch their own string, and the tablet
-- joins as a coach. The phone's role flips to `coach` server-side, so
-- `relay_shots_insert_own` refuses every subsequent shot with 42501 — while the
-- phone still shows `● live`, its own session keeps logging normally, and
-- nothing appears anywhere, because relayPushShot is fire-and-forget and
-- nothing subscribed to RELAY_ERROR. The partner and the coach watch the string
-- stop at shot 3, mid-match. And if the second device joins as a SHOOTER
-- instead, both write the same (relay_id, user_id, shot_no, is_sighter) key
-- with merge-duplicates, so each device's shot silently overwrites the other's
-- and the relay shows one string built from two.
--
-- THE FIX IS A ONE-DIRECTIONAL REFUSAL.
--
-- The first attempt at this refused ANY role change while a fresh row existed,
-- and the SQL suite caught it immediately: "the coach picks up a rifle" is a
-- real thing that happens on a firing line, it is a single device changing its
-- own mind, and 0004 has pinned it since the relay shipped. Refusing a working
-- flow to close a rarer hole is a bad trade, and the failing assertion said so
-- before this ever reached a user.
--
-- So only the direction that kills a live string is refused: a live SHOOTER
-- being asked to become a coach. Coach → shooter still works. Same-role rejoin
-- still works, because that is a dropped signal reconnecting.
--
-- Keying the participant on a client-minted device id is the other candidate,
-- and it is the more general answer: two devices on one account become two
-- participants, and both can shoot. It is also a schema change across three
-- tables, an RPC signature change, a new meaning for `is_self`, and a slot
-- allocator that would let one account consume two of the four firing points.
-- That is a lot of new surface for a case the product does not actually ask
-- for — a relay is people on a firing line, and one person is one firing point.
--
-- What that leaves open, said plainly rather than left to be discovered: two
-- devices on one account both joining as SHOOTERS still share one participant
-- row and still overwrite each other's shots. The difference is that the case
-- left open is VISIBLE — two strings merged into one, obviously wrong on every
-- screen — where the one closed here was silent.
--
-- The presence window is the same 20 seconds the client polls on: a row that
-- has not been seen for longer is a device that has gone, and taking over from
-- it is the reconnect case rather than a collision.
--
-- Every error code, message and throttle behaviour below is otherwise
-- byte-for-byte 0009's. The SQL suite asserts on those strings.
-- ============================================================================

create or replace function public.join_relay(
  p_code text,
  p_name text default 'Guest',
  p_role text default 'coach',
  p_distance_yd numeric default null,
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
  v_held text;
  v_fresh boolean;
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
  select slot, role, last_seen_at > now() - interval '20 seconds'
    into v_slot, v_held, v_fresh
    from public.relay_participants
   where relay_id = r.id and user_id = auth.uid();

  /* The refusal, and it is deliberately ONE-DIRECTIONAL.
   *
   * Refused: a live SHOOTER being asked to become a coach. That is the silent
   * kill — the tablet on the bench joining to watch, flipping the phone's role,
   * and every shot the phone fires afterwards being refused 42501 while it
   * still shows `● live`.
   *
   * Allowed: everything else, and the one that matters is coach → shooter.
   * "The coach picks up a rifle" is a real thing that happens on a firing line,
   * it is a single device changing its own mind, and the SQL suite has pinned
   * it since 0004. Refusing it to close a rarer hole would be trading a working
   * flow for a hypothetical one.
   *
   * A rejoin in the SAME role falls straight through, because that is a dropped
   * signal reconnecting and it must keep working.
   *
   * WHAT THIS DOES NOT FIX, stated plainly rather than left to be discovered:
   * two devices on one account both joining as SHOOTERS still share the single
   * participant row, so their shots collide on
   * (relay_id, user_id, shot_no, is_sighter) and overwrite each other. Closing
   * that needs a client-minted device id on three tables, a widened unique key,
   * an RPC signature change, and a slot allocator that would let one account
   * consume two of the four firing points. It is the more general answer and it
   * is a lot of new surface for a case the product does not ask for — a relay
   * is people on a firing line, and one person is one firing point. The
   * difference is that the case left open is VISIBLE (two strings merged into
   * one, obviously wrong on every screen) where the one closed here was
   * silent. */
  if v_held = 'shooter' and v_fresh and v_role = 'coach' then
    return jsonb_build_object('ok', false, 'error', 'already_shooting',
      'role', v_held,
      'message', 'This account is already shooting in this relay, on this or '
              || 'another device. End that first, or watch from a different account.');
  end if;

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

revoke all on function public.join_relay(text, text, text, numeric, text) from public;
grant execute on function public.join_relay(text, text, text, numeric, text) to authenticated;
