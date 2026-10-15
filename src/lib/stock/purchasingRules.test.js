/** purchasingRules.test.js — Order pad and Orders screen pure rules. Run: `npm test` */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normDay, normDeliveryDays, coverDaysFromSchedule, nextDeliveryYmd, packContent,
  suggestPacks, cleanFnError, createOrdersToast,
  pickSupplierProduct, packsForBase, netPackPrice, poTotals, normCode, matchScannedLine,
} from './purchasingRules.js';
import { pickSupplierProduct as fromCosting } from './costing.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(resolve(here, p), 'utf8');

test('normDay: day names, ISO numbers and JS numbers all read as the same day', () => {
  assert.equal(normDay('tue'), 'tue');
  assert.equal(normDay('Thursday'), 'thu');
  assert.equal(normDay(1), 'mon');          // ISO Monday
  assert.equal(normDay('6'), 'sat');
  assert.equal(normDay(7), 'sun');          // ISO Sunday
  assert.equal(normDay(0), 'sun');          // JS Sunday
  assert.equal(normDay(9), null);
  assert.equal(normDay('yesterday'), null);
  assert.equal(normDay(null), null);
  // the demo seed wrote [1,2,3,4,5,6]: six working days, no Sunday
  assert.deepEqual(normDeliveryDays([1, 2, 3, 4, 5, 6]), ['mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
  assert.deepEqual(normDeliveryDays(['tue', 'thu', 'sat']), ['tue', 'thu', 'sat']);
  assert.deepEqual(normDeliveryDays('tue'), []);
});

test('coverDaysFromSchedule: covers to the SECOND upcoming delivery, numbers behave like names', () => {
  // today Thursday (4); deliveries Tue/Thu → next Tue is +5, the Thu after is +7
  assert.equal(coverDaysFromSchedule(['tue', 'thu'], 4), 7);
  assert.equal(coverDaysFromSchedule([2, 4], 4), 7);           // same schedule as integers
  // daily Mon..Sat on a Thursday: Fri +1, Sat +2
  assert.equal(coverDaysFromSchedule([1, 2, 3, 4, 5, 6], 4), 2);
  // one delivery a week → the single hit
  assert.equal(coverDaysFromSchedule(['mon'], 4), 11);
  assert.equal(coverDaysFromSchedule([], 4), null);
  assert.equal(coverDaysFromSchedule(null, 4), null);
  assert.equal(coverDaysFromSchedule(['noday'], 4), null);
});

test('nextDeliveryYmd: first delivery day from tomorrow; no schedule means tomorrow', () => {
  // 2026-10-15 is a Thursday
  assert.equal(nextDeliveryYmd(['tue', 'thu'], '2026-10-15'), '2026-10-20');
  assert.equal(nextDeliveryYmd([2, 4], '2026-10-15'), '2026-10-20');
  assert.equal(nextDeliveryYmd([1, 2, 3, 4, 5, 6], '2026-10-15'), '2026-10-16');
  assert.equal(nextDeliveryYmd(['thu'], '2026-10-15'), '2026-10-22');  // today does not count
  assert.equal(nextDeliveryYmd([], '2026-10-15'), '2026-10-16');
  assert.equal(nextDeliveryYmd(null, '2026-10-31'), '2026-11-01');      // month roll
  assert.equal(nextDeliveryYmd(['mon'], 'not-a-date'), null);
});

test('packContent: a case of 6 x 2 l is 12 l, a bag of 48 is 48', () => {
  assert.equal(packContent({ packQty: 6, innerQty: 2 }), 12);
  assert.equal(packContent({ packQty: 1, innerQty: 48 }), 48);
  assert.equal(packContent({ innerQty: 5 }), 5);            // missing packQty reads as 1
  assert.equal(packContent({ packQty: 6, innerQty: 0 }), null);
  assert.equal(packContent(null), null);
});

test('suggestPacks: usage over cover minus on hand minus on order, rounded up to packs', () => {
  // flat average: 23.25 buns a day, 8 day cover, 30 on hand, nothing on order, packs of 48
  const a = suggestPacks({ onHand: 30, onOrder: 0, avgDaily: 23.25, coverDays: 7, safetyDays: 1, perPack: 48 });
  assert.equal(a.effCover, 8);
  assert.equal(a.needBase, 186 - 30);
  assert.equal(a.suggestedPacks, 4);          // 156 / 48 = 3.25 → 4
  assert.equal(a.covered, false);
  // the same item once those 4 packs are on order: nothing more to buy, and the rule says why
  const b = suggestPacks({ onHand: 30, onOrder: 192, avgDaily: 23.25, coverDays: 7, safetyDays: 1, perPack: 48 });
  assert.equal(b.suggestedPacks, 0);
  assert.equal(b.covered, true);
  // case items: 6 x 2 l milk, need 60 l → 5 cases, not 30
  const c = suggestPacks({ onHand: 44, onOrder: 0, avgDaily: 13, coverDays: 7, safetyDays: 1, perPack: packContent({ packQty: 6, innerQty: 2 }) });
  assert.equal(c.needBase, 104 - 44);
  assert.equal(c.suggestedPacks, 5);
  // weekday profile walks the real days starting tomorrow (today Thu = 4)
  const prof = [0, 10, 0, 0, 0, 50, 50];      // Sun..Sat: busy Fri and Sat, a little Monday
  const d = suggestPacks({ onHand: 0, avgDaily: 0, profile: prof, todayDow: 4, coverDays: 3, safetyDays: 0, perPack: 10 });
  assert.equal(d.expectedBase, 100);          // Fri 50 + Sat 50 + Sun 0
  assert.equal(d.suggestedPacks, 10);
  // no history: top up to par
  const e = suggestPacks({ onHand: 3, onOrder: 0, avgDaily: 0, par: 10, perPack: 1 });
  assert.equal(e.suggestedPacks, 7);
  // no history and no par: nothing to say
  const f = suggestPacks({ onHand: 3, avgDaily: 0, perPack: 1 });
  assert.equal(f.suggestedPacks, 0);
  assert.equal(f.covered, false);
  // no pack on file: never suggests
  assert.equal(suggestPacks({ onHand: 0, avgDaily: 5, perPack: null }).suggestedPacks, 0);
});

test('cleanFnError: peels po-send and the mail provider down to one plain sentence', () => {
  const resend = 'email failed: {"error":"send failed: Invalid `to` field. Please use our testing email address instead of domains like `example.com`."}';
  // the mail provider refusing the address (an example.com supplier) is said in plain words
  assert.equal(cleanFnError(resend), "the mail service refused the supplier's email address (check it in Suppliers)");
  assert.equal(cleanFnError('Invalid `to` field'), "the mail service refused the supplier's email address (check it in Suppliers)");
  // po-send answers 422 { error: 'supplier_has_no_email' }; the SDK hands the body over as the raw token
  assert.equal(cleanFnError({ error: 'supplier_has_no_email' }), 'this supplier has no email address on file (add one in Suppliers)');
  assert.equal(cleanFnError('supplier_has_no_email'), 'this supplier has no email address on file (add one in Suppliers)');
  assert.equal(cleanFnError('Edge Function returned a non-2xx status code'), 'send failed');
  assert.equal(cleanFnError('Edge Function returned a non-2xx status code', 'could not send'), 'could not send');
  assert.equal(cleanFnError(null), 'send failed');
  assert.equal(cleanFnError(''), 'send failed');
  assert.equal(cleanFnError('{"error":"PO has no lines"}'), 'PO has no lines');
  assert.equal(cleanFnError('not authorized for location x'), 'not authorized for location x');
});

test('createOrdersToast: says what happened in plain words', () => {
  assert.equal(createOrdersToast({ created: 2, emailed: 2, failed: [] }), '2 orders created and emailed to the suppliers. See Orders for delivery.');
  assert.equal(createOrdersToast({ created: 1, emailed: 1, failed: [] }), '1 order created and emailed to the supplier. See Orders for delivery.');
  const t = createOrdersToast({ created: 3, emailed: 2, failed: [{ supplier: 'Bakehouse', reason: 'email failed: {"error":"send failed: Invalid `to` field."}' }] });
  assert.equal(t, "3 orders created. Email to Bakehouse did not send: the mail service refused the supplier's email address (check it in Suppliers). The order is saved; open it in Orders and press Resend to supplier.");
  // the pad passes the supplier's address so the venue sees what to fix
  const u = createOrdersToast({ created: 1, emailed: 0, failed: [{ supplier: 'Bakehouse', email: 'sales@example.com', reason: 'email failed: {"error":"send failed: Invalid `to` field."}' }] });
  assert.match(u, /^1 order created\. Email to Bakehouse \(sales@example\.com\) did not send: the mail service refused/);
  assert.match(createOrdersToast({ created: 1, emailed: 0, failed: [{ supplier: 'Dairy', reason: { error: 'supplier_has_no_email' } }] }), /Email to Dairy did not send: this supplier has no email address on file \(add one in Suppliers\)\./);
  assert.match(createOrdersToast({ created: 1, emailed: 0, failed: [{ supplier: null, reason: null }] }), /Email to 1 supplier did not send: send failed/);
});

test('pickSupplierProduct is ONE function: costing.js re-exports the shared rule', () => {
  assert.equal(fromCosting, pickSupplierProduct);
  // preferred star, then the default supplier's pack, then cheapest per base unit, never "first row"
  assert.equal(pickSupplierProduct({ supplierProducts: [{ id: 'p1', supplierId: 'a' }, { id: 'p2', supplierId: 'b', isPreferred: true }] }).id, 'p2');
  assert.equal(pickSupplierProduct({ defaultSupplierId: 'b', supplierProducts: [{ id: 'p1', supplierId: 'a', baseUnitCost: 0.1 }, { id: 'p2', supplierId: 'b', baseUnitCost: 0.2 }] }).id, 'p2');
  assert.equal(pickSupplierProduct({ supplierProducts: [{ id: 'p1', supplierId: 'a', baseUnitCost: 0.3 }, { id: 'p2', supplierId: 'b', baseUnitCost: 0.2 }] }).id, 'p2');
  assert.equal(pickSupplierProduct({ supplierProducts: [] }), null);
  assert.equal(pickSupplierProduct(null), null);
});

test('packsForBase: a shortfall in base units becomes whole packs, never fewer than one', () => {
  assert.equal(packsForBase(32, { packQty: 1, innerQty: 180 }), 1);     // 32 eggs, a pack of 180
  assert.equal(packsForBase(27, { packQty: 1, innerQty: 24 }), 2);      // 27 avocados, trays of 24
  assert.equal(packsForBase(22, { packQty: 1, innerQty: 20 }), 2);      // 22 portions, packs of 20
  assert.equal(packsForBase(60, { packQty: 6, innerQty: 2 }), 5);       // 60 l, cases of 6 x 2 l
  assert.equal(packsForBase(0, { packQty: 1, innerQty: 10 }), 1);       // never an empty line
  assert.equal(packsForBase(10, { packQty: 1, innerQty: 0 }), 0);       // no pack content: cannot order
  assert.equal(packsForBase(10, null), 0);
});

test('netPackPrice: strips VAT only when the price was entered inc VAT', () => {
  assert.equal(netPackPrice({ packPrice: 32.4, priceIncludesTax: false }, 0.2), 32.4);
  assert.equal(netPackPrice({ packPrice: 12, priceIncludesTax: true }, 0.2), 10);
  assert.equal(netPackPrice({ packPrice: 12, priceIncludesTax: true }, 0), 12);
  assert.equal(netPackPrice({ packPrice: 'abc' }, 0.2), 0);
  assert.equal(netPackPrice(null, 0.2), 0);
});

test('poTotals: the same maths savePurchaseOrder always wrote', () => {
  const rates = { std: 0.2, zero: 0 };
  const t = poTotals([
    { qtyPacks: 1, unitPrice: 32.4, purchaseTaxRateId: 'zero' },
    { qtyPacks: 2, unitPrice: 18, purchaseTaxRateId: 'zero' },
    { qtyPacks: 2, unitPrice: 58, purchaseTaxRateId: null },
    { qtyPacks: 3, unitPrice: 10.005, purchaseTaxRateId: 'std' },
  ], rates);
  assert.deepEqual(t.lineTaxes, [0, 0, 0, 6]);                 // 30.015 x 0.2 = 6.003 → 6.00
  assert.equal(Math.round(t.subtotal * 100) / 100, 214.42);     // 32.4 + 36 + 116 + 30.015
  assert.equal(t.tax, 6);
  assert.deepEqual(poTotals([], rates), { lineTaxes: [], subtotal: 0, tax: 0 });
  assert.deepEqual(poTotals(null), { lineTaxes: [], subtotal: 0, tax: 0 });
});

test('matchScannedLine: supplier code, then our SKU, then the name', () => {
  const cands = [
    { key: 'l1', name: 'Free Range Eggs', supplierSku: 'SKU-022-HAR', itemSku: 'DEMO-022' },
    { key: 'l2', name: 'Brioche Buns', supplierSku: 'SKU-012-BAK', itemSku: 'DEMO-012' },
    { key: 'l3', name: 'Eggs Benedict Sauce', supplierSku: null, itemSku: null },
  ];
  assert.equal(normCode(' sku-022-har '), 'SKU022HAR');
  // the supplier code wins over a closer looking name
  assert.deepEqual(matchScannedLine({ code: 'SKU-022-HAR', description: 'Eggs Benedict Sauce' }, cands), { match: cands[0], how: 'supplier_sku' });
  assert.equal(matchScannedLine({ code: 'sku022har', description: '' }, cands).how, 'supplier_sku');
  // our own SKU printed on the note
  assert.deepEqual(matchScannedLine({ code: 'DEMO-022', description: 'x' }, cands), { match: cands[0], how: 'item_sku' });
  // a code nothing knows falls back to the name
  assert.deepEqual(matchScannedLine({ code: 'ZZ-1', description: 'Brioche Buns 48' }, cands), { match: cands[1], how: 'name' });
  assert.equal(matchScannedLine({ description: 'free range eggs' }, cands).match.key, 'l1');
  assert.deepEqual(matchScannedLine({ description: 'Paper towels' }, cands), { match: null, how: null });
  assert.deepEqual(matchScannedLine({}, cands), { match: null, how: null });
  assert.deepEqual(matchScannedLine({ description: 'eggs' }, null), { match: null, how: null });
});

test('one copy of the rules: src re-exports _shared, and the edge functions import the same file', () => {
  assert.match(read('./purchasingRules.js'), /export \* from '\.\.\/\.\.\/\.\.\/supabase\/functions\/_shared\/purchasingRules\.js';/);
  assert.match(read('./units.js'), /export \* from '\.\.\/\.\.\/\.\.\/supabase\/functions\/_shared\/stockUnits\.js';/);
  assert.match(read('./conversion.js'), /export \* from '\.\.\/\.\.\/\.\.\/supabase\/functions\/_shared\/stockConversion\.js';/);
  const approve = read('../../../supabase/functions/manager-approve/index.ts');
  assert.match(approve, /from '\.\.\/_shared\/purchasingRules\.js';/);
  assert.match(approve, /import \{ convert \} from '\.\.\/_shared\/stockConversion\.js';/);
  const snap = read('../../../supabase/functions/manager-snapshot/index.ts');
  assert.match(snap, /from '\.\.\/_shared\/purchasingRules\.js';/);
  // the shared conversion engine reads the shared unit table, not the browser copy
  assert.match(read('../../../supabase/functions/_shared/stockConversion.js'), /from '\.\/stockUnits\.js';/);
});
