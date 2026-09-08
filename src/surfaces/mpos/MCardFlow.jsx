// MCardFlow — runs the card payment.
//
// Runtime decision tree:
//   0) If the native MPOS wrapper injected the Adyen local nexo bridge
//      (window.RposAdyenNexo) → THIS DEVICE IS THE CARD READER. We are running on
//      an Adyen Android payment terminal (S1F2L / S1E2L / S1E4 Pro), so the card is
//      presented to THIS screen, not to a machine somewhere else. Highest priority:
//      when there is a reader in your hand, nothing else should be considered.
//      See runAdyenLocalTerminalFlow for the money contract.
//   1) If the native MPOS app injected the Tap to Pay bridge (window.RposTapToPay)
//      and this device isn't pinned to a hardware reader → NATIVE Tap to Pay:
//      connect the device's built-in reader, create a card_present PaymentIntent,
//      collect+confirm the tap natively (the NFC reader can't be driven from a
//      WebView). This bridge is implemented by the native iOS MPOS app (Apple Tap
//      to Pay on iPhone). On Android the bridge is absent, so this branch is
//      skipped — the Android MPOS app takes orders and uses a hardware reader.
//   2) If profile.payment_mode is 'assigned_reader' AND a network reader is
//      bound to this device → REST flow (stripe-process-payment-on-reader, poll,
//      customer pays on the WisePOS E screen).
//   3) Otherwise → simulated approval (browser dev / unconfigured devices).

import { useState, useEffect, useRef } from 'react';
import { useStore } from '../../store';
import { resolvePlatformLocationId, getAssignedNetworkReader } from '../../lib/networkReader';
import { getActiveLocationSync, supabase, ensureAuthToken } from '../../lib/supabase';
import { Sx, money } from './MShellStyles';
import { stripeCurrency, getActiveCurrencyCode } from '../../lib/currency';
import { tapToPayAvailable, tapInit, tapCollect, tapCancel } from '../../lib/tapToPay';
import { isTrainingMode } from '../../lib/trainingMode';
import { adyenLocalBridgeAvailable, runAdyenLocalPayment, abortAdyenLocalPayment } from '../../lib/payments/adyenLocalTerminal';
import { resolveSelfHostedAdyenTerminal } from '../../lib/payments/localTerminalIdentity';
import { dispatchTerminalJob, buildCheckKey, toMinor, forgetJob, getPosDeviceId, cancelTerminalJob, findPaxTerminal, pollTerminalJob, abortTerminalJob } from '../../lib/payments/terminalJobs';

// Stage → what the person holding the terminal is actually being asked to do.
// NOTHING here may say "hand it to the customer" or "sent to the card machine":
// the machine IS this device, and telling staff to look at another screen while a
// card prompt is up on this one is how a tender gets abandoned mid-flight.
const LOCAL_STAGE_COPY = {
  starting:     { title: 'Getting ready',        sub: 'Setting the payment up on this terminal…' },
  preparing:    { title: 'Getting ready',        sub: 'Asking the server for the amount…' },
  present_card: { title: 'Present the card',     sub: 'Tap, insert or swipe on THIS terminal' },
  confirming:   { title: 'Confirming',           sub: 'Checking the result with the bank…' },
  recovering:   { title: 'Checking the result',  sub: 'Do not take payment again — finding out what happened' },
  cancelling:   { title: 'Cancelling',           sub: 'Stopping the payment on this terminal…' },
};

