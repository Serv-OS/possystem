-- 20261016d_OPS_booking_host_tools.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  RUN 20261016b_OPS_bookings_core.sql FIRST (this file replaces two of     #
-- #  its functions and stops with a clear message if it has not been run).    #
-- #  Additive and safe to run twice. One transaction. No table is rewritten:  #
-- #  nullable or defaulted columns only, one partial unique index, one cron   #
-- #  job body replaced, two functions replaced with grants re issued.         #
-- #  Safe in service: the app works before and after (every screen feature   #
-- #  detects the new columns and says in words what waits for this file).     #
-- ############################################################################
--
-- WHY (bookings audit 16 Oct 2026, section 3, host tools track, v5.11.70)
--   4  Refund button. A refund is its own booking_payments row (kind refund, pending until
--      Adyen's REFUND webhook settles it). The payment it gives back now records how much went
--      back (amount_refunded_minor), so a PART refund lowers the credit the till and the card
--      reader take off the bill instead of wiping the whole payment. refund_of links a refund row
--      to its payment (the merchant reference bkrf-<payment id>-<n> links them as well, so
--      refunds made before this file still match). Card holds are stored as amount 0 from now on
--      (a hold takes no money); hold_minor keeps the rule figure for reference only.
--   5  Large parties. widget_min_party and widget_max_party: the party sizes the booking page
--      offers. A bigger party sends a request, which lands in the host stand's inbox.
--   9  Pay link from the stand. pay_link_until: when the link stops being live (24 hours, never
--      past the booking start). A confirmed phone booking stays confirmed; a booking still waiting
--      online is not expired by the 20 minute sweep while its link is live. A unique index stops
--      two refund taps at the same moment from both going out.
--  11  late_release_minutes: after this many minutes late the host stand asks "Still waiting?".
--      privacy_url: the venue's privacy notice, linked under the booking page's consent box.
--
-- WHAT DOES NOT CHANGE
--   No till sends anything new. _booking_credit_for_session and apply_booking_payment are the
--   20261016b text with one change each, marked "16 Oct 2026 (host tools)": what was refunded is
--   taken off the payment first. A payment with nothing refunded (every live row today) gives
--   exactly the same answer as before.
--
-- AFTER RUNNING
--   Read the check select at the bottom (expected values are written above it). Then deploy the
--   edge functions listed in the PR (booking-host is new).

begin;

-- 2 seconds: while this waits for a lock, reads and writes on bookings queue behind it. If it
-- stops, nothing changed: run it again (16 Oct 2026 release review).
set local lock_timeout = '2s';

-- 20261016b must be in: this file replaces two of its functions.
do $guard$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'booking_payments' and column_name = 'refund_due_minor') then
    raise exception 'Run 20261016b_OPS_bookings_core.sql first, then this file.';
  end if;
end
$guard$;

-- ── 1. booking_payments: part refunds, refund links, holds take nothing ─────
alter table public.booking_payments add column if not exists amount_refunded_minor integer not null default 0;
alter table public.booking_payments add column if not exists refund_of uuid;
alter table public.booking_payments add column if not exists hold_minor integer;

do $fk$
begin
  if not exists (select 1 from pg_constraint where conname = 'booking_payments_refund_of_fkey') then
    alter table public.booking_payments
      add constraint booking_payments_refund_of_fkey foreign key (refund_of) references public.booking_payments(id) on delete set null;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'booking_payments_amount_refunded_minor_check') then
    alter table public.booking_payments
      add constraint booking_payments_amount_refunded_minor_check check (amount_refunded_minor >= 0);
  end if;
end
$fk$;

create index if not exists booking_payments_refund_of_idx on public.booking_payments (refund_of) where refund_of is not null;

-- Two refund taps at the same moment build the same reference (bkrf-<payment id>-<n>): only one
-- row may carry it, so the second tap is refused before it reaches Adyen. Part refunds made in
-- Adyen's own screens are all written as bkrf-<payment id>-0 (each keyed on its own psp), so the
-- -0 rows are left out. No refund rows exist on live today, so nothing can clash.
create unique index if not exists booking_payments_refund_ref_uidx
  on public.booking_payments (merchant_reference)
  where kind = 'refund' and merchant_reference like 'bkrf-%' and merchant_reference not like '%-0';

-- booking_payments has column scoped grants for authenticated (20260825f). The new columns get
-- the same read grant as the other readable ones, so the host stand and the till can see them.
grant select (amount_refunded_minor, refund_of, hold_minor) on public.booking_payments to authenticated;

