-- 20261128a_OPS_admin_wipe_fences.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Needs 20261125a_OPS_admin_wipe.sql first. Changes no data by itself.     #
-- ############################################################################
--
-- WHY (Peter, 6 Nov 2026)
--   "still cant delete organisations. Error when removing a site: The Ops database refused
--   that: Set by head office. Change it in Inventory > Stock items."
--   The wipe (20261125a) deletes every row of a venue through the tables' own fence triggers.
--   Five of those refuse a delete whatever the caller, and the wipe runs as the service role,
--   which the stock fences (stock_co__site_lock, 20261022a) treat like any signed in session.
--   The first refused row rolls the whole wipe back, so the screen shows the fence's words
--   and nothing is deleted. A dry run never hits them (it only counts), so the preview said
--   the venue could go.
--
-- WHAT THIS FILE DOES
--   public.admin_wipe__active()  true inside a wipe: this transaction armed itself and runs
--                                as postgres (the wipe functions are security definer).
--   public.admin_wipe__arm()     sets that mark for the transaction, plus the stock writer
--                                pass (servos.stock_co_write = this txid) that the stock
--                                fences already honour.
--   admin_wipe_locations and admin_wipe_organisation arm the transaction first thing.
--   Four fence functions let an armed wipe through, one line each, the rest of their text
--   is exactly what production holds today (read back with pg_get_functiondef):
--     _chat_log_append_only            chat_moderation_log is append only
--     msm_change_sets_guard            Only a draft can be thrown away
--     msm_changes_guard                This set is %, so its changes cannot be removed
--     wf_block_finalized_tronc_delete  a % run is immutable and cannot be deleted
--   Fences that already pass the service role (invoice lock, approved counts) or raise
--   foreign_key_violation (keep history, pack in use, retried by the engine) are not touched.
--
-- WHO MAY CALL
--   admin_wipe__arm is revoked from public, anon, authenticated and service_role: only the two
--   wipe functions (service role only) call it. admin_wipe__active may be asked by any role
--   (the fences ask it, and some fences run as the caller), and it answers true only inside
--   an armed wipe running as postgres. A session cannot arm itself: set_config of the mark in
--   a PostgREST session does nothing, because that session runs as authenticated, anon or
--   service_role, never postgres (proved on a local Postgres 17, 7 Nov 2026).
--
-- Rollback: 20261128a_OPS_admin_wipe_fences_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.organisations') is null or to_regclass('public.user_profiles') is null then
    raise exception 'This is not the Ops database (organisations or user_profiles is missing). Nothing was changed.';
  end if;
  if to_regprocedure('public.admin_wipe_tables(text[], text[], text[], jsonb, boolean)') is null then
    raise exception 'Run 20261125a_OPS_admin_wipe.sql first. Nothing was changed.';
  end if;
end
$guard$;

-- ===== The mark =====
create or replace function public.admin_wipe__active()
returns boolean
language sql
volatile
set search_path = pg_catalog, public
as $fn$
  select coalesce(current_setting('servos.admin_wipe', true), '') = txid_current()::text
     and current_user = 'postgres';
$fn$;

create or replace function public.admin_wipe__arm()
returns void
language plpgsql
volatile
set search_path = pg_catalog, public
as $fn$
begin
  perform set_config('servos.admin_wipe', txid_current()::text, true);
  perform set_config('servos.stock_co_write', txid_current()::text, true);
end
$fn$;

-- active() is asked by the fences, and some fences run as the caller (not security definer),
-- so every role may ask it. It answers true only inside an armed wipe running as postgres.
grant execute on function public.admin_wipe__active() to public;
-- arm() is the wipe functions' own: nobody else may call it.
revoke all on function public.admin_wipe__arm() from public, anon, authenticated, service_role;

