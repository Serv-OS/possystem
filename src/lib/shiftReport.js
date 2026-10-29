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
// 16 Oct 2026: the figures are read by THE ONE SALES RULE (src/lib/salesBreakdown.js over
// supabase/functions/_shared/tradingSales.js), the same reading as the Back Office Business
// summary, Daily trading and the Owner app, so "Net sales excluding VAT" is the same figure to
// the penny. Until today the slip printed the stored subtotal less discounts as "Net sales": at
// a UK venue that still had the VAT inside it and counted free loyalty drinks as sales
// (Huddersfield 16 Oct: the slip would have said 2,085.10, the Owner app 1,703.30). Payments are
// the money tenders (card, cash, gift card), which add up to Money collected; a loyalty reward
// is never money. Print only: nothing a customer is charged changes.
// 29 Oct 2026 (v5.11.118, Drop C): gift cards sold at the till print as their own "plus Gift cards
// sold" line of the ladder (money in, not sales: outside Item sales, Net sales and the VAT, inside
// Money collected) and are named again under Payments, where their money sits inside Card and Cash.
// Pure: no store, no printer, no clock of its own.

import { salesBreakdown, breakdownLines, TENDER_ORDER, TENDER_WORDS } from './salesBreakdown.js';
import { businessDayOf, businessDayWindow } from '../../supabase/functions/_shared/businessDay.js';
import { DocBuilder } from './printDoc.js';
import { money, signedMoney } from './currency.js';

/** The checks of the business day that `now` falls in, at the venue's clock and day start. */
export function checksForBusinessDay(checks, { now = Date.now(), timezone, dayStart } = {}) {
  const today = businessDayOf(now, timezone, dayStart);
  if (!today) return [];
  return (Array.isArray(checks) ? checks : []).filter((c) => {
    const at = c?.closedAt ?? c?.closed_at;
    return at != null && businessDayOf(typeof at === 'number' ? at : Date.parse(at), timezone, dayStart) === today;
  });
}

/** The business day `now` falls in as { fromMs, toMs } (to inclusive), or null. Refunds count on the day they were made. */
export function businessDayRange({ now = Date.now(), timezone, dayStart } = {}) {
  const today = businessDayOf(now, timezone, dayStart);
  if (!today) return null;
  const w = businessDayWindow(today, timezone, dayStart);
  return { fromMs: w.fromMs, toMs: w.toMs - 1 };
}

/**
 * The slip's figures.
 *   checks      the checks that closed in the business day (checksForBusinessDay)
 *   range       the business day (businessDayRange): a refund counts on the day it was made
 *   refundRows  the till's older checks (a refund made today on yesterday's sale comes off today,
 *               as in Daily trading); a check in both lists counts once
 *   currency    the venue's currency
 * Returns { sales, payments }: `sales` is the Business summary's breakdown (salesBreakdown),
 * `payments` one row per money kind that took money ({ kind, label, count, amount, tips }),
 * Card, Cash and Gift card always, adding up to sales.collected.
 */
export function summariseShift(checks, { range = null, refundRows = null, currency = null } = {}) {
  const list = Array.isArray(checks) ? checks : [];
  const sales = salesBreakdown(list, { range, refundRows, currency });
  const payments = TENDER_ORDER
    .filter((k) => ['card', 'cash', 'gift_card'].includes(k) || Math.abs(sales[`tender_${k}`] || 0) >= 0.005)
    .map((k) => ({ kind: k, label: TENDER_WORDS[k], count: sales.tenderChecks?.[k] || 0, amount: sales[`tender_${k}`] || 0, tips: sales.tenderTips?.[k] || 0 }));
  return { sales, payments };
}

// A narrow (58 mm) slip says "inc" and "ex" so a label and its amount share one line.
const fitLabel = (label, cols) => (cols < 40 ? label.replace(/\bincluding\b/, 'inc').replace(/\bexcluding\b/, 'ex').replace(/\(before tax\)/, '(pre tax)') : label);

