// supabase/functions/_shared/accountingData.ts
//
// The database reads behind a day of accounting (Xero now, QuickBooks next). Kept apart from
// the pure rules (businessDay.js, accountingDay.js) so those stay testable under `npm test`.
//
//   venueClock(platform, opsLocationId)   the venue's zone, business day start and currency
//   loadAccountingDay(ops, platform, id, ymd)  -> { venue, day, summary }
//
// Reads are PAGED: PostgREST returns at most 1000 rows per request, and until v5.9.11
// xero-sales read one unpaged request, so a venue with more than 1000 checks in a day
// silently posted a short day.

import { businessDayWindow, venueZone, DEFAULT_DAY_START } from './businessDay.js';
import { buildAccountingDay } from './accountingDay.js';

const PAGE = 1000;
// How far back a refunded check can have closed and still have a refund dated today.
const REFUND_LOOKBACK_DAYS = 400;

const BASE_COLS = 'id,closed_at,total,subtotal,tip,service,tax_amount,method,payment_method,status,voided,refunds,gift_card,payment_intents,processor,source,loyalty';
// Newer columns: read when the database has them. tenders arrives with migration 20260919n;
// promo (the kiosk's promo credit) is missing on a venue database that never got it.
const OPTIONAL_COLS = ['tenders', 'promo'];

export type VenueClock = { timezone: string; dayStart: string; currency: string; found: boolean };

/**
 * The venue's own clock, from the PLATFORM locations row (authoritative for timezone and
 * currency; business_day_start is the setting the Back Office sales reports use). Resolved by
 * ops_location_id first, then by id (legacy rows), never with limit(1). Throws when the read
 * itself fails, so no money is ever booked on a guessed clock.
 */
export async function venueClock(platform: any, opsLocationId: string): Promise<VenueClock> {
  const cols = 'id,timezone,business_day_start,currency';
  let row: any = null;
  const r1 = await platform.from('locations').select(cols).eq('ops_location_id', opsLocationId).maybeSingle();
  if (r1.error) throw new Error(`Could not read the venue's time zone: ${r1.error.message}`);
  row = r1.data;
  if (!row) {
    const r2 = await platform.from('locations').select(cols).eq('id', opsLocationId).maybeSingle();
    if (r2.error) throw new Error(`Could not read the venue's time zone: ${r2.error.message}`);
    row = r2.data;
  }
  return {
    timezone: venueZone(row?.timezone),
    dayStart: row?.business_day_start || DEFAULT_DAY_START,
    currency: String(row?.currency || 'GBP').toUpperCase(),
    found: !!row,
  };
}

// The optional column PostgREST says does not exist, or null.
const missingOptional = (err: any): string | null => {
  if (!err || (err.code !== '42703' && err.code !== 'PGRST204')) return null;
  const msg = String(err.message || '');
  return OPTIONAL_COLS.find((c) => new RegExp(`\\b${c}\\b`).test(msg)) || null;
};

const _missingUntil = new Map<string, number>();

/** Page through closed_checks with `build(query)` adding the filters. Optional columns are read when they exist. */
async function pagedChecks(ops: any, build: (q: any) => any): Promise<any[]> {
  const out: any[] = [];
  const now = Date.now();
  const optional = OPTIONAL_COLS.filter((c) => !((_missingUntil.get(c) || 0) > now));
  const cols = () => [BASE_COLS, ...optional].join(',');
  for (let from = 0; ; from += PAGE) {
    let { data, error } = await build(ops.from('closed_checks').select(cols())).order('closed_at').order('id').range(from, from + PAGE - 1);
    for (let n = 0; error && n < OPTIONAL_COLS.length; n++) {
      const col = missingOptional(error);
      if (!col || !optional.includes(col)) break;
      optional.splice(optional.indexOf(col), 1);
      _missingUntil.set(col, Date.now() + 10 * 60 * 1000);
      ({ data, error } = await build(ops.from('closed_checks').select(cols())).order('closed_at').order('id').range(from, from + PAGE - 1));
    }
    if (error) throw new Error(`Could not read closed checks: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/** Checks that closed inside the window. */
export function salesRows(ops: any, locationId: string, fromIso: string, toIso: string) {
  return pagedChecks(ops, (q) => q.eq('location_id', locationId).gte('closed_at', fromIso).lt('closed_at', toIso));
}

/** Checks carrying any refund, closed before the window ended (their refunds are filtered by refund time). */
export function refundRows(ops: any, locationId: string, fromIso: string, toIso: string) {
  const since = new Date(Date.parse(fromIso) - REFUND_LOOKBACK_DAYS * 86400000).toISOString();
  return pagedChecks(ops, (q) => q.eq('location_id', locationId).gte('closed_at', since).lt('closed_at', toIso).neq('refunds', '[]'));
}

/**
 * One venue business day, read and summed. `venue` may be passed in when already known.
 * `fromMs` moves the start of the window (only the hand over from the old UTC days uses it:
 * xero-sales starts the first business day where the last UTC day posted ended).
 */
export async function loadAccountingDay(ops: any, platform: any, locationId: string, ymd: string, venue?: VenueClock, opts: { fromMs?: number | null } = {}) {
  const v = venue || await venueClock(platform, locationId);
  let day = businessDayWindow(ymd, v.timezone, v.dayStart);
  if (opts.fromMs != null && Number.isFinite(opts.fromMs) && opts.fromMs < day.toMs) {
    day = { ...day, fromMs: opts.fromMs, fromIso: new Date(opts.fromMs).toISOString() };
  }
  const [sale, refund] = await Promise.all([
    salesRows(ops, locationId, day.fromIso, day.toIso),
    refundRows(ops, locationId, day.fromIso, day.toIso),
  ]);
  const summary = buildAccountingDay({ day, saleRows: sale, refundRows: refund, venue: v });
  return { venue: v, day, summary };
}
