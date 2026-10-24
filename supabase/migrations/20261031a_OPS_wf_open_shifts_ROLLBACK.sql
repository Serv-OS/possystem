-- 20261031a_OPS_wf_open_shifts_ROLLBACK.sql
-- Puts the Ops database back as it was before 20261031a_OPS_wf_open_shifts.sql.
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand. One transaction: any error and nothing changes. #
-- #  Lock wait 3 s. Run the 5.11.100 web app first (the open shift screens    #
-- #  go with it), then this.                                                  #
-- ############################################################################
--
-- It refuses while any shift has nobody on it (an open shift): staff_id cannot be required again
-- with such a row. Delete or fill those shifts in Back Office first; the refusal says how many.
-- It also refuses while a claim on an open shift has nobody giving it up (from_staff_id empty):
-- those rows are history of this release and go with it only when you say so, by deleting them
-- first (delete from public.wf_swap_requests where from_staff_id is null;).
--
-- What it puts back: the three direct write policies on wf_swap_requests and the anon and
-- authenticated grants as they were (select, insert, update, delete); staff_id and from_staff_id
-- required again. What it drops: the ten functions, the unique index and the status index, the
-- eight request columns and their checks, and wf_staff.payroll_employee_id and ssn_last4 (any
-- values typed into those two are lost).

do $guard$
declare
  v_open int;
  v_claims int;
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('public.wf_shift_claim(uuid,uuid)') is null
     and not exists (select 1 from information_schema.columns c
                      where c.table_schema = 'public' and c.table_name = 'wf_swap_requests' and c.column_name = 'kind') then
    raise exception 'Open shifts (20261031a) is not in this database. Nothing was changed.';
  end if;
  select count(*) into v_open from public.wf_shifts where staff_id is null;
  if v_open > 0 then
    raise exception 'There are % open shift(s) with nobody on them. Delete or fill them in Back Office first. Nothing was changed.', v_open;
  end if;
  select count(*) into v_claims from public.wf_swap_requests where from_staff_id is null;
  if v_claims > 0 then
    raise exception 'There are % claim(s) on open shifts with nobody giving them up. Delete them first (see the note at the top). Nothing was changed.', v_claims;
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

drop function if exists public.wf_swap_decide(uuid, uuid, text, jsonb);
drop function if exists public.wf_swap_decline(uuid, uuid);
drop function if exists public.wf_swap_cancel(uuid, uuid);
drop function if exists public.wf_shift_drop(uuid, uuid, uuid, text);
drop function if exists public.wf_shift_claim(uuid, uuid);
drop function if exists public._wf_shift_snapshot(public.wf_shifts);
drop function if exists public._wf_assign(uuid, uuid);
drop function if exists public._wf_claim_problem(uuid, uuid, uuid, boolean);
drop function if exists public._wf_onboarding_open(uuid, boolean);
drop function if exists public._wf_shift_hours(public.wf_shifts);

drop index if exists public.wf_swap_requests_one_live;
drop index if exists public.wf_swap_requests_loc_status;
alter table public.wf_swap_requests drop constraint if exists wf_swap_requests_kind_check;
alter table public.wf_swap_requests drop constraint if exists wf_swap_requests_status_check;
alter table public.wf_swap_requests drop constraint if exists wf_swap_requests_note_len;
alter table public.wf_swap_requests drop column if exists kind;
alter table public.wf_swap_requests drop column if exists note;
alter table public.wf_swap_requests drop column if exists claimed_at;
alter table public.wf_swap_requests drop column if exists decided_at;
alter table public.wf_swap_requests drop column if exists decided_by_id;
alter table public.wf_swap_requests drop column if exists decided_by_name;
alter table public.wf_swap_requests drop column if exists decided_how;
alter table public.wf_swap_requests drop column if exists shift_snapshot;
alter table public.wf_swap_requests alter column from_staff_id set not null;
comment on column public.wf_swap_requests.status is null;

alter table public.wf_staff drop constraint if exists wf_staff_payroll_employee_id_len;
alter table public.wf_staff drop constraint if exists wf_staff_ssn_last4_check;
alter table public.wf_staff drop column if exists payroll_employee_id;
alter table public.wf_staff drop column if exists ssn_last4;

alter table public.wf_shifts alter column staff_id set not null;
comment on column public.wf_shifts.staff_id is null;

drop policy if exists wf_swap_requests_rls_insert on public.wf_swap_requests;
drop policy if exists wf_swap_requests_rls_update on public.wf_swap_requests;
drop policy if exists wf_swap_requests_rls_delete on public.wf_swap_requests;
create policy wf_swap_requests_rls_insert on public.wf_swap_requests for insert
  with check (location_id::text in (select public.user_accessible_locations()));
create policy wf_swap_requests_rls_update on public.wf_swap_requests for update
  using (location_id::text in (select public.user_accessible_locations()))
  with check (location_id::text in (select public.user_accessible_locations()));
create policy wf_swap_requests_rls_delete on public.wf_swap_requests for delete
  using (location_id::text in (select public.user_accessible_locations()));
grant select, insert, update, delete on public.wf_swap_requests to anon, authenticated;

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: staff_id_required true, from_staff_required true, request_columns_left 0,
-- staff_columns_left 0, judge_functions_left 0, direct_write_policies 3, authenticated_can_write true.
select
  (select is_nullable = 'NO' from information_schema.columns
    where table_schema = 'public' and table_name = 'wf_shifts' and column_name = 'staff_id') as staff_id_required,
  (select is_nullable = 'NO' from information_schema.columns
    where table_schema = 'public' and table_name = 'wf_swap_requests' and column_name = 'from_staff_id') as from_staff_required,
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'wf_swap_requests'
      and column_name in ('kind', 'note', 'claimed_at', 'decided_at', 'decided_by_id', 'decided_by_name', 'decided_how', 'shift_snapshot')) as request_columns_left,
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'wf_staff' and column_name in ('payroll_employee_id', 'ssn_last4')) as staff_columns_left,
  (select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('_wf_shift_hours', '_wf_onboarding_open', '_wf_claim_problem', '_wf_assign', '_wf_shift_snapshot', 'wf_shift_claim',
                      'wf_shift_drop', 'wf_swap_cancel', 'wf_swap_decline', 'wf_swap_decide')) as judge_functions_left,
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'wf_swap_requests'
    and policyname in ('wf_swap_requests_rls_insert', 'wf_swap_requests_rls_update', 'wf_swap_requests_rls_delete')) as direct_write_policies,
  has_table_privilege('authenticated', 'public.wf_swap_requests', 'insert') as authenticated_can_write;
