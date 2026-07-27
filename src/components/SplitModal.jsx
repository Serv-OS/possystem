import { useState, useMemo, useRef, useEffect } from 'react';
import { supabase, isMock } from '../lib/supabase';
import { getActiveLocationSync, ensureAuthToken } from '../lib/supabase';
import {
  resolvePlatformLocationId,
  getAssignedNetworkReader,
} from '../lib/networkReader';
import { getLocationProcessorInfo } from '../lib/payments/processor';
import { chargeRyftTerminal } from '../lib/payments/ryftTerminal';
// v5.5.904: split legs dispatch a REAL terminal job, exactly like a full payment.
import { findPaxTerminal, dispatchTerminalJob, buildCheckKey, toMinor, getPosDeviceId,
         pollTerminalJob, cancelTerminalJob } from '../lib/payments/terminalJobs';
import { publishTipRequest, onCustomerTip, displayUsesScreen } from '../lib/customerDisplay';
import { platformSupabase } from '../lib/supabase';
import { money, currencySymbol, stripeCurrency } from '../lib/currency';
import { isTrainingMode } from '../lib/trainingMode';
import { stageGiftCard } from '../lib/giftCommit';

// ─── v5.5.291: Card terminal for split portions ─────────────────────────────
// Sends the portion amount to the card terminal — same flow as CheckoutModal's
// CardTerminal but scoped to a single split portion. v5.5.808: dispatches by
// the venue's processor — Ryft venues drive the PAX via chargeRyftTerminal.
// v5.5.830: Ryft has no on-reader tip prompt, so each split payer is asked for a
// gratuity on the CUSTOMER DISPLAY before their portion is charged — matching
// Stripe splits, which pass skip_tipping:false so the reader asks per portion.
function SplitCardTerminal({ amount, portionLabel, onComplete, onBack }) {
  const [state, setState] = useState('resolving'); // resolving | awaiting_tip | starting | collecting | success | error | cancelling | simulated
  const [statusMsg, setStatusMsg] = useState('Connecting to reader…');
  const [errorMsg, setErrorMsg] = useState(null);
  const [readerLabel, setReaderLabel] = useState('');
  const [attempt, setAttempt] = useState(0);       // v5.5.808: bump to re-run the flow (Retry)
  const pollAbortRef = useRef(false);
  // v5.5.904 — PAX job path. legKey is minted ONCE per mount: SplitModal is given no check
  // or table id, and portion ids ('p0','s3'…) recycle on every split at the venue, so a
  // portion-derived key would collide two different tables' legs and trip the remembered-job
  // ALREADY_PAID guard in terminalJobs.js. A per-mount uuid cannot collide.
  const paxJobRef = useRef(null);
  const legKeyRef = useRef(null);
  if (legKeyRef.current == null) {
    legKeyRef.current = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID() : `leg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
  const piIdRef = useRef(null);
  const readerIdRef = useRef(null);
  const platformLocRef = useRef(null);
  const startedRef = useRef(false);
  const processorRef = useRef('stripe');
  const ryftAbortRef = useRef(null);
  const ryftFlightRef = useRef(null);
  const tipNonceRef = useRef(0);
  const portionTipRef = useRef(0);   // gratuity for THIS portion, chosen on the display
  const tipSkipRef = useRef(null);   // staff override while waiting on the customer

  // Ask this payer for a gratuity on the customer display, then continue.
  // Resolves to the tip (0 if declined, skipped, or nothing is listening).
  const askPortionTip = (opsLocationId) => new Promise((resolve) => {
    if (!displayUsesScreen()) return resolve(0);
    (async () => {
      let cfg = {};
      try {
        if (platformSupabase && opsLocationId) {
          const { data } = await platformSupabase.from('location_reader_settings')
            .select('tipping_enabled, tip_percentages, allow_custom_tip, smart_tip_threshold_minor')
            .eq('location_id', opsLocationId).maybeSingle();
          cfg = data || {};
        }
      } catch { /* fall through with defaults */ }
      if (cfg.tipping_enabled === false) return resolve(0);

      const nonce = ++tipNonceRef.current;
      let settled = false;
      const done = (v) => { if (settled) return; settled = true; off && off(); resolve(v); };
      const off = onCustomerTip((pl) => {
        if (!pl || pl.nonce !== nonce) return;
        done(Math.max(0, Number(pl.tip) || 0));
      });
      setState('awaiting_tip');
      setStatusMsg('Waiting for the customer to choose a tip…');
      publishTipRequest({ total: amount, cfg, nonce });
      setTimeout(() => done(0), 60000);   // never strand the till
      tipSkipRef.current = () => done(0); // staff "Skip tip" button
    })();
  });

  // ─── PAX terminal job branch (v5.5.904) ───────────────────────────────
  // THE FIX: a split card leg now creates a terminal_jobs row, which is the ONLY thing
  // paxpay's JobPoller reads. Before this, splits called chargeRyftTerminal directly (the
  // pre-v5.5.837 REST route), so no job row existed and the terminal never woke — a full
  // payment landed on the PAX and a split leg silently did not.
  //
  // NOTE: no askPortionTip here. The PAX collects the tip itself (bands come from
  // terminal_devices.tip_config), so prompting on the customer display too would ask twice
  // and desync the amount. askPortionTip stays on the legacy fallback below.
  const runPaxJob = async (opsLocationId, terminal) => {
    setState('starting');
    setStatusMsg('Sending to the card terminal…');
    setErrorMsg(null);
    setReaderLabel(terminal.label || 'Card terminal');
    try {
      const dueMinor = toMinor(amount);
      const checkKey = buildCheckKey({ locationId: opsLocationId, tableId: null,
                                       sessionId: null, leg: legKeyRef.current });
      const { job } = await dispatchTerminalJob({
        checkKey,
        targetTerminalId: terminal.id,
        posDeviceId: getPosDeviceId(),
        tipBasisMinor: dueMinor,
        dueMinor,
        currency: stripeCurrency(),
        // 'pos_split_leg' is deliberately NOT 'pax_table_pay': TerminalJobReconciler filters
        // on that source to auto-close a WHOLE check, which must never happen for one leg.
        checkDraft: { source: 'pos_split_leg', portionLabel, totalMinor: dueMinor },
      });
      paxJobRef.current = job?.id || job?.jobId || null;
      setState('collecting');
      setStatusMsg('Ask the customer to present their card');
      const finished = await pollTerminalJob(paxJobRef.current, {
        onUpdate: (j) => {
          if (j.status === 'tipping') setStatusMsg('Customer is choosing a tip…');
          else if (j.status === 'claimed') setStatusMsg('Ask the customer to present their card');
        },
      });
      if (finished?.status === 'approved' && !finished.needs_human) {
        const tipGbp = (finished.tip_minor ?? 0) / 100;
        portionTipRef.current = tipGbp;
        setState('success');
        setStatusMsg('Payment approved');
        setTimeout(() => onComplete('card', finished.payment_session_id || null, tipGbp), 800);
        return;
      }
      setState('error');
      setErrorMsg(finished?.status === 'declined'
        ? (finished.decline_reason ? `Declined — ${finished.decline_reason}` : 'Card declined — try another card')
        : `Terminal did not complete (${finished?.status || 'no response'}) — check the terminal screen.`);
    } catch (e) {
      setState('error');
      setErrorMsg(e?.training ? 'Training mode — no card payment sent' : (e?.message || 'Could not send to the terminal'));
    }
  };

  // ─── Ryft terminal branch (v5.5.808) ──────────────────────────────────
  const runRyftPayment = async (opsLocationId) => {
    // v5.5.830: settle the gratuity FIRST — Ryft takes one amount and cannot
    // add a tip after the fact, so portion+tip must be known before charging.
    const tip = await askPortionTip(opsLocationId);
    portionTipRef.current = tip;
    setState('starting');
    setStatusMsg('Starting terminal payment…');
    setErrorMsg(null);
    setReaderLabel('Ryft terminal');
    const controller = new AbortController();
    ryftAbortRef.current = controller;
    const flight = chargeRyftTerminal({
      locationId: opsLocationId,
      posDeviceId: (() => { try { return JSON.parse(localStorage.getItem('rpos-device') || 'null')?.id || null; } catch { return null; } })(),
      amountMinor: Math.round((amount + portionTipRef.current) * 100),
      currency: stripeCurrency(),
      captureMethod: 'automatic',
      signal: controller.signal,
      onProgress: (st) => {
        if (st === 'present_card') { setState('collecting'); setStatusMsg('Ask the customer to present their card'); }
        else if (st === 'processing') setStatusMsg('Processing on the terminal…');
      },
    });
    ryftFlightRef.current = flight;
    try {
      const result = await flight;
      setState('success');
      setStatusMsg('Payment approved');
      // Tip was chosen by this payer on the customer display before charging.
      setTimeout(() => onComplete('card', result.paymentSessionId, portionTipRef.current), 800);
    } catch (e) {
      if (e?.message === 'cancelled') return;   // staff cancel — handled by cancelReader
      setState('error');
      setErrorMsg(e?.declined ? 'Card declined — try another card' : (e?.message || 'Terminal payment failed'));
    } finally {
      ryftAbortRef.current = null;
      ryftFlightRef.current = null;
    }
  };

  // Resolve processor + reader, then start payment. Re-runs on Retry (attempt).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // TRAINING MODE: never charge a real card for a split portion. Simulate an
        // instant approval so the split flow completes in-memory (the closed_check
        // is separately gated in db.js).
        if (isTrainingMode()) {
          setState('success');
          setStatusMsg('TRAINING — no card charged');
          setTimeout(() => onComplete('card', 'pi_training_split', 0), 600);
          return;
        }
        const opsLocationId = getActiveLocationSync();
        if (!opsLocationId) { setState('error'); setErrorMsg('Location not resolved'); return; }
        // v5.5.808: dispatch by processor. Non-definitive lookups do NOT count
        // as Stripe — see the no-reader guard below.
        let procInfo = { processor: 'stripe', definitive: false };
        try { procInfo = await getLocationProcessorInfo(opsLocationId); } catch { /* stays non-definitive */ }
        if (cancelled) return;
        processorRef.current = procInfo.processor;
        if (procInfo.processor === 'ryft') {
          if (!startedRef.current) {
            startedRef.current = true;
            // v5.5.904: prefer the terminal-job path (same as a full payment). Only fall
            // back to the direct REST charge when this till has no PAX bound to it.
            let target = null, why = null;
            try { const r = await findPaxTerminal({ posDeviceId: getPosDeviceId() }); target = r?.terminal || null; why = r?.reason || null; }
            catch { /* fall through to legacy */ }
            if (cancelled) return;
            if (target) runPaxJob(opsLocationId, target);
            else {
              if (why) console.warn('[split] no PAX terminal —', why);
              runRyftPayment(opsLocationId);
            }
          }
          return;
        }
        const platformId = await resolvePlatformLocationId(opsLocationId);
        if (cancelled) return;
        platformLocRef.current = platformId;
        const assigned = await getAssignedNetworkReader();
        if (cancelled) return;
        if (!assigned) {
          // v5.5.808: the click-to-approve simulator is dev-mock ONLY — it used
          // to close real split portions as PAID with no money taken. Production
          // gets an honest dead-end instead.
          if (isMock) { setState('simulated'); return; }
          setState('error');
          setErrorMsg(procInfo.definitive
            ? 'No card reader is available on this till — check the reader assignment, or take cash / gift card.'
            : 'Card payments unavailable — check this till’s connection and try again.');
          return;
        }
        setReaderLabel(assigned.label || assigned.stripe_reader_id);
        readerIdRef.current = assigned.stripe_reader_id;
        if (!startedRef.current) {
          startedRef.current = true;
          runPayment(assigned, platformId);
        }
      } catch (e) {
        if (!cancelled) { setState('error'); setErrorMsg(e?.message || 'Reader setup failed'); }
      }
    })();
    return () => {
      cancelled = true;
      pollAbortRef.current = true;
      // Best-effort cancel on unmount — Ryft abort fires ryft-terminal-cancel
      // from the helper so the PAX doesn't sit live collecting.
      try { ryftAbortRef.current?.abort(); } catch { /* */ }
      if (piIdRef.current && readerIdRef.current && platformLocRef.current) {
        cancelStripeActionSilent().catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  // Cancel the Stripe reader action WITHOUT touching UI state — used by the
  // unmount cleanup and the interactive cancel button.
  const cancelStripeActionSilent = async () => {
    const token = await ensureAuthToken();
    await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-cancel-reader-action`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ payment_intent_id: piIdRef.current, reader_id: readerIdRef.current, location_id: platformLocRef.current }),
    });
  };

  const runPayment = async (reader, platformId) => {
    setState('starting');
    setStatusMsg('Pushing to reader…');
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
          amount_minor: Math.round(amount * 100),
          currency: stripeCurrency(),
          line_items: [{ description: portionLabel || 'Split portion', amount: Math.round(amount * 100), quantity: 1 }],
          // v5.5.331: DON'T skip the reader tip prompt on split portions. It was
          // hardcoded skip_tipping:true ("handled at table level") but split tips
          // were never actually collected at table level (the split records
          // tip:0), so split card payers were never asked to tip. Omitting the
          // flag makes each portion follow the location's tipping settings —
          // same as the main checkout — so the reader prompts per portion.
          skip_tipping: false,
        }),
      });
      const j = await res.json();
      console.log('[SplitCardTerminal] process-payment response:', j);
      if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);

      piIdRef.current = j.payment_intent_id;
      setState('collecting');
      setStatusMsg('Tap or insert card on reader');
      pollAbortRef.current = false;
      pollPayment(j.payment_intent_id, j.reader_id, platformId);
    } catch (e) {
      setState('error');
      setErrorMsg(e?.message || 'Payment failed');
    }
  };

  const pollPayment = async (piId, readerId, locId) => {
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
        if (!res.ok) { console.warn('[SplitCardTerminal] poll error:', j.error); continue; }
        if (j.reader_action?.status === 'in_progress') setStatusMsg('Customer is paying…');
        if (j.is_terminal_state) {
          if (j.is_success) {
            setState('success');
            setStatusMsg('Payment approved');
            // v5.5.323: carry the PaymentIntent id up so this split portion's
            // card refund can be auto-processed back to the customer's card.
            // v5.5.332: also derive the reader-collected tip (amount_received
            // minus the portion base) so split tips reach the closed check for
            // reports + reconciliation — same as the main checkout flow.
            const receivedMinor = Number.isFinite(j.amount_received) ? j.amount_received : null;
            const tip = receivedMinor != null ? Math.max(0, +((receivedMinor / 100) - amount).toFixed(2)) : 0;
            setTimeout(() => onComplete('card', piIdRef.current, tip), 800);
          } else {
            setState('error');
            setErrorMsg(j.last_payment_error || j.reader_action?.failure_message || 'Payment failed');
          }
          return;
        }
      } catch (e) { console.warn('[SplitCardTerminal] poll failed:', e?.message); }
    }
    if (!pollAbortRef.current) { setState('error'); setErrorMsg('Timed out — 5 minutes'); }
  };

  const cancelReader = async () => {
    pollAbortRef.current = true;
    setState('cancelling');
    // v5.5.808: Ryft branch — abort the in-flight charge and WAIT for the
    // cancel to be confirmed before leaving (same rule as the main checkout:
    // never walk away from a PAX that might still be live collecting).
    // v5.5.904: a dispatched PAX job is cancelled server-side (which voids the live action
    // at the processor); never just walk away from a terminal that may still be collecting.
    if (paxJobRef.current) {
      try {
        const r = await cancelTerminalJob(paxJobRef.current);
        if (r && r.ok === false) {
          setState('error');
          setErrorMsg(r.error === 'already_captured'
            ? 'That card already paid — refund it instead of cancelling.'
            : `Could not cancel on the terminal (${r.error || 'unknown'}) — check the terminal screen.`);
          return;
        }
      } catch (e) {
        setState('error');
        setErrorMsg('Could not confirm the terminal cancel — check the terminal screen before retrying.');
        return;
      }
      paxJobRef.current = null;
      onBack();
      return;
    }
    if (processorRef.current === 'ryft') {
      try { ryftAbortRef.current?.abort(); } catch { /* */ }
      const flight = ryftFlightRef.current;
      if (flight) {
        const outcome = await Promise.race([
          flight.then(() => ({ ok: true, paid: true }))
                .catch(e => ({ ok: e?.message === 'cancelled' && e?.cancelConfirmed !== false, paid: false })),
          new Promise(r => setTimeout(() => r({ ok: false, timeout: true }), 10000)),
        ]);
        if (outcome.paid) { setState('success'); return; }   // tap beat the cancel — runRyftPayment already completed the portion
        if (!outcome.ok) {
          setState('error');
          setErrorMsg('Could not confirm the terminal cancel — check the terminal screen before retrying. Do NOT let the customer tap.');
          return;
        }
      }
      onBack();
      return;
    }
    try {
      await cancelStripeActionSilent();
    } catch (e) { console.warn('[SplitCardTerminal] cancel failed:', e?.message); }
    onBack();
  };

  // ─── Render ─────────────────────────────────────────────────
  if (state === 'simulated') {
    // No reader assigned — simulated approval (dev-mock ONLY, gated above)
    return (
      <div style={{ textAlign: 'center', padding: '16px 0' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 8 }}>No card reader assigned · dev simulator</div>
        <div style={{ fontSize: 32, fontWeight: 800, color: 'var(--t1)', fontFamily: 'DM Mono,monospace', marginBottom: 16 }}>{money(amount)}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button className="btn btn-ghost" style={{ height: 42 }} onClick={onBack}>← Back</button>
          <button className="btn btn-grn" style={{ height: 42, padding: '0 24px' }} onClick={() => onComplete('card', null)}>Simulate approved</button>
        </div>
      </div>
    );
  }

  if (state === 'success') {
    return (
      <div style={{ textAlign: 'center', padding: '20px 0' }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>✅</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--grn)' }}>{money(amount)} paid</div>
        <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 4 }}>{portionLabel}</div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div style={{ textAlign: 'center', padding: '16px 0' }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>⚠️</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--red)', marginBottom: 6 }}>Payment failed</div>
        <div style={{ fontSize: 13, color: 'var(--t2)', marginBottom: 16, maxWidth: 340, margin: '0 auto 16px' }}>{errorMsg}</div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button className="btn btn-ghost" style={{ height: 42 }} onClick={onBack}>← Back</button>
          <button className="btn btn-grn" style={{ height: 42, padding: '0 22px' }}
            onClick={() => { startedRef.current = false; pollAbortRef.current = false; setState('resolving'); setErrorMsg(null); setAttempt(a => a + 1); }}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  // v5.5.830: waiting on this payer's gratuity choice on the customer display.
  if (state === 'awaiting_tip') {
    return (
      <div style={{ textAlign: 'center', padding: '16px 0' }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 8 }}>
          {portionLabel} — Gratuity
        </div>
        <div style={{ fontSize: 40, marginBottom: 8 }}>💬</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--t1)' }}>Waiting for the customer</div>
        <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 6, lineHeight: 1.5 }}>
          They're choosing a tip on the customer display for {money(amount)}.
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 16 }}>
          <button className="btn btn-ghost" style={{ height: 42 }} onClick={onBack}>← Back</button>
          <button className="btn" style={{ height: 42, padding: '0 18px' }}
            onClick={() => { try { tipSkipRef.current && tipSkipRef.current(); } catch { /* noop */ } }}>
            Skip tip · take payment
          </button>
        </div>
      </div>
    );
  }

  // resolving | starting | collecting | cancelling
  return (
    <div style={{ textAlign: 'center', padding: '16px 0' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 8 }}>
        {portionLabel} — Card payment
      </div>
      <div style={{ padding: '16px 14px', borderRadius: 14, background: 'var(--bg3)', border: '1px solid var(--bdr)', marginBottom: 14 }}>
        <div style={{ fontSize: 36, marginBottom: 6 }}>📲</div>
        <div style={{ fontSize: 24, fontWeight: 800, color: 'var(--t1)', marginBottom: 4, fontFamily: 'DM Mono,monospace' }}>
          {money(amount)}
        </div>
        {readerLabel && <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 4 }}>on {readerLabel}</div>}
        <div style={{ fontSize: 13, color: 'var(--t3)' }}>{statusMsg}</div>
      </div>
      <button className="btn btn-ghost" style={{ width: '100%', height: 42 }} disabled={state === 'cancelling'} onClick={cancelReader}>
        {state === 'cancelling' ? 'Cancelling…' : '✕ Cancel payment'}
      </button>
    </div>
  );
}

