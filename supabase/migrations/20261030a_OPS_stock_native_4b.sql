-- 20261030a_OPS_stock_native_4b.sql
-- Release 5.11.100, multi site stock Drop 4b: the rest of the head office stock reports.
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  NEEDS live first: Drop 3 (20261027a), Drop 4a (20261026a), Reports align #
-- #  (20261029a) and the storage fix of 23 Oct (20261029b). The guard refuses #
-- #  otherwise. One transaction: any error and nothing changes.               #
-- #  Run after UK close. NEVER on 25 Oct 2026 (UK clocks) or 1 Nov 2026       #
-- #  (US clocks). Lock wait 3 s (it gives up, nothing changes).               #
-- ############################################################################
--
-- WHAT IT ADDS (Back Office > Reports > Stock and GP, multi site companies only)
--   1. Five reports: Off contract spend (stock_report_off_contract), Purchase budget
--      (stock_report_budget), Transfers and central kitchen (stock_report_transfers), Count compliance
--      (stock_report_count_compliance) and the Month end pack (stock_report_month_end).
--   2. The closing stock journal: stock_month_end_journal (what each legal company would send) and
--      stock_month_end_journal_record (what the xero-stock-journal edge function sent). Xero gets a
--      DRAFT manual journal only, when a person presses Send. Nothing is ever posted by itself.
--   3. Stock value: an In transit column (stock sent to a site and not yet received, at the sender's
--      cost) and the central kitchen markup taken out of the company value (decision 5). Site rows keep
--      the site's own cost.
--   4. Purchases: orders sent unapproved, lines added at delivery (substitutions), credit notes and
--      invoices after credit notes, deliveries with no invoice. Price paid: overcharges and credits.
--   5. The league and the dashboard: the purchase budget for the period, the last full count against
--      the count plan (on time, late, missed), and the Drop 3 needs attention rows.
--   6. A locked period's snapshot now holds every figure the reports read (stock_lock_period), and a
--      snapshot written before tonight is read with its old names too.
--   7. The weekly email: a 'weekly' kind of the stock alert sender, on each venue's clock, after the
--      count plan deadline (stock_notify_due and stock_notify_targets).
--   8. Export of the five new reports.
--
-- HOW IT CHANGES WHAT IS THERE
--   Eight live functions are renamed to an internal name and a new function of the same public name
--   calls them and adds the new figures (stock_report_league, stock_report_dashboard,
--   stock_report_attention, stock_report_value, stock_report_purchases, stock_report_prices,
--   stock_notify_due, stock_notify_targets). Three are replaced (stock_rp__snapshot,
--   stock_report_export_start, stock_lock_period). Each of the eleven is checked by md5 against what is
--   live first, and saved in stock_native_backup as 4b:<name> for the rollback. One CHECK gains a kind
--   (stock_notify_sent: 'weekly').
--
-- WHAT IT NEVER DOES
--   It writes no site row, ledger row, sale, count, order, login or link. It changes no figure that
--   is on a screen today: every new figure is a new key. It touches no storage policy.
--
-- HOW IT RUNS
--   Paste the whole file into the SQL editor and run it once. The first statement is the guard; the
--   last result is the check row. Paste it back to Claude.
--
-- ROLLBACK
--   20261030a_OPS_stock_native_4b_ROLLBACK.sql. Run it BEFORE any 4a, Reports align or Drop 3 rollback.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.stock_budgets') is null or to_regclass('public.stock_notify_sent') is null or to_regclass('public.stock_po_approvals') is null
     or to_regclass('public.stock_credit_requests') is null or to_regclass('public.stock_credit_notes') is null or to_regclass('public.stock_invoice_inbox') is null
     or to_regclass('public.stock_count_plans') is null or to_regclass('public.stock_recharge_posts') is null
     or to_regprocedure('public.stock_lock_period(uuid,date,date)') is null or to_regprocedure('public.stock_notify_due()') is null
     or to_regprocedure('public.stock_co__count_due_rows(uuid,uuid[],date)') is null then
    raise exception 'Run 20261027a_OPS_stock_native_3.sql first. Nothing was changed.';
  end if;
  if to_regclass('public.stock_targets') is null or to_regprocedure('public.stock_report_league(uuid,uuid[],date,date,jsonb,jsonb,integer)') is null
     or to_regprocedure('public.stock_rp__site_figures(jsonb,jsonb)') is null or to_regclass('public.stock_native_backup') is null then
    raise exception 'Run 20261026a_OPS_stock_native_4a.sql first. Nothing was changed.';
  end if;
  if to_regprocedure('public._sales_refund_parts(public.closed_checks,jsonb)') is null then
    raise exception 'Run 20261029a_OPS_reports_align.sql first. Nothing was changed.';
  end if;
  if to_regprocedure('public.stock_invoice_inbox_upload_ok(text)') is null
     or exists (select 1 from pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects'
                 and coalesce(p.qual, '') || coalesce(p.with_check, '') ~ 'stock_level') then
    raise exception 'Run 20261029b_OPS_storage_inbox_upload_ok.sql first (the storage fix of 23 Oct). Nothing was changed.';
  end if;
  if to_regclass('public.stock_month_end_journals') is not null
     or to_regprocedure('public.stock_rp__value_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)') is not null
     or exists (select 1 from public.stock_native_backup b where left(b.name, 3) = '4b:') then
    raise exception 'Drop 4b has run already. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '300s';

-- ============================================================================
-- STEP 0. THE ELEVEN BODIES THIS FILE RENAMES OR REPLACES, AND FOUR IT READS, STILL AS LIVE
-- (md5 of the source, white space made one space: the 0a rule)
-- ============================================================================
do $bodies$
declare
  v_bad text;
begin
  select string_agg(e.sig, ', ' order by e.sig) into v_bad
    from (values
      ('public.stock_rp__snapshot(uuid,date,date)', '337b3eced4a784a310ab6a9a19698196'),
      ('public.stock_report_league(uuid,uuid[],date,date,jsonb,jsonb,integer)', '187e57cdd30206a996f57577fcc1b786'),
      ('public.stock_report_dashboard(uuid,uuid[],date,date,jsonb,jsonb,integer)', 'd0323ceee050a123f7a310de73b77eb4'),
      ('public.stock_report_attention(uuid,uuid[],date,date,jsonb,jsonb,integer)', 'a72f1d26901dc4ef4170ffb3561d18c2'),
      ('public.stock_report_value(uuid,uuid[],date,date,jsonb,jsonb,integer)', '9ce59583f9e9f0f59083ceeb1baa0b99'),
      ('public.stock_report_purchases(uuid,uuid[],date,date,jsonb,jsonb,integer)', 'e383750b568d9b5deb87ac8afd0bb1cb'),
      ('public.stock_report_prices(uuid,uuid[],date,date,jsonb,jsonb,integer)', 'b5a575d346e06b1302da576e85928651'),
      ('public.stock_report_export_start(text,jsonb)', '9cbe7bd979cb18856f055113f1705039'),
      ('public.stock_lock_period(uuid,date,date)', '8a77de5d4fc115b4922a8b332e3db5da'),
      ('public.stock_notify_due()', '8958a67ff641ea9270a8ac5632dd19ae'),
      ('public.stock_notify_targets(bigint)', '276132acb90aff16aa031fcecada9aff'),
      -- read only: 4b's new figures rely on these as they are
      ('public.stock_rp__site_figures(jsonb,jsonb)', '61302c621256eb638c977eb452bc4724'),
      ('public.stock_rp__windows(jsonb,date,date,boolean)', '7d695565d0da046538dfb3f0a39c5805'),
      ('public.stock_co__count_due_rows(uuid,uuid[],date)', '578c33287f913776dbba88e17b881269'),
      ('public.stock_co__forecast_amount(uuid,date)', 'da368fbe7c89eaf9bdc2685d0f43fa96')
    ) as e(sig, want)
    left join pg_proc p on p.oid = to_regprocedure(e.sig)
   where p.oid is null
      or md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) is distinct from e.want;
  if v_bad is not null then
    raise exception 'A stock function changed since this file was written. Ask Claude for a new file. Changed: %. Nothing was changed.', v_bad;
  end if;
  if (select md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) from pg_proc p where p.oid = to_regprocedure('public.stock_invoice_inbox_upload_ok(text)'))
     not in ('adde31d11f803c6d069548712db613bb', '55eae407423d4a30610a40f4e4627b4b') then
    raise exception 'The storage upload check changed since this file was written. Ask Claude for a new file. Nothing was changed.';
  end if;
  if (select pg_get_constraintdef(c.oid) from pg_constraint c
       where c.conrelid = 'public.stock_notify_sent'::regclass and c.conname = 'stock_notify_sent_kind_check')
     is distinct from 'CHECK ((kind = ANY (ARRAY[''order_by''::text, ''approval_wait''::text, ''approval_60''::text, ''approval_30''::text, ''sent_unapproved''::text, ''price_rise''::text, ''invoice_unplaced''::text, ''count_due''::text, ''count_missed''::text, ''count_second_approval''::text, ''transfer_waiting''::text, ''delivery_overdue''::text])))' then
    raise exception 'The alert kinds of stock_notify_sent are not as written for. Ask Claude. Nothing was changed.';
  end if;
end
$bodies$;

-- ============================================================================
-- STEP 1. THE SNAPSHOT: every count and sum this file must leave alone, per venue, and the logins
-- ============================================================================
create temp table _stock_native4b_snap (location_id uuid, metric text, value numeric, txt text) on commit drop;
create temp table _stock_native4b_now (location_id uuid, metric text, value numeric, txt text) on commit drop;

create temp view _stock_native4b_metrics as
select l.id as location_id, m.metric, m.value
  from public.locations l
 cross join lateral (values
   ('n:inventory_items',   (select count(*) from public.inventory_items x where x.location_id = l.id)::numeric),
   ('n:stock_movements',   (select count(*) from public.stock_movements x where x.location_id = l.id)::numeric),
   ('n:stock_counts',      (select count(*) from public.stock_counts x where x.location_id = l.id)::numeric),
   ('n:purchase_orders',   (select count(*) from public.purchase_orders x where x.location_id = l.id)::numeric),
   ('n:supplier_invoices', (select count(*) from public.supplier_invoices x where x.location_id = l.id)::numeric),
   ('n:stock_transfers',   (select count(*) from public.stock_transfers x where x.location_id = l.id)::numeric),
   ('n:waste_events',      (select count(*) from public.waste_events x where x.location_id = l.id)::numeric),
   ('n:stock_day_sums',    (select count(*) from public.stock_day_sums x where x.location_id = l.id)::numeric),
   ('n:sales_day_sums',    (select count(*) from public.sales_day_sums x where x.location_id = l.id)::numeric),
   ('n:stock_periods',     (select count(*) from public.stock_periods x where x.location_id = l.id)::numeric),
   ('s:on_hand',           (select sum(x.on_hand) from public.inventory_items x where x.location_id = l.id)),
   ('s:books',             (select sum(x.on_hand * x.current_cost) from public.inventory_items x where x.location_id = l.id)),
   ('s:mv_value',          (select sum(x.value_delta) from public.stock_movements x where x.location_id = l.id)),
   ('s:day_value',         (select sum(x.value) from public.stock_day_sums x where x.location_id = l.id)),
   ('s:sales_net',         (select sum(x.net) from public.sales_day_sums x where x.location_id = l.id))
 ) as m(metric, value)
 where exists (select 1 from public.sales_day_sums s where s.location_id = l.id)
    or exists (select 1 from public.inventory_items i where i.location_id = l.id);

insert into _stock_native4b_snap (location_id, metric, value) select * from _stock_native4b_metrics;
insert into _stock_native4b_snap (location_id, metric, value, txt)
values ('00000000-0000-0000-0000-000000000000', 'md5:user_profiles', 0,
        (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.user_profiles t)),
       ('00000000-0000-0000-0000-000000000000', 'md5:user_locations', 0,
        (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.user_locations t));

