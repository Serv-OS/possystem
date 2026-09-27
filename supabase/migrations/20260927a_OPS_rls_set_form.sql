-- 20260927a (Ops): every venue row check runs ONCE per statement, not once per row.
-- Project tbetcegmszzotrwdtqhi. Drafted 26 Sep 2026 from the LIVE policy text (pg_policies), not
-- from older migration files. Peter runs this; Claude cannot run DDL on production.
--
-- WHY
--   Peter: "this is exactly what I was worried about with the database and speed ... lots more users"
--   - A policy like pos_can_access(location_id) passes the ROW's column to a SECURITY DEFINER
--     function, so Postgres calls it for every row it looks at.
--   - Cost: about 0.6 to 0.8 ms per row, paid by EVERY caller (owner, manager, till, ops device,
--     super admin, anon). Postgres never runs such a check once for the whole query.
--   - The authenticated role has statement_timeout 8 s (anon 3 s). At about 0.9 ms a row for an
--     owner, roughly 8,000 rows checked and the read fails.
--   - customers was fixed this way on 26 Sep (20260926b): 7.5 s became 16 ms.
--
-- MEASURED 26 SEP (EXPLAIN ANALYZE as neil, a Coffee Boy owner)
--   - Per row checked, benchmark over 8,047 rows:
--       pos_can_access 0.60 to 0.71 ms, ops_can_write 0.56 to 0.81 ms,
--       waitlist_can_write 0.63 to 0.74 ms, unwrapped is_super_admin() about 0.019 ms.
--   - staff_auth_events 707 rows 541 ms; closed_checks 650 rows 469 ms;
--     shifts 526 rows 368 ms; cash_movements 221 rows 162 ms.
--   - closed_checks with the set form: 484 ms became 4.9 ms, same rows for all 10 test logins.
--   - Writes pay it too: the menu_items write check is 2.0 to 2.3 s over 3,267 rows.
--   - Coffee Boy Leeds went live on 26 Sep: about 175 closed checks a day.
--     A whole closed_checks read would hit the wall in about 66 days.
--   - Nearest wall: loadSalesHistory (src/staff/wfData.js) pages 8 weeks with OFFSET. Skipped
--     rows still pay the check, so it times out at about 208 checks a day.
--
-- WHAT CHANGES (WHO may see or write WHAT stays IDENTICAL; only how it is evaluated changes)
--   - 4 new helpers return the caller's venue SET once per statement (hashed lookup per row):
--       accessible_location_ids()           text: exactly what pos_can_access allows
--       accessible_location_uuids()         uuid: the same set, so uuid columns stay uuid
--       ops_writable_location_uuids()       uuid: exactly what ops_can_write allows
--       waitlist_writable_location_uuids()  uuid: exactly what waitlist_can_write allows
--   - 104 policies on 79 tables are dropped and recreated, rewritten like this:
--       pos_can_access(col)          ->  (col in (select public.accessible_location_ids()))    text col
--       pos_can_access(col)          ->  (col in (select public.accessible_location_uuids()))  uuid col
--       pos_can_access((col)::text)  ->  (col in (select public.accessible_location_uuids()))  uuid col
--       ops_can_write(col)           ->  (col in (select public.ops_writable_location_uuids()))
--       waitlist_can_write(col)      ->  (col in (select public.waitlist_writable_location_uuids()))
--       is_super_admin()             ->  (select public.is_super_admin())
--       auth.uid()                   ->  (select auth.uid())
--   - Every other character of each policy is the live text. Same name, command, roles,
--     permissive or restrictive, and WITH CHECK (rewritten the same way).
--   - A null location is still never visible and never writable.
--
-- NOT TOUCHED
--   - customers (done in 20260926b) and every second_step_fence policy.
--   - storage.objects policies (different owner; not part of this change).
--   - item_cost_history, stock_count_lines, supplier_invoice_lines: their check compares the row
--     with itself, so ANY login with one venue can read and write EVERY venue's rows (proven:
--     mike sees all 23 item_cost_history rows, none at his venues). Fixing that CHANGES access,
--     so it needs its own migration. Not fixed here.
--   - booking_payments "paired device read" has no bound/status check on devices. Only its
--     auth.uid() is wrapped here; access is unchanged.
--   - auth.role() and is_anon_session() policies: about 0.002 ms per row, no wall in sight.
--   - locations_insert: already wrapped; its per-row part only runs on insert.
--
-- INDEXES
--   - Every table over 500 rows already has a btree index that starts with location_id
--     (menu_items, menu_translations, staff_auth_events, closed_checks, shifts). None added.
--
-- SAFETY
--   - One transaction. The GUARD first checks all 104 policies still have the exact 26 Sep text.
--     If anything drifted it stops and NOTHING is applied.
--   - lock_timeout 3 s: if a busy table cannot be locked it stops and NOTHING is applied
--     (just run it again). While it runs, tills wait at most a few seconds. Run it outside service.
--   - The POST CHECK stops (and undoes everything) if any rewritten policy is missing or still per row.
--   - Rollback: 20260927a_rollback.sql, drafted with this file. It restores every original policy
--     text exactly and drops the 4 helpers.
--
-- VERIFY AFTER RUNNING (paste each block into the SQL editor)
--   1) Nothing slow left. Expect 0 rows (customers and second_step_fence never matched this):
--        select tablename, policyname from pg_policies
--         where schemaname = 'public'
--           and concat_ws(' ', qual, with_check) ~ '(pos_can_access|ops_can_write|waitlist_can_write)\(';
--   2) Speed as neil. Expect a few ms for the count (it was about 470 ms):
--        begin;
--        set local role authenticated;
--        select set_config('request.jwt.claims', '{"sub":"45e27b2b-9bfe-4d35-9a5a-a3d5f6789da6","role":"authenticated","aal":"aal2"}', true);
--        explain analyze select count(*) from public.closed_checks;
--        rollback;
--   3) Same rows as the old rule. Expect old_rule = new_rule:
--        begin;
--        select set_config('request.jwt.claims', '{"sub":"45e27b2b-9bfe-4d35-9a5a-a3d5f6789da6","role":"authenticated","aal":"aal2"}', true);
--        select count(*) filter (where pos_can_access(location_id)) as old_rule,
--               count(*) filter (where location_id in (select public.accessible_location_ids())) as new_rule
--          from public.closed_checks;
--        rollback;

