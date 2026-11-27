-- 20261214a_OPS_multi_site_menu_several_menus_ROLLBACK.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand. UNDO of 20261214a.                              #
-- #  It REFUSES while any group menu still has another menu, any category is  #
-- #  ticked into one, or a draft holds either: remove those in the Multi      #
-- #  site menu and publish first, so no site is left half way.                #
-- #  The app must be back on a version before 5.12.116 first.                 #
-- ############################################################################
--
-- Puts the four functions back as they were before 20261214a (the same lines swapped the other
-- way, read from the functions as they are now) and drops the two columns.
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This must be run against the OPS DB (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.msm_changes') is null then
    raise exception 'The Multi site menu is not installed here. Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'msm_menus' and column_name = 'extra_menus') then
    raise exception '20261214a is not on this database. Nothing was changed.';
  end if;
  if exists (select 1 from public.msm_menus m where jsonb_array_length(m.extra_menus) > 0) then
    raise exception 'A group menu still has another menu. Remove it in the Multi site menu and publish first. Nothing was changed.';
  end if;
  if exists (select 1 from public.msm_categories c where c.menu_keys is not null) then
    raise exception 'A category is still ticked into another menu. Put it back on the main menu only and publish first. Nothing was changed.';
  end if;
  if exists (select 1 from public.msm_changes c join public.msm_change_sets s on s.id = c.change_set_id
              where s.status not in ('done', 'cancelled') and (c.after ? 'extra_menus' or c.after ? 'menu_keys')) then
    raise exception 'A draft still holds a change to the menus. Take that change out first. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

do $patch$
declare
  nl constant text := chr(10);
  -- function, the line before 20261214a, the line 20261214a made (swapped back below)
  v_pairs constant text[] := array[
    'msm_changes_guard',
    'when ''menu'' then array[''name'', ''description'', ''use_name_everywhere'']',
    'when ''menu'' then array[''name'', ''description'', ''use_name_everywhere'', ''extra_menus'']',

    'msm_changes_guard',
    'when ''category'' then array[''parent_id'', ''label'', ''icon'', ''color'', ''accounting_group'', ''default_course'', ''sort_order'', ''image'', ''archived'', ''route_like_id'']',
    'when ''category'' then array[''parent_id'', ''label'', ''icon'', ''color'', ''accounting_group'', ''default_course'', ''sort_order'', ''image'', ''archived'', ''route_like_id'', ''menu_keys'']',

    'msm_start_version',
    'set (name, description, use_name_everywhere, updated_at) =',
    'set (name, description, use_name_everywhere, extra_menus, updated_at) =',

    'msm_start_version',
    'coalesce(r.use_name_everywhere, false), now()',
    'coalesce(r.use_name_everywhere, false), coalesce(r.extra_menus, ''[]''::jsonb), now()',

    'msm_start_version',
    'insert into public.msm_categories (id, menu_id, parent_id, label, icon, color, accounting_group, default_course, sort_order, image, archived, route_like_id)',
    'insert into public.msm_categories (id, menu_id, parent_id, label, icon, color, accounting_group, default_course, sort_order, image, archived, route_like_id, menu_keys)',

    'msm_start_version',
    'coalesce(r.default_course, 1), coalesce(r.sort_order, 0), r.image, coalesce(r.archived, false), r.route_like_id' || chr(10),
    'coalesce(r.default_course, 1), coalesce(r.sort_order, 0), r.image, coalesce(r.archived, false), r.route_like_id, r.menu_keys' || chr(10),

    'msm_start_version',
    'set (parent_id, label, icon, color, accounting_group, default_course, sort_order, image, archived, route_like_id, updated_at) =',
    'set (parent_id, label, icon, color, accounting_group, default_course, sort_order, image, archived, route_like_id, menu_keys, updated_at) =',

    'msm_start_version',
    'coalesce(r.default_course, 1), coalesce(r.sort_order, 0), r.image, coalesce(r.archived, false), r.route_like_id, now()',
    'coalesce(r.default_course, 1), coalesce(r.sort_order, 0), r.image, coalesce(r.archived, false), r.route_like_id, r.menu_keys, now()',

    'msm_apply_site',
    'v_upd_menus  constant text[] := array[''name'', ''description''];',
    'v_upd_menus  constant text[] := array[''name'', ''description'', ''is_default''];',

    'msm_apply_site',
    'if not public.msm__keys_ok(u -> ''set'', v_upd_menus) then raise exception ''A menu change has a field publish may not write.''; end if;',
    'if not public.msm__keys_ok(u -> ''set'', v_upd_menus) then raise exception ''A menu change has a field publish may not write.''; end if;' || chr(10)
      || '    if (u -> ''set'') ? ''is_default'' and (u #>> ''{set,is_default}'') is distinct from ''true'' then raise exception ''Publish may only make a menu the default, never take that away. Nothing was written.''; end if;',

    'msm_apply_site',
    'update public.menus t set (name, description, updated_at) =',
    'update public.menus t set (name, description, is_default, updated_at) =',

    'msm_apply_site',
    '(select r.name, r.description, v_now from jsonb_populate_record(t, u -> ''set'') r)',
    '(select r.name, r.description, coalesce(r.is_default, t.is_default), v_now from jsonb_populate_record(t, u -> ''set'') r)'
  ];
  f      regprocedure;
  v_name text;
  v_def  text;
  i      integer;
begin
  for f, v_name in
    select p.oid::regprocedure, p.proname::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('msm_changes_guard', 'msm_start_version', 'msm_apply_site')
     order by p.proname
  loop
    v_def := pg_get_functiondef(f);
    i := 1;
    while i <= array_length(v_pairs, 1) loop
      if v_pairs[i] = v_name and position(v_pairs[i + 2] in v_def) > 0 then
        v_def := replace(v_def, v_pairs[i + 2], v_pairs[i + 1]);
      end if;
      i := i + 3;
    end loop;
    execute v_def;
  end loop;
end
$patch$;

-- The category rule as 20261211a left it.
create or replace function public.msm_changes_category_fields()
returns trigger
language plpgsql
set search_path to ''
as $fn$
begin
  if new.target = 'category' and new.op <> 'create' and jsonb_typeof(new.after) = 'object'
     and exists (select 1 from jsonb_object_keys(new.after) k where k <> all (array['archived', 'route_like_id', 'label'])) then
    raise exception 'A category''s place and colour stay as each site has them for now. Only its name can be changed here.' using errcode = '22023';
  end if;
  return new;
end
$fn$;

revoke all on function public.msm_changes_category_fields() from public, anon, authenticated, service_role;

alter table public.msm_menus drop constraint if exists msm_menus_extra_menus_ok;
alter table public.msm_categories drop constraint if exists msm_categories_menu_keys_ok;
alter table public.msm_menus drop column if exists extra_menus;
alter table public.msm_categories drop column if exists menu_keys;

-- VISIBLE CHECK. Expected: columns_left 0, functions_still_changed 0
select
  (select count(*) from information_schema.columns where table_schema = 'public'
     and ((table_name = 'msm_menus' and column_name = 'extra_menus') or (table_name = 'msm_categories' and column_name = 'menu_keys'))) as columns_left,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('msm_changes_guard', 'msm_start_version', 'msm_apply_site', 'msm_changes_category_fields')
      and (position('extra_menus' in pg_get_functiondef(p.oid)) > 0 or position('menu_keys' in pg_get_functiondef(p.oid)) > 0
           or position('coalesce(r.is_default, t.is_default)' in pg_get_functiondef(p.oid)) > 0)) as functions_still_changed;
