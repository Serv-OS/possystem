-- 20261023a_OPS_stock_drainer_v2.sql
-- Multi site stock, the drainer release (map 8.1): one stock rule, refunds from what the sale took,
-- live day totals.
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand AFTER UK CLOSE, never in service, on its own     #
-- #  night (not the night of 0b), NEVER on 25 Oct 2026 (UK clocks) or 1 Nov   #
-- #  2026 (US clocks). One paste, one transaction: any error and nothing      #
-- #  changes. The guard refuses anywhere else, and a second paste.            #
-- ############################################################################
--
-- WHY
--   Every venue is central: the database takes stock off every sale on every channel. This file
--   makes that one rule right where it was not, keeps what each sale took so refunds give back
--   exactly that, and keeps the stock and sales day totals up as things happen, so head office
--   reports (Drop 4) are fast and add up.
--
-- WHAT CHANGES
--   Tables: stock_co_option_rules and stock_co_option_rule_sites (option rules, empty until Drop 2),
--     stock_sale_takes (what each sale took, per line). Columns: discounts.kind (staff, comp,
--     loyalty or null), stock_day_sums.demo (in its primary key), and attempts, due_at, last_error
--     on stock_day_sums_repair and sales_day_sums_queue.
--   Seven live bodies are rebuilt from their live text (saved first in stock_native_backup as
--     drainer_v2:<name>): stock_qty_to_base, stock_explode, stock_explode_skipped,
--     _stock_outbox_apply, stock_day_sums_rebuild, sales_day_sums_rebuild, sales_day_sums_check.
--   New: stock_explode_lines (the rule line by line), _stock_explode_made, _stock_takes_share,
--     _stock_day_sums_apply, _venue_clock_requeue, stock_drainer_health, _sales_js_round,
--     _sales_js_num, _sales_check_parts (the one sales rule in SQL), _sales_day_sums_enqueue,
--     stock_co__option_org_guard and the procedure stock_day_sums_drain.
--   Triggers: three on stock_movements (day totals), two on closed_checks (sales day queue), two on
--     venue_clock (a changed clock rebuilds its days), two org guards on the option tables.
--   Cron: stock-day-sums-drain, every minute.
--   Day totals queued for the drain: stock, every venue day that holds a movement (the whole ledger,
--     so no stock day is ever a part total); sales, the days already totalled and today and the two
--     days before. After that a figure moved on a stock day older than the venue's yesterday queues
--     that day again (reason late).
--
-- THE ONLY DELIBERATE CHANGES TO WHAT A SALE TAKES OFF (map 8.1; every other stock movement, waste
-- row, outbox event and net of VAT is identical before and after, on every channel)
--   D1 Archived rows are skipped: an archived recipe still linked takes nothing; a line on an
--      archived item is left out; a line on an archived pack, or whose only bridge is archived, is
--      left out and flags unit_skipped.
--   D2 Made to order per site: the raw ingredients come off, at any depth (loops and more than 6
--      levels fall back to the made item, flagged to_order_fallback).
--   D3 Options that replace or remove an ingredient, matched on the site's own modifier id; a
--      matched modifier does not also take off its own recipe.
--   D4 Part refunds give back what the sale took per unit times the quantity refunded (by uid,
--      else the menu item's average), capped as today; a sale booked before tonight gives back by
--      today's recipe and flags refund_by_recipe. Full refunds and voids: unchanged.
--   D5 New rows in stock_sale_takes, stock_day_sums, sales_day_sums and the two queues only.
--   D6 New flags only on the new paths: takes_not_saved, to_order_fallback, refund_by_recipe,
--      refund_line_unmatched.
--   The web and edge parts of the same release (not in this file): D7 check discounts carry
--   presetId and kind (net of VAT unchanged); D8 the till never posts sale stock, stock-deplete
--   answers retired, and dish waste goes only through stock_record_waste.
--   Live tonight none of D1 to D3 has anything to act on (no archived row under a live recipe, no
--   option rule, nothing made to order), and the proof in part 5 checks it: on every live check of
--   the last 7 days the new rule must give exactly the live answer, or nothing changes.
--
-- HOW IT RUNS
--   Paste the whole file into the SQL editor and run it once. No begin or commit in here on
--   purpose. The first statement is the guard; straight after it the time limits:
--     set local lock_timeout = '3s';   (it waits at most 3 s for a busy table, then stops and
--                                       changes nothing: run it again a minute later)
--     set local statement_timeout = '120s';
--   Then the body check ('A stock function changed since this file was written. Ask Claude for a
--   new file.'), the backup, the v1 answers, the changes, the proof, and last the check row: one
--   row per venue that holds stock, every difference column 0, bodies 7 and 7, new tables 3,
--   discounts_kind true, triggers 3, 2, 2, 2, drain_job true, internals_open_to_api false,
--   repair_days_queued about the number of days that venue has stock movements on. Paste it back
--   to Claude. The two closed_checks triggers come last, so tills wait on this file for a
--   second or two at most.
--
-- THE NIGHT, IN ORDER (Claude names the exact commands; Peter runs them)
--   1. This file in the SQL editor.
--   2. Deploy stock-deplete (now answers retired) and stock-nightly (adds drainer_health).
--   3. The web release to develop, then main.
--   4. The morning after, Claude reads (read only): select public.stock_drainer_health(); and
--      stock_outbox_health per central venue, and yesterday's stock and sales day checks.
--
-- IF SOMETHING IS WRONG AFTER IT RAN
--   20261023a_OPS_stock_drainer_v2_ROLLBACK.sql (before any 0a rollback; the 0a rollback refuses
--   while this release is in). The rollback keeps discounts.kind (Peter's settings), so this file
--   can be pasted again after it: it keeps that column as it is.
--
-- Built from five parts, in order, byte for byte (each starts with a '-- == drainer part N:' line).

-- == drainer part 1: foundation ==
--
-- The guard (first statement), the time limits, the check that the 28 stock bodies this release
-- replaces or leans on are still the text it was written against, a backup of the 7 it replaces,
-- the v1 answers of the live stock rule on the last 7 days of checks (part 5 compares the new rule
-- with them before the check row), the new columns, the option rule tables, the sale takes table
-- and the company guard of the option tables. Function grants and revokes are all in part 5; the
-- table grants for the tables made here are here.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.stock_native_backup') is null
     or to_regclass('public.stock_co_items') is null
     or to_regclass('public.stock_co_item_sites') is null
     or to_regclass('public.stock_co_recipes') is null
     or to_regclass('public.stock_day_sums') is null
     or to_regclass('public.stock_day_sums_repair') is null
     or to_regclass('public.sales_day_sums') is null
     or to_regclass('public.sales_day_sums_queue') is null
     or to_regclass('public.venue_clock') is null
     or to_regprocedure('public.stock_co__venue_day(uuid,timestamptz)') is null
     or not exists (select 1 from information_schema.columns c
                     where c.table_schema = 'public' and c.table_name = 'recipes' and c.column_name = 'company_ref')
     or not exists (select 1 from information_schema.columns c
                     where c.table_schema = 'public' and c.table_name = 'item_packaging_formats' and c.column_name = 'archived_at')
     or not exists (select 1 from information_schema.columns c
                     where c.table_schema = 'public' and c.table_name = 'inventory_item_conversions' and c.column_name = 'archived_at') then
    raise exception 'Run 20261021a_OPS_stock_native_0a.sql first. Nothing was changed.';
  end if;
  -- a separate statement: stock_native_backup is read only once it is known to be there
  if (select count(distinct b.name) from public.stock_native_backup b
       where b.name in ('_stock_receive_lines', 'approve_stock_count', 'post_stock_transfer_leg', 'stock_office_reaches',
                        'stock_caller_reaches', 'stock_cost_rule', 'user_profiles_fence_guard')) <> 7 then
    raise exception 'Run 20261021a_OPS_stock_native_0a.sql first. Nothing was changed.';
  end if;
  if to_regclass('public.stock_sale_takes') is not null
     or to_regclass('public.stock_co_option_rules') is not null
     or exists (select 1 from public.stock_native_backup b where left(b.name, 11) = 'drainer_v2:')
     or exists (select 1 from pg_trigger g where not g.tgisinternal and g.tgname = 'stock_movements_day_sums_ins') then
    raise exception 'The drainer release has run already. Nothing was changed.';
  end if;
  -- discounts.kind alone is what this release's rollback keeps (Peter's settings): a paste after
  -- that rollback keeps it as it is, but only when it is exactly the column this release makes
  if exists (select 1 from information_schema.columns c
              where c.table_schema = 'public' and c.table_name = 'discounts' and c.column_name = 'kind')
     and not exists (select 1 from information_schema.columns c
                      join pg_constraint k on k.conrelid = 'public.discounts'::regclass and k.conname = 'discounts_kind_known'
                       and k.contype = 'c'
                       and replace(pg_get_constraintdef(k.oid), ' ', '') =
                           'CHECK(((kindISNULL)OR(kind=ANY(ARRAY[''staff''::text,''comp''::text,''loyalty''::text]))))'
                     where c.table_schema = 'public' and c.table_name = 'discounts' and c.column_name = 'kind'
                       and c.data_type = 'text') then
    raise exception 'discounts.kind is there but not as this release makes it (text with the check discounts_kind_known). Nothing was changed. Send this line to Claude.';
  end if;
  if to_regprocedure('cron.schedule(text,text,text)') is null or to_regprocedure('cron.unschedule(bigint)') is null then
    raise exception 'pg_cron is not there (cron.schedule). Nothing was changed.';
  end if;
  if to_regclass('public.discounts') is null or to_regclass('public.stock_outbox') is null
     or to_regprocedure('public._stock_mode_of(uuid)') is null then
    raise exception 'A table or helper this file needs is missing (discounts, stock_outbox, _stock_mode_of). Nothing was changed. Send this line to Claude.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- ============================================================================
-- THE BODIES THIS FILE REPLACES OR LEANS ON, STILL AS BUILT (read live 20 Oct 2026)
-- ============================================================================
-- The house rule: md5 of the function source with every run of white space made one space (the
-- same text the repo migrations hold, so the harness gets the same answer). The first seven are
-- replaced in parts 2, 3 and 4; the rest are only called by the new bodies.
do $bodies$
declare
  v_bad text;
begin
  select string_agg(e.name, ', ' order by e.name) into v_bad
    from (values
      ('stock_qty_to_base', 'public.stock_qty_to_base(numeric,text,uuid)', 'c052fead38aa366e8145a85790dda91c'),
      ('stock_explode', 'public.stock_explode(uuid,jsonb,text,text)', '5e27ac77aa8022d035f226f9bc8d2db9'),
      ('stock_explode_skipped', 'public.stock_explode_skipped(uuid,jsonb,text)', '1cfd825ca6f678d745552418008f6f46'),
      ('_stock_outbox_apply', 'public._stock_outbox_apply(bigint)', 'e71a501b8571b4627558b0b1541d3417'),
      ('stock_day_sums_rebuild', 'public.stock_day_sums_rebuild(uuid,date,date)', '9a7d26c203d7ce2ae2c2e18879c9f29d'),
      ('sales_day_sums_rebuild', 'public.sales_day_sums_rebuild(uuid,date,date)', '76d10f6c92e685bc5ef20e04e29de0d9'),
      ('sales_day_sums_check', 'public.sales_day_sums_check(uuid,date)', '5fb95ca9d5987700a490f98b0565eb22'),
      ('_post_stock_movement', 'public._post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)', '2974176b3ea49b90065dc0c20572e343'),
      ('_stock_post', 'public._stock_post(uuid,uuid,numeric,text,text,text,text,timestamptz,numeric,uuid,text,boolean)', '858c0e57136998f6613cde7bba42010d'),
      ('_stock_taken', 'public._stock_taken(uuid,text)', '3180631cc277fb3003c05a772b5400d5'),
      ('_stock_given_back', 'public._stock_given_back(uuid,text)', 'a7fc1b530093d9d51504396184eaf7d4'),
      ('_stock_refund_lines', 'public._stock_refund_lines(jsonb,jsonb)', '3878bfefa4e0e09ffee13e157da752de'),
      ('_stock_refund_at', 'public._stock_refund_at(uuid,text,jsonb)', 'de946a006072960781b6a8cc9e0e2df3'),
      ('stock_record_waste', 'public.stock_record_waste(uuid,jsonb,jsonb)', '7adec1618754c96e9f3d9655fcf98070'),
      ('stock_outbox_drain', 'public.stock_outbox_drain(integer,integer,numeric,boolean)', '1528946997db29d2f6c8685ca8425ec5'),
      ('_stock_outbox_on_insert', 'public._stock_outbox_on_insert()', 'e8acd544e17a4c176ae5015118f5fb80'),
      ('_stock_outbox_on_update', 'public._stock_outbox_on_update()', 'df31713b61a21394dd8225bb3079538f'),
      ('stock_js_truthy', 'public.stock_js_truthy(jsonb)', '3c65ef2a35812850480485860145722d'),
      ('stock_js_num', 'public.stock_js_num(jsonb)', '2350548e9309c22a340dc216b765c43d'),
      ('stock_js_qty', 'public.stock_js_qty(jsonb)', '72cf646903b672f80119819049810d14'),
      ('stock_js_key', 'public.stock_js_key(jsonb)', 'cdf4f77b33245549db9a5e2787e5e731'),
      ('stock_line_applies', 'public.stock_line_applies(jsonb,text,boolean)', '5b84b40043adb5d649b1e13799aef19c'),
      ('stock_norm_order_type', 'public.stock_norm_order_type(text)', '1bb362aea591604ca01108e2ad74a096'),
      ('stock_co__venue_day', 'public.stock_co__venue_day(uuid,timestamptz)', '8c9513db8ec56ddb68a1a3f247360742'),
      ('stock_co__clock_of', 'public.stock_co__clock_of(uuid)', '605fce03d4e44064df5cf3b03ecd0350'),
      ('stock_co__day_start_at', 'public.stock_co__day_start_at(date,time,text)', '2cb462264587615075225d05a84cd051'),
      ('report_day_sums', 'public.report_day_sums(text[],date,date,jsonb)', '25a8daf22bd412c1a2579807d21b223c'),
      ('_rds_num', 'public._rds_num(jsonb)', '28a3269e1d37a550643da3b08ae6daff')
    ) as e(name, sig, want)
    left join pg_proc p on p.oid = to_regprocedure(e.sig)
   where p.oid is null
      or md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) is distinct from e.want;
  if v_bad is not null then
    raise exception 'A stock function changed since this file was written. Ask Claude for a new file. Changed: %. Nothing was changed.', v_bad;
  end if;
end
$bodies$;

-- The seven bodies as they are tonight, replayable (pg_get_functiondef text), in 0a's backup table
-- under their own names (drainer_v2:<name>). The drainer rollback runs each one back and deletes
-- these seven rows. 0a's own seven rows are never touched.
insert into public.stock_native_backup (name, body, md5)
select 'drainer_v2:' || p.proname, pg_get_functiondef(p.oid), md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')))
  from (values
    ('public.stock_qty_to_base(numeric,text,uuid)'),
    ('public.stock_explode(uuid,jsonb,text,text)'),
    ('public.stock_explode_skipped(uuid,jsonb,text)'),
    ('public._stock_outbox_apply(bigint)'),
    ('public.stock_day_sums_rebuild(uuid,date,date)'),
    ('public.sales_day_sums_rebuild(uuid,date,date)'),
    ('public.sales_day_sums_check(uuid,date)')
  ) as s(sig)
  join pg_proc p on p.oid = to_regprocedure(s.sig);

do $backup_check$
begin
  if (select count(*) from public.stock_native_backup b where left(b.name, 11) = 'drainer_v2:') <> 7 then
    raise exception 'The backup of the seven stock bodies is not complete. Nothing was changed. Send this line to Claude.';
  end if;
end
$backup_check$;

-- ============================================================================
-- THE V1 ANSWERS (part 5 compares the new rule with them; dropped at commit)
-- ============================================================================
-- Over every venue of a company that holds stock (a venue with any inventory_items row): the
-- closed checks of the last 7 days, the most recent 5,000 (live about 406). A voided check counts
-- only for its refund lines. Every
-- non voided check has one _drainer_v1_skipped row (0 included), so it is also the set of checks
-- compared; every refund entry has one marker row (no item) in _drainer_v1_refund, so a refund
-- that takes nothing is compared too. One statement, one snapshot, filled BEFORE part 2 replaces
-- anything.
create temp table _drainer_v1_explode (
  location_id        uuid,
  check_id           text,
  inventory_item_id  uuid,
  qty_base           numeric
) on commit drop;
create temp table _drainer_v1_refund (
  location_id        uuid,
  check_id           text,
  refund_id          text,
  inventory_item_id  uuid,
  qty_base           numeric
) on commit drop;
create temp table _drainer_v1_skipped (
  location_id  uuid,
  check_id     text,
  skipped      integer
) on commit drop;
create temp table _drainer_v1_base (
  recipe_line_id  uuid,
  location_id     uuid,
  base            numeric
) on commit drop;

with v as (
  select l.id from public.locations l
   where l.org_id in (select l2.org_id from public.locations l2
                       where l2.org_id is not null
                         and exists (select 1 from public.inventory_items i where i.location_id = l2.id))
),
ck as materialized (
  select c.id, c.location_id::uuid as loc, c.items, c.order_type, c.refunds,
         (coalesce(c.voided, false) or coalesce(c.status, '') in ('void', 'voided')) as tomb
    from public.closed_checks c
   where c.location_id in (select v.id::text from v)
     and c.closed_at >= now() - interval '7 days'
   order by c.closed_at desc, c.id
   limit 5000
),
sk as (
  insert into _drainer_v1_skipped (location_id, check_id, skipped)
  select ck.loc, ck.id, public.stock_explode_skipped(ck.loc, ck.items, ck.order_type)
    from ck
   where not ck.tomb
  returning 1
),
ex as (
  insert into _drainer_v1_explode (location_id, check_id, inventory_item_id, qty_base)
  select ck.loc, ck.id, x.inventory_item_id, x.qty_base
    from ck
   cross join lateral public.stock_explode(ck.loc, ck.items, ck.order_type) x
   where not ck.tomb
  returning 1
)
insert into _drainer_v1_refund (location_id, check_id, refund_id, inventory_item_id, qty_base)
select ck.loc, ck.id, r.rid, x.inventory_item_id, x.qty_base
  from ck
 cross join lateral (select e.x, public.stock_js_key(e.x -> 'id') as rid
                       from jsonb_array_elements(case when jsonb_typeof(ck.refunds) = 'array' then ck.refunds else '[]'::jsonb end) as e(x)
                      where jsonb_typeof(e.x) = 'object' and public.stock_js_key(e.x -> 'id') is not null) r
 cross join lateral (select y.inventory_item_id, y.qty_base
                       from public.stock_explode(ck.loc, public._stock_refund_lines(ck.items, r.x), ck.order_type, 'refundQty') y
                     union all
                     select null::uuid, null::numeric) x;

insert into _drainer_v1_base (recipe_line_id, location_id, base)
select x.id, x.location_id, public.stock_qty_to_base(x.qty, x.unit, x.component_item_id)
  from public.recipe_lines x
 where x.location_id in (select l.id from public.locations l
                          where l.org_id in (select l2.org_id from public.locations l2
                                              where l2.org_id is not null
                                                and exists (select 1 from public.inventory_items i where i.location_id = l2.id)));

-- ============================================================================
-- NEW COLUMNS (constant or stable defaults: no table rewrite)
-- ============================================================================

-- Discount kinds (L9): what a Back Office preset is for. Null is an ordinary discount. After this
-- release's rollback the column stays (Peter's settings), so a paste after it keeps that column and
-- its check as they are (the guard made sure they are exactly these).
alter table public.discounts
  add column if not exists kind text constraint discounts_kind_known check (kind is null or kind in ('staff', 'comp', 'loyalty'));
comment on column public.discounts.kind is
  'What the preset is for (20261023a, multi site stock drainer release): staff, comp, loyalty, or null for an ordinary discount. Carried on the check discount as kind with presetId; the sales day totals put staff food, comps and loyalty rewards on their own line. The price never changes.';

