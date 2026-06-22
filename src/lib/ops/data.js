/**
 * ops/data.js — Supabase data layer for the Operations module.
 *
 * House pattern (mirrors src/lib/stock/data.js): resolve a real locationId, map
 * camelCase ↔ snake_case, return { data, error }. Safety-critical writes (readings,
 * breaches) go through the SECURITY DEFINER RPC `ops_submit_reading` so a paired
 * (anonymous) tablet can submit and the breach→corrective→maintenance→alert chain
 * is atomic. The Deliveries gate reuses the existing stock receiving flow.
 */

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { fetchPurchaseOrders, receivePurchaseOrder } from '../stock/purchasing.js';

const nowIso = () => new Date().toISOString();
async function ensureLoc(locationId) {
  if (!locationId || locationId === 'loc-demo') locationId = getActiveLocationSync();
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return null;
  return locationId;
}

// ── mappers ──────────────────────────────────────────────────────────────────
const unitFromRow = (r) => ({
  id: r.id, locationId: r.location_id, name: r.name, type: r.type, area: r.area,
  targetMinC: r.target_min_c == null ? null : Number(r.target_min_c),
  targetMaxC: r.target_max_c == null ? null : Number(r.target_max_c),
  displayUnit: r.display_unit || 'C', guidance: r.guidance, sortOrder: r.sort_order,
  active: r.active !== false, archivedAt: r.archived_at,
});
const unitToRow = (u, locationId) => ({
  ...(u.id ? { id: u.id } : {}),
  location_id: locationId, org_id: u.orgId || null, name: (u.name || '').trim(), type: u.type || 'fridge',
  area: u.area || null, target_min_c: u.targetMinC ?? null, target_max_c: u.targetMaxC ?? null,
  display_unit: u.displayUnit || 'C', guidance: u.guidance || null, sort_order: u.sortOrder || 0,
  active: u.active !== false, updated_at: nowIso(),
});
const schedFromRow = (r) => ({
  id: r.id, locationId: r.location_id, tempUnitId: r.temp_unit_id, label: r.label,
  frequency: r.frequency, daysOfWeek: Array.isArray(r.days_of_week) ? r.days_of_week : [],
  timeOfDay: r.time_of_day, graceMinutes: r.grace_minutes, active: r.active !== false,
});
const schedToRow = (s, locationId) => ({
  ...(s.id ? { id: s.id } : {}),
  location_id: locationId, temp_unit_id: s.tempUnitId, label: s.label || null, frequency: s.frequency || 'daily',
  days_of_week: Array.isArray(s.daysOfWeek) ? s.daysOfWeek : [], time_of_day: s.timeOfDay,
  grace_minutes: s.graceMinutes ?? 60, active: s.active !== false,
});
const readingFromRow = (r) => ({
  id: r.id, locationId: r.location_id, tempUnitId: r.temp_unit_id, scheduleId: r.schedule_id,
  readingC: Number(r.reading_c), inRange: r.in_range, severity: r.severity, source: r.source,
  operatorId: r.operator_id, operatorName: r.operator_name, notes: r.notes, recordedAt: r.recorded_at,
});
const correctiveFromRow = (r) => ({
  id: r.id, locationId: r.location_id, sourceType: r.source_type, sourceId: r.source_id, severity: r.severity,
  action: r.action, description: r.description, operatorName: r.operator_name,
  maintenanceRequestId: r.maintenance_request_id, status: r.status, createdAt: r.created_at,
});
const maintFromRow = (r) => ({
  id: r.id, locationId: r.location_id, title: r.title, description: r.description, assetType: r.asset_type,
  assetId: r.asset_id, priority: r.priority, status: r.status, reporterName: r.reporter_name,
  assigneeId: r.assignee_id, assigneeName: r.assignee_name, source: r.source, photoUrl: r.photo_url,
  createdAt: r.created_at, updatedAt: r.updated_at, resolvedAt: r.resolved_at,
});
const alertFromRow = (r) => ({
  id: r.id, locationId: r.location_id, type: r.type, severity: r.severity, title: r.title, body: r.body,
  sourceType: r.source_type, sourceId: r.source_id, targetRole: r.target_role, status: r.status,
  escalationStep: r.escalation_step, acknowledgedByName: r.acknowledged_by_name, acknowledgedAt: r.acknowledged_at,
  actionTaken: r.action_taken, createdAt: r.created_at,
});
const deliveryFromRow = (r) => ({
  id: r.id, locationId: r.location_id, poId: r.po_id, supplierId: r.supplier_id, status: r.status,
  temperatureC: r.temperature_c == null ? null : Number(r.temperature_c), inRange: r.in_range,
  checkedByName: r.checked_by_name, checkedAt: r.checked_at, rejectionReason: r.rejection_reason,
  receivedAt: r.received_at, createdAt: r.created_at,
});

