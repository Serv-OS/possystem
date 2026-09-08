-- Give approved leave a value, so it can be paid, deducted and settled.
--
-- The workforce system accrued holiday (12.07% of approved hours -> a positive
-- wf_holiday_accrual row) but nothing ever SPENT it: approving leave flipped a
-- status and touched no ledger, so balances only ever grew, the approver could
-- not see whether the requester had the hours, and the payroll export had no
-- idea paid holiday happened. This makes the accrual table a true ledger:
-- accrual rows positive, taken rows negative, balance = sum. Negative balances
-- fall out for free, and offboarding is just "is the sum below zero".

alter table public.wf_time_off
  -- Decided at approval, not requested: the approver says paid or unpaid.
  add column if not exists paid boolean,
  -- Snapshots taken at approval, so later rate/settings changes cannot rewrite
  -- what was deducted or what payroll already exported.
  add column if not exists deducted_hours numeric,
  add column if not exists pay_rate numeric;

alter table public.wf_holiday_accrual
  add column if not exists source_time_off_id uuid;

-- One deduction per request, ever — approving twice cannot double-spend.
create unique index if not exists wf_holiday_accrual_one_per_timeoff
  on public.wf_holiday_accrual (source_time_off_id)
  where source_time_off_id is not null;