-- Demo history kept apart in the stock day totals (map 8.5 markers on the movement key).
alter table public.stock_day_sums add column demo boolean not null default false;
alter table public.stock_day_sums drop constraint stock_day_sums_pkey;
alter table public.stock_day_sums
  add constraint stock_day_sums_pkey primary key (location_id, business_day, inventory_item_id, movement_type, source_type, demo);
comment on column public.stock_day_sums.demo is
  'True when the movements behind this total carry a demo key (idempotency key starting demo-v1:, demo71: or seed:). 20261023a.';

-- The two day queues get a back off (the drain retries a failing day later, never gives up).
alter table public.stock_day_sums_repair
  add column attempts integer not null default 0,
  add column due_at timestamptz not null default now(),
  add column last_error text;
create index stock_day_sums_repair_due on public.stock_day_sums_repair (due_at);
alter table public.sales_day_sums_queue
  add column attempts integer not null default 0,
  add column due_at timestamptz not null default now(),
  add column last_error text;
create index sales_day_sums_queue_due on public.sales_day_sums_queue (due_at);

-- The days the live totals would start in the middle of, rebuilt by the drain once this commits
-- (the drain claims them within a minute): every day the nightly run already totalled under the 0a
-- rules (the demo flag on stock days; net, rewards, staff, comps, loyalty and theoretical cost on
-- sales days), and today and the two venue days before it at every venue with movements or checks
-- (so tonight's day, half booked before this file, is whole).
-- Stock also queues EVERY venue day that holds a movement, the whole ledger: the trigger adds only the
-- rows that change, so a day it never held whole would stay a part total for ever (a row dated back,
-- a demo or seed file, a delete). Each day is found on the venue clock in force: the wall clock day
-- less the day start, one either side (the true venue day is always one of the three), kept only when
-- a movement falls inside that day's own start and end (one index probe per day). A few hundred rows
-- live; on a million movements at 50 venues it takes under 2 s and gives exactly the venue days of
-- stock_co__venue_day.
insert into public.stock_day_sums_repair (location_id, business_day, reason)
select x.location_id, x.business_day, 'drainer_v2'
  from (select s.location_id, s.business_day from public.stock_day_sums s
        union
        select l.id, d.business_day
          from public.locations l
         cross join lateral generate_series(now() - interval '2 days', now(), interval '1 day') as g(at)
         cross join lateral public.stock_co__venue_day(l.id, g.at) d
         where exists (select 1 from public.stock_movements m where m.location_id = l.id)
        union
        select h.location_id, h.business_day
          from (select v.location_id, v.business_day,
                       public.stock_co__day_start_at(v.business_day, v.day_start, v.timezone) as lo,
                       public.stock_co__day_start_at(v.business_day + 1, v.day_start, v.timezone) as hi
                  from (select distinct w.location_id, w.d0 + o.k as business_day, w.timezone, w.day_start
                          from (select distinct m.location_id, k.timezone, k.day_start,
                                       ((m.occurred_at at time zone k.timezone) - (k.day_start - time '00:00'))::date as d0
                                  from public.stock_movements m
                                  join (select l.id, c.timezone, c.day_start
                                          from public.locations l
                                         cross join lateral public.stock_co__clock_of(l.id) c) k on k.id = m.location_id) w
                         cross join (values (-1), (0), (1)) as o(k)) v) h
         cross join lateral (select 1 from public.stock_movements m
                              where m.location_id = h.location_id and m.occurred_at >= h.lo and m.occurred_at < h.hi
                              limit 1) e) x
 where x.business_day is not null
 order by 1, 2
on conflict (location_id, business_day) do nothing;
insert into public.sales_day_sums_queue (location_id, business_day, reason)
select x.location_id, x.business_day, 'drainer_v2'
  from (select s.location_id, s.business_day from public.sales_day_sums s
        union
        select l.id, d.business_day
          from public.locations l
         cross join lateral generate_series(now() - interval '2 days', now(), interval '1 day') as g(at)
         cross join lateral public.stock_co__venue_day(l.id, g.at) d
         where exists (select 1 from public.closed_checks c
                        where c.location_id = l.id::text and c.closed_at >= now() - interval '4 days')) x
 where x.business_day is not null
 order by 1, 2
on conflict (location_id, business_day) do nothing;

-- ============================================================================
-- NEW TABLES
-- ============================================================================

-- Company option rules: an option that replaces one ingredient of a dish with another (oat milk for
-- whole milk) or removes one (no cheese). Empty until Drop 2 fills them.
create table public.stock_co_option_rules (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references public.organisations(id) on delete cascade,
  recipe_id               uuid not null references public.stock_co_recipes(id) on delete cascade,
  kind                    text not null check (kind in ('replace', 'remove')),
  option_name             text not null check (btrim(option_name) <> ''),
  option_msm_product_id   uuid,
  option_company_item_id  uuid references public.stock_co_items(id),
  replaces_item_id        uuid references public.stock_co_items(id),
  removes_item_id         uuid references public.stock_co_items(id),
  archived_at             timestamptz,
  row_version             integer not null default 1,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  updated_by              uuid,
  constraint stock_co_option_rules_shape check (
    (kind = 'replace' and replaces_item_id is not null and option_company_item_id is not null
       and removes_item_id is null and replaces_item_id <> option_company_item_id)
    or (kind = 'remove' and removes_item_id is not null and replaces_item_id is null and option_company_item_id is null))
);
create index stock_co_option_rules_recipe on public.stock_co_option_rules (recipe_id) where archived_at is null;
create index stock_co_option_rules_org on public.stock_co_option_rules (org_id);
comment on table public.stock_co_option_rules is
  'Company option rules (20261023a, multi site stock drainer release): an option of a company dish that replaces one stock item with another or removes one. Each site matches it on its own modifier id (stock_co_option_rule_sites). Written only by definer functions (Drop 2).';

-- Each site's own modifier for a rule. site_modifier_id null means the option was not found at that
-- site: the rule does nothing there.
create table public.stock_co_option_rule_sites (
  rule_id           uuid not null references public.stock_co_option_rules(id) on delete cascade,
  org_id            uuid not null references public.organisations(id) on delete cascade,
  location_id       uuid not null references public.locations(id),
  site_modifier_id  text,
  resolved_by       text check (resolved_by is null or resolved_by in ('msm', 'master_id', 'name', 'hand')),
  row_version       integer not null default 1,
  updated_at        timestamptz not null default now(),
  primary key (rule_id, location_id)
);
create index stock_co_option_rule_sites_loc on public.stock_co_option_rule_sites (location_id, site_modifier_id)
  where site_modifier_id is not null;
comment on table public.stock_co_option_rule_sites is
  'A company option rule at one site (20261023a): the site''s own modifier id it matches on a sold line, and how it was found. Written only by definer functions (Drop 2).';

-- What each sale took, per sold line: the source of part refunds and of theoretical cost.
create table public.stock_sale_takes (
  location_id  uuid not null,
  check_id     text not null,
  order_type   text,
  occurred_at  timestamptz not null,
  lines        jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  primary key (location_id, check_id)
);
create index stock_sale_takes_loc_time on public.stock_sale_takes (location_id, occurred_at);
comment on table public.stock_sale_takes is
  'What each sale took off, per sold line (20261023a): lines = [{n: line number in closed_checks.items, u: uid, m: menu item id, q: quantity taken for, t: [{i: stock item, b: base quantity per one unit}], c: theoretical cost}]. Written once by the drainer (_stock_outbox_apply), never updated. Part refunds give back from it; the sales day totals read c. Owner and definer functions only.';

alter table public.stock_co_option_rules enable row level security;
alter table public.stock_co_option_rule_sites enable row level security;
alter table public.stock_sale_takes enable row level security;
revoke all on table public.stock_co_option_rules from public, anon, authenticated, service_role;
revoke all on table public.stock_co_option_rule_sites from public, anon, authenticated, service_role;
revoke all on table public.stock_sale_takes from public, anon, authenticated, service_role;
grant select on table public.stock_co_option_rules to authenticated, service_role;
grant select on table public.stock_co_option_rule_sites to authenticated, service_role;
grant select on table public.stock_sale_takes to service_role;

-- Company rows by company, site rows by site (the 0a read rules). No write policy: definer only.
create policy stock_co_option_rules_read on public.stock_co_option_rules as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));
create policy stock_co_option_rule_sites_read on public.stock_co_option_rule_sites as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));

-- The second sign in step, as on every other table (20260919s). Skipped when that file has not run.
do $fence_options$
begin
  if to_regprocedure('public.second_step_ok()') is not null then
    create policy second_step_fence on public.stock_co_option_rules as restrictive for all to authenticated
      using ((select public.second_step_ok())) with check ((select public.second_step_ok()));
    create policy second_step_fence on public.stock_co_option_rule_sites as restrictive for all to authenticated
      using ((select public.second_step_ok())) with check ((select public.second_step_ok()));
  end if;
end
$fence_options$;

-- ============================================================================
-- THE COMPANY GUARD OF THE OPTION TABLES (the stock_co__org_guard pattern)
-- ============================================================================
-- A rule's dish and items are of its own company; a rule's site row is a site of that company and
-- of the rule's company. A record never moves to another company. Unchanged keys are not checked
-- again on an update.
create or replace function public.stock_co__option_org_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if tg_op = 'UPDATE' then
    if new.org_id is distinct from old.org_id then
      raise exception 'That stock record cannot move to another company.' using errcode = '22023';
    end if;
  end if;

  if tg_table_name = 'stock_co_option_rules' then
    if tg_op = 'UPDATE' then
      if new.recipe_id = old.recipe_id
         and new.option_company_item_id is not distinct from old.option_company_item_id
         and new.replaces_item_id is not distinct from old.replaces_item_id
         and new.removes_item_id is not distinct from old.removes_item_id then
        return new;
      end if;
    end if;
    if not exists (select 1 from stock_co_recipes r where r.id = new.recipe_id and r.org_id = new.org_id) then
      raise exception 'That recipe is not in this company.' using errcode = '22023';
    end if;
    if (new.option_company_item_id is not null
        and not exists (select 1 from stock_co_items i where i.id = new.option_company_item_id and i.org_id = new.org_id))
       or (new.replaces_item_id is not null
        and not exists (select 1 from stock_co_items i where i.id = new.replaces_item_id and i.org_id = new.org_id))
       or (new.removes_item_id is not null
        and not exists (select 1 from stock_co_items i where i.id = new.removes_item_id and i.org_id = new.org_id)) then
      raise exception 'That stock item is not in this company.' using errcode = '22023';
    end if;

  elsif tg_table_name = 'stock_co_option_rule_sites' then
    if tg_op = 'UPDATE' then
      if new.rule_id = old.rule_id and new.location_id = old.location_id then
        return new;
      end if;
    end if;
    if not exists (select 1 from stock_co_option_rules ru where ru.id = new.rule_id and ru.org_id = new.org_id)
       or not exists (select 1 from locations l where l.id = new.location_id and l.org_id = new.org_id) then
      raise exception 'That site is not in this company.' using errcode = '22023';
    end if;
  end if;
  return new;
end
$fn$;

create trigger stock_co_option_org_guard before insert or update on public.stock_co_option_rules
  for each row execute function public.stock_co__option_org_guard();
create trigger stock_co_option_org_guard before insert or update on public.stock_co_option_rule_sites
  for each row execute function public.stock_co__option_org_guard();
-- == drainer part 2: the one stock rule ==
--
-- stock_qty_to_base v2 (archived packs and bridges are not used), the rule line by line
-- (stock_explode_lines, with the made to order helper _stock_explode_made), stock_explode v2 and
-- stock_explode_skipped v2 on top of it, the refund share (_stock_takes_share) and the drainer
-- (_stock_outbox_apply v2). Each replaced body starts from its live text (saved in part 1) and
-- changes only what map 8.1 says. No grants here: part 5 owns every function grant and revoke.
--
-- What may now differ from the live rule (map 8.1, all dormant on live data tonight):
--   D1 an archived recipe still linked takes nothing; a line on an archived item is left out; a line
--      on an archived pack, or whose only bridge is archived, is left out and flags unit_skipped;
--   D2 an item a site makes to order (stock_co_item_sites.supply_mode 'to_order') is taken off as
--      its own recipe's raw ingredients, at any depth;
--   D3 options that replace or remove an ingredient, matched on the site's own modifier id;
--   D4 a part refund gives back the sale's own per unit takes times the quantity refunded.

-- ---------------------------------------------------------------------------------------------
-- stock_qty_to_base v2: the live body with two changes only: the "@" pack lookup leaves out an
-- archived pack, and the bridge set leaves out archived bridges. Same NULL answers, same 6 hop
-- walk, same order.
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_qty_to_base(p_qty numeric, p_unit text, p_item uuid)
returns numeric
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  f text := lower(btrim(coalesce(p_unit, '')));
  t text;
  v numeric;
begin
  if p_qty is null then return null; end if;
  if p_unit like '@%' then
    select pf.qty_in_base into v from item_packaging_formats pf
     where pf.inventory_item_id = p_item and pf.id::text = substr(p_unit, 2) and pf.archived_at is null;
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
            and btrim(coalesce(c.from_unit, '')) <> '' and btrim(coalesce(c.to_unit, '')) <> ''
            and c.archived_at is null),
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
end $function$;

