-- 20261016_OPS_stock_areas.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Adds 6 tables, 1 column on stock_counts (plus 3 name columns), 1 column  #
-- #  on stock_count_lines, 1 column on stock_movements, replaces the          #
-- #  post_stock_movement function with a 12 argument one, adds the transfer   #
-- #  leg function, and backfills the areas from each item's storage text.     #
-- #  RUN OUTSIDE SERVICE: the posting function is dropped and created again   #
-- #  inside this one transaction, and the API schema cache is reloaded at the #
-- #  end. Then post ONE test movement (Stock items, Set count on a demo item)  #
-- #  before leaving the screen.                                               #
-- ############################################################################
--
-- WHY (Peter, 15 and 16 Oct 2026)
--   "Things come in then go into a central cellar then they get distributed to fridges and
--   freezers. Counts are just all items which is wrong: you need to count by location then
--   complete as whole, or count via supplier, or just do a spot check. These numbers need to be
--   right." "The storage locations need to be set ahead of time, then on the products there
--   should be a drop down." "Transfers between locations and stock areas, so then each stock
--   area should have its own holding of said item."
--
-- WHAT THIS FILE DOES
--   storage_areas              the venue's list of areas (Cellar, Walk in fridge, Freezer, Dry
--                              store, Bar, Kitchen), set up ahead of time on the Stock areas screen.
--                              At most one is the receiving area, where deliveries land.
--   inventory_item_areas       which area an item lives in (its use area). One primary row an item.
--   inventory_item_area_stock  the holding of each item in each area. A cache kept by the posting
--                              function in the same statement, like inventory_items.on_hand.
--                              The ledger (stock_movements.area_id) stays the truth.
--   stock_movements.area_id    every movement from now on says which area it touched.
--   post_stock_movement        gains a 12th argument p_area_id (default null). When it is null the
--                              function works the area out: a delivery lands in the receiving area
--                              if one is flagged, everything else lands in the item's use area,
--                              nothing when the venue has no areas. Every caller alive today (the
--                              tills, the two edge functions, set_inventory_on_hand) keeps working
--                              with no redeploy: 11 arguments bind to the new function through the
--                              default. The 11 argument signature is DROPPED first, in the same
--                              transaction, or an 11 argument call would be ambiguous.
--   stock_counts               gains supplier_id, approval_note, started_by_name and
--                              approved_by_name; count_type now allows AREA and SUPPLIER.
--   stock_count_lines.area_id  a count line is one (item, area). Null = the whole item (old drafts).
--   stock_count_areas          one row per area on a count sheet: open or complete, by whom, when.
--   stock_transfers            stock moving between areas (one venue) or between venues.
--   stock_transfer_lines       the lines of a transfer, with the receiver's matched item.
--   post_stock_transfer_leg    posts a whole transfer leg (out, in, or both) in one transaction.
--   Backfill                   one area per distinct storage text per venue (from LIVE items),
--                              every item whose text matches gets that use area, every old movement
--                              goes to its item's use area, and the holdings cache is rebuilt.
--                              NO area is flagged receiving by this file: the venue ticks it on the
--                              Stock areas screen once it has a way to move deliveries out.
--
-- BEFORE AND AFTER IT RUNS
--   Before: Back Office works as today. Stock counts shows the single New count button and the
--   old sheet, the item editor shows the Storage location text box, and the Stock areas screen
--   says it needs this update. Nothing sends p_area_id until the probe finds storage_areas.
--   After: the Stock areas screen lists the areas the backfill found, the item editor shows the
--   Stock area dropdown, New count offers Full, By area, By supplier and Spot check, and every
--   sale, delivery, waste and count adjustment carries its area.
--
-- Rollback: 20261016_OPS_stock_areas_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice: every create is "if not exists", the backfill
-- only touches rows with no area yet, and the cache is deleted and refilled inside the transaction.

