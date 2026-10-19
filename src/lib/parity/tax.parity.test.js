// tax.parity.test.js: every channel books the till's VAT for the same basket (v5.11.78).
// Run: node --test src/lib/parity/tax.parity.test.js
//
// The POS reference is pos.js (computeCheckTotals over the till's own lines). Each channel's VAT
// comes from the code that channel runs: the online, QR and catering line builder (taxRefs.js),
// the kiosk line (kioskLine.js), the QR close (headlessTax.js), the HubRise close
// (channelMoney.js), a bar tab (barTabTax.js over tillLine.js lines), refunds (refundMath.js),
// the daily VAT check (vatRederive.js) and ezCater (ezcaterCatering.js). Tax rules stay data: no
// test here, and no code it covers, works tax out live on a server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MENU, STORE_MENU, UK_RATES, ctxUK, ctxUS, US_MENU, raw, storeRow, basket } from './fixtures.js';
import { posLine, posLines, posTotals, taxCtxFor } from './pos.js';
import { computeOrderTaxUnified } from '../taxCompute.js';
import { computeCheckTotals } from '../payments/checkTotals.js';
import { roundVat } from '../taxRule.js';
import { kioskVariant, kioskLineTaxRefs } from '../kioskLine.js';
import { qrTaxLines, qrCloseTax } from '../headlessTax.js';
import { buildChannelCloseFields } from '../channelMoney.js';
import { refundBreakdown, refundTaxAmount } from '../payments/refundMath.js';
import { rederiveSale } from '../../../supabase/functions/_shared/vatRederive.js';
import { mapMenuItemRow } from '../rowMapping.js';
import { readRepo, between } from './src.js';

const vat = (t) => roundVat(t?.totalTax);
const line = (row, refs, price, qty = 1, extra = {}) => ({ uid: `x-${row.id}`, itemId: row.id, price, qty, ...refs, ...extra });
const hubOrder = (items, extra = {}) => ({ channel: 'delivery', total: items.reduce((s, i) => s + i.price * (i.qty || 1), 0), items, customer: { payments: [] }, ...extra });

// ── A size follows its product (confirmed major: online, QR pay now, catering, HubRise) ───────────
for (const [id, ot] of [['baby-l', 'collection'], ['baby-l', 'dine-in'], ['cake-slice', 'takeaway']]) {
  test(`a size with no VAT of its own follows its product: ${id} ${ot} books the till's VAT on every channel`, async () => {
    const { lineTaxRefsFor } = await import('../taxRefs.js');
    const b = { orderType: ot, menuId: null, lines: [{ itemId: id, qty: 1 }] };
    const pos = vat(posTotals(b).tax);
    const price = posLine(b, b.lines[0]).price;
    const rawRow = raw(id);
    const parent = raw(rawRow.parent_id);
    // online, QR pay now and catering: the page's cart line (OnlineSurface / CateringSurface addToCart)
    const page = vat(computeOrderTaxUnified([line(rawRow, lineTaxRefsFor(rawRow, MENU), price)], ctxUK(), ot));
    // kiosk: the basket line
    const kiosk = vat(computeOrderTaxUnified([line(rawRow, kioskLineTaxRefs({ item: parent, variant: kioskVariant(parent, rawRow) }), price)], ctxUK(), ot));
    // QR close (Orders force close, the phone, settle): qrTaxLines restores the rule from the menu
    const qr = vat(computeOrderTaxUnified(qrTaxLines([{ itemId: id, parentId: rawRow.parent_id, price, qty: 1, mods: [] }], STORE_MENU), ctxUK(), ot));
    // HubRise close (channelMoney)
    const hub = buildChannelCloseFields(hubOrder([{ id: 'h1', itemId: id, name: id, price, qty: 1, mods: [] }], { channel: ot === 'takeaway' ? 'collection' : ot === 'dine-in' ? 'eat_in' : 'collection' }), { menuItems: STORE_MENU, taxRates: UK_RATES }).taxAmount;
    assert.deepEqual({ page, kiosk, qr, hub }, { page: pos, kiosk: pos, qr: pos, hub: pos }, `till ${pos}`);
  });
}