comment on column public.booking_payments.amount_refunded_minor is
  '16 Oct 2026 (host tools): minor units of this payment refunded or being refunded (pending refund rows count, failed ones do not). The credit on the bill is amount less this. Written by adyen-modify booking_refund and adyen-webhook.';
comment on column public.booking_payments.refund_of is
  '16 Oct 2026 (host tools): on a kind refund row, the payment it gives back. Refund rows made before this column carry the link in merchant_reference (bkrf-<payment id>-<n>).';
comment on column public.booking_payments.hold_minor is
  '16 Oct 2026 (host tools): on a card hold, the venue rule figure (hold per cover x covers) for reference. A hold takes no money, so its amount is 0.';

-- Old card hold rows carried the rule figure as their amount, though Adyen was sent 0. Keep the
-- figure in hold_minor and set the amount to the truth (nothing taken). Holds only.
update public.booking_payments
   set hold_minor = coalesce(hold_minor, round(amount * 100)::integer),
       amount = 0
 where kind = 'hold' and amount <> 0;

-- ── 2. booking_rules: party sizes, late release, privacy link ───────────────
alter table public.booking_rules add column if not exists widget_min_party integer;
alter table public.booking_rules add column if not exists widget_max_party integer;
alter table public.booking_rules add column if not exists late_release_minutes integer;
alter table public.booking_rules add column if not exists privacy_url text;

do $rk$
begin
  if not exists (select 1 from pg_constraint where conname = 'booking_rules_widget_party_check') then
    alter table public.booking_rules add constraint booking_rules_widget_party_check
      check ((widget_min_party is null or widget_min_party between 1 and 50)
         and (widget_max_party is null or widget_max_party between 1 and 50));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'booking_rules_late_release_check') then
    alter table public.booking_rules add constraint booking_rules_late_release_check
      check (late_release_minutes is null or late_release_minutes between 5 and 120);
  end if;
end
$rk$;

comment on column public.booking_rules.widget_min_party is '16 Oct 2026 (host tools): the smallest party the booking page offers. null = 1.';
comment on column public.booking_rules.widget_max_party is '16 Oct 2026 (host tools): the largest party the booking page offers; bigger parties send a request. null = 12.';
comment on column public.booking_rules.late_release_minutes is '16 Oct 2026 (host tools): minutes late before the host stand asks to release the table. null = 15.';
comment on column public.booking_rules.privacy_url is '16 Oct 2026 (host tools): the venue privacy notice, linked under the booking page consent box.';

-- ── 3. bookings: the pay link window ────────────────────────────────────────
alter table public.bookings add column if not exists pay_link_until timestamptz;
alter table public.bookings add column if not exists pay_link_sent_at timestamptz;

comment on column public.bookings.pay_link_until is
  '16 Oct 2026 (host tools): when a pay link sent from the host stand stops being live (24 hours, never past the booking start). A booking still waiting online (pending_payment) is not expired by the unpaid sweep until then; a confirmed booking stays confirmed. Written by booking-host; the sweep ignores a value more than 25 hours ahead.';
comment on column public.bookings.pay_link_sent_at is
  '16 Oct 2026 (host tools): when the host stand last sent the pay link.';

-- ── 4. the unpaid sweep: never expire a booking whose pay link is live ──────
-- The 20260910 job body with one line added (marked). cron.schedule with an existing job name
-- replaces that job. A warning, not an error, where pg_cron is absent (local restores).
do $cron$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise warning 'pg_cron is not installed on this database, bookings-expire-unpaid was NOT rescheduled.';
    return;
  end if;
  perform cron.schedule('bookings-expire-unpaid', '*/5 * * * *', $q$
    update public.bookings b
       set status = 'expired'
     where b.status = 'pending_payment'
       and b.created_at < now() - interval '20 minutes'
       and (b.pay_link_until is null or b.pay_link_until < now()                  -- 16 Oct 2026 (host tools): a live pay link waits,
            or b.pay_link_until > now() + interval '25 hours')                     -- never longer than booking-host can set
       and not exists (
         select 1 from public.booking_payments p
          where p.booking_id = b.id
            and (p.status in ('authorised','captured')
                 or (p.status = 'pending' and p.created_at > now() - interval '30 minutes')))
  $q$);
end
$cron$;

