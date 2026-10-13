// supabase/functions/_shared/xeroCardFees.ts
//
// THE CARD FEES OF ONE BUSINESS DAY, for the "Card fees" line on the daily Xero sales invoice
// (13 Oct 2026, the owner: "We should create a new account in Xero called card fees"). The
// venue's accountant used to get a minus line for the fees on each day's invoice, so the card
// money on the invoice was what the card processor paid out. This file finds those fees; the
// planner (_shared/xeroInvoicePlan.js) puts them on the invoice. Pure functions and one loader:
// no remote imports, the database client is passed in, so `npm test` loads it as it is.
//
// WHICH FEES. The venue's own fee on each card payment: adyen_payments.commission_minor on the
// Platform database, stamped from the venue's rate card when the payment is authorised. Never
// Adyen's own cost to the platform (fee_minor, fee_breakdown), which is not read here at all.
// Never a percentage, never an estimate: a payment with no fee on record has no fee here.
//
// MATCHED PAYMENT BY PAYMENT. The invoice counts the card tenders of the checks that closed in
// the business day and the card refunds made in it. Each card tender carries the processor's
// reference (closed_checks.tenders[].psp_ref, "<till's own key>.<PSP reference>" on a reader
// payment); each card refund leg carries the reference of the payment it refunded (legs[].id).
// cardFeeItems lists exactly the card money the planner holds on the card clearing account, and
// the planner checks the two sums agree before it carries the line.
//
// REFUNDS. The store's split refunds 'deductAccordingToSplitRatio' (_shared/adyenLink.ts
// splitLogicFor), so the venue gets its fee back in proportion to what is refunded. Our record
// keeps the full fee on the payment, so the fee given back on a day is worked out from that
// day's refund legs with venuePayoutLine, the very function Back Office, Card payments, Payouts
// uses. The Xero line and that screen therefore agree by construction.
//
// NEVER A GUESS, NEVER FOR EVER. A fee that can still arrive (the payment has a reference, and
// its row or its fee is not there yet) makes the day WAIT, up to CARD_FEE_WAIT_MS after the
// business day ended; after that the day posts with the fees that are known and a warning says
// what is missing. A payment that can never have a fee here (no reference on the till record,
// another card processor, or one the processor shows as not taken) never holds the day.

import { checkTenders, refundParts, isVoidedCheck } from './accountingDay.js';
import { clearingFor, dayLabel, cardFeeWayStarted } from './xeroInvoicePlan.js';
import { wallClock } from './businessDay.js';
import { venuePayoutLine, isCountedPayment } from './venueFees.ts';
import { venueSite } from './accountingData.ts';

type Dict = Record<string, any>;
export type CardFeeItem = { checkId: string; minor: number; psp: string | null; other?: boolean };
export type CardFeeItems = { cardAccount: string | null; sales: CardFeeItem[]; refunds: CardFeeItem[]; cardSales: number; cardRefunds: number };
export type CardFeeUnknown = { side: 'sale' | 'refund'; reason: string; count: number; amount: number; checkIds: string[] };
export type CardFees = {
  charged: number; returned: number; cardSales: number; cardRefunds: number;
  sales: { count: number; known: number }; refunds: { count: number; known: number };
  unknown: CardFeeUnknown[]; account?: string;
};

// How long a day waits for a fee that can still arrive, from the END of its business day. The
// nightly run first tries a day 4 hours after it ended and then every hour for 24 hours, and it
// only ever targets the last finished day. So the wait ends 12 tries in and leaves 12 to post.
export const CARD_FEE_WAIT_MS = 16 * 3600 * 1000;

// Why a card payment has no fee here. The first two can still arrive, so they are the only ones
// a day waits for; the others never can.
const REASONS = ['no_payment', 'no_fee', 'no_reference', 'other_processor', 'not_taken'];
const WAITABLE = new Set(['no_payment', 'no_fee']);
const OK_LEG = new Set(['succeeded', 'accepted']);
const MAX_IDS = 25;
const CHUNK = 200;

/** The Adyen PSP reference inside a till's payment key: the text after the last dot. '' gives null. */
export function pspOf(ref: unknown): string | null {
  const s = String(ref ?? '').trim();
  if (!s) return null;
  return s.slice(s.lastIndexOf('.') + 1).trim() || null;
}

// A tender or refund leg that names a card processor other than ServOS Payments (Adyen): its
// fee is not in our records and never will be. Only believed when the tender also carries that
// processor's reference (see cardFeeItems): on a row written with no tenders the processor is
// the closed_checks column's old default ('stripe', on Adyen kiosk sales too) and says nothing.
const otherProcessor = (processor: unknown): boolean => {
  const p = String(processor ?? '').trim().toLowerCase();
  return !!p && p !== 'adyen';
};

