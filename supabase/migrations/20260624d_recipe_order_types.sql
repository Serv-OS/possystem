-- 20260624d_recipe_order_types.sql
-- Per-order-type recipe lines.
--
-- A recipe line can now be scoped to specific order types. Semantics:
--   order_types IS NULL  (or [])  → the line applies to ALL order types (the shared base recipe).
--   order_types = ["takeaway","collection","delivery"] → the line applies ONLY to those types.
--
-- This lets a dish's food cost / GP — and its stock depletion — differ by order type. The motivating
-- case: a latte sold dine-in goes in a reusable washable mug (no packaging cost), but takeaway /
-- collection / delivery go in a disposable cup that must be costed and depleted from stock. The cup
-- is one recipe line tagged {takeaway,collection,delivery}; the espresso + milk lines stay untagged
-- (all types). Canonical order-type values match closed_checks.order_type: dine-in, takeaway,
-- collection, delivery.
--
-- Additive + backward-compatible: existing lines have order_types NULL → apply to all types → no
-- change to any current cost/GP/depletion. Safe to re-run (IF NOT EXISTS).

alter table public.recipe_lines
  add column if not exists order_types jsonb;

comment on column public.recipe_lines.order_types is
  'Order types this line applies to (jsonb array of dine-in|takeaway|collection|delivery). NULL/[] = all order types (shared base recipe).';