do $guard$
begin
  if to_regclass('public.device_profiles') is null or to_regclass('public.devices') is null then
    raise exception 'This is not the Ops database (device_profiles or devices is missing). Nothing was changed.';
  end if;
  if to_regclass('public.inventory_items') is null or to_regclass('public.stock_movements') is null
     or to_regclass('public.stock_counts') is null or to_regclass('public.stock_count_lines') is null then
    raise exception 'The stock tables (inventory_items, stock_movements, stock_counts) are missing. Run the 20260621e and 20260622 stock files first. Nothing was changed.';
  end if;
  if to_regprocedure('public.user_accessible_locations()') is null then
    raise exception 'The fence helper user_accessible_locations is missing. This is not the database this file was written for. Nothing was changed.';
  end if;
  if to_regprocedure('public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text)') is null
     and to_regprocedure('public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)') is null then
    raise exception 'post_stock_movement is not the function this file expects (neither the 11 nor the 12 argument shape). Nothing was changed.';
  end if;
end
$guard$;

-- Fail fast instead of making till reads queue behind this script.
set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- ── 1. Tables ───────────────────────────────────────────────────────────────

create table if not exists public.storage_areas (
  id            uuid primary key default gen_random_uuid(),
  location_id   uuid not null,
  name          text not null,
  kind          text not null default 'other'
                constraint storage_areas_kind_chk check (kind in ('cellar','walk_in','fridge','freezer','dry_store','bar','kitchen','other')),
  sort_order    integer not null default 0,
  is_receiving  boolean not null default false,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint storage_areas_name_chk check (char_length(btrim(name)) between 1 and 60)
);
comment on table public.storage_areas is
  'Stock areas of a venue (16 Oct 2026): Cellar, Walk in fridge, Freezer, Dry store, Bar, Kitchen. Set up ahead of time on Back Office, Stock areas. At most one live area a venue is the receiving area (deliveries land there). src/lib/stock/areaRules.js.';
-- Two live areas cannot share a name (spelling and case aside).
create unique index if not exists storage_areas_name_uniq
  on public.storage_areas (location_id, lower(btrim(name))) where archived_at is null;
-- At most one receiving area a venue.
create unique index if not exists storage_areas_receiving_uniq
  on public.storage_areas (location_id) where is_receiving and archived_at is null;
create index if not exists storage_areas_loc_idx on public.storage_areas (location_id, sort_order);

create table if not exists public.inventory_item_areas (
  id                uuid primary key default gen_random_uuid(),
  location_id       uuid not null,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  area_id           uuid not null references public.storage_areas(id) on delete restrict,
  is_primary        boolean not null default true,
  created_at        timestamptz not null default now(),
  constraint inventory_item_areas_item_area_uniq unique (inventory_item_id, area_id)
);
comment on table public.inventory_item_areas is
  'Which area an item lives in: its use area (is_primary). Sales, waste, production and counts with no area come out of it. One primary row an item; later slices may add is_primary false rows (an item also kept at the bar).';
-- ONE use area per item.
create unique index if not exists inventory_item_areas_primary_uniq
  on public.inventory_item_areas (inventory_item_id) where is_primary;
create index if not exists inventory_item_areas_loc_area_idx on public.inventory_item_areas (location_id, area_id);

create table if not exists public.inventory_item_area_stock (
  location_id       uuid not null,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  area_id           uuid not null references public.storage_areas(id) on delete cascade,
  on_hand           numeric(16,4) not null default 0,
  updated_at        timestamptz not null default now(),
  primary key (inventory_item_id, area_id)
);
comment on table public.inventory_item_area_stock is
  'Holding of each item in each area. A CACHE kept by post_stock_movement in the same statement as the ledger row (like inventory_items.on_hand). Truth = sum of stock_movements.qty_base by area_id. Read only through the API; the rebuild at the bottom of 20261016_OPS_stock_areas.sql refills it.';