test('the page cart line takes its tax references from the shared rule (OnlineSurface, CateringSurface, channelMoney)', () => {
  assert.match(readRepo('src/surfaces/online/OnlineSurface.jsx'), /\.\.\.lineTaxRefsFor\(item, items\),/);
  assert.match(readRepo('src/surfaces/catering/CateringSurface.jsx'), /\.\.\.lineTaxRefsFor\(item, items\), price,/);
  assert.match(readRepo('src/lib/channelMoney.js'), /const refs = mi \? lineTaxRefsFor\(mi, menuItems\) : null;/);
  assert.match(readRepo('src/store/index.js'), /const refs = tillLineTaxRefs\(item, useStore\.getState\(\)\.menuItems, useStore\.getState\(\)\.taxRates\);/);
  assert.match(readRepo('src/lib/kioskLine.js'), /const refs = v \? sizeTaxRefs\(v, item\) : sizeTaxRefs\(item, null\);/);
});

// ── HubRise channel discounts and fees (confirmed major; US fees minor) ───────────────────────────
test('HubRise: a channel discount takes the VAT off exactly as the till books a discounted bill', () => {
  const items = [{ id: 'h1', itemId: 'burger', name: 'Burger', price: 9, qty: 1, mods: [] }, { id: 'h2', itemId: 'sarnie', name: 'Sandwich', price: 4.5, qty: 1, mods: [] }];
  const hub = buildChannelCloseFields(hubOrder(items, { customer: { payments: [], discounts: [{ name: 'Offer', amount: 3 }] } }), { menuItems: STORE_MENU, taxRates: UK_RATES });
  const till = computeCheckTotals({ items: items.map((i) => ({ ...i, ...{ taxRateId: storeRow(i.itemId).taxRateId, taxOverrides: storeRow(i.itemId).taxOverrides } })), checkDiscounts: [{ type: 'amount', value: 3 }], covers: 1, orderType: 'delivery', taxCtx: ctxUK() });
  assert.equal(hub.taxAmount, vat(till.tax), `till ${vat(till.tax)}`);
  // No discount: the record is the same object the seam returns (nothing changes for 99% of sales).
  const plain = buildChannelCloseFields(hubOrder(items), { menuItems: STORE_MENU, taxRates: UK_RATES });
  assert.equal(plain.taxBreakdown.share, undefined);
});

test('HubRise US: a bag fee is taxed where the profile taxes a service charge, and an offer lowers the added on tax, as the till', () => {
  const US_STORE = US_MENU.map(mapMenuItemRow);
  const items = [{ id: 'u1', itemId: 'burger', name: 'Burger', price: 17, qty: 1, mods: [] }, { id: 'u2', itemId: 'soda', name: 'Soda', price: 10, qty: 1, mods: [] }];
  const tillLines = items.map((i) => ({ ...i, uid: i.id, cat: US_STORE.find((m) => m.id === i.itemId).cat, taxRateId: null, taxOverrides: {} }));
  const fee = buildChannelCloseFields(hubOrder(items, { customer: { payments: [], charges: [{ name: 'Bag fee', type: 'other', amount: 1.5 }] } }), { menuItems: US_STORE, taxCtx: ctxUS() });
  const tillFee = computeOrderTaxUnified(tillLines, ctxUS(), 'delivery', { discounts: [], service: 1.5, deliveryFee: 0 });
  assert.equal(fee.taxAmount, vat(tillFee), 'bag fee');
  const off = buildChannelCloseFields(hubOrder(items, { customer: { payments: [], discounts: [{ name: 'Offer', amount: 5 }] } }), { menuItems: US_STORE, taxCtx: ctxUS() });
  const tillOff = computeOrderTaxUnified(tillLines, ctxUS(), 'delivery', { discounts: [{ type: 'amount', value: 5 }], service: 0, deliveryFee: 0 });
  assert.equal(off.taxAmount, vat(tillOff), 'offer');
});

