/** countRules.test.js: approving a count: the plan, the guard, the words. Run: npm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canApproveCount, countApprovalPlan, approvalOutcomeText } from './countRules.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));

const lines = [
  { id: 'l1', inventory_item_id: 'beans', counted_qty: 12, expected_qty: 12.55 },
  { id: 'l2', inventory_item_id: 'milk', counted_qty: null, expected_qty: 44 },
  { id: 'l3', inventory_item_id: 'buns', counted_qty: 50, expected_qty: 48 },
];

test('canApproveCount: nothing counted means nothing to approve', () => {
  assert.equal(canApproveCount(lines), true);
  assert.equal(canApproveCount([{ id: 'x', counted_qty: null }, { id: 'y', counted_qty: '' }]), false);
  assert.equal(canApproveCount([]), false);
  assert.equal(canApproveCount(null), false);
  assert.equal(canApproveCount([{ id: 'z', counted_qty: 0 }]), true, 'a counted zero is a count');
});

test('countApprovalPlan: delta moves the ledger to the counted figure, varQty is against the snapshot', () => {
  // beans sold 0.3 kg since the count started: on hand now 12.25
  const plan = countApprovalPlan(lines, { beans: 12.25, milk: 40, buns: 48 }, { beans: 17.28, buns: 0.3 });
  assert.equal(plan.counted, 2);
  assert.equal(plan.uncounted, 1);
  assert.deepEqual(plan.adjustments.map((a) => a.lineId), ['l1', 'l3']);
  const beans = plan.adjustments[0];
  assert.ok(Math.abs(beans.delta - (12 - 12.25)) < 1e-9);
  assert.ok(Math.abs(beans.varQty - (12 - 12.55)) < 1e-9);
  const buns = plan.adjustments[1];
  assert.equal(buns.delta, 2);
  assert.equal(buns.varQty, 2);
  // variance value = sum(varQty x cost): -0.55 x 17.28 + 2 x 0.3
  assert.ok(Math.abs(plan.varianceValue - (-0.55 * 17.28 + 0.6)) < 1e-4);
  assert.deepEqual(countApprovalPlan([], {}, {}), { adjustments: [], varianceValue: 0, counted: 0, uncounted: 0 });
});

test('approvalOutcomeText says what happened in plain words', () => {
  assert.equal(approvalOutcomeText({ posted: 3, total: 3 }), 'Count approved: 3 lines adjusted, stock reconciled.');
  assert.equal(approvalOutcomeText({ posted: 0, total: 0 }), 'Count approved. Nothing differed from the system, so no stock moved.');
  const t = approvalOutcomeText({ posted: 1, total: 3, failedItem: 'Oat Milk', error: new Error('x') });
  assert.match(t, /^Not approved: 1 of 3 adjustments posted before the save failed at Oat Milk\./);
  assert.match(t, /approve again/);
  assert.doesNotMatch(t, /[\u2013\u2014]/, 'no long dashes');
});

test('approveCount checks every write and only then marks the count APPROVED', () => {
  const src = readFileSync(resolve(here, './counts.js'), 'utf8');
  // v5.11.82 (multi site stock Drop 0): approval is ONE database call (stock_approve_count_pin, else
  // approve_stock_count), all or nothing: the database posts every adjustment, checks each one, and
  // marks the count APPROVED last, in one transaction. The old browser loop (a post per line, then
  // the APPROVED write) never ran once 20261019b was in and is gone; countApprovalPlan and
  // approvalOutcomeText stay as the pure rules (tested here) the words are built from.
  const fn = src.slice(src.indexOf('export const approveCount'));
  assert.ok(fn.indexOf("supabase.rpc('stock_approve_count_pin'") > 0, 'the one call with a PIN');
  assert.ok(fn.indexOf("supabase.rpc('approve_stock_count'") > fn.indexOf("supabase.rpc('stock_approve_count_pin'"), 'the call without a PIN only after it');
  assert.doesNotMatch(fn, /postStockMovement|status: 'APPROVED'|Promise\.all\(plan\.adjustments/, 'no browser post or APPROVED write is left');
  assert.match(fn, /const outcome = approvalOutcome\(res\);\s+if \(!outcome\.ok\) return \{ error: new Error\(outcome\.text\), needsCost: outcome\.needsCost \|\| null, data: res \};/, 'a refusal from the database is never read as approved');
  // and the words a count with no differences gets, through the caller's own numbers
  const plan = countApprovalPlan(
    [{ id: 'l1', inventory_item_id: 'a', expected_qty: 5, counted_qty: 5 }, { id: 'l2', inventory_item_id: 'b', expected_qty: 2, counted_qty: 2 }],
    { a: 5, b: 2 }, { a: 1, b: 1 });
  const moving = plan.adjustments.filter(a => a.delta !== 0).length;
  assert.equal(plan.adjustments.length, 2);
  assert.equal(moving, 0);
  assert.equal(approvalOutcomeText({ posted: moving, total: moving }), 'Count approved. Nothing differed from the system, so no stock moved.');
});
