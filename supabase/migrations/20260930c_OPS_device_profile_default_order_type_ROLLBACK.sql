-- ROLLBACK for 20260930c_OPS_device_profile_default_order_type.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- Drops device_profiles.default_order_type, device_profiles.dine_in_flag_prompt and the check.
-- Any default order type or flag prompt set in Back Office is lost: every till goes back to the
-- automatic default (the only enabled type, else dine in) and no till asks for a flag number,
-- from its next profile load.
--
-- Refresh every open Back Office tab straight after: a tab loaded while the columns existed still
-- sends them, and its device profile saves fail (loudly, with a "NOT saved" message) until then.
-- Tills need nothing: they read without the columns when they are missing.
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

alter table public.device_profiles drop constraint if exists device_profiles_default_order_type_known;
alter table public.device_profiles drop column if exists default_order_type;
alter table public.device_profiles drop column if exists dine_in_flag_prompt;

notify pgrst, 'reload schema';

-- VISIBLE CHECK: 0.
select count(*) as columns_left
from information_schema.columns
where table_schema = 'public' and table_name = 'device_profiles'
  and column_name in ('default_order_type', 'dine_in_flag_prompt');
