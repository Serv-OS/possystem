-- 20261213a_OPS_option_group_once_each_ROLLBACK.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Undoes 20261213a_OPS_option_group_once_each.sql: the two group menu      #
-- #  lists of kinds of choice go back to single, multiple and quantity.       #
-- ############################################################################
--
-- It stops, changing nothing, while any group menu option group or any draft still uses the kind
-- "multiple_once": set those groups back to Several choices without the tick first, and publish.
-- Nothing changes at any venue.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This must be run against the OPS DB (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.msm_changes') is null then
    raise exception 'The Multi site menu is not installed here. Nothing was changed.';
  end if;
  if exists (select 1 from public.msm_modifier_groups g where g.selection_type = 'multiple_once') then
    raise exception 'A group menu option group is still set to each option only once. Untick it and publish first. Nothing was changed.';
  end if;
  if exists (select 1 from public.msm_changes c join public.msm_change_sets s on s.id = c.change_set_id
              where s.status not in ('done', 'cancelled') and c.after ->> 'selection_type' = 'multiple_once') then
    raise exception 'A draft still holds a group set to each option only once. Take that change out first. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

do $patch$
declare
  v_old  constant text := 'array[''single'', ''multiple'', ''quantity'', ''multiple_once'']';
  v_new  constant text := 'array[''single'', ''multiple'', ''quantity'']';
  f      regprocedure;
  v_def  text;
begin
  for f in
    select p.oid::regprocedure
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('msm_changes_guard', 'msm_apply_site')
     order by p.proname
  loop
    v_def := pg_get_functiondef(f);
    if position(v_old in v_def) > 0 then execute replace(v_def, v_old, v_new); end if;
  end loop;
end
$patch$;

-- VISIBLE CHECK. Expected: still_takes_once_each 0
select count(*) as still_takes_once_each
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('msm_changes_guard', 'msm_apply_site')
   and position('''multiple_once''' in pg_get_functiondef(p.oid)) > 0;
