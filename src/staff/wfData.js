// src/staff/wfData.js
//
// Workforce data-access layer — the real persistence for the Workforce module.
// Reads/writes the location-fenced wf_* tables on the Ops DB (see
// supabase/migrations/20260608_workforce.sql). Everything is scoped to the
// Back Office's selected location; there is no per-module venue switcher.
//
// Tenant fence: wf_staff is ORG-scoped under RLS; everything else is
// LOCATION-scoped. Writes always stamp location_id + org_id, where org_id is
// resolved from the locations table so the (location_id, org_id) pair satisfies
// the composite FK. Pay-critical maths (tronc / pay / accrual) is computed
// SERVER-SIDE via the workforce-compute edge function — never trust the client.
//
// Mock/local-dev (isMock, no Supabase) falls back to localStorage per table so
// every flow is testable without a backend. Production always hits Supabase.

import { supabase, isMock } from '../lib/supabase';
import { ROLES as SEED_ROLES } from './seed';

const orgCache = {};

// ── localStorage mock layer ─────────────────────────────────────────────────
const lsKey = t => `rpos-wf-${t}`;
const lsGet = t => { try { return JSON.parse(localStorage.getItem(lsKey(t)) || '[]'); } catch { return []; } };
const lsSet = (t, a) => { try { localStorage.setItem(lsKey(t), JSON.stringify(a)); } catch { /* ignore */ } };
const newId = () => `wf-${Date.now()}-${Math.floor(Math.random() * 1e5)}`;
function lsUpsert(t, obj) {
  const a = lsGet(t);
  const id = obj.id && !String(obj.id).startsWith('tmp-') ? obj.id : newId();
  const o = { ...obj, id };
  const i = a.findIndex(x => x.id === id);
  if (i >= 0) a[i] = { ...a[i], ...o }; else a.push(o);
  lsSet(t, a);
  return o;
}
const lsDelete = (t, id) => lsSet(t, lsGet(t).filter(x => x.id !== id));

// ── shared helpers ──────────────────────────────────────────────────────────
async function authToken() {
  try { const { data } = await supabase.auth.getSession(); return data?.session?.access_token || null; }
  catch { return null; }
}

/** Resolve canonical org_id for a location (cached) so (location_id, org_id) is FK-valid. */
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

/** Invoke a Supabase edge function via the SDK (handles apikey + session auth)
 *  and surface the function's own {error} message rather than a generic one. */
