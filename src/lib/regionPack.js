// src/lib/regionPack.js
//
// v5.11.101: the region pack in the browser. The rules live in
// supabase/functions/_shared/regionPack.js (one copy for the app and the edge functions); this
// file adds the venue the Back Office is on right now, read from the active currency, which the
// location loader sets from the venue's own row (lib/locationTime.js setActiveCurrency). No switch:
// the pack follows the venue, as the currency does.

import { getActiveCurrencyCode } from './currency';
import { regionPack, regionOf, toE164 as toE164For, wfMoneyText, fmtDateNumeric } from '../../supabase/functions/_shared/regionPack.js';

export { regionPack, regionOf, DOC_INFO, docLabel, payPeriodAllowed, fmtDateNumeric, wfMoneyText } from '../../supabase/functions/_shared/regionPack.js';

/** The pack for the venue this screen is on. */
export function activeRegionPack() {
  return regionPack(getActiveCurrencyCode());
}

/** The active venue's country ('UK' | 'US' | 'IE'). */
export function activeCountry() {
  return regionOf(getActiveCurrencyCode());
}

/** A phone number in E.164, read with the active venue's country unless one is given. */
export function toE164(raw, countryCodeOrVenue) {
  return toE164For(raw, countryCodeOrVenue ?? getActiveCurrencyCode());
}

/** Workforce money for the active venue: "£1,234" for a UK venue (as before), "$1,234" for a US one. */
export function venueMoney(n, dp = 0) {
  return wfMoneyText(n, dp, getActiveCurrencyCode());
}

/** A numeric date for the active venue: 24/10/2026 (UK) or 10/24/2026 (US). */
export function venueDate(iso) {
  return fmtDateNumeric(iso, getActiveCurrencyCode());
}
