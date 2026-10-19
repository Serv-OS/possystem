-- 20261018_OPS_multi_site_menu_category_fields_ROLLBACK.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Undoes 20261018_OPS_multi_site_menu_category_fields.sql: drops its       #
-- #  trigger and its function, nothing else.                                  #
-- #  Run it BEFORE the 20261017c roll back, never after.                      #
-- ############################################################################
--
-- After this the database takes any allowed field on a category the group menu already has
-- again (as on 18 Oct before this file ran); the Back Office still refuses it in words first.
-- Nothing changes at any venue.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This must be run against the OPS DB (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

drop trigger if exists msm_changes_guard_category on public.msm_changes;
drop function if exists public.msm_changes_category_fields();

-- VISIBLE CHECK. Expected: triggers_left 0, functions_left 0
select
  (select count(*) from pg_trigger t where t.tgname = 'msm_changes_guard_category') as triggers_left,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'msm_changes_category_fields') as functions_left;
