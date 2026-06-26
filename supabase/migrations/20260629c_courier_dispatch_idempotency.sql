-- 20260629c_courier_dispatch_idempotency.sql — DB-enforced one-courier-per-order.
-- The dispatcher reserves an order_ref by inserting its courier_deliveries row BEFORE calling
-- Uber/HubRise (reserve-then-act). This unique index makes that claim atomic across the device
-- path + the fire-time cron + retries, so a courier can never be double-booked. Additive +
-- reversible.

create unique index if not exists courier_deliveries_order_ref_uidx
  on courier_deliveries (location_id, order_ref)
  where order_ref is not null;

-- Rollback:
-- drop index if exists courier_deliveries_order_ref_uidx;
