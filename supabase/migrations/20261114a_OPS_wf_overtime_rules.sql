-- 20261114a_OPS_wf_overtime_rules.sql
-- Run in the Ops database (tbetcegmszzotrwdtqhi), Supabase SQL editor. Release 5.12.41.
-- Needs 20261112a (overtime on every timesheet).
--
-- Peter, 3 Nov 2026: "fix the tip credit and salaried overtime limits". Two rules from Workforce
-- settings, per site, the SQL twin of _shared/multiSiteOvertime.js overtimeRules:
--
--   EXEMPT  a position that earns no overtime (most salaried managers). Its timesheets are left out
--           of the count: no overtime, and they do not count toward 40. Salaried positions
--           (wf_roles.pay_type 'salaried', or a timesheet paid a salary's equivalent) are exempt
--           unless switched off; any position can be switched on. settings.overtimeExempt
--           { roleKey: true | false }.
--   TIP CREDIT  a timesheet paid below the site's minimum wage counts in the week's blended rate at
--           the minimum wage, so the half time is half the minimum wage (the law: 1.5 x 7.25 less
--           the 5.12 tip credit). settings.minimumWage; federal 7.25 when not set.
--
-- wf_ot_recompute (20261112a) is replaced with the two rules in, word for word otherwise. A change to
-- those two settings, or to a position's pay type, recomputes the site's last 10 weeks. Backfill:
-- every US timesheet of the last 120 days once.
-- Safe to run once. Rollback: 20261114a_OPS_wf_overtime_rules_ROLLBACK.sql (20261112a's function).

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('public.wf_ot_recompute(uuid,timestamptz)') is null then
    raise exception 'Overtime on every timesheet (20261112a) has not run. Nothing was changed.';
  end if;
  if to_regprocedure('public._wf_ot_rules(uuid,text,text)') is not null then
    raise exception '20261114a has run already. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '300s';

-- -- 1. The rules for one timesheet at its site --------------------------------------------------
create function public._wf_ot_rules(p_location uuid, p_role_key text, p_rate_source text)
returns table(exempt boolean, min_wage numeric)
language sql stable security definer set search_path = public, pg_temp as $f$
  with s as (select coalesce((select vs.settings from public.wf_venue_settings vs where vs.location_id = p_location), '{}'::jsonb) as st),
  e as (select case when p_role_key is null then null else (select s.st -> 'overtimeExempt' ->> p_role_key from s) end as set_to)
  select
    case
      when (select set_to from e) = 'true' then true
      when (select set_to from e) = 'false' then false
      else coalesce((select r.pay_type = 'salaried' from public.wf_roles r where r.location_id = p_location and r.key = p_role_key limit 1), false)
           or coalesce(p_rate_source = 'salaried', false)
    end,
    coalesce((select case when btrim(s.st ->> 'minimumWage') ~ '^[0-9]+(\.[0-9]+)?$' and (btrim(s.st ->> 'minimumWage'))::numeric > 0
                          then round((btrim(s.st ->> 'minimumWage'))::numeric, 2) end from s), 7.25)
$f$;
revoke all on function public._wf_ot_rules(uuid, text, text) from public, anon, authenticated, service_role;

-- -- 2. The recompute with the two rules in -------------------------------------------------------
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
             -- 20261114a: tip credit. Paid below the site's minimum wage: counts at it in the blend.
             greatest(coalesce(t.pay_amount, 0), 0)
               + case when ru.min_wage > coalesce(t.effective_rate, 0)
                      then (ru.min_wage - coalesce(t.effective_rate, 0))
                           * (greatest(coalesce(t.actual_hours, 0), 0) + greatest(coalesce(t.paid_break_mins, 0), 0)::numeric / 60)
                      else 0 end as pay,
             -- 20261114a: exempt positions earn no overtime and do not count toward 40.
             t.status in ('approved', 'paid') and not ru.exempt as counts
        from public.wf_timesheets t
        join public.locations l on l.id = t.location_id
        left join public.wf_staff ws on ws.id = t.staff_id
        cross join lateral public._wf_ot_rules(t.location_id, ws.role_key, t.rate_source) ru
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
      -- 20261114a: to 6 places first, then the cent (the JS twin's pennies()), so both round alike.
      v_prem := case when v_ot > 0 then round(round(v_ot * v_rate * 0.5, 6), 2) else 0 end;
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


-- -- 3. Recompute a site's last 10 weeks when its rules change ------------------------------------
create function public.wf_ot_recompute_site(p_location uuid)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $f$
declare
  r record;
  v_n integer := 0;
begin
  for r in
    select distinct on (t.staff_id, (t.clock_in at time zone 'UTC')::date) t.staff_id, t.clock_in
      from public.wf_timesheets t
     where t.location_id = p_location and t.clock_in >= now() - interval '70 days'
  loop
    v_n := v_n + public.wf_ot_recompute(r.staff_id, r.clock_in);
  end loop;
  return v_n;
end
$f$;
revoke all on function public.wf_ot_recompute_site(uuid) from public, anon, authenticated;
grant execute on function public.wf_ot_recompute_site(uuid) to service_role;

create function public.wf_ot_after_rules_change()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $f$
begin
  if tg_table_name = 'wf_venue_settings' then
    if (old.settings -> 'overtimeExempt') is distinct from (new.settings -> 'overtimeExempt')
       or (old.settings ->> 'minimumWage') is distinct from (new.settings ->> 'minimumWage') then
      perform public.wf_ot_recompute_site(new.location_id);
    end if;
  elsif tg_table_name = 'wf_roles' then
    if old.pay_type is distinct from new.pay_type then
      perform public.wf_ot_recompute_site(new.location_id);
    end if;
  end if;
  return null;
end
$f$;
revoke all on function public.wf_ot_after_rules_change() from public, anon, authenticated, service_role;
create trigger wf_venue_settings_ot_rules_trg
  after update of settings on public.wf_venue_settings
  for each row execute function public.wf_ot_after_rules_change();
create trigger wf_roles_ot_rules_trg
  after update of pay_type on public.wf_roles
  for each row execute function public.wf_ot_after_rules_change();

-- -- 4. Backfill: US timesheets of the last 120 days -------------------------------------------
do $backfill$
declare
  r record;
begin
  for r in
    select distinct on (t.staff_id, (t.clock_in at time zone 'UTC')::date) t.staff_id, t.clock_in
      from public.wf_timesheets t join public.locations l on l.id = t.location_id
     where upper(coalesce(l.currency, 'GBP')) = 'USD' and t.clock_in >= now() - interval '120 days'
  loop
    perform public.wf_ot_recompute(r.staff_id, r.clock_in);
  end loop;
end
$backfill$;

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: rules true, recompute_uses_rules true, triggers 2, rules_open_to_api false.
select
  to_regprocedure('public._wf_ot_rules(uuid,text,text)') is not null as rules,
  position('_wf_ot_rules' in pg_get_functiondef('public.wf_ot_recompute(uuid,timestamptz)'::regprocedure)) > 0 as recompute_uses_rules,
  (select count(*)::int from pg_trigger where not tgisinternal and tgname in ('wf_venue_settings_ot_rules_trg', 'wf_roles_ot_rules_trg')) as triggers,
  has_function_privilege('authenticated', 'public._wf_ot_rules(uuid,text,text)', 'execute') as rules_open_to_api;
