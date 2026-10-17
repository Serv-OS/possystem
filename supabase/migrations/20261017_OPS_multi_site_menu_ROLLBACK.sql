-- 20261017_OPS_multi_site_menu_ROLLBACK.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Undoes 20261017_OPS_multi_site_menu.sql. Drops ONLY msm_ objects, the    #
-- #  msm-run-due job and the msm_cron_key vault secret.                       #
-- ############################################################################
--
-- What stays: every venue row a publish wrote (menus, menu_categories, menu_items, menu links,
-- modifier groups, print routing, config pushes, activity feed entries). They are ordinary menu
-- rows by then, exactly as if someone had edited them in Back Office. The tills keep running.
-- The group menu itself (central products, prices per site, history) is GONE after this: export
-- it first from the Multi site menu screen if it is wanted.
--
-- Run the job removal first so the scheduler stops calling a function that is about to go.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This must be run against the OPS DB (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
end
$guard$;

do $cron$
declare
  j record;
begin
  if to_regclass('cron.job') is not null then
    for j in select jobid from cron.job where jobname = 'msm-run-due' loop
      perform cron.unschedule(j.jobid);
    end loop;
  end if;
end
$cron$;

do $key$
begin
  if to_regclass('vault.secrets') is not null then
    delete from vault.secrets where name = 'msm_cron_key';
  end if;
end
$key$;

drop function if exists public.msm_run_due();
drop function if exists public.msm_note_notified(uuid, text, text);
drop function if exists public.msm_mark_late();
drop function if exists public.msm_mark_missed();
drop function if exists public.msm_precheck_result(uuid, text, boolean, text);
drop function if exists public.msm_precheck_due(integer);
drop function if exists public.msm_fail_site(uuid, text, text, integer);
drop function if exists public.msm_apply_site(uuid, text, jsonb, jsonb, text, jsonb, text, text, uuid);
drop function if exists public.msm_apply_site(uuid, text, jsonb, jsonb, text, jsonb, text, text);
drop function if exists public.msm__managed_item(uuid, text, text, text[]);
drop function if exists public.msm__managed_category(uuid, text, text, text[], jsonb);
drop function if exists public.msm__keys_ok(jsonb, text[]);
drop function if exists public.msm_start_version(uuid);
drop function if exists public.msm_claim_due(integer);
drop function if exists public.msm__refresh_version(uuid);
drop function if exists public.msm_venue_fingerprint(text);
drop function if exists public.msm_cron_ok(text);
drop function if exists public.msm_admin_set_member(uuid, uuid, text);
drop function if exists public.msm_admin_set_enabled(uuid, boolean);
drop function if exists public.msm_admin_status(uuid);
drop function if exists public.msm_managed_items(text);
drop function if exists public.msm_retry_site(uuid, text);
drop function if exists public.msm_cancel_set(uuid);
drop function if exists public.msm_unschedule_set(uuid);
drop function if exists public.msm_schedule_set(uuid, timestamp, integer, boolean);
drop function if exists public.msm_publish_now(uuid, boolean);
drop function if exists public.msm__freeze(uuid, text, timestamp, integer, boolean);
drop function if exists public.msm__sites_reached(uuid);
drop function if exists public.msm_import_commit(jsonb);
drop function if exists public.msm_my_access();

drop table if exists public.msm_version_sites;
drop table if exists public.msm_versions;
drop table if exists public.msm_changes;
drop table if exists public.msm_change_sets;
drop table if exists public.msm_product_sites;
drop table if exists public.msm_products;
drop table if exists public.msm_modifier_group_sites;
drop table if exists public.msm_modifier_groups;
drop table if exists public.msm_category_sites;
drop table if exists public.msm_categories;
drop table if exists public.msm_site_groups;
drop table if exists public.msm_menu_sites;
drop table if exists public.msm_menus;
drop table if exists public.msm_members;
drop table if exists public.msm_company;

drop function if exists public.msm_changes_guard();
drop function if exists public.msm__ref_ok(uuid, uuid, text, uuid);
drop function if exists public.msm_change_sets_guard();
drop function if exists public.msm_site_groups_guard();
drop function if exists public.msm_site_org_guard();
drop function if exists public.msm__venue_in_org(text, uuid);
drop function if exists public.msm__require_servos();
drop function if exists public.msm__require_editor(uuid);
drop function if exists public.msm__second_step_ok();
drop function if exists public.msm_member_org_ids();
drop function if exists public.msm_viewable_menu_ids();
drop function if exists public.msm_editable_org_ids();
drop function if exists public.msm_viewable_org_ids();
drop function if exists public.msm_can_edit(uuid);
drop function if exists public.msm_can_view(uuid);
drop function if exists public.msm_role(uuid);

-- VISIBLE CHECK. Expected: msm_tables 0, msm_functions 0, job 0, key 0
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname like 'msm\_%' and c.relkind = 'r') as msm_tables,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'msm%') as msm_functions,
  (select count(*) from cron.job where jobname = 'msm-run-due') as job,
  (select count(*) from vault.secrets where name = 'msm_cron_key') as key;
