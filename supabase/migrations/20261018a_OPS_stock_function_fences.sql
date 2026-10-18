-- 20261018a_OPS_stock_function_fences.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  NEEDS 20261016_OPS_stock_areas.sql and 20260927a_OPS_rls_set_form.sql    #
-- #  (both live). One transaction: any error and nothing changes. Safe to run #
-- #  twice. Best outside UK service. Coffee Boy has no recipes, so no Coffee  #
-- #  Boy till posts stock today; Provo, Location 2 and one other company do.  #
-- ############################################################################
--
-- WHY (multi site stock plan, 18 Oct 2026, Phase 0 "Fences", Appendix D)
--   post_stock_movement and set_inventory_on_hand are SECURITY DEFINER and anyone holding the
--   public anon key could call them for ANY venue: post a sale, a delivery or waste, or set the
--   stock on hand of a venue they have nothing to do with. post_stock_transfer_leg checked only
--   user_accessible_locations, the Back Office half of the rule, and let a transfer go to a venue
--   of another company.
--
-- THE RULE (one function, public.stock_caller_reaches, used by all three)
--   A call may move stock at a venue only when it comes from:
--     * the service role (the stock-deplete and manager-approve edge functions), or
--     * the database itself (this SQL editor, pg_cron, the demo files): no API claims and not the
--       API login (authenticator), or
--     * a session that can reach the venue: accessible_location_uuids() (20260927a), which is
--       exactly what pos_can_access allows. That is a Back Office login linked to the venue, an
--       owner of its company, a super admin, or a till, kiosk or ops tablet BOUND to the venue.
--   NOT user_accessible_locations(): tills, kiosks, QR and online pages sign in anonymously
--   (role authenticated, is_anonymous true), and that helper leaves anonymous sessions out. Every
--   till's SALE_DEPLETION would be refused, deplete.js swallows the error, and on hand would
--   silently stop moving. A self test below proves every bound device still reaches its venue.
--
-- WHAT CHANGES
--   post_stock_movement (the 12 argument shape of 20261016)
--     * refuses a caller that cannot reach the venue (SQLSTATE 42501);
--     * refuses a stock item that is not one of the venue's own items (22023);
--     * refuses an area (p_area_id) that is not one of the venue's own areas (22023);
--     * the use area lookup, the cost lookup and the duplicate answer read only this venue.
--     Every other line is the 20261016 text.
--   set_inventory_on_hand: the same caller check first. Every other line is the live text.
--   post_stock_transfer_leg (20261016)
--     * who is asking: stock_caller_reaches instead of user_accessible_locations (the service
--       role still passes; a till bound to the venue now passes too, it can post there anyway);
--     * a transfer between venues must stay inside one company (both venues share an org_id);
--     * the sending lines, the area it leaves from and (within one venue) the area it goes to
--       must be the sender's own, checked before anything posts, refused in words.
--   EXECUTE on post_stock_movement and set_inventory_on_hand: taken from PUBLIC and anon, kept
--   for authenticated and service_role. post_stock_transfer_leg grants are unchanged.
--
-- WHAT IT DOES NOT TOUCH
--   decrement_stock and restore_stock (the old daily count counters). Their table stock_levels
--   is itself writable with the anon key (policy stock_levels_auth_write), so fencing the two
--   functions alone closes nothing, and the online checkout calls decrement_stock from an
--   unbound customer session, so the reach rule would stop online orders counting down. They go
--   with the stock_levels table fence, with the online count moved to the server.
--   No table, column, policy or row changes. The function signatures are the same, so PostgREST
--   keeps every call shape the tills, Back Office and the edge functions send today.
--
-- CALLERS ON MAIN (v5.11.74), all still allowed
--   src/lib/stock/deplete.js (till, at check close and refund)  bound till session
--   src/lib/stock/data.js postStockMovement / setInventoryOnHand Back Office login, or the till
--     (till waste) on its own venue
--   src/lib/stock/transfers.js, areas.js (post_stock_transfer_leg) Back Office login
--   supabase/functions/stock-deplete, manager-approve           service role
--   set_inventory_on_hand and post_stock_transfer_leg call post_stock_movement inside the same
--   transaction with the same claims, for the same venue they just checked.
--   ~/.claude/servos-release/demo 70 and 71 call it from the SQL editor: the database itself.
--
-- GUARD: the three function bodies must be exactly the ones this file was written against
--   (20261016 for post_stock_movement and post_stock_transfer_leg, the live text of 5 Aug for
--   set_inventory_on_hand; compared with spaces folded, so line endings do not matter), or this
--   file's own fenced bodies (a second run). Anything else and NOTHING is changed: it says which.
--
-- Proof: supabase/tests/stock_function_fences/run.mjs (local Postgres 17, real roles, the live
--   statement timeouts: authenticated 8 s, anon 3 s; bound till, Back Office login, owner,
--   stranger, bare anon key, service role, SQL editor).
-- UNDO: 20261018a_OPS_stock_function_fences_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction.