// ── Refunds (confirmed major: pro rata over the whole check) ─────────────────────────────────────
const mixedCheck = () => {
  const b = { orderType: 'takeaway', menuId: null, lines: [{ itemId: 'toastie', qty: 1 }, { itemId: 'sarnie', qty: 1 }] };
  const items = posLines(b);
  const t = posTotals(b);
  return { id: 'chk-r', orderType: 'takeaway', items, subtotal: t.subtotal, total: t.total, tip: 0, service: 0, taxAmount: vat(t.tax), taxBreakdown: t.tax, refunds: [] };
};

test('refund: a part refund gives back the VAT of the lines it returns, never a share of the whole check', () => {
  const chk = mixedCheck();
  const [toastie, sarnie] = chk.items;
  const give = (it) => {
    const items = [{ ...it, refundQty: 1 }];
    return refundTaxAmount(chk, refundBreakdown(chk, { items }), { items, taxRates: UK_RATES });
  };
  assert.equal(give(sarnie), 0, 'the zero rated sandwich carried no VAT');
  assert.equal(give(toastie), vat({ totalTax: 5.35 - 5.35 / 1.2 }), 'the toastie gives back its own 0.89');
  // A tip only refund gives back no VAT.
  const tipped = { ...chk, tip: 1, total: chk.total + 1 };
  assert.equal(refundTaxAmount(tipped, refundBreakdown(tipped, { items: [], tipOverride: 1, serviceOverride: 0 }), { items: [], taxRates: UK_RATES }), 0);
});

test('refund: a one rate check with no tip gives back exactly what it did before (pro rata = line rule)', () => {
  const b = basket('refund');
  const t = posTotals(b);
  const chk = { id: 'chk-1', orderType: b.orderType, items: posLines(b), subtotal: t.subtotal, total: t.total, tip: 0, service: 0, taxAmount: vat(t.tax), taxBreakdown: t.tax, refunds: [] };
  const items = [{ ...chk.items[0], refundQty: 1 }];
  const bd = refundBreakdown(chk, { items });
  const old = Math.round(chk.taxAmount * (bd.amount / chk.total) * 100) / 100;
  assert.equal(refundTaxAmount(chk, bd, { items, taxRates: UK_RATES }), old);
  assert.match(readRepo('src/store/index.js'), /const taxRefunded = refundTaxAmount\(chkBefore, bd, \{ items: refundItems, taxRates: get\(\)\.taxRates \}\);/);
});

// Round 1 fix (19 Oct 2026): a discounted check refunds each line at its own price, so the VAT given
// back is the VAT inside that money. Scaling it by the bill's discount share gave a meal deal burger
// refunded at 9.00 only 1.20 of VAT (1.50 is inside 9.00) and left the rest of the check at 26.7%.
const checkOf = (b) => {
  const t = posTotals(b);
  return { id: `chk-${b.id}`, orderType: b.orderType, items: posLines(b), subtotal: t.subtotal, total: t.total, tip: 0, service: 0, taxAmount: vat(t.tax), taxBreakdown: t.tax, refunds: [] };
};
const refundLine = (chk, idx, qty = 1) => {
  const items = [{ ...chk.items[idx], refundQty: qty }];
  const bd = refundBreakdown(chk, { items });
  return { bd, taxAmount: refundTaxAmount(chk, bd, { items, taxRates: UK_RATES }) };
};
for (const [id, expectTotal, expectVat] of [['auto-discount', 12, 2], ['manual-discount', 16.2, 2.7]]) {
  test(`refund of one line on a discounted one rate check gives back the VAT inside the money returned (${id})`, () => {
    const chk = checkOf(basket(id));
    assert.equal(Math.round(chk.total * 100) / 100, expectTotal, 'the bill was discounted');
    assert.equal(chk.taxAmount, expectVat, 'VAT booked on what was charged');
    const { bd, taxAmount } = refundLine(chk, 0);
    assert.equal(bd.amount, 9, 'the burger goes back at its own price');
    assert.equal(taxAmount, 1.5, 'the VAT inside 9.00 at 20%');
    // v5.11.75 (pro rata on the money) gave the same on one rate: nothing moves for these checks.
    assert.equal(taxAmount, Math.round(chk.taxAmount * (bd.amount / chk.total) * 100) / 100);
    // The rest of the check keeps 20% inside it, and the refund that clears the bill sweeps the rest.
    const after = { ...chk, refunds: [{ amount: bd.amount, tipAmount: 0, serviceAmount: 0, taxAmount }] };
    const leftMoney = Math.round((chk.total - bd.amount) * 100) / 100;
    assert.equal(Math.round((chk.taxAmount - taxAmount) * 100) / 100, Math.round(leftMoney / 6 * 100) / 100, 'the money left carries 20% VAT');
    const restItems = after.items.map((it, i) => ({ ...it, refundQty: i === 0 ? Math.max(0, it.qty - 1) : it.qty })).filter((it) => it.refundQty > 0);
    const bd2 = refundBreakdown(after, { items: restItems });
    assert.equal(refundTaxAmount(after, bd2, { items: restItems, taxRates: UK_RATES }), Math.round((chk.taxAmount - taxAmount) * 100) / 100);
  });
}