-- ============================================================================
-- STEP 2. THE BACKUP: the eleven bodies as they are tonight (pg_get_functiondef text, replayable) and
-- the alert kind CHECK, in 0a's backup table as 4b:<name>. The rollback uses them and deletes these rows.
-- ============================================================================
insert into public.stock_native_backup (name, body, md5)
select '4b:' || p.proname, pg_get_functiondef(p.oid), md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')))
  from (values
    ('public.stock_rp__snapshot(uuid,date,date)'),
    ('public.stock_report_league(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
    ('public.stock_report_dashboard(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
    ('public.stock_report_attention(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
    ('public.stock_report_value(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
    ('public.stock_report_purchases(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
    ('public.stock_report_prices(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
    ('public.stock_report_export_start(text,jsonb)'),
    ('public.stock_lock_period(uuid,date,date)'),
    ('public.stock_notify_due()'),
    ('public.stock_notify_targets(bigint)')
  ) as f(sig)
  join pg_proc p on p.oid = to_regprocedure(f.sig);
insert into public.stock_native_backup (name, body, md5)
select '4b:check:stock_notify_sent_kind_check', pg_get_constraintdef(c.oid), md5(pg_get_constraintdef(c.oid))
  from pg_constraint c where c.conrelid = 'public.stock_notify_sent'::regclass and c.conname = 'stock_notify_sent_kind_check';

-- ============================================================================
-- STEP 3. THE EIGHT RENAMES: the live body keeps its text under an internal name (an owner only
-- function from STEP 9 on); a new function of the public name calls it and adds the 4b figures.
-- ============================================================================
alter function public.stock_report_league(uuid, uuid[], date, date, jsonb, jsonb, integer) rename to stock_rp__league_4a;
alter function public.stock_report_dashboard(uuid, uuid[], date, date, jsonb, jsonb, integer) rename to stock_rp__dashboard_4a;
alter function public.stock_report_attention(uuid, uuid[], date, date, jsonb, jsonb, integer) rename to stock_rp__attention_4a;
alter function public.stock_report_value(uuid, uuid[], date, date, jsonb, jsonb, integer) rename to stock_rp__value_4a;
alter function public.stock_report_purchases(uuid, uuid[], date, date, jsonb, jsonb, integer) rename to stock_rp__purchases_4a;
alter function public.stock_report_prices(uuid, uuid[], date, date, jsonb, jsonb, integer) rename to stock_rp__prices_4a;
alter function public.stock_notify_due() rename to stock_co__notify_due_d3;
alter function public.stock_notify_targets(bigint) rename to stock_co__notify_targets_d3;

-- ============================================================================
-- STEP 4. THE ONE NEW TABLE: what was sent to Xero as a closing stock journal (one row a legal company
-- and period; the edge function writes it through stock_month_end_journal_record)
-- ============================================================================
create table public.stock_month_end_journals (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references public.organisations(id) on delete cascade,
  period            date not null,
  to_day            date not null,
  tenant_id         text not null,
  tenant_name       text,
  status            text not null check (status in ('sending', 'sent', 'failed')),
  xero_journal_id   text,
  amount            numeric(14,2),
  stock_account     text,
  movement_account  text,
  sent_at           timestamptz,
  sent_by           uuid,
  sent_by_name      text,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, period, tenant_id)
);
comment on table public.stock_month_end_journals is 'Multi site stock Drop 4b (20261030a): the closing stock journal sent to Xero as a DRAFT for one legal company and month. sending = claimed before the Xero call (one at a time), sent, or failed (may be sent again). Written only by stock_month_end_journal_claim and stock_month_end_journal_record (the xero-stock-journal edge function, service role). A login reads its own companies.';
alter table public.stock_month_end_journals enable row level security;
revoke all on table public.stock_month_end_journals from public, anon, authenticated, service_role;
grant select on table public.stock_month_end_journals to authenticated, service_role;
create policy stock_month_end_journals_read on public.stock_month_end_journals for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));
create policy second_step_fence on public.stock_month_end_journals as restrictive for all to authenticated
  using ((select public.second_step_ok())) with check ((select public.second_step_ok()));

-- ============================================================================
-- STEP 5. THE ALERT KIND CHECK gains 'weekly' (the weekly email)
-- ============================================================================
alter table public.stock_notify_sent drop constraint stock_notify_sent_kind_check;
alter table public.stock_notify_sent add constraint stock_notify_sent_kind_check
  check (kind in ('order_by', 'approval_wait', 'approval_60', 'approval_30', 'sent_unapproved', 'price_rise', 'invoice_unplaced', 'count_due',
                  'count_missed', 'count_second_approval', 'transfer_waiting', 'delivery_overdue', 'weekly'));

-- ============================================================================
-- STEP 6. THE HELPERS (internal: prefix stock_rp__, SECURITY DEFINER, owner only from STEP 9)
-- ============================================================================

-- stock_rp__snapshot (replaced): a locked period's snapshot for exactly this window at this site,
-- else null. A snapshot written before 4b (by the Drop 3 lock) used other names for three figures:
-- stock_value, count_variance and cogs. They are read as closing_value, count_adj and sold_cost when the
-- new names are missing. locked_at is added from the period.
create or replace function public.stock_rp__snapshot(p_site uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select s.metrics
         || case when not (s.metrics ? 'closing_value') and jsonb_typeof(s.metrics -> 'stock_value') = 'number'
                 then jsonb_build_object('closing_value', s.metrics -> 'stock_value') else '{}'::jsonb end
         || case when not (s.metrics ? 'count_adj') and jsonb_typeof(s.metrics -> 'count_variance') = 'number'
                 then jsonb_build_object('count_adj', s.metrics -> 'count_variance') else '{}'::jsonb end
         || case when not (s.metrics ? 'sold_cost') and jsonb_typeof(s.metrics -> 'cogs') = 'number'
                 then jsonb_build_object('sold_cost', s.metrics -> 'cogs') else '{}'::jsonb end
         || jsonb_build_object('locked_at', p.locked_at)
    from stock_periods p
    join stock_period_snapshots s on s.period_id = p.id and s.location_id = p.location_id
   where p.location_id = p_site and p.from_day = p_from and p.to_day = p_to
     and p.locked_at is not null and p.unlocked_at is null
   order by p.locked_at desc
   limit 1;
$fn$;

-- The legal company of a site: its Xero organisation (the recharge statement's rule: the newest
-- connection row of that site, by created_at). Null when the site is not connected to Xero.
create or replace function public.stock_rp__legal_of(p_site uuid)
returns table(tenant_id text, tenant_name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select x.tenant_id, x.tenant_name from xero_connections x where x.location_id = p_site order by x.created_at desc limit 1;
$fn$;

-- Stock in transit to each site at the END of business day p_day: transfers sent by then and not
-- received by then, at the sender's cost (what left the sender's books). Cancelled, draft and
-- requested transfers never count.
create or replace function public.stock_rp__in_transit(p_sites uuid[], p_day date)
returns table(location_id uuid, value numeric, n integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select t.to_location_id, round(sum(coalesce(l.qty_base, 0) * coalesce(l.unit_cost, 0)), 2), count(distinct t.id)::integer
    from stock_transfers t
    join stock_transfer_lines l on l.transfer_id = t.id and not coalesce(l.dropped, false)
   where t.to_location_id = any(p_sites) and t.sent_at is not null
     and t.status not in ('DRAFT', 'CANCELLED', 'REQUESTED')
     and public.stock_co__vday(t.to_location_id, t.sent_at) <= p_day
     and ((t.received_at is null and t.status = 'SENT')
          or (t.received_at is not null and public.stock_co__vday(t.to_location_id, t.received_at) > p_day))
   group by t.to_location_id;
$fn$;

-- The central kitchen markup inside each site's stock value at the END of business day p_day
-- (decision 5): for an item the site gets only from a central kitchen (no live supplier item at the
-- site that is not the kitchen's), its value at the site's cost less its value at the kitchen's cost,
-- by the latest received kitchen transfer line of that item (kitchen value unit_cost x qty_base
-- against the price the site paid, to_unit_cost x qty_received_base). Zero when no markup is used.
create or replace function public.stock_rp__kitchen_margin(p_sites uuid[], p_day date)
returns table(location_id uuid, kitchen_location_id uuid, margin numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with k as (
    select distinct on (t.to_location_id, l.to_inventory_item_id)
           t.to_location_id as loc, l.to_inventory_item_id as item, t.location_id as kitchen,
           coalesce(l.unit_cost, 0) * coalesce(l.qty_base, 0) as kv,
           coalesce(l.to_unit_cost, 0) * coalesce(l.qty_received_base, 0) as sv
      from stock_transfers t
      join stock_transfer_lines l on l.transfer_id = t.id and not coalesce(l.dropped, false)
     where t.to_location_id = any(p_sites) and t.kind = 'central_kitchen' and t.received_at is not null
       and l.to_inventory_item_id is not null and coalesce(l.qty_received_base, 0) > 0
       and public.stock_co__vday(t.to_location_id, t.received_at) <= p_day
     order by t.to_location_id, l.to_inventory_item_id, t.received_at desc, l.id
  )
  select v.location_id, k.kitchen, round(sum(v.value * (1 - k.kv / k.sv)), 2)
    from k
    join public.stock_rp__value_at(array(select distinct k2.loc from k k2), p_day) v
      on v.location_id = k.loc and v.inventory_item_id = k.item
   where k.sv > 0 and k.kv <> k.sv and v.value > 0
     and not exists (select 1 from supplier_products sp
                       join suppliers s on s.id = sp.supplier_id
                       left join stock_co_suppliers cs on cs.id = s.company_ref
                      where sp.inventory_item_id = k.item and sp.location_id = k.loc and sp.archived_at is null
                        and cs.internal_location_id is null)
   group by v.location_id, k.kitchen;
$fn$;

-- The purchase budget of one site over business days p_from to p_to (the Order pad rule, any length):
-- the site's budget row, else the company's; 'fixed' is the amount a week, pro rata by days; a percent
-- of the forecast is that percent of the forecast of those days (stock_co__forecast_amount). Spent is
-- the net subtotal plus the delivery fee of SENT, PARTIAL and RECEIVED orders by the venue day they
-- were ordered. budget null = no budget set. The forecast is worked out only when asked or needed.
create or replace function public.stock_rp__budget(p_site uuid, p_from date, p_to date, p_forecast boolean)
returns table(budget numeric, spent numeric, forecast numeric, rule text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_b   stock_budgets;
  v_f   numeric;
  v_s   numeric;
begin
  select l.org_id into v_org from locations l where l.id = p_site;
  select * into v_b from stock_budgets b where b.org_id = v_org and b.location_id = p_site;
  if v_b.id is null then
    select * into v_b from stock_budgets b where b.org_id = v_org and b.location_id is null;
  end if;
  select coalesce(sum(coalesce(po.subtotal, 0) + coalesce(po.delivery_fee, 0)), 0) into v_s
    from purchase_orders po
   where po.location_id = p_site and po.status in ('SENT', 'PARTIAL', 'RECEIVED')
     and coalesce(po.ordered_at, po.created_at) >= p_from::timestamp - interval '2 days'
     and coalesce(po.ordered_at, po.created_at) < p_to::timestamp + interval '3 days'
     and public.stock_co__vday(p_site, coalesce(po.ordered_at, po.created_at)) between p_from and p_to;
  if coalesce(p_forecast, false) or v_b.rule = 'pct_of_forecast' then
    select coalesce(sum(public.stock_co__forecast_amount(p_site, p_from + k)), 0) into v_f from generate_series(0, p_to - p_from) k;
  end if;
  return query
  select case when v_b.id is null then null::numeric
              when v_b.rule = 'fixed' then round(v_b.amount * (p_to - p_from + 1) / 7.0, 2)
              else round(coalesce(v_f, 0) * v_b.pct / 100.0, 2) end,
         round(v_s, 2), round(v_f, 2), v_b.rule;
end
$fn$;

-- Goods received not invoiced at the END of business day p_day, at delivery value: received orders
-- (RECEIVED or PARTIAL, received by then) with no posted invoice dated by then. Central kitchen
-- orders never count (they arrive as transfers, never invoices).
create or replace function public.stock_rp__grni(p_sites uuid[], p_day date)
returns table(location_id uuid, value numeric, orders integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select po.location_id,
         round(coalesce(sum((select coalesce(sum(coalesce(l.qty_received, 0) * coalesce(l.unit_price, 0)), 0) from po_lines l where l.po_id = po.id)), 0), 2),
         count(*)::integer
    from purchase_orders po
    left join suppliers s on s.id = po.supplier_id
    left join stock_co_suppliers cs on cs.id = s.company_ref
   where po.location_id = any(p_sites) and po.status in ('RECEIVED', 'PARTIAL') and po.received_at is not null
     and cs.internal_location_id is null
     and public.stock_co__vday(po.location_id, po.received_at) <= p_day
     and not exists (select 1 from supplier_invoices v where v.po_id = po.id and v.status = 'POSTED' and v.invoice_date <= p_day)
   group by po.location_id;
$fn$;

-- Credits still owed at the END of business day p_day: credit requests still asked, made by then,
-- less the credit notes against them dated by then.
create or replace function public.stock_rp__credits_out(p_sites uuid[], p_day date)
returns table(location_id uuid, value numeric, requests integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select r.location_id,
         round(sum(greatest(coalesce(r.amount, 0) - coalesce((select sum(n.amount) from stock_credit_notes n where n.request_id = r.id and n.note_date <= p_day), 0), 0)), 2),
         count(*)::integer
    from stock_credit_requests r
   where r.location_id = any(p_sites) and r.status = 'asked'
     and public.stock_co__vday(r.location_id, r.created_at) <= p_day
   group by r.location_id;
$fn$;

-- Recharges (decision 6, the stock_recharge_statement rule): received central kitchen transfers and
-- received transfers between sites of different legal companies, at the price the site paid
-- (to_unit_cost), by the receiving site's venue day; in for the receiver, out for the sender.
create or replace function public.stock_rp__recharges(p_sites uuid[], p_from date, p_to date)
returns table(location_id uuid, recharges_in numeric, recharges_out numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with t as (
    select tr.location_id as f, tr.to_location_id as tt, tr.kind,
           (select x.tenant_id from public.stock_rp__legal_of(tr.location_id) x) as ft,
           (select x.tenant_id from public.stock_rp__legal_of(tr.to_location_id) x) as tot,
           sum(coalesce(l.qty_received_base, 0) * coalesce(l.to_unit_cost, 0)) as amount
      from stock_transfers tr
      join stock_transfer_lines l on l.transfer_id = tr.id and not coalesce(l.dropped, false)
     where (tr.location_id = any(p_sites) or tr.to_location_id = any(p_sites))
       and tr.status in ('RECEIVED', 'DISPUTED') and tr.received_at is not null
       and tr.to_location_id is not null and tr.to_location_id <> tr.location_id
       and public.stock_co__vday(tr.to_location_id, tr.received_at) between p_from and p_to
     group by 1, 2, 3, 4, 5
  ),
  g as (select * from t where t.kind = 'central_kitchen' or t.ft is null or t.tot is null or t.ft <> t.tot)
  select z.loc, round(sum(z.i), 2), round(sum(z.o), 2)
    from (select g.tt as loc, g.amount as i, 0::numeric as o from g
          union all
          select g.f, 0, g.amount from g) z
   where z.loc = any(p_sites)
   group by z.loc;
$fn$;

-- The purchase budget on report rows (the league, the dashboard): every site row gets budget,
-- budget_spent, budget_pct and rag.budget_pct over its own window (the period, or its two counts),
-- every company row the sums of its currency's site rows (budget null when no site has one).
create or replace function public.stock_rp__budget_merge(p_org uuid, p_totals jsonb, p_windows jsonb, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with r as (
    select x.t, x.n, nullif(x.t ->> 'location_id', '')::uuid as loc, coalesce(x.t ->> 'currency', '') as cur
      from jsonb_array_elements(coalesce(p_totals, '[]'::jsonb)) with ordinality as x(t, n)
  ),
  w as (
    select r.loc, coalesce((ww ->> 'from_day')::date, p_from) as f, coalesce((ww ->> 'to_day')::date, p_to) as tt
      from r
      left join lateral (select y from jsonb_array_elements(coalesce(p_windows, '[]'::jsonb)) y
                          where y ->> 'location_id' = r.loc::text limit 1) q(ww) on true
     where r.loc is not null
  ),
  b as (
    select w.loc, x.budget, x.spent from w cross join lateral public.stock_rp__budget(w.loc, w.f, w.tt, false) x
  ),
  site as (
    select r.n, r.cur, r.loc, r.t, b.budget, b.spent from r join b on b.loc = r.loc
  ),
  co as (
    select s.cur, case when count(s.budget) = 0 then null else sum(s.budget) end as budget, sum(s.spent) as spent
      from site s group by s.cur
  )
  select coalesce(jsonb_agg(
           case when r.loc is not null then
                  r.t || jsonb_build_object('budget', s.budget, 'budget_spent', s.spent, 'budget_pct', public.stock_rp__pct(s.spent, s.budget),
                                            'rag', coalesce(case when jsonb_typeof(r.t -> 'rag') = 'object' then r.t -> 'rag' end, '{}'::jsonb)
                                                   || jsonb_build_object('budget_pct', public.stock_rp__rag(p_org, r.loc, 'budget_pct', public.stock_rp__pct(s.spent, s.budget))))
                else
                  r.t || jsonb_build_object('budget', c.budget, 'budget_spent', coalesce(c.spent, 0), 'budget_pct', public.stock_rp__pct(c.spent, c.budget),
                                            'rag', coalesce(case when jsonb_typeof(r.t -> 'rag') = 'object' then r.t -> 'rag' end, '{}'::jsonb)
                                                   || jsonb_build_object('budget_pct', public.stock_rp__rag(p_org, null, 'budget_pct', public.stock_rp__pct(c.spent, c.budget))))
           end order by r.n), '[]'::jsonb)
    from r
    left join site s on s.n = r.n
    left join co c on c.cur = r.cur and r.loc is null;
$fn$;

-- The last full count against the count plan, on league rows: the latest plan day in the last 14 days
-- to p_to at each site gives ', on time', ', late' or 'Missed <day>' (stock_co__count_due_rows, the
-- Drop 3 rule). A company with no live count plan keeps the 4a words.
create or replace function public.stock_rp__count_merge(p_org uuid, p_rows jsonb, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_sites uuid[];
  v_found jsonb := '{}'::jsonb;
  v_day   date;
  e       jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array'
     or not exists (select 1 from stock_count_plans p where p.org_id = p_org and p.active and p.archived_at is null) then
    return p_rows;
  end if;
  v_sites := array(select (x ->> 'location_id')::uuid from jsonb_array_elements(p_rows) x where jsonb_typeof(x -> 'location_id') = 'string');
  if cardinality(v_sites) = 0 then
    return p_rows;
  end if;
  for k in 0..13 loop
    v_day := p_to - k;
    for e in select y from jsonb_array_elements(public.stock_co__count_due_rows(p_org, v_sites, v_day)) y loop
      if not (v_found ? (e ->> 'location_id')) and e ->> 'status' in ('done', 'late', 'missed') then
        v_found := v_found || jsonb_build_object(e ->> 'location_id', e);
      end if;
    end loop;
    exit when (select count(*) from jsonb_object_keys(v_found)) >= cardinality(v_sites);
  end loop;
  return (select coalesce(jsonb_agg(
            case when x ? 'location_id' and v_found ? (x ->> 'location_id') then
                   x || jsonb_build_object(
                     'last_count_status', case v_found -> (x ->> 'location_id') ->> 'status' when 'done' then 'on_time' else v_found -> (x ->> 'location_id') ->> 'status' end,
                     'last_full_count_words',
                     case v_found -> (x ->> 'location_id') ->> 'status'
                       when 'missed' then 'Missed ' || to_char((v_found -> (x ->> 'location_id') ->> 'due_day')::date, 'Dy FMDD Mon')
                       when 'late' then coalesce(to_char((x ->> 'last_full_count_day')::date, 'Dy FMDD Mon'), 'Counted') || ', late'
                       else coalesce(to_char((x ->> 'last_full_count_day')::date, 'Dy FMDD Mon'), 'Counted') || ', on time' end)
                 else x end order by o), '[]'::jsonb)
            from jsonb_array_elements(p_rows) with ordinality as z(x, o));
end
$fn$;

-- What the purchases report adds per site over business days p_from to p_to: orders sent unapproved
-- (by the venue day they were sent so) and their value, lines added at delivery (qty_packs 0 and
-- something received, on orders received in the window), credit notes (net, or with VAT), and the
-- delivery value of received orders with no invoice yet. Central kitchen orders never count.
create or replace function public.stock_rp__purchase_extra(p_sites uuid[], p_from date, p_to date, p_gross boolean)
returns table(location_id uuid, sent_unapproved integer, sent_unapproved_value numeric, substitutions integer, credit_notes numeric, invoice_missing numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with s as (select unnest(p_sites) as loc),
  su as (
    select po.location_id as loc, count(*)::integer as n,
           sum(coalesce(po.subtotal, 0) + case when p_gross then coalesce(po.tax, 0) else 0 end) as v
      from purchase_orders po
     where po.location_id = any(p_sites) and po.sent_unapproved_at is not null
       and public.stock_co__vday(po.location_id, po.sent_unapproved_at) between p_from and p_to
     group by po.location_id
  ),
  sb as (
    select po.location_id as loc, count(l.id)::integer as n
      from purchase_orders po
      join po_lines l on l.po_id = po.id and coalesce(l.qty_packs, 0) = 0 and coalesce(l.qty_received, 0) > 0
     where po.location_id = any(p_sites) and po.received_at is not null
       and public.stock_co__vday(po.location_id, po.received_at) between p_from and p_to
     group by po.location_id
  ),
  cn as (
    select n.location_id as loc, sum(coalesce(n.amount, 0) + case when p_gross then coalesce(n.tax, 0) else 0 end) as v
      from stock_credit_notes n
     where n.location_id = any(p_sites) and n.note_date between p_from and p_to
     group by n.location_id
  ),
  im as (
    select po.location_id as loc, sum((select coalesce(sum(coalesce(l.qty_received, 0) * coalesce(l.unit_price, 0)), 0) from po_lines l where l.po_id = po.id)) as v
      from purchase_orders po
      left join suppliers sp on sp.id = po.supplier_id
      left join stock_co_suppliers cs on cs.id = sp.company_ref
     where po.location_id = any(p_sites) and po.status in ('RECEIVED', 'PARTIAL') and po.received_at is not null
       and cs.internal_location_id is null
       and public.stock_co__vday(po.location_id, po.received_at) between p_from and p_to
       and not exists (select 1 from supplier_invoices v where v.po_id = po.id and v.status = 'POSTED')
     group by po.location_id
  )
  select s.loc, coalesce(su.n, 0), round(coalesce(su.v, 0), 2), coalesce(sb.n, 0), round(coalesce(cn.v, 0), 2), round(coalesce(im.v, 0), 2)
    from s
    left join su on su.loc = s.loc
    left join sb on sb.loc = s.loc
    left join cn on cn.loc = s.loc
    left join im on im.loc = s.loc;
$fn$;

-- The credit figures the price paid report adds per site, by the venue day each request was made:
-- overcharges asked (reason overcharge), credit notes received (by note date), written off, requests.
create or replace function public.stock_rp__credit_figures(p_sites uuid[], p_from date, p_to date)
returns table(location_id uuid, overcharge_asked numeric, credits_received numeric, written_off numeric, credit_requests integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with s as (select unnest(p_sites) as loc),
  r as (
    select x.location_id as loc,
           sum(coalesce(x.amount, 0)) filter (where x.reason = 'overcharge') as asked,
           sum(coalesce(x.amount, 0)) filter (where x.status = 'written_off') as off,
           count(*)::integer as n
      from stock_credit_requests x
     where x.location_id = any(p_sites) and public.stock_co__vday(x.location_id, x.created_at) between p_from and p_to
     group by x.location_id
  ),
  n as (
    select x.location_id as loc, sum(coalesce(x.amount, 0)) as v
      from stock_credit_notes x where x.location_id = any(p_sites) and x.note_date between p_from and p_to
     group by x.location_id
  )
  select s.loc, round(coalesce(r.asked, 0), 2), round(coalesce(n.v, 0), 2), round(coalesce(r.off, 0), 2), coalesce(r.n, 0)
    from s left join r on r.loc = s.loc left join n on n.loc = s.loc;
$fn$;

-- A meta.notes list with the 4a words that the purchasing update now answers taken out or reworded.
create or replace function public.stock_rp__notes_4b(p_notes jsonb)
returns jsonb
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(jsonb_agg(case when n #>> '{}' = 'Purchases at delivery value until the purchasing update'
                                 then to_jsonb('Purchases at delivery value. Invoices after credit notes are in the Purchases report.'::text)
                                 else n end order by o), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_notes, '[]'::jsonb)) with ordinality as x(n, o)
   where n #>> '{}' not in ('Sent unapproved and substitutions come with the purchasing update', 'Overcharges and credits come with the purchasing update');
$fn$;

-- ============================================================================
-- STEP 6b. THE STORAGE UPLOAD CHECK, CORRECTED (the rule itself is not touched)
-- The 23 Oct fix (20261029b) compares stock_reach_orgs() (text) with a uuid, so an upload into the
-- invoice inbox raises 'operator does not exist: text = uuid' instead of answering. Nothing else
-- changes: the same three checks, the same grants (create or replace keeps them). The rollback keeps
-- this corrected body (putting the slip back would help nobody).
-- ============================================================================
create or replace function public.stock_invoice_inbox_upload_ok(p_name text)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_parts text[] := storage.foldername(p_name);
  v_org uuid;
begin
  if v_parts is null or v_parts[1] is distinct from 'org' then return false; end if;
  if v_parts[2] is null or not (v_parts[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then return false; end if;
  v_org := v_parts[2]::uuid;
  if not exists (select 1 from public.stock_reach_orgs() o where o = v_org::text) then return false; end if;
  return coalesce(public.stock_level(auth.uid(), v_org) = 'all', false);
end
$fn$;

-- ============================================================================
-- STEP 7. THE EIGHT PUBLIC NAMES AGAIN (each calls the renamed 4a or Drop 3 body, then adds)
-- ============================================================================

-- stock_report_attention: the 4a rows plus the Drop 3 rows (missed counts, approvals, sent
-- unapproved, invoices with no site, deliveries with no invoice, transfers not received after 2
-- days, price rises over 5%, counts waiting a second approval). A company row (the invoice inbox) has
-- location_id null and the site 'Company'.
create or replace function public.stock_report_attention(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
                                                         p_after jsonb default null, p_limit integer default 1000)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_a     jsonb := public.stock_rp__attention_4a(p_org, p_sites, p_from, p_to, p_opts, p_after, p_limit);
  v_sites uuid[];
  v_new   jsonb;
  v_rows  jsonb;
  v_today date;
begin
  v_sites := array(select (x ->> 'id')::uuid from jsonb_array_elements(v_a -> 'meta' -> 'sites') x);
  v_today := (select max(public.stock_co__today(x)) from unnest(v_sites) x);
  with s as (select (x ->> 'id')::uuid as id, x ->> 'name' as name from jsonb_array_elements(v_a -> 'meta' -> 'sites') x),
  missed as (
    select (e ->> 'location_id')::uuid as id, count(*) as n
      from generate_series(1, 7) k
     cross join lateral jsonb_array_elements(public.stock_co__count_due_rows(p_org, v_sites, v_today - k)) e
     where e ->> 'status' = 'missed'
     group by 1
  ),
  k as (
    select s.id, s.name, 'count_missed' as kind, m.n, m.n || ' counts missed this week.' as words, 'stock-counts' as route
      from s join missed m on m.id = s.id
    union all
    select s.id, s.name, 'approval_waiting', count(*), count(*) || ' orders waiting for approval.', 'purchase-orders'
      from s join stock_po_approvals a on a.location_id = s.id and a.status = 'waiting' group by s.id, s.name
    union all
    select s.id, s.name, 'sent_unapproved', count(*), count(*) || ' orders sent unapproved this week.', 'purchase-orders'
      from s join purchase_orders po on po.location_id = s.id and po.sent_unapproved_at >= now() - interval '7 days' group by s.id, s.name
    union all
    select null::uuid, 'Company', 'invoice_unplaced', count(*), count(*) || ' invoices need a site.', 'invoices'
      from stock_invoice_inbox b where b.org_id = p_org and b.status = 'waiting' and b.location_id is null having count(*) > 0
    union all
    select s.id, s.name, 'invoice_missing', count(*), count(*) || ' deliveries with no invoice after 7 days.', 'invoices'
      from s join purchase_orders po on po.location_id = s.id and po.status = 'RECEIVED' and po.received_at < now() - interval '7 days'
      left join suppliers sp on sp.id = po.supplier_id
      left join stock_co_suppliers cs on cs.id = sp.company_ref
     where cs.internal_location_id is null
       and not exists (select 1 from supplier_invoices v where v.po_id = po.id)
     group by s.id, s.name
    union all
    select s.id, s.name, 'transfer_overdue', count(*), count(*) || ' transfers not received after 2 days.', 'stock-transfers'
      from s join stock_transfers t on t.to_location_id = s.id and t.status = 'SENT' and t.sent_at < now() - interval '2 days' group by s.id, s.name
    union all
    select s.id, s.name, 'price_rise', count(*), count(*) || ' prices rose over 5% this week.', 'price-changes'
      from s join stock_notify_sent ns on ns.org_id = p_org and ns.location_id = s.id and ns.kind = 'price_rise' and ns.created_at > now() - interval '7 days'
     group by s.id, s.name
    union all
    select s.id, s.name, 'count_second_approval', count(*), count(*) || ' counts waiting for a second approval.', 'stock-counts'
      from s join stock_counts c on c.location_id = s.id and c.second_approval_needed_at is not null and c.second_approved_at is null
                                 and c.status not in ('APPROVED', 'CANCELLED')
     group by s.id, s.name
  )
  select coalesce(jsonb_agg(jsonb_build_object('kind', k.kind, 'location_id', k.id, 'site', k.name, 'count', k.n, 'words', k.words,
                                               'ref', jsonb_build_object('site', k.id, 'kind', k.kind, 'route', k.route))
                            order by k.kind, k.name, k.id), '[]'::jsonb)
    into v_new
    from k;
  v_rows := (select coalesce(jsonb_agg(r order by r ->> 'kind', r ->> 'site', r ->> 'location_id'), '[]'::jsonb)
               from (select r from jsonb_array_elements(coalesce(v_a -> 'rows', '[]'::jsonb) || v_new) r limit 1000) z);
  return v_a || jsonb_build_object(
    'rows', v_rows,
    'totals', coalesce((select jsonb_agg(jsonb_build_object('kind', z.kind, 'count', z.n, 'sites', z.sites) order by z.kind)
                          from (select r ->> 'kind' as kind, sum((r ->> 'count')::numeric) as n, count(*) as sites
                                  from jsonb_array_elements(v_rows) r group by 1) z), '[]'::jsonb));
end
$fn$;

-- stock_report_league: the 4a league plus the purchase budget of each site's window and the last full
-- count against the count plan. Also for the service role (the Owner app and the weekly email).
create or replace function public.stock_report_league(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
                                                      p_after jsonb default null, p_limit integer default 1000)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_a      jsonb := public.stock_rp__league_4a(p_org, p_sites, p_from, p_to, p_opts, p_after, p_limit);
  v_totals jsonb;
begin
  v_totals := public.stock_rp__count_merge(p_org, public.stock_rp__budget_merge(p_org, v_a -> 'totals', v_a -> 'meta' -> 'windows', p_from, p_to), p_to);
  return v_a || jsonb_build_object(
    'meta', (v_a -> 'meta') || jsonb_build_object('notes', public.stock_rp__notes_4b(v_a -> 'meta' -> 'notes'),
              'columns', (v_a -> 'meta' -> 'columns') || jsonb_build_array(public.stock_rp__col('budget_spent', 'Spent against budget', 'money'),
                                                                            public.stock_rp__col('budget_pct', 'Budget used %', 'pct'))),
    'totals', v_totals,
    'rows', (select coalesce(jsonb_agg(t), '[]'::jsonb) from (select t from jsonb_array_elements(v_totals) t where jsonb_typeof(t -> 'location_id') = 'string' limit 1000) z));
end
$fn$;

-- stock_report_dashboard: the 4a dashboard (its attention rows come from the new stock_report_attention)
-- plus the purchase budget on the cards and the league, and the count plan words on the league.
create or replace function public.stock_report_dashboard(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
                                                         p_after jsonb default null, p_limit integer default 1000)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_a jsonb := public.stock_rp__dashboard_4a(p_org, p_sites, p_from, p_to, p_opts, p_after, p_limit);
  v_win jsonb;
begin
  v_win := v_a -> 'meta' -> 'windows';
  return v_a || jsonb_build_object(
    'meta', (v_a -> 'meta') || jsonb_build_object('notes', public.stock_rp__notes_4b(v_a -> 'meta' -> 'notes')),
    'totals', public.stock_rp__budget_merge(p_org, v_a -> 'totals', v_win, p_from, p_to),
    'rows', (v_a -> 'rows') || jsonb_build_object(
              'league', public.stock_rp__count_merge(p_org, public.stock_rp__budget_merge(p_org, v_a -> 'rows' -> 'league', v_win, p_from, p_to), p_to)));
end
$fn$;

-- stock_report_value: the 4a stock value plus In transit (sent to the site, not received at the end
-- of the day, at the sender's cost) and, on the company rows, the central kitchen markup taken out
-- (decision 5): company_value = stock value + in transit - internal_margin. Site rows keep the site's
-- cost. By legal company the markup comes out only where the kitchen is in the same legal company.
create or replace function public.stock_report_value(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
                                                     p_after jsonb default null, p_limit integer default 1000)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_a      jsonb := public.stock_rp__value_4a(p_org, p_sites, p_from, p_to, p_opts, p_after, p_limit);
  v_at     date;
  v_sites  uuid[];
  v_it     jsonb;
  v_km     jsonb;
  v_totals jsonb;
  v_rows   jsonb;
  v_level  text;
  v_view   text;
  v_notes  jsonb := '[]'::jsonb;
  v_snap   jsonb := '{}'::jsonb;
begin
  v_at := (v_a -> 'meta' ->> 'at_day')::date;
  v_level := coalesce(v_a -> 'meta' ->> 'level', 'site');
  v_view := coalesce(v_a -> 'meta' ->> 'view', 'category');
  v_sites := array(select (t ->> 'location_id')::uuid from jsonb_array_elements(v_a -> 'totals') t where jsonb_typeof(t -> 'location_id') = 'string');
  -- a locked period ending that day: the snapshot's figures for the site (a 4b snapshot carries the
  -- positive part, the negative part, archived stock and items as Stock value shows them; an older
  -- snapshot only its closing value, which 4a already reads)
  select coalesce(jsonb_object_agg(s.loc::text, sn.m), '{}'::jsonb) into v_snap
    from unnest(v_sites) s(loc)
    cross join lateral (select sp.metrics as m from stock_periods p join stock_period_snapshots sp on sp.period_id = p.id and sp.location_id = p.location_id
                         where p.location_id = s.loc and p.to_day = v_at and p.locked_at is not null and p.unlocked_at is null
                         order by p.locked_at desc limit 1) sn;
  if v_snap <> '{}'::jsonb then
    v_a := v_a || jsonb_build_object('totals', (
      select coalesce(jsonb_agg(case when jsonb_typeof(t -> 'location_id') = 'string' and jsonb_typeof(v_snap -> (t ->> 'location_id') -> 'value_positive') = 'number'
                                     then t || jsonb_build_object('stock_value', v_snap -> (t ->> 'location_id') -> 'value_positive',
                                                                  'negative_value', v_snap -> (t ->> 'location_id') -> 'value_negative',
                                                                  'archived_holding_value', v_snap -> (t ->> 'location_id') -> 'value_archived',
                                                                  'items', v_snap -> (t ->> 'location_id') -> 'value_items')
                                     else t end order by o), '[]'::jsonb)
        from jsonb_array_elements(v_a -> 'totals') with ordinality as x(t, o)));
    v_a := v_a || jsonb_build_object('totals', (
      select coalesce(jsonb_agg(case when jsonb_typeof(t -> 'location_id') = 'string' then t
                                     else t || (select jsonb_build_object('stock_value', sum((s ->> 'stock_value')::numeric), 'negative_value', sum((s ->> 'negative_value')::numeric),
                                                                          'archived_holding_value', sum((s ->> 'archived_holding_value')::numeric), 'items', sum((s ->> 'items')::numeric))
                                                  from jsonb_array_elements(v_a -> 'totals') s
                                                 where jsonb_typeof(s -> 'location_id') = 'string' and coalesce(s ->> 'currency', '') = coalesce(t ->> 'currency', '')) end
                                order by o), '[]'::jsonb)
        from jsonb_array_elements(v_a -> 'totals') with ordinality as x(t, o)));
    if v_level = 'site' and v_view <> 'legal' then
      v_a := v_a || jsonb_build_object('rows', (
        select coalesce(jsonb_agg(case when jsonb_typeof(v_snap -> (r ->> 'location_id') -> 'value_positive') = 'number'
                                       then r || jsonb_build_object('stock_value', v_snap -> (r ->> 'location_id') -> 'value_positive',
                                                                    'negative_value', v_snap -> (r ->> 'location_id') -> 'value_negative',
                                                                    'archived_holding_value', v_snap -> (r ->> 'location_id') -> 'value_archived',
                                                                    'items', v_snap -> (r ->> 'location_id') -> 'value_items')
                                       else r end order by o), '[]'::jsonb)
          from jsonb_array_elements(coalesce(v_a -> 'rows', '[]'::jsonb)) with ordinality as x(r, o)));
    end if;
  end if;
  -- in transit per receiving site (a locked period ending that day gives its snapshot's figure)
  select coalesce(jsonb_object_agg(z.loc::text, jsonb_build_object('v', z.v, 'n', z.n)), '{}'::jsonb) into v_it
    from (select s.loc, public.stock_rp__snap_num(v_snap -> s.loc::text, 'in_transit', coalesce(it.value, 0)) as v, coalesce(it.n, 0) as n
            from unnest(v_sites) s(loc)
            left join public.stock_rp__in_transit(v_sites, v_at) it on it.location_id = s.loc) z;
  -- the kitchen markup per site, with the kitchen's legal company beside the site's
  select coalesce(jsonb_agg(jsonb_build_object('loc', m.location_id, 'kitchen', m.kitchen_location_id, 'margin', m.margin,
                                               'same_legal', (select x.tenant_id from public.stock_rp__legal_of(m.location_id) x)
                                                             is not distinct from (select x.tenant_id from public.stock_rp__legal_of(m.kitchen_location_id) x))), '[]'::jsonb)
    into v_km
    from public.stock_rp__kitchen_margin(v_sites, v_at) m;
  v_totals := (select coalesce(jsonb_agg(
                  case when jsonb_typeof(t -> 'location_id') = 'string' then
                         t || jsonb_build_object('in_transit', coalesce((v_it -> (t ->> 'location_id') ->> 'v')::numeric, 0),
                                                 'in_transit_count', coalesce((v_it -> (t ->> 'location_id') ->> 'n')::integer, 0),
                                                 'total_value', coalesce((t ->> 'stock_value')::numeric, 0) + coalesce((v_it -> (t ->> 'location_id') ->> 'v')::numeric, 0),
                                                 'internal_margin', 0)
                       else
                         t || (select jsonb_build_object(
                                 'in_transit', coalesce(sum((v_it -> (s ->> 'location_id') ->> 'v')::numeric), 0),
                                 'in_transit_count', coalesce(sum((v_it -> (s ->> 'location_id') ->> 'n')::integer), 0),
                                 'total_value', coalesce((t ->> 'stock_value')::numeric, 0) + coalesce(sum((v_it -> (s ->> 'location_id') ->> 'v')::numeric), 0),
                                 'internal_margin', coalesce((select sum((m ->> 'margin')::numeric) from jsonb_array_elements(v_km) m
                                                               where (m ->> 'loc') in (select s2 ->> 'location_id' from jsonb_array_elements(v_a -> 'totals') s2
                                                                                        where jsonb_typeof(s2 -> 'location_id') = 'string'
                                                                                          and coalesce(s2 ->> 'currency', '') = coalesce(t ->> 'currency', ''))), 0),
                                 'company_value', coalesce((t ->> 'stock_value')::numeric, 0) + coalesce(sum((v_it -> (s ->> 'location_id') ->> 'v')::numeric), 0)
                                                  - coalesce((select sum((m ->> 'margin')::numeric) from jsonb_array_elements(v_km) m
                                                               where (m ->> 'loc') in (select s2 ->> 'location_id' from jsonb_array_elements(v_a -> 'totals') s2
                                                                                        where jsonb_typeof(s2 -> 'location_id') = 'string'
                                                                                          and coalesce(s2 ->> 'currency', '') = coalesce(t ->> 'currency', ''))), 0))
                                 from jsonb_array_elements(v_a -> 'totals') s
                                where jsonb_typeof(s -> 'location_id') = 'string' and coalesce(s ->> 'currency', '') = coalesce(t ->> 'currency', ''))
                  end order by o), '[]'::jsonb)
                 from jsonb_array_elements(v_a -> 'totals') with ordinality as x(t, o));
  v_rows := v_a -> 'rows';
  if v_level = 'site' and v_view = 'legal' then
    v_rows := (select coalesce(jsonb_agg(r || jsonb_build_object(
                  'in_transit', coalesce((select sum((v_it -> (t ->> 'location_id') ->> 'v')::numeric) from jsonb_array_elements(v_a -> 'totals') t
                                           where jsonb_typeof(t -> 'location_id') = 'string' and t ->> 'legal_company' = r ->> 'legal_company'
                                             and coalesce(t ->> 'currency', '') = coalesce(r ->> 'currency', '')), 0),
                  'internal_margin', coalesce((select sum((m ->> 'margin')::numeric) from jsonb_array_elements(v_km) m
                                                where coalesce((m ->> 'same_legal')::boolean, false)
                                                  and (m ->> 'loc') in (select t ->> 'location_id' from jsonb_array_elements(v_a -> 'totals') t
                                                                         where jsonb_typeof(t -> 'location_id') = 'string' and t ->> 'legal_company' = r ->> 'legal_company'
                                                                           and coalesce(t ->> 'currency', '') = coalesce(r ->> 'currency', ''))), 0)) order by o), '[]'::jsonb)
                 from jsonb_array_elements(coalesce(v_a -> 'rows', '[]'::jsonb)) with ordinality as x(r, o));
  elsif v_level = 'site' then
    v_rows := (select coalesce(jsonb_agg(r || jsonb_build_object('in_transit', coalesce((v_it -> (r ->> 'location_id') ->> 'v')::numeric, 0),
                                                                 'in_transit_count', coalesce((v_it -> (r ->> 'location_id') ->> 'n')::integer, 0),
                                                                 'total_value', coalesce((r ->> 'stock_value')::numeric, 0) + coalesce((v_it -> (r ->> 'location_id') ->> 'v')::numeric, 0))
                                          order by o), '[]'::jsonb)
                 from jsonb_array_elements(coalesce(v_a -> 'rows', '[]'::jsonb)) with ordinality as x(r, o));
  end if;
  if exists (select 1 from jsonb_array_elements(v_km) m where (m ->> 'margin')::numeric <> 0) then
    v_notes := v_notes || to_jsonb('Central kitchen markup taken out of the company value: stock at a site is valued at what it cost the group.'::text);
  end if;
  if exists (select 1 from jsonb_each(v_it) e where (e.value ->> 'v')::numeric <> 0) then
    v_notes := v_notes || to_jsonb('In transit: sent and not yet received at the end of the day, at the sending site''s cost.'::text);
  end if;
  return v_a || jsonb_build_object(
    'meta', (v_a -> 'meta') || jsonb_build_object('notes', coalesce(v_a -> 'meta' -> 'notes', '[]'::jsonb) || v_notes,
              'columns', case when v_level = 'site' and v_view <> 'legal'
                              then (v_a -> 'meta' -> 'columns') || jsonb_build_array(public.stock_rp__col('in_transit', 'In transit', 'money'),
                                                                                     public.stock_rp__col('total_value', 'Total', 'money'))
                              else v_a -> 'meta' -> 'columns' end),
    'totals', v_totals,
    'rows', v_rows);
end
$fn$;

-- stock_report_purchases: the 4a purchases plus orders sent unapproved, lines added at delivery
-- (substitutions), credit notes, invoices after credit notes and deliveries with no invoice yet.
create or replace function public.stock_report_purchases(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
                                                         p_after jsonb default null, p_limit integer default 1000)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_a      jsonb := public.stock_rp__purchases_4a(p_org, p_sites, p_from, p_to, p_opts, p_after, p_limit);
  v_gross  boolean;
  v_level  text;
  v_sites  uuid[];
  v_x      jsonb;
  v_totals jsonb;
  v_rows   jsonb;
begin
  v_gross := coalesce(v_a -> 'meta' ->> 'vat', 'net') = 'gross';
  v_level := coalesce(v_a -> 'meta' ->> 'level', 'site');
  v_sites := array(select (t ->> 'location_id')::uuid from jsonb_array_elements(v_a -> 'totals') t where jsonb_typeof(t -> 'location_id') = 'string');
  select coalesce(jsonb_object_agg(e.location_id::text, to_jsonb(e) - 'location_id'), '{}'::jsonb) into v_x
    from public.stock_rp__purchase_extra(v_sites, p_from, p_to, v_gross) e;
  v_totals := (select coalesce(jsonb_agg(
                  case when jsonb_typeof(t -> 'location_id') = 'string' then
                         t || coalesce(v_x -> (t ->> 'location_id'), '{}'::jsonb)
                           || jsonb_build_object('invoiced_after_credits', coalesce((t ->> 'invoiced')::numeric, 0) - coalesce((v_x -> (t ->> 'location_id') ->> 'credit_notes')::numeric, 0))
                       else
                         t || (select jsonb_build_object(
                                 'sent_unapproved', coalesce(sum((v_x -> (s ->> 'location_id') ->> 'sent_unapproved')::integer), 0),
                                 'sent_unapproved_value', coalesce(sum((v_x -> (s ->> 'location_id') ->> 'sent_unapproved_value')::numeric), 0),
                                 'substitutions', coalesce(sum((v_x -> (s ->> 'location_id') ->> 'substitutions')::integer), 0),
                                 'credit_notes', coalesce(sum((v_x -> (s ->> 'location_id') ->> 'credit_notes')::numeric), 0),
                                 'invoice_missing', coalesce(sum((v_x -> (s ->> 'location_id') ->> 'invoice_missing')::numeric), 0),
                                 'invoiced_after_credits', coalesce((t ->> 'invoiced')::numeric, 0) - coalesce(sum((v_x -> (s ->> 'location_id') ->> 'credit_notes')::numeric), 0))
                                 from jsonb_array_elements(v_a -> 'totals') s
                                where jsonb_typeof(s -> 'location_id') = 'string' and coalesce(s ->> 'currency', '') = coalesce(t ->> 'currency', ''))
                  end order by o), '[]'::jsonb)
                 from jsonb_array_elements(v_a -> 'totals') with ordinality as x(t, o));
  v_rows := v_a -> 'rows';
  if v_level = 'site' then
    v_rows := (select coalesce(jsonb_agg(t), '[]'::jsonb) from (select t from jsonb_array_elements(v_totals) t where jsonb_typeof(t -> 'location_id') = 'string' limit 1000) z);
  elsif v_level = 'order' then
    v_rows := (select coalesce(jsonb_agg(r || jsonb_build_object(
                  'sent_unapproved', exists (select 1 from purchase_orders po where po.id = (r ->> 'po_id')::uuid and po.sent_unapproved_at is not null),
                  'substitutions', (select count(*) from po_lines l where l.po_id = (r ->> 'po_id')::uuid and coalesce(l.qty_packs, 0) = 0 and coalesce(l.qty_received, 0) > 0))
                  order by o), '[]'::jsonb)
                 from jsonb_array_elements(coalesce(v_a -> 'rows', '[]'::jsonb)) with ordinality as x(r, o));
  end if;
  return v_a || jsonb_build_object(
    'meta', (v_a -> 'meta') || jsonb_build_object(
              'notes', public.stock_rp__notes_4b(v_a -> 'meta' -> 'notes'),
              'columns', case when v_level = 'site'
                              then (v_a -> 'meta' -> 'columns') || jsonb_build_array(
                                     public.stock_rp__col('sent_unapproved_value', 'Sent unapproved value', 'money'), public.stock_rp__col('credit_notes', 'Credit notes', 'money'),
                                     public.stock_rp__col('invoiced_after_credits', 'Invoiced after credits', 'money'), public.stock_rp__col('invoice_missing', 'No invoice yet', 'money'))
                              when v_level = 'order'
                              then (v_a -> 'meta' -> 'columns') || jsonb_build_array(public.stock_rp__col('sent_unapproved', 'Sent unapproved', 'text'),
                                                                                     public.stock_rp__col('substitutions', 'Substitutions', 'qty'))
                              else v_a -> 'meta' -> 'columns' end),
    'totals', v_totals,
    'rows', v_rows);
end
$fn$;

-- stock_report_prices: the 4a price paid report plus overcharges and credits: the credit figures on the
-- totals, and two levels, 'credits' (each credit request) and 'credit_suppliers' (by supplier and site).
create or replace function public.stock_report_prices(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
                                                      p_after jsonb default null, p_limit integer default 1000)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_o      jsonb := coalesce(p_opts, '{}'::jsonb);
  v_level  text := coalesce(nullif(v_o ->> 'level', ''), 'item');
  v_credit boolean := coalesce(nullif(v_o ->> 'level', ''), 'item') in ('credits', 'credit_suppliers');
  v_a      jsonb;
  v_limit  integer := public.stock_rp__page_cap(p_limit);
  v_sites  uuid[];
  v_site   uuid;
  v_x      jsonb;
  v_totals jsonb;
  v_rows   jsonb;
  v_next   jsonb;
  v_cols   jsonb;
  v_n      integer;
begin
  v_a := public.stock_rp__prices_4a(p_org, p_sites, p_from, p_to,
                                    case when v_credit then v_o || jsonb_build_object('level', 'coming') else p_opts end,
                                    case when v_credit then null else p_after end, case when v_credit then 1 else p_limit end);
  v_sites := array(select (t ->> 'location_id')::uuid from jsonb_array_elements(v_a -> 'totals') t where jsonb_typeof(t -> 'location_id') = 'string');
  v_site := nullif(v_o ->> 'site', '')::uuid;
  select coalesce(jsonb_object_agg(e.location_id::text, to_jsonb(e) - 'location_id'), '{}'::jsonb) into v_x
    from public.stock_rp__credit_figures(v_sites, p_from, p_to) e;
  v_totals := (select coalesce(jsonb_agg(
                  case when jsonb_typeof(t -> 'location_id') = 'string' then t || coalesce(v_x -> (t ->> 'location_id'), '{}'::jsonb)
                       else t || (select jsonb_build_object(
                                     'overcharge_asked', coalesce(sum((v_x -> (s ->> 'location_id') ->> 'overcharge_asked')::numeric), 0),
                                     'credits_received', coalesce(sum((v_x -> (s ->> 'location_id') ->> 'credits_received')::numeric), 0),
                                     'written_off', coalesce(sum((v_x -> (s ->> 'location_id') ->> 'written_off')::numeric), 0),
                                     'credit_requests', coalesce(sum((v_x -> (s ->> 'location_id') ->> 'credit_requests')::integer), 0))
                                    from jsonb_array_elements(v_a -> 'totals') s
                                   where jsonb_typeof(s -> 'location_id') = 'string' and coalesce(s ->> 'currency', '') = coalesce(t ->> 'currency', '')) end
                  order by o), '[]'::jsonb)
                 from jsonb_array_elements(v_a -> 'totals') with ordinality as x(t, o));
  v_rows := v_a -> 'rows';
  v_next := v_a -> 'next';
  v_cols := v_a -> 'meta' -> 'columns';
  if v_level = 'credits' then
    v_cols := jsonb_build_array(public.stock_rp__col('created_at', 'Asked', 'day'), public.stock_rp__col('site', 'Site', 'text'),
      public.stock_rp__col('supplier_name', 'Supplier', 'text'), public.stock_rp__col('reason', 'Why', 'text'), public.stock_rp__col('status', 'Status', 'text'),
      public.stock_rp__col('amount', 'Asked for', 'money'), public.stock_rp__col('received', 'Credit notes', 'money'), public.stock_rp__col('invoice_number', 'Invoice', 'text'));
    with pg as (
      select r.id, r.location_id, r.created_at, r.reason, r.status, r.amount,
             coalesce(cs.name, s.name, 'No supplier') as supplier_name, v.invoice_number,
             coalesce((select sum(n.amount) from stock_credit_notes n where n.request_id = r.id), 0) as received,
             (select x ->> 'name' from jsonb_array_elements(v_a -> 'meta' -> 'sites') x where (x ->> 'id')::uuid = r.location_id) as site,
             (select x ->> 'currency' from jsonb_array_elements(v_a -> 'meta' -> 'sites') x where (x ->> 'id')::uuid = r.location_id) as currency
        from stock_credit_requests r
        left join suppliers s on s.id = r.supplier_id
        left join stock_co_suppliers cs on cs.id = s.company_ref
        left join supplier_invoices v on v.id = r.invoice_id
       where r.location_id = any(v_sites) and (v_site is null or r.location_id = v_site)
         and public.stock_co__vday(r.location_id, r.created_at) between p_from and p_to
         and (p_after is null or r.created_at < (p_after ->> 'created_at')::timestamptz
              or (r.created_at = (p_after ->> 'created_at')::timestamptz and r.id::text > coalesce(p_after ->> 'request_id', '')))
       order by r.created_at desc, r.id
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('request_id', pg.id, 'location_id', pg.location_id, 'site', pg.site, 'currency', pg.currency,
             'supplier_name', pg.supplier_name, 'reason', pg.reason, 'status', pg.status, 'amount', pg.amount, 'received', pg.received,
             'created_at', pg.created_at, 'invoice_number', pg.invoice_number) order by pg.created_at desc, pg.id), '[]'::jsonb), count(*)
      into v_rows, v_n
      from pg;
    v_next := null;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('created_at', v_rows -> (v_limit - 1) ->> 'created_at', 'request_id', v_rows -> (v_limit - 1) ->> 'request_id');
    end if;
  elsif v_level = 'credit_suppliers' then
    v_cols := jsonb_build_array(public.stock_rp__col('supplier_name', 'Supplier', 'text'), public.stock_rp__col('site', 'Site', 'text'),
      public.stock_rp__col('asked', 'Asked for', 'money'), public.stock_rp__col('received', 'Credit notes', 'money'),
      public.stock_rp__col('written_off', 'Written off', 'money'), public.stock_rp__col('requests', 'Requests', 'qty'));
    select coalesce(jsonb_agg(jsonb_build_object('supplier_name', z.supplier_name, 'location_id', z.location_id, 'site', z.site, 'currency', z.currency,
             'asked', z.asked, 'received', z.received, 'written_off', z.off, 'requests', z.n) order by z.asked desc, z.supplier_name, z.location_id), '[]'::jsonb)
      into v_rows
      from (select coalesce(cs.name, s.name, 'No supplier') as supplier_name, r.location_id,
                   min((select x ->> 'name' from jsonb_array_elements(v_a -> 'meta' -> 'sites') x where (x ->> 'id')::uuid = r.location_id)) as site,
                   min((select x ->> 'currency' from jsonb_array_elements(v_a -> 'meta' -> 'sites') x where (x ->> 'id')::uuid = r.location_id)) as currency,
                   round(sum(coalesce(r.amount, 0)), 2) as asked,
                   round(sum(coalesce((select sum(n.amount) from stock_credit_notes n where n.request_id = r.id), 0)), 2) as received,
                   round(sum(coalesce(r.amount, 0)) filter (where r.status = 'written_off'), 2) as off,
                   count(*) as n
              from stock_credit_requests r
              left join suppliers s on s.id = r.supplier_id
              left join stock_co_suppliers cs on cs.id = s.company_ref
             where r.location_id = any(v_sites) and (v_site is null or r.location_id = v_site)
               and public.stock_co__vday(r.location_id, r.created_at) between p_from and p_to
             group by 1, 2
             order by 5 desc
             limit 1000) z;
    v_next := null;
  end if;
  return v_a || jsonb_build_object(
    'meta', (v_a -> 'meta') || jsonb_build_object('notes', public.stock_rp__notes_4b(v_a -> 'meta' -> 'notes'), 'level', v_level, 'columns', v_cols),
    'totals', v_totals,
    'rows', v_rows,
    'next', v_next);
end
$fn$;

-- stock_report_export_start (replaced): the 4a body; the five 4b reports may be exported too.
create or replace function public.stock_report_export_start(p_report text, p_args jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org   uuid;
  v_sites uuid[];
  v_g     jsonb;
  v_uid   uuid;
  v_id    uuid;
  v_today integer;
begin
  if p_report is null or p_report not in ('value', 'movement', 'gap', 'cogs', 'product_gp', 'waste', 'purchases', 'prices', 'days_on_hand', 'par',
                                           'key_ratios', 'setup_health', 'batches', 'league',
                                           'off_contract', 'budget', 'transfers', 'count_compliance', 'month_end') then
    raise exception 'That report cannot be exported.' using errcode = '22023';
  end if;
  if p_args is null or jsonb_typeof(p_args) <> 'object' or jsonb_typeof(p_args -> 'sites') <> 'array' then
    raise exception 'Pick 1 to 50 sites.' using errcode = '22023';
  end if;
  v_org := nullif(p_args ->> 'org', '')::uuid;
  v_sites := array(select (x #>> '{}')::uuid from jsonb_array_elements(p_args -> 'sites') x);
  v_g := public.stock_report_guard(v_org, v_sites);
  if (v_g ->> 'service')::boolean then
    raise exception 'Sign in to Back Office to see stock reports.' using errcode = '42501';
  end if;
  perform public.stock_rp__range_ok(nullif(p_args ->> 'from', '')::date, nullif(p_args ->> 'to', '')::date);
  v_uid := (v_g ->> 'uid')::uuid;
  if exists (select 1 from report_export_jobs j where j.user_id = v_uid and j.status in ('waiting', 'running')) then
    raise exception 'An export is already running. Wait for it to finish.' using errcode = '55000';
  end if;
  select count(*) into v_today from report_export_jobs j where j.user_id = v_uid and j.created_at >= now() - interval '1 day';
  if v_today >= 20 then
    raise exception 'That is 20 exports today. Try again tomorrow.' using errcode = '55000';
  end if;
  v_id := gen_random_uuid();
  insert into report_export_jobs (id, org_id, user_id, report, args, status, file_prefix)
  values (v_id, v_org, v_uid, p_report,
          jsonb_build_object('org', v_org, 'sites', to_jsonb(v_sites), 'from', p_args ->> 'from', 'to', p_args ->> 'to', 'opts', coalesce(p_args -> 'opts', '{}'::jsonb)),
          'waiting', v_org::text || '/' || v_uid::text || '/' || v_id::text || '/');
  return jsonb_build_object('ok', true, 'job_id', v_id);
end
$fn$;

-- ============================================================================
-- STEP 8. THE FIVE NEW REPORTS (public, STABLE, definer, the 4a signature and answer)
-- ============================================================================

-- The invoice lines behind Off contract spend: posted invoices dated p_from to p_to at the sites, each
-- line with why it is off contract. local: a local item, an item with no company record, or a
-- supplier with no company record or local to one site. not_contract: a company item bought from a
-- company supplier that has no live supplier item for it at this site. over_agreed: above the agreed
-- price (the price here, else the company pack price, plus allowed_diff_pct) from a supplier with
-- agreed prices, while the agreement runs.
create or replace function public.stock_rp__oc_lines(p_sites uuid[], p_from date, p_to date)
returns table(location_id uuid, invoice_id uuid, invoice_number text, invoice_date date, line_id uuid, supplier_key text, supplier_name text,
              company_item_id uuid, inventory_item_id uuid, name text, qty numeric, unit_price numeric, agreed_price numeric, spend numeric,
              is_local boolean, not_contract boolean, over_by numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select x.location_id, x.invoice_id, x.invoice_number, x.invoice_date, x.line_id, x.supplier_key, x.supplier_name, x.company_item_id, x.inventory_item_id,
         x.name, x.qty, x.unit_price, x.agreed, x.spend, x.is_local,
         not x.is_local and not exists (
           select 1 from stock_co_supplier_items si2
            where si2.item_id = x.company_item_id and si2.supplier_id = x.company_supplier_id and si2.archived_at is null
              and not coalesce((select y.off_here from stock_co_supplier_item_sites y where y.supplier_item_id = si2.id and y.location_id = x.location_id), false)),
         case when x.agreed is not null and x.unit_price > x.agreed * (1 + coalesce(x.allowed, 0) / 100.0) + 0.005
              then round(coalesce(x.qty, 0) * (x.unit_price - x.agreed), 2) else 0 end
    from (
      select v.location_id, v.id as invoice_id, v.invoice_number, v.invoice_date, il.id as line_id,
             coalesce(s.company_ref::text, s.id::text, 'none') as supplier_key, coalesce(cs.name, s.name, 'No supplier') as supplier_name,
             cs.id as company_supplier_id, ci.id as company_item_id, i.id as inventory_item_id,
             coalesce(ci.name, i.name, il.description, 'Unknown item') as name, il.qty, il.unit_price,
             coalesce(il.line_total, coalesce(il.qty, 0) * coalesce(il.unit_price, 0), 0) as spend,
             (ci.id is null or ci.local_location_id is not null or cs.id is null or cs.local_location_id is not null) as is_local,
             case when si.id is not null and cs.id is not null and coalesce(cs.accepts_price_changes, true) = false
                       and (si.agreed_until is null or si.agreed_until >= v.invoice_date)
                  then coalesce(sis.price_here, si.pack_price) end as agreed,
             si.allowed_diff_pct as allowed
        from supplier_invoices v
        join supplier_invoice_lines il on il.invoice_id = v.id
        left join suppliers s on s.id = v.supplier_id
        left join stock_co_suppliers cs on cs.id = s.company_ref
        left join inventory_items i on i.id = il.matched_item_id
        left join stock_co_items ci on ci.id = i.company_ref
        left join supplier_products sp on sp.id = il.supplier_product_id
        left join stock_co_supplier_items si on si.id = sp.company_ref
        left join stock_co_supplier_item_sites sis on sis.supplier_item_id = si.id and sis.location_id = v.location_id
       where v.status = 'POSTED' and v.location_id = any(p_sites) and v.invoice_date between p_from and p_to
    ) x;
$fn$;

-- stock_report_off_contract (5.12): spend off the company's contracts, per site, supplier, item, line
-- and week.
create or replace function public.stock_report_off_contract(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
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
  v_week   smallint := coalesce((v_g ->> 'week_start')::smallint, 1);
  v_sites  uuid[];
  v_win    jsonb;
  v_site_rows jsonb;
  v_rows   jsonb := '[]'::jsonb;
  v_next   jsonb;
  v_cols   jsonb;
  v_n      integer;
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  if v_level not in ('site', 'supplier', 'item', 'line', 'week') then
    v_level := 'site';
  end if;
  v_sites := array(select (x ->> 'id')::uuid from jsonb_array_elements(v_g -> 'sites') x where v_site is null or (x ->> 'id')::uuid = v_site);
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, false);
  with s as (select (x ->> 'id')::uuid as id, x ->> 'name' as name, x ->> 'currency' as currency from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = any(v_sites)),
  l as (select * from public.stock_rp__oc_lines(v_sites, p_from, p_to)),
  z as (
    select l.location_id, sum(l.spend) as spend,
           sum(l.spend) filter (where l.is_local) as loc_v, sum(l.spend) filter (where l.not_contract) as nc_v,
           sum(l.over_by) as over_v, count(*) filter (where l.over_by > 0) as over_n, count(*) as n, count(distinct l.invoice_id) as inv
      from l group by l.location_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', s.id, 'site', s.name, 'currency', s.currency,
           'spend', round(coalesce(z.spend, 0), 2), 'off_contract', round(coalesce(z.loc_v, 0) + coalesce(z.nc_v, 0), 2),
           'off_pct', public.stock_rp__pct(coalesce(z.loc_v, 0) + coalesce(z.nc_v, 0), z.spend),
           'not_contract', round(coalesce(z.nc_v, 0), 2), 'local', round(coalesce(z.loc_v, 0), 2),
           'over_agreed', round(coalesce(z.over_v, 0), 2), 'over_agreed_lines', coalesce(z.over_n, 0), 'lines', coalesce(z.n, 0), 'invoices', coalesce(z.inv, 0))
           order by s.name, s.id), '[]'::jsonb)
    into v_site_rows
    from s left join z on z.location_id = s.id;
  v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('spend', 'Spend', 'money'),
    public.stock_rp__col('off_contract', 'Off contract', 'money'), public.stock_rp__col('off_pct', 'Off contract %', 'pct'),
    public.stock_rp__col('not_contract', 'Not a contract supplier', 'money'), public.stock_rp__col('local', 'Local items and shop buys', 'money'),
    public.stock_rp__col('over_agreed', 'Above the agreed price', 'money'), public.stock_rp__col('lines', 'Lines', 'qty'));
  if v_level = 'supplier' then
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('supplier_name', 'Supplier', 'text'),
      public.stock_rp__col('spend', 'Spend', 'money'), public.stock_rp__col('off_contract', 'Off contract', 'money'),
      public.stock_rp__col('not_contract', 'Not a contract supplier', 'money'), public.stock_rp__col('local', 'Local items and shop buys', 'money'),
      public.stock_rp__col('over_agreed', 'Above the agreed price', 'money'));
    with g as (
      select l.location_id, l.location_id::text || ':' || l.supplier_key as key, min(l.supplier_name) as supplier_name, sum(l.spend) as spend,
             coalesce(sum(l.spend) filter (where l.is_local or l.not_contract), 0) as off, coalesce(sum(l.spend) filter (where l.not_contract), 0) as nc,
             coalesce(sum(l.spend) filter (where l.is_local), 0) as lv, sum(l.over_by) as over
        from public.stock_rp__oc_lines(v_sites, p_from, p_to) l group by l.location_id, 2
    ),
    pg as (
      select g.* from g
       where p_after is null or public.stock_rp__sk(g.off) < (p_after ->> 'off_contract')::numeric
          or (public.stock_rp__sk(g.off) = (p_after ->> 'off_contract')::numeric and g.key > coalesce(p_after ->> 'key', ''))
       order by public.stock_rp__sk(g.off) desc, g.key
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('location_id', pg.location_id,
             'site', (select x ->> 'name' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = pg.location_id),
             'currency', (select x ->> 'currency' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = pg.location_id),
             'key', pg.key, 'supplier_name', pg.supplier_name, 'spend', round(pg.spend, 2), 'off_contract', round(pg.off, 2), 'not_contract', round(pg.nc, 2),
             'local', round(pg.lv, 2), 'over_agreed', round(pg.over, 2)) order by public.stock_rp__sk(pg.off) desc, pg.key), '[]'::jsonb), count(*)
      into v_rows, v_n from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('off_contract', public.stock_rp__sk((v_rows -> (v_limit - 1) ->> 'off_contract')::numeric), 'key', v_rows -> (v_limit - 1) ->> 'key');
    end if;
  elsif v_level = 'item' then
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('name', 'Item', 'text'),
      public.stock_rp__col('spend', 'Spend', 'money'), public.stock_rp__col('off_contract', 'Off contract', 'money'),
      public.stock_rp__col('over_agreed', 'Above the agreed price', 'money'), public.stock_rp__col('why', 'Why', 'text'));
    with g as (
      select l.location_id, l.location_id::text || ':' || coalesce(l.company_item_id::text, l.inventory_item_id::text, 'n:' || l.name) as key,
             min(l.company_item_id::text)::uuid as company_item_id, min(l.inventory_item_id::text)::uuid as inventory_item_id, min(l.name) as name,
             sum(l.spend) as spend, coalesce(sum(l.spend) filter (where l.is_local or l.not_contract), 0) as off, sum(l.over_by) as over,
             bool_or(l.is_local) as any_local, bool_or(l.not_contract) as any_nc, bool_or(l.over_by > 0) as any_over
        from public.stock_rp__oc_lines(v_sites, p_from, p_to) l group by l.location_id, 2
    ),
    pg as (
      select g.* from g
       where (g.off > 0 or g.over > 0)
         and (p_after is null or public.stock_rp__sk(g.off) < (p_after ->> 'off_contract')::numeric
              or (public.stock_rp__sk(g.off) = (p_after ->> 'off_contract')::numeric and g.key > coalesce(p_after ->> 'key', '')))
       order by public.stock_rp__sk(g.off) desc, g.key
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('location_id', pg.location_id,
             'site', (select x ->> 'name' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = pg.location_id),
             'currency', (select x ->> 'currency' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = pg.location_id),
             'key', pg.key, 'company_item_id', pg.company_item_id, 'inventory_item_id', pg.inventory_item_id, 'name', pg.name,
             'spend', round(pg.spend, 2), 'off_contract', round(pg.off, 2), 'over_agreed', round(pg.over, 2),
             'why', case when (pg.any_local::int + pg.any_nc::int + pg.any_over::int) > 1 then 'mixed'
                         when pg.any_local then 'local' when pg.any_nc then 'not_contract' else 'over_agreed' end)
             order by public.stock_rp__sk(pg.off) desc, pg.key), '[]'::jsonb), count(*)
      into v_rows, v_n from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('off_contract', public.stock_rp__sk((v_rows -> (v_limit - 1) ->> 'off_contract')::numeric), 'key', v_rows -> (v_limit - 1) ->> 'key');
    end if;
  elsif v_level = 'line' then
    v_cols := jsonb_build_array(public.stock_rp__col('invoice_date', 'Invoice date', 'day'), public.stock_rp__col('site', 'Site', 'text'),
      public.stock_rp__col('invoice_number', 'Invoice', 'text'), public.stock_rp__col('supplier_name', 'Supplier', 'text'), public.stock_rp__col('name', 'Item', 'text'),
      public.stock_rp__col('qty', 'Qty', 'qty'), public.stock_rp__col('unit_price', 'Price paid', 'money'), public.stock_rp__col('agreed_price', 'Agreed', 'money'),
      public.stock_rp__col('line_total', 'Line', 'money'), public.stock_rp__col('why', 'Why', 'text'), public.stock_rp__col('over_by', 'Above agreed by', 'money'));
    with pg as (
      select l.* from public.stock_rp__oc_lines(v_sites, p_from, p_to) l
       where (l.is_local or l.not_contract or l.over_by > 0)
         and (p_after is null or l.invoice_date < (p_after ->> 'invoice_date')::date
              or (l.invoice_date = (p_after ->> 'invoice_date')::date and l.line_id::text > coalesce(p_after ->> 'line_id', '')))
       order by l.invoice_date desc, l.line_id
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('line_id', pg.line_id, 'invoice_id', pg.invoice_id, 'invoice_number', pg.invoice_number, 'invoice_date', pg.invoice_date,
             'location_id', pg.location_id, 'site', (select x ->> 'name' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = pg.location_id),
             'currency', (select x ->> 'currency' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = pg.location_id),
             'supplier_name', pg.supplier_name, 'name', pg.name, 'qty', pg.qty, 'unit_price', pg.unit_price, 'agreed_price', pg.agreed_price,
             'line_total', round(pg.spend, 2), 'why', case when pg.is_local then 'local' when pg.not_contract then 'not_contract' else 'over_agreed' end,
             'over_by', pg.over_by) order by pg.invoice_date desc, pg.line_id), '[]'::jsonb), count(*)
      into v_rows, v_n from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('invoice_date', v_rows -> (v_limit - 1) ->> 'invoice_date', 'line_id', v_rows -> (v_limit - 1) ->> 'line_id');
    end if;
  elsif v_level = 'week' then
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('week_start', 'Week', 'day'),
      public.stock_rp__col('spend', 'Spend', 'money'), public.stock_rp__col('off_contract', 'Off contract', 'money'), public.stock_rp__col('off_pct', 'Off contract %', 'pct'));
    with g as (
      select l.location_id, public.stock_rp__week_of(l.invoice_date, v_week) as week_start, sum(l.spend) as spend,
             coalesce(sum(l.spend) filter (where l.is_local or l.not_contract), 0) as off
        from public.stock_rp__oc_lines(v_sites, p_from, p_to) l group by 1, 2
    ),
    pg as (
      select g.* from g
       where p_after is null or g.location_id::text > coalesce(p_after ->> 'location_id', '')
          or (g.location_id::text = coalesce(p_after ->> 'location_id', '') and g.week_start > (p_after ->> 'week_start')::date)
       order by g.location_id::text, g.week_start
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('location_id', pg.location_id,
             'site', (select x ->> 'name' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = pg.location_id),
             'currency', (select x ->> 'currency' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = pg.location_id),
             'week_start', pg.week_start, 'spend', round(pg.spend, 2), 'off_contract', round(pg.off, 2), 'off_pct', public.stock_rp__pct(pg.off, pg.spend))
             order by pg.location_id::text, pg.week_start), '[]'::jsonb), count(*)
      into v_rows, v_n from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('location_id', v_rows -> (v_limit - 1) ->> 'location_id', 'week_start', v_rows -> (v_limit - 1) ->> 'week_start');
    end if;
  else
    v_rows := (select coalesce(jsonb_agg(r), '[]'::jsonb) from (select r from jsonb_array_elements(v_site_rows) r limit 1000) z);
  end if;
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'off_contract', p_from, p_to, false, v_level, v_cols, v_win, jsonb_build_array('Spend from posted invoices, net of VAT.')),
    'totals', v_site_rows || (select coalesce(jsonb_agg(c || jsonb_build_object('off_pct', public.stock_rp__pct((c ->> 'off_contract')::numeric, (c ->> 'spend')::numeric))
                                                  order by c ->> 'currency'), '[]'::jsonb)
                               from jsonb_array_elements(public.stock_rp__sum_rows(v_site_rows,
                                      array['spend', 'off_contract', 'not_contract', 'local', 'over_agreed', 'over_agreed_lines', 'lines', 'invoices'])) c),
    'rows', v_rows, 'next', v_next);
end
$fn$;

-- stock_report_budget (5.13): budget, spent and actual sales per site and per week.
create or replace function public.stock_report_budget(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
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
  v_week   smallint := coalesce((v_g ->> 'week_start')::smallint, 1);
  v_win    jsonb;
  v_fig    jsonb;
  v_site_rows jsonb;
  v_rows   jsonb := '[]'::jsonb;
  v_next   jsonb;
  v_cols   jsonb;
  v_notes  jsonb;
  v_n      integer;
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  if v_level not in ('site', 'week') then
    v_level := 'site';
  end if;
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, false);
  v_fig := public.stock_rp__site_figures(v_g, v_win);
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', s.id, 'site', s.name, 'currency', s.currency, 'rule', b.rule,
           'budget', b.budget, 'spent', b.spent, 'pct_used', public.stock_rp__pct(b.spent, b.budget),
           'left', case when b.budget is null then null else b.budget - b.spent end,
           'over', coalesce(b.budget is not null and b.spent > b.budget, false), 'forecast', b.forecast,
           'sales_net', (f ->> 'sales_net')::numeric, 'spent_pct_sales', public.stock_rp__pct(b.spent, (f ->> 'sales_net')::numeric),
           'demo_sales', coalesce((f ->> 'demo_sales')::boolean, false),
           'rag', jsonb_build_object('budget_pct', public.stock_rp__rag(p_org, s.id, 'budget_pct', public.stock_rp__pct(b.spent, b.budget))))
           order by s.name, s.id), '[]'::jsonb)
    into v_site_rows
    from (select (x ->> 'id')::uuid as id, x ->> 'name' as name, x ->> 'currency' as currency from jsonb_array_elements(v_g -> 'sites') x
           where v_site is null or (x ->> 'id')::uuid = v_site) s
   cross join lateral public.stock_rp__budget(s.id, p_from, p_to, true) b
    left join lateral (select y as f from jsonb_array_elements(v_fig) y where y ->> 'location_id' = s.id::text limit 1) q on true;
  v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('budget', 'Budget', 'money'),
    public.stock_rp__col('spent', 'Spent', 'money'), public.stock_rp__col('pct_used', 'Used %', 'pct'), public.stock_rp__col('left', 'Left', 'money'),
    public.stock_rp__col('forecast', 'Forecast sales', 'money'), public.stock_rp__col('sales_net', 'Actual sales', 'money'),
    public.stock_rp__col('spent_pct_sales', 'Spent % of sales', 'pct'));
  if v_level = 'week' then
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('week_start', 'Week', 'day'),
      public.stock_rp__col('budget', 'Budget', 'money'), public.stock_rp__col('spent', 'Spent', 'money'), public.stock_rp__col('pct_used', 'Used %', 'pct'),
      public.stock_rp__col('left', 'Left', 'money'), public.stock_rp__col('forecast', 'Forecast sales', 'money'), public.stock_rp__col('sales_net', 'Actual sales', 'money'));
    with s as (
      select (x ->> 'id')::uuid as id, x ->> 'name' as name, x ->> 'currency' as currency,
             coalesce((select (w ->> 'demo_sales')::boolean from jsonb_array_elements(v_win) w where w ->> 'location_id' = x ->> 'id' limit 1), false) as sd
        from jsonb_array_elements(v_g -> 'sites') x where v_site is null or (x ->> 'id')::uuid = v_site
    ),
    wk as (
      select gs::date as week_start, greatest(gs::date, p_from) as d_from, least(gs::date + 6, p_to) as d_to
        from generate_series(public.stock_rp__week_of(p_from, v_week), p_to, interval '7 days') gs
    ),
    pg as (
      select s.id, s.name, s.currency, s.sd, wk.week_start, wk.d_from, wk.d_to from s cross join wk
       where p_after is null or s.id::text > coalesce(p_after ->> 'location_id', '')
          or (s.id::text = coalesce(p_after ->> 'location_id', '') and wk.week_start > (p_after ->> 'week_start')::date)
       order by s.id::text, wk.week_start
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('location_id', pg.id, 'site', pg.name, 'currency', pg.currency, 'week_start', pg.week_start,
             'days', pg.d_to - pg.d_from + 1, 'budget', b.budget, 'spent', b.spent, 'pct_used', public.stock_rp__pct(b.spent, b.budget),
             'left', case when b.budget is null then null else b.budget - b.spent end, 'over', coalesce(b.budget is not null and b.spent > b.budget, false),
             'forecast', b.forecast,
             'sales_net', case when pg.sd then null else coalesce((select round(sum(d.net), 2) from sales_day_sums d
                                                                   where d.location_id = pg.id and d.business_day between pg.d_from and pg.d_to), 0) end)
             order by pg.id::text, pg.week_start), '[]'::jsonb), count(*)
      into v_rows, v_n
      from pg cross join lateral public.stock_rp__budget(pg.id, pg.d_from, pg.d_to, true) b;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('location_id', v_rows -> (v_limit - 1) ->> 'location_id', 'week_start', v_rows -> (v_limit - 1) ->> 'week_start');
    end if;
  else
    v_rows := (select coalesce(jsonb_agg(r), '[]'::jsonb) from (select r from jsonb_array_elements(v_site_rows) r limit 1000) z);
  end if;
  v_notes := coalesce((select jsonb_agg('No budget set at ' || (r ->> 'site') || '. Set one in Purchasing, Budgets.' order by r ->> 'site')
                         from jsonb_array_elements(v_site_rows) r where jsonb_typeof(r -> 'budget') = 'null'), '[]'::jsonb)
             || jsonb_build_array('Spent is the net value of orders sent, by the day they were ordered, plus delivery fees.');
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'budget', p_from, p_to, false, v_level, v_cols, v_win, v_notes),
    'totals', v_site_rows || (select coalesce(jsonb_agg(c || jsonb_build_object(
                                 'budget', (select case when count(r -> 'budget') filter (where jsonb_typeof(r -> 'budget') = 'number') = 0 then null
                                                        else sum((r ->> 'budget')::numeric) end
                                              from jsonb_array_elements(v_site_rows) r where coalesce(r ->> 'currency', '') = coalesce(c ->> 'currency', '')),
                                 'pct_used', public.stock_rp__pct((c ->> 'spent')::numeric,
                                               (select sum((r ->> 'budget')::numeric) from jsonb_array_elements(v_site_rows) r
                                                 where coalesce(r ->> 'currency', '') = coalesce(c ->> 'currency', '') and jsonb_typeof(r -> 'budget') = 'number')),
                                 'spent_pct_sales', public.stock_rp__pct((c ->> 'spent')::numeric, (c ->> 'sales_net')::numeric),
                                 'rag', jsonb_build_object('budget_pct', public.stock_rp__rag(p_org, null, 'budget_pct',
                                          public.stock_rp__pct((c ->> 'spent')::numeric,
                                            (select sum((r ->> 'budget')::numeric) from jsonb_array_elements(v_site_rows) r
                                              where coalesce(r ->> 'currency', '') = coalesce(c ->> 'currency', '') and jsonb_typeof(r -> 'budget') = 'number')))))
                                 order by c ->> 'currency'), '[]'::jsonb)
                               from jsonb_array_elements(public.stock_rp__strict(public.stock_rp__sum_rows(v_site_rows, array['spent', 'forecast', 'sales_net']),
                                                                                 v_site_rows, array['sales_net'])) c),
    'rows', v_rows, 'next', v_next);
