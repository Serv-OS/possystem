-- ROLLBACK for 20260927a_OPS_rls_set_form.sql (Ops, tbetcegmszzotrwdtqhi).
-- Restores all 104 policies to the exact text read live from pg_policies on 26 Sep 2026,
-- then drops the 4 helpers the migration added. One transaction; safe to run twice.
-- No cascade on purpose: if something newer uses a helper, its drop fails, the whole rollback
-- stops and nothing changes.

begin;

set local lock_timeout = '3s';
set local statement_timeout = '120s';
set local search_path = public;

-- bar_tabs
drop policy if exists bar_tabs_tenant on public.bar_tabs;
create policy bar_tabs_tenant on public.bar_tabs
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

-- booking_payments
drop policy if exists "host stand read" on public.booking_payments;
create policy "host stand read" on public.booking_payments
  as permissive
  for select
  to public
  using (waitlist_can_write(location_id));
drop policy if exists "paired device read" on public.booking_payments;
create policy "paired device read" on public.booking_payments
  as permissive
  for select
  to public
  using ((EXISTS ( SELECT 1
   FROM devices d
  WHERE ((d.device_uid = auth.uid()) AND (d.location_id = booking_payments.location_id)))));

-- cash_drawers
drop policy if exists cash_drawers_tenant on public.cash_drawers;
create policy cash_drawers_tenant on public.cash_drawers
  as permissive
  for all
  to public
  using (pos_can_access(location_id))
  with check (pos_can_access(location_id));

-- cash_movements
drop policy if exists cash_movements_tenant on public.cash_movements;
create policy cash_movements_tenant on public.cash_movements
  as permissive
  for all
  to public
  using (pos_can_access(location_id))
  with check (pos_can_access(location_id));

-- challenge_21_checks
drop policy if exists challenge_21_checks_tenant on public.challenge_21_checks;
create policy challenge_21_checks_tenant on public.challenge_21_checks
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

-- closed_checks
drop policy if exists closed_checks_delete on public.closed_checks;
create policy closed_checks_delete on public.closed_checks
  as permissive
  for delete
  to public
  using (pos_can_access(location_id));
drop policy if exists closed_checks_read on public.closed_checks;
create policy closed_checks_read on public.closed_checks
  as permissive
  for select
  to public
  using (pos_can_access(location_id));
drop policy if exists closed_checks_update on public.closed_checks;
create policy closed_checks_update on public.closed_checks
  as permissive
  for update
  to public
  using (pos_can_access(location_id))
  with check (pos_can_access(location_id));

-- customer_locations
drop policy if exists customer_locations_venue on public.customer_locations;
create policy customer_locations_venue on public.customer_locations
  as permissive
  for all
  to authenticated
  using (pos_can_access((location_id)::text))
  with check (pos_can_access((location_id)::text));

-- customer_orders
drop policy if exists customer_orders_venue on public.customer_orders;
create policy customer_orders_venue on public.customer_orders
  as permissive
  for all
  to authenticated
  using (pos_can_access((location_id)::text))
  with check (pos_can_access((location_id)::text));

-- deliveries
drop policy if exists deliveries_rls on public.deliveries;
create policy deliveries_rls on public.deliveries
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (ops_can_write(location_id));

-- device_heartbeats
drop policy if exists device_heartbeats_tenant on public.device_heartbeats;
create policy device_heartbeats_tenant on public.device_heartbeats
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

-- drawer_sessions
drop policy if exists drawer_sessions_tenant on public.drawer_sessions;
create policy drawer_sessions_tenant on public.drawer_sessions
  as permissive
  for all
  to public
  using (pos_can_access(location_id))
  with check (pos_can_access(location_id));

-- floor_table_tombstones
drop policy if exists floor_table_tombstones_insert on public.floor_table_tombstones;
create policy floor_table_tombstones_insert on public.floor_table_tombstones
  as permissive
  for insert
  to public
  with check ((pos_can_access(location_id) OR is_super_admin()));
drop policy if exists floor_table_tombstones_read on public.floor_table_tombstones;
create policy floor_table_tombstones_read on public.floor_table_tombstones
  as permissive
  for select
  to public
  using ((pos_can_access(location_id) OR is_super_admin()));
drop policy if exists floor_table_tombstones_update on public.floor_table_tombstones;
create policy floor_table_tombstones_update on public.floor_table_tombstones
  as permissive
  for update
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

-- floor_tables
drop policy if exists floor_tables_delete_tenant on public.floor_tables;
create policy floor_tables_delete_tenant on public.floor_tables
  as permissive
  for delete
  to public
  using ((pos_can_access(location_id) OR is_super_admin()));
