-- 20260630_stuart_per_location.sql — Stuart courier, PER-LOCATION accounts (Ops DB)
--
-- Two changes, additive + reversible:
--   1) Allow 'stuart' as a dispatch_backend (the original CHECK only permitted
--      'uber_api'/'hubrise_bridge', so saving a Stuart config failed a constraint).
--   2) Add per-location Stuart API credentials. Each venue connects its OWN Stuart
--      account (one Stuart account per location, not one platform account for the
--      whole system), entered/connected from Back Office → Channels → Delivery.
--
-- Secret posture: venue_uber_config is SERVICE-ROLE ONLY (RLS enabled, no policies), so
-- the browser can never read these columns. The uber-direct edge fn writes them
-- (set_stuart_creds) and NEVER returns the secret to the client (it returns only a
-- boolean `stuart_connected`). Same pattern as hubrise_connections.access_token.

-- 1) Permit the Stuart backend.
alter table venue_uber_config drop constraint if exists venue_uber_config_dispatch_backend_check;
alter table venue_uber_config add constraint venue_uber_config_dispatch_backend_check
  check (dispatch_backend in ('uber_api','hubrise_bridge','stuart'));

-- 2) Per-location Stuart credentials (write-only via the edge fn).
alter table venue_uber_config
  add column if not exists stuart_client_id     text,
  add column if not exists stuart_client_secret text;

comment on column venue_uber_config.stuart_client_secret is
  'Per-location Stuart API client secret. SERVICE-ROLE ONLY; never returned to the browser by the uber-direct edge fn (get_config returns only stuart_connected). v5.5.669';

-- Rollback:
-- alter table venue_uber_config drop column if exists stuart_client_id;
-- alter table venue_uber_config drop column if exists stuart_client_secret;
-- alter table venue_uber_config drop constraint if exists venue_uber_config_dispatch_backend_check;
-- alter table venue_uber_config add constraint venue_uber_config_dispatch_backend_check
--   check (dispatch_backend in ('uber_api','hubrise_bridge'));
