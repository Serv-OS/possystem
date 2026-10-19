-- 20261018_OPS_multi_site_menu_category_fields.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Needs 20261017c_OPS_multi_site_menu_groups.sql first (already run on     #
-- #  Ops 18 Oct; do NOT run that file again for this).                        #
-- #  ADDITIVE: one new msm_ function and one new trigger on msm_changes.      #
-- #  No venue table is changed, so it is safe any time, service too.          #
-- #  Safe to run twice. Running it changes NOTHING at any venue.              #
-- ############################################################################
--
-- WHY (18 Oct 2026 follow up)
--   A category the group menu already has takes only "send like" and removed or back. No screen
--   edits an existing category's name, place or colour yet, and the import keeps no per site
--   category differences (products have kept values, categories do not), so a publish would write
--   the group's value over every site's own. A NEW category takes every field.
--   The Back Office says it first (msmModel.categoryUpdateWords in msmDiff.mergeStaged). This file
--   makes the database refuse it too.
--
--   The rule was first written into 20261017c, after 20261017c had already run on Ops, so Ops never
--   got it. 20261017c stays exactly as it was run; the rule is this file, its own step.
--
-- WHAT THIS FILE ADDS
--   * public.msm_changes_category_fields(): refuses any field but archived and route_like_id on a
--     staged change to a category the group menu already has (op is not create). The list is
--     msmModel.CATEGORY_UPDATE_FIELDS (pinned by src/lib/msm/msmRunOnOps.test.js).
--   * Trigger msm_changes_guard_category on public.msm_changes, before insert or update. Triggers
--     on one table fire in name order, so the main guard (msm_changes_guard: draft only, the
--     allowlist, this menu's own rows) always answers first, and this one second.
--
-- NOTHING CHANGES FOR ANY VENUE. Nothing to deploy with it.
--
-- ORDER FOR PETER
--   1. Run this file on Ops (SQL editor). Read the check row at the bottom (expected values are
--      written above it).
--   That is all. 20261017c is not run again.
--
-- UNDO: 20261018_OPS_multi_site_menu_category_fields_ROLLBACK.sql. Run it BEFORE the 20261017c roll
-- back, never after.
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This migration must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it, nothing was changed.';
  end if;
  if to_regclass('public.msm_changes') is null or to_regprocedure('public.msm_changes_guard()') is null then
    raise exception 'Run 20261017_OPS_multi_site_menu.sql first. Nothing was changed.';
  end if;
  if to_regclass('public.msm_modifier_options') is null or to_regprocedure('public.msm_sql_contract()') is null then
    raise exception 'Run 20261017c_OPS_multi_site_menu_groups.sql first. Nothing was changed.';
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

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   category_fields_ok true, guards_in_order true, anon_function_rights 0,
--   staged_category_fields 0 (a set not yet done holding such a change from before this file; 0 on 18 Oct),
--   contract 2 (unchanged by this file)
select
  (position('k <> all (array[''archived'', ''route_like_id''])' in pg_get_functiondef('public.msm_changes_category_fields()'::regprocedure)) > 0
   and exists (select 1 from pg_trigger t where t.tgrelid = 'public.msm_changes'::regclass and t.tgname = 'msm_changes_guard_category'
                 and t.tgenabled = 'O' and not t.tgisinternal
                 and t.tgfoid = 'public.msm_changes_category_fields()'::regprocedure)) as category_fields_ok,
  ((select string_agg(t.tgname::text, ',' order by t.tgname::text collate "C") from pg_trigger t
     where t.tgrelid = 'public.msm_changes'::regclass and not t.tgisinternal) = 'msm_changes_guard,msm_changes_guard_category') as guards_in_order,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'msm%' and has_function_privilege('anon', p.oid, 'execute')) as anon_function_rights,
  (select count(*) from public.msm_changes c join public.msm_change_sets s on s.id = c.change_set_id
    where s.status not in ('done', 'cancelled') and c.target = 'category' and c.op <> 'create' and jsonb_typeof(c.after) = 'object'
      and exists (select 1 from jsonb_object_keys(c.after) k where k <> all (array['archived', 'route_like_id']))) as staged_category_fields,
  public.msm_sql_contract() as contract;
