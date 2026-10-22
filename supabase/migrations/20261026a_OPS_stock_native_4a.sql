-- 20261026a_OPS_stock_native_4a.sql
-- Multi site stock, Drop 4a: head office reports, first half (map 8.5 items 1 to 4).
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  NEEDS 20261021a_OPS_stock_native_0a.sql, its revalue file,               #
-- #  20261022a_OPS_stock_native_0b.sql, 20261024a_OPS_stock_native_1.sql AND  #
-- #  20261023a_OPS_stock_drainer_v2.sql live first (the guard refuses         #
-- #  otherwise). One transaction: any error and nothing changes.              #
-- #  Run after UK close. NEVER on 25 Oct 2026 (UK clocks) or 1 Nov 2026       #
-- #  (US clocks). Lock wait 3 s (it gives up, nothing changes).               #
-- ############################################################################
--
-- WHAT IT IS
--   Back Office > Reports > Stock and GP reads through the functions made here: the head office
--   dashboard, the site league, the needs attention list and 13 reports (stock value, stock movement,
--   the gap, cost of sales and GP, product GP, waste, purchases, price paid, days on hand, par and
--   availability, key item ratios, setup health, batches). Every figure is read from the stored day
--   totals the drainer release keeps up (stock_day_sums, sales_day_sums), each venue on its own
--   business day (venue_clock), at most 1,000 rows a call, keyset paged, site totals first, never two
--   currencies added together, demo history left out. Targets (red, amber, green) and key items are
--   saved here too. Exports of any size run through report_export_jobs, pg_cron report-export-run and
--   the report-export edge function into the private bucket report-exports.
--
-- WHAT IT NEVER DOES
--   It writes no site row (stock items, the ledger, counts, suppliers) and no login (user_profiles,
--   user_locations). It replaces no function an earlier file made and backs nothing up: it only
--   checks that the nine bodies it reads are still the text it was written against. Before the check
--   row it compares every count and sum of the site rows per venue with the snapshot it took at the
--   start, and stops (undoing everything) on any difference. It needs nothing of Drop 2 (recipes)
--   or Drop 3 (purchasing) and never names their tables.
--
-- HOW IT RUNS
--   Paste the whole file into the SQL editor and run it once (one paste is one transaction; no begin
--   or commit in here). The first statement is the guard. Then:
--     set local lock_timeout = '3s';  set local statement_timeout = '300s';
--   It checks the nine bodies by md5, takes the snapshot, makes the three tables, the vault key, the
--   cron job, the bucket and its policy, the report guard and its helpers, the sixteen report
--   functions, the saves and the export functions, queues the sales history backfill (15 venue days a
--   minute, newest first), grants, asserts, compares, times the dashboard, and shows the check row
--   last. Paste it back.
--
-- IF IT STOPS
--   Any error means nothing changed. A lock wait or 'deadlock detected': run it again a quiet minute
--   later. Any other words: send them to Claude.
--
-- ROLLBACK
--   20261026a_OPS_stock_native_4a_ROLLBACK.sql (drops everything this file made and nothing else).

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This is not the Ops database (tbetcegmszzotrwdtqhi). Nothing was changed.';
  end if;
  if to_regclass('public.stock_native_backup') is null or to_regclass('public.stock_co_items') is null
     or to_regclass('public.stock_co_settings') is null or to_regclass('public.stock_day_sums') is null
     or to_regclass('public.sales_day_sums') is null or to_regclass('public.venue_clock') is null
     or to_regclass('public.stock_periods') is null or to_regclass('public.stock_period_snapshots') is null then
    raise exception 'Run 20261021a_OPS_stock_native_0a.sql first. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger g where not g.tgisinternal and g.tgname = 'stock_co_lock_upd') then
    raise exception 'Run 20261022a_OPS_stock_native_0b.sql first. Nothing was changed.';
  end if;
  if to_regclass('public.stock_order_rules') is null
     or not exists (select 1 from information_schema.columns c
                     where c.table_schema = 'public' and c.table_name = 'stock_co_items' and c.column_name = 'category_id') then
    raise exception 'Run 20261024a_OPS_stock_native_1.sql first. Nothing was changed.';
  end if;
  if to_regclass('public.stock_sale_takes') is null
     or not exists (select 1 from information_schema.columns c
                     where c.table_schema = 'public' and c.table_name = 'stock_day_sums' and c.column_name = 'demo')
     or not exists (select 1 from pg_trigger g where not g.tgisinternal and g.tgname = 'stock_movements_day_sums_ins') then
    raise exception 'Run 20261023a_OPS_stock_drainer_v2.sql first. Nothing was changed.';
  end if;
  if to_regclass('public.stock_targets') is not null or to_regprocedure('public.report_export_cron_ok(text)') is not null then
    raise exception 'Drop 4a has run already. Nothing was changed.';
  end if;
  if to_regclass('vault.decrypted_secrets') is null or to_regprocedure('vault.create_secret(text,text,text,uuid)') is null then
    raise exception 'The database vault is not there (vault.create_secret). Nothing was changed.';
  end if;
  if to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    raise exception 'pg_net is not there (net.http_post). Nothing was changed.';
  end if;
  if to_regprocedure('cron.schedule(text,text,text)') is null or to_regprocedure('cron.unschedule(bigint)') is null then
    raise exception 'pg_cron is not there (cron.schedule). Nothing was changed.';
  end if;
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise exception 'Storage is not there. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '300s';

-- ============================================================================
-- STEP 0. THE BODIES THIS FILE READS, STILL AS BUILT (check only: nothing is replaced or backed up)
-- ============================================================================
-- The house rule: md5 of the function source with every run of white space made one space. The five
-- 0a bodies are the live text of 20 Oct 2026; the three drainer bodies are the text 20261023a leaves
-- live; stock_site_scope is 0a's. The report functions below call these and never copy them.
do $bodies$
declare
  v_bad text;
begin
  select string_agg(e.sig, ', ' order by e.sig) into v_bad
    from (values
      ('public.stock_level(uuid,uuid)', '4287c82be293ef0b2724ee206d71eecc'),
      ('public.stock_reach_locations()', '6805857cee1a521eebe68a9dc3d8fa3e'),
      ('public.stock_co__venue_day(uuid,timestamptz)', '8c9513db8ec56ddb68a1a3f247360742'),
      ('public.stock_co__clock_of(uuid)', '605fce03d4e44064df5cf3b03ecd0350'),
      ('public.stock_co__day_start_at(date,time,text)', '2cb462264587615075225d05a84cd051'),
      ('public._stock_day_sums_apply()', 'ccf9db2e33be2e998bcc540186cca0f9'),
      ('public.stock_day_sums_rebuild(uuid,date,date)', '7f8ccfae7dbe7826623e60dab4f84bcb'),
      ('public.sales_day_sums_rebuild(uuid,date,date)', '007c100176c9438b35c6531916555a79'),
      ('public.stock_site_scope(uuid)', 'e0b54f5aaea4f330e2300248b721141d')
    ) as e(sig, want)
    left join pg_proc p on p.oid = to_regprocedure(e.sig)
   where p.oid is null
      or md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) is distinct from e.want;
  if v_bad is not null then
    raise exception 'A stock function changed since this file was written. Ask Claude for a new file. Changed: %. Nothing was changed.', v_bad;
  end if;
end
$bodies$;

-- ============================================================================
-- STEP 1. THE SNAPSHOT: every count and sum this file must leave alone, per venue, and the logins
-- ============================================================================
create temp table _stock_native4a_snap (
  location_id  uuid,
  metric       text,
  value        numeric,
  txt          text
) on commit drop;

do $snap$
begin
  insert into _stock_native4a_snap (location_id, metric, value)
  select l.id, m.metric, m.value
    from public.locations l
   cross join lateral (values
     ('n:inventory_items',   (select count(*) from public.inventory_items x where x.location_id = l.id)::numeric),
     ('n:stock_movements',   (select count(*) from public.stock_movements x where x.location_id = l.id)::numeric),
     ('n:stock_counts',      (select count(*) from public.stock_counts x where x.location_id = l.id)::numeric),
     ('n:suppliers',         (select count(*) from public.suppliers x where x.location_id = l.id)::numeric),
     ('n:recipes',           (select count(*) from public.recipes x where x.location_id = l.id)::numeric),
     ('n:waste_events',      (select count(*) from public.waste_events x where x.location_id = l.id)::numeric),
     ('n:stock_day_sums',    (select count(*) from public.stock_day_sums x where x.location_id = l.id)::numeric),
     ('n:sales_day_sums',    (select count(*) from public.sales_day_sums x where x.location_id = l.id)::numeric),
     ('s:on_hand',           (select sum(x.on_hand) from public.inventory_items x where x.location_id = l.id)),
     ('s:current_cost',      (select sum(x.current_cost) from public.inventory_items x where x.location_id = l.id)),
     ('s:books',             (select sum(x.on_hand * x.current_cost) from public.inventory_items x where x.location_id = l.id)),
     ('s:mv_qty',            (select sum(x.qty_base) from public.stock_movements x where x.location_id = l.id)),
     ('s:mv_value',          (select sum(x.value_delta) from public.stock_movements x where x.location_id = l.id)),
     ('s:day_qty',           (select sum(x.qty_base) from public.stock_day_sums x where x.location_id = l.id)),
     ('s:day_value',         (select sum(x.value) from public.stock_day_sums x where x.location_id = l.id)),
     ('s:sales_net',         (select sum(x.net) from public.sales_day_sums x where x.location_id = l.id))
   ) as m(metric, value)
   where exists (select 1 from public.inventory_items i where i.location_id = l.id);
  insert into _stock_native4a_snap (location_id, metric, value, txt)
  values ('00000000-0000-0000-0000-000000000000', 'md5:user_profiles', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.user_profiles t)),
         ('00000000-0000-0000-0000-000000000000', 'md5:user_locations', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.user_locations t));
end
$snap$;

-- ============================================================================
-- STEP 2. THE TABLES (RLS on, revoked from every API role first, a restrictive second step fence,
-- no write policy, select only where listed)
-- ============================================================================

-- Targets: the red, amber, green lines per metric. location_id null is the company row; a site row
-- overrides it. green_to is the better side: for gp_pct green is at or above it, for every other
-- metric green is at or below it.
create table public.stock_targets (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.organisations(id) on delete cascade,
  location_id  uuid references public.locations(id),
  metric       text not null check (metric in ('gp_pct', 'gap_pct', 'waste_pct', 'comps_pct', 'days_on_hand', 'budget_pct', 'no_recipe_pct')),
  green_to     numeric not null,
  amber_to     numeric not null,
  row_version  integer not null default 1,
  updated_at   timestamptz not null default now(),
  updated_by   uuid,
  constraint stock_targets_order check ((metric = 'gp_pct' and green_to >= amber_to) or (metric <> 'gp_pct' and green_to <= amber_to))
);
create unique index stock_targets_one on public.stock_targets (org_id, location_id, metric) nulls not distinct;
comment on table public.stock_targets is
  'Head office report targets (20261026a, multi site stock Drop 4a): one row per company (location_id null) or per site and metric, with the green and amber lines. Read by stock_rp__rag for every coloured cell; written by stock_save_targets only (company editors). No row is seeded: the built in defaults apply until one is saved.';

-- Key item ratios: the dashboard tiles (milk per milk drink, beans per shot, cups against cup drinks).
create table public.stock_key_ratios (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references public.organisations(id) on delete cascade,
  name           text not null check (btrim(name) <> ''),
  used_item_id   uuid not null references public.stock_co_items(id),
  used_unit      text not null,
  sold_rule      jsonb not null default '{}'::jsonb,
  recipe_amount  numeric,
  sort_order     integer not null default 0,
  archived_at    timestamptz,
  row_version    integer not null default 1,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  updated_by     uuid
);
create index stock_key_ratios_org on public.stock_key_ratios (org_id) where archived_at is null;
comment on table public.stock_key_ratios is
  'Key item ratios (20261026a, multi site stock Drop 4a): a company item used against the products sold (sold_rule: a category by accounting group, chosen products, or every sale), with what the recipe says one sold unit uses. At most 20 live rows a company. Written by stock_save_key_ratios only; read by stock_report_key_ratios and the dashboard tiles.';

-- Export jobs: a report bigger than 1,000 rows built in the background into part files.
create table public.report_export_jobs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  user_id      uuid not null,
  report       text not null,
  args         jsonb not null,
  columns      jsonb not null default '[]'::jsonb,
  status       text not null default 'waiting' check (status in ('waiting', 'running', 'done', 'failed', 'cancelled', 'expired')),
  cursor       jsonb,
  pages        integer not null default 0,
  parts        integer not null default 0,
  rows         integer not null default 0,
  file_prefix  text,
  error        text,
  attempts     integer not null default 0,
  created_at   timestamptz not null default now(),
  started_at   timestamptz,
  done_at      timestamptz,
  expires_at   timestamptz,
  claimed_at   timestamptz
);
create index report_export_jobs_open on public.report_export_jobs (created_at) where status in ('waiting', 'running');
create index report_export_jobs_user on public.report_export_jobs (user_id, created_at desc);
comment on table public.report_export_jobs is
  'Report export jobs (20261026a, multi site stock Drop 4a): one row per export a login asked for (the report name and the exact call in args). pg_cron report-export-run wakes the report-export edge function every minute; it claims jobs with the service role, reads pages as the job''s login (reach checked again at run time), writes part files under <org>/<user>/<job>/ in the private bucket report-exports, and marks the job done, failed or cancelled. A login reads its own jobs only. Files are kept 7 days.';

alter table public.stock_targets enable row level security;
alter table public.stock_key_ratios enable row level security;
alter table public.report_export_jobs enable row level security;
revoke all on table public.stock_targets from public, anon, authenticated, service_role;
revoke all on table public.stock_key_ratios from public, anon, authenticated, service_role;
revoke all on table public.report_export_jobs from public, anon, authenticated, service_role;
grant select on table public.stock_targets to authenticated, service_role;
grant select on table public.stock_key_ratios to authenticated;
grant select on table public.report_export_jobs to authenticated, service_role;

create policy stock_targets_read on public.stock_targets as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));
create policy stock_key_ratios_read on public.stock_key_ratios as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));
create policy report_export_jobs_read on public.report_export_jobs as permissive for select to authenticated
  using (user_id = auth.uid() and not public.is_anon_session());

-- The second sign in step on every new table (the 0a pattern), skipped only where that function is
-- not there (it is live).
do $fence_4a$
declare
  t text;
