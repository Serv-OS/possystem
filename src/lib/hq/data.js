// src/lib/hq/data.js
//
// Head office hub: the Supabase data layer (Ops database). Every read answers
// { data, error, absent, message } and never throws; `absent` is true until Peter has run
// supabase/migrations/20261130a_OPS_head_office_hub.sql, and the screens then say
// "not set up yet" (the Operations Forms pattern, src/lib/ops/forms.js).
//
// Who may see what is decided by the database, not here:
//   * daily numbers: anyone who manages the site in Back Office;
//   * projects, tasks, updates, questions: everyone with a site in the company;
//   * check ins: the author and the company's owner logins (hq_is_company_owner).
// The till's own figures come from the owner-snapshot edge function (one call, every site).

import { supabase, isMock } from '../supabase';
import { isAbsentError } from '../ops/formRules';
import { withTimeout } from '../withTimeout';
import { cleanAnswers, normaliseQuestions, scoreOf, weekStartIso } from './checkinWeek.js';
import { getVenueClock, getLocationConfig, ymdInTz, minutesInTz } from '../locationTime';
import { businessDayOf, businessDayWindow, dayStartMinutes, isYmd, addDays as addYmd } from '../../../supabase/functions/_shared/businessDay.js';
import { buildScheduleCtx } from '../scheduleCtx';

export const NOT_SET_UP = 'Head office is not set up in the database yet. Ask ServOS to run migration 20261130a.';
const NOT_LIVE = 'This needs a live connection to ServOS.';
const SNAPSHOT_TIMEOUT_MS = 15000;

const fail = (error, what) => (isAbsentError(error)
  ? { data: null, error, absent: true, message: NOT_SET_UP }
  : { data: null, error, absent: false, message: `Could not ${what}. Try again.` });
const ok = (data) => ({ data, error: null, absent: false, message: null });
const offline = () => ({ data: null, error: new Error(NOT_LIVE), absent: false, message: NOT_LIVE });

async function me() {
  if (isMock || !supabase?.auth?.getUser) return { id: null, email: null };
  try { const { data } = await supabase.auth.getUser(); return { id: data?.user?.id || null, email: data?.user?.email || null }; }
  catch { return { id: null, email: null }; }
}

/** The three parts of a user name and id to stamp on a row. */
async function stamp(name) {
  const u = await me();
  return { id: u.id, name: name || u.email || null };
}

// ----------------------------------------------------------------------------
// The till's figures: owner-snapshot, one call for every site the login can read.
// ----------------------------------------------------------------------------
/** { data: { venues: [...], rollup, period }, ... }. period: 'today' | 'week' | 'month'. */
export async function fetchSnapshot(period = 'today') {
  if (isMock || !supabase) return offline();
  try {
    const { data, error } = await withTimeout(supabase.functions.invoke('owner-snapshot', { body: { period } }), SNAPSHOT_TIMEOUT_MS, 'owner-snapshot');
    if (error) return { data: null, error, absent: false, message: 'Could not reach the sales figures. The typed numbers still show.' };
    const venues = Array.isArray(data?.locations) ? data.locations : (Array.isArray(data?.venues) ? data.venues : []);
    return ok({ venues, rollup: data?.rollup || null, period: data?.period || period, raw: data });
  } catch (e) {
    return { data: null, error: e, absent: false, message: 'The sales figures took too long. The typed numbers still show.' };
  }
}

// ----------------------------------------------------------------------------
// Daily numbers
// ----------------------------------------------------------------------------
/** Rows for the sites between two dates (inclusive), newest first. */
export async function fetchDailyNumbers(locationIds, fromIso, toIso) {
  if (isMock || !supabase) return offline();
  const ids = (locationIds || []).filter(Boolean);
  if (!ids.length) return ok([]);
  let q = supabase.from('hq_daily_numbers').select('*').in('location_id', ids).order('business_date', { ascending: false }).limit(2000);
  if (fromIso) q = q.gte('business_date', fromIso);
  if (toIso) q = q.lte('business_date', toIso);
  const { data, error } = await q;
  return error ? fail(error, 'load the daily numbers') : ok(data || []);
}

/** The newest row per site (any date), as a Map by location id. */
export function latestBySite(rows) {
  const m = new Map();
  for (const r of rows || []) if (!m.has(r.location_id)) m.set(r.location_id, r);
  return m;
}

