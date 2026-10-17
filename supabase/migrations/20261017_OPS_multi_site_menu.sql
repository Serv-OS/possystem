-- 20261017_OPS_multi_site_menu.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  ADDITIVE: new msm_ tables and functions only. No existing table, row,    #
-- #  policy or function is changed, so it is safe any time, service too.      #
-- #  Safe to run twice. Nothing to copy or paste: the scheduler's key is made #
-- #  here, inside the database vault, and nobody ever sees it.                #
-- ############################################################################
--
-- WHY (Peter, 17 Oct 2026)
--   "build a multi site menu builder where if you want to manage a menu centrally you can: a list
--   of products, their categories, if it is active at each location, what the price is at each
--   location. I only want people to be able to access it if we add them from the admin area."
--   And: "not just schedule price increase but schedule menu push so we can add items then say
--   these items need to be on the POS by X date and time".
--
-- THE MODEL
--   A company owned CENTRAL MENU (the msm_ tables) sits ON TOP of the venue rows every surface
--   already reads (menus, menu_categories, menu_items, menu_category_links, modifier_groups).
--   Edits are staged in CHANGE SETS (msm_change_sets, msm_changes). PUBLISH, now or at a time on
--   each site's own clock, runs on the SERVER: the msm-publish edge function plans each venue
--   (supabase/functions/_shared/msmPlan.js) and public.msm_apply_site writes that venue's rows IN
--   PLACE by their existing ids and inserts that venue's config push (the same till refresh as
--   Push to POS), in ONE transaction per venue. Every till, kiosk, online page, QR page, menu
--   board, HubRise and ezCater link and the Smart Quick Screen keep reading what they read today.
--
-- NOTHING CHANGES FOR ANY VENUE UNTIL
--   1. ServOS switches the company on in Company Admin (public.msm_admin_set_enabled), AND
--   2. a person ServOS added by name (public.msm_admin_set_member) publishes.
--   Owners and ServOS staff do NOT get in automatically. Importing a company's menus into the
--   central menu writes nothing at any venue.
--
-- WHAT THIS FILE ADDS
--   Tables (row level security on, every one; location_id is text NOT NULL with NO default):
--     msm_company, msm_members                      the switch and the named logins
--     msm_menus, msm_menu_sites                     the central menu and the sites it covers
--     msm_categories, msm_category_sites            categories and each site's category id
--     msm_modifier_groups, msm_modifier_group_sites modifier groups and each site's group id
--     msm_products, msm_product_sites               products; per site: active, price, kept
--     msm_site_groups                               saved groups of sites ("City sites")
--     msm_change_sets, msm_changes                  staged edits (several named drafts)
--     msm_versions, msm_version_sites               every publish: history, audit, schedule
--   Guards (triggers, they run for every writer, SECURITY DEFINER functions included):
--     msm_site_org_guard     a site row's venue must belong to the menu's company
--     msm_changes_guard      a change lands only in a DRAFT set, only allowlisted fields, only for
--                            this menu's own rows and this company's venues
--     msm_change_sets_guard  a set's status moves only through the functions below
--     msm_site_groups_guard  a saved group holds only this company's venues
--   Functions a signed in member calls (each checks who is asking itself):
--     msm_my_access, msm_import_commit, msm_publish_now, msm_schedule_set, msm_unschedule_set,
--     msm_cancel_set, msm_retry_site, msm_managed_items
--   Functions only ServOS (super admin, with the second sign in step) calls:
--     msm_admin_status, msm_admin_set_enabled, msm_admin_set_member
--   Functions only the msm-publish function (service role) calls:
--     msm_cron_ok, msm_claim_due, msm_start_version, msm_venue_fingerprint, msm_apply_site,
--     msm_fail_site, msm_precheck_due, msm_precheck_result, msm_mark_late, msm_note_notified
--   The scheduler: vault secret msm_cron_key (made here), public.msm_run_due() (posts to
--   msm-publish only when something is due), pg_cron job msm-run-due every minute.
--
-- ORDER FOR PETER
--   1. Merge v5.11.75. The Multi site menu stays hidden everywhere ("not installed").
--   2. Run this file on Ops. Read the check row at the bottom. Still nothing changes (no company on).
--   3. Deploy msm-publish:  npx supabase functions deploy msm-publish --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
--      (it checks the person's sign in, or the scheduler's key, itself).
--   4. Company Admin: switch the company on and add the named people.
--   5. Import. Version 1 says 0 changes at 0 sites.
--   6. First real publish in a quiet hour, one small change, watched.
--
-- UNDO: 20261017_OPS_multi_site_menu_ROLLBACK.sql (drops only msm_ objects, the job and the key;
-- venue rows written by a publish stay as they are, as with any menu edit).
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This migration must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it, nothing was changed.';
  end if;
  if to_regprocedure('public.is_super_admin()') is null or to_regprocedure('public.is_anon_session()') is null
     or to_regprocedure('public.accessible_location_ids()') is null then
    raise exception 'The helpers is_super_admin, is_anon_session and accessible_location_ids are missing. Nothing was changed.';
  end if;
  if to_regclass('public.menu_items') is null or to_regclass('public.config_pushes') is null
     or to_regclass('public.activity_events') is null or to_regclass('public.print_routing') is null then
    raise exception 'The menu tables are not all here. Nothing was changed.';
  end if;
  if to_regclass('vault.decrypted_secrets') is null or to_regprocedure('vault.create_secret(text,text,text,uuid)') is null then
    raise exception 'The database vault is not there (vault.create_secret). Nothing was changed.';
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'pg_net is not there (net.http_post). Nothing was changed.';
  end if;
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'pg_cron is not there (cron.schedule). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

-- ============================================================================
-- 1. TABLES
-- ============================================================================

-- The company switch. Not an organisations column: signed in users can update organisations and
-- a company's creator passes its update rule, so an owner could switch a column there on.
create table if not exists public.msm_company (
  org_id      uuid primary key references public.organisations(id) on delete cascade,
  enabled     boolean not null default false,
  enabled_by  uuid,
  enabled_at  timestamptz,
  updated_at  timestamptz not null default now()
);
comment on table public.msm_company is 'Multi site menu (17 Oct 2026): is the company switched on. Written only by public.msm_admin_set_enabled (ServOS).';

create table if not exists public.msm_members (
  org_id    uuid not null references public.organisations(id) on delete cascade,
  user_id   uuid not null,
  role      text not null,
  added_by  uuid,
  added_at  timestamptz not null default now(),
  primary key (org_id, user_id),
  constraint msm_members_role_ok check (role in ('editor', 'viewer'))
);
comment on table public.msm_members is 'Multi site menu: the named logins (editor or viewer). Written only by public.msm_admin_set_member (ServOS). Owners and ServOS staff are not members unless added.';

create table if not exists public.msm_menus (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null references public.organisations(id) on delete cascade,
  name                 text not null,
  description          text not null default '',
  use_name_everywhere  boolean not null default false,
  status               text not null default 'live',
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  last_version_no      integer not null default 0,
  last_published_at    timestamptz,
  last_published_by    text,
  constraint msm_menus_name_ok check (char_length(btrim(name)) between 1 and 80),
  constraint msm_menus_description_ok check (char_length(description) <= 600),
  constraint msm_menus_status_ok check (status in ('live', 'archived'))
);
create unique index if not exists msm_menus_one_live_per_org on public.msm_menus (org_id) where status = 'live';

create table if not exists public.msm_menu_sites (
  menu_id          uuid not null references public.msm_menus(id) on delete cascade,
  location_id      text not null,
  venue_menu_id    text,
  joined_at        timestamptz not null default now(),
  joined_by        uuid,
  last_version_no  integer,
  last_push_id     uuid,
  last_done_at     timestamptz,
  last_error       text,
  primary key (menu_id, location_id)
);
create index if not exists msm_menu_sites_location on public.msm_menu_sites (location_id);

