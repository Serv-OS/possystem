// MCardFlow — runs the card payment.
//
// Runtime decision tree:
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
import { stripeCurrency } from '../../lib/currency';
import { tapToPayAvailable, tapInit, tapCollect, tapCancel } from '../../lib/tapToPay';
import { isTrainingMode } from '../../lib/trainingMode';

export default function MCardFlow({ payment, onCancel, onApproved }) {
  const { deviceConfig, walkInOrder, activeTableId, tables } = useStore();
  const [phase, setPhase] = useState('starting'); // starting | rest | sim | approved | error
  const [statusMsg, setStatusMsg] = useState('Preparing payment…');
  const [errorMsg, setErrorMsg] = useState(null);
  const pollAbortRef = useRef(false);
  const startedRef = useRef(false);

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
      // Native Tap to Pay takes priority when the MPOS app injected the bridge,
      // unless this device is explicitly pinned to a hardware (network) reader.
      if (paymentMode !== 'assigned_reader' && tapToPayAvailable()) {
        await runTapToPayFlow();
        return;
      }
      if (paymentMode === 'assigned_reader') {
        const reader = await getAssignedNetworkReader();
        if (!reader) {
          setStatusMsg('No reader assigned — using simulated approval');
          setPhase('sim');
          return;
        }
        await runRestFlow(reader);
        return;
      }
      // No native bridge (browser/dev) and no hardware reader → simulate.
      setPhase('sim');
    } catch (e) {
      setErrorMsg(e?.message || String(e));
      setPhase('error');
    }
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

  if (phase === 'rest' || phase === 'starting') {
    return <Waiting grand={grand} title="Customer paying on reader" sub={statusMsg} onCancel={cancelFlow} />;
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

function Waiting({ grand, title, sub, onCancel }) {
  return (
    <div style={Sx.shell}>
      <div style={Sx.header}>
        <button onClick={onCancel} style={Sx.iconBtn} aria-label="Cancel">←</button>
        <div style={{ flex:1 }}>
          <div style={Sx.hTitle}>Card payment</div>
          <div style={Sx.hSub}>{money(grand)}</div>
        </div>
      </div>
      <div style={{ ...Sx.scroller, padding:'48px 16px', textAlign:'center' }}>
        <div style={{ fontSize:54, marginBottom:14 }}>📲</div>
        <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)', marginBottom:6 }}>{title}</div>
        <div style={{ fontSize:13, color:'var(--t3)', marginBottom:24 }}>{sub}</div>
        <div style={{ fontSize:36, fontWeight:800, fontFamily:'var(--font-mono)', color:'var(--acc)' }}>{money(grand)}</div>
      </div>
      <div style={Sx.bottom}>
        <button onClick={onCancel} style={{ ...Sx.btnGhost, color:'var(--red)', borderColor:'var(--red-b)' }}>✕ Cancel payment</button>
      </div>
    </div>
  );
}
