-- 20261017c_OPS_multi_site_menu_groups_ROLLBACK.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Undoes 20261017c_OPS_multi_site_menu_groups.sql and puts the round 1     #
-- #  functions back exactly as 20261017_OPS_multi_site_menu.sql made them.    #
-- #  Run it BEFORE the round 1 roll back, never after.                        #
-- ############################################################################
--
-- What stays: every venue row a publish wrote (option groups, products, VAT by order type, config
-- pushes). They are ordinary menu rows by then. The tills keep running.
-- What goes: the option rows and option site rows of the group menu, the round 2 columns
-- (tax_by_type, order_types, refreshed_at, kept on group sites, archived and family_base on
-- groups, cleared_tax_profile_id), and every STAGED round 2 change in a draft (a draft or a
-- scheduled push holding one should be published or cancelled first).

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This must be run against the OPS DB (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
end
$guard$;

-- Staged round 2 changes cannot stay once the targets go (the change guard would refuse touching a
-- frozen set's rows, so it is paused for these three statements only).
alter table public.msm_changes disable trigger msm_changes_guard;
delete from public.msm_changes where target in ('modifier_group', 'modifier_group_site', 'modifier_option', 'modifier_option_site');
update public.msm_changes set after = after - 'tax_by_type' where target = 'product' and after ? 'tax_by_type';
update public.msm_changes set after = jsonb_set(after, '{kept}', (after -> 'kept') - 'tax_overrides')
 where target = 'product_site' and jsonb_typeof(after -> 'kept') = 'object' and after -> 'kept' ? 'tax_overrides';
alter table public.msm_changes enable trigger msm_changes_guard;
alter table public.msm_changes drop constraint if exists msm_changes_target_ok;
alter table public.msm_changes add constraint msm_changes_target_ok check (target in ('menu', 'menu_site', 'category', 'product', 'product_site'));

drop function if exists public.msm_sites_trading(uuid);
drop function if exists public.msm_sold_recently(uuid, integer, text[]);
drop function if exists public.msm_managed_at(text[]);
drop function if exists public.msm_managed_groups(text);
drop function if exists public.msm_import_groups(uuid, jsonb);
drop function if exists public.msm__import_options(uuid, jsonb);
drop function if exists public.msm__managed_group(uuid, text, text, text[]);
drop function if exists public.msm__is_legacy_mirror(uuid, uuid);
drop function if exists public.msm_sql_contract();
drop function if exists public.msm_set_order_types(uuid, text[]);

drop table if exists public.msm_modifier_option_sites;
drop table if exists public.msm_modifier_options;
drop function if exists public.msm_option_menu_guard();

alter table public.msm_modifier_groups drop column if exists archived;
alter table public.msm_modifier_groups drop column if exists family_base;
alter table public.msm_modifier_group_sites drop column if exists kept;
alter table public.msm_products drop column if exists tax_by_type;
alter table public.msm_product_sites drop column if exists cleared_tax_profile_id;
update public.msm_product_sites set kept = kept - 'tax_overrides' where kept ? 'tax_overrides';
alter table public.msm_menus drop column if exists order_types;
alter table public.msm_menus drop column if exists refreshed_at;

-- The round 1 functions, verbatim from 20261017_OPS_multi_site_menu.sql.
create or replace function public.msm_site_org_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_org uuid;
begin
  if tg_table_name = 'msm_menu_sites' then
    select m.org_id into v_org from public.msm_menus m where m.id = new.menu_id;
  elsif tg_table_name = 'msm_product_sites' then
    select m.org_id into v_org from public.msm_products p join public.msm_menus m on m.id = p.menu_id where p.id = new.product_id;
  elsif tg_table_name = 'msm_category_sites' then
    select m.org_id into v_org from public.msm_categories c join public.msm_menus m on m.id = c.menu_id where c.id = new.category_id;
  elsif tg_table_name = 'msm_modifier_group_sites' then
    select m.org_id into v_org from public.msm_modifier_groups g join public.msm_menus m on m.id = g.menu_id where g.id = new.group_id;
  elsif tg_table_name = 'msm_version_sites' then
    select v.org_id into v_org from public.msm_versions v where v.id = new.version_id;
    new.org_id := v_org;
  else
    raise exception 'msm_site_org_guard: not for table %', tg_table_name;
  end if;
  if v_org is null or not public.msm__venue_in_org(new.location_id, v_org) then
    raise exception 'That site is not in this company.' using errcode = '42501';
  end if;
  return new;
end
$fn$;

create or replace function public.msm__ref_ok(p_menu uuid, p_set uuid, p_target text, p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select p_id is null
      or (p_target = 'category' and exists (select 1 from public.msm_categories c where c.id = p_id and c.menu_id = p_menu))
      or (p_target = 'product' and exists (select 1 from public.msm_products p where p.id = p_id and p.menu_id = p_menu))
      or exists (select 1 from public.msm_changes x where x.change_set_id = p_set and x.target = p_target and x.entity_id = p_id and x.op = 'create');
$fn$;

create or replace function public.msm_changes_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_set      record;
  v_allowed  text[];
  v_bad      text;
  v_ref      uuid;
  v_kept     constant text[] := array['cat', 'cats', 'image', 'name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'tax_rate_id', 'allergens', 'tags', 'visibility', 'sold_alone', 'item_code', 'assigned_modifier_groups', 'type', 'parent_id'];
  v_channels constant text[] := array['dineIn', 'takeaway', 'collection', 'delivery', 'driveThru'];
  v_vid      text;
begin
  if tg_op = 'DELETE' then
    select s.status into v_set from public.msm_change_sets s where s.id = old.change_set_id;
    if found and v_set.status <> 'draft' then
      raise exception 'This set is %, so its changes cannot be removed.', v_set.status using errcode = '42501';
    end if;
    -- Throwing away a NEW product or category (the set itself still there): its site rows go
    -- with it, and a change that still uses it keeps it (otherwise the set would fail at its time).
    if found and old.op = 'create' and old.target = 'product' then
      if exists (select 1 from public.msm_changes x
                  where x.change_set_id = old.change_set_id and x.id <> old.id and x.target = 'product'
                    and (x.after ->> 'parent_product_id' = old.entity_id::text)) then
        raise exception 'Other changes in this set use this new product (its sizes). Remove those first.' using errcode = '22023';
      end if;
      delete from public.msm_changes x
       where x.change_set_id = old.change_set_id and x.target = 'product_site' and x.entity_id = old.entity_id;
    elsif found and old.op = 'create' and old.target = 'category' then
      if exists (select 1 from public.msm_changes x
                  where x.change_set_id = old.change_set_id and x.id <> old.id
                    and ((x.target = 'category' and (x.after ->> 'parent_id' = old.entity_id::text or x.after ->> 'route_like_id' = old.entity_id::text))
                      or (x.target = 'product' and (x.after ->> 'category_id' = old.entity_id::text
                           or (jsonb_typeof(x.after -> 'extra_category_ids') = 'array' and x.after -> 'extra_category_ids' ? old.entity_id::text))))) then
        raise exception 'Other changes in this set use this new category. Move those products or categories first.' using errcode = '22023';
      end if;
    end if;
    return old;
  end if;

  select s.id, s.status, s.menu_id, s.org_id into v_set from public.msm_change_sets s where s.id = new.change_set_id;
  if not found then
    raise exception 'No such set of changes.' using errcode = '42501';
  end if;
  if v_set.status <> 'draft' then
    raise exception 'This set is %, so it cannot be changed. Unschedule it to edit it again.', v_set.status using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.change_set_id is distinct from old.change_set_id or new.target is distinct from old.target
       or new.entity_id is distinct from old.entity_id or new.location_id is distinct from old.location_id) then
    raise exception 'A staged change cannot move. Remove it and stage a new one.' using errcode = '42501';
  end if;
  new.menu_id := v_set.menu_id;
  new.org_id := v_set.org_id;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(auth.uid(), new.created_by);
    new.created_at := now();
  end if;
  new.updated_at := now();

  v_allowed := case new.target
    when 'menu' then array['name', 'description', 'use_name_everywhere']
    when 'menu_site' then array['venue_menu_id']
    when 'category' then array['parent_id', 'label', 'icon', 'color', 'accounting_group', 'default_course', 'sort_order', 'image', 'archived', 'route_like_id']
    when 'product' then array['category_id', 'extra_category_ids', 'parent_product_id', 'type', 'name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'default_price', 'default_channels', 'tax_rate_name', 'tax_rate_percent', 'allergens', 'tags', 'image', 'modifier_groups', 'visibility', 'sold_alone', 'item_code', 'site_only_location_id', 'archived', 'sort_order', 'family_base']
    when 'product_site' then array['venue_item_id', 'active', 'price', 'channel_prices', 'kept']
  end;
  select k into v_bad from jsonb_object_keys(new.after) k where k <> all (v_allowed) limit 1;
  if found then
    raise exception 'This cannot be changed here: %', v_bad using errcode = '22023';
  end if;
  if not ((new.target = 'menu' and new.op = 'update')
       or (new.target = 'menu_site' and new.op = 'create')
       or (new.target in ('category', 'product'))
       or (new.target = 'product_site' and new.op in ('create', 'update'))) then
    raise exception 'A % cannot be changed that way (%).', replace(new.target, '_', ' '), new.op using errcode = '22023';
  end if;

  -- Where: a site for site changes, never for menu wide ones; the site must be in the company.
  if new.target in ('menu_site', 'product_site') then
    if new.location_id is null or not public.msm__venue_in_org(new.location_id, v_set.org_id) then
      raise exception 'That site is not in this company.' using errcode = '42501';
    end if;
  elsif new.location_id is not null then
    raise exception 'This change is for every site, not one.' using errcode = '22023';
  end if;

  -- What: this menu's own rows only.
  if new.target in ('menu', 'menu_site') then
    if new.entity_id <> v_set.menu_id then
      raise exception 'That is not this group menu.' using errcode = '42501';
    end if;
    if new.target = 'menu_site' then
      if exists (select 1 from public.msm_menu_sites s where s.menu_id = v_set.menu_id and s.location_id = new.location_id) then
        raise exception 'That site is already in the group menu.' using errcode = '22023';
      end if;
      v_vid := new.after ->> 'venue_menu_id';
      if v_vid is not null and not exists (select 1 from public.menus m where m.id = v_vid and m.location_id = new.location_id) then
        raise exception 'That menu is not at that site.' using errcode = '42501';
      end if;
    end if;
  elsif new.target = 'category' then
    if new.op = 'create' then
      if exists (select 1 from public.msm_categories c where c.id = new.entity_id) then
        raise exception 'That category already exists.' using errcode = '22023';
      end if;
    elsif not exists (select 1 from public.msm_categories c where c.id = new.entity_id and c.menu_id = v_set.menu_id) then
      raise exception 'That category is not in this group menu.' using errcode = '42501';
    end if;
    foreach v_ref in array array[nullif(new.after ->> 'parent_id', '')::uuid, nullif(new.after ->> 'route_like_id', '')::uuid] loop
      if not public.msm__ref_ok(v_set.menu_id, v_set.id, 'category', v_ref) then
        raise exception 'That category is not in this group menu.' using errcode = '42501';
      end if;
    end loop;
  elsif new.target = 'product' then
    if new.op = 'create' then
      if exists (select 1 from public.msm_products p where p.id = new.entity_id) then
        raise exception 'That product already exists.' using errcode = '22023';
      end if;
    elsif not exists (select 1 from public.msm_products p where p.id = new.entity_id and p.menu_id = v_set.menu_id) then
      raise exception 'That product is not in this group menu.' using errcode = '42501';
    end if;
    if not public.msm__ref_ok(v_set.menu_id, v_set.id, 'category', nullif(new.after ->> 'category_id', '')::uuid)
       or not public.msm__ref_ok(v_set.menu_id, v_set.id, 'product', nullif(new.after ->> 'parent_product_id', '')::uuid) then
      raise exception 'That category or product is not in this group menu.' using errcode = '42501';
    end if;
    if jsonb_typeof(new.after -> 'extra_category_ids') = 'array' then
      for v_ref in select x::uuid from jsonb_array_elements_text(new.after -> 'extra_category_ids') x loop
        if not public.msm__ref_ok(v_set.menu_id, v_set.id, 'category', v_ref) then
          raise exception 'That category is not in this group menu.' using errcode = '42501';
        end if;
      end loop;
    end if;
    if new.after ? 'site_only_location_id' and new.after ->> 'site_only_location_id' is not null
       and not public.msm__venue_in_org(new.after ->> 'site_only_location_id', v_set.org_id) then
      raise exception 'That site is not in this company.' using errcode = '42501';
    end if;
    if jsonb_typeof(new.after -> 'default_channels') = 'object' then
      select k into v_bad from jsonb_object_keys(new.after -> 'default_channels') k where k <> all (v_channels) limit 1;
      if found then raise exception 'Unknown channel: %', v_bad using errcode = '22023'; end if;
    end if;
    if new.after ? 'default_price' and (new.after ->> 'default_price')::numeric < 0 then
      raise exception 'A price cannot be below zero.' using errcode = '22023';
    end if;
  elsif new.target = 'product_site' then
    if not exists (select 1 from public.msm_products p where p.id = new.entity_id and p.menu_id = v_set.menu_id)
       and not exists (select 1 from public.msm_changes x where x.change_set_id = v_set.id and x.target = 'product' and x.entity_id = new.entity_id and x.op = 'create') then
      raise exception 'That product is not in this group menu.' using errcode = '42501';
    end if;
    if new.op = 'create' then
      if exists (select 1 from public.msm_product_sites s where s.product_id = new.entity_id and s.location_id = new.location_id) then
        raise exception 'That product is already at that site.' using errcode = '22023';
      end if;
      v_vid := new.after ->> 'venue_item_id';
      if v_vid is null or btrim(v_vid) = '' then
        raise exception 'A new product at a site needs its venue id.' using errcode = '22023';
      end if;
      -- An id of ANOTHER venue's product is never taken (it would write into that venue).
      if exists (select 1 from public.menu_items i where i.id = v_vid and i.location_id is distinct from new.location_id) then
        raise exception 'That product id belongs to another site.' using errcode = '42501';
      end if;
      if exists (select 1 from public.msm_product_sites s where s.location_id = new.location_id and s.venue_item_id = v_vid) then
        raise exception 'That product is already managed at that site.' using errcode = '22023';
      end if;
      if not exists (select 1 from public.msm_menu_sites s where s.menu_id = v_set.menu_id and s.location_id = new.location_id)
         and not exists (select 1 from public.msm_changes x where x.change_set_id = v_set.id and x.target = 'menu_site' and x.location_id = new.location_id) then
        raise exception 'That site is not in the group menu yet. Add the site first.' using errcode = '22023';
      end if;
    else
      if new.after ? 'venue_item_id' then
        raise exception 'A product''s venue id cannot change.' using errcode = '22023';
      end if;
      if not exists (select 1 from public.msm_product_sites s where s.product_id = new.entity_id and s.location_id = new.location_id) then
        raise exception 'That product is not at that site.' using errcode = '22023';
      end if;
    end if;
    if jsonb_typeof(new.after -> 'kept') = 'object' then
      select k into v_bad from jsonb_object_keys(new.after -> 'kept') k where k <> all (v_kept) limit 1;
      if found then raise exception 'A site cannot keep its own %', v_bad using errcode = '22023'; end if;
    elsif new.after ? 'kept' and jsonb_typeof(new.after -> 'kept') <> 'null' then
      raise exception 'Kept values must be a list of fields.' using errcode = '22023';
    end if;
    if jsonb_typeof(new.after -> 'channel_prices') = 'object' then
      select k into v_bad from jsonb_object_keys(new.after -> 'channel_prices') k where k <> all (v_channels) limit 1;
      if found then raise exception 'Unknown channel: %', v_bad using errcode = '22023'; end if;
    end if;
    if new.after ? 'price' and jsonb_typeof(new.after -> 'price') = 'number' and (new.after ->> 'price')::numeric < 0 then
      raise exception 'A price cannot be below zero.' using errcode = '22023';
    end if;
  end if;
  return new;
end
$fn$;

create or replace function public.msm__sites_reached(p_set uuid)
returns setof text
language sql
stable
security definer
set search_path = ''
as $fn$
  with s as (select cs.menu_id from public.msm_change_sets cs where cs.id = p_set),
       wide as (select exists (select 1 from public.msm_changes c where c.change_set_id = p_set and c.target not in ('menu_site', 'product_site')) as yes)
  select ms.location_id from public.msm_menu_sites ms, s, wide where ms.menu_id = s.menu_id and wide.yes
  union
  select c.location_id from public.msm_changes c where c.change_set_id = p_set and c.location_id is not null;
$fn$;

create or replace function public.msm_start_version(p_version uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v       public.msm_versions%rowtype;
  c       record;
  v_row   jsonb;
  v_before jsonb;
  v_log   jsonb := '[]'::jsonb;
  v_no    integer;
begin
  select * into v from public.msm_versions where id = p_version for update;
  if not found then
    raise exception 'No such publish.';
  end if;
  if v.version_no is not null then
    return jsonb_build_object('ok', true, 'already', true, 'version_no', v.version_no, 'changes', v.changes);
  end if;
  if v.status = 'cancelled' then
    raise exception 'This publish was cancelled.';
  end if;
  -- Dependency order (the menu, then its sites, categories, products, then product sites), and
  -- links between new rows of the same kind checked at commit: a staged create row keeps its
  -- first time when it is edited, so a product moved into a category made later sorts first.
  set constraints public.msm_categories_parent_id_fkey, public.msm_categories_route_like_id_fkey,
                  public.msm_products_category_id_fkey, public.msm_products_parent_product_id_fkey,
                  public.msm_product_sites_product_id_fkey deferred;
  for c in select * from public.msm_changes x where x.change_set_id = v.change_set_id
            order by case x.target when 'menu' then 0 when 'menu_site' then 1 when 'category' then 2 when 'product' then 3 else 4 end,
                     x.created_at, x.id loop
    v_before := null;
    if c.target = 'menu' then
      select to_jsonb(m) into v_row from public.msm_menus m where m.id = v.menu_id;
      select jsonb_object_agg(k, v_row -> k) into v_before from jsonb_object_keys(c.after) k;
      update public.msm_menus t
         set (name, description, use_name_everywhere, updated_at) =
             (select coalesce(nullif(btrim(r.name), ''), t.name), coalesce(r.description, ''), coalesce(r.use_name_everywhere, false), now()
                from jsonb_populate_record(t, c.after) r)
       where t.id = v.menu_id;
    elsif c.target = 'menu_site' then
      insert into public.msm_menu_sites (menu_id, location_id, venue_menu_id, joined_by)
      values (v.menu_id, c.location_id, c.after ->> 'venue_menu_id', v.created_by)
      on conflict (menu_id, location_id) do nothing;
    elsif c.target = 'category' then
      if c.op = 'create' then
        insert into public.msm_categories (id, menu_id, parent_id, label, icon, color, accounting_group, default_course, sort_order, image, archived, route_like_id)
        select c.entity_id, v.menu_id, r.parent_id, coalesce(nullif(btrim(r.label), ''), 'Category'), r.icon, r.color, coalesce(r.accounting_group, ''),
               coalesce(r.default_course, 1), coalesce(r.sort_order, 0), r.image, coalesce(r.archived, false), r.route_like_id
          from jsonb_populate_record(null::public.msm_categories, c.after) r
        on conflict (id) do nothing;
      else
        select to_jsonb(x) into v_row from public.msm_categories x where x.id = c.entity_id and x.menu_id = v.menu_id;
        if c.op = 'remove' then
          v_before := jsonb_build_object('archived', v_row -> 'archived');
          update public.msm_categories set archived = true, updated_at = now() where id = c.entity_id and menu_id = v.menu_id;
        else
          select jsonb_object_agg(k, v_row -> k) into v_before from jsonb_object_keys(c.after) k;
          update public.msm_categories t
             set (parent_id, label, icon, color, accounting_group, default_course, sort_order, image, archived, route_like_id, updated_at) =
                 (select r.parent_id, coalesce(nullif(btrim(r.label), ''), t.label), r.icon, r.color, coalesce(r.accounting_group, ''),
                         coalesce(r.default_course, 1), coalesce(r.sort_order, 0), r.image, coalesce(r.archived, false), r.route_like_id, now()
                    from jsonb_populate_record(t, c.after) r)
           where t.id = c.entity_id and t.menu_id = v.menu_id;
        end if;
      end if;
    elsif c.target = 'product' then
      if c.op = 'create' then
        insert into public.msm_products (id, menu_id, category_id, extra_category_ids, parent_product_id, type, name, menu_name, receipt_name,
               kitchen_name, description, default_price, default_channels, tax_rate_name, tax_rate_percent, allergens, tags, image,
               modifier_groups, visibility, sold_alone, item_code, site_only_location_id, archived, sort_order, family_base)
        select c.entity_id, v.menu_id, r.category_id, coalesce(r.extra_category_ids, '{}'), r.parent_product_id, coalesce(r.type, 'simple'),
               coalesce(nullif(btrim(r.name), ''), 'Product'), r.menu_name, r.receipt_name, r.kitchen_name, coalesce(r.description, ''),
               coalesce(r.default_price, 0), r.default_channels, r.tax_rate_name, r.tax_rate_percent, coalesce(r.allergens, '{}'),
               coalesce(r.tags, '[]'::jsonb), r.image, coalesce(r.modifier_groups, '[]'::jsonb), r.visibility, coalesce(r.sold_alone, false),
               r.item_code, r.site_only_location_id, coalesce(r.archived, false), coalesce(r.sort_order, 0), r.family_base
          from jsonb_populate_record(null::public.msm_products, c.after) r
        on conflict (id) do nothing;
      else
        select to_jsonb(x) into v_row from public.msm_products x where x.id = c.entity_id and x.menu_id = v.menu_id;
        if c.op = 'remove' then
          v_before := jsonb_build_object('archived', v_row -> 'archived');
          update public.msm_products set archived = true, updated_at = now() where id = c.entity_id and menu_id = v.menu_id;
        else
          select jsonb_object_agg(k, v_row -> k) into v_before from jsonb_object_keys(c.after) k;
          update public.msm_products t
             set (category_id, extra_category_ids, parent_product_id, type, name, menu_name, receipt_name, kitchen_name, description,
                  default_price, default_channels, tax_rate_name, tax_rate_percent, allergens, tags, image, modifier_groups, visibility,
                  sold_alone, item_code, site_only_location_id, archived, sort_order, family_base, updated_at) =
                 (select r.category_id, coalesce(r.extra_category_ids, '{}'), r.parent_product_id, coalesce(r.type, 'simple'),
                         coalesce(nullif(btrim(r.name), ''), t.name), r.menu_name, r.receipt_name, r.kitchen_name, coalesce(r.description, ''),
                         coalesce(r.default_price, 0), r.default_channels, r.tax_rate_name, r.tax_rate_percent, coalesce(r.allergens, '{}'),
                         coalesce(r.tags, '[]'::jsonb), r.image, coalesce(r.modifier_groups, '[]'::jsonb), r.visibility, coalesce(r.sold_alone, false),
                         r.item_code, r.site_only_location_id, coalesce(r.archived, false), coalesce(r.sort_order, 0), r.family_base, now()
                    from jsonb_populate_record(t, c.after) r)
           where t.id = c.entity_id and t.menu_id = v.menu_id;
        end if;
      end if;
    elsif c.target = 'product_site' then
      if c.op = 'create' then
        insert into public.msm_product_sites (product_id, location_id, venue_item_id, active, price, channel_prices, kept)
        select c.entity_id, c.location_id, r.venue_item_id, coalesce(r.active, true), r.price, r.channel_prices, coalesce(r.kept, '{}'::jsonb)
          from jsonb_populate_record(null::public.msm_product_sites, c.after) r
        on conflict (product_id, location_id) do nothing;
      else
        select to_jsonb(x) into v_row from public.msm_product_sites x where x.product_id = c.entity_id and x.location_id = c.location_id;
        select jsonb_object_agg(k, v_row -> k) into v_before from jsonb_object_keys(c.after) k;
        update public.msm_product_sites t
           set (active, price, channel_prices, kept, updated_at) =
               (select coalesce(r.active, true), r.price, r.channel_prices, coalesce(r.kept, '{}'::jsonb), now()
                  from jsonb_populate_record(t, c.after) r)
         where t.product_id = c.entity_id and t.location_id = c.location_id;
      end if;
    end if;
    v_log := v_log || jsonb_build_array(jsonb_build_object('target', c.target, 'entity_id', c.entity_id, 'location_id', c.location_id,
                                                           'op', c.op, 'before', v_before, 'after', c.after));
  end loop;

  -- Every reference still inside this menu (the staging guard checked each one; this is the last word).
  if exists (select 1 from public.msm_products p where p.menu_id = v.menu_id and (
        (p.category_id is not null and not exists (select 1 from public.msm_categories x where x.id = p.category_id and x.menu_id = v.menu_id))
     or (p.parent_product_id is not null and not exists (select 1 from public.msm_products q where q.id = p.parent_product_id and q.menu_id = v.menu_id))
     or exists (select 1 from unnest(p.extra_category_ids) e where not exists (select 1 from public.msm_categories x where x.id = e and x.menu_id = v.menu_id))))
  or exists (select 1 from public.msm_categories k where k.menu_id = v.menu_id and (
        (k.parent_id is not null and not exists (select 1 from public.msm_categories x where x.id = k.parent_id and x.menu_id = v.menu_id))
     or (k.route_like_id is not null and not exists (select 1 from public.msm_categories x where x.id = k.route_like_id and x.menu_id = v.menu_id)))) then
    raise exception 'A product or category points outside this group menu. Nothing was published.';
  end if;

  update public.msm_menus set last_version_no = last_version_no + 1, updated_at = now() where id = v.menu_id returning last_version_no into v_no;
  update public.msm_versions set version_no = v_no, started_at = now(), status = 'running', changes = v_log where id = p_version;
  perform public.msm__refresh_version(p_version);
  return jsonb_build_object('ok', true, 'already', false, 'version_no', v_no, 'changes', v_log);
end
$fn$;

create or replace function public.msm_import_commit(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_org     uuid := nullif(p_payload ->> 'org_id', '')::uuid;
  v_menu    uuid := gen_random_uuid();
  v_version uuid := gen_random_uuid();
  v_bad     text;
  v_n       record;
  v_name    text;
begin
  perform public.msm__require_editor(v_org);
  if exists (select 1 from public.msm_menus m where m.org_id = v_org and m.status = 'live') then
    raise exception 'This company already has a group menu.' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload -> 'sites') <> 'array' or jsonb_array_length(p_payload -> 'sites') = 0 then
    raise exception 'Pick at least one site.' using errcode = '22023';
  end if;
  -- Sites: in the company, and each venue menu at its own site.
  select s ->> 'location_id' into v_bad from jsonb_array_elements(p_payload -> 'sites') s
   where not public.msm__venue_in_org(s ->> 'location_id', v_org)
      or (s ->> 'venue_menu_id' is not null and not exists (select 1 from public.menus m where m.id = s ->> 'venue_menu_id' and m.location_id = s ->> 'location_id'))
   limit 1;
  if found then
    raise exception 'A site or its menu is not in this company (%).', v_bad using errcode = '42501';
  end if;

  select coalesce(nullif(btrim(p.full_name), ''), p.email) into v_name from public.user_profiles p where p.id = auth.uid();
  insert into public.msm_menus (id, org_id, name, description, created_by, last_version_no, last_published_at, last_published_by)
  values (v_menu, v_org, coalesce(nullif(btrim(p_payload #>> '{menu,name}'), ''), 'Group menu'), coalesce(p_payload #>> '{menu,description}', ''), auth.uid(), 1, now(), v_name);
  insert into public.msm_menu_sites (menu_id, location_id, venue_menu_id, joined_by)
  select v_menu, s ->> 'location_id', s ->> 'venue_menu_id', auth.uid() from jsonb_array_elements(p_payload -> 'sites') s;

  -- Categories (one statement, so a parent later in the list is fine).
  insert into public.msm_categories (id, menu_id, parent_id, label, icon, color, accounting_group, default_course, sort_order, image, archived, route_like_id)
  select r.id, v_menu, r.parent_id, coalesce(nullif(btrim(r.label), ''), 'Category'), r.icon, r.color, coalesce(r.accounting_group, ''),
         coalesce(r.default_course, 1), coalesce(r.sort_order, 0), r.image, false, r.route_like_id
    from jsonb_populate_recordset(null::public.msm_categories, coalesce(p_payload -> 'categories', '[]'::jsonb)) r;
  select x ->> 'venue_category_id' into v_bad
    from jsonb_array_elements(coalesce(p_payload -> 'categories', '[]'::jsonb)) c, jsonb_array_elements(coalesce(c -> 'sites', '[]'::jsonb)) x
   where not exists (select 1 from public.menu_categories mc where mc.id = x ->> 'venue_category_id' and mc.location_id = x ->> 'location_id')
   limit 1;
  if found then
    raise exception 'A category is not at the site it was matched to (%).', v_bad using errcode = '42501';
  end if;
  insert into public.msm_category_sites (category_id, location_id, venue_category_id)
  select (c ->> 'id')::uuid, x ->> 'location_id', x ->> 'venue_category_id'
    from jsonb_array_elements(coalesce(p_payload -> 'categories', '[]'::jsonb)) c, jsonb_array_elements(coalesce(c -> 'sites', '[]'::jsonb)) x;

  -- Modifier groups.
  insert into public.msm_modifier_groups (id, menu_id, name, min, max, selection_type, options, sort_order, source_location_id)
  select r.id, v_menu, coalesce(r.name, 'Options'), coalesce(r.min, 0), coalesce(r.max, 1), coalesce(r.selection_type, 'single'),
         coalesce(r.options, '[]'::jsonb), coalesce(r.sort_order, 0), r.source_location_id
    from jsonb_populate_recordset(null::public.msm_modifier_groups, coalesce(p_payload -> 'groups', '[]'::jsonb)) r;
  select x ->> 'venue_group_id' into v_bad
    from jsonb_array_elements(coalesce(p_payload -> 'groups', '[]'::jsonb)) g, jsonb_array_elements(coalesce(g -> 'sites', '[]'::jsonb)) x
   where not exists (select 1 from public.modifier_groups mg where mg.id = x ->> 'venue_group_id' and mg.location_id = x ->> 'location_id')
   limit 1;
  if found then
    raise exception 'A modifier group is not at the site it was matched to (%).', v_bad using errcode = '42501';
  end if;
  insert into public.msm_modifier_group_sites (group_id, location_id, venue_group_id)
  select (g ->> 'id')::uuid, x ->> 'location_id', x ->> 'venue_group_id'
    from jsonb_array_elements(coalesce(p_payload -> 'groups', '[]'::jsonb)) g, jsonb_array_elements(coalesce(g -> 'sites', '[]'::jsonb)) x;

  -- Products (references inside this menu only: the foreign keys plus the check below).
  insert into public.msm_products (id, menu_id, category_id, extra_category_ids, parent_product_id, type, name, menu_name, receipt_name,
         kitchen_name, description, default_price, default_channels, tax_rate_name, tax_rate_percent, allergens, tags, image,
         modifier_groups, visibility, sold_alone, item_code, site_only_location_id, archived, sort_order, family_base)
  select r.id, v_menu, r.category_id, coalesce(r.extra_category_ids, '{}'), r.parent_product_id, coalesce(r.type, 'simple'),
         coalesce(nullif(btrim(r.name), ''), 'Product'), r.menu_name, r.receipt_name, r.kitchen_name, coalesce(r.description, ''),
         coalesce(r.default_price, 0), r.default_channels, r.tax_rate_name, r.tax_rate_percent, coalesce(r.allergens, '{}'),
         coalesce(r.tags, '[]'::jsonb), r.image, coalesce(r.modifier_groups, '[]'::jsonb), r.visibility, coalesce(r.sold_alone, false),
         r.item_code, r.site_only_location_id, false, coalesce(r.sort_order, 0), r.family_base
    from jsonb_populate_recordset(null::public.msm_products, coalesce(p_payload -> 'products', '[]'::jsonb)) r;
  if exists (select 1 from public.msm_products p where p.menu_id = v_menu and (
        (p.category_id is not null and not exists (select 1 from public.msm_categories c where c.id = p.category_id and c.menu_id = v_menu))
     or (p.parent_product_id is not null and not exists (select 1 from public.msm_products q where q.id = p.parent_product_id and q.menu_id = v_menu))
     or exists (select 1 from unnest(p.extra_category_ids) x where not exists (select 1 from public.msm_categories c where c.id = x and c.menu_id = v_menu))
     or (p.site_only_location_id is not null and not public.msm__venue_in_org(p.site_only_location_id, v_org)))) then
    raise exception 'A product points at a category, product or site that is not in this group menu.' using errcode = '42501';
  end if;
  select x ->> 'venue_item_id' into v_bad
    from jsonb_array_elements(coalesce(p_payload -> 'products', '[]'::jsonb)) p, jsonb_array_elements(coalesce(p -> 'sites', '[]'::jsonb)) x
   where not exists (select 1 from public.menu_items mi where mi.id = x ->> 'venue_item_id' and mi.location_id = x ->> 'location_id')
      or (jsonb_typeof(x -> 'kept') = 'object' and exists (select 1 from jsonb_object_keys(x -> 'kept') k
            where k <> all (array['cat', 'cats', 'image', 'name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'tax_rate_id', 'allergens', 'tags', 'visibility', 'sold_alone', 'item_code', 'assigned_modifier_groups', 'type', 'parent_id'])))
   limit 1;
  if found then
    raise exception 'A product is not at the site it was matched to, or keeps a field it cannot (%).', v_bad using errcode = '42501';
  end if;
  insert into public.msm_product_sites (product_id, location_id, venue_item_id, active, price, channel_prices, kept)
  select (p ->> 'id')::uuid, x ->> 'location_id', x ->> 'venue_item_id', coalesce((x ->> 'active')::boolean, true),
         nullif(x ->> 'price', '')::numeric, case when jsonb_typeof(x -> 'channel_prices') = 'object' then x -> 'channel_prices' end,
         case when jsonb_typeof(x -> 'kept') = 'object' then x -> 'kept' else '{}'::jsonb end
    from jsonb_array_elements(coalesce(p_payload -> 'products', '[]'::jsonb)) p, jsonb_array_elements(coalesce(p -> 'sites', '[]'::jsonb)) x;

  insert into public.msm_versions (id, menu_id, org_id, version_no, kind, title, status, created_by, created_by_name, started_at, finished_at, changes)
  values (v_version, v_menu, v_org, 1, 'import', 'Import', 'done', auth.uid(), v_name, now(), now(), '[]'::jsonb);

  select (select count(*) from public.msm_products where menu_id = v_menu) as products,
         (select count(*) from public.msm_categories where menu_id = v_menu) as categories,
         (select count(*) from public.msm_menu_sites where menu_id = v_menu) as sites
    into v_n;
  return jsonb_build_object('ok', true, 'menu_id', v_menu, 'version_id', v_version,
                            'products', v_n.products, 'categories', v_n.categories, 'sites', v_n.sites,
                            'words', 'Version 1: imported. 0 changes at 0 sites.');
end
$fn$;

create or replace function public.msm_apply_site(p_version uuid, p_location text, p_writes jsonb, p_snapshot jsonb,
                                                 p_fingerprint text, p_counts jsonb default '{}'::jsonb,
                                                 p_pushed_by text default 'Multi site menu', p_summary text default null,
                                                 p_last_push_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v        public.msm_versions%rowtype;
  vs       public.msm_version_sites%rowtype;
  w        jsonb;
  u        jsonb;
  v_old    jsonb;
  v_new    jsonb;
  v_audit  jsonb := '[]'::jsonb;
  v_rows   integer;
  v_now    timestamptz := now();
  v_nowj   jsonb := to_jsonb(now());
  v_items  text[] := '{}';
  v_cats   text[] := '{}';
  v_menus  text[] := '{}';
  v_items_new text[] := '{}';
  v_cats_new  text[] := '{}';
  v_menus_new text[] := '{}';
  v_set    jsonb;
  v_push   uuid;
  v_snap   jsonb;
  v_any    boolean := false;
  v_uuid   uuid;
  v_ins_menus  constant text[] := array['id', 'name', 'description', 'is_default', 'is_active', 'sort_order', 'scope', 'org_id'];
  v_ins_cats   constant text[] := array['id', 'menu_id', 'parent_id', 'label', 'icon', 'color', 'accounting_group', 'sort_order', 'default_course', 'image', 'scope', 'org_id'];
  v_ins_items  constant text[] := array['id', 'name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'type', 'cat', 'cats', 'parent_id', 'sort_order', 'pricing', 'allergens', 'assigned_modifier_groups', 'visibility', 'sold_alone', 'archived', 'tax_rate_id', 'image', 'scope', 'org_id', 'tags', 'item_code'];
  v_ins_groups constant text[] := array['id', 'name', 'min', 'max', 'min_select', 'max_select', 'selection_type', 'options', 'sort_order'];
  v_upd_menus  constant text[] := array['name', 'description'];
  v_upd_cats   constant text[] := array['menu_id', 'parent_id', 'label', 'icon', 'color', 'accounting_group', 'sort_order', 'default_course', 'image'];
  v_upd_items  constant text[] := array['name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'type', 'cat', 'cats', 'parent_id', 'allergens', 'assigned_modifier_groups', 'visibility', 'sold_alone', 'archived', 'tax_rate_id', 'image', 'tags', 'item_code'];
  v_pricing    constant text[] := array['base', 'dineIn', 'takeaway', 'collection', 'delivery', 'driveThru'];
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
    select to_jsonb(m) into v_old from public.menus m where m.id = u ->> 'id' and m.location_id = p_location for update;
    if v_old is null then raise exception 'A menu is not at this site (%).', u ->> 'id'; end if;
    if not (u ->> 'id' = any (v_menus_new)
            or exists (select 1 from public.msm_menu_sites s where s.menu_id = v.menu_id and s.location_id = p_location and s.venue_menu_id = u ->> 'id')) then
      raise exception 'A change points at a menu this group menu does not manage. Nothing was written.';
    end if;
    -- jsonb_populate_record(t, set) keeps t's own value for every column the set does not name,
    -- so an untouched column is written back exactly as it is.
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
    select r.id, p_location, r.menu_id, r.parent_id, coalesce(nullif(btrim(r.label), ''), 'Category'), coalesce(r.icon, '🍽'), coalesce(r.color, '#3b82f6'),
           coalesce(r.accounting_group, ''), coalesce(r.sort_order, 0), coalesce(r.default_course, 1), r.image, 'local', v.org_id, v_now, v_now
      from jsonb_populate_record(null::public.menu_categories, w) r;
    v_cats := v_cats || (w ->> 'id');
    v_cats_new := v_cats_new || (w ->> 'id');
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'categories', 'id', w ->> 'id', 'before', null, 'after', w));
  end loop;
  for u in select x from jsonb_array_elements(coalesce(p_writes #> '{categories,update}', '[]'::jsonb)) x loop
    if not public.msm__keys_ok(u -> 'set', v_upd_cats) then raise exception 'A category change has a field publish may not write.'; end if;
    select to_jsonb(c) into v_old from public.menu_categories c where c.id = u ->> 'id' and c.location_id = p_location for update;
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

  -- modifier groups (new copies for a new site) -------------------------
  for w in select x from jsonb_array_elements(coalesce(p_writes #> '{groups,insert}', '[]'::jsonb)) x loop
    if not public.msm__keys_ok(w, v_ins_groups) then raise exception 'A new modifier group has a field publish may not write.'; end if;
    if exists (select 1 from public.modifier_groups g where g.id = w ->> 'id') then raise exception 'A new modifier group id is already taken (%).', w ->> 'id'; end if;
    insert into public.modifier_groups (id, location_id, name, min_select, max_select, sort_order, min, max, selection_type, options, created_at)
    select r.id, p_location, coalesce(r.name, 'Options'), coalesce(r.min_select, r.min, 0), coalesce(r.max_select, r.max, 1), coalesce(r.sort_order, 0),
           coalesce(r.min, 0), coalesce(r.max, 1), coalesce(r.selection_type, 'single'), coalesce(r.options, '[]'::jsonb), v_now
      from jsonb_populate_record(null::public.modifier_groups, w) r;
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'groups', 'id', w ->> 'id', 'before', null, 'after', w));
  end loop;

  -- products ----------------------------------------------------------------
  for w in select x from jsonb_array_elements(coalesce(p_writes #> '{items,insert}', '[]'::jsonb)) x loop
    if not public.msm__keys_ok(w, v_ins_items) or not public.msm__keys_ok(w -> 'pricing', v_pricing || array['menus']) then
      raise exception 'A new product has a field publish may not write.';
    end if;
    if exists (select 1 from public.menu_items i where i.id = w ->> 'id') then raise exception 'A new product id is already taken (%).', w ->> 'id'; end if;
    insert into public.menu_items (id, location_id, name, menu_name, receipt_name, kitchen_name, description, type, cat, cats, parent_id, sort_order,
                                   pricing, allergens, assigned_modifier_groups, visibility, sold_alone, archived, tax_rate_id, image, scope, org_id,
                                   tags, item_code, created_at, updated_at)
    select r.id, p_location, coalesce(r.name, 'Item'), r.menu_name, r.receipt_name, r.kitchen_name, coalesce(r.description, ''), coalesce(r.type, 'simple'),
           r.cat, coalesce(r.cats, '{}'), r.parent_id, coalesce(r.sort_order, 0), coalesce(r.pricing, '{"base": 0}'::jsonb), coalesce(r.allergens, '{}'),
           coalesce(r.assigned_modifier_groups, '[]'::jsonb), coalesce(r.visibility, '{"pos": true, "kiosk": true, "online": true}'::jsonb),
           coalesce(r.sold_alone, false), coalesce(r.archived, false), r.tax_rate_id, r.image, 'local', v.org_id, coalesce(r.tags, '[]'::jsonb),
           r.item_code, v_now, v_now
      from jsonb_populate_record(null::public.menu_items, w) r;
    v_items := v_items || (w ->> 'id');
    v_items_new := v_items_new || (w ->> 'id');
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'items', 'id', w ->> 'id', 'before', null, 'after', w));
  end loop;
  for u in select x from jsonb_array_elements(coalesce(p_writes #> '{items,update}', '[]'::jsonb)) x loop
    if not public.msm__keys_ok(coalesce(u -> 'set', '{}'::jsonb), v_upd_items) or not public.msm__keys_ok(u -> 'pricing', v_pricing) then
      raise exception 'A product change has a field publish may not write.';
    end if;
    select to_jsonb(i) into v_old from public.menu_items i where i.id = u ->> 'id' and i.location_id = p_location for update;
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
    update public.menu_items t
       set (name, menu_name, receipt_name, kitchen_name, description, type, cat, cats, parent_id, allergens, assigned_modifier_groups,
            visibility, sold_alone, archived, tax_rate_id, image, tags, item_code, pricing, updated_at) =
           (select r.name, r.menu_name, r.receipt_name, r.kitchen_name, r.description, r.type,
                   r.cat, r.cats, r.parent_id, r.allergens, r.assigned_modifier_groups,
                   r.visibility, r.sold_alone, r.archived, r.tax_rate_id, r.image, r.tags,
                   r.item_code,
                   case when jsonb_typeof(u -> 'pricing') = 'object' then coalesce(t.pricing, '{}'::jsonb) || (u -> 'pricing') else t.pricing end,
                   v_now
              from jsonb_populate_record(t, coalesce(u -> 'set', '{}'::jsonb)) r)
     where t.id = u ->> 'id' and t.location_id = p_location;
    v_items := v_items || (u ->> 'id');
    select jsonb_object_agg(k, v_old -> k) into v_new from jsonb_object_keys(coalesce(u -> 'set', '{}'::jsonb)) k;
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'items', 'id', u ->> 'id',
                 'before', coalesce(v_new, '{}'::jsonb) || case when jsonb_typeof(u -> 'pricing') = 'object'
                                                                then jsonb_build_object('pricing', (select jsonb_object_agg(k, v_old #> array['pricing', k]) from jsonb_object_keys(u -> 'pricing') k))
                                                                else '{}'::jsonb end,
                 'after', coalesce(u -> 'set', '{}'::jsonb) || case when jsonb_typeof(u -> 'pricing') = 'object' then jsonb_build_object('pricing', u -> 'pricing') else '{}'::jsonb end));
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

  -- option prices and names follow their sub item (review blocker 2) -----
  for w in select x from jsonb_array_elements(coalesce(p_writes -> 'options', '[]'::jsonb)) x loop
    if not exists (select 1 from public.menu_items i where i.id = w ->> 'item_id' and i.location_id = p_location) then
      raise exception 'An option follows a product that is not at this site.';
    end if;
    if not public.msm__managed_item(v.menu_id, p_location, w ->> 'item_id', v_items_new) then
      raise exception 'A change points at a product this group menu does not manage. Nothing was written.';
    end if;
    update public.modifier_groups g
       set options = (select coalesce(jsonb_agg(case when o ->> 'itemId' = w ->> 'item_id'
                                                    then o || (case when w ? 'price' then jsonb_build_object('price', w -> 'price') else '{}'::jsonb end)
                                                           || (case when w ? 'name' then jsonb_build_object('name', w -> 'name') else '{}'::jsonb end)
                                                    else o end order by ord), '[]'::jsonb)
                        from jsonb_array_elements(g.options) with ordinality as e(o, ord))
     where g.location_id = p_location and g.options @> jsonb_build_array(jsonb_build_object('itemId', w ->> 'item_id'));
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'options', 'id', w ->> 'item_id', 'before', null, 'after', w));
  end loop;

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

  v_any := jsonb_array_length(v_audit) > 0;

  -- the config push: the same till refresh as Push to POS ----------------
  if v_any then
    if p_snapshot is null or jsonb_typeof(p_snapshot) <> 'object' or p_snapshot ->> 'locationId' is distinct from p_location then
      raise exception 'The push for this site is missing or for another site. Nothing was written.';
    end if;
    -- Written rows carry the server time they now hold, so an open Back Office sees the change.
    v_snap := p_snapshot;
    if jsonb_typeof(v_snap -> 'menuItems') = 'array' then
      v_snap := jsonb_set(v_snap, '{menuItems}', (select coalesce(jsonb_agg(case when e ->> 'id' = any (v_items) then e || jsonb_build_object('updated_at', v_nowj, 'srvAt', v_nowj) else e end order by ord), '[]'::jsonb)
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
$fn$;

drop function if exists public.msm__group_ids(jsonb);

do $grants$
declare
  f text;
begin
  foreach f in array array['public.msm_site_org_guard()', 'public.msm__ref_ok(uuid,uuid,text,uuid)', 'public.msm_changes_guard()',
                           'public.msm__sites_reached(uuid)', 'public.msm_start_version(uuid)', 'public.msm_import_commit(jsonb)',
                           'public.msm_apply_site(uuid,text,jsonb,jsonb,text,jsonb,text,text,uuid)'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', to_regprocedure(f));
  end loop;
  execute format('grant execute on function %s to authenticated', to_regprocedure('public.msm_import_commit(jsonb)'));
  execute format('grant execute on function %s to service_role', to_regprocedure('public.msm_start_version(uuid)'));
  execute format('grant execute on function %s to service_role', to_regprocedure('public.msm_apply_site(uuid,text,jsonb,jsonb,text,jsonb,text,text,uuid)'));
end
$grants$;

-- CHECK (expected: 0 | 0 | 5 | 0)
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname in ('msm_modifier_options', 'msm_modifier_option_sites')) as round2_tables,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
     and p.proname in ('msm_sql_contract', 'msm_import_groups', 'msm_managed_groups', 'msm_managed_at', 'msm_sold_recently', 'msm_sites_trading', 'msm__is_legacy_mirror', 'msm__managed_group', 'msm__import_options', 'msm__group_ids', 'msm_option_menu_guard', 'msm_set_order_types')) as round2_functions,
  (select count(*) from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''[a-z_]+''', 'g') m where c.conname = 'msm_changes_target_ok') as targets,
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name like 'msm\_%' and column_name in ('tax_by_type', 'refreshed_at', 'order_types', 'cleared_tax_profile_id')) as round2_columns;