begin;

set local lock_timeout = '3s';
set local statement_timeout = '120s';
set local search_path = public;

create temp table _rls_20260927a (tbl text, pol text, sig text) on commit drop;
insert into _rls_20260927a (tbl, pol, sig) values
  ('bar_tabs', 'bar_tabs_tenant', 'dbffab369acbf288a4bb88fb1f2d99ec'),
  ('booking_payments', 'host stand read', 'ab7ec1baf0968080b3fe12dcb6a29646'),
  ('booking_payments', 'paired device read', 'b9328c1833183616dae8cc914b41a101'),
  ('cash_drawers', 'cash_drawers_tenant', '3644a0b93764f398c08a420050df26da'),
  ('cash_movements', 'cash_movements_tenant', '3644a0b93764f398c08a420050df26da'),
  ('challenge_21_checks', 'challenge_21_checks_tenant', 'dbffab369acbf288a4bb88fb1f2d99ec'),
  ('closed_checks', 'closed_checks_delete', '73d35828429c43dbe7ac527c45c9eb41'),
  ('closed_checks', 'closed_checks_read', '08856e11c7e98dbc6dd25cf09701085b'),
  ('closed_checks', 'closed_checks_update', '937986ef5f70857ecc8fae0cdc510adb'),
  ('customer_locations', 'customer_locations_venue', 'eecdbf1774accef9728b637df1dfac52'),
  ('customer_orders', 'customer_orders_venue', 'eecdbf1774accef9728b637df1dfac52'),
  ('deliveries', 'deliveries_rls', '0a65b0468655534ffd5c2e4234ab58a0'),
  ('device_heartbeats', 'device_heartbeats_tenant', 'dbffab369acbf288a4bb88fb1f2d99ec'),
  ('drawer_sessions', 'drawer_sessions_tenant', '3644a0b93764f398c08a420050df26da'),
  ('floor_table_tombstones', 'floor_table_tombstones_insert', '8f1650d1ac870540a994b6542c10da6f'),
  ('floor_table_tombstones', 'floor_table_tombstones_read', '4bbaa5684d27fd2cd6df93b6fda4dbfd'),
  ('floor_table_tombstones', 'floor_table_tombstones_update', '5324ecabee68b62a10a463f19cf15e7c'),
  ('floor_tables', 'floor_tables_delete_tenant', '860170a5e8b0fd9332f045f5f9d7cb51'),
  ('floor_tables', 'floor_tables_insert_tenant', '8f1650d1ac870540a994b6542c10da6f'),
  ('floor_tables', 'floor_tables_update_tenant', '5324ecabee68b62a10a463f19cf15e7c'),
  ('inventory_item_conversions', 'inventory_item_conversions_sel', '08856e11c7e98dbc6dd25cf09701085b'),
  ('inventory_items', 'inventory_items_sel', '08856e11c7e98dbc6dd25cf09701085b'),
  ('item_packaging_formats', 'item_packaging_formats_sel', '08856e11c7e98dbc6dd25cf09701085b'),
  ('location_features', 'location_features_tenant', 'dbffab369acbf288a4bb88fb1f2d99ec'),
  ('loyalty_transactions', 'loyalty_transactions_tenant', 'dbffab369acbf288a4bb88fb1f2d99ec'),
  ('maintenance_requests', 'maintenance_requests_rls', '0a65b0468655534ffd5c2e4234ab58a0'),
  ('menu_board_screens', 'mb_screens_insert', '96c07802ac0860ef7c19499892307ae4'),
  ('menu_board_screens', 'mb_screens_select', '0731fd0922314eb2312726a2811d2178'),
  ('menu_item_recipes', 'menu_item_recipes_sel', '08856e11c7e98dbc6dd25cf09701085b'),
  ('menu_items', 'menu_items_write_tenant', 'dbffab369acbf288a4bb88fb1f2d99ec'),
  ('menu_translations', 'menu_translations_write_tenant', 'dbffab369acbf288a4bb88fb1f2d99ec'),
  ('modifier_groups', 'modifier_groups_delete', '860170a5e8b0fd9332f045f5f9d7cb51'),
  ('modifier_groups', 'modifier_groups_update', '5324ecabee68b62a10a463f19cf15e7c'),
  ('modifier_groups', 'modifier_groups_write', '8f1650d1ac870540a994b6542c10da6f'),
  ('ops_alerts', 'ops_alerts_rls', '3673b8041085a4d1200ad15fc357cfa1'),
  ('ops_audit', 'ops_audit_ins', '6181e60995d755809439a32e23411080'),
  ('ops_audit', 'ops_audit_sel', '5c568a25565d88ec24d45ebbc91f921a'),
  ('ops_checklist_runs', 'ops_checklist_runs_rls', '0a65b0468655534ffd5c2e4234ab58a0'),
  ('ops_checklist_tasks', 'ops_checklist_tasks_rls', '3673b8041085a4d1200ad15fc357cfa1'),
  ('ops_checklists', 'ops_checklists_rls', '3673b8041085a4d1200ad15fc357cfa1'),
  ('ops_task_completions', 'ops_task_completions_rls', '0a65b0468655534ffd5c2e4234ab58a0'),
  ('order_status_displays', 'osd_delete', 'e351f80dbd9488b0121e06f396af0b0a'),
  ('order_status_displays', 'osd_insert', '57b5b1b5d2068710ab3da2990ae382d3'),
  ('order_status_displays', 'osd_select', '74b3b16fca0400b49df8559a14d21aaa'),
  ('order_status_displays', 'osd_update', 'a319b68878b335f88a3b9f3ddc415680'),
  ('pos_nudges', 'pos_nudges_tenant', 'dbffab369acbf288a4bb88fb1f2d99ec'),
  ('prep_log', 'prep_log_rls', '0a65b0468655534ffd5c2e4234ab58a0'),
  ('prep_schedule', 'prep_schedule_sel', '08856e11c7e98dbc6dd25cf09701085b'),
  ('production_batches', 'production_batches_ins', 'fffa9aae29d7b4b71b1b83ba3602c2e6'),
  ('production_batches', 'production_batches_sel', '08856e11c7e98dbc6dd25cf09701085b'),
  ('production_batches', 'production_batches_upd', '937986ef5f70857ecc8fae0cdc510adb'),
  ('quote_accuracy', 'quote_accuracy_rw', '8b0be217a9f722ea2b87bf9a332b0bfd'),
  ('recipe_lines', 'recipe_lines_sel', '08856e11c7e98dbc6dd25cf09701085b'),
  ('recipes', 'recipes_sel', '08856e11c7e98dbc6dd25cf09701085b'),
  ('sections', 'sections_tenant', 'dbffab369acbf288a4bb88fb1f2d99ec'),
  ('shifts', 'shifts_tenant', 'dbffab369acbf288a4bb88fb1f2d99ec'),
  ('staff_auth_events', 'staff_auth_events_insert', '8f1650d1ac870540a994b6542c10da6f'),
  ('staff_auth_events', 'staff_auth_events_read', '4bbaa5684d27fd2cd6df93b6fda4dbfd'),
  ('staff_members', 'staff_members_tenant', '3644a0b93764f398c08a420050df26da'),
  ('subscriptions', 'subscriptions_tenant', '90085f0c485ca67b4adc69a565781194'),
  ('supplier_products', 'supplier_products_sel', '08856e11c7e98dbc6dd25cf09701085b'),
  ('temp_check_schedules', 'temp_check_schedules_rls', '3673b8041085a4d1200ad15fc357cfa1'),
  ('temp_readings', 'temp_readings_sel', '5c568a25565d88ec24d45ebbc91f921a'),
  ('temp_units', 'temp_units_rls', '3673b8041085a4d1200ad15fc357cfa1'),
  ('terminal_devices', 'td_select', '0731fd0922314eb2312726a2811d2178'),
  ('turn_time_stats', 'turn_time_stats_rw', '8b0be217a9f722ea2b87bf9a332b0bfd'),
  ('user_locations', 'ul_delete_self', 'f0014a26855d90bd9f43e751568b7009'),
  ('user_locations', 'ul_delete_super_admin', 'f43bcf095c94e8018237c71462b674ab'),
  ('user_locations', 'ul_insert_self_claim', '51640873451b2a18c505373c2471d314'),
  ('user_locations', 'ul_insert_super_admin', '3709df0ccc0047e1ea81ddcbfbaa6d1e'),
  ('user_locations', 'ul_select_super_admin', '8eaa9eb4e8271d0ae6d3ffa231052437'),
  ('user_locations', 'ul_update_super_admin', 'aefb0c3c7af7944b38a83b0fe3016c32'),
  ('user_locations', 'user_locations_select_own', '1e61f817ed9c9e26e6f504ff8f71ab37'),
  ('user_profiles', 'up_delete_super_admin_only', '99ad7e0516c04b25c1d0a6ee4649dfa7'),
  ('user_profiles', 'up_insert_super_admin_only', '8dea2148ffe0f54eee98a7eeed36b9ae'),
  ('waitlist_config', 'waitlist_config_rw', '8b0be217a9f722ea2b87bf9a332b0bfd'),
  ('waitlist_devices', 'waitlist_devices_sel', 'feae0aa1dd1f2eb5544766fdc7dd9a24'),
  ('waitlist_entries', 'waitlist_entries_rw', '8b0be217a9f722ea2b87bf9a332b0bfd'),
  ('waitlist_sms_inbound', 'waitlist_sms_inbound_sel', 'ab7ec1baf0968080b3fe12dcb6a29646'),
  ('waitlist_status_events', 'waitlist_events_rw', '8b0be217a9f722ea2b87bf9a332b0bfd'),
  ('waste_events', 'waste_events_ins', 'fffa9aae29d7b4b71b1b83ba3602c2e6'),
  ('waste_events', 'waste_events_sel', '08856e11c7e98dbc6dd25cf09701085b'),
  ('wf_announcements', 'wf_announcements_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_audit', 'wf_audit_super_admin_select', '8eaa9eb4e8271d0ae6d3ffa231052437'),
  ('wf_availability', 'wf_availability_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_doc_templates', 'wf_doc_templates_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_documents', 'wf_documents_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_holiday_accrual', 'wf_holiday_accrual_super_admin_select', '8eaa9eb4e8271d0ae6d3ffa231052437'),
  ('wf_onboarding', 'wf_onboarding_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_payroll_runs', 'wf_payroll_runs_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_roles', 'wf_roles_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_sales_forecast', 'wf_sales_forecast_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_sections', 'wf_sections_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_shifts', 'wf_shifts_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_staff', 'wf_staff_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_swap_requests', 'wf_swap_requests_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_time_off', 'wf_time_off_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_timesheets', 'wf_timesheets_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_training_assignments', 'wf_training_assignments_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_training_modules', 'wf_training_modules_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_tronc_lines', 'wf_tronc_lines_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_tronc_runs', 'wf_tronc_runs_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_user_roles', 'wf_user_roles_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360'),
  ('wf_venue_settings', 'wf_venue_settings_super_admin_all', '6e5a5a3c10c622a4c5980e1787c70360');

