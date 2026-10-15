// supabase/functions/_shared/xeroGaps.js
//
// XERO NEVER SKIPS A DAY QUIETLY (8 Oct 2026, the VAT audit, plan Fix 4 and decision D5).
//
// Coffee Boy Leeds business day 30 Sep 2026 (143 sales, 850.28 of net sales, 141.58 of VAT) was
// never posted to Xero. Auto posting was off that day; 29 Sep and 1 Oct were pushed by hand on
// 2 Oct, 30 Sep was not, and nothing in the system noticed: the hourly job only ever looks at the
// last completed business day, and the Postings tab painted the missing day grey "Not posted",
// the same as a quiet Sunday.
//
// D5 (the coordinator's call): the auto run does NOT post missed days by itself. A day somebody
// keyed into Xero by hand would be posted twice. Instead this GAP SCAN looks at the last 14
// business days of each site on the sales invoice model, finds the days that had sales and no
// ok posting, shows them on the Back Office Xero Postings tab in red with a Push button per day,
// and when a gap is older than two days writes one plain notice to the venue's messages (which
// Company Admin also lists). Nothing posts without a person.
//
// This file is the rule, with no database in it (xeroGapScan.ts does the reads and the writes;
// xero-config answers the Postings tab; xero-sales runs the scan on every hourly auto run).
// PURE: imports businessDay.js (pure) and xeroInvoicePlan.js's dayModel (pure).

import { addDays, isYmd } from './businessDay.js';
import { dayModel } from './xeroInvoicePlan.js';
import { stableUuid } from './stableId.js';

/** How many completed business days the scan looks back over. */
export const GAP_SCAN_DAYS = 14;
/** A gap this many days old (or older) gets a notice to the venue and the admin. */
export const GAP_NOTICE_AFTER_DAYS = 2;

/** Whole days from `from` to `to` (both YYYY-MM-DD); negative when `to` is earlier. */
export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

/**
 * The gap days of one site.
 *   lastCompletedDay  the site's last completed business day (YYYY-MM-DD)
 *   postMode, invoiceStartDate  xero_config.post_mode and mapping.invoiceStartDate
 *   logRows           xero_sync_log rows of kind daily_sales: [{ ref_date, status }]
 *   salesByDay        { [ymd]: { count, gross } } sales that closed in each business day
 *                     (voided rows and £0 rows left out)
 *   days              how many completed days to look at (GAP_SCAN_DAYS)
 * A gap is a completed business day on the SALES INVOICE model (dayModel, from the site's
 * start day) that had sales and has no row with status ok. A row that failed or was blocked is
 * still a gap (nothing is in Xero), but it says so (`logStatus`), so the Postings tab keeps
 * its own red Failed or Blocked label and the Push button. Returns oldest first:
 *   [{ date, sales, gross, ageDays, logStatus, notice }]
 * where ageDays is how many days have passed since the day ended (lastCompletedDay is 0) and
 * `notice` is true once ageDays reaches GAP_NOTICE_AFTER_DAYS.
 */
export function findXeroGaps({ lastCompletedDay, postMode, invoiceStartDate = null, logRows = [], salesByDay = {}, days = GAP_SCAN_DAYS }) {
  if (!isYmd(lastCompletedDay)) return [];
  const n = Math.max(1, Math.min(60, Math.round(Number(days) || GAP_SCAN_DAYS)));
  const byDate = new Map();
  for (const r of Array.isArray(logRows) ? logRows : []) {
    if (!r || !isYmd(r.ref_date)) continue;
    const prev = byDate.get(r.ref_date);
    // ok beats everything else; the newest of the rest stands
    if (!prev || r.status === 'ok') byDate.set(r.ref_date, r);
  }
  const out = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const date = addDays(lastCompletedDay, -i);
    if (dayModel(null, postMode, invoiceStartDate, date) !== 'sales_invoice') continue;
    const sales = salesByDay?.[date];
    const count = Number(sales?.count) || 0;
    if (!(count > 0)) continue;
    const row = byDate.get(date);
    if (row && row.status === 'ok') continue;
    const ageDays = daysBetween(date, lastCompletedDay);
    out.push({ date, sales: count, gross: Math.round((Number(sales?.gross) || 0) * 100) / 100, ageDays, logStatus: row ? String(row.status || '') : null, notice: ageDays >= GAP_NOTICE_AFTER_DAYS });
  }
  return out;
}

