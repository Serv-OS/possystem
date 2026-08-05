-- v5.5.970 — FUTURE-DATED PAY RATE CHANGES (customer ask: "schedule NMW/salary
-- rises in advance at position level so they apply automatically").
--
-- Model: wf_rate_changes rows are SCHEDULED intents. On the effective date the
-- daily applier writes the new rate onto wf_roles.base_rate / wf_staff.rate_override
-- and marks the row 'applied' — from then on the normal rate card carries it.
-- Before that date, the ROTA resolves rates date-aware (resolveRateOn in
-- src/staff/labour.js) so publishing next week's shifts already stamps the new
-- rate for days on/after the change. Historical shifts/timesheets are untouched
-- (rates are snapshotted at publish/clock-in — the existing protection).
begin;

create table if not exists wf_rate_changes (
  id                uuid primary key default gen_random_uuid(),
  location_id       uuid not null,
  org_id            uuid,
  target_kind       text not null check (target_kind in ('role','staff')),
  role_key          text,                                  -- target_kind='role'
  staff_id          uuid references wf_staff(id) on delete cascade,  -- target_kind='staff'
  new_rate          numeric(10,2) check (new_rate is null or new_rate >= 0),
  new_salary_annual numeric(12,2) check (new_salary_annual is null or new_salary_annual >= 0),
  effective_from    date not null,
  status            text not null default 'scheduled' check (status in ('scheduled','applied','cancelled')),
  note              text,
  created_by        text,
  applied_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check ((target_kind = 'role' and role_key is not null) or (target_kind = 'staff' and staff_id is not null)),
  check (new_rate is not null or new_salary_annual is not null)
);
create index if not exists idx_wf_rate_changes_loc on wf_rate_changes (location_id, status, effective_from);

-- Same tenant integrity + touch trigger + RLS fence as every other wf_* table.
do $$ begin
  alter table wf_rate_changes add constraint wf_rate_changes_loc_org_fk
    foreign key (location_id, org_id) references locations (id, org_id);
exception when duplicate_object then null; end $$;

drop trigger if exists trg_wf_rate_changes_touch on wf_rate_changes;
create trigger trg_wf_rate_changes_touch before update on wf_rate_changes
  for each row execute function wf_touch_updated_at();

alter table wf_rate_changes enable row level security;
alter table wf_rate_changes force row level security;
do $$ begin
  begin create policy wf_rate_changes_rls_select on wf_rate_changes for select
    using (location_id::text in (select public.user_accessible_locations()));
  exception when duplicate_object then null; end;
  begin create policy wf_rate_changes_rls_insert on wf_rate_changes for insert
    with check (location_id::text in (select public.user_accessible_locations()));
  exception when duplicate_object then null; end;
  begin create policy wf_rate_changes_rls_update on wf_rate_changes for update
    using (location_id::text in (select public.user_accessible_locations()));
  exception when duplicate_object then null; end;
  begin create policy wf_rate_changes_rls_delete on wf_rate_changes for delete
    using (location_id::text in (select public.user_accessible_locations()));
  exception when duplicate_object then null; end;
end $$;

-- ── The applier: due scheduled rows land on the live rate card ───────────────
-- Idempotent (a row is applied exactly once — status flips inside the same
-- loop iteration) and safe to call from anywhere: pg_cron daily, and lazily
-- from the Back Office when the rates screen opens (same-day schedules apply
-- without waiting for tomorrow's cron).
create or replace function public.apply_due_wf_rate_changes() returns integer
language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  for r in
    select * from wf_rate_changes
     where status = 'scheduled' and effective_from <= current_date
     order by effective_from, created_at
  loop
    if r.target_kind = 'role' then
      update wf_roles
         set base_rate     = coalesce(r.new_rate, base_rate),
             salary_annual = coalesce(r.new_salary_annual, salary_annual),
             -- a scheduled salary implies salaried pay; a scheduled hourly rate
             -- keeps whatever pay_type the role already has
             pay_type      = case when r.new_salary_annual is not null and r.new_rate is null
                                  then 'salaried' else pay_type end
       where location_id = r.location_id and key = r.role_key;
    else
      update wf_staff set rate_override = r.new_rate where id = r.staff_id;
    end if;
    update wf_rate_changes set status = 'applied', applied_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return n;
end $$;

revoke execute on function public.apply_due_wf_rate_changes() from public;
grant execute on function public.apply_due_wf_rate_changes() to authenticated, service_role;

-- Daily at 03:05 (before any UK shift starts) — same guard idiom as paxpay-sweep.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('wf-rate-changes-daily')
      where exists (select 1 from cron.job where jobname = 'wf-rate-changes-daily');
    perform cron.schedule('wf-rate-changes-daily', '5 3 * * *',
                          $cron$ select public.apply_due_wf_rate_changes(); $cron$);
    raise notice 'wf-rate-changes-daily scheduled via pg_cron';
  else
    raise warning 'pg_cron NOT installed — scheduled rate changes apply lazily when the Back Office rates screen opens.';
  end if;
end $$;

commit;