async function invokeFn(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let msg = error.message || 'Request failed';
    try { const b = await error.context?.json?.(); if (b?.error) msg = b.error; } catch { /* keep generic */ }
    throw new Error(msg);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

/** Call the server-side compute edge function (tronc / pay / accrual / labour). */
export async function invokeCompute(action, payload = {}) {
  if (isMock || !supabase) return { ok: true, mock: true, action };
  return invokeFn('workforce-compute', { action, ...payload });
}

// ── Document storage (private bucket wf-documents; path = locationId/staffId/…) ──
const DOCS_BUCKET = 'wf-documents';
export async function uploadWfDocument(file, locationId, staffId, type) {
  if (isMock || !supabase || !locationId) return { path: null, name: file?.name || null };
  const ext = (String(file.name).split('.').pop() || 'pdf').toLowerCase().replace(/[^a-z0-9]/g, '');
  const safeType = String(type || 'doc').replace(/[^a-z0-9]/gi, '');
  const path = `${locationId}/${staffId || 'general'}/${safeType}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(DOCS_BUCKET).upload(path, file, { upsert: false, contentType: file.type });
  if (error) throw new Error(error.message);
  return { path, name: file.name };
}
/** Resolve a short-lived signed URL for a stored document path (or pass through a legacy full URL). */
export async function signedDocUrl(pathOrUrl, expiresIn = 120) {
  if (!pathOrUrl) return null;
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl; // legacy file_url
  if (isMock || !supabase) return null;
  const { data, error } = await supabase.storage.from(DOCS_BUCKET).createSignedUrl(pathOrUrl, expiresIn);
  if (error) { console.warn('[wf] signedDocUrl:', error.message); return null; }
  return data?.signedUrl || null;
}

/** Normalise a phone number to E.164 (UK-default). send-sms requires +44… and
 *  rejects local 07… numbers with a 400, so we convert before sending.
 *  07931129015 → +447931129015 · 00447… → +447… · already-+44 passes through. */
export function toE164(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/[\s()\-.]/g, '');
  if (s.startsWith('+')) return /^\+[1-9]\d{6,14}$/.test(s) ? s : null;
  if (s.startsWith('00')) s = '+' + s.slice(2);
  else if (s.startsWith('0')) s = '+44' + s.slice(1);   // UK local 07…/01… → +44…
  else if (s.startsWith('44')) s = '+' + s;
  else if (/^[1-9]\d{6,14}$/.test(s)) s = '+44' + s;    // bare national, no leading 0
  return /^\+[1-9]\d{6,14}$/.test(s) ? s : null;
}

/** Send one SMS via the send-sms edge function. Throws on failure; no-op in mock. */
export async function sendStaffSms(to, message, locationId, type = 'rota_notification', referenceId = null) {
  if (isMock || !supabase) return { ok: true, mock: true };
  const phone = toE164(to);
  if (!phone) return { ok: false, skipped: 'no-mobile' };
  const data = await invokeFn('send-sms', { to: phone, message, location_id: locationId, type, reference_id: referenceId });
  return { ok: true, ...(data || {}) };
}

/** Send a transactional email via the send-receipt edge function (generic html). */
export async function sendEmail(to, subject, html, locationId) {
  if (isMock || !supabase) return { ok: true, mock: true };
  if (!to) throw new Error('No email address on file for this person');
  const data = await invokeFn('send-receipt', { location_id: locationId, to, subject, html, text: html.replace(/<[^>]+>/g, ' ') });
  return { ok: true, ...(data || {}) };
}

/** Store bank details on the staff record — MASKED ONLY (sort code + last 4). */
export async function saveStaffBank(staffId, sortCode, accountFull) {
  const digits = String(accountFull || '').replace(/\D/g, '');
  const masked = digits.length >= 4 ? `****${digits.slice(-4)}` : null;
  const sort = String(sortCode || '').replace(/[^0-9]/g, '').replace(/(\d{2})(\d{2})(\d{2})/, '$1-$2-$3') || null;
  if (isMock || !supabase) { const a = lsGet('staff'); const i = a.findIndex(x => x.id === staffId); if (i >= 0) { a[i].bankMasked = masked; a[i].bankAccount = digits; a[i].bankSortCode = sort; lsSet('staff', a); } return { masked, sort, account: digits }; }
  if (!staffId || !masked) throw new Error('Enter a valid sort code + account number');
  // Full account is stored (org-RLS-fenced) so staff can actually be paid via BACS;
  // masked is kept for compact display.
  const { error } = await supabase.from('wf_staff').update({ bank_sort_code: sort, bank_account: digits, bank_account_masked: masked }).eq('id', staffId);
  if (error) throw new Error(error.message);
  return { masked, sort, account: digits };
}

/** Call the Claude proxy (/api/ai). Returns the Anthropic Messages response. */
export async function callAI(messages, mode = 'boh') {
  if (isMock) throw new Error('AI is only available on the live system');
  const res = await fetch('/api/ai', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, mode }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || 'AI request failed');
  return j;
}

// ============================================================================
// STAFF (wf_staff — org-scoped PII; Workforce shows the current location's staff)
// ============================================================================
function mapStaff(r) {
  return {
    id: r.id, name: r.name, role: r.role_key, contractType: r.contract_type,
    mobile: r.mobile, email: r.email, dob: r.dob, startDate: r.start_date,
    status: r.status, posUserId: r.pos_user_id, sectionIds: r.section_ids || [],
    rateOverride: r.rate_override, contractedWeek: r.contracted_week,
    weeklyHoursTarget: r.weekly_hours_target != null ? Number(r.weekly_hours_target) : null,
    holidayEntitlementDays: r.holiday_entitlement_days != null ? Number(r.holiday_entitlement_days) : null,
    address: r.address || null, emergencyContact: r.emergency_contact || null,
    bankSortCode: r.bank_sort_code || null, bankAccount: r.bank_account || null, bankMasked: r.bank_account_masked || null,
    days: {},
  };
}
export async function loadStaff(locationId) {
  if (isMock || !supabase) return lsGet('staff');
  if (!locationId) return [];
  const { data, error } = await supabase.from('wf_staff')
    .select('id,name,role_key,contract_type,mobile,email,dob,start_date,status,pos_user_id,section_ids,rate_override,contracted_week,weekly_hours_target,holiday_entitlement_days,address,emergency_contact,bank_sort_code,bank_account,bank_account_masked,created_at')
    .eq('location_id', locationId).neq('status', 'leaver').order('created_at', { ascending: true });
  if (error) { console.warn('[wf] loadStaff:', error.message); return []; }
  return (data || []).map(mapStaff);
}
export async function saveStaff(member, locationId, orgId) {
  if (isMock || !supabase) return lsUpsert('staff', { ...member, status: member.status || 'active' });
  if (!locationId) throw new Error('No location selected');
  const org = await resolveOrgForLocation(locationId, orgId);
  const row = {
    location_id: locationId, org_id: org, name: member.name, role_key: member.role || null,
    contract_type: member.contractType || 'partTime', mobile: member.mobile || null,
    email: member.email || null, dob: member.dob || null, start_date: member.startDate || null,
    address: member.address || null, emergency_contact: member.emergencyContact || null,
    primary_venue_id: locationId, venue_ids: [locationId], status: member.status || 'active',
  };
  const real = member.id && !String(member.id).startsWith('tmp-') && !String(member.id).startsWith('wf-');
  if (real) row.id = member.id;
  const q = real ? supabase.from('wf_staff').upsert(row, { onConflict: 'id' }) : supabase.from('wf_staff').insert(row);
  const { data, error } = await q.select().single();
  if (error) { console.warn('[wf] saveStaff:', error.message); throw new Error(error.message); }
  return mapStaff(data);
}
export async function softDeleteStaff(id) {
  if (isMock || !supabase) return lsDelete('staff', id);
  const today = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.from('wf_staff').update({ status: 'leaver', leaver_date: today }).eq('id', id);
  if (error) console.warn('[wf] softDeleteStaff:', error.message);
}
export async function markPosUser(staffId, posUserId) {
  if (isMock || !supabase) { const a = lsGet('staff'); const i = a.findIndex(x => x.id === staffId); if (i >= 0) { a[i].posUserId = posUserId; lsSet('staff', a); } return; }
  const { error } = await supabase.from('wf_staff').update({ pos_user_id: posUserId }).eq('id', staffId);
  if (error) console.warn('[wf] markPosUser:', error.message);
}

// ============================================================================
// ROLES (wf_roles — editable rate card)
// ============================================================================
function mapRole(r) {
  return {
    id: r.id, key: r.key, lbl: r.label, grp: r.grp, payType: r.pay_type,
    rate: r.base_rate != null ? Number(r.base_rate) : null,
    salary: r.salary_annual != null ? Number(r.salary_annual) : null,
    contractedWeek: r.contracted_week != null ? Number(r.contracted_week) : 40,
    ageBands: r.age_bands || [], troncWeight: Number(r.tronc_weight ?? 1),
    requiresSIA: !!r.requires_sia, premiumEligible: !!r.premium_eligible, sortOrder: r.sort_order || 0,
  };
}
/** Returns { list:[roleObj], map:{key:roleObj} } for the location, seeding defaults if empty. */
export async function loadRoles(locationId, orgId) {
  let list;
  if (isMock || !supabase) {
    list = lsGet('roles');
    if (!list.length) { list = seedRoleObjects(); lsSet('roles', list); }
  } else {
    if (!locationId) return { list: [], map: {} };
    const { data, error } = await supabase.from('wf_roles').select('*').eq('location_id', locationId).order('sort_order');
    if (error) { console.warn('[wf] loadRoles:', error.message); return { list: [], map: {} }; }
    list = (data || []).map(mapRole);
    if (!list.length) { list = await seedDefaultRoles(locationId, orgId); }
  }
  const map = {}; list.forEach(r => { map[r.key] = r; });
  return { list, map };
}
function seedRoleObjects() {
  return Object.entries(SEED_ROLES).map(([key, r], i) => ({
    id: `wf-role-${key}`, key, lbl: r.lbl, grp: r.grp, payType: r.salary ? 'salaried' : r.band ? 'ageBanded' : 'hourly',
    rate: r.rate ?? null, salary: r.salary ?? null, contractedWeek: 40, ageBands: [], troncWeight: 1,
    requiresSIA: !!r.requiresSIA, premiumEligible: true, sortOrder: i,
  }));
}
async function seedDefaultRoles(locationId, orgId) {
  const org = await resolveOrgForLocation(locationId, orgId);
  const rows = Object.entries(SEED_ROLES).map(([key, r], i) => ({
    location_id: locationId, org_id: org, key, label: r.lbl, grp: r.grp,
    pay_type: r.salary ? 'salaried' : r.band ? 'ageBanded' : 'hourly',
    base_rate: r.rate ?? null, salary_annual: r.salary ?? null, contracted_week: 40,
    tronc_weight: 1, requires_sia: !!r.requiresSIA, sort_order: i,
  }));
  const { data, error } = await supabase.from('wf_roles').insert(rows).select();
  if (error) { console.warn('[wf] seedDefaultRoles:', error.message); return seedRoleObjects(); }
  return (data || []).map(mapRole);
}
export async function saveRole(role, locationId, orgId) {
  if (isMock || !supabase) return lsUpsert('roles', role);
  const org = await resolveOrgForLocation(locationId, orgId);
  const row = {
    location_id: locationId, org_id: org, key: role.key, label: role.lbl, grp: role.grp,
    pay_type: role.payType || 'hourly', base_rate: role.rate ?? null, salary_annual: role.salary ?? null,
    contracted_week: role.contractedWeek ?? 40, tronc_weight: role.troncWeight ?? 1,
    requires_sia: !!role.requiresSIA, premium_eligible: role.premiumEligible !== false, sort_order: role.sortOrder || 0,
  };
  const real = role.id && !String(role.id).startsWith('wf-role-') && !String(role.id).startsWith('tmp-');
  if (real) row.id = role.id;
  const q = real ? supabase.from('wf_roles').upsert(row, { onConflict: 'id' }) : supabase.from('wf_roles').insert(row);
  const { data, error } = await q.select().single();
  if (error) throw new Error(error.message);
  return mapRole(data);
}
export async function deleteRole(id) {
  if (isMock || !supabase) return lsDelete('roles', id);
  const { error } = await supabase.from('wf_roles').delete().eq('id', id);
  if (error) console.warn('[wf] deleteRole:', error.message);
}

// ============================================================================
// SECTIONS (wf_sections)
// ============================================================================
const mapSection = r => ({ id: r.id, name: r.name, color: r.color, minCoverage: r.min_coverage, peakRules: r.peak_rules || [], sortOrder: r.sort_order || 0 });
export async function loadSections(locationId) {
  if (isMock || !supabase) return lsGet('sections');
  if (!locationId) return [];
  const { data, error } = await supabase.from('wf_sections').select('*').eq('location_id', locationId).order('sort_order');
  if (error) { console.warn('[wf] loadSections:', error.message); return []; }
  return (data || []).map(mapSection);
}
export async function saveSection(section, locationId, orgId) {
  if (isMock || !supabase) return lsUpsert('sections', section);
  const org = await resolveOrgForLocation(locationId, orgId);
  const row = { location_id: locationId, org_id: org, name: section.name, color: section.color || null, min_coverage: section.minCoverage ?? 1, sort_order: section.sortOrder || 0 };
  const real = section.id && !String(section.id).startsWith('wf-') && !String(section.id).startsWith('tmp-');
  if (real) row.id = section.id;
  const q = real ? supabase.from('wf_sections').upsert(row, { onConflict: 'id' }) : supabase.from('wf_sections').insert(row);
  const { data, error } = await q.select().single();
  if (error) throw new Error(error.message);
  return mapSection(data);
}
export async function deleteSection(id) {
  if (isMock || !supabase) return lsDelete('sections', id);
  const { error } = await supabase.from('wf_sections').delete().eq('id', id);
  if (error) console.warn('[wf] deleteSection:', error.message);
}

// ============================================================================
// VENUE SETTINGS (wf_venue_settings — PK location_id)
// ============================================================================
const DEFAULT_SETTINGS = { currency: 'GBP', labourTargetPct: 0.28, accrualRate: 0.1207, premiums: {}, salesSource: 'pos', payPeriodType: 'monthly', payPeriodStartDay: 1, settings: {} };
const mapSettings = r => ({ currency: r.currency || 'GBP', labourTargetPct: Number(r.labour_target_pct ?? 0.28), accrualRate: Number(r.accrual_rate ?? 0.1207), premiums: r.premiums || {}, salesSource: r.sales_source || 'pos', payPeriodType: r.pay_period_type || 'monthly', payPeriodStartDay: Number(r.pay_period_start_day ?? 1), settings: r.settings || {} });
export async function loadSettings(locationId) {
  if (isMock || !supabase) { const a = lsGet('settings'); return a[0] || { ...DEFAULT_SETTINGS }; }
  if (!locationId) return { ...DEFAULT_SETTINGS };
  const { data, error } = await supabase.from('wf_venue_settings').select('*').eq('location_id', locationId).maybeSingle();
  if (error) { console.warn('[wf] loadSettings:', error.message); return { ...DEFAULT_SETTINGS }; }
  return data ? mapSettings(data) : { ...DEFAULT_SETTINGS };
}
export async function saveSettings(patch, locationId, orgId) {
  if (isMock || !supabase) { lsSet('settings', [{ ...DEFAULT_SETTINGS, ...patch }]); return { ...DEFAULT_SETTINGS, ...patch }; }
  const org = await resolveOrgForLocation(locationId, orgId);
  const row = {
    location_id: locationId, org_id: org,
    currency: patch.currency || 'GBP', labour_target_pct: patch.labourTargetPct ?? 0.28,
    accrual_rate: patch.accrualRate ?? 0.1207, premiums: patch.premiums || {}, sales_source: patch.salesSource || 'pos',
    pay_period_type: patch.payPeriodType || 'monthly', pay_period_start_day: patch.payPeriodStartDay ?? 1,
    settings: patch.settings || {}, updated_at: new Date().toISOString(),
  };
  const { data, error } = await supabase.from('wf_venue_settings').upsert(row, { onConflict: 'location_id' }).select().single();
  if (error) throw new Error(error.message);
  return mapSettings(data);
}

// ============================================================================
// SHIFTS (wf_shifts) — rota. Pay rate is SNAPSHOTTED at save time.
// ============================================================================
const mapShift = r => ({
  id: r.id, staffId: r.staff_id, roleKey: r.role_key, sectionId: r.section_id, section: r.section,
  date: r.shift_date, start: (r.start_time || '').slice(0, 5), finish: (r.finish_time || '').slice(0, 5),
  breakMins: r.break_mins || 0, status: r.status, note: r.note,
  effectiveRate: r.effective_rate != null ? Number(r.effective_rate) : null, rateSource: r.rate_source,
  computedHours: r.computed_hours != null ? Number(r.computed_hours) : null,
  computedCost: r.computed_cost != null ? Number(r.computed_cost) : null,
});
export async function loadShifts(locationId, fromIso, toIso) {
  if (isMock || !supabase) return lsGet('shifts').filter(s => (!fromIso || s.date >= fromIso) && (!toIso || s.date <= toIso));
  if (!locationId) return [];
  let q = supabase.from('wf_shifts').select('*').eq('location_id', locationId);
  if (fromIso) q = q.gte('shift_date', fromIso);
  if (toIso) q = q.lte('shift_date', toIso);
  const { data, error } = await q.order('shift_date');
  if (error) { console.warn('[wf] loadShifts:', error.message); return []; }
  return (data || []).map(mapShift);
}
export async function saveShift(shift, locationId, orgId) {
  if (isMock || !supabase) return lsUpsert('shifts', shift);
  const org = await resolveOrgForLocation(locationId, orgId);
  const row = {
    location_id: locationId, org_id: org, staff_id: shift.staffId, role_key: shift.roleKey || null,
    section_id: shift.sectionId || null, section: shift.section || null, shift_date: shift.date,
    start_time: shift.start, finish_time: shift.finish, break_mins: shift.breakMins || 0,
    status: shift.status || 'draft', note: shift.note || null,
    effective_rate: shift.effectiveRate ?? null, rate_source: shift.rateSource || null,
    currency: shift.currency || 'GBP', computed_hours: shift.computedHours ?? null, computed_cost: shift.computedCost ?? null,
  };
  const real = shift.id && !String(shift.id).startsWith('tmp-') && !String(shift.id).startsWith('wf-');
  if (real) row.id = shift.id;
  const q = real ? supabase.from('wf_shifts').upsert(row, { onConflict: 'id' }) : supabase.from('wf_shifts').insert(row);
  const { data, error } = await q.select().single();
  if (error) throw new Error(error.message);
  return mapShift(data);
}
export async function deleteShift(id) {
  if (isMock || !supabase) return lsDelete('shifts', id);
  const { error } = await supabase.from('wf_shifts').delete().eq('id', id);
  if (error) console.warn('[wf] deleteShift:', error.message);
}
export async function publishShifts(ids) {
  if (!ids?.length) return;
  if (isMock || !supabase) { const a = lsGet('shifts'); a.forEach(s => { if (ids.includes(s.id)) s.status = 'published'; }); lsSet('shifts', a); return; }
  const { error } = await supabase.from('wf_shifts').update({ status: 'published' }).in('id', ids);
  if (error) console.warn('[wf] publishShifts:', error.message);
}

// ============================================================================
// TIMESHEETS (wf_timesheets)
// ============================================================================
const mapTs = r => ({
  id: r.id, shiftId: r.shift_id, staffId: r.staff_id, clockIn: r.clock_in, clockOut: r.clock_out,
  breakTaken: r.break_taken || 0, scheduledHours: Number(r.scheduled_hours ?? 0), actualHours: Number(r.actual_hours ?? 0),
  variance: r.variance != null ? Number(r.variance) : null, payAmount: r.pay_amount != null ? Number(r.pay_amount) : null,
  effectiveRate: r.effective_rate != null ? Number(r.effective_rate) : null, rateSource: r.rate_source,
  status: r.status, approvedBy: r.approved_by, approvedAt: r.approved_at,
});
export async function loadTimesheets(locationId, fromIso, toIso) {
  if (isMock || !supabase) return lsGet('timesheets');
  if (!locationId) return [];
  let q = supabase.from('wf_timesheets').select('*').eq('location_id', locationId);
  const { data, error } = await q.order('created_at', { ascending: false });
  if (error) { console.warn('[wf] loadTimesheets:', error.message); return []; }
  return (data || []).map(mapTs);
}
export async function saveTimesheet(ts, locationId, orgId) {
  if (isMock || !supabase) return lsUpsert('timesheets', ts);
  const org = await resolveOrgForLocation(locationId, orgId);
  const row = {
    location_id: locationId, org_id: org, shift_id: ts.shiftId || null, staff_id: ts.staffId,
    clock_in: ts.clockIn || null, clock_out: ts.clockOut || null, break_taken: ts.breakTaken || 0,
    scheduled_hours: ts.scheduledHours ?? null, actual_hours: ts.actualHours ?? null, variance: ts.variance ?? null,
    effective_rate: ts.effectiveRate ?? null, rate_source: ts.rateSource || null, currency: ts.currency || 'GBP',
    pay_amount: ts.payAmount ?? null, status: ts.status || 'pending',
  };
  const real = ts.id && !String(ts.id).startsWith('tmp-') && !String(ts.id).startsWith('wf-');
  if (real) row.id = ts.id;
  const q = real ? supabase.from('wf_timesheets').upsert(row, { onConflict: 'id' }) : supabase.from('wf_timesheets').insert(row);
  const { data, error } = await q.select().single();
  if (error) throw new Error(error.message);
  return mapTs(data);
}
export async function approveTimesheet(id, approvedBy) {
  if (isMock || !supabase) { const a = lsGet('timesheets'); const i = a.findIndex(x => x.id === id); if (i >= 0) { a[i].status = 'approved'; lsSet('timesheets', a); } return; }
  const { error } = await supabase.from('wf_timesheets').update({ status: 'approved', approved_by: approvedBy || null, approved_at: new Date().toISOString() }).eq('id', id);
  if (error) console.warn('[wf] approveTimesheet:', error.message);
}

// ============================================================================
// TIME OFF (wf_time_off) + AVAILABILITY (wf_availability)
// ============================================================================
const mapLeave = r => ({ id: r.id, staffId: r.staff_id, type: r.type, startDate: r.start_date, endDate: r.end_date, days: Number(r.days ?? 0), note: r.note, status: r.status, decidedBy: r.decided_by, decidedAt: r.decided_at });
export async function loadTimeOff(locationId) {
  if (isMock || !supabase) return lsGet('timeoff');
  if (!locationId) return [];
  const { data, error } = await supabase.from('wf_time_off').select('*').eq('location_id', locationId).order('start_date', { ascending: false });
  if (error) { console.warn('[wf] loadTimeOff:', error.message); return []; }
  return (data || []).map(mapLeave);
}
export async function saveTimeOff(leave, locationId, orgId) {
  if (isMock || !supabase) return lsUpsert('timeoff', leave);
  const org = await resolveOrgForLocation(locationId, orgId);
  const row = { location_id: locationId, org_id: org, staff_id: leave.staffId, type: leave.type, start_date: leave.startDate, end_date: leave.endDate, days: leave.days ?? null, note: leave.note || null, status: leave.status || 'pending' };
  const real = leave.id && !String(leave.id).startsWith('tmp-') && !String(leave.id).startsWith('wf-');
  if (real) row.id = leave.id;
  const q = real ? supabase.from('wf_time_off').upsert(row, { onConflict: 'id' }) : supabase.from('wf_time_off').insert(row);
  const { data, error } = await q.select().single();
  if (error) throw new Error(error.message);
  return mapLeave(data);
}
export async function decideTimeOff(id, status, decidedBy) {
  if (isMock || !supabase) { const a = lsGet('timeoff'); const i = a.findIndex(x => x.id === id); if (i >= 0) { a[i].status = status; lsSet('timeoff', a); } return; }
  const { error } = await supabase.from('wf_time_off').update({ status, decided_by: decidedBy || null, decided_at: new Date().toISOString() }).eq('id', id);
  if (error) console.warn('[wf] decideTimeOff:', error.message);
}
const mapAvail = r => ({ id: r.id, staffId: r.staff_id, weekStart: r.week_start, recurring: r.recurring, perDay: r.per_day || [] });
export async function loadAvailability(locationId) {
  if (isMock || !supabase) return lsGet('availability');
  if (!locationId) return [];
  const { data, error } = await supabase.from('wf_availability').select('*').eq('location_id', locationId);
  if (error) { console.warn('[wf] loadAvailability:', error.message); return []; }
  return (data || []).map(mapAvail);
}
export async function saveAvailability(av, locationId, orgId) {
  if (isMock || !supabase) return lsUpsert('availability', av);
  const org = await resolveOrgForLocation(locationId, orgId);
  const row = { location_id: locationId, org_id: org, staff_id: av.staffId, week_start: av.weekStart || null, recurring: !!av.recurring, per_day: av.perDay || [] };
  const real = av.id && !String(av.id).startsWith('tmp-') && !String(av.id).startsWith('wf-');
  if (real) row.id = av.id;
  const q = real ? supabase.from('wf_availability').upsert(row, { onConflict: 'id' }) : supabase.from('wf_availability').insert(row);
  const { data, error } = await q.select().single();
  if (error) throw new Error(error.message);
  return mapAvail(data);
}

// ============================================================================
// HOLIDAY ACCRUAL (wf_holiday_accrual — append-only ledger; balance = sum)
// ============================================================================
const mapAccrual = r => ({ id: r.id, staffId: r.staff_id, kind: r.kind, periodStart: r.period_start, accruedHours: Number(r.accrued_hours ?? 0), accruedPay: r.accrued_pay != null ? Number(r.accrued_pay) : null, accrualRate: r.accrual_rate != null ? Number(r.accrual_rate) : null, createdAt: r.created_at });
export async function loadAccrual(locationId) {
  if (isMock || !supabase) return lsGet('accrual');
  if (!locationId) return [];
  const { data, error } = await supabase.from('wf_holiday_accrual').select('*').eq('location_id', locationId).order('created_at', { ascending: false });
  if (error) { console.warn('[wf] loadAccrual:', error.message); return []; }
  return (data || []).map(mapAccrual);
}
/** Per-staff balance (hours) derived from the ledger. */
export function accrualBalances(rows) {
  const bal = {};
  rows.forEach(r => { bal[r.staffId] = (bal[r.staffId] || 0) + Number(r.accruedHours || 0); });
  return bal;
}

// ============================================================================
// TRONC (wf_tronc_runs + wf_tronc_lines) — runs are computed SERVER-SIDE.
// ============================================================================
const mapRun = r => ({ id: r.id, weekStart: r.week_start, currency: r.currency, pool: Number(r.pool ?? 0), unitsTotal: r.units_total != null ? Number(r.units_total) : null, pointValue: r.point_value != null ? Number(r.point_value) : null, totalPaid: Number(r.total_paid ?? 0), residual: Number(r.residual ?? 0), status: r.status, lines: r.lines || [], createdAt: r.created_at });
const mapLine = r => ({ id: r.id, runId: r.run_id, staffId: r.staff_id, hours: Number(r.hours ?? 0), points: Number(r.points ?? 0), units: Number(r.units ?? 0), sharePct: Number(r.share_pct ?? 0), payout: Number(r.payout ?? 0) });
export async function loadTroncRuns(locationId) {
  if (isMock || !supabase) return lsGet('tronc');
  if (!locationId) return [];
  const { data, error } = await supabase.from('wf_tronc_runs').select('*').eq('location_id', locationId).order('week_start', { ascending: false });
  if (error) { console.warn('[wf] loadTroncRuns:', error.message); return []; }
  return (data || []).map(mapRun);
}
export async function loadTroncLines(runId) {
  if (isMock || !supabase) return [];
  const { data, error } = await supabase.from('wf_tronc_lines').select('*').eq('run_id', runId).order('payout', { ascending: false });
  if (error) { console.warn('[wf] loadTroncLines:', error.message); return []; }
  return (data || []).map(mapLine);
}

// ============================================================================
// DOCUMENTS (wf_documents — compliance vault)
// ============================================================================
const mapDoc = r => ({ id: r.id, staffId: r.staff_id, type: r.type, fileUrl: r.file_url, status: r.status, issuedOn: r.issued_on, expiry: r.expiry, verifiedBy: r.verified_by, verifiedAt: r.verified_at });
export async function loadDocuments(locationId) {
  if (isMock || !supabase) return lsGet('documents');
  if (!locationId) return [];
  const { data, error } = await supabase.from('wf_documents').select('*').eq('location_id', locationId).order('expiry', { ascending: true, nullsFirst: false });
  if (error) { console.warn('[wf] loadDocuments:', error.message); return []; }
  return (data || []).map(mapDoc);
}
export async function saveDocument(doc, locationId, orgId) {
  if (isMock || !supabase) return lsUpsert('documents', doc);
  const org = await resolveOrgForLocation(locationId, orgId);
  const row = { location_id: locationId, org_id: org, staff_id: doc.staffId, type: doc.type, file_url: doc.fileUrl || null, status: doc.status || 'missing', issued_on: doc.issuedOn || null, expiry: doc.expiry || null };
  const real = doc.id && !String(doc.id).startsWith('tmp-') && !String(doc.id).startsWith('wf-');
  if (real) row.id = doc.id;
  const q = real ? supabase.from('wf_documents').upsert(row, { onConflict: 'id' }) : supabase.from('wf_documents').insert(row);
  const { data, error } = await q.select().single();
  if (error) throw new Error(error.message);
  return mapDoc(data);
}
export async function deleteDocument(id) {
  if (isMock || !supabase) return lsDelete('documents', id);
  const { error } = await supabase.from('wf_documents').delete().eq('id', id);
  if (error) console.warn('[wf] deleteDocument:', error.message);
}

// ============================================================================
// ONBOARDING (wf_onboarding)
// ============================================================================
const mapOnb = r => ({ id: r.id, staffId: r.staff_id, roleKey: r.role_key, steps: r.steps || [], status: r.status, firstShiftDate: r.first_shift_date, meta: r.meta || {} });
export async function loadOnboarding(locationId) {
  if (isMock || !supabase) return lsGet('onboarding');
  if (!locationId) return [];
  const { data, error } = await supabase.from('wf_onboarding').select('*').eq('location_id', locationId).order('created_at', { ascending: false });
  if (error) { console.warn('[wf] loadOnboarding:', error.message); return []; }
  return (data || []).map(mapOnb);
}
export async function saveOnboarding(onb, locationId, orgId) {
  if (isMock || !supabase) return lsUpsert('onboarding', onb);
  const org = await resolveOrgForLocation(locationId, orgId);
  const row = { location_id: locationId, org_id: org, staff_id: onb.staffId, role_key: onb.roleKey || null, steps: onb.steps || [], status: onb.status || 'inProgress', first_shift_date: onb.firstShiftDate || null, meta: onb.meta || {} };
  const real = onb.id && !String(onb.id).startsWith('tmp-') && !String(onb.id).startsWith('wf-');
  if (real) row.id = onb.id;
  const q = real ? supabase.from('wf_onboarding').upsert(row, { onConflict: 'id' }) : supabase.from('wf_onboarding').insert(row);
  const { data, error } = await q.select().single();
  if (error) throw new Error(error.message);
  return mapOnb(data);
}

// ============================================================================
// DOCUMENT TEMPLATES (wf_doc_templates) — offer letters + contracts with {{tokens}}
// ============================================================================
const mapTemplate = r => ({ id: r.id, kind: r.kind, name: r.name, body: r.body || '', contractType: r.contract_type || null, isDefault: !!r.is_default, active: r.active !== false });

// Built-in starting templates so there's always something to send. Editable copies
// are created in wf_doc_templates the first time the operator saves a change.
export const DEFAULT_TEMPLATES = [
  { id: 'builtin-offer', kind: 'offer', name: 'Standard offer letter', contractType: null, isDefault: true, builtin: true,
    body: `Dear {{first_name}},

We're delighted to offer you the position of {{position}} at {{business_name}}.

• Rate of pay: {{rate}}
• Employment type: {{contract_type}}
• Proposed start date: {{start_date}}

We're really pleased to have you joining the team. Please reply to this email to accept, and we'll send your contract to sign and get you set up.

Warm regards,
{{business_name}}` },
  { id: 'builtin-contract', kind: 'contract', name: 'Statement of main terms (UK)', contractType: null, isDefault: true, builtin: true,
    body: `STATEMENT OF MAIN TERMS OF EMPLOYMENT

This statement sets out the main terms of your employment with {{business_name}} ("the Employer").

Employee: {{full_name}}
Position: {{position}}
Employment type: {{contract_type}}
Start date: {{start_date}}
Rate of pay: {{rate}}
Average weekly hours: {{weekly_hours}}
Place of work: {{business_name}}

1. Pay is calculated and paid in line with the Employer's normal payroll schedule.
2. Holiday accrues in line with statutory entitlement (5.6 weeks per year, pro rata).
3. Either party may end this employment by giving the statutory minimum notice.
4. You agree to follow the Employer's policies and procedures while employed.

By signing below you confirm you have read, understood and agree to these terms of employment.

Signed: {{full_name}}     Date: {{today}}` },
];

/** Replace {{token}} placeholders in a template body. Unknown tokens → blank. */
export function mergeTemplate(body, vars) {
  return String(body || '').replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, k) => (vars[k] != null && vars[k] !== '' ? String(vars[k]) : '—'));
}

/** Build the merge variables for a staff member. */
export function templateVars(staff, role, businessName) {
  const rate = staff.rateOverride != null && staff.rateOverride !== '' ? `£${Number(staff.rateOverride).toFixed(2)} per hour`
    : (role?.rate != null ? `£${Number(role.rate).toFixed(2)} per hour` : (role?.salary ? `£${Number(role.salary).toLocaleString()} per year` : 'to be confirmed'));
  const ctMap = { zeroHours: 'Zero hours', partTime: 'Part time', fullTime: 'Full time', salaried: 'Salaried' };
  return {
    first_name: (staff.name || '').split(' ')[0] || 'there',
    full_name: staff.name || '',
    position: role?.lbl || staff.role || 'team member',
    rate,
    contract_type: ctMap[staff.contractType] || staff.contractType || '—',
    start_date: staff.startDate ? new Date(staff.startDate + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : 'to be confirmed',
    weekly_hours: staff.weeklyHoursTarget || staff.contractedWeek || '—',
    business_name: businessName || 'our team',
    today: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
  };
}

/** Load templates (merges built-in defaults with saved ones; saved override built-ins by kind+name). */
export async function loadTemplates(locationId, kind) {
  let saved = [];
  if (isMock || !supabase) saved = lsGet('templates');
  else if (locationId) {
    const { data, error } = await supabase.from('wf_doc_templates').select('*').eq('location_id', locationId).eq('active', true).order('created_at');
    if (!error) saved = (data || []).map(mapTemplate);
  }
  const all = [...DEFAULT_TEMPLATES, ...saved];
  return kind ? all.filter(t => t.kind === kind) : all;
}
export async function saveTemplate(tpl, locationId, orgId) {
  if (isMock || !supabase) return lsUpsert('templates', { ...tpl, builtin: false });
  const org = await resolveOrgForLocation(locationId, orgId);
  const row = { location_id: locationId, org_id: org, kind: tpl.kind, name: tpl.name, body: tpl.body || '', contract_type: tpl.contractType || null, is_default: !!tpl.isDefault, active: true };
  const real = tpl.id && !String(tpl.id).startsWith('builtin-') && !String(tpl.id).startsWith('tmp-') && !String(tpl.id).startsWith('wf-');
  if (real) row.id = tpl.id;
  const q = real ? supabase.from('wf_doc_templates').upsert(row, { onConflict: 'id' }) : supabase.from('wf_doc_templates').insert(row);
  const { data, error } = await q.select().single();
  if (error) throw new Error(error.message);
  return mapTemplate(data);
}
export async function deleteTemplate(id) {
  if (String(id).startsWith('builtin-')) return; // can't delete built-ins
  if (isMock || !supabase) return lsDelete('templates', id);
  const { error } = await supabase.from('wf_doc_templates').delete().eq('id', id);
  if (error) console.warn('[wf] deleteTemplate:', error.message);
}

// ============================================================================
// ANNOUNCEMENTS (wf_announcements)
// ============================================================================
const mapAnn = r => ({ id: r.id, authorName: r.author_name, audience: r.audience || {}, channels: r.channels || [], body: r.body, sentAt: r.sent_at, createdAt: r.created_at });
export async function loadAnnouncements(locationId) {
  if (isMock || !supabase) return lsGet('announce');
  if (!locationId) return [];
  const { data, error } = await supabase.from('wf_announcements').select('*').eq('location_id', locationId).order('created_at', { ascending: false });
  if (error) { console.warn('[wf] loadAnnouncements:', error.message); return []; }
  return (data || []).map(mapAnn);
}
export async function saveAnnouncement(ann, locationId, orgId, authorName) {
  if (isMock || !supabase) return lsUpsert('announce', { ...ann, createdAt: new Date().toISOString() });
  const org = await resolveOrgForLocation(locationId, orgId);
  const row = { location_id: locationId, org_id: org, author_name: authorName || null, audience: ann.audience || {}, channels: ann.channels || ['inApp'], body: ann.body, sent_at: new Date().toISOString() };
  const { data, error } = await supabase.from('wf_announcements').insert(row).select().single();
  if (error) throw new Error(error.message);
  return mapAnn(data);
}

// ============================================================================
// SALES FORECAST (wf_sales_forecast) + ACTUAL sales (closed_checks)
// ============================================================================
export async function loadForecast(locationId, fromIso, toIso) {
  if (isMock || !supabase) { const a = lsGet('forecast'); const m = {}; a.forEach(r => { m[r.date] = Number(r.amount || 0); }); return m; }
  if (!locationId) return {};
  let q = supabase.from('wf_sales_forecast').select('forecast_date, amount').eq('location_id', locationId);
  if (fromIso) q = q.gte('forecast_date', fromIso);
  if (toIso) q = q.lte('forecast_date', toIso);
  const { data, error } = await q;
  if (error) { console.warn('[wf] loadForecast:', error.message); return {}; }
  const m = {}; (data || []).forEach(r => { m[r.forecast_date] = Number(r.amount || 0); });
  return m;
}
export async function saveForecast(dateIso, amount, locationId, orgId) {
  if (isMock || !supabase) { const a = lsGet('forecast').filter(r => r.date !== dateIso); a.push({ id: dateIso, date: dateIso, amount }); lsSet('forecast', a); return; }
  const org = await resolveOrgForLocation(locationId, orgId);
  const row = { location_id: locationId, org_id: org, forecast_date: dateIso, amount: Number(amount) || 0 };
  const { error } = await supabase.from('wf_sales_forecast').upsert(row, { onConflict: 'location_id,forecast_date' });
  if (error) console.warn('[wf] saveForecast:', error.message);
}
/** Actual revenue per day (YYYY-MM-DD → £) from closed_checks (excludes voids). */
export async function loadActualSales(locationId, fromIso, toIso) {
  if (isMock || !supabase || !locationId) return {};
  const { data, error } = await supabase.from('closed_checks')
    .select('total, closed_at, status')
    .eq('location_id', String(locationId))
    .gte('closed_at', `${fromIso}T00:00:00`).lte('closed_at', `${toIso}T23:59:59`)
    .neq('status', 'voided');
  if (error) { console.warn('[wf] loadActualSales:', error.message); return {}; }
  const m = {};
  (data || []).forEach(c => {
    const d = new Date(c.closed_at);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    m[iso] = (m[iso] || 0) + (Number(c.total) || 0);
  });
  return m;
}

/**
 * Real tip pool from the POS for a period, mirroring the Tips report:
 * card tips (non-cash) + service charge are the troncable pool; cash tips are
 * shown for context. Excludes voided checks. Returns money rounded to 2dp.
 */
export async function loadTipPool(locationId, fromIso, toIso) {
  const empty = { cardTips: 0, cashTips: 0, serviceCharge: 0, suggestedPool: 0, totalTips: 0 };
  if (isMock || !supabase || !locationId) return empty;
  const { data, error } = await supabase.from('closed_checks')
    .select('tip, service, method, closed_at, status')
    .eq('location_id', String(locationId))
    .gte('closed_at', `${fromIso}T00:00:00`).lte('closed_at', `${toIso}T23:59:59`)
    .neq('status', 'voided');
  if (error) { console.warn('[wf] loadTipPool:', error.message); return empty; }
  let cardTips = 0, cashTips = 0, serviceCharge = 0;
  (data || []).forEach(c => {
    const tip = Number(c.tip) || 0;
    if ((c.method || '').toLowerCase() === 'cash') cashTips += tip; else cardTips += tip;
    serviceCharge += Number(c.service) || 0;
  });
  const r2 = n => Math.round(n * 100) / 100;
  return { cardTips: r2(cardTips), cashTips: r2(cashTips), serviceCharge: r2(serviceCharge), suggestedPool: r2(cardTips + serviceCharge), totalTips: r2(cardTips + cashTips) };
}

// ============================================================================
// AUDIT (wf_audit — client writes non-financial events; financial chain is server-side)
// ============================================================================
export async function logAudit(entry, locationId, orgId, actor) {
  if (isMock || !supabase || !locationId) return;
  const org = await resolveOrgForLocation(locationId, orgId);
  const row = {
    location_id: locationId, org_id: org, actor_id: actor?.id || null, actor_name: actor?.name || null,
    action: entry.action, entity: entry.entity || null, entity_id: entry.entityId || null,
    amount: entry.amount ?? null, currency: entry.currency || null, reason: entry.reason || null,
    before: entry.before || null, after: entry.after || null,
  };
  const { error } = await supabase.from('wf_audit').insert(row);
  if (error) console.warn('[wf] logAudit:', error.message);
}
