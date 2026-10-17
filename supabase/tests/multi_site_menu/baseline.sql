-- A throwaway copy of the shape 20261017_OPS_multi_site_menu.sql runs against: the Supabase roles
-- WITH the default privileges production has (new tables and functions granted to anon and
-- authenticated, the trap the migration must undo by name), the auth helpers, the vault, pg_net and
-- pg_cron stand ins, and the menu tables with the LIVE column lists (read 17 Oct 2026).
do $roles$
begin
  if to_regrole('anon') is null then create role anon nologin; end if;
  if to_regrole('authenticated') is null then create role authenticated nologin; end if;
  if to_regrole('service_role') is null then create role service_role nologin bypassrls; end if;
end
$roles$;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role;

create extension if not exists pgcrypto;

create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- vault, pg_net, pg_cron stand ins (same signatures as live)
create schema if not exists vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
create view vault.decrypted_secrets as select id, name, secret as decrypted_secret, description from vault.secrets;
create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null)
returns uuid language sql as $$ insert into vault.secrets (name, secret, description) values (new_name, new_secret, new_description) returning id $$;
create schema if not exists net;
create table net.calls (id bigserial primary key, url text, body jsonb, headers jsonb, at timestamptz default now());
create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000)
returns bigint language sql as $$ insert into net.calls (url, body, headers) values (url, body, headers) returning id $$;
create schema if not exists cron;
create table cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid $$;
create or replace function cron.unschedule(job_id bigint) returns boolean language sql as $$
  delete from cron.job where jobid = job_id returning true $$;

-- the public tables (live column lists)
create table public.organisations (id uuid primary key default gen_random_uuid(), name text, slug text, status text default 'active', created_at timestamptz default now(), updated_at timestamptz default now(), created_by uuid);
create table public.locations (id uuid primary key default gen_random_uuid(), org_id uuid, name text, address text, timezone text, currency text, status text, created_at timestamptz default now(), updated_at timestamptz default now(), default_tax_profile_id uuid);
create table public.user_profiles (id uuid primary key, org_id uuid, location_id uuid, full_name text, role text, email text, bo_access boolean, bo_sections text[]);
create table public.user_locations (id uuid primary key default gen_random_uuid(), user_id uuid, location_id uuid, created_at timestamptz default now(), role text);
create table public.devices (id uuid primary key default gen_random_uuid(), device_uid uuid, location_id uuid, bound_via text, status text, type text);
create table public.ops_devices (id uuid primary key default gen_random_uuid(), device_uid uuid, location_id uuid, active boolean);

create table public.menus (id text primary key, location_id text default 'loc-demo', name text, description text default '', is_default boolean default false, is_active boolean default true, sort_order integer default 0, created_at timestamptz default now(), updated_at timestamptz default now(), schedule jsonb, priority integer default 0, scope text default 'local' check (scope in ('local','shared','global')), org_id uuid references public.organisations(id) on delete cascade);
create table public.menu_categories (id text primary key, location_id text default 'loc-demo', menu_id text references public.menus(id) on delete set null, parent_id text references public.menu_categories(id) on delete cascade, label text, icon text default '🍽', color text default '#3b82f6', accounting_group text default '', sort_order integer default 0, is_special boolean default false, created_at timestamptz default now(), updated_at timestamptz default now(), default_course integer default 1, spacer_slots jsonb default '[]', scope text default 'local' check (scope in ('local','shared','global','override')), org_id uuid references public.organisations(id) on delete cascade, master_id text references public.menu_categories(id) on delete set null, lock_pricing boolean default false, tax_profile_id uuid, image text,
  constraint menu_categories_image_shape check (image is null or (char_length(image) <= 2048 and image ~ '^https://[^/?#]+/storage/v1/object/public/product-images/[^/?#]+/categories/[A-Za-z0-9_-]+-[0-9]+\.(jpg|png|webp)$')));
