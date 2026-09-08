/**
 * dispatch.js — DeliveryDispatcher (client side). Thin: builds the manifest (tested,
 * manifest.js) and calls the uber-direct edge fn, which routes by the venue's
 * dispatch_backend (uber_api → Create Delivery; hubrise_bridge → deferred seam) and
 * holds the creds. Returns { ok, deliveryId, trackingUrl, status, deferred?, reason? }.
 */
import { toE164 } from './manifest.js';

async function invoke(action, payload) {
  const { supabase } = await import('../supabase.js');
  if (!supabase) return { ok: false, reason: 'offline' };
  const { data, error } = await supabase.functions.invoke('uber-direct', { body: { action, ...payload } });
  if (error) return { ok: false, reason: 'transport_error', error: error.message };
  return data;
}

/**
 * Dispatch a courier for a confirmed delivery order. The edge fn routes by the venue's
 * dispatch_backend: uber_api uses `manifest` (Create Delivery); hubrise_bridge uses
 * `hubrise_order` (pushed into HubRise → the Bridge dispatches). We build BOTH from the
 * same order+quote (both pure + tested) so the edge fn just picks. pickup is filled
 * server-side from config; currency comes off the quote.
 */
export async function dispatchDelivery({ opsLocationId, order, quote }, deps = {}) {
  const send = deps.invoke || invoke;
  // Send the raw order + accepted quote; the edge fn builds the manifest / HubRise order
  // server-side and dispatches idempotently (same path the catering fire-time cron uses).
  return send('create_delivery', { ops_location_id: opsLocationId, order_ref: order?.ref || null, order, quote });
}

/** Poll a delivery's live status (staff board fallback to the webhook). */
export async function fetchDeliveryStatus({ opsLocationId, uberDeliveryId }, deps = {}) {
  const send = deps.invoke || invoke;
  return send('get_delivery', { ops_location_id: opsLocationId, uber_delivery_id: uberDeliveryId });
}

/** Customer-facing live courier tracking for the online order tracker (anon-safe). Returns
 *  { dispatched, status, trackingUrl, eta, courierFirstName }. */
export async function trackDelivery({ opsLocationId, orderRef }, deps = {}) {
  const send = deps.invoke || invoke;
  return send('track_order', { ops_location_id: opsLocationId, order_ref: orderRef });
}

/** Text the customer a courier tracking link (best-effort; Uber/HubRise may also notify). */
export async function sendDeliveryTrackingSMS({ opsLocationId, phone, trackingUrl, ref }) {
  const { supabase } = await import('../supabase.js');
  if (!supabase || !phone || !trackingUrl) return;
  try {
    await supabase.functions.invoke('send-sms', {
      body: { to: toE164(phone), message: `Your order ${ref || ''} is on its way — track it here: ${trackingUrl}`.replace(/\s+/g, ' ').trim(), location_id: opsLocationId, type: 'delivery_tracking' },
    });
  } catch { /* best-effort */ }
}
