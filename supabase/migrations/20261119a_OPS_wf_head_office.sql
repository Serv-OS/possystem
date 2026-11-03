-- 20261119a_OPS_wf_head_office.sql (5.12.56). Run in the Ops SQL editor BEFORE merging 5.12.56 and
-- deploying workforce-clock, workforce-compute, staff-portal and owner-snapshot. ASCII only on purpose.
--
-- Head office staff (UK and US). Peter, 3 Nov 2026: head office staff do not clock in, their cost is
-- never shared across the sites, and head office is a tick on the person (not a site of its own).
--   head_office    the person is head office at their site (counts only while Workforce settings,
--                  Head office staff, is on). Paid their salary each pay period with no timesheets,
--                  refused at clock in, left off the rota, left out of the site's labour and labour %,
--                  shown as its own Head office line in the Owner app company view.
--   salary_annual  their salary for a year, in the venue's money. Paid per period by
--                  _shared/headOffice.js headOfficePay.
-- Written by the Back Office staff form (wf_staff's existing policies, nothing new opened). The two
-- columns are granted to the API with public.wf_staff_regrant_api() (20261104a fence: a new wf_staff
-- column is not writable from the Back Office until it is called). The identity columns stay fenced.

begin;
set local lock_timeout = '3s';

do $g$
begin
  if to_regclass('public.billing_state') is not null then
    raise exception 'This is the Platform database. Run 20261119a in Ops (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('public.wf_staff_regrant_api()') is null then
    raise exception 'Run 20261104a and 20261111a first (wf_staff_regrant_api is missing). Nothing was changed.';
  end if;
end
$g$;

alter table public.wf_staff
  add column if not exists head_office boolean not null default false,
  add column if not exists salary_annual numeric(12,2);

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'wf_staff_salary_annual_range') then
    alter table public.wf_staff add constraint wf_staff_salary_annual_range
      check (salary_annual is null or (salary_annual >= 0 and salary_annual <= 10000000));
  end if;
end
$c$;

comment on column public.wf_staff.head_office is
  'Head office staff (5.12.56): salaried, no clock in, no rota, out of the site labour %. Needs settings.headOffice.';
comment on column public.wf_staff.salary_annual is
  'Annual salary for head office pay (5.12.56), venue currency. Null = not set (nothing is paid).';

-- Let the Back Office write the two new columns (every column but the identity ones and person_id).
select public.wf_staff_regrant_api() as columns_granted;
notify pgrst, 'reload schema';

commit;

-- Check: one row, true.
select count(*) = 2 as head_office_ready from information_schema.columns
 where table_schema = 'public' and table_name = 'wf_staff' and column_name in ('head_office', 'salary_annual');
