-- 20260915b_OPS_move_main_product_options_to_sizes.sql  (Ops, tbetcegmszzotrwdtqhi)
--
-- DATA ONLY. No tables or columns change. Safe to run twice (the second run finds nothing).
--
-- WHY (Peter, 15 Sep 2026): "you shouldnt be able to set modifers on the master product only on
-- the varients". Back Office's Flow tab "Add to flow" box saved options on the MAIN product of
-- an item with sizes (closed in v5.8.70), and options set before an item had sizes stayed on
-- the main product. 7 live items had them (Americano, Cappucino, Espresso and Latte at Provo,
-- Latte and Box Of 3 at Huddersfield, Cappucino at Location 2). Back Office hides them.
--
-- WHAT IT DOES, per main product (not archived) that has live sizes and options of its own:
--   1. every live size with NO modifier groups gets a copy of the main product's modifier groups
--   2. every live size with NO instruction groups gets a copy of the main product's
--   3. the main product's modifier and instruction groups are emptied
-- What the till, kiosk and online show does NOT change: a size with none of its own already
-- showed the main product's options (lib/menuRules.js rule 2). option_group_order stays on the
-- main product, which is where the till reads it.
--
-- AFTER RUNNING: refresh every open Back Office tab (an old tab could save the old options
-- back), then Push to POS.
--
-- The whole script runs as one transaction in the SQL editor (one query text), so it either all
-- applies or none of it does.

create temp table _main_options as
select p.id,
       coalesce(p.assigned_modifier_groups, '[]'::jsonb)   as mods,
       coalesce(p.assigned_instruction_groups, '[]'::jsonb) as inst
from menu_items p
where p.parent_id is null
  and p.archived is not true
  and exists (select 1 from menu_items c where c.parent_id = p.id and c.archived is not true)
  and (jsonb_array_length(coalesce(p.assigned_modifier_groups, '[]'::jsonb)) > 0
    or jsonb_array_length(coalesce(p.assigned_instruction_groups, '[]'::jsonb)) > 0);

-- 1. modifier groups onto sizes that have none
update menu_items c
set assigned_modifier_groups = m.mods, updated_at = now()
from _main_options m
where c.parent_id = m.id
  and c.archived is not true
  and jsonb_array_length(m.mods) > 0
  and jsonb_array_length(coalesce(c.assigned_modifier_groups, '[]'::jsonb)) = 0;

-- 2. instruction groups onto sizes that have none
update menu_items c
set assigned_instruction_groups = m.inst, updated_at = now()
from _main_options m
where c.parent_id = m.id
  and c.archived is not true
  and jsonb_array_length(m.inst) > 0
  and jsonb_array_length(coalesce(c.assigned_instruction_groups, '[]'::jsonb)) = 0;

-- 3. clear the main products
update menu_items p
set assigned_modifier_groups = '[]'::jsonb, assigned_instruction_groups = '[]'::jsonb, updated_at = now()
from _main_options m
where p.id = m.id;

-- VISIBLE RESULT (the SQL editor shows this last result): the items that were fixed, and how
-- many main products with sizes still carry options (must be 0).
select
  (select count(*) from _main_options) as main_products_fixed,
  (select string_agg(coalesce(l.name, '?') || ': ' || i.name, ', ' order by l.name, i.name)
     from _main_options m join menu_items i on i.id = m.id
     left join locations l on l.id::text = i.location_id::text) as items,
  (select count(*) from menu_items p
     where p.parent_id is null and p.archived is not true
       and exists (select 1 from menu_items c where c.parent_id = p.id and c.archived is not true)
       and (jsonb_array_length(coalesce(p.assigned_modifier_groups, '[]'::jsonb)) > 0
         or jsonb_array_length(coalesce(p.assigned_instruction_groups, '[]'::jsonb)) > 0)) as still_on_main_products;
