-- 20261216a_OPS_multi_site_menu_combo_steps.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Needs 20261215a first (menu_items.combo, the stage 1 SQL). Refuses       #
-- #  without it, and refuses unless the three functions below are exactly     #
-- #  the bodies read on live on 27 Nov 2026. Safe to run twice. Running it    #
-- #  changes NOTHING at any venue and nothing in any group menu: one new      #
-- #  empty column, and three functions that take one more field.             #
-- ############################################################################
--
-- WHY (Peter, 27 Nov 2026)
--   "make sure its also in the multi site menu manager properly". Combo products (5.12.123) are a
--   product at a set price built from real products in steps (menu_items.combo). Stage 2
--   (5.12.124) lets the group menu hold a Combo's steps, in the same shape, with every product a
--   step names being a product of the GROUP MENU. Publish swaps each for that site's own item of
--   it (supabase/functions/_shared/msmPlan.js), and leaves out one the site does not sell.
--
-- WHAT THIS FILE DOES
--   1. msm_products.combo      jsonb, null on every row   a group product's steps
--   2. msm_changes_guard()     a draft may carry a product's steps (checked: the shape, and every
--                              product a step names is this group menu's own, or new in the same
--                              draft, never the Combo itself); a site may keep its own steps
--                              (kept 'combo'); a new product a Combo's step still names cannot be
--                              thrown away on its own
--   3. msm_start_version(uuid) a publish saves the steps in the group menu, and refuses a step that
--                              names a product outside this menu (the last word)
--   4. msm_apply_site(...)     a publish may write a site's menu_items.combo (insert and update),
--                              and refuses a Combo that names an item that is not at that site
--
-- HOW (functions 2 to 4)
--   Each function is read as it is on this database right now. It must be EXACTLY the body read
--   on live on 27 Nov 2026 (md5 of its body below), or this file's own result (a second run).
--   Anything else stops the file before anything is changed. Then the lines named below are
--   swapped, each must be there exactly once, and the function is made again with every other
--   line untouched (so the company wipe lines live already has stay as they are).
--     msm_changes_guard  read e36061b4ce3b7974741e5e39b8dca496   after c71ea4a7fb8e221617b42ef0725aa8f2
--     msm_start_version  read 188ea598a5d54f40932f5eae8583aeb0   after 2abda0780f63ce0ae2080ee49a0021f8
--     msm_apply_site     read 87be2da005dea0d49a4d068660ac8b8c   after cded0bbdf09a050156cb9674ab0e815b
--   Generated from the live text by ~/.claude/servos-release/combo_stage2/gen_20261216a.py, and
--   rehearsed against that text and end to end on the local rig (supabase/tests/multi_site_menu,
--   combo.mjs).
--
-- ORDER FOR PETER
--   1. 20261215a_OPS_menu_item_combo_steps.sql (stage 1), if not run already.
--   2. This file, on Ops (SQL editor). Read the check row at the bottom (expected values above it).
--   3. Then deploy the edge function msm-publish (from release 5.12.124).
--   4. Then launch 5.12.124.
--   Running this before the release is safe: the app that is live now never sends the new field.
--   Deploying msm-publish before the launch is safe too: it writes steps only for a group product
--   that has them, and none can until 5.12.124's screens stage them. The other way round, for the
--   minutes between launch and deploy, the old msm-publish would publish a new group Combo to the
--   sites WITHOUT its steps (found by the independent review of 27 Nov 2026).
--   Afterwards, 20261216a_CHECK_read_only.sql reads the same check again, any time.
--
-- UNDO: 20261216a_OPS_multi_site_menu_combo_steps_ROLLBACK.sql.
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This migration must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it, nothing was changed.';
  end if;
  if to_regclass('public.msm_changes') is null or to_regprocedure('public.msm_changes_guard()') is null
     or to_regclass('public.msm_modifier_options') is null then
    raise exception 'The Multi site menu is not on this database (20261017 and 20261017c). Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'menu_items' and column_name = 'combo') then
    raise exception 'Run 20261215a_OPS_menu_item_combo_steps.sql first (menu_items.combo). Nothing was changed.';
  end if;
end
$guard$;