begin
  if to_regprocedure('public.second_step_ok()') is null then
    return;
  end if;
  foreach t in array array['stock_targets', 'stock_key_ratios', 'report_export_jobs'] loop
    if not exists (select 1 from pg_policy p where p.polrelid = format('public.%I', t)::regclass and p.polname = 'second_step_fence') then
      execute format('create policy second_step_fence on public.%I as restrictive for all to authenticated
                        using ((select public.second_step_ok())) with check ((select public.second_step_ok()))', t);
    end if;
  end loop;
end
$fence_4a$;

-- The reads of the day totals the reports make: the live primary keys carry (location_id,
-- business_day, ...); these two serve a site's window from the index alone (measured in the harness
-- at 50 sites by 31 days), and the third finds a demo flag at a site without reading its history.
-- The fourth finds the checks the demo files wrote (ids 'demo-'): sales_day_sums has no demo flag
-- (the drainer's rebuild is pinned above), so a site window holding a demo check has its sales and
-- every GP figure left out (shown as not known, with the words), never counted. It holds only the
-- demo checks (12,643 live on 21 Oct), so a till closing a check never writes to it.
create index stock_day_sums_rp on public.stock_day_sums (location_id, business_day)
  include (inventory_item_id, movement_type, value, qty_base) where demo = false;
create index sales_day_sums_rp on public.sales_day_sums (location_id, business_day)
  include (menu_item_id, net, gross, qty, theo_cost, loyalty_cost, staff_cost, comp_cost, loyalty_qty, staff_qty, comp_qty);
create index stock_day_sums_demo on public.stock_day_sums (location_id) where demo = true;
create index closed_checks_demo_rp on public.closed_checks (location_id, closed_at) where id like 'demo-%';

-- ============================================================================
-- STEP 3. THE VAULT KEY, THE CRON JOB, THE BUCKET AND ITS POLICY (own objects only)
-- ============================================================================
do $p_key$
begin
  if not exists (select 1 from vault.secrets s where s.name = 'report_export_cron_key') then
    perform vault.create_secret(
      replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
      'report_export_cron_key',
      'pg_cron report-export-run proves itself to the report-export edge function with this (20261026a). Made by the database, never typed.');
  end if;
end
$p_key$;

-- The edge function asks: is this the key? (the stock_nightly_cron_ok body with the new name)
create or replace function public.report_export_cron_ok(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(length(p_key) >= 32 and exists (
    select 1 from vault.decrypted_secrets s
     where s.name = 'report_export_cron_key' and s.decrypted_secret = p_key
  ), false);
$fn$;

-- Every minute (pg_cron, as postgres): post to the edge function only when there is work: a job
-- waiting, a running slice that died (claimed over 3 minutes ago), or a done job whose files have
-- expired. Otherwise nothing is posted and 0 comes back.
create or replace function public.report_export_run_due()
returns bigint
language plpgsql
volatile
security definer
set search_path = ''
as $fn$
declare
  k    text;
  req  bigint;
begin
  if not exists (select 1 from public.report_export_jobs j
                  where j.status = 'waiting'
                     or (j.status = 'running' and j.claimed_at < now() - interval '3 minutes')
                     or (j.status = 'done' and j.expires_at < now())) then
    return 0;
  end if;
  select s.decrypted_secret into k from vault.decrypted_secrets s where s.name = 'report_export_cron_key' limit 1;
  if k is null or length(k) < 32 then
    raise exception 'report_export_run_due: no report_export_cron_key in the vault (run 20261026a again).';
  end if;
  select net.http_post(
    url := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/report-export',
    body := '{"action": "run"}'::jsonb,
    params := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', k),
    timeout_milliseconds := 25000
  ) into req;
  return req;
end
$fn$;

do $p_cron$
declare
  j record;
begin
  for j in select c.jobid from cron.job c where c.jobname = 'report-export-run' loop
    perform cron.unschedule(j.jobid);
  end loop;
  perform cron.schedule('report-export-run', '* * * * *', 'select public.report_export_run_due();');
end
$p_cron$;

-- The private bucket (50 MB a part, CSV and the index JSON only) and the one read policy: a login
-- may read the parts under its own folder (<org>/<user>/<job>/...). No insert, update or delete
-- policy: the edge function writes and deletes with the service role. The second step fence already
-- on storage.objects applies. Never a raw device read function here.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('report-exports', 'report-exports', false, 52428800, array['text/csv', 'application/json'])
on conflict (id) do nothing;

create policy report_exports_owner_read on storage.objects for select to authenticated
  using (bucket_id = 'report-exports' and not public.is_anon_session() and (storage.foldername(name))[2] = auth.uid()::text);

-- ============================================================================
-- STEP 4. THE REPORT GUARD AND THE HELPERS (internal, owner only; the grant block revokes them)
-- ============================================================================

-- A movement key the demo files wrote (map 8.5): left out of every report.
create or replace function public.stock_rp__is_demo(p_key text)
returns boolean
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(left(p_key, 8) = 'demo-v1:' or left(p_key, 7) = 'demo71:' or left(p_key, 5) = 'seed:', false);
$fn$;

create or replace function public.stock_rp__range_ok(p_from date, p_to date)
returns void
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if p_from is null or p_to is null or p_from > p_to or p_to - p_from > 400 then
    raise exception 'Pick a start and end day, start first, up to 400 days.' using errcode = '22023';
  end if;
end
$fn$;

create or replace function public.stock_rp__page_cap(p_limit integer)
returns integer
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select least(greatest(coalesce(p_limit, 1000), 1), 1000);
$fn$;

-- The first day of the week that holds p_day (week_start 0 Sunday to 6 Saturday, null Monday).
create or replace function public.stock_rp__week_of(p_day date, p_week_start smallint)
returns date
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select p_day - ((extract(dow from p_day)::integer - coalesce(p_week_start, 1) + 7) % 7);
$fn$;

-- A percent, null when the base is nothing (never divide by zero: the web shows "No sales").
create or replace function public.stock_rp__pct(p_num numeric, p_den numeric)
returns numeric
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select case when p_den is null or p_den = 0 or p_num is null then null else round(p_num / p_den * 100, 2) end;
$fn$;

-- A keyset sort value: the number rounded to 6 places, so the value a page hands back in next (which
-- the web carries as a JavaScript number) is exactly the value the next page compares with. The
-- order, the filter and next all use it; a tie after rounding is broken by the unique key.
create or replace function public.stock_rp__sk(p_value numeric)
returns numeric
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select round(coalesce(p_value, 0), 6);
$fn$;

-- The movement types in the words the reports use (one place). 'sold' is the sale's own take off
-- (SALE_DEPLETION from closed_check): the stock the plate cost of the products sold is made of, so
-- product GP adds up to site GP (the drainer's nightly check proves the two agree from takes_from).
-- What a refund gives back (an unsale, or a RETURN of sealed goods to the shelf, source
-- closed_check_refund) is 'other': refunded food is booked as waste straight after, never unsold.
create or replace function public.stock_rp__bucket(p_type text, p_source text)
returns text
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select case when p_type in ('SALE_DEPLETION', 'RETURN') then case when p_type = 'SALE_DEPLETION' and p_source = 'closed_check' then 'sold' else 'other' end
         else case p_type
           when 'PURCHASE_RECEIPT' then 'received'
           when 'TRANSFER_IN' then 'transfer_in'
           when 'TRANSFER_OUT' then 'transfer_out'
           when 'PRODUCTION_OUTPUT' then 'made'
           when 'PRODUCTION_CONSUME' then 'used'
           when 'WASTE' then 'waste'
           when 'REVALUE' then 'revalue'
           when 'STOCK_COUNT_ADJ' then 'count_adj'
           when 'OPENING_BALANCE' then 'opening_balance'
           else 'other'
         end end;
$fn$;

-- food, drink or other from the product's menu category accounting group at that site (the Sales
-- mix grouping in SQL words): Food, Cold Food and anything starting food are food; anything starting
-- drink is drink; the rest other.
create or replace function public.stock_rp__type_of(p_site uuid, p_menu_item_id text)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case when lower(g.grp) like 'food%' or lower(g.grp) = 'cold food' then 'food'
              when lower(g.grp) like 'drink%' then 'drink'
              else 'other' end
    from (select coalesce((select c.accounting_group from menu_categories c
                            where c.location_id = p_site::text and c.id = coalesce(mi.cat, mi.cats[1])
                            limit 1), '') as grp
            from (select m.cat, m.cats from menu_items m
                   where m.location_id = p_site::text and m.id = p_menu_item_id
                   union all
                   select null::text, null::text[]
                   limit 1) mi) g;
$fn$;

-- The built in targets (one literal block, pinned by the CI test against src/lib/stock/targetRules.js
-- TARGET_DEFAULTS): the site row of stock_targets, else the company row, else these.
create or replace function public.stock_rp__rag(p_org uuid, p_site uuid, p_metric text, p_value numeric)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_green numeric;
  v_amber numeric;
begin
  if p_value is null or p_metric is null then
    return null;
  end if;
  select t.green_to, t.amber_to into v_green, v_amber
    from stock_targets t
   where t.org_id = p_org and t.metric = p_metric and t.location_id is not distinct from p_site;
  if v_green is null and p_site is not null then
    select t.green_to, t.amber_to into v_green, v_amber
      from stock_targets t
     where t.org_id = p_org and t.metric = p_metric and t.location_id is null;
  end if;
  if v_green is null then
    select d.green_to, d.amber_to into v_green, v_amber
      from (values
        ('gp_pct', 70::numeric, 65::numeric),
        ('gap_pct', 1.8, 2.5),
        ('waste_pct', 2.5, 3.5),
        ('comps_pct', 1.5, 2.5),
        ('days_on_hand', 7, 10),
        ('budget_pct', 100, 105),
        ('no_recipe_pct', 3, 6)
      ) as d(metric, green_to, amber_to)
     where d.metric = p_metric;
  end if;
  if v_green is null then
    return null;
  end if;
  if p_metric = 'gp_pct' then
    return case when p_value >= v_green then 'green' when p_value >= v_amber then 'amber' else 'red' end;
  end if;
  return case when p_value <= v_green then 'green' when p_value <= v_amber then 'amber' else 'red' end;
end
$fn$;

-- A locked period's snapshot for exactly this window at this site, else null.
create or replace function public.stock_rp__snapshot(p_site uuid, p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select s.metrics
    from stock_periods p
    join stock_period_snapshots s on s.period_id = p.id and s.location_id = p.location_id
   where p.location_id = p_site and p.from_day = p_from and p.to_day = p_to
     and p.locked_at is not null and p.unlocked_at is null
   order by p.locked_at desc
   limit 1;
$fn$;

-- True when a locked period at the site overlaps the window without being exactly it (read live).
create or replace function public.stock_rp__part_locked(p_site uuid, p_from date, p_to date)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select exists (select 1 from stock_periods p
                  where p.location_id = p_site and p.locked_at is not null and p.unlocked_at is null
                    and p.from_day <= p_to and p.to_day >= p_from
                    and not (p.from_day = p_from and p.to_day = p_to));
$fn$;

-- The first venue day on which every sale at the site has its takes saved (product theo cost is known
-- from it, and product GP adds up to site GP from it). That is the venue day of the first take, unless
-- a sale was taken off earlier that same day with no takes (the night the drainer release went live,
-- sales before it were taken off by the old rule): then it is the next day. Demo history is left out.
create or replace function public.stock_rp__takes_from(p_site uuid)
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case when exists (
                select 1 from stock_movements m
                 cross join lateral public.stock_co__venue_day(p_site, m.occurred_at) v
                 where m.location_id = p_site and m.movement_type = 'SALE_DEPLETION'
                   and m.occurred_at < x.at and m.occurred_at >= x.at - interval '2 days'
                   and not public.stock_rp__is_demo(m.idempotency_key)
                   and not exists (select 1 from stock_sale_takes t where t.location_id = p_site and t.check_id = m.source_id)
                   and v.business_day = d.business_day)
              then d.business_day + 1 else d.business_day end
    from (select min(t.occurred_at) as at from stock_sale_takes t where t.location_id = p_site) x
   cross join lateral public.stock_co__venue_day(p_site, x.at) d
   where x.at is not null;
$fn$;

-- True when a check the demo files wrote (id 'demo-', not voided) closed on one of the site's venue
-- days p_from to p_to. sales_day_sums keeps no demo flag, so the sales of such a window cannot be
-- told from the demo ones: the reports then show its sales and GP as not known, with the words
-- (never a GP over demo takings with the demo stock left out). The day cut is sales_day_sums'.
create or replace function public.stock_rp__demo_sales(p_site uuid, p_from date, p_to date)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p_site is not null and p_from is not null and p_to is not null
     and exists (select 1
                   from public.stock_co__clock_of(p_site) k
                   join closed_checks c on c.location_id = p_site::text and c.id like 'demo-%'
                    and c.closed_at >= public.stock_co__day_start_at(p_from, k.day_start, k.timezone)
                    and c.closed_at < public.stock_co__day_start_at(p_to + 1, k.day_start, k.timezone)
                  where not (c.voided is true or coalesce(c.status, '') in ('void', 'voided')));
$fn$;

-- One site's window. Dates mode: the days asked for, with the latest approved count at or before
-- the day before the start (counted when it IS that day) and at or before the end (counted when it
-- is the end). Between two counts: the latest approved FULL count at or before the end and the one
-- before it; fewer than two full counts is window_missing (the web says "Needs two full counts").
create or replace function public.stock_rp__window(p_site uuid, p_from date, p_to date, p_between_counts boolean)
returns table(from_day date, to_day date, opening_count_id uuid, closing_count_id uuid, opening_counted boolean, closing_counted boolean,
              opening_day date, closing_day date, window_missing boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_c_id   uuid;
  v_c_day  date;
  v_o_id   uuid;
  v_o_day  date;
begin
  if coalesce(p_between_counts, false) then
    select c.id, d.business_day into v_c_id, v_c_day
      from stock_counts c
     cross join lateral public.stock_co__venue_day(c.location_id, c.approved_at) d
     where c.location_id = p_site and c.status = 'APPROVED' and c.count_type = 'FULL' and c.approved_at is not null
       and d.business_day <= p_to
     order by d.business_day desc, c.approved_at desc
     limit 1;
    if v_c_id is not null then
      select c.id, d.business_day into v_o_id, v_o_day
        from stock_counts c
       cross join lateral public.stock_co__venue_day(c.location_id, c.approved_at) d
       where c.location_id = p_site and c.status = 'APPROVED' and c.count_type = 'FULL' and c.approved_at is not null
         and d.business_day < v_c_day
       order by d.business_day desc, c.approved_at desc
       limit 1;
    end if;
    if v_c_id is null or v_o_id is null then
      return query select null::date, null::date, null::uuid, null::uuid, false, false, null::date, null::date, true;
      return;
    end if;
    return query select (v_o_day + 1)::date, v_c_day, v_o_id, v_c_id, true, true, v_o_day, v_c_day, false;
    return;
  end if;
  select c.id, d.business_day into v_o_id, v_o_day
    from stock_counts c
   cross join lateral public.stock_co__venue_day(c.location_id, c.approved_at) d
   where c.location_id = p_site and c.status = 'APPROVED' and c.approved_at is not null and d.business_day <= p_from - 1
   order by d.business_day desc, c.approved_at desc
   limit 1;
  select c.id, d.business_day into v_c_id, v_c_day
    from stock_counts c
   cross join lateral public.stock_co__venue_day(c.location_id, c.approved_at) d
   where c.location_id = p_site and c.status = 'APPROVED' and c.approved_at is not null and d.business_day <= p_to
   order by d.business_day desc, c.approved_at desc
   limit 1;
  return query select p_from, p_to, v_o_id, v_c_id,
                      coalesce(v_o_day = p_from - 1, false), coalesce(v_c_day = p_to, false),
                      v_o_day, v_c_day, false;
end
$fn$;

-- The windows of every site in scope as one jsonb array (what every report puts in meta.windows,
-- plus the snapshot metrics under snap, which meta leaves out).
create or replace function public.stock_rp__windows(p_sites jsonb, p_from date, p_to date, p_between_counts boolean)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', s.id, 'site', s.name, 'currency', s.currency,
           'from_day', w.from_day, 'to_day', w.to_day,
           'opening_count_id', w.opening_count_id, 'closing_count_id', w.closing_count_id,
           'opening_counted', w.opening_counted, 'closing_counted', w.closing_counted,
           'opening_day', w.opening_day, 'closing_day', w.closing_day,
           'window_missing', w.window_missing,
           'snapshot', (w.from_day is not null and public.stock_rp__snapshot(s.id, w.from_day, w.to_day) is not null),
           'part_locked', (w.from_day is not null and public.stock_rp__part_locked(s.id, w.from_day, w.to_day)),
           'takes_from', public.stock_rp__takes_from(s.id),
           'demo_sales', (w.from_day is not null and public.stock_rp__demo_sales(s.id, w.from_day, w.to_day)),
           'snap', case when w.from_day is null then null else public.stock_rp__snapshot(s.id, w.from_day, w.to_day) end
         ) order by s.name, s.id), '[]'::jsonb)
    from jsonb_to_recordset(p_sites) as s(id uuid, name text, currency text)
   cross join lateral public.stock_rp__window(s.id, p_from, p_to, p_between_counts) w;
$fn$;

-- On hand and ledger value per item at the END of business day p_day: today's on hand and books
-- minus the day totals after that day (demo left out). Ledger value equals on hand times cost at any
-- day because every cost writer posts REVALUE (design 5.2). Archived items that still hold stock are
-- included; a negative quantity is kept (the reports show it apart and never let it reduce a total).
create or replace function public.stock_rp__value_at(p_sites uuid[], p_day date)
returns table(location_id uuid, inventory_item_id uuid, company_item_id uuid, qty numeric, value numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with later as (
    select s.location_id, s.inventory_item_id, sum(s.qty_base) as q, sum(s.value) as v
      from stock_day_sums s
     where s.location_id = any(p_sites) and s.business_day > p_day and s.demo = false
     group by s.location_id, s.inventory_item_id
  )
  select i.location_id, i.id, i.company_ref,
         coalesce(i.on_hand, 0) - coalesce(l.q, 0),
         coalesce(i.on_hand, 0) * coalesce(i.current_cost, 0) - coalesce(l.v, 0)
    from inventory_items i
    left join later l on l.location_id = i.location_id and l.inventory_item_id = i.id
   where i.location_id = any(p_sites);
$fn$;

-- The same, summed per site, with the positive part, the negative part and the archived holding apart.
create or replace function public.stock_rp__site_value_at(p_sites uuid[], p_day date)
returns table(location_id uuid, value numeric, positive_value numeric, negative_value numeric, archived_holding_value numeric, items integer, negative_items integer)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select v.location_id,
         sum(v.value),
         sum(case when v.value > 0 then v.value else 0 end),
         sum(case when v.value < 0 then v.value else 0 end),
         sum(case when i.archived_at is not null and v.qty <> 0 then v.value else 0 end),
         count(*) filter (where v.qty <> 0)::integer,
         count(*) filter (where v.qty < 0)::integer
    from public.stock_rp__value_at(p_sites, p_day) v
    join inventory_items i on i.id = v.inventory_item_id
   group by v.location_id;
$fn$;

-- Opening and closing ledger value of each window: the books now less the day totals after the
-- window end (closing), less the window's own totals (opening). The same figures as stock_rp__value_at
-- at to_day and at from_day - 1 summed per site (the harness proves it to the penny), in one read.
create or replace function public.stock_rp__open_close(p_windows jsonb)
returns table(location_id uuid, opening_value numeric, closing_value numeric, books_now numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with w as (
    select x.location_id, x.from_day, x.to_day
      from jsonb_to_recordset(p_windows) as x(location_id uuid, from_day date, to_day date)
     where x.from_day is not null
  ),
  b as (
    select i.location_id, sum(coalesce(i.on_hand, 0) * coalesce(i.current_cost, 0)) as v
      from inventory_items i
     where i.location_id in (select w.location_id from w)
     group by i.location_id
  ),
  d as (
    select w.location_id,
           sum(s.value) filter (where s.business_day > w.to_day) as later,
           sum(s.value) filter (where s.business_day between w.from_day and w.to_day) as win
      from w
      join stock_day_sums s on s.location_id = w.location_id and s.business_day >= w.from_day and s.demo = false
     group by w.location_id
  )
  select w.location_id,
         coalesce(b.v, 0) - coalesce(d.later, 0) - coalesce(d.win, 0),
         coalesce(b.v, 0) - coalesce(d.later, 0),
         coalesce(b.v, 0)
    from w
    left join b on b.location_id = w.location_id
    left join d on d.location_id = w.location_id;
$fn$;

-- The window's day totals per site and bucket (every report's stock figures come from here).
create or replace function public.stock_rp__site_ledger(p_windows jsonb)
returns table(location_id uuid, bucket text, qty numeric, value numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select g.location_id, public.stock_rp__bucket(g.movement_type, g.source_type), sum(g.q), sum(g.v)
    from (select w.location_id, s.movement_type, s.source_type, sum(s.qty_base) as q, sum(s.value) as v
            from jsonb_to_recordset(p_windows) as w(location_id uuid, from_day date, to_day date)
            join stock_day_sums s on s.location_id = w.location_id and s.business_day between w.from_day and w.to_day and s.demo = false
           where w.from_day is not null
           group by w.location_id, s.movement_type, s.source_type) g
   group by g.location_id, public.stock_rp__bucket(g.movement_type, g.source_type);
$fn$;

-- The window's sales day totals per site (every report's sales figures come from here): net after
-- spread discounts and rewards, the loyalty, staff and comps line, and the share with a recipe.
-- Plate cost (theo_cost, from the sale's own takes, on the day the check closed) and the cost of the
-- loyalty, staff and comps line are known only from the site's takes_from day: they are summed from
-- it, known_net is the net of those same days (the base of every product GP), and pre_rows counts
-- the sales rows before it (a sale whose plate cost was never saved).
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
           sum(s.theo_cost) filter (where s.business_day >= w.takes_from) as theo,
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

-- The sale's own take off from the ledger on the venue days of the window BEFORE the site's
-- takes_from (the old rule's sales, which have no takes): the only theoretical cost those days have.
-- From takes_from on, theoretical cost is the takes' (stock_rp__site_sales), on the day the check
-- closed, so a sale and its cost always sit on the same day (a catering order dated ahead included).
create or replace function public.stock_rp__site_old_sold(p_windows jsonb)
returns table(location_id uuid, sold numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select w.location_id, -sum(s.value)
    from jsonb_to_recordset(p_windows) as w(location_id uuid, from_day date, to_day date, takes_from date)
    join stock_day_sums s on s.location_id = w.location_id and s.demo = false
                         and s.business_day between w.from_day and least(w.to_day, coalesce(w.takes_from - 1, w.to_day))
                         and s.movement_type = 'SALE_DEPLETION' and s.source_type = 'closed_check'
   where w.from_day is not null
   group by w.location_id;
$fn$;

-- Average daily cost of use (sales and batch use) over the last 28 venue days, per site.
create or replace function public.stock_rp__daily_use(p_sites uuid[])
returns table(location_id uuid, daily_use numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select l.id, coalesce((select -sum(s.value) / 28.0 from stock_day_sums s
                          where s.location_id = l.id and s.business_day between t.business_day - 27 and t.business_day
                            and s.demo = false and s.movement_type in ('SALE_DEPLETION', 'PRODUCTION_CONSUME')), 0)
    from unnest(p_sites) as l(id)
   cross join lateral public.stock_co__venue_day(l.id, now()) t;
$fn$;

-- Labour from Workforce timesheets at the site, bucketed on the venue day of clock in.
create or replace function public.stock_rp__labour(p_site uuid, p_from date, p_to date)
returns table(pay numeric, has_data boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce((select sum(coalesce(t.pay_amount, t.actual_hours * t.effective_rate))
                     from wf_timesheets t
                    cross join lateral public.stock_co__venue_day(p_site, t.clock_in) d
                    where t.location_id = p_site and coalesce(t.status, '') <> 'rejected' and d.business_day between p_from and p_to), 0),
         exists (select 1 from wf_timesheets t
                  cross join lateral public.stock_co__venue_day(p_site, t.clock_in) d
                  where t.location_id = p_site and d.business_day between p_from and p_to);
$fn$;

-- Sales not yet posted to stock: pending or held outbox events in the window, with their value.
create or replace function public.stock_rp__not_posted(p_sites uuid[], p_from date, p_to date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object('count', count(*), 'value', coalesce(sum(coalesce(c.subtotal, 0)), 0))
    from stock_outbox o
   cross join lateral public.stock_co__venue_day(o.location_id, o.occurred_at) d
    left join closed_checks c on c.id = o.check_id and c.location_id = o.location_id::text
   where o.location_id = any(p_sites) and o.status in ('pending', 'held') and d.business_day between p_from and p_to;
$fn$;

-- The guard's step 3 for a named login (the export runner and the download check cannot ask
-- user_accessible_locations as that user): a link row, or owner of the company, or Stock control all
-- in the company, or ServOS staff; every site in the company.
create or replace function public.stock_rp__reach_for(p_user uuid, p_org uuid, p_sites uuid[])
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select p_user is not null and p_org is not null and p_sites is not null and cardinality(p_sites) > 0
     and not exists (select 1 from unnest(p_sites) x(id)
                      where not exists (select 1 from locations l where l.id = x.id and l.org_id = p_org))
     and (exists (select 1 from user_profiles p where p.id = p_user and p.role = 'super_admin')
          or exists (select 1 from user_profiles p where p.id = p_user and p.org_id = p_org and (p.role = 'owner' or p.stock_control = 'all'))
          or not exists (select 1 from unnest(p_sites) x(id)
                          where not exists (select 1 from user_locations ul where ul.user_id = p_user and ul.location_id = x.id)));
$fn$;

-- One company row per currency from site rows: the listed keys summed (null when no site has a
-- number). Two currencies are never added: a company with GBP and USD sites gets two rows.
create or replace function public.stock_rp__sum_rows(p_rows jsonb, p_keys text[])
returns jsonb
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(jsonb_agg(z.row order by z.currency), '[]'::jsonb)
    from (select r.currency,
                 jsonb_build_object('location_id', null, 'site', 'Company', 'currency', r.currency, 'sites', count(*))
                 || coalesce((select jsonb_object_agg(k.key, (select sum((x.r ->> k.key)::numeric) from jsonb_array_elements(p_rows) x(r)
                                                                where coalesce(x.r ->> 'currency', '') = r.currency and jsonb_typeof(x.r -> k.key) = 'number'))
                                from unnest(p_keys) k(key)), '{}'::jsonb) as row
            from (select coalesce(e ->> 'currency', '') as currency from jsonb_array_elements(p_rows) e) r
           group by r.currency) z;
$fn$;

-- A snapshot figure when the locked period has it, else the live one.
create or replace function public.stock_rp__snap_num(p_snap jsonb, p_key text, p_live numeric)
returns numeric
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select case when p_snap is not null and jsonb_typeof(p_snap -> p_key) = 'number' then (p_snap ->> p_key)::numeric else p_live end;
$fn$;

-- meta.windows: the windows without their snapshot metrics.
create or replace function public.stock_rp__meta_windows(p_windows jsonb)
returns jsonb
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(jsonb_agg(w - 'snap' - 'site' - 'currency'), '[]'::jsonb) from jsonb_array_elements(p_windows) w;
$fn$;

-- The meta block every report answers: the guard's facts plus the report's own. meta.level is the
-- drill level answered (contract 1.6.1); the login's Stock control level is meta.stock_level. A site
-- whose window holds a demo check gets its line in meta.notes (its sales and GP are not shown).
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
                       || coalesce((select jsonb_agg('Demo sales on these days at ' || coalesce(w ->> 'site', 'a site') || ': its sales and GP are not shown'
                                                     order by w ->> 'site')
                                      from jsonb_array_elements(coalesce(p_windows, '[]'::jsonb)) w
                                     where coalesce((w ->> 'demo_sales')::boolean, false) and not coalesce((w ->> 'snapshot')::boolean, false)), '[]'::jsonb),
              'generated_at', now());
$fn$;

-- A column list entry (key, label, kind) in one call.
create or replace function public.stock_rp__col(p_key text, p_label text, p_kind text)
returns jsonb
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_object('key', p_key, 'label', p_label, 'kind', p_kind);
$fn$;

-- The drill site of p_opts (one of the sites in scope), else null.
create or replace function public.stock_rp__opt_site(p_g jsonb, p_opts jsonb)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v uuid;
begin
  if p_opts is null or nullif(p_opts ->> 'site', '') is null then
    return null;
  end if;
  begin
    v := (p_opts ->> 'site')::uuid;
  exception when others then
    raise exception 'Pick 1 to 50 sites.' using errcode = '22023';
  end;
  if not exists (select 1 from jsonb_array_elements(p_g -> 'sites') x where (x ->> 'id')::uuid = v) then
    raise exception 'Pick 1 to 50 sites.' using errcode = '22023';
  end if;
  return v;
end
$fn$;

-- THE REPORT GUARD. Who is asking (never a till, kiosk, clock, customer or the anon key; the second
-- step done), which sites (1 to 50, all in the company, all in the login's reach), and the facts every
-- report puts in meta. The service role (the Owner app) is trusted for reach and given level all.
create or replace function public.stock_report_guard(p_org uuid, p_sites uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_service boolean := public._fence_api_role() = 'service_role';
  v_uid     uuid;
  v_reach   text[];
  v_l       record;
  v_level   text;
  v_open    integer;
  v_since   timestamptz;
  v_sites   jsonb;
  v_curr    text[];
  v_rule    text;
  v_week    smallint;
begin
  if not v_service then
    v_uid := auth.uid();
    if v_uid is null or public.is_anon_session() or not public.second_step_ok() then
      raise exception 'Sign in to Back Office to see stock reports.' using errcode = '42501';
    end if;
  end if;
  if p_org is null or p_sites is null or cardinality(p_sites) = 0
     or (select count(distinct x.id) from unnest(p_sites) x(id)) > 50
     or exists (select 1 from unnest(p_sites) x(id) where x.id is null) then
    raise exception 'Pick 1 to 50 sites.' using errcode = '22023';
  end if;
  if not v_service then
    v_reach := array(select public.stock_reach_locations());
  end if;
  for v_l in
    select u.id as want, l.id, l.name, l.org_id
      from (select distinct x.id from unnest(p_sites) x(id)) u
      left join locations l on l.id = u.id
     order by u.id
  loop
    if v_l.id is null then
      raise exception 'Not allowed: a site in the list was not found.' using errcode = '42501';
    end if;
    if v_l.org_id is distinct from p_org then
      raise exception 'Not allowed: % is in another company.', v_l.name using errcode = '42501';
    end if;
    if not v_service and not (v_l.id::text = any(v_reach)) then
      raise exception 'Not allowed: this login does not reach %.', v_l.name using errcode = '42501';
    end if;
  end loop;
  v_level := case when v_service then 'all' else public.stock_level(v_uid, p_org) end;
  select count(*) filter (where coalesce(l.status, 'active') = 'active') into v_open from locations l where l.org_id = p_org;
  select s.multi_since, coalesce(s.cost_rule, 'price_list'), coalesce(s.week_start, 1) into v_since, v_rule, v_week
    from stock_co_settings s where s.org_id = p_org;
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'name', l.name, 'currency', coalesce(nullif(l.currency, ''), 'GBP'),
           'timezone', k.timezone, 'day_start', k.day_start, 'clock_known', k.clock_known,
           'cost_rule_own', (ss.cost_rule_override is not null and ss.cost_rule_override is distinct from coalesce(v_rule, 'price_list')),
           'kind', coalesce(ss.site_kind, 'restaurant'),
           'status', coalesce(l.status, 'active')) order by l.name, l.id), '[]'::jsonb)
    into v_sites
    from (select distinct x.id from unnest(p_sites) x(id)) u
    join locations l on l.id = u.id
   cross join lateral public.stock_co__clock_of(l.id) k
    left join stock_co_site_settings ss on ss.location_id = l.id;
  v_curr := array(select distinct coalesce(nullif(l.currency, ''), 'GBP') from locations l where l.id = any(p_sites) order by 1);
  return jsonb_build_object(
    'uid', v_uid, 'service', v_service, 'level', v_level, 'org_id', p_org,
    'multi', (coalesce(v_open, 0) >= 2 or v_since is not null),
    'sites', v_sites,
    'currencies', to_jsonb(v_curr),
    'mixed_currency', cardinality(v_curr) > 1,
    -- demo stock (keyed demo-v1:, demo71:, seed:) or a check the demo files wrote (id demo-)
    'demo_left_out', exists (select 1 from stock_day_sums s where s.location_id = any(p_sites) and s.demo = true)
                     or exists (select 1 from closed_checks c
                                 where c.location_id = any(array(select x.id::text from unnest(p_sites) x(id))) and c.id like 'demo-%'),
    'week_start', coalesce(v_week, 1));
end
$fn$;

-- ============================================================================
-- STEP 5. THE REPORT FUNCTIONS (public, STABLE, definer; one signature, one answer shape)
-- ============================================================================
-- stock_report_<name>(p_org, p_sites, p_from, p_to, p_opts, p_after, p_limit) returns
--   { meta, totals, rows, next }: meta the guard's facts plus the report's; totals the site rows
--   first then one company row per currency; rows the drill level asked for, keyset paged on p_after
--   (never OFFSET), at most stock_rp__page_cap(p_limit) = 1,000 rows; next null when there are no more.
--   A site level answer (one row per site, or per site and type or kind: at most 50 sites by the
--   guard) is never cut by p_limit: it is all of it in one page, under the same 1,000 cap.

-- The window's day totals per site and bucket, with the positive and negative parts kept apart.
create or replace function public.stock_rp__site_ledger_split(p_windows jsonb)
returns table(location_id uuid, bucket text, qty numeric, value numeric, pos_value numeric, neg_value numeric)
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select g.location_id, public.stock_rp__bucket(g.movement_type, g.source_type), sum(g.q), sum(g.v), sum(g.pv), sum(g.nv)
    from (select w.location_id, s.movement_type, s.source_type, sum(s.qty_base) as q, sum(s.value) as v,
                 sum(case when s.value > 0 then s.value else 0 end) as pv, sum(case when s.value < 0 then s.value else 0 end) as nv
            from jsonb_to_recordset(p_windows) as w(location_id uuid, from_day date, to_day date)
            join stock_day_sums s on s.location_id = w.location_id and s.business_day between w.from_day and w.to_day and s.demo = false
           where w.from_day is not null
           group by w.location_id, s.movement_type, s.source_type) g
   group by g.location_id, public.stock_rp__bucket(g.movement_type, g.source_type);
$fn$;

-- The base figures of every site in scope for its window (the rules of contract 1.6.2, in one place):
-- sales from sales_day_sums, stock from stock_day_sums, opening and closing from the ledger, the
-- loyalty, staff and comps line, and a locked period's snapshot in place of the live figures.
-- Theoretical cost is the takes' from the site's takes_from day (on the day each check closed, the
-- day its sale sits on) and the ledger's sale take off before it. The loyalty, staff and comps cost
-- is not known (null) when the window has sales before takes_from. A window holding a demo check
-- (demo_sales) has its sales and every figure made from them null: they cannot be told apart.
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
           case when w.sd then null else coalesce(s.theo_cost, 0) end as product_theo,
           case when w.sd then null else coalesce(s.known_net, 0) end as known_net,
           case when w.sd then null else public.stock_rp__snap_num(w.snap, 'theo_cost', coalesce(od.sold, 0) + coalesce(s.theo_cost, 0)) end as theo_cost,
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

-- The percents and the GP lines of one row (a site row or a summed company row): the same words as
-- contract 1.6.2, computed once here so every report and every company row agrees.
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
           'gp_before', (p_row ->> 'sales_net')::numeric - (p_row ->> 'theo_cost')::numeric,
           'gp_after', (p_row ->> 'sales_net')::numeric - (p_row ->> 'theo_cost')::numeric + (p_row ->> 'comps_cost')::numeric,
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

-- The base keys a company row adds up (never a percent: those are derived again from the sums).
create or replace function public.stock_rp__sum_keys()
returns text[]
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select array['sales_net', 'sales_gross', 'sold_qty', 'with_recipe_net', 'no_recipe_net', 'products', 'product_theo', 'theo_cost', 'known_net',
               'loyalty_cost', 'staff_cost', 'comp_cost', 'loyalty_qty', 'staff_qty', 'comp_qty', 'comps_cost', 'comps_qty',
               'opening_value', 'closing_value', 'received', 'purchases', 'transfers_in', 'transfers_out', 'made', 'used_in_batches',
               'sold_cost', 'waste_value', 'revalue', 'count_adj', 'surplus', 'unaccounted', 'opening_balance', 'other', 'sold_units',
               'expected_closing', 'gap_value', 'actual_cost', 'stock_value_now', 'negative_value_now', 'daily_use',
               'not_posted_count', 'not_posted_value', 'labour', 'below_par_count', 'negative_count'];
$fn$;

-- The keys a company row shows only when every site in it has them (never a sum of some sites' sales
-- beside another set's cost): the sales and every figure made from them. A site with demo sales in
-- the window, or with sales before its takes_from (the loyalty, staff and comps cost), answers null,
-- and then so does the company row of its currency. A central kitchen (no sales) never counts.
create or replace function public.stock_rp__strict_keys()
returns text[]
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select array['sales_net', 'sales_gross', 'sold_qty', 'with_recipe_net', 'no_recipe_net', 'products', 'product_theo', 'theo_cost', 'known_net',
               'loyalty_cost', 'staff_cost', 'comp_cost', 'loyalty_qty', 'staff_qty', 'comp_qty', 'comps_cost', 'comps_qty'];
$fn$;

-- The company rows with each strict key null where a site row of that currency has it null, and
-- demo_sales true where a site row of that currency has it true.
create or replace function public.stock_rp__strict(p_company jsonb, p_site_rows jsonb, p_keys text[])
returns jsonb
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(jsonb_agg(
           c.c
           || coalesce((select jsonb_object_agg(k.key, 'null'::jsonb)
                          from unnest(p_keys) k(key)
                         where exists (select 1 from jsonb_array_elements(p_site_rows) r
                                        where coalesce(r ->> 'currency', '') = coalesce(c.c ->> 'currency', '')
                                          and not coalesce((r ->> 'kitchen')::boolean, false)
                                          and jsonb_typeof(r -> k.key) = 'null')), '{}'::jsonb)
           || jsonb_build_object('demo_sales', exists (select 1 from jsonb_array_elements(p_site_rows) r
                                                        where coalesce(r ->> 'currency', '') = coalesce(c.c ->> 'currency', '')
                                                          and coalesce((r ->> 'demo_sales')::boolean, false)))
           order by c.n), '[]'::jsonb)
    from jsonb_array_elements(p_company) with ordinality as c(c, n);
$fn$;

-- The lines a GP report adds for its site rows: the loyalty, staff and comps cost not known where a
-- window has sales before the site's takes_from (they never had their plate cost saved).
create or replace function public.stock_rp__fig_notes(p_fig jsonb)
returns jsonb
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(jsonb_agg('Loyalty, staff and comps cost not known '
                            || case when r ->> 'takes_from' is null then 'yet' else 'before ' || to_char((r ->> 'takes_from')::date, 'Dy FMDD Mon') end
                            || ' at ' || coalesce(r ->> 'site', 'a site') order by r ->> 'site'), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_fig, '[]'::jsonb)) r
   where jsonb_typeof(r -> 'comps_cost') = 'null' and not coalesce((r ->> 'demo_sales')::boolean, false)
     and not coalesce((r ->> 'kitchen')::boolean, false) and r ->> 'from_day' is not null;
$fn$;

-- Site rows then one company row per currency, each with the derived percents; p_keep lists the
-- columns to answer (null keeps every key).
create or replace function public.stock_rp__totals(p_org uuid, p_site_rows jsonb, p_keep text[])
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with all_rows as (
    select public.stock_rp__derive(p_org, r) as r, 0 as grp, (r ->> 'site') as site_name, r ->> 'currency' as currency
      from jsonb_array_elements(p_site_rows) r
    union all
    select public.stock_rp__derive(p_org, c), 1, 'Company', c ->> 'currency'
      from jsonb_array_elements(public.stock_rp__strict(public.stock_rp__sum_rows(p_site_rows, public.stock_rp__sum_keys()), p_site_rows,
                                                        public.stock_rp__strict_keys())) c
  )
  select coalesce(jsonb_agg(
           case when p_keep is null then a.r
                else (select coalesce(jsonb_object_agg(k.key, a.r -> k.key), '{}'::jsonb)
                        from unnest(array['location_id', 'site', 'currency', 'sites', 'rag', 'demo_sales', 'known_from'] || p_keep) k(key)
                       where a.r ? k.key) end
           order by a.grp, a.site_name, a.currency), '[]'::jsonb)
    from all_rows a;
$fn$;

-- ---------------------------------------------------------------------------------------------
-- stock_report_attention: the needs attention rows (4a kinds), one row per site and kind.
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_report_attention(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
                                                         p_after jsonb default null, p_limit integer default 1000)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_g      jsonb := public.stock_report_guard(p_org, p_sites);
  v_limit  integer := public.stock_rp__page_cap(p_limit);
  v_sites  uuid[];
  v_rows   jsonb;
  v_totals jsonb;
  v_cols   jsonb;
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  v_sites := array(select (x ->> 'id')::uuid from jsonb_array_elements(v_g -> 'sites') x);
  v_cols := jsonb_build_array(public.stock_rp__col('kind', 'What', 'text'), public.stock_rp__col('site', 'Site', 'text'),
                              public.stock_rp__col('count', 'How many', 'qty'), public.stock_rp__col('words', 'Words', 'text'));
  with s as (select (x ->> 'id')::uuid as id, x ->> 'name' as name, x ->> 'currency' as currency from jsonb_array_elements(v_g -> 'sites') x),
  k as (
    select s.id, s.name, 'negative_stock' as kind, count(*) as n, 'Negative stock: a missed delivery or a wrong recipe.' as words
      from s join inventory_items i on i.location_id = s.id and i.archived_at is null and i.on_hand < 0 group by s.id, s.name
    union all
    select s.id, s.name, 'below_minimum', count(*), 'Below the minimum level.'
      from s join par_levels p on p.location_id = s.id join inventory_items i on i.id = p.inventory_item_id and i.archived_at is null
     where p.min_level is not null and i.on_hand < p.min_level group by s.id, s.name
    union all
    select s.id, s.name, 'out_of_step', 1, 'Site out of step. Fix.'
      from s join stock_co_site_health h on h.location_id = s.id
     where coalesce(h.planned_writes, 0) + coalesce(h.recipe_planned_writes, 0) > 0
    union all
    select s.id, s.name, 'invoice_review', count(*), 'Invoices waiting for review.'
      from s join supplier_invoices v on v.location_id = s.id and v.status = 'REVIEW' group by s.id, s.name
    union all
    select s.id, s.name, 'clock_disagrees', 1, 'The venue clock disagrees between Ops and Platform.'
      from s join venue_clock c on c.location_id = s.id and c.mismatch is not null
    union all
    select s.id, s.name, 'demo_history', 1, 'Demo history left out of every figure.'
      from s where exists (select 1 from stock_day_sums d where d.location_id = s.id and d.demo = true)
                or exists (select 1 from closed_checks c where c.location_id = s.id::text and c.id like 'demo-%')
    union all
    select s.id, s.name, 'not_posted', count(*), 'Sales not yet posted to stock.'
      from s join stock_outbox o on o.location_id = s.id and o.status in ('pending', 'held') group by s.id, s.name
  )
  select coalesce(jsonb_agg(jsonb_build_object('kind', k.kind, 'location_id', k.id, 'site', k.name, 'count', k.n, 'words', k.words,
                                               'ref', jsonb_build_object('site', k.id, 'kind', k.kind))
                            order by k.kind, k.name, k.id), '[]'::jsonb),
         coalesce((select jsonb_agg(jsonb_build_object('kind', z.kind, 'count', z.n, 'sites', z.sites) order by z.kind)
                     from (select kind, sum(n) as n, count(*) as sites from k group by kind) z), '[]'::jsonb)
    into v_rows, v_totals
    from k;
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'attention', p_from, p_to, false, 'kind', v_cols, '[]'::jsonb, '[]'::jsonb),
    'totals', v_totals,
    'rows', (select coalesce(jsonb_agg(r), '[]'::jsonb) from (select r from jsonb_array_elements(v_rows) r limit 1000) z),
    'next', null);
end
$fn$;

-- ---------------------------------------------------------------------------------------------
-- The league rows: the base figures of every site plus the last full count, below par, negative
-- stock and the central kitchen flag (a kitchen has no sales of its own).
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_rp__league_rows(p_fig jsonb)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with f as (select r, (r ->> 'location_id')::uuid as loc from jsonb_array_elements(p_fig) r),
  x as (
    select f.loc,
           (select d.business_day from stock_counts c cross join lateral public.stock_co__venue_day(c.location_id, c.approved_at) d
             where c.location_id = f.loc and c.status = 'APPROVED' and c.count_type = 'FULL' and c.approved_at is not null
             order by d.business_day desc limit 1) as last_full,
           (select count(*) from par_levels p join inventory_items i on i.id = p.inventory_item_id
             where p.location_id = f.loc and i.archived_at is null and i.location_id = f.loc
               and i.on_hand < coalesce(
                     (select nullif(cs.par_by_weekday ->> lower(to_char(public.stock_co__today(f.loc), 'dy')), '')::numeric
                        from stock_co_item_sites cs where cs.location_id = f.loc and cs.site_item_id = i.id limit 1),
                     p.par_level)) as below_par,
           (select count(*) from inventory_items i where i.location_id = f.loc and i.archived_at is null and i.on_hand < 0) as negative,
           coalesce((select ss.site_kind = 'central_kitchen' from stock_co_site_settings ss where ss.location_id = f.loc), false) as kitchen
      from f
  )
  select coalesce(jsonb_agg(f.r || jsonb_build_object(
           'last_full_count_day', x.last_full,
           'last_full_count_words', case when x.last_full is null then 'None yet' else to_char(x.last_full, 'Dy FMDD Mon') end,
           'below_par_count', x.below_par, 'negative_count', x.negative, 'kitchen', x.kitchen)
           || case when x.kitchen then jsonb_build_object('sales_net', null, 'theo_cost', null, 'comps_cost', null) else '{}'::jsonb end
         order by f.r ->> 'site', f.loc), '[]'::jsonb)
    from f join x on x.loc = f.loc;
$fn$;

create or replace function public.stock_rp__league_keep()
returns text[]
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select array['sales_net', 'gp_pct_theo', 'gp_pct_actual', 'gap_pct', 'waste_pct', 'comps_pct', 'purchases', 'budget', 'stock_value_now',
               'days_on_hand', 'last_full_count_day', 'last_full_count_words', 'no_recipe_pct', 'below_par_count', 'negative_count', 'kitchen',
               'theo_cost', 'actual_cost', 'gap_value', 'waste_value', 'comps_cost', 'opening_counted', 'closing_counted', 'window_missing', 'snapshot',
               'from_day', 'to_day'];
$fn$;

create or replace function public.stock_rp__league_cols()
returns jsonb
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select jsonb_build_array(
    public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('sales_net', 'Sales', 'money'),
    public.stock_rp__col('gp_pct_theo', 'GP % theo', 'pct'), public.stock_rp__col('gp_pct_actual', 'GP % actual', 'pct'),
    public.stock_rp__col('gap_pct', 'Gap %', 'pct'), public.stock_rp__col('waste_pct', 'Waste %', 'pct'), public.stock_rp__col('comps_pct', 'Comps %', 'pct'),
    public.stock_rp__col('purchases', 'Purchases', 'money'), public.stock_rp__col('budget', 'Budget', 'money'),
    public.stock_rp__col('stock_value_now', 'Stock value', 'money'), public.stock_rp__col('days_on_hand', 'Days on hand', 'qty'),
    public.stock_rp__col('last_full_count_words', 'Last full count', 'text'), public.stock_rp__col('no_recipe_pct', 'No recipe sales', 'pct'),
    public.stock_rp__col('below_par_count', 'Below par', 'qty'));
$fn$;

-- ---------------------------------------------------------------------------------------------
-- stock_report_league: one row per site (the league IS the site level). Also for the service role
-- (the Owner app, fenced by officeReachesVenue first).
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_report_league(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
                                                      p_after jsonb default null, p_limit integer default 1000)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_g        jsonb := public.stock_report_guard(p_org, p_sites);
  v_o        jsonb := coalesce(p_opts, '{}'::jsonb);
  v_limit    integer := public.stock_rp__page_cap(p_limit);
  v_between  boolean := coalesce(nullif(v_o ->> 'between_counts', '')::boolean, false);
  v_win      jsonb;
  v_fig      jsonb;
  v_totals   jsonb;
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, v_between);
  v_fig := public.stock_rp__league_rows(public.stock_rp__site_figures(v_g, v_win));
  v_totals := public.stock_rp__totals(p_org, v_fig, public.stock_rp__league_keep());
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'league', p_from, p_to, v_between, 'site', public.stock_rp__league_cols(), v_win,
              jsonb_build_array('Purchases at delivery value until the purchasing update') || public.stock_rp__fig_notes(v_fig)),
    'totals', v_totals,
    'rows', (select coalesce(jsonb_agg(t), '[]'::jsonb) from (select t from jsonb_array_elements(v_totals) t where jsonb_typeof(t -> 'location_id') = 'string' limit 1000) z),
    'next', null);
