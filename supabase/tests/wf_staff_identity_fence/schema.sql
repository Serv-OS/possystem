-- schema.sql: the live shape (27 Oct 2026, from 000_baseline_ops.sql plus 20260608, 20260806f, 20260806j,
-- 20260919s, 20260921u and 20261031a) of what 20261104a touches, for a throwaway local Postgres.
-- Roles as Supabase has them. wf_staff: the org scoped policies, the super admin policy, the
-- restrictive second step fence, anon and authenticated with every grant (as live), the touch
-- trigger, the 20260806j portal guard and the unique portal_user_id index. wf_audit: insert and
-- select only for the API roles. A stand in for 5.11.102's chat sync trigger, so the proof shows
-- the two triggers live side by side. No data: run.mjs seeds it.

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
create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase gives every new public function EXECUTE to the API roles by default; the migration must revoke what it hides.
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;

create table public.locations (id uuid primary key, org_id uuid not null, name text not null, unique (id, org_id));
create table public.user_locations (user_id uuid not null, location_id uuid not null, role text default 'manager' not null, unique (user_id, location_id));
create table public.user_profiles (id uuid primary key, org_id uuid, location_id uuid, full_name text, email text, role text default 'owner');
create table public.staff_members (id uuid primary key default gen_random_uuid(), location_id uuid, org_id uuid, name text not null,
  pin text not null, active boolean default true, auth_user_id uuid);

create function public.is_anon_session() returns boolean language sql stable as $$
  select coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false)
$$;
create function public.is_super_admin() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role = 'super_admin' from public.user_profiles where id = auth.uid()), false)
$$;
-- 20260921u: venue links, every venue for a super admin, every venue of their own company for an owner.
create function public.user_accessible_locations() returns setof text language sql stable security definer set search_path = public as $$
  select ul.location_id::text from public.user_locations ul where ul.user_id = auth.uid() and not public.is_anon_session()
  union
  select l.id::text from public.locations l where public.is_super_admin()
  union
  select l.id::text from public.locations l join public.user_profiles p on p.id = auth.uid()
   where not public.is_anon_session() and p.role = 'owner' and p.org_id is not null and l.org_id = p.org_id
$$;
create function public.user_accessible_orgs() returns setof text language sql stable security definer set search_path = public as $$
  select distinct l.org_id::text from public.locations l where l.org_id is not null and l.id::text in (select public.user_accessible_locations())
$$;
-- The second step: true unless the test sets test.second_step to fail in the same transaction.
create function public.second_step_ok() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(current_setting('test.second_step', true), '') <> 'fail'
$$;
revoke all on function public.user_accessible_locations(), public.user_accessible_orgs(), public.second_step_ok() from public;
grant execute on function public.is_anon_session(), public.is_super_admin(), public.user_accessible_locations(), public.user_accessible_orgs(), public.second_step_ok() to anon, authenticated, service_role;

create table public.wf_staff (
  id uuid primary key default gen_random_uuid(), org_id uuid not null, location_id uuid not null, name text not null,
  photo_url text, role_key text, section_ids uuid[] default '{}'::uuid[] not null, primary_venue_id uuid,
  venue_ids uuid[] default '{}'::uuid[] not null, contract_type text default 'partTime' not null, contracted_week numeric(5,2),
  weekly_hours_target numeric(6,2), holiday_entitlement_days numeric(5,2), rate_override numeric(10,2), dob date, ni_number text,
  tax_ref text, bank_sort_code text, bank_account_masked text, address text, emergency_contact jsonb, mobile text, email text,
  right_to_work jsonb default '{"status": "missing"}'::jsonb not null, start_date date, status text default 'active' not null,
  leaver_date date, pos_user_id uuid, notes text, created_at timestamptz default now() not null, updated_at timestamptz default now() not null,
  bank_account text, bank_account_name text,
  portal_user_id uuid, portal_invite_hash text, portal_invite_expires timestamptz,
  payroll_employee_id text, ssn_last4 text,
  unique (id, org_id), foreign key (location_id, org_id) references public.locations (id, org_id));