-- GUARD: every policy must still be exactly what was read live on 26 Sep 2026.
-- sig = md5(permissive|roles|cmd|qual|with_check) from pg_policies. Any drift and NOTHING is applied.
do $guard$
declare
  v_bad text;
begin
  select string_agg(m.tbl || '.' || m.pol, ', ' order by m.tbl, m.pol) into v_bad
    from _rls_20260927a m
    left join pg_policies p
      on p.schemaname = 'public' and p.tablename = m.tbl and p.policyname = m.pol
   where p.policyname is null
      or md5(concat_ws('|', p.permissive, p.roles::text, p.cmd,
                       coalesce(p.qual, '-'), coalesce(p.with_check, '-'))) <> m.sig;
  if v_bad is not null then
    raise exception '20260927a stopped, nothing changed: these policies differ from 26 Sep: %', v_bad;
  end if;
end
$guard$;

-- ============================================================ helpers

create or replace function public.accessible_location_ids()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select s.k
    from (
      select public.user_accessible_locations() as k
      union
      select d.location_id::text
        from public.devices d
       where d.device_uid = auth.uid()
         and d.bound_via is not null
         and d.status in ('active', 'online')
      union
      select o.location_id::text
        from public.ops_devices o
       where o.device_uid = auth.uid()
         and o.active
    ) s
   where s.k is not null;
