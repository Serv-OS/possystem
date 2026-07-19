// src/lib/payments/processor.js
//
// Which payment processor does a location use? Cached per location for the
// session. Defaults to 'stripe' on any error/unknown, so existing Stripe venues
// are never affected — but ONLY definitive answers are cached. A transient
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
  if (!locationId) return { processor: 'stripe', definitive: false };
  if (_cache.has(locationId)) return { processor: _cache.get(locationId), definitive: true };
  if (isMock || !supabase) { _cache.set(locationId, 'stripe'); return { processor: 'stripe', definitive: true }; }
  try {
    await ensureAuthToken();
    const { data, error } = await supabase.functions.invoke('payments-processor', { body: { location_id: locationId } });
    // Only a clean response with a recognised processor is definitive. An invoke
    // error, a fn-level error field, or an unknown value is NOT cached — the
    // next call retries instead of pinning the wrong processor for the session.
    if (!error && !data?.error && (data?.processor === 'ryft' || data?.processor === 'stripe')) {
      _cache.set(locationId, data.processor);
      return { processor: data.processor, definitive: true };
    }
    return { processor: 'stripe', definitive: false };
  } catch {
    return { processor: 'stripe', definitive: false }; // fail safe — never break the live Stripe path
  }
}

export async function getLocationProcessor(locationId) {
  return (await getLocationProcessorInfo(locationId)).processor;
}

export function clearProcessorCache(locationId) {
  if (locationId) _cache.delete(locationId); else _cache.clear();
}
