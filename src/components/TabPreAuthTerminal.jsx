import { useState, useRef, useEffect } from 'react';
import { getActiveLocationSync, ensureAuthToken } from '../lib/supabase';
import { resolvePlatformLocationId, getAssignedNetworkReader } from '../lib/networkReader';
import { money, stripeCurrency } from '../lib/currency';

// ─── v5.5.324: Bar-tab card pre-authorisation ──────────────────────────────
// Places a manual-capture HOLD on the customer's card via the Stripe Terminal
// reader when a bar tab is opened. The hold is captured (tab closed & charged)
// or released (void / pay another way) later.
//
// Reuses the same reader REST flow as CheckoutModal/SplitModal, with ONE key
// difference: a successful hold lands the PaymentIntent at `requires_capture`,
// NOT `succeeded`. The shared poll fn's `is_success` only covers automatic-
// capture `succeeded` (and we deliberately don't touch it — it's on the hot
// path for every card payment), so we detect the hold here from the poll's
// `payment_intent_status` field.
//
// No reader assigned → 'simulated' state: we can't really hold a card, so we
// offer to open the tab WITHOUT a hold (the pre-v5.5.324 behaviour).
export default function TabPreAuthTerminal({ amountMinor, guestName, onAuthorized, onSkip, onCancel }) {
  const [state, setState] = useState('resolving'); // resolving | starting | collecting | success | error | cancelling | simulated
  const [statusMsg, setStatusMsg] = useState('Connecting to reader…');
  const [errorMsg, setErrorMsg] = useState(null);
  const [readerLabel, setReaderLabel] = useState('');
  const pollAbortRef = useRef(false);
  const piIdRef = useRef(null);
  const acctRef = useRef(null);
  const readerIdRef = useRef(null);
  const platformLocRef = useRef(null);
  const startedRef = useRef(false);

  const pounds = (m) => `${money(((m || 0) / 100))}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const opsLocationId = getActiveLocationSync();
        if (!opsLocationId) { setState('error'); setErrorMsg('Location not resolved'); return; }
        const platformId = await resolvePlatformLocationId(opsLocationId);
        if (cancelled) return;
        platformLocRef.current = platformId;
        const assigned = await getAssignedNetworkReader();
        if (cancelled) return;
        if (!assigned) { setState('simulated'); return; }
        setReaderLabel(assigned.label || assigned.stripe_reader_id);
        readerIdRef.current = assigned.stripe_reader_id;
        if (!startedRef.current) { startedRef.current = true; runHold(); }
      } catch (e) {
        if (!cancelled) { setState('error'); setErrorMsg(e?.message || 'Reader setup failed'); }
      }
    })();
    return () => { cancelled = true; pollAbortRef.current = true; };
  }, []);

  const runHold = async () => {
    setState('starting');
    setStatusMsg('Pushing hold to reader…');
    setErrorMsg(null);
    try {
      const opsDeviceId = (() => {
        try { const raw = localStorage.getItem('rpos-device'); return raw ? (JSON.parse(raw)?.id || '') : ''; }
        catch { return ''; }
      })();
      if (!opsDeviceId) throw new Error('POS device id missing — pair this device first.');
      const token = await ensureAuthToken();
      if (!token) throw new Error('Could not obtain auth token');

      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-process-payment-on-reader`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          pos_device_id: opsDeviceId,
          amount_minor: amountMinor,
          currency: stripeCurrency(),
          capture_method: 'manual', // ← pre-auth hold, captured at tab close
          line_items: [{ description: `Tab hold — ${guestName || 'Guest'}`, amount: amountMinor, quantity: 1 }],
          skip_tipping: true,
        }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);

      piIdRef.current = j.payment_intent_id;
      acctRef.current = j.stripe_account_id || null;
      setState('collecting');
      setStatusMsg('Tap or insert card to authorise');
      pollAbortRef.current = false;
      pollHold(j.payment_intent_id, j.reader_id, platformLocRef.current);
    } catch (e) {
      setState('error');
      setErrorMsg(e?.message || 'Hold failed');
    }
  };

  const pollHold = async (piId, readerId, locId) => {
    const start = Date.now();
    const TIMEOUT = 5 * 60 * 1000;
    while (!pollAbortRef.current && Date.now() - start < TIMEOUT) {
      await new Promise(r => setTimeout(r, 1500));
      if (pollAbortRef.current) return;
      try {
        const token = await ensureAuthToken();
        const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-poll-reader-action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ payment_intent_id: piId, reader_id: readerId, location_id: locId }),
        });
        const j = await res.json();
        if (!res.ok) { console.warn('[TabPreAuth] poll error:', j.error); continue; }
        if (j.reader_action?.status === 'in_progress') setStatusMsg('Customer is authorising…');
        // A successful hold lands at requires_capture (auth placed, awaiting
        // capture at close) — this is our success signal, NOT `succeeded`.
        if (j.payment_intent_status === 'requires_capture') {
          setState('success');
          setStatusMsg('Card authorised');
          setTimeout(() => onAuthorized?.({ paymentIntentId: piId, stripeAccount: acctRef.current, heldMinor: amountMinor }), 800);
          return;
        }
        // Genuine failure or cancellation.
        if (j.is_terminal_state || j.reader_action?.status === 'failed') {
          setState('error');
          setErrorMsg(j.last_payment_error || j.reader_action?.failure_message || 'Authorisation declined');
          return;
        }
      } catch (e) { console.warn('[TabPreAuth] poll failed:', e?.message); }
    }
    if (!pollAbortRef.current) { setState('error'); setErrorMsg('Timed out — 5 minutes'); }
  };

  const cancelHold = async () => {
    pollAbortRef.current = true;
    setState('cancelling');
    // Best-effort: cancel the reader action + release any partial auth.
    try {
      const token = await ensureAuthToken();
      await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-cancel-reader-action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ payment_intent_id: piIdRef.current, reader_id: readerIdRef.current, location_id: platformLocRef.current }),
      });
    } catch (e) { console.warn('[TabPreAuth] cancel failed:', e?.message); }
    onCancel?.();
  };

  const box = {
    background: 'var(--bg1)', border: '1px solid var(--bdr2)', borderRadius: 20,
    width: '100%', maxWidth: 380, padding: 24, boxShadow: 'var(--sh3)', textAlign: 'center',
  };

  return (
    <div className="modal-back">
      <div style={box}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 6 }}>
          Card pre-authorisation
        </div>
        <div style={{ fontSize: 34, fontWeight: 800, color: 'var(--t1)', fontFamily: 'DM Mono,monospace', marginBottom: 4 }}>{pounds(amountMinor)}</div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 18 }}>
          {guestName ? `${guestName} · ` : ''}hold only — charged when the tab closes
        </div>

        {(state === 'resolving' || state === 'starting' || state === 'collecting' || state === 'cancelling') && (
          <>
            <div style={{ fontSize: 14, color: 'var(--t2)', marginBottom: 16 }}>{statusMsg}</div>
            {readerLabel && <div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 16 }}>Reader: {readerLabel}</div>}
            <button className="btn btn-ghost btn-full" onClick={cancelHold} disabled={state === 'cancelling'}>
              {state === 'cancelling' ? 'Cancelling…' : 'Cancel'}
            </button>
          </>
        )}

        {state === 'success' && (
          <div style={{ padding: '12px 0' }}>
            <div style={{ fontSize: 44, marginBottom: 6 }}>🔒</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--grn)' }}>{pounds(amountMinor)} held</div>
          </div>
        )}

        {state === 'error' && (
          <>
            <div style={{ fontSize: 13, color: 'var(--red)', marginBottom: 16 }}>{errorMsg || 'Authorisation failed'}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button className="btn btn-acc btn-full" onClick={runHold}>Try hold again</button>
              <button className="btn btn-ghost btn-full" onClick={() => onSkip?.()}>Open tab without a hold</button>
              <button className="btn btn-ghost btn-full" onClick={() => onCancel?.()}>Cancel</button>
            </div>
          </>
        )}

        {state === 'simulated' && (
          <>
            <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 16 }}>
              No card reader is assigned to this terminal, so a card can't be held here.
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button className="btn btn-acc btn-full" onClick={() => onSkip?.()}>Open tab without a hold</button>
              <button className="btn btn-ghost btn-full" onClick={() => onCancel?.()}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
