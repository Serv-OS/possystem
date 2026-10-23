-- 20261027a_OPS_stock_native_3_ROLLBACK.sql
-- Takes multi site stock Drop 3 (20261027a_OPS_stock_native_3.sql) back out.
--
-- ############################################################################
-- #  OPS DB ONLY   project ref  tbetcegmszzotrwdtqhi                          #
-- #  Peter runs this by hand. One transaction: any error and nothing changes. #
-- #  Run after UK close. Lock wait 3 s (it gives up, nothing changes).        #
-- ############################################################################
--
-- WHAT IT DOES (explicit names only)
--   Stops the two cron jobs (stock-notify, po-cutoff-run) and deletes their two vault keys; puts the 10
--   Drop 2 bodies back exactly as they were (the 'd3:' rows saved by 20261027a); puts the two recipe read
--   rules back to the live text; drops the three triggers, every function 20261027a made, the 25 new
--   tables and the 41 new columns; puts the transfer status CHECK back to its five live values; deletes the
--   'd3:' rows.
--
-- WHAT IT KEEPS, AND SAYS SO
--   Every purchase order, transfer, count, waste event, invoice and forecast amount stays (the new columns
--   go with their values: delivery fee, approvals, reasons, lots, match status). Waiting approvals and send
--   jobs are counted in the check row and are NOT sent. Kitchen only recipes: each recipe's method is copied
--   back from the secrets table and Kitchen only is switched off; the recipe stays only at the kitchen until
--   head office ticks sites. The invoice inbox bucket and its files are kept (they are evidence); only its
--   two policies go.
--
-- IT REFUSES (and changes nothing) when a transfer is REQUESTED or DISPUTED: cancel or resolve those first.

do $guard$
begin
  if to_regclass('public.user_locations') is null or to_regclass('public.billing_state') is not null then
    raise exception 'This file is for the Ops database only. Nothing was changed.';
  end if;
  if to_regclass('public.stock_po_approvals') is null
     or (select count(*) from public.stock_native_backup b where left(b.name, 3) = 'd3:') <> 10 then
    raise exception 'Drop 3 is not here (20261027a). Nothing was changed.';
  end if;
  if exists (select 1 from public.stock_transfers t where t.status in ('REQUESTED', 'DISPUTED')) then
    raise exception 'Some transfers are REQUESTED or DISPUTED. Cancel or resolve them first. Nothing was changed.';
  end if;
end
$guard$;

set local lock_timeout = '3s';
set local statement_timeout = '300s';

create temp table _stock_native3rb_snap (location_id uuid not null, metric text not null, value numeric, txt text, primary key (location_id, metric)) on commit drop;
create temp table _stock_native3rb_now (location_id uuid not null, metric text not null, value numeric, txt text, primary key (location_id, metric)) on commit drop;
create temp table _stock_native3rb_kept (metric text primary key, value numeric) on commit drop;

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
  insert into _stock_native3rb_snap (location_id, metric, value)
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
  insert into _stock_native3rb_snap (location_id, metric, value, txt)
  values ('00000000-0000-0000-0000-000000000000', 'md5:user_profiles', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.user_profiles t)),
         ('00000000-0000-0000-0000-000000000000', 'md5:user_locations', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.user_locations t)),
         ('00000000-0000-0000-0000-000000000000', 'md5:menu_items', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.menu_items t));
  insert into _stock_native3rb_kept (metric, value)
  values ('approvals_waiting', (select count(*) from public.stock_po_approvals a where a.status in ('waiting', 'sent_back'))),
         ('send_jobs_waiting', (select count(*) from public.stock_po_send_jobs j where j.status = 'waiting')),
         ('kitchen_only_recipes', (select count(*) from public.stock_co_recipe_secrets s));
end
$snap$;

-- 1. the cron jobs and their keys
do $rb_cron$
declare
  j record;
