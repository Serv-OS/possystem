// countPlanRules.test.js: count plans, templates, the due strip, second approval and locked periods
// (v5.11.96, multi site stock Drop 3, contract 3.3 and 4.3). Run: npm test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PLAN_COUNT_TYPES, PLAN_EVERY, IF_NOT_COUNTED, dayMonWords, hmOf, dueWords, dueStripRows, everyWords, planSummary, blankPlan,
  planProblem, planToSave, moveItem, shelfSortLines, templateItemsForCount, secondApprovalState, secondApprovalWords, lockProblem,
  periodWords, snapshotRows,
} from './countPlanRules.js';

const A = 'a1000000-0000-4000-8000-000000000001';
const B = 'a1000000-0000-4000-8000-000000000002';

test('the plan form words are the mockup\'s', () => {
  assert.deepEqual(PLAN_EVERY.map((e) => e.label), ['Every day', 'Every week on', 'Every month on day']);
  assert.deepEqual(IF_NOT_COUNTED.map((e) => e.label), ['Use the estimate', 'Use zero']);
  assert.deepEqual(PLAN_COUNT_TYPES.map((t) => t.id), ['FULL', 'PARTIAL', 'SPOT', 'AREA', 'SUPPLIER']);
});

test('dayMonWords and hmOf', () => {
  assert.equal(dayMonWords('2026-10-21'), '21 Oct');
  assert.equal(dayMonWords('2026-01-05T10:00:00Z'), '5 Jan');
  assert.equal(dayMonWords('2026-13-01'), '');
  assert.equal(dayMonWords(null), '');
  assert.equal(hmOf('10:00:00'), '10:00');
  assert.equal(hmOf('9:30'), '09:30');
  assert.equal(hmOf('25:00'), '');
  assert.equal(hmOf(''), '');
});

test('dueWords: the strip words for each status (contract 4.3)', () => {
  assert.deepEqual(dueWords({ plan_name: 'Full count', due_by: '10:00:00', status: 'due' }), { text: 'Count due today: Full count by 10:00', tone: 'warn', pill: 'Due today' });
  assert.deepEqual(dueWords({ plan_name: 'Full count', due_day: '2026-10-21', status: 'missed' }), { text: 'Count missed: Full count on 21 Oct', tone: 'bad', pill: 'Missed' });
  assert.equal(dueWords({ plan_name: 'Bar', due_by: '09:00', status: 'late' }).text, 'Count late: Bar was due by 09:00');
  assert.equal(dueWords({ plan_name: 'Bar', status: 'done' }).pill, 'Done');
  assert.equal(dueWords({ status: 'odd' }).text, 'Count');
});

test('dueStripRows: one site, done rows left out, missed then late then due, at most 4', () => {
  const rows = [
    { location_id: A, plan_name: 'Full', status: 'due', due_by: '10:00' },
    { location_id: A, plan_name: 'Bar', status: 'missed', due_day: '2026-10-21', due_by: '09:00' },
    { location_id: A, plan_name: 'Spot', status: 'done', due_by: '08:00' },
    { location_id: B, plan_name: 'Other site', status: 'due', due_by: '07:00' },
    { location_id: A, plan_name: 'Cellar', status: 'late', due_by: '08:00' },
    null,
  ];
  assert.deepEqual(dueStripRows(rows, A).map((r) => r.plan_name), ['Bar', 'Cellar', 'Full']);
  assert.equal(dueStripRows(rows, A)[0].text, 'Count missed: Bar on 21 Oct');
  assert.equal(dueStripRows(rows, A, 1).length, 1);
  assert.deepEqual(dueStripRows(rows, null).map((r) => r.plan_name), ['Bar', 'Cellar', 'Other site', 'Full']);
  assert.deepEqual(dueStripRows(null, A), []);
});

test('everyWords and planSummary', () => {
  assert.equal(everyWords({ every: 'day', due_by: '10:00:00' }), 'Every day by 10:00');
  assert.equal(everyWords({ every: 'week', dows: [4, 1, 1, 0], due_by: '09:30' }), 'Every week on Mon, Thu, Sun by 09:30');
  assert.equal(everyWords({ every: 'week', dows: [] }), 'Every week on no day yet by 10:00');
  assert.equal(everyWords({ every: 'month', day_of_month: 28 }), 'Every month on day 28 by 10:00');
  const names = { siteName: (id) => (id === A ? 'Site A' : ''), groupName: (id) => (id === 'g1' ? 'North' : '') };
  assert.equal(planSummary({ count_type: 'FULL', every: 'day', due_by: '10:00', sites: null, if_not_counted: 'zero' }, names), 'Full count · Every day by 10:00 · Every open site · Use zero');
  assert.equal(planSummary({ count_type: 'SPOT', every: 'day', sites: [A] }, names), 'Spot check · Every day by 10:00 · Site A · Use the estimate');
  assert.equal(planSummary({ count_type: 'AREA', every: 'day', sites: [A, B], group_ids: ['g1'] }, names), 'By area · Every day by 10:00 · North and 2 sites · Use the estimate');
});

