/**
 * vatRederive.test.js: the daily VAT check's mirror of the till's rule, pinned against the real
 * engine (8 Oct 2026). Run: `npm test`, or `node --test src/lib/accounting/vatRederive.test.js`.
 *
 * Edge functions cannot import src/lib, so vatRederive.js mirrors the one rule the till books
 * with. This file proves the mirror IS that rule:
 *   1. its alias table and its rounding are src/lib/taxRule.js's, byte for byte;
 *   2. over the 200 live till sales of 1 to 8 Oct 2026 (Lane B's fixtures: lines, discounts and
 *      stored VAT, no customer data) the mirror and saleVatGuard.rederiveSaleTax (the engine)
 *      give the same VAT on every sale, and against the stored figures 182 agree to the penny
 *      and 18 sit one penny above: every one a half penny the till of those days stored as a
 *      float rounded down (10.05 at 20% is 1.675, stored 1.67; 11.10 of goods charged at 9.99 is
 *      1.85 x 0.9 = 1.665, stored 1.66). Lane B's SQL counted 183 and 17: Postgres numeric and a
 *      JS float part on one of the two 10% bills; the engine is the rule, so 182 and 18 here;
 *   3. the 14 QR sales of the audit, whose lines carry no rate (the menu row decides): 13 to the
 *      stored penny, QR-186RY to 0.98 (a half penny stored as 0.97);
 *   4. the rule's own cases: a Leeds donut collected reads the Takeaway override (0.00), a bar
 *      tab reads the Bar override, a foreign rate id takes the default and is flagged, an open
 *      price item is flagged custom-item, a size inherits its parent, a 100% comp books 0;
 *   5. the daily check's judgement and its message.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TAX_ORDER_TYPE_ALIASES, roundHalfUpMinor } from '../taxRule.js';
import { rederiveSaleTax } from '../saleVatGuard.js';
import { toStoreRate } from '../venueTaxRates.js';
import { rederiveSale, lineRule, resolveLineRate, ratesIndex, menuIndex, chargedShare, taxOrderTypeKey, roundHalfUpPence } from '../../../supabase/functions/_shared/vatRederive.js';
import { TAX_ORDER_TYPE_ALIASES as MIRROR } from '../../../supabase/functions/_shared/accountingGroups.js';
import { judgeSale, checkVenueDay, vatCheckMessage, vatCheckNoticeId, vatCheckRunRow, needsMessage } from '../../../supabase/functions/_shared/vatCheck.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, '../../../supabase/tests/public_order_vat/fixtures');
const load = (f) => JSON.parse(fs.readFileSync(path.join(fixtures, f), 'utf8'));
const RATES = load('tax_rates.json');
const MENU = load('menu_items.json');
const TILL = load('till200.json');
const QR = load('qr14.json');
const ratesOf = (loc) => RATES.filter((r) => r.location_id === loc);
const menuOf = (loc) => MENU.filter((m) => m.location_id === loc);
// The engine's venue, as saleVatGuard reads a store: the venue's rates in the store's shape.
const venueOf = (loc) => { const taxRates = ratesOf(loc).map(toStoreRate); return { taxRates, taxCtx: { taxRates }, hasTaxConfig: true }; };

test('the mirror\'s alias table and rounding are taxRule.js\'s', () => {
  assert.deepEqual(MIRROR, TAX_ORDER_TYPE_ALIASES);
  for (const [k, v] of Object.entries(TAX_ORDER_TYPE_ALIASES)) assert.equal(taxOrderTypeKey(k), v);
  assert.equal(taxOrderTypeKey('dine-in'), 'dine-in');
  for (let p = 0; p <= 3000; p += 1) {
    const x = p / 100 / 1.2 * 0.2;           // the VAT inside p pence at 20%
    assert.equal(roundHalfUpPence(x), roundHalfUpMinor(x, 2), `${p}p`);
    assert.equal(roundHalfUpPence(p / 100 * 0.05 / 1.05), roundHalfUpMinor(p / 100 * 0.05 / 1.05, 2));
  }
  assert.equal(roundHalfUpPence(1.6749999999999998), 1.68);
  assert.equal(roundHalfUpPence(-0.975), -0.98);
});

test('200 live till sales: the mirror equals the engine on every one; 182 to the stored penny, 18 one penny above (half pennies)', () => {
  let same = 0, exact = 0, penny = 0;
  const misses = [];
  for (const s of TILL) {
    const row = { items: s.items, discounts: s.discounts, order_type: s.order_type, total: s.total, tip: s.tip, tax_amount: s.tax_amount, ref: s.ref };
    const mirror = rederiveSale(row, { rates: ratesOf(s.location_id), menu: menuOf(s.location_id) });
    const engine = rederiveSaleTax({ ...row, taxAmount: s.tax_amount }, venueOf(s.location_id));
    assert.ok(mirror.ok, `${s.ref}: the mirror could not work it out (${mirror.reason})`);
    assert.ok(engine, `${s.ref}: the engine could not work it out`);
    const engineVat = roundHalfUpMinor(engine.totalTax, 2);
    if (mirror.totalTax === engineVat) same += 1; else misses.push(`${s.ref}: mirror ${mirror.totalTax}, engine ${engineVat}`);
    if (mirror.totalTax === s.tax_amount) exact += 1;
    else if (Math.abs(mirror.totalTax - s.tax_amount - 0.01) < 1e-9) penny += 1;
    else misses.push(`${s.ref}: mirror ${mirror.totalTax}, stored ${s.tax_amount}`);
    // the share the till stored (a discounted bill) is the share the mirror found
    if (s.share != null) assert.ok(Math.abs(mirror.share - s.share) < 1e-6, `${s.ref}: share ${mirror.share} vs stored ${s.share}`);
  }
  assert.deepEqual(misses, [], 'every sale: mirror equals engine, and stored equals or sits a half penny below');
  assert.equal(same, TILL.length);
  assert.equal(exact, 182);
  assert.equal(penny, 18);
  assert.equal(exact + penny, TILL.length, 'nothing further off, nothing below');
});

test('the 14 QR sales (lines with no rate, the menu row decides): 13 to the stored penny, QR-186RY to 0.98', () => {
  let exact = 0;
  for (const s of QR) {
    const row = { items: s.items, order_type: s.order_type, total: s.total, tip: 0, tax_amount: s.tax_amount, ref: s.ref };
    const got = rederiveSale(row, { rates: ratesOf(s.location_id), menu: menuOf(s.location_id) });
    assert.ok(got.ok, `${s.ref}`);
    assert.deepEqual(got.fallbacks, [], `${s.ref}: every line is on its venue's menu`);
    const want = s.ref === 'QR-186RY' ? 0.98 : s.tax_amount;
    assert.equal(got.totalTax, want, `${s.ref} ${s.total}`);
    if (got.totalTax === s.tax_amount) exact += 1;
  }
  assert.equal(exact, 13);
  // The daily check's verdicts on them: QR-186RY is a penny (the half penny), the rest ok.
  const day = checkVenueDay(QR.map((s) => ({ ...s, tip: 0, tax_breakdown: { totalTax: s.tax_amount, breakdown: [{ rate: { id: 'x' }, tax: s.tax_amount }] } })).filter((s) => s.location_id === 'ab45c80b-416d-4631-93e2-05048e52e0fa'), { rates: ratesOf('ab45c80b-416d-4631-93e2-05048e52e0fa'), menu: menuOf('ab45c80b-416d-4631-93e2-05048e52e0fa') });
  assert.equal(day.penny, 1);
  assert.equal(day.differs, 0);
  assert.equal(day.noVat, 0);
});

const LEEDS = '1e252e7c-c875-4971-b91d-1e945c26956b';
const leedsRates = () => ratesOf(LEEDS);
const leedsZero = () => leedsRates().find((r) => r.rate === 0 && /zero/i.test(r.name)).id;
const leedsStd = () => leedsRates().find((r) => r.is_default).id;

test('the rule\'s own cases: collection reads Takeaway, a bar tab reads Bar, a foreign rate id falls to the default and is flagged, custom is flagged, a size inherits', () => {
  const rates = leedsRates();
  const donut = { itemId: 'donut', name: 'Bueno Filled Donut', price: 3.75, qty: 1, taxRateId: leedsStd(), taxOverrides: { takeaway: leedsZero() } };
  // dine-in at 20%; collection and takeaway at the zero rate (D2)
  assert.equal(rederiveSale({ items: [donut], order_type: 'dine-in', total: 3.75 }, { rates }).totalTax, 0.63);
  assert.equal(rederiveSale({ items: [donut], order_type: 'takeaway', total: 3.75 }, { rates }).totalTax, 0);
  assert.equal(rederiveSale({ items: [donut], order_type: 'collection', total: 3.75 }, { rates }).totalTax, 0);
  assert.equal(rederiveSale({ items: [donut], order_type: 'drive-thru', total: 3.75 }, { rates }).totalTax, 0);
  // an override under the sale's own key wins over the alias
  assert.equal(rederiveSale({ items: [{ ...donut, taxOverrides: { takeaway: leedsZero(), collection: leedsStd() } }], order_type: 'collection', total: 3.75 }, { rates }).totalTax, 0.63);
  // a bar tab reads the Bar override
  const pint = { itemId: 'pint', name: 'Pint', price: 6, qty: 1, taxRateId: leedsStd(), taxOverrides: { bar: leedsZero() } };
  assert.equal(rederiveSale({ items: [pint], order_type: 'bar-tab', total: 6 }, { rates }).totalTax, 0);
  // an explicit null override is "Use default"
  assert.equal(rederiveSale({ items: [{ ...pint, taxOverrides: { 'bar-tab': null } }], order_type: 'bar-tab', total: 6 }, { rates }).totalTax, 1);
  // another venue's rate id: the venue default, flagged rate-not-found (D4)
  const foreign = rederiveSale({ items: [{ itemId: 'x', name: 'Latte', price: 6, qty: 1, taxRateId: 'b4c75881-8771-4780-bac4-afc501f4a77e', taxOverrides: {} }], order_type: 'dine-in', total: 6 }, { rates });
  assert.equal(foreign.totalTax, 1);
  assert.deepEqual(foreign.fallbacks.map((f) => [f.reason, f.name, f.rateId]), [['rate-not-found', 'Latte', 'b4c75881-8771-4780-bac4-afc501f4a77e']]);
  // an open price item typed at the till
  const custom = rederiveSale({ items: [{ itemId: 'custom', name: 'Coffee beans', price: 7.95, qty: 1, taxRateId: null, taxOverrides: {} }], order_type: 'dine-in', total: 7.95 }, { rates });
  assert.equal(custom.totalTax, 1.33);
  assert.deepEqual(custom.fallbacks.map((f) => f.reason), ['custom-item']);
  // a line with no rule of its own: the menu row; a size inherits its parent's rate and overrides
  const menu = menuIndex([
    { id: 'p1', location_id: LEEDS, parent_id: null, tax_rate_id: leedsStd(), tax_overrides: { takeaway: leedsZero() } },
    { id: 's1', location_id: LEEDS, parent_id: 'p1', tax_rate_id: null, tax_overrides: {} },
  ]);
  assert.equal(rederiveSale({ items: [{ itemId: 's1', name: 'Size', price: 1.2, qty: 1 }], order_type: 'takeaway', total: 1.2 }, { rates, menu }).totalTax, 0);
  assert.equal(rederiveSale({ items: [{ itemId: 's1', name: 'Size', price: 1.2, qty: 1 }], order_type: 'dine-in', total: 1.2 }, { rates, menu }).totalTax, 0.2);
  // a line on no menu row with no rule of its own: the default, flagged item-not-on-menu
  const gone = rederiveSale({ items: [{ itemId: 'gone', name: 'Old thing', price: 6, qty: 1 }], order_type: 'dine-in', total: 6 }, { rates, menu });
  assert.equal(gone.totalTax, 1);
  assert.deepEqual(gone.fallbacks.map((f) => f.reason), ['item-not-on-menu']);
  // a 100% comp books 0 (taxForChargedGoods); a half price bill books half (share 0.5)
  assert.equal(rederiveSale({ items: [pint], order_type: 'dine-in', total: 0, discounts: [{ type: 'percent', value: 100, amount: 6 }] }, { rates }).totalTax, 0);
  const half = rederiveSale({ items: [pint], order_type: 'dine-in', total: 3, discounts: [{ type: 'percent', value: 50, amount: 3 }] }, { rates });
  assert.equal(half.totalTax, 0.5);
  assert.equal(half.share, 0.5);
  assert.equal(chargedShare({ discounts: [{ type: 'amount', value: 1.5 }] }, [{ price: 6, qty: 1 }]).share, 0.75);
  // a venue with rates but no default: a line with no rate books no VAT, flagged no-default-rate
  const noDef = rederiveSale({ items: [{ itemId: 'x', price: 6, qty: 1, taxRateId: null, taxOverrides: {} }], order_type: 'dine-in', total: 6 }, { rates: rates.map((r) => ({ ...r, is_default: false })) });
  assert.equal(noDef.ok, false);
  assert.equal(noDef.reason, 'no-default-rate');
  // no rates at all, or no lines: not worked out, said so
  assert.equal(rederiveSale({ items: [pint] }, { rates: [] }).reason, 'no-rates');
  assert.equal(rederiveSale({ items: [] }, { rates }).reason, 'no-lines');
  // the pieces on their own
  assert.equal(ratesIndex(rates).def.id, leedsStd());
  assert.deepEqual(lineRule({ itemId: 'custom', price: 1 }, new Map()).note, null);
  assert.equal(resolveLineRate({ taxRateId: leedsStd(), taxOverrides: {} }, {}, ratesIndex(rates), 'dine-in').rate.id, leedsStd());
});

test('the daily check: verdicts, counts, the message and its id', () => {
  const rates = leedsRates();
  const std = { id: leedsStd(), rate: 0.2, type: 'inclusive', name: 'Standard Rate' };
  const rec = (tax, gross, extra = {}) => ({ totalTax: tax, subtotal: gross - tax, total: gross, breakdown: [{ rate: std, tax, net: gross - tax, gross, items: 1 }], hasExclusiveTax: false, ...extra });
  const latte = { itemId: 'l', name: 'Latte', price: 6, qty: 1, taxRateId: leedsStd(), taxOverrides: {} };
  const rows = [
    { id: 'a', ref: 'R1', items: [latte], order_type: 'dine-in', total: 6, tax_amount: 1, tax_breakdown: rec(1, 6) },                               // ok
    { id: 'b', ref: 'R2', items: [{ ...latte, price: 10.05 }], order_type: 'dine-in', total: 10.05, tax_amount: 1.67, tax_breakdown: rec(1.675, 10.05) },   // a half penny: penny
    { id: 'c', ref: 'QR-4OGI7', items: [{ itemId: 'm', name: 'Cooler', price: 4.85, qty: 1 }], order_type: 'dine-in', total: 4.85, tax_amount: null, tax_breakdown: [] },   // no-vat
    { id: 'd', ref: 'R4', items: [latte], order_type: 'dine-in', total: 6, tax_amount: 0.5, tax_breakdown: rec(0.5, 6) },                             // differs
    { id: 'e', ref: 'K5', items: [latte], order_type: 'dine-in', total: 6, tax_amount: 1, tax_breakdown: [] },                                        // no-record
    { id: 'f', ref: 'R6', items: [latte], order_type: 'dine-in', total: 6, tax_amount: 1, status: 'voided', voided: true },                            // skipped
    { id: 'g', ref: 'R7', items: [{ ...latte, taxRateId: 'other-venue' }], order_type: 'dine-in', total: 6, tax_amount: 1, tax_breakdown: rec(1, 6, { fallbacks: [{ source: 'fallback', reason: 'rate-not-found', name: 'Latte', rateId: 'other-venue' }] }) },   // ok, flagged
  ];
  const menu = menuIndex([{ id: 'm', location_id: LEEDS, parent_id: null, tax_rate_id: leedsStd(), tax_overrides: {} }]);
  assert.equal(judgeSale(rows[0], { rates, menu }).verdict, 'ok');
  assert.equal(judgeSale(rows[1], { rates, menu }).verdict, 'penny');
  assert.equal(judgeSale(rows[2], { rates, menu }).verdict, 'no-vat');
  assert.deepEqual(judgeSale(rows[3], { rates, menu }), { ...judgeSale(rows[3], { rates, menu }), verdict: 'differs', stored: 0.5, derived: 1, diff: -0.5 });
  assert.equal(judgeSale(rows[4], { rates, menu }).verdict, 'no-record');
  assert.equal(judgeSale(rows[5], { rates, menu }).skipped, true);
  const g = judgeSale(rows[6], { rates, menu });
  assert.equal(g.verdict, 'ok');
  assert.deepEqual(g.fallbacks.map((f) => f.reason), ['rate-not-found']);
  assert.equal(judgeSale(rows[0], { rates, menu, profilesInUse: true }).verdict, 'not-checked');
  assert.equal(judgeSale(rows[2], { rates, menu, profilesInUse: true }).verdict, 'no-vat', 'no VAT is no VAT whatever the engine');

  const day = checkVenueDay(rows, { rates, menu, date: '2026-10-07', venue: 'Coffee Boy Leeds' });
  assert.equal(day.sales, 6);
  assert.deepEqual([day.ok, day.penny, day.noVat, day.differs, day.noRecord, day.notChecked, day.fallbacks], [2, 1, 1, 1, 1, 0, 1]);
  assert.deepEqual(day.noVatRefs, ['QR-4OGI7']);
  assert.deepEqual(day.differsRefs, ['R4']);
  assert.deepEqual(day.fallbackRefs, ['R7']);
  assert.equal(day.details.length, 5);
  assert.equal(needsMessage(day), true);
  const msg = vatCheckMessage(day, { venueName: 'Coffee Boy Leeds', dayWords: 'yesterday' });
  assert.equal(msg.title, 'VAT check: sales to look at');
  assert.equal(msg.body, '1 sale was booked with no VAT at Coffee Boy Leeds yesterday: QR-4OGI7. 1 sale booked VAT that does not match the Back Office item rules: R4. 1 sale has no record of the rate. Nothing was changed. Check them in Back Office, Reports, Tax.');
  assert.ok(!/[–—]/.test(msg.body));
  // pennies and a clean day say nothing
  assert.equal(vatCheckMessage(checkVenueDay(rows.slice(0, 2), { rates, menu })), null);
  const row = vatCheckRunRow(day, { locationId: LEEDS, ranAt: '2026-10-08T05:30:00.000Z', messageId: null });
  assert.equal(row.business_day, '2026-10-07');
  assert.deepEqual([row.sales, row.ok_count, row.penny_count, row.no_vat, row.differs, row.no_record, row.fallbacks], [6, 2, 1, 1, 1, 1, 1]);
  assert.deepEqual(row.details.noVatRefs, ['QR-4OGI7']);
  assert.match(vatCheckNoticeId(LEEDS, '2026-10-07'), /^[0-9a-f-]{36}$/);
  assert.equal(vatCheckNoticeId(LEEDS, '2026-10-07'), vatCheckNoticeId(LEEDS, '2026-10-07'));
  assert.notEqual(vatCheckNoticeId(LEEDS, '2026-10-07'), vatCheckNoticeId(LEEDS, '2026-10-08'));
});