$$;
comment on function public.accessible_location_ids() is 'Venues the caller may use, as text. Same set as pos_can_access(text) allows. For RLS: col in (select public.accessible_location_ids()). 20260927a.';

create or replace function public.accessible_location_uuids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select k::uuid
    from public.accessible_location_ids() as k
   where k ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;
comment on function public.accessible_location_uuids() is 'accessible_location_ids() as uuid (only canonical lowercase uuid text is kept, which is all of it). Same set as pos_can_access(uuid) allows. 20260927a.';

create or replace function public.ops_writable_location_uuids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select k::uuid
    from public.user_accessible_locations() as k
   where k ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  union
  select o.location_id
    from public.ops_devices o
   where o.device_uid = auth.uid()
     and o.active
     and o.location_id is not null;
$$;
comment on function public.ops_writable_location_uuids() is 'Venues ops_can_write(uuid) allows: user_accessible_locations() plus active ops_devices of the caller. 20260927a.';

create or replace function public.waitlist_writable_location_uuids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select k::uuid
    from public.user_accessible_locations() as k
   where k ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  union
  select w.location_id
    from public.waitlist_devices w
   where w.device_uid = auth.uid()
     and w.active
     and w.location_id is not null;
$$;
comment on function public.waitlist_writable_location_uuids() is 'Venues waitlist_can_write(uuid) allows: user_accessible_locations() plus active waitlist_devices of the caller. 20260927a.';

revoke all on function public.accessible_location_ids() from public;
revoke all on function public.accessible_location_uuids() from public;
grant execute on function public.accessible_location_ids() to anon, authenticated, service_role;
grant execute on function public.accessible_location_uuids() to anon, authenticated, service_role;
grant execute on function public.ops_writable_location_uuids() to public, anon, authenticated, service_role;
grant execute on function public.waitlist_writable_location_uuids() to public, anon, authenticated, service_role;

-- ============================================================ policies (104 on 79 tables)

-- bar_tabs
drop policy if exists bar_tabs_tenant on public.bar_tabs;
create policy bar_tabs_tenant on public.bar_tabs
  as permissive
  for all
  to public
  using (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())))
  with check (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())));

-- booking_payments
drop policy if exists "host stand read" on public.booking_payments;
create policy "host stand read" on public.booking_payments
  as permissive
  for select
  to public
  using ((location_id in (select public.waitlist_writable_location_uuids())));
drop policy if exists "paired device read" on public.booking_payments;
create policy "paired device read" on public.booking_payments
  as permissive
  for select
  to public
  using ((EXISTS ( SELECT 1
   FROM devices d
  WHERE ((d.device_uid = (select auth.uid())) AND (d.location_id = booking_payments.location_id)))));

-- cash_drawers
drop policy if exists cash_drawers_tenant on public.cash_drawers;
create policy cash_drawers_tenant on public.cash_drawers
  as permissive
  for all
  to public
  using ((location_id in (select public.accessible_location_uuids())))
  with check ((location_id in (select public.accessible_location_uuids())));

-- cash_movements
drop policy if exists cash_movements_tenant on public.cash_movements;
create policy cash_movements_tenant on public.cash_movements
  as permissive
  for all
  to public
  using ((location_id in (select public.accessible_location_uuids())))
  with check ((location_id in (select public.accessible_location_uuids())));

-- challenge_21_checks
drop policy if exists challenge_21_checks_tenant on public.challenge_21_checks;
create policy challenge_21_checks_tenant on public.challenge_21_checks
  as permissive
  for all
  to public
  using (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())))
  with check (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())));

-- closed_checks
drop policy if exists closed_checks_delete on public.closed_checks;
create policy closed_checks_delete on public.closed_checks
  as permissive
  for delete
  to public
  using ((location_id in (select public.accessible_location_ids())));
drop policy if exists closed_checks_read on public.closed_checks;
create policy closed_checks_read on public.closed_checks
  as permissive
  for select
  to public
  using ((location_id in (select public.accessible_location_ids())));
drop policy if exists closed_checks_update on public.closed_checks;
create policy closed_checks_update on public.closed_checks
  as permissive
  for update
  to public
  using ((location_id in (select public.accessible_location_ids())))
  with check ((location_id in (select public.accessible_location_ids())));

-- customer_locations
drop policy if exists customer_locations_venue on public.customer_locations;
create policy customer_locations_venue on public.customer_locations
  as permissive
  for all
  to authenticated
  using ((location_id in (select public.accessible_location_uuids())))
  with check ((location_id in (select public.accessible_location_uuids())));

-- customer_orders
drop policy if exists customer_orders_venue on public.customer_orders;
create policy customer_orders_venue on public.customer_orders
  as permissive
  for all
  to authenticated
  using ((location_id in (select public.accessible_location_uuids())))
  with check ((location_id in (select public.accessible_location_uuids())));