do $guard$
declare
  v_bad text := '';
  v_md5 text;
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.devices') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.storage_areas') is null or to_regclass('public.inventory_item_areas') is null
     or to_regclass('public.inventory_item_area_stock') is null or to_regclass('public.stock_transfers') is null
     or to_regclass('public.stock_transfer_lines') is null then
    raise exception 'The stock area tables are missing: run 20261016_OPS_stock_areas.sql first. Nothing was changed.';
  end if;
  if to_regprocedure('public.accessible_location_uuids()') is null then
    raise exception 'accessible_location_uuids() is missing: run 20260927a_OPS_rls_set_form.sql first. Nothing was changed.';
  end if;
  if to_regprocedure('public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text)') is not null then
    raise exception 'An 11 argument post_stock_movement is still there (20261016 drops it). Nothing was changed.';
  end if;
  if (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'post_stock_movement') <> 1
     or (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'set_inventory_on_hand') <> 1
     or (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'post_stock_transfer_leg') <> 1 then
    raise exception 'post_stock_movement, set_inventory_on_hand and post_stock_transfer_leg must each exist exactly once. Nothing was changed.';
  end if;

  select md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) into v_md5 from pg_proc p
   where p.oid = to_regprocedure('public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)');
  if v_md5 is null or v_md5 not in ('cf3987d3ff0064d735a9ae9727fd8794', 'adb486b4e4f95cccf5cfb6f59809331f') then
    v_bad := v_bad || ' post_stock_movement=' || coalesce(v_md5, 'missing');
  end if;
  select md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) into v_md5 from pg_proc p
   where p.oid = to_regprocedure('public.set_inventory_on_hand(uuid,uuid,numeric,uuid,text)');
  if v_md5 is null or v_md5 not in ('7d8a0343a1eca02bcb0c9dafe252fe8f', 'f7d55d836f6e05f784e296f89a83e5ad') then
    v_bad := v_bad || ' set_inventory_on_hand=' || coalesce(v_md5, 'missing');
  end if;
  select md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) into v_md5 from pg_proc p
   where p.oid = to_regprocedure('public.post_stock_transfer_leg(uuid,text,text)');
  if v_md5 is null or v_md5 not in ('e75b6c4346e8944c8ff064159f3504c1', '667e330841d8e9e4e7d3447c9b8ab588') then
    v_bad := v_bad || ' post_stock_transfer_leg=' || coalesce(v_md5, 'missing');
  end if;
  if v_bad <> '' then
    raise exception 'These functions are not the version this file was written for, so nothing was changed. Send this line to Claude:%', v_bad;
  end if;
end
$guard$;

-- Fail fast instead of making till calls queue behind this script.
set local lock_timeout = '3s';
set local statement_timeout = '60s';

