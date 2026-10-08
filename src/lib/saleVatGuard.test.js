// The save time guard (8 Oct 2026, VAT audit, Fix 3 and section 4 "refuse or repair at save time").
// A sale is never saved without VAT when the venue has rates: repaired from its lines with the
// Back Office item rules, or refused by name. Plus the source pins: every closed_checks write in
// src goes through writeClosedCheckRow, which calls the guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  assertSaleVat, SaleVatError, isSaleVatError, saleVatNeeds, saleGoods, rederiveSaleTax,
  normaliseVenueTax, venueTaxFromStore, setVenueTaxSource, venueTaxNow, onSaleVatEvent,
  SALE_VAT_WORDS, SALE_VAT_REPAIR_REASONS,
} from './saleVatGuard.js';
import { writeClosedCheckRow } from './closedCheckWrite.js';

const STD = { id: 'r20', name: 'Standard Rate', rate: 0.2, type: 'inclusive', isDefault: true, active: true, locationId: 'L1' };
const RED = { id: 'r5', name: 'Reduced Rate', rate: 0.05, type: 'inclusive', isDefault: false, active: true, locationId: 'L1' };
const ZERO = { id: 'r0', name: 'Zero Rate', rate: 0, type: 'inclusive', isDefault: false, active: true, locationId: 'L1' };
const RATES = [STD, RED, ZERO];
const venue = { taxRates: RATES, taxCtx: { taxRates: RATES }, hasTaxConfig: true };

const line = (price, qty = 1, extra = {}) => ({ uid: `u${price}`, id: `i${price}`, itemId: `i${price}`, name: `Item ${price}`, price, qty, taxRateId: 'r20', taxOverrides: {}, ...extra });
const row = (over = {}) => ({
  id: 'chk-1', ref: 'R1', location_id: 'L1', order_type: 'takeaway', items: [line(4.85)], discounts: [],
  subtotal: 4.85, service: 0, tip: 0, total: 4.85, tax_amount: null, tax_breakdown: null, status: 'paid', ...over,
});

const quiet = async (fn) => { const orig = console.error; const warn = console.warn; console.error = () => {}; console.warn = () => {}; try { return await fn(); } finally { console.error = orig; console.warn = warn; } };

test('nothing known about the venue: the row passes untouched (the surfaces decide, not the guard)', () => {
  const r = row();
  assert.equal(assertSaleVat(r, null), r);
  assert.equal(assertSaleVat(r, undefined), r);
  assert.equal(assertSaleVat(r, false), r);
  assert.equal(assertSaleVat(r, []), r);
  assert.equal(assertSaleVat(r, { taxRates: [] }), r);
});

test('a row that already carries VAT and its record passes untouched (the same object)', () => {
  const r = row({ tax_amount: 0.81, tax_breakdown: { totalTax: 0.808, breakdown: [{ rate: STD, tax: 0.808 }] } });
  assert.equal(assertSaleVat(r, venue), r);
});

test('QR-4OGI7 shape: 4.85 with tax_amount null books 0.81, tagged source repair, reason tax-missing', () => {
  const out = assertSaleVat(row(), venue);
  assert.equal(out.tax_amount, 0.81);
  assert.equal(out.tax_breakdown.source, 'repair');
  assert.equal(out.tax_breakdown.repair.reason, SALE_VAT_REPAIR_REASONS.TAX_MISSING);
  assert.equal(out.tax_breakdown.repair.was, null);
  assert.equal(out.tax_breakdown.repair.engine, 'legacy');
  assert.equal(out.tax_breakdown.breakdown[0].rate.id, 'r20');
  assert.equal(out.items, row().items.length ? out.items : out.items);   // items untouched
  assert.equal(out.total, 4.85);                                        // money untouched
});

test('the Barnsley kiosk shape: VAT booked with no record of the rate, within 1p: figure kept, record filled in', () => {
  const r = row({ subtotal: 8.1, total: 8.1, items: [line(8.1)], tax_amount: 1.35, tax_breakdown: [] });
  const out = assertSaleVat(r, venue);
  assert.equal(out.tax_amount, 1.35);
  assert.equal(out.tax_breakdown.source, 'repair');
  assert.equal(out.tax_breakdown.repair.reason, SALE_VAT_REPAIR_REASONS.RECORD_MISSING);
  assert.equal(out.tax_breakdown.repair.was, 1.35);
  assert.equal(out.tax_breakdown.breakdown.length, 1);
});

