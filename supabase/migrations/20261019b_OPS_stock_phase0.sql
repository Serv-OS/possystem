-- 20261019b_OPS_stock_phase0.sql
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand (Claude cannot run DDL on production).           #
-- #  NEEDS 20261018a (stock fences) AND 20261018c (central stock depletion)   #
-- #  live first (v5.11.77). One transaction: any error and nothing changes.   #
-- #  Safe to run twice. Run OUTSIDE UK service: four small stock tables are   #
-- #  rewritten for the wider cost column (a few thousand rows today, under a  #
-- #  second), and the lock wait is 3 s (it gives up, nothing changes).        #
-- ############################################################################
--
-- WHY (multi site stock plan, 18 Oct 2026, section 7 "Phase 0" and 11.5): the safety pass on the
-- stock every venue has today (Provo, Location 2 and one other company hold stock). Worth doing with
-- no sharing at all, and needed before Coffee Boy gets stock items. Central stock is NOT switched
-- here: 20261019 (v5.11.78, run 19 Oct 2026) made every venue central, and every new venue central
-- the moment it is created. This file does not touch stock_depletion_mode.
--
-- WHAT CHANGES (every change is additive: new columns, tables, functions, indexes and triggers;
-- four function bodies are replaced on top of their live text, md5 guarded; no stock row is updated)
--   0. _stock_counted_after (20261018c) is replaced: the late sale adjustment is now booked by
--      _post_stock_movement itself (item 3), from the time each line was counted and by area, under
--      the same key late:<key>, so the drainer's own guard answers false and never doubles it.
--   1. Counting while trading (11.5 item 1, decision 1 in 11.10): every count line records WHEN it
--      was counted (stock_count_lines.counted_at, stamped by the database clock). Approval is ONE
--      database call, approve_stock_count: it locks the items in id order, works out each line
--      against the stock held at the moment that line was counted, posts the adjustment dated to
--      that moment, and stores expected and variance from the same figure. Sales made during the
--      count are never added back. The database stamps counted_at itself (an API caller cannot
--      write it, on insert or later); a count older than a count of the same item (and area)
--      approved already is SUPERSEDED: approving it posts nothing for those lines, so the newest
--      count stays the truth. An approved count is locked in the database: its lines cannot be
--      added, changed or removed, and the count cannot be reopened, re figured or deleted (only the
--      service role or the SQL editor can).
--   2. Opening count (4.6): the first count of an item at a venue posts OPENING_BALANCE, not a gain.
--      It is costed (the item's cost, else the price the screen sends, else the line's cost) and
--      never 0: approval stops and names the items that need a price. The Gap and the count's
--      variance leave it out (stock_counts.opening_value holds its value apart).
--   3. Late sale rule (11.5 item 2): a movement dated BEFORE an approved count of that item (an
--      offline till catching up, a late drained sale, back dated waste) is posted with an equal and
--      opposite count adjustment dated at the count, key late:<key>, so on hand still equals the
--      count plus later movements, the sale still shows in usage and The Gap nets to 0.
--   4. Item lock and lock order (11.5 items 4 and 5): _post_stock_movement locks the item row FIRST,
--      before it reads the use area; the area re home trigger takes the same lock first; transfers,
--      count approval, receipts and waste lock every item they touch in id order before the first
--      post, so two writers can never deadlock (the drainer of 20261018c also posts in item id order).
--      The row lock is FOR NO KEY UPDATE (what an UPDATE of on hand takes anyway): every writer still
--      queues on the item, but saving a count sheet, an order, an invoice or a transfer line that
--      points at the item (a key share lock) never waits on it, so those saves cannot deadlock with a
--      receipt, an approval or a till sale.
--   5. Precision (11.5 item 9): unit costs keep 8 decimals (milk per ml lost up to 0.5% at 5);
--      the quantity is rounded once, at the top of the posting; on hand on items and on areas share
--      one scale (16,4).
--   6. Return cap (11.5 item 6): a RETURN keyed return:<check>:...:<item> never returns more than
--      sale:<check>:<item> actually took, less earlier returns and their undos (a refund of a sale
--      that never took stock off returns nothing), valued at that sale's own unit cost.
--   7. Receiving in one database step (11.5 item 3): stock_receive (a purchase order receive) and
--      stock_post_invoice (an invoice, its lines and its receipts) lock the items in id order, work
--      from the locked on hand and write the movement, the cost history (with the supplier pack and
--      the pack price) and the cost together. Below zero or an unknown cost takes the delivery price,
--      never an average. An invoice for an order already received is kept as paperwork and never
--      counts the stock twice; a second posted invoice with the same number from the same supplier at
--      the same venue is refused. The screen sends its own invoice id (client_id): a retry after a lost
--      answer is answered duplicate, so an invoice with no number never posts twice. A receive is Back
--      Office work (a Back Office login, the owner, the Manager app through the service role) or the
--      venue's Ops tablet; a till or a kiosk cannot receive (it would set the item's cost).
--   8. Cost rule per venue (4.5, decision 2): stock_site_settings.cost_rule, 'price_list' (the
--      default: exactly what every venue does today) or 'deliveries'. Read by the Back Office price
--      save. No row means price list, so no number moves anywhere today.
--   9. Waste never refused (4.7): stock_record_waste writes the waste row and its WASTE movements in
--      one call; for a menu product the database explodes that ONE product through its recipe (the
--      same stock_explode rule as central depletion), so the till no longer reads the whole recipe
--      book to log one waste (11.5 item 8). A product with no recipe is recorded by product, tagged
--      no_recipe ("No recipe: stock not taken off"), with waste_events.menu_item_id. A stock item
--      waste sent with no lines takes its own quantity off (a call with no quantity is refused).
--  10. Deletes keep ledgers: an item with stock history cannot be deleted (archive it); a pack used
--      by a recipe line cannot be deleted.
--  11. Transfers (4.8): unit conversion on receive (blocked, in words, when the units cannot
--      convert); Short on transfer: what did not arrive (or a dropped line) is booked AT THE SENDER
--      as waste with reason "Short on transfer", after a reversal of the shortfall, so the sender's
--      on hand is unchanged and the loss shows in its waste; one company only, now also in the insert
--      policy of both transfer tables; the receiver's cost moves like a delivery (below zero or an
--      unknown cost takes the transfer cost). What arrives is rounded DOWN in the receiver's unit
--      (never more than was sent); a remainder under half a 4th decimal step of the coarser unit is
--      not booked as Short on transfer (11.6438 ml into litres arrives as 0.0116 l, no short).
--  12. Site indexes (11.5 item 7) on recipe_lines, item_packaging_formats, inventory_item_conversions,
--      supplier_products, po_lines, item_cost_history, and small partial indexes for the new rules.
--  13. The order pad's usage reads, in pages of 1,000 items (11.5 item 11): stock_usage_weekday_page
--      (the weekday pattern on the venue's own clock, not UTC, one row per item with 7 values) and
--      stock_usage_rates_page. The live stock_usage_by_weekday and stock_usage_rates stay as they are
--      for screens not yet updated (those return up to one row per item and day, capped at 1,000).
--  14. msm_stock_recipe_gaps: the Multi site menu's read only warning "12 products have a recipe at
--      Provo but none at Location 2". Reads only; touches no menu table or function.
--  15. Who may ask: stock_cost_rule answers the venue's rule only to a caller that reaches the venue
--      (else the default); stock_same_company answers false unless the caller reaches the first venue.
--      approve_stock_count checks the caller before it locks anything.
--
-- WHAT IT DOES NOT TOUCH
--   post_stock_movement (20261018c's door) and set_inventory_on_hand (20261018a): the caller check
--   and the central door stay exactly as they are; they call _post_stock_movement, whose body this
--   file replaces. The outbox, the drainer, the sweep, the enqueue triggers, stock_central_switch and
--   the stock-deplete edge function (20261018c, v5.11.77). Movement keys: sale:<check>:<item>,
--   return:<check>:<refund id>:<item>, count:<count>:<item>[:<area>], po:<po>:<line>, inv:<inv>:<item>:<i>,
--   waste:<event>[:<item>], transfer:<t>:<line>:out|in|cancel are all unchanged.
--   No menu (msm_*) table or function. No row of any stock table is updated.
--
-- AFTER THIS FILE, A SECOND PASTE OF 20261018c STOPS WITH "Nothing was changed": its guard knows
--   only its own post_stock_transfer_leg text, and this file's leg (units, Short on transfer) is
--   newer. That is on purpose: 20261018c can never undo this file's rules. Its tables, rows and
--   triggers are untouched either way.
--
-- GUARD: _post_stock_movement must be exactly 20261018a's text, post_stock_transfer_leg and
--   _stock_counted_after 20261018c's, inventory_item_areas_rehome 20261016's, or this file's own (a
--   second run). Anything else and NOTHING is changed: it says which, and the line goes to Claude.
--
-- Proof: supabase/tests/stock_phase0/run.mjs (local Postgres 17 with 20261018a, 20261018c and
--   20261019 applied as Peter ran them, the real roles, the live timeouts: authenticated and service
--   role 8 s, anon 3 s; bound till, kiosk, Back Office login, owner, other company, stranger, service
--   role, SQL editor; a second paste of 20261018c; property runs, a 2,250 line count approval,
--   concurrency with count sheet, order and invoice saves racing receipts, approvals and sales).
-- UNDO: 20261019b_OPS_stock_phase0_ROLLBACK.sql
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
  if to_regprocedure('public.stock_caller_reaches(uuid)') is null
     or to_regprocedure('public._post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)') is null then
    raise exception 'Run 20261018a_OPS_stock_function_fences.sql (v5.11.76) first: stock_caller_reaches or _post_stock_movement is missing. Nothing was changed.';
  end if;
  if to_regclass('public.stock_depletion_mode') is null or to_regclass('public.stock_outbox') is null
     or to_regprocedure('public.stock_central_switch(uuid,text,text)') is null
     or to_regprocedure('public.stock_explode(uuid,jsonb,text,text)') is null
     or to_regprocedure('public._stock_counted_after(uuid,uuid,timestamptz)') is null then
    raise exception 'Run 20261018c_OPS_central_stock_depletion.sql (v5.11.77) first: the central stock tables or functions are missing. Nothing was changed.';
  end if;
  if to_regclass('public.storage_areas') is null or to_regclass('public.stock_transfer_lines') is null then
    raise exception 'The stock area tables are missing: run 20261016_OPS_stock_areas.sql first. Nothing was changed.';
  end if;
  if to_regclass('public.msm_product_sites') is null or to_regclass('public.msm_menus') is null
     or to_regprocedure('public.msm_can_view(uuid)') is null then
    raise exception 'The Multi site menu tables are missing: run 20261017_OPS_multi_site_menu.sql first. Nothing was changed.';
  end if;

  select md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) into v_md5 from pg_proc p
   where p.oid = to_regprocedure('public._post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)');
  if v_md5 is null or v_md5 not in ('e9865d7cad62f582db4e904bf41ad512', '2974176b3ea49b90065dc0c20572e343') then
    v_bad := v_bad || ' _post_stock_movement=' || coalesce(v_md5, 'missing');
  end if;
  select md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) into v_md5 from pg_proc p
   where p.oid = to_regprocedure('public.post_stock_transfer_leg(uuid,text,text)');
  if v_md5 is null or v_md5 not in ('541ac92297e3784706a2f7a958d5c396', 'f321c21b48115a8de8fbfcb021ab4577') then
    v_bad := v_bad || ' post_stock_transfer_leg=' || coalesce(v_md5, 'missing');
  end if;
  select md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) into v_md5 from pg_proc p
   where p.oid = to_regprocedure('public._stock_counted_after(uuid,uuid,timestamptz)');
  if v_md5 is null or v_md5 not in ('d9792fc95826ff4691437bbeb7133dea', '7c413f3e439a68bc8d0440c97580d638') then
    v_bad := v_bad || ' _stock_counted_after=' || coalesce(v_md5, 'missing');
  end if;
  select md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) into v_md5 from pg_proc p
   where p.oid = to_regprocedure('public.inventory_item_areas_rehome()');
  if v_md5 is null or v_md5 not in ('fa39649e37be3f6645d3ac390989ead4', 'd1776e100d95826e79f55218ead52cb6') then
    v_bad := v_bad || ' inventory_item_areas_rehome=' || coalesce(v_md5, 'missing');
  end if;
  if v_bad <> '' then
    raise exception 'These functions are not the version this file was written for, so nothing was changed. Send this line to Claude:%', v_bad;
  end if;

  -- The unique rule on invoice numbers below would stop the file half way: say it in words first.
  if exists (
    select 1 from public.supplier_invoices
     where status = 'POSTED' and invoice_number is not null and btrim(invoice_number) <> ''
     group by location_id, coalesce(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(btrim(invoice_number))
    having count(*) > 1) then
    raise exception 'Two posted invoices from one supplier share a number at a venue. Nothing was changed. Send this line to Claude: duplicate invoice numbers.';
  end if;
end
$guard$;

-- Fail fast instead of making till calls queue behind this script.
set local lock_timeout = '3s';
set local statement_timeout = '120s';

-- == 1. Columns and the settings table ===========================================================
-- Each step runs only when it is not there yet: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT
-- EXISTS and DROP/CREATE POLICY still lock the table when the thing exists, so a second paste would
-- make stock posts and the drainer's waste rows wait behind this script for nothing.
do $cols$
declare
  r record;
begin
  for r in
    select * from (values
      ('stock_count_lines', 'counted_at', 'timestamptz',
       'When the counted figure was entered (database clock, stamped by stock_count_lines_counted_at). Approval works out the line against the stock held at this moment. 20261019b.'),
      ('stock_count_lines', 'is_opening', 'boolean not null default false',
       'Set by approve_stock_count: this line was the item''s first count at the venue and posted OPENING_BALANCE (left out of The Gap and variance). 20261019b.'),
      ('stock_counts', 'opening_value', 'numeric(14,2)',
       'Value of the OPENING_BALANCE this count posted (kept apart from variance_value). 20261019b.'),
      ('waste_events', 'menu_item_id', 'text',
       'The menu product wasted (menu_items.id at the venue), when the waste is by product. 20261019b.'),
      ('waste_events', 'no_recipe', 'boolean not null default false',
       'True when a product waste took nothing off stock: "No recipe: stock not taken off". 20261019b.'),
      ('item_cost_history', 'pack_label', 'text',
       'The supplier pack the price was paid for ("6 x 1 l"), on PO_RECEIPT and INVOICE rows. pack_price is the net price paid for one such pack. 20261019b.'),
      ('supplier_invoice_lines', 'supplier_product_id', 'uuid references public.supplier_products(id) on delete set null',
       'The supplier pack this invoice line was bought in (its pack and price), when matched. 20261019b.'),
      ('stock_transfer_lines', 'to_base_unit', 'text',
       'The receiving item''s base unit at the receive (qty_received_base is in it). 20261019b.'),
      ('stock_transfer_lines', 'short_qty_base', 'numeric(16,4)',
       'What did not arrive, in the SENDER''s base unit: booked at the sender as waste, reason Short on transfer. 20261019b.'),
      ('stock_transfer_lines', 'to_unit_cost', 'numeric(18,8)',
       'The transfer cost per RECEIVING base unit (sender cost divided by the unit factor). 20261019b.')
    ) as t(tbl, col, typ, note)
  loop
    if not exists (select 1 from information_schema.columns c
                    where c.table_schema = 'public' and c.table_name = r.tbl and c.column_name = r.col) then
      execute format('alter table public.%I add column %I %s', r.tbl, r.col, r.typ);
      execute format('comment on column public.%I.%I is %L', r.tbl, r.col, r.note);
    end if;
  end loop;
end
$cols$;

create table if not exists public.stock_site_settings (
  location_id      uuid primary key,
  cost_rule        text not null default 'price_list',
  updated_at       timestamptz not null default now(),
  updated_by_name  text,
  constraint stock_site_settings_cost_rule_ok check (cost_rule in ('price_list', 'deliveries'))
);
do $settings$
begin
  if obj_description('public.stock_site_settings'::regclass, 'pg_class') is null then
    comment on table public.stock_site_settings is 'Stock settings per venue (20261019b). cost_rule: price_list (default, a supplier price change sets the cost) or deliveries (cost is the average paid; a price change only sets the cost of an item never received). No row means price_list.';
  end if;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'public.stock_site_settings'::regclass) then
    alter table public.stock_site_settings enable row level security;
  end if;
  if not exists (select 1 from pg_policy p where p.polrelid = 'public.stock_site_settings'::regclass and p.polname = 'stock_site_settings_read') then
    create policy stock_site_settings_read on public.stock_site_settings
      for select using (location_id in (select public.accessible_location_uuids()));
  end if;
  if not exists (select 1 from pg_policy p where p.polrelid = 'public.stock_site_settings'::regclass and p.polname = 'stock_site_settings_insert') then
    create policy stock_site_settings_insert on public.stock_site_settings
      for insert with check ((location_id)::text in (select public.user_accessible_locations()));
  end if;
  if not exists (select 1 from pg_policy p where p.polrelid = 'public.stock_site_settings'::regclass and p.polname = 'stock_site_settings_update') then
    create policy stock_site_settings_update on public.stock_site_settings
      for update using ((location_id)::text in (select public.user_accessible_locations()))
      with check ((location_id)::text in (select public.user_accessible_locations()));
  end if;
  if to_regprocedure('public.second_step_ok()') is not null
     and not exists (select 1 from pg_policy p where p.polrelid = 'public.stock_site_settings'::regclass and p.polname = 'second_step_fence') then
    execute 'create policy second_step_fence on public.stock_site_settings as restrictive for all to authenticated '
         || 'using ((select public.second_step_ok())) with check ((select public.second_step_ok()))';
  end if;
