// src/lib/hq/departments.js
//
// Head office hub: the departments a project or a check in belongs to, and the words for
// project and task states. One list, used by every head office screen and the database
// check constraints (supabase/migrations/20261130a_OPS_head_office_hub.sql).

export const DEPARTMENTS = Object.freeze([
  { id: 'operations', label: 'Operations', blurb: 'Store execution, staffing coverage and the day to day standard.' },
  { id: 'hr', label: 'HR', blurb: 'Hiring, retention, leadership morale and how the teams are holding up.' },
  { id: 'finance', label: 'Finance', blurb: 'Prime cost, cash position and the plan behind the next sites.' },
  { id: 'marketing', label: 'Marketing', blurb: 'Guest sentiment, reviews and the campaigns that fill the dayparts.' },
  { id: 'store_leadership', label: 'Store leadership', blurb: 'The people running each room.' },
]);

export const DEPARTMENT_IDS = Object.freeze(DEPARTMENTS.map((d) => d.id));

export function departmentLabel(id) {
  return DEPARTMENTS.find((d) => d.id === id)?.label || 'Department';
}

/** Project states, in the order the filter pills show them. */
export const PROJECT_STATUSES = Object.freeze([
  { id: 'in_progress', label: 'In progress', tone: 'grn' },
  { id: 'at_risk', label: 'At risk', tone: 'orn' },
  { id: 'blocked', label: 'Blocked', tone: 'red' },
  { id: 'planning', label: 'Planning', tone: 't3' },
  { id: 'done', label: 'Done', tone: 'acc' },
  { id: 'cancelled', label: 'Cancelled', tone: 't4' },
]);

export const OPEN_PROJECT_STATUSES = Object.freeze(['planning', 'in_progress', 'at_risk', 'blocked']);

export function projectStatusLabel(id) {
  return PROJECT_STATUSES.find((s) => s.id === id)?.label || 'Planning';
}

/** Task states and priorities (the posupject set, unchanged). */
export const TASK_STATUSES = Object.freeze([
  { id: 'todo', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
]);

export const TASK_PRIORITIES = Object.freeze([
  { id: 'P0', label: 'P0 urgent' },
  { id: 'P1', label: 'P1 high' },
  { id: 'P2', label: 'P2 normal' },
  { id: 'P3', label: 'P3 low' },
]);