test('refund of the 20% line on a discounted mixed rate check gives back the VAT inside its price, never a share of the bill\'s VAT', () => {
  const chk = checkOf({ id: 'mixed-10', orderType: 'takeaway', menuId: null, lines: [{ itemId: 'burger', qty: 1 }, { itemId: 'toastie', qty: 1 }, { itemId: 'sarnie', qty: 1 }], checkDiscounts: [{ id: 'd1', label: '10% off', type: 'percent', value: 10 }] });
  assert.equal(chk.taxAmount, 2.15, '14.35 of 20% goods less 10%');
  assert.equal(refundLine(chk, 1).taxAmount, vat({ totalTax: 5.35 - 5.35 / 1.2 }), 'the toastie: 0.89 inside 5.35 (0.80 when scaled by the discount)');
  assert.equal(refundLine(chk, 2).taxAmount, 0, 'the zero rated sandwich carried none');
  // Never more than the VAT still on the check: a line refunded at its price on a discounted bill
  // can hold more VAT than the bill booked (one 20% line, the rest zero rated), and gives back what is left.
  const one = checkOf({ id: 'one-20', orderType: 'takeaway', menuId: null, lines: [{ itemId: 'toastie', qty: 1 }, { itemId: 'sarnie', qty: 1 }], checkDiscounts: [{ id: 'd1', label: '10% off', type: 'percent', value: 10 }] });
  assert.equal(refundLine(one, 0).taxAmount, one.taxAmount);
});

// ── Public checks store the till's line contract (confirmed major: readers saw base only) ─────────
test('public checks: a QR latte with a paid syrup is stored folded, and the daily VAT check then agrees with the booked VAT', async () => {
  const { foldLineMods } = await import('../channelMoney.js');
  assert.equal(typeof foldLineMods, 'function');
  const pageLines = [{ itemId: 'latte', name: 'Latte', price: 3.2, qty: 1, mods: [{ id: 'o-oat', name: 'Oat', price: 0.5 }] }];
  const booked = qrCloseTax(pageLines, { menuItems: STORE_MENU, taxRates: UK_RATES, taxCtx: ctxUK() });
  const folded = foldLineMods(pageLines);
  assert.equal(folded[0].price, 3.7);
  assert.equal(folded[0].mods[0].price, 0.5, 'the option keeps its price for receipts, like a till line');
  assert.equal(foldLineMods(folded), folded, 'never folded twice');
  const row = { id: 'chk-q', source: 'qr', order_type: 'dine-in', items: folded, discounts: [], total: 3.7, tip: 0, tax_amount: booked.taxAmount, tax_breakdown: booked.taxBreakdown };
  const d = rederiveSale(row, { rates: UK_RATES.map((r) => ({ ...r })), menu: MENU.map((m) => ({ ...m, tax_rate_id: m.tax_rate_id })) });
  assert.equal(d.totalTax, booked.taxAmount, 'the check reads the whole line');
  assert.equal(vat(qrCloseTax(folded, { menuItems: STORE_MENU, taxRates: UK_RATES, taxCtx: ctxUK() }).taxBreakdown), booked.taxAmount, 'a folded line is never folded again by the QR close');
});

