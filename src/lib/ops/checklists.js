/**
 * ops/checklists.js — data layer for task management / checklists (slice 4).
 * Templates live in ops_checklists/_tasks; a day's run in ops_checklist_runs with
 * per-task ops_task_completions. "Due today" is derived from the schedule + whether a
 * run is complete, using the same engine as temperature (runsOnDay/windowStatus).
 */

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { hhmmToMin, windowStatus } from './temp.js';
import { isTrainingMode } from '../trainingMode';
import { getLocationConfig, buildScheduleCtx } from '../locationTime';

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
  dayOfMonth: r.day_of_month ?? null,
  graceMinutes: r.grace_minutes, assigneeRole: r.assignee_role, active: r.active !== false, archivedAt: r.archived_at,
  updatedAt: r.updated_at,
});
const taskFromRow = (r) => ({
  id: r.id, checklistId: r.checklist_id, label: r.label, sortOrder: r.sort_order, taskType: r.task_type,
  evidenceRequired: r.evidence_required === true, tempUnitId: r.temp_unit_id, active: r.active !== false,
});
const runFromRow = (r) => ({ id: r.id, checklistId: r.checklist_id, runDate: r.run_date, status: r.status, completedByName: r.completed_by_name, completedAt: r.completed_at });
const complFromRow = (r) => ({ id: r.id, runId: r.run_id, taskId: r.task_id, done: r.done, valueText: r.value_text, photoUrl: r.photo_url, completedByName: r.completed_by_name, completedAt: r.completed_at });

