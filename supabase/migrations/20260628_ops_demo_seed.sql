-- ============================================================================
-- DEMO SEED for the Operations module (location 7218c716… — the demo venue).
-- Idempotent: each block is guarded by NOT EXISTS, so re-running does nothing.
-- To remove later: delete the rows named below (all are clearly demo content).
--   5 temperature units + schedules + today's readings
--   3 checklists (Opening / Closing / Cleaning) with full task lists
--   1 open maintenance request
--   1 alert rule (temperature breach → MOD, in-app + email)
-- ============================================================================

do $$
declare
  loc uuid := '7218c716-eeb4-4f96-b284-f3500823595c';
  u_fridge uuid; u_chiller uuid; u_freezer uuid; u_hot uuid; u_bain uuid;
  cl_open uuid; cl_close uuid; cl_clean uuid;
begin
  -- ── Temperature units + schedules + today's readings ──
  if not exists (select 1 from temp_units where location_id = loc and name = 'Walk-in fridge') then
    insert into temp_units (location_id, name, type, area, target_min_c, target_max_c, sort_order, guidance)
      values (loc, 'Walk-in fridge', 'fridge', 'Kitchen', 1, 4, 1, 'Probe between packs; keep the door shut 30s before reading.') returning id into u_fridge;
    insert into temp_units (location_id, name, type, area, target_min_c, target_max_c, sort_order, guidance)
      values (loc, 'Display chiller', 'cold_hold', 'Front', 1, 5, 2, 'Read the built-in probe; check the night blind is down out of hours.') returning id into u_chiller;
    insert into temp_units (location_id, name, type, area, target_min_c, target_max_c, sort_order, guidance)
      values (loc, 'Chest freezer', 'freezer', 'Store', -22, -18, 3, 'Read after the lid has been shut for a few minutes.') returning id into u_freezer;
    insert into temp_units (location_id, name, type, area, target_min_c, target_max_c, sort_order, guidance)
      values (loc, 'Hot hold — pass', 'hot_hold', 'Kitchen', 63, 90, 4, 'Core-probe the thickest item; discard if below 63°C for 2h+.') returning id into u_hot;
    insert into temp_units (location_id, name, type, area, target_min_c, target_max_c, sort_order, guidance)
      values (loc, 'Bain-marie', 'hot_hold', 'Front', 63, 90, 5, 'Stir before probing; top up with hot, not cold, product.') returning id into u_bain;

    insert into temp_check_schedules (location_id, temp_unit_id, label, time_of_day, grace_minutes) values
      (loc, u_fridge, 'AM', '06:00', 90), (loc, u_fridge, 'PM', '14:00', 90), (loc, u_fridge, 'Close', '22:00', 90),
      (loc, u_chiller, 'AM', '06:00', 90), (loc, u_chiller, 'PM', '14:00', 90), (loc, u_chiller, 'Close', '22:00', 90),
      (loc, u_freezer, 'AM', '06:00', 90), (loc, u_freezer, 'Close', '22:00', 90),
      (loc, u_hot, 'Lunch', '12:00', 60), (loc, u_hot, 'Dinner', '18:00', 60),
      (loc, u_bain, 'Lunch', '12:00', 60), (loc, u_bain, 'Dinner', '18:00', 60);

    insert into temp_readings (location_id, temp_unit_id, reading_c, in_range, severity, source, operator_name, recorded_at) values
      (loc, u_fridge, 3.2, true, 'none', 'manual', 'Priya', now() - interval '3 hours'),
      (loc, u_chiller, 4.1, true, 'none', 'manual', 'Priya', now() - interval '3 hours'),
      (loc, u_freezer, -19.4, true, 'none', 'manual', 'Priya', now() - interval '3 hours'),
      (loc, u_hot, 71, true, 'none', 'manual', 'Marco', now() - interval '1 hour'),
      (loc, u_bain, 68, true, 'none', 'manual', 'Marco', now() - interval '1 hour');
  end if;

  -- ── Checklists ──
  if not exists (select 1 from ops_checklists where location_id = loc and name = 'Opening checklist') then
    insert into ops_checklists (location_id, name, area, frequency, time_of_day, assignee_role)
      values (loc, 'Opening checklist', 'opening', 'daily', '07:00', 'Opening duty') returning id into cl_open;
    insert into ops_checklist_tasks (location_id, checklist_id, label, sort_order, task_type, evidence_required) values
      (loc, cl_open, 'Sanitise prep surfaces', 1, 'check', false),
      (loc, cl_open, 'Check fridge & freezer temps', 2, 'check', false),
      (loc, cl_open, 'Calibrate probe thermometer', 3, 'check', false),
      (loc, cl_open, 'Date-label opened stock', 4, 'check', false),
      (loc, cl_open, 'Photo: handwash station stocked', 5, 'photo', true),
      (loc, cl_open, 'Check first-aid & blue plasters', 6, 'check', false),
      (loc, cl_open, 'Run dishwasher hot cycle', 7, 'check', false),
      (loc, cl_open, 'Bin & waste check', 8, 'check', false);

    insert into ops_checklists (location_id, name, area, frequency, time_of_day, assignee_role)
      values (loc, 'Closing checklist', 'closing', 'daily', '22:00', 'Closing duty') returning id into cl_close;
    insert into ops_checklist_tasks (location_id, checklist_id, label, sort_order, task_type, evidence_required) values
      (loc, cl_close, 'Wipe down & sanitise all surfaces', 1, 'check', false),
      (loc, cl_close, 'Check & record fridge / freezer temps', 2, 'check', false),
      (loc, cl_close, 'Cover, date & store open food', 3, 'check', false),
      (loc, cl_close, 'Empty & sanitise bins', 4, 'check', false),
      (loc, cl_close, 'Clean down & switch off coffee machine', 5, 'check', false),
      (loc, cl_close, 'Sweep & mop floors', 6, 'check', false),
      (loc, cl_close, 'Cash up & secure float', 7, 'check', false),
      (loc, cl_close, 'Set alarm & lock up', 8, 'check', false);

    insert into ops_checklists (location_id, name, area, frequency, time_of_day, assignee_role)
      values (loc, 'Cleaning rota', 'cleaning', 'daily', null, 'Cleaner') returning id into cl_clean;
    insert into ops_checklist_tasks (location_id, checklist_id, label, sort_order, task_type, evidence_required) values
      (loc, cl_clean, 'Degrease extraction filters', 1, 'check', false),
      (loc, cl_clean, 'Clean & descale dishwasher', 2, 'check', false),
      (loc, cl_clean, 'Sanitise chopping boards & knives', 3, 'check', false),
      (loc, cl_clean, 'Clean fridge seals & handles', 4, 'check', false),
      (loc, cl_clean, 'Mop the walk-in floor', 5, 'check', false),
      (loc, cl_clean, 'Empty & sanitise the waste area', 6, 'photo', true);
  end if;

  -- ── An open maintenance request ──
  if not exists (select 1 from maintenance_requests where location_id = loc and title = 'Walk-in fridge door seal worn') then
    insert into maintenance_requests (location_id, title, description, priority, status, reporter_name, source)
      values (loc, 'Walk-in fridge door seal worn', 'Door not sealing fully on the left side — temps creeping up by close. Needs an engineer.', 'high', 'open', 'Priya', 'manual');
  end if;

  -- ── A notification rule: temperature breach → MOD (in-app + email), escalate after 15m ──
  if not exists (select 1 from ops_notification_rules where location_id = loc and event_type = 'temp_breach') then
    insert into ops_notification_rules (location_id, event_type, severity_min, channels, recipients, escalate_after_min)
      values (loc, 'temp_breach', 'major', '["inapp","email"]'::jsonb, '[{"role":"MOD"}]'::jsonb, 15);
  end if;
end $$;
