-- 20261121a_OPS_wf_private_docs_rates.sql (5.12.59, Peter's decisions 2.4 and 2.5, 4 Nov 2026). Run in
-- the Ops SQL editor AFTER 20261120a and AFTER the 5.12.59 Back Office is live (it reads rates through
-- the door below and falls back to the old column read while this has not run). ASCII only on purpose.
--
-- The same door as staff ID numbers and bank details (wf_can_see_payroll_details: owners, admins and
-- logins with Can see payroll details, past the second step) now also decides:
--
--   1. Identity document FILES in the private wf-documents bucket (right to work: passports, visas,
--      I-9 papers; uploaded as <location>/<staff>/RTW-<stamp>.<ext>). Before this any login of the
--      venue could open them. The wf_documents ROWS (type, expiry, verified) stay readable, so
--      compliance tracking still works; only the image or PDF needs the door. Training materials and
--      every other document type read exactly as before.
--   2. Pay rate overrides (wf_staff.rate_override). Before this every login of the company could read
--      every record's rate at every site (the Sites panel showed them). Now the column loses its API
--      read and wf_staff_rates(location) answers rates for a site the login is assigned to, or for any
--      site in the company when the door is open. The site's own payroll and timesheets keep working
--      (a manager reads their own site's rates); other sites' rates read as Hidden.
--
-- Edge functions (service role) are not touched.

begin;
set local lock_timeout = '3s';

do $g$
begin
  if to_regclass('public.billing_state') is not null then
    raise exception 'This is the Platform database. Run 20261121a in Ops (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('public.wf_can_see_payroll_details(uuid)') is null or to_regprocedure('public.wf_staff_regrant_select()') is null then
    raise exception 'Run 20261120a first. Nothing was changed.';
  end if;
end
$g$;

-- -- 0. The door by site (for storage rules and the rates door) -------------------------------------
create or replace function public.wf_can_see_payroll_details_at(p_location text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
begin
  if p_location is null or p_location = '' then
    return false;
  end if;
  select l.org_id into v_org from public.locations l where l.id::text = p_location;
  if v_org is null then
    return false;
  end if;
  return public.wf_can_see_payroll_details(v_org);
end
$fn$;
revoke all on function public.wf_can_see_payroll_details_at(text) from public, anon;
grant execute on function public.wf_can_see_payroll_details_at(text) to authenticated, service_role;

-- -- 1. Identity document files need the door ----------------------------------------------------------
-- Identity file names start with one of these (uploadWfDocument writes <type>-<stamp>.<ext>).
create or replace function public.wf_is_identity_doc(p_name text)
returns boolean
language sql
immutable
as $fn$
  select coalesce(p_name, '') ~ '(^|/)(RTW|rtw|I9|i9|passport|visa|id)-[0-9]+\.[A-Za-z0-9]+$'
$fn$;
revoke all on function public.wf_is_identity_doc(text) from public;
grant execute on function public.wf_is_identity_doc(text) to anon, authenticated, service_role;

-- objects.name on purpose (a bare name inside a subquery binds to that table's column, 28 Sep 2026).
drop policy if exists wf_docs_select on storage.objects;
create policy wf_docs_select on storage.objects for select to authenticated
  using (
    bucket_id = 'wf-documents'
    and (storage.foldername(objects.name))[1] in (select public.user_accessible_locations())
    and (
      not public.wf_is_identity_doc(objects.name)
      or public.wf_can_see_payroll_details_at((storage.foldername(objects.name))[1])
    )
  );

-- -- 2. Pay rate overrides lose their API read ----------------------------------------------------------
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
     and c.column_name not in ('ni_number', 'ssn_last4', 'tax_ref', 'bank_sort_code', 'bank_account', 'bank_account_name', 'rate_override');
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
  'Grants SELECT on every wf_staff column except the six private details and rate_override to anon and authenticated. Called by wf_staff_regrant_api (20261120a, 20261121a).';

select public.wf_staff_regrant_select() as columns_readable;

-- The one door that reads rates: a site the login is assigned to, or any site of a company where the
-- payroll door is open. Past the second step only. Any other site is refused (42501, Hidden), so the
-- screen can tell Hidden from no override.
create or replace function public.wf_staff_rates(p_location uuid)
returns table (staff_id uuid, rate_override numeric)
language plpgsql
stable
security definer
set search_path = public, pg_temp as $f$
declare
  v_uid uuid := auth.uid();
begin
  if p_location is null or v_uid is null or public.is_anon_session() then
    return;
  end if;
  if not public.second_step_ok() then
    return;
  end if;
  if not (p_location::text in (select public.user_accessible_locations())
          or public.wf_can_see_payroll_details_at(p_location::text)) then
    raise exception 'Hidden (owner, admin or payroll details access only)' using errcode = '42501';
  end if;
  return query
    select s.id, s.rate_override
      from public.wf_staff s
     where s.location_id = p_location
       and s.rate_override is not null;
end
$f$;
revoke all on function public.wf_staff_rates(uuid) from public, anon;
grant execute on function public.wf_staff_rates(uuid) to authenticated, service_role;
comment on function public.wf_staff_rates(uuid) is
  'The only API read of wf_staff.rate_override: a site the login is assigned to, or any site of the company when wf_can_see_payroll_details is true (20261121a).';

notify pgrst, 'reload schema';

commit;

-- VISIBLE CHECK: one row. rate_readable must be false, rates_door and docs_rule true.
select has_column_privilege('authenticated', 'public.wf_staff', 'rate_override', 'SELECT') as rate_readable,
       to_regprocedure('public.wf_staff_rates(uuid)') is not null as rates_door,
       exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'wf_docs_select' and qual like '%wf_is_identity_doc%') as docs_rule;