-- -- 1. The rule ----------------------------------------------------------------
create or replace function public.stock_caller_reaches(p_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select p_location_id is not null
     and (
          -- another edge function, with the service role key
          coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
          -- the database itself: no API claims, and not the login the API connects as
       or (coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = ''
           and session_user::text not in ('authenticator', 'anon', 'authenticated'))
          -- a Back Office login of the venue or its company, a super admin, or a device bound to it
       or p_location_id in (select public.accessible_location_uuids())
     );
$fn$;

comment on function public.stock_caller_reaches(uuid) is
  'May this call move stock at the venue? The service role, the database itself (no API claims, not authenticator), or accessible_location_uuids() (Back Office login, owner, super admin, bound till, kiosk or ops tablet). Never user_accessible_locations(): it leaves out the anonymous till sessions. 20261018a.';

revoke all on function public.stock_caller_reaches(uuid) from public;
grant execute on function public.stock_caller_reaches(uuid) to anon, authenticated, service_role;

-- -- 2. post_stock_movement -------------------------------------------------------
-- Same signature as 20261016, so its grants and every caller stay as they are (grants are set
-- again in step 5). The marked lines are new; every other line is the 20261016 text.
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
declare
  v_cost numeric;
  v_existing_id uuid;
  v_existing_area uuid;
  v_id uuid;
  v_onhand numeric;
  v_area uuid;
  v_area_onhand numeric;
begin
  -- FENCE 20261018a: only a caller that can reach this venue (stock_caller_reaches).
  if not public.stock_caller_reaches(p_location_id) then
    raise exception 'post_stock_movement: this session cannot move stock at venue %', p_location_id
      using errcode = '42501';
  end if;
  -- FENCE 20261018a: the item and a chosen area must be this venue's own.
  if not exists (select 1 from inventory_items i where i.id = p_inventory_item_id and i.location_id = p_location_id) then
    raise exception 'post_stock_movement: stock item % is not at venue %', p_inventory_item_id, p_location_id
      using errcode = '22023';
  end if;
  if p_area_id is not null and not exists (select 1 from storage_areas a where a.id = p_area_id and a.location_id = p_location_id) then
    raise exception 'post_stock_movement: stock area % is not at venue %', p_area_id, p_location_id
      using errcode = '22023';
  end if;

  if p_idempotency_key is not null then
    select id, area_id into v_existing_id, v_existing_area from stock_movements
      where location_id = p_location_id and idempotency_key = p_idempotency_key limit 1;
    if v_existing_id is not null then
      select on_hand into v_onhand from inventory_items where id = p_inventory_item_id and location_id = p_location_id;
      return jsonb_build_object('id', v_existing_id, 'on_hand', v_onhand, 'duplicate', true, 'area_id', v_existing_area);
    end if;
  end if;

  v_cost := coalesce(p_unit_cost, (select current_cost from inventory_items where id = p_inventory_item_id and location_id = p_location_id), 0);

  -- Which area. The caller's choice first (a delivery landed somewhere else, a count line, a
  -- transfer leg). Otherwise: a delivery lands in the venue's receiving area when one is
  -- flagged; everything, deliveries included when there is no receiving area, lands in the
  -- item's use area; nothing when the venue has no areas (on_hand only, as before 16 Oct 2026).
  v_area := p_area_id;
  if v_area is null and p_movement_type = 'PURCHASE_RECEIPT' then
    select a.id into v_area from storage_areas a
      where a.location_id = p_location_id and a.is_receiving and a.archived_at is null
      limit 1;
  end if;
  if v_area is null then
    select ia.area_id into v_area
      from inventory_item_areas ia
      join storage_areas a on a.id = ia.area_id
     where ia.inventory_item_id = p_inventory_item_id and ia.is_primary and a.archived_at is null
       and ia.location_id = p_location_id and a.location_id = p_location_id   -- FENCE 20261018a
     limit 1;
  end if;

  insert into stock_movements(location_id, inventory_item_id, qty_base, unit_cost, value_delta,
      movement_type, source_type, source_id, occurred_at, posted_at, created_by, idempotency_key, notes, area_id)
    values (p_location_id, p_inventory_item_id, p_qty_base, v_cost, p_qty_base * coalesce(v_cost, 0),
      p_movement_type, p_source_type, p_source_id, coalesce(p_occurred_at, now()), now(),
      p_created_by, p_idempotency_key, p_notes, v_area)
    returning id into v_id;

  update inventory_items set on_hand = coalesce(on_hand, 0) + p_qty_base, updated_at = now()
    where id = p_inventory_item_id and location_id = p_location_id
    returning on_hand into v_onhand;

  if v_area is not null then
    insert into inventory_item_area_stock (location_id, inventory_item_id, area_id, on_hand, updated_at)
      values (p_location_id, p_inventory_item_id, v_area, p_qty_base, now())
      on conflict (inventory_item_id, area_id) do update
        set on_hand = inventory_item_area_stock.on_hand + excluded.on_hand, updated_at = now()
      returning on_hand into v_area_onhand;
  end if;

  return jsonb_build_object('id', v_id, 'on_hand', v_onhand, 'duplicate', false,
    'area_id', v_area, 'area_on_hand', v_area_onhand);