begin
  for j in select c.jobid from cron.job c where c.jobname in ('stock-notify', 'po-cutoff-run') loop
    perform cron.unschedule(j.jobid);
  end loop;
end
$rb_cron$;
delete from vault.secrets s where s.name in ('stock_notify_cron_key', 'po_cutoff_cron_key');

-- 2. kitchen only recipes: the method goes back on the recipe, Kitchen only off
update public.stock_co_recipes r
   set method = coalesce(s.method, r.method), restricted = false, row_version = r.row_version + 1, updated_at = now()
  from public.stock_co_recipe_secrets s
 where s.recipe_id = r.id;

-- 3. the 10 Drop 2 bodies, exactly as saved
do $rb_bodies$
declare
  r record;
begin
  for r in select b.name, b.body from public.stock_native_backup b where left(b.name, 3) = 'd3:' order by b.name loop
    execute r.body;
  end loop;
end
$rb_bodies$;

-- 4. the two recipe read rules, back to the live text
alter policy stock_co_recipes_read on public.stock_co_recipes using (org_id::text in (select public.stock_reach_orgs()));
alter policy stock_co_recipe_lines_read on public.stock_co_recipe_lines using (org_id::text in (select public.stock_reach_orgs()));

-- 5. the three triggers (their functions go with the rest below)
drop trigger if exists purchase_orders_approval_guard on public.purchase_orders;
drop trigger if exists purchase_orders_send_rule on public.purchase_orders;
drop trigger if exists stock_counts_approval_fence on public.stock_counts;
drop trigger if exists supplier_invoices_lock_guard on public.supplier_invoices;
drop trigger if exists supplier_invoices_lock_guard on public.supplier_invoice_lines;
drop trigger if exists stock_co_d3_org_guard on public.stock_po_approvals;
drop trigger if exists stock_co_d3_org_guard on public.stock_standing_orders;
drop trigger if exists stock_co_d3_org_guard on public.stock_standing_runs;
drop trigger if exists stock_co_d3_org_guard on public.stock_order_lists;
drop trigger if exists stock_co_d3_org_guard on public.stock_budgets;
drop trigger if exists stock_co_d3_org_guard on public.stock_credit_requests;
drop trigger if exists stock_co_d3_org_guard on public.stock_credit_notes;
drop trigger if exists stock_co_d3_org_guard on public.stock_template_shelf_order;
drop trigger if exists stock_co_d3_org_guard on public.stock_transfer_lists;
drop trigger if exists stock_co_d3_org_guard on public.stock_forecast_hours;
drop trigger if exists stock_co_d3_org_guard on public.stock_co_site_forecast_source;
drop trigger if exists stock_co_d3_org_guard on public.stock_kitchen_plan_ticks;
drop trigger if exists stock_co_d3_org_guard on public.supplier_invoice_site_splits;

-- 6. the inbox bucket's two policies (the bucket and its files stay)
drop policy if exists stock_invoice_inbox_files_read on storage.objects;
drop policy if exists stock_invoice_inbox_files_add on storage.objects;
-- the upload check the policy called (20261029b); the policy is gone first, so nothing calls it
drop function if exists public.stock_invoice_inbox_upload_ok(text);
drop policy if exists stock_co_recipe_secrets_read on public.stock_co_recipe_secrets;