-- ---------------------------------------------------------------------------------------------
-- _stock_explode_made: made to order (R9). p_qty_base base units of p_item, an item the site makes
-- to order, become its own recipe's ingredients: the live recipe at the site that outputs it (batch
-- and prep recipes first, then the newest, then by id: the stock_co__made_cost pick), scaled by
-- p_qty_base over the recipe's yield in base units. Each line goes through the same rule as a dish
-- line (order type with the recipe's own drive thru tag, usable share, a live item at the site,
-- base units), and again for an ingredient that is itself made to order. p_path holds the items
-- already being made above this one. On a loop, below 6 levels, with no live recipe, or a yield
-- that is not above 0, the made item itself is taken (today's behaviour) and a note row is added.
-- Rows: (item, qty) for what is taken, (null, null, note) for every note.
-- ---------------------------------------------------------------------------------------------
create or replace function public._stock_explode_made(p_loc uuid, p_item uuid, p_qty_base numeric, p_order_type text, p_path uuid[])
returns table (inventory_item_id uuid, qty_base numeric, note text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
#variable_conflict use_column
declare
  v_path  uuid[] := coalesce(p_path, '{}'::uuid[]);
  v_base  text;
  v_r     record;
  v_y     numeric;
  v_f     numeric;
  v_dt    boolean;
  v_b     numeric;
  v_c     numeric;
  x       record;
begin
  if p_item = any(v_path) then
    return query select p_item, p_qty_base, null::text union all select null::uuid, null::numeric, 'loop'::text;
    return;
  end if;
  if cardinality(v_path) >= 6 then
    return query select p_item, p_qty_base, null::text union all select null::uuid, null::numeric, 'depth'::text;
    return;
  end if;
  select i.base_unit into v_base from inventory_items i where i.id = p_item and i.location_id = p_loc;
  select r.id, r.yield_qty, r.yield_unit into v_r
    from recipes r
   where r.location_id = p_loc and r.output_item_id = p_item and r.archived_at is null
   order by (r.recipe_type in ('BATCH', 'PREP')) desc, r.updated_at desc, r.id
   limit 1;
  if v_r.id is null then
    return query select p_item, p_qty_base, null::text union all select null::uuid, null::numeric, 'no_recipe'::text;
    return;
  end if;
  v_y := public.stock_qty_to_base(coalesce(v_r.yield_qty, 1), coalesce(nullif(v_r.yield_unit, ''), v_base), p_item);
  if v_y is null or v_y <= 0 then
    return query select p_item, p_qty_base, null::text union all select null::uuid, null::numeric, 'yield'::text;
    return;
  end if;
  v_f := p_qty_base / v_y;
  v_dt := exists (select 1 from recipe_lines y where y.recipe_id = v_r.id and y.location_id = p_loc
                   and jsonb_typeof(y.order_types) = 'array' and y.order_types ? 'drive-thru');
  for x in
    select rl.component_item_id as comp, rl.qty, rl.unit, coalesce(rl.usable_pct, 100) as usable
      from recipe_lines rl
     where rl.recipe_id = v_r.id and rl.location_id = p_loc
       and coalesce(rl.usable_pct, 100) > 0
       and public.stock_line_applies(rl.order_types, public.stock_norm_order_type(p_order_type), v_dt)
       and exists (select 1 from inventory_items i where i.id = rl.component_item_id and i.location_id = p_loc and i.archived_at is null)
     order by rl.sort_order, rl.id
  loop
    v_b := public.stock_qty_to_base(x.qty, x.unit, x.comp);
    if v_b is null then
      inventory_item_id := null;
      qty_base := null;
      note := 'unit';
      return next;
      continue;
    end if;
    v_c := (v_b / (x.usable / 100.0)) * v_f;
    if exists (select 1 from stock_co_item_sites si
                where si.site_item_id = x.comp and si.location_id = p_loc and si.supply_mode = 'to_order') then
      return query select z.inventory_item_id, z.qty_base, z.note
                     from public._stock_explode_made(p_loc, x.comp, v_c, p_order_type, v_path || p_item) z;
    else
      inventory_item_id := x.comp;
      qty_base := v_c;
      note := null;
      return next;
    end if;
  end loop;
  return;
end
$fn$;

-- ---------------------------------------------------------------------------------------------
-- stock_explode_lines: the one stock rule, line by line (contract R1 to R10).
-- One row per (sold line, stock item) with the base quantity per one unit of the line
-- (unit_qty_base) and for the line (qty_base = unit_qty_base x line_qty), plus one note row (no
-- item) per recipe line left out on a unit ('unit', 'replace_unit') or made to order fallen back
-- ('loop', 'depth', 'no_recipe', 'yield'). With nothing archived, no option rule and nothing made
-- to order, the per item sum of qty_base is the live stock_explode figure to the last digit: the
-- only division, b / (usable / 100.0), has the same inputs, and numeric multiplication and
-- addition are exact.
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_explode_lines(p_loc uuid, p_lines jsonb, p_order_type text, p_qty_key text default 'qty')
returns table (line_no integer, line_uid text, menu_item_id text, line_qty numeric, inventory_item_id uuid,
               unit_qty_base numeric, qty_base numeric, note text)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with line as (
    -- R1: every element, numbered over all of them; voided lines out unless a refund is read
    select o.n::integer as n,
           public.stock_js_key(o.l -> 'uid') as uid,
           coalesce(public.stock_js_key(o.l -> 'itemId'), public.stock_js_key(o.l -> 'id')) as mid,
           case when p_qty_key = 'refundQty'
                then coalesce(nullif(public.stock_js_num(o.l -> 'refundQty'), 0), public.stock_js_num(o.l -> 'qty'))
                else public.stock_js_qty(o.l -> 'qty') end as q,
           case when jsonb_typeof(o.l -> 'mods') = 'array' then o.l -> 'mods' else '[]'::jsonb end as mods
      from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) with ordinality as o(l, n)
     where jsonb_typeof(o.l) = 'object'
       and (p_qty_key = 'refundQty' or not public.stock_js_truthy(o.l -> 'voided'))
  ),
  sold as (
    select ln.n, ln.uid, ln.mid, ln.q, ln.mods from line ln where ln.mid is not null and ln.q > 0
  ),
  -- R6: the option rules of each sold line's own dish that one of its modifiers matched, with the
  -- site items they hit and bring (a site item counts only when it is live at this site)
  rules as (
    select sl.n, rc.id as recipe_id, ru.id as rule_id, ru.kind, rs.site_modifier_id,
           (select si.site_item_id
              from stock_co_item_sites si
              join inventory_items ii on ii.id = si.site_item_id and ii.location_id = p_loc and ii.archived_at is null
             where si.location_id = p_loc
               and si.item_id = case when ru.kind = 'remove' then ru.removes_item_id else ru.replaces_item_id end) as hit_item,
           (select si.site_item_id
              from stock_co_item_sites si
              join inventory_items ii on ii.id = si.site_item_id and ii.location_id = p_loc and ii.archived_at is null
             where si.location_id = p_loc and si.item_id = ru.option_company_item_id) as with_item
      from sold sl
      join menu_item_recipes r on r.location_id = p_loc and r.menu_item_id = sl.mid
      join recipes rc on rc.id = r.recipe_id and rc.location_id = p_loc and rc.archived_at is null
      join stock_co_option_rules ru on ru.recipe_id = rc.company_ref and ru.archived_at is null
      join stock_co_option_rule_sites rs on rs.rule_id = ru.id and rs.location_id = p_loc and rs.site_modifier_id is not null
     where exists (select 1 from jsonb_array_elements(sl.mods) md
                    where jsonb_typeof(md) = 'object' and not public.stock_js_truthy(md -> 'removed')
                      and coalesce(public.stock_js_key(md -> 'itemId'), public.stock_js_key(md -> 'id')) = rs.site_modifier_id)
  ),
  -- R2: sold units: the line itself, and each modifier as a unit of its own menu id per one unit of
  -- the line (a modifier that matched an option rule of its line does not also take its own recipe)
  units as (
    select sl.n, sl.uid, sl.mid as line_mid, sl.q, sl.mid as unit_mid, 1::numeric as uq, true as own
      from sold sl
    union all
    select sl.n, sl.uid, sl.mid, sl.q, public.stock_js_key(md -> 'itemId'), public.stock_js_qty(md -> 'qty'), false
      from sold sl
     cross join lateral jsonb_array_elements(sl.mods) md
     where jsonb_typeof(md) = 'object'
       and public.stock_js_truthy(md -> 'itemId')
       and not public.stock_js_truthy(md -> '_instruction')
       and not public.stock_js_truthy(md -> 'removed')
       and public.stock_js_key(md -> 'itemId') is not null
       and public.stock_js_qty(md -> 'qty') > 0
       and not exists (select 1 from rules ru
                        where ru.n = sl.n
                          and ru.site_modifier_id = coalesce(public.stock_js_key(md -> 'itemId'), public.stock_js_key(md -> 'id')))
  ),
  -- R3 and R4: each unit's live recipes at this site and their lines that apply to the order type
  rl as (
    select u.n, u.uid, u.line_mid, u.q, u.own, u.uq * coalesce(nullif(r.portion, 0), 1) as mult,
           rc.id as recipe_id, x.component_item_id as comp, x.qty, x.unit, coalesce(x.usable_pct, 100) as usable
      from units u
      join menu_item_recipes r on r.location_id = p_loc and r.menu_item_id = u.unit_mid
      join recipes rc on rc.id = r.recipe_id and rc.location_id = p_loc and rc.archived_at is null
      join recipe_lines x on x.recipe_id = r.recipe_id and x.location_id = p_loc
     where coalesce(x.usable_pct, 100) > 0
       and public.stock_line_applies(x.order_types, public.stock_norm_order_type(p_order_type),
             exists (select 1 from recipe_lines y where y.recipe_id = x.recipe_id and y.location_id = p_loc
                      and jsonb_typeof(y.order_types) = 'array' and y.order_types ? 'drive-thru'))
  ),
  -- R6: the rule that wins on each line of the dish (remove over replace, then the lowest rule id)
  opt as (
    select rl.n, rl.uid, rl.line_mid, rl.q, rl.mult, rl.comp, rl.qty, rl.unit, rl.usable, w.kind as rule_kind, w.with_item
      from rl
      left join lateral (select ru.kind, ru.with_item
                           from rules ru
                          where rl.own and ru.n = rl.n and ru.recipe_id = rl.recipe_id and ru.hit_item = rl.comp
                          order by (ru.kind = 'remove') desc, ru.rule_id
                          limit 1) w on true
  ),
  -- R5 and R7: base quantity per recipe line (a remove takes nothing and is not noted)
  conv as (
    select o.n, o.uid, o.line_mid, o.q, o.mult, o.usable, o.comp as item,
           public.stock_qty_to_base(o.qty, o.unit, o.comp) as b, 'unit'::text as miss
      from opt o
     where o.rule_kind is null
       and exists (select 1 from inventory_items i where i.id = o.comp and i.location_id = p_loc and i.archived_at is null)
    union all
    select o.n, o.uid, o.line_mid, o.q, o.mult, o.usable, o.with_item,
           case when o.with_item is not null
                then public.stock_qty_to_base(public.stock_qty_to_base(o.qty, o.unit, o.comp), i.base_unit, o.with_item) end,
           'replace_unit'::text
      from opt o
      join inventory_items i on i.id = o.comp
     where o.rule_kind = 'replace'
  ),
  -- R8: per one unit of the line, exactly this expression order
  contrib as (
    select cv.n, cv.uid, cv.line_mid, cv.q, cv.item, (cv.b / (cv.usable / 100.0)) * cv.mult as cq
      from conv cv
     where cv.b is not null
  ),
  -- R9: made to order at this site becomes its own recipe's ingredients
  outrows as (
    select k.n, k.uid, k.line_mid, k.q, k.item, k.cq, null::text as note
      from contrib k
     where not exists (select 1 from stock_co_item_sites si
                        where si.site_item_id = k.item and si.location_id = p_loc and si.supply_mode = 'to_order')
    union all
    select k.n, k.uid, k.line_mid, k.q, z.inventory_item_id, z.qty_base, z.note
      from contrib k
     cross join lateral public._stock_explode_made(p_loc, k.item, k.cq, p_order_type, '{}'::uuid[]) z
     where exists (select 1 from stock_co_item_sites si
                    where si.site_item_id = k.item and si.location_id = p_loc and si.supply_mode = 'to_order')
    union all
    select cv.n, cv.uid, cv.line_mid, cv.q, null::uuid, null::numeric, cv.miss
      from conv cv
     where cv.b is null
  )
  -- R10: one row per (line, item), no per line filter; and the note rows
  select ot.n, ot.uid, ot.line_mid, ot.q, ot.item, sum(ot.cq), sum(ot.cq) * ot.q, null::text
    from outrows ot
   where ot.item is not null
   group by ot.n, ot.uid, ot.line_mid, ot.q, ot.item
  union all
  select ot.n, ot.uid, ot.line_mid, ot.q, null::uuid, null::numeric, null::numeric, ot.note
    from outrows ot
   where ot.item is null and ot.note is not null;
$fn$;

-- ---------------------------------------------------------------------------------------------
-- stock_explode v2: the per item total of the rule. Same signature, same columns, same callers
-- (the drainer's sale, tomb and fallback refund; stock_record_waste for dish waste).
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_explode(p_loc uuid, p_lines jsonb, p_order_type text, p_qty_key text default 'qty'::text)
returns table (inventory_item_id uuid, qty_base numeric)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select x.inventory_item_id, sum(x.qty_base)
    from public.stock_explode_lines(p_loc, p_lines, p_order_type, p_qty_key) x
   where x.inventory_item_id is not null
   group by x.inventory_item_id
  having sum(x.qty_base) > 0;
$function$;

-- ---------------------------------------------------------------------------------------------
-- stock_explode_skipped v2: the live body (the distinct set of sold menu ids, the order type with no
-- drive thru tag, any recipe line whose base quantity is null) with only these changes: archived
-- recipes are left out; a line whose item is archived is left out (D1); on a sold line with option
-- rules, a removed line is not counted and a replaced one only when its replacement cannot be
-- worked out (D3); a made to order sub recipe line whose base quantity is null is counted (D2).
-- A recipe line counts once when it is skipped on any sold line that uses it.
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_explode_skipped(p_loc uuid, p_lines jsonb, p_order_type text)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $function$
  with line as (
    select o.n::integer as n,
           coalesce(public.stock_js_key(o.l -> 'itemId'), public.stock_js_key(o.l -> 'id')) mid,
           case when jsonb_typeof(o.l -> 'mods') = 'array' then o.l -> 'mods' else '[]'::jsonb end mods
      from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) with ordinality as o(l, n)
     where jsonb_typeof(o.l) = 'object' and not public.stock_js_truthy(o.l -> 'voided')
  ),
  by_mod as (
    select distinct public.stock_js_key(md -> 'itemId') as mid
      from line, jsonb_array_elements(line.mods) md
     where line.mid is not null and jsonb_typeof(md) = 'object' and public.stock_js_truthy(md -> 'itemId')
       and not public.stock_js_truthy(md -> '_instruction') and not public.stock_js_truthy(md -> 'removed')
  ),
  sold as (
    select mid from line where mid is not null
    union select by_mod.mid from by_mod
  ),
  cand as (
    select s.mid, r.id as link_id, x.id as line_id, x.component_item_id as comp, rc.id as recipe_id,
           public.stock_qty_to_base(x.qty, x.unit, x.component_item_id) as b
      from sold s
      join menu_item_recipes r on r.location_id = p_loc and r.menu_item_id = s.mid
      join recipes rc on rc.id = r.recipe_id and rc.location_id = p_loc and rc.archived_at is null
      join recipe_lines x on x.recipe_id = r.recipe_id and x.location_id = p_loc
     where coalesce(x.usable_pct, 100) > 0
       and public.stock_line_applies(x.order_types, public.stock_norm_order_type(p_order_type), false)
       and not exists (select 1 from inventory_items i where i.id = x.component_item_id and i.archived_at is not null)
  ),
  rules as (
    select line.n, rc.id as recipe_id, ru.id as rule_id, ru.kind,
           (select si.site_item_id
              from stock_co_item_sites si
              join inventory_items ii on ii.id = si.site_item_id and ii.location_id = p_loc and ii.archived_at is null
             where si.location_id = p_loc
               and si.item_id = case when ru.kind = 'remove' then ru.removes_item_id else ru.replaces_item_id end) as hit_item,
           (select si.site_item_id
              from stock_co_item_sites si
              join inventory_items ii on ii.id = si.site_item_id and ii.location_id = p_loc and ii.archived_at is null
             where si.location_id = p_loc and si.item_id = ru.option_company_item_id) as with_item
      from line
      join menu_item_recipes r on r.location_id = p_loc and r.menu_item_id = line.mid
      join recipes rc on rc.id = r.recipe_id and rc.location_id = p_loc and rc.archived_at is null
      join stock_co_option_rules ru on ru.recipe_id = rc.company_ref and ru.archived_at is null
      join stock_co_option_rule_sites rs on rs.rule_id = ru.id and rs.location_id = p_loc and rs.site_modifier_id is not null
     where line.mid is not null
       and exists (select 1 from jsonb_array_elements(line.mods) md
                    where jsonb_typeof(md) = 'object' and not public.stock_js_truthy(md -> 'removed')
                      and coalesce(public.stock_js_key(md -> 'itemId'), public.stock_js_key(md -> 'id')) = rs.site_modifier_id)
  ),
  ctx as (
    -- each line that sells the menu id itself, with the rule that wins on this recipe line there
    select c.link_id, c.line_id, c.mid, w.kind as rule_kind, w.with_item
      from cand c
      join line on line.mid = c.mid
      left join lateral (select ru.kind, ru.with_item
                           from rules ru
                          where ru.n = line.n and ru.recipe_id = c.recipe_id and ru.hit_item = c.comp
                          order by (ru.kind = 'remove') desc, ru.rule_id
                          limit 1) w on true
  )
  select (select count(*)::integer
            from cand c
           where (c.b is null and c.mid in (select by_mod.mid from by_mod))
              or exists (select 1 from ctx t
                          where t.link_id = c.link_id and t.line_id = c.line_id and t.mid = c.mid
                            and ((t.rule_kind is null and c.b is null)
                                 or (t.rule_kind = 'replace'
                                     and (t.with_item is null
                                          or public.stock_qty_to_base(c.b, (select i.base_unit from inventory_items i where i.id = c.comp),
                                                                      t.with_item) is null)))))
       + (select count(*)::integer
            from cand c
           cross join lateral public._stock_explode_made(p_loc, c.comp, 1, p_order_type, '{}'::uuid[]) z
           where c.b is not null and z.note = 'unit'
             and exists (select 1 from stock_co_item_sites si
                          where si.site_item_id = c.comp and si.location_id = p_loc and si.supply_mode = 'to_order'));
$function$;

-- ---------------------------------------------------------------------------------------------
-- _stock_takes_share: refund lines shared over what the sale took (D4). Never reads today's recipe.
-- p_takes is a stock_sale_takes.lines array; p_refund_lines are refund lines as _stock_refund_lines
-- gives them. A refund line comes off the sold line with its uid (M1), else off every sold line of
-- its menu item in proportion to their quantities (M2), else nothing (M3: a row with no line and no
-- item, which the drainer flags refund_line_unmatched). Per sold line the refunded quantity is
-- capped at what the sale took for it. Rows: (line, item, base quantity, refunded quantity of the
-- line); a matched line that took no stock gives one row with no item.
-- ---------------------------------------------------------------------------------------------
create or replace function public._stock_takes_share(p_takes jsonb, p_refund_lines jsonb)
returns table (line_no integer, inventory_item_id uuid, qty_base numeric, refund_qty numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with tk as materialized (
    select (t.v ->> 'n')::integer as n,
           public.stock_js_key(t.v -> 'u') as u,
           public.stock_js_key(t.v -> 'm') as m,
           public.stock_js_num(t.v -> 'q') as q,
           case when jsonb_typeof(t.v -> 't') = 'array' then t.v -> 't' else '[]'::jsonb end as tt
      from jsonb_array_elements(case when jsonb_typeof(p_takes) = 'array' then p_takes else '[]'::jsonb end) as t(v)
     where jsonb_typeof(t.v) = 'object' and jsonb_typeof(t.v -> 'n') = 'number'
  ),
  rf as materialized (
    select o.k,
           coalesce(nullif(public.stock_js_num(o.x -> 'refundQty'), 0), public.stock_js_num(o.x -> 'qty')) as r,
           public.stock_js_key(o.x -> 'uid') as uid,
           coalesce(public.stock_js_key(o.x -> 'itemId'), public.stock_js_key(o.x -> 'id')) as mid
      from jsonb_array_elements(case when jsonb_typeof(p_refund_lines) = 'array' then p_refund_lines else '[]'::jsonb end)
           with ordinality as o(x, k)
     where jsonb_typeof(o.x) = 'object'
  ),
  rql as (
    select rf.k, rf.r, rf.uid, rf.mid,
           (select min(tk.n) from tk where rf.uid is not null and tk.u = rf.uid) as by_uid
      from rf
     where rf.r > 0
  ),
  alloc as (
    -- M1: the sold line with that uid
    select rql.k, rql.by_uid as n, least(rql.r, tk.q) as a
      from rql
      join tk on tk.n = rql.by_uid
    union all
    -- M2: every sold line of that menu item, in proportion to its quantity
    select rql.k, tk.n, least(rql.r, s.qq) * tk.q / s.qq
      from rql
      join lateral (select sum(t2.q) as qq from tk t2 where t2.m = rql.mid and t2.q > 0) s on s.qq > 0
      join tk on tk.m = rql.mid and tk.q > 0
     where rql.by_uid is null
  ),
  per_line as (
    select a.n, least(sum(a.a), max(tk.q)) as rq
      from alloc a
      join tk on tk.n = a.n
     group by a.n
  )
  select pl.n, (e ->> 'i')::uuid, sum(public.stock_js_num(e -> 'b') * pl.rq), pl.rq
    from per_line pl
    join tk on tk.n = pl.n
   cross join lateral jsonb_array_elements(tk.tt) e
   where jsonb_typeof(e) = 'object' and public.stock_js_key(e -> 'i') is not null
   group by pl.n, (e ->> 'i')::uuid, pl.rq
  union all
  select pl.n, null::uuid, null::numeric, pl.rq
    from per_line pl
    join tk on tk.n = pl.n
   where not exists (select 1 from jsonb_array_elements(tk.tt) e
                      where jsonb_typeof(e) = 'object' and public.stock_js_key(e -> 'i') is not null)
  union all
  select null::integer, null::uuid, null::numeric, rql.r
    from rql
   where not exists (select 1 from alloc a where a.k = rql.k);
$fn$;

-- ---------------------------------------------------------------------------------------------
-- _stock_outbox_apply v2: the live body word for word except:
--   A. the sale explodes once, line by line (stock_explode_lines); a catering sale dated ahead
--      nets its earlier part refunds through _stock_takes_share; to_order_fallback is flagged; and
--      after the posts the sale's takes are saved (stock_sale_takes) and its sales day queued, each
--      in its own exception block, so a problem there never undoes the sale (takes_not_saved);
--   C. a part refund with lines gives back the sale's own takes (_stock_takes_share) when the sale
--      saved them, else today's recipe as before (refund_by_recipe); refund_line_unmatched when a
--      refund line matched no sold line.
-- Everything else (writer checks, waits, held and dead rules, the tomb, full refunds and voids,
-- undo, keys, values, occurred_at, the late count guard) is unchanged.
-- ---------------------------------------------------------------------------------------------
create or replace function public._stock_outbox_apply(p_id bigint)
returns text
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  e   stock_outbox%rowtype;
  s   stock_outbox%rowtype;
  c   closed_checks%rowtype;
  v_ot text;
  v_n integer := 0;
  v_flags text[] := '{}';
  m record;
  v_lines jsonb;
  v_rid text;
  v_entry jsonb;
  v_q numeric;
  v_full boolean := false;
  v_reason text;
  v_xid text;
  v_wait timestamptz;
  v_has_sale boolean := false;
  v_booked boolean;
  v_since timestamptz;
  v_ahead boolean := false;
  v_netted text[] := '{}';
  v_skip boolean := false;
  v_ex jsonb := '[]'::jsonb;
  v_tk jsonb;
  v_nl jsonb := '[]'::jsonb;
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
  -- person released: trusted. A refund, void or undo the sweep found: trusted, because it can
  -- only give back what a booked sale took (the waits below never run it before a trusted sale).
  -- Anyone else (an unbound session): only a public order whose payment proof (paid token, or a
  -- payment_proofs row bound to the ref) was written in the SAME transaction as the check, once
  -- per ref. A copy forged with the public key, before or after the real order, never matches.
  if e.writer not in ('device', 'service', 'db', 'fenced_update', 'released')
     and not (e.writer = 'swept' and e.kind in ('refund', 'void', 'undo')) then
    v_xid := (e.xact::text::bigint % 4294967296)::text;
    if e.kind in ('sale', 'tomb') and c.ref is not null
       and (exists (select 1 from public_order_tokens t where t.location_id = e.location_id::text and t.ref = c.ref and t.paid
                       and t.xmin::text = v_xid)
            or exists (select 1 from payment_proofs p where p.location_id = e.location_id::text and p.used_by_ref = e.location_id::text || ':' || c.ref
                          and p.xmin::text = v_xid)) then
      begin
        update stock_outbox set proof = e.location_id::text || ':' || c.ref where id = p_id;
      exception when unique_violation then
        update stock_outbox set status = 'held', flags = array_append(flags, 'proof_used'), attempts = attempts + 1,
               last_error = 'another check already used the payment proof for ref ' || c.ref where id = p_id;
        return 'held';
      end;
    else
      update stock_outbox set status = 'held', flags = array_append(flags, 'unproven'), attempts = attempts + 1,
             last_error = 'written by a session that cannot open this venue and no payment proof from the same transaction' where id = p_id;
      return 'held';
    end if;
  end if;

  -- A refund, void or undo runs after its own sale, in event order per check.
  if e.kind in ('refund', 'void', 'undo') then
    -- (a) an earlier event of this check, or its sale, still pending (a retry in backoff, a
    --     catering sale dated ahead): wait until just after it is due
    select max(o.due_at) into v_wait from stock_outbox o
     where o.location_id = e.location_id and o.check_id = e.check_id and o.id <> e.id and o.status = 'pending'
       and (o.id < e.id or o.kind = 'sale');
    if v_wait is not null then
      update stock_outbox set due_at = greatest(now() + interval '5 seconds', v_wait + interval '1 second') where id = p_id;
      return 'waiting';
    end if;
    select * into s from stock_outbox o where o.location_id = e.location_id and o.check_id = e.check_id and o.kind = 'sale';
    v_has_sale := found;
    v_booked := exists (select 1 from stock_movements mv where mv.location_id = e.location_id and mv.source_id = c.id
                         and mv.source_type = 'closed_check' and mv.idempotency_key like 'sale:%');
    -- (b) the sale is held or dead and took nothing yet: held with it; releasing the sale sends this on
    if v_has_sale and s.status in ('held', 'dead') and not v_booked then
      update stock_outbox set status = 'held', flags = array_append(flags, 'sale_not_booked'), attempts = attempts + 1,
             last_error = 'waits for the sale of this check, which is ' || s.status || '; releasing the sale sends this on' where id = p_id;
      return 'held';
    end if;
    -- (c) no sale event at all for a check closed after the switch, in the sweep's window: the
    --     enqueue was lost; wait for the hourly sweep to find the sale (up to 2 hours, then the
    --     ledger decides as for a check the till booked)
    if not v_has_sale and not v_booked
       and not exists (select 1 from stock_outbox o where o.location_id = e.location_id and o.check_id = e.check_id and o.kind = 'tomb') then
      select md.central_since into v_since from stock_depletion_mode md where md.location_id = e.location_id;
      if c.closed_at >= greatest(coalesce(v_since, '-infinity'::timestamptz), now() - interval '47 hours')
         and e.created_at > now() - interval '2 hours' then
        update stock_outbox set due_at = now() + interval '10 minutes',
               flags = case when 'sale_missing' = any(flags) then flags else array_append(flags, 'sale_missing') end
         where id = p_id;
        return 'waiting';
      end if;
    end if;
    -- (d) a catering sale dated ahead already netted this refund or void (it came before the
    --     event, nothing was made): nothing to book here. Its undo cannot take back what was never
    --     taken: a person books the stock by hand.
    if v_has_sale and e.kind = 'refund' and ('netted:' || e.event_ref) = any(s.flags) then
      v_flags := array_append(v_flags, 'before_made');
      v_skip := true;
    elsif v_has_sale and e.kind = 'void' and 'cancelled_before_made' = any(s.flags) then
      v_flags := array_append(v_flags, 'before_made');
      v_skip := true;
    elsif v_has_sale and e.kind = 'undo' and ('netted:' || e.event_ref) = any(s.flags) then
      update stock_outbox set status = 'held', flags = array_append(flags, 'netted_refund_failed'), attempts = attempts + 1,
             last_error = 'the order was refunded before its event, so its stock was never taken; then the refund was refused. Take the stock off by hand.'
       where id = p_id;
      return 'held';
    end if;
  end if;

  v_ot := c.order_type;

  if v_skip then
    null;

  elsif e.kind = 'sale' then
    -- A catering order dated ahead posts at its event time. A void or a full refund made before
    -- then cancels it (nothing was made); part refunds made before then come off the sale.
    v_ahead := e.occurred_at > e.created_at + interval '10 minutes';
    if v_ahead then
      select coalesce(array_agg('netted:' || (x ->> 'id') order by x ->> 'id'), '{}') into v_netted
        from jsonb_array_elements(case when jsonb_typeof(c.refunds) = 'array' then c.refunds else '[]'::jsonb end) x
       where public.stock_js_key(x -> 'id') is not null and not public._stock_refund_failed(x)
         and public._stock_refund_at(e.location_id, c.id, x) < e.occurred_at;
      if ((coalesce(c.voided, false) or coalesce(c.status, '') in ('void', 'voided'))
          and exists (select 1 from stock_outbox o where o.location_id = e.location_id and o.check_id = e.check_id
                         and o.kind = 'void' and o.occurred_at < e.occurred_at))
         or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(c.refunds) = 'array' then c.refunds else '[]'::jsonb end) x
                     where ('netted:' || (x ->> 'id')) = any(v_netted) and public.stock_js_truthy(x -> 'isFullRefund')) then
        v_flags := array_append(v_flags, 'cancelled_before_made') || v_netted;
        v_skip := true;
      end if;
    end if;
    if not v_skip then
      -- 20261023a: the sale explodes once, line by line (the one stock rule)
      select coalesce(jsonb_agg(jsonb_build_object('n', x.line_no, 'i', x.inventory_item_id, 'b', x.unit_qty_base,
                                                   'qb', x.qty_base, 'note', x.note)), '[]'::jsonb)
        into v_ex
        from public.stock_explode_lines(e.location_id, c.items, v_ot) x;
      -- the sold lines and what one unit of each took (the takes shape, before any netting)
      select coalesce(jsonb_agg(jsonb_build_object('n', sl.n, 'u', sl.u, 'm', sl.mid, 'q', sl.q,
                                                   't', coalesce((select jsonb_agg(jsonb_build_object('i', g.i, 'b', trim_scale(g.b)) order by g.i)
                                                                    from (select (y ->> 'i')::uuid as i, sum((y ->> 'b')::numeric) as b
                                                                            from jsonb_array_elements(v_ex) y
                                                                           where (y ->> 'n')::integer = sl.n and y ->> 'i' is not null
                                                                           group by (y ->> 'i')::uuid) g), '[]'::jsonb))
                                order by sl.n), '[]'::jsonb)
        into v_tk
        from (select o.n::integer as n, public.stock_js_key(o.l -> 'uid') as u,
                     coalesce(public.stock_js_key(o.l -> 'itemId'), public.stock_js_key(o.l -> 'id')) as mid,
                     public.stock_js_qty(o.l -> 'qty') as q
                from jsonb_array_elements(case when jsonb_typeof(c.items) = 'array' then c.items else '[]'::jsonb end) with ordinality as o(l, n)
               where jsonb_typeof(o.l) = 'object' and not public.stock_js_truthy(o.l -> 'voided')) sl
       where sl.mid is not null and sl.q > 0;
      -- the part refunds a catering sale dated ahead nets, as refund lines
      if cardinality(v_netted) > 0 then
        select coalesce(jsonb_agg(y.v order by x.k, y.j), '[]'::jsonb) into v_nl
          from jsonb_array_elements(case when jsonb_typeof(c.refunds) = 'array' then c.refunds else '[]'::jsonb end) with ordinality as x(v, k)
         cross join lateral jsonb_array_elements(public._stock_refund_lines(c.items, x.v)) with ordinality as y(v, j)
         where ('netted:' || (x.v ->> 'id')) = any(v_netted);
      end if;
      for m in
        with sold as (select (x ->> 'i')::uuid as inventory_item_id, sum((x ->> 'qb')::numeric) as qty_base
                        from jsonb_array_elements(v_ex) x
                       where x ->> 'i' is not null
                       group by (x ->> 'i')::uuid
                      having sum((x ->> 'qb')::numeric) > 0),
             back as (select z.inventory_item_id, sum(z.qty_base) q
                        from public._stock_takes_share(v_tk, v_nl) z
                       where cardinality(v_netted) > 0 and z.inventory_item_id is not null
                       group by z.inventory_item_id)
        select sd.inventory_item_id, sd.qty_base - coalesce(b.q, 0) qty_base
          from sold sd left join back b on b.inventory_item_id = sd.inventory_item_id
         where sd.qty_base - coalesce(b.q, 0) > 0.00005
         order by sd.inventory_item_id
      loop
        v_q := public._stock_post(e.location_id, m.inventory_item_id, -m.qty_base, 'SALE_DEPLETION', 'closed_check', c.id,
                                  'sale:' || c.id || ':' || m.inventory_item_id::text, e.occurred_at, null, null, null, true);
        v_n := v_n + 1;
      end loop;
      if cardinality(v_netted) > 0 then v_flags := array_append(v_flags, 'refund_before_made') || v_netted; end if;
      if v_n = 0 then v_flags := array_append(v_flags, 'nothing_to_take'); end if;
      if public.stock_explode_skipped(e.location_id, c.items, v_ot) > 0 then v_flags := array_append(v_flags, 'unit_skipped'); end if;
      if exists (select 1 from jsonb_array_elements(v_ex) x where x ->> 'note' in ('loop', 'depth', 'no_recipe', 'yield')) then
        v_flags := array_append(v_flags, 'to_order_fallback');
      end if;
      -- What each line took, for its refunds and its theoretical cost: q is the line's quantity
      -- less what a netted refund took back; c is the line's share of the value its sale movements
      -- booked (each item's value shared over the lines by base quantity), so the lines of a check
      -- add up to its sale value to the penny. Never undoes the sale.
      begin
        insert into stock_sale_takes (location_id, check_id, order_type, occurred_at, lines)
        select e.location_id, c.id, c.order_type, e.occurred_at, coalesce((
          with tl as (select (x ->> 'n')::integer as n, x -> 'u' as u, x -> 'm' as mm, (x ->> 'q')::numeric as q0, x -> 't' as t
                        from jsonb_array_elements(v_tk) x),
               sh as (select z.line_no as n, max(z.refund_qty) as rq
                        from public._stock_takes_share(v_tk, v_nl) z
                       where cardinality(v_netted) > 0 and z.line_no is not null
                       group by z.line_no),
               lq as (select tl.n, tl.u, tl.mm, tl.q0 - coalesce(sh.rq, 0) as q, tl.t from tl left join sh on sh.n = tl.n),
               it as (select lq.n, (y ->> 'i')::uuid as i, (y ->> 'b')::numeric as b, lq.q
                        from lq cross join lateral jsonb_array_elements(lq.t) y),
               wt as (select it.i, sum(it.b * it.q) as w from it group by it.i),
               vv as (select wt.i, wt.w,
                             coalesce((select -mv.value_delta from stock_movements mv
                                        where mv.location_id = e.location_id
                                          and mv.idempotency_key = 'sale:' || c.id || ':' || wt.i::text), 0) as val
                        from wt),
               cl as (select it.n, sum(case when vv.w <> 0 then vv.val * (it.b * it.q) / vv.w else 0 end) as cost
                        from it join vv on vv.i = it.i
                       group by it.n)
          select jsonb_agg(jsonb_build_object('n', lq.n, 'u', lq.u, 'm', lq.mm, 'q', trim_scale(lq.q), 't', lq.t,
                                           'c', trim_scale(coalesce(cl.cost, 0)))
                           order by lq.n)
            from lq left join cl on cl.n = lq.n), '[]'::jsonb)
        on conflict (location_id, check_id) do nothing;
      exception when others then
        raise warning 'stock drainer: what check % took was not saved (% %); its sale is booked', c.id, sqlstate, sqlerrm;
        v_flags := array_append(v_flags, 'takes_not_saved');
      end;
      -- its sales day is rebuilt with the theoretical cost (the till's close queued it already;
      -- this one covers a day rebuilt before the sale was booked)
      begin
        insert into sales_day_sums_queue (location_id, business_day, reason)
        select e.location_id, d.business_day, 'sale_booked'
          from public.stock_co__venue_day(e.location_id, c.closed_at) d
         where c.closed_at is not null and d.business_day is not null
        on conflict (location_id, business_day) do nothing;
      exception when others then
        raise warning 'stock drainer: the sales day of check % was not queued (% %); the nightly run rebuilds yesterday', c.id, sqlstate, sqlerrm;
      end;
    end if;

  elsif e.kind = 'tomb' then
    -- A whole order voided. Lines the kitchen was cooking were made: waste, never for shelf items.
    -- A line with sent (a 5.11.77 till: its status was 'sent' at the void) is made when sent and
    -- not held (fired not false); an older line with no sent key when fired and not course 0 (a
    -- course 0 drink is fired the moment it is added, before any send); a channel line with
    -- neither key (kiosk, online, QR) is made. A tombstone that mirrors a paid check (same venue
    -- and ref, within a day: a prepaid kiosk, online, QR or HubRise order voided on the Orders
    -- screen) books nothing.
    if c.ref is not null and exists (select 1 from closed_checks p where p.location_id = c.location_id and p.ref = c.ref and p.id <> c.id
                                      and not coalesce(p.voided, false) and coalesce(p.status, 'paid') not in ('void', 'voided')
                                      and p.closed_at between c.closed_at - interval '24 hours' and c.closed_at + interval '10 minutes') then
      v_flags := array_append(v_flags, 'paid_twin');
    else
      v_lines := (select coalesce(jsonb_agg(l - 'voided'), '[]'::jsonb)
                    from jsonb_array_elements(case when jsonb_typeof(c.items) = 'array' then c.items else '[]'::jsonb end) l
                   where jsonb_typeof(l) = 'object'
                     and case when l ? 'sent' then public.stock_js_truthy(l -> 'sent') and (not (l ? 'fired') or public.stock_js_truthy(l -> 'fired'))
                              when l ? 'fired' then public.stock_js_truthy(l -> 'fired') and coalesce(l ->> 'course', '1') <> '0'
                              else coalesce(nullif(c.source, ''), 'pos') <> 'pos' end);
      for m in select x.inventory_item_id, x.qty_base, i.returns_to_shelf from stock_explode(e.location_id, v_lines, v_ot) x
                 join inventory_items i on i.id = x.inventory_item_id order by x.inventory_item_id loop
        continue when m.returns_to_shelf;
        v_q := public._stock_post(e.location_id, m.inventory_item_id, -m.qty_base, 'WASTE', 'closed_check_void', c.id,
                                  'waste:' || c.id || ':tomb:' || m.inventory_item_id::text, e.occurred_at, null, null,
                                  'Voided after it was sent to the kitchen', true);
        v_n := v_n + 1;
        insert into waste_events (id, location_id, inventory_item_id, item_name, qty, unit, qty_base, reason, note, cost_value, source, occurred_at)
        select md5('waste:' || c.id || ':tomb:' || m.inventory_item_id::text)::uuid, e.location_id, m.inventory_item_id, i.name,
               -v_q, i.base_unit, -v_q, 'Voided after sent', 'Check ' || coalesce(c.ref, c.id), -v_q * coalesce(i.current_cost, 0), 'void', e.occurred_at
          from inventory_items i where i.id = m.inventory_item_id
        on conflict (id) do nothing;
      end loop;
      if v_n = 0 then v_flags := array_append(v_flags, 'nothing_made'); end if;
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
      v_lines := public._stock_refund_lines(c.items, v_entry);
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
      -- 20261023a: a part refund gives back the sale's own takes; a sale booked before them (or
      -- whose takes were not saved) gives back today's recipe, as before
      if not v_full then
        select t.lines into v_tk from stock_sale_takes t where t.location_id = e.location_id and t.check_id = c.id;
        if v_tk is null then
          v_flags := array_append(v_flags, 'refund_by_recipe');
        elsif exists (select 1 from public._stock_takes_share(v_tk, v_lines) z where z.line_no is null) then
          v_flags := array_append(v_flags, 'refund_line_unmatched');
        end if;
      end if;
      for m in
        with want as (
          select x.inventory_item_id, x.qty_base from stock_explode(e.location_id, v_lines, v_ot, 'refundQty') x
           where not v_full and v_tk is null
          union all
          select z.inventory_item_id, sum(z.qty_base) from public._stock_takes_share(v_tk, v_lines) z
           where not v_full and v_tk is not null and z.inventory_item_id is not null
           group by z.inventory_item_id
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
        v_n := v_n + 1;
      end loop;
      if v_n = 0 then v_flags := array_append(v_flags, 'nothing_to_give_back'); end if;
    end if;

  elsif e.kind = 'undo' then
    -- Post the exact opposite of every row this refund booked (same type, qty, cost, area), once.
    for m in select sm.* from stock_movements sm
              where sm.location_id = e.location_id and sm.source_id = c.id and sm.source_type = 'closed_check_refund'
                and sm.idempotency_key like '%:' || c.id || ':' || e.event_ref || ':%'
                and split_part(sm.idempotency_key, ':', 1) in ('unsale', 'waste', 'return')
                and not exists (select 1 from stock_movements u where u.location_id = e.location_id and u.idempotency_key = 'undo:' || sm.idempotency_key)
              order by sm.inventory_item_id, sm.idempotency_key loop
      perform public._stock_post(e.location_id, m.inventory_item_id, -m.qty_base, m.movement_type, 'closed_check_refund', c.id,
                                 'undo:' || m.idempotency_key, now(), m.unit_cost, m.area_id, 'Refund refused by the card processor: reversed', false);
      if m.movement_type = 'WASTE' then
        delete from waste_events w where w.id = md5(m.idempotency_key)::uuid and w.location_id = e.location_id;
      end if;
      v_n := v_n + 1;
    end loop;
    if v_n = 0 then v_flags := array_append(v_flags, 'nothing_to_undo'); end if;

  else
    -- edit and moved rows are written as held by the trigger; a released one has nothing safe to do by itself
    update stock_outbox set status = 'held', flags = array_append(flags, 'needs_a_person'), attempts = attempts + 1 where id = p_id;
    return 'held';
  end if;

  -- posted: how many rows this event booked (the detail is in stock_movements by source_id)
  update stock_outbox set status = 'done', done_at = now(), attempts = attempts + 1, posted = jsonb_build_object('rows', v_n),
         flags = flags || v_flags, last_error = null
   where id = p_id;
  return 'done';
end $function$;
-- == drainer part 3: stock day totals kept live ==
--
-- A statement trigger on stock_movements keeps stock_day_sums up on each venue's business day as
-- movements are inserted, updated or deleted, and never raises (a problem queues the day in
-- stock_day_sums_repair, and the movement always posts); a figure moved on a day older than the
-- venue's yesterday queues that day for a whole rebuild too. stock_day_sums_rebuild v2 writes the demo
-- flag, leaves the repair rows to the drain, and gives up after 2 s of waiting for writers. A new
-- or changed venue clock queues every day of that venue for a rebuild. stock_drainer_health is the
-- morning after check. No grants here: part 5 owns every function grant and revoke.

-- ---------------------------------------------------------------------------------------------
-- _stock_day_sums_apply: INSERT adds new_rows, UPDATE takes off old_rows and adds new_rows, DELETE
-- takes off old_rows. Grouped per venue business day (stock_co__venue_day), item, movement type,
-- source (null kept as 'unknown') and demo flag. Writers share the venue's day totals lock (a
-- rebuild takes it alone), waiting at most 500 ms for a rebuild in flight. A figure moved on a day
-- older than the venue's yesterday also queues that day for a whole rebuild (reason late). On any
-- error the touched venue days are queued for the drain to rebuild, a warning is raised, and the
-- movement posts.
-- ---------------------------------------------------------------------------------------------
create or replace function public._stock_day_sums_apply()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_lt     text := current_setting('lock_timeout');
  v_rows   jsonb;
  v_state  text;
  v_msg    text;
  r        record;
