-- 20261002a_OPS_qr_floor_tabs_only.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Safe any time, service included. Replaces two functions, nothing else.   #
-- #  NOT needed for the 2 Oct app fix to work. It MUST run before             #
-- #  20260919b_OPS_fence_2_after_app.sql (the note at the top of that file).  #
-- ############################################################################
--
-- WHAT WENT WRONG (Peter, 2 Oct 2026, Coffee Boy Leeds, live)
--   "online ordering, when you order to table you get 2 orders ... it's opening 2 tables for
--   some reason, one on the actual table 6 and 6.1, that needs to not happen."
--   QR order QR-FAUOB was paid in full on the phone. The QR floor sync still wrote its item
--   onto floor table T6 as a session, and the till shows every session as an open, unpaid
--   check. So the Orders screen had "Table T6, In service, Open" beside the paid QR card,
--   Open loaded a paid order into the pay flow, and nothing took the session off the table
--   when the order was collected.
--
-- THE RULE NOW (src/lib/publicOrder.js qrRowOnFloor)
--   Only the rounds of an OPEN TAB go on the floor plan: a tab is unpaid and still running.
--   A pay now order is one paid order in the Orders screen's QR section, never a table check.
--
-- WHY THIS FILE
--   Today the phone does the floor sync (src/lib/qrTableSession.js) and the app release fixes
--   it there. _qr_sync_table_session is the server's copy of the same rule. Nothing calls it
--   yet: its trigger (order_queue_qr_floor) is attached by 20260919b, which has not run. If
--   20260919b ran with the old rule, every paid QR order would go back on its table. This
--   file gives the server the new rule first.
--
-- THE SECOND FUNCTION (review, 2 Oct)
--   qr_table_tab_count gives a new TAB its number on the table ("T6", then "T6.2" for a second
--   tab opened while the first is still running). It counted every QR row that was not yet
--   collected, paid pay now orders included, and a paid order stays in the queue until staff
--   tap it through to collected (QR-FAUOB was still 'prep' 40 minutes after it was paid). So a
--   first tab on a table with one of those would have been numbered "T6.2". It now counts open
--   tabs only. The new app never asks it for a pay now order (that always carries the plain
--   table); a phone still holding the old page gets "T6.1" for a pay now order, as today.
--
-- RULES OF THE FILE
--   two create or replace (each function exactly as 20260919a2 wrote it, one condition
--   changed), a self test that aborts before anything is kept, a verification select, and a
--   roll back block in comments.

do $guard$
begin
  if to_regprocedure('public._qr_sync_table_session(uuid, text)') is null
     or to_regprocedure('public.qr_table_tab_count(text, text)') is null
     or to_regprocedure('public._fence_bool(text)') is null then
    raise exception 'The payment half (20260919a2) has not run. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

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
         -- 2 Oct 2026: only the rounds of an OPEN TAB. A paid pay now order is finished
         -- business and is never an open check on the table (until now it counted too).
         and public._fence_bool(q.customer ->> 'tab_open')
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

-- The number a new tab takes on its table: the tabs already OPEN there. As 20260919a2 wrote it
-- (section 7b), with one more condition. Its grants are kept by create or replace.
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
     and q.customer ->> 'tableId' = p_table_id
     -- 2 Oct 2026: open tabs only. A paid pay now order still in the queue takes no number.
     and public._fence_bool(q.customer ->> 'tab_open');
$fn$;


-- ============================================================================
-- Self test: the rule is really in the function now
-- ============================================================================
do $test$
declare
  v_src text := pg_get_functiondef('public._qr_sync_table_session(uuid, text)'::regprocedure);
begin
  if position('q.paid or' in v_src) > 0 then
    raise exception 'Self test: a paid pay now order still counts. Nothing was changed.';
  end if;
  if position('and public._fence_bool(q.customer ->> ''tab_open'')' in v_src) = 0 then
    raise exception 'Self test: the open tab rule is not in the function. Nothing was changed.';
  end if;
  if position('and public._fence_bool(q.customer ->> ''tab_open'')' in pg_get_functiondef('public.qr_table_tab_count(text, text)'::regprocedure)) = 0 then
    raise exception 'Self test: the tab count still counts paid orders. Nothing was changed.';
  end if;
  if not has_function_privilege('anon', 'public.qr_table_tab_count(text, text)', 'execute') then
    raise exception 'Self test: the customer page can no longer read the tab count. Nothing was changed.';
  end if;
end
$test$;

-- ============================================================================
-- Verification: one row, all five must be true
-- ============================================================================
select
  position('q.paid or' in pg_get_functiondef('public._qr_sync_table_session(uuid, text)'::regprocedure)) = 0 as paid_orders_off_the_floor,
  position('and public._fence_bool(q.customer ->> ''tab_open'')' in pg_get_functiondef('public._qr_sync_table_session(uuid, text)'::regprocedure)) > 0 as open_tabs_still_on_it,
  not has_function_privilege('anon', 'public._qr_sync_table_session(uuid, text)', 'execute') as not_callable_from_a_phone,
  position('and public._fence_bool(q.customer ->> ''tab_open'')' in pg_get_functiondef('public.qr_table_tab_count(text, text)'::regprocedure)) > 0 as tab_number_counts_open_tabs_only,
  has_function_privilege('anon', 'public.qr_table_tab_count(text, text)', 'execute') as customer_page_can_still_read_it;

-- ============================================================================
-- ROLL BACK
-- Re-run section 7g of supabase/migrations/20260919a2_OPS_fence_public_orders.sql (the
-- create or replace of public._qr_sync_table_session and its revoke) and, in section 7b, the
-- create or replace of public.qr_table_tab_count: they hold the previous version of each
-- function and are safe to run twice. (After a roll back 20260919b refuses to run again.)
-- ============================================================================
