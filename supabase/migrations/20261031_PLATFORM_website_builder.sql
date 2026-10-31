-- 20261031_PLATFORM_website_builder.sql  (31 Oct 2026, v5.12.0, Website builder, first iteration)
--
-- ############################################################################
-- #  PLATFORM DB ONLY   project ref  yhzjgyrkyjabvhblqxzu                     #
-- #  Peter runs this by hand in the Supabase SQL editor (Platform project).   #
-- #  Safe to run twice. The guard stops it (changing nothing) in Ops.         #
-- ############################################################################
--
-- WHAT THIS MAKES (docs/website-builder/ARCHITECTURE.md section 2)
--   web_sites          one website per company (slug, custom domain, theme, nav, footer, seo, settings)
--   web_pages          the pages of a site (Puck layout json), unique slug per site
--   web_posts          the blog
--   web_site_versions  every publish kept as a whole snapshot, one press restores
--   web_ai_messages    the designer chat per site, so it survives a reload
--   web_assets         uploads used by the site (bucket web-assets, public read)
--   web_sites_public   the ONLY thing the public reads: live sites + their published snapshot
--   web_resolve_host   hostname -> public row (custom domain, apex, or <slug>.sites.serv-os.app)
--   web_company_for_user  the companies a login may manage (service role only; the AI function)
--
-- ACCESS. Every table has row level security FORCED. The browser roles (anon, authenticated) get
-- NO table grants at all: the Platform browser client holds no login (src/lib/supabase.js,
-- persistSession false), so a table policy could never tell the owner from anyone else. Writes
-- come through the website-admin and website-domain edge functions (service role). The owner
-- read policies below use the Platform's own access tables (user_company_roles and
-- user_location_access joined to locations.company_id, the pattern the companies and gift
-- tables already use); they fire only for a real Platform login and are harmless otherwise.
-- Anon reads ONE view (live sites only) and ONE function (web_resolve_host).
--
-- RULES: no begin or commit (an error means nothing changed), every statement can run twice,
-- 3 second lock wait, VISIBLE CHECK at the bottom.

set local lock_timeout = '3s';

do $guard$
begin
  if to_regclass('public.companies') is null
     or to_regclass('public.locations') is null
     or to_regclass('public.user_locations') is not null then
    raise exception 'This file is for the PLATFORM project (yhzjgyrkyjabvhblqxzu). This is not it. Nothing was changed.';
  end if;
end
$guard$;

-- ============================================================================
-- 1. TABLES
-- ============================================================================

