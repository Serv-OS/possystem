// templates.test.js: project templates (head office slice 6): the shape, a template from a project,
// and a project from a template with real dates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import {
  addDays, daysBetween, normaliseTask, normaliseTemplate, templateProblem, countTasks, lastDueDay, templateFromProject, instantiate, templateWords, phaseNames,
} from './templates.js';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.join(here, rel), 'utf8');
const LONG_DASHES = new RegExp('[\\u2013\\u2014]');

test('dates: addDays and daysBetween on plain day strings', () => {
  assert.equal(addDays('2026-11-18', 14), '2026-12-02');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays(null, 3), null);
  assert.equal(daysBetween('2026-11-18', '2026-12-02'), 14);
  assert.equal(daysBetween('2026-11-18', null), null);
});

test('normaliseTemplate: every field in its place, blanks and repeats out of the phases, a key on every task', () => {
  const t = normaliseTemplate({ name: '  Open a site ', department: 'nope', phases: ['Plan', '', 'Plan', { name: 'Build' }], tasks: [{ title: 'Sign lease', due_days: '7', priority: 'P9', children: [{ title: 'Survey' }] }], duration_days: '45.4' });
  assert.equal(t.name, 'Open a site');
  assert.equal(t.department, 'operations');
  assert.deepEqual(t.phases, ['Plan', 'Build']);
  assert.equal(t.tasks[0].due_days, 7);
  assert.equal(t.tasks[0].priority, 'P2');
  assert.ok(t.tasks[0].key && t.tasks[0].children[0].key);
  assert.equal(t.duration_days, 45);
  assert.deepEqual(phaseNames(null), []);
  assert.equal(normaliseTask({ due_days: '' }).due_days, null);
});

test('templateProblem: a name, a title on every task, no negative days', () => {
  assert.equal(templateProblem({ name: '' }), 'Give the template a name.');
  assert.equal(templateProblem({ name: 'A', tasks: [{ title: 'x', children: [{ title: '' }] }] }), 'Every task needs a title.');
  assert.equal(templateProblem({ name: 'A', tasks: [{ title: 'x', due_days: -1 }] }), 'A due day counts from the start: no negative days.');
  assert.equal(templateProblem({ name: 'A', duration_days: -3 }), 'The length counts from the start: no negative days.');
  assert.equal(templateProblem({ name: 'A', tasks: [{ title: 'x', due_days: 3 }] }), null);
});

test('countTasks, lastDueDay and templateWords', () => {
  const tasks = [{ title: 'a', due_days: 3, children: [{ title: 'b', due_days: 10 }, { title: 'c' }] }, { title: 'd' }];
  assert.equal(countTasks(tasks), 4);
  assert.equal(lastDueDay(tasks), 10);
  assert.equal(lastDueDay([{ title: 'a' }]), null);
  assert.equal(templateWords({ name: 'x', phases: ['Plan'], tasks, duration_days: 1 }), '1 phase · 4 tasks · 1 day');
  assert.equal(templateWords({ name: 'x' }), '0 tasks');
});

test('templateFromProject: due days from the start date, sub tasks under their parent, order kept', () => {
  const project = { name: 'Open Leeds', description: 'The second UK site', department: 'finance', phases: ['Plan', 'Build'], start_date: '2026-11-01', due_date: '2026-12-16' };
  const tasks = [
    { id: 't1', title: 'Sign lease', phase: 'Plan', priority: 'P1', due_date: '2026-11-08', sort_order: 1 },
    { id: 't0', title: 'Find a site', phase: 'Plan', priority: 'P0', due_date: '2026-11-03', sort_order: 0 },
    { id: 't2', title: 'Survey', parent_task_id: 't1', due_date: '2026-11-06', sort_order: 0 },
    { id: 't3', title: 'Fit out', phase: 'Build', sort_order: 2 },
  ];
  const tpl = templateFromProject(project, tasks);
  assert.equal(tpl.name, 'Open Leeds template');
  assert.equal(tpl.department, 'finance');
  assert.deepEqual(tpl.phases, ['Plan', 'Build']);
  assert.equal(tpl.duration_days, 45);
  assert.deepEqual(tpl.tasks.map((t) => [t.title, t.due_days, t.children.map((c) => [c.title, c.due_days])]), [
    ['Find a site', 2, []], ['Sign lease', 7, [['Survey', 5]]], ['Fit out', null, []],
  ]);
  // No start date on the project: the earliest task date stands in.
  const noStart = templateFromProject({ name: 'X', phases: [] }, [{ id: 'a', title: 'A', due_date: '2026-11-10' }, { id: 'b', title: 'B', due_date: '2026-11-12' }], 'Mine');
  assert.equal(noStart.name, 'Mine');
  assert.deepEqual(noStart.tasks.map((t) => t.due_days), [0, 2]);
  assert.equal(noStart.duration_days, null);
  // A sub sub task is lifted to sit under the root task, right after its parent (the editor shows two levels).
  const deep = templateFromProject({ name: 'D', start_date: '2026-11-01' }, [
    { id: 'r', title: 'Root', sort_order: 0 }, { id: 'c', title: 'Child', parent_task_id: 'r', sort_order: 0 }, { id: 'g', title: 'Grandchild', parent_task_id: 'c', due_date: '2026-11-04' }, { id: 'c2', title: 'Child 2', parent_task_id: 'r', sort_order: 1 },
  ]);
  assert.deepEqual(deep.tasks.map((t) => [t.title, t.children.map((c) => [c.title, c.due_days])]), [['Root', [['Child', null], ['Grandchild', 3], ['Child 2', null]]]]);
});

