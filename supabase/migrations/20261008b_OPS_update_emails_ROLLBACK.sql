-- ROLLBACK for 20261008b_OPS_update_emails.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- Drops the update_emails table. The record of EVERY update email sent to Back Office logins
-- (who got it, when, what the provider said) and every test is lost. The emails themselves
-- were already delivered and are not affected.
--
-- Nothing else is touched. Company Admin, Messages to venues goes back to saying the Email an
-- update panel needs the database update; nothing else in the app reads this table.
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.device_profiles') is null or to_regclass('public.devices') is null then
    raise exception 'This is not the Ops database (device_profiles or devices is missing). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

drop table if exists public.update_emails;

notify pgrst, 'reload schema';

-- VISIBLE CHECK: 0.
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'update_emails') as table_left;
