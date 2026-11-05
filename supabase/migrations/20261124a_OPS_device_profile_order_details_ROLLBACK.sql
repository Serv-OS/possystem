-- ROLLBACK for 20261124a_OPS_device_profile_order_details.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- Drops device_profiles.order_prompt_guests, order_prompt_order_type and order_prompt_new_customer.
-- Any of the three switches set in Back Office is lost: from its next profile load a till asks
-- none of the three. The flag number switch (dine_in_flag_prompt, 20260930c) is not touched.
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

alter table public.device_profiles drop column if exists order_prompt_guests;
alter table public.device_profiles drop column if exists order_prompt_order_type;
alter table public.device_profiles drop column if exists order_prompt_new_customer;

notify pgrst, 'reload schema';

-- VISIBLE CHECK: 0.
select count(*) as columns_left
from information_schema.columns
where table_schema = 'public' and table_name = 'device_profiles'
  and column_name in ('order_prompt_guests', 'order_prompt_order_type', 'order_prompt_new_customer');
