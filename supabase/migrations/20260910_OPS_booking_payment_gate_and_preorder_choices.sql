-- ═══════════════════════════════════════════════════════════════════════════
-- 20260910_OPS_booking_payment_gate_and_preorder_choices.sql
--
-- OPS DB ONLY. Project ref tbetcegmszzotrwdtqhi. Hand-applied by the operator
-- in the SQL editor. Claude cannot apply this.
--
-- WHY (Peter, 10 Sep 2026): "payment must be paid before booking confirms on
-- the system". Provo's owner booking bk-1789079502662-p44q0 was written
-- pending_payment, the payment never reached Adyen and the sweep expired it,
-- while the till showed the table as a normal reservation.
--
-- PART A, THE PAYMENT GATE. What this file does:
--  A1. bookings gains payment_kind, payment_due_minor, payment_currency: what
--      the booking widget said was due at book time. booking_pay charges that,
--      never a figure recomputed later (a changed package can never cause a
--      second charge or a smaller one).
--  A2. booking_payments.status allows 'needs_refund': money that landed after
--      its booking expired and its table was booked again.
--  A3. public.promote_paid_booking(booking, status): the ONE atomic door from
--      pending_payment (or expired, only when its tables are still free) to
--      confirmed or prepaid. Service role only. Called by booking-widget and
--      adyen-webhook through _shared/bookingPromote.ts.
--  A4. The bookings-expire-unpaid cron is rescheduled (same name replaces it):
--      a booking with a pending payment row younger than 30 minutes (a 3DS
--      challenge or a Received answer still in flight) is NOT expired.
--  A5. Trigger bookings_payment_gate (every insert and update): for any API
--      caller that is not the service role, refuses a prepaid or widget insert,
--      any write to what a booking owes (payment_*), a package or covers change
--      while unpaid, any move into prepaid, and any move into confirmed, due or
--      late for a booking that owes money with no authorised or captured
--      payment covering it (whatever status it passes through on the way).
--      Staff paths are untouched: create confirmed, seat (dining), depart,
--      cancel, no-show, undo no-show all still work. Direct database sessions
--      with no request JWT (pg_cron, the SQL editor) are not API callers and pass.
--  A3 also: promote_paid_booking answers unknown_booking (never promoted true)
--      when the booking row is gone.
--
-- PART B, GUEST PRE ORDER CHOICES (appended below). What it does:
--  B1. booking_preorders gains mods (the guest's options, the same array the
--      till and the online item sheet build), variant_item_id and variant_name
--      (the size). item_id stays the PACKAGE LINE's item even when a size is
--      picked, because the till matches the line by item id, then name.
--
-- The edge functions and screens work BEFORE this file is applied: they
-- tolerate the missing columns and the missing function, and fall back to the
-- same checks without the lock.
--
-- Idempotent, re-runnable, no transaction wrapper, everything schema-qualified.
-- ═══════════════════════════════════════════════════════════════════════════

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

-- ── A1. What was due, stored on the booking ────────────────────────────────
alter table public.bookings add column if not exists payment_kind text;
alter table public.bookings add column if not exists payment_due_minor integer;
alter table public.bookings add column if not exists payment_currency text;

alter table public.bookings drop constraint if exists bookings_payment_kind_check;
alter table public.bookings add constraint bookings_payment_kind_check
  check (payment_kind is null or payment_kind in ('prepay','deposit','hold'));

alter table public.bookings drop constraint if exists bookings_payment_due_minor_check;
alter table public.bookings add constraint bookings_payment_due_minor_check
  check (payment_due_minor is null or payment_due_minor >= 0);

comment on column public.bookings.payment_kind is
  'What the booking widget said was due at book time: prepay, deposit or hold (a hold saves a card and takes nothing). null = nothing was due. Written by booking-widget (service role) only.';
comment on column public.bookings.payment_due_minor is
  'The amount due at book time in minor units (pence or cents). booking_pay charges this, never a recomputed figure.';
comment on column public.bookings.payment_currency is
  'ISO currency of payment_due_minor (the venue currency at book time).';

-- ── A2. needs_refund on the payment ledger ─────────────────────────────────
alter table public.booking_payments drop constraint if exists booking_payments_status_check;
alter table public.booking_payments add constraint booking_payments_status_check
  check (status in ('pending','authorised','captured','cancelled','failed','refunded','needs_refund'));

comment on column public.booking_payments.status is
  'pending = in flight (3DS, Received); authorised = card saved (hold) or authorised; captured = money taken; needs_refund = paid after the booking expired and its table was booked again (refusal_reason says why; refund it in Adyen); failed, cancelled, refunded as named.';

