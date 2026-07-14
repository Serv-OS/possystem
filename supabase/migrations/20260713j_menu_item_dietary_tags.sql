-- 20260713j_menu_item_dietary_tags.sql
--
-- Dietary tags for menu items (Vegetarian / Vegan / Gluten-free / Dairy-free …).
-- Until now `tags` existed only in the in-memory store shape and mock data — it was
-- never a real column, so the digital menu board AND the new print menu both read
-- `it.tags` and always got nothing (dietary badges never rendered in production).
--
-- This makes dietary a first-class, persisted field. Additive + reversible:
-- existing rows default to an empty array (no dietary claims), so nothing changes
-- for current items until an operator ticks a diet in Back office → Menu.

alter table public.menu_items
  add column if not exists tags jsonb not null default '[]'::jsonb;