// ── Evidence photos live in the PRIVATE 'ops-evidence' bucket (v5.5.756). The stored
// photo_url is a bucket PATH (<location_id>/<run_id>/<task_id>.<ext>); we mint short-lived
// signed URLs on read so thumbnails render without the bucket being world-readable. Legacy
// rows hold a full public receipt-assets URL — those pass through untouched.
const EVIDENCE_BUCKET = 'ops-evidence';
const signCompletions = async (compls) => {
  if (isMock || !supabase || !compls?.length) return compls;
  const paths = [...new Set(compls.map(c => c.photoUrl).filter(u => u && !/^https?:\/\//.test(u)))];
  if (!paths.length) return compls;
  const map = {};
  try {
    const { data } = await supabase.storage.from(EVIDENCE_BUCKET).createSignedUrls(paths, 3600);
    (data || []).forEach(d => { if (d?.path && d?.signedUrl) map[d.path] = d.signedUrl; });
  } catch { /* leave the raw path — the thumbnail just won't load */ }
  return compls.map(c => (c.photoUrl && map[c.photoUrl]) ? { ...c, photoUrl: map[c.photoUrl] } : c);
};

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
    day_of_month: checklist.frequency === 'monthly' ? Math.min(28, Math.max(1, Number(checklist.dayOfMonth) || 1)) : null,
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
  // v5.7.22 — "today" is the VENUE's calendar day, "now" the venue's wall
  // clock (project invariant: business-time decisions never read the device
  // clock). A tablet on the wrong OS timezone was showing the wrong day's
  // checklists and mis-timing due/missed windows.
  const ctx = buildScheduleCtx((await getLocationConfig(locationId))?.timezone);
  const today = ctx.ymd; const nowMin = ctx.nowMinutes;
  const jsDow = ctx.isoDay % 7; // ISO 1=Mon..7=Sun → JS 0=Sun..6=Sat (schedule rows store JS dow)
  const runsToday = (days) => !Array.isArray(days) || days.length === 0 || days.includes(jsDow);
  const { data: lists } = await fetchChecklists(locationId);
  // v5.5.971 — the frequency field finally MEANS something:
  //   daily   → weekday chips as before (empty = every day)
  //   weekly  → ONLY the ticked weekdays (no days = never due; the builder now
  //             refuses to save that, and the old silent-daily behaviour was a lie)
  //   monthly → the configured day of month (1-28)
  const dueOn = (l) => {
    if (l.frequency === 'monthly') return Number(today.slice(8, 10)) === (l.dayOfMonth || 1);
    if (l.frequency === 'weekly') return (l.daysOfWeek?.length > 0) && runsToday(l.daysOfWeek);
    return runsToday(l.daysOfWeek);
  };
  const due = (lists || []).filter(dueOn);
  const ids = due.map(l => l.id);
  const [{ data: runs }, { data: compls }] = await Promise.all([
    supabase.from('ops_checklist_runs').select('*').eq('location_id', locationId).eq('run_date', today).in('checklist_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']),
    supabase.from('ops_task_completions').select('*').eq('location_id', locationId).gte('completed_at', today + 'T00:00:00'),
  ]);
  const runByList = {}; (runs || []).forEach(r => { runByList[r.checklist_id] = runFromRow(r); });
  const signedCompls = await signCompletions((compls || []).map(complFromRow));
  const complByRun = {}; signedCompls.forEach(c => { (complByRun[c.runId] ??= []).push(c); });
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
  // TRAINING MODE: never open a real run. Hand back a fake in-memory run that
  // CARRIES AN id, so ChecklistRun can call completeTask(run.id,…) /
  // signOffRun(run.id,…) / uploadChecklistPhoto({runId:run.id,…}) without
  // crashing on run.id — those then no-op too. (Returning null here, like the
  // mock path, would leave run=null and crash sign-off.)
  if (isTrainingMode()) return { data: { id: 'training-run', checklistId, runDate: ymd(new Date()), status: 'open', completedByName: null, completedAt: null }, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  // v5.7.22 — run_date must be the VENUE's calendar day, matching what
  // fetchTodayChecklists queries; a device-clock date here would open the run
  // under a different key than the day view reads.
  const today = buildScheduleCtx((await getLocationConfig(locationId))?.timezone).ymd;
  const { data, error } = await supabase.from('ops_checklist_runs')
    .upsert({ location_id: locationId, checklist_id: checklistId, run_date: today, status: 'open' }, { onConflict: 'location_id,checklist_id,run_date' })
    .select().maybeSingle();
  return { data: data ? runFromRow(data) : null, error };
};
export const completeTask = async (runId, taskId, { done = true, valueText, photoUrl, by, byId }, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  // TRAINING MODE: don't record a real task completion.
  if (isTrainingMode()) return { error: null };
  locationId = await ensureLoc(locationId);
  // v5.5.917 — THIS GUARD IS THE WHOLE BUG. ensureLoc() returns null when the venue cannot be
  // resolved, and every READ path already checks for that. This write did not: it carried on and
  // sent location_id: null, which fails the row-level security check on the table and surfaced to
  // staff as the raw database message "new row violates row-level security policy" under an
  // otherwise working checklist. Nothing was wrong with their permissions — the venue simply had
  // not resolved yet. Fail with something a manager can act on instead.
  if (!locationId) return { error: new Error('Venue not resolved yet — reopen the checklist and try again') };
  if (!runId || !taskId) return { error: new Error('Missing run or task') };
  return supabase.from('ops_task_completions').upsert({
    location_id: locationId, run_id: runId, task_id: taskId, done, value_text: valueText || null,
    photo_url: photoUrl || null, completed_by: byId || null, completed_by_name: by || null, completed_at: nowIso(),
  }, { onConflict: 'run_id,task_id' });
};
export const signOffRun = async (runId, by, byId, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  // TRAINING MODE: don't sign off (or write an ops_audit row for) a live run.
  if (isTrainingMode()) return { error: null };
  locationId = await ensureLoc(locationId);
  // Same guard as completeTask: without it the sign-off silently matched zero rows (the .eq on a
  // null location_id) and then tried to write an audit row with a null location, which RLS
  // refused — so a checklist could LOOK signed off and have recorded nothing.
  if (!locationId) return { error: new Error('Venue not resolved yet — reopen the checklist and try again') };
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

/** Per-task completion records for one or more runs (carries photo evidence), for BO viewing. */
export const fetchRunCompletions = async (runIds, locationId = null) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  const ids = (Array.isArray(runIds) ? runIds : [runIds]).filter(Boolean);
  if (!locationId || ids.length === 0) return { data: [], error: null };
  const { data, error } = await supabase.from('ops_task_completions')
    .select('*').eq('location_id', locationId).in('run_id', ids);
  return { data: await signCompletions((data || []).map(complFromRow)), error };
};

// ── Evidence photos ──────────────────────────────────────────────────────────
// PRIVATE 'ops-evidence' bucket (v5.5.756). Storage RLS lets a paired ops device write
// ONLY under its own <location_id>/ folder (keyed on the ops_devices claim); back office
// reads via user_accessible_locations(). We persist the bucket PATH and hand back a signed
// URL for the immediate thumbnail. Path is stable per task so a re-capture overwrites
// (no orphans). See migration 20260713b_ops_evidence_private_bucket.sql.
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const uploadChecklistPhoto = async (file, { locationId = null, runId, taskId } = {}) => {
  if (isMock || !supabase) return { url: null, path: null, error: new Error('Not connected') };
  // TRAINING MODE: never upload evidence to live storage. Benign return so onPhotoPicked
  // surfaces it gracefully rather than writing a real object.
  if (isTrainingMode()) return { url: null, path: null, error: new Error('Training mode — evidence not saved') };
  if (!file) return { url: null, path: null, error: new Error('No file') };
  if (file.size > MAX_PHOTO_BYTES) return { url: null, path: null, error: new Error('Photo too large — keep it under 10 MB') };
  locationId = await ensureLoc(locationId);
  if (!locationId || !runId || !taskId) return { url: null, path: null, error: new Error('Missing run/task/location') };
  // Desktop browsers can't decode HEIC; capture="environment" yields JPEG anyway.
  const ext = (file.name?.split('.').pop() || 'jpg').toLowerCase().replace('jpeg', 'jpg');
  const safeExt = ['jpg', 'png', 'webp'].includes(ext) ? ext : 'jpg';
  // First path segment = location_id so the storage RLS device fence matches.
  const path = `${locationId}/${runId}/${taskId}.${safeExt}`;
  const { error } = await supabase.storage.from(EVIDENCE_BUCKET).upload(path, file, {
    upsert: true, contentType: file.type || 'image/jpeg', cacheControl: '3600',
  });
  if (error) return { url: null, path: null, error };
  // Signed URL for the immediate thumbnail; the PATH is what we persist (signed URLs expire).
  const { data } = await supabase.storage.from(EVIDENCE_BUCKET).createSignedUrl(path, 3600);
  return { url: data?.signedUrl || null, path, error: null };
};