/** Upsert one or many rows (location_id + business_date decide which day). */
export async function saveDailyNumbers(rows, orgId, byName = null) {
  if (isMock || !supabase) return offline();
  const list = Array.isArray(rows) ? rows : [rows];
  if (!list.length) return ok([]);
  const who = await stamp(byName);
  const payload = list.map((r) => ({
    ...r,
    org_id: r.org_id || orgId,
    created_by: who.id,
    created_by_name: who.name,
  }));
  let { data, error } = await supabase.from('hq_daily_numbers').upsert(payload, { onConflict: 'location_id,business_date' }).select();
  // Slice 3 saves `sources` and source 'system'. Until migration 20261202a runs the column is not
  // there (42703 / PGRST204) and 'system' fails the check (23514): save the figures anyway, as typed,
  // and tell the screen so it can say the migration is waiting.
  if (error && (error.code === '42703' || error.code === 'PGRST204' || error.code === '23514') && payload.some((r) => 'sources' in r || 'projected_parts' in r || r.source === 'system')) {
    const older = payload.map(({ sources: _dropped, projected_parts: _parts, ...r }) => ({ ...r, source: r.source === 'system' ? 'typed' : r.source }));
    ({ data, error } = await supabase.from('hq_daily_numbers').upsert(older, { onConflict: 'location_id,business_date' }).select());
    if (!error) return { ...ok(data || []), downgraded: true, message: 'Saved, but where each figure came from was not kept: ask ServOS to run migration 20261202a.' };
  }
  return error ? fail(error, 'save the numbers') : ok(data || []);
}

// ----------------------------------------------------------------------------
// Internal projects
// ----------------------------------------------------------------------------
export async function fetchProjects(orgId, { includeArchived = false } = {}) {
  if (isMock || !supabase) return offline();
  if (!orgId) return ok([]);
  let q = supabase.from('hq_projects').select('*').eq('org_id', orgId).order('updated_at', { ascending: false }).limit(1000);
  if (!includeArchived) q = q.is('archived_at', null);
  const { data, error } = await q;
  return error ? fail(error, 'load the projects') : ok(data || []);
}

export async function saveProject(project, orgId, byName = null) {
  if (isMock || !supabase) return offline();
  const who = await stamp(byName);
  const row = {
    org_id: project.org_id || orgId,
    location_id: project.location_id || null,
    name: String(project.name || '').trim(),
    description: project.description || null,
    department: project.department || 'operations',
    status: project.status || 'planning',
    owner_id: project.owner_id || null,
    owner_name: project.owner_name || null,
    start_date: project.start_date || null,
    due_date: project.due_date || null,
    phases: Array.isArray(project.phases) ? project.phases : [],
    archived_at: project.archived_at || null,
  };
  if (!row.name) return { data: null, error: new Error('name'), absent: false, message: 'Give the project a name.' };
  let res;
  if (project.id) res = await supabase.from('hq_projects').update(row).eq('id', project.id).select().single();
  else res = await supabase.from('hq_projects').insert({ ...row, created_by: who.id, created_by_name: who.name }).select().single();
  return res.error ? fail(res.error, 'save the project') : ok(res.data);
}

/** Tasks for one project, or for every project in the company when projectId is null. */
export async function fetchTasks(orgId, projectId = null) {
  if (isMock || !supabase) return offline();
  if (!orgId) return ok([]);
  let q = supabase.from('hq_tasks').select('*').eq('org_id', orgId).order('sort_order').order('created_at').limit(5000);
  if (projectId) q = q.eq('project_id', projectId);
  const { data, error } = await q;
  return error ? fail(error, 'load the tasks') : ok(data || []);
}

export async function saveTask(task, orgId, byName = null) {
  if (isMock || !supabase) return offline();
  const who = await stamp(byName);
  const row = {
    org_id: task.org_id || orgId,
    project_id: task.project_id,
    parent_task_id: task.parent_task_id || null,
    title: String(task.title || '').trim(),
    description: task.description || null,
    status: task.status || 'todo',
    priority: task.priority || 'P2',
    owner_id: task.owner_id || null,
    owner_name: task.owner_name || null,
    phase: task.phase || null,
    start_date: task.start_date || null,
    due_date: task.due_date || null,
    depends_on_id: task.depends_on_id || null,
    blocked_reason: task.status === 'blocked' ? (task.blocked_reason || null) : null,
    sort_order: Number.isFinite(Number(task.sort_order)) ? Number(task.sort_order) : 0,
    completed_at: task.status === 'done' ? (task.completed_at || new Date().toISOString()) : null,
  };
  if (!row.title) return { data: null, error: new Error('title'), absent: false, message: 'Give the task a title.' };
  if (!row.project_id) return { data: null, error: new Error('project'), absent: false, message: 'The task needs a project.' };
  let res;
  if (task.id) res = await supabase.from('hq_tasks').update(row).eq('id', task.id).select().single();
  else res = await supabase.from('hq_tasks').insert({ ...row, created_by: who.id, created_by_name: who.name }).select().single();
  return res.error ? fail(res.error, 'save the task') : ok(res.data);
}

