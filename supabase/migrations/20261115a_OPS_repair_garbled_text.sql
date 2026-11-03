-- 20261115a_OPS_repair_garbled_text.sql (5.12.42, RUN 3 Nov 2026 by Peter in the SQL editor).
-- Pastes made through a clipboard with no UTF-8 setting turned pound signs and emoji into
-- Mac Roman text. This puts the live function text back. ASCII only on purpose.

-- ServOS 5.12.42: functions whose text was garbled by a Mac Roman clipboard paste.
-- Same live definitions; only the garbled characters change. ASCII only on purpose.
begin;
CREATE OR REPLACE FUNCTION public._osd_name(p_name text, p_format text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$
declare
  n text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  parts text[];
  first_part text;
  last_initial text;
begin
  if coalesce(p_format, 'short') = 'number' or n = '' then return null; end if;
  -- An @ or any digit (a phone number, an email address, a flat or table number) never shows.
  if n ~ '@|\d' then return null; end if;
  if n ~* '^(order\s*#?\s*\d+|hubrise customer|ezcater customer|guest|customer|walk\s*-?\s*in|counter|dine\s*-?\s*in|eat\s*-?\s*in|take\s*-?\s*away|collection|delivery|drive\s*-?\s*thru|drive\s*-?\s*through|table\s*\S+)$'
     or n ~ '^[0-9#\s]+$' then
    return null;
  end if;
  -- Letters, spaces, apostrophes and hyphens only, so a web address cannot render.
  n := btrim(regexp_replace(regexp_replace(n, '[^[:alpha:][:space:]''' || chr(8217) || '-]', '', 'g'), '\s+', ' ', 'g'));
  if n !~ '[[:alpha:]]' then return null; end if;
  if n ~* '^(order\s*#?\s*\d+|hubrise customer|ezcater customer|guest|customer|walk\s*-?\s*in|counter|dine\s*-?\s*in|eat\s*-?\s*in|take\s*-?\s*away|collection|delivery|drive\s*-?\s*thru|drive\s*-?\s*through|table\s*\S+)$' then
    return null;
  end if;
  if p_format = 'full' then return left(n, 24); end if;
  parts := string_to_array(n, ' ');
  first_part := left(parts[1], 16);
  if array_length(parts, 1) = 1 then return first_part; end if;
  last_initial := upper(left(regexp_replace(parts[array_length(parts, 1)], '[^[:alpha:]]', '', 'g'), 1));
  if coalesce(last_initial, '') = '' then return first_part; end if;
  return first_part || ' ' || last_initial;
end $function$;
CREATE OR REPLACE FUNCTION public.terminal_start_table_payment(p_table_id text, p_staff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t          terminal_devices;
  a          active_sessions;
  v_staff    record;
  v_key      text;
  v_bill     bigint;
  v_job      uuid := gen_random_uuid();
  v_ccid     text;
  v_currency text;
  v_tipcfg   jsonb;
  v_draft    jsonb;
  v_credit   jsonb;             -- 16 Oct 2026
  v_credit_minor bigint := 0;   -- 16 Oct 2026
begin
  t := _terminal_for_caller();

  select s.id, s.name, s.role into v_staff
    from staff_members s
   where s.id = p_staff_id and s.location_id = t.location_id and s.active
   limit 1;
  if v_staff.id is null then raise exception 'staff member not valid at this location'; end if;
  if coalesce(v_staff.role, '') = 'Kitchen' then raise exception 'this role cannot take payment'; end if;

  select * into a from active_sessions
   where location_id = t.location_id and table_id = p_table_id
   limit 1;
  if a.table_id is null then raise exception 'table is not open'; end if;

  if a.total_minor is null then
    raise exception 'this table has no server-side total yet: open and re-save it on the POS first';
  end if;
  v_bill := a.total_minor;
  if v_bill <= 0 then raise exception 'nothing to pay on this table'; end if;

  v_key := t.location_id::text || ':' || p_table_id || ':' || coalesce(a.session ->> 'id', '-');

  if exists (select 1 from terminal_jobs j
              where j.check_key = v_key
                and j.status = 'approved'
                and (
                      (j.check_draft ->> 'seatedAt') is not null
                        and j.check_draft ->> 'seatedAt' = a.session ->> 'seatedAt'
                   or (j.check_draft ->> 'seatedAt') is null
                        and j.created_at > now() - interval '2 hours'
                    )) then
    raise exception 'this table has already been paid: wait for it to finish closing';
  end if;
  if exists (select 1 from terminal_jobs j
              where j.check_key = v_key
                and j.status in ('pending','claimed','tipping','charging_unsent','charging','unknown')) then
    raise exception 'this table already has a payment in progress';
  end if;
  if exists (select 1 from terminal_jobs j
              where j.target_terminal_id = t.id
                and j.status in ('claimed','tipping','charging_unsent','charging','unknown')) then
    raise exception 'this terminal is already taking a payment';
  end if;

  select coalesce(l.currency, 'GBP') into v_currency from locations l where l.id = t.location_id;

  -- 16 Oct 2026 (bookings audit item 1): the booking money comes off first; when it covers the
  -- whole bill there is nothing to take on the terminal.
  v_credit := public._booking_credit_for_session(t.location_id, a.session, v_bill);
  v_credit_minor := coalesce((v_credit ->> 'appliedMinor')::bigint, 0);
  if v_credit_minor > 0 and v_credit_minor >= v_bill then
    raise exception 'this table was paid in advance (% on the booking): close it on the till',
      (case upper(v_currency) when 'GBP' then chr(163) when 'USD' then '$' when 'EUR' then chr(8364) else upper(v_currency) || ' ' end)
      || to_char(v_credit_minor / 100.0, 'FM999999990.00');
  end if;
  v_bill := v_bill - v_credit_minor;   -- 16 Oct 2026: what is left to take

  v_tipcfg := coalesce(t.tip_config, jsonb_build_object('enabled', false));

  v_ccid := 'chk-' || (extract(epoch from now()) * 1000)::bigint::text
            || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);

  v_draft := jsonb_build_object(
    'id',          v_ccid,
    'tableId',     p_table_id,
    'tableLabel',  coalesce((select f.label from floor_tables f
                              where f.id = p_table_id and f.location_id = t.location_id::text), p_table_id),
    'locationId',  t.location_id,
    'sessionId',   a.session ->> 'id',
    'server',      coalesce(v_staff.name, a.session ->> 'server'),
    'staffId',     v_staff.id,
    'covers',      coalesce((a.session ->> 'covers')::int, 1),
    'orderType',   'dine-in',
    'items',       coalesce(a.session -> 'items', '[]'::jsonb),
    'discounts',   coalesce(a.session -> 'discounts', '[]'::jsonb),
    'seatedAt',    a.session ->> 'seatedAt',
    'subtotalMinor', a.subtotal_minor,
    'totalMinor',    a.total_minor,
    'currency',    v_currency,
    'source',      'pax_table_pay'
  );
  -- 16 Oct 2026: the tender legs the closer books for the booking money.
  if v_credit_minor > 0 then
    v_draft := v_draft || jsonb_build_object(
      'bookingCreditMinor', v_credit_minor,
      'bookingPayment', jsonb_build_object(
        'bookingId',    v_credit ->> 'bookingId',
        'appliedMinor', v_credit_minor,
        'legs',         v_credit -> 'legs'));
  end if;

  insert into terminal_jobs (
    id, check_key, location_id, target_terminal_id, pos_device_id, training,
    tip_basis_minor, due_minor, currency, tip_config, closed_check_id, check_draft,
    status, processor, claim_expires_at, dispatched_at
  ) values (
    v_job, v_key,
    t.location_id,
    t.id, null,
    false,
    v_bill,
    v_bill,
    v_currency, v_tipcfg, v_ccid, v_draft,
    'pending', 'ryft',
    now() + interval '15 minutes',
    now()
  );

  return jsonb_build_object(
    'job_id',          v_job,
    'tip_basis_minor', v_bill,
    'due_minor',       v_bill,
    'currency',        v_currency,
    'tip_config',      v_tipcfg
  );
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_start_table_payment_for(p_terminal_device_id uuid, p_table_id text, p_amount_minor bigint DEFAULT NULL::bigint, p_session_id text DEFAULT NULL::text, p_seated_at text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  t           public.terminal_devices%rowtype;
  a           public.active_sessions%rowtype;
  v_demo      boolean;
  v_key       text;
  v_bill      bigint;
  v_paid      bigint;
  v_prior     jsonb;
  v_remaining bigint;
  v_due       bigint;
  v_final     boolean;
  v_job       uuid := gen_random_uuid();
  v_ccid      text;
  v_currency  text;
  v_tipcfg    jsonb;
  v_draft     jsonb;
  v_credit    jsonb;            -- 16 Oct 2026
  v_credit_minor bigint := 0;   -- 16 Oct 2026
begin
  select * into t from public.terminal_devices
   where id = p_terminal_device_id and status = 'paired' and active
   limit 1;
  if t.id is null then raise exception 'terminal not paired'; end if;

  -- Demo reader (v5.6.95): the terminal row's own serial is the authority.
  v_demo := upper(coalesce(t.serial_number, '')) like 'DEMO-%';

  if t.adyen_terminal_id is null and not v_demo then
    raise exception 'terminal has no Adyen link';
  end if;
  if coalesce((t.modes ->> 'table_pay')::boolean, true) = false then
    raise exception 'Table Pay is switched off for this terminal';
  end if;

  select * into a from public.active_sessions
   where location_id = t.location_id and table_id = p_table_id
   limit 1;
  if a.table_id is null then raise exception 'table is not open'; end if;
  if a.total_minor is null then
    raise exception 'this table has no server-side total yet: open and re-save it on the POS first';
  end if;

  v_key := t.location_id::text || ':' || p_table_id || ':' || coalesce(a.session ->> 'id', '-');

  -- SERIALISE every reader/till decision on this check.
  perform pg_advisory_xact_lock(hashtextextended(v_key, 0));

  -- Occupation pin: refuse if the party changed while staff were on the menus.
  if p_session_id is not null and (a.session ->> 'id') is distinct from p_session_id then
    raise exception 'this table changed while you were choosing: start again';
  end if;
  if p_seated_at is not null and (a.session ->> 'seatedAt') is distinct from p_seated_at then
    raise exception 'this table changed while you were choosing: start again';
  end if;

  v_bill := a.total_minor;
  if v_bill <= 0 then raise exception 'nothing to pay on this table'; end if;

  -- CROSS-SOURCE guard (restores 20260814d).
  if exists (select 1 from public.terminal_jobs j
              where j.check_key = v_key
                and coalesce(j.check_draft ->> 'source', '') <> 'adyen_pay_at_table'
                and (j.status in ('pending','claimed','tipping','charging_unsent','charging','unknown')
                     or (j.status = 'approved' and j.created_at > now() - interval '6 hours'))) then
    raise exception 'this table has already been paid or has a payment in progress';
  end if;

  -- Paid so far on THIS occupation.
  select paid, legs into v_paid, v_prior
    from public._terminal_paid_legs_for(t.location_id, p_table_id, a.session ->> 'id', a.session ->> 'seatedAt');

  select coalesce(l.currency, 'GBP') into v_currency from public.locations l where l.id = t.location_id;

  -- 16 Oct 2026 (bookings audit item 1): money the guest already paid for this booking comes
  -- off the bill first. When it covers the whole bill there is nothing to take on the reader.
  v_credit := public._booking_credit_for_session(t.location_id, a.session, v_bill);
  v_credit_minor := coalesce((v_credit ->> 'appliedMinor')::bigint, 0);
  if v_credit_minor > 0 and v_credit_minor >= v_bill then
    raise exception 'this table was paid in advance (% on the booking): close it on the till',
      (case upper(v_currency) when 'GBP' then chr(163) when 'USD' then '$' when 'EUR' then chr(8364) else upper(v_currency) || ' ' end)
      || to_char(v_credit_minor / 100.0, 'FM999999990.00');
  end if;

  v_remaining := v_bill - v_credit_minor - v_paid;   -- 16 Oct 2026: less the booking money
  if v_remaining <= 0 then
    if v_paid > 0 then
      raise exception 'this table is fully paid (% already taken on the reader): settle any difference on the till',
        to_char(v_paid / 100.0, 'FM999999990.00');
    end if;
    raise exception 'this table has already been paid';
  end if;

  -- One live leg per check and per terminal.
  if exists (select 1 from public.terminal_jobs j
              where j.check_key = v_key
                and j.status in ('pending','claimed','tipping','charging_unsent','charging','unknown')) then
    raise exception 'this table already has a payment in progress';
  end if;
  if exists (select 1 from public.terminal_jobs j
              where j.target_terminal_id = t.id
                and j.status in ('claimed','tipping','charging_unsent','charging','unknown')) then
    raise exception 'this terminal is already taking a payment';
  end if;

  if p_amount_minor is not null and p_amount_minor <= 0 then
    raise exception 'invalid split amount';
  end if;
  v_due   := coalesce(least(p_amount_minor, v_remaining), v_remaining);
  v_final := (v_due = v_remaining);

  v_tipcfg := coalesce(t.tip_config, jsonb_build_object('enabled', false));

  v_ccid := 'chk-' || (extract(epoch from now()) * 1000)::bigint::text
            || '-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 6);

  v_draft := jsonb_build_object(
    'id',          v_ccid,
    'tableId',     p_table_id,
    'tableLabel',  coalesce((select f.label from public.floor_tables f
                              where f.id = p_table_id and f.location_id = t.location_id::text), p_table_id),
    'locationId',  t.location_id,
    'sessionId',   a.session ->> 'id',
    'server',      coalesce(a.session ->> 'server', 'Pay at table'),
    'covers',      coalesce((a.session ->> 'covers')::int, 1),
    'orderType',   'dine-in',
    'items',       coalesce(a.session -> 'items', '[]'::jsonb),
    'discounts',   coalesce(a.session -> 'discounts', '[]'::jsonb),
    'seatedAt',    a.session ->> 'seatedAt',
    'subtotalMinor', a.subtotal_minor,
    'totalMinor',    a.total_minor,
    'currency',    v_currency,
    'source',      'adyen_pay_at_table',
    'billMinor',           v_bill,
    'paidBeforeMinor',     v_paid,
    'remainingAfterMinor', v_remaining - v_due,
    'partial',             (not v_final)
  );
  if v_final and v_paid > 0 then
    v_draft := v_draft || jsonb_build_object('priorLegs', v_prior);
  end if;
  -- 16 Oct 2026: every leg says how much booking money came off; the FINAL leg carries the
  -- tender legs, so the check it books (store closeApprovedTerminalJob) records them and
  -- stamps the booking's ledger rows applied with the amount used.
  if v_credit_minor > 0 then
    v_draft := v_draft || jsonb_build_object('bookingCreditMinor', v_credit_minor);
    if v_final then
      v_draft := v_draft || jsonb_build_object('bookingPayment', jsonb_build_object(
        'bookingId',    v_credit ->> 'bookingId',
        'appliedMinor', v_credit_minor,
        'legs',         v_credit -> 'legs'));
    end if;
  end if;

  insert into public.terminal_jobs (
    id, check_key, location_id, target_terminal_id, pos_device_id, training,
    tip_basis_minor, due_minor, charge_minor, currency, tip_config, closed_check_id, check_draft,
    status, processor, simulated, claim_expires_at, dispatched_at
  ) values (
    v_job, v_key, t.location_id, t.id, null, false,
    v_due, v_due,
    case when v_demo then null else v_due end,
    v_currency, v_tipcfg, v_ccid, v_draft,
    case when v_demo then 'pending' else 'charging_unsent' end,
    case when v_demo then 'ryft' else 'adyen' end,
    v_demo,
    now() + interval '15 minutes',
    now()
  );

  return jsonb_build_object(
    'job_id', v_job, 'due_minor', v_due, 'currency', v_currency,
    'bill_minor', v_bill, 'paid_before_minor', v_paid,
    'remaining_after_minor', v_remaining - v_due, 'partial', (not v_final),
    'simulated', v_demo,
    'booking_credit_minor', v_credit_minor   -- 16 Oct 2026
  );
end; $function$;
CREATE OR REPLACE FUNCTION public.set_terminal_settings(p_terminal_id uuid, p_tip_config jsonb DEFAULT NULL::jsonb, p_bound_pos_device_id uuid DEFAULT NULL::uuid, p_modes jsonb DEFAULT NULL::jsonb, p_label text DEFAULT NULL::text, p_idle_screen jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t terminal_devices;
begin
  if auth.uid() is null then raise exception 'no session'; end if;
  if p_terminal_id is null then raise exception 'terminal required'; end if;

  select * into t from terminal_devices where id = p_terminal_id;
  if t.id is null then raise exception 'terminal not found'; end if;

  -- -- THE FENCE --------------------------------------------------------------
  -- Identical to claim_terminal_device: the manager must have access to the
  -- location, via user_locations or super_admin. Read off the TERMINAL'S OWN ROW,
  -- never from an argument: the caller does not get to nominate the location
  -- they are allowed to write to. (Rule 3 of 20260722c.)
  if not _terminal_user_has_location(t.location_id) then
    raise exception 'no access to this terminal';
  end if;

  -- -- CROSS-LOCATION VALIDATION ----------------------------------------------
  -- A terminal bound to another venue's till is a cross-tenant payment hazard:
  -- terminal_targets_for_pos would hand that till a terminal in a different
  -- building and a card would be presented to the wrong customer. Both halves are
  -- checked: same location AND actually a POS.
  --
  -- devices.location_id and terminal_devices.location_id are both uuid, so this
  -- compares directly. (floor_tables.location_id and closed_checks.location_id
  -- are TEXT in this schema: do not copy this line to those tables without
  -- casting the uuid side DOWN to text; 'loc-demo' is not a valid uuid and ::uuid
  -- throws 22P02.)
  if p_bound_pos_device_id is not null then
    if not exists (
      select 1 from devices d
       where d.id = p_bound_pos_device_id
         and d.location_id = t.location_id
         and d.type in ('pos', 'kiosk', 'handheld')
    ) then
      raise exception 'that device is not a POS till, MPOS or kiosk at this terminal''s venue';
    end if;
  end if;

  update terminal_devices
     set tip_config          = _terminal_norm_tip_config(p_tip_config),
         bound_pos_device_id = p_bound_pos_device_id,
         modes               = _terminal_norm_modes(p_modes),
         idle_screen         = _terminal_norm_idle_screen(p_idle_screen),
         label               = coalesce(nullif(btrim(coalesce(p_label, '')), ''), label, 'Card terminal'),
         updated_at          = now()
   where id = t.id;

  return jsonb_build_object('ok', true, 'terminal_id', t.id);
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_commit_tip(p_job_id uuid, p_tip_minor bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t terminal_devices; j terminal_jobs; v_tip bigint; v_charge bigint;
begin
  t := _terminal_for_caller();

  select * into j from terminal_jobs
   where id = p_job_id and target_terminal_id = t.id
   for update;
  if j.id is null then raise exception 'job not found'; end if;
  if j.training then raise exception 'training job: no card may be charged'; end if;
  if j.status not in ('claimed','tipping') then
    raise exception 'job is not awaiting a tip (status %)', j.status;
  end if;

  v_tip    := least(greatest(coalesce(p_tip_minor, 0), 0), greatest(j.tip_basis_minor, 2000));
  v_charge := j.due_minor + v_tip;

  update terminal_jobs
     set tip_minor    = v_tip,
         charge_minor = v_charge,
         charged_at   = now(),         -- stamped BEFORE the controller is launched
         status       = 'charging_unsent',
         updated_at   = now()
   where id = j.id;

  return jsonb_build_object('charge_minor', v_charge);
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_job_cancel(p_job_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare j terminal_jobs; v_ok boolean;
begin
  if auth.uid() is null then raise exception 'no session'; end if;

  select * into j from terminal_jobs where id = p_job_id for update;
  if j.id is null then raise exception 'job not found'; end if;

  select (
    _terminal_user_has_location(j.location_id)
    or exists (select 1 from devices d where d.device_uid = auth.uid() and d.location_id = j.location_id)
  ) into v_ok;
  if not v_ok then raise exception 'no access to this job'; end if;

  if j.charged_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already charging: cannot cancel', 'status', j.status);
  end if;
  if j.status not in ('pending','claimed','tipping') then
    return jsonb_build_object('ok', false, 'reason', 'job is no longer cancellable', 'status', j.status);
  end if;

  update terminal_jobs
     set status = 'cancelled', settled_at = now(), updated_at = now(),
         last_error = coalesce(last_error, 'cancelled from the POS')
   where id = j.id;

  return jsonb_build_object('ok', true, 'status', 'cancelled');
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_jobs_sweep(p_limit integer DEFAULT 200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_expired int := 0; v_cancelled int := 0; v_unknown int := 0;
begin
  if not _terminal_is_service_role() then raise exception 'service role required'; end if;

  with due as (
    select id from terminal_jobs
     where claim_expires_at is not null and claim_expires_at < now()
       and status in ('pending','claimed','tipping')
     order by claim_expires_at limit p_limit for update skip locked
  )
  update terminal_jobs j set status = 'expired', updated_at = now(),
         last_error = coalesce(j.last_error, 'lease expired before dispatch')
    from due where j.id = due.id;
  get diagnostics v_expired = row_count;

  with due as (
    select id from terminal_jobs
     where claim_expires_at is not null and claim_expires_at < now()
       and status = 'charging_unsent'
     order by claim_expires_at limit p_limit for update skip locked
  )
  update terminal_jobs j set status = 'cancelled', updated_at = now(),
         last_error = coalesce(j.last_error, 'tip taken but request never dispatched')
    from due where j.id = due.id;
  get diagnostics v_cancelled = row_count;

  with due as (
    select id from terminal_jobs
     where claim_expires_at is not null and claim_expires_at < now()
       and status = 'charging'
     order by claim_expires_at limit p_limit for update skip locked
  )
  update terminal_jobs j set status = 'unknown', needs_human = true, updated_at = now(),
         reconcile_attempts = j.reconcile_attempts + 1,
         last_error = coalesce(j.last_error, 'dispatched but no result received: outcome not established')
    from due where j.id = due.id;
  get diagnostics v_unknown = row_count;

  return jsonb_build_object('expired', v_expired, 'cancelled', v_cancelled, 'unknown', v_unknown);
end; $function$;
CREATE OR REPLACE FUNCTION public.terminal_staff_login(p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare t terminal_devices; m record; v_pin text := btrim(coalesce(p_pin, ''));
begin
  t := _terminal_for_caller();

  if t.pin_locked_until is not null and t.pin_locked_until > now() then
    raise exception 'too many incorrect PINs: try again in a minute';
  end if;

  if v_pin = '' then return null; end if;

  select s.id, s.name, s.role into m
    from staff_members s
   where s.location_id = t.location_id      -- the fence: this terminal's venue only
     and s.active
     and s.pin is not null
     and s.pin::text = v_pin
   limit 1;

  if m.id is null then
    update terminal_devices
       set pin_fail_count  = pin_fail_count + 1,
           pin_locked_until = case when pin_fail_count + 1 >= 5 then now() + interval '5 minutes' else pin_locked_until end,
           updated_at = now()
     where id = t.id;
    -- Reset the counter once the lock is applied, so the next window starts clean.
    update terminal_devices set pin_fail_count = 0 where id = t.id and pin_locked_until > now();
    return null;
  end if;

  update terminal_devices
     set pin_fail_count = 0, pin_locked_until = null, last_seen_at = now(), updated_at = now()
   where id = t.id;

  -- There is no dedicated "take payment" permission in staff_members today (see
  -- PERM_GROUPS in StaffManager.jsx). Kitchen is the one POS role that never
  -- handles a card; everyone else on the floor does. Narrow this the moment a
  -- real permission exists: do not widen it.
  return jsonb_build_object(
    'staff_id',         m.id,
    'name',             m.name,
    'can_take_payment', coalesce(m.role, '') is distinct from 'Kitchen'
  );
end; $function$;
CREATE OR REPLACE FUNCTION public.tg_order_queue_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  evt text;
begin
  if tg_op = 'INSERT' then
    -- Age gate: a "confirmed" for an order placed >6h ago is never right: it is a
    -- stale device replaying its queue, not a customer placing an order.
    if coalesce(new.created_at, now()) < now() - interval '6 hours' then
      return new;
    end if;
    evt := 'confirmed';
  elsif new.status = 'ready' and coalesce(old.status, '') <> 'ready' then
    evt := 'ready';
  else
    return new;
  end if;

  -- Fire-and-forget: a notification failure must never fail the order itself.
  -- location_id: refs are per venue, so the function needs both to find the one order.
  begin
    perform net.http_post(
      url := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/order-notify',
      body := jsonb_build_object('ref', new.ref, 'event', evt, 'location_id', new.location_id),
      headers := jsonb_build_object('Content-Type', 'application/json')
    );
  exception when others then
    null;
  end;

  return new;
end;
$function$;
comment on function terminal_jobs_sweep_cron() is 'pg_cron entry point for terminal_jobs_sweep(). Sets the service_role claim transaction-locally so the sweep''s own fence passes. Revoked from anon/authenticated: this is the only caller permitted to bypass that guard.';
comment on column public.active_sessions.paid_minor is 'Sum of settled on-reader split legs for THIS occupation (minor units). Server-written; the bill (total_minor) is unchanged: this is what has already been collected against it.';
commit;
