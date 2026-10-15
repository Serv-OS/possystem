-- 20261005b_OPS_report_day_sums.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  Safe any time, service included. ADDS functions only.                    #
-- #  No table changes, no data changes. Takes under a second.                 #
-- ############################################################################
--
-- WHY (Peter, 5 Oct 2026, multi site reports, decision 4: "Long periods for All sites: fast
-- money totals from the server now (one SQL function Peter runs)")
--   A Back Office report reads every closed check into the browser and adds them up there.
--   The database hands back 1,000 rows a request. One Coffee Boy site is about 1,100 to 1,900
--   checks a week, so 90 days across the 6 sites is about 99,000 rows: 100 requests, twice
--   that with the period before, on the database the tills are using. Too heavy.
--   This file adds ONE function that does the adding up in the database and answers one row
--   per site per business day: 540 small rows for 90 days across 6 sites.
--
-- WHAT IT ADDS
--   public.report_day_sums(p_location_ids text[], p_from date, p_to date, p_clocks jsonb)
--     One row per site per BUSINESS day that has a sale or a refund. Days with nothing have
--     no row. The eight small helpers (_rds_*) are only its working parts.
--
-- WHO CAN READ WHAT (nothing new is opened)
--   The function is SECURITY INVOKER: it reads closed_checks AS THE PERSON CALLING IT, so the
--   existing rule on the table (policy closed_checks_read: location_id in
--   accessible_location_ids(), plus the second step fence) still decides every row. Asking
--   for a site you may not see answers no rows for it, exactly like a plain read.
--   Signed in Back Office users only (role authenticated). The public key (anon) cannot run
--   it. A paired till, kiosk or screen is an ANONYMOUS session: it is refused by name inside
--   the function (is_anon_session), so it gets nothing, even for its own venue.
--   What it does NOT do: pick "the same company". A login linked to sites in two companies
--   may read both, here as on every screen. The app decides which sites to ask for
--   (the Sites control, same locations.org_id) and currencies are kept apart in the app.
--
-- WHICH ID, AND WHERE THE CLOCK COMES FROM
--   p_location_ids are OPS location ids: the text in closed_checks.location_id
--   (= locations.id on THIS database). 9 of 13 venues have a different id on Platform; no
--   Platform id is ever used here, so that drift cannot touch it.
--   A venue's business day start is stored in ONE place: Platform locations.business_day_start.
--   It is not on this database at all (checked 5 Oct 2026: the only clock column on Ops is
--   locations.timezone), and this database cannot read Platform. So the caller passes each
--   site's clock in p_clocks: { "<ops location id>": { "tz": "Europe/London",
--   "day_start": "06:30" } }, read from Platform locations by ops_location_id, the same read
--   the Back Office reports already make (src/lib/locationTime.js getVenueClock). That is the
--   only safe way to get the same day the reports show.
--   It is safe: the clock only decides which DAY a row lands on. It cannot widen what the
--   caller reads (the table rule does that). A site with no clock, a zone Postgres does not
--   know, or a start that is not HH:MM is REFUSED with an error; no day is ever cut on a
--   guessed clock. Each row answers the clock it used, and the zone stored on Ops
--   (stored_timezone) beside it, so the app can warn when the two databases disagree.
--
-- THE DAY (the venue clock invariant)
--   Business day D runs from day_start on D to day_start on D + 1 on the venue's own wall
--   clock, found from the zone's real offsets. Same boundaries as
--   supabase/functions/_shared/businessDay.js (a start time the clocks skip is the first
--   moment after the gap; a start time shown twice is the FIRST time it is shown).
--
-- WHAT EACH ROW HOLDS, AND WHICH REPORT IT MATCHES
--   A. THE SALES OF THE DAY: checks that CLOSED in the business day. Same maths as the Back
--      Office Business summary (src/lib/salesStats.js computeSalesStats), to the penny:
--        gross          sum of subtotal, every row
--        discounts      each discount's amount, else its value
--        voids          total of voided rows (voided = true, or status 'void' or 'voided':
--                       both spellings, src/lib/voidRules.js normaliseCheckStatus)
--        refunds        every refund entry on those checks, WHENEVER it was made, split into
--                       refunds_items / refunds_tip / refunds_service / refunds_tax
--        net_sales      gross - discounts - voids - refunds_items
--        tax            tax_amount, else max(0, total - subtotal - service - tip), less refunds_tax
--        service, tips  less their refunded part
--        total          sum of total
--        checks, covers voided rows left out; covers 0 or empty counts as 1
--        delivery_fees  customer.delivery_fee
--      by_method        the Payments report (reports/Payments.jsx): check method, total, tip
--      by_order_type    the Order types report: order_type (empty = dine-in), total
--      by_source        the Order sources report: kiosk, online, qr, catering, a delivery
--                       channel by its name, everything else pos
--      by_tender        the money by what paid: card, cash, gift_card, loyalty, other. Read
--                       from closed_checks.tenders the way the accounting layer reads a check
--                       (_shared/accountingDay.js checkTenders); a row from before tenders by
--                       its legacy rules. loyalty = loyalty rewards and promo codes (a
--                       discount, not money). other = booking deposits, an old split nobody
--                       can place, anything unknown. Voided rows left out.
--      Training mode books nothing (v645), so there is nothing to leave out. A zero total
--      check counts as a check, as it does in the report.
--   B. THE REFUNDS MADE THAT DAY: refunds_made, _tip, _service, _tax, _count. The accounting
--      day rule 3 (_shared/accountingDay.js, what Daily trading and Xero use): a refund
--      belongs to the business day of the refund ITSELF (refunds[].timestamp, else .at, else
--      .created_at, else a card leg's time, else the check's close time), not the day the
--      check closed. Checks closed up to 400 days before are looked at, as there. A refund
--      that failed or never finished moved no money and is left out; a part failed refund
--      counts what really went back; a voided check's refunds are left out.
--      NOT the same figure as A.refunds on purpose. The Back Office summary takes a refund
--      off the day of the SALE; the accounts take it off the day it was MADE. Both are here
--      so a report can say which one it shows. One thing B does not do: gift card or loyalty
--      credit put back ON TOP of a full refund (kiosk and online checks) is not added.
--
-- HOW IT READS (and why it is safe during service)
--   One site at a time, each over its own window, along the index that is already there:
--   idx_closed_checks_location_closed_at (location_id, closed_at desc). It only reads. It
--   takes no lock a till could wait on, and a signed in user's 8 second limit still applies.
--
-- SPEED (measured 5 Oct 2026 on a local Postgres 17 built from a read only export, set up
-- like production: 2 GB shared buffers, the same indexes, the same rule on the table)
--   Today's real rows (7,609 checks):  90 days, all 13 sites asked    45 ms
--                                      one site, one week              11 ms
--   A year from now (470,000 checks, Coffee Boy's pace of about 1,100 a day over 6 sites):
--                                      7 days,  6 sites,  7,845 checks   75 ms
--                                      30 days, 6 sites, 32,900 checks  195 ms
--                                      90 days, 6 sites, 98,619 checks  510 ms
--   Those year from now figures are WITH the small extra index in
--   20261005b2_OPS_report_day_sums_refund_index.sql. Without it each call is about 350 ms
--   slower by then (the 400 day look back for refunds has to open every check). Today the
--   index makes no difference you could measure. It is a separate file because it must be run
--   on its own (CREATE INDEX CONCURRENTLY cannot run inside this paste).
--
-- TWO THINGS TO KNOW ABOUT "TO THE PENNY"
--   1. The sums here are exact. The browser adds the same numbers in floating point. Where
--      a day's true total is an exact half penny (10% off 4.75 is 0.475, stored
--      unrounded), the two agree to a millionth of a penny but the SCREEN can round them a
--      penny apart. 11 of 4,779 figures on 5 Oct 2026. Nothing here can remove that; storing
--      discounts in whole pence at the till would.
--   2. Voids: this file uses the reports' rule everywhere (voided = true, or status 'void'
--      or 'voided'). The accounting layer only knows the flag and 'voided'. No live row
--      differs (every 'void' row has the flag set, checked 5 Oct 2026).
--      A check with NO status at all (the column allows empty) is a sale, not a void, as
--      it is in the reports. No live row has an empty status (checked 5 Oct 2026).
--
-- BEFORE AND AFTER IT RUNS
--   Before: the app asks, is told the function is not there, and falls back to the browser
--   read it uses today (src/lib/reportDaySums.js answers "not available"). After: long
--   periods come from here. No app release has to wait for this file, or the other way round.
--
-- Rollback: 20261005b_OPS_report_day_sums_ROLLBACK.sql
--
-- Bare statements, no begin or commit: the SQL editor runs the paste as one transaction, so any
-- error means nothing changed. Safe to run twice.