test('planProblem and planToSave: the form refuses in words; the save shape is exact', () => {
  assert.equal(planProblem(blankPlan()), 'Give the plan a name.');
  const ok = { ...blankPlan(), name: ' Full count ' };
  assert.equal(planProblem(ok), null);
  assert.equal(planProblem({ ...ok, every: 'week', dows: [] }), 'Pick at least one day.');
  assert.equal(planProblem({ ...ok, every: 'month', day_of_month: 31 }), 'Pick a day from 1 to 28.');
  assert.equal(planProblem({ ...ok, due_by: 'soon' }), 'Type the time it is due by, like 10:00.');
  assert.equal(planProblem({ ...ok, count_type: 'X' }), 'Pick what is counted.');
  assert.equal(planProblem({ ...ok, every: 'year' }), 'Pick how often.');
  assert.deepEqual(planToSave({ ...ok, dows: [3, 1, 1], sites: [A, A], group_ids: [] }), {
    name: 'Full count', count_type: 'FULL', template_id: null, every: 'week', dows: [1, 3], day_of_month: null, due_by: '10:00',
    sites: [A], group_ids: null, if_not_counted: 'estimate', active: true,
  });
  assert.deepEqual(planToSave({ ...ok, id: 'p1', every: 'month', day_of_month: '5', if_not_counted: 'zero', archived: true, active: false }), {
    id: 'p1', name: 'Full count', count_type: 'FULL', template_id: null, every: 'month', dows: null, day_of_month: 5, due_by: '10:00',
    sites: null, group_ids: null, if_not_counted: 'zero', active: false, archived: true,
  });
});

test('moveItem and shelfSortLines: the site\'s shelf order', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 0, 5), ['a', 'b']);
  assert.deepEqual(moveItem(null, 0, 1), []);
  const lines = [
    { itemId: 'x', areaId: 'bar', sortOrder: 0 }, { itemId: 'y', areaId: null, sortOrder: 1 },
    { itemId: 'x', areaId: 'cellar', sortOrder: 2 }, { itemId: 'z', areaId: null, sortOrder: 3 },
  ];
  const got = shelfSortLines(lines, ['y', 'x']);
  assert.deepEqual(got.map((l) => [l.itemId, l.areaId, l.sortOrder]), [['y', null, 0], ['x', 'bar', 1], ['x', 'cellar', 2], ['z', null, 3]]);
  assert.equal(lines[0].sortOrder, 0, 'the lines given are not changed');
  assert.deepEqual(shelfSortLines(null, ['a']), []);
});

test('templateItemsForCount: the site items in shelf order, counted here only, and how many are missing', () => {
  assert.deepEqual(templateItemsForCount({ items: [
    { inventory_item_id: 'i2', counted_here: true }, { inventory_item_id: 'i1' }, { inventory_item_id: 'i2' }, { inventory_item_id: 'i3', counted_here: false }, {},
  ], missing: [{ item_id: 'c9' }] }), { itemIds: ['i2', 'i1'], missing: 1 });
  assert.deepEqual(templateItemsForCount(null), { itemIds: [], missing: 0 });
});

test('secondApprovalState: never the first approver; head office or another site login may give it', () => {
  const count = { status: 'SUBMITTED', secondApprovalNeededAt: '2026-10-22T10:00:00Z', firstApprovedBy: 'u1' };
  assert.deepEqual(secondApprovalState(count, { userId: 'u1', companyEditor: true }), { waiting: true, canGive: false, why: 'You gave the first approval. Someone else gives the second.' });
  assert.deepEqual(secondApprovalState(count, { userId: 'u2', linkedHere: true }), { waiting: true, canGive: true, why: null });
  assert.deepEqual(secondApprovalState(count, { userId: 'u3', companyEditor: true }), { waiting: true, canGive: true, why: null });
  assert.equal(secondApprovalState(count, { userId: 'u4' }).canGive, false);
  assert.equal(secondApprovalState({ ...count, status: 'APPROVED' }).waiting, false);
  assert.equal(secondApprovalState({ ...count, secondApprovedAt: 'x' }).waiting, false);
  assert.equal(secondApprovalState({ status: 'SUBMITTED' }).waiting, false);
  assert.equal(secondApprovalState(null).waiting, false);
});

