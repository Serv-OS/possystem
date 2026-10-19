// tillLine.js: the till's own rules for one sold line, shared by every screen that builds a till
// line (v5.11.78, channel parity).
//
// 19 Oct 2026: store.addItem (the counter, table service, MPOS, drive thru) built its line with
// three rules a bar tab round never had:
//   price     menuPricing.cartUnitPrice for the order type and the active menu (tiers, order type
//             prices, the option surcharge stacked on the resolved price);
//   tax       the size rule (taxRefs.sizeTaxRefs) then this venue's rates (venueTaxRates
//             .lineTaxRefs, a rate id the till does not hold is dropped and noted);
//   category  a size reports under its product's category.
// BarSurface's addToRound charged the base price (a Half on the Bar menu at 17:00: 2.85 on a tab,
// 1.23 at the counter) and its lines carried NO tax references at all, so every bar tab line was
// taxed at the venue default: a zero rated soft drink booked 20% VAT and the Bar override set in
// Back Office (Peter, 8 Oct) never applied on a tab (41 of the 44 app written bar tab checks).
// Both now call these, so a line on a tab is the line the counter would ring.
//
// PURE: no store, runs under node --test.

import { sizeTaxRefs } from './taxRefs.js';
import { lineTaxRefs } from './venueTaxRates.js';
import { cartUnitPrice } from './menuPricing.js';

const parentOf = (item, menuItems) => (item?.parentId
  ? (Array.isArray(menuItems) ? menuItems : []).find((m) => m.id === item.parentId) || null
  : null);

/**
 * The tax references a till line carries, exactly as store.addItem stamps them:
 * { taxRateId, taxOverrides, dropped, taxFallback? } (venueTaxRates.lineTaxRefs's answer).
 */
export function tillLineTaxRefs(item, menuItems, taxRates) {
  const sized = sizeTaxRefs(item, parentOf(item, menuItems));
  return lineTaxRefs(sized.taxRateId, sized.taxOverrides, taxRates);
}

/** The fields a till line stores from tillLineTaxRefs (taxFallback only when a rate was dropped). */
export function tillLineTaxFields(refs) {
  return { taxRateId: refs.taxRateId, taxOverrides: refs.taxOverrides, ...(refs.taxFallback ? { taxFallback: refs.taxFallback } : {}) };
}

/** The category a till line reports under: a size takes its product's (v5.5.259), else its own. */
export function tillLineCat(item, menuItems) {
  const parent = parentOf(item, menuItems);
  if (parent?.cat) return parent.cat;
  return item?.cat || null;
}

/** The unit price a till line charges (store.addItem's call, with its fallback when it throws). */
export function tillLineUnitPrice(item, orderType, menuId, linePrice = null, qty = 1) {
  try { return cartUnitPrice(item, orderType, menuId, linePrice, qty); }
  catch { return linePrice != null ? linePrice / (Number(qty) || 1) : (item?.pricing?.base ?? item?.price ?? 0); }
}