-- deliveries
drop policy if exists deliveries_rls on public.deliveries;
create policy deliveries_rls on public.deliveries
  as permissive
  for all
  to public
  using ((location_id in (select public.ops_writable_location_uuids())))
  with check ((location_id in (select public.ops_writable_location_uuids())));

-- device_heartbeats
drop policy if exists device_heartbeats_tenant on public.device_heartbeats;
create policy device_heartbeats_tenant on public.device_heartbeats
  as permissive
  for all
  to public
  using (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())))
  with check (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())));

-- drawer_sessions
drop policy if exists drawer_sessions_tenant on public.drawer_sessions;
create policy drawer_sessions_tenant on public.drawer_sessions
  as permissive
  for all
  to public
  using ((location_id in (select public.accessible_location_uuids())))
  with check ((location_id in (select public.accessible_location_uuids())));

-- floor_table_tombstones
drop policy if exists floor_table_tombstones_insert on public.floor_table_tombstones;
create policy floor_table_tombstones_insert on public.floor_table_tombstones
  as permissive
  for insert
  to public
  with check (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())));
drop policy if exists floor_table_tombstones_read on public.floor_table_tombstones;
create policy floor_table_tombstones_read on public.floor_table_tombstones
  as permissive
  for select
  to public
  using (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())));
drop policy if exists floor_table_tombstones_update on public.floor_table_tombstones;
create policy floor_table_tombstones_update on public.floor_table_tombstones
  as permissive
  for update
  to public
  using (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())))
  with check (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())));

-- floor_tables
drop policy if exists floor_tables_delete_tenant on public.floor_tables;
create policy floor_tables_delete_tenant on public.floor_tables
  as permissive
  for delete
  to public
  using (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())));
drop policy if exists floor_tables_insert_tenant on public.floor_tables;
create policy floor_tables_insert_tenant on public.floor_tables
  as permissive
  for insert
  to public
  with check (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())));
drop policy if exists floor_tables_update_tenant on public.floor_tables;
create policy floor_tables_update_tenant on public.floor_tables
  as permissive
  for update
  to public
  using (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())))
  with check (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())));

-- inventory_item_conversions
drop policy if exists inventory_item_conversions_sel on public.inventory_item_conversions;
create policy inventory_item_conversions_sel on public.inventory_item_conversions
  as permissive
  for select
  to public
  using ((location_id in (select public.accessible_location_uuids())));

-- inventory_items
drop policy if exists inventory_items_sel on public.inventory_items;
create policy inventory_items_sel on public.inventory_items
  as permissive
  for select
  to public
  using ((location_id in (select public.accessible_location_uuids())));

-- item_packaging_formats
drop policy if exists item_packaging_formats_sel on public.item_packaging_formats;
create policy item_packaging_formats_sel on public.item_packaging_formats
  as permissive
  for select
  to public
  using ((location_id in (select public.accessible_location_uuids())));

-- location_features
drop policy if exists location_features_tenant on public.location_features;
create policy location_features_tenant on public.location_features
  as permissive
  for all
  to public
  using (((location_id in (select public.accessible_location_uuids())) OR (select public.is_super_admin())))
  with check (((location_id in (select public.accessible_location_uuids())) OR (select public.is_super_admin())));

-- loyalty_transactions
drop policy if exists loyalty_transactions_tenant on public.loyalty_transactions;
create policy loyalty_transactions_tenant on public.loyalty_transactions
  as permissive
  for all
  to public
  using (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())))
  with check (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())));

-- maintenance_requests
drop policy if exists maintenance_requests_rls on public.maintenance_requests;
create policy maintenance_requests_rls on public.maintenance_requests
  as permissive
  for all
  to public
  using ((location_id in (select public.ops_writable_location_uuids())))
  with check ((location_id in (select public.ops_writable_location_uuids())));

-- menu_board_screens
drop policy if exists mb_screens_insert on public.menu_board_screens;
create policy mb_screens_insert on public.menu_board_screens
  as permissive
  for insert
  to public
  with check (((device_uid = (select auth.uid())) AND (location_id IS NULL) AND (board_id IS NULL) AND (order_display_id IS NULL) AND (status = 'unpaired'::text)));
drop policy if exists mb_screens_select on public.menu_board_screens;
create policy mb_screens_select on public.menu_board_screens
  as permissive
  for select
  to public
  using (((device_uid = (select auth.uid())) OR (location_id IN ( SELECT user_locations.location_id
   FROM user_locations
  WHERE (user_locations.user_id = (select auth.uid())))) OR (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = (select auth.uid())) AND (user_profiles.role = 'super_admin'::text))))));

-- menu_item_recipes
drop policy if exists menu_item_recipes_sel on public.menu_item_recipes;
create policy menu_item_recipes_sel on public.menu_item_recipes
  as permissive
  for select
  to public
  using ((location_id in (select public.accessible_location_uuids())));

-- menu_items
drop policy if exists menu_items_write_tenant on public.menu_items;
create policy menu_items_write_tenant on public.menu_items
  as permissive
  for all
  to public
  using (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())))
  with check (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())));

-- menu_translations
drop policy if exists menu_translations_write_tenant on public.menu_translations;
create policy menu_translations_write_tenant on public.menu_translations
  as permissive
  for all
  to public
  using (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())))
  with check (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())));

-- modifier_groups
drop policy if exists modifier_groups_delete on public.modifier_groups;
create policy modifier_groups_delete on public.modifier_groups
  as permissive
  for delete
  to public
  using (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())));
drop policy if exists modifier_groups_update on public.modifier_groups;
create policy modifier_groups_update on public.modifier_groups
  as permissive
  for update
  to public
  using (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())))
  with check (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())));
drop policy if exists modifier_groups_write on public.modifier_groups;
create policy modifier_groups_write on public.modifier_groups
  as permissive
  for insert
  to public
  with check (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())));