// Words on whole lines no wider than the slip.
function wrapWords(text, cols) {
  const out = [];
  let cur = '';
  for (const w of String(text || '').split(/\s+/).filter(Boolean)) {
    if (cur && cur.length + 1 + w.length > cols) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The printed document.
 * @param {object} r { kind: 'X'|'Z', venueName, dayLabel, printedAtText, printedBy, sales, payments,
 *                     drawer?: { expected, declared, variance }, currency }
 */
export function buildShiftReportDoc(r, { cols = 42 } = {}) {
  const m = (n) => money(Number(n) || 0, r.currency);
  const sm = (n) => signedMoney(Number(n) || 0, r.currency);
  const s = r.sales || salesBreakdown([]);
  const b = new DocBuilder(cols);
  b.init()
    .center().bold(true).doubleBoth().text(r.kind === 'Z' ? 'Z REPORT' : 'X REPORT').lf()
    .normal().center();
  if (r.venueName) b.line(String(r.venueName));
  b.line(r.kind === 'Z' ? 'End of shift: drawer cashed up' : 'Shift so far: nothing is reset');
  if (r.dayLabel) b.line(`Business day ${r.dayLabel}`);
  if (r.printedAtText) b.fontB().line(`Printed ${r.printedAtText}${r.printedBy ? ` by ${r.printedBy}` : ''}`).fontA();
  b.divider().left();
  // The Business summary's ladder, line for line: the net sales line is the Owner app's figure.
  for (const l of breakdownLines(s)) {
    const label = fitLabel(l.kind === 'of' ? `  ${l.label}` : l.label, cols);
    const value = l.kind === 'less' ? sm(l.value) : m(l.value);
    const strong = l.kind === 'head' || l.kind === 'sub' || l.kind === 'total' || l.key === 'net';
    if (strong) b.bold(true);
    b.twoColTrunc(label, value);
    if (strong) b.bold(false);
  }
  if (s.rewardsTax >= 0.005) {
    const w = s.taxWord === 'tax' ? 'Tax' : 'VAT';
    b.fontB();
    for (const ln of wrapWords(`${w} on loyalty rewards ${m(s.rewardsTax)} is not in the ${w} above (as Daily trading and the Owner app). The Tax summary counts it.`, cols)) b.line(ln);
    b.fontA();
  }
  b.divider()
    .twoCol('Checks', String(s.count || 0))
    .twoCol('Covers', String(s.covers || 0))
    .twoColTrunc(fitLabel(`Average check (excluding ${s.taxWord === 'tax' ? 'tax' : 'VAT'})`, cols), m(s.count ? s.net / s.count : 0))
    .divider()
    .bold(true).line('Payments').bold(false);
  const payments = Array.isArray(r.payments) ? r.payments : [];
  for (const p of payments) {
    b.twoColTrunc(`${p.label} (${p.count || 0})`, m(p.amount));
    if (Math.abs(Number(p.tips) || 0) >= 0.005) b.twoColTrunc('  of which tips', m(p.tips));
  }
  if ((Number(s.giftSold) || 0) >= 0.005) {
    b.twoColTrunc('Gift cards sold (in the payments above)', m(s.giftSold));
    b.fontB();
    for (const ln of wrapWords('Gift cards sold are money in, not sales: outside Net sales and VAT until the card is spent.', cols)) b.line(ln);
    b.fontA();
  }
  b.bold(true).twoColTrunc('Money collected', m(s.collected)).bold(false);
  if (r.kind === 'Z' && r.drawer) {
    const v = Number(r.drawer.variance) || 0;
    b.divider().bold(true).line('Cash drawer').bold(false)
      .twoCol('Expected cash', m(r.drawer.expected))
      .twoCol('Counted cash', m(r.drawer.declared))
      .bold(true).twoCol(Math.abs(v) < 0.005 ? 'Variance (balanced)' : v > 0 ? 'Variance (over)' : 'Variance (short)', m(v)).bold(false);
  }
  b.divider().center().fontB().line('Figures match Back Office, Business summary').fontA()
    .lf(4).cut();
  return b.toDoc();
}
