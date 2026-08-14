-- ============================================================================
-- 0004: live relay / pair-firing kit.
--
-- PAIR FIRE, as actually shot: two shooters and a coach, all three watching
-- each other's work. One of them starts a relay and gets a 4-character code;
-- the others enter it with a name and a role.
--
--   * a SHOOTER logs their own string, and sees their partner's shots and
--     calls drawn over their own target in a second colour
--   * a COACH logs nothing and sees both strings side by side -- calls as
--     well as impacts, which is the thing a coach is actually reading
--   * everyone shares one feed for wind calls and chatter
--
-- The consequence for this schema is that there is no single privileged
-- writer. Every shooter writes THEIR OWN string and nobody else's, which is
-- enforced per row rather than per relay. See relay_shots below.
--
-- SECURITY MODEL -- this differs from every other table in the schema.
--
-- "No accounts" is a statement about the USER EXPERIENCE, not about
-- authentication. Each device performs an anonymous sign-in, which in Supabase
-- creates a real auth.users row using the `authenticated` role and carries an
-- `is_anonymous` JWT claim. So auth.uid() still exists and RLS still works;
-- the user simply never typed an email.
--
-- Access to a relay is therefore NOT granted by holding the code. It is
-- granted by having a row in relay_participants, and the ONLY way to obtain
-- that row is join_relay(), a security definer function that takes the code.
-- One door, which is what makes the code throttleable.
--
-- BRUTE FORCE, stated honestly. The alphabet is 27 characters (no vowels, so
-- no accidental words; no 0/O/1/I/L, so nothing ambiguous when shouted down a
-- firing line), giving 27^4 = 531,441 codes. Codes are only valid while a
-- relay is live and unexpired, so the target set is however many relays are
-- running right now -- typically one or two. Combined with the per-user
-- attempt throttle below and Supabase's default 30 anonymous sign-ins per hour
-- per IP, guessing a live code takes days of sustained effort. The prize is
-- someone's shot string. That is an acceptable trade for a code short enough
-- to say out loud; it would NOT be acceptable for anything sensitive, and
-- nothing sensitive is reachable through it.
-- ============================================================================

-- ---------------------------------------------------------------- relays
create table public.relays (
  id            uuid primary key default gen_random_uuid(),
  code          text not null,
  host_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  host_name     text not null default 'Shooter',
  title         text,
  target_name   text,
  -- Ring geometry snapshot so a viewer can draw the plot without owning the
  -- same custom target. Optional: the statistics are pure point geometry.
  target_rings  jsonb,
  distance_yd   numeric(7,1) check (distance_yd > 0),
  status        text not null default 'live' check (status in ('live', 'ended')),
  started_at    timestamptz not null default now(),
  ended_at      timestamptz,
  expires_at    timestamptz not null default now() + interval '12 hours',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint relay_code_shape check (code ~ '^[2-9BCDFGHJKMNPQRSTVWXZ]{4}$')
);

-- A code is only reserved while it is live, so codes recycle naturally.
create unique index ux_relay_live_code on public.relays (code) where status = 'live';
create index ix_relay_host on public.relays (host_id, started_at desc);

-- ------------------------------------------------------------ participants
create table public.relay_participants (
  id            uuid primary key default gen_random_uuid(),
  relay_id      uuid not null references public.relays(id) on delete cascade,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name          text not null default 'Guest',
  role          text not null default 'coach' check (role in ('coach', 'shooter')),
  -- Firing point number, 1..MAX_SHOOTERS, assigned on first becoming a
  -- shooter and never reused within a relay. This is what makes "your partner
  -- in a different colour" consistent on every device: colour is a function of
  -- slot, not of join order as each client happens to observe it. Coaches have
  -- no slot.
  slot          smallint check (slot between 1 and 4),
  joined_at     timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (relay_id, user_id)
);
create unique index ux_relay_slot on public.relay_participants (relay_id, slot)
  where slot is not null;
create index ix_relay_part_lookup on public.relay_participants (user_id, relay_id);

-- ------------------------------------------------------------------ shots
-- A projection for viewing, not a system of record: Zero's own session stays
-- the source of truth on each shooter's device.
--
-- user_id is the whole design. Shot 3 is not "the relay's shot 3", it is "this
-- shooter's shot 3", so two shooters firing simultaneously do not collide and
-- neither can overwrite the other's string by racing to a number.
create table public.relay_shots (
  id            uuid primary key default gen_random_uuid(),
  relay_id      uuid not null references public.relays(id) on delete cascade,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  shot_no       integer not null check (shot_no > 0),
  ring          text,
  x_in          numeric(8,3),
  y_in          numeric(8,3),
  -- Where the shooter CALLED it: sights at the break. The gap between call and
  -- impact is the single most useful thing a coach reads off a string -- a
  -- called flyer is a technique problem, an uncalled one is wind or ammunition.
  call_x_in     numeric(8,3),
  call_y_in     numeric(8,3),
  -- The wind call this shot was fired on, so the coach can see whether their
  -- own call was taken and what it did.
  wind_call_moa numeric(6,2),
  wind_call_dir text check (wind_call_dir in ('L', 'R')),
  is_sighter    boolean not null default false,
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (relay_id, user_id, shot_no, is_sighter)
);
create index ix_relay_shots_feed on public.relay_shots (relay_id, created_at);

