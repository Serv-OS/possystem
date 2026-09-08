-- v5.5.575 — Stock: named "units you use" defaults.
-- item_packaging_formats already holds per-item packs (name + qty_in_base + nesting).
-- These flags mark which pack staff COUNT in and which you BUY in by default, so the
-- screens pre-pick the friendly unit. Additive.
alter table item_packaging_formats
  add column if not exists is_count_default    boolean not null default false,
  add column if not exists is_purchase_default boolean not null default false;