end
$fn$;

-- ---------------------------------------------------------------------------------------------
-- stock_report_key_ratios: used against sold per key item, per site (and per week).
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_report_key_ratios(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
                                                          p_after jsonb default null, p_limit integer default 1000)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_g        jsonb := public.stock_report_guard(p_org, p_sites);
  v_o        jsonb := coalesce(p_opts, '{}'::jsonb);
  v_limit    integer := public.stock_rp__page_cap(p_limit);
  v_between  boolean := coalesce(nullif(v_o ->> 'between_counts', '')::boolean, false);
  v_level    text := coalesce(nullif(v_o ->> 'level', ''), 'site');
  v_ratio    uuid := nullif(v_o ->> 'ratio_id', '')::uuid;
  v_week     smallint := coalesce((v_g ->> 'week_start')::smallint, 1);
  v_win      jsonb;
  v_rows     jsonb := '[]'::jsonb;
  v_totals   jsonb := '[]'::jsonb;
  v_next     jsonb;
  v_cols     jsonb;
  v_notes    jsonb := '[]'::jsonb;
  v_n        integer;
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, v_between);
  v_cols := jsonb_build_array(
    public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('name', 'Key item', 'text'),
    public.stock_rp__col('used_qty', 'Used', 'qty'), public.stock_rp__col('used_unit', 'Unit', 'text'), public.stock_rp__col('sold_qty', 'Sold', 'qty'),
    public.stock_rp__col('per_sold', 'Per sold', 'qty'), public.stock_rp__col('recipe_amount', 'Recipe', 'qty'), public.stock_rp__col('diff_pct', 'Difference %', 'pct'),
    public.stock_rp__col('rag', 'Colour', 'rag'));
  if not exists (select 1 from stock_key_ratios k where k.org_id = p_org and k.archived_at is null) then
    v_notes := jsonb_build_array('Choose your key items in Targets');
  end if;
  -- per site (and week) per ratio: used = minus SALE_DEPLETION quantity of the used item's site item;
  -- sold = sales_day_sums quantity of the sold rule's products (not known at a site whose window holds
  -- a demo check: its demo sales cannot be told apart, and the demo stock is left out of used)
  with w as (
    select (x ->> 'location_id')::uuid as loc, x ->> 'site' as site, x ->> 'currency' as currency,
           (x ->> 'from_day')::date as from_day, (x ->> 'to_day')::date as to_day,
           coalesce((x ->> 'demo_sales')::boolean, false) and not coalesce((x ->> 'snapshot')::boolean, false) as sd
      from jsonb_array_elements(v_win) x
     where x ->> 'from_day' is not null
  ),
  k as (
    select r.id, r.name, r.used_item_id, r.used_unit, r.sold_rule, r.recipe_amount, r.sort_order
      from stock_key_ratios r
     where r.org_id = p_org and r.archived_at is null and (v_ratio is null or r.id = v_ratio)
  ),
  used as (
    select w.loc, k.id as ratio_id,
           case when v_level = 'week' then public.stock_rp__week_of(s.business_day, v_week) else w.from_day end as wk,
           -sum(s.qty_base) as used_qty
      from w cross join k
      join stock_day_sums s on s.location_id = w.loc and s.business_day between w.from_day and w.to_day and s.demo = false
                            and s.movement_type = 'SALE_DEPLETION' and s.source_type = 'closed_check' and s.company_item_id = k.used_item_id
     group by w.loc, k.id, 3
  ),
  sold as (
    select w.loc, k.id as ratio_id,
           case when v_level = 'week' then public.stock_rp__week_of(s.business_day, v_week) else w.from_day end as wk,
           sum(s.qty) as sold_qty
      from w cross join k
      join sales_day_sums s on s.location_id = w.loc and s.business_day between w.from_day and w.to_day
     where not w.sd and case k.sold_rule ->> 'kind'
             when 'all' then true
             when 'items' then (k.sold_rule -> 'menu_item_ids') ? s.menu_item_id
             when 'category' then exists (select 1 from menu_items m
                                           left join menu_categories c on c.location_id = m.location_id and c.id = coalesce(m.cat, m.cats[1])
                                          where m.location_id = w.loc::text and m.id = s.menu_item_id
                                            and lower(coalesce(c.accounting_group, '')) = lower(coalesce(k.sold_rule ->> 'accounting_group', '')))
             else false end
     group by w.loc, k.id, 3
  ),
  keys as (
    select u.loc, u.ratio_id, u.wk from used u
    union
    select so.loc, so.ratio_id, so.wk from sold so
    union
    select w.loc, k.id, w.from_day from w cross join k where v_level <> 'week'
  ),
  g as (
    select kk.loc, w.site, w.currency, kk.ratio_id, k.name, k.used_unit, k.recipe_amount, k.sort_order,
           kk.wk as week_start, coalesce(u.used_qty, 0) as used_qty, case when w.sd then null else coalesce(so.sold_qty, 0) end as sold_qty
      from keys kk
      join w on w.loc = kk.loc
      join k on k.id = kk.ratio_id
      left join used u on u.loc = kk.loc and u.ratio_id = kk.ratio_id and u.wk = kk.wk
      left join sold so on so.loc = kk.loc and so.ratio_id = kk.ratio_id and so.wk = kk.wk
  ),
  r as (
    select g.*, case when coalesce(g.sold_qty, 0) = 0 then null else round(g.used_qty / g.sold_qty, 4) end as per_sold,
           case when coalesce(g.sold_qty, 0) = 0 or g.recipe_amount is null or g.recipe_amount = 0 then null
                else round((g.used_qty / g.sold_qty - g.recipe_amount) / g.recipe_amount * 100, 2) end as diff_pct
      from g
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', r.loc, 'site', r.site, 'currency', r.currency, 'ratio_id', r.ratio_id, 'name', r.name,
           'week_start', case when v_level = 'week' then r.week_start end,
           'used_qty', r.used_qty, 'used_unit', r.used_unit, 'sold_qty', r.sold_qty, 'per_sold', r.per_sold,
           'recipe_amount', r.recipe_amount, 'diff_pct', r.diff_pct,
           'rag', case when r.diff_pct is null then null when abs(r.diff_pct) <= 5 then 'green' when abs(r.diff_pct) <= 10 then 'amber' else 'red' end)
           order by r.site, r.loc, r.week_start, r.sort_order, r.name, r.ratio_id), '[]'::jsonb)
    into v_rows
    from r
   where v_level <> 'week' or r.week_start is not null;
  -- totals: the site rows (level site) and one company row per currency and ratio
  v_totals := (select coalesce(jsonb_agg(t order by (t ->> 'site'), (t ->> 'name')), '[]'::jsonb)
                 from jsonb_array_elements(v_rows) t where v_level <> 'week')
              || (select coalesce(jsonb_agg(jsonb_build_object(
                    'location_id', null, 'site', 'Company', 'currency', z.currency, 'ratio_id', z.ratio_id, 'name', z.name,
                    'used_qty', z.used_qty, 'used_unit', z.used_unit, 'sold_qty', z.sold_qty,
                    'per_sold', case when coalesce(z.sold_qty, 0) = 0 then null else round(z.used_qty / z.sold_qty, 4) end,
                    'recipe_amount', z.recipe_amount,
                    'diff_pct', case when coalesce(z.sold_qty, 0) = 0 or coalesce(z.recipe_amount, 0) = 0 then null
                                     else round((z.used_qty / z.sold_qty - z.recipe_amount) / z.recipe_amount * 100, 2) end)
                    order by z.currency, z.name), '[]'::jsonb)
                    from (select t ->> 'currency' as currency, (t ->> 'ratio_id')::uuid as ratio_id, t ->> 'name' as name, t ->> 'used_unit' as used_unit,
                                 (t ->> 'recipe_amount')::numeric as recipe_amount,
                                 sum((t ->> 'used_qty')::numeric) as used_qty,
                                 case when bool_or(jsonb_typeof(t -> 'sold_qty') = 'null') then null else sum((t ->> 'sold_qty')::numeric) end as sold_qty
                            from jsonb_array_elements(v_rows) t
                           group by 1, 2, 3, 4, 5) z);
  -- keyset page of the rows: (site name, location_id, week_start, ratio_id)
  select coalesce(jsonb_agg(z.r order by z.k1, z.k2, z.k3, z.k4), '[]'::jsonb), count(*)
    into v_rows, v_n
    from (select r, r ->> 'site' as k1, r ->> 'location_id' as k2, coalesce(r ->> 'week_start', '') as k3, r ->> 'ratio_id' as k4
            from jsonb_array_elements(v_rows) r) z
   where p_after is null
      or (z.k1, z.k2, z.k3, z.k4) > (coalesce(p_after ->> 'site', ''), coalesce(p_after ->> 'location_id', ''), coalesce(p_after ->> 'week_start', ''), coalesce(p_after ->> 'ratio_id', ''))
   ;
  if v_n > v_limit then
    v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
    v_next := jsonb_build_object('site', v_rows -> (v_limit - 1) ->> 'site', 'location_id', v_rows -> (v_limit - 1) ->> 'location_id',
                                 'week_start', v_rows -> (v_limit - 1) ->> 'week_start', 'ratio_id', v_rows -> (v_limit - 1) ->> 'ratio_id');
  end if;
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'key_ratios', p_from, p_to, v_between, v_level, v_cols, v_win, v_notes),
    'totals', v_totals, 'rows', v_rows, 'next', v_next);
end
$fn$;

-- ---------------------------------------------------------------------------------------------
-- stock_report_dashboard: the cards, the league, GP by type, the key item tiles and the attention
-- rows in one answer. Also for the service role (the Owner app).
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_report_dashboard(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
                                                         p_after jsonb default null, p_limit integer default 1000)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_g        jsonb := public.stock_report_guard(p_org, p_sites);
  v_o        jsonb := coalesce(p_opts, '{}'::jsonb);
  v_limit    integer := public.stock_rp__page_cap(p_limit);
  v_between  boolean := coalesce(nullif(v_o ->> 'between_counts', '')::boolean, false);
  v_win      jsonb;
  v_fig      jsonb;
  v_league   jsonb;
  v_keys     jsonb;
  v_att      jsonb;
  v_type     jsonb;
  v_cols     jsonb;
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, v_between);
  v_fig := public.stock_rp__site_figures(v_g, v_win);
  v_league := (select coalesce(jsonb_agg(t), '[]'::jsonb)
                 from (select t from jsonb_array_elements(public.stock_rp__totals(p_org, public.stock_rp__league_rows(v_fig), public.stock_rp__league_keep())) t
                        where jsonb_typeof(t -> 'location_id') = 'string' limit 1000) z);
  v_keys := public.stock_report_key_ratios(p_org, p_sites, p_from, p_to, null, null, v_limit);
  v_att := public.stock_report_attention(p_org, p_sites, p_from, p_to, null, null, v_limit);
  -- GP by type: food, drink, other (sales and product theo by the menu category accounting group).
  -- The GP of a type is over the days its plate cost is known (from each site's takes_from: known_net
  -- and theo_cost); its sales are every day's. A currency with a site whose window holds a demo
  -- check shows its types as not known (demo_sales), never a GP over demo takings.
  with w as (
    select (x ->> 'location_id')::uuid as loc, x ->> 'currency' as currency, (x ->> 'from_day')::date as from_day, (x ->> 'to_day')::date as to_day,
           (x ->> 'takes_from')::date as kf,
           coalesce((x ->> 'demo_sales')::boolean, false) and not coalesce((x ->> 'snapshot')::boolean, false) as sd
      from jsonb_array_elements(v_win) x where x ->> 'from_day' is not null
  ),
  g as (
    select w.loc, w.currency, s.menu_item_id, sum(s.net) as net,
           sum(s.net) filter (where s.business_day >= w.kf) as kn,
           sum(s.theo_cost) filter (where s.business_day >= w.kf) as theo
      from w join sales_day_sums s on s.location_id = w.loc and s.business_day between w.from_day and w.to_day
     where not w.sd
     group by w.loc, w.currency, s.menu_item_id
  ),
  t as (select g.*, public.stock_rp__type_of(g.loc, g.menu_item_id) as type from g)
  select coalesce(jsonb_agg(case when exists (select 1 from w where w.sd and w.currency = z.currency)
                                 then jsonb_build_object('type', z.type, 'currency', z.currency, 'sales_net', null, 'known_net', null, 'theo_cost', null,
                                                         'gp_pct_theo', null, 'actual_cost', null, 'demo_sales', true)
                                 else jsonb_build_object('type', z.type, 'currency', z.currency, 'sales_net', z.net, 'known_net', z.kn,
                                                         'theo_cost', case when z.kn is null then null else coalesce(z.theo, 0) end,
                                                         'gp_pct_theo', public.stock_rp__pct(z.kn - coalesce(z.theo, 0), z.kn), 'actual_cost', null, 'demo_sales', false) end
                            order by z.currency, case z.type when 'food' then 1 when 'drink' then 2 else 3 end), '[]'::jsonb)
    into v_type
    from (select t.type, t.currency, sum(t.net) as net, sum(t.kn) as kn, sum(t.theo) as theo from t group by t.type, t.currency) z;
  v_cols := jsonb_build_array(
    public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('sales_net', 'Sales', 'money'), public.stock_rp__col('sales_with_recipe_pct', 'With a recipe %', 'pct'),
    public.stock_rp__col('theo_cost', 'Theoretical cost', 'money'), public.stock_rp__col('theo_pct', 'Theoretical cost %', 'pct'),
    public.stock_rp__col('actual_cost', 'Actual cost', 'money'), public.stock_rp__col('actual_pct', 'Actual cost %', 'pct'),
    public.stock_rp__col('gp_pct_theo', 'GP % theo', 'pct'), public.stock_rp__col('gp_pct_actual', 'GP % actual', 'pct'),
    public.stock_rp__col('gap_value', 'Gap', 'money'), public.stock_rp__col('gap_pct', 'Gap %', 'pct'),
    public.stock_rp__col('waste_value', 'Waste', 'money'), public.stock_rp__col('waste_pct', 'Waste %', 'pct'),
    public.stock_rp__col('unaccounted', 'Unaccounted', 'money'), public.stock_rp__col('surplus', 'Surplus', 'money'),
    public.stock_rp__col('comps_cost', 'Loyalty, staff and comps', 'money'), public.stock_rp__col('comps_pct', 'Loyalty, staff and comps %', 'pct'),
    public.stock_rp__col('purchases', 'Purchases', 'money'), public.stock_rp__col('budget', 'Budget', 'money'),
    public.stock_rp__col('stock_value_now', 'Stock value now', 'money'), public.stock_rp__col('days_on_hand', 'Days on hand', 'qty'),
    public.stock_rp__col('not_posted_count', 'Sales not yet posted', 'qty'), public.stock_rp__col('not_posted_value', 'Not yet posted value', 'money'));
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'dashboard', p_from, p_to, v_between, 'site', v_cols, v_win,
              jsonb_build_array('Purchases at delivery value until the purchasing update') || public.stock_rp__fig_notes(v_fig)),
    'totals', public.stock_rp__totals(p_org, v_fig,
                array['sales_net', 'sales_with_recipe_pct', 'theo_cost', 'theo_pct', 'actual_cost', 'actual_pct', 'gp_pct_theo', 'gp_pct_actual',
                      'gap_value', 'gap_pct', 'waste_value', 'waste_pct', 'unaccounted', 'surplus', 'comps_cost', 'comps_pct', 'purchases', 'budget',
                      'stock_value_now', 'days_on_hand', 'not_posted_count', 'not_posted_value', 'opening_counted', 'closing_counted', 'window_missing', 'snapshot']),
    'rows', jsonb_build_object('league', v_league, 'by_type', v_type, 'key_items', v_keys -> 'totals', 'attention', v_att -> 'rows'),
    'next', null);
end
$fn$;

-- ---------------------------------------------------------------------------------------------
-- stock_report_movement: opening to closing per site; items at one site; every movement of one item.
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_report_movement(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
                                                        p_after jsonb default null, p_limit integer default 1000)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_g        jsonb := public.stock_report_guard(p_org, p_sites);
  v_o        jsonb := coalesce(p_opts, '{}'::jsonb);
  v_limit    integer := public.stock_rp__page_cap(p_limit);
  v_between  boolean := coalesce(nullif(v_o ->> 'between_counts', '')::boolean, false);
  v_level    text := coalesce(nullif(v_o ->> 'level', ''), 'site');
  v_site     uuid := public.stock_rp__opt_site(v_g, v_o);
  v_item     uuid := nullif(v_o ->> 'item_id', '')::uuid;
  v_win      jsonb;
  v_fig      jsonb;
  v_rows     jsonb := '[]'::jsonb;
  v_next     jsonb;
  v_cols     jsonb;
  v_from     date;
  v_to       date;
  v_n        integer;
  v_keep     text[] := array['opening_value', 'opening_counted', 'received', 'from_kitchen', 'transfers_in', 'made', 'sold_cost', 'used_in_batches',
                             'transfers_out', 'waste_value', 'revalue', 'count_adj', 'expected_closing', 'closing_value', 'closing_counted', 'gap',
                             'opening_balance', 'other', 'from_day', 'to_day', 'window_missing', 'snapshot'];
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  if v_level not in ('site', 'item', 'movement') then
    v_level := 'site';
  end if;
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, v_between);
  v_fig := (select coalesce(jsonb_agg(r || jsonb_build_object('from_kitchen', null)), '[]'::jsonb)
              from jsonb_array_elements(public.stock_rp__site_figures(v_g, v_win)) r);
  v_cols := jsonb_build_array(
    public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('opening_value', 'Opening', 'money'),
    public.stock_rp__col('received', 'Received', 'money'), public.stock_rp__col('from_kitchen', 'From central kitchen', 'money'),
    public.stock_rp__col('transfers_in', 'Transfers in', 'money'), public.stock_rp__col('made', 'Made', 'money'),
    public.stock_rp__col('sold_cost', 'Sold (theoretical)', 'money'), public.stock_rp__col('used_in_batches', 'Used in batches', 'money'),
    public.stock_rp__col('transfers_out', 'Transfers out', 'money'), public.stock_rp__col('waste_value', 'Wasted', 'money'),
    public.stock_rp__col('revalue', 'Revalued', 'money'), public.stock_rp__col('count_adj', 'Count adjustments', 'money'),
    public.stock_rp__col('opening_balance', 'Opening balances loaded', 'money'), public.stock_rp__col('other', 'Refunds given back and other', 'money'),
    public.stock_rp__col('expected_closing', 'Expected closing', 'money'), public.stock_rp__col('closing_value', 'Counted closing', 'money'),
    public.stock_rp__col('gap', 'Gap', 'money'));
  if v_level = 'item' then
    if v_site is null then
      raise exception 'Pick 1 to 50 sites.' using errcode = '22023';
    end if;
    select (x ->> 'from_day')::date, (x ->> 'to_day')::date into v_from, v_to
      from jsonb_array_elements(v_win) x where (x ->> 'location_id')::uuid = v_site;
    v_cols := jsonb_build_array(public.stock_rp__col('name', 'Item', 'text'), public.stock_rp__col('unit', 'Unit', 'text')) || (v_cols - 0);
    if v_from is not null then
      with cl as (select * from public.stock_rp__value_at(array[v_site], v_to)),
      op as (select * from public.stock_rp__value_at(array[v_site], v_from - 1)),
      s as (
        select d.inventory_item_id, public.stock_rp__bucket(d.movement_type, d.source_type) as bucket, sum(d.value) as v, sum(d.qty_base) as q
          from stock_day_sums d
         where d.location_id = v_site and d.business_day between v_from and v_to and d.demo = false
         group by d.inventory_item_id, public.stock_rp__bucket(d.movement_type, d.source_type)
      ),
      r as (
        select i.id, i.company_ref, i.name, i.base_unit, i.archived_at is not null as archived,
               op.value as opening_value, op.qty as opening_qty, cl.value as closing_value, cl.qty as closing_qty,
               coalesce(sum(s.v) filter (where s.bucket = 'received'), 0) as received,
               coalesce(sum(s.v) filter (where s.bucket = 'transfer_in'), 0) as transfers_in,
               coalesce(-sum(s.v) filter (where s.bucket = 'transfer_out'), 0) as transfers_out,
               coalesce(sum(s.v) filter (where s.bucket = 'made'), 0) as made,
               coalesce(-sum(s.v) filter (where s.bucket = 'used'), 0) as used,
               coalesce(-sum(s.v) filter (where s.bucket = 'sold'), 0) as sold,
               coalesce(-sum(s.v) filter (where s.bucket = 'waste'), 0) as waste,
               coalesce(sum(s.v) filter (where s.bucket = 'revalue'), 0) as revalue,
               coalesce(sum(s.v) filter (where s.bucket = 'count_adj'), 0) as count_adj,
               coalesce(sum(s.v) filter (where s.bucket = 'opening_balance'), 0) as opening_balance,
               coalesce(sum(s.v) filter (where s.bucket = 'other'), 0) as other,
               coalesce(-sum(s.q) filter (where s.bucket = 'sold'), 0) as sold_qty
          from inventory_items i
          left join cl on cl.inventory_item_id = i.id
          left join op on op.inventory_item_id = i.id
          left join s on s.inventory_item_id = i.id
         where i.location_id = v_site and (v_item is null or i.company_ref = v_item)
         group by i.id, i.company_ref, i.name, i.base_unit, i.archived_at, op.value, op.qty, cl.value, cl.qty
      ),
      x as (
        select r.*, r.opening_value + r.received + r.opening_balance + r.transfers_in + r.made + r.revalue + r.other - r.sold - r.used - r.transfers_out - r.waste as expected
          from r
         where r.opening_qty <> 0 or r.closing_qty <> 0 or r.received <> 0 or r.sold <> 0 or r.waste <> 0 or r.count_adj <> 0 or r.made <> 0
            or r.used <> 0 or r.transfers_in <> 0 or r.transfers_out <> 0 or r.revalue <> 0 or r.opening_balance <> 0 or r.other <> 0
      ),
      pg as (
        select x.*, public.stock_rp__sk(abs(x.count_adj)) as abs_gap from x
         where p_after is null
            or public.stock_rp__sk(abs(x.count_adj)) < (p_after ->> 'abs_gap')::numeric
            or (public.stock_rp__sk(abs(x.count_adj)) = (p_after ->> 'abs_gap')::numeric and x.id::text > coalesce(p_after ->> 'inventory_item_id', ''))
         order by public.stock_rp__sk(abs(x.count_adj)) desc, x.id
         limit v_limit + 1
      )
      select coalesce(jsonb_agg(jsonb_build_object(
               'location_id', v_site, 'inventory_item_id', pg.id, 'company_item_id', pg.company_ref, 'name', pg.name, 'unit', pg.base_unit, 'archived', pg.archived,
               'opening_value', pg.opening_value, 'opening_qty', pg.opening_qty, 'received', pg.received, 'from_kitchen', null,
               'transfers_in', pg.transfers_in, 'made', pg.made, 'sold_cost', pg.sold, 'sold_qty', pg.sold_qty, 'used_in_batches', pg.used,
               'transfers_out', pg.transfers_out, 'waste_value', pg.waste, 'revalue', pg.revalue, 'count_adj', pg.count_adj, 'opening_balance', pg.opening_balance, 'other', pg.other,
               'expected_closing', pg.expected, 'closing_value', pg.closing_value, 'closing_qty', pg.closing_qty, 'gap', pg.closing_value - pg.expected, 'abs_gap', pg.abs_gap)
               order by pg.abs_gap desc, pg.id), '[]'::jsonb), count(*)
        into v_rows, v_n
        from pg;
      if v_n > v_limit then
        v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
        v_next := jsonb_build_object('abs_gap', (v_rows -> (v_limit - 1) ->> 'abs_gap')::numeric, 'inventory_item_id', v_rows -> (v_limit - 1) ->> 'inventory_item_id');
      end if;
    end if;
  elsif v_level = 'movement' then
    if v_site is null or v_item is null then
      raise exception 'Pick 1 to 50 sites.' using errcode = '22023';
    end if;
    select (x ->> 'from_day')::date, (x ->> 'to_day')::date into v_from, v_to
      from jsonb_array_elements(v_win) x where (x ->> 'location_id')::uuid = v_site;
    v_cols := jsonb_build_array(
      public.stock_rp__col('occurred_at', 'When', 'day'), public.stock_rp__col('movement_type', 'Type', 'text'), public.stock_rp__col('source_type', 'Source', 'text'),
      public.stock_rp__col('qty_base', 'Quantity', 'qty'), public.stock_rp__col('unit_cost', 'Cost each', 'money'), public.stock_rp__col('value_delta', 'Value', 'money'),
      public.stock_rp__col('notes', 'Notes', 'text'));
    if v_from is not null then
      with m as (
        select m.id, m.occurred_at, d.business_day, m.movement_type, m.source_type, m.source_id, m.qty_base, m.unit_cost, m.value_delta, m.notes, m.created_by
          from stock_movements m
          join inventory_items i on i.id = m.inventory_item_id and i.location_id = v_site and i.company_ref = v_item
         cross join lateral public.stock_co__venue_day(m.location_id, m.occurred_at) d
         where m.location_id = v_site and not public.stock_rp__is_demo(m.idempotency_key)
           and d.business_day between v_from and v_to
      ),
      pg as (
        select m.* from m
         where p_after is null
            or m.occurred_at > (p_after ->> 'occurred_at')::timestamptz
            or (m.occurred_at = (p_after ->> 'occurred_at')::timestamptz and m.id::text > coalesce(p_after ->> 'id', ''))
         order by m.occurred_at, m.id
         limit v_limit + 1
      )
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', pg.id, 'occurred_at', pg.occurred_at, 'business_day', pg.business_day, 'movement_type', pg.movement_type, 'source_type', pg.source_type,
               'source_id', pg.source_id, 'qty_base', pg.qty_base, 'unit_cost', pg.unit_cost, 'value_delta', pg.value_delta, 'notes', pg.notes,
               'document', jsonb_build_object(
                 'kind', case pg.movement_type when 'SALE_DEPLETION' then 'sale' when 'RETURN' then 'refund' when 'PURCHASE_RECEIPT' then 'delivery'
                              when 'WASTE' then 'waste' when 'STOCK_COUNT_ADJ' then 'count' when 'OPENING_BALANCE' then 'count'
                              when 'TRANSFER_IN' then 'transfer' when 'TRANSFER_OUT' then 'transfer' when 'PRODUCTION_CONSUME' then 'batch'
                              when 'PRODUCTION_OUTPUT' then 'batch' when 'REVALUE' then 'revalue' else 'other' end,
                 'ref', pg.source_id,
                 'who', (select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), '')) from user_profiles p where p.id = pg.created_by)))
               order by pg.occurred_at, pg.id), '[]'::jsonb), count(*)
        into v_rows, v_n
        from pg;
      if v_n > v_limit then
        v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
        v_next := jsonb_build_object('occurred_at', v_rows -> (v_limit - 1) ->> 'occurred_at', 'id', v_rows -> (v_limit - 1) ->> 'id');
      end if;
    end if;
  else
    v_rows := (select coalesce(jsonb_agg(t), '[]'::jsonb) from (select t from jsonb_array_elements(public.stock_rp__totals(p_org, v_fig, v_keep)) t
                                                                  where jsonb_typeof(t -> 'location_id') = 'string' limit 1000) z);
  end if;
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'movement', p_from, p_to, v_between, v_level, v_cols, v_win,
              jsonb_build_array('Purchases at delivery value until the purchasing update')),
    'totals', public.stock_rp__totals(p_org, v_fig, v_keep),
    'rows', v_rows, 'next', v_next);