export default function MCardFlow({ payment, onCancel, onApproved }) {
  const { deviceConfig, walkInOrder, activeTableId, tables } = useStore();
  const [phase, setPhase] = useState('starting'); // starting | rest | local | localSetup | sim | approved | error
  const [statusMsg, setStatusMsg] = useState('Preparing payment…');
  const [errorMsg, setErrorMsg] = useState(null);
  const [localStage, setLocalStage] = useState('starting');
  const [localSetup, setLocalSetup] = useState(null);   // { reason, claimCode } when the reader is not ready
  const pollAbortRef = useRef(false);
  const startedRef = useRef(false);
  // The on-device Adyen tender, held across renders so Cancel knows what is live.
  const localJobRef = useRef(null);        // { jobId, checkKey, closedCheckId }
  const localStageRef = useRef(null);
  const localAbortSentRef = useRef(false);
  const localCancelRequestedRef = useRef(false);

  const paymentMode = deviceConfig?.paymentMode || 'tap_to_pay';
  const grand = payment?.grand ?? 0;

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    runFlow();
    return () => { pollAbortRef.current = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runFlow = async () => {
    try {
      // TRAINING MODE: never reach a real processor (Tap to Pay or reader).
      // Simulate an instant approval so the MPOS close flow runs in-memory.
      if (isTrainingMode()) {
        setStatusMsg('TRAINING — no card charged');
        setPhase('approved');
        onApproved?.({ method:'card', paymentIntentId:`training_${Date.now()}`, tip: payment.tip, grand, simulated:true, training:true });
        return;
      }
      // TIER 0 — this device IS the reader (Adyen Android terminal).
      if (adyenLocalBridgeAvailable()) {
        await runAdyenLocalTerminalFlow();
        return;
      }
      // Native Tap to Pay takes priority when the MPOS app injected the bridge,
      // unless this device is explicitly pinned to a hardware (network) reader.
      if (paymentMode !== 'assigned_reader' && tapToPayAvailable()) {
        await runTapToPayFlow();
        return;
      }
      if (paymentMode === 'assigned_reader') {
        // v5.8.23: an Adyen (or Ryft) reader bound to THIS device in Back Office →
        // Card readers takes the same cloud terminal-job route the till uses. The
        // Stripe registry lookup below used to be the only path, so an Adyen reader
        // bound to an MPOS was invisible and the MPOS "simulated" the approval.
        const { terminal, reason } = await findPaxTerminal({ posDeviceId: getPosDeviceId() });
        if (terminal && (terminal.adyen_terminal_id || terminal.ryft_terminal_id)) {
          await runCloudTerminalFlow(terminal);
          return;
        }
        const reader = await getAssignedNetworkReader();
        if (!reader) {
          // v5.8.26: say WHY, on screen. The lookup's reason was being discarded, so
          // staff saw a simulated approval with no clue which link was missing.
          setStatusMsg(`No reader assigned — using simulated approval. ${reason || 'No card terminal is bound to this handset in Back Office → Card readers.'} (this handset: ${String(getPosDeviceId() || 'no device id').slice(0, 8)})`);
          setPhase('sim');
          return;
        }
        await runRestFlow(reader);
        return;
      }
      // No native bridge (browser/dev) and no hardware reader → simulate.
      // v5.8.26: say which payment mode this handset thinks it is in. A profile
      // changed in Back Office after pairing stays cached on the device until a
      // Push to POS or a re-pair, and that is invisible without this line.
      setStatusMsg(`Simulated approval — this handset's payment mode is "${paymentMode}". For a card reader, set the device profile to "Assigned network reader" and press Push to POS in Back Office.`);
      setPhase('sim');
    } catch (e) {
      setErrorMsg(e?.message || String(e));
      setPhase('error');
    }
  };

  const stage = (s) => { localStageRef.current = s; setLocalStage(s); };

  // ── TIER 0: the Adyen terminal we are running ON ──────────────────────────
  //
  // MONEY CONTRACT — the whole point of routing this through terminal_jobs rather
  // than talking to the reader directly:
  //
  //   1. terminal-job-create writes the job row. For an Adyen-LINKED terminal that
  //      row is born status='charging_unsent' WITH charge_minor = due_minor already
  //      set server-side (see the insert in terminal-job-create). That insert IS the
  //      "money frozen before the card is touched" step on this fleet — the PAX walk
  //      (claim → commit_tip → charging_unsent) does not apply, and calling
  //      terminal_commit_tip here would throw 'job is not awaiting a tip'.
  //   2. adyen-terminal-charge 'prepare_local' CAS-flips charging_unsent→charging and
  //      returns a nexo PaymentRequest built from THE DB'S amount. We never build,
  //      inspect or amend a payment message.
  //   3. The native bridge posts it to https://127.0.0.1:8443/nexo on this device.
  //   4. 'report_local' settles it SERVER-side. Our report is advisory: the server
  //      re-checks the ServiceID, the POIID, the authorised amount, and prefers
  //      Adyen's own TransactionStatusRequest answer over ours whenever it can get one.
  //
  // We report the sale approved to MPOS ONLY on the server's settled verdict. A lost
  // response is NEVER a decline — runAdyenLocalPayment routes it to 'result' recovery
  // and we surface "outcome unknown, do not charge again" rather than guessing.
  //
  // TIP: MTender already took the tip on this screen, so the card takes bill + tip in
  // one go (due_minor = grand) and suppressTip stops the reader raising a SECOND
  // gratuity prompt on top. The tip is recorded on the closed check by MPOS's normal
  // close path, which is what the Tips report and tronc read.
  // v5.8.23: CLOUD terminal job to a reader bound to this MPOS. Same job row, same
  // server-side settle, same recovery as the till; the only difference from the
  // local flow above is that dispatch fires Adyen's cloud 'start' and we poll.
  const runCloudTerminalFlow = async (terminal) => {
    setPhase('local');
    stage('starting');
    const st = useStore.getState();
    const locationId = getActiveLocationSync();
    const tableId = activeTableId || null;
    const session = tableId ? st.tables.find(t => t.id === tableId)?.session : null;
    const items = (tableId ? (session?.items || []) : (st.walkInOrder?.items || [])).filter(i => !i.voided);
    const grandMinor = toMinor(grand);
    const tipMinor = Math.min(toMinor(payment?.tip), grandMinor);
    const billMinor = grandMinor - tipMinor;
    if (!(grandMinor > 0)) throw new Error('There is nothing for the card to take.');
    const closedCheckId = localJobRef.current?.closedCheckId || `chk-${Date.now()}`;
    const checkKey = buildCheckKey({ locationId, tableId, sessionId: session?.id, leg: tableId ? undefined : closedCheckId });
    const { job, kickError } = await dispatchTerminalJob({
      checkKey,
      targetTerminalId: terminal.id,
      posDeviceId: getPosDeviceId(),
      tipBasisMinor: billMinor,
      dueMinor: grandMinor,
      currency: getActiveCurrencyCode?.() || 'GBP',
      suppressTip: true,
      closedCheckId,
      checkDraft: {
        tableId, tableLabel: tableId, sessionId: session?.id || null, locationId,
        orderType: st.orderType || (tableId ? 'dine-in' : 'takeaway'),
        covers: session?.covers ?? 1,
        server: st.staff?.name || session?.server || null,
        staffId: st.staff?.id || null,
        items,
        discounts: session?.discounts || [],
        subtotalMinor: toMinor(payment?.subtotal),
        totalMinor: billMinor,
        tipMinor,
        seatedAt: session?.seatedAt ?? null,
        source: 'mpos_cloud_terminal',   // MPOS closes its own check, like the local flow
      },
      localBridge: false,
    });
    localJobRef.current = { jobId: job.id, checkKey, closedCheckId, cloud: true };
    if (kickError) {
      forgetJob(checkKey);
      throw new Error(`Could not reach the card machine: ${kickError}`);
    }
    if (localCancelRequestedRef.current) {
      await cancelTerminalJob(job.id);
      forgetJob(checkKey);
      return;
    }
    stage('waiting');
    const done = await pollTerminalJob(job.id, { onUpdate: (j) => stage(j?.status || 'waiting') });
    if (done?.status === 'approved') {
      forgetJob(checkKey);
      setPhase('approved');
      onApproved?.({
        method: 'card',
        processor: done.processor || (terminal.adyen_terminal_id ? 'adyen' : 'ryft'),
        closedCheckId,
        paymentIntentId: done.transaction_id || done.payment_session_id || null,
        cardReceipt: done.card || null,
        tip: payment.tip,
        grand,
      });
      return;
    }
    if (done?.status === 'unknown' || done?.needs_human) {
      throw new Error(
        'The result of this payment is not confirmed yet. DO NOT take payment again. '
        + 'Check the card terminal and Back Office → Card readers before retrying.',
      );
    }
    if (done?.status === 'cancelled') {
      forgetJob(checkKey);
      onCancel?.();
      return;
    }
    forgetJob(checkKey);
    throw new Error(done?.decline_reason || done?.last_error || 'The card was declined.');
  };

  const runAdyenLocalTerminalFlow = async () => {
    setPhase('local');
    stage('starting');

    const self = await resolveSelfHostedAdyenTerminal();
    if (!self.ok) {
      setLocalSetup({ reason: self.reason || 'This terminal cannot take card payments yet.', claimCode: self.claimCode || null });
      setPhase('localSetup');
      return;
    }

    const st = useStore.getState();
    const locationId = getActiveLocationSync();
    const tableId = activeTableId || null;
    const session = tableId ? st.tables.find(t => t.id === tableId)?.session : null;
    const items = (tableId ? (session?.items || []) : (st.walkInOrder?.items || [])).filter(i => !i.voided);

    // ONE conversion each, then arithmetic in minor units — never round twice.
    const grandMinor = toMinor(grand);
    const tipMinor = Math.min(toMinor(payment?.tip), grandMinor);
    const billMinor = grandMinor - tipMinor;
    if (!(grandMinor > 0)) throw new Error('There is nothing for the card to take.');

    // Minted BEFORE the network call and carried into onApproved, so the job row,
    // the closed check and MPOS's own post-approval recovery record all agree on
    // one id — that is what makes a retry rewrite the same row instead of booking
    // the sale twice.
    const closedCheckId = localJobRef.current?.closedCheckId || `chk-${Date.now()}`;
    const checkKey = buildCheckKey({
      locationId, tableId, sessionId: session?.id,
      // A table check shares one key per table+session on purpose (two devices
      // working the same table must collide). A walk-in has no session, so give it
      // a per-bill leg or every walk-in at the venue would share `loc:walkin:-`.
      leg: tableId ? undefined : closedCheckId,
    });

    const { job } = await dispatchTerminalJob({
      checkKey,
      targetTerminalId: self.terminal.id,     // THIS device's own paired reader row
      posDeviceId: getPosDeviceId(),
      tipBasisMinor: billMinor,               // the BILL — what a tip % would apply to
      dueMinor: grandMinor,                   // bill + the tip MTender already took
      currency: getActiveCurrencyCode?.() || 'GBP',
      suppressTip: true,                      // the tip pass happened on this screen already
      closedCheckId,
      checkDraft: {
        tableId, tableLabel: tableId, sessionId: session?.id || null, locationId,
        orderType: st.orderType || (tableId ? 'dine-in' : 'takeaway'),
        covers: session?.covers ?? 1,
        server: st.staff?.name || session?.server || null,
        staffId: st.staff?.id || null,
        items,
        discounts: session?.discounts || [],
        subtotalMinor: toMinor(payment?.subtotal),
        totalMinor: billMinor,
        tipMinor,
        seatedAt: session?.seatedAt ?? null,
        // DELIBERATELY NOT one of terminalJobs.RECONCILABLE_SOURCES. MPOS does not
        // build the recordClosedCheck-shaped draft the reconciler books from; it
        // closes its own check (clearTable / recordWalkInClosed) and already has a
        // durable backstop for a close that fails after approval — the IndexedDB
        // OfflineQueue 'closed_check' recovery in MPOSSurface.onCloseFailed. Two
        // closers on one sale is a worse failure than the one we would be fixing.
        source: 'mpos_adyen_local',
      },
      // Do NOT let dispatch fire the cloud 'start' kick — we drive the reader here.
      localBridge: true,
    });

    localJobRef.current = { jobId: job.id, checkKey, closedCheckId };

    // Cancel pressed while the job was being created. This component is already
    // unmounted, but the promise chain is not — and it is the only thing that knows
    // the id. Stop the job here or it holds the reader (idx_tj_one_live_per_terminal)
    // until its 15-minute lease expires. Nothing has been charged: prepare_local has
    // not run, so terminal_job_cancel's charged_at guard lets this through.
    if (localCancelRequestedRef.current) {
      await cancelTerminalJob(job.id);
      forgetJob(checkKey);
      return;
    }

    const res = await runAdyenLocalPayment(job.id, { onStage: stage });

    // ── The server's verdict, and nothing else ────────────────────────────────
    if (res?.ok && res.state === 'approved') {
      forgetJob(checkKey);
      setPhase('approved');
      onApproved?.({
        method: 'card',
        processor: 'adyen',
        closedCheckId,
        paymentIntentId: res.transaction_id || res.payment_session_id || null,
        cardReceipt: res.card || null,
        tip: payment.tip,
        grand,
      });
      return;
    }
    if (res?.pending) {
      // The tender may STILL be live or already taken. Never a decline, never a retry.
      throw new Error(
        'The result of this payment is not confirmed yet. DO NOT take payment again. '
        + 'Check the card terminal and Back Office → Card readers before retrying.',
      );
    }
    if (res?.state === 'cancelled' || res?.decline_reason === 'Cancel') {
      forgetJob(checkKey);
      onCancel?.();
      return;
    }
    forgetJob(checkKey);
    throw new Error(res?.decline_reason || res?.error || 'The card was declined.');
  };

  // Cancel while the reader is ours to drive. An abort is ADVISORY — the tender may
  // already have completed — so we send it and STAY on this screen until the server
  // says what actually happened. Telling staff "cancelled" while money moves is the
  // exact failure the job lifecycle exists to prevent.
  const cancelLocalFlow = () => {
    const live = localJobRef.current;
    if (!live) {
      // The job is still being created. Never leave staff behind a dead button on a
      // slow network: record the intent (the dispatch continuation acts on it) and go.
      localCancelRequestedRef.current = true;
      onCancel?.();
      return;
    }
    if (localAbortSentRef.current) return;
    localAbortSentRef.current = true;
    stage('cancelling');
    if (live.cloud) { abortTerminalJob(live.jobId); return; }   // v5.8.23 cloud job: server-side abort
    abortAdyenLocalPayment(live.jobId);
  };

  // Native Stripe Tap to Pay: connect the phone's reader, create a card_present
  // PaymentIntent (amount incl. tip, captured automatically), then collect+confirm
  // the tap on-device. The whole money path stays Stripe — we just brand it 'stripe'.
  const runTapToPayFlow = async () => {
    setPhase('rest'); setStatusMsg('Connecting Tap to Pay…');
    const opsLocation = getActiveLocationSync();
    const platformLocId = await resolvePlatformLocationId(opsLocation);
    if (!platformLocId) throw new Error('No connected Stripe account for this location');
    const token = await ensureAuthToken();
    if (!token) throw new Error('Could not obtain auth token — check Anonymous sign-ins are enabled in Supabase Auth.');

    // Stripe Terminal Location (tml_…) for connectReader — per-merchant config.
    const tmlId = import.meta.env.VITE_STRIPE_TERMINAL_LOCATION_ID || deviceConfig?.tapTerminalLocationId || '';

    // 1) Connect the built-in Tap to Pay reader (one-time per app session).
    const initRes = await tapInit({
      locationId: platformLocId,
      supabaseUrl: import.meta.env.VITE_SUPABASE_URL,
      supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
      accessToken: token,
      stripeTerminalLocationId: tmlId,
    });
    if (!initRes.ok) {
      // Not fatal — let staff still test the rest of the flow; show why.
      setStatusMsg(initRes.message || 'Tap to Pay unavailable');
      setPhase('sim');
      return;
    }

    // 2) Create the card_present PaymentIntent (tip already in `grand`).
    setStatusMsg('Ready — present card');
    const piRes = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-create-payment-intent`, {
      method:'POST',
      headers:{ 'content-type':'application/json', authorization:`Bearer ${token}` },
      body: JSON.stringify({
        location_id: platformLocId,
        amount_minor: Math.round(grand * 100),
        currency: stripeCurrency(),
        channel: 'card_present',
        payment_method_types: ['card_present'],
        capture_method: 'automatic',
        description: 'MPOS Tap to Pay',
        ...(payment?.tip > 0 ? { metadata: { tip_minor: String(Math.round(payment.tip * 100)) } } : {}),
      }),
    });
    const pj = await piRes.json();
    if (!piRes.ok || pj.error || !pj.client_secret) throw new Error(pj.error || `HTTP ${piRes.status}`);

    // 3) Run the tap natively (full-screen OS Tap to Pay UI takes over here).
    const tap = await tapCollect({
      clientSecret: pj.client_secret,
      paymentIntentId: pj.payment_intent_id,
      amountMinor: Math.round(grand * 100),
      currency: stripeCurrency(),
    });
    if (!tap.ok) {
      const code = String(tap.code || '').toUpperCase();
      if (code.includes('CANCEL')) { onCancel?.(); return; }
      throw new Error(tap.message || 'Tap to Pay failed');
    }

    setPhase('approved');
    onApproved?.({
      method: 'card',
      paymentIntentId: tap.paymentIntentId || pj.payment_intent_id,
      tip: payment.tip,
      grand,
      processor: 'stripe',
    });
  };

  const cancelFlow = () => {
    // On-device Adyen owns its own cancel semantics (abort, then wait for the truth).
    if (phase === 'local') { cancelLocalFlow(); return; }
    // Best-effort cancel of an in-progress native tap, then bubble up.
    try { if (tapToPayAvailable()) tapCancel(); } catch (e) { /* noop */ }
    onCancel?.();
  };

  const runRestFlow = async (reader) => {
    setPhase('rest'); setStatusMsg('Pushing cart to reader…');
    const opsLocation = getActiveLocationSync();
    const platformLocId = await resolvePlatformLocationId(opsLocation);

    const items = activeTableId
      ? (tables.find(t => t.id === activeTableId)?.session?.items || []).filter(i => !i.voided)
      : (walkInOrder?.items || []);
    const lineItems = items.map(it => ({
      description: String(it.name || 'Item').slice(0, 60),
      amount: Math.round((it.price || 0) * 100),
      quantity: Math.max(1, it.qty || 1),
    }));
    if (payment?.tip > 0) lineItems.push({ description:'Tip', amount: Math.round(payment.tip * 100), quantity:1 });

    // v5.5.170: was sending the whole rpos-device JSON blob as opsDeviceId,
    // edge fn looked up pos_devices.id and returned "device not found".
    // Parse + extract the id field. Same fix as CheckoutModal.
    const opsDeviceId = (() => {
      try {
        const raw = localStorage.getItem('rpos-device');
        if (!raw) return '';
        const parsed = JSON.parse(raw);
        return parsed?.id || '';
      } catch { return ''; }
    })();
    const token = await ensureAuthToken();
    if (!token) throw new Error('Could not obtain auth token — check Anonymous sign-ins are enabled in Supabase Auth.');

    const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-process-payment-on-reader`, {
      method:'POST',
      headers:{ 'content-type':'application/json', authorization:`Bearer ${token}` },
      body: JSON.stringify({
        pos_device_id: opsDeviceId,
        amount_minor: Math.round(grand * 100),
        currency: stripeCurrency(),
        line_items: lineItems,
      }),
    });
    const j = await res.json();
    if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);

    setStatusMsg('Customer is paying on the reader');
    const piId = j.payment_intent_id;
    const start = Date.now();
    while (!pollAbortRef.current && Date.now() - start < 5*60*1000) {
      await new Promise(r => setTimeout(r, 1500));
      if (pollAbortRef.current) return;
      const pollToken = await ensureAuthToken();
      const pr = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-poll-reader-action`, {
        method:'POST',
        headers:{ 'content-type':'application/json', authorization:`Bearer ${pollToken}` },
        body: JSON.stringify({ payment_intent_id: piId, reader_id: j.reader_id, location_id: platformLocId }),
      });
      const pj = await pr.json();
      if (!pr.ok) continue;
      const ra = pj.reader_action;
      if (ra?.type === 'process_payment_intent' && ra?.status === 'in_progress') {
        setStatusMsg('Card prompt active on reader');
      }
      if (pj.is_terminal_state) {
        if (pj.is_success) {
          setPhase('approved');
          onApproved?.({
            method:'card',
            paymentIntentId: piId,
            tip: payment.tip,
            grand,
            applicationFee: pj.application_fee_amount,
          });
          return;
        }
        throw new Error(pj.last_payment_error || `Payment ${pj.payment_intent_status}`);
      }
    }
    if (!pollAbortRef.current) throw new Error('Timed out — customer did not complete payment');
  };

  const simulateApprove = () => {
    setPhase('approved');
    onApproved?.({ method:'card', paymentIntentId:`sim_${Date.now()}`, tip: payment.tip, grand, simulated:true });
  };

  // ── Render ────────────────────────────────────────────────────────────────

  if (phase === 'local') {
    const copy = LOCAL_STAGE_COPY[localStage] || LOCAL_STAGE_COPY.starting;
    // Once the card is live, "cancel" can only ASK the reader to stop — and the
    // answer may still be "approved". Say that, rather than offering a button that
    // implies the payment is off.
    const live = localStage === 'present_card' || localStage === 'confirming';
    return (
      <Waiting
        grand={grand}
        icon="💳"
        title={copy.title}
        sub={copy.sub}
        cancelLabel={
          localStage === 'cancelling' ? 'Cancelling…'
            : localStage === 'recovering' ? 'Waiting for the result…'
              : live ? '✕ Stop this payment' : '✕ Cancel payment'
        }
        cancelDisabled={localStage === 'cancelling' || localStage === 'recovering'}
        onCancel={cancelFlow}
      />
    );
  }
  if (phase === 'localSetup') {
    return (
      <div style={Sx.shell}>
        <div style={Sx.header}>
          <button onClick={onCancel} style={Sx.iconBtn} aria-label="Back">←</button>
          <div style={{ flex:1 }}>
            <div style={Sx.hTitle}>Card reader not ready</div>
            <div style={Sx.hSub}>{money(grand)}</div>
          </div>
        </div>
        <div style={{ ...Sx.scroller, padding:'24px 16px', textAlign:'center' }}>
          <div style={{ fontSize:48, marginBottom:10 }}>🔌</div>
          <div style={{ fontSize:13, color:'var(--t3)', lineHeight:1.6, maxWidth:380, margin:'0 auto 18px' }}>
            {localSetup?.reason}
          </div>
          {localSetup?.claimCode && (
            <div style={{ background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:12, padding:'16px 14px', maxWidth:340, margin:'0 auto' }}>
              <div style={{ fontSize:11, color:'var(--t4)', textTransform:'uppercase', letterSpacing:.6, marginBottom:8 }}>Pairing code</div>
              <div style={{ fontSize:30, fontWeight:800, letterSpacing:3, fontFamily:'var(--font-mono)', color:'var(--t1)' }}>
                {localSetup.claimCode}
              </div>
              <div style={{ fontSize:12, color:'var(--t3)', marginTop:10, lineHeight:1.5 }}>
                Type this into Back Office → Card readers to pair this terminal. The code expires 30 minutes after this screen was last open.
              </div>
            </div>
          )}
        </div>
        <div style={Sx.bottom}>
          <button onClick={() => { setLocalSetup(null); setPhase('starting'); runFlow(); }} style={Sx.btnPrim}>↻ Check again</button>
          <button onClick={onCancel} style={{ ...Sx.btnGhost, marginTop:8 }}>← Back to tender</button>
        </div>
      </div>
    );
  }
  if (phase === 'rest' || phase === 'starting') {
    // "Customer paying on reader" is wrong when the reader is the thing in your hand.
    const onThisDevice = adyenLocalBridgeAvailable();
    return (
      <Waiting
        grand={grand}
        icon={onThisDevice ? '💳' : '📲'}
        title={onThisDevice ? 'Getting ready' : 'Customer paying on reader'}
        sub={onThisDevice && phase === 'starting' ? 'Setting the payment up on this terminal…' : statusMsg}
        onCancel={cancelFlow}
      />
    );
  }
  if (phase === 'sim') {
    return (
      <div style={Sx.shell}>
        <div style={Sx.header}>
          <button onClick={onCancel} style={Sx.iconBtn} aria-label="Cancel">←</button>
          <div style={{ flex:1 }}>
            <div style={Sx.hTitle}>Card payment</div>
            <div style={Sx.hSub}>{statusMsg || 'Simulated card flow'}</div>
          </div>
        </div>
        <div style={{ ...Sx.scroller, padding:'24px 16px', textAlign:'center' }}>
          <div style={{ fontSize:54, marginBottom:8 }}>📱</div>
          <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', marginBottom:6 }}>
            Simulated card flow
          </div>
          <div style={{ fontSize:13, color:'var(--t3)', lineHeight:1.5, marginBottom:20, maxWidth:360, margin:'0 auto 20px' }}>
            Take card payments with an assigned reader, or Tap to Pay in the native MPOS app.
            In a browser (or when no reader is assigned) you can simulate a successful card
            payment to test the rest of the flow end-to-end.
          </div>
          <div style={{ fontSize:36, fontWeight:800, fontFamily:'var(--font-mono)', color:'var(--t1)', marginBottom:24 }}>{money(grand)}</div>
        </div>
        <div style={Sx.bottom}>
          <button onClick={simulateApprove} style={Sx.btnPrim}>✓ Simulate approved</button>
          <button onClick={onCancel} style={{ ...Sx.btnGhost, marginTop:8 }}>← Back</button>
        </div>
      </div>
    );
  }
  if (phase === 'error') {
    return (
      <div style={Sx.shell}>
        <div style={Sx.header}>
          <button onClick={onCancel} style={Sx.iconBtn} aria-label="Back">←</button>
          <div style={Sx.hTitle}>Payment failed</div>
        </div>
        <div style={{ ...Sx.scroller, padding:'24px 16px', textAlign:'center' }}>
          <div style={{ fontSize:48, marginBottom:8 }}>⚠️</div>
          <div style={{ fontSize:18, fontWeight:800, color:'var(--red)', marginBottom:6 }}>Payment failed</div>
          <div style={{ fontSize:13, color:'var(--t3)', maxWidth:380, margin:'0 auto', lineHeight:1.5 }}>{errorMsg}</div>
        </div>
        <div style={Sx.bottom}>
          <button onClick={onCancel} style={Sx.btnPrim}>← Back to tender</button>
        </div>
      </div>
    );
  }
  return null;
}

function Waiting({ grand, title, sub, onCancel, icon = '📲', cancelLabel = '✕ Cancel payment', cancelDisabled = false }) {
  return (
    <div style={Sx.shell}>
      <div style={Sx.header}>
        <button onClick={onCancel} style={Sx.iconBtn} aria-label="Cancel" disabled={cancelDisabled}>←</button>
        <div style={{ flex:1 }}>
          <div style={Sx.hTitle}>Card payment</div>
          <div style={Sx.hSub}>{money(grand)}</div>
        </div>
      </div>
      <div style={{ ...Sx.scroller, padding:'48px 16px', textAlign:'center' }}>
        <div style={{ fontSize:54, marginBottom:14 }}>{icon}</div>
        <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', marginBottom:6 }}>{title}</div>
        <div style={{ fontSize:13, color:'var(--t3)', marginBottom:24 }}>{sub}</div>
        <div style={{ fontSize:36, fontWeight:800, fontFamily:'var(--font-mono)', color:'var(--acc)' }}>{money(grand)}</div>
      </div>
      <div style={Sx.bottom}>
        <button
          onClick={onCancel}
          disabled={cancelDisabled}
          style={{ ...Sx.btnGhost, color:'var(--red)', borderColor:'var(--red-b)', opacity: cancelDisabled ? .5 : 1 }}
        >{cancelLabel}</button>
      </div>
    </div>
  );
}
