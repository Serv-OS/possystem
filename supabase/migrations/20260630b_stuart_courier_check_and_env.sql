-- 20260630b_stuart_courier_check_and_env.sql — make Stuart actually dispatchable (Ops DB)
--
-- Two fixes found by adversarial review of v5.5.670:
--   1) courier_deliveries.dispatch_backend CHECK still only allowed ('uber_api','hubrise_bridge')
--      — the 20260630 migration widened the constraint on venue_uber_config but NOT on
--      courier_deliveries. So the reserve-then-act INSERT for a Stuart venue failed the CHECK and
--      the dispatch SILENTLY no-op'd (reported success, no courier booked). Widen it here.
--   2) Stuart shared the single `env` column with the (now retired) Uber paths; give Stuart its
--      own `stuart_env` so changing one can't repoint the other at the wrong host/account.
-- Additive + reversible.

-- 1) Permit the Stuart backend on dispatched deliveries.
alter table courier_deliveries drop constraint if exists courier_deliveries_dispatch_backend_check;
alter table courier_deliveries add constraint courier_deliveries_dispatch_backend_check
  check (dispatch_backend in ('uber_api','hubrise_bridge','stuart'));

-- 2) Dedicated Stuart environment (sandbox|prod). Null → fall back to `env` then the platform default.
alter table venue_uber_config
  add column if not exists stuart_env text;

comment on column venue_uber_config.stuart_env is
  'Stuart account environment (sandbox|prod) for THIS venue, independent of the legacy Uber `env`. v5.5.671';

-- Rollback:
-- alter table venue_uber_config drop column if exists stuart_env;
-- alter table courier_deliveries drop constraint if exists courier_deliveries_dispatch_backend_check;
-- alter table courier_deliveries add constraint courier_deliveries_dispatch_backend_check
--   check (dispatch_backend in ('uber_api','hubrise_bridge'));