-- ── A3. The one atomic promote ─────────────────────────────────────────────
create or replace function public.promote_paid_booking(
  p_booking_id text,
  p_next_status text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_loc uuid;
  v_bk public.bookings%rowtype;
  v_conflict text;
  v_start int;
  v_end int;
begin
  if p_next_status not in ('confirmed','prepaid') then
    return jsonb_build_object('ok', false, 'promoted', false, 'error', 'bad_status');
  end if;

  select location_id into v_loc from public.bookings where id = p_booking_id;
  if v_loc is null then
    return jsonb_build_object('ok', false, 'promoted', false, 'error', 'unknown_booking');
  end if;

  -- The same per-venue lock create_booking and move_booking take, so a
  -- booking cannot land on these tables between the free check and the update.
  perform pg_advisory_xact_lock(hashtext('bookings:' || v_loc::text));

  select * into v_bk from public.bookings where id = p_booking_id for update;
  -- Deleted between the location read and the lock: never a false success.
  if not found then
    return jsonb_build_object('ok', false, 'promoted', false, 'error', 'unknown_booking');
  end if;

  if v_bk.status = p_next_status then
    return jsonb_build_object('ok', true, 'promoted', false, 'status', v_bk.status);
  end if;
  -- cancelled, no_show, departed, dining and anything else never promote.
  if v_bk.status not in ('pending_payment','expired') then
    return jsonb_build_object('ok', false, 'promoted', false, 'status', v_bk.status, 'error', 'not_promotable');
  end if;

  if v_bk.status = 'expired' then
    -- The create_booking free check (20260824 section 3), excluding itself.
    v_start := extract(hour from v_bk.start_time)::int * 60 + extract(minute from v_bk.start_time)::int;
    v_end := v_start + v_bk.turn_minutes;
    select b.id into v_conflict
      from public.bookings b
      join public.booking_tables bt on bt.booking_id = b.id
     where b.location_id = v_bk.location_id
       and b.booking_date = v_bk.booking_date
       and b.id <> v_bk.id
       and b.status not in ('departed','cancelled','no_show','expired')
       and bt.table_id in (
             select t.table_id from public.booking_tables t where t.booking_id = v_bk.id
             union select v_bk.primary_table_id)
       and (extract(hour from b.start_time)::int * 60 + extract(minute from b.start_time)::int) < v_end
       and (extract(hour from b.start_time)::int * 60 + extract(minute from b.start_time)::int) + b.turn_minutes > v_start
     limit 1;
    if v_conflict is not null then
      return jsonb_build_object('ok', false, 'promoted', false, 'status', 'expired',
        'error', 'table_taken', 'booking_id', v_conflict);
    end if;
  end if;

  update public.bookings set status = p_next_status where id = p_booking_id;
  if not found then
    return jsonb_build_object('ok', false, 'promoted', false, 'error', 'unknown_booking');
  end if;
  return jsonb_build_object('ok', true, 'promoted', true, 'status', p_next_status);
end $$;

revoke all on function public.promote_paid_booking(text, text) from public;
revoke all on function public.promote_paid_booking(text, text) from anon, authenticated;
grant execute on function public.promote_paid_booking(text, text) to service_role;

comment on function public.promote_paid_booking(text, text) is
  'Payment gate (10 Sep 2026): promotes a paid booking to confirmed or prepaid. pending_payment always; expired only when its tables are still free (else error table_taken, the caller marks the payment needs_refund). Service role only.';

-- ── A4. Expiry sweep: never expire a payment still in flight ───────────────
-- cron.schedule with an existing job name replaces that job. A warning, not
-- an error, where pg_cron is absent (local restores).
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
       and not exists (
         select 1 from public.booking_payments p
          where p.booking_id = b.id
            and (p.status in ('authorised','captured')
                 or (p.status = 'pending' and p.created_at > now() - interval '30 minutes')))
  $q$);
end
$cron$;