-- ------------------------------------------------------------------- feed
create table public.relay_messages (
  id            uuid primary key default gen_random_uuid(),
  relay_id      uuid not null references public.relays(id) on delete cascade,
  user_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  author_name   text not null default 'Guest',
  kind          text not null default 'chat' check (kind in ('chat', 'wind', 'system')),
  body          text not null check (length(btrim(body)) between 1 and 500),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index ix_relay_msgs_feed on public.relay_messages (relay_id, created_at);

-- --------------------------------------------------------- join throttling
-- One row per failed guess. join_relay refuses once a user has burned through
-- the budget, which is what turns a 4-character code from guessable into
-- impractical.
create table public.relay_join_attempts (
  id          bigserial primary key,
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  ok          boolean not null
);
create index ix_join_attempts on public.relay_join_attempts (user_id, attempted_at desc);

-- ============================================================ triggers
do $$
declare t text;
begin
  foreach t in array array['relays','relay_participants','relay_shots','relay_messages'] loop
    execute format('create trigger %I before update on public.%I
                    for each row execute function public.set_updated_at()',
                   t || '_set_updated_at', t);
  end loop;
end $$;

-- ============================================================ helpers
/* Is the caller a participant of this relay? Used by every relay policy.
 * SECURITY DEFINER so the policy on relay_participants cannot recurse into
 * itself while being evaluated. */
create or replace function public.is_relay_participant(p_relay uuid)
returns boolean
language sql
security definer
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.relay_participants
    where relay_id = p_relay and user_id = auth.uid()
  );
$$;

/* Codes avoid vowels entirely (so a code can never spell a word) and avoid
 * 0/O/1/I/L (so it is unambiguous shouted across a firing line). */
create or replace function public.gen_relay_code()
returns text
language plpgsql
volatile
as $$
declare
  alphabet constant text := '23456789BCDFGHJKMNPQRSTVWXZ';
  out text := '';
  i integer;
begin
  for i in 1..4 loop
    out := out || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
  end loop;
  return out;
end $$;

-- ============================================================ RPCs
/* Start a relay. Retries on the (rare) code collision against live relays. */
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

  -- End any relay this host already has running: one live relay per shooter
  -- keeps the mental model simple and stops orphaned codes accumulating.
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

  -- The creator is a participant too, so one set of policies covers everyone.
  -- They take firing point 1; a partner joining later takes 2.
  insert into public.relay_participants (relay_id, user_id, name, role, slot)
  values (r.id, auth.uid(), r.host_name, 'shooter', 1);

  return r;
end $$;

/* The ONLY entry point that accepts a code. Throttled per user.
 *
 * Returns a RESULT rather than raising, and that is load-bearing, not
 * stylistic: a RAISE rolls back the current subtransaction, which would undo
 * the very row recording the failed attempt. Raising on a bad code therefore
 * produced a throttle that counted nothing and never tripped. Returning
 * {ok:false} lets the insert commit -- and spares the client parsing Postgres
 * error strings. */
create or replace function public.join_relay(
  p_code text,
  p_name text default 'Guest',
  p_role text default 'coach'
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

  insert into public.relay_participants (relay_id, user_id, name, role, slot)
  values (r.id, auth.uid(),
          coalesce(nullif(btrim(p_name), ''), 'Guest'), v_role, v_slot)
  on conflict (relay_id, user_id) do update
    set name = excluded.name, role = excluded.role, slot = excluded.slot,
        last_seen_at = now(), updated_at = now();

  return jsonb_build_object('ok', true, 'slot', v_slot, 'role', v_role,
                            'relay', to_jsonb(r) - 'target_rings');
end $$;

/* One round trip per poll tick: everything new since the caller's cursors,
 * plus the participant list and current status. Polling beats a WebSocket
 * here -- a coach's phone backgrounds constantly, and a plain request on
 * resume simply works where a silently-dropped socket does not. */
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

  -- Presence: this poll IS the heartbeat. No separate keepalive to go stale.
  update public.relay_participants
     set last_seen_at = now()
   where relay_id = p_relay and user_id = auth.uid();

  select jsonb_build_object(
    'relay', (select to_jsonb(r) - 'target_rings' from public.relays r where r.id = p_relay),
    -- >= not >, deliberately. Rows written in one transaction share an
    -- identical created_at, so a strict > cursor silently drops every row
    -- that ties the boundary. The overlap costs re-sending the last row or
    -- two; THE CLIENT MUST DEDUPE BY id, which zero-core's relay client does.
    -- Shots carry the firing point and the shooter's name, NOT their user id:
    -- co-participants have no business learning each other's auth ids, and
    -- slot is what the clients colour by anyway. is_self lets a device pick
    -- its own string out without one.
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
    'messages', coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at, m.id)
                          from public.relay_messages m
                          where m.relay_id = p_relay and m.created_at >= p_since_msg), '[]'::jsonb),
    'participants', coalesce((select jsonb_agg(jsonb_build_object(
                          'name', p.name, 'role', p.role, 'slot', p.slot,
                          'last_seen_at', p.last_seen_at,
                          'is_self', p.user_id = auth.uid())
                          order by p.slot nulls last, p.joined_at)
                       from public.relay_participants p where p.relay_id = p_relay), '[]'::jsonb),
    'server_time', now()
  ) into result;

  return result;
