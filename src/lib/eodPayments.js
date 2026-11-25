/**
 * eodPayments.js: which sales the Close day page counts, and its totals.
 *
 * Coffee Boy Castleford, 25 Nov 2026: "where can we see what is card payment and what is app
 * payments. The end of day report doesn't separate them." Looking into it found the page was
 * counting very little:
 *
 *   1. It asked each sale "were you taken in the open shift?" by the shift stamped on it. The
 *      till writes that stamp, but nothing read it back from the database, so the only sales
 *      that passed were ones made on the same device since it was last reloaded. Opened in
 *      Back Office on another computer, the page showed almost nothing.
 *   2. An order taken away from the tills (online, the app, a kiosk, QR at the table) and a
 *      till sale closed by the card reader route carry no shift stamp at all.
 *   3. The page added up from the till's working list, which holds the newest 500 sales.
 *   4. Cash and Card were added by the sale's method WORD, so an order paid part by card and
 *      part with a loyalty reward was neither, and its whole value (free drink included)
 *      counted as revenue.
 *
 * Now: the shift is a WINDOW (from when it opened), every sale closed in it counts whoever
 * took it, the page reads that window from the database itself, and the totals are the one
 * sales rule's (lib/salesBreakdown.js), the same figures as the Business summary and the Z
 * report.
 *
 * Pure: no React, no store, no database (eodPayments.test.js).
 */
import { salesBreakdown, placeOf } from './salesBreakdown.js';

const ms = (v) => (v == null ? null : typeof v === 'number' ? v : v instanceof Date ? v.getTime() : Number.isFinite(Date.parse(v)) ? Date.parse(v) : null);
const closedMs = (c) => ms(c?.closedAt ?? c?.closed_at);

/**
 * The sales of a shift: every check stamped with it, and every check closed at or after it
 * opened, from both lists (the page's own read of the database, then the till's working list
 * for anything newer). A check in both counts once; the database copy is kept. Voided checks
 * stay in (the breakdown counts them as voids, never as sales).
 */
export function shiftWindowChecks(shift, ...lists) {
  const from = ms(shift?.openedAt ?? shift?.opened_at);
  const id = shift?.id ?? null;
  if (from == null && id == null) return [];
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const c of Array.isArray(list) ? list : []) {
      if (!c) continue;
      const stamped = id != null && (c.shiftId ?? c.shift_id ?? null) === id;
      const at = closedMs(c);
      const inWindow = from != null && at != null && at >= from;
      if (!stamped && !inWindow) continue;
      const key = c.id ?? null;
      if (key != null) { if (seen.has(key)) continue; seen.add(key); }
      out.push(c);
    }
  }
  return out;
}

/** How many of them were taken away from the tills (online, app, kiosk, QR, delivery apps). */
export function awayFromTills(checks) {
  return (Array.isArray(checks) ? checks : []).filter((c) => c && c.status !== 'voided' && placeOf(c) !== 'till').length;
}

/**
 * The page's totals, by the one sales rule. Refunds count when they were made inside the
 * shift. Keys are the ones the page and the stored Z report have always carried:
 *   revenue   money collected (sales after refunds, plus service, tips and gift cards sold)
 *   cash, card, other   the money by what paid it; they add up to revenue
 *   taxes, tips, refunds, covers, checks, taxMissing, taxMissingRefs
 */
export function closeDayTotals(checks, shift, { now = Date.now(), currency = null } = {}) {
  const from = ms(shift?.openedAt ?? shift?.opened_at);
  const range = from != null ? { fromMs: from, toMs: ms(now) } : null;
  const b = salesBreakdown(checks, { range, currency });
  const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
  const other = r2(b.tender_gift_card + b.tender_deposit + b.tender_other + b.tender_unallocated);
  const missing = Array.isArray(b.vatMissing) ? b.vatMissing : [];
  return {
    revenue: r2(b.collected), cash: r2(b.tender_cash), card: r2(b.tender_card), other,
    tips: r2(b.tips), refunds: r2(b.refunds), covers: b.covers || 0, checks: b.count || 0,
    taxes: r2(b.tax), taxMissing: missing.length, taxMissingRefs: missing.slice(0, 12).map((m) => m.ref || m.id),
    sales: r2(b.sales), service: r2(b.service), giftSold: r2(b.giftSold), rewards: r2(b.rewards), voids: b.voidCount || 0,
  };
}
