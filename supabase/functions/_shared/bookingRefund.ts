// supabase/functions/_shared/bookingRefund.ts
//
// TABLE BOOKING REFUNDS (16 Oct 2026, v5.11.70 host tools). The database half
// of a booking refund, shared by adyen-modify (which asks Adyen) and
// adyen-webhook (which hears the answer). The pure rules are in
// ./bookingHost.js (node tested); this file only reads and writes rows.
//
// A refund is its own booking_payments row: kind 'refund', status pending,
// then refunded (Adyen's REFUND event) or failed (REFUND_FAILED, or REFUND
// with success false). It names the payment it gives back in its merchant
// reference (bkrf-<payment id>-<n>) and, after migration 20261016d, in
// refund_of. The payment keeps amount_refunded_minor (pending and settled
// refunds, never failed ones) and becomes 'refunded' only once the whole
// amount went back, so a part refund leaves the rest as credit on the bill.
//
// TESTED: src/lib/bookings/bookingRefund.test.js drives this file with a fake
// PostgREST client (Node strips the types).

import { parseRefundReference, refundedMinorFor, refundRowsFor, parentAfterRefund, refundDueAfter } from './bookingHost.js';

// deno-lint-ignore no-explicit-any
type Db = any;
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

const missingColumn = (e: Row | null | undefined) => !!e
  && (String(e.code ?? '') === '42703' || String(e.code ?? '') === 'PGRST204'
    || /does not exist|schema cache|could not find the '/i.test(String(e.message ?? '')));

// Recount what has gone back on one payment and store it. Before the migration
// amount_refunded_minor is not there: only the status moves (a full refund).
//   -> { ok, refundedMinor, status } | { ok:false, error }
export async function recomputeRefunded(db: Db, parentId: string): Promise<Row> {
  // Newest columns first, then without them: amount_refunded_minor (20261016d), then
  // applied_minor and refund_due_minor (20261016b).
  const BASE = 'id, booking_id, kind, status, amount, applied_to_check';
  let pr = await db.from('booking_payments').select(`${BASE}, applied_minor, refund_due_minor, amount_refunded_minor`).eq('id', parentId).maybeSingle();
  let hasColumn = true;
  let hasDue = true;
  if (pr.error && missingColumn(pr.error)) {
    hasColumn = false;
    pr = await db.from('booking_payments').select(`${BASE}, applied_minor, refund_due_minor`).eq('id', parentId).maybeSingle();
    if (pr.error && missingColumn(pr.error)) {
      hasDue = false;
      pr = await db.from('booking_payments').select(BASE).eq('id', parentId).maybeSingle();
    }
  }
  if (pr.error || !pr.data) return { ok: false, error: pr.error?.message || 'payment not found' };
  const parent = { ...pr.data, amount_refunded_minor: 0 };
  let sib = await db.from('booking_payments').select('id, kind, status, amount, merchant_reference, refund_of').eq('booking_id', parent.booking_id).eq('kind', 'refund');
  if (sib.error && missingColumn(sib.error)) {
    sib = await db.from('booking_payments').select('id, kind, status, amount, merchant_reference').eq('booking_id', parent.booking_id).eq('kind', 'refund');
  }
  if (sib.error) return { ok: false, error: sib.error.message };
  const total = Math.round(Number(parent.amount) * 100) || 0;
  const mine = refundRowsFor(parent, sib.data || []);
  const back = refundedMinorFor(parent, sib.data || []);
  const settledBack = refundedMinorFor(parent, (sib.data || []).filter((r: Row) => r.status === 'refunded'));
  // The status follows only what Adyen has CONFIRMED; the column also counts pending refunds,
  // so the till stops counting that money as credit the moment the refund is asked for.
  const after = parentAfterRefund(parent, settledBack);
  const patch: Row = {};
  if (hasColumn) patch.amount_refunded_minor = Math.min(back, total);
  if (after.status === 'refunded' && ['captured', 'needs_refund'].includes(String(parent.status))) {
    patch.status = 'refunded';
  } else if (String(parent.status) === 'refunded' && settledBack < total
    && mine.reduce((s: number, r: Row) => s + (Math.round(Number(r.amount) * 100) || 0), 0) >= total) {
    // The refund rows made it refunded, then Adyen said one failed or was reversed
    // (REFUND_FAILED, REFUNDED_REVERSED): the money is the guest's credit again, and it can be
    // refunded again. A full refund made in Adyen's own screens has no rows and is left alone.
    patch.status = 'captured';
  }
  // A payment the bill used less of: what is still owed back drops as it is refunded, so the
  // stand stops saying "give it back" and never offers the same money twice.
  if (hasDue) {
    const due = refundDueAfter(parent, back);
    const had = parent.refund_due_minor === null || parent.refund_due_minor === undefined ? null : Math.round(Number(parent.refund_due_minor));
    if (due !== undefined && due !== had) {
      patch.refund_due_minor = due;
      patch.refund_reason = null;
    } else if (due === undefined && !parent.applied_to_check && had !== null && had > 0) {
      // Money not used on a bill yet, flagged as owed back by a guest party change (manage.ts
      // flagOwedBack): a stand refund lowers the figure by what went back since the last count
      // (a failed refund puts it back), never above what the payment still holds. Without this
      // the Diary kept saying "give back" after it was given (16 Oct 2026 release review).
      const prevBack = hasColumn ? Math.max(0, Math.round(Number(pr.data.amount_refunded_minor) || 0)) : 0;
      const step = hasColumn ? back - prevBack : 0;
      const left = Math.max(0, Math.min(had - step, total - back));
      if (left !== had) {
        patch.refund_due_minor = left > 0 ? left : null;
        if (left <= 0) patch.refund_reason = null;
      }
    }
  }
  if (Object.keys(patch).length) {
    const { error } = await db.from('booking_payments').update(patch).eq('id', parent.id);
    if (error) return { ok: false, error: error.message };
  }
  return { ok: true, refundedMinor: back, status: patch.status || parent.status };
}

// One Adyen REFUND / REFUND_FAILED / REFUNDED_REVERSED notification item. true
// when it belonged to a booking refund row (handled here), false otherwise so
// the caller carries on with its own handling.
export async function settleBookingRefundEvent(db: Db, item: Row): Promise<boolean> {
  const code = String(item?.eventCode || '');
  if (!['REFUND', 'REFUND_FAILED', 'REFUNDED_REVERSED'].includes(code)) return false;
  const ref = String(item?.merchantReference || '');
  const psp = String(item?.pspReference || '');
  let row: Row | null = null;
  if (parseRefundReference(ref)) {
    const { data } = await db.from('booking_payments').select('id, status, psp_reference, merchant_reference, refund_of')
      .eq('merchant_reference', ref).eq('kind', 'refund').order('created_at', { ascending: false }).limit(1);
    row = data?.[0] || null;
  }
  if (!row && psp) {
    const { data } = await db.from('booking_payments').select('id, status, psp_reference, merchant_reference, refund_of')
      .eq('psp_reference', psp).eq('kind', 'refund').limit(1);
    row = data?.[0] || null;
  }
  if (!row) return false;
  const ok = code === 'REFUND' && String(item?.success) === 'true';
  const patch: Row = ok
    ? { status: 'refunded', refusal_reason: null }
    : { status: 'failed', refusal_reason: `Refund ${code === 'REFUNDED_REVERSED' ? 'reversed by the bank' : 'failed'}${item?.reason ? `: ${String(item.reason).slice(0, 200)}` : ''}` };
  if (!row.psp_reference && psp) patch.psp_reference = psp;
  const { error } = await db.from('booking_payments').update(patch).eq('id', row.id);
  if (error) console.error('[bookingRefund] could not settle refund row', row.id, error.message);
  const parentId = row.refund_of || parseRefundReference(row.merchant_reference)?.parentId || null;
  if (parentId) {
    const r = await recomputeRefunded(db, String(parentId));
    if (!r.ok) console.error('[bookingRefund] could not recount the payment', parentId, r.error);
  }
  return true;
}

// A REFUND on a booking PAYMENT reference (bkpay-...), made outside the host
// stand (Adyen's own screens). A full refund keeps the old rule (the payment
// is refunded). A PART refund used to mark the whole payment refunded and
// wipe the guest's remaining credit (bookings audit, auditor 6): it is now
// written as a refund row instead, keyed on the event's own psp so an Adyen
// retry never counts it twice, and the payment is recounted.
//   -> 'part' when handled here (a part refund written, or the host stand's own pending refund
//      settled), 'full' when the caller should mark the payment refunded, 'none' when there is
//      no matching payment
export async function partRefundFromAdyen(db: Db, item: Row): Promise<'part' | 'full' | 'none'> {
  const original = String(item?.originalReference || '');
  const psp = String(item?.pspReference || '');
  if (!original) return 'none';
  const { data: parent } = await db.from('booking_payments').select('id, booking_id, location_id, kind, amount, currency, merchant_account')
    .eq('psp_reference', original).maybeSingle();
  if (!parent) return 'none';
  const value = Number(item?.amount?.value);
  const total = Math.round(Number(parent.amount) * 100) || 0;
  // A refund the host stand asked for whose answer came back before its psp was stored: settle
  // that pending row (same payment, same amount) rather than writing a second one.
  const { data: pend } = await db.from('booking_payments').select('id, amount, merchant_reference, refund_of, psp_reference')
    .eq('booking_id', parent.booking_id).eq('kind', 'refund').eq('status', 'pending');
  const mine = (pend || []).find((r: Row) => !r.psp_reference && Math.round(Number(r.amount) * 100) === Math.round(value)
    && (String(r.refund_of || '') === String(parent.id) || parseRefundReference(r.merchant_reference)?.parentId === String(parent.id).toLowerCase()));
  if (mine) {
    await db.from('booking_payments').update({ status: 'refunded', refusal_reason: null, ...(psp ? { psp_reference: psp } : {}) }).eq('id', mine.id);
    await recomputeRefunded(db, parent.id);
    return 'part';
  }
  if (!Number.isFinite(value) || value <= 0 || value >= total) return 'full';
  if (psp) {
    const { data: seen } = await db.from('booking_payments').select('id').eq('psp_reference', psp).limit(1);
    if (seen?.length) { await recomputeRefunded(db, parent.id); return 'part'; }
  }
  const row: Row = {
    location_id: parent.location_id, booking_id: parent.booking_id, kind: 'refund', status: 'refunded',
    amount: value / 100, currency: parent.currency || 'gbp', merchant_reference: `bkrf-${parent.id}-0`,
    merchant_account: parent.merchant_account || item?.merchantAccountCode || null, psp_reference: psp || null,
    refusal_reason: 'Part refund made in Adyen', refund_of: parent.id,
  };
  let ins = await db.from('booking_payments').insert(row);
  if (ins.error && missingColumn(ins.error)) {
    const { refund_of: _drop, ...bare } = row;
    ins = await db.from('booking_payments').insert(bare);
  }
  if (ins.error) console.error('[bookingRefund] could not write the part refund from Adyen:', ins.error.message);
  await recomputeRefunded(db, parent.id);
  return 'part';
}

