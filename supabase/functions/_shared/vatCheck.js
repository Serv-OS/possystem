// supabase/functions/_shared/vatCheck.js
//
// THE DAILY VAT CHECK, the rule without the database (8 Oct 2026, plan section 4 "a daily check").
//
// Each morning vat-check reads the last completed business day's sales at every venue that has
// tax rates and judges each one against the till's rule, run again over its stored lines
// (vatRederive.js). It then writes one row per venue in vat_check_runs and, when something is
// wrong, one plain message to the venue (venue_messages, which Company Admin lists too):
// "3 sales booked with no VAT at Preston yesterday: QR-4OGI7, ...". Nothing is changed by it.
//
// What a sale can be:
//   ok           booked what its items give, to the penny, with a record of the rate
//   penny        one penny from the rule: a half penny the till of 1 to 8 Oct stored as a float
//                rounded down (814 live sales). Counted, never alarmed.
//   no-vat       goods sold, tax_amount null (Preston QR-4OGI7)
//   differs      more than a penny from what its items give under today's Back Office rules
//   no-record    the right figure with no split by rate behind it (the Barnsley kiosk sales)
//   not-checked  the venue uses tax profiles (this mirror reads rates only), or the sale has no
//                lines to read; said so, never counted as ok
// And beside the verdict: the D4 fallbacks the sale recorded (a line that took the venue
// default), a record whose rate id is not one of the venue's, a record the save guard repaired,
// a figure the server booked. PURE: imports vatRederive.js and saleVat.js (both pure).

import { rederiveSale } from './vatRederive.js';
import { saleVatFlags, readSale, roundPence, SALE_VAT_FLAGS } from './saleVat.js';
import { stableUuid } from './stableId.js';

export const VERDICTS = Object.freeze(['ok', 'penny', 'no-vat', 'differs', 'no-record', 'not-checked']);
const MAX_REFS = 25;

/**
 * One sale judged: { ref, id, verdict, stored, derived, diff, flags, fallbacks, foreignRateIds, share }.
 *   row            a closed_checks row (items, discounts, order_type, total, tip, tax_amount, tax_breakdown, ref, id)
 *   rates, menu    the venue's tax_rates rows and menu_items rows (or a menuIndex Map)
 *   profilesInUse  true when the venue has tax_profiles: the figure is not judged, only its presence
 */
export function judgeSale(row, { rates, menu, profilesInUse = false } = {}) {
  const r = readSale(row);
  const out = { ref: r.ref || r.id, id: r.id, verdict: 'ok', stored: r.taxAmount, derived: null, diff: null, flags: [], fallbacks: [], foreignRateIds: [], share: 1 };
  if (r.voided || !(r.goods > 0)) return { ...out, verdict: 'ok', skipped: true };
  out.flags = saleVatFlags(row, { hasRates: true }).map((f) => f.code);
  // The record's own fallbacks and any rate id that is not this venue's.
  const rec = r.record;
  const own = new Set((Array.isArray(rates) ? rates : []).map((x) => String(x?.id)));
  if (rec && Array.isArray(rec.breakdown)) {
    for (const b of rec.breakdown) {
      const id = b?.rate?.id;
      if (id != null && !own.has(String(id)) && !out.foreignRateIds.includes(String(id))) out.foreignRateIds.push(String(id));
    }
  }
  if (rec && Array.isArray(rec.fallbacks)) out.fallbacks = rec.fallbacks.filter((f) => f && typeof f === 'object').map((f) => ({ reason: f.reason, name: f.name ?? null, rateId: f.rateId ?? null }));
  if (r.taxAmount == null) return { ...out, verdict: 'no-vat' };
  if (profilesInUse) return { ...out, verdict: 'not-checked', why: 'tax profiles in use' };
  const d = rederiveSale(row, { rates, menu });
  if (!d.ok || d.totalTax == null) return { ...out, verdict: 'not-checked', why: d.reason || 'could not be worked out', share: d.share };
  out.derived = d.totalTax;
  out.share = d.share;
  out.diff = roundPence(r.taxAmount - d.totalTax);
  for (const f of d.fallbacks) if (!out.fallbacks.some((x) => x.reason === f.reason && x.name === f.name)) out.fallbacks.push({ reason: f.reason, name: f.name ?? null, rateId: f.rateId ?? null });
  if (Math.abs(out.diff) > 0.01 + 1e-9) return { ...out, verdict: 'differs' };
  if (out.flags.includes(SALE_VAT_FLAGS.NO_RECORD)) return { ...out, verdict: 'no-record' };
  if (Math.abs(out.diff) > 1e-9) return { ...out, verdict: 'penny' };
  return out;
}

/**
 * One venue's day: every sale judged and counted.
 *   { date, venue, sales, ok, penny, noVat, noVatRefs, differs, differsRefs, noRecord, noRecordRefs,
 *     notChecked, fallbacks, fallbackRefs, foreign, foreignRefs, repaired, server, profilesInUse,
 *     details:[...judged sales that are not plain ok] }
 */
