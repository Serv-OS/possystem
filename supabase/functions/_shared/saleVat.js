// supabase/functions/_shared/saleVat.js
//
// THE ONE RULE FOR "THE VAT OF A SALE" IN EVERY REPORT (8 Oct 2026).
//
// Peter, 8 Oct 2026: "VAT despite the order type should follow the Tax rules set on the back
// office per menu item." "Fix once and right." The VAT audit of that day found the reports each
// reading a sale's VAT their own way:
//   - the Tax summary summed tax_amount and never took a refund off; Daily trading, the Owner
//     app and Xero took refunds off on the refund's day; the Business summary took them off on
//     the sale's day;
//   - a sale with no VAT (Preston QR-4OGI7, tax_amount null) read as 0 in every report and said
//     nothing, and Xero would have posted it inside the 20% line with VAT 0.00;
//   - a refund made on a till that did not make the sale saved no refund VAT, so the Business
//     summary kept VAT that Xero had given back.
//
// This file is the rule, with no database and no screen in it, so the Back Office reports
// (src), the edge functions (Deno) and the daily check all read a sale the same way:
//   1. The VAT of a sale is what it BOOKED: closed_checks.tax_amount. Never a recompute, never
//      total minus subtotal (0 at a UK venue), never a guess.
//   2. A sale with goods and no VAT recorded counts as 0 AND is named (never a silent 0).
//   3. A refund takes its VAT off on the day the REFUND was made (what Xero and HMRC see), by
//      the app's rule: the entry's own taxAmount when the till saved one, else pro rata on the
//      sale's booked VAT (payments/refundMath.refundTaxAmount), estimated and said so.
//   4. A sale whose record says the VAT did not come straight from its own Back Office rule is
//      flagged: a line that took the venue default (tax_breakdown.fallbacks, D4), a record the
//      save time guard repaired (source 'repair'), a figure the server booked because the page
//      sent none or a wrong one (source 'server', booked 'server'), a figure with no record of
//      the rate, or a record that does not add up to the figure booked.
// Accepts a closed_checks row (snake_case, as the edge functions read it) or the store's copy
// (camelCase, as the Back Office reports read it). PURE: imports nothing; node --test loads it.

export const SALE_VAT_FLAGS = Object.freeze({
  NO_VAT: 'no-vat',           // goods above 0, tax_amount null: nothing was booked
  NO_RECORD: 'no-record',     // a figure booked with no split by rate behind it
  FALLBACK: 'fallback',       // a line took the venue default instead of its own rule (D4)
  REPAIR: 'repair',           // the save time guard worked the VAT out or filled the record in
  SERVER: 'server',           // the server booked the figure (the page sent none, or a wrong one)
  MISMATCH: 'mismatch',       // the record's total does not match the figure booked (over 1p)
});

/** Plain words, short, for a report line. */
export const SALE_VAT_FLAG_WORDS = Object.freeze({
  'no-vat': 'no VAT recorded',
  'no-record': 'no record of the rate',
  'fallback': 'a line took the venue default rate',
  'repair': 'VAT filled in when the sale was saved',
  'server': 'VAT booked by the server, not the page',
  'mismatch': 'the rate record does not add up to the VAT booked',
});

// ── reading a row of either shape ────────────────────────────────────────────

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Half up to the penny on the true value (the one rounding rule, taxRule.roundHalfUpMinor), with sign. */
export function roundPence(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  const out = Math.round(Number((Math.abs(n) * 100).toFixed(6))) / 100;
  return n < 0 && out !== 0 ? -out : out;
}

const isSnake = (row) => 'tax_amount' in row || 'closed_at' in row || 'order_type' in row || 'tax_breakdown' in row;

/** True when `record` is a usable tax record: an object with a real number for totalTax. */
export function isUsableRecord(record) {
  return !!record && typeof record === 'object' && !Array.isArray(record) && num(record.totalTax) != null;
}

/** True when the record carries a split by rate (one or more breakdown lines). */
export function hasRateLines(record) {
  return isUsableRecord(record) && Array.isArray(record.breakdown) && record.breakdown.length > 0;
}

/** The goods a row sold: its live lines at price x qty, else the stored subtotal. */
export function saleGoods(row) {
  const items = Array.isArray(row?.items) ? row.items : [];
  let goods = 0;
  for (const i of items) {
    if (!i || i.voided) continue;
    goods += (num(i.price) || 0) * (num(i.qty) || 1);
  }
  if (goods > 0) return goods;
  const sub = num(row?.subtotal);
  return sub != null && sub > 0 ? sub : 0;
}