-- 7. every function 20261027a made, by exact signature
drop function if exists public.stock_notify_targets(bigint);
drop function if exists public.stock_notify_due();
drop function if exists public.stock_notify_cron_ok(text);
drop function if exists public.po_cutoff_cron_ok(text);
drop function if exists public.stock_po_cutoff_run();
drop function if exists public.stock_co__due_delivery(uuid, smallint[], timestamptz);
drop function if exists public.stock_recharge_record(uuid, date, uuid, uuid, numeric, text, text, text, text);
drop function if exists public.stock_recharge_statement(uuid, date);
drop function if exists public.stock_save_recipe_secret(uuid, text, integer);
drop function if exists public.stock_set_recipe_restricted(uuid, boolean, uuid, integer);
drop function if exists public.stock_kitchen_pick(uuid, jsonb, jsonb);
drop function if exists public.stock_kitchen_untick(uuid, jsonb);
drop function if exists public.stock_kitchen_tick(uuid, uuid, numeric, date, jsonb);
drop function if exists public.stock_co__recipe_yield_base(uuid, uuid);
drop function if exists public.stock_co__line_base(uuid, uuid);
drop function if exists public.stock_kitchen_ingredients(uuid, date);
drop function if exists public.stock_kitchen_plan(uuid, date, jsonb);
drop function if exists public.stock_co__pack_base(numeric, numeric, text, uuid);
drop function if exists public.stock_kitchen_orders_in(uuid, date, jsonb);
drop function if exists public.stock_set_site_kind(uuid, text);
drop function if exists public.stock_save_transfer_list(jsonb, integer);
drop function if exists public.stock_transfer_matches(uuid);
drop function if exists public.stock_dispute_transfer(uuid, text, jsonb);
drop function if exists public.stock_fulfil_request(uuid, jsonb, jsonb);
drop function if exists public.stock_request_transfer(uuid, uuid, jsonb, text, text, jsonb);
drop function if exists public.stock_fresh_closedown_list(uuid, date, jsonb);
drop function if exists public.stock_waste_reasons(uuid);
drop function if exists public.stock_unlock_period(uuid, text);
drop function if exists public.stock_lock_period(uuid, date, date);
drop function if exists public.stock_second_approve_count(uuid, text);
drop function if exists public.stock_save_shelf_order(uuid, uuid, uuid[]);
drop function if exists public.stock_template_for_site(uuid, uuid);
drop function if exists public.stock_save_count_template(jsonb, jsonb, jsonb, integer);
drop function if exists public.stock_save_count_plan(jsonb, integer);
drop function if exists public.stock_count_due(uuid, uuid[], date);
drop function if exists public.stock_save_forecast_source(uuid, uuid, numeric, integer);
drop function if exists public.stock_save_forecast(uuid, jsonb, jsonb, jsonb);
drop function if exists public.stock_forecast_week(uuid, date);
drop function if exists public.stock_sales_history(uuid, integer);
drop function if exists public.stock_save_budget(jsonb, integer);
drop function if exists public.stock_budget_board(uuid, uuid[], date);
drop function if exists public.stock_budget_status(uuid, date);
drop function if exists public.stock_make_company_price(uuid, uuid, integer, text);
drop function if exists public.stock_price_changes_page(uuid, uuid[], jsonb, jsonb, integer);
drop function if exists public.stock_credits_page(uuid, uuid[], text, jsonb, integer);
drop function if exists public.stock_save_credit_note(jsonb);
drop function if exists public.stock_credit_set_status(uuid, text, integer, text);
drop function if exists public.stock_save_credit_request(jsonb, integer);
drop function if exists public.stock_inbox_receive(text, text, text, jsonb);
drop function if exists public.stock_inbox_add(uuid, text, text, text);
drop function if exists public.stock_inbox_address(uuid);
drop function if exists public.stock_inbox_ignore(uuid);
drop function if exists public.stock_inbox_place(uuid, uuid, uuid);
drop function if exists public.stock_invoice_inbox_page(uuid, text, jsonb, integer);
drop function if exists public.stock_invoice_split(uuid, jsonb);
drop function if exists public.stock_invoices_approve(uuid[], text);
drop function if exists public.stock_invoice_match(uuid);
drop function if exists public.stock_missing_invoices(uuid, uuid[], jsonb, integer);
drop function if exists public.stock_invoices_page(uuid, uuid[], jsonb, jsonb, integer);
drop function if exists public.stock_deliveries_board(uuid, uuid[], jsonb, integer);
drop function if exists public.stock_orders_page(uuid, uuid[], text, jsonb, jsonb, integer);
drop function if exists public.stock_due_to_order(uuid, uuid[], jsonb, integer);
drop function if exists public.stock_save_order_list(jsonb, integer);
drop function if exists public.stock_save_delivery_exception(jsonb, integer, text);
drop function if exists public.stock_edit_standing_run(uuid, date, jsonb, boolean, jsonb);
drop function if exists public.stock_save_standing_order(jsonb, integer, text);
drop function if exists public.stock_create_orders_many(uuid, jsonb, text);
drop function if exists public.stock_po_decide(uuid, text, text, text);
drop function if exists public.stock_po_submit(uuid, text, jsonb);
drop function if exists public.stock_order_pad_context(uuid, jsonb);
drop function if exists public.stock_co__budget_of(uuid, date);
drop function if exists public.stock_co__d3_scope(uuid, uuid[]);
drop function if exists public.stock_co__count_due_rows(uuid, uuid[], date);
drop function if exists public.stock_co__po_submit_core(uuid, uuid, text, boolean);
drop function if exists public.stock_co__standing_over(uuid, uuid, jsonb);
drop function if exists public.stock_co__count_approval_fence();
drop function if exists public.stock_co__is_raiser(uuid, uuid, uuid);
drop function if exists public.stock_co__po_send_rule();
drop function if exists public.stock_co__po_send_block(uuid);
drop function if exists public.stock_co__fee_for(uuid, numeric);
drop function if exists public.stock_co__inbox_place_auto(uuid);
drop function if exists public.stock_co__match_invoice(uuid);
drop function if exists public.stock_co__set_price_here(uuid, uuid, numeric, text, uuid);
drop function if exists public.stock_co__kitchen_price(uuid);
drop function if exists public.stock_co__next_delivery(uuid, timestamptz);
drop function if exists public.stock_co__forecast_amount(uuid, date);
drop function if exists public.stock_co__notify(uuid, uuid, text, text, jsonb);
drop function if exists public.stock_co__locked_until(uuid);
drop function if exists public.stock_co__hidden_recipes();
drop function if exists public.stock_co__secret_ok(uuid, uuid);
drop function if exists public.stock_co__invoice_lock_guard();
drop function if exists public.stock_co__po_approval_guard();
drop function if exists public.stock_co__d3_org_guard();
drop function if exists public.stock_co__d3_who(uuid, text, text, uuid[], jsonb);
drop function if exists public.stock_co__tz(uuid);
drop function if exists public.stock_co__money(text, numeric);
drop function if exists public.stock_co__multi(uuid);
drop function if exists public.stock_co__is_service();
drop function if exists public.stock_co__vday(uuid, timestamptz);

