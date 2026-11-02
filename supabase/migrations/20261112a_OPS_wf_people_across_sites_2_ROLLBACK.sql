-- 20261112a_OPS_wf_people_across_sites_2_ROLLBACK.sql
-- Run in the Ops database (tbetcegmszzotrwdtqhi) ONLY to undo 20261112a. Release 5.12.38.
--
-- Claims go back to counting the shifts at the claimer's own site only (20261031a's
-- _wf_claim_problem, word for word below). The overtime columns on wf_timesheets, their guard,
-- the recompute and its triggers go: the labour reports read pay without the overtime premium again
-- (they read the column, so release 5.12.38's reports must be rolled back first, or they fail).
-- 20261111a (the links) stays.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'wf_timesheets' and column_name = 'overtime_premium') then
    raise exception '20261112a has not run (or was rolled back already). Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- Stock and GP labour back to pay_amount alone (20261029a, as it was), before the column goes.
create or replace function public.stock_rp__labour(p_site uuid, p_from date, p_to date)
returns table(pay numeric, has_data boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with k as (select c.timezone, c.day_start from public.stock_co__clock_of(p_site) c),
  t as (
    select t.status, t.pay_amount,
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
  select coalesce((select sum(coalesce(t.pay_amount, 0)) from t where t.status in ('approved', 'paid') and t.day between p_from and p_to), 0),
         exists (select 1 from t where t.day between p_from and p_to);
$fn$;

drop trigger if exists wf_staff_ot_after_link_trg on public.wf_staff;
drop trigger if exists wf_timesheets_ot_after_trg on public.wf_timesheets;
drop trigger if exists wf_timesheets_ot_guard_trg on public.wf_timesheets;
drop function if exists public.wf_ot_after_person_link();
drop function if exists public.wf_ot_after_timesheet();
drop function if exists public.wf_ot_columns_guard();
drop function if exists public.wf_ot_recompute(uuid, timestamptz);
alter table public.wf_timesheets drop column if exists overtime_premium;
alter table public.wf_timesheets drop column if exists overtime_hours;

-- 20261031a, as it was.
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

  if exists (select 1 from public.wf_shifts o
              where o.staff_id = st.id and o.id <> sh.id and o.status in ('draft', 'published')
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
     where o.staff_id = st.id and o.id <> sh.id and o.status in ('draft', 'published') and o.shift_date between v_mon and v_mon + 6;
    if round(v_week + public._wf_shift_hours(sh), 2) > v_cap + 0.001 then return 'hours_cap'; end if;
  end if;
  return null;
end
$f$;
revoke all on function public._wf_claim_problem(uuid, uuid, uuid, boolean) from public, anon, authenticated;

drop function if exists public._wf_week_start_dow(uuid);
drop function if exists public._wf_person_records(uuid);

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: columns 0, recompute false, triggers 0, claim_counts_every_site false, labour_adds_premium false.
select
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'wf_timesheets' and column_name in ('overtime_hours', 'overtime_premium')) as columns,
  to_regprocedure('public.wf_ot_recompute(uuid,timestamptz)') is not null as recompute,
  (select count(*)::int from pg_trigger where not tgisinternal and tgname in
    ('wf_timesheets_ot_guard_trg', 'wf_timesheets_ot_after_trg', 'wf_staff_ot_after_link_trg')) as triggers,
  position('_wf_person_records' in pg_get_functiondef('public._wf_claim_problem(uuid,uuid,uuid,boolean)'::regprocedure)) > 0 as claim_counts_every_site,
  position('overtime_premium' in pg_get_functiondef('public.stock_rp__labour(uuid,date,date)'::regprocedure)) > 0 as labour_adds_premium;
