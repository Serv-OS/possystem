-- 20260624c_scale_indexes.sql
-- Concurrency/scale audit — Tier 0: cheap, additive, zero behaviour change.
-- Apply each statement INDIVIDUALLY (CONCURRENTLY cannot run inside a transaction block) so the
-- live order_queue table is never locked during the build.

-- 1) Catering release was a SEQ SCAN. The master "release due catering" tick AND the catering-release
--    cron scan order_queue for due catering on every run; with thousands of parked future bookings
--    that scan grows unbounded. This partial index makes it a tight range scan forever.
create index concurrently if not exists idx_order_queue_catering_due
  on public.order_queue (location_id, sent_at)
  where source = 'catering' and kitchen_routed_at is null;

-- 2) ops_devices RLS helper (ops_can_write) filters `device_uid = auth.uid()` per row → seq scan
--    on every fenced read by a paired ops tablet. Mirror the index waitlist_devices already has.
create index concurrently if not exists ops_devices_uid_idx on public.ops_devices (device_uid);

-- 3) Write-amplification: order_queue carries TWO byte-identical (location_id, status) indexes plus a
--    redundant location-only index (the composite's leading column already serves location-only
--    lookups). Every insert/update on the busiest table maintained all three. Drop the duplicates;
--    idx_order_queue_loc_status remains to serve both (location_id) and (location_id, status) queries.
drop index concurrently if exists idx_order_queue_status;     -- duplicate of idx_order_queue_loc_status
drop index concurrently if exists idx_order_queue_location;   -- redundant; covered by the composite
