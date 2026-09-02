// src/components/AdyenPaymentForm.jsx
//
// Adyen card form for ONLINE checkout (programme slice 1a) — the Adyen
// sibling of RyftPaymentForm, same contract: give it an amount and an order
// ref, it collects the card and calls onSuccess/onError.
//
// ADVANCED flow (11 Aug): the card encrypts in the browser, but the payment
// request runs through OUR adyen-checkout fn (make_payment → /v72/payments
// with the API key). We switched off the sessions flow after checkoutshopper's
// /sessions/{id}/payments returned a bare 403 with origin, client key and
// clientside role all verified good — server-side, every Adyen error reaches
// us in full. AUTHORISATION still lands on adyen-webhook (HMAC-verified) with
// our order ref as merchantReference, which is how money reconciles.
//
// Static imports only (CLAUDE.md — dynamic import silently fails in the Vite
// bundle). The CSS import rides the same lazy chunk as the online surface.

import { useEffect, useRef, useState } from 'react';
import { AdyenCheckout, Dropin, Card } from '@adyen/adyen-web';
import '@adyen/adyen-web/styles/adyen.css';
import { supabase } from '../lib/supabase';

// Advanced flow wants a /paymentMethods response; ours is static — this
// checkout only ever offers card (parity with the Ryft form).
const CARD_ONLY = { paymentMethods: [{ type: 'scheme', name: 'Credit or debit card', brands: ['visa', 'mc', 'amex'] }] };

export default function AdyenPaymentForm({
  amountMinor,
  currency = 'GBP',
  reference,                 // OUR order ref — becomes Adyen's merchantReference
  customerEmail,
  locationId,                // v5.8.15: platform location id. adyen-checkout resolves the
                             // venue's store from it; without it the fn falls back to
                             // "the only Adyen store", which stops being true at venue 2.
  captureMethod = 'automatic', // v5.8.17: 'manual' = pre-authorise, capture later (QR open tab)
  storeCard = false,           // v5.8.17: keep the card on file (shopper_reference required)
  shopperReference,
  onSuccess,
  onError,
}) {
  const holder = useRef(null);
  const dropinRef = useRef(null);
  const lastServer = useRef(null);   // last make_payment/details response — pspReference for onSuccess
  const lastFailure = useRef(null);  // server error message — beats Drop-in's generic banner
  const [phase, setPhase] = useState('init');   // init | ready | failed

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        // Client key + environment come from the fn so live/test stays a
        // server-side switch (ADYEN_ENV) the bundle never hardcodes.
        const { data: cfg, error: cfgErr } = await supabase.functions.invoke('adyen-checkout', { body: { action: 'status', ...(locationId ? { location_id: locationId } : {}) } });
        if (cfgErr || cfg?.error || !cfg?.ok) throw new Error(cfg?.error || cfgErr?.message || 'Could not start the payment');
        if (!live) return;

        const payViaServer = async (body) => {
          const { data, error } = await supabase.functions.invoke('adyen-checkout', { body });
          if (error || data?.error) throw new Error(data?.error || error?.message || 'Payment failed');
          lastServer.current = data;
          return data;
        };

        const checkout = await AdyenCheckout({
          clientKey: cfg.clientKey || undefined,
          environment: cfg.environment === 'live' ? 'live' : 'test',
          countryCode: 'GB',
          amount: { value: amountMinor, currency: String(currency).toUpperCase() },
          paymentMethodsResponse: CARD_ONLY,
          onSubmit: async (state, _component, actions) => {
            try {
              lastFailure.current = null;
              const r = await payViaServer({
                action: 'make_payment',
                ...(locationId ? { location_id: locationId } : {}),
                ...(captureMethod === 'manual' ? { capture_method: 'manual' } : {}),
                ...(storeCard && shopperReference ? { store_card: true, shopper_reference: shopperReference } : {}),
                amount_minor: amountMinor,
                currency: String(currency).toUpperCase(),
                reference,
                payment_method: state.data.paymentMethod,
                browser_info: state.data.browserInfo,
                origin: window.location.origin,
                return_url: window.location.href,
                shopper_email: customerEmail || undefined,
              });
              if (!r.resultCode) { actions.reject(); return; }
              actions.resolve({ resultCode: r.resultCode, action: r.action || undefined });
            } catch (e) {
              lastFailure.current = e;
              actions.reject();
            }
          },
          onAdditionalDetails: async (state, _component, actions) => {
            // Completes 3DS / redirect steps.
            try {
              const r = await payViaServer({ action: 'payment_details', details: state.data.details });
              if (!r.resultCode) { actions.reject(); return; }
              actions.resolve({ resultCode: r.resultCode, action: r.action || undefined });
            } catch (e) {
              lastFailure.current = e;
              actions.reject();
            }
          },
          onPaymentCompleted: (result) => {
            if (['Authorised', 'Received', 'Pending'].includes(result?.resultCode)) {
              onSuccess?.({
                id: lastServer.current?.pspReference || reference,
                pspReference: lastServer.current?.pspReference || null,
                resultCode: result?.resultCode,
                processor: 'adyen',
                reference,
              });
            } else {
              onError?.(new Error(`Payment ${result?.resultCode || 'failed'}`));
            }
          },
          onPaymentFailed: (result) => {
            const reason = lastServer.current?.refusalReason;
            onError?.(new Error(
              result?.resultCode === 'Refused'
                ? `Card refused${reason ? ` (${reason})` : ''} — try another card`
                : `Payment ${result?.resultCode || 'failed'}`
            ));
          },
          onError: (e) => onError?.(lastFailure.current || new Error(e?.message || 'Payment error')),
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
