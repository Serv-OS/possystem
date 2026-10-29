// src/lib/payments/processor.js
//
// Which payment processor does a location use? Cached per location for the
// session. 29 Oct 2026 (v5.11.116): defaults to 'adyen' on any error/unknown. Every live
// venue is on Adyen and Stripe and Ryft are being removed, so a lookup blip must never
// send a customer down a dead Stripe path (it did: the gift page, catering). ONLY definitive answers are cached. A transient
// lookup failure must never pin 'stripe' for the whole session on a Ryft venue:
// that downgrade used to end at the production simulated card screen, letting
// staff close real checks as paid with no money taken.

import { supabase, ensureAuthToken, isMock } from '../supabase';

const _cache = new Map(); // locationId -> 'stripe' | 'ryft'

// Full answer: { processor: 'stripe'|'ryft', definitive: boolean }.
// definitive=false means the lookup failed and 'stripe' is only a guess —
// callers that gate money-taking UI must treat non-definitive as "unknown",
// not as a confirmed Stripe venue. Tolerates both the old fn shape (silent
// 'stripe' default) and the new one (explicit error on lookup failure).
export async function getLocationProcessorInfo(locationId) {
  if (!locationId) return { processor: 'adyen', definitive: false };
  if (_cache.has(locationId)) return { processor: _cache.get(locationId), definitive: true };
  if (isMock || !supabase) { _cache.set(locationId, 'adyen'); return { processor: 'adyen', definitive: true }; }
  try {
    await ensureAuthToken();
    const { data, error } = await supabase.functions.invoke('payments-processor', { body: { location_id: locationId } });
    // Only a clean response with a recognised processor is definitive. An invoke
    // error, a fn-level error field, or an unknown value is NOT cached — the
    // next call retries instead of pinning the wrong processor for the session.
    if (!error && !data?.error && (data?.processor === 'ryft' || data?.processor === 'stripe' || data?.processor === 'adyen')) {
      _cache.set(locationId, data.processor);
      return { processor: data.processor, definitive: true };
    }
    return { processor: 'adyen', definitive: false };
  } catch {
    return { processor: 'adyen', definitive: false }; // fail safe: the live processor, never a dead one
  }
}

export async function getLocationProcessor(locationId) {
  return (await getLocationProcessorInfo(locationId)).processor;
}

/**
 * v5.8.75: the ONE rule for "does this venue take card payments on a paired card machine through
 * a terminal job" (the POS CheckoutModal, SplitModal and the kiosk). Ryft and Adyen do; Stripe
 * uses its own reader call. The kiosk had its own copy that only knew Ryft, so an Adyen venue's
 * kiosk (Provo, 15 Sep 2026) fell through to the Stripe reader call and never reached its reader.
 */
export function takesCardsOnTerminal(processor) {
  return processor === 'ryft' || processor === 'adyen';
}

export function clearProcessorCache(locationId) {
  if (locationId) _cache.delete(locationId); else _cache.clear();
}
