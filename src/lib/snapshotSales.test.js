/**
 * snapshotSales.test.js: the Owner app (owner-snapshot) and Manager app (manager-snapshot) takings.
 * Run: `npm test`, or `node --test src/lib/snapshotSales.test.js`.
 *
 * 27 Sep 2026: both functions took net sales (ex-VAT) = closed_checks.subtotal and gross = total.
 * The subtotal is shelf prices before every discount and, at a UK venue, includes VAT, so net was
 * overstated by the VAT and by every discount and comp. Both also read closed_checks in ONE request
 * with .limit(50000) / .limit(20000), but PostgREST answers at most 1000 rows a request (max_rows on
 * the Ops project), so the rest of a busy window was silently lost. Several rows below are real
 * Coffee Boy Leeds checks (26 and 27 Sep), trimmed to the columns the snapshots read.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SALES_CHECK_COLS, emptySales, addCheckSales } from '../../supabase/functions/_shared/snapshotSales.js';
import { pagedRows, PAGE } from '../../supabase/functions/_shared/pagedRows.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const card = (amount, tip = 0) => ({ method: 'card', amount, tip, processor: 'adyen' });
const day = (rows) => { const a = emptySales(); for (const r of rows) addCheckSales(a, r); return a; };
const sameDay = (a, { net, vat, gross, orders, tips }) => { near(a.net, net); near(a.vat, vat); near(a.gross, gross); assert.equal(a.orders, orders); near(a.tips, tips); };

test('UK, no discount: net takes the VAT out of what was paid (it was the VAT inclusive subtotal)', () => {
  // £12 of shelf prices at 20%: the old snapshot said net £12.
  sameDay(day([{ subtotal: 12, total: 12, tax_amount: 2, service: 0, tip: 0, tenders: [card(12)] }]), { net: 10, vat: 2, gross: 12, orders: 1, tips: 0 });
});

test('UK staff 50%: half the sales (the shelf subtotal said full price)', () => {
  sameDay(day([{
    subtotal: 8.4, total: 4.2, tax_amount: 0.7, service: 0, tip: 0,
    discounts: [{ type: 'percent', label: 'Staff Discount 50%', scope: 'check', value: 50, amount: 4.2 }],
    tenders: [card(4.2)],
  }]), { net: 3.5, vat: 0.7, gross: 4.2, orders: 1, tips: 0 });
});

test('a 100% comp is still an order, at £0; its phantom cash tender is not takings', () => {
  // Leeds chk-1790408579352-a20a98 (before v5.9.97): total = subtotal and a cash tender for money never taken.
  const comp = { subtotal: 4.1, total: 4.1, tax_amount: 0.68, service: 0, tip: 0, discounts: [{ type: 'percent', label: 'Custom 100%', scope: 'check', value: 100, amount: 4.1 }], tenders: [{ method: 'cash', amount: 4.1, tip: 0 }] };
  sameDay(day([comp]), { net: 0, vat: 0, gross: 0, orders: 1, tips: 0 });
});

test('a drink paid by a loyalty reward is a discount, not takings', () => {
  // Leeds chk-1790501999278-037bf2
  sameDay(day([{ subtotal: 2.95, total: 2.95, tax_amount: 0.49, service: 0, tip: 0, method: 'loyalty+cash', tenders: [{ method: 'loyalty', amount: 2.95, tip: 0 }] }]), { net: 0, vat: 0, gross: 0, orders: 1, tips: 0 });
});

test('a reader sale whose discount the row never recorded: what the card took', () => {
  // Leeds chk-1790416675425-b72ce3: shelf £4.10, card £3.69, discounts [].
  sameDay(day([{ subtotal: 4.1, total: 3.69, tax_amount: 0.62, service: 0, tip: 0, discounts: [], source: 'pos_send_to_terminal', tenders: [card(3.69)] }]), { net: 3.07, vat: 0.62, gross: 3.69, orders: 1, tips: 0 });
});

test('a kiosk row (total net of credits, no tenders): the gift card counts, the total alone did not', () => {
  // £10 order: £3 gift card, £7 card plus a £1 tip. The old gross (total) said £8.
  sameDay(day([{ source: 'kiosk', subtotal: 10, total: 8, tax_amount: 1.67, service: 0, tip: 1, method: 'card', gift_card: { applied: 300 } }]), { net: 8.33, vat: 1.67, gross: 10, orders: 1, tips: 1 });
});

test('tips and service are never sales; tips are the check\'s own tip', () => {
  sameDay(day([{ subtotal: 40, total: 48, tax_amount: 6.67, service: 5, tip: 3, tenders: [card(45, 3)] }]), { net: 33.33, vat: 6.67, gross: 40, orders: 1, tips: 3 });
});

test('US added-on tax with a discount: net is the discounted goods', () => {
  sameDay(day([{ subtotal: 100, total: 87.1, tax_amount: 7.1, service: 0, tip: 0, discounts: [{ amount: 20 }], tenders: [card(87.1)] }]), { net: 80, vat: 7.1, gross: 87.1, orders: 1, tips: 0 });
});

test('voided checks count for nothing, by either flag', () => {
  const a = emptySales();
  assert.equal(addCheckSales(a, { voided: true, subtotal: 10, total: 10, tax_amount: 1.67, tip: 1, tenders: [card(10, 1)] }), false);
  assert.equal(addCheckSales(a, { status: 'Voided', subtotal: 10, total: 10, tax_amount: 1.67, tip: 1, tenders: [card(10, 1)] }), false);
  sameDay(a, { net: 0, vat: 0, gross: 0, orders: 0, tips: 0 });
});

test('a day adds up check by check: gross = net + VAT', () => {
  const a = day([
    { subtotal: 12, total: 12, tax_amount: 2, service: 0, tip: 0.5, tenders: [card(12, 0.5)] },
    { subtotal: 8.4, total: 4.2, tax_amount: 0.7, service: 0, tip: 0, discounts: [{ amount: 4.2 }], tenders: [card(4.2)] },
    { subtotal: 4.1, total: 0, tax_amount: 0, service: 0, tip: 0, discounts: [{ amount: 4.1 }], tenders: [{ method: 'cash', amount: 0, tip: 0 }] },
  ]);
  sameDay(a, { net: 13.5, vat: 2.7, gross: 16.2, orders: 3, tips: 0.5 });
  near(Math.round((a.net + a.vat) * 100), Math.round(a.gross * 100));
});

test('SALES_CHECK_COLS carries every column checkSalesParts reads', () => {
  const cols = SALES_CHECK_COLS.split(',').map((s) => s.trim());
  for (const c of ['id', 'closed_at', 'subtotal', 'total', 'tax_amount', 'service', 'tip', 'discounts', 'tenders', 'method', 'payment_method', 'source', 'processor', 'gift_card', 'loyalty', 'promo', 'payment_intents', 'voided', 'status']) {
    assert.ok(cols.includes(c), `SALES_CHECK_COLS is missing ${c}`);
  }
  // The same list trading-report reads its checks with.
  const tr = fs.readFileSync(path.join(here, '../../supabase/functions/trading-report/index.ts'), 'utf8');
  const trCols = (/const CHECK_COLS = '([^']+)'/.exec(tr)?.[1] ?? '').split(',').map((s) => s.trim());
  assert.deepEqual([...cols].sort(), [...trCols].sort());
});

// A PostgREST stand-in that, like the Ops project, answers at most 1000 rows a request.
function capped(rows, calls, failAt = -1) {
  return () => ({
    range(from, to) {
      calls.push([from, to]);
      if (calls.length - 1 === failAt) return Promise.resolve({ data: null, error: { message: 'canceling statement due to statement timeout' } });
      return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null });
    },
  });
}

test('pagedRows reads past the 1000 row cap, 1000 a page', async () => {
  const rows = Array.from({ length: 2345 }, (_, i) => ({ id: i }));
  const calls = [];
  const got = await pagedRows('closed checks', capped(rows, calls));
  assert.equal(PAGE, 1000);
  assert.equal(got.length, 2345);
  assert.deepEqual(got.map((r) => r.id), rows.map((r) => r.id));
  assert.deepEqual(calls, [[0, 999], [1000, 1999], [2000, 2999]]);
});

test('pagedRows: exactly a page full asks once more; nothing at all is one request', async () => {
  const calls = [];
  assert.equal((await pagedRows('x', capped(Array.from({ length: 1000 }, (_, i) => i), calls))).length, 1000);
  assert.equal(calls.length, 2);
  const none = [];
  assert.deepEqual(await pagedRows('x', capped([], none)), []);
  assert.equal(none.length, 1);
});

test('pagedRows: a failed page is an error, never fewer rows', async () => {
  const rows = Array.from({ length: 1500 }, (_, i) => i);
  await assert.rejects(pagedRows('closed checks', capped(rows, [], 1)), /Could not read closed checks: canceling statement/);
});

// Source pins: each function reads checks through the shared reading, paged, with no capped reads.
const read = (fn) => fs.readFileSync(path.join(here, `../../supabase/functions/${fn}/index.ts`), 'utf8');
for (const fn of ['owner-snapshot', 'manager-snapshot']) {
  test(`${fn} reads every check through addCheckSales, paged, never the shelf subtotal`, () => {
    const src = read(fn);
    assert.match(src, /import \{ pagedRows \} from '\.\.\/_shared\/pagedRows\.js';/);
    assert.match(src, /import \{ SALES_CHECK_COLS, emptySales, addCheckSales \} from '\.\.\/_shared\/snapshotSales\.js';/);
    assert.match(src, /addCheckSales\(/);
    // Sales never come from the subtotal or the total.
    assert.doesNotMatch(src, /Number\(c\.subtotal\)/);
    assert.doesNotMatch(src, /Number\(c\.total\)/);
    // Every paged read, from `pagedRows(` to the end of its query.
    const paged = [...src.matchAll(/pagedRows\('([^']+)', \(\) => /g)].map((m) => {
      const q = src.slice(m.index + m[0].length);
      return { what: m[1], q: q.slice(0, q.search(/\)\)[,;]/) + 1) };
    });
    // Every closed_checks read pages, in closed_at then id order, and the sales read uses the tender columns.
    const checkReads = paged.filter((p) => p.q.includes(".from('closed_checks')"));
    assert.equal(checkReads.length, (src.match(/\.from\('closed_checks'\)/g) ?? []).length, 'a closed_checks read outside pagedRows');
    assert.ok(checkReads.some((p) => p.q.includes('.select(SALES_CHECK_COLS)')), 'no closed_checks read with SALES_CHECK_COLS');
    for (const p of checkReads) assert.match(p.q, /\.order\('closed_at'\)\.order\('id'\)$/);
    // Every read that pages is ordered on a unique key (order_queue's is location_id + ref).
    for (const p of paged) assert.match(p.q, /\.order\('(id|ref)'\)$/, `${fn}: '${p.what}' pages without a unique order`);
    // PostgREST returns at most 1000 rows a request: a .limit() of 1000 or more is a lie.
    for (const m of src.replace(/\/\/[^\n]*/g, '').matchAll(/\.limit\((\d+)\)/g)) assert.ok(Number(m[1]) < 1000, `${fn} still has .limit(${m[1]})`);
  });
}

test('owner-snapshot answers VAT with net, and a failed read is a 500, not £0', () => {
  const src = read('owner-snapshot');
  assert.match(src, /net_sales: r2\(t\.net\), vat: r2\(t\.vat\), gross_sales: r2\(t\.gross\)/);
  assert.match(src, /return json\(\{ error: \(e as Error\)\?\.message \|\| 'Could not build the snapshot' \}, 500\);/);
  // Items (the heavy column) are read for today only, never the whole sales window.
  assert.match(src, /select\('id, closed_at, status, voided, items'\)\s*\n?\s*\.eq\('location_id', id\)\.gte\('closed_at', todayIso\)/);
});

test('manager-snapshot answers VAT with net', () => {
  assert.match(read('manager-snapshot'), /net: r2\(net\), vat: r2\(vat\), gross: r2\(gross\), orders, tips: r2\(tips\),/);
});
