-- ROLLBACK for 20260930b_OPS_customer_display_branding.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- Drops device_profiles.customer_display_brand and its check. Any customer display branding set
-- in Back Office is lost, and every display goes back to the kiosk branding on its next load.
--
-- Refresh every open Back Office tab straight after: a tab loaded while the column existed still
-- sends it, and its device profile saves fail (loudly, with a "NOT saved" message) until then.
-- Displays need nothing: they read without the column when it is missing.
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

set local lock_timeout = '3s';

alter table public.device_profiles drop constraint if exists device_profiles_customer_display_brand_shape;
alter table public.device_profiles drop column if exists customer_display_brand;

notify pgrst, 'reload schema';

-- VISIBLE CHECK: 0.
select count(*) as column_left
from information_schema.columns
where table_schema = 'public' and table_name = 'device_profiles' and column_name = 'customer_display_brand';
