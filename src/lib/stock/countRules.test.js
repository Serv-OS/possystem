/** countRules.test.js — approving a count: the plan, the guard, the words. Run: npm test */
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
  assert.doesNotMatch(t, /[–—]/, 'no long dashes');
});

test('approveCount checks every write and only then marks the count APPROVED', () => {
  const src = readFileSync(resolve(here, './counts.js'), 'utf8');
  assert.match(src, /import \{ countApprovalPlan, approvalOutcomeText \} from '\.\/countRules\.js';/);
  assert.match(src, /if \(mv\?\.error\) return \{/, 'a refused movement stops the approval');
  assert.match(src, /if \(lineErr\) return \{/, 'a refused line update stops the approval');
  assert.match(src, /if \(headErr\) return \{ error: headErr/, 'the APPROVED write itself is checked');
  const approved = src.indexOf("status: 'APPROVED'");
  const loop = src.indexOf('for (const a of plan.adjustments)');
  assert.ok(loop > 0 && approved > loop, 'APPROVED is written after the adjustments, never before');
});
