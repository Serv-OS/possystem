-- supabase/queries/caller_authority_report.sql
--
-- READ ONLY. OPS DB (tbetcegmszzotrwdtqhi). Paste into the SQL editor; changes nothing.
-- Needs migration 20260918_OPS_caller_authority_log.sql.
--
-- What caller_authority_log says, so staff can fix real tills, kiosks and online orders BEFORE
-- anyone sets LOYALTY_AUTHORITY_MODE=enforce (18 Sep 2026, round three).
--
-- One venue per row: the edge function resolves whichever id the caller sent (Ops or Platform)
-- to the venue's Ops id and name when it writes the row (ops_location_id, venue_name). Rows
-- whose location could not be resolved fall back to what the caller sent.
--
-- Change the window in the first line of each query (default: the last 7 days).


-- ============================================================================
-- 1. Summary: by function, reason and venue
-- ============================================================================
with w as (select now() - interval '7 days' as since)
select
  coalesce(l.name, a.venue_name, a.location_id, '(no venue sent)')   as venue,
  a.fn,
  a.reason,
  a.mode,
  a.outcome,
  a.caller_kind,
  a.channel,
  count(*)                                                           as calls,
  count(distinct a.caller_id)                                        as distinct_callers,
  sum(coalesce((a.detail->>'suppressed_before')::int, 0))            as further_calls_not_logged,
  min(a.created_at)                                                  as first_seen,
  max(a.created_at)                                                  as last_seen
from public.caller_authority_log a
left join public.locations l on l.id = a.ops_location_id
cross join w
where a.created_at >= w.since
group by 1, 2, 3, 4, 5, 6, 7
order by calls desc, venue, a.fn;


-- ============================================================================
-- 2. Which till or kiosk to re-pair: anonymous callers with no device claim
-- ============================================================================
-- Every row here is a session that acted like a till or kiosk (loyalty earn, redeem, refund,
-- gift card reversal) but holds no claimed devices row. device_hint is what the browser says it
-- was paired as (its rpos-device id or rpos-kiosk-id); it is joined to devices to name it.
-- Fix: Back Office -> Devices (or Kiosks) -> that device -> new pairing code -> type it on the
-- device. Online checkout rows (channel 'online', no device) are customers, not devices: those
-- need the member signed in, and are expected until then.
with w as (select now() - interval '7 days' as since)
select
  coalesce(l.name, a.venue_name, a.location_id, '(no venue sent)')   as venue,
  coalesce(d.name, '(unknown device)')                               as device_name,
  d.type                                                             as device_type,
  a.detail->>'device_hint'                                           as device_id,
  d.status                                                           as device_status,
  d.device_uid is not null                                           as device_row_has_a_claim,
  d.last_seen                                                        as device_last_seen,
  a.caller_id                                                        as anonymous_session,
  string_agg(distinct a.fn, ', ' order by a.fn)                      as functions,
  string_agg(distinct a.channel, ', ')                               as channels,
  count(*)                                                           as calls,
  max(a.created_at)                                                  as last_seen
from public.caller_authority_log a
left join public.locations l on l.id = a.ops_location_id
left join public.devices d
       on d.id::text = a.detail->>'device_hint'
cross join w
where a.created_at >= w.since
  and a.caller_anonymous is true
  and a.reason in ('anonymous_no_device', 'anonymous', 'device_other_company', 'member_token_invalid', 'member_token_not_accepted')
group by 1, 2, 3, 4, 5, 6, 7, 8
order by venue, calls desc;


-- ============================================================================
-- 3. Signed in users refused (Back Office users without the venue)
-- ============================================================================
with w as (select now() - interval '7 days' as since)
select
  coalesce(l.name, a.venue_name, a.location_id, '(no venue sent)')   as venue,
  a.caller_id                                                        as user_id,
  up.email,
  up.role,
  up.location_id                                                     as profile_location,
  string_agg(distinct a.fn, ', ' order by a.fn)                      as functions,
  count(*)                                                           as calls,
  max(a.created_at)                                                  as last_seen
from public.caller_authority_log a
left join public.locations l on l.id = a.ops_location_id
left join public.user_profiles up on up.id = a.caller_id
cross join w
where a.created_at >= w.since
  and a.caller_anonymous is false
  and a.reason = 'no_location_access'
group by 1, 2, 3, 4, 5
order by calls desc;


-- ============================================================================
-- 4. Is it quiet enough to enforce? (per venue, last 24 hours, report mode only)
-- ============================================================================
select
  coalesce(l.name, a.venue_name, a.location_id, '(no venue sent)')   as venue,
  count(*) filter (where a.channel in ('pos', 'kiosk', 'bar', 'tables', 'mpos'))  as till_or_kiosk_would_refuse,
  count(*) filter (where a.channel in ('online', 'qr'))                           as online_would_refuse,
  count(*)                                                                          as all_would_refuse
from public.caller_authority_log a
left join public.locations l on l.id = a.ops_location_id
where a.created_at >= now() - interval '24 hours'
  and a.outcome = 'would_refuse'
group by 1
order by all_would_refuse desc;