-- ===== The wipe functions arm the transaction =====
CREATE OR REPLACE FUNCTION public.admin_wipe_locations(p_location_ids uuid[], p_dry_run boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  found int;
  report jsonb;
  profiles bigint := 0;
begin
  perform public.admin_wipe__arm();   -- 20261128a: the fences let this transaction through
  if p_location_ids is null or array_length(p_location_ids, 1) is null then
    raise exception 'No location given.';
  end if;
  select count(*) into found from public.locations where id = any(p_location_ids);
  if found <> array_length(p_location_ids, 1) then
    raise exception 'Location not found (% of % given exist).', found, array_length(p_location_ids, 1);
  end if;

  -- A login's profile is the person's, not the venue's: only its home venue pointer goes.
  if p_dry_run then
    select count(*) into profiles from public.user_profiles where location_id = any(p_location_ids);
  else
    update public.user_profiles set location_id = null where location_id = any(p_location_ids);
    get diagnostics profiles = row_count;
  end if;

  report := public.admin_wipe_tables(
    p_location_ids::text[],
    array['location_id', 'local_location_id', 'internal_location_id', 'kitchen_location_id'],
    array['locations', 'user_profiles'],
    jsonb_build_object('locations', 'id::text = any($1)'),
    p_dry_run
  );
  return report || jsonb_build_object('locations', array_length(p_location_ids, 1), 'profiles_unlinked', profiles);
end
$function$
;

CREATE OR REPLACE FUNCTION public.admin_wipe_organisation(p_org_id uuid, p_org_name text, p_dry_run boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  org record;
  loc_ids uuid[];
  login_ids uuid[];
  venues jsonb := '{}'::jsonb;
  people jsonb := '{}'::jsonb;
  company jsonb := '{}'::jsonb;
  staff_unlinked bigint := 0;
begin
  perform public.admin_wipe__arm();   -- 20261128a: the fences let this transaction through
  select id, name into org from public.organisations where id = p_org_id;
  if org.id is null then
    raise exception 'Organisation not found.';
  end if;
  if lower(trim(coalesce(p_org_name, ''))) <> lower(trim(coalesce(org.name, ''))) then
    raise exception 'The name typed does not match the organisation name.'
      using errcode = 'check_violation';
  end if;

  select coalesce(array_agg(id), '{}') into loc_ids from public.locations where org_id = p_org_id;

  -- 1. The venues.
  if array_length(loc_ids, 1) is not null then
    venues := public.admin_wipe_locations(loc_ids, p_dry_run);
  end if;

  -- 2. The people: every profile of this company that is not ServOS staff, with whatever
  --    points at those profiles. Their sign ins (auth.users) are the edge function's job.
  select coalesce(array_agg(id), '{}') into login_ids
  from public.user_profiles
  where org_id = p_org_id and coalesce(role, '') <> 'super_admin';
  if array_length(login_ids, 1) is not null then
    people := public.admin_wipe_tables(
      login_ids::text[],
      '{}'::text[],
      '{}'::text[],
      jsonb_build_object('user_profiles', 'id::text = any($1)'),
      p_dry_run
    );
  end if;

  -- 3. Everything keyed by org_id, then the organisations row. A ServOS super admin whose
  --    profile sits on this company keeps the profile and loses the company pointer.
  if p_dry_run then
    select count(*) into staff_unlinked from public.user_profiles where org_id = p_org_id and role = 'super_admin';
  else
    update public.user_profiles set org_id = null, location_id = null where org_id = p_org_id and role = 'super_admin';
    get diagnostics staff_unlinked = row_count;
  end if;
  --    locations is skipped here: the venues step owns it (and a dry run would count its
  --    children twice).
  company := public.admin_wipe_tables(
    array[p_org_id::text],
    array['org_id'],
    array['organisations', 'user_profiles', 'locations'],
    jsonb_build_object('organisations', 'id::text = any($1)'),
    p_dry_run
  );

  return jsonb_build_object(
    'dry_run', p_dry_run,
    'organisation', org.name,
    'locations', coalesce(array_length(loc_ids, 1), 0),
    'logins', coalesce(array_length(login_ids, 1), 0),
    'login_ids', to_jsonb(login_ids),
    'staff_unlinked', staff_unlinked,
    'venues', venues,
    'people', people,
    'company', company,
    'total', coalesce((venues ->> 'total')::bigint, 0) + coalesce((people ->> 'total')::bigint, 0) + coalesce((company ->> 'total')::bigint, 0)
  );
end
$function$
;

-- ===== The fences let an armed wipe through =====
CREATE OR REPLACE FUNCTION public._chat_log_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if public.admin_wipe__active() then
    return case when tg_op = 'DELETE' then old else new end;   -- a wipe by Company Admin (20261128a)
  end if;
  if tg_op = 'DELETE' and old.at < now() - interval '6 years' then return old; end if;
  raise exception using errcode = '42501', message = 'chat_moderation_log is append only';
end
$function$
;

CREATE OR REPLACE FUNCTION public.msm_change_sets_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_fn boolean := coalesce(current_setting('servos.msm_write', true), '') = 'on';
begin
  if public.admin_wipe__active() then
    return case when tg_op = 'DELETE' then old else new end;   -- a wipe by Company Admin (20261128a)
  end if;
  if tg_op = 'DELETE' then
    if old.status <> 'draft' and not v_fn then
      raise exception 'Only a draft can be thrown away. Cancel or unschedule it first.' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    select m.org_id into new.org_id from public.msm_menus m where m.id = new.menu_id and m.status = 'live';
    if new.org_id is null then
      raise exception 'No such group menu.' using errcode = '42501';
    end if;
    if not v_fn then
      if new.status <> 'draft' or new.version_id is not null or new.scheduled_at is not null or new.scheduled_by is not null or new.run_local is not null then
        raise exception 'A new set of changes starts as a draft.' using errcode = '42501';
      end if;
      new.created_by := auth.uid();
    end if;
    new.created_at := now();
    new.updated_at := now();
    return new;
  end if;
  -- UPDATE
  if new.menu_id is distinct from old.menu_id or new.org_id is distinct from old.org_id or new.id is distinct from old.id then
    raise exception 'A set of changes cannot move to another menu.' using errcode = '42501';
  end if;
  if not v_fn then
    if old.status <> 'draft' then
      raise exception 'This set is %, so it cannot be changed. Unschedule it to edit it again.', old.status using errcode = '42501';
    end if;
    if new.status is distinct from old.status or new.version_id is distinct from old.version_id
       or new.scheduled_at is distinct from old.scheduled_at or new.scheduled_by is distinct from old.scheduled_by
       or new.run_local is distinct from old.run_local or new.created_by is distinct from old.created_by
       or new.kind is distinct from old.kind or new.undo_of_version is distinct from old.undo_of_version then
      raise exception 'Use Publish, Schedule or Cancel to do that.' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  return new;
end
$function$
;

CREATE OR REPLACE FUNCTION public.msm_changes_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_set      record;
  v_allowed  text[];
  v_bad      text;
  v_ref      uuid;
  v_kept     constant text[] := array['cat', 'cats', 'image', 'name', 'menu_name', 'receipt_name', 'kitchen_name', 'description', 'tax_rate_id', 'allergens', 'tags', 'visibility', 'sold_alone', 'item_code', 'assigned_modifier_groups', 'type', 'parent_id', 'tax_overrides', 'no_price'];
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
  if public.admin_wipe__active() then
    return case when tg_op = 'DELETE' then old else new end;   -- a wipe by Company Admin (20261128a)
  end if;
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
      -- 17 Oct recheck: a turn on (or a new product) whose id is already the site's OWN product
      -- would take it over, and Undo would then turn it off. Only Bring it in links a site's own
      -- product, and its change always carries what the site keeps (even none). (A site being added
      -- in this set is checked at publish instead: Add a site says it in words there.)
      if not (new.after ? 'kept')
         and exists (select 1 from public.msm_menu_sites s where s.menu_id = v_set.menu_id and s.location_id = new.location_id)
         and exists (select 1 from public.menu_items i where i.id = v_vid and i.location_id = new.location_id) then
        raise exception 'This site already sells its own product with this id. To use it, bring it in from the Sites tab and link it to the group''s product. Nothing was changed.' using errcode = '22023';
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
      -- No price (17 Oct recheck): only ever true, never with a price of the site's own.
      if new.after -> 'kept' ? 'no_price' and (new.after #> '{kept,no_price}' <> 'true'::jsonb
         or (jsonb_typeof(new.after -> 'price') = 'number')) then
        raise exception 'A site with no price cannot have a price of its own in the same change.' using errcode = '22023';
      end if;
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
$function$
;

CREATE OR REPLACE FUNCTION public.wf_block_finalized_tronc_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  if public.admin_wipe__active() then
    return case when tg_op = 'DELETE' then old else new end;   -- a wipe by Company Admin (20261128a)
  end if;
  if old.status is distinct from 'draft' then
    raise exception 'wf_tronc_runs: a % run is immutable and cannot be deleted (supersede via an audited correction instead)', old.status;
  end if;
  return old;
end; $function$
;

notify pgrst, 'reload schema';

-- VISIBLE CHECK: armed = 2, fences = 4.
select count(*) filter (where p.prosrc like '%admin_wipe__arm()%' and p.proname like 'admin_wipe_%') as armed,
       count(*) filter (where p.prosrc like '%admin_wipe__active()%' and p.proname not like 'admin_wipe%') as fences
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public';
