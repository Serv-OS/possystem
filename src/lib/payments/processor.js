// src/lib/payments/processor.js
//
// Which payment processor does a location use? ServOS works with Adyen only (Drop D,
// 29 Oct 2026): 'adyen' is the only recognised answer. The lookup still runs so the
// server can say whether the venue has an Adyen account (definitive) or the answer is a
// guess (a lookup blip). Cached per location for the session. ONLY definitive answers
// are cached; a transient failure is retried on the next call.

import { supabase, ensureAuthToken, isMock } from '../supabase';

const _cache = new Map(); // locationId -> 'adyen'

// Full answer: { processor: 'adyen', definitive: boolean }.
// definitive=false means the lookup failed: callers that gate money-taking UI must
// treat non-definitive as "unknown", not as a confirmed venue.
export async function getLocationProcessorInfo(locationId) {
  if (!locationId) return { processor: 'adyen', definitive: false };
  if (_cache.has(locationId)) return { processor: _cache.get(locationId), definitive: true };
  if (isMock || !supabase) { _cache.set(locationId, 'adyen'); return { processor: 'adyen', definitive: true }; }
  try {
    await ensureAuthToken();
    const { data, error } = await supabase.functions.invoke('payments-processor', { body: { location_id: locationId } });
    // Only a clean response naming Adyen is definitive. An invoke error, a fn-level error
    // field, or any other value is NOT cached: the next call retries instead.
    if (!error && !data?.error && data?.processor === 'adyen') {
      _cache.set(locationId, 'adyen');
      return { processor: 'adyen', definitive: true };
    }
    return { processor: 'adyen', definitive: false };
  } catch {
    return { processor: 'adyen', definitive: false };
  }
}

export async function getLocationProcessor(locationId) {
  return (await getLocationProcessorInfo(locationId)).processor;
}

/**
 * v5.8.75: the ONE rule for "does this venue take card payments on a paired card machine through
 * a terminal job" (the POS CheckoutModal, SplitModal and the kiosk). Adyen does; it is the only
 * processor ServOS works with.
 */
export function takesCardsOnTerminal(processor) {
  return processor === 'adyen';
}

export function clearProcessorCache(locationId) {
  if (locationId) _cache.delete(locationId); else _cache.clear();
}
