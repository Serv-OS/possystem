-- schema.sql: the live shape (24 Oct 2026, read with read_only:true) of what 20261031a touches, for a
-- throwaway local Postgres. Roles as Supabase has them. Grants and policies on wf_swap_requests as
-- live: anon and authenticated arwd, the four location policies, the super admin policy and the
-- restrictive second step fence. No data: run.mjs seeds it.

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

create table public.locations (id uuid primary key, org_id uuid not null, name text not null, timezone text, currency text default 'GBP',
  unique (id, org_id));
create table public.user_locations (user_id uuid not null, location_id uuid not null, role text default 'manager');
create table public.user_profiles (id uuid primary key, role text);

create function public.user_accessible_locations() returns setof text language sql stable security definer set search_path = public as $$
  select location_id::text from public.user_locations where user_id = auth.uid()
$$;
create function public.is_super_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_profiles where id = auth.uid() and role = 'super_admin')
$$;
create function public.second_step_ok() returns boolean language sql stable security definer set search_path = public as $$ select true $$;
revoke all on function public.user_accessible_locations() from public;
revoke all on function public.second_step_ok() from public;
grant execute on function public.user_accessible_locations() to anon, authenticated, service_role;
grant execute on function public.is_super_admin() to anon, authenticated, service_role;
grant execute on function public.second_step_ok() to anon, authenticated, service_role;

create table public.wf_staff (
  id uuid primary key default gen_random_uuid(), org_id uuid not null, location_id uuid not null, name text not null,
  role_key text, status text not null default 'active', rate_override numeric(10,4), mobile text,
  bank_account_masked text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, org_id), foreign key (location_id, org_id) references public.locations (id, org_id));
create table public.wf_roles (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, org_id uuid not null, key text not null,
  label text, base_rate numeric(10,4), salary_annual numeric(12,2), contracted_week numeric(5,2) default 40);
create table public.wf_shifts (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, org_id uuid not null, staff_id uuid not null,
  role_key text, section_id uuid, section text, shift_date date not null, start_time time not null, finish_time time not null,
  break_mins integer not null default 0 check (break_mins >= 0), status text not null default 'draft', note text,
  premiums_applied jsonb not null default '[]'::jsonb, effective_rate numeric(10,4), rate_source text,
  currency character(3) not null default 'GBP', computed_hours numeric(6,2), computed_cost numeric(10,2),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (id, org_id), foreign key (location_id, org_id) references public.locations (id, org_id),
  foreign key (staff_id, org_id) references public.wf_staff (id, org_id) on delete restrict);
create table public.wf_swap_requests (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, org_id uuid not null, shift_id uuid,
  from_staff_id uuid not null, to_staff_id uuid, status text not null default 'open', coverage_ok boolean,
  eligibility_checks jsonb not null default '[]'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key (location_id, org_id) references public.locations (id, org_id),
  foreign key (from_staff_id, org_id) references public.wf_staff (id, org_id) on delete restrict,
  foreign key (to_staff_id, org_id) references public.wf_staff (id, org_id) on delete set null (to_staff_id),
  foreign key (shift_id, org_id) references public.wf_shifts (id, org_id) on delete set null (shift_id));
create index idx_wf_swap_shift on public.wf_swap_requests (shift_id);
create table public.wf_time_off (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, org_id uuid not null, staff_id uuid not null,
  type text not null default 'holiday', start_date date not null, end_date date not null, days numeric, status text not null default 'pending');
create table public.wf_availability (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, org_id uuid not null, staff_id uuid not null,
  week_start date, recurring boolean not null default true, per_day jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.wf_venue_settings (location_id uuid primary key, org_id uuid not null, settings jsonb not null default '{}'::jsonb);

-- The touch trigger live has on wf_swap_requests and wf_shifts.
create function public.wf_touch() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
create trigger trg_wf_swap_requests_touch before update on public.wf_swap_requests for each row execute function public.wf_touch();
create trigger trg_wf_shifts_touch before update on public.wf_shifts for each row execute function public.wf_touch();

-- RLS and grants as live.
do $rls$
declare t text;
begin
  foreach t in array array['wf_staff', 'wf_roles', 'wf_shifts', 'wf_swap_requests', 'wf_time_off', 'wf_availability', 'wf_venue_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('grant select, insert, update, delete on public.%I to anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format($p$create policy %1$s_rls_select on public.%1$s for select using (location_id::text in (select public.user_accessible_locations()))$p$, t);
    execute format($p$create policy %1$s_rls_insert on public.%1$s for insert with check (location_id::text in (select public.user_accessible_locations()))$p$, t);
    execute format($p$create policy %1$s_rls_update on public.%1$s for update using (location_id::text in (select public.user_accessible_locations())) with check (location_id::text in (select public.user_accessible_locations()))$p$, t);
    execute format($p$create policy %1$s_rls_delete on public.%1$s for delete using (location_id::text in (select public.user_accessible_locations()))$p$, t);
    execute format($p$create policy %1$s_super_admin_all on public.%1$s for all using ((select public.is_super_admin())) with check ((select public.is_super_admin()))$p$, t);
    execute format($p$create policy second_step_fence on public.%1$s as restrictive for all to authenticated using ((select public.second_step_ok())) with check ((select public.second_step_ok()))$p$, t);
  end loop;
end
$rls$;
grant select on public.locations to anon, authenticated, service_role;