create index if not exists inventory_item_area_stock_loc_area_idx on public.inventory_item_area_stock (location_id, area_id);

create table if not exists public.stock_count_areas (
  id                uuid primary key default gen_random_uuid(),
  location_id       uuid not null,
  count_id          uuid not null references public.stock_counts(id) on delete cascade,
  area_id           uuid not null references public.storage_areas(id) on delete cascade,
  status            text not null default 'open' constraint stock_count_areas_status_chk check (status in ('open','complete')),
  completed_by_name text,
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  constraint stock_count_areas_count_area_uniq unique (count_id, area_id)
);
comment on table public.stock_count_areas is
  'One row per area on a count sheet. The counter marks their area complete (by name, with the time); the manager approves the whole count once every area is complete, or confirms the ones that are not.';
create index if not exists stock_count_areas_count_idx on public.stock_count_areas (count_id);

create table if not exists public.stock_transfers (
  id               uuid primary key default gen_random_uuid(),
  location_id      uuid not null,
  to_location_id   uuid,
  from_area_id     uuid references public.storage_areas(id) on delete set null,
  to_area_id       uuid references public.storage_areas(id) on delete set null,
  status           text not null default 'DRAFT' constraint stock_transfers_status_chk check (status in ('DRAFT','SENT','RECEIVED','CANCELLED','DONE')),
  reference        text,
  note             text,
  created_by_name  text,
  sent_by_name     text,
  sent_at          timestamptz,
  received_by_name text,
  received_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
comment on table public.stock_transfers is
  'Stock moving between areas of one venue (to_location_id null, born and finished DONE in one step) or between venues (SENT, then RECEIVED or CANCELLED). location_id is the SENDING venue. Posted through post_stock_transfer_leg only.';
-- Builder B (16 Oct, later the same day): who cancelled a transfer and when. "add column if not
-- exists" so the file stays safe to run twice.
alter table public.stock_transfers add column if not exists cancelled_by_name text;
alter table public.stock_transfers add column if not exists cancelled_at timestamptz;
create index if not exists stock_transfers_loc_idx on public.stock_transfers (location_id, created_at desc);
create index if not exists stock_transfers_to_loc_idx on public.stock_transfers (to_location_id, created_at desc) where to_location_id is not null;

create table if not exists public.stock_transfer_lines (
  id                   uuid primary key default gen_random_uuid(),
  transfer_id          uuid not null references public.stock_transfers(id) on delete cascade,
  location_id          uuid not null,
  to_location_id       uuid,
  inventory_item_id    uuid not null references public.inventory_items(id) on delete restrict,
  to_inventory_item_id uuid references public.inventory_items(id) on delete set null,
  name_snapshot        text,
  sku_snapshot         text,
  base_unit            text,
  qty_base             numeric(16,4) not null,
  unit_cost            numeric(12,5),
  qty_received_base    numeric(16,4),
  dropped              boolean not null default false,
  sort_order           integer not null default 0,
  created_at           timestamptz not null default now()
);
comment on table public.stock_transfer_lines is
  'Lines of a stock transfer. location_id (sender) and to_location_id (receiver) are copied from the parent at insert so the receiving venue reads its lines through this table''s own columns (27 Sep 2026 lesson: a line policy must fence on its own columns).';
create index if not exists stock_transfer_lines_transfer_idx on public.stock_transfer_lines (transfer_id, sort_order);

-- ── 2. stock_counts: scope and names, wider count_type ──────────────────────

alter table public.stock_counts add column if not exists supplier_id uuid;
alter table public.stock_counts add column if not exists approval_note text;
alter table public.stock_counts add column if not exists started_by_name text;
alter table public.stock_counts add column if not exists approved_by_name text;

-- The original check was made unnamed in 20260622_par_counts.sql (Postgres named it
-- stock_counts_count_type_check). Find whatever check mentions count_type and replace it.
do $count_type$
declare
  r record;
begin
  for r in
    select c.conname from pg_constraint c
     where c.conrelid = 'public.stock_counts'::regclass and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%count_type%'
  loop
    execute format('alter table public.stock_counts drop constraint %I', r.conname);
  end loop;
  alter table public.stock_counts add constraint stock_counts_count_type_chk
    check (count_type in ('FULL','PARTIAL','SPOT','AREA','SUPPLIER'));
end
$count_type$;

-- ── 3. stock_count_lines.area_id ────────────────────────────────────────────

alter table public.stock_count_lines add column if not exists area_id uuid references public.storage_areas(id) on delete set null;
create index if not exists stock_count_lines_count_area_idx on public.stock_count_lines (count_id, area_id);

-- ── 4. stock_movements.area_id ──────────────────────────────────────────────

alter table public.stock_movements add column if not exists area_id uuid references public.storage_areas(id) on delete set null;
create index if not exists stock_mv_item_area_idx on public.stock_movements (location_id, inventory_item_id, area_id);

-- ── 5. post_stock_movement: the 12 argument shape ───────────────────────────
-- The 11 argument signature is dropped FIRST (same transaction). Postgres would otherwise keep
-- both, and every 11 argument call would then be ambiguous ("function is not unique") because
-- the 12 argument one also matches through its default. Grants are per signature, so the grant
-- is issued again below for the new one, to the same three roles as 20260621e.

drop function if exists public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text);

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
  if p_idempotency_key is not null then
    select id, area_id into v_existing_id, v_existing_area from stock_movements
      where location_id = p_location_id and idempotency_key = p_idempotency_key limit 1;
    if v_existing_id is not null then
      select on_hand into v_onhand from inventory_items where id = p_inventory_item_id;
      return jsonb_build_object('id', v_existing_id, 'on_hand', v_onhand, 'duplicate', true, 'area_id', v_existing_area);
    end if;
  end if;

  v_cost := coalesce(p_unit_cost, (select current_cost from inventory_items where id = p_inventory_item_id), 0);

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

