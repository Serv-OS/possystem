-- 20261016f_OPS_booking_noshow_reports.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Additive and safe to run twice. One transaction. Two indexes and one     #
-- #  comment on booking_payments, and closed_checks_source_check widened to   #
-- #  take 'booking' (NOT VALID, no scan). No table is rewritten, no function  #
-- #  is replaced, no grant changes, nothing a till sends changes.             #
-- #  The app works before this runs: booking-charge refuses a second charge   #
-- #  by itself, and posts its check as source 'online' (marked as a booking   #
-- #  charge) until closed_checks takes 'booking'.                             #
-- #  RUN IT OUTSIDE SERVICE: step 3 locks closed_checks for a moment.         #
-- ############################################################################
--
-- WHY (bookings audit, 16 Oct 2026, section 3 items 3 and 10)
--   3  No show and late cancel charge. The booking-charge edge function charges the card a guest
--      saved with a hold booking, once per booking, written as booking_payments kind
--      no_show_charge (the kind has been allowed since 20260811b). The function already refuses a
--      second charge while one is taken or waiting for the bank, and Adyen replays the first
--      answer for the same attempt. This index makes the database refuse it too: at most ONE
--      no_show_charge row per booking that is waiting (pending), authorised or captured. A failed,
--      cancelled or refunded attempt does not count, so the host can try again after a decline.
--      The fee is posted to a closed check with source 'booking'. The live
--      closed_checks_source_check (last set by 20260919a1) does not allow 'booking', so every post
--      was refused (23514). Step 3 widens it. Until it runs, booking-charge posts the check as
--      source 'online' with customer.charge_source 'booking', so the money still reaches reports,
--      the VAT and Xero.
--   10 Booking payments in Back Office. The tab reads booking_payments for a venue by the time the
--      payment was made, in pages of 1,000. An index on (location_id, created_at) keeps that read
--      off a scan of every venue's rows.
--
-- CHECKED LIVE (read only, 16 Oct 2026): booking_payments holds 19 rows and no no_show_charge row,
-- so the unique index cannot meet a duplicate. The guard below says so in words and skips the
-- unique index (instead of failing the whole file) if a duplicate ever appears before it runs.
--
-- AFTER RUNNING
--   Read the check select at the bottom: one_charge_index 1, payments_by_time_index 1,
--   duplicate_charges 0, source_allows_booking true, and source_check_definition listing the
--   12 sources: pos, kiosk, online, mobile, catering, hubrise, pax_table_pay,
--   pos_send_to_terminal, adyen_pay_at_table, ezcater, qr, booking (NOT VALID).

begin;

-- Wrong database guard (same test as 20260824): Ops has user_locations and no billing_state;
-- Platform is the other way round.
do $guard$
begin
  if to_regclass('public.user_locations') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This migration must be run against the OPS DB (tbetcegmszzotrwdtqhi). This is not it, aborting.';
  end if;
  if to_regclass('public.booking_payments') is null then
    raise exception 'public.booking_payments is missing. Apply 20260811b_table_bookings.sql first.';
  end if;
end
$guard$;

-- Fail fast rather than queue booking reads behind the index builds: if a long transaction holds
-- booking_payments, this stops after 5 seconds and nothing is changed. Just run it again.
set local lock_timeout = '5s';

-- ── 1. one live no show charge per booking ─────────────────────────────────
do $one$
declare
  v_dupes integer;
begin
  select count(*) into v_dupes from (
    select booking_id from public.booking_payments
     where kind = 'no_show_charge' and status in ('pending', 'authorised', 'captured')
     group by booking_id having count(*) > 1
  ) d;
  if v_dupes > 0 then
    raise notice 'NOT created: % booking(s) already hold more than one live no show charge. Refund the extra charge in Adyen, mark that row refunded, then run this file again.', v_dupes;
  else
    execute 'create unique index if not exists booking_payments_one_noshow_charge
               on public.booking_payments (booking_id)
               where kind = ''no_show_charge'' and status in (''pending'', ''authorised'', ''captured'')';
  end if;
