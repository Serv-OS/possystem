// supabase/functions/_shared/xeroGapScan.ts
//
// The gap scan's reads and writes (8 Oct 2026, plan Fix 4, decision D5). The rule is in
// xeroGaps.js (pure); this file reads the site's clock, posting model, sync log and sales, and
// writes the notice for a gap older than two days. Used by xero-config (action 'gaps', the
// Postings tab) and by xero-sales on every hourly auto run, so a skipped day is noticed even when
// nobody opens Back Office. Nothing here posts anything to Xero.

import { venueClock } from './accountingData.ts';
import { pagedRows } from './pagedRows.js';
import { businessDayWindow, businessDayOf, lastCompletedBusinessDay, addDays } from './businessDay.js';
import { findXeroGaps, salesByBusinessDay, gapNotice, gapNoticeId, GAP_SCAN_DAYS } from './xeroGaps.js';

export type XeroGap = { date: string; sales: number; gross: number; ageDays: number; logStatus: string | null; notice: boolean };

/**
 * The gap days of one site over its last `days` completed business days: { gaps, venue, lastCompletedDay }.
 * `venue` may be passed in when already known (xero-sales has it). Throws when a read fails: a
 * gap list is never guessed.
 */
export async function scanXeroGaps(sb: any, platform: any, locationId: string, opts: { days?: number; now?: number; venue?: any } = {}): Promise<{ gaps: XeroGap[]; venue: any; lastCompletedDay: string; postMode: string | null }> {
  const now = opts.now ?? Date.now();
  const days = Math.max(1, Math.min(60, opts.days || GAP_SCAN_DAYS));
  const venue = opts.venue || await venueClock(platform, locationId);
  const lastCompletedDay = lastCompletedBusinessDay(now, venue.timezone, venue.dayStart);
  const firstDay = addDays(lastCompletedDay, -(days - 1));
  const { data: cfg, error: cfgErr } = await sb.from('xero_config').select('post_mode,mapping').eq('location_id', locationId).maybeSingle();
  if (cfgErr) throw new Error(`Could not read the Xero setup: ${cfgErr.message}`);
  const postMode = cfg?.post_mode || null;
  // A site that does not post sales invoices has no gap to scan (D5: the invoice model only).
  if (postMode !== 'sales_invoice') return { gaps: [], venue, lastCompletedDay, postMode };
  const span = { from: businessDayWindow(firstDay, venue.timezone, venue.dayStart).fromIso, to: businessDayWindow(lastCompletedDay, venue.timezone, venue.dayStart).toIso };
  const [logRows, saleRows] = await Promise.all([
    pagedRows('xero postings', () => sb.from('xero_sync_log').select('ref_date,status').eq('location_id', locationId).eq('kind', 'daily_sales').gte('ref_date', firstDay).lte('ref_date', lastCompletedDay).order('ref_date').order('id')),
    pagedRows('closed checks', () => sb.from('closed_checks').select('id,closed_at,total,status,voided').eq('location_id', locationId).gte('closed_at', span.from).lt('closed_at', span.to).order('closed_at').order('id')),
  ]);
  const salesByDay = salesByBusinessDay(saleRows, (ms: number) => businessDayOf(ms, venue.timezone, venue.dayStart));
  const gaps = findXeroGaps({ lastCompletedDay, postMode, invoiceStartDate: cfg?.mapping?.invoiceStartDate || null, logRows, salesByDay, days }) as XeroGap[];
  return { gaps, venue, lastCompletedDay, postMode };
}

/**
 * One notice per gap older than two days, to the venue's messages (venue_messages: it pops up
 * in Back Office and Company Admin lists it). Written once per site and day whatever runs the
 * scan (the id is worked out from the site and the day, and the table is unique on it). A
 * venue_messages table that is not there yet (the 20261005a update not run) is not an error:
 * the Postings tab still shows the gap. Returns how many notices were written this time.
 */
export async function noticeXeroGaps(sb: any, locationId: string, siteName: string, gaps: XeroGap[], currency = 'GBP'): Promise<number> {
  const due = (gaps || []).filter((g) => g.notice);
  if (!due.length) return 0;
  const sentAt = new Date().toISOString();
  const rows = due.map((g) => {
    const n = gapNotice({ siteName, gap: g, currency });
    return { broadcast_id: gapNoticeId(locationId, g.date), location_id: locationId, kind: n.kind, title: n.title, body: n.body, sent_by: null, sent_by_name: 'ServOS Xero check', sent_at: sentAt };
  });
  const { data, error } = await sb.from('venue_messages').upsert(rows, { onConflict: 'broadcast_id,location_id', ignoreDuplicates: true }).select('id');
  if (error) {
    if (/venue_messages/.test(String(error.message || '')) && /does not exist|schema cache|not find/i.test(String(error.message || ''))) return 0;
    throw new Error(`Could not write the Xero gap notice: ${error.message}`);
  }
  return (data || []).length;
}