test('instantiate: real dates from the start, parents before children, the project carries the template', () => {
  const tpl = { id: 'tpl1', name: 'Open a site', description: 'Everything to open', department: 'operations', phases: ['Plan', 'Build'], duration_days: 45,
    tasks: [{ key: 'a', title: 'Find a site', phase: 'Plan', due_days: 2, children: [{ key: 'a1', title: 'Shortlist', due_days: 1 }] }, { key: 'b', title: 'Fit out', phase: 'Build' }] };
  const plan = instantiate(tpl, { name: 'Open Hull', startDate: '2026-11-18', locationId: 'loc1', ownerName: 'Peter' });
  assert.equal(plan.project.name, 'Open Hull');
  assert.equal(plan.project.description, 'Everything to open');
  assert.equal(plan.project.due_date, '2027-01-02');
  assert.equal(plan.project.template_id, 'tpl1');
  assert.equal(plan.project.location_id, 'loc1');
  assert.deepEqual(plan.project.phases, ['Plan', 'Build']);
  assert.deepEqual(plan.tasks.map((t) => [t.key, t.parentKey, t.due_date, t.sort_order]), [['a', null, '2026-11-20', 0], ['a1', 'a', '2026-11-19', 0], ['b', null, null, 1]]);
  // No start date: no dates at all, the template's name stands in, a given due date wins.
  const bare = instantiate(tpl, { startDate: null, dueDate: '2027-03-01' });
  assert.equal(bare.project.name, 'Open a site');
  assert.equal(bare.project.due_date, '2027-03-01');
  assert.ok(bare.tasks.every((t) => t.due_date === null));
});

test('the screens: templates are a tab on Internal projects, a project can be saved as one, the write is two passes, no long dashes', () => {
  const lib = read('./templates.js');
  const data = read('./data.js');
  const projects = read('../../backoffice/sections/headoffice/HqProjects.jsx');
  const detail = read('../../backoffice/sections/headoffice/HqProjectDetail.jsx');
  const screen = read('../../backoffice/sections/headoffice/HqTemplates.jsx');
  const sql = fs.readFileSync(path.join(here, '../../../supabase/migrations/20261203a_OPS_head_office_templates.sql'), 'utf8');
  for (const [name, src] of Object.entries({ lib, data, projects, detail, screen, sql })) assert.doesNotMatch(src, LONG_DASHES, `${name} has no long dashes`);
  assert.ok(projects.includes("['templates', 'Templates']"), 'the Templates tab');
  assert.ok(projects.includes('<HqTemplates hq={hq}'), 'the tab shows the templates screen');
  assert.ok(projects.includes('const plan = instantiate(picked, {') && projects.includes('res = await applyTemplate(plan, hq.orgId, hq.userName);'), 'a project from a template goes through instantiate then applyTemplate');
  assert.ok(detail.includes('Save as template'), 'a project can become a template');
  assert.ok(detail.includes('templateFromProject(project, tasks'));
  assert.ok(data.includes("const ready = pending.filter((t) => !t.parentKey || ids.has(t.parentKey));"), 'parents first, sub tasks with their parents\' ids');
  assert.ok(data.includes('const byPlace = new Map(ready.map((t) => [`${t.parentKey ? ids.get(t.parentKey) : \'\'}|${Number(t.sort_order) || 0}`, t.key]));'), 'the ids are matched by place, never by the order rows come back');
  assert.ok(screen.includes('const id = t.id || template?.id || null;'), 'a just saved template keeps its id: no double insert');
  assert.ok(detail.includes('const [msg, setMsg] = useState(() => { const n = hqHandoff.notice || null; hqHandoff.notice = null; return n; });'), 'a partly made project says so when it opens');
  assert.ok(data.includes("...(project.template_id ? { template_id: project.template_id } : {}),"), 'a blank project still saves on a database without 20261203a');
  assert.ok(sql.includes('add column if not exists template_id uuid references public.hq_project_templates(id) on delete set null'));
  assert.ok(sql.includes("create policy hq_project_templates_all on public.hq_project_templates for all to authenticated"));
});
