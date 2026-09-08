-- Fix: catering_site_settings.menu_ids was uuid[], but menu/item ids in this system are TEXT
-- (app-generated, e.g. 'menu-1776196849535'). Saving a menu selection failed with
-- 'invalid input syntax for type uuid'. Convert to text[].
alter table catering_site_settings alter column menu_ids type text[] using menu_ids::text[];
