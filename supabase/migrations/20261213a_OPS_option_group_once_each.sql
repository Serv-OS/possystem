-- 20261213a_OPS_option_group_once_each.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Needs the Multi site menu files first (20261017, 20261017c, 20261209a:   #
-- #  all run on Ops already; do NOT run them again for this).                 #
-- #  It only LOOSENS one list in two functions. No table is changed, no row   #
-- #  is changed, so it is safe any time, service too.                         #
-- #  Safe to run twice. Running it changes NOTHING at any venue.              #
-- ############################################################################
--
-- WHY (Peter, 26 Nov 2026)
--   "any of the pizza options they can select multiple but only one of each", for every venue.
--   An option group has a new kind of choice, multiple_once: several choices, each option only
--   once. Plain "multiple" stays exactly as it is (the same option can be picked again).
--   A venue's own option groups need nothing from this file: modifier_groups.selection_type is
--   plain text with no check on it. Only the GROUP MENU has two lists of the kinds it accepts:
--     * public.msm_changes_guard()   a change staged in a draft
--     * public.msm_apply_site(...)   a publish to a site
--   Both lists gain 'multiple_once'. The list is msmModel.SELECTION_TYPES (pinned by
--   src/lib/optionGroupOnceEach.test.js).
--
-- HOW
--   Each function is read as it is on this database right now, the one list in it is swapped,
--   and the function is made again with every other line untouched. So whatever later file last
--   changed these functions is kept. If a function does not hold the list exactly once, the file
--   stops and nothing is changed.
--
-- ORDER FOR PETER
--   1. Run this file on Ops (SQL editor). Read the check row at the bottom (expected values are
--      written above it).
--   That is all. The edge function msm-publish is deployed with the app release.
--
-- UNDO: 20261213a_OPS_option_group_once_each_ROLLBACK.sql.
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
  if to_regclass('public.msm_modifier_options') is null then
    raise exception 'Run 20261017c_OPS_multi_site_menu_groups.sql first. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

do $patch$
declare
  v_old  constant text := 'array[''single'', ''multiple'', ''quantity'']';
  v_new  constant text := 'array[''single'', ''multiple'', ''quantity'', ''multiple_once'']';
  f      regprocedure;
  v_def  text;
  v_n    integer;
  v_seen integer := 0;
begin
  for f in
    select p.oid::regprocedure
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('msm_changes_guard', 'msm_apply_site')
     order by p.proname
  loop
    v_seen := v_seen + 1;
    v_def := pg_get_functiondef(f);
    if position(v_new in v_def) > 0 then continue; end if;          -- done already
    v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
    if v_n <> 1 then
      raise exception 'The function % holds the list of kinds of choice % times, 1 was expected. Nothing was changed.', f, v_n;
    end if;
    execute replace(v_def, v_old, v_new);
  end loop;
  if v_seen <> 2 then
    raise exception 'Expected the 2 functions msm_changes_guard and msm_apply_site, found %. Nothing was changed.', v_seen;
  end if;
end
$patch$;

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   guard_takes_once_each true, publish_takes_once_each true, functions 2, anon_function_rights 0,
--   guards_in_order true
select
  (select position('array[''single'', ''multiple'', ''quantity'', ''multiple_once'']' in pg_get_functiondef(p.oid)) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'msm_changes_guard') as guard_takes_once_each,
  (select bool_and(position('array[''single'', ''multiple'', ''quantity'', ''multiple_once'']' in pg_get_functiondef(p.oid)) > 0)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'msm_apply_site') as publish_takes_once_each,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('msm_changes_guard', 'msm_apply_site')) as functions,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'msm%' and has_function_privilege('anon', p.oid, 'execute')) as anon_function_rights,
  ((select string_agg(t.tgname::text, ',' order by t.tgname::text collate "C") from pg_trigger t
     where t.tgrelid = 'public.msm_changes'::regclass and not t.tgisinternal) = 'msm_changes_guard,msm_changes_guard_category') as guards_in_order;