drop policy if exists floor_tables_insert_tenant on public.floor_tables;
create policy floor_tables_insert_tenant on public.floor_tables
  as permissive
  for insert
  to public
  with check ((pos_can_access(location_id) OR is_super_admin()));
drop policy if exists floor_tables_update_tenant on public.floor_tables;
create policy floor_tables_update_tenant on public.floor_tables
  as permissive
  for update
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

-- inventory_item_conversions
drop policy if exists inventory_item_conversions_sel on public.inventory_item_conversions;
create policy inventory_item_conversions_sel on public.inventory_item_conversions
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

-- inventory_items
drop policy if exists inventory_items_sel on public.inventory_items;
create policy inventory_items_sel on public.inventory_items
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

-- item_packaging_formats
drop policy if exists item_packaging_formats_sel on public.item_packaging_formats;
create policy item_packaging_formats_sel on public.item_packaging_formats
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

-- location_features
drop policy if exists location_features_tenant on public.location_features;
create policy location_features_tenant on public.location_features
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

-- loyalty_transactions
drop policy if exists loyalty_transactions_tenant on public.loyalty_transactions;
create policy loyalty_transactions_tenant on public.loyalty_transactions
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

-- maintenance_requests
drop policy if exists maintenance_requests_rls on public.maintenance_requests;
create policy maintenance_requests_rls on public.maintenance_requests
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (ops_can_write(location_id));

-- menu_board_screens
drop policy if exists mb_screens_insert on public.menu_board_screens;
create policy mb_screens_insert on public.menu_board_screens
  as permissive
  for insert
  to public
  with check (((device_uid = auth.uid()) AND (location_id IS NULL) AND (board_id IS NULL) AND (order_display_id IS NULL) AND (status = 'unpaired'::text)));
drop policy if exists mb_screens_select on public.menu_board_screens;
create policy mb_screens_select on public.menu_board_screens
  as permissive
  for select
  to public
  using (((device_uid = auth.uid()) OR (location_id IN ( SELECT user_locations.location_id
   FROM user_locations
  WHERE (user_locations.user_id = auth.uid()))) OR (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = 'super_admin'::text))))));

-- menu_item_recipes
drop policy if exists menu_item_recipes_sel on public.menu_item_recipes;
create policy menu_item_recipes_sel on public.menu_item_recipes
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

-- menu_items
drop policy if exists menu_items_write_tenant on public.menu_items;
create policy menu_items_write_tenant on public.menu_items
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

-- menu_translations
drop policy if exists menu_translations_write_tenant on public.menu_translations;
create policy menu_translations_write_tenant on public.menu_translations
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

-- modifier_groups
drop policy if exists modifier_groups_delete on public.modifier_groups;
create policy modifier_groups_delete on public.modifier_groups
  as permissive
  for delete
  to public
  using ((pos_can_access(location_id) OR is_super_admin()));
drop policy if exists modifier_groups_update on public.modifier_groups;
create policy modifier_groups_update on public.modifier_groups
  as permissive
  for update
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));
drop policy if exists modifier_groups_write on public.modifier_groups;
create policy modifier_groups_write on public.modifier_groups
  as permissive
  for insert
  to public
  with check ((pos_can_access(location_id) OR is_super_admin()));

-- ops_alerts
drop policy if exists ops_alerts_rls on public.ops_alerts;
create policy ops_alerts_rls on public.ops_alerts
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

-- ops_audit
drop policy if exists ops_audit_ins on public.ops_audit;
create policy ops_audit_ins on public.ops_audit
  as permissive
  for insert
  to public
  with check (ops_can_write(location_id));
drop policy if exists ops_audit_sel on public.ops_audit;
create policy ops_audit_sel on public.ops_audit
  as permissive
  for select
  to public
  using (ops_can_write(location_id));

-- ops_checklist_runs
drop policy if exists ops_checklist_runs_rls on public.ops_checklist_runs;
create policy ops_checklist_runs_rls on public.ops_checklist_runs
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (ops_can_write(location_id));

-- ops_checklist_tasks
drop policy if exists ops_checklist_tasks_rls on public.ops_checklist_tasks;
create policy ops_checklist_tasks_rls on public.ops_checklist_tasks
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

-- ops_checklists
drop policy if exists ops_checklists_rls on public.ops_checklists;
create policy ops_checklists_rls on public.ops_checklists
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

