-- 20260624b_operations_rpcs.sql
-- Operations RPCs: paired-tablet lifecycle (register/claim/heartbeat/PIN login) and the
-- COMPLIANCE BACKBONE — ops_submit_reading — which logs a temperature, computes in-range
-- server-side against the unit's authored band, and on a breach atomically forces a
-- corrective action, auto-raises maintenance (major/critical), alerts the duty manager,
-- and writes the append-only audit trail. SECURITY DEFINER so a paired (anonymous) tablet
-- can write, but every call is fenced to a location the caller can access OR a claimed device.

-- caller is allowed at this location if they have BO access OR a claimed ops_device for it
create or replace function public.ops_can_write(p_location_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from user_accessible_locations() where location_id = p_location_id)
      or exists (select 1 from ops_devices d where d.device_uid = auth.uid() and d.location_id = p_location_id and d.active);
$$;

-- ── Paired tablet lifecycle ──────────────────────────────────────────────────
create or replace function public.register_ops_device(p_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v ops_devices; v_code text;
begin
  select * into v from ops_devices where device_uid = auth.uid() limit 1;
  if found then return jsonb_build_object('id', v.id, 'claim_code', v.claim_code, 'location_id', v.location_id); end if;
  v_code := upper(substr(translate(encode(gen_random_bytes(6),'base64'), '/+=O0Il', 'XYZ'), 1, 6));
  insert into ops_devices (device_uid, name, claim_code, last_seen_at)
    values (auth.uid(), coalesce(p_name,'Ops tablet'), v_code, now()) returning * into v;
  return jsonb_build_object('id', v.id, 'claim_code', v.claim_code, 'location_id', v.location_id);
end $$;

create or replace function public.claim_ops_device(p_code text, p_location_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v ops_devices; v_org uuid;
begin
  if not exists (select 1 from user_accessible_locations() where location_id = p_location_id) then
    raise exception 'not authorized for this location';
  end if;
  select org_id into v_org from locations where id = p_location_id;
  update ops_devices set location_id = p_location_id, org_id = v_org, claimed_at = now()
    where claim_code = p_code and (location_id is null or location_id = p_location_id) returning * into v;
  if not found then raise exception 'code not found'; end if;
  return jsonb_build_object('id', v.id, 'location_id', v.location_id);
end $$;

create or replace function public.ops_device_heartbeat()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v ops_devices;
begin
  update ops_devices set last_seen_at = now() where device_uid = auth.uid() returning * into v;
  if not found then return jsonb_build_object('claimed', false); end if;
  return jsonb_build_object('claimed', v.location_id is not null, 'location_id', v.location_id, 'name', v.name);
end $$;

-- staff PIN → identity (PINs never reach the client); fenced to a location the device is claimed to.
create or replace function public.ops_pin_login(p_location_id uuid, p_pin text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v record;
begin
  if not public.ops_can_write(p_location_id) then raise exception 'not authorized for this location'; end if;
  select id, name, role, permissions into v from staff_members
    where location_id = p_location_id and pin = p_pin and coalesce(active, true) = true limit 1;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'id', v.id, 'name', v.name, 'role', v.role, 'permissions', v.permissions);
end $$;

-- ── Compliance backbone: submit a reading (handles breach atomically) ─────────
create or replace function public.ops_submit_reading(
  p_location_id uuid, p_unit_id uuid, p_reading_c numeric,
  p_schedule_id uuid default null, p_operator_id uuid default null, p_operator_name text default null,
  p_source text default 'manual', p_notes text default null,
  p_corrective_action text default null, p_corrective_desc text default null, p_delivery_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  u temp_units; v_org uuid; v_in_range boolean; v_sev text; v_delta numeric;
  v_reading_id uuid; v_corr_id uuid := null; v_maint_id uuid := null; v_alert_id uuid := null;
begin
  if not public.ops_can_write(p_location_id) then raise exception 'not authorized for this location'; end if;
  select * into u from temp_units where id = p_unit_id and location_id = p_location_id;
  if not found then raise exception 'unknown unit'; end if;
  v_org := u.org_id;

  v_in_range := (u.target_min_c is null or p_reading_c >= u.target_min_c)
            and (u.target_max_c is null or p_reading_c <= u.target_max_c);
  if v_in_range then v_sev := 'none';
  elsif u.type = 'freezer' and p_reading_c > -15 then v_sev := 'critical';
  elsif u.type in ('hot_hold','cooking') and p_reading_c < 63 then v_sev := 'critical';
  else
    v_delta := greatest(
      case when u.target_max_c is not null and p_reading_c > u.target_max_c then p_reading_c - u.target_max_c else 0 end,
      case when u.target_min_c is not null and p_reading_c < u.target_min_c then u.target_min_c - p_reading_c else 0 end);
    v_sev := case when v_delta >= 2 then 'major' else 'minor' end;
  end if;

  -- HARD STOP: a breach cannot be saved without a corrective action.
  if not v_in_range and (p_corrective_action is null or btrim(p_corrective_action) = '') then
    raise exception 'corrective action required for out-of-range reading';
  end if;

  insert into temp_readings (location_id, org_id, temp_unit_id, schedule_id, reading_c, in_range, severity,
      source, operator_id, operator_name, device_id, notes)
    values (p_location_id, v_org, p_unit_id, p_schedule_id, p_reading_c, v_in_range, v_sev,
      coalesce(p_source,'manual'), p_operator_id, p_operator_name, null, p_notes)
    returning id into v_reading_id;

  if not v_in_range then
    insert into corrective_actions (location_id, org_id, source_type, source_id, severity, action, description,
        operator_id, operator_name, status, closed_at)
      values (p_location_id, v_org, case when p_delivery_id is not null then 'delivery' else 'temp_reading' end,
        coalesce(p_delivery_id, v_reading_id), v_sev, p_corrective_action, p_corrective_desc,
        p_operator_id, p_operator_name, 'closed', now())
      returning id into v_corr_id;

    if v_sev in ('major','critical') then
      insert into maintenance_requests (location_id, org_id, title, description, asset_type, asset_id,
          priority, status, reporter_id, reporter_name, source, source_ref)
        values (p_location_id, v_org, u.name || ' — out of safe range',
          'Auto-raised from a ' || v_sev || ' temperature breach (' || p_reading_c || '°C).',
          'temp_unit', p_unit_id, case when v_sev = 'critical' then 'urgent' else 'high' end,
          'open', p_operator_id, p_operator_name, 'temp_breach', v_reading_id)
        returning id into v_maint_id;
      update corrective_actions set maintenance_request_id = v_maint_id where id = v_corr_id;
    end if;

    -- Nothing red passes silently: always alert the duty manager on a breach.
    insert into ops_alerts (location_id, org_id, type, severity, title, body, source_type, source_id, target_role)
      values (p_location_id, v_org, 'temp_breach', v_sev,
        u.name || ' breach · ' || p_reading_c || '°C',
        'Corrective: ' || coalesce(p_corrective_action,'—') || coalesce(' · ' || p_operator_name, ''),
        'temp_reading', v_reading_id, 'MOD')
      returning id into v_alert_id;

    if p_delivery_id is not null then
      update deliveries set corrective_action_id = v_corr_id where id = p_delivery_id and location_id = p_location_id;
    end if;
  end if;

  insert into ops_audit (location_id, actor_id, actor_name, action, entity_type, entity_id, payload)
    values (p_location_id, coalesce(p_operator_id, auth.uid()), p_operator_name, 'temp_reading', 'temp_reading', v_reading_id,
      jsonb_build_object('unit', u.name, 'reading_c', p_reading_c, 'in_range', v_in_range, 'severity', v_sev,
        'corrective', p_corrective_action, 'maintenance_id', v_maint_id));

  return jsonb_build_object('reading_id', v_reading_id, 'in_range', v_in_range, 'severity', v_sev,
    'corrective_id', v_corr_id, 'maintenance_id', v_maint_id, 'alert_id', v_alert_id);
end $$;

-- ── Manager acknowledges an alert ────────────────────────────────────────────
create or replace function public.ops_ack_alert(p_alert_id uuid, p_action text default null, p_user_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a ops_alerts;
begin
  select * into a from ops_alerts where id = p_alert_id;
  if not found then raise exception 'alert not found'; end if;
  if not public.ops_can_write(a.location_id) then raise exception 'not authorized'; end if;
  update ops_alerts set status = 'acknowledged', acknowledged_by = auth.uid(), acknowledged_by_name = p_user_name,
    acknowledged_at = now(), action_taken = p_action where id = p_alert_id;
  return jsonb_build_object('ok', true);
end $$;

grant execute on function public.ops_can_write(uuid)                                            to authenticated, anon;
grant execute on function public.register_ops_device(text)                                      to authenticated, anon;
grant execute on function public.claim_ops_device(text, uuid)                                   to authenticated;
grant execute on function public.ops_device_heartbeat()                                         to authenticated, anon;
grant execute on function public.ops_pin_login(uuid, text)                                      to authenticated, anon;
grant execute on function public.ops_submit_reading(uuid, uuid, numeric, uuid, uuid, text, text, text, text, text, uuid) to authenticated, anon;
grant execute on function public.ops_ack_alert(uuid, text, text)                                to authenticated, anon;
