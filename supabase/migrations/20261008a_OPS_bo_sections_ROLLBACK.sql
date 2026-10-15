-- ROLLBACK for 20261008a_OPS_bo_sections.sql (Ops, tbetcegmszzotrwdtqhi).
--
-- Drops public.set_bo_sections(), the guard on the column, the check and the column
-- user_profiles.bo_sections. EVERY list saved in Back Office, Team is lost, so EVERY limited
-- login opens ALL of Back Office again from its next page load (which venues it can reach does
-- not change). If somebody must stay out, switch their Back Office access off in Team first.
-- The guard's rule that a limited person cannot switch an unlimited login back on goes with it,
-- so any manager can switch a teammate's Back Office access either way again, as before.
--
-- Nothing else on user_profiles is touched: the read and update rules, the two older guards
-- (user_profiles_fence_guard, user_profiles_role_guard) and the grants stay exactly as they are.
-- Back Office needs nothing: it reads without the column when it is missing, and Team goes back
-- to saying that limiting a login needs a database update. The create-user function needs
-- nothing either: it makes the login and says the limit was not saved.
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.device_profiles') is null or to_regclass('public.user_profiles') is null then
    raise exception 'This is not the Ops database (device_profiles or user_profiles is missing). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

drop function if exists public.set_bo_sections(uuid, text[]);
drop trigger if exists user_profiles_bo_sections_guard on public.user_profiles;
drop function if exists public.user_profiles_bo_sections_guard();
alter table public.user_profiles drop constraint if exists user_profiles_bo_sections_known;
alter table public.user_profiles drop column if exists bo_sections;

notify pgrst, 'reload schema';

-- VISIBLE CHECK: 0, 0 and 0.
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'user_profiles' and column_name = 'bo_sections') as column_left,
  (select count(*) from pg_proc
    where pronamespace = 'public'::regnamespace
      and proname in ('set_bo_sections', 'user_profiles_bo_sections_guard')) as functions_left,
  (select count(*) from pg_trigger
    where tgname = 'user_profiles_bo_sections_guard' and not tgisinternal) as guard_left;