end $$;

-- -- 3. set_inventory_on_hand -----------------------------------------------------
-- The caller check first, so a stranger cannot even learn whether an item exists. Every other
-- line is the live text (000_baseline_ops.sql, read from the catalog on 5 Aug 2026).
create or replace function public.set_inventory_on_hand(
  p_location_id uuid, p_inventory_item_id uuid, p_counted_qty numeric,
  p_created_by uuid default null, p_notes text default null
) returns jsonb
language plpgsql security definer set search_path to 'public' as $function$
declare
  v_cur numeric;
  v_delta numeric;
  v_res jsonb;
begin
  -- FENCE 20261018a: only a caller that can reach this venue (stock_caller_reaches).
  if not public.stock_caller_reaches(p_location_id) then
    raise exception 'set_inventory_on_hand: this session cannot move stock at venue %', p_location_id
      using errcode = '42501';
  end if;
  select coalesce(on_hand, 0) into v_cur from inventory_items
    where id = p_inventory_item_id and location_id = p_location_id;
  if not found then return jsonb_build_object('error', 'item not found'); end if;
  v_delta := p_counted_qty - v_cur;
  if v_delta = 0 then return jsonb_build_object('on_hand', v_cur, 'delta', 0); end if;
  v_res := post_stock_movement(p_location_id, p_inventory_item_id, v_delta, 'STOCK_COUNT_ADJ',
    null, 'manual_count', null, null, now(), p_created_by, p_notes);
  return v_res || jsonb_build_object('delta', v_delta);
end $function$;

