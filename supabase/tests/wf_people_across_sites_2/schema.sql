-- schema.sql: the live shape (2 Nov 2026) of what 20261031a, 20261104a, 20261111a and 20261112a touch,
-- for a throwaway local Postgres. Built from ../wf_people_across_sites/schema.sql and the tables of
-- ../wf_open_shifts/schema.sql, plus wf_timesheets as live (2 Nov 2026). Copied from ../wf_staff_identity_fence/schema.sql (which proves 20261104a) with the live
-- staff_members columns, its row level security (accessible_location_uuids) and locations.timezone added.
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

create table public.locations (id uuid primary key, org_id uuid not null, name text not null, timezone text default 'America/Denver', currency text default 'GBP', unique (id, org_id));
create table public.user_locations (user_id uuid not null, location_id uuid not null, role text default 'manager' not null, unique (user_id, location_id));
create table public.user_profiles (id uuid primary key, org_id uuid, location_id uuid, full_name text, email text, role text default 'owner');
create table public.staff_members (id uuid primary key default gen_random_uuid(), location_id uuid, org_id uuid, name text not null,
  role text, pin text not null, color text, initials text, active boolean default true, created_at timestamptz default now(),
  permissions jsonb default '[]'::jsonb, nfc_card_id text, auth_method text default 'pin', auth_user_id uuid);

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
create function public.accessible_location_uuids() returns setof uuid language sql stable security definer set search_path = public as $$
  select x::uuid from public.user_accessible_locations() as x
$$;
revoke all on function public.user_accessible_locations(), public.user_accessible_orgs(), public.second_step_ok() from public;
grant execute on function public.accessible_location_uuids() to anon, authenticated, service_role;
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

grant select on public.locations, public.user_locations, public.user_profiles to anon, authenticated, service_role;
-- staff_members as live: row level security by venue, every grant to the API roles.
alter table public.staff_members enable row level security;
grant delete, insert, references, select, trigger, truncate, update on table public.staff_members to anon, authenticated, service_role;
create policy staff_members_tenant on public.staff_members for all
  using (location_id in (select public.accessible_location_uuids())) with check (location_id in (select public.accessible_location_uuids()));
create policy second_step_fence on public.staff_members as restrictive for all to authenticated using ((select public.second_step_ok())) with check ((select public.second_step_ok()));
grant select on public.chat_sync_log to anon, authenticated, service_role;

-- From ../wf_open_shifts/schema.sql (the tables 20261031a touches).
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
create table public.wf_onboarding (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, org_id uuid not null, staff_id uuid not null,
  role_key text, steps jsonb not null default '[]'::jsonb, status text not null default 'inProgress', meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now());
create table public.wf_venue_settings (location_id uuid primary key, org_id uuid not null, settings jsonb not null default '{}'::jsonb);

-- The touch trigger live has on wf_swap_requests and wf_shifts.
create function public.wf_touch() returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;
create trigger trg_wf_swap_requests_touch before update on public.wf_swap_requests for each row execute function public.wf_touch();
create trigger trg_wf_shifts_touch before update on public.wf_shifts for each row execute function public.wf_touch();


-- wf_timesheets as live (2 Nov 2026): the columns the reports and the recompute read.
create table public.wf_timesheets (
  id uuid primary key default gen_random_uuid(), location_id uuid not null, org_id uuid not null, shift_id uuid, staff_id uuid not null,
  clock_in timestamptz not null, clock_out timestamptz, break_taken integer, scheduled_hours numeric, actual_hours numeric,
  variance numeric, effective_rate numeric, rate_source text, currency character(3), pay_amount numeric, status text default 'pending',
  approved_by uuid, approved_at timestamptz, created_at timestamptz default now(), updated_at timestamptz default now(),
  paid_break_mins integer default 0, payroll_run_id uuid);
create trigger trg_wf_timesheets_touch before update on public.wf_timesheets for each row execute function public.wf_touch();
alter table public.wf_timesheets enable row level security;
alter table public.wf_timesheets force row level security;
grant select, insert, update, delete on public.wf_timesheets to anon, authenticated;
grant all on public.wf_timesheets to service_role;
create policy wf_timesheets_rls_select on public.wf_timesheets for select using (location_id::text in (select public.user_accessible_locations()));
create policy wf_timesheets_rls_insert on public.wf_timesheets for insert with check (location_id::text in (select public.user_accessible_locations()));
create policy wf_timesheets_rls_update on public.wf_timesheets for update using (location_id::text in (select public.user_accessible_locations())) with check (location_id::text in (select public.user_accessible_locations()));
create policy wf_timesheets_super_admin_all on public.wf_timesheets for all using ((select public.is_super_admin())) with check ((select public.is_super_admin()));

do $rls$
declare t text;
begin
  foreach t in array array['wf_roles', 'wf_shifts', 'wf_swap_requests', 'wf_time_off', 'wf_availability', 'wf_venue_settings', 'wf_onboarding'] loop
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

-- Stand ins for the stock clock helpers (20261021a) that stock_rp__labour reads: the venue's zone
-- from locations, a 06:00 day start. Enough to prove the labour sum adds the overtime premium.
create function public.stock_co__clock_of(p_site uuid) returns table(timezone text, day_start time, clock_known boolean)
language sql stable as $$ select coalesce(l.timezone, 'UTC'), time '06:00', true from public.locations l where l.id = p_site $$;
create function public.stock_co__day_start_at(p_day date, p_start time, p_tz text) returns timestamptz
language sql stable as $$ select (p_day + p_start) at time zone p_tz $$;
create function public.stock_co__venue_day(p_location uuid, p_at timestamptz) returns table(business_day date, clock_known boolean)
language sql stable as $$ select ((p_at at time zone coalesce((select timezone from public.locations where id = p_location), 'UTC')) - interval '6 hours')::date, true $$;
