// src/lib/taxWords.js
//
// 5.12.57 (US basics, batch 6: tax): the tax words in the browser. The rules live in
// supabase/functions/_shared/taxWords.js (one copy for the app and the edge functions); this file
// adds the venue the Back Office is on right now, read from the active currency, as
// lib/regionPack.js activeRegionPack does.

import { getActiveCurrencyCode } from './currency.js';
import { taxWords, taxText } from '../../supabase/functions/_shared/taxWords.js';

export { taxWords, taxWord, mixedTaxWords, taxText } from '../../supabase/functions/_shared/taxWords.js';

/** The tax words for the venue this screen is on. */
export function activeTaxWords() {
  return taxWords(getActiveCurrencyCode());
}

/** A line kept in the UK words, read for the venue this screen is on (unchanged at a UK venue). */
export function activeTaxText(text, opts) {
  return taxText(text, getActiveCurrencyCode(), opts);
}
