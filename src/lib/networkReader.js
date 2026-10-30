// src/lib/networkReader.js
//
// v5.5.58: a tiny set of helpers used to identify this POS device and resolve its venue's
// Platform location id (the Ops and Platform projects can carry different ids for one venue).

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
