-- 20261017c_OPS_multi_site_menu_groups.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Needs 20261017_OPS_multi_site_menu.sql first (already run 17 Oct).       #
-- #  ADDITIVE: new msm_ tables and columns, msm_ functions replaced whole.     #
-- #  No venue table is changed, so it is safe any time, service too.          #
-- #  Safe to run twice. Running it changes NOTHING at any venue.              #
-- ############################################################################
--
-- WHY (Peter, 17 Oct 2026, after testing round 1 on the dev site)
--   "It would be good to be able to build modifier groups here and push them across the company,
--   and set things like sub items, and sub items that can be sold separately, and manage the groups
--   globally and push similar changes like we have." And: price per order type and VAT per order
--   type, "a bit more idiot proof".
--
-- WHAT THIS FILE ADDS (round 2 of the Multi site menu, same release v5.11.75)
--   * Option groups become central like products: msm_modifier_options (one row per option, a
--     default price, its sub item, its "Then ask" group) and msm_modifier_option_sites (on or off at
--     each site, the site's own price, the venue option id kept for ever, what the site keeps).
--     msm_modifier_groups gains archived and family_base; msm_modifier_group_sites gains kept.
--   * VAT per order type: msm_products.tax_by_type, written into menu_items.tax_overrides (only the
--     four keys dine-in, takeaway, delivery, bar; every other key a site has stays as it is).
--   * msm_menus.order_types (which order types the screens show) and msm_menus.refreshed_at (the
--     one time option group refresh has run; round 2 changes wait for it).
--   * msm_product_sites.cleared_tax_profile_id: the old copy of a product's own VAT rate that a
--     publish cleared, so a later publish (Undo) can put exactly that one back.
--   * The change set targets modifier_group, modifier_group_site, modifier_option and
--     modifier_option_site, through the same draft, preview, schedule, history and undo.
--   * public.msm_apply_site writes an option group IN PLACE and its options ONE BY ONE by the
--     venue option id (never the whole list), locks every row it names before it checks the
--     venue fingerprint, refuses any key it does not know (so a newer publish runner against an
--     older database never half applies), and rebuilds the till push entry of every group it wrote
--     from the row it now holds. The round 1 "option price follows its sub item" block is GONE.
--   * New: msm_import_groups (the one time refresh), msm_managed_groups and msm_managed_at (the
--     Menu Manager lock and the sharing engine's target side gate), msm_sold_recently and
--     msm_sites_trading (the risk ticks), msm__is_legacy_mirror, msm__managed_group,
--     msm_sql_contract (= 2; msm-publish refuses to plan below it: "Run 20261017c first").
--
-- NOTHING CHANGES FOR ANY VENUE UNTIL its company is switched on in Admin AND someone publishes.
--
-- ORDER FOR PETER (17 Oct verification: deploy the function FIRST, then this file, back to back)
--   0. Check nothing is waiting to publish (it must say 0), and that nobody is publishing on the dev
--      site:  select count(*) from public.msm_version_sites where status in ('scheduled', 'running');
--   1. Redeploy msm-publish:  npx supabase functions deploy msm-publish --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
--      (Against the round 1 database it waits and tries again: nothing is started or written.)
--   2. Run this file on Ops straight after. Read the check row at the bottom (expected values
--      written above it).
--   3. Push the branch to the develop site only. Then reload every open dev site Back Office tab
--      (the version number stays 5.11.75, so the tabs do not reload by themselves).
--   4. Demo company: Multi site menu, Menu details, "Refresh option groups from the sites" (it must
--      say nothing changes at any site), then test.
--   5. Switch on and import a new company only from a freshly loaded page.
--
-- UNDO: 20261017c_OPS_multi_site_menu_groups_ROLLBACK.sql (puts the round 1 functions back and drops
-- only what this file added). Run it BEFORE the round 1 roll back, never after.
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This migration must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it, nothing was changed.';
  end if;
  if to_regclass('public.msm_menus') is null or to_regprocedure('public.msm_apply_site(uuid,text,jsonb,jsonb,text,jsonb,text,text,uuid)') is null then
    raise exception 'Run 20261017_OPS_multi_site_menu.sql first. Nothing was changed.';
  end if;
  if to_regclass('public.tax_profiles') is null or to_regclass('public.tax_profile_lines') is null or to_regclass('public.tax_rates') is null then
    raise exception 'The tax tables are not all here. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

-- ============================================================================
-- 1. TABLES AND COLUMNS
-- ============================================================================

alter table public.msm_modifier_groups add column if not exists archived boolean not null default false;
alter table public.msm_modifier_groups add column if not exists family_base text;
alter table public.msm_modifier_group_sites add column if not exists kept jsonb not null default '{}'::jsonb;
alter table public.msm_products add column if not exists tax_by_type jsonb;
alter table public.msm_product_sites add column if not exists cleared_tax_profile_id uuid;
alter table public.msm_menus add column if not exists order_types text[];
alter table public.msm_menus add column if not exists refreshed_at timestamptz;
comment on column public.msm_products.tax_by_type is 'Multi site menu round 2: VAT per order type, {"takeaway": {"name": "Zero Rate", "percent": 0}}. Keys dine-in, takeaway, delivery, bar only. A missing key = the product''s own VAT.';
comment on column public.msm_menus.refreshed_at is 'Multi site menu round 2: the option groups are rows (import or the one time refresh). Null = round 2 changes wait for the refresh.';
comment on column public.msm_product_sites.cleared_tax_profile_id is 'Multi site menu round 2: the generated copy of the product''s own rate a publish cleared at this site (written only by msm_apply_site), so a later publish can put it back.';

create table if not exists public.msm_modifier_options (
  id            uuid primary key,
  menu_id       uuid not null references public.msm_menus(id) on delete cascade,
  group_id      uuid not null,
  name          text not null,
  price         numeric(10,2) not null default 0,
  product_id    uuid,
  sub_group_id  uuid,
  sort_order    integer not null default 0,
  archived      boolean not null default false,
  updated_at    timestamptz not null default now(),
  constraint msm_modifier_options_group_fk foreign key (group_id) references public.msm_modifier_groups(id) on delete cascade deferrable initially immediate,
  constraint msm_modifier_options_product_fk foreign key (product_id) references public.msm_products(id) on delete restrict deferrable initially immediate,
  constraint msm_modifier_options_sub_group_fk foreign key (sub_group_id) references public.msm_modifier_groups(id) on delete restrict deferrable initially immediate,
  constraint msm_modifier_options_name_ok check (char_length(btrim(name)) between 1 and 120),
  constraint msm_modifier_options_not_itself check (sub_group_id is distinct from group_id)
);
create index if not exists msm_modifier_options_menu on public.msm_modifier_options (menu_id);
create index if not exists msm_modifier_options_group on public.msm_modifier_options (group_id, sort_order);
comment on table public.msm_modifier_options is 'Multi site menu round 2: one row per option of a central option group, with its default price, its sub item (a central product) and its "Then ask" group.';

create table if not exists public.msm_modifier_option_sites (
  option_id        uuid not null,
  location_id      text not null,
  venue_option_id  text,
  active           boolean not null default true,
  price            numeric(10,2),
  kept             jsonb not null default '{}'::jsonb,
  updated_at       timestamptz not null default now(),
  primary key (option_id, location_id),
  constraint msm_modifier_option_sites_option_fk foreign key (option_id) references public.msm_modifier_options(id) on delete cascade deferrable initially immediate,
  constraint msm_modifier_option_sites_kept_object check (jsonb_typeof(kept) = 'object')
);
create index if not exists msm_modifier_option_sites_location on public.msm_modifier_option_sites (location_id);
comment on table public.msm_modifier_option_sites is 'Multi site menu round 2: an option at one site. No row = off there. venue_option_id is the option''s id inside that site''s group and never changes once set.';

-- The round 1 group site link may wait until the end of a start too (a group made in the same set).
alter table public.msm_modifier_group_sites alter constraint msm_modifier_group_sites_group_id_fkey deferrable initially immediate;

-- The change targets: round 1's five plus the four option group targets.
alter table public.msm_changes drop constraint if exists msm_changes_target_ok;
alter table public.msm_changes add constraint msm_changes_target_ok check (target in (
  'menu', 'menu_site', 'category', 'product', 'product_site',
  'modifier_group', 'modifier_group_site', 'modifier_option', 'modifier_option_site'));

-- ============================================================================
-- 2. GUARDS
-- ============================================================================

-- A site row's venue must belong to the menu's company (round 1, now with the option sites).
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
  elsif tg_table_name = 'msm_modifier_option_sites' then
    select m.org_id into v_org from public.msm_modifier_options o join public.msm_menus m on m.id = o.menu_id where o.id = new.option_id;
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
drop trigger if exists msm_site_org_guard on public.msm_modifier_option_sites;
create trigger msm_site_org_guard before insert or update on public.msm_modifier_option_sites for each row execute function public.msm_site_org_guard();

-- An option, its group, its sub item and its "Then ask" group are all in ONE group menu.
create or replace function public.msm_option_menu_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  if not exists (select 1 from public.msm_modifier_groups g where g.id = new.group_id and g.menu_id = new.menu_id)
     or (new.product_id is not null and not exists (select 1 from public.msm_products p where p.id = new.product_id and p.menu_id = new.menu_id))
     or (new.sub_group_id is not null and not exists (select 1 from public.msm_modifier_groups g where g.id = new.sub_group_id and g.menu_id = new.menu_id)) then
    raise exception 'An option points outside its group menu.' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end
$fn$;
drop trigger if exists msm_option_menu_guard on public.msm_modifier_options;
create trigger msm_option_menu_guard before insert or update on public.msm_modifier_options for each row execute function public.msm_option_menu_guard();

-- Is a central reference this menu's own, or created in this same set? (round 1, now with the
-- option groups and options)
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
      or (p_target = 'modifier_group' and exists (select 1 from public.msm_modifier_groups g where g.id = p_id and g.menu_id = p_menu))
      or (p_target = 'modifier_option' and exists (select 1 from public.msm_modifier_options o where o.id = p_id and o.menu_id = p_menu))
      or exists (select 1 from public.msm_changes x where x.change_set_id = p_set and x.target = p_target and x.entity_id = p_id and x.op = 'create');
$fn$;

-- A product's modifier_groups jsonb as group ids (a plain id or {groupId}).
create or replace function public.msm__group_ids(p_list jsonb)
returns setof text
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(a ->> 'groupId', case when jsonb_typeof(a) = 'string' then a #>> '{}' end)
    from jsonb_array_elements(case when jsonb_typeof(p_list) = 'array' then p_list else '[]'::jsonb end) a
   where coalesce(a ->> 'groupId', case when jsonb_typeof(a) = 'string' then a #>> '{}' end) is not null;
$fn$;

-- Changes: only into a DRAFT set (whoever writes), only allowlisted fields, only this menu's own
-- rows and this company's venues. The field lists are pinned to supabase/functions/_shared/msmModel.js
-- (STAGE_FIELDS, KEPT_COLUMNS, CHANNELS, ORDER_TYPE_TAX_KEYS, GROUP_KEPT_COLUMNS, OPTION_KEPT_KEYS,
-- SELECTION_TYPES) by src/lib/msm/msmMigration.test.js.
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
  v_kept     constant text[] := array['cat', 'cats', 'image', 'name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'tax_rate_id', 'allergens', 'tags', 'visibility', 'sold_alone', 'item_code', 'assigned_modifier_groups', 'type', 'parent_id', 'tax_overrides'];
  v_channels constant text[] := array['dineIn', 'takeaway', 'collection', 'delivery', 'driveThru'];
  v_tax_keys constant text[] := array['dine-in', 'takeaway', 'delivery', 'bar'];
  v_group_kept  constant text[] := array['name', 'min', 'max', 'selection_type'];
  v_option_kept constant text[] := array['name', 'item_link', 'sub_group'];
  v_selection   constant text[] := array['single', 'multiple', 'quantity'];
  v_vid      text;
  v_vg       text;
  v_group    uuid;
  v_refreshed timestamptz;
  v_site_ok  boolean;
begin
  if tg_op = 'DELETE' then
    select s.status into v_set from public.msm_change_sets s where s.id = old.change_set_id;
    if found and v_set.status <> 'draft' then
      raise exception 'This set is %, so its changes cannot be removed.', v_set.status using errcode = '42501';
    end if;
    -- Throwing away a NEW product, category, option group or option (the set itself still there):
    -- its site rows go with it, and a change that still uses it keeps it (otherwise the set would
    -- fail at its time).
    if found and old.op = 'create' and old.target = 'product' then
      if exists (select 1 from public.msm_changes x
                  where x.change_set_id = old.change_set_id and x.id <> old.id
                    and ((x.target = 'product' and x.after ->> 'parent_product_id' = old.entity_id::text)
                      or (x.target = 'modifier_option' and x.after ->> 'product_id' = old.entity_id::text))) then
        raise exception 'Other changes in this set use this new product (its sizes, or an option). Remove those first.' using errcode = '22023';
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
    elsif found and old.op = 'create' and old.target = 'modifier_group' then
      if exists (select 1 from public.msm_changes x
                  where x.change_set_id = old.change_set_id and x.id <> old.id
                    and ((x.target = 'modifier_option' and (x.after ->> 'group_id' = old.entity_id::text or x.after ->> 'sub_group_id' = old.entity_id::text))
                      or (x.target = 'product' and exists (select 1 from public.msm__group_ids(x.after -> 'modifier_groups') g where g = old.entity_id::text)))) then
        raise exception 'Other changes in this set use this new option group (its options, a "Then ask", or a product). Take those out first.' using errcode = '22023';
      end if;
      delete from public.msm_changes x
       where x.change_set_id = old.change_set_id and x.target = 'modifier_group_site' and x.entity_id = old.entity_id;
    elsif found and old.op = 'create' and old.target = 'modifier_option' then
      delete from public.msm_changes x
       where x.change_set_id = old.change_set_id and x.target = 'modifier_option_site' and x.entity_id = old.entity_id;
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
    when 'product' then array['category_id', 'extra_category_ids', 'parent_product_id', 'type', 'name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'default_price', 'default_channels', 'tax_rate_name', 'tax_rate_percent', 'allergens', 'tags', 'image', 'modifier_groups', 'visibility', 'sold_alone', 'item_code', 'site_only_location_id', 'archived', 'sort_order', 'family_base', 'tax_by_type']
    when 'product_site' then array['venue_item_id', 'active', 'price', 'channel_prices', 'kept']
    when 'modifier_group' then array['name', 'min', 'max', 'selection_type', 'sort_order', 'archived', 'family_base']
    when 'modifier_group_site' then array['venue_group_id', 'kept']
    when 'modifier_option' then array['group_id', 'name', 'price', 'product_id', 'sub_group_id', 'sort_order', 'archived']
    when 'modifier_option_site' then array['venue_option_id', 'active', 'price', 'kept']
  end;
  if v_allowed is null then
    raise exception 'Unknown kind of change: %', new.target using errcode = '22023';
  end if;
  select k into v_bad from jsonb_object_keys(new.after) k where k <> all (v_allowed) limit 1;
  if found then
    raise exception 'This cannot be changed here: %', v_bad using errcode = '22023';
  end if;
  if not ((new.target = 'menu' and new.op = 'update')
       or (new.target = 'menu_site' and new.op = 'create')
       or (new.target in ('category', 'product', 'modifier_group', 'modifier_option'))
       or (new.target in ('product_site', 'modifier_group_site', 'modifier_option_site') and new.op in ('create', 'update'))) then
    raise exception 'A % cannot be changed that way (%).', replace(new.target, '_', ' '), new.op using errcode = '22023';
  end if;

  -- Where: a site for site changes, never for menu wide ones; the site must be in the company.
  if new.target in ('menu_site', 'product_site', 'modifier_group_site', 'modifier_option_site') then
    if new.location_id is null or not public.msm__venue_in_org(new.location_id, v_set.org_id) then
      raise exception 'That site is not in this company.' using errcode = '42501';
    end if;
  elsif new.location_id is not null then
    raise exception 'This change is for every site, not one.' using errcode = '22023';
  end if;
  v_site_ok := new.location_id is null
    or exists (select 1 from public.msm_menu_sites s where s.menu_id = v_set.menu_id and s.location_id = new.location_id)
    or exists (select 1 from public.msm_changes x where x.change_set_id = v_set.id and x.target = 'menu_site' and x.location_id = new.location_id);

  -- Round 2 changes wait for the option groups to be rows (import, or the one time refresh).
  if new.target in ('modifier_group', 'modifier_group_site', 'modifier_option', 'modifier_option_site')
     or (new.target = 'product' and new.after ? 'tax_by_type')
     or (new.target = 'product_site' and jsonb_typeof(new.after -> 'kept') = 'object' and new.after -> 'kept' ? 'tax_overrides') then
    select m.refreshed_at into v_refreshed from public.msm_menus m where m.id = v_set.menu_id;
    if v_refreshed is null then
      raise exception 'Refresh the option groups from the sites first (Menu details). Nothing was changed.' using errcode = '22023';
    end if;
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
    -- Its option groups: this menu's own (or new in this set).
    if new.after ? 'modifier_groups' then
      for v_vid in select g from public.msm__group_ids(new.after -> 'modifier_groups') g loop
        if v_vid !~ '^[0-9a-fA-F-]{36}$' or not public.msm__ref_ok(v_set.menu_id, v_set.id, 'modifier_group', v_vid::uuid) then
          raise exception 'That option group is not in this group menu.' using errcode = '42501';
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
    -- VAT per order type: the four keys, each a rate name and percent (a missing key = the product's VAT).
    if new.after ? 'tax_by_type' and jsonb_typeof(new.after -> 'tax_by_type') not in ('object', 'null') then
      raise exception 'VAT by order type must be a list of order types.' using errcode = '22023';
    end if;
    if jsonb_typeof(new.after -> 'tax_by_type') = 'object' then
      select k into v_bad from jsonb_object_keys(new.after -> 'tax_by_type') k where k <> all (v_tax_keys) limit 1;
      if found then raise exception 'Unknown order type for VAT: %', v_bad using errcode = '22023'; end if;
      if exists (select 1 from jsonb_each(new.after -> 'tax_by_type') e
                  where jsonb_typeof(e.value) <> 'object' or coalesce(jsonb_typeof(e.value -> 'percent'), 'missing') <> 'number'
                     or coalesce(btrim(e.value ->> 'name'), '') = '' or (e.value ->> 'percent')::numeric not between 0 and 100) then
        raise exception 'VAT by order type needs a rate name and a percent from 0 to 100.' using errcode = '22023';
      end if;
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
      if not v_site_ok then
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
      -- Kept VAT by order type: per key, a rate id, null (the site's default) or false (no key).
      if new.after -> 'kept' ? 'tax_overrides' and (jsonb_typeof(new.after #> '{kept,tax_overrides}') <> 'object'
         or exists (select 1 from jsonb_each(new.after #> '{kept,tax_overrides}') e
                     where e.key !~ '^[a-z][a-z-]{0,23}$' or jsonb_typeof(e.value) not in ('string', 'null', 'boolean')
                        or (jsonb_typeof(e.value) = 'boolean' and e.value <> 'false'::jsonb))) then
        raise exception 'Kept VAT by order type must be a list of order types.' using errcode = '22023';
      end if;
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
  elsif new.target = 'modifier_group' then
    if new.op = 'create' then
      if exists (select 1 from public.msm_modifier_groups g where g.id = new.entity_id) then
        raise exception 'That option group already exists.' using errcode = '22023';
      end if;
      if coalesce(btrim(new.after ->> 'name'), '') = '' then
        raise exception 'Give the option group a name.' using errcode = '22023';
      end if;
    elsif not exists (select 1 from public.msm_modifier_groups g where g.id = new.entity_id and g.menu_id = v_set.menu_id) then
      raise exception 'That option group is not in this group menu.' using errcode = '42501';
    end if;
    if new.after ? 'name' and coalesce(btrim(new.after ->> 'name'), '') = '' then
      raise exception 'Give the option group a name.' using errcode = '22023';
    end if;
    if new.after ? 'selection_type' and coalesce(new.after ->> 'selection_type', '') <> all (v_selection) then
      raise exception 'Pick one choice, several choices, or the same choice more than once.' using errcode = '22023';
    end if;
    if (new.after ? 'min' and (jsonb_typeof(new.after -> 'min') <> 'number' or (new.after ->> 'min')::numeric not between 0 and 999 or (new.after ->> 'min')::numeric <> trunc((new.after ->> 'min')::numeric)))
       or (new.after ? 'max' and (jsonb_typeof(new.after -> 'max') <> 'number' or (new.after ->> 'max')::numeric not between 0 and 999 or (new.after ->> 'max')::numeric <> trunc((new.after ->> 'max')::numeric))) then
      raise exception 'Choose a whole number from 0 to 999.' using errcode = '22023';
    end if;
  elsif new.target = 'modifier_group_site' then
    if not public.msm__ref_ok(v_set.menu_id, v_set.id, 'modifier_group', new.entity_id) then
      raise exception 'That option group is not in this group menu.' using errcode = '42501';
    end if;
    if not v_site_ok then
      raise exception 'That site is not in the group menu yet. Add the site first.' using errcode = '22023';
    end if;
    if new.op = 'create' then
      if exists (select 1 from public.msm_modifier_group_sites s where s.group_id = new.entity_id and s.location_id = new.location_id) then
        raise exception 'That option group is already at that site.' using errcode = '22023';
      end if;
      v_vid := new.after ->> 'venue_group_id';
      if v_vid is null or btrim(v_vid) = '' then
        raise exception 'A group at a site needs that site''s group.' using errcode = '22023';
      end if;
      if not exists (select 1 from public.modifier_groups g where g.id = v_vid and g.location_id = new.location_id) then
        raise exception 'That option group is not at that site.' using errcode = '42501';
      end if;
      if exists (select 1 from public.msm_modifier_group_sites s where s.location_id = new.location_id and s.venue_group_id = v_vid) then
        raise exception 'That option group is already managed at that site.' using errcode = '22023';
      end if;
    else
      if new.after ? 'venue_group_id' then
        raise exception 'A site''s own id never changes.' using errcode = '22023';
      end if;
      if not exists (select 1 from public.msm_modifier_group_sites s where s.group_id = new.entity_id and s.location_id = new.location_id) then
        raise exception 'That option group is not at that site.' using errcode = '22023';
      end if;
    end if;
    if jsonb_typeof(new.after -> 'kept') = 'object' then
      select k into v_bad from jsonb_object_keys(new.after -> 'kept') k where k <> all (v_group_kept) limit 1;
      if found then raise exception 'A site cannot keep its own %', v_bad using errcode = '22023'; end if;
    elsif new.after ? 'kept' and jsonb_typeof(new.after -> 'kept') <> 'null' then
      raise exception 'Kept values must be a list of fields.' using errcode = '22023';
    end if;
  elsif new.target = 'modifier_option' then
    if new.op = 'create' then
      if exists (select 1 from public.msm_modifier_options o where o.id = new.entity_id) then
        raise exception 'That option already exists.' using errcode = '22023';
      end if;
      if nullif(new.after ->> 'group_id', '') is null then
        raise exception 'A new option needs its option group.' using errcode = '22023';
      end if;
      if coalesce(btrim(new.after ->> 'name'), '') = '' then
        raise exception 'Give the option a name.' using errcode = '22023';
      end if;
    else
      if not exists (select 1 from public.msm_modifier_options o where o.id = new.entity_id and o.menu_id = v_set.menu_id) then
        raise exception 'That option is not in this group menu.' using errcode = '42501';
      end if;
      if new.after ? 'group_id' then
        raise exception 'An option cannot move to another group. Remove it and add it there.' using errcode = '22023';
      end if;
    end if;
    if new.after ? 'name' and coalesce(btrim(new.after ->> 'name'), '') = '' then
      raise exception 'Give the option a name.' using errcode = '22023';
    end if;
    if not public.msm__ref_ok(v_set.menu_id, v_set.id, 'modifier_group', nullif(new.after ->> 'group_id', '')::uuid)
       or not public.msm__ref_ok(v_set.menu_id, v_set.id, 'modifier_group', nullif(new.after ->> 'sub_group_id', '')::uuid)
       or not public.msm__ref_ok(v_set.menu_id, v_set.id, 'product', nullif(new.after ->> 'product_id', '')::uuid) then
      raise exception 'That option group or sub item is not in this group menu.' using errcode = '42501';
    end if;
    select coalesce(nullif(new.after ->> 'group_id', '')::uuid, o.group_id) into v_group
      from (select 1) one left join public.msm_modifier_options o on o.id = new.entity_id;
    if nullif(new.after ->> 'sub_group_id', '')::uuid = v_group then
      raise exception 'An option cannot ask its own group again.' using errcode = '22023';
    end if;
    -- 0.00 or more from the editor; a minus price a site already had (imported) stays possible.
    if new.after ? 'price' and (jsonb_typeof(new.after -> 'price') <> 'number' or abs((new.after ->> 'price')::numeric) >= 100000) then
      raise exception 'An option needs a price (0.00 or more).' using errcode = '22023';
    end if;
  elsif new.target = 'modifier_option_site' then
    if not public.msm__ref_ok(v_set.menu_id, v_set.id, 'modifier_option', new.entity_id) then
      raise exception 'That option is not in this group menu.' using errcode = '42501';
    end if;
    if not v_site_ok then
      raise exception 'That site is not in the group menu yet. Add the site first.' using errcode = '22023';
    end if;
    if new.op = 'create' then
      if exists (select 1 from public.msm_modifier_option_sites s where s.option_id = new.entity_id and s.location_id = new.location_id) then
        raise exception 'That option is already set for that site.' using errcode = '22023';
      end if;
      v_vid := new.after ->> 'venue_option_id';
      if v_vid is not null then
        if btrim(v_vid) = '' then
          raise exception 'An option''s id at a site cannot be blank.' using errcode = '22023';
        end if;
        -- An existing id must be in that site's own copy of the group (bringing an option in).
        -- The option, or its group's row at that site, may be new in this same draft (bringing a
        -- site's own product and its option group in, or "Bring it into the group").
        select coalesce(gs.venue_group_id, gx.after ->> 'venue_group_id') into v_vg
          from (select coalesce((select o.group_id from public.msm_modifier_options o where o.id = new.entity_id),
                                (select nullif(x.after ->> 'group_id', '')::uuid from public.msm_changes x
                                  where x.change_set_id = v_set.id and x.target = 'modifier_option' and x.op = 'create' and x.entity_id = new.entity_id
                                  limit 1)) as gid) og
          left join public.msm_modifier_group_sites gs on gs.group_id = og.gid and gs.location_id = new.location_id
          left join public.msm_changes gx on gx.change_set_id = v_set.id and gx.target = 'modifier_group_site' and gx.op = 'create'
                                         and gx.entity_id = og.gid and gx.location_id = new.location_id
         limit 1;
        if v_vg is null or not exists (select 1 from public.modifier_groups g where g.id = v_vg and g.location_id = new.location_id
                                          and jsonb_typeof(g.options) = 'array' and g.options @> jsonb_build_array(jsonb_build_object('id', v_vid))) then
          raise exception 'That option is not in the site''s own option group.' using errcode = '42501';
        end if;
      end if;
    else
      if new.after ? 'venue_option_id' then
        raise exception 'A site''s own id never changes.' using errcode = '22023';
      end if;
      if not exists (select 1 from public.msm_modifier_option_sites s where s.option_id = new.entity_id and s.location_id = new.location_id) then
        raise exception 'That option is not set for that site.' using errcode = '22023';
      end if;
    end if;
    if jsonb_typeof(new.after -> 'kept') = 'object' then
      select k into v_bad from jsonb_object_keys(new.after -> 'kept') k where k <> all (v_option_kept) limit 1;
      if found then raise exception 'A site cannot keep its own %', v_bad using errcode = '22023'; end if;
    elsif new.after ? 'kept' and jsonb_typeof(new.after -> 'kept') <> 'null' then
      raise exception 'Kept values must be a list of fields.' using errcode = '22023';
    end if;
    if new.after ? 'price' and jsonb_typeof(new.after -> 'price') not in ('number', 'null') then
      raise exception 'An option''s price at a site is a number, or blank to use the group''s.' using errcode = '22023';
    end if;
    if new.after ? 'active' and jsonb_typeof(new.after -> 'active') <> 'boolean' then
      raise exception 'An option is on or off at a site.' using errcode = '22023';
    end if;
  end if;
  return new;
end
$fn$;

-- The sites a set reaches: every site of the menu (and any it adds) for a menu wide change, else
-- the sites its changes name.
create or replace function public.msm__sites_reached(p_set uuid)
returns setof text
language sql
stable
security definer
set search_path = ''
as $fn$
  with s as (select cs.menu_id from public.msm_change_sets cs where cs.id = p_set),
       wide as (select exists (select 1 from public.msm_changes c where c.change_set_id = p_set
                                 and c.target not in ('menu_site', 'product_site', 'modifier_group_site', 'modifier_option_site')) as yes)
  select ms.location_id from public.msm_menu_sites ms, s, wide where ms.menu_id = s.menu_id and wide.yes
  union
  select c.location_id from public.msm_changes c where c.change_set_id = p_set and c.location_id is not null;
$fn$;

-- ============================================================================
-- 3. ROW LEVEL SECURITY AND TABLE GRANTS (the new tables)
-- ============================================================================

do $rls$
declare
  t text;
begin
  foreach t in array array['msm_modifier_options', 'msm_modifier_option_sites'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
end
$rls$;

-- Read for a member of a switched on company (or ServOS). NO write policy: written only by the
-- functions below, so central state always equals what was published.
drop policy if exists msm_modifier_options_read on public.msm_modifier_options;
create policy msm_modifier_options_read on public.msm_modifier_options as permissive for select to authenticated
  using (menu_id in (select public.msm_viewable_menu_ids()));
drop policy if exists msm_modifier_option_sites_read on public.msm_modifier_option_sites;
create policy msm_modifier_option_sites_read on public.msm_modifier_option_sites as permissive for select to authenticated
  using (option_id in (select o.id from public.msm_modifier_options o where o.menu_id in (select public.msm_viewable_menu_ids())));

do $second_step$
declare
  t text;
begin
  if to_regprocedure('public.second_step_ok()') is null then
    return;
  end if;
  foreach t in array array['msm_modifier_options', 'msm_modifier_option_sites'] loop
    if not exists (select 1 from pg_policy p where p.polrelid = format('public.%I', t)::regclass and p.polname = 'second_step_fence') then
      execute format('create policy second_step_fence on public.%I as restrictive for all to authenticated using ((select public.second_step_ok())) with check ((select public.second_step_ok()))', t);
    end if;
  end loop;
end
$second_step$;

-- ============================================================================
-- 4. HELPERS
-- ============================================================================

-- The database end of the contract with msm-publish (msmModel.SQL_CONTRACT). msm-publish refuses
-- to plan against an older database, so group writes can never be dropped silently.
create or replace function public.msm_sql_contract()
returns integer
language sql
immutable
set search_path = ''
as $fn$
  select 2;
$fn$;

-- Is a tax profile still a generated copy of the item's own rate? The same conditions as
-- src/lib/taxCompute.js isLegacyMirror and supabase/functions/_shared/msmTax.js isMirrorProfile
-- (the three are pinned to one fixture list): generated from p_rate (the item's rate AFTER the
-- write), that rate active, rounding not per item, exactly one active line, a rate line, not
-- compound, not taxable, no order type limit, the rate's own inclusive or exclusive mode and rate,
-- and the basis settings the adapter gives that rate.
create or replace function public.msm__is_legacy_mirror(p_profile uuid, p_rate uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce((
    select coalesce(r.active, true)
       and coalesce(p.rounding ->> 'level', 'invoice') <> 'item'
       and (select count(*) from public.tax_profile_lines l where l.profile_id = p.id and coalesce(l.active, true)) = 1
       and exists (
         select 1 from public.tax_profile_lines l
          where l.profile_id = p.id and coalesce(l.active, true)
            and coalesce(l.line_type, 'rate') = 'rate'
            and not coalesce(l.compound, false) and not coalesce(l.taxable, false)
            and (l.order_types is null or cardinality(l.order_types) = 0 or 'all' = any (l.order_types))
            and (case when l.mode = 'inclusive' then 'inclusive' else 'exclusive' end)
                = (case when coalesce(r.type, '') = 'inclusive' then 'inclusive' else 'exclusive' end)
            and abs(coalesce(l.rate, 0) - coalesce(r.rate, 0)) < 0.000000001
            and coalesce(l.tax_basis, 'pre_discount') = (case when coalesce(r.type, '') = 'inclusive' then 'pre_discount' else 'post_discount' end)
            and coalesce(l.tax_service_charge, coalesce(r.type, '') <> 'inclusive') = (coalesce(r.type, '') <> 'inclusive')
            and coalesce(l.tax_delivery_fee, false) = false)
      from public.tax_profiles p
      join public.tax_rates r on r.id = p.generated_from_rate_id
     where p.id = p_profile and p_rate is not null and p.generated_from_rate_id = p_rate and r.location_id = p.location_id
  ), false);
$fn$;

-- Is a venue option group one this group menu manages at that venue (or one this same write made)?
create or replace function public.msm__managed_group(p_menu uuid, p_location text, p_id text, p_new text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select p_id = any (coalesce(p_new, '{}'))
      or exists (select 1 from public.msm_modifier_group_sites gs join public.msm_modifier_groups g on g.id = gs.group_id
                  where g.menu_id = p_menu and gs.location_id = p_location and gs.venue_group_id = p_id);
$fn$;

-- ============================================================================
-- 5. START A VERSION (round 1, now with the option groups and VAT per order type)
-- ============================================================================

-- Apply a version's change set to the CENTRAL tables, once (idempotent), recording the central
-- before and after of every change (for history and undo), and number the version.
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
  -- Dependency order (the menu, its sites, categories, option groups, products, a group at a site,
  -- options, product sites, option sites), and links between new rows checked at commit.
  set constraints public.msm_categories_parent_id_fkey, public.msm_categories_route_like_id_fkey,
                  public.msm_products_category_id_fkey, public.msm_products_parent_product_id_fkey,
                  public.msm_product_sites_product_id_fkey, public.msm_modifier_group_sites_group_id_fkey,
                  public.msm_modifier_options_group_fk, public.msm_modifier_options_product_fk,
                  public.msm_modifier_options_sub_group_fk, public.msm_modifier_option_sites_option_fk deferred;
  for c in select * from public.msm_changes x where x.change_set_id = v.change_set_id
            order by case x.target when 'menu' then 0 when 'menu_site' then 1 when 'category' then 2 when 'modifier_group' then 3
                                   when 'product' then 4 when 'modifier_group_site' then 5 when 'modifier_option' then 6
                                   when 'product_site' then 7 when 'modifier_option_site' then 8 else 9 end,
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
    elsif c.target = 'modifier_group' then
      if c.op = 'create' then
        insert into public.msm_modifier_groups (id, menu_id, name, min, max, selection_type, options, sort_order, archived, family_base)
        select c.entity_id, v.menu_id, coalesce(nullif(btrim(r.name), ''), 'Options'), coalesce(r.min, 0), coalesce(r.max, 1),
               coalesce(r.selection_type, 'single'), '[]'::jsonb, coalesce(r.sort_order, 0), coalesce(r.archived, false), r.family_base
          from jsonb_populate_record(null::public.msm_modifier_groups, c.after) r
        on conflict (id) do nothing;
      else
        select to_jsonb(x) into v_row from public.msm_modifier_groups x where x.id = c.entity_id and x.menu_id = v.menu_id;
        if c.op = 'remove' then
          v_before := jsonb_build_object('archived', v_row -> 'archived');
          update public.msm_modifier_groups set archived = true, updated_at = now() where id = c.entity_id and menu_id = v.menu_id;
        else
          select jsonb_object_agg(k, v_row -> k) into v_before from jsonb_object_keys(c.after) k;
          update public.msm_modifier_groups t
             set (name, min, max, selection_type, sort_order, archived, family_base, updated_at) =
                 (select coalesce(nullif(btrim(r.name), ''), t.name), coalesce(r.min, 0), coalesce(r.max, 1), coalesce(r.selection_type, 'single'),
                         coalesce(r.sort_order, 0), coalesce(r.archived, false), r.family_base, now()
                    from jsonb_populate_record(t, c.after) r)
           where t.id = c.entity_id and t.menu_id = v.menu_id;
        end if;
      end if;
    elsif c.target = 'product' then
      if c.op = 'create' then
        insert into public.msm_products (id, menu_id, category_id, extra_category_ids, parent_product_id, type, name, menu_name, receipt_name,
               kitchen_name, description, default_price, default_channels, tax_rate_name, tax_rate_percent, allergens, tags, image,
               modifier_groups, visibility, sold_alone, item_code, site_only_location_id, archived, sort_order, family_base, tax_by_type)
        select c.entity_id, v.menu_id, r.category_id, coalesce(r.extra_category_ids, '{}'), r.parent_product_id, coalesce(r.type, 'simple'),
               coalesce(nullif(btrim(r.name), ''), 'Product'), r.menu_name, r.receipt_name, r.kitchen_name, coalesce(r.description, ''),
               coalesce(r.default_price, 0), r.default_channels, r.tax_rate_name, r.tax_rate_percent, coalesce(r.allergens, '{}'),
               coalesce(r.tags, '[]'::jsonb), r.image, coalesce(r.modifier_groups, '[]'::jsonb), r.visibility, coalesce(r.sold_alone, false),
               r.item_code, r.site_only_location_id, coalesce(r.archived, false), coalesce(r.sort_order, 0), r.family_base, r.tax_by_type
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
                  sold_alone, item_code, site_only_location_id, archived, sort_order, family_base, tax_by_type, updated_at) =
                 (select r.category_id, coalesce(r.extra_category_ids, '{}'), r.parent_product_id, coalesce(r.type, 'simple'),
                         coalesce(nullif(btrim(r.name), ''), t.name), r.menu_name, r.receipt_name, r.kitchen_name, coalesce(r.description, ''),
                         coalesce(r.default_price, 0), r.default_channels, r.tax_rate_name, r.tax_rate_percent, coalesce(r.allergens, '{}'),
                         coalesce(r.tags, '[]'::jsonb), r.image, coalesce(r.modifier_groups, '[]'::jsonb), r.visibility, coalesce(r.sold_alone, false),
                         r.item_code, r.site_only_location_id, coalesce(r.archived, false), coalesce(r.sort_order, 0), r.family_base, r.tax_by_type, now()
                    from jsonb_populate_record(t, c.after) r)
           where t.id = c.entity_id and t.menu_id = v.menu_id;
        end if;
      end if;
    elsif c.target = 'modifier_group_site' then
      if c.op = 'create' then
        insert into public.msm_modifier_group_sites (group_id, location_id, venue_group_id, kept)
        values (c.entity_id, c.location_id, c.after ->> 'venue_group_id', coalesce(case when jsonb_typeof(c.after -> 'kept') = 'object' then c.after -> 'kept' end, '{}'::jsonb))
        on conflict (group_id, location_id) do nothing;
      else
        select to_jsonb(x) into v_row from public.msm_modifier_group_sites x where x.group_id = c.entity_id and x.location_id = c.location_id;
        select jsonb_object_agg(k, v_row -> k) into v_before from jsonb_object_keys(c.after) k;
        update public.msm_modifier_group_sites t
           set kept = coalesce(case when jsonb_typeof(c.after -> 'kept') = 'object' then c.after -> 'kept' end, '{}'::jsonb)
         where t.group_id = c.entity_id and t.location_id = c.location_id and c.after ? 'kept';
      end if;
    elsif c.target = 'modifier_option' then
      if c.op = 'create' then
        insert into public.msm_modifier_options (id, menu_id, group_id, name, price, product_id, sub_group_id, sort_order, archived)
        select c.entity_id, v.menu_id, r.group_id, coalesce(nullif(btrim(r.name), ''), 'Option'), coalesce(r.price, 0), r.product_id, r.sub_group_id,
               coalesce(r.sort_order, 0), coalesce(r.archived, false)
          from jsonb_populate_record(null::public.msm_modifier_options, c.after) r
        on conflict (id) do nothing;
      else
        select to_jsonb(x) into v_row from public.msm_modifier_options x where x.id = c.entity_id and x.menu_id = v.menu_id;
        if c.op = 'remove' then
          v_before := jsonb_build_object('archived', v_row -> 'archived');
          update public.msm_modifier_options set archived = true where id = c.entity_id and menu_id = v.menu_id;
        else
          select jsonb_object_agg(k, v_row -> k) into v_before from jsonb_object_keys(c.after) k;
          update public.msm_modifier_options t
             set (name, price, product_id, sub_group_id, sort_order, archived) =
                 (select coalesce(nullif(btrim(r.name), ''), t.name), coalesce(r.price, 0), r.product_id, r.sub_group_id,
                         coalesce(r.sort_order, 0), coalesce(r.archived, false)
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
    elsif c.target = 'modifier_option_site' then
      if c.op = 'create' then
        insert into public.msm_modifier_option_sites (option_id, location_id, venue_option_id, active, price, kept)
        select c.entity_id, c.location_id, r.venue_option_id, coalesce(r.active, true), r.price, coalesce(r.kept, '{}'::jsonb)
          from jsonb_populate_record(null::public.msm_modifier_option_sites, c.after) r
        on conflict (option_id, location_id) do nothing;
      else
        select to_jsonb(x) into v_row from public.msm_modifier_option_sites x where x.option_id = c.entity_id and x.location_id = c.location_id;
        select jsonb_object_agg(k, v_row -> k) into v_before from jsonb_object_keys(c.after) k;
        update public.msm_modifier_option_sites t
           set (active, price, kept, updated_at) =
               (select coalesce(r.active, true), r.price, coalesce(r.kept, '{}'::jsonb), now()
                  from jsonb_populate_record(t, c.after) r)
         where t.option_id = c.entity_id and t.location_id = c.location_id;
      end if;
    end if;
    v_log := v_log || jsonb_build_array(jsonb_build_object('target', c.target, 'entity_id', c.entity_id, 'location_id', c.location_id,
                                                           'op', c.op, 'before', v_before, 'after', c.after));
  end loop;

  -- Every reference still inside this menu (the staging guard checked each one; this is the last word).
  if exists (select 1 from public.msm_products p where p.menu_id = v.menu_id and (
        (p.category_id is not null and not exists (select 1 from public.msm_categories x where x.id = p.category_id and x.menu_id = v.menu_id))
     or (p.parent_product_id is not null and not exists (select 1 from public.msm_products q where q.id = p.parent_product_id and q.menu_id = v.menu_id))
     or exists (select 1 from unnest(p.extra_category_ids) e where not exists (select 1 from public.msm_categories x where x.id = e and x.menu_id = v.menu_id))
     or exists (select 1 from public.msm__group_ids(p.modifier_groups) g
                 where not exists (select 1 from public.msm_modifier_groups x where x.id::text = g and x.menu_id = v.menu_id))))
  or exists (select 1 from public.msm_categories k where k.menu_id = v.menu_id and (
        (k.parent_id is not null and not exists (select 1 from public.msm_categories x where x.id = k.parent_id and x.menu_id = v.menu_id))
     or (k.route_like_id is not null and not exists (select 1 from public.msm_categories x where x.id = k.route_like_id and x.menu_id = v.menu_id))))
  or exists (select 1 from public.msm_modifier_options o where o.menu_id = v.menu_id and (
        not exists (select 1 from public.msm_modifier_groups x where x.id = o.group_id and x.menu_id = v.menu_id)
     or (o.product_id is not null and not exists (select 1 from public.msm_products x where x.id = o.product_id and x.menu_id = v.menu_id))
     or (o.sub_group_id is not null and not exists (select 1 from public.msm_modifier_groups x where x.id = o.sub_group_id and x.menu_id = v.menu_id)))) then
    raise exception 'A product, category or option points outside this group menu. Nothing was published.';
  end if;

  update public.msm_menus set last_version_no = last_version_no + 1, updated_at = now() where id = v.menu_id returning last_version_no into v_no;
  update public.msm_versions set version_no = v_no, started_at = now(), status = 'running', changes = v_log where id = p_version;
  perform public.msm__refresh_version(p_version);
  return jsonb_build_object('ok', true, 'already', false, 'version_no', v_no, 'changes', v_log);
end
$fn$;

-- ============================================================================
-- 6. THE FIRST IMPORT (round 1, now with option rows, group kept values and VAT per order type)
-- ============================================================================

-- Writes the CENTRAL tables only, in one transaction. Nothing at any venue. Every venue id it is
-- given must exist at that venue (an id of another venue would later write into that venue).
-- Refused when the company already has a live group menu.
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
  -- A round 2 import always sends its options (even as []). A page still running round 1 sends
  -- none, and would make every option group empty: refused, in words (17 Oct verification).
  if not (p_payload ? 'options') then
    raise exception 'This page is out of date. Reload the page, then import again. Nothing was changed.' using errcode = '22023';
  end if;
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
  insert into public.msm_menus (id, org_id, name, description, created_by, last_version_no, last_published_at, last_published_by, refreshed_at)
  values (v_menu, v_org, coalesce(nullif(btrim(p_payload #>> '{menu,name}'), ''), 'Group menu'), coalesce(p_payload #>> '{menu,description}', ''), auth.uid(), 1, now(), v_name, now());
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

  -- Option groups (the options are rows, below; the old jsonb list stays empty).
  insert into public.msm_modifier_groups (id, menu_id, name, min, max, selection_type, options, sort_order, source_location_id, archived, family_base)
  select r.id, v_menu, coalesce(r.name, 'Options'), coalesce(r.min, 0), coalesce(r.max, 1), coalesce(r.selection_type, 'single'),
         '[]'::jsonb, coalesce(r.sort_order, 0), r.source_location_id, false, r.family_base
    from jsonb_populate_recordset(null::public.msm_modifier_groups, coalesce(p_payload -> 'groups', '[]'::jsonb)) r;
  select x ->> 'venue_group_id' into v_bad
    from jsonb_array_elements(coalesce(p_payload -> 'groups', '[]'::jsonb)) g, jsonb_array_elements(coalesce(g -> 'sites', '[]'::jsonb)) x
   where not exists (select 1 from public.modifier_groups mg where mg.id = x ->> 'venue_group_id' and mg.location_id = x ->> 'location_id')
      or (jsonb_typeof(x -> 'kept') = 'object' and exists (select 1 from jsonb_object_keys(x -> 'kept') k where k <> all (array['name', 'min', 'max', 'selection_type'])))
   limit 1;
  if found then
    raise exception 'A modifier group is not at the site it was matched to, or keeps a field it cannot (%).', v_bad using errcode = '42501';
  end if;
  insert into public.msm_modifier_group_sites (group_id, location_id, venue_group_id, kept)
  select (g ->> 'id')::uuid, x ->> 'location_id', x ->> 'venue_group_id', case when jsonb_typeof(x -> 'kept') = 'object' then x -> 'kept' else '{}'::jsonb end
    from jsonb_array_elements(coalesce(p_payload -> 'groups', '[]'::jsonb)) g, jsonb_array_elements(coalesce(g -> 'sites', '[]'::jsonb)) x;

  -- Products (references inside this menu only: the foreign keys plus the check below).
  insert into public.msm_products (id, menu_id, category_id, extra_category_ids, parent_product_id, type, name, menu_name, receipt_name,
         kitchen_name, description, default_price, default_channels, tax_rate_name, tax_rate_percent, allergens, tags, image,
         modifier_groups, visibility, sold_alone, item_code, site_only_location_id, archived, sort_order, family_base, tax_by_type)
  select r.id, v_menu, r.category_id, coalesce(r.extra_category_ids, '{}'), r.parent_product_id, coalesce(r.type, 'simple'),
         coalesce(nullif(btrim(r.name), ''), 'Product'), r.menu_name, r.receipt_name, r.kitchen_name, coalesce(r.description, ''),
         coalesce(r.default_price, 0), r.default_channels, r.tax_rate_name, r.tax_rate_percent, coalesce(r.allergens, '{}'),
         coalesce(r.tags, '[]'::jsonb), r.image, coalesce(r.modifier_groups, '[]'::jsonb), r.visibility, coalesce(r.sold_alone, false),
         r.item_code, r.site_only_location_id, false, coalesce(r.sort_order, 0), r.family_base, r.tax_by_type
    from jsonb_populate_recordset(null::public.msm_products, coalesce(p_payload -> 'products', '[]'::jsonb)) r;
  if exists (select 1 from public.msm_products p where p.menu_id = v_menu and (
        (p.category_id is not null and not exists (select 1 from public.msm_categories c where c.id = p.category_id and c.menu_id = v_menu))
     or (p.parent_product_id is not null and not exists (select 1 from public.msm_products q where q.id = p.parent_product_id and q.menu_id = v_menu))
     or exists (select 1 from unnest(p.extra_category_ids) x where not exists (select 1 from public.msm_categories c where c.id = x and c.menu_id = v_menu))
     or exists (select 1 from public.msm__group_ids(p.modifier_groups) g where not exists (select 1 from public.msm_modifier_groups x where x.id::text = g and x.menu_id = v_menu))
     or (p.site_only_location_id is not null and not public.msm__venue_in_org(p.site_only_location_id, v_org)))) then
    raise exception 'A product points at a category, product, option group or site that is not in this group menu.' using errcode = '42501';
  end if;
  select x ->> 'venue_item_id' into v_bad
    from jsonb_array_elements(coalesce(p_payload -> 'products', '[]'::jsonb)) p, jsonb_array_elements(coalesce(p -> 'sites', '[]'::jsonb)) x
   where not exists (select 1 from public.menu_items mi where mi.id = x ->> 'venue_item_id' and mi.location_id = x ->> 'location_id')
      or (jsonb_typeof(x -> 'kept') = 'object' and exists (select 1 from jsonb_object_keys(x -> 'kept') k
            where k <> all (array['cat', 'cats', 'image', 'name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'tax_rate_id', 'allergens', 'tags', 'visibility', 'sold_alone', 'item_code', 'assigned_modifier_groups', 'type', 'parent_id', 'tax_overrides'])))
   limit 1;
  if found then
    raise exception 'A product is not at the site it was matched to, or keeps a field it cannot (%).', v_bad using errcode = '42501';
  end if;
  insert into public.msm_product_sites (product_id, location_id, venue_item_id, active, price, channel_prices, kept)
  select (p ->> 'id')::uuid, x ->> 'location_id', x ->> 'venue_item_id', coalesce((x ->> 'active')::boolean, true),
         nullif(x ->> 'price', '')::numeric, case when jsonb_typeof(x -> 'channel_prices') = 'object' then x -> 'channel_prices' end,
         case when jsonb_typeof(x -> 'kept') = 'object' then x -> 'kept' else '{}'::jsonb end
    from jsonb_array_elements(coalesce(p_payload -> 'products', '[]'::jsonb)) p, jsonb_array_elements(coalesce(p -> 'sites', '[]'::jsonb)) x;

  -- Options and each site's option (round 2).
  perform public.msm__import_options(v_menu, p_payload -> 'options');

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

-- Options and option sites from an import payload, into a menu whose groups and products are in.
-- Each venue option id must be in that site's own copy of the group. Internal.
create or replace function public.msm__import_options(p_menu uuid, p_options jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_bad text;
  v_n   integer;
begin
  if p_options is null or jsonb_typeof(p_options) <> 'array' or jsonb_array_length(p_options) = 0 then
    return 0;
  end if;
  insert into public.msm_modifier_options (id, menu_id, group_id, name, price, product_id, sub_group_id, sort_order, archived)
  select r.id, p_menu, r.group_id, coalesce(nullif(btrim(r.name), ''), 'Option'), coalesce(r.price, 0), r.product_id, r.sub_group_id,
         coalesce(r.sort_order, 0), coalesce(r.archived, false)
    from jsonb_populate_recordset(null::public.msm_modifier_options, p_options) r;
  get diagnostics v_n = row_count;
  select x ->> 'location_id' into v_bad
    from jsonb_array_elements(p_options) o, jsonb_array_elements(coalesce(o -> 'sites', '[]'::jsonb)) x
   where (jsonb_typeof(x -> 'kept') = 'object' and exists (select 1 from jsonb_object_keys(x -> 'kept') k where k <> all (array['name', 'item_link', 'sub_group'])))
      or (x ->> 'venue_option_id' is not null and not exists (
            select 1 from public.msm_modifier_group_sites gs
              join public.modifier_groups mg on mg.id = gs.venue_group_id and mg.location_id = gs.location_id
             where gs.group_id = (o ->> 'group_id')::uuid and gs.location_id = x ->> 'location_id'
               and jsonb_typeof(mg.options) = 'array' and mg.options @> jsonb_build_array(jsonb_build_object('id', x ->> 'venue_option_id'))))
   limit 1;
  if found then
    raise exception 'An option is not in its site''s own group, or keeps a field it cannot (%).', v_bad using errcode = '42501';
  end if;
  insert into public.msm_modifier_option_sites (option_id, location_id, venue_option_id, active, price, kept)
  select (o ->> 'id')::uuid, x ->> 'location_id', nullif(x ->> 'venue_option_id', ''), coalesce((x ->> 'active')::boolean, false),
         nullif(x ->> 'price', '')::numeric, case when jsonb_typeof(x -> 'kept') = 'object' then x -> 'kept' else '{}'::jsonb end
    from jsonb_array_elements(p_options) o, jsonb_array_elements(coalesce(o -> 'sites', '[]'::jsonb)) x;
  return v_n;
end
$fn$;

-- THE ONE TIME REFRESH (design 1.9): a group menu imported before round 2 gets its option groups
-- as rows, the group rules each site keeps, and VAT per order type, from msm-publish's
-- refreshGroupsPayload (which proved zero writes at every site first). Writes the CENTRAL tables
-- only. Refused when it has already run, while a draft or a scheduled push holds option group or
-- VAT changes, or when any site saved its menu since msm-publish read it (fingerprints).
create or replace function public.msm_import_groups(p_menu uuid, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_m     public.msm_menus%rowtype;
  v_bad   text;
  v_name  text;
  v_no    integer;
  v_groups integer := 0;
  v_options integer := 0;
begin
  select * into v_m from public.msm_menus m where m.id = p_menu and m.status = 'live' for update;
  if not found then
    raise exception 'No such group menu.' using errcode = '22023';
  end if;
  perform public.msm__require_editor(v_m.org_id);
  if v_m.refreshed_at is not null then
    raise exception 'The option groups were already brought in. Nothing was changed.' using errcode = '22023';
  end if;
  if exists (select 1 from public.msm_changes c join public.msm_change_sets s on s.id = c.change_set_id
              where s.menu_id = p_menu and s.status in ('draft', 'scheduled', 'running')
                and (c.target in ('modifier_group', 'modifier_group_site', 'modifier_option', 'modifier_option_site')
                  or (c.target = 'product' and (c.after ? 'modifier_groups' or c.after ? 'tax_by_type')))) then
    raise exception 'A draft or a scheduled push changes option groups. Publish it, cancel it or take those changes out first. Nothing was changed.' using errcode = '22023';
  end if;
  -- Every site exactly as msm-publish read it.
  select f.key into v_bad from jsonb_each_text(coalesce(p_payload -> 'fingerprints', '{}'::jsonb)) f
   where f.value is distinct from public.msm_venue_fingerprint(f.key) limit 1;
  if found then
    raise exception 'A site saved its menu while the option groups were being read. Nothing was changed. Try again.' using errcode = '40001';
  end if;
  if exists (select 1 from public.msm_menu_sites s where s.menu_id = p_menu
              and not (coalesce(p_payload -> 'fingerprints', '{}'::jsonb) ? s.location_id)) then
    raise exception 'Every site must be read for the refresh. Nothing was changed.' using errcode = '22023';
  end if;
  if exists (select 1 from public.msm_modifier_options o where o.menu_id = p_menu) then
    raise exception 'This group menu already has option rows. Nothing was changed.' using errcode = '22023';
  end if;

  -- Groups: those already in the group menu keep their ids and rules; new ones (the groups an
  -- option asks next) come in.
  if exists (select 1 from jsonb_array_elements(coalesce(p_payload -> 'groups', '[]'::jsonb)) g
              join public.msm_modifier_groups x on x.id = (g ->> 'id')::uuid where x.menu_id <> p_menu) then
    raise exception 'An option group belongs to another group menu.' using errcode = '42501';
  end if;
  insert into public.msm_modifier_groups (id, menu_id, name, min, max, selection_type, options, sort_order, source_location_id, archived, family_base)
  select r.id, p_menu, coalesce(r.name, 'Options'), coalesce(r.min, 0), coalesce(r.max, 1), coalesce(r.selection_type, 'single'),
         '[]'::jsonb, coalesce(r.sort_order, 0), r.source_location_id, false, r.family_base
    from jsonb_populate_recordset(null::public.msm_modifier_groups, coalesce(p_payload -> 'groups', '[]'::jsonb)) r
   where not exists (select 1 from public.msm_modifier_groups x where x.id = r.id);
  get diagnostics v_groups = row_count;
  update public.msm_modifier_groups x set family_base = coalesce(x.family_base, g ->> 'family_base'), updated_at = now()
    from jsonb_array_elements(coalesce(p_payload -> 'groups', '[]'::jsonb)) g
   where x.id = (g ->> 'id')::uuid and x.menu_id = p_menu;
  select x ->> 'venue_group_id' into v_bad
    from jsonb_array_elements(coalesce(p_payload -> 'groups', '[]'::jsonb)) g, jsonb_array_elements(coalesce(g -> 'sites', '[]'::jsonb)) x
   where not exists (select 1 from public.modifier_groups mg where mg.id = x ->> 'venue_group_id' and mg.location_id = x ->> 'location_id')
      or not exists (select 1 from public.msm_menu_sites s where s.menu_id = p_menu and s.location_id = x ->> 'location_id')
      or exists (select 1 from public.msm_modifier_group_sites gs where gs.group_id = (g ->> 'id')::uuid and gs.location_id = x ->> 'location_id'
                   and gs.venue_group_id is distinct from x ->> 'venue_group_id')
      or (jsonb_typeof(x -> 'kept') = 'object' and exists (select 1 from jsonb_object_keys(x -> 'kept') k where k <> all (array['name', 'min', 'max', 'selection_type'])))
   limit 1;
  if found then
    raise exception 'An option group is not at the site it was matched to (%). Nothing was changed.', v_bad using errcode = '42501';
  end if;
  insert into public.msm_modifier_group_sites (group_id, location_id, venue_group_id, kept)
  select (g ->> 'id')::uuid, x ->> 'location_id', x ->> 'venue_group_id', case when jsonb_typeof(x -> 'kept') = 'object' then x -> 'kept' else '{}'::jsonb end
    from jsonb_array_elements(coalesce(p_payload -> 'groups', '[]'::jsonb)) g, jsonb_array_elements(coalesce(g -> 'sites', '[]'::jsonb)) x
  on conflict (group_id, location_id) do update set kept = excluded.kept;

  v_options := public.msm__import_options(p_menu, p_payload -> 'options');

  -- VAT per order type: the group's, and what each site keeps (only that key of kept is touched).
  update public.msm_products p set tax_by_type = case when jsonb_typeof(x -> 'tax_by_type') = 'object' then x -> 'tax_by_type' end, updated_at = now()
    from jsonb_array_elements(coalesce(p_payload -> 'products', '[]'::jsonb)) x
   where p.id = (x ->> 'id')::uuid and p.menu_id = p_menu;
  update public.msm_product_sites ps
     set kept = (ps.kept - 'tax_overrides') || case when jsonb_typeof(s -> 'kept' -> 'tax_overrides') = 'object'
                                                     then jsonb_build_object('tax_overrides', s -> 'kept' -> 'tax_overrides') else '{}'::jsonb end,
         updated_at = now()
    from jsonb_array_elements(coalesce(p_payload -> 'products', '[]'::jsonb)) x, jsonb_array_elements(coalesce(x -> 'sites', '[]'::jsonb)) s
   where ps.product_id = (x ->> 'id')::uuid and ps.location_id = s ->> 'location_id'
     and exists (select 1 from public.msm_products p where p.id = ps.product_id and p.menu_id = p_menu);

  select coalesce(nullif(btrim(p.full_name), ''), p.email) into v_name from public.user_profiles p where p.id = auth.uid();
  update public.msm_menus set refreshed_at = now(), last_version_no = last_version_no + 1, updated_at = now() where id = p_menu returning last_version_no into v_no;
  insert into public.msm_versions (menu_id, org_id, version_no, kind, title, status, created_by, created_by_name, started_at, finished_at, changes)
  values (p_menu, v_m.org_id, v_no, 'import', 'Option groups brought in', 'done', auth.uid(), v_name, now(), now(), '[]'::jsonb);
  return jsonb_build_object('ok', true, 'groups_new', v_groups, 'options', v_options, 'version_no', v_no,
                            'words', format('Option groups brought in: %s options. 0 changes at 0 sites.', v_options));
end
$fn$;

-- ============================================================================
-- 7. WRITE ONE VENUE (round 1, with option groups written option by option and VAT per order type)
-- ============================================================================
--   p_writes   msmPlan.js planSite(...).writes, these top level keys ONLY (anything else refused):
--     menus: {insert:[row], update:[{id, set}]}, categories: {insert, update},
--     items: {insert:[row], update:[{id, set, pricing?, tax_overrides?: {set:{key: rate id}, remove:[keys]}}]},
--     links: {insert:[{menu_id, category_id, sort_order}], delete:[{menu_id, category_id}]},
--     groups: {insert:[row], update:[{id, set, options:[{op:'patch', id, set, unset?} | {op:'add', entry, after?, before?}
--                                                     | {op:'drop', id} | {op:'order', ids}]}]},
--     routing: [{centre_id, category_id}],
--     maps: {categories:[{category_id, venue_category_id}], groups:[{group_id, venue_group_id}],
--            options:[{option_id, venue_option_id}], items:[{product_id, venue_item_id, active?}], menu_site: {venue_menu_id}}
--               (items.active: false for a product sold on its own that this publish added at the site
--               only for an option, so central never says it is on sale there; true or absent otherwise)
--   p_snapshot  the config push (msmSnapshot.js), built from the same read with these writes applied;
--               every product and option group written here is stamped from the row it now holds
--   p_fingerprint  msm_venue_fingerprint as the function read it BEFORE that read
-- Idempotent: a site already done says so and writes nothing. Every venue row the writes name is
-- LOCKED first, then the fingerprint is checked: a venue saved in between is refused whole
-- ({ok:false, reason:'changed'}) and the function reads again.
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
  v_ins_items  constant text[] := array['id', 'name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'type', 'cat', 'cats', 'parent_id', 'sort_order', 'pricing', 'allergens', 'assigned_modifier_groups', 'visibility', 'sold_alone', 'archived', 'tax_rate_id', 'image', 'scope', 'org_id', 'tags', 'item_code', 'tax_overrides'];
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
    -- VAT per order type: the four keys, each a rate of THIS site (never a foreign id).
    if w ? 'tax_overrides' and jsonb_typeof(w -> 'tax_overrides') <> 'null' and (jsonb_typeof(w -> 'tax_overrides') <> 'object'
       or exists (select 1 from jsonb_object_keys(w -> 'tax_overrides') k where k <> all (v_tax_keys))
       or exists (select 1 from jsonb_each(w -> 'tax_overrides') e
                   where jsonb_typeof(e.value) <> 'string'
                      or not exists (select 1 from public.tax_rates r where r.id::text = e.value #>> '{}' and r.location_id::text = p_location))) then
      raise exception 'A new product has VAT by order type that is not a rate at this site. Nothing was written.';
    end if;
    insert into public.menu_items (id, location_id, name, menu_name, receipt_name, kitchen_name, description, type, cat, cats, parent_id, sort_order,
                                   pricing, allergens, assigned_modifier_groups, visibility, sold_alone, archived, tax_rate_id, image, scope, org_id,
                                   tags, item_code, tax_overrides, created_at, updated_at)
    select r.id, p_location, coalesce(r.name, 'Item'), r.menu_name, r.receipt_name, r.kitchen_name, coalesce(r.description, ''), coalesce(r.type, 'simple'),
           r.cat, coalesce(r.cats, '{}'), r.parent_id, coalesce(r.sort_order, 0), coalesce(r.pricing, '{"base": 0}'::jsonb), coalesce(r.allergens, '{}'),
           coalesce(r.assigned_modifier_groups, '[]'::jsonb), coalesce(r.visibility, '{"pos": true, "kiosk": true, "online": true}'::jsonb),
           coalesce(r.sold_alone, false), coalesce(r.archived, false), r.tax_rate_id, r.image, 'local', v.org_id, coalesce(r.tags, '[]'::jsonb),
           r.item_code, coalesce(r.tax_overrides, '{}'::jsonb), v_now, v_now
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
    -- site has stays exactly as it is: design review blocker 2). Rates of THIS site only.
    if jsonb_typeof(u -> 'tax_overrides') = 'object' and (
         (u #> '{tax_overrides,set}' is not null and (jsonb_typeof(u #> '{tax_overrides,set}') <> 'object'
            or exists (select 1 from jsonb_each(u #> '{tax_overrides,set}') e
                        where e.key <> all (v_tax_keys) or jsonb_typeof(e.value) <> 'string'
                           or not exists (select 1 from public.tax_rates r where r.id::text = e.value #>> '{}' and r.location_id::text = p_location))))
      or (u #> '{tax_overrides,remove}' is not null and (jsonb_typeof(u #> '{tax_overrides,remove}') <> 'array'
            or exists (select 1 from jsonb_array_elements_text(u #> '{tax_overrides,remove}') k where k <> all (v_tax_keys))))) then
      raise exception 'VAT by order type for a product is not a rate at this site. Nothing was written.';
    end if;
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
        if v_prof_old is null or v_product is null
           or not (public.msm__is_legacy_mirror(v_prof_old::uuid, nullif(v_rate_after, '')::uuid)
                   or public.msm__is_legacy_mirror(v_prof_old::uuid, nullif(v_old ->> 'tax_rate_id', '')::uuid)) then
          raise exception 'Publish may only clear an old copy of a product''s own VAT rate. Nothing was written.';
        end if;
        update public.msm_product_sites set cleared_tax_profile_id = v_prof_old::uuid, updated_at = v_now
         where product_id = v_product and location_id = p_location;
      else
        if v_prof_old is not null or v_cleared is null or v_cleared::text <> v_prof_new
           or not exists (select 1 from public.tax_profiles t where t.id::text = v_prof_new and t.location_id::text = p_location)
           or not public.msm__is_legacy_mirror(v_prof_new::uuid, nullif(v_rate_after, '')::uuid) then
          raise exception 'Publish may only put back the old VAT profile copy it cleared. Nothing was written.';
        end if;
        update public.msm_product_sites set cleared_tax_profile_id = null, updated_at = v_now
         where product_id = v_product and location_id = p_location;
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
$fn$;

-- ============================================================================
-- 8. READS FOR THE SCREENS AND THE SHARING ENGINE
-- ============================================================================

-- The option groups the group menu manages at a venue, for the Menu Manager lock: the venue group
-- id, the central group, what the site keeps, and the venue option ids the group menu owns there.
-- A group or option REMOVED from the group menu is not listed (it is the site's again). Only while
-- the company is switched on. Anyone who uses that venue.
create or replace function public.msm_managed_groups(p_location text)
returns table (venue_group_id text, group_id uuid, kept text[], option_ids text[])
language sql
stable
security definer
set search_path = ''
as $fn$
  select gs.venue_group_id, gs.group_id, array(select jsonb_object_keys(gs.kept) order by 1),
         array(select os.venue_option_id
                 from public.msm_modifier_option_sites os
                 join public.msm_modifier_options o on o.id = os.option_id and not o.archived
                where o.group_id = gs.group_id and os.location_id = gs.location_id and os.venue_option_id is not null
                order by 1)
    from public.msm_modifier_group_sites gs
    join public.msm_modifier_groups g on g.id = gs.group_id and not g.archived
    join public.msm_menus m on m.id = g.menu_id and m.status = 'live'
    join public.msm_company c on c.org_id = m.org_id and c.enabled
   where gs.location_id = p_location
     and (p_location in (select public.accessible_location_ids()) or public.is_super_admin());
$fn$;

-- The sharing engine's target side gate (design review blocker 1): at these venues, which option
-- groups and which products the group menu manages, read afresh before any copy is written there.
-- {"on": true|false, "groups": [{location_id, venue_group_id}], "items": [{location_id, venue_item_id}]}
-- Only the venues the caller uses; "on" says whether any of their companies is switched on.
create or replace function public.msm_managed_at(p_locations text[])
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  with locs as (
    select distinct x as loc from unnest(coalesce(p_locations, '{}'::text[])) x
     where x in (select public.accessible_location_ids()) or public.is_super_admin()
  )
  select jsonb_build_object(
    'on', exists (select 1 from locs join public.locations l on l.id::text = locs.loc
                    join public.msm_company c on c.org_id = l.org_id and c.enabled
                    join public.msm_menus m on m.org_id = l.org_id and m.status = 'live'),
    'groups', coalesce((select jsonb_agg(jsonb_build_object('location_id', gs.location_id, 'venue_group_id', gs.venue_group_id))
                          from public.msm_modifier_group_sites gs
                          join public.msm_modifier_groups g on g.id = gs.group_id and not g.archived
                          join public.msm_menus m on m.id = g.menu_id and m.status = 'live'
                          join public.msm_company c on c.org_id = m.org_id and c.enabled
                         where gs.location_id in (select loc from locs)), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('location_id', ps.location_id, 'venue_item_id', ps.venue_item_id))
                         from public.msm_product_sites ps
                         join public.msm_products p on p.id = ps.product_id
                         join public.msm_menus m on m.id = p.menu_id and m.status = 'live'
                         join public.msm_company c on c.org_id = m.org_id and c.enabled
                        where ps.location_id in (select loc from locs)), '[]'::jsonb));
$fn$;

-- How many of each venue product sold at each site of the group menu in the last p_days days
-- (closed checks, voids left out), for the "removing something that sells" tick. Members only.
create or replace function public.msm_sold_recently(p_menu uuid, p_days integer default 7, p_item_ids text[] default null)
returns table (location_id text, venue_item_id text, sold numeric)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
#variable_conflict use_column
declare
  v_org uuid;
begin
  select m.org_id into v_org from public.msm_menus m where m.id = p_menu;
  if v_org is null or not coalesce(public.msm_can_view(v_org), false) then
    raise exception 'You cannot see this group menu.' using errcode = '42501';
  end if;
  -- Sales are behind the second sign in step too, as every other read of the group menu is
  -- (17 Oct verification).
  if not public.msm__second_step_ok() then
    raise exception 'Your sign in needs its second step before you can see this.' using errcode = '42501';
  end if;
  return query
  select cc.location_id, li ->> 'itemId',
         sum(case when li ->> 'qty' ~ '^[0-9]+(\.[0-9]+)?$' then (li ->> 'qty')::numeric else 1 end)
    from public.closed_checks cc
   cross join lateral jsonb_array_elements(case when jsonb_typeof(cc.items) = 'array' then cc.items else '[]'::jsonb end) li
   where cc.location_id in (select s.location_id from public.msm_menu_sites s where s.menu_id = p_menu)
     and cc.closed_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 7), 31)))
     and coalesce(cc.voided, false) = false
     and li ->> 'itemId' is not null
     and (p_item_ids is null or li ->> 'itemId' = any (p_item_ids))
   group by 1, 2;
end
$fn$;

-- Which sites of the group menu are trading now (a sale closed in the last 30 minutes, or an open
-- order from the last 12 hours), with their local time. Members only.
create or replace function public.msm_sites_trading(p_menu uuid)
returns table (location_id text, trading boolean, local_time timestamp, timezone text)
language plpgsql
stable
security definer
set search_path = ''
as $fn$
#variable_conflict use_column
declare
  v_org uuid;
begin
  select m.org_id into v_org from public.msm_menus m where m.id = p_menu;
  if v_org is null or not coalesce(public.msm_can_view(v_org), false) then
    raise exception 'You cannot see this group menu.' using errcode = '42501';
  end if;
  if not public.msm__second_step_ok() then
    raise exception 'Your sign in needs its second step before you can see this.' using errcode = '42501';
  end if;
  return query
  select s.location_id,
         exists (select 1 from public.closed_checks cc where cc.location_id = s.location_id and cc.closed_at >= now() - interval '30 minutes')
         or exists (select 1 from public.order_queue q where q.location_id = s.location_id and q.status in ('received', 'prep', 'ready')
                      and q.created_at >= now() - interval '12 hours'),
         (now() at time zone coalesce(nullif(l.timezone, ''), 'Europe/London')),
         coalesce(nullif(l.timezone, ''), 'Europe/London')
    from public.msm_menu_sites s
    left join public.locations l on l.id::text = s.location_id
   where s.menu_id = p_menu
   order by s.location_id;
end
$fn$;

-- Which order types the screens show (design 5.1: "Only these show on the product sheet. Hidden ones
-- keep their prices."). A screen setting: it never writes a venue row, so it is saved at once,
-- editors only. The keys are the price keys the tills read (msmModel.ORDER_TYPES).
create or replace function public.msm_set_order_types(p_menu uuid, p_types text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_org uuid;
  v_bad text;
  v_types text[];
begin
  select m.org_id into v_org from public.msm_menus m where m.id = p_menu and m.status = 'live';
  if v_org is null then
    raise exception 'No such group menu.' using errcode = '22023';
  end if;
  perform public.msm__require_editor(v_org);
  select t into v_bad from unnest(coalesce(p_types, '{}'::text[])) t
   where t <> all (array['dineIn', 'takeaway', 'collection', 'delivery', 'driveThru', 'bar']) limit 1;
  if found then
    raise exception '% is not an order type the tills have.', v_bad using errcode = '22023';
  end if;
  v_types := array(select distinct t from unnest(coalesce(p_types, '{}'::text[])) t order by 1);
  update public.msm_menus set order_types = case when p_types is null then null else v_types end, updated_at = now() where id = p_menu;
  return jsonb_build_object('ok', true, 'order_types', to_jsonb(case when p_types is null then null else v_types end));
end
$fn$;

-- ============================================================================
-- 8b. THE SCHEDULER, CAPPED (17 Oct verification)
--   A site run whose worker died part way (a crash, a time limit) stayed 'running' and was claimed
--   again every 10 minutes for ever, and a later publish at that site waited behind it for ever.
--   After 5 tries it now fails, in words, with Retry. Retry starts the count again, so the first
--   busy moment after a Retry is tried again rather than failing at once. The bodies are round 1's
--   (20261017) with only these lines changed; the ROLLBACK puts round 1's back.
-- ============================================================================

-- Stale running claims that have had 5 tries: failed in words (nothing was written there: a site
-- is written in one transaction, so a worker that died wrote nothing). Never emailed again: the
-- late alarm has already gone out for it.
create or replace function public.msm__fail_stuck()
returns integer
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  r record;
  n integer := 0;
begin
  for r in
    update public.msm_version_sites s
       set status = 'failed', finished_at = now(), claimed_at = null,
           error = 'The publish stopped part way at this site 5 times. Nothing was changed there. Press Retry.'
     where s.status = 'running' and s.claimed_at < now() - interval '10 minutes' and s.attempts >= 5
    returning s.version_id
  loop
    perform public.msm__refresh_version(r.version_id);
    n := n + 1;
  end loop;
  return n;
end
$fn$;

create or replace function public.msm_claim_due(p_limit integer default 1)
returns table (version_id uuid, location_id text, attempts integer)
language plpgsql
security definer
set search_path = ''
as $fn$
#variable_conflict use_column
begin
  perform public.msm__fail_stuck();
  return query
  with c as (
    select vs.version_id, vs.location_id
      from public.msm_version_sites vs
      join public.msm_versions v on v.id = vs.version_id
      join public.msm_company co on co.org_id = v.org_id and co.enabled
     where ((vs.status = 'scheduled' and vs.due_at <= now()
             -- A SCHEDULED run more than 6 hours past its time is never started by itself (a company
             -- switched back on weeks later, a function that was down): msm_mark_missed fails it in
             -- words and a person presses Retry if they still want it.
             and (v.kind <> 'scheduled' or vs.due_at > now() - interval '6 hours'))
         -- A stale claim is taken again only while it has had fewer than 5 tries (17 Oct).
         or (vs.status = 'running' and vs.claimed_at < now() - interval '10 minutes' and vs.attempts < 5))
       and not exists (select 1 from public.msm_version_sites e
                         join public.msm_versions ev on ev.id = e.version_id
                        where e.location_id = vs.location_id and e.version_id <> vs.version_id
                          and e.status in ('scheduled', 'running') and ev.menu_id = v.menu_id
                          and (e.due_at < vs.due_at or (e.due_at = vs.due_at and ev.created_at < v.created_at)))
     order by vs.due_at, v.created_at
     limit greatest(1, least(coalesce(p_limit, 1), 20))
     for update of vs skip locked
  ), u as (
    update public.msm_version_sites s
       set status = 'running', claimed_at = now(), attempts = s.attempts + 1, started_at = coalesce(s.started_at, now())
      from c
     where s.version_id = c.version_id and s.location_id = c.location_id
    returning s.version_id, s.location_id, s.attempts
  )
  select u.version_id, u.location_id, u.attempts from u;
end
$fn$;

create or replace function public.msm_mark_missed()
returns table (version_id uuid, location_id text, due_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $fn$
#variable_conflict use_column
declare
  r record;
begin
  -- Stuck runs first (they are not "missed its time": failed in their own words, not returned).
  perform public.msm__fail_stuck();
  for r in
    update public.msm_version_sites s
       set status = 'failed', finished_at = now(), claimed_at = null,
           error = 'Missed its time (it was due ' || to_char(s.due_at at time zone coalesce((select nullif(l.timezone, '') from public.locations l where l.id::text = s.location_id), 'Europe/London'), 'DD Mon YYYY HH24:MI')
                   || '). Nothing was changed. Press Retry to publish it now.'
      from public.msm_versions v, public.msm_company co
     where v.id = s.version_id and co.org_id = v.org_id and co.enabled and v.kind = 'scheduled'
       and s.status = 'scheduled' and s.due_at <= now() - interval '6 hours'
    returning s.version_id, s.location_id, s.due_at
  loop
    perform public.msm__refresh_version(r.version_id);
    version_id := r.version_id; location_id := r.location_id; due_at := r.due_at;
    return next;
  end loop;
end
$fn$;

create or replace function public.msm_run_due()
returns bigint
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  k text;
  req bigint;
begin
  -- A stuck run is failed here too, every minute, so nothing waits behind it for ever.
  perform public.msm__fail_stuck();
  if not exists (
    select 1
      from public.msm_version_sites vs
      join public.msm_versions v on v.id = vs.version_id
      join public.msm_company c on c.org_id = v.org_id and c.enabled
     where vs.status in ('scheduled', 'running')
       and ((vs.status = 'scheduled' and vs.due_at <= now())
         or (vs.status = 'running' and vs.claimed_at < now() - interval '10 minutes' and vs.attempts < 5)
         or (vs.status = 'scheduled' and vs.precheck_at is null and vs.due_at <= now() + interval '60 minutes')
         or (vs.late_at is null and vs.due_at < now() - interval '15 minutes'))) then
    return null;
  end if;
  select s.decrypted_secret into k from vault.decrypted_secrets s where s.name = 'msm_cron_key' limit 1;
  if k is null or length(k) < 32 then
    raise exception 'msm_run_due: no msm_cron_key in the vault (run 20261017 again)';
  end if;
  select net.http_post(
    url := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/msm-publish',
    body := '{"action": "run_due"}'::jsonb,
    params := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', k),
    timeout_milliseconds := 25000
  ) into req;
  return req;
end
$fn$;

create or replace function public.msm_retry_site(p_version uuid, p_location text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_org uuid;
  v_status text;
begin
  select v.org_id into v_org from public.msm_versions v where v.id = p_version;
  if v_org is null then
    raise exception 'No such publish.' using errcode = '22023';
  end if;
  perform public.msm__require_editor(v_org);
  select vs.status into v_status from public.msm_version_sites vs where vs.version_id = p_version and vs.location_id = p_location for update;
  if not found then
    raise exception 'That site is not in this publish.' using errcode = '22023';
  end if;
  if v_status <> 'failed' then
    raise exception 'Only a site that failed can be retried (this one is %).', v_status using errcode = '22023';
  end if;
  -- attempts starts again: a Retry gets its own 5 tries (17 Oct verification).
  update public.msm_version_sites
     set status = 'scheduled', due_at = now(), claimed_at = null, attempts = 0, error = null, finished_at = null,
         precheck_at = null, precheck_ok = null, precheck_words = null, late_at = null, notified = '{}'::jsonb
   where version_id = p_version and location_id = p_location;
  perform public.msm__refresh_version(p_version);
  return jsonb_build_object('ok', true, 'status', 'scheduled');
end
$fn$;

-- ============================================================================
-- 9. GRANTS ON FUNCTIONS (by oid: every function this file makes or replaces is closed to everyone
--    first, then opened to exactly who needs it; anon gets none)
-- ============================================================================

do $grants$
declare
  f   text;
  p   regprocedure;
begin
  foreach f in array array[
    'public.msm_site_org_guard()', 'public.msm_option_menu_guard()', 'public.msm__ref_ok(uuid,uuid,text,uuid)',
    'public.msm__group_ids(jsonb)', 'public.msm_changes_guard()', 'public.msm__sites_reached(uuid)', 'public.msm_sql_contract()',
    'public.msm__is_legacy_mirror(uuid,uuid)', 'public.msm__managed_group(uuid,text,text,text[])', 'public.msm_start_version(uuid)',
    'public.msm_import_commit(jsonb)', 'public.msm__import_options(uuid,jsonb)', 'public.msm_import_groups(uuid,jsonb)',
    'public.msm_apply_site(uuid,text,jsonb,jsonb,text,jsonb,text,text,uuid)', 'public.msm_managed_groups(text)',
    'public.msm_managed_at(text[])', 'public.msm_sold_recently(uuid,integer,text[])', 'public.msm_sites_trading(uuid)',
    'public.msm_set_order_types(uuid,text[])', 'public.msm__fail_stuck()', 'public.msm_claim_due(integer)',
    'public.msm_mark_missed()', 'public.msm_run_due()', 'public.msm_retry_site(uuid,text)'] loop
    p := to_regprocedure(f);
    if p is null then raise exception 'Missing function %', f; end if;
    execute format('revoke all on function %s from public, anon, authenticated, service_role', p);
  end loop;
  -- signed in people (each checks who is asking itself)
  foreach f in array array[
    'public.msm_import_commit(jsonb)', 'public.msm_import_groups(uuid,jsonb)', 'public.msm_managed_groups(text)',
    'public.msm_managed_at(text[])', 'public.msm_sold_recently(uuid,integer,text[])', 'public.msm_sites_trading(uuid)',
    'public.msm_sql_contract()', 'public.msm_set_order_types(uuid,text[])', 'public.msm_retry_site(uuid,text)'] loop
    execute format('grant execute on function %s to authenticated', to_regprocedure(f));
  end loop;
  -- the msm-publish function (msm__fail_stuck and msm_run_due: nobody, they run inside the
  -- database's own functions and the job)
  foreach f in array array[
    'public.msm_start_version(uuid)', 'public.msm_apply_site(uuid,text,jsonb,jsonb,text,jsonb,text,text,uuid)', 'public.msm_sql_contract()',
    'public.msm_claim_due(integer)', 'public.msm_mark_missed()'] loop
    execute format('grant execute on function %s to service_role', to_regprocedure(f));
  end loop;
end
$grants$;

comment on function public.msm_apply_site(uuid,text,jsonb,jsonb,text,jsonb,text,text,uuid) is
  'Multi site menu (17 Oct 2026, round 2): writes ONE venue''s menu rows in place (option groups option by option) and its config push in one transaction. Service role only (msm-publish). Idempotent; locks every named row, then refuses a venue saved in between (fingerprint); refuses keys it does not know.';
comment on function public.msm_managed_at(text[]) is
  'Multi site menu round 2: the sharing engine''s target side gate. Which option groups and products the group menu manages at these venues.';

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   new_tables 2, rls_on 2, fenced 2 (or 0 on a database without the second step), anon_table_rights 0,
--   targets 9, contract 2, anon_function_rights 0, new_functions 20, follow_block_gone true,
--   menus_waiting_for_refresh N (the menus imported before this file: 1 on 17 Oct, the demo company),
--   companies_switched_on N (unchanged by this file), icon_ok true, stuck_capped true,
--   retry_resets true
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname in ('msm_modifier_options', 'msm_modifier_option_sites')) as new_tables,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname in ('msm_modifier_options', 'msm_modifier_option_sites') and c.relrowsecurity) as rls_on,
  (select count(distinct p.polrelid) from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname in ('msm_modifier_options', 'msm_modifier_option_sites') and p.polname = 'second_step_fence') as fenced,
  (select count(*) from information_schema.role_table_grants g
    where g.table_schema = 'public' and g.table_name like 'msm\_%' and g.grantee in ('anon', 'PUBLIC')) as anon_table_rights,
  (select count(*) from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''[a-z_]+''', 'g') m
    where c.conname = 'msm_changes_target_ok') as targets,
  public.msm_sql_contract() as contract,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'msm%' and has_function_privilege('anon', p.oid, 'execute')) as anon_function_rights,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('msm_option_menu_guard', 'msm__group_ids', 'msm_sql_contract', 'msm__is_legacy_mirror',
      'msm__managed_group', 'msm__import_options', 'msm_import_groups', 'msm_managed_groups', 'msm_managed_at', 'msm_sold_recently',
      'msm_sites_trading', 'msm_site_org_guard', 'msm__ref_ok', 'msm_changes_guard', 'msm__sites_reached', 'msm_start_version',
      'msm_import_commit', 'msm_apply_site', 'msm_set_order_types', 'msm__fail_stuck')) as new_functions,
  (position('follow their sub item (review blocker 2) ---' in pg_get_functiondef('public.msm_apply_site(uuid,text,jsonb,jsonb,text,jsonb,text,text,uuid)'::regprocedure)) = 0) as follow_block_gone,
  (select count(*) from public.msm_menus m where m.status = 'live' and m.refreshed_at is null) as menus_waiting_for_refresh,
  (select count(*) from public.msm_company where enabled) as companies_switched_on,
  (position('coalesce(r.icon, chr(127869))' in pg_get_functiondef('public.msm_apply_site(uuid,text,jsonb,jsonb,text,jsonb,text,text,uuid)'::regprocedure)) > 0) as icon_ok,
  (position('vs.attempts < 5' in pg_get_functiondef('public.msm_claim_due(integer)'::regprocedure)) > 0) as stuck_capped,
  (position('attempts = 0' in pg_get_functiondef('public.msm_retry_site(uuid,text)'::regprocedure)) > 0) as retry_resets;