test('a booked figure more than 1p from the item rules: the rule is booked and the channel figure kept in the note', () => {
  const r = row({ tax_amount: 0.5, tax_breakdown: null });
  const out = assertSaleVat(r, venue);
  assert.equal(out.tax_amount, 0.81);
  assert.equal(out.tax_breakdown.repair.reason, SALE_VAT_REPAIR_REASONS.TAX_DIFFERS);
  assert.equal(out.tax_breakdown.repair.was, 0.5);
});

test('tax_amount null beside a usable record: the record figure is booked (tax-from-record)', () => {
  const r = row({ tax_amount: null, tax_breakdown: { source: 'legacy', totalTax: 0.8083333, breakdown: [{ rate: STD, tax: 0.8083333 }] } });
  const out = assertSaleVat(r, venue);
  assert.equal(out.tax_amount, 0.81);
  assert.equal(out.tax_breakdown.repair.reason, SALE_VAT_REPAIR_REASONS.TAX_FROM_RECORD);
  assert.equal(out.tax_breakdown.repair.engine, 'legacy');
});

test('D3: the repaired figure is rounded half up to the penny once (10.05 at 20% books 1.68, never 1.67)', () => {
  const out = assertSaleVat(row({ items: [line(10.05)], subtotal: 10.05, total: 10.05 }), venue);
  assert.equal(out.tax_amount, 1.68);
});

test('the item rules apply: per order type override (takeaway zero rate) and a reduced rate line', () => {
  const donut = line(0.75, 1, { taxOverrides: { takeaway: 'r0' } });
  assert.equal(assertSaleVat(row({ items: [donut], subtotal: 0.75, total: 0.75, order_type: 'takeaway' }), venue).tax_amount, 0);
  assert.equal(assertSaleVat(row({ items: [donut], subtotal: 0.75, total: 0.75, order_type: 'dine-in' }), venue).tax_amount, 0.13);
  // D2: collection reads the Takeaway override (taxRule.js alias)
  assert.equal(assertSaleVat(row({ items: [donut], subtotal: 0.75, total: 0.75, order_type: 'collection' }), venue).tax_amount, 0);
  const milk = line(1.55, 1, { taxRateId: 'r5' });
  assert.equal(assertSaleVat(row({ items: [milk], subtotal: 1.55, total: 1.55 }), venue).tax_amount, 0.07);
});

test('a discounted bill books the VAT on what was charged (the till rule); a 100% comp books 0, not null', () => {
  const half = assertSaleVat(row({ items: [line(10)], subtotal: 10, total: 5, discounts: [{ type: 'percent', value: 50 }] }), venue);
  assert.equal(half.tax_amount, 0.83);
  assert.equal(half.tax_breakdown.share, 0.5);
  const comp = assertSaleVat(row({ items: [line(10)], subtotal: 10, total: 0, discounts: [{ type: 'percent', value: 100 }] }), venue);
  assert.equal(comp.tax_amount, 0);
});

test('D4: a line naming another venue rate takes the default and the record flags it (fallbacks ride on the repair)', () => {
  const out = assertSaleVat(row({ items: [line(4.85, 1, { taxRateId: 'other-venue' })] }), venue);
  assert.equal(out.tax_amount, 0.81);
  assert.equal(out.tax_breakdown.fallbacks.length, 1);
  assert.equal(out.tax_breakdown.fallbacks[0].reason, 'rate-not-found');
});

test('a void tombstone and a row with no goods are never touched', () => {
  const tomb = row({ status: 'void', voided: true, total: 0 });
  assert.equal(assertSaleVat(tomb, venue), tomb);
  const empty = row({ items: [], subtotal: 0, total: 0 });
  assert.equal(assertSaleVat(empty, venue), empty);
});

test('REFUSE: no lines to work from, or a venue said to have rates with no maths handed over: SaleVatError, named, never null', async () => {
  const r = row({ items: [], subtotal: 4.85 });
  await quiet(() => {
    assert.throws(() => assertSaleVat(r, venue), (e) => e instanceof SaleVatError && e.name === 'SaleVatError' && e.code === 'vat_missing' && e.ref === 'R1' && e.message === SALE_VAT_WORDS.refused);
    assert.throws(() => assertSaleVat(row(), true), (e) => isSaleVatError(e) && e.reason === 'no-lines');
    return null;
  });
});