create table public.menu_category_links (id uuid primary key default gen_random_uuid(), menu_id text references public.menus(id) on delete cascade, category_id text references public.menu_categories(id) on delete cascade, sort_order integer default 0, created_at timestamptz default now(), unique (menu_id, category_id));
create table public.menu_items (id text primary key, location_id text default 'loc-demo', name text, menu_name text, receipt_name text, kitchen_name text, description text default '', type text default 'simple', cat text, cats text[] default '{}', parent_id text, sort_order integer default 0, pricing jsonb default '{"base": 0}', allergens text[] default '{}', assigned_modifier_groups jsonb default '[]', assigned_instruction_groups jsonb default '[]', visibility jsonb default '{"pos": true, "kiosk": true, "online": true}', sold_alone boolean default false, archived boolean default false, created_at timestamptz default now(), updated_at timestamptz default now(), tax_rate_id uuid, tax_overrides jsonb default '{}', centre_id text, image text, scope text default 'local' check (scope in ('local','shared','global','override')), org_id uuid references public.organisations(id) on delete cascade, master_id text references public.menu_items(id) on delete set null, lock_pricing boolean default false, locked_fields jsonb default '[]', tags jsonb default '[]', option_group_order jsonb, tax_profile_id uuid, item_code text check (item_code is null or (length(btrim(item_code)) between 1 and 32)));
create unique index menu_items_item_code_unique on public.menu_items (location_id, upper(btrim(item_code))) where item_code is not null;
create table public.modifier_groups (id text primary key, location_id text default 'loc-demo', name text, min_select integer default 0, max_select integer default 1, sort_order integer default 0, min integer default 0, max integer default 1, selection_type text default 'single', options jsonb default '[]', created_at timestamptz default now());
create table public.config_pushes (id uuid primary key default gen_random_uuid(), location_id text default 'loc-demo', pushed_by text, snapshot jsonb, change_count integer default 0, created_at timestamptz default now());
create table public.activity_events (id uuid primary key default gen_random_uuid(), location_id uuid, kind text, severity text default 'info', title text, body text, ref_type text, ref_id text, actor_name text, acked_at timestamptz, acked_by text, created_at timestamptz default now());
create table public.print_routing (id uuid primary key default gen_random_uuid(), location_id uuid, centres jsonb default '[]', routing jsonb default '{}', updated_at timestamptz default now());
create table public.printers (id text primary key, location_id uuid, name text, type text default 'escpos', connection text default 'network', ip text, port integer default 9100, paper_width integer default 80, meta jsonb default '{}', created_at timestamptz default now(), updated_at timestamptz default now());
create table public.tax_rates (id uuid primary key default gen_random_uuid(), location_id uuid, name text, code text, rate numeric default 0, type text default 'inclusive', applies_to text[] default array['all'], is_default boolean default false, active boolean default true, created_at timestamptz default now());
create table public.tax_profiles (id uuid primary key default gen_random_uuid(), location_id uuid, name text, description text, rounding jsonb, active boolean, sort_order integer, generated_from_rate_id uuid, created_at timestamptz default now(), updated_at timestamptz default now());
create table public.tax_profile_lines (id uuid primary key default gen_random_uuid(), profile_id uuid not null, location_id uuid not null, name text not null, rate numeric not null default 0, flat_amount numeric not null default 0, compound boolean not null default false, taxable boolean not null default false, order_types text[] not null default array['all'], sort_order integer, active boolean);

-- The menu tables as live: anyone may read; writes as today (not under test here).
do $rls$
declare t text;
begin
  foreach t in array array['menus','menu_categories','menu_category_links','menu_items','modifier_groups','config_pushes','activity_events','print_routing','printers','tax_rates','tax_profiles','tax_profile_lines','locations','organisations','user_profiles','user_locations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy allow_all on public.%I for all to public using (true) with check (true)', t);
  end loop;
end
$rls$;

-- helpers, bodies as live (read 17 Oct 2026)
create or replace function public.is_anon_session() returns boolean language sql stable as $$
  select coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false)
$$;
create or replace function public.is_super_admin() returns boolean language sql stable security definer set search_path to 'public' as $$
  select not public.is_anon_session() and coalesce((select role = 'super_admin' from public.user_profiles where id = auth.uid()), false);
$$;
create or replace function public.user_accessible_locations() returns setof text language sql stable security definer set search_path to 'public' as $$
  select ul.location_id::text from public.user_locations ul where ul.user_id = auth.uid() and not public.is_anon_session()
  union select l.id::text from public.locations l where public.is_super_admin()
  union select l.id::text from public.locations l join public.user_profiles p on p.id = auth.uid()
   where not public.is_anon_session() and p.role = 'owner' and p.org_id is not null and l.org_id = p.org_id;
$$;
create or replace function public.accessible_location_ids() returns setof text language sql stable security definer set search_path = public as $$
  select s.k from (
    select public.user_accessible_locations() as k
    union select d.location_id::text from public.devices d where d.device_uid = auth.uid() and d.bound_via is not null and d.status in ('active','online')
    union select o.location_id::text from public.ops_devices o where o.device_uid = auth.uid() and o.active
  ) s where s.k is not null;
$$;
-- The second sign in step stand in: the token's aal claim (aal2) or no person at all.
create or replace function public.second_step_ok() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'aal', '') = 'aal2'
      or auth.uid() is null
$$;
