// src/components/AdyenPaymentForm.jsx
//
// Adyen card AND wallet form for ONLINE / QR checkout (programme slice 1a),
// the Adyen sibling of RyftPaymentForm: give it an amount and an order ref, it
// collects the payment and calls onSuccess/onError.
//
// ADVANCED flow (11 Aug): the card encrypts in the browser, but the payment
// request runs through OUR adyen-checkout fn (make_payment -> /v72/payments
// with the API key). We switched off the sessions flow after checkoutshopper's
// /sessions/{id}/payments returned a bare 403 with origin, client key and
// clientside role all verified good. Server-side, every Adyen error reaches us
// in full. AUTHORISATION still lands on adyen-webhook (HMAC-verified) with our
// order ref as merchantReference, which is how money reconciles.
//
// APPLE PAY AND GOOGLE PAY (8 Sep 2026). This file used to hand Drop-in a
// HARDCODED card only paymentMethodsResponse, so no wallet could ever appear
// however the merchant account was set up. That single constant is why Apple
// Pay did not load in checkout, and it is now the FALLBACK only. On mount the
// form asks adyen-checkout `payment_methods` for the venue's real
// /paymentMethods response at the real amount, currency and country, and hands
// that to Drop-in. Wallets ride the same onSubmit -> make_payment route the
// card does, because Drop-in reports a wallet token in state.data.paymentMethod
// exactly as it reports an encrypted card.
//   https://docs.adyen.com/api-explorer/Checkout/72/post/paymentMethods
//   https://docs.adyen.com/payment-methods/apple-pay/web-drop-in
//   https://docs.adyen.com/payment-methods/google-pay/web-drop-in
//
// A wallet's ABSENCE is normal, not an error: Drop-in calls each component's
// isAvailable() and quietly drops the ones that reject, so Apple Pay does not
// render without Safari or an Apple device with a card in Wallet, and Google
// Pay does not render off Chrome. When the venue offers a wallet this browser
// did not render we say so in one line under the form, and nothing else.
//
// A WALLET THAT CANNOT START IS SAID OUT LOUD (29 Sep 2026, v5.11.17). Coffee
// Boy: the Apple Pay sheet opened and closed at once and the shopper saw
// nothing, because every wallet error before onSubmit was swallowed. Each
// wallet's onClick now stamps the tap, and an error within a minute of it
// (not a cancel, not a script that did not load) shows "Apple Pay could not
// start for this shop. Please pay by card below." ABOVE the card form and
// writes one wallet_error line to the edge logs (adyenWallets.js
// walletErrorOutcome). Log only: nothing waits on it. A submit only counts
// for the tap it followed (submittedAt), so a card refused earlier on the
// same form never hides a later Apple Pay tap that could not start.
//
// Static imports only (CLAUDE.md: dynamic import silently fails in the Vite
// bundle). The CSS import rides the same lazy chunk as the online surface.

import { useEffect, useRef, useState } from 'react';
import { AdyenCheckout, Dropin, Card, ApplePay, GooglePay } from '@adyen/adyen-web';
import '@adyen/adyen-web/styles/adyen.css';
import { supabase } from '../lib/supabase';
import {
  CARD_ONLY_PAYMENT_METHODS, buildPaymentMethodsRequest, resolvePaymentMethods,
  offeredWalletTypes, walletConfiguration, missingWalletNote, droppedWalletNote,
  walletErrorOutcome, walletStartFailedNote, walletErrorReport,
} from '../lib/payments/adyenWallets';

