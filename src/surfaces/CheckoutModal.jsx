import { useCompact } from '../lib/useCompact';
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ALLERGENS } from '../data/seed';
import SplitModal from '../components/SplitModal';
import { useStore } from '../store';
import { calculateOrderTax } from '../lib/tax';
import {
  resolvePlatformLocationId,
  getAssignedNetworkReader,
} from '../lib/networkReader';
import { getActiveLocationSync, supabase, platformSupabase, ensureAuthToken, isMock } from '../lib/supabase';
import { getLocationProcessor, getLocationProcessorInfo } from '../lib/payments/processor';
import { chargeRyftTerminal } from '../lib/payments/ryftTerminal';
import { fetchCustomerByPhone } from '../lib/customerLookup';
import { redeemLoyaltyReward } from '../lib/loyaltyRedeem';
import { stageGiftCard, commitGiftCard, giftCardCheckRecord, reverseGiftCard } from '../lib/giftCommit';
import { money, currencySymbol, stripeCurrency, getActiveCurrencyCode } from '../lib/currency';
import { publishDisplay, displayUsesScreen, publishTipRequest, onCustomerTip } from '../lib/customerDisplay';
import { isTrainingMode } from '../lib/trainingMode';
import PaxTerminal from './PaxTerminal';
import {
  findPaxTerminal, dispatchTerminalJob, buildCheckKey, toMinor, forgetJob, getPosDeviceId,
  fetchJobs,
} from '../lib/payments/terminalJobs';
// (readerDisplay imports removed — cancel now lets the natural cart-change effect refresh the reader after onBack)

// ─── Tip picker ───────────────────────────────────────────────────────────────

// ─── Card terminal ────────────────────────────────────────────────────────────
// Handles three modes, in order:
//   1. NETWORK READER (BBPOS WisePOS E, S700) — REST flow. Customer interacts
//      directly with the reader screen: line items, tip prompt, card prompt.
//      No Android bridge required. This is the primary path.
//   2. BLUETOOTH M2 (Sunmi APK with bridge) — bridge flow. Cashier-facing only.
//      Kept as a fallback for mobile checkout scenarios.
//   3. SIMULATED — browser dev / non-Sunmi devices. Click-to-approve UI.
function CardTerminal({ items, grand, tipAmt, onComplete, onBack }) {
  const compact = useCompact();

  // REST flow state (network reader)
  const [networkReader, setNetworkReader] = useState(null);            // { stripe_reader_id, label, ... }
  const [paymentIntentId, setPaymentIntentId] = useState(null);
  const [platformLocId, setPlatformLocId] = useState(null);
  const [restState, setRestState] = useState('idle');                  // idle | starting | collecting | success | error | cancelling
  const [restStatusMsg, setRestStatusMsg] = useState('');

  // Simulated fallback (browser dev / no reader assigned)
  const [state, setState] = useState('waiting');                      // waiting | approved
  const [errorMsg, setErrorMsg] = useState(null);
  const [piResult, setPiResult] = useState(null);
  const [processor, setProcessor] = useState('stripe');                // 'stripe' | 'ryft' — per location
  // v5.5.808: null = still resolving, true = definitive answer, false = lookup
  // FAILED ('stripe' is only a guess). A failed lookup must never fall through
  // to the click-to-approve simulator on a production till.
  const [processorKnown, setProcessorKnown] = useState(null);
  // v5.5.808: true once the reader/processor lookup has finished (success OR
  // failure) — the "unavailable" dead-end must not flash while still resolving.
  const [lookupDone, setLookupDone] = useState(false);
  const startedRef = useRef(false);
  const pollAbortRef = useRef(false);
  const ryftAbortRef = useRef(null);
  const ryftFlightRef = useRef(null);   // in-flight chargeRyftTerminal promise (awaited by Cancel)

  // Resolve location + check for assigned network reader on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const opsLocationId = getActiveLocationSync();
        if (!opsLocationId) return;
        const platformId = await resolvePlatformLocationId(opsLocationId);
        if (cancelled) return;
        setPlatformLocId(platformId);
        // Per-location processor (defaults to 'stripe' — never breaks live venues).
        try {
          const info = await getLocationProcessorInfo(opsLocationId);
          if (!cancelled) { setProcessor(info.processor); setProcessorKnown(info.definitive); }
        } catch { if (!cancelled) setProcessorKnown(false); /* stays stripe, non-definitive */ }
        const assigned = await getAssignedNetworkReader();
        if (cancelled) return;
        setNetworkReader(assigned);
      } catch (e) {
        console.warn('[CardTerminal] resolve location/reader failed:', e?.message ?? e);
      } finally {
        if (!cancelled) setLookupDone(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ─── REST flow: start payment when the terminal path is ready ─────────
  // Stripe reader path needs the assigned reader + platform location resolved.
  // Ryft path just needs the processor resolved to 'ryft' (no Stripe reader).
  useEffect(() => {
    if (restState !== 'idle' || startedRef.current) return;
    const ryft = processor === 'ryft';
    if (!ryft && (!networkReader || !platformLocId)) return;
    startedRef.current = true;
    runRestFlow();
  }, [networkReader, platformLocId, restState, processor]);

  // Smooth transition to "approved" → call onComplete after brief moment.
  // v5.5.172: pass the captured PI through so the parent can derive the
  // ACTUAL reader-collected tip (amountReceived - base bill).
  useEffect(() => {
    if (state === 'approved' || restState === 'success') {
      // v5.5.560: 900ms → 250ms. This delay sat in front of the whole close → print →
      // cash-drawer chain; 250ms still shows the "approved" tick but cuts ~650ms of dead
      // time before the kitchen ticket/receipt print and the drawer pulse.
      const t = setTimeout(() => onComplete(piResult), 250);
      return () => clearTimeout(t);
    }
  }, [state, restState, onComplete, piResult]);

  // Cleanup: cancel any in-flight reader/terminal action when this screen unmounts.
  // v5.5.808: read state through a ref — the old [] -deps closure captured the
  // INITIAL null paymentIntentId, so the Stripe cancel never actually fired; and
  // the Ryft AbortController was never aborted at all, leaving the PAX live
  // collecting a card after a reload/navigation (tap = captured money, no check).
  const cleanupRef = useRef({});
  cleanupRef.current = { paymentIntentId, restState, networkReader, platformLocId };
  useEffect(() => () => {
    pollAbortRef.current = true;
    // Ryft: abort the in-flight terminal charge — the helper fires
    // ryft-terminal-cancel from its abort path (best-effort, survives unmount).
    try { ryftAbortRef.current?.abort(); } catch { /* */ }
    const c = cleanupRef.current;
    if (c.paymentIntentId && (c.restState === 'collecting' || c.restState === 'starting')) {
      // Best-effort cancel — don't await
      callCancelReaderAction({ paymentIntentId: c.paymentIntentId, readerId: c.networkReader?.stripe_reader_id, locationId: c.platformLocId })
        .catch(() => {});
    }
  }, []);

  // ─── Mirror payment status to the dedicated customer display ──────────────
  // paying → approved/declined. (The WisePOS E shows this natively; this is for
  // a separate screen running ?mode=customer-display.)
  const payRef = useRef({});
  payRef.current = { restState, state, grand, tipAmt, items };
  useEffect(() => {
    if (!displayUsesScreen()) return;
    let st = 'paying';
    if (restState === 'success' || state === 'approved') st = 'approved';
    else if (restState === 'error') st = 'declined';
    publishDisplay({ state: st, total: grand, currency: getActiveCurrencyCode() });
  }, [restState, state, grand]);
  // On leaving the card screen WITHOUT completing (back/cancel), put the cart
  // back on the display. On success the parent clears the cart (→ broadcasts idle).
  useEffect(() => () => {
    if (!displayUsesScreen()) return;
    const { restState: rs, state: ss, items: its } = payRef.current;
    if (rs === 'success' || ss === 'approved') return;
    const di = (its || []).filter(it => it && it.price != null).map(it => {
      const unitMods = (it.mods || []).reduce((s, m) => s + (Number(m.price) || 0), 0);
      const qty = Math.max(1, Number(it.qty) || 1);
      return { uid: it.uid, name: it.menuName || it.name || 'Item', qty,
        lineTotal: Math.max(0, ((Number(it.price) || 0) + unitMods) * qty),
        mods: (it.mods || []).map(m => ({ label: m.label, price: Number(m.price) || 0 })), notes: it.notes || '' };
    });
    const cartTotal = di.reduce((s, it) => s + (Number(it.lineTotal) || 0), 0);
    publishDisplay(di.length
      ? { state: 'active', items: di, total: cartTotal, currency: getActiveCurrencyCode() }
      : { state: 'idle', items: [], total: 0 });
  }, []);

  // ─── Ryft card-present (POS terminal) flow ──────────────────────────────
  // Only runs for locations whose processor is 'ryft' (none in production yet).
  // Drives the SAME restState UI as the Stripe reader flow. Built to the Ryft
  // in-person spec; verify against a Ryft reader when hardware is available.
  const runRyftTerminalFlow = async () => {
    const controller = new AbortController();
    ryftAbortRef.current = controller;
    // Keep the promise so Cancel can AWAIT the outcome (cancel confirmed vs
    // customer tap winning the race) instead of instantly returning to review.
    const flight = chargeRyftTerminal({
      locationId: getActiveLocationSync(),
      posDeviceId: (() => { try { return JSON.parse(localStorage.getItem('rpos-device') || 'null')?.id || null; } catch { return null; } })(),
      amountMinor: Math.round(grand * 100),
      currency: stripeCurrency(),
      captureMethod: 'automatic',
      signal: controller.signal,
      onProgress: (state) => {
        if (state === 'present_card') { setRestState('collecting'); setRestStatusMsg('Ask the customer to present their card'); }
        else if (state === 'processing') setRestStatusMsg('Processing on the terminal…');
      },
    });
    ryftFlightRef.current = flight;
    try {
      const result = await flight;
      // v5.5.808: record what Ryft says was CAPTURED, not what we asked for —
      // falls back to the requested amount on older fn responses.
      const requestedMinor = Math.round(grand * 100);
      const capturedMinor = Number.isFinite(result.amountMinor) ? result.amountMinor : requestedMinor;
      setRestState('success');
      setRestStatusMsg('Payment approved');
      setPiResult({ status: 'succeeded', paymentIntentId: result.paymentSessionId, amount: capturedMinor, amountReceived: capturedMinor, processor, card: result.card || null });
    } catch (e) {
      if (e.message === 'cancelled') return;             // user cancelled — handled by cancelRestFlow
      setRestState('error');
      // v5.5.808: a definitive decline reads as a decline, not a generic failure/timeout.
      setErrorMsg(e.declined ? 'Card declined — try another card' : (e.message || 'Terminal payment failed'));
    } finally {
      ryftAbortRef.current = null;
      ryftFlightRef.current = null;
    }
  };

  // ─── REST flow runner ──────────────────────────────────────────────────
  const runRestFlow = async () => {
    setRestState('starting');
    setRestStatusMsg('Pushing cart to reader…');
    setErrorMsg(null);

    // TRAINING MODE: never reach a real processor (Stripe reader OR Ryft terminal).
    // Simulate an instant approval so the rest of the (in-memory) close flow runs
    // exactly as normal. amountReceived = grand so the parent derives the picked tip
    // correctly (amountReceived − total). This is the single payment safety gate.
    if (isTrainingMode()) {
      const minor = Math.round(grand * 100);
      setPiResult({ status: 'succeeded', paymentIntentId: 'pi_training', amount: minor, amountReceived: minor, processor: 'training', training: true });
      setRestStatusMsg('TRAINING — no card charged');
      setRestState('success');
      return;
    }

    // Ryft AND Adyen venues take the terminal payment via the terminal_jobs
    // pipeline — it is processor-blind by design: terminal-job-create routes by
    // the terminal's link (adyen_terminal_id ⇒ Adyen cloud, else Ryft/PAX) and
    // the v5.6.18 "still being built" refusal retired in v5.6.49.
    if (processor === 'ryft' || processor === 'adyen') return runRyftTerminalFlow();

    try {
      // Build line items for set_reader_display
      // v5.5.172: NO tip line item — Stripe Terminal Configuration prompts
      // the customer for a tip on the reader after the cart screen. The
      // tip the customer picks is added to amount_received automatically
      // and surfaces back in piResult.amountReceived after capture.
      const lineItems = (items ?? [])
        .filter(it => it && it.price != null)
        .map(it => ({
          description: String(it.name || it.title || 'Item').slice(0, 60),
          amount: Math.round(Number(it.price) * 100),
          quantity: Math.max(1, Math.round(Number(it.qty || it.quantity || 1))),
        }));

      // v5.5.170: was sending the whole rpos-device JSON blob as opsDeviceId.
      // Edge fn looks up pos_devices.id and got "device not found". Parse + extract.
      const opsDeviceId = (() => {
        try {
          const raw = localStorage.getItem('rpos-device');
          if (!raw) return '';
          const parsed = JSON.parse(raw);
          return parsed?.id || '';
        } catch { return ''; }
      })();
      if (!opsDeviceId) throw new Error('POS device id missing — pair this device in BO → Device Pairing first.');

      // v5.5.183: use ensureAuthToken() — POS devices don't have a BO login
      // session, so fall back to anonymous sign-in for the edge-function JWT.
      const token = await ensureAuthToken();
      if (!token) throw new Error('Could not obtain auth token — check Anonymous sign-ins are enabled in Supabase Auth.');

      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-process-payment-on-reader`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          pos_device_id: opsDeviceId,
          // v5.5.172: send the base bill (before tip). tipAmt is now always
          // 0 because handleCardPress skips the POS tip picker; the reader
          // prompts the customer for the tip and Stripe adjusts the PI
          // amount on confirm. amountReceived post-capture = base + tip.
          amount_minor: Math.round(grand * 100),
          currency: stripeCurrency(),                                              // TODO: read from location.currency
          line_items: lineItems,
        }),
      });
      const j = await res.json();
      // v5.5.178: surface the tipping config diagnostic to console so we can
      // see whether Stripe has GBP tipping configured for this reader.
      console.log('[stripe-process-payment-on-reader] response:', j);
      if (!res.ok || j.error) throw new Error(j.error ?? `HTTP ${res.status}`);

      setPaymentIntentId(j.payment_intent_id);
      setRestState('collecting');
      setRestStatusMsg('Customer is paying on reader');

      // Begin polling
      pollAbortRef.current = false;
      pollPaymentIntent(j.payment_intent_id, j.reader_id, platformLocId);
    } catch (e) {
      setRestState('error');
      setErrorMsg(e.message || String(e));
    }
  };

  const pollPaymentIntent = async (piId, readerId, locId) => {
    const start = Date.now();
    const POLL_INTERVAL = 1500;                                         // 1.5s between polls
    const TIMEOUT_MS = 5 * 60 * 1000;                                   // 5 minutes
    while (!pollAbortRef.current && Date.now() - start < TIMEOUT_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      if (pollAbortRef.current) return;
      try {
        const pollToken = await ensureAuthToken();
        const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-poll-reader-action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${pollToken}` },
          body: JSON.stringify({ payment_intent_id: piId, reader_id: readerId, location_id: locId }),
        });
        const j = await res.json();
        if (!res.ok) {
          console.warn('[CardTerminal] poll error:', j.error);
          continue;                                                     // transient — keep polling
        }
        // Update status message based on reader action stage
        const ra = j.reader_action;
        if (ra?.type === 'process_payment_intent' && ra?.status === 'in_progress') {
          setRestStatusMsg('Customer is selecting tip / paying on reader');
        }
        if (j.is_terminal_state) {
          if (j.is_success) {
            setRestState('success');
            setRestStatusMsg('Payment approved');
            setPiResult({
              status: 'succeeded',
              paymentIntentId: j.payment_intent_id,
              amount: j.amount,
              amountReceived: j.amount_received,
              applicationFee: j.application_fee_amount,
              card: j.card || null,   // card-scheme receipt block (brand/last4/auth code/AID/CVM)
            });
          } else {
            setRestState('error');
            setErrorMsg(
              j.last_payment_error
              ?? ra?.failure_message
              ?? `Payment ${j.payment_intent_status}`,
            );
          }
          return;
        }
      } catch (e) {
        console.warn('[CardTerminal] poll iter failed:', e?.message ?? e);
      }
    }
    if (!pollAbortRef.current) {
      setRestState('error');
      setErrorMsg('Timed out — customer didn\'t complete payment within 5 minutes');
    }
  };

  const cancelRestFlow = async () => {
    pollAbortRef.current = true;
    // Ryft: abort the in-flight terminal charge (the helper cancels the action).
    // v5.5.808: WAIT for the cancel to be confirmed before leaving the payment
    // screen — returning instantly left a window where the PAX was still live
    // and a customer tap = captured money with no closed check.
    if (processor === 'ryft') {
      if (piResult) return;                       // payment already approved — let completion run
      setRestState('cancelling');
      try { ryftAbortRef.current?.abort(); } catch { /* */ }
      const flight = ryftFlightRef.current;
      if (flight) {
        const outcome = await Promise.race([
          flight.then(() => ({ ok: true, paid: true }))
                .catch(e => ({ ok: e?.message === 'cancelled' && e?.cancelConfirmed !== false, paid: false })),
          new Promise(r => setTimeout(() => r({ ok: false, timeout: true }), 10000)),
        ]);
        if (outcome.paid) { setRestState('success'); return; }   // customer tap beat the cancel — complete the sale
        if (!outcome.ok) {
          setRestState('error');
          setErrorMsg('Could not confirm the terminal cancel — check the terminal screen before retrying. Do NOT let the customer tap.');
          return;
        }
      }
      onBack();
      return;
    }
    setRestState('cancelling');
    try {
      await callCancelReaderAction({
        paymentIntentId,
        readerId: networkReader?.stripe_reader_id,
        locationId: platformLocId,
      });
    } catch (e) {
      console.warn('[CardTerminal] cancel failed:', e?.message ?? e);
    }
    // v5.5.178: do NOT immediately push the cart back. The cancel needs
    // ~1-2 seconds to propagate to the reader; if we push the live cart
    // right after, the reader's "cancelling" transition gets overwritten
    // and from the cashier's POV nothing happened. Wait 2 seconds, THEN
    // the natural cart-change effect from going back to the review screen
    // will refresh the reader display.
    onBack();
  };

  // ─── Render ────────────────────────────────────────────────────────────
  // Prioritise REST flow when a network reader is assigned, OR when the
  // location runs on Ryft (card-present goes through the Ryft terminal).
  const useRest = !!networkReader || processor === 'ryft';
  // v5.5.808: the click-to-approve simulator is dev/training ONLY. A production
  // till must never be able to close a real check as paid with no money taken —
  // if there's no reader (or the processor lookup failed), say so honestly.
  const allowSimulated = isMock || isTrainingMode();

  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', textAlign:'center' }}>
      {/* REST flow: starting / collecting */}
      {useRest && (restState === 'starting' || restState === 'collecting' || restState === 'cancelling') && (
        <RestCardWaiting
          grand={grand}
          // v5.5.808: networkReader is NULL on a Ryft-only till (no Stripe reader
          // bound) — the unguarded deref crashed the whole POS mid-payment.
          readerLabel={networkReader?.label || networkReader?.stripe_reader_id || (processor === 'ryft' ? 'Ryft terminal' : 'card reader')}
          statusMsg={restStatusMsg}
          state={restState}
          onCancel={cancelRestFlow}
        />
      )}

      {/* REST flow: success */}
      {useRest && restState === 'success' && (
        <ApprovedView grand={grand}/>
      )}

      {/* REST flow: error */}
      {useRest && restState === 'error' && (
        <div style={{ padding:'20px 8px', textAlign:'center' }}>
          <div style={{ fontSize:48, marginBottom:8 }}>⚠️</div>
          <div style={{ fontSize:18, fontWeight:800, color:'var(--red)', marginBottom:6 }}>Payment failed</div>
          <div style={{ fontSize:13, color:'var(--t2)', marginBottom:16, maxWidth:380, margin:'0 auto 16px' }}>
            {errorMsg || 'Unknown error'}
          </div>
          <div style={{ display:'flex', gap:8, justifyContent:'center' }}>
            <button className="btn btn-ghost" style={{ height:46, padding:'0 22px' }} onClick={onBack}>← Back</button>
            <button className="btn btn-grn" style={{ height:46, padding:'0 22px' }}
              onClick={() => { startedRef.current = false; pollAbortRef.current = false; setRestState('idle'); setErrorMsg(null); }}>
              Retry
            </button>
          </div>
        </div>
      )}

      {/* No network reader assigned → simulated (browser dev / training ONLY) */}
      {!useRest && state==='waiting' && allowSimulated && (
        <SimulatedCardWaiting grand={grand} onSimulate={() => setState('approved')} onBack={onBack} />
      )}

      {/* v5.5.808: production till, lookup still running — neutral holding state */}
      {!useRest && state==='waiting' && !allowSimulated && !lookupDone && (
        <div style={{ padding:'32px 8px', textAlign:'center' }}>
          <div style={{ fontSize:14, color:'var(--t3)', marginBottom:16 }}>Connecting to card reader…</div>
          <button className="btn btn-ghost" style={{ height:42, padding:'0 20px' }} onClick={onBack}>← Back</button>
        </div>
      )}

      {/* v5.5.808: production till with no reader (or a failed processor lookup) —
          an honest dead-end instead of the click-to-approve simulator. */}
      {!useRest && state==='waiting' && !allowSimulated && lookupDone && (
        <CardUnavailable
          detail={processorKnown === false
            ? 'Could not reach the payment service — check this till’s internet connection and try again.'
            : 'No card reader is available on this till — check the reader assignment in Back Office → Card readers, or take another payment method.'}
          onBack={onBack}
        />
      )}

      {!useRest && state==='approved' && <ApprovedView grand={grand}/>}
    </div>
  );
}