-- ops_alerts
drop policy if exists ops_alerts_rls on public.ops_alerts;
create policy ops_alerts_rls on public.ops_alerts
  as permissive
  for all
  to public
  using ((location_id in (select public.ops_writable_location_uuids())))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

-- ops_audit
drop policy if exists ops_audit_ins on public.ops_audit;
create policy ops_audit_ins on public.ops_audit
  as permissive
  for insert
  to public
  with check ((location_id in (select public.ops_writable_location_uuids())));
drop policy if exists ops_audit_sel on public.ops_audit;
create policy ops_audit_sel on public.ops_audit
  as permissive
  for select
  to public
  using ((location_id in (select public.ops_writable_location_uuids())));

-- ops_checklist_runs
drop policy if exists ops_checklist_runs_rls on public.ops_checklist_runs;
create policy ops_checklist_runs_rls on public.ops_checklist_runs
  as permissive
  for all
  to public
  using ((location_id in (select public.ops_writable_location_uuids())))
  with check ((location_id in (select public.ops_writable_location_uuids())));

-- ops_checklist_tasks
drop policy if exists ops_checklist_tasks_rls on public.ops_checklist_tasks;
create policy ops_checklist_tasks_rls on public.ops_checklist_tasks
  as permissive
  for all
  to public
  using ((location_id in (select public.ops_writable_location_uuids())))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

-- ops_checklists
drop policy if exists ops_checklists_rls on public.ops_checklists;
create policy ops_checklists_rls on public.ops_checklists
  as permissive
  for all
  to public
  using ((location_id in (select public.ops_writable_location_uuids())))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

-- ops_task_completions
drop policy if exists ops_task_completions_rls on public.ops_task_completions;
create policy ops_task_completions_rls on public.ops_task_completions
  as permissive
  for all
  to public
  using ((location_id in (select public.ops_writable_location_uuids())))
  with check ((location_id in (select public.ops_writable_location_uuids())));

-- order_status_displays
drop policy if exists osd_delete on public.order_status_displays;
create policy osd_delete on public.order_status_displays
  as permissive
  for delete
  to authenticated
  using (((NOT is_anon_session()) AND (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR (select public.is_super_admin()))));
drop policy if exists osd_insert on public.order_status_displays;
create policy osd_insert on public.order_status_displays
  as permissive
  for insert
  to authenticated
  with check (((NOT is_anon_session()) AND (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR (select public.is_super_admin()))));
drop policy if exists osd_select on public.order_status_displays;
create policy osd_select on public.order_status_displays
  as permissive
  for select
  to authenticated
  using (((NOT is_anon_session()) AND (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR (select public.is_super_admin()))));
drop policy if exists osd_update on public.order_status_displays;
create policy osd_update on public.order_status_displays
  as permissive
  for update
  to authenticated
  using (((NOT is_anon_session()) AND (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR (select public.is_super_admin()))))
  with check (((NOT is_anon_session()) AND (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR (select public.is_super_admin()))));

-- pos_nudges
drop policy if exists pos_nudges_tenant on public.pos_nudges;
create policy pos_nudges_tenant on public.pos_nudges
  as permissive
  for all
  to public
  using (((location_id in (select public.accessible_location_uuids())) OR (select public.is_super_admin())))
  with check (((location_id in (select public.accessible_location_uuids())) OR (select public.is_super_admin())));

-- prep_log
drop policy if exists prep_log_rls on public.prep_log;
create policy prep_log_rls on public.prep_log
  as permissive
  for all
  to public
  using ((location_id in (select public.ops_writable_location_uuids())))
  with check ((location_id in (select public.ops_writable_location_uuids())));

-- prep_schedule
drop policy if exists prep_schedule_sel on public.prep_schedule;
create policy prep_schedule_sel on public.prep_schedule
  as permissive
  for select
  to public
  using ((location_id in (select public.accessible_location_uuids())));

-- production_batches
drop policy if exists production_batches_ins on public.production_batches;
create policy production_batches_ins on public.production_batches
  as permissive
  for insert
  to public
  with check ((location_id in (select public.accessible_location_uuids())));
drop policy if exists production_batches_sel on public.production_batches;
create policy production_batches_sel on public.production_batches
  as permissive
  for select
  to public
  using ((location_id in (select public.accessible_location_uuids())));
drop policy if exists production_batches_upd on public.production_batches;
create policy production_batches_upd on public.production_batches
  as permissive
  for update
  to public
  using ((location_id in (select public.accessible_location_uuids())))
  with check ((location_id in (select public.accessible_location_uuids())));

-- quote_accuracy
drop policy if exists quote_accuracy_rw on public.quote_accuracy;
create policy quote_accuracy_rw on public.quote_accuracy
  as permissive
  for all
  to public
  using ((location_id in (select public.waitlist_writable_location_uuids())))
  with check ((location_id in (select public.waitlist_writable_location_uuids())));

-- recipe_lines
drop policy if exists recipe_lines_sel on public.recipe_lines;
create policy recipe_lines_sel on public.recipe_lines
  as permissive
  for select
  to public
  using ((location_id in (select public.accessible_location_uuids())));

-- recipes
drop policy if exists recipes_sel on public.recipes;
create policy recipes_sel on public.recipes
  as permissive
  for select
  to public
  using ((location_id in (select public.accessible_location_uuids())));

-- sections
drop policy if exists sections_tenant on public.sections;
create policy sections_tenant on public.sections
  as permissive
  for all
  to public
  using (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())))
  with check (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())));

-- shifts
drop policy if exists shifts_tenant on public.shifts;
create policy shifts_tenant on public.shifts
  as permissive
  for all
  to public
  using (((location_id in (select public.accessible_location_uuids())) OR (select public.is_super_admin())))
  with check (((location_id in (select public.accessible_location_uuids())) OR (select public.is_super_admin())));

-- staff_auth_events
drop policy if exists staff_auth_events_insert on public.staff_auth_events;
create policy staff_auth_events_insert on public.staff_auth_events
  as permissive
  for insert
  to public
  with check (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())));
