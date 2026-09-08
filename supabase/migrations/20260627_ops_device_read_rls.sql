-- ============================================================================
-- FIX: the mobile Operations floor app (a paired = ANONYMOUS device) could not
-- READ its venue's ops data, so nothing showed (no temp units, schedules,
-- checklists, deliveries, alerts), and its direct writes (checklist runs,
-- deliveries, maintenance) were blocked too.
--
-- WHY: every ops table's RLS used `location_id::text in (user_accessible_locations())`.
-- user_accessible_locations() reads user_locations / user_profiles for auth.uid() —
-- an anonymous paired tablet has NEITHER, so it returns {} and the device sees 0 rows.
-- (Writes via the SECURITY DEFINER RPC ops_submit_reading worked; everything else didn't.)
--
-- FIX: use the existing ops_can_write(location_id) = BO access OR a claimed ACTIVE device
-- for the floor-app-facing tables. BO access is preserved (ops_can_write is a superset);
-- this only ADDS a claimed device's access to its OWN venue's ops rows. Scope: ops_* only.
--   • READ for devices (BO still the only writer): temp_units, temp_check_schedules,
--     ops_checklists, ops_checklist_tasks, ops_alerts  → USING device-aware, WITH CHECK BO-only
--   • READ+WRITE for devices (floor app inserts/updates these directly): ops_checklist_runs,
--     ops_task_completions, deliveries, maintenance_requests → both device-aware
--   • temp_readings: device reads directly (writes go via the RPC) → SELECT device-aware
--   • ops_audit: device appends on checklist sign-off → SELECT + INSERT device-aware
-- Left BO-only (device never touches): maintenance_notes, maintenance_status_history,
-- corrective_actions, ops_notification_rules, ops_devices.
-- Idempotent.
-- ============================================================================

do $$
declare t text;
begin
  -- device READ, BO WRITE
  foreach t in array array['temp_units','temp_check_schedules','ops_checklists','ops_checklist_tasks','ops_alerts'] loop
    execute format('drop policy if exists %1$I_rls on public.%1$I;', t);
    execute format('create policy %1$I_rls on public.%1$I for all using (public.ops_can_write(location_id)) with check (location_id::text in (select public.user_accessible_locations()));', t);
  end loop;

  -- device READ + WRITE (floor app writes these directly)
  foreach t in array array['ops_checklist_runs','ops_task_completions','deliveries','maintenance_requests'] loop
    execute format('drop policy if exists %1$I_rls on public.%1$I;', t);
    execute format('create policy %1$I_rls on public.%1$I for all using (public.ops_can_write(location_id)) with check (public.ops_can_write(location_id));', t);
  end loop;
end $$;

-- temp_readings: device reads to compute today's status; inserts go through the RPC (definer)
drop policy if exists temp_readings_sel on public.temp_readings;
create policy temp_readings_sel on public.temp_readings for select using (public.ops_can_write(location_id));

-- ops_audit: device appends on checklist sign-off (direct insert); keep it readable to BO/device
drop policy if exists ops_audit_sel on public.ops_audit;
create policy ops_audit_sel on public.ops_audit for select using (public.ops_can_write(location_id));
drop policy if exists ops_audit_ins on public.ops_audit;
create policy ops_audit_ins on public.ops_audit for insert with check (public.ops_can_write(location_id));