/**
 * The card money of one business day, item by item, exactly as the invoice counts it
 * (buildAccountingDay): each card tender of each check that closed in the window, and each card
 * refund made in it, on the clearing account card:adyen is mapped to. A card tender mapped to
 * ANOTHER clearing account is out of scope (its payment is not the one the fee comes off).
 * cardSales and cardRefunds are the sums the planner checks against its own.
 */
export function cardFeeItems({ day, saleRows = [], refundRows = [], clearing = null }: { day: { fromMs: number; toMs: number }; saleRows?: any[]; refundRows?: any[]; clearing?: Dict | null }): CardFeeItems {
  const cardAccount: string | null = clearingFor({ kind: 'card', processor: 'adyen' }, clearing).account;
  const inScope = (processor: unknown) => !!cardAccount && clearingFor({ kind: 'card', processor }, clearing).account === cardAccount;
  const item = (checkId: string, minor: number, ref: unknown, processor: unknown): CardFeeItem => {
    const psp = pspOf(ref);
    return psp && otherProcessor(processor) ? { checkId, minor, psp: null, other: true } : { checkId, minor, psp };
  };

  const sales: CardFeeItem[] = [];
  const seen = new Set<string>();
  for (const row of saleRows || []) {
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    const at = Date.parse(row.closed_at);
    if (!(at >= day.fromMs && at < day.toMs)) continue;
    if (isVoidedCheck(row)) continue;
    for (const t of checkTenders(row).tenders as any[]) {
      const minor = t.amount + t.tip;
      if (t.kind !== 'card' || !(minor > 0) || !inScope(t.processor)) continue;
      sales.push(item(row.id, minor, t.pspRef, t.processor));
    }
  }

  const refunds: CardFeeItem[] = [];
  const seenRefund = new Set<string>();
  for (const row of refundRows || []) {
    if (!row || isVoidedCheck(row)) continue;
    const list: any[] = Array.isArray(row.refunds) ? row.refunds : [];
    list.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') return;
      const rid = `${row.id}:${entry.id || i}`;
      if (seenRefund.has(rid)) return;
      seenRefund.add(rid);
      const r: any = refundParts(entry, row, null);
      const at = r.atMs == null ? Date.parse(row.closed_at) : r.atMs;
      if (!(at >= day.fromMs && at < day.toMs) || r.skipped) return;
      // The card money this refund put back on the card clearing account, as the invoice counts it.
      let cardLeft = 0;
      for (const p of r.parts as any[]) if (p.kind === 'card' && p.gross > 0 && inScope(p.processor)) cardLeft += p.gross;
      // Each card reversal that went through names the payment it refunded (leg.id; leg.ref is
      // the refund's own reference). Never more than the card money the invoice counts.
      for (const leg of (Array.isArray(entry.legs) ? entry.legs : []) as any[]) {
        if (!leg || !OK_LEG.has(String(leg.status || '').toLowerCase())) continue;
        const m = Math.min(Math.max(0, Math.round(Number(leg.amountMinor) || 0)), cardLeft);
        if (m > 0) { refunds.push(item(row.id, m, leg.id, leg.processor)); cardLeft -= m; }
      }
      // Card money refunded with no processor reversal recorded: no payment to take a fee from.
      if (cardLeft > 0) refunds.push({ checkId: row.id, minor: cardLeft, psp: null });
    });
  }
  const total = (list: CardFeeItem[]) => list.reduce((s, x) => s + x.minor, 0);
  return { cardAccount, sales, refunds, cardSales: total(sales), cardRefunds: total(refunds) };
}

/**
 * The fees of those items. `paymentsByPsp` holds the adyen_payments rows by PSP reference (a Map
 * or a plain object). charged is the fee on the day's card sales, returned the fee given back on
 * its card refunds; both hold KNOWN fees only. Every item with no fee is counted in `unknown`
 * with the reason:
 *   no_reference     the till record has no processor reference (never arrives)
 *   other_processor  the reference is another card processor's (never arrives)
 *   no_payment       no payment row for the reference yet (can still arrive)
 *   no_fee           the payment was taken and has no fee stamped yet (can still arrive)
 *   not_taken        the processor shows the payment as not taken, cancelled, a capture that
 *                    failed or a hold never captured (never arrives)
 */
