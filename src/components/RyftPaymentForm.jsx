// src/components/RyftPaymentForm.jsx
//
// Card-not-present Ryft payment form (online / QR / kiosk / manual entry).
// Creates a payment session, loads the Ryft embedded SDK, lets Ryft mount the
// PCI card fields into <form id="ryft-pay-form">, and on submit calls
// Ryft.attemptPayment(). On Approved/Captured it calls onSuccess(paymentSession).
//
// Ryft owns the DOM inside the form, so React must NOT render children into it —
// we hand Ryft an empty form via ref and let it populate the fields.

import { useEffect, useRef, useState } from 'react';
import { loadRyft, createRyftSession } from '../lib/payments/ryft';

export default function RyftPaymentForm({
  amountMinor,
  currency = 'gbp',
  locationId = null,
  captureMethod = 'automatic',
  customerEmail,
  closedCheckId,
  channel = 'online',
  payLabel,
  onSuccess,
  onError,
}) {
  const [phase, setPhase] = useState('init');   // init | ready | paying | done | error
  const [error, setError] = useState('');
  const [session, setSession] = useState(null); // { sessionId, status }
  const mounted = useRef(true);
  const inited = useRef(false);

  useEffect(() => {
    mounted.current = true;
    (async () => {
      try {
        const [Ryft, s] = await Promise.all([
          loadRyft(),
          createRyftSession({ amountMinor, currency, locationId, captureMethod, customerEmail, closedCheckId, channel }),
        ]);
        if (!mounted.current) return;
        setSession({ sessionId: s.sessionId, status: s.status });
        if (!inited.current) {
          inited.current = true;
          Ryft.init({
            publicKey: s.publicKey,
            clientSecret: s.clientSecret,
            ...(s.accountId ? { accountId: s.accountId } : {}),
          });
          // Surface live validation errors from the SDK.
          Ryft.addEventHandler?.('cardValidationChanged', (e) => {
            if (e?.errors?.length && mounted.current) setError('');
          });
        }
        setPhase('ready');
      } catch (e) {
        if (!mounted.current) return;
        setError(e.message || 'Could not start the payment');
        setPhase('error');
        onError?.(e);
      }
    })();
    return () => { mounted.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (phase === 'paying') return;
    setError('');
    setPhase('paying');
    try {
      const Ryft = await loadRyft();
      const ps = await Ryft.attemptPayment();
      if (ps?.status === 'Approved' || ps?.status === 'Captured') {
        setPhase('done');
        onSuccess?.(ps);
      } else {
        const msg = Ryft.getUserFacingErrorMessage?.(ps?.lastError) || 'Payment was not approved';
        setError(msg);
        setPhase('ready');
        onError?.(new Error(msg));
      }
    } catch (err) {
      const Ryft = window.Ryft;
      const msg = (Ryft?.getUserFacingErrorMessage?.(err) ) || err?.message || 'Payment failed — please try again';
      setError(msg);
      setPhase('ready');
      onError?.(err);
    }
  }

  const amountLabel = `${currency === 'usd' ? '$' : currency === 'eur' ? '€' : '£'}${(Number(amountMinor || 0) / 100).toFixed(2)}`;

  return (
    <form id="ryft-pay-form" onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
      {phase === 'init' && <div style={{ fontSize: 13, color: 'var(--t3)' }}>Loading secure card form…</div>}
      {/* Ryft mounts its card fields inside this form. */}
      <div id="ryft-pay-error" aria-live="polite" style={{ display: error ? 'block' : 'none', color: 'var(--red)', fontSize: 13, fontWeight: 600 }}>{error}</div>
      <button
        id="ryft-pay-btn"
        type="submit"
        className="btn btn-acc"
        disabled={phase === 'init' || phase === 'paying' || phase === 'done'}
        style={{ height: 48, fontSize: 16, fontWeight: 700 }}
      >
        {phase === 'paying' ? 'Processing…' : phase === 'done' ? 'Paid ✓' : (payLabel || `Pay ${amountLabel}`)}
      </button>
      {session?.sessionId && <div style={{ fontSize: 10.5, color: 'var(--t4)', fontFamily: 'var(--font-mono)' }}>Ryft session {session.sessionId}</div>}
    </form>
  );
}
