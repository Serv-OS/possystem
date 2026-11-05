-- ROLLBACK for 20261123a_OPS_update_email_blocks.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- Drops the update_email_blocks table. Every removal and every unsubscribe is forgotten: the
-- next send goes to those people again. update_emails (the record of what was sent) is not
-- touched.
--
-- Company Admin, Email an update goes back to saying the Removed from emails card needs the
-- database update; Remove and the unsubscribe link say the same; sends go to everyone.
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

drop table if exists public.update_email_blocks;

notify pgrst, 'reload schema';

-- VISIBLE CHECK: 0.
select
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'update_email_blocks') as table_left;