-- -- 4. post_stock_transfer_leg ---------------------------------------------------
-- The 20261016 text with the caller check swapped for stock_caller_reaches, one company only
-- between venues, and the sender's own lines and areas checked before anything posts.
create or replace function public.post_stock_transfer_leg(p_transfer_id uuid, p_leg text, p_by_name text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t record;
  v_l record;
  v_mine boolean;
  v_lines integer := 0;
  v_cost numeric;
  v_qty numeric;
  v_area uuid;
  v_item record;
  v_before numeric;
  v_new_avg numeric;
  v_res jsonb;
begin
  if p_leg not in ('out', 'in', 'both', 'cancel') then
    raise exception 'post_stock_transfer_leg: leg must be out, in, both or cancel (got %)', coalesce(p_leg, 'null');
  end if;

  select * into v_t from stock_transfers where id = p_transfer_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Transfer not found');
  end if;

  -- Who is asking (FENCE 20261018a): the same rule as post_stock_movement. The receiving leg
  -- belongs to the receiving venue; every other leg to the sending venue.
  if p_leg = 'in' then
    v_mine := v_t.to_location_id is not null and public.stock_caller_reaches(v_t.to_location_id);
  else
    v_mine := public.stock_caller_reaches(v_t.location_id);
  end if;
  if not coalesce(v_mine, false) then
    return jsonb_build_object('ok', false, 'error', 'This transfer belongs to a venue you cannot open');
  end if;

  -- Already past this step: nothing moves twice.
  if (p_leg in ('out', 'both') and v_t.status <> 'DRAFT') or (p_leg = 'in' and v_t.status <> 'SENT')
     or (p_leg = 'cancel' and v_t.status = 'CANCELLED') then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', v_t.status);
  end if;
  if p_leg = 'cancel' and v_t.status not in ('DRAFT', 'SENT') then
    return jsonb_build_object('ok', false, 'error', 'A transfer that is ' || lower(v_t.status) || ' cannot be cancelled: move the stock back with a new transfer');
  end if;

  -- FENCE 20261018a: stock moves between venues of ONE company only. A cancel only puts the
  -- stock back at the sender, so it is never refused for this.
  if p_leg in ('out', 'in') and v_t.to_location_id is not null and v_t.to_location_id <> v_t.location_id
     and not exists (select 1 from locations a join locations b on b.org_id = a.org_id
                      where a.id = v_t.location_id and b.id = v_t.to_location_id and a.org_id is not null) then
    return jsonb_build_object('ok', false, 'error', 'Stock can only move between venues of the same company');
  end if;
  -- FENCE 20261018a: the sender's own lines and areas, checked before anything posts (a return
  -- from plpgsql does not roll back, so a refusal half way through would leave a half leg).
  if (p_leg in ('out', 'both') or (p_leg = 'cancel' and v_t.status = 'SENT'))
     and v_t.from_area_id is not null
     and not exists (select 1 from storage_areas a where a.id = v_t.from_area_id and a.location_id = v_t.location_id) then
    return jsonb_build_object('ok', false, 'error', 'The area this transfer leaves from is not at the sending venue');
  end if;
  if p_leg = 'both' and v_t.to_area_id is not null
     and not exists (select 1 from storage_areas a where a.id = v_t.to_area_id and a.location_id = v_t.location_id) then
    return jsonb_build_object('ok', false, 'error', 'The area this transfer goes to is not at this venue');
  end if;
  if (p_leg in ('out', 'both') or (p_leg = 'cancel' and v_t.status = 'SENT'))
     and exists (select 1 from stock_transfer_lines l
                  where l.transfer_id = p_transfer_id and not l.dropped and coalesce(l.qty_base, 0) > 0
                    and not exists (select 1 from inventory_items i where i.id = l.inventory_item_id and i.location_id = v_t.location_id)) then
    return jsonb_build_object('ok', false, 'error', 'A line names a stock item that is not at the sending venue');
  end if;

  if p_leg = 'cancel' then
    -- A SENT transfer has already posted TRANSFER_OUT at the sender: put every line back where it came from.
    if v_t.status = 'SENT' then
      for v_l in
        select * from stock_transfer_lines where transfer_id = p_transfer_id and not dropped order by sort_order, id
      loop
        if coalesce(v_l.qty_base, 0) <= 0 then continue; end if;
        perform post_stock_movement(v_t.location_id, v_l.inventory_item_id, v_l.qty_base, 'TRANSFER_IN',
          coalesce(v_l.unit_cost, (select current_cost from inventory_items where id = v_l.inventory_item_id), 0),
          'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':cancel',
          now(), null, 'Transfer ' || coalesce(v_t.reference, '') || ' cancelled, stock back', v_t.from_area_id);
        v_lines := v_lines + 1;
      end loop;
    end if;
    update stock_transfers set status = 'CANCELLED', cancelled_by_name = p_by_name, cancelled_at = now(), updated_at = now()
      where id = p_transfer_id;
    return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'CANCELLED', 'lines', v_lines);
  end if;
  if p_leg = 'both' and v_t.to_location_id is not null and v_t.to_location_id <> v_t.location_id then
    return jsonb_build_object('ok', false, 'error', 'A transfer to another venue is sent, then received there');
  end if;
  if p_leg = 'in' and (v_t.to_location_id is null or v_t.to_location_id = v_t.location_id) then
    return jsonb_build_object('ok', false, 'error', 'A transfer within one venue has no receiving step');
  end if;

  if p_leg in ('out', 'both') then
    for v_l in
      select * from stock_transfer_lines where transfer_id = p_transfer_id and not dropped order by sort_order, id
    loop
      if coalesce(v_l.qty_base, 0) <= 0 then continue; end if;
      v_cost := coalesce((select current_cost from inventory_items where id = v_l.inventory_item_id), 0);
      update stock_transfer_lines set unit_cost = v_cost where id = v_l.id;
      perform post_stock_movement(v_t.location_id, v_l.inventory_item_id, -v_l.qty_base, 'TRANSFER_OUT',
        v_cost, 'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':out',
        now(), null, 'Transfer ' || coalesce(v_t.reference, ''), v_t.from_area_id);
      if p_leg = 'both' then
        perform post_stock_movement(v_t.location_id, v_l.inventory_item_id, v_l.qty_base, 'TRANSFER_IN',
          v_cost, 'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':in',
          now(), null, 'Transfer ' || coalesce(v_t.reference, ''), v_t.to_area_id);
      end if;
      v_lines := v_lines + 1;
    end loop;
    if v_lines = 0 then
      return jsonb_build_object('ok', false, 'error', 'This transfer has no lines with a quantity');
    end if;
    if p_leg = 'both' then
      update stock_transfers set status = 'DONE', sent_by_name = p_by_name, sent_at = now(),
        received_by_name = p_by_name, received_at = now(), updated_at = now() where id = p_transfer_id;
      return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'DONE', 'lines', v_lines);
    end if;
    update stock_transfers set status = 'SENT', sent_by_name = p_by_name, sent_at = now(), updated_at = now()
      where id = p_transfer_id;
    return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'SENT', 'lines', v_lines);
  end if;

  -- p_leg = 'in'
  if exists (select 1 from stock_transfer_lines where transfer_id = p_transfer_id and not dropped and to_inventory_item_id is null) then
    return jsonb_build_object('ok', false, 'error', 'Every line must be matched to one of your items or dropped before you receive');
  end if;
  -- Every matched item must be at the receiving venue BEFORE anything posts: a return from
  -- plpgsql does not roll back, so a refusal half way through the loop would leave the lines
  -- already posted at the receiver with the head still SENT (16 Oct review).
  if exists (select 1 from stock_transfer_lines l
              where l.transfer_id = p_transfer_id and not l.dropped
                and not exists (select 1 from inventory_items i where i.id = l.to_inventory_item_id and i.location_id = v_t.to_location_id)) then
    return jsonb_build_object('ok', false, 'error', 'A matched item is not at the receiving venue');
  end if;
  -- Where it lands: the chosen area (only when it is a live area of the receiving venue), else
  -- the receiving area, else (null) the item's use area.
  v_area := v_t.to_area_id;
  if v_area is not null and not exists (select 1 from storage_areas a
      where a.id = v_area and a.location_id = v_t.to_location_id and a.archived_at is null) then
    v_area := null;
  end if;
  if v_area is null then
    select a.id into v_area from storage_areas a
      where a.location_id = v_t.to_location_id and a.is_receiving and a.archived_at is null limit 1;
  end if;
  for v_l in
    select * from stock_transfer_lines where transfer_id = p_transfer_id and not dropped order by sort_order, id
  loop
    v_qty := coalesce(v_l.qty_received_base, v_l.qty_base);
    if coalesce(v_qty, 0) <= 0 then continue; end if;
    select id, on_hand, current_cost, cost_method into v_item from inventory_items
      where id = v_l.to_inventory_item_id and location_id = v_t.to_location_id;
    if not found then
      -- checked before the loop; a raise rolls the whole leg back
      raise exception 'post_stock_transfer_leg: matched item % is not at venue %', v_l.to_inventory_item_id, v_t.to_location_id;
    end if;
    v_before := coalesce(v_item.on_hand, 0);
    v_cost := coalesce(v_l.unit_cost, v_item.current_cost, 0);
    v_res := post_stock_movement(v_t.to_location_id, v_l.to_inventory_item_id, v_qty, 'TRANSFER_IN',
      v_cost, 'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':in',
      now(), null, 'Transfer ' || coalesce(v_t.reference, ''), v_area);
    -- The receiver's cost moves the way a delivery moves it (costAfterReceipt in
    -- supabase/functions/_shared/stockCosting.js): moving average, or the last cost replaces.
    -- The received cost stands on its own only when on hand plus received is zero or below,
    -- the same rule as movingAverageCost. A zero cost never re-costs the item.
    if coalesce((v_res ->> 'duplicate')::boolean, false) = false and v_cost > 0 then
      if coalesce(v_item.cost_method, 'MOVING_AVG') = 'LAST_COST' or v_before + v_qty <= 0 then
        v_new_avg := v_cost;
      else
        v_new_avg := (v_before * coalesce(v_item.current_cost, 0) + v_qty * v_cost) / (v_before + v_qty);
      end if;
      update item_cost_history set effective_to = now()
        where location_id = v_t.to_location_id and inventory_item_id = v_l.to_inventory_item_id and effective_to is null;
      insert into item_cost_history (location_id, inventory_item_id, base_unit_cost, source, effective_from)
        values (v_t.to_location_id, v_l.to_inventory_item_id, v_new_avg, 'TRANSFER', now());
      update inventory_items set current_cost = v_new_avg, updated_at = now()
        where id = v_l.to_inventory_item_id and location_id = v_t.to_location_id;
    end if;
    v_lines := v_lines + 1;
  end loop;
  update stock_transfers set status = 'RECEIVED', received_by_name = p_by_name, received_at = now(), updated_at = now()
    where id = p_transfer_id;
  return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'RECEIVED', 'lines', v_lines);
