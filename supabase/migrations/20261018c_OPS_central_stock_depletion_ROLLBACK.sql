-- 20261018c_OPS_central_stock_depletion_ROLLBACK.sql
--
-- OPS DB ONLY (tbetcegmszzotrwdtqhi). Undoes 20261018c_OPS_central_stock_depletion.sql: drops the
-- two triggers on closed_checks and the three pg_cron jobs, puts post_stock_movement back to its
-- 20261018a text (the door closes: tills post again everywhere) and post_stock_transfer_leg back
-- to its 20261018a line order, drops the API facing RPCs and the internal routines. KEEPS the tables (stock_outbox, stock_outbox_runs, stock_depletion_mode,
-- stock_depletion_default, their rows), every stock movement already booked, the indexes, the
-- table options and inventory_items.returns_to_shelf: nothing of the stock history is lost, and the
-- migration applies again on top of it.
--
-- RUN THIS BEFORE 20261018a_OPS_stock_function_fences_ROLLBACK.sql: that file checks the md5 of
-- post_stock_movement and refuses the door text.
--
-- To back out ONE venue instead, no rollback is needed:
--   select public.stock_central_switch('<venue uuid>', 'browser', 'peter');
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction.

do $guard$
declare v_md5 text;
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.devices') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('public._post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)') is null then
    raise exception '20261018a is not live (no _post_stock_movement): there is nothing of 20261018c to undo here. Nothing was changed.';
  end if;
  select md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) into v_md5 from pg_proc p
   where p.oid = to_regprocedure('public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)');
  if v_md5 is null or v_md5 not in ('0adb151adb1611b05a1099df81cf5aae', 'ad53ab7ca7477bba0a56b2e512fc11e7') then
    raise exception 'post_stock_movement is neither the 20261018c door nor the 20261018a text (md5 %). Nothing was changed. Send this line to Claude.', coalesce(v_md5, 'missing');
  end if;
  select md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) into v_md5 from pg_proc p
   where p.oid = to_regprocedure('public.post_stock_transfer_leg(uuid,text,text)');
  if v_md5 is null or v_md5 not in ('541ac92297e3784706a2f7a958d5c396', '8c6ee62b7279f09f94f1e0eaa320da9d') then
    raise exception 'post_stock_transfer_leg is neither the 20261018c order nor the 20261018a text (md5 %). Nothing was changed. Send this line to Claude.', coalesce(v_md5, 'missing');
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '60s';

-- 1. The triggers: nothing is enqueued any more.
drop trigger if exists closed_checks_stock_outbox_ins on public.closed_checks;
drop trigger if exists closed_checks_stock_outbox_upd on public.closed_checks;

-- 2. The jobs.
do $cron$
declare j record;
begin
  if to_regprocedure('cron.unschedule(bigint)') is not null then
    for j in select jobid from cron.job where jobname in ('stock-outbox-drain', 'stock-outbox-sweep', 'stock-outbox-purge') loop
      perform cron.unschedule(j.jobid);
    end loop;
  end if;
end
$cron$;

-- 3. The door: post_stock_movement back to 20261018a's text (byte for byte).
create or replace function public.post_stock_movement(
  p_location_id       uuid,
  p_inventory_item_id uuid,
  p_qty_base          numeric,
  p_movement_type     text,
  p_unit_cost         numeric default null,
  p_source_type       text default null,
  p_source_id         text default null,
  p_idempotency_key   text default null,
  p_occurred_at       timestamptz default null,
  p_created_by        uuid default null,
  p_notes             text default null,
  p_area_id           uuid default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  -- FENCE 20261018a: only a caller that can reach this venue (stock_caller_reaches).
  if not public.stock_caller_reaches(p_location_id) then
    raise exception 'post_stock_movement: this session cannot move stock at venue %', p_location_id
      using errcode = '42501';
  end if;
  return public._post_stock_movement(p_location_id, p_inventory_item_id, p_qty_base, p_movement_type,
    p_unit_cost, p_source_type, p_source_id, p_idempotency_key, p_occurred_at, p_created_by, p_notes, p_area_id);
end $$;
revoke all on function public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid) from public, anon;
grant execute on function public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid) to authenticated, service_role;

