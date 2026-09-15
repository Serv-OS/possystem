-- 20260915d_OPS_categories_on_no_menu.sql  (Ops, tbetcegmszzotrwdtqhi)
--
-- DATA ONLY. Safe to run twice (the second run finds nothing to fix).
--
-- WHY (Peter, 15 Sep 2026, Coffee Boy Barnsley): sharing categories to a venue that had no menu
-- left them on NO menu (menu_id empty, no link). Back Office then listed them under every menu
-- ("if I add a test menu the category shows up for both"), while tills with a menu picked never
-- showed them. v5.8.73 stops both (sharing creates the venue's menu; Back Office uses the tills'
-- rule). This fixes the categories already left on no menu:
--   1. a top level category on no menu that is LINKED to a menu at its venue makes that menu its
--      home (Barnsley: Coffee, linked to CB Barnsley)
--   2. otherwise, if its venue has exactly ONE menu, that menu becomes its home
--   3. sub categories on no menu take their parent's menu (Hot Coffee, Iced Coffee)
-- A category at a venue with several menus and no link is left alone and listed below, so
-- someone can choose (Back Office now shows it as "not on any menu").

-- 1 and 2. Top level categories.
update public.menu_categories c
set menu_id = pick.menu_id, updated_at = now()
from (
  select c2.id,
         coalesce(
           (select k.menu_id
              from public.menu_category_links k
              join public.menus m on m.id = k.menu_id and m.location_id::text = c2.location_id::text
             where k.category_id = c2.id
             order by k.sort_order nulls last, k.menu_id
             limit 1),
           (select min(m.id) from public.menus m where m.location_id::text = c2.location_id::text
             having count(*) = 1)
         ) as menu_id
    from public.menu_categories c2
   where c2.menu_id is null
     and c2.parent_id is null
     and coalesce(c2.is_special, false) = false
) pick
where c.id = pick.id
  and pick.menu_id is not null;

-- 3. Sub categories take their parent's menu (twice, for a second level of nesting).
update public.menu_categories c
set menu_id = p.menu_id, updated_at = now()
from public.menu_categories p
where c.parent_id = p.id and c.menu_id is null and p.menu_id is not null;

update public.menu_categories c
set menu_id = p.menu_id, updated_at = now()
from public.menu_categories p
where c.parent_id = p.id and c.menu_id is null and p.menu_id is not null;

-- VISIBLE RESULT (the SQL editor shows this last result).
select
  (select string_agg(l.name || ': ' || c.label || ' on ' || coalesce(m.name, '?'), ', ' order by l.name, c.label)
     from public.menu_categories c
     join public.locations l on l.id::text = c.location_id::text
     left join public.menus m on m.id = c.menu_id
    where l.name ilike '%barnsley%') as barnsley_categories,
  (select coalesce(string_agg(l.name || ': ' || c.label, ', ' order by l.name, c.label), 'none')
     from public.menu_categories c
     join public.locations l on l.id::text = c.location_id::text
    where c.menu_id is null and c.parent_id is null and coalesce(c.is_special, false) = false
      and not exists (select 1 from public.menu_category_links k where k.category_id = c.id)) as still_on_no_menu;
