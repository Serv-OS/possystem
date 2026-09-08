-- ═══════════════════════════════════════════════════════════════════════════
-- 20260824_booking_payment_flow.sql — Bookings pay-before-commit (v5.7.21)
--
-- ⚠ OPS DB ONLY — project ref tbetcegmszzotrwdtqhi (guard below aborts on
--   the Platform DB). Hand-applied by the operator via the SQL editor.
--
-- WHAT THIS SHIPS (product decisions locked 19 Aug):
--  1. bookings.status gains 'pending_payment' and 'expired'.
--     pending_payment = the table is held while the guest pays (widget books
--     with this status whenever card capture is on and money is due —
--     prepay/deposit/hold). 'prepaid'/'confirmed' now mean the money side is
--     actually settled (or nothing was due).
--     expired = the guest never paid; the table is FREED (see 3 + 4).
--  2. Paired host-stand devices can now SEE booking_payments (SELECT only) —
--     the Diary Inspector's PaymentState reads honestly instead of guessing.
--     Writes stay service-role only, exactly as before.
--  3. create_booking's conflict check now ignores 'expired' bookings, so an
--     expired hold stops blocking its tables (mirrors the optimiser's
--     BLOCKING_EXCLUDED gaining 'expired' in the same release).
--  4. A SQL-only pg_cron job every 5 minutes expires pending_payment
--     bookings older than 20 minutes that have NO authorised/captured
--     booking_payments row. No HTTP, no tokens — a plain UPDATE.
--  5. public.apply_booking_payment(p_booking_id, p_closed_check_id):
--     SECURITY DEFINER, fenced to paired devices + BO users at the booking's
--     location. Marks that booking's CAPTURED payment rows applied_to_check
--     and stamps which closed check consumed them. Returns the row count.
--     The till calls it best-effort after booking the closed check.
--
-- Idempotent + re-runnable. begin/commit. Everything schema-qualified.
-- ═══════════════════════════════════════════════════════════════════════════
begin;

-- Wrong-database guard (same test as 20260806b/c/e): Ops has user_locations
-- and no billing_state; Platform is the other way round.
do $guard$
begin
  if to_regclass('public.user_locations') is null
     or to_regclass('public.billing_state') is not null then
    raise exception
      'This migration must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it — aborting.';
  end if;
end
$guard$;

-- ── 1. Widen bookings.status ───────────────────────────────────────────────
alter table public.bookings drop constraint if exists bookings_status_check;
alter table public.bookings add constraint bookings_status_check
  check (status in ('confirmed','prepaid','pending_payment','due','late',
                    'dining','departed','cancelled','no_show','expired'));

comment on column public.bookings.status is
  'pending_payment = table held while the guest pays (card capture on + money due); expired = never paid, table freed by the bookings-expire-unpaid cron. prepaid/confirmed after money now arrive via booking-widget booking_pay (sync) or adyen-webhook bkpay capture (async backstop).';

-- Cheap partial index for the 5-minute expiry sweep (status alone, by age).
create index if not exists idx_bookings_pending_payment
  on public.bookings(created_at) where status = 'pending_payment';

-- ── 2. booking_payments: paired-device SELECT + applied_check_id ───────────
-- Which closed check consumed the credit — stamped by apply_booking_payment.
alter table public.booking_payments add column if not exists applied_check_id text;
comment on column public.booking_payments.applied_check_id is
  'closed_checks id that consumed this payment as a tender leg (set by apply_booking_payment alongside applied_to_check).';

-- Host stands were blind to booking_payments (20260811b: BO read only), which
-- is why the Diary showed "prepaid" off the status string alone. Same fence
-- idiom as terminal_jobs: the caller is a paired device at this location.
-- Policies are permissive, so this ADDS a read path next to "bo read".
do $$ begin
  create policy "paired device read" on public.booking_payments for select
    using (exists (
      select 1 from public.devices d
       where d.device_uid = auth.uid()
         and d.location_id = public.booking_payments.location_id));
exception when duplicate_object then null; end $$;
grant select on public.booking_payments to authenticated;   -- re-assert (anon-signed-in devices carry the authenticated role)

