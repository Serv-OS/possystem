/**
 * dispatch.js — DeliveryDispatcher (client side). Thin: builds the manifest (tested,
 * manifest.js) and calls the uber-direct edge fn, which routes by the venue's
 * dispatch_backend (uber_api → Create Delivery; hubrise_bridge → deferred seam) and
 * holds the creds. Returns { ok, deliveryId, trackingUrl, status, deferred?, reason? }.
 */
import { buildManifest } from './manifest.js';

async function invoke(action, payload) {
  const { supabase } = await import('../supabase.js');
  if (!supabase) return { ok: false, reason: 'offline' };
  const { data, error } = await supabase.functions.invoke('uber-direct', { body: { action, ...payload } });
  if (error) return { ok: false, reason: 'transport_error', error: error.message };
  return data;
}

/** Dispatch a courier for a confirmed delivery order. pickup is filled server-side from config. */
export async function dispatchDelivery({ opsLocationId, order, quote }, deps = {}) {
  const send = deps.invoke || invoke;
  const manifest = buildManifest({ order, quote, pickup: {} });
  return send('create_delivery', { ops_location_id: opsLocationId, order_ref: order?.ref || null, manifest });
}

/** Poll a delivery's live status (staff board fallback to the webhook). */
export async function fetchDeliveryStatus({ opsLocationId, uberDeliveryId }, deps = {}) {
  const send = deps.invoke || invoke;
  return send('get_delivery', { ops_location_id: opsLocationId, uber_delivery_id: uberDeliveryId });
}