end
$settings$;
revoke all on public.stock_site_settings from public, anon;
grant select, insert, update on public.stock_site_settings to authenticated;
grant all on public.stock_site_settings to service_role;

-- == 2. Precision ===================================================================================
-- Unit costs to 8 decimals, on hand to one scale. Only a column whose type is not already the
-- target is altered (a second run does nothing). Widening keeps every stored value exactly.
do $precision$
declare
  r record;
begin
  for r in
    select * from (values
      ('inventory_items', 'current_cost', 'numeric(18,8)'),
      ('inventory_items', 'on_hand', 'numeric(16,4)'),
      ('stock_movements', 'unit_cost', 'numeric(18,8)'),
      ('item_cost_history', 'base_unit_cost', 'numeric(18,8)'),
      ('item_cost_history', 'moving_avg_cost', 'numeric(18,8)'),
      ('stock_count_lines', 'unit_cost', 'numeric(18,8)'),
      ('stock_transfer_lines', 'unit_cost', 'numeric(18,8)'),
      ('production_batches', 'output_unit_cost', 'numeric(18,8)')
    ) as t(tbl, col, target)
  loop
    if (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
         where a.attrelid = format('public.%I', r.tbl)::regclass and a.attname = r.col and not a.attisdropped) is distinct from r.target then
      execute format('alter table public.%I alter column %I type %s', r.tbl, r.col, r.target);
    end if;
  end loop;
end
$precision$;

-- == 3. Indexes =====================================================================================
-- Site indexes (11.5 item 7), each only when missing. The count lookups of the late sale rule
-- (item 3) and of opening stock use stock_count_lines_loc_item_idx and 20261018c's
-- stock_mv_count_idx; the return cap uses 20261018c's stock_mv_source_idx.
do $idx$
declare
  r record;
