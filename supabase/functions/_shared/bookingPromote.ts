// supabase/functions/_shared/bookingPromote.ts
//
// The ONE server door that turns a paid booking into a confirmed one
// (10 Sep 2026, Peter: "payment must be paid before booking confirms on the
// system"). Used by booking-widget (booking_pay, booking_pay_details) and by
// adyen-webhook (the async backstop). The pure rules live in
// ./bookingPayment.js; this file only does the database work.
//
// Order of doors:
//   1. public.promote_paid_booking (migration 20260910): one transaction under
//      the venue's booking lock, so a late payment can never promote onto a
//      table another booking just took.
//   2. Before that migration is applied the function does not exist, so the
//      same checks run here with plain reads (not atomic, but the same rules).
//
// Only pending_payment promotes, or expired when its tables are still free
// (no other booking on them, and today no live till tab on them either).
// cancelled, no_show, departed and dining never promote.
//
// TESTED: src/lib/bookings/bookingPromote.test.js imports this file directly
// (Node strips the types) with a fake PostgREST client.

import {
  promotedStatusFor, promotionDecision, tablesStillFree, liveTabOnTables,
  paymentDue, storedDue, dueForCharge,
} from './bookingPayment.js';

// deno-lint-ignore no-explicit-any
type Db = any;
type DbError = { code?: unknown; message?: unknown; details?: unknown; hint?: unknown } | null | undefined;

export type PromoteResult = {
  ok: boolean;
  promoted: boolean;
  status: string | null;
  error?: string;
};

const errText = (e: DbError) => [e?.message, e?.details, e?.hint].map((v) => String(v ?? '')).join(' ');

// PostgREST's two shapes for a column that is not there yet: 42703 on a
// select, PGRST204 on a write (same test as adyen-terminal-admin).
export function isMissingColumnError(e: DbError, column?: string): boolean {
  if (!e) return false;
  const code = String(e.code ?? '');
  const text = errText(e);
  if (column && !text.includes(column)) return false;
  return code === '42703' || code === 'PGRST204' || /does not exist|schema cache|could not find the '/i.test(text);
}

// A function that is not there yet: PGRST202 from PostgREST, 42883 from Postgres.
export function isMissingFunctionError(e: DbError): boolean {
  if (!e) return false;
  const code = String(e.code ?? '');
  return code === 'PGRST202' || code === '42883' || /could not find the function/i.test(errText(e));
}

// A status the booking_payments check constraint does not allow yet (23514).
const isCheckViolation = (e: DbError) => String(e?.code ?? '') === '23514' || /violates check constraint/i.test(errText(e));

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// The venue's today (YYYY-MM-DD) on its own clock, never the server's.
export function venueTodayFor(tz: unknown, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: String(tz || 'Europe/London'), year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }
}

const BOOKING_COLS = 'id, location_id, booking_date, start_time, turn_minutes, status, primary_table_id';

// Are this booking's tables still free for its own slot? null = could not read.
async function tablesFreeNow(db: Db, bk: Record<string, unknown>): Promise<boolean | null> {
  const [{ data: rows, error: rowsErr }, { data: mineRows, error: mineErr }] = await Promise.all([
    db.from('bookings')
      .select('id, status, start_time, turn_minutes, primary_table_id')
      .eq('location_id', bk.location_id).eq('booking_date', bk.booking_date),
    db.from('booking_tables').select('table_id').eq('booking_id', bk.id),
  ]);
  if (rowsErr || mineErr) return null;
  const ids = (rows || []).map((r: Record<string, unknown>) => r.id);
  const members = new Map<string, string[]>();
  if (ids.length) {
    const { data: bt, error: btErr } = await db.from('booking_tables').select('booking_id, table_id').in('booking_id', ids);
    if (btErr) return null;
    for (const r of bt || []) members.set(String(r.booking_id), [...(members.get(String(r.booking_id)) || []), String(r.table_id)]);
  }
  const mine = {
    id: bk.id,
    start_time: bk.start_time,
    turn_minutes: bk.turn_minutes,
    primary_table_id: bk.primary_table_id,
    tables: (mineRows || []).map((r: Record<string, unknown>) => String(r.table_id)),
  };
  const others = (rows || []).map((r: Record<string, unknown>) => ({ ...r, tables: members.get(String(r.id)) || [] }));
  return tablesStillFree(mine, others);
}

