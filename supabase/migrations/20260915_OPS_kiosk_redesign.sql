-- 20260915_OPS_kiosk_redesign.sql
-- OPS project (tbetcegmszzotrwdtqhi) ONLY. Peter runs this by hand in the SQL editor.
--
-- The new kiosk design (start, menu, review and pay, card, done) is switched on per kiosk profile.
--
-- Adds
--   1. device_profiles.kiosk_new_design   per profile switch for the new kiosk design, default off
--   2. device_profiles.kiosk_sms_enabled  "Text me when it's ready". The column is already in the
--                                         baseline and unused; this only makes sure it exists.
--
-- Safety
--   Idempotent. The web app works before and after this runs.
--   Before it runs: the Back Office design and text switches stay hidden, every kiosk keeps
--   today's design, and order-notify treats every kiosk order as today.
--   Nothing is dropped. No existing column changes type or default.
--
-- Rollback (only if needed)
--   alter table public.device_profiles drop column if exists kiosk_new_design;
--   Leave kiosk_sms_enabled, it predates this file. Refresh every kiosk afterwards.

set lock_timeout = '3s';

do $$ begin
  if to_regclass('public.device_profiles') is null or to_regclass('public.order_queue') is null then
    raise exception 'Wrong database. Run this on the Ops project.';
  end if;
end $$;

alter table public.device_profiles add column if not exists kiosk_new_design boolean not null default false;
comment on column public.device_profiles.kiosk_new_design is
  'Kiosk: use the new five screen design (start, menu, review and pay, card, done). Off means the current kiosk.';

alter table public.device_profiles add column if not exists kiosk_sms_enabled boolean default false;
comment on column public.device_profiles.kiosk_sms_enabled is
  'Kiosk new design: offer Text me when it''s ready on take away orders. Sends the ready text only. Separate from kiosk_loyalty_enabled.';

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result). 2 means both columns are there.
select count(*) as kiosk_redesign_columns
from information_schema.columns
where table_schema = 'public' and table_name = 'device_profiles'
  and column_name in ('kiosk_new_design', 'kiosk_sms_enabled');