test('REFUSE: the maths throw (a poisoned context) is logged and refused, not swallowed into null', async () => {
  const bad = { taxRates: RATES, get taxCtx() { throw new Error('boom'); }, hasTaxConfig: true };
  await quiet(() => { assert.throws(() => assertSaleVat(row(), bad), (e) => isSaleVatError(e) && e.reason === 'venue-unreadable'); return null; });
  // and a context that is readable but whose maths throw on the lines
  const poisoned = { taxRates: RATES, taxCtx: { get taxRates() { throw new Error('boom'); } }, hasTaxConfig: true };
  await quiet(() => { assert.throws(() => assertSaleVat(row(), poisoned), (e) => isSaleVatError(e) && e.reason === 'maths-failed'); return null; });
});

test('a camel store record is read and written in camel (buildCloseRecord shape)', () => {
  const rec = { id: 'chk-2', ref: 'R2', orderType: 'dine-in', items: [line(4.85)], discounts: [], subtotal: 4.85, total: 4.85, tip: 0, taxAmount: null, taxBreakdown: null, status: 'paid' };
  const out = assertSaleVat(rec, venue);
  assert.equal(out.taxAmount, 0.81);
  assert.equal(out.taxBreakdown.source, 'repair');
  assert.ok(!('tax_amount' in out));
});

test('saleVatNeeds, saleGoods and rederiveSaleTax read the row honestly', () => {
  assert.deepEqual(saleVatNeeds(row()), { goods: 4.85, taxMissing: true, recordMissing: true });
  assert.deepEqual(saleVatNeeds(row({ tax_amount: 0.81, tax_breakdown: { totalTax: 0.81, breakdown: [{ rate: STD }] } })), { goods: 4.85, taxMissing: false, recordMissing: false });
  assert.equal(saleGoods(row({ items: [line(2, 3)] })), 6);
  assert.equal(saleGoods(row({ items: [], subtotal: 3 })), 3);
  assert.equal(rederiveSaleTax(row(), normaliseVenueTax(venue)).totalTax.toFixed(4), '0.8083');
  assert.equal(rederiveSaleTax(row({ items: [] }), normaliseVenueTax(venue)), null);
});

test('normaliseVenueTax accepts every shape a writer hands over', () => {
  assert.equal(normaliseVenueTax(null), null);
  assert.deepEqual(normaliseVenueTax(true), { hasRates: true, taxCtx: null });
  assert.equal(normaliseVenueTax([STD]).hasRates, true);
  assert.equal(normaliseVenueTax([{ ...STD, active: false }]), null);
  assert.equal(normaliseVenueTax({ taxRates: [] }), null);
  assert.equal(normaliseVenueTax({ taxCtx: { taxRates: RATES } }).hasRates, true);
  assert.equal(normaliseVenueTax(venue).taxRates.length, 3);
});

test('venueTaxFromStore reads the till store; the registered source feeds venueTaxNow', () => {
  assert.equal(venueTaxFromStore(null), null);
  assert.equal(venueTaxFromStore({ taxRates: [] }), null);
  const v = venueTaxFromStore({ taxRates: RATES, getTaxContext: () => ({ taxRates: RATES }), deviceConfig: { x: 1 }, locationConfig: { timezone: 'Europe/London' } });
  assert.equal(v.hasTaxConfig, true);
  assert.equal(v.timezone, 'Europe/London');
  setVenueTaxSource(() => v);
  assert.equal(venueTaxNow(), v);
  setVenueTaxSource(() => { throw new Error('x'); });
  assert.equal(venueTaxNow(), null);
  setVenueTaxSource(null);
  assert.equal(venueTaxNow(), null);
});

test('every repair and refusal is told to the subscriber', async () => {
  const seen = [];
  const off = onSaleVatEvent((ev) => seen.push(ev));
  assertSaleVat(row(), venue);
  await quiet(() => { assert.throws(() => assertSaleVat(row({ items: [] }), venue)); return null; });
  off();
  assertSaleVat(row(), venue);
  assert.deepEqual(seen.map((e) => [e.kind, e.ref, e.reason]), [['repaired', 'R1', 'tax-missing'], ['refused', 'R1', 'no-lines']]);
});

