// qrCloseTax.test.js: a QR check written by the till (Orders force close, or a tab closed short)
// books its VAT. Run: `npm test`, or `node --test src/lib/qrCloseTax.test.js`.
//
// 27 Sep 2026: forceCloseQrTab, the single QR order force close and closeShortQrTab booked
// tax_amount null. The v5.9.97 attempt was dropped because order_queue lines keep the base price
// and each modifier's price apart (mods[].price) and carry no taxRateId: it missed every priced
// modifier and every product rate. Now: modifiers folded in (modsTotal), each line's rate,
// overrides and profile restored from the till's menu by itemId, then itemsTaxRecord + paidShare.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { qrTaxLines, qrCloseTax } from './headlessTax.js';
import { shortTabClosedCheck, qrTabShortInfo } from './orderPayment.js';
import { recordedCheckTax } from './taxCompute.js';
import { toStoreRate } from './venueTaxRates.js';

const std = toStoreRate({ id: 'std', name: 'Standard Rate', code: 'VAT20', rate: 0.2, type: 'inclusive', is_default: true, active: true, location_id: 'leeds' });
const zero = toStoreRate({ id: 'zero', name: 'Zero Rate', code: 'ZERO', rate: 0, type: 'inclusive', is_default: false, active: true, location_id: 'leeds' });
const salesTax = toStoreRate({ id: 'us', name: 'Sales Tax', code: 'US', rate: 0.1, type: 'exclusive', is_default: true, active: true, location_id: 'provo' });
const pence = (n) => Math.round(n * 100);

const red = toStoreRate({ id: 'red', name: 'Reduced Rate', code: 'VAT5', rate: 0.05, type: 'inclusive', is_default: false, active: true, location_id: 'leeds' });
const menuItems = [
  { id: 'burger', name: 'Burger', price: 10, taxRateId: 'std', taxOverrides: {} },
  { id: 'cake', name: 'Cake', price: 6, taxRateId: 'zero', taxOverrides: {} },
  { id: 'latte', name: 'Latte', price: 3, taxRateId: null, taxOverrides: { takeaway: 'zero' } },
  // Leeds Babyccino: the parent carries the 5% rate; its Milk size row was saved with Tax rate
  // "Use default" (null) and no overrides, as the item editor writes a size (8 Oct 2026 review).
  { id: 'babyccino', name: 'Babyccino', price: 1.55, taxRateId: 'red', taxOverrides: { takeaway: 'zero' } },
  { id: 'babyccino-milk', name: 'Milk', price: 1.55, parentId: 'babyccino', taxRateId: null, taxOverrides: {} },
  { id: 'babyccino-oat', name: 'Oat', price: 1.85, parentId: 'babyccino', taxRateId: 'std', taxOverrides: {} },
];
const ctx = { menuItems, taxRates: [std, zero, red] };

// Two order_queue lines as QrCheckout writes them: base price, mods apart, no tax fields.
const qrItems = () => ([
  { itemId: 'burger', name: 'Burger', price: 10, qty: 1, mods: [{ name: 'Cheese', price: 1 }, { name: 'Bacon', price: 0.5, qty: 2 }], cat: 'mains' },
  { itemId: 'cake', name: 'Cake', price: 6, qty: 1, mods: [] },
]);

test('lines take their modifier prices and their product rate from the menu', () => {
  const lines = qrTaxLines(qrItems(), menuItems);
  assert.equal(lines[0].price, 12);            // 10 + 1 + 0.5 x 2
  assert.equal(lines[0].taxRateId, 'std');
  assert.equal(lines[1].price, 6);
  assert.equal(lines[1].taxRateId, 'zero');    // a zero rated cake, not the venue default
  assert.equal(lines[0].cat, 'mains');         // the line's own category stays
  // A variant whose own row is not on the menu takes its parent's rate.
  const v = qrTaxLines([{ itemId: 'cake-slice', parentId: 'cake', price: 3, qty: 1 }], menuItems)[0];
  assert.equal(v.taxRateId, 'zero');
  // A line not on this till's menu keeps what it carries (none: the venue default), and since
  // 8 Oct 2026 (D4) says so, so the record flags it instead of taking the default quietly.
  const u = qrTaxLines([{ itemId: 'gone', price: 5, qty: 1, taxRateId: null }], menuItems)[0];
  assert.equal(u.taxRateId, null);
  assert.deepEqual(u.taxFallback, { reason: 'item-not-on-menu', rateId: null });
  const gone = qrCloseTax([{ itemId: 'gone', name: 'Gone', price: 6, qty: 1 }], ctx, { paidGoods: 6 });
  assert.equal(gone.taxAmount, 1, 'the venue default, never 0 or null');
  assert.deepEqual(gone.taxBreakdown.fallbacks.map((f) => [f.reason, f.itemId]), [['item-not-on-menu', 'gone']]);
  // one that carries its own rate from the page is left alone
  assert.equal('taxFallback' in qrTaxLines([{ itemId: 'gone', price: 5, qty: 1, taxRateId: 'zero' }], menuItems)[0], false);
  // Voided lines drop out.
  assert.equal(qrTaxLines([{ itemId: 'burger', price: 1, qty: 1, voided: true }], menuItems).length, 0);
});

