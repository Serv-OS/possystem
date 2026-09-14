-- 20260914_OPS_kds_redesign.sql  (v5.8.66, Ops project tbetcegmszzotrwdtqhi)
--
-- KDS redesign. Two new jsonb columns, nothing else. Safe to run more than once.
--
-- 1. kds_tickets.meta
--    Until now a kitchen ticket had no order type, till name, order number or customer
--    name of its own; they were squashed into table_label ("Takeaway · Peter Roberts").
--    The tills, the master till's kiosk / online / delivery app router and the
--    catering-release function now also write:
--      { v, channel, orderType, isTable, customerName, orderNo, source, staff, note }
--    table_label is unchanged (fireCourse matches on it).
--
-- 2. devices.kds_settings
--    Each kitchen screen's own settings (switches, time alert minutes, colour by,
--    density). Saved per screen, not per venue.
--
-- The app works before this is run: ticket writers retry without meta when PostgREST
-- says the column is missing, the KDS reads old rows from table_label, and settings
-- stay on the tablet until the column exists.
--
-- RLS: both tables keep their existing policies. A column add needs no policy change.

alter table public.kds_tickets add column if not exists meta jsonb;
comment on column public.kds_tickets.meta is
  'v5.8.66 KDS: { v, channel, orderType, isTable, customerName, orderNo, source, staff, note }. Null on tickets written before the redesign.';

alter table public.devices add column if not exists kds_settings jsonb;
comment on column public.devices.kds_settings is
  'v5.8.66 KDS: this screen''s settings { v, colour, density, caution, late, show{} }. Null means defaults.';

-- PostgREST must see the new columns straight away, or the first writes still fail.
notify pgrst, 'reload schema';

-- Check (should return 2 rows):
-- select table_name, column_name, data_type from information_schema.columns
--  where table_schema = 'public'
--    and ((table_name = 'kds_tickets' and column_name = 'meta')
--      or (table_name = 'devices' and column_name = 'kds_settings'));
