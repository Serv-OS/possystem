// src/lib/networkReader.js
//
// v5.5.58: WiFi-only payment terminal helpers.
// Replaced the old stripeTerminal.js (Bluetooth bridge + SDK) after the
// REST-on-WisePOS-E pivot. We no longer initialise the Stripe Terminal SDK
// from the device — payments run server-side via stripe-process-payment-on-reader.
// What remains is a tiny set of helpers used to identify this POS device and
// look up the network reader the admin assigned to it in BO.

import { platformSupabase } from './supabase';

const POS_DEVICE_KEY = 'rpos-device';

export function getPosDeviceId() {
  try {
    const raw = localStorage.getItem(POS_DEVICE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj?.id || null;
  } catch { return null; }
}

let platformIdCache = null;
let platformIdCachedFor = null;

export async function resolvePlatformLocationId(opsLocationId) {
  if (!opsLocationId) return null;
  if (platformIdCachedFor === opsLocationId && platformIdCache) return platformIdCache;
  if (!platformSupabase) return opsLocationId;
  const { data: direct } = await platformSupabase
    .from('locations').select('id').eq('id', opsLocationId).maybeSingle();
  if (direct?.id) {
    platformIdCache = direct.id; platformIdCachedFor = opsLocationId;
    return direct.id;
  }
  const { data: byOps } = await platformSupabase
    .from('locations').select('id').eq('ops_location_id', opsLocationId).maybeSingle();
  if (byOps?.id) {
    platformIdCache = byOps.id; platformIdCachedFor = opsLocationId;
    return byOps.id;
  }
  return null;
}

function getActiveLocationSyncMaybe() {
  try {
    return localStorage.getItem('rpos-bo-location') || localStorage.getItem('rpos-active-location') || null;
  } catch { return null; }
}

/**
 * Fetch the network reader assigned to this POS/kiosk device, if any.
 * Returns the payment_devices row or null.
 */
export async function getAssignedNetworkReader() {
  const opsLocationId = getActiveLocationSyncMaybe();
  const posDeviceId = getPosDeviceId();
  if (!opsLocationId || !posDeviceId || !platformSupabase) return null;
  const platformLocationId = await resolvePlatformLocationId(opsLocationId);
  if (!platformLocationId) return null;
  const { data } = await platformSupabase
    .from('payment_devices')
    .select('id, stripe_reader_id, label, status, ip_address, device_type, last_seen_at, serial_number')
    .eq('location_id', platformLocationId)
    .eq('connection_kind', 'network')
    .eq('bound_pos_device_id', posDeviceId)
    .maybeSingle();
  return data ?? null;
}