end
$one$;

-- ── 2. the Back Office Booking payments tab: a venue's payments by time ────
create index if not exists booking_payments_location_created
  on public.booking_payments (location_id, created_at);

-- ── 3. closed_checks takes source 'booking' (the no show charge check) ──────
-- The new list is built FROM the live constraint: every source it allows today is kept, and
-- 'booking' is added (16 Oct 2026 release review: a typed list could drop a source live allows
-- and every check closed with it would then fail). Read live 16 Oct 2026: the 11 sources from
-- 20260919a1, NOT VALID. NOT VALID again so the largest table is not re-read while it is locked
-- (the new list is a strict superset, so no existing row can break it; every new insert and
-- update is still checked). Last in the file, so the lock on closed_checks is held only from
-- here to the commit. If a till holds closed_checks for more than 3 seconds the whole file
-- stops and nothing changes: run it again. If the constraint is missing or not a plain list,
-- the file stops with the reason and nothing changes.
set local lock_timeout = '3s';
do $src$
declare
  v_def  text;
  v_list text[];
begin
  select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
   where c.conrelid = 'public.closed_checks'::regclass and c.conname = 'closed_checks_source_check';
  if v_def is null then
    raise exception 'closed_checks_source_check not found, nothing changed';
  end if;
  if v_def like '%''booking''%' then
    raise notice 'closed_checks already allows booking, left as it is';
    return;
  end if;
  if v_def not like 'CHECK ((source = ANY (ARRAY[%' then
    raise exception 'closed_checks_source_check is not a plain list of sources, nothing changed: %', v_def;
  end if;
  select array_agg(t.m[1] order by t.n) into v_list
    from regexp_matches(v_def, '''([^'']*)''', 'g') with ordinality as t(m, n);
  if v_list is null or array_length(v_list, 1) < 1 then
    raise exception 'could not read the sources in closed_checks_source_check, nothing changed: %', v_def;
  end if;
  v_list := v_list || 'booking'::text;
  execute 'alter table public.closed_checks drop constraint closed_checks_source_check';
  execute 'alter table public.closed_checks add constraint closed_checks_source_check check (source = any (array['
       || (select string_agg(quote_literal(x), ', ' order by n) from unnest(v_list) with ordinality as u(x, n))
       || '])) not valid';
end
$src$;

comment on column public.booking_payments.kind is
  'hold = card saved, nothing taken (amount 0 since 20261016d, hold_minor keeps the rule figure, never money); deposit, prepay = money taken online, credit on the bill; no_show_charge = the saved card charged for a no show or a late cancellation by booking-charge (16 Oct 2026; merchant_reference bkpay-<booking>-noshow-a<N> or -latecancel-a<N>; posted to closed check bkns-<booking>-a<N>, applied_check_id); refund = money given back.';

commit;

-- ── check (read the row) ───────────────────────────────────────────────────
select
  (select count(*) from pg_indexes where schemaname = 'public' and indexname = 'booking_payments_one_noshow_charge') as one_charge_index,
  (select count(*) from pg_indexes where schemaname = 'public' and indexname = 'booking_payments_location_created') as payments_by_time_index,
  (select count(*) from (
     select booking_id from public.booking_payments
      where kind = 'no_show_charge' and status in ('pending', 'authorised', 'captured')
      group by booking_id having count(*) > 1) d) as duplicate_charges,
  (select count(*) from public.booking_payments where kind = 'no_show_charge') as no_show_charges_so_far,
  (select coalesce(bool_or(pg_get_constraintdef(oid) like '%''booking''%'), false) from pg_constraint
    where conrelid = 'public.closed_checks'::regclass and conname = 'closed_checks_source_check') as source_allows_booking,
  (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid = 'public.closed_checks'::regclass and conname = 'closed_checks_source_check') as source_check_definition;
