-- 20261120a_OPS_wf_staff_private_details.sql (5.12.57, US basics batch 2). Run in the Ops SQL editor
-- AFTER the 5.12.57 Back Office is live (it reads the private details through the door below and only
-- falls back to the old direct read while this has not run). ASCII only on purpose.
--
-- Peter, 3 Nov 2026: staff ID numbers and bank details must not be seen by people who should not see
-- them. Before this, every Back Office login of a company (any manager) could read every staff
-- member's National Insurance number, SSN last 4, tax reference, bank sort code, account number and
-- account name straight from the table (the policies only fence the company, and a till's anonymous
-- session had the table read too). His decision: owners, admins, and a login given the new
-- "Can see payroll details" tick (Back Office, Team) see them; nobody else, enforced here.
--
--   1. user_profiles.payroll_details (boolean, false): the tick. Only the owner of the login's company
--      (or ServOS staff) changes it, through set_payroll_details; a guard refuses any other change.
--   2. wf_can_see_payroll_details(org): who may see them in a company (ServOS staff, the company owner,
--      an owner or admin at one of its venues, or a login of the company with the tick), past the
--      Back Office second step.
--   3. The six private columns lose their API read (anon and authenticated). Every other column keeps
--      it, granted one by one; wf_staff_regrant_api() now also re-grants the reads, so a column added
--      later stays readable (and the private six stay closed).
--   4. wf_staff_private_details(ids): the one door that reads them, only for staff in companies where
--      the caller may see them. Edge functions (service role) are not touched.

begin;
set local lock_timeout = '3s';

do $g$
begin
  if to_regclass('public.billing_state') is not null then
    raise exception 'This is the Platform database. Run 20261120a in Ops (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('public.wf_staff_regrant_api()') is null or to_regprocedure('public.second_step_ok()') is null then
    raise exception 'Run 20261104a, 20261111a and the second step migration first. Nothing was changed.';
  end if;
end
$g$;

-- -- 1. The tick ---------------------------------------------------------------------------------
alter table public.user_profiles add column if not exists payroll_details boolean not null default false;
comment on column public.user_profiles.payroll_details is
  'Can see payroll details (staff ID numbers and bank details). Set by the company owner only, through set_payroll_details (20261120a).';

create or replace function public.user_profiles_payroll_details_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_api_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  if v_api_role not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.payroll_details is not true then
      return new;
    end if;
  elsif new.payroll_details is not distinct from old.payroll_details then
    return new;
  end if;
  -- The pass set by set_payroll_details for this transaction only.
  if coalesce(current_setting('servos.payroll_details_write', true), '') = txid_current()::text then
    return new;
  end if;
  if coalesce(public.is_super_admin(), false) then
    return new;
  end if;
  raise exception 'Can see payroll details is set by the owner, in Back Office, Team.' using errcode = '42501';
end
$fn$;

drop trigger if exists user_profiles_payroll_details_guard on public.user_profiles;
create trigger user_profiles_payroll_details_guard before insert or update on public.user_profiles
  for each row execute function public.user_profiles_payroll_details_guard();

