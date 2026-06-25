-- 20260629b_delivery_mode.sql — delivery fulfilment mode (self vs Uber Direct courier).
-- Additive + reversible. Default 'self' = the order just fires to the POS/kitchen and the
-- venue delivers it themselves (no courier dispatch, no Uber/HubRise needed). 'uber' = get a
-- live/configured fee + dispatch a courier (via dispatch_backend: uber_api | hubrise_bridge).
-- flat_fee_minor is the venue's own delivery charge used when there's no live quote
-- (self-delivery, or the HubRise-Bridge path where the Bridge can't quote pre-order).

alter table venue_uber_config
  add column if not exists delivery_mode  text not null default 'self'
    check (delivery_mode in ('self','uber')),
  add column if not exists flat_fee_minor integer;

comment on column venue_uber_config.delivery_mode is
  'self = fires to POS, venue delivers (no courier); uber = quote + dispatch a courier. v5.5.652';

-- Rollback:
-- alter table venue_uber_config drop column if exists delivery_mode;
-- alter table venue_uber_config drop column if exists flat_fee_minor;
