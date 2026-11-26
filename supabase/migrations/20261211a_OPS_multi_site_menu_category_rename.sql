-- 20261211a_OPS_multi_site_menu_category_rename.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Needs 20261018_OPS_multi_site_menu_category_fields.sql first (run on     #
-- #  Ops in October; do NOT run that file again for this).                    #
-- #  It only LOOSENS one rule: one function is replaced, nothing else.        #
-- #  No venue table is changed, so it is safe any time, service too.          #
-- #  Safe to run twice. Running it changes NOTHING at any venue.              #
-- ############################################################################
--
-- WHY (Peter, 26 Nov 2026)
--   The Multi site menu could not change a name: "also in categories". A category the group menu
--   already has took only "send like" and removed or back (20261018). Its NAME is allowed now, so
--   head office renames a category once and publish writes the new name to every site.
--   Its place and colour still stay as each site has them.
--
-- WHAT THIS FILE CHANGES
--   * public.msm_changes_category_fields(): the allowed list gains 'label'. The list is
--     msmModel.CATEGORY_UPDATE_FIELDS (pinned by src/lib/msm/msmCategoryRename.test.js). The words
--     it raises are the words the Back Office says (msmModel.categoryUpdateWords).
--   * The trigger msm_changes_guard_category is made again, the same as before.
--
-- A rename only reaches a site when a change set that holds it is published: the publish writes
-- only the fields that change set touched. Nothing to deploy with this file.
--
-- ORDER FOR PETER
--   1. Run this file on Ops (SQL editor). Read the check row at the bottom (expected values are
--      written above it).
--   That is all.
--
-- UNDO: 20261211a_OPS_multi_site_menu_category_rename_ROLLBACK.sql puts the 20261018 rule back.
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
  if to_regprocedure('public.msm_changes_category_fields()') is null then
    raise exception 'Run 20261018_OPS_multi_site_menu_category_fields.sql first. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

-- A category the group menu already has: "send like", removed or back, and its name.
create or replace function public.msm_changes_category_fields()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.target = 'category' and new.op <> 'create' and jsonb_typeof(new.after) = 'object'
     and exists (select 1 from jsonb_object_keys(new.after) k where k <> all (array['archived', 'route_like_id', 'label'])) then
    raise exception 'A category''s place and colour stay as each site has them for now. Only its name can be changed here.' using errcode = '22023';
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
  'Multi site menu (18 Oct 2026, name added 26 Nov 2026): a staged change to a category the group menu already has takes only archived, route_like_id and label. Runs after msm_changes_guard (trigger msm_changes_guard_category).';

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   category_rename_ok true, guards_in_order true, anon_function_rights 0,
--   staged_category_fields 0 (a set not yet done holding a change the rule still refuses)
select
  (position('k <> all (array[''archived'', ''route_like_id'', ''label''])' in pg_get_functiondef('public.msm_changes_category_fields()'::regprocedure)) > 0
   and exists (select 1 from pg_trigger t where t.tgrelid = 'public.msm_changes'::regclass and t.tgname = 'msm_changes_guard_category'
                 and t.tgenabled = 'O' and not t.tgisinternal
                 and t.tgfoid = 'public.msm_changes_category_fields()'::regprocedure)) as category_rename_ok,
  ((select string_agg(t.tgname::text, ',' order by t.tgname::text collate "C") from pg_trigger t
     where t.tgrelid = 'public.msm_changes'::regclass and not t.tgisinternal) = 'msm_changes_guard,msm_changes_guard_category') as guards_in_order,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'msm%' and has_function_privilege('anon', p.oid, 'execute')) as anon_function_rights,
  (select count(*) from public.msm_changes c join public.msm_change_sets s on s.id = c.change_set_id
    where s.status not in ('done', 'cancelled') and c.target = 'category' and c.op <> 'create' and jsonb_typeof(c.after) = 'object'
      and exists (select 1 from jsonb_object_keys(c.after) k where k <> all (array['archived', 'route_like_id', 'label']))) as staged_category_fields;