/**
 * Sales per business day from closed_checks rows (id, closed_at, total, status, voided):
 * { [ymd]: { count, gross } }. Voided rows and rows with no money count for nothing. `dayOf`
 * is the venue's business day of an instant (businessDay.businessDayOf bound to its clock).
 */
export function salesByBusinessDay(rows, dayOf) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r) continue;
    if (r.voided === true || /^void/i.test(String(r.status || ''))) continue;
    const total = Number(r.total) || 0;
    if (!(total > 0)) continue;
    const ms = Date.parse(r.closed_at);
    if (!Number.isFinite(ms)) continue;
    const d = dayOf(ms);
    if (!d) continue;
    const e = out[d] || (out[d] = { count: 0, gross: 0 });
    e.count += 1;
    e.gross += total;
  }
  for (const e of Object.values(out)) e.gross = Math.round(e.gross * 100) / 100;
  return out;
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The day as the notice says it: "Wed 30 Sep 2026" (spelt here, so Node and Deno agree). */
export function gapDayWords(ymd) {
  if (!isYmd(ymd)) return String(ymd || '');
  const d = new Date(`${ymd}T12:00:00Z`);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * The notice for one gap day, as the venue and Company Admin read it. Short, plain, no dashes.
 *   { title, body, kind }
 */
export function gapNotice({ siteName, gap, currency = 'GBP' }) {
  const site = String(siteName || 'This site').trim() || 'This site';
  const sym = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '£';
  const n = gap.sales === 1 ? '1 sale' : `${gap.sales} sales`;
  return {
    kind: 'info',
    title: 'Xero: a day is not posted',
    body: `${site}: the sales of ${gapDayWords(gap.date)} are not in Xero. ${n}, ${sym}${gap.gross.toFixed(2)}. Open Back Office, Xero, Postings and press Push on that day. Nothing posts by itself. If the day was keyed into Xero by hand, press Push anyway: ServOS checks before it sends.`,
  };
}

/**
 * One id for one notice (a site and a day), the same every time it is worked out, so a notice
 * is written once however many scans run (venue_messages is unique on broadcast_id and venue).
 */
export function gapNoticeId(locationId, date) {
  return stableUuid(`xero-gap|${locationId}|${date}`);
}

/**
 * The Postings tab rows with the gaps marked (8 Oct 2026): a day with sales and no ok posting
 * is 'missing' (red "Not posted", with a Push button); a 'waiting' day with no sales is
 * 'quiet' (grey "Nothing to post"). A gap day with no history row at all is added. Rows that
 * failed or were blocked keep their own status. Sorted newest first, then by site.
 *   rows  the history action's rows [{ date, locationId, site, status, ... }]
 *   gaps  { [locationId]: [{ date, sales, gross, ageDays }] }
 */
export function markGaps(rows, gaps) {
  const gapAt = new Map();
  for (const [locationId, list] of Object.entries(gaps || {})) for (const g of list || []) gapAt.set(`${locationId}|${g.date}`, g);
  const out = (Array.isArray(rows) ? rows : []).map((r) => {
    const g = gapAt.get(`${r.locationId}|${r.date}`);
    if (r.status === 'waiting') return { ...r, status: g ? 'missing' : 'quiet', ...(g ? { gap: g } : {}) };
    return g ? { ...r, gap: g } : r;
  });
  const seen = new Set(out.map((r) => `${r.locationId}|${r.date}`));
  for (const [key, g] of gapAt) {
    if (seen.has(key)) continue;
    const [locationId] = key.split('|');
    out.push({ date: g.date, locationId, site: g.site || '', model: 'sales_invoice', status: 'missing', documents: [], totals: { sales: g.gross, refunds: null, vat: null }, warnings: 0, error: null, notReady: null, updatedAt: null, gap: g });
  }
  out.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.site).localeCompare(String(b.site)));
  return out;
}