begin
  begin
    -- the changed rows as signed deltas (the transition tables this trigger has)
    if tg_op = 'INSERT' then
      select jsonb_agg(jsonb_build_object('l', n.location_id, 'at', n.occurred_at, 'i', n.inventory_item_id, 't', n.movement_type,
                                          's', n.source_type, 'k', n.idempotency_key, 'q', n.qty_base, 'v', n.value_delta))
        into v_rows
        from new_rows n;
    elsif tg_op = 'UPDATE' then
      select jsonb_agg(z.d) into v_rows
        from (select jsonb_build_object('l', o.location_id, 'at', o.occurred_at, 'i', o.inventory_item_id, 't', o.movement_type,
                                        's', o.source_type, 'k', o.idempotency_key, 'q', -o.qty_base, 'v', -o.value_delta) as d
                from old_rows o
              union all
              select jsonb_build_object('l', n.location_id, 'at', n.occurred_at, 'i', n.inventory_item_id, 't', n.movement_type,
                                        's', n.source_type, 'k', n.idempotency_key, 'q', n.qty_base, 'v', n.value_delta)
                from new_rows n) z;
    else
      select jsonb_agg(jsonb_build_object('l', o.location_id, 'at', o.occurred_at, 'i', o.inventory_item_id, 't', o.movement_type,
                                          's', o.source_type, 'k', o.idempotency_key, 'q', -o.qty_base, 'v', -o.value_delta))
        into v_rows
        from old_rows o;
    end if;
    if v_rows is null then
      return null;
    end if;

    -- writers share the lock of each venue they touch, in venue id order
    perform set_config('lock_timeout', '500ms', true);
    for r in
      select distinct (d ->> 'l')::uuid as loc from jsonb_array_elements(v_rows) d order by 1
    loop
      perform pg_advisory_xact_lock_shared(hashtext('stock_day_sums:' || r.loc::text));
    end loop;
    perform set_config('lock_timeout', v_lt, true);

    insert into stock_day_sums as t (location_id, business_day, inventory_item_id, company_item_id, movement_type, source_type, demo,
                                     qty_base, value, clock_known, updated_at)
    select g.location_id, g.business_day, g.inventory_item_id, i.company_ref, g.movement_type, g.source_type, g.demo,
           g.q, g.v, g.known, now()
      from (select x.location_id, vd.business_day, x.inventory_item_id, x.movement_type, coalesce(x.source_type, 'unknown') as source_type,
                   coalesce(left(x.idempotency_key, 8) = 'demo-v1:' or left(x.idempotency_key, 7) = 'demo71:'
                            or left(x.idempotency_key, 5) = 'seed:', false) as demo,
                   sum(x.qty_base) as q, sum(coalesce(x.value_delta, 0)) as v, bool_and(vd.clock_known) as known
              from jsonb_to_recordset(v_rows) as y(l uuid, "at" timestamptz, i uuid, t text, s text, k text, q numeric, v numeric)
             cross join lateral (select y.l as location_id, y."at" as occurred_at, y.i as inventory_item_id, y.t as movement_type,
                                        y.s as source_type, y.k as idempotency_key, y.q as qty_base, y.v as value_delta) x
             cross join lateral public.stock_co__venue_day(x.location_id, coalesce(x.occurred_at, now())) vd
             group by x.location_id, vd.business_day, x.inventory_item_id, x.movement_type, coalesce(x.source_type, 'unknown'),
                      coalesce(left(x.idempotency_key, 8) = 'demo-v1:' or left(x.idempotency_key, 7) = 'demo71:'
                               or left(x.idempotency_key, 5) = 'seed:', false)) g
      left join inventory_items i on i.id = g.inventory_item_id
     order by g.location_id, g.business_day, g.inventory_item_id, g.movement_type, g.source_type, g.demo
    on conflict (location_id, business_day, inventory_item_id, movement_type, source_type, demo) do update
       set qty_base = t.qty_base + excluded.qty_base,
           value = t.value + excluded.value,
           clock_known = t.clock_known and excluded.clock_known,
           company_item_id = coalesce(excluded.company_item_id, t.company_item_id),
           updated_at = now();

    -- a figure moved on a venue day older than the venue's yesterday: that day is queued for a whole
    -- rebuild as well (reason late). A row dated back (a till that synced late, a held sale released
    -- late, a count, a demo or seed file) can land on a day these totals never held whole, and the
    -- delta alone would leave it a part total. Only rows before the venue's yesterday are looked at,
    -- and only groups whose quantity or value changed (an update that moves no figure queues
    -- nothing). Waits at most 500 ms for a row the drain is claiming; a problem here only warns, and
    -- the delta above stays. A venue's yesterday starts at least 22 hours ago (a day is 23 to 25
    -- hours long), so a statement whose rows are all newer than that (every sale made now) skips the
    -- clock lookups.
    begin
      if exists (select 1 from jsonb_array_elements(v_rows) e
                  where coalesce((e ->> 'at')::timestamptz, now()) < now() - interval '22 hours') then
        perform set_config('lock_timeout', '500ms', true);
        insert into stock_day_sums_repair (location_id, business_day, reason)
        select distinct z.l, z.d, 'late'
          from (select y.l, vd.business_day as d
                  from (select distinct (e ->> 'l')::uuid as l from jsonb_array_elements(v_rows) e) vv
                 cross join lateral (select public.stock_co__day_start_at(td.business_day - 1, kc.day_start, kc.timezone) as cut
                                       from public.stock_co__venue_day(vv.l, now()) td
                                      cross join public.stock_co__clock_of(vv.l) kc) cc
                  join jsonb_to_recordset(v_rows) as y(l uuid, "at" timestamptz, i uuid, t text, s text, k text, q numeric, v numeric)
                    on y.l = vv.l and coalesce(y."at", now()) < cc.cut
                 cross join lateral public.stock_co__venue_day(y.l, coalesce(y."at", now())) vd
                 group by y.l, vd.business_day, y.i, y.t, coalesce(y.s, 'unknown'),
                          coalesce(left(y.k, 8) = 'demo-v1:' or left(y.k, 7) = 'demo71:' or left(y.k, 5) = 'seed:', false)
                having coalesce(sum(y.q), 0) <> 0 or sum(coalesce(y.v, 0)) <> 0) z
         order by 1, 2
        on conflict (location_id, business_day) do nothing;
        perform set_config('lock_timeout', v_lt, true);
      end if;
    exception when others then
      perform set_config('lock_timeout', v_lt, true);
      raise warning 'stock day totals: a late venue day was not queued for a rebuild (% %)', sqlstate, sqlerrm;
    end;
  exception when others then
    v_state := sqlstate;
    v_msg := sqlerrm;
    perform set_config('lock_timeout', v_lt, true);
    begin
      if v_rows is not null then
        insert into stock_day_sums_repair (location_id, business_day, reason)
        select distinct y.l, coalesce((select vd.business_day from public.stock_co__venue_day(y.l, coalesce(y."at", now())) vd),
                                      (coalesce(y."at", now()) at time zone 'UTC')::date),
               'trigger: ' || v_state
          from jsonb_to_recordset(v_rows) as y(l uuid, "at" timestamptz)
         order by 1, 2
        on conflict (location_id, business_day) do nothing;
      end if;
    exception when others then
      null;
    end;
    raise warning 'stock day totals: a movement was posted but its day total was not (% %); the day is queued for a rebuild', v_state, v_msg;
  end;
  return null;