grant execute on function public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid) to authenticated, anon, service_role;

-- ── 6. post_stock_transfer_leg: a whole leg in one transaction ──────────────
-- Why a function and not a loop of posts from the browser: two venues, two legs, many lines; a
-- lost line between venues is stock that exists nowhere. One transaction or nothing.
--   p_leg = 'out'   the sending venue posts TRANSFER_OUT per line (status DRAFT becomes SENT)
--   p_leg = 'both'  within one venue: OUT from from_area_id and IN to to_area_id (DRAFT becomes DONE)
--   p_leg = 'in'    the receiving venue posts TRANSFER_IN per matched line (SENT becomes RECEIVED)
--   p_leg = 'cancel' the sending venue takes a transfer back: a DRAFT is simply CANCELLED; a SENT
--                   one (stock already out) posts TRANSFER_IN per line back into from_area_id,
--                   key transfer:{id}:{lineId}:cancel, then CANCELLED. Never after RECEIVED or DONE.
-- Refuses in words (jsonb error) for an ordinary refusal; raises only for a bad leg. A second
-- call finds the status already moved and answers duplicate true. Granted to authenticated and
-- service_role only (never anon).

create or replace function public.post_stock_transfer_leg(p_transfer_id uuid, p_leg text, p_by_name text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t record;
  v_l record;
  v_role text;
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

  -- Who is asking: the service role passes; a signed in login must hold the venue of this leg.
  v_role := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
  if v_role <> 'service_role' then
    if p_leg = 'in' then
      v_mine := v_t.to_location_id is not null and v_t.to_location_id::text in (select user_accessible_locations());
    else
      v_mine := v_t.location_id::text in (select user_accessible_locations());
    end if;
    if not coalesce(v_mine, false) then
      return jsonb_build_object('ok', false, 'error', 'This transfer belongs to a venue you cannot open');
    end if;
  end if;

  -- Already past this step: nothing moves twice.
  if (p_leg in ('out', 'both') and v_t.status <> 'DRAFT') or (p_leg = 'in' and v_t.status <> 'SENT')
     or (p_leg = 'cancel' and v_t.status = 'CANCELLED') then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', v_t.status);
  end if;
  if p_leg = 'cancel' and v_t.status not in ('DRAFT', 'SENT') then
    return jsonb_build_object('ok', false, 'error', 'A transfer that is ' || lower(v_t.status) || ' cannot be cancelled: move the stock back with a new transfer');
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
  -- Where it lands: the chosen area, else the receiving area, else (null) the item's use area.
  v_area := v_t.to_area_id;
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
      return jsonb_build_object('ok', false, 'error', 'A matched item is not at the receiving venue');
    end if;
    v_before := coalesce(v_item.on_hand, 0);
    v_cost := coalesce(v_l.unit_cost, v_item.current_cost, 0);
    v_res := post_stock_movement(v_t.to_location_id, v_l.to_inventory_item_id, v_qty, 'TRANSFER_IN',
      v_cost, 'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':in',
      now(), null, 'Transfer ' || coalesce(v_t.reference, ''), v_area);
    -- The receiver's cost moves the way a delivery moves it (costAfterReceipt in
    -- supabase/functions/_shared/stockCosting.js): moving average, or the last cost replaces.
    -- A zero cost never re-costs the item.
    if coalesce((v_res ->> 'duplicate')::boolean, false) = false and v_cost > 0 then
      if coalesce(v_item.cost_method, 'MOVING_AVG') = 'LAST_COST' or v_before + v_qty <= 0 or v_before <= 0 then
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

