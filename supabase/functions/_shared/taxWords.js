// supabase/functions/_shared/taxWords.js
//
// 5.12.57 (US basics, batch 6: tax): THE ONE HELPER for what a venue calls its tax. A UK or Irish
// venue says VAT (prices include it); a US venue says tax or sales tax (it is added on top of the
// price). HMRC is the UK's tax office, so only a UK venue ever reads it. The venue's country comes
// from regionPack.regionOf (a country field, else the currency: USD is the US, GBP the UK, EUR
// Ireland, nothing at all the UK), so the words follow the venue exactly as the money does.
//
// Every screen and report line that names the tax reads it from here (src/lib/ownerBasis.js
// taxWord, src/lib/taxWords.js activeTaxWords for the Back Office's own venue). A UK venue's words
// are exactly the words every screen used before, so UK screens do not change by a byte.
// PURE: imports only regionPack.js (which imports nothing); node --test and the edge functions
// load it as it is.

import { regionOf } from './regionPack.js';

/**
 * The tax words for a venue (a row with country/currency, or a currency code).
 *   us      true at a US venue: the tax is added on top, there is no VAT and no HMRC
 *   uk      true at a UK venue: HMRC may be named
 *   tax     'VAT' | 'tax'          mid sentence ("no VAT recorded", "no tax recorded")
 *   Tax     'VAT' | 'Tax'          a heading or the start of a sentence
 *   sales   'VAT' | 'sales tax'    where the kind of tax is named ("record no sales tax")
 *   Sales   'VAT' | 'Sales tax'
 *   exTax   'ex VAT' | 'before tax'
 *   incTax  'inc VAT' | 'with tax'
 */
export function taxWords(venue) {
  const country = regionOf(venue);
  const us = country === 'US';
  return Object.freeze({
    country, us, uk: country === 'UK',
    tax: us ? 'tax' : 'VAT',
    Tax: us ? 'Tax' : 'VAT',
    sales: us ? 'sales tax' : 'VAT',
    Sales: us ? 'Sales tax' : 'VAT',
    exTax: us ? 'before tax' : 'ex VAT',
    incTax: us ? 'with tax' : 'inc VAT',
  });
}

/** The tax word alone: 'VAT' at a pound or euro venue, 'tax' at a dollar one. */
export const taxWord = (venue) => taxWords(venue).tax;

/**
 * A line written in the UK words, read for a venue. At a UK or Irish venue it is returned exactly
 * as it is (byte for byte). At a US venue: 'ex VAT' / 'ex-VAT' become 'before tax', 'inc VAT'
 * becomes 'with tax', 'Tax & VAT' becomes 'Tax', and 'VAT' becomes 'Tax' at the start of a line,
 * a sentence or a bracket and 'tax' elsewhere. A rate code such as VAT20 is a name, left alone.
 * `mid` true: a word that sits inside a sentence (a column name), so 'VAT rate' is 'tax rate'.
 * For screens whose words are kept as UK constants (the multi site menu): the constant stays
 * what the tests pin, the screen reads it through this.
 */
export function taxText(text, venue, { mid = false } = {}) {
  if (typeof text !== 'string' || !taxWords(venue).us) return text;
  const out = text
    .replace(/Tax (?:&|&amp;|and) VAT/g, 'Tax')
    .replace(/\bex[- ]VAT\b/g, 'before tax')
    .replace(/\binc(?:l\.?|luding)?[- ]VAT\b/g, 'with tax')
    .replace(mid ? /([.!?:]\s+|\(|\n)VAT\b/g : /(^|[.!?:]\s+|\(|\n)VAT\b/g, (m, lead) => `${lead}Tax`)
    .replace(/\bVAT\b/g, 'tax');
  return out;
}

/**
 * The word for a screen that mixes venues: the shared word when every venue says the same, else
 * the neutral 'tax'. `venues` is a list of rows or currency codes.
 */
export function mixedTaxWords(venues) {
  const list = (Array.isArray(venues) ? venues : []).map((v) => taxWords(v));
  if (!list.length) return taxWords(null);
  const first = list[0];
  if (list.every((w) => w.country === first.country)) return first;
  if (list.every((w) => !w.us)) return taxWords('EUR');   // UK and Irish: VAT, no HMRC
  return taxWords('USD');                                   // a US venue among them: the neutral tax
}