test('a force close that took the whole bill books the VAT on every line with its modifiers', () => {
  const t = qrCloseTax(qrItems(), ctx, { paidGoods: 18 });
  assert.equal(t.taxAmount, 2);                // £12 burger at 20% = £2.00; the zero rated cake adds nothing
  // 8 Oct 2026: the record is written for a UK whole bill too (it was written only for added-on
  // tax or a share): the Xero daily invoice reads the split by rate from it instead of estimating.
  assert.equal(t.taxBreakdown.totalTax, 2);
  assert.deepEqual(t.taxBreakdown.breakdown.map((b) => [b.rate.id, Math.round(b.tax * 100)]), [['std', 200], ['zero', 0]]);
  assert.equal('share' in t.taxBreakdown, false, 'the whole bill: not a share');
  assert.equal(t.exclusiveTax, 0);
  // The dropped attempt: base prices, venue default on every line.
  assert.notEqual(pence(t.taxAmount), pence((10 + 6) - (10 + 6) / 1.2));
});

test('per order type overrides come back from the menu too', () => {
  const t = qrCloseTax([{ itemId: 'latte', price: 3, qty: 2 }], ctx, { paidGoods: 6 });
  assert.equal(t.taxAmount, 1, 'dine-in: no override, the venue default (20% of £6 inclusive)');
});

test('a capture short of the bill books only its share, and says so', () => {
  const t = qrCloseTax(qrItems(), ctx, { paidGoods: 9 });   // half the £18 of goods
  assert.equal(t.taxAmount, 1);
  assert.equal(t.taxBreakdown.share, 0.5);
  assert.equal(t.taxBreakdown.totalTax, 1);
  // The Z report reads the booked share, never the whole tab's VAT again.
  const check = { items: qrItems(), discounts: [], orderType: 'dine-in', taxAmount: t.taxAmount, taxBreakdown: t.taxBreakdown };
  assert.equal(recordedCheckTax(check, { taxRates: [std, zero] }).totalTax, 1);
});

test('added-on (US) tax: the record rides along and the caller takes it out of subtotal', () => {
  const t = qrCloseTax([{ itemId: 'x', price: 20, qty: 1, mods: [] }], { menuItems: [], taxRates: [salesTax] }, { paidGoods: 22 });
  assert.equal(t.exclusiveTax, 2);
  assert.equal(t.taxAmount, 2);
  assert.equal(t.taxBreakdown.hasExclusiveTax, true);
});

test('no tax set up, nothing to tax, or anything unexpected: null, as before (never a guess)', () => {
  const none = { taxAmount: null, taxBreakdown: null, exclusiveTax: 0 };
  assert.deepEqual(qrCloseTax(qrItems(), { menuItems, taxRates: [] }), none);
  assert.deepEqual(qrCloseTax([], ctx), none);
  assert.deepEqual(qrCloseTax(null, ctx), none);
  assert.deepEqual(qrCloseTax(qrItems(), { get menuItems() { throw new Error('boom'); }, taxRates: [std] }), none);
});

