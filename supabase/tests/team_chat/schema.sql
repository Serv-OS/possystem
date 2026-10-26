-- schema.sql: the live shape of what 20261103a reads, for a throwaway local Postgres. Roles as Supabase
-- has them, with Supabase's default privileges (every new public table granted to anon and
-- authenticated), so the run proves the migration takes those grants away. A supabase_realtime
-- publication and a storage.buckets table as Supabase has them. No data: run.mjs seeds it.

do $roles$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
end
$roles$;
grant anon, authenticated, service_role to authenticator;

create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Supabase's default privileges on the public schema.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

create schema if not exists storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
create publication supabase_realtime;

create table public.organisations (id uuid primary key, name text not null);
create table public.locations (id uuid primary key, org_id uuid, name text not null, timezone text, currency text default 'GBP',
  status text default 'active', constraint locations_id_org_uniq unique (id, org_id));
create table public.user_locations (id uuid primary key default gen_random_uuid(), user_id uuid not null, location_id uuid not null,
  role text not null default 'manager', created_at timestamptz default now());
create table public.user_profiles (id uuid primary key, org_id uuid, location_id uuid, full_name text, role text default 'owner', email text,
  bo_access boolean default true);
create table public.wf_staff (
  id uuid primary key default gen_random_uuid(), org_id uuid not null, location_id uuid not null, name text not null,
  role_key text, status text not null default 'active', venue_ids uuid[] not null default '{}', portal_user_id uuid, mobile text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint wf_staff_id_org_id_key unique (id, org_id), foreign key (location_id, org_id) references public.locations (id, org_id));

-- As live: Back Office logins read their own venues' staff; the tables the migration reads are not opened further here.
alter table public.wf_staff enable row level security;
create policy wf_staff_rls_select on public.wf_staff for select using (location_id in (select ul.location_id from public.user_locations ul where ul.user_id = auth.uid()));