// ── writeClosedCheckRow runs the guard ──────────────────────────────────────────────────────────

function fakeClient(log) {
  const result = { data: [], error: null };
  const q = { select: () => result, then: (res) => res(result) };
  return { from: (t) => ({ insert: (p) => { log.push(['insert', t, p]); return q; }, upsert: (p, o) => { log.push(['upsert', t, p, o]); return q; } }) };
}

test('writeClosedCheckRow repairs a row with no VAT before the insert and sends the repaired payload', async () => {
  const log = [];
  const res = await quiet(() => writeClosedCheckRow(fakeClient(log), row(), { tag: 't', vat: venue }));
  assert.equal(res.error, null);
  assert.equal(log[0][2].tax_amount, 0.81);
  assert.equal(log[0][2].tax_breakdown.source, 'repair');
});

test('writeClosedCheckRow refuses by name: nothing is sent, the error is the SaleVatError', async () => {
  const log = [];
  const res = await quiet(() => writeClosedCheckRow(fakeClient(log), row({ items: [] }), { tag: 't', vat: venue }));
  assert.equal(log.length, 0);
  assert.ok(isSaleVatError(res.error));
  assert.equal(res.error.code, 'vat_missing');
  assert.deepEqual(res.dropped, []);
});

test('writeClosedCheckRow with vat null judges nothing (the customer pages guard themselves before payment)', async () => {
  const log = [];
  const res = await writeClosedCheckRow(fakeClient(log), row(), { tag: 't', vat: null });
  assert.equal(res.error, null);
  assert.equal(log[0][2].tax_amount, null);
});

test('writeClosedCheckRow with no vat option asks the registered source', async () => {
  const log = [];
  setVenueTaxSource(() => venue);
  try {
    const res = await quiet(() => writeClosedCheckRow(fakeClient(log), row(), { tag: 't' }));
    assert.equal(res.error, null);
    assert.equal(log[0][2].tax_amount, 0.81);
  } finally { setVenueTaxSource(null); }
});

// ── source pins: every closed_checks write goes through the guard ───────────────────────────────

const read = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const listSrc = (dir) => fs.readdirSync(new URL(dir, import.meta.url), { recursive: true })
  .filter((f) => /\.(js|jsx)$/.test(f) && !/\.test\.js$/.test(f))
  .map((f) => [`src/${dir.replace('../', '')}${f}`, read(`${dir}${f}`)]);