export async function deleteTask(taskId) {
  if (isMock || !supabase) return offline();
  const { error } = await supabase.from('hq_tasks').delete().eq('id', taskId);
  return error ? fail(error, 'delete the task') : ok(true);
}

/** Updates for one project (newest first), or the newest few for every project in the company. */
export async function fetchUpdates(orgId, projectId = null, limit = 200) {
  if (isMock || !supabase) return offline();
  if (!orgId) return ok([]);
  let q = supabase.from('hq_project_updates').select('*').eq('org_id', orgId).order('created_at', { ascending: false }).limit(projectId ? limit : 2000);
  if (projectId) q = q.eq('project_id', projectId);
  const { data, error } = await q;
  return error ? fail(error, 'load the updates') : ok(data || []);
}

export async function addUpdate({ projectId, taskId = null, body, kind = 'update' }, orgId, byName = null) {
  if (isMock || !supabase) return offline();
  const text = String(body || '').trim();
  if (!text) return { data: null, error: new Error('body'), absent: false, message: 'Write the update first.' };
  const who = await stamp(byName);
  const { data, error } = await supabase.from('hq_project_updates')
    .insert({ project_id: projectId, task_id: taskId, org_id: orgId, kind, body: text, author_id: who.id, author_name: who.name })
    .select().single();
  return error ? fail(error, 'post the update') : ok(data);
}

// ----------------------------------------------------------------------------
// Weekly check ins
// ----------------------------------------------------------------------------
/** The company's questions (defaults when none are stored). */
export async function fetchQuestions(orgId) {
  if (isMock || !supabase) return offline();
  if (!orgId) return ok(normaliseQuestions(null));
  const { data, error } = await supabase.from('hq_checkin_questions').select('questions').eq('org_id', orgId).maybeSingle();
  if (error) return fail(error, 'load the questions');
  return ok(normaliseQuestions(data?.questions));
}

export async function saveQuestions(orgId, questions) {
  if (isMock || !supabase) return offline();
  const who = await stamp();
  const { data, error } = await supabase.from('hq_checkin_questions')
    .upsert({ org_id: orgId, questions: normaliseQuestions(questions), updated_by: who.id, updated_at: new Date().toISOString() }, { onConflict: 'org_id' })
    .select().single();
  return error ? fail(error, 'save the questions') : ok(normaliseQuestions(data?.questions));
}

/** Send (or resend) this week's check in. One row per person, week, department and site. */
export async function sendCheckin({ department, locationId = null, answers, weekStart = null, questions = null }, orgId, byName = null) {
  if (isMock || !supabase) return offline();
  const qs = normaliseQuestions(questions);
  const cleaned = cleanAnswers(answers, qs);
  if (!Object.keys(cleaned).length) return { data: null, error: new Error('empty'), absent: false, message: 'Answer at least one question.' };
  const who = await stamp(byName);
  if (!who.id) return offline();
  const week = weekStart || weekStartIso(new Date());
  const row = {
    org_id: orgId, week_start: week, department: department || 'operations', location_id: locationId || null,
    author_id: who.id, author_name: who.name, answers: cleaned, score: scoreOf(cleaned, qs),
  };
  // Upsert on the unique index: the same person, week, department and site replaces the earlier send.
  const existing = await supabase.from('hq_checkins').select('id').eq('author_id', who.id).eq('week_start', week)
    .eq('department', row.department).filter('location_id', locationId ? 'eq' : 'is', locationId || null).maybeSingle();
  if (existing.error) return fail(existing.error, 'send the check in');
  const res = existing.data?.id
    ? await supabase.from('hq_checkins').update({ answers: row.answers, score: row.score, author_name: row.author_name }).eq('id', existing.data.id).select().single()
    : await supabase.from('hq_checkins').insert(row).select().single();
  return res.error ? fail(res.error, 'send the check in') : ok(res.data);
}

