// src/staff/wfData.js
//
// Workforce data-access layer — the real persistence for the Workforce module.
// Reads/writes the location-fenced wf_* tables on the Ops DB (see
// supabase/migrations/20260608_workforce.sql). Everything is scoped to the
// Back Office's selected location; there is no per-module venue switcher.
//
// Tenant fence: wf_staff is ORG-scoped under RLS, but the Workforce UI is
// per-LOCATION, so reads filter by location_id and writes stamp both
// location_id (home venue) + org_id. org_id is resolved from the locations
// table so the (location_id, org_id) pair always satisfies the composite FK.
//
// Mock/local-dev (isMock, no Supabase) falls back to localStorage so the flow
// is still testable without a backend. Production always hits Supabase.

import { supabase, isMock } from '../lib/supabase';

const LS_KEY = 'rpos-wf-staff';
const orgCache = {}; // locationId -> org_id (avoids re-querying locations)

// ── localStorage fallback (mock only) ───────────────────────────────────────
function lsGet() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); } catch { return []; } }
function lsSet(a) { try { localStorage.setItem(LS_KEY, JSON.stringify(a)); } catch { /* ignore */ } }

// ── snake_case row → camelCase UI shape ─────────────────────────────────────
function mapStaffRow(r) {
  return {
    id: r.id,
    name: r.name,
    role: r.role_key,
    contractType: r.contract_type,
    mobile: r.mobile,
    email: r.email,
    dob: r.dob,
    startDate: r.start_date,
    status: r.status,
    posUserId: r.pos_user_id,
    posRole: r.pos_role || null,           // UI-only convenience (not a column)
    sectionIds: Array.isArray(r.section_ids) ? r.section_ids : [],
    rateOverride: r.rate_override,
    contractedWeek: r.contracted_week,
    days: {},                              // rota assignment lives in wf_shifts
  };
}

/** Resolve the canonical org_id for a location (cached). Guarantees the
 *  (location_id, org_id) pair matches the locations composite FK. */
export async function resolveOrgForLocation(locationId, fallbackOrgId) {
  if (!locationId) return fallbackOrgId || null;
  if (orgCache[locationId]) return orgCache[locationId];
  if (isMock || !supabase) return fallbackOrgId || null;
  try {
    const { data } = await supabase.from('locations').select('org_id').eq('id', locationId).single();
    const org = data?.org_id || fallbackOrgId || null;
    if (org) orgCache[locationId] = org;
    return org;
  } catch { return fallbackOrgId || null; }
}

/** Load active (non-leaver) staff for a location, newest-last. */
export async function loadStaff(locationId) {
  if (isMock || !supabase) return lsGet();
  if (!locationId) return [];
  const { data, error } = await supabase
    .from('wf_staff')
    .select('id,name,role_key,contract_type,mobile,email,dob,start_date,status,pos_user_id,section_ids,rate_override,contracted_week,created_at')
    .eq('location_id', locationId)
    .neq('status', 'leaver')
    .order('created_at', { ascending: true });
  if (error) { console.warn('[wf] loadStaff:', error.message); return []; }
  return (data || []).map(mapStaffRow);
}

/** Insert (or update if it carries a real id) a staff HR record. Returns the
 *  canonical mapped row (with the DB-generated id). Throws on DB error so the
 *  caller can roll back the optimistic row + surface a toast. */
export async function saveStaff(member, locationId, orgId) {
  if (isMock || !supabase) {
    const id = member.id && !String(member.id).startsWith('tmp-') ? member.id : `wf-${Date.now()}`;
    const rows = lsGet();
    const next = { ...member, id, status: member.status || 'active' };
    const i = rows.findIndex(r => r.id === id);
    if (i >= 0) rows[i] = { ...rows[i], ...next }; else rows.push(next);
    lsSet(rows);
    return next;
  }
  if (!locationId) throw new Error('No location selected');
  const org = await resolveOrgForLocation(locationId, orgId);
  const row = {
    location_id: locationId,
    org_id: org,
    name: member.name,
    role_key: member.role || null,
    contract_type: member.contractType || 'partTime',
    mobile: member.mobile || null,
    email: member.email || null,
    dob: member.dob || null,
    start_date: member.startDate || null,
    primary_venue_id: locationId,
    venue_ids: [locationId],
    status: member.status || 'active',
  };
  const hasRealId = member.id && !String(member.id).startsWith('tmp-') && !String(member.id).startsWith('wf-');
  if (hasRealId) row.id = member.id;
  const q = hasRealId
    ? supabase.from('wf_staff').upsert(row, { onConflict: 'id' })
    : supabase.from('wf_staff').insert(row);
  const { data, error } = await q.select().single();
  if (error) { console.warn('[wf] saveStaff:', error.message); throw new Error(error.message); }
  return mapStaffRow(data);
}

/** Soft-delete: mark as leaver (pay/compliance history is preserved, never hard-deleted). */
export async function softDeleteStaff(id) {
  if (isMock || !supabase) { lsSet(lsGet().filter(r => r.id !== id)); return; }
  if (!id) return;
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.from('wf_staff').update({ status: 'leaver', leaver_date: today }).eq('id', id);
  if (error) console.warn('[wf] softDeleteStaff:', error.message);
}

/** Link the HR record to its POS system user (staff_members.id) after "Set as POS user". */
export async function markPosUser(staffId, posUserId) {
  if (isMock || !supabase) {
    const rows = lsGet();
    const i = rows.findIndex(r => r.id === staffId);
    if (i >= 0) { rows[i] = { ...rows[i], posUserId }; lsSet(rows); }
    return;
  }
  if (!staffId) return;
  const { error } = await supabase.from('wf_staff').update({ pos_user_id: posUserId }).eq('id', staffId);
  if (error) console.warn('[wf] markPosUser:', error.message);
}