drop policy if exists staff_auth_events_read on public.staff_auth_events;
create policy staff_auth_events_read on public.staff_auth_events
  as permissive
  for select
  to public
  using (((location_id in (select public.accessible_location_ids())) OR (select public.is_super_admin())));

-- staff_members
drop policy if exists staff_members_tenant on public.staff_members;
create policy staff_members_tenant on public.staff_members
  as permissive
  for all
  to public
  using ((location_id in (select public.accessible_location_uuids())))
  with check ((location_id in (select public.accessible_location_uuids())));

-- subscriptions
drop policy if exists subscriptions_tenant on public.subscriptions;
create policy subscriptions_tenant on public.subscriptions
  as permissive
  for all
  to public
  using ((((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR (select public.is_super_admin())))
  with check ((((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR (select public.is_super_admin())));

-- supplier_products
drop policy if exists supplier_products_sel on public.supplier_products;
create policy supplier_products_sel on public.supplier_products
  as permissive
  for select
  to public
  using ((location_id in (select public.accessible_location_uuids())));

-- temp_check_schedules
drop policy if exists temp_check_schedules_rls on public.temp_check_schedules;
create policy temp_check_schedules_rls on public.temp_check_schedules
  as permissive
  for all
  to public
  using ((location_id in (select public.ops_writable_location_uuids())))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

-- temp_readings
drop policy if exists temp_readings_sel on public.temp_readings;
create policy temp_readings_sel on public.temp_readings
  as permissive
  for select
  to public
  using ((location_id in (select public.ops_writable_location_uuids())));

-- temp_units
drop policy if exists temp_units_rls on public.temp_units;
create policy temp_units_rls on public.temp_units
  as permissive
  for all
  to public
  using ((location_id in (select public.ops_writable_location_uuids())))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

-- terminal_devices
drop policy if exists td_select on public.terminal_devices;
create policy td_select on public.terminal_devices
  as permissive
  for select
  to public
  using (((device_uid = (select auth.uid())) OR (location_id IN ( SELECT user_locations.location_id
   FROM user_locations
  WHERE (user_locations.user_id = (select auth.uid())))) OR (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = (select auth.uid())) AND (user_profiles.role = 'super_admin'::text))))));

-- turn_time_stats
drop policy if exists turn_time_stats_rw on public.turn_time_stats;
create policy turn_time_stats_rw on public.turn_time_stats
  as permissive
  for all
  to public
  using ((location_id in (select public.waitlist_writable_location_uuids())))
  with check ((location_id in (select public.waitlist_writable_location_uuids())));

-- user_locations
drop policy if exists ul_delete_self on public.user_locations;
create policy ul_delete_self on public.user_locations
  as permissive
  for delete
  to public
  using (((user_id = (select auth.uid())) AND (NOT is_anon_session())));
drop policy if exists ul_delete_super_admin on public.user_locations;
create policy ul_delete_super_admin on public.user_locations
  as permissive
  for delete
  to public
  using ((select public.is_super_admin()));
drop policy if exists ul_insert_self_claim on public.user_locations;
create policy ul_insert_self_claim on public.user_locations
  as permissive
  for insert
  to public
  with check (((user_id = (select auth.uid())) AND (NOT is_anon_session()) AND (role = 'owner'::text) AND can_claim_location(location_id)));
drop policy if exists ul_insert_super_admin on public.user_locations;
create policy ul_insert_super_admin on public.user_locations
  as permissive
  for insert
  to public
  with check ((select public.is_super_admin()));
drop policy if exists ul_select_super_admin on public.user_locations;
create policy ul_select_super_admin on public.user_locations
  as permissive
  for select
  to public
  using ((select public.is_super_admin()));
drop policy if exists ul_update_super_admin on public.user_locations;
create policy ul_update_super_admin on public.user_locations
  as permissive
  for update
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));
drop policy if exists user_locations_select_own on public.user_locations;
create policy user_locations_select_own on public.user_locations
  as permissive
  for select
  to public
  using (((select auth.uid()) = user_id));

-- user_profiles
drop policy if exists up_delete_super_admin_only on public.user_profiles;
create policy up_delete_super_admin_only on public.user_profiles
  as restrictive
  for delete
  to public
  using ((select public.is_super_admin()));
drop policy if exists up_insert_super_admin_only on public.user_profiles;
create policy up_insert_super_admin_only on public.user_profiles
  as restrictive
  for insert
  to public
  with check ((select public.is_super_admin()));

-- waitlist_config
drop policy if exists waitlist_config_rw on public.waitlist_config;
create policy waitlist_config_rw on public.waitlist_config
  as permissive
  for all
  to public
  using ((location_id in (select public.waitlist_writable_location_uuids())))
  with check ((location_id in (select public.waitlist_writable_location_uuids())));

-- waitlist_devices
drop policy if exists waitlist_devices_sel on public.waitlist_devices;
create policy waitlist_devices_sel on public.waitlist_devices
  as permissive
  for select
  to public
  using (((device_uid = (select auth.uid())) OR ((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))));

-- waitlist_entries
drop policy if exists waitlist_entries_rw on public.waitlist_entries;
create policy waitlist_entries_rw on public.waitlist_entries
  as permissive
  for all
  to public
  using ((location_id in (select public.waitlist_writable_location_uuids())))
  with check ((location_id in (select public.waitlist_writable_location_uuids())));

-- waitlist_sms_inbound
drop policy if exists waitlist_sms_inbound_sel on public.waitlist_sms_inbound;
create policy waitlist_sms_inbound_sel on public.waitlist_sms_inbound
  as permissive
  for select
  to public
  using ((location_id in (select public.waitlist_writable_location_uuids())));

-- waitlist_status_events
drop policy if exists waitlist_events_rw on public.waitlist_status_events;
create policy waitlist_events_rw on public.waitlist_status_events
  as permissive
  for all
  to public
  using ((location_id in (select public.waitlist_writable_location_uuids())))
  with check ((location_id in (select public.waitlist_writable_location_uuids())));

