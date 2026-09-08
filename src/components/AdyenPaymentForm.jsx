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
        // The venue is the payment's environment (test or live), its merchant
        // account and its store. Without it the fn would fall back to the
        // ADYEN_ENV set (test keys), so it is required here, not optional
        // (8 Sep 2026; the fn refuses money actions without it too).
        if (!locationId) throw new Error('This venue is not set up for card payments yet (no location id for the checkout)');
        // Client key + environment come from the fn so live/test stays a
        // server-side switch (the venue's environment) the bundle never hardcodes.
        // 8 Sep 2026: the fn also answers region ('UK' | 'US') and
        // dropinEnvironment ('test' | 'live' | 'live-us'): a US venue's live
        // Drop-in must mount against Adyen's US data centre. An older fn build
        // without dropinEnvironment falls back to the environment mapping.
        const { data: cfg, error: cfgErr } = await supabase.functions.invoke('adyen-checkout', { body: { action: 'status', location_id: locationId } });
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
          environment: cfg.dropinEnvironment || (cfg.environment === 'live' ? 'live' : 'test'),
          countryCode: cfg.region === 'US' ? 'US' : 'GB',
          amount: { value: amountMinor, currency: String(currency).toUpperCase() },
          paymentMethodsResponse: CARD_ONLY,
          onSubmit: async (state, _component, actions) => {
            try {
              lastFailure.current = null;
              // One UUID per submit: the fn uses it as Adyen's Idempotency-Key,
              // so a retry after a refused card is a fresh decision, and the
              // key can never collide with another order's (order refs are
              // five random chars and Adyen scopes keys company wide).
              const attemptId = crypto.randomUUID();
              const r = await payViaServer({
                action: 'make_payment',
                attempt_id: attemptId,
                location_id: locationId,
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
              // A redirect (the issuer wants a full page hop) cannot be
              // completed: the storefront keeps the cart in memory and
              // nothing handles the return, so the shopper would land back
              // cold with no order and the payment would expire. The fn asks
              // for native 3DS2 (handled in the Drop-in below), so this is
              // rare; when it happens, fail clearly with no money moved
              // rather than silently losing the order (8 Sep 2026).
              if (r.action?.type === 'redirect') {
                lastFailure.current = new Error('Your bank asked for a redirect this checkout cannot complete yet. Nothing was charged; please try another card or pay at the venue.');
                actions.reject();
                return;
              }
              actions.resolve({ resultCode: r.resultCode, action: r.action || undefined });
            } catch (e) {
              lastFailure.current = e;
              actions.reject();
            }
          },
          onAdditionalDetails: async (state, _component, actions) => {
            // Completes 3DS / redirect steps.
            try {
              // location_id rides along so the fn resolves the SAME venue
              // (and so the same Adyen environment) as the payment it completes.
              const r = await payViaServer({ action: 'payment_details', location_id: locationId, details: state.data.details });
              if (!r.resultCode) { actions.reject(); return; }
              if (r.action?.type === 'redirect') {
                lastFailure.current = new Error('Your bank asked for a redirect this checkout cannot complete yet. Nothing was charged; please try another card or pay at the venue.');
                actions.reject();
                return;
              }
              actions.resolve({ resultCode: r.resultCode, action: r.action || undefined });
            } catch (e) {
              lastFailure.current = e;
              actions.reject();
            }
          },
          onPaymentCompleted: (result) => {
            // Only Authorised is paid. Received / Pending (never seen for a
            // card) would have written a paid order on an unconfirmed outcome.
            if (result?.resultCode === 'Authorised') {
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
