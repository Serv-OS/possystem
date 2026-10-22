-- 20261029a_OPS_reports_align.sql
-- Release 5.11.99, Reports align: every report shows the same figure by the same rule.
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  NEEDS 20261026a_OPS_stock_native_4a.sql live first (the guard refuses    #
-- #  otherwise). One transaction: any error and nothing changes.              #
-- #  Run after UK close. NEVER on 25 Oct 2026 (UK clocks) or 1 Nov 2026       #
-- #  (US clocks). Lock wait 3 s (it gives up, nothing changes).               #
-- ############################################################################
--
-- THE RULE OF RECORD is the P&L, Back Office > Reports > Daily trading (trading-report and
-- _shared/tradingSales.js tradingDays): net sales by the one sales rule, a refund off on the day it
-- was MADE, ex VAT; labour from approved and paid timesheets on the business day most of the shift
-- falls in; waste from the stock ledger; refunded food off cost once and into waste once; every
-- venue on its own business day; demo history left out. This file brings Stock and GP (and the
-- Owner app's Stock line, which reads it) and the server day sums onto that rule.
--
-- WHAT IT CHANGES
--   1. Net sales and refunds. sales_day_sums gains seven columns (sale_net, sale_theo, refund_net,
--      refund_tax, refund_gross, refund_qty, refund_cost). The day total rebuild (v3) puts every
--      refund on the day it was made, by the refund rule (_sales_refund_parts, the line for line port
--      of accountingDay.js refundParts), spread over the products it names; net is AFTER refunds and
--      theo_cost after what the refunds' own takes gave back. So every Stock and GP figure built on
--      net (GP %, waste %, comps %, labour %, the league, the dashboard, Product GP, the Owner app
--      Stock line) takes refunds off on the refund's day, ex VAT, exactly as Daily trading. The
--      closed_checks trigger also queues the refund's day; the drain rebuilds it.
--   2. Labour (stock_rp__labour): approved and paid only, on the day most of the shift falls in.
--   3. Waste, one source: the Stock and GP Waste report reads the stock ledger (stock_report_waste),
--      as the dashboard, the league, Daily trading and the Wastage log do; a waste entry that carries a
--      cost but took nothing off stock is named and never counted. The direct insert and update
--      policies on waste_events go: every screen writes waste through stock_record_waste (the row and
--      its WASTE movements together), so a row can no longer carry a cost with no ledger behind it.
--   4. Refunded food is counted once: what a refund gives back to the ledger (the unsale) comes off
--      theoretical cost on the refund's day (stock_rp__site_figures), as Daily trading takes it off COGS.
--   5. GP before and after loyalty, staff and comps (stock_rp__derive): GP after = net sales less
--      theoretical cost (which holds those plates' cost); GP before = GP after plus that cost. After is
--      never more than before.
--   One fix on the way: _sales_check_parts (the one sales rule in SQL) left a discount line with no source
--      or type key out of a check that also had a promo tender, so a 100% discount there read as a sale;
--      it now reads as accountingDay.js does.
--  10. Demo history is left out of the day totals (sales_day_sums v3), of report_day_sums (the
--      Business summary and Daily trend over a long period across sites) and of the check, by one rule:
--      _sales_is_demo (a check id starting demo-), the twin of _shared/demoHistory.js.
--
-- WHAT IT NEVER DOES
--   It writes no site row and no login. It moves no sales total while it runs: it adds the columns,
--   replaces twelve bodies (each checked by md5 first, each saved in stock_native_backup as align:<name>
--   for the rollback), and QUEUES the days to rebuild (every day a refund was made, every day holding a
--   demo check) for the drain, 15 venue days a minute, newest first, so no rebuild ever runs in this
--   transaction or in one big one during service. Until a queued day is rebuilt it reads as before
--   (and a window still holding a demo day not yet rebuilt shows its sales and GP as not known).
--
-- HOW IT RUNS
--   Paste the whole file into the SQL editor and run it once. The first statement is the guard. Then:
--     set local lock_timeout = '3s';  set local statement_timeout = '300s';
--   It checks the bodies by md5, adds the columns (a short lock on sales_day_sums, so the drain waits),
--   takes the snapshot, saves the bodies, makes the six new helpers, replaces the twelve bodies, drops the two waste_events write policies, queues the
--   rebuild, grants, compares the snapshot, and shows the check row last. Paste it back.
--
-- IF IT STOPS
--   Any error means nothing changed. A lock wait or 'deadlock detected': run it again a quiet minute
--   later. Any other words: send them to Claude.
--
-- ROLLBACK
--   20261029a_OPS_reports_align_ROLLBACK.sql (puts back the twelve bodies by md5 and the two policies,
--   drops the helpers and the seven columns, queues the same days so the old rule rebuilds them). Run
--   it before any 4a or drainer rollback.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.stock_targets') is null or to_regprocedure('public.stock_rp__site_figures(jsonb,jsonb)') is null
     or to_regprocedure('public.stock_report_waste(uuid,uuid[],date,date,jsonb,jsonb,integer)') is null
     or to_regclass('public.stock_native_backup') is null or to_regclass('public.sales_day_sums') is null
     or to_regprocedure('public.stock_day_sums_drain(integer,integer)') is null
     or to_regprocedure('public._sales_check_parts(public.closed_checks)') is null
     or to_regprocedure('public.report_day_sums(text[],date,date,jsonb)') is null
     or to_regprocedure('public._rds_ms(jsonb)') is null or to_regprocedure('public._rds_canon(text)') is null then
    raise exception 'Run 20261026a_OPS_stock_native_4a.sql first (it needs the drainer release and report_day_sums too). Nothing was changed.';
  end if;
  if to_regprocedure('public._sales_refund_parts(public.closed_checks,jsonb)') is not null
     or exists (select 1 from information_schema.columns c
                 where c.table_schema = 'public' and c.table_name = 'sales_day_sums' and c.column_name = 'refund_net')
     or exists (select 1 from public.stock_native_backup b where left(b.name, 6) = 'align:') then
    raise exception 'Reports align (20261029a) has run already. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '300s';

-- ============================================================================
-- STEP 0. THE TWELVE BODIES THIS FILE REPLACES, STILL AS LIVE (md5 of the source, white space made one space)
-- ============================================================================
do $bodies$
declare
  v_bad text;
begin
  select string_agg(e.sig, ', ' order by e.sig) into v_bad
    from (values
      ('public.sales_day_sums_rebuild(uuid,date,date)', '007c100176c9438b35c6531916555a79'),
      ('public.sales_day_sums_check(uuid,date)', '309f47ed5dc335eaea8b39fca077df25'),
      ('public._sales_check_parts(public.closed_checks)', 'e8bf29d73eb072ae3ea7320e6db8d6ed'),
      ('public._sales_day_sums_enqueue()', '35a05a622b0c4034f3a42f4fe18a6c5e'),
      ('public.report_day_sums(text[],date,date,jsonb)', '25a8daf22bd412c1a2579807d21b223c'),
      ('public.stock_rp__labour(uuid,date,date)', 'c517bbdaa5d045ee61da531288fa39df'),
      ('public.stock_rp__site_sales(jsonb)', '56b344ed1a153802e2b239a52b12b5b8'),
      ('public.stock_rp__site_figures(jsonb,jsonb)', '2682edc3b68ad1c9e1900c1ae174fe5b'),
      ('public.stock_rp__derive(uuid,jsonb)', '0e3d2aa719c32b9378a49a80567f832c'),
      ('public.stock_rp__demo_sales(uuid,date,date)', '38dc304d476f2d7892f2922cfbefdb9d'),
      ('public.stock_rp__meta(jsonb,text,date,date,boolean,text,jsonb,jsonb,jsonb)', '7dc410b654129a53de9ca72065a62bdf'),
      ('public.stock_report_waste(uuid,uuid[],date,date,jsonb,jsonb,integer)', '012537d5fb83c45c65f75ae3906cefba')
    ) as e(sig, want)
    left join pg_proc p on p.oid = to_regprocedure(e.sig)
   where p.oid is null
      or md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) is distinct from e.want;
  if v_bad is not null then
    raise exception 'A report function changed since this file was written. Ask Claude for a new file. Changed: %. Nothing was changed.', v_bad;
  end if;
  if (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = 'waste_events'
         and p.policyname in ('waste_events_ins', 'waste_events_upd')) <> 2 then
    raise exception 'The two waste_events write policies are not as written for. Ask Claude. Nothing was changed.';
  end if;
end
$bodies$;

-- ============================================================================
-- STEP 0b. THE SEVEN NEW COLUMNS of sales_day_sums (no default: a row built before tonight reads null in
-- refund_net, which is how a report knows it is still to be rebuilt)
-- ============================================================================
alter table public.sales_day_sums
  add column sale_net     numeric,
  add column sale_theo    numeric,
  add column refund_net   numeric,
  add column refund_tax   numeric,
  add column refund_gross numeric,
  add column refund_qty   numeric,
  add column refund_cost  numeric;
comment on column public.sales_day_sums.net is
  'From 20261029a (v3 rebuild): net sales AFTER refunds = sale_net - refund_net (refunds on the day they were made, ex VAT, the P&L rule). A row with refund_net null was built before and is before refunds.';
comment on column public.sales_day_sums.theo_cost is
  'From 20261029a: the sold lines'' theoretical cost less what the refunds made that day gave back by the sale''s own takes (sale_theo - refund_cost). Null when neither is known.';
comment on column public.sales_day_sums.sale_net is '20261029a: net sales of the checks that closed that day, before refunds (the one sales rule).';
comment on column public.sales_day_sums.sale_theo is '20261029a: the sold lines'' theoretical cost (stock_sale_takes), before refunds; null when no line has one.';
comment on column public.sales_day_sums.refund_net is '20261029a: refunds made that day, ex VAT (_sales_refund_parts), spread over the products each names. Never null on a row the v3 rebuild wrote.';
comment on column public.sales_day_sums.refund_tax is '20261029a: the VAT of the refunds made that day.';
comment on column public.sales_day_sums.refund_gross is '20261029a: the goods money given back that day, VAT inside, tips and service out.';
comment on column public.sales_day_sums.refund_qty is '20261029a: the quantity refunded that day.';
comment on column public.sales_day_sums.refund_cost is '20261029a: the plate cost the refunds made that day gave back, by the sale''s own takes; null when not known.';

-- ============================================================================
-- STEP 1. THE SNAPSHOT: every count and sum this file must leave alone, per venue, and the logins
-- ============================================================================
create temp table _reports_align_snap (location_id uuid, metric text, value numeric, txt text) on commit drop;
create temp table _reports_align_now (location_id uuid, metric text, value numeric, txt text) on commit drop;

create temp view _reports_align_metrics as
select l.id as location_id, m.metric, m.value
  from public.locations l
 cross join lateral (values
   ('n:inventory_items',   (select count(*) from public.inventory_items x where x.location_id = l.id)::numeric),
   ('n:stock_movements',   (select count(*) from public.stock_movements x where x.location_id = l.id)::numeric),
   ('n:stock_counts',      (select count(*) from public.stock_counts x where x.location_id = l.id)::numeric),
   ('n:waste_events',      (select count(*) from public.waste_events x where x.location_id = l.id)::numeric),
   ('n:stock_day_sums',    (select count(*) from public.stock_day_sums x where x.location_id = l.id)::numeric),
   ('n:sales_day_sums',    (select count(*) from public.sales_day_sums x where x.location_id = l.id)::numeric),
   ('s:on_hand',           (select sum(x.on_hand) from public.inventory_items x where x.location_id = l.id)),
   ('s:books',             (select sum(x.on_hand * x.current_cost) from public.inventory_items x where x.location_id = l.id)),
   ('s:mv_value',          (select sum(x.value_delta) from public.stock_movements x where x.location_id = l.id)),
   ('s:waste_cost',        (select sum(x.cost_value) from public.waste_events x where x.location_id = l.id)),
   ('s:day_value',         (select sum(x.value) from public.stock_day_sums x where x.location_id = l.id)),
   ('s:sales_net',         (select sum(x.net) from public.sales_day_sums x where x.location_id = l.id)),
   ('s:sales_theo',        (select sum(x.theo_cost) from public.sales_day_sums x where x.location_id = l.id))
 ) as m(metric, value)
 where exists (select 1 from public.sales_day_sums s where s.location_id = l.id)
    or exists (select 1 from public.inventory_items i where i.location_id = l.id);

insert into _reports_align_snap (location_id, metric, value) select * from _reports_align_metrics;
insert into _reports_align_snap (location_id, metric, value, txt)
values ('00000000-0000-0000-0000-000000000000', 'md5:user_profiles', 0,
        (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.user_profiles t)),
       ('00000000-0000-0000-0000-000000000000', 'md5:user_locations', 0,
        (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.user_locations t));

-- ============================================================================
-- STEP 2. THE BACKUP: the twelve bodies as they are tonight (pg_get_functiondef text, replayable) and
-- the two policies, in 0a's backup table as align:<name>. The rollback replays them and deletes these rows.
-- ============================================================================
insert into public.stock_native_backup (name, body, md5)
select 'align:' || p.proname, pg_get_functiondef(p.oid), md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')))
  from (values
    ('public.sales_day_sums_rebuild(uuid,date,date)'),
    ('public.sales_day_sums_check(uuid,date)'),
    ('public._sales_check_parts(public.closed_checks)'),
    ('public._sales_day_sums_enqueue()'),
    ('public.report_day_sums(text[],date,date,jsonb)'),
    ('public.stock_rp__labour(uuid,date,date)'),
    ('public.stock_rp__site_sales(jsonb)'),
    ('public.stock_rp__site_figures(jsonb,jsonb)'),
    ('public.stock_rp__derive(uuid,jsonb)'),
    ('public.stock_rp__demo_sales(uuid,date,date)'),
    ('public.stock_rp__meta(jsonb,text,date,date,boolean,text,jsonb,jsonb,jsonb)'),
    ('public.stock_report_waste(uuid,uuid[],date,date,jsonb,jsonb,integer)')
  ) as s(sig)
  join pg_proc p on p.oid = to_regprocedure(s.sig);

insert into public.stock_native_backup (name, body, md5)
select 'align:policy:' || p.policyname,
       'create policy ' || quote_ident(p.policyname) || ' on public.waste_events as ' || lower(p.permissive) || ' for ' || p.cmd
       || ' to ' || array_to_string(p.roles, ', ')
       || coalesce(' using (' || p.qual || ')', '') || coalesce(' with check (' || p.with_check || ')', ''),
       md5(coalesce(p.qual, '') || '|' || coalesce(p.with_check, ''))
  from pg_policies p
 where p.schemaname = 'public' and p.tablename = 'waste_events' and p.policyname in ('waste_events_ins', 'waste_events_upd');

do $backup_check$
begin
  if (select count(*) from public.stock_native_backup b where left(b.name, 6) = 'align:') <> 14 then
    raise exception 'The backup of the twelve bodies and two policies is not complete. Nothing was changed. Send this line to Claude.';
  end if;
end
$backup_check$;

-- ============================================================================
-- STEP 3. THE ONE DEMO RULE AND THE REFUND RULE IN SQL (new, internal)
-- ============================================================================

-- A check the demo files wrote: its id starts 'demo-'. The twin of _shared/demoHistory.js isDemoCheckId.
-- Pure, so the invoker report_day_sums can run it as the signed in user.
create or replace function public._sales_is_demo(p_id text)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $fn$
  select coalesce(left(p_id, 5) = 'demo-', false);
$fn$;

-- accountingDay.js allocate: split p_total (minor units) over the weights in proportion, whole units
-- that add up exactly (largest remainder, ties to the earlier weight, all zero weights to the first).
create or replace function public._sales_allocate(p_total bigint, p_w bigint[])
returns bigint[]
language plpgsql
immutable
set search_path = public, pg_temp
as $fn$
declare
  v_n    integer := coalesce(cardinality(p_w), 0);
  v_w    double precision[] := '{}';
  v_s    double precision := 0;
  v_t    bigint := coalesce(p_total, 0);
  v_sg   integer;
  v_a    bigint;
  v_raw  double precision;
  v_out  bigint[] := '{}';
  v_fr   double precision[] := '{}';
  v_left bigint;
  v_ord  integer[];
  v_k    integer;
  v_i    integer;
begin
  if v_n = 0 then
    return '{}';
  end if;
  for v_i in 1 .. v_n loop
    v_w := v_w || case when p_w[v_i] is not null and p_w[v_i] > 0 then p_w[v_i]::double precision else 0 end;
    v_s := v_s + v_w[v_i];
  end loop;
  if v_s <= 0 then
    for v_i in 1 .. v_n loop
      v_out := v_out || case when v_i = 1 then v_t else 0 end;
    end loop;
    return v_out;
  end if;
  v_sg := case when v_t < 0 then -1 else 1 end;
  v_a := abs(v_t);
  for v_i in 1 .. v_n loop
    v_raw := v_a::double precision * v_w[v_i] / v_s;
    v_out := v_out || floor(v_raw)::bigint;
    v_fr := v_fr || (v_raw - floor(v_raw));
  end loop;
  v_left := v_a - (select coalesce(sum(x), 0) from unnest(v_out) as x);
  select array_agg(z.i::integer order by z.f desc, z.i) into v_ord from unnest(v_fr) with ordinality as z(f, i);
  v_k := 1;
  while v_left > 0 loop
    v_out[v_ord[v_k]] := v_out[v_ord[v_k]] + 1;
    v_left := v_left - 1;
    v_k := v_k % v_n + 1;
  end loop;
  for v_i in 1 .. v_n loop
    v_out[v_i] := v_out[v_i] * v_sg;
  end loop;
  return v_out;
end
$fn$;

-- accountingDay.js tenderKind of a method already made canonical (_rds_canon).
create or replace function public._sales_kind(p_canon text)
returns text
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $fn$
  select case when p_canon in ('split', 'unallocated') then 'unallocated'
              when strpos(p_canon, 'loyalty') > 0 or strpos(p_canon, 'promo') > 0 or strpos(p_canon, 'reward') > 0 or p_canon = 'discount' then 'discount'
              when strpos(p_canon, 'cash') > 0 then 'cash'
              when strpos(p_canon, 'gift') > 0 then 'gift_card'
              when left(p_canon, 7) = 'booking' or strpos(p_canon, 'deposit') > 0 or strpos(p_canon, 'prepaid') > 0 then 'deposit'
              when p_canon ~ '(card|stripe|adyen|ryft|online|apple|google|contactless|visa|master|amex|terminal|pax|tap|credit|debit)' then 'card'
              else 'other' end;
$fn$;

-- accountingDay.js checkTenders: the tenders that paid a check, in order, with the method made
-- canonical, its kind, and the bill money and the tip each took (minor units). A row from before the
-- tenders list is read by the legacy rules (legacyTenders), as _sales_check_parts reads it, with the
-- tips where that rule puts them. A tip taken after the close lands on the first card tender when the
-- tenders fall short of the total (the US tip on receipt).
create or replace function public._sales_check_tenders(p_c public.closed_checks)
returns table (i integer, method text, kind text, amount bigint, tip bigint)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
#variable_conflict use_column
declare
  v_ms      text[] := '{}';
  v_as      bigint[] := '{}';
  v_ts      bigint[] := '{}';
  v_raw     text;
  v_tip     bigint;
  v_total   bigint;
  v_source  text;
  v_g       bigint := 0;
  v_l       bigint := 0;
  v_pr      bigint := 0;
  v_segs    text[];
  v_base    text;
  v_bms     text[] := '{}';
  v_bas     bigint[] := '{}';
  v_used    bigint;
  v_rest    bigint;
  v_t       bigint;
  v_tipleft bigint;
  v_m       text;
  v_paid    bigint;
  v_gap     bigint;
  v_short   bigint;
  v_card    integer;
  v_j       integer;
  r         record;
begin
  v_tip := greatest(0, coalesce(public._sales_js_round(p_c.tip::double precision * 100), 0))::bigint;
  v_total := greatest(0, coalesce(public._sales_js_round(p_c.total::double precision * 100), 0))::bigint;
  if jsonb_typeof(p_c.tenders) = 'array'
     and exists (select 1 from jsonb_array_elements(p_c.tenders) as y(v) where jsonb_typeof(y.v) in ('object', 'array')) then
    select coalesce(array_agg(public._rds_canon(case jsonb_typeof(y.v -> 'method') when 'string' then y.v ->> 'method' when 'number' then y.v ->> 'method'
                                   when 'boolean' then y.v ->> 'method' when 'object' then '[object Object]' else '' end) order by y.k), '{}'),
           coalesce(array_agg(greatest(0, coalesce(public._sales_js_round(public._sales_js_num(y.v -> 'amount') * 100), 0))::bigint order by y.k), '{}'),
           coalesce(array_agg(greatest(0, coalesce(public._sales_js_round(public._sales_js_num(y.v -> 'tip') * 100), 0))::bigint order by y.k), '{}')
      into v_ms, v_as, v_ts
      from jsonb_array_elements(p_c.tenders) with ordinality as y(v, k)
     where jsonb_typeof(y.v) in ('object', 'array');
    -- a tip taken after the close belongs on the card it was captured on, when the tenders fall short
    v_paid := 0;
    v_gap := v_tip;
    for v_j in 1 .. cardinality(v_ms) loop
      v_paid := v_paid + v_as[v_j] + v_ts[v_j];
      v_gap := v_gap - v_ts[v_j];
    end loop;
    v_short := coalesce(public._sales_js_round(p_c.total::double precision * 100), 0)::bigint - v_paid;
    v_card := null;
    for v_j in 1 .. cardinality(v_ms) loop
      if v_card is null and public._sales_kind(v_ms[v_j]) = 'card' then
        v_card := v_j;
      end if;
    end loop;
    if v_gap > 0 and v_short > 0 and v_card is not null then
      v_ts[v_card] := v_ts[v_card] + least(v_gap, v_short);
    end if;
  else
    v_raw := coalesce(nullif(p_c.payment_method, ''), nullif(p_c.method, ''), 'other');
    v_source := lower(coalesce(p_c.source, ''));
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
      if v_g > 0 then v_ms := v_ms || 'gift_card'::text; v_as := v_as || v_g; v_ts := v_ts || 0::bigint; end if;
      if v_l > 0 then v_ms := v_ms || 'loyalty'::text; v_as := v_as || v_l; v_ts := v_ts || 0::bigint; end if;
      if v_pr > 0 then v_ms := v_ms || 'promo'::text; v_as := v_as || v_pr; v_ts := v_ts || 0::bigint; end if;
      if v_total > 0 then v_ms := v_ms || 'card'::text; v_as := v_as || greatest(0, v_total - v_t); v_ts := v_ts || greatest(0, v_t); end if;

    elsif v_source = 'online' and strpos(coalesce(p_c.payment_method, ''), ':') = 0
          and public._rds_canon(p_c.method) in ('gift_card', 'loyalty', 'split')
          and (v_g > 0 or v_l > 0 or v_pr > 0) then
      if v_g > 0 then v_ms := v_ms || 'gift_card'::text; v_as := v_as || v_g; v_ts := v_ts || 0::bigint; end if;
      if v_l > 0 then v_ms := v_ms || 'loyalty'::text; v_as := v_as || v_l; v_ts := v_ts || 0::bigint; end if;
      if v_pr > 0 then v_ms := v_ms || 'promo'::text; v_as := v_as || v_pr; v_ts := v_ts || 0::bigint; end if;

    elsif v_raw ~* '^\s*[a-z_ ]+:\s*\d+(?:\.\d+)?\s*(?:,\s*[a-z_ ]+:\s*\d+(?:\.\d+)?\s*)*$' and strpos(v_raw, ':') > 0 then
      v_tipleft := v_tip;
      for r in
        select public._rds_canon(split_part(y.p, ':', 1)) as cm,
               coalesce(public._sales_js_round(public._sales_js_num(to_jsonb(split_part(y.p, ':', 2))) * 100), 0)::bigint as amt, y.k
          from regexp_split_to_table(v_raw, ',') with ordinality as y(p, k)
         order by y.k
      loop
        v_t := 0;
        if v_tipleft > 0 and public._sales_kind(r.cm) = 'card' then
          v_t := least(v_tipleft, r.amt);
          v_tipleft := v_tipleft - v_t;
        end if;
        v_ms := v_ms || r.cm;
        v_as := v_as || greatest(0, r.amt - v_t);
        v_ts := v_ts || greatest(0, v_t);
      end loop;

    else
      select coalesce(array_agg(z.cm order by z.k), '{}') into v_segs
        from (select public._rds_canon(y.p) as cm, y.k from regexp_split_to_table(v_raw, '\+') with ordinality as y(p, k)) z
       where z.cm <> 'other';
      if cardinality(v_segs) > 1 or v_segs[1] = 'booking' then
        v_base := v_segs[cardinality(v_segs)];
        select coalesce(array_agg(z.cm order by z.k), '{}'), coalesce(array_agg(z.amt order by z.k), '{}') into v_bms, v_bas
          from (select y.k, public._rds_canon(coalesce(y.v ->> 'method', '')) as cm,
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
            v_ts := array_fill(0::bigint, array[cardinality(v_bms)]);
          else
            v_ms := array['unallocated'];
            v_as := array[greatest(0, v_total - v_tip)];
            v_ts := array[v_tip];
          end if;
        elsif v_base = 'split'
              or exists (select 1 from unnest(v_segs[1:cardinality(v_segs) - 1]) as g(x) where g.x <> 'gift_card' and left(g.x, 7) <> 'booking') then
          v_ms := array['unallocated'];
          v_as := array[greatest(0, v_total - v_tip)];
          v_ts := array[v_tip];
        else
          if 'gift_card' = any(v_segs[1:cardinality(v_segs) - 1]) and v_g > 0 then
            v_ms := v_ms || 'gift_card'::text; v_as := v_as || v_g; v_ts := v_ts || 0::bigint;
          end if;
          if exists (select 1 from unnest(v_segs[1:cardinality(v_segs) - 1]) as g(x) where left(g.x, 7) = 'booking') then
            v_ms := v_ms || v_bms; v_as := v_as || v_bas;
            v_ts := v_ts || array_fill(0::bigint, array[cardinality(v_bms)]);
          end if;
          v_used := coalesce((select sum(g.a) from unnest(v_as) as g(a)), 0);
          v_rest := greatest(0, v_total - v_used);
          v_t := least(v_tip, v_rest);
          v_ms := v_ms || v_base; v_as := v_as || greatest(0, v_rest - v_t); v_ts := v_ts || greatest(0, v_t);
        end if;
      else
        v_m := coalesce(v_segs[1], public._rds_canon(v_raw));
        if v_m = 'split' then
          v_ms := array['unallocated'];
        else
          v_ms := array[v_m];
        end if;
        v_as := array[greatest(0, v_total - v_tip)];
        v_ts := array[v_tip];
      end if;
    end if;
  end if;
  return query
    select z.k::integer, z.m, public._sales_kind(z.m), z.a, z.t
      from unnest(v_ms, v_as, v_ts) with ordinality as z(m, a, t, k)
     order by z.k;
end
$fn$;

-- accountingDay.js refundAtMs, else the check's close time (tradingSales.js refundSalesParts): when a
-- refund entry was made.
create or replace function public._sales_refund_at(p_e jsonb, p_closed timestamptz)
returns timestamptz
language sql
stable
set search_path = public, pg_temp
as $fn$
  select coalesce(public._rds_ms(p_e -> 'timestamp'), public._rds_ms(p_e -> 'at'), public._rds_ms(p_e -> 'created_at'),
                  (select public._rds_ms(x.l -> 'at')
                     from jsonb_array_elements(case when jsonb_typeof(p_e -> 'legs') = 'array' then p_e -> 'legs' else '[]'::jsonb end)
                          with ordinality as x(l, k)
                    where jsonb_typeof(x.l) = 'object' and (jsonb_typeof(x.l -> 'at') = 'number' or (x.l ->> 'at') ~ '^[0-9]+$')
                      and public._rds_ms(x.l -> 'at') is not null
                    order by x.k limit 1),
                  p_closed);
$fn$;

-- THE REFUND RULE. One refunds[] entry of a check as Daily trading takes it off: the line for line
-- port of accountingDay.js refundParts (no tax context) and tradingSales.js refundSalesMinor, money
-- kinds only. at_ts: when it was made (else the check's close). skipped: no money went back (failed,
-- still pending, nothing to give back, a partly failed card leg left nothing, or a check that sold
-- nothing). sales_minor: the goods that went back, tax inside, tip and service share out, loyalty and
-- promo credit put back left out. tax_minor: its VAT. Net of the refund = sales_minor - tax_minor.
create or replace function public._sales_refund_parts(p_c public.closed_checks, p_e jsonb)
returns table (at_ts timestamptz, skipped boolean, sales_minor bigint, tax_minor bigint)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_at      timestamptz := public._sales_refund_at(p_e, p_c.closed_at);
  v_amount  bigint;
  v_status  text := lower(case jsonb_typeof(p_e -> 'cardStatus') when 'string' then p_e ->> 'cardStatus' when 'number' then p_e ->> 'cardStatus'
                                                                  when 'boolean' then p_e ->> 'cardStatus' else '' end);
  v_legs    jsonb;
  v_nlegs   integer;
  v_legmin  bigint;
  v_failmin bigint;
  v_total   bigint;
  v_tip     bigint;
  v_svc     bigint;
  v_tax     bigint;
  v_taxc    bigint;
  v_basis   bigint;
  v_tsum    numeric;
  v_settled numeric;
  v_ctotal  numeric;
  v_method  text;
  v_tm      text;
  v_left    bigint;
  v_tm_k    text[];
  v_tm_a    bigint[];
  v_tm_t    bigint[];
  v_sk      text[] := '{}';
  v_sg      bigint[] := '{}';
  v_ek      text[] := '{}';
  v_eg      bigint[] := '{}';
  v_out     bigint;
  v_own     bigint;
  v_beyond  bigint;
  v_g       bigint;
  v_pool    integer[] := '{}';
  v_pw      bigint[] := '{}';
  v_split   bigint[];
  v_kind    text;
  v_w       bigint[];
  v_tw      bigint[];
  v_tips    bigint[];
  v_svcs    bigint[];
  v_taxes   bigint[];
  v_paid    bigint;
  v_sales   bigint := 0;
  v_mtax    bigint := 0;
  v_j       integer;
  v_any_tw  boolean := false;
  v_charged boolean;
begin
  select p.charged_nothing into v_charged from public._sales_check_parts(p_c) as p;
  if jsonb_typeof(p_e) is distinct from 'object' then
    return query select v_at, true, 0::bigint, 0::bigint;
    return;
  end if;
  v_amount := greatest(0, coalesce(public._sales_js_round(public._sales_js_num(p_e -> 'amount') * 100), 0))::bigint;
  if p_e -> 'failed' = 'true'::jsonb then
    return query select v_at, true, 0::bigint, 0::bigint;
    return;
  end if;
  v_tm := case jsonb_typeof(p_e -> 'tenderMethod') when 'string' then p_e ->> 'tenderMethod' when 'number' then p_e ->> 'tenderMethod'
                                                   when 'boolean' then p_e ->> 'tenderMethod' else null end;
  v_method := public._rds_canon(coalesce(v_tm, ''));
  if v_status = 'pending' and v_method <> 'cash' then
    return query select v_at, true, 0::bigint, 0::bigint;
    return;
  end if;
  if v_amount <= 0 then
    return query select v_at, true, 0::bigint, 0::bigint;
    return;
  end if;

  -- the card legs (truthy entries), what went through and what failed
  v_legs := coalesce((select jsonb_agg(x.l order by x.k)
                        from jsonb_array_elements(case when jsonb_typeof(p_e -> 'legs') = 'array' then p_e -> 'legs' else '[]'::jsonb end)
                             with ordinality as x(l, k)
                       where public.stock_js_truthy(x.l)), '[]'::jsonb);
  v_nlegs := jsonb_array_length(v_legs);
  select coalesce(sum(greatest(0, coalesce(public._sales_js_round(public._sales_js_num(l -> 'amountMinor')), 0)))
                    filter (where lower(case jsonb_typeof(l -> 'status') when 'string' then l ->> 'status' else '' end) in ('succeeded', 'accepted')), 0)::bigint,
         coalesce(sum(greatest(0, coalesce(public._sales_js_round(public._sales_js_num(l -> 'amountMinor')), 0)))
                    filter (where lower(case jsonb_typeof(l -> 'status') when 'string' then l ->> 'status' else '' end) = 'failed'), 0)::bigint
    into v_legmin, v_failmin
    from jsonb_array_elements(v_legs) as l;
  if v_status in ('partial', 'failed') and v_nlegs > 0 then
    v_amount := greatest(0, v_amount - v_failmin);
    if v_amount <= 0 then
      return query select v_at, true, 0::bigint, 0::bigint;
      return;
    end if;
  elsif v_status = 'failed' then
    return query select v_at, true, 0::bigint, 0::bigint;
    return;
  end if;
  if coalesce(v_charged, false) then
    return query select v_at, true, 0::bigint, 0::bigint;
    return;
  end if;

  -- the tip and service in it
  v_total := greatest(1, coalesce(public._sales_js_round(p_c.total::double precision * 100), 0)::bigint);
  if coalesce(jsonb_typeof(p_e -> 'tipAmount'), 'null') <> 'null' or coalesce(jsonb_typeof(p_e -> 'serviceAmount'), 'null') <> 'null' then
    v_tip := greatest(0, coalesce(public._sales_js_round(public._sales_js_num(p_e -> 'tipAmount') * 100), 0))::bigint;
    v_svc := greatest(0, coalesce(public._sales_js_round(public._sales_js_num(p_e -> 'serviceAmount') * 100), 0))::bigint;
  elsif jsonb_typeof(p_e -> 'items') = 'array' and jsonb_array_length(p_e -> 'items') > 0 then
    v_tip := 0;
    v_svc := 0;
  else
    v_tip := public._sales_js_round(coalesce(public._sales_js_round(p_c.tip::double precision * 100), 0) * v_amount::double precision / v_total)::bigint;
    v_svc := public._sales_js_round(coalesce(public._sales_js_round(p_c.service::double precision * 100), 0) * v_amount::double precision / v_total)::bigint;
  end if;
  if v_tip + v_svc > v_amount then
    v_split := public._sales_allocate(v_amount, array[v_tip, v_svc]);
    v_tip := v_split[1];
    v_svc := v_split[2];
  end if;

  -- its VAT: the entry's own figure, else the check's VAT pro rata on saleVat.refundTaxBasis
  if p_c.tax_amount is not null then
    v_taxc := greatest(0, coalesce(public._sales_js_round(p_c.tax_amount::double precision * 100), 0))::bigint;
  else
    v_taxc := greatest(0, coalesce(public._sales_js_round(p_c.total::double precision * 100), 0)::bigint
                          - coalesce(public._sales_js_round(p_c.subtotal::double precision * 100), 0)::bigint
                          - coalesce(public._sales_js_round(p_c.service::double precision * 100), 0)::bigint
                          - coalesce(public._sales_js_round(p_c.tip::double precision * 100), 0)::bigint);
  end if;
  v_ctotal := coalesce(p_c.total, 0);
  if jsonb_typeof(p_c.tenders) = 'array' and jsonb_array_length(p_c.tenders) > 0 then
    select coalesce(sum(coalesce(public._sales_js_num(t -> 'amount'), 0) + coalesce(public._sales_js_num(t -> 'tip'), 0)), 0)
      into v_tsum
      from jsonb_array_elements(p_c.tenders) as t;
    v_settled := v_tsum - coalesce(p_c.tip, 0);
    v_settled := sign(v_settled) * floor(round(abs(v_settled) * 100, 6) + 0.5) / 100;
    v_basis := greatest(1, public._sales_js_round(greatest(v_ctotal, v_settled)::double precision * 100)::bigint);
  else
    v_basis := greatest(1, public._sales_js_round(v_ctotal::double precision * 100)::bigint);
  end if;
  if coalesce(jsonb_typeof(p_e -> 'taxAmount'), 'null') <> 'null' and coalesce(p_e ->> 'taxAmount', '') <> '' then
    v_tax := greatest(0, coalesce(public._sales_js_round(public._sales_js_num(p_e -> 'taxAmount') * 100), 0))::bigint;
  else
    v_tax := least(v_taxc, public._sales_js_round(v_taxc::double precision * v_amount / v_basis)::bigint);
  end if;
  v_tax := least(v_tax, v_amount - v_tip - v_svc);

  -- where the money went back
  select coalesce(array_agg(t.kind order by t.i), '{}'), coalesce(array_agg(t.amount order by t.i), '{}'), coalesce(array_agg(t.tip order by t.i), '{}')
    into v_tm_k, v_tm_a, v_tm_t
    from public._sales_check_tenders(p_c) as t;
  v_left := v_amount;
  -- 1. card reversals that went through are card money
  if v_legmin > 0 then
    v_g := least(v_left, v_legmin);
    if v_g > 0 then v_sk := v_sk || 'card'::text; v_sg := v_sg || v_g; v_left := v_left - v_g; end if;
  end if;
  -- 2. a full refund also puts back gift card and loyalty or promo credit
  if public.stock_js_truthy(p_e -> 'isFullRefund') then
    v_out := 0;
    for v_j in 1 .. coalesce(cardinality(v_tm_k), 0) loop
      v_out := v_out + v_tm_a[v_j] + v_tm_t[v_j];
    end loop;
    v_out := greatest(0, v_out - coalesce(public._sales_js_round(p_c.total::double precision * 100), 0)::bigint);
    for v_j in 1 .. coalesce(cardinality(v_tm_k), 0) loop
      if v_tm_k[v_j] in ('gift_card', 'discount') then
        v_own := v_tm_a[v_j] + v_tm_t[v_j];
        v_beyond := least(v_out, v_own);
        if v_beyond > 0 then
          v_ek := v_ek || v_tm_k[v_j]; v_eg := v_eg || v_beyond; v_out := v_out - v_beyond;
        end if;
        if v_own - v_beyond > 0 and v_left > 0 then
          v_g := least(v_left, v_own - v_beyond);
          if v_g > 0 then v_sk := v_sk || v_tm_k[v_j]; v_sg := v_sg || v_g; v_left := v_left - v_g; end if;
        end if;
      end if;
    end loop;
  end if;
  if v_left > 0 then
    if v_tm is not null and v_tm <> '' and public._sales_kind(v_method) = 'cash' then
      -- 3. staff chose cash
      v_sk := v_sk || 'cash'::text; v_sg := v_sg || v_left; v_left := 0;
    else
      -- 4. the rest to the check's remaining money tenders in proportion
      for v_j in 1 .. coalesce(cardinality(v_tm_k), 0) loop
        if not (v_nlegs > 0 and v_tm_k[v_j] = 'card') and not (v_tm_k[v_j] = any(v_sk))
           and v_tm_k[v_j] not in ('gift_card', 'discount') then
          v_pool := v_pool || v_j;
          v_pw := v_pw || case when v_tm_a[v_j] + v_tm_t[v_j] <> 0 then v_tm_a[v_j] + v_tm_t[v_j] else 1 end;
        end if;
      end loop;
      v_kind := public._sales_kind(v_method);
      if cardinality(v_pool) > 0 then
        v_split := public._sales_allocate(v_left, v_pw);
        for v_j in 1 .. cardinality(v_pool) loop
          if v_split[v_j] > 0 then
            v_sk := v_sk || v_tm_k[v_pool[v_j]]; v_sg := v_sg || v_split[v_j];
          end if;
        end loop;
        v_left := 0;
      elsif v_tm is not null and v_tm <> '' and v_kind = any(v_tm_k) and v_kind in ('card', 'cash', 'gift_card', 'deposit', 'other') then
        v_sk := v_sk || v_kind; v_sg := v_sg || v_left; v_left := 0;
      else
        v_sk := v_sk || 'unallocated'::text; v_sg := v_sg || v_left; v_left := 0;
      end if;
    end if;
  end if;

  -- tips, service and tax over the slices; tips back to cash and card first
  v_w := v_sg;
  v_tw := '{}';
  for v_j in 1 .. coalesce(cardinality(v_sk), 0) loop
    v_tw := v_tw || case when v_sk[v_j] in ('gift_card', 'discount') then 0::bigint else v_sg[v_j] end;
    if v_sk[v_j] not in ('gift_card', 'discount') and v_sg[v_j] > 0 then v_any_tw := true; end if;
  end loop;
  v_tips := public._sales_allocate(v_tip, case when v_any_tw then v_tw else v_w end);
  v_svcs := public._sales_allocate(v_svc, v_w);
  v_taxes := public._sales_allocate(v_tax, v_w);
  for v_j in 1 .. coalesce(cardinality(v_sk), 0) loop
    if v_sk[v_j] <> 'discount' then
      v_sales := v_sales + v_sg[v_j] - v_tips[v_j] - v_svcs[v_j];
      v_mtax := v_mtax + v_taxes[v_j];
    end if;
  end loop;
  -- credit put back beyond the refund amount: goods, with the check's own tax share
  if coalesce(cardinality(v_ek), 0) > 0 then
    v_paid := 0;
    for v_j in 1 .. coalesce(cardinality(v_tm_k), 0) loop
      v_paid := v_paid + v_tm_a[v_j];
    end loop;
    v_paid := greatest(1, v_paid);
    for v_j in 1 .. cardinality(v_ek) loop
      if v_ek[v_j] <> 'discount' then
        v_sales := v_sales + v_eg[v_j];
        v_mtax := v_mtax + least(v_eg[v_j], public._sales_js_round(v_taxc::double precision * v_eg[v_j] / v_paid)::bigint);
      end if;
    end loop;
  end if;
  return query select v_at, false, v_sales, v_mtax;
end
$fn$;

-- Labour from Workforce timesheets at the site, by the P&L rule (trading-report and the Owner app,
-- _shared/tradingSales.js timesheetDays): approved and paid timesheets only, their pay_amount, each on
-- the business day MOST of the shift falls in (the middle of the shift, timesheetDayMs, to the
-- millisecond; without a usable clock out, the clock in). has_data: any timesheet at all on those days.
-- 4a counted pending and draft timesheets on the day of clock in (Provo 14 Oct 2026: 638.84 against
-- the P&L's 258.11).
create or replace function public.stock_rp__labour(p_site uuid, p_from date, p_to date)
returns table(pay numeric, has_data boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with k as (select c.timezone, c.day_start from public.stock_co__clock_of(p_site) c),
  t as (
    select t.status, t.pay_amount,
           (select d.business_day
              from public.stock_co__venue_day(p_site,
                     case when t.clock_out is not null and t.clock_out > t.clock_in
                          then to_timestamp((floor(extract(epoch from t.clock_in) * 1000)
                                             + floor((floor(extract(epoch from t.clock_out) * 1000) - floor(extract(epoch from t.clock_in) * 1000)) / 2)) / 1000.0)
                          else t.clock_in end) d) as day
      from wf_timesheets t, k
     where t.location_id = p_site and t.clock_in is not null
       and t.clock_in >= public.stock_co__day_start_at(p_from, k.day_start, k.timezone) - interval '2 days'
       and t.clock_in < public.stock_co__day_start_at(p_to + 1, k.day_start, k.timezone)
  )
  select coalesce((select sum(coalesce(t.pay_amount, 0)) from t where t.status in ('approved', 'paid') and t.day between p_from and p_to), 0),
         exists (select 1 from t where t.day between p_from and p_to);
$fn$;

-- True while a window still holds a day whose stored totals were built before 20261029a AND that day
-- holds a check the demo files wrote: those totals have the demo sales inside, so the reports show its
-- sales and GP as not known, with the words, until the drain rebuilds the day (demo left out, as every
-- report does now). Once rebuilt, the day's figures show with demo history left out.
create or replace function public.stock_rp__demo_sales(p_site uuid, p_from date, p_to date)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p_site is not null and p_from is not null and p_to is not null and p_to >= p_from
     and exists (select 1
                   from public.stock_co__clock_of(p_site) k
                  cross join generate_series(p_from::timestamp, p_to::timestamp, interval '1 day') as g
                  where exists (select 1 from sales_day_sums s
                                 where s.location_id = p_site and s.business_day = g::date and s.refund_net is null)
                    and exists (select 1 from closed_checks c
                                 where c.location_id = p_site::text and c.id like 'demo-%'
                                   and c.closed_at >= public.stock_co__day_start_at(g::date, k.day_start, k.timezone)
                                   and c.closed_at < public.stock_co__day_start_at(g::date + 1, k.day_start, k.timezone)
                                   and not (c.voided is true or coalesce(c.status, '') in ('void', 'voided'))));
$fn$;

-- ============================================================================
-- STEP 4. THE DAY TOTALS: rebuild v3, check v3, the queue trigger v3, report_day_sums with demo left out
-- ============================================================================

-- sales_day_sums_rebuild v3: the v2 body word for word for the sold lines, with demo checks left out
-- (_sales_is_demo), plus the refunds MADE on each day (rf, by _sales_refund_parts), each spread over the
-- products it names by price x quantity refunded (rs), and the plate cost they gave back by the sale's
-- own takes (rc). One row per day, product and order type: net = sale_net - refund_net, theo_cost =
-- sale_theo - refund_cost.
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
  v_lo     timestamptz;
  v_hi     timestamptz;
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
  v_lo := public.stock_co__day_start_at(p_from, v_start, v_tz);
  v_hi := public.stock_co__day_start_at(p_to + 1, v_start, v_tz);
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
       and not public._sales_is_demo(c.id)
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
  ),
  -- the sold lines per day, product and order type (the v2 sums, under their own names)
  sr as (
    select s.day, s.mid, s.ot, sum(s.q) as qty, sum(s.g) as gross, sum(s.net * s.share) as net, sum(s.disc * s.share) as disc,
           sum(s.reward * s.share) as reward, sum(s.tax0 * s.share) as tax,
           sum(case when s.kind = 'loyalty' then s.q
                    when s.kind is null and s.live and s.gsum > 0 and s.credit > 0 then s.q * least(1, s.credit / s.gsum)
                    else 0 end) as lq,
           sum(case when s.kind = 'staff' then s.q else 0 end) as sq,
           sum(case when s.kind = 'comp' then s.q else 0 end) as cq,
           sum(case when s.kind = 'loyalty' then coalesce(s.c, 0)
                    when s.kind is null and s.live and s.gsum > 0 and s.credit > 0 then coalesce(s.c, 0) * least(1, s.credit / s.gsum)
                    else 0 end) as lc,
           sum(case when s.kind = 'staff' then coalesce(s.c, 0) else 0 end) as sc,
           sum(case when s.kind = 'comp' then coalesce(s.c, 0) else 0 end) as cc,
           sum(s.c) as theo
      from kd s
     group by s.day, s.mid, s.ot
  ),
  -- 20261029a: the refunds MADE on each day (the refund rule, _sales_refund_parts), from checks closed
  -- up to 400 days before, voided and demo checks never; each refunds[] entry once (its id, else its
  -- place), as Daily trading counts them
  rfe as (
    select distinct on (c.id, coalesce(nullif(e.r ->> 'id', ''), (e.n - 1)::text))
           c.id, coalesce(nullif(e.r ->> 'id', ''), (e.n - 1)::text) as rkey, coalesce(c.order_type, 'unknown') as ot,
           c.items as citems, e.r as entry, c as crow, public._sales_refund_at(e.r, c.closed_at) as at_ts
      from closed_checks c
     cross join lateral jsonb_array_elements(case when jsonb_typeof(c.refunds) = 'array' then c.refunds else '[]'::jsonb end) with ordinality as e(r, n)
     where c.location_id = p_location::text
       and c.closed_at >= v_lo - interval '400 days' and c.closed_at < v_hi
       and c.refunds is not null and c.refunds <> '[]'::jsonb
       and not (c.voided is true or coalesce(c.status, '') in ('void', 'voided'))
       and not public._sales_is_demo(c.id)
       and jsonb_typeof(e.r) = 'object'
     order by c.id, coalesce(nullif(e.r ->> 'id', ''), (e.n - 1)::text), e.n
  ),
  -- the rule worked out only for the entries made on the days being rebuilt
  rf as (
    select b.day, x.id, x.rkey, x.ot, x.citems, x.entry, p.sales_minor, p.tax_minor
      from rfe x
      join b on x.at_ts >= b.lo and x.at_ts < b.hi
     cross join lateral public._sales_refund_parts(x.crow, x.entry) as p
     where not p.skipped
  ),
  -- each refund's money over the lines it names (price x quantity refunded), else one unknown line
  rl as (
    select r.day, r.id, r.rkey, r.ot, r.sales_minor, r.tax_minor,
           coalesce(public.stock_js_key(o.l -> 'itemId'), public.stock_js_key(o.l -> 'id'), 'unknown') as mid,
           coalesce(nullif(public.stock_js_num(o.l -> 'refundQty'), 0), public.stock_js_qty(o.l -> 'qty')) as rq,
           public.stock_js_num(o.l -> 'price') * coalesce(nullif(public.stock_js_num(o.l -> 'refundQty'), 0), public.stock_js_qty(o.l -> 'qty')) as w
      from rf r
     cross join lateral jsonb_array_elements(case when jsonb_typeof(r.entry -> 'items') = 'array' then r.entry -> 'items' else '[]'::jsonb end) as o(l)
     where jsonb_typeof(o.l) = 'object'
    union all
    select r.day, r.id, r.rkey, r.ot, r.sales_minor, r.tax_minor, 'unknown', 0, 0
      from rf r
     where not exists (select 1 from jsonb_array_elements(case when jsonb_typeof(r.entry -> 'items') = 'array' then r.entry -> 'items' else '[]'::jsonb end) as y(l)
                        where jsonb_typeof(y.l) = 'object')
  ),
  rs as (
    select l.*,
           case when sum(l.w) over (partition by l.id, l.rkey) <> 0 then l.w / sum(l.w) over (partition by l.id, l.rkey)
                else 1.0 / count(*) over (partition by l.id, l.rkey) end as share
      from rl l
  ),
  -- the plate cost each refund gave back, from what the sale took (stock_sale_takes): per refunded
  -- line its cost per unit times the quantity refunded (_stock_takes_share, the drainer's own match)
  rc as (
    select r.day, r.ot, coalesce(t.m, 'unknown') as mid, sum(case when t.q > 0 then t.c / t.q * z.rq end) as cost
      from rf r
      join stock_sale_takes st on st.location_id = p_location and st.check_id = r.id
     cross join lateral (select distinct y.line_no, y.refund_qty as rq
                           from public._stock_takes_share(st.lines, public._stock_refund_lines(r.citems, r.entry)) y
                          where y.line_no is not null) z
     cross join lateral (select public.stock_js_key(x.v -> 'm') as m, public.stock_js_num(x.v -> 'q') as q, public.stock_js_num(x.v -> 'c') as c
                           from jsonb_array_elements(case when jsonb_typeof(st.lines) = 'array' then st.lines else '[]'::jsonb end) as x(v)
                          where jsonb_typeof(x.v) = 'object' and jsonb_typeof(x.v -> 'n') = 'number' and (x.v ->> 'n')::integer = z.line_no
                          limit 1) t
     group by r.day, r.ot, coalesce(t.m, 'unknown')
  ),
  rr as (
    select s.day, s.mid, s.ot,
           sum(s.sales_minor * s.share) / 100.0 as gross_back,
           sum((s.sales_minor - s.tax_minor) * s.share) / 100.0 as net_back,
           sum(s.tax_minor * s.share) / 100.0 as tax_back,
           sum(s.rq) as rq
      from rs s
     group by s.day, s.mid, s.ot
  ),
  keys as (
    select sr.day, sr.mid, sr.ot from sr
    union
    select rr.day, rr.mid, rr.ot from rr
    union
    select rc.day, rc.mid, rc.ot from rc
  )
  insert into sales_day_sums (location_id, business_day, menu_item_id, order_type, qty, gross, net, discount_spread,
                              reward_spread, tax, loyalty_qty, staff_qty, comp_qty, loyalty_cost, staff_cost, comp_cost,
                              theo_cost, clock_known, updated_at,
                              sale_net, sale_theo, refund_net, refund_tax, refund_gross, refund_qty, refund_cost)
  select p_location, k.day, k.mid, k.ot,
         coalesce(s.qty, 0), coalesce(s.gross, 0),
         coalesce(s.net, 0) - coalesce(r.net_back, 0),
         coalesce(s.disc, 0), coalesce(s.reward, 0), coalesce(s.tax, 0),
         coalesce(s.lq, 0), coalesce(s.sq, 0), coalesce(s.cq, 0), coalesce(s.lc, 0), coalesce(s.sc, 0), coalesce(s.cc, 0),
         case when s.theo is null and c.cost is null then null else coalesce(s.theo, 0) - coalesce(c.cost, 0) end,
         v_known, now(),
         coalesce(s.net, 0), s.theo, coalesce(r.net_back, 0), coalesce(r.tax_back, 0), coalesce(r.gross_back, 0), coalesce(r.rq, 0), c.cost
    from keys k
    left join sr s on s.day = k.day and s.mid = k.mid and s.ot = k.ot
    left join rr r on r.day = k.day and r.mid = k.mid and r.ot = k.ot
    left join rc c on c.day = k.day and c.mid = k.mid and c.ot = k.ot;
  get diagnostics v_rows = row_count;
  return jsonb_build_object('ok', true, 'days', p_to - p_from + 1, 'rows', v_rows);
end
$function$;

-- sales_day_sums_check v3: the v2 checks over the same checks (demo left out on every side) with the
-- sale side read from sale_net and sale_theo, plus refunds: the stored refund_net against the refund
-- rule over the refunds made that day. ok needs all seven.
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
  v_s_ref    numeric;
  v_r_ref    numeric;
  v_f1 numeric; v_f2 numeric;
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

  -- 20261029a: a row the v3 rebuild wrote (refund_net set) keeps its sale side in sale_net and
  -- sale_theo; an older row is all sale side
  select coalesce(sum(s.gross), 0), coalesce(sum(s.discount_spread), 0), coalesce(sum(s.tax), 0),
         coalesce(sum(case when s.refund_net is null then s.net else s.sale_net end), 0),
         coalesce(sum(case when s.refund_net is null then s.theo_cost else s.sale_theo end), 0),
         coalesce(sum(s.refund_net), 0)
    into v_s_gross, v_s_disc, v_s_tax, v_s_net, v_s_theo, v_s_ref
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
     and (c.voided is true or coalesce(c.status, '') in ('void', 'voided'))
     and not public._sales_is_demo(c.id);

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
     and not (c.voided is true or coalesce(c.status, '') in ('void', 'voided'))
     and not public._sales_is_demo(c.id);

  -- 20261029a: the refunds made that day by the refund rule (each entry once, as Daily trading)
  select coalesce(sum(p.sales_minor - p.tax_minor) filter (where not p.skipped), 0) / 100.0
    into v_r_ref
    from (select distinct on (c.id, coalesce(nullif(e.r ->> 'id', ''), (e.n - 1)::text)) c as crow, e.r as entry, public._sales_refund_at(e.r, c.closed_at) as at_ts
            from closed_checks c
           cross join lateral jsonb_array_elements(case when jsonb_typeof(c.refunds) = 'array' then c.refunds else '[]'::jsonb end) with ordinality as e(r, n)
           where c.location_id = p_location::text and c.closed_at >= v_lo - interval '400 days' and c.closed_at < v_hi
             and c.refunds is not null and c.refunds <> '[]'::jsonb
             and not (c.voided is true or coalesce(c.status, '') in ('void', 'voided'))
             and not public._sales_is_demo(c.id)
             and jsonb_typeof(e.r) = 'object'
           order by c.id, coalesce(nullif(e.r ->> 'id', ''), (e.n - 1)::text), e.n) x
   cross join lateral public._sales_refund_parts(x.crow, x.entry) as p
   where x.at_ts >= v_lo and x.at_ts < v_hi;

  -- the ledger's sale value of those checks that saved what they took
  select -coalesce(sum(m.value_delta), 0)
    into v_l_theo
    from stock_movements m
   where m.location_id = p_location and m.movement_type = 'SALE_DEPLETION' and m.source_type = 'closed_check'
     and m.source_id in (select c.id from closed_checks c
                          where c.location_id = p_location::text and c.closed_at >= v_lo and c.closed_at < v_hi
                            and not (c.voided is true or coalesce(c.status, '') in ('void', 'voided'))
                            and not public._sales_is_demo(c.id)
                            and exists (select 1 from stock_sale_takes t where t.location_id = p_location and t.check_id = c.id));

  v_g1 := round(v_s_gross + v_v_sub, 2);                 v_g2 := round(coalesce(v_r_gross, 0), 2);
  v_d1 := round(v_s_disc + v_v_disc, 2);                 v_d2 := round(coalesce(v_r_disc, 0), 2);
  v_o1 := round(v_v_total, 2);                           v_o2 := round(coalesce(v_r_voids, 0), 2);
  v_t1 := round(v_s_tax + v_v_tax, 2);                   v_t2 := round(coalesce(v_r_tax, 0) + coalesce(v_r_rtax, 0), 2);
  v_n1 := round(v_s_net, 2);                             v_n2 := round(v_r_net, 2);
  v_c1 := round(v_s_theo, 2);                            v_c2 := round(v_l_theo, 2);
  v_f1 := round(v_s_ref, 2);                             v_f2 := round(v_r_ref, 2);
  return jsonb_build_object('ok', v_g1 = v_g2 and v_d1 = v_d2 and v_o1 = v_o2 and v_t1 = v_t2 and v_n1 = v_n2 and v_c1 = v_c2 and v_f1 = v_f2,
                            'gross', jsonb_build_object('sums', v_g1, 'report', v_g2),
                            'discounts', jsonb_build_object('sums', v_d1, 'report', v_d2),
                            'voids', jsonb_build_object('sums', v_o1, 'report', v_o2),
                            'tax', jsonb_build_object('sums', v_t1, 'report', v_t2),
                            'net', jsonb_build_object('sums', v_n1, 'rule', v_n2),
                            'net_checked', true,
                            'theo', jsonb_build_object('sums', v_c1, 'ledger', v_c2),
                            'refunds', jsonb_build_object('sums', v_f1, 'rule', v_f2));
end
$function$;

-- _sales_day_sums_enqueue v3: the v2 body, plus the venue day of every refund on a check written with
-- refunds, or whose refunds changed. Never raises (the till's close is never refused for a total).
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
      -- 20261029a: a check written with refunds queues the venue day each refund was made
      insert into sales_day_sums_queue (location_id, business_day, reason)
      select x.loc, x.day, 'refund_made'
        from (select distinct n.location_id::uuid as loc,
                     (select d.business_day from public.stock_co__venue_day(n.location_id::uuid, public._sales_refund_at(e.r, n.closed_at)) d) as day
                from new_rows n
               cross join lateral jsonb_array_elements(case when jsonb_typeof(n.refunds) = 'array' then n.refunds else '[]'::jsonb end) as e(r)
               where n.location_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 and n.refunds is not null and n.refunds <> '[]'::jsonb and jsonb_typeof(e.r) = 'object'
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
      -- 20261029a: a check whose refunds changed (one made, refused, undone) queues the venue day of
      -- every refund it holds, before and after, so the refund lands on the day it was made
      insert into sales_day_sums_queue (location_id, business_day, reason)
      select x.loc, x.day, 'refund_made'
        from (select distinct y.location_id::uuid as loc,
                     (select d.business_day from public.stock_co__venue_day(y.location_id::uuid, public._sales_refund_at(e.r, y.closed_at)) d) as day
                from (select n.location_id, n.closed_at, n.refunds
                        from new_rows n join old_rows o on o.id = n.id
                       where o.refunds is distinct from n.refunds
                      union all
                      select o.location_id, o.closed_at, o.refunds
                        from old_rows o join new_rows n on n.id = o.id
                       where o.refunds is distinct from n.refunds) y
               cross join lateral jsonb_array_elements(case when jsonb_typeof(y.refunds) = 'array' then y.refunds else '[]'::jsonb end) as e(r)
               where y.location_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                 and y.refunds is not null and y.refunds <> '[]'::jsonb and jsonb_typeof(e.r) = 'object'
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

-- _sales_check_parts: the live body (20261023a) with one fix: when a row has a promo tender, a discount
-- line with no source or type key is still a money discount (accountingDay.js moneyDiscounts keeps it; the
-- missing key read as null and left the line out, so a 100% discount beside a promo tender was a sale).
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
                                  and (coalesce(d.v -> 'source' = '"promo"'::jsonb, false) or coalesce(d.v -> 'type' = '"promo"'::jsonb, false)))), 0)::bigint;
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

-- report_day_sums: the live body (20261005b) with the checks the demo files wrote left out of the sales
-- and the refunds (_sales_is_demo). Every other line is as live, but for the time zone test, written
-- without the not match operator (the same test).
create or replace function public.report_day_sums(p_location_ids text[], p_from date, p_to date,
                                                  p_clocks jsonb default '{}'::jsonb)
returns table (
  location_id          text,
  business_day         date,
  currency             text,
  timezone             text,
  day_start            text,
  stored_timezone      text,
  checks               bigint,
  voided_checks        bigint,
  covers               bigint,
  gross                numeric,
  discounts            numeric,
  voids                numeric,
  refunds              numeric,
  refunds_items        numeric,
  refunds_tip          numeric,
  refunds_service      numeric,
  refunds_tax          numeric,
  net_sales            numeric,
  tax                  numeric,
  service              numeric,
  tips                 numeric,
  delivery_fees        numeric,
  total                numeric,
  by_tender            jsonb,
  by_method            jsonb,
  by_order_type        jsonb,
  by_source            jsonb,
  refunds_made         numeric,
  refunds_made_tip     numeric,
  refunds_made_service numeric,
  refunds_made_tax     numeric,
  refunds_made_count   bigint
)
language plpgsql
stable
security invoker
set search_path = public
as $fn$
#variable_conflict use_column
declare
  v_ids    text[];
  v_tzs    text[] := '{}';
  v_mins   integer[] := '{}';
  v_id     text;
  v_tz     text;
  v_start  text;
  v_m      text[];
  v_i      integer;
  v_min    integer;
  v_iv     interval;
  v_n      integer;
  v_bounds timestamptz[];
  v_lo     timestamptz;
  v_hi     timestamptz;
  v_cur    text;
  v_stored text;
begin
  -- 20261005b. A paired till, kiosk or screen is an anonymous session: reports are for
  -- signed in Back Office users. (anon, the public key, has no right to run this at all.)
  if public.is_anon_session() then
    raise exception 'Reports need a Back Office sign in.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'report_day_sums: from and to must be dates, from first.' using errcode = '22023';
  end if;
  if p_to - p_from > 400 then
    raise exception 'report_day_sums: at most 400 days at a time.' using errcode = '22023';
  end if;
  select array_agg(x order by x) into v_ids
    from (select distinct u.x from unnest(coalesce(p_location_ids, '{}')) as u(x) where u.x is not null and u.x <> '') q;
  if v_ids is null then
    return;
  end if;
  if array_length(v_ids, 1) > 100 then
    raise exception 'report_day_sums: at most 100 sites at a time.' using errcode = '22023';
  end if;

  -- Every site needs its own clock. No day is ever cut on a guessed one. All are checked
  -- before anything is read, so a bad clock answers an error, never half a report.
  foreach v_id in array v_ids loop
    v_tz := p_clocks -> v_id ->> 'tz';
    v_start := p_clocks -> v_id ->> 'day_start';
    -- A real zone name ('Europe/London', or 'UTC'), and one this Postgres knows. Asked by
    -- using it: looking it up in pg_timezone_names reads the whole zone folder, 25 ms a time.
    if v_tz is null or not (v_tz ~ '^(UTC|[A-Za-z_]+(/[A-Za-z0-9_+-]+)+)$') then
      raise exception 'report_day_sums: no usable time zone for site %.', v_id using errcode = '22023';
    end if;
    if not (v_tz = any (v_tzs)) then
      begin
        perform timestamp '2026-01-01 12:00' at time zone v_tz;
      exception when others then
        raise exception 'report_day_sums: no usable time zone for site %.', v_id using errcode = '22023';
      end;
    end if;
    v_m := regexp_match(coalesce(v_start, ''), '^\s*([0-9]{1,2}):([0-9]{2})(:[0-9]{2})?\s*$');
    if v_m is null or v_m[1]::integer > 23 or v_m[2]::integer > 59 then
      raise exception 'report_day_sums: no usable business day start for site %.', v_id using errcode = '22023';
    end if;
    v_tzs := v_tzs || v_tz;
    v_mins := v_mins || (v_m[1]::integer * 60 + v_m[2]::integer);
  end loop;

  v_n := p_to - p_from + 1;

  -- One site at a time, each over ITS OWN window. One site is one short walk along the
  -- (location_id, closed_at) index, whatever the planner thinks of the rest of the table.
  for v_i in 1 .. array_length(v_ids, 1) loop
    v_id := v_ids[v_i];
    v_tz := v_tzs[v_i];
    v_min := v_mins[v_i];
    v_iv := make_interval(mins => v_min);

    -- Where each business day starts, as real instants, from the day before the range to two
    -- days after it: v_bounds[k] is the start of (p_from - 2 + k). Days are contiguous by
    -- construction: a day ends exactly where the next begins.
    select array_agg(public._rds_wall(p_from - 1 + g, v_min, v_tz) order by g) into v_bounds
      from generate_series(0, v_n + 2) as g;
    v_lo := v_bounds[2];
    v_hi := v_bounds[v_n + 2];

    v_cur := null; v_stored := null;
    select l.currency::text, l.timezone::text into v_cur, v_stored from public.locations l where l.id::text = v_id;

    return query
    with
    -- A. One line per check that CLOSED in the window, with everything the sums need.
    -- Built in three small steps ("offset 0" keeps Postgres from folding them together, so
    -- each value is worked out once per check, not once per place it is used).
    chk as (
      select w.d0 + case when w.closed_at < v_bounds[w.d0 - p_from + 2] then -1
                         when w.closed_at >= v_bounds[w.d0 - p_from + 3] then 1
                         else 0 end as bday,
             w.is_void, w.sub, w.tot, w.svc, w.tip, w.tax0, w.cov, w.disc,
             coalesce(w.rv[1], 0) as r_amt, coalesce(w.rv[2], 0) as r_tip,
             coalesce(w.rv[3], 0) as r_svc, coalesce(w.rv[4], 0) as r_tax,
             w.fee,
             -- reports/Payments.jsx bucket()
             case when w.m = 'cash' then 'cash'
                  when w.m = 'card' then 'card'
                  when w.m like '%apple%' then 'apple-pay'
                  when w.m like '%google%' then 'google-pay'
                  when w.m like '%split%' then 'split'
                  when w.m like '%stripe%' or w.m like '%terminal%'
                    or w.m like '%contactless%' or w.m like '%chip%' then 'card'
                  when w.m = '' then 'other'
                  else w.m end as mkey,
             w.okey, w.skey,
             -- The money by what paid, pence. A voided check's money is never counted.
             case when w.is_void then 0 when w.b1 is null then coalesce(w.tx[1], 0)
                  when w.b1 = 'card' then w.a1 + w.t1
                       -- A tip taken AFTER the close (US tip on the receipt) raises tip and total,
                       -- not the tenders: it goes on the card, only while the tenders fall short.
                       + case when w.tip_p - w.t1 > 0 and w.tot_p - (w.a1 + w.t1) > 0
                              then least(w.tip_p - w.t1, w.tot_p - (w.a1 + w.t1)) else 0 end
                  else 0 end as t_card,
             case when w.is_void then 0 when w.b1 is null then coalesce(w.tx[2], 0) when w.b1 = 'cash' then w.a1 + w.t1 else 0 end as t_cash,
             case when w.is_void then 0 when w.b1 is null then coalesce(w.tx[3], 0) when w.b1 = 'gift_card' then w.a1 + w.t1 else 0 end as t_gift,
             case when w.is_void then 0 when w.b1 is null then coalesce(w.tx[4], 0) when w.b1 = 'loyalty' then w.a1 + w.t1 else 0 end as t_loy,
             case when w.is_void then 0 when w.b1 is null then coalesce(w.tx[5], 0) when w.b1 = 'other' then w.a1 + w.t1 else 0 end as t_other
        from (
          select q.*,
                 -- Most checks have no discount and no refund: the lists are only opened when there is one.
                 case when q.discounts is null or q.discounts = '[]'::jsonb or jsonb_typeof(q.discounts) <> 'array' then 0
                      else (select coalesce(sum(coalesce(nullif(public._rds_num(d -> 'amount'), 0),
                                                         nullif(public._rds_num(d -> 'value'), 0), 0)), 0)
                              from jsonb_array_elements(q.discounts) as d) end as disc,
                 case when q.refunds is null or q.refunds = '[]'::jsonb or jsonb_typeof(q.refunds) <> 'array' then null
                      else (select array[sum(public._rds_num(r -> 'amount')), sum(public._rds_num(r -> 'tipAmount')),
                                         sum(public._rds_num(r -> 'serviceAmount')), sum(public._rds_num(r -> 'taxAmount'))]
                              from jsonb_array_elements(q.refunds) as r) end as rv,
                 -- The usual check has ONE tender: read straight off the row (b1, a1, t1).
                 case when q.one then
                        case q.t0 ->> 'method' when 'card' then 'card' when 'cash' then 'cash'
                                               when 'loyalty' then 'loyalty' when 'gift_card' then 'gift_card'
                                               else public._rds_tender_bucket(q.t0 ->> 'method') end end as b1,
                 case when q.one then greatest(0, round(public._rds_num(q.t0 -> 'amount') * 100)) end as a1,
                 case when q.one then greatest(0, round(public._rds_num(q.t0 -> 'tip') * 100)) end as t1,
                 case
                   when q.one or q.is_void then null
                   -- Several tenders: { card, cash, gift_card, loyalty, other }.
                   when q.tn > 1 and exists (select 1 from jsonb_array_elements(q.tenders) as e where jsonb_typeof(e) = 'object') then
                     (select array[coalesce(sum(z.a + z.t) filter (where z.b = 'card'), 0)
                                     + case when count(*) filter (where z.b = 'card') > 0
                                             and q.tip_p - sum(z.t) > 0 and q.tot_p - sum(z.a + z.t) > 0
                                            then least(q.tip_p - sum(z.t), q.tot_p - sum(z.a + z.t)) else 0 end,
                                   coalesce(sum(z.a + z.t) filter (where z.b = 'cash'), 0),
                                   coalesce(sum(z.a + z.t) filter (where z.b = 'gift_card'), 0),
                                   coalesce(sum(z.a + z.t) filter (where z.b = 'loyalty'), 0),
                                   coalesce(sum(z.a + z.t) filter (where z.b = 'other'), 0)]
                        from (select public._rds_tender_bucket(e ->> 'method') as b,
                                     greatest(0, round(public._rds_num(e -> 'amount') * 100)) as a,
                                     greatest(0, round(public._rds_num(e -> 'tip') * 100)) as t
                                from jsonb_array_elements(q.tenders) as e
                               where jsonb_typeof(e) = 'object') z)
                   -- Written before tenders (old rows, and the kiosk): the legacy rules.
                   else (select array[(j.j ->> 'card')::numeric, (j.j ->> 'cash')::numeric, (j.j ->> 'gift_card')::numeric,
                                      (j.j ->> 'loyalty')::numeric, (j.j ->> 'other')::numeric]
                           from (select public._rds_legacy_tenders(q.method, q.payment_method, q.source, q.raw_total, q.raw_tip,
                                                                   q.gift_card, q.loyalty, q.promo, q.payment_intents) as j) j)
                 end as tx
            from (
              select c.closed_at, c.discounts, c.refunds, c.tenders, c.method, c.payment_method, c.source,
                     c.total as raw_total, c.tip as raw_tip,
                     c.gift_card, c.loyalty, c.promo, c.payment_intents,
                     ((c.closed_at at time zone v_tz) - v_iv)::date as d0,
                     -- coalesce: status may be empty (the column allows it). "empty in (...)" is
                     -- neither yes nor no in SQL, and such a check would count as neither a sale
                     -- nor a void. The reports count it as a sale, so this must too.
                     (c.voided is true or coalesce(c.status, '') in ('void', 'voided')) as is_void,
                     lower(coalesce(c.method, '')) as m,
                     coalesce(c.subtotal, 0) as sub, coalesce(c.total, 0) as tot,
                     coalesce(c.service, 0) as svc, coalesce(c.tip, 0) as tip,
                     case when c.tax_amount is not null then c.tax_amount
                          else greatest(0, coalesce(c.total, 0) - coalesce(c.subtotal, 0) - coalesce(c.service, 0) - coalesce(c.tip, 0)) end as tax0,
                     case when coalesce(c.covers, 0) = 0 then 1 else c.covers end as cov,
                     case when c.customer is null then 0 else public._rds_num(c.customer -> 'delivery_fee') end as fee,
                     -- reports/OrderTypes.jsx
                     coalesce(nullif(c.order_type, ''), 'dine-in') as okey,
                     -- reports/OrderSources.jsx srcKey
                     case when c.source = 'hubrise' then coalesce(nullif(c.customer ->> 'channel', ''), 'Delivery channel')
                          when c.source in ('kiosk', 'online', 'qr', 'catering') then c.source
                          else 'pos' end as skey,
                     greatest(0, round(coalesce(c.tip, 0) * 100)) as tip_p,
                     round(coalesce(c.total, 0) * 100) as tot_p,
                     case when jsonb_typeof(c.tenders) = 'array' then jsonb_array_length(c.tenders) else 0 end as tn,
                     c.tenders -> 0 as t0,
                     (jsonb_typeof(c.tenders) = 'array' and jsonb_array_length(c.tenders) = 1
                        and jsonb_typeof(c.tenders -> 0) = 'object') is true as one
                from public.closed_checks c
               where c.location_id = v_id and c.closed_at >= v_lo and c.closed_at < v_hi
                 and not public._sales_is_demo(c.id)
              offset 0
            ) q
          offset 0
        ) w
    ),
    -- Add up once per day and per (method, order type, source) mix, then roll that small
    -- table up four ways: the day, and the day by each of the three.
    pre as (
      select k.bday, k.mkey, k.okey, k.skey,
             count(*) filter (where not k.is_void) as checks,
             count(*) filter (where k.is_void) as voided_checks,
             coalesce(sum(k.cov) filter (where not k.is_void), 0) as covers,
             sum(k.sub) as gross, sum(k.disc) as discounts,
             coalesce(sum(k.tot) filter (where k.is_void), 0) as voids,
             sum(k.r_amt) as refunds, sum(k.r_tip) as refunds_tip, sum(k.r_svc) as refunds_service, sum(k.r_tax) as refunds_tax,
             sum(k.tax0 - k.r_tax) as tax, sum(k.svc - k.r_svc) as service, sum(k.tip - k.r_tip) as tips,
             sum(k.fee) as delivery_fees, sum(k.tot) as total,
             coalesce(sum(k.tot) filter (where not k.is_void), 0) as live_total,
             coalesce(sum(k.tip) filter (where not k.is_void), 0) as live_tip,
             sum(k.t_card) as t_card, sum(k.t_cash) as t_cash, sum(k.t_gift) as t_gift,
             sum(k.t_loy) as t_loy, sum(k.t_other) as t_other
        from chk k
       group by k.bday, k.mkey, k.okey, k.skey
    ),
    agg as (
      select k.bday, k.mkey, k.okey, k.skey,
             grouping(k.mkey, k.okey, k.skey) as g,
             sum(k.checks)::bigint as checks, sum(k.voided_checks)::bigint as voided_checks, sum(k.covers)::bigint as covers,
             sum(k.gross) as gross, sum(k.discounts) as discounts, sum(k.voids) as voids,
             sum(k.refunds) as refunds, sum(k.refunds_tip) as refunds_tip,
             sum(k.refunds_service) as refunds_service, sum(k.refunds_tax) as refunds_tax,
             sum(k.tax) as tax, sum(k.service) as service, sum(k.tips) as tips,
             sum(k.delivery_fees) as delivery_fees, sum(k.total) as total,
             sum(k.live_total) as live_total, sum(k.live_tip) as live_tip,
             sum(k.t_card) as t_card, sum(k.t_cash) as t_cash, sum(k.t_gift) as t_gift,
             sum(k.t_loy) as t_loy, sum(k.t_other) as t_other
        from pre k
       group by grouping sets ((k.bday), (k.bday, k.mkey), (k.bday, k.okey), (k.bday, k.skey))
    ),
    dims as (
      select a.bday,
             coalesce(jsonb_object_agg(a.mkey, jsonb_build_object('checks', a.checks, 'revenue', a.live_total, 'tips', a.live_tip))
                        filter (where a.g = 3 and a.checks > 0), '{}'::jsonb) as by_method,
             coalesce(jsonb_object_agg(a.okey, jsonb_build_object('checks', a.checks, 'revenue', a.live_total))
                        filter (where a.g = 5 and a.checks > 0), '{}'::jsonb) as by_order_type,
             coalesce(jsonb_object_agg(a.skey, jsonb_build_object('checks', a.checks, 'revenue', a.live_total))
                        filter (where a.g = 6 and a.checks > 0), '{}'::jsonb) as by_source
        from agg a
       where a.g <> 7
       group by a.bday
    ),
    -- B. Refunds on the day they were MADE. Checks closed up to 400 days before the window
    -- (the accounting layer's lookback, 9600 hours) that carry a refund.
    rent as (
      select distinct on (c.id, coalesce(nullif(e.r ->> 'id', ''), (e.n - 1)::text))
             coalesce(public._rds_ms(e.r -> 'timestamp'), public._rds_ms(e.r -> 'at'), public._rds_ms(e.r -> 'created_at'),
                      (select public._rds_ms(x.l -> 'at')
                         from jsonb_array_elements(case when jsonb_typeof(e.r -> 'legs') = 'array' then e.r -> 'legs' else '[]'::jsonb end)
                              with ordinality as x(l, i)
                        where public._rds_ms(x.l -> 'at') is not null
                        order by x.i limit 1),
                      c.closed_at) as at_ts,
             e.r as entry, c.total, c.subtotal, c.tip, c.service, c.tax_amount
        from public.closed_checks c
       cross join lateral jsonb_array_elements(case when jsonb_typeof(c.refunds) = 'array' then c.refunds else '[]'::jsonb end)
                          with ordinality as e(r, n)
       where c.location_id = v_id and c.closed_at >= v_lo - interval '9600 hours' and c.closed_at < v_hi
         and c.refunds is not null and c.refunds <> '[]'::jsonb
         and not public._sales_is_demo(c.id)
         and not (c.voided is true or coalesce(c.status, '') in ('void', 'voided'))
         and jsonb_typeof(e.r) = 'object'
       order by c.id, coalesce(nullif(e.r ->> 'id', ''), (e.n - 1)::text), e.n
    ),
    made as (
      select y.d0 + case when y.at_ts < v_bounds[y.d0 - p_from + 2] then -1
                         when y.at_ts >= v_bounds[y.d0 - p_from + 3] then 1
                         else 0 end as bday,
             round(sum(p.amount) / 100.0, 2) as amount, round(sum(p.tip) / 100.0, 2) as tip,
             round(sum(p.service) / 100.0, 2) as service, round(sum(p.tax) / 100.0, 2) as tax, count(*) as n
        from (select r.*, ((r.at_ts at time zone v_tz) - v_iv)::date as d0
                from rent r where r.at_ts >= v_lo and r.at_ts < v_hi) y
       cross join lateral public._rds_refund(y.entry, y.total, y.subtotal, y.tip, y.service, y.tax_amount) as p
       where p.counted
       group by 1
    )
    select v_id,
           coalesce(a.bday, m.bday),
           v_cur, v_tz,
           lpad((v_min / 60)::text, 2, '0') || ':' || lpad((v_min % 60)::text, 2, '0'),
           v_stored,
           coalesce(a.checks, 0), coalesce(a.voided_checks, 0), coalesce(a.covers, 0),
           coalesce(a.gross, 0), coalesce(a.discounts, 0), coalesce(a.voids, 0),
           coalesce(a.refunds, 0),
           coalesce(a.refunds - a.refunds_tip - a.refunds_service, 0),
           coalesce(a.refunds_tip, 0), coalesce(a.refunds_service, 0), coalesce(a.refunds_tax, 0),
           coalesce(a.gross - a.discounts - a.voids - (a.refunds - a.refunds_tip - a.refunds_service), 0),
           coalesce(a.tax, 0), coalesce(a.service, 0), coalesce(a.tips, 0),
           coalesce(a.delivery_fees, 0), coalesce(a.total, 0),
           jsonb_build_object('card', round(coalesce(a.t_card, 0) / 100.0, 2), 'cash', round(coalesce(a.t_cash, 0) / 100.0, 2),
                              'gift_card', round(coalesce(a.t_gift, 0) / 100.0, 2), 'loyalty', round(coalesce(a.t_loy, 0) / 100.0, 2),
                              'other', round(coalesce(a.t_other, 0) / 100.0, 2)),
           coalesce(d.by_method, '{}'::jsonb), coalesce(d.by_order_type, '{}'::jsonb), coalesce(d.by_source, '{}'::jsonb),
           coalesce(m.amount, 0), coalesce(m.tip, 0), coalesce(m.service, 0), coalesce(m.tax, 0), coalesce(m.n, 0)
      from (select * from agg where g = 7) a
      full join made m on m.bday = a.bday
      left join dims d on d.bday = a.bday
     order by 2;
  end loop;
end
$fn$;

-- ============================================================================
-- STEP 5. STOCK AND GP: net after refunds, the unsale off cost, labour, GP before and after, demo, waste
-- ============================================================================

-- stock_rp__site_sales: the 4a body; theo is the sold lines' cost (sale_theo on a v3 row), before refunds:
-- what refunds gave back comes off in stock_rp__site_figures from the ledger, as Daily trading does.
create or replace function public.stock_rp__site_sales(p_windows jsonb)
returns table(location_id uuid, sales_net numeric, sales_gross numeric, sold_qty numeric, theo_cost numeric,
              loyalty_cost numeric, staff_cost numeric, comp_cost numeric, loyalty_qty numeric, staff_qty numeric, comp_qty numeric,
              with_recipe_net numeric, no_recipe_net numeric, products integer, known_net numeric, pre_rows integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with g as (
    select w.location_id, s.menu_item_id,
           sum(s.net) as net, sum(s.gross) as gross, sum(s.qty) as qty,
           sum(case when s.refund_net is null then s.theo_cost else s.sale_theo end) filter (where s.business_day >= w.takes_from) as theo,
           sum(s.loyalty_cost) filter (where s.business_day >= w.takes_from) as lc,
           sum(s.staff_cost) filter (where s.business_day >= w.takes_from) as sc,
           sum(s.comp_cost) filter (where s.business_day >= w.takes_from) as cc,
           sum(s.loyalty_qty) as lq, sum(s.staff_qty) as sq, sum(s.comp_qty) as cq,
           sum(s.net) filter (where s.business_day >= w.takes_from) as kn,
           count(*) filter (where w.takes_from is null or s.business_day < w.takes_from) as pre
      from jsonb_to_recordset(p_windows) as w(location_id uuid, from_day date, to_day date, takes_from date)
      join sales_day_sums s on s.location_id = w.location_id and s.business_day between w.from_day and w.to_day
     where w.from_day is not null
     group by w.location_id, s.menu_item_id
  )
  select g.location_id, sum(g.net), sum(g.gross), sum(g.qty), sum(g.theo), sum(g.lc), sum(g.sc), sum(g.cc), sum(g.lq), sum(g.sq), sum(g.cq),
         sum(g.net) filter (where r.menu_item_id is not null), sum(g.net) filter (where r.menu_item_id is null), count(*)::integer,
         sum(g.kn), sum(g.pre)::integer
    from g
    left join menu_item_recipes r on r.location_id = g.location_id and r.menu_item_id = g.menu_item_id
   group by g.location_id;
$fn$;

-- stock_rp__site_figures: the 4a body; theoretical cost less the unsale of the window (the ledger's
-- SALE_DEPLETION from closed_check_refund, demo left out, on the refund's day); product_theo is the
-- products' cost after their refunds' own takes (what Product GP adds up).
create or replace function public.stock_rp__site_figures(p_g jsonb, p_windows jsonb)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with w as (
    select (x ->> 'location_id')::uuid as loc, x ->> 'site' as site, x ->> 'currency' as currency,
           (x ->> 'from_day')::date as from_day, (x ->> 'to_day')::date as to_day,
           coalesce((x ->> 'opening_counted')::boolean, false) as oc, coalesce((x ->> 'closing_counted')::boolean, false) as cc,
           coalesce((x ->> 'window_missing')::boolean, false) as wm, coalesce((x ->> 'snapshot')::boolean, false) as has_snap,
           case when jsonb_typeof(x -> 'snap') = 'object' then x -> 'snap' end as snap,
           (x ->> 'takes_from')::date as takes_from,
           coalesce((x ->> 'demo_sales')::boolean, false) and jsonb_typeof(x -> 'snap') is distinct from 'object' as sd
      from jsonb_array_elements(p_windows) x
  ),
  led as (
    select l.location_id,
           coalesce(sum(l.value) filter (where l.bucket = 'received'), 0) as received,
           coalesce(sum(l.value) filter (where l.bucket = 'transfer_in'), 0) as transfers_in,
           coalesce(-sum(l.value) filter (where l.bucket = 'transfer_out'), 0) as transfers_out,
           coalesce(sum(l.value) filter (where l.bucket = 'made'), 0) as made,
           coalesce(-sum(l.value) filter (where l.bucket = 'used'), 0) as used,
           coalesce(-sum(l.value) filter (where l.bucket = 'sold'), 0) as sold,
           coalesce(-sum(l.value) filter (where l.bucket = 'waste'), 0) as waste,
           coalesce(sum(l.value) filter (where l.bucket = 'revalue'), 0) as revalue,
           coalesce(sum(l.value) filter (where l.bucket = 'count_adj'), 0) as count_adj,
           coalesce(sum(l.pos_value) filter (where l.bucket = 'count_adj'), 0) as surplus,
           coalesce(sum(l.neg_value) filter (where l.bucket = 'count_adj'), 0) as unaccounted,
           coalesce(sum(l.value) filter (where l.bucket = 'opening_balance'), 0) as opening_balance,
           coalesce(sum(l.value) filter (where l.bucket = 'other'), 0) as other,
           coalesce(-sum(l.qty) filter (where l.bucket = 'sold'), 0) as sold_units
      from public.stock_rp__site_ledger_split(p_windows) l
     group by l.location_id
  ),
  sal as (select * from public.stock_rp__site_sales(p_windows)),
  -- 20261029a: what refunds gave back to the ledger in the window (the unsale, on the day of the
  -- refund, demo left out): it comes OFF theoretical cost, as Daily trading takes it off COGS. The
  -- refunded food is booked as waste the same moment, so it is counted once, in waste. A void's unsale
  -- (key unsale:<check>:void:<item>) is left out: a voided check's sale is in no day total either.
  uns as (
    select w.loc as location_id, sum(m.value_delta) as v
      from w
     cross join lateral public.stock_co__clock_of(w.loc) k
      join stock_movements m on m.location_id = w.loc and m.movement_type = 'SALE_DEPLETION' and m.source_type = 'closed_check_refund'
                            and m.occurred_at >= public.stock_co__day_start_at(w.from_day, k.day_start, k.timezone)
                            and m.occurred_at < public.stock_co__day_start_at(w.to_day + 1, k.day_start, k.timezone)
     where w.from_day is not null
       and not public.stock_rp__is_demo(m.idempotency_key)
       and coalesce(m.idempotency_key, '') not like 'unsale:%:void:%'
       and coalesce(m.idempotency_key, '') not like 'undo:unsale:%:void:%'
     group by w.loc
  ),
  -- the products' plate cost after the refunds' own takes (what Product GP adds up), from takes_from
  pth as (
    select w.loc as location_id, sum(s.theo_cost) as v
      from w
      join sales_day_sums s on s.location_id = w.loc and s.business_day between w.from_day and w.to_day and s.business_day >= w.takes_from
     where w.from_day is not null and w.takes_from is not null
     group by w.loc
  ),
  olds as (select * from public.stock_rp__site_old_sold(p_windows)),
  oc as (select * from public.stock_rp__open_close(p_windows)),
  now_v as (select * from public.stock_rp__site_value_at(array(select w.loc from w), current_date + 2)),
  du as (select * from public.stock_rp__daily_use(array(select w.loc from w))),
  live as (
    select w.loc, w.site, w.currency, w.from_day, w.to_day, w.oc, w.cc, w.wm, w.has_snap, w.snap, w.takes_from, w.sd,
           case when w.sd or w.takes_from is null or w.takes_from > w.to_day then null else greatest(w.from_day, w.takes_from) end as known_from,
           case when w.sd then null else public.stock_rp__snap_num(w.snap, 'sales_net', coalesce(s.sales_net, 0)) end as sales_net,
           case when w.sd then null else coalesce(s.sales_gross, 0) end as sales_gross,
           case when w.sd then null else coalesce(s.sold_qty, 0) end as sold_qty,
           case when w.sd then null else coalesce(s.with_recipe_net, 0) end as with_recipe_net,
           case when w.sd then null else coalesce(s.no_recipe_net, 0) end as no_recipe_net,
           case when w.sd then null else coalesce(s.products, 0) end as products,
           case when w.sd then null else coalesce(pt.v, 0) end as product_theo,
           case when w.sd then null else coalesce(s.known_net, 0) end as known_net,
           case when w.sd then null else public.stock_rp__snap_num(w.snap, 'theo_cost', coalesce(od.sold, 0) + coalesce(s.theo_cost, 0) - coalesce(u.v, 0)) end as theo_cost,
           case when w.sd or coalesce(s.pre_rows, 0) > 0 then null else coalesce(s.loyalty_cost, 0) end as loyalty_cost,
           case when w.sd or coalesce(s.pre_rows, 0) > 0 then null else coalesce(s.staff_cost, 0) end as staff_cost,
           case when w.sd or coalesce(s.pre_rows, 0) > 0 then null else coalesce(s.comp_cost, 0) end as comp_cost,
           case when w.sd then null else coalesce(s.loyalty_qty, 0) end as loyalty_qty,
           case when w.sd then null else coalesce(s.staff_qty, 0) end as staff_qty,
           case when w.sd then null else coalesce(s.comp_qty, 0) end as comp_qty,
           case when w.sd then null
                else public.stock_rp__snap_num(w.snap, 'comps_cost',
                       case when coalesce(s.pre_rows, 0) > 0 then null
                            else coalesce(s.loyalty_cost, 0) + coalesce(s.staff_cost, 0) + coalesce(s.comp_cost, 0) end) end as comps_cost,
           case when w.sd then null
                else public.stock_rp__snap_num(w.snap, 'comps_qty', coalesce(s.loyalty_qty, 0) + coalesce(s.staff_qty, 0) + coalesce(s.comp_qty, 0)) end as comps_qty,
           public.stock_rp__snap_num(w.snap, 'opening_value', o.opening_value) as opening_value,
           public.stock_rp__snap_num(w.snap, 'closing_value', o.closing_value) as closing_value,
           public.stock_rp__snap_num(w.snap, 'purchases', coalesce(l.received, 0)) as received,
           public.stock_rp__snap_num(w.snap, 'transfers_in', coalesce(l.transfers_in, 0)) as transfers_in,
           public.stock_rp__snap_num(w.snap, 'transfers_out', coalesce(l.transfers_out, 0)) as transfers_out,
           public.stock_rp__snap_num(w.snap, 'made', coalesce(l.made, 0)) as made,
           public.stock_rp__snap_num(w.snap, 'used_in_batches', coalesce(l.used, 0)) as used_in_batches,
           public.stock_rp__snap_num(w.snap, 'sold_cost', coalesce(l.sold, 0)) as sold_cost,
           public.stock_rp__snap_num(w.snap, 'waste', coalesce(l.waste, 0)) as waste_value,
           public.stock_rp__snap_num(w.snap, 'revalue', coalesce(l.revalue, 0)) as revalue,
           public.stock_rp__snap_num(w.snap, 'count_adj', coalesce(l.count_adj, 0)) as count_adj,
           coalesce(l.surplus, 0) as surplus, coalesce(l.unaccounted, 0) as unaccounted,
           coalesce(l.opening_balance, 0) as opening_balance, coalesce(l.other, 0) as other, coalesce(l.sold_units, 0) as sold_units,
           coalesce(n.positive_value, 0) as stock_value_now, coalesce(n.negative_value, 0) as negative_value_now,
           coalesce(d.daily_use, 0) as daily_use,
           public.stock_rp__not_posted(array[w.loc], coalesce(w.from_day, current_date), coalesce(w.to_day, current_date)) as np
      from w
      left join led l on l.location_id = w.loc
      left join sal s on s.location_id = w.loc
      left join olds od on od.location_id = w.loc
      left join uns u on u.location_id = w.loc
      left join pth pt on pt.location_id = w.loc
      left join oc o on o.location_id = w.loc
      left join now_v n on n.location_id = w.loc
      left join du d on d.location_id = w.loc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', v.loc, 'site', v.site, 'currency', v.currency, 'from_day', v.from_day, 'to_day', v.to_day,
           'opening_counted', v.oc, 'closing_counted', v.cc, 'window_missing', v.wm, 'snapshot', v.has_snap, 'takes_from', v.takes_from,
           'demo_sales', v.sd, 'known_from', v.known_from, 'known_net', v.known_net,
           'sales_net', v.sales_net, 'sales_gross', v.sales_gross, 'sold_qty', v.sold_qty,
           'with_recipe_net', v.with_recipe_net, 'no_recipe_net', v.no_recipe_net, 'products', v.products,
           'product_theo', v.product_theo, 'theo_cost', v.theo_cost,
           'loyalty_cost', v.loyalty_cost, 'staff_cost', v.staff_cost, 'comp_cost', v.comp_cost,
           'loyalty_qty', v.loyalty_qty, 'staff_qty', v.staff_qty, 'comp_qty', v.comp_qty,
           'comps_cost', v.comps_cost, 'comps_qty', v.comps_qty)
           || jsonb_build_object(
           'opening_value', v.opening_value, 'closing_value', v.closing_value,
           'received', v.received, 'purchases', v.received, 'transfers_in', v.transfers_in, 'transfers_out', v.transfers_out,
           'made', v.made, 'used_in_batches', v.used_in_batches, 'sold_cost', v.sold_cost, 'waste_value', v.waste_value,
           'revalue', v.revalue, 'count_adj', v.count_adj, 'surplus', v.surplus, 'unaccounted', v.unaccounted,
           'opening_balance', v.opening_balance, 'other', v.other, 'sold_units', v.sold_units,
           'expected_closing', case when v.opening_value is null then null
                                    else v.opening_value + v.received + v.opening_balance + v.transfers_in + v.made + v.revalue + v.other
                                         - v.sold_cost - v.used_in_batches - v.transfers_out - v.waste_value end,
           'gap_value', v.count_adj,
           'actual_cost', public.stock_rp__snap_num(v.snap, 'actual_cost',
                            case when v.opening_value is null then null
                                 else v.opening_value + v.received + v.transfers_in + v.opening_balance - v.transfers_out - v.closing_value end),
           'stock_value_now', v.stock_value_now, 'negative_value_now', v.negative_value_now, 'daily_use', v.daily_use,
           'not_posted_count', (v.np ->> 'count')::integer, 'not_posted_value', (v.np ->> 'value')::numeric
         ) order by v.site, v.loc), '[]'::jsonb)
    from live v;
$fn$;

-- stock_rp__derive: the 4a body; GP after loyalty, staff and comps = net less theoretical cost (the cost
-- of those plates is inside it); GP before = GP after plus that cost (not known when it is not).
create or replace function public.stock_rp__derive(p_org uuid, p_row jsonb)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p_row || jsonb_build_object(
           'sales_with_recipe_pct', public.stock_rp__pct((p_row ->> 'with_recipe_net')::numeric, (p_row ->> 'sales_net')::numeric),
           'no_recipe_pct', public.stock_rp__pct((p_row ->> 'no_recipe_net')::numeric, (p_row ->> 'sales_net')::numeric),
           'theo_pct', public.stock_rp__pct((p_row ->> 'theo_cost')::numeric, (p_row ->> 'sales_net')::numeric),
           'actual_pct', public.stock_rp__pct((p_row ->> 'actual_cost')::numeric, (p_row ->> 'sales_net')::numeric),
           'gp_before', (p_row ->> 'sales_net')::numeric - (p_row ->> 'theo_cost')::numeric + (p_row ->> 'comps_cost')::numeric,
           'gp_after', (p_row ->> 'sales_net')::numeric - (p_row ->> 'theo_cost')::numeric,
           'gp_actual', case when p_row ->> 'actual_cost' is null then null else (p_row ->> 'sales_net')::numeric - (p_row ->> 'actual_cost')::numeric end,
           'gp_pct_theo', public.stock_rp__pct((p_row ->> 'sales_net')::numeric - (p_row ->> 'theo_cost')::numeric, (p_row ->> 'sales_net')::numeric),
           'gp_pct_actual', case when p_row ->> 'actual_cost' is null then null
                                 else public.stock_rp__pct((p_row ->> 'sales_net')::numeric - (p_row ->> 'actual_cost')::numeric, (p_row ->> 'sales_net')::numeric) end,
           'gap_pct', public.stock_rp__pct(-(p_row ->> 'gap_value')::numeric, (p_row ->> 'sales_net')::numeric),
           'waste_pct', public.stock_rp__pct((p_row ->> 'waste_value')::numeric, (p_row ->> 'sales_net')::numeric),
           'waste_pct_purchases', public.stock_rp__pct((p_row ->> 'waste_value')::numeric, (p_row ->> 'purchases')::numeric),
           'comps_pct', public.stock_rp__pct((p_row ->> 'comps_cost')::numeric, (p_row ->> 'sales_net')::numeric),
           'budget', null,
           'days_on_hand', case when coalesce((p_row ->> 'daily_use')::numeric, 0) = 0 then null
                                else round((p_row ->> 'stock_value_now')::numeric / (p_row ->> 'daily_use')::numeric, 1) end,
           'gap', case when p_row ->> 'expected_closing' is null then null
                       else (p_row ->> 'closing_value')::numeric - (p_row ->> 'expected_closing')::numeric end)
         || jsonb_build_object('rag', jsonb_build_object(
              'gp_pct', public.stock_rp__rag(p_org, (p_row ->> 'location_id')::uuid, 'gp_pct',
                          public.stock_rp__pct((p_row ->> 'sales_net')::numeric - (p_row ->> 'theo_cost')::numeric, (p_row ->> 'sales_net')::numeric)),
              'gap_pct', public.stock_rp__rag(p_org, (p_row ->> 'location_id')::uuid, 'gap_pct',
                          public.stock_rp__pct(-(p_row ->> 'gap_value')::numeric, (p_row ->> 'sales_net')::numeric)),
              'waste_pct', public.stock_rp__rag(p_org, (p_row ->> 'location_id')::uuid, 'waste_pct',
                          public.stock_rp__pct((p_row ->> 'waste_value')::numeric, (p_row ->> 'sales_net')::numeric)),
              'comps_pct', public.stock_rp__rag(p_org, (p_row ->> 'location_id')::uuid, 'comps_pct',
                          public.stock_rp__pct((p_row ->> 'comps_cost')::numeric, (p_row ->> 'sales_net')::numeric)),
              'days_on_hand', public.stock_rp__rag(p_org, (p_row ->> 'location_id')::uuid, 'days_on_hand',
                          case when coalesce((p_row ->> 'daily_use')::numeric, 0) = 0 then null
                               else round((p_row ->> 'stock_value_now')::numeric / (p_row ->> 'daily_use')::numeric, 1) end),
              'no_recipe_pct', public.stock_rp__rag(p_org, (p_row ->> 'location_id')::uuid, 'no_recipe_pct',
                          public.stock_rp__pct((p_row ->> 'no_recipe_net')::numeric, (p_row ->> 'sales_net')::numeric))));
$fn$;

-- stock_rp__meta: the 4a body; the words for a window still holding a demo day not yet rebuilt.
create or replace function public.stock_rp__meta(p_g jsonb, p_report text, p_from date, p_to date, p_between boolean, p_level text,
                                                 p_columns jsonb, p_windows jsonb, p_notes jsonb)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p_g
         || jsonb_build_object(
              'stock_level', p_g -> 'level',
              'report', p_report, 'from', p_from, 'to', p_to, 'between_counts', coalesce(p_between, false), 'level', p_level,
              'columns', coalesce(p_columns, '[]'::jsonb),
              'windows', public.stock_rp__meta_windows(p_windows),
              'not_posted', public.stock_rp__not_posted(array(select (x ->> 'id')::uuid from jsonb_array_elements(p_g -> 'sites') x), p_from, p_to),
              'notes', coalesce(p_notes, '[]'::jsonb)
                       || coalesce((select jsonb_agg('Demo history at ' || coalesce(w ->> 'site', 'a site') || ' is still being taken out of these days: its sales and GP show once that is done'
                                                     order by w ->> 'site')
                                      from jsonb_array_elements(coalesce(p_windows, '[]'::jsonb)) w
                                     where coalesce((w ->> 'demo_sales')::boolean, false) and not coalesce((w ->> 'snapshot')::boolean, false)), '[]'::jsonb),
              'generated_at', now());
$fn$;

-- stock_report_waste: the 4a body; every figure from the ledger's WASTE rows.
create or replace function public.stock_report_waste(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
                                                     p_after jsonb default null, p_limit integer default 1000)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_g      jsonb := public.stock_report_guard(p_org, p_sites);
  v_o      jsonb := coalesce(p_opts, '{}'::jsonb);
  v_limit  integer := public.stock_rp__page_cap(p_limit);
  v_level  text := coalesce(nullif(v_o ->> 'level', ''), 'site');
  v_site   uuid := public.stock_rp__opt_site(v_g, v_o);
  v_win    jsonb;
  v_fig    jsonb;
  v_w      jsonb;
  v_site_rows jsonb;
  v_rows   jsonb := '[]'::jsonb;
  v_next   jsonb;
  v_cols   jsonb;
  v_n      integer;
  v_notes  jsonb := '[]'::jsonb;
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  if v_level not in ('site', 'reason', 'category', 'item', 'person', 'day') then
    v_level := 'site';
  end if;
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, false);
  v_fig := public.stock_rp__site_figures(v_g, v_win);
  -- 20261029a: every figure from the stock ledger's WASTE rows (demo left out), each with the waste
  -- entry it belongs to for the reason, the person and the note (source waste: source_id is the entry;
  -- refunded food and a voided order's made food: the entry the drainer wrote beside it, md5 of the
  -- movement key). The same rows the
  -- dashboard, the league, Daily trading and the Wastage log add up, so every waste figure agrees.
  v_w := (select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) from (
  select m.location_id, (select x ->> 'name' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = m.location_id) as site,
         (select x ->> 'currency' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = m.location_id) as currency,
         d.business_day, coalesce(nullif(btrim(w.reason), ''), nullif(btrim(m.notes), ''), 'No reason') as reason,
         coalesce(w.source, case when m.source_type = 'closed_check_refund' then 'refund' else 'backoffice' end) as source, w.logged_by,
         coalesce((select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), '')) from user_profiles p where p.id = w.logged_by), 'Till') as person,
         m.inventory_item_id, i.company_ref as company_item_id, coalesce(i.name, w.item_name, 'Item') as name, coalesce(i.base_unit, w.unit) as unit,
         coalesce(cat.name, nullif(btrim(i.category), ''), 'No category') as category,
         -m.qty_base as qty, -m.value_delta as value, coalesce(w.id::text, 'mv:' || m.id::text) as entry
    from (select (x ->> 'id')::uuid as loc,
                 public.stock_co__day_start_at(p_from, k.day_start, k.timezone) as lo,
                 public.stock_co__day_start_at(p_to + 1, k.day_start, k.timezone) as hi
            from jsonb_array_elements(v_g -> 'sites') x
           cross join lateral public.stock_co__clock_of((x ->> 'id')::uuid) k
           where v_site is null or (x ->> 'id')::uuid = v_site) sw
    join stock_movements m on m.location_id = sw.loc and m.movement_type = 'WASTE' and m.occurred_at >= sw.lo and m.occurred_at < sw.hi
   cross join lateral public.stock_co__venue_day(m.location_id, m.occurred_at) d
    left join waste_events w on w.location_id = m.location_id
                            and ((m.source_type = 'waste' and w.id::text = m.source_id)
                                 or (m.source_type <> 'waste' and m.idempotency_key is not null and w.id = md5(m.idempotency_key)::uuid))
    left join inventory_items i on i.id = m.inventory_item_id
    left join stock_co_items ci on ci.id = i.company_ref
    left join stock_co_categories cat on cat.id = ci.category_id
   where not public.stock_rp__is_demo(m.idempotency_key)) z);
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', (f ->> 'location_id')::uuid, 'site', f ->> 'site', 'currency', f ->> 'currency', 'sales_net', (f ->> 'sales_net')::numeric, 'purchases', (f ->> 'purchases')::numeric,
           'waste_value', coalesce(z.v, 0), 'waste_pct_sales', public.stock_rp__pct(coalesce(z.v, 0), (f ->> 'sales_net')::numeric),
           'waste_pct_purchases', public.stock_rp__pct(coalesce(z.v, 0), (f ->> 'purchases')::numeric),
           'refund_waste', coalesce(z.refund, 0), 'closedown_waste', null, 'events', coalesce(z.n, 0), 'ledger_waste', (f ->> 'waste_value')::numeric)
           order by f ->> 'site'), '[]'::jsonb)
    into v_site_rows
    from jsonb_array_elements(v_fig) f
    left join (select t.location_id, sum(t.value) as v, sum(t.value) filter (where t.source = 'refund') as refund, count(distinct t.entry) as n from jsonb_to_recordset(v_w) as t(location_id uuid, site text, currency text, business_day date, reason text, source text, logged_by uuid, person text, inventory_item_id uuid, company_item_id uuid, name text, unit text, category text, qty numeric, value numeric, entry text) group by t.location_id) z
      on z.location_id = (f ->> 'location_id')::uuid
   where v_site is null or (f ->> 'location_id')::uuid = v_site;
  if exists (select 1 from jsonb_array_elements(v_site_rows) r where abs((r ->> 'waste_value')::numeric - (r ->> 'ledger_waste')::numeric) > 0.01) then
    v_notes := (select jsonb_agg('The ledger''s waste rows at ' || (r ->> 'site') || ' add up to ' || (r ->> 'waste_value') || ' and the day totals to ' || (r ->> 'ledger_waste') || ': the day totals are still catching up.')
                  from jsonb_array_elements(v_site_rows) r where abs((r ->> 'waste_value')::numeric - (r ->> 'ledger_waste')::numeric) > 0.01);
  end if;
  -- 20261029a: a waste entry that carries a cost but took nothing off stock is named, never counted
  -- (the ledger is the figure): three such dish entries were written straight into waste_events
  v_notes := v_notes || (select coalesce(jsonb_agg(z.n || ' waste ' || case when z.n = 1 then 'entry' else 'entries' end || ' at ' || z.site
                                        || ' carry a cost but took nothing off stock: not counted' order by z.site), '[]'::jsonb)
                from (select (select x ->> 'name' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = we.location_id) as site, count(*) as n
                        from waste_events we
                       cross join lateral public.stock_co__venue_day(we.location_id, we.occurred_at) d
                       where we.location_id = any(array(select (x ->> 'id')::uuid from jsonb_array_elements(v_g -> 'sites') x))
                         and (v_site is null or we.location_id = v_site)
                         and coalesce(we.cost_value, 0) <> 0 and d.business_day between p_from and p_to
                         and not exists (select 1 from stock_movements m
                                          where m.location_id = we.location_id and m.movement_type = 'WASTE'
                                            and ((m.source_type = 'waste' and m.source_id = we.id::text)
                                                 or (m.source_type <> 'waste' and m.idempotency_key is not null and md5(m.idempotency_key)::uuid = we.id)))
                       group by we.location_id) z);
  v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('waste_value', 'Waste', 'money'),
    public.stock_rp__col('waste_pct_sales', '% of sales', 'pct'), public.stock_rp__col('waste_pct_purchases', '% of purchases', 'pct'),
    public.stock_rp__col('refund_waste', 'Refunded food', 'money'), public.stock_rp__col('closedown_waste', 'End of day close down', 'money'), public.stock_rp__col('events', 'Entries', 'qty'));
  if v_level <> 'site' then
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('name', case v_level when 'reason' then 'Reason' when 'category' then 'Category'
                when 'item' then 'Item' when 'person' then 'Who' else 'Day' end, 'text'),
      public.stock_rp__col('value', 'Waste', 'money'), public.stock_rp__col('qty', 'Quantity', 'qty'), public.stock_rp__col('events', 'Entries', 'qty'));
    with g as (
      select t.location_id, t.site, t.currency,
             case v_level when 'reason' then t.reason when 'category' then t.category when 'item' then coalesce(t.company_item_id::text, t.inventory_item_id::text, t.name)
                          when 'person' then coalesce(t.logged_by::text, 'till') else t.business_day::text end as key,
             case v_level when 'reason' then t.reason when 'category' then t.category when 'item' then t.name when 'person' then t.person else t.business_day::text end as name,
             min(t.unit) as unit, min(t.company_item_id::text) as company_item_id, min(t.logged_by::text) as logged_by,
             sum(t.value) as value, sum(t.qty) as qty, count(distinct t.entry) as events
        from jsonb_to_recordset(v_w) as t(location_id uuid, site text, currency text, business_day date, reason text, source text, logged_by uuid, person text, inventory_item_id uuid, company_item_id uuid, name text, unit text, category text, qty numeric, value numeric, entry text)
       group by t.location_id, t.site, t.currency, 4, 5
    ),
    gt as (
      select g.*,
             case when v_level = 'item' then
               (select r.reason from jsonb_to_recordset(v_w) as r(location_id uuid, site text, currency text, business_day date, reason text, source text, logged_by uuid, person text, inventory_item_id uuid, company_item_id uuid, name text, unit text, category text, qty numeric, value numeric, entry text)
                 where r.location_id = g.location_id and coalesce(r.company_item_id::text, r.inventory_item_id::text, r.name) = g.key
                 group by r.reason order by sum(r.value) desc, r.reason limit 1) end as top_reason
        from g
    ),
    pg as (
      select g.* from gt g
       where p_after is null
          or public.stock_rp__sk(g.value) < (p_after ->> 'value')::numeric
          or (public.stock_rp__sk(g.value) = (p_after ->> 'value')::numeric and (g.location_id::text || ':' || g.key) > coalesce(p_after ->> 'key', ''))
       order by public.stock_rp__sk(g.value) desc, g.location_id::text || ':' || g.key
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('location_id', pg.location_id, 'site', pg.site, 'currency', pg.currency, 'key', pg.location_id::text || ':' || pg.key,
             'name', pg.name, 'reason', case when v_level = 'reason' then pg.name end, 'company_item_id', case when v_level = 'item' then pg.company_item_id end,
             'logged_by', case when v_level = 'person' then pg.logged_by end, 'day', case when v_level = 'day' then pg.name end,
             'value', pg.value, 'qty', pg.qty, 'unit', case when v_level = 'item' then pg.unit end, 'events', pg.events, 'top_reason', case when v_level = 'item' then pg.top_reason end)
             order by public.stock_rp__sk(pg.value) desc, pg.location_id::text || ':' || pg.key), '[]'::jsonb), count(*)
      into v_rows, v_n
      from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('value', public.stock_rp__sk((v_rows -> (v_limit - 1) ->> 'value')::numeric), 'key', v_rows -> (v_limit - 1) ->> 'key');
    end if;
  else
    v_rows := (select coalesce(jsonb_agg(r), '[]'::jsonb) from (select r from jsonb_array_elements(v_site_rows) r limit 1000) z);
  end if;
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'waste', p_from, p_to, false, v_level, v_cols, v_win, v_notes),
    'totals', v_site_rows || (select coalesce(jsonb_agg(c || jsonb_build_object(
                                 'waste_pct_sales', public.stock_rp__pct((c ->> 'waste_value')::numeric, (c ->> 'sales_net')::numeric),
                                 'waste_pct_purchases', public.stock_rp__pct((c ->> 'waste_value')::numeric, (c ->> 'purchases')::numeric), 'closedown_waste', null)
                                 order by c ->> 'currency'), '[]'::jsonb)
                               from jsonb_array_elements(public.stock_rp__sum_rows(v_site_rows, array['sales_net', 'purchases', 'waste_value', 'refund_waste', 'events', 'ledger_waste'])) c),
    'rows', v_rows, 'next', v_next);
