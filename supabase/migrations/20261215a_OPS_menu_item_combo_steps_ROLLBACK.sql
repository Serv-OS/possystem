-- 20261215a_OPS_menu_item_combo_steps_ROLLBACK.sql  (Ops database tbetcegmszzotrwdtqhi)
--
-- Undoes 20261215a: drops menu_items.combo and its check.
--
-- THE STEPS ARE KEPT, NOT LOST. Every Combo's steps are copied first into
-- public.menu_items_combo_keep_20261215 (id, location_id, name, combo, kept_at), so running
-- 20261215a again and the UPDATE at the bottom of this file puts them back exactly.
--
-- WHAT HAPPENS TO THE APP
-- Release 5.12.123 keeps working without the column, as it did before the file was run: every
-- Combo sells as a plain product at its price again (no steps, no picks), and the Steps tab
-- says the database update is needed. So take every Combo with steps OFF SALE (86 it, or
-- archive it) before running this, or it will be sold for its set price with nothing in it.
-- The first check below lists them.

set lock_timeout = '3s';
set client_min_messages = warning;

-- Check 0 (read this before going on): the Combos that have steps today.
do $$
declare n integer := 0;
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'menu_items' and column_name = 'combo') then
    execute 'select count(*) from public.menu_items where combo is not null' into n;
  end if;
  raise notice '% product(s) hold Combo steps. They are copied to menu_items_combo_keep_20261215 before the column is dropped.', n;
end $$;

begin;

create table if not exists public.menu_items_combo_keep_20261215 (
  id text not null,
  location_id text,
  name text,
  combo jsonb not null,
  kept_at timestamptz not null default now(),
  primary key (id)
);
-- A plain keep table: nobody but the database owner reads it.
alter table public.menu_items_combo_keep_20261215 enable row level security;
revoke all on public.menu_items_combo_keep_20261215 from public, anon, authenticated;

do $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'menu_items' and column_name = 'combo') then
    execute $q$
      insert into public.menu_items_combo_keep_20261215 (id, location_id, name, combo)
      select m.id::text, m.location_id::text, coalesce(m.menu_name, m.name), m.combo
      from public.menu_items m
      where m.combo is not null
      on conflict (id) do update set combo = excluded.combo, name = excluded.name, location_id = excluded.location_id, kept_at = now()
    $q$;
  end if;
end $$;

alter table public.menu_items drop constraint if exists menu_items_combo_shape_check;
alter table public.menu_items drop column if exists combo;

commit;

notify pgrst, 'reload schema';

-- Check 1: no rows (the column is gone).
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'menu_items' and column_name = 'combo';

-- Check 2: the steps that were kept (one row per Combo that had steps).
select id, location_id, name, jsonb_array_length(combo -> 'steps') as steps, kept_at
from public.menu_items_combo_keep_20261215
order by location_id, name;

-- TO PUT THE STEPS BACK LATER: run 20261215a again, then
--   update public.menu_items m set combo = k.combo
--   from public.menu_items_combo_keep_20261215 k
--   where m.id::text = k.id and m.combo is null;
--   drop table public.menu_items_combo_keep_20261215;
