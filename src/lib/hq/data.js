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
  const { data, error } = await supabase.from('hq_daily_numbers').upsert(payload, { onConflict: 'location_id,business_date' }).select();
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