// ── paired tablet + PIN ──────────────────────────────────────────────────────
export const opsRegisterDevice = async (name) => {
  if (isMock || !supabase) return { data: null, error: null };
  return rpc('register_ops_device', { p_name: name || null });
};
export const opsHeartbeat = async () => rpc('ops_device_heartbeat', {});
export const opsClaimDevice = async (code, locationId) => rpc('claim_ops_device', { p_code: code, p_location_id: locationId });
export const opsPinLogin = async (locationId, pin) => rpc('ops_pin_login', { p_location_id: locationId, p_pin: String(pin) });
async function rpc(fn, args) {
  if (isMock || !supabase) return { data: null, error: null };
  const { data, error } = await supabase.rpc(fn, args);
  return { data, error };
}

// ── temperature units (admin config = source of truth) ───────────────────────
export const fetchTempUnits = async (locationId = null, includeArchived = false) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  let q = supabase.from('temp_units').select('*').eq('location_id', locationId).order('sort_order').order('name');
  if (!includeArchived) q = q.is('archived_at', null);
  const { data, error } = await q;
  return { data: (data || []).map(unitFromRow), error };
};
export const upsertTempUnit = async (unit, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const { data, error } = await supabase.from('temp_units').upsert(unitToRow(unit, locationId)).select().maybeSingle();
  return { data: data ? unitFromRow(data) : null, error };
};
export const archiveTempUnit = async (id, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  return supabase.from('temp_units').update({ archived_at: nowIso() }).eq('location_id', locationId).eq('id', id);
};

// ── schedules ────────────────────────────────────────────────────────────────
export const fetchSchedules = async (locationId = null) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  const { data, error } = await supabase.from('temp_check_schedules').select('*').eq('location_id', locationId).eq('active', true);
  return { data: (data || []).map(schedFromRow), error };
};
export const upsertSchedule = async (sched, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const { data, error } = await supabase.from('temp_check_schedules').upsert(schedToRow(sched, locationId)).select().maybeSingle();
  return { data: data ? schedFromRow(data) : null, error };
};
export const deleteSchedule = async (id, locationId = null) => {
  locationId = await ensureLoc(locationId);
  return supabase.from('temp_check_schedules').delete().eq('location_id', locationId).eq('id', id);
};

// ── readings (via the breach-atomic RPC) ─────────────────────────────────────
/** Submit a temperature reading. Returns { data:{readingId,inRange,severity,...}, error }.
 *  On a breach the RPC REQUIRES corrective.action or it rejects. */
export const submitReading = async ({ unitId, readingC, scheduleId, operatorId, operatorName, source, notes, corrective, deliveryId }, locationId = null) => {
  if (isMock || !supabase) return { data: { inRange: true }, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const { data, error } = await supabase.rpc('ops_submit_reading', {
    p_location_id: locationId, p_unit_id: unitId, p_reading_c: Number(readingC),
    p_schedule_id: scheduleId || null, p_operator_id: operatorId || null, p_operator_name: operatorName || null,
    p_source: source || 'manual', p_notes: notes || null,
    p_corrective_action: corrective?.action || null, p_corrective_desc: corrective?.description || null,
    p_delivery_id: deliveryId || null,
  });
  if (error) return { data: null, error };
  return {
    data: { readingId: data?.reading_id, inRange: data?.in_range, severity: data?.severity,
      correctiveId: data?.corrective_id, maintenanceId: data?.maintenance_id, alertId: data?.alert_id },
    error: null,
  };
};
export const fetchReadings = async (fromIso, toIso, locationId = null, limit = 2000) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  let q = supabase.from('temp_readings').select('*').eq('location_id', locationId);
  if (fromIso) q = q.gte('recorded_at', fromIso);
  if (toIso) q = q.lte('recorded_at', toIso);
  const { data, error } = await q.order('recorded_at', { ascending: false }).limit(limit);
  return { data: (data || []).map(readingFromRow), error };
};

