// src/lib/payments/processor.js
//
// Which payment processor does a location use? Cached per location for the
// session. Defaults to 'stripe' on any error/unknown, so existing Stripe venues
// are never affected. The POS checkout uses this to dispatch card-present
// payments to Stripe Terminal vs Ryft terminals.

import { supabase, ensureAuthToken, isMock } from '../supabase';

const _cache = new Map(); // locationId -> 'stripe' | 'ryft'

export async function getLocationProcessor(locationId) {
  if (!locationId) return 'stripe';
  if (_cache.has(locationId)) return _cache.get(locationId);
  if (isMock || !supabase) { _cache.set(locationId, 'stripe'); return 'stripe'; }
  try {
    await ensureAuthToken();
    const { data, error } = await supabase.functions.invoke('payments-processor', { body: { location_id: locationId } });
    const processor = (!error && data?.processor === 'ryft') ? 'ryft' : 'stripe';
    _cache.set(locationId, processor);
    return processor;
  } catch {
    return 'stripe'; // fail safe — never break the live Stripe path
  }
}

export function clearProcessorCache(locationId) {
  if (locationId) _cache.delete(locationId); else _cache.clear();
}
