// supabase/functions/booking-charge
//
// THE NO SHOW AND LATE CANCEL CHARGE (16 Oct 2026, bookings audit section 3 item 3).
//
// Guests at a card hold venue save a card when they book online (booking-widget booking_pay:
// storePaymentMethod, recurringProcessingModel UnscheduledCardOnFile, shopperReference = the
// guest's customer id; the token lands on booking_payments.stored_payment_method_id and on
// customers.stored_payment_method_id). This is the only door that charges it.
//
//   POST { action: 'quote',  location_id, booking_id }
//        -> { ok, chargeable, kind, amountMinor, currency, last4, question, message, charges[] }
//   POST { action: 'charge', location_id, booking_id, expected_minor, staff_name }
//        -> { ok:true, charged:true, amountMinor, currency, last4, checkRef }
//         | { ok:false, error, message }      (message is plain words for the host)
//   POST { action: 'post_check', location_id, booking_id }
//        -> posts any charge that took money but is not on a check yet (also done on every quote)
//
// WHO: a paired host stand at that venue (waitlist_devices), a paired till (devices), or a Back
// Office login that may write at the venue (isVenueWriter). Same fence as customer-search.
//
// THE RULES live in ../_shared/noShowCharge.js (pure, tested, byte identical copy in src):
//   - only a no show, or a cancellation inside booking_rules.cancellation_window_hours (venue
//     clock), and only when THIS booking saved a card
//   - the fee is the hold the guest agreed to (stored due, the hold row, else hold per cover x covers)
//   - one charge per booking: a charge that took money, or one still waiting for the bank,
//     refuses another; the Adyen Idempotency-Key is the booking and the attempt, so a double tap
//     replays Adyen's first answer instead of charging twice; migration 20261016f adds a unique
//     index as the database's own guard (the function works before it, without the index)
//   - the amount the host was shown (expected_minor) must be the amount charged
//   - a refusal is said in words and NOTHING is retried by itself; the host may try again
//
// ADYEN: /payments with paymentMethod { type: 'scheme', storedPaymentMethodId }, shopperReference,
// shopperInteraction ContAuth, recurringProcessingModel UnscheduledCardOnFile, the venue's store and
// merchant account, metadata.location_id (the PLATFORM id, so adyen-webhook files it under the venue,
// which is what lets the existing refund path refund it). Reference bkpay-<booking>-noshow-a<N>, so
// the Adyen ledger files it under bookings; adyen-webhook's bkpay settle leaves a captured row alone.
//
// THE MONEY REACHES THE BOOKS: a charge that took money is written as booking_payments kind
// no_show_charge (captured) and posted to a closed check (id bkns-<booking>-a<N>, ref NS-XXXXX,
// source 'booking', one line "No show charge", card tender with the psp), the same row shape as a
// sale, so Reports, the VAT and the Xero daily invoice pick it up; the row is then stamped
// applied_to_check with applied_check_id. Refunds go through the existing refund path (refund the
// check in History on the till or Transactions in Back Office: adyen-modify).
//
// DEPLOY (Peter runs it):
//   npx supabase functions deploy booking-charge --project-ref tbetcegmszzotrwdtqhi --no-verify-jwt
// (--no-verify-jwt like customer-search: the caller is checked here with getUser, and the host
// stand signs in anonymously.)

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  adyenConfig, adyenAccountForLocation, platformLocationIdFor, checkoutBase, adyenFetch,
  adyenNotConfiguredMessage, paymentIdempotencyKey, effectiveMerchantAccount, type AdyenConfig,
} from '../_shared/adyen.ts';
import { isVenueWriter } from '../_shared/venueWriter.js';
import { secondStepRefusal } from '../_shared/second-step.ts';
import {
  chargeDecision, chargeQuestion, chargeReference, nextAttempt, refusalWords, chargeCheckRow,
  chargeCheckIds, attemptOf, kindOfReference, feeRate, noShowRows, moneyText, NO_SHOW_KIND, TAKEN_STATUSES, chargeLabel,
} from '../_shared/noShowCharge.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const db = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '', {
  auth: { autoRefreshToken: false, persistSession: false },
});
const platformAdmin = createClient(
  Deno.env.get('PLATFORM_SUPABASE_URL') ?? '',
  Deno.env.get('PLATFORM_SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
const PAY_COLS = 'id, kind, status, amount, currency, card_last4, card_brand, stored_payment_method_id, refusal_reason, applied_to_check, applied_check_id, psp_reference, merchant_reference, created_at, captured_at';

const errText = (e: unknown) => {
  const x = e as { message?: unknown; details?: unknown; code?: unknown } | null;
  return [x?.message, x?.details].map((v) => String(v ?? '')).join(' ').trim();
};
const isUnique = (e: unknown) => String((e as { code?: unknown })?.code ?? '') === '23505' || /duplicate key/i.test(errText(e));

// The venue's Adyen set (same reads as booking-widget adyenCfgForOps; copied rather than shared so
// the public booking widget is not redeployed for this).
async function venueAdyen(opsLocationId: string): Promise<{ cfg: AdyenConfig; merchantAccount: string; store: string | null; platformId: string; currency: string } | null> {
  const platformId = await platformLocationIdFor(platformAdmin, opsLocationId);
  if (!platformId) return null;
  const [{ env, region, row }, ploc] = await Promise.all([
    adyenAccountForLocation<{ merchant_account?: string | null; store_id?: string | null; receive_payments_ok?: boolean | null }>(
      platformAdmin, platformId, ['merchant_account', 'store_id', 'receive_payments_ok']),
    platformAdmin.from('locations').select('currency').eq('id', platformId).maybeSingle(),
  ]);
  if (ploc?.error) throw new Error(`currency lookup failed: ${errText(ploc.error)}`);
  const cfg = adyenConfig(env, region);
  const c = String(ploc?.data?.currency ?? '').trim().toUpperCase();
  const currency = /^[A-Z]{3}$/.test(c) ? c : (cfg.region === 'US' ? 'USD' : 'GBP');
  const store = row?.receive_payments_ok && row?.store_id ? String(row.store_id) : null;
  return { cfg, merchantAccount: effectiveMerchantAccount(cfg, row?.merchant_account), store, platformId, currency };
}

// Everything the decision needs, read with the service role.
async function loadState(locationId: string, bookingId: string) {
  const BASE = 'id, location_id, booking_date, start_time, covers, status, customer_id, customer, cancelled_at, primary_table_id';
  let bkRes = await db.from('bookings').select(`${BASE}, payment_kind, payment_due_minor, payment_currency`)
    .eq('id', bookingId).eq('location_id', locationId).maybeSingle();
  if (bkRes.error && /payment_kind|payment_due_minor|payment_currency|does not exist|schema cache/i.test(errText(bkRes.error))) {
    bkRes = await db.from('bookings').select(BASE).eq('id', bookingId).eq('location_id', locationId).maybeSingle();
  }
  if (bkRes.error) throw new Error(`booking read failed: ${errText(bkRes.error)}`);
  const booking = bkRes.data as Row | null;
  if (!booking) return { booking: null } as const;
  const [payRes, rulesRes, locRes, custRes] = await Promise.all([
    db.from('booking_payments').select(PAY_COLS).eq('booking_id', bookingId).order('created_at', { ascending: true }),
    db.from('booking_rules').select('hold_per_cover, cancellation_window_hours').eq('location_id', locationId).maybeSingle(),
    db.from('locations').select('timezone, currency').eq('id', locationId).maybeSingle(),
    booking.customer_id
      ? db.from('customers').select('id, stored_payment_method_id, shopper_reference').eq('id', booking.customer_id).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ]);
  if (payRes.error) throw new Error(`payments read failed: ${errText(payRes.error)}`);
  if (rulesRes.error) throw new Error(`rules read failed: ${errText(rulesRes.error)}`);
  return {
    booking,
    payments: (payRes.data || []) as Row[],
    rules: (rulesRes.data || null) as Row | null,
    tz: String(locRes.data?.timezone || 'Europe/London'),
    currency: String(locRes.data?.currency || 'GBP').toUpperCase(),
    customer: (custRes?.data || null) as Row | null,
  };
}

// Post one charge row that took money to its closed check, then stamp the row. Idempotent: the
// check id is fixed per attempt and the insert ignores a duplicate.
async function postCheck(booking: Row, pay: Row, staffName: string | null): Promise<{ ok: boolean; checkId: string; ref: string; error?: string }> {
  const attempt = attemptOf(pay.merchant_reference);
  const { id, ref } = chargeCheckIds(booking.id, attempt);
  const { data: rates, error: ratesErr } = await db.from('tax_rates')
    .select('id, location_id, name, code, rate, type, applies_to, is_default, active').eq('location_id', booking.location_id);
  if (ratesErr) return { ok: false, checkId: id, ref, error: `tax rates could not be read (${errText(ratesErr)})` };
  const kind = kindOfReference(pay.merchant_reference);
  const row = chargeCheckRow({
    booking,
    charge: {
      pspReference: pay.psp_reference, amountMinor: Math.round(Number(pay.amount) * 100),
      currency: pay.currency, last4: pay.card_last4, brand: pay.card_brand, reference: pay.merchant_reference,
    },
    kind,
    rate: feeRate(rates || []),
    staffName,
    closedAt: pay.captured_at || new Date().toISOString(),
  });
  // A column this database does not have yet is left out and the insert tried again
  // (src/lib/closedCheckWrite.js keeps the same rule for every till).
  const payload: Row = { ...row };
  for (let i = 0; i < 6; i++) {
    const { error } = await db.from('closed_checks').upsert(payload, { onConflict: 'id', ignoreDuplicates: true });
    if (!error) break;
    const col = /Could not find the '([^']+)' column/.exec(String((error as { message?: unknown }).message || ''))?.[1];
    if (!col || !(col in payload) || col === 'id' || col === 'location_id') {
      return { ok: false, checkId: id, ref, error: errText(error) };
    }
    console.warn(`[booking-charge] closed_checks has no '${col}' column, posting without it`);
    delete payload[col];
  }
  const { error: stampErr } = await db.from('booking_payments')
    .update({ applied_to_check: true, applied_check_id: id }).eq('id', pay.id);
  if (stampErr) console.error('[booking-charge] check posted but the payment row was not stamped:', pay.id, errText(stampErr));
  return { ok: true, checkId: id, ref };
}