-- 3b. Transfers: post_stock_transfer_leg back to 20261018a's line order (sort_order), byte for byte.
do $leg$
declare
  v_def text;
  v_old constant text := 'order by case when p_leg = ''in'' then to_inventory_item_id else inventory_item_id end, sort_order, id';
begin
  if (select md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) from pg_proc p
       where p.oid = to_regprocedure('public.post_stock_transfer_leg(uuid,text,text)')) = '541ac92297e3784706a2f7a958d5c396' then
    v_def := pg_get_functiondef(to_regprocedure('public.post_stock_transfer_leg(uuid,text,text)'));
    execute replace(v_def, v_old, 'order by sort_order, id');
  end if;
end
$leg$;

-- 4. The routines (the tables stay).
drop function if exists public.stock_outbox_watch(integer, integer);
drop function if exists public.stock_outbox_release(bigint);
drop function if exists public.stock_outbox_health(uuid);
drop function if exists public.stock_venue_mode(uuid);
drop function if exists public.stock_central_switch(uuid, text, text);
drop function if exists public.stock_outbox_purge();
drop function if exists public.stock_outbox_sweep();
drop procedure if exists public.stock_outbox_drain(integer, integer, numeric, boolean);
drop procedure if exists public.stock_outbox_drain(integer, integer, numeric);
drop function if exists public._stock_outbox_apply(bigint);
drop function if exists public._stock_given_back(uuid, text);
drop function if exists public._stock_refund_at(uuid, text, jsonb);
drop function if exists public._stock_refund_lines(jsonb, jsonb);
drop function if exists public._stock_taken(uuid, text);
drop function if exists public._stock_post(uuid, uuid, numeric, text, text, text, text, timestamptz, numeric, uuid, text, boolean);
drop function if exists public._stock_counted_after(uuid, uuid, timestamptz);
drop function if exists public._stock_outbox_on_update();
drop function if exists public._stock_outbox_on_insert();
drop function if exists public._stock_refund_failed(jsonb);
drop function if exists public._stock_writer_class(uuid);
drop function if exists public.stock_explode_skipped(uuid, jsonb, text);
drop function if exists public.stock_explode(uuid, jsonb, text, text);
drop function if exists public.stock_qty_to_base(numeric, text, uuid);
drop function if exists public.stock_line_applies(jsonb, text, boolean);
drop function if exists public.stock_norm_order_type(text);
drop function if exists public.stock_js_key(jsonb);
drop function if exists public.stock_js_qty(jsonb);
drop function if exists public.stock_js_num(jsonb);
drop function if exists public.stock_js_truthy(jsonb);
drop function if exists public.stock_venue_is_central(uuid);
drop function if exists public._stock_mode_of(uuid);

notify pgrst, 'reload schema';

-- VISIBLE CHECK. Expected: triggers 0, cron_jobs 0, routines_left 0, door_text_is_20261018a 1
-- (md5 ad53ab7ca7477bba0a56b2e512fc11e7), tables_kept 3, movements_kept = your count,
-- transfer_leg_is_20261018a 1 (md5 8c6ee62b7279f09f94f1e0eaa320da9d).
select
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname = 'closed_checks' and t.tgname in ('closed_checks_stock_outbox_ins', 'closed_checks_stock_outbox_upd')) as triggers,
  (select count(*) from cron.job where jobname in ('stock-outbox-drain', 'stock-outbox-sweep', 'stock-outbox-purge')) as cron_jobs,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
     and (p.proname like '\_stock\_%' or p.proname like 'stock\_outbox\_%' or p.proname in ('stock_explode', 'stock_central_switch', 'stock_venue_mode', 'stock_venue_is_central'))) as routines_left,
  (select count(*) from pg_proc p where p.oid = to_regprocedure('public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)')
     and md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = 'ad53ab7ca7477bba0a56b2e512fc11e7') as door_text_is_20261018a,
  (select count(*) from pg_tables where schemaname = 'public' and tablename in ('stock_outbox', 'stock_outbox_runs', 'stock_depletion_mode')) as tables_kept,
  (select count(*) from public.stock_movements) as movements_kept,
  (select count(*) from pg_proc p where p.oid = to_regprocedure('public.post_stock_transfer_leg(uuid,text,text)')
     and md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = '8c6ee62b7279f09f94f1e0eaa320da9d') as transfer_leg_is_20261018a;