end $$;

-- -- 5. Who may call them -----------------------------------------------------------
-- anon and PUBLIC lose EXECUTE (no legitimate caller uses the bare anon key: every page signs
-- in first, and a page that has not signed in is bound to no venue anyway). authenticated keeps
-- it (tills, kiosks and Back Office), and so does service_role (the edge functions).
revoke all on function public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid) from public, anon;
grant execute on function public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid) to authenticated, service_role;
revoke all on function public.set_inventory_on_hand(uuid,uuid,numeric,uuid,text) from public, anon;
grant execute on function public.set_inventory_on_hand(uuid,uuid,numeric,uuid,text) to authenticated, service_role;
revoke all on function public.post_stock_transfer_leg(uuid,text,text) from public, anon;
grant execute on function public.post_stock_transfer_leg(uuid,text,text) to authenticated, service_role;

-- -- 6. Self test, on this database, before anything is kept ------------------------
-- (a) Every till, kiosk and tablet bound to a venue still reaches it (they post SALE_DEPLETION
--     at check close): asked AS each device, the way its own session asks.
-- (b) A stranger (an anonymous session bound to nothing) is refused by both functions with
--     SQLSTATE 42501, at a real venue, before any read.
-- Any failure stops the whole file: nothing is kept. Role and claims are set inside a block that
-- is always rolled back, so nothing of the test is left behind.
do $selftest$
declare
  v_devices jsonb;
  v_dev jsonb;
  v_unreached integer := 0;
  v_loc uuid;
  v_psm text := 'not run';
  v_sioh text := 'not run';
