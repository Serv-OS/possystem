/**
 * paymentMethodRows.js: the rows of the Back Office Payment methods report.
 *
 * Coffee Boy Castleford, 25 Nov 2026 (Peter: "the 9th has 591.86"). The report filed a whole
 * check under the one word in its method column, so a check paid part by card and part with a
 * free loyalty drink ("loyalty+card") was a row called "? Other", and its card money was left
 * out of Card. On 9 Nov that showed Card 591.86 when the card machine took 603.31, and the
 * report's total counted 41.00 of free drinks as money.
 *
 * The rows now come from THE ONE SALES RULE (src/lib/salesBreakdown.js), the same reading as the
 * Business summary, the X and Z report and the Owner app: one row per kind of money, split by
 * what actually paid. They add up to Money collected. A loyalty reward is never money: it is
 * returned beside the rows, outside the total.
 *
 * Pure: no React, no store. Tested in paymentMethodRows.test.js.
 */
import { TENDER_ORDER, TENDER_WORDS } from './salesBreakdown.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (x) => Math.round(x * 100) / 100;

/** Card and Cash are always named, even at 0, so a quiet day still reads as a full answer. */
export const ALWAYS_SHOWN = Object.freeze(['card', 'cash']);

/** The words for a money kind (Card, Cash, Gift card, Booking deposits, Other, old split bills). */
export function paymentLabel(kind) {
  return TENDER_WORDS[kind] || 'Other';
}

/**
 * The report's rows from a breakdown (salesBreakdown over the checks, or breakdownFromDaySums
 * over the server sums for a long period).
 *   rows     [{ method, revenue, count, tips }]  biggest first; count and tips are 0 when the
 *            breakdown does not know them (the server sums)
 *   total    the money collected: the rows added up
 *   rewards  free loyalty items given (no money), for the note under the rows
 *   checks   how many checks were paid (a check paid two ways is still one)
 */
export function paymentRows(breakdown) {
  const b = breakdown && typeof breakdown === 'object' ? breakdown : {};
  const rows = TENDER_ORDER
    .map((k) => ({ method: k, revenue: num(b[`tender_${k}`]), count: num(b.tenderChecks?.[k]), tips: num(b.tenderTips?.[k]) }))
    .filter((r) => ALWAYS_SHOWN.includes(r.method) || Math.abs(r.revenue) >= 0.005 || r.count > 0)
    .sort((a, c) => c.revenue - a.revenue);
  return { rows, total: r2(rows.reduce((s, r) => s + r.revenue, 0)), rewards: num(b.rewards), checks: num(b.count) };
}
