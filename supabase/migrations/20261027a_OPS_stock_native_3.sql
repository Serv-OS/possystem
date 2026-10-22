-- 20261027a_OPS_stock_native_3.sql
-- Multi site stock, Drop 3: purchasing, forecast, counts, transfers and the central kitchen (map 8.4).
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  NEEDS 20261021a_OPS_stock_native_0a.sql, its revalue file,              #
-- #  20261022a_OPS_stock_native_0b.sql, 20261024a_OPS_stock_native_1.sql,    #
-- #  20261023a_OPS_stock_drainer_v2.sql AND 20261025a_OPS_stock_native_2.sql #
-- #  live first (the guard refuses otherwise). It does NOT need 20261026a.    #
-- #  One transaction: any error and nothing changes.                          #
-- #  Run after UK close. NEVER on 25 Oct 2026 (UK clocks) or 1 Nov 2026       #
-- #  (US clocks). Lock wait 3 s (it gives up, nothing changes).               #
-- ############################################################################
--
-- WHAT IT IS
--   The Drop 3 screens read and save through the functions made here: the Order pad context (next
--   delivery, order by time, minimum, maximum, delivery fee, budget, saved lists, standing orders),
--   approvals over a site's limit for a supplier (passed up at 60 and 30 minutes, sent at the order by
--   time as "sent unapproved" when the company setting is on), standing orders and days with no delivery,
--   head office ordering for many sites, Due to order, the company Orders list, Deliveries, invoices with
--   the 3 way match, the invoice price rule and credit requests, the company invoice inbox, one invoice for
--   many sites, credits, supplier price changes, budgets, the forecast (with the reason a manager changed
--   it, shown on the rota too), count plans and templates with each site's shelf order, a second approval
--   for a count over a limit, a manager PIN for waste over a limit, locked periods, transfer requests and
--   disputes, the central kitchen (Orders in, production plan, ingredients, pick and send, kitchen only
--   recipes, recharges) and the alert ledger the stock-notify function sends from (SMS, email, the bell).
--
-- WHAT IT NEVER DOES
--   It writes no site row, no login (user_profiles, user_locations), no menu row and no order, transfer,
--   count, waste or forecast row. New columns start at their defaults (null). Nothing here moves an on hand,
--   a cost, a ledger or a count number by itself: every stock movement is a person's act (a receive, a
--   waste, a count approval, a transfer leg) or the order by time a company agreed to. Every order channel
--   is unchanged (the drainer, stock_explode and the till, kiosk, online, QR, catering, pay at table, MPOS,
--   HubRise and ezCater paths are not touched). A central kitchen order is received ONLY through its
--   transfer. Before the check row it compares every count, version and sum of the site rows per venue,
--   the order, invoice, transfer, count, waste and forecast counts, and the md5 of every login and menu row,
--   with the snapshot it took under the item row locks at the start, and stops on any difference.
--
-- HOW IT RUNS
--   Paste the whole file into the SQL editor and run it once (one paste is one transaction; no begin or
--   commit in here). The first statement is the guard. Then:
--     set local lock_timeout = '3s';  set local statement_timeout = '300s';
--   It checks that the 33 stock bodies it rebuilds or leans on are still the text it was written against
--   (else: 'A stock function changed since this file was written. Ask Claude for a new file.'), saves the
--   10 it rebuilds in stock_native_backup (names 'd3:...') for the rollback, takes the item row locks and
--   the snapshot, builds, makes the two vault keys and the two cron jobs (stock-notify and po-cutoff-run,
--   every minute), compares, and shows the check row last. Paste it back.
--
-- IF IT STOPS
--   Any error means nothing changed. A lock wait or 'deadlock detected': run it again a quiet minute
--   later. Any other words: send them to Claude.
--
-- ROLLBACK
--   20261027a_OPS_stock_native_3_ROLLBACK.sql (puts the 10 Drop 2 bodies back; the new tables go; every
--   order, transfer, count, waste event, invoice and forecast amount is kept).

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This file is for the Ops database only. Nothing was changed.';
  end if;
  if to_regclass('public.stock_native_backup') is null or to_regclass('public.stock_co_items') is null
     or to_regclass('public.stock_save_queue') is null then
    raise exception 'Run 20261021a_OPS_stock_native_0a.sql and its revalue file first. Nothing was changed.';
  end if;
  if not exists (select 1 from pg_trigger g where not g.tgisinternal and g.tgname = 'stock_co_lock_upd') then
    raise exception 'Run 20261022a_OPS_stock_native_0b.sql first. Nothing was changed.';
  end if;
  if to_regclass('public.stock_order_rules') is null
     or (select count(*) from public.stock_native_backup b where left(b.name, 3) = 'd1:') <> 24 then
    raise exception 'Run 20261024a_OPS_stock_native_1.sql first. Nothing was changed.';
  end if;
  if to_regclass('public.stock_co_option_rules') is null
     or (select count(*) from public.stock_native_backup b where left(b.name, 11) = 'drainer_v2:') <> 7 then
    raise exception 'Run 20261023a_OPS_stock_drainer_v2.sql first. Nothing was changed.';
  end if;
  if to_regclass('public.menu_item_stock_facts') is null
     or (select count(*) from public.stock_native_backup b where left(b.name, 3) = 'd2:') <> 15 then
    raise exception 'Run 20261025a_OPS_stock_native_2.sql first. Nothing was changed.';
  end if;
  if to_regclass('public.stock_po_approvals') is not null or to_regclass('public.stock_notify_sent') is not null then
    raise exception 'Drop 3 has run already. Nothing was changed.';
  end if;
  if to_regprocedure('vault.create_secret(text,text,text,uuid)') is null
     or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null
     or to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regprocedure('cron.unschedule(bigint)') is null then
    raise exception 'The vault, pg_net or pg_cron is missing here. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '300s';

-- ============================================================================
-- STEP 0. THE BODIES THIS FILE REBUILDS OR LEANS ON, STILL AS BUILT
-- ============================================================================
-- The house rule: md5 of the function source with every run of white space made one space, read live
-- 22 Oct 2026. The first 10 are rebuilt below from that text (the 20261021a, 20261024a and 20261025a
-- files), changing only what contract section 1.5 lists; the other 23 are checked only.
do $bodies$
declare
  v_bad text;
begin
  select string_agg(e.sig, ', ' order by e.sig) into v_bad
    from (values
      ('public.stock_post_invoice(uuid,jsonb,jsonb,jsonb,uuid)', '13a87312ccaecb25f0e5184f070565ed'),
      ('public.stock_receive(uuid,text,text,jsonb,uuid,text)', '25cf780578d16f9c42e2e4cb3509911e'),
      ('public.stock_record_waste(uuid,jsonb,jsonb)', '7adec1618754c96e9f3d9655fcf98070'),
      ('public.stock_approve_count_pin(uuid,text,text,text,jsonb,boolean)', 'ffccd1e09fcfac62cff36e8d463f6519'),
      ('public.post_stock_transfer_leg(uuid,text,text)', 'd95f253953c5f22d537ee5e4b6925d49'),
      ('public.stock_needs_attention(uuid,uuid[])', '3c37e882291e5ba76048fa31304046b7'),
      ('public.stock_save_recipe(jsonb,jsonb,integer,text)', '8b625c94827917726945d7d4b1dffd8a'),
      ('public.stock_co__recipe_on_at(uuid,uuid,text,text,text)', '00d9e6a85b03889c53dd96d716b33a37'),
      ('public.stock_recipe_detail(uuid)', 'd7e0003ba1ae8dbc3b76e08ad13a8da2'),
      ('public.stock_recipe_card(uuid,text,uuid)', '275faa45aff17d97f12de8e7934252bf'),
      ('public.approve_stock_count(uuid,text,text,jsonb,boolean)', 'bad3f938c1f00e7dd1c08ade70cc3b45'),
      ('public._stock_receive_lines(uuid,text,text,jsonb,uuid,text)', '3bb42e8fac4e6259f537bc6a6159177a'),
      ('public.stock_co__guard(uuid,text,text,uuid[])', '03e4984a451353649de11b73acdd4e11'),
      ('public.stock_co__need_of(text,uuid,uuid)', 'a7cb781c5c5931f347d05252a6327ff1'),
      ('public.stock_co__venue_day(uuid,timestamp with time zone)', '8c9513db8ec56ddb68a1a3f247360742'),
      ('public.stock_co__today(uuid)', 'ebf8561b02839372d44f0b42def127e2'),
      ('public.stock_co__writer_ok()', 'ea27df98f795de86f094926b26478571'),
      ('public.stock_co__log(uuid,uuid,text,uuid,text,jsonb,jsonb,text)', 'a519f9295ec00c61f08ac0bcadf62e9f'),
      ('public.stock_co__cost_step(uuid,uuid[],bigint,boolean)', '12bc4e385fdb5562506977d1e05fce7e'),
      ('public.stock_save_supplier_item_site(uuid,uuid,jsonb,integer,text)', 'dfb1ae8795f9105f1d9761d4846c6ded'),
      ('public.stock_set_recipe_sites(uuid,jsonb,integer,text)', '591676006ee56b85eb6b88149f48263b'),
      ('public.stock_recipes_page(uuid,uuid[],text,jsonb,jsonb,integer)', 'f81f934a29ce14571f254df888bb9f90'),
      ('public.stock_explode_lines(uuid,jsonb,text,text)', '0c60388fa92f2b14ae4c16c4f1ecf357'),
      ('public.stock_opening_costs(uuid)', 'e6c02dc96759f6d61511efdf36f8bc04'),
      ('public.stock_site_scope(uuid)', 'e0b54f5aaea4f330e2300248b721141d'),
      ('public.stock_save_settings(uuid,jsonb,integer)', 'd4a8cf7151e8558d5c16ac31dbd5a8ec'),
      ('public.stock_co__apply_dated_prices(integer)', 'eddb686e82a5314f6fe10de34cff92ab'),
      ('public.stock_level(uuid,uuid)', '4287c82be293ef0b2724ee206d71eecc'),
      ('public.stock_reach_locations()', '6805857cee1a521eebe68a9dc3d8fa3e'),
      ('public.stock_office_reaches(uuid)', 'd5585672014220e100b95533e471dd89'),
      ('public.stock_caller_reaches(uuid)', '681741af80b7152ff692bf3689fd1cc3'),
      ('public.second_step_ok()', '5027ed5a5c5ca0b6f03a1d414998dfeb'),
      ('public.stock_nightly_upkeep()', 'a5a6840362abc7d648281f0e47a89da5')
    ) as e(sig, want)
    left join pg_proc p on p.oid = to_regprocedure(e.sig)
   where p.oid is null
      or md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) is distinct from e.want;
  if v_bad is not null then
    raise exception 'A stock function changed since this file was written. Ask Claude for a new file. Changed: %. Nothing was changed.', v_bad;
  end if;
end
$bodies$;

-- The 10 bodies this file rebuilds, as they are tonight (pg_get_functiondef text, replayable), in the
-- owner only stock_native_backup, named 'd3:<name>'. The Drop 3 rollback replays exactly these.
insert into public.stock_native_backup (name, body, md5, saved_at)
select 'd3:' || p.proname, pg_get_functiondef(p.oid), md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))), now()
  from (values
    ('public.stock_post_invoice(uuid,jsonb,jsonb,jsonb,uuid)'),
    ('public.stock_receive(uuid,text,text,jsonb,uuid,text)'),
    ('public.stock_record_waste(uuid,jsonb,jsonb)'),
    ('public.stock_approve_count_pin(uuid,text,text,text,jsonb,boolean)'),
    ('public.post_stock_transfer_leg(uuid,text,text)'),
    ('public.stock_needs_attention(uuid,uuid[])'),
    ('public.stock_save_recipe(jsonb,jsonb,integer,text)'),
    ('public.stock_co__recipe_on_at(uuid,uuid,text,text,text)'),
    ('public.stock_recipe_detail(uuid)'),
    ('public.stock_recipe_card(uuid,text,uuid)')
  ) as e(sig)
  join pg_proc p on p.oid = to_regprocedure(e.sig);

do $backup_check$
begin
  if (select count(*) from public.stock_native_backup b where left(b.name, 3) = 'd3:') <> 10 then
    raise exception 'The 10 bodies were not all saved. Nothing was changed. Send this line to Claude.';
  end if;
end
$backup_check$;

-- ============================================================================
-- STEP 1. THE SNAPSHOT (no site row, login, menu row, order, transfer, count, waste or forecast row
-- may change)
-- ============================================================================
create temp table _stock_native3_snap (
  location_id  uuid not null,
  metric       text not null,
  value        numeric,
  txt          text,
  primary key (location_id, metric)
) on commit drop;

create temp table _stock_native3_now (
  location_id  uuid not null,
  metric       text not null,
  value        numeric,
  txt          text,
  primary key (location_id, metric)
) on commit drop;

do $snap$
declare
  v_orgs uuid[];
begin
  select coalesce(array_agg(distinct i.org_id), '{}'::uuid[]) into v_orgs from public.stock_co_items i;
  perform 1
     from public.inventory_items i
    where i.location_id in (select l.id from public.locations l where l.org_id = any (v_orgs))
    order by i.id
      for no key update;
  insert into _stock_native3_snap (location_id, metric, value)
  select l.id, m.metric, coalesce(m.value, 0)
    from public.locations l
   cross join lateral (values
     ('n:inventory_items',               (select count(*) from public.inventory_items x where x.location_id = l.id)::numeric),
     ('rv:inventory_items',              (select sum(x.row_version) from public.inventory_items x where x.location_id = l.id)::numeric),
     ('n:suppliers',                     (select count(*) from public.suppliers x where x.location_id = l.id)::numeric),
     ('rv:suppliers',                    (select sum(x.row_version) from public.suppliers x where x.location_id = l.id)::numeric),
     ('n:supplier_products',             (select count(*) from public.supplier_products x where x.location_id = l.id)::numeric),
     ('rv:supplier_products',            (select sum(x.row_version) from public.supplier_products x where x.location_id = l.id)::numeric),
     ('n:item_packaging_formats',        (select count(*) from public.item_packaging_formats x where x.location_id = l.id)::numeric),
     ('rv:item_packaging_formats',       (select sum(x.row_version) from public.item_packaging_formats x where x.location_id = l.id)::numeric),
     ('n:inventory_item_conversions',    (select count(*) from public.inventory_item_conversions x where x.location_id = l.id)::numeric),
     ('rv:inventory_item_conversions',   (select sum(x.row_version) from public.inventory_item_conversions x where x.location_id = l.id)::numeric),
     ('n:recipes',                       (select count(*) from public.recipes x where x.location_id = l.id)::numeric),
     ('rv:recipes',                      (select sum(x.row_version) from public.recipes x where x.location_id = l.id)::numeric),
     ('n:recipe_lines',                  (select count(*) from public.recipe_lines x where x.location_id = l.id)::numeric),
     ('n:menu_item_recipes',             (select count(*) from public.menu_item_recipes x where x.location_id = l.id)::numeric),
     ('n:par_levels',                    (select count(*) from public.par_levels x where x.location_id = l.id)::numeric),
     ('n:inventory_item_areas',          (select count(*) from public.inventory_item_areas x where x.location_id = l.id)::numeric),
     ('n:stock_movements',               (select count(*) from public.stock_movements x where x.location_id = l.id)::numeric),
     ('s:on_hand',                       (select sum(x.on_hand) from public.inventory_items x where x.location_id = l.id)),
     ('s:current_cost',                  (select sum(x.current_cost) from public.inventory_items x where x.location_id = l.id)),
     ('s:books',                         (select sum(x.on_hand * x.current_cost) from public.inventory_items x where x.location_id = l.id)),
     ('s:mv_qty',                        (select sum(x.qty_base) from public.stock_movements x where x.location_id = l.id)),
     ('s:mv_value',                      (select sum(x.value_delta) from public.stock_movements x where x.location_id = l.id)),
     ('s:area_on_hand',                  (select sum(x.on_hand) from public.inventory_item_area_stock x where x.location_id = l.id)),
     ('n:purchase_orders',               (select count(*) from public.purchase_orders x where x.location_id = l.id)::numeric),
     ('n:po_lines',                      (select count(*) from public.po_lines x where x.location_id = l.id)::numeric),
     ('n:supplier_invoices',             (select count(*) from public.supplier_invoices x where x.location_id = l.id)::numeric),
     ('n:stock_transfers',               (select count(*) from public.stock_transfers x where x.location_id = l.id)::numeric),
     ('n:stock_transfer_lines',          (select count(*) from public.stock_transfer_lines x where x.location_id = l.id)::numeric),
     ('n:stock_counts',                  (select count(*) from public.stock_counts x where x.location_id = l.id)::numeric),
     ('n:waste_events',                  (select count(*) from public.waste_events x where x.location_id = l.id)::numeric),
     ('n:wf_sales_forecast',             (select count(*) from public.wf_sales_forecast x where x.location_id = l.id)::numeric),
     ('s:stock_movements_qty',           (select sum(x.qty_base) from public.stock_movements x where x.location_id = l.id)),
     ('s:inventory_items_on_hand',       (select sum(x.on_hand) from public.inventory_items x where x.location_id = l.id)),
     ('s:inventory_items_current_cost',  (select sum(x.current_cost) from public.inventory_items x where x.location_id = l.id))
   ) as m(metric, value)
   where l.org_id = any (v_orgs);
  insert into _stock_native3_snap (location_id, metric, value, txt)
  values ('00000000-0000-0000-0000-000000000000', 'md5:user_profiles', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.user_profiles t)),
         ('00000000-0000-0000-0000-000000000000', 'md5:user_locations', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.user_locations t)),
         ('00000000-0000-0000-0000-000000000000', 'md5:menu_items', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.menu_items t));
end
$snap$;

-- ============================================================================
-- STEP 2. TABLES AND COLUMNS (contract 1.2)
-- ============================================================================
-- Every new table: row level security on, revoked from every API role, only the grants listed, a read
-- rule where listed, the second sign in step fence, and no write policy (only definer functions write).

-- Approvals (map 4.9): one row per order over the site's approval limit for that supplier.
create table public.stock_po_approvals (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  location_id      uuid not null references public.locations(id) on delete cascade,
  po_id            uuid not null unique references public.purchase_orders(id) on delete cascade,
  supplier_id      uuid,
  amount           numeric(12,2) not null,
  limit_amount     numeric(12,2) not null,
  raised_by        uuid,
  raised_by_name   text,
  raised_by_staff_id uuid,
  status           text not null default 'waiting'
                   check (status in ('waiting', 'approved', 'sent_back', 'sent_anyway', 'sent_unapproved', 'missed', 'cancelled')),
  step             smallint not null default 0 check (step between 0 and 2),
  delivery_day     date,
  order_by_at      timestamptz,
  decided_by       uuid,
  decided_by_name  text,
  decided_at       timestamptz,
  note             text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index stock_po_approvals_due on public.stock_po_approvals (order_by_at) where status = 'waiting';
create index stock_po_approvals_loc on public.stock_po_approvals (location_id, status);
comment on table public.stock_po_approvals is 'Order approvals (20261027a). Written only by stock definer functions.';

-- The order by runner's send list (po-cutoff-run reads it with the service role).
create table public.stock_po_send_jobs (
  id           bigint generated always as identity primary key,
  po_id        uuid not null unique references public.purchase_orders(id) on delete cascade,
  location_id  uuid not null,
  why          text not null check (why in ('standing', 'sent_unapproved', 'sent_anyway', 'approved')),
  status       text not null default 'waiting' check (status in ('waiting', 'sent', 'failed', 'held')),
  not_before   timestamptz not null default now(),
  attempts     integer not null default 0,
  last_error   text,
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);
create index stock_po_send_jobs_waiting on public.stock_po_send_jobs (created_at) where status = 'waiting';
comment on table public.stock_po_send_jobs is 'Orders the po-cutoff-run edge function emails (20261027a).';

-- Standing orders (C16, F5).
create table public.stock_standing_orders (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null,
  location_id          uuid not null references public.locations(id) on delete cascade,
  supplier_id          uuid not null references public.suppliers(id) on delete cascade,
  company_supplier_id  uuid references public.stock_co_suppliers(id) on delete set null,
  name                 text,
  delivery_dows        smallint[] not null,
  active               boolean not null default true,
  paused_until         date,
  note                 text,
  row_version          integer not null default 1,
  created_by           uuid,
  created_by_name      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index stock_standing_orders_loc on public.stock_standing_orders (location_id, supplier_id);

create table public.stock_standing_order_lines (
  id                   uuid primary key default gen_random_uuid(),
  standing_order_id    uuid not null references public.stock_standing_orders(id) on delete cascade,
  location_id          uuid not null,
  inventory_item_id    uuid not null references public.inventory_items(id) on delete cascade,
  supplier_product_id  uuid references public.supplier_products(id) on delete set null,
  qty_packs            numeric not null check (qty_packs > 0),
  sort_order           integer not null default 0
);
create index stock_standing_order_lines_so on public.stock_standing_order_lines (standing_order_id);

create table public.stock_standing_runs (
  id                 uuid primary key default gen_random_uuid(),
  standing_order_id  uuid not null references public.stock_standing_orders(id) on delete cascade,
  location_id        uuid not null,
  delivery_day       date not null,
  order_by_at        timestamptz,
  status             text not null default 'waiting' check (status in ('waiting', 'sent', 'held', 'skipped', 'failed')),
  skip_reason        text,
  lines              jsonb,
  edited_by          uuid,
  edited_by_name     text,
  edited_at          timestamptz,
  po_id              uuid references public.purchase_orders(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (standing_order_id, delivery_day)
);
create index stock_standing_runs_loc on public.stock_standing_runs (location_id, delivery_day);

-- Days with no delivery, or a delivery on another day (C17).
create table public.stock_delivery_exceptions (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null,
  scope                text not null check (scope in ('company', 'supplier', 'site')),
  company_supplier_id  uuid references public.stock_co_suppliers(id) on delete cascade,
  location_id          uuid references public.locations(id) on delete cascade,
  name                 text not null,
  from_day             date not null,
  to_day               date not null,
  kind                 text not null check (kind in ('no_delivery', 'deliver_instead')),
  deliver_on           date,
  archived_at          timestamptz,
  row_version          integer not null default 1,
  created_by           uuid,
  created_by_name      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (to_day >= from_day),
  check ((kind = 'deliver_instead') = (deliver_on is not null)),
  constraint stock_delivery_exceptions_scope check (
    (scope = 'company' and company_supplier_id is null and location_id is null)
    or (scope = 'supplier' and company_supplier_id is not null)
    or (scope = 'site' and location_id is not null))
);
create index stock_delivery_exceptions_org on public.stock_delivery_exceptions (org_id, from_day);

-- Saved order lists (G5).
create table public.stock_order_lists (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  location_id      uuid not null references public.locations(id) on delete cascade,
  name             text not null,
  supplier_id      uuid,
  lines            jsonb not null default '[]'::jsonb,
  archived_at      timestamptz,
  row_version      integer not null default 1,
  created_by       uuid,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index stock_order_lists_loc on public.stock_order_lists (location_id);

-- Budgets (G15): the company default (no location) and site overrides.
create table public.stock_budgets (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null,
  location_id  uuid references public.locations(id) on delete cascade,
  rule         text not null check (rule in ('pct_of_forecast', 'fixed')),
  pct          numeric(5,2) check (pct is null or (pct > 0 and pct <= 100)),
  amount       numeric(12,2) check (amount is null or amount >= 0),
  row_version  integer not null default 1,
  updated_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (((rule = 'pct_of_forecast') = (pct is not null)) and ((rule = 'fixed') = (amount is not null)))
);
create unique index stock_budgets_one on public.stock_budgets (org_id, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- The company invoice inbox (H15).
create table public.stock_invoice_inbox (
  id                   uuid primary key default gen_random_uuid(),
  org_id               uuid not null,
  location_id          uuid references public.locations(id) on delete set null,
  source               text not null check (source in ('email', 'upload')),
  from_email           text,
  subject              text,
  file_path            text not null,
  file_name            text,
  mime                 text,
  scan                 jsonb,
  account_number       text,
  delivery_address     text,
  company_supplier_id  uuid,
  status               text not null default 'waiting' check (status in ('waiting', 'placed', 'posted', 'ignored')),
  placed_by            uuid,
  placed_by_name       text,
  placed_at            timestamptz,
  placed_how           text check (placed_how is null or placed_how in ('account_number', 'address', 'by_hand')),
  invoice_id           uuid references public.supplier_invoices(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index stock_invoice_inbox_org on public.stock_invoice_inbox (org_id, status, created_at desc);

-- One invoice for many sites (H14): paperwork only, never stock or cost.
create table public.supplier_invoice_site_splits (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  invoice_id       uuid not null references public.supplier_invoices(id) on delete cascade,
  location_id      uuid not null references public.locations(id) on delete cascade,
  amount           numeric(12,2) not null,
  tax              numeric(12,2) not null default 0,
  basis            text not null check (basis in ('by_hand', 'by_delivery')),
  po_id            uuid references public.purchase_orders(id) on delete set null,
  note             text,
  created_by       uuid,
  created_by_name  text,
  created_at       timestamptz not null default now()
);
create index supplier_invoice_site_splits_inv on public.supplier_invoice_site_splits (invoice_id);

-- Credits (H8).
create table public.stock_credit_requests (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  location_id      uuid not null references public.locations(id) on delete cascade,
  supplier_id      uuid references public.suppliers(id) on delete set null,
  invoice_id       uuid references public.supplier_invoices(id) on delete set null,
  po_id            uuid references public.purchase_orders(id) on delete set null,
  reason           text not null check (reason in ('overcharge', 'short', 'not_coming', 'damaged', 'other')),
  status           text not null default 'asked' check (status in ('asked', 'received', 'written_off')),
  amount           numeric(12,2) not null default 0,
  emailed_at       timestamptz,
  note             text,
  row_version      integer not null default 1,
  created_by       uuid,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index stock_credit_requests_loc on public.stock_credit_requests (location_id, status);

create table public.stock_credit_request_lines (
  id                  uuid primary key default gen_random_uuid(),
  request_id          uuid not null references public.stock_credit_requests(id) on delete cascade,
  location_id         uuid not null,
  inventory_item_id   uuid,
  description         text not null,
  qty                 numeric not null,
  unit_price_charged  numeric(12,4),
  unit_price_agreed   numeric(12,4),
  amount              numeric(12,2) not null,
  sort_order          integer not null default 0
);
create index stock_credit_request_lines_req on public.stock_credit_request_lines (request_id);

create table public.stock_credit_notes (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  location_id      uuid not null references public.locations(id) on delete cascade,
  supplier_id      uuid references public.suppliers(id) on delete set null,
  request_id       uuid references public.stock_credit_requests(id) on delete set null,
  number           text,
  note_date        date not null,
  amount           numeric(12,2) not null check (amount >= 0),
  tax              numeric(12,2) not null default 0,
  image_path       text,
  created_by       uuid,
  created_by_name  text,
  created_at       timestamptz not null default now()
);
create index stock_credit_notes_loc on public.stock_credit_notes (location_id, created_at);

-- Count templates and plans (I2, I3, I6).
create table public.stock_count_templates (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  name             text not null,
  archived_at      timestamptz,
  row_version      integer not null default 1,
  created_by       uuid,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create unique index stock_count_templates_name on public.stock_count_templates (org_id, lower(name)) where archived_at is null;

create table public.stock_count_template_lines (
  template_id  uuid not null references public.stock_count_templates(id) on delete cascade,
  org_id       uuid not null,
  item_id      uuid not null references public.stock_co_items(id) on delete cascade,
  sort_order   integer not null default 0,
  primary key (template_id, item_id)
);

create table public.stock_count_template_sites (
  template_id  uuid not null references public.stock_count_templates(id) on delete cascade,
  org_id       uuid not null,
  location_id  uuid references public.locations(id) on delete cascade,
  group_id     uuid references public.stock_co_site_groups(id) on delete cascade,
  check ((location_id is null) <> (group_id is null))
);
create unique index stock_count_template_sites_one on public.stock_count_template_sites (template_id, coalesce(location_id, group_id));

create table public.stock_template_shelf_order (
  template_id  uuid not null references public.stock_count_templates(id) on delete cascade,
  location_id  uuid not null references public.locations(id) on delete cascade,
  org_id       uuid not null,
  item_id      uuid not null references public.stock_co_items(id) on delete cascade,
  sort_order   integer not null,
  updated_by   uuid,
  updated_at   timestamptz not null default now(),
  primary key (template_id, location_id, item_id)
);

create table public.stock_count_plans (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  name             text not null,
  count_type       text not null check (count_type in ('FULL', 'PARTIAL', 'SPOT', 'AREA', 'SUPPLIER')),
  template_id      uuid references public.stock_count_templates(id) on delete set null,
  every            text not null check (every in ('day', 'week', 'month')),
  dows             smallint[],
  day_of_month     smallint check (day_of_month is null or day_of_month between 1 and 28),
  due_by           time not null default '10:00',
  sites            uuid[],
  group_ids        uuid[],
  if_not_counted   text not null default 'estimate' check (if_not_counted in ('estimate', 'zero')),
  active           boolean not null default true,
  archived_at      timestamptz,
  row_version      integer not null default 1,
  created_by       uuid,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index stock_count_plans_org on public.stock_count_plans (org_id) where archived_at is null;

-- Saved transfer lists (K4).
create table public.stock_transfer_lists (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null,
  location_id      uuid not null references public.locations(id) on delete cascade,
  to_location_id   uuid references public.locations(id) on delete set null,
  name             text not null,
  lines            jsonb not null default '[]'::jsonb,
  archived_at      timestamptz,
  row_version      integer not null default 1,
  created_by       uuid,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index stock_transfer_lists_loc on public.stock_transfer_lists (location_id);

-- Forecast by hour (G12) and the borrowed history of a new site.
create table public.stock_forecast_hours (
  location_id     uuid not null references public.locations(id) on delete cascade,
  org_id          uuid not null,
  business_day    date not null,
  hour            smallint not null check (hour between 0 and 23),
  amount          numeric(12,2) not null check (amount >= 0),
  reason          text,
  edited_by       uuid,
  edited_by_name  text,
  edited_at       timestamptz not null default now(),
  primary key (location_id, business_day, hour)
);

create table public.stock_co_site_forecast_source (
  location_id              uuid primary key references public.locations(id) on delete cascade,
  org_id                   uuid not null,
  borrow_from_location_id  uuid not null references public.locations(id) on delete cascade,
  scale                    numeric(6,3) not null default 1 check (scale > 0 and scale <= 10),
  row_version              integer not null default 1,
  updated_by               uuid,
  updated_at               timestamptz not null default now()
);

-- Kitchen only recipes (F11): method and cost note, readable by the kitchen and company editors only.
create table public.stock_co_recipe_secrets (
  recipe_id            uuid primary key references public.stock_co_recipes(id) on delete cascade,
  org_id               uuid not null,
  kitchen_location_id  uuid not null references public.locations(id),
  method               text,
  cost_note            text,
  row_version          integer not null default 1,
  updated_by           uuid,
  updated_by_name      text,
  updated_at           timestamptz not null default now()
);

-- Production plan Done ticks with who (map 4.7).
create table public.stock_kitchen_plan_ticks (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null,
  location_id   uuid not null references public.locations(id) on delete cascade,
  business_day  date not null,
  recipe_id     uuid not null references public.stock_co_recipes(id) on delete cascade,
  qty           numeric not null check (qty > 0),
  done_by       uuid,
  done_by_name  text,
  done_at       timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index stock_kitchen_plan_ticks_day on public.stock_kitchen_plan_ticks (location_id, business_day, recipe_id);

-- What xero-sales and xero-bills posted for a month of recharges (F13).
create table public.stock_recharge_posts (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null,
  month             date not null,
  from_location_id  uuid not null,
  to_location_id    uuid not null,
  amount            numeric(12,2) not null,
  xero_invoice_id   text,
  xero_bill_id      text,
  posted_at         timestamptz,
  posted_by_name    text,
  last_error        text,
  created_at        timestamptz not null default now(),
  unique (org_id, month, from_location_id, to_location_id)
);

-- The alert ledger (map 4.23): nothing is sent twice.
create table public.stock_notify_sent (
  id            bigint generated always as identity primary key,
  org_id        uuid not null,
  location_id   uuid,
  kind          text not null check (kind in ('order_by', 'approval_wait', 'approval_60', 'approval_30', 'sent_unapproved',
                                             'price_rise', 'invoice_unplaced', 'count_due', 'count_missed',
                                             'count_second_approval', 'transfer_waiting', 'delivery_overdue')),
  ref           text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        text not null default 'waiting' check (status in ('waiting', 'sent', 'failed', 'skipped')),
  attempts      integer not null default 0,
  last_error    text,
  bell_event_id uuid,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);
create unique index stock_notify_sent_once on public.stock_notify_sent (kind, ref, coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index stock_notify_sent_waiting on public.stock_notify_sent (created_at) where status = 'waiting';

-- Columns on live tables (constant defaults only, each only when missing).
alter table public.wf_sales_forecast add column if not exists reason text
  check (reason is null or reason in ('weather', 'local_event', 'booking', 'promotion', 'closure', 'other'));
alter table public.wf_sales_forecast add column if not exists reason_note text;
alter table public.wf_sales_forecast add column if not exists edited_by uuid;
alter table public.wf_sales_forecast add column if not exists edited_by_name text;
alter table public.wf_sales_forecast add column if not exists edited_at timestamptz;
alter table public.purchase_orders add column if not exists delivery_fee numeric(12,2);
alter table public.purchase_orders add column if not exists standing_order_id uuid references public.stock_standing_orders(id) on delete set null;
alter table public.purchase_orders add column if not exists sent_unapproved_at timestamptz;
alter table public.po_lines add column if not exists qty_draft numeric;
alter table public.po_lines add column if not exists ordered_unit_price numeric;
alter table public.supplier_invoices add column if not exists match_status text
  check (match_status is null or match_status in ('matched', 'price_issue', 'qty_issue', 'both', 'by_hand'));
alter table public.supplier_invoices add column if not exists match_detail jsonb;
alter table public.supplier_invoices add column if not exists approved_at timestamptz;
alter table public.supplier_invoices add column if not exists approved_by_name text;
alter table public.supplier_invoices add column if not exists locked_at timestamptz;
alter table public.supplier_invoices add column if not exists inbox_id uuid references public.stock_invoice_inbox(id) on delete set null;
alter table public.stock_counts add column if not exists plan_id uuid references public.stock_count_plans(id) on delete set null;
alter table public.stock_counts add column if not exists template_id uuid references public.stock_count_templates(id) on delete set null;
alter table public.stock_counts add column if not exists second_approval_needed_at timestamptz;
alter table public.stock_counts add column if not exists first_approved_by uuid;
alter table public.stock_counts add column if not exists first_approved_by_name text;
alter table public.stock_counts add column if not exists first_approved_by_staff_id uuid;
alter table public.stock_counts add column if not exists second_approved_by uuid;
alter table public.stock_counts add column if not exists second_approved_by_name text;
alter table public.stock_counts add column if not exists second_approved_at timestamptz;
alter table public.waste_events add column if not exists approved_by_staff_id uuid;
alter table public.waste_events add column if not exists approved_by_staff_name text;
alter table public.stock_transfers add column if not exists kind text not null default 'transfer'
  check (kind in ('transfer', 'request', 'central_kitchen'));
alter table public.stock_transfers add column if not exists reason text;
alter table public.stock_transfers add column if not exists requested_by_name text;
alter table public.stock_transfers add column if not exists requested_at timestamptz;
alter table public.stock_transfers add column if not exists disputed_at timestamptz;
alter table public.stock_transfers add column if not exists dispute_note text;
alter table public.stock_transfers add column if not exists resolved_at timestamptz;
alter table public.stock_transfers add column if not exists resolved_by_name text;
alter table public.stock_transfers add column if not exists purchase_order_id uuid references public.purchase_orders(id) on delete set null;
alter table public.stock_transfer_lines add column if not exists lot_code text;
alter table public.stock_transfer_lines add column if not exists use_by_at timestamptz;
alter table public.stock_transfer_lines add column if not exists requested_qty_base numeric;
alter table public.stock_co_suppliers add column if not exists fee_waived_over_min boolean not null default false;
alter table public.stock_co_settings add column if not exists inbox_token text;
create unique index if not exists stock_transfers_one_per_order on public.stock_transfers (purchase_order_id) where purchase_order_id is not null;
create unique index if not exists stock_co_settings_inbox_token on public.stock_co_settings (inbox_token) where inbox_token is not null;
create index if not exists purchase_orders_standing on public.purchase_orders (standing_order_id) where standing_order_id is not null;

comment on column public.wf_sales_forecast.reason is 'Why a manager changed the forecast (20261027a). Written by stock_save_forecast; the rota shows it.';
comment on column public.wf_sales_forecast.reason_note is 'The words with the reason (20261027a).';
comment on column public.wf_sales_forecast.edited_by is 'Who changed the forecast (20261027a).';
comment on column public.wf_sales_forecast.edited_by_name is 'Who changed the forecast, the name (20261027a).';
comment on column public.wf_sales_forecast.edited_at is 'When the forecast was changed (20261027a).';
comment on column public.purchase_orders.delivery_fee is 'The site''s delivery fee for this order, not in subtotal; null = none (20261027a).';
comment on column public.purchase_orders.standing_order_id is 'The standing order the runner made this order from (20261027a).';
comment on column public.purchase_orders.sent_unapproved_at is 'Sent at the order by time with no approval answer (20261027a).';
comment on column public.po_lines.qty_draft is 'Part saved on Deliveries; no stock moves until Finish (20261027a).';
comment on column public.po_lines.ordered_unit_price is 'The price when ordered (20261027a).';
comment on column public.supplier_invoices.match_status is 'The 3 way match (20261027a).';
comment on column public.supplier_invoices.match_detail is 'Per line ordered, received, invoiced (20261027a).';
comment on column public.supplier_invoices.approved_at is 'When the invoice was approved (20261027a).';
comment on column public.supplier_invoices.approved_by_name is 'Who approved the invoice (20261027a).';
comment on column public.supplier_invoices.locked_at is 'Set by xero-bills after a send; a locked invoice refuses edits (20261027a).';
comment on column public.supplier_invoices.inbox_id is 'The inbox file this invoice came from (20261027a).';
comment on column public.stock_counts.plan_id is 'The count plan this count is for (20261027a).';
comment on column public.stock_counts.template_id is 'The count template this count used (20261027a).';
comment on column public.stock_counts.second_approval_needed_at is 'Over the limit: waiting for a second approval (20261027a).';
comment on column public.stock_counts.first_approved_by is 'The login of the first approval (20261027a).';
comment on column public.stock_counts.first_approved_by_name is 'The PIN holder of the first approval (20261027a).';
comment on column public.stock_counts.first_approved_by_staff_id is 'The staff member of the first approval (20261027a).';
comment on column public.stock_counts.second_approved_by is 'The login of the second approval (20261027a).';
comment on column public.stock_counts.second_approved_by_name is 'Who gave the second approval (20261027a).';
comment on column public.stock_counts.second_approved_at is 'When the second approval was given (20261027a).';
comment on column public.waste_events.approved_by_staff_id is 'The PIN holder for waste over the limit (20261027a).';
comment on column public.waste_events.approved_by_staff_name is 'The PIN holder for waste over the limit, the name (20261027a).';
comment on column public.stock_transfers.kind is 'transfer, request or central_kitchen (20261027a).';
comment on column public.stock_transfers.reason is 'Why the stock moved (20261027a).';
comment on column public.stock_transfers.requested_by_name is 'Who asked for the stock (20261027a).';
comment on column public.stock_transfers.requested_at is 'When the stock was asked for (20261027a).';
comment on column public.stock_transfers.disputed_at is 'When the receiving site disputed it (20261027a).';
comment on column public.stock_transfers.dispute_note is 'What the receiving site said was wrong (20261027a).';
comment on column public.stock_transfers.resolved_at is 'When the sending site resolved the dispute (20261027a).';
comment on column public.stock_transfers.resolved_by_name is 'Who resolved the dispute (20261027a).';
comment on column public.stock_transfers.purchase_order_id is 'The kitchen order this transfer delivers; one transfer per order (20261027a).';
comment on column public.stock_transfer_lines.lot_code is 'The batch lot the kitchen picked (20261027a).';
comment on column public.stock_transfer_lines.use_by_at is 'The use by of the batch picked (20261027a).';
comment on column public.stock_transfer_lines.requested_qty_base is 'What a request asked for (20261027a).';
comment on column public.stock_co_suppliers.fee_waived_over_min is 'No delivery fee over the minimum (20261027a).';
comment on column public.stock_co_settings.inbox_token is 'The company invoice inbox address token (20261027a).';

-- The one change to a live CHECK: two new transfer statuses (live rows are DONE and pass).
alter table public.stock_transfers drop constraint stock_transfers_status_chk;
alter table public.stock_transfers add constraint stock_transfers_status_chk
  check (status in ('DRAFT', 'SENT', 'RECEIVED', 'CANCELLED', 'DONE', 'REQUESTED', 'DISPUTED'));

-- Row level security, grants, read rules, the fence.
alter table public.stock_po_approvals enable row level security;
alter table public.stock_po_send_jobs enable row level security;
alter table public.stock_standing_orders enable row level security;
alter table public.stock_standing_order_lines enable row level security;
alter table public.stock_standing_runs enable row level security;
alter table public.stock_delivery_exceptions enable row level security;
alter table public.stock_order_lists enable row level security;
alter table public.stock_budgets enable row level security;
alter table public.stock_invoice_inbox enable row level security;
alter table public.supplier_invoice_site_splits enable row level security;
alter table public.stock_credit_requests enable row level security;
alter table public.stock_credit_request_lines enable row level security;
alter table public.stock_credit_notes enable row level security;
alter table public.stock_count_plans enable row level security;
alter table public.stock_count_templates enable row level security;
alter table public.stock_count_template_lines enable row level security;
alter table public.stock_count_template_sites enable row level security;
alter table public.stock_template_shelf_order enable row level security;
alter table public.stock_transfer_lists enable row level security;
alter table public.stock_forecast_hours enable row level security;
alter table public.stock_co_site_forecast_source enable row level security;
alter table public.stock_co_recipe_secrets enable row level security;
alter table public.stock_kitchen_plan_ticks enable row level security;
alter table public.stock_recharge_posts enable row level security;
alter table public.stock_notify_sent enable row level security;
revoke all on table public.stock_po_approvals from public, anon, authenticated, service_role;
revoke all on table public.stock_po_send_jobs from public, anon, authenticated, service_role;
revoke all on table public.stock_standing_orders from public, anon, authenticated, service_role;
revoke all on table public.stock_standing_order_lines from public, anon, authenticated, service_role;
revoke all on table public.stock_standing_runs from public, anon, authenticated, service_role;
revoke all on table public.stock_delivery_exceptions from public, anon, authenticated, service_role;
revoke all on table public.stock_order_lists from public, anon, authenticated, service_role;
revoke all on table public.stock_budgets from public, anon, authenticated, service_role;
revoke all on table public.stock_invoice_inbox from public, anon, authenticated, service_role;
revoke all on table public.supplier_invoice_site_splits from public, anon, authenticated, service_role;
revoke all on table public.stock_credit_requests from public, anon, authenticated, service_role;
revoke all on table public.stock_credit_request_lines from public, anon, authenticated, service_role;
revoke all on table public.stock_credit_notes from public, anon, authenticated, service_role;
revoke all on table public.stock_count_plans from public, anon, authenticated, service_role;
revoke all on table public.stock_count_templates from public, anon, authenticated, service_role;
revoke all on table public.stock_count_template_lines from public, anon, authenticated, service_role;
revoke all on table public.stock_count_template_sites from public, anon, authenticated, service_role;
revoke all on table public.stock_template_shelf_order from public, anon, authenticated, service_role;
revoke all on table public.stock_transfer_lists from public, anon, authenticated, service_role;
revoke all on table public.stock_forecast_hours from public, anon, authenticated, service_role;
revoke all on table public.stock_co_site_forecast_source from public, anon, authenticated, service_role;
revoke all on table public.stock_co_recipe_secrets from public, anon, authenticated, service_role;
revoke all on table public.stock_kitchen_plan_ticks from public, anon, authenticated, service_role;
revoke all on table public.stock_recharge_posts from public, anon, authenticated, service_role;
revoke all on table public.stock_notify_sent from public, anon, authenticated, service_role;
grant select on table public.stock_po_approvals to authenticated, service_role;
grant select, update on table public.stock_po_send_jobs to service_role;
grant select on table public.stock_standing_orders to authenticated, service_role;
grant select on table public.stock_standing_order_lines to authenticated, service_role;
grant select on table public.stock_standing_runs to authenticated, service_role;
grant select on table public.stock_delivery_exceptions to authenticated, service_role;
grant select on table public.stock_order_lists to authenticated, service_role;
grant select on table public.stock_budgets to authenticated, service_role;
grant select on table public.stock_invoice_inbox to authenticated, service_role;
grant insert on table public.stock_invoice_inbox to service_role;
grant select on table public.supplier_invoice_site_splits to authenticated, service_role;
grant select on table public.stock_credit_requests to authenticated, service_role;
-- po-send's credit_request action stamps when the request was emailed (service role, these two columns only).
grant update (emailed_at, updated_at) on table public.stock_credit_requests to service_role;
grant select on table public.stock_credit_request_lines to authenticated, service_role;
grant select on table public.stock_credit_notes to authenticated, service_role;
grant select on table public.stock_count_plans to authenticated, service_role;
grant select on table public.stock_count_templates to authenticated, service_role;
grant select on table public.stock_count_template_lines to authenticated, service_role;
grant select on table public.stock_count_template_sites to authenticated, service_role;
grant select on table public.stock_template_shelf_order to authenticated, service_role;
grant select on table public.stock_transfer_lists to authenticated, service_role;
grant select on table public.stock_forecast_hours to authenticated, service_role;
grant select on table public.stock_co_site_forecast_source to authenticated, service_role;
grant select on table public.stock_co_recipe_secrets to authenticated, service_role;
grant select on table public.stock_kitchen_plan_ticks to authenticated, service_role;
grant select on table public.stock_recharge_posts to authenticated, service_role;
grant insert, update on table public.stock_recharge_posts to service_role;
grant select, insert, update on table public.stock_notify_sent to service_role;

create policy stock_po_approvals_read on public.stock_po_approvals as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_standing_orders_read on public.stock_standing_orders as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_standing_order_lines_read on public.stock_standing_order_lines as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_standing_runs_read on public.stock_standing_runs as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_delivery_exceptions_read on public.stock_delivery_exceptions as permissive for select to authenticated
  using ((location_id is null and org_id::text in (select public.stock_reach_orgs()))
         or (location_id is not null and location_id::text in (select public.stock_reach_locations())));
create policy stock_order_lists_read on public.stock_order_lists as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_budgets_read on public.stock_budgets as permissive for select to authenticated
  using ((location_id is null and org_id::text in (select public.stock_reach_orgs()))
         or (location_id is not null and location_id::text in (select public.stock_reach_locations())));
create policy stock_invoice_inbox_read on public.stock_invoice_inbox as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs())
         and (location_id is null or location_id::text in (select public.stock_reach_locations())));
create policy supplier_invoice_site_splits_read on public.supplier_invoice_site_splits as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations())
         or exists (select 1 from public.supplier_invoices i
                     where i.id = invoice_id and i.location_id::text in (select public.stock_reach_locations())));
create policy stock_credit_requests_read on public.stock_credit_requests as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_credit_request_lines_read on public.stock_credit_request_lines as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_credit_notes_read on public.stock_credit_notes as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_count_plans_read on public.stock_count_plans as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));
create policy stock_count_templates_read on public.stock_count_templates as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));
create policy stock_count_template_lines_read on public.stock_count_template_lines as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));
create policy stock_count_template_sites_read on public.stock_count_template_sites as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));
create policy stock_template_shelf_order_read on public.stock_template_shelf_order as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_transfer_lists_read on public.stock_transfer_lists as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_forecast_hours_read on public.stock_forecast_hours as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_co_site_forecast_source_read on public.stock_co_site_forecast_source as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_kitchen_plan_ticks_read on public.stock_kitchen_plan_ticks as permissive for select to authenticated
  using (location_id::text in (select public.stock_reach_locations()));
create policy stock_recharge_posts_read on public.stock_recharge_posts as permissive for select to authenticated
  using (org_id::text in (select public.stock_reach_orgs()));
-- stock_co_recipe_secrets_read is made after stock_co__secret_ok (step 3)
do $fence_d3$
declare
  t text;
begin
  if to_regprocedure('public.second_step_ok()') is not null then
    foreach t in array array['stock_po_approvals', 'stock_po_send_jobs', 'stock_standing_orders', 'stock_standing_order_lines',
                             'stock_standing_runs', 'stock_delivery_exceptions', 'stock_order_lists', 'stock_budgets',
                             'stock_invoice_inbox', 'supplier_invoice_site_splits', 'stock_credit_requests',
                             'stock_credit_request_lines', 'stock_credit_notes', 'stock_count_plans', 'stock_count_templates',
                             'stock_count_template_lines', 'stock_count_template_sites', 'stock_template_shelf_order',
                             'stock_transfer_lists', 'stock_forecast_hours', 'stock_co_site_forecast_source',
                             'stock_co_recipe_secrets', 'stock_kitchen_plan_ticks', 'stock_recharge_posts', 'stock_notify_sent']
    loop
      execute format('create policy second_step_fence on public.%I as restrictive for all to authenticated '
                     'using ((select public.second_step_ok())) with check ((select public.second_step_ok()))', t);
    end loop;
  end if;
end
$fence_d3$;

-- The inbox bucket (private, 10 MB) and its own policies on objects.name. Made only when missing; the
-- rollback keeps the bucket and its files (evidence) and drops the two policies.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('stock-invoice-inbox', 'stock-invoice-inbox', false, 10485760,
        array['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic'])
on conflict (id) do nothing;
create policy stock_invoice_inbox_files_read on storage.objects as permissive for select to authenticated
  using (bucket_id = 'stock-invoice-inbox' and (storage.foldername(name))[1] = 'org'
         and (storage.foldername(name))[2] in (select public.stock_reach_orgs()));
create policy stock_invoice_inbox_files_add on storage.objects as permissive for insert to authenticated
  with check (bucket_id = 'stock-invoice-inbox' and (storage.foldername(name))[1] = 'org'
              and (storage.foldername(name))[2] in (select public.stock_reach_orgs())
              and public.stock_level(auth.uid(), ((storage.foldername(name))[2])::uuid) = 'all');

-- ============================================================================
-- STEP 3. HELPERS AND TRIGGERS (owner only, the stock_co__ prefix; contract 1.4 and 1.6)
-- ============================================================================

-- The venue business day of a moment, as a plain date (stock_co__venue_day answers a row).
create or replace function public.stock_co__vday(p_loc uuid, p_at timestamptz)
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select v.business_day from public.stock_co__venue_day(p_loc, p_at) v;
$fn$;

-- The session is the service role (an edge function). Read from the request claims, never current_user
-- (inside a definer function current_user is the owner).
create or replace function public.stock_co__is_service()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role';
$fn$;

-- A company is multi site when it has 2 or more open sites or was marked multi (the guard's rule).
create or replace function public.stock_co__multi(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce((select count(*) filter (where coalesce(l.status, 'active') = 'active') from locations l where l.org_id = p_org), 0) >= 2
      or exists (select 1 from stock_co_settings s where s.org_id = p_org and s.multi_since is not null);
$fn$;

-- Money in the venue's currency, whole units when whole (ASCII only in this file: the pound and euro
-- signs are made with chr()).
create or replace function public.stock_co__money(p_currency text, p_amount numeric)
returns text
language sql
immutable
security definer
set search_path = public, pg_temp
as $fn$
  select case upper(coalesce(p_currency, 'GBP')) when 'GBP' then chr(163) when 'USD' then '$' when 'EUR' then chr(8364)
                                                 else upper(p_currency) || ' ' end
      || case when p_amount is null then '0'
              when p_amount = trunc(p_amount) then trunc(p_amount)::text
              else to_char(round(p_amount, 2), 'FM999999990.00') end;
$fn$;

-- The venue's time zone (venue_clock first, then the location).
create or replace function public.stock_co__tz(p_loc uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce((select v.timezone from venue_clock v where v.location_id = p_loc),
                  (select l.timezone from locations l where l.id = p_loc), 'Europe/London');
$fn$;

-- Who is asking, for a Drop 3 function that takes p_actor: the service role (the phone, which proved the
-- office reach and the PIN itself) names the person and one site; every other session goes through the
-- common guard. p_actor is ignored for any session but the service role.
create or replace function public.stock_co__d3_who(p_org uuid, p_section text, p_need text, p_sites uuid[], p_actor jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_loc uuid;
  v_s uuid;
begin
  if public.stock_co__is_service() then
    if p_actor is null or jsonb_typeof(p_actor) <> 'object'
       or coalesce(p_actor ->> 'location_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or p_sites is null or cardinality(p_sites) = 0 then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    v_loc := (p_actor ->> 'location_id')::uuid;
    foreach v_s in array p_sites loop
      if v_s is distinct from v_loc then
        raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
      end if;
    end loop;
    if not exists (select 1 from locations l where l.id = v_loc and l.org_id = p_org) then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    if p_need <> 'read' then
      perform set_config('servos.stock_co_write', txid_current()::text, true);
    end if;
    return jsonb_build_object('uid', nullif(p_actor ->> 'uid', ''), 'name', nullif(p_actor ->> 'name', ''),
                              'staff_id', nullif(p_actor ->> 'staff_id', ''), 'level', 'sites',
                              'multi', public.stock_co__multi(p_org), 'org_id', p_org, 'phone', true);
  end if;
  return public.stock_co__guard(p_org, p_section, p_need, p_sites);
end
$fn$;

-- The company guard of the new tables: org_id is the site's company (and of the other site named).
create or replace function public.stock_co__d3_org_guard()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_new jsonb := to_jsonb(new);
  v_org uuid;
  v_loc_org uuid;
  v_k text;
begin
  if tg_table_name = 'stock_standing_runs' then
    if not exists (select 1 from stock_standing_orders o where o.id = new.standing_order_id and o.location_id = new.location_id) then
      raise exception 'That site is not in this company.' using errcode = '22023';
    end if;
    return new;
  end if;
  v_org := (v_new ->> 'org_id')::uuid;
  foreach v_k in array array['location_id', 'to_location_id', 'borrow_from_location_id'] loop
    continue when nullif(v_new ->> v_k, '') is null;
    select l.org_id into v_loc_org from locations l where l.id = (v_new ->> v_k)::uuid;
    if v_loc_org is null or v_loc_org is distinct from v_org then
      raise exception 'That site is not in this company.' using errcode = '22023';
    end if;
  end loop;
  return new;
end
$fn$;

-- An order waiting for approval (or sent back) is never marked sent, except inside the pass that the
-- approval, the runner and the kitchen take (servos.stock_po_send = this transaction). INVOKER.
create or replace function public.stock_co__po_approval_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if new.status in ('SENT', 'PARTIAL', 'RECEIVED') and old.status = 'DRAFT'
     and coalesce(current_setting('servos.stock_po_send', true), '') is distinct from txid_current()::text
     and exists (select 1 from public.stock_po_approvals a where a.po_id = new.id and a.status in ('waiting', 'sent_back')) then
    raise exception 'This order is waiting for approval.' using errcode = '55000';
  end if;
  return new;
end
$fn$;

-- The delivery fee an order of these goods carries (the rule stock_co__po_submit_core applies): null when
-- none or waived over the minimum.
create or replace function public.stock_co__fee_for(p_sup uuid, p_goods numeric)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_sup suppliers;
  v_waive boolean;
begin
  select * into v_sup from suppliers s where s.id = p_sup;
  if v_sup.id is null or v_sup.delivery_fee is null or v_sup.delivery_fee = 0 then
    return null;
  end if;
  select coalesce(c.fee_waived_over_min, false) into v_waive from stock_co_suppliers c where c.id = v_sup.company_ref;
  if coalesce(v_waive, false) and v_sup.min_order_value is not null and p_goods >= v_sup.min_order_value then
    return null;
  end if;
  return v_sup.delivery_fee;
end
$fn$;

-- Why a DRAFT order may not be marked SENT now (null = it may). Multi site companies only, never the
-- central kitchen: an order over the site's approval limit for that supplier goes out only once it was
-- approved (or sent anyway, or sent unapproved at the order by time) for at least what it costs now; a
-- standing order the runner made was agreed when it was set up (its limit is checked when it is saved).
create or replace function public.stock_co__po_send_block(p_po uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_po purchase_orders;
  v_sup suppliers;
  v_internal uuid;
  v_a stock_po_approvals;
  v_amount numeric;
begin
  select * into v_po from purchase_orders p where p.id = p_po;
  if v_po.id is null or v_po.status <> 'DRAFT' then
    return null;
  end if;
  if not public.stock_co__multi((select l.org_id from locations l where l.id = v_po.location_id)) then
    return null;
  end if;
  select * into v_sup from suppliers s where s.id = v_po.supplier_id and s.location_id = v_po.location_id;
  select c.internal_location_id into v_internal from stock_co_suppliers c where c.id = v_sup.company_ref;
  if v_internal is not null then
    return null;
  end if;
  select coalesce(sum(round(coalesce(pl.qty_packs, 0) * coalesce(pl.unit_price, 0), 2)), 0) into v_amount from po_lines pl where pl.po_id = p_po;
  v_amount := v_amount + coalesce(public.stock_co__fee_for(v_sup.id, v_amount), 0);
  select * into v_a from stock_po_approvals a where a.po_id = p_po;
  if v_a.id is not null then
    if v_a.status in ('waiting', 'sent_back') then
      return 'This order is waiting for approval.';
    end if;
    if v_a.status in ('approved', 'sent_anyway', 'sent_unapproved') and v_amount <= v_a.amount then
      return null;
    end if;
    return 'This order needs approval. Submit it again.';
  end if;
  if exists (select 1 from stock_standing_runs r where r.po_id = p_po) then
    return null;
  end if;
  if v_sup.approval_limit is not null and v_amount > v_sup.approval_limit then
    return 'This order is over the approval limit. Submit it for approval first.';
  end if;
  return null;
end
$fn$;

-- DRAFT to SENT for a multi site company only as stock_co__po_send_block allows, unless inside the pass
-- the approval runner and the kitchen take. Every caller: po-send, the phone, a direct update. DEFINER
-- (it reads the approval and the supplier whatever the caller may read); it changes nothing.
create or replace function public.stock_co__po_send_rule()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_why text;
begin
  if new.status = 'SENT' and old.status = 'DRAFT'
     and coalesce(current_setting('servos.stock_po_send', true), '') is distinct from txid_current()::text then
    v_why := public.stock_co__po_send_block(new.id);
    if v_why is not null then
      raise exception '%', v_why using errcode = '55000';
    end if;
  end if;
  return new;
end
$fn$;

-- Is this login the person who raised the order: the login itself, or the login of the staff PIN that
-- raised it on the phone (staff_members.auth_user_id, else the rota row with the same email).
create or replace function public.stock_co__is_raiser(p_uid uuid, p_raised_by uuid, p_staff uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
begin
  if p_uid is null then
    return false;
  end if;
  if p_uid = p_raised_by then
    return true;
  end if;
  if p_staff is null then
    return false;
  end if;
  return exists (select 1 from staff_members s where s.id = p_staff and s.auth_user_id = p_uid::text)
      or exists (select 1 from wf_staff w join user_profiles p on lower(p.email) = lower(btrim(w.email))
                  where w.pos_user_id = p_staff and p.id = p_uid and nullif(btrim(w.email), '') is not null);
end
$fn$;

-- A count's plan, template and approval columns are written only by the count approval (the stock
-- definer functions, and the phone through the service role): a login cannot set or clear them through
-- the API (no skipping the second approval, no dropping a 'zero' plan). INVOKER: current_user is the API
-- role only when no stock function is running.
create or replace function public.stock_co__count_approval_fence()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
begin
  if current_user::text not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.second_approval_needed_at is not null or new.first_approved_by is not null or new.first_approved_by_name is not null
       or new.first_approved_by_staff_id is not null or new.second_approved_by is not null or new.second_approved_by_name is not null
       or new.second_approved_at is not null then
      raise exception 'Only the count approval records who approved a count.' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.plan_id is distinct from old.plan_id or new.template_id is distinct from old.template_id
     or new.second_approval_needed_at is distinct from old.second_approval_needed_at
     or new.first_approved_by is distinct from old.first_approved_by or new.first_approved_by_name is distinct from old.first_approved_by_name
     or new.first_approved_by_staff_id is distinct from old.first_approved_by_staff_id
     or new.second_approved_by is distinct from old.second_approved_by or new.second_approved_by_name is distinct from old.second_approved_by_name
     or new.second_approved_at is distinct from old.second_approved_at then
    raise exception 'Only the count approval records who approved a count.' using errcode = '42501';
  end if;
  return new;
end
$fn$;

-- An invoice sent to Xero is locked: only the service role (xero-bills) changes it after that. INVOKER.
create or replace function public.stock_co__invoice_lock_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $fn$
declare
  v_locked timestamptz;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role' then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_table_name = 'supplier_invoices' then
    v_locked := old.locked_at;
  else
    select i.locked_at into v_locked from public.supplier_invoices i where i.id = old.invoice_id;
  end if;
  if v_locked is not null then
    raise exception 'This invoice was sent to Xero and is locked.' using errcode = '55000';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end
$fn$;

create trigger stock_co_d3_org_guard before insert or update on public.stock_po_approvals
  for each row execute function public.stock_co__d3_org_guard();
create trigger stock_co_d3_org_guard before insert or update on public.stock_standing_orders
  for each row execute function public.stock_co__d3_org_guard();
create trigger stock_co_d3_org_guard before insert or update on public.stock_standing_runs
  for each row execute function public.stock_co__d3_org_guard();
create trigger stock_co_d3_org_guard before insert or update on public.stock_order_lists
  for each row execute function public.stock_co__d3_org_guard();
create trigger stock_co_d3_org_guard before insert or update on public.stock_budgets
  for each row execute function public.stock_co__d3_org_guard();
create trigger stock_co_d3_org_guard before insert or update on public.stock_credit_requests
  for each row execute function public.stock_co__d3_org_guard();
create trigger stock_co_d3_org_guard before insert or update on public.stock_credit_notes
  for each row execute function public.stock_co__d3_org_guard();
create trigger stock_co_d3_org_guard before insert or update on public.stock_template_shelf_order
  for each row execute function public.stock_co__d3_org_guard();
create trigger stock_co_d3_org_guard before insert or update on public.stock_transfer_lists
  for each row execute function public.stock_co__d3_org_guard();
create trigger stock_co_d3_org_guard before insert or update on public.stock_forecast_hours
  for each row execute function public.stock_co__d3_org_guard();
create trigger stock_co_d3_org_guard before insert or update on public.stock_co_site_forecast_source
  for each row execute function public.stock_co__d3_org_guard();
create trigger stock_co_d3_org_guard before insert or update on public.stock_kitchen_plan_ticks
  for each row execute function public.stock_co__d3_org_guard();
create trigger stock_co_d3_org_guard before insert or update on public.supplier_invoice_site_splits
  for each row execute function public.stock_co__d3_org_guard();
create trigger purchase_orders_approval_guard before update of status on public.purchase_orders
  for each row execute function public.stock_co__po_approval_guard();
create trigger purchase_orders_send_rule before update of status on public.purchase_orders
  for each row execute function public.stock_co__po_send_rule();
create trigger stock_counts_approval_fence before insert or update on public.stock_counts
  for each row execute function public.stock_co__count_approval_fence();
create trigger supplier_invoices_lock_guard before update or delete on public.supplier_invoices
  for each row execute function public.stock_co__invoice_lock_guard();
create trigger supplier_invoices_lock_guard before update or delete on public.supplier_invoice_lines
  for each row execute function public.stock_co__invoice_lock_guard();

-- Kitchen only recipes: who may read the method and cost (ServOS staff, the company owner, Stock control
-- all there, or a login that reaches the kitchen). STABLE; RLS calls it as the caller.
create or replace function public.stock_co__secret_ok(p_org uuid, p_kitchen uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
           public.is_super_admin()
           or (not public.is_anon_session() and auth.uid() is not null
               and (exists (select 1 from user_profiles p where p.id = auth.uid() and p.role = 'owner' and p.org_id = p_org)
                    or public.stock_level(auth.uid(), p_org) = 'all'))
           or (p_kitchen is not null and p_kitchen::text in (select public.stock_reach_locations())),
         false);
$fn$;

-- The restricted recipes of the caller's companies that the caller may not read.
create or replace function public.stock_co__hidden_recipes()
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(array_agg(r.id order by r.id), '{}'::uuid[])
    from stock_co_recipes r
    left join stock_co_recipe_secrets s on s.recipe_id = r.id
   where r.restricted
     and r.org_id::text in (select public.stock_reach_orgs())
     and not public.stock_co__secret_ok(r.org_id, s.kitchen_location_id);
$fn$;

create policy stock_co_recipe_secrets_read on public.stock_co_recipe_secrets as permissive for select to authenticated
  using (public.stock_co__secret_ok(org_id, kitchen_location_id));

-- Kitchen only recipes are hidden from logins that do not reach the kitchen (F11); the rollback puts the
-- live text back (R_ORG only).
alter policy stock_co_recipes_read on public.stock_co_recipes
  using (org_id::text in (select public.stock_reach_orgs()) and (not restricted or id <> all ((select public.stock_co__hidden_recipes())::uuid[])));
alter policy stock_co_recipe_lines_read on public.stock_co_recipe_lines
  using (org_id::text in (select public.stock_reach_orgs()) and recipe_id <> all ((select public.stock_co__hidden_recipes())::uuid[]));

-- The latest locked (not unlocked) period end at a site.
create or replace function public.stock_co__locked_until(p_loc uuid)
returns date
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select max(p.to_day) from stock_periods p
   where p.location_id = p_loc and p.locked_at is not null and p.unlocked_at is null;
$fn$;

-- One alert, staged once (the ledger's unique key); stock-notify sends it.
create or replace function public.stock_co__notify(p_org uuid, p_loc uuid, p_kind text, p_ref text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
begin
  if p_org is null or p_kind is null or p_ref is null then
    return;
  end if;
  insert into stock_notify_sent (org_id, location_id, kind, ref, payload)
  values (p_org, p_loc, p_kind, p_ref, coalesce(p_payload, '{}'::jsonb))
  on conflict do nothing;
end
$fn$;

-- The forecast for one venue day: the saved amount, else the same weekday over the last 4 venue weeks.
create or replace function public.stock_co__forecast_amount(p_loc uuid, p_day date)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(
           (select f.amount from wf_sales_forecast f where f.location_id = p_loc and f.forecast_date = p_day),
           (select round(avg(x.net), 2) from (
               select sum(d.net) as net from sales_day_sums d
                where d.location_id = p_loc and d.business_day in (p_day - 7, p_day - 14, p_day - 21, p_day - 28)
                group by d.business_day) x),
           0);
$fn$;

-- The SQL twin of nextDelivery (purchasingRules.js, contract 2.3): the next delivery whose order by time
-- is still ahead, on the venue's wall clock. An order by null means midnight at the start of the delivery
-- day (the end of the day before); an order after the cut off asks for the following delivery; a day in a
-- 'no_delivery' exception is skipped; 'deliver_instead' moves the day and its order by the same number of
-- days; at most 21 venue days; null when the supplier has no rules or nothing is found.
create or replace function public.stock_co__next_delivery(p_site_supplier uuid, p_now timestamptz default now())
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_s record;
  v_tz text;
  v_now timestamp;
  v_cand jsonb;
  v_best jsonb;
begin
  select s.id, s.location_id, s.company_ref, l.org_id into v_s
    from suppliers s join locations l on l.id = s.location_id where s.id = p_site_supplier;
  if v_s.id is null or not exists (select 1 from stock_order_rules o where o.supplier_id = v_s.id) then
    return null;
  end if;
  v_tz := public.stock_co__tz(v_s.location_id);
  v_now := date_trunc('minute', coalesce(p_now, now()) at time zone v_tz);
  with ex as (
    select x.* from stock_delivery_exceptions x
     where x.org_id = v_s.org_id and x.archived_at is null
       and x.to_day >= v_now::date and x.from_day <= v_now::date + 21
       and (x.scope = 'company' or (x.scope = 'supplier' and x.company_supplier_id = v_s.company_ref)
            or (x.scope = 'site' and x.location_id = v_s.location_id
                and (x.company_supplier_id is null or x.company_supplier_id = v_s.company_ref)))
  ), c as (
    select d.d, o.order_by_dow, o.order_by_time,
           (select x.name from ex x where x.kind = 'no_delivery' and d.d between x.from_day and x.to_day
             order by x.from_day, x.name, x.id limit 1) as skip_name,
           coalesce((select x.deliver_on - d.d from ex x where x.kind = 'deliver_instead' and d.d between x.from_day and x.to_day
                      order by x.from_day, x.name, x.id limit 1), 0) as shift
      from (select v_now::date + k as d from generate_series(0, 20) k) d
      join stock_order_rules o on o.supplier_id = v_s.id and o.delivery_dow = extract(dow from d.d)
  ), c2 as (
    select c.d as orig_day, c.d + c.shift as day, c.skip_name,
           case when c.order_by_time is null then (c.d + c.shift)::timestamp
                else (c.d - ((extract(dow from c.d)::integer - coalesce(c.order_by_dow::integer, (extract(dow from c.d)::integer + 6) % 7) + 7) % 7)
                      + c.shift) + c.order_by_time end as ob
      from c
  )
  select jsonb_agg(jsonb_build_object('orig_day', c2.orig_day, 'day', c2.day, 'ob', c2.ob, 'skip_name', c2.skip_name)
                   order by c2.day, c2.ob, c2.orig_day)
    into v_cand
    from c2 where c2.ob > v_now or c2.skip_name is not null;
  -- the first delivery still orderable; every no delivery day met on the walk before it is listed as skipped
  select e into v_best from jsonb_array_elements(coalesce(v_cand, '[]'::jsonb)) e
   where e ->> 'skip_name' is null and (e ->> 'ob')::timestamp > v_now limit 1;
  if v_best is null then
    return null;
  end if;
  return jsonb_build_object(
    'delivery_day', (v_best ->> 'day')::date,
    'order_by_at', ((v_best ->> 'ob')::timestamp at time zone v_tz),
    'order_by_ymd', to_char((v_best ->> 'ob')::timestamp, 'YYYY-MM-DD'),
    'order_by_hm', to_char((v_best ->> 'ob')::timestamp, 'HH24:MI'),
    'minutes_left', (extract(epoch from ((v_best ->> 'ob')::timestamp - v_now)) / 60)::bigint,
    'skipped', coalesce((select jsonb_agg(jsonb_build_object('day', x.d, 'name', x.n) order by x.d)
                           from (select distinct (e ->> 'orig_day')::date as d, e ->> 'skip_name' as n
                                   from jsonb_array_elements(v_cand) e
                                  where e ->> 'skip_name' is not null and (e ->> 'orig_day')::date < (v_best ->> 'day')::date) x),
                        '[]'::jsonb));
end
$fn$;

-- The net pack price of an internal (central kitchen) supplier pack: the kitchen's current cost for
-- 'cost', plus the markup for 'cost_plus', else the stored pack price (decision 2).
create or replace function public.stock_co__kitchen_price(p_site_sp uuid)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v record;
  v_cost numeric;
  v_base numeric;
begin
  select sp.pack_price, sp.pack_qty, sp.inner_qty, sp.inner_unit, si.ck_price_rule, si.ck_markup_pct, si.item_id,
         cs.internal_location_id
    into v
    from supplier_products sp
    join stock_co_supplier_item_sites sis on sis.site_supplier_product_id = sp.id
    join stock_co_supplier_items si on si.id = sis.supplier_item_id
    join stock_co_suppliers cs on cs.id = si.supplier_id
   where sp.id = p_site_sp;
  if v.internal_location_id is null then
    return (select sp.pack_price from supplier_products sp where sp.id = p_site_sp);
  end if;
  if coalesce(v.ck_price_rule, 'fixed') not in ('cost', 'cost_plus') then
    return v.pack_price;
  end if;
  select i.current_cost, public.stock_qty_to_base(coalesce(v.pack_qty, 1) * coalesce(v.inner_qty, 1), v.inner_unit, i.id)
    into v_cost, v_base
    from stock_co_item_sites s join inventory_items i on i.id = s.site_item_id
   where s.item_id = v.item_id and s.location_id = v.internal_location_id;
  if v_cost is null then
    return v.pack_price;
  end if;
  return round(v_cost * coalesce(v_base, coalesce(v.pack_qty, 1) * coalesce(v.inner_qty, 1))
               * case when v.ck_price_rule = 'cost_plus' then 1 + coalesce(v.ck_markup_pct, 0) / 100.0 else 1 end, 4);
end
$fn$;

-- Price here at ONE site from an invoice (decision 7): the write body of stock_save_supplier_item_site
-- for price_here only (the writer pass, the currency rule, the cost step and REVALUE through the site
-- sync, the change log with the source given), no guard.
create or replace function public.stock_co__set_price_here(p_si uuid, p_location uuid, p_price numeric, p_source text, p_doc uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_si stock_co_supplier_items;
  v_link stock_co_supplier_item_sites;
  v_before jsonb;
  v_after jsonb;
  v_r jsonb;
begin
  select * into v_si from stock_co_supplier_items x where x.id = p_si;
  select * into v_link from stock_co_supplier_item_sites x where x.supplier_item_id = p_si and x.location_id = p_location for update;
  if v_si.id is null or v_link.supplier_item_id is null then
    return jsonb_build_object('ok', false);
  end if;
  perform set_config('servos.stock_co_write', txid_current()::text, true);
  v_before := jsonb_build_object('price_here', v_link.price_here, 'off_here', v_link.off_here, 'paused', v_link.paused);
  update stock_co_supplier_item_sites x
     set price_here = round(p_price, 4), row_version = x.row_version + 1, updated_at = now()
   where x.supplier_item_id = p_si and x.location_id = p_location
  returning jsonb_build_object('price_here', x.price_here, 'off_here', x.off_here, 'paused', x.paused) into v_after;
  perform public.stock_co__currency_check(p_si);
  perform public.stock_co__log_diff(v_si.org_id, p_location, 'supplier_item_site', p_si,
                                    v_before || jsonb_build_object('doc', p_doc), v_after || jsonb_build_object('doc', p_doc),
                                    coalesce(p_source, 'invoice'));
  v_r := public.stock_co__sync_site(p_location, array[v_si.item_id], '{}'::uuid[], true, false);
  return jsonb_build_object('ok', true, 'cost', v_r -> 'cost');
end
$fn$;

-- The 3 way match (H7): ordered (and its price when ordered), received, invoiced.
create or replace function public.stock_co__match_invoice(p_invoice uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_inv supplier_invoices;
  v_org uuid;
  v_pct numeric;
  v_amt numeric;
  v_detail jsonb;
  v_price boolean;
  v_qty boolean;
  v_status text;
begin
  select * into v_inv from supplier_invoices i where i.id = p_invoice;
  if v_inv.id is null then
    return null;
  end if;
  select l.org_id into v_org from locations l where l.id = v_inv.location_id;
  select s.invoice_tolerance_pct, s.invoice_tolerance_amount into v_pct, v_amt from stock_co_settings s where s.org_id = v_org;
  if v_pct is null and v_amt is null then
    v_amt := 0.01;
    v_pct := 0;
  end if;
  with il as (
    select l.id, l.matched_item_id, l.description, l.qty, l.unit_price, l.sort_order from supplier_invoice_lines l where l.invoice_id = p_invoice
  ), pl as (
    select p.inventory_item_id, sum(p.qty_packs) as ordered, sum(coalesce(p.qty_received, 0)) as received,
           max(coalesce(p.ordered_unit_price, p.unit_price)) as price
      from po_lines p where v_inv.po_id is not null and p.po_id = v_inv.po_id group by p.inventory_item_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'line_id', il.id, 'item_id', il.matched_item_id, 'description', il.description,
           'ordered', pl.ordered, 'received', pl.received, 'invoiced', il.qty,
           'ordered_price', pl.price, 'invoiced_price', il.unit_price,
           'price_ok', case when v_inv.po_id is null then il.matched_item_id is not null
                            when pl.price is null then false
                            else abs(il.unit_price - pl.price) <= greatest(coalesce(v_amt, 0), coalesce(v_pct, 0) / 100.0 * pl.price) + 0.000001 end,
           'qty_ok', case when v_inv.po_id is null then il.matched_item_id is not null
                          when pl.received is null then false
                          else abs(il.qty - pl.received) < 0.0005 end) order by il.sort_order, il.id), '[]'::jsonb)
    into v_detail
    from il left join pl on pl.inventory_item_id = il.matched_item_id;
  v_price := exists (select 1 from jsonb_array_elements(v_detail) e where not (e ->> 'price_ok')::boolean);
  v_qty := exists (select 1 from jsonb_array_elements(v_detail) e where not (e ->> 'qty_ok')::boolean);
  v_status := case when v_inv.po_id is null then case when v_price or v_qty then 'qty_issue' else 'matched' end
                   when v_price and v_qty then 'both' when v_price then 'price_issue' when v_qty then 'qty_issue' else 'matched' end;
  update supplier_invoices i set match_status = v_status, match_detail = v_detail
   where i.id = p_invoice and i.match_status is distinct from 'by_hand'
     and (i.match_status is distinct from v_status or i.match_detail is distinct from v_detail);
  return jsonb_build_object('match_status', v_status, 'lines', v_detail);
end
$fn$;

-- Place an inbox file at a site by the supplier account number, else the delivery address postcode.
create or replace function public.stock_co__inbox_place_auto(p_inbox uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v stock_invoice_inbox;
  v_acct text;
  v_pc text;
  v_loc uuid;
  v_sup uuid;
  v_n integer;
  v_how text;
begin
  select * into v from stock_invoice_inbox i where i.id = p_inbox for update;
  if v.id is null or v.status <> 'waiting' then
    return null;
  end if;
  v_acct := upper(regexp_replace(coalesce(v.account_number, v.scan ->> 'account_number', ''), '\s+', '', 'g'));
  if v_acct <> '' then
    select count(distinct s.location_id), min(s.location_id::text)::uuid into v_n, v_loc
      from suppliers s join locations l on l.id = s.location_id
     where l.org_id = v.org_id and s.archived_at is null
       and upper(regexp_replace(coalesce(s.account_number, ''), '\s+', '', 'g')) = v_acct;
    if v_n = 1 then
      v_how := 'account_number';
      select s.company_ref into v_sup from suppliers s
       where s.location_id = v_loc and upper(regexp_replace(coalesce(s.account_number, ''), '\s+', '', 'g')) = v_acct limit 1;
    end if;
  end if;
  if v_how is null then
    v_pc := upper(regexp_replace(coalesce(substring(coalesce(v.delivery_address, v.scan ->> 'delivery_address', '')
                                                     from '([A-Za-z]{1,2}[0-9][A-Za-z0-9]? ?[0-9][A-Za-z]{2})'), ''), '\s+', '', 'g'));
    if v_pc <> '' then
      select count(*), min(l.id::text)::uuid into v_n, v_loc
        from locations l
       where l.org_id = v.org_id and coalesce(l.status, 'active') = 'active'
         and upper(regexp_replace(coalesce(substring(coalesce(l.address, '') from '([A-Za-z]{1,2}[0-9][A-Za-z0-9]? ?[0-9][A-Za-z]{2})'), ''), '\s+', '', 'g')) = v_pc;
      if v_n = 1 then
        v_how := 'address';
      end if;
    end if;
  end if;
  if v_how is null then
    return null;
  end if;
  update stock_invoice_inbox i
     set location_id = v_loc, status = 'placed', placed_how = v_how, placed_at = now(),
         company_supplier_id = coalesce(i.company_supplier_id, v_sup), updated_at = now()
   where i.id = p_inbox;
  return v_how;
end
$fn$;

-- The submit body (stock_po_submit, stock_create_orders_many and the runner): checks, the price when
-- ordered, the delivery fee, the delivery day; then internal (SENT to the kitchen), approval, or send.
create or replace function public.stock_co__po_submit_core(p_po uuid, p_by uuid, p_by_name text, p_standing boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_po purchase_orders;
  v_sup suppliers;
  v_co stock_co_suppliers;
  v_org uuid;
  v_cur text;
  v_lname text;
  v_bad text;
  v_goods numeric;
  v_fee numeric;
  v_next jsonb;
  v_amount numeric;
  v_names jsonb;
  v_ap stock_po_approvals;
begin
  select * into v_po from purchase_orders p where p.id = p_po for update;
  if v_po.id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if v_po.status <> 'DRAFT' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', v_po.status, 'po_id', v_po.id);
  end if;
  select * into v_sup from suppliers s where s.id = v_po.supplier_id and s.location_id = v_po.location_id;
  if v_sup.id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_co from stock_co_suppliers c where c.id = v_sup.company_ref;
  select l.org_id, l.currency, l.name into v_org, v_cur, v_lname from locations l where l.id = v_po.location_id;
  -- paused lines (Drop 1 words)
  select string_agg(coalesce(i.name, 'An item') || ': ' ||
                    case when (pz ->> 'everywhere')::boolean then 'Paused everywhere' else 'Paused at ' || v_lname end ||
                    coalesce(' until ' || to_char((pz ->> 'until')::date, 'FMDD Mon'), ''), '; ' order by i.name)
    into v_bad
    from po_lines pl
    join inventory_items i on i.id = pl.inventory_item_id
    cross join lateral (select public.stock_co__paused_now(i.company_ref, v_po.location_id, null) as pz) z
   where pl.po_id = p_po and i.company_ref is not null and z.pz is not null;
  if v_bad is not null then
    raise exception '%', v_bad using errcode = '22023';
  end if;
  -- internal supplier lines carry the kitchen price
  if v_co.internal_location_id is not null then
    update po_lines pl set unit_price = public.stock_co__kitchen_price(pl.supplier_product_id)
     where pl.po_id = p_po and pl.supplier_product_id is not null
       and public.stock_co__kitchen_price(pl.supplier_product_id) is not null;
  end if;
  update po_lines pl set ordered_unit_price = pl.unit_price where pl.po_id = p_po;
  select coalesce(sum(round(coalesce(pl.qty_packs, 0) * coalesce(pl.unit_price, 0), 2)), 0) into v_goods from po_lines pl where pl.po_id = p_po;
  if v_co.max_order_value is not null and v_goods > v_co.max_order_value then
    raise exception 'Over the maximum % for %. Split the order or ask head office.',
      public.stock_co__money(v_cur, v_co.max_order_value), coalesce(v_co.name, v_sup.name) using errcode = '22023';
  end if;
  v_fee := case when v_sup.delivery_fee is null or v_sup.delivery_fee = 0 then null
                when coalesce(v_co.fee_waived_over_min, false) and v_sup.min_order_value is not null and v_goods >= v_sup.min_order_value then null
                else v_sup.delivery_fee end;
  v_next := public.stock_co__next_delivery(v_sup.id, now());
  update purchase_orders p
     set delivery_fee = v_fee,
         expected_date = coalesce(p.expected_date, (v_next ->> 'delivery_day')::date),
         subtotal = case when v_co.internal_location_id is not null then v_goods else p.subtotal end,
         updated_at = now()
   where p.id = p_po;
  if v_co.internal_location_id is not null then
    perform set_config('servos.stock_po_send', txid_current()::text, true);
    update purchase_orders p set status = 'SENT', ordered_at = coalesce(p.ordered_at, now()), updated_at = now() where p.id = p_po;
    return jsonb_build_object('ok', true, 'internal', true, 'po_id', p_po, 'status', 'SENT');
  end if;
  v_amount := v_goods + coalesce(v_fee, 0);
  -- approved (or sent anyway, or sent unapproved) for at least this amount: it goes; more than that asks again
  select * into v_ap from stock_po_approvals a where a.po_id = p_po;
  if v_ap.status in ('approved', 'sent_anyway', 'sent_unapproved') and v_amount <= v_ap.amount then
    return jsonb_build_object('ok', true, 'send', true, 'po_id', p_po, 'approved', true);
  end if;
  if not (p_standing or exists (select 1 from stock_standing_runs r where r.po_id = p_po))
     and v_sup.approval_limit is not null and v_amount > v_sup.approval_limit then
    insert into stock_po_approvals (org_id, location_id, po_id, supplier_id, amount, limit_amount, raised_by, raised_by_name,
                                    status, step, delivery_day, order_by_at)
    values (v_org, v_po.location_id, p_po, v_sup.id, v_amount, v_sup.approval_limit, p_by, p_by_name, 'waiting', 0,
            (v_next ->> 'delivery_day')::date, (v_next ->> 'order_by_at')::timestamptz)
    on conflict (po_id) do update
       set amount = excluded.amount, limit_amount = excluded.limit_amount, status = 'waiting', step = 0,
           delivery_day = excluded.delivery_day, order_by_at = excluded.order_by_at,
           raised_by = excluded.raised_by, raised_by_name = excluded.raised_by_name, raised_by_staff_id = null,
           decided_by = null, decided_by_name = null, decided_at = null, updated_at = now();
    perform public.stock_co__notify(v_org, v_po.location_id, 'approval_wait', p_po::text,
      jsonb_build_object('title', 'Order waiting for approval', 'body', coalesce(v_co.name, v_sup.name) || ' ' || public.stock_co__money(v_cur, v_amount),
                         'route', 'purchase-orders', 'focus', p_po, 'amount', v_amount, 'raised_by', p_by));
    select coalesce(jsonb_agg(n.name order by n.name), '[]'::jsonb) into v_names from (
      select distinct coalesce(nullif(btrim(p.full_name), ''), p.email) as name
        from user_profiles p
       where p.id is distinct from p_by
         and (p.id in (select ul.user_id from user_locations ul where ul.location_id = v_po.location_id)
              or (p.org_id = v_org and (p.role = 'owner'
                    or (p.stock_control = 'all' and (p.bo_sections is null or 'purchasing' = any(p.bo_sections))))))
       limit 10) n;
    return jsonb_build_object('ok', true, 'needs_approval', true, 'po_id', p_po, 'limit', v_sup.approval_limit, 'amount', v_amount,
                              'order_by_at', v_next ->> 'order_by_at', 'approvers', v_names);
  end if;
  return jsonb_build_object('ok', true, 'send', true, 'po_id', p_po);
end
$fn$;

-- The count plans due at each site on a venue day (null = each site's today): stock_count_due, the needs
-- attention rows and the alert staging share it. Done = a SUBMITTED or APPROVED count of that plan started
-- that venue day before due_by; late = after due_by; missed = none by the end of the venue day.
create or replace function public.stock_co__count_due_rows(p_org uuid, p_sites uuid[], p_day date default null)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  with s as (
    select l.id as loc, l.org_id, coalesce(p_day, public.stock_co__today(l.id)) as day, public.stock_co__today(l.id) as today,
           public.stock_co__tz(l.id) as tz
      from locations l where l.id = any(p_sites) and l.org_id = p_org
  ), pl as (
    select p.*, s.loc, s.day, s.today, s.tz
      from stock_count_plans p
      join s on s.org_id = p.org_id
     where p.org_id = p_org and p.active and p.archived_at is null
       and ((p.sites is null and p.group_ids is null)
            or s.loc = any(coalesce(p.sites, '{}'::uuid[]))
            or exists (select 1 from stock_co_site_groups g where g.id = any(coalesce(p.group_ids, '{}'::uuid[])) and s.loc = any(g.location_ids)))
       and public.stock_co__vday(s.loc, p.created_at) <= s.day
       and case p.every when 'day' then true
                        when 'week' then extract(dow from s.day)::smallint = any(coalesce(p.dows, '{}'::smallint[]))
                        else extract(day from s.day)::smallint = p.day_of_month end
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'plan_id', pl.id, 'plan_name', pl.name, 'location_id', pl.loc, 'due_day', pl.day, 'due_by', to_char(pl.due_by, 'HH24:MI'),
           'status', case when c.id is not null and (c.started_at at time zone pl.tz)::time <= pl.due_by then 'done'
                          when c.id is not null then 'late'
                          when pl.day < pl.today then 'missed'
                          else 'due' end,
           'count_id', c.id) order by pl.loc, pl.name, pl.id), '[]'::jsonb)
    from pl
    left join lateral (select k.id, k.started_at from stock_counts k
                        where k.plan_id = pl.id and k.location_id = pl.loc and k.status in ('SUBMITTED', 'APPROVED')
                          and public.stock_co__vday(pl.loc, coalesce(k.started_at, k.created_at)) = pl.day
                        order by k.started_at nulls last, k.id limit 1) c on true;
$fn$;


-- ============================================================================
-- STEP 4. THE 10 REBUILT BODIES (contract 1.5): the live text, changed only where it says DROP 3 20261027a
-- ============================================================================

CREATE OR REPLACE FUNCTION public.stock_co__recipe_on_at(p_recipe uuid, p_loc uuid, p_menu_item_id text, p_why text, p_by text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_r stock_co_recipes;
  v_org uuid;
  v_lname text;
  v_items uuid[];
  v_new_items uuid[];
  v_res jsonb;
  v_sid uuid;
  v_menu text := nullif(btrim(coalesce(p_menu_item_id, '')), '');
  v_old_menu text;
  v_nested uuid;
  v_sub jsonb;
  v_src text := coalesce(nullif(public.stock_co__d1_source(), ''), 'save');
begin
  perform set_config('servos.stock_co_write', txid_current()::text, true);
  select * into v_r from stock_co_recipes r where r.id = p_recipe;
  select l.org_id, l.name into v_org, v_lname from locations l where l.id = p_loc;
  if v_r.id is null or v_org is null or v_r.org_id is distinct from v_org then
    return jsonb_build_object('ok', false, 'error', 'That site is not in this company.');
  end if;
  if v_r.archived_at is not null then
    return jsonb_build_object('ok', false, 'error', 'This recipe is archived, so it cannot be linked.');
  end if;
  begin
    -- DROP 3 20261027a: a kitchen only recipe is made at its kitchen only (caught into refused below).
    if coalesce(v_r.restricted, false)
       and p_loc is distinct from (select s.kitchen_location_id from stock_co_recipe_secrets s where s.recipe_id = p_recipe) then
      raise exception 'Only the kitchen makes this recipe. Other sites buy it from the kitchen.' using errcode = '55000';
    end if;
    -- 1. every item the recipe needs, ticked on here
    v_items := public.stock_co__recipe_components(p_recipe);
    v_new_items := array(select x from unnest(v_items) x
                          where not exists (select 1 from stock_co_item_sites s where s.item_id = x and s.location_id = p_loc and s.on_here));
    if cardinality(v_items) > 0 then
      v_res := public.stock_co__set_sites_at(v_items, p_loc, 'add', p_by);
      if jsonb_array_length(coalesce(v_res -> 'refused', '[]'::jsonb)) > 0 then
        raise exception 'Not written at %: % uses an item or a pack that is not set up there. Add the item at that site first.', v_lname, v_r.name
          using errcode = '55000';
      end if;
      update stock_co_item_sites s set why_on = 'On because ' || v_r.name || ' is sold here'
       where s.item_id = any(v_new_items) and s.location_id = p_loc;
    end if;
    -- 2. the nested batch and prep recipes it is made from, on here too (no till link)
    for v_nested in select x from unnest(public.stock_co__recipe_nested(p_recipe)) x loop
      if not exists (select 1 from stock_co_recipe_sites s where s.recipe_id = v_nested and s.location_id = p_loc and s.on_here) then
        v_sub := public.stock_co__recipe_on_at(v_nested, p_loc, null, 'On because ' || v_r.name || ' is sold here', p_by);
        if not coalesce((v_sub ->> 'ok')::boolean, false) then
          raise exception '%', coalesce(v_sub ->> 'error', 'A recipe it is made from could not be set up there.') using errcode = '55000';
        end if;
      end if;
    end loop;
    -- 3. the site recipe
    select s.site_recipe_id, s.site_menu_item_id into v_sid, v_old_menu
      from stock_co_recipe_sites s where s.recipe_id = p_recipe and s.location_id = p_loc;
    if v_sid is null then
      v_sid := public.stock_co__new_site_recipe(p_recipe, p_loc);
    else
      update stock_co_recipe_sites s set on_here = true, row_version = s.row_version + 1, updated_at = now()
       where s.recipe_id = p_recipe and s.location_id = p_loc and not s.on_here;
    end if;
    -- 4. the till link, when given (the stock_link_menu_item body)
    if v_menu is not null then
      if not exists (select 1 from menu_items m where m.id = v_menu and m.location_id = p_loc::text) then
        raise exception 'That till product is not on this venue''s menu.' using errcode = '22023';
      end if;
      update stock_co_recipe_sites s set site_menu_item_id = null, row_version = s.row_version + 1, updated_at = now()
       where s.location_id = p_loc and s.site_menu_item_id = v_menu and s.recipe_id <> p_recipe;
      update stock_co_recipe_sites s
         set site_menu_item_id = v_menu, linked_at = now(), row_version = s.row_version + 1, updated_at = now()
       where s.recipe_id = p_recipe and s.location_id = p_loc and s.site_menu_item_id is distinct from v_menu;
    end if;
    update stock_co_recipe_sites s
       set why_on = coalesce(s.why_on, nullif(btrim(coalesce(p_why, '')), ''), 'Added by ' || coalesce(nullif(btrim(coalesce(p_by, '')), ''), 'head office'))
     where s.recipe_id = p_recipe and s.location_id = p_loc;
    -- 5. the recipe at the site: columns, lines, the till link
    perform public.stock_co__sync_recipes(p_loc, array[p_recipe], true, false);
    if v_menu is not null then
      insert into menu_item_recipes (location_id, menu_item_id, recipe_id, portion)
      values (p_loc, v_menu, v_sid, 1)
      on conflict (location_id, menu_item_id) do update set recipe_id = excluded.recipe_id;
      if v_old_menu is distinct from v_menu then
        perform public.stock_co__log(v_org, p_loc, 'menu_link', p_recipe, 'menu_item_id', to_jsonb(v_old_menu), to_jsonb(v_menu), v_src);
      end if;
    end if;
    perform public.stock_co__log(v_org, p_loc, 'recipe_site', p_recipe, 'on_here', to_jsonb(false), to_jsonb(true), v_src);
    -- 6. today's cost row and the facts of the linked product
    perform public.stock_co__cost_rows(array[p_recipe], array[p_loc], null);
    select s.site_menu_item_id into v_old_menu from stock_co_recipe_sites s where s.recipe_id = p_recipe and s.location_id = p_loc;
    if v_old_menu is not null then
      perform public.stock_co__facts_rebuild_site(p_loc, array[v_old_menu]);
    end if;
    return jsonb_build_object('ok', true, 'location_id', p_loc, 'site_recipe_id', v_sid, 'menu_item_id', v_old_menu,
                              'items_added', cardinality(v_new_items));
  exception
    when lock_not_available or deadlock_detected or query_canceled then
      raise;
    when others then
      return jsonb_build_object('ok', false, 'location_id', p_loc, 'error', sqlerrm, 'code', sqlstate);
  end;
end
$function$;

CREATE OR REPLACE FUNCTION public.stock_post_invoice(p_location_id uuid, p_invoice jsonb, p_lines jsonb, p_receipts jsonb DEFAULT '[]'::jsonb, p_area_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_supplier uuid;
  v_po uuid;
  v_po_status text;
  v_number text;
  v_inv uuid;
  v_rec jsonb;
  v_res jsonb;
  v_client uuid;
  v_con text;
  v_ans jsonb;
  v_multi boolean := false;
  v_org uuid;
  v_l record;
  v_old numeric;
  v_new numeric;
  v_packs numeric;
  v_agreed numeric;
  v_rules jsonb := '[]'::jsonb;
  v_credit jsonb := '[]'::jsonb;
  v_credit_id uuid;
  v_match text;
  v_inbox uuid;
  v_cur text;
begin
  if not public.stock_office_reaches(p_location_id) then
    raise exception 'stock_post_invoice: this session cannot post invoices at venue %', p_location_id using errcode = '42501';
  end if;
  if p_invoice is null or jsonb_typeof(p_invoice) <> 'object' then
    raise exception 'stock_post_invoice: the invoice is missing' using errcode = '22023';
  end if;
  -- A retry of the same invoice (the answer was lost): the screen sends the same client_id, which is
  -- the invoice's own id, so nothing is posted twice, with or without an invoice number.
  if coalesce(p_invoice ->> 'client_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_client := (p_invoice ->> 'client_id')::uuid;
    if exists (select 1 from supplier_invoices si where si.id = v_client) then
      if not exists (select 1 from supplier_invoices si where si.id = v_client and si.location_id = p_location_id) then
        raise exception 'stock_post_invoice: invoice % is not at venue %', v_client, p_location_id using errcode = '22023';
      end if;
      return jsonb_build_object('ok', true, 'duplicate', true, 'invoice_id', v_client,
        'words', 'This invoice was posted already. Nothing was posted twice.');
    end if;
  end if;
  -- DROP 3 20261027a: the invoice price rule, the match and the inbox run for multi site companies only;
  -- a one site company runs the body as it was.
  select l.org_id, l.currency into v_org, v_cur from locations l where l.id = p_location_id;
  v_multi := v_org is not null and public.stock_co__multi(v_org);
  -- DROP 3 20261027a: central kitchen goods are received only through their transfer: never an invoice
  -- from the kitchen supplier here, with an order or without one (its delivery note is not a delivery).
  if exists (select 1 from purchase_orders po
               join suppliers s on s.id = po.supplier_id
               join stock_co_suppliers c on c.id = s.company_ref
              where po.id = nullif(p_invoice ->> 'po_id', '')::uuid and c.internal_location_id is not null)
     or exists (select 1 from suppliers s join stock_co_suppliers c on c.id = s.company_ref
                 where s.id = nullif(p_invoice ->> 'supplier_id', '')::uuid and c.internal_location_id is not null) then
    raise exception 'This order arrives as a transfer from the central kitchen. Receive it in Transfers.' using errcode = '55000';
  end if;
  if p_area_id is not null and not exists (select 1 from storage_areas a where a.id = p_area_id and a.location_id = p_location_id) then
    raise exception 'stock_post_invoice: stock area % is not at venue %', p_area_id, p_location_id using errcode = '22023';
  end if;
  select s.id into v_supplier from suppliers s
   where s.id = nullif(p_invoice ->> 'supplier_id', '')::uuid and s.location_id = p_location_id;
  v_po := nullif(p_invoice ->> 'po_id', '')::uuid;
  if v_po is not null then
    select po.status into v_po_status from purchase_orders po where po.id = v_po and po.location_id = p_location_id;
    if v_po_status is null then
      raise exception 'stock_post_invoice: order % is not at venue %', v_po, p_location_id using errcode = '22023';
    end if;
    -- An invoice is linked only to an order already received (it is then paperwork): linking one to
    -- an order still on its way and then receiving that order would count the stock twice.
    if v_po_status <> 'RECEIVED' then
      return jsonb_build_object('ok', false, 'code', 'po_not_received',
        'error', 'That order has not been received yet. Receive it first (its stock goes in then), and its invoice is kept as paperwork.');
    end if;
  end if;
  v_number := nullif(btrim(coalesce(p_invoice ->> 'invoice_number', '')), '');
  if v_number is not null and exists (
       select 1 from supplier_invoices si
        where si.location_id = p_location_id and si.status = 'POSTED'
          and coalesce(si.supplier_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(v_supplier, '00000000-0000-0000-0000-000000000000'::uuid)
          and lower(btrim(si.invoice_number)) = lower(v_number)) then
    return jsonb_build_object('ok', false, 'code', 'duplicate_number',
      'error', 'Invoice ' || v_number || ' from this supplier is posted already at this venue. Nothing was posted again.');
  end if;

  -- Two retries at the same moment: the second waits on the first and is answered as a repeat.
  begin
    insert into supplier_invoices (id, location_id, supplier_id, po_id, invoice_number, invoice_date, status, ocr_confidence,
        subtotal, tax, total, raw_json, image_path, posted_at)
      values (coalesce(v_client, gen_random_uuid()), p_location_id, v_supplier, v_po, v_number, nullif(p_invoice ->> 'invoice_date', '')::date, 'POSTED',
        nullif(p_invoice ->> 'ocr_confidence', '')::numeric, nullif(p_invoice ->> 'subtotal', '')::numeric,
        nullif(p_invoice ->> 'tax', '')::numeric, nullif(p_invoice ->> 'total', '')::numeric,
        case when jsonb_typeof(p_invoice -> 'raw_json') = 'object' then p_invoice -> 'raw_json' end,
        nullif(p_invoice ->> 'image_path', ''), now())
      returning id into v_inv;
  exception when unique_violation then
    get stacked diagnostics v_con = constraint_name;
    if v_client is not null and exists (select 1 from supplier_invoices si where si.id = v_client and si.location_id = p_location_id) then
      return jsonb_build_object('ok', true, 'duplicate', true, 'invoice_id', v_client,
        'words', 'This invoice was posted already. Nothing was posted twice.');
    end if;
    if v_con = 'supplier_invoices_posted_number_uniq' then
      return jsonb_build_object('ok', false, 'code', 'duplicate_number',
        'error', 'Invoice ' || v_number || ' from this supplier is posted already at this venue. Nothing was posted again.');
    end if;
    raise;
  end;

  insert into supplier_invoice_lines (location_id, invoice_id, matched_item_id, description, qty, unit, unit_price,
      line_total, purchase_tax_rate_id, line_tax, flags, sort_order, supplier_product_id)
  select p_location_id, v_inv,
         (select i.id from inventory_items i where i.id = nullif(e.v ->> 'matched_item_id', '')::uuid and i.location_id = p_location_id),
         e.v ->> 'description', coalesce(nullif(e.v ->> 'qty', '')::numeric, 0), coalesce(nullif(e.v ->> 'unit', ''), 'each'),
         coalesce(nullif(e.v ->> 'unit_price', '')::numeric, 0), nullif(e.v ->> 'line_total', '')::numeric,
         nullif(e.v ->> 'purchase_tax_rate_id', '')::uuid, nullif(e.v ->> 'line_tax', '')::numeric,
         case when jsonb_typeof(e.v -> 'flags') = 'array' then e.v -> 'flags' else '[]'::jsonb end,
         (e.n - 1)::integer,
         (select sp.id from supplier_products sp where sp.id = nullif(e.v ->> 'supplier_product_id', '')::uuid and sp.location_id = p_location_id)
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) with ordinality as e(v, n);

  if v_po_status = 'RECEIVED' then
    v_ans := jsonb_build_object('ok', true, 'invoice_id', v_inv, 'stock', false, 'code', 'po_received',
      'words', 'Kept as paperwork for an order received already: no stock was counted twice.');
  else
    select coalesce(jsonb_agg(r.v || jsonb_build_object('key', 'inv:' || v_inv::text || ':' || (r.v ->> 'item_id') || ':' || coalesce(r.v ->> 'line_index', '0'))), '[]'::jsonb)
      into v_rec
      from jsonb_array_elements(coalesce(p_receipts, '[]'::jsonb)) r(v);
    v_res := public._stock_receive_lines(p_location_id, 'supplier_invoice', v_inv::text, v_rec, p_area_id, null);
    v_ans := jsonb_build_object('ok', true, 'invoice_id', v_inv, 'stock', true, 'posted', v_res -> 'posted', 'lines', v_res -> 'lines');
  end if;
  if not v_multi then
    return v_ans;
  end if;

  -- DROP 3 20261027a (decision 7): the invoice price rule, line by line, after the stock went in at the
  -- price charged. A supplier that accepts price changes moves the price here at THIS site only; agreed
  -- prices over the allowed difference raise one credit request and the price stays. The price compared
  -- is the NET price of one pack as posted: the net line total over the packs received (the receipt's
  -- base quantity over the pack's base quantity). A line that cannot be put in packs (no receipt, a unit
  -- that does not convert to the pack) leaves the price alone.
  for v_l in
    select l.id, l.qty, l.unit_price, l.line_total, l.description, l.matched_item_id, l.sort_order, sis.supplier_item_id, sis.price_here,
           sp.pack_price as site_price, csi.pack_price as co_price, csi.agreed_until, csi.allowed_diff_pct,
           coalesce(cs.accepts_price_changes, true) as accepts,
           (select sum(nullif(r.v ->> 'qty_base', '')::numeric)
              from jsonb_array_elements(case when jsonb_typeof(p_receipts) = 'array' then p_receipts else '[]'::jsonb end) r(v)
             where (r.v ->> 'line_index') = l.sort_order::text and nullif(r.v ->> 'item_id', '')::uuid = l.matched_item_id) as got_base,
           public.stock_qty_to_base(coalesce(sp.pack_qty, 1) * coalesce(sp.inner_qty, 1), sp.inner_unit, l.matched_item_id) as pack_base
      from supplier_invoice_lines l
      join supplier_products sp on sp.id = l.supplier_product_id and sp.location_id = p_location_id
      join stock_co_supplier_item_sites sis on sis.site_supplier_product_id = sp.id and sis.location_id = p_location_id
      join stock_co_supplier_items csi on csi.id = sis.supplier_item_id
      join stock_co_suppliers cs on cs.id = csi.supplier_id
     where l.invoice_id = v_inv and l.supplier_product_id is not null and coalesce(l.line_total, 0) > 0
     order by l.sort_order, l.id
  loop
    continue when coalesce(v_l.got_base, 0) <= 0 or coalesce(v_l.pack_base, 0) <= 0;
    v_packs := v_l.got_base / v_l.pack_base;
    v_new := round(v_l.line_total / v_packs, 4);
    v_old := coalesce(v_l.site_price, v_l.price_here, v_l.co_price);
    if v_l.accepts then
      if v_old is null or abs(v_new - v_old) > 0.005 then
        perform public.stock_co__set_price_here(v_l.supplier_item_id, p_location_id, v_new, 'invoice', v_inv);
        v_rules := v_rules || jsonb_build_array(jsonb_build_object('supplier_item_id', v_l.supplier_item_id, 'rule', 'price_here',
                     'old', v_old, 'new', v_new, 'pct', case when coalesce(v_old, 0) > 0 then round((v_new - v_old) / v_old * 100, 1) end));
        if coalesce(v_old, 0) > 0 and (v_new - v_old) / v_old > 0.05 then
          perform public.stock_co__notify(v_org, p_location_id, 'price_rise',
            v_l.supplier_item_id::text || ':' || p_location_id::text || ':' || v_inv::text,
            jsonb_build_object('title', 'Price rose', 'body', coalesce(v_l.description, 'An item') || ' rose '
                                 || round((v_new - v_old) / v_old * 100, 1)::text || '%',
                               'route', 'price-changes',
                               'focus', jsonb_build_object('tab', 'supplier', 'supplierItemId', v_l.supplier_item_id, 'locationId', p_location_id),
                               'item_name', v_l.description, 'pct', round((v_new - v_old) / v_old * 100, 1), 'old', v_old, 'new', v_new));
        end if;
      else
        v_rules := v_rules || jsonb_build_array(jsonb_build_object('supplier_item_id', v_l.supplier_item_id, 'rule', 'none',
                     'old', v_old, 'new', v_new, 'pct', 0));
      end if;
    else
      v_agreed := coalesce(v_l.price_here, v_l.co_price, v_l.site_price);
      if v_agreed is not null
         and (v_l.agreed_until is null or v_l.agreed_until >= coalesce(nullif(p_invoice ->> 'invoice_date', '')::date, current_date))
         and v_new > v_agreed * (1 + coalesce(v_l.allowed_diff_pct, 0) / 100.0) + 0.00005 then
        v_credit := v_credit || jsonb_build_array(jsonb_build_object('item_id', v_l.matched_item_id, 'description', coalesce(v_l.description, 'Overcharge'),
                      'qty', round(v_packs, 3), 'charged', v_new, 'agreed', v_agreed, 'amount', round(v_packs * (v_new - v_agreed), 2), 'n', v_l.sort_order));
        v_rules := v_rules || jsonb_build_array(jsonb_build_object('supplier_item_id', v_l.supplier_item_id, 'rule', 'credit_request',
                     'old', v_agreed, 'new', v_new, 'pct', case when v_agreed > 0 then round((v_new - v_agreed) / v_agreed * 100, 1) end));
      else
        v_rules := v_rules || jsonb_build_array(jsonb_build_object('supplier_item_id', v_l.supplier_item_id, 'rule', 'none',
                     'old', v_agreed, 'new', v_new, 'pct', case when coalesce(v_agreed, 0) > 0 then round((v_new - v_agreed) / v_agreed * 100, 1) end));
      end if;
    end if;
  end loop;
  if jsonb_array_length(v_credit) > 0 then
    insert into stock_credit_requests (org_id, location_id, supplier_id, invoice_id, po_id, reason, status, amount, note, created_by, created_by_name)
    values (v_org, p_location_id, v_supplier, v_inv, v_po, 'overcharge', 'asked',
            (select sum((e ->> 'amount')::numeric) from jsonb_array_elements(v_credit) e),
            'Raised by the invoice price rule', auth.uid(),
            (select coalesce(nullif(btrim(p.full_name), ''), p.email) from user_profiles p where p.id = auth.uid()))
    returning id into v_credit_id;
    insert into stock_credit_request_lines (request_id, location_id, inventory_item_id, description, qty, unit_price_charged,
                                            unit_price_agreed, amount, sort_order)
    select v_credit_id, p_location_id, (e ->> 'item_id')::uuid, e ->> 'description', (e ->> 'qty')::numeric, (e ->> 'charged')::numeric,
           (e ->> 'agreed')::numeric, (e ->> 'amount')::numeric, (e ->> 'n')::integer
      from jsonb_array_elements(v_credit) e;
  end if;
  -- (d) the inbox file this invoice came from
  v_inbox := case when coalesce(p_invoice ->> 'inbox_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  then (p_invoice ->> 'inbox_id')::uuid end;
  if v_inbox is not null and exists (select 1 from stock_invoice_inbox b where b.id = v_inbox and b.org_id = v_org) then
    update supplier_invoices si set inbox_id = v_inbox where si.id = v_inv;
    update stock_invoice_inbox b set status = 'posted', invoice_id = v_inv, location_id = coalesce(b.location_id, p_location_id), updated_at = now()
     where b.id = v_inbox;
  end if;
  -- (c) the 3 way match
  v_match := public.stock_co__match_invoice(v_inv) ->> 'match_status';
  return v_ans || jsonb_build_object('price_rule', v_rules, 'credit_request_id', v_credit_id, 'match_status', v_match);
end $function$;

CREATE OR REPLACE FUNCTION public.stock_receive(p_location_id uuid, p_source_type text, p_source_id text, p_lines jsonb, p_area_id uuid DEFAULT NULL::uuid, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not (public.stock_office_reaches(p_location_id)
          or (p_location_id is not null and auth.uid() is not null
              and exists (select 1 from ops_devices d
                           where d.location_id = p_location_id and d.device_uid = auth.uid() and d.active))) then
    raise exception 'stock_receive: this session cannot move stock at venue %', p_location_id using errcode = '42501';
  end if;
  if p_source_type is null or p_source_type not in ('purchase_order', 'supplier_invoice') then
    raise exception 'stock_receive: source must be purchase_order or supplier_invoice' using errcode = '22023';
  end if;
  -- DROP 3 20261027a: a central kitchen order is received only through its transfer.
  if p_source_type = 'purchase_order' and exists (
       select 1 from purchase_orders po
         join suppliers s on s.id = po.supplier_id
         join stock_co_suppliers c on c.id = s.company_ref
        where po.id::text = p_source_id and c.internal_location_id is not null) then
    raise exception 'This order arrives as a transfer from the central kitchen. Receive it in Transfers.' using errcode = '55000';
  end if;
  if p_area_id is not null and not exists (select 1 from storage_areas a where a.id = p_area_id and a.location_id = p_location_id) then
    raise exception 'stock_receive: stock area % is not at venue %', p_area_id, p_location_id using errcode = '22023';
  end if;
  -- An invoice for an order that was received already: its stock is in, it stays paperwork.
  if p_source_type = 'supplier_invoice' and exists (
       select 1 from supplier_invoices si join purchase_orders po on po.id = si.po_id
        where si.id::text = p_source_id and si.location_id = p_location_id and po.status = 'RECEIVED') then
    return jsonb_build_object('ok', false, 'code', 'po_received',
      'error', 'This invoice belongs to an order that was received already, so its stock is in. It is kept as paperwork and nothing was counted twice.');
  end if;
  return public._stock_receive_lines(p_location_id, p_source_type, p_source_id, p_lines, p_area_id, p_notes);
end $function$;

CREATE OR REPLACE FUNCTION public.stock_record_waste(p_location_id uuid, p_event jsonb, p_lines jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid;
  v_kind text;
  v_item uuid;
  v_menu text;
  v_cost numeric;
  v_line record;
  v_res jsonb;
  v_posted integer := 0;
  v_no_recipe boolean;
  v_reason text;
  v_lines jsonb;
  v_linked boolean := false;
  v_tag text;
  v_limit numeric;
  v_cur text;
  v_pin text;
  v_staff_id uuid;
  v_staff_name text;
  v_note text;
  v_locked date;
  v_dated date;
begin
  if not public.stock_caller_reaches(p_location_id) then
    raise exception 'stock_record_waste: this session cannot record waste at venue %', p_location_id using errcode = '42501';
  end if;
  if p_event is null or jsonb_typeof(p_event) <> 'object' then
    raise exception 'stock_record_waste: the waste is missing' using errcode = '22023';
  end if;
  if p_lines is not null and jsonb_typeof(p_lines) = 'null' then
    p_lines := null;   -- a JSON null from the API is no lines, the same as SQL null
  end if;
  if p_lines is not null and jsonb_typeof(p_lines) <> 'array' then
    raise exception 'stock_record_waste: lines must be a list' using errcode = '22023';
  end if;
  v_id := coalesce(nullif(p_event ->> 'id', '')::uuid, gen_random_uuid());
  if exists (select 1 from waste_events w where w.id = v_id) then
    return jsonb_build_object('ok', true, 'duplicate', true, 'id', v_id);
  end if;
  v_kind := case when p_event ->> 'kind' = 'item' then 'item' else 'menu' end;
  v_menu := nullif(btrim(coalesce(p_event ->> 'menu_item_id', '')), '');
  v_reason := nullif(btrim(coalesce(p_event ->> 'reason', '')), '');
  if v_kind = 'menu' and v_menu is not null then
    v_linked := exists (select 1 from menu_item_recipes r where r.location_id = p_location_id and r.menu_item_id = v_menu);
  end if;
  if nullif(p_event ->> 'inventory_item_id', '') is not null then
    select i.id into v_item from inventory_items i
     where i.id = (p_event ->> 'inventory_item_id')::uuid and i.location_id = p_location_id;
    if v_item is null then
      raise exception 'stock_record_waste: stock item % is not at venue %', p_event ->> 'inventory_item_id', p_location_id using errcode = '22023';
    end if;
  end if;

  -- The lines: the screen's, or (a menu product with none sent) the recipe's, worked out here, or (a
  -- stock item with none sent) that item's own quantity: a stock item waste always takes it off.
  if v_kind = 'item' and (p_lines is null or jsonb_array_length(p_lines) = 0) then
    if v_item is null or coalesce(nullif(p_event ->> 'qty_base', '')::numeric, 0) <= 0 then
      raise exception 'stock_record_waste: a stock item waste needs the item and a quantity above 0' using errcode = '22023';
    end if;
    v_lines := jsonb_build_array(jsonb_build_object('item_id', v_item, 'qty_base', round((p_event ->> 'qty_base')::numeric, 4)));
  elsif p_lines is null and v_kind = 'menu' and v_menu is not null then
    select coalesce(jsonb_agg(jsonb_build_object('item_id', x.inventory_item_id, 'qty_base', round(x.qty_base, 4)) order by x.inventory_item_id), '[]'::jsonb)
      into v_lines
      from public.stock_explode(p_location_id,
             jsonb_build_array(jsonb_build_object('itemId', v_menu,
               'qty', coalesce(nullif(p_event ->> 'qty', '')::numeric, 1),
               'mods', case when jsonb_typeof(p_event -> 'mods') = 'array' then p_event -> 'mods' else '[]'::jsonb end)),
             coalesce(nullif(p_event ->> 'order_type', ''), 'dine-in')) x;
  else
    v_lines := coalesce(p_lines, '[]'::jsonb);
  end if;

  if exists (select 1 from jsonb_array_elements(v_lines) e
              where not exists (select 1 from inventory_items i
                                 where i.id = nullif(e ->> 'item_id', '')::uuid and i.location_id = p_location_id)) then
    raise exception 'stock_record_waste: a line names a stock item that is not at this venue' using errcode = '22023';
  end if;
  if v_kind = 'item' and (v_item is null
       or exists (select 1 from jsonb_array_elements(v_lines) e
                   where nullif(e ->> 'item_id', '')::uuid is distinct from v_item)) then
    raise exception 'stock_record_waste: a stock item waste takes off that one item only' using errcode = '22023';
  end if;

  -- PREVIEW (the till's "Comes off stock" box): the lines, their names, units and cost, nothing
  -- written and nothing locked. The till sends the product only and never reads the recipe book.
  if coalesce(p_event ->> 'preview', '') = 'true' then
    return jsonb_build_object('ok', true, 'preview', true, 'linked', v_linked,
      'lines', coalesce((select jsonb_agg(to_jsonb(x) order by x.name)
                           from (select i.id as item_id, i.name, i.base_unit,
                                        round(sum(nullif(e ->> 'qty_base', '')::numeric), 4) as qty_base,
                                        case when i.current_cost is null then null
                                             else round(sum(nullif(e ->> 'qty_base', '')::numeric) * i.current_cost, 4) end as cost
                                   from jsonb_array_elements(v_lines) e
                                   join inventory_items i on i.id = (e ->> 'item_id')::uuid and i.location_id = p_location_id
                                  where nullif(e ->> 'qty_base', '')::numeric > 0
                                  group by i.id, i.name, i.base_unit, i.current_cost) x), '[]'::jsonb),
      'cost_value', (select round(sum(nullif(e ->> 'qty_base', '')::numeric * coalesce(i.current_cost, 0)), 2)
                       from jsonb_array_elements(v_lines) e
                       join inventory_items i on i.id = (e ->> 'item_id')::uuid and i.location_id = p_location_id
                      where nullif(e ->> 'qty_base', '')::numeric > 0),
      'tag', case when jsonb_array_length(v_lines) > 0 then null when v_linked then 'nothing_to_deduct' else 'no_recipe' end);
  end if;

  -- LOCK ORDER 20261019b
  perform 1 from inventory_items
   where location_id = p_location_id
     and id in (select (e ->> 'item_id')::uuid from jsonb_array_elements(v_lines) e)
   order by id
   for no key update;

  select sum(round(nullif(e ->> 'qty_base', '')::numeric, 4) * coalesce(i.current_cost, 0)) into v_cost
    from jsonb_array_elements(v_lines) e
    join inventory_items i on i.id = (e ->> 'item_id')::uuid and i.location_id = p_location_id
   where nullif(e ->> 'qty_base', '')::numeric > 0;
  v_no_recipe := v_kind = 'menu' and v_cost is null;
  v_tag := case when not v_no_recipe then null when v_linked then 'nothing_to_deduct' else 'no_recipe' end;

  -- DROP 3 20261027a (J5): over the site's limit (else the company's; null = no limit) the waste needs a
  -- manager PIN at this venue (the count PIN rule, 5 tries in 15 minutes). The phone (service role) has
  -- proven the PIN itself and names the staff member. Nothing is written on a refusal but the try.
  select coalesce(ss.waste_pin_over_value, cs.waste_pin_over_value), l.currency into v_limit, v_cur
    from locations l
    left join stock_co_site_settings ss on ss.location_id = l.id
    left join stock_co_settings cs on cs.org_id = l.org_id
   where l.id = p_location_id;
  if v_limit is not null and round(coalesce(v_cost, 0), 2) > v_limit then
    if public.stock_co__is_service() and coalesce(p_event ->> 'approved_by_staff_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select s.id, s.name into v_staff_id, v_staff_name from staff_members s
       where s.id = (p_event ->> 'approved_by_staff_id')::uuid and s.location_id = p_location_id and coalesce(s.active, true);
      if v_staff_id is null then
        return jsonb_build_object('ok', false, 'pin', 'wrong', 'error', 'That PIN is not a manager at this venue.');
      end if;
      v_staff_name := coalesce(nullif(btrim(coalesce(p_event ->> 'approved_by_staff_name', '')), ''), v_staff_name);
    else
      v_pin := btrim(coalesce(p_event ->> 'pin', ''));
      if v_pin = '' then
        return jsonb_build_object('ok', false, 'pin', 'needed', 'error', 'Over ' || public.stock_co__money(v_cur, v_limit) || ' needs a manager PIN.',
                                  'limit', v_limit);
      end if;
      if (select count(*) from stock_pin_tries t
           where t.location_id = p_location_id and t.user_id is not distinct from auth.uid()
             and t.tried_at > now() - interval '15 minutes') >= 5 then
        return jsonb_build_object('ok', false, 'pin', 'locked', 'error', 'Too many wrong PINs. Wait 15 minutes, then try again.');
      end if;
      select s.id, s.name into v_staff_id, v_staff_name
        from staff_members s
       where s.location_id = p_location_id and s.pin = v_pin and s.pin <> '' and coalesce(s.active, true)
         and (lower(coalesce(s.role, '')) in ('manager', 'owner')
              or (jsonb_typeof(s.permissions) = 'array' and s.permissions ? 'manager_approvals'))
       order by s.created_at, s.id
       limit 1;
      if v_staff_id is null then
        insert into stock_pin_tries (user_id, location_id) values (auth.uid(), p_location_id);
        return jsonb_build_object('ok', false, 'pin', 'wrong', 'error', 'That PIN is not a manager at this venue.');
      end if;
    end if;
  end if;
  -- DROP 3 20261027a: a back dated waste inside a locked period is booked now, with the real day in the note.
  v_note := nullif(p_event ->> 'note', '');
  if nullif(p_event ->> 'occurred_at', '') is not null then
    v_locked := public.stock_co__locked_until(p_location_id);
    if v_locked is not null then
      v_dated := public.stock_co__vday(p_location_id, (p_event ->> 'occurred_at')::timestamptz);
    end if;
    if v_locked is not null and v_dated <= v_locked then
      v_note := btrim(coalesce(v_note, '') || ' (dated ' || to_char(v_dated, 'FMDD Mon YYYY') || ', period locked)');
    end if;
  end if;

  insert into waste_events (id, location_id, inventory_item_id, item_name, qty, unit, qty_base, reason, note,
      cost_value, sale_value, source, occurred_at, menu_item_id, no_recipe, approved_by_staff_id, approved_by_staff_name)
    values (v_id, p_location_id, v_item, nullif(p_event ->> 'item_name', ''),
      coalesce(nullif(p_event ->> 'qty', '')::numeric, 1), coalesce(nullif(p_event ->> 'unit', ''), 'item'),
      nullif(p_event ->> 'qty_base', '')::numeric, v_reason, v_note,
      round(v_cost, 2), round(nullif(p_event ->> 'sale_value', '')::numeric, 2),
      coalesce(nullif(p_event ->> 'source', ''), 'backoffice'), now(), v_menu, v_no_recipe, v_staff_id, v_staff_name);

  for v_line in
    select (e ->> 'item_id')::uuid as item_id, sum(round(nullif(e ->> 'qty_base', '')::numeric, 4)) as qty
      from jsonb_array_elements(v_lines) e
     where nullif(e ->> 'qty_base', '')::numeric > 0
     group by 1
     order by 1
  loop
    v_res := public._post_stock_movement(p_location_id, v_line.item_id, -v_line.qty, 'WASTE', null, 'waste', v_id::text,
      case when v_kind = 'item' then 'waste:' || v_id::text else 'waste:' || v_id::text || ':' || v_line.item_id::text end,
      null, null, coalesce(v_reason, 'waste'), null);
    v_posted := v_posted + 1;
  end loop;
  return jsonb_build_object('ok', true, 'duplicate', false, 'id', v_id, 'posted', v_posted,
    'cost_value', round(v_cost, 2), 'no_recipe', v_no_recipe, 'tag', v_tag, 'linked', v_linked);
end $function$;

CREATE OR REPLACE FUNCTION public.stock_approve_count_pin(p_count_id uuid, p_pin text, p_approved_by_name text DEFAULT NULL::text, p_approval_note text DEFAULT NULL::text, p_costs jsonb DEFAULT NULL::jsonb, p_preview boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_loc         uuid;
  v_pin         text := btrim(coalesce(p_pin, ''));
  v_staff_id    uuid;
  v_staff_name  text;
  v_costs       jsonb;
  v_res         jsonb;
  v_c           stock_counts;
  v_org         uuid;
  v_cur         text;
  v_limit       numeric;
  v_locked      date;
  v_first_day   date;
  v_prev        jsonb;
  v_zero        boolean;
begin
  select c.location_id into v_loc from stock_counts c where c.id = p_count_id;
  if v_loc is null or not public.stock_office_reaches(v_loc) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_costs := public.stock_opening_costs(p_count_id)
             || case when jsonb_typeof(p_costs) = 'object' then p_costs else '{}'::jsonb end;
  if coalesce(p_preview, false) then
    return public.approve_stock_count(p_count_id, p_approved_by_name, p_approval_note, v_costs, true);
  end if;
  -- DROP 3 20261027a: a count inside a locked period is refused (the preview above still works).
  select * into v_c from stock_counts c where c.id = p_count_id;
  select l.org_id, l.currency into v_org, v_cur from locations l where l.id = v_loc;
  v_locked := public.stock_co__locked_until(v_loc);
  if v_locked is not null and v_c.status not in ('APPROVED', 'CANCELLED') then
    select min(public.stock_co__vday(v_loc, coalesce(cl.counted_at, v_c.started_at, v_c.created_at))) into v_first_day
      from stock_count_lines cl where cl.count_id = p_count_id and cl.counted_qty is not null;
    if v_first_day is not null and v_first_day <= v_locked then
      raise exception 'That count is in a locked period (to %). Ask head office to unlock it.', to_char(v_locked, 'FMDD Mon')
        using errcode = '55000';
    end if;
  end if;
  if v_pin = '' then
    return jsonb_build_object('ok', false, 'error', 'Type the manager PIN first.', 'pin', 'missing');
  end if;
  if (select count(*) from stock_pin_tries t
       where t.location_id = v_loc and t.user_id is not distinct from auth.uid()
         and t.tried_at > now() - interval '15 minutes') >= 5 then
    return jsonb_build_object('ok', false, 'error', 'Too many wrong PINs. Wait 15 minutes, then try again.', 'pin', 'locked');
  end if;
  select s.id, s.name into v_staff_id, v_staff_name
    from staff_members s
   where s.location_id = v_loc and s.pin = v_pin and s.pin <> '' and coalesce(s.active, true)
     and (lower(coalesce(s.role, '')) in ('manager', 'owner')
          or (jsonb_typeof(s.permissions) = 'array' and s.permissions ? 'manager_approvals'))
   order by s.created_at, s.id
   limit 1;
  if v_staff_id is null then
    insert into stock_pin_tries (user_id, location_id) values (auth.uid(), v_loc);
    return jsonb_build_object('ok', false, 'error', 'That PIN is not a manager at this venue.', 'pin', 'wrong');
  end if;
  -- DROP 3 20261027a (a): the plan says what an uncounted line is; 'zero' fills 0 now that a person pressed
  -- Approve with a manager PIN ('estimate' keeps today's skip).
  if v_c.status not in ('APPROVED', 'CANCELLED') and v_c.second_approval_needed_at is null then
    select coalesce(cp.if_not_counted = 'zero', false) into v_zero from stock_count_plans cp where cp.id = v_c.plan_id;
    if coalesce(v_zero, false) then
      update stock_count_lines cl set counted_qty = 0, counted_at = now()
       where cl.count_id = p_count_id and cl.location_id = v_loc and cl.counted_qty is null;
    end if;
  end if;
  -- DROP 3 20261027a (b, I7): over the site's limit (else the company's) a second person approves.
  select coalesce(ss.count_second_approval_over, cs.count_second_approval_over) into v_limit
    from locations l
    left join stock_co_site_settings ss on ss.location_id = l.id
    left join stock_co_settings cs on cs.org_id = l.org_id
   where l.id = v_loc;
  if v_limit is not null and v_c.status not in ('APPROVED', 'CANCELLED') and v_c.second_approved_at is null then
    v_prev := public.approve_stock_count(p_count_id, null, null, v_costs, true);
    if coalesce((v_prev ->> 'ok')::boolean, false) and abs(coalesce((v_prev ->> 'variance_value')::numeric, 0)) > v_limit then
      if v_c.second_approval_needed_at is null then
        update stock_counts
           set second_approval_needed_at = now(), first_approved_by = auth.uid(),
               first_approved_by_name = coalesce(nullif(btrim(p_approved_by_name), ''), v_staff_name),
               first_approved_by_staff_id = v_staff_id
         where id = p_count_id;
        perform public.stock_co__notify(v_org, v_loc, 'count_second_approval', p_count_id::text,
          jsonb_build_object('title', 'Count waiting for a second approval',
                             'body', coalesce(v_c.name, 'A count') || ': ' || public.stock_co__money(v_cur, abs((v_prev ->> 'variance_value')::numeric)),
                             'route', 'stock-counts', 'focus', p_count_id, 'variance_value', (v_prev ->> 'variance_value')::numeric));
      end if;
      return jsonb_build_object('ok', false, 'waiting', 'second_approval',
        'error', 'Over ' || public.stock_co__money(v_cur, v_limit) || '. Waiting for a second approval.',
        'variance_value', (v_prev ->> 'variance_value')::numeric, 'limit', v_limit);
    end if;
  end if;
  v_res := public.approve_stock_count(p_count_id, coalesce(nullif(btrim(p_approved_by_name), ''), v_staff_name),
                                      p_approval_note, v_costs, false);
  if coalesce((v_res ->> 'ok')::boolean, false) and not coalesce((v_res ->> 'duplicate')::boolean, false) then
    update stock_counts
       set approved_by_staff_id = v_staff_id, approved_by_staff_name = v_staff_name
     where id = p_count_id;
  end if;
  return v_res || jsonb_build_object('approved_by_pin', v_staff_name);
end
$function$;

CREATE OR REPLACE FUNCTION public.post_stock_transfer_leg(p_transfer_id uuid, p_leg text, p_by_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_t record;
  v_l record;
  v_mine boolean;
  v_lines integer := 0;
  v_short_lines integer := 0;
  v_cost numeric;
  v_qty numeric;
  v_area uuid;
  v_item record;
  v_before numeric;
  v_new_avg numeric;
  v_res jsonb;
  v_factor numeric;
  v_from_unit text;
  v_to_unit text;
  v_sent_recv numeric;
  v_short numeric;
  v_bad text;
  v_out_id uuid;
  v_reset boolean;
  v_pl record;
  v_left numeric;
  v_pack_base numeric;
  v_got jsonb := '[]'::jsonb;
begin
  -- DROP 3 20261027a: legs 'refuse' (a request), 'dispute' and 'resolve' (paperwork; none moves stock).
  if p_leg not in ('out', 'in', 'both', 'cancel', 'refuse', 'dispute', 'resolve') then
    raise exception 'post_stock_transfer_leg: leg must be out, in, both or cancel (got %)', coalesce(p_leg, 'null');
  end if;

  select * into v_t from stock_transfers where id = p_transfer_id for no key update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Transfer not found');
  end if;

  -- Who is asking (FENCE 20261018a): the same rule as post_stock_movement. The receiving leg
  -- belongs to the receiving venue; every other leg to the sending venue.
  if p_leg in ('in', 'dispute') then
    v_mine := v_t.to_location_id is not null and public.stock_caller_reaches(v_t.to_location_id);
  else
    v_mine := public.stock_caller_reaches(v_t.location_id);
  end if;
  if not coalesce(v_mine, false) then
    return jsonb_build_object('ok', false, 'error', 'This transfer belongs to a venue you cannot open');
  end if;

  -- DROP 3 20261027a: the paperwork legs.
  if p_leg = 'refuse' then
    if v_t.status = 'CANCELLED' then
      return jsonb_build_object('ok', true, 'duplicate', true, 'status', v_t.status);
    end if;
    if v_t.status <> 'REQUESTED' then
      return jsonb_build_object('ok', false, 'error', 'Only a request can be refused.');
    end if;
    update stock_transfers set status = 'CANCELLED', cancelled_by_name = p_by_name, cancelled_at = now(), updated_at = now()
     where id = p_transfer_id;
    return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'CANCELLED', 'lines', 0);
  end if;
  if p_leg = 'dispute' then
    if v_t.status = 'DISPUTED' then
      return jsonb_build_object('ok', true, 'duplicate', true, 'status', v_t.status);
    end if;
    if v_t.status not in ('RECEIVED', 'DONE') then
      return jsonb_build_object('ok', false, 'error', 'Only a received transfer can be disputed.');
    end if;
    update stock_transfers set status = 'DISPUTED', disputed_at = now(), updated_at = now() where id = p_transfer_id;
    return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'DISPUTED', 'lines', 0);
  end if;
  if p_leg = 'resolve' then
    if v_t.status <> 'DISPUTED' then
      return jsonb_build_object('ok', true, 'duplicate', true, 'status', v_t.status);
    end if;
    update stock_transfers set status = 'RECEIVED', resolved_at = now(), resolved_by_name = p_by_name, updated_at = now()
     where id = p_transfer_id;
    return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'RECEIVED', 'lines', 0);
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
      -- LOCK ORDER 20261019b
      perform 1 from inventory_items
       where location_id = v_t.location_id
         and id in (select l.inventory_item_id from stock_transfer_lines l where l.transfer_id = p_transfer_id and not l.dropped)
       order by id for no key update;
      for v_l in
        select * from stock_transfer_lines where transfer_id = p_transfer_id and not dropped order by case when p_leg = 'in' then to_inventory_item_id else inventory_item_id end, sort_order, id
      loop
        if coalesce(v_l.qty_base, 0) <= 0 then continue; end if;
        perform public._post_stock_movement(v_t.location_id, v_l.inventory_item_id, v_l.qty_base, 'TRANSFER_IN',
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
    -- LOCK ORDER 20261019b
    perform 1 from inventory_items
     where location_id = v_t.location_id
       and id in (select l.inventory_item_id from stock_transfer_lines l where l.transfer_id = p_transfer_id and not l.dropped)
     order by id for no key update;
    for v_l in
      select * from stock_transfer_lines where transfer_id = p_transfer_id and not dropped order by case when p_leg = 'in' then to_inventory_item_id else inventory_item_id end, sort_order, id
    loop
      if coalesce(v_l.qty_base, 0) <= 0 then continue; end if;
      v_cost := coalesce((select current_cost from inventory_items where id = v_l.inventory_item_id), 0);
      update stock_transfer_lines set unit_cost = v_cost,
             base_unit = coalesce(base_unit, (select i.base_unit from inventory_items i where i.id = v_l.inventory_item_id))
       where id = v_l.id;
      perform public._post_stock_movement(v_t.location_id, v_l.inventory_item_id, -v_l.qty_base, 'TRANSFER_OUT',
        v_cost, 'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':out',
        now(), null, 'Transfer ' || coalesce(v_t.reference, ''), v_t.from_area_id);
      if p_leg = 'both' then
        perform public._post_stock_movement(v_t.location_id, v_l.inventory_item_id, v_l.qty_base, 'TRANSFER_IN',
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
  -- UNITS 20261019b: every matched line must convert from the sender's unit to the receiver's.
  select string_agg(coalesce(l.name_snapshot, 'A line') || ' (' || coalesce(l.base_unit, s.base_unit) || ' to ' || r.base_unit || ')', ', ')
    into v_bad
    from stock_transfer_lines l
    join inventory_items s on s.id = l.inventory_item_id
    join inventory_items r on r.id = l.to_inventory_item_id
   where l.transfer_id = p_transfer_id and not l.dropped
     and public.stock_convert_qty(1, coalesce(l.base_unit, s.base_unit), r.base_unit, array[l.to_inventory_item_id, l.inventory_item_id]) is null;
  if v_bad is not null then
    return jsonb_build_object('ok', false, 'error', 'These units cannot be converted, so nothing was received: ' || v_bad || '. Add a unit bridge on your item, or drop the line.');
  end if;

  -- LOCK ORDER 20261019b: both venues' items, one id order.
  perform 1 from inventory_items
   where id in (select l.inventory_item_id from stock_transfer_lines l where l.transfer_id = p_transfer_id
                union
                select l.to_inventory_item_id from stock_transfer_lines l where l.transfer_id = p_transfer_id and not l.dropped)
   order by id for no key update;

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
    select * from stock_transfer_lines where transfer_id = p_transfer_id order by case when p_leg = 'in' then to_inventory_item_id else inventory_item_id end, sort_order, id
  loop
    if coalesce(v_l.qty_base, 0) <= 0 then continue; end if;
    v_cost := coalesce(v_l.unit_cost, (select current_cost from inventory_items where id = v_l.inventory_item_id), 0);
    v_short := 0;
    if v_l.dropped then
      v_short := v_l.qty_base;
    else
      select id, on_hand, current_cost, cost_method, base_unit into v_item from inventory_items
        where id = v_l.to_inventory_item_id and location_id = v_t.to_location_id;
      if not found then
        -- checked before the loop; a raise rolls the whole leg back
        raise exception 'post_stock_transfer_leg: matched item % is not at venue %', v_l.to_inventory_item_id, v_t.to_location_id;
      end if;
      v_from_unit := coalesce(v_l.base_unit, (select i.base_unit from inventory_items i where i.id = v_l.inventory_item_id));
      v_to_unit := v_item.base_unit;
      v_factor := public.stock_convert_qty(1, v_from_unit, v_to_unit, array[v_l.to_inventory_item_id, v_l.inventory_item_id]);
      if v_factor is null or v_factor <= 0 then
        raise exception 'post_stock_transfer_leg: % cannot be converted to %', v_from_unit, v_to_unit;
      end if;
      -- What arrived, in the receiver's unit, never more than was sent: rounded DOWN to the 4
      -- decimals the receiver holds (rounding to the nearest could land more than left the sender).
      v_qty := trunc(least(coalesce(v_l.qty_received_base, v_l.qty_base * v_factor), v_l.qty_base * v_factor), 4);
      if v_qty < 0 then v_qty := 0; end if;
      v_sent_recv := v_qty / v_factor;
      -- What did not arrive, in the sender's unit. A remainder under half a 4th decimal step of the
      -- coarser of the two units is rounding, not a loss: no Short on transfer for it.
      v_short := greatest(0, v_l.qty_base - v_sent_recv);
      if v_short < 0.00005 * greatest(1, 1 / v_factor) then
        v_short := 0;
      else
        v_short := round(v_short, 4);
      end if;
      if v_qty > 0 then
        v_before := coalesce(v_item.on_hand, 0);
        v_res := public._post_stock_movement(v_t.to_location_id, v_l.to_inventory_item_id, v_qty, 'TRANSFER_IN',
          v_cost / v_factor, 'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':in',
          now(), null, 'Transfer ' || coalesce(v_t.reference, ''), v_area);
        -- The receiver's cost moves the way a delivery moves it: moving average, or the last cost
        -- replaces; stock at or below zero, or an unknown cost, takes the transfer cost. A zero cost
        -- never re-costs the item.
        if coalesce((v_res ->> 'duplicate')::boolean, false) = false and v_cost > 0 then
          if coalesce(v_item.cost_method, 'MOVING_AVG') = 'LAST_COST' or v_before <= 0
             or v_item.current_cost is null or v_item.current_cost <= 0 then
            v_new_avg := v_cost / v_factor;
            v_reset := true;
          else
            v_new_avg := (v_before * v_item.current_cost + v_qty * (v_cost / v_factor)) / (v_before + v_qty);
            v_reset := false;
          end if;
          v_new_avg := round(v_new_avg, 8);
          update item_cost_history set effective_to = now()
            where location_id = v_t.to_location_id and inventory_item_id = v_l.to_inventory_item_id and effective_to is null;
          insert into item_cost_history (location_id, inventory_item_id, base_unit_cost, moving_avg_cost, source, source_doc_id, effective_from)
            values (v_t.to_location_id, v_l.to_inventory_item_id, v_new_avg, v_new_avg, 'TRANSFER', v_t.id, now());
          update inventory_items set current_cost = v_new_avg, updated_at = now()
            where id = v_l.to_inventory_item_id and location_id = v_t.to_location_id;
          -- REVALUE 20261021a: in the reset branch only, the receiver's stock already held moves to the new cost.
          if v_reset then
            perform public._stock_revalue(v_t.to_location_id, v_l.to_inventory_item_id, v_before, v_item.current_cost, v_new_avg,
              'stock_transfer', 'revalue:transfer:' || v_l.id::text, p_transfer_id::text);
          end if;
        end if;
      end if;
      -- DROP 3 20261027a: a kitchen transfer keeps the price the site paid (set at pick) as to_unit_cost;
      -- the stock itself moves at the kitchen's cost, so value is conserved.
      update stock_transfer_lines set qty_received_base = v_qty, to_base_unit = v_to_unit,
             to_unit_cost = case when v_t.purchase_order_id is not null and v_l.to_unit_cost is not null then v_l.to_unit_cost
                                 else round(v_cost / v_factor, 8) end
       where id = v_l.id;
      v_got := v_got || jsonb_build_array(jsonb_build_object('line_id', v_l.id, 'to_inventory_item_id', v_l.to_inventory_item_id,
                 'qty', v_qty, 'lot_code', v_l.lot_code, 'use_by_at', v_l.use_by_at));
      v_lines := v_lines + 1;
    end if;

    -- SHORT ON TRANSFER 20261019b: booked at the sender (only for stock that did leave it).
    v_out_id := null;
    if v_short > 0 then
      select m.id into v_out_id from stock_movements m
       where m.location_id = v_t.location_id
         and m.idempotency_key = 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':out';
      if v_out_id is null then v_short := 0; end if;
    end if;
    if v_short > 0 then
      v_res := public._post_stock_movement(v_t.location_id, v_l.inventory_item_id, v_short, 'TRANSFER_OUT',
        v_cost, 'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':short-back',
        now(), null, 'Transfer ' || coalesce(v_t.reference, '') || ': not received, back on the books to be written off', v_t.from_area_id);
      if v_res ->> 'id' is not null then
        update stock_movements set reversal_of = v_out_id where id = (v_res ->> 'id')::uuid;
      end if;
      perform public._post_stock_movement(v_t.location_id, v_l.inventory_item_id, -v_short, 'WASTE',
        v_cost, 'stock_transfer', v_t.id::text, 'transfer:' || v_t.id::text || ':' || v_l.id::text || ':short',
        now(), null, 'Short on transfer ' || coalesce(v_t.reference, ''), v_t.from_area_id);
      insert into waste_events (location_id, inventory_item_id, item_name, qty, unit, qty_base, reason, note, cost_value, source, occurred_at)
        values (v_t.location_id, v_l.inventory_item_id,
          coalesce(v_l.name_snapshot, (select i.name from inventory_items i where i.id = v_l.inventory_item_id)),
          v_short, coalesce(v_l.base_unit, 'each'), v_short, 'Short on transfer',
          'Transfer ' || coalesce(v_t.reference, '') || case when v_l.dropped then ': line dropped at the receiving venue'
            else ': sent ' || round(v_l.qty_base, 4)::text || ', received ' || round(v_l.qty_base - v_short, 4)::text end,
          round(v_short * v_cost, 2), 'transfer', now());
      update stock_transfer_lines set short_qty_base = v_short where id = v_l.id;
      v_short_lines := v_short_lines + 1;
    end if;
  end loop;
  update stock_transfers set status = 'RECEIVED', received_by_name = p_by_name, received_at = now(), updated_at = now()
    where id = p_transfer_id;
  -- DROP 3 20261027a: a kitchen order closes with its transfer, in this transaction: each order line's
  -- received packs from the transfer lines received, then the order RECEIVED (through the pass).
  if v_t.purchase_order_id is not null then
    perform set_config('servos.stock_po_send', txid_current()::text, true);
    for v_l in
      select l.to_inventory_item_id as item_id, sum(coalesce(l.qty_received_base, 0)) as got
        from stock_transfer_lines l where l.transfer_id = p_transfer_id and not l.dropped and l.to_inventory_item_id is not null
       group by 1 order by 1
    loop
      v_left := v_l.got;
      for v_pl in
        select pl.id, pl.qty_packs, pl.pack_qty, pl.inner_qty, pl.inner_unit, pl.inventory_item_id
          from po_lines pl where pl.po_id = v_t.purchase_order_id and pl.inventory_item_id = v_l.item_id
         order by pl.sort_order, pl.id
      loop
        v_pack_base := coalesce(public.stock_qty_to_base(coalesce(v_pl.pack_qty, 1) * coalesce(v_pl.inner_qty, 1), v_pl.inner_unit, v_pl.inventory_item_id),
                                coalesce(v_pl.pack_qty, 1) * coalesce(v_pl.inner_qty, 1));
        if v_pack_base is null or v_pack_base <= 0 then v_pack_base := 1; end if;
        update po_lines set qty_received = round(least(coalesce(v_pl.qty_packs, 0) * v_pack_base, v_left) / v_pack_base, 3)
         where id = v_pl.id;
        v_left := greatest(0, v_left - least(coalesce(v_pl.qty_packs, 0) * v_pack_base, v_left));
      end loop;
    end loop;
    update purchase_orders set status = 'RECEIVED', received_at = now(), updated_at = now()
     where id = v_t.purchase_order_id and status <> 'RECEIVED';
  end if;
  return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'RECEIVED', 'lines', v_lines, 'short_lines', v_short_lines,
                            'received_lines', v_got);
end $function$;

CREATE OR REPLACE FUNCTION public.stock_needs_attention(p_org uuid, p_sites uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_scope uuid[];
  v_alerts jsonb;
begin
  if p_sites is not null and cardinality(p_sites) > 50 then
    raise exception 'Pick 50 sites or fewer.' using errcode = '22023';
  end if;
  v_scope := public.stock_co__read_scope(p_org, p_sites);
  if cardinality(v_scope) > 50 then
    raise exception 'Pick 50 sites or fewer.' using errcode = '22023';
  end if;
  -- DROP 3 20261027a: the alert rows of a multi site company, at most 50 a kind, in their own key
  if public.stock_co__multi(p_org) then
    with a as (
      select 'approvals_waiting' as kind, x.location_id, (count(*)::text || ' orders waiting for approval') as words, count(*) as n,
             'purchase-orders' as route, null::jsonb as focus
        from stock_po_approvals x where x.location_id = any(v_scope) and x.status = 'waiting' group by x.location_id
      union all
      (select 'missed_cutoff', s.location_id, l.name || ' missed the order by time for ' || s.name, 1, 'due-to-order',
              jsonb_build_object('supplier_id', s.id)
         from suppliers s join locations l on l.id = s.location_id
        where s.location_id = any(v_scope) and s.archived_at is null
          and exists (select 1 from stock_order_rules o where o.supplier_id = s.id and o.order_by_time is not null
                         and o.order_by_dow = extract(dow from (now() at time zone public.stock_co__tz(s.location_id)))
                         and o.order_by_time <= (now() at time zone public.stock_co__tz(s.location_id))::time)
          and not exists (select 1 from purchase_orders po where po.supplier_id = s.id and po.location_id = s.location_id
                             and public.stock_co__vday(s.location_id, po.created_at) = public.stock_co__today(s.location_id))
          and not exists (select 1 from stock_standing_orders so where so.supplier_id = s.id and so.active)
        order by l.name, s.name limit 50)
      union all
      select 'deliveries_overdue', po.location_id, count(*)::text || ' deliveries overdue', count(*), 'stock-deliveries', null
        from purchase_orders po where po.location_id = any(v_scope) and po.status in ('SENT', 'PARTIAL')
         and po.expected_date < public.stock_co__today(po.location_id) group by po.location_id
      union all
      (select case when e ->> 'status' = 'missed' then 'count_missed' else 'count_due' end, (e ->> 'location_id')::uuid,
              case when e ->> 'status' = 'missed' then 'Count missed' else 'Count due today' end, 1, 'stock-counts',
              jsonb_build_object('plan_id', e ->> 'plan_id')
         from jsonb_array_elements(public.stock_co__count_due_rows(p_org, v_scope, null)) e
        where e ->> 'status' in ('due', 'missed') limit 50)
      union all
      (select 'count_missed', (e ->> 'location_id')::uuid, 'Count missed', 1, 'stock-counts', jsonb_build_object('plan_id', e ->> 'plan_id')
         from (select l.id from locations l where l.id = any(v_scope)) z
         cross join lateral jsonb_array_elements(public.stock_co__count_due_rows(p_org, array[z.id], public.stock_co__today(z.id) - 1)) e
        where e ->> 'status' = 'missed' limit 50)
      union all
      select 'counts_second_approval', c.location_id, count(*)::text || ' counts waiting for a second approval', count(*), 'stock-counts', null
        from stock_counts c where c.location_id = any(v_scope) and c.second_approval_needed_at is not null
         and c.status not in ('APPROVED', 'CANCELLED') group by c.location_id
      union all
      select 'transfers_waiting', t.to_location_id, count(*)::text || ' transfers waiting to be received', count(*), 'stock-transfers', null
        from stock_transfers t where t.to_location_id = any(v_scope) and t.status = 'SENT' group by t.to_location_id
      union all
      select 'invoices_unplaced', null::uuid, count(*)::text || ' invoices need a site', count(*), 'invoices', jsonb_build_object('tab', 'inbox')
        from stock_invoice_inbox b where b.org_id = p_org and b.status = 'waiting' having count(*) > 0
      union all
      (select 'price_rise', ns.location_id, coalesce(ns.payload ->> 'body', 'A price rose') || ' at ' || l.name, 1, 'price-changes',
              ns.payload -> 'focus'
         from stock_notify_sent ns join locations l on l.id = ns.location_id
        where ns.org_id = p_org and ns.kind = 'price_rise' and ns.location_id = any(v_scope) and ns.created_at > now() - interval '7 days'
        order by ns.created_at desc limit 50)
    )
    select coalesce(jsonb_agg(jsonb_build_object('kind', a.kind, 'location_id', a.location_id, 'words', a.words, 'count', a.n,
                                                 'route', a.route, 'focus', a.focus) order by a.kind, a.location_id), '[]'::jsonb)
      into v_alerts
      from a;
  end if;
  -- one pass per figure over every site in scope (set based, so 50 sites by 5,000 items stays well inside 8 s)
  return jsonb_build_object('rows', (
    with bz as (
      select t.location_id as loc, count(*) as n from inventory_items t
       where t.location_id = any(v_scope) and t.archived_at is null and t.on_hand < 0
       group by 1
    ), np as (
      select s.location_id as loc, count(*) as n
        from stock_co_item_sites s
        join inventory_items t on t.id = s.site_item_id
       where s.location_id = any(v_scope) and s.on_here and s.supply_mode = 'bought' and t.archived_at is null
         and not exists (select 1 from supplier_products sp
                          where sp.location_id = s.location_id and sp.inventory_item_id = t.id and sp.archived_at is null)
       group by 1
    ), cr as (
      select c.location_id as loc, count(*) as n from stock_counts c
       where c.location_id = any(v_scope) and c.status not in ('APPROVED', 'CANCELLED')
         and exists (select 1 from stock_count_areas a where a.count_id = c.id)
         and not exists (select 1 from stock_count_areas a where a.count_id = c.id and a.completed_at is null)
       group by 1
    ), od as (
      select po.location_id as loc, count(*) as n from purchase_orders po
       where po.location_id = any(v_scope) and po.status in ('SENT', 'PARTIAL') and po.expected_date < public.stock_co__today(po.location_id)
       group by 1
    ), br as (
      select pl.location_id as loc, count(*) as n from par_levels pl join inventory_items t on t.id = pl.inventory_item_id
       where pl.location_id = any(v_scope) and t.location_id = pl.location_id and t.archived_at is null
         and pl.reorder_point is not null and t.on_hand < pl.reorder_point
       group by 1
    ), qf as (
      select q.location_id as loc, count(*) as n from stock_save_queue q
       where q.location_id = any(v_scope) and q.status = 'failed' and q.done_at > now() - interval '7 days'
       group by 1
    ), go as (
      select g.location_id as loc, count(*) as n from stock_co_golive_steps g
       where g.location_id = any(v_scope) and g.done_at is null
       group by 1
    )
    select coalesce(jsonb_agg(jsonb_build_object(
             'location_id', l.id, 'name', l.name,
             'below_zero', coalesce(bz.n, 0), 'no_price', coalesce(np.n, 0), 'counts_ready', coalesce(cr.n, 0),
             'orders_overdue', coalesce(od.n, 0), 'below_reorder', coalesce(br.n, 0), 'queue_failed', coalesce(qf.n, 0),
             'golive_open', coalesce(go.n, 0),
             'health', (select jsonb_build_object('checked_at', h.checked_at, 'planned_writes', h.planned_writes,
                                                  'recipe_planned_writes', h.recipe_planned_writes, 'lines', h.lines)
                          from stock_co_site_health h where h.location_id = l.id))
             order by array_position(v_scope, l.id)), '[]'::jsonb)
      from locations l
      left join bz on bz.loc = l.id
      left join np on np.loc = l.id
      left join cr on cr.loc = l.id
      left join od on od.loc = l.id
      left join br on br.loc = l.id
      left join qf on qf.loc = l.id
      left join go on go.loc = l.id
     where l.id = any(v_scope))) || case when v_alerts is null then '{}'::jsonb else jsonb_build_object('alerts', v_alerts) end;
end
$function$;

CREATE OR REPLACE FUNCTION public.stock_save_recipe(p_recipe jsonb, p_lines jsonb, p_version integer DEFAULT NULL::integer, p_section text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_t0 timestamptz := clock_timestamp();
  v_d jsonb;
  v_section text;
  v_id uuid;
  v_loc uuid;
  v_sid uuid;
  v_srv integer;
  v_rv integer;
  v_org uuid;
  v_g jsonb;
  v_old stock_co_recipes;
  v_new stock_co_recipes;
  v_co jsonb;
  v_out uuid;
  v_site_out uuid;
  v_lines jsonb := '[]'::jsonb;
  v_old_lines jsonb;
  v_line jsonb;
  v_ln jsonb;
  v_comp uuid;
  v_site_comp uuid;
  v_u text;
  v_unit text;
  v_site_unit text;
  v_pack uuid;
  v_n integer := 0;
  v_menu text;
  v_linked boolean := false;
  v_cost jsonb;
  v_c jsonb;
  v_before_cost numeric;
  v_log bigint;
  v_run jsonb;
  v_src text := case when p_version is null then 'save_unversioned' else 'save' end;
  v_row recipes;
  v_q integer;
  v_sites uuid[];
  v_sites_in jsonb;
  v_e jsonb;
  v_s uuid;
  v_on jsonb;
  v_sites_out jsonb := '[]'::jsonb;
  v_facts integer := 0;
  v_fr jsonb;
  v_kind_new text;
begin
  -- DROP 3 20261027a: Kitchen only is set on the recipe page (stock_set_recipe_restricted), never here.
  if p_recipe ? 'restricted' then
    raise exception 'Set Kitchen only on the recipe page.' using errcode = '22023';
  end if;
  v_d := public.stock_co__clean('recipe', p_recipe);
  if (v_d ? 'id' and v_d ? 'site_recipe_id') or (v_d ? 'output_item_id' and v_d ? 'site_output_item_id') then
    raise exception 'Send the company id or the site id of a field, not both.' using errcode = '22023';
  end if;
  if p_lines is not null and jsonb_typeof(p_lines) not in ('array', 'null') then
    raise exception 'The recipe lines must be a list.' using errcode = '22023';
  end if;
  v_loc := (v_d ->> 'location_id')::uuid;
  v_sid := (v_d ->> 'site_recipe_id')::uuid;
  -- the sites of a new company recipe (Drop 2)
  if v_d ? 'sites' and jsonb_typeof(v_d -> 'sites') <> 'null' then
    v_sites_in := v_d -> 'sites';
    v_d := v_d - 'sites';
    if v_d ? 'id' or v_sid is not null then
      raise exception 'Tick sites on the Sites tab.' using errcode = '22023';
    end if;
    if jsonb_typeof(v_sites_in) <> 'array' then
      raise exception 'The field "sites" must be a list.' using errcode = '22023';
    end if;
    for v_e in select e.value from jsonb_array_elements(v_sites_in) e loop
      if jsonb_typeof(v_e) <> 'object' or coalesce(v_e ->> 'location_id', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'Each site needs its location_id.' using errcode = '22023';
      end if;
      continue when jsonb_typeof(v_e -> 'on') = 'boolean' and not (v_e ->> 'on')::boolean;
      v_sites := coalesce(v_sites, '{}'::uuid[]) || lower(v_e ->> 'location_id')::uuid;
    end loop;
    if v_sites is null then
      raise exception 'Tick at least one site.' using errcode = '22023';
    end if;
    if v_loc is null then
      v_loc := v_sites[1];
    end if;
    v_sites := array(select distinct x from unnest(v_sites || v_loc) x order by x);
  elsif v_d ? 'sites' then
    v_d := v_d - 'sites';
  end if;
  if v_d ? 'id' or v_sid is not null then
    v_id := public.stock_co__company_id('recipe', coalesce((v_d ->> 'id')::uuid, v_sid));
    if v_id is null or ((v_d ->> 'id') is not null and v_id <> (v_d ->> 'id')::uuid) then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    select * into v_old from stock_co_recipes x where x.id = v_id;
    v_org := v_old.org_id;
    if v_sid is not null then
      select t.row_version into v_srv from recipes t where t.id = v_sid;
      v_loc := (select y.loc from (select public.stock_co__site_loc('recipe', v_sid) as loc) y where v_loc is null or y.loc = v_loc);
      if v_loc is null then
        raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
      end if;
    elsif v_loc is null then
      v_loc := public.stock_co__reached_site(array(select s.location_id from stock_co_recipe_sites s where s.recipe_id = v_id)
                                             || v_old.local_location_id);
    end if;
  else
    if v_loc is null then
      raise exception 'A new recipe needs its site (location_id).' using errcode = '22023';
    end if;
    select l.org_id into v_org from locations l where l.id = v_loc;
    if v_org is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
  end if;
  if v_d ? 'output_item_id' or v_d ? 'site_output_item_id' then
    v_out := public.stock_co__company_id('item', coalesce((v_d ->> 'output_item_id')::uuid, (v_d ->> 'site_output_item_id')::uuid));
    if coalesce(v_d ->> 'output_item_id', v_d ->> 'site_output_item_id') is not null
       and (v_out is null or not exists (select 1 from stock_co_items x where x.id = v_out and x.org_id = v_org)) then
      raise exception 'That made item was not found in this company.' using errcode = '22023';
    end if;
  else
    v_out := v_old.output_item_id;
  end if;
  v_section := public.stock_co__section(p_section, case when v_out is not null then array['produce', 'inventory'] else array['produce'] end);
  v_g := public.stock_co__guard(v_org, v_section, 'company', coalesce(v_sites, array[v_loc]));
  if v_id is not null then
    select * into v_old from stock_co_recipes x where x.id = v_id for update;
    perform public.stock_co__need_version('company', p_version);
    if p_version is not null then
      v_rv := case when v_sid is not null then v_srv else v_old.row_version end;
      if v_rv is distinct from p_version then
        return public.stock_co__conflict(v_org, array['recipe', 'recipe_site', 'menu_link'], v_id, v_rv, v_loc, v_old.updated_at);
      end if;
    end if;
  end if;

  v_co := v_d - array['id', 'site_recipe_id', 'location_id', 'recipe_type', 'output_item_id', 'site_output_item_id', 'menu_item_id', 'portion'];
  v_co := v_co || jsonb_build_object('output_item_id', v_out);
  -- DROP 3 20261027a: a kitchen only recipe keeps its method in stock_co_recipe_secrets (readable by the
  -- kitchen and company editors only); stock_co_recipes.method stays null.
  if v_old.id is not null and coalesce(v_old.restricted, false) and v_co ? 'method' then
    if not public.stock_co__secret_ok(v_org, (select s.kitchen_location_id from stock_co_recipe_secrets s where s.recipe_id = v_id)) then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
    update stock_co_recipe_secrets s
       set method = nullif(v_co ->> 'method', ''), row_version = s.row_version + 1, updated_by = (v_g ->> 'uid')::uuid,
           updated_by_name = v_g ->> 'name', updated_at = now()
     where s.recipe_id = v_id;
    v_co := v_co - 'method';
  end if;
  if v_d ? 'recipe_type' then
    v_co := v_co || jsonb_build_object('kind', case v_d ->> 'recipe_type' when 'MENU' then 'dish' when 'BATCH' then 'batch' else 'prep' end);
  end if;
  -- Drop 2: the menu product is one of this company's menus; a kind change and its made item
  if (v_co ->> 'msm_product_id') is not null
     and not exists (select 1 from msm_products mp join msm_menus mm on mm.id = mp.menu_id
                      where mp.id = (v_co ->> 'msm_product_id')::uuid and mm.org_id = v_org) then
    raise exception 'That menu product is not in this company.' using errcode = '22023';
  end if;
  v_kind_new := coalesce(v_co ->> 'kind', v_old.kind);
  if v_kind_new = 'dish' and v_out is not null and (v_old.id is null or v_old.kind <> 'dish') then
    if v_d ? 'output_item_id' or v_d ? 'site_output_item_id' then
      raise exception 'A dish has no made item.' using errcode = '22023';
    end if;
    v_out := null;
    v_co := v_co || jsonb_build_object('output_item_id', null);
  end if;
  if v_kind_new in ('batch', 'prep') and v_out is null and v_old.id is not null and v_old.kind = 'dish' then
    raise exception 'A batch or prep recipe needs its made item.' using errcode = '22023';
  end if;

  -- the lines, in the company form
  if jsonb_typeof(p_lines) = 'array' then
    for v_line in select e.value from jsonb_array_elements(p_lines) with ordinality e(value, ord) order by e.ord loop
      v_ln := public.stock_co__clean('recipe_line', v_line);
      if v_ln ? 'component_item_id' and v_ln ? 'site_component_item_id' then
        raise exception 'Send the company id or the site id of a line''s item, not both.' using errcode = '22023';
      end if;
      continue when coalesce(v_ln ->> 'component_item_id', v_ln ->> 'site_component_item_id') is null
                 or coalesce((v_ln ->> 'qty')::numeric, 0) <= 0;
      if (v_ln ->> 'site_component_item_id') is not null then
        v_site_comp := (v_ln ->> 'site_component_item_id')::uuid;
        select s.item_id into v_comp from stock_co_item_sites s where s.site_item_id = v_site_comp and s.location_id = v_loc;
        if v_comp is null then
          raise exception 'A line names a stock item that is not at this site.' using errcode = '22023';
        end if;
      else
        v_comp := (v_ln ->> 'component_item_id')::uuid;
        if not exists (select 1 from stock_co_items x where x.id = v_comp and x.org_id = v_org) then
          raise exception 'A line names a stock item that is not in this company.' using errcode = '22023';
        end if;
        select s.site_item_id into v_site_comp from stock_co_item_sites s where s.item_id = v_comp and s.location_id = v_loc;
      end if;
      v_u := btrim(coalesce(v_ln ->> 'unit', ''));
      v_pack := null;
      if v_u like '@_%' then
        if substr(v_u, 2) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
          raise exception 'A line is in a pack ServOS does not know.' using errcode = '22023';
        end if;
        select ps.pack_id into v_pack from stock_co_pack_sites ps
         where ps.site_pack_id = substr(v_u, 2)::uuid and ps.location_id = v_loc;
        v_unit := '@';
        v_site_unit := lower(v_u);
      elsif v_u = '@' then
        v_pack := (v_ln ->> 'pack_id')::uuid;
        v_unit := '@';
        v_site_unit := '@' || (select ps.site_pack_id from stock_co_pack_sites ps where ps.pack_id = v_pack and ps.location_id = v_loc)::text;
      else
        if (v_ln ->> 'pack_id') is not null then
          raise exception 'A line with a pack has the unit "@".' using errcode = '22023';
        end if;
        v_unit := lower(v_u);
        if not exists (select 1 from stock_units su where su.code = v_unit) then
          raise exception '"%" is not a unit ServOS knows (g, kg, ml, l, each, ...).', v_u using errcode = '22023';
        end if;
        v_site_unit := v_unit;
      end if;
      if v_unit = '@' and (v_pack is null or not exists (select 1 from stock_co_packs x where x.id = v_pack and x.item_id = v_comp)) then
        raise exception 'A line is in a pack that is not one of its item''s packs.' using errcode = '22023';
      end if;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object(
        'component_item_id', v_comp, 'qty', (v_ln ->> 'qty')::numeric, 'unit', v_unit, 'pack_id', v_pack,
        'usable_pct', coalesce((v_ln ->> 'usable_pct')::numeric, 100), 'sort_order', v_n, 'note', v_ln ->> 'note',
        'order_types', case when jsonb_typeof(v_ln -> 'order_types') = 'array' and jsonb_array_length(v_ln -> 'order_types') > 0
                            then v_ln -> 'order_types' end,
        'base_qty', case when v_site_comp is not null and v_site_unit is not null
                         then public.stock_qty_to_base((v_ln ->> 'qty')::numeric, v_site_unit, v_site_comp) end));
      v_n := v_n + 1;
    end loop;
  end if;

  if v_id is null then
    if coalesce(v_co ->> 'name', '') = '' or (v_co ->> 'kind') is null then
      raise exception 'A new recipe needs a name and its type.' using errcode = '22023';
    end if;
    v_new := jsonb_populate_record(null::stock_co_recipes,
               jsonb_build_object('id', gen_random_uuid(), 'org_id', v_org,
                                  'local_location_id', case when (v_g ->> 'multi')::boolean and v_sites is null then v_loc end,
                                  'yield_qty', 1, 'yield_unit', 'each', 'wastage_pct', 0, 'restricted', false, 'row_version', 1,
                                  'created_at', now(), 'updated_at', now(), 'updated_by', v_g ->> 'uid') || v_co);
    v_new.restricted := coalesce(v_new.restricted, false);
    insert into stock_co_recipes select (v_new).*;
    v_id := v_new.id;
    v_log := public.stock_co__log_diff(v_org, null, 'recipe', v_id, null, to_jsonb(v_new), v_src);
  else
    v_new := jsonb_populate_record(v_old, v_co);
    v_new.row_version := v_old.row_version + 1;
    v_new.updated_at := now();
    v_new.updated_by := (v_g ->> 'uid')::uuid;
    update stock_co_recipes x
       set (kind, name, yield_qty, yield_unit, output_item_id, wastage_pct, gp_target_pct, method, photo, food_kind, meal_food_pct,
            portion_weight_g, cooking_yield_pct, shelf_life_days, msm_product_id, row_version, updated_at, updated_by)
         = (v_new.kind, v_new.name, v_new.yield_qty, v_new.yield_unit, v_new.output_item_id, v_new.wastage_pct, v_new.gp_target_pct,
            v_new.method, v_new.photo, v_new.food_kind, v_new.meal_food_pct, v_new.portion_weight_g, v_new.cooking_yield_pct,
            v_new.shelf_life_days, v_new.msm_product_id, v_new.row_version, v_new.updated_at, v_new.updated_by)
     where x.id = v_id;
    v_log := public.stock_co__log_diff(v_org, null, 'recipe', v_id, to_jsonb(v_old), to_jsonb(v_new), v_src);
  end if;
  if jsonb_typeof(p_lines) = 'array' then
    select coalesce(jsonb_agg(jsonb_build_object('component_item_id', l.component_item_id, 'qty', l.qty, 'unit', l.unit,
                                                 'pack_id', l.pack_id, 'usable_pct', l.usable_pct, 'sort_order', l.sort_order,
                                                 'note', l.note, 'order_types', l.order_types) order by l.sort_order, l.id), '[]'::jsonb)
      into v_old_lines from stock_co_recipe_lines l where l.recipe_id = v_id;
    delete from stock_co_recipe_lines l where l.recipe_id = v_id;
    insert into stock_co_recipe_lines (org_id, recipe_id, component_item_id, qty, unit, pack_id, usable_pct, order_types, note,
                                       sort_order, base_qty)
    select v_org, v_id, x.component_item_id, x.qty, x.unit, x.pack_id, x.usable_pct, x.order_types, x.note, x.sort_order, x.base_qty
      from jsonb_to_recordset(v_lines) as x(component_item_id uuid, qty numeric, unit text, pack_id uuid, usable_pct numeric,
                                            sort_order integer, note text, order_types jsonb, base_qty numeric);
    if v_old_lines is distinct from (select coalesce(jsonb_agg(e - 'base_qty'), '[]'::jsonb) from jsonb_array_elements(v_lines) e) then
      v_log := coalesce(public.stock_co__log(v_org, null, 'recipe', v_id, 'lines', v_old_lines,
                                             (select coalesce(jsonb_agg(e - 'base_qty'), '[]'::jsonb) from jsonb_array_elements(v_lines) e),
                                             v_src), v_log);
    end if;
  end if;

  -- Drop 2: a new company recipe switched on at every listed site (every ingredient, pack and bridge
  -- ticked there, the till link when given); a refusal in words is listed per site
  if v_sites is not null then
    foreach v_s in array v_sites loop
      v_on := null;
      select e into v_on from jsonb_array_elements(v_sites_in) e where lower(e ->> 'location_id') = v_s::text limit 1;
      v_fr := public.stock_co__recipe_on_at(v_id, v_s, nullif(btrim(coalesce(v_on ->> 'menu_item_id', '')), ''),
                'Added by ' || coalesce(nullif(btrim(coalesce(v_g ->> 'name', '')), ''), 'head office'), v_g ->> 'name');
      v_sites_out := v_sites_out || jsonb_build_array(jsonb_build_object(
                       'location_id', v_s, 'site_recipe_id', v_fr ->> 'site_recipe_id', 'menu_item_id', v_fr ->> 'menu_item_id',
                       'refused', case when coalesce((v_fr ->> 'ok')::boolean, false) then null else v_fr ->> 'error' end));
    end loop;
  end if;

  -- the recipe at the caller's site, and its till product there
  select s.site_recipe_id into v_sid from stock_co_recipe_sites s where s.recipe_id = v_id and s.location_id = v_loc;
  if v_sid is null then
    if v_old.id is not null then
      raise exception 'This recipe is not set up at that site.' using errcode = '22023';
    end if;
    v_sid := public.stock_co__new_site_recipe(v_id, v_loc);
  end if;
  v_menu := v_d ->> 'menu_item_id';
  if v_menu is not null and v_new.kind = 'dish' then
    if not exists (select 1 from menu_items m where m.id = v_menu and m.location_id = v_loc::text) then
      raise exception 'That till product is not on this venue''s menu.' using errcode = '22023';
    end if;
    update stock_co_recipe_sites s set site_menu_item_id = null, row_version = s.row_version + 1, updated_at = now()
     where s.location_id = v_loc and s.site_menu_item_id = v_menu and s.recipe_id <> v_id;
    update stock_co_recipe_sites s set site_menu_item_id = v_menu, row_version = s.row_version + 1, updated_at = now()
     where s.recipe_id = v_id and s.location_id = v_loc and s.site_menu_item_id is distinct from v_menu;
    if found then
      v_log := coalesce(public.stock_co__log(v_org, v_loc, 'menu_link', v_id, 'menu_item_id', null, to_jsonb(v_menu), v_src), v_log);
    end if;
  end if;

  select s.site_item_id into v_site_out from stock_co_item_sites s where s.item_id = v_new.output_item_id and s.location_id = v_loc;
  select t.current_cost into v_before_cost from inventory_items t where t.id = v_site_out;
  v_run := public.stock_co__run_sites(v_org, v_loc, array(select s.location_id from stock_co_recipe_sites s where s.recipe_id = v_id),
                                      '{}'::uuid[], '{}'::uuid[], array[v_id], v_log, v_t0);

  if v_menu is not null and v_new.kind = 'dish' then
    update menu_item_recipes m set portion = coalesce((v_d ->> 'portion')::numeric, 1)
     where m.location_id = v_loc and m.menu_item_id = v_menu and m.recipe_id = v_sid
       and m.portion is distinct from coalesce((v_d ->> 'portion')::numeric, 1);
    v_linked := exists (select 1 from menu_item_recipes m where m.location_id = v_loc and m.menu_item_id = v_menu and m.recipe_id = v_sid);
  end if;

  -- the made item's cost at the caller's site, said back the way the screens say it today
  if v_site_out is not null then
    v_cost := public.stock_co__recost(v_loc, array[v_site_out], true);
    select e into v_c from jsonb_array_elements(v_cost -> 'items') e where (e ->> 'item_id')::uuid = v_site_out limit 1;
  end if;

  -- Drop 2: today's cost rows for every site the recipe is on, and the facts of its linked till products
  -- (inline up to 50 sites, else queued per site)
  perform public.stock_co__cost_rows(array[v_id], null, null);
  if (select count(*) from stock_co_recipe_sites s where s.recipe_id = v_id and s.on_here and s.site_menu_item_id is not null) <= 50 then
    for v_s, v_e in
      select s.location_id, to_jsonb(s.site_menu_item_id) from stock_co_recipe_sites s
       where s.recipe_id = v_id and s.on_here and s.site_menu_item_id is not null order by s.location_id
    loop
      v_fr := public.stock_co__facts_rebuild_site(v_s, array[v_e #>> '{}']);
      v_facts := v_facts + coalesce((v_fr ->> 'rows')::integer, 0);
    end loop;
  else
    perform public.stock_co__d2_enqueue(v_org, s.location_id, 'facts_rebuild',
                                        jsonb_build_object('menu_item_ids', jsonb_build_array(s.site_menu_item_id)), '{}'::uuid[])
       from stock_co_recipe_sites s where s.recipe_id = v_id and s.on_here and s.site_menu_item_id is not null;
  end if;

  if (v_d ->> 'site_recipe_id') is not null then
    select t.row_version into v_rv from recipes t where t.id = v_sid;
    if v_rv is not distinct from v_srv then
      update recipes t set row_version = t.row_version + 1 where t.id = v_sid returning t.row_version into v_rv;
    end if;
  else
    v_rv := v_new.row_version;
  end if;
  select * into v_row from recipes t where t.id = v_sid;
  select count(*) into v_q from stock_co_recipe_lines l where l.recipe_id = v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', v_rv, 'site_recipe_id', v_sid,
                            'site_row', case when v_row.id is null then null else to_jsonb(v_row) end,
                            'lines_saved', v_q, 'linked', v_linked,
                            'cost', case when v_site_out is null then null
                                         else jsonb_build_object('item_id', v_site_out, 'ok', coalesce((v_c ->> 'ok')::boolean, false),
                                                                 'before', to_jsonb(v_before_cost), 'after', v_c -> 'after') end,
                            'queued', v_run -> 'queued', 'facts_rows', v_facts)
         || case when v_sites is not null then jsonb_build_object('sites', v_sites_out) else '{}'::jsonb end;
end
$function$;

CREATE OR REPLACE FUNCTION public.stock_recipe_detail(p_recipe uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_id uuid;
  v_r stock_co_recipes;
  v_scope uuid[];
  v_cost_site uuid;
  v_tot record;
  v_ans jsonb;
  v_sec stock_co_recipe_secrets;
  v_read boolean := true;
begin
  perform public.stock_co__signed_in();
  v_id := public.stock_co__company_id('recipe', p_recipe);
  select * into v_r from stock_co_recipes r where r.id = v_id;
  if v_r.id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_scope := public.stock_co__read_scope(v_r.org_id, null);
  select s.location_id into v_cost_site from stock_co_recipe_sites s
    join locations l on l.id = s.location_id
   where s.recipe_id = v_id and s.on_here and s.location_id = any(v_scope)
   order by l.name, l.id limit 1;
  if v_cost_site is not null then
    select * into v_tot from public.stock_co__recipe_total(v_id, v_cost_site, null);
  else
    -- DROP 3 20261027a: a recipe on at no site in the caller's reach (a kitchen only recipe read from
    -- another site) answers with no cost instead of stopping on an unassigned record
    select null::numeric as total, null::numeric as yield_base, null::numeric as per_yield, null::integer as missing into v_tot;
  end if;
  v_ans := jsonb_build_object(
    'recipe', to_jsonb(v_r), 'row_version', v_r.row_version, 'local', v_r.local_location_id is not null,
    'editors', coalesce((select jsonb_agg(e.name order by e.name) from (
                           select distinct coalesce(p.full_name, p.email) as name from user_profiles p
                            where p.org_id = v_r.org_id and p.role = 'owner' limit 10) e), '[]'::jsonb),
    'cost_site', v_cost_site,
    'cost', case when v_cost_site is not null then jsonb_build_object('total', v_tot.total, 'yield_base', v_tot.yield_base,
                                                                      'per_yield', v_tot.per_yield, 'missing', v_tot.missing) end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', l.id, 'component_item_id', l.component_item_id, 'name', i.name, 'base_unit', i.base_unit,
               'kind_at_site', (select ii.kind from stock_co_item_sites si join inventory_items ii on ii.id = si.site_item_id
                                 where si.item_id = l.component_item_id and si.location_id = v_cost_site),
               'qty', l.qty, 'unit', l.unit, 'pack_id', l.pack_id, 'pack_name', (select pk.name from stock_co_packs pk where pk.id = l.pack_id),
               'usable_pct', l.usable_pct, 'order_types', l.order_types, 'note', l.note, 'sort_order', l.sort_order,
               'packs', coalesce((select jsonb_agg(jsonb_build_object('id', pk.id, 'name', pk.name, 'qty_in_base', pk.qty_in_base)
                                                   order by pk.name, pk.id)
                                    from stock_co_packs pk where pk.item_id = l.component_item_id and pk.archived_at is null), '[]'::jsonb),
               'has_recipe', exists (select 1 from stock_co_recipes x join stock_co_recipe_sites xs on xs.recipe_id = x.id
                                      where x.output_item_id = l.component_item_id and x.archived_at is null
                                        and xs.location_id = v_cost_site and xs.on_here))
             order by l.sort_order, l.id)
        from stock_co_recipe_lines l left join stock_co_items i on i.id = l.component_item_id
       where l.recipe_id = v_id), '[]'::jsonb),
    'sites', coalesce((
      select jsonb_agg(jsonb_build_object(
               'location_id', l.id, 'name', l.name, 'on', coalesce(s.on_here, false),
               'site_recipe_id', case when s.on_here then s.site_recipe_id end,
               'menu_item_id', case when s.on_here then s.site_menu_item_id end,
               'menu_item_name', case when s.on_here then (select mi.name from menu_items mi where mi.id = s.site_menu_item_id and mi.location_id = l.id::text) end,
               'sale_price', case when s.on_here then pr.gross end, 'sale_price_net', case when s.on_here then pr.net end,
               'cost', case when s.on_here then (cr.cj ->> 'cost')::numeric end, 'gp_pct', case when s.on_here then (cr.cj ->> 'gp_pct')::numeric end,
               'price_for_target', case when s.on_here and v_r.gp_target_pct is not null and v_r.gp_target_pct < 100 and (cr.cj ->> 'cost') is not null
                                        then round((cr.cj ->> 'cost')::numeric / (1 - v_r.gp_target_pct / 100.0)
                                                   * case when pr.gross is not null and pr.net is not null and pr.net <> 0 then pr.gross / pr.net else 1 end, 2) end,
               'sold_7d', case when s.on_here then sd.qty end, 'sales_7d_net', case when s.on_here then sd.net end,
               'how', case when s.on_here then coalesce(s.how, (select si.supply_mode from stock_co_item_sites si
                                                                 where si.item_id = v_r.output_item_id and si.location_id = l.id)) end,
               'holds', case when s.on_here and v_r.output_item_id is not null then
                               (select ii.on_hand from stock_co_item_sites si join inventory_items ii on ii.id = si.site_item_id
                                 where si.item_id = v_r.output_item_id and si.location_id = l.id) end,
               'why_on', case when s.on_here then s.why_on end, 'linked_at', case when s.on_here then s.linked_at end,
               'link_row_version', s.row_version,
               'needs_check', coalesce(fx.needs_check, false), 'checked_by_name', fx.checked_by_name, 'checked_at', fx.checked_at)
             order by l.name, l.id)
        from locations l
        left join stock_co_recipe_sites s on s.recipe_id = v_id and s.location_id = l.id
        left join lateral (select public.stock_co__cost_row_of(v_id, l.id) as cj) cr on true
        left join lateral (select * from public.stock_co__menu_price_net(l.id, s.site_menu_item_id) where s.site_menu_item_id is not null) pr on true
        left join lateral (select sum(d.qty) as qty, sum(d.net) as net from sales_day_sums d
                            where s.site_menu_item_id is not null and d.location_id = l.id and d.menu_item_id = s.site_menu_item_id
                              and d.business_day between public.stock_co__today(l.id) - 6 and public.stock_co__today(l.id)) sd on true
        left join menu_item_stock_facts fx on fx.location_id = l.id::text and fx.menu_item_id = s.site_menu_item_id
       where l.id = any(v_scope)), '[]'::jsonb),
    'option_rules', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', ru.id, 'kind', ru.kind, 'option_name', ru.option_name, 'option_msm_product_id', ru.option_msm_product_id,
               'option_company_item_id', ru.option_company_item_id,
               'option_item_name', (select i.name from stock_co_items i where i.id = ru.option_company_item_id),
               'replaces_item_id', ru.replaces_item_id, 'replaces_item_name', (select i.name from stock_co_items i where i.id = ru.replaces_item_id),
               'removes_item_id', ru.removes_item_id, 'removes_item_name', (select i.name from stock_co_items i where i.id = ru.removes_item_id),
               'archived_at', ru.archived_at, 'row_version', ru.row_version,
               'sites', coalesce((select jsonb_agg(jsonb_build_object('location_id', rs.location_id, 'site_modifier_id', rs.site_modifier_id,
                                                                      'resolved_by', rs.resolved_by) order by rs.location_id)
                                    from stock_co_option_rule_sites rs where rs.rule_id = ru.id and rs.location_id = any(v_scope)), '[]'::jsonb))
             order by ru.option_name, ru.id)
        from stock_co_option_rules ru where ru.recipe_id = v_id), '[]'::jsonb),
    'menu_product', (select jsonb_build_object('id', mp.id, 'name', mp.name, 'menu_name', mm.name)
                       from msm_products mp join msm_menus mm on mm.id = mp.menu_id
                      where mp.id = v_r.msm_product_id and mm.org_id = v_r.org_id));
  -- DROP 3 20261027a: kitchen only recipes. A caller who may not read it sees no method and no cost; a reader
  -- gets the method from the secrets table. The three keys are always there.
  select * into v_sec from stock_co_recipe_secrets s where s.recipe_id = v_id;
  if coalesce(v_r.restricted, false) then
    v_read := public.stock_co__secret_ok(v_r.org_id, v_sec.kitchen_location_id);
    v_ans := v_ans || jsonb_build_object('recipe', (v_ans -> 'recipe') || jsonb_build_object('method', case when v_read then v_sec.method end),
                                         'method', case when v_read then v_sec.method end);
    if not v_read then
      v_ans := v_ans || jsonb_build_object('cost', null,
                 'sites', coalesce((select jsonb_agg(e || jsonb_build_object('cost', null, 'gp_pct', null, 'price_for_target', null) order by o)
                                      from jsonb_array_elements(v_ans -> 'sites') with ordinality x(e, o)), '[]'::jsonb));
    end if;
  end if;
  return v_ans || jsonb_build_object('restricted', coalesce(v_r.restricted, false), 'kitchen_location_id', v_sec.kitchen_location_id,
                                     'kitchen_name', (select l.name from locations l where l.id = v_sec.kitchen_location_id));
end
$function$;

CREATE OR REPLACE FUNCTION public.stock_recipe_card(p_loc uuid, p_menu_item_id text DEFAULT NULL::text, p_recipe uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_id uuid;
  v_r stock_co_recipes;
  v_fx menu_item_stock_facts;
  f record;
  v_menu text := nullif(btrim(coalesce(p_menu_item_id, '')), '');
begin
  if p_loc is null then
    raise exception 'Sign in to see recipe cards.' using errcode = '42501';
  end if;
  if v_uid is null or public.is_anon_session() then
    if v_uid is null or not (
         exists (select 1 from devices d where d.device_uid = v_uid and d.location_id = p_loc and d.type in ('pos', 'kds', 'handheld'))
         or exists (select 1 from ops_devices o where o.device_uid = v_uid and o.location_id = p_loc and o.active and o.claimed_at is not null)) then
      raise exception 'Sign in to see recipe cards.' using errcode = '42501';
    end if;
  else
    select l.org_id into v_org from locations l where l.id = p_loc;
    perform public.stock_co__read_scope(v_org, array[p_loc]);
  end if;
  if p_recipe is not null then
    v_id := public.stock_co__company_id('recipe', p_recipe);
  elsif v_menu is not null then
    select t.company_ref into v_id from menu_item_recipes m join recipes t on t.id = m.recipe_id and t.archived_at is null
     where m.location_id = p_loc and m.menu_item_id = v_menu;
  end if;
  select * into v_r from stock_co_recipes r
   where r.id = v_id and r.org_id = (select l.org_id from locations l where l.id = p_loc)
     and exists (select 1 from stock_co_recipe_sites s where s.recipe_id = r.id and s.location_id = p_loc and s.on_here);
  if v_r.id is null then
    return jsonb_build_object('recipe_id', null, 'name', null, 'build', '[]'::jsonb, 'method', '[]'::jsonb);
  end if;
  if v_menu is null then
    select s.site_menu_item_id into v_menu from stock_co_recipe_sites s where s.recipe_id = v_r.id and s.location_id = p_loc;
  end if;
  select * into v_fx from menu_item_stock_facts x where x.location_id = p_loc::text and x.menu_item_id = v_menu;
  select * into f from public.stock_co__facts_of_recipe(v_r.id, p_loc, '{}'::uuid[]);
  return jsonb_build_object(
    'recipe_id', v_r.id, 'name', v_r.name, 'kind', v_r.kind, 'restricted', v_r.restricted,
    'photo', case when v_r.restricted then null else v_r.photo end,
    'portion_words', case when v_r.portion_weight_g is not null then trim_scale(round(v_r.portion_weight_g, 1))::text || ' g'
                          when v_r.kind = 'dish' and coalesce(v_r.yield_qty, 1) = 1 and coalesce(v_r.yield_unit, 'each') = 'each' then '1 plate'
                          else trim_scale(round(coalesce(v_r.yield_qty, 1), 3))::text || ' ' || coalesce(nullif(v_r.yield_unit, ''), 'each') end,
    'build', coalesce((select jsonb_agg(jsonb_build_object('qty', trim_scale(l.qty),
                                                           'unit', case when l.unit = '@' then (select pk.name from stock_co_packs pk where pk.id = l.pack_id) else l.unit end,
                                                           'name', i.name) order by l.sort_order, l.id)
                         from stock_co_recipe_lines l left join stock_co_items i on i.id = l.component_item_id
                        where l.recipe_id = v_r.id), '[]'::jsonb),
    'method', case when v_r.restricted then
                     -- DROP 3 20261027a: a kitchen only recipe's method comes from the secrets, at its kitchen only
                     coalesce((select jsonb_agg(btrim(regexp_replace(x, '^\s*[0-9]+[.)]\s*', '')) order by o)
                                 from stock_co_recipe_secrets sx
                                 cross join lateral regexp_split_to_table(sx.method, '\n\s*\n|\n(?=\s*[0-9]+[.)]\s)') with ordinality t(x, o)
                                where sx.recipe_id = v_r.id and sx.kitchen_location_id = p_loc
                                  and nullif(btrim(coalesce(sx.method, '')), '') is not null and btrim(x) <> ''), '[]'::jsonb)
                   when nullif(btrim(coalesce(v_r.method, '')), '') is null then '[]'::jsonb
                   else coalesce((select jsonb_agg(btrim(regexp_replace(x, '^\s*[0-9]+[.)]\s*', '')) order by o)
                                    from regexp_split_to_table(v_r.method, '\n\s*\n|\n(?=\s*[0-9]+[.)]\s)') with ordinality t(x, o)
                                   where btrim(x) <> ''), '[]'::jsonb) end,
    'allergens', to_jsonb(coalesce(v_fx.allergens, f.allergens, '{}'::text[])),
    'may_contain', to_jsonb(coalesce(v_fx.may_contain, f.may_contain, '{}'::text[])),
    'kcal', coalesce(v_fx.kcal, f.kcal),
    'use_by_days', v_r.shelf_life_days,
    'ingredients_text', coalesce(v_fx.ingredients_text, f.ingredients_text),
    'signed_off', coalesce(v_fx.checked_at is not null and not v_fx.needs_check, false));
end
$function$;

-- ============================================================================
-- STEP 5. PURCHASING (contract 1.6): the Order pad, approvals, standing orders, invoices, credits,
-- prices and budgets. Reads are keyset pages of at most 100, never OFFSET.
-- ============================================================================

-- The sites a company read names (at most 50), checked like the guard's read.
create or replace function public.stock_co__d3_scope(p_org uuid, p_sites uuid[])
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v uuid[];
begin
  if p_sites is not null and cardinality(p_sites) > 50 then
    raise exception 'Pick 50 sites or fewer.' using errcode = '22023';
  end if;
  v := public.stock_co__read_scope(p_org, p_sites);
  if cardinality(v) > 50 then
    raise exception 'Pick 50 sites or fewer.' using errcode = '22023';
  end if;
  return v;
end
$fn$;

-- A budget week at one site, no guard (stock_budget_status and the Order pad context call it).
create or replace function public.stock_co__budget_of(p_site uuid, p_week date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_ws integer;
  v_today date;
  v_start date;
  v_b stock_budgets;
  v_forecast numeric := 0;
  v_spent numeric := 0;
  v_budget numeric;
begin
  select l.org_id into v_org from locations l where l.id = p_site;
  select coalesce(s.week_start, 1) into v_ws from stock_co_settings s where s.org_id = v_org;
  v_ws := coalesce(v_ws, 1) % 7;
  v_today := coalesce(p_week, public.stock_co__today(p_site));
  v_start := v_today - ((extract(dow from v_today)::integer - v_ws + 7) % 7);
  select * into v_b from stock_budgets b where b.org_id = v_org and b.location_id = p_site;
  if v_b.id is null then
    select * into v_b from stock_budgets b where b.org_id = v_org and b.location_id is null;
  end if;
  select coalesce(sum(public.stock_co__forecast_amount(p_site, v_start + k)), 0) into v_forecast from generate_series(0, 6) k;
  select coalesce(sum(coalesce(po.subtotal, 0) + coalesce(po.delivery_fee, 0)), 0) into v_spent
    from purchase_orders po
   where po.location_id = p_site and po.status in ('SENT', 'PARTIAL', 'RECEIVED')
     and public.stock_co__vday(p_site, coalesce(po.ordered_at, po.created_at)) between v_start and v_start + 6;
  v_budget := case when v_b.id is null then null when v_b.rule = 'fixed' then v_b.amount else round(v_forecast * v_b.pct / 100.0, 2) end;
  return jsonb_build_object('location_id', p_site, 'week_start', v_start, 'budget', v_budget, 'rule', v_b.rule, 'pct', v_b.pct,
                            'forecast', round(v_forecast, 2), 'spent', round(v_spent, 2),
                            'left', case when v_budget is null then null else round(v_budget - v_spent, 2) end,
                            'over', coalesce(v_budget is not null and v_spent > v_budget, false));
end
$fn$;

create or replace function public.stock_order_pad_context(p_loc uuid, p_actor jsonb default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_g jsonb;
  v_tz text;
  v_local timestamp;
  v_cur text;
  v_today date;
  v_sup jsonb;
  v_kp jsonb;
  v_budget jsonb;
begin
  select l.org_id, l.currency into v_org, v_cur from locations l where l.id = p_loc;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__d3_who(v_org, null, 'read', array[p_loc], p_actor);
  v_tz := public.stock_co__tz(p_loc);
  v_local := now() at time zone v_tz;
  v_today := v_local::date;
  select coalesce(jsonb_agg(x.j order by x.name, x.id), '[]'::jsonb) into v_sup from (
    select s.id, s.name, jsonb_build_object(
             'supplier_id', s.id, 'company_supplier_id', s.company_ref, 'name', s.name,
             'internal_location_id', c.internal_location_id, 'order_method', coalesce(c.order_method, 'email'),
             'rules', coalesce((select jsonb_agg(jsonb_build_object('delivery_dow', o.delivery_dow, 'order_by_dow', o.order_by_dow,
                                                                    'order_by_time', to_char(o.order_by_time, 'HH24:MI'))
                                                 order by o.delivery_dow) from stock_order_rules o where o.supplier_id = s.id), '[]'::jsonb),
             'exceptions', coalesce((select jsonb_agg(jsonb_build_object('from_day', x.from_day, 'to_day', x.to_day, 'kind', x.kind,
                                                                         'deliver_on', x.deliver_on, 'name', x.name) order by x.from_day, x.id)
                                       from stock_delivery_exceptions x
                                      where x.org_id = v_org and x.archived_at is null and x.to_day >= v_today and x.from_day <= v_today + 21
                                        and (x.scope = 'company' or (x.scope = 'supplier' and x.company_supplier_id = s.company_ref)
                                             or (x.scope = 'site' and x.location_id = p_loc
                                                 and (x.company_supplier_id is null or x.company_supplier_id = s.company_ref)))), '[]'::jsonb),
             'next', nd.j,
             'min_order_value', s.min_order_value, 'max_order_value', c.max_order_value, 'delivery_fee', s.delivery_fee,
             'fee_waived_over_min', coalesce(c.fee_waived_over_min, false), 'approval_limit', s.approval_limit,
             'cc_count', coalesce(cardinality(s.cc_emails), 0),
             'standing', coalesce((select jsonb_agg(jsonb_build_object(
                                     'standing_order_id', so.id, 'delivery_day', nd.j ->> 'delivery_day', 'order_by_at', nd.j ->> 'order_by_at',
                                     'lines', coalesce(r.lines, (select coalesce(jsonb_agg(jsonb_build_object('inventory_item_id', sl.inventory_item_id,
                                                                   'supplier_product_id', sl.supplier_product_id, 'qty_packs', sl.qty_packs)
                                                                   order by sl.sort_order, sl.id), '[]'::jsonb)
                                                                   from stock_standing_order_lines sl where sl.standing_order_id = so.id)),
                                     'edited_by_name', r.edited_by_name, 'status', coalesce(r.status, 'waiting')) order by so.created_at, so.id)
                                     from stock_standing_orders so
                                     left join stock_standing_runs r on r.standing_order_id = so.id and r.delivery_day = (nd.j ->> 'delivery_day')::date
                                    where so.supplier_id = s.id and so.active and nd.j is not null
                                      and extract(dow from (nd.j ->> 'delivery_day')::date)::smallint = any(so.delivery_dows)), '[]'::jsonb)) as j
      from suppliers s
      left join stock_co_suppliers c on c.id = s.company_ref
      cross join lateral (select public.stock_co__next_delivery(s.id, now()) as j) nd
     where s.location_id = p_loc and s.archived_at is null
     limit 200) x;
  select coalesce(jsonb_object_agg(sp.id::text, public.stock_co__kitchen_price(sp.id)), '{}'::jsonb) into v_kp
    from supplier_products sp
    join suppliers s on s.id = sp.supplier_id
    join stock_co_suppliers c on c.id = s.company_ref and c.internal_location_id is not null
    join stock_co_supplier_item_sites sis on sis.site_supplier_product_id = sp.id
    join stock_co_supplier_items si on si.id = sis.supplier_item_id and si.ck_price_rule in ('cost', 'cost_plus')
   where sp.location_id = p_loc and sp.archived_at is null;
  begin
    v_budget := public.stock_co__budget_of(p_loc, null);
    if v_budget ->> 'budget' is null then
      v_budget := null;
    end if;
  end;
  return jsonb_build_object(
    'location_id', p_loc,
    'now', jsonb_build_object('ymd', to_char(v_local, 'YYYY-MM-DD'), 'hm', to_char(v_local, 'HH24:MI'), 'dow', extract(dow from v_local)::integer),
    'tz', v_tz, 'currency', v_cur, 'multi', coalesce((v_g ->> 'multi')::boolean, public.stock_co__multi(v_org)),
    'suppliers', v_sup,
    'budget', v_budget,
    'lists', coalesce((select jsonb_agg(jsonb_build_object('id', ol.id, 'name', ol.name, 'supplier_id', ol.supplier_id, 'lines', ol.lines)
                                        order by ol.name, ol.id)
                         from (select * from stock_order_lists o where o.location_id = p_loc and o.archived_at is null
                                order by o.name, o.id limit 100) ol), '[]'::jsonb),
    'pending_approvals', coalesce((select jsonb_agg(jsonb_build_object('po_id', a.po_id, 'reference', po.reference, 'amount', a.amount,
                                                                       'status', a.status, 'order_by_at', a.order_by_at) order by a.created_at, a.id)
                                     from stock_po_approvals a join purchase_orders po on po.id = a.po_id
                                    where a.location_id = p_loc and a.status in ('waiting', 'sent_back')), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('inventory_item_id', s.site_item_id, 'par_by_weekday', s.par_by_weekday,
                                                           'cover_days', s.cover_days) order by s.site_item_id)
                         from (select * from stock_co_item_sites x where x.location_id = p_loc and x.on_here
                                 and (x.par_by_weekday is not null or x.cover_days is not null) order by x.site_item_id limit 1000) s), '[]'::jsonb),
    'kitchen_prices', v_kp);
end
$fn$;

create or replace function public.stock_po_submit(p_po uuid, p_section text default null, p_actor jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_loc uuid;
  v_org uuid;
  v_g jsonb;
  v_res jsonb;
begin
  select po.location_id, l.org_id into v_loc, v_org from purchase_orders po join locations l on l.id = po.location_id where po.id = p_po;
  if v_loc is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__d3_who(v_org, public.stock_co__section(p_section, array['purchasing']), 'site_facts', array[v_loc], p_actor);
  v_res := public.stock_co__po_submit_core(p_po, nullif(v_g ->> 'uid', '')::uuid, v_g ->> 'name', false);
  if coalesce((v_res ->> 'needs_approval')::boolean, false)
     and coalesce(v_g ->> 'staff_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    update stock_po_approvals a set raised_by_staff_id = (v_g ->> 'staff_id')::uuid, updated_at = now() where a.po_id = p_po;
  end if;
  return v_res;
end
$fn$;

create or replace function public.stock_po_decide(p_po uuid, p_decision text, p_note text default null, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_a stock_po_approvals;
  v_g jsonb;
  v_uid uuid;
  v_editor boolean;
  v_linked boolean;
  v_new text;
begin
  if p_decision is null or p_decision not in ('approve', 'send_back', 'send_anyway', 'cancel') then
    raise exception 'Choose approve, send back, send anyway or cancel.' using errcode = '22023';
  end if;
  select * into v_a from stock_po_approvals a where a.po_id = p_po for update;
  if v_a.id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_a.org_id, public.stock_co__section(p_section, array['purchasing']), 'site_facts', array[v_a.location_id]);
  v_uid := (v_g ->> 'uid')::uuid;
  v_editor := v_g ->> 'level' = 'all';
  v_linked := exists (select 1 from user_locations ul where ul.user_id = v_uid and ul.location_id = v_a.location_id);
  if p_decision in ('approve', 'send_back', 'send_anyway') and public.stock_co__is_raiser(v_uid, v_a.raised_by, v_a.raised_by_staff_id) then
    raise exception 'You raised this order. Another manager approves it.' using errcode = '42501';
  end if;
  if p_decision = 'send_anyway' and (not v_editor or v_a.step < 2) then
    raise exception 'Send anyway is for head office, 30 minutes before the order by time.' using errcode = '42501';
  end if;
  if p_decision in ('approve', 'send_back') and not (v_linked or v_editor) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_decision = 'cancel' and not (v_editor or public.stock_co__is_raiser(v_uid, v_a.raised_by, v_a.raised_by_staff_id)) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if v_a.status <> 'waiting' then
    if (p_decision = 'approve' and v_a.status = 'approved') or (p_decision = 'send_back' and v_a.status = 'sent_back')
       or (p_decision = 'send_anyway' and v_a.status = 'sent_anyway') or (p_decision = 'cancel' and v_a.status = 'cancelled') then
      return jsonb_build_object('ok', true, 'duplicate', true, 'status', v_a.status);
    end if;
    if not (p_decision = 'cancel' and v_a.status = 'sent_back') then
      raise exception 'This order is not waiting for approval now.' using errcode = '55000';
    end if;
  end if;
  v_new := case p_decision when 'approve' then 'approved' when 'send_back' then 'sent_back' when 'send_anyway' then 'sent_anyway' else 'cancelled' end;
  update stock_po_approvals a
     set status = v_new, decided_by = v_uid, decided_by_name = v_g ->> 'name', decided_at = now(),
         note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), a.note), updated_at = now()
   where a.id = v_a.id;
  if p_decision = 'cancel' then
    update purchase_orders po set status = 'CANCELLED', updated_at = now() where po.id = p_po and po.status = 'DRAFT';
  end if;
  -- the server sends it too: the screen emails it at once, and if that email fails (or the tab closes)
  -- po-cutoff-run sends it two minutes later and tries again, so an approval never costs the delivery
  if p_decision in ('approve', 'send_anyway') then
    insert into stock_po_send_jobs (po_id, location_id, why, not_before)
    values (p_po, v_a.location_id, v_new, now() + interval '2 minutes')
    on conflict (po_id) do update set why = excluded.why, status = 'waiting', attempts = 0, last_error = null,
                                      not_before = excluded.not_before
     where stock_po_send_jobs.status <> 'sent';
  end if;
  perform public.stock_co__log(v_a.org_id, v_a.location_id, 'po_approval', p_po, 'status', to_jsonb(v_a.status), to_jsonb(v_new), 'save');
  return jsonb_build_object('ok', true, 'status', v_new, 'po_id', p_po)
      || case when p_decision in ('approve', 'send_anyway') then jsonb_build_object('send', true) else '{}'::jsonb end;
end
$fn$;

create or replace function public.stock_create_orders_many(p_org uuid, p_orders jsonb, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_sites uuid[];
  v_g jsonb;
  v_o jsonb;
  v_ln jsonb;
  v_n integer;
  v_loc uuid;
  v_lname text;
  v_sup uuid;
  v_po uuid;
  v_ref text;
  v_res jsonb;
  v_out jsonb := '[]'::jsonb;
  v_sp supplier_products;
begin
  if p_orders is null or jsonb_typeof(p_orders) <> 'array' or jsonb_array_length(p_orders) = 0 then
    raise exception 'Add at least one order.' using errcode = '22023';
  end if;
  if jsonb_array_length(p_orders) > 50 then
    raise exception 'Pick 50 sites or fewer.' using errcode = '22023';
  end if;
  select array_agg(distinct (e ->> 'location_id')::uuid) into v_sites from jsonb_array_elements(p_orders) e;
  if cardinality(v_sites) > 50 then
    raise exception 'Pick 50 sites or fewer.' using errcode = '22023';
  end if;
  v_g := public.stock_co__guard(p_org, public.stock_co__section(p_section, array['purchasing']), 'company', v_sites);
  -- every supplier, item and supplier pack belongs to its site, checked before anything is written
  for v_o in select e from jsonb_array_elements(p_orders) e loop
    v_loc := (v_o ->> 'location_id')::uuid;
    select l.name into v_lname from locations l where l.id = v_loc;
    if not exists (select 1 from suppliers s where s.id = nullif(v_o ->> 'supplier_id', '')::uuid and s.location_id = v_loc and s.archived_at is null) then
      raise exception 'That supplier is not at %.', v_lname using errcode = '22023';
    end if;
    if jsonb_typeof(v_o -> 'lines') <> 'array' or jsonb_array_length(v_o -> 'lines') = 0 or jsonb_array_length(v_o -> 'lines') > 300 then
      raise exception 'Each order needs 1 to 300 lines.' using errcode = '22023';
    end if;
    v_n := 0;
    for v_ln in select e from jsonb_array_elements(v_o -> 'lines') e loop
      v_n := v_n + 1;
      if not exists (select 1 from inventory_items i where i.id = nullif(v_ln ->> 'inventory_item_id', '')::uuid and i.location_id = v_loc)
         or (nullif(v_ln ->> 'supplier_product_id', '') is not null
             and not exists (select 1 from supplier_products sp
                              where sp.id = (v_ln ->> 'supplier_product_id')::uuid and sp.location_id = v_loc
                                and sp.inventory_item_id = (v_ln ->> 'inventory_item_id')::uuid
                                and sp.supplier_id = (v_o ->> 'supplier_id')::uuid))
         or coalesce(nullif(v_ln ->> 'qty_packs', '')::numeric, 0) <= 0 then
        raise exception 'Line %: that item is not at %.', v_n, v_lname using errcode = '22023';
      end if;
    end loop;
  end loop;
  for v_o in select e from jsonb_array_elements(p_orders) e loop
    v_loc := (v_o ->> 'location_id')::uuid;
    v_sup := (v_o ->> 'supplier_id')::uuid;
    v_ref := 'PO-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
    begin
      insert into purchase_orders (location_id, supplier_id, reference, status, subtotal, notes, created_by)
      values (v_loc, v_sup, v_ref, 'DRAFT', 0, 'Ordered by head office for many sites', (v_g ->> 'uid')::uuid)
      returning id into v_po;
      v_n := 0;
      for v_ln in select e from jsonb_array_elements(v_o -> 'lines') e loop
        v_sp := null;
        select * into v_sp from supplier_products sp where sp.id = nullif(v_ln ->> 'supplier_product_id', '')::uuid;
        if v_sp.id is null then
          select * into v_sp from supplier_products sp
           where sp.location_id = v_loc and sp.supplier_id = v_sup and sp.inventory_item_id = (v_ln ->> 'inventory_item_id')::uuid
             and sp.archived_at is null order by sp.is_preferred desc nulls last, sp.id limit 1;
        end if;
        insert into po_lines (location_id, po_id, inventory_item_id, supplier_product_id, description, qty_packs, pack_qty, inner_qty,
                              inner_unit, unit_price, qty_received, sort_order, purchase_tax_rate_id)
        values (v_loc, v_po, (v_ln ->> 'inventory_item_id')::uuid, v_sp.id,
                coalesce(v_sp.pack_description, (select i.name from inventory_items i where i.id = (v_ln ->> 'inventory_item_id')::uuid)),
                (v_ln ->> 'qty_packs')::numeric, coalesce(v_sp.pack_qty, 1), coalesce(v_sp.inner_qty, 1),
                coalesce(v_sp.inner_unit, (select i.base_unit from inventory_items i where i.id = (v_ln ->> 'inventory_item_id')::uuid), 'each'),
                coalesce(v_sp.pack_price, 0), 0, v_n, v_sp.purchase_tax_rate_id);
        v_n := v_n + 1;
      end loop;
      update purchase_orders po
         set subtotal = (select coalesce(sum(round(pl.qty_packs * coalesce(pl.unit_price, 0), 2)), 0) from po_lines pl where pl.po_id = v_po)
       where po.id = v_po;
      v_res := public.stock_co__po_submit_core(v_po, (v_g ->> 'uid')::uuid, v_g ->> 'name', false);
      v_out := v_out || jsonb_build_array(jsonb_build_object('po_id', v_po, 'location_id', v_loc, 'supplier_id', v_sup, 'reference', v_ref,
                 'send', coalesce((v_res ->> 'send')::boolean, false), 'needs_approval', coalesce((v_res ->> 'needs_approval')::boolean, false),
                 'internal', coalesce((v_res ->> 'internal')::boolean, false), 'error', null));
    exception
      when lock_not_available or deadlock_detected or query_canceled then
        raise;
      when others then
        v_out := v_out || jsonb_build_array(jsonb_build_object('po_id', null, 'location_id', v_loc, 'supplier_id', v_sup, 'reference', null,
                   'send', false, 'needs_approval', false, 'internal', false, 'error', sqlerrm));
    end;
  end loop;
  return jsonb_build_object('ok', true, 'orders', v_out);
end
$fn$;

-- A standing order is agreed when it is set up, so the runner sends it with no approval. Over the site's
-- approval limit for that supplier, only a company editor (Stock control all) sets or changes its lines;
-- null = within the limit (or no limit, or the central kitchen), else the words.
create or replace function public.stock_co__standing_over(p_loc uuid, p_sup uuid, p_lines jsonb)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_sup suppliers;
  v_co stock_co_suppliers;
  v_goods numeric;
  v_amount numeric;
  v_cur text;
begin
  select * into v_sup from suppliers s where s.id = p_sup and s.location_id = p_loc;
  if v_sup.id is null or v_sup.approval_limit is null then
    return null;
  end if;
  select * into v_co from stock_co_suppliers c where c.id = v_sup.company_ref;
  if v_co.internal_location_id is not null then
    return null;
  end if;
  select coalesce(sum(round(greatest(coalesce(nullif(e.v ->> 'qty_packs', '')::numeric, 0), 0) * coalesce(sp.pack_price, 0), 2)), 0) into v_goods
    from jsonb_array_elements(case when jsonb_typeof(p_lines) = 'array' then p_lines else '[]'::jsonb end) e(v)
    left join lateral (select x.pack_price from supplier_products x
                        where x.location_id = p_loc and x.supplier_id = p_sup and x.archived_at is null
                          and x.inventory_item_id = nullif(e.v ->> 'inventory_item_id', '')::uuid
                        order by (x.id = nullif(e.v ->> 'supplier_product_id', '')::uuid) desc, x.is_preferred desc nulls last, x.id
                        limit 1) sp on true;
  v_amount := v_goods + coalesce(public.stock_co__fee_for(v_sup.id, v_goods), 0);
  if v_amount <= v_sup.approval_limit then
    return null;
  end if;
  select l.currency into v_cur from locations l where l.id = p_loc;
  return 'This standing order comes to ' || public.stock_co__money(v_cur, v_amount) || ', over the approval limit '
      || public.stock_co__money(v_cur, v_sup.approval_limit) || ' for ' || coalesce(v_co.name, v_sup.name)
      || '. Ask head office to set it, or order it by hand for approval.';
end
$fn$;

create or replace function public.stock_save_standing_order(p_so jsonb, p_version integer default null, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old stock_standing_orders;
  v_loc uuid;
  v_org uuid;
  v_sup suppliers;
  v_g jsonb;
  v_id uuid;
  v_d smallint;
  v_dows smallint[];
  v_ln jsonb;
  v_n integer := 0;
  v_why text;
begin
  if p_so is null or jsonb_typeof(p_so) <> 'object' then
    raise exception 'The standing order is missing.' using errcode = '22023';
  end if;
  if nullif(p_so ->> 'id', '') is not null then
    select * into v_old from stock_standing_orders o where o.id = (p_so ->> 'id')::uuid;
    if v_old.id is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
  end if;
  v_loc := coalesce(v_old.location_id, nullif(p_so ->> 'location_id', '')::uuid);
  select l.org_id into v_org from locations l where l.id = v_loc;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, public.stock_co__section(p_section, array['purchasing']), 'site_facts', array[v_loc]);
  select * into v_sup from suppliers s where s.id = coalesce(nullif(p_so ->> 'supplier_id', '')::uuid, v_old.supplier_id) and s.location_id = v_loc;
  if v_sup.id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if v_old.id is not null then
    perform 1 from stock_standing_orders o where o.id = v_old.id for update;
    if p_version is not null and p_version is distinct from v_old.row_version then
      return public.stock_co__conflict(v_org, array['standing_order'], v_old.id, v_old.row_version, v_loc, v_old.updated_at);
    end if;
  end if;
  if p_so ? 'delivery_dows' then
    if jsonb_typeof(p_so -> 'delivery_dows') <> 'array' or jsonb_array_length(p_so -> 'delivery_dows') = 0 then
      raise exception 'Pick at least one delivery day.' using errcode = '22023';
    end if;
    v_dows := array(select distinct (e #>> '{}')::smallint from jsonb_array_elements(p_so -> 'delivery_dows') e order by 1);
  else
    v_dows := v_old.delivery_dows;
  end if;
  if v_dows is null then
    raise exception 'Pick at least one delivery day.' using errcode = '22023';
  end if;
  foreach v_d in array v_dows loop
    if v_d not between 0 and 6 or not exists (select 1 from stock_order_rules o where o.supplier_id = v_sup.id and o.delivery_dow = v_d) then
      raise exception '% does not deliver to % on %.', v_sup.name, (select l.name from locations l where l.id = v_loc),
        (array['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'])[v_d + 1] using errcode = '22023';
    end if;
  end loop;
  if p_so ? 'lines' and (jsonb_typeof(p_so -> 'lines') <> 'array' or jsonb_array_length(p_so -> 'lines') > 300) then
    raise exception 'A standing order has 1 to 300 lines.' using errcode = '22023';
  end if;
  if v_old.id is null then
    insert into stock_standing_orders (org_id, location_id, supplier_id, company_supplier_id, name, delivery_dows, active, paused_until, note,
                                       created_by, created_by_name)
    values (v_org, v_loc, v_sup.id, v_sup.company_ref, nullif(btrim(coalesce(p_so ->> 'name', '')), ''), v_dows,
            coalesce((p_so ->> 'active')::boolean, true), nullif(p_so ->> 'paused_until', '')::date, nullif(p_so ->> 'note', ''),
            (v_g ->> 'uid')::uuid, v_g ->> 'name')
    returning id into v_id;
  else
    v_id := v_old.id;
    update stock_standing_orders o
       set name = case when p_so ? 'name' then nullif(btrim(coalesce(p_so ->> 'name', '')), '') else o.name end,
           delivery_dows = v_dows,
           active = case when p_so ? 'active' then coalesce((p_so ->> 'active')::boolean, true) else o.active end,
           paused_until = case when p_so ? 'paused_until' then nullif(p_so ->> 'paused_until', '')::date else o.paused_until end,
           note = case when p_so ? 'note' then nullif(p_so ->> 'note', '') else o.note end,
           row_version = o.row_version + 1, updated_at = now()
     where o.id = v_id;
  end if;
  if p_so ? 'lines' then
    for v_ln in select e from jsonb_array_elements(p_so -> 'lines') e loop
      if not exists (select 1 from inventory_items i where i.id = nullif(v_ln ->> 'inventory_item_id', '')::uuid and i.location_id = v_loc)
         or (nullif(v_ln ->> 'supplier_product_id', '') is not null
             and not exists (select 1 from supplier_products sp where sp.id = (v_ln ->> 'supplier_product_id')::uuid and sp.location_id = v_loc
                               and sp.supplier_id = v_sup.id))
         or coalesce(nullif(v_ln ->> 'qty_packs', '')::numeric, 0) <= 0 then
        raise exception 'Line %: that item is not at %.', v_n + 1, (select l.name from locations l where l.id = v_loc) using errcode = '22023';
      end if;
      v_n := v_n + 1;
    end loop;
    delete from stock_standing_order_lines sl where sl.standing_order_id = v_id;
    insert into stock_standing_order_lines (standing_order_id, location_id, inventory_item_id, supplier_product_id, qty_packs, sort_order)
    select v_id, v_loc, (e.v ->> 'inventory_item_id')::uuid, nullif(e.v ->> 'supplier_product_id', '')::uuid, (e.v ->> 'qty_packs')::numeric,
           (e.n - 1)::integer
      from jsonb_array_elements(p_so -> 'lines') with ordinality e(v, n);
  end if;
  -- over the approval limit: a company editor only (the whole save rolls back)
  if (p_so ? 'lines' or p_so ? 'supplier_id' or v_old.id is null) and coalesce(v_g ->> 'level', '') <> 'all' then
    v_why := public.stock_co__standing_over(v_loc, v_sup.id,
               (select coalesce(jsonb_agg(jsonb_build_object('inventory_item_id', sl.inventory_item_id, 'supplier_product_id', sl.supplier_product_id,
                                                             'qty_packs', sl.qty_packs)), '[]'::jsonb)
                  from stock_standing_order_lines sl where sl.standing_order_id = v_id));
    if v_why is not null then
      raise exception '%', v_why using errcode = '22023';
    end if;
  end if;
  perform public.stock_co__log(v_org, v_loc, 'standing_order', v_id, 'saved', null, to_jsonb(p_so), 'save');
  return jsonb_build_object('ok', true, 'id', v_id,
                            'row_version', (select o.row_version from stock_standing_orders o where o.id = v_id));
end
$fn$;

create or replace function public.stock_edit_standing_run(p_so uuid, p_delivery_day date, p_lines jsonb default null, p_skip boolean default false,
                                                          p_actor jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_so stock_standing_orders;
  v_org uuid;
  v_g jsonb;
  v_next jsonb;
  v_ob timestamptz;
  v_run stock_standing_runs;
  v_why text;
begin
  select * into v_so from stock_standing_orders o where o.id = p_so;
  if v_so.id is null or p_delivery_day is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_org := v_so.org_id;
  v_g := public.stock_co__d3_who(v_org, 'purchasing', 'site_facts', array[v_so.location_id], p_actor);
  select * into v_run from stock_standing_runs r where r.standing_order_id = p_so and r.delivery_day = p_delivery_day for update;
  if v_run.id is not null and v_run.status <> 'waiting' then
    raise exception 'The order by time has passed. This standing order was sent.' using errcode = '55000';
  end if;
  v_next := public.stock_co__next_delivery(v_so.supplier_id, now());
  v_ob := coalesce(v_run.order_by_at, case when (v_next ->> 'delivery_day')::date = p_delivery_day then (v_next ->> 'order_by_at')::timestamptz end);
  if v_ob is null or v_ob <= now() then
    raise exception 'The order by time has passed. This standing order was sent.' using errcode = '55000';
  end if;
  if p_lines is not null and (jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 300
       or exists (select 1 from jsonb_array_elements(p_lines) e
                   where not exists (select 1 from inventory_items i where i.id = nullif(e ->> 'inventory_item_id', '')::uuid
                                        and i.location_id = v_so.location_id)
                      or coalesce(nullif(e ->> 'qty_packs', '')::numeric, -1) < 0)) then
    raise exception 'A line names a stock item that is not at this site.' using errcode = '22023';
  end if;
  -- the site's change to one run stays within the approval limit unless a company editor makes it
  if p_lines is not null and not coalesce(p_skip, false) and coalesce(v_g ->> 'level', '') <> 'all' then
    v_why := public.stock_co__standing_over(v_so.location_id, v_so.supplier_id, p_lines);
    if v_why is not null then
      raise exception '%', v_why using errcode = '22023';
    end if;
  end if;
  insert into stock_standing_runs (standing_order_id, location_id, delivery_day, order_by_at, status, skip_reason, lines,
                                   edited_by, edited_by_name, edited_at)
  values (p_so, v_so.location_id, p_delivery_day, v_ob, case when coalesce(p_skip, false) then 'skipped' else 'waiting' end,
          case when coalesce(p_skip, false) then 'Skipped by ' || coalesce(v_g ->> 'name', 'a manager') end,
          p_lines, nullif(v_g ->> 'uid', '')::uuid, v_g ->> 'name', now())
  on conflict (standing_order_id, delivery_day) do update
     set status = excluded.status, skip_reason = excluded.skip_reason,
         lines = case when p_lines is not null then excluded.lines else stock_standing_runs.lines end,
         edited_by = excluded.edited_by, edited_by_name = excluded.edited_by_name, edited_at = now(), updated_at = now();
  return jsonb_build_object('ok', true, 'standing_order_id', p_so, 'delivery_day', p_delivery_day,
                            'status', case when coalesce(p_skip, false) then 'skipped' else 'waiting' end, 'order_by_at', v_ob);
end
$fn$;

create or replace function public.stock_save_delivery_exception(p_ex jsonb, p_version integer default null, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old stock_delivery_exceptions;
  v_org uuid;
  v_scope text;
  v_loc uuid;
  v_cs uuid;
  v_sites uuid[];
  v_g jsonb;
  v_id uuid;
  v_need text;
begin
  if p_ex is null or jsonb_typeof(p_ex) <> 'object' then
    raise exception 'The day is missing.' using errcode = '22023';
  end if;
  if nullif(p_ex ->> 'id', '') is not null then
    select * into v_old from stock_delivery_exceptions x where x.id = (p_ex ->> 'id')::uuid;
    if v_old.id is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
  end if;
  v_scope := coalesce(nullif(p_ex ->> 'scope', ''), v_old.scope);
  v_loc := case when p_ex ? 'location_id' then nullif(p_ex ->> 'location_id', '')::uuid else v_old.location_id end;
  v_cs := case when p_ex ? 'company_supplier_id' then nullif(p_ex ->> 'company_supplier_id', '')::uuid else v_old.company_supplier_id end;
  if v_scope is null or v_scope not in ('company', 'supplier', 'site') then
    raise exception 'Say who the day is for: the company, a supplier or a site.' using errcode = '22023';
  end if;
  v_org := coalesce(v_old.org_id, (select l.org_id from locations l where l.id = v_loc),
                    (select c.org_id from stock_co_suppliers c where c.id = v_cs), nullif(p_ex ->> 'org_id', '')::uuid);
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if v_cs is not null and not exists (select 1 from stock_co_suppliers c where c.id = v_cs and c.org_id = v_org) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if v_scope = 'site' then
    v_need := 'site_facts';
    v_sites := array[v_loc];
  else
    v_need := 'company';
    v_sites := public.stock_co__read_scope(v_org, null);
  end if;
  v_g := public.stock_co__guard(v_org, public.stock_co__section(p_section, array['purchasing']), v_need, v_sites);
  if v_old.id is not null then
    perform 1 from stock_delivery_exceptions x where x.id = v_old.id for update;
    perform public.stock_co__need_version(v_need, p_version);
    if p_version is not null and p_version is distinct from v_old.row_version then
      return public.stock_co__conflict(v_org, array['delivery_exception'], v_old.id, v_old.row_version, v_loc, v_old.updated_at);
    end if;
    update stock_delivery_exceptions x
       set scope = v_scope, company_supplier_id = case when v_scope = 'company' then null else v_cs end,
           location_id = case when v_scope = 'site' then v_loc else null end,
           name = coalesce(nullif(btrim(coalesce(p_ex ->> 'name', '')), ''), x.name),
           from_day = coalesce(nullif(p_ex ->> 'from_day', '')::date, x.from_day),
           to_day = coalesce(nullif(p_ex ->> 'to_day', '')::date, x.to_day),
           kind = coalesce(nullif(p_ex ->> 'kind', ''), x.kind),
           deliver_on = case when coalesce(nullif(p_ex ->> 'kind', ''), x.kind) = 'deliver_instead'
                             then coalesce(nullif(p_ex ->> 'deliver_on', '')::date, x.deliver_on) end,
           archived_at = case when coalesce((p_ex ->> 'archived')::boolean, false) then coalesce(x.archived_at, now())
                              when p_ex ? 'archived' then null else x.archived_at end,
           row_version = x.row_version + 1, updated_at = now()
     where x.id = v_old.id;
    v_id := v_old.id;
  else
    insert into stock_delivery_exceptions (org_id, scope, company_supplier_id, location_id, name, from_day, to_day, kind, deliver_on,
                                           created_by, created_by_name)
    values (v_org, v_scope, case when v_scope = 'company' then null else v_cs end, case when v_scope = 'site' then v_loc end,
            coalesce(nullif(btrim(coalesce(p_ex ->> 'name', '')), ''), 'No delivery'),
            (p_ex ->> 'from_day')::date, coalesce(nullif(p_ex ->> 'to_day', '')::date, (p_ex ->> 'from_day')::date),
            coalesce(nullif(p_ex ->> 'kind', ''), 'no_delivery'),
            case when coalesce(nullif(p_ex ->> 'kind', ''), 'no_delivery') = 'deliver_instead' then nullif(p_ex ->> 'deliver_on', '')::date end,
            (v_g ->> 'uid')::uuid, v_g ->> 'name')
    returning id into v_id;
  end if;
  perform public.stock_co__log(v_org, v_loc, 'delivery_exception', v_id, 'saved', to_jsonb(v_old), to_jsonb(p_ex), 'save');
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', (select x.row_version from stock_delivery_exceptions x where x.id = v_id));
end
$fn$;

create or replace function public.stock_save_order_list(p_list jsonb, p_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old stock_order_lists;
  v_loc uuid;
  v_org uuid;
  v_g jsonb;
  v_id uuid;
begin
  if p_list is null or jsonb_typeof(p_list) <> 'object' then
    raise exception 'The list is missing.' using errcode = '22023';
  end if;
  if nullif(p_list ->> 'id', '') is not null then
    select * into v_old from stock_order_lists o where o.id = (p_list ->> 'id')::uuid;
    if v_old.id is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
  end if;
  v_loc := coalesce(v_old.location_id, nullif(p_list ->> 'location_id', '')::uuid);
  select l.org_id into v_org from locations l where l.id = v_loc;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, 'purchasing', 'site_facts', array[v_loc]);
  if p_list ? 'lines' and (jsonb_typeof(p_list -> 'lines') <> 'array' or jsonb_array_length(p_list -> 'lines') > 300
       or exists (select 1 from jsonb_array_elements(p_list -> 'lines') e
                   where not exists (select 1 from inventory_items i where i.id = nullif(e ->> 'inventory_item_id', '')::uuid and i.location_id = v_loc))) then
    raise exception 'A line names a stock item that is not at this site.' using errcode = '22023';
  end if;
  if v_old.id is not null then
    perform 1 from stock_order_lists o where o.id = v_old.id for update;
    if p_version is not null and p_version is distinct from v_old.row_version then
      return public.stock_co__conflict(v_org, array['order_list'], v_old.id, v_old.row_version, v_loc, v_old.updated_at);
    end if;
    update stock_order_lists o
       set name = coalesce(nullif(btrim(coalesce(p_list ->> 'name', '')), ''), o.name),
           supplier_id = case when p_list ? 'supplier_id' then nullif(p_list ->> 'supplier_id', '')::uuid else o.supplier_id end,
           lines = coalesce(case when p_list ? 'lines' then p_list -> 'lines' end, o.lines),
           archived_at = case when coalesce((p_list ->> 'archived')::boolean, false) then coalesce(o.archived_at, now())
                              when p_list ? 'archived' then null else o.archived_at end,
           row_version = o.row_version + 1, updated_at = now()
     where o.id = v_old.id;
    v_id := v_old.id;
  else
    if nullif(btrim(coalesce(p_list ->> 'name', '')), '') is null then
      raise exception 'Give the list a name.' using errcode = '22023';
    end if;
    insert into stock_order_lists (org_id, location_id, name, supplier_id, lines, created_by, created_by_name)
    values (v_org, v_loc, btrim(p_list ->> 'name'), nullif(p_list ->> 'supplier_id', '')::uuid, coalesce(p_list -> 'lines', '[]'::jsonb),
            (v_g ->> 'uid')::uuid, v_g ->> 'name')
    returning id into v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', (select o.row_version from stock_order_lists o where o.id = v_id));
end
$fn$;

-- Due to order (map 4.10): every site supplier that can order with rules, keyset (order_by_at, location_id,
-- supplier_id). A delivery whose order by passed today with nothing ordered is 'missed'.
create or replace function public.stock_due_to_order(p_org uuid, p_sites uuid[], p_after jsonb default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_scope uuid[];
  v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_rows jsonb := '[]'::jsonb;
  r record;
  v_first jsonb;
  v_pick jsonb;
  v_day date;
  v_ob timestamptz;
  v_status text;
  v_po uuid;
  v_out jsonb;
begin
  v_scope := public.stock_co__d3_scope(p_org, p_sites);
  for r in
    select s.id, s.name, s.location_id, l.name as site_name, public.stock_co__tz(s.location_id) as tz
      from suppliers s join locations l on l.id = s.location_id
     where s.location_id = any(v_scope) and s.archived_at is null
       and exists (select 1 from stock_order_rules o where o.supplier_id = s.id)
       and not exists (select 1 from stock_co_suppliers c where c.id = s.company_ref and c.archived_at is not null)
     order by s.location_id, s.id
     limit 2000
  loop
    -- the first delivery whose order by is after the start of the venue's day: passed today means missed
    v_first := public.stock_co__next_delivery(r.id, (date_trunc('day', now() at time zone r.tz)) at time zone r.tz);
    if v_first is null then
      continue;
    end if;
    v_pick := v_first;
    if (v_first ->> 'order_by_at')::timestamptz <= now() then
      if exists (select 1 from purchase_orders po where po.supplier_id = r.id and po.location_id = r.location_id
                    and po.status in ('DRAFT', 'SENT', 'PARTIAL', 'RECEIVED')
                    and (po.expected_date = (v_first ->> 'delivery_day')::date
                         or coalesce(po.ordered_at, po.created_at) >= (v_first ->> 'order_by_at')::timestamptz - interval '7 days'))
         or exists (select 1 from stock_standing_orders so where so.supplier_id = r.id and so.active
                       and extract(dow from (v_first ->> 'delivery_day')::date)::smallint = any(so.delivery_dows)) then
        v_pick := public.stock_co__next_delivery(r.id, now());
        if v_pick is null then continue; end if;
      end if;
    end if;
    v_day := (v_pick ->> 'delivery_day')::date;
    v_ob := (v_pick ->> 'order_by_at')::timestamptz;
    v_po := null;
    select po.id into v_po from purchase_orders po
     where po.supplier_id = r.id and po.location_id = r.location_id and po.status in ('DRAFT', 'SENT', 'PARTIAL', 'RECEIVED')
       and (po.expected_date = v_day or (po.expected_date is null and coalesce(po.ordered_at, po.created_at) >= v_ob - interval '7 days'))
     order by po.created_at desc limit 1;
    v_status := case
      when exists (select 1 from stock_standing_runs sr join stock_standing_orders so on so.id = sr.standing_order_id
                    where so.supplier_id = r.id and sr.delivery_day = v_day and sr.status = 'held') then 'held'
      when exists (select 1 from stock_po_approvals a where a.supplier_id = r.id and a.location_id = r.location_id
                      and a.status in ('waiting', 'sent_back') and (a.delivery_day = v_day or a.po_id = v_po)) then 'waiting_approval'
      when v_po is not null then 'ordered'
      when exists (select 1 from stock_standing_orders so where so.supplier_id = r.id and so.active
                      and (so.paused_until is null or so.paused_until < v_day)
                      and extract(dow from v_day)::smallint = any(so.delivery_dows)) then 'standing'
      when v_ob <= now() then 'missed'
      else 'not_yet' end;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('location_id', r.location_id, 'site_name', r.site_name, 'supplier_id', r.id,
                'supplier_name', r.name, 'delivery_day', v_day, 'order_by_at', v_ob, 'status', v_status, 'po_id', v_po));
  end loop;
  with s as (
    select e, (e ->> 'order_by_at')::timestamptz as ob, (e ->> 'location_id')::uuid as loc, (e ->> 'supplier_id')::uuid as sup
      from jsonb_array_elements(v_rows) e
  ), f as (
    select * from s
     where p_after is null
        or (s.ob, s.loc, s.sup) > ((p_after ->> 'order_by_at')::timestamptz, (p_after ->> 'location_id')::uuid, (p_after ->> 'supplier_id')::uuid)
     order by s.ob, s.loc, s.sup
     limit v_lim + 1
  ), n as (select f.*, row_number() over (order by f.ob, f.loc, f.sup) as rn from f)
  select jsonb_build_object(
           'rows', coalesce((select jsonb_agg(n.e order by n.rn) from n where n.rn <= v_lim), '[]'::jsonb),
           'next', (select jsonb_build_object('order_by_at', n.ob, 'location_id', n.loc, 'supplier_id', n.sup)
                      from n where n.rn = v_lim and exists (select 1 from n m where m.rn = v_lim + 1)))
    into v_out;
  return v_out;
end
$fn$;

create or replace function public.stock_orders_page(p_org uuid, p_sites uuid[], p_status text default null, p_filters jsonb default null,
                                                    p_after jsonb default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_scope uuid[];
  v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_uid uuid := auth.uid();
  v_editor boolean;
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_out jsonb;
begin
  v_scope := public.stock_co__d3_scope(p_org, p_sites);
  v_editor := public.stock_level(v_uid, p_org) = 'all';
  with o as (
    select po.*, l.name as site_name, s.name as supplier_name, c.internal_location_id, a.id as a_id, a.status as a_status, a.step as a_step,
           a.order_by_at as a_ob, a.raised_by, a.raised_by_name, a.raised_by_staff_id,
           case when a.status = 'waiting' then 0 else 1 end as g,
           coalesce(po.ordered_at, '-infinity'::timestamptz) as at
      from purchase_orders po
      join locations l on l.id = po.location_id
      left join suppliers s on s.id = po.supplier_id
      left join stock_co_suppliers c on c.id = s.company_ref
      left join stock_po_approvals a on a.po_id = po.id
     where po.location_id = any(v_scope)
       and (p_status is null or po.status = p_status)
       and (v_f ->> 'supplier_id' is null or po.supplier_id = (v_f ->> 'supplier_id')::uuid)
       and (v_f ->> 'from' is null or po.created_at >= (v_f ->> 'from')::date)
       and (v_f ->> 'to' is null or po.created_at < (v_f ->> 'to')::date + 1)
       and (nullif(btrim(coalesce(v_f ->> 'search', '')), '') is null
            or position(lower(btrim(v_f ->> 'search')) in lower(coalesce(po.reference, '') || ' ' || coalesce(s.name, ''))) > 0)
  ), k as (
    select * from o
     where p_after is null
        or o.g > (p_after ->> 'g')::integer
        or (o.g = (p_after ->> 'g')::integer and (o.at < (p_after ->> 'at')::timestamptz
                                                  or (o.at = (p_after ->> 'at')::timestamptz and o.id > (p_after ->> 'id')::uuid)))
     order by o.g, o.at desc, o.id
     limit v_lim + 1
  ), n as (select k.*, row_number() over (order by k.g, k.at desc, k.id) as rn from k)
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
               'id', n.id, 'location_id', n.location_id, 'site_name', n.site_name, 'supplier_name', n.supplier_name, 'reference', n.reference,
               'status', n.status, 'expected_date', n.expected_date, 'ordered_at', n.ordered_at, 'subtotal', n.subtotal,
               'delivery_fee', n.delivery_fee, 'internal', n.internal_location_id is not null,
               'approval', case when n.a_id is null then null else jsonb_build_object(
                             'status', n.a_status, 'step', n.a_step, 'order_by_at', n.a_ob, 'raised_by_name', n.raised_by_name,
                             'can_decide', n.a_status = 'waiting' and not public.stock_co__is_raiser(v_uid, n.raised_by, n.raised_by_staff_id)
                                           and (v_editor or exists (select 1 from user_locations ul
                                                                     where ul.user_id = v_uid and ul.location_id = n.location_id))) end,
               'transfer_id', (select t.id from stock_transfers t where t.purchase_order_id = n.id))
             order by n.rn) from n where n.rn <= v_lim), '[]'::jsonb),
    'next', (select jsonb_build_object('g', n.g, 'at', n.at, 'id', n.id) from n
              where n.rn = v_lim and exists (select 1 from n m where m.rn = v_lim + 1)))
    into v_out;
  return v_out;
end
$fn$;

create or replace function public.stock_deliveries_board(p_org uuid, p_sites uuid[], p_after jsonb default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_scope uuid[];
  v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_rows jsonb;
  v_next jsonb;
begin
  v_scope := public.stock_co__d3_scope(p_org, p_sites);
  with o as (
    select po.id, po.location_id, po.reference, po.expected_date, l.name as site_name, s.name as supplier_name,
           c.internal_location_id is not null as internal, public.stock_co__today(po.location_id) as today,
           coalesce(po.expected_date, 'infinity'::date) as ed
      from purchase_orders po
      join locations l on l.id = po.location_id
      left join suppliers s on s.id = po.supplier_id
      left join stock_co_suppliers c on c.id = s.company_ref
     where po.location_id = any(v_scope) and po.status in ('SENT', 'PARTIAL')
  ), k as (
    select * from o
     where p_after is null or (o.ed, o.id) > ((p_after ->> 'ed')::date, (p_after ->> 'id')::uuid)
     order by o.ed, o.id limit v_lim + 1
  ), n as (select k.*, row_number() over (order by k.ed, k.id) as rn from k)
  select coalesce(jsonb_agg(jsonb_build_object(
           'po_id', n.id, 'location_id', n.location_id, 'site_name', n.site_name, 'supplier_name', n.supplier_name, 'reference', n.reference,
           'expected_date', n.expected_date,
           'lines', (select count(*) from po_lines pl where pl.po_id = n.id),
           'part_saved', exists (select 1 from po_lines pl where pl.po_id = n.id and pl.qty_draft is not null),
           'internal', n.internal,
           'transfer_id', (select t.id from stock_transfers t where t.purchase_order_id = n.id),
           'transfer_status', (select t.status from stock_transfers t where t.purchase_order_id = n.id),
           'held', exists (select 1 from stock_standing_runs sr where sr.po_id = n.id and sr.status = 'held'),
           'bucket', case when n.internal then 'kitchen' when n.expected_date < n.today then 'overdue'
                          when n.expected_date = n.today then 'today' else 'coming' end) order by n.rn) filter (where n.rn <= v_lim), '[]'::jsonb),
         (select jsonb_build_object('ed', m.ed, 'id', m.id) from n m where m.rn = v_lim and exists (select 1 from n x where x.rn = v_lim + 1))
    into v_rows, v_next
    from n;
  return jsonb_build_object(
    'today', coalesce((select jsonb_agg(e - 'bucket') from jsonb_array_elements(v_rows) e where e ->> 'bucket' = 'today'), '[]'::jsonb),
    'coming', coalesce((select jsonb_agg(e - 'bucket') from jsonb_array_elements(v_rows) e where e ->> 'bucket' = 'coming'), '[]'::jsonb),
    'overdue', coalesce((select jsonb_agg(e - 'bucket') from jsonb_array_elements(v_rows) e where e ->> 'bucket' = 'overdue'), '[]'::jsonb),
    'kitchen', coalesce((select jsonb_agg(e - 'bucket') from jsonb_array_elements(v_rows) e where e ->> 'bucket' = 'kitchen'), '[]'::jsonb),
    'next', v_next);
end
$fn$;

create or replace function public.stock_invoices_page(p_org uuid, p_sites uuid[], p_filters jsonb default null, p_after jsonb default null,
                                                      p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_scope uuid[];
  v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_out jsonb;
begin
  v_scope := public.stock_co__d3_scope(p_org, p_sites);
  with o as (
    select i.*, l.name as site_name, s.name as supplier_name, po.reference as po_reference,
           coalesce(i.invoice_date, i.created_at::date) as d
      from supplier_invoices i
      join locations l on l.id = i.location_id
      left join suppliers s on s.id = i.supplier_id
      left join purchase_orders po on po.id = i.po_id
     where i.location_id = any(v_scope)
       and not exists (select 1 from suppliers ps join stock_co_suppliers c on c.id = ps.company_ref
                        where ps.id = coalesce(po.supplier_id, i.supplier_id) and c.internal_location_id is not null)
       and (v_f ->> 'supplier_id' is null or i.supplier_id = (v_f ->> 'supplier_id')::uuid)
       and (v_f ->> 'status' is null or i.status = v_f ->> 'status')
       and (v_f ->> 'match_status' is null or i.match_status = v_f ->> 'match_status')
       and (v_f ->> 'from' is null or coalesce(i.invoice_date, i.created_at::date) >= (v_f ->> 'from')::date)
       and (v_f ->> 'to' is null or coalesce(i.invoice_date, i.created_at::date) <= (v_f ->> 'to')::date)
       and (nullif(btrim(coalesce(v_f ->> 'search', '')), '') is null
            or position(lower(btrim(v_f ->> 'search')) in lower(coalesce(i.invoice_number, '') || ' ' || coalesce(s.name, ''))) > 0)
  ), k as (
    select * from o
     where p_after is null or o.d < (p_after ->> 'd')::date or (o.d = (p_after ->> 'd')::date and o.id > (p_after ->> 'id')::uuid)
     order by o.d desc, o.id limit v_lim + 1
  ), n as (select k.*, row_number() over (order by k.d desc, k.id) as rn from k)
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
               'id', n.id, 'location_id', n.location_id, 'site_name', n.site_name, 'supplier_name', n.supplier_name,
               'invoice_number', n.invoice_number, 'invoice_date', n.invoice_date, 'status', n.status, 'total', n.total,
               'match_status', n.match_status, 'approved_at', n.approved_at, 'locked_at', n.locked_at, 'po_reference', n.po_reference,
               'splits', (select count(*) from supplier_invoice_site_splits x where x.invoice_id = n.id)) order by n.rn)
             from n where n.rn <= v_lim), '[]'::jsonb),
    'next', (select jsonb_build_object('d', n.d, 'id', n.id) from n where n.rn = v_lim and exists (select 1 from n m where m.rn = v_lim + 1)))
    into v_out;
  return v_out;
end
$fn$;

create or replace function public.stock_missing_invoices(p_org uuid, p_sites uuid[], p_after jsonb default null, p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_scope uuid[];
  v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_out jsonb;
begin
  v_scope := public.stock_co__d3_scope(p_org, p_sites);
  with o as (
    select po.id, po.location_id, po.reference, po.received_at, po.subtotal, l.name as site_name, s.name as supplier_name,
           coalesce(po.received_at, po.updated_at) as at
      from purchase_orders po
      join locations l on l.id = po.location_id
      left join suppliers s on s.id = po.supplier_id
      left join stock_co_suppliers c on c.id = s.company_ref
     where po.location_id = any(v_scope) and po.status = 'RECEIVED' and c.internal_location_id is null
       and public.stock_co__vday(po.location_id, coalesce(po.received_at, po.updated_at)) < public.stock_co__today(po.location_id) - 7
       and not exists (select 1 from supplier_invoices i where i.po_id = po.id)
  ), k as (
    select * from o
     where p_after is null or o.at < (p_after ->> 'at')::timestamptz or (o.at = (p_after ->> 'at')::timestamptz and o.id > (p_after ->> 'id')::uuid)
     order by o.at desc, o.id limit v_lim + 1
  ), n as (select k.*, row_number() over (order by k.at desc, k.id) as rn from k)
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object('po_id', n.id, 'location_id', n.location_id, 'site_name', n.site_name,
                                                          'supplier_name', n.supplier_name, 'reference', n.reference,
                                                          'received_at', n.received_at, 'subtotal', n.subtotal) order by n.rn)
                        from n where n.rn <= v_lim), '[]'::jsonb),
    'next', (select jsonb_build_object('at', n.at, 'id', n.id) from n where n.rn = v_lim and exists (select 1 from n m where m.rn = v_lim + 1)))
    into v_out;
  return v_out;
end
$fn$;

create or replace function public.stock_invoice_match(p_invoice uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_inv supplier_invoices;
  v_org uuid;
begin
  select * into v_inv from supplier_invoices i where i.id = p_invoice;
  select l.org_id into v_org from locations l where l.id = v_inv.location_id;
  if v_inv.id is null or v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__guard(v_org, 'purchasing', 'site_facts', array[v_inv.location_id]);
  if v_inv.locked_at is not null then
    return jsonb_build_object('ok', true, 'locked', true, 'match_status', v_inv.match_status, 'lines', v_inv.match_detail);
  end if;
  return jsonb_build_object('ok', true) || public.stock_co__match_invoice(p_invoice);
end
$fn$;

create or replace function public.stock_invoices_approve(p_ids uuid[], p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_sites uuid[];
  v_g jsonb;
  r record;
  v_n integer := 0;
  v_skip jsonb := '[]'::jsonb;
begin
  if p_ids is null or cardinality(p_ids) = 0 then
    raise exception 'Pick at least one invoice.' using errcode = '22023';
  end if;
  if cardinality(p_ids) > 100 then
    raise exception 'Pick 100 invoices or fewer.' using errcode = '22023';
  end if;
  select min(l.org_id::text)::uuid, count(distinct l.org_id), array_agg(distinct i.location_id)
    into v_org, v_n, v_sites
    from supplier_invoices i join locations l on l.id = i.location_id where i.id = any(p_ids);
  if v_org is null or v_n <> 1 or (select count(*) from supplier_invoices i where i.id = any(p_ids)) <> cardinality(array(select distinct x from unnest(p_ids) x)) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, 'purchasing', 'site_facts', v_sites);
  v_n := 0;
  for r in select i.id, i.locked_at, i.match_status, i.approved_at from supplier_invoices i where i.id = any(p_ids) order by i.id for update loop
    if r.locked_at is not null then
      v_skip := v_skip || jsonb_build_array(jsonb_build_object('id', r.id, 'words', 'This invoice was sent to Xero and is locked.'));
      continue;
    end if;
    update supplier_invoices i
       set approved_at = coalesce(i.approved_at, now()), approved_by_name = coalesce(i.approved_by_name, v_g ->> 'name'),
           match_status = case when i.match_status = 'matched' then i.match_status else 'by_hand' end, updated_at = now()
     where i.id = r.id;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'approved', v_n, 'skipped', v_skip);
end
$fn$;

create or replace function public.stock_invoice_split(p_invoice uuid, p_splits jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_inv supplier_invoices;
  v_org uuid;
  v_cur text;
  v_sites uuid[];
  v_g jsonb;
  v_sum numeric;
begin
  select * into v_inv from supplier_invoices i where i.id = p_invoice for update;
  select l.org_id, l.currency into v_org, v_cur from locations l where l.id = v_inv.location_id;
  if v_inv.id is null or v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_splits is null or jsonb_typeof(p_splits) <> 'array' or jsonb_array_length(p_splits) = 0 or jsonb_array_length(p_splits) > 50 then
    raise exception 'Add 1 to 50 sites to split the invoice.' using errcode = '22023';
  end if;
  select array_agg(distinct x) into v_sites
    from (select (e ->> 'location_id')::uuid as x from jsonb_array_elements(p_splits) e union select v_inv.location_id) z;
  v_g := public.stock_co__guard(v_org, 'purchasing', 'company', v_sites);
  if v_inv.locked_at is not null then
    raise exception 'This invoice was sent to Xero and is locked.' using errcode = '55000';
  end if;
  select coalesce(sum(round(coalesce(nullif(e ->> 'amount', '')::numeric, 0), 2)), 0) into v_sum from jsonb_array_elements(p_splits) e;
  if abs(v_sum - coalesce(v_inv.total, 0)) > 0.01 then
    raise exception 'The splits add up to %, the invoice is %.', public.stock_co__money(v_cur, v_sum), public.stock_co__money(v_cur, coalesce(v_inv.total, 0))
      using errcode = '22023';
  end if;
  delete from supplier_invoice_site_splits x where x.invoice_id = p_invoice;
  insert into supplier_invoice_site_splits (org_id, invoice_id, location_id, amount, tax, basis, po_id, note, created_by, created_by_name)
  select v_org, p_invoice, (e ->> 'location_id')::uuid, round((e ->> 'amount')::numeric, 2), round(coalesce(nullif(e ->> 'tax', '')::numeric, 0), 2),
         coalesce(nullif(e ->> 'basis', ''), 'by_hand'), nullif(e ->> 'po_id', '')::uuid, nullif(e ->> 'note', ''),
         (v_g ->> 'uid')::uuid, v_g ->> 'name'
    from jsonb_array_elements(p_splits) e;
  return jsonb_build_object('ok', true, 'invoice_id', p_invoice, 'splits', jsonb_array_length(p_splits));
end
$fn$;

create or replace function public.stock_invoice_inbox_page(p_org uuid, p_status text default 'waiting', p_after jsonb default null,
                                                           p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_scope uuid[];
  v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_out jsonb;
begin
  v_scope := public.stock_co__read_scope(p_org, null);
  with o as (
    select b.*, c.name as supplier_name, l.name as site_name from stock_invoice_inbox b
      left join stock_co_suppliers c on c.id = b.company_supplier_id
      left join locations l on l.id = b.location_id
     where b.org_id = p_org and (p_status is null or b.status = p_status) and (b.location_id is null or b.location_id = any(v_scope))
  ), k as (
    select * from o
     where p_after is null or o.created_at < (p_after ->> 'at')::timestamptz
        or (o.created_at = (p_after ->> 'at')::timestamptz and o.id > (p_after ->> 'id')::uuid)
     order by o.created_at desc, o.id limit v_lim + 1
  ), n as (select k.*, row_number() over (order by k.created_at desc, k.id) as rn from k)
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'status', n.status, 'source', n.source, 'from_email', n.from_email,
               'subject', n.subject, 'file_name', n.file_name, 'file_path', n.file_path, 'account_number', n.account_number,
               'supplier_name', n.supplier_name, 'location_id', n.location_id, 'site_name', n.site_name, 'placed_how', n.placed_how,
               'created_at', n.created_at) order by n.rn) from n where n.rn <= v_lim), '[]'::jsonb),
    'next', (select jsonb_build_object('at', n.created_at, 'id', n.id) from n where n.rn = v_lim and exists (select 1 from n m where m.rn = v_lim + 1)))
    into v_out;
  return v_out;
end
$fn$;

create or replace function public.stock_inbox_place(p_inbox uuid, p_location uuid, p_company_supplier uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v stock_invoice_inbox;
  v_g jsonb;
begin
  select * into v from stock_invoice_inbox b where b.id = p_inbox for update;
  if v.id is null or not exists (select 1 from locations l where l.id = p_location and l.org_id = v.org_id) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v.org_id, 'purchasing', 'site_facts', array[p_location]);
  if p_company_supplier is not null and not exists (select 1 from stock_co_suppliers c where c.id = p_company_supplier and c.org_id = v.org_id) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  update stock_invoice_inbox b
     set location_id = p_location, company_supplier_id = coalesce(p_company_supplier, b.company_supplier_id),
         status = case when b.status = 'posted' then b.status else 'placed' end, placed_how = 'by_hand',
         placed_by = (v_g ->> 'uid')::uuid, placed_by_name = v_g ->> 'name', placed_at = now(), updated_at = now()
   where b.id = p_inbox;
  return jsonb_build_object('ok', true, 'id', p_inbox, 'location_id', p_location);
end
$fn$;

create or replace function public.stock_inbox_ignore(p_inbox uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v stock_invoice_inbox;
begin
  select * into v from stock_invoice_inbox b where b.id = p_inbox for update;
  if v.id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__guard(v.org_id, 'purchasing', 'company', public.stock_co__read_scope(v.org_id, null));
  update stock_invoice_inbox b set status = 'ignored', updated_at = now() where b.id = p_inbox and b.status <> 'posted';
  return jsonb_build_object('ok', true, 'id', p_inbox);
end
$fn$;

create or replace function public.stock_inbox_address(p_org uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_token text;
begin
  perform public.stock_co__guard(p_org, 'purchasing', 'company', public.stock_co__read_scope(p_org, null));
  insert into stock_co_settings (org_id) values (p_org) on conflict (org_id) do nothing;
  update stock_co_settings s set inbox_token = substr(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 1, 24)
   where s.org_id = p_org and s.inbox_token is null;
  select s.inbox_token into v_token from stock_co_settings s where s.org_id = p_org;
  -- the inbound address waits for an email provider (open question 15): Upload only until then
  return jsonb_build_object('token', v_token, 'address', null);
end
$fn$;

create or replace function public.stock_inbox_add(p_org uuid, p_file_path text, p_file_name text, p_mime text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_g jsonb;
  v_id uuid;
  v_how text;
begin
  v_g := public.stock_co__guard(p_org, 'purchasing', 'company', public.stock_co__read_scope(p_org, null));
  if p_file_path is null or left(p_file_path, length('org/' || p_org::text || '/')) <> 'org/' || p_org::text || '/' then
    raise exception 'That file is not in this company''s inbox.' using errcode = '22023';
  end if;
  insert into stock_invoice_inbox (org_id, source, file_path, file_name, mime, placed_by, placed_by_name)
  values (p_org, 'upload', p_file_path, nullif(btrim(coalesce(p_file_name, '')), ''), nullif(btrim(coalesce(p_mime, '')), ''), null, null)
  returning id into v_id;
  v_how := public.stock_co__inbox_place_auto(v_id);
  return jsonb_build_object('ok', true, 'id', v_id, 'placed_how', v_how);
end
$fn$;

create or replace function public.stock_inbox_receive(p_token text, p_from text, p_subject text, p_files jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_f jsonb;
  v_id uuid;
  v_how text;
  v_out jsonb := '[]'::jsonb;
begin
  if not public.stock_co__is_service() then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select s.org_id into v_org from stock_co_settings s where s.inbox_token = nullif(btrim(coalesce(p_token, '')), '');
  if v_org is null then
    return jsonb_build_object('ok', false, 'error', 'No company has this inbox address.');
  end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) > 20 then
    raise exception 'Send 1 to 20 files.' using errcode = '22023';
  end if;
  for v_f in select e from jsonb_array_elements(p_files) e loop
    if left(coalesce(v_f ->> 'file_path', ''), length('org/' || v_org::text || '/')) <> 'org/' || v_org::text || '/' then
      raise exception 'That file is not in this company''s inbox.' using errcode = '22023';
    end if;
    insert into stock_invoice_inbox (org_id, source, from_email, subject, file_path, file_name, mime, scan, account_number, delivery_address)
    values (v_org, 'email', left(p_from, 320), left(p_subject, 500), v_f ->> 'file_path', v_f ->> 'file_name', v_f ->> 'mime',
            case when jsonb_typeof(v_f -> 'scan') = 'object' then v_f -> 'scan' end,
            nullif(btrim(coalesce(v_f #>> '{scan,account_number}', '')), ''), nullif(btrim(coalesce(v_f #>> '{scan,delivery_address}', '')), ''))
    returning id into v_id;
    v_how := public.stock_co__inbox_place_auto(v_id);
    if v_how is null then
      perform public.stock_co__notify(v_org, null, 'invoice_unplaced', v_id::text,
        jsonb_build_object('title', 'Invoice needs a site', 'body', coalesce(v_f ->> 'file_name', 'An invoice') || ' could not be placed',
                           'route', 'invoices', 'focus', jsonb_build_object('tab', 'inbox')));
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('id', v_id, 'placed_how', v_how));
  end loop;
  return jsonb_build_object('ok', true, 'rows', v_out);
end
$fn$;

create or replace function public.stock_save_credit_request(p_req jsonb, p_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old stock_credit_requests;
  v_loc uuid;
  v_org uuid;
  v_g jsonb;
  v_id uuid;
begin
  if p_req is null or jsonb_typeof(p_req) <> 'object' then
    raise exception 'The credit request is missing.' using errcode = '22023';
  end if;
  if nullif(p_req ->> 'id', '') is not null then
    select * into v_old from stock_credit_requests r where r.id = (p_req ->> 'id')::uuid;
    if v_old.id is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
  end if;
  v_loc := coalesce(v_old.location_id, nullif(p_req ->> 'location_id', '')::uuid);
  select l.org_id into v_org from locations l where l.id = v_loc;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, 'purchasing', 'site_facts', array[v_loc]);
  if p_req ? 'lines' and (jsonb_typeof(p_req -> 'lines') <> 'array' or jsonb_array_length(p_req -> 'lines') > 300) then
    raise exception 'A credit request has up to 300 lines.' using errcode = '22023';
  end if;
  if nullif(p_req ->> 'supplier_id', '') is not null
     and not exists (select 1 from suppliers s where s.id = (p_req ->> 'supplier_id')::uuid and s.location_id = v_loc) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if (nullif(p_req ->> 'invoice_id', '') is not null
      and not exists (select 1 from supplier_invoices i where i.id = (p_req ->> 'invoice_id')::uuid and i.location_id = v_loc))
     or (nullif(p_req ->> 'po_id', '') is not null
         and not exists (select 1 from purchase_orders po where po.id = (p_req ->> 'po_id')::uuid and po.location_id = v_loc)) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if v_old.id is not null then
    perform 1 from stock_credit_requests r where r.id = v_old.id for update;
    if p_version is not null and p_version is distinct from v_old.row_version then
      return public.stock_co__conflict(v_org, array['credit_request'], v_old.id, v_old.row_version, v_loc, v_old.updated_at);
    end if;
    update stock_credit_requests r
       set supplier_id = case when p_req ? 'supplier_id' then nullif(p_req ->> 'supplier_id', '')::uuid else r.supplier_id end,
           invoice_id = case when p_req ? 'invoice_id' then nullif(p_req ->> 'invoice_id', '')::uuid else r.invoice_id end,
           po_id = case when p_req ? 'po_id' then nullif(p_req ->> 'po_id', '')::uuid else r.po_id end,
           reason = coalesce(nullif(p_req ->> 'reason', ''), r.reason),
           note = case when p_req ? 'note' then nullif(p_req ->> 'note', '') else r.note end,
           row_version = r.row_version + 1, updated_at = now()
     where r.id = v_old.id;
    v_id := v_old.id;
  else
    insert into stock_credit_requests (org_id, location_id, supplier_id, invoice_id, po_id, reason, note, created_by, created_by_name)
    values (v_org, v_loc, nullif(p_req ->> 'supplier_id', '')::uuid, nullif(p_req ->> 'invoice_id', '')::uuid, nullif(p_req ->> 'po_id', '')::uuid,
            coalesce(nullif(p_req ->> 'reason', ''), 'other'), nullif(p_req ->> 'note', ''), (v_g ->> 'uid')::uuid, v_g ->> 'name')
    returning id into v_id;
  end if;
  if p_req ? 'lines' then
    delete from stock_credit_request_lines x where x.request_id = v_id;
    insert into stock_credit_request_lines (request_id, location_id, inventory_item_id, description, qty, unit_price_charged, unit_price_agreed,
                                            amount, sort_order)
    select v_id, v_loc,
           (select i.id from inventory_items i where i.id = nullif(e.v ->> 'inventory_item_id', '')::uuid and i.location_id = v_loc),
           coalesce(nullif(btrim(coalesce(e.v ->> 'description', '')), ''), 'A line'), coalesce(nullif(e.v ->> 'qty', '')::numeric, 0),
           nullif(e.v ->> 'unit_price_charged', '')::numeric, nullif(e.v ->> 'unit_price_agreed', '')::numeric,
           round(coalesce(nullif(e.v ->> 'amount', '')::numeric, 0), 2), (e.n - 1)::integer
      from jsonb_array_elements(p_req -> 'lines') with ordinality e(v, n);
  end if;
  update stock_credit_requests r
     set amount = (select coalesce(sum(x.amount), 0) from stock_credit_request_lines x where x.request_id = v_id)
   where r.id = v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', (select r.row_version from stock_credit_requests r where r.id = v_id),
                            'amount', (select r.amount from stock_credit_requests r where r.id = v_id));
end
$fn$;

create or replace function public.stock_credit_set_status(p_id uuid, p_status text, p_version integer, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old stock_credit_requests;
begin
  select * into v_old from stock_credit_requests r where r.id = p_id for update;
  if v_old.id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_status is null or p_status not in ('asked', 'received', 'written_off') then
    raise exception 'Choose asked, received or written off.' using errcode = '22023';
  end if;
  perform public.stock_co__guard(v_old.org_id, 'purchasing', case when p_status = 'written_off' then 'company' else 'site_facts' end,
                                 array[v_old.location_id]);
  if p_status = 'asked' and v_old.status <> 'written_off' then
    raise exception 'Only a written off credit goes back to asked.' using errcode = '22023';
  end if;
  if p_version is not null and p_version is distinct from v_old.row_version then
    return public.stock_co__conflict(v_old.org_id, array['credit_request'], v_old.id, v_old.row_version, v_old.location_id, v_old.updated_at);
  end if;
  update stock_credit_requests r
     set status = p_status, note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), r.note), row_version = r.row_version + 1, updated_at = now()
   where r.id = p_id;
  perform public.stock_co__log(v_old.org_id, v_old.location_id, 'credit_request', p_id, 'status', to_jsonb(v_old.status), to_jsonb(p_status), 'save');
  return jsonb_build_object('ok', true, 'id', p_id, 'status', p_status, 'row_version', v_old.row_version + 1);
end
$fn$;

create or replace function public.stock_save_credit_note(p_note jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_loc uuid;
  v_org uuid;
  v_g jsonb;
  v_id uuid;
  v_req stock_credit_requests;
begin
  if p_note is null or jsonb_typeof(p_note) <> 'object' then
    raise exception 'The credit note is missing.' using errcode = '22023';
  end if;
  v_loc := nullif(p_note ->> 'location_id', '')::uuid;
  select l.org_id into v_org from locations l where l.id = v_loc;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, 'purchasing', 'site_facts', array[v_loc]);
  if nullif(p_note ->> 'request_id', '') is not null then
    select * into v_req from stock_credit_requests r where r.id = (p_note ->> 'request_id')::uuid and r.location_id = v_loc for update;
    if v_req.id is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
  end if;
  if coalesce(nullif(p_note ->> 'amount', '')::numeric, -1) < 0 then
    raise exception 'Type the amount of the credit note.' using errcode = '22023';
  end if;
  insert into stock_credit_notes (org_id, location_id, supplier_id, request_id, number, note_date, amount, tax, image_path, created_by, created_by_name)
  values (v_org, v_loc, (select s.id from suppliers s where s.id = nullif(p_note ->> 'supplier_id', '')::uuid and s.location_id = v_loc),
          v_req.id, nullif(btrim(coalesce(p_note ->> 'number', '')), ''), coalesce(nullif(p_note ->> 'note_date', '')::date, current_date),
          round((p_note ->> 'amount')::numeric, 2), round(coalesce(nullif(p_note ->> 'tax', '')::numeric, 0), 2), nullif(p_note ->> 'image_path', ''),
          (v_g ->> 'uid')::uuid, v_g ->> 'name')
  returning id into v_id;
  if v_req.id is not null and v_req.status = 'asked'
     and (select coalesce(sum(n.amount), 0) from stock_credit_notes n where n.request_id = v_req.id) >= v_req.amount then
    update stock_credit_requests r set status = 'received', row_version = r.row_version + 1, updated_at = now() where r.id = v_req.id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id,
                            'request_status', (select r.status from stock_credit_requests r where r.id = v_req.id));
end
$fn$;

create or replace function public.stock_credits_page(p_org uuid, p_sites uuid[], p_status text default null, p_after jsonb default null,
                                                     p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_scope uuid[];
  v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_out jsonb;
begin
  v_scope := public.stock_co__d3_scope(p_org, p_sites);
  with k as (
    select r.* from stock_credit_requests r
     where r.location_id = any(v_scope) and (p_status is null or r.status = p_status)
       and (p_after is null or r.created_at < (p_after ->> 'at')::timestamptz
            or (r.created_at = (p_after ->> 'at')::timestamptz and r.id > (p_after ->> 'id')::uuid))
     order by r.created_at desc, r.id limit v_lim + 1
  ), n as (select k.*, row_number() over (order by k.created_at desc, k.id) as rn from k)
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(n) - 'rn' || jsonb_build_object(
               'site_name', (select l.name from locations l where l.id = n.location_id),
               'supplier_name', (select s.name from suppliers s where s.id = n.supplier_id),
               'lines', coalesce((select jsonb_agg(to_jsonb(x) order by x.sort_order, x.id) from stock_credit_request_lines x where x.request_id = n.id), '[]'::jsonb),
               'notes', coalesce((select jsonb_agg(to_jsonb(x) order by x.created_at, x.id) from stock_credit_notes x where x.request_id = n.id), '[]'::jsonb))
             order by n.rn) from n where n.rn <= v_lim), '[]'::jsonb),
    'next', (select jsonb_build_object('at', n.created_at, 'id', n.id) from n where n.rn = v_lim and exists (select 1 from n m where m.rn = v_lim + 1)))
    into v_out;
  return v_out;
end
$fn$;

-- Supplier prices (map 4.15): one row per change from deliveries and invoices (item_cost_history pack
-- prices), price here edits (the change log), and dated prices (waiting ones are 'coming').
create or replace function public.stock_price_changes_page(p_org uuid, p_sites uuid[], p_filters jsonb default null, p_after jsonb default null,
                                                           p_limit integer default 100)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_scope uuid[];
  v_lim integer := least(greatest(coalesce(p_limit, 100), 1), 100);
  v_f jsonb := coalesce(p_filters, '{}'::jsonb);
  v_from date;
  v_to date;
  v_out jsonb;
begin
  v_scope := public.stock_co__d3_scope(p_org, p_sites);
  v_from := coalesce((v_f ->> 'from')::date, current_date - 90);
  v_to := coalesce((v_f ->> 'to')::date, current_date + 60);
  with h as (
    select x.* from (
      select 'h:' || c.id::text as id, c.effective_from as at, c.location_id, c.inventory_item_id as item, c.supplier_product_id as sp,
             lag(c.pack_price) over (partition by c.location_id, c.inventory_item_id, c.supplier_product_id order by c.effective_from, c.id) as old,
             c.pack_price as new, c.pack_label, 'invoice'::text as source, false as coming, null::date as from_day
        from item_cost_history c
       where c.location_id = any(v_scope) and c.pack_price is not null and c.effective_from >= v_from - 120
         and c.source in ('INVOICE', 'PO_RECEIPT')) x
     where x.old is not null and x.new is distinct from x.old and x.at >= v_from and x.at < v_to + 1
  ), g as (
    select 'l:' || l.id::text as id, l.at, l.location_id, sis.site_supplier_product_id as sp,
           (l.before #>> '{}')::numeric as old, (l.after #>> '{}')::numeric as new,
           case when l.source = 'invoice' then 'invoice' else 'edit' end as source, l.entity_id as si
      from stock_change_log l
      join stock_co_supplier_item_sites sis on sis.supplier_item_id = l.entity_id and sis.location_id = l.location_id
     where l.org_id = p_org and l.location_id = any(v_scope) and l.entity = 'supplier_item_site' and l.field = 'price_here'
       and jsonb_typeof(l.after) = 'number' and l.at >= v_from and l.at < v_to + 1
  ), d as (
    select 'd:' || dp.id::text as id, coalesce(dp.applied_at, dp.from_day::timestamptz) as at, s.location_id, s.site_supplier_product_id as sp,
           sp.pack_price as old, dp.price as new, dp.status = 'waiting' as coming, dp.from_day, dp.supplier_item_id as si
      from stock_co_dated_prices dp
      join stock_co_supplier_item_sites s on s.supplier_item_id = dp.supplier_item_id and (dp.location_id is null or s.location_id = dp.location_id)
      left join supplier_products sp on sp.id = s.site_supplier_product_id
     where dp.org_id = p_org and s.location_id = any(v_scope) and dp.status in ('waiting', 'applied')
       and coalesce(dp.applied_at, dp.from_day::timestamptz) >= v_from and coalesce(dp.applied_at, dp.from_day::timestamptz) < v_to + 1
  ), u as (
    select h.id, h.at, h.location_id, h.sp, h.old, h.new, h.pack_label, h.source, h.coming, h.from_day,
           (select sis.supplier_item_id from stock_co_supplier_item_sites sis where sis.site_supplier_product_id = h.sp limit 1) as si
      from h
    union all
    select g.id, g.at, g.location_id, g.sp, g.old, g.new, null, g.source, false, null, g.si from g where g.old is distinct from g.new
    union all
    select d.id, d.at, d.location_id, d.sp, d.old, d.new, null, 'dated', d.coming, d.from_day, d.si from d
  ), f as (
    select u.*, sp.pack_description, sp.pack_qty, sp.inner_qty, sp.inner_unit, sp.inventory_item_id as site_item,
           case when coalesce(u.old, 0) > 0 then round((u.new - u.old) / u.old * 100, 1) end as pct
      from u left join supplier_products sp on sp.id = u.sp
     where (v_f ->> 'source' is null or u.source = v_f ->> 'source')
       and (v_f ->> 'supplier_id' is null or sp.supplier_id = (v_f ->> 'supplier_id')::uuid)
       and (v_f ->> 'rise_over_pct' is null or (coalesce(u.old, 0) > 0 and (u.new - u.old) / u.old * 100 > (v_f ->> 'rise_over_pct')::numeric))
  ), k as (
    select * from f
     where p_after is null or f.at < (p_after ->> 'at')::timestamptz or (f.at = (p_after ->> 'at')::timestamptz and f.id > p_after ->> 'id')
     order by f.at desc, f.id limit v_lim + 1
  ), n as (select k.*, row_number() over (order by k.at desc, k.id) as rn from k)
  select jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
               'id', n.id, 'at', n.at, 'location_id', n.location_id, 'site_name', (select l.name from locations l where l.id = n.location_id),
               'supplier_item_id', n.si, 'supplier_item_version', (select c.row_version from stock_co_supplier_items c where c.id = n.si),
               'item_name', (select i.name from inventory_items i where i.id = n.site_item),
               'supplier_name', (select s.name from supplier_products sp join suppliers s on s.id = sp.supplier_id where sp.id = n.sp),
               'pack_label', coalesce(n.pack_label, n.pack_description), 'old', n.old, 'new', n.new, 'pct', n.pct, 'source', n.source,
               'coming', n.coming, 'from_day', n.from_day,
               'cost_effect_4w', case when n.old is null or n.site_item is null then null else round(
                   (n.new - n.old) / nullif(coalesce(public.stock_qty_to_base(coalesce(n.pack_qty, 1) * coalesce(n.inner_qty, 1), n.inner_unit, n.site_item),
                                                     coalesce(n.pack_qty, 1) * coalesce(n.inner_qty, 1)), 0)
                   * coalesce((select abs(sum(ds.qty_base)) from stock_day_sums ds
                                where ds.location_id = n.location_id and ds.inventory_item_id = n.site_item and not ds.demo
                                  and ds.movement_type in ('SALE_DEPLETION', 'WASTE')
                                  and ds.business_day > public.stock_co__today(n.location_id) - 28), 0), 2) end)
             order by n.rn) from n where n.rn <= v_lim), '[]'::jsonb),
    'next', (select jsonb_build_object('at', n.at, 'id', n.id) from n where n.rn = v_lim and exists (select 1 from n m where m.rn = v_lim + 1)))
    into v_out;
  return v_out;
end
$fn$;

create or replace function public.stock_make_company_price(p_si uuid, p_location uuid, p_version integer, p_section text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_si stock_co_supplier_items;
  v_link stock_co_supplier_item_sites;
  v_section text := public.stock_co__section(p_section, array['purchasing']);
  v_g jsonb;
  v_price numeric;
  v_res jsonb;
begin
  select * into v_si from stock_co_supplier_items x where x.id = p_si;
  select * into v_link from stock_co_supplier_item_sites x where x.supplier_item_id = p_si and x.location_id = p_location;
  if v_si.id is null or v_link.supplier_item_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_si.org_id, v_section, 'company', array[p_location]);
  perform public.stock_co__need_version('company', p_version);
  if p_version is distinct from v_si.row_version then
    return public.stock_co__conflict(v_si.org_id, array['supplier_item'], p_si, v_si.row_version, p_location, v_si.updated_at);
  end if;
  v_price := v_link.price_here;
  if v_price is null then
    raise exception 'This site follows the company price already.' using errcode = '22023';
  end if;
  update stock_co_supplier_item_sites x set price_here = null, row_version = x.row_version + 1, updated_at = now()
   where x.supplier_item_id = p_si and x.location_id = p_location;
  perform public.stock_co__log(v_si.org_id, p_location, 'supplier_item_site', p_si, 'price_here', to_jsonb(v_price), null, 'make_company_price');
  perform public.stock_co__log(v_si.org_id, null, 'supplier_item', p_si, 'pack_price', to_jsonb(v_si.pack_price), to_jsonb(v_price), 'make_company_price');
  v_res := public.stock_save_supplier_item(jsonb_build_object('id', p_si, 'pack_price', v_price), p_version, v_section);
  return jsonb_build_object('ok', coalesce((v_res ->> 'ok')::boolean, true), 'supplier_item_id', p_si, 'pack_price', v_price, 'save', v_res);
end
$fn$;

create or replace function public.stock_budget_status(p_site uuid, p_week date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
begin
  select l.org_id into v_org from locations l where l.id = p_site;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if not public.stock_co__is_service() then
    perform public.stock_co__guard(v_org, null, 'read', array[p_site]);
  end if;
  return public.stock_co__budget_of(p_site, p_week);
end
$fn$;

create or replace function public.stock_budget_board(p_org uuid, p_sites uuid[], p_week date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_scope uuid[];
begin
  v_scope := public.stock_co__d3_scope(p_org, p_sites);
  return jsonb_build_object(
    'rows', coalesce((select jsonb_agg(public.stock_co__budget_of(x, p_week) || jsonb_build_object('site_name', l.name,
                       'own', (select jsonb_build_object('id', b.id, 'rule', b.rule, 'pct', b.pct, 'amount', b.amount, 'row_version', b.row_version)
                                 from stock_budgets b where b.org_id = p_org and b.location_id = u.x)) order by o)
                        from unnest(v_scope) with ordinality u(x, o) join locations l on l.id = u.x), '[]'::jsonb),
    'company', (select jsonb_build_object('id', b.id, 'rule', b.rule, 'pct', b.pct, 'amount', b.amount, 'row_version', b.row_version)
                  from stock_budgets b where b.org_id = p_org and b.location_id is null));
end
$fn$;

create or replace function public.stock_save_budget(p_budget jsonb, p_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_loc uuid;
  v_org uuid;
  v_old stock_budgets;
  v_g jsonb;
  v_rule text;
begin
  if p_budget is null or jsonb_typeof(p_budget) <> 'object' then
    raise exception 'The budget is missing.' using errcode = '22023';
  end if;
  v_loc := nullif(p_budget ->> 'location_id', '')::uuid;
  v_org := coalesce((select l.org_id from locations l where l.id = v_loc), case when v_loc is null then nullif(p_budget ->> 'org_id', '')::uuid end);
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, 'purchasing', 'company', case when v_loc is null then public.stock_co__read_scope(v_org, null) else array[v_loc] end);
  select * into v_old from stock_budgets b where b.org_id = v_org and b.location_id is not distinct from v_loc for update;
  if v_old.id is not null then
    perform public.stock_co__need_version('company', p_version);
    if p_version is distinct from v_old.row_version then
      return public.stock_co__conflict(v_org, array['budget'], v_old.id, v_old.row_version, v_loc, v_old.updated_at);
    end if;
  end if;
  if coalesce((p_budget ->> 'delete')::boolean, false) then
    delete from stock_budgets b where b.id = v_old.id;
    return jsonb_build_object('ok', true, 'deleted', v_old.id is not null);
  end if;
  v_rule := coalesce(nullif(p_budget ->> 'rule', ''), v_old.rule);
  if v_rule is null or v_rule not in ('pct_of_forecast', 'fixed') then
    raise exception 'Choose a percent of the forecast or a fixed amount.' using errcode = '22023';
  end if;
  if v_old.id is null then
    insert into stock_budgets (org_id, location_id, rule, pct, amount, updated_by)
    values (v_org, v_loc, v_rule, case when v_rule = 'pct_of_forecast' then nullif(p_budget ->> 'pct', '')::numeric end,
            case when v_rule = 'fixed' then nullif(p_budget ->> 'amount', '')::numeric end, (v_g ->> 'uid')::uuid);
  else
    update stock_budgets b
       set rule = v_rule, pct = case when v_rule = 'pct_of_forecast' then coalesce(nullif(p_budget ->> 'pct', '')::numeric, b.pct) end,
           amount = case when v_rule = 'fixed' then coalesce(nullif(p_budget ->> 'amount', '')::numeric, b.amount) end,
           row_version = b.row_version + 1, updated_by = (v_g ->> 'uid')::uuid, updated_at = now()
     where b.id = v_old.id;
  end if;
  perform public.stock_co__log(v_org, v_loc, 'budget', coalesce(v_old.id, (select b.id from stock_budgets b where b.org_id = v_org and b.location_id is not distinct from v_loc)),
                               'saved', to_jsonb(v_old), p_budget, 'save');
  return jsonb_build_object('ok', true,
                            'row_version', (select b.row_version from stock_budgets b where b.org_id = v_org and b.location_id is not distinct from v_loc));
end
$fn$;

-- ============================================================================
-- STEP 6. FORECAST, COUNTS, WASTE AND PERIODS (contract 1.6)
-- ============================================================================

create or replace function public.stock_sales_history(p_loc uuid, p_days integer default 84)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_days integer := least(greatest(coalesce(p_days, 84), 1), 371);
  v_today date;
  v_own integer;
  v_src stock_co_site_forecast_source;
  v_rows jsonb;
begin
  select l.org_id into v_org from locations l where l.id = p_loc;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__guard(v_org, null, 'read', array[p_loc]);
  v_today := public.stock_co__today(p_loc);
  select count(distinct d.business_day) into v_own from sales_day_sums d
   where d.location_id = p_loc and d.business_day >= v_today - v_days and d.business_day < v_today;
  select * into v_src from stock_co_site_forecast_source s where s.location_id = p_loc;
  if v_own >= 28 then
    v_src := null;
  end if;
  with own as (
    select d.business_day, sum(d.net) as net from sales_day_sums d
     where d.location_id = p_loc and d.business_day >= v_today - v_days and d.business_day < v_today group by 1
  ), bor as (
    select d.business_day, round(sum(d.net) * v_src.scale, 2) as net from sales_day_sums d
     where v_src.location_id is not null and d.location_id = v_src.borrow_from_location_id
       and d.business_day >= v_today - v_days and d.business_day < v_today group by 1
  )
  select coalesce(jsonb_agg(jsonb_build_object('business_day', x.business_day, 'net', x.net) order by x.business_day), '[]'::jsonb) into v_rows
    from (select coalesce(o.business_day, b.business_day) as business_day, coalesce(o.net, b.net) as net
            from own o full join bor b on b.business_day = o.business_day) x;
  return jsonb_build_object('rows', v_rows, 'own_days', v_own,
    'borrowed', case when v_src.location_id is null then null
                     else jsonb_build_object('from_location_id', v_src.borrow_from_location_id,
                                             'from_name', (select l.name from locations l where l.id = v_src.borrow_from_location_id),
                                             'scale', v_src.scale) end);
end
$fn$;

create or replace function public.stock_forecast_week(p_loc uuid, p_week_start date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_today date;
begin
  select l.org_id into v_org from locations l where l.id = p_loc;
  if v_org is null or p_week_start is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__guard(v_org, null, 'read', array[p_loc]);
  v_today := public.stock_co__today(p_loc);
  return jsonb_build_object(
    'days', (select jsonb_agg(jsonb_build_object(
               'day', d.day, 'amount', f.amount, 'reason', f.reason, 'reason_note', f.reason_note, 'edited_by_name', f.edited_by_name,
               'edited_at', f.edited_at,
               'hours', coalesce((select jsonb_agg(jsonb_build_object('hour', h.hour, 'amount', h.amount, 'reason', h.reason) order by h.hour)
                                    from stock_forecast_hours h where h.location_id = p_loc and h.business_day = d.day), '[]'::jsonb))
               order by d.day)
               from (select p_week_start + k as day from generate_series(0, 6) k) d
               left join wf_sales_forecast f on f.location_id = p_loc and f.forecast_date = d.day),
    'actuals', coalesce((select jsonb_agg(jsonb_build_object('day', x.business_day, 'net', x.net) order by x.business_day)
                           from (select s.business_day, sum(s.net) as net from sales_day_sums s
                                  where s.location_id = p_loc and s.business_day between p_week_start and least(p_week_start + 6, v_today - 1)
                                  group by 1) x), '[]'::jsonb));
end
$fn$;

-- Forecast edits are site work (decision 1). A day changed from the suggestion the screen sends
-- ("suggested") needs a reason. The rota reads the same rows.
create or replace function public.stock_save_forecast(p_loc uuid, p_days jsonb, p_hours jsonb default null, p_actor jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_cur text;
  v_g jsonb;
  v_section text;
  v_d jsonb;
  v_day date;
  v_amt numeric;
  v_n integer := 0;
  v_h integer := 0;
begin
  select l.org_id, upper(coalesce(l.currency, 'GBP')) into v_org, v_cur from locations l where l.id = p_loc;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_section := case when public.stock_co__is_service() then null
                    when exists (select 1 from user_profiles p where p.id = auth.uid() and p.bo_sections is not null
                                    and not ('purchasing' = any(p.bo_sections)) and 'workforce' = any(p.bo_sections)) then 'workforce'
                    else 'purchasing' end;
  v_g := public.stock_co__d3_who(v_org, v_section, 'site_facts', array[p_loc], p_actor);
  if p_days is not null and (jsonb_typeof(p_days) <> 'array' or jsonb_array_length(p_days) > 31) then
    raise exception 'Save up to 31 days at a time.' using errcode = '22023';
  end if;
  if p_hours is not null and (jsonb_typeof(p_hours) <> 'array' or jsonb_array_length(p_hours) > 744) then
    raise exception 'Save up to 31 days of hours at a time.' using errcode = '22023';
  end if;
  for v_d in select e from jsonb_array_elements(coalesce(p_days, '[]'::jsonb)) e loop
    v_day := (v_d ->> 'day')::date;
    v_amt := round(coalesce(nullif(v_d ->> 'amount', '')::numeric, -1), 2);
    if v_day is null or v_amt < 0 then
      raise exception 'Each day needs its date and an amount of 0 or more.' using errcode = '22023';
    end if;
    if nullif(v_d ->> 'reason', '') is not null and v_d ->> 'reason' not in ('weather', 'local_event', 'booking', 'promotion', 'closure', 'other') then
      raise exception 'Pick a reason for %.', to_char(v_day, 'Dy FMDD Mon') using errcode = '22023';
    end if;
    if nullif(v_d ->> 'suggested', '') is not null and abs(v_amt - (v_d ->> 'suggested')::numeric) > 0.005
       and nullif(v_d ->> 'reason', '') is null then
      raise exception 'Pick a reason for %.', to_char(v_day, 'Dy FMDD Mon') using errcode = '22023';
    end if;
    insert into wf_sales_forecast (location_id, org_id, forecast_date, currency, amount, reason, reason_note, edited_by, edited_by_name, edited_at)
    values (p_loc, v_org, v_day, left(v_cur, 3), v_amt, nullif(v_d ->> 'reason', ''), nullif(btrim(coalesce(v_d ->> 'reason_note', '')), ''),
            nullif(v_g ->> 'uid', '')::uuid, v_g ->> 'name', now())
    on conflict (location_id, forecast_date) do update
       set amount = excluded.amount, reason = excluded.reason, reason_note = excluded.reason_note, edited_by = excluded.edited_by,
           edited_by_name = excluded.edited_by_name, edited_at = excluded.edited_at, updated_at = now();
    v_n := v_n + 1;
  end loop;
  for v_d in select e from jsonb_array_elements(coalesce(p_hours, '[]'::jsonb)) e loop
    if (v_d ->> 'day') is null or coalesce(nullif(v_d ->> 'hour', '')::integer, -1) not between 0 and 23
       or coalesce(nullif(v_d ->> 'amount', '')::numeric, -1) < 0 then
      raise exception 'Each hour needs its day, an hour from 0 to 23 and an amount of 0 or more.' using errcode = '22023';
    end if;
    insert into stock_forecast_hours (location_id, org_id, business_day, hour, amount, reason, edited_by, edited_by_name, edited_at)
    values (p_loc, v_org, (v_d ->> 'day')::date, (v_d ->> 'hour')::smallint, round((v_d ->> 'amount')::numeric, 2), nullif(v_d ->> 'reason', ''),
            nullif(v_g ->> 'uid', '')::uuid, v_g ->> 'name', now())
    on conflict (location_id, business_day, hour) do update
       set amount = excluded.amount, reason = excluded.reason, edited_by = excluded.edited_by, edited_by_name = excluded.edited_by_name,
           edited_at = now();
    v_h := v_h + 1;
  end loop;
  return jsonb_build_object('ok', true, 'days', v_n, 'hours', v_h);
end
$fn$;

create or replace function public.stock_save_forecast_source(p_loc uuid, p_from uuid, p_scale numeric, p_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_old stock_co_site_forecast_source;
begin
  select l.org_id into v_org from locations l where l.id = p_loc;
  if v_org is null or (p_from is not null and p_from = p_loc) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__guard(v_org, 'purchasing', 'company', array_remove(array[p_loc, p_from], null));
  select * into v_old from stock_co_site_forecast_source s where s.location_id = p_loc for update;
  if v_old.location_id is not null then
    perform public.stock_co__need_version('company', p_version);
    if p_version is distinct from v_old.row_version then
      return public.stock_co__conflict(v_org, array['forecast_source'], p_loc, v_old.row_version, p_loc, v_old.updated_at);
    end if;
  end if;
  if p_from is null then
    delete from stock_co_site_forecast_source s where s.location_id = p_loc;
    return jsonb_build_object('ok', true, 'deleted', v_old.location_id is not null);
  end if;
  if p_scale is null or p_scale <= 0 or p_scale > 10 then
    raise exception 'The scale is above 0 and up to 10.' using errcode = '22023';
  end if;
  insert into stock_co_site_forecast_source (location_id, org_id, borrow_from_location_id, scale, updated_by)
  values (p_loc, v_org, p_from, round(p_scale, 3), auth.uid())
  on conflict (location_id) do update
     set borrow_from_location_id = excluded.borrow_from_location_id, scale = excluded.scale,
         row_version = stock_co_site_forecast_source.row_version + 1, updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('ok', true, 'row_version', (select s.row_version from stock_co_site_forecast_source s where s.location_id = p_loc));
end
$fn$;

create or replace function public.stock_count_due(p_org uuid, p_sites uuid[], p_day date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_scope uuid[];
begin
  v_scope := public.stock_co__d3_scope(p_org, p_sites);
  return jsonb_build_object('rows', public.stock_co__count_due_rows(p_org, v_scope, p_day));
end
$fn$;

create or replace function public.stock_save_count_plan(p_plan jsonb, p_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old stock_count_plans;
  v_org uuid;
  v_g jsonb;
  v_id uuid;
  v_sites uuid[];
  v_groups uuid[];
begin
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then
    raise exception 'The count plan is missing.' using errcode = '22023';
  end if;
  if nullif(p_plan ->> 'id', '') is not null then
    select * into v_old from stock_count_plans x where x.id = (p_plan ->> 'id')::uuid;
    if v_old.id is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
  end if;
  v_org := coalesce(v_old.org_id, nullif(p_plan ->> 'org_id', '')::uuid);
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, 'inventory', 'company', public.stock_co__read_scope(v_org, null));
  if p_plan ? 'sites' and jsonb_typeof(p_plan -> 'sites') = 'array' then
    v_sites := array(select (e #>> '{}')::uuid from jsonb_array_elements(p_plan -> 'sites') e);
    if exists (select 1 from unnest(v_sites) x where not exists (select 1 from locations l where l.id = x and l.org_id = v_org)) then
      raise exception 'That site is not in this company.' using errcode = '22023';
    end if;
  end if;
  if p_plan ? 'group_ids' and jsonb_typeof(p_plan -> 'group_ids') = 'array' then
    v_groups := array(select (e #>> '{}')::uuid from jsonb_array_elements(p_plan -> 'group_ids') e);
    if exists (select 1 from unnest(v_groups) x where not exists (select 1 from stock_co_site_groups g where g.id = x and g.org_id = v_org)) then
      raise exception 'That group is not in this company.' using errcode = '22023';
    end if;
  end if;
  if nullif(p_plan ->> 'template_id', '') is not null
     and not exists (select 1 from stock_count_templates t where t.id = (p_plan ->> 'template_id')::uuid and t.org_id = v_org) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if v_old.id is not null then
    perform 1 from stock_count_plans x where x.id = v_old.id for update;
    perform public.stock_co__need_version('company', p_version);
    if p_version is distinct from v_old.row_version then
      return public.stock_co__conflict(v_org, array['count_plan'], v_old.id, v_old.row_version, null, v_old.updated_at);
    end if;
    update stock_count_plans x
       set name = coalesce(nullif(btrim(coalesce(p_plan ->> 'name', '')), ''), x.name),
           count_type = coalesce(nullif(p_plan ->> 'count_type', ''), x.count_type),
           template_id = case when p_plan ? 'template_id' then nullif(p_plan ->> 'template_id', '')::uuid else x.template_id end,
           every = coalesce(nullif(p_plan ->> 'every', ''), x.every),
           dows = case when p_plan ? 'dows' then array(select (e #>> '{}')::smallint from jsonb_array_elements(coalesce(p_plan -> 'dows', '[]'::jsonb)) e)
                       else x.dows end,
           day_of_month = case when p_plan ? 'day_of_month' then nullif(p_plan ->> 'day_of_month', '')::smallint else x.day_of_month end,
           due_by = coalesce(nullif(p_plan ->> 'due_by', '')::time, x.due_by),
           sites = case when p_plan ? 'sites' then v_sites else x.sites end,
           group_ids = case when p_plan ? 'group_ids' then v_groups else x.group_ids end,
           if_not_counted = coalesce(nullif(p_plan ->> 'if_not_counted', ''), x.if_not_counted),
           active = case when p_plan ? 'active' then coalesce((p_plan ->> 'active')::boolean, true) else x.active end,
           archived_at = case when coalesce((p_plan ->> 'archived')::boolean, false) then coalesce(x.archived_at, now())
                              when p_plan ? 'archived' then null else x.archived_at end,
           row_version = x.row_version + 1, updated_at = now()
     where x.id = v_old.id;
    v_id := v_old.id;
  else
    insert into stock_count_plans (org_id, name, count_type, template_id, every, dows, day_of_month, due_by, sites, group_ids, if_not_counted,
                                   active, created_by, created_by_name)
    values (v_org, coalesce(nullif(btrim(coalesce(p_plan ->> 'name', '')), ''), 'Count'), coalesce(nullif(p_plan ->> 'count_type', ''), 'FULL'),
            nullif(p_plan ->> 'template_id', '')::uuid, coalesce(nullif(p_plan ->> 'every', ''), 'week'),
            case when jsonb_typeof(p_plan -> 'dows') = 'array' then array(select (e #>> '{}')::smallint from jsonb_array_elements(p_plan -> 'dows') e) end,
            nullif(p_plan ->> 'day_of_month', '')::smallint, coalesce(nullif(p_plan ->> 'due_by', '')::time, '10:00'::time), v_sites, v_groups,
            coalesce(nullif(p_plan ->> 'if_not_counted', ''), 'estimate'), coalesce((p_plan ->> 'active')::boolean, true),
            (v_g ->> 'uid')::uuid, v_g ->> 'name')
    returning id into v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', (select x.row_version from stock_count_plans x where x.id = v_id));
end
$fn$;

create or replace function public.stock_save_count_template(p_tpl jsonb, p_lines jsonb, p_sites jsonb, p_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old stock_count_templates;
  v_org uuid;
  v_g jsonb;
  v_id uuid;
begin
  if p_tpl is null or jsonb_typeof(p_tpl) <> 'object' then
    raise exception 'The template is missing.' using errcode = '22023';
  end if;
  if nullif(p_tpl ->> 'id', '') is not null then
    select * into v_old from stock_count_templates t where t.id = (p_tpl ->> 'id')::uuid;
    if v_old.id is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
  end if;
  v_org := coalesce(v_old.org_id, nullif(p_tpl ->> 'org_id', '')::uuid);
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, 'inventory', 'company', public.stock_co__read_scope(v_org, null));
  if p_lines is not null and (jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 2000
       or exists (select 1 from jsonb_array_elements(p_lines) e
                   where not exists (select 1 from stock_co_items i where i.id = nullif(e ->> 'item_id', '')::uuid and i.org_id = v_org))) then
    raise exception 'A template has up to 2,000 stock items of this company.' using errcode = '22023';
  end if;
  if p_sites is not null and (jsonb_typeof(p_sites) <> 'array'
       or exists (select 1 from jsonb_array_elements(p_sites) e
                   where (nullif(e ->> 'location_id', '') is null) = (nullif(e ->> 'group_id', '') is null)
                      or (nullif(e ->> 'location_id', '') is not null
                          and not exists (select 1 from locations l where l.id = (e ->> 'location_id')::uuid and l.org_id = v_org))
                      or (nullif(e ->> 'group_id', '') is not null
                          and not exists (select 1 from stock_co_site_groups g where g.id = (e ->> 'group_id')::uuid and g.org_id = v_org)))) then
    raise exception 'That site is not in this company.' using errcode = '22023';
  end if;
  if v_old.id is not null then
    perform 1 from stock_count_templates t where t.id = v_old.id for update;
    perform public.stock_co__need_version('company', p_version);
    if p_version is distinct from v_old.row_version then
      return public.stock_co__conflict(v_org, array['count_template'], v_old.id, v_old.row_version, null, v_old.updated_at);
    end if;
    update stock_count_templates t
       set name = coalesce(nullif(btrim(coalesce(p_tpl ->> 'name', '')), ''), t.name),
           archived_at = case when coalesce((p_tpl ->> 'archived')::boolean, false) then coalesce(t.archived_at, now())
                              when p_tpl ? 'archived' then null else t.archived_at end,
           row_version = t.row_version + 1, updated_at = now()
     where t.id = v_old.id;
    v_id := v_old.id;
  else
    if nullif(btrim(coalesce(p_tpl ->> 'name', '')), '') is null then
      raise exception 'Give the template a name.' using errcode = '22023';
    end if;
    insert into stock_count_templates (org_id, name, created_by, created_by_name)
    values (v_org, btrim(p_tpl ->> 'name'), (v_g ->> 'uid')::uuid, v_g ->> 'name')
    returning id into v_id;
  end if;
  if p_lines is not null then
    delete from stock_count_template_lines x where x.template_id = v_id;
    insert into stock_count_template_lines (template_id, org_id, item_id, sort_order)
    select distinct on ((e.v ->> 'item_id')::uuid) v_id, v_org, (e.v ->> 'item_id')::uuid,
           coalesce(nullif(e.v ->> 'sort_order', '')::integer, (e.n - 1)::integer)
      from jsonb_array_elements(p_lines) with ordinality e(v, n)
     order by (e.v ->> 'item_id')::uuid, e.n;
  end if;
  if p_sites is not null then
    delete from stock_count_template_sites x where x.template_id = v_id;
    insert into stock_count_template_sites (template_id, org_id, location_id, group_id)
    select distinct v_id, v_org, nullif(e ->> 'location_id', '')::uuid, nullif(e ->> 'group_id', '')::uuid from jsonb_array_elements(p_sites) e;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', (select t.row_version from stock_count_templates t where t.id = v_id));
end
$fn$;

create or replace function public.stock_template_for_site(p_template uuid, p_loc uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t stock_count_templates;
begin
  select * into v_t from stock_count_templates t where t.id = p_template;
  if v_t.id is null or not exists (select 1 from locations l where l.id = p_loc and l.org_id = v_t.org_id) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__guard(v_t.org_id, null, 'read', array[p_loc]);
  return jsonb_build_object(
    'template_id', p_template, 'name', v_t.name,
    'items', coalesce((select jsonb_agg(jsonb_build_object(
               'item_id', tl.item_id, 'inventory_item_id', s.site_item_id, 'name', i.name, 'base_unit', i.base_unit,
               'area_id', (select a.area_id from inventory_item_areas a where a.inventory_item_id = s.site_item_id
                            order by a.is_primary desc nulls last, a.created_at limit 1),
               'counted_here', coalesce(s.counted_here, true))
               order by so.sort_order nulls last, tl.sort_order, i.name, i.id)
               from stock_count_template_lines tl
               join stock_co_item_sites s on s.item_id = tl.item_id and s.location_id = p_loc and s.on_here
               join inventory_items i on i.id = s.site_item_id
               left join stock_template_shelf_order so on so.template_id = p_template and so.location_id = p_loc and so.item_id = tl.item_id
              where tl.template_id = p_template), '[]'::jsonb),
    'missing', coalesce((select jsonb_agg(jsonb_build_object('item_id', tl.item_id, 'name', ci.name) order by ci.name, ci.id)
                           from stock_count_template_lines tl join stock_co_items ci on ci.id = tl.item_id
                          where tl.template_id = p_template
                            and not exists (select 1 from stock_co_item_sites s where s.item_id = tl.item_id and s.location_id = p_loc and s.on_here)),
                        '[]'::jsonb));
end
$fn$;

create or replace function public.stock_save_shelf_order(p_template uuid, p_loc uuid, p_item_ids uuid[])
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t stock_count_templates;
  v_g jsonb;
begin
  select * into v_t from stock_count_templates t where t.id = p_template;
  if v_t.id is null or not exists (select 1 from locations l where l.id = p_loc and l.org_id = v_t.org_id) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_t.org_id, 'inventory', 'site_facts', array[p_loc]);
  if p_item_ids is null or cardinality(p_item_ids) > 2000
     or exists (select 1 from unnest(p_item_ids) x
                 where not exists (select 1 from stock_count_template_lines tl where tl.template_id = p_template and tl.item_id = x)) then
    raise exception 'Every item must be on the template.' using errcode = '22023';
  end if;
  delete from stock_template_shelf_order so where so.template_id = p_template and so.location_id = p_loc;
  insert into stock_template_shelf_order (template_id, location_id, org_id, item_id, sort_order, updated_by)
  select p_template, p_loc, v_t.org_id, u.x, min(u.o)::integer, (v_g ->> 'uid')::uuid
    from unnest(p_item_ids) with ordinality u(x, o) group by u.x;
  return jsonb_build_object('ok', true, 'items', cardinality(p_item_ids));
end
$fn$;

create or replace function public.stock_second_approve_count(p_count_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_c stock_counts;
  v_org uuid;
  v_g jsonb;
  v_uid uuid;
  v_locked date;
  v_res jsonb;
begin
  select * into v_c from stock_counts c where c.id = p_count_id;
  select l.org_id into v_org from locations l where l.id = v_c.location_id;
  if v_c.id is null or v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, 'inventory', 'site_facts', array[v_c.location_id]);
  v_uid := (v_g ->> 'uid')::uuid;
  if v_c.status = 'APPROVED' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', 'APPROVED');
  end if;
  if v_c.second_approval_needed_at is null then
    raise exception 'This count is not waiting for a second approval.' using errcode = '55000';
  end if;
  if v_uid is not distinct from v_c.first_approved_by then
    raise exception 'You gave the first approval. Someone else gives the second.' using errcode = '42501';
  end if;
  if not (v_g ->> 'level' = 'all'
          or exists (select 1 from user_locations ul where ul.user_id = v_uid and ul.location_id = v_c.location_id)) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_locked := public.stock_co__locked_until(v_c.location_id);
  if v_locked is not null and exists (select 1 from stock_count_lines cl where cl.count_id = p_count_id and cl.counted_qty is not null
                                         and public.stock_co__vday(v_c.location_id, coalesce(cl.counted_at, v_c.started_at, v_c.created_at)) <= v_locked) then
    raise exception 'That count is in a locked period (to %). Ask head office to unlock it.', to_char(v_locked, 'FMDD Mon') using errcode = '55000';
  end if;
  v_res := public.approve_stock_count(p_count_id, v_c.first_approved_by_name, coalesce(nullif(btrim(coalesce(p_note, '')), ''), v_c.approval_note),
                                      public.stock_opening_costs(p_count_id), false);
  if coalesce((v_res ->> 'ok')::boolean, false) and not coalesce((v_res ->> 'duplicate')::boolean, false) then
    update stock_counts
       set second_approved_by = v_uid, second_approved_by_name = v_g ->> 'name', second_approved_at = now(),
           approved_by_staff_id = coalesce(approved_by_staff_id, first_approved_by_staff_id),
           approved_by_staff_name = coalesce(approved_by_staff_name, first_approved_by_name)
     where id = p_count_id;
  end if;
  return v_res;
end
$fn$;

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
  insert into stock_periods (org_id, location_id, from_day, to_day, locked_at, locked_by)
  values (v_org, p_loc, p_from, p_to, now(), (v_g ->> 'uid')::uuid)
  returning id into v_id;
  insert into stock_period_snapshots (period_id, location_id, metrics) values (v_id, p_loc, v_m);
  perform public.stock_co__log(v_org, p_loc, 'period', v_id, 'locked', null, jsonb_build_object('from', p_from, 'to', p_to), 'save');
  return jsonb_build_object('ok', true, 'period_id', v_id, 'metrics', v_m);
end
$fn$;

create or replace function public.stock_unlock_period(p_period uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_p stock_periods;
  v_g jsonb;
begin
  select * into v_p from stock_periods p where p.id = p_period for update;
  if v_p.id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_p.org_id, 'inventory', 'company', array[v_p.location_id]);
  if public.stock_level((v_g ->> 'uid')::uuid, v_p.org_id) is distinct from 'all' then
    raise exception 'Not allowed: this is set by head office.' using errcode = '42501';
  end if;
  if nullif(btrim(coalesce(p_reason, '')), '') is null then
    raise exception 'Say why you are unlocking it.' using errcode = '22023';
  end if;
  if v_p.unlocked_at is not null then
    return jsonb_build_object('ok', true, 'duplicate', true, 'period_id', p_period);
  end if;
  update stock_periods p set unlocked_at = now(), unlocked_by = (v_g ->> 'uid')::uuid where p.id = p_period;
  perform public.stock_co__log(v_p.org_id, v_p.location_id, 'period', p_period, 'unlocked', null, to_jsonb(btrim(p_reason)), 'save');
  return jsonb_build_object('ok', true, 'period_id', p_period);
end
$fn$;

create or replace function public.stock_waste_reasons(p_loc uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_r jsonb;
  v_limit numeric;
  v_cur text;
begin
  if p_loc is null then
    raise exception 'Sign in to log waste.' using errcode = '42501';
  end if;
  select l.org_id, l.currency into v_org, v_cur from locations l where l.id = p_loc;
  if v_org is null then
    raise exception 'Sign in to log waste.' using errcode = '42501';
  end if;
  if public.stock_co__is_service() then
    null;
  elsif v_uid is null or public.is_anon_session() then
    if v_uid is null or not (
         exists (select 1 from devices d where d.device_uid = v_uid and d.location_id = p_loc and d.type in ('pos', 'kds', 'handheld'))
         or exists (select 1 from ops_devices o where o.device_uid = v_uid and o.location_id = p_loc and o.active and o.claimed_at is not null)) then
      raise exception 'Sign in to log waste.' using errcode = '42501';
    end if;
  else
    perform public.stock_co__read_scope(v_org, array[p_loc]);
  end if;
  select case when jsonb_typeof(s.waste_reasons) = 'array' and jsonb_array_length(s.waste_reasons) > 0 then s.waste_reasons end
    into v_r from stock_co_settings s where s.org_id = v_org;
  select coalesce(ss.waste_pin_over_value, cs.waste_pin_over_value) into v_limit
    from locations l left join stock_co_site_settings ss on ss.location_id = l.id left join stock_co_settings cs on cs.org_id = l.org_id
   where l.id = p_loc;
  return jsonb_build_object('reasons', v_r, 'pin_over', v_limit, 'currency', v_cur);
end
$fn$;

create or replace function public.stock_fresh_closedown_list(p_loc uuid, p_day date default null, p_actor jsonb default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_day date;
  v_from timestamptz;
  v_to timestamptz;
  v_k record;
begin
  select l.org_id into v_org from locations l where l.id = p_loc;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__d3_who(v_org, null, 'read', array[p_loc], p_actor);
  v_day := coalesce(p_day, public.stock_co__today(p_loc));
  select * into v_k from public.stock_co__clock_of(p_loc);
  v_from := public.stock_co__day_start_at(v_day, v_k.day_start, v_k.timezone);
  v_to := public.stock_co__day_start_at(v_day + 1, v_k.day_start, v_k.timezone);
  return jsonb_build_object('day', v_day, 'rows', coalesce((
    select jsonb_agg(jsonb_build_object('inventory_item_id', x.id, 'name', x.name, 'unit', x.base_unit, 'on_hand', x.on_hand,
                                        'made_today', x.made, 'delivered_today', x.delivered) order by x.name, x.id)
      from (select i.id, i.name, i.base_unit, i.on_hand,
                   coalesce((select sum(coalesce(b.actual_qty, b.planned_qty)) from production_batches b
                              where b.location_id = p_loc and b.output_item_id = i.id and b.status = 'COMPLETED'
                                and b.produced_at >= v_from and b.produced_at < v_to), 0) as made,
                   coalesce((select sum(m.qty_base) from stock_movements m
                              where m.location_id = p_loc and m.inventory_item_id = i.id and m.movement_type in ('PURCHASE_RECEIPT', 'TRANSFER_IN')
                                and m.occurred_at >= v_from and m.occurred_at < v_to), 0) as delivered
              from inventory_items i
             where i.location_id = p_loc and i.archived_at is null
               and (coalesce(i.shelf_life_days, 99) <= 1
                    or exists (select 1 from production_batches b where b.location_id = p_loc and b.output_item_id = i.id
                                  and b.status <> 'CANCELLED' and b.expiry_at >= v_from and b.expiry_at < v_to))
             order by i.name, i.id
             limit 300) x), '[]'::jsonb));
end
$fn$;

-- ============================================================================
-- STEP 7. TRANSFERS AND THE CENTRAL KITCHEN (contract 1.6)
-- ============================================================================
-- Every stock movement here is a person's act through the existing transfer legs; requests, disputes,
-- ticks and plans move no number.

create or replace function public.stock_request_transfer(p_from uuid, p_to uuid, p_lines jsonb, p_reason text default null, p_note text default null,
                                                         p_actor jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_g jsonb;
  v_id uuid;
  v_ref text;
  v_refused jsonb := '[]'::jsonb;
  v_from_name text;
  v_n integer;
begin
  select l.org_id into v_org from locations l where l.id = p_to;
  select l.name into v_from_name from locations l where l.id = p_from and l.org_id = v_org;
  if v_org is null or v_from_name is null or p_from = p_to then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__d3_who(v_org, 'inventory', 'site_facts', array[p_to], p_actor);
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 or jsonb_array_length(p_lines) > 300 then
    raise exception 'Ask for 1 to 300 items.' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(coalesce(ci.name, 'An item') || ' is not at ' ||
                            case when fs.site_item_id is null then v_from_name else (select l.name from locations l where l.id = p_to) end || '.'),
                  '[]'::jsonb)
    into v_refused
    from jsonb_array_elements(p_lines) e
    left join stock_co_items ci on ci.id = nullif(e ->> 'company_item_id', '')::uuid and ci.org_id = v_org
    left join stock_co_item_sites fs on fs.item_id = ci.id and fs.location_id = p_from and fs.on_here
    left join stock_co_item_sites ts on ts.item_id = ci.id and ts.location_id = p_to and ts.on_here
   where fs.site_item_id is null or ts.site_item_id is null or coalesce(nullif(e ->> 'qty_base', '')::numeric, 0) <= 0;
  v_ref := 'TR-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
  insert into stock_transfers (location_id, to_location_id, status, reference, note, created_by_name, kind, reason, requested_by_name, requested_at)
  values (p_from, p_to, 'REQUESTED', v_ref, nullif(btrim(coalesce(p_note, '')), ''), v_g ->> 'name', 'request',
          nullif(btrim(coalesce(p_reason, '')), ''), v_g ->> 'name', now())
  returning id into v_id;
  insert into stock_transfer_lines (transfer_id, location_id, to_location_id, inventory_item_id, to_inventory_item_id, name_snapshot, sku_snapshot,
                                    base_unit, qty_base, requested_qty_base, sort_order)
  select v_id, p_from, p_to, fs.site_item_id, ts.site_item_id, fi.name, fi.sku, fi.base_unit,
         round((e.v ->> 'qty_base')::numeric, 4), round((e.v ->> 'qty_base')::numeric, 4), (e.n - 1)::integer
    from jsonb_array_elements(p_lines) with ordinality e(v, n)
    join stock_co_items ci on ci.id = nullif(e.v ->> 'company_item_id', '')::uuid and ci.org_id = v_org
    join stock_co_item_sites fs on fs.item_id = ci.id and fs.location_id = p_from and fs.on_here
    join stock_co_item_sites ts on ts.item_id = ci.id and ts.location_id = p_to and ts.on_here
    join inventory_items fi on fi.id = fs.site_item_id
   where coalesce(nullif(e.v ->> 'qty_base', '')::numeric, 0) > 0;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception '%', coalesce(v_refused ->> 0, 'Nothing to ask for.') using errcode = '22023';
  end if;
  perform public.stock_co__notify(v_org, p_from, 'transfer_waiting', v_id::text,
    jsonb_build_object('title', 'Stock asked for', 'body', (select l.name from locations l where l.id = p_to) || ' asked for ' || v_n || ' items',
                       'route', 'stock-transfers', 'focus', v_id));
  return jsonb_build_object('ok', true, 'transfer_id', v_id, 'reference', v_ref, 'refused', v_refused);
end
$fn$;

create or replace function public.stock_fulfil_request(p_transfer uuid, p_lines jsonb default null, p_actor jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t stock_transfers;
  v_org uuid;
begin
  select * into v_t from stock_transfers t where t.id = p_transfer for update;
  select l.org_id into v_org from locations l where l.id = v_t.location_id;
  if v_t.id is null or v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__d3_who(v_org, 'inventory', 'site_facts', array[v_t.location_id], p_actor);
  if v_t.status = 'DRAFT' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', 'DRAFT');
  end if;
  if v_t.status <> 'REQUESTED' then
    return jsonb_build_object('ok', false, 'error', 'Only a request can be accepted.');
  end if;
  if p_lines is not null and (jsonb_typeof(p_lines) <> 'array'
       or exists (select 1 from jsonb_array_elements(p_lines) e
                   where not exists (select 1 from stock_transfer_lines l where l.id = nullif(e ->> 'line_id', '')::uuid and l.transfer_id = p_transfer)
                      or coalesce(nullif(e ->> 'qty_base', '')::numeric, -1) < 0)) then
    raise exception 'A line is not on this request.' using errcode = '22023';
  end if;
  update stock_transfer_lines l
     set qty_base = round((e ->> 'qty_base')::numeric, 4), dropped = (e ->> 'qty_base')::numeric = 0
    from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) e
   where l.transfer_id = p_transfer and l.id = (e ->> 'line_id')::uuid;
  update stock_transfers t set status = 'DRAFT', updated_at = now() where t.id = p_transfer;
  return jsonb_build_object('ok', true, 'status', 'DRAFT', 'transfer_id', p_transfer);
end
$fn$;

create or replace function public.stock_dispute_transfer(p_transfer uuid, p_note text, p_actor jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t stock_transfers;
  v_org uuid;
  v_g jsonb;
  v_res jsonb;
begin
  select * into v_t from stock_transfers t where t.id = p_transfer;
  select l.org_id into v_org from locations l where l.id = v_t.to_location_id;
  if v_t.id is null or v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__d3_who(v_org, 'inventory', 'site_facts', array[v_t.to_location_id], p_actor);
  if nullif(btrim(coalesce(p_note, '')), '') is null then
    raise exception 'Say what is wrong.' using errcode = '22023';
  end if;
  v_res := public.post_stock_transfer_leg(p_transfer, 'dispute', v_g ->> 'name');
  if coalesce((v_res ->> 'ok')::boolean, false) and not coalesce((v_res ->> 'duplicate')::boolean, false) then
    update stock_transfers t set dispute_note = btrim(p_note), updated_at = now() where t.id = p_transfer;
    perform public.stock_co__notify(v_org, v_t.location_id, 'transfer_waiting', p_transfer::text || ':dispute',
      jsonb_build_object('title', 'Transfer disputed', 'body', coalesce(v_t.reference, 'A transfer') || ': ' || left(btrim(p_note), 200),
                         'route', 'stock-transfers', 'focus', p_transfer));
  end if;
  return v_res;
end
$fn$;

create or replace function public.stock_transfer_matches(p_transfer uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t stock_transfers;
  v_org uuid;
begin
  select * into v_t from stock_transfers t where t.id = p_transfer;
  select l.org_id into v_org from locations l where l.id = v_t.to_location_id;
  if v_t.id is null or v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__guard(v_org, null, 'read', array[v_t.to_location_id]);
  return coalesce((
    select jsonb_agg(jsonb_build_object('line_id', l.id, 'to_inventory_item_id', coalesce(m.co, m.sku, m.nm),
                                        'how', case when m.co is not null then 'company' when m.sku is not null then 'sku'
                                                    when m.nm is not null then 'name' else 'none' end) order by l.sort_order, l.id)
      from stock_transfer_lines l
      join inventory_items f on f.id = l.inventory_item_id
      cross join lateral (select
        (select s.site_item_id from stock_co_item_sites s where f.company_ref is not null and s.item_id = f.company_ref
            and s.location_id = v_t.to_location_id and s.on_here limit 1) as co,
        (select i.id from inventory_items i where i.location_id = v_t.to_location_id and i.archived_at is null
            and nullif(btrim(coalesce(f.sku, '')), '') is not null and lower(btrim(i.sku)) = lower(btrim(f.sku)) order by i.id limit 1) as sku,
        (select i.id from inventory_items i where i.location_id = v_t.to_location_id and i.archived_at is null
            and lower(btrim(i.name)) = lower(btrim(f.name)) order by i.id limit 1) as nm) m
     where l.transfer_id = p_transfer), '[]'::jsonb);
end
$fn$;

create or replace function public.stock_save_transfer_list(p_list jsonb, p_version integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_old stock_transfer_lists;
  v_loc uuid;
  v_org uuid;
  v_g jsonb;
  v_id uuid;
begin
  if p_list is null or jsonb_typeof(p_list) <> 'object' then
    raise exception 'The list is missing.' using errcode = '22023';
  end if;
  if nullif(p_list ->> 'id', '') is not null then
    select * into v_old from stock_transfer_lists x where x.id = (p_list ->> 'id')::uuid;
    if v_old.id is null then
      raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
    end if;
  end if;
  v_loc := coalesce(v_old.location_id, nullif(p_list ->> 'location_id', '')::uuid);
  select l.org_id into v_org from locations l where l.id = v_loc;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_org, 'inventory', 'site_facts', array[v_loc]);
  if p_list ? 'lines' and (jsonb_typeof(p_list -> 'lines') <> 'array' or jsonb_array_length(p_list -> 'lines') > 300
       or exists (select 1 from jsonb_array_elements(p_list -> 'lines') e
                   where not exists (select 1 from stock_co_items i where i.id = nullif(e ->> 'company_item_id', '')::uuid and i.org_id = v_org))) then
    raise exception 'A list has up to 300 stock items of this company.' using errcode = '22023';
  end if;
  if nullif(p_list ->> 'to_location_id', '') is not null
     and not exists (select 1 from locations l where l.id = (p_list ->> 'to_location_id')::uuid and l.org_id = v_org) then
    raise exception 'That site is not in this company.' using errcode = '22023';
  end if;
  if v_old.id is not null then
    perform 1 from stock_transfer_lists x where x.id = v_old.id for update;
    if p_version is not null and p_version is distinct from v_old.row_version then
      return public.stock_co__conflict(v_org, array['transfer_list'], v_old.id, v_old.row_version, v_loc, v_old.updated_at);
    end if;
    update stock_transfer_lists x
       set name = coalesce(nullif(btrim(coalesce(p_list ->> 'name', '')), ''), x.name),
           to_location_id = case when p_list ? 'to_location_id' then nullif(p_list ->> 'to_location_id', '')::uuid else x.to_location_id end,
           lines = coalesce(case when p_list ? 'lines' then p_list -> 'lines' end, x.lines),
           archived_at = case when coalesce((p_list ->> 'archived')::boolean, false) then coalesce(x.archived_at, now())
                              when p_list ? 'archived' then null else x.archived_at end,
           row_version = x.row_version + 1, updated_at = now()
     where x.id = v_old.id;
    v_id := v_old.id;
  else
    if nullif(btrim(coalesce(p_list ->> 'name', '')), '') is null then
      raise exception 'Give the list a name.' using errcode = '22023';
    end if;
    insert into stock_transfer_lists (org_id, location_id, to_location_id, name, lines, created_by, created_by_name)
    values (v_org, v_loc, nullif(p_list ->> 'to_location_id', '')::uuid, btrim(p_list ->> 'name'), coalesce(p_list -> 'lines', '[]'::jsonb),
            (v_g ->> 'uid')::uuid, v_g ->> 'name')
    returning id into v_id;
  end if;
  return jsonb_build_object('ok', true, 'id', v_id, 'row_version', (select x.row_version from stock_transfer_lists x where x.id = v_id));
end
$fn$;

create or replace function public.stock_set_site_kind(p_loc uuid, p_kind text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_name text;
  v_g jsonb;
  v_old text;
  v_sup uuid;
begin
  select l.org_id, l.name into v_org, v_name from locations l where l.id = p_loc;
  if v_org is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('restaurant', 'central_kitchen', 'store_room') then
    raise exception 'Choose restaurant, central kitchen or store room.' using errcode = '22023';
  end if;
  if not public.stock_co__multi(v_org) then
    raise exception 'A one site company has no central kitchen.' using errcode = '22023';
  end if;
  v_g := public.stock_co__guard(v_org, null, 'company', array[p_loc]);
  if public.stock_level((v_g ->> 'uid')::uuid, v_org) is distinct from 'all' then
    raise exception 'Not allowed: this is set by head office.' using errcode = '42501';
  end if;
  select s.site_kind into v_old from stock_co_site_settings s where s.location_id = p_loc;
  select c.id into v_sup from stock_co_suppliers c where c.org_id = v_org and c.internal_location_id = p_loc order by c.created_at, c.id limit 1;
  if p_kind <> 'central_kitchen' and v_sup is not null
     and exists (select 1 from purchase_orders po join suppliers s on s.id = po.supplier_id
                  where s.company_ref = v_sup and po.status in ('SENT', 'PARTIAL')) then
    raise exception 'This kitchen has open orders. Send or cancel them first.' using errcode = '55000';
  end if;
  insert into stock_co_site_settings (location_id, org_id, site_kind, updated_by)
  values (p_loc, v_org, p_kind, (v_g ->> 'uid')::uuid)
  on conflict (location_id) do update
     set site_kind = excluded.site_kind, row_version = stock_co_site_settings.row_version + 1, updated_at = now(), updated_by = excluded.updated_by;
  if p_kind = 'central_kitchen' then
    if v_sup is null then
      insert into stock_co_suppliers (org_id, name, internal_location_id, accepts_price_changes, order_method)
      values (v_org, 'Central kitchen, ' || v_name, p_loc, false, 'email')
      returning id into v_sup;
    else
      update stock_co_suppliers c set archived_at = null, row_version = c.row_version + 1, updated_at = now()
       where c.id = v_sup and c.archived_at is not null;
    end if;
  elsif v_sup is not null then
    update stock_co_suppliers c set archived_at = now(), row_version = c.row_version + 1, updated_at = now()
     where c.id = v_sup and c.archived_at is null;
  end if;
  perform public.stock_co__log(v_org, p_loc, 'site_kind', p_loc, 'site_kind', to_jsonb(v_old), to_jsonb(p_kind), 'save');
  return jsonb_build_object('ok', true, 'site_kind', p_kind, 'supplier_id', v_sup);
end
$fn$;

create or replace function public.stock_kitchen_orders_in(p_kitchen uuid, p_day date, p_actor jsonb default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
begin
  select l.org_id into v_org from locations l where l.id = p_kitchen;
  if v_org is null or p_day is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__d3_who(v_org, null, 'read', array[p_kitchen], p_actor);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'po_id', po.id, 'location_id', po.location_id, 'site_name', l.name, 'reference', po.reference, 'status', po.status,
             'lines', coalesce((select jsonb_agg(jsonb_build_object('po_line_id', pl.id, 'company_item_id', i.company_ref, 'name', i.name,
                                                                    'qty_packs', pl.qty_packs, 'pack_label', pl.description, 'unit_price', pl.unit_price)
                                                 order by pl.sort_order, pl.id)
                                  from po_lines pl join inventory_items i on i.id = pl.inventory_item_id where pl.po_id = po.id), '[]'::jsonb),
             'transfer_id', t.id, 'transfer_status', t.status) order by l.name, po.created_at, po.id)
      from purchase_orders po
      join suppliers s on s.id = po.supplier_id
      join stock_co_suppliers c on c.id = s.company_ref and c.internal_location_id = p_kitchen
      join locations l on l.id = po.location_id
      left join stock_transfers t on t.purchase_order_id = po.id
     where l.org_id = v_org and po.status in ('SENT', 'RECEIVED') and po.expected_date = p_day), '[]'::jsonb);
end
$fn$;

-- The pack content of an order line in a site item's base unit.
create or replace function public.stock_co__pack_base(p_pack_qty numeric, p_inner_qty numeric, p_inner_unit text, p_item uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(nullif(public.stock_qty_to_base(coalesce(p_pack_qty, 1) * coalesce(p_inner_qty, 1), p_inner_unit, p_item), 0),
                  coalesce(p_pack_qty, 1) * coalesce(p_inner_qty, 1));
$fn$;

create or replace function public.stock_kitchen_plan(p_kitchen uuid, p_day date, p_actor jsonb default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_cat jsonb := '[]'::jsonb;
  r record;
begin
  select l.org_id into v_org from locations l where l.id = p_kitchen;
  if v_org is null or p_day is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__d3_who(v_org, null, 'read', array[p_kitchen], p_actor);
  -- catering and ezCater orders at the kitchen for that day, through the drainer's rule
  for r in
    select q.items, coalesce(nullif(q.type, ''), 'dine-in') as ot from order_queue q
     where q.location_id = p_kitchen::text and q.source = 'catering' and q.event_date = p_day and coalesce(q.status, '') not in ('cancelled', 'void')
    union all
    select q.items, coalesce(nullif(q.type, ''), 'dine-in') from ezcater_order_links z join order_queue q on q.ref = z.ref
     where z.location_id = p_kitchen::text and z.event_at is not null and public.stock_co__vday(p_kitchen, z.event_at) = p_day
       and coalesce(q.source, '') <> 'catering'
    limit 500
  loop
    if jsonb_typeof(r.items) = 'array' then
      v_cat := v_cat || coalesce((select jsonb_agg(jsonb_build_object('item', x.inventory_item_id, 'qty', x.qty_base))
                                    from public.stock_explode_lines(p_kitchen, r.items, r.ot, 'qty') x where x.inventory_item_id is not null), '[]'::jsonb);
    end if;
  end loop;
  return coalesce((
    with rec as (
      select cr.id, cr.name, cr.output_item_id, ks.site_item_id as k_item, ki.base_unit, ki.on_hand
        from stock_co_recipes cr
        join stock_co_recipe_sites rs on rs.recipe_id = cr.id and rs.location_id = p_kitchen and rs.on_here
        join stock_co_item_sites ks on ks.item_id = cr.output_item_id and ks.location_id = p_kitchen
        join inventory_items ki on ki.id = ks.site_item_id
       where cr.org_id = v_org and cr.kind in ('batch', 'prep') and cr.archived_at is null
    ), ord as (
      select i.company_ref as co_item, po.location_id, l.name as site_name,
             sum(pl.qty_packs * public.stock_co__pack_base(pl.pack_qty, pl.inner_qty, pl.inner_unit, pl.inventory_item_id)) as qty
        from purchase_orders po
        join suppliers s on s.id = po.supplier_id
        join stock_co_suppliers c on c.id = s.company_ref and c.internal_location_id = p_kitchen
        join po_lines pl on pl.po_id = po.id
        join inventory_items i on i.id = pl.inventory_item_id
        join locations l on l.id = po.location_id
       where l.org_id = v_org and po.status in ('SENT', 'RECEIVED') and po.expected_date = p_day
       group by 1, 2, 3
    ), std as (
      select i.company_ref as co_item,
             sum(coalesce(nullif(rl.qty, 0), sl.qty_packs) * public.stock_co__pack_base(sp.pack_qty, sp.inner_qty, sp.inner_unit, sl.inventory_item_id)) as qty
        from stock_standing_orders so
        join suppliers s on s.id = so.supplier_id
        join stock_co_suppliers c on c.id = s.company_ref and c.internal_location_id = p_kitchen
        join stock_standing_order_lines sl on sl.standing_order_id = so.id
        join inventory_items i on i.id = sl.inventory_item_id
        left join supplier_products sp on sp.id = sl.supplier_product_id
        left join stock_standing_runs sr on sr.standing_order_id = so.id and sr.delivery_day = p_day
        left join lateral (select (e ->> 'qty_packs')::numeric as qty from jsonb_array_elements(coalesce(sr.lines, '[]'::jsonb)) e
                            where (e ->> 'inventory_item_id')::uuid = sl.inventory_item_id limit 1) rl on true
       where so.org_id = v_org and so.active and extract(dow from p_day)::smallint = any(so.delivery_dows)
         and (sr.id is null or sr.status = 'waiting') and (so.paused_until is null or so.paused_until < p_day)
       group by 1
    ), cat as (
      select (e ->> 'item')::uuid as k_item, sum((e ->> 'qty')::numeric) as qty from jsonb_array_elements(v_cat) e group by 1
    ), t as (
      select rec.*,
             coalesce((select sum(o.qty) from ord o where o.co_item = rec.output_item_id), 0) as ordered,
             coalesce((select sum(cat.qty) from cat where cat.k_item = rec.k_item), 0) as catering,
             coalesce((select sum(std.qty) from std where std.co_item = rec.output_item_id), 0) as standing,
             coalesce((select sum(k.qty) from stock_kitchen_plan_ticks k where k.location_id = p_kitchen and k.business_day = p_day and k.recipe_id = rec.id), 0) as done
        from rec
    )
    select jsonb_agg(jsonb_build_object(
             'recipe_id', t.id, 'name', t.name, 'unit', t.base_unit, 'ordered', round(t.ordered, 4),
             'by_site', coalesce((select jsonb_agg(jsonb_build_object('location_id', o.location_id, 'site_name', o.site_name, 'qty', round(o.qty, 4))
                                                   order by o.site_name) from ord o where o.co_item = t.output_item_id), '[]'::jsonb),
             'catering', round(t.catering, 4), 'standing', round(t.standing, 4), 'holds', coalesce(t.on_hand, 0),
             'make', round(greatest(0, t.ordered + t.catering + t.standing - coalesce(t.on_hand, 0)), 4), 'done', t.done,
             'ticks', coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'qty', k.qty, 'done_by_name', k.done_by_name, 'done_at', k.done_at)
                                                 order by k.done_at, k.id)
                                  from stock_kitchen_plan_ticks k where k.location_id = p_kitchen and k.business_day = p_day and k.recipe_id = t.id), '[]'::jsonb))
             order by t.name, t.id)
      from t), '[]'::jsonb);
end
$fn$;

create or replace function public.stock_kitchen_ingredients(p_kitchen uuid, p_day date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_plan jsonb;
begin
  v_plan := public.stock_kitchen_plan(p_kitchen, p_day, null);
  return coalesce((
    with recursive mk as (
      select (e ->> 'recipe_id')::uuid as recipe_id, (e ->> 'make')::numeric as make from jsonb_array_elements(v_plan) e
       where (e ->> 'make')::numeric > 0
    ), need(item, qty, depth) as (
      select l.component_item_id,
             mk.make / nullif(public.stock_co__recipe_yield_base(cr.id, p_kitchen), 0) * public.stock_co__line_base(l.id, p_kitchen), 1
        from mk join stock_co_recipes cr on cr.id = mk.recipe_id join stock_co_recipe_lines l on l.recipe_id = cr.id
      union all
      select l.component_item_id,
             n.qty / nullif(public.stock_co__recipe_yield_base(cr.id, p_kitchen), 0) * public.stock_co__line_base(l.id, p_kitchen), n.depth + 1
        from need n
        join stock_co_recipes cr on cr.output_item_id = n.item and cr.kind in ('batch', 'prep') and cr.archived_at is null
        join stock_co_recipe_sites rs on rs.recipe_id = cr.id and rs.location_id = p_kitchen and rs.on_here
        join stock_co_recipe_lines l on l.recipe_id = cr.id
       where n.depth < 5
    ), raw as (
      select n.item, sum(n.qty) as need_base from need n
       where not exists (select 1 from stock_co_recipes cr join stock_co_recipe_sites rs on rs.recipe_id = cr.id and rs.location_id = p_kitchen and rs.on_here
                          where cr.output_item_id = n.item and cr.kind in ('batch', 'prep') and cr.archived_at is null)
       group by n.item
    )
    select jsonb_agg(jsonb_build_object(
             'inventory_item_id', s.site_item_id, 'name', i.name, 'need_base', round(raw.need_base, 4), 'on_hand', coalesce(i.on_hand, 0),
             'short_base', round(greatest(0, raw.need_base - coalesce(i.on_hand, 0)), 4),
             'supplier_id', sp.supplier_id, 'supplier_product_id', sp.id,
             'packs', case when sp.id is null then null
                           else ceil(greatest(0, raw.need_base - coalesce(i.on_hand, 0))
                                     / nullif(public.stock_co__pack_base(sp.pack_qty, sp.inner_qty, sp.inner_unit, i.id), 0)) end)
             order by i.name, i.id)
      from raw
      join stock_co_item_sites s on s.item_id = raw.item and s.location_id = p_kitchen
      join inventory_items i on i.id = s.site_item_id
      left join lateral (select p.* from supplier_products p where p.location_id = p_kitchen and p.inventory_item_id = i.id and p.archived_at is null
                          order by p.is_preferred desc nulls last, p.id limit 1) sp on true), '[]'::jsonb);
end
$fn$;

-- A recipe line's quantity in the kitchen item's base unit, before the usable percent loss.
create or replace function public.stock_co__line_base(p_line uuid, p_loc uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select case when l.unit = '@' then l.qty * coalesce(pk.qty_in_base, 1)
              else coalesce(public.stock_qty_to_base(l.qty, l.unit, s.site_item_id), l.base_qty, l.qty) end
         / greatest(coalesce(l.usable_pct, 100), 1) * 100
    from stock_co_recipe_lines l
    left join stock_co_packs pk on pk.id = l.pack_id
    left join stock_co_item_sites s on s.item_id = l.component_item_id and s.location_id = p_loc
   where l.id = p_line;
$fn$;

-- A recipe's yield in its made item's base unit at a site.
create or replace function public.stock_co__recipe_yield_base(p_recipe uuid, p_loc uuid)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $fn$
  select coalesce(public.stock_qty_to_base(coalesce(r.yield_qty, 1), coalesce(r.yield_unit, 'each'), s.site_item_id), r.yield_qty, 1)
    from stock_co_recipes r
    left join stock_co_item_sites s on s.item_id = r.output_item_id and s.location_id = p_loc
   where r.id = p_recipe;
$fn$;

create or replace function public.stock_kitchen_tick(p_kitchen uuid, p_recipe uuid, p_qty numeric, p_day date default null, p_actor jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_org uuid;
  v_g jsonb;
  v_today date;
  v_day date;
  v_id uuid;
begin
  select l.org_id into v_org from locations l where l.id = p_kitchen;
  if v_org is null or not exists (select 1 from stock_co_recipes r where r.id = p_recipe and r.org_id = v_org) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__d3_who(v_org, 'produce', 'site_facts', array[p_kitchen], p_actor);
  if p_qty is null or p_qty <= 0 then
    raise exception 'Type how many were made.' using errcode = '22023';
  end if;
  v_today := public.stock_co__today(p_kitchen);
  v_day := coalesce(p_day, v_today);
  if v_day not in (v_today, v_today - 1) then
    raise exception 'Tick today or yesterday only.' using errcode = '22023';
  end if;
  insert into stock_kitchen_plan_ticks (org_id, location_id, business_day, recipe_id, qty, done_by, done_by_name)
  values (v_org, p_kitchen, v_day, p_recipe, p_qty, nullif(v_g ->> 'uid', '')::uuid, v_g ->> 'name')
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id,
    'done', (select sum(k.qty) from stock_kitchen_plan_ticks k where k.location_id = p_kitchen and k.business_day = v_day and k.recipe_id = p_recipe));
end
$fn$;

create or replace function public.stock_kitchen_untick(p_id uuid, p_actor jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_k stock_kitchen_plan_ticks;
begin
  select * into v_k from stock_kitchen_plan_ticks k where k.id = p_id;
  if v_k.id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  perform public.stock_co__d3_who(v_k.org_id, 'produce', 'site_facts', array[v_k.location_id], p_actor);
  if v_k.business_day <> public.stock_co__today(v_k.location_id) then
    raise exception 'That tick is from an earlier day.' using errcode = '55000';
  end if;
  delete from stock_kitchen_plan_ticks k where k.id = p_id;
  return jsonb_build_object('ok', true, 'id', p_id);
end
$fn$;

-- Pick and send one site's kitchen order (F8): one transfer linked to the order, then the existing out
-- leg (the stock leaves the kitchen at its cost and is in transit until the site receives the transfer).
create or replace function public.stock_kitchen_pick(p_po uuid, p_lines jsonb, p_actor jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_po purchase_orders;
  v_kitchen uuid;
  v_org uuid;
  v_g jsonb;
  v_id uuid;
  v_ref text;
  v_res jsonb;
  v_n integer;
  v_note jsonb;
begin
  select * into v_po from purchase_orders p where p.id = p_po for update;
  select c.internal_location_id, l.org_id into v_kitchen, v_org
    from suppliers s join stock_co_suppliers c on c.id = s.company_ref join locations l on l.id = s.location_id
   where s.id = v_po.supplier_id;
  if v_po.id is null or v_kitchen is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__d3_who(v_org, 'inventory', 'site_facts', array[v_kitchen], p_actor);
  if exists (select 1 from stock_transfers t where t.purchase_order_id = p_po) then
    raise exception 'This order was already picked.' using errcode = '55000';
  end if;
  if v_po.status <> 'SENT' then
    raise exception 'This order is not waiting to be picked.' using errcode = '55000';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array'
     or exists (select 1 from jsonb_array_elements(p_lines) e
                 where not exists (select 1 from po_lines pl where pl.id = nullif(e ->> 'po_line_id', '')::uuid and pl.po_id = p_po)
                    or coalesce(nullif(e ->> 'qty_packs_sent', '')::numeric, -1) < 0) then
    raise exception 'A line is not on this order.' using errcode = '22023';
  end if;
  v_ref := 'TR-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
  insert into stock_transfers (location_id, to_location_id, status, reference, note, created_by_name, kind, reason, purchase_order_id)
  values (v_kitchen, v_po.location_id, 'DRAFT', v_ref, 'Order ' || coalesce(v_po.reference, ''), v_g ->> 'name', 'central_kitchen',
          'Central kitchen', p_po)
  returning id into v_id;
  insert into stock_transfer_lines (transfer_id, location_id, to_location_id, inventory_item_id, to_inventory_item_id, name_snapshot, sku_snapshot,
                                    base_unit, qty_base, to_unit_cost, lot_code, use_by_at, sort_order)
  select v_id, v_kitchen, v_po.location_id, ki.id, pl.inventory_item_id, si.name, ki.sku, ki.base_unit,
         round((e ->> 'qty_packs_sent')::numeric * public.stock_co__pack_base(pl.pack_qty, pl.inner_qty, pl.inner_unit, ki.id), 4),
         round(coalesce(pl.unit_price, 0) / nullif(public.stock_co__pack_base(pl.pack_qty, pl.inner_qty, pl.inner_unit, pl.inventory_item_id), 0), 8),
         b.lot_code, b.expiry_at, pl.sort_order
    from jsonb_array_elements(p_lines) e
    join po_lines pl on pl.id = (e ->> 'po_line_id')::uuid
    join inventory_items si on si.id = pl.inventory_item_id
    join stock_co_item_sites ks on ks.item_id = si.company_ref and ks.location_id = v_kitchen
    join inventory_items ki on ki.id = ks.site_item_id
    left join lateral (select pb.lot_code, pb.expiry_at from production_batches pb
                        where pb.location_id = v_kitchen and pb.output_item_id = ki.id
                          and ((nullif(e ->> 'batch_id', '') is not null and pb.id = (e ->> 'batch_id')::uuid)
                               or (nullif(e ->> 'batch_id', '') is null and pb.status = 'COMPLETED' and pb.lot_code is not null))
                        order by pb.produced_at desc nulls last, pb.created_at desc limit 1) b on true
   where (e ->> 'qty_packs_sent')::numeric > 0;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    raise exception 'Send at least one line.' using errcode = '22023';
  end if;
  v_res := public.post_stock_transfer_leg(v_id, 'out', v_g ->> 'name');
  if not coalesce((v_res ->> 'ok')::boolean, false) then
    raise exception '%', coalesce(v_res ->> 'error', 'The transfer could not be sent.') using errcode = '55000';
  end if;
  select jsonb_build_object('site', (select l.name from locations l where l.id = v_po.location_id), 'reference', v_po.reference,
           'transfer_reference', v_ref,
           'lines', coalesce(jsonb_agg(jsonb_build_object('name', i.name, 'ordered', pl.qty_packs,
                      'sent', coalesce((pk.x ->> 'qty_packs_sent')::numeric, 0),
                      'short', greatest(0, pl.qty_packs - coalesce((pk.x ->> 'qty_packs_sent')::numeric, 0)),
                      'lot', tl.lot_code, 'use_by', tl.use_by_at) order by pl.sort_order, pl.id), '[]'::jsonb))
    into v_note
    from po_lines pl
    join inventory_items i on i.id = pl.inventory_item_id
    left join lateral (select y from jsonb_array_elements(p_lines) y where (y ->> 'po_line_id')::uuid = pl.id limit 1) pk(x) on true
    left join lateral (select l.lot_code, l.use_by_at from stock_transfer_lines l where l.transfer_id = v_id and l.to_inventory_item_id = pl.inventory_item_id
                        order by l.sort_order limit 1) tl on true
   where pl.po_id = p_po;
  return jsonb_build_object('ok', true, 'transfer_id', v_id, 'reference', v_ref,
    'short_lines', coalesce((select jsonb_agg(jsonb_build_object('po_line_id', pl.id, 'ordered', pl.qty_packs,
                                                                 'sent', coalesce((x ->> 'qty_packs_sent')::numeric, 0)) order by pl.sort_order, pl.id)
                               from po_lines pl
                               left join lateral (select y from jsonb_array_elements(p_lines) y where (y ->> 'po_line_id')::uuid = pl.id limit 1) z(x) on true
                              where pl.po_id = p_po and coalesce((x ->> 'qty_packs_sent')::numeric, 0) < pl.qty_packs), '[]'::jsonb),
    'note', v_note);
end
$fn$;

create or replace function public.stock_set_recipe_restricted(p_recipe uuid, p_restricted boolean, p_kitchen uuid, p_version integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_r stock_co_recipes;
  v_g jsonb;
  v_s uuid;
  v_sec stock_co_recipe_secrets;
  v_off integer := 0;
begin
  select * into v_r from stock_co_recipes r where r.id = p_recipe for update;
  if v_r.id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v_sec from stock_co_recipe_secrets s where s.recipe_id = p_recipe;
  v_g := public.stock_co__guard(v_r.org_id, 'produce', 'company', array[coalesce(p_kitchen, v_sec.kitchen_location_id,
                                 (select s.location_id from stock_co_recipe_sites s where s.recipe_id = p_recipe order by s.location_id limit 1),
                                 v_r.local_location_id)]);
  perform public.stock_co__need_version('company', p_version);
  if p_version is distinct from v_r.row_version then
    return public.stock_co__conflict(v_r.org_id, array['recipe'], p_recipe, v_r.row_version, null, v_r.updated_at);
  end if;
  if coalesce(p_restricted, false) then
    if v_r.kind not in ('batch', 'prep') then
      raise exception 'Only batch and prep recipes can be kitchen only.' using errcode = '22023';
    end if;
    if p_kitchen is null or not exists (select 1 from stock_co_site_settings ss join locations l on l.id = ss.location_id
                                         where ss.location_id = p_kitchen and ss.site_kind = 'central_kitchen' and l.org_id = v_r.org_id) then
      raise exception 'Pick a central kitchen of this company.' using errcode = '22023';
    end if;
    insert into stock_co_recipe_secrets (recipe_id, org_id, kitchen_location_id, method, updated_by, updated_by_name)
    values (p_recipe, v_r.org_id, p_kitchen, coalesce(v_r.method, v_sec.method), (v_g ->> 'uid')::uuid, v_g ->> 'name')
    on conflict (recipe_id) do update
       set kitchen_location_id = excluded.kitchen_location_id, method = coalesce(excluded.method, stock_co_recipe_secrets.method),
           row_version = stock_co_recipe_secrets.row_version + 1, updated_by = excluded.updated_by, updated_by_name = excluded.updated_by_name,
           updated_at = now();
    update stock_co_recipes r set restricted = true, method = null, row_version = r.row_version + 1, updated_at = now(), updated_by = (v_g ->> 'uid')::uuid
     where r.id = p_recipe;
    for v_s in select s.location_id from stock_co_recipe_sites s where s.recipe_id = p_recipe and s.on_here and s.location_id <> p_kitchen order by 1 loop
      perform public.stock_co__recipe_off_at(p_recipe, v_s, v_g ->> 'name');
      v_off := v_off + 1;
    end loop;
    -- the ingredients and quantities stay only at the kitchen: every other site's copy of the lines goes
    -- (its archived site recipe row stays for history; turning the recipe on there again writes them back)
    delete from recipe_lines rl
     where rl.recipe_id in (select s.site_recipe_id from stock_co_recipe_sites s
                             where s.recipe_id = p_recipe and s.location_id <> p_kitchen and s.site_recipe_id is not null);
  else
    update stock_co_recipes r set restricted = false, method = coalesce(v_sec.method, r.method), row_version = r.row_version + 1, updated_at = now(),
           updated_by = (v_g ->> 'uid')::uuid
     where r.id = p_recipe;
    delete from stock_co_recipe_secrets s where s.recipe_id = p_recipe;
  end if;
  perform public.stock_co__log(v_r.org_id, p_kitchen, 'recipe', p_recipe, 'restricted', to_jsonb(v_r.restricted), to_jsonb(coalesce(p_restricted, false)), 'save');
  return jsonb_build_object('ok', true, 'restricted', coalesce(p_restricted, false), 'sites_off', v_off,
                            'row_version', (select r.row_version from stock_co_recipes r where r.id = p_recipe));
end
$fn$;

create or replace function public.stock_save_recipe_secret(p_recipe uuid, p_method text, p_version integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_sec stock_co_recipe_secrets;
  v_g jsonb;
begin
  select * into v_sec from stock_co_recipe_secrets s where s.recipe_id = p_recipe for update;
  if v_sec.recipe_id is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  v_g := public.stock_co__guard(v_sec.org_id, 'produce', 'site_facts', array[v_sec.kitchen_location_id]);
  if not public.stock_co__secret_ok(v_sec.org_id, v_sec.kitchen_location_id) then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if p_version is not null and p_version is distinct from v_sec.row_version then
    return public.stock_co__conflict(v_sec.org_id, array['recipe_secret'], p_recipe, v_sec.row_version, v_sec.kitchen_location_id, v_sec.updated_at);
  end if;
  update stock_co_recipe_secrets s
     set method = nullif(p_method, ''), row_version = s.row_version + 1, updated_by = (v_g ->> 'uid')::uuid, updated_by_name = v_g ->> 'name', updated_at = now()
   where s.recipe_id = p_recipe;
  return jsonb_build_object('ok', true, 'row_version', v_sec.row_version + 1);
end
$fn$;

-- Recharges (F13): kitchen transfers and transfers between sites of different legal companies (another
-- Xero organisation), received in the month, at the price the site paid.
create or replace function public.stock_recharge_statement(p_org uuid, p_month date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_scope uuid[];
  v_g jsonb;
  v_m date := date_trunc('month', coalesce(p_month, current_date))::date;
begin
  v_scope := public.stock_co__read_scope(p_org, null);
  v_g := public.stock_co__guard(p_org, null, 'read', v_scope);
  if public.stock_level((v_g ->> 'uid')::uuid, p_org) is distinct from 'all' then
    raise exception 'Not allowed: this is set by head office.' using errcode = '42501';
  end if;
  return coalesce((
    with t as (
      select tr.location_id as f, tr.to_location_id as tt, tr.kind,
             (select x.tenant_id from xero_connections x where x.location_id = tr.location_id order by x.created_at desc limit 1) as ft,
             (select x.tenant_id from xero_connections x where x.location_id = tr.to_location_id order by x.created_at desc limit 1) as tot,
             sum(coalesce(l.qty_received_base, 0) * coalesce(l.to_unit_cost, 0)) as amount, count(l.id) as n
        from stock_transfers tr
        join locations fl on fl.id = tr.location_id and fl.org_id = p_org
        join stock_transfer_lines l on l.transfer_id = tr.id and not l.dropped
       where tr.status in ('RECEIVED', 'DISPUTED') and tr.to_location_id is not null and tr.to_location_id <> tr.location_id
         and tr.received_at is not null
         and public.stock_co__vday(tr.to_location_id, tr.received_at) >= v_m
         and public.stock_co__vday(tr.to_location_id, tr.received_at) < (v_m + interval '1 month')::date
       group by 1, 2, 3, 4, 5
    ), g as (
      select t.f, t.tt, t.ft, t.tot, sum(t.amount) as amount, sum(t.n) as n from t
       where t.kind = 'central_kitchen' or coalesce(t.ft, '') <> coalesce(t.tot, '') or t.ft is null or t.tot is null
       group by 1, 2, 3, 4
    )
    select jsonb_agg(jsonb_build_object(
             'from_location_id', g.f, 'from_name', (select l.name from locations l where l.id = g.f),
             'from_tenant', coalesce((select x.tenant_name from xero_connections x where x.location_id = g.f order by x.created_at desc limit 1), 'No Xero company set'),
             'to_location_id', g.tt, 'to_name', (select l.name from locations l where l.id = g.tt),
             'to_tenant', coalesce((select x.tenant_name from xero_connections x where x.location_id = g.tt order by x.created_at desc limit 1), 'No Xero company set'),
             'amount', round(g.amount, 2), 'lines', g.n,
             'posted', (select jsonb_build_object('xero_invoice_id', p.xero_invoice_id, 'xero_bill_id', p.xero_bill_id, 'posted_at', p.posted_at)
                          from stock_recharge_posts p where p.org_id = p_org and p.month = v_m and p.from_location_id = g.f and p.to_location_id = g.tt))
             order by 2, 5)
      from g), '[]'::jsonb);
end
$fn$;

create or replace function public.stock_recharge_record(p_org uuid, p_month date, p_from uuid, p_to uuid, p_amount numeric, p_invoice text, p_bill text,
                                                        p_error text, p_by_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_m date := date_trunc('month', p_month)::date;
  v_old stock_recharge_posts;
begin
  if not public.stock_co__is_service() or p_org is null or p_month is null or p_from is null or p_to is null then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  if not exists (select 1 from locations l where l.id = p_from and l.org_id = p_org) or not exists (select 1 from locations l where l.id = p_to and l.org_id = p_org) then
    raise exception 'That site is not in this company.' using errcode = '22023';
  end if;
  select * into v_old from stock_recharge_posts p where p.org_id = p_org and p.month = v_m and p.from_location_id = p_from and p.to_location_id = p_to for update;
  if v_old.id is not null and v_old.xero_invoice_id is not null and v_old.xero_bill_id is not null then
    raise exception 'This month was already sent to Xero.' using errcode = '55000';
  end if;
  insert into stock_recharge_posts (org_id, month, from_location_id, to_location_id, amount, xero_invoice_id, xero_bill_id, posted_at, posted_by_name, last_error)
  values (p_org, v_m, p_from, p_to, round(coalesce(p_amount, 0), 2), nullif(p_invoice, ''), nullif(p_bill, ''),
          case when nullif(p_invoice, '') is not null or nullif(p_bill, '') is not null then now() end, p_by_name, nullif(p_error, ''))
  on conflict (org_id, month, from_location_id, to_location_id) do update
     set amount = excluded.amount, xero_invoice_id = coalesce(excluded.xero_invoice_id, stock_recharge_posts.xero_invoice_id),
         xero_bill_id = coalesce(excluded.xero_bill_id, stock_recharge_posts.xero_bill_id),
         posted_at = coalesce(excluded.posted_at, stock_recharge_posts.posted_at), posted_by_name = coalesce(excluded.posted_by_name, stock_recharge_posts.posted_by_name),
         last_error = excluded.last_error;
  return jsonb_build_object('ok', true);
end
$fn$;

-- ============================================================================
-- STEP 8. THE ORDER BY RUNNER AND THE ALERTS (contract 1.6; pg_cron runs both as the owner)
-- ============================================================================

-- The delivery whose order by time has passed in the last 24 hours, for one site supplier, on a day the
-- caller wants (p_dows; null = any): walks next_delivery forward. Also answers the skipped days met.
create or replace function public.stock_co__due_delivery(p_site_supplier uuid, p_dows smallint[], p_now timestamptz)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_t timestamptz := p_now - interval '24 hours';
  v_c jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_k integer := 0;
begin
  loop
    v_k := v_k + 1;
    exit when v_k > 8;
    v_c := public.stock_co__next_delivery(p_site_supplier, v_t);
    exit when v_c is null;
    v_skipped := v_skipped || coalesce(v_c -> 'skipped', '[]'::jsonb);
    exit when (v_c ->> 'order_by_at')::timestamptz > p_now;
    if p_dows is null or extract(dow from (v_c ->> 'delivery_day')::date)::smallint = any(p_dows) then
      return v_c || jsonb_build_object('skipped', v_skipped);
    end if;
    v_t := (v_c ->> 'order_by_at')::timestamptz;
  end loop;
  return case when jsonb_array_length(v_skipped) > 0 then jsonb_build_object('delivery_day', null, 'skipped', v_skipped) end;
end
$fn$;

create or replace function public.stock_po_cutoff_run()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  a record;
  so record;
  v_send boolean;
  v_due jsonb;
  v_day date;
  v_sk jsonb;
  v_run stock_standing_runs;
  v_po uuid;
  v_lines jsonb;
  v_res jsonb;
  v_held boolean;
  v_n integer;
  v_cur text;
  k text;
  req bigint;
begin
  if not pg_try_advisory_xact_lock(hashtext('stock_po_cutoff_run')) then
    return null;
  end if;
  perform set_config('lock_timeout', '200ms', true);
  -- (1) approvals: pass up at 60 minutes, alert at 30, at the order by time send as sent unapproved (the
  -- company setting, on by default) or mark missed
  for a in
    select x.*, coalesce(s.send_unapproved_at_cutoff, true) as send_it, l.currency
      from stock_po_approvals x
      join locations l on l.id = x.location_id
      left join stock_co_settings s on s.org_id = x.org_id
     where x.status = 'waiting' and x.order_by_at is not null and x.order_by_at <= now() + interval '60 minutes'
     order by x.order_by_at, x.id
     limit 200
       for update of x skip locked
  loop
    if a.order_by_at <= now() then
      if a.send_it then
        update stock_po_approvals x set status = 'sent_unapproved', decided_at = now(), decided_by_name = 'Order by time', updated_at = now()
         where x.id = a.id;
        update purchase_orders po set sent_unapproved_at = now(), updated_at = now() where po.id = a.po_id;
        insert into stock_po_send_jobs (po_id, location_id, why) values (a.po_id, a.location_id, 'sent_unapproved') on conflict (po_id) do nothing;
        perform public.stock_co__notify(a.org_id, a.location_id, 'sent_unapproved', a.po_id::text,
          jsonb_build_object('title', 'Order sent unapproved', 'body', 'Nobody answered by the order by time. ' || public.stock_co__money(a.currency, a.amount),
                             'route', 'purchase-orders', 'focus', a.po_id, 'raised_by', a.raised_by));
      else
        update stock_po_approvals x set status = 'missed', decided_at = now(), decided_by_name = 'Order by time', updated_at = now()
         where x.id = a.id;
      end if;
    elsif a.order_by_at <= now() + interval '30 minutes' and a.step < 2 then
      update stock_po_approvals x set step = 2, updated_at = now() where x.id = a.id;
      perform public.stock_co__notify(a.org_id, a.location_id, 'approval_30', a.po_id::text,
        jsonb_build_object('title', 'Order waiting for approval: 30 minutes left', 'body', public.stock_co__money(a.currency, a.amount),
                           'route', 'purchase-orders', 'focus', a.po_id, 'raised_by', a.raised_by));
    elsif a.step = 0 then
      update stock_po_approvals x set step = 1, updated_at = now() where x.id = a.id;
      perform public.stock_co__notify(a.org_id, a.location_id, 'approval_60', a.po_id::text,
        jsonb_build_object('title', 'Order waiting for approval: 1 hour left', 'body', public.stock_co__money(a.currency, a.amount),
                           'route', 'purchase-orders', 'focus', a.po_id, 'raised_by', a.raised_by));
    end if;
  end loop;

  -- (2) standing orders whose order by time has passed with no run yet (a cheap first pass on the rules,
  -- then the exact delivery rule with exceptions). At most 200 a call; the next minute takes the rest.
  v_n := 0;
  for so in
    select o.*, s.archived_at as sup_archived, c.order_method, c.internal_location_id
      from stock_standing_orders o
      join suppliers s on s.id = o.supplier_id
      left join stock_co_suppliers c on c.id = s.company_ref
     where o.active
       and (exists (select 1 from stock_order_rules r
                     cross join lateral (select (now() at time zone public.stock_co__tz(o.location_id)) as lnow) z
                     cross join lateral generate_series(-1, 9) g(k)
                     where r.supplier_id = o.supplier_id and r.delivery_dow = any(o.delivery_dows)
                       and r.delivery_dow = extract(dow from (z.lnow::date + g.k))
                       and not exists (select 1 from stock_standing_runs sr where sr.standing_order_id = o.id and sr.delivery_day = z.lnow::date + g.k)
                       and (case when r.order_by_time is null then (z.lnow::date + g.k)::timestamp
                                 else (z.lnow::date + g.k - ((r.delivery_dow::integer - coalesce(r.order_by_dow::integer, (r.delivery_dow::integer + 6) % 7) + 7) % 7))
                                      + r.order_by_time end) between z.lnow - interval '24 hours' and z.lnow)
            or exists (select 1 from stock_delivery_exceptions x where x.org_id = o.org_id and x.archived_at is null
                          and x.to_day >= current_date - 2 and x.from_day <= current_date + 30))
     order by o.id
  loop
    exit when v_n >= 200;
    v_day := null;
    v_due := null;
    begin
      v_due := public.stock_co__due_delivery(so.supplier_id, so.delivery_dows, now());
      -- no delivery days met on the way (bank holidays and the like) are recorded as skipped
      for v_sk in select e from jsonb_array_elements(coalesce(v_due -> 'skipped', '[]'::jsonb)) e loop
        if extract(dow from (v_sk ->> 'day')::date)::smallint = any(so.delivery_dows) then
          insert into stock_standing_runs (standing_order_id, location_id, delivery_day, status, skip_reason)
          values (so.id, so.location_id, (v_sk ->> 'day')::date, 'skipped', coalesce(v_sk ->> 'name', 'No delivery'))
          on conflict (standing_order_id, delivery_day) do update
             set status = 'skipped', skip_reason = excluded.skip_reason, updated_at = now()
           where stock_standing_runs.status = 'waiting';
        end if;
      end loop;
      v_day := (v_due ->> 'delivery_day')::date;
      continue when v_day is null;
      select * into v_run from stock_standing_runs r where r.standing_order_id = so.id and r.delivery_day = v_day for update;
      continue when v_run.id is not null and v_run.status <> 'waiting';
      v_n := v_n + 1;
      if v_run.id is null then
        insert into stock_standing_runs (standing_order_id, location_id, delivery_day, order_by_at, status)
        values (so.id, so.location_id, v_day, (v_due ->> 'order_by_at')::timestamptz, 'waiting')
        returning * into v_run;
      end if;
      if so.paused_until is not null and so.paused_until >= v_day then
        update stock_standing_runs r set status = 'skipped', skip_reason = 'Standing order paused', updated_at = now() where r.id = v_run.id;
        continue;
      end if;
      if so.sup_archived is not null then
        update stock_standing_runs r set status = 'skipped', skip_reason = 'Supplier paused', updated_at = now() where r.id = v_run.id;
        continue;
      end if;
      -- the site's edits, else the standing lines; zero and paused lines left out
      select coalesce(jsonb_agg(x.j order by x.n), '[]'::jsonb) into v_lines from (
        select jsonb_build_object('inventory_item_id', i.id, 'supplier_product_id', l.sp, 'qty_packs', l.qty) as j, l.n
          from (select (e.v ->> 'inventory_item_id')::uuid as item, nullif(e.v ->> 'supplier_product_id', '')::uuid as sp,
                       (e.v ->> 'qty_packs')::numeric as qty, e.n
                  from jsonb_array_elements(v_run.lines) with ordinality e(v, n) where v_run.lines is not null
                union all
                select sl.inventory_item_id, sl.supplier_product_id, sl.qty_packs, sl.sort_order
                  from stock_standing_order_lines sl where v_run.lines is null and sl.standing_order_id = so.id) l
          join inventory_items i on i.id = l.item and i.location_id = so.location_id
         where coalesce(l.qty, 0) > 0
           and (i.company_ref is null or public.stock_co__paused_now(i.company_ref, so.location_id, v_day) is null)) x;
      if jsonb_array_length(v_lines) = 0 then
        update stock_standing_runs r set status = 'skipped', skip_reason = 'No lines', updated_at = now() where r.id = v_run.id;
        continue;
      end if;
      insert into purchase_orders (location_id, supplier_id, reference, status, expected_date, subtotal, notes, standing_order_id)
      values (so.location_id, so.supplier_id, 'SO-' || upper(substr(md5(gen_random_uuid()::text), 1, 6)), 'DRAFT', v_day, 0,
              'Standing order' || coalesce(': ' || so.name, ''), so.id)
      returning id into v_po;
      insert into po_lines (location_id, po_id, inventory_item_id, supplier_product_id, description, qty_packs, pack_qty, inner_qty, inner_unit,
                            unit_price, qty_received, sort_order, purchase_tax_rate_id)
      select so.location_id, v_po, (e.v ->> 'inventory_item_id')::uuid, sp.id,
             coalesce(sp.pack_description, (select i.name from inventory_items i where i.id = (e.v ->> 'inventory_item_id')::uuid)),
             (e.v ->> 'qty_packs')::numeric, coalesce(sp.pack_qty, 1), coalesce(sp.inner_qty, 1),
             coalesce(sp.inner_unit, (select i.base_unit from inventory_items i where i.id = (e.v ->> 'inventory_item_id')::uuid), 'each'), coalesce(sp.pack_price, 0), 0,
             (e.n - 1)::integer, sp.purchase_tax_rate_id
        from jsonb_array_elements(v_lines) with ordinality e(v, n)
        left join lateral (select p.* from supplier_products p
                            where p.location_id = so.location_id and p.supplier_id = so.supplier_id
                              and p.inventory_item_id = (e.v ->> 'inventory_item_id')::uuid and p.archived_at is null
                            order by (p.id = nullif(e.v ->> 'supplier_product_id', '')::uuid) desc, p.is_preferred desc nulls last, p.id
                            limit 1) sp on true;
      update purchase_orders po
         set subtotal = (select coalesce(sum(round(pl.qty_packs * coalesce(pl.unit_price, 0), 2)), 0) from po_lines pl where pl.po_id = v_po)
       where po.id = v_po;
      v_res := public.stock_co__po_submit_core(v_po, null, 'Standing order', true);
      if coalesce((v_res ->> 'internal')::boolean, false) then
        update stock_standing_runs r set status = 'sent', po_id = v_po, updated_at = now() where r.id = v_run.id;
      elsif coalesce(so.order_method, 'email') = 'held' then
        perform set_config('servos.stock_po_send', txid_current()::text, true);
        update purchase_orders po set status = 'SENT', ordered_at = coalesce(po.ordered_at, now()), updated_at = now() where po.id = v_po;
        update stock_standing_runs r set status = 'held', po_id = v_po, updated_at = now() where r.id = v_run.id;
      else
        insert into stock_po_send_jobs (po_id, location_id, why) values (v_po, so.location_id, 'standing') on conflict (po_id) do nothing;
        update stock_standing_runs r set status = 'sent', po_id = v_po, updated_at = now() where r.id = v_run.id;
      end if;
    exception
      when lock_not_available or deadlock_detected or query_canceled then
        null;
      when others then
        -- the block rolled back: the run is written again as failed with the words, so nothing is lost silently
        if v_day is not null then
          insert into stock_standing_runs (standing_order_id, location_id, delivery_day, order_by_at, status, skip_reason)
          values (so.id, so.location_id, v_day, (v_due ->> 'order_by_at')::timestamptz, 'failed', left(sqlerrm, 200))
          on conflict (standing_order_id, delivery_day) do update set status = 'failed', skip_reason = excluded.skip_reason, updated_at = now()
           where stock_standing_runs.status = 'waiting';
        end if;
    end;
  end loop;

  -- (3) only when there is something to send: po-cutoff-run emails the waiting orders
  if not exists (select 1 from stock_po_send_jobs j where j.status = 'waiting' and j.not_before <= now()) then
    return null;
  end if;
  select s.decrypted_secret into k from vault.decrypted_secrets s where s.name = 'po_cutoff_cron_key' limit 1;
  if k is null or length(k) < 32 then
    raise exception 'stock_po_cutoff_run: no po_cutoff_cron_key in the vault (run 20261027a again).';
  end if;
  select net.http_post(
    url := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/po-cutoff-run',
    body := '{"action": "run"}'::jsonb,
    params := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', k),
    timeout_milliseconds := 25000
  ) into req;
  return req;
end
$fn$;

create or replace function public.po_cutoff_cron_ok(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(length(p_key) >= 32 and exists (
    select 1 from vault.decrypted_secrets s
     where s.name = 'po_cutoff_cron_key' and s.decrypted_secret = p_key
  ), false);
$fn$;

create or replace function public.stock_notify_cron_ok(p_key text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $fn$
  select coalesce(length(p_key) >= 32 and exists (
    select 1 from vault.decrypted_secrets s
     where s.name = 'stock_notify_cron_key' and s.decrypted_secret = p_key
  ), false);
$fn$;

-- Every minute: stage the alerts that are due (once each, the ledger's unique key), purge old rows, and
-- only when something waits, call stock-notify. Multi site companies only.
create or replace function public.stock_notify_due()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $fn$
declare
  v_orgs uuid[];
  v_sites uuid[];
  r record;
  v_nd jsonb;
  v_o uuid;
  k text;
  req bigint;
begin
  if not pg_try_advisory_xact_lock(hashtext('stock_notify_due')) then
    return null;
  end if;
  perform set_config('lock_timeout', '200ms', true);
  v_orgs := array(select o.org_id from (select distinct l.org_id from locations l where l.org_id is not null) o
                   where public.stock_co__multi(o.org_id) and exists (select 1 from stock_co_items i where i.org_id = o.org_id) order by 1);
  if cardinality(v_orgs) = 0 then
    return null;
  end if;
  v_sites := array(select l.id from locations l where l.org_id = any(v_orgs) and coalesce(l.status, 'active') = 'active');
  -- order_by: a site supplier whose order by time is within 60 minutes, nothing ordered, no standing order
  for r in
    select s.id, s.name, s.location_id, l.org_id from suppliers s join locations l on l.id = s.location_id
     where s.location_id = any(v_sites) and s.archived_at is null
       and not exists (select 1 from stock_co_suppliers c where c.id = s.company_ref and c.internal_location_id is not null)
       and exists (select 1 from stock_order_rules o
                    cross join lateral (select (now() at time zone public.stock_co__tz(s.location_id)) as lnow) z
                    where o.supplier_id = s.id and o.order_by_time is not null
                      and (o.order_by_dow is null or o.order_by_dow = extract(dow from z.lnow))
                      and o.order_by_time between z.lnow::time and (z.lnow + interval '60 minutes')::time)
     limit 1000
  loop
    v_nd := public.stock_co__next_delivery(r.id, now());
    continue when v_nd is null or (v_nd ->> 'minutes_left')::integer > 60;
    continue when exists (select 1 from purchase_orders po where po.supplier_id = r.id and po.location_id = r.location_id
                             and po.status in ('DRAFT', 'SENT', 'PARTIAL', 'RECEIVED') and po.expected_date = (v_nd ->> 'delivery_day')::date)
               or exists (select 1 from stock_standing_orders so where so.supplier_id = r.id and so.active
                             and extract(dow from (v_nd ->> 'delivery_day')::date)::smallint = any(so.delivery_dows));
    perform public.stock_co__notify(r.org_id, r.location_id, 'order_by', r.id::text || ':' || (v_nd ->> 'delivery_day'),
      jsonb_build_object('title', 'Order by ' || (v_nd ->> 'order_by_hm'), 'body', r.name || ': nothing ordered for ' || (v_nd ->> 'delivery_day'),
                         'route', 'order-pad', 'focus', r.id));
  end loop;
  -- count_due (an hour after the venue day starts) and count_missed (yesterday)
  foreach v_o in array v_orgs loop
    for r in
      select e, l.org_id from locations l
       cross join lateral jsonb_array_elements(public.stock_co__count_due_rows(l.org_id, array[l.id], null)) e
       where l.org_id = v_o and l.id = any(v_sites) and e ->> 'status' = 'due'
         and now() >= (select public.stock_co__day_start_at(public.stock_co__today(l.id), k2.day_start, k2.timezone) from public.stock_co__clock_of(l.id) k2)
                      + interval '1 hour'
    loop
      perform public.stock_co__notify(r.org_id, (r.e ->> 'location_id')::uuid, 'count_due',
        (r.e ->> 'plan_id') || ':' || (r.e ->> 'location_id') || ':' || (r.e ->> 'due_day'),
        jsonb_build_object('title', 'Count due today', 'body', (r.e ->> 'plan_name') || ' by ' || (r.e ->> 'due_by'), 'route', 'stock-counts',
                           'focus', r.e ->> 'plan_id'));
    end loop;
    for r in
      select e, l.org_id from locations l
       cross join lateral jsonb_array_elements(public.stock_co__count_due_rows(l.org_id, array[l.id], public.stock_co__today(l.id) - 1)) e
       where l.org_id = v_o and l.id = any(v_sites) and e ->> 'status' = 'missed'
    loop
      perform public.stock_co__notify(r.org_id, (r.e ->> 'location_id')::uuid, 'count_missed',
        (r.e ->> 'plan_id') || ':' || (r.e ->> 'location_id') || ':' || (r.e ->> 'due_day'),
        jsonb_build_object('title', 'Count missed', 'body', r.e ->> 'plan_name', 'route', 'stock-counts', 'focus', r.e ->> 'plan_id'));
    end loop;
  end loop;
  -- delivery_overdue and transfer_waiting
  insert into stock_notify_sent (org_id, location_id, kind, ref, payload)
  select l.org_id, po.location_id, 'delivery_overdue', po.id::text,
         jsonb_build_object('title', 'Delivery overdue', 'body', coalesce(s.name, 'A supplier') || ' ' || coalesce(po.reference, '') || ' was due '
                                                                 || to_char(po.expected_date, 'FMDD Mon'),
                            'route', 'stock-deliveries', 'focus', po.id)
    from purchase_orders po join locations l on l.id = po.location_id left join suppliers s on s.id = po.supplier_id
   where po.location_id = any(v_sites) and po.status in ('SENT', 'PARTIAL') and po.expected_date < public.stock_co__today(po.location_id)
   limit 1000
  on conflict do nothing;
  insert into stock_notify_sent (org_id, location_id, kind, ref, payload)
  select l.org_id, t.to_location_id, 'transfer_waiting', t.id::text,
         jsonb_build_object('title', 'Transfer waiting to be received', 'body', coalesce(t.reference, 'A transfer') || ' from '
                                                                                || (select f.name from locations f where f.id = t.location_id),
                            'route', 'stock-transfers', 'focus', t.id)
    from stock_transfers t join locations l on l.id = t.to_location_id
   where t.to_location_id = any(v_sites) and t.status = 'SENT' and t.sent_at < now() - interval '2 hours'
   limit 1000
  on conflict do nothing;
  -- purge: sent alerts and done send jobs over 30 days old, at most 5,000 each
  delete from stock_notify_sent n
   where n.id in (select x.id from stock_notify_sent x where x.status in ('sent', 'skipped') and x.created_at < now() - interval '30 days'
                   order by x.id limit 5000);
  delete from stock_po_send_jobs j
   where j.id in (select x.id from stock_po_send_jobs x where x.status in ('sent', 'held') and x.created_at < now() - interval '30 days'
                   order by x.id limit 5000);
  if not exists (select 1 from stock_notify_sent n where n.status = 'waiting') then
    return null;
  end if;
  select s.decrypted_secret into k from vault.decrypted_secrets s where s.name = 'stock_notify_cron_key' limit 1;
  if k is null or length(k) < 32 then
    raise exception 'stock_notify_due: no stock_notify_cron_key in the vault (run 20261027a again).';
  end if;
  select net.http_post(
    url := 'https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/stock-notify',
    body := '{"action": "run"}'::jsonb,
    params := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-key', k),
    timeout_milliseconds := 25000
  ) into req;
  return req;
end
$fn$;

-- Who gets one staged alert (map 4.23): the bell sites and the people with their contact details.
create or replace function public.stock_notify_targets(p_id bigint)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $fn$
declare
  v stock_notify_sent;
  v_section text;
  v_skip uuid;
begin
  if not public.stock_co__is_service() then
    raise exception 'That record was not found, or this login cannot change it.' using errcode = '42501';
  end if;
  select * into v from stock_notify_sent n where n.id = p_id;
  if v.id is null then
    return null;
  end if;
  v_section := case when v.kind in ('count_due', 'count_missed', 'count_second_approval', 'transfer_waiting') then 'inventory' else 'purchasing' end;
  v_skip := case when v.kind = 'approval_wait' then nullif(v.payload ->> 'raised_by', '')::uuid end;
  return jsonb_build_object(
    'bell', coalesce((select jsonb_agg(jsonb_build_object('location_id', x.id) order by x.id)
                        from (select l.id from locations l
                               where (v.location_id is not null and l.id = v.location_id)
                                  or (v.location_id is null and l.org_id = v.org_id and coalesce(l.status, 'active') = 'active')
                               order by l.id limit 50) x), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(jsonb_build_object('user_id', p.id, 'name', coalesce(nullif(btrim(p.full_name), ''), p.email),
                                                            'email', coalesce(w.email, p.email), 'mobile', w.mobile,
                                                            'sms', w.mobile is not null, 'email_on', coalesce(w.email, p.email) is not null)
                                         order by p.id)
                          from (select up.* from user_profiles up
                                 where up.id is distinct from v_skip
                                   and ((v.location_id is not null and v.kind not in ('price_rise', 'invoice_unplaced', 'approval_60', 'approval_30', 'sent_unapproved')
                                         and up.id in (select ul.user_id from user_locations ul where ul.location_id = v.location_id))
                                        or (v.kind in ('approval_wait', 'approval_60', 'approval_30', 'sent_unapproved', 'price_rise', 'invoice_unplaced',
                                                       'count_second_approval')
                                            and up.org_id = v.org_id
                                            and (up.role = 'owner' or (up.stock_control = 'all' and (up.bo_sections is null or v_section = any(up.bo_sections)))))
                                        or (v.kind in ('approval_60', 'approval_30', 'sent_unapproved') and v.location_id is not null
                                            and up.id in (select ul.user_id from user_locations ul where ul.location_id = v.location_id)))
                                 order by up.id limit 50) p
                          left join lateral (select ws.email, ws.mobile from wf_staff ws where ws.pos_user_id = p.id
                                              order by (ws.status = 'active') desc, ws.created_at limit 1) w on true), '[]'::jsonb));
end
$fn$;

-- ============================================================================
-- STEP 9. THE DATA STEP: the two vault keys and the two cron jobs (nothing else is written)
-- ============================================================================
do $d3_vault$
begin
  if not exists (select 1 from vault.secrets s where s.name = 'stock_notify_cron_key') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'stock_notify_cron_key',
      'pg_cron stock-notify proves itself to the stock-notify edge function with this (20261027a). Made by the database, never typed.');
  end if;
  if not exists (select 1 from vault.secrets s where s.name = 'po_cutoff_cron_key') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'po_cutoff_cron_key',
      'pg_cron po-cutoff-run proves itself to the po-cutoff-run edge function with this (20261027a). Made by the database, never typed.');
  end if;
end
$d3_vault$;

do $d3_cron$
declare
  j record;
begin
  for j in select c.jobid from cron.job c where c.jobname in ('stock-notify', 'po-cutoff-run') loop
    perform cron.unschedule(j.jobid);
  end loop;
  perform cron.schedule('stock-notify', '* * * * *', 'select public.stock_notify_due();');
  perform cron.schedule('po-cutoff-run', '* * * * *', 'select public.stock_po_cutoff_run();');
end
$d3_cron$;

-- ============================================================================
-- STEP 10. GRANTS (contract 1.8): every new function revoked by name, then exactly the grant listed
-- ============================================================================
revoke all on function public.stock_co__vday(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__is_service() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__multi(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__money(text, numeric) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__tz(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__d3_who(uuid, text, text, uuid[], jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__d3_org_guard() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__po_approval_guard() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__invoice_lock_guard() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__secret_ok(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__hidden_recipes() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__locked_until(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__notify(uuid, uuid, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__forecast_amount(uuid, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__next_delivery(uuid, timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__kitchen_price(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__set_price_here(uuid, uuid, numeric, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__match_invoice(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__inbox_place_auto(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__po_submit_core(uuid, uuid, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__fee_for(uuid, numeric) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__po_send_block(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__po_send_rule() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__is_raiser(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__count_approval_fence() from public, anon, authenticated, service_role;
revoke all on function public.stock_co__standing_over(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__count_due_rows(uuid, uuid[], date) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__d3_scope(uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__budget_of(uuid, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_order_pad_context(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_po_submit(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_po_decide(uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_create_orders_many(uuid, jsonb, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_standing_order(jsonb, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_edit_standing_run(uuid, date, jsonb, boolean, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_delivery_exception(jsonb, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_order_list(jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_due_to_order(uuid, uuid[], jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_orders_page(uuid, uuid[], text, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_deliveries_board(uuid, uuid[], jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_invoices_page(uuid, uuid[], jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_missing_invoices(uuid, uuid[], jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_invoice_match(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_invoices_approve(uuid[], text) from public, anon, authenticated, service_role;
revoke all on function public.stock_invoice_split(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_invoice_inbox_page(uuid, text, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_inbox_place(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_inbox_ignore(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_inbox_address(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_inbox_add(uuid, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_inbox_receive(text, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_credit_request(jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_credit_set_status(uuid, text, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_credit_note(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_credits_page(uuid, uuid[], text, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_price_changes_page(uuid, uuid[], jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_make_company_price(uuid, uuid, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_budget_status(uuid, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_budget_board(uuid, uuid[], date) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_budget(jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_sales_history(uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_forecast_week(uuid, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_forecast(uuid, jsonb, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_forecast_source(uuid, uuid, numeric, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_count_due(uuid, uuid[], date) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_count_plan(jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_count_template(jsonb, jsonb, jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_template_for_site(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_shelf_order(uuid, uuid, uuid[]) from public, anon, authenticated, service_role;
revoke all on function public.stock_second_approve_count(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_lock_period(uuid, date, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_unlock_period(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_waste_reasons(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_fresh_closedown_list(uuid, date, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_request_transfer(uuid, uuid, jsonb, text, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_fulfil_request(uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_dispute_transfer(uuid, text, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_transfer_matches(uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_transfer_list(jsonb, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_set_site_kind(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_kitchen_orders_in(uuid, date, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__pack_base(numeric, numeric, text, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_kitchen_plan(uuid, date, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_kitchen_ingredients(uuid, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__line_base(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__recipe_yield_base(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.stock_kitchen_tick(uuid, uuid, numeric, date, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_kitchen_untick(uuid, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_kitchen_pick(uuid, jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.stock_set_recipe_restricted(uuid, boolean, uuid, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_save_recipe_secret(uuid, text, integer) from public, anon, authenticated, service_role;
revoke all on function public.stock_recharge_statement(uuid, date) from public, anon, authenticated, service_role;
revoke all on function public.stock_recharge_record(uuid, date, uuid, uuid, numeric, text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.stock_co__due_delivery(uuid, smallint[], timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.stock_po_cutoff_run() from public, anon, authenticated, service_role;
revoke all on function public.po_cutoff_cron_ok(text) from public, anon, authenticated, service_role;
revoke all on function public.stock_notify_cron_ok(text) from public, anon, authenticated, service_role;
revoke all on function public.stock_notify_due() from public, anon, authenticated, service_role;
revoke all on function public.stock_notify_targets(bigint) from public, anon, authenticated, service_role;
grant execute on function public.stock_order_pad_context(uuid, jsonb) to authenticated, service_role;
grant execute on function public.stock_po_submit(uuid, text, jsonb) to authenticated, service_role;
grant execute on function public.stock_po_decide(uuid, text, text, text) to authenticated;
grant execute on function public.stock_create_orders_many(uuid, jsonb, text) to authenticated;
grant execute on function public.stock_save_standing_order(jsonb, integer, text) to authenticated;
grant execute on function public.stock_edit_standing_run(uuid, date, jsonb, boolean, jsonb) to authenticated, service_role;
grant execute on function public.stock_save_delivery_exception(jsonb, integer, text) to authenticated;
grant execute on function public.stock_save_order_list(jsonb, integer) to authenticated;
grant execute on function public.stock_due_to_order(uuid, uuid[], jsonb, integer) to authenticated;
grant execute on function public.stock_orders_page(uuid, uuid[], text, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_deliveries_board(uuid, uuid[], jsonb, integer) to authenticated;
grant execute on function public.stock_invoices_page(uuid, uuid[], jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_missing_invoices(uuid, uuid[], jsonb, integer) to authenticated;
grant execute on function public.stock_invoice_match(uuid) to authenticated;
grant execute on function public.stock_invoices_approve(uuid[], text) to authenticated;
grant execute on function public.stock_invoice_split(uuid, jsonb) to authenticated;
grant execute on function public.stock_invoice_inbox_page(uuid, text, jsonb, integer) to authenticated;
grant execute on function public.stock_inbox_place(uuid, uuid, uuid) to authenticated;
grant execute on function public.stock_inbox_ignore(uuid) to authenticated;
grant execute on function public.stock_inbox_address(uuid) to authenticated;
grant execute on function public.stock_inbox_add(uuid, text, text, text) to authenticated;
grant execute on function public.stock_inbox_receive(text, text, text, jsonb) to service_role;
grant execute on function public.stock_save_credit_request(jsonb, integer) to authenticated;
grant execute on function public.stock_credit_set_status(uuid, text, integer, text) to authenticated;
grant execute on function public.stock_save_credit_note(jsonb) to authenticated;
grant execute on function public.stock_credits_page(uuid, uuid[], text, jsonb, integer) to authenticated;
grant execute on function public.stock_price_changes_page(uuid, uuid[], jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_make_company_price(uuid, uuid, integer, text) to authenticated;
grant execute on function public.stock_budget_status(uuid, date) to authenticated, service_role;
grant execute on function public.stock_budget_board(uuid, uuid[], date) to authenticated;
grant execute on function public.stock_save_budget(jsonb, integer) to authenticated;
grant execute on function public.stock_sales_history(uuid, integer) to authenticated;
grant execute on function public.stock_forecast_week(uuid, date) to authenticated;
grant execute on function public.stock_save_forecast(uuid, jsonb, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.stock_save_forecast_source(uuid, uuid, numeric, integer) to authenticated;
grant execute on function public.stock_count_due(uuid, uuid[], date) to authenticated;
grant execute on function public.stock_save_count_plan(jsonb, integer) to authenticated;
grant execute on function public.stock_save_count_template(jsonb, jsonb, jsonb, integer) to authenticated;
grant execute on function public.stock_template_for_site(uuid, uuid) to authenticated;
grant execute on function public.stock_save_shelf_order(uuid, uuid, uuid[]) to authenticated;
grant execute on function public.stock_second_approve_count(uuid, text) to authenticated;
grant execute on function public.stock_lock_period(uuid, date, date) to authenticated;
grant execute on function public.stock_unlock_period(uuid, text) to authenticated;
grant execute on function public.stock_waste_reasons(uuid) to anon, authenticated, service_role;
grant execute on function public.stock_fresh_closedown_list(uuid, date, jsonb) to authenticated, service_role;
grant execute on function public.stock_request_transfer(uuid, uuid, jsonb, text, text, jsonb) to authenticated, service_role;
grant execute on function public.stock_fulfil_request(uuid, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.stock_dispute_transfer(uuid, text, jsonb) to authenticated, service_role;
grant execute on function public.stock_transfer_matches(uuid) to authenticated;
grant execute on function public.stock_save_transfer_list(jsonb, integer) to authenticated;
grant execute on function public.stock_set_site_kind(uuid, text) to authenticated;
grant execute on function public.stock_kitchen_orders_in(uuid, date, jsonb) to authenticated, service_role;
grant execute on function public.stock_kitchen_plan(uuid, date, jsonb) to authenticated, service_role;
grant execute on function public.stock_kitchen_ingredients(uuid, date) to authenticated;
grant execute on function public.stock_kitchen_tick(uuid, uuid, numeric, date, jsonb) to authenticated, service_role;
grant execute on function public.stock_kitchen_untick(uuid, jsonb) to authenticated, service_role;
grant execute on function public.stock_kitchen_pick(uuid, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.stock_set_recipe_restricted(uuid, boolean, uuid, integer) to authenticated;
grant execute on function public.stock_save_recipe_secret(uuid, text, integer) to authenticated;
grant execute on function public.stock_recharge_statement(uuid, date) to authenticated;
grant execute on function public.stock_recharge_record(uuid, date, uuid, uuid, numeric, text, text, text, text) to service_role;
grant execute on function public.po_cutoff_cron_ok(text) to service_role;
grant execute on function public.stock_notify_cron_ok(text) to service_role;
grant execute on function public.stock_notify_targets(bigint) to service_role;

-- every stock_co__ helper closed to the API roles (a revoke, never a drop), then the ones earlier Drops
-- opened go back, plus the two the recipe read rules call as the caller
do $d3_internals$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p
     where p.pronamespace = 'public'::regnamespace and left(p.proname, 9) = 'stock_co_' and substr(p.proname, 10, 1) = '_'
  loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f.sig);
  end loop;
end
$d3_internals$;
grant execute on function public.stock_co__writer_ok() to authenticated, service_role;
grant execute on function public.stock_co__site_lock() to authenticated, service_role;
grant execute on function public.stock_co__site_price_lock() to authenticated, service_role;
grant execute on function public.stock_co__ledger_lock() to authenticated, service_role;
grant execute on function public.stock_co__hidden_recipes() to authenticated, service_role;
grant execute on function public.stock_co__secret_ok(uuid, uuid) to authenticated, service_role;

do $d3_acl$
declare
  v_bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by 1) into v_bad
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and (p.proname ~ '^stock_(save|archive|set|pause|change|cancel|import|copy|make|delete|suggest|resync|swap|prep|facts|batch|recipe_link|po_|create_|edit_|invoice|inbox|credit|budget|forecast|count_|template_|second_|lock_|unlock_|fresh_|request_|fulfil_|dispute_|transfer_|kitchen_|recharge_|notify_|order_|due_|orders_|deliveries_|missing_|price_|sales_)'
          or p.proname in ('stock_post_invoice', 'stock_receive', 'stock_record_waste', 'stock_approve_count_pin', 'post_stock_transfer_leg',
                           'stock_needs_attention', 'stock_recipe_detail', 'po_cutoff_cron_ok'))
     and p.proname <> 'stock_recipe_card' and p.proname <> 'stock_waste_reasons'
     and has_function_privilege('anon', p.oid, 'execute');
  if v_bad is not null then
    raise exception 'The anon key could run a stock function: %. Nothing was changed. Send this line to Claude.', v_bad;
  end if;
  if not has_function_privilege('anon', 'public.stock_waste_reasons(uuid)'::regprocedure, 'execute') then
    raise exception 'The till could not read the waste reasons. Nothing was changed. Send this line to Claude.';
  end if;
end
$d3_acl$;

-- ============================================================================
-- STEP 11. THE COMPARE: no site row, login, menu row, order, transfer, count, waste or forecast row changed
-- ============================================================================
do $now$
declare
  v_orgs uuid[];
begin
  select coalesce(array_agg(distinct i.org_id), '{}'::uuid[]) into v_orgs from public.stock_co_items i;
  insert into _stock_native3_now (location_id, metric, value)
  select l.id, m.metric, coalesce(m.value, 0)
    from public.locations l
   cross join lateral (values
     ('n:inventory_items',               (select count(*) from public.inventory_items x where x.location_id = l.id)::numeric),
     ('rv:inventory_items',              (select sum(x.row_version) from public.inventory_items x where x.location_id = l.id)::numeric),
     ('n:suppliers',                     (select count(*) from public.suppliers x where x.location_id = l.id)::numeric),
     ('rv:suppliers',                    (select sum(x.row_version) from public.suppliers x where x.location_id = l.id)::numeric),
     ('n:supplier_products',             (select count(*) from public.supplier_products x where x.location_id = l.id)::numeric),
     ('rv:supplier_products',            (select sum(x.row_version) from public.supplier_products x where x.location_id = l.id)::numeric),
     ('n:item_packaging_formats',        (select count(*) from public.item_packaging_formats x where x.location_id = l.id)::numeric),
     ('rv:item_packaging_formats',       (select sum(x.row_version) from public.item_packaging_formats x where x.location_id = l.id)::numeric),
     ('n:inventory_item_conversions',    (select count(*) from public.inventory_item_conversions x where x.location_id = l.id)::numeric),
     ('rv:inventory_item_conversions',   (select sum(x.row_version) from public.inventory_item_conversions x where x.location_id = l.id)::numeric),
     ('n:recipes',                       (select count(*) from public.recipes x where x.location_id = l.id)::numeric),
     ('rv:recipes',                      (select sum(x.row_version) from public.recipes x where x.location_id = l.id)::numeric),
     ('n:recipe_lines',                  (select count(*) from public.recipe_lines x where x.location_id = l.id)::numeric),
     ('n:menu_item_recipes',             (select count(*) from public.menu_item_recipes x where x.location_id = l.id)::numeric),
     ('n:par_levels',                    (select count(*) from public.par_levels x where x.location_id = l.id)::numeric),
     ('n:inventory_item_areas',          (select count(*) from public.inventory_item_areas x where x.location_id = l.id)::numeric),
     ('n:stock_movements',               (select count(*) from public.stock_movements x where x.location_id = l.id)::numeric),
     ('s:on_hand',                       (select sum(x.on_hand) from public.inventory_items x where x.location_id = l.id)),
     ('s:current_cost',                  (select sum(x.current_cost) from public.inventory_items x where x.location_id = l.id)),
     ('s:books',                         (select sum(x.on_hand * x.current_cost) from public.inventory_items x where x.location_id = l.id)),
     ('s:mv_qty',                        (select sum(x.qty_base) from public.stock_movements x where x.location_id = l.id)),
     ('s:mv_value',                      (select sum(x.value_delta) from public.stock_movements x where x.location_id = l.id)),
     ('s:area_on_hand',                  (select sum(x.on_hand) from public.inventory_item_area_stock x where x.location_id = l.id)),
     ('n:purchase_orders',               (select count(*) from public.purchase_orders x where x.location_id = l.id)::numeric),
     ('n:po_lines',                      (select count(*) from public.po_lines x where x.location_id = l.id)::numeric),
     ('n:supplier_invoices',             (select count(*) from public.supplier_invoices x where x.location_id = l.id)::numeric),
     ('n:stock_transfers',               (select count(*) from public.stock_transfers x where x.location_id = l.id)::numeric),
     ('n:stock_transfer_lines',          (select count(*) from public.stock_transfer_lines x where x.location_id = l.id)::numeric),
     ('n:stock_counts',                  (select count(*) from public.stock_counts x where x.location_id = l.id)::numeric),
     ('n:waste_events',                  (select count(*) from public.waste_events x where x.location_id = l.id)::numeric),
     ('n:wf_sales_forecast',             (select count(*) from public.wf_sales_forecast x where x.location_id = l.id)::numeric),
     ('s:stock_movements_qty',           (select sum(x.qty_base) from public.stock_movements x where x.location_id = l.id)),
     ('s:inventory_items_on_hand',       (select sum(x.on_hand) from public.inventory_items x where x.location_id = l.id)),
     ('s:inventory_items_current_cost',  (select sum(x.current_cost) from public.inventory_items x where x.location_id = l.id))
   ) as m(metric, value)
   where l.org_id = any (v_orgs);
  insert into _stock_native3_now (location_id, metric, value, txt)
  values ('00000000-0000-0000-0000-000000000000', 'md5:user_profiles', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.user_profiles t)),
         ('00000000-0000-0000-0000-000000000000', 'md5:user_locations', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.user_locations t)),
         ('00000000-0000-0000-0000-000000000000', 'md5:menu_items', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.menu_items t));
end
$now$;

do $d3_compare$
declare
  v_diff text;
begin
  select string_agg(coalesce(a.location_id, b.location_id)::text || ' ' || coalesce(a.metric, b.metric), ', ' order by 1) into v_diff
    from _stock_native3_snap a
    full join _stock_native3_now b on b.location_id = a.location_id and b.metric = a.metric
   where a.metric is null or b.metric is null
      or a.value is distinct from b.value or a.txt is distinct from b.txt;
  if v_diff is not null then
    raise exception 'A site row, a login, a menu row or an order changed: %. Nothing was changed. Send this line to Claude.', left(v_diff, 600);
  end if;
end
$d3_compare$;

notify pgrst, 'reload schema';

-- ============================================================================
-- THE CHECK ROW (one row per company that holds stock). Paste it back.
-- ============================================================================
select o.org_id,
       public.stock_co__multi(o.org_id) as multi,
       (select count(*) from public.stock_native_backup b where left(b.name, 3) = 'd3:')::integer as replaced_functions,
       (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in (
         'stock_order_pad_context',
         'stock_po_submit',
         'stock_po_decide',
         'stock_create_orders_many',
         'stock_save_standing_order',
         'stock_edit_standing_run',
         'stock_save_delivery_exception',
         'stock_save_order_list',
         'stock_due_to_order',
         'stock_orders_page',
         'stock_deliveries_board',
         'stock_invoices_page',
         'stock_missing_invoices',
         'stock_invoice_match',
         'stock_invoices_approve',
         'stock_invoice_split',
         'stock_invoice_inbox_page',
         'stock_inbox_place',
         'stock_inbox_ignore',
         'stock_inbox_address',
         'stock_inbox_add',
         'stock_inbox_receive',
         'stock_save_credit_request',
         'stock_credit_set_status',
         'stock_save_credit_note',
         'stock_credits_page',
         'stock_price_changes_page',
         'stock_make_company_price',
         'stock_budget_status',
         'stock_budget_board',
         'stock_save_budget',
         'stock_sales_history',
         'stock_forecast_week',
         'stock_save_forecast',
         'stock_save_forecast_source',
         'stock_count_due',
         'stock_save_count_plan',
         'stock_save_count_template',
         'stock_template_for_site',
         'stock_save_shelf_order',
         'stock_second_approve_count',
         'stock_lock_period',
         'stock_unlock_period',
         'stock_waste_reasons',
         'stock_fresh_closedown_list',
         'stock_request_transfer',
         'stock_fulfil_request',
         'stock_dispute_transfer',
         'stock_transfer_matches',
         'stock_save_transfer_list',
         'stock_set_site_kind',
         'stock_kitchen_orders_in',
         'stock_kitchen_plan',
         'stock_kitchen_ingredients',
         'stock_kitchen_tick',
         'stock_kitchen_untick',
         'stock_kitchen_pick',
         'stock_set_recipe_restricted',
         'stock_save_recipe_secret',
         'stock_recharge_statement',
         'stock_recharge_record',
         'stock_po_cutoff_run',
         'po_cutoff_cron_ok',
         'stock_notify_cron_ok',
         'stock_notify_due',
         'stock_notify_targets'
       ))::integer as new_functions,
       (select count(*) from (values ('stock_po_approvals'), ('stock_po_send_jobs'), ('stock_standing_orders'), ('stock_standing_order_lines'),
                                     ('stock_standing_runs'), ('stock_delivery_exceptions'), ('stock_order_lists'), ('stock_budgets'),
                                     ('stock_invoice_inbox'), ('supplier_invoice_site_splits'), ('stock_credit_requests'), ('stock_credit_request_lines'),
                                     ('stock_credit_notes'), ('stock_count_plans'), ('stock_count_templates'), ('stock_count_template_lines'),
                                     ('stock_count_template_sites'), ('stock_template_shelf_order'), ('stock_transfer_lists'), ('stock_forecast_hours'),
                                     ('stock_co_site_forecast_source'), ('stock_co_recipe_secrets'), ('stock_kitchen_plan_ticks'),
                                     ('stock_recharge_posts'), ('stock_notify_sent')) t(n)
         where to_regclass('public.' || t.n) is not null)::integer as new_tables,
       (select count(*) from information_schema.columns c
         where c.table_schema = 'public' and (c.table_name, c.column_name) in (
           ('wf_sales_forecast', 'reason'),
           ('wf_sales_forecast', 'reason_note'),
           ('wf_sales_forecast', 'edited_by'),
           ('wf_sales_forecast', 'edited_by_name'),
           ('wf_sales_forecast', 'edited_at'),
           ('purchase_orders', 'delivery_fee'),
           ('purchase_orders', 'standing_order_id'),
           ('purchase_orders', 'sent_unapproved_at'),
           ('po_lines', 'qty_draft'),
           ('po_lines', 'ordered_unit_price'),
           ('supplier_invoices', 'match_status'),
           ('supplier_invoices', 'match_detail'),
           ('supplier_invoices', 'approved_at'),
           ('supplier_invoices', 'approved_by_name'),
           ('supplier_invoices', 'locked_at'),
           ('supplier_invoices', 'inbox_id'),
           ('stock_counts', 'plan_id'),
           ('stock_counts', 'template_id'),
           ('stock_counts', 'second_approval_needed_at'),
           ('stock_counts', 'first_approved_by'),
           ('stock_counts', 'first_approved_by_name'),
           ('stock_counts', 'first_approved_by_staff_id'),
           ('stock_counts', 'second_approved_by'),
           ('stock_counts', 'second_approved_by_name'),
           ('stock_counts', 'second_approved_at'),
           ('waste_events', 'approved_by_staff_id'),
           ('waste_events', 'approved_by_staff_name'),
           ('stock_transfers', 'kind'),
           ('stock_transfers', 'reason'),
           ('stock_transfers', 'requested_by_name'),
           ('stock_transfers', 'requested_at'),
           ('stock_transfers', 'disputed_at'),
           ('stock_transfers', 'dispute_note'),
           ('stock_transfers', 'resolved_at'),
           ('stock_transfers', 'resolved_by_name'),
           ('stock_transfers', 'purchase_order_id'),
           ('stock_transfer_lines', 'lot_code'),
           ('stock_transfer_lines', 'use_by_at'),
           ('stock_transfer_lines', 'requested_qty_base'),
           ('stock_co_suppliers', 'fee_waived_over_min'),
           ('stock_co_settings', 'inbox_token')
         ))::integer as new_columns,
       (select pg_get_constraintdef(k.oid) like '%REQUESTED%' and pg_get_constraintdef(k.oid) like '%DISPUTED%'
          from pg_constraint k where k.conrelid = 'public.stock_transfers'::regclass and k.conname = 'stock_transfers_status_chk') as transfer_status_check,
       exists (select 1 from pg_trigger g where g.tgrelid = 'public.purchase_orders'::regclass and g.tgname = 'purchase_orders_approval_guard') as approval_guard,
       (select count(*) = 2 from pg_trigger g where g.tgname = 'supplier_invoices_lock_guard') as invoice_lock_guard,
       (select count(*) = 2 from pg_policies y where y.schemaname = 'public' and y.policyname in ('stock_co_recipes_read', 'stock_co_recipe_lines_read')
           and y.qual like '%stock_co__hidden_recipes%') as recipe_policies,
       (select count(*) from cron.job c where c.jobname in ('stock-notify', 'po-cutoff-run'))::integer as cron_jobs,
       (select count(*) from vault.secrets s where s.name in ('stock_notify_cron_key', 'po_cutoff_cron_key'))::integer as vault_keys,
       exists (select 1 from storage.buckets b where b.id = 'stock-invoice-inbox' and not b.public) as bucket,
       exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace and left(p.proname, 9) = 'stock_co_' and substr(p.proname, 10, 1) = '_'
                  and p.proname not in ('stock_co__writer_ok', 'stock_co__site_lock', 'stock_co__site_price_lock', 'stock_co__ledger_lock',
                                        'stock_co__hidden_recipes', 'stock_co__secret_ok')
                  and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                       or has_function_privilege('service_role', p.oid, 'execute'))) as internals_open_to_api,
       exists (select 1 from pg_proc p
                where p.pronamespace = 'public'::regnamespace
                  and p.proname ~ '^stock_(save|archive|set|pause|change|cancel|import|copy|make|delete|suggest|resync|swap|prep|facts|batch|recipe_link|po_|create_|edit_|invoice|inbox|credit|budget|forecast|lock_|unlock_|request_|fulfil_|dispute_|kitchen_|recharge_|second_)'
                  and has_function_privilege('anon', p.oid, 'execute')) as anon_can_save,
       (select count(*) from public.stock_co_site_settings s where s.org_id = o.org_id and s.site_kind is not null)::integer as site_kinds,
       (select count(*) from public.stock_co_suppliers c where c.org_id = o.org_id and c.internal_location_id is not null)::integer as internal_suppliers,
       (select count(*) from public.stock_po_approvals a where a.org_id = o.org_id)::integer as approvals,
       (select count(*) from public.stock_notify_sent n where n.org_id = o.org_id)::integer as notify_rows,
       (select count(*) from public.stock_po_send_jobs j join public.locations l on l.id = j.location_id where l.org_id = o.org_id)::integer as send_jobs,
       0 as site_rows_changed,
       false as orders_changed,
       false as menu_rows_changed,
       false as logins_changed
  from (select distinct i.org_id from public.stock_co_items i) o
 order by o.org_id;