function CardUnavailable({ detail, onBack }) {
  return (
    <div style={{ padding:'20px 8px', textAlign:'center' }}>
      <div style={{ fontSize:48, marginBottom:8 }}>📵</div>
      <div style={{ fontSize:18, fontWeight:800, color:'var(--red)', marginBottom:6 }}>Card payments unavailable</div>
      <div style={{ fontSize:13, color:'var(--t2)', marginBottom:16, maxWidth:380, margin:'0 auto 16px' }}>{detail}</div>
      <button className="btn btn-ghost" style={{ height:46, padding:'0 22px' }} onClick={onBack}>← Back</button>
    </div>
  );
}

async function callCancelReaderAction({ paymentIntentId, readerId, locationId }) {
  const token = await ensureAuthToken();
  if (!token) throw new Error('Could not obtain auth token for cancel.');
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-cancel-reader-action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ payment_intent_id: paymentIntentId, reader_id: readerId, location_id: locationId }),
  });
  const j = await res.json();
  // v5.5.178: log the cancel diagnostic to console so we can see what happened
  console.log('[cancel-reader-action] response:', j);
  if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j;
}

function RestCardWaiting({ grand, readerLabel, statusMsg, state, onCancel }) {
  return (
    <div style={{ padding:'18px 8px', width:'100%', maxWidth:480, margin:'0 auto' }}>
      <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:6 }}>
        Customer-facing payment
      </div>
      <div style={{ padding:'18px 16px', borderRadius:14, background:'var(--bg2)', border:'1px solid var(--bdr)', marginBottom:14 }}>
        <div style={{ fontSize:36, marginBottom:6 }}>📲</div>
        <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', marginBottom:4 }}>
          {money(Number(grand))} on {readerLabel}
        </div>
        <div style={{ fontSize:13, color:'var(--t3)' }}>{statusMsg}</div>
        <div style={{ marginTop:10, fontSize:11, color:'var(--t4)', lineHeight:1.5 }}>
          Customer should see the line items, tip prompt, and card prompt on the reader screen.
        </div>
      </div>
      <button className="btn btn-ghost" style={{ width:'100%', height:46 }} disabled={state==='cancelling'} onClick={onCancel}>
        {state === 'cancelling' ? 'Cancelling…' : '✕ Cancel payment'}
      </button>
    </div>
  );
}

function ApprovedView({ grand }) {
  return (
    <div style={{ padding:'20px 0' }}>
      <div style={{
        width:88, height:88, borderRadius:'50%',
        background:'var(--grn-d)', border:'2px solid var(--grn)',
        display:'flex', alignItems:'center', justifyContent:'center',
        fontSize:48, color:'var(--grn)', margin:'0 auto 14px',
      }}>✓</div>
      <div style={{ fontSize:22, fontWeight:800, color:'var(--grn)', marginBottom:4 }}>Approved</div>
      <div style={{ fontSize:14, color:'var(--t2)' }}>{money(Number(grand))} charged</div>
    </div>
  );
}