end
$fn$;

-- ---------------------------------------------------------------------------------------------
-- stock_report_gap: theoretical against actual per site; the top items company wide.
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_report_gap(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
                                                   p_after jsonb default null, p_limit integer default 1000)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_g        jsonb := public.stock_report_guard(p_org, p_sites);
  v_o        jsonb := coalesce(p_opts, '{}'::jsonb);
  v_limit    integer := public.stock_rp__page_cap(p_limit);
  v_between  boolean := coalesce(nullif(v_o ->> 'between_counts', '')::boolean, false);
  v_level    text := coalesce(nullif(v_o ->> 'level', ''), 'site');
  v_site     uuid := public.stock_rp__opt_site(v_g, v_o);
  v_cat      uuid := nullif(v_o ->> 'category_id', '')::uuid;
  v_keyonly  boolean := coalesce(nullif(v_o ->> 'key_items_only', '')::boolean, false);
  v_win      jsonb;
  v_fig      jsonb;
  v_rows     jsonb := '[]'::jsonb;
  v_next     jsonb;
  v_cols     jsonb;
  v_n        integer;
  v_keep     text[] := array['sales_net', 'gap_value', 'gap_pct', 'positive', 'negative', 'net', 'waste_value', 'unaccounted', 'surplus', 'counted_both_ends',
                             'from_day', 'to_day', 'window_missing', 'snapshot', 'opening_counted', 'closing_counted'];
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  if v_level not in ('site', 'item') then
    v_level := 'site';
  end if;
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, v_between);
  v_fig := (select coalesce(jsonb_agg(r || jsonb_build_object(
                     'positive', (r ->> 'surplus')::numeric, 'negative', (r ->> 'unaccounted')::numeric, 'net', (r ->> 'count_adj')::numeric,
                     'counted_both_ends', (r ->> 'opening_counted')::boolean and (r ->> 'closing_counted')::boolean)), '[]'::jsonb)
              from jsonb_array_elements(public.stock_rp__site_figures(v_g, v_win)) r);
  v_cols := jsonb_build_array(
    public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('sales_net', 'Sales', 'money'), public.stock_rp__col('gap_value', 'Gap', 'money'),
    public.stock_rp__col('gap_pct', 'Gap % of sales', 'pct'), public.stock_rp__col('positive', 'Positive', 'money'), public.stock_rp__col('negative', 'Negative', 'money'),
    public.stock_rp__col('net', 'Net', 'money'), public.stock_rp__col('waste_value', 'Logged waste', 'money'), public.stock_rp__col('unaccounted', 'Unaccounted', 'money'),
    public.stock_rp__col('surplus', 'Surplus', 'money'));
  if v_level = 'item' then
    v_cols := jsonb_build_array(
      public.stock_rp__col('name', 'Item', 'text'), public.stock_rp__col('category', 'Category', 'text'), public.stock_rp__col('gap_value', 'Gap', 'money'),
      public.stock_rp__col('gap_qty', 'Gap quantity', 'qty'), public.stock_rp__col('unit', 'Unit', 'text'), public.stock_rp__col('best_site', 'Best site', 'text'),
      public.stock_rp__col('best_gap', 'Best gap', 'money'), public.stock_rp__col('worst_site', 'Worst site', 'text'), public.stock_rp__col('worst_gap', 'Worst gap', 'money'),
      public.stock_rp__col('use_per_1000', 'Use per 1,000 of sales', 'qty'), public.stock_rp__col('counted_sites', 'Counted at', 'qty'), public.stock_rp__col('not_counted_sites', 'Not counted at', 'qty'));
    with w as (
      select (x ->> 'location_id')::uuid as loc, x ->> 'site' as site, x ->> 'currency' as currency, (x ->> 'from_day')::date as from_day, (x ->> 'to_day')::date as to_day,
             (x ->> 'opening_count_id')::uuid as oc, (x ->> 'closing_count_id')::uuid as cc, coalesce((x ->> 'opening_counted')::boolean, false) and coalesce((x ->> 'closing_counted')::boolean, false) as both,
             coalesce((x ->> 'demo_sales')::boolean, false) and not coalesce((x ->> 'snapshot')::boolean, false) as sd
        from jsonb_array_elements(v_win) x
       where x ->> 'from_day' is not null and (v_site is null or (x ->> 'location_id')::uuid = v_site)
    ),
    -- a site whose window holds a demo check gives no sales to the use per 1,000 of sales
    sn as (select w.loc, w.currency, case when w.sd then null else coalesce(f.sales_net, 0) end as sales_net from w left join public.stock_rp__site_sales(v_win) f on f.location_id = w.loc),
    d as (
      select w.loc, s.company_item_id, s.inventory_item_id,
             sum(s.value) filter (where s.movement_type = 'STOCK_COUNT_ADJ') as gap_value,
             sum(s.qty_base) filter (where s.movement_type = 'STOCK_COUNT_ADJ') as gap_qty,
             -sum(s.qty_base) filter (where s.movement_type = 'SALE_DEPLETION' and s.source_type = 'closed_check') as sold_qty
        from w join stock_day_sums s on s.location_id = w.loc and s.business_day between w.from_day and w.to_day and s.demo = false
       where s.company_item_id is not null
       group by w.loc, s.company_item_id, s.inventory_item_id
    ),
    per_site as (
      select d.loc, w.site, w.currency, d.company_item_id,
             w.both and exists (select 1 from stock_count_lines l where l.count_id = w.oc and l.inventory_item_id = d.inventory_item_id and l.counted_qty is not null)
                    and exists (select 1 from stock_count_lines l where l.count_id = w.cc and l.inventory_item_id = d.inventory_item_id and l.counted_qty is not null) as counted,
             coalesce(d.gap_value, 0) as gap_value, coalesce(d.gap_qty, 0) as gap_qty, case when sn.sales_net is null then null else coalesce(d.sold_qty, 0) end as sold_qty, sn.sales_net
        from d join w on w.loc = d.loc join sn on sn.loc = d.loc
    ),
    it as (
      select ps.company_item_id, ps.currency, ps.currency || ':' || ps.company_item_id::text as key, ci.name, ci.base_unit, cat.name as category, ci.key_item,
             sum(ps.gap_value) filter (where ps.counted) as gap_value, sum(ps.gap_qty) filter (where ps.counted) as gap_qty,
             count(*) filter (where ps.counted) as counted_sites, count(*) filter (where not ps.counted) as not_counted_sites,
             (select z.site from per_site z where z.company_item_id = ps.company_item_id and z.currency = ps.currency and z.counted order by z.gap_value desc, z.site limit 1) as best_site,
             max(ps.gap_value) filter (where ps.counted) as best_gap,
             (select z.site from per_site z where z.company_item_id = ps.company_item_id and z.currency = ps.currency and z.counted order by z.gap_value asc, z.site limit 1) as worst_site,
             min(ps.gap_value) filter (where ps.counted) as worst_gap,
             case when coalesce(sum(ps.sales_net), 0) = 0 then null else round(sum(ps.sold_qty) / (sum(ps.sales_net) / 1000), 4) end as use_per_1000
        from per_site ps
        join stock_co_items ci on ci.id = ps.company_item_id
        left join stock_co_categories cat on cat.id = ci.category_id
       where (v_cat is null or ci.category_id = v_cat) and (not v_keyonly or ci.key_item)
       group by ps.company_item_id, ps.currency, ci.name, ci.base_unit, cat.name, ci.key_item
    ),
    pg as (
      select it.* from it
       where p_after is null
          or public.stock_rp__sk(it.gap_value) > (p_after ->> 'gap_value')::numeric
          or (public.stock_rp__sk(it.gap_value) = (p_after ->> 'gap_value')::numeric and it.key > coalesce(p_after ->> 'key', ''))
       order by public.stock_rp__sk(it.gap_value), it.key
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'company_item_id', pg.company_item_id, 'currency', pg.currency, 'key', pg.key, 'name', pg.name, 'category', pg.category, 'key_item', pg.key_item,
             'gap_value', coalesce(pg.gap_value, 0), 'gap_qty', pg.gap_qty, 'unit', pg.base_unit, 'best_site', pg.best_site, 'best_gap', pg.best_gap,
             'worst_site', pg.worst_site, 'worst_gap', pg.worst_gap, 'use_per_1000', pg.use_per_1000, 'counted_sites', pg.counted_sites, 'not_counted_sites', pg.not_counted_sites,
             'not_counted', pg.counted_sites = 0)
             order by public.stock_rp__sk(pg.gap_value), pg.key), '[]'::jsonb), count(*)
      into v_rows, v_n
      from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('gap_value', public.stock_rp__sk((v_rows -> (v_limit - 1) ->> 'gap_value')::numeric), 'company_item_id', v_rows -> (v_limit - 1) ->> 'company_item_id',
                                   'key', v_rows -> (v_limit - 1) ->> 'key');
    end if;
  else
    v_rows := (select coalesce(jsonb_agg(t), '[]'::jsonb) from (select t from jsonb_array_elements(public.stock_rp__totals(p_org, v_fig, v_keep)) t
                                                                  where jsonb_typeof(t -> 'location_id') = 'string' limit 1000) z);
  end if;
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'gap', p_from, p_to, v_between, v_level, v_cols, v_win, '[]'::jsonb),
    'totals', public.stock_rp__totals(p_org, v_fig, v_keep),
    'rows', v_rows, 'next', v_next);
end
$fn$;

-- The cogs totals: the common totals plus labour percent and flash GP on every row.
create or replace function public.stock_rp__cogs_rows(p_org uuid, p_fig jsonb, p_keep text[])
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(jsonb_agg(
           t || jsonb_build_object(
             'labour_pct', case when (t ->> 'labour') is null then null else public.stock_rp__pct((t ->> 'labour')::numeric, (t ->> 'sales_net')::numeric) end,
             'flash_gp_pct', case when (t ->> 'labour') is null or (t ->> 'gp_pct_actual') is null then null
                                  else (t ->> 'gp_pct_actual')::numeric - public.stock_rp__pct((t ->> 'labour')::numeric, (t ->> 'sales_net')::numeric) end)
           order by o.n), '[]'::jsonb)
    from jsonb_array_elements(public.stock_rp__totals(p_org, p_fig, p_keep || array['labour', 'labour_has_data'])) with ordinality as o(t, n);
$fn$;

-- ---------------------------------------------------------------------------------------------
-- stock_report_cogs: cost of sales and GP per site with the loyalty, staff and comps line; by week; by type.
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_report_cogs(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
                                                    p_after jsonb default null, p_limit integer default 1000)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_g        jsonb := public.stock_report_guard(p_org, p_sites);
  v_o        jsonb := coalesce(p_opts, '{}'::jsonb);
  v_limit    integer := public.stock_rp__page_cap(p_limit);
  v_between  boolean := coalesce(nullif(v_o ->> 'between_counts', '')::boolean, false);
  v_level    text := coalesce(nullif(v_o ->> 'level', ''), 'site');
  v_week     smallint := coalesce((v_g ->> 'week_start')::smallint, 1);
  v_win      jsonb;
  v_fig      jsonb;
  v_rows     jsonb := '[]'::jsonb;
  v_next     jsonb;
  v_cols     jsonb;
  v_n        integer;
  v_keep     text[] := array['sales_net', 'theo_cost', 'theo_pct', 'actual_cost', 'actual_pct', 'comps_cost', 'loyalty_cost', 'staff_cost', 'comp_cost', 'comps_qty',
                             'gp_before', 'gp_after', 'gp_pct_theo', 'gp_pct_actual', 'labour', 'labour_pct', 'flash_gp_pct', 'labour_has_data',
                             'from_day', 'to_day', 'window_missing', 'snapshot', 'opening_counted', 'closing_counted', 'takes_from'];
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  if v_level not in ('site', 'week', 'type') then
    v_level := 'site';
  end if;
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, v_between);
  v_fig := (select coalesce(jsonb_agg(r || jsonb_build_object('labour', case when lb.has_data then lb.pay end, 'labour_has_data', lb.has_data)), '[]'::jsonb)
              from jsonb_array_elements(public.stock_rp__site_figures(v_g, v_win)) r
             cross join lateral public.stock_rp__labour((r ->> 'location_id')::uuid, coalesce((r ->> 'from_day')::date, p_from), coalesce((r ->> 'to_day')::date, p_to)) lb);
  -- labour percent and flash GP on every row (site and company)
  v_cols := jsonb_build_array(
    public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('sales_net', 'Net sales', 'money'), public.stock_rp__col('theo_cost', 'Theoretical cost', 'money'),
    public.stock_rp__col('theo_pct', 'Theoretical %', 'pct'), public.stock_rp__col('actual_cost', 'Actual cost', 'money'), public.stock_rp__col('actual_pct', 'Actual %', 'pct'),
    public.stock_rp__col('comps_cost', 'Loyalty, staff and comps', 'money'), public.stock_rp__col('loyalty_cost', 'Loyalty', 'money'),
    public.stock_rp__col('staff_cost', 'Staff', 'money'), public.stock_rp__col('comp_cost', 'Comps', 'money'), public.stock_rp__col('comps_qty', 'Items', 'qty'),
    public.stock_rp__col('gp_before', 'GP before', 'money'), public.stock_rp__col('gp_after', 'GP after', 'money'),
    public.stock_rp__col('gp_pct_theo', 'GP % theo', 'pct'), public.stock_rp__col('gp_pct_actual', 'GP % actual', 'pct'),
    public.stock_rp__col('labour', 'Labour', 'money'), public.stock_rp__col('labour_pct', 'Labour %', 'pct'), public.stock_rp__col('flash_gp_pct', 'Flash GP %', 'pct'));
  if v_level = 'week' then
    -- theoretical cost as the site rows take it: the takes' from takes_from on (on the day the check
    -- closed), the ledger's sale take off before it; a site whose window holds a demo check shows its
    -- weeks' sales and GP as not known
    with w as (
      select (x ->> 'location_id')::uuid as loc, x ->> 'site' as site, x ->> 'currency' as currency, (x ->> 'from_day')::date as from_day, (x ->> 'to_day')::date as to_day,
             (x ->> 'takes_from')::date as kf,
             coalesce((x ->> 'demo_sales')::boolean, false) and not coalesce((x ->> 'snapshot')::boolean, false) as sd
        from jsonb_array_elements(v_win) x where x ->> 'from_day' is not null
    ),
    s as (
      select w.loc, w.site, w.currency, public.stock_rp__week_of(d.business_day, v_week) as wk, sum(d.net) as net,
             sum(d.theo_cost) filter (where d.business_day >= w.kf) as ktheo
        from w join sales_day_sums d on d.location_id = w.loc and d.business_day between w.from_day and w.to_day
       group by w.loc, w.site, w.currency, 4
    ),
    k as (
      select w.loc, public.stock_rp__week_of(d.business_day, v_week) as wk,
             -sum(d.value) filter (where d.movement_type = 'SALE_DEPLETION' and d.source_type = 'closed_check' and (w.kf is null or d.business_day < w.kf)) as theo_old,
             -sum(d.value) filter (where d.movement_type in ('SALE_DEPLETION', 'RETURN', 'PRODUCTION_CONSUME', 'PRODUCTION_OUTPUT', 'WASTE', 'STOCK_COUNT_ADJ', 'REVALUE')) as actual
        from w join stock_day_sums d on d.location_id = w.loc and d.business_day between w.from_day and w.to_day and d.demo = false
       group by w.loc, 2
    ),
    r as (
      select coalesce(s.loc, k.loc) as loc, coalesce(s.site, w.site) as site, coalesce(s.currency, w.currency) as currency, coalesce(s.wk, k.wk) as wk,
             case when w.sd then null else coalesce(s.net, 0) end as net,
             case when w.sd then null else coalesce(k.theo_old, 0) + coalesce(s.ktheo, 0) end as theo,
             coalesce(k.actual, 0) as actual
        from s full join k on k.loc = s.loc and k.wk = s.wk
        join w on w.loc = coalesce(s.loc, k.loc)
    ),
    pg as (
      select r.* from r
       where p_after is null
          or (r.loc::text, r.wk::text) > (coalesce(p_after ->> 'location_id', ''), coalesce(p_after ->> 'week_start', ''))
       order by r.loc::text, r.wk
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'location_id', pg.loc, 'site', pg.site, 'currency', pg.currency, 'week_start', pg.wk, 'sales_net', pg.net, 'theo_cost', pg.theo, 'actual_cost', pg.actual,
             'gp_pct_theo', public.stock_rp__pct(pg.net - pg.theo, pg.net), 'gp_pct_actual', public.stock_rp__pct(pg.net - pg.actual, pg.net),
             'target_gp', (select coalesce((select t.green_to from stock_targets t where t.org_id = p_org and t.metric = 'gp_pct' and t.location_id = pg.loc),
                                           (select t.green_to from stock_targets t where t.org_id = p_org and t.metric = 'gp_pct' and t.location_id is null), 70)))
             order by pg.loc::text, pg.wk), '[]'::jsonb), count(*)
      into v_rows, v_n
      from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('location_id', v_rows -> (v_limit - 1) ->> 'location_id', 'week_start', v_rows -> (v_limit - 1) ->> 'week_start');
    end if;
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('week_start', 'Week', 'day'), public.stock_rp__col('sales_net', 'Net sales', 'money'),
      public.stock_rp__col('theo_cost', 'Theoretical cost', 'money'), public.stock_rp__col('actual_cost', 'Actual cost', 'money'),
      public.stock_rp__col('gp_pct_theo', 'GP % theo', 'pct'), public.stock_rp__col('gp_pct_actual', 'GP % actual', 'pct'), public.stock_rp__col('target_gp', 'Target GP %', 'pct'));
  elsif v_level = 'type' then
    -- GP by type over the days the plate cost is known (known_net and theo_cost from takes_from); a
    -- site whose window holds a demo check has no type rows (the notes say why)
    with w as (
      select (x ->> 'location_id')::uuid as loc, x ->> 'site' as site, x ->> 'currency' as currency, (x ->> 'from_day')::date as from_day, (x ->> 'to_day')::date as to_day,
             (x ->> 'takes_from')::date as kf,
             coalesce((x ->> 'demo_sales')::boolean, false) and not coalesce((x ->> 'snapshot')::boolean, false) as sd
        from jsonb_array_elements(v_win) x where x ->> 'from_day' is not null
    ),
    g as (
      select w.loc, w.site, w.currency, d.menu_item_id, sum(d.net) as net,
             sum(d.net) filter (where d.business_day >= w.kf) as kn,
             sum(d.theo_cost) filter (where d.business_day >= w.kf) as theo
        from w join sales_day_sums d on d.location_id = w.loc and d.business_day between w.from_day and w.to_day
       where not w.sd
       group by w.loc, w.site, w.currency, d.menu_item_id
    ),
    t as (select g.loc, g.site, g.currency, public.stock_rp__type_of(g.loc, g.menu_item_id) as type, sum(g.net) as net, sum(g.kn) as kn, sum(g.theo) as theo
            from g group by g.loc, g.site, g.currency, 4)
    select coalesce(jsonb_agg(jsonb_build_object('location_id', t.loc, 'site', t.site, 'currency', t.currency, 'type', t.type, 'sales_net', t.net,
                                                 'known_net', t.kn, 'theo_cost', case when t.kn is null then null else coalesce(t.theo, 0) end,
                                                 'gp_pct_theo', public.stock_rp__pct(t.kn - coalesce(t.theo, 0), t.kn))
                              order by t.site, t.loc, case t.type when 'food' then 1 when 'drink' then 2 else 3 end), '[]'::jsonb)
      into v_rows
      from t;
    v_rows := (select coalesce(jsonb_agg(r), '[]'::jsonb) from (select r from jsonb_array_elements(v_rows) r limit 1000) z);
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('type', 'Type', 'text'), public.stock_rp__col('sales_net', 'Net sales', 'money'),
      public.stock_rp__col('known_net', 'Sales with plate cost', 'money'),
      public.stock_rp__col('theo_cost', 'Theoretical cost', 'money'), public.stock_rp__col('gp_pct_theo', 'GP % theo', 'pct'));
  else
    v_rows := (select coalesce(jsonb_agg(t), '[]'::jsonb) from (select t from jsonb_array_elements(public.stock_rp__cogs_rows(p_org, v_fig, v_keep)) t
                                                                  where jsonb_typeof(t -> 'location_id') = 'string' limit 1000) z);
  end if;
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'cogs', p_from, p_to, v_between, v_level, v_cols, v_win, public.stock_rp__fig_notes(v_fig)),
    'totals', public.stock_rp__cogs_rows(p_org, v_fig, v_keep),
    'rows', v_rows, 'next', v_next);
end
$fn$;


-- ---------------------------------------------------------------------------------------------
-- stock_report_value: stock value at the end of any day, by site, category, area (today only) or
-- legal company; negative stock and archived items still holding stock apart.
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_report_value(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
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
  v_view   text := coalesce(nullif(v_o ->> 'view', ''), 'category');
  v_at     date := coalesce(nullif(v_o ->> 'at_day', '')::date, p_to);
  v_site   uuid := public.stock_rp__opt_site(v_g, v_o);
  v_sites  uuid[];
  v_win    jsonb;
  v_val    jsonb;
  v_site_rows jsonb;
  v_rows   jsonb := '[]'::jsonb;
  v_next   jsonb;
  v_cols   jsonb;
  v_n      integer;
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  if v_level not in ('site', 'category', 'item') then
    v_level := 'site';
  end if;
  if v_view not in ('category', 'area', 'legal') then
    v_view := 'category';
  end if;
  if v_view = 'area' and v_at <> current_date then
    raise exception 'By area is today only.' using errcode = '22023';
  end if;
  v_sites := array(select (x ->> 'id')::uuid from jsonb_array_elements(v_g -> 'sites') x where v_site is null or (x ->> 'id')::uuid = v_site);
  -- the window of this report is the one day; a locked period ending that day gives its snapshot
  v_win := (select coalesce(jsonb_agg(jsonb_build_object(
              'location_id', (x ->> 'id')::uuid, 'from_day', v_at, 'to_day', v_at, 'opening_counted', false,
              'closing_counted', exists (select 1 from stock_counts c cross join lateral public.stock_co__venue_day(c.location_id, c.approved_at) d
                                          where c.location_id = (x ->> 'id')::uuid and c.status = 'APPROVED' and c.approved_at is not null and d.business_day = v_at),
              'window_missing', false,
              'snapshot', exists (select 1 from stock_periods p where p.location_id = (x ->> 'id')::uuid and p.to_day = v_at and p.locked_at is not null and p.unlocked_at is null),
              'part_locked', exists (select 1 from stock_periods p where p.location_id = (x ->> 'id')::uuid and p.locked_at is not null and p.unlocked_at is null
                                      and p.from_day <= v_at and p.to_day > v_at),
              'takes_from', public.stock_rp__takes_from((x ->> 'id')::uuid),
              'snap', (select s.metrics from stock_periods p join stock_period_snapshots s on s.period_id = p.id and s.location_id = p.location_id
                        where p.location_id = (x ->> 'id')::uuid and p.to_day = v_at and p.locked_at is not null and p.unlocked_at is null
                        order by p.locked_at desc limit 1)) order by x ->> 'name'), '[]'::jsonb)
             from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = any(v_sites));
  -- per item value at the day, with the company category
  v_val := (select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) from (
    select v.location_id, v.inventory_item_id, v.company_item_id, i.name, i.base_unit as unit, i.archived_at is not null as archived,
           ci.category_id, coalesce(cat.name, nullif(btrim(i.category), ''), 'No category') as category, v.qty, coalesce(i.current_cost, 0) as cost, v.value
      from public.stock_rp__value_at(v_sites, v_at) v
      join inventory_items i on i.id = v.inventory_item_id
      left join stock_co_items ci on ci.id = v.company_item_id
      left join stock_co_categories cat on cat.id = ci.category_id) z);
  -- site rows
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', s.id, 'site', s.name, 'currency', s.currency, 'at_day', v_at,
           'stock_value', public.stock_rp__snap_num(w.snap, 'closing_value', coalesce(z.pos, 0)),
           'negative_value', coalesce(z.neg, 0), 'archived_holding_value', coalesce(z.arch, 0), 'items', coalesce(z.items, 0),
           'counted', coalesce((w.w ->> 'closing_counted')::boolean, false), 'snapshot', coalesce((w.w ->> 'snapshot')::boolean, false),
           'legal_company', coalesce((select x.tenant_name from xero_connections x where x.location_id = s.id order by x.updated_at desc limit 1), 'Not connected to Xero'),
           'by_category', case when w.snap is not null and jsonb_typeof(w.snap -> 'by_category') = 'array' then w.snap -> 'by_category'
                               else coalesce((select jsonb_agg(jsonb_build_object('category_id', c.category_id, 'name', c.category, 'value', c.v) order by c.v desc, c.category)
                                                from (select t.category_id, t.category, sum(case when t.value > 0 then t.value else 0 end) as v
                                                        from jsonb_to_recordset(v_val) as t(location_id uuid, inventory_item_id uuid, company_item_id uuid, name text, unit text, archived boolean, category_id uuid, category text, qty numeric, cost numeric, value numeric) where t.location_id = s.id group by t.category_id, t.category) c), '[]'::jsonb) end,
           'by_area', case when v_view = 'area' then
                        (select coalesce(jsonb_agg(jsonb_build_object('area_id', a.area_id, 'name', sa.name, 'value', a.v) order by a.v desc), '[]'::jsonb)
                           from (select st.area_id, sum(st.on_hand * coalesce(i.current_cost, 0)) as v
                                   from inventory_item_area_stock st join inventory_items i on i.id = st.inventory_item_id
                                  where st.location_id = s.id group by st.area_id) a
                           left join storage_areas sa on sa.id = a.area_id) end)
           order by s.name, s.id), '[]'::jsonb)
    into v_site_rows
    from (select (x ->> 'id')::uuid as id, x ->> 'name' as name, x ->> 'currency' as currency from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = any(v_sites)) s
    left join (select t.location_id, sum(case when t.value > 0 then t.value else 0 end) as pos, sum(case when t.value < 0 then t.value else 0 end) as neg,
                      sum(case when t.archived and t.qty <> 0 then t.value else 0 end) as arch, count(*) filter (where t.qty <> 0) as items
                 from jsonb_to_recordset(v_val) as t(location_id uuid, inventory_item_id uuid, company_item_id uuid, name text, unit text, archived boolean, category_id uuid, category text, qty numeric, cost numeric, value numeric) group by t.location_id) z on z.location_id = s.id
    left join lateral (select x as w, case when jsonb_typeof(x -> 'snap') = 'object' then x -> 'snap' end as snap from jsonb_array_elements(v_win) x where (x ->> 'location_id')::uuid = s.id) w on true;
  v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('stock_value', 'Stock value', 'money'),
    public.stock_rp__col('negative_value', 'Negative stock', 'money'), public.stock_rp__col('archived_holding_value', 'Archived items still holding stock', 'money'),
    public.stock_rp__col('items', 'Items', 'qty'), public.stock_rp__col('counted', 'Counted', 'text'));
  if v_level = 'item' then
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('name', 'Item', 'text'), public.stock_rp__col('category', 'Category', 'text'),
      public.stock_rp__col('qty', 'On hand', 'qty'), public.stock_rp__col('unit', 'Unit', 'text'), public.stock_rp__col('cost', 'Cost here', 'money'),
      public.stock_rp__col('value', 'Value', 'money'), public.stock_rp__col('archived', 'Archived', 'text'));
    with pg as (
      select t.*, (select x ->> 'name' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = t.location_id) as site
        from jsonb_to_recordset(v_val) as t(location_id uuid, inventory_item_id uuid, company_item_id uuid, name text, unit text, archived boolean, category_id uuid, category text, qty numeric, cost numeric, value numeric)
       where t.qty <> 0 and (nullif(v_o ->> 'category_id', '') is null or t.category_id = (v_o ->> 'category_id')::uuid)
         and (p_after is null or public.stock_rp__sk(t.value) < (p_after ->> 'value')::numeric
              or (public.stock_rp__sk(t.value) = (p_after ->> 'value')::numeric and t.inventory_item_id::text > coalesce(p_after ->> 'inventory_item_id', '')))
       order by public.stock_rp__sk(t.value) desc, t.inventory_item_id
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('location_id', pg.location_id, 'site', pg.site, 'company_item_id', pg.company_item_id, 'inventory_item_id', pg.inventory_item_id,
             'name', pg.name, 'category', pg.category, 'category_id', pg.category_id, 'qty', pg.qty, 'unit', pg.unit, 'cost', pg.cost, 'value', pg.value, 'archived', pg.archived)
             order by public.stock_rp__sk(pg.value) desc, pg.inventory_item_id), '[]'::jsonb), count(*)
      into v_rows, v_n
      from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('value', public.stock_rp__sk((v_rows -> (v_limit - 1) ->> 'value')::numeric), 'inventory_item_id', v_rows -> (v_limit - 1) ->> 'inventory_item_id');
    end if;
  elsif v_level = 'category' then
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('name', 'Category', 'text'),
      public.stock_rp__col('value', 'Value', 'money'), public.stock_rp__col('items', 'Items', 'qty'));
    with c as (
      select t.location_id, t.category_id, t.category as name, sum(case when t.value > 0 then t.value else 0 end) as value, count(*) filter (where t.qty <> 0) as items,
             (select x ->> 'name' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = t.location_id) as site
        from jsonb_to_recordset(v_val) as t(location_id uuid, inventory_item_id uuid, company_item_id uuid, name text, unit text, archived boolean, category_id uuid, category text, qty numeric, cost numeric, value numeric) group by t.location_id, t.category_id, t.category
    ),
    pg as (
      select c.* from c
       where p_after is null
          or (c.site, c.location_id::text) > (coalesce(p_after ->> 'site', ''), coalesce(p_after ->> 'location_id', ''))
          or ((c.site, c.location_id::text) = (coalesce(p_after ->> 'site', ''), coalesce(p_after ->> 'location_id', ''))
              and (public.stock_rp__sk(c.value) < (p_after ->> 'value')::numeric or (public.stock_rp__sk(c.value) = (p_after ->> 'value')::numeric and c.name > coalesce(p_after ->> 'name', ''))))
       order by c.site, c.location_id::text, public.stock_rp__sk(c.value) desc, c.name
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('location_id', pg.location_id, 'site', pg.site, 'category_id', pg.category_id, 'name', pg.name, 'value', pg.value, 'items', pg.items)
                              order by pg.site, pg.location_id::text, public.stock_rp__sk(pg.value) desc, pg.name), '[]'::jsonb), count(*)
      into v_rows, v_n
      from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('site', v_rows -> (v_limit - 1) ->> 'site', 'location_id', v_rows -> (v_limit - 1) ->> 'location_id',
                                   'value', public.stock_rp__sk((v_rows -> (v_limit - 1) ->> 'value')::numeric), 'name', v_rows -> (v_limit - 1) ->> 'name');
    end if;
  elsif v_view = 'legal' then
    v_cols := jsonb_build_array(public.stock_rp__col('legal_company', 'Legal company', 'text'), public.stock_rp__col('stock_value', 'Stock value', 'money'),
      public.stock_rp__col('negative_value', 'Negative stock', 'money'), public.stock_rp__col('sites', 'Sites', 'qty'));
    select coalesce(jsonb_agg(jsonb_build_object('legal_company', z.legal, 'currency', z.currency, 'stock_value', z.v, 'negative_value', z.neg, 'archived_holding_value', z.arch, 'sites', z.n)
                              order by z.currency, z.legal), '[]'::jsonb)
      into v_rows
      from (select r ->> 'legal_company' as legal, r ->> 'currency' as currency, sum((r ->> 'stock_value')::numeric) as v, sum((r ->> 'negative_value')::numeric) as neg,
                   sum((r ->> 'archived_holding_value')::numeric) as arch, count(*) as n
              from jsonb_array_elements(v_site_rows) r group by 1, 2) z;
  else
    v_rows := (select coalesce(jsonb_agg(r), '[]'::jsonb) from (select r from jsonb_array_elements(v_site_rows) r limit 1000) z);
  end if;
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'value', v_at, v_at, false, v_level, v_cols, v_win, '[]'::jsonb) || jsonb_build_object('at_day', v_at, 'view', v_view),
    'totals', (select coalesce(jsonb_agg(r - 'by_category' - 'by_area' order by o.n), '[]'::jsonb) from jsonb_array_elements(v_site_rows) with ordinality as o(r, n))
              || (select coalesce(jsonb_agg(c || jsonb_build_object('at_day', v_at) order by c ->> 'currency'), '[]'::jsonb)
                    from jsonb_array_elements(public.stock_rp__sum_rows(v_site_rows, array['stock_value', 'negative_value', 'archived_holding_value', 'items'])) c),
    'rows', v_rows, 'next', v_next);