-- ops_task_completions
drop policy if exists ops_task_completions_rls on public.ops_task_completions;
create policy ops_task_completions_rls on public.ops_task_completions
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (ops_can_write(location_id));

-- order_status_displays
drop policy if exists osd_delete on public.order_status_displays;
create policy osd_delete on public.order_status_displays
  as permissive
  for delete
  to authenticated
  using (((NOT is_anon_session()) AND (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR is_super_admin())));
drop policy if exists osd_insert on public.order_status_displays;
create policy osd_insert on public.order_status_displays
  as permissive
  for insert
  to authenticated
  with check (((NOT is_anon_session()) AND (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR is_super_admin())));
drop policy if exists osd_select on public.order_status_displays;
create policy osd_select on public.order_status_displays
  as permissive
  for select
  to authenticated
  using (((NOT is_anon_session()) AND (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR is_super_admin())));
drop policy if exists osd_update on public.order_status_displays;
create policy osd_update on public.order_status_displays
  as permissive
  for update
  to authenticated
  using (((NOT is_anon_session()) AND (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR is_super_admin())))
  with check (((NOT is_anon_session()) AND (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR is_super_admin())));

-- pos_nudges
drop policy if exists pos_nudges_tenant on public.pos_nudges;
create policy pos_nudges_tenant on public.pos_nudges
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

-- prep_log
drop policy if exists prep_log_rls on public.prep_log;
create policy prep_log_rls on public.prep_log
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (ops_can_write(location_id));

-- prep_schedule
drop policy if exists prep_schedule_sel on public.prep_schedule;
create policy prep_schedule_sel on public.prep_schedule
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

-- production_batches
drop policy if exists production_batches_ins on public.production_batches;
create policy production_batches_ins on public.production_batches
  as permissive
  for insert
  to public
  with check (pos_can_access(location_id));
drop policy if exists production_batches_sel on public.production_batches;
create policy production_batches_sel on public.production_batches
  as permissive
  for select
  to public
  using (pos_can_access(location_id));
drop policy if exists production_batches_upd on public.production_batches;
create policy production_batches_upd on public.production_batches
  as permissive
  for update
  to public
  using (pos_can_access(location_id))
  with check (pos_can_access(location_id));

-- quote_accuracy
drop policy if exists quote_accuracy_rw on public.quote_accuracy;
create policy quote_accuracy_rw on public.quote_accuracy
  as permissive
  for all
  to public
  using (waitlist_can_write(location_id))
  with check (waitlist_can_write(location_id));

-- recipe_lines
drop policy if exists recipe_lines_sel on public.recipe_lines;
create policy recipe_lines_sel on public.recipe_lines
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

-- recipes
drop policy if exists recipes_sel on public.recipes;
create policy recipes_sel on public.recipes
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

-- sections
drop policy if exists sections_tenant on public.sections;
create policy sections_tenant on public.sections
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

-- shifts
drop policy if exists shifts_tenant on public.shifts;
create policy shifts_tenant on public.shifts
  as permissive
  for all
  to public
  using ((pos_can_access(location_id) OR is_super_admin()))
  with check ((pos_can_access(location_id) OR is_super_admin()));

-- staff_auth_events
drop policy if exists staff_auth_events_insert on public.staff_auth_events;
create policy staff_auth_events_insert on public.staff_auth_events
  as permissive
  for insert
  to public
  with check ((pos_can_access(location_id) OR is_super_admin()));
drop policy if exists staff_auth_events_read on public.staff_auth_events;
create policy staff_auth_events_read on public.staff_auth_events
  as permissive
  for select
  to public
  using ((pos_can_access(location_id) OR is_super_admin()));

-- staff_members
drop policy if exists staff_members_tenant on public.staff_members;
create policy staff_members_tenant on public.staff_members
  as permissive
  for all
  to public
  using (pos_can_access(location_id))
  with check (pos_can_access(location_id));

