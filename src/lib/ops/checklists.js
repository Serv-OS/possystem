/**
 * ops/checklists.js — data layer for task management / checklists (slice 4).
 * Templates live in ops_checklists/_tasks; a day's run in ops_checklist_runs with
 * per-task ops_task_completions. "Due today" is derived from the schedule + whether a
 * run is complete, using the same engine as temperature (runsOnDay/windowStatus).
 */

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { runsOnDay, hhmmToMin, windowStatus } from './temp.js';

const nowIso = () => new Date().toISOString();
const ymd = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
async function ensureLoc(locationId) {
  if (!locationId || locationId === 'loc-demo') locationId = getActiveLocationSync();
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return null;
  return locationId;
}

const clFromRow = (r) => ({
  id: r.id, locationId: r.location_id, name: r.name, area: r.area, frequency: r.frequency,
  daysOfWeek: Array.isArray(r.days_of_week) ? r.days_of_week : [], timeOfDay: r.time_of_day,
  graceMinutes: r.grace_minutes, assigneeRole: r.assignee_role, active: r.active !== false, archivedAt: r.archived_at,
});
const taskFromRow = (r) => ({
  id: r.id, checklistId: r.checklist_id, label: r.label, sortOrder: r.sort_order, taskType: r.task_type,
  evidenceRequired: r.evidence_required === true, tempUnitId: r.temp_unit_id, active: r.active !== false,
});
const runFromRow = (r) => ({ id: r.id, checklistId: r.checklist_id, runDate: r.run_date, status: r.status, completedByName: r.completed_by_name, completedAt: r.completed_at });
const complFromRow = (r) => ({ id: r.id, runId: r.run_id, taskId: r.task_id, done: r.done, valueText: r.value_text, photoUrl: r.photo_url, completedByName: r.completed_by_name, completedAt: r.completed_at });

// ── templates (admin) ─────────────────────────────────────────────────────────
export const fetchChecklists = async (locationId = null, includeArchived = false) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  let q = supabase.from('ops_checklists').select('*').eq('location_id', locationId).order('area').order('name');
  if (!includeArchived) q = q.is('archived_at', null);
  const [{ data: lists, error }, { data: tasks }] = await Promise.all([
    q, supabase.from('ops_checklist_tasks').select('*').eq('location_id', locationId).eq('active', true).order('sort_order'),
  ]);
  if (error) return { data: [], error };
  const tByList = {}; (tasks || []).forEach(t => { (tByList[t.checklist_id] ??= []).push(taskFromRow(t)); });
  return { data: (lists || []).map(l => ({ ...clFromRow(l), tasks: tByList[l.id] || [] })), error: null };
};
export const upsertChecklist = async (checklist, tasks, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const row = {
    ...(checklist.id ? { id: checklist.id } : {}), location_id: locationId, org_id: checklist.orgId || null,
    name: (checklist.name || '').trim(), area: checklist.area || 'BOH', frequency: checklist.frequency || 'daily',
    days_of_week: Array.isArray(checklist.daysOfWeek) ? checklist.daysOfWeek : [], time_of_day: checklist.timeOfDay || null,
    grace_minutes: checklist.graceMinutes ?? 120, assignee_role: checklist.assigneeRole || null, active: checklist.active !== false, updated_at: nowIso(),
  };
  const { data: saved, error } = await supabase.from('ops_checklists').upsert(row).select().maybeSingle();
  if (error || !saved) return { data: null, error: error || new Error('Save failed') };
  // replace tasks
  await supabase.from('ops_checklist_tasks').delete().eq('location_id', locationId).eq('checklist_id', saved.id);
  const taskRows = (tasks || []).filter(t => (t.label || '').trim()).map((t, i) => ({
    location_id: locationId, checklist_id: saved.id, label: t.label.trim(), sort_order: i,
    task_type: t.taskType || 'check', evidence_required: t.evidenceRequired === true, temp_unit_id: t.tempUnitId || null, active: true,
  }));
  if (taskRows.length) await supabase.from('ops_checklist_tasks').insert(taskRows);
  return { data: clFromRow(saved), error: null };
};
export const archiveChecklist = async (id, locationId = null) => {
  locationId = await ensureLoc(locationId);
  return supabase.from('ops_checklists').update({ archived_at: nowIso() }).eq('location_id', locationId).eq('id', id);
};

