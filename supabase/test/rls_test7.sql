-- ============================================================================
-- Whole-device backups (0010).
--
-- This row is the entire contents of someone's phone in one column, which
-- makes it the single most sensitive object in the schema. Four claims:
--
--   1. it is yours and nobody else's, under every verb
--   2. one account cannot accumulate rows without bound
--   3. the size ceiling is the database's, not the client's
--   4. an anonymous relay device cannot park data here at all
--
-- (4) matters because an anonymous identity is free to create: anyone who can
-- reach the signup endpoint gets one, and 8 MiB per slot per identity is an
-- unmetered write endpoint if the RESTRICTIVE policy is missing.
-- ============================================================================
\set ON_ERROR_STOP on
\pset pager off

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'backup-a@example.com'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'backup-b@example.com')
on conflict do nothing;

set role authenticated;

-- ============================================================ A backs up
select test.as_user('aaaaaaaa-0000-0000-0000-00000000000a');

insert into public.account_backups (app, slot, payload, counts, device_label)
values ('zero', 'default', '{"sessions_v1":[{"id":"s1"}]}', '{"sessions":1}'::jsonb, 'iPhone');

do $$
declare n integer;
begin
  select count(*) into n from public.account_backups;
  perform test.check(n = 1, 'a snapshot is stored');

  -- user_id defaults to auth.uid(): the client never has to send it, and a
  -- client that sends someone else's is refused by the with-check below.
  select count(*) into n from public.account_backups
   where user_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  perform test.check(n = 1, 'and is attributed to the account that wrote it, without being told');
end $$;

-- ============================================ one account, one row per slot
do $$
begin
  begin
    insert into public.account_backups (app, slot, payload)
    values ('zero', 'default', '{"second":true}');
    perform test.check(false,
      'a second row in the same slot must be refused — otherwise an account '
      || 'accumulates 8 MiB rows without bound');
  exception when unique_violation then
    perform test.check(true, 'a second row in the same slot is refused: the slot IS the bound');
  end;
end $$;

-- Overwriting the slot is how a repeat backup is meant to work.
update public.account_backups set payload = '{"sessions_v1":[{"id":"s1"},{"id":"s2"}]}'
 where app = 'zero' and slot = 'default';
do $$
declare p text;
begin
  select payload into p from public.account_backups where app = 'zero' and slot = 'default';
  perform test.check(p like '%s2%', 'writing the slot again replaces it in place');
end $$;

-- A different app, and a different slot, are different rows. Bench and Zero
-- share an account; restoring a bench into a shooting log would be nonsense.
insert into public.account_backups (app, slot, payload)
values ('bench', 'default', '{"brassLots":[]}'),
       ('zero',  'slot2',   '{"keep":"me"}');
do $$
declare n integer;
begin
  select count(*) into n from public.account_backups;
  perform test.check(n = 3, 'app and slot are part of the key, so they do not collide');
end $$;

-- The vocabulary is fixed, which is what makes "rows per account" countable.
do $$
begin
  begin
    insert into public.account_backups (app, slot, payload)
    values ('zero', 'whatever-i-like', '{}');
    perform test.check(false, 'free-text slots would make the row count unbounded');
  exception when check_violation then
    perform test.check(true, 'the slot vocabulary is fixed, so the row count per account is fixed');
  end;
  begin
    insert into public.account_backups (app, slot, payload) values ('notanapp', 'auto', '{}');
    perform test.check(false, 'an unknown app should be refused');
  exception when check_violation then
    perform test.check(true, 'and so is a snapshot claiming to be from an app that does not exist');
  end;
end $$;

-- ==================================================== the ceiling is the server's
do $$
begin
  begin
    insert into public.account_backups (app, slot, payload)
    values ('zero', 'slot3', repeat('x', 8388609));
    perform test.check(false, 'an oversized payload must be refused by the database');
  exception when check_violation then
    perform test.check(true,
      'the 8 MiB ceiling is enforced here, not merely in the client that is trying to exceed it');
  end;
end $$;

-- ================================================ B cannot see or touch A's
select test.as_user('bbbbbbbb-0000-0000-0000-00000000000b');
do $$
declare n integer;
begin
  select count(*) into n from public.account_backups;
  perform test.check(n = 0, 'another account sees none of A''s backups');

  select count(*) into n from public.v_account_backups;
  perform test.check(n = 0,
    'nor through the listing view — security_invoker, so it is not a way around the policy');

  -- An UPDATE that matches no visible row is not an error, it changes nothing.
  update public.account_backups set payload = '{"stolen":true}';
  get diagnostics n = row_count;
  perform test.check(n = 0, 'and cannot overwrite A''s snapshot');

  delete from public.account_backups;
  get diagnostics n = row_count;
  perform test.check(n = 0, '...or delete it');
end $$;

-- Writing a row that CLAIMS to be A's is refused outright rather than silently
-- re-attributed, which is the difference between a policy and a default.
do $$
begin
  begin
    insert into public.account_backups (user_id, app, slot, payload)
    values ('aaaaaaaa-0000-0000-0000-00000000000a', 'zero', 'auto', '{}');
    perform test.check(false, 'writing a backup into someone else''s account must be refused');
  exception when insufficient_privilege then
    perform test.check(true, 'a backup cannot be written into someone else''s account');
  end;
end $$;

-- ============================================ an anonymous device is not a customer
-- Anonymous identities exist so a partner can join a pair-fire relay without an
-- account. They are free to mint, so an unmetered 8 MiB write endpoint behind
-- one is an open door.
select test.as_user('bbbbbbbb-0000-0000-0000-00000000000b', true);
do $$
begin
  begin
    insert into public.account_backups (app, slot, payload) values ('zero', 'default', '{}');
    perform test.check(false, 'an anonymous device must not be able to store a backup');
  exception when insufficient_privilege then
    perform test.check(true,
      'an anonymous relay device cannot store a backup — the endpoint is not free storage');
  end;
end $$;

-- ================================================== A still has exactly what it had
select test.as_user('aaaaaaaa-0000-0000-0000-00000000000a');
do $$
declare n integer; p text;
begin
  select count(*) into n from public.account_backups;
  perform test.check(n = 3, 'A still has its three rows after all of that');
  select payload into p from public.account_backups where app = 'zero' and slot = 'default';
  perform test.check(p like '%s2%', '...with its snapshot unmodified');

  -- The listing is what the restore screen renders, so it must carry the size
  -- without carrying the megabytes.
  select count(*) into n from public.v_account_backups where bytes > 0;
  perform test.check(n = 3, 'the listing view reports a size for every backup');
end $$;

reset role;
\echo ''
\echo 'ACCOUNT BACKUP ASSERTIONS PASSED'