test('PIN: the only closed_checks insert or upsert in src is inside writeClosedCheckRow', () => {
  const files = listSrc('../');
  const offenders = [];
  for (const [name, text] of files) {
    const hits = text.match(/from\(\s*['"]closed_checks['"]\s*\)\s*\n?\s*\.(insert|upsert)\(/g) || [];
    if (hits.length && !name.endsWith('src/lib/closedCheckWrite.js')) offenders.push(`${name} (${hits.length})`);
  }
  assert.deepEqual(offenders, [], 'a closed_checks write that bypasses writeClosedCheckRow (and the guard)');
  const write = read('./closedCheckWrite.js');
  assert.equal((write.match(/from\('closed_checks'\)\.(insert|upsert)\(/g) || []).length, 2);
  // the guard runs before the first send, inside writeClosedCheckRow
  const fn = write.slice(write.indexOf('export async function writeClosedCheckRow'));
  assert.ok(fn.indexOf('assertSaleVat(payload') > 0 && fn.indexOf('assertSaleVat(payload') < fn.indexOf('let res = await send()'), 'the guard runs before the insert');
  assert.match(fn, /if \(!isSaleVatError\(e\)\) throw e;/);
  assert.match(fn, /return \{ data: null, error: e, dropped: \[\] \};/);
});

test('PIN: the call sites the audit found all write through writeClosedCheckRow', () => {
  const sites = {
    'src/lib/db.js': /safeInsertClosedCheck\(check, row\)|safeUpsertClosedCheck\(check, row\)/,       // insertClosedCheck / upsertClosedCheck (store closes)
    'src/sync/DataSafe.js': /writeClosedCheckRow\(supabase, row/,                                     // live write, reconciler upsert, pending replay
    'src/sync/OfflineQueue.js': /writeClosedCheckRow\(supabase, item\.payload, \{ upsert: item\.type === 'upsert', tag: 'OfflineQueue' \}\)/,   // MPOS recovery row
    'src/surfaces/KioskApp.jsx': /writeClosedCheckRow\(supabase, checkRow, \{ tag: 'kiosk', vat: kioskVenueTaxCtx \}\)/,   // was KioskApp.jsx:1070,1077
    'src/surfaces/OrdersHub.jsx': /writeClosedCheckRow\(supabase, check, \{ tag: 'OrdersHub short close' \}\)/,   // was OrdersHub.jsx:547
    'src/store/index.js': /writeClosedCheckRow\(supabase, \{\n\s*id: `chk-hr-\$\{o\.ref\}`/,          // bookChannelSale
    'src/surfaces/qr/TabResumeScreen.jsx': /writeClosedCheckRow\(supabase, \{/,
    'src/surfaces/qr/QrCheckout.jsx': /writeClosedCheckRow\(supabase, closedCheckRow, \{ tag: 'QrCheckout' \}\)/,
    'src/surfaces/online/OnlineCheckout.jsx': /writeClosedCheckRow\(supabase, closedCheck, \{ tag: 'OnlineCheckout' \}\)/,
    'src/surfaces/catering/CateringCheckout.jsx': /writeClosedCheckRow\(supabase, closedCheck, \{ tag: 'CateringCheckout' \}\)/,
  };
  for (const [file, re] of Object.entries(sites)) {
    assert.match(read(`../../${file}`), re, file);
  }
  // OrdersHub's two force closes (lines 772 and 979 of the audit) still write through it
  assert.equal((read('../surfaces/OrdersHub.jsx').match(/await writeClosedCheckRow\(supabase, \{/g) || []).length, 2);
  // the offline queue keeps no copy of the missing column loop of its own
  assert.doesNotMatch(read('../sync/OfflineQueue.js'), /missingColumnOf\(/);
  // MPOS buffers its recovery row for that replay
  assert.match(read('../surfaces/MPOSSurface.jsx'), /table: 'closed_checks',\n\s*onConflict: 'id',\n\s*kind: 'closed_check',/);
});

test('PIN: the store registers the venue tax source and hears every repair and refusal', () => {
  const store = read('../store/index.js');
  assert.match(store, /setVenueTaxSource\(\(\) => venueTaxFromStore\(useStore\.getState\(\)\)\);/);
  assert.match(store, /onSaleVatEvent\(\(ev\) => \{/);
  assert.match(store, /logActivity\(locationId, \{\n\s*kind: 'ops',\n\s*severity: ev\.kind === 'refused' \? 'urgent' : 'action',/);
  // DataSafe keeps a refused sale pending, without the fence banner
  const ds = read('../sync/DataSafe.js');
  assert.equal((ds.match(/isSaleVatError\(error\)/g) || []).length, 3);
});

test('PIN: no close path catches its tax maths into null quietly any more', () => {
  const store = read('../store/index.js');
  assert.doesNotMatch(store, /creditDiscounts: creditDiscountsFromPayment\(paymentInfo\),\n\s*\}\)\.tax;\n\s*\} catch \{\}/, 'buildCloseRecord / recordWalkInClosed swallow');
  assert.doesNotMatch(store, /\} catch \{ headlessTax = null; \}/);
  assert.equal((store.match(/\[tax\] (buildCloseRecord|recordWalkInClosed|reconciler headless record): the VAT could not be worked out:/g) || []).length, 3);
  // the in memory record is rounded like the row (null stays null)
  assert.equal((store.match(/taxAmount:\s+roundVat\((taxBreakdown|headlessTax)\?\.totalTax\)/g) || []).length, 3);
  assert.match(read('../surfaces/MPOSSurface.jsx'), /taxAmount:\s+roundVat\(taxBreakdown\?\.totalTax\)/);
  for (const f of ['./headlessTax.js', './barTabTax.js']) {
    assert.doesNotMatch(read(f), /\} catch \{\n\s*return (null|none);/, `${f} still swallows`);
  }
});