/** The check ins this login may read (the database decides): newest week first. */
export async function fetchCheckins(orgId, { weeks = 12 } = {}) {
  if (isMock || !supabase) return offline();
  if (!orgId) return ok([]);
  const since = new Date(); since.setDate(since.getDate() - weeks * 7);
  const { data, error } = await supabase.from('hq_checkins').select('*').eq('org_id', orgId)
    .gte('week_start', since.toISOString().slice(0, 10)).order('week_start', { ascending: false }).order('created_at', { ascending: false }).limit(1000);
  return error ? fail(error, 'load the check ins') : ok(data || []);
}

/** Is this login an owner of the company (the database's own answer)? */
export async function isCompanyOwner(orgId) {
  if (isMock || !supabase || !orgId) return false;
  try {
    const { data, error } = await supabase.rpc('hq_is_company_owner', { p_org: orgId });
    return !error && data === true;
  } catch { return false; }
}

// ----------------------------------------------------------------------------
// Reviews: the real rating when the venue runs our review card.
// ----------------------------------------------------------------------------
/** { locationId: { avg, count } } over the last `days`, from review_feedback; empty when none. */
export async function fetchRatings(locationIds, days = 7) {
  if (isMock || !supabase) return ok({});
  const ids = (locationIds || []).filter(Boolean);
  if (!ids.length) return ok({});
  const since = new Date(); since.setDate(since.getDate() - days);
  const { data, error } = await supabase.from('review_feedback').select('location_id, rating').in('location_id', ids)
    .gte('created_at', since.toISOString()).limit(5000);
  if (error) return ok({});
  const out = {};
  for (const r of data || []) {
    const n = Number(r.rating);
    if (!Number.isFinite(n)) continue;
    const o = out[r.location_id] || (out[r.location_id] = { sum: 0, count: 0 });
    o.sum += n; o.count += 1;
  }
  for (const k of Object.keys(out)) { out[k] = { avg: Math.round((out[k].sum / out[k].count) * 100) / 100, count: out[k].count }; }
  return ok(out);
}

// ============================================================================
// Slice 2 (20261201a): targets, the safe and banking, the Operations figures.
// ============================================================================

export const NOT_SET_UP_2 = 'The safe, banking and targets are not set up in the database yet. Ask ServOS to run migration 20261201a.';
const fail2 = (error, what) => (isAbsentError(error)
  ? { data: null, error, absent: true, message: NOT_SET_UP_2 }
  : { data: null, error, absent: false, message: `Could not ${what}. Try again.` });

// ----------------------------------------------------------------------------
// Venue clocks: one read per site, cached for the session.
// ----------------------------------------------------------------------------
const _clocks = new Map();
/** { [locationId]: { timezone, businessDayStart, today, nowMin } } on each venue's own clock. */
export async function fetchVenueClocks(locationIds) {
  const out = {};
  await Promise.all((locationIds || []).filter(Boolean).map(async (id) => {
    let clock = _clocks.get(id);
    if (!clock) {
      try { clock = await getVenueClock(id); } catch { clock = { timezone: 'Europe/London', businessDayStart: '06:00' }; }
      _clocks.set(id, clock);
    }
    const now = Date.now();
    const ctx = buildScheduleCtx(clock.timezone, new Date(now));
    out[id] = { ...clock, today: businessDayOf(now, clock.timezone, clock.businessDayStart) || ctx.ymd, calendarToday: ctx.ymd, nowMin: ctx.nowMinutes };
  }));
  return out;
}
/** The business date of an instant on a site's clock ('YYYY-MM-DD'). */
export function businessDateFor(iso, clock) {
  if (!iso) return null;
  return businessDayOf(iso, clock?.timezone || 'Europe/London', clock?.businessDayStart || '06:00');
}

// ----------------------------------------------------------------------------
// Targets
// ----------------------------------------------------------------------------
export async function fetchTargets(orgId) {
  if (isMock || !supabase) return offline();
  if (!orgId) return ok([]);
  const { data, error } = await supabase.from('hq_targets').select('*').eq('org_id', orgId).limit(500);
  return error ? fail2(error, 'load the targets') : ok(data || []);
}
/** Insert or replace the band for (site or company, metric). */
export async function saveTarget({ location_id = null, metric, green_to, amber_to }, orgId, byName = null) {
  if (isMock || !supabase) return offline();
  const who = await stamp(byName);
  const row = { org_id: orgId, location_id: location_id || null, metric, green_to, amber_to, created_by: who.id, created_by_name: who.name };
  const { data, error } = await supabase.from('hq_targets').upsert(row, { onConflict: 'org_id,location_id,metric' }).select().maybeSingle();
  return error ? fail2(error, 'save the target') : ok(data);
}
export async function deleteTarget(id) {
  if (isMock || !supabase) return offline();
  const { error } = await supabase.from('hq_targets').delete().eq('id', id);
  return error ? fail2(error, 'remove the target') : ok(true);
}