do $guard$
begin
  if to_regclass('public.closed_checks') is null then
    raise exception 'This is not the Ops database (closed_checks is missing). Nothing was changed.';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'closed_checks' and column_name = 'tenders') then
    raise exception 'closed_checks.tenders is missing (v5.9.11). Nothing was changed.';
  end if;
  if to_regprocedure('public.is_anon_session()') is null
     or to_regprocedure('public.accessible_location_ids()') is null then
    raise exception 'The access helpers (is_anon_session, accessible_location_ids) are not here. Nothing was changed.';
  end if;
  -- The function reads as the caller, so the table's own rule is the only fence. Never
  -- install it on a table with no rule.
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.closed_checks'::regclass)
     or not exists (select 1 from pg_policies p
                     where p.schemaname = 'public' and p.tablename = 'closed_checks' and p.cmd = 'SELECT') then
    raise exception 'closed_checks has no read rule (row level security). Nothing was changed. Send Claude this message.';
  end if;
end
$guard$;

set local lock_timeout = '3s';

-- ── helpers ──────────────────────────────────────────────────────────────────
-- Pure arithmetic on what they are handed: none reads a table. Every name they use is
-- written out in full (public._rds_...). The four called once or more per check (_rds_num,
-- _rds_canon, _rds_tender_bucket, _rds_wall) carry no "set search_path": with one, Postgres
-- sets it and puts it back on every call, which was most of the run time when measured.

