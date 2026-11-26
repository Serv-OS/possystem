-- 20261209a  OPS  Multi site menu: a product's tax may be a TAX PROFILE, by name
--
-- Peter, Mozz, 25 Nov 2026: the group menu's Tax view read "No tax rate" in every box and the
-- product sheet offered only old style rates, while every site charged through its "Prepared
-- food" profile (8.45% at three sites, 9.45% at two). "this needs building".
--
-- The group product's tax is already a NAME and a percent. From 5.12.104 a name with NO percent
-- means "each site's own tax profile of that name" (msmPlan taxProfileFor). Nothing new is stored
-- in the group menu. The one database rule in the way is in public.msm_apply_site, which let a
-- publish touch menu_items.tax_profile_id in exactly two ways (clear a generated copy of a rate,
-- or put that copy back) and refused it on a new product. This file adds:
--   * a NEW product may carry tax_profile_id: one of that site's own live profiles;
--   * an EXISTING product may be SET to one of that site's own live, real profiles whose name is
--     the group product's tax name (and the group product has no percent);
--   * an existing product's profile may be CLEARED when the group product names no tax at all.
-- Everything else in the function is byte for byte what Ops ran on 25 Nov 2026 (read with
-- pg_get_functiondef, md5 of the body 5e37e5207d3ac1957d1c0692861f5f2d). The two old ways work as
-- before. Safe to run twice. Run BEFORE 5.12.104 is launched; until then nothing uses the new ways.