begin
  for r in
    select * from (values
      ('recipe_lines_loc_recipe_idx', 'create index recipe_lines_loc_recipe_idx on public.recipe_lines (location_id, recipe_id)'),
      ('recipe_lines_loc_pack_unit_idx', 'create index recipe_lines_loc_pack_unit_idx on public.recipe_lines (location_id, unit) where unit like ''@%'''),
      ('item_pack_fmt_loc_item_idx', 'create index item_pack_fmt_loc_item_idx on public.item_packaging_formats (location_id, inventory_item_id)'),
      ('inv_item_conv_loc_item_idx', 'create index inv_item_conv_loc_item_idx on public.inventory_item_conversions (location_id, inventory_item_id)'),
      ('supplier_products_loc_item_idx', 'create index supplier_products_loc_item_idx on public.supplier_products (location_id, inventory_item_id)'),
      ('po_lines_loc_po_idx', 'create index po_lines_loc_po_idx on public.po_lines (location_id, po_id, sort_order)'),
      ('item_cost_hist_loc_item_idx', 'create index item_cost_hist_loc_item_idx on public.item_cost_history (location_id, inventory_item_id, effective_from desc)'),
      ('stock_count_lines_loc_item_idx', 'create index stock_count_lines_loc_item_idx on public.stock_count_lines (location_id, inventory_item_id, counted_at desc)'),
      ('waste_events_loc_menu_item_idx', 'create index waste_events_loc_menu_item_idx on public.waste_events (location_id, menu_item_id) where menu_item_id is not null'),
      ('supplier_invoices_posted_number_uniq', 'create unique index supplier_invoices_posted_number_uniq on public.supplier_invoices '
         || '(location_id, coalesce(supplier_id, ''00000000-0000-0000-0000-000000000000''::uuid), lower(btrim(invoice_number))) '
         || 'where status = ''POSTED'' and invoice_number is not null and btrim(invoice_number) <> ''''')
    ) as t(name, ddl)
  loop
    if to_regclass('public.' || r.name) is null then
      execute r.ddl;
    end if;
  end loop;
end
$idx$;

-- == 4. Small helpers ===============================================================================

-- Back Office work at a venue (count approval, invoices): the service role, the database itself, or
-- a Back Office login that reaches the venue (user_accessible_locations: linked, owner of its
-- company, super admin). Never an anonymous till or kiosk session.
create or replace function public.stock_office_reaches(p_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select p_location_id is not null
     and (
          coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
       or (coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = ''
           and session_user::text not in ('authenticator', 'anon', 'authenticated'))
       or (p_location_id)::text in (select public.user_accessible_locations())
     );
$fn$;
comment on function public.stock_office_reaches(uuid) is 'Back Office stock work at a venue: service role, the database itself, or user_accessible_locations() (never an anonymous device). 20261019b.';
revoke all on function public.stock_office_reaches(uuid) from public;
grant execute on function public.stock_office_reaches(uuid) to authenticated, service_role;

-- Are two venues of one company? Answered only to a caller that reaches the first venue (the transfer
-- insert rules already need that), so a stranger cannot map which venues belong together.
create or replace function public.stock_same_company(p_a uuid, p_b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select p_a is not null and p_b is not null
     and public.stock_caller_reaches(p_a)
     and (p_a = p_b
          or exists (select 1 from locations a join locations b on b.org_id = a.org_id
                      where a.id = p_a and b.id = p_b and a.org_id is not null));
$fn$;
revoke all on function public.stock_same_company(uuid, uuid) from public;
grant execute on function public.stock_same_company(uuid, uuid) to authenticated, service_role;

create or replace function public.stock_cost_rule(p_location_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $fn$
  -- The venue's own rule only for a caller that reaches it; anyone else gets the default.
  select case when public.stock_caller_reaches(p_location_id)
              then coalesce((select s.cost_rule from stock_site_settings s where s.location_id = p_location_id), 'price_list')
              else 'price_list' end;
$fn$;
revoke all on function public.stock_cost_rule(uuid) from public;
grant execute on function public.stock_cost_rule(uuid) to authenticated, service_role;

-- The caller is the database itself (SQL editor, pg_cron, a migration) or the service role (an edge
-- function), never a Back Office login, a till or a kiosk. The count locks below let only these through.
-- Owner only: the SECURITY DEFINER triggers call it.
create or replace function public._stock_caller_is_system()
returns boolean
language sql
stable
set search_path = public
as $fn$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
      or (coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = ''
          and session_user::text not in ('authenticator', 'anon', 'authenticated'));
$fn$;
revoke all on function public._stock_caller_is_system() from public, anon, authenticated, service_role;

-- Is this database on 20261019b? The Back Office asks once a session and keeps its old paths
-- until the answer is 1.
create or replace function public.stock_phase0_ready()
returns integer
language sql
immutable
as $fn$ select 1 $fn$;
revoke all on function public.stock_phase0_ready() from public;
grant execute on function public.stock_phase0_ready() to anon, authenticated, service_role;

-- Convert a quantity between two unit codes: the same dimension through stock_units, or across
-- dimensions through ONE unit bridge of the named items (1 each = 110 g). Null when no path: the
-- caller refuses in words, it never guesses. Invoker rights, owner only: it runs inside the
-- SECURITY DEFINER functions below, never through the API.
create or replace function public.stock_convert_qty(p_qty numeric, p_from text, p_to text, p_items uuid[] default null)
returns numeric
language plpgsql
stable
set search_path = public
as $fn$
declare
  v_f record;
  v_t record;
  b record;
begin
  if p_qty is null or p_from is null or p_to is null then return null; end if;
  if lower(btrim(p_from)) = lower(btrim(p_to)) then return p_qty; end if;
  select u.code, u.dimension, u.to_canonical into v_f from stock_units u where u.code = lower(btrim(p_from));
  select u.code, u.dimension, u.to_canonical into v_t from stock_units u where u.code = lower(btrim(p_to));
  if v_f.code is null or v_t.code is null then return null; end if;
  if v_f.dimension = v_t.dimension then
    return p_qty * v_f.to_canonical / v_t.to_canonical;
  end if;
  if p_items is null then return null; end if;
  for b in
    select c.from_qty, c.to_qty, uf.dimension as df, uf.to_canonical as cf, ut.dimension as dt, ut.to_canonical as ct
      from inventory_item_conversions c
      join stock_units uf on uf.code = lower(btrim(c.from_unit))
      join stock_units ut on ut.code = lower(btrim(c.to_unit))
     where c.inventory_item_id = any(p_items) and c.from_qty > 0 and c.to_qty > 0
     order by array_position(p_items, c.inventory_item_id), c.created_at, c.id
  loop
    if b.df = v_f.dimension and b.dt = v_t.dimension then
      return p_qty * v_f.to_canonical / b.cf * (b.to_qty / b.from_qty) * b.ct / v_t.to_canonical;
    elsif b.dt = v_f.dimension and b.df = v_t.dimension then
      return p_qty * v_f.to_canonical / b.ct * (b.from_qty / b.to_qty) * b.cf / v_t.to_canonical;
    end if;
  end loop;
  return null;
end
$fn$;
revoke all on function public.stock_convert_qty(numeric, text, text, uuid[]) from public, anon, authenticated, service_role;

-- == 5. _post_stock_movement: the posting itself ==================================================
-- 20261018a's body (venue checks on the item and the area, no caller check, owner only) with:
--   * LOCK: the item row is locked FIRST, before the use area is read (11.5 item 4);
--   * PRECISION: the quantity is rounded once, here, to 4 places (11.5 item 9);
--   * RETURN CAP: a RETURN keyed return:<check>:...:<item> never exceeds what sale:<check>:<item>
--     took, less earlier returns of that check item and their undos, valued at that sale's unit
--     cost; nothing to return answers capped, qty 0 (11.5 item 6);
--   * LATE SALE: a movement dated at or before an approved count of that item (and area) is posted
--     with an equal and opposite STOCK_COUNT_ADJ dated at the count, key late:<key>, source_type
--     late_sale (11.5 item 2). A line counted from 20261019b on is judged by when it was counted;
--     an older approved line by when its count was approved. 20261018c's drainer asks the same
--     question under the same key, so the adjustment is booked exactly once.
-- Same 12 arguments, same answer (with capped, qty and late_adjustment_id added), idempotent per
-- (location, key). post_stock_movement, set_inventory_on_hand, post_stock_transfer_leg and the
-- central drainer (20261018c) call it.
create or replace function public._post_stock_movement(
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
  v_qty numeric;
  v_cost numeric;
  v_item_cost numeric;
  v_existing_id uuid;
  v_existing_area uuid;
  v_id uuid;
  v_onhand numeric;
  v_area uuid;
  v_area_onhand numeric;
  v_mid text;
  v_check text;
  v_sale record;
  v_returned numeric;
  v_cap numeric;
  v_capped boolean := false;
  v_late record;
  v_late_id uuid;
  v_late_key text;
begin
  -- FENCE 20261018a and LOCK 20261019b: the item must be this venue's own, and its row is locked
  -- before anything else is read, so every writer of one item queues here in the same order.
  select i.current_cost into v_item_cost from inventory_items i
   where i.id = p_inventory_item_id and i.location_id = p_location_id
   for no key update;
  if not found then
    raise exception 'post_stock_movement: stock item % is not at venue %', p_inventory_item_id, p_location_id
      using errcode = '22023';
  end if;
  if p_area_id is not null and not exists (select 1 from storage_areas a where a.id = p_area_id and a.location_id = p_location_id) then
    raise exception 'post_stock_movement: stock area % is not at venue %', p_area_id, p_location_id
      using errcode = '22023';
  end if;

  -- PRECISION 20261019b: one rounding, here.
  v_qty := round(coalesce(p_qty_base, 0), 4);

  if p_idempotency_key is not null then
    select id, area_id into v_existing_id, v_existing_area from stock_movements
      where location_id = p_location_id and idempotency_key = p_idempotency_key limit 1;
    if v_existing_id is not null then
      select on_hand into v_onhand from inventory_items where id = p_inventory_item_id and location_id = p_location_id;
      return jsonb_build_object('id', v_existing_id, 'on_hand', v_onhand, 'duplicate', true, 'area_id', v_existing_area);
    end if;
  end if;

  v_cost := coalesce(p_unit_cost, v_item_cost, 0);

  -- RETURN CAP 20261019b: what this check's sale took, less what has come back already (returns
  -- of this check item and the undo of a refused one, read by the check id).
  if p_movement_type = 'RETURN' and p_idempotency_key like 'return:%'
     and length(p_idempotency_key) > 7 + 37
     and right(p_idempotency_key, 37) = ':' || p_inventory_item_id::text then
    v_mid := substr(p_idempotency_key, 8, length(p_idempotency_key) - 7 - 37);
    v_check := v_mid;
    select m.id, m.qty_base, m.unit_cost into v_sale from stock_movements m
     where m.location_id = p_location_id and m.idempotency_key = 'sale:' || v_mid || ':' || p_inventory_item_id::text;
    if v_sale.id is null and position(':' in v_mid) > 0 then
      v_check := regexp_replace(v_mid, ':[^:]*$', '');
      select m.id, m.qty_base, m.unit_cost into v_sale from stock_movements m
       where m.location_id = p_location_id and m.idempotency_key = 'sale:' || v_check || ':' || p_inventory_item_id::text;
    end if;
    if v_sale.id is null then
      v_cap := 0;
    else
      select coalesce(sum(m.qty_base), 0) into v_returned from stock_movements m
       where m.location_id = p_location_id and m.source_id = v_check
         and m.inventory_item_id = p_inventory_item_id and m.movement_type = 'RETURN'
         and (left(m.idempotency_key, length('return:' || v_check || ':')) = 'return:' || v_check || ':'
              or left(m.idempotency_key, length('undo:return:' || v_check || ':')) = 'undo:return:' || v_check || ':');
      v_cap := greatest(0, -coalesce(v_sale.qty_base, 0) - v_returned);
      v_cost := coalesce(v_sale.unit_cost, v_cost);
    end if;
    if v_qty > v_cap then
      v_qty := round(v_cap, 4);
      v_capped := true;
    end if;
    if v_qty <= 0 then
      select on_hand into v_onhand from inventory_items where id = p_inventory_item_id and location_id = p_location_id;
      return jsonb_build_object('id', null, 'on_hand', v_onhand, 'duplicate', false, 'area_id', null,
        'capped', true, 'qty', 0);
    end if;
  end if;

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
       and ia.location_id = p_location_id and a.location_id = p_location_id
     limit 1;
  end if;

  insert into stock_movements(location_id, inventory_item_id, qty_base, unit_cost, value_delta,
      movement_type, source_type, source_id, occurred_at, posted_at, created_by, idempotency_key, notes, area_id)
    values (p_location_id, p_inventory_item_id, v_qty, v_cost, v_qty * coalesce(v_cost, 0),
      p_movement_type, p_source_type, p_source_id, coalesce(p_occurred_at, now()), now(),
      p_created_by, p_idempotency_key, p_notes, v_area)
    returning id into v_id;

  update inventory_items set on_hand = coalesce(on_hand, 0) + v_qty, updated_at = now()
    where id = p_inventory_item_id and location_id = p_location_id
    returning on_hand into v_onhand;

  if v_area is not null then
    insert into inventory_item_area_stock (location_id, inventory_item_id, area_id, on_hand, updated_at)
      values (p_location_id, p_inventory_item_id, v_area, v_qty, now())
      on conflict (inventory_item_id, area_id) do update
        set on_hand = inventory_item_area_stock.on_hand + excluded.on_hand, updated_at = now()
      returning on_hand into v_area_onhand;
  end if;

  -- LATE SALE 20261019b: dated at or before an approved count of this item (this area, or a line
  -- that counted the whole item): the count already saw the stock as it was, so an equal and
  -- opposite adjustment, dated at the count, keeps on hand = counted + later movements.
  if p_occurred_at is not null and p_occurred_at < now()
     and p_movement_type not in ('STOCK_COUNT_ADJ', 'OPENING_BALANCE') and v_qty <> 0 then
    select l.count_id, coalesce(l.counted_at, c.approved_at) as at into v_late
      from stock_count_lines l
      join stock_counts c on c.id = l.count_id and upper(c.status) = 'APPROVED'
     where l.location_id = p_location_id and l.inventory_item_id = p_inventory_item_id
       and l.counted_qty is not null
       and coalesce(l.counted_at, c.approved_at) >= p_occurred_at
       and (l.area_id is null or l.area_id is not distinct from v_area)
     order by coalesce(l.counted_at, c.approved_at) desc
     limit 1;
    if v_late.count_id is not null then
      v_late_key := 'late:' || coalesce(p_idempotency_key, v_id::text);
      insert into stock_movements(location_id, inventory_item_id, qty_base, unit_cost, value_delta,
          movement_type, source_type, source_id, occurred_at, posted_at, created_by, idempotency_key, notes, area_id, reversal_of)
        values (p_location_id, p_inventory_item_id, -v_qty, v_cost, -v_qty * coalesce(v_cost, 0),
          'STOCK_COUNT_ADJ', 'late_sale', coalesce(p_source_id, v_late.count_id::text), v_late.at, now(),
          p_created_by, v_late_key,
          case when p_movement_type = 'SALE_DEPLETION' then 'Late sale before count' else 'Late movement before count' end,
          v_area, v_id)
        on conflict do nothing
        returning id into v_late_id;
      if v_late_id is not null then
        update inventory_items set on_hand = coalesce(on_hand, 0) - v_qty, updated_at = now()
          where id = p_inventory_item_id and location_id = p_location_id
          returning on_hand into v_onhand;
        if v_area is not null then
          update inventory_item_area_stock set on_hand = on_hand - v_qty, updated_at = now()
            where inventory_item_id = p_inventory_item_id and area_id = v_area
            returning on_hand into v_area_onhand;
        end if;
      end if;
    end if;
  end if;

  return jsonb_build_object('id', v_id, 'on_hand', v_onhand, 'duplicate', false,
    'area_id', v_area, 'area_on_hand', v_area_onhand)
    || case when v_capped then jsonb_build_object('capped', true, 'qty', v_qty) else '{}'::jsonb end
    || case when v_late_id is not null then jsonb_build_object('late_adjustment_id', v_late_id) else '{}'::jsonb end;
end $$;
revoke all on function public._post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid) from public, anon, authenticated, service_role;

-- 20261018c's late sale guard, replaced: _post_stock_movement (above) now books the adjustment
-- itself, by area and from the time each line was counted, under the same key late:<key>. The
-- drainer's _stock_post still asks this function after a new post; it answers false so the
-- drainer never books a second, item wide adjustment (a cellar count must not cancel a bar sale,
-- and a sale made after a line was counted but before the count was approved must stand).
create or replace function public._stock_counted_after(p_loc uuid, p_item uuid, p_at timestamptz) returns boolean
language sql stable security definer set search_path = public as $$
  -- LATE SALE 20261019b: booked by _post_stock_movement; see 20261019b section 5.
  select false;
$$;
revoke all on function public._stock_counted_after(uuid, uuid, timestamptz) from public, anon, authenticated, service_role;

-- == 6. The area re home trigger takes the item lock first =========================================
-- 20261016's body with one line first: the same row lock _post_stock_movement takes, so a sale cannot
-- post into "no area" while this moves the item's old rows into its new area (11.5 item 4).
create or replace function public.inventory_item_areas_rehome()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.is_primary then
    -- LOCK 20261019b
    perform 1 from inventory_items where id = new.inventory_item_id for no key update;
    update stock_movements set area_id = new.area_id
     where location_id = new.location_id and inventory_item_id = new.inventory_item_id and area_id is null;
    insert into inventory_item_area_stock (location_id, inventory_item_id, area_id, on_hand, updated_at)
    select new.location_id, new.inventory_item_id, new.area_id, coalesce(sum(m.qty_base), 0), now()
      from stock_movements m
     where m.location_id = new.location_id and m.inventory_item_id = new.inventory_item_id and m.area_id = new.area_id
    on conflict (inventory_item_id, area_id) do update set on_hand = excluded.on_hand, updated_at = now();
  end if;
  return new;
end $$;

-- == 7. Count lines: when each was counted, and an approved count stays as it was approved ========
-- counted_at is the DATABASE's clock: stamped when a figure is entered or changed, cleared when it is
-- cleared, and an API caller cannot write it (on insert it is always stamped; on an update that does
-- not change the figure the old time is kept). The late sale rule and the approval read it, so a
-- moved counted_at could cancel live sales. Only the database itself (the SQL editor, a demo file)
-- may set it by hand. A line of an APPROVED count cannot be added, changed, moved or removed, except
-- by the service role or the SQL editor. approve_stock_count writes its lines before it marks the
-- count approved, so it is never stopped here.
create or replace function public.stock_count_lines_counted_at()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_sys boolean := public._stock_caller_is_system();
begin
  if not v_sys then
    if exists (select 1 from stock_counts c
                where upper(coalesce(c.status, '')) = 'APPROVED'
                  and (c.id = case when tg_op = 'DELETE' then old.count_id else new.count_id end
                       or (tg_op = 'UPDATE' and c.id = old.count_id))) then
      raise exception 'This count has been approved; its figures cannot change. Start a new count.'
        using errcode = '55000';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'INSERT' then
    if not v_sys or new.counted_at is null then
      new.counted_at := case when new.counted_qty is null then null else now() end;
    end if;
    return new;
  end if;
  if new.counted_qty is distinct from old.counted_qty then
    new.counted_at := case when new.counted_qty is null then null else now() end;
  elsif not v_sys then
    new.counted_at := old.counted_at;
  end if;
  return new;
end $$;
revoke all on function public.stock_count_lines_counted_at() from public, anon, authenticated;
do $trg_stock_count_lines_counted_at_trg$
begin
  -- only when missing (or an earlier draft that fired on the figure only): DROP/CREATE TRIGGER
  -- would lock the table on a second paste
  if not exists (select 1 from pg_trigger where tgrelid = 'public.stock_count_lines'::regclass
                  and tgname = 'stock_count_lines_counted_at_trg' and (tgtype & 8) = 8 and tgattr = ''::int2vector) then
    drop trigger if exists stock_count_lines_counted_at_trg on public.stock_count_lines;
    create trigger stock_count_lines_counted_at_trg
      before insert or update or delete on public.stock_count_lines
      for each row execute function public.stock_count_lines_counted_at();
  end if;
end
$trg_stock_count_lines_counted_at_trg$;

-- An approved count cannot be reopened, re figured or deleted through the API (a Back Office login
-- could set it back to DRAFT, change a figure and approve again: the sheet would then disagree with
-- the ledger). Its name and notes may still change. The service role and the SQL editor may.
create or replace function public.stock_counts_keep_approved()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if upper(coalesce(old.status, '')) <> 'APPROVED' or public._stock_caller_is_system() then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'This count has been approved and already adjusted your stock, so it cannot be deleted.'
      using errcode = '55000';
  end if;
  if new.status is distinct from old.status or new.approved_at is distinct from old.approved_at
     or new.variance_value is distinct from old.variance_value or new.opening_value is distinct from old.opening_value
     or new.location_id is distinct from old.location_id then
    raise exception 'This count has been approved; it cannot be reopened or changed. Start a new count.'
      using errcode = '55000';
  end if;
  return new;
end $$;
revoke all on function public.stock_counts_keep_approved() from public, anon, authenticated;
do $trg_stock_counts_keep_approved_trg$
begin
  if not exists (select 1 from pg_trigger where tgrelid = 'public.stock_counts'::regclass and tgname = 'stock_counts_keep_approved_trg') then
    create trigger stock_counts_keep_approved_trg
      before update or delete on public.stock_counts
      for each row execute function public.stock_counts_keep_approved();
  end if;
end
$trg_stock_counts_keep_approved_trg$;

-- == 8. Deletes keep ledgers =======================================================================
create or replace function public.inventory_items_keep_history()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from stock_movements m where m.location_id = old.location_id and m.inventory_item_id = old.id)
     or exists (select 1 from item_cost_history h where h.inventory_item_id = old.id) then
    raise exception 'This stock item has stock history, so it cannot be deleted. Archive it instead: its history is kept.'
      using errcode = '23503';
  end if;
  return old;
end $$;
revoke all on function public.inventory_items_keep_history() from public, anon, authenticated;
do $trg_inventory_items_keep_history_trg$
begin
  -- only when missing: DROP/CREATE TRIGGER would lock the table on a second paste
  if not exists (select 1 from pg_trigger where tgrelid = 'public.inventory_items'::regclass and tgname = 'inventory_items_keep_history_trg') then
    create trigger inventory_items_keep_history_trg
      before delete on public.inventory_items
      for each row execute function public.inventory_items_keep_history();
  end if;
end
$trg_inventory_items_keep_history_trg$;

create or replace function public.item_packaging_formats_in_use()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from recipe_lines rl where rl.location_id = old.location_id and rl.unit = '@' || old.id::text) then
    raise exception 'This pack is used in a recipe, so it cannot be deleted. Change those recipe lines to another unit first.'
      using errcode = '23503';
  end if;
  return old;
end $$;
revoke all on function public.item_packaging_formats_in_use() from public, anon, authenticated;
do $trg_item_packaging_formats_in_use_trg$
begin
  -- only when missing: DROP/CREATE TRIGGER would lock the table on a second paste
  if not exists (select 1 from pg_trigger where tgrelid = 'public.item_packaging_formats'::regclass and tgname = 'item_packaging_formats_in_use_trg') then
    create trigger item_packaging_formats_in_use_trg
      before delete on public.item_packaging_formats
      for each row execute function public.item_packaging_formats_in_use();
  end if;
end
$trg_item_packaging_formats_in_use_trg$;

-- == 9. Receiving in one database step =============================================================
-- _stock_receive_lines: the receipt itself, owner only (stock_receive and stock_post_invoice call it
-- after their own checks). p_lines: [{ key, item_id, qty_base, unit_cost (net, per base unit; 0 or
-- null = not priced), supplier_product_id, pack_price, pack_label }]. Every item is locked in id
-- order first; each line posts PURCHASE_RECEIPT (idempotent on its key) and, when priced and new,
-- moves the cost: LAST_COST takes the price; otherwise the moving average, except that stock at or
-- below zero, or an unknown cost, takes the delivery price (never an average). An unpriced line moves
-- the stock in at the item's known cost and leaves the cost alone. Cost history keeps the pack.
create or replace function public._stock_receive_lines(p_location_id uuid, p_source_type text, p_source_id text,
  p_lines jsonb, p_area_id uuid default null, p_notes text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_line jsonb;
  v_item record;
  v_res jsonb;
  v_qty numeric;
  v_cost numeric;
  v_new numeric;
  v_before numeric;
  v_sp uuid;
  v_doc uuid;
  v_out jsonb := '[]'::jsonb;
  v_posted integer := 0;
  v_dupes integer := 0;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'stock_receive: lines must be a list' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_lines) e
              where nullif(e ->> 'key', '') is null
                 or not exists (select 1 from inventory_items i
                                 where i.id = nullif(e ->> 'item_id', '')::uuid and i.location_id = p_location_id)) then
    raise exception 'stock_receive: a line has no key or names a stock item that is not at this venue' using errcode = '22023';
  end if;
  v_doc := case when p_source_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_source_id::uuid end;

  -- LOCK ORDER 20261019b: every item of this receipt, in id order, before the first post.
  perform 1 from inventory_items
   where location_id = p_location_id
     and id in (select (e ->> 'item_id')::uuid from jsonb_array_elements(p_lines) e)
   order by id
   for no key update;

  for v_line in
    select e from jsonb_array_elements(p_lines) e order by (e ->> 'item_id')::uuid, (e ->> 'key')
  loop
    v_qty := round(coalesce(nullif(v_line ->> 'qty_base', '')::numeric, 0), 4);
    if v_qty <= 0 then continue; end if;
    select id, on_hand, current_cost, cost_method into v_item from inventory_items
     where id = (v_line ->> 'item_id')::uuid and location_id = p_location_id;
    v_cost := nullif(v_line ->> 'unit_cost', '')::numeric;
    if v_cost is not null and v_cost <= 0 then v_cost := null; end if;
    v_before := coalesce(v_item.on_hand, 0);
    v_res := public._post_stock_movement(p_location_id, v_item.id, v_qty, 'PURCHASE_RECEIPT',
      coalesce(v_cost, v_item.current_cost, 0), p_source_type, p_source_id, v_line ->> 'key',
      null, null, p_notes, p_area_id);
    if coalesce((v_res ->> 'duplicate')::boolean, false) then
      v_dupes := v_dupes + 1;
      v_out := v_out || jsonb_build_array(jsonb_build_object('key', v_line ->> 'key', 'item_id', v_item.id, 'duplicate', true));
      continue;
    end if;
    v_posted := v_posted + 1;
    v_new := null;
    if v_cost is not null then
      if coalesce(v_item.cost_method, 'MOVING_AVG') = 'LAST_COST' or v_before <= 0
         or v_item.current_cost is null or v_item.current_cost <= 0 then
        v_new := v_cost;
      else
        v_new := (v_before * v_item.current_cost + v_qty * v_cost) / (v_before + v_qty);
      end if;
      v_new := round(v_new, 8);
      select sp.id into v_sp from supplier_products sp
       where sp.id = nullif(v_line ->> 'supplier_product_id', '')::uuid and sp.location_id = p_location_id;
      update item_cost_history set effective_to = now()
       where location_id = p_location_id and inventory_item_id = v_item.id and effective_to is null;
      insert into item_cost_history (location_id, inventory_item_id, supplier_product_id, pack_price, pack_label,
          base_unit_cost, moving_avg_cost, source, source_doc_id, effective_from)
        values (p_location_id, v_item.id, v_sp, round(nullif(v_line ->> 'pack_price', '')::numeric, 4),
          nullif(left(coalesce(v_line ->> 'pack_label', ''), 120), ''), v_new, v_new,
          case when p_source_type = 'purchase_order' then 'PO_RECEIPT' else 'INVOICE' end, v_doc, now());
      update inventory_items set current_cost = v_new, updated_at = now()
       where id = v_item.id and location_id = p_location_id;
    end if;
    v_out := v_out || jsonb_build_array(jsonb_build_object('key', v_line ->> 'key', 'item_id', v_item.id,
      'duplicate', false, 'on_hand', v_res -> 'on_hand', 'cost', v_new));
  end loop;
  return jsonb_build_object('ok', true, 'posted', v_posted, 'duplicates', v_dupes, 'lines', v_out);
end $$;
revoke all on function public._stock_receive_lines(uuid, text, text, jsonb, uuid, text) from public, anon, authenticated, service_role;

-- The door for a receive (a purchase order, the Ops tablet's goods in, the Manager app). A receive
-- sets the item's cost, so it is Back Office work (stock_office_reaches: a Back Office login, the
-- owner, the service role, the SQL editor) or the venue's own active Ops tablet. A till or a kiosk
-- is refused (row level security gives cost writes to the Back Office only).
create or replace function public.stock_receive(p_location_id uuid, p_source_type text, p_source_id text,
  p_lines jsonb, p_area_id uuid default null, p_notes text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
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
end $$;
revoke all on function public.stock_receive(uuid, text, text, jsonb, uuid, text) from public, anon;
grant execute on function public.stock_receive(uuid, text, text, jsonb, uuid, text) to authenticated, service_role;

-- An invoice in one step: the header, its lines and its receipts, or nothing.
--   p_invoice:  { client_id (the screen's own id for this invoice: a retry answers duplicate),
--                 supplier_id, invoice_number, invoice_date, ocr_confidence, subtotal, tax, total,
--                 raw_json, image_path, po_id }
--   p_lines:    [{ matched_item_id, description, qty, unit, unit_price, line_total, purchase_tax_rate_id,
--                  line_tax, flags, supplier_product_id }]   (stored in this order)
--   p_receipts: [{ line_index, item_id, qty_base, unit_cost, supplier_product_id, pack_price, pack_label }]
-- Refused in words: a second posted invoice with the same number from the same supplier here.
-- Linked to an order already received: kept as paperwork, no stock (never counted twice).
create or replace function public.stock_post_invoice(p_location_id uuid, p_invoice jsonb, p_lines jsonb,
  p_receipts jsonb default '[]'::jsonb, p_area_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
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
    return jsonb_build_object('ok', true, 'invoice_id', v_inv, 'stock', false, 'code', 'po_received',
      'words', 'Kept as paperwork for an order received already: no stock was counted twice.');
  end if;

  select coalesce(jsonb_agg(r.v || jsonb_build_object('key', 'inv:' || v_inv::text || ':' || (r.v ->> 'item_id') || ':' || coalesce(r.v ->> 'line_index', '0'))), '[]'::jsonb)
    into v_rec
    from jsonb_array_elements(coalesce(p_receipts, '[]'::jsonb)) r(v);
  v_res := public._stock_receive_lines(p_location_id, 'supplier_invoice', v_inv::text, v_rec, p_area_id, null);
  return jsonb_build_object('ok', true, 'invoice_id', v_inv, 'stock', true, 'posted', v_res -> 'posted', 'lines', v_res -> 'lines');
end $$;
revoke all on function public.stock_post_invoice(uuid, jsonb, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.stock_post_invoice(uuid, jsonb, jsonb, jsonb, uuid) to authenticated, service_role;

-- == 10. Count approval in one call ================================================================
-- approve_stock_count: the whole approval, or nothing.
--   * each counted line is worked out against the stock held AT THE MOMENT IT WAS COUNTED (the area's
--     holding for a line with an area, else the item's on hand, less every movement dated after that
--     moment), posted dated at that moment, with expected and variance stored from that figure;
--   * the first count of an item at this venue posts OPENING_BALANCE, costed (the item's cost, else
--     p_costs ->> item id, else the line's cost) and never 0: lines that would post with no cost stop
--     the approval and come back as needs_cost, with nothing written;
--   * every item is locked in id order first; the key per line is the one the screen always used
--     (count:<count>:<item>[:<area>]), so a retry, or a half approval made by an older screen, never
--     posts a line twice;
--   * a line counted BEFORE a count of the same item (same area, or the whole item) that is approved
--     already is superseded: it posts nothing (delta 0, 'superseded' in its line), so the newest count
--     stays the truth when an older sheet is approved late;
--   * p_preview true: the plan only (lines, opening, needs_cost, values), nothing locked or written.
create or replace function public.approve_stock_count(p_count_id uuid, p_approved_by_name text default null,
  p_approval_note text default null, p_costs jsonb default null, p_preview boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_c record;
  v_l record;
  v_now timestamptz := now();
  v_delta numeric;
  v_expected numeric;
  v_cost numeric;
  v_type text;
  v_key text;
  v_res jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_needs jsonb := '[]'::jsonb;
  v_counted integer := 0;
  v_uncounted integer := 0;
  v_total integer := 0;
  v_posted integer := 0;
  v_opening integer := 0;
  v_var numeric := 0;
  v_open_val numeric := 0;
  v_given numeric;
  v_loc uuid;
  v_superseded integer := 0;
begin
  -- Who is asking comes first: nothing is locked (and nothing says whether the count exists) for a
  -- caller who cannot approve at its venue.
  select c.location_id into v_loc from stock_counts c where c.id = p_count_id;
  if v_loc is null or not public.stock_office_reaches(v_loc) then
    raise exception 'approve_stock_count: that count was not found, or this login cannot approve counts at its venue' using errcode = '42501';
  end if;
  if p_preview then
    select * into v_c from stock_counts where id = p_count_id;
  else
    select * into v_c from stock_counts where id = p_count_id for no key update;
  end if;
  if not found or v_c.location_id is distinct from v_loc then
    raise exception 'approve_stock_count: that count was not found, or this login cannot approve counts at its venue' using errcode = '42501';
  end if;
  if v_c.status = 'APPROVED' then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', 'APPROVED');
  end if;
  if v_c.status = 'CANCELLED' then
    return jsonb_build_object('ok', false, 'error', 'This count was cancelled, so it cannot be approved');
  end if;
  select count(*) filter (where l.counted_qty is not null), count(*) filter (where l.counted_qty is null)
    into v_counted, v_uncounted
    from stock_count_lines l where l.count_id = p_count_id and l.location_id = v_c.location_id;
  if v_counted = 0 then
    return jsonb_build_object('ok', false, 'error', 'Nothing has been counted on this sheet yet');
  end if;

  if not p_preview then
    -- LOCK ORDER 20261019b: every counted item, in id order, before anything is read for the plan.
    perform 1 from inventory_items
     where location_id = v_c.location_id
       and id in (select l.inventory_item_id from stock_count_lines l
                   where l.count_id = p_count_id and l.location_id = v_c.location_id and l.counted_qty is not null)
     order by id
     for no key update;
  end if;

  for v_l in
    with l as (
      select l.id, l.inventory_item_id, l.area_id, l.counted_qty, l.counted_at,
             coalesce(l.counted_at, v_now) as at, l.unit_cost as line_cost
        from stock_count_lines l
       where l.count_id = p_count_id and l.location_id = v_c.location_id and l.counted_qty is not null
    )
    select l.*, i.name, i.current_cost,
           (case when l.area_id is null then coalesce(i.on_hand, 0)
                 else coalesce((select s.on_hand from inventory_item_area_stock s
                                 where s.inventory_item_id = l.inventory_item_id and s.area_id = l.area_id), 0) end)
           - coalesce((select sum(m.qty_base) from stock_movements m
                        where m.location_id = v_c.location_id and m.inventory_item_id = l.inventory_item_id
                          and m.occurred_at > l.at
                          and (l.area_id is null or m.area_id = l.area_id)), 0) as expected,
           (not exists (select 1 from stock_movements m
                         where m.location_id = v_c.location_id and m.inventory_item_id = l.inventory_item_id
                           and m.movement_type in ('OPENING_BALANCE', 'STOCK_COUNT_ADJ'))
            and not exists (select 1 from stock_count_lines o join stock_counts oc on oc.id = o.count_id
                             where o.location_id = v_c.location_id and o.inventory_item_id = l.inventory_item_id
                               and o.count_id <> p_count_id and o.counted_qty is not null and oc.status = 'APPROVED')) as opening,
           -- SUPERSEDED 20261019b: a count of this item (this area, or the whole item) approved
           -- already and counted LATER than this line is the truth now; this older line posts nothing.
           exists (select 1 from stock_count_lines o join stock_counts oc on oc.id = o.count_id and upper(oc.status) = 'APPROVED'
                    where o.location_id = v_c.location_id and o.inventory_item_id = l.inventory_item_id
                      and o.count_id <> p_count_id and o.counted_qty is not null
                      and coalesce(o.counted_at, oc.approved_at) > l.at
                      and (o.area_id is null or l.area_id is null or o.area_id = l.area_id)) as superseded
      from l
      join inventory_items i on i.id = l.inventory_item_id and i.location_id = v_c.location_id
     order by l.inventory_item_id, l.area_id nulls first, l.id
  loop
    v_expected := round(v_l.expected, 4);
    v_delta := round(v_l.counted_qty - v_expected, 4);
    if v_l.superseded then
      v_delta := 0;
      v_superseded := v_superseded + 1;
    end if;
    v_cost := null;
    if v_l.opening then
      v_given := null;
      if p_costs is not null and jsonb_typeof(p_costs) = 'object' then
        v_given := nullif(p_costs ->> v_l.inventory_item_id::text, '')::numeric;
      end if;
      v_cost := coalesce(nullif(v_l.current_cost, 0), nullif(v_given, 0), nullif(v_l.line_cost, 0));
      if v_cost is not null and v_cost < 0 then v_cost := null; end if;
      if v_cost is null and v_delta <> 0 then
        v_needs := v_needs || jsonb_build_array(jsonb_build_object('item_id', v_l.inventory_item_id, 'name', v_l.name));
      end if;
      v_opening := v_opening + 1;
      v_open_val := v_open_val + v_delta * coalesce(v_cost, 0);
    else
      v_var := v_var + v_delta * coalesce(v_l.current_cost, 0);
    end if;
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'line_id', v_l.id, 'item_id', v_l.inventory_item_id, 'area_id', v_l.area_id, 'counted', v_l.counted_qty,
      'expected', v_expected, 'delta', v_delta, 'opening', v_l.opening, 'cost', v_cost,
      'counted_at', v_l.counted_at, 'at', v_l.at, 'superseded', v_l.superseded));
  end loop;

  if jsonb_array_length(v_needs) > 0 then
    return jsonb_build_object('ok', false, 'code', 'needs_cost', 'needs_cost', v_needs,
      'error', 'Enter a cost for the items counted for the first time that have no price yet.',
      'opening', v_opening, 'lines', case when p_preview then v_lines else '[]'::jsonb end);
  end if;
  if p_preview then
    return jsonb_build_object('ok', true, 'preview', true, 'lines', v_lines, 'opening', v_opening,
      'variance_value', round(v_var, 2), 'opening_value', round(v_open_val, 2), 'uncounted', v_uncounted,
      'counted', v_counted, 'superseded', v_superseded);
  end if;

  for v_l in
    select (x ->> 'line_id')::uuid as line_id, (x ->> 'item_id')::uuid as item_id, nullif(x ->> 'area_id', '')::uuid as area_id,
           (x ->> 'expected')::numeric as expected, (x ->> 'delta')::numeric as delta, (x ->> 'opening')::boolean as opening,
           nullif(x ->> 'cost', '')::numeric as cost, (x ->> 'at')::timestamptz as at
      from jsonb_array_elements(v_lines) x
  loop
    if v_l.delta <> 0 then
      v_total := v_total + 1;
      v_type := case when v_l.opening then 'OPENING_BALANCE' else 'STOCK_COUNT_ADJ' end;
      v_key := case when v_l.area_id is null then 'count:' || p_count_id::text || ':' || v_l.item_id::text
                    else 'count:' || p_count_id::text || ':' || v_l.item_id::text || ':' || v_l.area_id::text end;
      v_res := public._post_stock_movement(v_c.location_id, v_l.item_id, v_l.delta, v_type,
        case when v_l.opening then v_l.cost else null end, 'stock_count', p_count_id::text, v_key,
        v_l.at, null, case when v_l.opening then 'Opening count' else 'Stock count' end, v_l.area_id);
      if not coalesce((v_res ->> 'duplicate')::boolean, false) then v_posted := v_posted + 1; end if;
    end if;
    -- An item with no cost takes the cost of its opening count (once, never over a known cost).
    if v_l.opening and v_l.cost is not null then
      update inventory_items set current_cost = round(v_l.cost, 8), updated_at = now()
       where id = v_l.item_id and location_id = v_c.location_id and (current_cost is null or current_cost <= 0);
      if found then
        update item_cost_history set effective_to = now()
         where location_id = v_c.location_id and inventory_item_id = v_l.item_id and effective_to is null;
        insert into item_cost_history (location_id, inventory_item_id, base_unit_cost, moving_avg_cost, source, source_doc_id, effective_from)
          values (v_c.location_id, v_l.item_id, round(v_l.cost, 8), round(v_l.cost, 8), 'MANUAL', p_count_id, now());
      end if;
    end if;
    update stock_count_lines
       set expected_qty = v_l.expected, variance_qty = v_l.delta, is_opening = v_l.opening,
           unit_cost = coalesce(v_l.cost, unit_cost)
     where id = v_l.line_id;
  end loop;

  update stock_counts
     set status = 'APPROVED', approved_at = now(), updated_at = now(),
         approved_by_name = coalesce(nullif(btrim(coalesce(p_approved_by_name, '')), ''), approved_by_name),
         approval_note = coalesce(nullif(btrim(coalesce(p_approval_note, '')), ''), approval_note),
         variance_value = round(v_var, 2), opening_value = round(v_open_val, 2)
   where id = p_count_id;

  return jsonb_build_object('ok', true, 'posted', v_posted, 'total', v_total, 'opening', v_opening,
    'variance_value', round(v_var, 2), 'opening_value', round(v_open_val, 2), 'uncounted', v_uncounted,
    'superseded', v_superseded);
end $$;
revoke all on function public.approve_stock_count(uuid, text, text, jsonb, boolean) from public, anon;
grant execute on function public.approve_stock_count(uuid, text, text, jsonb, boolean) to authenticated, service_role;

-- == 11. Waste in one call, never refused ==========================================================
--   p_event: { id (the client's, for a safe retry), kind 'item' | 'menu', inventory_item_id, menu_item_id,
--              item_name, qty, unit, qty_base, reason, note, sale_value, source, mods, order_type,
--              preview: true answers the lines and their cost and writes nothing }
--   p_lines: [{ item_id, qty_base }]   the stock it takes off, as the screen worked it out; or NULL
--            for a menu product: the database explodes that ONE product (and its options) through its
--            recipe with stock_explode, the same rule as central depletion (11.5 item 8: the till no
--            longer reads the whole recipe book to log one waste). Wastage % never inflates it.
-- The waste row and every WASTE movement, or nothing. cost_value is worked out here at each item's
-- cost (null when nothing comes off stock, never a made up 0). A menu product that takes nothing off
-- stock is recorded all the same, tagged no_recipe; the answer's tag says why (no_recipe: no recipe
-- linked; nothing_to_deduct: a recipe that takes nothing off).
create or replace function public.stock_record_waste(p_location_id uuid, p_event jsonb, p_lines jsonb default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
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

  insert into waste_events (id, location_id, inventory_item_id, item_name, qty, unit, qty_base, reason, note,
      cost_value, sale_value, source, occurred_at, menu_item_id, no_recipe)
    values (v_id, p_location_id, v_item, nullif(p_event ->> 'item_name', ''),
      coalesce(nullif(p_event ->> 'qty', '')::numeric, 1), coalesce(nullif(p_event ->> 'unit', ''), 'item'),
      nullif(p_event ->> 'qty_base', '')::numeric, v_reason, nullif(p_event ->> 'note', ''),
      round(v_cost, 2), round(nullif(p_event ->> 'sale_value', '')::numeric, 2),
      coalesce(nullif(p_event ->> 'source', ''), 'backoffice'), now(), v_menu, v_no_recipe);

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
end $$;
revoke all on function public.stock_record_waste(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.stock_record_waste(uuid, jsonb, jsonb) to authenticated, service_role;

-- == 12. Transfers ==================================================================================
-- 20261018c's text (20261018a's, its three line loops in item id order) with:
--   * LOCK ORDER: every item the leg touches (both venues on a receive) locked in id order first;
--   * UNITS: a receive converts the sender's base unit to the receiving item's, through stock_units
--     or one unit bridge of either item; a line whose units cannot convert stops the receive in words
--     before anything posts; the received quantity is capped at what was sent and rounded down in
--     the receiver's unit (nothing is created); a remainder under half a 4th decimal step of the
--     coarser unit is rounding and books no Short on transfer;
--   * SHORT ON TRANSFER: for each line, what did not arrive (all of it for a dropped line) is booked
--     at the SENDER: a reversal of that much of its transfer out, then WASTE of the same, reason
--     "Short on transfer", plus a waste row, valued at the sender's cost. The sender's on hand does
--     not move again; the loss shows in its waste;
--   * the receiver's cost moves like a delivery: below zero, or an unknown cost, takes the transfer
--     cost (the cost per receiving unit: sender cost divided by the unit factor).
create or replace function public.post_stock_transfer_leg(p_transfer_id uuid, p_leg text, p_by_name text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
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
begin
  if p_leg not in ('out', 'in', 'both', 'cancel') then
    raise exception 'post_stock_transfer_leg: leg must be out, in, both or cancel (got %)', coalesce(p_leg, 'null');
  end if;

  select * into v_t from stock_transfers where id = p_transfer_id for no key update;
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
          else
            v_new_avg := (v_before * v_item.current_cost + v_qty * (v_cost / v_factor)) / (v_before + v_qty);
          end if;
          v_new_avg := round(v_new_avg, 8);
          update item_cost_history set effective_to = now()
            where location_id = v_t.to_location_id and inventory_item_id = v_l.to_inventory_item_id and effective_to is null;
          insert into item_cost_history (location_id, inventory_item_id, base_unit_cost, moving_avg_cost, source, source_doc_id, effective_from)
            values (v_t.to_location_id, v_l.to_inventory_item_id, v_new_avg, v_new_avg, 'TRANSFER', v_t.id, now());
          update inventory_items set current_cost = v_new_avg, updated_at = now()
            where id = v_l.to_inventory_item_id and location_id = v_t.to_location_id;
        end if;
      end if;
      update stock_transfer_lines set qty_received_base = v_qty, to_base_unit = v_to_unit,
             to_unit_cost = round(v_cost / v_factor, 8)
       where id = v_l.id;
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
  return jsonb_build_object('ok', true, 'duplicate', false, 'status', 'RECEIVED', 'lines', v_lines, 'short_lines', v_short_lines);
end $$;
revoke all on function public.post_stock_transfer_leg(uuid,text,text) from public, anon;
grant execute on function public.post_stock_transfer_leg(uuid,text,text) to authenticated, service_role;

-- One company only, in the table rule too (a transfer head or line naming a venue of another company
-- is refused at insert, not only when it is posted).
do $transfer_pol$
begin
  -- only when the rule is not there yet (DROP/CREATE POLICY locks the table on a second paste)
  if not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = 'stock_transfers'
                  and p.policyname = 'stock_transfers_insert' and p.with_check like '%stock_same_company%') then
    drop policy if exists stock_transfers_insert on public.stock_transfers;
    create policy stock_transfers_insert on public.stock_transfers
      for insert
      with check ((location_id)::text in (select public.user_accessible_locations())
                  and (to_location_id is null or public.stock_same_company(location_id, to_location_id)));
  end if;
  if not exists (select 1 from pg_policies p where p.schemaname = 'public' and p.tablename = 'stock_transfer_lines'
                  and p.policyname = 'stock_transfer_lines_insert' and p.with_check like '%stock_same_company%') then
    drop policy if exists stock_transfer_lines_insert on public.stock_transfer_lines;
    create policy stock_transfer_lines_insert on public.stock_transfer_lines
      for insert
      with check ((location_id)::text in (select public.user_accessible_locations())
                  and (to_location_id is null or public.stock_same_company(location_id, to_location_id)));
  end if;
end
$transfer_pol$;

-- == 13. The order pad's usage reads, in pages of 1,000 items ======================================
-- The Order pad, Purchase orders and Batches read usage per item. The live stock_usage_by_weekday
-- answers one row per item and weekday (up to 35,000 rows at 5,000 items) and the API cuts every
-- answer at 1,000 rows, with no order: items and days went missing and counted as 0. These two
-- answer ONE row per stock item of the venue, at most 1,000 items per call, in item id order; the
-- screen asks again with p_after = the last id until a call answers fewer than 1,000 rows. Each call
-- adds up only its own items' movements (stock_mv_item_idx). The weekday is the venue's own day:
-- its zone (p_tz, else the venue's timezone) and business day start (p_day_start 'HH:MM', else
-- midnight); an unknown zone falls back to Europe/London, never an error. by_dow holds 7 values,
-- Sunday first, average base units used per such day over p_weeks weeks.
-- The live stock_usage_by_weekday(uuid, integer) and stock_usage_rates(uuid, integer) are left as
-- they are for screens not yet updated. Invoker rights: row level security decides what is read.
create or replace function public.stock_usage_weekday_page(p_location_id uuid, p_weeks integer default 8,
  p_after uuid default null, p_tz text default null, p_day_start text default null)
returns table(inventory_item_id uuid, by_dow numeric[])
language sql
stable
set search_path to 'public'
as $function$
  with w as (
    select greatest(coalesce(p_weeks, 8), 1)::numeric as weeks
  ), z as (
    select coalesce(
             (select n.name from pg_timezone_names n
               where n.name = coalesce(nullif(btrim(p_tz), ''), (select l.timezone from public.locations l where l.id = p_location_id))
               limit 1),
             'Europe/London') as tz,
           case when coalesce(p_day_start, '') ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then p_day_start::interval
                else interval '0' end as ds
  ), page as (
    select i.id
      from public.inventory_items i
     where i.location_id = p_location_id and (p_after is null or i.id > p_after)
     order by i.id
     limit 1000
  ), m as (
    select sm.inventory_item_id,
           extract(dow from ((sm.occurred_at at time zone z.tz) - z.ds))::int as dow,
           sum(-sm.qty_base) as total_base
      from page p
      join public.stock_movements sm on sm.location_id = p_location_id and sm.inventory_item_id = p.id
     cross join w cross join z
     where sm.movement_type in ('SALE_DEPLETION', 'PRODUCTION_CONSUME')
       and sm.qty_base < 0
       and sm.occurred_at >= now() - make_interval(weeks => w.weeks::integer)
     group by 1, 2
  )
  select p.id,
         array[coalesce(sum(m.total_base) filter (where m.dow = 0), 0) / (select weeks from w),
               coalesce(sum(m.total_base) filter (where m.dow = 1), 0) / (select weeks from w),
               coalesce(sum(m.total_base) filter (where m.dow = 2), 0) / (select weeks from w),
               coalesce(sum(m.total_base) filter (where m.dow = 3), 0) / (select weeks from w),
               coalesce(sum(m.total_base) filter (where m.dow = 4), 0) / (select weeks from w),
               coalesce(sum(m.total_base) filter (where m.dow = 5), 0) / (select weeks from w),
               coalesce(sum(m.total_base) filter (where m.dow = 6), 0) / (select weeks from w)]
    from page p
    left join m on m.inventory_item_id = p.id
   group by p.id
   order by p.id;
$function$;
revoke all on function public.stock_usage_weekday_page(uuid, integer, uuid, text, text) from public, anon;
grant execute on function public.stock_usage_weekday_page(uuid, integer, uuid, text, text) to authenticated, service_role;

create or replace function public.stock_usage_rates_page(p_location_id uuid, p_days integer default 28,
  p_after uuid default null)
returns table(inventory_item_id uuid, avg_daily_base numeric)
language sql
stable
set search_path to 'public'
as $function$
  with d as (
    select greatest(coalesce(p_days, 28), 1) as days
  ), page as (
    select i.id
      from public.inventory_items i
     where i.location_id = p_location_id and (p_after is null or i.id > p_after)
     order by i.id
     limit 1000
  )
  select p.id,
         coalesce((select sum(-sm.qty_base) from public.stock_movements sm, d
                    where sm.location_id = p_location_id and sm.inventory_item_id = p.id
                      and sm.movement_type in ('SALE_DEPLETION', 'PRODUCTION_CONSUME')
                      and sm.qty_base < 0
                      and sm.occurred_at >= now() - make_interval(days => d.days)), 0)
           / (select days from d)::numeric
    from page p
   order by p.id;
$function$;
revoke all on function public.stock_usage_rates_page(uuid, integer, uuid) from public, anon;
grant execute on function public.stock_usage_rates_page(uuid, integer, uuid) to authenticated, service_role;

-- == 14. The Multi site menu's read only recipe warning ============================================
-- Per site of the group menu: how many products on sale there have NO recipe there but DO have one
-- at another site, and the site with the most of those recipes. "12 products have a recipe at Provo
-- but none at Location 2". At most one row per site (well under the 1,000 row cap at 50 sites).
create or replace function public.msm_stock_recipe_gaps(p_menu uuid)
returns table (location_id text, site_name text, missing integer, from_location_id text, from_site_name text, from_count integer)
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_org uuid;
begin
  select m.org_id into v_org from msm_menus m where m.id = p_menu;
  if v_org is null or not public.msm_can_view(v_org) then
    raise exception 'msm_stock_recipe_gaps: this login cannot see that menu' using errcode = '42501';
  end if;
  return query
  with ps as (
    select s.product_id, s.location_id as loc,
           exists (select 1 from menu_item_recipes r
                    where r.location_id = (case when s.location_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then s.location_id::uuid end)
                      and r.menu_item_id = s.venue_item_id) as has_recipe
      from msm_product_sites s
      join msm_products p on p.id = s.product_id
     where p.menu_id = p_menu and not p.archived and s.active
  ), lacking as (
    select b.product_id, b.loc from ps b
     where not b.has_recipe
       and exists (select 1 from ps a where a.product_id = b.product_id and a.has_recipe and a.loc <> b.loc)
  ), missing as (
    select k.loc, count(*)::integer as n from lacking k group by k.loc
  ), pairs as (
    select k.loc as lacking_loc, a.loc as having_loc, count(*)::integer as n
      from lacking k join ps a on a.product_id = k.product_id and a.has_recipe and a.loc <> k.loc
     group by k.loc, a.loc
  ), best as (
    select distinct on (pr.lacking_loc) pr.lacking_loc, pr.having_loc, pr.n
      from pairs pr order by pr.lacking_loc, pr.n desc, pr.having_loc
  )
  select mi.loc, coalesce(l1.name, 'A site'), mi.n, bs.having_loc, coalesce(l2.name, 'another site'), bs.n
    from missing mi
    left join best bs on bs.lacking_loc = mi.loc
    left join locations l1 on l1.id::text = mi.loc
    left join locations l2 on l2.id::text = bs.having_loc
   order by mi.n desc, mi.loc
   limit 200;
end
$fn$;
revoke all on function public.msm_stock_recipe_gaps(uuid) from public, anon;
grant execute on function public.msm_stock_recipe_gaps(uuid) to authenticated, service_role;


notify pgrst, 'reload schema';

-- VISIBLE CHECK (the SQL editor shows this last result). Expected on Ops (19 Oct 2026):
--   phase0_functions 11, core_locked 1, core_open_to_api 0, triggers 4, new_columns 12, cost_8dp 1,
--   on_hand_16_4 1, site_indexes 10, settings_rows 0 (no venue has chosen yet: price list),
--   transfer_insert_same_company 2, old_usage_reads_kept 2 (the live stock_usage_by_weekday and
--   stock_usage_rates stay for screens not yet updated), and stock_sums: one entry per venue that
--   holds stock, the same figures as the BEFORE query in supabase/tests/stock_phase0/README.md
--   (nothing moved; cost may show more zeros after the point, 168.30576 as 168.30576000: the same
--   number in the wider column).
--   So: 11|1|0|4|12|1|1|10|0|2|2|{...}
select
  (select count(*) from pg_proc p where p.oid in (
     to_regprocedure('public.stock_receive(uuid,text,text,jsonb,uuid,text)'),
     to_regprocedure('public._stock_receive_lines(uuid,text,text,jsonb,uuid,text)'),
     to_regprocedure('public.stock_post_invoice(uuid,jsonb,jsonb,jsonb,uuid)'),
     to_regprocedure('public.approve_stock_count(uuid,text,text,jsonb,boolean)'),
     to_regprocedure('public.stock_record_waste(uuid,jsonb,jsonb)'),
     to_regprocedure('public.stock_convert_qty(numeric,text,text,uuid[])'),
     to_regprocedure('public.stock_office_reaches(uuid)'),
     to_regprocedure('public.msm_stock_recipe_gaps(uuid)'),
     to_regprocedure('public.stock_usage_weekday_page(uuid,integer,uuid,text,text)'),
     to_regprocedure('public.stock_usage_rates_page(uuid,integer,uuid)'),
     to_regprocedure('public._stock_caller_is_system()'))) as phase0_functions,
  (select count(*) from pg_proc p where p.oid = to_regprocedure('public._post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)')
     and p.prosrc like '%LOCK 20261019b%' and p.prosrc like '%RETURN CAP 20261019b%' and p.prosrc like '%LATE SALE 20261019b%') as core_locked,
  (select count(*) from pg_proc p, unnest(array['anon', 'authenticated', 'service_role']) r(name)
    where p.oid in (to_regprocedure('public._post_stock_movement(uuid,uuid,numeric,text,numeric,text,text,text,timestamptz,uuid,text,uuid)'),
                    to_regprocedure('public._stock_receive_lines(uuid,text,text,jsonb,uuid,text)'),
                    to_regprocedure('public._stock_caller_is_system()'),
                    to_regprocedure('public._stock_counted_after(uuid,uuid,timestamptz)'))
      and has_function_privilege(r.name, p.oid, 'execute')) as core_open_to_api,
  (select count(*) from pg_trigger t where not t.tgisinternal and t.tgname in
     ('stock_count_lines_counted_at_trg', 'stock_counts_keep_approved_trg', 'inventory_items_keep_history_trg',
      'item_packaging_formats_in_use_trg')) as triggers,
  (select count(*) from information_schema.columns c where c.table_schema = 'public' and (c.table_name, c.column_name) in (
     ('stock_count_lines', 'counted_at'), ('stock_count_lines', 'is_opening'), ('stock_counts', 'opening_value'),
     ('waste_events', 'menu_item_id'), ('waste_events', 'no_recipe'), ('item_cost_history', 'pack_label'),
     ('supplier_invoice_lines', 'supplier_product_id'), ('stock_transfer_lines', 'to_base_unit'),
     ('stock_transfer_lines', 'short_qty_base'), ('stock_transfer_lines', 'to_unit_cost'),
     ('stock_site_settings', 'cost_rule'), ('stock_site_settings', 'location_id'))) as new_columns,
  (select count(*) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'inventory_items'
     and c.column_name = 'current_cost' and c.numeric_precision = 18 and c.numeric_scale = 8) as cost_8dp,
  (select count(*) from information_schema.columns c where c.table_schema = 'public' and c.table_name = 'inventory_items'
     and c.column_name = 'on_hand' and c.numeric_precision = 16 and c.numeric_scale = 4) as on_hand_16_4,
  (select count(*) from pg_indexes i where i.schemaname = 'public' and i.indexname in (
     'recipe_lines_loc_recipe_idx', 'recipe_lines_loc_pack_unit_idx', 'item_pack_fmt_loc_item_idx', 'inv_item_conv_loc_item_idx',
     'supplier_products_loc_item_idx', 'po_lines_loc_po_idx', 'item_cost_hist_loc_item_idx', 'stock_count_lines_loc_item_idx',
     'waste_events_loc_menu_item_idx', 'supplier_invoices_posted_number_uniq')) as site_indexes,
  (select count(*) from public.stock_site_settings) as settings_rows,
  (select count(*) from pg_policies p where p.schemaname = 'public' and p.policyname in ('stock_transfers_insert', 'stock_transfer_lines_insert')
     and p.with_check like '%stock_same_company%') as transfer_insert_same_company,
  (select count(*) from pg_proc p where p.oid in (to_regprocedure('public.stock_usage_by_weekday(uuid,integer)'),
                                                 to_regprocedure('public.stock_usage_rates(uuid,integer)'))) as old_usage_reads_kept,
  (select coalesce(jsonb_object_agg(s.location_id, jsonb_build_object('items', s.items, 'on_hand', s.on_hand, 'cost', s.cost,
            'movements', s.movements, 'qty', s.qty, 'value', s.value)), '{}'::jsonb)
     from (select i.location_id::text as location_id, count(*) as items, sum(i.on_hand) as on_hand, sum(i.current_cost) as cost,
                  (select count(*) from public.stock_movements m where m.location_id = i.location_id) as movements,
                  (select sum(m.qty_base) from public.stock_movements m where m.location_id = i.location_id) as qty,
                  (select sum(m.value_delta) from public.stock_movements m where m.location_id = i.location_id) as value
             from public.inventory_items i group by i.location_id) s) as stock_sums;