end
$fn$;

-- stock_report_transfers (5.14): transfers by site (the ledger's transfers in and out, so it agrees
-- with Stock movement, and a locked period's snapshot), the from and to grid, every transfer with its
-- status, the central kitchen (fill rate, shorts, on time, internal sales and margin, made, kitchen
-- stock and waste) and the recharges between legal companies.
create or replace function public.stock_report_transfers(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
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
  v_status text := nullif(v_o ->> 'status', '');
  v_sites  uuid[];
  v_all    uuid[];
  v_win    jsonb;
  v_fig    jsonb;
  v_site_rows jsonb;
  v_rows   jsonb := '[]'::jsonb;
  v_next   jsonb;
  v_cols   jsonb;
  v_notes  jsonb := '[]'::jsonb;
  v_n      integer;
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  if v_level not in ('site', 'grid', 'list', 'kitchen', 'recharges') then
    v_level := 'site';
  end if;
  v_all := array(select (x ->> 'id')::uuid from jsonb_array_elements(v_g -> 'sites') x);
  v_sites := array(select x from unnest(v_all) x where v_site is null or x = v_site);
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, false);
  v_fig := public.stock_rp__site_figures(v_g, v_win);
  with s as (select (x ->> 'id')::uuid as id, x ->> 'name' as name, x ->> 'currency' as currency from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = any(v_sites)),
  it as (select * from public.stock_rp__in_transit(v_sites, p_to)),
  sh as (
    select t.to_location_id as loc, sum(coalesce(l.short_qty_base, 0) * coalesce(l.unit_cost, 0)) as v, count(*) filter (where coalesce(l.short_qty_base, 0) > 0) as n
      from stock_transfers t join stock_transfer_lines l on l.transfer_id = t.id and not coalesce(l.dropped, false)
     where t.to_location_id = any(v_sites) and t.received_at is not null
       and public.stock_co__vday(t.to_location_id, t.received_at) between p_from and p_to
     group by 1
  ),
  st as (
    select z.loc, count(*) filter (where z.status = 'DISPUTED') as disputed, count(*) filter (where z.status = 'REQUESTED') as requests,
           count(*) filter (where z.at_day between p_from and p_to) as n
      from (select t.id, t.status, x.loc, public.stock_co__vday(x.loc, coalesce(t.sent_at, t.requested_at, t.created_at)) as at_day
              from stock_transfers t cross join lateral (values (t.location_id), (t.to_location_id)) x(loc)
             where x.loc = any(v_sites)) z
     group by z.loc
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', s.id, 'site', s.name, 'currency', s.currency,
           'sent_out', round(coalesce((f ->> 'transfers_out')::numeric, 0), 2), 'received_in', round(coalesce((f ->> 'transfers_in')::numeric, 0), 2),
           'in_transit', coalesce(it.value, 0), 'in_transit_count', coalesce(it.n, 0),
           'short', round(coalesce(sh.v, 0), 2), 'short_lines', coalesce(sh.n, 0),
           'disputed', coalesce(st.disputed, 0), 'requests_open', coalesce(st.requests, 0), 'transfers', coalesce(st.n, 0),
           'snapshot', coalesce((f ->> 'snapshot')::boolean, false))
           order by s.name, s.id), '[]'::jsonb)
    into v_site_rows
    from s
    left join lateral (select y as f from jsonb_array_elements(v_fig) y where y ->> 'location_id' = s.id::text limit 1) q on true
    left join it on it.location_id = s.id
    left join sh on sh.loc = s.id
    left join st on st.loc = s.id;
  v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('sent_out', 'Sent out', 'money'),
    public.stock_rp__col('received_in', 'Received in', 'money'), public.stock_rp__col('in_transit', 'In transit', 'money'),
    public.stock_rp__col('short', 'Short', 'money'), public.stock_rp__col('disputed', 'Disputed', 'qty'), public.stock_rp__col('requests_open', 'Requests open', 'qty'));
  if v_level = 'grid' then
    v_cols := jsonb_build_array(public.stock_rp__col('from_site', 'From', 'text'), public.stock_rp__col('to_site', 'To', 'text'),
      public.stock_rp__col('value', 'Received value', 'money'), public.stock_rp__col('sent_value', 'Sent at cost', 'money'), public.stock_rp__col('transfers', 'Transfers', 'qty'));
    select coalesce(jsonb_agg(jsonb_build_object('from_location_id', z.f, 'to_location_id', z.tt,
             'from_site', (select l.name from locations l where l.id = z.f), 'to_site', (select l.name from locations l where l.id = z.tt),
             'currency', (select coalesce(nullif(l.currency, ''), 'GBP') from locations l where l.id = z.tt),
             'value', round(z.v, 2), 'sent_value', round(z.sv, 2), 'transfers', z.n) order by z.v desc, z.f, z.tt), '[]'::jsonb)
      into v_rows
      from (select t.location_id as f, t.to_location_id as tt,
                   sum(coalesce(l.qty_received_base, 0) * coalesce(l.to_unit_cost, l.unit_cost, 0)) as v,
                   sum(coalesce(l.qty_base, 0) * coalesce(l.unit_cost, 0)) as sv, count(distinct t.id) as n
              from stock_transfers t join stock_transfer_lines l on l.transfer_id = t.id and not coalesce(l.dropped, false)
             where (t.location_id = any(v_sites) or t.to_location_id = any(v_sites)) and t.to_location_id is not null and t.received_at is not null
               and t.location_id = any(v_all) and t.to_location_id = any(v_all)
               and public.stock_co__vday(t.to_location_id, t.received_at) between p_from and p_to
             group by 1, 2
             order by 3 desc
             limit 2500) z;
  elsif v_level = 'list' then
    v_cols := jsonb_build_array(public.stock_rp__col('at', 'When', 'day'), public.stock_rp__col('reference', 'Transfer', 'text'),
      public.stock_rp__col('from_site', 'From', 'text'), public.stock_rp__col('to_site', 'To', 'text'), public.stock_rp__col('words', 'Status', 'text'),
      public.stock_rp__col('value', 'Value', 'money'), public.stock_rp__col('short_value', 'Short', 'money'), public.stock_rp__col('lines', 'Lines', 'qty'));
    with t as (
      select t.id, t.reference, t.kind, t.status, t.location_id, t.to_location_id, t.sent_at, t.received_at,
             coalesce(t.sent_at, t.requested_at, t.created_at) as at,
             (select sum(coalesce(l.qty_base, 0) * coalesce(l.unit_cost, 0)) from stock_transfer_lines l where l.transfer_id = t.id and not coalesce(l.dropped, false)) as value,
             (select sum(coalesce(l.short_qty_base, 0) * coalesce(l.unit_cost, 0)) from stock_transfer_lines l where l.transfer_id = t.id and not coalesce(l.dropped, false)) as short_value,
             (select count(*) from stock_transfer_lines l where l.transfer_id = t.id and not coalesce(l.dropped, false)) as lines
        from stock_transfers t
       where (t.location_id = any(v_sites) or t.to_location_id = any(v_sites))
         and public.stock_co__vday(coalesce(t.to_location_id, t.location_id), coalesce(t.sent_at, t.requested_at, t.created_at)) between p_from and p_to
    ),
    w as (
      select t.*, case when t.status = 'SENT' then 'In transit' when t.status = 'DISPUTED' then 'Disputed' when t.status = 'REQUESTED' then 'Requested'
                       when t.status = 'CANCELLED' then 'Cancelled' when t.status = 'DRAFT' then 'Draft'
                       when coalesce(t.short_value, 0) > 0 then 'Short' else 'Received' end as words
        from t
    ),
    pg as (
      select w.* from w
       where (v_status is null or (v_status = 'short' and w.words = 'Short') or w.status = v_status)
         and (p_after is null or w.at < (p_after ->> 'at')::timestamptz or (w.at = (p_after ->> 'at')::timestamptz and w.id::text > coalesce(p_after ->> 'id', '')))
       order by w.at desc, w.id
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('id', pg.id, 'reference', pg.reference, 'kind', pg.kind, 'status', pg.status, 'words', pg.words,
             'from_location_id', pg.location_id, 'to_location_id', pg.to_location_id,
             'from_site', (select l.name from locations l where l.id = pg.location_id), 'to_site', (select l.name from locations l where l.id = pg.to_location_id),
             'currency', (select coalesce(nullif(l.currency, ''), 'GBP') from locations l where l.id = pg.location_id),
             'at', pg.at, 'sent_at', pg.sent_at, 'received_at', pg.received_at, 'value', round(coalesce(pg.value, 0), 2),
             'short_value', round(coalesce(pg.short_value, 0), 2), 'lines', pg.lines) order by pg.at desc, pg.id), '[]'::jsonb), count(*)
      into v_rows, v_n from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('at', v_rows -> (v_limit - 1) ->> 'at', 'id', v_rows -> (v_limit - 1) ->> 'id');
    end if;
  elsif v_level = 'kitchen' then
    v_cols := jsonb_build_array(public.stock_rp__col('kitchen', 'Kitchen', 'text'), public.stock_rp__col('site', 'Site', 'text'),
      public.stock_rp__col('orders', 'Orders', 'qty'), public.stock_rp__col('fill_rate', 'Fill rate %', 'pct'), public.stock_rp__col('short_lines', 'Short lines', 'qty'),
      public.stock_rp__col('on_time_pct', 'Sent on time %', 'pct'), public.stock_rp__col('internal_sales', 'Internal sales', 'money'),
      public.stock_rp__col('margin', 'Margin', 'money'), public.stock_rp__col('made_value', 'Made', 'money'),
      public.stock_rp__col('kitchen_stock_value', 'Kitchen stock', 'money'), public.stock_rp__col('kitchen_waste', 'Kitchen waste', 'money'));
    with k as (
      select (x ->> 'id')::uuid as id, x ->> 'name' as name, x ->> 'currency' as currency from jsonb_array_elements(v_g -> 'sites') x
       where x ->> 'kind' = 'central_kitchen' and (v_site is null or (x ->> 'id')::uuid = v_site)
    ),
    tr as (
      select t.id, t.location_id as kitchen, t.to_location_id as loc, t.purchase_order_id, t.sent_at, t.received_at, po.expected_date
        from stock_transfers t join k on k.id = t.location_id
        left join purchase_orders po on po.id = t.purchase_order_id
       where t.kind = 'central_kitchen' and t.sent_at is not null and t.status not in ('DRAFT', 'CANCELLED', 'REQUESTED')
         and public.stock_co__vday(t.location_id, t.sent_at) between p_from and p_to
    ),
    ord as (
      select tr.kitchen, tr.loc, sum(coalesce(pl.qty_packs, 0)) as oq, sum(coalesce(pl.qty_packs, 0) * coalesce(pl.unit_price, 0)) as ov,
             count(*) filter (where coalesce(pl.qty_packs, 0) > 0 and coalesce((select sum(l.qty_base) from stock_transfer_lines l
                                                                                 where l.transfer_id = tr.id and l.to_inventory_item_id = pl.inventory_item_id
                                                                                   and not coalesce(l.dropped, false)), 0)
                                                                        / nullif(coalesce(pl.pack_qty, 1) * coalesce(pl.inner_qty, 1), 0) < pl.qty_packs - 0.0001) as short_n
        from tr join po_lines pl on pl.po_id = tr.purchase_order_id
       group by 1, 2
    ),
    snt as (
      select tr.kitchen, tr.loc, count(distinct tr.id) as orders,
             count(distinct tr.id) filter (where tr.expected_date is null or public.stock_co__vday(tr.kitchen, tr.sent_at) <= tr.expected_date) as on_time,
             sum(coalesce(l.qty_base, 0) * coalesce(l.to_unit_cost, 0)) as sv,
             sum(coalesce(l.qty_base, 0) / nullif((select coalesce(pl.pack_qty, 1) * coalesce(pl.inner_qty, 1) from po_lines pl
                                                    where pl.po_id = tr.purchase_order_id and pl.inventory_item_id = l.to_inventory_item_id limit 1), 0)) as sq
        from tr join stock_transfer_lines l on l.transfer_id = tr.id and not coalesce(l.dropped, false)
       group by 1, 2
    ),
    rcv as (
      select t.location_id as kitchen, t.to_location_id as loc,
             sum(coalesce(l.qty_received_base, 0) * coalesce(l.to_unit_cost, 0)) as sales, sum(coalesce(l.qty_received_base, 0) * coalesce(l.unit_cost, 0)) as cost
        from stock_transfers t join k on k.id = t.location_id
        join stock_transfer_lines l on l.transfer_id = t.id and not coalesce(l.dropped, false)
       where t.kind = 'central_kitchen' and t.received_at is not null
         and public.stock_co__vday(t.to_location_id, t.received_at) between p_from and p_to
       group by 1, 2
    ),
    pairs as (select kitchen, loc from snt union select kitchen, loc from rcv),
    site_rows as (
      select k.id as kitchen_location_id, k.name as kitchen, p.loc as location_id, (select l.name from locations l where l.id = p.loc) as site, k.currency,
             coalesce(snt.orders, 0) as orders, ord.oq as ordered_qty, snt.sq as sent_qty, ord.ov as ordered_value, snt.sv as sent_value,
             public.stock_rp__pct(snt.sv, ord.ov) as fill_rate, coalesce(ord.short_n, 0) as short_lines,
             public.stock_rp__pct(snt.on_time::numeric, snt.orders::numeric) as on_time_pct,
             round(coalesce(rcv.sales, 0), 2) as internal_sales, round(coalesce(rcv.cost, 0), 2) as kitchen_cost,
             round(coalesce(rcv.sales, 0) - coalesce(rcv.cost, 0), 2) as margin
        from pairs p join k on k.id = p.kitchen
        left join snt on snt.kitchen = p.kitchen and snt.loc = p.loc
        left join ord on ord.kitchen = p.kitchen and ord.loc = p.loc
        left join rcv on rcv.kitchen = p.kitchen and rcv.loc = p.loc
    ),
    self_rows as (
      select k.id as kitchen_location_id, k.name as kitchen, k.currency,
             round(coalesce((select sum(d.value) from stock_day_sums d where d.location_id = k.id and d.demo = false and d.movement_type = 'PRODUCTION_OUTPUT'
                               and d.business_day between p_from and p_to), 0), 2) as made_value,
             coalesce((select sum(t.qty) from stock_kitchen_plan_ticks t where t.location_id = k.id and t.business_day between p_from and p_to), 0) as planned_qty,
             coalesce((select sum(b.actual_qty) from production_batches b where b.location_id = k.id
                         and public.stock_co__vday(k.id, b.produced_at) between p_from and p_to), 0) as made_qty,
             round(coalesce((select v.positive_value from public.stock_rp__site_value_at(array[k.id], p_to) v), 0), 2) as kitchen_stock_value,
             round(coalesce((select -sum(d.value) from stock_day_sums d where d.location_id = k.id and d.demo = false and d.movement_type = 'WASTE'
                               and d.business_day between p_from and p_to), 0), 2) as kitchen_waste
        from k
    )
    select coalesce(jsonb_agg(r order by r ->> 'kitchen', (r ->> 'kind') desc, r ->> 'site'), '[]'::jsonb) into v_rows
      from (select jsonb_build_object('kind', 'kitchen', 'kitchen_location_id', s.kitchen_location_id, 'kitchen', s.kitchen, 'location_id', s.kitchen_location_id,
                                      'site', s.kitchen, 'currency', s.currency, 'made_value', s.made_value, 'planned_qty', s.planned_qty, 'made_qty', s.made_qty,
                                      'kitchen_stock_value', s.kitchen_stock_value, 'kitchen_waste', s.kitchen_waste) as r
              from self_rows s
            union all
            select jsonb_build_object('kind', 'site', 'kitchen_location_id', s.kitchen_location_id, 'kitchen', s.kitchen, 'location_id', s.location_id, 'site', s.site,
                                      'currency', s.currency, 'orders', s.orders, 'ordered_qty', s.ordered_qty, 'sent_qty', round(s.sent_qty, 3),
                                      'ordered_value', round(s.ordered_value, 2), 'sent_value', round(s.sent_value, 2), 'fill_rate', s.fill_rate,
                                      'short_lines', s.short_lines, 'on_time_pct', s.on_time_pct, 'internal_sales', s.internal_sales,
                                      'kitchen_cost', s.kitchen_cost, 'margin', s.margin)
              from site_rows s
             limit 1000) z;
    if not exists (select 1 from jsonb_array_elements(v_g -> 'sites') x where x ->> 'kind' = 'central_kitchen') then
      v_notes := v_notes || to_jsonb('No central kitchen in these sites.'::text);
    end if;
  elsif v_level = 'recharges' then
    v_cols := jsonb_build_array(public.stock_rp__col('from_legal', 'From', 'text'), public.stock_rp__col('to_legal', 'To', 'text'),
      public.stock_rp__col('amount', 'Recharge', 'money'), public.stock_rp__col('transfers', 'Transfers', 'qty'));
    with t as (
      select tr.id, tr.kind, tr.location_id as f, tr.to_location_id as tt,
             (select x.tenant_id from public.stock_rp__legal_of(tr.location_id) x) as ft, (select x.tenant_name from public.stock_rp__legal_of(tr.location_id) x) as fn,
             (select x.tenant_id from public.stock_rp__legal_of(tr.to_location_id) x) as tot, (select x.tenant_name from public.stock_rp__legal_of(tr.to_location_id) x) as tn,
             (select sum(coalesce(l.qty_received_base, 0) * coalesce(l.to_unit_cost, 0)) from stock_transfer_lines l where l.transfer_id = tr.id and not coalesce(l.dropped, false)) as amount
        from stock_transfers tr
       where (tr.location_id = any(v_sites) or tr.to_location_id = any(v_sites))
         and tr.status in ('RECEIVED', 'DISPUTED') and tr.received_at is not null and tr.to_location_id is not null and tr.to_location_id <> tr.location_id
         and public.stock_co__vday(tr.to_location_id, tr.received_at) between p_from and p_to
    )
    select coalesce(jsonb_agg(jsonb_build_object('from_tenant', z.ft, 'to_tenant', z.tot,
             'from_legal', coalesce(z.fn, 'Not connected to Xero'), 'to_legal', coalesce(z.tn, 'Not connected to Xero'),
             'currency', z.currency, 'amount', round(z.amount, 2), 'transfers', z.n) order by z.amount desc), '[]'::jsonb)
      into v_rows
      from (select t.ft, t.tot, min(t.fn) as fn, min(t.tn) as tn, min((select coalesce(nullif(l.currency, ''), 'GBP') from locations l where l.id = t.tt)) as currency,
                   sum(coalesce(t.amount, 0)) as amount, count(*) as n
              from t where t.kind = 'central_kitchen' or t.ft is null or t.tot is null or t.ft <> t.tot
             group by 1, 2 limit 1000) z;
  else
    v_rows := (select coalesce(jsonb_agg(r), '[]'::jsonb) from (select r from jsonb_array_elements(v_site_rows) r limit 1000) z);
  end if;
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'transfers', p_from, p_to, false, v_level, v_cols, v_win,
              v_notes || jsonb_build_array('Sent out and received in are the stock ledger''s transfers, at each site''s cost.')),
    'totals', v_site_rows || public.stock_rp__sum_rows(v_site_rows, array['sent_out', 'received_in', 'in_transit', 'in_transit_count', 'short', 'short_lines',
                                                                          'disputed', 'requests_open', 'transfers']),
    'rows', v_rows, 'next', v_next);