CREATE OR REPLACE FUNCTION public.msm_apply_site(p_version uuid, p_location text, p_writes jsonb, p_snapshot jsonb, p_fingerprint text, p_counts jsonb DEFAULT '{}'::jsonb, p_pushed_by text DEFAULT 'Multi site menu'::text, p_summary text DEFAULT NULL::text, p_last_push_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v        public.msm_versions%rowtype;
  vs       public.msm_version_sites%rowtype;
  w        jsonb;
  u        jsonb;
  op       jsonb;
  v_old    jsonb;
  v_new    jsonb;
  v_audit  jsonb := '[]'::jsonb;
  v_rows   integer;
  v_now    timestamptz := now();
  v_nowj   jsonb := to_jsonb(now());
  v_items  text[] := '{}';
  v_cats   text[] := '{}';
  v_menus  text[] := '{}';
  v_groups text[] := '{}';
  v_items_new text[] := '{}';
  v_cats_new  text[] := '{}';
  v_menus_new text[] := '{}';
  v_groups_new text[] := '{}';
  v_set    jsonb;
  v_push   uuid;
  v_snap   jsonb;
  v_any    boolean := false;
  v_uuid   uuid;
  v_bad    text;
  v_opts   jsonb;
  v_idx    integer;
  v_entry  jsonb;
  v_vg     text;
  v_rate_after text;
  v_prof_old text;
  v_prof_new text;
  v_cleared uuid;
  v_product uuid;
  v_ins_menus  constant text[] := array['id', 'name', 'description', 'is_default', 'is_active', 'sort_order', 'scope', 'org_id'];
  v_ins_cats   constant text[] := array['id', 'menu_id', 'parent_id', 'label', 'icon', 'color', 'accounting_group', 'sort_order', 'default_course', 'image', 'scope', 'org_id'];
  v_ins_items  constant text[] := array['id', 'name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'type', 'cat', 'cats', 'parent_id', 'sort_order', 'pricing', 'allergens', 'assigned_modifier_groups', 'visibility', 'sold_alone', 'archived', 'tax_rate_id', 'image', 'scope', 'org_id', 'tags', 'item_code', 'tax_overrides', 'tax_profile_id'];
  v_ins_groups constant text[] := array['id', 'name', 'min', 'max', 'min_select', 'max_select', 'selection_type', 'options', 'sort_order'];
  v_upd_menus  constant text[] := array['name', 'description'];
  v_upd_cats   constant text[] := array['menu_id', 'parent_id', 'label', 'icon', 'color', 'accounting_group', 'sort_order', 'default_course', 'image'];
  v_upd_items  constant text[] := array['name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'type', 'cat', 'cats', 'parent_id', 'allergens', 'assigned_modifier_groups', 'visibility', 'sold_alone', 'archived', 'tax_rate_id', 'image', 'tags', 'item_code', 'tax_profile_id'];
  v_upd_groups constant text[] := array['name', 'min', 'max', 'min_select', 'max_select', 'selection_type'];
  v_pricing    constant text[] := array['base', 'dineIn', 'takeaway', 'collection', 'delivery', 'driveThru'];
  v_opt_keys   constant text[] := array['id', 'name', 'price', 'itemId', 'subGroupId'];
  v_opt_patch  constant text[] := array['name', 'price', 'itemId', 'subGroupId'];
  v_tax_keys   constant text[] := array['dine-in', 'takeaway', 'delivery', 'bar'];
  v_write_keys constant text[] := array['menus', 'categories', 'items', 'links', 'groups', 'routing', 'maps'];
  v_map_keys   constant text[] := array['categories', 'groups', 'menu_site', 'options', 'items'];
begin
  select * into v from public.msm_versions where id = p_version;
  if not found then
    raise exception 'No such publish.';
  end if;
  select * into vs from public.msm_version_sites s where s.version_id = p_version and s.location_id = p_location for update;
  if not found then
    raise exception 'That site is not in this publish.';
  end if;
  if vs.status in ('done', 'nothing') then
    return jsonb_build_object('ok', true, 'already', true, 'push_id', vs.push_id);
  end if;
  if vs.status <> 'running' then
    raise exception 'That site is not being published (it is %).', vs.status;
  end if;
  if v.version_no is null then
    raise exception 'This publish has not started.';
  end if;
  -- Switched off between the claim and the write: the site waits (design 3.4), it never fails.
  if not exists (select 1 from public.msm_company c where c.org_id = v.org_id and c.enabled) then
    update public.msm_version_sites
       set status = 'scheduled', claimed_at = null, attempts = greatest(0, attempts - 1)
     where version_id = p_version and location_id = p_location;
    return jsonb_build_object('ok', false, 'reason', 'paused', 'words', 'The Multi site menu was switched off for this company. The site waits until it is switched on again.');
  end if;
  if not exists (select 1 from public.msm_menu_sites s where s.menu_id = v.menu_id and s.location_id = p_location)
     or not public.msm__venue_in_org(p_location, v.org_id) then
    raise exception 'That site is not in this group menu.';
  end if;

  -- The contract (design review): only the keys this database knows. A newer publish runner
  -- against an older database, or the other way round, never half applies.
  if p_writes is null or jsonb_typeof(p_writes) <> 'object' then
    raise exception 'The writes for this site are missing. Nothing was written.';
  end if;
  select k into v_bad from jsonb_object_keys(p_writes) k where k <> all (v_write_keys) limit 1;
  if found then
    -- Only an OLDER runner reaches this (a newer one stops at msm_sql_contract first): the words say
    -- what really helps (17 Oct verification).
    raise exception 'Publish sent something this database does not know (%). The publish runner is older than the database: redeploy msm-publish, then press Retry. Nothing was written.', v_bad;
  end if;
  if jsonb_typeof(p_writes -> 'maps') = 'object' then
    select k into v_bad from jsonb_object_keys(p_writes -> 'maps') k where k <> all (v_map_keys) limit 1;
    if found then raise exception 'Publish sent a map this database does not know (%). Nothing was written.', v_bad; end if;
  end if;
  select k0.t || '.' || s.k into v_bad
    from (values ('menus'), ('categories'), ('items'), ('groups'), ('links')) k0(t)
    cross join lateral jsonb_object_keys(case when jsonb_typeof(p_writes -> k0.t) = 'object' then p_writes -> k0.t else '{}'::jsonb end) s(k)
   where s.k <> all (case when k0.t = 'links' then array['insert', 'delete'] else array['insert', 'update'] end)
   limit 1;
  if found then
    raise exception 'Publish sent something this database does not know (%). Nothing was written.', v_bad;
  end if;

  -- Lock every venue row the writes name, in id order, BEFORE the fingerprint (design review): a
  -- save that lands between the check and the write cannot be overwritten field by field.
  perform 1 from public.menus m
   where m.location_id = p_location and m.id in (select x ->> 'id' from jsonb_array_elements(coalesce(p_writes #> '{menus,update}', '[]'::jsonb)) x)
   order by m.id for update;
  perform 1 from public.menu_categories c
   where c.location_id = p_location and c.id in (select x ->> 'id' from jsonb_array_elements(coalesce(p_writes #> '{categories,update}', '[]'::jsonb)) x
                                                 union select x ->> 'category_id' from jsonb_array_elements(coalesce(p_writes #> '{links,delete}', '[]'::jsonb)) x)
   order by c.id for update;
  perform 1 from public.menu_items i
   where i.location_id = p_location and i.id in (select x ->> 'id' from jsonb_array_elements(coalesce(p_writes #> '{items,update}', '[]'::jsonb)) x)
   order by i.id for update;
  perform 1 from public.modifier_groups g
   where g.location_id = p_location and g.id in (select x ->> 'id' from jsonb_array_elements(coalesce(p_writes #> '{groups,update}', '[]'::jsonb)) x)
   order by g.id for update;
  if jsonb_typeof(p_writes -> 'routing') = 'array' and jsonb_array_length(p_writes -> 'routing') > 0 then
    perform 1 from public.print_routing r where r.location_id::text = p_location order by r.id for update;
  end if;

  if p_fingerprint is distinct from public.msm_venue_fingerprint(p_location) then
    return jsonb_build_object('ok', false, 'reason', 'changed', 'words', 'Someone saved the menu at this site while it was being published. Reading it again.');
  end if;
  -- The push carries the venue's instruction groups, profiles, discounts and printers from the
  -- latest push the function read. A Push to POS that landed since would be replaced by an older
  -- copy of them, so the function reads everything again.
  if p_last_push_id is distinct from (select cp.id from public.config_pushes cp where cp.location_id = p_location order by cp.created_at desc limit 1) then
    return jsonb_build_object('ok', false, 'reason', 'changed', 'words', 'A Push to POS landed at this site while it was being published. Reading it again.');
  end if;

  -- menus ----------------------------------------------------------------
  for w in select x from jsonb_array_elements(coalesce(p_writes #> '{menus,insert}', '[]'::jsonb)) x loop
    if not public.msm__keys_ok(w, v_ins_menus) then raise exception 'A new menu has a field publish may not write.'; end if;
    if exists (select 1 from public.menus m where m.id = w ->> 'id') then raise exception 'A new menu id is already taken (%).', w ->> 'id'; end if;
    insert into public.menus (id, location_id, name, description, is_default, is_active, sort_order, scope, org_id, created_at, updated_at)
    select r.id, p_location, coalesce(nullif(btrim(r.name), ''), 'Menu'), coalesce(r.description, ''), coalesce(r.is_default, false),
           coalesce(r.is_active, true), coalesce(r.sort_order, 0), 'local', v.org_id, v_now, v_now
      from jsonb_populate_record(null::public.menus, w) r;
    v_menus := v_menus || (w ->> 'id');
    v_menus_new := v_menus_new || (w ->> 'id');
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'menus', 'id', w ->> 'id', 'before', null, 'after', w));
  end loop;
  if jsonb_typeof(p_writes #> '{maps,menu_site}') = 'object' then
    update public.msm_menu_sites s set venue_menu_id = p_writes #>> '{maps,menu_site,venue_menu_id}'
     where s.menu_id = v.menu_id and s.location_id = p_location
       and exists (select 1 from public.menus m where m.id = p_writes #>> '{maps,menu_site,venue_menu_id}' and m.location_id = p_location);
  end if;
  for u in select x from jsonb_array_elements(coalesce(p_writes #> '{menus,update}', '[]'::jsonb)) x loop
    if not public.msm__keys_ok(u -> 'set', v_upd_menus) then raise exception 'A menu change has a field publish may not write.'; end if;
    select to_jsonb(m) into v_old from public.menus m where m.id = u ->> 'id' and m.location_id = p_location;
    if v_old is null then raise exception 'A menu is not at this site (%).', u ->> 'id'; end if;
    if not (u ->> 'id' = any (v_menus_new)
            or exists (select 1 from public.msm_menu_sites s where s.menu_id = v.menu_id and s.location_id = p_location and s.venue_menu_id = u ->> 'id')) then
      raise exception 'A change points at a menu this group menu does not manage. Nothing was written.';
    end if;
    update public.menus t set (name, description, updated_at) =
           (select r.name, r.description, v_now from jsonb_populate_record(t, u -> 'set') r)
     where t.id = u ->> 'id' and t.location_id = p_location;
    v_menus := v_menus || (u ->> 'id');
    select jsonb_object_agg(k, v_old -> k) into v_old from jsonb_object_keys(u -> 'set') k;
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'menus', 'id', u ->> 'id', 'before', v_old, 'after', u -> 'set'));
  end loop;

  -- categories (inserts arrive parents first) ----------------------------
  for w in select x from jsonb_array_elements(coalesce(p_writes #> '{categories,insert}', '[]'::jsonb)) x loop
    if not public.msm__keys_ok(w, v_ins_cats) then raise exception 'A new category has a field publish may not write.'; end if;
    if exists (select 1 from public.menu_categories c where c.id = w ->> 'id') then raise exception 'A new category id is already taken (%).', w ->> 'id'; end if;
    if w ->> 'menu_id' is not null and not exists (select 1 from public.menus m where m.id = w ->> 'menu_id' and m.location_id = p_location) then
      raise exception 'A new category points at a menu that is not at this site.';
    end if;
    if w ->> 'parent_id' is not null and not exists (select 1 from public.menu_categories c where c.id = w ->> 'parent_id' and c.location_id = p_location) then
      raise exception 'A new category points at a parent that is not at this site.';
    end if;
    insert into public.menu_categories (id, location_id, menu_id, parent_id, label, icon, color, accounting_group, sort_order, default_course, image, scope, org_id, created_at, updated_at)
    select r.id, p_location, r.menu_id, r.parent_id, coalesce(nullif(btrim(r.label), ''), 'Category'), coalesce(r.icon, chr(127869)), coalesce(r.color, '#3b82f6'),
           coalesce(r.accounting_group, ''), coalesce(r.sort_order, 0), coalesce(r.default_course, 1), r.image, 'local', v.org_id, v_now, v_now
      from jsonb_populate_record(null::public.menu_categories, w) r;
    v_cats := v_cats || (w ->> 'id');
    v_cats_new := v_cats_new || (w ->> 'id');
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'categories', 'id', w ->> 'id', 'before', null, 'after', w));
  end loop;
  for u in select x from jsonb_array_elements(coalesce(p_writes #> '{categories,update}', '[]'::jsonb)) x loop
    if not public.msm__keys_ok(u -> 'set', v_upd_cats) then raise exception 'A category change has a field publish may not write.'; end if;
    select to_jsonb(c) into v_old from public.menu_categories c where c.id = u ->> 'id' and c.location_id = p_location;
    if v_old is null then raise exception 'A category is not at this site (%).', u ->> 'id'; end if;
    if not public.msm__managed_category(v.menu_id, p_location, u ->> 'id', v_cats_new, p_writes) then
      raise exception 'A change points at a category this group menu does not manage. Nothing was written.';
    end if;
    if (u -> 'set') ? 'menu_id' and u #>> '{set,menu_id}' is not null and not exists (select 1 from public.menus m where m.id = u #>> '{set,menu_id}' and m.location_id = p_location) then
      raise exception 'A category would point at a menu that is not at this site.';
    end if;
    if (u -> 'set') ? 'parent_id' and u #>> '{set,parent_id}' is not null and (u #>> '{set,parent_id}' = u ->> 'id'
        or not exists (select 1 from public.menu_categories c where c.id = u #>> '{set,parent_id}' and c.location_id = p_location)) then
      raise exception 'A category would point at a parent that is not at this site.';
    end if;
    update public.menu_categories t
       set (menu_id, parent_id, label, icon, color, accounting_group, sort_order, default_course, image, updated_at) =
           (select r.menu_id, r.parent_id, r.label, r.icon, r.color, r.accounting_group, r.sort_order, r.default_course, r.image, v_now
              from jsonb_populate_record(t, u -> 'set') r)
     where t.id = u ->> 'id' and t.location_id = p_location;
    v_cats := v_cats || (u ->> 'id');
    select jsonb_object_agg(k, v_old -> k) into v_old from jsonb_object_keys(u -> 'set') k;
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'categories', 'id', u ->> 'id', 'before', v_old, 'after', u -> 'set'));
  end loop;

  -- new products, sub items for options included (before the groups that point at them) --------
  for w in select x from jsonb_array_elements(coalesce(p_writes #> '{items,insert}', '[]'::jsonb)) x loop
    if not public.msm__keys_ok(w, v_ins_items) or not public.msm__keys_ok(w -> 'pricing', v_pricing || array['menus']) then
      raise exception 'A new product has a field publish may not write.';
    end if;
    if exists (select 1 from public.menu_items i where i.id = w ->> 'id') then raise exception 'A new product id is already taken (%).', w ->> 'id'; end if;
    -- VAT per order type: the four keys, each a rate of THIS site (never a foreign id), or an
    -- explicit null (the site's default VAT) that a new size copies from its product's row.
    if w ? 'tax_overrides' and jsonb_typeof(w -> 'tax_overrides') <> 'null' and (jsonb_typeof(w -> 'tax_overrides') <> 'object'
       or exists (select 1 from jsonb_object_keys(w -> 'tax_overrides') k where k <> all (v_tax_keys))
       or exists (select 1 from jsonb_each(w -> 'tax_overrides') e
                   where jsonb_typeof(e.value) not in ('string', 'null')
                      or (jsonb_typeof(e.value) = 'string'
                          and not exists (select 1 from public.tax_rates r where r.id::text = e.value #>> '{}' and r.location_id::text = p_location)))) then
      raise exception 'A new product has VAT by order type that is not a rate at this site. Nothing was written.';
    end if;
    -- 20261209a: a new product may be born on a tax profile, the group product's tax by NAME:
    -- one of THIS site's own live profiles, never another site's id.
    if w ? 'tax_profile_id' and jsonb_typeof(w -> 'tax_profile_id') <> 'null'
       and (jsonb_typeof(w -> 'tax_profile_id') <> 'string'
            or not exists (select 1 from public.tax_profiles t
                            where t.id::text = w ->> 'tax_profile_id' and t.location_id::text = p_location and t.active is not false)) then
      raise exception 'A new product names a tax profile that is not one of this site''s. Nothing was written.';
    end if;
    insert into public.menu_items (id, location_id, name, menu_name, receipt_name, kitchen_name, description, type, cat, cats, parent_id, sort_order,
                                   pricing, allergens, assigned_modifier_groups, visibility, sold_alone, archived, tax_rate_id, image, scope, org_id,
                                   tags, item_code, tax_overrides, tax_profile_id, created_at, updated_at)
    select r.id, p_location, coalesce(r.name, 'Item'), r.menu_name, r.receipt_name, r.kitchen_name, coalesce(r.description, ''), coalesce(r.type, 'simple'),
           r.cat, coalesce(r.cats, '{}'), r.parent_id, coalesce(r.sort_order, 0), coalesce(r.pricing, '{"base": 0}'::jsonb), coalesce(r.allergens, '{}'),
           coalesce(r.assigned_modifier_groups, '[]'::jsonb), coalesce(r.visibility, '{"pos": true, "kiosk": true, "online": true}'::jsonb),
           coalesce(r.sold_alone, false), coalesce(r.archived, false), r.tax_rate_id, r.image, 'local', v.org_id, coalesce(r.tags, '[]'::jsonb),
           r.item_code, coalesce(r.tax_overrides, '{}'::jsonb), r.tax_profile_id, v_now, v_now
      from jsonb_populate_record(null::public.menu_items, w) r;
    v_items := v_items || (w ->> 'id');
    v_items_new := v_items_new || (w ->> 'id');
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'items', 'id', w ->> 'id', 'before', null, 'after', w));
  end loop;

  -- new option groups ("Then ask" groups arrive first) -------------------
  for w in select x from jsonb_array_elements(coalesce(p_writes #> '{groups,insert}', '[]'::jsonb)) x loop
    if not public.msm__keys_ok(w, v_ins_groups) then raise exception 'A new modifier group has a field publish may not write.'; end if;
    if exists (select 1 from public.modifier_groups g where g.id = w ->> 'id') then raise exception 'A new modifier group id is already taken (%).', w ->> 'id'; end if;
    if jsonb_typeof(w -> 'options') = 'array' then
      if exists (select 1 from jsonb_array_elements(w -> 'options') e
                  where jsonb_typeof(e) <> 'object' or not public.msm__keys_ok(e, v_opt_keys) or coalesce(e ->> 'id', '') = ''
                     or (e ? 'price' and jsonb_typeof(e -> 'price') <> 'number')) then
        raise exception 'A new option group has an option publish may not write.';
      end if;
      if (select count(*) from jsonb_array_elements(w -> 'options')) <> (select count(distinct e ->> 'id') from jsonb_array_elements(w -> 'options') e) then
        raise exception 'A new option group has two options with one id.';
      end if;
      if exists (select 1 from jsonb_array_elements(w -> 'options') e
                  where (e ->> 'itemId' is not null and not exists (select 1 from public.menu_items i where i.id = e ->> 'itemId' and i.location_id = p_location))
                     or (e ->> 'subGroupId' is not null and not exists (select 1 from public.modifier_groups g where g.id = e ->> 'subGroupId' and g.location_id = p_location))) then
        raise exception 'An option would point at a product or option group that is not at this site. Nothing was written.';
      end if;
    end if;
    insert into public.modifier_groups (id, location_id, name, min_select, max_select, sort_order, min, max, selection_type, options, created_at)
    select r.id, p_location, coalesce(r.name, 'Options'), coalesce(r.min_select, r.min, 0), coalesce(r.max_select, r.max, 1), coalesce(r.sort_order, 0),
           coalesce(r.min, 0), coalesce(r.max, 1), coalesce(r.selection_type, 'single'), coalesce(r.options, '[]'::jsonb), v_now
      from jsonb_populate_record(null::public.modifier_groups, w) r;
    v_groups := v_groups || (w ->> 'id');
    v_groups_new := v_groups_new || (w ->> 'id');
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'groups', 'id', w ->> 'id', 'before', null, 'after', w));
  end loop;

  -- option groups in place, options one by one by the venue option id ---
  for u in select x from jsonb_array_elements(coalesce(p_writes #> '{groups,update}', '[]'::jsonb)) x loop
    v_set := coalesce(u -> 'set', '{}'::jsonb);
    if not public.msm__keys_ok(v_set, v_upd_groups) then raise exception 'An option group change has a field publish may not write.'; end if;
    select to_jsonb(g) into v_old from public.modifier_groups g where g.id = u ->> 'id' and g.location_id = p_location;
    if v_old is null then raise exception 'An option group is not at this site (%).', u ->> 'id'; end if;
    if not public.msm__managed_group(v.menu_id, p_location, u ->> 'id', v_groups_new) then
      raise exception 'A change points at an option group this group menu does not manage. Nothing was written.';
    end if;
    if exists (select 1 from jsonb_each(v_set) e where e.key in ('min', 'max', 'min_select', 'max_select')
                and (jsonb_typeof(e.value) <> 'number' or (e.value #>> '{}')::numeric not between 0 and 999))
       or (v_set ? 'selection_type' and coalesce(v_set ->> 'selection_type', '') <> all (array['single', 'multiple', 'quantity']))
       or (v_set ? 'name' and coalesce(btrim(v_set ->> 'name'), '') = '') then
      raise exception 'An option group change is not a rule the till can use. Nothing was written.';
    end if;
    v_opts := case when jsonb_typeof(v_old -> 'options') = 'array' then v_old -> 'options' else '[]'::jsonb end;
    for op in select x from jsonb_array_elements(coalesce(u -> 'options', '[]'::jsonb)) x loop
      v_entry := case when op ->> 'op' = 'add' then op -> 'entry' else op -> 'set' end;
      if v_entry is not null and jsonb_typeof(v_entry) = 'object' and (
           (v_entry ? 'price' and jsonb_typeof(v_entry -> 'price') <> 'number')
        or (v_entry ->> 'itemId' is not null and not exists (select 1 from public.menu_items i where i.id = v_entry ->> 'itemId' and i.location_id = p_location))
        or (v_entry ->> 'subGroupId' is not null and not exists (select 1 from public.modifier_groups g where g.id = v_entry ->> 'subGroupId' and g.location_id = p_location))) then
        raise exception 'An option would point at a product or option group that is not at this site, or has no price. Nothing was written.';
      end if;
      v_idx := null;
      if op ->> 'op' = 'patch' then
        if not public.msm__keys_ok(coalesce(op -> 'set', '{}'::jsonb), v_opt_patch)
           or (jsonb_typeof(op -> 'unset') = 'array' and exists (select 1 from jsonb_array_elements_text(op -> 'unset') k where k not in ('itemId', 'subGroupId'))) then
          raise exception 'An option change has a field publish may not write.';
        end if;
        select (e.ord - 1)::integer into v_idx from jsonb_array_elements(v_opts) with ordinality e(x, ord) where e.x ->> 'id' = op ->> 'id' limit 1;
        if v_idx is null then raise exception 'An option is not in this site''s group any more (%). Nothing was written.', op ->> 'id'; end if;
        v_entry := (v_opts -> v_idx) || coalesce(op -> 'set', '{}'::jsonb);
        if jsonb_typeof(op -> 'unset') = 'array' then
          v_entry := v_entry - array(select jsonb_array_elements_text(op -> 'unset'));
        end if;
        v_opts := jsonb_set(v_opts, array[v_idx::text], v_entry);
      elsif op ->> 'op' = 'add' then
        v_entry := op -> 'entry';
        if jsonb_typeof(v_entry) <> 'object' or not public.msm__keys_ok(v_entry, v_opt_keys) or coalesce(v_entry ->> 'id', '') = '' then
          raise exception 'A new option has a field publish may not write.';
        end if;
        if exists (select 1 from jsonb_array_elements(v_opts) e where e ->> 'id' = v_entry ->> 'id') then
          raise exception 'An option id is already in this site''s group (%). Nothing was written.', v_entry ->> 'id';
        end if;
        if op ->> 'after' is not null then
          select (e.ord - 1)::integer into v_idx from jsonb_array_elements(v_opts) with ordinality e(x, ord) where e.x ->> 'id' = op ->> 'after' limit 1;
          if v_idx is not null then v_opts := jsonb_insert(v_opts, array[v_idx::text], v_entry, true); end if;
        elsif op ->> 'before' is not null then
          select (e.ord - 1)::integer into v_idx from jsonb_array_elements(v_opts) with ordinality e(x, ord) where e.x ->> 'id' = op ->> 'before' limit 1;
          if v_idx is not null then v_opts := jsonb_insert(v_opts, array[v_idx::text], v_entry, false); end if;
        end if;
        if v_idx is null then v_opts := v_opts || jsonb_build_array(v_entry); end if;
      elsif op ->> 'op' = 'drop' then
        if not exists (select 1 from jsonb_array_elements(v_opts) e where e ->> 'id' = op ->> 'id') then
          raise exception 'An option is not in this site''s group any more (%). Nothing was written.', op ->> 'id';
        end if;
        select coalesce(jsonb_agg(e.x order by e.ord), '[]'::jsonb) into v_opts
          from jsonb_array_elements(v_opts) with ordinality e(x, ord) where e.x ->> 'id' is distinct from op ->> 'id';
      elsif op ->> 'op' = 'order' then
        if jsonb_typeof(op -> 'ids') <> 'array'
           or (select count(*) from jsonb_array_elements(v_opts) e where e ->> 'id' in (select jsonb_array_elements_text(op -> 'ids')))
              <> jsonb_array_length(op -> 'ids') then
          raise exception 'The option order does not match this site''s group. Nothing was written.';
        end if;
        -- The group menu's options take the places they already hold, in its order; options the
        -- group menu does not know keep their places.
        with cur as (select e.x, e.ord from jsonb_array_elements(v_opts) with ordinality e(x, ord)),
             slots as (select c.ord, row_number() over (order by c.ord) as rn from cur c where c.x ->> 'id' in (select jsonb_array_elements_text(op -> 'ids'))),
             wanted as (select w2.value as id, w2.ordinality as rn from jsonb_array_elements_text(op -> 'ids') with ordinality w2)
        select coalesce(jsonb_agg(case when s.ord is not null then (select c2.x from cur c2 where c2.x ->> 'id' = wt.id) else c.x end order by c.ord), '[]'::jsonb)
          into v_opts
          from cur c left join slots s on s.ord = c.ord left join wanted wt on wt.rn = s.rn;
      else
        raise exception 'Publish sent an option change this database does not know. Nothing was written.';
      end if;
    end loop;
    if (select count(*) from jsonb_array_elements(v_opts)) <> (select count(distinct e ->> 'id') from jsonb_array_elements(v_opts) e) then
      raise exception 'An option group would hold two options with one id. Nothing was written.';
    end if;
    update public.modifier_groups t
       set (name, min, max, min_select, max_select, selection_type, options) =
           (select r.name, r.min, r.max, r.min_select, r.max_select, r.selection_type, v_opts from jsonb_populate_record(t, v_set) r)
     where t.id = u ->> 'id' and t.location_id = p_location;
    v_groups := v_groups || (u ->> 'id');
    select jsonb_object_agg(k, v_old -> k) into v_new from jsonb_object_keys(v_set) k;
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'groups', 'id', u ->> 'id',
                 'before', coalesce(v_new, '{}'::jsonb) || case when jsonb_array_length(coalesce(u -> 'options', '[]'::jsonb)) > 0 then jsonb_build_object('options', v_old -> 'options') else '{}'::jsonb end,
                 'after', v_set || case when jsonb_array_length(coalesce(u -> 'options', '[]'::jsonb)) > 0 then jsonb_build_object('options', v_opts) else '{}'::jsonb end));
  end loop;

  -- products in place -----------------------------------------------------
  for u in select x from jsonb_array_elements(coalesce(p_writes #> '{items,update}', '[]'::jsonb)) x loop
    if not public.msm__keys_ok(coalesce(u -> 'set', '{}'::jsonb), v_upd_items) or not public.msm__keys_ok(u -> 'pricing', v_pricing)
       or not public.msm__keys_ok(u -> 'tax_overrides', array['set', 'remove']) then
      raise exception 'A product change has a field publish may not write.';
    end if;
    select to_jsonb(i) into v_old from public.menu_items i where i.id = u ->> 'id' and i.location_id = p_location;
    if v_old is null then raise exception 'A product is not at this site (%).', u ->> 'id'; end if;
    if not public.msm__managed_item(v.menu_id, p_location, u ->> 'id', v_items_new) then
      raise exception 'A change points at a product this group menu does not manage. Nothing was written.';
    end if;
    -- Only the references this change SETS to a new value are checked (a price change never
    -- refuses a site over an old link the venue already had).
    v_set := coalesce(u -> 'set', '{}'::jsonb);
    if (v_set ? 'cat' and v_set ->> 'cat' is not null and v_set ->> 'cat' is distinct from v_old ->> 'cat'
          and not exists (select 1 from public.menu_categories c where c.id = v_set ->> 'cat' and c.location_id = p_location))
       or (jsonb_typeof(v_set -> 'cats') = 'array' and exists (
             select 1 from jsonb_array_elements_text(v_set -> 'cats') x
              where not (coalesce(v_old -> 'cats', '[]'::jsonb) ? x)
                and not exists (select 1 from public.menu_categories c where c.id = x and c.location_id = p_location)))
       or (v_set ? 'parent_id' and v_set ->> 'parent_id' is not null and v_set ->> 'parent_id' is distinct from v_old ->> 'parent_id'
             and not exists (select 1 from public.menu_items p where p.id = v_set ->> 'parent_id' and p.location_id = p_location))
       or (v_set ? 'tax_rate_id' and v_set ->> 'tax_rate_id' is not null and v_set ->> 'tax_rate_id' is distinct from v_old ->> 'tax_rate_id'
             and not exists (select 1 from public.tax_rates r where r.id::text = v_set ->> 'tax_rate_id' and r.location_id::text = p_location))
       or (jsonb_typeof(v_set -> 'assigned_modifier_groups') = 'array' and exists (
             select 1 from jsonb_array_elements(v_set -> 'assigned_modifier_groups') a
              where a ->> 'groupId' is not null
                and not exists (select 1 from jsonb_array_elements(coalesce(v_old -> 'assigned_modifier_groups', '[]'::jsonb)) o where o ->> 'groupId' = a ->> 'groupId')
                and not exists (select 1 from public.modifier_groups g where g.id = a ->> 'groupId' and g.location_id = p_location))) then
      raise exception 'A product would point at a category, size, tax rate or modifier group that is not at this site. Nothing was written.';
    end if;
    -- VAT per order type, as a patch of the four keys (every other key and every explicit null the
    -- site has stays exactly as it is: design review blocker 2). Rates of THIS site only, or an
    -- explicit null (the site's default VAT) a size copies from its product's row (17 Oct recheck:
    -- a size takes its product's four keys, as Menu Manager cascades them).
    if jsonb_typeof(u -> 'tax_overrides') = 'object' and (
         (u #> '{tax_overrides,set}' is not null and (jsonb_typeof(u #> '{tax_overrides,set}') <> 'object'
            or exists (select 1 from jsonb_each(u #> '{tax_overrides,set}') e
                        where e.key <> all (v_tax_keys) or jsonb_typeof(e.value) not in ('string', 'null')
                           or (jsonb_typeof(e.value) = 'string'
                               and not exists (select 1 from public.tax_rates r where r.id::text = e.value #>> '{}' and r.location_id::text = p_location)))))
      or (u #> '{tax_overrides,remove}' is not null and (jsonb_typeof(u #> '{tax_overrides,remove}') <> 'array'
            or exists (select 1 from jsonb_array_elements_text(u #> '{tax_overrides,remove}') k where k <> all (v_tax_keys))))) then
      raise exception 'VAT by order type for a product is not a rate at this site. Nothing was written.';
    end if;
    -- No price (17 Oct recheck): a site that keeps "no price" for this product is never given a
    -- Standard price by publish (a change that sets one there takes no_price away first).
    if jsonb_typeof(u -> 'pricing') = 'object' and u -> 'pricing' ? 'base' and jsonb_typeof(u #> '{pricing,base}') <> 'null'
       and exists (select 1 from public.msm_product_sites ps join public.msm_products p on p.id = ps.product_id
                    where p.menu_id = v.menu_id and ps.location_id = p_location and ps.venue_item_id = u ->> 'id'
                      and ps.kept -> 'no_price' = 'true'::jsonb and ps.price is null) then
      raise exception 'A product with no price at this site would get one that nobody set there. Nothing was written.';
    end if;
    -- 20261209a adds two more ways, both tied to the group product this row belongs to:
    --   set to one of THIS site's own live profiles whose name is the group product's tax name
    --     (a name with no percent: msmPlan taxProfileFor), and
    --   cleared when the group product names no tax at all (each site's own tax again).
    -- tax_profile_id in exactly two ways (design review blocker 3): cleared over a profile that is
    -- still a generated copy of the item's own rate (after this write, or before it when the same
    -- write changes the rate: 17 Oct verification, a new VAT rate over a copy of the old one would
    -- have kept charging the old rate), remembered so it can come back; or that same remembered
    -- copy put back. Anything else is refused.
    if v_set ? 'tax_profile_id' then
      v_rate_after := case when v_set ? 'tax_rate_id' then v_set ->> 'tax_rate_id' else v_old ->> 'tax_rate_id' end;
      v_prof_old := v_old ->> 'tax_profile_id';
      v_prof_new := v_set ->> 'tax_profile_id';
      v_cleared := null; v_product := null;
      select ps.cleared_tax_profile_id, ps.product_id into v_cleared, v_product
        from public.msm_product_sites ps join public.msm_products p on p.id = ps.product_id
       where p.menu_id = v.menu_id and ps.location_id = p_location and ps.venue_item_id = u ->> 'id';
      if v_prof_new is null then
        if v_prof_old is not null and v_product is not null
           and (public.msm__is_legacy_mirror(v_prof_old::uuid, nullif(v_rate_after, '')::uuid)
                or public.msm__is_legacy_mirror(v_prof_old::uuid, nullif(v_old ->> 'tax_rate_id', '')::uuid)) then
          update public.msm_product_sites set cleared_tax_profile_id = v_prof_old::uuid, updated_at = v_now
           where product_id = v_product and location_id = p_location;
        elsif v_prof_old is not null and v_product is not null
           and exists (select 1 from public.msm_products gp
                        where gp.id = v_product and nullif(btrim(coalesce(gp.tax_rate_name, '')), '') is null and gp.tax_rate_percent is null) then
          null;   -- 20261209a: the group product names no tax now, so the profile comes off
        else
          raise exception 'Publish may only clear an old copy of a product''s own VAT rate, or a tax profile the group menu no longer names. Nothing was written.';
        end if;
      else
        if v_prof_old is null and v_cleared is not null and v_cleared::text = v_prof_new
           and exists (select 1 from public.tax_profiles t where t.id::text = v_prof_new and t.location_id::text = p_location)
           and public.msm__is_legacy_mirror(v_prof_new::uuid, nullif(v_rate_after, '')::uuid) then
          update public.msm_product_sites set cleared_tax_profile_id = null, updated_at = v_now
           where product_id = v_product and location_id = p_location;
        elsif v_product is not null
           and exists (select 1 from public.tax_profiles t join public.msm_products gp on gp.id = v_product
                        where t.id::text = v_prof_new and t.location_id::text = p_location and t.active is not false
                          and t.generated_from_rate_id is null and gp.tax_rate_percent is null
                          and nullif(btrim(coalesce(gp.tax_rate_name, '')), '') is not null
                          and lower(btrim(t.name)) = lower(btrim(gp.tax_rate_name))) then
          null;   -- 20261209a: the group product names this site's own tax profile
        else
          raise exception 'Publish may only put back the old VAT profile copy it cleared, or set a tax profile the group menu names for this product. Nothing was written.';
        end if;
      end if;
    end if;
    update public.menu_items t
       set (name, menu_name, receipt_name, kitchen_name, description, type, cat, cats, parent_id, allergens, assigned_modifier_groups,
            visibility, sold_alone, archived, tax_rate_id, image, tags, item_code, tax_profile_id, tax_overrides, pricing, updated_at) =
           (select r.name, r.menu_name, r.receipt_name, r.kitchen_name, r.description, r.type,
                   r.cat, r.cats, r.parent_id, r.allergens, r.assigned_modifier_groups,
                   r.visibility, r.sold_alone, r.archived, r.tax_rate_id, r.image, r.tags,
                   r.item_code, r.tax_profile_id,
                   case when jsonb_typeof(u -> 'tax_overrides') = 'object'
                        then (case when jsonb_typeof(t.tax_overrides) = 'object' then t.tax_overrides else '{}'::jsonb end
                              - coalesce(array(select jsonb_array_elements_text(case when jsonb_typeof(u #> '{tax_overrides,remove}') = 'array' then u #> '{tax_overrides,remove}' else '[]'::jsonb end)), '{}'::text[]))
                             || coalesce(case when jsonb_typeof(u #> '{tax_overrides,set}') = 'object' then u #> '{tax_overrides,set}' end, '{}'::jsonb)
                        else t.tax_overrides end,
                   case when jsonb_typeof(u -> 'pricing') = 'object' then coalesce(t.pricing, '{}'::jsonb) || (u -> 'pricing') else t.pricing end,
                   v_now
              from jsonb_populate_record(t, coalesce(u -> 'set', '{}'::jsonb)) r)
     where t.id = u ->> 'id' and t.location_id = p_location;
    v_items := v_items || (u ->> 'id');
    select jsonb_object_agg(k, v_old -> k) into v_new from jsonb_object_keys(coalesce(u -> 'set', '{}'::jsonb)) k;
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'items', 'id', u ->> 'id',
                 'before', coalesce(v_new, '{}'::jsonb)
                           || case when jsonb_typeof(u -> 'pricing') = 'object'
                                   then jsonb_build_object('pricing', (select jsonb_object_agg(k, v_old #> array['pricing', k]) from jsonb_object_keys(u -> 'pricing') k))
                                   else '{}'::jsonb end
                           || case when jsonb_typeof(u -> 'tax_overrides') = 'object'
                                   then jsonb_build_object('tax_overrides', coalesce(v_old -> 'tax_overrides', '{}'::jsonb))
                                   else '{}'::jsonb end,
                 'after', coalesce(u -> 'set', '{}'::jsonb)
                          || case when jsonb_typeof(u -> 'pricing') = 'object' then jsonb_build_object('pricing', u -> 'pricing') else '{}'::jsonb end
                          || case when jsonb_typeof(u -> 'tax_overrides') = 'object'
                                  then jsonb_build_object('tax_overrides', (select to_jsonb(i.tax_overrides) from public.menu_items i where i.id = u ->> 'id' and i.location_id = p_location))
                                  else '{}'::jsonb end));
  end loop;
  -- Every NEW product points only at this venue's own rows (changed ones were checked above).
  if exists (
    select 1 from public.menu_items i
     where i.location_id = p_location and i.id = any (v_items_new)
       and ((i.cat is not null and not exists (select 1 from public.menu_categories c where c.id = i.cat and c.location_id = p_location))
         or exists (select 1 from unnest(i.cats) x where not exists (select 1 from public.menu_categories c where c.id = x and c.location_id = p_location))
         or (i.parent_id is not null and not exists (select 1 from public.menu_items p where p.id = i.parent_id and p.location_id = p_location))
         or (i.tax_rate_id is not null and not exists (select 1 from public.tax_rates r where r.id = i.tax_rate_id and r.location_id::text = p_location))
         or exists (select 1 from jsonb_array_elements(coalesce(i.assigned_modifier_groups, '[]'::jsonb)) a
                     where a ->> 'groupId' is not null and not exists (select 1 from public.modifier_groups g where g.id = a ->> 'groupId' and g.location_id = p_location)))) then
    raise exception 'A product would point at a category, size, tax rate or modifier group that is not at this site. Nothing was written.';
  end if;

  -- category links ------------------------------------------------------
  for w in select x from jsonb_array_elements(coalesce(p_writes #> '{links,insert}', '[]'::jsonb)) x loop
    if not exists (select 1 from public.menus m where m.id = w ->> 'menu_id' and m.location_id = p_location)
       or not exists (select 1 from public.menu_categories c where c.id = w ->> 'category_id' and c.location_id = p_location) then
      raise exception 'A menu link points outside this site.';
    end if;
    insert into public.menu_category_links (menu_id, category_id, sort_order)
    values (w ->> 'menu_id', w ->> 'category_id', coalesce((w ->> 'sort_order')::integer, 0))
    on conflict (menu_id, category_id) do nothing;
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'links', 'id', (w ->> 'menu_id') || '|' || (w ->> 'category_id'), 'before', null, 'after', w));
  end loop;
  for w in select x from jsonb_array_elements(coalesce(p_writes #> '{links,delete}', '[]'::jsonb)) x loop
    if not exists (select 1 from public.menus m where m.id = w ->> 'menu_id' and m.location_id = p_location) then
      raise exception 'A menu link points outside this site.';
    end if;
    if not public.msm__managed_category(v.menu_id, p_location, w ->> 'category_id', v_cats_new, p_writes) then
      raise exception 'A change points at a category this group menu does not manage. Nothing was written.';
    end if;
    delete from public.menu_category_links l where l.menu_id = w ->> 'menu_id' and l.category_id = w ->> 'category_id';
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'links', 'id', (w ->> 'menu_id') || '|' || (w ->> 'category_id'), 'before', w, 'after', null));
  end loop;

  -- (Round 1's "option prices and names follow their sub item" block is GONE: option prices are
  -- set on the option, round 2 design 1.4.)

  -- print routing for new categories (review blocker 1) ------------------
  for w in select x from jsonb_array_elements(coalesce(p_writes -> 'routing', '[]'::jsonb)) x loop
    if not exists (select 1 from public.menu_categories c where c.id = w ->> 'category_id' and c.location_id = p_location) then
      raise exception 'A printer route points at a category that is not at this site.';
    end if;
    update public.print_routing r
       set routing = jsonb_set(coalesce(r.routing, '{}'::jsonb), array[w ->> 'centre_id'],
                               coalesce(r.routing -> (w ->> 'centre_id'), '{"excludedItems": []}'::jsonb)
                               || jsonb_build_object('assignedCategories',
                                    (select coalesce(jsonb_agg(distinct x), '[]'::jsonb)
                                       from jsonb_array_elements_text(coalesce(r.routing #> array[w ->> 'centre_id', 'assignedCategories'], '[]'::jsonb) || jsonb_build_array(w ->> 'category_id')) x)),
                               true),
           updated_at = v_now
     where r.location_id::text = p_location
       and exists (select 1 from jsonb_array_elements(coalesce(r.centres, '[]'::jsonb)) c where c ->> 'id' = w ->> 'centre_id');
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then raise exception 'A printer or kitchen screen for a new category is not at this site.'; end if;
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'routing', 'id', w ->> 'centre_id', 'before', null, 'after', w));
  end loop;

  -- the central id maps for rows this publish created --------------------
  for w in select x from jsonb_array_elements(coalesce(p_writes #> '{maps,categories}', '[]'::jsonb)) x loop
    if not exists (select 1 from public.msm_categories c where c.id = (w ->> 'category_id')::uuid and c.menu_id = v.menu_id)
       or not exists (select 1 from public.menu_categories c where c.id = w ->> 'venue_category_id' and c.location_id = p_location) then
      raise exception 'A category map points outside this group menu or site.';
    end if;
    insert into public.msm_category_sites (category_id, location_id, venue_category_id)
    values ((w ->> 'category_id')::uuid, p_location, w ->> 'venue_category_id')
    on conflict (category_id, location_id) do update set venue_category_id = excluded.venue_category_id;
  end loop;
  for w in select x from jsonb_array_elements(coalesce(p_writes #> '{maps,groups}', '[]'::jsonb)) x loop
    if not exists (select 1 from public.msm_modifier_groups g where g.id = (w ->> 'group_id')::uuid and g.menu_id = v.menu_id)
       or not exists (select 1 from public.modifier_groups g where g.id = w ->> 'venue_group_id' and g.location_id = p_location) then
      raise exception 'A modifier group map points outside this group menu or site.';
    end if;
    insert into public.msm_modifier_group_sites (group_id, location_id, venue_group_id)
    values ((w ->> 'group_id')::uuid, p_location, w ->> 'venue_group_id')
    on conflict (group_id, location_id) do update set venue_group_id = excluded.venue_group_id;
  end loop;
  -- A new option's id at this site, recorded in the same transaction (an entry already carrying it
  -- was adopted by the planner, so a second run never adds it twice). Set once, never changed.
  for w in select x from jsonb_array_elements(coalesce(p_writes #> '{maps,options}', '[]'::jsonb)) x loop
    v_vg := null;
    select gs.venue_group_id into v_vg
      from public.msm_modifier_options o join public.msm_modifier_group_sites gs on gs.group_id = o.group_id and gs.location_id = p_location
     where o.id = (w ->> 'option_id')::uuid and o.menu_id = v.menu_id;
    if v_vg is null or coalesce(w ->> 'venue_option_id', '') = ''
       or not exists (select 1 from public.modifier_groups g where g.id = v_vg and g.location_id = p_location
                        and jsonb_typeof(g.options) = 'array' and g.options @> jsonb_build_array(jsonb_build_object('id', w ->> 'venue_option_id'))) then
      raise exception 'An option map points outside this group menu or this site''s group.';
    end if;
    if exists (select 1 from public.msm_modifier_option_sites os2 join public.msm_modifier_options o2 on o2.id = os2.option_id
                where os2.location_id = p_location and os2.venue_option_id = w ->> 'venue_option_id' and os2.option_id <> (w ->> 'option_id')::uuid
                  and o2.group_id = (select o3.group_id from public.msm_modifier_options o3 where o3.id = (w ->> 'option_id')::uuid)) then
      raise exception 'Another option of this group already has that id at this site. Nothing was written.';
    end if;
    insert into public.msm_modifier_option_sites as t (option_id, location_id, venue_option_id, active)
    values ((w ->> 'option_id')::uuid, p_location, w ->> 'venue_option_id', true)
    on conflict (option_id, location_id) do update set venue_option_id = excluded.venue_option_id, updated_at = v_now
     where t.venue_option_id is null or t.venue_option_id = excluded.venue_option_id;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then raise exception 'An option already has another id at this site. Nothing was written.'; end if;
  end loop;
  -- A sub item this publish added at the site for an option (option only), recorded centrally.
  for w in select x from jsonb_array_elements(coalesce(p_writes #> '{maps,items}', '[]'::jsonb)) x loop
    if not exists (select 1 from public.msm_products p where p.id = (w ->> 'product_id')::uuid and p.menu_id = v.menu_id)
       or not ((w ->> 'venue_item_id') = any (v_items_new)) then
      raise exception 'A sub item map points outside this group menu or this publish.';
    end if;
    if w ? 'active' and jsonb_typeof(w -> 'active') <> 'boolean' then
      raise exception 'A sub item map has an on or off that is not true or false.';
    end if;
    insert into public.msm_product_sites (product_id, location_id, venue_item_id, active)
    values ((w ->> 'product_id')::uuid, p_location, w ->> 'venue_item_id', coalesce((w ->> 'active')::boolean, true))
    on conflict (product_id, location_id) do nothing;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then raise exception 'That sub item is already at this site under another id. Nothing was written.'; end if;
  end loop;

  v_any := jsonb_array_length(v_audit) > 0;

  -- the config push: the same till refresh as Push to POS ----------------
  if v_any then
    if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' or p_snapshot ->> 'locationId' is distinct from p_location then
      raise exception 'The push for this site is missing or for another site. Nothing was written.';
    end if;
    -- Written rows carry the server time they now hold, so an open Back Office sees the change,
    -- and the VAT they now hold (the database applied the patch to the row it locked).
    v_snap := p_snapshot;
    if jsonb_typeof(v_snap -> 'menuItems') = 'array' then
      v_snap := jsonb_set(v_snap, '{menuItems}', (
        select coalesce(jsonb_agg(case when x.e ->> 'id' = any (v_items)
                                       then x.e || jsonb_build_object('updated_at', v_nowj, 'srvAt', v_nowj)
                                                || coalesce((select jsonb_build_object('tax_overrides', coalesce(i.tax_overrides, '{}'::jsonb), 'taxOverrides', coalesce(i.tax_overrides, '{}'::jsonb),
                                                                                       'tax_profile_id', i.tax_profile_id, 'taxProfileId', i.tax_profile_id)
                                                               from public.menu_items i where i.id = x.e ->> 'id' and i.location_id = p_location), '{}'::jsonb)
                                       else x.e end order by x.ord), '[]'::jsonb)
          from jsonb_array_elements(v_snap -> 'menuItems') with ordinality as x(e, ord)));
    end if;
    if jsonb_typeof(v_snap -> 'menuCategories') = 'array' then
      v_snap := jsonb_set(v_snap, '{menuCategories}', (select coalesce(jsonb_agg(case when e ->> 'id' = any (v_cats) then e || jsonb_build_object('updated_at', v_nowj, 'srvAt', v_nowj) else e end order by ord), '[]'::jsonb)
                                                        from jsonb_array_elements(v_snap -> 'menuCategories') with ordinality as x(e, ord)));
    end if;
    if jsonb_typeof(v_snap -> 'menus') = 'array' then
      v_snap := jsonb_set(v_snap, '{menus}', (select coalesce(jsonb_agg(case when e ->> 'id' = any (v_menus) then e || jsonb_build_object('updated_at', v_nowj, 'srvAt', v_nowj) else e end order by ord), '[]'::jsonb)
                                               from jsonb_array_elements(v_snap -> 'menus') with ordinality as x(e, ord)));
    end if;
    -- Every option group written here, rebuilt from the row it now holds (design review): the
    -- tills replace their groups from the push while kiosk, online, QR and the price fence read the
    -- table, so the two can never disagree. The same shape as venueMenuCore mapModifierGroupRow.
    if cardinality(v_groups) > 0 then
      v_snap := jsonb_set(v_snap, '{modifierGroupDefs}', (
        select coalesce(jsonb_agg(case when g.id is not null
                                       then jsonb_build_object('id', g.id, 'name', g.name, 'min', coalesce(g.min, 0), 'max', coalesce(g.max, 1),
                                                               'selectionType', coalesce(g.selection_type, 'single'),
                                                               'options', case when jsonb_typeof(g.options) = 'array' then g.options else '[]'::jsonb end,
                                                               'sortOrder', coalesce(g.sort_order, 0), 'srvAt', null, 'locationId', g.location_id)
                                       else x.e end order by x.ord), '[]'::jsonb)
          from jsonb_array_elements(case when jsonb_typeof(v_snap -> 'modifierGroupDefs') = 'array' then v_snap -> 'modifierGroupDefs' else '[]'::jsonb end) with ordinality as x(e, ord)
          left join public.modifier_groups g on g.id = x.e ->> 'id' and g.location_id = p_location and g.id = any (v_groups)));
      v_snap := jsonb_set(v_snap, '{modifierGroupDefs}', (v_snap -> 'modifierGroupDefs') || coalesce((
        select jsonb_agg(jsonb_build_object('id', g.id, 'name', g.name, 'min', coalesce(g.min, 0), 'max', coalesce(g.max, 1),
                                            'selectionType', coalesce(g.selection_type, 'single'),
                                            'options', case when jsonb_typeof(g.options) = 'array' then g.options else '[]'::jsonb end,
                                            'sortOrder', coalesce(g.sort_order, 0), 'srvAt', null, 'locationId', g.location_id) order by g.sort_order, g.id)
          from public.modifier_groups g
         where g.location_id = p_location and g.id = any (v_groups)
           and not exists (select 1 from jsonb_array_elements(v_snap -> 'modifierGroupDefs') e where e ->> 'id' = g.id)), '[]'::jsonb));
    end if;
    insert into public.config_pushes (location_id, pushed_by, snapshot, change_count)
    values (p_location, left(coalesce(nullif(btrim(p_pushed_by), ''), 'Multi site menu'), 120), v_snap, jsonb_array_length(v_audit))
    returning id into v_push;
    begin
      v_uuid := p_location::uuid;
      insert into public.activity_events (location_id, kind, severity, title, body, ref_type, ref_id, actor_name)
      values (v_uuid, 'menu', 'info', 'Head office menu update', left(coalesce(p_summary, 'The group menu was published here.'), 600),
              'msm_version', p_version::text, left(coalesce(v.created_by_name, 'Multi site menu'), 120));
    exception when invalid_text_representation then
      null;   -- a venue id that is not a uuid has no activity feed
    end;
  end if;

  update public.msm_version_sites
     set status = case when v_any then 'done' else 'nothing' end, finished_at = v_now, push_id = v_push,
         counts = coalesce(p_counts, '{}'::jsonb), writes = v_audit, error = null
   where version_id = p_version and location_id = p_location;
  update public.msm_menu_sites
     set last_version_no = v.version_no, last_push_id = coalesce(v_push, last_push_id), last_done_at = v_now, last_error = null
   where menu_id = v.menu_id and location_id = p_location;
  perform public.msm__refresh_version(p_version);
  return jsonb_build_object('ok', true, 'already', false, 'push_id', v_push, 'written', jsonb_array_length(v_audit));
end
$function$;

-- The body now in place (expect one row, and the three new lines counted 1 each).
select md5(p.prosrc) as body_md5,
       (p.prosrc like '%20261209a: a new product may be born on a tax profile%')::int as new_product_rule,
       (p.prosrc like '%20261209a: the group product names this site''s own tax profile%')::int as set_rule,
       (p.prosrc like '%20261209a: the group product names no tax now%')::int as clear_rule
  from pg_proc p where p.proname = 'msm_apply_site';
