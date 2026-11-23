// src/lib/hq/templates.js
//
// Head office, project templates (slice 6, 18 Nov 2026): a reusable internal project. Pure: the
// shape of a template, a template taken from a finished project, and a project (with real dates)
// made from a template. The database writes are in data.js (applyTemplate); the screens draw.
//
//   template.tasks is a tree: [{ key, title, description, phase, priority, due_days, children: [...] }]
//   due_days counts from the project's start date (null = no due date). A template is a snapshot:
//   editing it later never changes a project already made from it (posupject's rule).

import { DEPARTMENT_IDS, TASK_PRIORITIES } from './departments.js';

const PRIORITIES = TASK_PRIORITIES.map((p) => p.id);
const clean = (v) => (v == null ? '' : String(v).trim());
const intOrNull = (v) => { const n = Number(v); return v === '' || v === null || v === undefined || !Number.isFinite(n) ? null : Math.round(n); };

/** 'YYYY-MM-DD' plus n days, or null. */
export function addDays(ymd, n) {
  if (!ymd || !/^\d{4}-\d{2}-\d{2}$/.test(String(ymd))) return null;
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (Number(n) || 0));
  return d.toISOString().slice(0, 10);
}

/** Whole days from a to b ('YYYY-MM-DD'), or null when either is missing. */
export function daysBetween(a, b) {
  if (!a || !b) return null;
  const ms = Date.parse(`${String(b).slice(0, 10)}T12:00:00Z`) - Date.parse(`${String(a).slice(0, 10)}T12:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : null;
}

let keyN = 0;
/** A key for a task row in the editor (never stored as an id). */
export const newKey = () => `k${Date.now().toString(36)}${(keyN += 1)}`;

/** One task row of a template, every field in its place. */
export function normaliseTask(t, depth = 0) {
  const task = {
    key: clean(t?.key) || newKey(),
    title: clean(t?.title),
    description: clean(t?.description) || null,
    phase: clean(t?.phase) || null,
    priority: PRIORITIES.includes(t?.priority) ? t.priority : 'P2',
    due_days: intOrNull(t?.due_days),
    children: [],
  };
  // Two levels in the editor (a task and its sub tasks), any depth is read back.
  if (Array.isArray(t?.children)) task.children = t.children.map((c) => normaliseTask(c, depth + 1));
  return task;
}

/** The phases as names, trimmed and without blanks or repeats. */
export function phaseNames(phases) {
  const out = [];
  for (const p of Array.isArray(phases) ? phases : []) {
    const name = clean(typeof p === 'string' ? p : p?.name);
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** A template with every field in its place (what the screen edits and the row stores). */
export function normaliseTemplate(raw = {}) {
  return {
    id: raw.id || null,
    org_id: raw.org_id || null,
    name: clean(raw.name),
    description: clean(raw.description) || null,
    department: DEPARTMENT_IDS.includes(raw.department) ? raw.department : 'operations',
    phases: phaseNames(raw.phases),
    tasks: (Array.isArray(raw.tasks) ? raw.tasks : []).map((t) => normaliseTask(t)),
    duration_days: intOrNull(raw.duration_days),
    archived_at: raw.archived_at || null,
  };
}

/** Why a template cannot be saved, or null. */
export function templateProblem(tpl) {
  const t = normaliseTemplate(tpl);
  if (!t.name) return 'Give the template a name.';
  const blank = (list) => list.some((x) => !x.title || blank(x.children));
  if (blank(t.tasks)) return 'Every task needs a title.';
  const bad = (list) => list.some((x) => (x.due_days !== null && x.due_days < 0) || bad(x.children));
  if (bad(t.tasks)) return 'A due day counts from the start: no negative days.';
  if (t.duration_days !== null && t.duration_days < 0) return 'The length counts from the start: no negative days.';
  return null;
}

/** How many tasks a template holds, sub tasks included. */
export function countTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).reduce((n, t) => n + 1 + countTasks(t.children), 0);
}

/** The latest due_days in the tree, or null. */
export function lastDueDay(tasks) {
  let last = null;
  const walk = (list) => { for (const t of list || []) { if (t.due_days !== null && t.due_days !== undefined && (last === null || t.due_days > last)) last = t.due_days; walk(t.children); } };
  walk(tasks);
  return last;
}

/**
 * A template taken from a project and its tasks (Save as template). Due days count from the
 * project's start date (else the earliest task date); a task with no due date keeps none.
 */
export function templateFromProject(project, tasks, name = null) {
  const list = (tasks || []).filter((t) => t && t.title);
  const dates = list.map((t) => t.due_date).concat(list.map((t) => t.start_date)).filter(Boolean).sort();
  const start = project?.start_date || dates[0] || null;
  const byParent = new Map();
  for (const t of list) { const p = t.parent_task_id || null; if (!byParent.has(p)) byParent.set(p, []); byParent.get(p).push(t); }
  const order = (a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.created_at || '').localeCompare(String(b.created_at || ''));
  const one = (t, children) => normaliseTask({
    title: t.title, description: t.description, phase: t.phase, priority: t.priority,
    due_days: start && t.due_date ? Math.max(0, daysBetween(start, t.due_date)) : null,
    children,
  });
  // Two levels, as the editor shows: a project's deeper sub tasks are lifted to sit under the root
  // task, each right after its own parent, so nothing is hidden and nothing is lost.
  const flat = (parent, depth, out) => {
    for (const t of (byParent.get(parent) || []).sort(order)) { out.push(one(t, [])); if (depth < 6) flat(t.id, depth + 1, out); }
    return out;
  };
  const build = (parent) => (byParent.get(parent) || []).sort(order).map((t) => one(t, flat(t.id, 0, [])));
  return normaliseTemplate({
    name: name || `${project?.name || 'Project'} template`,
    description: project?.description || null,
    department: project?.department,
    phases: project?.phases,
    tasks: build(null),
    duration_days: start && project?.due_date ? Math.max(0, daysBetween(start, project.due_date)) : null,
  });
}

/**
 * The rows a project made from a template needs: the project's fields with real dates, and the
 * tasks flattened parents first ([{ key, parentKey, title, ..., due_date, sort_order }]), so the
 * database write can insert the parents, map key to id, then insert the sub tasks.
 */
export function instantiate(template, { name, startDate, locationId = null, ownerName = null, ownerId = null, description = null, dueDate = null } = {}) {
  const t = normaliseTemplate(template);
  const start = startDate || null;
  const due = dueDate || (start && t.duration_days !== null ? addDays(start, t.duration_days) : null);
  const rows = [];
  const walk = (list, parentKey) => {
    list.forEach((task, i) => {
      rows.push({
        key: task.key, parentKey, title: task.title, description: task.description, phase: task.phase,
        priority: task.priority, due_date: start && task.due_days !== null ? addDays(start, task.due_days) : null, sort_order: i, status: 'todo',
      });
      walk(task.children, task.key);
    });
  };
  walk(t.tasks, null);
  return {
    project: {
      name: clean(name) || t.name, description: description === null ? t.description : (clean(description) || null), department: t.department,
      location_id: locationId || null, owner_name: ownerName || null, owner_id: ownerId || null, status: 'planning',
      start_date: start, due_date: due, phases: t.phases, template_id: t.id || null,
    },
    tasks: rows,
  };
}

/** The words under a template in the list: "3 phases · 12 tasks · 45 days". */
export function templateWords(tpl) {
  const t = normaliseTemplate(tpl);
  const parts = [];
  if (t.phases.length) parts.push(`${t.phases.length} phase${t.phases.length === 1 ? '' : 's'}`);
  const n = countTasks(t.tasks);
  parts.push(`${n} task${n === 1 ? '' : 's'}`);
  if (t.duration_days !== null) parts.push(`${t.duration_days} day${t.duration_days === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
