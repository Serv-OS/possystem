-- 20261204a_OPS_menu_placeholder_names_repair.sql  (Ops database tbetcegmszzotrwdtqhi)
--
-- Data repair, 19 Nov 2026 (Peter: "new items added to POS come up on KDS as new item").
-- "+ Item" in Back Office makes a product called "New item" and stamps that into its kitchen
-- and receipt names; renaming it only changed the menu name. 448 rows at 13 venues went to the
-- kitchen screen and onto customer receipts as "New item" (or "New item 2", "New size").
-- This sets those kitchen and receipt names to the product's name. Only rows whose kitchen or
-- receipt name is still the placeholder AND differs from the name are touched; a name someone
-- typed is never changed. Safe to run twice (the second run finds nothing).
--
-- The rows' old values are kept in menu_items_name_repair_20261204 so the rollback twin can put
-- them back. No DDL on menu_items, no trigger on it, nothing to deploy. Tills read the menu at
-- boot and on Push to POS, so reload Back Office and push, or let the tills restart.

set client_min_messages = warning;

create table if not exists public.menu_items_name_repair_20261204 (
  id text primary key,
  location_id text,
  kitchen_name text,
  receipt_name text,
  repaired_to text,          -- the product's name at the time, what the columns were set to
  taken_at timestamptz not null default now()
);
alter table public.menu_items_name_repair_20261204 enable row level security;
revoke all on public.menu_items_name_repair_20261204 from anon, authenticated;

insert into public.menu_items_name_repair_20261204 (id, location_id, kitchen_name, receipt_name, repaired_to)
select m.id, m.location_id, m.kitchen_name, m.receipt_name, m.name
from public.menu_items m
where (
    (m.kitchen_name ~* '^new (item|size)( \d+)?$' and m.kitchen_name is distinct from m.name)
    or (m.receipt_name ~* '^new (item|size)( \d+)?$' and m.receipt_name is distinct from m.name)
  )
  and coalesce(m.name, '') <> ''
  and not (m.name ~* '^new (item|size)( \d+)?$')
on conflict (id) do nothing;

update public.menu_items m
set kitchen_name = case
      when m.kitchen_name ~* '^new (item|size)( \d+)?$' and m.kitchen_name is distinct from m.name then m.name
      else m.kitchen_name end,
    receipt_name = case
      when m.receipt_name ~* '^new (item|size)( \d+)?$' and m.receipt_name is distinct from m.name then m.name
      else m.receipt_name end
where (
    (m.kitchen_name ~* '^new (item|size)( \d+)?$' and m.kitchen_name is distinct from m.name)
    or (m.receipt_name ~* '^new (item|size)( \d+)?$' and m.receipt_name is distinct from m.name)
  )
  and coalesce(m.name, '') <> ''
  and not (m.name ~* '^new (item|size)( \d+)?$');

-- What it did (the SQL editor shows this as the result).
select count(*) as rows_repaired_total,
       count(*) filter (where taken_at > now() - interval '5 minutes') as rows_repaired_this_run
from public.menu_items_name_repair_20261204;
