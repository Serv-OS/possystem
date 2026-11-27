-- 20261214a_OPS_multi_site_menu_several_menus.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Needs the Multi site menu files first (20261017, 20261017c, 20261018,    #
-- #  20261211a, 20261213a: all run on Ops already; do NOT run them again).    #
-- #  Safe to run twice. Running it changes NOTHING at any venue and nothing   #
-- #  in any group menu: two new empty columns, and four functions that take   #
-- #  three more fields.                                                       #
-- ############################################################################
--
-- WHY (Peter, 26 Nov 2026, Mozz)
--   "each site has multiple menus, they have online, instore, items that are not available for
--   take away only dine in, catering menus all with different products ... we cant manage this in
--   multi site menus". And: "a different menu seems better. I like the different menus but need
--   to be able to manage centrally in multi site".
--   A group menu can now hold more than one menu (Main, and say Online and Catering), with ONE
--   product list underneath. A category is ticked into the menus it is on; a product is on a menu
--   through its category (or an "Also in" category). Publish puts each category on the matching
--   menu at each site (the site's own menu of that name, or one it makes), and takes it off the
--   ones it is not on. Version 5.12.116, supabase/functions/_shared/msmMenus.js.
--
-- WHAT THIS FILE DOES
--   1. msm_menus.extra_menus      jsonb, default []     the group menu's other menus
--      msm_categories.menu_keys   jsonb, default null   the menus a category is on (null = Main)
--   2. public.msm_changes_guard()            a draft may carry extra_menus (the menu) and
--                                            menu_keys (a category)
--   3. public.msm_changes_category_fields()  a category the group menu already has may also change
--                                            menu_keys; and the SHAPE of both new fields is checked
--   4. public.msm_start_version(uuid)        a publish saves both new fields in the group menu
--   5. public.msm_apply_site(...)            a publish may set is_default = true on the site's menu
--                                            the group menu writes into. Only ever true, and the
--                                            planner sends it only at a site that has NO default
--                                            menu, in the publish that first puts a category on
--                                            one of the other menus there: a POS with no menu
--                                            picked must stay on the main menu.
--
-- HOW (functions 2, 4 and 5)
--   Each function is read as it is on this database right now, the few lines named below are
--   swapped, and the function is made again with every other line untouched. So whatever later
--   file last changed these functions is kept. If a line is not there exactly once, the file stops
--   and nothing is changed.
--
-- ORDER FOR PETER
--   1. Run this file on Ops (SQL editor). Read the check row at the bottom (expected values are
--      written above it).
--   2. Then launch 5.12.116. The edge function msm-publish is deployed with the release.
--   Running this before the release is safe: the app that is live now never sends the new fields.
--
-- UNDO: 20261214a_OPS_multi_site_menu_several_menus_ROLLBACK.sql.
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
  if to_regprocedure('public.msm_changes_category_fields()') is null then
    raise exception 'Run 20261018_OPS_multi_site_menu_category_fields.sql first. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

-- 1. The two columns ---------------------------------------------------------
alter table public.msm_menus add column if not exists extra_menus jsonb not null default '[]'::jsonb;
alter table public.msm_categories add column if not exists menu_keys jsonb;

do $checks$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.msm_menus'::regclass and conname = 'msm_menus_extra_menus_ok') then
    alter table public.msm_menus add constraint msm_menus_extra_menus_ok check (jsonb_typeof(extra_menus) = 'array');
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.msm_categories'::regclass and conname = 'msm_categories_menu_keys_ok') then
    alter table public.msm_categories add constraint msm_categories_menu_keys_ok check (menu_keys is null or jsonb_typeof(menu_keys) = 'array');
  end if;
end
$checks$;

comment on column public.msm_menus.extra_menus is 'Multi site menu (5.12.116): the group menu''s other menus beside its main one: [{ id, name, archived?, sites?: { location id: that site''s menu id, or false for "not at this site" } }]. Written only by a publish (msm_start_version).';
comment on column public.msm_categories.menu_keys is 'Multi site menu (5.12.116): the menus this category is on: ''main'' and, or, ids from msm_menus.extra_menus. null = the main menu only.';

-- 2, 4, 5. The lines swapped in the three big functions ----------------------
do $patch$
declare
  nl constant text := chr(10);
  -- function, the line as it is, the line as it becomes
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
  v_n    integer;
  v_seen integer := 0;
  i      integer;
begin
  for f, v_name in
    select p.oid::regprocedure, p.proname::text
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in ('msm_changes_guard', 'msm_start_version', 'msm_apply_site')
     order by p.proname
  loop
    v_seen := v_seen + 1;
    v_def := pg_get_functiondef(f);
    i := 1;
    while i <= array_length(v_pairs, 1) loop
      if v_pairs[i] = v_name and position(v_pairs[i + 2] in v_def) = 0 then          -- not done already
        v_n := (length(v_def) - length(replace(v_def, v_pairs[i + 1], ''))) / length(v_pairs[i + 1]);
        if v_n <> 1 then
          raise exception 'The function % holds the line "%" % times, 1 was expected. Nothing was changed.', f, left(v_pairs[i + 1], 70), v_n;
        end if;
        v_def := replace(v_def, v_pairs[i + 1], v_pairs[i + 2]);
      end if;
      i := i + 3;
    end loop;
    execute v_def;
  end loop;
  if v_seen <> 3 then
    raise exception 'Expected the 3 functions msm_changes_guard, msm_start_version and msm_apply_site, found %. Nothing was changed.', v_seen;
  end if;
end
$patch$;

-- 3. The category rule, and the shape of the two new fields -------------------
-- The same trigger function as 20261211a (msm_changes_guard_category, before insert or update on
-- msm_changes), with menu_keys allowed on a category the group menu already has, and both new
-- fields checked: msmMenus.js extraMenusShapeOk and menuKeysShapeOk say the same in the screens.
create or replace function public.msm_changes_category_fields()
returns trigger
language plpgsql
set search_path to ''
as $fn$
begin
  if new.target = 'category' and new.op <> 'create' and jsonb_typeof(new.after) = 'object'
     and exists (select 1 from jsonb_object_keys(new.after) k where k <> all (array['archived', 'route_like_id', 'label', 'menu_keys'])) then
    raise exception 'A category''s place and colour stay as each site has them for now. Only its name can be changed here.' using errcode = '22023';
  end if;
  if new.target = 'category' and jsonb_typeof(new.after) = 'object' and new.after ? 'menu_keys'
     and jsonb_typeof(new.after -> 'menu_keys') <> 'null' then
    if jsonb_typeof(new.after -> 'menu_keys') <> 'array'
       or jsonb_array_length(new.after -> 'menu_keys') not between 1 and 17
       or exists (select 1 from jsonb_array_elements(new.after -> 'menu_keys') e
                   where jsonb_typeof(e) <> 'string' or not ((e #>> '{}') = 'main' or (e #>> '{}') ~ '^[0-9a-fA-F-]{8,40}$'))
       or (select count(distinct e #>> '{}') from jsonb_array_elements(new.after -> 'menu_keys') e) <> jsonb_array_length(new.after -> 'menu_keys') then
      raise exception 'The menus a category is on are not a list of this group menu''s menus. Nothing was changed.' using errcode = '22023';
    end if;
  end if;
  if new.target = 'menu' and jsonb_typeof(new.after) = 'object' and new.after ? 'extra_menus' then
    if jsonb_typeof(new.after -> 'extra_menus') <> 'array'
       or jsonb_array_length(new.after -> 'extra_menus') > 16
       or exists (select 1 from jsonb_array_elements(new.after -> 'extra_menus') e
                   where jsonb_typeof(e) <> 'object'
                      or jsonb_typeof(e -> 'id') is distinct from 'string' or not ((e ->> 'id') ~ '^[0-9a-fA-F-]{8,40}$')
                      or jsonb_typeof(e -> 'name') is distinct from 'string' or char_length(btrim(e ->> 'name')) not between 1 and 60 or char_length(e ->> 'name') > 60
                      or exists (select 1 from jsonb_object_keys(e) k where k <> all (array['id', 'name', 'archived', 'sites']))
                      or (e ? 'archived' and jsonb_typeof(e -> 'archived') <> 'boolean')
                      or (e ? 'sites' and (jsonb_typeof(e -> 'sites') <> 'object'
                            or exists (select 1 from jsonb_each(e -> 'sites') s
                                        where not (s.value = 'false'::jsonb
                                                   or (jsonb_typeof(s.value) = 'string' and char_length(s.value #>> '{}') between 1 and 120))))))
       or (select count(distinct e ->> 'id') from jsonb_array_elements(new.after -> 'extra_menus') e) <> jsonb_array_length(new.after -> 'extra_menus')
       or (select count(*) from jsonb_array_elements(new.after -> 'extra_menus') e where coalesce(e ->> 'archived', 'false') <> 'true') > 8 then
      raise exception 'The list of menus is not one this group menu can hold (8 menus beside the main one, each with a name). Nothing was changed.' using errcode = '22023';
    end if;
  end if;
  return new;
end
$fn$;

revoke all on function public.msm_changes_category_fields() from public, anon, authenticated, service_role;

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   columns 2, guard_takes_both true, publish_saves_both true, site_default_only_true true,
--   category_rule_takes_menus true, functions 4, anon_function_rights 0, guards_in_order true,
--   group_menus_with_other_menus 0, categories_with_menus 0
select
  (select count(*) from information_schema.columns where table_schema = 'public'
     and ((table_name = 'msm_menus' and column_name = 'extra_menus') or (table_name = 'msm_categories' and column_name = 'menu_keys'))) as columns,
  (select position('''use_name_everywhere'', ''extra_menus'']' in pg_get_functiondef(p.oid)) > 0 and position('''route_like_id'', ''menu_keys'']' in pg_get_functiondef(p.oid)) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'msm_changes_guard') as guard_takes_both,
  (select position('use_name_everywhere, extra_menus, updated_at' in pg_get_functiondef(p.oid)) > 0 and position('route_like_id, menu_keys, updated_at' in pg_get_functiondef(p.oid)) > 0
          and position('archived, route_like_id, menu_keys)' in pg_get_functiondef(p.oid)) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'msm_start_version') as publish_saves_both,
  (select bool_and(position('Publish may only make a menu the default' in pg_get_functiondef(p.oid)) > 0 and position('coalesce(r.is_default, t.is_default)' in pg_get_functiondef(p.oid)) > 0)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'msm_apply_site') as site_default_only_true,
  (select position('''label'', ''menu_keys'']' in pg_get_functiondef(p.oid)) > 0
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'msm_changes_category_fields') as category_rule_takes_menus,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('msm_changes_guard', 'msm_start_version', 'msm_apply_site', 'msm_changes_category_fields')) as functions,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'msm%' and has_function_privilege('anon', p.oid, 'execute')) as anon_function_rights,
  ((select string_agg(t.tgname::text, ',' order by t.tgname::text collate "C") from pg_trigger t
     where t.tgrelid = 'public.msm_changes'::regclass and not t.tgisinternal) = 'msm_changes_guard,msm_changes_guard_category') as guards_in_order,
  (select count(*) from public.msm_menus where jsonb_array_length(extra_menus) > 0) as group_menus_with_other_menus,
  (select count(*) from public.msm_categories where menu_keys is not null) as categories_with_menus;
