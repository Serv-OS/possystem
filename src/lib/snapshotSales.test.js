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
// 2 Oct 2026: owner-snapshot's reads moved to _shared/ownerSnapshot.js (the quick filters:
// Today, This week, This month), where the check reads page through pagedEach, which adds each
// page up as it arrives. The same pins hold there; src/lib/ownerSnapshot.test.js runs the build
// itself against a database stand in that caps every request at 1000 rows.
const read = (fn) => fs.readFileSync(path.join(here, `../../supabase/functions/${fn}/index.ts`), 'utf8');
const SOURCES = {
  'owner-snapshot': { file: '../../supabase/functions/_shared/ownerSnapshot.js', dir: '\\.' },
  'manager-snapshot': { file: '../../supabase/functions/manager-snapshot/index.ts', dir: '\\.\\.\\/_shared' },
};
for (const fn of ['owner-snapshot', 'manager-snapshot']) {
  test(`${fn} reads every check through addCheckSales, paged, never the shelf subtotal`, () => {
    const src = fs.readFileSync(path.join(here, SOURCES[fn].file), 'utf8');
    const dir = SOURCES[fn].dir;
    assert.match(src, new RegExp(`import \\{ pagedRows(, pagedEach, limiter)? \\} from '${dir}\\/pagedRows\\.js';`));
    assert.match(src, new RegExp(`import \\{ SALES_CHECK_COLS, emptySales, addCheckSales \\} from '${dir}\\/snapshotSales\\.js';`));
    assert.match(src, /addCheckSales\(/);
    // Sales never come from the subtotal or the total.
    assert.doesNotMatch(src, /Number\(c\.subtotal\)/);
    assert.doesNotMatch(src, /Number\(c\.total\)/);
    // Every paged read, from `pagedRows(` or `pagedEach(` to the end of its query: `))` for
    // pagedRows (`)))` when it waits its turn in the limiter), `), (rows) =>` where pagedEach
    // is handed the page.
    const paged = [...src.matchAll(/paged(?:Rows|Each)\('([^']+)', \(\) => /g)].map((m) => {
      const q = src.slice(m.index + m[0].length);
      return { what: m[1], q: q.slice(0, q.search(/\)(?:\)+[,;]|, \(rows\) =>)/) + 1) };
    });
    assert.ok(paged.length >= 5, `${fn}: expected its paged reads, found ${paged.length}`);
    // Every closed_checks read pages, in closed_at then id order, and the sales read uses the tender columns.
    const checkReads = paged.filter((p) => p.q.includes(".from('closed_checks')"));
    // 5 Oct 2026: owner-snapshot has ONE closed_checks read outside pagedRows, on purpose: a
    // venue's opening day, from its oldest checks that are not voided, sixty at a time in
    // closed_at then id order, and at most FIRST_SALE_PAGES times, for the "New" word.
    const firstSale = fn === 'owner-snapshot' ? (src.match(/\.from\('closed_checks'\)\.select\('id, closed_at, status, voided'\)\s*\.eq\('location_id', id\)\.not\('voided', 'is', true\)\.order\('closed_at'\)\.order\('id'\)\s*\.range\(page \* FIRST_SALE_ROWS, \(page \+ 1\) \* FIRST_SALE_ROWS - 1\)/g) ?? []).length : 0;
    if (fn === 'owner-snapshot') { assert.equal(firstSale, 1, 'the first sale read'); assert.match(src, /const FIRST_SALE_ROWS = 60;/); assert.match(src, /const FIRST_SALE_PAGES = 5;/); }
    assert.equal(checkReads.length + firstSale, (src.match(/\.from\('closed_checks'\)/g) ?? []).length, 'a closed_checks read outside pagedRows');
    assert.ok(checkReads.some((p) => p.q.includes('.select(SALES_CHECK_COLS)')), 'no closed_checks read with SALES_CHECK_COLS');
    for (const p of checkReads) assert.match(p.q, /\.order\('closed_at'\)\.order\('id'\)$/);
    // Every read that pages is ordered on a unique key (order_queue's is location_id + ref).
    // (wf_venue_settings and xero_config have one row a venue: their key is location_id.)
    for (const p of paged) assert.match(p.q, /\.order\('(id|ref)'\)$|\.from\('(wf_venue_settings|xero_config)'\)[^;]*\.order\('location_id'\)$/, `${fn}: '${p.what}' pages without a unique order`);
    // PostgREST returns at most 1000 rows a request: a .limit() of 1000 or more is a lie.
    for (const m of src.replace(/\/\/[^\n]*/g, '').matchAll(/\.limit\((\d+)\)/g)) assert.ok(Number(m[1]) < 1000, `${fn} still has .limit(${m[1]})`);
  });
}