-- The functions must be the bodies read on live (or this file's own result). Nothing is changed
-- before this passes.
do $same$
declare
  v_bad   text;
  v_count integer;
begin
  select count(*) into v_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('msm_changes_guard', 'msm_start_version', 'msm_apply_site');
  if v_count <> 3 then
    raise exception 'Expected one each of msm_changes_guard, msm_start_version and msm_apply_site, found % functions. Nothing was changed.', v_count;
  end if;
  select string_agg(p.proname || ' (body md5 ' || md5(p.prosrc) || ')', ', ' order by p.proname) into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and (false
       or (p.proname = 'msm_changes_guard' and md5(p.prosrc) not in ('e36061b4ce3b7974741e5e39b8dca496', 'c71ea4a7fb8e221617b42ef0725aa8f2'))
       or (p.proname = 'msm_start_version' and md5(p.prosrc) not in ('188ea598a5d54f40932f5eae8583aeb0', '2abda0780f63ce0ae2080ee49a0021f8'))
       or (p.proname = 'msm_apply_site' and md5(p.prosrc) not in ('87be2da005dea0d49a4d068660ac8b8c', 'cded0bbdf09a050156cb9674ab0e815b'))
       );
  if v_bad is not null then
    raise exception 'These functions are not the ones this file was made from: %. They changed on live after 27 Nov 2026. Nothing was changed: ask Claude to read them again and make the file again.', v_bad;
  end if;
end
$same$;

set local lock_timeout = '3s';

-- 1. The column --------------------------------------------------------------
alter table public.msm_products add column if not exists combo jsonb;

do $checks$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.msm_products'::regclass and conname = 'msm_products_combo_shape_check') then
    -- The same loose check as menu_items.combo (20261215a): an object holding a list of steps.
    alter table public.msm_products add constraint msm_products_combo_shape_check
      check (combo is null or (jsonb_typeof(combo) = 'object' and coalesce(jsonb_typeof(combo -> 'steps'), '') = 'array'));
  end if;
end
$checks$;

comment on column public.msm_products.combo is 'Multi site menu (5.12.124): a group product''s Combo steps, the shape of menu_items.combo (20261215a) with every itemId a product of THIS group menu. Publish writes each site''s menu_items.combo with that site''s own item of each product. Null = no steps.';

-- 2 to 4. The lines swapped in the three functions ----------------------------
do $patch$
declare
  -- function, the lines as they are, the lines as they become
  v_pairs constant text[] := array[
    'msm_changes_guard',
    '''parent_id'', ''tax_overrides'', ''no_price''];',
    '''parent_id'', ''tax_overrides'', ''no_price'', ''combo''];',

    'msm_changes_guard',
    '''archived'', ''sort_order'', ''family_base'', ''tax_by_type'']',
    '''archived'', ''sort_order'', ''family_base'', ''tax_by_type'', ''combo'']',

    'msm_changes_guard',
    '                      or (x.target = ''modifier_option'' and x.after ->> ''product_id'' = old.entity_id::text))) then' || chr(10) || '        raise exception ''Other changes in this set use this new product (its sizes, or an option). Remove those first.'' using errcode = ''22023'';',
    '                      or (x.target = ''modifier_option'' and x.after ->> ''product_id'' = old.entity_id::text)' || chr(10) || '                      or (x.target = ''product'' and jsonb_typeof(x.after #> ''{combo,steps}'') = ''array''' || chr(10) || '                          and exists (select 1 from jsonb_array_elements(x.after #> ''{combo,steps}'') s,' || chr(10) || '                                                    jsonb_array_elements(case when jsonb_typeof(s -> ''products'') = ''array'' then s -> ''products'' else ''[]''::jsonb end) e' || chr(10) || '                                       where e ->> ''itemId'' = old.entity_id::text)))) then' || chr(10) || '        raise exception ''Other changes in this set use this new product (its sizes, an option, or a step of a Combo). Remove those first.'' using errcode = ''22023'';',

    'msm_changes_guard',
    '    if new.after ? ''site_only_location_id'' and new.after ->> ''site_only_location_id'' is not null' || chr(10) || '',
    '    -- 20261216a: a Combo''s steps (Combo products stage 2). An object holding a list of steps (the' || chr(10) || '    -- check menu_items.combo has), and every product a step names is this group menu''s own, or' || chr(10) || '    -- new in this set, and never the Combo itself.' || chr(10) || '    if new.after ? ''combo'' and jsonb_typeof(new.after -> ''combo'') <> ''null'' then' || chr(10) || '      if jsonb_typeof(new.after -> ''combo'') <> ''object'' or coalesce(jsonb_typeof(new.after #> ''{combo,steps}''), '''') <> ''array'' then' || chr(10) || '        raise exception ''A Combo''''s steps must be a list of steps.'' using errcode = ''22023'';' || chr(10) || '      end if;' || chr(10) || '      for v_vid in select coalesce(e ->> ''itemId'', '''')' || chr(10) || '                     from jsonb_array_elements(new.after #> ''{combo,steps}'') s,' || chr(10) || '                          jsonb_array_elements(case when jsonb_typeof(s -> ''products'') = ''array'' then s -> ''products'' else ''[]''::jsonb end) e loop' || chr(10) || '        if v_vid !~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'' or v_vid = new.entity_id::text then' || chr(10) || '          raise exception ''A step of this Combo names a product that is not in this group menu.'' using errcode = ''42501'';' || chr(10) || '        end if;' || chr(10) || '        if not public.msm__ref_ok(v_set.menu_id, v_set.id, ''product'', v_vid::uuid) then' || chr(10) || '          raise exception ''A step of this Combo names a product that is not in this group menu.'' using errcode = ''42501'';' || chr(10) || '        end if;' || chr(10) || '      end loop;' || chr(10) || '    end if;' || chr(10) || '    if new.after ? ''site_only_location_id'' and new.after ->> ''site_only_location_id'' is not null' || chr(10) || '',

    'msm_start_version',
    '               modifier_groups, visibility, sold_alone, item_code, site_only_location_id, archived, sort_order, family_base, tax_by_type)',
    '               modifier_groups, visibility, sold_alone, item_code, site_only_location_id, archived, sort_order, family_base, tax_by_type, combo)',

    'msm_start_version',
    'r.family_base, r.tax_by_type' || chr(10) || '          from jsonb_populate_record(null::public.msm_products, c.after) r',
    'r.family_base, r.tax_by_type, r.combo' || chr(10) || '          from jsonb_populate_record(null::public.msm_products, c.after) r',

    'msm_start_version',
    '                  sold_alone, item_code, site_only_location_id, archived, sort_order, family_base, tax_by_type, updated_at) =',
    '                  sold_alone, item_code, site_only_location_id, archived, sort_order, family_base, tax_by_type, combo, updated_at) =',

    'msm_start_version',
    'r.family_base, r.tax_by_type, now()',
    'r.family_base, r.tax_by_type, r.combo, now()',

    'msm_start_version',
    '                 where not exists (select 1 from public.msm_modifier_groups x where x.id::text = g and x.menu_id = v.menu_id))))' || chr(10) || '',
    '                 where not exists (select 1 from public.msm_modifier_groups x where x.id::text = g and x.menu_id = v.menu_id))' || chr(10) || '     or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(p.combo -> ''steps'') = ''array'' then p.combo -> ''steps'' else ''[]''::jsonb end) s,' || chr(10) || '                              jsonb_array_elements(case when jsonb_typeof(s -> ''products'') = ''array'' then s -> ''products'' else ''[]''::jsonb end) e' || chr(10) || '                 where not exists (select 1 from public.msm_products x where x.id::text = e ->> ''itemId'' and x.menu_id = v.menu_id))))' || chr(10) || '',

    'msm_apply_site',
    '''tax_overrides'', ''tax_profile_id''];',
    '''tax_overrides'', ''tax_profile_id'', ''combo''];',

    'msm_apply_site',
    '''tags'', ''item_code'', ''tax_profile_id''];',
    '''tags'', ''item_code'', ''tax_profile_id'', ''combo''];',

    'msm_apply_site',
    'tags, item_code, tax_overrides, tax_profile_id, created_at, updated_at)',
    'tags, item_code, tax_overrides, tax_profile_id, combo, created_at, updated_at)',

    'msm_apply_site',
    'r.item_code, coalesce(r.tax_overrides, ''{}''::jsonb), r.tax_profile_id, v_now, v_now',
    'r.item_code, coalesce(r.tax_overrides, ''{}''::jsonb), r.tax_profile_id, r.combo, v_now, v_now',

    'msm_apply_site',
    'visibility, sold_alone, archived, tax_rate_id, image, tags, item_code, tax_profile_id, tax_overrides, pricing, updated_at) =',
    'visibility, sold_alone, archived, tax_rate_id, image, tags, item_code, tax_profile_id, combo, tax_overrides, pricing, updated_at) =',

    'msm_apply_site',
    '                   r.item_code, r.tax_profile_id,' || chr(10) || '',
    '                   r.item_code, r.tax_profile_id, r.combo,' || chr(10) || '',

    'msm_apply_site',
    '    -- VAT per order type, as a patch of the four keys (every other key and every explicit null the' || chr(10) || '',
    '    -- 20261216a: a Combo''s steps this change SETS name only this site''s own items (the planner swaps' || chr(10) || '    -- each group menu product for this site''s item of it, and leaves out one the site does not sell).' || chr(10) || '    if jsonb_typeof(v_set -> ''combo'') = ''object'' and exists (' || chr(10) || '         select 1 from jsonb_array_elements(case when jsonb_typeof(v_set #> ''{combo,steps}'') = ''array'' then v_set #> ''{combo,steps}'' else ''[]''::jsonb end) s,' || chr(10) || '                       jsonb_array_elements(case when jsonb_typeof(s -> ''products'') = ''array'' then s -> ''products'' else ''[]''::jsonb end) e' || chr(10) || '          where not exists (select 1 from public.menu_items p where p.id = e ->> ''itemId'' and p.location_id = p_location)) then' || chr(10) || '      raise exception ''A Combo would name a product that is not at this site. Nothing was written.'';' || chr(10) || '    end if;' || chr(10) || '    -- VAT per order type, as a patch of the four keys (every other key and every explicit null the' || chr(10) || '',

    'msm_apply_site',
    '  -- category links ------------------------------------------------------' || chr(10) || '',
    '  -- 20261216a: every NEW Combo names only this site''s own items.' || chr(10) || '  if exists (' || chr(10) || '    select 1 from public.menu_items i' || chr(10) || '     where i.location_id = p_location and i.id = any (v_items_new) and jsonb_typeof(i.combo) = ''object''' || chr(10) || '       and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(i.combo -> ''steps'') = ''array'' then i.combo -> ''steps'' else ''[]''::jsonb end) s,' || chr(10) || '                                 jsonb_array_elements(case when jsonb_typeof(s -> ''products'') = ''array'' then s -> ''products'' else ''[]''::jsonb end) e' || chr(10) || '                    where not exists (select 1 from public.menu_items p where p.id = e ->> ''itemId'' and p.location_id = p_location))) then' || chr(10) || '    raise exception ''A new Combo would name a product that is not at this site. Nothing was written.'';' || chr(10) || '  end if;' || chr(10) || '' || chr(10) || '  -- category links ------------------------------------------------------' || chr(10) || ''
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

