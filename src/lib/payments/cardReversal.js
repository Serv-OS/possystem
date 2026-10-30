/**
 * cardReversal.js — actually give the money back, on Adyen, the processor that took it.
 *
 * WHY THIS EXISTS (v5.6.79, task #107)
 *
 * Until then `store.refundCheck` was bookkeeping only for Adyen: it aimed every refund at a
 * processor that had never heard of the id, and the refund landed nowhere while the screen
 * said "processed". This module is the routing table (Adyen only since Drop D, 29 Oct 2026:
 * ServOS works with Adyen alone) plus the honest translation of Adyen's answer into one verdict.
 *
 * ADYEN'S CONTRACT:
 *
 *   adyen-modify    200 { ok: true, status: 'received', modification_psp } — but
 *                   ALSO 200 { ok: false, error, detail } when Adyen refused.
 *                   ⚠️ HTTP 200 DOES NOT MEAN SUCCESS HERE. Its deliberate
 *                   "graceful-fallback contract" hands scheme-level refusals back
 *                   as a 200 body so the caller can decide. Checking `res.ok`
 *                   alone would book every Adyen refusal as a completed refund —
 *                   precisely the failure this rebuild exists to prevent.
 *
 * Adyen never confirms synchronously: `received` means accepted for processing.
 * We report that as 'accepted', never 'succeeded'.
 *
 * A record whose processor is one ServOS no longer works with (an old Stripe or Ryft sale)
 * gets a plain refusal, never a guess at an endpoint: that money is refunded in the old
 * processor's own dashboard.
 *
 * ⚠️ `supabase-js` RESOLVES with { data, error } and never rejects, which is why
 * everything here uses plain `fetch` and reads the body — and why nothing in this
 * file uses `.then(ok, err)`. A dead error handler is how a broken money path
 * stays invisible.
 *
 * Static imports only — a dynamic import() silently fails in this Vite bundle.
 */

// Explicit .js — this module is unit-tested under `node --test`, whose ESM
// loader does not do Vite's extensionless resolution.
import { refundReference } from './refundMath.js';

/** Which edge function reverses a charge. Adyen is the only processor ServOS works with. */
export const REFUND_ENDPOINT = {
  adyen: 'adyen-modify',
};

/** Processors ServOS used to work with. Their sales are refunded in their own dashboards. */
export const RETIRED_PROCESSORS = Object.freeze(['stripe', 'ryft']);
export const RETIRED_PROCESSOR_MESSAGE = 'This payment was taken on a processor ServOS no longer works with; refund it in that processor\'s own dashboard';

/**
 * Normalise whatever the check says into a processor we can route to: 'adyen', or null.
 * Unknown stays unknown so the caller refuses loudly instead of firing at the wrong place.
 */
export function normaliseProcessor(p) {
  const s = String(p || '').toLowerCase();
  return REFUND_ENDPOINT[s] ? s : null;
}

/** True for a processor ServOS no longer works with (its refund is refused with a plain reason). */
export function isRetiredProcessor(p) {
  return RETIRED_PROCESSORS.includes(String(p || '').toLowerCase());
}

/** The request body for one Adyen leg. Exported for the unit tests. */
export function buildRefundBody({ legId, amountMinor, locationId, refundId, currency = 'GBP' }) {
  const reference = refundReference(refundId, legId);
  return {
    action: 'refund',
    // The leg id as the check recorded it. For an Adyen sale closed off a
    // terminal job that is the POI transaction id, NOT the pspReference Adyen's
    // /payments/{psp}/refunds needs — adyen-modify resolves one to the other
    // server-side against terminal_jobs, which is also what binds the payment
    // to the caller's venue. Never guess the translation client-side.
    psp_reference: legId,
    location_id: locationId,
    amount_minor: amountMinor,
    currency,
    // Supplying a reference is what makes adyen-modify's Idempotency-Key
    // DETERMINISTIC (`mod:<reference>`); without one it mints a random UUID and
    // a retry would refund twice. refundReference keeps it inside Adyen's
    // 64-char limit.
    reference,
  };
}

/**
 * Read Adyen's answer as a verdict. Exported so the shape is tested rather than trusted.
 *
 * @returns {{status:'accepted'|'failed', ref:string|null, error:string|null}}
 */
export function readRefundResponse(processor, httpOk, httpStatus, body) {
  const j = body && typeof body === 'object' ? body : {};
  // See the header note: a refusal arrives as HTTP 200 with ok:false.
  if (!httpOk || j.ok === false) {
    return { status: 'failed', ref: null, error: j.error || j.detail?.message || `adyen refund refused (HTTP ${httpStatus})` };
  }
  // 'received' is Adyen accepting the refund, not completing it.
  return { status: 'accepted', ref: j.modification_psp || j.reference || null, error: null };
}

/**
 * Reverse ONE leg. Never throws — a thrown error inside a loop over card legs
 * would strand the legs after it, so every failure comes back as a verdict the
 * caller records and can retry.
 *
 * The same `refundId` + `legId` always produce the same idempotency key, so
 * retrying a leg that actually went through returns the original outcome instead
 * of taking the money a second time.
 */
export async function reverseCardLeg({
  processor, legId, amountMinor, locationId, checkId, refundId, staffId,
  currency = 'GBP', reason = 'requested_by_customer', functionsUrl, token,
}) {
  if (isRetiredProcessor(processor)) {
    return { status: 'failed', ref: null, error: RETIRED_PROCESSOR_MESSAGE };
  }
  const p = normaliseProcessor(processor);
  if (!p) {
    return { status: 'failed', ref: null, error: `unknown processor "${processor}" — cannot route this refund` };
  }
  if (!(amountMinor > 0)) return { status: 'skipped', ref: null, error: null };
  if (!token) return { status: 'failed', ref: null, error: 'not authenticated' };

  const body = buildRefundBody({ processor: p, legId, amountMinor, locationId, checkId, refundId, staffId, currency, reason });
  try {
    const res = await fetch(`${functionsUrl}/${REFUND_ENDPOINT[p]}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    const verdict = readRefundResponse(p, res.ok, res.status, j);
    if (verdict.status === 'failed') {
      console.warn(`[cardReversal] ${p} leg ${legId} FAILED:`, verdict.error, j);
    } else {
      console.info(`[cardReversal] ${p} leg ${legId} ${verdict.status}:`, verdict.ref, amountMinor);
    }
    return verdict;
  } catch (e) {
    // A network failure is NOT proof the refund did not happen. Say exactly that,
    // and leave the leg retryable — the idempotency key makes the retry safe.
    const error = `could not reach ${REFUND_ENDPOINT[p]}: ${e?.message || e}`;
    console.warn('[cardReversal]', error);
    return { status: 'failed', ref: null, error };
  }
}