test('closeShortQrTab: the check books the share of VAT the capture paid for', () => {
  const rows = [
    { ref: 'Q1', location_id: 'leeds', customer: { tip: 1, payment_state: 'short', tab_close_short: { paid_minor: 1000, due_minor: 1900 } } },
  ];
  const tab = { rows, allItems: qrItems(), firstRow: rows[0], payment_intent_id: 'pi_1', processor: 'stripe', tableId: 't1', tableLabel: '4' };
  const short = qrTabShortInfo(rows);
  const check = shortTabClosedCheck(tab, short, { nowIso: '2026-09-27T20:00:00.000Z', taxFor: (paidGoods) => qrCloseTax(tab.allItems, ctx, { paidGoods }) });
  assert.equal(check.subtotal, 9);             // £10 paid less the £1 tip
  assert.equal(check.tax_amount, 1);           // half of the tab's £2 VAT (9 of 18)
  assert.equal(check.tax_breakdown.share, 0.5);
  // Without a tax function: exactly the old record.
  const old = shortTabClosedCheck(tab, short, { nowIso: '2026-09-27T20:00:00.000Z' });
  assert.equal(old.tax_amount, null);
  assert.equal('tax_breakdown' in old, false);
  assert.equal(old.subtotal, 9);
  // A tax function that throws never stops the close.
  assert.equal(shortTabClosedCheck(tab, short, { taxFor: () => { throw new Error('x'); } }).tax_amount, null);
});

test('wiring: all three Orders Hub QR closes book VAT (none books tax_amount null)', () => {
  const hub = fs.readFileSync(new URL('../surfaces/OrdersHub.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(hub, /tax_amount: null/);
  assert.match(hub, /import \{ qrCloseTax \} from '\.\.\/lib\/headlessTax';/);
  assert.match(hub, /import \{ taxCtxHasConfig \} from '\.\.\/lib\/taxCompute';/);
  assert.match(hub, /shortTabClosedCheck\(tab, short, \{ taxFor: \(paidGoods\) => qrCloseTax\(tab\.allItems, qrTaxCtx\(\), \{ paidGoods \}\) \}\)/);
  assert.match(hub, /const qrTax = qrCloseTax\(tab\.allItems, qrTaxCtx\(\), \{ paidGoods: totalCollected - tabTip - surcharge \}\);/);
  assert.match(hub, /const qrTax = qrCloseTax\(o\.items, qrTaxCtx\(\), \{ paidGoods: captureAmount - qrTip - surcharge \}\);/);
  assert.equal((hub.match(/tax_amount: qrTax\.taxAmount,/g) || []).length, 2);
  assert.equal((hub.match(/\.\.\.\(qrTax\.taxBreakdown \? \{ tax_breakdown: qrTax\.taxBreakdown \} : \{\}\),/g) || []).length, 2);
  assert.match(hub, /menuItems: st\.menuItems \|\| \[\], taxRates: st\.taxRates \|\| \[\], taxCtx, hasTaxConfig: taxCtxHasConfig\(taxCtx\)/);
});

test('8 Oct 2026 (review): a size ON the menu with no rate of its own takes its parent rate and overrides, as the till and the kiosk do', () => {
  // Milk: null rate, no overrides -> the parent's 5% and the parent's takeaway override.
  const milk = qrTaxLines([{ itemId: 'babyccino-milk', parentId: 'babyccino', price: 1.55, qty: 1 }], menuItems)[0];
  assert.equal(milk.taxRateId, 'red');
  assert.deepEqual(milk.taxOverrides, { takeaway: 'zero' });
  assert.equal(milk.taxFallback, undefined);
  // Oat: its own rate stands (a size at its own Back Office rate), the parent's overrides fill the gap.
  const oat = qrTaxLines([{ itemId: 'babyccino-oat', parentId: 'babyccino', price: 1.85, qty: 1 }], menuItems)[0];
  assert.equal(oat.taxRateId, 'std');
  assert.deepEqual(oat.taxOverrides, { takeaway: 'zero' });
  // The force close books 0.07 on 1.55 at 5%, the same as settle_qr_tab and the till, not 0.26 at the default 20%.
  const t = qrCloseTax([{ itemId: 'babyccino-milk', parentId: 'babyccino', name: 'Babyccino Milk', price: 1.55, qty: 1, mods: [] }], ctx);
  assert.equal(t.taxAmount, 0.07);
  assert.equal(t.taxBreakdown.breakdown[0].rate.id, 'red');
  assert.equal(t.taxBreakdown.fallbacks, undefined);
});