revoke all on function public.post_stock_transfer_leg(uuid, text, text) from public, anon;
grant execute on function public.post_stock_transfer_leg(uuid, text, text) to authenticated, service_role;

-- ── 7. Row level security ───────────────────────────────────────────────────
-- The live stock_counts rule, word for word: ((location_id)::text IN (SELECT user_accessible_locations())).
-- The transfer tables fence on either end (sender or receiver). The holdings cache is read only
-- through the API (the posting function writes it). The restrictive second sign in step fence is
-- added where the database has it (20260919s), guarded by to_regprocedure like 20261005a.

alter table public.storage_areas             enable row level security;
alter table public.inventory_item_areas      enable row level security;
alter table public.inventory_item_area_stock enable row level security;
alter table public.stock_count_areas         enable row level security;
alter table public.stock_transfers           enable row level security;
alter table public.stock_transfer_lines      enable row level security;

do $rls$
declare t text;
begin
  foreach t in array array['storage_areas', 'inventory_item_areas', 'stock_count_areas'] loop
    execute format('drop policy if exists %I_rls on public.%I;', t, t);
    execute format($f$
      create policy %I_rls on public.%I
        for all
        using ((location_id)::text in (select user_accessible_locations()))
        with check ((location_id)::text in (select user_accessible_locations()));
    $f$, t, t);
  end loop;
  foreach t in array array['stock_transfers', 'stock_transfer_lines'] loop
    execute format('drop policy if exists %I_rls on public.%I;', t, t);
    execute format($f$
      create policy %I_rls on public.%I
        for all
        using ((location_id)::text in (select user_accessible_locations())
            or (to_location_id)::text in (select user_accessible_locations()))
        with check ((location_id)::text in (select user_accessible_locations())
            or (to_location_id)::text in (select user_accessible_locations()));
    $f$, t, t);
  end loop;
  drop policy if exists inventory_item_area_stock_read on public.inventory_item_area_stock;
  create policy inventory_item_area_stock_read on public.inventory_item_area_stock
    for select using ((location_id)::text in (select user_accessible_locations()));
  -- No insert, update or delete policy on the cache: the posting function writes it.
end
$rls$;

