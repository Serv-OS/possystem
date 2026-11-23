/**
 * projectRollup.test.js: a project card's figures come from its tasks.
 * Run: `node --test src/lib/hq/projectRollup.test.js`.
 *
 * Pinned:
 *   1. Percent = finished leaf tasks over all leaf tasks; a parent counts through its children.
 *   2. Risk: blocked beats overdue beats a late project; done and cancelled projects carry none.
 *   3. The shown status is what a person set, lifted to At risk or Blocked by a live risk.
 *   4. Latest update = newest words a person wrote, else the newest activity.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  taskTree, leafTasks, progressOf, riskOf, shownStatus, latestUpdate, groupByPhase, projectCard, statusCounts, myWork,
} from './projectRollup.js';

const T = (id, over = {}) => ({ id, project_id: 'p', parent_task_id: null, status: 'todo', priority: 'P2', sort_order: 0, created_at: `2026-11-0${id.length}T00:00:00Z`, ...over });

test('taskTree and leafTasks: sub tasks nest, parents are headings', () => {
  const tasks = [T('a'), T('b', { parent_task_id: 'a', sort_order: 2 }), T('c', { parent_task_id: 'a', sort_order: 1 }), T('d')];
  const tree = taskTree(tasks);
  assert.deepEqual(tree.map((t) => t.id), ['a', 'd']);
  assert.deepEqual(tree[0].children.map((t) => t.id), ['c', 'b']);
  assert.deepEqual(leafTasks(tasks).map((t) => t.id), ['b', 'c', 'd']);
});

test('progressOf: leaves only, 0 when there are none', () => {
  const tasks = [T('a'), T('b', { parent_task_id: 'a', status: 'done' }), T('c', { parent_task_id: 'a' }), T('d', { status: 'done' })];
  assert.deepEqual(progressOf(tasks), { done: 2, total: 3, pct: 67 });
  assert.deepEqual(progressOf([]), { done: 0, total: 0, pct: 0 });
  assert.deepEqual(progressOf([T('a', { status: 'done' })]), { done: 1, total: 1, pct: 100 });
});

test('riskOf: blocked, then overdue, then a late project, none when finished', () => {
  const today = '2026-11-16';
  const p = { status: 'in_progress', due_date: '2026-11-10' };
  assert.deepEqual(riskOf(p, [T('a', { status: 'blocked' }), T('b', { due_date: '2026-11-01' })], today), { kind: 'blocked', reason: '1 task blocked' });
  assert.deepEqual(riskOf(p, [T('b', { due_date: '2026-11-01' }), T('c', { due_date: '2026-11-02' })], today), { kind: 'overdue', reason: '2 tasks overdue' });
  assert.deepEqual(riskOf(p, [T('b', { due_date: '2026-11-01', status: 'done' })], today), { kind: 'late', reason: 'Due 6 days ago' });
  assert.equal(riskOf({ status: 'in_progress', due_date: '2026-12-01' }, [], today), null);
  assert.equal(riskOf({ status: 'done', due_date: '2026-11-01' }, [T('a', { status: 'blocked' })], today), null);
  assert.equal(riskOf({ status: 'cancelled' }, [T('a', { status: 'blocked' })], today), null);
  assert.equal(riskOf(p, [T('b', { due_date: '2026-11-01' })], null), null); // no today, no date arithmetic
});

test('shownStatus: a live risk lifts planning and in progress, never done', () => {
  assert.equal(shownStatus({ status: 'in_progress' }, { kind: 'overdue' }), 'at_risk');
  assert.equal(shownStatus({ status: 'planning' }, { kind: 'blocked' }), 'blocked');
  assert.equal(shownStatus({ status: 'at_risk' }, null), 'at_risk');
  assert.equal(shownStatus({ status: 'done' }, { kind: 'late' }), 'done');
  assert.equal(shownStatus({ status: 'blocked' }, { kind: 'overdue' }), 'blocked');
  assert.equal(shownStatus(null, null), 'planning');
});

test('latestUpdate prefers a person\'s words', () => {
  const u = [
    { id: 1, kind: 'activity', body: 'moved', created_at: '2026-11-16T10:00:00Z' },
    { id: 2, kind: 'update', body: 'Signups ahead of target', created_at: '2026-11-15T10:00:00Z' },
  ];
  assert.equal(latestUpdate(u).id, 2);
  assert.equal(latestUpdate([u[0]]).id, 1);
  assert.equal(latestUpdate([]), null);
});

test('groupByPhase: project order, unknown phase kept, no phase last', () => {
  const tasks = [T('a', { phase: 'Build' }), T('b', { phase: 'Plan' }), T('c'), T('d', { phase: 'Launch' })];
  const g = groupByPhase(tasks, ['Plan', 'Build']);
  assert.deepEqual(g.map((x) => x.name), ['Plan', 'Build', 'Launch', '']);
  assert.deepEqual(g[0].tasks.map((t) => t.id), ['b']);
  assert.deepEqual(g[3].tasks.map((t) => t.id), ['c']);
});

test('projectCard and statusCounts', () => {
  const p = { id: 'p', status: 'in_progress', due_date: '2026-12-01' };
  const card = projectCard(p, [T('a', { status: 'done' }), T('b')], [{ kind: 'update', body: 'hi', created_at: '2026-11-16T00:00:00Z' }], '2026-11-16');
  assert.equal(card.progress.pct, 50);
  assert.equal(card.risk, null);
  assert.equal(card.shownStatus, 'in_progress');
  assert.equal(card.latest.body, 'hi');
  assert.equal(card.openTasks, 1);
  const counts = statusCounts([card, { shownStatus: 'at_risk' }, { shownStatus: 'weird' }]);
  assert.equal(counts.all, 3);
  assert.equal(counts.in_progress, 1);
  assert.equal(counts.at_risk, 1);
  assert.equal(counts.planning, 1);
});

test('myWork: mine or nobody\'s, open, soonest first', () => {
  const tasks = [
    T('a', { owner_id: 'me', due_date: '2026-11-20' }),
    T('b', { owner_id: 'you', due_date: '2026-11-01' }),
    T('c', { owner_id: null, due_date: '2026-11-10' }),
    T('d', { owner_id: 'me', status: 'done' }),
    T('e', { owner_id: 'me', due_date: null, priority: 'P0' }),
  ];
  assert.deepEqual(myWork(tasks, 'me').map((t) => t.id), ['c', 'a', 'e']);
});
