-- ============================================================================
-- Let the audit log record a listing.
--
-- 0018 enumerated the three verbs the support tools had at the time. The tools
-- now also LIST every customer, and that verb has to be allowed here or the
-- CHECK refuses the row -- silently, because the function does not read the
-- result of its own logging call, so the listing would still succeed and simply
-- go unrecorded. An audit trail with one invisible verb is worse than none: it
-- reads as complete.
--
-- Reading the whole customer list is the most sensitive of the four. It is the
-- one that touches every account at once rather than the one somebody wrote in
-- about, so it is the one most worth having a record of.
-- ============================================================================
alter table public.owner_action_log
  drop constraint owner_action_log_action_check;

alter table public.owner_action_log
  add constraint owner_action_log_action_check check (action in
    ('list', 'lookup', 'send_reset', 'resend_confirmation'));