do $second_step$
declare t text;
begin
  if to_regprocedure('public.second_step_ok()') is not null then
    foreach t in array array['storage_areas', 'inventory_item_areas', 'inventory_item_area_stock', 'stock_count_areas', 'stock_transfers', 'stock_transfer_lines'] loop
      if not exists (select 1 from pg_policy p where p.polrelid = format('public.%I', t)::regclass and p.polname = 'second_step_fence') then
        execute format('create policy second_step_fence on public.%I as restrictive for all to authenticated '
          || 'using ((select public.second_step_ok())) with check ((select public.second_step_ok()))', t);
      end if;
    end loop;
  end if;
end
$second_step$;

-- The count sheet watches its areas turn complete live (two counters, one manager).
do $realtime$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stock_count_areas') then
    alter publication supabase_realtime add table public.stock_count_areas;
  end if;
end
$realtime$;

-- ── 8. Backfill ─────────────────────────────────────────────────────────────
-- 8a. One area per distinct storage text per venue, from LIVE items only (archived test items
--     carried texts like "Fridge 14" that nobody wants as an area). The normalised text is the
--     key: trimmed, spaces collapsed, lower case, dashes and underscores to spaces, a leading
--     "the " dropped (areaRules.normaliseAreaName says the same in JavaScript). The display name
--     is the first spelling seen, trimmed. Kind from the words (areaRules.kindFromName).
--     Nothing is flagged receiving here.
with texts as (
  select i.location_id,
         btrim(i.storage_location) as shown,
         regexp_replace(lower(regexp_replace(regexp_replace(btrim(i.storage_location), '[-_]', ' ', 'g'), '\s+', ' ', 'g')), '^the ', '') as norm,
         min(i.created_at) as first_seen
    from inventory_items i
   where i.archived_at is null
     and nullif(btrim(coalesce(i.storage_location, '')), '') is not null
   group by i.location_id, btrim(i.storage_location)
), picked as (
  select distinct on (location_id, norm) location_id, norm, shown
    from texts
   order by location_id, norm, first_seen, shown
)
insert into storage_areas (location_id, name, kind, sort_order)
select p.location_id, p.shown,
       case
         when p.norm like '%freezer%' then 'freezer'
         when p.norm like '%walk%' then 'walk_in'
         when p.norm like '%fridge%' or p.norm like '%chiller%' then 'fridge'
         when p.norm like '%cellar%' then 'cellar'
         when p.norm like '%dry%' or p.norm like '%store%' or p.norm like '%pantry%' then 'dry_store'
         when p.norm like '%bar%' then 'bar'
         when p.norm like '%kitchen%' or p.norm like '%prep%' then 'kitchen'
         else 'other'
       end,
       row_number() over (partition by p.location_id order by p.norm) * 10
  from picked p
 where not exists (
   select 1 from storage_areas a
    where a.location_id = p.location_id and a.archived_at is null
      and lower(btrim(a.name)) = lower(p.shown)
 );

-- 8b. Every item (archived too) whose text matches a live area gets that use area. An item that
--     already has a primary area keeps it.
insert into inventory_item_areas (location_id, inventory_item_id, area_id, is_primary)
select i.location_id, i.id, a.id, true
  from inventory_items i
  join storage_areas a
    on a.location_id = i.location_id and a.archived_at is null
   and regexp_replace(lower(regexp_replace(regexp_replace(btrim(a.name), '[-_]', ' ', 'g'), '\s+', ' ', 'g')), '^the ', '')
     = regexp_replace(lower(regexp_replace(regexp_replace(btrim(i.storage_location), '[-_]', ' ', 'g'), '\s+', ' ', 'g')), '^the ', '')
 where nullif(btrim(coalesce(i.storage_location, '')), '') is not null
   and not exists (select 1 from inventory_item_areas ia where ia.inventory_item_id = i.id and ia.is_primary)
on conflict (inventory_item_id, area_id) do nothing;