end
$fn$;

-- stock_report_count_compliance (5.15): counts due by the count plans and how each went, the last full
-- count, counted against estimated lines, time taken, variance at approval, second approvals; a
-- calendar of every plan day; each count.
create or replace function public.stock_report_count_compliance(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
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
  v_sites  uuid[];
  v_win    jsonb;
  v_cal    jsonb := '[]'::jsonb;
  v_plans  boolean;
  v_last   date;
  v_site_rows jsonb;
  v_rows   jsonb := '[]'::jsonb;
  v_next   jsonb;
  v_cols   jsonb;
  v_n      integer;
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  if v_level not in ('site', 'calendar', 'count') then
    v_level := 'site';
  end if;
  v_sites := array(select (x ->> 'id')::uuid from jsonb_array_elements(v_g -> 'sites') x where v_site is null or (x ->> 'id')::uuid = v_site);
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, false);
  v_plans := exists (select 1 from stock_count_plans p where p.org_id = p_org and p.archived_at is null);
  if v_plans then
    v_last := least(p_to, (select max(public.stock_co__today(x)) from unnest(v_sites) x));
    select coalesce(jsonb_agg(e || jsonb_build_object('day', e ->> 'due_day') order by e ->> 'location_id', e ->> 'due_day', e ->> 'plan_id'), '[]'::jsonb)
      into v_cal
      from generate_series(p_from, v_last, interval '1 day') d
     cross join lateral jsonb_array_elements(public.stock_co__count_due_rows(p_org, v_sites, d::date)) e
     where (e ->> 'due_day')::date <= public.stock_co__today((e ->> 'location_id')::uuid);
  end if;
  with s as (select (x ->> 'id')::uuid as id, x ->> 'name' as name, x ->> 'currency' as currency from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = any(v_sites)),
  cal as (
    select (e ->> 'location_id')::uuid as loc, count(*) as due, count(*) filter (where e ->> 'status' = 'done') as on_time,
           count(*) filter (where e ->> 'status' = 'late') as late, count(*) filter (where e ->> 'status' = 'missed') as missed,
           count(*) filter (where e ->> 'status' = 'due') as waiting
      from jsonb_array_elements(v_cal) e group by 1
  ),
  c as (
    select k.location_id as loc, count(*) as counts,
           sum((select count(*) from stock_count_lines l where l.count_id = k.id and l.counted_qty is not null)) as counted,
           sum((select count(*) from stock_count_lines l where l.count_id = k.id and l.counted_qty is null)) as estimated,
           round(avg(extract(epoch from (k.submitted_at - k.started_at)) / 60.0) filter (where k.submitted_at is not null and k.started_at is not null), 1) as minutes,
           round(sum(abs(coalesce(k.variance_value, 0))), 2) as variance
      from stock_counts k
     where k.location_id = any(v_sites) and k.status = 'APPROVED' and k.approved_at is not null
       and public.stock_co__vday(k.location_id, k.approved_at) between p_from and p_to
     group by 1
  ),
  sa as (
    select k.location_id as loc, count(*) as n from stock_counts k
     where k.location_id = any(v_sites) and k.second_approved_at is not null
       and public.stock_co__vday(k.location_id, k.second_approved_at) between p_from and p_to
     group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', s.id, 'site', s.name, 'currency', s.currency,
           'due', coalesce(cal.due, 0), 'on_time', coalesce(cal.on_time, 0), 'late', coalesce(cal.late, 0), 'missed', coalesce(cal.missed, 0),
           'waiting', coalesce(cal.waiting, 0), 'on_time_pct', public.stock_rp__pct(cal.on_time::numeric, (cal.due - coalesce(cal.waiting, 0))::numeric),
           'last_full', lf.d, 'last_full_words', case when lf.d is null then 'None yet' else to_char(lf.d, 'Dy FMDD Mon') end,
           'counts', coalesce(c.counts, 0), 'lines_counted', coalesce(c.counted, 0), 'lines_estimated', coalesce(c.estimated, 0),
           'counted_pct', public.stock_rp__pct(c.counted, coalesce(c.counted, 0) + coalesce(c.estimated, 0)),
           'minutes_avg', c.minutes, 'variance_value', coalesce(c.variance, 0), 'second_approvals', coalesce(sa.n, 0))
           order by s.name, s.id), '[]'::jsonb)
    into v_site_rows
    from s
    left join cal on cal.loc = s.id
    left join c on c.loc = s.id
    left join sa on sa.loc = s.id
    left join lateral (select max(public.stock_co__vday(k.location_id, k.approved_at)) as d from stock_counts k
                        where k.location_id = s.id and k.status = 'APPROVED' and k.count_type = 'FULL' and k.approved_at is not null
                          and public.stock_co__vday(k.location_id, k.approved_at) <= p_to) lf on true;
  v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('due', 'Due', 'qty'),
    public.stock_rp__col('on_time', 'On time', 'qty'), public.stock_rp__col('late', 'Late', 'qty'), public.stock_rp__col('missed', 'Missed', 'qty'),
    public.stock_rp__col('last_full_words', 'Last full count', 'text'), public.stock_rp__col('counted_pct', 'Lines counted %', 'pct'),
    public.stock_rp__col('minutes_avg', 'Minutes a count', 'qty'), public.stock_rp__col('variance_value', 'Variance at approval', 'money'),
    public.stock_rp__col('second_approvals', 'Second approvals', 'qty'));
  if v_level = 'calendar' then
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('day', 'Day', 'day'),
      public.stock_rp__col('plan_name', 'Count plan', 'text'), public.stock_rp__col('status', 'Status', 'text'));
    with pg as (
      select e from jsonb_array_elements(v_cal) e
       where p_after is null
          or (e ->> 'location_id', e ->> 'day', e ->> 'plan_id') > (coalesce(p_after ->> 'location_id', ''), coalesce(p_after ->> 'day', ''), coalesce(p_after ->> 'plan_id', ''))
       order by e ->> 'location_id', e ->> 'day', e ->> 'plan_id'
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('location_id', (pg.e ->> 'location_id')::uuid,
             'site', (select x ->> 'name' from jsonb_array_elements(v_g -> 'sites') x where x ->> 'id' = pg.e ->> 'location_id'),
             'day', pg.e ->> 'day', 'plan_id', pg.e ->> 'plan_id', 'plan_name', pg.e ->> 'plan_name', 'status', pg.e ->> 'status', 'count_id', pg.e ->> 'count_id')
             order by pg.e ->> 'location_id', pg.e ->> 'day', pg.e ->> 'plan_id'), '[]'::jsonb), count(*)
      into v_rows, v_n from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('location_id', v_rows -> (v_limit - 1) ->> 'location_id', 'day', v_rows -> (v_limit - 1) ->> 'day',
                                   'plan_id', v_rows -> (v_limit - 1) ->> 'plan_id');
    end if;
  elsif v_level = 'count' then
    v_cols := jsonb_build_array(public.stock_rp__col('approved_at', 'Approved', 'day'), public.stock_rp__col('site', 'Site', 'text'),
      public.stock_rp__col('name', 'Count', 'text'), public.stock_rp__col('count_type', 'Kind', 'text'), public.stock_rp__col('approved_by_name', 'Approved by', 'text'),
      public.stock_rp__col('minutes', 'Minutes', 'qty'), public.stock_rp__col('counted', 'Counted', 'qty'), public.stock_rp__col('estimated', 'Estimated', 'qty'),
      public.stock_rp__col('variance_value', 'Variance', 'money'), public.stock_rp__col('second_approved_by_name', 'Second approval', 'text'));
    with pg as (
      select k.* from stock_counts k
       where k.location_id = any(v_sites) and k.status = 'APPROVED' and k.approved_at is not null
         and public.stock_co__vday(k.location_id, k.approved_at) between p_from and p_to
         and (p_after is null or k.approved_at < (p_after ->> 'approved_at')::timestamptz
              or (k.approved_at = (p_after ->> 'approved_at')::timestamptz and k.id::text > coalesce(p_after ->> 'count_id', '')))
       order by k.approved_at desc, k.id
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('count_id', pg.id, 'location_id', pg.location_id,
             'site', (select x ->> 'name' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = pg.location_id),
             'currency', (select x ->> 'currency' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = pg.location_id),
             'name', pg.name, 'count_type', pg.count_type, 'started_at', pg.started_at, 'submitted_at', pg.submitted_at, 'approved_at', pg.approved_at,
             'approved_by_name', coalesce(pg.approved_by_staff_name, pg.approved_by_name),
             'minutes', case when pg.submitted_at is not null and pg.started_at is not null then round(extract(epoch from (pg.submitted_at - pg.started_at)) / 60.0, 1) end,
             'lines', (select count(*) from stock_count_lines l where l.count_id = pg.id),
             'counted', (select count(*) from stock_count_lines l where l.count_id = pg.id and l.counted_qty is not null),
             'estimated', (select count(*) from stock_count_lines l where l.count_id = pg.id and l.counted_qty is null),
             'variance_value', pg.variance_value, 'second_approved_by_name', pg.second_approved_by_name,
             'plan_name', (select p.name from stock_count_plans p where p.id = pg.plan_id)) order by pg.approved_at desc, pg.id), '[]'::jsonb), count(*)
      into v_rows, v_n from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('approved_at', v_rows -> (v_limit - 1) ->> 'approved_at', 'count_id', v_rows -> (v_limit - 1) ->> 'count_id');
    end if;
  else
    v_rows := (select coalesce(jsonb_agg(r), '[]'::jsonb) from (select r from jsonb_array_elements(v_site_rows) r limit 1000) z);
  end if;
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'count_compliance', p_from, p_to, false, v_level, v_cols, v_win,
              case when v_plans then '[]'::jsonb else jsonb_build_array('No count plan set. Set one in Inventory, Counts.') end),
    'totals', v_site_rows || public.stock_rp__sum_rows(v_site_rows, array['due', 'on_time', 'late', 'missed', 'waiting', 'counts', 'lines_counted', 'lines_estimated',
                                                                          'variance_value', 'second_approvals']),
    'rows', v_rows, 'next', v_next);
