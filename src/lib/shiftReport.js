// src/lib/shiftReport.js: the X and Z report the till prints (28 Sep 2026).
//
// Peter: "we have a z report but there is nowhere in the POS to actually print it and it doesn't
// print when closing the cash drawer. Really we should have a button that can print a z report
// so staff can check the shift."
//
//   X report: the business day so far, printed on demand; changes nothing.
//   Z report: printed when the drawer is cashed up, with the drawer's expected, counted and
//             variance figures.
//
// The figures are the Back Office Sales summary's own (lib/salesStats.js computeSalesStats), so
// the printout and the screen always agree. Pure: no store, no printer, no clock of its own.

import { computeSalesStats } from './salesStats.js';
import { businessDayOf } from '../../supabase/functions/_shared/businessDay.js';
import { DocBuilder } from './printDoc.js';
import { money } from './currency.js';

/** The checks of the business day that `now` falls in, at the venue's clock and day start. */
export function checksForBusinessDay(checks, { now = Date.now(), timezone, dayStart } = {}) {
  const today = businessDayOf(now, timezone, dayStart);
  if (!today) return [];
  return (Array.isArray(checks) ? checks : []).filter((c) => {
    const at = c?.closedAt ?? c?.closed_at;
    return at != null && businessDayOf(typeof at === 'number' ? at : Date.parse(at), timezone, dayStart) === today;
  });
}

/** Headline figures plus takings by payment method (voided checks left out of the methods). */
export function summariseShift(checks) {
  const list = Array.isArray(checks) ? checks : [];
  const stats = computeSalesStats(list);
  const methods = {};
  for (const c of list) {
    if (!c || c.status === 'voided' || c.voided) continue;
    const key = String(c.method || 'other').toLowerCase();
    if (!methods[key]) methods[key] = { method: key, count: 0, total: 0 };
    methods[key].count += 1;
    methods[key].total += Number(c.total) || 0;
  }
  const byMethod = Object.values(methods).sort((a, b) => b.total - a.total);
  return { stats, byMethod };
}

const METHOD_WORDS = { card: 'Card', cash: 'Cash', split: 'Split', gift_card: 'Gift card', other: 'Other' };
const methodLabel = (m) => METHOD_WORDS[m] || m.split(/[+_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' + ');

/**
 * The printed document.
 * @param {object} r { kind: 'X'|'Z', venueName, dayLabel, printedAtText, printedBy, stats, byMethod,
 *                     drawer?: { expected, declared, variance }, currency }
 */
export function buildShiftReportDoc(r, { cols = 42 } = {}) {
  const m = (n) => money(Number(n) || 0, r.currency);
  const s = r.stats || {};
  const b = new DocBuilder(cols);
  b.init()
    .center().bold(true).doubleBoth().text(r.kind === 'Z' ? 'Z REPORT' : 'X REPORT').lf()
    .normal().center();
  if (r.venueName) b.line(String(r.venueName));
  b.line(r.kind === 'Z' ? 'End of shift: drawer cashed up' : 'Shift so far: nothing is reset');
  if (r.dayLabel) b.line(`Business day ${r.dayLabel}`);
  if (r.printedAtText) b.fontB().line(`Printed ${r.printedAtText}${r.printedBy ? ` by ${r.printedBy}` : ''}`).fontA();
  b.divider().left()
    .twoCol('Sales (gross)', m(s.gross))
    .twoCol('Discounts', `-${m(s.discounts)}`)
    .twoCol('Refunds', `-${m(s.refundsItems)}`)
    .twoCol('Voids', `-${m(s.voids)}`)
    .bold(true).twoCol('Net sales', m(s.net)).bold(false)
    .twoCol('Service', m(s.service))
    .twoCol('Tips', m(s.tips))
    .twoCol('VAT included', m(s.tax))
    .divider()
    .twoCol('Checks', String(s.count || 0))
    .twoCol('Covers', String(s.covers || 0))
    .twoCol('Average check', m(s.count ? s.net / s.count : 0))
    .divider()
    .bold(true).line('Payments').bold(false);
  const methods = Array.isArray(r.byMethod) ? r.byMethod : [];
  if (!methods.length) b.line('No payments yet');
  for (const pm of methods) b.twoCol(`${methodLabel(pm.method)} (${pm.count})`, m(pm.total));
  if (r.kind === 'Z' && r.drawer) {
    const v = Number(r.drawer.variance) || 0;
    b.divider().bold(true).line('Cash drawer').bold(false)
      .twoCol('Expected cash', m(r.drawer.expected))
      .twoCol('Counted cash', m(r.drawer.declared))
      .bold(true).twoCol(Math.abs(v) < 0.005 ? 'Variance (balanced)' : v > 0 ? 'Variance (over)' : 'Variance (short)', m(v)).bold(false);
  }
  b.divider().center().fontB().line('Figures match Back Office, Reports, Sales summary').fontA()
    .lf(4).cut();
  return b.toDoc();
}