-- subscriptions
drop policy if exists subscriptions_tenant on public.subscriptions;
create policy subscriptions_tenant on public.subscriptions
  as permissive
  for all
  to public
  using ((((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR is_super_admin()))
  with check ((((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)) OR is_super_admin()));

-- supplier_products
drop policy if exists supplier_products_sel on public.supplier_products;
create policy supplier_products_sel on public.supplier_products
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

-- temp_check_schedules
drop policy if exists temp_check_schedules_rls on public.temp_check_schedules;
create policy temp_check_schedules_rls on public.temp_check_schedules
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

-- temp_readings
drop policy if exists temp_readings_sel on public.temp_readings;
create policy temp_readings_sel on public.temp_readings
  as permissive
  for select
  to public
  using (ops_can_write(location_id));

-- temp_units
drop policy if exists temp_units_rls on public.temp_units;
create policy temp_units_rls on public.temp_units
  as permissive
  for all
  to public
  using (ops_can_write(location_id))
  with check (((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations)));

-- terminal_devices
drop policy if exists td_select on public.terminal_devices;
create policy td_select on public.terminal_devices
  as permissive
  for select
  to public
  using (((device_uid = auth.uid()) OR (location_id IN ( SELECT user_locations.location_id
   FROM user_locations
  WHERE (user_locations.user_id = auth.uid()))) OR (EXISTS ( SELECT 1
   FROM user_profiles
  WHERE ((user_profiles.id = auth.uid()) AND (user_profiles.role = 'super_admin'::text))))));

-- turn_time_stats
drop policy if exists turn_time_stats_rw on public.turn_time_stats;
create policy turn_time_stats_rw on public.turn_time_stats
  as permissive
  for all
  to public
  using (waitlist_can_write(location_id))
  with check (waitlist_can_write(location_id));

-- user_locations
drop policy if exists ul_delete_self on public.user_locations;
create policy ul_delete_self on public.user_locations
  as permissive
  for delete
  to public
  using (((user_id = auth.uid()) AND (NOT is_anon_session())));
drop policy if exists ul_delete_super_admin on public.user_locations;
create policy ul_delete_super_admin on public.user_locations
  as permissive
  for delete
  to public
  using (is_super_admin());
drop policy if exists ul_insert_self_claim on public.user_locations;
create policy ul_insert_self_claim on public.user_locations
  as permissive
  for insert
  to public
  with check (((user_id = auth.uid()) AND (NOT is_anon_session()) AND (role = 'owner'::text) AND can_claim_location(location_id)));
drop policy if exists ul_insert_super_admin on public.user_locations;
create policy ul_insert_super_admin on public.user_locations
  as permissive
  for insert
  to public
  with check (is_super_admin());
drop policy if exists ul_select_super_admin on public.user_locations;
create policy ul_select_super_admin on public.user_locations
  as permissive
  for select
  to public
  using (is_super_admin());
drop policy if exists ul_update_super_admin on public.user_locations;
create policy ul_update_super_admin on public.user_locations
  as permissive
  for update
  to public
  using (is_super_admin())
  with check (is_super_admin());
drop policy if exists user_locations_select_own on public.user_locations;
create policy user_locations_select_own on public.user_locations
  as permissive
  for select
  to public
  using ((auth.uid() = user_id));

-- user_profiles
drop policy if exists up_delete_super_admin_only on public.user_profiles;
create policy up_delete_super_admin_only on public.user_profiles
  as restrictive
  for delete
  to public
  using (is_super_admin());
drop policy if exists up_insert_super_admin_only on public.user_profiles;
create policy up_insert_super_admin_only on public.user_profiles
  as restrictive
  for insert
  to public
  with check (is_super_admin());

-- waitlist_config
drop policy if exists waitlist_config_rw on public.waitlist_config;
create policy waitlist_config_rw on public.waitlist_config
  as permissive
  for all
  to public
  using (waitlist_can_write(location_id))
  with check (waitlist_can_write(location_id));

-- waitlist_devices
drop policy if exists waitlist_devices_sel on public.waitlist_devices;
create policy waitlist_devices_sel on public.waitlist_devices
  as permissive
  for select
  to public
  using (((device_uid = auth.uid()) OR ((location_id)::text IN ( SELECT user_accessible_locations() AS user_accessible_locations))));

-- waitlist_entries
drop policy if exists waitlist_entries_rw on public.waitlist_entries;
create policy waitlist_entries_rw on public.waitlist_entries
  as permissive
  for all
  to public
  using (waitlist_can_write(location_id))
  with check (waitlist_can_write(location_id));

-- waitlist_sms_inbound
drop policy if exists waitlist_sms_inbound_sel on public.waitlist_sms_inbound;
create policy waitlist_sms_inbound_sel on public.waitlist_sms_inbound
  as permissive
  for select
  to public
  using (waitlist_can_write(location_id));

-- waitlist_status_events
drop policy if exists waitlist_events_rw on public.waitlist_status_events;
create policy waitlist_events_rw on public.waitlist_status_events
  as permissive
  for all
  to public
  using (waitlist_can_write(location_id))
  with check (waitlist_can_write(location_id));

-- waste_events
drop policy if exists waste_events_ins on public.waste_events;
create policy waste_events_ins on public.waste_events
  as permissive
  for insert
  to public
  with check (pos_can_access(location_id));
drop policy if exists waste_events_sel on public.waste_events;
create policy waste_events_sel on public.waste_events
  as permissive
  for select
  to public
  using (pos_can_access(location_id));

-- wf_announcements
drop policy if exists wf_announcements_super_admin_all on public.wf_announcements;
create policy wf_announcements_super_admin_all on public.wf_announcements
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_audit
drop policy if exists wf_audit_super_admin_select on public.wf_audit;
create policy wf_audit_super_admin_select on public.wf_audit
  as permissive
  for select
  to public
  using (is_super_admin());

-- wf_availability
drop policy if exists wf_availability_super_admin_all on public.wf_availability;
create policy wf_availability_super_admin_all on public.wf_availability
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_doc_templates
drop policy if exists wf_doc_templates_super_admin_all on public.wf_doc_templates;
create policy wf_doc_templates_super_admin_all on public.wf_doc_templates
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_documents
drop policy if exists wf_documents_super_admin_all on public.wf_documents;
create policy wf_documents_super_admin_all on public.wf_documents
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_holiday_accrual
drop policy if exists wf_holiday_accrual_super_admin_select on public.wf_holiday_accrual;
create policy wf_holiday_accrual_super_admin_select on public.wf_holiday_accrual
  as permissive
  for select
  to public
  using (is_super_admin());

-- wf_onboarding
drop policy if exists wf_onboarding_super_admin_all on public.wf_onboarding;
create policy wf_onboarding_super_admin_all on public.wf_onboarding
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_payroll_runs
drop policy if exists wf_payroll_runs_super_admin_all on public.wf_payroll_runs;
create policy wf_payroll_runs_super_admin_all on public.wf_payroll_runs
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_roles
drop policy if exists wf_roles_super_admin_all on public.wf_roles;
create policy wf_roles_super_admin_all on public.wf_roles
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_sales_forecast
drop policy if exists wf_sales_forecast_super_admin_all on public.wf_sales_forecast;
create policy wf_sales_forecast_super_admin_all on public.wf_sales_forecast
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_sections
drop policy if exists wf_sections_super_admin_all on public.wf_sections;
create policy wf_sections_super_admin_all on public.wf_sections
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_shifts
drop policy if exists wf_shifts_super_admin_all on public.wf_shifts;
create policy wf_shifts_super_admin_all on public.wf_shifts
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_staff
drop policy if exists wf_staff_super_admin_all on public.wf_staff;
create policy wf_staff_super_admin_all on public.wf_staff
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_swap_requests
drop policy if exists wf_swap_requests_super_admin_all on public.wf_swap_requests;
create policy wf_swap_requests_super_admin_all on public.wf_swap_requests
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_time_off
drop policy if exists wf_time_off_super_admin_all on public.wf_time_off;
create policy wf_time_off_super_admin_all on public.wf_time_off
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_timesheets
drop policy if exists wf_timesheets_super_admin_all on public.wf_timesheets;
create policy wf_timesheets_super_admin_all on public.wf_timesheets
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_training_assignments
drop policy if exists wf_training_assignments_super_admin_all on public.wf_training_assignments;
create policy wf_training_assignments_super_admin_all on public.wf_training_assignments
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_training_modules
drop policy if exists wf_training_modules_super_admin_all on public.wf_training_modules;
create policy wf_training_modules_super_admin_all on public.wf_training_modules
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_tronc_lines
drop policy if exists wf_tronc_lines_super_admin_all on public.wf_tronc_lines;
create policy wf_tronc_lines_super_admin_all on public.wf_tronc_lines
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_tronc_runs
drop policy if exists wf_tronc_runs_super_admin_all on public.wf_tronc_runs;
create policy wf_tronc_runs_super_admin_all on public.wf_tronc_runs
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_user_roles
drop policy if exists wf_user_roles_super_admin_all on public.wf_user_roles;
create policy wf_user_roles_super_admin_all on public.wf_user_roles
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- wf_venue_settings
drop policy if exists wf_venue_settings_super_admin_all on public.wf_venue_settings;
create policy wf_venue_settings_super_admin_all on public.wf_venue_settings
  as permissive
  for all
  to public
  using (is_super_admin())
  with check (is_super_admin());

-- ============================================================ helpers
drop function if exists public.accessible_location_uuids();
drop function if exists public.accessible_location_ids();
drop function if exists public.ops_writable_location_uuids();
drop function if exists public.waitlist_writable_location_uuids();

commit;
