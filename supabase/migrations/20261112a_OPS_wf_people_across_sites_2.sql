-- 20261112a_OPS_wf_people_across_sites_2.sql
-- Run in the Ops database (tbetcegmszzotrwdtqhi), Supabase SQL editor. Release 5.12.38.
-- Needs 20261031a (open shifts), 20261104a (identity fence) and 20261111a (one person, many sites).
--
-- ONE PERSON, MANY SITES, part two (Peter, 2 Nov 2026: "one member of staff might work at 2 sites or
-- 3 sites ... 20 hours at one site and 25 hours at another site, then that is 5 hours over time").
--
--   1. Claims count every site. A staff app claim of an open shift (and a manager approving one)
--      is refused when it overlaps the person's shift at ANY of their linked sites, and the most hours
--      a week counts every site. (_wf_claim_problem, replaced; only those two reads change.)
--
--   2. Overtime premium on every timesheet, for the reports. wf_timesheets gets overtime_hours and
--      overtime_premium. The database keeps them, whoever writes the timesheet (the clock, the Manager
--      app, Back Office): every change to a timesheet's hours, times, pay, status or person recomputes
--      that person's week at every linked site (wf_ot_recompute). Linking or unlinking a person
--      recomputes their recent weeks. Nobody can write the two columns directly.
--      The rule is _shared/multiSiteOvertime.js sheetOvertime, the same one payroll uses:
--        * US sites only (currency USD): over 40 hours in the work week; other sites read 0.
--        * approved and paid timesheets count; the rest read 0.
--        * each timesheet's week is its own site's work week (its venue day, its Work week starts).
--        * the hours after 40 are overtime in the order worked, on the timesheet that worked them.
--        * premium = overtime hours x 0.5 x the week's blend (all pay_amount / all paid hours, every
--          linked site), to the cent per timesheet.
--      Daily trading, the Owner and Manager apps and the P&L add overtime_premium to labour.
--
-- Backfill: every US timesheet of the last 120 days is computed once (1 US venue today).
-- Safe to run once. Rollback: 20261112a_OPS_wf_people_across_sites_2_ROLLBACK.sql

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('public._wf_claim_problem(uuid,uuid,uuid,boolean)') is null or to_regprocedure('public._wf_shift_hours(public.wf_shifts)') is null then
    raise exception 'Open shifts (20261031a) has not run. Nothing was changed.';
  end if;
  if to_regprocedure('public.stock_co__venue_day(uuid,timestamptz)') is null or to_regprocedure('public.stock_co__clock_of(uuid)') is null
     or to_regprocedure('public.stock_co__day_start_at(date,time,text)') is null then
    raise exception 'The Stock and GP report functions (20261029a) are missing. Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'wf_staff' and column_name = 'person_id') then
    raise exception 'One person, many sites (20261111a) has not run. Run it first. Nothing was changed.';
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'wf_timesheets' and column_name = 'overtime_premium') then
    raise exception '20261112a has run already. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '300s';

-- -- 1. Helpers ---------------------------------------------------------------------------------
-- Every staff record of the person (this one included): one site when not linked.
create function public._wf_person_records(p_staff uuid)
returns uuid[]
language sql stable security definer set search_path = public, pg_temp as $f$
  select coalesce(
    (select array_agg(o.id order by o.id)
       from public.wf_staff me
       join public.wf_staff o on o.org_id = me.org_id and o.person_id = me.person_id
      where me.id = p_staff and me.person_id is not null),
    array[p_staff])
$f$;
revoke all on function public._wf_person_records(uuid) from public, anon, authenticated, service_role;

-- A site's Work week starts (Workforce settings): 0 Sunday ... 6 Saturday, Monday when not set.
create function public._wf_week_start_dow(p_location uuid)
returns integer
language sql stable security definer set search_path = public, pg_temp as $f$
  select coalesce((select case when (vs.settings ->> 'workweekStart') ~ '^[0-6]$' then (vs.settings ->> 'workweekStart')::int end
                     from public.wf_venue_settings vs where vs.location_id = p_location), 1)
