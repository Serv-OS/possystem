// src/lib/receiptDiscountLines.test.js (29 Oct 2026, v5.11.114): a bill's discounts reach the
// printed receipt and the till's History screen as named lines. The receipt builder could always
// print them; the till never handed over the list. These pin the rule and the four hand overs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { receiptDiscountLines } from './receiptDiscountLines.js';
import { buildCustomerReceiptDoc } from './printDoc.js';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const pepperoni = [{ uid: 'a', name: 'Pepperoni', qty: 1, price: 16, status: 'sent' }];

test('a 10% check discount on a 16.00 bill is one named line of 1.60 (the Provo case)', () => {
  const lines = receiptDiscountLines(pepperoni, [{ id: 'd1', type: 'percent', value: 10, label: '10% Off Soft Drinks', scope: 'check' }]);
  assert.deepEqual(lines, [{ label: '10% Off Soft Drinks', amount: 1.6 }]);
});

test('an amount discount keeps its value; a voided line is not in the basis; nothing taken = no line', () => {
  assert.deepEqual(receiptDiscountLines(pepperoni, [{ type: 'amount', value: 2, label: 'Custom £2' }]), [{ label: 'Custom £2', amount: 2 }]);
  const voided = [{ ...pepperoni[0], voided: true }, { uid: 'b', name: 'Water', qty: 1, price: 2 }];
  assert.deepEqual(receiptDiscountLines(voided, [{ type: 'percent', value: 50, label: 'Half' }]), [{ label: 'Half', amount: 1 }]);
  assert.deepEqual(receiptDiscountLines(pepperoni, [{ type: 'percent', value: 0, label: 'Nothing' }]), []);
  assert.deepEqual(receiptDiscountLines(pepperoni, null), []);
  assert.deepEqual(receiptDiscountLines(null, [{ type: 'amount', value: 1, label: 'x' }]), [{ label: 'x', amount: 1 }]);
});

test('auto discounts and saved rows pass through with the amount they carry, in order', () => {
  const auto = [{ id: 'r1', label: 'Lunch deal', type: 'amount', value: 3, amount: 3, isAuto: true }];
  const lines = receiptDiscountLines(pepperoni, [{ type: 'percent', value: 10, label: 'Ten' }], auto);
  assert.deepEqual(lines, [{ label: 'Ten', amount: 1.6 }, { label: 'Lunch deal', amount: 3 }]);
  // a closed_checks row already carries amount: the same figure comes back, never recomputed differently
  const saved = [{ id: 'd', kind: null, type: 'percent', label: 'running club', scope: 'check', value: 10, amount: 0.595, manager: null }];
  assert.deepEqual(receiptDiscountLines([{ name: 'Flat white', qty: 1, price: 5.95 }], saved), [{ label: 'running club', amount: 0.6 }]);
});

test('the printed receipt shows the line between Subtotal and TOTAL when the till hands the list over', () => {
  const base = { location: { name: 'Provo', currency: 'GBP' }, items: pepperoni, totals: { subtotal: 16, service: 0, tip: 0, grand: 14.4, taxBreakdown: null } };
  const rows = (check) => buildCustomerReceiptDoc({ ...base, check }).ops.filter(o => o.t === 'twoCol').map(o => `${o.l} ${o.r}`);
  const without = rows({ ref: '#1', orderType: 'takeaway' });
  assert.ok(without.some(r => r.startsWith('Subtotal')) && !without.some(r => r.includes('Off')), 'before: Subtotal then TOTAL, no explanation');
  const withList = rows({ ref: '#1', orderType: 'takeaway', discounts: receiptDiscountLines(pepperoni, [{ type: 'percent', value: 10, label: '10% Off Soft Drinks' }]) });
  const i = withList.findIndex(r => r.startsWith('Subtotal'));
  assert.ok(i >= 0 && withList[i + 1].startsWith('10% Off Soft Drinks -'), `after: ${withList.join(' | ')}`);
  assert.match(withList[i + 1], /1\.60$/);
});

test('the till receipt at pay, the Receipt dialog print and the History reprint all hand the list over', () => {
  const pos = read('src/surfaces/POSSurface.jsx');
  assert.ok(pos.includes("import { receiptDiscountLines } from '../lib/receiptDiscountLines';"));
  assert.ok(pos.includes('const discounts = receiptDiscountLines(nonVoided, liveDiscounts, autoDiscounts);'), 'receipt snapshot builds the lines');
  assert.ok(/loyaltyRewards: receiptRewardLines\(paymentInfo\.loyaltyRedemption\), discounts \}/.test(pos), 'and puts them on the printed check');
  assert.ok(/<ReceiptModal[\s\S]*?discounts=\{receiptDiscountLines\(items,/.test(pos), 'the Receipt dialog is given the lines');
  const modal = read('src/components/ReceiptModal.jsx');
  assert.ok(modal.includes('discounts = []'), 'the dialog takes them');
  assert.ok(/check: \{ ref: checkRef, server, tableLabel, orderType, covers, method, discounts: /.test(modal), 'and prints them');
  const hist = read('src/components/CheckHistory.jsx');
  assert.ok(hist.includes('discounts: receiptDiscountLines(nonVoided, selectedCheck.discounts),'), 'History reprint');
});

test('the History screen lists each discount under Subtotal, before the rewards', () => {
  const hist = read('src/components/CheckHistory.jsx');
  const sub = hist.indexOf('<span>Subtotal</span>');
  const disc = hist.indexOf('receiptDiscountLines(selectedCheck.items, selectedCheck.discounts).map(');
  const rewards = hist.indexOf('receiptRewardsOf(selectedCheck).map(');
  assert.ok(sub > 0 && disc > sub && rewards > disc, 'Subtotal, then the discounts, then the rewards');
  assert.ok(hist.slice(disc, rewards).includes('{d.label}') && hist.slice(disc, rewards).includes('money(d.amount)'));
});
