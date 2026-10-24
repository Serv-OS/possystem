-- 20261031a_OPS_wf_open_shifts.sql
-- Release 5.11.101, Workforce: open shifts, swaps and US sites.
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  One transaction: any error and nothing changes. It refuses a second run. #
-- #  Lock wait 3 s (it gives up, nothing changes). Run after UK close.        #
-- #  NEVER on 25 Oct 2026 (UK clocks) or 1 Nov 2026 (US clocks).              #
-- ############################################################################
--
-- WHAT IT ADDS
--   1. Open shifts. wf_shifts.staff_id may be empty: a shift on the rota with nobody on it yet,
--      for someone in its position to claim from the staff app. Nothing else about a shift changes.
--   2. Shift claims and swaps on wf_swap_requests (the table has existed since 20260608 with no
--      code using it; one test row at Provo): kind (drop: "I can't do this shift", open to everyone
--      in the position; offer: to one named colleague; claim: someone claiming an open shift),
--      a note, when it was claimed and decided, who decided and how, and what the shift was at the
--      time (kept even if the shift is deleted later). from_staff_id may be empty (a claim on an
--      open shift has nobody giving it up). One live request per shift (a unique index), so two
--      people can never both have the same shift waiting.
--   3. The judge, in the database, so the phone is never trusted: wf_shift_claim, wf_shift_drop,
--      wf_swap_cancel, wf_swap_decline and wf_swap_decide. Each locks the shift, checks every rule
--      (published, not started, on the team here, the right position, offered to this person,
--      nobody else waiting, no overlap with their other shifts, not on approved leave, not marked
--      unavailable that weekday, under the venue's weekly hours cap, onboarding finished, as the rota
--      requires before it schedules anyone) and the first claim wins.
--      The venue setting (Workforce settings, Shift claims and swaps) decides whether a claim
--      happens straight away or waits for a manager; with no setting a manager approves.
--      SECURITY DEFINER, callable by the service role only (the staff-portal and manager-approve
--      edge functions, which prove who is asking). Nobody else can execute them.
--   4. wf_swap_requests is written ONLY through those functions: the direct insert, update and
--      delete policies go, and the anon and authenticated roles lose their write grants (anon loses
--      read too). Back Office logins still read their own venues' requests (the select policy and
--      grant stay). No new policy is added, so no policy calls a function a role cannot execute.
--   5. US payroll fields on wf_staff: payroll_employee_id (the payroll provider's id, for the US
--      export) and ssn_last4 (the last four digits only, never the whole number).
--
-- WHAT IT NEVER DOES
--   It changes no shift, timesheet, pay figure or staff row. The one test request at Provo keeps
--   its row (its shift was 24 Oct, so it is in the past and nobody can claim it).
--
-- ROLLBACK
--   20261031a_OPS_wf_open_shifts_ROLLBACK.sql (drops the five functions and two helpers, the new
--   columns and the index, puts back the three policies and the grants, and makes staff_id and
--   from_staff_id required again; it refuses while any open shift with nobody on it exists, and
--   names how many).

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.wf_shifts') is null or to_regclass('public.wf_swap_requests') is null
     or to_regclass('public.wf_staff') is null or to_regclass('public.wf_venue_settings') is null
     or to_regclass('public.wf_time_off') is null or to_regclass('public.wf_availability') is null
     or to_regclass('public.wf_roles') is null or to_regclass('public.wf_onboarding') is null then
    raise exception 'The Workforce tables are missing. Nothing was changed.';
  end if;
  if to_regprocedure('public.wf_shift_claim(uuid,uuid)') is not null
     or exists (select 1 from information_schema.columns c
                 where c.table_schema = 'public' and c.table_name = 'wf_swap_requests' and c.column_name = 'kind') then
    raise exception 'Open shifts (20261031a) has run already. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- ============================================================================
