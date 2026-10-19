-- 20261018c_OPS_central_stock_depletion.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  NEEDS 20261018a_OPS_stock_function_fences.sql (v5.11.76) live first.     #
-- #  One transaction: any error and nothing changes. Safe to run twice.       #
-- #  Run OUTSIDE UK service: CREATE TRIGGER takes a short lock on             #
-- #  closed_checks (lock_timeout 3 s below: it gives up, nothing changes,     #
-- #  run it again).                                                            #
-- #  DAY ONE NOTHING MOVES: every venue stays on the till ("browser") path    #
-- #  until stock_central_switch(<venue>, 'central', 'peter') is run for it.    #
-- ############################################################################
--
-- WHY (Peter, 18 Oct 2026): "you send the order to the POS, the POS should know what's been
--   ordered ... it's supposed to be central." Today stock comes off only in the till's browser
--   at check close (fire and forget, no retry); kiosk, online, QR, HubRise, ezCater, catering
--   and every refund made outside the till never touch stock. The database now does it for
--   every channel, from the booked check itself, exactly once, and tells someone when it is late.
--
-- HOW (design B, "outbox + drainer", chosen 18 Oct)
--   1. A statement level trigger on closed_checks writes ONE outbox row per booked, refunded or
--      voided check at a venue switched to central (one PK probe for every other venue). It never
--      raises: any error is a warning and the hourly sweep finds the check. The sale write never
--      waits on stock.
--   2. pg_cron runs public.stock_outbox_drain() every minute (as postgres). It claims rows with
--      FOR UPDATE SKIP LOCKED in batches of 50, posts each event in its own subtransaction through
--      public._post_stock_movement (the fences core, owner only), commits per batch, retries with
--      backoff (15 s x 2^n, cap 1 h) and parks an event as dead after 8 tries, with the error.
--   3. The one stock rule, in SQL (stock_explode): the same maths as src/lib/stock/explode.js
--      (portion, usable %, order type tags, pack tokens, unit bridges, made items depleted as
--      themselves, sizes are their own menu item, itemId else id, modifiers with itemId that are
--      not instructions and not removed, bar-tab is dine in), EXCEPT wastage % which no longer
--      multiplies the quantity taken off (fences contract: wastage changes cost only).
--   4. The door: at a central venue, post_stock_movement answers an API caller's SALE_DEPLETION or
--      RETURN post for a check (source_type closed_check, closed_check_refund, online_sale,
--      online_refund) with {skipped: 'central'} and posts nothing, so a till on ANY build, the
--      kiosk and the stock-deplete function cannot double count. Waste, counts, deliveries and
--      transfers are untouched. The database itself (pg_cron, this editor) is never refused.
--   5. Keys are the till's own: sale:<check>:<item>; unsale|waste|return:<check>:<refund id>:<item>;
--      waste:<check>:tomb:<item>; late:<key>; undo:<key>. The unique index stock_mv_idem_uniq is
--      the floor under everything.
--
-- RULES BOOKED HERE (Peter, 18 Oct 2026)
--   * Food is never put back. A refund, or a void after the kitchen made it, reverses the sale's
--     share (SALE_DEPLETION +q, key unsale:...) and books the same amount as WASTE (key waste:...,
--     reason Refunded or Voided, a waste_events row), so on hand stays off and waste and GP reports
--     are right. Only items with "Can go back on the shelf" (inventory_items.returns_to_shelf, off
--     by default) RETURN (key return:...). Never more than the sale took, less what earlier
--     refunds and voids already moved. A refund the processor later refused (failed true, or the
--     till's cardStatus failed) is undone exactly once (key undo:<key>).
--   * A line voided before it was sent to the kitchen never takes stock off. A whole order voided
--     (tombstone, status voided) books WASTE only for lines marked fired or sent. A tombstone
--     that mirrors a paid check (same venue and ref, a prepaid kiosk or online order voided on the
--     Orders screen) books nothing: that sale's own refund does.
--   * Posting values as the till: unit cost null (current cost at posting), area null (the
--     item's use area), occurred_at = closed_at (the trading report buckets COGS by it),
--     source_type closed_check, source_id = the check id.
--   * A sale closed before a count but posted after it (an offline till) gets the equal and
--     opposite STOCK_COUNT_ADJ (key late:<key>), so on hand still equals the count.
--   * Excluded: id like 'demo-%' (the demo files post their own rows), source booking, a venue
--     with no menu_item_recipes (cheap no op), a venue not switched on.
--   * Held, never posted by itself: a check written by a session that cannot open the venue and
--     carries no payment proof (the insert policy on closed_checks is still with check (true)),
--     a check older than 31 days or closed before the venue switched on less a day (bulk
--     replays), items edited after close, a check moved to another venue. A Back Office login at
--     the venue releases a held row (stock_outbox_release).
--
-- WHO WROTE IT (writer class, read from the OUTER caller's claims inside the trigger)
--   service (service_role: edge functions), db (no claims and not the API login: pg_cron, this
--   editor, the demo files, and place_public_order / settle_qr_tab which run as postgres), device
--   (the venue is in accessible_location_uuids(): a bound till, kiosk or ops tablet, a Back Office
--   login of the venue or its company, a super admin), else public. A public row posts once when a
--   paid public order proof exists for its ref (public_order_tokens.paid or payment_proofs
--   used_by_ref), a unique index makes one proof serve one check; else it is held.
--
-- SECURITY DEFAULTS
--   Every routine here is owned by postgres with search_path = public; EXECUTE is taken from
--   public, anon, authenticated and service_role (the schema's default ACL grants EXECUTE to anon
--   on every new function) and given back only where named: stock_outbox_health, stock_outbox_
--   release and stock_venue_mode (authenticated + service_role, each gated by stock_caller_reaches),
--   stock_outbox_watch (service_role only, the watchdog). The tables stock_outbox,
--   stock_outbox_runs, stock_depletion_mode and stock_depletion_default: RLS on, zero grants, not
--   in supabase_realtime. Only public._post_stock_movement is called to post, never the public
--   post_stock_movement from a trigger (it judges the outer caller and would abort a customer's
--   order).
--
-- GUARD: refuses unless 20261018a is live (public._post_stock_movement exists, stock_mv_idem_uniq
--   exists, post_stock_movement's body is 20261018a's fenced text or this file's door text) and
--   pg_cron is installed. Anything else and NOTHING is changed.
-- SELF TEST (rolled back): the internal routines are not callable through the API; the door
--   answers skipped at a central venue; a stranger classifies as public.
-- UNDO: 20261018c_OPS_central_stock_depletion_ROLLBACK.sql (run it BEFORE 20261018a's ROLLBACK).
-- PROOF: node supabase/tests/central_stock/run.mjs (local Postgres 17, real roles, live timeouts).
-- SWITCH ON (one venue, by hand, when Peter says):
--   select public.stock_central_switch('<venue uuid>', 'central', 'peter');
-- SWITCH OFF: select public.stock_central_switch('<venue uuid>', 'browser', 'peter');
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction.

do $guard$
declare
  v_md5 text;
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.devices') is null
     or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regprocedure('public._post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)') is null
     or to_regprocedure('public.stock_caller_reaches(uuid)') is null then
    raise exception 'The stock fences are not live: run 20261018a_OPS_stock_function_fences.sql first. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'stock_movements' and indexname = 'stock_mv_idem_uniq') then
    raise exception 'The unique index stock_mv_idem_uniq on stock_movements is missing. Nothing was changed.';
  end if;
  if to_regclass('public.closed_checks') is null or to_regclass('public.menu_item_recipes') is null
     or to_regclass('public.recipe_lines') is null or to_regclass('public.inventory_items') is null
     or to_regclass('public.stock_units') is null or to_regclass('public.item_packaging_formats') is null
     or to_regclass('public.inventory_item_conversions') is null or to_regclass('public.waste_events') is null
     or to_regclass('public.stock_counts') is null or to_regclass('public.stock_count_lines') is null
     or to_regclass('public.public_order_tokens') is null or to_regclass('public.payment_proofs') is null
     or to_regclass('public.storage_areas') is null then
    raise exception 'A table this file reads is missing. Nothing was changed.';
  end if;
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise exception 'pg_cron is not there (cron.schedule). Nothing was changed.';
  end if;
  select md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) into v_md5 from pg_proc p
   where p.oid = to_regprocedure('public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)');
  if v_md5 is null or v_md5 not in ('ad53ab7ca7477bba0a56b2e512fc11e7', '0adb151adb1611b05a1099df81cf5aae') then
    raise exception 'post_stock_movement is not the 20261018a text this file was written for (md5 %). Nothing was changed. Send this line to Claude.', coalesce(v_md5, 'missing');
  end if;
end
$guard$;

-- Fail fast instead of making till writes queue behind this script.
set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- -- 1. Columns, indexes and table options ---------------------------------------------------
alter table public.inventory_items add column if not exists returns_to_shelf boolean not null default false;
comment on column public.inventory_items.returns_to_shelf is
  'Can go back on the shelf (sealed cans, bottles). Off by default: a refund, or a void after the kitchen made it, books food as waste, never back to stock. 20261018c.';

-- Refund caps and the sweep read a check's movements by source_id; the late sale guard reads
-- the last count on an item.
create index if not exists stock_mv_source_idx on public.stock_movements (location_id, source_id) where source_id is not null;
create index if not exists stock_mv_count_idx on public.stock_movements (location_id, inventory_item_id, occurred_at desc)
  where movement_type in ('STOCK_COUNT_ADJ', 'OPENING_BALANCE');
create index if not exists stock_counts_approved_idx on public.stock_counts (location_id, approved_at) where upper(status) = 'APPROVED';

-- Hot rows: on hand is updated on every movement. Room on the page for HOT updates and a tighter
-- autovacuum so the tables do not bloat at 50 sites x 300 checks an hour.
alter table public.inventory_items set (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
alter table public.inventory_item_area_stock set (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);

-- -- 2. The switch: which venues the database depletes -------------------------------------
-- No row = the default, and the default is 'browser' (the till path, as today). 'central' = the
-- database books every check. 'paused' = events are kept but not posted, and browser posts are
-- still refused (for a venue being fixed). Nothing here is readable through the API.
create table if not exists public.stock_depletion_default (
  one  boolean primary key default true check (one),
  mode text not null default 'browser' check (mode in ('browser', 'central')),
  changed_by text,
  changed_at timestamptz not null default now()
);
insert into public.stock_depletion_default (one, mode, changed_by) values (true, 'browser', '20261018c') on conflict (one) do nothing;
alter table public.stock_depletion_default enable row level security;
revoke all on public.stock_depletion_default from public, anon, authenticated, service_role;

create table if not exists public.stock_depletion_mode (
  location_id   uuid primary key,
  mode          text not null check (mode in ('browser', 'central', 'paused')),
  central_since timestamptz,
  changed_by    text,
  changed_at    timestamptz not null default now()
);
alter table public.stock_depletion_mode enable row level security;
revoke all on public.stock_depletion_mode from public, anon, authenticated, service_role;
comment on table public.stock_depletion_mode is
  'Per venue: browser (the till takes stock off at close, as before), central (the database books every check from every channel), paused (kept, not posted). No row = stock_depletion_default (browser). Change it with stock_central_switch. 20261018c.';

-- The mode of a venue, one PK probe.
create or replace function public._stock_mode_of(p_loc uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select m.mode from stock_depletion_mode m where m.location_id = p_loc),
                  (select d.mode from stock_depletion_default d), 'browser');
$$;

create or replace function public.stock_venue_is_central(p_loc uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select p_loc is not null and public._stock_mode_of(p_loc) in ('central', 'paused');
$$;

-- -- 3. The outbox ----------------------------------------------------------------------------
-- One row per (venue, check, kind, event ref). Never in realtime, no grants. The partial index is
-- what the drainer walks; the proof index makes one paid public order serve one check.
create table if not exists public.stock_outbox (
  id          bigint generated always as identity primary key,
  location_id uuid   not null,
  check_id    text   not null,
  kind        text   not null check (kind in ('sale', 'tomb', 'refund', 'undo', 'void', 'edit', 'moved')),
  event_ref   text   not null default '',
  writer      text   not null,
  status      text   not null default 'pending' check (status in ('pending', 'done', 'skipped', 'held', 'dead')),
  due_at      timestamptz not null default now(),
  occurred_at timestamptz not null default now(),
  attempts    integer not null default 0,
  last_error  text,
  flags       text[] not null default '{}',
  proof       text,
  posted      jsonb,
  created_at  timestamptz not null default now(),
  done_at     timestamptz,
  constraint stock_outbox_event_uniq unique (location_id, check_id, kind, event_ref)
) with (fillfactor = 80, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
create index if not exists stock_outbox_due_idx on public.stock_outbox (due_at, id) where status = 'pending';
create index if not exists stock_outbox_loc_status_idx on public.stock_outbox (location_id, status, created_at);
create unique index if not exists stock_outbox_proof_uniq on public.stock_outbox (proof) where proof is not null;
alter table public.stock_outbox enable row level security;
revoke all on public.stock_outbox from public, anon, authenticated, service_role;
comment on table public.stock_outbox is
  'Central stock depletion queue: one event per booked, refunded or voided check at a central venue. writer: device, service, db, public, swept, released. status: pending, done, skipped, held (needs a person), dead (8 failures, see last_error). 20261018c.';

create table if not exists public.stock_outbox_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  finished_at timestamptz,
  done integer not null default 0,
  failed integer not null default 0,
  oldest_due_age_s numeric
);
alter table public.stock_outbox_runs enable row level security;
revoke all on public.stock_outbox_runs from public, anon, authenticated, service_role;

-- -- 4. The one stock rule, in SQL ---------------------------------------------------------
-- Mirrors src/lib/stock/explode.js with JavaScript semantics kept (Number(x) || 1, truthiness),
-- minus the wastage multiply. Pure helpers first.
create or replace function public.stock_js_truthy(j jsonb) returns boolean
language sql immutable parallel safe as $$
  select case jsonb_typeof(j)
           when 'boolean' then (j #>> '{}')::boolean
           when 'number'  then (j #>> '{}')::numeric <> 0
           when 'string'  then (j #>> '{}') <> ''
           when 'object'  then true
           when 'array'   then true
           else false end;
$$;

create or replace function public.stock_js_num(j jsonb) returns numeric
language sql immutable parallel safe as $$
  select case jsonb_typeof(j)
           when 'number'  then (j #>> '{}')::numeric
           when 'boolean' then case when (j #>> '{}')::boolean then 1 else 0 end
           when 'string'  then case when btrim(j #>> '{}') ~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$'
                                    then btrim(j #>> '{}')::numeric else 0 end
           else 0 end;
$$;

create or replace function public.stock_js_qty(j jsonb) returns numeric
language sql immutable parallel safe as $$
  select coalesce(nullif(public.stock_js_num(j), 0), 1);
$$;

create or replace function public.stock_js_key(j jsonb) returns text
language sql immutable parallel safe as $$
  select case when jsonb_typeof(j) in ('string', 'number') and (j #>> '{}') <> '' then j #>> '{}' end;
$$;

-- costing.js normaliseOrderType, plus bar-tab as dine in (the bar tab record's order type).
create or replace function public.stock_norm_order_type(p text) returns text
language sql immutable parallel safe as $$
  select case when p is null or btrim(p) = '' then 'dine-in'
              else coalesce((select a.v from (values ('dinein','dine-in'), ('eatin','dine-in'), ('counter','dine-in'),
                                                     ('bar','dine-in'), ('bartab','dine-in'),
                                                     ('drivethru','drive-thru'), ('drivethrough','drive-thru')) a(k, v)
                              where a.k = regexp_replace(lower(btrim(p)), '[\s_-]', '', 'g')),
                            lower(btrim(p))) end;
$$;

-- costing.js lineAppliesToOrderType: untagged applies to all; tagged to its own type; a drive
-- thru sale takes takeaway lines unless the recipe names drive-thru itself.
create or replace function public.stock_line_applies(p_tags jsonb, p_key text, p_recipe_has_dt boolean) returns boolean
language sql immutable parallel safe as $$
  select case
           when p_tags is null or jsonb_typeof(p_tags) <> 'array' or jsonb_array_length(p_tags) = 0 then true
           when p_tags ? p_key then true
           when p_key = 'drive-thru' and p_tags ? 'takeaway' then not coalesce(p_recipe_has_dt, false)
           else false end;
$$;

-- uom.js toBase: a pack token '@<format id>', the same unit, a global unit of the same dimension,
-- else the item's own conversion bridges (shortest path, 6 hops). NULL where the JS throws (the
-- line is then skipped, as explode.js does).
create or replace function public.stock_qty_to_base(p_qty numeric, p_unit text, p_item uuid) returns numeric
language plpgsql stable security definer set search_path = public as $$
declare
  f text := lower(btrim(coalesce(p_unit, '')));
  t text;
  v numeric;
begin
  if p_qty is null then return null; end if;
  if p_unit like '@%' then
    select pf.qty_in_base into v from item_packaging_formats pf
     where pf.inventory_item_id = p_item and pf.id::text = substr(p_unit, 2);
    return case when v > 0 then p_qty * v end;
  end if;
  select lower(btrim(coalesce(i.base_unit, ''))) into t from inventory_items i where i.id = p_item;
  if f = '' or t is null or t = '' then return null; end if;
  if f = t then return p_qty; end if;
  select p_qty * a.to_canonical / b.to_canonical into v
    from stock_units a join stock_units b on b.dimension = a.dimension
   where a.code = f and b.code = t;
  if v is not null then return v; end if;
  with recursive
  br as (select lower(btrim(c.from_unit)) fu, lower(btrim(c.to_unit)) tu, c.to_qty / c.from_qty k
           from inventory_item_conversions c
          where c.inventory_item_id = p_item and c.from_qty > 0 and c.to_qty > 0
            and btrim(coalesce(c.from_unit, '')) <> '' and btrim(coalesce(c.to_unit, '')) <> ''),
  nodes as (select f n union select t union select fu from br union select tu from br),
  edges as (select fu a, tu b, k from br
            union all select tu, fu, 1 / k from br
            union all select x.n, y.n, ux.to_canonical / uy.to_canonical
                        from nodes x join nodes y on y.n <> x.n
                        join stock_units ux on ux.code = x.n join stock_units uy on uy.code = y.n and uy.dimension = ux.dimension),
  walk(node, acc, hops, path) as (
    select f, 1::numeric, 0, array[f]
    union all
    select e.b, w.acc * e.k, w.hops + 1, w.path || e.b
      from walk w join edges e on e.a = w.node
     where not e.b = any(w.path) and w.hops < 6)
  select p_qty * w.acc into v from walk w where w.node = t order by w.hops, w.path::text limit 1;
  return v;
end $$;

-- Explode sold lines (a closed_checks.items array, or a refund's items) into {stock item, base
-- qty} at one venue. Set based. p_qty_key 'refundQty' reads a refund entry's lines (refundQty,
-- else qty; voided flags ignored, the refund says what came back). Lines whose unit cannot be
-- resolved are left out and counted in skipped_lines (one row per call, item null).
create or replace function public.stock_explode(p_loc uuid, p_lines jsonb, p_order_type text, p_qty_key text default 'qty')
returns table (inventory_item_id uuid, qty_base numeric)
language sql stable security definer set search_path = public as $$
  with line as (
    select coalesce(public.stock_js_key(l -> 'itemId'), public.stock_js_key(l -> 'id')) mid,
           case when p_qty_key = 'refundQty'
                then coalesce(nullif(public.stock_js_num(l -> 'refundQty'), 0), public.stock_js_num(l -> 'qty'))
                else public.stock_js_qty(l -> 'qty') end q,
           case when jsonb_typeof(l -> 'mods') = 'array' then l -> 'mods' else '[]'::jsonb end mods
      from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) l
     where jsonb_typeof(l) = 'object'
       and (p_qty_key = 'refundQty' or not public.stock_js_truthy(l -> 'voided'))
  ),
  sold as (
    select mid, q from line where mid is not null and q > 0
    union all
    select public.stock_js_key(m -> 'itemId'), public.stock_js_qty(m -> 'qty') * line.q
      from line, jsonb_array_elements(line.mods) m
     where line.mid is not null and line.q > 0 and jsonb_typeof(m) = 'object'
       and public.stock_js_truthy(m -> 'itemId')
       and not public.stock_js_truthy(m -> '_instruction')
       and not public.stock_js_truthy(m -> 'removed')
  ),
  agg as (select mid, sum(q) q from sold where mid is not null and q > 0 group by mid),
  lnk as (select a.q * coalesce(nullif(r.portion, 0), 1) mult, r.recipe_id
            from agg a join menu_item_recipes r on r.location_id = p_loc and r.menu_item_id = a.mid),
  rl as (select k.mult, x.component_item_id, x.qty, x.unit, coalesce(x.usable_pct, 100) usable, x.order_types,
                exists (select 1 from recipe_lines y where y.recipe_id = x.recipe_id and y.location_id = p_loc
                         and jsonb_typeof(y.order_types) = 'array' and y.order_types ? 'drive-thru') rec_dt
           from lnk k join recipe_lines x on x.recipe_id = k.recipe_id and x.location_id = p_loc),
  conv as (select rl.component_item_id, rl.mult, rl.usable,
                  public.stock_qty_to_base(rl.qty, rl.unit, rl.component_item_id) b
             from rl
            where rl.usable > 0
              and public.stock_line_applies(rl.order_types, public.stock_norm_order_type(p_order_type), rl.rec_dt)
              and exists (select 1 from inventory_items i where i.id = rl.component_item_id and i.location_id = p_loc))
  select component_item_id, sum(b / (usable / 100.0) * mult)
    from conv where b is not null
   group by component_item_id
  having sum(b / (usable / 100.0) * mult) > 0;
$$;

-- How many recipe lines of these sold lines could not be resolved (unit unknown): the event is
-- flagged unit_skipped so the gap is visible (today explode.js skips them silently).
create or replace function public.stock_explode_skipped(p_loc uuid, p_lines jsonb, p_order_type text) returns integer
language sql stable security definer set search_path = public as $$
  with line as (
    select coalesce(public.stock_js_key(l -> 'itemId'), public.stock_js_key(l -> 'id')) mid,
           case when jsonb_typeof(l -> 'mods') = 'array' then l -> 'mods' else '[]'::jsonb end mods
      from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) l
     where jsonb_typeof(l) = 'object' and not public.stock_js_truthy(l -> 'voided')
  ),
  sold as (
    select mid from line where mid is not null
    union select public.stock_js_key(m -> 'itemId') from line, jsonb_array_elements(line.mods) m
     where line.mid is not null and jsonb_typeof(m) = 'object' and public.stock_js_truthy(m -> 'itemId')
       and not public.stock_js_truthy(m -> '_instruction') and not public.stock_js_truthy(m -> 'removed')
  )
  select count(*)::integer
    from sold s
    join menu_item_recipes r on r.location_id = p_loc and r.menu_item_id = s.mid
    join recipe_lines x on x.recipe_id = r.recipe_id and x.location_id = p_loc
   where coalesce(x.usable_pct, 100) > 0
     and public.stock_line_applies(x.order_types, public.stock_norm_order_type(p_order_type), false)
     and public.stock_qty_to_base(x.qty, x.unit, x.component_item_id) is null;
$$;

-- -- 5. Who wrote the check -----------------------------------------------------------------
create or replace function public._stock_writer_class(p_loc uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
begin
  if v_role = 'service_role' then return 'service'; end if;
  if v_role = '' and session_user::text not in ('authenticator', 'anon', 'authenticated') then return 'db'; end if;
  if p_loc in (select public.accessible_location_uuids()) then return 'device'; end if;
  return 'public';
end $$;

-- A refund entry the processor refused: the Adyen webhook writes failed true, the till writes
-- cardStatus 'failed'. Neither books stock.
create or replace function public._stock_refund_failed(x jsonb) returns boolean
language sql immutable parallel safe as $$
  select public.stock_js_truthy(x -> 'failed') or coalesce(x ->> 'cardStatus', '') = 'failed';
$$;

-- -- 6. Enqueue triggers (never raise) ---------------------------------------------------------
create or replace function public._stock_outbox_on_insert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  begin
    with v as (
      select n.id, n.location_id::uuid loc, n.closed_at, coalesce(n.source, '') source, n.refunds,
             (coalesce(n.voided, false) or coalesce(n.status, '') in ('void', 'voided')) tomb,
             (n.closed_at > now() + interval '10 minutes') future,
             (n.closed_at < now() - interval '31 days') too_old,
             (select m.central_since from stock_depletion_mode m where m.location_id = n.location_id::uuid) since
        from new_rows n
       where n.location_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         and n.id not like 'demo-%'
         and coalesce(n.source, '') <> 'booking'
         and public._stock_mode_of(n.location_id::uuid) in ('central', 'paused')
         and exists (select 1 from menu_item_recipes r where r.location_id = n.location_id::uuid)
    )
    insert into stock_outbox (location_id, check_id, kind, event_ref, writer, status, due_at, occurred_at, flags)
    select e.loc, e.id, e.kind, e.ref, public._stock_writer_class(e.loc), e.status, e.due, e.occ, e.flags
      from (
        select v.loc, v.id,
               case when v.tomb then 'tomb' else 'sale' end kind, '' ref,
               case when v.too_old or (v.since is not null and v.closed_at < v.since - interval '24 hours') then 'held' else 'pending' end status,
               case when v.future and v.source = 'catering' then v.closed_at else now() end due,
               case when v.future and v.source <> 'catering' then now() else coalesce(v.closed_at, now()) end occ,
               case when v.too_old then array['too_old']
                    when v.since is not null and v.closed_at < v.since - interval '24 hours' then array['before_switch']
                    when v.future and v.source <> 'catering' then array['clock_ahead']
                    else '{}'::text[] end flags
          from v
        union all
        select v.loc, v.id, 'refund', x ->> 'id', 'pending', now(),
               coalesce(case when jsonb_typeof(x -> 'timestamp') = 'number' then to_timestamp((x ->> 'timestamp')::numeric / 1000) end, now()),
               '{}'::text[]
          from v, jsonb_array_elements(case when jsonb_typeof(v.refunds) = 'array' then v.refunds else '[]'::jsonb end) x
         where not v.tomb and public.stock_js_key(x -> 'id') is not null and not public._stock_refund_failed(x)
      ) e
    on conflict do nothing;
  exception when others then
    raise warning 'stock outbox: enqueue skipped (% %); the hourly sweep will find these checks', sqlstate, sqlerrm;
  end;
  return null;
end $$;

drop trigger if exists closed_checks_stock_outbox_ins on public.closed_checks;
create trigger closed_checks_stock_outbox_ins
  after insert on public.closed_checks
  referencing new table as new_rows
  for each statement execute function public._stock_outbox_on_insert();

create or replace function public._stock_outbox_on_update() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_loc uuid;
  v_writer text;
begin
  begin
    if new.location_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or new.id like 'demo-%' then return null; end if;
    v_loc := new.location_id::uuid;
    if public._stock_mode_of(v_loc) not in ('central', 'paused')
       or not exists (select 1 from menu_item_recipes r where r.location_id = v_loc) then return null; end if;
    v_writer := public._stock_writer_class(v_loc);
    -- updates are already fenced to the venue's own sessions by the table policy
    if v_writer = 'public' then v_writer := 'fenced_update'; end if;
    -- the check moved to another venue after the sale: a person must look
    if old.location_id is distinct from new.location_id then
      insert into stock_outbox (location_id, check_id, kind, event_ref, writer, status, flags)
      values (v_loc, new.id, 'moved', left(md5(coalesce(old.location_id, '')), 12), v_writer, 'held', array['moved'])
      on conflict do nothing;
      return null;
    end if;
    -- new refund entries
    insert into stock_outbox (location_id, check_id, kind, event_ref, writer, occurred_at)
    select v_loc, new.id, 'refund', x ->> 'id', v_writer,
           coalesce(case when jsonb_typeof(x -> 'timestamp') = 'number' then to_timestamp((x ->> 'timestamp')::numeric / 1000) end, now())
      from jsonb_array_elements(case when jsonb_typeof(new.refunds) = 'array' then new.refunds else '[]'::jsonb end) x
     where public.stock_js_key(x -> 'id') is not null and not public._stock_refund_failed(x)
    on conflict do nothing;
    -- a refund the processor refused after it was booked: undo exactly what it booked
    insert into stock_outbox (location_id, check_id, kind, event_ref, writer)
    select v_loc, new.id, 'undo', x ->> 'id', v_writer
      from jsonb_array_elements(case when jsonb_typeof(new.refunds) = 'array' then new.refunds else '[]'::jsonb end) x
     where public._stock_refund_failed(x)
       and exists (select 1 from stock_outbox o where o.location_id = v_loc and o.check_id = new.id and o.kind = 'refund' and o.event_ref = x ->> 'id')
    on conflict do nothing;
    -- voided after it was booked (a HubRise cancel, a void after payment): the full refund rule
    if (coalesce(new.voided, false) or coalesce(new.status, '') in ('void', 'voided'))
       and not (coalesce(old.voided, false) or coalesce(old.status, '') in ('void', 'voided')) then
      insert into stock_outbox (location_id, check_id, kind, event_ref, writer)
      values (v_loc, new.id, 'void', '', v_writer) on conflict do nothing;
    end if;
    -- items changed after close (no code path does this today): held, never posted by itself
    if old.items is distinct from new.items then
      insert into stock_outbox (location_id, check_id, kind, event_ref, writer, status, flags)
      values (v_loc, new.id, 'edit', left(md5(coalesce(new.items::text, '')), 12), v_writer, 'held', array['items_changed'])
      on conflict do nothing;
    end if;
  exception when others then
    raise warning 'stock outbox: update enqueue skipped (% %)', sqlstate, sqlerrm;
  end;
  return null;
end $$;

drop trigger if exists closed_checks_stock_outbox_upd on public.closed_checks;
create trigger closed_checks_stock_outbox_upd
  after update of refunds, status, voided, items, location_id on public.closed_checks
  for each row
  when (old.refunds is distinct from new.refunds or old.status is distinct from new.status
        or old.voided is distinct from new.voided or old.items is distinct from new.items
        or old.location_id is distinct from new.location_id)
  execute function public._stock_outbox_on_update();

-- -- 7. Posting helpers (everything posts through public._post_stock_movement) --------------
-- Was this item counted after the moment given? A count movement dated later, or an approved
-- count that listed it (a zero variance line posts no movement).
create or replace function public._stock_counted_after(p_loc uuid, p_item uuid, p_at timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from stock_movements m
                  where m.location_id = p_loc and m.inventory_item_id = p_item and m.occurred_at > p_at
                    and m.movement_type in ('STOCK_COUNT_ADJ', 'OPENING_BALANCE'))
      or exists (select 1 from stock_counts c join stock_count_lines l on l.count_id = c.id
                  where c.location_id = p_loc and upper(c.status) = 'APPROVED' and c.approved_at > p_at
                    and l.inventory_item_id = p_item);
$$;

-- Post one movement. When it is new, dated before the item's last count and the guard is on,
-- post the equal and opposite STOCK_COUNT_ADJ (the count already saw the shelf). Returns the
-- quantity in the ledger under that key (new or already there), or 0.
create or replace function public._stock_post(
  p_loc uuid, p_item uuid, p_qty numeric, p_type text, p_source_type text, p_check text, p_key text,
  p_occurred timestamptz, p_cost numeric, p_area uuid, p_notes text, p_late_guard boolean)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  r jsonb;
  v_area uuid := p_area;
  v_qty numeric;
begin
  if p_qty is null or p_qty = 0 then return 0; end if;
  if v_area is not null and not exists (select 1 from storage_areas a where a.id = v_area and a.location_id = p_loc and a.archived_at is null) then
    v_area := null;
  end if;
  r := public._post_stock_movement(p_loc, p_item, round(p_qty, 4), p_type, p_cost, p_source_type, p_check, p_key,
                                   p_occurred, null, p_notes, v_area);
  if coalesce((r ->> 'duplicate')::boolean, false) then
    select m.qty_base into v_qty from stock_movements m where m.location_id = p_loc and m.idempotency_key = p_key;
    return coalesce(v_qty, 0);
  end if;
  if p_late_guard and public._stock_counted_after(p_loc, p_item, p_occurred) then
    perform public._post_stock_movement(p_loc, p_item, -round(p_qty, 4), 'STOCK_COUNT_ADJ', p_cost, 'late_sale', p_check,
                                        'late:' || p_key, now(), null, 'Late sale, booked after the count that already saw it', v_area);
  end if;
  return round(p_qty, 4);
end $$;

-- What a check's sale took off, per item (the till's key or the database's: the same key).
create or replace function public._stock_taken(p_loc uuid, p_check text) returns table (inventory_item_id uuid, qty numeric, unit_cost numeric, area_id uuid)
language sql stable security definer set search_path = public as $$
  select m.inventory_item_id, -m.qty_base, m.unit_cost, m.area_id
    from stock_movements m
   where m.location_id = p_loc and m.source_id = p_check and m.source_type = 'closed_check'
     and m.movement_type = 'SALE_DEPLETION' and m.idempotency_key = 'sale:' || p_check || ':' || m.inventory_item_id::text;
$$;

-- What earlier refunds and voids already moved off the sale, per item, read from the ledger:
-- RETURN rows and unsale rows count, their undo rows cancel them (same type, opposite sign).
create or replace function public._stock_given_back(p_loc uuid, p_check text) returns table (inventory_item_id uuid, qty numeric)
language sql stable security definer set search_path = public as $$
  select m.inventory_item_id, sum(m.qty_base)
    from stock_movements m
   where m.location_id = p_loc and m.source_id = p_check and m.source_type = 'closed_check_refund'
     and m.movement_type in ('RETURN', 'SALE_DEPLETION')
   group by m.inventory_item_id;
$$;

-- -- 8. Apply one event, all or nothing (the drainer wraps each call in a subtransaction) --------
create or replace function public._stock_outbox_apply(p_id bigint) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  e   stock_outbox%rowtype;
  c   closed_checks%rowtype;
  v_ot text;
  v_posted jsonb := '{}'::jsonb;
  v_flags text[] := '{}';
  m record;
  v_lines jsonb;
  v_rid text;
  v_entry jsonb;
  v_q numeric;
  v_full boolean := false;
  v_reason text;
begin
  select * into e from stock_outbox where id = p_id for update;
  if not found or e.status <> 'pending' then return 'gone'; end if;
  -- one check at a time: sale, refund, void and undo events on one check never interleave
  perform pg_advisory_xact_lock(hashtextextended('stock:' || e.location_id::text || ':' || e.check_id, 0));
  select * into c from closed_checks where id = e.check_id;
  if not found or c.location_id is distinct from e.location_id::text then
    update stock_outbox set status = 'skipped', flags = array_append(flags, 'check_gone'), done_at = now(), attempts = attempts + 1 where id = p_id;
    return 'skipped';
  end if;

  -- Who wrote it. A device, Back Office, an edge function, the database itself, or a row a
  -- person released: trusted. Anyone else (an unbound session): only a public order the server
  -- proved paid, once per ref.
  if e.writer not in ('device', 'service', 'db', 'fenced_update', 'released') then
    if e.kind in ('sale', 'tomb') and c.ref is not null
       and (exists (select 1 from public_order_tokens t where t.location_id = e.location_id::text and t.ref = c.ref and t.paid)
            or exists (select 1 from payment_proofs p where p.location_id = e.location_id::text and p.used_by_ref = e.location_id::text || ':' || c.ref)) then
      begin
        update stock_outbox set proof = e.location_id::text || ':' || c.ref where id = p_id;
      exception when unique_violation then
        update stock_outbox set status = 'held', flags = array_append(flags, 'proof_used'), attempts = attempts + 1,
               last_error = 'another check already used the payment proof for ref ' || c.ref where id = p_id;
        return 'held';
      end;
    else
      update stock_outbox set status = 'held', flags = array_append(flags, 'unproven'), attempts = attempts + 1,
             last_error = 'written by a session that cannot open this venue and no payment proof found' where id = p_id;
      return 'held';
    end if;
  end if;

  -- A refund, void or undo waits for its own sale event to finish first.
  if e.kind in ('refund', 'void', 'undo')
     and exists (select 1 from stock_outbox o where o.location_id = e.location_id and o.check_id = e.check_id
                  and o.kind = 'sale' and o.status = 'pending') then
    update stock_outbox set due_at = now() + interval '30 seconds' where id = p_id;
    return 'waiting';
  end if;

  v_ot := c.order_type;

  if e.kind = 'sale' then
    for m in select x.inventory_item_id, x.qty_base from stock_explode(e.location_id, c.items, v_ot) x order by x.inventory_item_id loop
      v_q := public._stock_post(e.location_id, m.inventory_item_id, -m.qty_base, 'SALE_DEPLETION', 'closed_check', c.id,
                                'sale:' || c.id || ':' || m.inventory_item_id::text, e.occurred_at, null, null, null, true);
      v_posted := v_posted || jsonb_build_object(m.inventory_item_id::text, -v_q);
    end loop;
    if v_posted = '{}'::jsonb then v_flags := array_append(v_flags, 'nothing_to_take'); end if;
    if public.stock_explode_skipped(e.location_id, c.items, v_ot) > 0 then v_flags := array_append(v_flags, 'unit_skipped'); end if;

  elsif e.kind = 'tomb' then
    -- A whole order voided. Lines the kitchen had (fired or sent) were made: waste, never for
    -- shelf items. A tombstone that mirrors a paid check (same venue and ref, within a day: a
    -- prepaid kiosk, online, QR or HubRise order voided on the Orders screen) books nothing.
    if c.ref is not null and exists (select 1 from closed_checks p where p.location_id = c.location_id and p.ref = c.ref and p.id <> c.id
                                      and not coalesce(p.voided, false) and coalesce(p.status, 'paid') not in ('void', 'voided')
                                      and p.closed_at between c.closed_at - interval '24 hours' and c.closed_at + interval '10 minutes') then
      v_flags := array_append(v_flags, 'paid_twin');
    else
      v_lines := (select coalesce(jsonb_agg(l - 'voided'), '[]'::jsonb) from jsonb_array_elements(case when jsonb_typeof(c.items) = 'array' then c.items else '[]'::jsonb end) l
                   where public.stock_js_truthy(l -> 'sent') or public.stock_js_truthy(l -> 'fired')
                      or (not (l ? 'sent') and not (l ? 'fired') and coalesce(c.source, 'pos') <> 'pos'));
      for m in select x.inventory_item_id, x.qty_base, i.returns_to_shelf from stock_explode(e.location_id, v_lines, v_ot) x
                 join inventory_items i on i.id = x.inventory_item_id order by x.inventory_item_id loop
        continue when m.returns_to_shelf;
        v_q := public._stock_post(e.location_id, m.inventory_item_id, -m.qty_base, 'WASTE', 'closed_check_void', c.id,
                                  'waste:' || c.id || ':tomb:' || m.inventory_item_id::text, e.occurred_at, null, null,
                                  'Voided after it was sent to the kitchen', true);
        v_posted := v_posted || jsonb_build_object(m.inventory_item_id::text, -v_q);
        insert into waste_events (id, location_id, inventory_item_id, item_name, qty, unit, qty_base, reason, note, cost_value, source, occurred_at)
        select md5('waste:' || c.id || ':tomb:' || m.inventory_item_id::text)::uuid, e.location_id, m.inventory_item_id, i.name,
               -v_q, i.base_unit, -v_q, 'Voided after sent', 'Check ' || coalesce(c.ref, c.id), -v_q * coalesce(i.current_cost, 0), 'void', e.occurred_at
          from inventory_items i where i.id = m.inventory_item_id
        on conflict (id) do nothing;
      end loop;
      if v_posted = '{}'::jsonb then v_flags := array_append(v_flags, 'nothing_made'); end if;
    end if;

  elsif e.kind in ('refund', 'void') then
    -- Food is never put back: the sale's share is reversed and the same amount booked as waste
    -- (on hand stays off). "Can go back on the shelf" items RETURN. Never more than the sale took
    -- less what earlier refunds and voids already moved (read from the ledger).
    if e.kind = 'refund' then
      select x into v_entry from jsonb_array_elements(case when jsonb_typeof(c.refunds) = 'array' then c.refunds else '[]'::jsonb end) x
       where x ->> 'id' = e.event_ref limit 1;
      if v_entry is null then
        update stock_outbox set status = 'skipped', flags = array_append(flags, 'refund_gone'), done_at = now(), attempts = attempts + 1 where id = p_id;
        return 'skipped';
      end if;
      if public._stock_refund_failed(v_entry) then
        update stock_outbox set status = 'skipped', flags = array_append(flags, 'refund_failed'), done_at = now(), attempts = attempts + 1 where id = p_id;
        return 'skipped';
      end if;
      v_full := public.stock_js_truthy(v_entry -> 'isFullRefund');
      -- the refund's lines; a line with a uid but no modifiers takes them from the stored line,
      -- so options come back too (the till's refund copies the whole line; Back Office may not)
      v_lines := (select coalesce(jsonb_agg(
                    ri || jsonb_build_object('itemId', coalesce(ri -> 'itemId', sl.s -> 'itemId', ri -> 'id'))
                       || case when ri ? 'mods' or sl.s is null then '{}'::jsonb else jsonb_build_object('mods', sl.s -> 'mods') end), '[]'::jsonb)
                   from jsonb_array_elements(case when jsonb_typeof(v_entry -> 'items') = 'array' then v_entry -> 'items' else '[]'::jsonb end) ri
                   left join lateral (select s.v as s from jsonb_array_elements(case when jsonb_typeof(c.items) = 'array' then c.items else '[]'::jsonb end) s(v)
                                       where nullif(ri ->> 'uid', '') is not null and s.v ->> 'uid' = ri ->> 'uid' limit 1) sl on true
                  where jsonb_typeof(ri) = 'object');
      v_rid := e.event_ref;
      v_reason := 'Refunded';
    else
      v_full := true;
      v_lines := '[]'::jsonb;
      v_rid := 'void';
      v_reason := 'Voided';
    end if;
    -- a money only entry (the Ryft webhook, a part refund of the amount) names no lines: nothing moves
    if not v_full and jsonb_array_length(v_lines) = 0 then
      v_flags := array_append(v_flags, 'money_only');
    else
      for m in
        with want as (
          select x.inventory_item_id, x.qty_base from stock_explode(e.location_id, v_lines, v_ot, 'refundQty') x
           where not v_full
        ),
        taken as (select * from public._stock_taken(e.location_id, c.id)),
        back as (select * from public._stock_given_back(e.location_id, c.id)),
        book as (
          select t.inventory_item_id, t.unit_cost, t.area_id,
                 greatest(0, least(case when v_full then t.qty else coalesce(w.qty_base, 0) end, t.qty - coalesce(b.qty, 0))) qty
            from taken t
            left join want w on w.inventory_item_id = t.inventory_item_id
            left join back b on b.inventory_item_id = t.inventory_item_id
        )
        select b.*, i.returns_to_shelf, i.name, i.base_unit from book b join inventory_items i on i.id = b.inventory_item_id
         where b.qty > 0.00005 order by b.inventory_item_id
      loop
        if m.returns_to_shelf then
          v_q := public._stock_post(e.location_id, m.inventory_item_id, m.qty, 'RETURN', 'closed_check_refund', c.id,
                                    'return:' || c.id || ':' || v_rid || ':' || m.inventory_item_id::text, e.occurred_at, m.unit_cost, m.area_id,
                                    v_reason || ': back on the shelf', true);
        else
          -- the cap above already counts anything an old till put back (its RETURN rows), so the
          -- sale share left is reversed here and booked as waste
          perform public._stock_post(e.location_id, m.inventory_item_id, m.qty, 'SALE_DEPLETION', 'closed_check_refund', c.id,
                                     'unsale:' || c.id || ':' || v_rid || ':' || m.inventory_item_id::text, e.occurred_at, m.unit_cost, m.area_id,
                                     v_reason || ': the sale share moved to waste', false);
          v_q := -public._stock_post(e.location_id, m.inventory_item_id, -m.qty, 'WASTE', 'closed_check_refund', c.id,
                                     'waste:' || c.id || ':' || v_rid || ':' || m.inventory_item_id::text, e.occurred_at, m.unit_cost, m.area_id,
                                     v_reason, false);
          insert into waste_events (id, location_id, inventory_item_id, item_name, qty, unit, qty_base, reason, note, cost_value, source, occurred_at)
          values (md5('waste:' || c.id || ':' || v_rid || ':' || m.inventory_item_id::text)::uuid, e.location_id, m.inventory_item_id, m.name,
                  v_q, m.base_unit, v_q, v_reason, 'Check ' || coalesce(c.ref, c.id), v_q * coalesce(m.unit_cost, 0), 'refund', e.occurred_at)
          on conflict (id) do nothing;
        end if;
        v_posted := v_posted || jsonb_build_object(m.inventory_item_id::text, v_q);
      end loop;
      if v_posted = '{}'::jsonb then v_flags := array_append(v_flags, 'nothing_to_give_back'); end if;
    end if;

  elsif e.kind = 'undo' then
    -- Post the exact opposite of every row this refund booked (same type, qty, cost, area), once.
    for m in select s.* from stock_movements s
              where s.location_id = e.location_id and s.source_id = c.id and s.source_type = 'closed_check_refund'
                and s.idempotency_key like '%:' || c.id || ':' || e.event_ref || ':%'
                and split_part(s.idempotency_key, ':', 1) in ('unsale', 'waste', 'return')
                and not exists (select 1 from stock_movements u where u.location_id = e.location_id and u.idempotency_key = 'undo:' || s.idempotency_key)
              order by s.inventory_item_id, s.idempotency_key loop
      perform public._stock_post(e.location_id, m.inventory_item_id, -m.qty_base, m.movement_type, 'closed_check_refund', c.id,
                                 'undo:' || m.idempotency_key, now(), m.unit_cost, m.area_id, 'Refund refused by the card processor: reversed', false);
      if m.movement_type = 'WASTE' then
        delete from waste_events w where w.id = md5(m.idempotency_key)::uuid and w.location_id = e.location_id;
      end if;
      v_posted := v_posted || jsonb_build_object(m.idempotency_key, -m.qty_base);
    end loop;
    if v_posted = '{}'::jsonb then v_flags := array_append(v_flags, 'nothing_to_undo'); end if;

  else
    -- edit and moved rows are written as held by the trigger; a released one has nothing safe to do by itself
    update stock_outbox set status = 'held', flags = array_append(flags, 'needs_a_person'), attempts = attempts + 1 where id = p_id;
    return 'held';
  end if;

  update stock_outbox set status = 'done', done_at = now(), attempts = attempts + 1, posted = v_posted, flags = flags || v_flags, last_error = null
   where id = p_id;
  return 'done';
end $$;

-- -- 9. The drainer, sweep and purge (pg_cron, as postgres) -----------------------------------
-- A PROCEDURE so it can COMMIT between batches. Postgres refuses COMMIT inside a SECURITY DEFINER
-- procedure, so it is INVOKER, schema qualified, and only its owner (postgres) can run it: pg_cron
-- and the SQL editor. Batches of 50 so the per event subtransactions stay small. Note: a
-- statement_timeout set inside a running CALL does not re arm the timer, so the budget keeps the
-- call well inside the server's 120 s limit; lock_timeout does apply to every lock wait.
-- p_until_empty true (the SQL editor, "drain everything now"): stop at the first empty claim
-- instead of waiting out the budget.
create or replace procedure public.stock_outbox_drain(p_budget_s integer default 50, p_batch integer default 50, p_idle_sleep numeric default 3, p_until_empty boolean default false)
language plpgsql as $$
declare
  v_t0 timestamptz := clock_timestamp();
  v_ids bigint[];
  v_id bigint;
  v_done integer := 0;
  v_fail integer := 0;
  v_run bigint;
  v_res text;
begin
  if not pg_try_advisory_lock(hashtext('stock_outbox_drain')) then return; end if;
  insert into public.stock_outbox_runs (started_at, oldest_due_age_s)
  values (now(), (select extract(epoch from now() - min(o.due_at)) from public.stock_outbox o where o.status = 'pending' and o.due_at <= now()))
  returning id into v_run;
  commit;
  loop
    perform set_config('lock_timeout', '2s', true);
    select array_agg(q.id order by q.due_at, q.id) into v_ids
      from (select o.id, o.due_at from public.stock_outbox o
             where o.status = 'pending' and o.due_at <= now()
               and public._stock_mode_of(o.location_id) <> 'paused'
             order by o.due_at, o.id
             limit p_batch
             for update of o skip locked) q;
    if v_ids is null then
      commit;
      exit when p_until_empty or clock_timestamp() - v_t0 > make_interval(secs => greatest(p_budget_s - p_idle_sleep, 0));
      perform pg_sleep(p_idle_sleep);
      continue;
    end if;
    foreach v_id in array v_ids loop
      begin
        v_res := public._stock_outbox_apply(v_id);
        if v_res = 'done' then v_done := v_done + 1; end if;
      exception when others then
        v_fail := v_fail + 1;
        update public.stock_outbox
           set attempts = attempts + 1,
               last_error = left(sqlstate || ': ' || sqlerrm, 400),
               status = case when attempts + 1 >= 8 then 'dead' else 'pending' end,
               due_at = now() + least(interval '1 hour', interval '15 seconds' * power(2, attempts))
         where id = v_id;
      end;
    end loop;
    commit;
    exit when clock_timestamp() - v_t0 > make_interval(secs => p_budget_s);
  end loop;
  update public.stock_outbox_runs set finished_at = now(), done = v_done, failed = v_fail where id = v_run;
  commit;
  perform pg_advisory_unlock(hashtext('stock_outbox_drain'));
end $$;

-- Hourly: a paid check at a central venue, closed after the switch and in the last 48 h, with
-- no sale event (the trigger was disabled, or its insert failed). Written as writer 'swept': the
-- drainer holds it unless a paid public order proof exists, and a Back Office login releases it.
create or replace function public.stock_outbox_sweep() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  insert into stock_outbox (location_id, check_id, kind, event_ref, writer, occurred_at, flags)
  select c.location_id::uuid, c.id, case when coalesce(c.voided, false) or coalesce(c.status, '') in ('void', 'voided') then 'tomb' else 'sale' end, '',
         'swept', coalesce(c.closed_at, now()), array['swept']
    from stock_depletion_mode m
    join closed_checks c on c.location_id = m.location_id::text
   where m.mode in ('central', 'paused')
     and c.closed_at >= greatest(now() - interval '48 hours', coalesce(m.central_since, now() - interval '48 hours'))
     and c.closed_at < now() - interval '2 minutes'
     and c.id not like 'demo-%' and coalesce(c.source, '') <> 'booking'
     and exists (select 1 from menu_item_recipes r where r.location_id = m.location_id)
     and not exists (select 1 from stock_outbox o where o.location_id = m.location_id and o.check_id = c.id and o.kind in ('sale', 'tomb'))
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Nightly: done and skipped events older than 7 days, runs older than 30 days. Held and dead rows stay.
create or replace function public.stock_outbox_purge() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  delete from stock_outbox where status in ('done', 'skipped') and done_at < now() - interval '7 days';
  get diagnostics n = row_count;
  delete from stock_outbox_runs where started_at < now() - interval '30 days';
  return n;
end $$;

do $cron$
declare j record;
begin
  for j in select jobid from cron.job where jobname in ('stock-outbox-drain', 'stock-outbox-sweep', 'stock-outbox-purge') loop
    perform cron.unschedule(j.jobid);
  end loop;
  perform cron.schedule('stock-outbox-drain', '* * * * *', 'call public.stock_outbox_drain();');
  perform cron.schedule('stock-outbox-sweep', '7 * * * *', 'select public.stock_outbox_sweep();');
  perform cron.schedule('stock-outbox-purge', '23 3 * * *', 'select public.stock_outbox_purge();');
end
$cron$;

-- -- 10. The switch (SQL editor only) -------------------------------------------------------
-- Turning a venue central enqueues sale events for its paid checks of the last 2 hours (the grace
-- window: a till that posted seconds before the switch cannot double, the keys collide), as
-- writer db. Turning it browser stops the trigger and opens the door again; movements stay.
create or replace function public.stock_central_switch(p_loc uuid, p_mode text, p_who text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n integer := 0;
begin
  if p_loc is null or p_mode not in ('browser', 'central', 'paused') then
    raise exception 'stock_central_switch: mode must be browser, central or paused';
  end if;
  if not exists (select 1 from locations l where l.id = p_loc) then
    raise exception 'stock_central_switch: no venue %', p_loc;
  end if;
  insert into stock_depletion_mode (location_id, mode, central_since, changed_by, changed_at)
  values (p_loc, p_mode, case when p_mode in ('central', 'paused') then now() end, p_who, now())
  on conflict (location_id) do update
    set mode = excluded.mode,
        central_since = case when excluded.mode in ('central', 'paused')
                             then coalesce(case when stock_depletion_mode.mode = 'browser' then null else stock_depletion_mode.central_since end, now())
                             else stock_depletion_mode.central_since end,
        changed_by = excluded.changed_by, changed_at = now();
  if p_mode in ('central', 'paused') and exists (select 1 from menu_item_recipes r where r.location_id = p_loc) then
    insert into stock_outbox (location_id, check_id, kind, event_ref, writer, occurred_at, flags)
    select p_loc, c.id, 'sale', '', 'db', coalesce(c.closed_at, now()), array['switch_grace']
      from closed_checks c
     where c.location_id = p_loc::text and c.closed_at > now() - interval '2 hours' and c.closed_at <= now() + interval '10 minutes'
       and c.id not like 'demo-%' and coalesce(c.source, '') <> 'booking'
       and not coalesce(c.voided, false) and coalesce(c.status, 'paid') not in ('void', 'voided')
    on conflict do nothing;
    get diagnostics n = row_count;
  end if;
  return jsonb_build_object('location_id', p_loc, 'mode', p_mode, 'grace_events', n,
                            'has_recipes', exists (select 1 from menu_item_recipes r where r.location_id = p_loc));
end $$;

-- -- 11. The door: at a central venue only the database books sales and refunds -------------
-- 20261018a's post_stock_movement text plus one block. An API caller (a till on any build, the
-- kiosk, the stock-deplete function, the service role) posting a sale or refund type for a check
-- at a central or paused venue is answered {skipped: 'central'} and nothing is posted. The
-- database itself (pg_cron, this editor, the demo files) is never refused. Waste, counts,
-- deliveries and transfers are untouched.
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
  -- CENTRAL 20261018c: at a central venue the database books sales and refunds from the check
  -- itself; an API caller's post of the same is answered as done and not posted.
  if p_movement_type in ('SALE_DEPLETION', 'RETURN')
     and coalesce(p_source_type, '') in ('closed_check', 'closed_check_refund', 'online_sale', 'online_refund')
     and coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') <> ''
     and public.stock_venue_is_central(p_location_id) then
    return jsonb_build_object('id', null, 'duplicate', false, 'skipped', 'central', 'central', true,
      'on_hand', (select on_hand from inventory_items where id = p_inventory_item_id and location_id = p_location_id));
  end if;
  return public._post_stock_movement(p_location_id, p_inventory_item_id, p_qty_base, p_movement_type,
    p_unit_cost, p_source_type, p_source_id, p_idempotency_key, p_occurred_at, p_created_by, p_notes, p_area_id);
end $$;

-- -- 12. Visibility (API callable, each gated by stock_caller_reaches) ----------------------
-- What the till reads once a minute: skip its own depletion at a central venue.
create or replace function public.stock_venue_mode(p_location_id uuid) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.stock_caller_reaches(p_location_id) then
    raise exception 'stock_venue_mode: this session cannot open venue %', p_location_id using errcode = '42501';
  end if;
  return public._stock_mode_of(p_location_id);
end $$;

-- Back Office stock screens: the backlog, in plain numbers, plus the rows that need a person.
create or replace function public.stock_outbox_health(p_location_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.stock_caller_reaches(p_location_id) then
    raise exception 'stock_outbox_health: this session cannot open venue %', p_location_id using errcode = '42501';
  end if;
  return jsonb_build_object(
    'mode', public._stock_mode_of(p_location_id),
    'pending', (select count(*) from stock_outbox o where o.location_id = p_location_id and o.status = 'pending'),
    'oldest_pending_s', (select coalesce(extract(epoch from now() - min(o.due_at)), 0)::integer from stock_outbox o where o.location_id = p_location_id and o.status = 'pending' and o.due_at <= now()),
    'held', (select count(*) from stock_outbox o where o.location_id = p_location_id and o.status = 'held'),
    'dead', (select count(*) from stock_outbox o where o.location_id = p_location_id and o.status = 'dead'),
    'done_24h', (select count(*) from stock_outbox o where o.location_id = p_location_id and o.status = 'done' and o.done_at > now() - interval '24 hours'),
    'last_run_at', (select max(r.started_at) from stock_outbox_runs r),
    'needs_person', (select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'check_id', o.check_id, 'kind', o.kind, 'status', o.status,
                                                                  'flags', to_jsonb(o.flags), 'last_error', o.last_error, 'created_at', o.created_at)
                                               order by o.created_at desc), '[]'::jsonb)
                       from (select * from stock_outbox o where o.location_id = p_location_id and o.status in ('held', 'dead') order by o.created_at desc limit 20) o));
end $$;

-- A Back Office login (not an anonymous device session) at the venue releases a held or dead row:
-- it is posted on the next drain as a trusted event. Edit and moved rows cannot be released: a
-- person corrects the stock by hand.
create or replace function public.stock_outbox_release(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare e stock_outbox%rowtype;
begin
  select * into e from stock_outbox where id = p_id for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'No such row'); end if;
  if not public.stock_caller_reaches(e.location_id) then
    raise exception 'stock_outbox_release: this session cannot open venue %', e.location_id using errcode = '42501';
  end if;
  if coalesce((nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'is_anonymous')::boolean, false) then
    return jsonb_build_object('ok', false, 'error', 'Only a Back Office login can release a held stock event');
  end if;
  if e.status not in ('held', 'dead') then return jsonb_build_object('ok', false, 'error', 'This event is ' || e.status); end if;
  if e.kind in ('edit', 'moved') then return jsonb_build_object('ok', false, 'error', 'A check edited or moved after the sale is corrected by hand (count or adjust the items)'); end if;
  update stock_outbox set status = 'pending', writer = 'released', due_at = now(), attempts = 0, last_error = null,
         flags = array_append(flags, 'released:' || coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', 'db'))
   where id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id);
end $$;

-- The watchdog (service role): per venue, the counts its three signals read.
create or replace function public.stock_outbox_watch(p_pending_older_min integer default 10, p_held_older_min integer default 60)
returns table (location_id uuid, pending_old integer, dead integer, held_old integer)
language sql stable security definer set search_path = public as $$
  select o.location_id,
         count(*) filter (where o.status = 'pending' and o.due_at < now() - make_interval(mins => greatest(p_pending_older_min, 1)))::integer,
         count(*) filter (where o.status = 'dead')::integer,
         count(*) filter (where o.status = 'held' and o.created_at < now() - make_interval(mins => greatest(p_held_older_min, 1)))::integer
    from stock_outbox o
   where o.status in ('pending', 'dead', 'held')
   group by o.location_id
  having count(*) filter (where o.status = 'pending' and o.due_at < now() - make_interval(mins => greatest(p_pending_older_min, 1))) > 0
      or count(*) filter (where o.status = 'dead') > 0
      or count(*) filter (where o.status = 'held' and o.created_at < now() - make_interval(mins => greatest(p_held_older_min, 1))) > 0;
$$;

-- -- 13. Who may call what ---------------------------------------------------------------------
-- The schema's default ACL grants EXECUTE to anon, authenticated and service_role on every new
-- function: take it from every routine here, then give it back by name.
do $grants$
declare f text;
begin
  for f in select p.oid::regprocedure::text from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and p.proname in ('_stock_mode_of', 'stock_venue_is_central', 'stock_js_truthy', 'stock_js_num', 'stock_js_qty', 'stock_js_key',
                                'stock_norm_order_type', 'stock_line_applies', 'stock_qty_to_base', 'stock_explode', 'stock_explode_skipped',
                                '_stock_writer_class', '_stock_refund_failed', '_stock_outbox_on_insert', '_stock_outbox_on_update',
                                '_stock_counted_after', '_stock_post', '_stock_taken', '_stock_given_back', '_stock_outbox_apply',
                                'stock_outbox_drain', 'stock_outbox_sweep', 'stock_outbox_purge', 'stock_central_switch',
                                'stock_venue_mode', 'stock_outbox_health', 'stock_outbox_release', 'stock_outbox_watch')
  loop
    execute format('revoke all on routine %s from public, anon, authenticated, service_role', f);
  end loop;
end
$grants$;
grant execute on function public.stock_venue_mode(uuid) to authenticated, service_role;
grant execute on function public.stock_outbox_health(uuid) to authenticated, service_role;
grant execute on function public.stock_outbox_release(bigint) to authenticated, service_role;
grant execute on function public.stock_outbox_watch(integer, integer) to service_role;
-- the door keeps 20261018a's grants
revoke all on function public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid) from public, anon;
grant execute on function public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid) to authenticated, service_role;

-- -- 14. Self test, on this database, before anything is kept ------------------------------
-- (a) none of the internal routines is callable by anon, authenticated or service_role;
-- (b) the door answers skipped for a sale post at a (made up) central venue by the service role,
--     and still posts nothing anywhere: the test block is rolled back;
-- (c) a stranger's session classifies as public; (d) every venue is still browser (no row).
do $selftest$
declare
  v_open integer;
  v_door text := 'not run';
  v_class text := 'not run';
  v_loc uuid := gen_random_uuid();
begin
  select count(*) into v_open
    from pg_proc p, unnest(array['anon', 'authenticated', 'service_role']) r(name)
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('_stock_mode_of', 'stock_venue_is_central', 'stock_qty_to_base', 'stock_explode', 'stock_explode_skipped',
                       '_stock_writer_class', '_stock_outbox_on_insert', '_stock_outbox_on_update', '_stock_counted_after', '_stock_post',
                       '_stock_taken', '_stock_given_back', '_stock_outbox_apply', 'stock_outbox_drain', 'stock_outbox_sweep',
                       'stock_outbox_purge', 'stock_central_switch')
     and has_function_privilege(r.name, p.oid, 'execute');
  if v_open > 0 then
    raise exception 'Stopped, nothing changed: % internal stock routine grant(s) still reach the API.', v_open;
  end if;
  if (select count(*) from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
       where p.pronamespace = 'public'::regnamespace and p.proname like '\_stock\_%' and a.grantee = 0 and a.privilege_type = 'EXECUTE') > 0 then
    raise exception 'Stopped, nothing changed: an internal stock routine is executable by PUBLIC.';
  end if;
  begin
    insert into stock_depletion_mode (location_id, mode, central_since) values (v_loc, 'central', now());
    -- the claims alone decide: the service role reaches every venue, and the door reads the claims role
    perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
    v_door := coalesce((public.post_stock_movement(v_loc, gen_random_uuid(), -1, 'SALE_DEPLETION', null, 'closed_check', 'selftest', 'sale:selftest:x') ->> 'skipped'), 'posted');
    -- an anonymous session bound to nothing
    perform set_config('request.jwt.claims', '{"sub":"5e1f0000-0000-4000-8000-00000000f0ce","role":"authenticated","is_anonymous":true}', true);
    v_class := public._stock_writer_class(v_loc);
    raise exception using errcode = 'P0001', message = 'central stock self test done';
  exception when others then
    if sqlerrm <> 'central stock self test done' then raise; end if;
  end;
  if v_door <> 'central' then
    raise exception 'Stopped, nothing changed: the door did not answer skipped central for a service role sale post at a central venue (got %).', v_door;
  end if;
  if v_class <> 'public' then
    raise exception 'Stopped, nothing changed: a stranger classified as % not public.', v_class;
  end if;
  if (select mode from stock_depletion_default) <> 'browser' then
    raise exception 'Stopped, nothing changed: the default mode is not browser.';
  end if;
end
$selftest$;

notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result). Expected on first run:
--   outbox_tables 3, triggers 2, cron_jobs 3, default_mode browser, venues_central 0 (nothing moves
--   until stock_central_switch is run), door_central 1, internal_open_to_api 0, outbox_in_realtime 0,
--   returns_to_shelf_column 1, api_rpcs 4 (stock_venue_mode, stock_outbox_health,
--   stock_outbox_release for signed in; stock_outbox_watch service role only).
select
  (select count(*) from pg_tables where schemaname = 'public' and tablename in ('stock_outbox', 'stock_outbox_runs', 'stock_depletion_mode')) as outbox_tables,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relname = 'closed_checks' and t.tgname in ('closed_checks_stock_outbox_ins', 'closed_checks_stock_outbox_upd')) as triggers,
  (select count(*) from cron.job where jobname in ('stock-outbox-drain', 'stock-outbox-sweep', 'stock-outbox-purge')) as cron_jobs,
  (select mode from public.stock_depletion_default) as default_mode,
  (select count(*) from public.stock_depletion_mode where mode in ('central', 'paused')) as venues_central,
  (select count(*) from pg_proc p where p.oid = to_regprocedure('public.post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)')
     and p.prosrc like '%CENTRAL 20261018c%') as door_central,
  (select count(*) from pg_proc p, unnest(array['anon', 'authenticated', 'service_role']) r(name)
    where p.pronamespace = 'public'::regnamespace
      and p.proname in ('_stock_mode_of', 'stock_explode', '_stock_outbox_apply', 'stock_outbox_drain', 'stock_outbox_sweep', 'stock_outbox_purge', 'stock_central_switch', '_stock_post')
      and has_function_privilege(r.name, p.oid, 'execute')) as internal_open_to_api,
  (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
     and tablename in ('stock_outbox', 'stock_outbox_runs', 'stock_depletion_mode', 'stock_depletion_default')) as outbox_in_realtime,
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'inventory_items' and column_name = 'returns_to_shelf') as returns_to_shelf_column,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace
     and p.proname in ('stock_venue_mode', 'stock_outbox_health', 'stock_outbox_release', 'stock_outbox_watch')
     and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'))) as api_rpcs;