function SimulatedCardWaiting({ grand, onSimulate, onBack }) {
  return (
    <>
      <div style={{ position:'relative', width:120, height:120, marginBottom:24 }}>
        <svg width="120" height="120" style={{ position:'absolute', top:0, left:0 }}>
          <circle cx="60" cy="60" r="54" fill="none" stroke="var(--bdr2)" strokeWidth="3"/>
        </svg>
        <svg width="120" height="120" style={{ position:'absolute', top:0, left:0, animation:'spin .9s linear infinite' }}>
          <circle cx="60" cy="60" r="54" fill="none" stroke="var(--acc)" strokeWidth="3"
            strokeDasharray="100 240" strokeLinecap="round"/>
        </svg>
        <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <div style={{ width:64, height:44, borderRadius:8, background:'var(--bg3)', border:'2px solid var(--bdr2)', display:'flex', flexDirection:'column', overflow:'hidden', boxShadow:'var(--sh)' }}>
            <div style={{ height:12, background:'var(--acc)', opacity:.7 }}/>
            <div style={{ flex:1, display:'flex', alignItems:'flex-end', padding:'4px 6px', gap:3 }}>
              {[1,2,3,4].map(i=><div key={i} style={{ flex:1, height:3, borderRadius:1, background:'var(--t4)' }}/>)}
            </div>
          </div>
        </div>
      </div>
      <div style={{ fontSize:38, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)', letterSpacing:'-.02em', marginBottom:6 }}>
        {money(grand)}
      </div>
      <div style={{ fontSize:15, color:'var(--t2)', fontWeight:600, marginBottom:4 }}>Present card to reader</div>
      <div style={{ fontSize:12, color:'var(--t4)', marginBottom:8 }}>(Simulator — pair an M2 in BO to take real payments)</div>

      <div style={{ display:'flex', gap:12, marginBottom:28 }}>
        {['Tap','Chip','Swipe','Apple Pay','Google Pay'].map(m=>(
          <div key={m} style={{ fontSize:10, fontWeight:600, color:'var(--t4)', padding:'3px 8px', borderRadius:20, border:'1px solid var(--bdr)', background:'var(--bg3)' }}>{m}</div>
        ))}
      </div>

      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 20px', background:'var(--acc-d)', border:'1px solid var(--acc-b)', borderRadius:22, fontSize:12, color:'var(--acc)', fontWeight:700, marginBottom:24 }}>
        <div style={{ width:7,height:7,borderRadius:'50%',background:'var(--acc)',animation:'pulse 1.4s ease-in-out infinite'}}/>
        Waiting for card…
      </div>

      <div style={{ display:'flex', gap:8, width:'100%' }}>
        <button className="btn btn-ghost" style={{ flex:1, height:46 }} onClick={onBack}>← Back</button>
        <button className="btn btn-grn" style={{ flex:2, height:46, fontSize:14, fontWeight:800 }}
          onClick={onSimulate}>
          Simulate payment ✓
        </button>
      </div>
    </>
  );
}

// ─── Cash transaction ─────────────────────────────────────────────────────────
function CashTransaction({ grand, onComplete, onBack }) {
  const compact = useCompact();
  const [entered, setEntered] = useState('');
  const tendered = parseFloat(entered) || 0;
  // v5.5.822: compare in PENCE, never raw floats. `grand` is the result of float
  // arithmetic (total + tip − gift − loyalty − promo), so it routinely carries dust
  // like 0.30000000000000004. "Exact" fills the box with grand.toFixed(2) → "0.30",
  // and 0.30 >= 0.30000000000000004 is FALSE — so tendering the exact amount read as
  // short by £0.00 and left Complete disabled. Same idiom the card path already uses.
  const grandMinor    = Math.round(grand * 100);
  const tenderedMinor = Math.round(tendered * 100);
  const shortMinor    = Math.max(0, grandMinor - tenderedMinor);
  const change        = Math.max(0, tenderedMinor - grandMinor) / 100;
  const isValid       = tenderedMinor >= grandMinor;

  const press = (d) => {
    if (d==='⌫') { setEntered(p=>p.slice(0,-1)); return; }
    if (d==='.' && entered.includes('.')) return;
    if (entered.includes('.') && entered.split('.')[1]?.length>=2) return;
    if (entered.length >= 7) return;
    setEntered(p=>p+d);
  };

  const quickAmounts = [
    ...([5,10,20,50].filter(n=>Math.round(n*100)>=grandMinor)),
    Math.ceil(grand),
    Math.ceil(grand/5)*5,
  ].filter((v,i,a)=>a.indexOf(v)===i).sort((a,b)=>a-b).slice(0,5);

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:0 }}>
      {/* Amount due + change display */}
      <div style={{ marginBottom:14 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:10 }}>
          <div>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:3 }}>Amount due</div>
            <div style={{ fontSize:compact?22:30, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)', letterSpacing:'-.01em' }}>{money(grand)}</div>
          </div>
          <div style={{ textAlign:'right' }}>
            <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'.08em', marginBottom:3,
              color:isValid?'var(--grn)':entered?'var(--red)':'var(--t4)' }}>
              {isValid?'Change':'Short by'}
            </div>
            <div style={{ fontSize:compact?22:30, fontWeight:800, fontFamily:'var(--font-mono)', letterSpacing:'-.01em',
              color:isValid?'var(--grn)':entered?'var(--red)':'var(--t4)' }}>
              {isValid?`${money(change)}`:entered?`${money(shortMinor/100)}`:'—'}
            </div>
          </div>
        </div>

        {/* Tendered display */}
        <div style={{
          padding:'12px 16px', borderRadius:14, border:`2px solid ${isValid?'var(--grn-b)':entered?'var(--acc-b)':'var(--bdr2)'}`,
          background:isValid?'var(--grn-d)':entered?'var(--acc-d)':'var(--bg3)',
          display:'flex', alignItems:'center', justifyContent:'space-between', transition:'all .2s',
        }}>
          <div style={{ fontSize:11, color:'var(--t3)', fontWeight:600 }}>
            {entered ? 'Tendered' : 'Enter amount or tap quick cash'}
          </div>
          <div style={{ fontSize:22, fontWeight:800, fontFamily:'var(--font-mono)', color:isValid?'var(--grn)':entered?'var(--acc)':'var(--t4)' }}>
            {entered ? `${money(tendered)}` : '£—'}
          </div>
        </div>
      </div>

      {/* Quick cash */}
      <div style={{ display:'flex', gap:5, marginBottom:10 }}>
        {quickAmounts.map(a=>(
          <button key={a} onClick={()=>setEntered(String(a))} style={{
            flex:1, padding:'7px 2px', borderRadius:9, cursor:'pointer', fontFamily:'inherit',
            background:entered===String(a)?'var(--acc-d)':'var(--bg3)',
            border:`1.5px solid ${entered===String(a)?'var(--acc)':'var(--bdr)'}`,
            color:entered===String(a)?'var(--acc)':'var(--t2)',
            fontSize:12, fontWeight:800, transition:'all .1s',
          }}>{currencySymbol()}{a}</button>
        ))}
        <button onClick={()=>setEntered(grand.toFixed(2))} style={{
          flex:1.2, padding:'7px 2px', borderRadius:9, cursor:'pointer', fontFamily:'inherit',
          background:entered===grand.toFixed(2)?'var(--acc-d)':'var(--bg3)',
          border:`1.5px solid ${entered===grand.toFixed(2)?'var(--acc)':'var(--bdr)'}`,
          color:entered===grand.toFixed(2)?'var(--acc)':'var(--t2)',
          fontSize:11, fontWeight:800,
        }}>Exact</button>
      </div>

      {/* Numpad — bigger keys */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:6, marginBottom:12 }}>
        {[7,8,9,4,5,6,1,2,3,'.',0,'⌫'].map((d,i)=>(
          <button key={i} onClick={()=>press(String(d))} style={{
            height:compact?44:56, borderRadius:compact?9:11, cursor:'pointer', fontFamily:'inherit',
            background:d==='⌫'?'var(--red-d)':'var(--bg3)',
            border:`1.5px solid ${d==='⌫'?'var(--red-b)':'var(--bdr)'}`,
            color:d==='⌫'?'var(--red)':'var(--t1)',
            fontSize:d==='⌫'?(compact?16:20):(compact?18:22), fontWeight:700,
            transition:'all .08s',
          }}
          onMouseEnter={e=>e.currentTarget.style.background=d==='⌫'?'var(--red)':'var(--bg4)'}
          onMouseLeave={e=>e.currentTarget.style.background=d==='⌫'?'var(--red-d)':'var(--bg3)'}>
            {d==='⌫' ? '⌫' : d}
          </button>
        ))}
      </div>

      <div style={{ display:'flex', gap:8 }}>
        <button className="btn btn-ghost" style={{ flex:1, height:compact?40:50 }} onClick={onBack}>← Back</button>
        <button className="btn btn-grn" style={{ flex:2, height:compact?40:50, fontSize:compact?13:15, fontWeight:800 }}
          disabled={!isValid}
          onClick={()=>onComplete(tendered)}>
          {isValid ? `Complete · ${money(change)} change` : 'Enter cash amount'}
        </button>
      </div>
    </div>
  );
}

// ─── Gift card entry (v5.5.193) ─────────────────────────────────────────────
const GIFT_FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

// v5.5.505: this single box accepts BOTH a gift card and a marketing promo code. We tell them apart
// by shape — gift codes are exactly 16 chars of the gift alphabet (separators stripped); promo codes
// are short and usually hyphenated (e.g. BDAY-7F3K9). Try gift first ONLY when the input is 16 gift-
// chars; on a clean "not found" fall through to a promo validate. Promo apply is delegated to the
// parent (onPromoCode) which reuses the slice-1 promo wiring.
//
// v5.5.902: APPLY-ONLY, the kiosk/online pattern from v5.5.901. Applying a card now only
// LOOKS THE BALANCE UP (gift-lookup — read-only) and stages the discount; the real debit
// fires at check commit (see `complete` below). Before this, staff tapping Apply debited the
// card immediately with `order_id: tableId || walkin-<ts>` — close the modal, walk away, or
// have the remainder declined and the customer's balance was gone, with no check and nothing
// for the refund path to reverse.
//
// `totalMinor` is the amount the gift card may be applied against — the parent nets off any
// loyalty reward / promo code first, so a card can never be over-drawn (the online half of
// v5.5.901 fixed the same over-draw). It deliberately does NOT net off a card already staged
// here: entering a card REPLACES the staged one, so the full bill is available again.
function GiftCardEntry({ totalMinor, giftAlreadyApplied, onApplied, onRemove, onBack, promoAlreadyApplied, onPromoCode }) {
  const compact = useCompact();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [cardInfo, setCardInfo] = useState(null); // looked-up card details
  const codeRef = useRef(null);

  useEffect(() => { codeRef.current?.focus(); }, []);

  // Step 1: decide gift-vs-promo, then look up the gift card OR validate the promo code.
  const handleSubmit = async () => {
    const raw = code.trim();
    if (!raw) return;
    const giftStripped = raw.replace(/[\s-]/g, '').toUpperCase();
    setError(null);

    // Gift-shaped (exactly 16 chars of the gift alphabet) → try gift card first.
    if (/^[A-Z2-9]{16}$/.test(giftStripped)) {
      setLoading(true); setCardInfo(null);
      let status, j;
      try {
        const { data: session } = await supabase.auth.getSession();
        const token = session?.session?.access_token;
        if (!token) throw new Error('Not authenticated');
        const res = await fetch(`${GIFT_FUNCTIONS_URL}/gift-lookup`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ code: giftStripped, location_id: getActiveLocationSync() }),
        });
        status = res.status; j = await res.json().catch(() => ({}));
      } catch (e) {
        // Transport error — we can't tell "not a gift" from "gift service down"; do NOT fall through.
        setError('Could not check code — try again'); setLoading(false); return;
      }
      const notFound = status === 404 || (j?.error && /not found/i.test(j.error));
      if (!notFound) {
        // Definitive gift answer (found / void / zero balance / other error) — never misreport as promo.
        if (status >= 200 && status < 300 && !j?.error) {
          if (j.status !== 'active') { setError(`Card is ${j.status}`); setLoading(false); return; }
          if (j.balance <= 0) { setError('Card has zero balance'); setLoading(false); return; }
          setCardInfo(j); setLoading(false); return;
        }
        setError(j?.error || `HTTP ${status}`); setLoading(false); return;
      }
      // gift not found → fall through to promo
    }

    // Promo attempt. Keep the original (hyphen-preserving) string — promo lookup is case-insensitive
    // on the stored hyphenated code. Apply is delegated to the parent (reuses slice-1 wiring).
    if (promoAlreadyApplied) { setError('A promo code is already applied'); return; }
    setLoading(true);
    try {
      const r = await onPromoCode?.(raw.toUpperCase());
      if (r?.error) { setError(r.error); setLoading(false); }
      // on success the parent navigates away (this component unmounts)
    } catch (e) {
      setError('Could not check code — try again'); setLoading(false);
    }
  };

  // Step 2: STAGE the card. Pure — no server call, nothing debited. `stageGiftCard`
  // keeps the partial-balance behaviour (applied = min(balance, due)) and mints the
  // commit key ONCE, so every retry of this check's commit reuses it.
  const handleApply = () => {
    if (!cardInfo) return;
    setError(null);
    const staged = stageGiftCard({
      cardId: cardInfo.card_id,
      code: code.replace(/[\s-]/g, ''),
      codeLast4: cardInfo.code_last4,
      balanceMinor: cardInfo.balance,
      amountDueMinor: totalMinor,
    });
    if (staged.applied <= 0) { setError('Nothing to redeem'); return; }
    onApplied(staged);
  };

  const sym = String.fromCodePoint(0x00A3);
  const alreadyAppliedAmt = (giftAlreadyApplied?.applied || 0) / 100;
  const remainingDue = totalMinor / 100;

  return (
    <div>
      <div style={{ textAlign:'center', marginBottom:compact?12:20 }}>
        <div style={{ fontSize:compact?28:40, marginBottom:6 }}>{String.fromCodePoint(0x1F381)}</div>
        <div style={{ fontSize:compact?18:24, fontWeight:800, color:'var(--t1)' }}>
          {sym}{remainingDue.toFixed(2)} due
        </div>
      </div>

      {/* A card is already staged. Nothing has been debited yet, so it can simply be
          taken off — and entering another REPLACES it (one gift card per check, same
          as kiosk + online). Stated plainly so staff aren't left thinking they stack. */}
      {alreadyAppliedAmt > 0 && (
        <div style={{
          marginBottom:12, padding:'10px 12px', borderRadius:12,
          background:'var(--grn-d)', border:'1px solid var(--grn-b)',
          display:'flex', alignItems:'center', justifyContent:'space-between', gap:10,
        }}>
          <div>
            <div style={{ fontSize:13, fontWeight:700, color:'var(--grn)' }}>
              {String.fromCodePoint(0x1F381)} {sym}{alreadyAppliedAmt.toFixed(2)} applied
              {giftAlreadyApplied?.code_last4 ? ` · ...${giftAlreadyApplied.code_last4}` : ''}
            </div>
            <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>
              Not charged yet — entering another card replaces this one.
            </div>
          </div>
          {onRemove && (
            <button onClick={onRemove} style={{
              flexShrink:0, padding:'6px 12px', borderRadius:9,
              border:'1px solid var(--bdr2)', background:'transparent',
              color:'var(--t3)', fontSize:12, fontWeight:700, cursor:'pointer', fontFamily:'inherit',
            }}>Remove</button>
          )}
        </div>
      )}

      {/* Code entry */}
      {!cardInfo && (
        <div>
          <label style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6, display:'block' }}>
            Gift card or promo code
          </label>
          <input
            ref={codeRef}
            type="text"
            value={code}
            onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9\s-]/g, ''))}
            placeholder="Gift card or promo code"
            maxLength={19}
            style={{
              width:'100%', padding:'12px 14px', borderRadius:12,
              border:'2px solid var(--bdr2)', background:'var(--bg2)', color:'var(--t1)',
              fontSize:18, fontFamily:'var(--font-mono, monospace)', letterSpacing:'0.15em',
              textAlign:'center', outline:'none', boxSizing:'border-box',
            }}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
          />
          <button
            onClick={handleSubmit}
            disabled={loading || !code.trim()}
            style={{
              width:'100%', marginTop:12, padding:'14px', borderRadius:12,
              border:'none', cursor:'pointer', fontFamily:'inherit',
              background:'var(--acc)', color:'#0b0c10', fontSize:15, fontWeight:800,
              opacity: loading || !code.trim() ? 0.5 : 1,
            }}
          >
            {loading ? 'Checking...' : 'Apply code'}
          </button>
          <div style={{ fontSize:11, color:'var(--t4)', marginTop:8, textAlign:'center' }}>
            Enter a gift card number or a promo code — we'll work out which it is.
          </div>
        </div>
      )}

      {/* Card found: show balance and redeem */}
      {cardInfo && (
        <div style={{
          padding:16, borderRadius:14, background:'var(--bg2)',
          border:'1px solid var(--bdr)', marginBottom:12,
        }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
            <div>
              <div style={{ fontSize:11, color:'var(--t4)', fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em' }}>Card balance</div>
              <div style={{ fontSize:22, fontWeight:800, color:'var(--t1)' }}>
                {sym}{(cardInfo.balance / 100).toFixed(2)}
              </div>
            </div>
            <div style={{
              padding:'4px 10px', borderRadius:99, fontSize:11, fontWeight:700,
              background:'var(--grn-d)', color:'var(--grn)', border:'1px solid var(--grn)',
            }}>
              {cardInfo.status}
            </div>
          </div>
          <div style={{ fontSize:12, color:'var(--t3)', marginBottom:4 }}>
            Code ending in <strong style={{ fontFamily:'var(--font-mono)' }}>...{cardInfo.code_last4}</strong>
            {cardInfo.recipient_name && ` ${String.fromCodePoint(0x00B7)} ${cardInfo.recipient_name}`}
          </div>
          <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', marginTop:8 }}>
            Will apply: {sym}{(Math.min(cardInfo.balance, Math.round(remainingDue * 100)) / 100).toFixed(2)}
            {cardInfo.balance < Math.round(remainingDue * 100) && (
              <span style={{ fontWeight:400, color:'var(--t3)', marginLeft:8 }}>
                (partial, {sym}{(remainingDue - cardInfo.balance / 100).toFixed(2)} remaining)
              </span>
            )}
          </div>

          <button
            onClick={handleApply}
            disabled={loading}
            style={{
              width:'100%', marginTop:14, padding:'14px', borderRadius:12,
              border:'none', cursor:'pointer', fontFamily:'inherit',
              background:'var(--acc)', color:'#0b0c10', fontSize:15, fontWeight:800,
              opacity: loading ? 0.5 : 1,
            }}
          >
            {`Apply ${sym}${(Math.min(cardInfo.balance, Math.round(remainingDue * 100)) / 100).toFixed(2)} from gift card`}
          </button>
          <div style={{ fontSize:11, color:'var(--t4)', marginTop:6, textAlign:'center' }}>
            The card is only charged when the check is paid.
          </div>

          <button
            onClick={() => { setCardInfo(null); setCode(''); setError(null); }}
            style={{
              width:'100%', marginTop:8, padding:'10px', borderRadius:10,
              border:'1px solid var(--bdr2)', background:'transparent',
              color:'var(--t3)', fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:'inherit',
            }}
          >
            Use a different card
          </button>
        </div>
      )}

      {error && (
        <div style={{
          marginTop:12, padding:12, borderRadius:10,
          background:'var(--red-d)', color:'var(--red)',
          fontSize:13, border:'1px solid var(--red-b)',
        }}>
          {error}
        </div>
      )}

      <button
        onClick={onBack}
        disabled={loading}
        style={{
          width:'100%', marginTop:12, padding:'12px', borderRadius:10,
          border:'1px solid var(--bdr2)', background:'transparent',
          color:'var(--t3)', fontSize:13, fontWeight:600, cursor:'pointer', fontFamily:'inherit',
        }}
      >
        {String.fromCodePoint(0x2190)} Back to payment options
      </button>
    </div>
  );
}

// ─── Loyalty rewards entry (v5.5.218) ─────────────────────────────────────────
// Staff selects a reward to redeem, we call loyalty-redeem, and apply the
// resulting discount to the checkout total. Follows the same pattern as
// GiftCardEntry above.
const FUNCTIONS_URL_LOYALTY = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

function LoyaltyRewardsEntry({ customer, loyaltyData, items = [], total, onApplied, onBack }) {
  const compact = useCompact();
  const [redeeming, setRedeeming] = useState(null); // reward id being redeemed
  const [error, setError] = useState('');

  const rewards = loyaltyData?.rewards || [];

  const redeem = async (reward) => {
    setError('');
    setRedeeming(reward.id);
    try {
      // v5.5.896: APPLY-ONLY — nothing is consumed server-side until the check commits
      // (store.redeemLoyaltyAtCommit, promo-code pattern). Free-item rewards refuse to
      // apply until an eligible item is in the basket, with a clear message.
      const applied = await redeemLoyaltyReward(reward, {
        customerId: loyaltyData.customerId || customer?.customerId,
        items, total,
      });
      onApplied(applied);
    } catch (e) {
      setError(e?.message || 'Could not apply reward');
    } finally {
      setRedeeming(null);
    }
  };

  return (
    <div>
      {/* Customer info */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16,
        padding: '12px 16px', borderRadius: 12,
        background: 'var(--acc-d, #2a1a0a)', border: '1px solid var(--acc-b, #E8743C33)',
      }}>
        <div style={{
          width: 40, height: 40, borderRadius: '50%', background: 'var(--acc)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 18, fontWeight: 800, color: '#0b0c10',
        }}>
          {(customer?.name || '?').charAt(0).toUpperCase()}
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{customer?.name || 'Customer'}</div>
          <div style={{ fontSize: 12, color: 'var(--acc)' }}>
            {loyaltyData.credit} points available
            {loyaltyData.tier && <span style={{ marginLeft: 6, color: loyaltyData.tier.color || 'var(--t3)' }}>· {loyaltyData.tier.name}</span>}
          </div>
        </div>
      </div>

      {error && (
        <div style={{ padding: 12, background: 'var(--red-d)', color: 'var(--red)', borderRadius: 8, marginBottom: 12, fontSize: 13, border: '1px solid var(--red-b)' }}>
          {error}
        </div>
      )}

      {/* Rewards list */}
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 10 }}>
        Choose a reward to redeem
      </div>

      {rewards.length === 0 && (
        <div style={{ padding: 20, textAlign: 'center', color: 'var(--t4)', fontSize: 13 }}>
          No rewards available at current points balance.
        </div>
      )}

      {rewards.map(r => (
        <button
          key={r.id}
          onClick={() => redeem(r)}
          disabled={!!redeeming}
          style={{
            width: '100%', padding: compact ? '12px 14px' : '14px 18px',
            borderRadius: 12, border: '1.5px solid var(--bdr2)', background: 'var(--bg2)',
            cursor: redeeming ? 'wait' : 'pointer', fontFamily: 'inherit',
            display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8,
            opacity: redeeming && redeeming !== r.id ? 0.5 : 1,
            transition: 'border-color .14s, transform .14s',
          }}
          onMouseEnter={e => { if (!redeeming) { e.currentTarget.style.borderColor = 'var(--acc)'; e.currentTarget.style.transform = 'translateY(-1px)'; }}}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--bdr2)'; e.currentTarget.style.transform = ''; }}
        >
          <div style={{
            width: 36, height: 36, borderRadius: 8, background: 'var(--acc-d, var(--bg3))',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 14, flexShrink: 0, border: '1px solid var(--bdr)',
          }}>
            {r.icon || 'gift'}
          </div>
          <div style={{ flex: 1, textAlign: 'left' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{r.label}</div>
            {r.description && <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>{r.description}</div>}
            {r.type === 'discount_fixed' && r.value?.amount_minor && (
              <div style={{ fontSize: 11, color: 'var(--grn)', marginTop: 2, fontWeight: 600 }}>
                {String.fromCodePoint(0x00A3)}{(r.value.amount_minor / 100).toFixed(2)} off
              </div>
            )}
            {r.type === 'discount_percent' && r.value?.percent && (
              <div style={{ fontSize: 11, color: 'var(--grn)', marginTop: 2, fontWeight: 600 }}>
                {r.value.percent}% off
              </div>
            )}
          </div>
          <div style={{ textAlign: 'right', flexShrink: 0 }}>
            {r.stamp ? (
              <>
                <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--grn)' }}>FREE</div>
                <div style={{ fontSize: 10, color: 'var(--t4)' }}>stamp card{r.available > 1 ? ` ×${r.available}` : ''}</div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--acc)', fontFamily: 'var(--font-mono)' }}>
                  {r.pointsCost}
                </div>
                <div style={{ fontSize: 10, color: 'var(--t4)' }}>pts</div>
              </>
            )}
            {/* v5.5.896: explicit affordance — staff didn't realise rows were tappable */}
            <div style={{ marginTop: 5, fontSize: 9, fontWeight: 800, letterSpacing: '.05em', color: 'var(--grn)', border: '1px solid rgba(34,197,94,.4)', borderRadius: 6, padding: '2px 7px', whiteSpace: 'nowrap' }}>
              TAP TO REDEEM
            </div>
          </div>
          {redeeming === r.id && <div style={{ fontSize: 11, color: 'var(--t3)', marginLeft: 6 }}>...</div>}
        </button>
      ))}

      <button onClick={onBack} style={{
        marginTop: 12, width: '100%', padding: '10px', borderRadius: 10,
        border: '1px solid var(--bdr2)', background: 'transparent',
        color: 'var(--t3)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
      }}>
        {String.fromCodePoint(0x2190)} Back to payment options
      </button>
    </div>
  );
}