export function sumCardFees(items: CardFeeItems, paymentsByPsp: Map<string, Dict> | Dict | null): CardFees {
  const get = (psp: string): Dict | null => (paymentsByPsp instanceof Map ? paymentsByPsp.get(psp) : (paymentsByPsp as Dict | null)?.[psp]) || null;
  let charged = 0, returned = 0;
  const sales = { count: 0, known: 0 }, refunds = { count: 0, known: 0 };
  const unknown = new Map<string, CardFeeUnknown>();
  const miss = (side: 'sale' | 'refund', reason: string, it: CardFeeItem) => {
    const k = `${side}|${reason}`;
    const u = unknown.get(k) || { side, reason, count: 0, amount: 0, checkIds: [] };
    u.count += 1; u.amount += it.minor;
    if (it.checkId && u.checkIds.length < MAX_IDS && !u.checkIds.includes(it.checkId)) u.checkIds.push(it.checkId);
    unknown.set(k, u);
  };
  // Why a payment row gives no fee: taken and not stamped yet, or never taken.
  const unrated = (row: Dict) => (isCountedPayment(row) && (row.commission_minor === null || row.commission_minor === undefined) ? 'no_fee' : 'not_taken');

  // One payment, one fee: a reference on two sale tenders is charged once, and reads the same both times.
  const seenSale = new Map<string, string | null>();
  for (const it of items?.sales || []) {
    sales.count += 1;
    if (it.other) { miss('sale', 'other_processor', it); continue; }
    if (!it.psp) { miss('sale', 'no_reference', it); continue; }
    if (seenSale.has(it.psp)) {
      const before = seenSale.get(it.psp);
      if (before) miss('sale', before, it); else sales.known += 1;
      continue;
    }
    const row = get(it.psp);
    const f = row ? venuePayoutLine({ line_type: 'Settled', gross_minor: row.amount_minor }, row) : null;
    const reason = !row ? 'no_payment' : !f || f.unrated ? unrated(row) : null;
    seenSale.set(it.psp, reason);
    if (reason) { miss('sale', reason, it); continue; }
    charged += Math.max(0, Math.round(Number(f!.fee_minor) || 0));
    sales.known += 1;
  }
  for (const it of items?.refunds || []) {
    refunds.count += 1;
    if (it.other) { miss('refund', 'other_processor', it); continue; }
    if (!it.psp) { miss('refund', 'no_reference', it); continue; }
    const row = get(it.psp);
    if (!row) { miss('refund', 'no_payment', it); continue; }
    // The refund line of Back Office Payouts: the fee this refund gave back, as a minus fee.
    const f = venuePayoutLine({ line_type: 'Refunded', gross_minor: -it.minor }, row);
    if (!f || f.unrated) { miss('refund', unrated(row), it); continue; }
    returned += Math.abs(Math.round(Number(f.fee_minor) || 0));
    refunds.known += 1;
  }
  const order = (u: CardFeeUnknown) => (u.side === 'sale' ? 0 : 10) + REASONS.indexOf(u.reason);
  return {
    charged, returned, cardSales: items?.cardSales || 0, cardRefunds: items?.cardRefunds || 0, sales, refunds,
    unknown: [...unknown.values()].sort((a, b) => order(a) - order(b)),
  };
}

/**
 * Whether the day must wait for its card fees: null, or { code: 'card_fees_wait', untilMs,
 * count, amount, message }. It waits only for fees that can still arrive, and only until
 * CARD_FEE_WAIT_MS after the business day ended (dayEndMs). The words give that time on the
 * venue's own clock.
 */
export function cardFeesWait(fees: CardFees | null | undefined, { dayEndMs, nowMs, timezone }: { dayEndMs: number; nowMs: number; timezone?: string | null }) {
  const waiting = (fees?.unknown || []).filter((u) => WAITABLE.has(u.reason));
  if (!waiting.length) return null;
  const untilMs = dayEndMs + CARD_FEE_WAIT_MS;
  if (!(nowMs < untilMs)) return null;
  const count = waiting.reduce((s, u) => s + u.count, 0);
  const amount = waiting.reduce((s, u) => s + u.amount, 0);
  const w = wallClock(untilMs, timezone);
  const hhmm = `${String(Math.floor(w.minutes / 60)).padStart(2, '0')}:${String(w.minutes % 60).padStart(2, '0')}`;
  const one = count === 1;
  const message = `Waiting for card fees. ${one ? '1 card payment has' : `${count} card payments have`} no fee from the card processor yet (${(Math.round(amount) / 100).toFixed(2)}). `
    + `ServOS tries again every hour. If ${one ? 'it is' : 'they are'} still missing at ${hhmm} on ${dayLabel(w.ymd)}, this day posts with the fees it has and says what is missing. Nothing has been posted yet.`;
  return { code: 'card_fees_wait', untilMs, count, amount, message };
}