test('owner-snapshot answers VAT with net, and a failed read is a 500, not £0', () => {
  const src = read('owner-snapshot');
  const core = fs.readFileSync(path.join(here, SOURCES['owner-snapshot'].file), 'utf8');
  assert.match(core, /net_sales: r2\(t\.net\), vat: r2\(t\.vat\), gross_sales: r2\(t\.gross\)/);
  // The function hands the whole build to the shared file, and a throw from it is a 500.
  assert.match(src, /import \{ buildOwnerSnapshot \} from '\.\.\/_shared\/ownerSnapshot\.js';/);
  assert.match(src, /const snap = await buildOwnerSnapshot\(\{ ops: opsAdmin, opsIds, meta, now: new Date\(\), period \}\);/);
  assert.doesNotMatch(src, /\.from\('closed_checks'\)/, 'a closed_checks read outside the shared build');
  assert.match(src, /return json\(\{ error: \(e as Error\)\?\.message \|\| 'Could not build the snapshot' \}, 500\);/);
  // Items (the heavy column) are read for the period's own days (today's, under Today) and, since
  // 8 Oct 2026 (the Sales mix points), for the comparison span in its own read (cmpItemsOf), never
  // the whole sales window. ownerSnapshot.test.js checks the dates asked for.
  assert.match(core, /const itemsOf = \(id\) => Promise\.all\(windowsOf\(plan\[id\], \[\{ from: plan\[id\]\.range\.from, to: plan\[id\]\.today \}\], SLICE_DAYS\[period\]\)/);
  // 5 Oct 2026: the detail call goes through the shared build too, and every answer says what
  // the function can do, so an app can tell it from one that cannot.
  assert.match(src, /const out = await buildOwnerDetail\(\{ ops: opsAdmin, opsIds, meta, target, currency: body\?\.currency, now: new Date\(\), period \}\);/);
  assert.equal((src.match(/api: OWNER_API, features: OWNER_FEATURES/g) ?? []).length, 3, 'every answer carries api and features');
  // The currency and the day start come from the Platform locations row (The Cabin, a dollar
  // venue, was labelled GBP), never from a 'GBP' written into the function.
  assert.match(src, /\.select\('id, ops_location_id, name, timezone, currency, business_day_start'\)/);
  assert.match(src, /const meta = venueMeta\(opsIds, plocs \?\? \[\], vsRows \?\? \[\]\);/);
  assert.doesNotMatch(src, /currency: 'GBP'/);
});

test('manager-snapshot answers VAT with net', () => {
  assert.match(read('manager-snapshot'), /net: r2\(net\), vat: r2\(vat\), gross: r2\(gross\), orders, tips: r2\(tips\),/);
});

// v5.10.2: the Manager app's Clock out (v5.8.21) sends the punch's timesheet id to manager-approve,
// and the button only renders when the punch has one. The team read selected no `id`, so every
// punch went out with `id: undefined` and the button never showed.
test('manager-snapshot: every wf_timesheets read selects id, and each punch sends it', () => {
  const src = read('manager-snapshot');
  const selects = [...src.matchAll(/\.from\('wf_timesheets'\)\s*\.select\('([^']*)'\)/g)].map((m) => m[1].split(',').map((c) => c.trim()));
  assert.ok(selects.length >= 2, 'expected the team read and the pending approvals read');
  for (const cols of selects) assert.ok(cols.includes('id'), `a wf_timesheets read without id: ${cols.join(', ')}`);
  // The team read (paged) is the one the punches come from.
  assert.match(src, /pagedRows\('timesheets', \(\) => sb\.from\('wf_timesheets'\)\.select\('id, /);
  assert.match(src, /const punches = tsRows[\s\S]*?\.map\(\(t: any\) => \(\{\s*id: t\.id, staffId: t\.staff_id,/);
});