// Is a live till tab open on this booking's tables today? A walk-in opened
// straight on the till writes no bookings row, so neither promote_paid_booking
// nor the free check above can see it. null = could not read.
async function liveTabNow(db: Db, bk: Record<string, unknown>): Promise<boolean | null> {
  const [{ data: loc, error: locErr }, { data: mineRows, error: mineErr }] = await Promise.all([
    db.from('locations').select('timezone').eq('id', bk.location_id).maybeSingle(),
    db.from('booking_tables').select('table_id').eq('booking_id', bk.id),
  ]);
  if (locErr || mineErr) return null;
  const today = venueTodayFor(loc?.timezone);
  if (String(bk.booking_date ?? '').slice(0, 10) !== today) return false;
  const tableIds = [...new Set([
    ...(mineRows || []).map((r: Record<string, unknown>) => String(r.table_id)),
    ...(bk.primary_table_id ? [String(bk.primary_table_id)] : []),
  ])];
  if (!tableIds.length) return false;
  const { data: sessions, error: sErr } = await db.from('active_sessions')
    .select('table_id, session').eq('location_id', bk.location_id).in('table_id', tableIds);
  if (sErr) return null;
  return liveTabOnTables({ bookingDate: bk.booking_date, today, tableIds, sessions: sessions || [] });
}

// Promote one booking after its payment was authorised and checked.
//   { ok:true, promoted:true }   moved to prepaid or confirmed just now
//   { ok:true, promoted:false }  already at that status
//   { ok:false, error:'table_taken', status:'expired' }  paid too late, refund it
//   { ok:false, error:'not_promotable', status }         cancelled, no_show, dining ...
//   { ok:false, error:'unknown_booking' }                the booking is gone
//   { ok:false, error:'lookup_failed' | 'promote_failed' } may succeed later
export async function promotePaidBooking(db: Db, bookingId: string, kind: string): Promise<PromoteResult> {
  const next = promotedStatusFor(kind);

  const { data: bk, error: bkErr } = await db.from('bookings').select(BOOKING_COLS).eq('id', bookingId).maybeSingle();
  if (bkErr) return { ok: false, promoted: false, status: null, error: 'lookup_failed' };
  if (!bk) return { ok: false, promoted: false, status: null, error: 'unknown_booking' };

  // A late payment on an expired booking must not come back onto a table a
  // live till tab now holds (10 Sep 2026 review). Checked before either door.
  if (bk.status === 'expired') {
    const tab = await liveTabNow(db, bk);
    if (tab === null) return { ok: false, promoted: false, status: bk.status, error: 'lookup_failed' };
    if (tab) return { ok: false, promoted: false, status: 'expired', error: 'table_taken' };
  }

  const { data, error } = await db.rpc('promote_paid_booking', { p_booking_id: bookingId, p_next_status: next });
  if (!error && data && typeof data === 'object') {
    return {
      ok: !!data.ok,
      promoted: !!data.promoted,
      status: data.status ?? null,
      ...(data.error ? { error: String(data.error) } : {}),
    };
  }
  if (error && !isMissingFunctionError(error)) {
    console.error('[bookingPromote] promote_paid_booking failed:', errText(error));
    return { ok: false, promoted: false, status: null, error: 'promote_failed' };
  }

  // Fallback until migration 20260910 is applied.
  let decision = promotionDecision({ status: bk.status, nextStatus: next });
  if (decision === 'check_tables') {
    const free = await tablesFreeNow(db, bk);
    if (free === null) return { ok: false, promoted: false, status: bk.status, error: 'lookup_failed' };
    decision = promotionDecision({ status: bk.status, nextStatus: next, tablesFree: free });
  }
  if (decision === 'already') return { ok: true, promoted: false, status: next };
  if (decision === 'needs_refund') return { ok: false, promoted: false, status: bk.status, error: 'table_taken' };
  if (decision !== 'promote') return { ok: false, promoted: false, status: bk.status, error: 'not_promotable' };

  const { data: moved, error: moveErr } = await db.from('bookings')
    .update({ status: next }).eq('id', bookingId).eq('status', bk.status).select('id');
  if (moveErr) return { ok: false, promoted: false, status: bk.status, error: 'promote_failed' };
  if (!moved?.length) {
    // Someone changed it between the read and the write: say what it is now.
    const { data: cur } = await db.from('bookings').select('status').eq('id', bookingId).maybeSingle();
    if (cur?.status === next) return { ok: true, promoted: false, status: next };
    if (!cur) return { ok: false, promoted: false, status: null, error: 'unknown_booking' };
    return { ok: false, promoted: false, status: cur?.status ?? null, error: 'not_promotable' };
  }
  return { ok: true, promoted: true, status: next };
}