test('public checks: every writer stores folded lines (Orders force closes, the phone, the short close, the server)', () => {
  const hub = readRepo('src/surfaces/OrdersHub.jsx');
  assert.match(hub, /items: foldLineMods\(tab\.allItems\)\.map\(i => \(\{ \.\.\.i, voided: false \}\)\),/);
  assert.match(hub, /items: foldLineMods\(o\.items \|\| \[\]\)\.map\(i => \(\{ \.\.\.i, voided: false \}\)\),/);
  assert.match(readRepo('src/surfaces/qr/TabResumeScreen.jsx'), /items: foldLineMods\(allItems\)\.map\(i => \(\{ \.\.\.i, voided: false \}\)\),/);
  assert.match(readRepo('src/lib/orderPayment.js'), /items: foldLineMods\(Array\.isArray\(tab\.allItems\) \? tab\.allItems : \[\]\)/);
  assert.match(readRepo('src/surfaces/catering/CateringCheckout.jsx'), /items: foldLineMods\(buildItems\(\)\)\.map/);
  const sql = readRepo('supabase/migrations/20261019a_OPS_channel_parity.sql');
  assert.match(between(sql, 'CREATE OR REPLACE FUNCTION public._public_order_check_row(', '$function$;'), /public\._order_line_folded\(x\) \|\| '\{"voided": false\}'::jsonb/);
  assert.match(between(sql, 'CREATE OR REPLACE FUNCTION public.settle_qr_tab(', '$function$;'), /'items', coalesce\(\(select jsonb_agg\(public\._order_line_folded\(x\) order by n\)/);
});

// ── A bar tab's lines carry the till's tax references (found while building: 41 of 44 app bar tab checks) ──
test('bar tab: a zero rated drink with a Bar override books the till\'s VAT, not the venue default', async () => {
  const { tillLineTaxRefs, tillLineTaxFields } = await import('../tillLine.js');
  const { tabCloseTax } = await import('../barTabTax.js');
  const row = storeRow('squash');
  const barLine = { uid: 'r1', itemId: 'squash', name: 'Squash', price: 1.5, qty: 2, mods: [], ...tillLineTaxFields(tillLineTaxRefs(row, STORE_MENU, UK_RATES)) };
  const tab = tabCloseTax([barLine], ctxUK(), { paymentInfo: { grand: 3 } });
  const pos = computeCheckTotals({ items: [posLine({ orderType: 'bar-tab', menuId: null }, { itemId: 'squash', qty: 2 })], checkDiscounts: [], covers: 1, orderType: 'bar-tab', taxCtx: ctxUK() });
  assert.equal(tab.taxAmount, vat(pos.tax), 'the Bar override (5%) applies on the tab as at the counter');
  assert.notEqual(tab.taxAmount, vat({ totalTax: 3 - 3 / 1.2 }), 'never the 20% default');
  assert.match(readRepo('src/surfaces/BarSurface.jsx'), /cat: tillLineCat\(item, storeMenuItems \|\| \[\]\), \.\.\.tillLineCats\(item, storeMenuItems \|\| \[\]\), parentId: item\.parentId \|\| null, \.\.\.taxFields \};/);
});

// ── ezCater (confirmed major: never booked) ───────────────────────────────────────────────────────
test('ezCater: the sale is booked with ezCater\'s own tax (what the venue owes), never worked out from our rates', async () => {
  const { ezcaterClosedCheck } = await import('../../../supabase/functions/_shared/ezcaterCatering.js');
  const row = {
    ref: 'EZ-1', location_id: 'L', type: 'collection', event_date: '2026-11-02', collection_time: '12:00',
    items: [{ name: 'Box lunch', qty: 10, price: 12, lineSubunits: 12000 }],
    customer: { channel: 'ezcater', ezcater_lifecycle: 'accepted', ezcater_order_id: 'u-1', catererReceivesTip: true, catererReceivesDeliveryFee: true,
      totals: { subtotal: 120, tip: 12, deliveryFee: 0, feesAndDiscounts: [] }, tax: { salesTax: 8.7, salesTaxRemittance: 0, taxableState: 'UT' } },
  };
  const sale = ezcaterClosedCheck(row, { venueTz: 'America/Denver' });
  assert.equal(sale.id, 'chk-ez-u-1');
  assert.equal(sale.tax_amount, 8.7);
  assert.equal(sale.total, 140.7, 'goods, tax and tip: never catererTotalDue (net of commission)');
  assert.equal(sale.tax_breakdown.engine, 'ezcater');
  // A marketplace facilitator state: ezCater remits the tax, so the venue books none of it.
  const remitted = ezcaterClosedCheck({ ...row, customer: { ...row.customer, tax: { salesTax: 8.7, salesTaxRemittance: 8.7 } } });
  assert.equal(remitted.tax_amount, 0);
  assert.equal(remitted.tax_breakdown.remittedByChannel, 8.7);
  // Not committed yet: nothing is booked.
  assert.equal(ezcaterClosedCheck({ ...row, customer: { ...row.customer, ezcater_lifecycle: 'new' } }), null);
  const hook = readRepo('supabase/functions/ezcater-webhook/index.ts');
  assert.match(hook, /await sb\.from\('closed_checks'\)\.upsert\(sale, \{ onConflict: 'id' \}\);/);
  assert.match(hook, /\.update\(\{ status: 'voided', voided: true \}\)\.eq\('id', checkId\)\.eq\('status', 'paid'\);/);
  const { judgeSale } = await import('../../../supabase/functions/_shared/vatCheck.js');
  assert.equal(judgeSale(sale, { rates: [], menu: [] }).verdict, 'not-checked', 'the daily check never judges a platform set tax');
});

// ── Already the same on every channel (regression guards) ────────────────────────────────────────
for (const id of ['vat-by-order-type', 'order-type-delivery', 'order-type-drive-thru', 'zero-rate', 'options', 'us-stacked']) {
  test(`regression: "${id}" books the same VAT on the till, kiosk, online, QR close and HubRise`, () => {
    const b = basket(id);
    const pos = vat(posTotals(b).tax);
    const lines = posLines(b);
    const ctx = taxCtxFor(b);
    const basis = b.checkDiscounts ? { discounts: b.checkDiscounts } : null;
    const seam = (ls) => vat(computeOrderTaxUnified(ls, ctx, b.orderType, basis));
    // kiosk, online and QR pay now lines carry the same references (taxRefs / kioskLine), so the
    // seam over the till's lines is what each books; the QR close restores them from the menu.
    if (!b.checkDiscounts) assert.equal(seam(lines), pos, 'the shared seam');
    if (b.region !== 'us') {
      const qr = qrTaxLines(lines.map((l) => ({ itemId: l.itemId, parentId: l.parentId, price: l.price, qty: l.qty, mods: [] })), STORE_MENU);
      assert.equal(vat(computeOrderTaxUnified(qr, ctx, b.orderType)), pos, 'QR close');
      const channel = b.orderType === 'takeaway' || b.orderType === 'drive-thru' ? 'collection' : b.orderType === 'dine-in' ? 'eat_in' : 'delivery';
      if (b.orderType !== 'drive-thru') {
        const hub = buildChannelCloseFields(hubOrder(lines.map((l, i) => ({ id: `h${i}`, itemId: l.itemId, name: l.name, price: l.price, qty: l.qty, mods: [] })), { channel }), { menuItems: STORE_MENU, taxRates: UK_RATES });
        assert.equal(hub.taxAmount, pos, 'HubRise');
      }
    }
  });
}