-- ── A5. Only the payment server confirms a booking that needs payment ──────
-- 10 Sep 2026 review: bookings RLS is still "allow all", so the gate is on the
-- BOOKING, never only on the previous status (pending_payment, then cancelled,
-- then confirmed walked round the first version), and it fires on EVERY column
-- (the first version only watched status, so a browser could rewrite what the
-- booking owed and pay 1p). For any API caller that is not the service role:
--   INSERT  refuses status prepaid, source widget (only booking-widget books
--           online) and any payment_kind, payment_due_minor or payment_currency.
--   UPDATE  refuses changing payment_kind, payment_due_minor, payment_currency;
--           refuses changing source to widget;
--           refuses changing package_id or covers while pending_payment or expired;
--           refuses ANY move into prepaid;
--           refuses pending_payment or expired into confirmed, due or late;
--           refuses any other move into confirmed, due or late when the booking
--           owes money (payment_kind with payment_due_minor above 0, or an online
--           booking whose package needs payment) and no authorised or captured
--           payment row covers it.
-- Staff paths still pass: create confirmed (host, walk_in, pos, phone), seat
-- (dining), depart, undo departed (dining), cancel, no-show, undo no-show to
-- confirmed when a paid row exists or nothing was owed (else expired), covers,
-- time, note and customer edits on a live booking, move_booking, preorder_token.
-- security definer so the paid row lookup is not at the mercy of the caller's
-- row security; search_path pinned.
create or replace function public.bookings_payment_gate() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_has_jwt boolean := coalesce(nullif(current_setting('request.jwt.claims', true), ''),
                                nullif(current_setting('request.jwt.claim.role', true), '')) is not null;
  v_kind text;
  v_due integer;
  v_pkg_needs boolean := false;
  v_paid boolean := false;
begin
  -- Not an API request (pg_cron, SQL editor, migrations): not gated.
  if not v_has_jwt then
    return new;
  end if;
  if auth.role() = 'service_role' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'prepaid' then
      raise exception 'Only the payment server can create a prepaid booking.'
        using errcode = 'P0001', hint = 'bookings_payment_gate: book through booking-widget, which charges first.';
    end if;
    if new.source = 'widget' then
      raise exception 'Online bookings can only be made through the booking page.'
        using errcode = 'P0001', hint = 'bookings_payment_gate: source widget is written by booking-widget only.';
    end if;
    if new.payment_kind is not null or new.payment_due_minor is not null or new.payment_currency is not null then
      raise exception 'What a booking owes can only be set by the booking page.'
        using errcode = 'P0001', hint = 'bookings_payment_gate: payment_* columns are written by booking-widget only.';
    end if;
    return new;
  end if;

  -- UPDATE
  if new.payment_kind is distinct from old.payment_kind
     or new.payment_due_minor is distinct from old.payment_due_minor
     or new.payment_currency is distinct from old.payment_currency then
    raise exception 'What a booking owes can only be set by the booking page.'
      using errcode = 'P0001', hint = 'bookings_payment_gate: payment_* columns are written by booking-widget only.';
  end if;
  if new.source is distinct from old.source and new.source = 'widget' then
    raise exception 'Online bookings can only be made through the booking page.'
      using errcode = 'P0001', hint = 'bookings_payment_gate: source widget is written by booking-widget only.';
  end if;
  if old.status in ('pending_payment','expired')
     and (new.package_id is distinct from old.package_id or new.covers is distinct from old.covers) then
    raise exception 'This booking is waiting for payment, so its package and covers cannot change.'
      using errcode = 'P0001', hint = 'bookings_payment_gate: what is due was fixed at book time.';
  end if;

  if new.status is distinct from old.status then
    if new.status = 'prepaid' then
      raise exception 'Only the payment server can mark a booking prepaid.'
        using errcode = 'P0001', hint = 'bookings_payment_gate: prepaid is set by booking-widget or adyen-webhook after payment.';
    end if;
    if old.status in ('pending_payment','expired') and new.status in ('confirmed','due','late') then
      raise exception 'This booking has not been paid, so it cannot be confirmed here.'
        using errcode = 'P0001', hint = 'bookings_payment_gate: only booking-widget or adyen-webhook confirm a booking after payment.';
    end if;
    if new.status in ('confirmed','due','late') then
      v_kind := new.payment_kind;
      v_due := coalesce(new.payment_due_minor, 0);
      if new.source = 'widget' and new.package_id is not null then
        select (p.payment_model = 'prepay' and coalesce(p.price, 0) > 0)
            or (p.payment_model = 'deposit' and coalesce(p.deposit_per_cover, 0) > 0)
          into v_pkg_needs
          from public.packages p where p.id = new.package_id;
        v_pkg_needs := coalesce(v_pkg_needs, false);
      end if;
      if (v_kind is not null and v_due > 0) or v_pkg_needs then
        select exists (
          select 1 from public.booking_payments bp
           where bp.booking_id = new.id
             and bp.status in ('authorised','captured')
             and bp.kind in ('hold','deposit','prepay')
             and coalesce(bp.refusal_reason, '') not ilike 'needs refund%'
             and (
               (v_kind = 'hold' and not v_pkg_needs)
               or (bp.kind in ('prepay','deposit') and round(bp.amount * 100) >= greatest(v_due, 1))
             )
        ) into v_paid;
        if not v_paid then
          raise exception 'This booking has not been paid, so it cannot be confirmed here.'
            using errcode = 'P0001', hint = 'bookings_payment_gate: no authorised or captured payment covers what this booking owes.';
        end if;
      end if;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists bookings_payment_gate on public.bookings;