create unique index idx_wf_staff_portal_user on public.wf_staff (portal_user_id) where portal_user_id is not null;
create index idx_wf_staff_pos on public.wf_staff (pos_user_id);

create table public.wf_audit (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, org_id uuid not null, actor_id uuid, actor_name text,
  action text not null, entity text, entity_id text, amount numeric(12,2), currency char(3), reason text, before jsonb, after jsonb,
  prev_hash text, row_hash text, at timestamptz default now() not null,
  foreign key (location_id, org_id) references public.locations (id, org_id));

create function public.wf_touch_updated_at() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
create trigger trg_wf_staff_touch before update on public.wf_staff for each row execute function public.wf_touch_updated_at();

-- 20260806j, as live.
create or replace function public.wf_staff_block_portal_cols()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('request.jwt.claims', true)::json->>'role', '') = 'service_role' then
    return new;
  end if;
  if new.portal_user_id is distinct from old.portal_user_id
     or new.portal_invite_hash is distinct from old.portal_invite_hash
     or new.portal_invite_expires is distinct from old.portal_invite_expires then
    raise exception 'portal_user_id / portal_invite_* are managed by the staff-portal service and cannot be set directly';
  end if;
  return new;
end $$;
create trigger wf_staff_block_portal_cols_trg before update on public.wf_staff for each row execute function public.wf_staff_block_portal_cols();

-- A stand in for 5.11.102's trg_wf_staff_chat_sync (20261103a): after insert or update of the same columns.
create table public.chat_sync_log (staff_id uuid, op text, at timestamptz default clock_timestamp());
create function public._chat_staff_changed() returns trigger language plpgsql security definer set search_path = public as $$
begin insert into public.chat_sync_log (staff_id, op) values (new.id, tg_op); return new; end $$;
create trigger trg_wf_staff_chat_sync after insert or update of status, location_id, venue_ids, name, role_key, portal_user_id
  on public.wf_staff for each row execute function public._chat_staff_changed();

-- RLS and grants as live.
alter table public.wf_staff enable row level security;
alter table public.wf_staff force row level security;
grant delete, insert, references, select, trigger, truncate, update on table public.wf_staff to anon, authenticated, service_role;
create policy wf_staff_rls_select on public.wf_staff for select using (org_id::text in (select public.user_accessible_orgs()));
create policy wf_staff_rls_insert on public.wf_staff for insert with check (org_id::text in (select public.user_accessible_orgs()));
create policy wf_staff_rls_update on public.wf_staff for update using (org_id::text in (select public.user_accessible_orgs())) with check (org_id::text in (select public.user_accessible_orgs()));
create policy wf_staff_rls_delete on public.wf_staff for delete using (org_id::text in (select public.user_accessible_orgs()));
create policy wf_staff_super_admin_all on public.wf_staff for all using (public.is_super_admin()) with check (public.is_super_admin());
create policy second_step_fence on public.wf_staff as restrictive for all to authenticated using ((select public.second_step_ok())) with check ((select public.second_step_ok()));

alter table public.wf_audit enable row level security;
alter table public.wf_audit force row level security;
grant insert, references, select, trigger on table public.wf_audit to anon, authenticated;
grant delete, insert, references, select, trigger, truncate, update on table public.wf_audit to service_role;
create policy wf_audit_rls_insert on public.wf_audit for insert with check (location_id::text in (select public.user_accessible_locations()));
create policy wf_audit_rls_select on public.wf_audit for select using (location_id::text in (select public.user_accessible_locations()));
create policy wf_audit_super_admin_select on public.wf_audit for select using (public.is_super_admin());
create policy second_step_fence on public.wf_audit as restrictive for all to authenticated using ((select public.second_step_ok())) with check ((select public.second_step_ok()));

grant select on public.locations, public.user_locations, public.user_profiles, public.staff_members to anon, authenticated, service_role;
grant select on public.chat_sync_log to anon, authenticated, service_role;