// ─── Main checkout modal ──────────────────────────────────────────────────────
export default function CheckoutModal({ items, subtotal, service, deliveryFee = 0, total, orderType, covers, tableId, tabName, customer, onClose, onComplete }) {
  const compact = useCompact();
  const { taxRates, deviceConfig, myDrawer, pendingLoyaltyReward, setPendingLoyaltyReward } = useStore();
  // v5.5.731: while checkout is open, hold the auto-sign-out guard so an idle timeout can't sign the
  // operator out mid-transaction (e.g. customer taking >15s to tap the reader = no POS activity).
  useEffect(() => {
    const { blockSignout, unblockSignout } = useStore.getState();
    blockSignout?.();
    return () => unblockSignout?.();
  }, []);
  // v4.6.50: resolve the drawer bound to this POS terminal. If the POS has
  // no drawer configured at all, cash payments shouldn't be offered —
  // nowhere to put the cash. Drawer status (open/idle) is not gated here.
  const _drawer = typeof myDrawer === 'function' ? myDrawer() : null;
  // v4.6.50: Cash shows whenever a drawer is bound to the POS. Cashed-in vs
  // idle is handled by the sign-in gate (lock), not by hiding the button.
  const _canTakeCash = !!_drawer;
  const [screen, setScreen] = useState('review');
  const [namesOnly, setNamesOnly] = useState(false);
  const [tipAmt, setTipAmt] = useState(0);
  const [showSplit, setShowSplit] = useState(false);
  // Staff per-transaction override of the device-profile default. Default
  // tracks the device profile so existing behaviour is preserved when the
  // toggle is true (legacy). When toggle is false the checkbox lands unchecked.
  const [printReceipt, setPrintReceipt] = useState(deviceConfig?.autoPrintReceiptOnClose !== false);

  // v5.5.658: defence-in-depth against a duplicate charge. OrdersHub opens already-paid
  // orders read-only, but if ANY path loads a paid order into checkout, refuse to take payment.
  useEffect(() => {
    if (customer?.paid) {
      try { useStore.getState().showToast?.('This order has already been paid — opening read-only.', 'error'); } catch {}
      onClose?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v5.5.193: gift card partial payment state
  // v5.5.902: this now holds a STAGED card (lib/giftCommit.stageGiftCard) —
  // { card_id, code, code_last4, applied, balance_at_apply, remaining_balance,
  //   commit_key, pending_commit:true }. Nothing is debited until `complete` runs.
  const [giftApplied, setGiftApplied] = useState(null);
  const [giftError, setGiftError] = useState('');
  // The state value is read by render; the REF is read by `complete`. They must both
  // exist: the gift-covers-everything path calls complete() from inside the same tick
  // as setGiftApplied, so the closure still holds the OLD state. That staleness is why
  // a fully-gift-paid POS check recorded `giftCard: undefined` and could never be
  // reversed on refund — the ref closes that hole.
  const giftRef = useRef(null);
  const applyGift = useCallback((staged) => { giftRef.current = staged; setGiftApplied(staged); }, []);

  // v5.5.218: loyalty state
  const [loyaltyData, setLoyaltyData] = useState(null); // { credit, rewards, memberCode, tier, ... }
  const [loyaltyLoading, setLoyaltyLoading] = useState(false);
  const [loyaltyApplied, setLoyaltyApplied] = useState(null);
  // Promo code (marketing offers) — validated via promo-redeem; redeemed (bound to the order) by the store.
  // v5.5.505: entered through the unified gift-card/promo box (no separate field).
  const [promoApplied, setPromoApplied] = useState(null);   // { code, code_id, offer_id, type, value, amount, label }
  // loyaltyApplied: { reward_id, reward_name, points_deducted, discount_type, discount_value, idempotency_key }

  // Fetch loyalty data when checkout opens with a customer that has a phone
  useEffect(() => {
    if (!customer?.phone) return;
    let alive = true;
    setLoyaltyLoading(true);
    fetchCustomerByPhone(customer.phone).then(data => {
      if (!alive) return;
      if (data?.knownCustomer) setLoyaltyData(data);
    }).catch(() => {}).finally(() => { if (alive) setLoyaltyLoading(false); });
    return () => { alive = false; };
  }, [customer?.phone]);

  // v5.5.349: auto-apply the reward the customer chose on the customer display.
  // Guarded — only when loyalty loaded + nothing applied yet; failure is silent
  // (staff can still apply manually), so it can never block checkout.
  useEffect(() => {
    if (!pendingLoyaltyReward || !loyaltyData || loyaltyApplied) return;
    let alive = true;
    redeemLoyaltyReward(pendingLoyaltyReward, {
      customerId: loyaltyData.customerId || customer?.customerId, items, total,
    })
      .then(r => { if (alive) { setLoyaltyApplied(r); setPendingLoyaltyReward?.(null); } })
      .catch(() => { /* leave for manual apply */ });
    return () => { alive = false; };
  }, [pendingLoyaltyReward, loyaltyData, loyaltyApplied]);

  // Loyalty now supports points and stamp cards independently. The lookup
  // returns points_enabled / stamps_enabled; treat a missing flag as enabled
  // (older data / unaffected venues still render points). Only hide when the
  // flag is EXPLICITLY false. This surface has no stamp-card UI, so we only
  // need the points gate here (hides the points banner + rewards redeem screen
  // for a stamps-only venue).
  const pointsEnabled = loyaltyData?.points_enabled !== false;

  const isBarTab = orderType==='bar-tab';
  const skipTip  = isBarTab || orderType==='takeaway' || orderType==='collection';

  // v5.5.808: resolve the venue's card processor at modal level too — the card
  // press, split card legs and the terminal flow all dispatch by this. Defaults
  // to 'stripe', so live Stripe venues are never affected by a failed lookup.
  const [cardProcessor, setCardProcessor] = useState('stripe');
  // v5.5.829: Ryft has no on-reader tip prompt, so on Ryft venues WITH a customer
  // display we ask the customer to choose a gratuity on their own screen, then
  // charge bill+tip as one amount. tipCfg is the venue's own rules — the same row
  // Stripe's Terminal Configuration is built from.
  const [tipCfg, setTipCfg] = useState(null);
  const [awaitingTip, setAwaitingTip] = useState(false);
  const tipNonceRef = useRef(0);

  // v5.5.837 (PaxPay mode 3): is there a PAX terminal at this venue to send the
  // payment to? paxLookupDone gates the race — a card press BEFORE the lookup
  // lands must not silently take the old path and produce a different tip on the
  // same bill. Failure leaves paxTarget null, so every existing venue (Stripe
  // readers, Ryft REST) behaves exactly as before.
  const [paxTarget, setPaxTarget] = useState(null);
  const [paxLookupDone, setPaxLookupDone] = useState(false);
  const [paxJob, setPaxJob] = useState(null);
  const [paxError, setPaxError] = useState('');
  const [paxBusy, setPaxBusy] = useState(false);
  // v5.5.862: ONE check id per checkout, minted on the first send and held for the
  // life of this modal. It does two jobs: (a) it is the pre-minted closed_check_id
  // (was re-minted `chk-${Date.now()}` on EVERY press, breaking idempotent retry),
  // and (b) for a COUNTER sale it becomes the check-key leg, so every counter sale
  // gets its OWN key instead of the constant `<loc>:walkin:-` that every sale at
  // the venue shared. That shared key is why a finished sale's remembered job id
  // collided with the next customer's payment ("reference has already been used" /
  // "already been paid") until localStorage was cleared by hand. A retry within
  // THIS checkout reuses the ref → same key + id → re-attaches idempotently.
  //
  // v5.5.902: promoted from PAX-only to THE check id for this checkout. It rides out
  // on paymentInfo.closedCheckId and the store adopts it as the closed_check row id,
  // so the gift-card debit — which is keyed to the closed check id server-side
  // (`giftcommit:<check>:<card>`) — lands on the same id the refund reversal later
  // reads back off the check. Side benefit: the modal-driven close and the terminal-job
  // reconciler now agree on one id instead of minting two for the same PAX sale.
  const checkIdRef = useRef(null);
  const getCheckId = useCallback(() => {
    if (!checkIdRef.current) {
      checkIdRef.current = `chk-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    }
    return checkIdRef.current;
  }, []);
  useEffect(() => {
    let alive = true;
    // A training till never even looks — it must not learn about, or reach, a
    // real card terminal.
    if (isTrainingMode()) { setPaxLookupDone(true); return () => { alive = false; }; }
    // v5.5.838: findPaxTerminal now returns { terminal, reason }. `reason` is the
    // "2 terminals here and none is assigned to this till" case — a real
    // misconfiguration the manager has to fix, so it is shown rather than
    // silently falling back to the old path with no explanation.
    findPaxTerminal({ posDeviceId: getPosDeviceId() })
      .then(({ terminal, reason }) => {
        if (!alive) return;
        setPaxTarget(terminal);
        if (reason) setPaxError(reason);
      })
      .catch(() => { /* stays null — existing paths unaffected */ })
      .finally(() => { if (alive) setPaxLookupDone(true); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    let alive = true;
    getLocationProcessor(getActiveLocationSync())
      .then(p => { if (alive) setCardProcessor(p); })
      .catch(() => { /* stays stripe */ });
    (async () => {
      try {
        const locId = getActiveLocationSync();
        if (!locId || !platformSupabase) { if (alive) setTipCfg({}); return; }
        const { data } = await platformSupabase.from('location_reader_settings')
          .select('tipping_enabled, tip_percentages, allow_custom_tip, smart_tip_threshold_minor')
          .eq('location_id', locId).maybeSingle();
        if (alive) setTipCfg(data || {});
      } catch { if (alive) setTipCfg({}); }
    })();
    return () => { alive = false; };
  }, []);
  const giftCredit = giftApplied?.applied ? giftApplied.applied / 100 : 0;
  // Loyalty discount applied to total
  const loyaltyCredit = loyaltyApplied?.discount_value ? loyaltyApplied.discount_value / 100 : 0;
  const promoCredit = promoApplied?.amount ? Number(promoApplied.amount) : 0;   // major units, from promo-redeem
  const grand    = Math.max(0, total + tipAmt - giftCredit - loyaltyCredit - promoCredit);

  // Validate a promo code in real time (no write). On success, hold it; the store redeems it
  // atomically (bound to the order) on payment completion. Called from the unified gift/promo box;
  // returns { ok } or { error } so the box can show the message (it never throws).
  const applyPromoCode = async (rawCode) => {
    const code = (rawCode || '').trim();
    if (!code) return { error: 'Enter a code' };
    if (promoApplied) return { error: 'A promo code is already applied' };
    try {
      const { data, error } = await supabase.functions.invoke('promo-redeem', { body: {
        action: 'validate', code, location_id: getActiveLocationSync(),
        customer_id: customer?.customerId || customer?.id || null, basket: { subtotal: total },
      } });
      if (error) throw new Error(error.message);
      if (data?.valid) {
        setPromoApplied({ code, code_id: data.code_id, offer_id: data.offer?.id, ...data.discount });
        return { ok: true };
      }
      const reasons = { not_found: 'Code not found', expired: 'Code expired', not_yet_active: 'Not active yet', already_used: 'Already used', usage_limit: 'Usage limit reached', min_spend: `Minimum spend £${Number(data?.min_spend || 0).toFixed(2)}`, wrong_venue: 'Not valid at this venue', customer_mismatch: 'Belongs to another customer', customer_required: 'Attach the customer first', inactive: 'Offer inactive', voided: 'Code voided' };
      return { error: reasons[data?.reason] || 'Invalid code' };
    } catch (e) { return { error: e.message || 'Could not check code' }; }
  };

  // Calculate tax breakdown
  const taxBreakdown = useMemo(() => {
    if (!taxRates?.length) return null;
    try { return calculateOrderTax(items?.filter(i=>!i.voided)||[], taxRates, orderType); } catch { return null; }
  }, [items, taxRates, orderType]);
  const hasTax = taxBreakdown?.breakdown?.length > 0;
  const hasExclusive = taxBreakdown?.hasExclusiveTax;

  // v5.5.902: fire the real gift-card debit. Never throws (commitGiftCard swallows
  // everything) and NEVER touches the server in training mode — a training till stages
  // and records the card in memory only, exactly as it did when the apply-time redeem
  // was mocked. Returns the closed_checks.gift_card record: what was ACTUALLY debited
  // plus the ledger row's idempotency key, which store.refundCheck needs verbatim.
  const commitGift = async (staged, { closedCheckId, allowPartial }) => {
    if (!staged) return { record: null, ok: true };
    if (!staged.pending_commit || isTrainingMode()) {
      return { record: giftCardCheckRecord(staged, null), ok: true };
    }
    const token = await ensureAuthToken().catch(() => null);
    const commit = await commitGiftCard(staged, {
      functionsUrl: GIFT_FUNCTIONS_URL,
      token,
      locationId: getActiveLocationSync(),
      channel: 'pos',
      closedCheckId,
      allowPartial,
    });
    if (!commit.ok) console.error('[checkout] gift card commit FAILED:', commit.error);
    else if (commit.shortfall > 0) console.warn('[checkout] gift commit partial — uncollected minor:', commit.shortfall);
    return { record: giftCardCheckRecord(staged, commit), ok: commit.ok, error: commit.error };
  };

  // ── v5.5.903: undo a DISPATCH-TIME debit when the terminal job dies ────────────
  // The PAX path is the one path that debits before there is a check to refund (see
  // startTerminalJob for why it has to). paxGiftRef holds what it debited, so a job that
  // comes back declined / cancelled / expired can put the money back on the card — until
  // now the balance was simply gone, with no check for store.refundCheck to reverse.
  const paxGiftRef = useRef(null);
  // Serialises the reversal: onFailed fires it, and the Back button can fire it again.
  const reversingGiftRef = useRef(false);

  const reverseDispatchedGift = useCallback(async (why) => {
    const record = paxGiftRef.current;
    if (!record?.card_id || !record?.idempotency_key || reversingGiftRef.current) return;
    reversingGiftRef.current = true;
    // Un-stage FIRST, and synchronously. Until the money is provably back on the card,
    // no payment taken in this modal may claim it — a cash tender landing mid-reversal
    // would otherwise record the leg on the check AND hand the balance back.
    applyGift(null);
    try {
      // A training till staged and "debited" in memory only — there is nothing to undo.
      if (isTrainingMode()) { paxGiftRef.current = null; return; }
      const token = await ensureAuthToken().catch(() => null);
      const r = await reverseGiftCard(record, {
        functionsUrl: GIFT_FUNCTIONS_URL,
        token,
        locationId: getActiveLocationSync(),
        reason: why || 'Card machine payment did not complete',
        staffId: useStore.getState().staff?.id || null,
      });
      if (r.ok) {
        paxGiftRef.current = null;
        // RETIRE THE CHECK ID WITH THE REVERSAL. The debit was keyed
        // `giftcommit:<checkId>:<cardId>` server-side, and the redeem row survives its own
        // reversal — so re-applying the SAME card in THIS checkout would derive that same
        // key, come back `already_applied`, debit NOTHING and still discount the bill.
        // A fresh id makes a re-apply a genuinely new redemption. Safe to mint: no check
        // has been recorded under the old id (the job died), and the next dispatch
        // re-keys its own job from it.
        checkIdRef.current = null;
        setGiftError('');
        try { useStore.getState().showToast?.('Gift card balance restored — apply it again if you need to.', 'info'); } catch {}
      } else {
        // The money is still OFF the card. Put the leg back on the bill: whatever staff
        // take next then honours it (and lands it on the check, where a refund can still
        // reverse it) instead of charging the customer for value they have already spent.
        // The record has no `pending_commit`, so commitGift passes it straight through as
        // the already-debited leg it is. paxGiftRef keeps it — Back retries the reversal.
        console.error('[checkout] gift card reversal FAILED:', r.error);
        applyGift(record);
        try { useStore.getState().showToast?.('Could not restore the gift card — it is still applied to this bill.', 'error'); } catch {}
      }
    } finally {
      reversingGiftRef.current = false;
    }
  }, [applyGift]);

  // Guards the window between "commit started" and "modal unmounted" — a second tap on
  // Complete must not fire a second commit (the derived key makes the server idempotent,
  // but the check must not be recorded twice either).
  const completingRef = useRef(false);

  const complete = async (method, tip=tipAmt, tendered=null, stripePaymentIntentId=null, cardReceipt=null, paidProcessor=null, capturedMinor=null) => {
    if (completingRef.current) return;
    completingRef.current = true;

    const staged = giftRef.current;
    const checkId = getCheckId();

    // Was there anything left for cash / the card AFTER the gift card? Computed against
    // the tip we were actually handed (the reader's figure), not the `tipAmt` in state —
    // a gift that cleared the bill but left a reader tip to charge is NOT gift-only.
    const dueAfterGift = Math.max(0, total + tip - ((staged?.applied || 0) / 100) - loyaltyCredit - promoCredit);
    const giftOnly = !!staged && dueAfterGift <= 0.005;

    // ── GIFT CARD DEBITS HERE, at commit — not when staff tapped Apply ──────────
    // Ordered BEFORE onComplete (which writes closed_checks) per INVARIANTS.md
    // "gift card redeem before order close".
    //
    // Gift-covers-everything means NO cash or card leg was taken, so a failed or short
    // debit must ABORT the close: the customer's balance stays intact and staff are sent
    // back to take payment another way. Where money HAS already been taken (cash in the
    // drawer, card captured) the check must still be recorded — a gift failure can't be
    // allowed to lose the sale — so we book what the server actually gave us and the
    // shortfall rides on the record as `uncollected`.
    let giftRecord;
    if (staged) {
      const { record, ok, error } = await commitGift(staged, {
        closedCheckId: checkId,
        allowPartial: !giftOnly,
      });
      if (!ok && giftOnly) {
        applyGift(null);
        setGiftError(error === 'Insufficient balance'
          ? 'That gift card no longer has enough balance — take payment another way.'
          : `Gift card could not be applied: ${error}`);
        setScreen('gift_card');
        completingRef.current = false;
        return;
      }
      giftRecord = record;
    }

    const hasGift = !!staged;
    const hasLoyalty = !!loyaltyApplied;
    let finalMethod = method;
    // Gift + something else only when the gift genuinely left a balance to take.
    if (hasGift && !giftOnly) finalMethod = `gift_card+${method}`;
    else if (hasGift) finalMethod = 'gift_card';
    if (hasLoyalty) finalMethod = `loyalty+${finalMethod}`;
    if (promoApplied) finalMethod = `promo+${finalMethod}`;
    // v5.5.943: cash change goes to the global tap-to-dismiss overlay. `tendered` is
    // only ever non-null on the cash path, and dueAfterGift is the figure the tender
    // screen showed as owed — in pence, same idiom as the tender screen's maths.
    if (tendered != null) {
      useStore.getState().showChangeDue?.(
        Math.max(0, Math.round(tendered * 100) - Math.round(dueAfterGift * 100)) / 100
      );
    }
    onComplete({
      method: finalMethod,
      tip,
      grand: total+tip,
      tendered,
      printReceipt,
      // v5.5.902: the store adopts this as the closed_check id, so it matches the id the
      // gift debit above was keyed to (and the id the PAX job pre-minted).
      closedCheckId: checkId,
      giftCard: giftRecord || undefined,
      loyaltyRedemption: loyaltyApplied || undefined,
      promoRedemption: promoApplied || undefined,
      stripePaymentIntentId,
      // v5.5.808: when the terminal reported what it actually CAPTURED, stamp it
      // on the refundable card leg — the record must match the money taken (the
      // fallback derives the leg amount from the requested grand instead).
      ...(stripePaymentIntentId && Number.isFinite(capturedMinor)
        ? { paymentIntents: [{ id: stripePaymentIntentId, amountMinor: capturedMinor }] }
        : {}),
      // NOTE: piResult/processor are CardTerminal state — NOT in scope here. The processor rides
      // in as a parameter from the card call site (the pi the reader flow hands back).
      processor: paidProcessor || 'stripe',
      cardReceipt,   // card-scheme receipt block (brand/last4/auth code/AID/CVM) — printed at the receipt bottom
    });
  };

  // v5.5.172: tipping is collected ON THE READER for card payments — Stripe
  // Terminal Configuration handles the % / custom / no-tip prompt customer-
  // side. The POS no longer pre-collects a tip. Goes straight from review
  // to card_terminal. The actual tip the customer chose comes back via the
  // payment intent's amount_received and is reflected in `complete()` below.
  // Ryft venues take no tip at all (see handleCardPress) — grand is just the bill.
  // v5.5.829: on Ryft, ask the CUSTOMER for the tip on their own display, then
  // charge bill+tip as one amount. Ryft's terminal API has no tip prompt and takes
  // a single `amounts.requested`, so the tip must be settled BEFORE the charge —
  // hence the wait. Staff can always skip, so a dead display never blocks a sale.
  const askCustomerForTip = () => {
    const nonce = ++tipNonceRef.current;
    setAwaitingTip(true);
    publishTipRequest({ total, cfg: tipCfg || {}, nonce });
    // Don't strand the till if the customer wanders off or the screen is asleep.
    setTimeout(() => {
      setAwaitingTip(prev => {
        if (prev && tipNonceRef.current === nonce) { setTipAmt(0); setScreen('card_terminal'); }
        return false;
      });
    }, 60000);
  };

  // v5.5.837 (PaxPay mode 3): hand the whole payment to the PAX terminal.
  //
  // THE THREE AMOUNTS (spec § "The three amounts"):
  //   tip basis = `total`  — the BILL. The tip is for the SERVICE, not for the
  //               leftover balance. Using `grand` here would show "10% = 50p" on a
  //               £50 meal that was mostly paid by gift card, and rob the staff.
  //   due       = `grand`  — bill minus gift / loyalty / promo credit. What the
  //               card must actually take. Charging the basis would take money the
  //               gift card already paid — the customer pays twice, then charges back.
  //   charge    = server-computed as due + tip, inside terminal_commit_tip. The POS
  //               never sends a charge figure at all.
  const startTerminalJob = async () => {
    setPaxError(''); setPaxBusy(true);
    try {
      const locationId = getActiveLocationSync();
      const session = tableId ? useStore.getState().tables.find(t => t.id === tableId)?.session : null;
      // Mint once per checkout (see checkIdRef). Table checks keep the shared
      // table:session key (two tills on one table MUST collide); counter sales get
      // a per-sale leg so they never share a key with a previous customer.
      const checkId = getCheckId();
      const checkKey = buildCheckKey({
        locationId, tableId, sessionId: session?.id,
        leg: tableId ? undefined : checkId,
      });
      const dueMinor = toMinor(grand);
      if (!(dueMinor > 0)) throw new Error('Nothing left for the card to take.');

      // ── v5.5.902: the gift card commits HERE on the PAX path, not in complete() ──
      // Handing the job to the terminal is this path's real point of no return: the
      // terminal charges `dueMinor` (already net of the gift), and from that moment the
      // check can be closed WITHOUT this modal — TerminalJobReconciler closes an approved
      // job on any till. Leave the debit in complete() and closing the modal mid-payment
      // would give the discount away and never take it off the card.
      //
      // Same checkId as complete() uses, so gift-redeem derives the SAME key: whichever
      // path runs second gets `already_applied` back, never a second debit.
      //
      // A failure ABORTS the dispatch. Nothing has been charged yet, so stopping here is
      // free — whereas sending a job whose due was discounted by a gift card we could not
      // actually debit leaves the venue short by exactly that amount. For the same reason
      // allowPartial is FALSE: `dueMinor` above was already frozen net of the full staged
      // amount, so taking "whatever is left" off a card that lost value would under-charge
      // the terminal by the difference. Refuse, and let staff re-apply against the truth.
      let paxGiftRecord = null;
      if (giftRef.current) {
        const { record, ok, error } = await commitGift(giftRef.current, {
          closedCheckId: checkId,
          allowPartial: false,
        });
        if (!ok) throw new Error(`Gift card could not be applied: ${error}. Remove it and take the full amount.`);
        paxGiftRecord = record;
        // v5.5.903: hold the debited leg for the failure paths (PaxTerminal onFailed /
        // Back). Set BEFORE the dispatch on purpose — the debit is real from this line
        // on, whatever the dispatch does next. It is only ever CONSUMED once a job is
        // proven dead, so a dispatch whose response was merely lost (the job may exist
        // and still be paid) never triggers a reversal.
        paxGiftRef.current = paxGiftRecord;
      }

      const { job } = await dispatchTerminalJob({
        checkKey,
        targetTerminalId: paxTarget.id,
        posDeviceId: getPosDeviceId(),
        tipBasisMinor: toMinor(total),
        dueMinor,
        currency: getActiveCurrencyCode?.() || 'GBP',
        // v5.5.841 — NO tipConfig IS SENT. The bands are the TERMINAL'S, resolved
        // server-side in terminal-job-create from terminal_devices.tip_config —
        // the value Back Office writes, the value the operator can actually see,
        // and the same column Table Pay freezes. Two clients building the same
        // object from two different tables is how they came to disagree.
        //
        // What this modal used to send was
        //   { enabled:true, percentages:null, … }
        // and the terminal's parser reads only percentBands / tip_percentages, so
        // it fell closed to "no bands" and showed the customer no tip prompt at
        // all. The venue read that as "tipping is off".
        //
        // skipTip is still ours to decide — a bar tab, takeaway or collection
        // takes no tip whatever the terminal is configured for — but it travels
        // as a suppression flag, which can only ever make the job LESS tippable.
        suppressTip: skipTip || tipCfg?.tipping_enabled === false,
        closedCheckId: checkId,
        checkDraft: {
          tableId: tableId || null,
          tableLabel: tableId || null,
          sessionId: session?.id || null,
          locationId,
          orderType,
          covers,
          server: session?.server || null,
          staffId: useStore.getState().staff?.id || null,
          items: (items || []).filter(i => !i.voided),
          discounts: session?.discounts || [],
          subtotalMinor: toMinor(subtotal),
          totalMinor: toMinor(total),
          // v5.5.862: the occupation identity. The paid-table guard and the durable
          // reconciler both prove "same party" by seatedAt (session ids recur);
          // without it a table check falls to the conservative headless/time-window
          // paths. Counter sales have no session — stays null.
          seatedAt: session?.seatedAt ?? null,
          // v5.5.902: the gift card debited above, in the closed_checks.gift_card shape —
          // card_id, amount applied and the ledger row's idempotency key. No code, no
          // balance: nothing here is a secret the job row shouldn't hold. This is what
          // lets closeApprovedTerminalJob record (and therefore later REVERSE) a gift card
          // on a check it closed without this modal — it booked giftCard:null before.
          giftCard: paxGiftRecord,
          source: 'pos_send_to_terminal',
        },
      });
      setPaxJob(job);
      setScreen('pax_terminal');
    } catch (e) {
      setPaxError(e?.message || 'Could not send the payment to the card machine.');
    } finally {
      setPaxBusy(false);
    }
  };

  const handleCardPress = () => {
    // TRAINING MODE — first, before anything else. A job row would dispatch a
    // REAL charge to a REAL terminal, and the server-side close path bypasses the
    // client-side commit gates entirely. Training keeps the existing simulated flow.
    if (isTrainingMode()) { setScreen('card_terminal'); return; }

    // PAX: the tip is chosen ON THE TERMINAL, in the customer's hand.
    //
    // LANDMINE (spec ⚠️ 1): displayUsesScreen() below asks "is there a stationary
    // second screen at THIS till?". For a handheld the correct answer is no — and
    // it is also irrelevant. A handheld's customer_display_mode is 'off' or
    // 'reader'; even on 'auto' the tip request would be published to a screen back
    // at the counter while the customer is holding the terminal at their table.
    // Left in place, that gate BLOCKS table service entirely. Deliberately bypassed.
    //
    // paxLookupDone gates the race: a press before the lookup lands must NOT
    // silently take the old path and produce a different tip on the same bill.
    if (paxLookupDone && cardProcessor === 'ryft' && paxTarget) { startTerminalJob(); return; }

    // Tipping is only offered on Ryft when the venue has it switched on AND has a
    // customer-facing screen. Without a screen there is nowhere for the customer to
    // choose (Ryft's reader can't ask), so we go straight to the card.
    const canAskCustomer = cardProcessor === 'ryft' && !skipTip
      && tipCfg?.tipping_enabled !== false && displayUsesScreen();
    if (canAskCustomer) { askCustomerForTip(); return; }
    setScreen('card_terminal');
  };

  // The customer's choice comes back over the display channel. The nonce guards
  // against a late reply from a previous sale landing on this one.
  useEffect(() => {
    if (!awaitingTip) return undefined;
    const off = onCustomerTip((p) => {
      if (!p || p.nonce !== tipNonceRef.current) return;
      setAwaitingTip(false);
      setTipAmt(Math.max(0, Number(p.tip) || 0));
      setScreen('card_terminal');
    });
    return off;
  }, [awaitingTip]);

  const nonVoided = items.filter(i=>!i.voided);

  // Group by course for the bill display
  const COURSE_LABELS = { 0:'Immediate', 1:'Course 1', 2:'Course 2', 3:'Course 3' };
  const courseGroups = nonVoided.reduce((acc, item) => {
    const c = item.course ?? 1;
    if (!acc[c]) acc[c] = [];
    acc[c].push(item);
    return acc;
  }, {});
  const courseNums = Object.keys(courseGroups).map(Number).sort();
  // v5.5.961: honour the device profile's "Course management: Hidden" toggle on the bill too
  const hideCourses = (deviceConfig?.hiddenFeatures || []).includes('courses');
  const showCourses = !hideCourses && courseNums.length > 1;

  const contextLabel = isBarTab ? `Bar tab · ${tabName}`
    : tableId ? `${tableId.replace(/^[tbp]/,'')} · ${orderType}${covers>1?` · ${covers} covers`:''}`
    : orderType;

  const SCREENS = {
    review:'Checkout',
    card_terminal:'Card payment', cash:'Cash payment',
    pax_terminal:'Card machine',
    gift_card:'Gift card', loyalty_rewards:'Loyalty rewards',
  };

  return (
    <div className="modal-back">
      <div style={{
        background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:24,
        width:'100%', maxWidth:compact?380:500, maxHeight:compact?'92vh':'94vh',
        display:'flex', flexDirection:'column',
        boxShadow:'var(--sh3)', overflow:'hidden',
      }}>

        {/* ── Header ── */}
        <div style={{ padding:compact?'10px 14px 8px':'16px 20px 12px', borderBottom:'1px solid var(--bdr)', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <div>
            <div style={{ fontSize:compact?15:18, fontWeight:800, color:'var(--t1)', letterSpacing:'-.01em' }}>{SCREENS[screen]||'Checkout'}</div>
            <div style={{ fontSize:12, color:'var(--t3)', marginTop:2, textTransform:'capitalize' }}>{contextLabel}</div>
          </div>
          <div style={{ display:'flex', gap:6, alignItems:'center' }}>
            {screen==='review' && (
              <button onClick={()=>setNamesOnly(n=>!n)} style={{
                padding:'4px 10px', borderRadius:7,
                border:`1px solid ${namesOnly?'var(--acc-b)':'var(--bdr)'}`,
                background:namesOnly?'var(--acc-d)':'transparent',
                color:namesOnly?'var(--acc)':'var(--t3)',
                fontSize:10, fontWeight:700, cursor:'pointer', fontFamily:'inherit', whiteSpace:'nowrap',
              }}>≡ Names</button>
            )}
            {/* v5.5.181: while a card payment is in flight on the reader,
                HIDE both the Back chevron and the X close button. The only
                way out is the explicit Cancel payment button inside the
                CardTerminal screen — prevents the cashier accidentally
                dismissing the modal while the customer is mid-tap.
                v5.5.905: 'pax_terminal' was MISSING from both guards, so the whole rule
                applied to Stripe readers and not to the PAX. Staff could Back/× out of a
                live PAX prompt, leaving the terminal collecting a card for a check the till
                had already walked away from — the job stays live, the customer can still
                tap, and nothing on the POS is listening for the result. Both screens are
                now treated identically: the in-screen Cancel is the only way out. */}
            {screen!=='review' && screen!=='card_terminal' && screen!=='pax_terminal' && (
              <button className="btn btn-ghost btn-sm" onClick={()=>setScreen('review')}>← Back</button>
            )}
            {screen!=='card_terminal' && screen!=='pax_terminal' && (
              <button onClick={onClose} style={{ width:32, height:32, borderRadius:9, border:'1px solid var(--bdr2)', background:'transparent', color:'var(--t3)', cursor:'pointer', fontFamily:'inherit', fontSize:18, display:'flex', alignItems:'center', justifyContent:'center' }}>×</button>
            )}
          </div>
        </div>

        {/* v5.5.793: on the review screen the body is a flex column — the items region
            scrolls on its own while the totals + payment controls stay pinned in view
            (staff go straight to payment; they must never have to scroll to reach it).
            Every other screen keeps the original whole-body scroll. */}
        <div style={ screen==='review'
          ? { flex:1, minHeight:0, display:'flex', flexDirection:'column', overflow:'hidden', padding:compact?'10px 14px':'18px 20px' }
          : { flex:1, overflowY:'auto', padding:compact?'10px 14px':'18px 20px' } }>

          {/* ══ REVIEW ══════════════════════════════════════════════ */}
          {screen==='review' && (
            <>
              {/* Scrolling region: bill items (+ loyalty banner) */}
              <div style={{ flex:'1 1 auto', minHeight:0, overflowY:'auto' }}>
              {/* Bill items — grouped by course */}
              <div style={{ marginBottom:16, borderRadius:14, border:'1px solid var(--bdr)', overflow:'hidden' }}>
                {courseNums.map(cNum => (
                  <div key={cNum}>
                    {showCourses && (
                      <div style={{ padding:'6px 14px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em' }}>
                        {COURSE_LABELS[cNum] || `Course ${cNum}`}
                      </div>
                    )}
                    {courseGroups[cNum].map((item, idx) => {
                  const disc  = item.discount;
                  const price = disc
                    ? (disc.type==='percent' ? item.price*(1-disc.value/100) : Math.max(0,item.price-disc.value/item.qty))
                    : item.price;
                  const isLast = idx === courseGroups[cNum].length - 1;
                  return (
                    <div key={item.uid} style={{ display:'flex', justifyContent:'space-between', gap:namesOnly?4:compact?8:12, padding:namesOnly?'3px 10px':compact?'7px 10px':'11px 14px', borderBottom:isLast?'none':'1px solid var(--bdr)', background:namesOnly?'transparent':idx%2===0?'var(--bg2)':'var(--bg1)' }}>
                      <div style={{ flex:1, minWidth:0 }}>
                        <div style={{ fontSize:namesOnly?11:compact?12:14, fontWeight:namesOnly?500:600, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          {item.qty>1 && <span style={{ fontWeight:800, color:'var(--acc)', marginRight:5, fontFamily:'var(--font-mono)' }}>{item.qty}×</span>}
                          {item.name}
                        </div>
                        {item.mods?.filter(m=>m.label).map((m,i)=>(
                          <div key={i} style={{ fontSize:11, color:'var(--t3)', marginTop:1 }}>
                            {m.label}
                            {m.price>0&&<span style={{ color:'var(--acc)', marginLeft:6, fontFamily:'var(--font-mono)' }}>+{money(m.price)}</span>}
                          </div>
                        ))}
                        {!namesOnly && item.notes && <div style={{ fontSize:11, color:'var(--orn)', marginTop:2 }}>📝 {item.notes}</div>}
                        {!namesOnly && disc && <div style={{ fontSize:11, color:'var(--grn)', marginTop:2, fontWeight:600 }}>🏷 {disc.label}</div>}
                        {item.allergens?.length>0 && (
                          <div style={{ fontSize:10, color:'var(--red)', marginTop:2, fontWeight:600 }}>
                            ⚠ {item.allergens.map(a=>ALLERGENS.find(x=>x.id===a)?.label).filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </div>
                      <div style={{ textAlign:'right', flexShrink:0 }}>
                        <div style={{ fontSize:namesOnly?11:compact?12:14, fontWeight:namesOnly?500:700, color:namesOnly?'var(--t3)':'var(--t1)', fontFamily:'var(--font-mono)' }}>{money((price*item.qty))}</div>
                        {!namesOnly && disc && <div style={{ fontSize:11, color:'var(--t4)', textDecoration:'line-through', fontFamily:'var(--font-mono)' }}>{money((item.price*item.qty))}</div>}
                      </div>
                    </div>
                  );
                    })}
                  </div>
                ))}
              </div>

              {/* v5.5.218: Loyalty banner. v5.5.895: ALSO shows when the member has redeemable
                  rewards with zero points — a completed STAMP card was invisible here (the panel
                  required credit > 0 and the rewards screen was points-gated), so stamp rewards
                  could never be redeemed at the POS. Same gate bug fixed on the kiosk in v5.5.886. */}
              {loyaltyData && ((pointsEnabled && loyaltyData.credit > 0) || loyaltyData.rewards?.length > 0) && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
                  padding: '10px 14px', borderRadius: 10,
                  background: 'var(--acc-d, #2a1a0a)', border: '1px solid var(--acc-b, #E8743C33)',
                }}>
                  <span style={{ fontSize: 18 }}>{'⭐'}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--acc)' }}>
                      {loyaltyData.memberCode || customer?.name || 'Loyalty member'}
                      {loyaltyData.tier && <span style={{ marginLeft: 8, fontSize: 11, color: loyaltyData.tier.color || 'var(--t3)' }}>({loyaltyData.tier.name})</span>}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>
                      {pointsEnabled && loyaltyData.credit > 0 ? `${loyaltyData.credit} points` : ''}
                      {loyaltyData.rewards?.length > 0 && `${pointsEnabled && loyaltyData.credit > 0 ? ' · ' : ''}${loyaltyData.rewards.length} reward${loyaltyData.rewards.length !== 1 ? 's' : ''} available`}
                    </div>
                  </div>
                  {loyaltyData.rewards?.length > 0 && !loyaltyApplied && (
                    <button
                      onClick={() => setScreen('loyalty_rewards')}
                      style={{
                        padding: '6px 12px', borderRadius: 8, border: '1px solid var(--acc)',
                        background: 'transparent', color: 'var(--acc)', fontSize: 11, fontWeight: 700,
                        cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
                      }}
                    >
                      Redeem
                    </button>
                  )}
                </div>
              )}
              {loyaltyLoading && customer?.phone && (
                <div style={{ fontSize: 11, color: 'var(--t4)', marginBottom: 10, textAlign: 'center' }}>Loading loyalty...</div>
              )}
              </div>

              {/* Pinned region: totals + payment controls — always visible, never scrolls away */}
              <div style={{ flexShrink:0 }}>
              {/* Totals */}
              <div style={{ background:'var(--bg3)', borderRadius:compact?10:14, padding:compact?'10px 12px':'14px 16px', marginBottom:compact?12:20, border:'1px solid var(--bdr)' }}>
                {hasTax && hasExclusive ? (
                  // US exclusive — show net, then tax lines, then total
                  <>
                    <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, color:'var(--t3)', marginBottom:4 }}>
                      <span>Subtotal (ex. tax)</span>
                      <span style={{ fontFamily:'var(--font-mono)' }}>{money(taxBreakdown.subtotal)}</span>
                    </div>
                    {taxBreakdown.breakdown.map(b => {
                      const pct = (b.rate.rate*100).toFixed(3).replace(/\.?0+$/,'');
                      return <div key={b.rate.id} style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--t3)', marginBottom:4 }}>
                        <span>{b.rate.name} ({pct}%)</span>
                        <span style={{ fontFamily:'var(--font-mono)' }}>{money(b.tax)}</span>
                      </div>;
                    })}
                  </>
                ) : (
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, color:'var(--t3)', marginBottom: hasTax ? 2 : 5 }}>
                    <span>Subtotal{hasTax ? ' (incl. VAT)' : ''}</span>
                    <span style={{ fontFamily:'var(--font-mono)' }}>{money(subtotal)}</span>
                  </div>
                )}
                {hasTax && !hasExclusive && taxBreakdown.breakdown.map(b => {
                  const pct = (b.rate.rate*100).toFixed(1).replace('.0','');
                  return <div key={b.rate.id} style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'var(--t4)', marginBottom:4 }}>
                    <span>  of which {b.rate.name} ({pct}%)</span>
                    <span style={{ fontFamily:'var(--font-mono)' }}>{money(b.tax)}</span>
                  </div>;
                })}
                {service > 0 ? (
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, color:'var(--t3)', marginBottom:5 }}>
                    <span>Service charge</span>
                    <span style={{ fontFamily:'var(--font-mono)' }}>{money(service)}</span>
                  </div>
                ) : orderType === 'dine-in' ? (
                  <div style={{ fontSize:12, color:'var(--t4)', marginBottom:5 }}>
                    No service charge
                  </div>
                ) : null}
                {/* v5.5.646: delivery surcharge line (Uber Direct) */}
                {deliveryFee > 0 && (
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, color:'var(--t3)', marginBottom:5 }}>
                    <span>Delivery</span>
                    <span style={{ fontFamily:'var(--font-mono)' }}>{money(deliveryFee)}</span>
                  </div>
                )}
                <div style={{ height:1, background:'var(--bdr)', margin:'8px 0' }}/>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
                  <span style={{ fontSize:15, fontWeight:600, color:'var(--t2)' }}>{(giftApplied || loyaltyApplied || promoApplied) ? 'Subtotal' : 'Total due'}</span>
                  <span style={{ fontSize:(giftApplied || loyaltyApplied || promoApplied)?(compact?16:18):(compact?20:26), fontWeight:800, color:(giftApplied || loyaltyApplied || promoApplied)?'var(--t2)':'var(--acc)', fontFamily:'var(--font-mono)', letterSpacing:'-.02em' }}>{String.fromCodePoint(0x00A3)}{total.toFixed(2)}</span>
                </div>
                {loyaltyApplied && (
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginTop:4 }}>
                    <span style={{ fontSize:13, color:'var(--grn)', fontWeight:600 }}>{'⭐'} {loyaltyApplied.reward_name} ({loyaltyApplied.points_deducted} pts)</span>
                    <span style={{ fontSize:14, fontWeight:700, color:'var(--grn)', fontFamily:'var(--font-mono)' }}>{String.fromCodePoint(0x2212)}{String.fromCodePoint(0x00A3)}{loyaltyCredit.toFixed(2)}</span>
                  </div>
                )}
                {giftApplied && (
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginTop:4 }}>
                    {/* v5.5.902: removable — the card has not been debited yet, so taking it
                        off costs the customer nothing (before, the money had already gone). */}
                    <span style={{ fontSize:13, color:'var(--grn)', fontWeight:600 }}>{String.fromCodePoint(0x1F381)} Gift card (...{giftApplied.code_last4}) <button onClick={()=>{ applyGift(null); setGiftError(''); }} style={{ marginLeft:6, background:'none', border:'none', color:'var(--t3)', cursor:'pointer', fontSize:12, textDecoration:'underline' }}>remove</button></span>
                    <span style={{ fontSize:14, fontWeight:700, color:'var(--grn)', fontFamily:'var(--font-mono)' }}>{String.fromCodePoint(0x2212)}{String.fromCodePoint(0x00A3)}{giftCredit.toFixed(2)}</span>
                  </div>
                )}
                {promoApplied && (
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginTop:4 }}>
                    <span style={{ fontSize:13, color:'var(--grn)', fontWeight:600 }}>{String.fromCodePoint(0x1F3AB)} {promoApplied.label || promoApplied.code} <button onClick={()=>{ setPromoApplied(null); }} style={{ marginLeft:6, background:'none', border:'none', color:'var(--t3)', cursor:'pointer', fontSize:12, textDecoration:'underline' }}>remove</button></span>
                    <span style={{ fontSize:14, fontWeight:700, color:'var(--grn)', fontFamily:'var(--font-mono)' }}>{promoCredit > 0 ? `${String.fromCodePoint(0x2212)}${String.fromCodePoint(0x00A3)}${promoCredit.toFixed(2)}` : '✓'}</span>
                  </div>
                )}
                {(giftApplied || loyaltyApplied || promoApplied) && (
                  <>
                    <div style={{ height:1, background:'var(--bdr)', margin:'6px 0' }}/>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
                      <span style={{ fontSize:15, fontWeight:700, color:'var(--t1)' }}>Remaining due</span>
                      <span style={{ fontSize:compact?20:26, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)', letterSpacing:'-.02em' }}>{String.fromCodePoint(0x00A3)}{grand.toFixed(2)}</span>
                    </div>
                  </>
                )}
              </div>

              {/* Promo codes are entered through the unified gift card / promo box below (v5.5.505). */}

              {/* ── Print receipt checkbox ── */}
              <div
                onClick={()=>setPrintReceipt(v => !v)}
                style={{
                  marginBottom:10, padding:'10px 14px', borderRadius:10, cursor:'pointer',
                  background:'var(--bg3)', border:`1.5px solid ${printReceipt ? 'var(--acc-b)' : 'var(--bdr)'}`,
                  display:'flex', alignItems:'center', gap:10,
                  transition:'border-color .14s, background .14s',
                }}
              >
                <div style={{
                  width:18, height:18, borderRadius:4, flexShrink:0,
                  border:`2px solid ${printReceipt ? 'var(--acc)' : 'var(--bdr2)'}`,
                  background: printReceipt ? 'var(--acc)' : 'transparent',
                  display:'flex', alignItems:'center', justifyContent:'center',
                }}>
                  {printReceipt && <div style={{ fontSize:11, color:'#0e0f14', fontWeight:900, lineHeight:1 }}>✓</div>}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:600, color:'var(--t1)' }}>Print receipt</div>
                  <div style={{ fontSize:11, color:'var(--t3)', marginTop:1 }}>Automatically print a customer receipt when payment completes</div>
                </div>
              </div>

              {/* ── Primary payment buttons ── */}
              {/* v5.5.837: a failed dispatch to the card machine must be LOUD. Silently
                  falling back to another path is how the same bill gets taken twice. */}
              {paxError && (
                <div style={{
                  marginBottom:10, padding:'10px 12px', borderRadius:10, fontSize:12, lineHeight:1.5,
                  background:'var(--red-d)', color:'var(--red)', border:'1px solid var(--red-b)',
                }}>{paxError}</div>
              )}
              {/* v5.5.793: compact tiles (~half height) — icon + label on one row, single subtitle */}
              <div style={{ display:'flex', gap:10, marginBottom:10 }}>
                <button onClick={handleCardPress} disabled={paxBusy} style={{
                  flex:1, padding:compact?'9px 8px':'11px 12px', borderRadius:compact?12:14, cursor:'pointer', fontFamily:'inherit',
                  background:'var(--card-bg)', border:`1.5px solid var(--card-border)`,
                  display:'flex', flexDirection:'column', alignItems:'center', gap:3,
                  transition:'transform .14s, box-shadow .14s',
                }}
                onMouseEnter={e=>{e.currentTarget.style.transform='translateY(-2px)';e.currentTarget.style.boxShadow='var(--sh2)';}}
                onMouseLeave={e=>{e.currentTarget.style.transform='';e.currentTarget.style.boxShadow='';}}>
                  <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                    <span style={{ fontSize:compact?17:20 }}>💳</span>
                    <span style={{ fontSize:compact?13:16, fontWeight:800, color:'var(--card-text)' }}>
                      {paxBusy ? 'Sending…' : 'Card'}
                    </span>
                  </div>
                  {/* v5.5.172: tip prompt is ON THE READER (Stripe). v5.5.808: Ryft terminals have no reader tip prompt — tip is picked on screen first.
                      v5.5.837: with a paired PAX the whole thing (amount, tip, card) happens on the terminal in the customer's hand. */}
                  <div style={{ fontSize:compact?10:11, color:'var(--card-sub)', textAlign:'center' }}>{
                    (paxLookupDone && cardProcessor === 'ryft' && paxTarget)
                      ? `Send to ${paxTarget.label || 'the card machine'} · tip on the terminal`
                      : cardProcessor === 'ryft' ? 'Tap, chip, contactless · tip added on screen'
                      : 'Tap, chip, contactless · tip prompt on reader'
                  }</div>
                </button>

                {_canTakeCash && <button onClick={()=>setScreen('cash')} style={{
                  flex:1, padding:compact?'9px 8px':'11px 12px', borderRadius:compact?12:14, cursor:'pointer', fontFamily:'inherit',
                  background:'var(--cash-bg)', border:`1.5px solid var(--cash-border)`,
                  display:'flex', flexDirection:'column', alignItems:'center', gap:3,
                  transition:'transform .14s, box-shadow .14s',
                }}
                onMouseEnter={e=>{e.currentTarget.style.transform='translateY(-2px)';e.currentTarget.style.boxShadow='var(--sh2)';}}
                onMouseLeave={e=>{e.currentTarget.style.transform='';e.currentTarget.style.boxShadow='';}}>
                  <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                    <span style={{ fontSize:compact?17:20 }}>{String.fromCodePoint(0x1F4B5)}</span>
                    <span style={{ fontSize:compact?13:16, fontWeight:800, color:'var(--cash-text)' }}>Cash</span>
                  </div>
                  <div style={{ fontSize:compact?10:11, color:'var(--cash-sub)', textAlign:'center' }}>Change calculated · no tip prompt</div>
                </button>}
              </div>

              {/* v5.5.793: Gift card (v5.5.505: also accepts promo codes) + Split — side by side to save vertical space */}
              <div style={{ display:'flex', gap:10 }}>
                <button onClick={()=>setScreen('gift_card')} style={{
                  flex:1, minWidth:0, padding:'12px 8px', borderRadius:13, cursor:'pointer', fontFamily:'inherit',
                  background:'var(--bg3)', border:'1.5px solid var(--bdr2)',
                  display:'flex', alignItems:'center', justifyContent:'center', gap:8,
                  color:'var(--t3)', fontSize:13, fontWeight:600, transition:'all .14s',
                }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--acc-b)';e.currentTarget.style.color='var(--acc)';}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--bdr2)';e.currentTarget.style.color='var(--t3)';}}>
                  <span>{String.fromCodePoint(0x1F381)}</span>
                  {giftApplied
                    ? `Gift card ${String.fromCodePoint(0x00A3)}${giftCredit.toFixed(2)} · ${String.fromCodePoint(0x00A3)}${grand.toFixed(2)} due`
                    : 'Gift card or promo code'}
                </button>

                {/* Split — secondary */}
                {/* v5.5.902: SplitModal divides the GROSS `total`, so a check-level gift
                    card has no meaning once you split — the portions already add up to the
                    whole bill. Drop it (nothing has been debited) and say so, rather than
                    leave it staged and silently ignored. Staff apply the card to a portion
                    instead. Before this the staged card was ALREADY debited, so the same
                    sequence charged the customer their gift balance AND the full bill. */}
                <button onClick={()=>{
                  if (giftRef.current) {
                    applyGift(null);
                    try { useStore.getState().showToast?.('Gift card removed — apply it to a split portion instead.', 'info'); } catch {}
                  }
                  setShowSplit(true);
                }} style={{
                  flex:1, minWidth:0, padding:'12px 8px', borderRadius:13, cursor:'pointer', fontFamily:'inherit',
                  background:'var(--bg3)', border:'1.5px solid var(--bdr2)',
                  display:'flex', alignItems:'center', justifyContent:'center', gap:8,
                  color:'var(--t3)', fontSize:13, fontWeight:600, transition:'all .14s',
                }}
                onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--acc-b)';e.currentTarget.style.color='var(--acc)';}}
                onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--bdr2)';e.currentTarget.style.color='var(--t3)';}}>
                  <span>⚖</span>
                  Split check · {covers} {covers===1?'guest':'guests'}
                </button>
              </div>
              </div>
            </>
          )}

          {awaitingTip && (
            <div style={{ textAlign:'center', padding:'40px 20px' }}>
              <div style={{ fontSize:44, marginBottom:14 }}>💬</div>
              <div style={{ fontSize:20, fontWeight:800, color:'var(--t1)' }}>Waiting for the customer</div>
              <div style={{ fontSize:14, color:'var(--t3)', marginTop:8, lineHeight:1.5 }}>
                They're choosing a tip on the customer display.<br/>The card total updates as soon as they pick.
              </div>
              <div style={{ display:'flex', gap:10, justifyContent:'center', marginTop:22 }}>
                <button className="btn" style={{ height:44, padding:'0 18px' }}
                  onClick={()=>{ tipNonceRef.current++; setAwaitingTip(false); setTipAmt(0); setScreen('card_terminal'); }}>
                  Skip tip · take payment
                </button>
                <button className="btn" style={{ height:44, padding:'0 18px' }}
                  onClick={()=>{ tipNonceRef.current++; setAwaitingTip(false); }}>
                  Back
                </button>
              </div>
            </div>
          )}

          {screen==='card_terminal' && (
            <CardTerminal
              items={items}
              grand={grand}
              tipAmt={tipAmt}
              onComplete={(pi)=>{
                // v5.5.172: derive the real reader-collected tip from the
                // captured PaymentIntent. amountReceived = (base + tip).
                // Fall back to 0 if the simulated path (no reader) ran.
                // v5.5.808: Ryft has no on-reader tip prompt — the tip was picked
                // on the POS screen (tipAmt), so record exactly that.
                const receivedMinor = pi?.amountReceived ?? null;
                const receivedGbp   = receivedMinor != null ? receivedMinor / 100 : null;
                // v5.5.837 — LANDMINE (spec ⚠️ 2). Keyed on pi.tipMinor PRESENCE,
                // not on the processor.
                //
                //   * PAX: the tip was chosen on the terminal, so `tipAmt` is 0
                //     here. The old `processor === 'ryft' ? tipAmt` branch threw
                //     the terminal's real figure away — £1.10 left the card and
                //     `tip: 0` was written to the check. Silently. Every time.
                //   * The display-based Ryft REST path (counter + second screen)
                //     still has its tip in tipAmt and keeps working unchanged.
                //   * Stripe: `grand`, not `total`. `grand` IS what we asked the
                //     reader to capture; subtracting the GROSS bill understates
                //     the tip by exactly any gift/loyalty/promo credit and Math.max
                //     clamps it to 0. £50 bill + £45 gift + £5 tip recorded £0 —
                //     a live bug on Stripe, fixed here.
                const realTip =
                    pi?.tipMinor != null     ? Math.max(0, pi.tipMinor / 100)                  // PAX — authoritative
                  : pi?.processor === 'ryft' ? tipAmt                                          // Ryft REST — POS-chosen
                  : receivedGbp != null      ? Math.max(0, +(receivedGbp - grand).toFixed(2))   // Stripe reader — FIXED
                  : 0;
                complete('card', realTip, null, pi?.paymentIntentId || null, pi?.card || null, pi?.processor || 'stripe',
                  Number.isFinite(receivedMinor) ? receivedMinor : null);
              }}
              onBack={()=>{ setTipAmt(0); setScreen('review'); }}
            />
          )}

          {screen==='pax_terminal' && paxJob && (
            <PaxTerminal
              job={paxJob}
              terminalLabel={paxTarget?.label || null}
              onComplete={(pi)=>{
                // Derive BOTH legs from the job's integers — tip_minor and
                // charge_minor — so the recorded tip and the refundable leg are
                // exactly what the card was asked for. Never round twice.
                forgetJob(paxJob.check_key);
                // v5.5.903: the card was APPROVED — the dispatch-time gift debit is paid
                // for and belongs on this check (complete() re-commits it idempotently and
                // books it). Drop the reversal handle so nothing can hand it back.
                paxGiftRef.current = null;
                complete('card', Math.max(0, (pi.tipMinor ?? 0) / 100), null,
                  pi.paymentIntentId || null, pi.card || null, 'ryft',
                  Number.isFinite(pi.amountReceived) ? pi.amountReceived : null);
              }}
              // v5.5.903: declined / cancelled / expired — the server has SETTLED the job
              // and no card was charged. That is the proof the reversal needs: the gift
              // debited at dispatch has no check to live on, so put it back on the card
              // and un-stage it for staff to re-apply against whatever they take instead.
              onFailed={(job)=>{
                forgetJob(paxJob.check_key);
                reverseDispatchedGift(`Card machine payment ${job?.status || 'did not complete'}`);
              }}
              // Only reachable in those same settled states (PaxTerminal renders Back for
              // nothing else), so it is safe to retry here — and worth it: this is the
              // one retry staff get if the reversal above failed on a network blip.
              onBack={()=>{
                reverseDispatchedGift('Card machine payment abandoned');
                setPaxJob(null); setScreen('review');
              }}
            />
          )}

          {screen==='cash' && (
            <CashTransaction
              grand={grand}
              onComplete={(tendered)=>complete('cash', 0, tendered)}
              onBack={()=>setScreen('review')}
            />
          )}

          {screen==='loyalty_rewards' && loyaltyData && (
            <LoyaltyRewardsEntry
              customer={customer}
              loyaltyData={loyaltyData}
              items={items}
              total={total}
              onApplied={(result) => {
                setLoyaltyApplied(result);
                setScreen('review');
              }}
              onBack={() => setScreen('review')}
            />
          )}

          {screen==='gift_card' && (
            <>
              {/* Why the last commit attempt failed (gift-only close aborted). */}
              {giftError && (
                <div style={{ marginBottom:12, padding:12, borderRadius:10, background:'var(--red-d)', color:'var(--red)', fontSize:13, border:'1px solid var(--red-b)' }}>
                  {giftError}
                </div>
              )}
              <GiftCardEntry
                // v5.5.902: the gift card applies against what is ACTUALLY left to pay —
                // net of an applied loyalty reward and promo code. Passing the gross bill
                // let a card be over-drawn by exactly those credits (same over-draw the
                // online half of v5.5.901 fixed). Any card already staged is EXCLUDED:
                // entering another replaces it, so the whole bill is available again.
                totalMinor={Math.round(Math.max(0, total + tipAmt - loyaltyCredit - promoCredit) * 100)}
                giftAlreadyApplied={giftApplied}
                onRemove={() => { applyGift(null); setGiftError(''); }}
                onApplied={(staged) => {
                  applyGift(staged);
                  setGiftError('');
                  const remainingDue = Math.round(Math.max(0, total + tipAmt - loyaltyCredit - promoCredit) * 100) - staged.applied;
                  if (remainingDue <= 0) {
                    // Gift card covers the lot — close now. The debit fires inside complete().
                    complete('gift_card', tipAmt);
                  } else {
                    // Partial: go back to review to pay the remainder.
                    setScreen('review');
                  }
                }}
                onBack={()=>setScreen('review')}
                promoAlreadyApplied={promoApplied}
                onPromoCode={async (code) => { const r = await applyPromoCode(code); if (r?.ok) setScreen('review'); return r; }}
              />
            </>
          )}
        </div>
      </div>

      {showSplit && (
        <SplitModal
          items={items}
          total={total}
          covers={covers}
          canTakeCash={_canTakeCash}
          onComplete={async (portions)=>{
            if (completingRef.current) return;
            completingRef.current = true;
            setShowSplit(false);
            // ── v5.5.902: split gift-card legs debit HERE, at the close ───────────────
            // Each portion only STAGED its card when it was tendered, so abandoning a
            // half-tendered split no longer burns anyone's balance.
            //
            // KEYING: gift-redeem derives its idempotency key from closed_check_id as
            // `giftcommit:<check>:<card>`, so the check id ALONE is wrong here — one card
            // legitimately used on two portions of the same check would collapse onto a
            // single debit. The portion id alone is worse still: they are positional
            // (`p0`, `s3`, `ip0`, `ca0`) and repeat on every split at the venue, so it
            // would collide across DIFFERENT checks and hand the second customer a free
            // meal. The scope that is actually unique is the pair — `<check>:<portion>`.
            const giftLegs = [];
            for (const p of (portions || [])) {
              if (!p?.giftCard) continue;
              const { record } = await commitGift(p.giftCard, {
                closedCheckId: `${getCheckId()}:${p.id}`,
                // The portion is already marked paid and the split has closed, so recover
                // whatever IS left on a card that lost value since it was tendered.
                allowPartial: true,
              });
              if (record) giftLegs.push({ ...record, portion_id: p.id, portion_label: p.label || null });
            }
            // v5.5.323/332: collect every card portion's PaymentIntent so each
            // card leg can be auto-refunded to its own card. The captured amount
            // per leg is base + reader tip, so the refundable amountMinor must
            // include the tip.
            // v5.5.908 — THE SERVER ROW IS THE RECORD, NOT REACT STATE. A split leg's tip
            // lives on terminal_jobs.tip_minor (written by terminal_commit_tip BEFORE the
            // card is touched, and never rewritten). Unlike a whole-bill PAX payment there
            // is NO reconciler behind a split leg (terminalJobs.js:466 excludes
            // 'pos_split_leg'), so if the browser's copy is lost the gratuity exists
            // nowhere on the check — money the customer paid and staff never see. Re-read
            // every card leg's job and take the tip off the row; fall back to the value the
            // leg handed up if we're offline.
            const legJobIds = (portions||[]).map(p => p?.terminalJob?.jobId).filter(Boolean);
            let jobById = new Map();
            if (legJobIds.length) {
              try { jobById = new Map((await fetchJobs(legJobIds)).map(j => [j.id, j])); }
              catch (e) { console.warn('[split] leg job re-read failed, using local tips', e?.message || e); }
            }
            const legTip = (p) => {
              const j = p?.terminalJob?.jobId ? jobById.get(p.terminalJob.jobId) : null;
              if (j?.status === 'approved' && j.tip_minor != null) return Number(j.tip_minor) / 100;
              if (p?.terminalJob?.tipMinor != null) return Number(p.terminalJob.tipMinor) / 100;
              return Number(p?.tip) || 0;
            };
            const paymentIntents = (portions||[])
              .filter(p => p?.method === 'card' && p.paymentIntentId)
              .map(p => ({ id: p.paymentIntentId, amountMinor: Math.round(((p.total||0)+legTip(p))*100) }));
            // v5.5.332: sum the reader-collected tips across portions so the
            // closed check records the real tip (reports + reconciliation),
            // matching the main checkout flow. grand = base bill + total tips.
            const tipTotal = +((portions||[]).reduce((s,p)=>s+legTip(p),0)).toFixed(2);
            // v5.5.808: stamp which processor took the card legs — refunds route
            // by check.processor, so a Ryft split must not default to 'stripe'.
            onComplete({ method:'split', tip:tipTotal, grand:total+tipTotal, portions, paymentIntents, stripePaymentIntentId: paymentIntents[0]?.id || null, processor: cardProcessor || 'stripe', printReceipt,
              closedCheckId: getCheckId(),
              // v5.5.902: split gift legs — the store folds these into the check's
              // gift_card jsonb so a refund can reverse every card that part-paid it.
              // Before this they were recorded NOWHERE and could never be reversed.
              giftCards: giftLegs.length ? giftLegs : undefined });
          }}
          onClose={()=>setShowSplit(false)}
        />
      )}
    </div>
  );
}
