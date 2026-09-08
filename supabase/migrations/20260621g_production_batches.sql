-- v5.5.566 — Stock & Production: production batches (make-here replenishment)
--
-- A batch produces a MADE inventory_item from its PREP recipe. On completion the
-- batch posts to the stock ledger:
--   PRODUCTION_CONSUME (−) for each recipe component, at the component's cost
--   PRODUCTION_OUTPUT  (+) for the made item, valued at consumed cost ÷ actual yield
-- so raws deplete, the made item is replenished, and yield variance (planned vs
-- actual) is visible. The movement detail lives in stock_movements (source_id =
-- batch id); this table holds the batch summary + traceability (lot, expiry).
-- Additive; movements are posted via the existing post_stock_movement RPC.

create table if not exists production_batches (
  id               uuid primary key default gen_random_uuid(),
  location_id      uuid not null,
  recipe_id        uuid references recipes(id) on delete set null,
  output_item_id   uuid references inventory_items(id) on delete set null,
  output_name      text,                          -- snapshot for history if item/recipe later removed
  planned_qty      numeric(14,4),
  actual_qty       numeric(14,4),
  output_unit      text not null default 'each',
  status           text not null default 'DRAFT' check (status in ('DRAFT','COMPLETED','CANCELLED')),
  theoretical_cost numeric(14,4),                 -- cost to make the planned/actual yield
  actual_cost      numeric(14,4),                 -- sum of components actually consumed
  output_unit_cost numeric(12,5),                 -- actual_cost ÷ output base qty
  lot_code         text,
  expiry_at        timestamptz,
  produced_at      timestamptz,
  produced_by      uuid,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists production_batches_loc_idx on production_batches(location_id, created_at desc);
create index if not exists production_batches_output_idx on production_batches(output_item_id);

alter table production_batches enable row level security;
drop policy if exists production_batches_rls on production_batches;
create policy production_batches_rls on production_batches
  for all
  using (location_id in (select location_id from user_accessible_locations()))
  with check (location_id in (select location_id from user_accessible_locations()));