test('secondApprovalWords, lockProblem, periodWords, snapshotRows', () => {
  assert.equal(secondApprovalWords(500), 'Waiting for a second approval. Over £500.');
  assert.equal(secondApprovalWords(1250.5, '$'), 'Waiting for a second approval. Over $1250.50.');
  assert.equal(secondApprovalWords(null), 'Waiting for a second approval.');
  assert.equal(lockProblem('2026-09-01', '2026-09-30', '2026-10-22'), null);
  assert.equal(lockProblem('', '2026-09-30', '2026-10-22'), 'Pick the first and last day.');
  assert.equal(lockProblem('2026-09-30', '2026-09-01', '2026-10-22'), 'The last day is before the first day.');
  assert.equal(lockProblem('2026-10-01', '2026-10-22', '2026-10-22'), 'Lock a period that has ended: the last day must be before today.');
  assert.equal(periodWords({ locked_at: '2026-11-02T09:00:00Z', locked_by_name: 'Sam' }), 'Locked by Sam on 2 Nov');
  assert.equal(periodWords({ locked_at: '2026-11-02T09:00:00Z' }), 'Locked on 2 Nov');
  assert.equal(periodWords({ locked_at: '2026-11-02T09:00:00Z', unlocked_at: '2026-11-03T09:00:00Z' }), 'Unlocked on 3 Nov');
  assert.equal(periodWords(null), '');
  assert.deepEqual(snapshotRows({ stock_value: 1200.5, waste: '30', gp_pct: 68.2, movements: 40, cogs: null }).map((r) => [r.label, r.value, r.pct]),
    [['Closing stock value', 1200.5, false], ['Waste', 30, false], ['GP %', 68.2, true]]);
  assert.deepEqual(snapshotRows(null), []);
});

test('countPlanRules.js is pure and plain', () => {
  const src = fs.readFileSync(new URL('./countPlanRules.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /^import /m);
  assert.doesNotMatch(src, /[\u2013\u2014]/);
});

test('companyLimitsForm and companyLimitsPatch: the Drop 3 company settings', async () => {
  const { companyLimitsForm, companyLimitsPatch } = await import('./countPlanRules.js');
  assert.deepEqual(companyLimitsForm({ send_unapproved_at_cutoff: true, waste_pin_over_value: null, count_second_approval_over: '500', invoice_tolerance_pct: null, invoice_tolerance_amount: null }),
    { sendUnapproved: true, wastePin: '', countSecond: '500', tolKind: 'amount', tol: '' });
  assert.deepEqual(companyLimitsForm({ send_unapproved_at_cutoff: false, invoice_tolerance_pct: 2.5 }), { sendUnapproved: false, wastePin: '', countSecond: '', tolKind: 'pct', tol: '2.5' });
  assert.equal(companyLimitsForm(null).sendUnapproved, true, 'on by default (Peter)');
  assert.deepEqual(companyLimitsPatch({ sendUnapproved: true, wastePin: ' 25 ', countSecond: '', tolKind: 'amount', tol: '0.5' }), { patch: {
    send_unapproved_at_cutoff: true, waste_pin_over_value: 25, count_second_approval_over: null, invoice_tolerance_pct: null, invoice_tolerance_amount: 0.5 } });
  assert.deepEqual(companyLimitsPatch({ sendUnapproved: false, tolKind: 'pct', tol: '3' }).patch, {
    send_unapproved_at_cutoff: false, waste_pin_over_value: null, count_second_approval_over: null, invoice_tolerance_pct: 3, invoice_tolerance_amount: null });
  assert.equal(companyLimitsPatch({ wastePin: '-1' }).error, 'The waste PIN limit must be a number of 0 or more, or empty for none.');
  assert.equal(companyLimitsPatch({ countSecond: 'lots' }).error, 'The count limit must be a number of 0 or more, or empty for none.');
  assert.equal(companyLimitsPatch({ tolKind: 'pct', tol: '101' }).error, 'The invoice tolerance % is at most 100.');
});
