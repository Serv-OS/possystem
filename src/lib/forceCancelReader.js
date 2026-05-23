// src/lib/forceCancelReader.js
//
// v5.5.180 — POS-side force-cancel for a stuck reader transaction.
// Calls stripe-cancel-reader-action with the assigned reader id (no
// payment_intent_id needed — server runs cancelAction + resets display).
//
// Resolves the assigned reader from the same path the card-payment flow
// uses (getAssignedNetworkReader). Returns the JSON diag from the server
// so the caller can show before/after action state.

import { supabase, ensureAuthToken } from './supabase';
import { resolvePlatformLocationId, getAssignedNetworkReader } from './networkReader';
import { getLocationId } from './supabase';

export async function forceCancelReader() {
  // 1. Resolve location + assigned reader
  const opsLocationId = await getLocationId();
  if (!opsLocationId || opsLocationId === 'loc-demo') {
    return { ok: false, error: 'No active location' };
  }
  const platformLocationId = await resolvePlatformLocationId(opsLocationId);
  if (!platformLocationId) return { ok: false, error: 'No platform location id' };
  const reader = await getAssignedNetworkReader();
  if (!reader?.stripe_reader_id) {
    return { ok: false, error: 'No reader assigned to this POS' };
  }

  // 2. Auth — v5.5.183: ensureAuthToken handles POS devices with no BO login
  let token;
  try { token = await ensureAuthToken(); } catch (e) { return { ok: false, error: e.message }; }
  if (!token) return { ok: false, error: 'Could not obtain auth token' };

  // 3. Call the edge fn — no payment_intent_id so it only runs cancelAction + display reset
  try {
    const res = await fetch(
      `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-cancel-reader-action`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          reader_id: reader.stripe_reader_id,
          location_id: platformLocationId,
          currency: 'gbp',
        }),
      }
    );
    const j = await res.json();
    console.log('[forceCancelReader]', j);
    if (!res.ok) return { ok: false, error: j?.error || `HTTP ${res.status}`, diag: j?.diag };
    return { ok: true, diag: j?.diag, reader_label: reader.label };
  } catch (e) {
    return { ok: false, error: e?.message || 'Network error' };
  }
}