create table if not exists public.msm_site_groups (
  id            uuid primary key default gen_random_uuid(),
  menu_id       uuid not null references public.msm_menus(id) on delete cascade,
  org_id        uuid not null,
  name          text not null,
  location_ids  text[] not null default '{}',
  created_by    uuid default auth.uid(),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint msm_site_groups_name_ok check (char_length(btrim(name)) between 1 and 60),
  constraint msm_site_groups_size_ok check (cardinality(location_ids) <= 200)
);

create table if not exists public.msm_categories (
  id                uuid primary key,
  menu_id           uuid not null references public.msm_menus(id) on delete cascade,
  parent_id         uuid references public.msm_categories(id) on delete restrict,
  label             text not null,
  icon              text,
  color             text,
  accounting_group  text not null default '',
  default_course    integer not null default 1,
  sort_order        integer not null default 0,
  image             text,
  archived          boolean not null default false,
  route_like_id     uuid references public.msm_categories(id) on delete set null,
  updated_at        timestamptz not null default now(),
  constraint msm_categories_label_ok check (char_length(btrim(label)) between 1 and 80)
);
create index if not exists msm_categories_menu on public.msm_categories (menu_id);

create table if not exists public.msm_category_sites (
  category_id        uuid not null references public.msm_categories(id) on delete cascade,
  location_id        text not null,
  venue_category_id  text not null,
  primary key (category_id, location_id),
  constraint msm_category_sites_one_venue_row unique (location_id, venue_category_id)
);

create table if not exists public.msm_modifier_groups (
  id                  uuid primary key,
  menu_id             uuid not null references public.msm_menus(id) on delete cascade,
  name                text not null,
  min                 integer not null default 0,
  max                 integer not null default 1,
  selection_type      text not null default 'single',
  options             jsonb not null default '[]'::jsonb,
  sort_order          integer not null default 0,
  source_location_id  text,
  updated_at          timestamptz not null default now()
);
create index if not exists msm_modifier_groups_menu on public.msm_modifier_groups (menu_id);

create table if not exists public.msm_modifier_group_sites (
  group_id        uuid not null references public.msm_modifier_groups(id) on delete cascade,
  location_id     text not null,
  venue_group_id  text not null,
  primary key (group_id, location_id),
  constraint msm_modifier_group_sites_one_venue_row unique (location_id, venue_group_id)
);

create table if not exists public.msm_products (
  id                     uuid primary key,
  menu_id                uuid not null references public.msm_menus(id) on delete cascade,
  category_id            uuid references public.msm_categories(id) on delete restrict,
  extra_category_ids     uuid[] not null default '{}',
  parent_product_id      uuid references public.msm_products(id) on delete restrict,
  type                   text not null default 'simple',
  name                   text not null,
  menu_name              text,
  receipt_name           text,
  kitchen_name           text,
  description            text not null default '',
  default_price          numeric(10,2) not null default 0,
  default_channels       jsonb,
  tax_rate_name          text,
  tax_rate_percent       numeric(6,3),
  allergens              text[] not null default '{}',
  tags                   jsonb not null default '[]'::jsonb,
  image                  text,
  modifier_groups        jsonb not null default '[]'::jsonb,
  visibility             jsonb,
  sold_alone             boolean not null default false,
  item_code              text,
  site_only_location_id  text,
  archived               boolean not null default false,
  sort_order             integer not null default 0,
  family_base            text,
  updated_at             timestamptz not null default now(),
  constraint msm_products_price_ok check (default_price >= 0),
  constraint msm_products_name_ok check (char_length(btrim(name)) between 1 and 120)
);
create index if not exists msm_products_menu on public.msm_products (menu_id);

create table if not exists public.msm_product_sites (
  product_id      uuid not null references public.msm_products(id) on delete cascade,
  location_id     text not null,
  venue_item_id   text not null,
  active          boolean not null default true,
  price           numeric(10,2),
  channel_prices  jsonb,
  kept            jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now(),
  primary key (product_id, location_id),
  constraint msm_product_sites_one_venue_row unique (location_id, venue_item_id),
  constraint msm_product_sites_price_ok check (price is null or price >= 0)
);

create table if not exists public.msm_change_sets (
  id                uuid primary key default gen_random_uuid(),
  menu_id           uuid not null references public.msm_menus(id) on delete cascade,
  org_id            uuid not null,
  title             text not null,
  kind              text not null default 'edit',
  status            text not null default 'draft',
  run_local         timestamp,
  lead_minutes      integer not null default 5,
  apply_when_idle   boolean not null default true,
  undo_of_version   uuid,
  created_by        uuid default auth.uid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  scheduled_by      uuid,
  scheduled_at      timestamptz,
  version_id        uuid,
  constraint msm_change_sets_title_ok check (char_length(btrim(title)) between 1 and 80),
  constraint msm_change_sets_kind_ok check (kind in ('edit', 'undo', 'add_site', 'price_change', 'csv')),
  constraint msm_change_sets_status_ok check (status in ('draft', 'scheduled', 'running', 'done', 'partly_done', 'failed', 'cancelled')),
  constraint msm_change_sets_lead_ok check (lead_minutes between 0 and 240)
);
create index if not exists msm_change_sets_menu on public.msm_change_sets (menu_id, status);

