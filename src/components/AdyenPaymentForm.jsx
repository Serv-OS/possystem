// src/components/AdyenPaymentForm.jsx
//
// Adyen card form for ONLINE checkout (programme slice 1a) — the Adyen
// sibling of RyftPaymentForm, same contract: give it an amount and an order
// ref, it collects the card and calls onSuccess/onError.
//
// Flow: adyen-checkout fn mints a Checkout v72 SESSION → Drop-in (v6, Card
// only — keeps the bundle lean) completes the payment client-side → the
// AUTHORISATION webhook lands in adyen_events (HMAC-verified) carrying our
// order ref as merchantReference, which is how money reconciles server-side.
//
// Static imports only (CLAUDE.md — dynamic import silently fails in the Vite
// bundle). The CSS import rides the same lazy chunk as the online surface.

import { useEffect, useRef, useState } from 'react';
import { AdyenCheckout, Dropin, Card } from '@adyen/adyen-web';
import '@adyen/adyen-web/styles/adyen.css';
import { supabase } from '../lib/supabase';

export default function AdyenPaymentForm({
  amountMinor,
  currency = 'GBP',
  reference,                 // OUR order ref — becomes Adyen's merchantReference
  customerEmail,
  onSuccess,
  onError,
}) {
  const holder = useRef(null);
  const dropinRef = useRef(null);
  const [phase, setPhase] = useState('init');   // init | ready | failed

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('adyen-checkout', {
          body: {
            action: 'create_session',
            amount_minor: amountMinor,
            currency: String(currency).toUpperCase(),
            reference,
            shopper_email: customerEmail || undefined,
            return_url: window.location.href,
          },
        });
        if (error || data?.error) throw new Error(data?.error || error?.message || 'Could not start the payment');
        if (!live) return;

        const checkout = await AdyenCheckout({
          session: { id: data.id, sessionData: data.sessionData },
          clientKey: data.clientKey,
          environment: data.environment === 'live' ? 'live' : 'test',
          countryCode: 'GB',
          amount: data.amount,
          onPaymentCompleted: (result) => {
            // Authorised/Received both mean the money side succeeded for cards.
            if (['Authorised', 'Received', 'Pending'].includes(result?.resultCode)) {
              onSuccess?.({ id: data.id, resultCode: result?.resultCode, processor: 'adyen', reference });
            } else {
              onError?.(new Error(`Payment ${result?.resultCode || 'failed'}`));
            }
          },
          onPaymentFailed: (result) => {
            onError?.(new Error(result?.resultCode === 'Refused' ? 'Card refused — try another card' : `Payment ${result?.resultCode || 'failed'}`));
          },
          onError: (e) => onError?.(new Error(e?.message || 'Payment error')),
        });
        if (!live) return;
        dropinRef.current = new Dropin(checkout, { paymentMethodComponents: [Card] }).mount(holder.current);
        setPhase('ready');
      } catch (e) {
        if (!live) return;
        setPhase('failed');
        onError?.(e);
      }
    })();
    return () => {
      live = false;
      try { dropinRef.current?.unmount(); } catch { /* already gone */ }
    };
    // A new amount or ref is a NEW payment — remount cleanly.
  }, [amountMinor, currency, reference]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div>
      {phase === 'init' && <div style={{ padding: 18, textAlign: 'center', opacity: 0.7, fontSize: 13 }}>Loading secure payment…</div>}
      {phase === 'failed' && <div style={{ padding: 18, textAlign: 'center', fontSize: 13 }}>Could not load the payment form — go back and try again.</div>}
      <div ref={holder} />
    </div>
  );
}
