-- 20261206b_OPS_wf_claim_availability_week.sql  (Ops database tbetcegmszzotrwdtqhi)
--
-- Open shifts: the claim judge reads the availability pattern for the SHIFT'S week (HR feedback
-- batch 2, 24 Nov 2026). Release 5.12.91 lets a team member file availability for any week up to 26
-- weeks ahead (students know their timetable months ahead). The judge that decides whether someone
-- may take an open shift (_wf_claim_problem) read the pattern that was EDITED most recently,
-- whatever week it was for. With one future pattern at most that was a small fault; with many it
-- is a real one: "Unavailable on Saturdays from the week of 12 April" would refuse every Saturday
-- claim from the day it was typed, while the staff app listed the shift as takeable.
--
-- This replaces that one function with the same text and ONE changed read: the pattern in effect
-- on the shift's day (greatest week_start on or before it; a pattern with no week_start is the
-- earliest), which is the rule the rota, the staff app and the Back Office already use
-- (supabase/functions/_shared/availabilityWhen.js). Nothing else in the function changes.
--
-- RUN THIS BEFORE the 5.12.91 staff-portal function is deployed (the deploy is what lets staff file
-- more than one future week). Proven on a local PostgreSQL by
-- supabase/tests/wf_claim_availability_week/run.mjs. One function replaced; its grants (service
-- role only) are kept by create or replace. Safe to run twice.

set client_min_messages = warning;

CREATE OR REPLACE FUNCTION public._wf_claim_problem(p_shift_id uuid, p_staff_id uuid, p_request_id uuid, p_deciding boolean)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- 20261206b: the pattern IN EFFECT on the shift's day: the greatest week_start on or before it
  -- (a pattern with no week_start is the earliest), newest edit first on a tie. It was the most
  -- recently EDITED row, whatever week it was for.
  select a.per_day into v_pd from public.wf_availability a
   where a.staff_id = st.id and (a.week_start is null or a.week_start <= sh.shift_date)
   order by a.week_start desc nulls last, a.updated_at desc nulls last, a.created_at desc limit 1;
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
$function$;

notify pgrst, 'reload schema';

-- Check: one row, _wf_claim_problem | t | f | f
select p.proname,
       position('a.week_start <= sh.shift_date' in pg_get_functiondef(p.oid)) > 0 as reads_the_week,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as logins_may_call,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_may_call
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = '_wf_claim_problem';
