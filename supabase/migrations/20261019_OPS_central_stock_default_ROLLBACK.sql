-- 20261019_OPS_central_stock_default_ROLLBACK.sql
-- Removes only the new venue trigger. Venues keep the mode they have (use stock_central_switch to
-- change one). Safe to run twice.
drop trigger if exists locations_central_stock_on_create on public.locations;
drop function if exists public._stock_central_on_new_venue();
select
  (select count(*) from pg_trigger t where t.tgrelid = 'public.locations'::regclass and t.tgname = 'locations_central_stock_on_create') as new_venue_trigger_left,
  (select count(*) from pg_proc p where p.proname = '_stock_central_on_new_venue') as function_left;