-- JavaScript's Number(x) || 0 for one JSON value: a number, or text that is a plain number.
-- Anything else (null, a list, a word) is 0.
-- No "set search_path" on purpose: with one, Postgres cannot fold the function into the query
-- and calls it once per value (it is used several times per check). It only uses built ins.
create or replace function public._rds_num(p_v jsonb)
returns numeric
language sql
immutable
parallel safe
as $fn$
  select case jsonb_typeof(p_v)
           when 'number' then (p_v #>> '{}')::numeric
           when 'string' then case when (p_v #>> '{}') ~ '^ *-?([0-9]+\.?[0-9]*|\.[0-9]+) *$'
                                   then btrim(p_v #>> '{}')::numeric else 0 end
           else 0
         end;
$fn$;

-- One spelling per payment method (_shared/accountingDay.js canonicalMethod): trimmed, lower
-- case, spaces and hyphens as underscores, the gift card spellings folded. Empty is 'other'.
create or replace function public._rds_canon(p_method text)
returns text
language plpgsql
immutable
parallel safe
as $fn$
declare
  v_m text := regexp_replace(regexp_replace(lower(coalesce(p_method, '')), '^\s+|\s+$', '', 'g'), '[\s-]+', '_', 'g');
begin
  if v_m = '' then return 'other'; end if;
  if v_m in ('gift', 'giftcard', 'gift_card', 'gift_cards') then return 'gift_card'; end if;
  return v_m;
end
$fn$;

-- What kind of money a method is (_shared/accountingDay.js tenderKind), folded to the five
-- the reports show: card, cash, gift_card, loyalty, other.
--   loyalty = the accounting layer's 'discount' kind: loyalty rewards and promo codes.
--   other   = its 'deposit', 'unallocated' and 'other' kinds.
-- The order of the tests is the accounting layer's and matters ('gift_card+cash' is cash).
create or replace function public._rds_tender_bucket(p_method text)
returns text
language plpgsql
immutable
parallel safe
as $fn$
declare
  v_m text := public._rds_canon(p_method);
begin
  return case
           when v_m in ('split', 'unallocated') then 'other'
           when v_m like '%loyalty%' or v_m like '%promo%' or v_m like '%reward%' or v_m = 'discount' then 'loyalty'
           when v_m like '%cash%' then 'cash'
           when v_m like '%gift%' then 'gift_card'
           when v_m like 'booking%' or v_m like '%deposit%' or v_m like '%prepaid%' then 'other'
           when v_m ~ 'card|stripe|adyen|ryft|online|apple|google|contactless|visa|master|amex|terminal|pax|tap|credit|debit' then 'card'
           else 'other'
         end;
end
$fn$;

-- The instant a wall clock time happens in a zone (_shared/businessDay.js wallTimeToInstant).
-- A time the clocks show twice is the FIRST time it is shown; a time the clocks skip is the
-- first moment after the gap. p_minutes is minutes after midnight on p_day.
create or replace function public._rds_wall(p_day date, p_minutes integer, p_tz text)
returns timestamptz
language plpgsql
stable
parallel safe
as $fn$
declare
  v_w timestamp := p_day::timestamp + make_interval(mins => p_minutes);
  v_g timestamptz := v_w at time zone p_tz;      -- Postgres's own reading of the wall time
  v_c timestamptz;
begin
  -- An earlier instant that shows the same wall time means the clocks went back: take the first.
  v_c := v_g - interval '1 hour';
  if (v_c at time zone p_tz) = v_w then return v_c; end if;
  v_c := v_g - interval '30 minutes';
  if (v_c at time zone p_tz) = v_w then return v_c; end if;
  return v_g;
end
$fn$;

-- A JSON time to an instant (_shared/accountingDay.js refundAtMs): epoch milliseconds as a
-- number or as digits in text, else a written date. Anything unusable is null, never an error.
create or replace function public._rds_ms(p_v jsonb)
returns timestamptz
language plpgsql
stable
parallel safe
set search_path = public
as $fn$
declare
  v_t text;
  v_n numeric;
begin
  if p_v is null or jsonb_typeof(p_v) not in ('number', 'string') then
    return null;
  end if;
  v_t := p_v #>> '{}';
  if v_t = '' then
    return null;
  end if;
  if jsonb_typeof(p_v) = 'number' or v_t ~ '^[0-9]+$' then
    v_n := v_t::numeric;
    if v_n > 0 and v_n < 1e14 then
      return to_timestamp((v_n / 1000)::double precision);
    end if;
    return null;
  end if;
  begin
    return v_t::timestamptz;
  exception when others then
    return null;
  end;
end
$fn$;

-- What a gift card record says was really debited, in pence
-- (_shared/accountingDay.js legacyGiftMinor): each leg's applied, legs that failed left out.
create or replace function public._rds_gift_minor(p_gift jsonb)
returns bigint
language sql
immutable
parallel safe
set search_path = public
as $fn$
  select case when jsonb_typeof(p_gift) <> 'object' then 0 else coalesce((
           select sum(greatest(0, round(public._rds_num(l -> 'applied'))))
             from jsonb_array_elements(case when jsonb_typeof(p_gift -> 'legs') = 'array'
                                             and jsonb_array_length(p_gift -> 'legs') > 0
                                            then p_gift -> 'legs' else jsonb_build_array(p_gift) end) as l
            where jsonb_typeof(l) = 'object'
              and coalesce(l -> 'commit_error', 'null'::jsonb) in ('null'::jsonb, 'false'::jsonb, '""'::jsonb, '0'::jsonb)
         ), 0)::bigint end;
$fn$;

-- The money of a check written BEFORE closed_checks.tenders, in pence by bucket
-- (_shared/accountingDay.js legacyTenders, the same rules in the same order). Only rows with
-- no tenders reach this (old rows, and the kiosk, which still writes none), so it is never
-- on the hot path.
create or replace function public._rds_legacy_tenders(p_method text, p_payment_method text, p_source text,
                                                      p_total numeric, p_tip numeric, p_gift jsonb,
                                                      p_loyalty jsonb, p_promo jsonb, p_intents jsonb)
returns jsonb
language plpgsql
immutable
parallel safe
set search_path = public
as $fn$
declare
  v_raw     text := coalesce(nullif(p_payment_method, ''), nullif(p_method, ''), 'other');
  v_tip     bigint := greatest(0, round(coalesce(p_tip, 0) * 100));
  v_total   bigint := greatest(0, round(coalesce(p_total, 0) * 100));
  v_source  text := lower(coalesce(p_source, ''));
  v_card    bigint := 0;
  v_cash    bigint := 0;
  v_gift    bigint := 0;
  v_loy     bigint := 0;
  v_other   bigint := 0;
  v_g       bigint := public._rds_gift_minor(p_gift);
  v_l       bigint := greatest(0, round(public._rds_num(p_loyalty -> 'discount_value')));          -- pence
  v_p       bigint := greatest(0, round(public._rds_num(p_promo -> 'discount_value') * 100));      -- pounds
  v_segs    text[];
  v_base    text;
  v_credits text[];
  v_legs    bigint := 0;
  v_legn    integer := 0;
  v_used    bigint := 0;
  v_part    text;
  v_m       text;
  v_i       integer;
  v_whole   bigint;
  -- One place puts pence on a bucket.
  v_b       text;
  v_amt     bigint;
begin
  -- A single tender holding the whole check keeps its tip: max(0, total - tip) + tip.
  v_whole := greatest(0, v_total - v_tip) + v_tip;

  -- THE KIOSK: total is the CARD amount (tip in, net of every credit); the credits are its own fields.
  if v_source = 'kiosk' then
    v_gift := v_g; v_loy := v_l + v_p;
    if v_total > 0 then v_card := v_total; end if;
    return jsonb_build_object('card', v_card, 'cash', 0, 'gift_card', v_gift, 'loyalty', v_loy, 'other', 0);
  end if;

  -- Online, gift card or reward only (no card charged).
  if v_source = 'online' and position(':' in coalesce(p_payment_method, '')) = 0
     and public._rds_canon(p_method) in ('gift_card', 'loyalty', 'split') and (v_g > 0 or v_l > 0 or v_p > 0) then
    return jsonb_build_object('card', 0, 'cash', 0, 'gift_card', v_g, 'loyalty', v_l + v_p, 'other', 0);
  end if;

  -- 'gift_card:10.00,loyalty:2.00,card:18.00': the online card path's own list, read as written.
  if position(':' in v_raw) > 0
     and v_raw ~* '^\s*[a-z_ ]+:\s*[0-9]+(\.[0-9]+)?\s*(,\s*[a-z_ ]+:\s*[0-9]+(\.[0-9]+)?\s*)*$' then
    foreach v_part in array string_to_array(v_raw, ',') loop
      v_i := length(v_part) - position(':' in reverse(v_part)) + 1;   -- the last ':'
      v_b := public._rds_tender_bucket(left(v_part, v_i - 1));
      v_amt := round(public._rds_num(to_jsonb(btrim(substr(v_part, v_i + 1)))) * 100);
      if v_b = 'card' then v_card := v_card + v_amt;
      elsif v_b = 'cash' then v_cash := v_cash + v_amt;
      elsif v_b = 'gift_card' then v_gift := v_gift + v_amt;
      elsif v_b = 'loyalty' then v_loy := v_loy + v_amt;
      else v_other := v_other + v_amt; end if;
    end loop;
    return jsonb_build_object('card', v_card, 'cash', v_cash, 'gift_card', v_gift, 'loyalty', v_loy, 'other', v_other);
  end if;

  -- 'gift_card+card', 'booking+cash': the till's composite.
  select coalesce(array_agg(c order by n), '{}') into v_segs
    from (select public._rds_canon(s) as c, n from unnest(string_to_array(v_raw, '+')) with ordinality as u(s, n)) q
   where c <> 'other';
  if coalesce(array_length(v_segs, 1), 0) > 1 or v_segs[1] = 'booking' then
    v_base := v_segs[array_length(v_segs, 1)];
    v_credits := v_segs[1 : array_length(v_segs, 1) - 1];
    -- Booking credit legs the row carries inside payment_intents ({ amountMinor, method }).
    select coalesce(sum(a), 0), count(*) into v_legs, v_legn
      from (select greatest(0, round(public._rds_num(l -> 'amountMinor'))) as a
              from jsonb_array_elements(case when jsonb_typeof(p_intents) = 'array' then p_intents else '[]'::jsonb end) as l
             where jsonb_typeof(l) = 'object' and coalesce(l ->> 'method', '') ~* '^booking') q
     where a > 0;
    if not exists (select 1 from unnest(v_segs) s where s not like 'booking%') then
      -- All booking credit: a deposit (other). With no legs recorded nobody can place it (other).
      v_other := case when v_legn > 0 then v_legs else v_whole end;
      return jsonb_build_object('card', 0, 'cash', 0, 'gift_card', 0, 'loyalty', 0, 'other', v_other);
    end if;
    if v_base = 'split' or exists (select 1 from unnest(v_credits) c where c <> 'gift_card' and c not like 'booking%') then
      -- A loyalty or promo credit the row never stored: one unallocated tender.
      return jsonb_build_object('card', 0, 'cash', 0, 'gift_card', 0, 'loyalty', 0, 'other', v_whole);
    end if;
    if 'gift_card' = any (v_credits) and v_g > 0 then v_gift := v_g; v_used := v_used + v_g; end if;
    if exists (select 1 from unnest(v_credits) c where c like 'booking%') then v_other := v_legs; v_used := v_used + v_legs; end if;
    v_amt := greatest(0, v_total - v_used);
    v_b := public._rds_tender_bucket(v_base);
    if v_b = 'card' then v_card := v_card + v_amt;
    elsif v_b = 'cash' then v_cash := v_cash + v_amt;
    elsif v_b = 'gift_card' then v_gift := v_gift + v_amt;
    elsif v_b = 'loyalty' then v_loy := v_loy + v_amt;
    else v_other := v_other + v_amt; end if;
    return jsonb_build_object('card', v_card, 'cash', v_cash, 'gift_card', v_gift, 'loyalty', v_loy, 'other', v_other);
  end if;

  -- One method holds the whole check. An old 'split' cannot be split after the fact (other).
  v_m := coalesce(v_segs[1], public._rds_canon(v_raw));
  v_b := case when v_m = 'split' then 'other' else public._rds_tender_bucket(v_m) end;
  return jsonb_build_object(
    'card', case when v_b = 'card' then v_whole else 0 end,
    'cash', case when v_b = 'cash' then v_whole else 0 end,
    'gift_card', case when v_b = 'gift_card' then v_whole else 0 end,
    'loyalty', case when v_b = 'loyalty' then v_whole else 0 end,
    'other', case when v_b = 'other' then v_whole else 0 end);
end
$fn$;

-- One refunds[] entry as the money that really went back, in pence
-- (_shared/accountingDay.js refundParts, the same rules in the same order):
--   counted false = no money moved (failed, still pending on a card, nothing to give back).
-- amount includes its tip, service and tax parts. Where the money went back (which tender) is
-- not worked out here.
create or replace function public._rds_refund(p_entry jsonb, p_total numeric, p_subtotal numeric, p_tip numeric,
                                              p_service numeric, p_tax_amount numeric,
                                              out amount bigint, out tip bigint, out service bigint,
                                              out tax bigint, out counted boolean)
language plpgsql
immutable
parallel safe
set search_path = public
as $fn$
declare
  v_status text := lower(coalesce(p_entry ->> 'cardStatus', ''));
  v_legs   jsonb := case when jsonb_typeof(p_entry -> 'legs') = 'array' then p_entry -> 'legs' else '[]'::jsonb end;
  v_nlegs  integer;
  v_failed bigint;
  v_total  bigint := greatest(1, round(coalesce(p_total, 0) * 100));
  v_ctax   bigint;
  v_split  boolean;
  v_t0     bigint;
  v_s0     bigint;
begin
  amount := greatest(0, round(public._rds_num(p_entry -> 'amount') * 100));
  tip := 0; service := 0; tax := 0; counted := false;
  if p_entry -> 'failed' = 'true'::jsonb then return; end if;
  -- Written BEFORE the processor is called. Still pending means the till stopped part way.
  if v_status = 'pending' and public._rds_canon(p_entry ->> 'tenderMethod') <> 'cash' then return; end if;
  if amount <= 0 then amount := 0; return; end if;

  select count(*), coalesce(sum(greatest(0, round(public._rds_num(l -> 'amountMinor'))))
                              filter (where lower(coalesce(l ->> 'status', '')) = 'failed'), 0)
    into v_nlegs, v_failed
    from jsonb_array_elements(v_legs) as l
   where jsonb_typeof(l) = 'object';
  if v_status in ('partial', 'failed') and v_nlegs > 0 then
    -- Card reversals that failed moved no money.
    amount := greatest(0, amount - v_failed);
    if amount <= 0 then amount := 0; return; end if;
  elsif v_status = 'failed' then
    return;
  end if;

  v_split := coalesce(jsonb_typeof(p_entry -> 'tipAmount'), 'null') <> 'null'
          or coalesce(jsonb_typeof(p_entry -> 'serviceAmount'), 'null') <> 'null';
  if v_split then
    tip := greatest(0, round(public._rds_num(p_entry -> 'tipAmount') * 100));
    service := greatest(0, round(public._rds_num(p_entry -> 'serviceAmount') * 100));
  elsif jsonb_typeof(p_entry -> 'items') = 'array' and jsonb_array_length(p_entry -> 'items') > 0 then
    tip := 0; service := 0;                       -- an old item refund: the amount was the items
  else
    -- A processor side refund: the check's own tip and service, pro rata.
    tip := round((round(coalesce(p_tip, 0) * 100) * amount)::numeric / v_total);
    service := round((round(coalesce(p_service, 0) * 100) * amount)::numeric / v_total);
  end if;
  if tip + service > amount then
    -- Largest remainder, ties to the tip (allocate() in the accounting layer).
    v_t0 := floor((amount * tip)::numeric / (tip + service));
    v_s0 := floor((amount * service)::numeric / (tip + service));
    if amount - v_t0 - v_s0 > 0 then
      if ((amount * tip) % (tip + service)) >= ((amount * service) % (tip + service)) then v_t0 := v_t0 + 1;
      else v_s0 := v_s0 + 1; end if;
    end if;
    tip := v_t0; service := v_s0;
  end if;

  if coalesce(jsonb_typeof(p_entry -> 'taxAmount'), 'null') <> 'null' and p_entry -> 'taxAmount' <> '""'::jsonb then
    tax := greatest(0, round(public._rds_num(p_entry -> 'taxAmount') * 100));
  else
    v_ctax := case when p_tax_amount is not null then greatest(0, round(p_tax_amount * 100))
                   else greatest(0, round(coalesce(p_total, 0) * 100) - round(coalesce(p_subtotal, 0) * 100)
                                    - round(coalesce(p_service, 0) * 100) - round(coalesce(p_tip, 0) * 100)) end;
    tax := round((v_ctax * amount)::numeric / v_total);
  end if;
  tax := least(tax, amount - tip - service);
  counted := true;
end
$fn$;

-- ── the function ─────────────────────────────────────────────────────────────

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
    if v_tz is null or v_tz !~ '^(UTC|[A-Za-z_]+(/[A-Za-z0-9_+-]+)+)$' then
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

-- Signed in users only. Supabase grants new functions to anon by default, so take it away.
revoke all on function public.report_day_sums(text[], date, date, jsonb) from public, anon;
grant execute on function public.report_day_sums(text[], date, date, jsonb) to authenticated, service_role;

revoke all on function public._rds_num(jsonb) from public, anon;
revoke all on function public._rds_canon(text) from public, anon;
revoke all on function public._rds_tender_bucket(text) from public, anon;
revoke all on function public._rds_wall(date, integer, text) from public, anon;
revoke all on function public._rds_ms(jsonb) from public, anon;
revoke all on function public._rds_gift_minor(jsonb) from public, anon;
revoke all on function public._rds_legacy_tenders(text, text, text, numeric, numeric, jsonb, jsonb, jsonb, jsonb) from public, anon;
revoke all on function public._rds_refund(jsonb, numeric, numeric, numeric, numeric, numeric) from public, anon;
-- The function runs as the caller, so the caller must be able to run its working parts.
-- They are pure arithmetic on what they are handed: they read no table.
grant execute on function public._rds_num(jsonb) to authenticated, service_role;
grant execute on function public._rds_canon(text) to authenticated, service_role;
grant execute on function public._rds_tender_bucket(text) to authenticated, service_role;
grant execute on function public._rds_wall(date, integer, text) to authenticated, service_role;
grant execute on function public._rds_ms(jsonb) to authenticated, service_role;
grant execute on function public._rds_gift_minor(jsonb) to authenticated, service_role;
grant execute on function public._rds_legacy_tenders(text, text, text, numeric, numeric, jsonb, jsonb, jsonb, jsonb) to authenticated, service_role;
grant execute on function public._rds_refund(jsonb, numeric, numeric, numeric, numeric, numeric) to authenticated, service_role;

-- So the app sees the new function straight away.
notify pgrst, 'reload schema';

-- VISIBLE CHECK: one row, every column true.
--   reads_as_the_caller        SECURITY INVOKER: the table's own rule still decides every row
--   signed_in_can_run          a Back Office login can call it
--   public_key_cannot_run      anon cannot, for the function or any working part
--   table_rule_still_there     closed_checks still has row level security and its read rule
--   day_maths_ok               06:30 in London on 25 Oct 2026 (clocks go back) is 06:30 GMT,
--                              and 01:30 that night is the FIRST 01:30 (BST)
--   uses_the_existing_index    the (location_id, closed_at) index it reads along is there
--   working_parts              all eight helpers are installed
select
  not p.prosecdef as reads_as_the_caller,
  has_function_privilege('authenticated', p.oid, 'execute') as signed_in_can_run,
  not has_function_privilege('anon', p.oid, 'execute')
    and not exists (select 1 from pg_proc h
                     where h.pronamespace = 'public'::regnamespace and h.proname like '\_rds\_%'
                       and has_function_privilege('anon', h.oid, 'execute')) as public_key_cannot_run,
  (select c.relrowsecurity from pg_class c where c.oid = 'public.closed_checks'::regclass)
    and exists (select 1 from pg_policies q
                 where q.schemaname = 'public' and q.tablename = 'closed_checks' and q.cmd = 'SELECT') as table_rule_still_there,
  public._rds_wall(date '2026-10-25', 390, 'Europe/London') = timestamptz '2026-10-25 06:30:00+00'
    and public._rds_wall(date '2026-10-25', 90, 'Europe/London') = timestamptz '2026-10-25 00:30:00+00' as day_maths_ok,
  exists (select 1 from pg_indexes i
           where i.schemaname = 'public' and i.tablename = 'closed_checks'
             and i.indexdef like '%(location_id, closed_at%') as uses_the_existing_index,
  (select count(*) = 8 from pg_proc h
    where h.pronamespace = 'public'::regnamespace and h.proname like '\_rds\_%') as working_parts
from pg_proc p
where p.oid = 'public.report_day_sums(text[], date, date, jsonb)'::regprocedure;
