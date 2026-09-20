-- 20260919a2_OPS_fence_public_orders.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  DATABASE FENCE, STAGE 1, FILE A2: THE PAYMENT HALF.                      #
-- #  ONLY AFTER 20260919a1_OPS_fence_identity_devices.sql. This file checks    #
-- #  that itself and stops, changing nothing, if a1 is not in.                 #
-- #  Run it OUTSIDE SERVICE. Peter pastes it into the Ops SQL editor and       #
-- #  presses Run. Claude never runs it. The runbook is                        #
-- #  docs/FENCE_STAGE_1_PAYMENTS.md (runbook two).                            #
-- #  (runbook two).                                                            #
-- ############################################################################
--
-- THE SPLIT (20 Sep 2026). This file and 20260919a1_OPS_fence_identity_devices.sql are the two
-- halves of what used to be one file, 20260919a_OPS_fence_1_after_release.sql. Not a line of
-- either half's rules changed in the cut. a1 closes the identity, venue and device holes and
-- can be run on its own; this half is what makes a customer order's price and its "paid" the
-- SERVER's answer instead of the phone's.
--
-- WHAT THIS HALF CLOSES: an online, QR or catering order can no longer tell the database what
-- it cost or that it was paid. The server prices every line from the venue's own menu, takes
-- off only the discounts it can prove, and marks the order paid only when a real payment covers
-- it. It also takes the two tables a discount could be forged in (discount_rules,
-- stamp_transactions) away from browser writes.
--
-- WHAT IT NEEDS FIRST: a1. Its private tables (payment_proofs, public_order_tokens,
-- public_order_pending_checks, qr_tab_members, fence_attempts, fence_state), its helpers and
-- its placed_via trigger are what everything below is built on.
--
-- WHAT THIS FILE CHANGES:
--   6h. discount_rules: reads unchanged (tills and customer pages read the active rules),
--       writes are the venue's Back Office logins and the super admin. stamp_transactions:
--       browser writes go (only the loyalty edge functions, which run as service role, write
--       it). Without these two a discount or a stamp redemption could simply be invented.
--   7.  The server functions the app release calls: order_track_row, order_track_check,
--       qr_table_open_tabs, qr_tab_rounds, qr_tab_join, qr_table_tab_count, catering_day_load,
--       place_public_order, verify_public_order_payment, confirm_public_order_payment,
--       settle_qr_tab and the QR floor plan sync.
--   PAID MEANS THE SERVER'S OWN PRICE: place_public_order values every line from the menu by id
--       (menu_items, sizes, modifier options; a price below the menu counts at the menu price,
--       a quantity is a whole number, nothing is voided, an item that is not on the venue's menu
--       can never be paid automatically), less only discounts the server can prove: the venue's
--       active automatic discount rules (worked out again here), a real promo code (used up
--       here, once), and a loyalty reward redeemed for this very order. Money short of that is
--       payment_state 'short', shown to staff with the amount paid and the amount expected.
--
-- WHAT IT DOES NOT CHANGE YET (file 2, 20260919b, a full day after a1):
--   order_queue, kds_tickets, active_sessions, table_reservations keep "allow all";
--   print_jobs keeps its open policies; closed_checks keeps its open insert.
--
-- RULES OF THE FILE: no begin or commit (the SQL editor runs the whole paste as one
-- transaction, so any error means NOTHING changed and you can simply run it again);
-- every statement can run twice; functions are SECURITY DEFINER with search_path
-- pinned and EXECUTE only for the roles that need it; verification at the bottom;
-- roll back block in the comments at the very end (its heading says how to run it).


-- ============================================================================
-- 0. Guards and locks
-- ============================================================================
set local lock_timeout = '3s';

do $guard$
declare
  v_file_a boolean := false;
  v_file_b boolean := false;
begin
  if to_regclass('public.user_locations') is null
     or to_regclass('public.devices') is null
     or to_regclass('public.order_queue') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This file is for the OPS project (tbetcegmszzotrwdtqhi). This is not it. Nothing was changed.';
  end if;
  -- a1 first. Everything below is built on its private tables, its helpers and its
  -- placed_via trigger, so without it this file would leave half a fence behind.
  if to_regclass('public.fence_state') is not null then
    execute 'select exists (select 1 from public.fence_state where key = ''file_a'')' into v_file_a;
    execute 'select exists (select 1 from public.fence_state where key = ''file_b'')' into v_file_b;
  end if;
  if not v_file_a
     or to_regclass('public.payment_proofs') is null
     or to_regclass('public.public_order_tokens') is null
     or to_regclass('public.public_order_pending_checks') is null
     or to_regclass('public.qr_tab_members') is null
     or to_regprocedure('public._fence_num(text)') is null
     or to_regprocedure('public._menu_item_floor_minor(jsonb, text, boolean, text)') is null
     or not exists (select 1 from pg_trigger where tgname = 'order_queue_placed_via' and not tgisinternal) then
    raise exception 'STOPPED, NOTHING WAS CHANGED. Run 20260919a1_OPS_fence_identity_devices.sql first (runbook one). This file is the payment half and is built on what a1 creates.';
  end if;
  -- File 2 closes the orders and tables. Running this file after it would put back things
  -- file 2 finished, so it refuses, exactly as a1 does.
  if v_file_b
     or exists (select 1 from pg_policies where schemaname = 'public'
                 and policyname in ('order_queue_staff', 'kds_tickets_staff', 'closed_checks_insert_staff')) then
    raise exception 'STOPPED, NOTHING WAS CHANGED. File 2 (20260919b) has already run on this database, so this file must not run again. Nothing is wrong: there is nothing to do here.';
  end if;
end
$guard$;

-- The locks this half needs, in the same order a1 takes its own: the two busy tables a till
-- writes first, then the two tables a discount is proved from. (a1 locks the identity and
-- device tables; the cut simply gives each half the tables it really touches.) If a till holds
-- one of them for more than 3 seconds, or a deadlock is found, the file stops and says so.
do $locks$
begin
  lock table public.closed_checks, public.order_queue,
             public.discount_rules, public.stamp_transactions
    in access exclusive mode;
exception when lock_not_available or deadlock_detected then
  raise exception 'STOPPED, NOTHING WAS CHANGED. A till was busy with the orders tables for more than 3 seconds. Wait 10 seconds and press Run again.';
end
$locks$;

-- This half's own line in fence_state. file_a (a1) is what file 2 counts its full day from;
-- this one is here so the roll backs can see which halves are in.
insert into public.fence_state (key, value) values ('file_a2', '20260919a2')
  on conflict (key) do nothing;

-- ============================================================================
-- 6h. What the server prices an order from (fix round 2, 19 Sep)
-- ============================================================================
-- place_public_order now works out what an order is worth from the venue's own data:
-- menu_items and modifier_groups (written only by the venue's tills and Back Office since
-- this file: pos_can_access), promo codes and offers (no browser writes at all), the
-- loyalty ledgers, and the automatic discount rules. Two of those could still be written by
-- anyone, so they could not prove a discount:
--   * discount_rules had "Allow authenticated access" FOR ALL, and an anonymous customer
--     session is 'authenticated': anyone could add a 100 percent rule at any venue. Reads
--     stay exactly as they were (tills and customer pages read the active rules); writes
--     are the venue's Back Office logins (Back Office, Discounts) and the super admin.
--   * stamp_transactions had "service_all_stamp_tx" FOR ALL with true: anyone could write a
--     stamp card redemption. Only the loyalty edge functions write it (service role, which
--     RLS never limits), so browser writes go. Reads are unchanged (stage 2).
alter table public.discount_rules enable row level security;
drop policy if exists discount_rules_read on public.discount_rules;
create policy discount_rules_read on public.discount_rules
  for select
  using (auth.role() = 'authenticated');
drop policy if exists discount_rules_write_bo on public.discount_rules;
create policy discount_rules_write_bo on public.discount_rules
  for all
  using ((select public.is_super_admin())
         or (not (select public.is_anon_session()) and location_id in (select public.user_accessible_locations())))
  with check ((select public.is_super_admin())
              or (not (select public.is_anon_session()) and location_id in (select public.user_accessible_locations())));
drop policy if exists "Allow authenticated access" on public.discount_rules;
revoke insert, update, delete on table public.discount_rules from anon;

alter table public.stamp_transactions enable row level security;
drop policy if exists service_all_stamp_tx on public.stamp_transactions;
revoke insert, update, delete on table public.stamp_transactions from anon, authenticated;



-- ============================================================================
-- 7. Server functions for the customer pages (used by the app release)
-- ============================================================================
-- Every one is keyed to something the customer really holds: the tracking token
-- (or, for old links, the last 4 phone digits, throttled), the card payment id of
-- their own tab, or the table code the tab owner shared. None returns another
-- customer's name, phone, email, address or card ids.

