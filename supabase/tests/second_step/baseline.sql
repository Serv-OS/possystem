-- A throwaway copy of the shape 20260919s_OPS_second_step.sql runs against: the Supabase roles,
-- the auth schema bits it reads, and enough public tables to prove the fence loop and the rules.
-- Roles live in the CLUSTER, not the database, so they are made only once.
do $roles$
begin
  if to_regrole('anon') is null then create role anon nologin; end if;
  if to_regrole('authenticated') is null then create role authenticated nologin; end if;
  if to_regrole('service_role') is null then create role service_role nologin bypassrls; end if;
  if to_regrole('authenticator') is null then create role authenticator noinherit login; end if;
  if to_regrole('supabase_auth_admin') is null then create role supabase_auth_admin nologin; end if;
  grant anon, authenticated, service_role to authenticator;
end
$roles$;
grant usage on schema public to anon, authenticated, service_role, supabase_auth_admin;

-- THE TRAP THIS HARNESS EXISTS TO CATCH (20 Sep 2026). On the live Ops database, schema public
-- carries DEFAULT PRIVILEGES that grant EXECUTE on every NEW function, and the usual rights on
-- every NEW table, to anon, authenticated and service_role (pg_default_acl, defaclobjtype 'f'
-- and 'r'). So a function is callable by the public key the instant it is created, and
-- "revoke all ... from public" does NOT take that away: those are explicit grants to named
-- roles, not the PUBLIC pseudo role. Every migration must revoke from anon and authenticated
-- BY NAME. Without these two lines the harness would be kinder than production, which is how
-- 20260920p reached Peter's SQL editor and stopped on its own self test.
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role;

create schema if not exists auth;
create schema if not exists storage;

create table auth.users (
  id uuid primary key,
  email text,
  is_anonymous boolean not null default false,
  last_sign_in_at timestamptz,
  banned_until timestamptz
);
create table auth.mfa_factors (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  status text not null,
  factor_type text not null,
  created_at timestamptz not null default now()
);
create table auth.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id),
  aal text,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  refreshed_at timestamp
);
create or replace function auth.jwt() returns jsonb
  language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;
grant usage on schema auth to anon, authenticated, service_role, supabase_auth_admin;
grant select on auth.users, auth.mfa_factors, auth.sessions to service_role;

-- the public tables the file touches or reads
create table public.user_profiles (id uuid primary key, email text, role text, location_id uuid, org_id uuid);
create table public.user_locations (user_id uuid, location_id uuid, role text);
create table public.locations (id uuid primary key, name text, org_id uuid);
create table public.organisations (id uuid primary key, name text);
create table public.devices (id uuid primary key, name text, location_id uuid, device_uid uuid, last_seen timestamptz);
create table public.ops_devices (name text, location_id uuid, device_uid uuid, last_seen_at timestamptz);
create table public.waitlist_devices (name text, location_id uuid, device_uid uuid, last_seen_at timestamptz);
create table public.menu_board_screens (name text, location_id uuid, device_uid uuid, last_seen_at timestamptz);
create table public.terminal_devices (label text, serial_number text, location_id uuid, device_uid uuid, last_seen_at timestamptz);
create table public.order_queue (ref text primary key, location_id uuid);
create table public.closed_checks (id text primary key, location_id uuid);
create table public.wf_staff (id uuid primary key, portal_user_id uuid, location_id uuid, status text);
create table public.menu_items (id text primary key, location_id uuid, name text);

-- row level security on, the way the live database has it, so the fence loop has work to do
alter table public.user_profiles enable row level security;
alter table public.user_locations enable row level security;
alter table public.locations enable row level security;
alter table public.organisations enable row level security;
alter table public.devices enable row level security;
alter table public.order_queue enable row level security;
alter table public.closed_checks enable row level security;
alter table public.wf_staff enable row level security;
alter table public.menu_items enable row level security;
create policy allow_all on public.menu_items for all to public using (true) with check (true);
create policy allow_all on public.order_queue for all to public using (true) with check (true);
grant select, insert, update, delete on all tables in schema public to anon, authenticated, service_role;

-- storage.objects, owned by another role in Supabase; here postgres owns it, which is the
-- lucky case: the file's storage fence then really is added (V4 = 1).
create table storage.objects (id uuid primary key, name text);
alter table storage.objects enable row level security;
grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.objects to anon, authenticated, service_role;

-- GoTrue records what each session was authenticated with, one row per method.
create table auth.mfa_amr_claims (
  session_id uuid not null,
  authentication_method text not null,
  created_at timestamptz not null default now(),
  id uuid primary key default gen_random_uuid()
);
grant select on auth.mfa_amr_claims to service_role;
