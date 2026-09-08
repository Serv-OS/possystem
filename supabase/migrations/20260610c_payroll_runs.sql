-- ============================================================================
-- Payroll runs — closing a pay period becomes a RECORD.
--
-- wf_payroll_runs: one row per closed pay period per location. Snapshot of
-- every staff line (hours, base, direct tips, tronc tips, total, bank at the
-- time) + totals + the tipping policy in force. UNIQUE (location, period
-- start): a period closes once. Closing marks the period's APPROVED
-- timesheets status='paid' and stamps payroll_run_id on them, giving a full
-- paid-history; the close itself lands in the tamper-evident wf_audit chain.
-- Closing is blocked server-side while the period still has PENDING
-- timesheets ("finish approving timesheets").
-- ============================================================================

create table if not exists wf_payroll_runs (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  org_id        uuid not null,
  period_start  date not null,
  period_end    date not null,
  pay_date      date,
  status        text not null default 'completed',   -- completed (immutable)
  totals        jsonb not null default '{}'::jsonb,  -- { pay, tips_direct, tips_tronc, total }
  lines         jsonb not null default '[]'::jsonb,  -- per-staff snapshot
  policy        jsonb not null default '{}'::jsonb,  -- tipping policy in force
  timesheet_ids uuid[] not null default '{}',        -- the timesheets marked paid
  run_by        uuid,
  created_at    timestamptz not null default now(),
  unique (location_id, period_start)
);
create index if not exists idx_wf_payroll_runs_loc on wf_payroll_runs(location_id, period_start desc);

do $$ begin
  alter table wf_payroll_runs add constraint wf_payroll_runs_loc_org_fk
    foreign key (location_id, org_id) references locations (id, org_id);
exception when duplicate_object then null; end $$;

alter table wf_payroll_runs enable row level security;
alter table wf_payroll_runs force row level security;
do $$ begin create policy wf_payroll_runs_rls_select on wf_payroll_runs for select using (location_id::text in (select public.user_accessible_locations())); exception when duplicate_object then null; end $$;
-- No client INSERT/UPDATE/DELETE policies: runs are created ONLY by the
-- service-role edge function (payroll.close) and are immutable.
do $$ begin create policy wf_payroll_runs_super_admin_all on wf_payroll_runs for all using (public.is_super_admin()) with check (public.is_super_admin()); exception when duplicate_object then null; end $$;

-- Link paid timesheets back to the run that paid them.
alter table wf_timesheets add column if not exists payroll_run_id uuid references wf_payroll_runs(id);
create index if not exists idx_wf_ts_payroll_run on wf_timesheets(payroll_run_id);