end
$fn$;

-- ---------------------------------------------------------------------------------------------
-- stock_report_product_gp: per product sold, net after spread discounts, plate cost, GP, the plate
-- cost spread across sites and the menu engineering class. Adds up to the site GP. The plate cost and
-- the GP are over the days the plate cost is known (each site's takes_from on): known_qty, known_net
-- and theo_cost are those days', gp is known_net less theo_cost; sold_qty and sales_net are every
-- day's. A site whose window holds a demo check has no product rows and its site row is not known.
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_report_product_gp(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
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
  v_level  text := coalesce(nullif(v_o ->> 'level', ''), 'product');
  v_view   text := coalesce(nullif(v_o ->> 'view', ''), 'gp');
  v_site   uuid := public.stock_rp__opt_site(v_g, v_o);
  v_mid    text := nullif(v_o ->> 'menu_item_id', '');
  v_win    jsonb;
  v_prod   jsonb;
  v_site_rows jsonb;
  v_rows   jsonb := '[]'::jsonb;
  v_next   jsonb;
  v_cols   jsonb;
  v_n      integer;
  v_notes  jsonb := '[]'::jsonb;
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  if v_level not in ('product', 'site_product') then
    v_level := 'product';
  end if;
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, false);
  v_prod := (select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) from (
  with w as (
    select (x ->> 'location_id')::uuid as loc, x ->> 'site' as site, x ->> 'currency' as currency, (x ->> 'from_day')::date as from_day, (x ->> 'to_day')::date as to_day,
           (x ->> 'takes_from')::date as takes_from
      from jsonb_array_elements(v_win) x
     where x ->> 'from_day' is not null and (v_site is null or (x ->> 'location_id')::uuid = v_site)
       and not (coalesce((x ->> 'demo_sales')::boolean, false) and not coalesce((x ->> 'snapshot')::boolean, false))
  ),
  g as (
    select w.loc, w.site, w.currency, s.menu_item_id, sum(s.qty) as qty, sum(s.net) as net,
           sum(s.qty) filter (where s.business_day >= w.takes_from) as kq,
           sum(s.net) filter (where s.business_day >= w.takes_from) as kn,
           sum(s.theo_cost) filter (where s.business_day >= w.takes_from) as theo,
           w.takes_from is not null and w.takes_from <= w.to_day as known
      from w join sales_day_sums s on s.location_id = w.loc and s.business_day between w.from_day and w.to_day
     where v_mid is null or s.menu_item_id = v_mid
     group by w.loc, w.site, w.currency, s.menu_item_id, w.takes_from, w.to_day
  )
  select g.loc as location_id, g.site, g.currency, g.menu_item_id, coalesce(mi.master_id, g.menu_item_id) as product_key, coalesce(mi.name, g.menu_item_id) as name,
         public.stock_rp__type_of(g.loc, g.menu_item_id) as type, g.qty as sold_qty, g.net as sales_net,
         case when g.known then coalesce(g.kq, 0) end as known_qty, case when g.known then coalesce(g.kn, 0) end as known_net,
         case when g.known then g.theo end as theo_cost, g.known
    from g left join menu_items mi on mi.location_id = g.loc::text and mi.id = g.menu_item_id) z);
  -- site rows: sales, the sales with a plate cost, product theo, GP over the known days; known_from.
  -- A site with demo sales in the window: not known (null), with demo_sales true.
  select coalesce(jsonb_agg(case when s.sd then jsonb_build_object(
           'location_id', s.id, 'site', s.name, 'currency', s.currency, 'sales_net', null, 'known_net', null, 'theo_cost', null, 'gp', null, 'gp_pct', null,
           'products', null, 'known_from', null, 'demo_sales', true)
         else jsonb_build_object(
           'location_id', s.id, 'site', s.name, 'currency', s.currency, 'sales_net', coalesce(z.net, 0),
           'known_net', case when s.known then coalesce(z.kn, 0) end, 'theo_cost', case when s.known then coalesce(z.theo, 0) end,
           'gp', case when s.known then coalesce(z.kn, 0) - coalesce(z.theo, 0) end,
           'gp_pct', case when s.known then public.stock_rp__pct(coalesce(z.kn, 0) - coalesce(z.theo, 0), z.kn) end,
           'products', coalesce(z.n, 0), 'known_from', case when s.known then greatest(s.from_day, s.takes_from) end, 'demo_sales', false) end
           order by s.name, s.id), '[]'::jsonb)
    into v_site_rows
    from (select (x ->> 'location_id')::uuid as id, x ->> 'site' as name, x ->> 'currency' as currency, (x ->> 'takes_from')::date as takes_from,
                 (x ->> 'from_day')::date as from_day,
                 x ->> 'takes_from' is not null and x ->> 'to_day' is not null and (x ->> 'takes_from')::date <= (x ->> 'to_day')::date as known,
                 coalesce((x ->> 'demo_sales')::boolean, false) and not coalesce((x ->> 'snapshot')::boolean, false) as sd
            from jsonb_array_elements(v_win) x where v_site is null or (x ->> 'location_id')::uuid = v_site) s
    left join (select p.location_id, sum(p.sales_net) as net, sum(p.known_net) as kn, sum(p.theo_cost) as theo, count(*) as n
                 from jsonb_to_recordset(v_prod) as p(location_id uuid, site text, currency text, menu_item_id text, product_key text, name text, type text, sold_qty numeric,
                                                      sales_net numeric, known_qty numeric, known_net numeric, theo_cost numeric, known boolean)
                group by p.location_id) z on z.location_id = s.id;
  if exists (select 1 from jsonb_array_elements(v_win) x where x ->> 'takes_from' is null or (x ->> 'takes_from')::date > p_from) then
    v_notes := (select coalesce(jsonb_agg('Plate cost not known before ' || coalesce(to_char((x ->> 'takes_from')::date, 'Dy FMDD Mon'), 'the first saved sale') || ' at ' || (x ->> 'site')
                                          || ': GP is over the sales with a plate cost'), '[]'::jsonb)
                  from jsonb_array_elements(v_win) x where x ->> 'takes_from' is null or (x ->> 'takes_from')::date > p_from);
  end if;
  v_cols := jsonb_build_array(public.stock_rp__col('name', 'Product', 'text'), public.stock_rp__col('type', 'Type', 'text'),
    public.stock_rp__col('sold_qty', 'Sold', 'qty'), public.stock_rp__col('sales_net', 'Net sales', 'money'),
    public.stock_rp__col('known_net', 'Sales with plate cost', 'money'), public.stock_rp__col('theo_cost', 'Plate cost', 'money'),
    public.stock_rp__col('gp', 'GP', 'money'), public.stock_rp__col('gp_pct', 'GP %', 'pct'), public.stock_rp__col('plate_cost_avg', 'Plate cost each', 'money'),
    public.stock_rp__col('plate_cost_low', 'Lowest', 'money'), public.stock_rp__col('plate_cost_low_site', 'Lowest at', 'text'),
    public.stock_rp__col('plate_cost_high', 'Highest', 'money'), public.stock_rp__col('plate_cost_high_site', 'Highest at', 'text'),
    public.stock_rp__col('popularity_share', 'Share of units %', 'pct'), public.stock_rp__col('class', 'Class', 'text'));
  if v_level = 'site_product' then
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text')) || v_cols;
  end if;
  -- the product rows (company wide by product key, or per site), with the menu engineering class;
  -- plate cost, GP and the class over the known days only (known_qty, known_net), so the rows add up
  -- to the site rows and a product sold before takes_from is never a GP with no cost
  with pr as (
    select p.location_id, p.site, p.currency, p.menu_item_id, p.product_key, p.name, p.type, p.sold_qty, p.sales_net, p.known_qty, p.known_net, p.theo_cost, p.known,
           case when v_level = 'site_product' then p.location_id end as loc,
           case when v_level = 'site_product' then p.site end as loc_site
      from jsonb_to_recordset(v_prod) as p(location_id uuid, site text, currency text, menu_item_id text, product_key text, name text, type text, sold_qty numeric,
                                           sales_net numeric, known_qty numeric, known_net numeric, theo_cost numeric, known boolean)
  ),
  grp as (
    select pr.loc, pr.loc_site as site, pr.currency, pr.product_key, min(pr.menu_item_id) as menu_item_id, min(pr.name) as name, min(pr.type) as type,
           sum(pr.sold_qty) as sold_qty, sum(pr.sales_net) as sales_net,
           case when bool_or(pr.known) then sum(pr.known_qty) filter (where pr.known) end as known_qty,
           case when bool_or(pr.known) then sum(pr.known_net) filter (where pr.known) end as known_net,
           case when bool_or(pr.known) then sum(pr.theo_cost) filter (where pr.known) end as theo_cost
      from pr
     group by pr.loc, pr.loc_site, pr.currency, pr.product_key
  ),
  base as (
    select g.*,
           (select z.site from pr z where z.product_key = g.product_key and z.currency = g.currency and z.known and z.known_qty > 0 and z.theo_cost is not null and (g.loc is null or z.location_id = g.loc)
             order by z.theo_cost / z.known_qty asc, z.site limit 1) as low_site,
           (select min(z.theo_cost / z.known_qty) from pr z where z.product_key = g.product_key and z.currency = g.currency and z.known and z.known_qty > 0 and (g.loc is null or z.location_id = g.loc)) as low,
           (select z.site from pr z where z.product_key = g.product_key and z.currency = g.currency and z.known and z.known_qty > 0 and z.theo_cost is not null and (g.loc is null or z.location_id = g.loc)
             order by z.theo_cost / z.known_qty desc, z.site limit 1) as high_site,
           (select max(z.theo_cost / z.known_qty) from pr z where z.product_key = g.product_key and z.currency = g.currency and z.known and z.known_qty > 0 and (g.loc is null or z.location_id = g.loc)) as high
      from grp g
  ),
  avg as (
    select b.loc, b.currency, count(*) filter (where b.theo_cost is not null and b.known_qty > 0) as n_known,
           sum(b.known_qty) filter (where b.theo_cost is not null and b.known_qty > 0) as total_qty,
           sum(b.known_net - b.theo_cost) filter (where b.theo_cost is not null and b.known_qty > 0) as total_gp
      from base b group by b.loc, b.currency
  ),
  cl as (
    select b.*, a.n_known, a.total_qty, a.total_gp,
           case when b.theo_cost is null or b.known_qty <= 0 or coalesce(a.total_qty, 0) = 0 then null else round(b.known_qty / a.total_qty * 100, 2) end as share,
           case when b.theo_cost is null or coalesce(b.known_qty, 0) <= 0 or coalesce(a.total_qty, 0) = 0 or a.n_known = 0 then 'Unknown'
                else case when (b.known_qty / a.total_qty * 100) > 0.7 * (100.0 / a.n_known) then
                            case when (b.known_net - b.theo_cost) / b.known_qty > a.total_gp / a.total_qty then 'Star' else 'Plowhorse' end
                          else case when (b.known_net - b.theo_cost) / b.known_qty > a.total_gp / a.total_qty then 'Puzzle' else 'Dog' end end end as class
      from base b left join avg a on a.loc is not distinct from b.loc and a.currency = b.currency
  ),
  pg as (
    select cl.* from cl
     where p_after is null
        or public.stock_rp__sk(cl.sales_net) < (p_after ->> 'sales_net')::numeric
        or (public.stock_rp__sk(cl.sales_net) = (p_after ->> 'sales_net')::numeric and (coalesce(cl.loc::text, '') || ':' || cl.product_key) > coalesce(p_after ->> 'key', ''))
     order by public.stock_rp__sk(cl.sales_net) desc, coalesce(cl.loc::text, '') || ':' || cl.product_key
     limit v_limit + 1
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', pg.loc, 'site', pg.site, 'currency', pg.currency, 'menu_item_id', pg.menu_item_id, 'product_key', pg.product_key, 'name', pg.name, 'type', pg.type,
           'sold_qty', pg.sold_qty, 'sales_net', pg.sales_net, 'known_qty', pg.known_qty, 'known_net', pg.known_net, 'theo_cost', pg.theo_cost,
           'gp', case when pg.theo_cost is null then null else pg.known_net - pg.theo_cost end,
           'gp_pct', case when pg.theo_cost is null then null else public.stock_rp__pct(pg.known_net - pg.theo_cost, pg.known_net) end,
           'plate_cost_avg', case when pg.theo_cost is null or coalesce(pg.known_qty, 0) = 0 then null else round(pg.theo_cost / pg.known_qty, 4) end,
           'plate_cost_low', round(pg.low, 4), 'plate_cost_low_site', pg.low_site, 'plate_cost_high', round(pg.high, 4), 'plate_cost_high_site', pg.high_site,
           'popularity_share', pg.share, 'class', pg.class, 'key', coalesce(pg.loc::text, '') || ':' || pg.product_key)
           order by public.stock_rp__sk(pg.sales_net) desc, coalesce(pg.loc::text, '') || ':' || pg.product_key), '[]'::jsonb), count(*)
    into v_rows, v_n
    from pg;
  if v_n > v_limit then
    v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
    v_next := jsonb_build_object('sales_net', public.stock_rp__sk((v_rows -> (v_limit - 1) ->> 'sales_net')::numeric), 'key', v_rows -> (v_limit - 1) ->> 'key');
  end if;
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'product_gp', p_from, p_to, false, v_level, v_cols, v_win, v_notes) || jsonb_build_object('view', v_view),
    -- the company row per currency: the sum of the site rows; GP from the sales with a plate cost and
    -- their plate cost only (the same sites, the same days); not known when a site in it is not
    'totals', v_site_rows || (select coalesce(jsonb_agg(c || jsonb_build_object(
                                 'gp', case when c ->> 'theo_cost' is null or c ->> 'known_net' is null then null
                                            else (c ->> 'known_net')::numeric - (c ->> 'theo_cost')::numeric end,
                                 'gp_pct', case when c ->> 'theo_cost' is null or c ->> 'known_net' is null then null
                                                else public.stock_rp__pct((c ->> 'known_net')::numeric - (c ->> 'theo_cost')::numeric, (c ->> 'known_net')::numeric) end)
                                 order by c ->> 'currency'), '[]'::jsonb)
                               from jsonb_array_elements(public.stock_rp__strict(public.stock_rp__sum_rows(v_site_rows, array['sales_net', 'known_net', 'theo_cost', 'products']),
                                                                                 (select coalesce(jsonb_agg(case when coalesce((r ->> 'demo_sales')::boolean, false) then r
                                                                                                                 else r || jsonb_build_object('known_net', coalesce((r ->> 'known_net')::numeric, 0),
                                                                                                                                              'theo_cost', coalesce((r ->> 'theo_cost')::numeric, 0)) end), '[]'::jsonb)
                                                                                    from jsonb_array_elements(v_site_rows) r),
                                                                                 array['sales_net', 'known_net', 'theo_cost', 'products'])) c),
    'rows', v_rows, 'next', v_next);
end
$fn$;

-- ---------------------------------------------------------------------------------------------
-- stock_report_waste: waste by site, reason, category, item, person and day, from the waste entries
-- (so the person and the reason exist), checked against the ledger's WASTE day totals.
-- ---------------------------------------------------------------------------------------------
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
  v_w := (select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) from (
  select w.location_id, (select x ->> 'name' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = w.location_id) as site,
         (select x ->> 'currency' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = w.location_id) as currency,
         d.business_day, coalesce(nullif(btrim(w.reason), ''), 'No reason') as reason, coalesce(w.source, 'backoffice') as source, w.logged_by,
         coalesce((select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), '')) from user_profiles p where p.id = w.logged_by), 'Till') as person,
         w.inventory_item_id, i.company_ref as company_item_id, coalesce(i.name, w.item_name, 'Item') as name, coalesce(i.base_unit, w.unit) as unit,
         coalesce(cat.name, nullif(btrim(i.category), ''), 'No category') as category,
         coalesce(w.qty_base, w.qty) as qty, coalesce(w.cost_value, 0) as value
    from waste_events w
   cross join lateral public.stock_co__venue_day(w.location_id, w.occurred_at) d
    left join inventory_items i on i.id = w.inventory_item_id
    left join stock_co_items ci on ci.id = i.company_ref
    left join stock_co_categories cat on cat.id = ci.category_id
   where w.location_id = any(array(select (x ->> 'id')::uuid from jsonb_array_elements(v_g -> 'sites') x))
     and (v_site is null or w.location_id = v_site)
     and d.business_day between p_from and p_to) z);
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', (f ->> 'location_id')::uuid, 'site', f ->> 'site', 'currency', f ->> 'currency', 'sales_net', (f ->> 'sales_net')::numeric, 'purchases', (f ->> 'purchases')::numeric,
           'waste_value', coalesce(z.v, 0), 'waste_pct_sales', public.stock_rp__pct(coalesce(z.v, 0), (f ->> 'sales_net')::numeric),
           'waste_pct_purchases', public.stock_rp__pct(coalesce(z.v, 0), (f ->> 'purchases')::numeric),
           'refund_waste', coalesce(z.refund, 0), 'closedown_waste', null, 'events', coalesce(z.n, 0), 'ledger_waste', (f ->> 'waste_value')::numeric)
           order by f ->> 'site'), '[]'::jsonb)
    into v_site_rows
    from jsonb_array_elements(v_fig) f
    left join (select t.location_id, sum(t.value) as v, sum(t.value) filter (where t.source = 'refund') as refund, count(*) as n from jsonb_to_recordset(v_w) as t(location_id uuid, site text, currency text, business_day date, reason text, source text, logged_by uuid, person text, inventory_item_id uuid, company_item_id uuid, name text, unit text, category text, qty numeric, value numeric) group by t.location_id) z
      on z.location_id = (f ->> 'location_id')::uuid
   where v_site is null or (f ->> 'location_id')::uuid = v_site;
  if exists (select 1 from jsonb_array_elements(v_site_rows) r where abs((r ->> 'waste_value')::numeric - (r ->> 'ledger_waste')::numeric) > 0.01) then
    v_notes := (select jsonb_agg('The waste entries at ' || (r ->> 'site') || ' add up to a different figure from the ledger''s WASTE line (' || (r ->> 'waste_value') || ' against ' || (r ->> 'ledger_waste') || ').')
                  from jsonb_array_elements(v_site_rows) r where abs((r ->> 'waste_value')::numeric - (r ->> 'ledger_waste')::numeric) > 0.01);
  end if;
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
             sum(t.value) as value, sum(t.qty) as qty, count(*) as events
        from jsonb_to_recordset(v_w) as t(location_id uuid, site text, currency text, business_day date, reason text, source text, logged_by uuid, person text, inventory_item_id uuid, company_item_id uuid, name text, unit text, category text, qty numeric, value numeric)
       group by t.location_id, t.site, t.currency, 4, 5
    ),
    gt as (
      select g.*,
             case when v_level = 'item' then
               (select r.reason from jsonb_to_recordset(v_w) as r(location_id uuid, site text, currency text, business_day date, reason text, source text, logged_by uuid, person text, inventory_item_id uuid, company_item_id uuid, name text, unit text, category text, qty numeric, value numeric)
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

-- ---------------------------------------------------------------------------------------------
-- stock_report_purchases: ordered, received and invoiced side by side; supplier by site; reliability.
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_report_purchases(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
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
  v_gross  boolean := coalesce(v_o ->> 'vat', 'net') = 'gross';
  v_site   uuid := public.stock_rp__opt_site(v_g, v_o);
  v_week   smallint := coalesce((v_g ->> 'week_start')::smallint, 1);
  v_win    jsonb;
  v_fig    jsonb;
  v_po     jsonb;
  v_site_rows jsonb;
  v_rows   jsonb := '[]'::jsonb;
  v_next   jsonb;
  v_cols   jsonb;
  v_n      integer;
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  if v_level not in ('site', 'supplier', 'category', 'week', 'order') then
    v_level := 'site';
  end if;
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, false);
  v_fig := public.stock_rp__site_figures(v_g, v_win);
  -- the orders of the window (by the venue day of ordered_at), with their lines
  v_po := (select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) from (
  select po.location_id, (select x ->> 'name' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = po.location_id) as site,
         (select x ->> 'currency' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = po.location_id) as currency,
         po.id as po_id, po.reference, po.supplier_id, coalesce(cs.name, s.name, 'No supplier') as supplier_name, po.status, po.ordered_at, d.business_day as ordered_day,
         po.expected_date, po.received_at, rd.business_day as received_day,
         coalesce(po.subtotal, 0) + case when v_gross then coalesce(po.tax, 0) else 0 end as subtotal, coalesce(po.tax, 0) as tax,
         coalesce((select sum(l.qty_received * l.unit_price) from po_lines l where l.po_id = po.id), 0) as received_value,
         (select count(*) from po_lines l where l.po_id = po.id) as lines, (select count(*) from po_lines l where l.po_id = po.id and l.qty_received < l.qty_packs) as short_lines,
         (select v.id from supplier_invoices v where v.po_id = po.id and v.status = 'POSTED' order by v.invoice_date desc limit 1) as invoice_id,
         coalesce((select sum(coalesce(v.subtotal, 0) + case when v_gross then coalesce(v.tax, 0) else 0 end) from supplier_invoices v where v.po_id = po.id and v.status = 'POSTED'), 0) as invoiced
    from purchase_orders po
   cross join lateral public.stock_co__venue_day(po.location_id, coalesce(po.ordered_at, po.created_at)) d
    left join lateral public.stock_co__venue_day(po.location_id, po.received_at) rd on true
    left join suppliers s on s.id = po.supplier_id
    left join stock_co_suppliers cs on cs.id = s.company_ref
   where po.location_id = any(array(select (x ->> 'id')::uuid from jsonb_array_elements(v_g -> 'sites') x))
     and (v_site is null or po.location_id = v_site)
     and po.status in ('SENT', 'PARTIAL', 'RECEIVED')
     and d.business_day between p_from and p_to) z);
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', (f ->> 'location_id')::uuid, 'site', f ->> 'site', 'currency', f ->> 'currency',
           'ordered', coalesce(z.ordered, 0), 'received', (f ->> 'purchases')::numeric,
           'invoiced', coalesce((select sum(coalesce(v.subtotal, 0) + case when v_gross then coalesce(v.tax, 0) else 0 end) from supplier_invoices v
                                  where v.location_id = (f ->> 'location_id')::uuid and v.status = 'POSTED' and v.invoice_date between p_from and p_to), 0),
           'on_time_pct', z.on_time_pct, 'short_pct', z.short_pct, 'orders', coalesce(z.n, 0), 'sent_unapproved', null, 'substitutions', null)
           order by f ->> 'site'), '[]'::jsonb)
    into v_site_rows
    from jsonb_array_elements(v_fig) f
    left join (select t.location_id, sum(t.subtotal) as ordered, count(*) as n,
                      public.stock_rp__pct(count(*) filter (where t.received_day is not null and (t.expected_date is null or t.received_day <= t.expected_date)), count(*) filter (where t.received_day is not null)) as on_time_pct,
                      public.stock_rp__pct(sum(t.short_lines) filter (where t.received_day is not null), sum(t.lines) filter (where t.received_day is not null)) as short_pct
                 from jsonb_to_recordset(v_po) as t(location_id uuid, site text, currency text, po_id uuid, reference text, supplier_id uuid, supplier_name text, status text, ordered_at timestamptz, ordered_day date, expected_date date, received_at timestamptz, received_day date, subtotal numeric, tax numeric, received_value numeric, lines integer, short_lines integer, invoice_id uuid, invoiced numeric) group by t.location_id) z on z.location_id = (f ->> 'location_id')::uuid
   where v_site is null or (f ->> 'location_id')::uuid = v_site;
  v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('ordered', 'Ordered', 'money'), public.stock_rp__col('received', 'Received', 'money'),
    public.stock_rp__col('invoiced', 'Invoiced', 'money'), public.stock_rp__col('on_time_pct', 'On time %', 'pct'), public.stock_rp__col('short_pct', 'Short %', 'pct'),
    public.stock_rp__col('sent_unapproved', 'Sent unapproved', 'qty'), public.stock_rp__col('substitutions', 'Substitutions', 'qty'));
  if v_level = 'order' then
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('reference', 'Order', 'text'), public.stock_rp__col('supplier_name', 'Supplier', 'text'),
      public.stock_rp__col('status', 'Status', 'text'), public.stock_rp__col('ordered_at', 'Ordered', 'day'), public.stock_rp__col('expected_date', 'Expected', 'day'),
      public.stock_rp__col('received_at', 'Received', 'day'), public.stock_rp__col('subtotal', 'Value', 'money'), public.stock_rp__col('tax', 'VAT', 'money'));
    with pg as (
      select t.* from jsonb_to_recordset(v_po) as t(location_id uuid, site text, currency text, po_id uuid, reference text, supplier_id uuid, supplier_name text, status text, ordered_at timestamptz, ordered_day date, expected_date date, received_at timestamptz, received_day date, subtotal numeric, tax numeric, received_value numeric, lines integer, short_lines integer, invoice_id uuid, invoiced numeric)
       where p_after is null
          or public.stock_rp__sk(t.received_value) < (p_after ->> 'received')::numeric
          or (public.stock_rp__sk(t.received_value) = (p_after ->> 'received')::numeric and t.po_id::text > coalesce(p_after ->> 'key', ''))
       order by public.stock_rp__sk(t.received_value) desc, t.po_id
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('location_id', pg.location_id, 'site', pg.site, 'currency', pg.currency, 'po_id', pg.po_id, 'reference', pg.reference,
             'supplier_name', pg.supplier_name, 'status', pg.status, 'ordered_at', pg.ordered_at, 'expected_date', pg.expected_date, 'received_at', pg.received_at,
             'subtotal', pg.subtotal, 'tax', pg.tax, 'received', pg.received_value, 'invoice_id', pg.invoice_id, 'invoiced', pg.invoiced, 'key', pg.po_id::text)
             order by public.stock_rp__sk(pg.received_value) desc, pg.po_id), '[]'::jsonb), count(*)
      into v_rows, v_n
      from pg;
  else
    with g as (
      select t.location_id, t.site, t.currency,
             case v_level when 'supplier' then coalesce(t.supplier_id::text, 'none') when 'week' then public.stock_rp__week_of(t.ordered_day, v_week)::text else coalesce(t.supplier_id::text, 'none') end as key,
             case v_level when 'week' then public.stock_rp__week_of(t.ordered_day, v_week)::text else t.supplier_name end as name,
             sum(t.subtotal) as ordered, sum(t.received_value) as received, sum(t.invoiced) as invoiced, count(*) as orders
        from jsonb_to_recordset(v_po) as t(location_id uuid, site text, currency text, po_id uuid, reference text, supplier_id uuid, supplier_name text, status text, ordered_at timestamptz, ordered_day date, expected_date date, received_at timestamptz, received_day date, subtotal numeric, tax numeric, received_value numeric, lines integer, short_lines integer, invoice_id uuid, invoiced numeric)
       where v_level in ('supplier', 'week')
       group by t.location_id, t.site, t.currency, 4, 5
      union all
      select t.location_id, t.site, t.currency, coalesce(cat.id::text, 'none'), coalesce(cat.name, 'No category'),
             sum(l.qty_packs * l.unit_price), sum(l.qty_received * l.unit_price), 0, count(distinct t.po_id)
        from jsonb_to_recordset(v_po) as t(location_id uuid, site text, currency text, po_id uuid, reference text, supplier_id uuid, supplier_name text, status text, ordered_at timestamptz, ordered_day date, expected_date date, received_at timestamptz, received_day date, subtotal numeric, tax numeric, received_value numeric, lines integer, short_lines integer, invoice_id uuid, invoiced numeric)
        join po_lines l on l.po_id = t.po_id
        left join inventory_items i on i.id = l.inventory_item_id
        left join stock_co_items ci on ci.id = i.company_ref
        left join stock_co_categories cat on cat.id = ci.category_id
       where v_level = 'category'
       group by t.location_id, t.site, t.currency, 4, 5
    ),
    pg as (
      select g.* from g
       where p_after is null
          or public.stock_rp__sk(g.received) < (p_after ->> 'received')::numeric
          or (public.stock_rp__sk(g.received) = (p_after ->> 'received')::numeric and (g.location_id::text || ':' || g.key) > coalesce(p_after ->> 'key', ''))
       order by public.stock_rp__sk(g.received) desc, g.location_id::text || ':' || g.key
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('location_id', pg.location_id, 'site', pg.site, 'currency', pg.currency, 'key', pg.location_id::text || ':' || pg.key,
             'supplier_name', case when v_level = 'supplier' then pg.name end, 'name', pg.name, 'week_start', case when v_level = 'week' then pg.name::date end,
             'ordered', pg.ordered, 'received', pg.received, 'invoiced', pg.invoiced, 'orders', pg.orders)
             order by public.stock_rp__sk(pg.received) desc, pg.location_id::text || ':' || pg.key), '[]'::jsonb), count(*)
      into v_rows, v_n
      from pg;
    if v_level <> 'site' then
      v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('name', case v_level when 'supplier' then 'Supplier' when 'week' then 'Week' else 'Category' end, 'text'),
        public.stock_rp__col('ordered', 'Ordered', 'money'), public.stock_rp__col('received', 'Received', 'money'), public.stock_rp__col('invoiced', 'Invoiced', 'money'), public.stock_rp__col('orders', 'Orders', 'qty'));
    end if;
  end if;
  if v_level = 'site' then
    v_rows := (select coalesce(jsonb_agg(r), '[]'::jsonb) from (select r from jsonb_array_elements(v_site_rows) r limit 1000) z);
    v_next := null;
  elsif v_n > v_limit then
    v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
    v_next := jsonb_build_object('received', public.stock_rp__sk((v_rows -> (v_limit - 1) ->> 'received')::numeric), 'key', v_rows -> (v_limit - 1) ->> 'key');
  end if;
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'purchases', p_from, p_to, false, v_level, v_cols, v_win,
              jsonb_build_array('Purchases at delivery value until the purchasing update', 'Sent unapproved and substitutions come with the purchasing update'))
            || jsonb_build_object('vat', case when v_gross then 'gross' else 'net' end),
    'totals', v_site_rows || (select coalesce(jsonb_agg(c || jsonb_build_object('sent_unapproved', null, 'substitutions', null, 'on_time_pct', null, 'short_pct', null) order by c ->> 'currency'), '[]'::jsonb)
                               from jsonb_array_elements(public.stock_rp__sum_rows(v_site_rows, array['ordered', 'received', 'invoiced', 'orders'])) c),
    'rows', v_rows, 'next', v_next);
