// supabase/functions/_shared/accountingData.ts
//
// The database reads behind a day of accounting (Xero now, QuickBooks next). Kept apart from
// the pure rules (businessDay.js, accountingDay.js) so those stay testable under `npm test`.
//
//   venueClock(platform, opsLocationId)   the venue's zone, business day start and currency
//   venueTaxRates(ops, opsLocationId)      the venue's tax_rates rows (28 Sep 2026)
//   loadAccountingDay(ops, platform, id, ymd)  -> { venue, day, summary, taxRates }
//   venueSite(platform, opsLocationId)     the venue's name, online slug and company (30 Sep 2026)
//   venueCategories(ops, id, rows)         menu categories for sales groups (30 Sep 2026)
//
// Reads are PAGED: PostgREST returns at most 1000 rows per request, and until v5.9.11
// xero-sales read one unpaged request, so a venue with more than 1000 checks in a day
// silently posted a short day.

import { businessDayWindow, venueZone, DEFAULT_DAY_START } from './businessDay.js';
import { buildAccountingDay } from './accountingDay.js';

const PAGE = 1000;
// How far back a refunded check can have closed and still have a refund dated today.
const REFUND_LOOKBACK_DAYS = 400;

// tax_breakdown (28 Sep 2026): the per rate VAT a till close saved, for one Xero line per rate.
const BASE_COLS = 'id,closed_at,total,subtotal,tip,service,tax_amount,tax_breakdown,method,payment_method,status,voided,refunds,gift_card,payment_intents,processor,source,loyalty';
// Newer columns: read when the database has them. tenders arrives with migration 20260919n;
// promo (the kiosk's promo credit) is missing on a venue database that never got it.
const OPTIONAL_COLS = ['tenders', 'promo'];
// The daily sales invoice (30 Sep 2026) also reads what was sold: items (category, price, tax
// rate) and the check's discounts, to post by sales group and discount group.
const ITEM_COLS = 'items,discounts';

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
async function pagedChecks(ops: any, build: (q: any) => any, withItems = false): Promise<any[]> {
  const out: any[] = [];
  const now = Date.now();
  const optional = OPTIONAL_COLS.filter((c) => !((_missingUntil.get(c) || 0) > now));
  const cols = () => [BASE_COLS, ...(withItems ? [ITEM_COLS] : []), ...optional].join(',');
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
export function salesRows(ops: any, locationId: string, fromIso: string, toIso: string, withItems = false) {
  return pagedChecks(ops, (q) => q.eq('location_id', locationId).gte('closed_at', fromIso).lt('closed_at', toIso), withItems);
}

/** Checks carrying any refund, closed before the window ended (their refunds are filtered by refund time). */
export function refundRows(ops: any, locationId: string, fromIso: string, toIso: string, withItems = false) {
  const since = new Date(Date.parse(fromIso) - REFUND_LOOKBACK_DAYS * 86400000).toISOString();
  return pagedChecks(ops, (q) => q.eq('location_id', locationId).gte('closed_at', since).lt('closed_at', toIso).neq('refunds', '[]'), withItems);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The venue's tax rates, inactive ones included (older checks point at them), so each sale can
 * post at its own VAT rate. [] for a location id that is not a uuid (tax_rates.location_id is
 * one; a demo id would fail the read). Throws when the read fails: no VAT is booked on a guess.
 */
export async function venueTaxRates(ops: any, locationId: string): Promise<any[]> {
  if (!UUID.test(String(locationId || ''))) return [];
  const { data, error } = await ops.from('tax_rates').select('id,name,code,rate,type,is_default,active').eq('location_id', locationId);
  if (error) throw new Error(`Could not read the venue's tax rates: ${error.message}`);
  return data || [];
}

/**
 * One venue business day, read and summed. `venue` may be passed in when already known.
 * `fromMs` moves the start of the window (only the hand over from the old UTC days uses it:
 * xero-sales starts the first business day where the last UTC day posted ended).
 * 30 Sep 2026, additive: `withItems` also reads items and discounts, and `keepRows` returns the
 * rows read ({ rows: { sale, refund } }) for the daily sales invoice's groups.
 */
export async function loadAccountingDay(ops: any, platform: any, locationId: string, ymd: string, venue?: VenueClock, opts: { fromMs?: number | null; withItems?: boolean; keepRows?: boolean } = {}) {
  const v = venue || await venueClock(platform, locationId);
  let day = businessDayWindow(ymd, v.timezone, v.dayStart);
  if (opts.fromMs != null && Number.isFinite(opts.fromMs) && opts.fromMs < day.toMs) {
    day = { ...day, fromMs: opts.fromMs, fromIso: new Date(opts.fromMs).toISOString() };
  }
  const [sale, refund, taxRates] = await Promise.all([
    salesRows(ops, locationId, day.fromIso, day.toIso, !!opts.withItems),
    refundRows(ops, locationId, day.fromIso, day.toIso, !!opts.withItems),
    venueTaxRates(ops, locationId),
  ]);
  const summary = buildAccountingDay({ day, saleRows: sale, refundRows: refund, venue: v, taxRates });
  return { venue: v, day, summary, taxRates, ...(opts.keepRows ? { rows: { sale, refund } } : {}) };
}

export type VenueSite = { name: string; onlineSlug: string | null; companyId: string | null; platformId: string | null; found: boolean };

/**
 * The venue's name, online slug and company from the PLATFORM locations row (30 Sep 2026: the
 * site's name goes into every Xero reference, and the slug suggests its invoice code). Throws
 * when the read itself fails, so nothing is posted under a guessed name.
 */
export async function venueSite(platform: any, opsLocationId: string): Promise<VenueSite> {
  const cols = 'id,name,online_slug,company_id';
  const r1 = await platform.from('locations').select(cols).eq('ops_location_id', opsLocationId).maybeSingle();
  if (r1.error) throw new Error(`Could not read the venue's name: ${r1.error.message}`);
  let row = r1.data;
  if (!row) {
    const r2 = await platform.from('locations').select(cols).eq('id', opsLocationId).maybeSingle();
    if (r2.error) throw new Error(`Could not read the venue's name: ${r2.error.message}`);
    row = r2.data;
  }
  return { name: String(row?.name || ''), onlineSlug: row?.online_slug || null, companyId: row?.company_id || null, platformId: row?.id || null, found: !!row };
}

/**
 * The menu categories the day's items point at: this venue's own (local true) plus any other
 * venue's id seen on a check (a shared menu), so each resolves through master_id to the local
 * copy. Throws when the read fails: sales would otherwise all fall to Other sales.
 */
export async function venueCategories(ops: any, locationId: string, rows: any[] = []): Promise<any[]> {
  const cols = 'id,parent_id,label,accounting_group,master_id';
  const { data, error } = await ops.from('menu_categories').select(cols).eq('location_id', locationId).limit(5000);
  if (error) throw new Error(`Could not read the menu categories: ${error.message}`);
  const local = (data || []).map((c: any) => ({ ...c, local: true }));
  const known = new Set(local.map((c: any) => String(c.id)));
  const foreign = new Set<string>();
  for (const r of rows || []) {
    const lists = [r?.items, ...((Array.isArray(r?.refunds) ? r.refunds : []).map((e: any) => e?.items))];
    for (const list of lists) for (const it of (Array.isArray(list) ? list : [])) {
      const id = it?.cat || (Array.isArray(it?.cats) ? it.cats[0] : null);
      if (id && !known.has(String(id))) foreign.add(String(id));
    }
  }
  if (!foreign.size) return local;
  const ids = [...foreign].slice(0, 500);
  const { data: more, error: e2 } = await ops.from('menu_categories').select(cols).in('id', ids);
  if (e2) throw new Error(`Could not read the menu categories: ${e2.message}`);
  return [...local, ...(more || []).map((c: any) => ({ ...c, local: false }))];
}