// Charges that took money but never reached a check (a failed post, or a webhook that settled a
// row whose answer never came back): posted now. Never charges anything.
async function healUnposted(booking: Row, payments: Row[], staffName: string | null) {
  for (const p of noShowRows(payments)) {
    if (!TAKEN_STATUSES.includes(p.status) || p.applied_to_check || !p.psp_reference) continue;
    const r = await postCheck(booking, p, staffName);
    if (r.ok) { p.applied_to_check = true; p.applied_check_id = r.checkId; }
    else console.error('[booking-charge] could not post the charge to a check:', p.id, r.error);
  }
}

const publicCharges = (bookingId: string, payments: Row[]) => noShowRows(payments).map((p) => ({
  kind: kindOfReference(p.merchant_reference),
  status: p.status,
  amountMinor: Math.round(Number(p.amount) * 100),
  currency: String(p.currency || '').toUpperCase(),
  last4: p.card_last4 || null,
  at: p.captured_at || p.created_at || null,
  refusal: p.status === 'failed' ? (p.refusal_reason || null) : null,
  onCheck: !!p.applied_to_check,
  checkRef: p.applied_to_check ? chargeCheckIds(bookingId, attemptOf(p.merchant_reference)).ref : null,
}));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const secondStepBlock = await secondStepRefusal(req); if (secondStepBlock) return secondStepBlock;
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  const token = (req.headers.get('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return json({ ok: false, error: 'Unauthorized' }, 401);
  const { data: { user } } = await db.auth.getUser(token);
  if (!user) return json({ ok: false, error: 'Invalid token' }, 401);

  let body: Row = {};
  try { body = await req.json(); } catch { return json({ ok: false, error: 'invalid json' }, 400); }
  const action = String(body.action || 'quote');
  const locationId = String(body.location_id || '');
  const bookingId = String(body.booking_id || '');
  const staffName = body.staff_name ? String(body.staff_name).slice(0, 80) : null;
  if (!locationId || !bookingId) return json({ ok: false, error: 'location_id and booking_id required' }, 400);
  if (!['quote', 'charge', 'post_check'].includes(action)) return json({ ok: false, error: `unknown action: ${action}` }, 400);

  // Who is asking, and for which venue?
  const [asUser, till, host] = await Promise.all([
    isVenueWriter(db, user, locationId).catch(() => false),
    db.from('devices').select('id').eq('device_uid', user.id).eq('location_id', locationId).in('status', ['active', 'online']).limit(1).maybeSingle(),
    db.from('waitlist_devices').select('id').eq('device_uid', user.id).eq('location_id', locationId).eq('active', true).limit(1).maybeSingle(),
  ]);
  if (!asUser && !till.data && !host.data) return json({ ok: false, error: 'No access to this location' }, 403);

  try {
    const st = await loadState(locationId, bookingId);
    if (!st.booking) return json({ ok: false, error: 'unknown_booking', message: 'This booking could not be found.' }, 404);
    const { booking, payments, rules, tz, customer } = st;
    let currency = st.currency;

    await healUnposted(booking, payments, staffName);
    if (action === 'post_check') return json({ ok: true, charges: publicCharges(bookingId, payments) });

    const decide = () => chargeDecision({ booking, payments, rules, customer, tz, currency });
    let d = decide();
    const quote = () => ({
      ok: true,
      chargeable: d.ok,
      kind: d.kind,
      label: d.kind ? chargeLabel(d.kind) : null,
      reason: d.reason,
      message: d.message,
      amountMinor: d.amountMinor,
      currency: d.currency,
      covers: d.covers,
      perCoverMinor: d.perCoverMinor,
      last4: d.last4,
      brand: d.brand,
      windowHours: d.windowHours,
      hoursBefore: d.hoursBefore,
      question: d.ok ? chargeQuestion(d) : null,
      charges: publicCharges(bookingId, payments),
    });
    if (action === 'quote') return json(quote());

    // ── charge ──
    if (!d.ok) return json({ ...quote(), ok: false, error: d.reason, message: d.message });
    const expected = body.expected_minor == null ? null : Math.round(Number(body.expected_minor));
    if (expected !== null && expected !== d.amountMinor) {
      return json({ ...quote(), ok: false, error: 'amount_changed', message: `The fee is now ${moneyText(d.amountMinor, d.currency)}, not ${moneyText(expected, d.currency)}. Check it and confirm again.` });
    }

    const v = await venueAdyen(locationId).catch((e) => { console.error('[booking-charge] Adyen config lookup failed:', errText(e)); return null; });
    if (!v || !v.cfg.configured || !v.merchantAccount) {
      const why = v?.cfg.live ? adyenNotConfiguredMessage(v.cfg) : 'card payments are not set up for this venue';
      return json({ ok: false, error: 'adyen_unavailable', message: `The card cannot be charged here: ${why}. Nothing was taken.` });
    }
    if (booking.payment_currency && String(booking.payment_currency).toUpperCase() !== v.currency) {
      return json({ ok: false, error: 'currency_changed', message: 'The venue currency changed since this booking was made. Nothing was taken.' });
    }
    currency = v.currency;
    d = decide();
    if (!d.ok) return json({ ...quote(), ok: false, error: d.reason, message: d.message });

    const attempt = nextAttempt(payments);
    const reference = chargeReference(bookingId, attempt, d.kind);
    const label = chargeLabel(d.kind);

    // The attempt row first, so a second tap (or a second stand) sees a charge in flight.
    const { data: ins, error: insErr } = await db.from('booking_payments').insert({
      location_id: locationId,
      booking_id: bookingId,
      kind: NO_SHOW_KIND,
      amount: d.amountMinor / 100,
      currency: currency.toLowerCase(),
      status: 'pending',
      merchant_reference: reference,
      merchant_account: v.merchantAccount,
      stored_payment_method_id: d.storedId,
      card_last4: d.last4,
      card_brand: d.brand,
      refusal_reason: 'waiting for the bank',
    }).select('id').maybeSingle();
    if (insErr) {
      if (isUnique(insErr)) return json({ ok: false, error: 'charge_in_flight', message: 'Another charge for this booking has just started. Nothing more was taken.' });
      console.error('[booking-charge] could not write the charge row:', errText(insErr));
      return json({ ok: false, error: 'ledger_failed', message: 'The charge could not be recorded, so it was not sent to the card. Nothing was taken.' }, 503);
    }
    const rowId = String(ins?.id);

    const payment: Row = {
      merchantAccount: v.merchantAccount,
      amount: { value: d.amountMinor, currency },
      reference,
      paymentMethod: { type: 'scheme', storedPaymentMethodId: d.storedId },
      shopperReference: d.shopperReference,
      shopperInteraction: 'ContAuth',
      recurringProcessingModel: 'UnscheduledCardOnFile',
      // adyen-webhook files the payment under this venue from it (resolveLocation step 0).
      metadata: { location_id: v.platformId, booking_id: bookingId.slice(0, 80), charge: label },
    };
    if (v.store) payment.store = v.store;

    let res: { ok: boolean; status: number; data: Row };
    try {
      res = await adyenFetch('POST', `${checkoutBase(v.cfg)}/payments`, payment,
        { cfg: v.cfg, idempotencyKey: await paymentIdempotencyKey(reference, attempt) });
    } catch (e) {
      // No answer (a timeout): the charge may still have gone through, so the row stays pending
      // and the webhook settles it. Never retried here.
      console.error('[booking-charge] no answer from Adyen for', reference, errText(e));
      await db.from('booking_payments').update({ refusal_reason: 'no answer from Adyen yet' }).eq('id', rowId);
      return json({ ok: false, pending: true, error: 'no_answer', message: 'No answer from the bank yet. Do not charge again: it shows here when Adyen answers.' });
    }
    const j = res.data ?? {};
    if (!res.ok) {
      const why = String(j.message || `refused (${res.status})`);
      console.error('[booking-charge] /payments refused:', res.status, JSON.stringify(j).slice(0, 300));
      await db.from('booking_payments').update({ status: 'failed', refusal_reason: why.slice(0, 300) }).eq('id', rowId);
      return json({ ok: false, error: 'adyen_refused', message: `Adyen did not accept the charge: ${why}. Nothing was taken.` });
    }

    const code = String(j.resultCode || '');
    const nowIso = new Date().toISOString();
    if (code === 'Authorised') {
      const last4 = j.additionalData?.cardSummary || d.last4 || null;
      const { error: upErr } = await db.from('booking_payments').update({
        status: 'captured',
        psp_reference: j.pspReference || null,
        card_last4: last4,
        refusal_reason: null,
        authorised_at: nowIso,
        captured_at: nowIso,
      }).eq('id', rowId);
      if (upErr) {
        if (isUnique(upErr)) {
          // Two attempts with the same key: Adyen replayed ONE payment. This row is the copy.
          await db.from('booking_payments').update({ status: 'cancelled', refusal_reason: 'duplicate of the same Adyen payment' }).eq('id', rowId);
        } else {
          console.error('[booking-charge] charge taken but the row was not updated:', rowId, errText(upErr));
        }
      }
      // Post it to a check (reports, VAT, Xero). The money is taken whatever happens here.
      const { data: fresh } = await db.from('booking_payments').select(PAY_COLS).eq('psp_reference', j.pspReference || '').maybeSingle();
      const pay = (fresh as Row | null) || {
        id: rowId, merchant_reference: reference, psp_reference: j.pspReference, amount: d.amountMinor / 100,
        currency: currency.toLowerCase(), card_last4: last4, card_brand: d.brand, captured_at: nowIso,
      };
      const posted = j.pspReference ? await postCheck(booking, pay, staffName) : { ok: false, checkId: '', ref: '', error: 'no psp reference' };
      return json({
        ok: true, charged: true, kind: d.kind, amountMinor: d.amountMinor, currency, last4,
        checkRef: posted.ok ? posted.ref : null, posted: posted.ok,
        message: posted.ok
          ? `${moneyText(d.amountMinor, currency)} charged${last4 ? ` to the card ending ${last4}` : ''}. It is on check ${posted.ref}.`
          : `${moneyText(d.amountMinor, currency)} charged${last4 ? ` to the card ending ${last4}` : ''}, but it could not be put on a check yet (${posted.error}). It is posted the next time this booking is opened.`,
      });
    }
    if (code === 'Received' || code === 'Pending') {
      await db.from('booking_payments').update({ psp_reference: j.pspReference || null, refusal_reason: 'waiting for the bank' }).eq('id', rowId);
      return json({ ok: false, pending: true, error: 'pending', message: 'The bank has not confirmed the charge yet. Do not charge again: it shows here when Adyen answers.' });
    }
    // Refused, Cancelled, Error, or anything else: nothing was taken.
    const words = refusalWords(code, j.refusalReason);
    await db.from('booking_payments').update({
      status: 'failed', psp_reference: j.pspReference || null, refusal_reason: String(j.refusalReason || code || 'refused').slice(0, 300),
    }).eq('id', rowId);
    return json({ ok: false, error: 'card_refused', resultCode: code || null, message: words });
  } catch (e) {
    console.error('[booking-charge]', e);
    return json({ ok: false, error: 'server_error', message: `Something went wrong: ${(e as Error).message || 'server error'}. Nothing was taken.` }, 500);
  }
});