end
$fn$;

-- ---------------------------------------------------------------------------------------------
-- stock_report_prices: price paid per item at each site against the agreed price; price changes in
-- the window and the ones coming.
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_report_prices(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
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
  v_level  text := coalesce(nullif(v_o ->> 'level', ''), 'item');
  v_site   uuid := public.stock_rp__opt_site(v_g, v_o);
  v_item   uuid := nullif(v_o ->> 'item_id', '')::uuid;
  v_win    jsonb;
  v_sites  uuid[];
  v_paid   jsonb;
  v_site_rows jsonb;
  v_rows   jsonb := '[]'::jsonb;
  v_next   jsonb;
  v_cols   jsonb;
  v_n      integer;
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  if v_level not in ('item', 'change', 'coming') then
    v_level := 'item';
  end if;
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, false);
  v_sites := array(select (x ->> 'id')::uuid from jsonb_array_elements(v_g -> 'sites') x where v_site is null or (x ->> 'id')::uuid = v_site);
  -- the prices paid in the window (invoices and deliveries), per site and company item, in base units
  v_paid := (select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) from (
  select h.location_id, (select x ->> 'name' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = h.location_id) as site,
         (select x ->> 'currency' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = h.location_id) as currency,
         i.company_ref as company_item_id, i.id as inventory_item_id, i.name,
         coalesce((select cs.name from stock_co_supplier_items si join stock_co_suppliers cs on cs.id = si.supplier_id where si.id = ci.main_supplier_item_id),
                  (select s.name from supplier_products sp join suppliers s on s.id = sp.supplier_id where sp.id = h.supplier_product_id)) as supplier_name,
         (select si.pack_price / nullif(si.pack_qty * si.inner_qty, 0) from stock_co_supplier_items si where si.id = ci.main_supplier_item_id) as agreed,
         h.base_unit_cost as paid, h.effective_from as at
    from item_cost_history h
    join inventory_items i on i.id = h.inventory_item_id
    left join stock_co_items ci on ci.id = i.company_ref
   cross join lateral public.stock_co__venue_day(h.location_id, h.effective_from) d
   where h.location_id = any(v_sites) and h.source in ('INVOICE', 'PO_RECEIPT') and d.business_day between p_from and p_to
     and (v_item is null or i.company_ref = v_item)) z);
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', s.id, 'site', s.name, 'currency', s.currency,
           'items_priced', coalesce(z.items, 0), 'paid_over_agreed', coalesce(z.over, 0), 'spread_pct_avg', z.spread)
           order by s.name, s.id), '[]'::jsonb)
    into v_site_rows
    from (select (x ->> 'id')::uuid as id, x ->> 'name' as name, x ->> 'currency' as currency from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = any(v_sites)) s
    left join (select t.location_id, count(distinct t.inventory_item_id) as items, count(*) filter (where t.agreed is not null and t.paid > t.agreed) as over,
                      avg(public.stock_rp__pct(t.paid - t.agreed, t.agreed)) filter (where t.agreed is not null and t.agreed <> 0) as spread
                 from jsonb_to_recordset(v_paid) as t(location_id uuid, site text, currency text, company_item_id uuid, inventory_item_id uuid, name text, supplier_name text, agreed numeric, paid numeric, at timestamptz) group by t.location_id) z on z.location_id = s.id;
  v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('items_priced', 'Items priced', 'qty'),
    public.stock_rp__col('paid_over_agreed', 'Paid over agreed', 'qty'), public.stock_rp__col('spread_pct_avg', 'Spread % (average)', 'pct'));
  if v_level = 'item' then
    v_cols := jsonb_build_array(public.stock_rp__col('name', 'Item', 'text'), public.stock_rp__col('supplier_name', 'Supplier', 'text'), public.stock_rp__col('agreed_price', 'Agreed', 'money'),
      public.stock_rp__col('paid_avg', 'Paid (average)', 'money'), public.stock_rp__col('paid_low', 'Lowest', 'money'), public.stock_rp__col('paid_low_site', 'Lowest at', 'text'),
      public.stock_rp__col('paid_high', 'Highest', 'money'), public.stock_rp__col('paid_high_site', 'Highest at', 'text'), public.stock_rp__col('spread_pct', 'Spread %', 'pct'),
      public.stock_rp__col('over_agreed_sites', 'Sites over agreed', 'qty'));
    with g as (
      select t.currency || ':' || coalesce(t.company_item_id::text, t.inventory_item_id::text) as key, t.currency, t.company_item_id, min(t.name) as name, min(t.supplier_name) as supplier_name, min(t.agreed) as agreed,
             avg(t.paid) as paid_avg, min(t.paid) as paid_low, max(t.paid) as paid_high, count(distinct t.location_id) filter (where t.agreed is not null and t.paid > t.agreed) as over_sites
        from jsonb_to_recordset(v_paid) as t(location_id uuid, site text, currency text, company_item_id uuid, inventory_item_id uuid, name text, supplier_name text, agreed numeric, paid numeric, at timestamptz) group by 1, 2, 3
    ),
    gs as (
      select g.*,
             (select z.site from jsonb_to_recordset(v_paid) as z(location_id uuid, site text, currency text, company_item_id uuid, inventory_item_id uuid, name text, supplier_name text, agreed numeric, paid numeric, at timestamptz) where z.currency || ':' || coalesce(z.company_item_id::text, z.inventory_item_id::text) = g.key order by z.paid asc, z.site limit 1) as low_site,
             (select z.site from jsonb_to_recordset(v_paid) as z(location_id uuid, site text, currency text, company_item_id uuid, inventory_item_id uuid, name text, supplier_name text, agreed numeric, paid numeric, at timestamptz) where z.currency || ':' || coalesce(z.company_item_id::text, z.inventory_item_id::text) = g.key order by z.paid desc, z.site limit 1) as high_site
        from g
    ),
    pg as (
      select g.*, public.stock_rp__pct(g.paid_high - g.paid_low, g.paid_low) as spread from gs g
       where p_after is null
          or public.stock_rp__pct(g.paid_high - g.paid_low, g.paid_low) < (p_after ->> 'spread_pct')::numeric
          or (p_after ->> 'spread_pct' is not null and public.stock_rp__pct(g.paid_high - g.paid_low, g.paid_low) is null)
          or (public.stock_rp__pct(g.paid_high - g.paid_low, g.paid_low) is not distinct from (p_after ->> 'spread_pct')::numeric and g.key > coalesce(p_after ->> 'key', ''))
       order by public.stock_rp__pct(g.paid_high - g.paid_low, g.paid_low) desc nulls last, g.key
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('company_item_id', pg.company_item_id, 'currency', pg.currency, 'key', pg.key, 'name', pg.name, 'supplier_name', pg.supplier_name, 'agreed_price', round(pg.agreed, 4),
             'paid_avg', round(pg.paid_avg, 4), 'paid_low', round(pg.paid_low, 4), 'paid_low_site', pg.low_site, 'paid_high', round(pg.paid_high, 4), 'paid_high_site', pg.high_site,
             'spread_pct', pg.spread, 'over_agreed_sites', pg.over_sites) order by pg.spread desc nulls last, pg.key), '[]'::jsonb), count(*)
      into v_rows, v_n
      from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('spread_pct', (v_rows -> (v_limit - 1) ->> 'spread_pct')::numeric, 'key', v_rows -> (v_limit - 1) ->> 'key');
    end if;
  else
    v_cols := jsonb_build_array(public.stock_rp__col('at', 'When', 'day'), public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('name', 'Item', 'text'),
      public.stock_rp__col('source', 'From', 'text'), public.stock_rp__col('old_price', 'Old', 'money'), public.stock_rp__col('new_price', 'New', 'money'), public.stock_rp__col('pct', 'Change %', 'pct'),
      public.stock_rp__col('use_qty', 'Use in the period', 'qty'), public.stock_rp__col('cost_effect', 'Cost effect', 'money'), public.stock_rp__col('who', 'Who', 'text'));
    with ch as (
      select c.at, c.id::text as id, c.location_id, si.item_id as company_item_id, ci.name, case when c.field = 'price_here' then 'edit' else 'edit' end as source,
             case when (c.before #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' then (c.before #>> '{}')::numeric end as old_price,
             case when (c.after #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' then (c.after #>> '{}')::numeric end as new_price, c.who_name as who, si.pack_qty * si.inner_qty as per_pack
        from stock_change_log c
        join stock_co_supplier_items si on si.id = c.entity_id
        join stock_co_items ci on ci.id = si.item_id
       where c.org_id = p_org and c.entity = 'supplier_item' and c.field in ('pack_price', 'price_here')
         and v_level = 'change'
         and (select vd.business_day from public.stock_co__venue_day(coalesce(c.location_id, v_sites[1]), c.at) vd) between p_from and p_to
         and (c.location_id is null or c.location_id = any(v_sites)) and (v_item is null or si.item_id = v_item)
         and jsonb_typeof(c.before) in ('number', 'string') and jsonb_typeof(c.after) in ('number', 'string')
      union all
      select coalesce(dp.applied_at, dp.from_day::timestamptz), dp.id::text, dp.location_id, si.item_id, ci.name, case when v_level = 'coming' then 'dated' else 'dated' end,
             si.pack_price, dp.price, dp.created_by_name, si.pack_qty * si.inner_qty
        from stock_co_dated_prices dp
        join stock_co_supplier_items si on si.id = dp.supplier_item_id
        join stock_co_items ci on ci.id = si.item_id
       where dp.org_id = p_org and (v_item is null or si.item_id = v_item) and (dp.location_id is null or dp.location_id = any(v_sites))
         and ((v_level = 'change' and dp.status = 'applied' and dp.from_day between p_from and p_to)
              or (v_level = 'coming' and dp.status = 'waiting'))
    ),
    pg as (
      select ch.*, public.stock_rp__pct(ch.new_price - ch.old_price, ch.old_price) as pct,
             (select -sum(s.qty_base) from stock_day_sums s
               where s.location_id = any(v_sites) and (ch.location_id is null or s.location_id = ch.location_id) and s.company_item_id = ch.company_item_id
                 and s.business_day between p_from and p_to and s.demo = false and s.movement_type in ('SALE_DEPLETION', 'PRODUCTION_CONSUME')) as use_qty
        from ch
       where p_after is null
          or ch.at < (p_after ->> 'at')::timestamptz
          or (ch.at = (p_after ->> 'at')::timestamptz and ch.id > coalesce(p_after ->> 'id', ''))
       order by ch.at desc, ch.id
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('at', pg.at, 'id', pg.id, 'location_id', pg.location_id,
             'site', (select x ->> 'name' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = pg.location_id),
             'company_item_id', pg.company_item_id, 'name', pg.name, 'source', pg.source, 'old_price', pg.old_price, 'new_price', pg.new_price, 'pct', pg.pct,
             'use_qty', pg.use_qty, 'cost_effect', case when pg.per_pack is null or pg.per_pack = 0 or pg.use_qty is null then null
                                                        else round((pg.new_price - pg.old_price) / pg.per_pack * pg.use_qty, 2) end, 'who', pg.who)
             order by pg.at desc, pg.id), '[]'::jsonb), count(*)
      into v_rows, v_n
      from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('at', v_rows -> (v_limit - 1) ->> 'at', 'id', v_rows -> (v_limit - 1) ->> 'id');
    end if;
  end if;
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'prices', p_from, p_to, false, v_level, v_cols, v_win, jsonb_build_array('Overcharges and credits come with the purchasing update')),
    'totals', v_site_rows || public.stock_rp__sum_rows(v_site_rows, array['items_priced', 'paid_over_agreed']),
    'rows', v_rows, 'next', v_next);
end
$fn$;

-- ---------------------------------------------------------------------------------------------
-- stock_report_days_on_hand: days on hand and stock turn per site and category; slow and dead stock
-- with a Transfer to suggestion where another site in scope uses the item.
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_report_days_on_hand(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
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
  v_idle   integer := case when (v_o ->> 'idle_days') in ('14', '30', '60') then (v_o ->> 'idle_days')::integer else 30 end;
  v_win    jsonb;
  v_sites  uuid[];
  v_doh    jsonb;
  v_site_rows jsonb;
  v_rows   jsonb := '[]'::jsonb;
  v_next   jsonb;
  v_cols   jsonb;
  v_n      integer;
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  if v_level not in ('site', 'category', 'slow') then
    v_level := 'site';
  end if;
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, false);
  v_sites := array(select (x ->> 'id')::uuid from jsonb_array_elements(v_g -> 'sites') x where v_site is null or (x ->> 'id')::uuid = v_site);
  -- per item: value now, use over the last 28 venue days, the last day of use in the last 120 days
  -- (one grouped read of the day totals; a slow item idle longer shows no last use day)
  v_doh := (select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) from (
  with s as (
    select (x ->> 'id')::uuid as id, x ->> 'name' as name, x ->> 'currency' as currency, vd.business_day as today
      from jsonb_array_elements(v_g -> 'sites') x
     cross join lateral public.stock_co__venue_day((x ->> 'id')::uuid, now()) vd
     where (x ->> 'id')::uuid = any(v_sites)
  ),
  u as (
    select d.location_id, d.inventory_item_id,
           coalesce(-sum(d.value) filter (where d.business_day between s.today - 27 and s.today), 0) as use_28d,
           max(d.business_day) filter (where d.qty_base <> 0) as last_use_day
      from s
      join stock_day_sums d on d.location_id = s.id and d.business_day between s.today - 120 and s.today and d.demo = false
     where d.movement_type in ('SALE_DEPLETION', 'PRODUCTION_CONSUME')
     group by d.location_id, d.inventory_item_id
  )
  select i.location_id, s.name as site, s.currency, i.id as inventory_item_id, i.company_ref as company_item_id, i.name, i.base_unit as unit, ci.category_id,
         coalesce(cat.name, nullif(btrim(i.category), ''), 'No category') as category,
         i.on_hand as qty, case when i.on_hand > 0 then i.on_hand * coalesce(i.current_cost, 0) else 0 end as value,
         coalesce(u.use_28d, 0) as use_28d, u.last_use_day, s.today
    from s
    join inventory_items i on i.location_id = s.id and i.archived_at is null
    left join u on u.location_id = i.location_id and u.inventory_item_id = i.id
    left join stock_co_items ci on ci.id = i.company_ref
    left join stock_co_categories cat on cat.id = ci.category_id) z);
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', s.id, 'site', s.name, 'currency', s.currency, 'stock_value_now', coalesce(z.v, 0), 'daily_use', coalesce(z.use, 0) / 28.0,
           'days_on_hand', case when coalesce(z.use, 0) = 0 then null else round(coalesce(z.v, 0) / (z.use / 28.0), 1) end,
           'stock_turn', case when coalesce(z.v, 0) = 0 or coalesce(z.use, 0) = 0 then null else round(365 / (coalesce(z.v, 0) / (z.use / 28.0)), 1) end,
           'slow_value', coalesce(z.slow, 0),
           'rag', jsonb_build_object('days_on_hand', public.stock_rp__rag(p_org, s.id, 'days_on_hand', case when coalesce(z.use, 0) = 0 then null else round(coalesce(z.v, 0) / (z.use / 28.0), 1) end)))
           order by s.name, s.id), '[]'::jsonb)
    into v_site_rows
    from (select (x ->> 'id')::uuid as id, x ->> 'name' as name, x ->> 'currency' as currency from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = any(v_sites)) s
    left join (select t.location_id, sum(t.value) as v, sum(t.use_28d) as use,
                      sum(t.value) filter (where t.qty > 0 and (t.last_use_day is null or t.last_use_day < t.today - v_idle)) as slow
                 from jsonb_to_recordset(v_doh) as t(location_id uuid, site text, currency text, inventory_item_id uuid, company_item_id uuid, name text, unit text, category_id uuid, category text, qty numeric, value numeric, use_28d numeric, last_use_day date, today date) group by t.location_id) z on z.location_id = s.id;
  v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('stock_value_now', 'Stock value', 'money'), public.stock_rp__col('daily_use', 'Daily use', 'money'),
    public.stock_rp__col('days_on_hand', 'Days on hand', 'qty'), public.stock_rp__col('stock_turn', 'Stock turn', 'qty'), public.stock_rp__col('slow_value', 'Slow and dead', 'money'));
  if v_level = 'category' then
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('name', 'Category', 'text')) || (v_cols - 0);
    with g as (
      select t.location_id, t.site, t.currency, t.category_id, t.category as name, sum(t.value) as v, sum(t.use_28d) as use,
             sum(t.value) filter (where t.qty > 0 and (t.last_use_day is null or t.last_use_day < t.today - v_idle)) as slow
        from jsonb_to_recordset(v_doh) as t(location_id uuid, site text, currency text, inventory_item_id uuid, company_item_id uuid, name text, unit text, category_id uuid, category text, qty numeric, value numeric, use_28d numeric, last_use_day date, today date) group by t.location_id, t.site, t.currency, t.category_id, t.category
    ),
    pg as (
      select g.* from g
       where p_after is null
          or public.stock_rp__sk(g.v) < (p_after ->> 'value')::numeric
          or (public.stock_rp__sk(g.v) = (p_after ->> 'value')::numeric and (g.location_id::text || ':' || coalesce(g.category_id::text, g.name)) > coalesce(p_after ->> 'key', ''))
       order by public.stock_rp__sk(g.v) desc, g.location_id::text || ':' || coalesce(g.category_id::text, g.name)
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('location_id', pg.location_id, 'site', pg.site, 'currency', pg.currency, 'category_id', pg.category_id, 'name', pg.name,
             'key', pg.location_id::text || ':' || coalesce(pg.category_id::text, pg.name), 'stock_value_now', pg.v, 'value', pg.v, 'daily_use', pg.use / 28.0,
             'days_on_hand', case when coalesce(pg.use, 0) = 0 then null else round(pg.v / (pg.use / 28.0), 1) end,
             'stock_turn', case when coalesce(pg.v, 0) = 0 or coalesce(pg.use, 0) = 0 then null else round(365 / (pg.v / (pg.use / 28.0)), 1) end, 'slow_value', coalesce(pg.slow, 0))
             order by public.stock_rp__sk(pg.v) desc, pg.location_id::text || ':' || coalesce(pg.category_id::text, pg.name)), '[]'::jsonb), count(*)
      into v_rows, v_n
      from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('value', public.stock_rp__sk((v_rows -> (v_limit - 1) ->> 'value')::numeric), 'key', v_rows -> (v_limit - 1) ->> 'key');
    end if;
  elsif v_level = 'slow' then
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('name', 'Item', 'text'), public.stock_rp__col('qty', 'On hand', 'qty'),
      public.stock_rp__col('unit', 'Unit', 'text'), public.stock_rp__col('value', 'Value', 'money'), public.stock_rp__col('last_use_day', 'Last used', 'day'),
      public.stock_rp__col('idle_days', 'Idle days', 'qty'), public.stock_rp__col('transfer_to', 'Transfer to', 'text'));
    with pg as (
      select t.* from jsonb_to_recordset(v_doh) as t(location_id uuid, site text, currency text, inventory_item_id uuid, company_item_id uuid, name text, unit text, category_id uuid, category text, qty numeric, value numeric, use_28d numeric, last_use_day date, today date)
       where t.qty > 0 and (t.last_use_day is null or t.last_use_day < t.today - v_idle)
         and (p_after is null or public.stock_rp__sk(t.value) < (p_after ->> 'value')::numeric
              or (public.stock_rp__sk(t.value) = (p_after ->> 'value')::numeric and t.inventory_item_id::text > coalesce(p_after ->> 'inventory_item_id', '')))
       order by public.stock_rp__sk(t.value) desc, t.inventory_item_id
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('location_id', pg.location_id, 'site', pg.site, 'currency', pg.currency, 'company_item_id', pg.company_item_id,
             'inventory_item_id', pg.inventory_item_id, 'name', pg.name, 'qty', pg.qty, 'unit', pg.unit, 'value', pg.value, 'last_use_day', pg.last_use_day,
             'idle_days', case when pg.last_use_day is null then null else pg.today - pg.last_use_day end,
             'transfer_to', coalesce((select jsonb_agg(jsonb_build_object('location_id', o.location_id, 'site', o.site, 'use_28d', o.use_28d) order by o.use_28d desc)
                                        from jsonb_to_recordset(v_doh) as o(location_id uuid, site text, currency text, inventory_item_id uuid, company_item_id uuid, name text, unit text, category_id uuid, category text, qty numeric, value numeric, use_28d numeric, last_use_day date, today date) where o.company_item_id = pg.company_item_id and o.company_item_id is not null
                                         and o.location_id <> pg.location_id and o.use_28d > 0), '[]'::jsonb))
             order by public.stock_rp__sk(pg.value) desc, pg.inventory_item_id), '[]'::jsonb), count(*)
      into v_rows, v_n
      from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('value', public.stock_rp__sk((v_rows -> (v_limit - 1) ->> 'value')::numeric), 'inventory_item_id', v_rows -> (v_limit - 1) ->> 'inventory_item_id');
    end if;
  else
    v_rows := (select coalesce(jsonb_agg(r), '[]'::jsonb) from (select r from jsonb_array_elements(v_site_rows) r limit 1000) z);
  end if;
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'days_on_hand', p_from, p_to, false, v_level, v_cols, v_win, '[]'::jsonb) || jsonb_build_object('idle_days', v_idle),
    'totals', v_site_rows || (select coalesce(jsonb_agg(c || jsonb_build_object(
                                 'days_on_hand', case when coalesce((c ->> 'daily_use')::numeric, 0) = 0 then null else round((c ->> 'stock_value_now')::numeric / (c ->> 'daily_use')::numeric, 1) end,
                                 'stock_turn', case when coalesce((c ->> 'daily_use')::numeric, 0) = 0 or coalesce((c ->> 'stock_value_now')::numeric, 0) = 0 then null
                                                    else round(365 / ((c ->> 'stock_value_now')::numeric / (c ->> 'daily_use')::numeric), 1) end)
                                 order by c ->> 'currency'), '[]'::jsonb)
                               from jsonb_array_elements(public.stock_rp__sum_rows(v_site_rows, array['stock_value_now', 'daily_use', 'slow_value'])) c),
    'rows', v_rows, 'next', v_next);
end
$fn$;