begin
  select coalesce(jsonb_agg(jsonb_build_object('uid', d.device_uid, 'loc', d.location_id)), '[]'::jsonb)
    into v_devices
    from public.devices d
   where d.device_uid is not null and d.location_id is not null
     and d.bound_via is not null and d.status in ('active', 'online');
  select l.id into v_loc from public.locations l order by l.created_at limit 1;

  begin
    execute 'set local role authenticated';
    for v_dev in select x from jsonb_array_elements(v_devices) x loop
      perform set_config('request.jwt.claims',
        jsonb_build_object('sub', v_dev ->> 'uid', 'role', 'authenticated', 'is_anonymous', true)::text, true);
      if not public.stock_caller_reaches((v_dev ->> 'loc')::uuid) then
        v_unreached := v_unreached + 1;
      end if;
    end loop;

    perform set_config('request.jwt.claims',
      jsonb_build_object('sub', '5e1f0000-0000-4000-8000-00000000f0ce', 'role', 'authenticated', 'is_anonymous', true)::text, true);
    if v_loc is not null then
      begin
        perform public.post_stock_movement(v_loc, '5e1f0000-0000-4000-8000-00000000a1e7'::uuid, -1, 'WASTE');
        v_psm := 'ALLOWED';
      exception when others then
        v_psm := sqlstate;
      end;
      begin
        perform public.set_inventory_on_hand(v_loc, '5e1f0000-0000-4000-8000-00000000a1e7'::uuid, 0);
        v_sioh := 'ALLOWED';
      exception when others then
        v_sioh := sqlstate;
      end;
    else
      v_psm := '42501';
      v_sioh := '42501';
    end if;
    raise exception using errcode = 'P0001', message = 'stock fence self test done';
  exception when others then
    if sqlerrm <> 'stock fence self test done' then raise; end if;
  end;

  if v_unreached > 0 then
    raise exception 'Stopped, nothing changed: % bound device(s) could not reach their own venue with the new rule.', v_unreached;
  end if;
  if v_psm <> '42501' or v_sioh <> '42501' then
    raise exception 'Stopped, nothing changed: a stranger was not refused (post_stock_movement %, set_inventory_on_hand %).', v_psm, v_sioh;
  end if;