-- The new column is invisible to the API until it reloads its schema.
notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   column_ok t, check_ok t, guard_md5_ok t, start_md5_ok t, apply_md5_ok t, functions 3,
--   anon_function_rights 0, guards_in_order t, group_combos 0
select
  (select count(*) = 1 from information_schema.columns where table_schema = 'public' and table_name = 'msm_products' and column_name = 'combo' and data_type = 'jsonb') as column_ok,
  (select count(*) = 1 from pg_constraint where conrelid = 'public.msm_products'::regclass and conname = 'msm_products_combo_shape_check' and convalidated) as check_ok,
  (select md5(p.prosrc) = 'c71ea4a7fb8e221617b42ef0725aa8f2' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'msm_changes_guard') as guard_md5_ok,
  (select md5(p.prosrc) = '2abda0780f63ce0ae2080ee49a0021f8' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'msm_start_version') as start_md5_ok,
  (select md5(p.prosrc) = 'cded0bbdf09a050156cb9674ab0e815b' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'msm_apply_site') as apply_md5_ok,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('msm_changes_guard', 'msm_start_version', 'msm_apply_site')) as functions,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'msm%' and has_function_privilege('anon', p.oid, 'execute')) as anon_function_rights,
  ((select string_agg(t.tgname::text, ',' order by t.tgname::text collate "C") from pg_trigger t
     where t.tgrelid = 'public.msm_changes'::regclass and not t.tgisinternal) = 'msm_changes_guard,msm_changes_guard_category') as guards_in_order,
  (select count(*) from public.msm_products where combo is not null) as group_combos;