-- 1. OPEN SHIFTS: a shift may have nobody on it yet
-- ============================================================================
alter table public.wf_shifts alter column staff_id drop not null;
comment on column public.wf_shifts.staff_id is
  'Who works the shift. Empty = an open shift: on the rota for someone in its position to claim (20261031a).';

-- ============================================================================
-- 2. CLAIMS AND SWAPS
-- ============================================================================
alter table public.wf_swap_requests alter column from_staff_id drop not null;
alter table public.wf_swap_requests add column kind text not null default 'drop';
alter table public.wf_swap_requests add column note text;
alter table public.wf_swap_requests add column claimed_at timestamptz;
alter table public.wf_swap_requests add column decided_at timestamptz;
alter table public.wf_swap_requests add column decided_by_id text;
alter table public.wf_swap_requests add column decided_by_name text;
alter table public.wf_swap_requests add column decided_how text;
alter table public.wf_swap_requests add column shift_snapshot jsonb;
alter table public.wf_swap_requests add constraint wf_swap_requests_kind_check check (kind in ('drop', 'offer', 'claim'));
-- 'claimed' and 'denied' are the words the 20260608 comment used; kept so an old row stays valid.
alter table public.wf_swap_requests add constraint wf_swap_requests_status_check
  check (status in ('open', 'pending', 'approved', 'declined', 'cancelled', 'claimed', 'denied'));
alter table public.wf_swap_requests add constraint wf_swap_requests_note_len check (note is null or char_length(note) <= 300);
create unique index wf_swap_requests_one_live on public.wf_swap_requests (shift_id)
  where status in ('open', 'pending') and shift_id is not null;
create index wf_swap_requests_loc_status on public.wf_swap_requests (location_id, status);

comment on column public.wf_swap_requests.kind is
  'drop: the owner cannot work it, open to everyone in the position. offer: to one named colleague (to_staff_id). claim: someone claiming an open shift (20261031a).';
comment on column public.wf_swap_requests.status is
  'open: waiting for someone to take it. pending: someone took it, a manager decides. approved, declined, cancelled: closed.';
comment on column public.wf_swap_requests.decided_how is
  'manager (approved or declined in Back Office or the Manager app), automatic (the venue setting: straight away), colleague (declined an offer), owner (cancelled by the person who asked).';

-- ============================================================================
-- 3. US PAYROLL FIELDS
-- ============================================================================
alter table public.wf_staff add column payroll_employee_id text;
alter table public.wf_staff add column ssn_last4 text;
alter table public.wf_staff add constraint wf_staff_payroll_employee_id_len check (payroll_employee_id is null or char_length(payroll_employee_id) <= 40);
alter table public.wf_staff add constraint wf_staff_ssn_last4_check check (ssn_last4 is null or ssn_last4 ~ '^[0-9]{4}$');
comment on column public.wf_staff.payroll_employee_id is 'US: the payroll provider''s employee id, for the payroll export (20261031a).';
comment on column public.wf_staff.ssn_last4 is 'US: the last four digits of the Social Security number. Never the whole number (20261031a).';

-- ============================================================================
-- 4. THE JUDGE
-- ============================================================================

-- Paid hours of a shift: its computed hours, else its span less its break.
create function public._wf_shift_hours(p_shift public.wf_shifts)
returns numeric language sql immutable set search_path = public, pg_temp as $f$
  select coalesce(p_shift.computed_hours,
    greatest(0, extract(epoch from (
      (p_shift.shift_date + p_shift.finish_time + case when p_shift.finish_time <= p_shift.start_time then interval '1 day' else interval '0' end)
      - (p_shift.shift_date + p_shift.start_time))) / 3600.0 - coalesce(p_shift.break_mins, 0) / 60.0))
$f$;

-- Is this person's onboarding unfinished? The same rule as _shared/onboardingOpen.js (the staff
-- app and the Time Clock): their newest wf_onboarding row, each step done by its evidence or by a
-- step marked complete. p_bank_details false (a US venue) = the bank step is never open. No row:
-- nothing open. The rota will not schedule such a person (WfRota onboardingBlock), so they cannot
-- claim a shift either.
create function public._wf_onboarding_open(p_staff_id uuid, p_bank_details boolean)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  o public.wf_onboarding;
  st public.wf_staff;
  v_meta jsonb;
  v_steps jsonb;