end
$selftest$;

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   reach_rule 1, fenced_functions 3, anon_can_call 0, public_can_call 0, signed_in_can_call 3,
--   service_role_can_call 3, bound_devices = your bound tills, kiosks and tablets (all of them
--   reach their venue: the self test above stopped the file otherwise), unbound_recent_devices 0
--   (a device seen in the last 7 days that no claim bound: it could not post stock; it cannot
--   use pos_can_access either), venues_without_company = venues that cannot send or receive
--   transfers between venues (they never have).
select
  (select count(*) from pg_proc p where p.oid = to_regprocedure('public.stock_caller_reaches(uuid)')) as reach_rule,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('post_stock_movement', 'set_inventory_on_hand', 'post_stock_transfer_leg')
     and p.prosrc like '%stock_caller_reaches%') as fenced_functions,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('post_stock_movement', 'set_inventory_on_hand', 'post_stock_transfer_leg')
     and has_function_privilege('anon', p.oid, 'execute')) as anon_can_call,
  (select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('post_stock_movement', 'set_inventory_on_hand', 'post_stock_transfer_leg')
      and a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_can_call,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('post_stock_movement', 'set_inventory_on_hand', 'post_stock_transfer_leg')
     and has_function_privilege('authenticated', p.oid, 'execute')) as signed_in_can_call,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('post_stock_movement', 'set_inventory_on_hand', 'post_stock_transfer_leg')
     and has_function_privilege('service_role', p.oid, 'execute')) as service_role_can_call,
  (select count(*) from public.devices d where d.device_uid is not null and d.location_id is not null
     and d.bound_via is not null and d.status in ('active', 'online')) as bound_devices,
  (select count(*) from public.devices d where d.bound_via is null and d.location_id is not null
     and d.last_seen > now() - interval '7 days') as unbound_recent_devices,
  (select count(*) from public.locations l where l.org_id is null) as venues_without_company;