// What a booking owes RIGHT NOW, for a charge or a promote (10 Sep 2026
// review). Never one source alone (dueForCharge in bookingPayment.js):
//   - what the widget stored at book time (payment_* columns, migration 20260910)
//   - the booking's own package, fetched by id (inactive packages included)
//   - the package and party in the widget's booking_requests audit row, which
//     no browser can write (20260811b revokes it from anon and authenticated)
//   - the venue's current card hold rule
// Before the migration the columns do not exist and the read retries without them.
//   { ok:true, due, booking }   due null = nothing owed
//   { ok:false, error:'lookup_failed' | 'unknown_booking' | 'due_mismatch', booking? }
export async function loadBookingDue(db: Db, bookingId: string): Promise<
  { ok: true; due: { kind: string; amountMinor: number; currency: string | null } | null; booking: Record<string, unknown> }
  | { ok: false; error: string; booking?: Record<string, unknown> }
> {
  const BASE = 'id, location_id, covers, status, customer_id, customer, package_id, booking_date, start_time, source';
  let res = await db.from('bookings').select(`${BASE}, payment_kind, payment_due_minor, payment_currency`).eq('id', bookingId).maybeSingle();
  if (res.error && isMissingColumnError(res.error)) {
    res = await db.from('bookings').select(BASE).eq('id', bookingId).maybeSingle();
  }
  if (res.error) return { ok: false, error: 'lookup_failed' };
  const bk = res.data as Record<string, unknown> | null;
  if (!bk) return { ok: false, error: 'unknown_booking' };

  const [rulesRes, reqRes] = await Promise.all([
    db.from('booking_rules').select('card_capture_enabled, hold_per_cover, card_capture_min_covers')
      .eq('location_id', bk.location_id).maybeSingle(),
    db.from('booking_requests').select('payload').eq('booking_id', bookingId)
      .order('created_at', { ascending: true }).limit(1),
  ]);
  if (rulesRes.error || reqRes.error) return { ok: false, error: 'lookup_failed', booking: bk };
  const rules = rulesRes.data || null;
  const req = (reqRes.data?.[0]?.payload || null) as Record<string, unknown> | null;

  const ownId = bk.package_id ? String(bk.package_id) : null;
  const reqId = req?.package_id ? String(req.package_id) : null;
  const ids = [...new Set([ownId, reqId].filter(Boolean))] as string[];
  let pkgs: Record<string, unknown>[] = [];
  if (ids.length) {
    const { data: p, error: pErr } = await db.from('packages').select('*').in('id', ids);
    if (pErr) return { ok: false, error: 'lookup_failed', booking: bk };
    pkgs = p || [];
  }
  const pkgOf = (id: string | null) => (id ? pkgs.find((p) => String(p.id) === id) || null : null);
  // The larger party wins: a party edited down in a browser never shrinks a per cover charge.
  const covers = Math.max(1, Math.round(num(bk.covers)), Math.round(num(req?.party)));
  const recomputed = [
    paymentDue({ covers, pkg: pkgOf(ownId), rules }),
    ...(reqId && reqId !== ownId ? [paymentDue({ covers, pkg: pkgOf(reqId), rules })] : []),
  ];
  const pick = dueForCharge({ stored: storedDue(bk), recomputed });
  if (!pick.ok) return { ok: false, error: pick.reason || 'due_mismatch', booking: bk };
  return { ok: true, due: pick.due, booking: bk };
}

