/**
 * xeroGaps.test.js: Xero never skips a day quietly (8 Oct 2026, plan Fix 4, decision D5).
 * Run: `npm test`, or `node --test src/lib/accounting/xeroGaps.test.js`.
 *
 * Coffee Boy Leeds business day 30 Sep 2026 traded 143 sales and was never posted to Xero:
 * 29 Sep and 1 Oct were pushed by hand on 2 Oct, 30 Sep was not, and nothing noticed. The gap
 * scan finds it, the Postings tab shows it in red with a Push button, and after two days one
 * notice goes to the venue and the admin. Nothing posts by itself (a day keyed into Xero by hand
 * would be posted twice).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findXeroGaps, salesByBusinessDay, gapNotice, gapNoticeId, markGaps, daysBetween, gapDayWords, GAP_SCAN_DAYS, GAP_NOTICE_AFTER_DAYS } from '../../../supabase/functions/_shared/xeroGaps.js';
import { businessDayOf } from '../../../supabase/functions/_shared/businessDay.js';

const LEEDS = { tz: 'Europe/London', dayStart: '06:30' };
const dayOf = (ms) => businessDayOf(ms, LEEDS.tz, LEEDS.dayStart);
const ok = (ref_date) => ({ ref_date, status: 'ok' });

test('the Leeds 30 Sep gap: 29 Sep and 1 Oct ok, 30 Sep had sales and no row, so 30 Sep is the gap', () => {
  const gaps = findXeroGaps({
    lastCompletedDay: '2026-10-07', postMode: 'sales_invoice', invoiceStartDate: '2026-09-27',
    logRows: [ok('2026-09-27'), ok('2026-09-28'), ok('2026-09-29'), ok('2026-10-01'), ok('2026-10-02'), ok('2026-10-03'), ok('2026-10-04'), ok('2026-10-05'), ok('2026-10-06'), ok('2026-10-07')],
    salesByDay: { '2026-09-29': { count: 150, gross: 900 }, '2026-09-30': { count: 143, gross: 865.07 }, '2026-10-01': { count: 160, gross: 950 }, '2026-10-07': { count: 170, gross: 1000 } },
  });
  assert.deepEqual(gaps, [{ date: '2026-09-30', sales: 143, gross: 865.07, ageDays: 7, logStatus: null, notice: true }]);
});

test('a quiet day is not a gap; a day before the invoice start day is not a gap; a failed day is a gap that says so', () => {
  const gaps = findXeroGaps({
    lastCompletedDay: '2026-10-07', postMode: 'sales_invoice', invoiceStartDate: '2026-10-01',
    logRows: [ok('2026-10-01'), { ref_date: '2026-10-02', status: 'error' }, { ref_date: '2026-10-03', status: 'running' }],
    salesByDay: { '2026-09-30': { count: 143, gross: 865 }, '2026-10-01': { count: 10, gross: 50 }, '2026-10-02': { count: 12, gross: 60 }, '2026-10-03': { count: 9, gross: 40 }, '2026-10-06': { count: 0, gross: 0 }, '2026-10-07': { count: 20, gross: 100 } },
  });
  assert.deepEqual(gaps.map((g) => [g.date, g.logStatus, g.ageDays, g.notice]), [
    ['2026-10-02', 'error', 5, true],
    ['2026-10-03', 'running', 4, true],
    ['2026-10-07', null, 0, false],   // yesterday: a gap, but no notice yet
  ]);
  // an ok row beats an older failed one for the same day
  assert.deepEqual(findXeroGaps({ lastCompletedDay: '2026-10-07', postMode: 'sales_invoice', invoiceStartDate: '2026-10-01', logRows: [{ ref_date: '2026-10-07', status: 'error' }, ok('2026-10-07')], salesByDay: { '2026-10-07': { count: 3, gross: 10 } } }), []);
  // a site on bank transactions is not scanned (D5: the invoice model only)
  assert.deepEqual(findXeroGaps({ lastCompletedDay: '2026-10-07', postMode: 'bank_tx', invoiceStartDate: null, logRows: [], salesByDay: { '2026-10-07': { count: 3, gross: 10 } } }), []);
  assert.deepEqual(findXeroGaps({ lastCompletedDay: 'nonsense', postMode: 'sales_invoice', salesByDay: {} }), []);
  assert.equal(GAP_SCAN_DAYS, 14);
  assert.equal(GAP_NOTICE_AFTER_DAYS, 2);
  assert.equal(daysBetween('2026-09-30', '2026-10-07'), 7);
});

test('sales per business day: a 00:30 sale is the night before, voided and nothing rows count for nothing', () => {
  const rows = [
    { id: 'a', closed_at: '2026-09-30T12:00:00Z', total: 5 },
    { id: 'b', closed_at: '2026-10-01T00:30:00Z', total: 7 },           // 01:30 UK: still 30 Sep's business day
    { id: 'c', closed_at: '2026-10-01T06:00:00Z', total: 3 },           // 07:00 UK: 1 Oct
    { id: 'd', closed_at: '2026-10-01T09:00:00Z', total: 9, status: 'voided' },
    { id: 'e', closed_at: '2026-10-01T09:30:00Z', total: 0 },
  ];
  assert.deepEqual(salesByBusinessDay(rows, dayOf), { '2026-09-30': { count: 2, gross: 12 }, '2026-10-01': { count: 1, gross: 3 } });
});

test('the notice: plain words, no dashes, one id per site and day', () => {
  const gap = { date: '2026-09-30', sales: 143, gross: 865.07, ageDays: 7 };
  const n = gapNotice({ siteName: 'Coffee Boy Leeds', gap });
  assert.equal(n.kind, 'info');
  assert.equal(n.title, 'Xero: a day is not posted');
  assert.equal(n.body, 'Coffee Boy Leeds: the sales of Wed 30 Sep 2026 are not in Xero. 143 sales, £865.07. Open Back Office, Xero, Postings and press Push on that day. Nothing posts by itself. If the day was keyed into Xero by hand, press Push anyway: ServOS checks before it sends.');
  assert.ok(!/[–—]/.test(n.body + n.title));
  assert.ok(n.body.length <= 600, 'fits venue_messages.body');
  assert.equal(gapDayWords('2026-09-30'), 'Wed 30 Sep 2026');
  const id = gapNoticeId('1e252e7c-c875-4971-b91d-1e945c26956b', '2026-09-30');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, gapNoticeId('1e252e7c-c875-4971-b91d-1e945c26956b', '2026-09-30'), 'the same every time');
  assert.notEqual(id, gapNoticeId('1e252e7c-c875-4971-b91d-1e945c26956b', '2026-10-01'));
  assert.notEqual(id, gapNoticeId('other-site', '2026-09-30'));
});

test('the Postings tab: a waiting day with sales is missing (red, Push), a waiting day with none is quiet, a gap with no row is added', () => {
  const rows = [
    { date: '2026-10-07', locationId: 'L', site: 'Leeds', status: 'posted' },
    { date: '2026-10-06', locationId: 'L', site: 'Leeds', status: 'waiting' },
    { date: '2026-10-05', locationId: 'L', site: 'Leeds', status: 'waiting' },
    { date: '2026-10-04', locationId: 'L', site: 'Leeds', status: 'failed' },
  ];
  const gaps = { L: [{ date: '2026-09-30', sales: 143, gross: 865.07, ageDays: 7 }, { date: '2026-10-04', sales: 9, gross: 40, ageDays: 3, logStatus: 'error' }, { date: '2026-10-06', sales: 5, gross: 20, ageDays: 1 }] };
  const out = markGaps(rows, gaps);
  assert.deepEqual(out.map((r) => [r.date, r.status, !!r.gap]), [
    ['2026-10-07', 'posted', false],
    ['2026-10-06', 'missing', true],
    ['2026-10-05', 'quiet', false],
    ['2026-10-04', 'failed', true],
    ['2026-09-30', 'missing', true],
  ]);
  assert.equal(out[4].totals.sales, 865.07);
  assert.deepEqual(markGaps(rows, {}).map((r) => r.status), ['posted', 'quiet', 'quiet', 'failed']);
});