$f$;
revoke all on function public._wf_week_start_dow(uuid) from public, anon, authenticated, service_role;

-- -- 2. Claims count every linked site -------------------------------------------------------
-- 20261031a's function, word for word, but for the two reads of "their other shifts" (overlap and
-- the most hours a week), which now read every record of the person.
create or replace function public._wf_claim_problem(p_shift_id uuid, p_staff_id uuid, p_request_id uuid, p_deciding boolean)
returns text language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  sh public.wf_shifts;
  st public.wf_staff;
  rq public.wf_swap_requests;
  v_tz text;
  v_now timestamp;
  v_s timestamp;
  v_e timestamp;
  v_pd jsonb;
  v_state text;
  v_cap_txt text;
  v_cap numeric;
  v_week numeric;
  v_mon date;
  v_mine uuid[];
begin
  select * into sh from public.wf_shifts where id = p_shift_id;
  if not found or sh.status <> 'published' then return 'not_published'; end if;
  select coalesce(nullif(l.timezone, ''), 'Europe/London') into v_tz from public.locations l where l.id = sh.location_id;
  v_now := date_trunc('minute', now() at time zone coalesce(v_tz, 'Europe/London'));
  v_s := sh.shift_date + sh.start_time;
  v_e := sh.shift_date + sh.finish_time + case when sh.finish_time <= sh.start_time then interval '1 day' else interval '0' end;
  if v_s <= v_now then return 'past'; end if;

  select * into st from public.wf_staff where id = p_staff_id;
  if not found or st.status is distinct from 'active' or st.location_id is distinct from sh.location_id then return 'not_on_team'; end if;
  if public._wf_onboarding_open(st.id, coalesce((select upper(l.currency) from public.locations l where l.id = sh.location_id), 'GBP') <> 'USD') then
    return 'onboarding';
  end if;
  if sh.staff_id is not null and sh.staff_id = st.id then return 'own'; end if;
  if sh.role_key is not null and st.role_key is distinct from sh.role_key then return 'role'; end if;

  if p_request_id is not null then
    select * into rq from public.wf_swap_requests where id = p_request_id;
  end if;
  if not coalesce(p_deciding, false) then
    if sh.staff_id is not null then
      if rq.id is null or rq.status not in ('open', 'pending') or rq.from_staff_id is distinct from sh.staff_id then return 'not_offered'; end if;
      if rq.kind = 'offer' and rq.to_staff_id is not null and rq.to_staff_id <> st.id then return 'offered_elsewhere'; end if;
    end if;
    if rq.id is not null and rq.status = 'pending' then return 'taken'; end if;
  end if;

  -- 20261112a: their shifts at every site they work at.
  v_mine := public._wf_person_records(st.id);
  if exists (select 1 from public.wf_shifts o
              where o.staff_id = any (v_mine) and o.id <> sh.id and o.status in ('draft', 'published')
                and o.shift_date between sh.shift_date - 1 and sh.shift_date + 1
                and (o.shift_date + o.start_time) < v_e
                and (o.shift_date + o.finish_time + case when o.finish_time <= o.start_time then interval '1 day' else interval '0' end) > v_s) then
    return 'overlap';
  end if;
  if exists (select 1 from public.wf_time_off l
              where l.staff_id = st.id and l.status = 'approved' and l.start_date <= sh.shift_date and sh.shift_date <= l.end_date) then
    return 'leave';
  end if;
  select a.per_day into v_pd from public.wf_availability a where a.staff_id = st.id
   order by a.updated_at desc nulls last, a.created_at desc limit 1;
  select e ->> 'state' into v_state
    from jsonb_array_elements(case when jsonb_typeof(v_pd) = 'array' then v_pd else '[]'::jsonb end) e
   where (e ->> 'day') = ((extract(isodow from sh.shift_date)::int) - 1)::text limit 1;
  if v_state = 'unavailable' then return 'unavailable'; end if;

  select vs.settings -> 'shiftSwaps' ->> 'maxWeeklyHours' into v_cap_txt from public.wf_venue_settings vs where vs.location_id = sh.location_id;
  v_cap := case when v_cap_txt ~ '^[0-9]+(\.[0-9]+)?$' then least(v_cap_txt::numeric, 168) else null end;
  if v_cap > 0 then
    v_mon := sh.shift_date - (extract(isodow from sh.shift_date)::int - 1);
    select coalesce(sum(public._wf_shift_hours(o)), 0) into v_week from public.wf_shifts o
     where o.staff_id = any (v_mine) and o.id <> sh.id and o.status in ('draft', 'published') and o.shift_date between v_mon and v_mon + 6;
    if round(v_week + public._wf_shift_hours(sh), 2) > v_cap + 0.001 then return 'hours_cap'; end if;
  end if;
  return null;
