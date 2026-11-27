-- 20261216a_OPS_multi_site_menu_combo_steps_ROLLBACK.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand. UNDO of 20261216a.                              #
-- #  It REFUSES while any group product still holds steps, any draft or       #
-- #  publish waiting to run carries steps, or any site keeps its own steps:   #
-- #  take those off in the Multi site menu (and publish) first, so nothing    #
-- #  is lost. Safe to run twice.                                              #
-- ############################################################################
--
-- WHAT IT DOES
--   Puts msm_changes_guard, msm_start_version and msm_apply_site back exactly as they were before
--   20261216a (the bodies read on live on 27 Nov 2026: every swapped line swapped back, each must be
--   there exactly once), then drops msm_products.combo and its check.
--   A site's own menu_items.combo (written by a publish) stays: that column is 20261215a's, and
--   each Combo keeps working at its site as the site's own Combo.
--
-- ORDER FOR PETER
--   1. Put back the release before 5.12.124 (the app then never sends steps to the group menu).
--   2. Run this file. Read the check row at the bottom.
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This file must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it, nothing was changed.';
  end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'msm_products' and column_name = 'combo') then
    if exists (select 1 from public.msm_products where combo is not null) then
      raise exception 'A group product still holds Combo steps. Take its steps off in the Multi site menu and publish first. Nothing was changed.';
    end if;
  end if;
  -- Only sets still to run count (a set already published keeps its history, as every set does):
  -- a product's steps, or a site keeping its own steps.
  if exists (select 1 from public.msm_changes x join public.msm_change_sets s on s.id = x.change_set_id
              where s.status in ('draft', 'scheduled', 'running') and jsonb_typeof(x.after) = 'object'
                and ((x.after ? 'combo' and jsonb_typeof(x.after -> 'combo') <> 'null')
                  or (jsonb_typeof(x.after -> 'kept') = 'object' and x.after -> 'kept' ? 'combo'))) then
    raise exception 'A draft or a scheduled set still carries Combo steps. Remove those changes first. Nothing was changed.';
  end if;
  if exists (select 1 from public.msm_product_sites s where jsonb_typeof(s.kept) = 'object' and s.kept ? 'combo') then
    raise exception 'A site still keeps its own Combo steps in the group menu. Give it the group''s back (Sites) first. Nothing was changed.';
  end if;
  if exists (select 1 from public.msm_versions v, jsonb_array_elements(case when jsonb_typeof(v.changes) = 'array' then v.changes else '[]'::jsonb end) c
              where v.status in ('scheduled', 'running') and jsonb_typeof(c -> 'after') = 'object' and c -> 'after' ? 'combo') then
    raise exception 'A publish that is still running carries Combo steps. Let it finish first. Nothing was changed.';
  end if;
end
$guard$;

do $same$
declare
  v_bad text;
begin
  select string_agg(p.proname || ' (body md5 ' || md5(p.prosrc) || ')', ', ' order by p.proname) into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and (false
       or (p.proname = 'msm_changes_guard' and md5(p.prosrc) not in ('c71ea4a7fb8e221617b42ef0725aa8f2', 'e36061b4ce3b7974741e5e39b8dca496'))
       or (p.proname = 'msm_start_version' and md5(p.prosrc) not in ('2abda0780f63ce0ae2080ee49a0021f8', '188ea598a5d54f40932f5eae8583aeb0'))
       or (p.proname = 'msm_apply_site' and md5(p.prosrc) not in ('cded0bbdf09a050156cb9674ab0e815b', '87be2da005dea0d49a4d068660ac8b8c'))
       );
  if v_bad is not null then
    raise exception 'These functions are not the ones 20261216a made (or read): %. Nothing was changed: ask Claude to read them again.', v_bad;
  end if;
end
$same$;

set local lock_timeout = '3s';

do $patch$
declare
  -- function, the lines as 20261216a left them, the lines as they were (the same list, read the other way)
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
    -- Backwards through the list, so a later line that sits inside an earlier one comes off first.
    i := array_length(v_pairs, 1) - 2;
    while i >= 1 loop
      if v_pairs[i] = v_name and position(v_pairs[i + 2] in v_def) > 0 then          -- not undone already
        v_n := (length(v_def) - length(replace(v_def, v_pairs[i + 2], ''))) / length(v_pairs[i + 2]);
        if v_n <> 1 then
          raise exception 'The function % holds the line "%" % times, 1 was expected. Nothing was changed.', f, left(v_pairs[i + 2], 70), v_n;
        end if;
        v_def := replace(v_def, v_pairs[i + 2], v_pairs[i + 1]);
      end if;
      i := i - 3;
    end loop;
    execute v_def;
  end loop;
  if v_seen <> 3 then
    raise exception 'Expected the 3 functions msm_changes_guard, msm_start_version and msm_apply_site, found %. Nothing was changed.', v_seen;
  end if;
end
$patch$;

alter table public.msm_products drop constraint if exists msm_products_combo_shape_check;
alter table public.msm_products drop column if exists combo;

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: column_gone t, guard_back t, start_back t, apply_back t
select
  (select count(*) = 0 from information_schema.columns where table_schema = 'public' and table_name = 'msm_products' and column_name = 'combo') as column_gone,
  (select md5(p.prosrc) = 'e36061b4ce3b7974741e5e39b8dca496' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'msm_changes_guard') as guard_back,
  (select md5(p.prosrc) = '188ea598a5d54f40932f5eae8583aeb0' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'msm_start_version') as start_back,
  (select md5(p.prosrc) = '87be2da005dea0d49a4d068660ac8b8c' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'msm_apply_site') as apply_back;