-- waste_events
drop policy if exists waste_events_ins on public.waste_events;
create policy waste_events_ins on public.waste_events
  as permissive
  for insert
  to public
  with check ((location_id in (select public.accessible_location_uuids())));
drop policy if exists waste_events_sel on public.waste_events;
create policy waste_events_sel on public.waste_events
  as permissive
  for select
  to public
  using ((location_id in (select public.accessible_location_uuids())));

-- wf_announcements
drop policy if exists wf_announcements_super_admin_all on public.wf_announcements;
create policy wf_announcements_super_admin_all on public.wf_announcements
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_audit
drop policy if exists wf_audit_super_admin_select on public.wf_audit;
create policy wf_audit_super_admin_select on public.wf_audit
  as permissive
  for select
  to public
  using ((select public.is_super_admin()));

-- wf_availability
drop policy if exists wf_availability_super_admin_all on public.wf_availability;
create policy wf_availability_super_admin_all on public.wf_availability
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_doc_templates
drop policy if exists wf_doc_templates_super_admin_all on public.wf_doc_templates;
create policy wf_doc_templates_super_admin_all on public.wf_doc_templates
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_documents
drop policy if exists wf_documents_super_admin_all on public.wf_documents;
create policy wf_documents_super_admin_all on public.wf_documents
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_holiday_accrual
drop policy if exists wf_holiday_accrual_super_admin_select on public.wf_holiday_accrual;
create policy wf_holiday_accrual_super_admin_select on public.wf_holiday_accrual
  as permissive
  for select
  to public
  using ((select public.is_super_admin()));

-- wf_onboarding
drop policy if exists wf_onboarding_super_admin_all on public.wf_onboarding;
create policy wf_onboarding_super_admin_all on public.wf_onboarding
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_payroll_runs
drop policy if exists wf_payroll_runs_super_admin_all on public.wf_payroll_runs;
create policy wf_payroll_runs_super_admin_all on public.wf_payroll_runs
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_roles
drop policy if exists wf_roles_super_admin_all on public.wf_roles;
create policy wf_roles_super_admin_all on public.wf_roles
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_sales_forecast
drop policy if exists wf_sales_forecast_super_admin_all on public.wf_sales_forecast;
create policy wf_sales_forecast_super_admin_all on public.wf_sales_forecast
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_sections
drop policy if exists wf_sections_super_admin_all on public.wf_sections;
create policy wf_sections_super_admin_all on public.wf_sections
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_shifts
drop policy if exists wf_shifts_super_admin_all on public.wf_shifts;
create policy wf_shifts_super_admin_all on public.wf_shifts
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_staff
drop policy if exists wf_staff_super_admin_all on public.wf_staff;
create policy wf_staff_super_admin_all on public.wf_staff
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_swap_requests
drop policy if exists wf_swap_requests_super_admin_all on public.wf_swap_requests;
create policy wf_swap_requests_super_admin_all on public.wf_swap_requests
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_time_off
drop policy if exists wf_time_off_super_admin_all on public.wf_time_off;
create policy wf_time_off_super_admin_all on public.wf_time_off
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_timesheets
drop policy if exists wf_timesheets_super_admin_all on public.wf_timesheets;
create policy wf_timesheets_super_admin_all on public.wf_timesheets
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_training_assignments
drop policy if exists wf_training_assignments_super_admin_all on public.wf_training_assignments;
create policy wf_training_assignments_super_admin_all on public.wf_training_assignments
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_training_modules
drop policy if exists wf_training_modules_super_admin_all on public.wf_training_modules;
create policy wf_training_modules_super_admin_all on public.wf_training_modules
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_tronc_lines
drop policy if exists wf_tronc_lines_super_admin_all on public.wf_tronc_lines;
create policy wf_tronc_lines_super_admin_all on public.wf_tronc_lines
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_tronc_runs
drop policy if exists wf_tronc_runs_super_admin_all on public.wf_tronc_runs;
create policy wf_tronc_runs_super_admin_all on public.wf_tronc_runs
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_user_roles
drop policy if exists wf_user_roles_super_admin_all on public.wf_user_roles;
create policy wf_user_roles_super_admin_all on public.wf_user_roles
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- wf_venue_settings
drop policy if exists wf_venue_settings_super_admin_all on public.wf_venue_settings;
create policy wf_venue_settings_super_admin_all on public.wf_venue_settings
  as permissive
  for all
  to public
  using ((select public.is_super_admin()))
  with check ((select public.is_super_admin()));

-- ============================================================ post check

-- POST CHECK: all 104 policies exist and none still calls a per-row helper or an unwrapped
-- is_super_admin() / auth.uid(). Any failure rolls the whole transaction back.
do $post$
declare
  v_missing text;
  v_slow    text;
begin
  select string_agg(m.tbl || '.' || m.pol, ', ') into v_missing
    from _rls_20260927a m
    left join pg_policies p
      on p.schemaname = 'public' and p.tablename = m.tbl and p.policyname = m.pol
   where p.policyname is null;
  if v_missing is not null then
    raise exception '20260927a: policies missing after the rewrite: %', v_missing;
  end if;

  select string_agg(m.tbl || '.' || m.pol, ', ') into v_slow
    from _rls_20260927a m
    join pg_policies p
      on p.schemaname = 'public' and p.tablename = m.tbl and p.policyname = m.pol
   where concat_ws(' ', p.qual, p.with_check) ~ '(pos_can_access|ops_can_write|waitlist_can_write)\('
      or replace(concat_ws(' ', p.qual, p.with_check), 'SELECT is_super_admin() AS is_super_admin', '') like '%is_super_admin()%'
      or replace(concat_ws(' ', p.qual, p.with_check), 'SELECT auth.uid() AS uid', '') like '%auth.uid()%';
  if v_slow is not null then
    raise exception '20260927a: still per row after the rewrite: %', v_slow;
  end if;
end
$post$;

commit;