// ── corrective actions / maintenance / alerts ────────────────────────────────
export const fetchCorrectiveActions = async (fromIso, toIso, locationId = null) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  let q = supabase.from('corrective_actions').select('*').eq('location_id', locationId);
  if (fromIso) q = q.gte('created_at', fromIso);
  if (toIso) q = q.lte('created_at', toIso);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(1000);
  return { data: (data || []).map(correctiveFromRow), error };
};
export const fetchMaintenance = async (locationId = null, status = null) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  let q = supabase.from('maintenance_requests').select('*').eq('location_id', locationId);
  if (status) q = q.eq('status', status);
  const { data, error } = await q.order('created_at', { ascending: false }).limit(500);
  return { data: (data || []).map(maintFromRow), error };
};
export const createMaintenance = async (m, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const { data, error } = await supabase.from('maintenance_requests').insert({
    location_id: locationId, title: (m.title || '').trim(), description: m.description || null,
    asset_type: m.assetType || null, asset_id: m.assetId || null, priority: m.priority || 'normal',
    status: 'open', reporter_id: m.reporterId || null, reporter_name: m.reporterName || null,
    source: m.source || 'manual', photo_url: m.photoUrl || null,
  }).select().maybeSingle();
  return { data: data ? maintFromRow(data) : null, error };
};
export const setMaintenanceStatus = async (id, status, who, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  const patch = { status, updated_at: nowIso() };
  if (status === 'resolved') patch.resolved_at = nowIso();
  const { data: prev } = await supabase.from('maintenance_requests').select('status').eq('id', id).maybeSingle();
  const { error } = await supabase.from('maintenance_requests').update(patch).eq('location_id', locationId).eq('id', id);
  if (!error) await supabase.from('maintenance_status_history').insert({ location_id: locationId, request_id: id, from_status: prev?.status || null, to_status: status, changed_by_name: who || null });
  return { error };
};
export const addMaintenanceNote = async (id, note, who, locationId = null) => {
  locationId = await ensureLoc(locationId);
  return supabase.from('maintenance_notes').insert({ location_id: locationId, request_id: id, note, author_name: who || null });
};
export const fetchAlerts = async (locationId = null, openOnly = false) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  let q = supabase.from('ops_alerts').select('*').eq('location_id', locationId);
  if (openOnly) q = q.eq('status', 'sent');
  const { data, error } = await q.order('created_at', { ascending: false }).limit(200);
  return { data: (data || []).map(alertFromRow), error };
};
export const ackAlert = async (alertId, action, who) => rpc('ops_ack_alert', { p_alert_id: alertId, p_action: action || null, p_user_name: who || null });

// ── Deliveries gate (ties into stock ordering) ───────────────────────────────
/** Open POs awaiting goods-in (SENT/PARTIAL), with any existing delivery record. */
export const fetchExpectedDeliveries = async (locationId = null) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  const [{ data: pos }, { data: dels }] = await Promise.all([
    fetchPurchaseOrders(locationId),
    supabase.from('deliveries').select('*').eq('location_id', locationId).order('created_at', { ascending: false }).limit(500),
  ]);
  const delByPo = {}; (dels || []).forEach((d) => { if (d.po_id && !delByPo[d.po_id]) delByPo[d.po_id] = deliveryFromRow(d); });
  const open = (pos || []).filter((p) => ['SENT', 'PARTIAL'].includes(p.status));
  return { data: open.map((po) => ({ po, delivery: delByPo[po.id] || null })), error: null };
};

/** Record a delivery temperature, log the reading (breach handled by submitReading),
 *  and set the delivery to accepted/rejected. On accept, receive the PO into stock. */
export const checkDelivery = async ({ poId, supplierId, deliveryUnitId, temperatureC, accept, operatorId, operatorName, corrective, rejectionReason }, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };

  // delivery record first (so the reading can link to it)
  const { data: del, error: dErr } = await supabase.from('deliveries').insert({
    location_id: locationId, po_id: poId || null, supplier_id: supplierId || null,
    temperature_c: temperatureC == null ? null : Number(temperatureC), checked_by: operatorId || null,
    checked_by_name: operatorName || null, checked_at: nowIso(), status: 'pending',
  }).select().maybeSingle();
  if (dErr || !del) return { data: null, error: dErr || new Error('Could not start delivery') };

  // temperature reading against the delivery probe unit (breach → corrective/alert in the RPC)
  let readingRes = { data: { inRange: true } };
  if (deliveryUnitId && temperatureC != null) {
    readingRes = await submitReading({
      unitId: deliveryUnitId, readingC: temperatureC, source: 'delivery', operatorId, operatorName,
      corrective, deliveryId: del.id,
    }, locationId);
    if (readingRes.error) return { data: null, error: readingRes.error };
  }

  if (accept) {
    const { error: rErr } = await receivePurchaseOrder(poId, locationId);   // existing stock receive
    if (rErr) return { data: null, error: rErr };
    await supabase.from('deliveries').update({ status: 'accepted', in_range: readingRes.data?.inRange ?? true, received_at: nowIso() }).eq('id', del.id);
    return { data: { deliveryId: del.id, status: 'accepted' }, error: null };
  }
  // reject: no stock movement is ever posted
  await supabase.from('deliveries').update({ status: 'rejected', in_range: readingRes.data?.inRange ?? false, rejection_reason: rejectionReason || 'Out of temperature range' }).eq('id', del.id);
  return { data: { deliveryId: del.id, status: 'rejected' }, error: null };
};