end
$fn$;

-- ============================================================================
-- STEP 6. WASTE IS WRITTEN WITH ITS LEDGER, ALWAYS: no direct insert or update of waste_events by an API
-- session. stock_record_waste, the drainer and the edge functions (definer or service role) are the
-- writers; the read and delete policies stay.
-- ============================================================================
drop policy waste_events_ins on public.waste_events;
drop policy waste_events_upd on public.waste_events;

-- ============================================================================
-- STEP 7. THE REBUILD, QUEUED (15 venue days a minute, newest first, the drain does it)
-- ============================================================================
-- For every venue with day totals: every venue business day a refund was made (refunds of the last 400
-- days) and every venue business day holding a demo check, from the venue's first day total to today.
create temp table _reports_align_queued (location_id uuid, kind text, days integer) on commit drop;

with v as (
  select s.location_id, min(s.business_day) as first_day
    from public.sales_day_sums s
   group by s.location_id
),
rday as (
  select distinct c.location_id::uuid as location_id,
         (select d.business_day from public.stock_co__venue_day(c.location_id::uuid, public._sales_refund_at(e.r, c.closed_at)) d) as business_day
    from public.closed_checks c
   cross join lateral jsonb_array_elements(case when jsonb_typeof(c.refunds) = 'array' then c.refunds else '[]'::jsonb end) as e(r)
   where c.refunds is not null and c.refunds <> '[]'::jsonb and c.closed_at >= now() - interval '400 days'
     and c.location_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     and jsonb_typeof(e.r) = 'object'
),
dday as (
  select distinct c.location_id::uuid as location_id,
         (select d.business_day from public.stock_co__venue_day(c.location_id::uuid, c.closed_at) d) as business_day
    from public.closed_checks c
   where c.id like 'demo-%' and c.closed_at >= now() - interval '400 days'
     and c.location_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
),
days as (
  select x.location_id, x.business_day, min(x.kind) as kind
    from (select r.location_id, r.business_day, 'refund' as kind from rday r
          union all
          select d.location_id, d.business_day, 'demo' from dday d) x
    join v on v.location_id = x.location_id
   where x.business_day is not null and x.business_day >= v.first_day
     and x.business_day <= (select t.business_day from public.stock_co__venue_day(x.location_id, now()) t)
   group by x.location_id, x.business_day
),
q as (
  insert into public.sales_day_sums_queue (location_id, business_day, reason, queued_at, attempts, due_at)
  select d.location_id, d.business_day, 'reports_align', now(), 0,
         now() + ((row_number() over (order by d.business_day desc, d.location_id) - 1) / 15) * interval '1 minute'
    from days d
   order by d.business_day desc, d.location_id
  on conflict (location_id, business_day) do update set due_at = least(public.sales_day_sums_queue.due_at, excluded.due_at)
  returning location_id, business_day
)
insert into _reports_align_queued (location_id, kind, days)
select q.location_id, d.kind, count(*)
  from q join days d on d.location_id = q.location_id and d.business_day = q.business_day
 group by q.location_id, d.kind;