// ----------------------------------------------------------------------------
// The till's cash events (drawer_sessions, cash_movements, cash_drawers), read only here.
// ----------------------------------------------------------------------------
/** Drawer sessions for the sites since an instant, with the drawer's name on each. */
export async function fetchDrawerSessions(locationIds, sinceIso) {
  if (isMock || !supabase) return offline();
  const ids = (locationIds || []).filter(Boolean);
  if (!ids.length) return ok([]);
  const [s, d] = await Promise.all([
    supabase.from('drawer_sessions').select('id, drawer_id, location_id, cash_in_at, opening_float, cash_out_at, declared_cash, expected_cash, variance, status')
      .in('location_id', ids).gte('cash_in_at', sinceIso).order('cash_in_at', { ascending: false }).limit(2000),
    supabase.from('cash_drawers').select('id, name, location_id').in('location_id', ids).limit(500),
  ]);
  if (s.error) return { data: null, error: s.error, absent: false, message: 'Could not read the till drawers.' };
  const names = new Map((d.data || []).map((r) => [r.id, r.name]));
  return ok((s.data || []).map((r) => ({ ...r, drawer_name: names.get(r.drawer_id) || null })));
}
/** The till's "Cash drop to safe" movements for the sites since an instant. */
export async function fetchTillDrops(locationIds, sinceIso) {
  if (isMock || !supabase) return offline();
  const ids = (locationIds || []).filter(Boolean);
  if (!ids.length) return ok([]);
  const { data, error } = await supabase.from('cash_movements').select('id, location_id, timestamp, type, amount, drawer_id, session_id, staff_name, reason, note')
    .in('location_id', ids).in('type', ['cash_drop', 'drop']).gte('timestamp', sinceIso).order('timestamp', { ascending: false }).limit(2000);
  return error ? { data: null, error, absent: false, message: 'Could not read the till drops.' } : ok(data || []);
}