export function checkVenueDay(rows, { rates, menu, profilesInUse = false, date = null, venue = null } = {}) {
  const s = {
    date, venue, profilesInUse: !!profilesInUse, sales: 0, ok: 0, penny: 0,
    noVat: 0, noVatRefs: [], differs: 0, differsRefs: [], noRecord: 0, noRecordRefs: [], notChecked: 0,
    fallbacks: 0, fallbackRefs: [], foreign: 0, foreignRefs: [], repaired: 0, server: 0, details: [],
  };
  const push = (list, ref) => { if (list.length < MAX_REFS && ref) list.push(String(ref)); };
  for (const row of Array.isArray(rows) ? rows : []) {
    const j = judgeSale(row, { rates, menu, profilesInUse });
    if (j.skipped) continue;
    s.sales += 1;
    if (j.verdict === 'ok') s.ok += 1;
    else if (j.verdict === 'penny') s.penny += 1;
    else if (j.verdict === 'no-vat') { s.noVat += 1; push(s.noVatRefs, j.ref); }
    else if (j.verdict === 'differs') { s.differs += 1; push(s.differsRefs, j.ref); }
    else if (j.verdict === 'no-record') { s.noRecord += 1; push(s.noRecordRefs, j.ref); }
    else s.notChecked += 1;
    if (j.fallbacks.length) { s.fallbacks += 1; push(s.fallbackRefs, j.ref); }
    if (j.foreignRateIds.length) { s.foreign += 1; push(s.foreignRefs, j.ref); }
    if (j.flags.includes(SALE_VAT_FLAGS.REPAIR)) s.repaired += 1;
    if (j.flags.includes(SALE_VAT_FLAGS.SERVER)) s.server += 1;
    if (j.verdict !== 'ok' || j.fallbacks.length || j.foreignRateIds.length) {
      if (s.details.length < 200) s.details.push({ ref: j.ref, id: j.id, verdict: j.verdict, stored: j.stored, derived: j.derived, diff: j.diff, fallbacks: j.fallbacks, foreignRateIds: j.foreignRateIds, flags: j.flags, ...(j.why ? { why: j.why } : {}) });
    }
  }
  return s;
}

/** True when the day needs a message (something a person must look at). Pennies alone do not. */
export function needsMessage(summary) {
  return (summary?.noVat || 0) > 0 || (summary?.differs || 0) > 0;
}

const list = (refs, n) => {
  const shown = (refs || []).slice(0, 8);
  const more = n > shown.length ? ` and ${n - shown.length} more` : '';
  return `${shown.join(', ')}${more}`;
};

/**
 * The message to the venue (and Company Admin), or null when the day is clean. Short, plain,
 * no dashes, under venue_messages' 600 characters.
 *   { title, body, kind }
 */
export function vatCheckMessage(summary, { venueName, dayWords } = {}) {
  if (!needsMessage(summary)) return null;
  const venue = String(venueName || summary?.venue || 'this venue').trim();
  const when = dayWords || (summary?.date ? `on ${summary.date}` : 'yesterday');
  const parts = [];
  if (summary.noVat) parts.push(`${summary.noVat === 1 ? '1 sale was' : `${summary.noVat} sales were`} booked with no VAT at ${venue} ${when}: ${list(summary.noVatRefs, summary.noVat)}.`);
  if (summary.differs) parts.push(`${summary.differs === 1 ? '1 sale booked' : `${summary.differs} sales booked`} VAT that does not match the Back Office item rules: ${list(summary.differsRefs, summary.differs)}.`);
  if (summary.noRecord) parts.push(`${summary.noRecord === 1 ? '1 sale has' : `${summary.noRecord} sales have`} no record of the rate.`);
  parts.push('Nothing was changed. Check them in Back Office, Reports, Tax.');
  let body = parts.join(' ');
  if ([...body].length > 600) body = `${[...body].slice(0, 597).join('')}...`;
  return { kind: 'info', title: 'VAT check: sales to look at', body };
}

/** One id for one venue and one day, so the message is written once however often the check runs. */
export function vatCheckNoticeId(locationId, date) {
  return stableUuid(`vat-check|${locationId}|${date}`);
}

/** The vat_check_runs row for a venue's day (the counts, the named sales), ready to upsert. */
export function vatCheckRunRow(summary, { locationId, ranAt = new Date().toISOString(), messageId = null } = {}) {
  return {
    location_id: locationId, business_day: summary.date, ran_at: ranAt,
    sales: summary.sales, ok_count: summary.ok, penny_count: summary.penny,
    no_vat: summary.noVat, differs: summary.differs, no_record: summary.noRecord, not_checked: summary.notChecked,
    fallbacks: summary.fallbacks, foreign_rate: summary.foreign, repaired: summary.repaired, server_booked: summary.server,
    profiles_in_use: summary.profilesInUse,
    details: { noVatRefs: summary.noVatRefs, differsRefs: summary.differsRefs, noRecordRefs: summary.noRecordRefs, fallbackRefs: summary.fallbackRefs, foreignRefs: summary.foreignRefs, sales: summary.details },
    message_id: messageId,
  };
}