-- 8. the transfer status CHECK back to its five live values
alter table public.stock_transfers drop constraint stock_transfers_status_chk;
alter table public.stock_transfers add constraint stock_transfers_status_chk
  check (status in ('DRAFT', 'SENT', 'RECEIVED', 'CANCELLED', 'DONE'));

-- 9. the 41 columns (their indexes go with them), then the 25 tables
drop index if exists public.stock_transfers_one_per_order;
drop index if exists public.stock_co_settings_inbox_token;
drop index if exists public.purchase_orders_standing;
alter table public.wf_sales_forecast drop column if exists reason;
alter table public.wf_sales_forecast drop column if exists reason_note;
alter table public.wf_sales_forecast drop column if exists edited_by;
alter table public.wf_sales_forecast drop column if exists edited_by_name;
alter table public.wf_sales_forecast drop column if exists edited_at;
alter table public.purchase_orders drop column if exists delivery_fee;
alter table public.purchase_orders drop column if exists standing_order_id;
alter table public.purchase_orders drop column if exists sent_unapproved_at;
alter table public.po_lines drop column if exists qty_draft;
alter table public.po_lines drop column if exists ordered_unit_price;
alter table public.supplier_invoices drop column if exists match_status;
alter table public.supplier_invoices drop column if exists match_detail;
alter table public.supplier_invoices drop column if exists approved_at;
alter table public.supplier_invoices drop column if exists approved_by_name;
alter table public.supplier_invoices drop column if exists locked_at;
alter table public.supplier_invoices drop column if exists inbox_id;
alter table public.stock_counts drop column if exists plan_id;
alter table public.stock_counts drop column if exists template_id;
alter table public.stock_counts drop column if exists second_approval_needed_at;
alter table public.stock_counts drop column if exists first_approved_by;
alter table public.stock_counts drop column if exists first_approved_by_name;
alter table public.stock_counts drop column if exists first_approved_by_staff_id;
alter table public.stock_counts drop column if exists second_approved_by;
alter table public.stock_counts drop column if exists second_approved_by_name;
alter table public.stock_counts drop column if exists second_approved_at;
alter table public.waste_events drop column if exists approved_by_staff_id;
alter table public.waste_events drop column if exists approved_by_staff_name;
alter table public.stock_transfers drop column if exists kind;
alter table public.stock_transfers drop column if exists reason;
alter table public.stock_transfers drop column if exists requested_by_name;
alter table public.stock_transfers drop column if exists requested_at;
alter table public.stock_transfers drop column if exists disputed_at;
alter table public.stock_transfers drop column if exists dispute_note;
alter table public.stock_transfers drop column if exists resolved_at;
alter table public.stock_transfers drop column if exists resolved_by_name;
alter table public.stock_transfers drop column if exists purchase_order_id;
alter table public.stock_transfer_lines drop column if exists lot_code;
alter table public.stock_transfer_lines drop column if exists use_by_at;
alter table public.stock_transfer_lines drop column if exists requested_qty_base;
alter table public.stock_co_suppliers drop column if exists fee_waived_over_min;
alter table public.stock_co_settings drop column if exists inbox_token;
drop table if exists public.stock_notify_sent;
drop table if exists public.stock_recharge_posts;
drop table if exists public.stock_kitchen_plan_ticks;
drop table if exists public.stock_co_recipe_secrets;
drop table if exists public.stock_co_site_forecast_source;
drop table if exists public.stock_forecast_hours;
drop table if exists public.stock_transfer_lists;
drop table if exists public.stock_template_shelf_order;
drop table if exists public.stock_count_template_sites;
drop table if exists public.stock_count_template_lines;
drop table if exists public.stock_count_plans;
drop table if exists public.stock_count_templates;
drop table if exists public.stock_credit_notes;
drop table if exists public.stock_credit_request_lines;
drop table if exists public.stock_credit_requests;
drop table if exists public.supplier_invoice_site_splits;
drop table if exists public.stock_invoice_inbox;
drop table if exists public.stock_budgets;
drop table if exists public.stock_order_lists;
drop table if exists public.stock_delivery_exceptions;
drop table if exists public.stock_standing_runs;
drop table if exists public.stock_standing_order_lines;
drop table if exists public.stock_po_send_jobs;
drop table if exists public.stock_po_approvals;
drop table if exists public.stock_standing_orders;