end $$;

create or replace function public.end_relay(p_relay uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.relays set status = 'ended', ended_at = now(), updated_at = now()
   where id = p_relay and host_id = auth.uid();
  if not found then
    raise exception 'only the host can end a relay' using errcode = '42501';
  end if;
end $$;

-- ============================================================ RLS
alter table public.relays enable row level security;
alter table public.relays force row level security;
alter table public.relay_participants enable row level security;
alter table public.relay_participants force row level security;
alter table public.relay_shots enable row level security;
alter table public.relay_shots force row level security;
alter table public.relay_messages enable row level security;
alter table public.relay_messages force row level security;
alter table public.relay_join_attempts enable row level security;
alter table public.relay_join_attempts force row level security;

-- Relays: participants read; only the host writes. Note there is deliberately
-- no policy allowing SELECT by code -- that is what join_relay() is for.
create policy relay_select on public.relays for select
  using (public.is_relay_participant(id));
create policy relay_update_host on public.relays for update
  using (host_id = auth.uid()) with check (host_id = auth.uid());

create policy relay_part_select on public.relay_participants for select
  using (public.is_relay_participant(relay_id));
create policy relay_part_update_self on public.relay_participants for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy relay_part_delete_self on public.relay_participants for delete
  using (user_id = auth.uid());

-- Shots: every participant reads all of them -- that mutual visibility IS the
-- feature. Writing is where it gets narrow, and the gate is per ROW, not per
-- relay: you may write a shot only if it is attributed to you, you hold the
-- shooter role in this relay, and the relay is still live.
--
-- Three distinct things are therefore impossible: a coach fabricating anybody's
-- string, a shooter fabricating their PARTNER's string, and either of them
-- appending to a relay that has ended.
--
-- (If a scorer entering shots on a shooter's behalf is ever wanted, that is a
-- change to this one policy -- allow a coach to insert rows attributed to a
-- shooter -- and nothing else. It is deliberately not enabled: silently
-- letting two devices write one string is how a shot string gets duplicated.)
create policy relay_shots_select on public.relay_shots for select
  using (public.is_relay_participant(relay_id));
create policy relay_shots_insert_own on public.relay_shots for insert
  with check (user_id = auth.uid()
              and exists (select 1 from public.relay_participants p
                           join public.relays r on r.id = p.relay_id
                          where p.relay_id = relay_shots.relay_id
                            and p.user_id = auth.uid()
                            and p.role = 'shooter'
                            and r.status = 'live'));
create policy relay_shots_update_own on public.relay_shots for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy relay_shots_delete_own on public.relay_shots for delete
  using (user_id = auth.uid());

-- Feed: every participant reads and writes their own lines.
create policy relay_msg_select on public.relay_messages for select
  using (public.is_relay_participant(relay_id));
create policy relay_msg_insert on public.relay_messages for insert
  with check (user_id = auth.uid() and public.is_relay_participant(relay_id));
create policy relay_msg_delete_own on public.relay_messages for delete
  using (user_id = auth.uid());

-- Attempts are written by the security definer function only; nobody reads them.
create policy relay_attempts_none on public.relay_join_attempts for select using (false);

-- ============================================================ anonymous users
/* Anonymous devices exist for the relay. They must NOT be able to publish to
 * the leaderboard, or the board becomes trivially spammable by anyone who can
 * hit the signup endpoint. RESTRICTIVE, so it ANDs with the existing policy
 * rather than opening a new path. */
create policy lbp_no_anon on public.leaderboard_profiles as restrictive for insert
  to authenticated
  with check ((select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)) is false);
create policy lbe_no_anon on public.leaderboard_entries as restrictive for insert
  to authenticated
  with check ((select coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)) is false);

-- ============================================================ grants
grant select, insert, update, delete on
  public.relays, public.relay_participants, public.relay_shots, public.relay_messages
  to authenticated;
grant execute on function
  public.create_relay(text, text, text, jsonb, numeric),
  public.join_relay(text, text, text),
  public.relay_state(uuid, timestamptz, timestamptz),
  public.end_relay(uuid),
  public.is_relay_participant(uuid)
  to authenticated;
