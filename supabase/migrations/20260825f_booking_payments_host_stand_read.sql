-- ═══════════════════════════════════════════════════════════════════════════
-- 20260825f_booking_payments_host_stand_read.sql
-- Let a paired HOST STAND read booking_payments (v5.7.53)
--
-- ⚠ OPS DB ONLY, project ref tbetcegmszzotrwdtqhi (guard below aborts on the
--   Platform DB). Hand-applied by the operator via the SQL editor.
--
-- WHY
-- 20260824_booking_payment_flow.sql set out to do exactly this. Its header
-- says "Paired host-stand devices can now SEE booking_payments (SELECT only)".
-- The policy it shipped, "paired device read", tests public.devices:
--
--     exists (select 1 from public.devices d
--              where d.device_uid = auth.uid()
--                and d.location_id = booking_payments.location_id)
--
-- A host stand is not in public.devices. Tables Ready (?mode=waitlist) and
-- Table Bookings (?mode=bookings) pair through public.waitlist_devices on an
-- anonymous auth session. They have no devices row and no user_profiles
-- location, so they match neither "bo read" nor "paired device read". The
-- policy names the right intent and tests the wrong table.
--
-- WHAT THAT COSTS TODAY
-- RLS filters a SELECT to zero rows instead of raising, so the miss is silent.
-- src/lib/bookings/bookingsData.js loadBookingCredit() reads booking_payments
-- and gets an empty set, which store/bookingsSlice.js seatBooking() cannot
-- tell apart from "this guest paid nothing":
--
--   * prepayCaptured resolves false, so a prepay package prices at REAL menu
--     prices. The guest already paid online and is charged a second time.
--   * prepaidMinor and depositMinor stay 0, so CheckoutModal never applies the
--     captured money as a tender leg.
--   * The POS chip then states "Package unpaid, full prices apply", which is
--     not true. It is the stand reporting what RLS let it see.
--
-- Seating the same booking from a till is correct, because a till IS in
-- public.devices. Only the host stand is wrong, which is why this has not
-- shown up before.
--
-- WHY THIS IS SAFE
-- public.waitlist_can_write(location_id) is the platform's existing host-stand
-- predicate. It already fences waitlist_entries, waitlist_config,
-- waitlist_status_events, turn_time_stats and quote_accuracy:
--
--     select (p_location_id::text in (select user_accessible_locations()))
--         or exists (select 1 from waitlist_devices d
--                     where d.device_uid = auth.uid()
--                       and d.location_id = p_location_id
--                       and d.active);
--
-- It matches only a stand a manager has claimed with a code, that is still
-- active, and only for that stand's own location. This grants SELECT and
-- nothing else. Writes to booking_payments stay service-role only: the table
-- has no INSERT, UPDATE or DELETE policy at all, and this migration adds none.
--
-- SCOPE NOTE FOR THE OPERATOR
-- RLS is row-level, so this exposes the whole row to the stand, including
-- card_last4, card_brand, psp_reference and stored_payment_method_id. The
-- stand already reads the full guest CRM record (bookings and customers are
-- both "allow all"), and a till at the same venue already reads these columns.
-- If you would rather the stand never saw the PSP token columns, say so and
-- the client read can be moved behind a SECURITY DEFINER function that returns
-- only kind, amount, status and applied_to_check. That is a larger change and
-- is not what this file does.
--
-- Idempotent and re-runnable. begin/commit. Everything schema-qualified.
-- ═══════════════════════════════════════════════════════════════════════════
begin;

-- Wrong-database guard (same test as 20260824): Ops has user_locations and no
-- billing_state; Platform is the other way round.
do $guard$
begin
  if to_regclass('public.user_locations') is null
     or to_regclass('public.billing_state') is not null then
    raise exception
      'This migration must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it, aborting.';
  end if;
end
$guard$;

-- The predicate must already exist (shipped with Tables Ready, 20260623t).
do $check$
begin
  if to_regclass('public.waitlist_devices') is null
     or not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'public' and p.proname = 'waitlist_can_write') then
    raise exception
      'public.waitlist_can_write() / public.waitlist_devices missing. Apply the Tables Ready migration (20260623t) first.';
  end if;
end
$check$;

-- Permissive policy, so this ADDS a read path alongside "bo read" and
-- "paired device read". Neither of those changes.
drop policy if exists "host stand read" on public.booking_payments;
create policy "host stand read" on public.booking_payments for select
  using (public.waitlist_can_write(location_id));

-- COLUMN-SCOPED grant, deliberately narrower than what was there before.
--
-- `authenticated` already held a TABLE-level SELECT on all 20 columns, so the
-- policy above would have handed a host stand every column, including
-- stored_payment_method_id: a reusable card-on-file token. A host stand signs in
-- ANONYMOUSLY, so that token would sit behind nothing but a pairing claim.
--
-- Postgres will not let a column revoke cut down a table-level grant, so the
-- table grant is dropped first and re-issued per column. Verified against every
-- client read before narrowing: the only queries against this table anywhere in
-- src/ are the three explicit column lists in lib/bookings/bookingsData.js, and
-- nothing does `select *`. created_at is included because loadBookingPayments
-- ORDERs by it, and ordering needs the privilege too.
--
-- WITHHELD: psp_reference, merchant_reference, merchant_account,
-- stored_payment_method_id. All four are processor identifiers or the stored
-- card token, no client code reads any of them, and the edge functions that do
-- use them run as service_role, which bypasses grants and RLS entirely.
revoke select on public.booking_payments from authenticated;
grant select (
  id, location_id, booking_id, kind, amount, currency, status,
  card_last4, card_brand, refusal_reason, applied_to_check,
  authorised_at, captured_at, released_at, created_at, applied_check_id
) on public.booking_payments to authenticated;

commit;

-- ---------------------------------------------------------------------------
-- Verify after applying
-- ---------------------------------------------------------------------------
--   select polname from pg_policy where polrelid = 'public.booking_payments'::regclass;
--     -- expect: "bo read", "paired device read", "host stand read"
--
--   -- Prove it from the stand's own identity. Swap in the device_uid of a
--   -- claimed stand: select device_uid, name, location_id from waitlist_devices
--   -- where active order by last_seen_at desc;
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<device_uid>","role":"authenticated"}';
--     select count(*) from public.booking_payments;   -- expect > 0, was 0 before
--   rollback;
-- ---------------------------------------------------------------------------
