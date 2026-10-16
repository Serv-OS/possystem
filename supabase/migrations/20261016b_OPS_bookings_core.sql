-- 20261016b_OPS_bookings_core.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Additive and safe to run twice. One transaction. No table is rewritten:  #
-- #  three nullable columns on booking_payments, one new internal helper,     #
-- #  one new RPC (edit_booking), and five functions replaced in place.        #
-- #  apply_booking_payment gains an optional third argument: the 2 argument   #
-- #  version is DROPPED and the 3 argument one created in this same          #
-- #  transaction, grants re issued, so every caller alive today (2 named     #
-- #  arguments) keeps working through the default.                           #
-- #  Safe in service: the tills keep working before and after (the app       #
-- #  feature detects every change and falls back to today's behaviour).      #
-- ############################################################################
--
-- WHY (bookings audit, 16 Oct 2026, section 2)
--   1  Reader double charge. Pay at table on the Adyen reader and PAX Table Pay charged the
--      whole bill on a table seated from a prepaid or deposit booking. The booking money was
--      ignored and stayed unapplied. Now both start functions take off the captured, unapplied
--      booking money, write bookingPayment { bookingId, appliedMinor, legs } into the job's
--      check draft (the till's closer books those tender legs and stamps the ledger), and refuse
--      to start when the booking money covers the whole bill (the till checkout closes it).
--   3  Surplus credit lost. apply_booking_payment stamped every captured row applied even when
--      the bill was smaller than what was paid. It now takes the applied amount, stores
--      applied_minor on each row, and when less was used than was paid it stores
--      refund_due_minor and refund_reason so the host stand shows "give back £X".
--   10 Double booking guard. A time only edit and the till's Edit reservation wrote straight to
--      the bookings row with no lock and no free check. edit_booking re checks the window, the
--      covers and the tables under the same venue lock as create_booking and move_booking, and
--      writes the row and the tables in one transaction.
--   21 Off plan tables. create_booking, move_booking and edit_booking refuse a table id that is
--      not on the venue's floor plan (floor_tables for that location). Checked live 16 Oct: 2 of
--      179 booked tables are off plan (demo rows), everything else is on plan.
--   Also: move_booking now ignores 'expired' bookings in its free check, the same as
--   create_booking (an expired booking never paid and its table was freed).
--
-- WHAT DOES NOT CHANGE
--   No till sends anything new. Session ids, totals, check keys, the paid legs scan, the
--   in progress guards, tips, the demo reader path and the job shapes are what 20260815b,
--   20260819c and 20260814c wrote, plus the booking credit lines marked "16 Oct 2026". A table
--   with no booking (every live venue today) takes exactly the old path.
--
-- AFTER RUNNING
--   Read the check select at the bottom. Then deploy the edge functions listed in the PR.

begin;

-- ── 1. booking_payments: what was used, what goes back ──────────────────────
alter table public.booking_payments add column if not exists applied_minor integer;
alter table public.booking_payments add column if not exists refund_due_minor integer;
alter table public.booking_payments add column if not exists refund_reason text;

comment on column public.booking_payments.applied_minor is
  '16 Oct 2026: minor units of this row used on the check (apply_booking_payment with p_applied_minor). null = applied before this column existed, or not applied.';
comment on column public.booking_payments.refund_due_minor is
  '16 Oct 2026: minor units of this captured row the check did not use, owed back to the guest. null or 0 = nothing owed.';
comment on column public.booking_payments.refund_reason is
  '16 Oct 2026: plain words for refund_due_minor, shown on the host stand.';

-- ── 2. the booking credit on an open table (internal) ───────────────────────
-- What a seated booking's captured, unapplied money takes off a bill, prepay first, then
-- deposit, capped at the bill. The booking id comes from the session the till published
-- (session.booking.bookingId); the AMOUNTS come only from booking_payments, never from the
-- session. The booking must belong to the same venue. null when there is nothing to take off.
-- Returns { bookingId, creditMinor, appliedMinor, legs:[{ method, amountMinor }] }.
create or replace function public._booking_credit_for_session(p_location_id uuid, p_session jsonb, p_bill bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $function$
declare
  v_bid     text := nullif(btrim(coalesce(p_session -> 'booking' ->> 'bookingId', '')), '');
  v_prepay  bigint := 0;
  v_deposit bigint := 0;
  v_left    bigint;
  v_take    bigint;
  v_legs    jsonb := '[]'::jsonb;
begin
  if v_bid is null or p_location_id is null or p_bill is null or p_bill <= 0 then
    return null;
  end if;
  select coalesce(sum(round(bp.amount * 100)) filter (where bp.kind = 'prepay'), 0)::bigint,
         coalesce(sum(round(bp.amount * 100)) filter (where bp.kind = 'deposit'), 0)::bigint
    into v_prepay, v_deposit
    from public.booking_payments bp
    join public.bookings b on b.id = bp.booking_id
   where bp.booking_id = v_bid
     and b.location_id = p_location_id
     and bp.status = 'captured'
     and bp.applied_to_check = false
     and bp.kind in ('prepay', 'deposit')
     and coalesce(bp.refusal_reason, '') not ilike 'needs refund%';
  if coalesce(v_prepay, 0) + coalesce(v_deposit, 0) <= 0 then
    return null;
  end if;
  v_left := p_bill;
  v_take := least(v_prepay, v_left);
  if v_take > 0 then
    v_legs := v_legs || jsonb_build_array(jsonb_build_object('method', 'booking_prepaid', 'amountMinor', v_take));
    v_left := v_left - v_take;
  end if;
  v_take := least(v_deposit, v_left);
  if v_take > 0 then
    v_legs := v_legs || jsonb_build_array(jsonb_build_object('method', 'booking_deposit', 'amountMinor', v_take));
    v_left := v_left - v_take;
  end if;
  return jsonb_build_object(
    'bookingId',    v_bid,
    'creditMinor',  v_prepay + v_deposit,
    'appliedMinor', p_bill - v_left,
    'legs',         v_legs
  );
end $function$;

revoke all on function public._booking_credit_for_session(uuid, jsonb, bigint) from public;
revoke all on function public._booking_credit_for_session(uuid, jsonb, bigint) from anon, authenticated;
grant execute on function public._booking_credit_for_session(uuid, jsonb, bigint) to service_role;

comment on function public._booking_credit_for_session(uuid, jsonb, bigint) is
  '16 Oct 2026 (bookings audit item 1): captured, unapplied prepay then deposit money of the booking seated on this session, capped at the bill. Internal: called by terminal_start_table_payment and terminal_start_table_payment_for.';

-- ── 3. Adyen reader Pay at table: take the booking money off ────────────────
-- The live function (20260819c on 20260815b) with the lines marked 16 Oct 2026 added. The staff
-- messages use a colon where the live text had a long dash; nothing reads those words.
create or replace function public.terminal_start_table_payment_for(
  p_terminal_device_id uuid, p_table_id text, p_amount_minor bigint default null::bigint,
  p_session_id text default null::text, p_seated_at text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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
      (case upper(v_currency) when 'GBP' then '£' when 'USD' then '$' when 'EUR' then '€' else upper(v_currency) || ' ' end)
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

revoke all on function public.terminal_start_table_payment_for(uuid, text, bigint, text, text) from public;
revoke all on function public.terminal_start_table_payment_for(uuid, text, bigint, text, text) from anon, authenticated;
grant execute on function public.terminal_start_table_payment_for(uuid, text, bigint, text, text) to service_role;

-- ── 4. PAX Table Pay: the same booking money rule ───────────────────────────
-- The live function (20260814c family) with the lines marked 16 Oct 2026 added (same note on
-- the messages as above).
create or replace function public.terminal_start_table_payment(p_table_id text, p_staff_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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
      (case upper(v_currency) when 'GBP' then '£' when 'USD' then '$' when 'EUR' then '€' else upper(v_currency) || ' ' end)
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

-- Same grants the live function has (the PAX app calls it with the device's own session).
grant execute on function public.terminal_start_table_payment(text, uuid) to anon, authenticated, service_role;

-- ── 5. apply_booking_payment: the amount used, the surplus flagged ──────────
drop function if exists public.apply_booking_payment(text, text);

create or replace function public.apply_booking_payment(p_booking_id text, p_closed_check_id text, p_applied_minor bigint default null)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_loc   uuid;
  v_count integer := 0;
  v_left  bigint;
  v_row   record;
  v_minor bigint;
  v_take  bigint;
  v_cur   text;
begin
  if auth.uid() is null then
    raise exception 'no session';
  end if;
  select location_id into v_loc from bookings where id = p_booking_id;
  if v_loc is null then
    raise exception 'unknown booking';
  end if;
  -- Fence: a BO user with access to the location, or a paired device at it.
  if not (
    v_loc::text in (select public.user_accessible_locations())
    or exists (select 1 from devices d where d.device_uid = auth.uid() and d.location_id = v_loc)
  ) then
    raise exception 'no access to this booking';
  end if;

  -- No amount given: exactly the old behaviour (every captured, unapplied row stamped).
  if p_applied_minor is null then
    update booking_payments
       set applied_to_check = true,
           applied_check_id = coalesce(p_closed_check_id, applied_check_id)
     where booking_id = p_booking_id
       and status = 'captured'
       and applied_to_check = false;
    get diagnostics v_count = row_count;
    return v_count;
  end if;

  -- 16 Oct 2026 (bookings audit item 3): the check used p_applied_minor. Prepay rows first,
  -- then deposit, oldest first (the same order the till takes the legs in). A row the check
  -- used less of than was paid keeps the difference as refund_due_minor with a reason.
  v_left := greatest(p_applied_minor, 0);
  for v_row in
    select bp.id, bp.amount, bp.currency
      from booking_payments bp
     where bp.booking_id = p_booking_id
       and bp.status = 'captured'
       and bp.applied_to_check = false
     order by case bp.kind when 'prepay' then 0 when 'deposit' then 1 else 2 end, bp.created_at, bp.id
     for update
  loop
    v_minor := round(coalesce(v_row.amount, 0) * 100)::bigint;
    v_take  := least(v_minor, v_left);
    v_left  := v_left - v_take;
    v_cur   := case upper(coalesce(v_row.currency, 'gbp')) when 'GBP' then '£' when 'USD' then '$' when 'EUR' then '€'
                 else upper(v_row.currency) || ' ' end;
    update booking_payments
       set applied_to_check = true,
           applied_check_id = coalesce(p_closed_check_id, applied_check_id),
           applied_minor    = v_take,
           refund_due_minor = case when v_take < v_minor then v_minor - v_take else null end,
           refund_reason    = case when v_take < v_minor
                                then 'The bill was smaller than what was paid: ' || v_cur
                                     || to_char(v_take / 100.0, 'FM999999990.00') || ' of ' || v_cur
                                     || to_char(v_minor / 100.0, 'FM999999990.00')
                                     || ' was used, give back ' || v_cur
                                     || to_char((v_minor - v_take) / 100.0, 'FM999999990.00') || '.'
                                else null end
     where id = v_row.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end $function$;

revoke all on function public.apply_booking_payment(text, text, bigint) from public;
grant execute on function public.apply_booking_payment(text, text, bigint) to anon, authenticated, service_role;

comment on function public.apply_booking_payment(text, text, bigint) is
  '16 Oct 2026: stamps a booking''s captured, unapplied payments onto a closed check. With p_applied_minor it stores applied_minor per row and the unused part as refund_due_minor + refund_reason. Without it: the old behaviour (all rows applied).';

-- ── 6. create_booking: refuse a table that is not on the floor plan ─────────
create or replace function public.create_booking(
  p_id text, p_location_id uuid, p_booking_date date, p_start_time time without time zone,
  p_turn_minutes integer, p_covers integer, p_table_ids text[], p_primary_table_id text,
  p_customer_id uuid default null::uuid, p_customer jsonb default null::jsonb,
  p_status text default 'confirmed'::text, p_source text default 'host'::text,
  p_package_id text default null::text, p_note text default ''::text,
  p_created_by text default null::text, p_pacing_override_by text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_conflict record;
  v_org uuid;
  v_off text;
  v_start_min int := extract(hour from p_start_time)::int * 60 + extract(minute from p_start_time)::int;
  v_end_min int := v_start_min + p_turn_minutes;
begin
  if p_table_ids is null or array_length(p_table_ids, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'no tables supplied');
  end if;
  if not (p_primary_table_id = any(p_table_ids)) then
    return jsonb_build_object('ok', false, 'error', 'primary table must be a member');
  end if;

  -- 16 Oct 2026 (bookings audit item 21): every table must be on this venue's floor plan.
  select x into v_off from unnest(p_table_ids) as x
   where not exists (select 1 from floor_tables f where f.id = x and f.location_id = p_location_id::text)
   limit 1;
  if v_off is not null then
    return jsonb_build_object('ok', false, 'error', 'unknown_table', 'table_id', v_off);
  end if;

  perform pg_advisory_xact_lock(hashtext('bookings:' || p_location_id::text));

  select b.id, b.customer->>'name' as name, bt.table_id into v_conflict
  from bookings b
  join booking_tables bt on bt.booking_id = b.id
  where b.location_id = p_location_id
    and b.booking_date = p_booking_date
    and b.status not in ('departed','cancelled','no_show','expired')
    and bt.table_id = any(p_table_ids)
    and (extract(hour from b.start_time)::int * 60 + extract(minute from b.start_time)::int) < v_end_min
    and (extract(hour from b.start_time)::int * 60 + extract(minute from b.start_time)::int) + b.turn_minutes > v_start_min
  limit 1;

  if found then
    return jsonb_build_object('ok', false, 'error', 'table_taken',
      'table_id', v_conflict.table_id, 'booking_id', v_conflict.id);
  end if;

  select org_id into v_org from locations where id = p_location_id;

  insert into bookings (id, location_id, org_id, customer_id, customer, booking_date, start_time,
    turn_minutes, covers, primary_table_id, status, source, package_id, note, created_by, pacing_override_by)
  values (p_id, p_location_id, v_org, p_customer_id, p_customer, p_booking_date, p_start_time,
    p_turn_minutes, p_covers, p_primary_table_id, coalesce(p_status,'confirmed'),
    coalesce(p_source,'host'), p_package_id, coalesce(p_note,''), p_created_by, p_pacing_override_by);

  insert into booking_tables (location_id, booking_id, table_id, is_primary)
  select p_location_id, p_id, t, (t = p_primary_table_id) from unnest(p_table_ids) as t;

  return jsonb_build_object('ok', true, 'id', p_id);
end $function$;

grant execute on function public.create_booking(text, uuid, date, time without time zone, integer, integer, text[], text, uuid, jsonb, text, text, text, text, text, text)
  to anon, authenticated, service_role;

-- ── 7. move_booking: floor plan check, expired never blocks ─────────────────
create or replace function public.move_booking(p_id text, p_location_id uuid, p_table_ids text[], p_primary_table_id text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_bk record;
  v_conflict record;
  v_off text;
  v_start_min int;
  v_end_min int;
begin
  if p_table_ids is null or array_length(p_table_ids, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'no tables supplied');
  end if;
  if not (p_primary_table_id = any(p_table_ids)) then
    return jsonb_build_object('ok', false, 'error', 'primary table must be a member');
  end if;

  -- 16 Oct 2026 (bookings audit item 21): every table must be on this venue's floor plan.
  select x into v_off from unnest(p_table_ids) as x
   where not exists (select 1 from floor_tables f where f.id = x and f.location_id = p_location_id::text)
   limit 1;
  if v_off is not null then
    return jsonb_build_object('ok', false, 'error', 'unknown_table', 'table_id', v_off);
  end if;

  perform pg_advisory_xact_lock(hashtext('bookings:' || p_location_id::text));

  select * into v_bk from bookings where id = p_id and location_id = p_location_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'unknown booking');
  end if;
  if v_bk.status in ('departed','cancelled','no_show') then
    return jsonb_build_object('ok', false, 'error', 'booking is closed');
  end if;

  v_start_min := extract(hour from v_bk.start_time)::int * 60 + extract(minute from v_bk.start_time)::int;
  v_end_min := v_start_min + v_bk.turn_minutes;

  select b.id, bt.table_id into v_conflict
  from bookings b
  join booking_tables bt on bt.booking_id = b.id
  where b.location_id = p_location_id
    and b.id != p_id
    and b.booking_date = v_bk.booking_date
    and b.status not in ('departed','cancelled','no_show','expired')   -- 16 Oct 2026: + expired, as create_booking
    and bt.table_id = any(p_table_ids)
    and (extract(hour from b.start_time)::int * 60 + extract(minute from b.start_time)::int) < v_end_min
    and (extract(hour from b.start_time)::int * 60 + extract(minute from b.start_time)::int) + b.turn_minutes > v_start_min
  limit 1;

  if found then
    return jsonb_build_object('ok', false, 'error', 'table_taken',
      'table_id', v_conflict.table_id, 'booking_id', v_conflict.id);
  end if;

  delete from booking_tables where booking_id = p_id;
  insert into booking_tables (location_id, booking_id, table_id, is_primary)
  select p_location_id, p_id, t, (t = p_primary_table_id) from unnest(p_table_ids) as t;
  update bookings set primary_table_id = p_primary_table_id where id = p_id;

  return jsonb_build_object('ok', true, 'id', p_id);
end $function$;

grant execute on function public.move_booking(text, uuid, text[], text) to anon, authenticated, service_role;

-- ── 8. edit_booking: one guarded write for date, time, covers and tables ────
-- The Edit sheet, the Timeline drag and the till's Edit reservation all write through here.
-- Under the venue lock it re checks, in this order:
--   unknown booking            the id is not at this venue
--   not_editable               dining, departed, cancelled, no show or expired
--   awaiting_payment           covers changed while the guest is still paying online
--   unknown_table              a table not on this venue's floor plan
--   too_many_covers            the tables seat fewer than the party (seats in the reply)
--   table_taken                another live booking overlaps the new window on a chosen table
-- then writes the row (date, time, turn, covers, note, guest) and, when they changed, the
-- tables (delete and insert, primary first), all in one transaction.
-- p_note and p_customer null = keep what is there.
create or replace function public.edit_booking(
  p_id text, p_location_id uuid, p_booking_date date, p_start_time time without time zone,
  p_turn_minutes integer, p_covers integer, p_table_ids text[], p_primary_table_id text,
  p_note text default null, p_customer jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_bk        record;
  v_conflict  record;
  v_off       text;
  v_seats     integer;
  v_start_min int;
  v_end_min   int;
  v_old_ids   text[];
  v_retable   boolean;
begin
  if p_id is null or p_location_id is null then
    return jsonb_build_object('ok', false, 'error', 'unknown booking');
  end if;
  if p_table_ids is null or array_length(p_table_ids, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'no tables supplied');
  end if;
  if not (p_primary_table_id = any(p_table_ids)) then
    return jsonb_build_object('ok', false, 'error', 'primary table must be a member');
  end if;
  if p_booking_date is null or p_start_time is null then
    return jsonb_build_object('ok', false, 'error', 'date and time required');
  end if;
  if p_covers is null or p_covers < 1 or p_covers > 200 then
    return jsonb_build_object('ok', false, 'error', 'covers out of range');
  end if;
  if p_turn_minutes is null or p_turn_minutes < 15 or p_turn_minutes > 720 then
    return jsonb_build_object('ok', false, 'error', 'turn out of range');
  end if;

  select x into v_off from unnest(p_table_ids) as x
   where not exists (select 1 from floor_tables f where f.id = x and f.location_id = p_location_id::text)
   limit 1;
  if v_off is not null then
    return jsonb_build_object('ok', false, 'error', 'unknown_table', 'table_id', v_off);
  end if;

  perform pg_advisory_xact_lock(hashtext('bookings:' || p_location_id::text));

  select * into v_bk from bookings where id = p_id and location_id = p_location_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'unknown booking');
  end if;
  if v_bk.status in ('dining','departed','cancelled','no_show','expired') then
    return jsonb_build_object('ok', false, 'error', 'not_editable', 'status', v_bk.status);
  end if;
  if v_bk.status = 'pending_payment' and p_covers is distinct from v_bk.covers then
    return jsonb_build_object('ok', false, 'error', 'awaiting_payment');
  end if;

  select coalesce(sum(f.max_covers), 0)::int into v_seats
    from floor_tables f
   where f.location_id = p_location_id::text
     and f.id in (select distinct x from unnest(p_table_ids) as x);
  if v_seats < p_covers then
    return jsonb_build_object('ok', false, 'error', 'too_many_covers', 'seats', v_seats);
  end if;

  v_start_min := extract(hour from p_start_time)::int * 60 + extract(minute from p_start_time)::int;
  v_end_min := v_start_min + p_turn_minutes;

  select b.id, bt.table_id into v_conflict
  from bookings b
  join booking_tables bt on bt.booking_id = b.id
  where b.location_id = p_location_id
    and b.id <> p_id
    and b.booking_date = p_booking_date
    and b.status not in ('departed','cancelled','no_show','expired')
    and bt.table_id = any(p_table_ids)
    and (extract(hour from b.start_time)::int * 60 + extract(minute from b.start_time)::int) < v_end_min
    and (extract(hour from b.start_time)::int * 60 + extract(minute from b.start_time)::int) + b.turn_minutes > v_start_min
  limit 1;
  if found then
    return jsonb_build_object('ok', false, 'error', 'table_taken',
      'table_id', v_conflict.table_id, 'booking_id', v_conflict.id);
  end if;

  update bookings
     set booking_date = p_booking_date,
         start_time   = p_start_time,
         turn_minutes = p_turn_minutes,
         covers       = p_covers,
         note         = coalesce(p_note, note),
         customer     = coalesce(p_customer, customer)
   where id = p_id and location_id = p_location_id;

  select coalesce(array_agg(bt.table_id order by bt.table_id), '{}') into v_old_ids
    from booking_tables bt where bt.booking_id = p_id;
  v_retable := v_bk.primary_table_id is distinct from p_primary_table_id
    or v_old_ids is distinct from (select array_agg(distinct x order by x) from unnest(p_table_ids) as x);
  if v_retable then
    delete from booking_tables where booking_id = p_id;
    insert into booking_tables (location_id, booking_id, table_id, is_primary)
    select p_location_id, p_id, t, (t = p_primary_table_id) from (select distinct x as t from unnest(p_table_ids) as x) s;
    update bookings set primary_table_id = p_primary_table_id where id = p_id;
  end if;

  return jsonb_build_object('ok', true, 'id', p_id, 'retabled', v_retable);
end $function$;

revoke all on function public.edit_booking(text, uuid, date, time without time zone, integer, integer, text[], text, text, jsonb) from public;
grant execute on function public.edit_booking(text, uuid, date, time without time zone, integer, integer, text[], text, text, jsonb)
  to anon, authenticated, service_role;

comment on function public.edit_booking(text, uuid, date, time without time zone, integer, integer, text[], text, text, jsonb) is
  '16 Oct 2026 (bookings audit item 10): edit a booking''s date, time, turn, covers, note, guest and tables in one transaction under the venue lock, with the same free check as create_booking and move_booking, the floor plan check and the seats check.';

commit;

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   payments_new_columns 3, credit_helper 1, edit_booking_fn 1, apply_3_args 1, apply_2_args 0,
--   start_for_has_credit 1, pax_start_has_credit 1, create_has_floor_check 1,
--   move_has_floor_check 1, helper_not_public 1,
--   off_plan_live_bookings = live bookings (today or later) on a table not on the floor plan
--   (2 at Provo on 16 Oct, demo rows; they keep working, only new writes are checked).
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_payments'
      and column_name in ('applied_minor', 'refund_due_minor', 'refund_reason')) as payments_new_columns,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_booking_credit_for_session') as credit_helper,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'edit_booking') as edit_booking_fn,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'apply_booking_payment' and p.pronargs = 3) as apply_3_args,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'apply_booking_payment' and p.pronargs = 2) as apply_2_args,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'terminal_start_table_payment_for'
     and pg_get_functiondef(p.oid) like '%_booking_credit_for_session%') as start_for_has_credit,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'terminal_start_table_payment'
     and pg_get_functiondef(p.oid) like '%_booking_credit_for_session%') as pax_start_has_credit,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'create_booking'
     and pg_get_functiondef(p.oid) like '%unknown_table%') as create_has_floor_check,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'move_booking'
     and pg_get_functiondef(p.oid) like '%unknown_table%') as move_has_floor_check,
  (select case when has_function_privilege('anon', 'public._booking_credit_for_session(uuid, jsonb, bigint)', 'execute') then 0 else 1 end) as helper_not_public,
  (select count(*) from bookings b join booking_tables bt on bt.booking_id = b.id
    where b.booking_date >= current_date
      and b.status not in ('departed','cancelled','no_show','expired')
      and not exists (select 1 from floor_tables f where f.id = bt.table_id and f.location_id = b.location_id::text)) as off_plan_live_bookings;