-- ---------------------------------------------------------------------------------------------
-- stock_report_par: below par and minimum now, stock outs in the period (a day by day replay of one
-- site, at most 93 days), over par and negative stock.
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_report_par(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
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
  v_sites  uuid[];
  v_par    jsonb;
  v_outs   jsonb := '[]'::jsonb;
  v_site_rows jsonb;
  v_rows   jsonb := '[]'::jsonb;
  v_next   jsonb;
  v_cols   jsonb;
  v_n      integer;
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  if v_level not in ('site', 'below', 'stockout', 'over', 'negative') then
    v_level := 'site';
  end if;
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, false);
  v_sites := array(select (x ->> 'id')::uuid from jsonb_array_elements(v_g -> 'sites') x where v_site is null or (x ->> 'id')::uuid = v_site);
  -- every live item at the sites with its par today (par by weekday when set), minimum and on hand
  v_par := (select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) from (
  select i.location_id, s.name as site, s.currency, i.id as inventory_item_id, i.company_ref as company_item_id, i.name, i.base_unit as unit, i.on_hand,
         coalesce((select nullif(cs.par_by_weekday ->> lower(to_char(public.stock_co__today(i.location_id), 'dy')), '')::numeric
                     from stock_co_item_sites cs where cs.location_id = i.location_id and cs.site_item_id = i.id limit 1), p.par_level) as par,
         p.min_level
    from (select (x ->> 'id')::uuid as id, x ->> 'name' as name, x ->> 'currency' as currency from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = any(v_sites)) s
    join inventory_items i on i.location_id = s.id and i.archived_at is null
    left join par_levels p on p.location_id = i.location_id and p.inventory_item_id = i.id) z);
  -- stock outs: item days at or below zero in the window, from the day totals alone (a running sum
  -- back from today's on hand; the quantity between two movement days is the quantity at the end of
  -- the first), at most 93 days
  if p_to - p_from > 92 then
    if v_level = 'stockout' then
      raise exception 'Stock outs cover up to 93 days.' using errcode = '22023';
    end if;
  else
    v_outs := (select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) from (
      with mv as (
        select d.location_id, d.inventory_item_id, d.business_day, sum(d.qty_base) as q
          from stock_day_sums d
         where d.location_id = any(v_sites) and d.business_day >= p_from and d.demo = false
         group by d.location_id, d.inventory_item_id, d.business_day
      ),
      seg as (
        select m.location_id, m.inventory_item_id, m.business_day, m.q,
               coalesce(i.on_hand, 0) - coalesce(sum(m.q) over (partition by m.location_id, m.inventory_item_id order by m.business_day desc rows between unbounded preceding and 1 preceding), 0) as qty_end,
               lead(m.business_day) over (partition by m.location_id, m.inventory_item_id order by m.business_day) as next_day,
               row_number() over (partition by m.location_id, m.inventory_item_id order by m.business_day) as rn
          from mv m
          join inventory_items i on i.id = m.inventory_item_id and i.archived_at is null
      ),
      spans as (
        select s.location_id, s.inventory_item_id, s.qty_end as qty, s.business_day as d0, least(coalesce(s.next_day - 1, p_to), p_to) as d1 from seg s where s.business_day <= p_to
        union all
        select s.location_id, s.inventory_item_id, s.qty_end - s.q, p_from, least(s.business_day - 1, p_to) from seg s where s.rn = 1 and s.business_day > p_from
        union all
        select i.location_id, i.id, coalesce(i.on_hand, 0), p_from, p_to
          from inventory_items i
         where i.location_id = any(v_sites) and i.archived_at is null
           and not exists (select 1 from mv m where m.location_id = i.location_id and m.inventory_item_id = i.id)
      )
      select sp.location_id, sp.inventory_item_id, i.company_ref as company_item_id, i.name,
             sum(sp.d1 - sp.d0 + 1)::integer as days_at_zero, min(sp.d0) as first_day, max(sp.d1) as last_day
        from spans sp
        join inventory_items i on i.id = sp.inventory_item_id
       where sp.qty <= 0 and sp.d1 >= sp.d0
       group by sp.location_id, sp.inventory_item_id, i.company_ref, i.name) z);
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', s.id, 'site', s.name, 'currency', s.currency,
           'below_par', coalesce(z.below_par, 0), 'below_min', coalesce(z.below_min, 0), 'over_par', coalesce(z.over_par, 0), 'negative', coalesce(z.negative, 0),
           'stock_outs', case when p_to - p_from > 92 then null else coalesce((select sum(o.days_at_zero) from jsonb_to_recordset(v_outs) as o(location_id uuid, inventory_item_id uuid, company_item_id uuid, name text, days_at_zero integer, first_day date, last_day date) where o.location_id = s.id), 0) end,
           'stock_out_items', case when p_to - p_from > 92 then null else coalesce((select count(*) from jsonb_to_recordset(v_outs) as o(location_id uuid, inventory_item_id uuid, company_item_id uuid, name text, days_at_zero integer, first_day date, last_day date) where o.location_id = s.id), 0) end)
           order by s.name, s.id), '[]'::jsonb)
    into v_site_rows
    from (select (x ->> 'id')::uuid as id, x ->> 'name' as name, x ->> 'currency' as currency from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = any(v_sites)) s
    left join (select t.location_id, count(*) filter (where t.par is not null and t.on_hand < t.par) as below_par, count(*) filter (where t.min_level is not null and t.on_hand < t.min_level) as below_min,
                      count(*) filter (where t.par is not null and t.par > 0 and t.on_hand > t.par * 1.5) as over_par, count(*) filter (where t.on_hand < 0) as negative
                 from jsonb_to_recordset(v_par) as t(location_id uuid, site text, currency text, inventory_item_id uuid, company_item_id uuid, name text, unit text, on_hand numeric, par numeric, min_level numeric) group by t.location_id) z on z.location_id = s.id;
  v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('below_par', 'Below par', 'qty'), public.stock_rp__col('below_min', 'Below minimum', 'qty'),
    public.stock_rp__col('stock_outs', 'Stock out days', 'qty'), public.stock_rp__col('over_par', 'Over par', 'qty'), public.stock_rp__col('negative', 'Negative stock', 'qty'));
  if v_level in ('below', 'over', 'negative') then
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('name', 'Item', 'text'), public.stock_rp__col('on_hand', 'On hand', 'qty'),
      public.stock_rp__col('unit', 'Unit', 'text'), public.stock_rp__col('par', 'Par', 'qty'), public.stock_rp__col('min_level', 'Minimum', 'qty'), public.stock_rp__col('short_by', 'Short by', 'qty'));
    with r as (
      select t.*, case when v_level = 'over' then t.on_hand - t.par else coalesce(t.par, 0) - t.on_hand end as short_by
        from jsonb_to_recordset(v_par) as t(location_id uuid, site text, currency text, inventory_item_id uuid, company_item_id uuid, name text, unit text, on_hand numeric, par numeric, min_level numeric)
       where case v_level when 'below' then t.par is not null and t.on_hand < t.par
                          when 'over' then t.par is not null and t.par > 0 and t.on_hand > t.par * 1.5
                          else t.on_hand < 0 end
    ),
    pg as (
      select r.* from r
       where p_after is null
          or public.stock_rp__sk(r.short_by) < (p_after ->> 'short_by')::numeric
          or (public.stock_rp__sk(r.short_by) = (p_after ->> 'short_by')::numeric and r.inventory_item_id::text > coalesce(p_after ->> 'inventory_item_id', ''))
       order by public.stock_rp__sk(r.short_by) desc, r.inventory_item_id
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('location_id', pg.location_id, 'site', pg.site, 'currency', pg.currency, 'company_item_id', pg.company_item_id, 'inventory_item_id', pg.inventory_item_id,
             'name', pg.name, 'on_hand', pg.on_hand, 'unit', pg.unit, 'par', pg.par, 'min_level', pg.min_level, 'short_by', pg.short_by)
             order by public.stock_rp__sk(pg.short_by) desc, pg.inventory_item_id), '[]'::jsonb), count(*)
      into v_rows, v_n
      from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('short_by', public.stock_rp__sk((v_rows -> (v_limit - 1) ->> 'short_by')::numeric), 'inventory_item_id', v_rows -> (v_limit - 1) ->> 'inventory_item_id');
    end if;
  elsif v_level = 'stockout' then
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('name', 'Item', 'text'), public.stock_rp__col('days_at_zero', 'Days at zero', 'qty'),
      public.stock_rp__col('first_day', 'First', 'day'), public.stock_rp__col('last_day', 'Last', 'day'));
    with pg as (
      select o.* from jsonb_to_recordset(v_outs) as o(location_id uuid, inventory_item_id uuid, company_item_id uuid, name text, days_at_zero integer, first_day date, last_day date)
       where p_after is null
          or o.days_at_zero < (p_after ->> 'days_at_zero')::integer
          or (o.days_at_zero = (p_after ->> 'days_at_zero')::integer and o.inventory_item_id::text > coalesce(p_after ->> 'inventory_item_id', ''))
       order by o.days_at_zero desc, o.inventory_item_id
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('location_id', pg.location_id, 'site', (select x ->> 'name' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = pg.location_id),
             'company_item_id', pg.company_item_id, 'inventory_item_id', pg.inventory_item_id, 'name', pg.name, 'days_at_zero', pg.days_at_zero, 'first_day', pg.first_day, 'last_day', pg.last_day)
             order by pg.days_at_zero desc, pg.inventory_item_id), '[]'::jsonb), count(*)
      into v_rows, v_n
      from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('days_at_zero', (v_rows -> (v_limit - 1) ->> 'days_at_zero')::integer, 'inventory_item_id', v_rows -> (v_limit - 1) ->> 'inventory_item_id');
    end if;
  else
    v_rows := (select coalesce(jsonb_agg(r), '[]'::jsonb) from (select r from jsonb_array_elements(v_site_rows) r limit 1000) z);
  end if;
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'par', p_from, p_to, false, v_level, v_cols, v_win,
              case when p_to - p_from > 92 then jsonb_build_array('Stock outs cover up to 93 days.') else '[]'::jsonb end),
    'totals', v_site_rows || public.stock_rp__sum_rows(v_site_rows, array['below_par', 'below_min', 'stock_outs', 'stock_out_items', 'over_par', 'negative']),
    'rows', v_rows, 'next', v_next);
end
$fn$;

-- ---------------------------------------------------------------------------------------------
-- stock_report_setup_health: no recipe sales, items with no supplier, allergens not set or not
-- checked, archived items still holding stock, sites out of step, clocks that disagree.
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_report_setup_health(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
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
  v_sites  uuid[];
  v_site_rows jsonb;
  v_rows   jsonb := '[]'::jsonb;
  v_next   jsonb;
  v_cols   jsonb;
  v_n      integer;
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  if v_level not in ('site', 'detail') then
    v_level := 'site';
  end if;
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, false);
  v_sites := array(select (x ->> 'id')::uuid from jsonb_array_elements(v_g -> 'sites') x where v_site is null or (x ->> 'id')::uuid = v_site);
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', s.id, 'site', s.name, 'currency', s.currency,
           'sales_net', case when w.sd then null else coalesce(f.sales_net, 0) end,
           'no_recipe_sales_net', case when w.sd then null else coalesce(f.no_recipe_net, 0) end,
           'no_recipe_pct', case when w.sd then null else public.stock_rp__pct(coalesce(f.no_recipe_net, 0), f.sales_net) end, 'demo_sales', w.sd,
           'recipes_over_target', null, 'recipes_missing_cost', null,
           'items_no_supplier', (select count(*) from stock_co_item_sites cs join stock_co_items ci on ci.id = cs.item_id
                                  where cs.location_id = s.id and cs.on_here and cs.supply_mode = 'bought' and ci.archived_at is null
                                    and not exists (select 1 from stock_co_supplier_items si where si.item_id = ci.id and si.archived_at is null)),
           'supplier_items_no_allergens', (select count(*) from stock_co_supplier_items si join stock_co_item_sites cs on cs.item_id = si.item_id and cs.location_id = s.id and cs.on_here
                                            where si.org_id = p_org and si.archived_at is null and coalesce(cardinality(si.allergens), 0) = 0 and si.ingredients_text is null),
           'allergen_check_waiting', (select count(*) from stock_co_supplier_items si join stock_co_item_sites cs on cs.item_id = si.item_id and cs.location_id = s.id and cs.on_here
                                       where si.org_id = p_org and si.archived_at is null and si.facts_checked_at is null),
           'archived_holding', (select count(*) from inventory_items i where i.location_id = s.id and i.archived_at is not null and i.on_hand <> 0),
           'out_of_step', coalesce(h.planned_writes, 0) + coalesce(h.recipe_planned_writes, 0),
           'checked_at', h.checked_at, 'fix_job_id', h.fix_job_id,
           'clock_disagrees', (select c.mismatch from venue_clock c where c.location_id = s.id),
           'rag', jsonb_build_object('no_recipe_pct', case when w.sd then null
                                                           else public.stock_rp__rag(p_org, s.id, 'no_recipe_pct', public.stock_rp__pct(coalesce(f.no_recipe_net, 0), f.sales_net)) end))
           order by s.name, s.id), '[]'::jsonb)
    into v_site_rows
    from (select (x ->> 'id')::uuid as id, x ->> 'name' as name, x ->> 'currency' as currency from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = any(v_sites)) s
    left join lateral (select coalesce(bool_or(coalesce((x ->> 'demo_sales')::boolean, false) and not coalesce((x ->> 'snapshot')::boolean, false)), false) as sd
                         from jsonb_array_elements(v_win) x where (x ->> 'location_id')::uuid = s.id) w on true
    left join public.stock_rp__site_sales(v_win) f on f.location_id = s.id
    left join stock_co_site_health h on h.location_id = s.id;
  v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('no_recipe_sales_net', 'Sales with no recipe', 'money'),
    public.stock_rp__col('no_recipe_pct', 'No recipe %', 'pct'), public.stock_rp__col('recipes_over_target', 'Recipes over target', 'qty'),
    public.stock_rp__col('recipes_missing_cost', 'Recipes with no cost', 'qty'), public.stock_rp__col('items_no_supplier', 'Items with no supplier', 'qty'),
    public.stock_rp__col('supplier_items_no_allergens', 'Supplier items with no allergens', 'qty'), public.stock_rp__col('allergen_check_waiting', 'Allergen check waiting', 'qty'),
    public.stock_rp__col('archived_holding', 'Archived items holding stock', 'qty'), public.stock_rp__col('out_of_step', 'Out of step', 'qty'),
    public.stock_rp__col('clock_disagrees', 'Clock disagrees', 'text'));
  if v_level = 'detail' then
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('name', 'Product', 'text'), public.stock_rp__col('sales_net', 'Sales with no recipe', 'money'));
    with w as (
      select (x ->> 'location_id')::uuid as loc, x ->> 'site' as site, x ->> 'currency' as currency, (x ->> 'from_day')::date as from_day, (x ->> 'to_day')::date as to_day
        from jsonb_array_elements(v_win) x where x ->> 'from_day' is not null and (x ->> 'location_id')::uuid = any(v_sites)
         and not (coalesce((x ->> 'demo_sales')::boolean, false) and not coalesce((x ->> 'snapshot')::boolean, false))
    ),
    g as (
      select w.loc, w.site, w.currency, s.menu_item_id, sum(s.net) as net
        from w join sales_day_sums s on s.location_id = w.loc and s.business_day between w.from_day and w.to_day
       where not exists (select 1 from menu_item_recipes r where r.location_id = w.loc and r.menu_item_id = s.menu_item_id)
       group by w.loc, w.site, w.currency, s.menu_item_id
    ),
    pg as (
      select g.*, coalesce((select mi.name from menu_items mi where mi.location_id = g.loc::text and mi.id = g.menu_item_id), g.menu_item_id) as name from g
       where p_after is null
          or public.stock_rp__sk(g.net) < (p_after ->> 'sales_net')::numeric
          or (public.stock_rp__sk(g.net) = (p_after ->> 'sales_net')::numeric and (g.loc::text || ':' || g.menu_item_id) > coalesce(p_after ->> 'key', ''))
       order by public.stock_rp__sk(g.net) desc, g.loc::text || ':' || g.menu_item_id
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('location_id', pg.loc, 'site', pg.site, 'currency', pg.currency, 'menu_item_id', pg.menu_item_id, 'name', pg.name, 'sales_net', pg.net,
             'key', pg.loc::text || ':' || pg.menu_item_id) order by public.stock_rp__sk(pg.net) desc, pg.loc::text || ':' || pg.menu_item_id), '[]'::jsonb), count(*)
      into v_rows, v_n
      from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('sales_net', public.stock_rp__sk((v_rows -> (v_limit - 1) ->> 'sales_net')::numeric), 'key', v_rows -> (v_limit - 1) ->> 'key');
    end if;
  else
    v_rows := (select coalesce(jsonb_agg(r), '[]'::jsonb) from (select r from jsonb_array_elements(v_site_rows) r limit 1000) z);
  end if;
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'setup_health', p_from, p_to, false, v_level, v_cols, v_win, jsonb_build_array('Recipes over target and recipes with no cost come with the recipes update'))
            || jsonb_build_object('health_lines', case when v_level = 'detail' then
                 (select coalesce(jsonb_agg(jsonb_build_object('location_id', h.location_id, 'lines', (select coalesce(jsonb_agg(l) , '[]'::jsonb) from (select l from jsonb_array_elements(coalesce(h.lines, '[]'::jsonb)) l limit 50) z))), '[]'::jsonb)
                    from stock_co_site_health h where h.location_id = any(v_sites)) end),
    'totals', v_site_rows || (select coalesce(jsonb_agg(c || jsonb_build_object('no_recipe_pct', public.stock_rp__pct((c ->> 'no_recipe_sales_net')::numeric, (c ->> 'sales_net')::numeric),
                                 'recipes_over_target', null, 'recipes_missing_cost', null) order by c ->> 'currency'), '[]'::jsonb)
                               from jsonb_array_elements(public.stock_rp__strict(public.stock_rp__sum_rows(v_site_rows, array['sales_net', 'no_recipe_sales_net', 'items_no_supplier', 'supplier_items_no_allergens',
                                                                                                 'allergen_check_waiting', 'archived_holding', 'out_of_step']), v_site_rows,
                                                                                 array['sales_net', 'no_recipe_sales_net'])) c),
    'rows', v_rows, 'next', v_next);
end
$fn$;

-- ---------------------------------------------------------------------------------------------
-- stock_report_batches: batches made, planned against actual yield, made and used value.
-- ---------------------------------------------------------------------------------------------
create or replace function public.stock_report_batches(p_org uuid, p_sites uuid[], p_from date, p_to date, p_opts jsonb default null,
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
  v_sites  uuid[];
  v_b      jsonb;
  v_site_rows jsonb;
  v_rows   jsonb := '[]'::jsonb;
  v_next   jsonb;
  v_cols   jsonb;
  v_n      integer;
begin
  perform public.stock_rp__range_ok(p_from, p_to);
  if v_level not in ('site', 'recipe', 'batch') then
    v_level := 'site';
  end if;
  v_win := public.stock_rp__windows(v_g -> 'sites', p_from, p_to, false);
  v_fig := public.stock_rp__site_figures(v_g, v_win);
  v_sites := array(select (x ->> 'id')::uuid from jsonb_array_elements(v_g -> 'sites') x where v_site is null or (x ->> 'id')::uuid = v_site);
  v_b := (select coalesce(jsonb_agg(to_jsonb(z)), '[]'::jsonb) from (
  select b.location_id, (select x ->> 'name' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = b.location_id) as site,
         (select x ->> 'currency' from jsonb_array_elements(v_g -> 'sites') x where (x ->> 'id')::uuid = b.location_id) as currency,
         b.id, coalesce(b.produced_at, b.created_at) as produced_at, b.output_item_id, coalesce(b.output_name, i.name, 'Batch') as output_name, b.planned_qty, b.actual_qty, b.output_unit,
         b.theoretical_cost, b.actual_cost, b.lot_code,
         (select coalesce(nullif(btrim(p.full_name), ''), nullif(btrim(p.email), '')) from user_profiles p where p.id = b.produced_by) as produced_by_name
    from production_batches b
   cross join lateral public.stock_co__venue_day(b.location_id, coalesce(b.produced_at, b.created_at)) d
    left join inventory_items i on i.id = b.output_item_id
   where b.location_id = any(v_sites) and coalesce(b.status, '') not in ('CANCELLED', 'PLANNED') and d.business_day between p_from and p_to) z);
  select coalesce(jsonb_agg(jsonb_build_object(
           'location_id', (f ->> 'location_id')::uuid, 'site', f ->> 'site', 'currency', f ->> 'currency',
           'batches', coalesce(z.n, 0), 'planned_qty', coalesce(z.planned, 0), 'actual_qty', coalesce(z.actual, 0),
           'yield_pct', public.stock_rp__pct(z.actual, z.planned),
           'made_value', (f ->> 'made')::numeric, 'used_value', (f ->> 'used_in_batches')::numeric, 'variance_value', (f ->> 'made')::numeric - (f ->> 'used_in_batches')::numeric,
           'theoretical_cost', coalesce(z.theo, 0), 'actual_cost', coalesce(z.act, 0))
           order by f ->> 'site'), '[]'::jsonb)
    into v_site_rows
    from jsonb_array_elements(v_fig) f
    left join (select t.location_id, count(*) as n, sum(t.planned_qty) as planned, sum(t.actual_qty) as actual, sum(t.theoretical_cost) as theo, sum(t.actual_cost) as act
                 from jsonb_to_recordset(v_b) as t(location_id uuid, site text, currency text, id uuid, produced_at timestamptz, output_item_id uuid, output_name text, planned_qty numeric, actual_qty numeric, output_unit text, theoretical_cost numeric, actual_cost numeric, lot_code text, produced_by_name text) group by t.location_id) z on z.location_id = (f ->> 'location_id')::uuid
   where (f ->> 'location_id')::uuid = any(v_sites);
  v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('batches', 'Batches', 'qty'), public.stock_rp__col('planned_qty', 'Planned', 'qty'),
    public.stock_rp__col('actual_qty', 'Actual', 'qty'), public.stock_rp__col('yield_pct', 'Yield %', 'pct'), public.stock_rp__col('made_value', 'Made', 'money'),
    public.stock_rp__col('used_value', 'Used in batches', 'money'), public.stock_rp__col('variance_value', 'Variance', 'money'),
    public.stock_rp__col('theoretical_cost', 'Theoretical cost', 'money'), public.stock_rp__col('actual_cost', 'Actual cost', 'money'));
  if v_level = 'recipe' then
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('output_name', 'Made item', 'text'), public.stock_rp__col('batches', 'Batches', 'qty'),
      public.stock_rp__col('planned_qty', 'Planned', 'qty'), public.stock_rp__col('actual_qty', 'Actual', 'qty'), public.stock_rp__col('yield_pct', 'Yield %', 'pct'),
      public.stock_rp__col('made_value', 'Made', 'money'), public.stock_rp__col('used_value', 'Used', 'money'));
    with g as (
      select t.location_id, t.site, t.currency, t.output_item_id, min(t.output_name) as output_name, count(*) as n, sum(t.planned_qty) as planned, sum(t.actual_qty) as actual,
             sum(t.theoretical_cost) as theo, sum(t.actual_cost) as act,
             coalesce((select sum(d.value) from stock_day_sums d where d.location_id = t.location_id and d.inventory_item_id = t.output_item_id and d.demo = false
                         and d.movement_type = 'PRODUCTION_OUTPUT' and d.business_day between p_from and p_to), 0) as made_value
        from jsonb_to_recordset(v_b) as t(location_id uuid, site text, currency text, id uuid, produced_at timestamptz, output_item_id uuid, output_name text, planned_qty numeric, actual_qty numeric, output_unit text, theoretical_cost numeric, actual_cost numeric, lot_code text, produced_by_name text) group by t.location_id, t.site, t.currency, t.output_item_id
    ),
    pg as (
      select g.* from g
       where p_after is null
          or public.stock_rp__sk(g.made_value) < (p_after ->> 'made_value')::numeric
          or (public.stock_rp__sk(g.made_value) = (p_after ->> 'made_value')::numeric and (g.location_id::text || ':' || coalesce(g.output_item_id::text, g.output_name)) > coalesce(p_after ->> 'key', ''))
       order by public.stock_rp__sk(g.made_value) desc, g.location_id::text || ':' || coalesce(g.output_item_id::text, g.output_name)
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('location_id', pg.location_id, 'site', pg.site, 'currency', pg.currency, 'output_item_id', pg.output_item_id, 'output_name', pg.output_name,
             'key', pg.location_id::text || ':' || coalesce(pg.output_item_id::text, pg.output_name), 'batches', pg.n, 'planned_qty', pg.planned, 'actual_qty', pg.actual,
             'yield_pct', public.stock_rp__pct(pg.actual, pg.planned), 'made_value', pg.made_value, 'used_value', pg.act, 'theoretical_cost', pg.theo, 'actual_cost', pg.act)
             order by public.stock_rp__sk(pg.made_value) desc, pg.location_id::text || ':' || coalesce(pg.output_item_id::text, pg.output_name)), '[]'::jsonb), count(*)
      into v_rows, v_n
      from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('made_value', public.stock_rp__sk((v_rows -> (v_limit - 1) ->> 'made_value')::numeric), 'key', v_rows -> (v_limit - 1) ->> 'key');
    end if;
  elsif v_level = 'batch' then
    v_cols := jsonb_build_array(public.stock_rp__col('site', 'Site', 'text'), public.stock_rp__col('produced_at', 'Made', 'day'), public.stock_rp__col('output_name', 'Made item', 'text'),
      public.stock_rp__col('planned_qty', 'Planned', 'qty'), public.stock_rp__col('actual_qty', 'Actual', 'qty'), public.stock_rp__col('output_unit', 'Unit', 'text'),
      public.stock_rp__col('theoretical_cost', 'Theoretical cost', 'money'), public.stock_rp__col('actual_cost', 'Actual cost', 'money'),
      public.stock_rp__col('lot_code', 'Lot', 'text'), public.stock_rp__col('produced_by_name', 'Made by', 'text'));
    with pg as (
      select t.* from jsonb_to_recordset(v_b) as t(location_id uuid, site text, currency text, id uuid, produced_at timestamptz, output_item_id uuid, output_name text, planned_qty numeric, actual_qty numeric, output_unit text, theoretical_cost numeric, actual_cost numeric, lot_code text, produced_by_name text)
       where p_after is null
          or t.produced_at < (p_after ->> 'produced_at')::timestamptz
          or (t.produced_at = (p_after ->> 'produced_at')::timestamptz and t.id::text > coalesce(p_after ->> 'id', ''))
       order by t.produced_at desc, t.id
       limit v_limit + 1
    )
    select coalesce(jsonb_agg(jsonb_build_object('location_id', pg.location_id, 'site', pg.site, 'currency', pg.currency, 'id', pg.id, 'produced_at', pg.produced_at, 'output_name', pg.output_name,
             'planned_qty', pg.planned_qty, 'actual_qty', pg.actual_qty, 'output_unit', pg.output_unit, 'theoretical_cost', pg.theoretical_cost, 'actual_cost', pg.actual_cost,
             'lot_code', pg.lot_code, 'produced_by_name', pg.produced_by_name) order by pg.produced_at desc, pg.id), '[]'::jsonb), count(*)
      into v_rows, v_n
      from pg;
    if v_n > v_limit then
      v_rows := (select jsonb_agg(r) from (select r from jsonb_array_elements(v_rows) r limit v_limit) z);
      v_next := jsonb_build_object('produced_at', v_rows -> (v_limit - 1) ->> 'produced_at', 'id', v_rows -> (v_limit - 1) ->> 'id');
    end if;
  else
    v_rows := (select coalesce(jsonb_agg(r), '[]'::jsonb) from (select r from jsonb_array_elements(v_site_rows) r limit 1000) z);
  end if;
  return jsonb_build_object(
    'meta', public.stock_rp__meta(v_g, 'batches', p_from, p_to, false, v_level, v_cols, v_win, '[]'::jsonb),
    'totals', v_site_rows || (select coalesce(jsonb_agg(c || jsonb_build_object('yield_pct', public.stock_rp__pct((c ->> 'actual_qty')::numeric, (c ->> 'planned_qty')::numeric)) order by c ->> 'currency'), '[]'::jsonb)
                               from jsonb_array_elements(public.stock_rp__sum_rows(v_site_rows, array['batches', 'planned_qty', 'actual_qty', 'made_value', 'used_value', 'variance_value', 'theoretical_cost', 'actual_cost'])) c),
    'rows', v_rows, 'next', v_next);
end
$fn$;

-- ============================================================================
-- STEP 6. THE SAVES (public, definer, signed in Back Office logins; the Drop 1 common guard)
-- ============================================================================

-- The sites the company guard checks for a company wide save: every open site of the company.
create or replace function public.stock_rp__company_sites(p_org uuid)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(array(select l.id from locations l where l.org_id = p_org and coalesce(l.status, 'active') = 'active' order by l.name, l.id), '{}'::uuid[]);
$fn$;

-- Targets: upsert on (company, site, metric); an existing row needs its row_version; delete removes
-- a row (a site row gone = back to the company row). Green must be the better side of amber.
create or replace function public.stock_save_targets(p_org uuid, p_rows jsonb, p_section text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_g     jsonb;
  v_sites uuid[];
  v_r     jsonb;
  v_loc   uuid;
  v_met   text;
  v_green numeric;
  v_amber numeric;
  v_rv    integer;
  v_old   record;
  v_out   jsonb := '[]'::jsonb;
  v_id    uuid;
begin
  if p_org is null or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Nothing to save.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 100 then
    raise exception 'Save 100 targets or fewer at a time.' using errcode = '22023';
  end if;
  v_sites := array(select distinct (r ->> 'location_id')::uuid from jsonb_array_elements(p_rows) r where nullif(r ->> 'location_id', '') is not null);
  if coalesce(cardinality(v_sites), 0) = 0 then
    v_sites := public.stock_rp__company_sites(p_org);
  end if;
  v_g := public.stock_co__guard(p_org, null, 'company', v_sites);
  for v_r in select r from jsonb_array_elements(p_rows) r loop
    v_loc := nullif(v_r ->> 'location_id', '')::uuid;
    v_met := v_r ->> 'metric';
    if v_met is null or v_met not in ('gp_pct', 'gap_pct', 'waste_pct', 'comps_pct', 'days_on_hand', 'budget_pct', 'no_recipe_pct') then
      raise exception 'Pick a metric from the list.' using errcode = '22023';
    end if;
    v_rv := nullif(v_r ->> 'row_version', '')::integer;
    select t.* into v_old from stock_targets t where t.org_id = p_org and t.location_id is not distinct from v_loc and t.metric = v_met;
    if coalesce((v_r ->> 'delete')::boolean, false) then
      if v_old.id is not null then
        if v_rv is null then
          raise exception 'This screen is out of date. Reload it, then save again.' using errcode = '22023';
        end if;
        if v_rv <> v_old.row_version then
          return public.stock_co__conflict(p_org, array['targets'], v_old.id, v_old.row_version, v_loc, v_old.updated_at);
        end if;
        delete from stock_targets t where t.id = v_old.id;
        perform public.stock_co__log(p_org, v_loc, 'targets', v_old.id, v_met,
                                     jsonb_build_object('green_to', v_old.green_to, 'amber_to', v_old.amber_to), null, 'save');
      end if;
      continue;
    end if;
    v_green := nullif(v_r ->> 'green_to', '')::numeric;
    v_amber := nullif(v_r ->> 'amber_to', '')::numeric;
    if v_green is null or v_amber is null then
      raise exception 'Give a green and an amber number.' using errcode = '22023';
    end if;
    if v_met = 'days_on_hand' then
      if v_green < 0 or v_green > 365 or v_amber < 0 or v_amber > 365 then
        raise exception 'Days on hand is from 0 to 365.' using errcode = '22023';
      end if;
    elsif v_green < 0 or v_green > 100 or v_amber < 0 or v_amber > 100 then
      raise exception 'A percent is from 0 to 100.' using errcode = '22023';
    end if;
    if (v_met = 'gp_pct' and v_green < v_amber) or (v_met <> 'gp_pct' and v_green > v_amber) then
      raise exception 'Green must be the better side of amber.' using errcode = '22023';
    end if;
    if v_old.id is null then
      insert into stock_targets (org_id, location_id, metric, green_to, amber_to, updated_by)
      values (p_org, v_loc, v_met, v_green, v_amber, (v_g ->> 'uid')::uuid)
      returning id into v_id;
      perform public.stock_co__log(p_org, v_loc, 'targets', v_id, v_met, null, jsonb_build_object('green_to', v_green, 'amber_to', v_amber), 'save');
      v_out := v_out || jsonb_build_object('id', v_id, 'location_id', v_loc, 'metric', v_met, 'green_to', v_green, 'amber_to', v_amber, 'row_version', 1);
    else
      if v_rv is null then
        raise exception 'This screen is out of date. Reload it, then save again.' using errcode = '22023';
      end if;
      if v_rv <> v_old.row_version then
        return public.stock_co__conflict(p_org, array['targets'], v_old.id, v_old.row_version, v_loc, v_old.updated_at);
      end if;
      if v_old.green_to <> v_green or v_old.amber_to <> v_amber then
        update stock_targets t
           set green_to = v_green, amber_to = v_amber, row_version = t.row_version + 1, updated_at = now(), updated_by = (v_g ->> 'uid')::uuid
         where t.id = v_old.id;
        perform public.stock_co__log(p_org, v_loc, 'targets', v_old.id, v_met,
                                     jsonb_build_object('green_to', v_old.green_to, 'amber_to', v_old.amber_to),
                                     jsonb_build_object('green_to', v_green, 'amber_to', v_amber), 'save');
        v_out := v_out || jsonb_build_object('id', v_old.id, 'location_id', v_loc, 'metric', v_met, 'green_to', v_green, 'amber_to', v_amber, 'row_version', v_old.row_version + 1);
      else
        v_out := v_out || jsonb_build_object('id', v_old.id, 'location_id', v_loc, 'metric', v_met, 'green_to', v_green, 'amber_to', v_amber, 'row_version', v_old.row_version);
      end if;
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'rows', v_out);
end
$fn$;

