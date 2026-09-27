// tradingSales.js: one closed check's sales for the Daily trading (P&L) report.
//
// 27 Sep 2026 (review of the Leeds VAT fix): trading-report read closed_checks.subtotal as
// ex VAT and made gross = subtotal + tax_amount. At a UK venue the subtotal is shelf prices,
// which already include VAT, so gross takings were overstated by the whole VAT and net
// sales (the P&L basis) by the same amount.
//
//   inclusive VAT (tax_breakdown.hasExclusiveTax not true; every UK check)
//     gross = subtotal, vat = tax_amount, net = subtotal - vat
//   added-on sales tax (hasExclusiveTax true; US)
//     net = subtotal, vat = tax_amount, gross = net + vat
//   no stored tax_amount (rows before v4.6.19, reader closes before v5.9.97)
//     the old fallback, unchanged: net = subtotal, vat = total - subtotal - service - tip
//
// Every writer stores tax_breakdown whenever a check carries added-on tax above zero
// (closedCheckRow, kiosk, online, QR, catering), so a row without one is inclusive, or
// charged no added-on tax, which gives the same figures either way.
//
// The subtotal is before check discounts on every surface; this report has never taken
// discounts off. Unchanged here (the fix is only the VAT double count).
//
// PURE: no imports, runs under node --test and in Deno.

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * @param {any} row  a closed_checks row: subtotal, total, tax_amount, tax_breakdown, service, tip
 * @returns {{ net: number, vat: number, gross: number }}
 */
export function checkSalesParts(row) {
  const r = row || {};
  const subtotal = num(r.subtotal);
  if (r.tax_amount == null || r.tax_amount === '') {
    const vat = Math.max(0, num(r.total) - subtotal - num(r.service) - num(r.tip));
    return { net: subtotal, vat, gross: subtotal + vat };
  }
  const vat = num(r.tax_amount);
  const bd = r.tax_breakdown && typeof r.tax_breakdown === 'object' ? r.tax_breakdown : null;
  if (bd?.hasExclusiveTax === true) return { net: subtotal, vat, gross: subtotal + vat };
  return { net: subtotal - vat, vat, gross: subtotal };
}
