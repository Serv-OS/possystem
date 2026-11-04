// src/lib/stock/stockRegion.js
//
// 5.12.57 (US basics batch 7): what changes in stock and purchasing when the SITE is in the US.
// The site's own currency decides its country (regionPack.regionOf: USD is the US), so a US site
// picked while signed in at a UK venue reads as a US site, and the other way round. A UK (or Irish)
// site reads every word and behaves exactly as before: each helper gives today's text for it.
//
// PURE: no browser imports, so node --test drives it (usUnitsBatch7.test.js).
//
//   isUsSite(currency)                       true for a USD site
//   stockTaxWords(currency)                  the tax words of one site ('VAT' / 'tax', 'ex VAT' / 'before tax' ...)
//   purchaseRateDec(currency, rate)          the rate that comes off a purchase price: 0 at a US site
//   unitPickList(currency, dbCodes)          the units a picker offers, and whether the US ones wait on the database
//   stockPlaceholders(currency)              the example words in empty boxes
//
// PURCHASE TAX AT A US SITE: a US venue usually cannot claim back the sales tax it pays on a
// purchase, so it stays IN the cost. The price entered is the price paid, the venue's SALES tax
// rates are never offered as purchase rates, and no rate is taken off a price.

import { regionOf } from '../../../supabase/functions/_shared/regionPack.js';
import { taxWord } from '../ownerBasis.js';
import { UNITS, US_UNITS } from './units.js';

/** True when the site's currency makes it a US site. */
export const isUsSite = (currency) => regionOf(currency) === 'US';

const UK_WORDS = Object.freeze({
  tax: 'VAT',
  exTax: 'ex VAT',
  incTax: 'inc VAT',
  noTax: 'No VAT',
  withTax: 'With VAT',
  purchaseTax: 'Purchase VAT',
  purchaseTaxLong: 'Purchase VAT (input tax)',
  noPurchaseTax: 'No VAT / zero-rated',
  taxIn: '(VAT in)',
  priceIncludes: 'The price includes VAT',
  keptInCost: false,
});

const US_WORDS = Object.freeze({
  tax: 'tax',
  exTax: 'before tax',
  incTax: 'with tax',
  noTax: 'No tax',
  withTax: 'With tax',
  purchaseTax: 'Sales tax paid',
  purchaseTaxLong: 'Sales tax paid',
  noPurchaseTax: 'None: the price you enter is what you pay',
  taxIn: '(tax in)',
  priceIncludes: 'The price includes tax',
  keptInCost: true,
});

/**
 * The tax words of one site. tax is ownerBasis.taxWord ('VAT' for a pound or euro site, 'tax' for a
 * dollar one); Tax is the same with a capital, for a heading. keptInCost: the purchase tax stays in
 * the cost (a US site).
 */
export function stockTaxWords(currency) {
  const w = taxWord(currency) === 'tax' ? US_WORDS : UK_WORDS;
  return Object.freeze({ ...w, Tax: w.tax === 'tax' ? 'Tax' : 'VAT' });
}

/** The purchase rate that comes off a price entered with tax in: the rate itself, 0 at a US site. */
export function purchaseRateDec(currency, rate) {
  if (isUsSite(currency)) return 0;
  const r = Number(rate);
  return Number.isFinite(r) ? r : 0;
}

/** The hint under the purchase tax field, per site. */
export function purchaseTaxHint(currency, { long = false } = {}) {
  if (isUsSite(currency)) return 'The sales tax you pay when you buy it stays in the cost (a US venue usually cannot claim it back). Enter the price you pay, tax included.';
  return long
    ? 'The VAT you pay on this item when you buy it (e.g. 20% on alcohol). Cost & GP always use the ex-VAT price; this drives VAT on POs/invoices and your input-VAT reclaim.'
    : 'The VAT you pay when you buy it. Cost and GP always use the price without VAT.';
}

const DIM_ORDER = ['COUNT', 'WEIGHT', 'VOLUME'];
const US_CODES = Object.keys(US_UNITS);
const UK_LIST = Object.freeze(Object.entries(UNITS).map(([code, u]) => Object.freeze({ code, ...u })));

/** True when the database's stock_units list holds every US unit (20261120c run). */
export function dbHasUsUnits(dbCodes) {
  if (!dbCodes) return false;
  const has = (c) => (dbCodes instanceof Set ? dbCodes.has(c) : Array.isArray(dbCodes) && dbCodes.includes(c));
  return US_CODES.every(has);
}

/**
 * The units a picker offers: [{ code, dimension, toCanonical, label }] in order, plus usPending
 * (a US site whose database does not hold the US units yet: the picker then says
 * 'US units need a database update' and offers the UK set, as today).
 *  - a UK site: the UK set of 13, exactly as the pickers listed UNITS before;
 *  - a US site with the units in the database: counts and weights as before, then the US volume
 *    units first, then millilitre, centilitre and litre, then the UK imperial ones (labelled (UK)).
 */
export function unitPickList(currency, dbCodes = null) {
  if (!isUsSite(currency)) return { list: UK_LIST, usPending: false };
  if (!dbHasUsUnits(dbCodes)) return { list: UK_LIST, usPending: true };
  const us = US_CODES.map((code) => Object.freeze({ code, ...US_UNITS[code] }));
  const list = [];
  for (const dim of DIM_ORDER) {
    if (dim !== 'VOLUME') { list.push(...UK_LIST.filter((u) => u.dimension === dim)); continue; }
    list.push(...us);
    list.push(...UK_LIST.filter((u) => u.dimension === 'VOLUME' && ['ml', 'cl', 'l'].includes(u.code)));
    list.push(...UK_LIST.filter((u) => u.dimension === 'VOLUME' && !['ml', 'cl', 'l'].includes(u.code)));
  }
  return { list: Object.freeze(list), usPending: false };
}

/** The words a picker shows when the US units wait on the database. */
export const US_UNITS_PENDING = 'US units need a database update';

/** The example words in empty boxes, per site. */
export function stockPlaceholders(currency) {
  const us = isUsSite(currency);
  return Object.freeze({
    supplierEmail: us ? 'orders@supplier.com' : 'orders@supplier.co.uk',
    glass: us ? '6 fl oz glass' : '175ml glass',
    bigEvent: us ? 'Big game on TV' : 'Football on the big screen',
    dryStore: us ? 'Dry storage' : 'Dry store',
    tillProduct: us ? 'POS item' : 'Till product',
  });
}