end
$fn$;

-- The kitchen markup at a site at the END of business day p_day, the part from a kitchen in the same
-- legal company: the snapshot of a locked period ending that day, else worked out live.
create or replace function public.stock_rp__margin_same_legal(p_site uuid, p_day date)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
           (select case when jsonb_typeof(s.metrics -> 'internal_margin_same_legal') = 'number' then (s.metrics ->> 'internal_margin_same_legal')::numeric end
              from stock_periods p join stock_period_snapshots s on s.period_id = p.id and s.location_id = p.location_id
             where p.location_id = p_site and p.to_day = p_day and p.locked_at is not null and p.unlocked_at is null
             order by p.locked_at desc limit 1),
           (select coalesce(sum(m.margin), 0) from public.stock_rp__kitchen_margin(array[p_site], p_day) m
             where (select x.tenant_id from public.stock_rp__legal_of(m.location_id) x)
                   is not distinct from (select x.tenant_id from public.stock_rp__legal_of(m.kitchen_location_id) x)),
           0);
$fn$;

-- stock_report_month_end (5.23): the month end pack per site, per legal company and per category, read
-- from each site's locked period (exactly p_from to p_to) when it is locked, else live and marked.
-- Opening value: the locked period's own, else the closing value of a locked period ending the day
-- before, else the ledger. The legal company rows carry the closing stock journal's state.
create or replace function public.stock_report_month_end(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
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
  v_level  text := coalesce(nullif(v_o ->> 'level', ''), 'site');
  v_sites  uuid[];
  v_win    jsonb;
  v_fig    jsonb;
  v_site_rows jsonb;
  v_rows   jsonb := '[]'::jsonb;
  v_cols   jsonb;
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  if v_level not in ('site', 'legal', 'category') then
    v_level := 'site';
  end if;
  v_sites := array(select (x ->> 'id')::uuid from jsonb_array_elements(v_g -> 'sites') x);
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, false);
  v_fig := public.stock_rp__site_figures(v_g, v_win);
  with s as (
    select (x ->> 'id')::uuid as id, x ->> 'name' as name, x ->> 'currency' as currency,
           (select case when jsonb_typeof(w -> 'snap') = 'object' then w -> 'snap' end from jsonb_array_elements(v_win) w where w ->> 'location_id' = x ->> 'id' limit 1) as snap,
           (select y from jsonb_array_elements(v_fig) y where y ->> 'location_id' = x ->> 'id' limit 1) as f,
           (select sp.metrics from stock_periods p join stock_period_snapshots sp on sp.period_id = p.id and sp.location_id = p.location_id
             where p.location_id = (x ->> 'id')::uuid and p.to_day = p_from - 1 and p.locked_at is not null and p.unlocked_at is null
             order by p.locked_at desc limit 1) as prev
      from jsonb_array_elements(v_g -> 'sites') x
  ),
  it as (select * from public.stock_rp__in_transit(v_sites, p_to)),
  gr as (select * from public.stock_rp__grni(v_sites, p_to)),
  cr as (select * from public.stock_rp__credits_out(v_sites, p_to)),
  rc as (select * from public.stock_rp__recharges(v_sites, p_from, p_to)),
  rows_ as (
    select s.id, s.name, s.currency, s.snap is not null as locked,
           coalesce(case when s.snap is not null then public.stock_rp__snap_num(s.snap, 'opening_value', null) end,
                    case when jsonb_typeof(s.prev -> 'closing_value') = 'number' then (s.prev ->> 'closing_value')::numeric
                         when jsonb_typeof(s.prev -> 'stock_value') = 'number' then (s.prev ->> 'stock_value')::numeric end,
                    (s.f ->> 'opening_value')::numeric) as opening_value,
           (s.f ->> 'closing_value')::numeric as closing_value,
           (s.f ->> 'purchases')::numeric as purchases, (s.f ->> 'transfers_in')::numeric as transfers_in,
           (s.f ->> 'transfers_out')::numeric as transfers_out, (s.f ->> 'waste_value')::numeric as waste_value,
           public.stock_rp__snap_num(s.snap, 'recharges_in', coalesce(rc.recharges_in, 0)) as recharges_in,
           public.stock_rp__snap_num(s.snap, 'recharges_out', coalesce(rc.recharges_out, 0)) as recharges_out,
           public.stock_rp__snap_num(s.snap, 'grni', coalesce(gr.value, 0)) as grni,
           public.stock_rp__snap_num(s.snap, 'credits_outstanding', coalesce(cr.value, 0)) as credits_outstanding,
           public.stock_rp__snap_num(s.snap, 'in_transit', coalesce(it.value, 0)) as in_transit,
           s.snap ->> 'locked_at' as locked_at,
           (select x.tenant_id from public.stock_rp__legal_of(s.id) x) as tenant_id,
           (select x.tenant_name from public.stock_rp__legal_of(s.id) x) as tenant_name,
           case when s.snap is not null and jsonb_typeof(s.snap -> 'by_category') = 'array' then s.snap -> 'by_category' end as by_category
      from s
      left join it on it.location_id = s.id
      left join gr on gr.location_id = s.id
      left join cr on cr.location_id = s.id
      left join rc on rc.location_id = s.id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', r.id, 'site', r.name, 'currency', r.currency, 'locked', r.locked, 'locked_at', r.locked_at,
           'opening_value', round(r.opening_value, 2), 'closing_value', round(r.closing_value, 2), 'movement', round(r.closing_value - r.opening_value, 2),
           'purchases', round(r.purchases, 2), 'transfers_in', round(r.transfers_in, 2), 'transfers_out', round(r.transfers_out, 2),
           'waste_value', round(r.waste_value, 2), 'recharges_in', round(r.recharges_in, 2), 'recharges_out', round(r.recharges_out, 2),
           'grni', round(r.grni, 2), 'credits_outstanding', round(r.credits_outstanding, 2), 'in_transit', round(r.in_transit, 2),
           'tenant_id', r.tenant_id, 'legal_company', coalesce(r.tenant_name, 'Not connected to Xero'),
           'margin_close', public.stock_rp__margin_same_legal(r.id, p_to), 'margin_open', public.stock_rp__margin_same_legal(r.id, p_from - 1),
           'by_category', r.by_category)
           order by r.name, r.id), '[]'::jsonb)
    into v_site_rows
    from rows_ r;
  v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('locked', 'Locked', 'text'),
    public.stock_rp__col('opening_value', 'Opening stock', 'money'), public.stock_rp__col('closing_value', 'Closing stock', 'money'),
    public.stock_rp__col('movement', 'Movement', 'money'), public.stock_rp__col('purchases', 'Purchases', 'money'),
    public.stock_rp__col('transfers_in', 'Transfers in', 'money'), public.stock_rp__col('transfers_out', 'Transfers out', 'money'),
    public.stock_rp__col('waste_value', 'Waste', 'money'), public.stock_rp__col('recharges_in', 'Recharges in', 'money'),
    public.stock_rp__col('recharges_out', 'Recharges out', 'money'), public.stock_rp__col('grni', 'Received not invoiced', 'money'),
    public.stock_rp__col('credits_outstanding', 'Credits still owed', 'money'), public.stock_rp__col('in_transit', 'In transit', 'money'));
  if v_level = 'legal' then
    v_cols := jsonb_build_array(public.stock_rp__col('legal_company', 'Legal company', 'text'), public.stock_rp__col('opening_value', 'Opening stock', 'money'),
      public.stock_rp__col('closing_value', 'Closing stock', 'money'), public.stock_rp__col('internal_margin', 'Kitchen margin taken out', 'money'),
      public.stock_rp__col('movement', 'Movement', 'money'), public.stock_rp__col('grni', 'Received not invoiced', 'money'),
      public.stock_rp__col('credits_outstanding', 'Credits still owed', 'money'));
    with g as (
      select r ->> 'tenant_id' as tenant_id, min(r ->> 'legal_company') as legal, r ->> 'currency' as currency,
             jsonb_agg(jsonb_build_object('location_id', r -> 'location_id', 'site', r -> 'site', 'locked', r -> 'locked') order by r ->> 'site') as sites,
             bool_and((r ->> 'locked')::boolean) as locked_all,
             sum((r ->> 'opening_value')::numeric) as ov, sum((r ->> 'closing_value')::numeric) as cv,
             sum((r ->> 'margin_open')::numeric) as mo, sum((r ->> 'margin_close')::numeric) as mc,
             sum((r ->> 'purchases')::numeric) as pu, sum((r ->> 'waste_value')::numeric) as wv, sum((r ->> 'grni')::numeric) as gr,
             sum((r ->> 'credits_outstanding')::numeric) as co, sum((r ->> 'recharges_in')::numeric) as ri, sum((r ->> 'recharges_out')::numeric) as ro,
             sum((r ->> 'in_transit')::numeric) as it
        from jsonb_array_elements(v_site_rows) r group by r ->> 'tenant_id', r ->> 'currency'
    ),
    gj as (
      select g.*,
             (select x.location_id from xero_connections x join locations l on l.id = x.location_id
               where l.org_id = p_org and x.tenant_id = g.tenant_id order by x.updated_at desc nulls last limit 1) as conn,
             (select position('accounting.manualjournals' in coalesce(x.scopes, '')) > 0 from xero_connections x join locations l on l.id = x.location_id
               where l.org_id = p_org and x.tenant_id = g.tenant_id order by x.updated_at desc nulls last limit 1) as scopes_ok,
             (select to_jsonb(j) from stock_month_end_journals j where j.org_id = p_org and j.period = p_from and j.tenant_id = g.tenant_id) as j
        from g
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'tenant_id', gj.tenant_id, 'legal_company', gj.legal, 'currency', gj.currency, 'sites', gj.sites, 'locked_all', gj.locked_all,
             'opening_value', round(gj.ov - gj.mo, 2), 'closing_value', round(gj.cv - gj.mc, 2), 'internal_margin', round(gj.mc, 2),
             'movement', round((gj.cv - gj.mc) - (gj.ov - gj.mo), 2), 'purchases', round(gj.pu, 2), 'waste_value', round(gj.wv, 2),
             'grni', round(gj.gr, 2), 'credits_outstanding', round(gj.co, 2), 'recharges_in', round(gj.ri, 2), 'recharges_out', round(gj.ro, 2),
             'in_transit', round(gj.it, 2), 'connection_location_id', gj.conn, 'scopes_ok', coalesce(gj.scopes_ok, false),
             'journal', jsonb_build_object(
               'status', case when gj.j ->> 'status' = 'sent' then 'sent'
                              when gj.j ->> 'status' = 'sending' and (gj.j ->> 'updated_at')::timestamptz > now() - interval '10 minutes' then 'sending'
                              when gj.tenant_id is null or gj.conn is null then 'not_connected'
                              when not gj.locked_all then 'not_locked' when not coalesce(gj.scopes_ok, false) then 'needs_reconnect' else 'ready' end,
               'xero_journal_id', gj.j ->> 'xero_journal_id', 'sent_at', gj.j ->> 'sent_at', 'sent_by_name', gj.j ->> 'sent_by_name',
               'amount', coalesce((gj.j ->> 'amount')::numeric, round((gj.cv - gj.mc) - (gj.ov - gj.mo), 2)),
               'stock_account', gj.j ->> 'stock_account', 'movement_account', gj.j ->> 'movement_account', 'last_error', gj.j ->> 'last_error',
               'missing_lock', (select coalesce(jsonb_agg(x ->> 'site' order by x ->> 'site'), '[]'::jsonb) from jsonb_array_elements(gj.sites) x
                                 where not coalesce((x ->> 'locked')::boolean, false)),
               'words', case when gj.j ->> 'status' = 'sending' and (gj.j ->> 'updated_at')::timestamptz > now() - interval '10 minutes' then 'Being sent to Xero now.'
                             when gj.j ->> 'status' = 'sent' then 'Sent to Xero as a draft on ' || to_char((gj.j ->> 'sent_at')::timestamptz, 'FMDD Mon')
                                                                || coalesce(' by ' || (gj.j ->> 'sent_by_name'), '') || '.'
                             when gj.tenant_id is null or gj.conn is null then 'Connect this legal company to Xero first.'
                             when not gj.locked_all then 'Lock the month at every site first.'
                             when not coalesce(gj.scopes_ok, false) then 'Reconnect Xero to allow stock journals.'
                             when gj.j ->> 'status' = 'failed' then 'The last send did not work: ' || coalesce(gj.j ->> 'last_error', 'no reason given') || '. Ready to send again.'
                             else 'Ready to send to Xero as a draft.' end))
             order by gj.currency, gj.legal), '[]'::jsonb)
      into v_rows
      from gj;
  elsif v_level = 'category' then
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('name', 'Category', 'text'),
      public.stock_rp__col('closing_value', 'Closing stock', 'money'));
    select coalesce(jsonb_agg(z.r order by z.site, (z.r ->> 'closing_value')::numeric desc, z.r ->> 'name'), '[]'::jsonb) into v_rows
      from (select r ->> 'site' as site,
                   jsonb_build_object('location_id', r -> 'location_id', 'site', r -> 'site', 'currency', r -> 'currency',
                                      'category_id', c -> 'category_id', 'name', c -> 'name',
                                      'closing_value', coalesce(c -> 'closing_value', c -> 'value')) as r
              from jsonb_array_elements(v_site_rows) r
             cross join lateral jsonb_array_elements(r -> 'by_category') c
             where jsonb_typeof(r -> 'by_category') = 'array'
            union all
            select (select x ->> 'name' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = c.location_id),
                   jsonb_build_object('location_id', c.location_id, 'site', (select x ->> 'name' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = c.location_id),
                                      'currency', (select x ->> 'currency' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = c.location_id),
                                      'category_id', c.category_id, 'name', c.name, 'closing_value', round(c.v, 2))
              from (select v.location_id, ci.category_id, coalesce(cat.name, nullif(btrim(i.category), ''), 'No category') as name,
                           sum(case when v.value > 0 then v.value else 0 end) as v
                      from public.stock_rp__value_at(array(select (r ->> 'location_id')::uuid from jsonb_array_elements(v_site_rows) r
                                                            where jsonb_typeof(r -> 'by_category') <> 'array'), p_to) v
                      join inventory_items i on i.id = v.inventory_item_id
                      left join stock_co_items ci on ci.id = v.company_item_id
                      left join stock_co_categories cat on cat.id = ci.category_id
                     group by 1, 2, 3) c
             limit 1000) z;
  else
    v_rows := (select coalesce(jsonb_agg(r - 'by_category' - 'margin_open' - 'margin_close'), '[]'::jsonb) from (select r from jsonb_array_elements(v_site_rows) r limit 1000) z);
  end if;
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'month_end', p_from, p_to, false, v_level, v_cols, v_win,
              jsonb_build_array('Lock the month at every site of a legal company before its closing stock journal goes to Xero.',
                                'Closing stock journals go to Xero as a DRAFT. Nothing is posted until your accountant posts it in Xero.')
              || coalesce((select jsonb_agg('Not locked: ' || (r ->> 'site') || ' is read live and may still change.' order by r ->> 'site')
                             from jsonb_array_elements(v_site_rows) r where not (r ->> 'locked')::boolean), '[]'::jsonb)),
    'totals', (select coalesce(jsonb_agg(r - 'by_category' - 'margin_open' - 'margin_close'), '[]'::jsonb) from jsonb_array_elements(v_site_rows) r)
              || (select coalesce(jsonb_agg(c || jsonb_build_object('locked', not exists (select 1 from jsonb_array_elements(v_site_rows) r
                                                                                          where coalesce(r ->> 'currency', '') = coalesce(c ->> 'currency', '')
                                                                                            and not (r ->> 'locked')::boolean)) order by c ->> 'currency'), '[]'::jsonb)
                    from jsonb_array_elements(public.stock_rp__sum_rows(v_site_rows, array['opening_value', 'closing_value', 'movement', 'purchases', 'transfers_in',
                                                     'transfers_out', 'waste_value', 'recharges_in', 'recharges_out', 'grni', 'credits_outstanding', 'in_transit'])) c),
    'rows', v_rows, 'next', null);