// ----------------------------------------------------------------------------
// The safe: movements, counts, deposits
// ----------------------------------------------------------------------------
export async function fetchSafeMovements(locationIds) {
  if (isMock || !supabase) return offline();
  const ids = (locationIds || []).filter(Boolean);
  if (!ids.length) return ok([]);
  const { data, error } = await supabase.from('hq_safe_movements').select('*').in('location_id', ids)
    .order('business_date', { ascending: false }).order('created_at', { ascending: false }).limit(5000);
  return error ? fail2(error, 'load the safe') : ok(data || []);
}
/** Append movements (rows from movementsFromItems, or one adjustment / petty / other). 23505 = already posted. */
export async function addSafeMovements(rows, orgId, byName = null) {
  if (isMock || !supabase) return offline();
  const list = (Array.isArray(rows) ? rows : [rows]).filter(Boolean);
  if (!list.length) return ok([]);
  const who = await stamp(byName);
  const payload = list.map((r) => ({ ...r, org_id: r.org_id || orgId, created_by: who.id, created_by_name: r.created_by_name || who.name }));
  const { data, error } = await supabase.from('hq_safe_movements').insert(payload).select();
  if (error?.code === '23505') return { data: null, error, absent: false, message: 'Some of this was already put in the safe by someone else. Refresh and look again.' };
  return error ? fail2(error, 'post to the safe') : ok(data || []);
}
export async function fetchSafeCounts(locationIds, limit = 200) {
  if (isMock || !supabase) return offline();
  const ids = (locationIds || []).filter(Boolean);
  if (!ids.length) return ok([]);
  const { data, error } = await supabase.from('hq_safe_counts').select('*').in('location_id', ids).order('created_at', { ascending: false }).limit(limit);
  return error ? fail2(error, 'load the safe counts') : ok(data || []);
}
/** Record a count; when `adjustment` is given (from countOutcome) the ledger moves to match in the same go. */
export async function addSafeCount({ location_id, business_date, counted_total, expected_total, denominations = null, note = null, adjustment = null }, orgId, byName = null) {
  if (isMock || !supabase) return offline();
  const who = await stamp(byName);
  const { data, error } = await supabase.from('hq_safe_counts')
    .insert({ org_id: orgId, location_id, business_date, counted_total, expected_total, denominations, note, created_by: who.id, created_by_name: who.name }).select().maybeSingle();
  if (error) return fail2(error, 'save the count');
  if (adjustment && data?.id) {
    const adj = await addSafeMovements([{ location_id, business_date, kind: 'adjustment', amount: adjustment.amount, ref_kind: 'count', ref_id: data.id, note: adjustment.note }], orgId, byName);
    if (adj.error) return { data, error: adj.error, absent: false, message: 'The count saved but the adjustment did not. Add it from the safe page.' };
  }
  return ok(data);
}
export async function fetchDeposits(locationIds, limit = 300) {
  if (isMock || !supabase) return offline();
  const ids = (locationIds || []).filter(Boolean);
  if (!ids.length) return ok([]);
  const { data, error } = await supabase.from('hq_bank_deposits').select('*').in('location_id', ids).order('business_date', { ascending: false }).order('created_at', { ascending: false }).limit(limit);
  return error ? fail2(error, 'load the deposits') : ok(data || []);
}
/** Prepare a bag: the deposit row and its bank_out movement, in that order. */
export async function prepareDeposit({ location_id, business_date, amount, bag_reference = null, bank_label = null, note = null }, orgId, byName = null) {
  if (isMock || !supabase) return offline();
  const who = await stamp(byName);
  const { data, error } = await supabase.from('hq_bank_deposits')
    .insert({ org_id: orgId, location_id, business_date, amount, bag_reference, bank_label, note, created_by: who.id, created_by_name: who.name }).select().maybeSingle();
  if (error) return fail2(error, 'prepare the deposit');
  const mv = await addSafeMovements([{ location_id, business_date, kind: 'bank_out', amount: -Math.abs(Number(amount)), ref_kind: 'deposit', ref_id: data.id,
    note: bag_reference ? `Bag ${bag_reference}` : 'To the bank' }], orgId, byName);
  if (mv.error) return { data, error: mv.error, absent: false, message: 'The deposit saved but the safe did not move. Refresh and check the balance.' };
  return ok(data);
}
/** Move a deposit on: banked, confirmed, or cancelled (a cancel puts the cash back with an adjustment). */
export async function setDepositStatus(deposit, status, orgId, byName = null) {
  if (isMock || !supabase) return offline();
  const who = await stamp(byName);
  const patch = { status };
  if (status === 'banked') patch.banked_at = new Date().toISOString();
  if (status === 'confirmed') { patch.confirmed_at = new Date().toISOString(); patch.confirmed_by_name = who.name; }
  const { data, error } = await supabase.from('hq_bank_deposits').update(patch).eq('id', deposit.id).select().maybeSingle();
  if (error) return fail2(error, 'update the deposit');
  if (status === 'cancelled') {
    const back = await addSafeMovements([{ location_id: deposit.location_id, business_date: deposit.business_date, kind: 'adjustment', amount: Math.abs(Number(deposit.amount)),
      ref_kind: 'deposit', ref_id: `${deposit.id}:cancel`, note: `Deposit ${deposit.bag_reference || ''} cancelled, cash back in the safe`.replace('  ', ' ') }], orgId, byName);
    if (back.error) return { data, error: back.error, absent: false, message: 'The deposit was cancelled but the cash did not go back on the ledger. Add an adjustment.' };
  }
  return ok(data);
}

/** Everything the Safe page and the cash tiles need for a set of sites, in one go. */
export async function fetchCashForSites(locationIds, { sinceDays = 45 } = {}) {
  const ids = (locationIds || []).filter(Boolean);
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const [movements, counts, deposits, sessions, drops, clocks] = await Promise.all([
    fetchSafeMovements(ids), fetchSafeCounts(ids), fetchDeposits(ids), fetchDrawerSessions(ids, since), fetchTillDrops(ids, since), fetchVenueClocks(ids),
  ]);
  const absent = !!(movements.absent || counts.absent || deposits.absent);
  const first = [movements, counts, deposits, sessions, drops].find((r) => r.error);
  return {
    data: { movements: movements.data || [], counts: counts.data || [], deposits: deposits.data || [], sessions: sessions.data || [], drops: drops.data || [], clocks },
    error: first?.error || null, absent, message: absent ? NOT_SET_UP_2 : (first?.message || null),
  };
}

// ----------------------------------------------------------------------------
// The Operations rows the scorecard counts from (read only, the module's own tables).
// ----------------------------------------------------------------------------
/**
 * fetchOpsRows(locationIds, fromYmd, toYmd): { checklists, runs, schedules, readings, maintenance, clocks }.
 * Readings are stamped with ymd and minute on their site's clock, so opsStats can group them.
 * A database without the Operations module answers empty lists, never an error.
 */
