/**
 * stock/siteScopeLoad.js: reads the stock site scope once, after the Back Office profile lands
 * (v5.11.86, multi site stock Drop 1, map 3.2).
 *
 * One call to stock_site_scope(p_location_id) for the signed in venue. A database without the
 * function (before Drop 0a), a refusal, any error or no answer within 6 s all answer the one site
 * scope of the signed in venue (failed true): the Back Office falls back to today's screens, and
 * never to a wider view.
 */

import { supabase as defaultClient, isMock } from '../supabase';
import { oneSiteScope, scopeFromRpc } from './siteScope.js';

export async function fetchStockSiteScope(locationId, { client = defaultClient, timeoutMs = 6000 } = {}) {
  if (!locationId || locationId === 'loc-demo' || !client || typeof client.rpc !== 'function') return oneSiteScope(locationId || null);
  if (client === defaultClient && isMock) return oneSiteScope(locationId, { failed: false });
  let timer = null;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve({ data: null, error: { message: 'timeout' } }), timeoutMs); });
  let res;
  try {
    res = await Promise.race([Promise.resolve(client.rpc('stock_site_scope', { p_location_id: locationId })), late]);
  } catch (e) {
    res = { data: null, error: e };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!res || res.error) {
    console.warn('[stock] site scope not read, showing the one site screens:', res?.error?.message || res?.error || 'no answer');
    return oneSiteScope(locationId);
  }
  return scopeFromRpc(res.data, locationId);
}