-- 10. the saved bodies
delete from public.stock_native_backup b where left(b.name, 3) = 'd3:';

do $now$
declare
  v_orgs uuid[];
begin
  select coalesce(array_agg(distinct i.org_id), '{}'::uuid[]) into v_orgs from public.stock_co_items i;
  insert into _stock_native3rb_now (location_id, metric, value)
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
  insert into _stock_native3rb_now (location_id, metric, value, txt)
  values ('00000000-0000-0000-0000-000000000000', 'md5:user_profiles', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.user_profiles t)),
         ('00000000-0000-0000-0000-000000000000', 'md5:user_locations', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.user_locations t)),
         ('00000000-0000-0000-0000-000000000000', 'md5:menu_items', 0,
          (select md5(coalesce(string_agg(t::text, '|' order by t.id), '')) from public.menu_items t));
end
$now$;

do $rb_compare$
declare
  v_diff text;
begin
  select string_agg(coalesce(a.location_id, b.location_id)::text || ' ' || coalesce(a.metric, b.metric), ', ' order by 1) into v_diff
    from _stock_native3rb_snap a
    full join _stock_native3rb_now b on b.location_id = a.location_id and b.metric = a.metric
   where a.metric is null or b.metric is null
      or a.value is distinct from b.value or a.txt is distinct from b.txt;
  if v_diff is not null then
    raise exception 'A site row, a login, a menu row or an order changed: %. Nothing was changed. Send this line to Claude.', left(v_diff, 600);
  end if;
