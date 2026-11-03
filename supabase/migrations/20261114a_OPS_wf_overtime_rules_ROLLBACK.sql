-- 20261114a_OPS_wf_overtime_rules_ROLLBACK.sql
-- Run in the Ops database (tbetcegmszzotrwdtqhi) ONLY to undo 20261114a. Release 5.12.41.
-- Puts wf_ot_recompute back as 20261112a left it (no exempt positions, no tip credit) and drops the
-- rules, the site recompute and the two triggers. Stored overtime stays as it is until the next
-- change to each timesheet.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('public._wf_ot_rules(uuid,text,text)') is null then
    raise exception '20261114a has not run (or was rolled back already). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

drop trigger if exists wf_roles_ot_rules_trg on public.wf_roles;
drop trigger if exists wf_venue_settings_ot_rules_trg on public.wf_venue_settings;
drop function if exists public.wf_ot_after_rules_change();
drop function if exists public.wf_ot_recompute_site(uuid);

-- 20261112a, as it was.
create or replace function public.wf_ot_recompute(p_staff uuid, p_at timestamptz)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $f$
declare
  v_ids uuid[];
  v_tz text;
  v_us boolean;
  v_day date;
  v_target date;
  v_rate numeric := 0;
  v_run numeric := 0;
  v_before numeric;
  v_ot numeric;
  v_prem numeric;
  v_n integer := 0;
  r record;
begin
  if p_staff is null or p_at is null then return 0; end if;
  select coalesce(nullif(l.timezone, ''), 'Europe/London'), upper(coalesce(l.currency, 'GBP')) = 'USD'
    into v_tz, v_us
    from public.wf_staff w join public.locations l on l.id = w.location_id where w.id = p_staff;
  if v_tz is null then return 0; end if;
  v_ids := public._wf_person_records(p_staff);
  v_day := (p_at at time zone v_tz)::date;
  v_target := v_day - ((extract(dow from v_day)::int - public._wf_week_start_dow((select location_id from public.wf_staff where id = p_staff)) + 7) % 7);

  for r in
    with wk as (
      select t.id, t.staff_id, t.clock_in, t.overtime_hours as old_h, t.overtime_premium as old_p,
             greatest(coalesce(t.actual_hours, 0), 0) as hrs,
             greatest(coalesce(t.actual_hours, 0), 0) + greatest(coalesce(t.paid_break_mins, 0), 0)::numeric / 60 as paid_hrs,
             greatest(coalesce(t.pay_amount, 0), 0) as pay,
             t.status in ('approved', 'paid') as counts
        from public.wf_timesheets t
        join public.locations l on l.id = t.location_id
       where t.staff_id = any (v_ids)
         and t.clock_in >= (v_target - 2)::timestamp at time zone 'UTC'
         and t.clock_in < (v_target + 9)::timestamp at time zone 'UTC'
         and ((t.clock_in at time zone coalesce(nullif(l.timezone, ''), 'Europe/London'))::date
              - ((extract(dow from (t.clock_in at time zone coalesce(nullif(l.timezone, ''), 'Europe/London'))::date)::int
                  - public._wf_week_start_dow(t.location_id) + 7) % 7)) = v_target
    )
    select wk.*,
           coalesce(sum(wk.pay) filter (where wk.counts) over (), 0) as week_pay,
           coalesce(sum(wk.paid_hrs) filter (where wk.counts) over (), 0) as week_hours
      from wk
     order by wk.clock_in, wk.staff_id::text collate "C", wk.id::text collate "C"
  loop
    v_ot := 0; v_prem := 0;
    if v_us and r.counts then
      v_rate := case when r.week_hours > 0 then r.week_pay / r.week_hours else 0 end;
      v_before := v_run;
      v_run := v_run + r.hrs;
      v_ot := greatest(v_run - 40, 0) - greatest(v_before - 40, 0);
      v_prem := case when v_ot > 0 then round(v_ot * v_rate * 0.5, 2) else 0 end;
    end if;
    if round(v_ot, 2) is distinct from r.old_h or v_prem is distinct from r.old_p then
      update public.wf_timesheets set overtime_hours = round(v_ot, 2), overtime_premium = v_prem where id = r.id;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end
$f$;
revoke all on function public.wf_ot_recompute(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.wf_ot_recompute(uuid, timestamptz) to service_role;


drop function if exists public._wf_ot_rules(uuid, text, text);
notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: rules false, triggers 0.
select to_regprocedure('public._wf_ot_rules(uuid,text,text)') is not null as rules,
  (select count(*)::int from pg_trigger where not tgisinternal and tgname in ('wf_venue_settings_ot_rules_trg', 'wf_roles_ot_rules_trg')) as triggers;