create trigger bookings_payment_gate
  before insert or update on public.bookings
  for each row execute function public.bookings_payment_gate();

-- ---------------------------------------------------------------------------
-- Verify after applying (Part A)
-- ---------------------------------------------------------------------------
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'bookings'
--      and column_name in ('payment_kind','payment_due_minor','payment_currency');
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'booking_payments_status_check';
--   select proname from pg_proc where proname in ('promote_paid_booking','bookings_payment_gate');
--   select tgname from pg_trigger where tgrelid = 'public.bookings'::regclass and tgname = 'bookings_payment_gate';
--   select jobname, schedule, command from cron.job where jobname = 'bookings-expire-unpaid';
--   -- expect the command to mention: p.status = 'pending' and p.created_at > now() - interval '30 minutes'
--
-- The two bypasses the first version allowed, run as the anon key would. Each
-- block rolls back; every statement marked REFUSED must raise
-- 'This booking has not been paid, so it cannot be confirmed here.' or another
-- bookings_payment_gate message. Pick a pending_payment widget booking id first.
--   begin;
--     set local role anon;
--     select set_config('request.jwt.claims', '{"role":"anon"}', true);
--     update public.bookings set status = 'cancelled' where id = '<pending booking id>';   -- allowed
--     update public.bookings set status = 'confirmed' where id = '<pending booking id>';   -- REFUSED
--   rollback;
--   begin;
--     set local role anon;
--     select set_config('request.jwt.claims', '{"role":"anon"}', true);
--     update public.bookings set payment_kind = 'hold', payment_due_minor = 0
--      where id = '<pending booking id>';                                                 -- REFUSED
--   rollback;
--   begin;
--     set local role anon;
--     select set_config('request.jwt.claims', '{"role":"anon"}', true);
--     select public.create_booking('bk-gate-test', '7218c716-eeb4-4f96-b284-f3500823595c', current_date + 30,
--       '19:00', 120, 2, array['<a table id>'], '<a table id>', null, null, 'confirmed', 'widget',
--       'pk-1786580494031-hd32', '', 'widget');                                            -- REFUSED
--   rollback;


-- ═══════════════════════════════════════════════════════════════════════════
-- PART B, GUEST PRE ORDER CHOICES (10 Sep 2026)
--
-- A guest pre-ordering a package dish can pick its size and its options on
-- the booking page (the online item sheet). Before this, booking_preorders had
-- nowhere to keep them, so every hop dropped them: the booking page, the link
-- page, the host stand save, the seated till line and the kitchen ticket.
--
-- Writers: booking-widget (service role) validates every option against the
-- dish's modifier groups and the instruction groups in the config snapshot,
-- restamps prices and caps the list before writing. The host stand's
-- Save pre-orders writes the same columns back so it never wipes them.
-- Before this part is applied, both writers retry without the new columns.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── B1. The guest's size and options on each pick ──────────────────────────
alter table public.booking_preorders add column if not exists mods jsonb not null default '[]'::jsonb;
alter table public.booking_preorders add column if not exists variant_item_id text;
alter table public.booking_preorders add column if not exists variant_name text;

alter table public.booking_preorders drop constraint if exists booking_preorders_mods_array_check;
alter table public.booking_preorders add constraint booking_preorders_mods_array_check
  check (jsonb_typeof(mods) = 'array');

comment on column public.booking_preorders.mods is
  'The guest''s options for this dish, in the till''s line.mods shape: modifiers {id, name, label, itemId, groupLabel, price} and instructions {id, name, label, groupLabel, price 0, _instruction true}. Validated and priced by booking-widget. Seated onto the POS line, printed on the kitchen ticket.';
comment on column public.booking_preorders.variant_item_id is
  'The size the guest picked (a menu_items row whose parent is item_id). null = no size. item_id stays the package line''s item.';
comment on column public.booking_preorders.variant_name is
  'The size''s name at the time of the pick, shown as "Dish · Size" on the till and the kitchen ticket.';

-- ---------------------------------------------------------------------------
-- Verify after applying (Part B)
-- ---------------------------------------------------------------------------
--   select column_name, data_type, is_nullable, column_default from information_schema.columns
--    where table_schema = 'public' and table_name = 'booking_preorders'
--      and column_name in ('mods','variant_item_id','variant_name');
--   -- expect mods jsonb NO '[]'::jsonb, and the two text columns nullable
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'booking_preorders_mods_array_check';