// ── operational: today's checklists with run + completion status ──────────────
export const fetchTodayChecklists = async (locationId = null) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  const today = ymd(new Date()); const now = new Date(); const nowMin = now.getHours() * 60 + now.getMinutes();
  const { data: lists } = await fetchChecklists(locationId);
  const due = (lists || []).filter(l => runsOnDay(l.daysOfWeek, now));
  const ids = due.map(l => l.id);
  const [{ data: runs }, { data: compls }] = await Promise.all([
    supabase.from('ops_checklist_runs').select('*').eq('location_id', locationId).eq('run_date', today).in('checklist_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']),
    supabase.from('ops_task_completions').select('*').eq('location_id', locationId).gte('completed_at', today + 'T00:00:00'),
  ]);
  const runByList = {}; (runs || []).forEach(r => { runByList[r.checklist_id] = runFromRow(r); });
  const complByRun = {}; (compls || []).forEach(c => { (complByRun[c.run_id] ??= []).push(complFromRow(c)); });
  return {
    data: due.map(l => {
      const run = runByList[l.id] || null;
      const done = run ? (complByRun[run.id] || []).filter(c => c.done).length : 0;
      const total = l.tasks.length;
      const wMin = l.timeOfDay ? hhmmToMin(l.timeOfDay) : null;
      const status = run?.status === 'complete' ? 'done'
        : wMin == null ? (done > 0 ? 'due' : 'due')
        : windowStatus({ windowMin: wMin, graceMin: l.graceMinutes, nowMin, satisfied: run?.status === 'complete' });
      return { ...l, run, completions: run ? (complByRun[run.id] || []) : [], doneCount: done, total, status };
    }),
    error: null,
  };
};

/** Open (or fetch) today's run for a checklist. */
export const openRun = async (checklistId, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const today = ymd(new Date());
  const { data, error } = await supabase.from('ops_checklist_runs')
    .upsert({ location_id: locationId, checklist_id: checklistId, run_date: today, status: 'open' }, { onConflict: 'location_id,checklist_id,run_date' })
    .select().maybeSingle();
  return { data: data ? runFromRow(data) : null, error };
};
export const completeTask = async (runId, taskId, { done = true, valueText, photoUrl, by, byId }, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  return supabase.from('ops_task_completions').upsert({
    location_id: locationId, run_id: runId, task_id: taskId, done, value_text: valueText || null,
    photo_url: photoUrl || null, completed_by: byId || null, completed_by_name: by || null, completed_at: nowIso(),
  }, { onConflict: 'run_id,task_id' });
};
export const signOffRun = async (runId, by, byId, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  const { error } = await supabase.from('ops_checklist_runs').update({ status: 'complete', completed_by: byId || null, completed_by_name: by || null, completed_at: nowIso() }).eq('location_id', locationId).eq('id', runId);
  if (!error) await supabase.from('ops_audit').insert({ location_id: locationId, actor_id: byId || null, actor_name: by || null, action: 'checklist_signoff', entity_type: 'ops_checklist_run', entity_id: runId });
  return { error };
};

/** Completion records over a range, for compliance/history. */
export const fetchRunsRange = async (fromYmd, toYmd, locationId = null) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  const { data, error } = await supabase.from('ops_checklist_runs').select('*').eq('location_id', locationId).gte('run_date', fromYmd).lte('run_date', toYmd).order('run_date', { ascending: false });
  return { data: (data || []).map(runFromRow), error };
};
