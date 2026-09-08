// src/lib/payments/adyenTab.js
// Adyen twin of ryftTab(): QR open-tab close lifecycle on the adyen-checkout fn.
//   tab_capture { location_id, psp_reference, amount_minor, hold_minor?, currency?, reference? }
//   tab_cancel  { location_id, psp_reference }
import { supabase, isMock, ensureAuthToken } from '../supabase';

export async function adyenTab(action, payload) {
  if (isMock || !supabase) return { ok: true, captured: true, captured_amount: payload?.amount_minor || 0, shortfall: 0, currency: 'gbp', mock: true };
  try { await ensureAuthToken(); } catch { /* invoke attaches anon */ }
  const { data, error } = await supabase.functions.invoke('adyen-checkout', { body: { action, ...payload } });
  if (error) {
    let body = null;
    try { body = await error.context?.json?.(); } catch { /* keep */ }
    const e = new Error(body?.error || error.message || `adyen-checkout ${action} failed`);
    e.code = body?.error; e.detail = body?.detail; e.status = error.context?.status;
    throw e;
  }
  if (data?.error) { const e = new Error(data.error); e.code = data.error; e.detail = data.detail; throw e; }
  return data;
}