end
$f$;
revoke all on function public._wf_claim_problem(uuid, uuid, uuid, boolean) from public, anon, authenticated;

-- -- 3. Overtime on every timesheet --------------------------------------------------------------
alter table public.wf_timesheets add column overtime_hours numeric(8,2) not null default 0;
alter table public.wf_timesheets add column overtime_premium numeric(12,2) not null default 0;
comment on column public.wf_timesheets.overtime_hours is
  'US: hours of this timesheet past 40 in its work week, counted across every linked site. Kept by wf_ot_recompute. 20261112a.';
comment on column public.wf_timesheets.overtime_premium is
  'US: half time owed on overtime_hours at the week''s blended regular rate, every linked site. Labour reports add it. Kept by wf_ot_recompute. 20261112a.';

-- Recompute one person's work week (every linked site): the week of p_at at the site of p_staff.
-- Returns how many timesheets changed.
create function public.wf_ot_recompute(p_staff uuid, p_at timestamptz)
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

-- The two columns are written only by wf_ot_recompute.
create function public.wf_ot_columns_guard()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $f$
declare
  v_ctx text;
begin
  get diagnostics v_ctx = pg_context;
  if v_ctx ~ 'function (public\.)?wf_ot_recompute\(uuid,timestamp with time zone\)' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.overtime_hours := 0; new.overtime_premium := 0;
  else
    new.overtime_hours := old.overtime_hours; new.overtime_premium := old.overtime_premium;
  end if;
  return new;
end
$f$;
revoke all on function public.wf_ot_columns_guard() from public, anon, authenticated, service_role;
create trigger wf_timesheets_ot_guard_trg
  before insert or update on public.wf_timesheets
  for each row execute function public.wf_ot_columns_guard();

-- Any change that can move overtime recomputes the week (and the old week, when it moved).
create function public.wf_ot_after_timesheet()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $f$
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    perform public.wf_ot_recompute(new.staff_id, new.clock_in);
  end if;
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and (old.staff_id is distinct from new.staff_id or old.clock_in is distinct from new.clock_in)) then
    perform public.wf_ot_recompute(old.staff_id, old.clock_in);
  end if;
  return null;
end
$f$;
revoke all on function public.wf_ot_after_timesheet() from public, anon, authenticated, service_role;
create trigger wf_timesheets_ot_after_trg
  after insert or update of staff_id, location_id, clock_in, actual_hours, paid_break_mins, pay_amount, status or delete
  on public.wf_timesheets
  for each row execute function public.wf_ot_after_timesheet();

-- Linking or unlinking a person recomputes their weeks of the last 10 weeks, both sides.
create function public.wf_ot_after_person_link()
returns trigger
language plpgsql security definer set search_path = public, pg_temp as $f$
declare
  r record;
