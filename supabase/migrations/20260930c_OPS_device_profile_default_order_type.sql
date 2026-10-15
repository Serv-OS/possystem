-- 20260930c_OPS_device_profile_default_order_type.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Adds 2 columns and 1 check to device_profiles. No data changes.          #
-- #  Takes a moment; outside service is best, as always.                      #
-- ############################################################################
--
-- WHY (Peter, Coffee Boy, 30 Sep 2026)
--   1. "Be able to set a default order type by device profile. For example Huddersfield have one
--      POS that only does drive thru but it's defaulting to Dine in, not Drive thru, even though
--      it's the only order type available on that POS."
--   2. "For coffee shops, a setting we can turn on so that on dine in orders it prompts for a
--      table flag: they have several numbered signs, no fixed tables, so staff must be prompted
--      to type that number, and then the KDS and production tickets say Table and the number
--      typed." POS only, staff must enter it.
--
-- WHAT THIS FILE DOES
--   device_profiles.default_order_type   text, null = automatic. One of dine-in, takeaway,
--                                        collection, delivery, drive-thru (checked). The till
--                                        starts on it when it is enabled on the profile; with
--                                        null, or a type no longer enabled, the till works it out
--                                        (src/lib/tillOrderType.js defaultOrderTypeFor: the only
--                                        enabled type, else dine in, else the first enabled).
--   device_profiles.dine_in_flag_prompt  boolean, default false. On: a dine in walk in order on
--                                        the till asks for the flag number before it is sent or
--                                        paid, and carries "Table <n>" like a kiosk flag order.
--
-- WHY NEW COLUMNS (and not enabled_order_types or hidden_features)
--   Both are jsonb lists that every Back Office build rewrites in full on save, so a value hidden
--   inside them would be wiped by a save from a Back Office build that does not know it (the
--   stale WebView problem). Old code never reads or writes a column it does not know.
--
-- BEFORE AND AFTER IT RUNS
--   Before: the app works as today. The till starts on dine in unless the profile enables exactly
--   one order type, in which case it starts on that one (that part needs no column). Back Office
--   shows the two settings greyed out with "needs a database update" and no save sends them.
--   After: refresh Back Office, open a device profile, and the "Starts on" choice and the
--   "Ask for a flag number on dine in orders" switch are live. Tills pick the values up when their
--   profile next loads (boot, Push to POS, the 5 minute refresh), like every profile setting.
--
-- Rollback: 20260930c_OPS_device_profile_default_order_type_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.device_profiles') is null then
    raise exception 'This is not the Ops database (device_profiles is missing). Nothing was changed.';
  end if;
end
$guard$;

-- Fail fast on a busy table instead of making till and kiosk reads queue behind this script.
set local lock_timeout = '3s';

alter table public.device_profiles add column if not exists default_order_type text;
alter table public.device_profiles add column if not exists dine_in_flag_prompt boolean not null default false;

comment on column public.device_profiles.default_order_type is
  'The order type a till on this profile starts on. Null = automatic (the only enabled type, else dine in, else the first enabled). Must also be in enabled_order_types to take effect. Written only by Back Office Device profiles (src/lib/tillOrderType.js).';
comment on column public.device_profiles.dine_in_flag_prompt is
  'On: a dine in walk in order on the till asks staff for the customer''s flag number before it is sent or paid, and carries "Table <n>" on the KDS, kitchen tickets, receipt and Orders (src/lib/tillOrderType.js). POS only.';

do $shape$
begin
  if not exists (select 1 from pg_constraint where conname = 'device_profiles_default_order_type_known') then
    alter table public.device_profiles add constraint device_profiles_default_order_type_known
      check (default_order_type is null
        or default_order_type in ('dine-in', 'takeaway', 'collection', 'delivery', 'drive-thru'));
  end if;
end
$shape$;

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result): 2 and 1.
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'device_profiles'
      and column_name in ('default_order_type', 'dine_in_flag_prompt')) as columns_added,
  (select count(*) from pg_constraint where conname = 'device_profiles_default_order_type_known') as check_added;
