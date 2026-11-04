/**
 * venueDate.js: dates and times in the venue's words and timezone. v5.11.65: the body lives in
 * supabase/functions/_shared/venueDate.js so po-send (the supplier email) and the browser share
 * one copy; this file re-exports it. Pure, so Node's test runner loads it too.
 *
 * 5.12.57 (US basics batch 8): the formatters read the active venue's words (the currency the
 * location loader set): a US venue reads 'Oct 16, 2026' and '2:05 PM', a UK venue exactly as before.
 * A caller that knows the venue passes it (opts.venue, or the last argument).
 */
import { getActiveCurrencyCode } from './currency.js';
import * as vd from '../../supabase/functions/_shared/venueDate.js';

export * from '../../supabase/functions/_shared/venueDate.js';

const V = (venue) => venue ?? getActiveCurrencyCode();

export const fmtYmd = (ymd, opts = {}) => vd.fmtYmd(ymd, { ...(opts || {}), venue: V(opts?.venue) });
export const fmtVenueDate = (ts, tz, opts = {}) => vd.fmtVenueDate(ts, tz, { ...(opts || {}), venue: V(opts?.venue) });
export const fmtVenueDateTime = (ts, tz, opts = {}) => vd.fmtVenueDateTime(ts, tz, { ...(opts || {}), venue: V(opts?.venue) });
export const fmtVenueTime = (ts, tz, venue) => vd.fmtVenueTime(ts, tz, V(venue));
export const countName = (ts, tz, countType = 'FULL', storageArea = null, venue) => vd.countName(ts, tz, countType, storageArea, V(venue));
