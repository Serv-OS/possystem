-- 20260928b_OPS_hot_pizzas_copy_categories.sql   (Ops DB tbetcegmszzotrwdtqhi)
--
-- NOT RUN. DECIDE FIRST (see below). Do not run during UK service hours.
--
-- WHAT: puts the 24 Coffee Boy pizza copies that show "No category" back into their own venue's
-- Hot Pizzas, with Food as "also in", exactly like Huddersfield's copies. Nothing is archived,
-- nothing else changes.
--   Train Station, Leeds, Preston, Headingly: 6 copies each of Calabrese, Margherita, Pepperoni,
--   Pollo Piccante, Roasted Vegetable and The Texan Pizza (masters at Coffee Boy Barnsley).
--
-- WHAT HAPPENED (read only queries and API logs, 28 Sep 2026; all times UTC, 27 Sep):
--   18:00:00-03  the share from Barnsley made Hot Pizzas at all five venues (Train Station's copy
--                sits under its own Food, id with no suffix: correct, Train Station owns Food)
--   18:00:07-27  it made the 30 pizza copies, every one AFTER its venue's Hot Pizzas existed.
--                The share put every copy in Hot Pizzas; there was no race.
--   18:08:58     the same Back Office login (an owner) switched to Train Station, and wrote each
--                of the 6 copies twice with no category (old whole row save, v5.9.97)
--   18:09:46     the same at Leeds, 18:11:10 Preston, 18:12:03 Headingly (48 writes in all, from
--                that one browser; nothing else wrote menu items between 18:00:28 and 18:24:04)
--   18:14:29     it switched to Huddersfield and did NOT do this there; Huddersfield kept Hot Pizzas
--   So "No category" at four venues looks like someone taking the pizzas off those menus by
--   hand. ASK THEM BEFORE RUNNING THIS: running it puts the pizzas back on four venues' menus.
--
-- AFTER RUNNING: the pizzas show straight away wherever a surface reads the database (online
-- ordering, kiosks, menu boards that list Hot Pizzas), and on the tills after Push to POS at
-- each of the four venues. If the copies are to be archived instead, do that in Back Office and
-- do not run this.
--
-- SAFE TO RUN AGAIN: it only fills copies that still have no category, and STEP 2 is all or
-- nothing (a copy it cannot match stops it and nothing changes). No schema change, no transaction
-- wrapper (the SQL editor chokes on begin/commit). No trigger on menu_items.
-- UNDO: 20260928b_OPS_hot_pizzas_copy_categories_ROLLBACK.sql
--
-- HOW: run STEP 1 on its own: 24 rows, every result "will be set". Run STEP 2. Run STEP 3: five
-- venues, 6 copies each, no_category 0, in_hot_pizzas 6.


-- ───────────────────────── STEP 1: READ ONLY, run first ─────────────────────────
-- Each copy with no category, and what it will get: the same category at ITS venue, found by
-- master id plus the venue suffix (the bare id at the venue that owns it), else by the one
-- category there with the same name.
with six(master_id) as (
  values ('m-1790477109738'), ('m-1790477141210'), ('m-1790477180152'),
         ('m-1790477204214'), ('m-1790477233374'), ('m-1790477258966')
),
copies as (   -- copies of the six pizzas that have NO category and are not archived
  select c.id as copy_id, c.location_id, c.cats as copy_cats, m.name, m.cat as master_cat, m.cats as master_cats
  from menu_items c
  join six s on s.master_id = c.master_id
  join menu_items m on m.id = c.master_id
  where c.id <> c.master_id and c.cat is null and coalesce(c.archived, false) = false
),
wanted as (   -- each category of the Barnsley pizza (ord 0 = its category, 1.. = its "also in")
  select c.copy_id, c.location_id, c.master_cat as src, 0::bigint as ord from copies c where c.master_cat is not null
  union all
  select c.copy_id, c.location_id, u.src, u.ord from copies c, unnest(c.master_cats) with ordinality as u(src, ord)
),
matched as (  -- that category at the copy's venue: master id + venue suffix (the bare id where the
              -- venue owns it), else the ONE category there with the same name
  select w.copy_id, w.ord,
    (select pc.id from menu_categories mc
       join menu_categories cm on cm.id = coalesce(mc.master_id, mc.id)
       join menu_categories pc on pc.location_id = w.location_id
        and pc.id = case when cm.location_id = w.location_id then cm.id else cm.id || '_' || right(w.location_id, 8) end
      where mc.id = w.src) as by_id,
    (select min(pc.id) from menu_categories mc
       join menu_categories cm on cm.id = coalesce(mc.master_id, mc.id)
       join menu_categories pc on pc.location_id = w.location_id and lower(btrim(pc.label)) = lower(btrim(cm.label))
      where mc.id = w.src
      having count(*) = 1) as by_name
  from wanted w
),
plan as (
  select c.copy_id, c.location_id, c.name, c.copy_cats,
    (select coalesce(x.by_id, x.by_name) from matched x where x.copy_id = c.copy_id and x.ord = 0) as new_cat,
    (select case when x.by_id is not null then 'master id + venue suffix' when x.by_name is not null then 'same name' end
       from matched x where x.copy_id = c.copy_id and x.ord = 0) as matched_by,
    coalesce((select array_agg(coalesce(x.by_id, x.by_name) order by x.ord) from matched x
               where x.copy_id = c.copy_id and x.ord > 0 and coalesce(x.by_id, x.by_name) is not null), '{}'::text[]) as new_cats
  from copies c
)
select l.name as venue, p.name as product, p.copy_id, p.new_cat, p.matched_by,
       case when coalesce(cardinality(p.copy_cats), 0) = 0 then p.new_cats else p.copy_cats end as new_cats,
       case when p.new_cat is null then 'NO MATCH: step 2 will stop' else 'will be set' end as result