-- 7a. The order tracker. p_key is the tracking token from place_public_order (128 bits),
-- the tab's card payment id (QR), or the last 4 digits of the phone (old share links).
-- Only the guessable last 4 path is throttled: 10 wrong tries per order per hour lock
-- that order's last 4 path for an hour (gap G6), and a platform wide breaker far above
-- normal use (20000 in 10 minutes) turns away only last 4 guesses. A token or payment id
-- always works, so nobody can lock a customer out of their own tracker.
create or replace function public._order_track_ok(p_location_id text, p_ref text, p_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_q      public.order_queue%rowtype;
  v_digits text := regexp_replace(coalesce(p_key, ''), '\D', '', 'g');
  v_bucket text := 'track:' || coalesce(p_location_id, '') || ':' || coalesce(p_ref, '');
begin
  if coalesce(p_location_id, '') = '' or coalesce(p_ref, '') = '' or coalesce(p_key, '') = '' then
    return false;
  end if;
  select * into v_q from public.order_queue q where q.location_id = p_location_id and q.ref = p_ref;
  if v_q.ref is not null then
    if exists (select 1 from public.public_order_tokens t
                where t.location_id = p_location_id and t.ref = p_ref and t.token = p_key) then
      return true;
    end if;
    if length(p_key) >= 12
       and (coalesce(v_q.customer ->> 'payment_intent_id', '') = p_key
            or coalesce(v_q.customer ->> 'payment_ref', '') = p_key) then
      return true;
    end if;
  end if;
  if length(v_digits) = 4 and length(p_key) <= 8 then
    if public._fence_is_locked(v_bucket) or public._fence_is_locked('track:last4:global') then
      return false;
    end if;
    if v_q.ref is not null
       and right(regexp_replace(coalesce(v_q.customer ->> 'phone', ''), '\D', '', 'g'), 4) = v_digits then
      return true;
    end if;
    perform public._fence_count('track:last4:global', 20000, interval '10 minutes', interval '5 minutes');
  end if;
  perform public._fence_count(v_bucket, 10, interval '1 hour', interval '1 hour');
  return false;
end;
$fn$;
revoke all on function public._order_track_ok(text, text, text) from public, anon, authenticated;

create or replace function public.order_track_check(p_location_id text, p_ref text, p_key text)
returns boolean
language sql
security definer
set search_path = public
as $fn$
  select public._order_track_ok(p_location_id, p_ref, p_key);
$fn$;

-- What the tracker page renders, and nothing else. The share link needs the last
-- 4 phone digits, so 'phone' carries only those. payment_state 'checking' means the
-- venue is still confirming the payment (the page says so, never "unpaid"). An order the
-- server found short ('short', fix round 2) reads 'checking' here too: the customer is
-- never asked to pay again from their phone, and staff sort it out.
create or replace function public.order_track_row(p_location_id text, p_ref text, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if not public._order_track_ok(p_location_id, p_ref, p_key) then
    return null;
  end if;
  return (
    select jsonb_build_object(
             'ref', q.ref, 'status', q.status, 'total', q.total, 'items', q.items,
             'collection_time', q.collection_time, 'is_asap', q.is_asap, 'type', q.type,
             'source', q.source, 'sent_at', q.sent_at, 'updated_at', q.updated_at, 'paid', q.paid,
             'payment_state', case when q.customer ->> 'payment_state' = 'short' then 'checking'
                                   else q.customer ->> 'payment_state' end,
             'customer', jsonb_strip_nulls(jsonb_build_object(
                 'delivery_mode', q.customer ->> 'delivery_mode',
                 'collection_at', q.customer ->> 'collection_at',
                 'tip', q.customer -> 'tip',
                 'tableLabel', q.customer ->> 'tableLabel',
                 'phone', nullif(right(regexp_replace(coalesce(q.customer ->> 'phone', ''), '\D', '', 'g'), 4), ''))))
      from public.order_queue q
     where q.location_id = p_location_id and q.ref = p_ref);
end;
$fn$;

-- 7b. QR tabs. The handle is an opaque md5 of the tab's card payment id: it names a
-- tab without revealing the payment id, the table code or any name (gap G4). A tab is
-- the set of open QR rows with tab_open true and the same card payment id; a pay now
-- order never counts as a round of anyone's tab (18 Sep review: a public order could
-- carry another tab's payment id and add itself to that tab).
create or replace function public.qr_table_open_tabs(p_location_id text, p_table_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select coalesce(jsonb_agg(t order by t.opened_at), '[]'::jsonb)
    from (
      select md5(q.customer ->> 'payment_intent_id')                               as tab_handle,
             min(coalesce(q.customer ->> 'tab_ref', q.ref))                        as tab_ref,
             min(coalesce(q.customer ->> 'tableLabel', p_table_id))                as table_label,
             min(coalesce(q.customer ->> 'tab_opened_at', q.created_at::text))     as opened_at,
             min(coalesce(q.customer ->> 'processor', 'stripe'))                   as processor,
             coalesce(sum(q.total), 0)                                             as total,
             count(*)::int                                                         as rounds,
             bool_or(coalesce(q.customer ->> 'tab_join_code', '') <> '')           as has_join_code
        from public.order_queue q
       where q.location_id = p_location_id
         and q.source = 'qr'
         and q.status <> 'collected'
         and q.customer ->> 'tableId' = p_table_id
         and public._fence_bool(q.customer ->> 'tab_open')
         and coalesce(q.customer ->> 'payment_intent_id', '') <> ''
       group by q.customer ->> 'payment_intent_id'
    ) t;
$fn$;

-- Is this session the tab's opener, or a phone that joined it with the table code?
create or replace function public._qr_tab_is_member(p_location_id text, p_pi text, p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select p_uid is not null and (
         exists (select 1 from public.qr_tab_members m
                  where m.location_id = p_location_id and m.pi_hash = md5(p_pi) and m.uid = p_uid)
      or exists (select 1
                   from public.order_queue q
                   join public.public_order_tokens t on t.location_id = q.location_id and t.ref = q.ref
                  where q.location_id = p_location_id and q.source = 'qr'
                    and public._fence_bool(q.customer ->> 'tab_open')
                    and q.customer ->> 'payment_intent_id' = p_pi
                    and coalesce(q.customer ->> 'tab_ref', q.ref) = q.ref
                    and t.placed_by = p_uid));
$fn$;
revoke all on function public._qr_tab_is_member(text, text, uuid) from public, anon, authenticated;

-- The tab and its rounds, for a caller who has proven the tab (internal). The tab block
-- carries the fields the close path needs (gap G16): payment id, processor, Stripe
-- account, Ryft ids, saved card id, hold amount, tab ref. The table code is included
-- only for the tab's opener and its members (p_with_code): anyone else holding the
-- payment id must not learn the code that lets a phone add rounds.
create or replace function public._qr_tab_payload(p_location_id text, p_pi text, p_with_code boolean)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  with r as (
    select q.*
      from public.order_queue q
     where q.location_id = p_location_id
       and q.source = 'qr'
       and q.status <> 'collected'
       and public._fence_bool(q.customer ->> 'tab_open')
       and q.customer ->> 'payment_intent_id' = p_pi
  ), first_round as (
    select * from r order by created_at limit 1
  )
  select case when not exists (select 1 from r) then null else jsonb_build_object(
    'tab', (select jsonb_strip_nulls(jsonb_build_object(
              'payment_intent_id', f.customer ->> 'payment_intent_id',
              'processor', coalesce(f.customer ->> 'processor', 'stripe'),
              'stripe_account', f.customer ->> 'stripe_account',
              'payment_session_id', f.customer ->> 'payment_session_id',
              'ryft_customer_id', f.customer ->> 'ryft_customer_id',
              'ryft_payment_method_id', f.customer ->> 'ryft_payment_method_id',
              'payment_method_id', f.customer ->> 'payment_method_id',
              'pre_auth_amount', public._fence_num(f.customer ->> 'pre_auth_amount'),
              'tab_ref', coalesce(f.customer ->> 'tab_ref', f.ref),
              'table_id', f.customer ->> 'tableId',
              'table_label', f.customer ->> 'tableLabel',
              'tab_join_code', case when p_with_code then (select max(x.customer ->> 'tab_join_code') from r x) end,
              'has_join_code', exists (select 1 from r x where coalesce(x.customer ->> 'tab_join_code', '') <> ''),
              'opened_at', coalesce(f.customer ->> 'tab_opened_at', f.created_at::text)))
              from first_round f),
    'rounds', (select coalesce(jsonb_agg(jsonb_build_object(
                  'ref', x.ref, 'status', x.status, 'items', x.items, 'total', x.total,
                  'created_at', x.created_at, 'sent_at', x.sent_at, 'location_id', x.location_id,
                  'customer', jsonb_strip_nulls(jsonb_build_object(
                      'tip', public._fence_num(x.customer ->> 'tip'),
                      'service_charge', public._fence_num(x.customer ->> 'service_charge'),
                      'tableId', x.customer ->> 'tableId',
                      'tableLabel', x.customer ->> 'tableLabel',
                      'round_ref', x.customer ->> 'round_ref',
                      'processor', x.customer ->> 'processor',
                      'pre_auth_amount', public._fence_num(x.customer ->> 'pre_auth_amount'),
                      'payment_intent_id', x.customer ->> 'payment_intent_id')))
                  order by x.created_at), '[]'::jsonb)
                 from r x)) end;
$fn$;
revoke all on function public._qr_tab_payload(text, text, boolean) from public, anon, authenticated;

-- The tab's owner, who holds its card payment id (their own stash). The table code
-- comes back only to the opener's session or a member.
create or replace function public.qr_tab_rounds(p_location_id text, p_payment_intent_id text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $fn$
  select case when coalesce(p_payment_intent_id, '') = '' then null
              else public._qr_tab_payload(p_location_id, p_payment_intent_id,
                                          public._qr_tab_is_member(p_location_id, p_payment_intent_id, auth.uid())) end;
$fn$;

-- Another phone at the table, with the table code the owner shared (gap G5).
-- 8 wrong codes per tab per hour lock that tab for an hour. A tab with no code (old
-- tabs) cannot be joined by phone; staff can add to it or close it. A phone that joins
-- with a session is remembered as a member, so its rounds need no code again.
create or replace function public.qr_tab_join(p_location_id text, p_tab_handle text, p_join_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_pi     text;
  v_code   text;
  v_bucket text := 'join:' || coalesce(p_location_id, '') || ':' || coalesce(p_tab_handle, '');
begin
  if coalesce(p_location_id, '') = '' or coalesce(p_tab_handle, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing');
  end if;
  if public._fence_is_locked(v_bucket) then
    return jsonb_build_object('ok', false, 'reason', 'locked', 'message', 'Too many wrong codes. Ask a member of staff.');
  end if;
  select q.customer ->> 'payment_intent_id', max(q.customer ->> 'tab_join_code')
    into v_pi, v_code
    from public.order_queue q
   where q.location_id = p_location_id
     and q.source = 'qr'
     and q.status <> 'collected'
     and public._fence_bool(q.customer ->> 'tab_open')
     and md5(q.customer ->> 'payment_intent_id') = p_tab_handle
   group by q.customer ->> 'payment_intent_id'
   limit 1;
  if v_pi is null then
    return jsonb_build_object('ok', false, 'reason', 'no_tab');
  end if;
  if coalesce(v_code, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'staff_only', 'message', 'This tab was opened on another phone. Ask a member of staff to help you join it.');
  end if;
  if public._fence_norm_code(p_join_code) <> public._fence_norm_code(v_code) then
    perform public._fence_count(v_bucket, 8, interval '1 hour', interval '1 hour');
    return jsonb_build_object('ok', false, 'reason', 'wrong_code', 'message', 'That code did not match.');
  end if;
  perform public._fence_clear(v_bucket);
  if auth.uid() is not null then
    insert into public.qr_tab_members (location_id, pi_hash, uid)
    values (p_location_id, md5(v_pi), auth.uid())
    on conflict do nothing;
  end if;
  return jsonb_build_object('ok', true) || public._qr_tab_payload(p_location_id, v_pi, true);
end;
$fn$;

create or replace function public.qr_table_tab_count(p_location_id text, p_table_id text)
returns integer
language sql
stable
security definer
set search_path = public
as $fn$
  select count(distinct coalesce(nullif(q.customer ->> 'payment_intent_id', ''), 'ref:' || q.ref))::int
    from public.order_queue q
   where q.location_id = p_location_id
     and q.source = 'qr'
     and q.status <> 'collected'
     and q.customer ->> 'tableId' = p_table_id;
$fn$;

-- 7c. Catering capacity: count and value only.
create or replace function public.catering_day_load(p_location_id text, p_date date)
returns table (order_count integer, order_value numeric)
language sql
stable
security definer
set search_path = public
as $fn$
  select count(*)::int, coalesce(sum(q.total), 0)
    from public.order_queue q
   where q.location_id = p_location_id
     and q.source = 'catering'
     and q.event_date = p_date
     and q.status is distinct from 'cancelled';
$fn$;

-- 7d. Placing a public order (online, QR, catering). Replaces the direct inserts the
-- customer pages make today (gaps B2, B3). The rules:
--   * a session is needed (anonymous is fine); 30 orders per session per 10 minutes;
--   * insert only: an order that exists is never changed (a retry by the same
--     session gets the same answer back);
--   * "paid" is decided by the SERVER from ITS OWN valuation of the order (fix round 2,
--     19 Sep: the first fix still trusted the lines and discounts the phone sent, and a
--     95 pound order was paid for 1p in seven ways). Every line is priced from the menu by
--     id: menu_items (a size is its own row) and modifier options by id; a price below
--     the menu counts at the menu price; a quantity is a whole number from 1; nothing is
--     voided; a line may carry no discount of its own; the menu's own names go to the
--     kitchen. A line whose id is not on the venue's menu can never be paid automatically.
--     From that the server takes only discounts it can prove: the venue's active automatic
--     discount rules (worked out again here, the way the storefront does), a promo code
--     that is real, live and has a use left (used up here, once, under the same key the
--     page's own promo-redeem call sends, so that call finds it done), and a loyalty
--     reward redeemed for this very order (its ledger row names this order's check). The
--     amount due is the larger of that and what the page itself said (the order total and
--     the check total, which carry tips, fees and tax);
--   * paid means verified money (card and gift card proofs the payment-proof edge function
--     wrote, bound to this order) covers the amount due. Short of that the order still
--     reaches the venue, never paid: payment_state 'checking' while no money is proven yet
--     (a late webhook), 'short' when money is proven but less than the amount due, or an
--     item is not on the menu. Staff see the amount paid and the amount due
--     (customer.order_pricing); verify_public_order_payment or a manager's
--     confirm_public_order_payment settles it. The order total staff see is never below the
--     amount due;
--   * a QR tab (open or a new round) needs a preauth proof for its card payment id; a new
--     round comes only from the tab's opener, a phone that joined it with the table code,
--     or a round that carries the code; every item of a round must be on the menu, and a
--     round may never take the tab past its card hold (fix round 2). The table code is
--     minted here (gap G5);
--   * a card payment id stays on a pay now order only when it is the order's own proven
--     payment, so no order can pose as part of another customer's tab;
--   * nothing the customer sends can set staff, the venue, the status, paid, or a
--     server field. Numbers that are not numbers become 0 (gaps G10, G11).

-- The server's own valuation of an order's lines. For each line: the menu row by id at this
-- venue (a size is its own row, with its own price), its price for the order's channel
-- (never below the lowest price the menu gives it there), each modifier option by id (the
-- rules are below), a whole quantity from 1 to 999. The line as stored gets the
-- server's price and quantity, loses any void flag or line discount, and keeps the page's
-- name only when it is one of the menu's names for that id (otherwise the menu's name goes
-- to the kitchen: a cheap item's id can never be sent under a dear item's name). Returns
-- { items, lines (only the lines the storefront really sells, for the discount rules and for
-- what a loyalty reward can make free), goods_minor, unknown_lines, max_unit_minor (the
-- dearest line the server could price, recorded for staff) } in pence.
--
-- OPTIONS (fix round 3, 19 Sep). An eighth way to forge "paid" was to repeat the venue's OWN
-- minus priced option until the line priced itself to zero: a 95 pound Feast with one real
-- "No onions" (-0.50) sent 190 times came to 0, so the amount due fell back to the penny the
-- phone declared, the order was paid, and one 1p check was written. It also walked a QR round
-- past its card hold and let settle_qr_tab close a whole tab for pennies. Every clamp before
-- this one clamped the PRICE of an option; nothing asked WHICH item the option belongs to, or
-- how many times its group allows it. An option may now take money OFF a line only when:
--   * it is in a modifier group the item is really assigned (menu_items.assigned_modifier_groups;
--     a size with none of its own uses the main product's, exactly as the till, kiosk and
--     storefront read them, src/lib/menuRules.js rule 2 and src/lib/kioskOptionGroups.js), or in
--     a sub group that one of those groups' options opens (a nested pick, OnlineItemSheet);
--   * that group has not already been counted the most times it allows on this line
--     (modifier_groups.max, then max_select, once by default, never more than 99);
--   * the same option is not repeated inside a group that is not a "pick with qty" group
--     (selection_type 'quantity'), because every other kind lets a customer pick an option once.
-- Anything else (an option of another item, a copy past what the group allows, an id that is
-- not on the menu at all) can only ADD to the line, never take anything off: it counts at the
-- largest of what the page said, its own menu price, and 0. So a line is never worth less than
-- the item's own floor price plus the options the venue really allows on it, a repeated minus
-- priced option can never reach zero, and legitimate free and minus priced options are
-- untouched. The options themselves still reach the kitchen exactly as the customer sent them.
--
-- WHAT THE STOREFRONT REALLY SELLS (fix round 4, 19 Sep; narrowed in fix round 5). A
-- menu_items row of the venue was enough: nothing asked whether the storefront sells it. A
-- variants parent (base 0, the row behind Half and Pint), an option only sub item, an archived
-- row and an 86'd row all passed, and _menu_item_floor_minor valued them at 0, so ten Colas
-- rode along free on a legitimately paid ticket. A line now counts as the server's own value
-- ONLY when the row is one the storefront sells:
--   * not a variants parent (no live child row points at it: lib/menuPricing.js variantChildren);
--   * not an option only sub item (lib/menuRules.js rule 1, the ONE rule every screen reads:
--     type 'subitem' and not sold alone. NOT "sold_alone is false" on its own: that column
--     DEFAULTS to false in the live Ops DB, so on its own it would refuse real products);
--   * not archived (both storefronts fetch archived = false);
--   * not 86'd (eighty_six, which online and catering both read to grey an item out).
-- Anything else is UNKNOWN: it counts at no less than what the page said and no less than any
-- price we do have, it is never worth zero, it is counted in unknown_lines (so the order can
-- never pay for itself and a manager confirms it), and it still reaches the kitchen under the
-- MENU's name. Lines like that take no part in the venue's automatic discounts either.
--
-- THE TEST IS THE STOREFRONT'S, NOT A STRICTER ONE (fix round 5, 19 Sep). Round 4 also refused
-- a row whose visibility.online was false. No storefront reads that key: OnlineSurface (which
-- is also the QR screen) filters on parent_id, archived, sold_alone and allergens only, and
-- catering has no such switch at all. Back Office still WRITES it, so an item a manager
-- switched off for Online is on the storefront and selling today, and the fence refused the
-- order that bought it: an honest customer who paid in full sat in "Payment short", and the
-- same two lines as a QR TAB ROUND were refused outright ("no longer on the menu"). The four
-- tests left are the ones that are certain, every one of them a rule a storefront really
-- applies. The one place the fence is deliberately LOOSER than the storefront is sold_alone:
-- online and the HubRise catalog hide any row whose sold_alone is exactly false, whatever its
-- type, but that column defaults to false in the live Ops DB, so the strict rule would have
-- refused real products. It costs nothing: such a row counts at its own menu price.
drop function if exists public._public_order_value(text, text, text, jsonb);
create or replace function public._public_order_value(p_loc text, p_source text, p_type text, p_items jsonb,
                                                      p_menu_id text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_channel  text := public._menu_channel_key(p_type);
  v_base     boolean := p_source = 'catering';
  -- The menu the page priced this basket on (fix round 7). Catering prices from `base` only
  -- (CateringSurface), so it never carries one.
  v_menu_id  text := case when p_source = 'catering' then null else nullif(left(btrim(coalesce(p_menu_id, '')), 80), '') end;
  v_86       text[] := '{}'::text[];
  v_parents  text[] := '{}'::text[];
  v_sell     boolean;
  v_floor    bigint;
  v_pname    text;
  v_opts     jsonb;
  v_out      jsonb := '[]'::jsonb;
  v_lines    jsonb := '[]'::jsonb;
  v_goods    bigint := 0;
  v_unknown  integer := 0;
  v_max_unit bigint := 0;
  it         jsonb;
  md         jsonb;
  v_mods     jsonb;
  v_opt      jsonb;
  v_ents     jsonb;
  v_pick     jsonb;
  v_used     jsonb;
  v_groups   text[];
  v_key      text;
  v_menu     bigint;
  r          public.menu_items%rowtype;
  p          public.menu_items%rowtype;
  v_id       text;
  v_item     bigint;
  v_modsum   bigint;
  v_mod      bigint;
  v_q        numeric;
  v_qty      integer;
  v_unit     bigint;
  v_names    text[];
  v_name     text;
  v_kitchen  text;
  v_receipt  text;
begin
  -- What the venue has switched off today (eighty_six: one row per 86'd item per venue, the
  -- table both storefronts read). Through to_regclass and EXECUTE, so this file still runs
  -- on a database that has no such table.
  if to_regclass('public.eighty_six') is not null then
    execute 'select coalesce(array_agg(e.item_id::text), ''{}''::text[]) from public.eighty_six e where e.location_id::text = $1'
      into v_86 using p_loc;
  end if;

  -- Every row that is the parent of a live size, once for the whole order (a variants parent
  -- is the row behind Half and Pint: it carries base 0 and is never sold itself).
  select coalesce(array_agg(distinct m.parent_id), '{}'::text[]) into v_parents
    from public.menu_items m
   where m.location_id = p_loc and m.parent_id is not null and coalesce(m.archived, false) = false;

  -- Every option of every modifier group at this venue, by option id: which group holds it,
  -- how many times that group allows one on a line, whether the group lets the SAME option be
  -- picked more than once ("pick with qty"), its menu price in pence and the menu's name for
  -- it. An option id that appears in more than one group gets one entry per group.
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) into v_opts
    from (
      select o ->> 'id' as k,
             jsonb_agg(jsonb_build_object(
               'g',   g.id,
               'max', greatest(1, least(99, coalesce(nullif(g.max, 0), nullif(g.max_select, 0), 1))),
               'rep', coalesce(g.selection_type, '') = 'quantity',
               'p',   round(public._fence_num(o ->> 'price') * 100)::bigint,
               'n',   nullif(coalesce(o ->> 'name', o ->> 'label', ''), '')
             ) order by g.id) as v
        from public.modifier_groups g
        cross join lateral jsonb_array_elements(case when jsonb_typeof(g.options) = 'array' then g.options else '[]'::jsonb end) o
       where g.location_id = p_loc
         and jsonb_typeof(o) = 'object'
         and coalesce(o ->> 'id', '') <> ''
       group by o ->> 'id'
    ) t;

  -- AN OPTION THE SERVER CANNOT MATCH BY ID IS WORTH NOTHING (fix round 7, 20 Sep). Round 6
  -- charged such an option at the dearest menu price of any option with the same NAME at the
  -- venue, to stop "Bacon" with a made up id riding a kitchen ticket at 0.00. That rule
  -- charged the storefront's OWN free choices: instruction picks and typed notes arrive with
  -- an ig-<group>-<value> id that is on no modifier group by design
  -- (src/surfaces/online/OnlineItemSheet.jsx:450) or with no id at all
  -- (src/components/InlineItemFlow.jsx:271, src/surfaces/ProductModal.jsx:169,
  -- src/lib/kioskBasket.js:51), and they carry price 0 because that is what the guest was
  -- charged. At any venue whose instruction wording matches one of its own option names
  -- (Sauce, Cheese, Oat, Gluten free, Extra shot), a guest who paid in full came out
  -- "Payment short", got no kitchen ticket, and saw a charge they never paid printed on their
  -- own line; "Check payment" could never clear it. So the server gives an unmatched option
  -- the only value it can prove: ZERO. It can still never TAKE anything off a line (round 3's
  -- repeated minus option forgery stays shut), and what the page declared above zero is kept,
  -- because that is what our own storefront charged.
  -- THE ACCEPTED COST: a doctored page can put a free extra on a kitchen ticket (a real 5.00
  -- Bacon sent under a made up id, declared at 0.00, reaches the kitchen for nothing). That is
  -- one extra given away on one line, and it is the price of never refusing a guest who paid
  -- exactly what our own page asked for. It is written up in docs/FENCE_STAGE_1_PAYMENTS.md.

  for it in select x from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) x loop
    if jsonb_typeof(it) is distinct from 'object' then
      v_unknown := v_unknown + 1;
      v_out := v_out || jsonb_build_array(it);
      continue;
    end if;
    v_id := nullif(btrim(coalesce(it ->> 'itemId', it ->> 'item_id', '')), '');
    r := null;
    p := null;
    if v_id is not null then
      select * into r from public.menu_items m where m.id = v_id and m.location_id = p_loc;
    end if;
    if r.id is not null and r.parent_id is not null then
      select * into p from public.menu_items m where m.id = r.parent_id and m.location_id = p_loc;
    end if;
    -- Does the storefront sell this row, and can the server price it?
    v_sell := false;
    v_floor := null;
    if r.id is not null then
      v_floor := public._menu_item_floor_minor(r.pricing, v_channel, v_base, v_menu_id);
      v_sell := not (r.id = any(v_parents))
                and coalesce(r.archived, false) = false
                and not (coalesce(r.type, '') = 'subitem' and r.sold_alone is not true)
                and not (r.id = any(v_86));
      -- A row the storefront SELLS but the server could not put a price on is not unknown: it
      -- is FREE, because that is exactly what the customer was charged. resolveItemPrice
      -- (lib/menuPricing.js) answers 0 for {"base": 0} and for a row with no pricing at all,
      -- and nothing on the storefront hides a 0.00 row, so a tap water, a cutlery pack or a no
      -- charge side is shown, added and sold for nothing (fix round 5). Refusing to price it
      -- put honest fully paid orders into "Payment short" and REFUSED a QR tab round that
      -- carried one. The rows that used to ride along free are held by the sellability test
      -- above, not by this.
      if v_sell and v_floor is null then
        v_floor := 0;
      end if;
    end if;
    v_item := round(public._fence_num(it ->> 'price') * 100)::bigint;
    if v_sell and v_floor is not null then
      v_item := greatest(v_item, v_floor);
    else
      -- Not on this venue's menu, not something the storefront sells, or nothing the server
      -- can put a price on: UNKNOWN. Never free, never paid by itself.
      v_unknown := v_unknown + 1;
      v_item := greatest(v_item, coalesce(v_floor, 0), 0);
    end if;

    -- Which groups this item's options may come from: its own list, or (a size with none of
    -- its own) the main product's, plus the sub groups those groups' options open.
    v_groups := '{}'::text[];
    if r.id is not null then
      select coalesce(array_agg(t.g), '{}'::text[]) into v_groups
        from (select nullif(btrim(case when jsonb_typeof(e) = 'string' then e #>> '{}'
                                       when jsonb_typeof(e) = 'object' then coalesce(e ->> 'groupId', e ->> 'id') end), '') as g
                from jsonb_array_elements(case when jsonb_typeof(r.assigned_modifier_groups) = 'array'
                                               then r.assigned_modifier_groups else '[]'::jsonb end) e) t
       where t.g is not null;
      if cardinality(v_groups) = 0 and p.id is not null then
        select coalesce(array_agg(t.g), '{}'::text[]) into v_groups
          from (select nullif(btrim(case when jsonb_typeof(e) = 'string' then e #>> '{}'
                                         when jsonb_typeof(e) = 'object' then coalesce(e ->> 'groupId', e ->> 'id') end), '') as g
                  from jsonb_array_elements(case when jsonb_typeof(p.assigned_modifier_groups) = 'array'
                                                 then p.assigned_modifier_groups else '[]'::jsonb end) e) t
         where t.g is not null;
      end if;
      if cardinality(v_groups) > 0 then
        select v_groups || coalesce((select array_agg(distinct nullif(btrim(o ->> 'subGroupId'), ''))
                                       from public.modifier_groups g2
                                       cross join lateral jsonb_array_elements(case when jsonb_typeof(g2.options) = 'array'
                                                                                    then g2.options else '[]'::jsonb end) o
                                      where g2.location_id = p_loc
                                        and g2.id = any(v_groups)
                                        and nullif(btrim(coalesce(o ->> 'subGroupId', '')), '') is not null), '{}'::text[])
          into v_groups;
      end if;
    end if;

    v_modsum := 0;
    v_mods := '[]'::jsonb;
    v_used := '{}'::jsonb;
    for md in select x from jsonb_array_elements(case when jsonb_typeof(it -> 'mods') = 'array' then it -> 'mods' else '[]'::jsonb end) x loop
      if jsonb_typeof(md) is distinct from 'object' then
        v_mods := v_mods || jsonb_build_array(md);
        continue;
      end if;
      v_mod := round(public._fence_num(md ->> 'price') * 100)::bigint;
      v_ents := case when coalesce(md ->> 'id', '') <> '' then v_opts -> (md ->> 'id') end;
      v_pick := null;
      v_menu := null;
      v_name := null;
      if v_ents is not null then
        v_name := nullif(coalesce(v_ents -> 0 ->> 'n', ''), '');
        -- One pass: the dearest menu price this option has anywhere (the floor for a copy that
        -- does not count), and the first group of this item that still has room for it.
        for v_opt in select x from jsonb_array_elements(v_ents) x loop
          v_menu := greatest(coalesce(v_menu, (v_opt ->> 'p')::bigint), (v_opt ->> 'p')::bigint);
          continue when v_pick is not null or not ((v_opt ->> 'g') = any(v_groups));
          v_key := (v_opt ->> 'g') || '|' || (md ->> 'id');
          if coalesce((v_used ->> (v_opt ->> 'g'))::integer, 0) < (v_opt ->> 'max')::integer
             and (coalesce((v_opt ->> 'rep')::boolean, false)
                  or coalesce((v_used ->> v_key)::integer, 0) = 0) then
            v_pick := v_opt;
          end if;
        end loop;
      end if;
      if v_pick is not null then
        -- An option this item really has, within what its group allows: the menu price is the
        -- floor, and the venue's own minus price counts.
        v_mod := greatest(v_mod, (v_pick ->> 'p')::bigint);
        v_key := (v_pick ->> 'g') || '|' || (md ->> 'id');
        v_used := v_used
                  || jsonb_build_object(v_pick ->> 'g', coalesce((v_used ->> (v_pick ->> 'g'))::integer, 0) + 1)
                  || jsonb_build_object(v_key, coalesce((v_used ->> v_key)::integer, 0) + 1);
        v_name := coalesce(nullif(coalesce(v_pick ->> 'n', ''), ''), v_name);
      else
        -- Not one of this item's options, or more copies than its group allows: it can only
        -- add to the line, never take anything off. An id the venue's menu does not have at
        -- all (v_ents null) is worth NOTHING to the server, so the line keeps what the page
        -- said for it, floored at zero: an instruction pick and a typed note stay free, and a
        -- minus priced option repeated past its group's limit cannot take a penny off (fix
        -- round 7 restores this; see the note above the loop).
        v_mod := greatest(v_mod, coalesce(v_menu, 0), 0);
      end if;
      if v_name is not null then
        md := md || jsonb_build_object('name', v_name, 'label', v_name);
      end if;
      md := md || jsonb_build_object('price', round(v_mod / 100.0, 2));
      v_modsum := v_modsum + v_mod;
      v_mods := v_mods || jsonb_build_array(md);
    end loop;

    v_q := public._fence_num(it ->> 'qty');
    v_qty := case when v_q >= 1 then least(999, ceil(v_q))::integer else 1 end;
    v_unit := greatest(0, v_item + v_modsum);
    v_goods := v_goods + v_unit * v_qty;
    if v_sell and v_floor is not null then
      v_max_unit := greatest(v_max_unit, greatest(0, v_item));
    end if;

    it := (it - 'voided' - 'discount') || jsonb_build_object('qty', v_qty, 'price', round(v_item / 100.0, 2));
    if it ? 'mods' then
      it := it || jsonb_build_object('mods', v_mods);
    end if;

    if r.id is not null then
      v_name := coalesce(nullif(r.menu_name, ''), r.name);
      v_pname := null;
      v_names := array[lower(btrim(coalesce(r.name, ''))), lower(btrim(coalesce(r.menu_name, ''))),
                       lower(btrim(coalesce(r.receipt_name, ''))), lower(btrim(coalesce(r.kitchen_name, '')))];
      if p.id is not null then
        -- The storefront names a size "Parent - Size" with a long dash (OnlineItemSheet).
        v_pname := coalesce(nullif(p.menu_name, ''), p.name);
        v_name := v_pname || ' ' || chr(8212) || ' ' || coalesce(nullif(r.menu_name, ''), r.name);
        v_names := v_names || lower(v_name);
      end if;
      if lower(btrim(coalesce(it ->> 'name', ''))) <> all (array_remove(v_names, '')) then
        it := it || jsonb_build_object('name', v_name);
      end if;
      v_kitchen := nullif(btrim(coalesce(it ->> 'kitchenName', it ->> 'kitchen_name', '')), '');
      if v_kitchen is not null and lower(v_kitchen) is distinct from lower(btrim(coalesce(r.kitchen_name, ''))) then
        it := (it - 'kitchen_name') || jsonb_build_object('kitchenName', nullif(r.kitchen_name, ''));
      end if;
      v_receipt := nullif(btrim(coalesce(it ->> 'receiptName', it ->> 'receipt_name', '')), '');
      if v_receipt is not null and lower(v_receipt) is distinct from lower(btrim(coalesce(r.receipt_name, '')))
         and lower(v_receipt) <> all (array_remove(v_names, '')) then
        it := (it - 'receipt_name') || jsonb_build_object('receiptName', nullif(r.receipt_name, ''));
      end if;
      if v_sell and v_floor is not null then
        -- Only a line the storefront really sells, at the server's own price, takes part in
        -- the venue's automatic discounts or can be what a free item loyalty reward makes
        -- free (id, parent id and the names lib/loyaltyMenuMatch.js matches on).
        v_lines := v_lines || jsonb_build_array(jsonb_build_object(
                     'unit', v_unit, 'qty', v_qty, 'cat', r.cat,
                     'cats', to_jsonb(coalesce(r.cats, '{}'::text[])),
                     'id', r.id, 'pid', r.parent_id, 'item', greatest(0, v_item),
                     'name', coalesce(nullif(r.menu_name, ''), r.name),
                     'pname', v_pname, 'label', v_name));
      end if;
    end if;
    v_out := v_out || jsonb_build_array(it);
  end loop;

  return jsonb_build_object('items', v_out, 'lines', v_lines, 'goods_minor', v_goods,
                            'unknown_lines', v_unknown, 'max_unit_minor', v_max_unit);
end;
$fn$;

-- The venue's automatic discounts on these lines, worked out the way the storefront's
-- engine does (src/lib/discountEngine.js evaluateAutoDiscounts): active rules for this
-- channel, live on the venue's clock (or 20 minutes ago, for a basket built just before a
-- window closed), highest priority first; buy X get Y (the cheapest qualifying units get the
-- reward: percent, amount or free) and bundles (a fixed price for one unit from each group);
-- each unit takes part in one rule at most. Only lines on the menu take part, with the
-- server's own prices and the menu's categories. In pence.
create or replace function public._public_order_auto(p_loc text, p_channel text, p_lines jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_tz      text;
  u_line    integer[];
  u_price   bigint[];
  u_used    boolean[];
  l_cat     text[];
  l_cats    jsonb[];
  v_n       integer := 0;
  v_total   bigint := 0;
  v_applied jsonb := '[]'::jsonb;
  r         public.discount_rules%rowtype;
  g         jsonb;
  v_ids     text[];
  v_rids    text[];
  v_avail   integer[];
  v_deal    integer[];
  v_reward  integer[];
  v_pick    integer[];
  v_claim   integer[];
  v_need    integer;
  v_fire    integer;
  v_count   integer;
  v_save    bigint;
  v_orig    bigint;
  v_rtype   text;
  v_rv      numeric;
  v_gi      integer;
  k         integer;
begin
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('total_minor', 0, 'rules', '[]'::jsonb);
  end if;
  select coalesce(nullif(l.timezone, ''), 'Europe/London') into v_tz from public.locations l where l.id::text = p_loc;

  select array_agg(x ->> 'cat' order by li), array_agg(coalesce(x -> 'cats', '[]'::jsonb) order by li)
    into l_cat, l_cats
    from jsonb_array_elements(p_lines) with ordinality as l(x, li);
  select array_agg(li::integer order by li, q), array_agg(coalesce((x ->> 'unit')::bigint, 0) order by li, q)
    into u_line, u_price
    from jsonb_array_elements(p_lines) with ordinality as l(x, li)
    cross join lateral generate_series(1, greatest(1, least(999, coalesce((x ->> 'qty')::integer, 1)))) as q;
  v_n := coalesce(cardinality(u_line), 0);
  if v_n = 0 or v_n > 5000 then
    return jsonb_build_object('total_minor', 0, 'rules', '[]'::jsonb);
  end if;
  u_used := array_fill(false, array[v_n]);

  for r in
    select * from public.discount_rules d
     where d.location_id = p_loc and d.active is true
     order by d.priority desc nulls last, d.sort_order nulls last, d.created_at, d.id
  loop
    if r.channels is not null and public._fence_js_truthy(r.channels)
       and not public._fence_js_truthy(r.channels -> p_channel) then
      continue;
    end if;
    if not (public._fence_rule_live(r.schedule, v_tz, now())
            or public._fence_rule_live(r.schedule, v_tz, now() - interval '20 minutes')) then
      continue;
    end if;
    v_rtype := coalesce(r.reward_type, 'percent');
    v_rv := coalesce(r.reward_value, 0);

    if coalesce(r.trigger_type, 'buy_x') = 'bundle' then
      continue when jsonb_typeof(r.trigger_groups) is distinct from 'array' or jsonb_array_length(r.trigger_groups) = 0;
      v_fire := null;
      for v_gi in 0 .. jsonb_array_length(r.trigger_groups) - 1 loop
        g := r.trigger_groups -> v_gi;
        v_ids := case when public._fence_js_truthy(g -> 'categoryIds')
                      then case when jsonb_typeof(g -> 'categoryIds') = 'array'
                                then array(select jsonb_array_elements_text(g -> 'categoryIds')) else '{}'::text[] end
                      when public._fence_js_truthy(g -> 'category_ids')
                      then case when jsonb_typeof(g -> 'category_ids') = 'array'
                                then array(select jsonb_array_elements_text(g -> 'category_ids')) else '{}'::text[] end
                      else '{}'::text[] end;
        v_need := greatest(1, floor(public._fence_num(coalesce(g ->> 'qty', '1')))::integer);
        select count(*) into v_count
          from generate_subscripts(u_line, 1) s
         where not u_used[s] and public._fence_cat_match(l_cat[u_line[s]], l_cats[u_line[s]], v_ids);
        if v_count < v_need then
          v_fire := 0;
          exit;
        end if;
        v_fire := least(coalesce(v_fire, v_count / v_need), v_count / v_need);
      end loop;
      continue when coalesce(v_fire, 0) < 1;
      v_orig := 0;
      v_claim := '{}'::integer[];
      for v_gi in 0 .. jsonb_array_length(r.trigger_groups) - 1 loop
        g := r.trigger_groups -> v_gi;
        v_ids := case when public._fence_js_truthy(g -> 'categoryIds')
                      then case when jsonb_typeof(g -> 'categoryIds') = 'array'
                                then array(select jsonb_array_elements_text(g -> 'categoryIds')) else '{}'::text[] end
                      when public._fence_js_truthy(g -> 'category_ids')
                      then case when jsonb_typeof(g -> 'category_ids') = 'array'
                                then array(select jsonb_array_elements_text(g -> 'category_ids')) else '{}'::text[] end
                      else '{}'::text[] end;
        v_need := greatest(1, floor(public._fence_num(coalesce(g ->> 'qty', '1')))::integer);
        v_pick := array(select s from generate_subscripts(u_line, 1) s
                         where not u_used[s] and public._fence_cat_match(l_cat[u_line[s]], l_cats[u_line[s]], v_ids)
                         order by u_price[s], s
                         limit v_need * v_fire);
        v_orig := v_orig + coalesce((select sum(u_price[s]) from unnest(v_pick) s), 0);
        v_claim := v_claim || v_pick;
      end loop;
      v_save := round(greatest(0, v_orig - v_rv * 100 * v_fire))::bigint;
      continue when v_save <= 0;
      foreach k in array v_claim loop
        u_used[k] := true;
      end loop;

    elsif coalesce(r.trigger_type, 'buy_x') = 'buy_x' then
      v_ids := coalesce(r.trigger_category_ids, '{}'::text[]);
      v_rids := coalesce(r.reward_category_ids, '{}'::text[]);
      v_need := coalesce(r.trigger_qty, 2) + coalesce(r.reward_qty, 1);
      continue when v_need <= 0;
      v_avail := array(select s from generate_subscripts(u_line, 1) s
                        where not u_used[s] and public._fence_cat_match(l_cat[u_line[s]], l_cats[u_line[s]], v_ids)
                        order by u_price[s], s);
      continue when coalesce(cardinality(v_avail), 0) < v_need;
      v_fire := cardinality(v_avail) / v_need;
      v_deal := v_avail[1 : v_need * v_fire];
      v_reward := v_deal[1 : greatest(0, coalesce(r.reward_qty, 1) * v_fire)];
      if coalesce(cardinality(v_rids), 0) > 0 then
        v_reward := array(select s from unnest(v_reward) with ordinality as a(s, o)
                           where public._fence_cat_match(l_cat[u_line[s]], l_cats[u_line[s]], v_rids)
                           order by o);
      end if;
      continue when coalesce(cardinality(v_reward), 0) = 0;
      select coalesce(sum(case v_rtype
                            when 'percent' then round(u_price[s] * v_rv / 100)
                            when 'amount'  then least(round(v_rv * 100), u_price[s])
                            when 'free'    then u_price[s]
                            else 0 end), 0)::bigint
        into v_save
        from unnest(v_reward) s;
      continue when v_save <= 0;
      foreach k in array v_deal loop
        u_used[k] := true;
      end loop;
    else
      continue;
    end if;

    v_total := v_total + v_save;
    v_applied := v_applied || jsonb_build_array(jsonb_build_object('rule_id', r.id, 'name', r.name, 'saving_minor', v_save));
  end loop;

  return jsonb_build_object('total_minor', v_total, 'rules', v_applied);
end;
$fn$;

-- A check id that belongs to this order: the customer pages mint it as chk-<ref>-<random>,
-- once per checkout, and the gift, loyalty and promo keys carry it (giftcommit:<check>:...,
-- redeem:<check>:..., stampredeem:<check>:..., <check>:<CODE>). Refs are unique per venue,
-- so a key made for another order never names this one.
create or replace function public._public_order_check_bound(p_check_id text, p_ref text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $fn$
  select coalesce(p_check_id, '') <> '' and coalesce(p_ref, '') <> ''
     and strpos(p_check_id, ':') = 0
     and left(p_check_id, length('chk-' || p_ref || '-')) = 'chk-' || p_ref || '-';
$fn$;

-- Does a payment proof belong to this order (fix round 2)? The processor's own order
-- reference decides when it has one (meta.order_ref). A gift card debit or a loyalty
-- redemption has none: its ledger key names the check, which must be this order's own. A
-- card payment the processor tied to no order belongs to the FIRST order that named it: if
-- an order at the venue placed before this one (p_since: this order's own time; NULL while
-- it is being placed) already names it, in its kept check or as its card payment id, it
-- is that order's, not this one's. So a copy that names someone else's payment can neither
-- use it nor keep its real owner from using it.
create or replace function public._public_order_proof_bound(p_loc text, p_ref text, p_check_id text,
                                                            p_kind text, p_payment_ref text, p_meta jsonb,
                                                            p_since timestamptz default null)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $fn$
begin
  if nullif(btrim(coalesce(p_meta ->> 'order_ref', '')), '') is not null then
    return p_meta ->> 'order_ref' = p_ref;
  end if;
  if p_kind in ('gift', 'loyalty') then
    return public._public_order_check_bound(p_check_id, p_ref)
       and split_part(coalesce(p_payment_ref, ''), ':', 2) = p_check_id;
  end if;
  return not exists (select 1 from public.public_order_pending_checks c
                      where c.location_id = p_loc and c.ref <> p_ref and p_payment_ref = any(c.payment_refs)
                        and c.created_at < coalesce(p_since, 'infinity'::timestamptz))
     and not exists (select 1 from public.order_queue q
                      where q.location_id = p_loc and q.ref <> p_ref and q.source in ('online', 'qr', 'catering')
                        and (q.customer ->> 'payment_ref' = p_payment_ref or q.customer ->> 'payment_intent_id' = p_payment_ref)
                        and q.created_at < coalesce(p_since, 'infinity'::timestamptz));
end;
$fn$;

-- The discounts an order says it has (so the server knows which promo code to check and
-- how much loyalty money the page took off): p_order.discounts when the page sends them
-- ([{type, label, amount_minor}] for the release), else the check's discounts (a catering
-- promo carries code and amount in pounds). A catering pay later order names its code on
-- the customer block. Declared amounts are only an upper limit; the server proves each one.
create or replace function public._public_order_declared(p_order jsonb, p_check jsonb, p_source text)
returns jsonb
language plpgsql
immutable
set search_path = public
as $fn$
declare
  v_list  jsonb := '[]'::jsonb;
  v_code  text := null;
  v_promo bigint := 0;
  v_loy   bigint := 0;
  v_amt   bigint;
  e       jsonb;
begin
  if jsonb_typeof(p_order -> 'discounts') = 'array' then
    v_list := p_order -> 'discounts';
  elsif jsonb_typeof(p_check -> 'discounts') = 'array' then
    v_list := p_check -> 'discounts';
  end if;
  for e in select x from jsonb_array_elements(v_list) x loop
    continue when jsonb_typeof(e) is distinct from 'object';
    v_amt := case when e ? 'amount_minor' then round(public._fence_num(e ->> 'amount_minor'))::bigint
                  else round(public._fence_num(coalesce(e ->> 'amount', e ->> 'value')) * 100)::bigint end;
    v_amt := greatest(0, least(v_amt, 10000000));
    if lower(coalesce(e ->> 'type', '')) = 'promo' then
      if v_code is null then
        v_code := nullif(upper(btrim(coalesce(nullif(e ->> 'code', ''), e ->> 'label', ''))), '');
        v_promo := v_amt;
      end if;
    elsif lower(coalesce(e ->> 'type', '')) = 'loyalty' then
      v_loy := v_loy + v_amt;
    end if;
  end loop;
  if v_loy = 0 and jsonb_typeof(p_check -> 'loyalty') = 'object' then
    v_loy := greatest(0, least(round(public._fence_num(p_check -> 'loyalty' ->> 'discount_value'))::bigint, 10000000));
  end if;
  if v_code is null and p_source = 'catering' and jsonb_typeof(p_order -> 'customer') = 'object' then
    v_code := nullif(upper(btrim(coalesce(p_order -> 'customer' ->> 'promo_code', ''))), '');
    if v_code is not null then
      v_promo := greatest(0, least(round(public._fence_num(p_order -> 'customer' ->> 'promo_discount') * 100)::bigint, 10000000));
    end if;
  end if;
  return jsonb_build_object('promo_code', v_code, 'promo_minor', v_promo, 'loyalty_minor', v_loy);
end;
$fn$;

-- A promo code the server can prove (the checks promo-redeem makes: the code exists, is not
-- voided or expired, its offer is active and live, for this venue's company and this venue,
-- the spend is met), worth what the offer gives on this subtotal (percent of it, or a fixed
-- amount up to it). With p_consume the code is USED UP here, once per order, by the same
-- promo_redeem_atomic the till uses, keyed <check id>:<CODE>: the page's own promo-redeem
-- call after the order sends the same key and finds it done; a second order can never use
-- a spent code. In pence.
create or replace function public._public_order_promo(p_loc text, p_code text, p_subtotal_minor bigint,
                                                      p_check_id text, p_consume boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_code text := upper(btrim(coalesce(p_code, '')));
  v_org  uuid;
  c      public.promo_codes%rowtype;
  o      public.offers%rowtype;
  v_sub  numeric := greatest(0, coalesce(p_subtotal_minor, 0)) / 100.0;
  v_amt  numeric := 0;
  v_key  text;
  v_res  jsonb;
begin
  if v_code = '' then
    return jsonb_build_object('ok', false, 'reason', 'none');
  end if;
  select l.org_id into v_org from public.locations l where l.id::text = p_loc;
  select * into c from public.promo_codes pc where upper(pc.code) = v_code limit 1;
  if c.id is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found', 'code', v_code);
  end if;
  if c.org_id is distinct from v_org then
    return jsonb_build_object('ok', false, 'reason', 'wrong_venue', 'code', v_code);
  end if;
  if c.status in ('voided', 'expired') or c.voided_at is not null
     or (c.expires_at is not null and c.expires_at < now()) then
    return jsonb_build_object('ok', false, 'reason', 'expired', 'code', v_code);
  end if;
  select * into o from public.offers ofr where ofr.id = c.offer_id;
  if o.id is null or not coalesce(o.active, false)
     or (o.valid_from is not null and o.valid_from > now())
     or (o.valid_to is not null and o.valid_to < now()) then
    return jsonb_build_object('ok', false, 'reason', 'inactive', 'code', v_code);
  end if;
  if coalesce(cardinality(o.venue_ids), 0) > 0 and not (p_loc = any(o.venue_ids)) then
    return jsonb_build_object('ok', false, 'reason', 'wrong_venue', 'code', v_code);
  end if;
  if o.min_spend is not null and v_sub < o.min_spend then
    return jsonb_build_object('ok', false, 'reason', 'min_spend', 'code', v_code);
  end if;
  v_amt := greatest(0, case o.reward_type
                         when 'percent' then round(v_sub * coalesce(o.reward_value, 0) / 100, 2)
                         when 'fixed'   then least(coalesce(o.reward_value, 0), v_sub)
                         else 0 end);
  v_key := case when coalesce(p_check_id, '') <> '' then p_check_id || ':' || v_code end;
  if p_consume then
    if v_key is null then
      return jsonb_build_object('ok', false, 'reason', 'no_check', 'code', v_code);
    end if;
    if not exists (select 1 from public.promo_redemptions pr where pr.idempotency_key = v_key) then
      if to_regprocedure('public.promo_redeem_atomic(uuid, integer, uuid, uuid, text, uuid, text, text, uuid, numeric, numeric, text)') is null then
        return jsonb_build_object('ok', false, 'reason', 'unsupported', 'code', v_code);
      end if;
      v_res := public.promo_redeem_atomic(c.id, c.uses_count, o.id, c.org_id, c.code, c.customer_id, p_loc,
                                          p_check_id, null, v_sub, v_amt, v_key);
      if coalesce(v_res ->> 'result', '') not in ('redeemed', 'idempotent_hit') then
        return jsonb_build_object('ok', false, 'reason', coalesce(v_res ->> 'result', 'failed'), 'code', v_code);
      end if;
    end if;
  elsif c.uses_count >= coalesce(c.uses_allowed, 1)
        and not (v_key is not null and exists (select 1 from public.promo_redemptions pr where pr.idempotency_key = v_key)) then
    -- Spent, unless the use is this very order's own (a retry).
    return jsonb_build_object('ok', false, 'reason', 'already_used', 'code', v_code);
  end if;
  return jsonb_build_object('ok', true, 'code', v_code, 'amount_minor', round(v_amt * 100)::bigint, 'offer_id', o.id);
end;
$fn$;

-- The comparison key for an item name, exactly as lib/loyaltyMenuMatch.js makes it (trim,
-- runs of whitespace to one space, lower case, and a spaced dash of any kind folded to
-- " - "). Loyalty is per COMPANY and menu_items ids are per site, so a Free Latte set up at
-- one venue is matched at another by NAME.
create or replace function public._loyalty_label_key(p text)
returns text
language sql
immutable
set search_path = pg_catalog
as $fn$
  select regexp_replace(
           lower(btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'))),
           ' [-' || chr(8208) || '-' || chr(8213) || chr(8722) || '] ', ' - ', 'g');
$fn$;

-- What a FREE ITEM loyalty reward is worth on this order, in pence: the CHEAPEST line the
-- reward could make free, priced by the server (p_lines carries only lines the storefront
-- really sells, at the server's own price). A line is eligible on the same rule every
-- surface uses (lib/loyaltyMenuMatch.js): one of its ids (the item, or the size's parent) is
-- a saved id, or one of its names matches a saved name (its own name, "Parent - Size", or
-- the parent alone). 0 when the reward names no item, or names nothing that is on this
-- order: the server cannot value it, so it is worth nothing and the order comes out short.
drop function if exists public._loyalty_free_item_minor(jsonb, jsonb);
create or replace function public._loyalty_free_item_minor(p_reward_items jsonb, p_lines jsonb,
                                                           p_cap_minor bigint default null)
returns bigint
language plpgsql
immutable
set search_path = pg_catalog
as $fn$
declare
  -- The ceiling on a reward that names NO item (fix round 7, 20 Sep). An unconfigured free
  -- item programme is otherwise a voucher for the cheapest line, which on a one line basket
  -- is the whole order: a genuine stamp redemption took a 95.00 Feast for a penny. The
  -- programme's own ceiling is used when it has one (meta.reward.max_minor, written by
  -- supabase/functions/_shared/paymentProofRules.js loyaltyRewardMeta from the reward row's
  -- max_value_minor / max_value and the stamp programme's reward_config); with none, 15.00,
  -- which is about the dearest single item a stamp card is ever meant to give away. Above
  -- that the order simply comes out SHORT and staff confirm it on the till. It is written up
  -- in docs/FENCE_STAGE_1_PAYMENTS.md, with the query that names the unconfigured rows.
  v_no_item_cap constant bigint := 1500;
  v_ids  text[] := '{}'::text[];
  v_keys text[] := '{}'::text[];
  v_min  bigint := null;
  v_key  text;
  e      jsonb;
  l      jsonb;
begin
  if jsonb_typeof(p_reward_items) is distinct from 'array' or jsonb_typeof(p_lines) is distinct from 'array' then
    return 0;
  end if;
  for e in select x from jsonb_array_elements(p_reward_items) x loop
    continue when jsonb_typeof(e) is distinct from 'object';
    if nullif(btrim(coalesce(e ->> 'id', '')), '') is not null then
      v_ids := v_ids || btrim(e ->> 'id');
    end if;
    v_key := public._loyalty_label_key(e ->> 'name');
    if v_key <> '' then
      v_keys := v_keys || v_key;
    end if;
  end loop;
  -- A FREE ITEM REWARD THAT NAMES NOTHING IS THE CHEAPEST LINE (fix round 6, 19 Sep). This
  -- used to return 0, so the stamp card default (free_item with no eligible_items) was worth
  -- nothing to the server and EVERY honest redemption landed in "Payment short" with the
  -- guest's stamp card already spent. The storefront does the opposite and always has:
  -- src/surfaces/online/OnlineCheckout.jsx:911-913 - when the reward configures no item,
  -- "fallback to cheapest in cart", the cart sorted by price and the first line's price taken
  -- as the discount. Mirrored here over the lines the SERVER priced (p_lines carries only the
  -- rows the storefront really sells, at the server's own prices), so a reward that names
  -- nothing is worth the cheapest of those and nothing else. The ceilings above it are
  -- unchanged: one reward per order, never more than the page declared, never more than the
  -- order has left to give away. Fix round 7 adds the ceiling this branch needed of its own
  -- (v_no_item_cap above): an unconfigured programme can no longer give away a 95.00 main.
  if cardinality(v_ids) = 0 and cardinality(v_keys) = 0 then
    for l in select x from jsonb_array_elements(p_lines) x loop
      continue when jsonb_typeof(l) is distinct from 'object';
      v_min := least(v_min, greatest(0, coalesce((l ->> 'item')::bigint, 0)));
    end loop;
    -- Bounded: the storefront's own fallback, but never more than the programme allows.
    return least(greatest(0, coalesce(v_min, 0)),
                 greatest(0, coalesce(nullif(p_cap_minor, 0), v_no_item_cap)));
  end if;
  for l in select x from jsonb_array_elements(p_lines) x loop
    continue when jsonb_typeof(l) is distinct from 'object';
    if coalesce(l ->> 'id', '') = any(v_ids)
       or coalesce(l ->> 'pid', '') = any(v_ids)
       or (public._loyalty_label_key(l ->> 'name') <> '' and public._loyalty_label_key(l ->> 'name') = any(v_keys))
       or (public._loyalty_label_key(l ->> 'label') <> '' and public._loyalty_label_key(l ->> 'label') = any(v_keys))
       or (public._loyalty_label_key(l ->> 'pname') <> '' and public._loyalty_label_key(l ->> 'pname') = any(v_keys)) then
      v_min := least(v_min, greatest(0, coalesce((l ->> 'item')::bigint, 0)));
    end if;
  end loop;
  return greatest(0, coalesce(v_min, 0));
end;
$fn$;

-- The loyalty discount the server can prove for this order: a redemption row in the
-- loyalty ledgers (loyalty_transactions for points, stamp_transactions for stamp cards,
-- both server written) whose key names THIS order's check, never more than the page
-- declared, never more than what the SERVER can say the reward is worth, ONE reward per
-- order, and never more than the order itself is worth. In pence.
--
-- WHAT A REWARD IS WORTH (fix round 4, 19 Sep). This used to fall back to the dearest single
-- item on the basket whenever the loyalty proof carried no money value, and payment-proof
-- writes the marker 1 for every reward that has none: free_item (the stamp card default) and
-- discount_percent. So one genuine free coffee redemption paid for a 95 pound Feast, and two
-- of them paid a 190 pound basket for a penny. Now, per redemption:
--   * the proof's own amount when it is a real money value (a fixed amount reward);
--   * a percent reward: that percent of what is left to pay for the goods (below);
--   * a free item reward: the cheapest line on the order the reward could make free, priced
--     by the server (_loyalty_free_item_minor);
--   * anything the server cannot value, including a redemption with no proof at all: ZERO.
-- The reward's shape reaches us on the proof (payment-proof writes meta.reward from the
-- company's loyalty_rewards row or stamp card programme). There is no dearest item fallback
-- any more: a reward we cannot value takes nothing off, the order is short, and staff see it
-- and confirm on the till.
--
-- ONE REWARD, AND NEVER MORE THAN THE ORDER (fix round 5, 19 Sep). Round 4 valued each
-- redemption honestly and then ADDED them up, with nothing tying the sum to what the order is
-- worth. loyalty-redeem keys on 'redeem:<check_id>:<reward_id>', so two DIFFERENT rewards
-- against the same check are two legal redemptions, each spending its own points: a crafted
-- page on an authorised path, not a forgery. Two genuine 50 percent rewards took a 125 pound
-- order to 0.00 and it booked as PAID with no money at all; 10 percent plus 20 percent gave a
-- flat 30 percent where the venue meant one reward; three free coffee stamp cards took 9.00
-- off an order carrying ONE 3 pound coffee. Two rules close it, and they are the rules the
-- app already follows (OnlineCheckout's rewardApplied is a SINGLE object: the storefront never
-- applies two):
--   * ONE reward per order counts. Of every redemption the server can value, the DEAREST one
--     is the discount; the rest take nothing off.
--   * p_cap_minor is the ceiling: the server's own goods value AFTER the venue's automatic
--     deals and any promo code, which is what is actually left to pay for the goods, so the
--     whole loyalty benefit can never be worth more than the order still owes.
-- An order that declares more loyalty than that is simply short: it books nothing, staff see
-- "Payment short" and confirm on the till.
--
-- A PERCENT REWARD IS THE STOREFRONT'S PERCENT (fix round 6, 19 Sep). Round 5 worked the
-- percent out on the ceiling above, which is net of the promo code. The storefront does not:
-- src/surfaces/online/OnlineCheckout.jsx:891 takes the percent of discountedSubtotalMinor,
-- which is the subtotal less the venue's AUTOMATIC deals only (:291), before any promo code;
-- :338 then subtracts the reward and the promo side by side from that same figure. So a guest
-- using a promo code and a percent reward together was charged one number by our own page and
-- refused by the server for paying it: 50 percent plus MULTI10 on a 125 pound basket asks for
-- 50.00 and came out due 56.20, "Payment short", no kitchen ticket, and "Check payment" could
-- never clear it because verify repeated the sum. The percent is now worked out on
-- p_base_minor, the goods less the venue's automatic deals, exactly as the page does; the
-- total benefit still cannot exceed p_cap_minor, so the order can never be given away twice
-- over and the eleventh forgery stays shut.
drop function if exists public._public_order_loyalty(text, text, text, bigint, bigint);
drop function if exists public._public_order_loyalty(text, text, text, bigint, bigint, jsonb);
drop function if exists public._public_order_loyalty(text, text, text, bigint, bigint, bigint, jsonb);
create or replace function public._public_order_loyalty(p_loc text, p_ref text, p_check_id text,
                                                        p_declared bigint, p_base_minor bigint,
                                                        p_cap_minor bigint, p_lines jsonb)
returns bigint
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_base bigint := greatest(0, coalesce(p_base_minor, 0));
  v_ceil bigint := greatest(0, coalesce(p_cap_minor, 0));
  v_cap  bigint := 0;
  v_val  bigint;
  v_amt  bigint;
  v_meta jsonb;
  v_rw   jsonb;
  v_type text;
  v_pct  numeric;
  k      text;
begin
  if coalesce(p_declared, 0) <= 0 or not public._public_order_check_bound(p_check_id, p_ref) then
    return 0;
  end if;
  for k in
    select lt.idempotency_key
      from public.loyalty_transactions lt
     where lt.location_id = p_loc and lt.type = 'redeem'
       and left(lt.idempotency_key, length('redeem:' || p_check_id || ':')) = 'redeem:' || p_check_id || ':'
    union
    select st.idempotency_key
      from public.stamp_transactions st
     where st.location_id::text = p_loc and st.type = 'redeem'
       and left(st.idempotency_key, length('stampredeem:' || p_check_id || ':')) = 'stampredeem:' || p_check_id || ':'
  loop
    select pp.amount_minor, pp.meta into v_amt, v_meta
      from public.payment_proofs pp
     where pp.kind = 'loyalty' and pp.payment_ref = k and pp.location_id = p_loc
     order by pp.amount_minor desc nulls last
     limit 1;
    v_val := 0;
    if coalesce(v_amt, 0) > 1 then
      v_val := v_amt;
    elsif v_amt is not null then
      v_rw := case when jsonb_typeof(v_meta -> 'reward') = 'object' then v_meta -> 'reward' end;
      v_type := lower(coalesce(v_rw ->> 'type', ''));
      if v_type = 'discount_percent' then
        -- mirrors OnlineCheckout.jsx:891 (percent of discountedSubtotalMinor, :291)
        v_pct := least(100, greatest(0, public._fence_num(v_rw ->> 'percent')));
        v_val := floor(v_base * v_pct / 100)::bigint;
      elsif v_type = 'free_item' then
        v_val := public._loyalty_free_item_minor(v_rw -> 'items', p_lines,
                                                 greatest(0, round(public._fence_num(v_rw ->> 'max_minor'))::bigint));
      end if;
    end if;
    -- ONE reward per order: the dearest redemption the server can value, never the sum.
    v_cap := greatest(v_cap, greatest(0, coalesce(v_val, 0)));
  end loop;
  -- Never more than the page declared, and never more than the order has left to give away
  -- (mirrors OnlineCheckout.jsx:338, where the reward and the promo code come off the same
  -- discounted subtotal inside a max(0, ...): the customer is never charged below zero, and
  -- the venue never gives away more than the order is worth).
  return least(p_declared, v_cap, v_ceil);
end;
$fn$;

-- The amount due: the larger of what the page said (order total, check total) and the
-- server's valuation less the proven discounts, less a few pence for rounding (the pages
-- count in floating point).
create or replace function public._public_order_due(p_pricing jsonb, p_loyalty bigint)
returns bigint
language sql
immutable
set search_path = pg_catalog
as $fn$
  select greatest(coalesce((p_pricing ->> 'client_due_minor')::bigint, 0),
                  greatest(0::bigint,
                           coalesce((p_pricing ->> 'goods_minor')::bigint, 0)
                           - coalesce((p_pricing ->> 'auto_minor')::bigint, 0)
                           - coalesce((p_pricing ->> 'promo_minor')::bigint, 0)
                           - greatest(0::bigint, coalesce(p_loyalty, 0))
                           - coalesce((p_pricing ->> 'tolerance_minor')::bigint, 0)));
$fn$;

-- The payment references a check names (card payment ids, gift and loyalty ledger
-- keys). verify_public_order_payment finds a late proof by them.
create or replace function public._public_order_payment_refs(p_check jsonb, p_pi text)
returns text[]
language sql
immutable
set search_path = public
as $fn$
  select coalesce(array_agg(distinct x) filter (where coalesce(x, '') <> ''), '{}'::text[])
    from (
      select p_check ->> 'stripe_payment_intent_id' as x
      union all select p_pi
      union all select p_check -> 'gift_card' ->> 'idempotency_key'
      union all select p_check -> 'loyalty' ->> 'idempotency_key'
      union all select e ->> 'id'
        from jsonb_array_elements(case when jsonb_typeof(p_check -> 'payment_intents') = 'array' then p_check -> 'payment_intents' else '[]'::jsonb end) e
      union all select l ->> 'idempotency_key'
        from jsonb_array_elements(case when jsonb_typeof(p_check -> 'gift_card' -> 'legs') = 'array' then p_check -> 'gift_card' -> 'legs' else '[]'::jsonb end) l
    ) refs;
$fn$;

-- The closed check of a public order, built from what the page sent but with every
-- server field forced, and the SERVER's lines (priced, whole quantities, nothing voided).
-- id, total, status and closed_at are added when it is written.
create or replace function public._public_order_check_row(p_loc text, p_ref text, p_source text, p_type text,
                                                          p_check jsonb, p_items jsonb, p_customer jsonb)
returns jsonb
language sql
stable
set search_path = public
as $fn$
  select jsonb_build_object(
      'id', left(coalesce(nullif(btrim(p_check ->> 'id'), ''), 'chk-' || p_source || '-' || p_ref), 80),
      'ref', p_ref,
      'location_id', p_loc,
      'table_id', left(p_check ->> 'table_id', 80),
      'table_label', left(p_check ->> 'table_label', 80),
      'staff_name', null,
      'items', coalesce((select jsonb_agg(case when jsonb_typeof(x) = 'object' then x || '{"voided": false}'::jsonb else x end
                                          order by n)
                           from jsonb_array_elements(p_items) with ordinality as i(x, n)), '[]'::jsonb),
      'subtotal', round(public._fence_num(p_check ->> 'subtotal'), 2),
      'tax', round(public._fence_num(p_check ->> 'tax'), 2),
      'payment_method', left(p_check ->> 'payment_method', 200),
      'covers', greatest(1, least(99, public._fence_num(p_check ->> 'covers')::int)),
      'voided', false,
      'refunded', false,
      'server', left(coalesce(nullif(p_check ->> 'server', ''), initcap(p_source)), 40),
      'order_type', left(coalesce(nullif(p_check ->> 'order_type', ''), p_type), 40),
      'customer', case when jsonb_typeof(p_check -> 'customer') = 'object'
                       then (p_check -> 'customer') - 'paid' - 'staff' - 'payment_state' - 'payment_unverified'
                            - 'payment_confirmed_by' - 'order_pricing' - 'placed_via'
                       else p_customer end,
      'discounts', case when jsonb_typeof(p_check -> 'discounts') = 'array' then p_check -> 'discounts' else '[]'::jsonb end,
      'service', round(public._fence_num(p_check ->> 'service'), 2),
      'tip', round(public._fence_num(p_check ->> 'tip'), 2),
      'method', left(coalesce(nullif(p_check ->> 'method', ''), 'card'), 40),
      'refunds', '[]'::jsonb,
      'tax_breakdown', case when jsonb_typeof(p_check -> 'tax_breakdown') = 'array' then p_check -> 'tax_breakdown' else '[]'::jsonb end,
      'tax_amount', case when p_check ? 'tax_amount' and p_check ->> 'tax_amount' is not null
                         then round(public._fence_num(p_check ->> 'tax_amount'), 2) end,
      'source', p_source,
      'gift_card', case when jsonb_typeof(p_check -> 'gift_card') = 'object' then p_check -> 'gift_card' end,
      'loyalty', case when jsonb_typeof(p_check -> 'loyalty') = 'object' then p_check -> 'loyalty' end,
      'promo', case when jsonb_typeof(p_check -> 'promo') = 'object' then p_check -> 'promo' end,
      'stripe_payment_intent_id', left(p_check ->> 'stripe_payment_intent_id', 120),
      'payment_intents', case when jsonb_typeof(p_check -> 'payment_intents') = 'array' then p_check -> 'payment_intents' end,
      -- v5.9.11 (rebase, fix round 3): what paid the check, one entry per tender
      -- (src/lib/accounting/tenders.js). The accounting layer posts card, cash, gift card and
      -- credits from this, so a check written here must carry it or a QR, online or catering
      -- sale lands in Unallocated. The page builds it from what it really charged, like
      -- gift_card, loyalty and promo beside it; _public_order_write_check falls back to one
      -- card tender for the money the server itself proved, so the column is never empty.
      'tenders', case when jsonb_typeof(p_check -> 'tenders') = 'array'
                       and jsonb_array_length(p_check -> 'tenders') > 0
                      then p_check -> 'tenders' end,
      'processor', case when p_check ->> 'processor' in ('stripe', 'ryft', 'adyen') then p_check ->> 'processor' else 'stripe' end,
      'customer_phone', left(p_check ->> 'customer_phone', 40),
      'closed_at_wanted', p_check ->> 'closed_at');
$fn$;

-- Write a public order's paid check: total = the verified card amount (in pence). A
-- catering check keeps the event time as its sales date (the old catering page did
-- this), within a year ahead; every other check is dated now.
--
-- THE MONEY ON THE CHECK IS THE SERVER'S OWN (fix round 6, 19 Sep). Round 5 capped the tip a
-- TAB CLOSE books (settle_qr_tab), and left the commonest paths alone: an online, QR pay now
-- or catering check still booked the subtotal, the service charge, the tip and the tender
-- list the phone declared, with only `total` replaced by the money the server proved. A 95
-- pound Feast paid with a real 9500 card proof, sent as subtotal 0.00 and tip 95.00, booked
-- exactly that: the venue booked a zero sale, and 95 pounds of its own takings became a tip
-- that flows into tronc, the Daily Trading P&L and the Xero posting. Four figures are now the
-- server's:
--   * subtotal: the server's own cart sum (p_server.goods_minor), which is precisely what
--     every storefront sends - OnlineCheckout.jsx:237 and :1358, QrCheckout.jsx:119 and :528,
--     CateringCheckout.jsx:281 all send the basket at menu prices, before any discount;
--   * service, then tip: only out of money the proof actually captured ABOVE what the order
--     owed for its goods, the same ceiling settle_qr_tab uses. On the pages the service
--     charge and the tip sit on top of the discounted subtotal (OnlineCheckout.jsx:338), so
--     money that is not there was never a tip;
--   * tenders: kept only when what the page declared adds up to the money the server itself
--     proved (src/lib/accounting/tenders.js: "the sum is the full bill plus tips"), otherwise
--     rebuilt from the server's own figures exactly as OnlineCheckout.jsx:1366-1371 builds
--     it - the gift card as debited, the loyalty and promo credits, then the card.
-- p_server: { goods_minor, owed_minor, proven_minor, gift_minor, loyalty_minor, promo_minor }.
-- An empty p_server leaves the old behaviour, so nothing that has not been given the figures
-- silently books zero.
drop function if exists public._public_order_write_check(jsonb, bigint, jsonb);
create or replace function public._public_order_write_check(p_cc jsonb, p_total_minor bigint, p_extra_customer jsonb,
                                                            p_server jsonb default '{}'::jsonb)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_id     text := left(coalesce(nullif(p_cc ->> 'id', ''), 'chk-' || coalesce(p_cc ->> 'ref', 'public')), 80);
  v_closed timestamptz := now();
  v_want   timestamptz;
  v_row    jsonb;
  v_tip    bigint;
  v_svc    bigint;
  v_head   bigint;
  v_gift   bigint;
  v_loy    bigint;
  v_promo  bigint;
  v_sum    bigint;
  v_tsum   bigint;
  v_ok     boolean;
  v_list   jsonb;
  v_fee    bigint;
  v_xtax   bigint;
  v_t_card bigint;
  v_t_gift bigint;
  v_t_loy  bigint;
  v_t_prom bigint;
  v_method text;
  g        jsonb;
begin
  if p_cc ->> 'source' = 'catering' then
    begin
      v_want := nullif(p_cc ->> 'closed_at_wanted', '')::timestamptz;
    exception when others then
      v_want := null;
    end;
    if v_want is not null and v_want > now() - interval '1 day' and v_want < now() + interval '400 days' then
      v_closed := v_want;
    end if;
  end if;
  if exists (select 1 from public.closed_checks c where c.id = v_id) then
    v_id := left(v_id, 75) || '-' || public._fence_random_code(4);
  end if;
  v_row := (p_cc - 'closed_at_wanted')
           || jsonb_build_object('id', v_id, 'total', round(greatest(0, p_total_minor) / 100.0, 2),
                                 'status', 'paid', 'closed_at', v_closed);

  v_gift  := greatest(0, coalesce((p_server ->> 'gift_minor')::bigint, 0));
  v_loy   := greatest(0, coalesce((p_server ->> 'loyalty_minor')::bigint, 0));
  v_promo := greatest(0, coalesce((p_server ->> 'promo_minor')::bigint, 0));
  v_tip   := greatest(0, round(public._fence_num(v_row ->> 'tip') * 100)::bigint);
  v_svc   := greatest(0, round(public._fence_num(v_row ->> 'service') * 100)::bigint);
  if coalesce(p_server, '{}'::jsonb) <> '{}'::jsonb then
    -- Money the proof captured over what the order owed for its goods: all a service charge
    -- and a tip can ever have come out of (settle_qr_tab uses the same ceiling). The service
    -- charge is part of the bill so it is served first, the tip is what is left.
    -- THE DELIVERY FEE AND ADDED-ON SALES TAX ARE NOT HEADROOM (fix round 7, 20 Sep). The
    -- server never prices either, so both sat inside the headroom and a page could relabel
    -- them as gratuity: a 20.00 burger with a 4.00 courier fee on a genuine 2400 proof booked
    -- a 4.00 tip, and a US venue could turn its sales tax the same way. Both come off first.
    -- Only EXCLUSIVE (added-on) tax counts: UK VAT is already inside the goods the server
    -- priced, so subtracting it would cap an honest tip at nothing.
    v_fee  := greatest(0, round(public._fence_num(v_row -> 'customer' ->> 'delivery_fee') * 100)::bigint);
    select greatest(0, coalesce(sum(round(public._fence_num(e ->> 'tax') * 100)), 0))::bigint
      into v_xtax
      from jsonb_array_elements(case when jsonb_typeof(v_row -> 'tax_breakdown') = 'array'
                                     then v_row -> 'tax_breakdown' else '[]'::jsonb end) e
     where lower(coalesce(e -> 'rate' ->> 'type', e ->> 'type', '')) = 'exclusive';
    v_head := greatest(0, greatest(0, coalesce((p_server ->> 'proven_minor')::bigint, 0))
                          - greatest(0, coalesce((p_server ->> 'owed_minor')::bigint, 0))
                          - v_fee - coalesce(v_xtax, 0));
    v_svc  := least(v_svc, v_head);
    v_tip  := least(v_tip, v_head - v_svc, greatest(0, p_total_minor));
    -- mirrors OnlineCheckout.jsx:237/:1358, QrCheckout.jsx:119/:528, CateringCheckout.jsx:281
    v_row := v_row || jsonb_build_object(
               'subtotal', round(greatest(0, coalesce((p_server ->> 'goods_minor')::bigint, 0)) / 100.0, 2),
               'service', round(v_svc / 100.0, 2),
               'tip', round(v_tip / 100.0, 2));
    -- The declared tender list is kept only when it adds up to the money the server itself
    -- proved: the card it is booking, plus the gift card, loyalty and promo it verified
    -- (src/lib/accounting/tenders.js THE RULE). Two pence of slack, because the pages count
    -- in floating point. Its methods must also be ones these three storefronts really use
    -- (OnlineCheckout.jsx:1366-1371, QrCheckout.jsx:536, CateringCheckout.jsx:282 emit card,
    -- gift_card, loyalty and promo and nothing else), so a page cannot book a card sale into
    -- the cash drawer. Anything else is not booked at all: it is rebuilt below.
    -- The tips ON the tenders must add up to the tip the server allowed too, or a page could
    -- send the right grand total split the wrong way ("card 0.00, tip 95.00") and the
    -- accounting layer would still pay 95 pounds of takings out through tronc.
    -- THE SPLIT, NOT JUST THE SUM (fix round 7, 20 Sep). Round 6 kept any list that added up,
    -- so a page could move a real card sale onto a credit line ("loyalty 90.00, card 5.00" on
    -- a 95.00 card payment): the day then booked 5.00 of card against 95.00 that really hit
    -- the PSP, and the Xero card clearing account and the payout reconciliation were 90.00
    -- apart on a sale that looked perfectly normal. Each method must now also be no more than
    -- what the SERVER proved for it: card the money it is booking, gift card a real gift
    -- debit, loyalty and promo what it allowed. With the sum rule beside it that forces every
    -- line to match. Anything else is rebuilt from the server's own figures below.
    if jsonb_typeof(v_row -> 'tenders') = 'array' then
      select coalesce(sum(round(public._fence_num(t ->> 'amount') * 100)::bigint
                          + round(public._fence_num(t ->> 'tip') * 100)::bigint), 0),
             coalesce(sum(round(public._fence_num(t ->> 'tip') * 100)::bigint), 0),
             bool_and(lower(coalesce(t ->> 'method', '')) in ('card', 'gift_card', 'loyalty', 'promo')),
             coalesce(sum(round(public._fence_num(t ->> 'amount') * 100)::bigint
                          + round(public._fence_num(t ->> 'tip') * 100)::bigint)
                        filter (where lower(coalesce(t ->> 'method', '')) = 'card'), 0),
             coalesce(sum(round(public._fence_num(t ->> 'amount') * 100)::bigint
                          + round(public._fence_num(t ->> 'tip') * 100)::bigint)
                        filter (where lower(coalesce(t ->> 'method', '')) = 'gift_card'), 0),
             coalesce(sum(round(public._fence_num(t ->> 'amount') * 100)::bigint
                          + round(public._fence_num(t ->> 'tip') * 100)::bigint)
                        filter (where lower(coalesce(t ->> 'method', '')) = 'loyalty'), 0),
             coalesce(sum(round(public._fence_num(t ->> 'amount') * 100)::bigint
                          + round(public._fence_num(t ->> 'tip') * 100)::bigint)
                        filter (where lower(coalesce(t ->> 'method', '')) = 'promo'), 0)
        into v_sum, v_tsum, v_ok, v_t_card, v_t_gift, v_t_loy, v_t_prom
        from jsonb_array_elements(v_row -> 'tenders') t;
      if not coalesce(v_ok, false)
         or abs(v_sum - (greatest(0, p_total_minor) + v_gift + v_loy + v_promo)) > 2
         or abs(v_tsum - v_tip) > 2
         or v_t_card > greatest(0, p_total_minor) + 2
         or v_t_gift > v_gift + 2
         or v_t_loy > v_loy + 2
         or v_t_prom > v_promo + 2 then
        v_row := v_row - 'tenders';
      end if;
    end if;
  else
    v_tip := least(v_tip, greatest(0, p_total_minor));
  end if;

  -- tenders (v5.9.11): the accounting layer posts card, cash, gift card and credits from this
  -- column, so a check written here must never leave it empty or the sale lands in
  -- Unallocated. The page normally sends its own list; when it did not (an older page, or the
  -- tab close, which the server values itself), or when what it sent did not add up, the
  -- server's own list: the gift card as debited, the loyalty and promo credits, then the card
  -- with the tip on it, exactly as OnlineCheckout.jsx:1366-1371 and singleTender() build it.
  if jsonb_typeof(v_row -> 'tenders') is distinct from 'array'
     and (p_total_minor > 0 or v_gift > 0 or v_loy > 0 or v_promo > 0) then
    v_list := '[]'::jsonb;
    for g in select x from jsonb_array_elements(
               case when jsonb_typeof(v_row -> 'gift_card' -> 'legs') = 'array' and v_gift > 0
                         and jsonb_array_length(v_row -> 'gift_card' -> 'legs') > 0
                    then v_row -> 'gift_card' -> 'legs'
                    when v_gift > 0 then jsonb_build_array(coalesce(v_row -> 'gift_card', '{}'::jsonb))
                    else '[]'::jsonb end) x loop
      v_list := v_list || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                  'method', 'gift_card',
                  'amount', round(least(v_gift, greatest(0, round(public._fence_num(g ->> 'applied'))::bigint)) / 100.0, 2),
                  'tip', 0,
                  'gift_card_id', nullif(g ->> 'card_id', ''))));
    end loop;
    -- One gift entry for the money proved when the check carried no usable record of it.
    if v_gift > 0 and (select coalesce(sum(round(public._fence_num(t ->> 'amount') * 100)::bigint), 0)
                         from jsonb_array_elements(v_list) t) = 0 then
      v_list := jsonb_build_array(jsonb_build_object('method', 'gift_card',
                                                     'amount', round(v_gift / 100.0, 2), 'tip', 0));
    end if;
    if v_loy > 0 then
      v_list := v_list || jsonb_build_array(jsonb_build_object('method', 'loyalty',
                                                               'amount', round(v_loy / 100.0, 2), 'tip', 0));
    end if;
    if v_promo > 0 then
      v_list := v_list || jsonb_build_array(jsonb_build_object('method', 'promo',
                                                               'amount', round(v_promo / 100.0, 2), 'tip', 0));
    end if;
    if p_total_minor > 0 then
      v_list := v_list || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                  'method', 'card',
                  'amount', round((p_total_minor - v_tip) / 100.0, 2),
                  'tip', round(v_tip / 100.0, 2),
                  'psp_ref', nullif(v_row ->> 'stripe_payment_intent_id', ''),
                  'processor', nullif(v_row ->> 'processor', ''))));
    end if;
    if jsonb_array_length(v_list) > 0 then
      v_row := jsonb_set(v_row, '{tenders}', v_list);
    end if;
  end if;
  -- THE ROW'S OWN METHOD IS THE SERVER'S TOO (fix round 7, 20 Sep). closed_checks.tenders is
  -- the release's own column (20260919n_OPS_closed_checks_tenders.sql). On a database that has
  -- not had it, jsonb_populate_record drops the key and every protection built into the list
  -- above disappears; `method` and `payment_method` do not, and
  -- supabase/functions/_shared/accountingDay.js legacyTenders reads exactly those two. A card
  -- sale sent as method 'cash' then booked 25.00 of card money as cash takings and the drawer
  -- was short at close. Both are now written from what the server PROVED: the card it is
  -- booking, else the gift card, loyalty or promo credit that paid it, with the split in the
  -- list form legacyTenders parses. The tenders column is still a prerequisite of step 3 (it
  -- carries the psp reference and the gift card id), but no money depends on it any more.
  if coalesce(p_server, '{}'::jsonb) <> '{}'::jsonb
     and (p_total_minor > 0 or v_gift > 0 or v_loy > 0 or v_promo > 0) then
    v_method := case when p_total_minor > 0 then 'card'
                     when v_gift > 0 then 'gift_card'
                     when v_loy > 0 then 'loyalty'
                     else 'promo' end;
    v_row := v_row || jsonb_build_object(
               'method', v_method,
               'payment_method', case
                 when (case when p_total_minor > 0 then 1 else 0 end + case when v_gift > 0 then 1 else 0 end
                       + case when v_loy > 0 then 1 else 0 end + case when v_promo > 0 then 1 else 0 end) < 2
                 then v_method
                 else concat_ws(',',
                        case when v_gift > 0 then 'gift_card:' || to_char(v_gift / 100.0, 'FM9999999990.00') end,
                        case when v_loy > 0 then 'loyalty:' || to_char(v_loy / 100.0, 'FM9999999990.00') end,
                        case when v_promo > 0 then 'promo:' || to_char(v_promo / 100.0, 'FM9999999990.00') end,
                        case when p_total_minor > 0 then 'card:' || to_char(p_total_minor / 100.0, 'FM9999999990.00') end)
               end);
  end if;
  if coalesce(p_extra_customer, '{}'::jsonb) <> '{}'::jsonb then
    v_row := jsonb_set(v_row, '{customer}', coalesce(v_row -> 'customer', '{}'::jsonb) || p_extra_customer);
  end if;
  insert into public.closed_checks
  select * from jsonb_populate_record(null::public.closed_checks, v_row);
  return v_id;
end;
$fn$;

do $order_helper_grants$
declare
  f text;
begin
  foreach f in array array['public._public_order_value(text, text, text, jsonb, text)',
                           'public._public_order_auto(text, text, jsonb)',
                           'public._public_order_check_bound(text, text)',
                           'public._public_order_proof_bound(text, text, text, text, text, jsonb, timestamp with time zone)',
                           'public._public_order_declared(jsonb, jsonb, text)',
                           'public._public_order_promo(text, text, bigint, text, boolean)',
                           'public._loyalty_label_key(text)',
                           'public._loyalty_free_item_minor(jsonb, jsonb, bigint)',
                           'public._public_order_loyalty(text, text, text, bigint, bigint, bigint, jsonb)',
                           'public._public_order_due(jsonb, bigint)',
                           'public._public_order_payment_refs(jsonb, text)',
                           'public._public_order_check_row(text, text, text, text, jsonb, jsonb, jsonb)',
                           'public._public_order_write_check(jsonb, bigint, jsonb, jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
end
$order_helper_grants$;

create or replace function public.place_public_order(
  p_location_id uuid,
  p_order       jsonb,
  p_check       jsonb default null,
  p_proof_ids   uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid         uuid := auth.uid();
  v_loc         text := p_location_id::text;
  v_source      text := lower(coalesce(p_order ->> 'source', ''));
  v_ref         text := btrim(coalesce(p_order ->> 'ref', ''));
  v_raw         jsonb := case when jsonb_typeof(p_order -> 'customer') = 'object' then p_order -> 'customer' else '{}'::jsonb end;
  v_customer    jsonb;
  v_items       jsonb := case when jsonb_typeof(p_order -> 'items') = 'array' then p_order -> 'items' else '[]'::jsonb end;
  v_total       numeric := round(public._fence_num(p_order ->> 'total'), 2);
  v_type        text := left(coalesce(nullif(p_order ->> 'type', ''), 'collection'), 40);
  -- Which menu the page priced this basket on (fix round 7): the storefront's own
  -- effectiveMenuId. A per menu 0.00 is a real price on THAT menu and nowhere else.
  v_menu_id     text := nullif(left(btrim(coalesce(p_order ->> 'menu_id', '')), 80), '');
  v_check       jsonb := case when jsonb_typeof(p_check) = 'object' then p_check end;
  v_check_id    text := null;
  v_ip          text := public._fence_client_ip();
  v_tab         boolean;
  v_pi          text;
  v_proof_ids   uuid[] := coalesce(p_proof_ids, '{}'::uuid[]);
  v_card_minor  bigint := 0;
  v_gift_minor  bigint := 0;
  v_card_refs   text[] := '{}'::text[];
  v_bound_ids   uuid[] := '{}'::uuid[];
  v_val         jsonb;
  v_auto        jsonb := jsonb_build_object('total_minor', 0, 'rules', '[]'::jsonb);
  v_decl        jsonb;
  v_promo       jsonb := null;
  v_goods_minor bigint := 0;
  v_auto_minor  bigint := 0;
  v_promo_minor bigint := 0;
  v_loy_decl    bigint := 0;
  v_loy_minor   bigint := 0;
  v_unknown     integer := 0;
  v_tol         bigint := 0;
  v_client_due  bigint := 0;
  v_pricing     jsonb := null;
  v_due_minor   bigint := 0;
  v_value_minor bigint := 0;
  v_running     bigint := 0;
  v_paid        boolean := false;
  v_unverified  boolean := false;
  v_state       text := null;
  v_status      text;
  v_token       text;
  v_join        text := null;
  v_tab_ref     text;
  v_written_id  text := null;
  v_sent_at     timestamptz;
  v_event_date  date;
  v_existing    public.public_order_tokens%rowtype;
  v_first       public.order_queue%rowtype;
  v_hold        public.payment_proofs%rowtype;
  v_code_given  text;
  v_bucket      text;
  v_cc          jsonb;
  v_pay_ref     text;
  v_processor   text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'no_session', 'message', 'Please reload the page and try again.');
  end if;
  if p_location_id is null
     or not exists (select 1 from public.locations l where l.id = p_location_id and coalesce(l.status, 'active') = 'active') then
    return jsonb_build_object('ok', false, 'reason', 'venue', 'message', 'This venue is not taking orders.');
  end if;
  if v_source not in ('online', 'qr', 'catering') then
    return jsonb_build_object('ok', false, 'reason', 'source');
  end if;
  if v_ref !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{1,39}$' then
    return jsonb_build_object('ok', false, 'reason', 'ref');
  end if;

  -- A retry by the same session gets the first answer back.
  select * into v_existing from public.public_order_tokens t where t.location_id = v_loc and t.ref = v_ref;
  if v_existing.ref is not null then
    if v_existing.placed_by = v_uid then
      return (select jsonb_build_object('ok', true, 'idempotent', true, 'ref', v_ref, 'paid', q.paid,
                                        'status', q.status,
                                        'payment_unverified', coalesce(q.customer ->> 'payment_state', '') in ('checking', 'short'),
                                        'payment_state', q.customer ->> 'payment_state',
                                        'track_token', v_existing.token,
                                        'tab_join_code', q.customer ->> 'tab_join_code')
                from public.order_queue q where q.location_id = v_loc and q.ref = v_ref);
    end if;
    return jsonb_build_object('ok', false, 'reason', 'ref_taken');
  end if;
  if exists (select 1 from public.order_queue q where q.location_id = v_loc and q.ref = v_ref) then
    return jsonb_build_object('ok', false, 'reason', 'ref_taken');
  end if;

  if jsonb_array_length(v_items) = 0 or jsonb_array_length(v_items) > 200 or pg_column_size(v_items) > 262144 then
    return jsonb_build_object('ok', false, 'reason', 'items');
  end if;
  if pg_column_size(v_raw) > 32768 then
    return jsonb_build_object('ok', false, 'reason', 'customer');
  end if;
  if v_total < 0 or v_total > 100000 then
    return jsonb_build_object('ok', false, 'reason', 'total');
  end if;
  if public._fence_is_locked('order:uid:' || v_uid::text) then
    return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many orders from this device. Please wait a few minutes.');
  end if;

  -- Server fields a phone must never set, on any order. Tab fields and the card payment
  -- id are put back below only where the server has checked them.
  v_customer := v_raw - 'paid' - 'payment_verified' - 'payment_unverified' - 'payment_state' - 'payment_ref'
                      - 'payment_processor' - 'payment_confirmed_by' - 'payment_confirmed_note'
                      - 'payment_verified_at' - 'order_pricing' - 'tab_join_code' - 'staff' - 'placed_via'
                      - 'tab_open' - 'tab_ref' - 'round_ref' - 'tab_opened_at' - 'pre_auth_amount'
                      - 'tab_running_total' - 'payment_intent_id';
  v_tab := v_source = 'qr' and public._fence_bool(v_raw ->> 'tab_open');
  v_pi := nullif(left(btrim(coalesce(v_raw ->> 'payment_intent_id', '')), 200), '');
  v_check_id := case when v_check is not null then nullif(left(btrim(coalesce(v_check ->> 'id', '')), 80), '') end;

  -- What the order is worth to the server: its lines from the menu, less the venue's own
  -- automatic discounts (catering has none).
  v_val := public._public_order_value(v_loc, v_source, v_type, v_items, v_menu_id);
  v_items := v_val -> 'items';
  v_goods_minor := (v_val ->> 'goods_minor')::bigint;
  v_unknown := (v_val ->> 'unknown_lines')::integer;
  if v_source in ('online', 'qr') then
    v_auto := public._public_order_auto(v_loc, v_source, v_val -> 'lines');
    v_auto_minor := least(v_goods_minor, (v_auto ->> 'total_minor')::bigint);
  end if;
  v_tol := least(50, jsonb_array_length(v_items) + 3);
  v_decl := public._public_order_declared(p_order, v_check, v_source);

  -- Money proofs named by the caller: this venue, not used before, fresh, and bound to this
  -- order (its processor order reference, its check's ledger key, or a card payment no other
  -- order names).
  perform 1 from public.payment_proofs p where p.id = any(v_proof_ids) for update;
  select coalesce(sum(p.amount_minor) filter (where p.kind = 'card'), 0),
         coalesce(sum(p.amount_minor) filter (where p.kind = 'gift'), 0),
         coalesce(array_agg(p.payment_ref) filter (where p.kind = 'card'), '{}'::text[]),
         coalesce(array_agg(p.id), '{}'::uuid[])
    into v_card_minor, v_gift_minor, v_card_refs, v_bound_ids
    from public.payment_proofs p
   where p.id = any(v_proof_ids)
     and p.location_id = v_loc
     and p.kind in ('card', 'gift')
     and p.used_by_ref is null
     and p.verified_at > now() - interval '24 hours'
     and public._public_order_proof_bound(v_loc, v_ref, v_check_id, p.kind, p.payment_ref, p.meta);

  if v_tab then
    -- A QR tab: the card hold must be proven by the server.
    if v_pi is null then
      return jsonb_build_object('ok', false, 'reason', 'tab_not_verified',
                                'message', 'We could not confirm the card hold for this tab. Please ask a member of staff.');
    end if;
    select * into v_hold
      from public.payment_proofs p
     where p.kind = 'preauth' and p.payment_ref = v_pi and p.location_id = v_loc
     order by p.verified_at desc
     limit 1
     for update;
    if v_hold.id is null then
      return jsonb_build_object('ok', false, 'reason', 'tab_not_verified',
                                'message', 'We could not confirm the card hold for this tab. Please ask a member of staff.');
    end if;
    -- A hold that was already captured is a closed tab: no new rounds on it.
    if exists (select 1 from public.payment_proofs p
                where p.kind = 'capture' and p.payment_ref = v_pi and p.location_id = v_loc) then
      return jsonb_build_object('ok', false, 'reason', 'tab_closed',
                                'message', 'This tab is already closed. Please start a new order.');
    end if;
    -- Every item of a round must be on the menu: a round is settled from its value later.
    if v_unknown > 0 then
      return jsonb_build_object('ok', false, 'reason', 'items',
                                'message', 'Something in this order is no longer on the menu. Please refresh the menu and try again.');
    end if;
    select * into v_first
      from public.order_queue q
     where q.location_id = v_loc and q.source = 'qr' and q.status <> 'collected'
       and public._fence_bool(q.customer ->> 'tab_open')
       and q.customer ->> 'payment_intent_id' = v_pi
     order by q.created_at
     limit 1;
    if v_first.ref is not null then
      -- A new round on an open tab: only the tab's opener, a phone that joined it with
      -- the table code, or a round that carries the code.
      select max(q.customer ->> 'tab_join_code') into v_join
        from public.order_queue q
       where q.location_id = v_loc and q.source = 'qr' and q.status <> 'collected'
         and public._fence_bool(q.customer ->> 'tab_open')
         and q.customer ->> 'payment_intent_id' = v_pi;
      if not public._qr_tab_is_member(v_loc, v_pi, v_uid) then
        v_bucket := 'join:' || v_loc || ':' || md5(v_pi);
        if public._fence_is_locked(v_bucket) then
          return jsonb_build_object('ok', false, 'reason', 'locked', 'message', 'Too many wrong codes. Ask a member of staff.');
        end if;
        v_code_given := nullif(public._fence_norm_code(coalesce(p_order ->> 'tab_join_code', v_raw ->> 'tab_join_code')), '');
        if v_code_given is null or coalesce(v_join, '') = '' or v_code_given <> public._fence_norm_code(v_join) then
          if v_code_given is not null then
            perform public._fence_count(v_bucket, 8, interval '1 hour', interval '1 hour');
          end if;
          return jsonb_build_object('ok', false, 'reason', 'tab_not_yours',
                                    'message', 'Ask the person who opened this tab for the table code.');
        end if;
      end if;
      v_tab_ref := coalesce(v_first.customer ->> 'tab_ref', v_first.ref);
      v_customer := v_customer || jsonb_build_object('tab_opened_at',
                      coalesce(v_first.customer ->> 'tab_opened_at', v_first.created_at::text));
    else
      -- Opening a tab. The hold must have been checked in the last 30 minutes (the
      -- phone asks for the proof just before it places the first round), must not have
      -- opened another tab already (a tab whose rounds were all collected), and must not
      -- belong to another order.
      if v_hold.used_by_ref is not null then
        return jsonb_build_object('ok', false, 'reason', 'tab_closed',
                                  'message', 'This tab is already closed. Please start a new order.');
      end if;
      if v_hold.verified_at < now() - interval '30 minutes'
         or (nullif(btrim(coalesce(v_hold.meta ->> 'order_ref', '')), '') is not null and v_hold.meta ->> 'order_ref' <> v_ref) then
        return jsonb_build_object('ok', false, 'reason', 'tab_not_verified',
                                  'message', 'We could not confirm the card hold for this tab. Please try again.');
      end if;
    end if;
    -- What this round is worth (never below the menu, less the automatic discounts), and
    -- the tab may never run past its card hold (fix round 2): the hold is all the money a
    -- tab is sure of.
    v_value_minor := greatest(round(v_total * 100)::bigint, v_goods_minor - v_auto_minor - v_tol);
    select coalesce(sum(greatest(round(q.total * 100)::bigint,
                                 coalesce((q.customer -> 'order_pricing' ->> 'value_minor')::bigint, 0))), 0)
      into v_running
      from public.order_queue q
     where q.location_id = v_loc and q.source = 'qr' and q.status <> 'collected'
       and public._fence_bool(q.customer ->> 'tab_open')
       and q.customer ->> 'payment_intent_id' = v_pi;
    if v_running + v_value_minor > v_hold.amount_minor then
      return jsonb_build_object('ok', false, 'reason', 'over_hold',
                                'hold_minor', v_hold.amount_minor, 'running_minor', v_running, 'round_minor', v_value_minor,
                                'message', 'This round would take the tab past its card hold. Close the tab and start a new one, or ask a member of staff.');
    end if;
    if v_first.ref is not null then
      if not public._qr_tab_is_member(v_loc, v_pi, v_uid) then
        insert into public.qr_tab_members (location_id, pi_hash, uid)
        values (v_loc, md5(v_pi), v_uid)
        on conflict do nothing;
      end if;
    else
      update public.payment_proofs set used_by_ref = v_loc || ':' || v_ref, used_at = now() where id = v_hold.id;
      v_join := public._fence_random_digits(6);
      v_tab_ref := v_ref;
      v_customer := v_customer || jsonb_build_object('tab_opened_at', now());
    end if;
    v_customer := v_customer || jsonb_build_object(
                    'tab_open', true, 'payment_intent_id', v_pi, 'tab_join_code', v_join,
                    'tab_ref', v_tab_ref, 'round_ref', v_ref,
                    'pre_auth_amount', round(v_hold.amount_minor / 100.0, 2),
                    'order_pricing', jsonb_build_object('goods_minor', v_goods_minor, 'auto_minor', v_auto_minor,
                                                        'value_minor', v_value_minor, 'hold_minor', v_hold.amount_minor));
    v_total := greatest(v_total, round(v_value_minor / 100.0, 2));
    v_paid := false;
    v_status := 'prep';
  else
    -- QR has no pay later: a QR order is either paid now or a round of a tab. Online
    -- always pays too; an online order that arrives without its check (the page could
    -- not build it) is treated as paid now with an empty check, so it is proven or
    -- checked like any other. Only catering has pay later.
    if v_check is null and v_source = 'qr' then
      return jsonb_build_object('ok', false, 'reason', 'payment', 'message', 'Please pay for your order to send it.');
    end if;
    if v_check is null and v_source = 'online' then
      v_check := '{}'::jsonb;
    end if;
    -- The card payment id stays only when it is this order's own proven payment.
    if v_pi is not null and v_pi = any(v_card_refs) then
      v_customer := v_customer || jsonb_build_object('payment_intent_id', v_pi);
    end if;
    -- The promo code the order names: checked here (nothing written yet), and used up
    -- below, once nothing can refuse the order any more (a pay later order only checks it;
    -- the page records the use after placing).
    if v_decl ->> 'promo_code' is not null and v_unknown = 0 then
      v_promo := public._public_order_promo(v_loc, v_decl ->> 'promo_code', v_goods_minor - v_auto_minor,
                                            v_check_id, false);
      if coalesce((v_promo ->> 'ok')::boolean, false) then
        v_promo_minor := least((v_decl ->> 'promo_minor')::bigint, (v_promo ->> 'amount_minor')::bigint);
      end if;
    end if;
    v_loy_decl := (v_decl ->> 'loyalty_minor')::bigint;
    if v_check is not null then
      -- A percent reward is worked out on the goods less the venue's AUTOMATIC deals, which is
      -- the figure the storefront takes its percent of (OnlineCheckout.jsx:891 and :291), and
      -- a free item reward is the cheapest line the server priced. The whole loyalty benefit
      -- is then capped at what is LEFT to pay for the goods, deals and promo code off
      -- (OnlineCheckout.jsx:338), so an order can never be given away twice over.
      v_loy_minor := public._public_order_loyalty(v_loc, v_ref, v_check_id, v_loy_decl,
                                                  greatest(0, v_goods_minor - v_auto_minor),
                                                  greatest(0, v_goods_minor - v_auto_minor - v_promo_minor),
                                                  v_val -> 'lines');
    end if;
    v_client_due := greatest(round(v_total * 100)::bigint,
                             case when v_check is not null
                                  then round(greatest(0, public._fence_num(v_check ->> 'total')) * 100)::bigint else 0 end);
    v_pricing := jsonb_build_object(
                   'goods_minor', v_goods_minor, 'auto_minor', v_auto_minor, 'auto_rules', v_auto -> 'rules',
                   'promo_code', v_decl ->> 'promo_code', 'promo_minor', v_promo_minor,
                   'promo_reason', case when v_promo is not null and not coalesce((v_promo ->> 'ok')::boolean, false)
                                        then v_promo ->> 'reason' end,
                   'loyalty_declared_minor', v_loy_decl, 'loyalty_minor', v_loy_minor,
                   'tolerance_minor', v_tol, 'client_due_minor', v_client_due,
                   'unknown_lines', v_unknown, 'max_unit_minor', (v_val ->> 'max_unit_minor')::bigint,
                   'menu_id', v_menu_id);
    v_due_minor := public._public_order_due(v_pricing, v_loy_minor);
    if v_check is not null then
      v_paid := v_unknown = 0
                and case when v_due_minor > 0 then (v_card_minor + v_gift_minor) >= v_due_minor
                         else (v_card_minor + v_gift_minor) > 0 or v_loy_minor > 0 or v_promo_minor > 0 end;
      v_unverified := not v_paid;
      -- Money may have been taken: never refused for the venue, but one network can
      -- only send so many orders it cannot prove.
      if v_unverified and v_ip is not null and public._fence_is_locked('order:unproven:ip:' || v_ip) then
        return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many orders from this network. Please ask a member of staff.');
      end if;
      -- Nothing refuses the order from here on: use the promo code up now. A code another
      -- order used up a moment ago is no discount after all. The loyalty discount worked out
      -- above keeps the smaller ceiling it was given (it was valued net of a promo code that
      -- turned out not to apply). That can only make the order MORE short, never less, which
      -- is the right way round: staff confirm it on the till.
      if v_promo_minor > 0 then
        v_promo := public._public_order_promo(v_loc, v_decl ->> 'promo_code', v_goods_minor - v_auto_minor,
                                              v_check_id, true);
        if not coalesce((v_promo ->> 'ok')::boolean, false) then
          v_promo_minor := 0;
          v_pricing := v_pricing || jsonb_build_object('promo_minor', 0, 'promo_reason', v_promo ->> 'reason');
          v_due_minor := public._public_order_due(v_pricing, v_loy_minor);
          v_paid := v_unknown = 0
                    and case when v_due_minor > 0 then (v_card_minor + v_gift_minor) >= v_due_minor
                             else (v_card_minor + v_gift_minor) > 0 or v_loy_minor > 0 end;
          v_unverified := not v_paid;
        end if;
      end if;
      if v_unverified then
        v_state := case when v_unknown > 0 or (v_card_minor + v_gift_minor) > 0 then 'short' else 'checking' end;
      end if;
      v_status := case when v_paid and v_source <> 'catering' then 'prep' else 'received' end;
    else
      -- Catering pay later: no money taken, so the venue collects it later, at no less
      -- than the amount due.
      v_paid := false;
      v_status := 'received';
      if (v_ip is not null and public._fence_is_locked('order:later:ip:' || v_ip))
         or public._fence_is_locked('order:later:loc:' || v_loc) then
        return jsonb_build_object('ok', false, 'reason', 'rate', 'message', 'Too many orders right now. Please try again in a few minutes.');
      end if;
    end if;
    v_customer := v_customer || jsonb_build_object('order_pricing',
                    v_pricing || jsonb_build_object('due_minor', v_due_minor, 'proven_minor', v_card_minor + v_gift_minor));
    v_total := greatest(v_total, round(v_due_minor / 100.0, 2));
  end if;

  if v_check is not null then
    v_cc := public._public_order_check_row(v_loc, v_ref, v_source, v_type, v_check, v_items, v_customer);
    v_pay_ref := coalesce(nullif(v_check ->> 'stripe_payment_intent_id', ''),
                          case when jsonb_typeof(v_check -> 'payment_intents') = 'array'
                               then nullif(v_check -> 'payment_intents' -> 0 ->> 'id', '') end,
                          v_pi);
    v_processor := case when coalesce(v_check ->> 'processor', v_raw ->> 'processor') in ('stripe', 'ryft', 'adyen')
                        then coalesce(v_check ->> 'processor', v_raw ->> 'processor') end;
  end if;
  if v_unverified then
    v_customer := v_customer || jsonb_strip_nulls(jsonb_build_object(
                    'payment_unverified', true, 'payment_state', v_state,
                    'payment_ref', left(v_pay_ref, 200), 'payment_processor', v_processor));
  end if;

  begin
    v_sent_at := nullif(p_order ->> 'sent_at', '')::timestamptz;
  exception when others then
    v_sent_at := null;
  end;
  if v_sent_at is null or v_sent_at < now() - interval '1 hour' or v_sent_at > now() + interval '400 days' then
    v_sent_at := now();
  end if;
  begin
    v_event_date := nullif(p_order ->> 'event_date', '')::date;
  exception when others then
    v_event_date := null;
  end;
  if v_event_date is not null and (v_event_date < current_date - 1 or v_event_date > current_date + 400) then
    v_event_date := null;
  end if;

  perform set_config('servos.public_order', 'on', true);
  insert into public.order_queue
    (ref, location_id, type, customer, items, total, status, staff, sent_at, collection_time, is_asap,
     source, paid, payment_method, event_date)
  values
    (v_ref, v_loc, v_type, v_customer, v_items, v_total, v_status, null, v_sent_at,
     left(nullif(p_order ->> 'collection_time', ''), 40), public._fence_bool(p_order ->> 'is_asap'),
     v_source, v_paid, case when v_paid then left(coalesce(nullif(p_order ->> 'payment_method', ''), 'card'), 40) else null end,
     v_event_date);
  perform set_config('servos.public_order', 'off', true);

  if v_paid and v_check is not null then
    v_written_id := public._public_order_write_check(
                      v_cc, least(v_card_minor, v_due_minor), '{}'::jsonb,
                      jsonb_build_object('goods_minor', v_goods_minor,
                                         'owed_minor', greatest(0, v_goods_minor - v_auto_minor
                                                                   - v_promo_minor - v_loy_minor),
                                         'proven_minor', v_card_minor + v_gift_minor,
                                         'gift_minor', v_gift_minor, 'loyalty_minor', v_loy_minor,
                                         'promo_minor', v_promo_minor));
    update public.payment_proofs
       set used_by_ref = v_loc || ':' || v_ref, used_at = now()
     where location_id = v_loc and used_by_ref is null
       and (id = any(v_bound_ids)
            or (kind = 'loyalty' and id = any(v_proof_ids)
                and public._public_order_proof_bound(v_loc, v_ref, v_check_id, kind, payment_ref, meta)));
  elsif v_check is not null then
    insert into public.public_order_pending_checks
      (location_id, ref, check_row, due_minor, client_total, payment_refs, placed_by, pricing, unknown_lines)
    values
      (v_loc, v_ref, v_cc, v_due_minor, round(public._fence_num(v_check ->> 'total'), 2),
       public._public_order_payment_refs(v_check, v_pi), v_uid, v_pricing, v_unknown)
    on conflict (location_id, ref) do nothing;
  end if;

  v_token := replace(gen_random_uuid()::text, '-', '');
  insert into public.public_order_tokens (location_id, ref, token, placed_by, paid)
  values (v_loc, v_ref, v_token, v_uid, v_paid);

  perform public._fence_count('order:uid:' || v_uid::text, 30, interval '10 minutes', interval '10 minutes');
  if v_unverified and v_ip is not null then
    perform public._fence_count('order:unproven:ip:' || v_ip, 60, interval '10 minutes', interval '10 minutes');
  end if;
  if not v_tab and v_check is null then
    if v_ip is not null then
      perform public._fence_count('order:later:ip:' || v_ip, 20, interval '10 minutes', interval '10 minutes');
    end if;
    perform public._fence_count('order:later:loc:' || v_loc, 200, interval '10 minutes', interval '10 minutes');
  end if;

  return jsonb_build_object('ok', true, 'ref', v_ref, 'paid', v_paid, 'status', v_status,
                            'payment_unverified', v_unverified, 'payment_state', v_state, 'track_token', v_token,
                            'tab_join_code', v_join, 'check_id', v_written_id,
                            'due_minor', case when v_tab then null else v_due_minor end,
                            'proven_minor', case when v_tab then null else v_card_minor + v_gift_minor end);
end;
$fn$;

-- 7e. A public order whose payment was being checked, or found short.
-- verify_public_order_payment is called by the page that placed it (retrying while the
-- processor catches up) or by a till or Back Office of the venue ("Check payment" after
-- payment-proof wrote the proof). It counts the proofs named plus any proof of the payments
-- the order's check names, but only proofs bound to THIS order (fix round 2: a gift or
-- loyalty proof with no processor order reference is not this order's just because its
-- check names it; its key must carry this order's check). A loyalty redemption that landed
-- after the order was placed is counted now. When the money covers the amount due it
-- writes the paid check (the verified card amount), marks the order paid and the state
-- 'verified'. Short of that it records the amounts on the order (payment_state 'short'
-- once some money is proven) for staff. An order with an item that is not on the menu is
-- never paid here: a manager confirms it.
create or replace function public.verify_public_order_payment(p_location_id uuid, p_ref text, p_proof_ids uuid[] default '{}'::uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid      uuid := auth.uid();
  v_loc      text := p_location_id::text;
  v_q        public.order_queue%rowtype;
  v_pend     public.public_order_pending_checks%rowtype;
  v_check_id text;
  v_ids      uuid[];
  v_card     bigint := 0;
  v_gift     bigint := 0;
  v_loy      bigint := 0;
  v_due      bigint;
  v_paid     boolean;
  v_check_id_written text;
  v_pi       text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'no_session');
  end if;
  select * into v_q from public.order_queue q where q.location_id = v_loc and q.ref = p_ref for update;
  if v_q.ref is null
     or not (exists (select 1 from public.public_order_tokens t
                      where t.location_id = v_loc and t.ref = p_ref and t.placed_by = v_uid)
             or public.pos_can_access(v_loc) or public.is_super_admin()) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_q.paid then
    return jsonb_build_object('ok', true, 'paid', true, 'already', true);
  end if;
  select * into v_pend from public.public_order_pending_checks c
   where c.location_id = v_loc and c.ref = p_ref for update;
  if v_pend.ref is null then
    return jsonb_build_object('ok', false, 'reason', 'no_check',
                              'message', 'This order was not paid online. Take the payment on the till.');
  end if;
  v_check_id := v_pend.check_row ->> 'id';
  select coalesce(array_agg(p.id), '{}'::uuid[]) into v_ids
    from public.payment_proofs p
   where p.location_id = v_loc
     and p.kind in ('card', 'gift')
     and p.used_by_ref is null
     and p.verified_at > now() - interval '7 days'
     and (p.id = any(coalesce(p_proof_ids, '{}'::uuid[])) or p.payment_ref = any(v_pend.payment_refs))
     and public._public_order_proof_bound(v_loc, p_ref, v_check_id, p.kind, p.payment_ref, p.meta, v_q.created_at);
  perform 1 from public.payment_proofs p where p.id = any(v_ids) for update;
  select coalesce(sum(p.amount_minor) filter (where p.kind = 'card'), 0),
         coalesce(sum(p.amount_minor) filter (where p.kind = 'gift'), 0),
         max(p.payment_ref) filter (where p.kind = 'card')
    into v_card, v_gift, v_pi
    from public.payment_proofs p
   where p.id = any(v_ids);
  if v_pend.pricing is not null then
    -- A redemption that landed after the order is valued now, against the SAME lines the
    -- order was priced from (the kept check carries the server's own priced items, so
    -- re-valuing them gives back the lines a free item reward is matched against), and on the
    -- same two figures place_public_order used: a percent reward on the goods less the
    -- venue's automatic deals (OnlineCheckout.jsx:891 and :291), the whole benefit capped at
    -- what is left to pay once the promo code is off too (:338).
    v_loy := greatest(coalesce((v_pend.pricing ->> 'loyalty_minor')::bigint, 0),
                      public._public_order_loyalty(v_loc, p_ref, v_check_id,
                                                   coalesce((v_pend.pricing ->> 'loyalty_declared_minor')::bigint, 0),
                                                   greatest(0, coalesce((v_pend.pricing ->> 'goods_minor')::bigint, 0)
                                                               - coalesce((v_pend.pricing ->> 'auto_minor')::bigint, 0)),
                                                   greatest(0, coalesce((v_pend.pricing ->> 'goods_minor')::bigint, 0)
                                                               - coalesce((v_pend.pricing ->> 'auto_minor')::bigint, 0)
                                                               - coalesce((v_pend.pricing ->> 'promo_minor')::bigint, 0)),
                                                   public._public_order_value(v_loc, coalesce(v_q.source, 'online'),
                                                                              coalesce(v_q.type, 'collection'),
                                                                              v_pend.check_row -> 'items',
                                                                              v_pend.pricing ->> 'menu_id') -> 'lines'));
    v_due := public._public_order_due(v_pend.pricing, v_loy);
  else
    v_due := v_pend.due_minor;
  end if;
  v_paid := coalesce(v_pend.unknown_lines, 0) = 0
            and case when v_due > 0 then (v_card + v_gift) >= v_due
                     else (v_card + v_gift) > 0 or v_loy > 0
                          or coalesce((v_pend.pricing ->> 'promo_minor')::bigint, 0) > 0 end;
  if not v_paid then
    update public.order_queue
       set customer = customer
                      || jsonb_build_object('payment_state',
                                            case when coalesce(v_pend.unknown_lines, 0) > 0 or (v_card + v_gift) > 0
                                                 then 'short' else 'checking' end)
                      || jsonb_build_object('order_pricing',
                                            coalesce(customer -> 'order_pricing', '{}'::jsonb)
                                            || jsonb_build_object('due_minor', v_due, 'proven_minor', v_card + v_gift,
                                                                  'loyalty_minor', v_loy))
     where location_id = v_loc and ref = p_ref;
    return jsonb_build_object('ok', true, 'paid', false, 'due_minor', v_due,
                              'proven_minor', v_card + v_gift,
                              'unknown_lines', coalesce(v_pend.unknown_lines, 0),
                              'message', case when coalesce(v_pend.unknown_lines, 0) > 0
                                              then 'Something on this order is not on the menu. A manager must check it and confirm the payment.'
                                              else 'The payment is not confirmed yet.' end);
  end if;
  v_check_id_written := public._public_order_write_check(
                          v_pend.check_row, least(v_card, v_due),
                          jsonb_build_object('payment_verified_at', now()),
                          jsonb_build_object(
                            'goods_minor', coalesce((v_pend.pricing ->> 'goods_minor')::bigint, 0),
                            'owed_minor', greatest(0, coalesce((v_pend.pricing ->> 'goods_minor')::bigint, 0)
                                                      - coalesce((v_pend.pricing ->> 'auto_minor')::bigint, 0)
                                                      - coalesce((v_pend.pricing ->> 'promo_minor')::bigint, 0)
                                                      - v_loy),
                            'proven_minor', v_card + v_gift,
                            'gift_minor', v_gift, 'loyalty_minor', v_loy,
                            'promo_minor', coalesce((v_pend.pricing ->> 'promo_minor')::bigint, 0)));
  update public.payment_proofs set used_by_ref = v_loc || ':' || p_ref, used_at = now() where id = any(v_ids);
  update public.order_queue
     set paid = true,
         payment_method = coalesce(payment_method, left(coalesce(nullif(v_pend.check_row ->> 'method', ''), 'card'), 40)),
         customer = (customer - 'payment_unverified')
                    || jsonb_build_object('payment_state', 'verified', 'payment_verified_at', now())
                    || jsonb_build_object('order_pricing',
                                          coalesce(customer -> 'order_pricing', '{}'::jsonb)
                                          || jsonb_build_object('due_minor', v_due, 'proven_minor', v_card + v_gift,
                                                                'loyalty_minor', v_loy))
                    || case when source = 'qr' and v_pi is not null and v_pi = customer ->> 'payment_ref'
                            then jsonb_build_object('payment_intent_id', v_pi) else '{}'::jsonb end
   where location_id = v_loc and ref = p_ref;
  update public.public_order_tokens set paid = true where location_id = v_loc and ref = p_ref;
  delete from public.public_order_pending_checks where location_id = v_loc and ref = p_ref;
  return jsonb_build_object('ok', true, 'paid', true, 'check_id', v_check_id_written);
end;
$fn$;

-- Staff of the venue saw the money (for example in the card processor's dashboard), or took
-- the rest of a short order on the till, but no proof covers it. Writes the kept check as
-- paid, and records who confirmed it and why. By default the check books the card amount the
-- order still needed; when staff took the rest on the till (which books its own check), the
-- app passes p_amount_minor, the card amount this online check really took (for example the
-- proven part), so nothing is counted twice. Tills and Back Office of the venue only, never
-- the customer. This is also how an order with an item that is not on the menu is settled:
-- a manager decides.
create or replace function public.confirm_public_order_payment(p_location_id uuid, p_ref text, p_note text default null,
                                                               p_amount_minor bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid      uuid := auth.uid();
  v_loc      text := p_location_id::text;
  v_q        public.order_queue%rowtype;
  v_pend     public.public_order_pending_checks%rowtype;
  v_gift     bigint := 0;
  v_book     bigint := 0;
  v_check_id text;
begin
  if v_uid is null or not (public.pos_can_access(v_loc) or public.is_super_admin()) then
    raise exception 'Only staff of this venue can confirm a payment' using errcode = '42501';
  end if;
  select * into v_q from public.order_queue q where q.location_id = v_loc and q.ref = p_ref for update;
  if v_q.ref is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;
  if v_q.paid then
    return jsonb_build_object('ok', true, 'paid', true, 'already', true);
  end if;
  select * into v_pend from public.public_order_pending_checks c
   where c.location_id = v_loc and c.ref = p_ref for update;
  if v_pend.ref is null then
    return jsonb_build_object('ok', false, 'reason', 'no_check',
                              'message', 'This order was not paid online. Take the payment on the till.');
  end if;
  select coalesce(sum(p.amount_minor), 0) into v_gift
    from public.payment_proofs p
   where p.location_id = v_loc and p.kind = 'gift' and p.used_by_ref is null
     and p.payment_ref = any(v_pend.payment_refs)
     and public._public_order_proof_bound(v_loc, p_ref, v_pend.check_row ->> 'id', p.kind, p.payment_ref, p.meta, v_q.created_at);
  v_book := greatest(0, v_pend.due_minor - v_gift);
  if p_amount_minor is not null then
    v_book := least(greatest(0, p_amount_minor), v_book);
  end if;
  v_check_id := public._public_order_write_check(
                  v_pend.check_row, v_book,
                  jsonb_strip_nulls(jsonb_build_object('payment_confirmed_by', v_uid, 'payment_confirmed_at', now(),
                                                       'payment_confirmed_note', left(p_note, 200),
                                                       'payment_confirmed_amount_minor', v_book)),
                  -- Staff confirmed it, so the money is what they say; the subtotal, service
                  -- charge, tip and tenders are still the server's own (fix round 6).
                  jsonb_build_object(
                    'goods_minor', coalesce((v_pend.pricing ->> 'goods_minor')::bigint, 0),
                    'owed_minor', greatest(0, coalesce((v_pend.pricing ->> 'goods_minor')::bigint, 0)
                                              - coalesce((v_pend.pricing ->> 'auto_minor')::bigint, 0)
                                              - coalesce((v_pend.pricing ->> 'promo_minor')::bigint, 0)
                                              - coalesce((v_pend.pricing ->> 'loyalty_minor')::bigint, 0)),
                    'proven_minor', v_book + v_gift,
                    'gift_minor', v_gift,
                    'loyalty_minor', coalesce((v_pend.pricing ->> 'loyalty_minor')::bigint, 0),
                    'promo_minor', coalesce((v_pend.pricing ->> 'promo_minor')::bigint, 0)));
  update public.order_queue
     set paid = true,
         payment_method = coalesce(payment_method, left(coalesce(nullif(v_pend.check_row ->> 'method', ''), 'card'), 40)),
         customer = (customer - 'payment_unverified')
                    || jsonb_strip_nulls(jsonb_build_object('payment_state', 'confirmed_by_staff',
                                                            'payment_confirmed_by', v_uid,
                                                            'payment_confirmed_note', left(p_note, 200),
                                                            'payment_confirmed_amount_minor', v_book))
   where location_id = v_loc and ref = p_ref;
  update public.public_order_tokens set paid = true where location_id = v_loc and ref = p_ref;
  delete from public.public_order_pending_checks where location_id = v_loc and ref = p_ref;
  insert into public.device_claim_log (location_id, event, new_uid, detail)
  values (p_location_id, 'payment_confirmed_by_staff', v_uid, left('order ' || p_ref || coalesce(': ' || p_note, ''), 300));
  return jsonb_build_object('ok', true, 'paid', true, 'check_id', v_check_id);
end;
$fn$;

-- 7f. Closing a QR tab from the customer's phone after the card was captured (gap G17:
-- only after a capture the server has seen). Fix round 2 (19 Sep: any unused 1p card proof
-- at the venue used to close any tab, whoever asked):
--   * only the tab's opener, a phone that joined it with the table code, or staff of the
--     venue may close it;
--   * only money that belongs to THIS tab counts: the capture of its own card hold, and
--     card payments whose processor record names the tab (its ref or a round's ref) or its
--     card hold (an overage charge);
--   * that money must cover the tab's balance as the server values it (each round's
--     recorded value, never below its total; a round written without one is valued from
--     the menu now).
-- Covered: the rounds are marked collected and ONE closed check books what was taken.
-- Not covered: nothing closes, nothing is used up, and the rounds are marked
-- payment_state 'short' with the amounts, for staff to take the rest on the till.
create or replace function public.settle_qr_tab(
  p_location_id       uuid,
  p_payment_intent_id text,
  p_check             jsonb default '{}'::jsonb,
  p_proof_ids         uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_uid        uuid := auth.uid();
  v_loc        text := p_location_id::text;
  v_refs       text[];
  v_first      public.order_queue%rowtype;
  v_tab_ref    text;
  v_ids        uuid[];
  v_taken      bigint := 0;
  v_balance    bigint := 0;
  v_check_id   text;
  v_cc         jsonb;
  v_items      jsonb;
  v_goods      bigint := 0;
  v_tip        numeric;
  v_booked     numeric;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'no_session');
  end if;
  if coalesce(p_payment_intent_id, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'missing');
  end if;
  -- Lock the tab's rounds first, so two phones closing the same tab one after the other
  -- get "already closed", never a second check.
  perform 1 from public.order_queue q
   where q.location_id = v_loc and q.source = 'qr'
     and public._fence_bool(q.customer ->> 'tab_open')
     and q.customer ->> 'payment_intent_id' = p_payment_intent_id
   for update;
  select array_agg(q.ref order by q.created_at) into v_refs
    from public.order_queue q
   where q.location_id = v_loc and q.source = 'qr' and q.status <> 'collected'
     and public._fence_bool(q.customer ->> 'tab_open')
     and q.customer ->> 'payment_intent_id' = p_payment_intent_id;
  if v_refs is null then
    return jsonb_build_object('ok', true, 'closed', 0, 'reason', 'already_closed');
  end if;
  if not (public._qr_tab_is_member(v_loc, p_payment_intent_id, v_uid)
          or public.pos_can_access(v_loc) or public.is_super_admin()) then
    return jsonb_build_object('ok', false, 'reason', 'not_yours',
                              'message', 'Only the person who opened this tab, someone who joined it, or staff can close it.');
  end if;
  select * into v_first from public.order_queue q
   where q.location_id = v_loc and q.ref = v_refs[1];
  v_tab_ref := coalesce(v_first.customer ->> 'tab_ref', v_first.ref);

  -- This tab's own money.
  select coalesce(array_agg(p.id), '{}'::uuid[]) into v_ids
    from public.payment_proofs p
   where p.location_id = v_loc
     and p.used_by_ref is null
     and ((p.kind = 'capture' and p.payment_ref = p_payment_intent_id)
          or (p.kind = 'card' and p.id = any(coalesce(p_proof_ids, '{}'::uuid[]))
              and (p.meta ->> 'order_ref' = v_tab_ref
                   or p.meta ->> 'order_ref' = any(v_refs)
                   or p.meta ->> 'parent_ref' = p_payment_intent_id)));
  perform 1 from public.payment_proofs p where p.id = any(v_ids) for update;
  select coalesce(sum(p.amount_minor), 0) into v_taken from public.payment_proofs p where p.id = any(v_ids);
  if v_taken <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'not_captured',
                              'message', 'We could not confirm the payment yet. Please try again, or ask a member of staff.');
  end if;

  -- The tab's balance as the server values it.
  select coalesce(sum(greatest(round(q.total * 100)::bigint,
                               coalesce((q.customer -> 'order_pricing' ->> 'value_minor')::bigint,
                                        (public._public_order_value(v_loc, 'qr', q.type, q.items,
                                                                    q.customer -> 'order_pricing' ->> 'menu_id') ->> 'goods_minor')::bigint))), 0)
    into v_balance
    from public.order_queue q
   where q.location_id = v_loc and q.ref = any(v_refs);
  if v_taken < v_balance then
    update public.order_queue
       set customer = customer
                      || jsonb_build_object('payment_state', 'short', 'payment_unverified', true,
                                            'tab_close_short', jsonb_build_object('paid_minor', v_taken, 'due_minor', v_balance,
                                                                                  'at', now()))
     where location_id = v_loc and ref = any(v_refs);
    return jsonb_build_object('ok', false, 'reason', 'short', 'paid_minor', v_taken, 'due_minor', v_balance,
                              'message', 'Your card paid part of this tab. A member of staff will settle the rest with you.');
  end if;

  select coalesce(jsonb_agg(e.item), '[]'::jsonb) into v_items
    from public.order_queue q
    cross join lateral jsonb_array_elements(case when jsonb_typeof(q.items) = 'array' then q.items else '[]'::jsonb end) as e(item)
   where q.location_id = v_loc and q.ref = any(v_refs);
  -- THE TIP IS CAPPED AT WHAT WAS TAKEN OVER THE GOODS (fix round 5, 19 Sep). The tip was the
  -- one money field on a QR check still decided by the phone: a tab of one 95 pound Feast
  -- placed with customer.tip = 95 and a genuine 9500 capture booked subtotal 0.00 and tip
  -- 95.00, so the venue booked no sale at all and then paid 95 pounds of its OWN takings out
  -- through tronc and the P&L. A tip can only be money taken ABOVE the server's own value of
  -- the rounds: goods less the venue's automatic deals (a round's order_pricing, or the
  -- server's own valuation for a round an old page placed). A page that declares more than
  -- that has the rest booked as the sale it is.
  select coalesce(sum(greatest(0, coalesce((q.customer -> 'order_pricing' ->> 'goods_minor')::bigint,
                                           (public._public_order_value(v_loc, 'qr', q.type, q.items,
                                                                       q.customer -> 'order_pricing' ->> 'menu_id') ->> 'goods_minor')::bigint, 0)
                                  - coalesce((q.customer -> 'order_pricing' ->> 'auto_minor')::bigint, 0))), 0)
    into v_goods
    from public.order_queue q
   where q.location_id = v_loc and q.ref = any(v_refs);
  select coalesce(sum(public._fence_num(q.customer ->> 'tip')), 0) into v_tip
    from public.order_queue q
   where q.location_id = v_loc and q.ref = any(v_refs);
  v_tip := least(greatest(0, v_tip), greatest(0, round((v_taken - v_goods)::numeric / 100, 2)));
  v_booked := round(v_taken::numeric / 100, 2);

  update public.order_queue
     set status = 'collected',
         customer = customer - 'payment_unverified' - 'payment_state' - 'tab_close_short'
   where location_id = v_loc and ref = any(v_refs);

  v_check_id := 'chk-qr-' || left(md5(v_loc || ':' || p_payment_intent_id), 16);
  if not exists (select 1 from public.closed_checks c where c.id = v_check_id) then
    v_cc := jsonb_build_object(
      'id', v_check_id,
      'ref', v_tab_ref,
      'location_id', v_loc,
      'table_id', null,
      'table_label', left(coalesce(p_check ->> 'table_label', 'Table ' || coalesce(v_first.customer ->> 'tableLabel', '')), 80),
      'items', v_items,
      'subtotal', greatest(0, v_booked - v_tip),
      'tax', 0,
      'total', v_booked,
      'covers', 1,
      'closed_at', now(),
      'voided', false,
      'refunded', false,
      'server', 'QR',
      'order_type', 'dine-in',
      'customer', (v_first.customer - 'tab_join_code' - 'payment_unverified' - 'payment_state' - 'tab_close_short')
                  || jsonb_build_object('tab_closed_at', now(), 'tab_balance_minor', v_balance, 'shortfall', 0),
      'discounts', '[]'::jsonb,
      'service', 0,
      'tip', least(v_tip, v_booked),
      'method', 'card',
      'status', 'paid',
      'refunds', '[]'::jsonb,
      'tax_breakdown', '[]'::jsonb,
      'source', 'qr',
      'stripe_payment_intent_id', case when coalesce(v_first.customer ->> 'processor', 'stripe') = 'stripe' then p_payment_intent_id end,
      'payment_intents', jsonb_build_array(jsonb_build_object('id', p_payment_intent_id, 'amountMinor', v_taken)),
      -- The server's own tender list (fix round 7, 20 Sep): one card entry for the capture,
      -- with the tip the server allowed on it. The other three public checks have carried one
      -- since round 6; this was the one paid public check still relying on the legacy method
      -- fallback, and the one that would silently diverge if that fallback ever changed.
      'tenders', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                   'method', 'card',
                   'amount', greatest(0, v_booked - least(v_tip, v_booked)),
                   'tip', least(v_tip, v_booked),
                   'psp_ref', p_payment_intent_id,
                   'processor', case when v_first.customer ->> 'processor' in ('stripe', 'ryft', 'adyen')
                                     then v_first.customer ->> 'processor' else 'stripe' end))),
      'processor', case when v_first.customer ->> 'processor' in ('stripe', 'ryft', 'adyen') then v_first.customer ->> 'processor' else 'stripe' end);
    insert into public.closed_checks
    select * from jsonb_populate_record(null::public.closed_checks, v_cc);
  end if;

  update public.payment_proofs
     set used_by_ref = v_loc || ':' || v_tab_ref, used_at = now()
   where id = any(v_ids);

  return jsonb_build_object('ok', true, 'closed', array_length(v_refs, 1), 'check_id', v_check_id,
                            'booked', v_booked, 'shortfall', 0, 'balance_minor', v_balance);
end;
$fn$;

-- 7g. QR tabs on the floor plan, worked out on the server from the open QR rounds
-- (gap G17: no public function writes active_sessions). Only ever writes or deletes a
-- session whose source is 'qr', so a till's own session on that table is never
-- touched (tables must never be lost). Only rounds of an open tab and paid pay now
-- orders count: an order whose payment is still being checked never puts a guest on
-- the floor plan. If a till is writing that table's row it waits up to 2 seconds for
-- it (a till's write takes milliseconds), so a closed tab does not stay on the floor
-- as a ghost. File 2 attaches it as a trigger on order_queue, when the phone's own sync
-- (src/lib/qrTableSession.js) is gone.
create or replace function public._qr_sync_table_session(p_location_id uuid, p_table_id text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_floor    text;
  v_items    jsonb;
  v_rounds   integer;
  v_opened   timestamptz;
  v_subtotal numeric := 0;
  v_existing public.active_sessions%rowtype;
  v_session  jsonb;
  v_timeout  text;
begin
  if p_location_id is null or coalesce(btrim(p_table_id), '') = '' then
    return;
  end if;
  select f.id into v_floor
    from public.floor_tables f
   where f.location_id = p_location_id::text
     and (f.id = p_table_id or lower(btrim(coalesce(f.label, ''))) = lower(btrim(p_table_id)))
   order by (f.id = p_table_id) desc
   limit 1;
  v_floor := coalesce(v_floor, p_table_id);

  select coalesce(jsonb_agg(x.item || jsonb_build_object('tab_pi', x.tab_pi)), '[]'::jsonb),
         count(distinct x.ref)::int,
         min(x.sent_at)
    into v_items, v_rounds, v_opened
    from (
      select q.ref, q.sent_at, q.customer ->> 'payment_intent_id' as tab_pi, e.item
        from public.order_queue q
        cross join lateral jsonb_array_elements(case when jsonb_typeof(q.items) = 'array' then q.items else '[]'::jsonb end) as e(item)
       where q.location_id = p_location_id::text
         and q.source = 'qr'
         and q.status <> 'collected'
         and q.customer ->> 'tableId' = p_table_id
         and (q.paid or public._fence_bool(q.customer ->> 'tab_open'))
    ) x;

  v_timeout := current_setting('lock_timeout');
  perform set_config('lock_timeout', '2s', true);
  begin
    select * into v_existing
      from public.active_sessions a
     where a.location_id = p_location_id and a.table_id = v_floor
     for update;
  exception when lock_not_available then
    perform set_config('lock_timeout', v_timeout, true);
    raise notice 'QR floor sync skipped table % at %: a till held it for 2 seconds', v_floor, p_location_id;
    return;
  end;
  perform set_config('lock_timeout', v_timeout, true);

  if jsonb_array_length(v_items) = 0 then
    if v_existing.id is not null and coalesce(v_existing.session ->> 'source', '') = 'qr' then
      delete from public.active_sessions where id = v_existing.id;
    end if;
    return;
  end if;
  if v_existing.id is not null and coalesce(v_existing.session ->> 'source', '') <> 'qr' then
    return;   -- a till's own session on this table: never overwritten
  end if;

  select coalesce(sum(
           (public._fence_num(it ->> 'price')
            + coalesce((select sum(public._fence_num(m ->> 'price'))
                          from jsonb_array_elements(case when jsonb_typeof(it -> 'mods') = 'array' then it -> 'mods' else '[]'::jsonb end) m), 0))
           * (case when public._fence_num(it ->> 'qty') > 0 then least(public._fence_num(it ->> 'qty'), 999) else 1 end)), 0)
    into v_subtotal
    from jsonb_array_elements(v_items) it;

  v_session := jsonb_build_object(
    'items', v_items, 'server', 'QR', 'source', 'qr', 'covers', 1,
    'openedAt', (extract(epoch from coalesce(v_opened, now())) * 1000)::bigint,
    'sentAt', (extract(epoch from now()) * 1000)::bigint,
    'subtotal', v_subtotal, 'total', v_subtotal, 'qr_tab_count', v_rounds);

  if v_existing.id is not null then
    update public.active_sessions set session = v_session, updated_at = now() where id = v_existing.id;
  else
    insert into public.active_sessions (location_id, table_id, session, updated_at)
    values (p_location_id, v_floor, v_session, now())
    on conflict (location_id, table_id) do nothing;
  end if;
end;
$fn$;
revoke all on function public._qr_sync_table_session(uuid, text) from public, anon, authenticated;

create or replace function public.order_queue_qr_floor_tg()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_row public.order_queue%rowtype;
begin
  if tg_op = 'DELETE' then v_row := old; else v_row := new; end if;
  if v_row.source is distinct from 'qr' or coalesce(v_row.customer ->> 'tableId', '') = ''
     or not public._fence_is_uuid(v_row.location_id) then
    return null;
  end if;
  if tg_op = 'UPDATE' and new.status is not distinct from old.status and new.items is not distinct from old.items
     and new.paid is not distinct from old.paid then
    return null;
  end if;
  begin
    perform public._qr_sync_table_session(v_row.location_id::uuid, v_row.customer ->> 'tableId');
  exception when others then
    null;   -- the floor plan must never break an order
  end;
  return null;
end;
$fn$;
revoke all on function public.order_queue_qr_floor_tg() from public, anon, authenticated;

do $public_grants$
declare
  f text;
begin
  -- Tracker and QR reads open on phones that may have no session: anon too.
  foreach f in array array['public.order_track_row(text, text, text)', 'public.order_track_check(text, text, text)',
                           'public.qr_table_open_tabs(text, text)', 'public.qr_tab_rounds(text, text)',
                           'public.qr_tab_join(text, text, text)', 'public.qr_table_tab_count(text, text)',
                           'public.catering_day_load(text, date)'] loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon, authenticated, service_role', f);
  end loop;
  -- Writes need a session (anonymous sign in first). confirm_public_order_payment checks
  -- inside that the caller is staff of the venue.
  foreach f in array array['public.place_public_order(uuid, jsonb, jsonb, uuid[])',
                           'public.settle_qr_tab(uuid, text, jsonb, uuid[])',
                           'public.verify_public_order_payment(uuid, text, uuid[])',
                           'public.confirm_public_order_payment(uuid, text, text, bigint)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end
$public_grants$;

reset lock_timeout;


-- ============================================================================
-- V. Verification (read only). The editor shows this last result.
-- ============================================================================
-- Expect: rules_open_to_customers = false; stamp_ledger_open = false; order_functions = 4
-- (place_public_order, verify_public_order_payment, confirm_public_order_payment,
-- settle_qr_tab); tab_functions = 4; tracker_functions = 2; order_fns_need_a_session = true;
-- allow_all_left = active_sessions, kds_tickets, order_queue, table_reservations (file 2
-- closes those).
select
  exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'discount_rules'
           and policyname = 'Allow authenticated access')                                                     as rules_open_to_customers,
  (has_table_privilege('authenticated', 'public.stamp_transactions', 'INSERT')
   or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'stamp_transactions'
               and cmd in ('ALL', 'INSERT') and btrim(coalesce(with_check, qual, '')) = 'true'))              as stamp_ledger_open,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('place_public_order', 'verify_public_order_payment',
                                                 'confirm_public_order_payment', 'settle_qr_tab'))            as order_functions,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('qr_table_open_tabs', 'qr_tab_rounds', 'qr_tab_join',
                                                 'qr_table_tab_count'))                                       as tab_functions,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname in ('order_track_row', 'order_track_check'))                     as tracker_functions,
  (not has_function_privilege('anon', 'public.place_public_order(uuid, jsonb, jsonb, uuid[])', 'execute')
   and has_function_privilege('authenticated', 'public.place_public_order(uuid, jsonb, jsonb, uuid[])', 'execute')) as order_fns_need_a_session,
  (select string_agg(tablename, ', ' order by tablename) from pg_policies
    where schemaname = 'public' and policyname = 'allow all'
      and tablename in ('order_queue', 'kds_tickets', 'active_sessions', 'table_reservations'))               as allow_all_left;