-- ============================================================================
-- STEP 8. GRANTS: the six new helpers revoked from every API role by signature; _sales_is_demo back to
-- authenticated and service_role (report_day_sums runs as the signed in user). The replaced bodies keep
-- their grants (create or replace keeps them).
-- ============================================================================
revoke all on function public._sales_is_demo(text) from public, anon, authenticated, service_role;
revoke all on function public._sales_allocate(bigint, bigint[]) from public, anon, authenticated, service_role;
revoke all on function public._sales_kind(text) from public, anon, authenticated, service_role;
revoke all on function public._sales_check_tenders(public.closed_checks) from public, anon, authenticated, service_role;
revoke all on function public._sales_refund_at(jsonb, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public._sales_refund_parts(public.closed_checks, jsonb) from public, anon, authenticated, service_role;
grant execute on function public._sales_is_demo(text) to authenticated, service_role;

notify pgrst, 'reload schema';

-- ============================================================================
-- STEP 9. NOTHING AT THE SITES OR LOGINS MOVED (any difference undoes everything)
-- ============================================================================
insert into _reports_align_now (location_id, metric, value) select * from _reports_align_metrics;
insert into _reports_align_now (location_id, metric, value, txt)
values ('00000000-0000-0000-0000-000000000000', 'md5:user_profiles', 0,
        (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.user_profiles t)),
       ('00000000-0000-0000-0000-000000000000', 'md5:user_locations', 0,
        (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.user_locations t));

do $compare$
declare
  v_bad text;
begin
  select string_agg(coalesce(b.metric, a.metric) || ' at ' || coalesce(b.location_id, a.location_id)::text, ', ')
    into v_bad
    from _reports_align_snap b
    full join _reports_align_now a on a.location_id = b.location_id and a.metric = b.metric
   where a.metric is null or b.metric is null or a.value is distinct from b.value or a.txt is distinct from b.txt;
  if v_bad is not null then
    raise exception 'Reports align changed a site row or a login (%). Nothing was changed. Send this line to Claude.', left(v_bad, 600);
  end if;
end
$compare$;

-- ============================================================================
-- VISIBLE CHECK (the SQL editor shows this last result; paste it back to Claude). One row.
-- Expected live:
--   bodies_replaced 12, new_helpers 6, new_columns 7, waste_write_policies 0, backup_rows 14,
--   internals_open_to_api false, site_rows_changed 0, logins_changed false;
--   refund_days_queued about 55 (6 venues) and demo_days_queued about 125 (Provo and Location 2 only),
--   backfill_minutes about 12 (the drain rebuilds them; Stock and GP shows each day after it);
--   by the new rules, straight from the checks and timesheets (the day totals follow once drained):
--   leeds_18_oct_net 821.52, leeds_19_oct_net 687.34, leeds_20_oct_net 645.12 (Daily trading's net
--   sales at Coffee Boy Leeds), provo_16_oct_net 400.90 (no refunds, no demo), provo_14_oct_labour
--   258.11 (approved and paid, Daily trading's labour).
-- ============================================================================
with proof(name, loc, day) as (values
  ('leeds_18_oct', '1e252e7c-c875-4971-b91d-1e945c26956b'::uuid, date '2026-10-18'),
  ('leeds_19_oct', '1e252e7c-c875-4971-b91d-1e945c26956b'::uuid, date '2026-10-19'),
  ('leeds_20_oct', '1e252e7c-c875-4971-b91d-1e945c26956b'::uuid, date '2026-10-20'),
  ('provo_16_oct', '7218c716-eeb4-4f96-b284-f3500823595c'::uuid, date '2026-10-16')
),
pc as (
  select p.name, case when exists (select 1 from public.locations l where l.id = p.loc)
                      then public.sales_day_sums_check(p.loc, p.day) end as ck
    from proof p
)
select
  (select count(*)::integer from (values
     ('public.sales_day_sums_rebuild(uuid,date,date)'), ('public.sales_day_sums_check(uuid,date)'), ('public._sales_day_sums_enqueue()'),
     ('public._sales_check_parts(public.closed_checks)'),
     ('public.report_day_sums(text[],date,date,jsonb)'), ('public.stock_rp__labour(uuid,date,date)'), ('public.stock_rp__site_sales(jsonb)'),
     ('public.stock_rp__site_figures(jsonb,jsonb)'), ('public.stock_rp__derive(uuid,jsonb)'), ('public.stock_rp__demo_sales(uuid,date,date)'),
     ('public.stock_rp__meta(jsonb,text,date,date,boolean,text,jsonb,jsonb,jsonb)'), ('public.stock_report_waste(uuid,uuid[],date,date,jsonb,jsonb,integer)')) f(sig)
    join pg_proc p on p.oid = to_regprocedure(f.sig)
    join public.stock_native_backup b on b.name = 'align:' || p.proname
   where md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) <> b.md5) as bodies_replaced,
  (select count(*)::integer from (values ('public._sales_is_demo(text)'), ('public._sales_allocate(bigint,bigint[])'), ('public._sales_kind(text)'),
     ('public._sales_check_tenders(public.closed_checks)'), ('public._sales_refund_at(jsonb,timestamptz)'),
     ('public._sales_refund_parts(public.closed_checks,jsonb)')) f(sig) where to_regprocedure(f.sig) is not null) as new_helpers,
  (select count(*)::integer from information_schema.columns c
    where c.table_schema = 'public' and c.table_name = 'sales_day_sums'
      and c.column_name in ('sale_net', 'sale_theo', 'refund_net', 'refund_tax', 'refund_gross', 'refund_qty', 'refund_cost')) as new_columns,
  (select count(*)::integer from pg_policies p where p.schemaname = 'public' and p.tablename = 'waste_events'
      and p.policyname in ('waste_events_ins', 'waste_events_upd')) as waste_write_policies,
  (select count(*)::integer from public.stock_native_backup b where left(b.name, 6) = 'align:') as backup_rows,
  exists (select 1 from pg_proc p
           where p.pronamespace = 'public'::regnamespace
             and p.proname in ('_sales_allocate', '_sales_kind', '_sales_check_tenders', '_sales_refund_at', '_sales_refund_parts')
             and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                  or has_function_privilege('service_role', p.oid, 'execute'))) as internals_open_to_api,
  coalesce((select sum(q.days) from _reports_align_queued q where q.kind = 'refund'), 0)::integer as refund_days_queued,
  coalesce((select sum(q.days) from _reports_align_queued q where q.kind = 'demo'), 0)::integer as demo_days_queued,
  ceil(coalesce((select sum(q.days) from _reports_align_queued q), 0) / 15.0)::integer as backfill_minutes,
  (select round((pc.ck -> 'net' ->> 'rule')::numeric - (pc.ck -> 'refunds' ->> 'rule')::numeric, 2) from pc where pc.name = 'leeds_18_oct') as leeds_18_oct_net,
  (select round((pc.ck -> 'net' ->> 'rule')::numeric - (pc.ck -> 'refunds' ->> 'rule')::numeric, 2) from pc where pc.name = 'leeds_19_oct') as leeds_19_oct_net,
  (select round((pc.ck -> 'net' ->> 'rule')::numeric - (pc.ck -> 'refunds' ->> 'rule')::numeric, 2) from pc where pc.name = 'leeds_20_oct') as leeds_20_oct_net,
  (select round((pc.ck -> 'net' ->> 'rule')::numeric - (pc.ck -> 'refunds' ->> 'rule')::numeric, 2) from pc where pc.name = 'provo_16_oct') as provo_16_oct_net,
  (select round(l.pay, 2) from public.stock_rp__labour('7218c716-eeb4-4f96-b284-f3500823595c'::uuid, date '2026-10-14', date '2026-10-14') l
    where exists (select 1 from public.locations x where x.id = '7218c716-eeb4-4f96-b284-f3500823595c'::uuid)) as provo_14_oct_labour,
  (select count(*)::integer from _reports_align_snap b join _reports_align_now a on a.location_id = b.location_id and a.metric = b.metric
    where (a.value is distinct from b.value or a.txt is distinct from b.txt) and b.metric not like 'md5:%') as site_rows_changed,
  exists (select 1 from _reports_align_snap b join _reports_align_now a on a.location_id = b.location_id and a.metric = b.metric
           where b.metric like 'md5:%' and a.txt is distinct from b.txt) as logins_changed;
