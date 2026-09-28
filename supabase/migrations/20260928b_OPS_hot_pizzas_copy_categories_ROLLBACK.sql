-- 20260928b_OPS_hot_pizzas_copy_categories_ROLLBACK.sql   (Ops DB tbetcegmszzotrwdtqhi)
--
-- Undoes 20260928b: the 24 pizza copies at Train Station, Leeds, Preston and Headingly go back to
-- no category (cat null, "also in" empty), which is how they were before it. Only a copy that
-- still sits in its venue's Hot Pizzas is changed, so a category someone chose since is kept.
-- Huddersfield is not touched. Safe to run again. Push to POS at the four venues afterwards.

update menu_items
set cat = null, cats = '{}'::text[], updated_at = now()
where id in (
  'm-1790477109738_ba9ab0c2', 'm-1790477141210_ba9ab0c2', 'm-1790477180152_ba9ab0c2',
  'm-1790477204214_ba9ab0c2', 'm-1790477233374_ba9ab0c2', 'm-1790477258966_ba9ab0c2',
  'm-1790477109738_5c26956b', 'm-1790477141210_5c26956b', 'm-1790477180152_5c26956b',
  'm-1790477204214_5c26956b', 'm-1790477233374_5c26956b', 'm-1790477258966_5c26956b',
  'm-1790477109738_8e52e0fa', 'm-1790477141210_8e52e0fa', 'm-1790477180152_8e52e0fa',
  'm-1790477204214_8e52e0fa', 'm-1790477233374_8e52e0fa', 'm-1790477258966_8e52e0fa',
  'm-1790477109738_42820abf', 'm-1790477141210_42820abf', 'm-1790477180152_42820abf',
  'm-1790477204214_42820abf', 'm-1790477233374_42820abf', 'm-1790477258966_42820abf'
)
and cat = 'cat-1790477045410_' || right(location_id, 8);

-- Check: 24 rows, cat null.
select id, location_id, cat, cats from menu_items
where master_id in ('m-1790477109738', 'm-1790477141210', 'm-1790477180152',
                    'm-1790477204214', 'm-1790477233374', 'm-1790477258966')
  and id <> master_id and right(id, 8) in ('ba9ab0c2', '5c26956b', '8e52e0fa', '42820abf')
order by id;