-- 8c. Every old movement goes to its item's USE area, deliveries too. Nobody recorded any
--     transfer, so putting old deliveries in a cellar would leave the cellar high and the fridge
--     below zero for every item. Only rows with no area yet are touched.
update stock_movements m
   set area_id = ia.area_id
  from inventory_item_areas ia
 where ia.inventory_item_id = m.inventory_item_id and ia.is_primary
   and m.area_id is null;

-- 8d. Rebuild the holdings cache from the ledger (delete and refill, inside this transaction).
delete from inventory_item_area_stock;
insert into inventory_item_area_stock (location_id, inventory_item_id, area_id, on_hand, updated_at)
select m.location_id, m.inventory_item_id, m.area_id, sum(m.qty_base), now()
  from stock_movements m
 where m.area_id is not null
 group by m.location_id, m.inventory_item_id, m.area_id;

-- ── 9. The API learns the new function shape and tables straight away ───────
-- Without this PostgREST keeps the 11 argument signature cached and a till's
-- supabase.rpc('post_stock_movement', ...) can fail with PGRST202 until it reloads on its own.
notify pgrst, 'reload schema';

-- ── 10. Seed the usual six areas for a list of venues (OPTIONAL, commented out) ──
-- The Coffee Boy venues have no items yet, so this file makes them no areas. Fill the ids in and
-- run this block on its own if you want them before the demo; the Stock areas screen has the
-- same "Add the usual six" button. Nothing is flagged receiving: tick Cellar on the screen once
-- deliveries can be moved out with a transfer.
-- insert into storage_areas (location_id, name, kind, sort_order)
-- select v.id, s.name, s.kind, s.sort_order
--   from (values ('00000000-0000-0000-0000-000000000000'::uuid)) as v(id)
--   cross join (values ('Cellar','cellar',10), ('Walk in fridge','walk_in',20), ('Freezer','freezer',30),
--                      ('Dry store','dry_store',40), ('Bar','bar',50), ('Kitchen','kitchen',60)) as s(name, kind, sort_order)
--  where not exists (select 1 from storage_areas a where a.location_id = v.id and a.archived_at is null and lower(btrim(a.name)) = lower(s.name));

-- VISIBLE CHECK (the SQL editor shows this last result). Expected:
--   on_hand_vs_ledger 0, area_cache_vs_ledger 0, fn_12_args 1, fn_11_args 0, transfer_fn 1,
--   count_type_check 1, areas_made = the number of distinct storage texts across your venues,
--   items_with_area = the items that carried one of those texts, movements_without_area = movements
--   of items with no area (0 at the demo venues), realtime_on 1.
select
  (select count(*) from inventory_items i
    where coalesce(i.on_hand, 0) <> coalesce((select sum(m.qty_base) from stock_movements m where m.inventory_item_id = i.id), 0)
      and exists (select 1 from stock_movements m where m.inventory_item_id = i.id)) as on_hand_vs_ledger,
  (select count(*) from inventory_item_area_stock s
    where s.on_hand <> coalesce((select sum(m.qty_base) from stock_movements m
                                  where m.inventory_item_id = s.inventory_item_id and m.area_id = s.area_id), 0)) as area_cache_vs_ledger,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'post_stock_movement' and p.pronargs = 12) as fn_12_args,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'post_stock_movement' and p.pronargs = 11) as fn_11_args,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'post_stock_transfer_leg') as transfer_fn,
  (select count(*) from pg_constraint c where c.conrelid = 'public.stock_counts'::regclass and c.conname = 'stock_counts_count_type_chk'
     and pg_get_constraintdef(c.oid) like '%AREA%' and pg_get_constraintdef(c.oid) like '%SUPPLIER%') as count_type_check,
  (select count(*) from storage_areas where archived_at is null) as areas_made,
  (select count(*) from inventory_item_areas where is_primary) as items_with_area,
  (select count(*) from stock_movements where area_id is null) as movements_without_area,
  (select count(*) from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'stock_count_areas') as realtime_on;