create or replace function public.set_payroll_details(p_user uuid, p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid     uuid := auth.uid();
  v_super   boolean;
  v_me_role text;
  v_me_org  uuid;
  v_role    text;
  v_org     uuid;
  v_rows    integer;
begin
  if v_uid is null or public.is_anon_session() then
    raise exception 'Sign in to Back Office to change who can see payroll details.' using errcode = '42501';
  end if;
  if not public.second_step_ok() then
    raise exception 'Finish your second sign in step first.' using errcode = '42501';
  end if;
  if p_user is null or p_on is null then
    raise exception 'Pick a login and on or off.' using errcode = '22023';
  end if;
  if p_user = v_uid then
    raise exception 'You cannot change this for your own login.' using errcode = '42501';
  end if;
  v_super := coalesce(public.is_super_admin(), false);   -- never a null that skips the owner check
  select p.role, p.org_id into v_me_role, v_me_org from public.user_profiles p where p.id = v_uid;
  if not v_super and (v_me_role is distinct from 'owner' or v_me_org is null) then
    raise exception 'Only the owner can change who can see payroll details.' using errcode = '42501';
  end if;
  select p.role, p.org_id into v_role, v_org from public.user_profiles p where p.id = p_user for update;
  if not found or (not v_super and v_org is distinct from v_me_org) then
    raise exception 'That login is not in your company.' using errcode = '42501';
  end if;
  if lower(coalesce(v_role, '')) in ('owner', 'super_admin') then
    raise exception 'An owner always sees payroll details.' using errcode = '42501';
  end if;
  perform set_config('servos.payroll_details_write', txid_current()::text, true);
  update public.user_profiles set payroll_details = p_on, updated_at = now() where id = p_user;
  get diagnostics v_rows = row_count;
  perform set_config('servos.payroll_details_write', '', true);
  if v_rows <> 1 then
    raise exception 'That login could not be changed.' using errcode = '42501';
  end if;
  return jsonb_build_object('ok', true, 'user', p_user, 'payroll_details', p_on);
end
$fn$;
revoke all on function public.set_payroll_details(uuid, boolean) from public, anon;
grant execute on function public.set_payroll_details(uuid, boolean) to authenticated, service_role;

-- -- 2. Who may see them ---------------------------------------------------------------------------
create or replace function public.wf_can_see_payroll_details(p_org uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if p_org is null or v_uid is null or public.is_anon_session() then
    return false;
  end if;
  if not public.second_step_ok() then
    return false;
  end if;
  if coalesce(public.is_super_admin(), false) then
    return true;
  end if;
  return exists (select 1 from public.user_profiles p
                  where p.id = v_uid and p.org_id = p_org
                    and (p.role = 'owner' or p.payroll_details is true))
      or exists (select 1 from public.user_locations ul
                   join public.locations l on l.id = ul.location_id
                  where ul.user_id = v_uid and l.org_id = p_org
                    and lower(coalesce(ul.role, '')) in ('owner', 'admin'));
end
$fn$;
revoke all on function public.wf_can_see_payroll_details(uuid) from public, anon;
grant execute on function public.wf_can_see_payroll_details(uuid) to authenticated, service_role;

-- -- 3. The private columns lose their API read -----------------------------------------------------
create or replace function public.wf_staff_regrant_select()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  v_cols text;
  v_n integer;
begin
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position), count(*)
    into v_cols, v_n
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'wf_staff'
     and c.column_name not in ('ni_number', 'ssn_last4', 'tax_ref', 'bank_sort_code', 'bank_account', 'bank_account_name');
  if v_n is null or v_n = 0 then
    raise exception 'wf_staff has no columns to grant';
  end if;
  revoke select on table public.wf_staff from anon, authenticated;
  execute format('grant select (%s) on table public.wf_staff to anon, authenticated', v_cols);
  return v_n;
end
$f$;
revoke all on function public.wf_staff_regrant_select() from public, anon, authenticated, service_role;
comment on function public.wf_staff_regrant_select() is
  'Grants SELECT on every wf_staff column except the six private details (ni_number, ssn_last4, tax_ref, bank_sort_code, bank_account, bank_account_name) to anon and authenticated. Called by wf_staff_regrant_api (20261120a).';

-- wf_staff_regrant_api exactly as 20261111a left it, and then the reads.
create or replace function public.wf_staff_regrant_api()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp as $f$
declare
  v_cols text;
  v_n integer;
begin
  select string_agg(quote_ident(c.column_name), ', ' order by c.ordinal_position), count(*)
    into v_cols, v_n
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'wf_staff'
     and c.column_name not in ('portal_user_id', 'pos_user_id', 'portal_invite_hash', 'portal_invite_expires', 'person_id');
  if v_n is null or v_n = 0 then
    raise exception 'wf_staff has no columns to grant';
  end if;
  execute format('grant insert (%s), update (%s) on table public.wf_staff to authenticated', v_cols, v_cols);
  perform public.wf_staff_regrant_select();
  return v_n;
end
$f$;
revoke all on function public.wf_staff_regrant_api() from public, anon, authenticated, service_role;

select public.wf_staff_regrant_select() as columns_readable;

-- -- 4. The one door that reads them ----------------------------------------------------------------
create or replace function public.wf_staff_private_details(p_staff_ids uuid[])
returns table (staff_id uuid, ni_number text, ssn_last4 text, tax_ref text, bank_sort_code text, bank_account text, bank_account_name text)
language plpgsql
stable
security definer
set search_path = public, pg_temp as $f$
begin
  if p_staff_ids is null or coalesce(array_length(p_staff_ids, 1), 0) = 0 then
    return;
  end if;
  if array_length(p_staff_ids, 1) > 2000 then
    raise exception 'Ask for at most 2000 people at once.' using errcode = '22023';
  end if;
  return query
    select s.id, s.ni_number::text, s.ssn_last4::text, s.tax_ref::text, s.bank_sort_code::text, s.bank_account::text, s.bank_account_name::text
      from public.wf_staff s
     where s.id = any (p_staff_ids)
       and s.org_id::text in (select public.user_accessible_orgs())
       and public.wf_can_see_payroll_details(s.org_id);
end
$f$;
revoke all on function public.wf_staff_private_details(uuid[]) from public, anon;
grant execute on function public.wf_staff_private_details(uuid[]) to authenticated, service_role;
comment on function public.wf_staff_private_details(uuid[]) is
  'The only API read of staff ID numbers and bank details: rows only for companies where wf_can_see_payroll_details is true (20261120a).';

notify pgrst, 'reload schema';

commit;

-- VISIBLE CHECK: one row. private_readable must be false, door_ready and tick_ready true.
select has_column_privilege('authenticated', 'public.wf_staff', 'ni_number', 'SELECT') as private_readable,
       to_regprocedure('public.wf_staff_private_details(uuid[])') is not null as door_ready,
       exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'user_profiles' and column_name = 'payroll_details') as tick_ready;