const MONEY_SYMBOL: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };
const moneyText = (amount: unknown, currency: unknown) => {
  const code = String(currency || 'GBP').toUpperCase();
  const v = num(amount).toFixed(2);
  return MONEY_SYMBOL[code] ? `${MONEY_SYMBOL[code]}${v}` : `${code} ${v}`;
};

// Money that landed but cannot secure its booking: the money must go back.
// Marks the rows needs_refund with a reason, and raises it on the venue's
// activity feed (the till bell) so staff see it without opening the booking.
// Before migration 20260910 the status is not allowed yet, so the status is
// kept and the reason carries "NEEDS REFUND: ...", which the host stand also
// reads as needs refund (isNeedsRefundRow).
//   reason   plain words, e.g. "the party was seated before the payment arrived"
//   context  { guestName, time } for the alert sentence (no ids in sentences)
export async function markPaymentNeedsRefund(
  db: Db, rowIds: string[], reason: string, context: { guestName?: string | null; time?: string | null } = {},
): Promise<void> {
  const ids = [...new Set((rowIds || []).filter(Boolean).map(String))];
  if (!ids.length) {
    console.error('[bookingPromote] NEEDS REFUND but no payment row to mark:', reason);
    return;
  }
  const { data: before } = await db.from('booking_payments')
    .select('id, location_id, booking_id, kind, amount, currency').in('id', ids);
  const text = `needs refund: ${reason}`.slice(0, 300);
  const { error } = await db.from('booking_payments').update({ status: 'needs_refund', refusal_reason: text }).in('id', ids);
  if (!error) {
    console.error('[bookingPromote] payment marked needs_refund:', ids.join(','), reason);
  } else if (!isCheckViolation(error)) {
    console.error('[bookingPromote] needs_refund mark failed:', errText(error), ids.join(','), reason);
  } else {
    const { error: e2 } = await db.from('booking_payments').update({ refusal_reason: `NEEDS REFUND: ${reason}`.slice(0, 300) }).in('id', ids);
    console.error('[bookingPromote] NEEDS REFUND (status kept until migration 20260910):', ids.join(','), reason, e2 ? errText(e2) : '');
  }

  // The alert. Only for money: a saved card (hold) took nothing, so there is
  // nothing to give back.
  for (const r of (before || []) as Record<string, unknown>[]) {
    if (r.kind !== 'prepay' && r.kind !== 'deposit') continue;
    if (!r.location_id) continue;
    const who = [context.guestName ? `for ${context.guestName}` : null, context.time ? `at ${String(context.time).slice(0, 5)}` : null]
      .filter(Boolean).join(' ');
    const body = `${moneyText(r.amount, r.currency)} was paid online${who ? ` ${who}` : ''}, but ${reason}. Refund the guest in Adyen.`;
    const { error: alertErr } = await db.from('activity_events').insert({
      location_id: r.location_id,
      kind: 'system',
      severity: 'urgent',
      title: 'Online booking payment needs a refund',
      body,
      ref_type: 'booking',
      ref_id: r.booking_id ? String(r.booking_id) : null,
    });
    if (alertErr) console.error('[bookingPromote] could not raise the refund alert:', errText(alertErr));
  }
}