begin
  select * into o from public.wf_onboarding where staff_id = p_staff_id order by created_at desc limit 1;
  if not found then return false; end if;
  select * into st from public.wf_staff where id = p_staff_id;
  v_meta := case when jsonb_typeof(o.meta) = 'object' then o.meta else '{}'::jsonb end;
  v_steps := case when jsonb_typeof(o.steps) = 'array' then o.steps else '[]'::jsonb end;
  -- A value counts as present when it is not missing, null, false, 0 or '' (as the JavaScript rule reads it).
  return exists (
    select 1 from (values
      ('offer', coalesce(v_meta -> 'offerAccepted' not in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb), false)
             or coalesce(v_meta -> 'offerSentAt' not in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb), false)),
      ('contract', coalesce(v_meta -> 'signature' not in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb), false)),
      ('rtw', coalesce(v_meta -> 'rtwPath' not in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb), false)),
      ('bank', not coalesce(p_bank_details, true)
             or coalesce(v_meta -> 'bankMasked' not in ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb), false)
             or coalesce(nullif(st.bank_account_masked, ''), '') <> ''),
      ('posUser', st.pos_user_id is not null)
    ) d(k, ok)
    where not d.ok
      and not exists (select 1 from jsonb_array_elements(v_steps) e where e ->> 'key' = d.k and e ->> 'status' = 'complete'));
end
$f$;

-- Why p_staff cannot take p_shift, or null. The same rules, in the same order, with the same
-- codes as _shared/openShiftRules.js claimProblem. p_deciding: a manager is deciding the request,
-- so the request's own state is not a reason.
create function public._wf_claim_problem(p_shift_id uuid, p_staff_id uuid, p_request_id uuid, p_deciding boolean)
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

