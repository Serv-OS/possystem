-- 20261028a_OPS_kiosk_counter_collect_ROLLBACK.sql
-- OPS project ONLY. Undoes 20261028a: the Counter collect tile leaves every kiosk (refresh them).
set lock_timeout = '3s';
do $$ begin
  if to_regclass('public.device_profiles') is null or to_regclass('public.order_queue') is null then
    raise exception 'Wrong database. Run this on the Ops project.';
  end if;
end $$;
alter table public.device_profiles drop constraint if exists device_profiles_kiosk_label_counter_collect_len;
alter table public.device_profiles drop column if exists kiosk_label_counter_collect;
alter table public.device_profiles drop column if exists kiosk_counter_collect;
notify pgrst, 'reload schema';
-- VISIBLE CHECK. Expected: columns_left 0.
select count(*) as columns_left from information_schema.columns
 where table_schema = 'public' and table_name = 'device_profiles'
   and column_name in ('kiosk_counter_collect', 'kiosk_label_counter_collect');
