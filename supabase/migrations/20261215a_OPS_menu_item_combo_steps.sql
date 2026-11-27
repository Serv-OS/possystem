-- 20261215a_OPS_menu_item_combo_steps.sql  (Ops database tbetcegmszzotrwdtqhi)
--
-- OPS project ONLY. Peter runs this by hand in the SQL editor, BEFORE release 5.12.123.
-- Safe to run twice. Additive only: one new column on menu_items, empty on every row.
--
-- WHAT THIS IS
-- Combo products, stage 1 (Peter, 27 Nov 2026, Mozz, the catering "Build Your Own Package"):
-- "composite product - Step 1 - name = Pic a product add the products for this step set rules
-- around it like you can anyway with modifers same logic etc. But we would need to say - keeps
-- price or is part of set price".
--
-- A product of type 'combo' can now hold ordered STEPS. They live in ONE new column:
--
--   menu_items.combo  jsonb, null on every row until somebody builds a Combo
--     { "v": 1,
--       "steps": [ { "id": "st-...", "name": "Pick 5 pizzas",
--                    "selectionType": "quantity",      -- single | multiple | multiple_once | quantity
--                    "min": 5, "max": 5,
--                    "pricing": "set",                 -- set = part of the set price, own = keeps its price
--                    "products": [ { "itemId": "<menu_items.id>", "bump": 0 } ] } ] }
--
-- The Combo's own price (pricing.base and the order type prices) is the set price. The app
-- reads and writes the column through src/lib/combo.js; the rules are in that one file.
--
-- WHY A COLUMN, AND NOT INSIDE visibility OR pricing
-- Those two travel through every screen, the Multi site menu and the delivery catalogue, and
-- each has its own meaning. Steps are a new thing with their own shape, so they get their own
-- column, which nothing else reads.
--
-- WHAT DOES NOT CHANGE
--   * No existing row, column, policy, grant, trigger or function is touched. menu_items row
--     level security already covers the new column (it is read and written with the row).
--   * A product of type 'combo' with no steps (the column null) is exactly the product it was.
--   * The Multi site menu never writes this column: msm_apply_site names every column it inserts
--     or updates, and combo is not one of them, so a publish leaves a site's own Combo alone.
--   * Sharing a product to other venues never copies it (src/lib/shareCopy.js NEVER_FIELDS).
--
-- THE APP WORKS BEFORE THIS FILE RUNS
-- Release 5.12.123 reads the column only when the row carries it. Until this has run, no row
-- does: every Combo behaves as it does today, the Steps tab says "Steps need one database
-- update that has not been run yet", and no save ever names the column. Nothing breaks if the
-- code lands first; steps simply cannot be saved until this is run.
--
-- THE CHECK IS LOOSE ON PURPOSE
-- The app keeps the shape right (combo.js normaliseStep). The database only refuses a value
-- that is not an object holding a list of steps, so a typo in the SQL editor cannot put a bare
-- string or a number where every screen expects steps.

-- Never sit behind a long running lock on a live venue.
set lock_timeout = '3s';
set client_min_messages = warning;

-- Fail fast in the wrong database rather than creating a stray column there.
do $$
begin
  if to_regclass('public.menu_items') is null then
    raise exception 'wrong database: public.menu_items is missing. This file is for the OPS project (tbetcegmszzotrwdtqhi).';
  end if;
end $$;

begin;

alter table public.menu_items add column if not exists combo jsonb;

comment on column public.menu_items.combo is
  'Steps of a Combo product (type = combo), 5.12.123: { v, steps: [{ id, name, selectionType, min, max, pricing: set|own, products: [{ itemId, bump }] }] }. Null = no steps: the product behaves as it always did. Read and written only through src/lib/combo.js. Never written by a Multi site menu publish.';

-- Dropped and re-added so a second run repairs a half applied file. NOT VALID then VALIDATE:
-- the add takes its lock for an instant, and the check of the existing rows (all null) does
-- not block the tills.
-- coalesce: a missing "steps" key is a SQL null, and a check that works out to null PASSES, so
-- without it { "v": 1 } was let in (found on the local rehearsal, supabase/tests/combo_steps).
alter table public.menu_items drop constraint if exists menu_items_combo_shape_check;
alter table public.menu_items add constraint menu_items_combo_shape_check
  check (combo is null or (jsonb_typeof(combo) = 'object' and coalesce(jsonb_typeof(combo -> 'steps'), '') = 'array')) not valid;
alter table public.menu_items validate constraint menu_items_combo_shape_check;

commit;

-- A new column is invisible to the API until it reloads its schema, so without this the app
-- keeps being told the column does not exist.
notify pgrst, 'reload schema';

-- Check 1: one row, combo | jsonb | YES.
select column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'menu_items' and column_name = 'combo';

-- Check 2: one row, 0 | 0  (no product has steps yet, and no Combo was changed).
select count(*) filter (where combo is not null) as products_with_steps,
       count(*) filter (where combo is not null and type is distinct from 'combo') as steps_on_a_non_combo
from public.menu_items;
