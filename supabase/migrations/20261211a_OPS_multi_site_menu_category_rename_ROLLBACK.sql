-- 20261211a_OPS_multi_site_menu_category_rename_ROLLBACK.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Undoes 20261211a_OPS_multi_site_menu_category_rename.sql: the category   #
-- #  rule goes back to the 20261018 one (a name is refused again).            #
-- ############################################################################
--
-- A rename already staged in a draft stays in that draft, but it can no longer be changed.
-- Nothing changes at any venue.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This must be run against the OPS DB (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.msm_changes') is null then
    raise exception 'The Multi site menu is not installed here. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

-- A category the group menu already has: only "send like" and removed or back.
create or replace function public.msm_changes_category_fields()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.target = 'category' and new.op <> 'create' and jsonb_typeof(new.after) = 'object'
     and exists (select 1 from jsonb_object_keys(new.after) k where k <> all (array['archived', 'route_like_id'])) then
    raise exception 'A category''s name, place and colour stay as each site has them for now. Only a new category takes them here.' using errcode = '22023';
  end if;
  return new;
end
$fn$;

drop trigger if exists msm_changes_guard_category on public.msm_changes;
create trigger msm_changes_guard_category before insert or update on public.msm_changes
  for each row execute function public.msm_changes_category_fields();

-- GRANTS: closed to everyone (a trigger function is never called by a person).
do $grants$
declare
  f   text;
  p   regprocedure;
begin
  foreach f in array array['public.msm_changes_category_fields()'] loop
    p := to_regprocedure(f);
    if p is null then raise exception 'Missing function %', f; end if;
    execute format('revoke all on function %s from public, anon, authenticated, service_role', p);
  end loop;
end
$grants$;

comment on function public.msm_changes_category_fields() is
  'Multi site menu (18 Oct 2026): a staged change to a category the group menu already has takes only archived and route_like_id. Runs after msm_changes_guard (trigger msm_changes_guard_category).';

-- VISIBLE CHECK. Expected: old_rule_back true
select
  (position('k <> all (array[''archived'', ''route_like_id''])' in pg_get_functiondef('public.msm_changes_category_fields()'::regprocedure)) > 0) as old_rule_back;
