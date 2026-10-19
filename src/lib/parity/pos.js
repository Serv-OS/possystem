// src/lib/parity/pos.js: the POS reference for the golden parity baskets (v5.11.78).
//
// The POS is central (Peter, 18 Oct 2026): every other channel is checked against what this
// returns. It runs the till's own code, nothing re-implemented:
//   unit price   lib/tillLine.js tillLineUnitPrice (menuPricing.cartUnitPrice with the linePrice
//                shape every till add path passes, (base + option surcharge) x qty), the call
//                store.addItem makes since v5.11.78 (and a bar tab round)
//   tax refs     lib/tillLine.js tillLineTaxRefs: the till's size rule (taxRefs.sizeTaxRefs) then
//                venueTaxRates.lineTaxRefs, exactly as addItem does
//   line price   includes the options (the native POS line contract)
//   the bill     payments/checkTotals.computeCheckTotals (getPOSTotals, buildCloseRecord,
//                recordWalkInClosed all call it)
// posGolden.json was written from this file on origin/main 2bbd9ecc (v5.11.75) BEFORE any
// v5.11.78 change; posIdentity.test.js proves the POS gives byte identical results today.

import { resolveItemPrice } from '../menuPricing.js';
import { computeCheckTotals } from '../payments/checkTotals.js';
import { tillLineUnitPrice, tillLineTaxRefs, tillLineTaxFields, tillLineCat } from '../tillLine.js';
import {
  STORE_MENU, US_MENU, UK_RATES, US_RATES, RULES, SERVICE_DEVICE,
  ctxUK, ctxUS, lineMods, extraOf,
} from './fixtures.js';
import { mapMenuItemRow } from '../rowMapping.js';

const US_STORE = US_MENU.map(mapMenuItemRow);
export const menuFor = (b) => (b?.region === 'us' ? US_STORE : STORE_MENU);
export const ratesFor = (b) => (b?.region === 'us' ? US_RATES : UK_RATES);
export const taxCtxFor = (b) => (b?.region === 'us' ? ctxUS() : ctxUK());

/** The order line store.addItem builds for one basket line (the fields money reads). */
export function posLine(b, l, i = 0) {
  const menu = menuFor(b);
  const row = menu.find((m) => m.id === l.itemId);
  if (!row) throw new Error(`parity fixture: no menu row ${l.itemId}`);
  const qty = l.qty || 1;
  const extra = extraOf(l);
  const base = Number(row.pricing?.base ?? row.price ?? 0);
  const linePrice = (base + extra) * qty;
  const price = tillLineUnitPrice(row, b.orderType, b.menuId, linePrice, qty);
  const refs = tillLineTaxRefs(row, menu, ratesFor(b));
  return {
    uid: `u${i}`, itemId: row.id, name: row.name, price, qty, mods: lineMods(l),
    cat: tillLineCat(row, menu), parentId: row.parentId || null,
    ...tillLineTaxFields(refs),
  };
}
export const posLines = (b) => b.lines.map((l, i) => posLine(b, l, i));

/** The POS bill for a basket (computeCheckTotals, as getPOSTotals feeds it). */
export function posTotals(b, extra = {}) {
  const credits = [];
  if (b.credits?.promo) credits.push({ type: 'amount', value: b.credits.promo });
  if (b.credits?.loyalty) credits.push({ type: 'amount', value: b.credits.loyalty });
  return computeCheckTotals({
    items: posLines(b),
    checkDiscounts: b.checkDiscounts || [],
    covers: b.covers || 1,
    serviceChargeWaived: false,
    orderType: b.orderType,
    deviceConfig: b.device === 'service' ? SERVICE_DEVICE : {},
    discountRules: RULES,
    timezone: 'Europe/London',
    deliveryQuote: null,
    taxCtx: taxCtxFor(b),
    creditDiscounts: credits,
    ...extra,
  });
}

/** Unit price the POS charges for one item (no options), for the cross channel price tables. */
export const posUnit = (itemId, orderType, menuId = null, region = null) => {
  const b = { orderType, menuId, region, lines: [{ itemId, qty: 1 }] };
  return posLine(b, b.lines[0]).price;
};

/** The POS figures pinned in posGolden.json: unit prices, every line and the whole bill. */
export function posFigures(b) {
  const t = posTotals(b);
  return {
    lines: posLines(b).map((l) => ({ itemId: l.itemId, price: l.price, qty: l.qty, taxRateId: l.taxRateId, taxOverrides: l.taxOverrides })),
    subtotal: t.subtotal, checkDiscount: t.checkDiscount, discountedSub: t.discountedSub,
    service: t.service, deliveryFee: t.deliveryFee, exclusiveTax: t.exclusiveTax, total: t.total,
    autoDiscounts: t.autoDiscounts, tax: t.tax,
  };
}

export { resolveItemPrice };