-- Key item ratios: at most 20 live rows a company; the used item must be a live company item.
create or replace function public.stock_save_key_ratios(p_org uuid, p_rows jsonb, p_section text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_g     jsonb;
  v_r     jsonb;
  v_id    uuid;
  v_old   record;
  v_rv    integer;
  v_rule  jsonb;
  v_live  integer;
  v_out   jsonb := '[]'::jsonb;
begin
  if p_org is null or p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'Nothing to save.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 50 then
    raise exception 'Save 50 key items or fewer at a time.' using errcode = '22023';
  end if;
  v_g := public.stock_co__guard(p_org, null, 'company', public.stock_rp__company_sites(p_org));
  for v_r in select r from jsonb_array_elements(p_rows) r loop
    v_id := nullif(v_r ->> 'id', '')::uuid;
    v_rv := nullif(v_r ->> 'row_version', '')::integer;
    select k.* into v_old from stock_key_ratios k where false;
    if v_id is not null then
      select k.* into v_old from stock_key_ratios k where k.id = v_id and k.org_id = p_org;
      if v_old.id is null then
        raise exception 'That key item was not found.' using errcode = '22023';
      end if;
      if v_rv is null then
        raise exception 'This screen is out of date. Reload it, then save again.' using errcode = '22023';
      end if;
      if v_rv <> v_old.row_version then
        return public.stock_co__conflict(p_org, array['key_ratio'], v_old.id, v_old.row_version, null, v_old.updated_at);
      end if;
    end if;
    if coalesce((v_r ->> 'archive')::boolean, false) then
      if v_old.id is not null and v_old.archived_at is null then
        update stock_key_ratios k set archived_at = now(), row_version = k.row_version + 1, updated_at = now(), updated_by = (v_g ->> 'uid')::uuid where k.id = v_old.id;
        perform public.stock_co__log(p_org, null, 'key_ratio', v_old.id, 'archived_at', null, to_jsonb(now()), 'save');
      end if;
      continue;
    end if;
    if nullif(btrim(coalesce(v_r ->> 'name', '')), '') is null then
      raise exception 'Give the key item a name.' using errcode = '22023';
    end if;
    if nullif(v_r ->> 'used_item_id', '') is null
       or not exists (select 1 from stock_co_items i where i.id = (v_r ->> 'used_item_id')::uuid and i.org_id = p_org and i.archived_at is null) then
      raise exception 'Pick a stock item from the company list.' using errcode = '22023';
    end if;
    v_rule := coalesce(v_r -> 'sold_rule', '{}'::jsonb);
    if jsonb_typeof(v_rule) <> 'object' or coalesce(v_rule ->> 'kind', '') not in ('category', 'items', 'all') then
      raise exception 'Say what counts as sold: all, a category or chosen products.' using errcode = '22023';
    end if;
    if v_old.id is null then
      select count(*) into v_live from stock_key_ratios k where k.org_id = p_org and k.archived_at is null;
      if v_live >= 20 then
        raise exception 'That is 20 key items. Archive one first.' using errcode = '55000';
      end if;
      insert into stock_key_ratios (org_id, name, used_item_id, used_unit, sold_rule, recipe_amount, sort_order, updated_by)
      values (p_org, btrim(v_r ->> 'name'), (v_r ->> 'used_item_id')::uuid, coalesce(nullif(v_r ->> 'used_unit', ''), 'each'), v_rule,
              nullif(v_r ->> 'recipe_amount', '')::numeric, coalesce(nullif(v_r ->> 'sort_order', '')::integer, 0), (v_g ->> 'uid')::uuid)
      returning id into v_id;
      perform public.stock_co__log(p_org, null, 'key_ratio', v_id, 'name', null, to_jsonb(btrim(v_r ->> 'name')), 'save');
      v_out := v_out || jsonb_build_object('id', v_id, 'name', btrim(v_r ->> 'name'), 'row_version', 1);
    else
      update stock_key_ratios k
         set name = btrim(v_r ->> 'name'), used_item_id = (v_r ->> 'used_item_id')::uuid, used_unit = coalesce(nullif(v_r ->> 'used_unit', ''), k.used_unit),
             sold_rule = v_rule, recipe_amount = nullif(v_r ->> 'recipe_amount', '')::numeric, sort_order = coalesce(nullif(v_r ->> 'sort_order', '')::integer, k.sort_order),
             archived_at = null, row_version = k.row_version + 1, updated_at = now(), updated_by = (v_g ->> 'uid')::uuid
       where k.id = v_old.id;
      perform public.stock_co__log(p_org, null, 'key_ratio', v_old.id, 'name', to_jsonb(v_old.name), to_jsonb(btrim(v_r ->> 'name')), 'save');
      v_out := v_out || jsonb_build_object('id', v_old.id, 'name', btrim(v_r ->> 'name'), 'row_version', v_old.row_version + 1);
    end if;
  end loop;
  return jsonb_build_object('ok', true, 'rows', v_out);
end
$fn$;

-- ============================================================================
-- STEP 7. EXPORTS: the job a login starts, and the runner's functions (service role)
-- ============================================================================
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
                                           'key_ratios', 'setup_health', 'batches', 'league') then
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

create or replace function public.stock_report_export_cancel(p_job uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or public.is_anon_session() or not public.second_step_ok() then
    raise exception 'Sign in to Back Office to see stock reports.' using errcode = '42501';
  end if;
  update report_export_jobs j
     set status = 'cancelled', done_at = now()
   where j.id = p_job and j.user_id = v_uid and j.status in ('waiting', 'running');
  return jsonb_build_object('ok', true);
end
$fn$;

-- The runner claims up to p_max jobs (waiting, or running but silent for 3 minutes), and names the
-- done jobs whose files have expired (set to expired here; the runner removes the files).
create or replace function public.report_export_claim(p_max integer default 3)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_jobs    jsonb;
  v_expired jsonb;
begin
  if public._fence_api_role() <> 'service_role' then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  with c as (
    select j.id from report_export_jobs j
     where j.status = 'waiting' or (j.status = 'running' and j.claimed_at < now() - interval '3 minutes')
     order by j.created_at
     limit least(greatest(coalesce(p_max, 3), 1), 10)
       for update skip locked
  ),
  u as (
    update report_export_jobs j
       set status = case when j.attempts + 1 > 5 then 'failed' else 'running' end,
           error = case when j.attempts + 1 > 5 then 'Stopped after 5 tries.' else j.error end,
           done_at = case when j.attempts + 1 > 5 then now() else j.done_at end,
           claimed_at = now(), started_at = coalesce(j.started_at, now()), attempts = j.attempts + 1
      from c
     where j.id = c.id
    returning j.*
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', u.id, 'org_id', u.org_id, 'user_id', u.user_id, 'report', u.report, 'args', u.args, 'columns', u.columns,
                                               'cursor', u.cursor, 'pages', u.pages, 'parts', u.parts, 'rows', u.rows, 'file_prefix', u.file_prefix, 'attempts', u.attempts)
                            order by u.created_at), '[]'::jsonb)
    into v_jobs
    from u where u.status = 'running';
  with e as (
    update report_export_jobs j set status = 'expired'
     where j.status = 'done' and j.expires_at < now()
    returning j.id, j.file_prefix
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'file_prefix', e.file_prefix)), '[]'::jsonb) into v_expired from e;
  return jsonb_build_object('jobs', v_jobs, 'expired', v_expired);
end
$fn$;

-- One page of a job, read AS THE JOB'S LOGIN (its reach checked again now): the request claims are
-- set to that user for this transaction only (the Drop 1 dry run pattern), the report function is
-- called with the job's args and the saved cursor, and the job's columns, cursor, pages and rows move on.
create or replace function public.report_export_page(p_job uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_j     record;
  v_sites uuid[];
  v_lost  text;
  v_ans   jsonb;
  v_sql   text;
begin
  if public._fence_api_role() <> 'service_role' then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  select j.* into v_j from report_export_jobs j where j.id = p_job for update;
  if v_j.id is null then
    raise exception 'That export was not found.' using errcode = '22023';
  end if;
  if v_j.status <> 'running' then
    return jsonb_build_object('rows', '[]'::jsonb, 'next', null, 'columns', v_j.columns, 'status', v_j.status);
  end if;
  v_sites := array(select (x #>> '{}')::uuid from jsonb_array_elements(v_j.args -> 'sites') x);
  if not public.stock_rp__reach_for(v_j.user_id, v_j.org_id, v_sites) then
    select l.name into v_lost from locations l
     where l.id = any(v_sites)
       and not (exists (select 1 from user_profiles p where p.id = v_j.user_id and p.role = 'super_admin')
                or exists (select 1 from user_profiles p where p.id = v_j.user_id and p.org_id = v_j.org_id and (p.role = 'owner' or p.stock_control = 'all'))
                or exists (select 1 from user_locations ul where ul.user_id = v_j.user_id and ul.location_id = l.id))
     order by l.name limit 1;
    update report_export_jobs j set status = 'failed', error = 'This login no longer reaches ' || coalesce(v_lost, 'a site') || '.', done_at = now()
     where j.id = v_j.id;
    return jsonb_build_object('rows', '[]'::jsonb, 'next', null, 'columns', v_j.columns, 'status', 'failed', 'error', 'This login no longer reaches ' || coalesce(v_lost, 'a site') || '.');
  end if;
  perform set_config('request.jwt.claims',
                     jsonb_build_object('sub', v_j.user_id, 'role', 'authenticated', 'aal', 'aal2', 'is_anonymous', false, 'aud', 'authenticated')::text, true);
  v_sql := format('select public.stock_report_%I($1, $2, $3, $4, $5, $6, 1000)', v_j.report);
  execute v_sql into v_ans
    using v_j.org_id, v_sites, (v_j.args ->> 'from')::date, (v_j.args ->> 'to')::date, coalesce(v_j.args -> 'opts', '{}'::jsonb), v_j.cursor;
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
  update report_export_jobs j
     set columns = case when j.pages = 0 then coalesce(v_ans -> 'meta' -> 'columns', '[]'::jsonb) else j.columns end,
         cursor = v_ans -> 'next',
         pages = j.pages + 1,
         rows = j.rows + coalesce(jsonb_array_length(case when jsonb_typeof(v_ans -> 'rows') = 'array' then v_ans -> 'rows' else '[]'::jsonb end), 0),
         claimed_at = now()
   where j.id = v_j.id;
  return jsonb_build_object('rows', case when jsonb_typeof(v_ans -> 'rows') = 'array' then v_ans -> 'rows' else '[]'::jsonb end,
                            'totals', v_ans -> 'totals', 'next', v_ans -> 'next',
                            'columns', case when v_j.pages = 0 then coalesce(v_ans -> 'meta' -> 'columns', '[]'::jsonb) else v_j.columns end,
                            'meta', v_ans -> 'meta', 'status', 'running');
end
$fn$;

create or replace function public.report_export_finish(p_job uuid, p_patch jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_status text := coalesce(p_patch ->> 'status', 'running');
begin
  if public._fence_api_role() <> 'service_role' then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  if v_status not in ('done', 'failed', 'running') then
    raise exception 'report_export_finish: status is done, failed or running.' using errcode = '22023';
  end if;
  update report_export_jobs j
     set status = case when j.status in ('cancelled', 'expired') then j.status else v_status end,
         parts = coalesce(nullif(p_patch ->> 'parts', '')::integer, j.parts),
         error = case when v_status = 'failed' then coalesce(p_patch ->> 'error', 'The export stopped.') else j.error end,
         done_at = case when v_status in ('done', 'failed') then now() else j.done_at end,
         expires_at = case when v_status = 'done' then now() + interval '7 days' else j.expires_at end,
         claimed_at = case when v_status = 'running' then now() else j.claimed_at end
   where j.id = p_job;
  return jsonb_build_object('ok', found);
end
$fn$;

-- The download check: the job belongs to this user, is done, is not expired, and the user still
-- reaches every site of it.
create or replace function public.report_export_reach_ok(p_job uuid, p_user uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_j record;
begin
  if public._fence_api_role() <> 'service_role' then
    raise exception 'Not allowed.' using errcode = '42501';
  end if;
  select j.* into v_j from report_export_jobs j where j.id = p_job;
  if v_j.id is null or v_j.user_id is distinct from p_user or v_j.status <> 'done' or v_j.expires_at is null or v_j.expires_at < now() then
    return false;
  end if;
  return public.stock_rp__reach_for(p_user, v_j.org_id, array(select (x #>> '{}')::uuid from jsonb_array_elements(v_j.args -> 'sites') x));
end
$fn$;

-- ============================================================================
-- STEP 8. THE SALES HISTORY BACKFILL (queued in chunks, 15 venue days a minute, newest first)
-- ============================================================================
-- For every venue with a closed check: every venue business day from the later of its first check
-- day and 13 months ago to the venue's yesterday that has no sales day total yet, queued for the
-- drainer's drain (20 days a minute, stock first) so a day a till closes now is never behind it.
create temp table _stock_native4a_backfill (org_id uuid, location_id uuid, days integer) on commit drop;

with v as (
  select l.id, l.org_id, d.business_day as first_day, public.stock_co__today(l.id) - 1 as last_day
    from public.locations l
   cross join lateral (select min(c.closed_at) as at from public.closed_checks c where c.location_id = l.id::text) f
   cross join lateral public.stock_co__venue_day(l.id, f.at) d
   where f.at is not null
),
days as (
  select v.id as location_id, v.org_id, g::date as business_day
    from v
   cross join lateral generate_series(greatest(v.first_day, (current_date - interval '13 months')::date)::timestamp, v.last_day::timestamp, interval '1 day') g
   where v.first_day is not null and v.last_day >= greatest(v.first_day, (current_date - interval '13 months')::date)
     and not exists (select 1 from public.sales_day_sums s where s.location_id = v.id and s.business_day = g::date)
),
q as (
  insert into public.sales_day_sums_queue (location_id, business_day, reason, queued_at, attempts, due_at)
  select d.location_id, d.business_day, 'drop4a_backfill', now(), 0,
         now() + ((row_number() over (order by d.business_day desc, d.location_id) - 1) / 15) * interval '1 minute'
    from days d
   order by d.business_day desc, d.location_id
  on conflict (location_id, business_day) do nothing
  returning location_id
)
insert into _stock_native4a_backfill (org_id, location_id, days)
select l.org_id, q.location_id, count(*)
  from q join public.locations l on l.id = q.location_id
 group by l.org_id, q.location_id;

-- ============================================================================
-- STEP 9. GRANTS (every new function revoked from public and anon by name, then exactly these grants)
-- ============================================================================
revoke all on function public.stock_report_guard(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_dashboard(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_league(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_attention(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_value(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_movement(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_gap(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_cogs(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_product_gp(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_waste(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_purchases(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_prices(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_days_on_hand(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_par(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_key_ratios(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_setup_health(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_batches(uuid, uuid[], date, date, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_targets(uuid, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_key_ratios(uuid, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_export_start(text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_report_export_cancel(uuid) from public, anon, authenticated, service_role;
revoke all on function public.report_export_cron_ok(text) from public, anon, authenticated, service_role;
revoke all on function public.report_export_run_due() from public, anon, authenticated, service_role;
revoke all on function public.report_export_claim(integer) from public, anon, authenticated, service_role;
revoke all on function public.report_export_page(uuid) from public, anon, authenticated, service_role;
revoke all on function public.report_export_finish(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.report_export_reach_ok(uuid, uuid) from public, anon, authenticated, service_role;
-- the internal helpers (owner only), by name
revoke all on function public.stock_rp__is_demo(text) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__range_ok(date, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__page_cap(integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__week_of(date, smallint) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__pct(numeric, numeric) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__sk(numeric) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__bucket(text, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__type_of(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__rag(uuid, uuid, text, numeric) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__snapshot(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__part_locked(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__takes_from(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__window(uuid, date, date, boolean) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__windows(jsonb, date, date, boolean) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__value_at(uuid[], date) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__site_value_at(uuid[], date) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__open_close(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__site_ledger(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__site_ledger_split(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__site_sales(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__daily_use(uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__labour(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__not_posted(uuid[], date, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__reach_for(uuid, uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__sum_rows(jsonb, text[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__snap_num(jsonb, text, numeric) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__meta_windows(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__meta(jsonb, text, date, date, boolean, text, jsonb, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__col(text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__opt_site(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__site_figures(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__derive(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__sum_keys() from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__totals(uuid, jsonb, text[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__league_rows(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__league_keep() from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__league_cols() from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__cogs_rows(uuid, jsonb, text[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__company_sites(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__demo_sales(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__site_old_sold(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__strict_keys() from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__strict(jsonb, jsonb, text[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_rp__fig_notes(jsonb) from public, anon, authenticated, service_role;

-- Every internal helper of this file (the stock_rp__ prefix, and report_export_, matched as regular
-- expressions): revoked from every API role. A revoke, never a drop.
do $internals_4a$
declare
  v_fn record;
begin
  for v_fn in
    select p.oid::regprocedure as sig, p.prokind
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and (p.proname ~ '^stock_rp__' or p.proname ~ '^report_export_' or p.proname = 'stock_report_guard')
     order by p.oid
  loop
    execute format('revoke all on %s %s from public, anon, authenticated, service_role',
                   case when v_fn.prokind = 'p' then 'procedure' else 'function' end, v_fn.sig);
  end loop;
end
$internals_4a$;

-- Then exactly these grants. Signed in Back Office logins (each function checks who is asking):
grant execute on function public.stock_report_dashboard(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated, service_role;
grant execute on function public.stock_report_league(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated, service_role;
grant execute on function public.stock_report_attention(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_value(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_movement(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_gap(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_cogs(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_product_gp(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_waste(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_purchases(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_prices(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_days_on_hand(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_par(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_key_ratios(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_setup_health(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_report_batches(uuid, uuid[], date, date, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_save_targets(uuid, jsonb, text) to authenticated;
grant execute on function public.stock_save_key_ratios(uuid, jsonb, text) to authenticated;
grant execute on function public.stock_report_export_start(text, jsonb) to authenticated;
grant execute on function public.stock_report_export_cancel(uuid) to authenticated;
-- The report-export edge function (service role):
grant execute on function public.report_export_cron_ok(text) to service_role;
grant execute on function public.report_export_claim(integer) to service_role;
grant execute on function public.report_export_page(uuid) to service_role;
grant execute on function public.report_export_finish(uuid, jsonb) to service_role;
grant execute on function public.report_export_reach_ok(uuid, uuid) to service_role;
-- Nobody but postgres (pg_cron): report_export_run_due. Nobody: stock_report_guard and every stock_rp__.

-- ============================================================================
-- STEP 10. ASSERTS (raise, nothing changed)
-- ============================================================================
do $asserts_4a$
declare
  v_bad text;
begin
  select string_agg(p.proname, ', ' order by p.proname) into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and (p.proname ~ '^stock_rp__' or p.proname ~ '^report_export_' or p.proname ~ '^stock_report_' or p.proname in ('stock_save_targets', 'stock_save_key_ratios'))
     and has_function_privilege('anon', p.oid, 'execute');
  if v_bad is not null then
    raise exception 'The anon key can run a 4a function (%). Nothing was changed. Send this line to Claude.', v_bad;
  end if;
  select string_agg(p.proname, ', ' order by p.proname) into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and (p.proname ~ '^stock_rp__' or p.proname = 'stock_report_guard'
          or (p.proname ~ '^report_export_'))
     and has_function_privilege('authenticated', p.oid, 'execute');
  if v_bad is not null then
    raise exception 'A signed in login can run a 4a internal (%). Nothing was changed. Send this line to Claude.', v_bad;
  end if;
  if has_function_privilege('service_role', 'public.report_export_run_due()', 'execute')
     or has_function_privilege('authenticated', 'public.report_export_run_due()', 'execute') then
    raise exception 'report_export_run_due is open to the API. Nothing was changed. Send this line to Claude.';
  end if;
  if exists (select 1 from pg_class c where c.oid in ('public.stock_targets'::regclass, 'public.stock_key_ratios'::regclass, 'public.report_export_jobs'::regclass) and not c.relrowsecurity) then
    raise exception 'A 4a table has no row level security. Nothing was changed. Send this line to Claude.';
  end if;
  if exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename in ('stock_targets', 'stock_key_ratios', 'report_export_jobs')
              and p.policyname <> 'second_step_fence' and p.cmd <> 'SELECT') then
    raise exception 'A 4a table has a write policy. Nothing was changed. Send this line to Claude.';
  end if;
  if not exists (select 1 from pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = 'report_exports_owner_read'
                  and p.qual not like '%accessible_location%' and p.qual not like '%ops_writable_location%' and p.qual like '%foldername%') then
    raise exception 'The report-exports read policy is not as written. Nothing was changed. Send this line to Claude.';
  end if;
end
$asserts_4a$;

notify pgrst, 'reload schema';

-- ============================================================================
-- STEP 11. THE COMPARE: no site row, ledger row, login or link changed
-- ============================================================================
create temp table _stock_native4a_now (
  location_id  uuid,
  metric       text,
  value        numeric,
  txt          text
) on commit drop;

do $compare_4a$
declare
  v_bad text;
begin
  insert into _stock_native4a_now (location_id, metric, value)
  select l.id, m.metric, m.value
    from public.locations l
   cross join lateral (values
     ('n:inventory_items',   (select count(*) from public.inventory_items x where x.location_id = l.id)::numeric),
     ('n:stock_movements',   (select count(*) from public.stock_movements x where x.location_id = l.id)::numeric),
     ('n:stock_counts',      (select count(*) from public.stock_counts x where x.location_id = l.id)::numeric),
     ('n:suppliers',         (select count(*) from public.suppliers x where x.location_id = l.id)::numeric),
     ('n:recipes',           (select count(*) from public.recipes x where x.location_id = l.id)::numeric),
     ('n:waste_events',      (select count(*) from public.waste_events x where x.location_id = l.id)::numeric),
     ('n:stock_day_sums',    (select count(*) from public.stock_day_sums x where x.location_id = l.id)::numeric),
     ('n:sales_day_sums',    (select count(*) from public.sales_day_sums x where x.location_id = l.id)::numeric),
     ('s:on_hand',           (select sum(x.on_hand) from public.inventory_items x where x.location_id = l.id)),
     ('s:current_cost',      (select sum(x.current_cost) from public.inventory_items x where x.location_id = l.id)),
     ('s:books',             (select sum(x.on_hand * x.current_cost) from public.inventory_items x where x.location_id = l.id)),
     ('s:mv_qty',            (select sum(x.qty_base) from public.stock_movements x where x.location_id = l.id)),
     ('s:mv_value',          (select sum(x.value_delta) from public.stock_movements x where x.location_id = l.id)),
     ('s:day_qty',           (select sum(x.qty_base) from public.stock_day_sums x where x.location_id = l.id)),
     ('s:day_value',         (select sum(x.value) from public.stock_day_sums x where x.location_id = l.id)),
     ('s:sales_net',         (select sum(x.net) from public.sales_day_sums x where x.location_id = l.id))
   ) as m(metric, value)
   where exists (select 1 from public.inventory_items i where i.location_id = l.id);
  insert into _stock_native4a_now (location_id, metric, value, txt)
  values ('00000000-0000-0000-0000-000000000000', 'md5:user_profiles', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.user_profiles t)),
         ('00000000-0000-0000-0000-000000000000', 'md5:user_locations', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.user_locations t));
  select string_agg(coalesce(b.metric, a.metric) || ' at ' || coalesce(b.location_id, a.location_id)::text, ', ')
    into v_bad
    from _stock_native4a_snap b
    full join _stock_native4a_now a on a.location_id = b.location_id and a.metric = b.metric
   where a.metric is null or b.metric is null
      or a.value is distinct from b.value or a.txt is distinct from b.txt;
  if v_bad is not null then
    raise exception 'Drop 4a changed a site row or a login (%). Nothing was changed. Send this line to Claude.', left(v_bad, 600);
  end if;
end
$compare_4a$;

-- ============================================================================
-- STEP 12. THE TIMED DASHBOARD (one call per multi site company, the last 31 days, as the file's
-- own role with the service claims for the call only; skipped for a one site company)
-- ============================================================================
create temp table _stock_native4a_timed (org_id uuid, dashboard_ms text, league_rows integer, demo_left_out boolean) on commit drop;

do $timed_4a$
declare
  v_org   record;
  v_sites uuid[];
  v_t0    timestamptz;
  v_ans   jsonb;
begin
  for v_org in
    select distinct l.org_id
      from public.locations l
     where l.org_id is not null and exists (select 1 from public.inventory_items i where i.location_id = l.id)
     order by l.org_id
  loop
    v_sites := array(select l.id from public.locations l where l.org_id = v_org.org_id and coalesce(l.status, 'active') = 'active' order by l.name, l.id limit 50);
    if cardinality(v_sites) < 2 then
      insert into _stock_native4a_timed values (v_org.org_id, 'skipped', cardinality(v_sites), false);
      continue;
    end if;
    perform set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);
    v_t0 := clock_timestamp();
    v_ans := public.stock_report_dashboard(v_org.org_id, v_sites, current_date - 30, current_date, null, null, 1000);
    insert into _stock_native4a_timed
    values (v_org.org_id, round(extract(epoch from clock_timestamp() - v_t0) * 1000)::text,
            coalesce(jsonb_array_length(v_ans -> 'rows' -> 'league'), 0), coalesce((v_ans -> 'meta' ->> 'demo_left_out')::boolean, false));
    perform set_config('request.jwt.claims', '', true);
  end loop;
end
$timed_4a$;

-- ============================================================================
-- VISIBLE CHECK (the SQL editor shows this last result; paste it back to Claude). One row per company
-- that holds stock. Expected live: a59a6d97 multi true, backfill about 360 days, dashboard_ms under
-- 5000, demo_left_out true; cd97f0f0 multi true, backfill about 110 days, demo_left_out false;
-- fcbddcfd multi false, dashboard 'skipped'. Every row: new_tables 3, new_functions 26,
-- internals_open_to_api false, anon_can_read_reports false, bucket_ok, policy_ok, cron_job and
-- vault_key true, site_rows_changed 0, logins_changed false.
-- ============================================================================
select o.org_id,
       (select count(*) filter (where coalesce(l.status, 'active') = 'active') >= 2
               or exists (select 1 from public.stock_co_settings cs where cs.org_id = o.org_id and cs.multi_since is not null)
          from public.locations l where l.org_id = o.org_id) as multi,
       (select count(*)::integer from unnest(array['stock_targets', 'stock_key_ratios', 'report_export_jobs']) t(n) where to_regclass('public.' || t.n) is not null) as new_tables,
       (select count(*)::integer from (values
          ('public.stock_report_dashboard(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_report_league(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
          ('public.stock_report_attention(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_report_value(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
          ('public.stock_report_movement(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_report_gap(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
          ('public.stock_report_cogs(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_report_product_gp(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
          ('public.stock_report_waste(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_report_purchases(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
          ('public.stock_report_prices(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_report_days_on_hand(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
          ('public.stock_report_par(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_report_key_ratios(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
          ('public.stock_report_setup_health(uuid,uuid[],date,date,jsonb,jsonb,integer)'), ('public.stock_report_batches(uuid,uuid[],date,date,jsonb,jsonb,integer)'),
          ('public.stock_save_targets(uuid,jsonb,text)'), ('public.stock_save_key_ratios(uuid,jsonb,text)'),
          ('public.stock_report_export_start(text,jsonb)'), ('public.stock_report_export_cancel(uuid)'),
          ('public.report_export_cron_ok(text)'), ('public.report_export_claim(integer)'), ('public.report_export_page(uuid)'),
          ('public.report_export_finish(uuid,jsonb)'), ('public.report_export_reach_ok(uuid,uuid)'), ('public.report_export_run_due()')) f(sig)
         where to_regprocedure(f.sig) is not null) as new_functions,
       exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace
                  and (p.proname ~ '^stock_rp__' or p.proname = 'stock_report_guard' or p.proname = 'report_export_run_due')
                  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                       or has_function_privilege('service_role', p.oid, 'execute'))) as internals_open_to_api,
       exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace and p.proname ~ '^stock_report_'
                  and has_function_privilege('anon', p.oid, 'execute')) as anon_can_read_reports,
       exists (select 1 from storage.buckets b where b.id = 'report-exports' and b.public = false) as bucket_ok,
       exists (select 1 from pg_policies p where p.schemaname = 'storage' and p.tablename = 'objects' and p.policyname = 'report_exports_owner_read') as policy_ok,
       exists (select 1 from cron.job c where c.jobname = 'report-export-run') as cron_job,
       exists (select 1 from vault.secrets s where s.name = 'report_export_cron_key') as vault_key,
       coalesce((select sum(b.days) from _stock_native4a_backfill b where b.org_id = o.org_id), 0)::integer as backfill_days_queued,
       ceil(coalesce((select sum(b.days) from _stock_native4a_backfill b where b.org_id = o.org_id), 0) / 15.0)::integer as backfill_minutes,
       (select t.dashboard_ms from _stock_native4a_timed t where t.org_id = o.org_id) as dashboard_ms,
       (select t.league_rows from _stock_native4a_timed t where t.org_id = o.org_id) as league_rows,
       coalesce((select t.demo_left_out from _stock_native4a_timed t where t.org_id = o.org_id), false) as demo_left_out,
       (select count(*)::integer from _stock_native4a_snap b join _stock_native4a_now a on a.location_id = b.location_id and a.metric = b.metric
         where (a.value is distinct from b.value or a.txt is distinct from b.txt) and b.metric not like 'md5:%') as site_rows_changed,
       exists (select 1 from _stock_native4a_snap b join _stock_native4a_now a on a.location_id = b.location_id and a.metric = b.metric
                where b.metric like 'md5:%' and a.txt is distinct from b.txt) as logins_changed
  from (select distinct l.org_id from public.locations l
         where l.org_id is not null and exists (select 1 from public.inventory_items i where i.location_id = l.id)) o
 order by o.org_id;
