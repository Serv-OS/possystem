-- Rollback twin of 20261204a: puts the kept kitchen and receipt names back, then drops the
-- keep table. A column goes back only while it still holds what the repair wrote (the product's
-- name at the time); a kitchen or receipt name changed since, by a rename or by hand, stays.
update public.menu_items m
set kitchen_name = case when m.kitchen_name = k.repaired_to then k.kitchen_name else m.kitchen_name end,
    receipt_name = case when m.receipt_name = k.repaired_to then k.receipt_name else m.receipt_name end
from public.menu_items_name_repair_20261204 k
where k.id = m.id;

drop table if exists public.menu_items_name_repair_20261204;
