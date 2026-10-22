// Multi site stock Drop 2: the Prep list and Batch and prep grid rules (src/lib/stock/prepList.js).
// Synthetic names and amounts only (public repo). The needed today rule must stay the one
// Batches.jsx has carried since v5.5.931: that file is read here and its rule lines pinned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as P from './prepList.js';

const TZ = 'Europe/London';
const item = (id, name, onHand, extra = {}) => ({ id, name, kind: 'MADE', archivedAt: null, onHand, baseUnit: 'L', ...extra });

// ── words ──
test('the words are the mockup words, no long dash in the file', () => {
  assert.equal(P.PREP_SUB, "Today's suggested amounts, through recipes, less what is on the shelf. Tick each one done.");
  assert.deepEqual([...P.PREP_COLUMNS], ['Item', 'On hand', 'Scheduled', 'Expect to use', 'Make', 'Done']);
  assert.equal(P.BATCH_TITLE, 'Batch and prep');
  assert.equal(P.BATCH_SUB, 'Same editor as dishes, plus yield, shelf life and the made item. Each site chooses how it gets each batch.');
  assert.equal(P.BATCH_STRIP.map(([b, w]) => `${b}: ${w}`).join(' '), 'Bought in: from the central kitchen or a supplier. Made here: the kitchen logs each batch. Made to order: no logging, the sale takes the raw ingredients off.');
  assert.equal(P.NOT_YET_TITLE, 'Not yet');
  assert.equal(P.NOT_YET_NOTE, 'That stock would never come off if sales took the raw ingredients instead.');
  assert.equal(P.NOT_USED, 'Not used');
  assert.deepEqual(P.HOW_OPTIONS.map((o) => o.label), ['Bought in', 'Made here', 'Made to order']);
  assert.deepEqual(P.HOW_OPTIONS.map((o) => o.value), ['bought', 'batches', 'to_order']);
  const src = fs.readFileSync(new URL('./prepList.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /[\u2013\u2014]/);
});

test('howLabel and prepTitle', () => {
  assert.equal(P.howLabel('batches'), 'Made here');
  assert.equal(P.howLabel('bought'), 'Bought in');
  assert.equal(P.howLabel('to_order'), 'Made to order');
  assert.equal(P.howLabel('odd'), 'odd');
  assert.equal(P.howLabel(null), '');
  assert.equal(P.prepTitle('Northgate'), 'Prep list for Northgate');
  assert.equal(P.prepTitle(''), 'Prep list');
});

// ── the needed today rule ──
test('prepRows: the Batches.jsx rule, in the server shape, biggest make first', () => {
  const items = [item('a', 'Test sauce', 4), item('b', 'Test stock', 20), item('c', 'Bought thing', 1, { kind: 'PURCHASED' }), item('d', 'Old prep', 0, { archivedAt: '2026-01-01' }), item('e', 'Quiet prep', 3)];
  const schedules = [{ output_item_id: 'a', qty: 5, unit: 'L', days_of_week: [1, 4], active: true }];   // Mon and Thu
  // usage by weekday, Sun..Sat
  const usageByItem = { a: [2, 6, 6, 6, 6, 8, 4], b: [1, 1, 1, 1, 1, 1, 1], e: [0, 0, 0, 0, 0, 0, 0] };
  const rows = P.prepRows({ items, schedules, usageByItem, batches: [], ticks: [], dow: 1 });   // Monday
  assert.deepEqual(rows.map((r) => r.name), ['Test sauce', 'Test stock'], 'PURCHASED, archived and zero usage rows are not listed');
  const a = rows[0];
  // Monday to Thursday exclusive: Mon 6 + Tue 6 + Wed 6 = 18 expected; scheduled 5 today; on hand 4
  assert.equal(a.expected, 18);
  assert.equal(a.scheduled, 5);
  assert.equal(a.on_hand, 4);
  assert.equal(a.planned, 0);
  assert.equal(a.make, 9);
  assert.equal(a.horizon, 'Thu');
  assert.equal(a.unit, 'L');
  assert.equal(a.output_item_id, 'a');
  assert.equal(a.recipe_id, null);
  assert.equal(a.done_qty, 0);
  assert.deepEqual(a.ticks, []);
  const b = rows[1];
  assert.equal(b.expected, 1, 'no schedule: today only');
  assert.equal(b.horizon, 'end of today');
  assert.equal(b.make, 0, 'on hand covers it');
});

test('prepRows: a schedule with no days means every day (span 1); the week wraps', () => {
  const items = [item('a', 'Test sauce', 0)];
  const usageByItem = { a: [10, 1, 1, 1, 1, 1, 7] };
  const everyDay = P.prepRows({ items, schedules: [{ output_item_id: 'a', qty: 2, days_of_week: [] }], usageByItem, dow: 6 });
  assert.equal(everyDay[0].expected, 7);
  assert.equal(everyDay[0].scheduled, 2);
  assert.equal(everyDay[0].make, 5);
  const satToMon = P.prepRows({ items, schedules: [{ output_item_id: 'a', qty: 0, days_of_week: [1] }], usageByItem, dow: 6 });
  assert.equal(satToMon[0].expected, 17, 'Sat 7 + Sun 10, up to Monday');
  assert.equal(satToMon[0].horizon, 'Mon');
  assert.equal(satToMon[0].scheduled, 0, 'not a cook day today');
  const cookEveryDay = P.prepRows({ items, schedules: [{ output_item_id: 'a', qty: 1, days_of_week: [0, 1, 2, 3, 4, 5, 6] }], usageByItem, dow: 0 });
  assert.equal(cookEveryDay[0].horizon, 'end of today');
  assert.equal(cookEveryDay[0].expected, 10);
});

test('prepRows: a batch planned by hand for today counts as planned; a scheduled plan does not count twice', () => {
  const items = [item('a', 'Test sauce', 0)];
  const usageByItem = { a: [0, 10, 0, 0, 0, 0, 0] };
  const schedules = [{ output_item_id: 'a', qty: 4, days_of_week: [1] }];
  const batches = [
    { outputItemId: 'a', status: 'PLANNED', plannedQty: 4, scheduleId: 'sch-1', plannedFor: '2026-10-19' },   // the schedule's own plan
    { outputItemId: 'a', status: 'PLANNED', plannedQty: 3, scheduleId: null, plannedFor: '2026-10-19' },      // by hand, today
    { outputItemId: 'a', status: 'PLANNED', plannedQty: 9, scheduleId: null, plannedFor: '2026-10-25' },      // by hand, another day
    { outputItemId: 'a', status: 'COMPLETED', actualQty: 5, scheduleId: null },
    { output_item_id: 'a', status: 'PLANNED', planned_qty: 1, schedule_id: null },                            // a raw row, no day: counts
  ];
  const [row] = P.prepRows({ items, schedules, usageByItem, batches, ticks: [], dow: 1, todayYmd: '2026-10-19' });
  assert.equal(row.scheduled, 4);
  assert.equal(row.planned, 4, '3 by hand today + 1 with no day');
  assert.equal(row.make, 2, '10 - 0 - 4 - 4');
  const noDay = P.prepRows({ items, schedules, usageByItem, batches, ticks: [], dow: 1 });
  assert.equal(noDay[0].planned, 13, 'with no todayYmd every by hand plan counts');
});

test('prepRows: ticks give done_qty and the tick list, by item or by recipe', () => {
  const items = [item('a', 'Test sauce', 0, { recipeId: 'r-1' }), item('b', 'Test stock', 0)];
  const usageByItem = { a: [5, 5, 5, 5, 5, 5, 5], b: [5, 5, 5, 5, 5, 5, 5] };
  const ticks = [
    { id: 't1', output_item_id: 'a', qty: 2, done_by_name: 'Jane Tester', done_at: '2026-10-21T13:05:00Z' },
    { id: 't2', recipe_id: 'r-1', qty: 1.5, by_name: 'Sam Tester', at: '2026-10-21T14:00:00Z' },
    { id: 't3', output_item_id: 'zzz', qty: 9 },
  ];
  const rows = P.prepRows({ items, schedules: [], usageByItem, ticks, dow: 2 });
  const a = rows.find((r) => r.name === 'Test sauce');
  assert.equal(a.recipe_id, 'r-1');
  assert.equal(a.done_qty, 3.5);
  assert.deepEqual(a.ticks, [
    { id: 't1', qty: 2, by_name: 'Jane Tester', at: '2026-10-21T13:05:00Z' },
    { id: 't2', qty: 1.5, by_name: 'Sam Tester', at: '2026-10-21T14:00:00Z' },
  ]);
  assert.equal(rows.find((r) => r.name === 'Test stock').done_qty, 0);
  assert.equal(a.make, 5, 'a tick never changes what is to make: it is not a stock number');
});

test('prepRows: sorted by make then name, and empty or odd input gives no rows', () => {
  const items = [item('a', 'Zed', 0), item('b', 'Alpha', 0), item('c', 'Mid', 0)];
  const usageByItem = { a: [1, 1, 1, 1, 1, 1, 1], b: [1, 1, 1, 1, 1, 1, 1], c: [4, 4, 4, 4, 4, 4, 4] };
  assert.deepEqual(P.prepRows({ items, usageByItem, dow: 3 }).map((r) => r.name), ['Mid', 'Alpha', 'Zed']);
  assert.deepEqual(P.prepRows({}), []);
  assert.deepEqual(P.prepRows(), []);
  assert.deepEqual(P.prepRows({ items: null, schedules: null, usageByItem: null, dow: 'x' }), []);
  assert.deepEqual(P.prepRows({ items, usageByItem, dow: 10 }).map((r) => r.name), ['Mid', 'Alpha', 'Zed'], 'a weekday out of range wraps');
});

test('the rule lines are the ones BatchesSite.jsx carries (the fallback stays word for word)', () => {
  // Drop 2 moved today's Batches.jsx whole into produce/BatchesSite.jsx (contract 3.1); the rule lives there.
  const batches = fs.readFileSync(new URL('../../backoffice/sections/produce/BatchesSite.jsx', import.meta.url), 'utf8');
  const mine = fs.readFileSync(new URL('./prepList.js', import.meta.url), 'utf8');
  for (const line of [
    'if (cookDays.size) { for (let d = 1; d <= 7; d++) { if (cookDays.has((',
    '// horizon: today up to (exclusive) the NEXT scheduled cook day; no schedule = today only',
    "span === 1 ? 'end of today' : DAYS[(",
    '.reduce((sum, x) => sum + (Number(x.qty) || 0), 0);',
    'const onHand = Number(item.onHand) || 0;',
    'if (expected > 0 || scheduled > 0) out.push({',
  ]) {
    assert.ok(batches.includes(line), `Batches.jsx still has: ${line}`);
    assert.ok(mine.includes(line), `prepList.js keeps: ${line}`);
  }
});

// ── the server answer and the row words ──
test('prepFromServer: every figure a number, make worked out when missing, ticks a list', () => {
  const out = P.prepFromServer({ business_day: '2026-10-21', rows: [
    { recipe_id: 'r-1', name: 'Test sauce', unit: 'L', on_hand: '4', expected: '18', scheduled: 5, planned: null, make: 9, done_qty: '2', ticks: [{ id: 't1', qty: '2', by_name: 'Jane Tester', at: '2026-10-21T13:05:00Z' }] },
    { recipe_id: 'r-2', name: 'Test stock', unit: 'L', on_hand: 1, expected: 4, scheduled: 0, planned: 1 },
  ] });
  assert.equal(out.business_day, '2026-10-21');
  assert.equal(out.rows[0].on_hand, 4);
  assert.equal(out.rows[0].planned, 0);
  assert.equal(out.rows[0].done_qty, 2);
  assert.deepEqual(out.rows[0].ticks, [{ id: 't1', qty: 2, by_name: 'Jane Tester', at: '2026-10-21T13:05:00Z' }]);
  assert.equal(out.rows[1].make, 2, '4 - 1 - 0 - 1 when the server gave no make');
  assert.deepEqual(out.rows[1].ticks, []);
  assert.deepEqual(P.prepFromServer(null), { business_day: null, rows: [] });
  assert.deepEqual(P.prepFromServer({ rows: 'x' }).rows, []);
});

test('makeWords, remaining, rowState, defaultTickQty', () => {
  assert.equal(P.makeWords({ make: 6, unit: 'L' }), '6 L');
  assert.equal(P.makeWords({ make: 6.46, unit: 'L' }), '6.5 L');
  assert.equal(P.makeWords({ make: 12, unit: '' }), '12');
  assert.equal(P.makeWords({ make: 0, unit: 'L' }), 'covered');
  assert.equal(P.makeWords({ make: -2 }), 'covered');
  assert.equal(P.makeWords(null), 'covered');
  assert.equal(P.remaining({ make: 6, done_qty: 2 }), 4);
  assert.equal(P.remaining({ make: 6, done_qty: 9 }), 0);
  assert.equal(P.remaining({}), 0);
  assert.equal(P.rowState({ make: 0 }), 'covered');
  assert.equal(P.rowState({ make: 6, done_qty: 6 }), 'done');
  assert.equal(P.rowState({ make: 6, done_qty: 2 }), 'open');
  assert.equal(P.defaultTickQty({ make: 6, done_qty: 2 }), '4');
  assert.equal(P.defaultTickQty({ make: 6.25, done_qty: 0 }), '6.3');
  assert.equal(P.defaultTickQty({ make: 6, done_qty: 6 }), '');
});

test('tickWords: Done <qty> <unit> by <name> <time>, on the venue clock', () => {
  assert.equal(P.tickWords({ qty: 6, by_name: 'Jane Tester', at: '2026-10-21T13:05:00Z' }, 'L', TZ), 'Done 6 L by Jane Tester 14:05');
  assert.equal(P.tickWords({ qty: 6, by_name: 'Jane Tester', at: '2026-10-21T13:05:00Z' }, 'L', 'America/Los_Angeles'), 'Done 6 L by Jane Tester 06:05');
  assert.equal(P.tickWords({ qty: 2.5, by_name: '', at: null }, 'kg'), 'Done 2.5 kg');
  assert.equal(P.tickWords({ qty: 3 }), 'Done 3');
  assert.equal(P.tickWords({ qty: 1.26, by_name: 'Sam' }, 'L'), 'Done 1.3 L by Sam');
});

// ── the grid ──
test('isHoldingRefusal: the 55000 still holds words open the Not yet modal, nothing else does', () => {
  const words = 'Northgate still holds 4 L of Test sauce. Use it up or count it to zero first, then switch to Made to order.';
  assert.equal(P.isHoldingRefusal({ code: '55000', message: words }), true);
  assert.equal(P.isHoldingRefusal({ message: words }), true, 'the words alone are enough');
  assert.equal(P.isHoldingRefusal(new Error(words)), true);
  assert.equal(P.isHoldingRefusal({ code: '55000', message: 'Not written at Northgate: the item is not set up there.' }), false);
  assert.equal(P.isHoldingRefusal({ code: '42501', message: 'Only head office can change this.' }), false);
  assert.equal(P.isHoldingRefusal(null), false);
  assert.equal(P.isHoldingRefusal('This needs a database update. Ask ServOS to run it.'), false);
});

test('howSavedWords is the mockup toast', () => {
  assert.equal(P.howSavedWords('Northgate', 'Test sauce', 'batches'), 'Northgate now gets Test sauce: Made here.');
  assert.equal(P.howSavedWords('', '', 'to_order'), 'The site now gets the batch: Made to order.');
});

const ROW = { recipe_id: 'r-1', name: 'Test sauce', yield_words: '10 L', row_version: 3, sites: [
  { location_id: 'a', on: true, how: 'batches', holds: 4, unit: 'L' },
  { location_id: 'b', on: true, how: null, holds: 0, unit: 'L' },
  { location_id: 'c', on: false, how: null, holds: null, unit: null },
] };

test('siteCell and holdsWords', () => {
  assert.deepEqual(P.siteCell(ROW, 'a'), { on: true, how: 'batches', holds: 4, unit: 'L' });
  assert.deepEqual(P.siteCell(ROW, 'b'), { on: true, how: 'batches', holds: 0, unit: 'L' }, 'no how yet reads as Made here (today\'s behaviour)');
  assert.equal(P.siteCell(ROW, 'c'), null, 'off there: Not used');
  assert.equal(P.siteCell(ROW, 'zzz'), null);
  assert.equal(P.siteCell(null, 'a'), null);
  assert.equal(P.holdsWords(P.siteCell(ROW, 'a')), 'holds 4 L');
  assert.equal(P.holdsWords(P.siteCell(ROW, 'b')), '');
  assert.equal(P.holdsWords(null), '');
  assert.equal(P.holdsWords({ holds: 2.55, unit: '' }), 'holds 2.6');
});

test('applyHow writes the saved choice and the new version into one row only, others untouched', () => {
  const other = { recipe_id: 'r-2', row_version: 1, sites: [{ location_id: 'a', on: true, how: 'bought' }] };
  const rows = [ROW, other];
  const out = P.applyHow(rows, 'r-1', 'a', { ok: true, location_id: 'a', how: 'to_order', row_version: 4 });
  assert.equal(out[1], other, 'the other row is the same object');
  assert.equal(out[0].row_version, 4);
  assert.equal(out[0].sites[0].how, 'to_order');
  assert.equal(out[0].sites[1].how, null, 'the other site unchanged');
  assert.equal(ROW.sites[0].how, 'batches', 'the row given is not changed');
  const same = P.applyHow(rows, 'r-1', 'a', null);
  assert.equal(same[0].row_version, 3);
  assert.deepEqual(P.applyHow(null, 'r-1', 'a', {}), []);
});

test('appendRows never shows a recipe twice; gridMinWidth grows a column a site', () => {
  const more = [{ recipe_id: 'r-1', name: 'dup' }, { recipe_id: 'r-9', name: 'new' }];
  const out = P.appendRows([ROW], more);
  assert.deepEqual(out.map((r) => r.recipe_id), ['r-1', 'r-9']);
  assert.equal(out[0], ROW);
  assert.deepEqual(P.appendRows(null, null), []);
  assert.equal(P.gridMinWidth(0), 370);
  assert.equal(P.gridMinWidth(3), 820);
  assert.equal(P.gridMinWidth('x'), 370);
});