end
$rb_compare$;

notify pgrst, 'reload schema';

-- THE CHECK ROW. Paste it back.
select (select count(*) from (values
      ('public.stock_post_invoice(uuid,jsonb,jsonb,jsonb,uuid)', '13a87312ccaecb25f0e5184f070565ed'),
      ('public.stock_receive(uuid,text,text,jsonb,uuid,text)', '25cf780578d16f9c42e2e4cb3509911e'),
      ('public.stock_record_waste(uuid,jsonb,jsonb)', '7adec1618754c96e9f3d9655fcf98070'),
      ('public.stock_approve_count_pin(uuid,text,text,text,jsonb,boolean)', 'ffccd1e09fcfac62cff36e8d463f6519'),
      ('public.post_stock_transfer_leg(uuid,text,text)', 'd95f253953c5f22d537ee5e4b6925d49'),
      ('public.stock_needs_attention(uuid,uuid[])', '3c37e882291e5ba76048fa31304046b7'),
      ('public.stock_save_recipe(jsonb,jsonb,integer,text)', '8b625c94827917726945d7d4b1dffd8a'),
      ('public.stock_co__recipe_on_at(uuid,uuid,text,text,text)', '00d9e6a85b03889c53dd96d716b33a37'),
      ('public.stock_recipe_detail(uuid)', 'd7e0003ba1ae8dbc3b76e08ad13a8da2'),
      ('public.stock_recipe_card(uuid,text,uuid)', '275faa45aff17d97f12de8e7934252bf')
          ) as e(sig, want)
          join pg_proc p on p.oid = to_regprocedure(e.sig)
         where md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = e.want)::integer as bodies_restored,
       (select count(*) from (values ('stock_notify_sent'), ('stock_recharge_posts'), ('stock_kitchen_plan_ticks'), ('stock_co_recipe_secrets'), ('stock_co_site_forecast_source'), ('stock_forecast_hours'), ('stock_transfer_lists'), ('stock_template_shelf_order'), ('stock_count_template_sites'), ('stock_count_template_lines'), ('stock_count_plans'), ('stock_count_templates'), ('stock_credit_notes'), ('stock_credit_request_lines'), ('stock_credit_requests'), ('supplier_invoice_site_splits'), ('stock_invoice_inbox'), ('stock_budgets'), ('stock_order_lists'), ('stock_delivery_exceptions'), ('stock_standing_runs'), ('stock_standing_order_lines'), ('stock_po_send_jobs'), ('stock_po_approvals'), ('stock_standing_orders')
          ) t(n) where to_regclass('public.' || t.n) is null)::integer as tables_dropped,
       (select count(*) from cron.job c where c.jobname in ('stock-notify', 'po-cutoff-run'))::integer as cron_jobs,
       (select k.value from _stock_native3rb_kept k where k.metric = 'approvals_waiting')::integer as approvals_not_sent,
       (select k.value from _stock_native3rb_kept k where k.metric = 'send_jobs_waiting')::integer as send_jobs_not_sent,
       (select k.value from _stock_native3rb_kept k where k.metric = 'kitchen_only_recipes')::integer as kitchen_only_recipes_opened,
       0 as site_rows_changed,
       false as orders_changed;
