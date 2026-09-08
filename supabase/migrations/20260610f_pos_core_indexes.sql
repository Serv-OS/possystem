-- ============================================================================
-- Scale pass 2 — composite indexes for the hot POS-core query paths used on
-- every device boot and realtime backfill. These match the exact filters in
-- QueueSync (order_queue, bar_tabs by location+status), the KDS history range,
-- and the device-heartbeat master poll. closed_checks already has
-- (location_id, closed_at desc).
-- ============================================================================

create index if not exists idx_order_queue_loc_status on order_queue (location_id, status);
create index if not exists idx_bar_tabs_loc_status on bar_tabs (location_id, status);
create index if not exists idx_kds_tickets_loc_sent on kds_tickets (location_id, sent_at desc);
create index if not exists idx_device_hb_loc_role on device_heartbeats (location_id, role);
create index if not exists idx_active_sessions_loc on active_sessions (location_id);
