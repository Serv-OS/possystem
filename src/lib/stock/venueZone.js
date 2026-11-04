// src/lib/stock/venueZone.js
//
// 5.12.57 (US basics batch 8): the zone and the words of the venue the Back Office is on, for the
// pure stock rules (node --test loads them). One copy: the active currency is src/lib/currency.js's
// and the active zone src/lib/venueDates.js's (a UK or Irish venue reads its one zone until the row
// is read; a US venue reads null, so a time reads '' until its own zone is known).

import { getActiveCurrencyCode } from '../currency.js';
import { activeTimezone } from '../venueDates.js';

/** The active venue's currency code ('GBP' when none is saved: node --test, an edge function). */
export const activeVenueCurrency = () => getActiveCurrencyCode();

/** The active venue's time zone: its own once read, else its country's only zone, else null (a US venue). */
export const activeVenueZone = () => activeTimezone();

/** A zone the caller has, or the active venue's (never a fixed other city). */
export const zoneOrActive = (tz) => tz || activeVenueZone();
