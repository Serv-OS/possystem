-- v5.5.561 — per-terminal "Order notifications" toggle.
-- When false, terminals on this profile stay silent for incoming orders (no chime,
-- no new-order popup) but still print and route as normal. Defaults true so every
-- existing terminal keeps its current behaviour.
alter table device_profiles
  add column if not exists order_notifications boolean not null default true;