-- Put p_staff on the shift, with their pay rate snapshotted as the clock does (workforce-clock
-- resolveRate: their own rate, else the position's base rate, else the salaried equivalent).
create function public._wf_assign(p_shift_id uuid, p_staff_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp as $f$
declare
  sh public.wf_shifts;
  st public.wf_staff;
  r public.wf_roles;
  v_rate numeric;
  v_src text;
begin
  select * into sh from public.wf_shifts where id = p_shift_id;
  select * into st from public.wf_staff where id = p_staff_id;
  if st.rate_override is not null then
    v_rate := st.rate_override; v_src := 'override';
  else
    select * into r from public.wf_roles where location_id = sh.location_id and key = coalesce(sh.role_key, st.role_key) limit 1;
    if r.base_rate is not null then v_rate := r.base_rate; v_src := 'base';
    elsif coalesce(r.salary_annual, 0) > 0 then v_rate := round(r.salary_annual / 52 / coalesce(nullif(r.contracted_week, 0), 40), 4); v_src := 'salaried';
    else v_rate := sh.effective_rate; v_src := sh.rate_source;
    end if;
  end if;
  update public.wf_shifts
     set staff_id = st.id,
         role_key = coalesce(sh.role_key, st.role_key),
         effective_rate = v_rate,
         rate_source = v_src,
         -- The planned cost scales with the rate: it holds hours x rate plus the venue's pay premiums,
         -- and a premium is a percent of the rate, so scaling keeps the premium exactly (the one rule,
         -- _shared/payPremiums.js, as the rota computed it). With no cost or rate before: hours x rate.
         computed_cost = case when v_rate is null then sh.computed_cost
                              when coalesce(sh.effective_rate, 0) > 0 and sh.computed_cost is not null then round(sh.computed_cost * v_rate / sh.effective_rate, 2)
                              else round(public._wf_shift_hours(sh) * v_rate, 2) end,
         updated_at = now()
   where id = sh.id;
end
$f$;

create function public._wf_shift_snapshot(p_shift public.wf_shifts)
returns jsonb language sql stable set search_path = public, pg_temp as $f$
  select jsonb_build_object('date', p_shift.shift_date, 'start', to_char(p_shift.start_time, 'HH24:MI'),
    'finish', to_char(p_shift.finish_time, 'HH24:MI'), 'role_key', p_shift.role_key, 'section', p_shift.section,
    'break_mins', p_shift.break_mins)
$f$;

-- A member of staff claims a shift (an open shift, a shift dropped to everyone, or one offered to
-- them). Locks the shift so the first claim wins. Answers { ok, code } or
-- { ok, outcome: 'assigned' | 'pending', request_id, from_staff_id }.
create function public.wf_shift_claim(p_staff_id uuid, p_shift_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $f$
declare
  sh public.wf_shifts;
  rq public.wf_swap_requests;
  v_code text;
  v_mode text;
  v_req uuid;
begin
  if p_staff_id is null or p_shift_id is null then
    raise exception using errcode = '22023', message = 'wf_shift_claim needs a staff member and a shift';
  end if;
  select * into sh from public.wf_shifts where id = p_shift_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_published'); end if;
  select * into rq from public.wf_swap_requests
   where shift_id = sh.id and status in ('open', 'pending') order by created_at desc limit 1 for update;
  -- The claimer too: two claims by one person on two overlapping shifts must not both pass the
  -- overlap check. Always shift first, then the person (wf_swap_decide takes them in that order).
  perform 1 from public.wf_staff where id = p_staff_id for update;
  v_code := public._wf_claim_problem(sh.id, p_staff_id, rq.id, false);
  if v_code is not null then return jsonb_build_object('ok', false, 'code', v_code); end if;

  select case when vs.settings -> 'shiftSwaps' ->> 'approval' = 'instant' then 'instant' else 'manager' end
    into v_mode from public.wf_venue_settings vs where vs.location_id = sh.location_id;
  v_mode := coalesce(v_mode, 'manager');

  if v_mode = 'manager' then
    if rq.id is null then
      insert into public.wf_swap_requests (location_id, org_id, shift_id, from_staff_id, to_staff_id, kind, status, claimed_at, shift_snapshot)
      values (sh.location_id, sh.org_id, sh.id, null, p_staff_id, 'claim', 'pending', now(), public._wf_shift_snapshot(sh))
      returning id into v_req;
    else
      update public.wf_swap_requests set to_staff_id = p_staff_id, status = 'pending', claimed_at = now(), updated_at = now()
       where id = rq.id;
      v_req := rq.id;
    end if;
    return jsonb_build_object('ok', true, 'outcome', 'pending', 'request_id', v_req, 'from_staff_id', sh.staff_id, 'shift_id', sh.id);
  end if;

  perform public._wf_assign(sh.id, p_staff_id);
  if rq.id is null then
    insert into public.wf_swap_requests (location_id, org_id, shift_id, from_staff_id, to_staff_id, kind, status, claimed_at,
                                         decided_at, decided_how, decided_by_name, shift_snapshot)
    values (sh.location_id, sh.org_id, sh.id, null, p_staff_id, 'claim', 'approved', now(), now(), 'automatic',
            'Venue setting: straight away', public._wf_shift_snapshot(sh))
    returning id into v_req;
  else
    update public.wf_swap_requests
       set to_staff_id = p_staff_id, status = 'approved', claimed_at = now(), decided_at = now(),
           decided_how = 'automatic', decided_by_name = 'Venue setting: straight away', updated_at = now()
     where id = rq.id;
    v_req := rq.id;
  end if;
  return jsonb_build_object('ok', true, 'outcome', 'assigned', 'request_id', v_req, 'from_staff_id', sh.staff_id, 'shift_id', sh.id);
end
$f$;

-- "I can't do this shift": the owner puts their published shift up, to everyone in the position
-- (p_to_staff_id empty) or offered to one colleague. Answers { ok, code } or { ok, request_id, kind }.
create function public.wf_shift_drop(p_staff_id uuid, p_shift_id uuid, p_to_staff_id uuid, p_note text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $f$
declare
  sh public.wf_shifts;
  co public.wf_staff;
  v_tz text;
  v_req uuid;
  v_kind text;
begin
  if p_staff_id is null or p_shift_id is null then
    raise exception using errcode = '22023', message = 'wf_shift_drop needs a staff member and a shift';
  end if;
  select * into sh from public.wf_shifts where id = p_shift_id for update;
  if not found or sh.status <> 'published' then return jsonb_build_object('ok', false, 'code', 'not_published'); end if;
  if sh.staff_id is distinct from p_staff_id then return jsonb_build_object('ok', false, 'code', 'not_yours'); end if;
  select coalesce(nullif(l.timezone, ''), 'Europe/London') into v_tz from public.locations l where l.id = sh.location_id;
  if sh.shift_date + sh.start_time <= date_trunc('minute', now() at time zone coalesce(v_tz, 'Europe/London')) then
    return jsonb_build_object('ok', false, 'code', 'past');
  end if;
  if exists (select 1 from public.wf_swap_requests r where r.shift_id = sh.id and r.status in ('open', 'pending')) then
    return jsonb_build_object('ok', false, 'code', 'already_up');
  end if;
  if p_to_staff_id is not null then
    select * into co from public.wf_staff where id = p_to_staff_id;
    if not found or co.id = p_staff_id or co.status is distinct from 'active' or co.location_id is distinct from sh.location_id
       or (sh.role_key is not null and co.role_key is distinct from sh.role_key) then
      return jsonb_build_object('ok', false, 'code', 'colleague');
    end if;
  end if;
  v_kind := case when p_to_staff_id is null then 'drop' else 'offer' end;
  insert into public.wf_swap_requests (location_id, org_id, shift_id, from_staff_id, to_staff_id, kind, status, note, shift_snapshot)
  values (sh.location_id, sh.org_id, sh.id, p_staff_id, p_to_staff_id, v_kind, 'open', nullif(left(btrim(coalesce(p_note, '')), 300), ''),
          public._wf_shift_snapshot(sh))
  returning id into v_req;
  return jsonb_build_object('ok', true, 'request_id', v_req, 'kind', v_kind, 'shift_id', sh.id);
end
$f$;

-- The person who asked takes it back (open or pending), or the claimer withdraws while a manager
-- has not decided yet (a dropped or offered shift goes back to waiting, a claim on an open shift closes).
create function public.wf_swap_cancel(p_staff_id uuid, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $f$
declare
  rq public.wf_swap_requests;
begin
  select * into rq from public.wf_swap_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if rq.from_staff_id = p_staff_id and rq.status in ('open', 'pending') then
    update public.wf_swap_requests set status = 'cancelled', decided_at = now(), decided_how = 'owner', updated_at = now() where id = rq.id;
    return jsonb_build_object('ok', true, 'outcome', 'cancelled');
  end if;
  if rq.to_staff_id = p_staff_id and rq.status = 'pending' then
    if rq.kind = 'claim' then
      update public.wf_swap_requests set status = 'cancelled', decided_at = now(), decided_how = 'owner', updated_at = now() where id = rq.id;
      return jsonb_build_object('ok', true, 'outcome', 'cancelled');
    end if;
    update public.wf_swap_requests
       set status = 'open', claimed_at = null, to_staff_id = case when rq.kind = 'offer' then rq.to_staff_id else null end, updated_at = now()
     where id = rq.id;
    return jsonb_build_object('ok', true, 'outcome', 'reopened');
  end if;
  return jsonb_build_object('ok', false, 'code', 'not_yours');
end
$f$;

-- The named colleague says no to an offer.
create function public.wf_swap_decline(p_staff_id uuid, p_request_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $f$
declare
  rq public.wf_swap_requests;
begin
  select * into rq from public.wf_swap_requests where id = p_request_id for update;
  if not found or rq.kind <> 'offer' or rq.to_staff_id is distinct from p_staff_id or rq.status <> 'open' then
    return jsonb_build_object('ok', false, 'code', 'not_yours');
  end if;
  update public.wf_swap_requests set status = 'declined', decided_at = now(), decided_how = 'colleague', updated_at = now() where id = rq.id;
  return jsonb_build_object('ok', true, 'outcome', 'declined', 'from_staff_id', rq.from_staff_id, 'shift_id', rq.shift_id);
end
$f$;

-- A manager approves or declines a pending request at p_location_id. Approving checks every rule
-- again under the lock (the rota may have moved since the claim). p_actor: { id, name } of the
-- manager, proven by the edge function (PIN or Back Office login).
create function public.wf_swap_decide(p_location_id uuid, p_request_id uuid, p_decision text, p_actor jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $f$
declare
  rq public.wf_swap_requests;
  sh public.wf_shifts;
  v_shift uuid;
  v_code text;
  v_by_id text := nullif(left(coalesce(p_actor ->> 'id', ''), 80), '');
  v_by_name text := coalesce(nullif(left(coalesce(p_actor ->> 'name', ''), 120), ''), 'Manager');
begin
  if p_decision not in ('approved', 'declined') then
    raise exception using errcode = '22023', message = 'decision must be approved or declined';
  end if;
  -- Lock order as wf_shift_claim: the shift, then the request, then the person (no deadlock).
  select r.shift_id into v_shift from public.wf_swap_requests r where r.id = p_request_id and r.location_id = p_location_id;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found'); end if;
  if v_shift is not null then
    select * into sh from public.wf_shifts where id = v_shift for update;
  end if;
  select * into rq from public.wf_swap_requests where id = p_request_id for update;
  if rq.status <> 'pending' then return jsonb_build_object('ok', false, 'code', 'not_pending'); end if;
  if rq.to_staff_id is not null then
    perform 1 from public.wf_staff where id = rq.to_staff_id for update;
  end if;
  if sh.id is null then
    update public.wf_swap_requests set status = 'cancelled', decided_at = now(), decided_how = 'manager',
           decided_by_id = v_by_id, decided_by_name = v_by_name, updated_at = now() where id = rq.id;
    return jsonb_build_object('ok', false, 'code', 'shift_gone');
  end if;
  if p_decision = 'declined' then
    -- A colleague's claim on a DROPPED shift (open to everyone in the position): declining that claim
    -- puts the shift back up for someone else, nobody on the request. The decline itself is in the
    -- audit (manager-approve writes it). A direct swap (an offer to one named colleague) or a claim on
    -- an open shift closes; the open shift itself stays open for others.
    if rq.kind = 'drop' then
      update public.wf_swap_requests set status = 'open', to_staff_id = null, claimed_at = null, updated_at = now() where id = rq.id;
      return jsonb_build_object('ok', true, 'outcome', 'reopened', 'shift_id', sh.id, 'from_staff_id', rq.from_staff_id, 'to_staff_id', rq.to_staff_id);
    end if;
    update public.wf_swap_requests set status = 'declined', decided_at = now(), decided_how = 'manager',
           decided_by_id = v_by_id, decided_by_name = v_by_name, updated_at = now() where id = rq.id;
    return jsonb_build_object('ok', true, 'outcome', 'declined', 'shift_id', sh.id, 'from_staff_id', rq.from_staff_id, 'to_staff_id', rq.to_staff_id);
  end if;
  if rq.kind <> 'claim' and sh.staff_id is distinct from rq.from_staff_id then
    return jsonb_build_object('ok', false, 'code', 'not_offered');
  end if;
  v_code := public._wf_claim_problem(sh.id, rq.to_staff_id, rq.id, true);
  if v_code is not null then return jsonb_build_object('ok', false, 'code', v_code); end if;
  perform public._wf_assign(sh.id, rq.to_staff_id);
  update public.wf_swap_requests set status = 'approved', decided_at = now(), decided_how = 'manager',
         decided_by_id = v_by_id, decided_by_name = v_by_name, updated_at = now() where id = rq.id;
  return jsonb_build_object('ok', true, 'outcome', 'assigned', 'shift_id', sh.id, 'from_staff_id', sh.staff_id, 'to_staff_id', rq.to_staff_id);
end
$f$;

-- Only the service role (the edge functions) may run the judge or its helpers.
do $grants$
declare
  f text;
begin
  foreach f in array array[
    'public._wf_shift_hours(public.wf_shifts)', 'public._wf_onboarding_open(uuid,boolean)', 'public._wf_claim_problem(uuid,uuid,uuid,boolean)',
    'public._wf_assign(uuid,uuid)', 'public._wf_shift_snapshot(public.wf_shifts)',
    'public.wf_shift_claim(uuid,uuid)', 'public.wf_shift_drop(uuid,uuid,uuid,text)',
    'public.wf_swap_cancel(uuid,uuid)', 'public.wf_swap_decline(uuid,uuid)',
    'public.wf_swap_decide(uuid,uuid,text,jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$grants$;

-- ============================================================================
-- 5. wf_swap_requests: writes only through the judge
-- ============================================================================
drop policy if exists wf_swap_requests_rls_insert on public.wf_swap_requests;
drop policy if exists wf_swap_requests_rls_update on public.wf_swap_requests;
drop policy if exists wf_swap_requests_rls_delete on public.wf_swap_requests;
revoke select, insert, update, delete on public.wf_swap_requests from anon;
revoke insert, update, delete on public.wf_swap_requests from authenticated;
grant select on public.wf_swap_requests to authenticated;
grant select, insert, update, delete on public.wf_swap_requests to service_role;

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: staff_id_optional true, new_request_columns 8, staff_columns 2,
-- judge_functions 10, judge_open_to_api false, direct_write_policies 0, anon_can_read false,
-- authenticated_can_write false, authenticated_can_read true, live_requests 1 (the Provo test row).
select
  (select is_nullable = 'YES' from information_schema.columns
    where table_schema = 'public' and table_name = 'wf_shifts' and column_name = 'staff_id') as staff_id_optional,
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'wf_swap_requests'
      and column_name in ('kind', 'note', 'claimed_at', 'decided_at', 'decided_by_id', 'decided_by_name', 'decided_how', 'shift_snapshot')) as new_request_columns,
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'wf_staff' and column_name in ('payroll_employee_id', 'ssn_last4')) as staff_columns,
  (select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('_wf_shift_hours', '_wf_onboarding_open', '_wf_claim_problem', '_wf_assign', '_wf_shift_snapshot', 'wf_shift_claim',
                      'wf_shift_drop', 'wf_swap_cancel', 'wf_swap_decline', 'wf_swap_decide')) as judge_functions,
  exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace
    and p.proname in ('_wf_shift_hours', '_wf_onboarding_open', '_wf_claim_problem', '_wf_assign', '_wf_shift_snapshot', 'wf_shift_claim',
                      'wf_shift_drop', 'wf_swap_cancel', 'wf_swap_decline', 'wf_swap_decide')
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) as judge_open_to_api,
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'wf_swap_requests'
    and policyname in ('wf_swap_requests_rls_insert', 'wf_swap_requests_rls_update', 'wf_swap_requests_rls_delete')) as direct_write_policies,
  has_table_privilege('anon', 'public.wf_swap_requests', 'select') as anon_can_read,
  (has_table_privilege('authenticated', 'public.wf_swap_requests', 'insert')
    or has_table_privilege('authenticated', 'public.wf_swap_requests', 'update')
    or has_table_privilege('authenticated', 'public.wf_swap_requests', 'delete')) as authenticated_can_write,
  has_table_privilege('authenticated', 'public.wf_swap_requests', 'select') as authenticated_can_read,
  (select count(*)::int from public.wf_swap_requests where status in ('open', 'pending')) as live_requests;