-- ── 5. the booking credit on an open table: refunds come off first ──────────
-- 20261016b text; the two sums take amount_refunded_minor off each payment (marked).
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
  -- 16 Oct 2026 (host tools): what was refunded is not credit.
  select coalesce(sum(greatest(round(bp.amount * 100) - coalesce(bp.amount_refunded_minor, 0), 0)) filter (where bp.kind = 'prepay'), 0)::bigint,
         coalesce(sum(greatest(round(bp.amount * 100) - coalesce(bp.amount_refunded_minor, 0), 0)) filter (where bp.kind = 'deposit'), 0)::bigint
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
  '16 Oct 2026 (bookings audit item 1, host tools): captured, unapplied prepay then deposit money of the booking seated on this session, less anything refunded, capped at the bill. Internal: called by terminal_start_table_payment and terminal_start_table_payment_for.';

-- ── 6. apply_booking_payment: the refunded part is not used on the bill ─────
-- 20261016b text; v_minor takes amount_refunded_minor off (marked).
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

  if p_applied_minor is null then
    update booking_payments
       set applied_to_check = true,
           applied_check_id = coalesce(p_closed_check_id, applied_check_id)
     where booking_id = p_booking_id
       and status = 'captured'
       and applied_to_check = false
       and kind in ('prepay', 'deposit')
       and coalesce(refusal_reason, '') not ilike 'needs refund%';
    get diagnostics v_count = row_count;
    return v_count;
  end if;

  v_left := greatest(p_applied_minor, 0);
  for v_row in
    select bp.id, bp.amount, bp.currency, coalesce(bp.amount_refunded_minor, 0) as refunded
      from booking_payments bp
     where bp.booking_id = p_booking_id
       and bp.status = 'captured'
       and bp.applied_to_check = false
       and bp.kind in ('prepay', 'deposit')
       and coalesce(bp.refusal_reason, '') not ilike 'needs refund%'
     order by case bp.kind when 'prepay' then 0 when 'deposit' then 1 else 2 end, bp.created_at, bp.id
     for update
  loop
    -- 16 Oct 2026 (host tools): the part already refunded was never credit.
    v_minor := greatest(round(coalesce(v_row.amount, 0) * 100)::bigint - v_row.refunded, 0);
    v_take  := least(v_minor, v_left);
    v_left  := v_left - v_take;
    -- chr(163) is the pound sign and chr(8364) the euro sign: written as codes so a paste that
    -- changes the text encoding cannot garble them (live read a stray sign before the pound on 16 Oct).
    v_cur   := case upper(coalesce(v_row.currency, 'gbp')) when 'GBP' then chr(163) when 'USD' then '$' when 'EUR' then chr(8364)
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
  '16 Oct 2026: stamps a booking''s captured, unapplied payments onto a closed check. With p_applied_minor it stores applied_minor per row and the unused part as refund_due_minor + refund_reason; anything already refunded is left out (host tools). Without it: the old behaviour (all rows applied).';

commit;

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   payments_new_columns 3, payments_columns_readable 3, rules_new_columns 4, bookings_new_columns 2,
--   holds_with_money 0, credit_takes_refunds 1, apply_takes_refunds 1, helper_not_public 1,
--   refund_ref_unique 1, sweep_skips_pay_links 1 (0 only where pg_cron is not installed),
--   apply_pound_sign_ok 1 (live had a stray character before the pound sign in the give back words).
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_payments'
      and column_name in ('amount_refunded_minor', 'refund_of', 'hold_minor')) as payments_new_columns,
  (select count(*) from unnest(array['amount_refunded_minor', 'refund_of', 'hold_minor']) c
    where has_column_privilege('authenticated', 'public.booking_payments', c, 'select')) as payments_columns_readable,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'booking_rules'
      and column_name in ('widget_min_party', 'widget_max_party', 'late_release_minutes', 'privacy_url')) as rules_new_columns,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'bookings'
      and column_name in ('pay_link_until', 'pay_link_sent_at')) as bookings_new_columns,
  (select count(*) from public.booking_payments where kind = 'hold' and amount <> 0) as holds_with_money,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_booking_credit_for_session'
     and pg_get_functiondef(p.oid) like '%amount_refunded_minor%') as credit_takes_refunds,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'apply_booking_payment'
     and p.pronargs = 3 and pg_get_functiondef(p.oid) like '%amount_refunded_minor%') as apply_takes_refunds,
  (select case when has_function_privilege('anon', 'public._booking_credit_for_session(uuid, jsonb, bigint)', 'execute') then 0 else 1 end) as helper_not_public,
  (select count(*) from pg_indexes where schemaname = 'public' and indexname = 'booking_payments_refund_ref_uidx') as refund_ref_unique,
  (select count(*) from cron.job where jobname = 'bookings-expire-unpaid' and command like '%pay_link_until%') as sweep_skips_pay_links,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'apply_booking_payment'
     and position(chr(172) in pg_get_functiondef(p.oid)) = 0) as apply_pound_sign_ok;
