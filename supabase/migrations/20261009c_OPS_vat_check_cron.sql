-- 20261009c_OPS_vat_check_cron.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Adds 1 small table and 1 pg_cron job. Touches no existing table and no   #
-- #  existing row. Safe any time, service included. Takes under a second.     #
-- ############################################################################
--
-- WHY (8 Oct 2026, the VAT audit; Peter: "VAT despite the order type should follow the Tax
-- rules set on the back office per menu item", "Fix once and right")
--   Preston QR-4OGI7 (8 Oct, 4.85) was booked with no VAT and every report read it as 0 and said
--   nothing; Leeds 30 Sep was never posted to Xero and nothing noticed. Every channel now books
--   the VAT the Back Office item rules say, and the reports read it one way. This file adds the
--   morning after: a daily check that reads yesterday's sales at every venue with tax rates,
--   works each sale's VAT out again from its lines with the till's rule, and TELLS ServOS what it
--   found. It changes nothing in the sales.
--
-- WHAT THIS FILE DOES
--   public.vat_check_runs   one row per venue per business day: how many sales, how many booked
--                           what their items give, how many a penny off (half pennies), how many
--                           with no VAT, how many that differ, how many with no record of the
--                           rate, and the named sales in details. Written by the vat-check edge
--                           function (service role). A Back Office login reads its own venues'
--                           rows; nobody writes through the API.
--   cron job vat-check-daily  05:30 UTC every day: call_edge_fn('vat-check', {"action":"daily"})
--                           through the pg_cron -> pg_net -> edge function bridge of
--                           20260805b_edge_cron_bridge.sql (public.call_edge_fn, live since
--                           7 Aug 2026). At 05:30 UTC every UK venue's 06:30 business day has
--                           ended; the function works each venue's own last completed day out
--                           from its clock, so a US venue is checked for its own yesterday too.
--
-- WHAT THE FUNCTION WRITES BESIDE THIS TABLE
--   When a sale was booked with no VAT, or with a figure its items do not give, one plain
--   message to the venue in public.venue_messages (20261005a), which pops up in Back Office and
--   Company Admin lists. Written once per venue and day (broadcast_id is worked out from them).
--
-- ORDER OF OPERATIONS
--   1. Deploy the function FIRST (edge functions are not deployed by pushing a file):
--        npx supabase functions deploy vat-check --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
--      A schedule pointing at a function that is not there logs a 404 every morning and checks
--      nothing. The function also answers before this file runs (it says the run row could not
--      be written and still returns what it found), so it can be tried by hand first:
--        POST /functions/v1/vat-check { "action": "venue", "locationId": "<ops id>", "date": "2026-10-07" }
--      with a Back Office super admin token or the service key.
--   2. Apply this file.
--
-- Rollback: 20261009c_OPS_vat_check_cron_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This file is for the OPS database (tbetcegmszzotrwdtqhi). This is not it. Nothing was changed.';
  end if;
  if to_regclass('public.closed_checks') is null or to_regclass('public.tax_rates') is null then
    raise exception 'closed_checks or tax_rates is missing. This is not the database this file was written for. Nothing was changed.';
  end if;
  if to_regprocedure('public.user_accessible_locations()') is null then
    raise exception 'The fence helper user_accessible_locations() is missing. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

create table if not exists public.vat_check_runs (
  id               uuid primary key default gen_random_uuid(),
  location_id      uuid not null references public.locations(id) on delete cascade,
  business_day     date not null,
  ran_at           timestamptz not null default now(),
  sales            integer not null default 0,
  ok_count         integer not null default 0,
  penny_count      integer not null default 0,
  no_vat           integer not null default 0,
  differs          integer not null default 0,
  no_record        integer not null default 0,
  not_checked      integer not null default 0,
  fallbacks        integer not null default 0,
  foreign_rate     integer not null default 0,
  repaired         integer not null default 0,
  server_booked    integer not null default 0,
  profiles_in_use  boolean not null default false,
  details          jsonb not null default '{}'::jsonb,
  message_id       uuid,
  constraint vat_check_runs_once_per_day unique (location_id, business_day)
);

comment on table public.vat_check_runs is
  'The daily VAT check (8 Oct 2026): one row per venue per business day, written by the vat-check edge function. Counts of sales booked as their items give, a penny off, with no VAT, differing, with no record of the rate; the named sales in details. Reads only; nothing in the sales is changed. supabase/functions/_shared/vatCheck.js.';

create index if not exists vat_check_runs_location_day_idx on public.vat_check_runs (location_id, business_day desc);

-- ── Row level security, written out ─────────────────────────────────────────
alter table public.vat_check_runs enable row level security;

revoke all on table public.vat_check_runs from public, anon, authenticated;
grant select on table public.vat_check_runs to authenticated;
grant all on table public.vat_check_runs to service_role;

-- A Back Office login reads its own venues' rows (user_accessible_locations(), the helper the
-- venue messages read with). A paired till, kiosk or screen is an anonymous session: nothing.
-- Nobody inserts, updates or deletes through the API: no policy, no grant. The function writes
-- with the service role.
drop policy if exists vat_check_runs_read on public.vat_check_runs;
create policy vat_check_runs_read on public.vat_check_runs
  for select to authenticated
  using (
    (to_regprocedure('public.is_anon_session()') is null or not public.is_anon_session())
    and location_id::text in (select k from public.user_accessible_locations() as k)
  );

-- ── The schedule ────────────────────────────────────────────────────────────
-- The bridge from 20260805b. Fail here, where it is visible, on a database without it.
do $precheck$
begin
  if to_regprocedure('public.call_edge_fn(text, jsonb)') is null then
    raise exception 'public.call_edge_fn(text, jsonb) is missing. Apply 20260805b_edge_cron_bridge.sql first. The table above was not made either (one transaction).';
  end if;
end
$precheck$;

-- Same idiom as 20260805b and 20260909: unschedule then schedule, so running the file again is a
-- no op, and a warning rather than an error where pg_cron is not installed.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed on this database. vat-check-daily was NOT scheduled.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'vat-check-daily') then
    perform cron.unschedule('vat-check-daily');
  end if;
  perform cron.schedule('vat-check-daily', '30 5 * * *', $q$select public.call_edge_fn('vat-check', '{"action":"daily"}'::jsonb)$q$);
end;
$$;

-- ---------------------------------------------------------------------------
-- Verify after applying
-- ---------------------------------------------------------------------------
--   select jobname, schedule, active from cron.job where jobname = 'vat-check-daily';
--
--   -- the next morning after 05:30 UTC:
--   select l.name, r.business_day, r.sales, r.ok_count, r.penny_count, r.no_vat, r.differs, r.no_record, r.ran_at
--     from public.vat_check_runs r join public.locations l on l.id = r.location_id
--    order by r.ran_at desc limit 20;
--
--   -- the HTTP side (the body is the report):
--   select id, status_code, left(content, 400) from net._http_response order by id desc limit 3;
--
-- A clean morning at a venue looks like: sales 170, ok_count 160, penny_count 10, no_vat 0,
-- differs 0, no_record 0, and no message. Pennies are the half penny sales of 1 to 8 Oct (the
-- till of those days stored the float rounded down); they are counted, never alarmed.
--
-- To pause it without deleting the schedule:
--   select cron.alter_job((select jobid from cron.job where jobname = 'vat-check-daily'), active := false);