end
$fn$;

create trigger stock_movements_day_sums_ins
  after insert on public.stock_movements
  referencing new table as new_rows
  for each statement execute function public._stock_day_sums_apply();
create trigger stock_movements_day_sums_upd
  after update on public.stock_movements
  referencing old table as old_rows new table as new_rows
  for each statement execute function public._stock_day_sums_apply();
create trigger stock_movements_day_sums_del
  after delete on public.stock_movements
  referencing old table as old_rows
  for each statement execute function public._stock_day_sums_apply();

-- ---------------------------------------------------------------------------------------------
-- stock_day_sums_rebuild v2: the live body with these changes only: it writes the demo flag; it
-- no longer deletes stock_day_sums_repair rows (only the drain claims them); it waits at most 2 s
-- for the writers of the venue (they hold the shared lock), then gives up and the drain retries,
-- so a sale never waits long behind a rebuild. Same refusals, same result.
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_day_sums_rebuild(p_location uuid, p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tz     text;
  v_start  time;
  v_known  boolean;
  v_rows   integer := 0;
  v_lt     text;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') in ('authenticated', 'anon') then
    raise exception 'Day totals are rebuilt by the nightly stock run only.' using errcode = '42501';
  end if;
  if p_location is null or p_from is null or p_to is null or p_to < p_from then
    raise exception 'stock_day_sums_rebuild: a venue, and from and to dates with from first.' using errcode = '22023';
  end if;
  if p_to - p_from > 400 then
    raise exception 'stock_day_sums_rebuild: at most 400 days at a time.' using errcode = '22023';
  end if;
  if not exists (select 1 from locations l where l.id = p_location) then
    raise exception 'stock_day_sums_rebuild: that venue was not found.' using errcode = '22023';
  end if;
  select k.timezone, k.day_start, k.clock_known into v_tz, v_start, v_known from public.stock_co__clock_of(p_location) k;
  -- one rebuild of a venue at a time, and no writer of it while it runs (they share this lock)
  v_lt := current_setting('lock_timeout');
  perform set_config('lock_timeout', '2s', true);
  perform pg_advisory_xact_lock(hashtext('stock_day_sums:' || p_location::text));
  perform set_config('lock_timeout', v_lt, true);

  delete from stock_day_sums where location_id = p_location and business_day between p_from and p_to;

  with b as (
    select g::date as day,
           public.stock_co__day_start_at(g::date, v_start, v_tz) as lo,
           public.stock_co__day_start_at(g::date + 1, v_start, v_tz) as hi
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as g
  )
  insert into stock_day_sums (location_id, business_day, inventory_item_id, company_item_id, movement_type, source_type, demo,
                              qty_base, value, clock_known, updated_at)
  select p_location, b.day, m.inventory_item_id, i.company_ref, m.movement_type, coalesce(m.source_type, 'unknown'),
         coalesce(left(m.idempotency_key, 8) = 'demo-v1:' or left(m.idempotency_key, 7) = 'demo71:'
                  or left(m.idempotency_key, 5) = 'seed:', false),
         sum(m.qty_base), sum(coalesce(m.value_delta, 0)), v_known, now()
    from b
    join stock_movements m on m.location_id = p_location and m.occurred_at >= b.lo and m.occurred_at < b.hi
    left join inventory_items i on i.id = m.inventory_item_id
   group by b.day, m.inventory_item_id, i.company_ref, m.movement_type, coalesce(m.source_type, 'unknown'),
            coalesce(left(m.idempotency_key, 8) = 'demo-v1:' or left(m.idempotency_key, 7) = 'demo71:'
                     or left(m.idempotency_key, 5) = 'seed:', false);
  get diagnostics v_rows = row_count;
  return jsonb_build_object('ok', true, 'days', p_to - p_from + 1, 'rows', v_rows);
end
$function$;

-- ---------------------------------------------------------------------------------------------
-- _venue_clock_requeue: a venue's clock arrived or its time zone or day start changed. Every venue
-- day of that venue from the day before its first day total to the day after its last (stock and
-- sales), within the last 400 days, is queued for a rebuild (reason clock_changed). No day totals
-- yet: nothing. Never raises.
-- ---------------------------------------------------------------------------------------------
create or replace function public._venue_clock_requeue()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_min   date;
  v_max   date;
  v_from  date;
  v_to    date;
begin
  begin
    select least(a.mn, b.mn), greatest(a.mx, b.mx) into v_min, v_max
      from (select min(x.business_day) as mn, max(x.business_day) as mx from stock_day_sums x where x.location_id = new.location_id) a,
           (select min(x.business_day) as mn, max(x.business_day) as mx from sales_day_sums x where x.location_id = new.location_id) b;
    if v_min is not null then
      v_from := greatest(v_min - 1, current_date - 400);
      v_to := v_max + 1;
      if v_from <= v_to then
        insert into stock_day_sums_repair (location_id, business_day, reason)
        select new.location_id, g::date, 'clock_changed'
          from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') as g
         order by 2
        on conflict (location_id, business_day) do nothing;
        insert into sales_day_sums_queue (location_id, business_day, reason)
        select new.location_id, g::date, 'clock_changed'
          from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') as g
         order by 2
        on conflict (location_id, business_day) do nothing;
      end if;
    end if;
  exception when others then
    raise warning 'venue clock: the day totals of venue % were not queued for a rebuild (% %)', new.location_id, sqlstate, sqlerrm;
  end;
  return null;
end
$fn$;

create trigger venue_clock_requeue_ins
  after insert on public.venue_clock
  for each row execute function public._venue_clock_requeue();
create trigger venue_clock_requeue_upd
  after update of timezone, day_start on public.venue_clock
  for each row
  when (old.timezone is distinct from new.timezone or old.day_start is distinct from new.day_start)
  execute function public._venue_clock_requeue();

-- ---------------------------------------------------------------------------------------------
-- stock_drainer_health: read only, the morning after check (service role). One entry per venue that
-- is central or paused and has any recipe link or stock item (or just p_location), at most 1000.
-- takes_missing_24h counts only sales booked since this release ran (the backup rows' time).
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_drainer_health(p_location uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_since    timestamptz;
  v_venues   jsonb;
  v_ok       boolean;
begin
  select coalesce(min(b.saved_at), '-infinity'::timestamptz) into v_since
    from stock_native_backup b where left(b.name, 11) = 'drainer_v2:';
  with v as (
    select l.id
      from locations l
     where (p_location is not null and l.id = p_location)
        or (p_location is null
            and public._stock_mode_of(l.id) in ('central', 'paused')
            and (exists (select 1 from menu_item_recipes r where r.location_id = l.id)
                 or exists (select 1 from inventory_items i where i.location_id = l.id)))
     order by l.id
     limit 1000
  ),
  h as (
    select v.id as location_id,
           public._stock_mode_of(v.id) as mode,
           (select count(*) from stock_outbox o where o.location_id = v.id and o.status = 'pending') as pending,
           (select count(*) from stock_outbox o where o.location_id = v.id and o.status = 'held') as held,
           (select count(*) from stock_outbox o where o.location_id = v.id and o.status = 'dead') as dead,
           (select coalesce(extract(epoch from now() - min(o.due_at)), 0)::integer from stock_outbox o
             where o.location_id = v.id and o.status = 'pending' and o.due_at <= now()) as oldest_pending_s,
           (select count(*) from stock_outbox o
             where o.location_id = v.id and o.status = 'done' and o.done_at > now() - interval '24 hours') as done_24h,
           (select count(*) from stock_outbox o
             where o.location_id = v.id and o.status = 'done' and o.done_at > now() - interval '24 hours' and 'unit_skipped' = any(o.flags)) as unit_skipped_24h,
           (select count(*) from stock_outbox o
             where o.location_id = v.id and o.status = 'done' and o.done_at > now() - interval '24 hours' and 'to_order_fallback' = any(o.flags)) as to_order_fallback_24h,
           (select count(*) from stock_outbox o
             where o.location_id = v.id and o.status = 'done' and o.done_at > now() - interval '24 hours' and 'takes_not_saved' = any(o.flags)) as takes_not_saved_24h,
           (select count(*) from stock_outbox o
             where o.location_id = v.id and o.status = 'done' and o.done_at > now() - interval '24 hours' and 'refund_by_recipe' = any(o.flags)) as refund_by_recipe_24h,
           (select count(*) from stock_outbox o
             where o.location_id = v.id and o.status = 'done' and o.done_at > now() - interval '24 hours' and 'refund_line_unmatched' = any(o.flags)) as refund_line_unmatched_24h,
           (select count(*) from stock_outbox o
             where o.location_id = v.id and o.kind = 'sale' and o.status = 'done'
               and o.done_at > greatest(now() - interval '24 hours', v_since)
               and coalesce((o.posted ->> 'rows')::integer, 0) > 0
               and not exists (select 1 from stock_sale_takes t where t.location_id = o.location_id and t.check_id = o.check_id)) as takes_missing_24h,
           (select count(*) from recipe_lines x
              join recipes rc on rc.id = x.recipe_id and rc.archived_at is null
             where x.location_id = v.id
               and (exists (select 1 from inventory_items i where i.id = x.component_item_id and i.archived_at is not null)
                    or (left(x.unit, 1) = '@'
                        and exists (select 1 from item_packaging_formats pf
                                     where pf.id::text = substr(x.unit, 2) and pf.archived_at is not null)))) as lines_on_archived,
           (select count(*) from recipe_lines x
              join recipes rc on rc.id = x.recipe_id and rc.archived_at is null
              join inventory_items i on i.id = x.component_item_id and i.location_id = v.id and i.archived_at is null
             where x.location_id = v.id
               and public.stock_qty_to_base(x.qty, x.unit, x.component_item_id) is null) as lines_unresolved,
           (select count(*) from recipe_lines x
              join recipes rc on rc.id = x.recipe_id and rc.archived_at is null
             where x.location_id = v.id and left(x.unit, 1) = '@'
               and not exists (select 1 from item_packaging_formats pf
                                where pf.id::text = substr(x.unit, 2) and pf.inventory_item_id = x.component_item_id)) as foreign_pack_lines,
           (select count(*) from stock_co_item_sites si
             where si.location_id = v.id and si.supply_mode = 'to_order'
               and exists (select 1 from public._stock_explode_made(v.id, si.site_item_id, 1, null, '{}'::uuid[]) z
                            where z.note in ('loop', 'depth'))) as to_order_loops,
           (select count(*) from stock_day_sums_repair q where q.location_id = v.id and q.due_at <= now()) as repair_due,
           (select count(*) from stock_day_sums_repair q where q.location_id = v.id and q.attempts >= 8) as repair_failing,
           (select count(*) from sales_day_sums_queue q where q.location_id = v.id and q.due_at <= now()) as sales_queue_due,
           (select count(*) from sales_day_sums_queue q where q.location_id = v.id and q.attempts >= 8) as sales_queue_failing,
           coalesce(extract(epoch from now() - least((select min(q.queued_at) from stock_day_sums_repair q where q.location_id = v.id),
                                                     (select min(q.queued_at) from sales_day_sums_queue q where q.location_id = v.id))), 0)::integer
             as oldest_queue_s,
           (select case when not exists (select 1 from stock_movements mv
                                          where mv.location_id = v.id
                                            and mv.occurred_at >= public.stock_co__day_start_at(d.business_day - 1, k.day_start, k.timezone)
                                            and mv.occurred_at < public.stock_co__day_start_at(d.business_day, k.day_start, k.timezone))
                        then null
                        else (public.stock_day_sums_check(v.id, d.business_day - 1) ->> 'ok')::boolean end
              from public.stock_co__venue_day(v.id, now()) d
             cross join public.stock_co__clock_of(v.id) k) as day_sums_ok_yesterday
      from v
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', h.location_id, 'mode', h.mode, 'pending', h.pending, 'held', h.held, 'dead', h.dead,
           'oldest_pending_s', h.oldest_pending_s, 'done_24h', h.done_24h, 'unit_skipped_24h', h.unit_skipped_24h,
           'to_order_fallback_24h', h.to_order_fallback_24h, 'takes_not_saved_24h', h.takes_not_saved_24h,
           'refund_by_recipe_24h', h.refund_by_recipe_24h, 'refund_line_unmatched_24h', h.refund_line_unmatched_24h,
           'takes_missing_24h', h.takes_missing_24h, 'lines_on_archived', h.lines_on_archived, 'lines_unresolved', h.lines_unresolved,
           'foreign_pack_lines', h.foreign_pack_lines, 'to_order_loops', h.to_order_loops, 'repair_due', h.repair_due,
           'repair_failing', h.repair_failing, 'sales_queue_due', h.sales_queue_due, 'sales_queue_failing', h.sales_queue_failing,
           'oldest_queue_s', h.oldest_queue_s, 'day_sums_ok_yesterday', h.day_sums_ok_yesterday) order by h.location_id), '[]'::jsonb),
         coalesce(bool_and(h.dead = 0 and h.lines_on_archived = 0 and h.foreign_pack_lines = 0 and h.to_order_loops = 0
                           and h.takes_missing_24h = 0 and h.repair_failing = 0 and h.sales_queue_failing = 0
                           and h.day_sums_ok_yesterday is not false), true)
    into v_venues, v_ok
    from h;
  return jsonb_build_object('ok', v_ok, 'at', now(), 'venues', v_venues);
end
$fn$;
-- == drainer part 4: sales day totals, the one sales rule, the drain ==
--
-- The SQL port of the one sales rule (tradingSales.js checkSalesParts on accountingDay.js), the
-- sales day totals v2 (net, rewards, staff, comps, loyalty and theoretical cost filled), their check
-- v2 (net against the one sales rule, theoretical cost against the ledger), the drain of both day
-- queues (pg_cron every minute) and, LAST, the closed_checks triggers that queue a sales day when a
-- check closes or changes (a short lock on a hot table: lock_timeout 3 s gives up and nothing
-- changes). No grants here: part 5 owns every function grant and revoke.

-- ---------------------------------------------------------------------------------------------
-- JavaScript Math.round: ties go up (toward +infinity). Null in, null out.
-- ---------------------------------------------------------------------------------------------
create or replace function public._sales_js_round(p double precision)
returns double precision
language sql
immutable
set search_path = public, pg_temp
as $fn$
  select floor(p) + case when p - floor(p) >= 0.5 then 1 else 0 end;
$fn$;

-- ---------------------------------------------------------------------------------------------
-- JavaScript Number(x) of a JSON value, as a double: a number as itself; true 1, false 0, JSON null
-- 0; a string trimmed, '' 0, a decimal or exponent literal its value, anything else null (NaN); an
-- object or array null; SQL null (a missing key, undefined in JavaScript) null. Beyond the range
-- of a double: null (JavaScript Infinity, which every caller treats as 0), or 0 when it is too small.
-- ---------------------------------------------------------------------------------------------
create or replace function public._sales_js_num(p jsonb)
returns double precision
language plpgsql
immutable
set search_path = public, pg_temp
as $fn$
declare
  t  text;
  n  numeric;
  x  numeric;
begin
  if p is null then
    return null;
  end if;
  case jsonb_typeof(p)
    when 'number' then
      t := p #>> '{}';
    when 'boolean' then
      return case when (p #>> '{}')::boolean then 1 else 0 end;
    when 'null' then
      return 0;
    when 'string' then
      t := regexp_replace(p #>> '{}', '^\s+|\s+$', '', 'g');
      if t = '' then
        return 0;
      end if;
      if t !~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)([eE][+-]?[0-9]+)?$' then
        return null;
      end if;
    else
      return null;
  end case;
  -- an exponent far outside a double: Infinity (null) or 0, before numeric is asked
  x := coalesce(substring(t from '[eE]([+-]?[0-9]+)$')::numeric, 0);
  if x > 400 then
    return case when t ~ '^[+-]?0*\.?0*[eE]' then 0 else null end;
  end if;
  if x < -400 then
    return 0;
  end if;
  n := t::numeric;
  if abs(n) >= 1e308 then
    return null;
  end if;
  if n <> 0 and abs(n) < 1e-300 then
    return 0;
  end if;
  return n::double precision;
end
$fn$;

-- ---------------------------------------------------------------------------------------------
-- _sales_check_parts: one closed check by the one sales rule, in minor units, the line for line
-- port of supabase/functions/_shared/accountingDay.js (toMinor, allocate, canonicalMethod,
-- tenderKind, moneyDiscounts, checkTaxMinor, legacyGiftMinor, legacyBookingLegs, legacyTenders,
-- checkTenders, checkMoney, checkTenderParts with no tax context) and tradingSales.js
-- (chargedNothing, recordedDiscountMinor, checkSalesMinor). Money kinds give gross and tax, the
-- discount kind (loyalty and promo credits) gives the reward parts. A check that charged nothing
-- gives 0 for all five. legacy: no tenders list. Two deliberate leavings out: the card pattern of
-- tenderKind leaves out the old card processor's name (no live row carries it), and checkTenders'
-- post close tip gap is not moved onto the card, because a tender's tip never reaches its sales
-- or tax (checkMoney reads the amounts only), so the answer is the same.
-- ---------------------------------------------------------------------------------------------
create or replace function public._sales_check_parts(p_c public.closed_checks)
returns table (gross_minor bigint, tax_minor bigint, net_minor bigint, reward_minor bigint, reward_tax_minor bigint,
               charged_nothing boolean, legacy boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
#variable_conflict use_column
declare
  v_ms       text[] := '{}';
  v_as       bigint[] := '{}';
  v_legacy   boolean;
  v_raw      text;
  v_tip      bigint;
  v_total    bigint;
  v_source   text;
  v_g        bigint := 0;
  v_l        bigint := 0;
  v_pr       bigint := 0;
  v_segs     text[];
  v_base     text;
  v_bms      text[] := '{}';
  v_bas      bigint[] := '{}';
  v_used     bigint;
  v_rest     bigint;
  v_t        bigint;
  v_tipleft  bigint;
  v_m        text;
  v_a        bigint;
  v_sub      bigint;
  v_disc     bigint;
  v_bill     bigint;
  v_svc      bigint;
  v_taxc     bigint;
  v_tax      bigint;
  v_promo    boolean;
  v_gross    bigint;
  v_rtax     bigint;
  v_reward   bigint;
  v_rewtax   bigint;
  v_i        integer;
  r          record;
begin
  -- checkTenders: the tenders list, when it holds any object (or array)
  if jsonb_typeof(p_c.tenders) = 'array'
     and exists (select 1 from jsonb_array_elements(p_c.tenders) as y(v) where jsonb_typeof(y.v) in ('object', 'array')) then
    v_legacy := false;
    select coalesce(array_agg(case jsonb_typeof(y.v -> 'method') when 'string' then y.v ->> 'method' when 'number' then y.v ->> 'method'
                                   when 'boolean' then y.v ->> 'method' when 'object' then '[object Object]' else '' end order by y.k), '{}'),
           coalesce(array_agg(greatest(0, coalesce(public._sales_js_round(public._sales_js_num(y.v -> 'amount') * 100), 0))::bigint order by y.k), '{}')
      into v_ms, v_as
      from jsonb_array_elements(p_c.tenders) with ordinality as y(v, k)
     where jsonb_typeof(y.v) in ('object', 'array');
  else
    -- legacyTenders: a row from before closed_checks.tenders
    v_legacy := true;
    v_raw := coalesce(nullif(p_c.payment_method, ''), nullif(p_c.method, ''), 'other');
    v_tip := greatest(0, coalesce(public._sales_js_round(p_c.tip::double precision * 100), 0))::bigint;
    v_total := greatest(0, coalesce(public._sales_js_round(p_c.total::double precision * 100), 0))::bigint;
    v_source := lower(coalesce(p_c.source, ''));
    -- the credits a legacy row proves: gift card (minor), loyalty (minor), promo (major)
    if jsonb_typeof(p_c.gift_card) = 'object' then
      select coalesce(sum(greatest(0, coalesce(public._sales_js_round(public._sales_js_num(y.v -> 'applied')), 0))), 0)::bigint into v_g
        from jsonb_array_elements(case when jsonb_typeof(p_c.gift_card -> 'legs') = 'array' and jsonb_array_length(p_c.gift_card -> 'legs') > 0
                                       then p_c.gift_card -> 'legs' else jsonb_build_array(p_c.gift_card) end) as y(v)
       where jsonb_typeof(y.v) = 'object' and not public.stock_js_truthy(y.v -> 'commit_error');
    end if;
    v_l := greatest(0, coalesce(public._sales_js_round(public._sales_js_num(p_c.loyalty -> 'discount_value')), 0))::bigint;
    v_pr := greatest(0, coalesce(public._sales_js_round(public._sales_js_num(p_c.promo -> 'discount_value') * 100), 0))::bigint;

    if v_source = 'kiosk' then
      v_t := least(v_tip, v_total);
      if v_g > 0 then v_ms := v_ms || 'gift_card'::text; v_as := v_as || v_g; end if;
      if v_l > 0 then v_ms := v_ms || 'loyalty'::text; v_as := v_as || v_l; end if;
      if v_pr > 0 then v_ms := v_ms || 'promo'::text; v_as := v_as || v_pr; end if;
      if v_total > 0 then v_ms := v_ms || 'card'::text; v_as := v_as || greatest(0, v_total - v_t); end if;

    elsif v_source = 'online' and strpos(coalesce(p_c.payment_method, ''), ':') = 0
          and (select case when z.s = '' then 'other' when z.s in ('gift', 'giftcard', 'gift_card', 'gift_cards') then 'gift_card' else z.s end
                 from (select regexp_replace(lower(regexp_replace(coalesce(p_c.method, ''), '^\s+|\s+$', '', 'g')), '[\s-]+', '_', 'g') as s) z)
              in ('gift_card', 'loyalty', 'split')
          and (v_g > 0 or v_l > 0 or v_pr > 0) then
      if v_g > 0 then v_ms := v_ms || 'gift_card'::text; v_as := v_as || v_g; end if;
      if v_l > 0 then v_ms := v_ms || 'loyalty'::text; v_as := v_as || v_l; end if;
      if v_pr > 0 then v_ms := v_ms || 'promo'::text; v_as := v_as || v_pr; end if;

    elsif v_raw ~* '^\s*[a-z_ ]+:\s*\d+(?:\.\d+)?\s*(?:,\s*[a-z_ ]+:\s*\d+(?:\.\d+)?\s*)*$' and strpos(v_raw, ':') > 0 then
      -- the online card path's own list 'gift_card:10.00,loyalty:2.00,card:18.00', the tip on the cards
      v_tipleft := v_tip;
      for r in
        select z.cm, z.amt,
               case when z.cm in ('split', 'unallocated') then 'unallocated'
                    when strpos(z.cm, 'loyalty') > 0 or strpos(z.cm, 'promo') > 0 or strpos(z.cm, 'reward') > 0 or z.cm = 'discount' then 'discount'
                    when strpos(z.cm, 'cash') > 0 then 'cash'
                    when strpos(z.cm, 'gift') > 0 then 'gift_card'
                    when left(z.cm, 7) = 'booking' or strpos(z.cm, 'deposit') > 0 or strpos(z.cm, 'prepaid') > 0 then 'deposit'
                    when z.cm ~ '(card|adyen|ryft|online|apple|google|contactless|visa|master|amex|terminal|pax|tap|credit|debit)' then 'card'
                    else 'other' end as kind
          from (select case when q.s = '' then 'other' when q.s in ('gift', 'giftcard', 'gift_card', 'gift_cards') then 'gift_card' else q.s end as cm,
                       coalesce(public._sales_js_round(public._sales_js_num(to_jsonb(split_part(y.p, ':', 2))) * 100), 0)::bigint as amt,
                       y.k
                  from regexp_split_to_table(v_raw, ',') with ordinality as y(p, k)
                 cross join lateral (select regexp_replace(lower(regexp_replace(split_part(y.p, ':', 1), '^\s+|\s+$', '', 'g')), '[\s-]+', '_', 'g') as s) q) z
         order by z.k
      loop
        v_t := 0;
        if v_tipleft > 0 and r.kind = 'card' then
          v_t := least(v_tipleft, r.amt);
          v_tipleft := v_tipleft - v_t;
        end if;
        v_ms := v_ms || r.cm;
        v_as := v_as || greatest(0, r.amt - v_t);
      end loop;

    else
      select coalesce(array_agg(z.cm order by z.k), '{}') into v_segs
        from (select case when q.s = '' then 'other' when q.s in ('gift', 'giftcard', 'gift_card', 'gift_cards') then 'gift_card' else q.s end as cm, y.k
                from regexp_split_to_table(v_raw, '\+') with ordinality as y(p, k)
               cross join lateral (select regexp_replace(lower(regexp_replace(y.p, '^\s+|\s+$', '', 'g')), '[\s-]+', '_', 'g') as s) q) z
       where z.cm <> 'other';
      if cardinality(v_segs) > 1 or v_segs[1] = 'booking' then
        -- the till's composite 'gift_card+card', 'booking+cash': credits sized from the row, the rest last
        v_base := v_segs[cardinality(v_segs)];
        select coalesce(array_agg(z.cm order by z.k), '{}'), coalesce(array_agg(z.amt order by z.k), '{}') into v_bms, v_bas
          from (select y.k,
                       (select case when q.s = '' then 'other' when q.s in ('gift', 'giftcard', 'gift_card', 'gift_cards') then 'gift_card' else q.s end
                          from (select regexp_replace(lower(regexp_replace(coalesce(y.v ->> 'method', ''), '^\s+|\s+$', '', 'g')), '[\s-]+', '_', 'g') as s) q) as cm,
                       greatest(0, coalesce(public._sales_js_round(public._sales_js_num(y.v -> 'amountMinor')), 0))::bigint as amt
                  from jsonb_array_elements(case when jsonb_typeof(p_c.payment_intents) = 'array' then p_c.payment_intents else '[]'::jsonb end)
                       with ordinality as y(v, k)
                 where jsonb_typeof(y.v) = 'object'
                   and (case jsonb_typeof(y.v -> 'method') when 'string' then y.v ->> 'method' when 'number' then y.v ->> 'method'
                             when 'boolean' then y.v ->> 'method' when 'object' then '[object Object]' else '' end) ~* '^booking') z
         where z.amt > 0;
        if not exists (select 1 from unnest(v_segs) as g(x) where left(g.x, 7) <> 'booking') then
          if cardinality(v_bms) > 0 then
            v_ms := v_bms;
            v_as := v_bas;
          else
            v_ms := array['unallocated'];
            v_as := array[greatest(0, v_total - v_tip)];
          end if;
        elsif v_base = 'split'
              or exists (select 1 from unnest(v_segs[1:cardinality(v_segs) - 1]) as g(x) where g.x <> 'gift_card' and left(g.x, 7) <> 'booking') then
          v_ms := array['unallocated'];
          v_as := array[greatest(0, v_total - v_tip)];
        else
          if 'gift_card' = any(v_segs[1:cardinality(v_segs) - 1]) and v_g > 0 then
            v_ms := v_ms || 'gift_card'::text;
            v_as := v_as || v_g;
          end if;
          if exists (select 1 from unnest(v_segs[1:cardinality(v_segs) - 1]) as g(x) where left(g.x, 7) = 'booking') then
            v_ms := v_ms || v_bms;
            v_as := v_as || v_bas;
          end if;
          v_used := coalesce((select sum(g.a) from unnest(v_as) as g(a)), 0);
          v_rest := greatest(0, v_total - v_used);
          v_t := least(v_tip, v_rest);
          v_ms := v_ms || v_base;
          v_as := v_as || greatest(0, v_rest - v_t);
        end if;
      else
        v_m := coalesce(v_segs[1],
                        (select case when q.s = '' then 'other' when q.s in ('gift', 'giftcard', 'gift_card', 'gift_cards') then 'gift_card' else q.s end
                           from (select regexp_replace(lower(regexp_replace(v_raw, '^\s+|\s+$', '', 'g')), '[\s-]+', '_', 'g') as s) q));
        if v_m = 'split' then
          v_ms := array['unallocated'];
          v_as := array[greatest(0, v_total - v_tip)];
        else
          v_ms := array[v_m];
          v_as := array[greatest(0, v_total - v_tip)];
        end if;
      end if;
    end if;
  end if;

  -- chargedNothing: the check's own money discounts cover its whole subtotal (moneyDiscounts leaves
  -- out a promo line when the row carries a promo tender)
  v_sub := coalesce(public._sales_js_round(p_c.subtotal::double precision * 100), 0)::bigint;
  v_promo := jsonb_typeof(p_c.tenders) = 'array'
             and exists (select 1 from jsonb_array_elements(p_c.tenders) as y(v)
                          where public.stock_js_truthy(y.v)
                            and (select case when q.s = '' then 'other' when q.s in ('gift', 'giftcard', 'gift_card', 'gift_cards') then 'gift_card' else q.s end
                                   from (select regexp_replace(lower(regexp_replace(
                                                  case jsonb_typeof(y.v -> 'method') when 'string' then y.v ->> 'method' when 'number' then y.v ->> 'method'
                                                       when 'boolean' then y.v ->> 'method' when 'object' then '[object Object]' else '' end,
                                                  '^\s+|\s+$', '', 'g')), '[\s-]+', '_', 'g') as s) q) = 'promo');
  v_disc := coalesce((select sum(greatest(0, coalesce(public._sales_js_round(public._sales_js_num(d.v -> 'amount') * 100), 0)))
                        from jsonb_array_elements(case when jsonb_typeof(p_c.discounts) = 'array' then p_c.discounts else '[]'::jsonb end) as d(v)
                       where not (v_promo and jsonb_typeof(d.v) = 'object'
                                  and (d.v -> 'source' = '"promo"'::jsonb or d.v -> 'type' = '"promo"'::jsonb))), 0)::bigint;
  if v_sub > 0 and v_disc >= v_sub then
    return query select 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, true, v_legacy;
    return;
  end if;

  -- checkMoney: the bill money, service and clamped tax (checkTaxMinor)
  v_bill := coalesce((select sum(g.a) from unnest(v_as) as g(a)), 0);
  v_svc := least(greatest(0, coalesce(public._sales_js_round(p_c.service::double precision * 100), 0))::bigint, v_bill);
  if p_c.tax_amount is not null then
    v_taxc := greatest(0, coalesce(public._sales_js_round(p_c.tax_amount::double precision * 100), 0))::bigint;
  else
    v_taxc := greatest(0, coalesce(public._sales_js_round(p_c.total::double precision * 100), 0)::bigint
                          - coalesce(public._sales_js_round(p_c.subtotal::double precision * 100), 0)::bigint
                          - coalesce(public._sales_js_round(p_c.service::double precision * 100), 0)::bigint
                          - coalesce(public._sales_js_round(p_c.tip::double precision * 100), 0)::bigint);
  end if;
  v_tax := least(v_taxc, greatest(0, v_bill - v_svc));

  -- checkTenderParts: service and tax allocated over the bill money (largest remainder, ties to the
  -- earlier tender, all zero weights to the first), then sales = amount - service per tender
  with u as (
    select z.m as raw, z.a, z.i
      from unnest(v_ms, v_as) with ordinality as z(m, a, i)
  ),
  k as (
    select u.i, u.a,
           case when q.cm in ('split', 'unallocated') then 'unallocated'
                when strpos(q.cm, 'loyalty') > 0 or strpos(q.cm, 'promo') > 0 or strpos(q.cm, 'reward') > 0 or q.cm = 'discount' then 'discount'
                when strpos(q.cm, 'cash') > 0 then 'cash'
                when strpos(q.cm, 'gift') > 0 then 'gift_card'
                when left(q.cm, 7) = 'booking' or strpos(q.cm, 'deposit') > 0 or strpos(q.cm, 'prepaid') > 0 then 'deposit'
                when q.cm ~ '(card|adyen|ryft|online|apple|google|contactless|visa|master|amex|terminal|pax|tap|credit|debit)' then 'card'
                else 'other' end as kind
      from u
     cross join lateral (select case when p.s = '' then 'other' when p.s in ('gift', 'giftcard', 'gift_card', 'gift_cards') then 'gift_card' else p.s end as cm
                           from (select regexp_replace(lower(regexp_replace(coalesce(u.raw, ''), '^\s+|\s+$', '', 'g')), '[\s-]+', '_', 'g') as s) p) q
  ),
  w as (
    select k.i, k.a, k.kind,
           sum(greatest(k.a, 0)) over () as sw,
           count(*) over () as cnt
      from k
  ),
  f as (
    select w.i, w.a, w.kind, w.sw, w.cnt,
           case when w.sw > 0 then (v_svc::double precision * greatest(w.a, 0)::double precision) / w.sw::double precision end as rs,
           case when w.sw > 0 then (v_tax::double precision * greatest(w.a, 0)::double precision) / w.sw::double precision end as rt
      from w
  ),
  g as (
    select f.i, f.a, f.kind, f.sw, f.cnt,
           floor(f.rs) as fs, floor(f.rt) as ft,
           v_svc - sum(floor(f.rs)) over () as ls,
           v_tax - sum(floor(f.rt)) over () as lt,
           row_number() over (order by f.rs - floor(f.rs) desc, f.i) as ks,
           row_number() over (order by f.rt - floor(f.rt) desc, f.i) as kt
      from f
  ),
  h as (
    select g.kind, g.a,
           case when g.sw <= 0 then case when g.i = 1 then v_svc else 0 end
                else g.fs + case when g.ls >= g.ks then floor((g.ls - g.ks) / g.cnt) + 1 else 0 end end as s_i,
           case when g.sw <= 0 then case when g.i = 1 then v_tax else 0 end
                else g.ft + case when g.lt >= g.kt then floor((g.lt - g.kt) / g.cnt) + 1 else 0 end end as t_i
      from g
  )
  select coalesce(sum(case when h.kind <> 'discount' then h.a - h.s_i else 0 end), 0)::bigint,
         coalesce(sum(case when h.kind <> 'discount' then h.t_i else 0 end), 0)::bigint,
         coalesce(sum(case when h.kind = 'discount' then h.a - h.s_i else 0 end), 0)::bigint,
         coalesce(sum(case when h.kind = 'discount' then h.t_i else 0 end), 0)::bigint
    into v_gross, v_rtax, v_reward, v_rewtax
    from h;

  return query select v_gross, v_rtax, v_gross - v_rtax, v_reward, v_rewtax, false, v_legacy;
end
$fn$;

-- ---------------------------------------------------------------------------------------------
-- sales_day_sums_rebuild v2: the live body (same day cut, never voided checks, the same live line
-- rule, the 'unknown' line for a check with no live lines, the same gross, discount spread and tax
-- spread, so the 0a parity with report_day_sums holds) with these changes: it no longer deletes
-- sales_day_sums_queue rows (only the drain claims them) and waits at most 2 s for its lock; net and
-- reward_spread are the one sales rule spread by the same share; theo_cost is the sum of the sold
-- lines' theoretical cost (stock_sale_takes, matched on the line number), null where no line has
-- one; staff, comp and loyalty quantity and cost (L9). A check with no live lines and a subtotal of
-- 0 that still took money or credit, or carries a discount or tax, now gets its 'unknown' line, so
-- its net, discount and tax are not lost (report_day_sums counts them for every check).
-- ---------------------------------------------------------------------------------------------
create or replace function public.sales_day_sums_rebuild(p_location uuid, p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tz     text;
  v_start  time;
  v_known  boolean;
  v_rows   integer := 0;
  v_lt     text;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') in ('authenticated', 'anon') then
    raise exception 'Day totals are rebuilt by the nightly stock run only.' using errcode = '42501';
  end if;
  if p_location is null or p_from is null or p_to is null or p_to < p_from then
    raise exception 'sales_day_sums_rebuild: a venue, and from and to dates with from first.' using errcode = '22023';
  end if;
  if p_to - p_from > 400 then
    raise exception 'sales_day_sums_rebuild: at most 400 days at a time.' using errcode = '22023';
  end if;
  if not exists (select 1 from locations l where l.id = p_location) then
    raise exception 'sales_day_sums_rebuild: that venue was not found.' using errcode = '22023';
  end if;
  select k.timezone, k.day_start, k.clock_known into v_tz, v_start, v_known from public.stock_co__clock_of(p_location) k;
  v_lt := current_setting('lock_timeout');
  perform set_config('lock_timeout', '2s', true);
  perform pg_advisory_xact_lock(hashtext('sales_day_sums:' || p_location::text));
  perform set_config('lock_timeout', v_lt, true);

  delete from sales_day_sums where location_id = p_location and business_day between p_from and p_to;

  with b as (
    select g::date as day,
           public.stock_co__day_start_at(g::date, v_start, v_tz) as lo,
           public.stock_co__day_start_at(g::date + 1, v_start, v_tz) as hi
      from generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as g
  ),
  -- the venue's presets with a kind, by name, where the name gives exactly one kind (L9 rule 1)
  pk as (
    select lower(btrim(d.name)) as nm, min(d.kind) as kind
      from discounts d
     where d.location_id = p_location::text and d.kind is not null
     group by lower(btrim(d.name))
    having count(distinct d.kind) = 1
  ),
  chk as (
    select b.day, c.id,
           coalesce(c.order_type, 'unknown') as ot,
           coalesce(c.subtotal, 0) as sub,
           case when c.discounts is null or jsonb_typeof(c.discounts) <> 'array' then 0
                else (select coalesce(sum(coalesce(nullif(public._rds_num(d -> 'amount'), 0),
                                                   nullif(public._rds_num(d -> 'value'), 0), 0)), 0)
                        from jsonb_array_elements(c.discounts) as d) end as disc,
           case when c.tax_amount is not null then c.tax_amount
                else greatest(0, coalesce(c.total, 0) - coalesce(c.subtotal, 0) - coalesce(c.service, 0)
                                 - coalesce(c.tip, 0)) end as tax0,
           case when jsonb_typeof(c.items) = 'array' then c.items else '[]'::jsonb end as items,
           p.net_minor / 100.0 as net,
           p.reward_minor / 100.0 as reward,
           case when jsonb_typeof(c.discounts) = 'array' then c.discounts else '[]'::jsonb end as dl,
           -- the loyalty credit (L9 rule 5): loyalty tenders, else the loyalty reward, else loyalty discount lines
           case when jsonb_typeof(c.tenders) = 'array' and jsonb_array_length(c.tenders) > 0
                then (select coalesce(sum(public.stock_js_num(t -> 'amount')), 0)
                        from jsonb_array_elements(c.tenders) as t
                       where jsonb_typeof(t) = 'object' and strpos(lower(coalesce(t ->> 'method', '')), 'loyalty') > 0)
                when jsonb_typeof(c.loyalty) = 'object' and public.stock_js_num(c.loyalty -> 'discount_value') > 0
                then public.stock_js_num(c.loyalty -> 'discount_value') / 100.0
                else (select coalesce(sum(coalesce(nullif(public._rds_num(d -> 'amount'), 0), nullif(public._rds_num(d -> 'value'), 0), 0)), 0)
                        from jsonb_array_elements(case when jsonb_typeof(c.discounts) = 'array' then c.discounts else '[]'::jsonb end) as d
                       where jsonb_typeof(d) = 'object' and d ->> 'source' = 'loyalty') end as credit
      from b
      join closed_checks c on c.location_id = p_location::text and c.closed_at >= b.lo and c.closed_at < b.hi
     cross join lateral public._sales_check_parts(c) as p
     where not (c.voided is true or coalesce(c.status, '') in ('void', 'voided'))
  ),
  ln as (
    select k.day, k.id, k.ot, k.disc, k.tax0, k.net, k.reward, k.dl, k.credit,
           coalesce(public.stock_js_key(o.l -> 'itemId'), public.stock_js_key(o.l -> 'id'), 'unknown') as mid,
           public.stock_js_qty(o.l -> 'qty') as q,
           public.stock_js_num(o.l -> 'price') * public.stock_js_qty(o.l -> 'qty') as g,
           o.n::integer as line_no,
           public.stock_js_key(o.l -> 'uid') as uid,
           o.l -> 'discount' as idisc,
           true as live
      from chk k
     cross join lateral jsonb_array_elements(k.items) with ordinality as o(l, n)
     where jsonb_typeof(o.l) = 'object' and not public.stock_js_truthy(o.l -> 'voided')
    union all
    select k.day, k.id, k.ot, k.disc, k.tax0, k.net, k.reward, k.dl, k.credit, 'unknown', 0, k.sub,
           null::integer, null::text, null::jsonb, false
      from chk k
     where (k.sub <> 0 or k.net <> 0 or k.reward <> 0 or k.disc <> 0 or k.tax0 <> 0)
       and not exists (select 1 from jsonb_array_elements(k.items) as l
                        where jsonb_typeof(l) = 'object' and not public.stock_js_truthy(l -> 'voided'))
  ),
  sh as (
    select n.day, n.id, n.ot, n.disc, n.tax0, n.net, n.reward, n.dl, n.credit, n.mid, n.q, n.g, n.line_no, n.uid, n.idisc, n.live,
           case when sum(n.g) over (partition by n.id) <> 0 then n.g / sum(n.g) over (partition by n.id)
                else 1.0 / count(*) over (partition by n.id) end as share,
           sum(case when n.live then n.g else 0 end) over (partition by n.id) as gsum
      from ln n
  ),
  tk as (
    select t.check_id, (x ->> 'n')::integer as line_no, public.stock_js_num(x -> 'c') as c
      from stock_sale_takes t
     cross join lateral jsonb_array_elements(t.lines) as x
     where t.location_id = p_location and t.check_id in (select k.id from chk k)
       and jsonb_typeof(x) = 'object' and jsonb_typeof(x -> 'n') = 'number'
  ),
  kd as (
    select s.*, tk.c,
           case when not s.live then null
                else (select case when bool_or(z.k = 'staff') then 'staff' when bool_or(z.k = 'comp') then 'comp'
                                  when bool_or(z.k = 'loyalty') then 'loyalty' end
                        from (select case when d ->> 'kind' in ('staff', 'comp', 'loyalty') then d ->> 'kind'
                                          when not (d ? 'kind') and coalesce(d ->> 'source', '') = ''
                                               and not public.stock_js_truthy(d -> 'isAuto')
                                          then (select pk.kind from pk where pk.nm = lower(btrim(coalesce(d ->> 'label', d ->> 'name')))) end as k
                                from jsonb_array_elements(s.dl) as d
                               where jsonb_typeof(d) = 'object'
                                 and (coalesce(d ->> 'scope', '') <> 'items'
                                      or (s.uid is not null and jsonb_typeof(d -> 'itemUids') = 'array' and (d -> 'itemUids') ? s.uid))
                              union all
                              select case when s.idisc ->> 'kind' in ('staff', 'comp', 'loyalty') then s.idisc ->> 'kind'
                                          when not (s.idisc ? 'kind') and coalesce(s.idisc ->> 'source', '') = ''
                                               and not public.stock_js_truthy(s.idisc -> 'isAuto')
                                          then (select pk.kind from pk where pk.nm = lower(btrim(coalesce(s.idisc ->> 'label', s.idisc ->> 'name')))) end
                               where jsonb_typeof(s.idisc) = 'object') z) end as kind
      from sh s
      left join tk on tk.check_id = s.id and tk.line_no = s.line_no
  )
  insert into sales_day_sums (location_id, business_day, menu_item_id, order_type, qty, gross, net, discount_spread,
                              reward_spread, tax, loyalty_qty, staff_qty, comp_qty, loyalty_cost, staff_cost, comp_cost,
                              theo_cost, clock_known, updated_at)
  select p_location, s.day, s.mid, s.ot, sum(s.q), sum(s.g), sum(s.net * s.share), sum(s.disc * s.share),
         sum(s.reward * s.share), sum(s.tax0 * s.share),
         sum(case when s.kind = 'loyalty' then s.q
                  when s.kind is null and s.live and s.gsum > 0 and s.credit > 0 then s.q * least(1, s.credit / s.gsum)
                  else 0 end),
         sum(case when s.kind = 'staff' then s.q else 0 end),
         sum(case when s.kind = 'comp' then s.q else 0 end),
         sum(case when s.kind = 'loyalty' then coalesce(s.c, 0)
                  when s.kind is null and s.live and s.gsum > 0 and s.credit > 0 then coalesce(s.c, 0) * least(1, s.credit / s.gsum)
                  else 0 end),
         sum(case when s.kind = 'staff' then coalesce(s.c, 0) else 0 end),
         sum(case when s.kind = 'comp' then coalesce(s.c, 0) else 0 end),
         sum(s.c), v_known, now()
    from kd s
   group by s.day, s.mid, s.ot;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('ok', true, 'days', p_to - p_from + 1, 'rows', v_rows);
end
$function$;

-- ---------------------------------------------------------------------------------------------
-- sales_day_sums_check v2: the live body (gross, discounts, voids and tax against report_day_sums)
-- plus net against the one sales rule over the venue day's non voided checks, and theoretical cost
-- against the ledger (the sale value of that day's non voided checks with saved takes: product GP
-- adds up to site GP). ok needs all six. Same refusals.
-- ---------------------------------------------------------------------------------------------
create or replace function public.sales_day_sums_check(p_location uuid, p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_tz       text;
  v_start    time;
  v_lo       timestamptz;
  v_hi       timestamptz;
  v_s_gross  numeric;
  v_s_disc   numeric;
  v_s_tax    numeric;
  v_s_net    numeric;
  v_s_theo   numeric;
  v_v_sub    numeric;
  v_v_disc   numeric;
  v_v_tax    numeric;
  v_v_total  numeric;
  v_r_gross  numeric;
  v_r_disc   numeric;
  v_r_voids  numeric;
  v_r_tax    numeric;
  v_r_rtax   numeric;
  v_r_net    numeric;
  v_l_theo   numeric;
  v_g1 numeric; v_g2 numeric; v_d1 numeric; v_d2 numeric; v_o1 numeric; v_o2 numeric; v_t1 numeric; v_t2 numeric;
  v_n1 numeric; v_n2 numeric; v_c1 numeric; v_c2 numeric;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') in ('authenticated', 'anon') then
    raise exception 'Day totals are checked by the nightly stock run only.' using errcode = '42501';
  end if;
  if p_location is null or p_day is null then
    raise exception 'sales_day_sums_check: a venue and a day.' using errcode = '22023';
  end if;
  if to_regprocedure('public.report_day_sums(text[],date,date,jsonb)') is null then
    raise exception 'sales_day_sums_check needs report_day_sums (20261005b).' using errcode = '55000';
  end if;
  select k.timezone, k.day_start into v_tz, v_start from public.stock_co__clock_of(p_location) k;
  v_lo := public.stock_co__day_start_at(p_day, v_start, v_tz);
  v_hi := public.stock_co__day_start_at(p_day + 1, v_start, v_tz);

  select coalesce(sum(s.gross), 0), coalesce(sum(s.discount_spread), 0), coalesce(sum(s.tax), 0),
         coalesce(sum(s.net), 0), coalesce(sum(s.theo_cost), 0)
    into v_s_gross, v_s_disc, v_s_tax, v_s_net, v_s_theo
    from sales_day_sums s
   where s.location_id = p_location and s.business_day = p_day;

  select coalesce(sum(coalesce(c.subtotal, 0)), 0),
         coalesce(sum(case when c.discounts is null or jsonb_typeof(c.discounts) <> 'array' then 0
                           else (select coalesce(sum(coalesce(nullif(public._rds_num(d -> 'amount'), 0),
                                                              nullif(public._rds_num(d -> 'value'), 0), 0)), 0)
                                   from jsonb_array_elements(c.discounts) as d) end), 0),
         coalesce(sum(case when c.tax_amount is not null then c.tax_amount
                           else greatest(0, coalesce(c.total, 0) - coalesce(c.subtotal, 0) - coalesce(c.service, 0)
                                            - coalesce(c.tip, 0)) end), 0),
         coalesce(sum(coalesce(c.total, 0)), 0)
    into v_v_sub, v_v_disc, v_v_tax, v_v_total
    from closed_checks c
   where c.location_id = p_location::text and c.closed_at >= v_lo and c.closed_at < v_hi
     and (c.voided is true or coalesce(c.status, '') in ('void', 'voided'));

  select r.gross, r.discounts, r.voids, r.tax, r.refunds_tax
    into v_r_gross, v_r_disc, v_r_voids, v_r_tax, v_r_rtax
    from public.report_day_sums(array[p_location::text], p_day, p_day,
                                jsonb_build_object(p_location::text,
                                                   jsonb_build_object('tz', v_tz, 'day_start', to_char(v_start, 'HH24:MI')))) r
   where r.business_day = p_day;

  -- net by the one sales rule, over the same checks the sums hold
  select coalesce(sum(p.net_minor), 0) / 100.0
    into v_r_net
    from closed_checks c
   cross join lateral public._sales_check_parts(c) as p
   where c.location_id = p_location::text and c.closed_at >= v_lo and c.closed_at < v_hi
     and not (c.voided is true or coalesce(c.status, '') in ('void', 'voided'));

  -- the ledger's sale value of those checks that saved what they took
  select -coalesce(sum(m.value_delta), 0)
    into v_l_theo
    from stock_movements m
   where m.location_id = p_location and m.movement_type = 'SALE_DEPLETION' and m.source_type = 'closed_check'
     and m.source_id in (select c.id from closed_checks c
                          where c.location_id = p_location::text and c.closed_at >= v_lo and c.closed_at < v_hi
                            and not (c.voided is true or coalesce(c.status, '') in ('void', 'voided'))
                            and exists (select 1 from stock_sale_takes t where t.location_id = p_location and t.check_id = c.id));

  v_g1 := round(v_s_gross + v_v_sub, 2);                 v_g2 := round(coalesce(v_r_gross, 0), 2);
  v_d1 := round(v_s_disc + v_v_disc, 2);                 v_d2 := round(coalesce(v_r_disc, 0), 2);
  v_o1 := round(v_v_total, 2);                           v_o2 := round(coalesce(v_r_voids, 0), 2);
  v_t1 := round(v_s_tax + v_v_tax, 2);                   v_t2 := round(coalesce(v_r_tax, 0) + coalesce(v_r_rtax, 0), 2);
  v_n1 := round(v_s_net, 2);                             v_n2 := round(v_r_net, 2);
  v_c1 := round(v_s_theo, 2);                            v_c2 := round(v_l_theo, 2);
  return jsonb_build_object('ok', v_g1 = v_g2 and v_d1 = v_d2 and v_o1 = v_o2 and v_t1 = v_t2 and v_n1 = v_n2 and v_c1 = v_c2,
                            'gross', jsonb_build_object('sums', v_g1, 'report', v_g2),
                            'discounts', jsonb_build_object('sums', v_d1, 'report', v_d2),
                            'voids', jsonb_build_object('sums', v_o1, 'report', v_o2),
                            'tax', jsonb_build_object('sums', v_t1, 'report', v_t2),
                            'net', jsonb_build_object('sums', v_n1, 'rule', v_n2),
                            'net_checked', true,
                            'theo', jsonb_build_object('sums', v_c1, 'ledger', v_c2));
end
$function$;

-- ---------------------------------------------------------------------------------------------
-- stock_day_sums_drain: one drain at a time (every transaction takes the drain lock first and
-- returns at once without it). Claims up to p_batch days that are due (stock days first, then
-- sales days, oldest first) with a short delete, commits, then rebuilds each day in its own
-- transaction. A day that fails goes back with attempts + 1 and a back off (1 minute doubling, at
-- most an hour) and its error; it is never given up (stock_drainer_health shows attempts >= 8).
-- An invoker procedure (a definer one cannot commit), so every name is schema qualified.
-- ---------------------------------------------------------------------------------------------
create or replace procedure public.stock_day_sums_drain(p_budget_s integer default 40, p_batch integer default 20)
language plpgsql
as $fn$
declare
  v_t0    timestamptz := clock_timestamp();
  v_lock  bigint := hashtextextended('stock_day_sums_drain', 0);
  v_rep   jsonb;
  v_sal   jsonb;
  v_left  integer;
  v_all   jsonb;
  v_i     integer;
  v_j     integer;
  v_d     jsonb;
  v_err   text;
begin
  loop
    if not pg_try_advisory_xact_lock(v_lock) then
      return;
    end if;
    with c as (
      delete from public.stock_day_sums_repair q
       where (q.location_id, q.business_day) in (select x.location_id, x.business_day
                                                   from public.stock_day_sums_repair x
                                                  where x.due_at <= now()
                                                  order by x.queued_at, x.location_id, x.business_day
                                                  limit p_batch
                                                    for update skip locked)
      returning q.location_id, q.business_day, q.reason, q.queued_at, q.attempts
    )
    select coalesce(jsonb_agg(jsonb_build_object('t', 'stock', 'l', c.location_id, 'd', c.business_day, 'r', c.reason,
                                                 'qa', c.queued_at, 'a', c.attempts) order by c.queued_at, c.location_id, c.business_day), '[]'::jsonb)
      into v_rep
      from c;
    v_left := p_batch - jsonb_array_length(v_rep);
    v_sal := '[]'::jsonb;
    if v_left > 0 then
      with c as (
        delete from public.sales_day_sums_queue q
         where (q.location_id, q.business_day) in (select x.location_id, x.business_day
                                                     from public.sales_day_sums_queue x
                                                    where x.due_at <= now()
                                                    order by x.queued_at, x.location_id, x.business_day
                                                    limit v_left
                                                      for update skip locked)
        returning q.location_id, q.business_day, q.reason, q.queued_at, q.attempts
      )
      select coalesce(jsonb_agg(jsonb_build_object('t', 'sales', 'l', c.location_id, 'd', c.business_day, 'r', c.reason,
                                                   'qa', c.queued_at, 'a', c.attempts) order by c.queued_at, c.location_id, c.business_day), '[]'::jsonb)
        into v_sal
        from c;
    end if;
    v_all := v_rep || v_sal;
    if jsonb_array_length(v_all) = 0 then
      commit;
      return;
    end if;
    commit;

    for v_i in 0 .. jsonb_array_length(v_all) - 1 loop
      v_d := v_all -> v_i;
      if not pg_try_advisory_xact_lock(v_lock) then
        -- another drain took over: hand back every claimed day not rebuilt yet, as it was
        for v_j in v_i .. jsonb_array_length(v_all) - 1 loop
          v_d := v_all -> v_j;
          if v_d ->> 't' = 'stock' then
            insert into public.stock_day_sums_repair (location_id, business_day, reason, queued_at, attempts, due_at)
            values ((v_d ->> 'l')::uuid, (v_d ->> 'd')::date, v_d ->> 'r', (v_d ->> 'qa')::timestamptz, (v_d ->> 'a')::integer, now())
            on conflict (location_id, business_day) do nothing;
          else
            insert into public.sales_day_sums_queue (location_id, business_day, reason, queued_at, attempts, due_at)
            values ((v_d ->> 'l')::uuid, (v_d ->> 'd')::date, v_d ->> 'r', (v_d ->> 'qa')::timestamptz, (v_d ->> 'a')::integer, now())
            on conflict (location_id, business_day) do nothing;
          end if;
        end loop;
        commit;
        return;
      end if;
      begin
        if v_d ->> 't' = 'stock' then
          perform public.stock_day_sums_rebuild((v_d ->> 'l')::uuid, (v_d ->> 'd')::date, (v_d ->> 'd')::date);
        else
          perform public.sales_day_sums_rebuild((v_d ->> 'l')::uuid, (v_d ->> 'd')::date, (v_d ->> 'd')::date);
        end if;
      exception when others then
        v_err := left(sqlstate || ' ' || sqlerrm, 400);
        if v_d ->> 't' = 'stock' then
          insert into public.stock_day_sums_repair (location_id, business_day, reason, queued_at, attempts, due_at, last_error)
          values ((v_d ->> 'l')::uuid, (v_d ->> 'd')::date, v_d ->> 'r', (v_d ->> 'qa')::timestamptz, (v_d ->> 'a')::integer + 1,
                  now() + least(interval '1 hour', interval '1 minute' * power(2, (v_d ->> 'a')::integer)), v_err)
          on conflict (location_id, business_day) do nothing;
        else
          insert into public.sales_day_sums_queue (location_id, business_day, reason, queued_at, attempts, due_at, last_error)
          values ((v_d ->> 'l')::uuid, (v_d ->> 'd')::date, v_d ->> 'r', (v_d ->> 'qa')::timestamptz, (v_d ->> 'a')::integer + 1,
                  now() + least(interval '1 hour', interval '1 minute' * power(2, (v_d ->> 'a')::integer)), v_err)
          on conflict (location_id, business_day) do nothing;
        end if;
      end;
      commit;
    end loop;
    exit when clock_timestamp() - v_t0 > make_interval(secs => p_budget_s);
  end loop;
end
$fn$;

-- The drain every minute (the 0a pattern: any job of that exact name first goes, then it is made).
do $cron$
declare
  j record;
begin
  for j in select c.jobid from cron.job c where c.jobname = 'stock-day-sums-drain' loop
    perform cron.unschedule(j.jobid);
  end loop;
  perform cron.schedule('stock-day-sums-drain', '* * * * *', 'call public.stock_day_sums_drain();');
end
$cron$;

-- ---------------------------------------------------------------------------------------------
-- _sales_day_sums_enqueue: a check closed (insert) or changed (update; the old venue day too when
-- its venue or close time moved) queues its venue day, every venue, every source, demo ids too.
-- Waits at most 500 ms for a row the drain is claiming. Never raises: the till's close is never
-- refused or slowed for a total.
-- ---------------------------------------------------------------------------------------------
create or replace function public._sales_day_sums_enqueue()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_lt text := current_setting('lock_timeout');
begin
  begin
    perform set_config('lock_timeout', '500ms', true);
    if tg_op = 'INSERT' then
      insert into sales_day_sums_queue (location_id, business_day, reason)
      select x.loc, x.day, 'check_closed'
        from (select distinct n.location_id::uuid as loc,
                     (select d.business_day from public.stock_co__venue_day(n.location_id::uuid, n.closed_at) d) as day
                from new_rows n
               where n.location_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 and n.closed_at is not null
                 and exists (select 1 from locations l where l.id::text = n.location_id)) x
       where x.day is not null
       order by x.loc, x.day
      on conflict (location_id, business_day) do nothing;
    else
      insert into sales_day_sums_queue (location_id, business_day, reason)
      select x.loc, x.day, 'check_changed'
        from (select distinct y.location_id::uuid as loc,
                     (select d.business_day from public.stock_co__venue_day(y.location_id::uuid, y.closed_at) d) as day
                from (select n.location_id, n.closed_at from new_rows n
                      union all
                      select o.location_id, o.closed_at
                        from old_rows o
                        left join new_rows n on n.id = o.id
                       where n.id is null or o.location_id is distinct from n.location_id or o.closed_at is distinct from n.closed_at) y
               where y.location_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 and y.closed_at is not null
                 and exists (select 1 from locations l where l.id::text = y.location_id)) x
       where x.day is not null
       order by x.loc, x.day
      on conflict (location_id, business_day) do nothing;
    end if;
    perform set_config('lock_timeout', v_lt, true);
  exception when others then
    perform set_config('lock_timeout', v_lt, true);
    raise warning 'sales day totals: a closed check was not queued (% %); the nightly run rebuilds yesterday', sqlstate, sqlerrm;
  end;
  return null;
end
$fn$;

-- LAST in this part: the two closed_checks triggers (a short lock on a hot table).
create trigger closed_checks_sales_day_ins
  after insert on public.closed_checks
  referencing new table as new_rows
  for each statement execute function public._sales_day_sums_enqueue();
create trigger closed_checks_sales_day_upd
  after update on public.closed_checks
  referencing old table as old_rows new table as new_rows
  for each statement execute function public._sales_day_sums_enqueue();
-- == drainer part 5: grants, the proof, the check row ==
--
-- Every function and the procedure of this release (new and replaced, trigger functions included)
-- is revoked from public, anon, authenticated and service_role by its exact signature, then
-- granted exactly: the three rebuild and check functions and stock_drainer_health to the service
-- role (as live for the three), everything else to nobody (owner only). Then the schema reload,
-- the proof (the new rule against the v1 answers part 1 saved, on the live checks of the last 7
-- days; any difference undoes everything) and the check row, the last statement.

revoke all on function public.stock_co__option_org_guard() from public, anon, authenticated, service_role;
revoke all on function public.stock_qty_to_base(numeric, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_explode_lines(uuid, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public._stock_explode_made(uuid, uuid, numeric, text, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_explode(uuid, jsonb, text, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_explode_skipped(uuid, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public._stock_takes_share(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public._stock_outbox_apply(bigint) from public, anon, authenticated, service_role;
revoke all on function public._stock_day_sums_apply() from public, anon, authenticated, service_role;
revoke all on function public.stock_day_sums_rebuild(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public._venue_clock_requeue() from public, anon, authenticated, service_role;
revoke all on function public.stock_drainer_health(uuid) from public, anon, authenticated, service_role;
revoke all on function public._sales_js_round(double precision) from public, anon, authenticated, service_role;
revoke all on function public._sales_js_num(jsonb) from public, anon, authenticated, service_role;
revoke all on function public._sales_check_parts(public.closed_checks) from public, anon, authenticated, service_role;
revoke all on function public.sales_day_sums_rebuild(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public.sales_day_sums_check(uuid, date) from public, anon, authenticated, service_role;
revoke all on function public._sales_day_sums_enqueue() from public, anon, authenticated, service_role;
revoke all on procedure public.stock_day_sums_drain(integer, integer) from public, anon, authenticated, service_role;

grant execute on function public.stock_day_sums_rebuild(uuid, date, date) to service_role;
grant execute on function public.sales_day_sums_rebuild(uuid, date, date) to service_role;
grant execute on function public.sales_day_sums_check(uuid, date) to service_role;
grant execute on function public.stock_drainer_health(uuid) to service_role;

notify pgrst, 'reload schema';

-- ============================================================================
-- THE PROOF: the new rule gives the live answer on every live check (map 9.1)
-- ============================================================================
-- Per check: the same items with the same base quantity (numeric, no tolerance); per refund entry
-- the same; the unit_skipped flag the same; per recipe line the same base quantity (null safe).
-- Every row that differs is listed here, then the block below stops the file on any of them.
create temp table _drainer_proof_bad (
  kind         text not null,
  location_id  uuid,
  ref          text
) on commit drop;

with v2e as materialized (
  select k.location_id, k.check_id, x.inventory_item_id, x.qty_base
    from _drainer_v1_skipped k
    join public.closed_checks c on c.id = k.check_id and c.location_id = k.location_id::text
   cross join lateral public.stock_explode(k.location_id, c.items, c.order_type) x
),
de as materialized (
  select coalesce(a.location_id, b.location_id) as loc, coalesce(a.check_id, b.check_id) as chk
    from _drainer_v1_explode a
    full join v2e b on b.location_id = a.location_id and b.check_id = a.check_id and b.inventory_item_id = a.inventory_item_id
   where a.qty_base is distinct from b.qty_base
),
ds as materialized (
  select k.location_id as loc, k.check_id as chk
    from _drainer_v1_skipped k
    left join public.closed_checks c on c.id = k.check_id and c.location_id = k.location_id::text
   where (k.skipped > 0) is distinct from (public.stock_explode_skipped(k.location_id, c.items, c.order_type) > 0)
),
r1 as materialized (
  select a.location_id, a.check_id, a.refund_id, a.inventory_item_id, sum(a.qty_base) as q
    from _drainer_v1_refund a
   where a.inventory_item_id is not null
   group by a.location_id, a.check_id, a.refund_id, a.inventory_item_id
),
rs as materialized (
  select distinct a.location_id, a.check_id, a.refund_id from _drainer_v1_refund a
),
r2 as materialized (
  select rs.location_id, rs.check_id, rs.refund_id, y.inventory_item_id, sum(y.qty_base) as q
    from rs
    join public.closed_checks c on c.id = rs.check_id and c.location_id = rs.location_id::text
   cross join lateral jsonb_array_elements(case when jsonb_typeof(c.refunds) = 'array' then c.refunds else '[]'::jsonb end) as e(x)
   cross join lateral public.stock_explode(rs.location_id, public._stock_refund_lines(c.items, e.x), c.order_type, 'refundQty') y
   where jsonb_typeof(e.x) = 'object' and public.stock_js_key(e.x -> 'id') = rs.refund_id
   group by rs.location_id, rs.check_id, rs.refund_id, y.inventory_item_id
),
dr as materialized (
  select coalesce(a.location_id, b.location_id) as loc, coalesce(a.check_id, b.check_id) as chk
    from r1 a
    full join r2 b on b.location_id = a.location_id and b.check_id = a.check_id and b.refund_id = a.refund_id
                  and b.inventory_item_id = a.inventory_item_id
   where a.q is distinct from b.q
),
db as materialized (
  select b.location_id as loc, b.recipe_line_id::text as ref
    from _drainer_v1_base b
    left join public.recipe_lines x on x.id = b.recipe_line_id
   where x.id is null
      or b.base is distinct from public.stock_qty_to_base(x.qty, x.unit, x.component_item_id)
)
insert into _drainer_proof_bad (kind, location_id, ref)
select 'explode', de.loc, de.chk from de
union all
select 'skipped', ds.loc, ds.chk from ds
union all
select 'refund', dr.loc, dr.chk from dr
union all
select 'base', db.loc, db.ref from db;

do $proof$
declare
  v_n      integer;
  v_first  text;
  v_bad    text;
begin
  select count(distinct b.ref), min(b.ref) into v_n, v_first
    from _drainer_proof_bad b where b.kind in ('explode', 'skipped', 'refund');
  if v_n > 0 then
    raise exception 'The new stock rule gives a different answer on % live checks (first: %). Nothing was changed. Send this line to Claude.', v_n, v_first;
  end if;
  select count(distinct b.ref), min(b.ref) into v_n, v_first
    from _drainer_proof_bad b where b.kind = 'base';
  if v_n > 0 then
    raise exception 'The new stock rule gives a different answer on % recipe lines (first: %). Nothing was changed. Send this line to Claude.', v_n, v_first;
  end if;

  -- nothing of this release is open to the API roles
  select string_agg(s.sig, ', ' order by s.sig) into v_bad
    from unnest(array[
      'public.stock_co__option_org_guard()', 'public.stock_qty_to_base(numeric,text,uuid)',
      'public.stock_explode_lines(uuid,jsonb,text,text)', 'public._stock_explode_made(uuid,uuid,numeric,text,uuid[])',
      'public.stock_explode(uuid,jsonb,text,text)', 'public.stock_explode_skipped(uuid,jsonb,text)',
      'public._stock_takes_share(jsonb,jsonb)', 'public._stock_outbox_apply(bigint)', 'public._stock_day_sums_apply()',
      'public.stock_day_sums_rebuild(uuid,date,date)', 'public._venue_clock_requeue()', 'public.stock_drainer_health(uuid)',
      'public._sales_js_round(double precision)', 'public._sales_js_num(jsonb)', 'public._sales_check_parts(public.closed_checks)',
      'public.sales_day_sums_rebuild(uuid,date,date)', 'public.sales_day_sums_check(uuid,date)', 'public._sales_day_sums_enqueue()',
      'public.stock_day_sums_drain(integer,integer)']) as s(sig)
   where to_regprocedure(s.sig) is null
      or has_function_privilege('anon', to_regprocedure(s.sig), 'execute')
      or has_function_privilege('authenticated', to_regprocedure(s.sig), 'execute');
  if v_bad is not null then
    raise exception 'A function of this release is missing or open to the public key or a login: %. Nothing was changed. Send this line to Claude.', v_bad;
  end if;

  -- the nine triggers and the drain job
  select string_agg(e.tg, ', ' order by e.tg) into v_bad
    from (values
      ('stock_movements_day_sums_ins', 'public.stock_movements'), ('stock_movements_day_sums_upd', 'public.stock_movements'),
      ('stock_movements_day_sums_del', 'public.stock_movements'), ('closed_checks_sales_day_ins', 'public.closed_checks'),
      ('closed_checks_sales_day_upd', 'public.closed_checks'), ('venue_clock_requeue_ins', 'public.venue_clock'),
      ('venue_clock_requeue_upd', 'public.venue_clock'), ('stock_co_option_org_guard', 'public.stock_co_option_rules'),
      ('stock_co_option_org_guard', 'public.stock_co_option_rule_sites')) as e(tg, tbl)
   where not exists (select 1 from pg_trigger g where g.tgrelid = to_regclass(e.tbl) and g.tgname = e.tg and not g.tgisinternal);
  if v_bad is not null then
    raise exception 'A trigger of this release is missing: %. Nothing was changed. Send this line to Claude.', v_bad;
  end if;
  if not exists (select 1 from cron.job c where c.jobname = 'stock-day-sums-drain') then
    raise exception 'The stock-day-sums-drain job is missing. Nothing was changed. Send this line to Claude.';
  end if;
end
$proof$;

-- ============================================================================
-- THE CHECK ROW: one row per venue that holds stock. Paste it back to Claude.
-- ============================================================================
select l.name as venue,
       l.id as location_id,
       (select count(*) from _drainer_v1_skipped k where k.location_id = l.id) as checks_compared,
       (select count(*) from _drainer_v1_explode a where a.location_id = l.id) as explode_rows_compared,
       (select count(distinct b.ref) from _drainer_proof_bad b where b.location_id = l.id and b.kind = 'explode') as explode_differences,
       (select count(distinct b.ref) from _drainer_proof_bad b where b.location_id = l.id and b.kind = 'skipped') as skipped_flag_differences,
       (select count(*) from (select distinct a.check_id, a.refund_id from _drainer_v1_refund a where a.location_id = l.id) r) as refunds_compared,
       (select count(distinct b.ref) from _drainer_proof_bad b where b.location_id = l.id and b.kind = 'refund') as refund_differences,
       (select count(*) from _drainer_v1_base x where x.location_id = l.id) as recipe_lines_compared,
       (select count(distinct b.ref) from _drainer_proof_bad b where b.location_id = l.id and b.kind = 'base') as base_qty_differences,
       (select count(*)
          from (values ('drainer_v2:stock_qty_to_base', 'public.stock_qty_to_base(numeric,text,uuid)'),
                       ('drainer_v2:stock_explode', 'public.stock_explode(uuid,jsonb,text,text)'),
                       ('drainer_v2:stock_explode_skipped', 'public.stock_explode_skipped(uuid,jsonb,text)'),
                       ('drainer_v2:_stock_outbox_apply', 'public._stock_outbox_apply(bigint)'),
                       ('drainer_v2:stock_day_sums_rebuild', 'public.stock_day_sums_rebuild(uuid,date,date)'),
                       ('drainer_v2:sales_day_sums_rebuild', 'public.sales_day_sums_rebuild(uuid,date,date)'),
                       ('drainer_v2:sales_day_sums_check', 'public.sales_day_sums_check(uuid,date)')) as e(name, sig)
          join public.stock_native_backup b on b.name = e.name
          join pg_proc p on p.oid = to_regprocedure(e.sig)
         where md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) <> b.md5) as bodies_replaced,
       (select count(*) from public.stock_native_backup b where left(b.name, 11) = 'drainer_v2:') as bodies_backed_up,
       (select count(*) from unnest(array['stock_co_option_rules', 'stock_co_option_rule_sites', 'stock_sale_takes']) t(n)
         where to_regclass('public.' || t.n) is not null) as new_tables,
       exists (select 1 from information_schema.columns c
                where c.table_schema = 'public' and c.table_name = 'discounts' and c.column_name = 'kind') as discounts_kind,
       (select count(*) from pg_trigger g
         where g.tgrelid = 'public.stock_movements'::regclass and not g.tgisinternal
           and g.tgname in ('stock_movements_day_sums_ins', 'stock_movements_day_sums_upd', 'stock_movements_day_sums_del')) as day_sums_triggers,
       (select count(*) from pg_trigger g
         where g.tgrelid = 'public.closed_checks'::regclass and not g.tgisinternal
           and g.tgname in ('closed_checks_sales_day_ins', 'closed_checks_sales_day_upd')) as sales_enqueue_triggers,
       (select count(*) from pg_trigger g
         where g.tgrelid = 'public.venue_clock'::regclass and not g.tgisinternal
           and g.tgname in ('venue_clock_requeue_ins', 'venue_clock_requeue_upd')) as clock_triggers,
       (select count(*) from pg_trigger g
         where g.tgrelid in ('public.stock_co_option_rules'::regclass, 'public.stock_co_option_rule_sites'::regclass)
           and not g.tgisinternal and g.tgname = 'stock_co_option_org_guard') as option_guard_triggers,
       exists (select 1 from cron.job c where c.jobname = 'stock-day-sums-drain') as drain_job,
       exists (select 1
                 from unnest(array[
                   'public.stock_co__option_org_guard()', 'public.stock_qty_to_base(numeric,text,uuid)',
                   'public.stock_explode_lines(uuid,jsonb,text,text)', 'public._stock_explode_made(uuid,uuid,numeric,text,uuid[])',
                   'public.stock_explode(uuid,jsonb,text,text)', 'public.stock_explode_skipped(uuid,jsonb,text)',
                   'public._stock_takes_share(jsonb,jsonb)', 'public._stock_outbox_apply(bigint)', 'public._stock_day_sums_apply()',
                   'public.stock_day_sums_rebuild(uuid,date,date)', 'public._venue_clock_requeue()', 'public.stock_drainer_health(uuid)',
                   'public._sales_js_round(double precision)', 'public._sales_js_num(jsonb)', 'public._sales_check_parts(public.closed_checks)',
                   'public.sales_day_sums_rebuild(uuid,date,date)', 'public.sales_day_sums_check(uuid,date)', 'public._sales_day_sums_enqueue()',
                   'public.stock_day_sums_drain(integer,integer)']) as s(sig)
                where has_function_privilege('anon', to_regprocedure(s.sig), 'execute')
                   or has_function_privilege('authenticated', to_regprocedure(s.sig), 'execute')) as internals_open_to_api,
       (select count(*) from public.stock_sale_takes t where t.location_id = l.id) as takes_rows,
       (select count(*) from public.stock_day_sums_repair q where q.location_id = l.id) as repair_days_queued,
       (select count(*) from public.sales_day_sums_queue q where q.location_id = l.id) as sales_days_queued
  from public.locations l
 where exists (select 1 from public.inventory_items i where i.location_id = l.id)
 order by l.org_id, l.name, l.id;
