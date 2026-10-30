// src/backoffice/sections/CardReaders.jsx
// Back office card-reader registry — SCOPED TO THE ACTIVE LOCATION.
//
// What lives here: the two self-gating Adyen hardware panels (readers that run
// Adyen's own software, and terminals that run OUR app) plus the payments
// whose outcome was never established.
//
// v5.5.58: Bluetooth support removed. Card readers are WiFi-only end-to-end.
// Cross-location oversight lives in the super-admin app (?mode=admin).

import { useEffect, useState } from 'react';
import { platformSupabase, getActiveLocationSync } from '../../lib/supabase';
import { resolvePlatformLocationId } from '../../lib/networkReader';
import PaxTerminals from './PaxTerminals';
import AdyenTerminals from './AdyenTerminals';
import UnresolvedPayments from './UnresolvedPayments';

const S = {
  page:    { padding: '32px 40px', maxWidth: 1080 },
  h1:      { fontSize: 22, fontWeight: 800, color: 'var(--t1)', margin: 0, marginBottom: 4, letterSpacing: '-.01em' },
  sub:     { fontSize: 13, color: 'var(--t3)', marginBottom: 28, maxWidth: 720, lineHeight: 1.5 },
  errorBox:{ padding: 12, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, marginBottom: 14, fontSize: 13, border: '1px solid var(--red-b)' },
};

// The venue must be picked and registered for billing before any reader can
// be managed here; the panels gate themselves, this names the problem. Null
// when all is well.
async function readinessProblem() {
  if (!platformSupabase) return 'Platform Supabase not configured';
  try {
    const opsLocId = getActiveLocationSync();
    if (!opsLocId) return 'No active location selected. Pick a location in the bottom-left corner of the back office.';
    const platformId = await resolvePlatformLocationId(opsLocId);
    if (!platformId) return 'This location is not registered for billing yet. Contact platform admin.';
    return null;
  } catch (e) {
    return String(e?.message ?? e);
  }
}

export default function CardReaders() {
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    readinessProblem().then((msg) => { if (live) setError(msg); });
    return () => { live = false; };
  }, []);

  return (
    <div style={S.page}>
      <h1 style={S.h1}>Card readers</h1>
      <div style={S.sub}>
        Card readers for this venue. Add a reader by its serial number and it takes payments from the till.
      </div>

      {/* Two sibling panels, one per kind of hardware, both self-gating.
          AdyenTerminals owns readers that run Adyen's own software: registered by
          serial, no code to type. PaxTerminals owns terminals that run OUR app
          (PAX :paxpay, and MPOS on an Adyen Android terminal from v5.6.81):
          paired by the code the terminal shows on its own screen. A device only
          ever appears in one of them — see the last_seen_at filter in
          PaxTerminals' load(). */}
      <AdyenTerminals />
      <PaxTerminals />

      {/* Payments whose outcome was never established — self-gating: renders
          nothing at all when there is nothing unresolved. Sits directly under the
          terminals because that is where a manager goes when a card machine has
          misbehaved. */}
      <UnresolvedPayments />

      {error && <div style={S.errorBox}>{error}</div>}
    </div>
  );
}