const isVoided = (row) => row?.voided === true || /^void/i.test(String(row?.status || ''));

/**
 * One row, either shape, read for this rule:
 *   { snake, id, ref, taxAmount, record, goods, total, tip, voided, refunds, closedAtMs, tenders }
 */
export function readSale(row) {
  const r = row || {};
  const snake = isSnake(r);
  const record = snake ? r.tax_breakdown : r.taxBreakdown;
  const closedRaw = snake ? r.closed_at : r.closedAt;
  const closedMs = typeof closedRaw === 'number' ? closedRaw : closedRaw ? Date.parse(closedRaw) : NaN;
  return {
    snake,
    id: r.id ?? null,
    ref: r.ref ?? null,
    taxAmount: num(snake ? r.tax_amount : r.taxAmount),
    record: record && typeof record === 'object' && !Array.isArray(record) ? record : null,
    goods: saleGoods(r),
    total: num(r.total),
    tip: num(r.tip) ?? 0,
    voided: isVoided(r),
    refunds: Array.isArray(r.refunds) ? r.refunds.filter((e) => e && typeof e === 'object') : [],
    closedAtMs: Number.isFinite(closedMs) ? closedMs : null,
    tenders: Array.isArray(r.tenders) ? r.tenders : null,
  };
}

/** The VAT a sale booked, or null when none was recorded. Never 0 for null. */
export function saleVatAmount(row) {
  return readSale(row).taxAmount;
}

/** True when the sale booked a VAT figure (0 counts: a zero rated sale is recorded). */
export function saleVatRecorded(row) {
  return readSale(row).taxAmount != null;
}

/**
 * What is wrong, or worth a look, about how this sale's VAT was booked (rule 4), as a list of
 * { code, words, reason, lineId, name, rateId }. Empty for a sale booked straight from its
 * Back Office rule. A voided sale or one with no goods is never flagged. `hasRates` false
 * (a venue with no tax set up) turns off 'no-vat' and 'no-record': that venue books nothing.
 */
export function saleVatFlags(row, { hasRates = true } = {}) {
  const r = readSale(row);
  if (r.voided || !(r.goods > 0)) return [];
  const out = [];
  const flag = (code, extra = {}) => out.push({ code, words: SALE_VAT_FLAG_WORDS[code], ...extra });
  if (r.taxAmount == null) {
    if (hasRates) flag(SALE_VAT_FLAGS.NO_VAT);
    // Nothing booked: the record (if any) cannot be judged against the figure.
  } else if (hasRates && !hasRateLines(r.record)) {
    flag(SALE_VAT_FLAGS.NO_RECORD);
  }
  const rec = r.record;
  if (isUsableRecord(rec)) {
    for (const f of Array.isArray(rec.fallbacks) ? rec.fallbacks : []) {
      if (!f || typeof f !== 'object') continue;
      flag(SALE_VAT_FLAGS.FALLBACK, { reason: f.reason || null, lineId: f.lineId ?? null, name: f.name ?? null, rateId: f.rateId ?? null });
    }
    if (rec.source === 'repair') flag(SALE_VAT_FLAGS.REPAIR, { reason: rec.repair?.reason || null });
    if (rec.source === 'server' || rec.booked === 'server') flag(SALE_VAT_FLAGS.SERVER, { reason: rec.reason || null });
    if (r.taxAmount != null && Math.abs(roundPence(rec.totalTax) - r.taxAmount) > 0.01 + 1e-9) {
      flag(SALE_VAT_FLAGS.MISMATCH, { reason: `record ${roundPence(rec.totalTax).toFixed(2)}, booked ${r.taxAmount.toFixed(2)}` });
    }
  }
  return out;
}

// ── refunds ──────────────────────────────────────────────────────────────────