create table if not exists public.web_sites (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null unique references public.companies(id) on delete cascade,
  slug                 text not null unique,
  custom_domain        text unique,
  apex_domain          text,
  domain_status        jsonb not null default '{}'::jsonb,
  status               text not null default 'draft',
  theme                jsonb not null default '{}'::jsonb,
  nav                  jsonb not null default '[]'::jsonb,
  footer               jsonb not null default '{}'::jsonb,
  seo                  jsonb not null default '{}'::jsonb,
  settings             jsonb not null default '{}'::jsonb,
  published_version_id uuid,
  published_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

alter table public.web_sites drop constraint if exists web_sites_status_check;
alter table public.web_sites add constraint web_sites_status_check check (status in ('draft', 'live', 'offline'));
-- 3 to 40 lower case letters, digits, hyphens, no hyphen at either end. The reserved list lives in
-- the edge function (websiteRules.js RESERVED_SITE_SLUGS); the database keeps the shape.
alter table public.web_sites drop constraint if exists web_sites_slug_shape;
alter table public.web_sites add constraint web_sites_slug_shape check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$');
alter table public.web_sites drop constraint if exists web_sites_custom_domain_lower;
alter table public.web_sites add constraint web_sites_custom_domain_lower check (custom_domain is null or custom_domain = lower(custom_domain));

create table if not exists public.web_pages (
  id          uuid primary key default gen_random_uuid(),
  site_id     uuid not null references public.web_sites(id) on delete cascade,
  slug        text not null,
  title       text not null,
  kind        text not null default 'custom',
  layout      jsonb not null default '{"content":[],"root":{"props":{}}}'::jsonb,
  seo         jsonb not null default '{}'::jsonb,
  sort_order  int not null default 0,
  status      text not null default 'published',
  location_id uuid,
  updated_at  timestamptz not null default now(),
  unique (site_id, slug)
);
alter table public.web_pages drop constraint if exists web_pages_kind_check;
alter table public.web_pages add constraint web_pages_kind_check
  check (kind in ('home', 'menu', 'order', 'catering', 'loyalty', 'gift', 'findus', 'blog', 'location', 'custom'));
alter table public.web_pages drop constraint if exists web_pages_status_check;
alter table public.web_pages add constraint web_pages_status_check check (status in ('draft', 'published'));
alter table public.web_pages drop constraint if exists web_pages_slug_shape;
alter table public.web_pages add constraint web_pages_slug_shape check (slug = '' or slug ~ '^[a-z0-9-]{1,60}$');

create table if not exists public.web_posts (
  id           uuid primary key default gen_random_uuid(),
  site_id      uuid not null references public.web_sites(id) on delete cascade,
  slug         text not null,
  title        text not null,
  excerpt      text,
  body_md      text not null default '',
  cover_url    text,
  author       text,
  tags         text[] default '{}'::text[],
  status       text not null default 'draft',
  published_at timestamptz,
  updated_at   timestamptz not null default now(),
  unique (site_id, slug)
);
alter table public.web_posts drop constraint if exists web_posts_status_check;
alter table public.web_posts add constraint web_posts_status_check check (status in ('draft', 'published'));
alter table public.web_posts drop constraint if exists web_posts_slug_shape;
alter table public.web_posts add constraint web_posts_slug_shape check (slug ~ '^[a-z0-9-]{1,60}$');

create table if not exists public.web_site_versions (
  id         uuid primary key default gen_random_uuid(),
  site_id    uuid not null references public.web_sites(id) on delete cascade,
  snapshot   jsonb not null,
  note       text,
  created_by uuid,
  created_at timestamptz not null default now()
);

-- web_sites.published_version_id -> web_site_versions, added once both tables exist.
do $fk$
begin
  if not exists (select 1 from pg_constraint where conname = 'web_sites_published_version_fkey') then
    alter table public.web_sites
      add constraint web_sites_published_version_fkey
      foreign key (published_version_id) references public.web_site_versions(id) on delete set null;
  end if;
end
$fk$;

create table if not exists public.web_ai_messages (
  id         uuid primary key default gen_random_uuid(),
  site_id    uuid not null references public.web_sites(id) on delete cascade,
  role       text not null,
  content    text not null,
  patch      jsonb,
  created_at timestamptz not null default now()
);
alter table public.web_ai_messages drop constraint if exists web_ai_messages_role_check;
alter table public.web_ai_messages add constraint web_ai_messages_role_check check (role in ('user', 'assistant'));

create table if not exists public.web_assets (
  id         uuid primary key default gen_random_uuid(),
  site_id    uuid not null references public.web_sites(id) on delete cascade,
  path       text not null,
  kind       text not null default 'photo',
  alt        text,
  width      int,
  height     int,
  created_at timestamptz not null default now()
);
alter table public.web_assets drop constraint if exists web_assets_kind_check;
alter table public.web_assets add constraint web_assets_kind_check check (kind in ('photo', 'logo', 'og', 'favicon', 'post'));

-- ============================================================================
-- 2. INDEXES AND updated_at TRIGGERS
-- ============================================================================

create index if not exists web_sites_slug_idx           on public.web_sites (slug);
create index if not exists web_sites_custom_domain_idx  on public.web_sites (custom_domain);
create index if not exists web_sites_apex_domain_idx    on public.web_sites (apex_domain);
create index if not exists web_sites_company_id_idx     on public.web_sites (company_id);
create index if not exists web_pages_site_idx           on public.web_pages (site_id, sort_order);
create index if not exists web_posts_site_idx           on public.web_posts (site_id, status, published_at desc);
create index if not exists web_site_versions_site_idx   on public.web_site_versions (site_id, created_at desc);
create index if not exists web_ai_messages_site_idx     on public.web_ai_messages (site_id, created_at);
create index if not exists web_assets_site_idx          on public.web_assets (site_id);

-- public.set_updated_at() exists in the Platform baseline (000_baseline_platform.sql).
drop trigger if exists web_sites_touch on public.web_sites;
create trigger web_sites_touch before update on public.web_sites for each row execute function public.set_updated_at();
drop trigger if exists web_pages_touch on public.web_pages;
create trigger web_pages_touch before update on public.web_pages for each row execute function public.set_updated_at();
drop trigger if exists web_posts_touch on public.web_posts;
create trigger web_posts_touch before update on public.web_posts for each row execute function public.set_updated_at();

-- ============================================================================
-- 3. ROW LEVEL SECURITY AND GRANTS
-- ============================================================================

alter table public.web_sites          enable row level security;
alter table public.web_pages          enable row level security;
alter table public.web_posts          enable row level security;
alter table public.web_site_versions  enable row level security;
alter table public.web_ai_messages    enable row level security;
alter table public.web_assets         enable row level security;
alter table public.web_sites          force row level security;
alter table public.web_pages          force row level security;
alter table public.web_posts          force row level security;
alter table public.web_site_versions  force row level security;
alter table public.web_ai_messages    force row level security;
alter table public.web_assets         force row level security;

-- Supabase's default ACL hands ALL on every new table to anon and authenticated. Take it back:
-- the browser never touches these tables (the view and the function below are its only doors).
revoke all on table public.web_sites, public.web_pages, public.web_posts, public.web_site_versions,
                    public.web_ai_messages, public.web_assets from anon, authenticated, public;
-- The owner read policies need a SELECT grant to have any effect for a real Platform login.
grant select on table public.web_sites, public.web_pages, public.web_posts, public.web_site_versions,
                      public.web_ai_messages, public.web_assets to authenticated;

-- The companies this login reaches on the Platform: a company role, or a location of the company.
create or replace function public.web_my_companies()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select ucr.company_id from public.user_company_roles ucr where ucr.user_id = auth.uid()
  union
  select l.company_id from public.user_location_access ula
    join public.locations l on l.id = ula.location_id
   where ula.user_id = auth.uid() and l.company_id is not null
$$;
revoke all on function public.web_my_companies() from public, anon;
grant execute on function public.web_my_companies() to authenticated, service_role;

drop policy if exists web_sites_owner_read on public.web_sites;
create policy web_sites_owner_read on public.web_sites for select to authenticated
  using (company_id in (select public.web_my_companies()));

drop policy if exists web_pages_owner_read on public.web_pages;
create policy web_pages_owner_read on public.web_pages for select to authenticated
  using (site_id in (select s.id from public.web_sites s where s.company_id in (select public.web_my_companies())));

drop policy if exists web_posts_owner_read on public.web_posts;
create policy web_posts_owner_read on public.web_posts for select to authenticated
  using (site_id in (select s.id from public.web_sites s where s.company_id in (select public.web_my_companies())));

drop policy if exists web_site_versions_owner_read on public.web_site_versions;
create policy web_site_versions_owner_read on public.web_site_versions for select to authenticated
  using (site_id in (select s.id from public.web_sites s where s.company_id in (select public.web_my_companies())));

drop policy if exists web_ai_messages_owner_read on public.web_ai_messages;
create policy web_ai_messages_owner_read on public.web_ai_messages for select to authenticated
  using (site_id in (select s.id from public.web_sites s where s.company_id in (select public.web_my_companies())));

drop policy if exists web_assets_owner_read on public.web_assets;
create policy web_assets_owner_read on public.web_assets for select to authenticated
  using (site_id in (select s.id from public.web_sites s where s.company_id in (select public.web_my_companies())));

-- No insert, update or delete policy anywhere: writes are service role only (the edge functions).

-- ============================================================================
-- 4. THE PUBLIC VIEW AND THE HOST LOOKUP
-- ============================================================================

-- Live sites only, published snapshot only. Owned by postgres (bypasses RLS), granted to anon.
-- domain_live: is the custom domain answering yet (domain_status.state = 'live')? The public
-- renderer names the domain in canonical, og:url, sitemap and robots only when this is true;
-- a domain typed but not pointed yet would send Google to a host that does not answer.
-- (A new column on an existing view must come last: create or replace view appends only.)
create or replace view public.web_sites_public as
  select s.slug, s.custom_domain, s.apex_domain, s.published_version_id, v.snapshot,
         coalesce((s.domain_status->>'state') = 'live', false) as domain_live
    from public.web_sites s
    join public.web_site_versions v on v.id = s.published_version_id
   where s.status = 'live';

revoke all on public.web_sites_public from public;
grant select on public.web_sites_public to anon, authenticated, service_role;

-- hostname -> the public row. Case and a trailing dot or port do not matter.
--   www.mozzpizza.com     custom_domain
--   mozzpizza.com         apex_domain
--   mozz.sites.serv-os.app  slug = first label
-- The return shape gained domain_live: a function's return type cannot change in place.
drop function if exists public.web_resolve_host(text);
create or replace function public.web_resolve_host(p_host text)
returns table (slug text, custom_domain text, apex_domain text, published_version_id uuid, snapshot jsonb, domain_live boolean)
language sql
stable
security definer
set search_path = public
as $$
  with h as (
    select regexp_replace(split_part(lower(trim(coalesce(p_host, ''))), ':', 1), '\.$', '') as host
  ),
  k as (
    select host,
           case when host like '%.sites.serv-os.app'
                then split_part(host, '.', 1)
                else null end as free_slug
      from h
  )
  select p.slug, p.custom_domain, p.apex_domain, p.published_version_id, p.snapshot, p.domain_live
    from public.web_sites_public p, k
   where (k.free_slug is not null and p.slug = k.free_slug and k.host = k.free_slug || '.sites.serv-os.app')
      or (k.free_slug is null and k.host <> '' and (p.custom_domain = k.host or p.apex_domain = k.host))
   limit 1
$$;
revoke all on function public.web_resolve_host(text) from public;
grant execute on function public.web_resolve_host(text) to anon, authenticated, service_role;

-- ============================================================================
-- 5. THE COMPANY FENCE FOR THE AI FUNCTION (service role only)
-- ============================================================================

-- The companies p_user may manage. The user signs in on the OPS project, so their venues there
-- (user_locations) are not visible here: the caller reads them with the Ops service role and
-- passes the Ops location ids in p_ops_location_ids; this maps them to Platform companies
-- (ops_location_id first, legacy same id second) and adds any Platform company role or location
-- access the same user id holds. Never callable from a browser.
create or replace function public.web_company_for_user(p_user uuid, p_ops_location_ids uuid[] default null)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select distinct c from (
    select ucr.company_id as c from public.user_company_roles ucr where ucr.user_id = p_user
    union
    select l.company_id from public.user_location_access ula
      join public.locations l on l.id = ula.location_id
     where ula.user_id = p_user
    union
    select l.company_id from public.locations l
     where p_ops_location_ids is not null
       and (l.ops_location_id = any (p_ops_location_ids) or l.id = any (p_ops_location_ids))
  ) x where c is not null
$$;
revoke all on function public.web_company_for_user(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.web_company_for_user(uuid, uuid[]) to service_role;

-- ============================================================================
-- 6. STORAGE BUCKET web-assets (public read, 10 MB, images only)
-- ============================================================================

do $bucket$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('web-assets', 'web-assets', true, 10485760,
            array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif', 'image/x-icon', 'image/vnd.microsoft.icon'])
    on conflict (id) do update
      set public = true,
          file_size_limit = 10485760,
          allowed_mime_types = excluded.allowed_mime_types;

    -- Anyone may read (the public site shows the photos). Writes happen through signed upload
    -- URLs made by website-admin on the service role; no browser role gets insert.
    drop policy if exists web_assets_public_read on storage.objects;
    create policy web_assets_public_read on storage.objects for select to public
      using (bucket_id = 'web-assets');
  end if;
end
$bucket$;

notify pgrst, 'reload schema';

-- ============================================================================
-- VISIBLE CHECK. Expected: 6 tables, all with rls true and forced true, 6 owner read policies,
-- 3 functions, 1 view, bucket web-assets public true, and 0 rows (a fresh install).
-- ============================================================================

select 'tables' as what,
       count(*) as n,
       bool_and(c.relrowsecurity) as rls_on,
       bool_and(c.relforcerowsecurity) as rls_forced
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public'
   and c.relname in ('web_sites', 'web_pages', 'web_posts', 'web_site_versions', 'web_ai_messages', 'web_assets')
union all
select 'policies', count(*), null, null from pg_policies
 where schemaname = 'public' and tablename like 'web\_%'
union all
select 'functions', count(*), null, null from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('web_resolve_host', 'web_company_for_user', 'web_my_companies')
union all
select 'view', count(*), null, null from pg_views where schemaname = 'public' and viewname = 'web_sites_public'
union all
select 'bucket_public', count(*), bool_and(public), null from storage.buckets where id = 'web-assets'
union all
select 'web_sites_rows', count(*), null, null from public.web_sites;
