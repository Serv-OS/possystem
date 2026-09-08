-- 20260822_saas_plans.sql — OPS database, hand-applied.
-- SaaS plans per venue (v5.7.4): two purely additive columns on
-- public.subscriptions so the admin portal can record extra paid devices and
-- the HubRise add-on per venue. Plan pricing itself lives in the payments-admin
-- edge function catalog, not in the database. No constraint on plan on purpose:
-- the operator picks the plan manually and the bands are advisory.
--
--   extra_devices  integer  — devices paid for BEYOND the plan allowance
--   hubrise        boolean  — the HubRise add-on flag
--
-- Nothing else. Never touches stripe_*, gmv_*, plan or monthly_fee.

begin;

alter table public.subscriptions
  add column if not exists extra_devices integer not null default 0;

alter table public.subscriptions
  add column if not exists hubrise boolean not null default false;

-- One subscription row per venue. Live data verified unique before adding
-- (6 rows, one per location). Lets the save path treat a concurrent
-- first-save race as a clean conflict instead of creating duplicates.
create unique index if not exists subscriptions_location_id_uniq
  on public.subscriptions (location_id);

commit;