-- ── 3. create_booking: expired bookings stop blocking their tables ─────────
-- Full replacement of the 20260811b function; the ONLY behaviour change is
-- 'expired' joining the conflict-check exclusion list.
create or replace function public.create_booking(
  p_id text,
  p_location_id uuid,
  p_booking_date date,
  p_start_time time,
  p_turn_minutes integer,
  p_covers integer,
  p_table_ids text[],
  p_primary_table_id text,
  p_customer_id uuid default null,
  p_customer jsonb default null,
  p_status text default 'confirmed',
  p_source text default 'host',
  p_package_id text default null,
  p_note text default '',
  p_created_by text default null,
  p_pacing_override_by text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_conflict record;
  v_org uuid;
  v_start_min int := extract(hour from p_start_time)::int * 60 + extract(minute from p_start_time)::int;
  v_end_min int := v_start_min + p_turn_minutes;
begin
  if p_table_ids is null or array_length(p_table_ids, 1) is null then
    return jsonb_build_object('ok', false, 'error', 'no tables supplied');
  end if;
  if not (p_primary_table_id = any(p_table_ids)) then
    return jsonb_build_object('ok', false, 'error', 'primary table must be a member');
  end if;

  -- serialise booking writes for this venue
  perform pg_advisory_xact_lock(hashtext('bookings:' || p_location_id::text));

  -- the free check, inside the transaction: any live booking overlapping the
  -- half-open window on any requested table wins. 'expired' = never paid,
  -- table freed — it must not block (nor 'pending_payment' be special: an
  -- unpaid-but-inside-its-20-minutes booking DOES hold the table).
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
end $$;

revoke all on function public.create_booking(text, uuid, date, time, integer, integer, text[], text, uuid, jsonb, text, text, text, text, text, text) from public;
grant execute on function public.create_booking(text, uuid, date, time, integer, integer, text[], text, uuid, jsonb, text, text, text, text, text, text) to anon, authenticated;

-- ── 4. apply_booking_payment — the checkout's "credit consumed" stamp ──────
-- The till books the closed check first (durable close is sacred), then calls
-- this best-effort. Captured rows only: a hold is an authorisation, not money.
create or replace function public.apply_booking_payment(
  p_booking_id text,
  p_closed_check_id text
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_loc uuid;
  v_count integer := 0;
begin
  if auth.uid() is null then
    raise exception 'no session';
  end if;
  select location_id into v_loc from bookings where id = p_booking_id;
  if v_loc is null then
    raise exception 'unknown booking';
  end if;
  -- Fence: a BO user with access to the location, or a paired device at it
  -- (same two doors as the terminal_jobs pattern).
  if not (
    v_loc::text in (select public.user_accessible_locations())
    or exists (select 1 from devices d where d.device_uid = auth.uid() and d.location_id = v_loc)
  ) then
    raise exception 'no access to this booking';
  end if;

  update booking_payments
     set applied_to_check = true,
         applied_check_id = coalesce(p_closed_check_id, applied_check_id)
   where booking_id = p_booking_id
     and status = 'captured'
     and applied_to_check = false;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

revoke all on function public.apply_booking_payment(text, text) from public;
grant execute on function public.apply_booking_payment(text, text) to anon, authenticated;

-- ── 5. Expiry sweep — SQL only, no HTTP, no tokens ─────────────────────────
-- Every 5 minutes: a pending_payment booking older than 20 minutes with no
-- authorised/captured payment row becomes 'expired' (frees the table via 3).
-- A 3DS payment still in flight has only a 'pending' booking_payments row and
-- does NOT protect the booking from expiring. A capture that lands AFTER the
-- sweep RESURRECTS it: both promote paths (booking-widget promotePaid and the
-- adyen-webhook bkpay backstop) match status in ('pending_payment','expired')
-- - the money is captured, the booking must live; the table-overlap risk is
-- accepted (v5.7.23). Cancelled/no_show bookings never come back.
-- Unschedule-then-schedule so re-running this file is a no-op; a
-- warning, not an error, where pg_cron is absent (local restores).
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed on this database — bookings-expire-unpaid was NOT scheduled.';
    return;
  end if;
  if exists (select 1 from cron.job where jobname = 'bookings-expire-unpaid') then
    perform cron.unschedule('bookings-expire-unpaid');
  end if;
  perform cron.schedule('bookings-expire-unpaid', '*/5 * * * *', $q$
    update public.bookings b
       set status = 'expired'
     where b.status = 'pending_payment'
       and b.created_at < now() - interval '20 minutes'
       and not exists (
         select 1 from public.booking_payments p
          where p.booking_id = b.id
            and p.status in ('authorised','captured'))
  $q$);
end;
$$;

commit;

-- ---------------------------------------------------------------------------
-- Verify after applying
-- ---------------------------------------------------------------------------
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'bookings_status_check';
--   select polname from pg_policy where polrelid = 'public.booking_payments'::regclass;
--     -- expect: "bo read" AND "paired device read"
--   select jobname, schedule, active from cron.job where jobname = 'bookings-expire-unpaid';
--   -- after a tick:
--   select d.status, d.return_message, d.end_time
--     from cron.job_run_details d join cron.job j using (jobid)
--    where j.jobname = 'bookings-expire-unpaid' order by d.end_time desc limit 3;