end
$fn$;

-- stock_month_end_journal: what each legal company's closing stock journal would send (the month end
-- pack's legal company rows, for every open site of the company). Head office only: Stock control
-- 'all' (every owner has it). Also the service role. The xero-stock-journal edge function calls it as
-- the signed in login, so this guard decides who may send.
create or replace function public.stock_month_end_journal(p_org uuid, p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_sites uuid[];
  v_g     jsonb;
  v_a     jsonb;
begin
  -- every site of the company: open ones, and a site closed since that still held or moved stock from
  -- the day before the month (its opening stock belongs in the journal); demo history is left out by the report
  v_sites := array(select l.id from locations l
                    where l.org_id = p_org
                      and (coalesce(l.status, 'active') = 'active'
                           or exists (select 1 from inventory_items i where i.location_id = l.id and coalesce(i.on_hand, 0) <> 0)
                           or exists (select 1 from stock_day_sums d where d.location_id = l.id and d.demo = false and d.business_day >= p_from - 1))
                    order by l.name, l.id limit 50);
  if p_org is null or cardinality(v_sites) = 0 then
    raise exception 'Pick 1 to 50 sites.' using errcode = '22023';
  end if;
  if public._fence_api_role() <> 'service_role' then
    if auth.uid() is null or public.is_anon_session() or not public.second_step_ok() then
      raise exception 'Sign in to Back Office to see stock reports.' using errcode = '42501';
    end if;
    if public.stock_level(auth.uid(), p_org) is distinct from 'all' then
      raise exception 'Only head office sends the closing stock journal.' using errcode = '42501';
    end if;
  end if;
  v_g := public.stock_report_guard(p_org, v_sites);
  v_a := public.stock_report_month_end(p_org, v_sites, p_from, p_to, jsonb_build_object('level', 'legal'), null, 1000);
  return jsonb_build_object('org_id', p_org, 'from', p_from, 'to', p_to,
    'legal', (select coalesce(jsonb_agg(r - 'journal' || jsonb_build_object(
                'tenant_id', r -> 'tenant_id', 'legal_company', r -> 'legal_company', 'currency', r -> 'currency',
                'location_ids', (select coalesce(jsonb_agg(x -> 'location_id'), '[]'::jsonb) from jsonb_array_elements(r -> 'sites') x),
                'connection_location_id', r -> 'connection_location_id', 'scopes_ok', r -> 'scopes_ok', 'locked_all', r -> 'locked_all',
                'missing_lock', r -> 'journal' -> 'missing_lock', 'opening_value', r -> 'opening_value', 'closing_value', r -> 'closing_value',
                'internal_margin', r -> 'internal_margin', 'movement', r -> 'movement', 'amount', round((r ->> 'movement')::numeric, 2),
                'status', r -> 'journal' -> 'status', 'words', r -> 'journal' -> 'words', 'journal', r -> 'journal',
                'already', case when r -> 'journal' ->> 'status' = 'sent'
                                then jsonb_build_object('xero_journal_id', r -> 'journal' -> 'xero_journal_id', 'sent_at', r -> 'journal' -> 'sent_at',
                                                        'sent_by_name', r -> 'journal' -> 'sent_by_name') end,
                'narration', 'Closing stock ' || to_char(p_to, 'FMDD Mon YYYY') || ', ServOS (' || jsonb_array_length(r -> 'sites')
                             || case when jsonb_array_length(r -> 'sites') = 1 then ' site)' else ' sites)' end)
                order by r ->> 'currency', r ->> 'legal_company'), '[]'::jsonb)
                from jsonb_array_elements(v_a -> 'rows') r));
end
$fn$;

-- stock_month_end_journal_record: what xero-stock-journal sent (service role only). A failed send is
-- kept with its words and may be sent again; a sent month is never sent twice.
create or replace function public.stock_month_end_journal_record(p_org uuid, p_from date, p_to date, p_tenant text, p_patch jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_status text := coalesce(p_patch ->> 'status', 'failed');
  v_id     uuid;
  v_name   text;
begin
  if public._fence_api_role() <> 'service_role' then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_org is null or p_from is null or p_to is null or nullif(p_tenant, '') is null or v_status not in ('sent', 'failed') then
    raise exception 'Say which company, month, legal company and outcome.' using errcode = '22023';
  end if;
  if exists (select 1 from stock_month_end_journals j where j.org_id = p_org and j.period = p_from and j.tenant_id = p_tenant and j.status = 'sent') then
    raise exception 'This month was already sent to Xero.' using errcode = '55000';
  end if;
  select x.tenant_name into v_name from xero_connections x join locations l on l.id = x.location_id
   where l.org_id = p_org and x.tenant_id = p_tenant order by x.updated_at desc nulls last limit 1;
  insert into stock_month_end_journals (org_id, period, to_day, tenant_id, tenant_name, status, xero_journal_id, amount, stock_account, movement_account,
                                        sent_at, sent_by, sent_by_name, last_error)
  values (p_org, p_from, p_to, p_tenant, v_name, v_status, nullif(p_patch ->> 'xero_journal_id', ''), nullif(p_patch ->> 'amount', '')::numeric,
          nullif(p_patch ->> 'stock_account', ''), nullif(p_patch ->> 'movement_account', ''),
          case when v_status = 'sent' then now() end, nullif(p_patch ->> 'sent_by', '')::uuid, nullif(p_patch ->> 'sent_by_name', ''),
          case when v_status = 'failed' then left(coalesce(p_patch ->> 'error', 'Xero did not take it.'), 500) end)
  on conflict (org_id, period, tenant_id) do update
     set status = excluded.status, to_day = excluded.to_day, tenant_name = coalesce(excluded.tenant_name, stock_month_end_journals.tenant_name),
         xero_journal_id = coalesce(excluded.xero_journal_id, stock_month_end_journals.xero_journal_id),
         amount = coalesce(excluded.amount, stock_month_end_journals.amount),
         stock_account = coalesce(excluded.stock_account, stock_month_end_journals.stock_account),
         movement_account = coalesce(excluded.movement_account, stock_month_end_journals.movement_account),
         sent_at = excluded.sent_at, sent_by = coalesce(excluded.sent_by, stock_month_end_journals.sent_by),
         sent_by_name = coalesce(excluded.sent_by_name, stock_month_end_journals.sent_by_name),
         last_error = excluded.last_error, updated_at = now()
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'status', v_status);
end
$fn$;

-- stock_month_end_journal_claim: one send at a time for a legal company and month (service role only).
-- xero-stock-journal claims BEFORE it calls Xero: a row in 'sending'. A second send while one is sending
-- is refused 55000 'This journal is already being sent.' (a claim older than 10 minutes is taken over:
-- the call that made it died). A sent month is refused for good. On a Xero failure the function records
-- 'failed' (stock_month_end_journal_record), which frees the month to be sent again.
create or replace function public.stock_month_end_journal_claim(p_org uuid, p_from date, p_to date, p_tenant text, p_by uuid, p_by_name text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_row stock_month_end_journals;
  v_name text;
begin
  if public._fence_api_role() <> 'service_role' then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_org is null or p_from is null or p_to is null or nullif(p_tenant, '') is null then
    raise exception 'Say which company, month and legal company.' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('stock_month_end_journal:' || p_org::text || ':' || p_from::text || ':' || p_tenant));
  select * into v_row from stock_month_end_journals j where j.org_id = p_org and j.period = p_from and j.tenant_id = p_tenant for update;
  if v_row.status = 'sent' then
    raise exception 'This month was already sent to Xero.' using errcode = '55000';
  end if;
  if v_row.status = 'sending' and v_row.updated_at > now() - interval '10 minutes' then
    raise exception 'This journal is already being sent.' using errcode = '55000';
  end if;
  select x.tenant_name into v_name from xero_connections x join locations l on l.id = x.location_id
   where l.org_id = p_org and x.tenant_id = p_tenant order by x.updated_at desc nulls last limit 1;
  insert into stock_month_end_journals (org_id, period, to_day, tenant_id, tenant_name, status, sent_by, sent_by_name, last_error)
  values (p_org, p_from, p_to, p_tenant, v_name, 'sending', p_by, nullif(p_by_name, ''), null)
  on conflict (org_id, period, tenant_id) do update
     set status = 'sending', to_day = excluded.to_day, sent_by = excluded.sent_by, sent_by_name = excluded.sent_by_name,
         last_error = null, updated_at = now();
  return jsonb_build_object('ok', true, 'status', 'sending');
end
$fn$;

-- stock_lock_period (replaced): the Drop 3 body (same checks, same words, same answer) with a snapshot
-- that holds every figure the reports read: the Drop 3 keys as before, then the site figures of the
-- period (opening and closing value, purchases, transfers, made, used, sold, waste, revalue, count
-- adjustments, sales, theoretical and actual cost, loyalty, staff and comps), the closing value by
-- category, in transit, goods received not invoiced, credits still owed, recharges and the kitchen
-- markup. Money to the penny.
create or replace function public.stock_lock_period(p_loc uuid, p_from date, p_to date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_g jsonb;
  v_id uuid;
  v_m jsonb;
  v_sales numeric;
  v_cogs numeric;
  v_g4 jsonb;
  v_fig jsonb;
  v_cat jsonb;
  v_x jsonb;
begin
  select l.org_id into v_org from locations l where l.id = p_loc;
  if v_org is null or p_from is null or p_to is null or p_to < p_from then
    raise exception 'Pick the first and last day of the period.' using errcode = '22023';
  end if;
  v_g := public.stock_co__guard(v_org, 'inventory', 'company', array[p_loc]);
  if public.stock_level((v_g ->> 'uid')::uuid, v_org) is distinct from 'all' then
    raise exception 'Not allowed: this is set by head office.' using errcode = '42501';
  end if;
  if p_to >= public.stock_co__today(p_loc) then
    raise exception 'A period to lock ends before today.' using errcode = '22023';
  end if;
  if exists (select 1 from stock_periods p where p.location_id = p_loc and p.locked_at is not null and p.unlocked_at is null
                and p.from_day <= p_to and p.to_day >= p_from) then
    raise exception 'That overlaps a locked period.' using errcode = '22023';
  end if;
  select coalesce(sum(d.net), 0) into v_sales from sales_day_sums d where d.location_id = p_loc and d.business_day between p_from and p_to;
  select coalesce(-sum(s.value), 0) into v_cogs from stock_day_sums s
   where s.location_id = p_loc and s.business_day between p_from and p_to and not s.demo and s.movement_type = 'SALE_DEPLETION';
  select jsonb_build_object(
           'stock_value', round(coalesce((select sum(i.on_hand * coalesce(i.current_cost, 0)) from inventory_items i where i.location_id = p_loc), 0)
                                - coalesce((select sum(s.value) from stock_day_sums s where s.location_id = p_loc and not s.demo and s.business_day > p_to), 0), 2),
           'purchases', round(coalesce(sum(s.value) filter (where s.movement_type = 'PURCHASE_RECEIPT'), 0), 2),
           'waste', round(coalesce(-sum(s.value) filter (where s.movement_type = 'WASTE'), 0), 2),
           'cogs', round(v_cogs, 2),
           'transfers_in', round(coalesce(sum(s.value) filter (where s.movement_type = 'TRANSFER_IN'), 0), 2),
           'transfers_out', round(coalesce(-sum(s.value) filter (where s.movement_type = 'TRANSFER_OUT'), 0), 2),
           'count_variance', round(coalesce(sum(s.value) filter (where s.movement_type = 'STOCK_COUNT_ADJ'), 0), 2),
           'sales_net', round(v_sales, 2),
           'gp_pct', case when v_sales > 0 then round((v_sales - v_cogs) / v_sales * 100, 1) end,
           'movements', count(*),
           'computed_at', now())
    into v_m
    from stock_day_sums s
   where s.location_id = p_loc and s.business_day between p_from and p_to and not s.demo;
  -- DROP 4B 20261030a: every figure the reports read, from the reports' own helpers
  v_g4 := public.stock_report_guard(v_org, array[p_loc]);
  v_fig := public.stock_rp__site_figures(v_g4, public.stock_rp__windows(v_g4 -> 'sites', p_from, p_to, false)) -> 0;
  select coalesce(jsonb_agg(jsonb_build_object('category_id', c.category_id, 'name', c.name, 'value', round(c.v, 2), 'closing_value', round(c.v, 2))
                            order by c.v desc, c.name), '[]'::jsonb)
    into v_cat
    from (select ci.category_id, coalesce(cat.name, nullif(btrim(i.category), ''), 'No category') as name, sum(case when v.value > 0 then v.value else 0 end) as v
            from public.stock_rp__value_at(array[p_loc], p_to) v
            join inventory_items i on i.id = v.inventory_item_id
            left join stock_co_items ci on ci.id = v.company_item_id
            left join stock_co_categories cat on cat.id = ci.category_id
           group by 1, 2) c;
  v_x := jsonb_build_object(
           'opening_value', round((v_fig ->> 'opening_value')::numeric, 2), 'closing_value', round((v_fig ->> 'closing_value')::numeric, 2),
           'made', round((v_fig ->> 'made')::numeric, 2), 'used_in_batches', round((v_fig ->> 'used_in_batches')::numeric, 2),
           'sold_cost', round((v_fig ->> 'sold_cost')::numeric, 2), 'revalue', round((v_fig ->> 'revalue')::numeric, 2),
           'count_adj', round((v_fig ->> 'count_adj')::numeric, 2), 'theo_cost', round((v_fig ->> 'theo_cost')::numeric, 2),
           'actual_cost', round((v_fig ->> 'actual_cost')::numeric, 2), 'comps_cost', round((v_fig ->> 'comps_cost')::numeric, 2),
           'comps_qty', (v_fig ->> 'comps_qty')::numeric,
           'sales_net', round((v_fig ->> 'sales_net')::numeric, 2),
           'by_category', v_cat,
           'in_transit', coalesce((select x.value from public.stock_rp__in_transit(array[p_loc], p_to) x), 0),
           'grni', coalesce((select x.value from public.stock_rp__grni(array[p_loc], p_to) x), 0),
           'credits_outstanding', coalesce((select x.value from public.stock_rp__credits_out(array[p_loc], p_to) x), 0),
           'recharges_in', coalesce((select x.recharges_in from public.stock_rp__recharges(array[p_loc], p_from, p_to) x), 0),
           'recharges_out', coalesce((select x.recharges_out from public.stock_rp__recharges(array[p_loc], p_from, p_to) x), 0),
           'internal_margin', coalesce((select sum(x.margin) from public.stock_rp__kitchen_margin(array[p_loc], p_to) x), 0),
           'internal_margin_same_legal', public.stock_rp__margin_same_legal(p_loc, p_to),
           -- what Stock value shows for the period end: the positive part, the negative part, archived stock, items
           'value_positive', coalesce((select round(x.positive_value, 2) from public.stock_rp__site_value_at(array[p_loc], p_to) x), 0),
           'value_negative', coalesce((select round(x.negative_value, 2) from public.stock_rp__site_value_at(array[p_loc], p_to) x), 0),
           'value_archived', coalesce((select round(x.archived_holding_value, 2) from public.stock_rp__site_value_at(array[p_loc], p_to) x), 0),
           'value_items', coalesce((select x.items from public.stock_rp__site_value_at(array[p_loc], p_to) x), 0));
  -- a site whose sales are not known yet (demo history still being taken out) locks its sales as not known
  if jsonb_typeof(v_fig -> 'sales_net') = 'null' then
    v_m := v_m || jsonb_build_object('gp_pct', null);
  end if;
  v_m := v_m || v_x;
  insert into stock_periods (org_id, location_id, from_day, to_day, locked_at, locked_by)
  values (v_org, p_loc, p_from, p_to, now(), (v_g ->> 'uid')::uuid)
  returning id into v_id;
  insert into stock_period_snapshots (period_id, location_id, metrics) values (v_id, p_loc, v_m);
  perform public.stock_co__log(v_org, p_loc, 'period', v_id, 'locked', null, jsonb_build_object('from', p_from, 'to', p_to), 'save');
  return jsonb_build_object('ok', true, 'period_id', v_id, 'metrics', v_m);
end
$fn$;

-- The weekly email (map 4.23, design 5.1): for each multi site company that holds stock, for the week
-- that just ended on each venue's clock (stock_co_settings.week_start), one row per open site once
-- that venue is past its count deadline (the earliest due_by of a daily count plan, or a weekly one
-- due on the first day of the new week, else 10:00) or has approved a count since the week's last
-- day; then one company row once every such site has its row. Only sites that hold stock and are not
-- demo venues: no email ever says there are no figures. Only within a day of the deadline, so a
-- late night never sends an old week. Never raises: a problem is a warning and the alerts go on.
create or replace function public.stock_co__weekly_stage()
returns integer
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_n     integer := 0;
  v_k     integer;
  o       record;
  s       record;
  v_ws    integer;
  v_today date;
  v_w     date;
  v_e     date;
  v_due   time;
  v_tz    text;
  v_dl    timestamptz;
  v_cnt   boolean;
  v_first date;
  v_sites uuid[];
  v_sym   text;
  v_in    jsonb;
begin
  for o in
    select x.org_id from (select distinct l.org_id from locations l where l.org_id is not null) x
     where public.stock_co__multi(x.org_id) and exists (select 1 from stock_co_items i where i.org_id = x.org_id)
     order by x.org_id
  loop
    v_ws := coalesce((select cs.week_start from stock_co_settings cs where cs.org_id = o.org_id), 1) % 7;
    -- the sites the email is about: open, holding stock (the Owner app's rule: a stock item row), never a
    -- demo venue. A site with no stock has no figures to send, so it gets no email.
    v_sites := array(select l.id from locations l
                      where l.org_id = o.org_id and coalesce(l.status, 'active') = 'active' and not coalesce(l.is_demo, false)
                        and exists (select 1 from inventory_items i where i.location_id = l.id)
                      order by l.name, l.id limit 50);
    v_first := null;
    for s in select l.id, l.name, l.currency from locations l where l.id = any(v_sites) order by l.name, l.id loop
      v_today := public.stock_co__today(s.id);
      v_w := v_today - ((extract(dow from v_today)::integer - v_ws + 7) % 7) - 7;
      v_e := v_w + 6;
      if v_first is null then
        v_first := v_w;
      end if;
      v_tz := public.stock_co__tz(s.id);
      v_due := coalesce((select min(p.due_by) from stock_count_plans p
                          where p.org_id = o.org_id and p.active and p.archived_at is null
                            and ((p.sites is null and p.group_ids is null) or s.id = any(coalesce(p.sites, '{}'::uuid[]))
                                 or exists (select 1 from stock_co_site_groups g where g.id = any(coalesce(p.group_ids, '{}'::uuid[])) and s.id = any(g.location_ids)))
                            and (p.every = 'day' or (p.every = 'week' and extract(dow from v_e + 1)::smallint = any(coalesce(p.dows, '{}'::smallint[]))))),
                        time '10:00');
      v_dl := ((v_e + 1)::timestamp + v_due) at time zone v_tz;
      v_cnt := exists (select 1 from stock_counts c where c.location_id = s.id and c.status = 'APPROVED' and c.approved_at is not null
                         and public.stock_co__vday(s.id, c.approved_at) >= v_e);
      if now() < v_dl + interval '1 day' and (now() >= v_dl or v_cnt) then
        v_sym := case upper(coalesce(nullif(s.currency, ''), 'GBP')) when 'GBP' then chr(163) when 'USD' then '$' when 'EUR' then chr(8364)
                      else upper(s.currency) || ' ' end;
        insert into stock_notify_sent (org_id, location_id, kind, ref, payload)
        values (o.org_id, s.id, 'weekly', s.id::text || ':' || v_w::text,
                jsonb_build_object('kind', 'weekly', 'week_start', v_w, 'week_end', v_e, 'org_id', o.org_id, 'site_ids', jsonb_build_array(s.id),
                                   'site_name', s.name, 'count_in', jsonb_build_object(s.id::text, v_cnt), 'currency_symbol', v_sym,
                                   'title', 'Weekly stock: ' || s.name || ', week of ' || to_char(v_w, 'FMDD Mon')))
        on conflict do nothing;
        get diagnostics v_k = row_count;
        v_n := v_n + v_k;
      end if;
    end loop;
    -- the company row, once every open site has its row for that week
    if v_first is not null and cardinality(v_sites) >= 1
       and (select count(*) from stock_notify_sent n where n.kind = 'weekly' and n.location_id = any(v_sites)
              and n.ref = n.location_id::text || ':' || v_first::text) >= cardinality(v_sites)
       and now() < (v_first + 9)::timestamp then
      select coalesce(jsonb_object_agg(l.id::text, exists (select 1 from stock_counts c where c.location_id = l.id and c.status = 'APPROVED' and c.approved_at is not null
                                                               and public.stock_co__vday(l.id, c.approved_at) >= v_first + 6)), '{}'::jsonb)
        into v_in from locations l where l.id = any(v_sites);
      v_sym := (select case upper(coalesce(nullif(l.currency, ''), 'GBP')) when 'GBP' then chr(163) when 'USD' then '$' when 'EUR' then chr(8364)
                            else upper(l.currency) || ' ' end from locations l where l.id = v_sites[1]);
      insert into stock_notify_sent (org_id, location_id, kind, ref, payload)
      values (o.org_id, null, 'weekly', o.org_id::text || ':' || v_first::text,
              jsonb_build_object('kind', 'weekly', 'week_start', v_first, 'week_end', v_first + 6, 'org_id', o.org_id, 'site_ids', to_jsonb(v_sites),
                                 'count_in', v_in, 'currency_symbol', v_sym,
                                 'title', 'Weekly stock: week of ' || to_char(v_first, 'FMDD Mon')))
      on conflict do nothing;
      get diagnostics v_k = row_count;
      v_n := v_n + v_k;
    end if;
  end loop;
  return v_n;
exception when others then
  raise warning 'stock weekly email staging: %', sqlerrm;
  return 0;
end
$fn$;

-- stock_notify_due: the weekly rows staged first, then the Drop 3 body (every other kind, the purge and
-- the post to stock-notify when anything waits). pg_cron runs it as the owner every minute.
create or replace function public.stock_notify_due()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if not pg_try_advisory_xact_lock(hashtext('stock_notify_due')) then
    return null;
  end if;
  perform set_config('lock_timeout', '200ms', true);
  perform public.stock_co__weekly_stage();
  return public.stock_co__notify_due_d3();
end
$fn$;

-- Who may be emailed a stock alert (map 4.23): one valid address that belongs to a person. Never the
-- HubRise integration login, a system or test login, or an address that cannot be real: hubrise.com
-- and its subdomains, example.com, example.org, example.net, a domain ending .test, .invalid, .local
-- or .example, and noreply or do-not-reply local parts. The JS twin is stockNotifyRules.notifyEmailOk.
create or replace function public.stock_co__notify_email_ok(p_email text)
returns boolean
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
           lower(btrim(p_email)) ~ '^[a-z0-9._%+''-]+@[a-z0-9.-]+[.][a-z]{2,}$'
           and not (split_part(lower(btrim(p_email)), '@', 2) ~ '(^|[.])hubrise[.]com$')
           and not (split_part(lower(btrim(p_email)), '@', 2) ~ '(^|[.])example[.](com|org|net)$')
           and not (split_part(lower(btrim(p_email)), '@', 2) ~ '[.](test|invalid|local|example)$')
           and not (split_part(lower(btrim(p_email)), '@', 1) ~ '^(no-?reply|do-?not-?reply)$'),
         false);
$fn$;

-- stock_notify_targets: who gets one staged alert.
--   weekly, the company row: the owners and the Stock control 'all' logins of the company (people only).
--   weekly, a site row: the logins linked to that site whose Back Office sections let them open Stock and
--     GP (no sections set, or inventory, produce or purchasing), and who are not on the company row, so an
--     owner of six sites gets one email, never seven. Email only, no bell.
--   every other kind: the Drop 3 body, then the same person rule: an address that is not a person's is
--     taken off (email off), and someone left with neither an email nor a mobile is not told at all.
create or replace function public.stock_notify_targets(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v stock_notify_sent;
  v_d3 jsonb;
begin
  if not public.stock_co__is_service() then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v from stock_notify_sent n where n.id = p_id;
  if v.id is null or v.kind is distinct from 'weekly' then
    v_d3 := public.stock_co__notify_targets_d3(p_id);
    if v_d3 is null or jsonb_typeof(v_d3 -> 'people') <> 'array' then
      return v_d3;
    end if;
    return v_d3 || jsonb_build_object('people', coalesce((
      select jsonb_agg(case when public.stock_co__notify_email_ok(x ->> 'email') then x
                            else x || jsonb_build_object('email', null, 'email_on', false) end order by o)
        from jsonb_array_elements(v_d3 -> 'people') with ordinality as z(x, o)
       where public.stock_co__notify_email_ok(x ->> 'email') or nullif(btrim(coalesce(x ->> 'mobile', '')), '') is not null), '[]'::jsonb));
  end if;
  return jsonb_build_object(
    'bell', '[]'::jsonb,
    'people', coalesce((select jsonb_agg(jsonb_build_object('user_id', p.id, 'name', coalesce(nullif(btrim(p.full_name), ''), p.email),
                                                            'email', p.addr, 'mobile', null, 'sms', false, 'email_on', true)
                                         order by p.id)
                          from (select up.id, up.full_name, up.email, coalesce(w.email, up.email) as addr
                                  from user_profiles up
                                  left join lateral (select ws.email from wf_staff ws where ws.pos_user_id = up.id
                                                      order by (ws.status = 'active') desc, ws.created_at limit 1) w on true
                                 where (v.location_id is null and up.org_id = v.org_id and (up.role = 'owner' or up.stock_control = 'all'))
                                    or (v.location_id is not null
                                        and up.id in (select ul.user_id from user_locations ul where ul.location_id = v.location_id)
                                        and not coalesce(up.org_id = v.org_id and (up.role = 'owner' or up.stock_control = 'all'), false)
                                        and (up.bo_sections is null or up.bo_sections && array['inventory', 'produce', 'purchasing']::text[]))
                                 order by up.id limit 50) p
                         where public.stock_co__notify_email_ok(p.addr)), '[]'::jsonb));
end
$fn$;

-- ============================================================================
-- STEP 9. GRANTS: every function this file made or renamed revoked from every API role by exact
-- signature, then exactly these grants.
-- ============================================================================
-- the renamed bodies are internals now
revoke all on function public.stock_rp__league_4a(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__dashboard_4a(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__attention_4a(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__value_4a(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__purchases_4a(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__prices_4a(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__notify_due_d3() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__notify_targets_d3(bigint) from public, anon, authenticated, service_role;
-- the new helpers
revoke all on function public.stock_rp__snapshot(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__legal_of(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__in_transit(uuid[], date) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__kitchen_margin(uuid[], date) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__budget(uuid, date, date, boolean) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__grni(uuid[], date) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__credits_out(uuid[], date) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__recharges(uuid[], date, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__budget_merge(uuid, jsonb, jsonb, date, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__count_merge(uuid, jsonb, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__purchase_extra(uuid[], date, date, boolean) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__credit_figures(uuid[], date, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__notes_4b(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__oc_lines(uuid[], date, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__margin_same_legal(uuid, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__weekly_stage() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__notify_email_ok(text) from public, anon, authenticated, service_role;
-- the public names
revoke all on function public.stock_report_league(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_dashboard(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_attention(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_value(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_purchases(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_prices(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_off_contract(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_budget(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_transfers(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_count_compliance(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_month_end(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_export_start(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_month_end_journal(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_month_end_journal_record(uuid, date, date, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_month_end_journal_claim(uuid, date, date, text, uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_lock_period(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_notify_due() from public, anon, authenticated, service_role;
revoke all on function public.stock_notify_targets(bigint) from public, anon, authenticated, service_role;

-- signed in Back Office logins (the report guard and the saves' own checks decide the rest)
grant execute on function public.stock_report_league(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated, service_role;
grant execute on function public.stock_report_dashboard(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated, service_role;
grant execute on function public.stock_report_attention(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_value(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_purchases(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_prices(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_off_contract(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_budget(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_transfers(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_count_compliance(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_month_end(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_export_start(text, jsonb) to authenticated;
grant execute on function public.stock_lock_period(uuid, date, date) to authenticated;
-- the month end journal: head office (its own check) and the xero-stock-journal edge function
grant execute on function public.stock_month_end_journal(uuid, date, date) to authenticated, service_role;
grant execute on function public.stock_month_end_journal_record(uuid, date, date, text, jsonb) to service_role;
grant execute on function public.stock_month_end_journal_claim(uuid, date, date, text, uuid, text) to service_role;
-- the stock-notify edge function
grant execute on function public.stock_notify_targets(bigint) to service_role;
-- nobody but postgres (pg_cron): stock_notify_due, stock_co__weekly_stage, stock_co__notify_due_d3

-- ============================================================================
-- STEP 10. ASSERTS (raise, nothing changed)
-- ============================================================================
do $asserts_4b$
declare
  v_bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by p.proname) into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and (p.proname ~ '^stock_rp__' or p.proname ~ '^stock_report_' or p.proname ~ '^stock_month_end_'
          or p.proname in ('stock_co__weekly_stage', 'stock_co__notify_email_ok', 'stock_co__notify_due_d3', 'stock_co__notify_targets_d3', 'stock_notify_due', 'stock_notify_targets', 'stock_lock_period'))
     and has_function_privilege('anon', p.oid, 'execute');
  if v_bad is not null then
    raise exception 'The anon key can run a stock report function (%). Nothing was changed. Send this line to Claude.', v_bad;
  end if;
  select string_agg(p.oid::regprocedure::text, ', ' order by p.proname) into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and (p.proname ~ '^stock_rp__' or p.proname in ('stock_co__weekly_stage', 'stock_co__notify_email_ok', 'stock_co__notify_due_d3', 'stock_co__notify_targets_d3', 'stock_notify_due'))
     and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('service_role', p.oid, 'execute'));
  if v_bad is not null then
    raise exception 'An API login can run a stock internal (%). Nothing was changed. Send this line to Claude.', v_bad;
  end if;
  if has_function_privilege('authenticated', 'public.stock_month_end_journal_record(uuid,date,date,text,jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.stock_month_end_journal_claim(uuid,date,date,text,uuid,text)', 'execute') then
    raise exception 'A signed in login can record a Xero journal. Nothing was changed. Send this line to Claude.';
  end if;
  if exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = 'stock_month_end_journals'
              and p.policyname <> 'second_step_fence' and p.cmd <> 'SELECT') then
    raise exception 'stock_month_end_journals has a write policy. Nothing was changed. Send this line to Claude.';
  end if;
  -- THE STORAGE LESSON (23 Oct): no policy on storage.objects or a public table may call a function that
  -- a role it applies to cannot run (Postgres checks it for every row of that command, so one such
  -- policy breaks every upload in every bucket). Roles that cannot use the command at all are skipped.
  with pol as (
    select n.nspname, c.relname, c.oid as rel, p.polname, p.polcmd, p.polroles,
           coalesce(p.polqual::text, '') || ' ' || coalesce(p.polwithcheck::text, '') as tree
      from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public', 'storage')
  ),
  calls as (select pol.*, (m[1])::oid as fn from pol cross join lateral regexp_matches(pol.tree, ':funcid (\d+)', 'g') as m),
  roles as (
    select calls.*, r.rolname
      from calls
     cross join lateral (select x.rolname from pg_roles x where x.oid = any(calls.polroles) and x.rolname in ('anon', 'authenticated')
                         union select 'anon' where 0::oid = any(calls.polroles)
                         union select 'authenticated' where 0::oid = any(calls.polroles)) r
  )
  select string_agg(distinct roles.nspname || '.' || roles.relname || ' ' || roles.polname || ' (' || roles.rolname || ': ' || roles.fn::regprocedure::text || ')', '; ')
    into v_bad
    from roles
   where not has_function_privilege(roles.rolname, roles.fn, 'execute')
     and ((roles.polcmd in ('r', '*') and has_table_privilege(roles.rolname, roles.rel, 'select'))
          or (roles.polcmd in ('a', '*') and has_table_privilege(roles.rolname, roles.rel, 'insert'))
          or (roles.polcmd in ('w', '*') and has_table_privilege(roles.rolname, roles.rel, 'update'))
          or (roles.polcmd in ('d', '*') and has_table_privilege(roles.rolname, roles.rel, 'delete')));
  if v_bad is not null then
    raise exception 'A table rule calls a function its logins cannot run: %. Nothing was changed. Send this line to Claude.', left(v_bad, 600);
  end if;
end
$asserts_4b$;

notify pgrst, 'reload schema';

-- ============================================================================
-- STEP 11. NOTHING AT THE SITES OR LOGINS MOVED (any difference undoes everything)
-- ============================================================================
insert into _stock_native4b_now (location_id, metric, value) select * from _stock_native4b_metrics;
insert into _stock_native4b_now (location_id, metric, value, txt)
values ('00000000-0000-0000-0000-000000000000', 'md5:user_profiles', 0,
        (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.user_profiles t)),
       ('00000000-0000-0000-0000-000000000000', 'md5:user_locations', 0,
        (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.user_locations t));

do $compare_4b$
declare
  v_bad text;
begin
  select string_agg(coalesce(b.metric, a.metric) || ' at ' || coalesce(b.location_id, a.location_id)::text, ', ')
    into v_bad
    from _stock_native4b_snap b
    full join _stock_native4b_now a on a.location_id = b.location_id and a.metric = b.metric
   where a.metric is null or b.metric is null or a.value is distinct from b.value or a.txt is distinct from b.txt;
  if v_bad is not null then
    raise exception 'Drop 4b changed a site row or a login (%). Nothing was changed. Send this line to Claude.', left(v_bad, 600);
  end if;
end
$compare_4b$;

-- ============================================================================
-- STEP 12. THE TIMED CALLS (per multi site company, the last 31 days, as the service role for the call
-- only): the dashboard and the month end pack of last month. Skipped for a one site company.
-- ============================================================================
create temp table _stock_native4b_timed (org_id uuid, dashboard_ms text, month_end_ms text, league_rows integer, legal_rows integer, budget_ok boolean) on commit drop;

do $timed_4b$
declare
  v_org   record;
  v_sites uuid[];
  v_t0    timestamptz;
  v_t1    timestamptz;
  v_d     jsonb;
  v_m     jsonb;
  v_from  date := (date_trunc('month', current_date) - interval '1 month')::date;
  v_to    date := (date_trunc('month', current_date) - interval '1 day')::date;
begin
  for v_org in
    select distinct l.org_id
      from public.locations l
     where l.org_id is not null and exists (select 1 from public.inventory_items i where i.location_id = l.id)
     order by l.org_id
  loop
    v_sites := array(select l.id from public.locations l where l.org_id = v_org.org_id and coalesce(l.status, 'active') = 'active' order by l.name, l.id limit 50);
    if cardinality(v_sites) < 2 then
      insert into _stock_native4b_timed values (v_org.org_id, 'skipped', 'skipped', cardinality(v_sites), null, null);
      continue;
    end if;
    perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
    v_t0 := clock_timestamp();
    v_d := public.stock_report_dashboard(v_org.org_id, v_sites, current_date - 30, current_date, null, null, 1000);
    v_t1 := clock_timestamp();
    v_m := public.stock_report_month_end(v_org.org_id, v_sites, v_from, v_to, jsonb_build_object('level', 'legal'), null, 1000);
    insert into _stock_native4b_timed
    values (v_org.org_id, round(extract(epoch from v_t1 - v_t0) * 1000)::text, round(extract(epoch from clock_timestamp() - v_t1) * 1000)::text,
            coalesce(jsonb_array_length(v_d -> 'rows' -> 'league'), 0), coalesce(jsonb_array_length(v_m -> 'rows'), 0),
            not exists (select 1 from jsonb_array_elements(v_d -> 'totals') t where not (t ? 'budget_spent')));
    perform set_config('request.jwt.claims', '', true);
  end loop;
end
$timed_4b$;

-- ============================================================================
-- VISIBLE CHECK (the SQL editor shows this last result; paste it back to Claude). One row per company
-- that holds stock. Expected live: a59a6d97 multi true, dashboard_ms and month_end_ms under 5000,
-- budget_ok true, legal_rows 2; fcbddcfd multi false, 'skipped' (league_rows 1, legal_rows and budget_ok
-- empty). Every row: bodies_moved 11, renamed_kept 8, new_functions 24, new_tables 1, weekly_kind true,
-- internals_open_to_api false, anon_can_read_reports false, table_rules_ok true,
-- storage_upload_ok true, backup_rows 12, site_rows_changed 0, logins_changed false.
-- ============================================================================
select o.org_id,
       (select count(*) filter (where coalesce(l.status, 'active') = 'active') >= 2
               or exists (select 1 from public.stock_co_settings cs where cs.org_id = o.org_id and cs.multi_since is not null)
          from public.locations l where l.org_id = o.org_id) as multi,
       (select count(*)::integer from public.stock_native_backup b
         where left(b.name, 3) = '4b:' and b.name <> '4b:check:stock_notify_sent_kind_check'
           and exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = substr(b.name, 4)
                        and md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) <> b.md5)) as bodies_moved,
       (select count(*)::integer from (values
          ('stock_report_league', 'public.stock_rp__league_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
          ('stock_report_dashboard', 'public.stock_rp__dashboard_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
          ('stock_report_attention', 'public.stock_rp__attention_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
          ('stock_report_value', 'public.stock_rp__value_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
          ('stock_report_purchases', 'public.stock_rp__purchases_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
          ('stock_report_prices', 'public.stock_rp__prices_4a(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
          ('stock_notify_due', 'public.stock_co__notify_due_d3()'),
          ('stock_notify_targets', 'public.stock_co__notify_targets_d3(bigint)')) f(name, sig)
          join pg_proc p on p.oid = to_regprocedure(f.sig)
          join public.stock_native_backup b on b.name = '4b:' || f.name
         where md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = b.md5) as renamed_kept,
       (select count(*)::integer from (values
          ('public.stock_report_off_contract(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_report_budget(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
          ('public.stock_report_transfers(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_report_count_compliance(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
          ('public.stock_report_month_end(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_month_end_journal(uuid,date,date)'),
          ('public.stock_month_end_journal_record(uuid,date,date,text,jsonb)'), ('public.stock_rp__legal_of(uuid)'), ('public.stock_rp__in_transit(uuid[],date)'),
          ('public.stock_rp__kitchen_margin(uuid[],date)'), ('public.stock_rp__budget(uuid,date,date,boolean)'), ('public.stock_rp__grni(uuid[],date)'),
          ('public.stock_rp__credits_out(uuid[],date)'), ('public.stock_rp__recharges(uuid[],date,date)'), ('public.stock_rp__budget_merge(uuid,jsonb,jsonb,date,date)'),
          ('public.stock_rp__count_merge(uuid,jsonb,date)'), ('public.stock_rp__purchase_extra(uuid[],date,date,boolean)'),
          ('public.stock_rp__credit_figures(uuid[],date,date)'), ('public.stock_rp__notes_4b(jsonb)'), ('public.stock_rp__oc_lines(uuid[],date,date)'),
          ('public.stock_rp__margin_same_legal(uuid,date)'), ('public.stock_co__weekly_stage()'), ('public.stock_co__notify_email_ok(text)'),
          ('public.stock_month_end_journal_claim(uuid,date,date,text,uuid,text)')) f(sig)
         where to_regprocedure(f.sig) is not null) as new_functions,
       (case when to_regclass('public.stock_month_end_journals') is not null then 1 else 0 end) as new_tables,
       exists (select 1 from pg_constraint c where c.conrelid = 'public.stock_notify_sent'::regclass and c.conname = 'stock_notify_sent_kind_check'
                and pg_get_constraintdef(c.oid) like '%weekly%') as weekly_kind,
       exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace
                  and (p.proname ~ '^stock_rp__' or p.proname in ('stock_co__weekly_stage', 'stock_co__notify_email_ok', 'stock_co__notify_due_d3', 'stock_co__notify_targets_d3', 'stock_notify_due'))
                  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                       or has_function_privilege('service_role', p.oid, 'execute'))) as internals_open_to_api,
       exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace and (p.proname ~ '^stock_report_' or p.proname ~ '^stock_month_end_')
                  and has_function_privilege('anon', p.oid, 'execute')) as anon_can_read_reports,
       true as table_rules_ok,
       (exists (select 1 from pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = 'stock_invoice_inbox_files_add'
                 and p.with_check ~ 'stock_invoice_inbox_upload_ok')
        and has_function_privilege('authenticated', 'public.stock_invoice_inbox_upload_ok(text)', 'execute')
        and has_function_privilege('anon', 'public.stock_invoice_inbox_upload_ok(text)', 'execute') = false
        and public.stock_invoice_inbox_upload_ok('org/' || o.org_id::text || '/check.pdf') = false) as storage_upload_ok,
       (select count(*)::integer from public.stock_native_backup b where left(b.name, 3) = '4b:') as backup_rows,
       (select t.dashboard_ms from _stock_native4b_timed t where t.org_id = o.org_id) as dashboard_ms,
       (select t.month_end_ms from _stock_native4b_timed t where t.org_id = o.org_id) as month_end_ms,
       (select t.league_rows from _stock_native4b_timed t where t.org_id = o.org_id) as league_rows,
       (select t.legal_rows from _stock_native4b_timed t where t.org_id = o.org_id) as legal_rows,
       (select t.budget_ok from _stock_native4b_timed t where t.org_id = o.org_id) as budget_ok,
       (select count(*)::integer from _stock_native4b_snap b join _stock_native4b_now a on a.location_id = b.location_id and a.metric = b.metric
         where (a.value is distinct from b.value or a.txt is distinct from b.txt) and b.metric not like 'md5:%') as site_rows_changed,
       exists (select 1 from _stock_native4b_snap b join _stock_native4b_now a on a.location_id = b.location_id and a.metric = b.metric
                where b.metric like 'md5:%' and a.txt is distinct from b.txt) as logins_changed
  from (select distinct l.org_id from public.locations l
         where l.org_id is not null and exists (select 1 from public.inventory_items i where i.location_id = l.id)) o
 order by o.org_id;
