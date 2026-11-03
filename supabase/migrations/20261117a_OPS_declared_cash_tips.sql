-- 20261117a_OPS_declared_cash_tips.sql (5.12.49). Run in the Ops SQL editor BEFORE deploying
-- workforce-clock, staff-portal and workforce-compute. ASCII only on purpose.
--
-- US venues: staff declare the cash tips they received at clock out (Time Clock tablet, staff app).
-- The amount is kept on the timesheet. Null means not asked (a UK venue, an older app, a manager's
-- clock out); 0 means asked and none. Shown and editable in Back Office, Timesheets; totalled in
-- Payroll and the US payroll export; counted toward the tip credit week (_shared/tipCredit.js).

begin;

alter table public.wf_timesheets
  add column if not exists declared_cash_tips numeric(10,2);

do $c$
begin
  if not exists (select 1 from pg_constraint where conname = 'wf_timesheets_declared_cash_tips_range') then
    alter table public.wf_timesheets add constraint wf_timesheets_declared_cash_tips_range
      check (declared_cash_tips is null or (declared_cash_tips >= 0 and declared_cash_tips <= 10000));
  end if;
end
$c$;

comment on column public.wf_timesheets.declared_cash_tips is
  'Cash tips the employee declared for this shift (US venues, 5.12.49). Null = not asked; 0 = none.';

commit;

-- Check: one row, true.
select exists (select 1 from information_schema.columns where table_schema = 'public'
  and table_name = 'wf_timesheets' and column_name = 'declared_cash_tips') as declared_cash_tips_ready;