create table if not exists public.msm_changes (
  id             uuid primary key default gen_random_uuid(),
  change_set_id  uuid not null references public.msm_change_sets(id) on delete cascade,
  menu_id        uuid not null,
  org_id         uuid not null,
  target         text not null,
  entity_id      uuid not null,
  location_id    text,
  op             text not null,
  after          jsonb not null default '{}'::jsonb,
  before         jsonb not null default '{}'::jsonb,
  created_by     uuid default auth.uid(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint msm_changes_target_ok check (target in ('menu', 'menu_site', 'category', 'product', 'product_site')),
  constraint msm_changes_op_ok check (op in ('create', 'update', 'remove')),
  constraint msm_changes_after_object check (jsonb_typeof(after) = 'object'),
  constraint msm_changes_before_object check (jsonb_typeof(before) = 'object')
);
create unique index if not exists msm_changes_one_row on public.msm_changes (change_set_id, target, entity_id, coalesce(location_id, ''));

create table if not exists public.msm_versions (
  id               uuid primary key default gen_random_uuid(),
  menu_id          uuid not null references public.msm_menus(id) on delete cascade,
  org_id           uuid not null,
  version_no       integer,
  kind             text not null,
  change_set_id    uuid references public.msm_change_sets(id) on delete set null,
  title            text,
  status           text not null default 'scheduled',
  apply_when_idle  boolean not null default true,
  created_by       uuid,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  changes          jsonb not null default '[]'::jsonb,
  constraint msm_versions_kind_ok check (kind in ('publish', 'scheduled', 'undo', 'import', 'add_site')),
  constraint msm_versions_status_ok check (status in ('scheduled', 'running', 'done', 'partly_done', 'failed', 'cancelled'))
);
create unique index if not exists msm_versions_no on public.msm_versions (menu_id, version_no) where version_no is not null;
create index if not exists msm_versions_menu on public.msm_versions (menu_id, created_at desc);

create table if not exists public.msm_version_sites (
  version_id      uuid not null references public.msm_versions(id) on delete cascade,
  location_id     text not null,
  org_id          uuid not null,
  status          text not null default 'scheduled',
  due_at          timestamptz not null default now(),
  claimed_at      timestamptz,
  started_at      timestamptz,
  finished_at     timestamptz,
  attempts        integer not null default 0,
  push_id         uuid,
  error           text,
  counts          jsonb,
  writes          jsonb,
  precheck_at     timestamptz,
  precheck_ok     boolean,
  precheck_words  text,
  late_at         timestamptz,
  notified        jsonb not null default '{}'::jsonb,
  primary key (version_id, location_id),
  constraint msm_version_sites_status_ok check (status in ('scheduled', 'running', 'done', 'nothing', 'failed', 'cancelled'))
);
-- The cron check: a cheap index read every minute.
create index if not exists msm_version_sites_due on public.msm_version_sites (status, due_at) where status in ('scheduled', 'running');

-- ============================================================================
-- 2. WHO MAY SEE AND EDIT (SECURITY DEFINER helpers, set forms for row level security)
-- ============================================================================

-- The caller's role in a company: 'editor' or 'viewer' while the company is switched on, else null.
-- Never for an anonymous session (a till or a kiosk).
create or replace function public.msm_role(p_org uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select m.role
    from public.msm_members m
    join public.msm_company c on c.org_id = m.org_id and c.enabled
   where m.org_id = p_org
     and m.user_id = auth.uid()
     and not public.is_anon_session();
$fn$;

create or replace function public.msm_can_view(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select public.msm_role(p_org) is not null or public.is_super_admin();
$fn$;

create or replace function public.msm_can_edit(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(public.msm_role(p_org) = 'editor', false);
$fn$;

-- Set forms, one call per statement (20260927a): the companies and menus the caller may see or edit.
create or replace function public.msm_viewable_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select m.org_id
    from public.msm_members m
    join public.msm_company c on c.org_id = m.org_id and c.enabled
   where m.user_id = auth.uid() and not public.is_anon_session()
  union
  select o.id from public.organisations o where public.is_super_admin();
$fn$;

create or replace function public.msm_editable_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select m.org_id
    from public.msm_members m
    join public.msm_company c on c.org_id = m.org_id and c.enabled
   where m.user_id = auth.uid() and m.role = 'editor' and not public.is_anon_session();
$fn$;

create or replace function public.msm_viewable_menu_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select mm.id from public.msm_menus mm where mm.org_id in (select public.msm_viewable_org_ids());
$fn$;

create or replace function public.msm_member_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $fn$
  select m.org_id from public.msm_members m where m.user_id = auth.uid() and not public.is_anon_session();
$fn$;

-- The second sign in step, asked by name at run time (a database without 20260919s still works).
create or replace function public.msm__second_step_ok()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_ok boolean;
begin
  if to_regprocedure('public.second_step_ok()') is null then
    return true;
  end if;
  execute 'select public.second_step_ok()' into v_ok;
  return coalesce(v_ok, false);
end
$fn$;

-- An editor of this company, signed in for real with the second step. Raises in plain words.
create or replace function public.msm__require_editor(p_org uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  if auth.uid() is null or public.is_anon_session() then
    raise exception 'Sign in to Back Office to use the Multi site menu.' using errcode = '42501';
  end if;
  if not public.msm__second_step_ok() then
    raise exception 'Your sign in needs its second step before you can change the group menu.' using errcode = '42501';
  end if;
  if not coalesce(public.msm_can_edit(p_org), false) then
    raise exception 'Only people ServOS added as an editor can change the group menu.' using errcode = '42501';
  end if;
end
$fn$;

-- ServOS staff with the second step.
create or replace function public.msm__require_servos()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $fn$
begin
  if auth.uid() is null or public.is_anon_session() or not public.is_super_admin() then
    raise exception 'Only ServOS staff can change this.' using errcode = '42501';
  end if;
  if not public.msm__second_step_ok() then
    raise exception 'Your sign in needs its second step first.' using errcode = '42501';
  end if;
end
$fn$;

-- Is this venue in this company? (text id, as the menu tables keep it)
create or replace function public.msm__venue_in_org(p_loc text, p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select exists (select 1 from public.locations l where l.id::text = p_loc and l.org_id = p_org);
$fn$;

-- ============================================================================
-- 3. GUARDS
-- ============================================================================

-- A site row's venue must belong to the menu's company (design review: a guessable location id
-- of another company must never be written by a definer path). Triggers fire for every writer.
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

drop trigger if exists msm_site_org_guard on public.msm_menu_sites;
create trigger msm_site_org_guard before insert or update on public.msm_menu_sites for each row execute function public.msm_site_org_guard();
drop trigger if exists msm_site_org_guard on public.msm_product_sites;
create trigger msm_site_org_guard before insert or update on public.msm_product_sites for each row execute function public.msm_site_org_guard();
drop trigger if exists msm_site_org_guard on public.msm_category_sites;
create trigger msm_site_org_guard before insert or update on public.msm_category_sites for each row execute function public.msm_site_org_guard();
drop trigger if exists msm_site_org_guard on public.msm_modifier_group_sites;
create trigger msm_site_org_guard before insert or update on public.msm_modifier_group_sites for each row execute function public.msm_site_org_guard();
drop trigger if exists msm_site_org_guard on public.msm_version_sites;
create trigger msm_site_org_guard before insert or update on public.msm_version_sites for each row execute function public.msm_site_org_guard();

-- Saved site groups: this company's venues only.
create or replace function public.msm_site_groups_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_bad text;
begin
  select m.org_id into new.org_id from public.msm_menus m where m.id = new.menu_id;
  if new.org_id is null then
    raise exception 'No such group menu.' using errcode = '42501';
  end if;
  select x into v_bad from unnest(new.location_ids) as x where not public.msm__venue_in_org(x, new.org_id) limit 1;
  if found then
    raise exception 'That site is not in this company.' using errcode = '42501';
  end if;
  new.location_ids := array(select distinct x from unnest(new.location_ids) as x order by x);
  new.updated_at := now();
  return new;
end
$fn$;
drop trigger if exists msm_site_groups_guard on public.msm_site_groups;
create trigger msm_site_groups_guard before insert or update on public.msm_site_groups for each row execute function public.msm_site_groups_guard();

-- Change sets: a person makes and names drafts; the status moves only through the functions in
-- section 5 (they say so with the setting servos.msm_write). A set that is not a draft is frozen.
create or replace function public.msm_change_sets_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_fn boolean := coalesce(current_setting('servos.msm_write', true), '') = 'on';
begin
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
$fn$;
drop trigger if exists msm_change_sets_guard on public.msm_change_sets;
create trigger msm_change_sets_guard before insert or update or delete on public.msm_change_sets for each row execute function public.msm_change_sets_guard();

-- Is a central reference (a category, a product) this menu's own, or created in this same set?
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

-- Changes: only into a DRAFT set (whoever writes), only allowlisted fields, only this menu's own
-- rows and this company's venues. The field lists are pinned to supabase/functions/_shared/msmModel.js
-- (STAGE_FIELDS, KEPT_COLUMNS, CHANNELS) by src/lib/msm/msmMigration.test.js.
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
drop trigger if exists msm_changes_guard on public.msm_changes;
create trigger msm_changes_guard before insert or update or delete on public.msm_changes for each row execute function public.msm_changes_guard();

-- ============================================================================
-- 4. ROW LEVEL SECURITY AND GRANTS
-- ============================================================================
-- Default privileges on this project give anon and authenticated rights on every NEW table and
-- function, and "revoke from public" does not remove those, so every one is revoked BY NAME first.

do $rls$
declare
  t text;
begin
  foreach t in array array['msm_company', 'msm_members', 'msm_menus', 'msm_menu_sites', 'msm_site_groups', 'msm_categories',
                           'msm_category_sites', 'msm_modifier_groups', 'msm_modifier_group_sites', 'msm_products',
                           'msm_product_sites', 'msm_change_sets', 'msm_changes', 'msm_versions', 'msm_version_sites'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from public, anon, authenticated', t);
    execute format('grant select on table public.%I to authenticated', t);
    execute format('grant all on table public.%I to service_role', t);
  end loop;
  foreach t in array array['msm_change_sets', 'msm_changes', 'msm_site_groups'] loop
    execute format('grant insert, update, delete on table public.%I to authenticated', t);
  end loop;
end
$rls$;

-- The switch and the members: a member reads their own company's row; ServOS reads all.
drop policy if exists msm_company_read on public.msm_company;
create policy msm_company_read on public.msm_company as permissive for select to authenticated
  using (org_id in (select public.msm_member_org_ids()) or (select public.is_super_admin()));
drop policy if exists msm_members_read on public.msm_members;
create policy msm_members_read on public.msm_members as permissive for select to authenticated
  using (user_id = (select auth.uid()) or org_id in (select public.msm_viewable_org_ids()));

-- Central tables: read for a member of a switched on company (or ServOS). NO write policy: they
-- are written only by the functions below, so central state always equals what was published.
drop policy if exists msm_menus_read on public.msm_menus;
create policy msm_menus_read on public.msm_menus as permissive for select to authenticated
  using (org_id in (select public.msm_viewable_org_ids()));
do $child$
declare
  t text;
begin
  foreach t in array array['msm_menu_sites', 'msm_categories', 'msm_modifier_groups', 'msm_products', 'msm_versions'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I as permissive for select to authenticated using (menu_id in (select public.msm_viewable_menu_ids()))', t || '_read', t);
  end loop;
end
$child$;
drop policy if exists msm_category_sites_read on public.msm_category_sites;
create policy msm_category_sites_read on public.msm_category_sites as permissive for select to authenticated
  using (category_id in (select c.id from public.msm_categories c where c.menu_id in (select public.msm_viewable_menu_ids())));
drop policy if exists msm_modifier_group_sites_read on public.msm_modifier_group_sites;
create policy msm_modifier_group_sites_read on public.msm_modifier_group_sites as permissive for select to authenticated
  using (group_id in (select g.id from public.msm_modifier_groups g where g.menu_id in (select public.msm_viewable_menu_ids())));
drop policy if exists msm_product_sites_read on public.msm_product_sites;
create policy msm_product_sites_read on public.msm_product_sites as permissive for select to authenticated
  using (product_id in (select p.id from public.msm_products p where p.menu_id in (select public.msm_viewable_menu_ids())));
drop policy if exists msm_version_sites_read on public.msm_version_sites;
create policy msm_version_sites_read on public.msm_version_sites as permissive for select to authenticated
  using (org_id in (select public.msm_viewable_org_ids()));

-- Staging: members read, editors write (split per command).
do $staging$
declare
  t text;
begin
  foreach t in array array['msm_change_sets', 'msm_changes', 'msm_site_groups'] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format('create policy %I on public.%I as permissive for select to authenticated using (org_id in (select public.msm_viewable_org_ids()))', t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('create policy %I on public.%I as permissive for insert to authenticated with check (org_id in (select public.msm_editable_org_ids()))', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('create policy %I on public.%I as permissive for update to authenticated using (org_id in (select public.msm_editable_org_ids())) with check (org_id in (select public.msm_editable_org_ids()))', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I as permissive for delete to authenticated using (org_id in (select public.msm_editable_org_ids()))', t || '_delete', t);
  end loop;
end
$staging$;

-- The second sign in step, as on every other table (20260919s). Skipped when that file has not run.
do $second_step$
declare
  t text;
begin
  if to_regprocedure('public.second_step_ok()') is null then
    return;
  end if;
  foreach t in array array['msm_company', 'msm_members', 'msm_menus', 'msm_menu_sites', 'msm_site_groups', 'msm_categories',
                           'msm_category_sites', 'msm_modifier_groups', 'msm_modifier_group_sites', 'msm_products',
                           'msm_product_sites', 'msm_change_sets', 'msm_changes', 'msm_versions', 'msm_version_sites'] loop
    if not exists (select 1 from pg_policy p where p.polrelid = format('public.%I', t)::regclass and p.polname = 'second_step_fence') then
      execute format('create policy second_step_fence on public.%I as restrictive for all to authenticated using ((select public.second_step_ok())) with check ((select public.second_step_ok()))', t);
    end if;
  end loop;
end
$second_step$;

-- ============================================================================
-- 5. FUNCTIONS FOR MEMBERS
-- ============================================================================

-- What the signed in login may do: one row per company it is a member of.
-- {"companies": [{"org_id", "org_name", "enabled", "role"}]}. Empty for everybody else.
create or replace function public.msm_my_access()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $fn$
  select jsonb_build_object('companies', coalesce(jsonb_agg(jsonb_build_object(
           'org_id', m.org_id, 'org_name', o.name, 'enabled', coalesce(c.enabled, false), 'role', m.role)
           order by o.name), '[]'::jsonb))
    from public.msm_members m
    join public.organisations o on o.id = m.org_id
    left join public.msm_company c on c.org_id = m.org_id
   where m.user_id = auth.uid() and auth.uid() is not null and not public.is_anon_session();
$fn$;

-- The first import: writes the CENTRAL tables only, in one transaction. Nothing at any venue.
-- Every venue id it is given must exist at that venue (review blocker: an id of another venue
-- would later write into that venue). Refused when the company already has a live group menu.
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
       wide as (select exists (select 1 from public.msm_changes c where c.change_set_id = p_set and c.target not in ('menu_site', 'product_site')) as yes)
  select ms.location_id from public.msm_menu_sites ms, s, wide where ms.menu_id = s.menu_id and wide.yes
  union
  select c.location_id from public.msm_changes c where c.change_set_id = p_set and c.location_id is not null;
$fn$;

-- Freeze a draft into a version with one site row per site it reaches. Internal.
create or replace function public.msm__freeze(p_set uuid, p_kind text, p_run_local timestamp, p_lead integer, p_idle boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_set      public.msm_change_sets%rowtype;
  v_version  uuid := gen_random_uuid();
  v_name     text;
  v_lead     integer := greatest(0, least(240, coalesce(p_lead, 5)));
  v_past     text;
  v_sites    jsonb;
begin
  select * into v_set from public.msm_change_sets s where s.id = p_set for update;
  if not found then
    raise exception 'No such set of changes.' using errcode = '22023';
  end if;
  perform public.msm__require_editor(v_set.org_id);
  if v_set.status <> 'draft' then
    raise exception 'This set is already %.', v_set.status using errcode = '22023';
  end if;
  if not exists (select 1 from public.msm_changes c where c.change_set_id = p_set) then
    raise exception 'There is nothing in this set to publish.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.msm__sites_reached(p_set)) then
    raise exception 'This set does not reach any site.' using errcode = '22023';
  end if;
  if p_kind = 'scheduled' then
    if p_run_local is null then
      raise exception 'Pick a date and time.' using errcode = '22023';
    end if;
    -- Read on each site's own clock; refused if it has already passed at any site.
    select l.name into v_past
      from public.msm__sites_reached(p_set) r(loc)
      join public.locations l on l.id::text = r.loc
     where (p_run_local at time zone coalesce(nullif(l.timezone, ''), 'Europe/London')) <= now()
     limit 1;
    if found then
      raise exception 'That time has already passed at %.', coalesce(v_past, 'one site') using errcode = '22023';
    end if;
  end if;
  select coalesce(nullif(btrim(p.full_name), ''), p.email) into v_name from public.user_profiles p where p.id = auth.uid();
  insert into public.msm_versions (id, menu_id, org_id, kind, change_set_id, title, status, apply_when_idle, created_by, created_by_name)
  values (v_version, v_set.menu_id, v_set.org_id, case when v_set.kind = 'undo' and p_kind = 'publish' then 'undo' when v_set.kind = 'add_site' and p_kind = 'publish' then 'add_site' else p_kind end,
          p_set, v_set.title, 'scheduled', coalesce(p_idle, v_set.apply_when_idle, true), auth.uid(), v_name);
  insert into public.msm_version_sites (version_id, location_id, org_id, status, due_at)
  select v_version, r.loc, v_set.org_id, 'scheduled',
         case when p_kind = 'scheduled'
              then (p_run_local at time zone coalesce(nullif(l.timezone, ''), 'Europe/London')) - make_interval(mins => v_lead)
              else now() end
    from public.msm__sites_reached(p_set) r(loc)
    left join public.locations l on l.id::text = r.loc;
  perform set_config('servos.msm_write', 'on', true);
  update public.msm_change_sets
     set status = 'scheduled', version_id = v_version, scheduled_by = auth.uid(), scheduled_at = now(),
         run_local = case when p_kind = 'scheduled' then p_run_local end, lead_minutes = v_lead,
         apply_when_idle = coalesce(p_idle, apply_when_idle, true)
   where id = p_set;
  perform set_config('servos.msm_write', 'off', true);
  select jsonb_agg(jsonb_build_object('location_id', vs.location_id, 'due_at', vs.due_at) order by vs.due_at, vs.location_id)
    into v_sites from public.msm_version_sites vs where vs.version_id = v_version;
  return jsonb_build_object('ok', true, 'version_id', v_version, 'sites', coalesce(v_sites, '[]'::jsonb));
end
$fn$;

-- Publish now: the set runs at once (the msm-publish function is asked straight away; if that
-- call is lost, the scheduler picks it up within a minute).
create or replace function public.msm_publish_now(p_set uuid, p_apply_when_idle boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  return public.msm__freeze(p_set, 'publish', null, 0, p_apply_when_idle);
end
$fn$;

-- Schedule: p_run_local is a wall clock time read on EACH site's clock; each site starts
-- p_lead_minutes before it so the change is on every till by that time.
create or replace function public.msm_schedule_set(p_set uuid, p_run_local timestamp, p_lead_minutes integer default 5, p_apply_when_idle boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  return public.msm__freeze(p_set, 'scheduled', p_run_local, p_lead_minutes, p_apply_when_idle);
end
$fn$;

-- Unschedule: back to a draft with every change kept (review: correct a scheduled set without
-- throwing it away). Refused once any site has started.
create or replace function public.msm_unschedule_set(p_set uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_set public.msm_change_sets%rowtype;
begin
  select * into v_set from public.msm_change_sets s where s.id = p_set for update;
  if not found then
    raise exception 'No such set of changes.' using errcode = '22023';
  end if;
  perform public.msm__require_editor(v_set.org_id);
  if v_set.status <> 'scheduled' then
    raise exception 'Only a scheduled set can be unscheduled (this one is %).', v_set.status using errcode = '22023';
  end if;
  perform 1 from public.msm_version_sites vs where vs.version_id = v_set.version_id for update;
  if exists (select 1 from public.msm_version_sites vs where vs.version_id = v_set.version_id and vs.status <> 'scheduled')
     or exists (select 1 from public.msm_versions v where v.id = v_set.version_id and v.version_no is not null) then
    raise exception 'It has already started, so it cannot be unscheduled.' using errcode = '22023';
  end if;
  delete from public.msm_versions v where v.id = v_set.version_id;
  perform set_config('servos.msm_write', 'on', true);
  update public.msm_change_sets
     set status = 'draft', version_id = null, scheduled_by = null, scheduled_at = null, run_local = null
   where id = p_set;
  perform set_config('servos.msm_write', 'off', true);
  return jsonb_build_object('ok', true, 'status', 'draft');
end
$fn$;

-- Cancel: the set will not run. Its changes stay, read only. Refused once any site has started.
create or replace function public.msm_cancel_set(p_set uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_set public.msm_change_sets%rowtype;
begin
  select * into v_set from public.msm_change_sets s where s.id = p_set for update;
  if not found then
    raise exception 'No such set of changes.' using errcode = '22023';
  end if;
  perform public.msm__require_editor(v_set.org_id);
  if v_set.status <> 'scheduled' then
    raise exception 'Only a scheduled set can be cancelled (this one is %).', v_set.status using errcode = '22023';
  end if;
  perform 1 from public.msm_version_sites vs where vs.version_id = v_set.version_id for update;
  if exists (select 1 from public.msm_version_sites vs where vs.version_id = v_set.version_id and vs.status <> 'scheduled')
     or exists (select 1 from public.msm_versions v where v.id = v_set.version_id and v.version_no is not null) then
    raise exception 'It has already started, so it cannot be cancelled.' using errcode = '22023';
  end if;
  update public.msm_version_sites set status = 'cancelled', finished_at = now() where version_id = v_set.version_id;
  update public.msm_versions set status = 'cancelled', finished_at = now() where id = v_set.version_id;
  perform set_config('servos.msm_write', 'on', true);
  update public.msm_change_sets set status = 'cancelled' where id = p_set;
  perform set_config('servos.msm_write', 'off', true);
  return jsonb_build_object('ok', true, 'status', 'cancelled');
end
$fn$;

-- Retry one site that failed: it runs again at once, with central values as they are now.
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
  update public.msm_version_sites
     set status = 'scheduled', due_at = now(), claimed_at = null, error = null, finished_at = null,
         precheck_at = null, precheck_ok = null, precheck_words = null, late_at = null, notified = '{}'::jsonb
   where version_id = p_version and location_id = p_location;
  perform public.msm__refresh_version(p_version);
  return jsonb_build_object('ok', true, 'status', 'scheduled');
end
$fn$;

-- The venue products the group menu manages at a venue, for the Menu Manager lock (a SCREEN
-- lock, not a database lock). Only while the company is switched on. Anyone who uses that venue.
create or replace function public.msm_managed_items(p_location text)
returns table (venue_item_id text, product_id uuid, kept text[])
language sql
stable
security definer
set search_path = ''
as $fn$
  select ps.venue_item_id, ps.product_id, array(select jsonb_object_keys(ps.kept) order by 1)
    from public.msm_product_sites ps
    join public.msm_products p on p.id = ps.product_id
    join public.msm_menus m on m.id = p.menu_id and m.status = 'live'
    join public.msm_company c on c.org_id = m.org_id and c.enabled
   where ps.location_id = p_location
     and (p_location in (select public.accessible_location_ids()) or public.is_super_admin());
$fn$;

-- ============================================================================
-- 6. FUNCTIONS FOR SERVOS (Company Admin)
-- ============================================================================

create or replace function public.msm_admin_status(p_org uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $fn$
declare
  v_out jsonb;
begin
  perform public.msm__require_servos();
  select jsonb_build_object(
           'org_id', p_org,
           'enabled', coalesce((select c.enabled from public.msm_company c where c.org_id = p_org), false),
           'enabled_at', (select c.enabled_at from public.msm_company c where c.org_id = p_org),
           'has_menu', exists (select 1 from public.msm_menus m where m.org_id = p_org and m.status = 'live'),
           'members', coalesce((select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role, 'added_at', m.added_at,
                                                                   'email', p.email, 'full_name', p.full_name) order by p.email)
                                  from public.msm_members m left join public.user_profiles p on p.id = m.user_id
                                 where m.org_id = p_org), '[]'::jsonb))
    into v_out;
  return v_out;
end
$fn$;

create or replace function public.msm_admin_set_enabled(p_org uuid, p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
begin
  perform public.msm__require_servos();
  if p_org is null or not exists (select 1 from public.organisations o where o.id = p_org) then
    raise exception 'No such company.' using errcode = '22023';
  end if;
  insert into public.msm_company as mc (org_id, enabled, enabled_by, enabled_at, updated_at)
  values (p_org, coalesce(p_on, false), auth.uid(), case when p_on then now() end, now())
  on conflict (org_id) do update
     set enabled = coalesce(p_on, false),
         enabled_by = auth.uid(),
         enabled_at = case when p_on then coalesce(case when mc.enabled then mc.enabled_at end, now()) else mc.enabled_at end,
         updated_at = now();
  return public.msm_admin_status(p_org);
end
$fn$;

-- p_role 'editor' or 'viewer' adds or changes; null removes.
create or replace function public.msm_admin_set_member(p_org uuid, p_user uuid, p_role text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_rows integer;
begin
  perform public.msm__require_servos();
  if p_org is null or not exists (select 1 from public.organisations o where o.id = p_org) then
    raise exception 'No such company.' using errcode = '22023';
  end if;
  if p_role is not null and p_role not in ('editor', 'viewer') then
    raise exception 'A person is an editor or a viewer.' using errcode = '22023';
  end if;
  -- A real login with an email (never a till's or a kiosk's anonymous session).
  perform 1 from public.user_profiles p where p.id = p_user and nullif(btrim(p.email), '') is not null for update;
  if not found then
    raise exception 'That login is not a person with an email.' using errcode = '22023';
  end if;
  if p_role is null then
    delete from public.msm_members m where m.org_id = p_org and m.user_id = p_user;
  else
    insert into public.msm_members (org_id, user_id, role, added_by)
    values (p_org, p_user, p_role, auth.uid())
    on conflict (org_id, user_id) do update set role = excluded.role;
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      raise exception 'The change did not save. Try again.';
    end if;
  end if;
  return public.msm_admin_status(p_org);
end
$fn$;

-- ============================================================================
-- 7. THE SERVER PATH (service role only: the msm-publish function)
-- ============================================================================

create or replace function public.msm_cron_ok(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(length(p_key) >= 32 and exists (
    select 1 from vault.decrypted_secrets s where s.name = 'msm_cron_key' and s.decrypted_secret = p_key
  ), false);
$fn$;

-- Everything at a venue a publish depends on, as one md5 (design review blocker: counts and the
-- newest updated_at missed ordinary saves; device clocks stamp updated_at). Every row of the menu
-- tables, the category links of the venue's menus, tax rates and profiles, print routing and printers.
create or replace function public.msm_venue_fingerprint(p_location text)
returns text
language sql
stable
security definer
set search_path = ''
as $fn$
  select md5(concat_ws('|',
    (select coalesce(string_agg(md5(to_jsonb(m)::text), ',' order by m.id), '') from public.menus m where m.location_id = p_location),
    (select coalesce(string_agg(md5(to_jsonb(c)::text), ',' order by c.id), '') from public.menu_categories c where c.location_id = p_location),
    (select coalesce(string_agg(md5(to_jsonb(i)::text), ',' order by i.id), '') from public.menu_items i where i.location_id = p_location),
    (select coalesce(string_agg(md5(to_jsonb(g)::text), ',' order by g.id), '') from public.modifier_groups g where g.location_id = p_location),
    (select coalesce(string_agg(l.menu_id || ':' || l.category_id || ':' || l.sort_order, ',' order by l.menu_id, l.category_id), '')
       from public.menu_category_links l join public.menus m on m.id = l.menu_id where m.location_id = p_location),
    (select coalesce(string_agg(md5(to_jsonb(r)::text), ',' order by r.id), '') from public.tax_rates r where r.location_id::text = p_location),
    (select coalesce(string_agg(md5(to_jsonb(t)::text), ',' order by t.id), '') from public.tax_profiles t where t.location_id::text = p_location),
    (select coalesce(string_agg(md5(to_jsonb(t)::text), ',' order by t.id), '') from public.tax_profile_lines t where t.location_id::text = p_location),
    (select coalesce(string_agg(md5(to_jsonb(r)::text), ',' order by r.id), '') from public.print_routing r where r.location_id::text = p_location),
    (select coalesce(string_agg(md5(to_jsonb(p)::text), ',' order by p.id), '') from public.printers p where p.location_id::text = p_location)
  ));
$fn$;

-- A version's status from its sites, mirrored on its change set. Internal.
create or replace function public.msm__refresh_version(p_version uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_open integer; v_done integer; v_failed integer; v_cancelled integer; v_total integer;
  v_status text;
  v_v public.msm_versions%rowtype;
begin
  select * into v_v from public.msm_versions where id = p_version;
  if not found then return null; end if;
  select count(*) filter (where status in ('scheduled', 'running')),
         count(*) filter (where status in ('done', 'nothing')),
         count(*) filter (where status = 'failed'),
         count(*) filter (where status = 'cancelled'),
         count(*)
    into v_open, v_done, v_failed, v_cancelled, v_total
    from public.msm_version_sites where version_id = p_version;
  v_status := case
    when v_total = 0 then v_v.status
    when v_cancelled = v_total then 'cancelled'
    when v_open > 0 then case when v_v.version_no is null then 'scheduled' else 'running' end
    when v_failed = 0 then 'done'
    when v_done = 0 then 'failed'
    else 'partly_done' end;
  update public.msm_versions
     set status = v_status,
         finished_at = case when v_status in ('done', 'failed', 'partly_done', 'cancelled') then coalesce(finished_at, now()) else null end
   where id = p_version;
  if v_v.change_set_id is not null then
    perform set_config('servos.msm_write', 'on', true);
    update public.msm_change_sets set status = v_status where id = v_v.change_set_id and status <> v_status;
    perform set_config('servos.msm_write', 'off', true);
  end if;
  if v_status in ('done', 'partly_done') then
    update public.msm_menus m
       set last_published_at = now(), last_published_by = coalesce(v_v.created_by_name, m.last_published_by)
     where m.id = v_v.menu_id;
  end if;
  return v_status;
end
$fn$;

-- Claim the next due site runs (FOR UPDATE SKIP LOCKED; a claim older than 10 minutes is taken
-- again). Only companies switched on (a company switched off pauses its scheduled sets). Never a
-- site of a later set while an earlier set is still waiting at that same site (sets run in order).
create or replace function public.msm_claim_due(p_limit integer default 1)
returns table (version_id uuid, location_id text, attempts integer)
language plpgsql
security definer
set search_path = ''
as $fn$
#variable_conflict use_column
begin
  return query
  with c as (
    select vs.version_id, vs.location_id
      from public.msm_version_sites vs
      join public.msm_versions v on v.id = vs.version_id
      join public.msm_company co on co.org_id = v.org_id and co.enabled
     where ((vs.status = 'scheduled' and vs.due_at <= now())
         or (vs.status = 'running' and vs.claimed_at < now() - interval '10 minutes'))
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

-- Start a version: apply its change set to the CENTRAL tables, once (idempotent), recording the
-- central before and after of every change (for history and undo), and number the version.
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
  for c in select * from public.msm_changes x where x.change_set_id = v.change_set_id order by x.created_at, x.id loop
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

-- Has a key of a written row's columns stayed inside the allowlist? Internal.
create or replace function public.msm__keys_ok(p_obj jsonb, p_allowed text[])
returns boolean
language sql
immutable
set search_path = ''
as $fn$
  select p_obj is null or jsonb_typeof(p_obj) <> 'object'
      or not exists (select 1 from jsonb_object_keys(p_obj) k where k <> all (p_allowed));
$fn$;

-- WRITE ONE VENUE: its menu rows in place and its config push, in ONE transaction.
--   p_writes   msmPlan.js planSite(...).writes:
--     { menus: {insert:[row], update:[{id, set}]}, categories: {insert, update}, items: {insert, update:[{id, set, pricing}]},
--       links: {insert:[{menu_id, category_id, sort_order}], delete:[{menu_id, category_id}]}, groups: {insert:[row]},
--       options: [{item_id, price?, name?}], routing: [{centre_id, category_id}],
--       maps: {categories:[{category_id, venue_category_id}], groups:[{group_id, venue_group_id}], menu_site: {venue_menu_id}} }
--   p_snapshot  the config push (msmSnapshot.js), built from the same read with these writes applied
--   p_fingerprint  msm_venue_fingerprint as the function read it BEFORE that read
-- Idempotent: a site already done says so and writes nothing. A venue saved in between (the
-- fingerprint moved) is refused whole: {ok:false, reason:'changed'}; the function reads again.
-- Every row written is checked: the venue's own id for an update, a new id for an insert, only
-- allowlisted columns, references at this venue. updated_at is stamped now() by the server.
create or replace function public.msm_apply_site(p_version uuid, p_location text, p_writes jsonb, p_snapshot jsonb,
                                                 p_fingerprint text, p_counts jsonb default '{}'::jsonb,
                                                 p_pushed_by text default 'Multi site menu', p_summary text default null)
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
  if not exists (select 1 from public.msm_company c where c.org_id = v.org_id and c.enabled) then
    raise exception 'The Multi site menu is switched off for this company.';
  end if;
  if not exists (select 1 from public.msm_menu_sites s where s.menu_id = v.menu_id and s.location_id = p_location)
     or not public.msm__venue_in_org(p_location, v.org_id) then
    raise exception 'That site is not in this group menu.';
  end if;
  if p_fingerprint is distinct from public.msm_venue_fingerprint(p_location) then
    return jsonb_build_object('ok', false, 'reason', 'changed', 'words', 'Someone saved the menu at this site while it was being published. Reading it again.');
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
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'categories', 'id', w ->> 'id', 'before', null, 'after', w));
  end loop;
  for u in select x from jsonb_array_elements(coalesce(p_writes #> '{categories,update}', '[]'::jsonb)) x loop
    if not public.msm__keys_ok(u -> 'set', v_upd_cats) then raise exception 'A category change has a field publish may not write.'; end if;
    select to_jsonb(c) into v_old from public.menu_categories c where c.id = u ->> 'id' and c.location_id = p_location for update;
    if v_old is null then raise exception 'A category is not at this site (%).', u ->> 'id'; end if;
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
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'items', 'id', w ->> 'id', 'before', null, 'after', w));
  end loop;
  for u in select x from jsonb_array_elements(coalesce(p_writes #> '{items,update}', '[]'::jsonb)) x loop
    if not public.msm__keys_ok(coalesce(u -> 'set', '{}'::jsonb), v_upd_items) or not public.msm__keys_ok(u -> 'pricing', v_pricing) then
      raise exception 'A product change has a field publish may not write.';
    end if;
    select to_jsonb(i) into v_old from public.menu_items i where i.id = u ->> 'id' and i.location_id = p_location for update;
    if v_old is null then raise exception 'A product is not at this site (%).', u ->> 'id'; end if;
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
  -- Every product written points only at this venue's own rows.
  if exists (
    select 1 from public.menu_items i
     where i.location_id = p_location and i.id = any (v_items)
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
    delete from public.menu_category_links l where l.menu_id = w ->> 'menu_id' and l.category_id = w ->> 'category_id';
    v_audit := v_audit || jsonb_build_array(jsonb_build_object('table', 'links', 'id', (w ->> 'menu_id') || '|' || (w ->> 'category_id'), 'before', w, 'after', null));
  end loop;

  -- option prices and names follow their sub item (review blocker 2) -----
  for w in select x from jsonb_array_elements(coalesce(p_writes -> 'options', '[]'::jsonb)) x loop
    if not exists (select 1 from public.menu_items i where i.id = w ->> 'item_id' and i.location_id = p_location) then
      raise exception 'An option follows a product that is not at this site.';
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

-- A site that could not be published: the reason in words. p_retry_in (minutes) puts it back in
-- the queue instead (a venue that was saving; at most 5 tries).
create or replace function public.msm_fail_site(p_version uuid, p_location text, p_words text, p_retry_in integer default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  vs public.msm_version_sites%rowtype;
  v_menu uuid;
begin
  select * into vs from public.msm_version_sites s where s.version_id = p_version and s.location_id = p_location for update;
  if not found then
    raise exception 'That site is not in this publish.';
  end if;
  if vs.status in ('done', 'nothing', 'cancelled') then
    return jsonb_build_object('ok', true, 'status', vs.status);
  end if;
  if p_retry_in is not null and vs.attempts < 5 then
    update public.msm_version_sites
       set status = 'scheduled', due_at = now() + make_interval(mins => greatest(0, least(p_retry_in, 30))), claimed_at = null,
           error = left(p_words, 600)
     where version_id = p_version and location_id = p_location;
    return jsonb_build_object('ok', true, 'status', 'scheduled');
  end if;
  update public.msm_version_sites
     set status = 'failed', finished_at = now(), error = left(coalesce(nullif(btrim(p_words), ''), 'It could not be published.'), 600)
   where version_id = p_version and location_id = p_location;
  select menu_id into v_menu from public.msm_versions where id = p_version;
  update public.msm_menu_sites set last_error = left(p_words, 600) where menu_id = v_menu and location_id = p_location;
  perform public.msm__refresh_version(p_version);
  return jsonb_build_object('ok', true, 'status', 'failed');
end
$fn$;

-- The pre check (review): sites due within 60 minutes that have not been checked. Claims them.
create or replace function public.msm_precheck_due(p_limit integer default 10)
returns table (version_id uuid, location_id text)
language plpgsql
security definer
set search_path = ''
as $fn$
#variable_conflict use_column
begin
  return query
  with c as (
    select vs.version_id, vs.location_id
      from public.msm_version_sites vs
      join public.msm_versions v on v.id = vs.version_id
      join public.msm_company co on co.org_id = v.org_id and co.enabled
     where vs.status = 'scheduled' and vs.precheck_at is null
       and vs.due_at > now() and vs.due_at <= now() + interval '60 minutes'
     order by vs.due_at
     limit greatest(1, least(coalesce(p_limit, 10), 50))
     for update of vs skip locked
  ), u as (
    update public.msm_version_sites s set precheck_at = now()
      from c where s.version_id = c.version_id and s.location_id = c.location_id
    returning s.version_id, s.location_id
  )
  select u.version_id, u.location_id from u;
end
$fn$;

create or replace function public.msm_precheck_result(p_version uuid, p_location text, p_ok boolean, p_words text)
returns void
language sql
security definer
set search_path = ''
as $fn$
  update public.msm_version_sites
     set precheck_ok = p_ok, precheck_words = left(p_words, 600), precheck_at = coalesce(precheck_at, now())
   where version_id = p_version and location_id = p_location;
$fn$;

-- Site runs not done 15 minutes after their time, marked once. Returns the newly late ones.
create or replace function public.msm_mark_late()
returns table (version_id uuid, location_id text)
language sql
security definer
set search_path = ''
as $fn$
  update public.msm_version_sites s set late_at = now()
    from public.msm_versions v, public.msm_company co
   where v.id = s.version_id and co.org_id = v.org_id and co.enabled
     and s.status in ('scheduled', 'running') and s.late_at is null and s.due_at < now() - interval '15 minutes'
  returning s.version_id, s.location_id;
$fn$;

-- The notification ledger: true only the first time a key is noted for a site, so an email or a
-- feed entry is never sent twice, however often a run repeats.
create or replace function public.msm_note_notified(p_version uuid, p_location text, p_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_rows integer;
begin
  update public.msm_version_sites
     set notified = notified || jsonb_build_object(p_key, now())
   where version_id = p_version and location_id = p_location and not (notified ? p_key);
  get diagnostics v_rows = row_count;
  return v_rows = 1;
end
$fn$;

-- ============================================================================
-- 8. THE SCHEDULER: a key in the vault, a function the job runs, the job
-- ============================================================================

do $key$
begin
  if not exists (select 1 from vault.secrets where name = 'msm_cron_key') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'msm_cron_key',
      'pg_cron msm-run-due proves itself to msm-publish run_due with this (20261017). Made by the database, never typed.'
    );
  end if;
end
$key$;

-- What the job runs every minute. A cheap index read first; it posts to msm-publish ONLY when a
-- site run is due, a claim went stale, a pre check is due or a run is late. The key is read from
-- the vault at call time and is never in the job's text.
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
  if not exists (
    select 1
      from public.msm_version_sites vs
      join public.msm_versions v on v.id = vs.version_id
      join public.msm_company c on c.org_id = v.org_id and c.enabled
     where vs.status in ('scheduled', 'running')
       and ((vs.status = 'scheduled' and vs.due_at <= now())
         or (vs.status = 'running' and vs.claimed_at < now() - interval '10 minutes')
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

do $cron$
declare
  j record;
begin
  for j in select jobid from cron.job where jobname = 'msm-run-due' loop
    perform cron.unschedule(j.jobid);
  end loop;
  perform cron.schedule('msm-run-due', '* * * * *', 'select public.msm_run_due();');
end
$cron$;

-- ============================================================================
-- 9. GRANTS ON FUNCTIONS (anon gets none; revoked by name, see section 4)
-- ============================================================================

do $grants$
declare
  f text;
begin
  -- every function in this file, closed first
  foreach f in array array[
    'public.msm_role(uuid)', 'public.msm_can_view(uuid)', 'public.msm_can_edit(uuid)', 'public.msm_viewable_org_ids()',
    'public.msm_editable_org_ids()', 'public.msm_viewable_menu_ids()', 'public.msm_member_org_ids()', 'public.msm__second_step_ok()',
    'public.msm__require_editor(uuid)', 'public.msm__require_servos()', 'public.msm__venue_in_org(text,uuid)',
    'public.msm_site_org_guard()', 'public.msm_site_groups_guard()', 'public.msm_change_sets_guard()', 'public.msm__ref_ok(uuid,uuid,text,uuid)',
    'public.msm_changes_guard()', 'public.msm_my_access()', 'public.msm_import_commit(jsonb)', 'public.msm__sites_reached(uuid)',
    'public.msm__freeze(uuid,text,timestamp,integer,boolean)', 'public.msm_publish_now(uuid,boolean)',
    'public.msm_schedule_set(uuid,timestamp,integer,boolean)', 'public.msm_unschedule_set(uuid)', 'public.msm_cancel_set(uuid)',
    'public.msm_retry_site(uuid,text)', 'public.msm_managed_items(text)', 'public.msm_admin_status(uuid)',
    'public.msm_admin_set_enabled(uuid,boolean)', 'public.msm_admin_set_member(uuid,uuid,text)', 'public.msm_cron_ok(text)',
    'public.msm_venue_fingerprint(text)', 'public.msm__refresh_version(uuid)', 'public.msm_claim_due(integer)',
    'public.msm_start_version(uuid)', 'public.msm__keys_ok(jsonb,text[])',
    'public.msm_apply_site(uuid,text,jsonb,jsonb,text,jsonb,text,text)', 'public.msm_fail_site(uuid,text,text,integer)',
    'public.msm_precheck_due(integer)', 'public.msm_precheck_result(uuid,text,boolean,text)', 'public.msm_mark_late()',
    'public.msm_note_notified(uuid,text,text)', 'public.msm_run_due()'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
  -- signed in people (row level security helpers and the member and ServOS calls, each checks itself)
  foreach f in array array[
    'public.msm_role(uuid)', 'public.msm_can_view(uuid)', 'public.msm_can_edit(uuid)', 'public.msm_viewable_org_ids()',
    'public.msm_editable_org_ids()', 'public.msm_viewable_menu_ids()', 'public.msm_member_org_ids()',
    'public.msm_my_access()', 'public.msm_import_commit(jsonb)', 'public.msm_publish_now(uuid,boolean)',
    'public.msm_schedule_set(uuid,timestamp,integer,boolean)', 'public.msm_unschedule_set(uuid)', 'public.msm_cancel_set(uuid)',
    'public.msm_retry_site(uuid,text)', 'public.msm_managed_items(text)', 'public.msm_admin_status(uuid)',
    'public.msm_admin_set_enabled(uuid,boolean)', 'public.msm_admin_set_member(uuid,uuid,text)'] loop
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- the msm-publish function
  foreach f in array array[
    'public.msm_cron_ok(text)', 'public.msm_venue_fingerprint(text)', 'public.msm_claim_due(integer)', 'public.msm_start_version(uuid)',
    'public.msm_apply_site(uuid,text,jsonb,jsonb,text,jsonb,text,text)', 'public.msm_fail_site(uuid,text,text,integer)',
    'public.msm_precheck_due(integer)', 'public.msm_precheck_result(uuid,text,boolean,text)', 'public.msm_mark_late()',
    'public.msm_note_notified(uuid,text,text)', 'public.msm_can_edit(uuid)', 'public.msm_role(uuid)'] loop
    execute format('grant execute on function %s to service_role', f);
  end loop;
  -- msm_run_due: nobody but the job (it runs as the database owner).
end
$grants$;

comment on function public.msm_apply_site(uuid,text,jsonb,jsonb,text,jsonb,text,text) is
  'Multi site menu (17 Oct 2026): writes ONE venue''s menu rows in place and its config push in one transaction. Service role only (msm-publish). Idempotent; refuses a venue saved in between (fingerprint).';
comment on function public.msm_run_due() is
  'Multi site menu: pg_cron msm-run-due. Posts run_due to msm-publish with the vault key only when something is due. Never grant it to anyone.';

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   tables 15, rls_on 15, fenced 15 (or 0 on a database without the second step), anon_table_rights 0,
--   anon_function_rights 0, member_functions 18, server_functions 12, job_every_minute 1, key_present true,
--   key_not_in_job 1, guards 8, companies_switched_on 0
select
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'msm\_%') as tables,
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'msm\_%' and c.relrowsecurity) as rls_on,
  (select count(distinct p.polrelid) from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname like 'msm\_%' and p.polname = 'second_step_fence') as fenced,
  (select count(*) from information_schema.role_table_grants g
    where g.table_schema = 'public' and g.table_name like 'msm\_%' and g.grantee in ('anon', 'PUBLIC')) as anon_table_rights,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'msm%' and has_function_privilege('anon', p.oid, 'execute')) as anon_function_rights,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'msm%' and has_function_privilege('authenticated', p.oid, 'execute')) as member_functions,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'msm%' and has_function_privilege('service_role', p.oid, 'execute')) as server_functions,
  (select count(*) from cron.job where jobname = 'msm-run-due' and schedule = '* * * * *' and command like '%public.msm_run_due()%' and active) as job_every_minute,
  exists (select 1 from vault.secrets where name = 'msm_cron_key') as key_present,
  (select count(*) from cron.job j where j.jobname = 'msm-run-due'
     and position(coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'msm_cron_key' limit 1), '#none#') in j.command) = 0) as key_not_in_job,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and c.relname like 'msm\_%') as guards,
  (select count(*) from public.msm_company where enabled) as companies_switched_on;
