-- 20260630c_courier_times.sql — capture the courier time flow (Ops DB). Additive + reversible.
-- Stuart gives us, per delivery: eta.pickup, eta.dropoff (we already store dropoff in `eta`),
-- picked_at (actual collection) and delivered_at (actual delivery). Store the rest so the POS
-- order card, the Deliveries board and the customer tracker can show expected-vs-actual times.

alter table courier_deliveries
  add column if not exists pickup_eta  timestamptz,   -- expected collection (Stuart eta.pickup)
  add column if not exists picked_at   timestamptz,   -- actual collection
  add column if not exists delivered_at timestamptz;  -- actual delivery

comment on column courier_deliveries.eta is 'Expected DROPOFF time (Stuart eta.dropoff). pickup_eta holds the expected collection. v5.5.680';

-- Rollback:
-- alter table courier_deliveries drop column if exists pickup_eta;
-- alter table courier_deliveries drop column if exists picked_at;
-- alter table courier_deliveries drop column if exists delivered_at;
