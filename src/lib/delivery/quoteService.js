/**
 * quoteService.js — the single DeliveryQuoteService every order module calls.
 *
 * Thin orchestration over the `uber-direct` edge fn (which holds creds + geocodes +
 * radius-checks server-side). This layer normalises the raw Uber quote (quote.js) and
 * computes the customer-facing fee from the venue policy (surcharge.js) — both pure +
 * unit-tested. Returns one consistent shape used identically by POS/online/catering.
 *
 * The transport is injectable (`deps.invoke`) so this is testable without network.
 */
import { normalizeUberQuote } from './quote.js';
import { computeSurcharge } from './surcharge.js';

async function defaultInvoke(action, payload) {
  const { supabase } = await import('../supabase.js');
  if (!supabase) return { ok: false, available: false, reason: 'offline' };
  const { data, error } = await supabase.functions.invoke('uber-direct', { body: { action, ...payload } });
  if (error) return { ok: false, available: false, reason: 'transport_error', error: error.message };
  return data;
}

/**
 * Get a live delivery quote + computed customer fee for a dropoff address.
 * @returns {{
 *   available:boolean, reason?:string, fallback?:boolean,
 *   quoteId?:string|null, trueCostMinor?:number, customerFeeMinor?:number, marginMinor?:number,
 *   currency?:string, etaMinutes?:number|null, expiresAtMs?:number|null,
 *   distanceMiles?:number|null, radiusMiles?:number, freeDelivery?:boolean, belowMinimum?:boolean,
 *   policyApplied?:string, dropoff?:object
 * }}
 */
export async function getDeliveryQuote({ opsLocationId, dropoff, orderSubtotalMinor = 0, scheduled = false }, deps = {}) {
  const invoke = deps.invoke || defaultInvoke;
  const now = deps.now || Date.now();

  let resp;
  try {
    resp = await invoke('quote', { ops_location_id: opsLocationId, dropoff, order_subtotal_minor: orderSubtotalMinor, scheduled });
  } catch (e) {
    return { available: false, reason: 'transport_error', error: String(e?.message || e) };
  }
  if (!resp || resp.ok === false) return { available: false, reason: resp?.reason || 'error' };
  if (resp.available === false) {
    return { available: false, reason: resp.reason || 'unavailable', distanceMiles: resp.distanceMiles, radiusMiles: resp.radiusMiles };
  }

  const q = normalizeUberQuote(resp.raw, now);
  if (!q) return { available: false, reason: 'no_quote' };

  const sc = computeSurcharge({ uberFeeMinor: q.feeMinor, policy: resp.policy, orderSubtotalMinor });

  return {
    available: true,
    fallback: !!resp.fallback,
    mode: resp.mode || 'uber',          // 'self' (fire to POS) | 'uber' (courier)
    dispatchable: !!resp.dispatchable,  // true only when a courier should be dispatched
    quoteId: q.quoteId,
    trueCostMinor: sc.trueCostMinor,
    customerFeeMinor: sc.customerFeeMinor,
    marginMinor: sc.marginMinor,
    currency: q.currency || resp.currency || 'GBP',
    etaMinutes: q.etaMinutes,
    expiresAtMs: q.expiresAtMs,
    distanceMiles: resp.distanceMiles ?? null,
    radiusMiles: resp.radiusMiles,
    freeDelivery: sc.freeDelivery,
    belowMinimum: sc.belowMinimum,
    policyApplied: sc.policyApplied,
    dropoff: resp.dropoff || dropoff,
  };
}

/** On order confirm: persist the quote + surcharge for margin reporting (best-effort). */
export async function recordDeliverySurcharge({ opsLocationId, orderRef, quote }, deps = {}) {
  const invoke = deps.invoke || defaultInvoke;
  try {
    await invoke('record_surcharge', {
      ops_location_id: opsLocationId,
      order_ref: orderRef,
      dropoff: quote?.dropoff || null,
      surcharge: {
        quoteId: quote?.quoteId || null,
        customerFeeMinor: quote?.customerFeeMinor ?? 0,
        trueCostMinor: quote?.trueCostMinor ?? 0,
        policyApplied: quote?.policyApplied || null,
        currency: quote?.currency || 'GBP',
        etaMinutes: quote?.etaMinutes ?? null,
        distanceMiles: quote?.distanceMiles ?? null,
        withinRadius: true,
        expiresAtMs: quote?.expiresAtMs ?? null,
      },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