-- More checks you can paste one by one (all read only):
--
-- 1. The order functions and who may call them (anon must be false):
-- select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon,
--        has_function_privilege('authenticated', p.oid, 'execute') as authenticated
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public'
--    and p.proname in ('place_public_order','verify_public_order_payment','confirm_public_order_payment',
--                      'settle_qr_tab','order_track_row','qr_tab_join')
--  order by 1;
--
-- 2. Customer orders of the last day and how each one was priced:
-- select ref, source, paid, status, customer->>'payment_state' as payment_state,
--        (customer->'order_pricing'->>'due_minor')::bigint as due_minor,
--        (customer->'order_pricing'->>'proven_minor')::bigint as proven_minor,
--        (customer->'order_pricing'->>'unknown_lines')::int as not_on_menu
--   from public.order_queue
--  where created_at > now() - interval '1 day' and source in ('online','qr','catering')
--  order by created_at desc;


-- -- ============================================================================
-- -- ROLL BACK (only if something is wrong; paste in the Ops SQL editor)
-- -- ============================================================================
-- -- HOW: copy every line from the "-- -- ====" line just above this heading to the
-- -- very end of the file and paste it into the Ops SQL editor. Select all (Cmd+A)
-- -- and press Cmd+/ once: every line loses its first "-- ", and the notes (lines
-- -- that still start with "-- ") stay notes. Then press Run.
-- -- ORDER: if file 2 (20260919b) has run, roll IT back first (the ROLL BACK block at
-- -- the end of 20260919b_OPS_fence_2_after_app.sql). While file 2 is still in, this
-- -- block stops at its first step and changes nothing. a1 comes out after this one.
-- -- WHAT: it puts discount_rules and stamp_transactions back exactly as they were on
-- -- 18 Sep, and can run twice. The server functions and their tables stay: nothing calls
-- -- them once the app is back on its old path, and a customer order simply goes back to
-- -- being written straight in, as it is today. THE ORDERS PLACED WHILE THIS HALF WAS IN
-- -- KEEP everything it gave them (their prices, their paid checks, their tokens).
-- set local lock_timeout = '3s';
-- do $rb_guard$
-- declare
--   v_file_b boolean := false;
-- begin
--   if to_regclass('public.fence_state') is not null then
--     execute 'select exists (select 1 from public.fence_state where key = ''file_b'')' into v_file_b;
--   end if;
--   if v_file_b or exists (select 1 from pg_policies where schemaname = 'public'
--                           and policyname in ('order_queue_staff', 'kds_tickets_staff', 'print_jobs_staff',
--                                              'active_sessions_staff', 'table_reservations_staff',
--                                              'closed_checks_insert_staff')) then
--     raise exception 'STOPPED, NOTHING WAS CHANGED. File 2 (20260919b) is still in. Roll back file 2 first (the ROLL BACK block at the end of 20260919b_OPS_fence_2_after_app.sql), then run this block again.';
--   end if;
-- end
-- $rb_guard$;
-- -- discount rules and the stamp ledger back to their 18 Sep rules
-- drop policy if exists discount_rules_read on public.discount_rules;
-- drop policy if exists discount_rules_write_bo on public.discount_rules;
-- drop policy if exists "Allow authenticated access" on public.discount_rules;
-- create policy "Allow authenticated access" on public.discount_rules for all to public using (auth.role() = 'authenticated'::text);
-- grant insert, update, delete on table public.discount_rules to anon;
-- drop policy if exists service_all_stamp_tx on public.stamp_transactions;
-- create policy service_all_stamp_tx on public.stamp_transactions for all to public using (true) with check (true);
-- grant insert, update, delete on table public.stamp_transactions to anon, authenticated;
-- delete from public.fence_state where key = 'file_a2';
-- reset lock_timeout;
