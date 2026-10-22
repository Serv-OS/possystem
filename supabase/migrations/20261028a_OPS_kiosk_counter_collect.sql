-- 20261028a_OPS_kiosk_counter_collect.sql
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor.
--
-- Counter collect on the kiosk is switched on PER KIOSK in Back Office, Kiosk settings, with the
-- words on its button (Peter, 22 Oct 2026: "it needs to be on the kiosk settings to turn on for
-- kiosk"). src/lib/counterOrder.js.
--
-- Adds
--   1. device_profiles.kiosk_counter_collect        the Counter collect tile on this kiosk, default off
--   2. device_profiles.kiosk_label_counter_collect  the words on the tile (blank shows "Counter collect")
--
-- Safety
--   Idempotent. The web app works before and after this runs: before it, the Kiosk settings switch
--   stays hidden and no kiosk shows the tile. Nothing is dropped, no existing column changes.
--
-- Rollback: 20261028a_OPS_kiosk_counter_collect_ROLLBACK.sql

set lock_timeout = '3s';

do $$ begin
  if to_regclass('public.device_profiles') is null or to_regclass('public.order_queue') is null then
    raise exception 'Wrong database. Run this on the Ops project.';
  end if;
end $$;

alter table public.device_profiles add column if not exists kiosk_counter_collect boolean not null default false;
comment on column public.device_profiles.kiosk_counter_collect is
  'Kiosk: show the Counter collect tile (eat in, no table, collected at the counter; dine in tax). Off by default.';

alter table public.device_profiles add column if not exists kiosk_label_counter_collect text;
comment on column public.device_profiles.kiosk_label_counter_collect is
  'Kiosk: the words on the Counter collect tile, up to 40 characters. Blank shows Counter collect.';

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'device_profiles_kiosk_label_counter_collect_len') then
    alter table public.device_profiles add constraint device_profiles_kiosk_label_counter_collect_len
      check (kiosk_label_counter_collect is null or char_length(kiosk_label_counter_collect) <= 40);
  end if;
end $$;

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: columns 2, kiosks_switched_on 0.
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'device_profiles'
      and column_name in ('kiosk_counter_collect', 'kiosk_label_counter_collect')) as columns,
  (select count(*) from public.device_profiles where kiosk_counter_collect) as kiosks_switched_on;