from plan p left join locations l on l.id::text = p.location_id
order by 1, 2;


-- ───────────────────────── STEP 2: THE FIX ─────────────────────────
do $$
declare
  waiting int;
  changed int;
begin
  select count(*) into waiting
  from menu_items c
  where c.master_id in ('m-1790477109738', 'm-1790477141210', 'm-1790477180152',
                        'm-1790477204214', 'm-1790477233374', 'm-1790477258966')
    and c.id <> c.master_id and c.cat is null and coalesce(c.archived, false) = false;

  with six(master_id) as (
    values ('m-1790477109738'), ('m-1790477141210'), ('m-1790477180152'),
           ('m-1790477204214'), ('m-1790477233374'), ('m-1790477258966')
  ),
  copies as (   -- copies of the six pizzas that have NO category and are not archived
    select c.id as copy_id, c.location_id, c.cats as copy_cats, m.name, m.cat as master_cat, m.cats as master_cats
    from menu_items c
    join six s on s.master_id = c.master_id
    join menu_items m on m.id = c.master_id
    where c.id <> c.master_id and c.cat is null and coalesce(c.archived, false) = false
  ),
  wanted as (   -- each category of the Barnsley pizza (ord 0 = its category, 1.. = its "also in")
    select c.copy_id, c.location_id, c.master_cat as src, 0::bigint as ord from copies c where c.master_cat is not null
    union all
    select c.copy_id, c.location_id, u.src, u.ord from copies c, unnest(c.master_cats) with ordinality as u(src, ord)
  ),
  matched as (  -- that category at the copy's venue: master id + venue suffix (the bare id where the
                -- venue owns it), else the ONE category there with the same name
    select w.copy_id, w.ord,
      (select pc.id from menu_categories mc
         join menu_categories cm on cm.id = coalesce(mc.master_id, mc.id)
         join menu_categories pc on pc.location_id = w.location_id
          and pc.id = case when cm.location_id = w.location_id then cm.id else cm.id || '_' || right(w.location_id, 8) end
        where mc.id = w.src) as by_id,
      (select min(pc.id) from menu_categories mc
         join menu_categories cm on cm.id = coalesce(mc.master_id, mc.id)
         join menu_categories pc on pc.location_id = w.location_id and lower(btrim(pc.label)) = lower(btrim(cm.label))
        where mc.id = w.src
        having count(*) = 1) as by_name
    from wanted w
  ),
  plan as (
    select c.copy_id, c.location_id, c.name, c.copy_cats,
      (select coalesce(x.by_id, x.by_name) from matched x where x.copy_id = c.copy_id and x.ord = 0) as new_cat,
      (select case when x.by_id is not null then 'master id + venue suffix' when x.by_name is not null then 'same name' end
         from matched x where x.copy_id = c.copy_id and x.ord = 0) as matched_by,
      coalesce((select array_agg(coalesce(x.by_id, x.by_name) order by x.ord) from matched x
                 where x.copy_id = c.copy_id and x.ord > 0 and coalesce(x.by_id, x.by_name) is not null), '{}'::text[]) as new_cats
    from copies c
  )
  update menu_items mi
     set cat = p.new_cat,
         cats = case when coalesce(cardinality(mi.cats), 0) = 0 then p.new_cats else mi.cats end,
         updated_at = now()
    from plan p
   where mi.id = p.copy_id and mi.cat is null and p.new_cat is not null;
  get diagnostics changed = row_count;

  if changed <> waiting then
    raise exception 'Stopped, nothing was changed: % pizza copies have no category but % could be matched to their venue''s Hot Pizzas. Run STEP 1 to see which.', waiting, changed;
  end if;
  raise notice 'Done: % pizza copies are in their venue''s Hot Pizzas.', changed;
end $$;


-- ───────────────────────── STEP 3: READ ONLY, check ─────────────────────────
select l.name as venue, count(*) as copies,
       count(*) filter (where c.cat is null) as no_category,
       count(*) filter (where c.cat = 'cat-1790477045410_' || right(c.location_id, 8)) as in_hot_pizzas
from menu_items c left join locations l on l.id::text = c.location_id
where c.master_id in ('m-1790477109738', 'm-1790477141210', 'm-1790477180152',
                      'm-1790477204214', 'm-1790477233374', 'm-1790477258966')
  and c.id <> c.master_id and coalesce(c.archived, false) = false
group by 1 order by 1;