export async function fetchOpsRows(locationIds, fromYmd, toYmd) {
  if (isMock || !supabase) return offline();
  const ids = (locationIds || []).filter(Boolean);
  if (!ids.length) return ok({ checklists: [], runs: [], schedules: [], readings: [], maintenance: [], clocks: {} });
  const clocks = await fetchVenueClocks(ids);
  const fromIso = new Date(Date.UTC(+fromYmd.slice(0, 4), +fromYmd.slice(5, 7) - 1, +fromYmd.slice(8, 10) - 1)).toISOString();
  const soft = (p) => p.then((r) => (r.error ? [] : (r.data || []))).catch(() => []);
  const [checklists, runs, schedules, readings, maintenance] = await Promise.all([
    soft(supabase.from('ops_checklists').select('id, location_id, area, frequency, days_of_week, day_of_month, time_of_day, grace_minutes, active, archived_at').in('location_id', ids).eq('active', true).is('archived_at', null).limit(2000)),
    soft(supabase.from('ops_checklist_runs').select('checklist_id, location_id, run_date, status, completed_at').in('location_id', ids).gte('run_date', fromYmd).lte('run_date', toYmd).limit(5000)),
    soft(supabase.from('temp_check_schedules').select('id, temp_unit_id, location_id, frequency, days_of_week, time_of_day, grace_minutes, active').in('location_id', ids).eq('active', true).limit(2000)),
    soft(supabase.from('temp_readings').select('temp_unit_id, schedule_id, location_id, in_range, severity, recorded_at').in('location_id', ids).gte('recorded_at', fromIso).limit(10000)),
    soft(supabase.from('maintenance_requests').select('id, location_id, status, priority, created_at').in('location_id', ids).in('status', ['open', 'assigned', 'in_progress']).limit(2000)),
  ]);
  const stamped = readings.map((r) => {
    const tz = clocks[r.location_id]?.timezone || 'Europe/London';
    return { ...r, ymd: ymdInTz(r.recorded_at, tz), minute: minutesInTz(r.recorded_at, tz) };
  });
  return ok({ checklists, runs, schedules, readings: stamped, maintenance, clocks });
}

// ============================================================================
// Slice 3: the system's own figures for one site and one business day, so Daily numbers shows
// what ServOS already knows and only takes an override.
// ============================================================================

const TRADING_TIMEOUT_MS = 20000;

/**
 * One business day from the Daily trading P&L function (supabase/functions/trading-report), the
 * same rule the Daily trading report and the Owner snapshot use: net sales ex VAT after refunds,
 * labour from approved and paid timesheets, COGS on the venue's basis (recipe ledger or flat %).
 * Returns { data: { row, settings, tz, dayStart, demoLeftOut } } or an error with words for the screen.
 * The function only answers for a site the login is attached to (user_locations) or a super admin;
 * a company owner who reaches the site through the organisation alone gets a 403 and the words say so.
 */
export async function fetchTradingDay(locationId, ymd) {
  if (isMock || !supabase) return offline();
  if (!locationId || !ymd) return ok(null);
  try {
    const { data, error } = await withTimeout(
      supabase.functions.invoke('trading-report', { body: { action: 'get', ops_location_id: locationId, from: ymd, to: ymd } }),
      TRADING_TIMEOUT_MS, 'trading-report',
    );
    if (error) {
      let body = null; try { body = await error.context?.json?.(); } catch { /* no body */ }
      const status = error.context?.status;
      const words = status === 403 || /forbidden|not allowed/i.test(String(body?.error || ''))
        ? 'Your login is not attached to this site, so the till figures cannot be read here. Type them, or ask ServOS to attach the site.'
        : 'Could not reach the till figures for this day. You can still type them.';
      return { data: null, error, absent: false, message: words };
    }
    if (data?.error) return { data: null, error: new Error(data.error), absent: false, message: 'Could not reach the till figures for this day. You can still type them.' };
    const row = (data?.rows || []).find((r) => r.date === ymd) || data?.rows?.[0] || null;
    return ok({ row, settings: data?.settings || null, tz: data?.tz || null, dayStart: data?.day_start || null, demoLeftOut: !!data?.demo_left_out });
  } catch (e) {
    return { data: null, error: e, absent: false, message: 'The till figures took too long. You can still type them.' };
  }
}

