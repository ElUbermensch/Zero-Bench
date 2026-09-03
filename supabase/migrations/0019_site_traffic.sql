-- ============================================================================
-- Traffic to the information site.
--
-- A SEPARATE TABLE from analytics_event, and that separation is the whole
-- design. Everything in analytics_event is written by a signed-in user under
-- `user_id = auth.uid()`, which is what makes those numbers trustworthy. The
-- marketing site has no signed-in users at all -- that is the point of it --
-- so recording its traffic means letting the `anon` role insert, and the
-- publishable key that permits it is printed in every page of the site.
--
-- So these rows are, and must be treated as, ASSERTIONS BY THE PUBLIC. Anyone
-- who reads the key can write them. Keeping them in their own table means the
-- worst case is a spoiled marketing chart, not a spoiled product metric: a
-- flood here cannot move active-user counts, sign-up counts, or feature usage,
-- because none of those read this table.
--
-- The columns are bounded for the same reason. There is no free-text field a
-- writer can put a megabyte in, every string has a length CHECK, and the two
-- enumerated columns are constrained to their vocabularies. A public insert
-- endpoint with an unbounded text column is a storage bill with a URL.
--
-- What is deliberately NOT collected: no IP address, no cookie, no device
-- fingerprint, no full referring URL, and no identifier that outlives the tab.
-- This answers "did the thing we posted on Thursday bring anybody" without
-- building a profile of anybody, which is both the decent choice and the one
-- that keeps a plain privacy notice truthful.
-- ============================================================================
create table public.site_visit (
  id            uuid primary key default gen_random_uuid(),
  /* Client-generated, one per tab, held in sessionStorage and gone when the
   * tab closes. It exists so five pages read in one sitting count as one
   * visit and five pageviews -- not as five visitors. It is not a user id and
   * cannot be joined to one. */
  visit_id      uuid not null,
  path          text not null check (length(path) between 1 and 200),
  /* The referring HOST, never the full URL. A full referrer carries search
   * terms and, from some sites, identifiers belonging to the reader. The host
   * is what answers "where is this traffic coming from". */
  referrer_host text check (length(referrer_host) <= 120),
  utm_source    text check (length(utm_source) <= 60),
  utm_medium    text check (length(utm_medium) <= 60),
  utm_campaign  text check (length(utm_campaign) <= 80),
  device        text check (device in ('mobile', 'tablet', 'desktop')),
  created_at    timestamptz not null default now()
);

create index site_visit_created_idx on public.site_visit (created_at desc);
create index site_visit_campaign_idx on public.site_visit (utm_campaign, created_at desc);

comment on table public.site_visit is
  'Pageviews on the marketing site. Written by anonymous visitors, so treat every '
  'row as an unverified public assertion; kept apart from analytics_event so a '
  'flood cannot reach the product numbers.';

alter table public.site_visit enable row level security;
alter table public.site_visit force row level security;

/* Anyone may add a pageview, nobody may read one back.
 *
 * `with check (true)` looks permissive and is the only thing that can work: the
 * writer is anonymous by definition, so there is no identity to test the row
 * against. The bounds are the column CHECKs above, not the policy.
 *
 * The important half is what is missing -- there is no select policy for anon
 * or for an ordinary user, so the marketing log cannot be read by the public
 * that writes it, and no visitor can enumerate what any other visitor read. */
create policy site_visit_insert_public on public.site_visit
  for insert to anon, authenticated
  with check (true);

create policy site_visit_select_admin on public.site_visit
  for select to authenticated
  using (public.is_admin_mfa());

-- No update and no delete policy, for anyone. Append-only, like the rest.
grant insert on public.site_visit to anon, authenticated;
grant select on public.site_visit to authenticated;

-- ============================================================================
-- Rollups. security_invoker, so the base table's policy is what decides --
-- an owner-rights view here would publish the whole marketing log.
-- ============================================================================

/* The traffic curve. `visits` counts distinct tabs, `pageviews` counts pages:
 * a campaign that brings a hundred people who each read one page and one that
 * brings ten who read ten are the same pageview count and very different
 * news. */
create view public.v_site_daily
  with (security_invoker = true) as
select
  (created_at at time zone 'utc')::date as day,
  count(distinct visit_id)              as visits,
  count(*)                              as pageviews
from public.site_visit
group by 1;

/* Where a visit came from, resolved once per visit rather than once per page.
 *
 * A campaign tag wins over a referrer because it is the thing you deliberately
 * put on a link; the referrer is the fallback when nobody tagged anything; and
 * 'direct' is what is left -- typed, bookmarked, or arriving from somewhere
 * that strips the referrer, which includes most messaging apps. Attributing on
 * the FIRST page of a visit matters: the utm tag is only on the link that was
 * clicked, so counting every page would credit the campaign once and 'direct'
 * four times for the same person. */
create view public.v_site_sources
  with (security_invoker = true) as
with first_page as (
  select distinct on (visit_id)
    visit_id,
    (created_at at time zone 'utc')::date as day,
    coalesce(nullif(utm_campaign, ''), nullif(utm_source, ''),
             nullif(referrer_host, ''), 'direct')                as source,
    coalesce(nullif(utm_medium, ''), case when referrer_host is null
             then 'direct' else 'referral' end)                  as medium
  from public.site_visit
  order by visit_id, created_at asc
)
select day, source, medium, count(*) as visits
from first_page
group by 1, 2, 3;

/* Which pages get read, and by how many separate visits. */
create view public.v_site_pages
  with (security_invoker = true) as
select
  (created_at at time zone 'utc')::date as day,
  path,
  count(*)                              as views,
  count(distinct visit_id)              as visits
from public.site_visit
group by 1, 2;

/* What kind of screen it was read on. The marketing site is linked from
 * phones far more than the apps are, and a page that converts on a desktop and
 * not on a phone is a page with a layout problem rather than a copy problem. */
create view public.v_site_devices
  with (security_invoker = true) as
select
  (created_at at time zone 'utc')::date as day,
  coalesce(device, 'unknown')           as device,
  count(distinct visit_id)              as visits
from public.site_visit
group by 1, 2;

grant select on
  public.v_site_daily, public.v_site_sources,
  public.v_site_pages, public.v_site_devices
to authenticated;