/** The instant (ms) a refund entry was made, or null (accountingDay.refundAtMs, the same reading). */
export function refundAtMs(entry) {
  for (const c of [entry?.timestamp, entry?.at, entry?.created_at]) {
    if (c == null || c === '') continue;
    const ms = typeof c === 'number' ? c : /^\d+$/.test(String(c)) ? Number(c) : Date.parse(c);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  const legAt = (Array.isArray(entry?.legs) ? entry.legs : []).map((l) => l?.at).find((x) => Number.isFinite(Number(x)) && Number(x) > 0);
  return legAt != null ? Number(legAt) : null;
}

/** A refund entry that moved no money: failed, or still pending (the till stopped part way). */
export function refundMovedNothing(entry) {
  if (!entry || typeof entry !== 'object') return true;
  if (entry.failed === true) return true;
  const st = String(entry.cardStatus || '').toLowerCase();
  if (st === 'failed') return true;
  if (st === 'pending' && !/cash/i.test(String(entry.tenderMethod || ''))) return true;
  return !((num(entry.amount) || 0) > 0);
}

/**
 * The basis a refund's VAT is pro rated on: the bill, or what the tenders settled when they
 * came to more (a kiosk or online check whose total is net of credits). Mirrors
 * payments/refundMath.refundTaxBasis.
 */
export function refundTaxBasis(row) {
  const r = readSale(row);
  const total = r.total || 0;
  if (!r.tenders || !r.tenders.length) return total;
  const settled = roundPence(r.tenders.reduce((s, t) => s + (num(t?.amount) || 0) + (num(t?.tip) || 0), 0) - r.tip);
  return Math.max(total, settled);
}

/**
 * The VAT one refund entry gives back (rule 3): { amount, estimated, noVat }.
 *   amount     the entry's own taxAmount when the till saved one; else the sale's booked VAT
 *              pro rata on the refund amount (the app's rule), rounded half up to the penny
 *   estimated  true when the figure was pro rated here, not saved by the till
 *   noVat      true when the sale itself booked no VAT: the refund gives back 0 and is named
 * A refund that moved no money gives back 0 (estimated false).
 */
export function refundVatOf(entry, row) {
  if (refundMovedNothing(entry)) return { amount: 0, estimated: false, noVat: false };
  const own = num(entry?.taxAmount);
  if (own != null) return { amount: Math.max(0, roundPence(own)), estimated: false, noVat: false };
  const r = readSale(row);
  if (r.taxAmount == null) return { amount: 0, estimated: true, noVat: true };
  const basis = refundTaxBasis(row);
  const amount = num(entry.amount) || 0;
  if (!(basis > 0)) return { amount: 0, estimated: true, noVat: false };
  return { amount: Math.min(r.taxAmount, roundPence((r.taxAmount * amount) / basis)), estimated: true, noVat: false };
}

/**
 * True when the refund belongs in [fromMs, toMs): by the time it was made, else (an entry with
 * no time) by the time its sale closed. With no range every refund belongs.
 */
export function refundInRange(entry, row, range) {
  if (!range || (range.fromMs == null && range.toMs == null)) return true;
  const at = refundAtMs(entry) ?? readSale(row).closedAtMs;
  if (at == null) return true;
  if (range.fromMs != null && at < range.fromMs) return false;
  if (range.toMs != null && at >= range.toMs) return false;
  return true;
}

// ── the ledger a report shows ────────────────────────────────────────────────

const MAX_NAMED = 40;

/**
 * The VAT of a list of sales, as every report must show it:
 *   { count, salesVat, refundVat, vatDue, refundsEstimated, noVat[], noRecord[], flagged[], mismatched[] }
 *   salesVat   the sum of what the sales booked (a sale with none counts 0 and is in noVat)
 *   refundVat  the VAT given back by refunds made inside `range` (every refund with no range)
 *   vatDue     salesVat less refundVat
 *   noVat      [{ id, ref, total }] sales with goods and no VAT recorded (never a silent 0)
 *   noRecord   [{ id, ref }] sales with a figure but no split by rate
 *   flagged    [{ id, ref, code, words, reason, name }] every other flag (fallback, repair, server)
 *   mismatched [{ id, ref, reason }] records that do not add up to the figure booked
 * Voided sales count for nothing. Lists are capped at MAX_NAMED names; the counts are exact.
 * `refundRows` (8 Oct 2026 review): sales closed BEFORE the range that carry a refund. Only their
 * refunds made inside the range are taken off; they are not the range's sales and count for
 * nothing else. A row already in `rows` is not read twice.
 */
export function saleVatLedger(rows, { range = null, hasRates = true, refundRows = null } = {}) {
  const out = {
    count: 0, salesVat: 0, refundVat: 0, vatDue: 0, refundsEstimated: 0,
    noVat: [], noVatCount: 0, noRecord: [], noRecordCount: 0, flagged: [], flaggedCount: 0, mismatched: [], mismatchedCount: 0,
  };
  const name = (list, countKey, entry) => { out[countKey] += 1; if (list.length < MAX_NAMED) list.push(entry); };
  const seen = new Set();
  const takeRefunds = (row, r) => {
    for (const e of r.refunds) {
      if (!refundInRange(e, row, range)) continue;
      const v = refundVatOf(e, row);
      out.refundVat += v.amount;
      if (v.estimated && !v.noVat) out.refundsEstimated += 1;
    }
  };
  for (const row of Array.isArray(rows) ? rows : []) {
    const r = readSale(row);
    if (!row || r.voided) continue;
    if (r.id != null) seen.add(r.id);
    out.count += 1;
    if (r.taxAmount != null) out.salesVat += r.taxAmount;
    for (const f of saleVatFlags(row, { hasRates })) {
      if (f.code === SALE_VAT_FLAGS.NO_VAT) name(out.noVat, 'noVatCount', { id: r.id, ref: r.ref, total: r.total });
      else if (f.code === SALE_VAT_FLAGS.NO_RECORD) name(out.noRecord, 'noRecordCount', { id: r.id, ref: r.ref });
      else if (f.code === SALE_VAT_FLAGS.MISMATCH) name(out.mismatched, 'mismatchedCount', { id: r.id, ref: r.ref, reason: f.reason });
      else name(out.flagged, 'flaggedCount', { id: r.id, ref: r.ref, code: f.code, words: f.words, reason: f.reason || null, name: f.name || null });
    }
    takeRefunds(row, r);
  }
  for (const row of Array.isArray(refundRows) ? refundRows : []) {
    const r = readSale(row);
    if (!row || r.voided || (r.id != null && seen.has(r.id))) continue;
    if (r.id != null) seen.add(r.id);
    takeRefunds(row, r);
  }
  out.salesVat = roundPence(out.salesVat);
  out.refundVat = roundPence(out.refundVat);
  out.vatDue = roundPence(out.salesVat - out.refundVat);
  return out;
}

/** "3 sales have no VAT recorded: QR-4OGI7, R12" (refs capped), or '' when none. */
export function noVatLine(ledger) {
  const n = ledger?.noVatCount || 0;
  if (!n) return '';
  const refs = (ledger.noVat || []).map((x) => x.ref || x.id).filter(Boolean);
  const more = n > refs.length ? ` and ${n - refs.length} more` : '';
  return `${n === 1 ? '1 sale has' : `${n} sales have`} no VAT recorded: ${refs.join(', ')}${more}`;
}

/** "2 sales have no record of the rate: R1, R2", or ''. */
export function noRecordLine(ledger) {
  const n = ledger?.noRecordCount || 0;
  if (!n) return '';
  const refs = (ledger.noRecord || []).map((x) => x.ref || x.id).filter(Boolean);
  const more = n > refs.length ? ` and ${n - refs.length} more` : '';
  return `${n === 1 ? '1 sale has' : `${n} sales have`} no record of the rate: ${refs.join(', ')}${more}`;
}

/** One line per flagged sale: "R4082: a line took the venue default rate (custom-item, Coffee beans)". */
export function flaggedLines(ledger) {
  return (ledger?.flagged || []).map((f) => {
    const why = [f.reason, f.name].filter(Boolean).join(', ');
    return `${f.ref || f.id}: ${f.words}${why ? ` (${why})` : ''}`;
  });
}

/** 8 Oct 2026 (D1): the plain line under the Back Office Tax summary until the owner decides with his accountant. */
export const LOYALTY_VAT_LINE = 'Includes VAT on loyalty rewards (the till\'s rule).';
/** The same question, as the Xero preview says it: the invoice takes that VAT off on the Loyalty rewards line. */
export const LOYALTY_VAT_XERO_LINE = 'VAT on loyalty rewards: the Back Office Tax summary includes it (the till\'s rule); this invoice takes it off on the Loyalty rewards line. One rule follows once the accountant decides.';

/**
 * A store copy of a closed check (camelCase) as the accounting layer reads a row (snake_case),
 * so the Tax summary can read a sale's tenders exactly as Xero and Daily trading do. A row that
 * is already snake_case is returned as it is.
 */
export function toAccountingRow(check) {
  const c = check || {};
  if (isSnake(c)) return c;
  return {
    id: c.id, ref: c.ref, closed_at: c.closedAt != null ? new Date(c.closedAt).toISOString() : null,
    total: c.total, subtotal: c.subtotal, tip: c.tip, service: c.service,
    tax_amount: c.taxAmount ?? null, tax_breakdown: c.taxBreakdown ?? null,
    status: c.status, voided: c.voided, discounts: c.discounts, items: c.items, refunds: c.refunds,
    tenders: c.tenders ?? null, method: c.method, payment_method: c.paymentMethod ?? c.method, source: c.source,
    processor: c.processor, gift_card: c.giftCard ?? null, loyalty: c.loyalty ?? null, promo: c.promo ?? null,
    payment_intents: c.paymentIntents ?? null, order_type: c.orderType,
  };
}