// ─── Cash tender for a split portion ─────────────────────────────────────────
function SplitCashTender({ amount, onComplete, onBack }) {
  const [entered, setEntered] = useState('');
  const tendered = parseFloat(entered) || 0;
  const change   = Math.max(0, tendered - amount);
  const isValid  = tendered >= amount;

  const press = d => {
    if (d === '⌫') { setEntered(p => p.slice(0, -1)); return; }
    if (d === '.' && entered.includes('.')) return;
    if (entered.includes('.') && entered.split('.')[1]?.length >= 2) return;
    setEntered(p => p + d);
  };

  const quickAmounts = [...new Set([
    ...[5,10,20,50].filter(n => n >= amount),
    Math.ceil(amount),
    Math.ceil(amount / 5) * 5,
  ])].sort((a,b)=>a-b).slice(0,5);

  return (
    <div>
      <div style={{ textAlign:'center', marginBottom:14 }}>
        <div style={{ fontSize:11, color:'var(--t3)', fontWeight:600, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:3 }}>Amount due</div>
        <div style={{ fontSize:34, fontWeight:800, color:'var(--t1)', fontFamily:'DM Mono,monospace' }}>{money(amount)}</div>
      </div>

      <div style={{ height:60, borderRadius:12, marginBottom:12, display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 16px',
        background: isValid?'var(--grn-d)':entered?'var(--red-d)':'var(--bg3)',
        border:`1.5px solid ${isValid?'var(--grn-b)':entered?'var(--red-b)':'var(--bdr)'}`,
      }}>
        <div>
          <div style={{ fontSize:10, fontWeight:700, textTransform:'uppercase', letterSpacing:'.06em', color:isValid?'var(--grn)':entered?'var(--red)':'var(--t3)' }}>
            {isValid?'Change due':entered?'Short by':'Cash tendered'}
          </div>
          {entered&&<div style={{ fontSize:10, color:'var(--t4)', marginTop:1 }}>{money(tendered)} tendered</div>}
        </div>
        <div style={{ fontSize:26, fontWeight:800, fontFamily:'DM Mono,monospace', color:isValid?'var(--grn)':entered?'var(--red)':'var(--t4)' }}>
          {isValid?`${money(change)}`:entered?`${money((amount-tendered))}`:'—'}
        </div>
      </div>

      <div style={{ display:'flex', gap:5, marginBottom:10, flexWrap:'wrap' }}>
        {quickAmounts.map(a=>(
          <button key={a} onClick={()=>setEntered(String(a))} style={{ flex:1, minWidth:44, padding:'6px 4px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:entered===String(a)?'var(--acc-d)':'var(--bg3)', border:`1px solid ${entered===String(a)?'var(--acc)':'var(--bdr2)'}`, color:entered===String(a)?'var(--acc)':'var(--t2)', fontSize:11, fontWeight:700 }}>{currencySymbol()}{a}</button>
        ))}
        <button onClick={()=>setEntered(amount.toFixed(2))} style={{ flex:1, minWidth:44, padding:'6px 4px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:entered===amount.toFixed(2)?'var(--acc-d)':'var(--bg3)', border:`1px solid ${entered===amount.toFixed(2)?'var(--acc)':'var(--bdr2)'}`, color:entered===amount.toFixed(2)?'var(--acc)':'var(--t2)', fontSize:11, fontWeight:700 }}>Exact</button>
      </div>

      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:5, marginBottom:12 }}>
        {[7,8,9,4,5,6,1,2,3,'.',0,'⌫'].map((d,i)=>(
          <button key={i} onClick={()=>press(String(d))} style={{ height:46, borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:d==='⌫'?'var(--red-d)':'var(--bg3)', border:`1px solid ${d==='⌫'?'var(--red-b)':'var(--bdr2)'}`, color:d==='⌫'?'var(--red)':'var(--t1)', fontSize:d==='⌫'?16:18, fontWeight:700 }}>{d}</button>
        ))}
      </div>

      <div style={{ display:'flex', gap:8 }}>
        <button className="btn btn-ghost" style={{ flex:1 }} onClick={onBack}>← Back</button>
        <button className="btn btn-grn" style={{ flex:2, height:42 }} disabled={!isValid} onClick={()=>onComplete(tendered, change)}>
          {isValid?`Paid · change ${money(change)}`:'Enter amount'}
        </button>
      </div>
    </div>
  );
}

// ─── Gift card tender for a split portion (v5.5.199) ─────────────────────────
const GIFT_FN_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

function SplitGiftCardTender({ amount, onComplete, onBack }) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [cardInfo, setCardInfo] = useState(null);
  const codeRef = useRef(null);

  useEffect(() => { codeRef.current?.focus(); }, []);

  const handleLookup = async () => {
    const cleaned = code.replace(/[\s-]/g, '');
    if (cleaned.length < 16) { setError('Enter the full 16 character code'); return; }
    setError(null); setLoading(true); setCardInfo(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('Not authenticated');
      const res = await fetch(`${GIFT_FN_URL}/gift-lookup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ code: cleaned, location_id: getActiveLocationSync() }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
      if (j.status !== 'active') throw new Error(`Card is ${j.status}`);
      if (j.balance <= 0) throw new Error('Card has zero balance');
      setCardInfo(j);
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  // v5.5.902: STAGE only — nothing is debited here. This used to call gift-redeem the
  // moment staff tendered the portion, with `order_id: portionId` (a positional `p0` /
  // `s3` shared by every split at the venue). Back out of a half-tendered split and the
  // customer's balance was gone with no check to show for it. The real debit now fires
  // when the whole split closes, keyed to `<check>:<portion>` — see CheckoutModal's
  // SplitModal onComplete.
  const handleApply = () => {
    if (!cardInfo) return;
    setError(null);
    const staged = stageGiftCard({
      cardId: cardInfo.card_id,
      code: code.replace(/[\s-]/g, ''),
      codeLast4: cardInfo.code_last4,
      balanceMinor: cardInfo.balance,
      amountDueMinor: Math.round(amount * 100),
    });
    if (staged.applied <= 0) { setError('Nothing to redeem'); return; }
    // tendered=0, change=0 — unchanged: a gift card takes no cash and gives no change.
    // NOTE (pre-existing, untouched): a card that only PART-covers the portion still
    // marks it paid, so the remainder is never collected. Staging doesn't introduce
    // that — it is the v5.5.199 behaviour — but it is now visible on the check as
    // `uncollected` rather than silently lost.
    onComplete(0, 0, staged);
  };

  const amountMinor = Math.round(amount * 100);
  const canCover = cardInfo ? Math.min(cardInfo.balance, amountMinor) : 0;

  return (
    <div>
      <div style={{ textAlign:'center', marginBottom:14 }}>
        <div style={{ fontSize:11, color:'var(--t3)', fontWeight:600, textTransform:'uppercase', letterSpacing:'.06em', marginBottom:3 }}>Amount due</div>
        <div style={{ fontSize:34, fontWeight:800, color:'var(--t1)', fontFamily:'DM Mono,monospace' }}>{money(amount)}</div>
      </div>

      {!cardInfo ? (
        <>
          <div style={{ marginBottom:10 }}>
            <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', marginBottom:4, textTransform:'uppercase', letterSpacing:'.06em' }}>Gift card code</div>
            <input
              ref={codeRef}
              type="text"
              value={code}
              onChange={e => setCode(e.target.value.toUpperCase())}
              placeholder="XXXX XXXX XXXX XXXX"
              maxLength={23}
              onKeyDown={e => e.key === 'Enter' && handleLookup()}
              style={{ width:'100%', padding:'10px 12px', borderRadius:10, border:'1px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t1)', fontSize:16, fontFamily:'DM Mono,monospace', letterSpacing:'0.12em', textAlign:'center', outline:'none', boxSizing:'border-box' }}
            />
          </div>
          {error && <div style={{ padding:8, background:'var(--red-d)', borderRadius:8, border:'1px solid var(--red-b)', color:'var(--red)', fontSize:12, marginBottom:10 }}>{error}</div>}
          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn-ghost" style={{ flex:1 }} onClick={onBack}>← Back</button>
            <button className="btn btn-acc" style={{ flex:2, height:42 }} disabled={loading || code.replace(/[\s-]/g, '').length < 16} onClick={handleLookup}>
              {loading ? 'Checking...' : 'Look up card'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ background:'var(--grn-d)', borderRadius:10, border:'1px solid var(--grn-b)', padding:'12px 14px', marginBottom:12 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:4 }}>
              <span style={{ fontSize:12, fontWeight:700, color:'var(--grn)' }}>Card found — ...{cardInfo.code_last4}</span>
              <span style={{ fontSize:14, fontWeight:800, color:'var(--grn)', fontFamily:'DM Mono,monospace' }}>{money((cardInfo.balance / 100))}</span>
            </div>
            <div style={{ fontSize:11, color:'var(--grn)' }}>
              Will apply {money((canCover / 100))} to this portion
              {canCover < amountMinor && ` (${money(((amountMinor - canCover) / 100))} remaining — pay by other method)`}
            </div>
          </div>
          {error && <div style={{ padding:8, background:'var(--red-d)', borderRadius:8, border:'1px solid var(--red-b)', color:'var(--red)', fontSize:12, marginBottom:10 }}>{error}</div>}
          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn-ghost" style={{ flex:1 }} onClick={() => { setCardInfo(null); setCode(''); setError(null); }}>← Different card</button>
            <button className="btn btn-grn" style={{ flex:2, height:42 }} disabled={loading} onClick={handleApply}>
              {`Apply ${money((canCover / 100))} from gift card`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Portion tender screen ────────────────────────────────────────────────────
function PortionTender({ portion, portionNum, total, canTakeCash = true, onComplete, onBack }) {
  const [screen, setScreen] = useState('method'); // method | cash | gift_card | card

  return (
    <div>
      {screen === 'method' && (
        <>
          <div style={{ textAlign:'center', marginBottom:20 }}>
            <div style={{ fontSize:12, color:'var(--t3)', marginBottom:4 }}>Portion {portionNum} — {portion.label}</div>
            <div style={{ fontSize:36, fontWeight:800, color:'var(--acc)', fontFamily:'DM Mono,monospace' }}>{money(portion.total)}</div>
          </div>
          <div style={{ display:'flex', gap:10, marginBottom:10 }}>
            <button onClick={()=>setScreen('card')} style={{ flex:1, padding:'18px 12px', borderRadius:14, cursor:'pointer', fontFamily:'inherit', background:'linear-gradient(135deg,#1a2744,#0f1a35)', border:'1px solid rgba(100,140,255,.3)', display:'flex', flexDirection:'column', alignItems:'center', gap:6 }}>
              <span style={{ fontSize:28 }}>💳</span>
              <span style={{ fontSize:14, fontWeight:800, color:'#e8f0ff' }}>Card</span>
              <span style={{ fontSize:10, color:'rgba(200,210,255,.5)' }}>Tap or chip</span>
            </button>
            {/* v5.5.180: only show Cash when this POS has a bound drawer */}
            {canTakeCash && (
              <button onClick={()=>setScreen('cash')} style={{ flex:1, padding:'18px 12px', borderRadius:14, cursor:'pointer', fontFamily:'inherit', background:'linear-gradient(135deg,#162a1a,#0d1f10)', border:'1px solid rgba(60,180,80,.3)', display:'flex', flexDirection:'column', alignItems:'center', gap:6 }}>
                <span style={{ fontSize:28 }}>💵</span>
                <span style={{ fontSize:14, fontWeight:800, color:'#d4f0d8' }}>Cash</span>
                <span style={{ fontSize:10, color:'rgba(160,210,170,.5)' }}>With change</span>
              </button>
            )}
            {/* v5.5.199: Gift card payment for split checks */}
            <button onClick={()=>setScreen('gift_card')} style={{ flex:1, padding:'18px 12px', borderRadius:14, cursor:'pointer', fontFamily:'inherit', background:'linear-gradient(135deg,#2a1a2e,#1a0f24)', border:'1px solid rgba(180,100,255,.3)', display:'flex', flexDirection:'column', alignItems:'center', gap:6 }}>
              <span style={{ fontSize:28 }}>🎁</span>
              <span style={{ fontSize:14, fontWeight:800, color:'#f0e8ff' }}>Gift Card</span>
              <span style={{ fontSize:10, color:'rgba(210,180,255,.5)' }}>Enter code</span>
            </button>
          </div>
          <button className="btn btn-ghost btn-full" onClick={onBack}>← Back to split</button>
        </>
      )}
      {screen === 'cash' && (
        <SplitCashTender
          amount={portion.total}
          onComplete={(tendered, change) => onComplete('cash', tendered, change)}
          onBack={() => setScreen('method')}
        />
      )}
      {screen === 'gift_card' && (
        <SplitGiftCardTender
          amount={portion.total}
          // v5.5.902: `staged` rides up to the portion; the debit fires at close.
          onComplete={(tendered, change, staged) => onComplete('gift_card', tendered, change, null, 0, staged)}
          onBack={() => setScreen('method')}
        />
      )}
      {screen === 'card' && (
        <SplitCardTerminal
          amount={portion.total}
          portionLabel={`Portion ${portionNum} — ${portion.label}`}
          onComplete={(method, piId, tip) => onComplete(method, null, null, piId, tip)}
          onBack={() => setScreen('method')}
        />
      )}
    </div>
  );
}

// ─── Main Split Modal ─────────────────────────────────────────────────────────
export default function SplitModal({ items, total, covers, canTakeCash = true, onComplete, onClose }) {
  const [mode, setMode]         = useState(null);     // null|even|seat|item|amount
  const [portions, setPortions] = useState([]);       // built split portions
  const [numWays, setNumWays]   = useState(Math.max(2, covers));
  const [tenderingIdx, setTenderingIdx] = useState(null); // which portion we're tendering

  const nonVoided = items.filter(i => !i.voided);
  const seats = [...new Set(nonVoided.map(i => i.seat).filter(Boolean))].sort();
  const hasSeatData = seats.length > 1 || (seats.length === 1 && seats[0] !== 'shared');

  // ─ Build portions from mode ─────────────────────────────────────────────────
  const buildEven = (n) => {
    const each = total / n;
    return Array.from({ length: n }, (_, i) => ({
      id: `p${i}`, label: `Guest ${i+1}`, total: each,
      items: nonVoided.map(item => ({ ...item, portionQty: item.qty / n })),
      paid: false, method: null,
    }));
  };

  const buildBySeat = () => {
    const seatMap = {};
    nonVoided.forEach(item => {
      const s = item.seat || 'shared';
      if (!seatMap[s]) seatMap[s] = [];
      seatMap[s].push(item);
    });

    // Distribute shared items evenly across seats
    const realSeats = Object.keys(seatMap).filter(s => s !== 'shared');
    if (realSeats.length === 0) return buildEven(numWays);

    const sharedItems = seatMap['shared'] || [];
    const portions = realSeats.map(seat => {
      const seatItems = seatMap[seat] || [];
      const sharedPortions = sharedItems.map(i => ({ ...i, qty: i.qty / realSeats.length, portionQty: i.qty / realSeats.length }));
      const allItems = [...seatItems, ...sharedPortions];
      const seatTotal = allItems.reduce((s, i) => s + i.price * (i.portionQty || i.qty), 0);
      return { id: `s${seat}`, label: seat === 'shared' ? 'Table' : `Seat ${seat}`, total: seatTotal, items: allItems, paid: false, method: null };
    });
    return portions;
  };

  const [itemPortions, setItemPortions] = useState(null);
  const [dragTarget, setDragTarget] = useState(null);
  const [numItemPortions, setNumItemPortions] = useState(2);

  const buildItemMode = (n) => {
    const ps = Array.from({ length: n }, (_, i) => ({
      id: `ip${i}`, label: `Check ${i+1}`, items: [], total: 0, paid: false, method: null,
    }));
    // Unassigned pool starts with all items
    return ps;
  };

  const [unassigned, setUnassigned] = useState([]);
  const [itemPortionList, setItemPortionList] = useState([]);
  const [customAmounts, setCustomAmounts] = useState([]);

  const initItemSplit = (n) => {
    setNumItemPortions(n);
    setItemPortionList(Array.from({ length: n }, (_, i) => ({ id: `ip${i}`, label: `Check ${i+1}`, items: [], total: 0, paid: false, method: null })));
    setUnassigned([...nonVoided]);
  };

  const moveItemToCheck = (item, fromPool, targetCheckIdx) => {
    if (fromPool) {
      setUnassigned(u => u.filter(i => i.uid !== item.uid));
    } else {
      setItemPortionList(p => p.map((check, ci) => {
        if (check.items.some(i => i.uid === item.uid)) {
          const items = check.items.filter(i => i.uid !== item.uid);
          return { ...check, items, total: items.reduce((s,i)=>s+i.price*i.qty,0) };
        }
        return check;
      }));
    }
    setItemPortionList(p => p.map((check, ci) => {
      if (ci !== targetCheckIdx) return check;
      const items = [...check.items, item];
      return { ...check, items, total: items.reduce((s,i)=>s+i.price*i.qty,0) };
    }));
  };

  const moveItemToPool = (item) => {
    setItemPortionList(p => p.map(check => {
      if (!check.items.some(i => i.uid === item.uid)) return check;
      const items = check.items.filter(i => i.uid !== item.uid);
      return { ...check, items, total: items.reduce((s,i)=>s+i.price*i.qty,0) };
    }));
    setUnassigned(u => [...u, item]);
  };

  // ─ Confirm split and go to tender ──────────────────────────────────────────
  const confirmSplit = () => {
    let ps;
    if (mode === 'even')   ps = buildEven(numWays);
    else if (mode === 'seat') ps = buildBySeat();
    else if (mode === 'item') {
      ps = itemPortionList.filter(p => p.items.length > 0).map(p => ({ ...p, total: p.items.reduce((s,i)=>s+i.price*i.qty,0) }));
      if (unassigned.length > 0) {
        // Put unassigned into last check
        const last = ps[ps.length-1] || { id:'extra', label:`Check ${ps.length+1}`, items:[], total:0, paid:false, method:null };
        const items = [...last.items, ...unassigned];
        ps = [...ps.slice(0,-1), { ...last, items, total: items.reduce((s,i)=>s+i.price*i.qty,0) }];
      }
    } else if (mode === 'amount') {
      ps = customAmounts.map((a,i) => ({ id:`ca${i}`, label:`Guest ${i+1}`, total: parseFloat(a)||0, items:[], paid:false, method:null }));
    }
    setPortions(ps);
    setMode('tender');
  };

  // ─ Handle tender completion ─────────────────────────────────────────────────
  // v5.5.323: capture the card PaymentIntent id (if this portion was paid by
  // card) so the closed check can auto-refund each card leg to its own card.
  // v5.5.902: `giftCard` is the STAGED card for a gift-tendered portion (nothing debited
  // yet). CheckoutModal commits every staged leg when the split closes.
  const handlePortionPaid = (idx, method, tendered, change, paymentIntentId = null, tip = 0, giftCard = null) => {
    setPortions(p => p.map((portion, i) => i===idx ? { ...portion, paid:true, method, tendered, change, paymentIntentId: paymentIntentId || null, tip: tip || 0, giftCard: giftCard || null } : portion));
    setTenderingIdx(null);
  };

  const allPaid = portions.length > 0 && portions.every(p => p.paid);
  const paidCount = portions.filter(p => p.paid).length;
  const paidAmount = portions.filter(p => p.paid).reduce((s,p) => s+p.total, 0);
  const remaining = total - paidAmount;

  // v5.5.902: fire ONCE. This runs during render, so every re-render between the last
  // portion being paid and the 500ms handoff used to queue another onComplete — each one
  // recording the check again. Now that the close also commits the staged gift-card legs,
  // a repeat is money, not just a duplicate row.
  const completedRef = useRef(false);
  if (allPaid && !completedRef.current) {
    completedRef.current = true;
    setTimeout(() => onComplete(portions), 500);
  }

  // ─ Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="modal-back" onClick={e => e.target===e.currentTarget && onClose()}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--bdr2)', borderRadius:24, width:'100%', maxWidth:560, maxHeight:'94vh', display:'flex', flexDirection:'column', boxShadow:'var(--sh3)', overflow:'hidden' }}>

        {/* Header */}
        <div style={{ padding:'16px 22px 12px', borderBottom:'1px solid var(--bdr)', display:'flex', alignItems:'center', justifyContent:'space-between', flexShrink:0 }}>
          <div>
            <div style={{ fontSize:17, fontWeight:700, color:'var(--t1)' }}>Split check</div>
            <div style={{ fontSize:12, color:'var(--t3)', marginTop:2 }}>
              {mode==='tender' ? `${paidCount} of ${portions.length} paid · ${money(remaining)} remaining`
               : `Total ${money(total)}`}
            </div>
          </div>
          <div style={{ display:'flex', gap:6 }}>
            {mode && mode!=='tender' && <button className="btn btn-ghost btn-sm" onClick={()=>setMode(null)}>← Back</button>}
            {mode==='tender' && paidCount===0 && <button className="btn btn-ghost btn-sm" onClick={()=>setMode(null)}>← Redo split</button>}
            <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          </div>
        </div>

        {/* Progress bar when tendering */}
        {mode==='tender' && (
          <div style={{ height:4, background:'var(--bg3)', flexShrink:0 }}>
            <div style={{ height:'100%', background:'var(--grn)', width:`${(paidCount/portions.length)*100}%`, transition:'width .3s ease' }}/>
          </div>
        )}

        <div style={{ flex:1, overflowY:'auto', padding:'18px 22px' }}>

          {/* ══ MODE PICKER ══════════════════════════════════════════ */}
          {!mode && (
            <>
              <div style={{ fontSize:13, color:'var(--t3)', marginBottom:16 }}>How would you like to split {money(total)}?</div>
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>

                {/* Even split */}
                <button onClick={()=>setMode('even')} style={{ padding:'16px 18px', borderRadius:14, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr)', display:'flex', alignItems:'center', gap:14, textAlign:'left' }}>
                  <span style={{ fontSize:28 }}>⚖</span>
                  <div>
                    <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>Split evenly</div>
                    <div style={{ fontSize:12, color:'var(--t3)', marginTop:2 }}>Divide the total equally between guests</div>
                  </div>
                </button>

                {/* By seat */}
                <button onClick={()=>setMode('seat')} disabled={!hasSeatData} style={{ padding:'16px 18px', borderRadius:14, cursor:hasSeatData?'pointer':'not-allowed', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr)', display:'flex', alignItems:'center', gap:14, textAlign:'left', opacity:hasSeatData?1:.4 }}>
                  <span style={{ fontSize:28 }}>🪑</span>
                  <div>
                    <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>By seat</div>
                    <div style={{ fontSize:12, color:'var(--t3)', marginTop:2 }}>
                      {hasSeatData ? `Auto-split based on ${seats.length} seat assignments` : 'No seat data — assign items to seats first'}
                    </div>
                  </div>
                </button>

                {/* By item */}
                <button onClick={()=>{ setMode('item'); initItemSplit(2); }} style={{ padding:'16px 18px', borderRadius:14, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr)', display:'flex', alignItems:'center', gap:14, textAlign:'left' }}>
                  <span style={{ fontSize:28 }}>🍽</span>
                  <div>
                    <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>By item</div>
                    <div style={{ fontSize:12, color:'var(--t3)', marginTop:2 }}>Drag and drop items onto separate checks</div>
                  </div>
                </button>

                {/* Custom amount */}
                <button onClick={()=>{ setMode('amount'); setCustomAmounts(Array(2).fill('')); }} style={{ padding:'16px 18px', borderRadius:14, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr)', display:'flex', alignItems:'center', gap:14, textAlign:'left' }}>
                  <span style={{ fontSize:28 }}>£</span>
                  <div>
                    <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>Custom amounts</div>
                    <div style={{ fontSize:12, color:'var(--t3)', marginTop:2 }}>Each guest enters how much they're paying</div>
                  </div>
                </button>
              </div>
            </>
          )}

          {/* ══ EVEN SPLIT ══════════════════════════════════════════ */}
          {mode==='even' && (
            <>
              <div style={{ fontSize:13, color:'var(--t3)', marginBottom:14 }}>Split {money(total)} between:</div>
              <div style={{ display:'flex', gap:6, marginBottom:20, flexWrap:'wrap' }}>
                {[2,3,4,5,6,7,8,9,10].map(n=>(
                  <button key={n} onClick={()=>setNumWays(n)} style={{ width:52, height:52, borderRadius:10, cursor:'pointer', textAlign:'center', fontFamily:'inherit', border:`1.5px solid ${numWays===n?'var(--acc)':'var(--bdr)'}`, background:numWays===n?'var(--acc-d)':'var(--bg3)', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center' }}>
                    <div style={{ fontSize:18, fontWeight:800, color:numWays===n?'var(--acc)':'var(--t1)' }}>{n}</div>
                  </button>
                ))}
              </div>
              <div style={{ background:'var(--bg3)', borderRadius:14, padding:'14px 18px', marginBottom:20 }}>
                <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, color:'var(--t3)', marginBottom:4 }}><span>Total</span><span style={{ fontFamily:'DM Mono,monospace' }}>{money(total)}</span></div>
                <div style={{ display:'flex', justifyContent:'space-between' }}>
                  <span style={{ fontSize:14, fontWeight:500 }}>Each guest pays</span>
                  <span style={{ fontSize:28, fontWeight:800, color:'var(--acc)', fontFamily:'DM Mono,monospace' }}>{money((total/numWays))}</span>
                </div>
              </div>
              <button className="btn btn-acc btn-full" style={{ height:46 }} onClick={confirmSplit}>Split into {numWays} checks →</button>
            </>
          )}

          {/* ══ BY SEAT ═════════════════════════════════════════════ */}
          {mode==='seat' && (
            <>
              <div style={{ fontSize:13, color:'var(--t3)', marginBottom:14 }}>Items will be split based on seat assignments. Shared items are divided evenly.</div>
              {(() => {
                const preview = buildBySeat();
                return (
                  <>
                    {preview.map((p,i) => (
                      <div key={i} style={{ background:'var(--bg3)', borderRadius:12, padding:'12px 14px', marginBottom:8, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                        <div>
                          <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>{p.label}</div>
                          <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>
                            {p.items.map(item => `${item.portionQty||item.qty}× ${item.name.split(' ')[0]}`).slice(0,3).join(', ')}
                            {p.items.length>3?` +${p.items.length-3} more`:''}
                          </div>
                        </div>
                        <span style={{ fontSize:18, fontWeight:800, color:'var(--acc)', fontFamily:'DM Mono,monospace' }}>{money(p.total)}</span>
                      </div>
                    ))}
                    <button className="btn btn-acc btn-full" style={{ height:46, marginTop:10 }} onClick={confirmSplit}>Confirm split →</button>
                  </>
                );
              })()}
            </>
          )}

          {/* ══ BY ITEM ═════════════════════════════════════════════ */}
          {mode==='item' && (
            <>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
                <div style={{ fontSize:13, color:'var(--t3)' }}>Tap items to move them between checks</div>
                <div style={{ display:'flex', gap:4 }}>
                  {[2,3,4].map(n=>(
                    <button key={n} onClick={()=>initItemSplit(n)} style={{ padding:'4px 10px', borderRadius:6, cursor:'pointer', fontFamily:'inherit', background:numItemPortions===n?'var(--acc-d)':'var(--bg3)', border:`1px solid ${numItemPortions===n?'var(--acc-b)':'var(--bdr)'}`, color:numItemPortions===n?'var(--acc)':'var(--t3)', fontSize:11, fontWeight:600 }}>{n} checks</button>
                  ))}
                </div>
              </div>

              {/* Unassigned pool */}
              {unassigned.length > 0 && (
                <div style={{ background:'rgba(232,160,32,.06)', border:'1px solid var(--acc-b)', borderRadius:12, padding:'10px 12px', marginBottom:12 }}>
                  <div style={{ fontSize:10, fontWeight:700, color:'var(--acc)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:8 }}>Unassigned items — tap to move</div>
                  {unassigned.map(item => (
                    <div key={item.uid} style={{ display:'flex', gap:6, marginBottom:6 }}>
                      <div style={{ flex:1, fontSize:12, color:'var(--t2)', padding:'6px 8px', background:'var(--bg3)', borderRadius:6 }}>
                        {item.qty>1?`${item.qty}× `:''}{item.name}
                        <span style={{ color:'var(--t3)', marginLeft:8, fontFamily:'DM Mono,monospace' }}>{money((item.price*item.qty))}</span>
                      </div>
                      {itemPortionList.map((check,ci) => (
                        <button key={ci} onClick={()=>moveItemToCheck(item, true, ci)} style={{ padding:'4px 10px', borderRadius:6, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t3)', fontSize:11, fontWeight:600 }}>{ci+1}</button>
                      ))}
                    </div>
                  ))}
                </div>
              )}

              {/* Check columns */}
              <div style={{ display:'flex', gap:10, marginBottom:14 }}>
                {itemPortionList.map((check, ci) => (
                  <div key={ci} style={{ flex:1, background:'var(--bg3)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden' }}>
                    <div style={{ padding:'8px 10px', borderBottom:'1px solid var(--bdr)', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                      <span style={{ fontSize:11, fontWeight:700, color:'var(--t2)' }}>Check {ci+1}</span>
                      <span style={{ fontSize:12, fontWeight:700, color:'var(--acc)', fontFamily:'DM Mono,monospace' }}>{money(check.total)}</span>
                    </div>
                    <div style={{ padding:'8px 8px', minHeight:60 }}>
                      {check.items.length === 0 && <div style={{ fontSize:11, color:'var(--t4)', textAlign:'center', padding:'12px 0' }}>Empty</div>}
                      {check.items.map(item => (
                        <div key={item.uid} onClick={()=>moveItemToPool(item)} style={{ fontSize:11, color:'var(--t2)', padding:'5px 8px', background:'var(--bg2)', borderRadius:6, marginBottom:4, cursor:'pointer', display:'flex', justifyContent:'space-between' }}>
                          <span>{item.qty>1?`${item.qty}× `:''}{item.name.split(' ').slice(0,2).join(' ')}</span>
                          <span style={{ color:'var(--t3)', fontFamily:'DM Mono,monospace' }}>{money((item.price*item.qty))}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              <button className="btn btn-acc btn-full" style={{ height:46 }}
                disabled={unassigned.length > 0 && itemPortionList.every(p=>p.items.length===0)}
                onClick={confirmSplit}>
                Confirm split →
              </button>
            </>
          )}

          {/* ══ CUSTOM AMOUNTS ══════════════════════════════════════ */}
          {mode==='amount' && (
            <>
              <div style={{ fontSize:13, color:'var(--t3)', marginBottom:14 }}>Total to cover: {money(total)}</div>
              {customAmounts.map((amt, i) => {
                const covered = customAmounts.slice(0,i).reduce((s,a)=>s+(parseFloat(a)||0),0);
                return (
                  <div key={i} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
                    <div style={{ width:28, height:28, borderRadius:'50%', background:'var(--acc-d)', border:'1px solid var(--acc-b)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:700, color:'var(--acc)', flexShrink:0 }}>{i+1}</div>
                    <div style={{ position:'relative', flex:1 }}>
                      <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', color:'var(--t3)', fontWeight:600 }}>£</span>
                      <input type="number" value={amt} onChange={e=>setCustomAmounts(a=>a.map((x,j)=>j===i?e.target.value:x))} placeholder="0.00" className="input" style={{ paddingLeft:24 }}/>
                    </div>
                    {customAmounts.length>2&&<button onClick={()=>setCustomAmounts(a=>a.filter((_,j)=>j!==i))} style={{ color:'var(--red)', background:'none', border:'none', cursor:'pointer', fontSize:18, fontFamily:'inherit' }}>×</button>}
                  </div>
                );
              })}

              {(() => {
                const covered = customAmounts.reduce((s,a)=>s+(parseFloat(a)||0),0);
                const diff = total - covered;
                return (
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, padding:'8px 12px', borderRadius:8, marginBottom:14, background:Math.abs(diff)<0.01?'var(--grn-d)':diff>0?'var(--red-d)':'var(--bg3)', border:`1px solid ${Math.abs(diff)<0.01?'var(--grn-b)':diff>0?'var(--red-b)':'var(--bdr)'}` }}>
                    <span style={{ color:Math.abs(diff)<0.01?'var(--grn)':diff>0?'var(--red)':'var(--t3)' }}>{Math.abs(diff)<0.01?'Fully covered':diff>0?`Short by ${money(diff)}`:`Over by ${money(Math.abs(diff))}`}</span>
                    <span style={{ color:'var(--t2)', fontFamily:'DM Mono,monospace' }}>{money(covered)} / {money(total)}</span>
                  </div>
                );
              })()}

              <div style={{ display:'flex', gap:8, marginBottom:14 }}>
                <button onClick={()=>setCustomAmounts(a=>[...a,''])} style={{ flex:1, padding:'8px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px dashed var(--bdr2)', color:'var(--t3)', fontSize:12 }}>+ Add guest</button>
              </div>
              <button className="btn btn-acc btn-full" style={{ height:46 }}
                disabled={Math.abs(customAmounts.reduce((s,a)=>s+(parseFloat(a)||0),0)-total)>0.01}
                onClick={confirmSplit}>Confirm split →</button>
            </>
          )}

          {/* ══ TENDER MODE ════════════════════════════════════════ */}
          {mode==='tender' && tenderingIdx === null && (
            <>
              {allPaid && (
                <div style={{ textAlign:'center', padding:'20px 0' }}>
                  <div style={{ fontSize:52, marginBottom:12 }}>✅</div>
                  <div style={{ fontSize:22, fontWeight:800, color:'var(--grn)', marginBottom:6 }}>All paid</div>
                  <div style={{ fontSize:14, color:'var(--t3)' }}>Closing check…</div>
                </div>
              )}
              {!allPaid && (
                <>
                  <div style={{ fontSize:11, fontWeight:700, color:'var(--t2)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:12 }}>
                    Tap a check to take payment
                  </div>
                  {portions.map((p, i) => (
                    <div key={p.id} onClick={()=>!p.paid&&setTenderingIdx(i)} style={{
                      display:'flex', alignItems:'center', justifyContent:'space-between',
                      padding:'14px 16px', borderRadius:14, marginBottom:8, cursor:p.paid?'default':'pointer',
                      background: p.paid?'var(--grn-d)':'var(--bg3)',
                      border:`1.5px solid ${p.paid?'var(--grn-b)':'var(--bdr)'}`,
                      transition:'all .15s',
                    }}>
                      <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                        <div style={{ width:32, height:32, borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', background:p.paid?'var(--grn)':'var(--bg4)', fontSize:p.paid?18:14, fontWeight:700, color:p.paid?'#fff':'var(--t2)' }}>
                          {p.paid ? '✓' : i+1}
                        </div>
                        <div>
                          <div style={{ fontSize:14, fontWeight:600, color:p.paid?'var(--grn)':'var(--t1)' }}>{p.label}</div>
                          {p.paid && <div style={{ fontSize:11, color:'var(--grn)', marginTop:1 }}>
                            {p.method==='card'?'💳 Card':p.method==='cash'?`💵 Cash · change ${money((p.change||0))}`:p.method==='gift_card'?'🎁 Gift Card':'Paid'}
                          </div>}
                        </div>
                      </div>
                      <div style={{ textAlign:'right' }}>
                        <div style={{ fontSize:18, fontWeight:800, color:p.paid?'var(--grn)':'var(--acc)', fontFamily:'DM Mono,monospace' }}>{money(p.total)}</div>
                        {!p.paid && <div style={{ fontSize:10, color:'var(--t4)', marginTop:1 }}>tap to pay →</div>}
                      </div>
                    </div>
                  ))}
                  <div style={{ marginTop:16, display:'flex', justifyContent:'space-between', padding:'10px 16px', background:'var(--bg3)', borderRadius:10, fontSize:13, color:'var(--t3)' }}>
                    <span>Remaining</span>
                    <span style={{ fontFamily:'DM Mono,monospace', fontWeight:700, color:'var(--t1)' }}>{money(remaining)}</span>
                  </div>
                </>
              )}
            </>
          )}

          {/* ══ PORTION TENDER ════════════════════════════════════= */}
          {mode==='tender' && tenderingIdx !== null && (
            <PortionTender
              portion={portions[tenderingIdx]}
              portionNum={tenderingIdx+1}
              total={total}
              canTakeCash={canTakeCash}
              onComplete={(method, tendered, change, piId, tip, staged) => handlePortionPaid(tenderingIdx, method, tendered, change, piId, tip, staged)}
              onBack={() => setTenderingIdx(null)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