/** The venue's service periods and clock for one site: { timezone, businessDayStart, shifts }. */
async function siteConfig(locationId) {
  try {
    const cfg = await getLocationConfig(locationId);
    return { timezone: cfg?.timezone || 'Europe/London', businessDayStart: cfg?.businessDayStart || '06:00', shifts: Array.isArray(cfg?.shifts) ? cfg.shifts : [] };
  } catch { return { timezone: 'Europe/London', businessDayStart: '06:00', shifts: [] }; }
}

const PATTERN_WEEKS = 4;

/**
 * Every raw row the system holds for one site and one business day, for systemDay.js systemFields:
 *   { trading, settings, forecastHours, patternChecks, reviews, cardCount, staff, shifts, dayStartMin, today, demoLeftOut, problems[] }
 * Each read is soft: one that fails leaves its figure blank and adds a line to problems.
 */
export async function fetchSystemDay(locationId, ymd) {
  if (isMock || !supabase) return offline();
  if (!locationId || !ymd) return ok(null);
  // A date box emits half typed years ("0002-11-17") on the way to a real date: answer softly, never throw.
  if (!isYmd(ymd)) return { data: null, error: new Error('date'), absent: false, message: 'Pick a real date.' };
  try {
    return await readSystemDay(locationId, ymd);
  } catch (e) {
    return { data: null, error: e, absent: false, message: 'The system figures could not be read for this day. You can still type them.' };
  }
}

async function readSystemDay(locationId, ymd) {
  const problems = [];
  const cfg = await siteConfig(locationId);
  const tz = cfg.timezone; const dayStart = cfg.businessDayStart;
  const win = businessDayWindow(ymd, tz, dayStart);
  const today = businessDayOf(Date.now(), tz, dayStart);
  const dayStartMin = dayStartMinutes(dayStart);

  // The same four weekdays before this one, for the daypart pattern.
  const patternWindows = [];
  for (let w = 1; w <= PATTERN_WEEKS; w += 1) patternWindows.push(businessDayWindow(addYmd(ymd, -7 * w), tz, dayStart));

  const [tradingRes, hoursRes, patternRes, reviewsRes, staffRes] = await Promise.all([
    fetchTradingDay(locationId, ymd),
    supabase.from('stock_forecast_hours').select('hour, amount').eq('location_id', locationId).eq('business_day', ymd).then((r) => r, (e) => ({ error: e })),
    // PostgREST answers at most 1000 rows whatever the limit says; a day with more checks than that
    // (rare) loses its earliest ones, newest first, so the evening pattern is kept.
    Promise.all(patternWindows.map((pw) => supabase.from('closed_checks').select('closed_at, total, voided, status').eq('location_id', locationId)
      .gte('closed_at', pw.fromIso).lt('closed_at', pw.toIso).not('id', 'like', 'demo-%').order('closed_at', { ascending: false }).limit(1000).then((r) => r, (e) => ({ error: e })))),
    supabase.from('review_feedback').select('rating, origin').eq('location_id', String(locationId))
      .gte('created_at', win.fromIso).lt('created_at', win.toIso).limit(2000).then((r) => r, (e) => ({ error: e })),
    supabase.from('wf_staff').select('id, status, start_date, leaver_date, created_at').eq('location_id', locationId).limit(5000).then((r) => r, (e) => ({ error: e })),
  ]);

  if (tradingRes.error) problems.push(tradingRes.message);
  const trading = tradingRes.data?.row || null;
  const settings = tradingRes.data?.settings || null;

  const forecastHours = hoursRes?.error ? [] : (hoursRes?.data || []);
  const patternChecks = [];
  let patternFailed = false;
  for (const r of patternRes || []) {
    if (r?.error) { patternFailed = true; continue; }
    for (const c of r?.data || []) patternChecks.push({ minutes: minutesInTz(c.closed_at, tz), total: c.total, voided: c.voided, status: c.status });
  }
  if (patternFailed && !patternChecks.length) problems.push('The till history for the daypart split could not be read.');

  let reviews = []; let cardCount = 0;
  if (reviewsRes?.error) problems.push('Reviews could not be read.');
  else {
    for (const r of reviewsRes?.data || []) { if (r.origin === 'synced') reviews.push(r); else cardCount += 1; }
  }
  if (staffRes?.error) problems.push('Workforce staff could not be read.');
  const staff = staffRes?.error ? [] : (staffRes?.data || []);

  return ok({ trading, settings, forecastHours, patternChecks, reviews, cardCount, staff, shifts: cfg.shifts, dayStartMin, today, timezone: tz, currency: settings?.currency || null, demoLeftOut: !!tradingRes.data?.demoLeftOut, problems });
}