export default function AdyenPaymentForm({
  amountMinor,
  currency = 'GBP',
  reference,                 // OUR order ref, becomes Adyen's merchantReference
  customerEmail,
  locationId,                // v5.8.15: platform location id. adyen-checkout resolves the
                             // venue's store from it; without it the fn falls back to
                             // "the only Adyen store", which stops being true at venue 2.
  merchantName = '',         // v5.8.43: the venue's name, shown on the Apple Pay sheet and
                             // the Google Pay sheet. Merged onto Adyen's own configuration,
                             // never sent alone (see adyenWallets.js).
  captureMethod = 'automatic', // v5.8.17: 'manual' = pre-authorise, capture later (QR open tab)
  storeCard = false,           // v5.8.17: keep the card on file (shopper_reference required)
  shopperReference,
  onSuccess,
  onError,
}) {
  const holder = useRef(null);
  const dropinRef = useRef(null);
  const lastServer = useRef(null);   // last make_payment/details response, pspReference for onSuccess
  const lastFailure = useRef(null);  // server error message, beats Drop-in's generic banner
  const offeredWallets = useRef([]); // wallet types the venue's Adyen config offers
  const submittedAt = useRef(0);     // ms of the last submit on this mount, 0 for none (see the wallet onError)
  const tappedAt = useRef({});       // { [wallet type]: ms } when the shopper last tapped that wallet
  const reportedTap = useRef({});    // { [wallet type]: ms } the tap already logged, one line per tap
  const [phase, setPhase] = useState('init');   // init | ready | failed
  const [walletNote, setWalletNote] = useState(''); // the one line when a wallet cannot render here
  // The one line when a tapped wallet could not start, tagged with the payment
  // it belongs to, so a remount (a new amount, ref or venue) drops it without
  // a setState in the effect.
  const [startNote, setStartNote] = useState({ key: '', text: '' });
  const payKey = [amountMinor, currency, reference, merchantName, locationId].join('|');

  useEffect(() => {
    let live = true;
    submittedAt.current = 0;     // a remount is a NEW payment: nothing in flight yet
    tappedAt.current = {};       // and nothing tapped yet
    reportedTap.current = {};
    const noteKey = [amountMinor, currency, reference, merchantName, locationId].join('|');
    (async () => {
      try {
        // The venue is the payment's environment (test or live), its merchant
        // account and its store. Without it the fn would fall back to the
        // ADYEN_ENV set (test keys), so it is required here, not optional
        // (8 Sep 2026; the fn refuses money actions without it too).
        if (!locationId) throw new Error('This venue is not set up for card payments yet (no location id for the checkout)');

        // ONE call on mount. payment_methods answers the venue's real method
        // list AND the publishable config (client key, environment, the
        // Drop-in environment for the venue's data centre, region), on its
        // refusal path too, so the card form mounts either way. `status` is
        // only used as a second chance when even that config is missing.
        let pmRes;
        try {
          const pmReq = buildPaymentMethodsRequest({
            locationId,
            amountMinor,
            currency,
            // The fn defaults the country from the venue's Adyen region, which
            // is the authority here (a US venue is US whatever the browser says).
            shopperLocale: typeof navigator !== 'undefined' ? navigator.language : undefined,
          });
          pmRes = await supabase.functions.invoke('adyen-checkout', { body: pmReq });
        } catch (e) {
          // A request we could not even build (no amount yet) is a lookup that
          // failed: card only, never a dead checkout.
          pmRes = { data: null, error: e };
        }
        if (!live) return;
        const resolved = resolvePaymentMethods(pmRes);
        if (resolved.fallback) {
          // Loud in the console, silent on screen: the shopper still gets a
          // working card form, and we get the reason the wallets are missing.
          console.warn('[adyen] payment methods lookup fell back to card only:', resolved.reason);
        }
        // An entry Drop-in would have THROWN on (a googlepay with no Google
        // merchant ID is the common one: Adyen makes it optional on test) was
        // filtered out before it could take the card form down with it.
        if (resolved.dropped?.length) {
          console.warn('[adyen] wallet dropped before Drop-in could throw on it:', droppedWalletNote(resolved.dropped));
        }

        let cfg = resolved.config;
        if (!cfg?.clientKey) {
          const { data, error: cfgErr } = await supabase.functions.invoke('adyen-checkout', { body: { action: 'status', location_id: locationId } });
          if (cfgErr || data?.error || !data?.ok) throw new Error(data?.error || cfgErr?.message || 'Could not start the payment');
          if (!live) return;
          cfg = {
            clientKey: data.clientKey,
            environment: data.environment,
            region: data.region,
            dropinEnvironment: data.dropinEnvironment || (data.environment === 'live' ? 'live' : 'test'),
          };
        }

        const paymentMethodsResponse = resolved.response || CARD_ONLY_PAYMENT_METHODS;
        const countryCode = cfg.region === 'US' ? 'US' : 'GB';
        offeredWallets.current = offeredWalletTypes(paymentMethodsResponse);

        const payViaServer = async (body) => {
          const { data, error } = await supabase.functions.invoke('adyen-checkout', { body });
          if (error || data?.error) throw new Error(data?.error || error?.message || 'Payment failed');
          lastServer.current = data;
          return data;
        };

        // Wallet configuration: the real amount and country on each wallet,
        // plus the venue's name merged onto Adyen's own configuration block
        // (merchantId / gatewayMerchantId must survive, see adyenWallets.js).
        // onAuthorized fires BEFORE onSubmit and the payment does not proceed
        // until it resolves, so resolving is not optional once we supply it.
        const walletCallbacksFor = (type) => ({
          onAuthorized: (_data, actions) => {
            lastFailure.current = null;
            actions.resolve();
          },
          // The shopper tapped this wallet. adyen-web 6.42 (ApplePay and
          // GooglePay) calls onClick(resolve, reject) and opens the sheet
          // only once it resolves, so this resolves at once, synchronously,
          // inside the tap: Apple Pay must begin within the user gesture.
          onClick: (resolve) => {
            tappedAt.current[type] = Date.now();
            resolve();
          },
          // A wallet component's own error, and it must NOT reach the
          // checkout unless a payment is actually in flight.
          //
          // A dismissed sheet arrives as name === 'CANCEL': nothing charged,
          // the shopper is still on the form. But ApplePayElement's
          // constructor ALSO loads apple-pay-sdk.js from Apple's CDN and, on
          // failure, calls handleError(SCRIPT_ERROR). And because
          // paymentMethodsConfiguration spreads last in buildElementProps,
          // this callback is that element's onError. A blocked CDN, a proxy
          // or an extension is a wallet-availability non-event, so it must
          // never put "Payment error" on a checkout whose card form works.
          //
          // An ERROR within a minute of a tap and before any submit is the
          // sheet dying at merchant validation (the shop address not
          // registered with Apple Pay at Adyen): say so above the card form
          // and log it (walletErrorOutcome). A CANCEL never clears the tap,
          // so the ERROR and CANCEL that follow an abort land in either order.
          // A submit counts only when it came at or after this tap, so a card
          // refused before the tap is not "a payment in flight" (29 Sep 2026
          // review). The tap is kept; reportedTap logs it once.
          onError: (e) => {
            const tap = tappedAt.current[type];
            const outcome = walletErrorOutcome({ name: e?.name, tappedAt: tap, now: Date.now(), submittedAt: submittedAt.current });
            if (outcome === 'payment_error') {
              onError?.(lastFailure.current || new Error(e?.message || 'Payment error'));
              return;
            }
            if (outcome === 'start_failed') {
              if (live) setStartNote({ key: noteKey, text: walletStartFailedNote(type) });
              if (reportedTap.current[type] === tap) return;
              reportedTap.current[type] = tap;
              console.warn('[adyen] wallet could not start:', type, e?.name, e?.message, e?.cause);
              try {
                const report = walletErrorReport({ locationId, type, error: e, host: typeof window !== 'undefined' ? window.location.hostname : '' });
                supabase.functions.invoke('adyen-checkout', { body: report }).catch(() => { /* log only */ });
              } catch { /* log only: never in the shopper's way */ }
              return;
            }
            console.warn('[adyen] wallet unavailable:', e?.name, e?.message);
          },
        });
        const wallets = walletConfiguration({
          response: paymentMethodsResponse,
          amountMinor,
          currency,
          countryCode,
          merchantName,
        });
        const paymentMethodsConfiguration = {};
        for (const [type, conf] of Object.entries(wallets)) {
          paymentMethodsConfiguration[type] = { ...conf, ...walletCallbacksFor(type) };
        }

        const checkout = await AdyenCheckout({
          clientKey: cfg.clientKey || undefined,
          environment: cfg.dropinEnvironment || (cfg.environment === 'live' ? 'live' : 'test'),
          countryCode,
          amount: { value: amountMinor, currency: String(currency).toUpperCase() },
          paymentMethodsResponse,
          onSubmit: async (state, _component, actions) => {
            try {
              submittedAt.current = Date.now();   // from here a wallet error of THIS tap IS a payment error
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
                // Verbatim from Drop-in: an encrypted card, an applePayToken or
                // a googlePayToken. The fn passes it straight to /payments.
                payment_method: state.data.paymentMethod,
                // Apple Pay sends no browserInfo (it needs none); Google Pay
                // and the card both do. Undefined simply drops out of the JSON.
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
                ? `Card refused${reason ? ` (${reason})` : ''}, try another card`
                : `Payment ${result?.resultCode || 'failed'}`
            ));
          },
          // A dismissed Apple Pay or Google Pay sheet reaches here as
          // name === 'CANCEL'. Nothing was charged, the form is still usable,
          // so it must not surface as a failed payment (8 Sep 2026).
          onError: (e) => {
            if (e?.name === 'CANCEL') return;
            onError?.(lastFailure.current || new Error(e?.message || 'Payment error'));
          },
        });
        if (!live) return;
        // `let` and not `const`: onReady closes over this, and a null read is
        // the quiet path (say nothing) rather than a wrong "wallet missing".
        let dropin = null;
        dropin = new Dropin(checkout, {
          // Every class Drop-in may need to mount. A type in the response with
          // no class here is dropped with a console warning, which is exactly
          // what used to keep the wallets off the screen.
          paymentMethodComponents: [Card, ApplePay, GooglePay],
          paymentMethodsConfiguration,
          onReady: () => {
            if (!live || !dropin) return;
            // Drop-in has finished its availability checks (it drops any
            // component whose isAvailable() rejects), so whatever is in
            // paymentMethodElements is what the shopper can actually see.
            const rendered = (dropin.paymentMethodElements || []).map((el) => el?.type).filter(Boolean);
            setWalletNote(missingWalletNote(offeredWallets.current, rendered) || '');
          },
        });
        dropinRef.current = dropin;
        dropin.mount(holder.current);
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
    // A new amount or ref is a NEW payment: remount cleanly. The amount is
    // also what /paymentMethods was asked with, so it must re-run here.
    // merchantName and locationId are in here because they arrive LATE: the
    // checkout mounts before `location` resolves, so the first run sees '' and
    // the Apple Pay sheet (and its total line, which ApplePay derives from
    // configuration.merchantName) would keep Adyen's own name for ever,
    // because nothing else remounts this form. Both are stable strings, so a
    // run that does not change them costs nothing.
  }, [amountMinor, currency, reference, merchantName, locationId]); // eslint-disable-line react-hooks/exhaustive-deps

  const startNoteText = startNote.key === payKey ? startNote.text : '';
  return (
    <div>
      {phase === 'init' && <div style={{ padding: 18, textAlign: 'center', opacity: 0.7, fontSize: 13 }}>Loading secure payment…</div>}
      {phase === 'failed' && <div style={{ padding: 18, textAlign: 'center', fontSize: 13 }}>Could not load the payment form. Go back and try again.</div>}
      {/* ABOVE the form, so "pay by card below" is true. */}
      {startNoteText && (
        <div role="status" style={{
          marginBottom: 10, padding: '10px 12px', borderRadius: 8, fontSize: 13.5, fontWeight: 600, lineHeight: 1.5,
          background: 'rgba(245, 158, 11, 0.12)', border: '1px solid rgba(180, 83, 9, 0.35)',
        }}>{startNoteText}</div>
      )}
      <div ref={holder} />
      {phase === 'ready' && walletNote && (
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7, lineHeight: 1.5 }}>{walletNote}</div>
      )}
    </div>
  );
}
