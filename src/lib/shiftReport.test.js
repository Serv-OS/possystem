// 28 Sep 2026: the till's X and Z report (lib/shiftReport.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checksForBusinessDay, summariseShift, buildShiftReportDoc } from './shiftReport.js';

const LON = 'Europe/London';
const at = (iso) => Date.parse(iso);

test('only the business day that now falls in, on the venue clock and day start', () => {
  const checks = [
    { id: 'a', closedAt: at('2026-09-28T05:10:00Z') },   // 06:10 BST, after a 06:00 start: today
    { id: 'b', closedAt: at('2026-09-28T04:50:00Z') },   // 05:50 BST: still yesterday's day
    { id: 'c', closed_at: '2026-09-28T11:00:00Z' },      // snake case row: today
    { id: 'd' },                                         // no close time: left out
  ];
  const got = checksForBusinessDay(checks, { now: at('2026-09-28T12:00:00Z'), timezone: LON, dayStart: '06:00' }).map((c) => c.id);
  assert.deepEqual(got, ['a', 'c']);
});

test('the figures are the Sales summary ones, and voided checks stay out of the payment methods', () => {
  const { stats, byMethod } = summariseShift([
    { subtotal: 10, total: 10, taxAmount: 1.67, method: 'card', status: 'paid' },
    { subtotal: 5, total: 5, taxAmount: 0.83, method: 'Cash', status: 'paid' },
    { subtotal: 4, total: 4, method: 'card', status: 'voided' },
  ]);
  assert.equal(stats.gross, 19);
  assert.equal(stats.count, 2);
  assert.deepEqual(byMethod.map((m) => [m.method, m.count, m.total]), [['card', 1, 10], ['cash', 1, 5]]);
});

test('a Z report prints the drawer; an X report says nothing is reset', () => {
  const base = { venueName: 'Coffee Boy Leeds', dayLabel: '2026-09-28', stats: summariseShift([{ subtotal: 10, total: 10, taxAmount: 1.67, method: 'card' }]).stats, byMethod: [{ method: 'card', count: 1, total: 10 }], currency: 'GBP' };
  const z = JSON.stringify(buildShiftReportDoc({ ...base, kind: 'Z', drawer: { expected: 100, declared: 98.5, variance: -1.5 } }));
  assert.match(z, /Z REPORT/);
  assert.match(z, /Expected cash/);
  assert.match(z, /Variance \(short\)/);
  const x = JSON.stringify(buildShiftReportDoc({ ...base, kind: 'X' }));
  assert.match(x, /X REPORT/);
  assert.match(x, /nothing is reset/);
  assert.doesNotMatch(x, /Expected cash/);
});

test('wiring: X report button in the drawer menu, Z report at a successful cash up', () => {
  const pos = fs.readFileSync(new URL('../surfaces/POSSurface.jsx', import.meta.url), 'utf8');
  assert.match(pos, /onClick=\{\(\) => \{ if \(!requirePerm\(\)\) return; setShowDrawerMenu\(false\); printShiftReportNow\('X'\); \}\}/);
  assert.match(pos, /if \(result\) \{\n\s*printShiftReportNow\('Z', \{ expected: result\.expected, declared: result\.declared, variance: result\.variance \}\);\n\s*signOutAfterCashUp\?\.\(\);/);
  const pr = fs.readFileSync(new URL('./printer.js', import.meta.url), 'utf8');
  assert.match(pr, /async printShiftReport\(report, printerId = null, opts = \{\}\)/);
});