begin
  for r in
    select distinct on (t.staff_id, (t.clock_in at time zone 'UTC')::date) t.staff_id, t.clock_in
      from public.wf_timesheets t
     where t.clock_in >= now() - interval '70 days'
       and (t.staff_id = new.id
            or (old.person_id is not null and t.staff_id in (select w.id from public.wf_staff w where w.person_id = old.person_id and w.org_id = new.org_id))
            or (new.person_id is not null and t.staff_id in (select w.id from public.wf_staff w where w.person_id = new.person_id and w.org_id = new.org_id)))
  loop
    perform public.wf_ot_recompute(r.staff_id, r.clock_in);
  end loop;
  return null;
end
$f$;
revoke all on function public.wf_ot_after_person_link() from public, anon, authenticated, service_role;
create trigger wf_staff_ot_after_link_trg
  after update of person_id on public.wf_staff
  for each row when (old.person_id is distinct from new.person_id)
  execute function public.wf_ot_after_person_link();


-- -- 4. Stock and GP labour adds the overtime premium (20261029a's stock_rp__labour, word for word but
-- for the premium; the P&L rule is now pay_amount + overtime_premium everywhere) -----------------
create or replace function public.stock_rp__labour(p_site uuid, p_from date, p_to date)
returns table(pay numeric, has_data boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with k as (select c.timezone, c.day_start from public.stock_co__clock_of(p_site) c),
  t as (
    select t.status, t.pay_amount, t.overtime_premium,
           (select d.business_day
              from public.stock_co__venue_day(p_site,
                     case when t.clock_out is not null and t.clock_out > t.clock_in
                          then to_timestamp((floor(extract(epoch from t.clock_in) * 1000)
                                             + floor((floor(extract(epoch from t.clock_out) * 1000) - floor(extract(epoch from t.clock_in) * 1000)) / 2)) / 1000.0)
                          else t.clock_in end) d) as day
      from wf_timesheets t, k
     where t.location_id = p_site and t.clock_in is not null
       and t.clock_in >= public.stock_co__day_start_at(p_from, k.day_start, k.timezone) - interval '2 days'
       and t.clock_in < public.stock_co__day_start_at(p_to + 1, k.day_start, k.timezone)
  )
  select coalesce((select sum(coalesce(t.pay_amount, 0) + coalesce(t.overtime_premium, 0)) from t where t.status in ('approved', 'paid') and t.day between p_from and p_to), 0),
         exists (select 1 from t where t.day between p_from and p_to);
$fn$;
-- -- 5. Backfill: US timesheets of the last 120 days ----------------------------------------------
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

-- VISIBLE CHECK. Expected: columns 2, recompute true, recompute_open_to_api false, triggers 3,
-- claim_counts_every_site true, uk_overtime_rows 0, labour_adds_premium true.
select
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'wf_timesheets' and column_name in ('overtime_hours', 'overtime_premium')) as columns,
  to_regprocedure('public.wf_ot_recompute(uuid,timestamptz)') is not null as recompute,
  has_function_privilege('authenticated', 'public.wf_ot_recompute(uuid,timestamptz)', 'execute') as recompute_open_to_api,
  (select count(*)::int from pg_trigger where not tgisinternal and tgname in
    ('wf_timesheets_ot_guard_trg', 'wf_timesheets_ot_after_trg', 'wf_staff_ot_after_link_trg')) as triggers,
  position('_wf_person_records' in pg_get_functiondef('public._wf_claim_problem(uuid,uuid,uuid,boolean)'::regprocedure)) > 0 as claim_counts_every_site,
  (select count(*)::int from public.wf_timesheets t join public.locations l on l.id = t.location_id
    where upper(coalesce(l.currency, 'GBP')) <> 'USD' and (t.overtime_hours <> 0 or t.overtime_premium <> 0)) as uk_overtime_rows,
  position('overtime_premium' in pg_get_functiondef('public.stock_rp__labour(uuid,date,date)'::regprocedure)) > 0 as labour_adds_premium;
