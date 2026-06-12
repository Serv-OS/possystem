// src/components/RyftPaymentForm.jsx
//
// Card-not-present Ryft payment form (online / QR / kiosk / manual entry).
// Creates a payment session, loads the Ryft embedded SDK, lets Ryft mount the
// PCI card fields into <form id="ryft-pay-form">, and on submit calls
// Ryft.attemptPayment(). On Approved/Captured it calls onSuccess(paymentSession).
//
// Apple Pay + Google Pay (v2 SDK): passing applePay/googlePay config to
// Ryft.init() makes the SDK render the wallet buttons in the form on supported
// devices and fire `walletPaymentSessionResult` when done — same paymentSession
// shape as a card payment, so the tab hold / store-card / overage logic all work
// unchanged. Google Pay uses Ryft's HOSTED option (no Google Merchant Account).
// Apple Pay needs the merchant domain registered with Apple for PRODUCTION;
// sandbox works on a real Apple device without domain verification.
//
// Ryft owns the DOM inside the form, so React must NOT render children into it —
// we hand Ryft an empty form via ref and let it populate the fields.

import { useEffect, useRef, useState } from 'react';
import { loadRyft, createRyftSession } from '../lib/payments/ryft';

// Apple/Google Pay want the MERCHANT's country (two-letter ISO). Derive a sane
// default from the transaction currency; UK hospitality is the launch case.
const COUNTRY_BY_CURRENCY = { gbp: 'GB', usd: 'US', eur: 'IE' };

export default function RyftPaymentForm({
  amountMinor,
  currency = 'gbp',
  locationId = null,
  captureMethod = 'automatic',
  storeCard = false,            // tab pre-auth: save the card for an off-session overage
  customerEmail,
  closedCheckId,
  channel = 'online',
  merchantName = '',            // venue name shown on the Apple/Google Pay sheet
  wallets = true,               // show Apple/Google Pay buttons when supported
  payLabel,
  onSuccess,
  onError,
}) {
  const [phase, setPhase] = useState('init');   // init | ready | paying | done | error
  const [error, setError] = useState('');
  const [session, setSession] = useState(null); // { sessionId, status }
  const [walletReady, setWalletReady] = useState(false);
  const mounted = useRef(true);
  const inited = useRef(false);
  const doneRef = useRef(false);

  const merchantCountryCode = COUNTRY_BY_CURRENCY[String(currency).toLowerCase()] || 'GB';
  const showWallets = wallets && !!merchantName;

  // Shared result handler for BOTH the card submit and the wallet event — Ryft
  // returns the same paymentSession either way.
  const handleResult = (ps) => {
    if (!mounted.current || doneRef.current) return;
    if (ps?.status === 'Approved' || ps?.status === 'Captured') {
      doneRef.current = true;
      setPhase('done');
      onSuccess?.(ps);
    } else if (ps?.status === 'PendingAction' || ps?.status === 'Processing') {
      // Authentication still in flight (e.g. a redirect-based 3DS the SDK is
      // completing). Not a failure — let the customer finish / retry.
      setError('Finish the card authentication to complete your payment.');
      setPhase('ready');
    } else {
      const msg = window.Ryft?.getUserFacingErrorMessage?.(ps?.lastError) || 'Payment was not approved — please check your card details and try again.';
      setError(msg);
      setPhase('ready');
      onError?.(new Error(msg));
    }
  };

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
            // Tab hold: classify as the initial of an Unscheduled series so Ryft
            // stores the card — we charge any overage off-session at tab close.
            ...(storeCard ? { paymentType: 'Unscheduled' } : {}),
            // 3DS v2 is completed inline by the SDK, but some issuers force a
            // redirect — returnUrl brings the customer back to this checkout.
            ...(typeof window !== 'undefined' ? { returnUrl: window.location.href } : {}),
            // Apple Pay + Google Pay. Ryft renders the buttons in the form on
            // supported devices; Google Pay is HOSTED (no merchantIdentifier).
            ...(showWallets ? {
              applePay: { merchantName, merchantCountryCode },
              googlePay: { merchantName, merchantCountryCode },
            } : {}),
          });
          // Surface live validation errors from the SDK.
          Ryft.addEventHandler?.('cardValidationChanged', (e) => {
            if (e?.errors?.length && mounted.current) setError('');
          });
          // Wallet buttons finished loading (device supports Apple/Google Pay).
          Ryft.addEventHandler?.('walletButtonsReady', () => { if (mounted.current) setWalletReady(true); });
          // A wallet (Apple/Google Pay) payment completed — same shape as card.
          Ryft.addEventHandler?.('walletPaymentSessionResult', (e) => handleResult(e?.paymentSession || e));
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
      // attemptPayment drives the whole flow including the inline 3DS v2
      // challenge, resolving only once authentication completes (Approved =
      // manual-capture hold authorised; Captured = taken immediately).
      const ps = await Ryft.attemptPayment();
      handleResult(ps);
    } catch (err) {
      const Ryft = window.Ryft;
      const msg = (Ryft?.getUserFacingErrorMessage?.(err)) || err?.message || 'Payment failed — please try again';
      setError(msg);
      setPhase('ready');
      onError?.(err);
    }
  }

  const amountLabel = `${currency === 'usd' ? '$' : currency === 'eur' ? '€' : '£'}${(Number(amountMinor || 0) / 100).toFixed(2)}`;

  return (
    <form id="ryft-pay-form" onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
      {phase === 'init' && <div style={{ fontSize: 13, color: 'var(--t3)' }}>Loading secure card form…</div>}
      {/* Ryft injects the Apple/Google Pay buttons (when supported) into the
          form; this container gives them a home above the card fields. */}
      <div id="ryft-pay-wallet" />
      {walletReady && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--t4)', fontSize: 12, margin: '2px 0' }}>
          <span style={{ flex: 1, height: 1, background: 'var(--bdr)' }} />
          or pay by card
          <span style={{ flex: 1, height: 1, background: 'var(--bdr)' }} />
        </div>
      )}
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