// What venueFees needs to rate a payment (the aliases adyen-financial's CAPTURE_COLS uses).
// Adyen's own cost (fee_minor, fee_breakdown) is not in this list and must never be.
export const CARD_FEE_COLS = 'psp_reference, location_id, amount_minor, amount_refunded_minor, success, last_event_code, commission_minor, authorised_at, capture_required, captured_at, '
  + 'applied_mods:raw->applied_modifications, captured_minor:raw->captured_minor, last_mod_code:raw->last_modification->>eventCode, last_mod_ok:raw->last_modification->>success, last_mod_amount:raw->last_modification->amount->>value';

/**
 * Read the day's card fees from the Platform database. `rows` are the day's closed_checks rows
 * ({ sale, refund }, as loadInvoiceDay returns them). The payments are read by their PSP
 * reference, fenced to this venue's Platform location (its id there may differ from the Ops id;
 * locations.ops_location_id links them), 200 at a time, so no read can be cut at 1,000 rows. A
 * day with no card reference to look up makes no read. A read that fails THROWS: the caller
 * must never post a day on fees it could not read.
 */
export async function loadCardFees(platform: any, opsLocationId: string, { day, rows, clearing, platformId = null }: { day: { fromMs: number; toMs: number }; rows: { sale?: any[]; refund?: any[] } | null | undefined; clearing?: Dict | null; platformId?: string | null }): Promise<CardFees> {
  const items = cardFeeItems({ day, saleRows: rows?.sale || [], refundRows: rows?.refund || [], clearing });
  const psps = [...new Set([...items.sales, ...items.refunds].map((i) => i.psp).filter(Boolean))] as string[];
  const found = new Map<string, Dict>();
  if (!psps.length) return sumCardFees(items, found);
  let pid: string | null = platformId || null;
  if (!pid) {
    try { pid = (await venueSite(platform, opsLocationId)).platformId; }
    catch (e) { throw new Error(`Could not read the card fees: ${(e as Error)?.message || String(e)}`); }
  }
  if (!pid) throw new Error('This venue has no card payments record, so its card fees cannot be read.');
  for (let i = 0; i < psps.length; i += CHUNK) {
    const { data, error } = await platform.from('adyen_payments').select(CARD_FEE_COLS).eq('location_id', pid).in('psp_reference', psps.slice(i, i + CHUNK));
    if (error) throw new Error(`Could not read the card fees: ${error.message}`);
    for (const r of data || []) if (r?.psp_reference) found.set(String(r.psp_reference), r);
  }
  return sumCardFees(items, found);
}

/**
 * The card fees every plan of one day is made with, as xero-sales asks for them. Returns
 * { cardFees, wait, started }:
 *   started 'on'   part of the day is in Xero (or on its way) WITH card fees: the figures on its
 *                  log row, and NO read. The day finishes with what it was sent with.
 *   started 'off'  part of the day was sent without them: none, and no read.
 *   free           by the mapping: none when card fees are not switched on, else a fresh read,
 *                  with `wait` set while a fee that can still arrive is missing (never with
 *                  noWait: a replace day whose old entries are already being removed).
 * `detailRow` is the detail of the log row (the one the run HOLDS, for a real post); `loaded` is
 * loadInvoiceDay's answer. storedOnly: a day already posted is only ever planned with what is on
 * its row. A read that fails throws.
 */
export async function cardFeesFor(platform: any, o: { detailRow: any; mapping: any; locationId: string; loaded: any; venue?: any; site?: any; nowMs?: number; noWait?: boolean; storedOnly?: boolean }): Promise<{ cardFees: CardFees | null; wait: ReturnType<typeof cardFeesWait>; started: null | 'on' | 'off' }> {
  const started = cardFeeWayStarted(o.detailRow);
  if (started === 'on') return { cardFees: o.detailRow.cardFees, wait: null, started };
  if (started === 'off' || o.storedOnly || o.mapping?.cardFees?.enabled !== true) return { cardFees: null, wait: null, started };
  const fees = await loadCardFees(platform, o.locationId, { day: o.loaded.day, rows: o.loaded.rows, clearing: o.mapping.clearing, platformId: o.site?.platformId || null });
  const wait = o.noWait ? null : cardFeesWait(fees, { dayEndMs: o.loaded.day.toMs, nowMs: o.nowMs ?? Date.now(), timezone: o.venue?.timezone });
  return { cardFees: { ...fees, account: o.mapping.cardFees.account }, wait, started };
}
