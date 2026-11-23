// src/lib/hq/projectRollup.js
//
// Internal projects: the card's figures come from the tasks, not from a typed box.
//   * percent done = finished leaf tasks over all leaf tasks (a task with sub tasks is a
//     heading, it counts through its children). No tasks = 0, and the card says "no tasks".
//   * risk = something the owner should know even when nobody changed the status: a blocked
//     task, an overdue open task, or the project itself past its due date.
//   * the status stays what a person set; the risk is shown beside it. The one exception:
//     a project whose status is "at_risk" with no live risk still shows At risk, because a
//     person said so.
// Pure, tested in projectRollup.test.js.

const dayOf = (v) => (v ? String(v).slice(0, 10) : null);

/** Tasks as a tree: [{ ...task, children: [...] }], roots sorted by sort_order then created_at. */
export function taskTree(tasks) {
  const list = (tasks || []).map((t) => ({ ...t, children: [] }));
  const byId = new Map(list.map((t) => [t.id, t]));
  const roots = [];
  for (const t of list) {
    const parent = t.parent_task_id ? byId.get(t.parent_task_id) : null;
    if (parent && parent !== t) parent.children.push(t); else roots.push(t);
  }
  const order = (a, b) => (a.sort_order || 0) - (b.sort_order || 0) || String(a.created_at || '').localeCompare(String(b.created_at || ''));
  const sortDeep = (arr) => { arr.sort(order); arr.forEach((n) => sortDeep(n.children)); return arr; };
  return sortDeep(roots);
}

/** Leaf tasks: those with no sub tasks. */
export function leafTasks(tasks) {
  const parents = new Set((tasks || []).filter((t) => t.parent_task_id).map((t) => t.parent_task_id));
  return (tasks || []).filter((t) => !parents.has(t.id));
}

/** { done, total, pct } over the leaf tasks. pct is a whole number, 0 when there are none. */
export function progressOf(tasks) {
  const leaves = leafTasks(tasks);
  const done = leaves.filter((t) => t.status === 'done').length;
  const total = leaves.length;
  return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
}

/**
 * The risk worth a badge, or null. today = 'YYYY-MM-DD'.
 *   { kind: 'blocked', reason: '2 tasks blocked' }
 *   { kind: 'overdue', reason: '1 task overdue' }
 *   { kind: 'late',    reason: 'Due 3 days ago' }
 */
export function riskOf(project, tasks, today) {
  if (!project || ['done', 'cancelled'].includes(project.status)) return null;
  const open = (tasks || []).filter((t) => t.status !== 'done');
  const blocked = open.filter((t) => t.status === 'blocked').length;
  if (blocked) return { kind: 'blocked', reason: `${blocked} task${blocked === 1 ? '' : 's'} blocked` };
  const overdue = today ? open.filter((t) => dayOf(t.due_date) && dayOf(t.due_date) < today).length : 0;
  if (overdue) return { kind: 'overdue', reason: `${overdue} task${overdue === 1 ? '' : 's'} overdue` };
  const due = dayOf(project.due_date);
  if (today && due && due < today) {
    const days = Math.round((Date.parse(today) - Date.parse(due)) / 86400000);
    return { kind: 'late', reason: `Due ${days} day${days === 1 ? '' : 's'} ago` };
  }
  return null;
}

/** The status word the card shows: the set one, or At risk when a live risk says so. */
export function shownStatus(project, risk) {
  const s = project?.status || 'planning';
  if (risk && ['planning', 'in_progress'].includes(s)) return risk.kind === 'blocked' ? 'blocked' : 'at_risk';
  return s;
}

/** Newest update of kind 'update' (a person's words), else the newest row of any kind, else null. */
export function latestUpdate(updates) {
  const list = [...(updates || [])].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return list.find((u) => u.kind === 'update') || list[0] || null;
}

/** Tasks grouped by phase in the project's phase order; tasks with no phase last under ''. */
export function groupByPhase(tasks, phases) {
  const names = Array.isArray(phases) ? phases.map((p) => (typeof p === 'string' ? p : p?.name)).filter(Boolean) : [];
  const groups = new Map(names.map((n) => [n, []]));
  const rest = [];
  for (const t of taskTree(tasks)) {
    if (t.phase && groups.has(t.phase)) groups.get(t.phase).push(t);
    else if (t.phase) { groups.set(t.phase, [t]); }
    else rest.push(t);
  }
  const out = [...groups.entries()].map(([name, items]) => ({ name, tasks: items }));
  if (rest.length) out.push({ name: '', tasks: rest });
  return out;
}

/** Everything the card needs for one project. */
export function projectCard(project, tasks, updates, today) {
  const progress = progressOf(tasks);
  const risk = riskOf(project, tasks, today);
  return {
    ...project,
    progress,
    risk,
    shownStatus: shownStatus(project, risk),
    latest: latestUpdate(updates),
    openTasks: (tasks || []).filter((t) => t.status !== 'done').length,
  };
}

/** Counts per status for the filter pills, after the risk rule. */
export function statusCounts(cards) {
  const counts = { all: 0, in_progress: 0, at_risk: 0, blocked: 0, planning: 0, done: 0, cancelled: 0 };
  for (const c of cards || []) {
    counts.all += 1;
    const k = c.shownStatus in counts ? c.shownStatus : 'planning';
    counts[k] += 1;
  }
  return counts;
}

/** Tasks that are mine or nobody's, open, due soonest first. */
export function myWork(tasks, userId) {
  return (tasks || [])
    .filter((t) => t.status !== 'done' && (!t.owner_id || t.owner_id === userId))
    .sort((a, b) => String(a.due_date || '9999').localeCompare(String(b.due_date || '9999')) || String(a.priority || 'P2').localeCompare(String(b.priority || 'P2')));
}
