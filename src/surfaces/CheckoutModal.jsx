import { useCompact } from '../lib/useCompact';
import { useState, useEffect, useMemo, useRef } from 'react';
import { ALLERGENS } from '../data/seed';
import SplitModal from '../components/SplitModal';
import { useStore } from '../store';
import { calculateOrderTax } from '../lib/tax';
import {
  hasStripeTerminalBridge,
  initialize as initStripeTerminal,
  getStatus as getStripeTerminalStatus,
  collectPayment as terminalCollect,
  resolvePlatformLocationId,
  syncAuthTokenFromSession,
  getSavedPairing,
  autoReconnect,
  getAssignedNetworkReader,
  connectInternetReader,
} from '../lib/stripeTerminal';
import { getActiveLocationSync, supabase } from '../lib/supabase';

// ─── Tip picker ───────────────────────────────────────────────────────────────
function TipPicker({ total, onSelect }) {
  const compact = useCompact();
  const [custom, setCustom] = useState('');
  const [active, setActive] = useState(12.5);
  const presets = [0, 10, 12.5, 15, 20];
  const tipAmt = custom !== '' ? (parseFloat(custom)||0) : total * active / 100;
  const pick = (p) => { setActive(p); setCustom(''); };

  return (
    <div>
      <div style={{ textAlign:'center', marginBottom:20 }}>
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>Add gratuity to</div>
        <div style={{ fontSize:32, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)' }}>£{total.toFixed(2)}</div>
      </div>

      {/* Preset grid — £ amount as hero */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:6, marginBottom:16 }}>
        {presets.map(p => {
          const isOn = active===p && custom==='';
          const amt  = total * p / 100;
          return (
            <button key={p} onClick={()=>pick(p)} style={{
              padding:'12px 4px', borderRadius:12, cursor:'pointer', textAlign:'center', fontFamily:'inherit',
              border:`2px solid ${isOn?'var(--acc)':'var(--bdr)'}`,
              background:isOn?'var(--acc-d)':'var(--bg3)',
              transition:'all .12s',
            }}>
              {p===0 ? (
                <div style={{ fontSize:15, fontWeight:800, color:isOn?'var(--acc)':'var(--t3)', lineHeight:1 }}>None</div>
              ) : (
                <>
                  <div style={{ fontSize:15, fontWeight:800, color:isOn?'var(--acc)':'var(--t1)', fontFamily:'var(--font-mono)', lineHeight:1 }}>£{amt.toFixed(2)}</div>
                  <div style={{ fontSize:10, color:isOn?'var(--acc)':'var(--t4)', marginTop:3, fontWeight:700 }}>{p}%</div>
                </>
              )}
            </button>
          );
        })}
      </div>

      {/* Custom amount */}
      <div style={{ position:'relative', marginBottom:16 }}>
        <span style={{ position:'absolute', left:14, top:'50%', transform:'translateY(-50%)', color:'var(--t3)', fontWeight:700, fontSize:16, fontFamily:'var(--font-mono)' }}>£</span>
        <input type="number" value={custom}
          onChange={e=>{setCustom(e.target.value);setActive(null);}}
          placeholder="Custom amount"
          className="input" style={{ paddingLeft:30, fontSize:16, height:46 }}/>
      </div>

      {/* Live summary */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'12px 16px', background:'var(--bg3)', borderRadius:12, marginBottom:16, border:'1px solid var(--bdr)' }}>
        <div>
          <div style={{ fontSize:11, color:'var(--t3)', fontWeight:600, marginBottom:2 }}>Tip added</div>
          <div style={{ fontSize:13, color:'var(--t2)' }}>Bill + tip</div>
        </div>
        <div style={{ textAlign:'right' }}>
          <div style={{ fontSize:16, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>+£{tipAmt.toFixed(2)}</div>
          <div style={{ fontSize:20, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)' }}>£{(total+tipAmt).toFixed(2)}</div>
        </div>
      </div>

      <div style={{ display:'flex', gap:8 }}>
        <button className="btn btn-ghost" style={{ flex:1, height:46 }} onClick={()=>onSelect(0)}>Skip</button>
        <button className="btn btn-acc" style={{ flex:2, height:46, fontSize:14 }} onClick={()=>onSelect(tipAmt)}>
          Confirm tip · £{(total+tipAmt).toFixed(2)} →
        </button>
      </div>
    </div>
  );
}

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
  const bridgePresent = hasStripeTerminalBridge();

  // REST flow state (network reader)
  const [networkReader, setNetworkReader] = useState(null);            // { stripe_reader_id, label, ... }
  const [paymentIntentId, setPaymentIntentId] = useState(null);
  const [platformLocId, setPlatformLocId] = useState(null);
  const [restState, setRestState] = useState('idle');                  // idle | starting | collecting | success | error | cancelling
  const [restStatusMsg, setRestStatusMsg] = useState('');

  // Bridge flow state (existing)
  const [bridgeReady, setBridgeReady] = useState(false);
  const [hasReader, setHasReader] = useState(false);
  const [readerLabel, setReaderLabel] = useState('');
  const [state, setState] = useState('waiting');                      // waiting | collecting | confirming | approved | error
  const [statusMsg, setStatusMsg] = useState('Present card to reader');
  const [errorMsg, setErrorMsg] = useState(null);
  const [piResult, setPiResult] = useState(null);
  const startedRef = useRef(false);
  const pollAbortRef = useRef(false);

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
        const assigned = await getAssignedNetworkReader();
        if (cancelled) return;
        setNetworkReader(assigned);
      } catch (e) {
        console.warn('[CardTerminal] resolve location/reader failed:', e?.message ?? e);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Probe the bridge / BT reader once on mount (only if no network reader)
  useEffect(() => {
    let cancelled = false;
    if (!bridgePresent || networkReader) return;                       // network reader path skips bridge entirely
    (async () => {
      try {
        await syncAuthTokenFromSession();
        await initStripeTerminal();
        if (cancelled) return;
        let s = getStripeTerminalStatus();
        if (!s?.reader && getSavedPairing()) {
          setStatusMsg('Reconnecting to reader…');
          await autoReconnect();
          if (cancelled) return;
          s = getStripeTerminalStatus();
        }
        setBridgeReady(true);
        if (s?.reader) {
          setHasReader(true);
          setReaderLabel(s.reader.label || s.reader.serialNumber || 'Reader');
        } else {
          setHasReader(false);
        }
      } catch (e) {
        if (!cancelled) setErrorMsg(`Bridge init failed: ${e.message}`);
      }
    })();
    return () => { cancelled = true; };
  }, [bridgePresent, networkReader]);

  // ─── REST flow: start payment when network reader is available ────────
  useEffect(() => {
    if (!networkReader || !platformLocId || restState !== 'idle' || startedRef.current) return;
    startedRef.current = true;
    runRestFlow();
  }, [networkReader, platformLocId, restState]);

  // BT auto-start collect once reader is connected
  useEffect(() => {
    if (networkReader) return;                                          // REST flow handles its own start
    if (!bridgePresent || !bridgeReady || !hasReader || startedRef.current) return;
    if (state !== 'waiting') return;
    startedRef.current = true;
    runCollect();
  }, [bridgePresent, bridgeReady, hasReader, state, networkReader]);

  // Smooth transition to "approved" → call onComplete after brief moment
  useEffect(() => {
    if (state === 'approved' || restState === 'success') {
      const t = setTimeout(onComplete, 900);
      return () => clearTimeout(t);
    }
  }, [state, restState, onComplete]);

  // Cleanup: cancel any in-flight reader action when this screen unmounts
  useEffect(() => () => {
    pollAbortRef.current = true;
    if (paymentIntentId && (restState === 'collecting' || restState === 'starting')) {
      // Best-effort cancel — don't await
      callCancelReaderAction({ paymentIntentId, readerId: networkReader?.stripe_reader_id, locationId: platformLocId })
        .catch(() => {});
    }
  }, []);

  // ─── REST flow runner ──────────────────────────────────────────────────
  const runRestFlow = async () => {
    setRestState('starting');
    setRestStatusMsg('Pushing cart to reader…');
    setErrorMsg(null);

    try {
      // Build line items for set_reader_display
      const lineItems = (items ?? [])
        .filter(it => it && it.price != null)
        .map(it => ({
          description: String(it.name || it.title || 'Item').slice(0, 60),
          amount: Math.round(Number(it.price) * 100),
          quantity: Math.max(1, Math.round(Number(it.qty || it.quantity || 1))),
        }));
      // Tip line if applicable
      if (tipAmt && tipAmt > 0) {
        lineItems.push({ description: 'Tip', amount: Math.round(tipAmt * 100), quantity: 1 });
      }

      const opsDeviceId = (() => {
        try { return localStorage.getItem('rpos-device') || ''; } catch { return ''; }
      })();
      if (!opsDeviceId) throw new Error('POS device id missing — run BO setup');

      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('not authenticated');

      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-process-payment-on-reader`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          pos_device_id: opsDeviceId,
          amount_minor: Math.round(grand * 100),
          currency: 'gbp',                                              // TODO: read from location.currency
          line_items: lineItems,
        }),
      });
      const j = await res.json();
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
        const { data: session } = await supabase.auth.getSession();
        const token = session?.session?.access_token;
        const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-poll-reader-action`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
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
    onBack();
  };

  // ─── BT bridge flow (unchanged) ────────────────────────────────────────
  const runCollect = async () => {
    setErrorMsg(null);
    setState('collecting');
    setStatusMsg('Tap, insert or swipe card');
    try {
      const opsLocationId = getActiveLocationSync();
      if (!opsLocationId) throw new Error('No active location');
      const platformLocationId = await resolvePlatformLocationId(opsLocationId);
      if (!platformLocationId) throw new Error('Could not resolve Platform DB location id (location not registered for billing)');

      const amountMinor = Math.round(grand * 100);
      const result = await terminalCollect({
        amountMinor,
        currency: 'gbp',
        locationId: platformLocationId,
        channel: 'card_present',
      });
      setPiResult(result);
      const s = (result?.status || '').toLowerCase();
      if (s === 'succeeded' || s === 'requires_capture') {
        setState('approved');
      } else {
        setState('error');
        setErrorMsg(`Unexpected status: ${result?.status || 'unknown'}`);
      }
    } catch (e) {
      setState('error');
      setErrorMsg(e.message || String(e));
    }
  };

  // ─── Render ────────────────────────────────────────────────────────────
  // Prioritise REST flow when a network reader is assigned
  const useRest = !!networkReader;

  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', textAlign:'center' }}>
      {/* REST flow: starting / collecting */}
      {useRest && (restState === 'starting' || restState === 'collecting' || restState === 'cancelling') && (
        <RestCardWaiting
          grand={grand}
          readerLabel={networkReader.label || networkReader.stripe_reader_id}
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

      {/* No network reader, no bridge → simulated */}
      {!useRest && !bridgePresent && state==='waiting' && (
        <SimulatedCardWaiting grand={grand} onSimulate={() => setState('approved')} onBack={onBack} />
      )}

      {/* Bridge present, no BT reader and no network reader → "no reader" message */}
      {!useRest && bridgePresent && bridgeReady && !hasReader && (
        <div style={{ padding:'24px 8px' }}>
          <div style={{ fontSize:32, marginBottom:8 }}>💳</div>
          <div style={{ fontSize:17, fontWeight:800, color:'var(--t1)', marginBottom:6 }}>No card reader available</div>
          <div style={{ fontSize:13, color:'var(--t3)', marginBottom:16, maxWidth:340, margin:'0 auto 16px' }}>
            Either pair a Bluetooth reader to this terminal, or have an admin assign a network reader (BBPOS WisePOS E, S700) in <strong style={{ color:'var(--acc)' }}>Back office → Card readers</strong>.
          </div>
          <button className="btn btn-ghost" style={{ height:46, padding:'0 22px' }} onClick={onBack}>← Back</button>
        </div>
      )}

      {/* BT bridge active flow */}
      {!useRest && bridgePresent && hasReader && state!=='approved' && state!=='error' && (
        <>
          <RealCardWaiting grand={grand} readerLabel={readerLabel} statusMsg={statusMsg} state={state}/>
          <div style={{ display:'flex', gap:8, width:'100%', marginTop:16 }}>
            <button className="btn btn-ghost" style={{ flex:1, height:46 }} onClick={onBack}>← Cancel</button>
          </div>
        </>
      )}

      {!useRest && state==='error' && (
        <div style={{ padding:'20px 8px', textAlign:'center' }}>
          <div style={{ fontSize:48, marginBottom:8 }}>⚠️</div>
          <div style={{ fontSize:18, fontWeight:800, color:'var(--red)', marginBottom:6 }}>Payment failed</div>
          <div style={{ fontSize:13, color:'var(--t2)', marginBottom:16, maxWidth:380, margin:'0 auto 16px' }}>
            {errorMsg || 'Unknown error'}
          </div>
          <div style={{ display:'flex', gap:8, justifyContent:'center' }}>
            <button className="btn btn-ghost" style={{ height:46, padding:'0 22px' }} onClick={onBack}>← Back</button>
            {bridgePresent && hasReader && (
              <button className="btn btn-grn" style={{ height:46, padding:'0 22px' }}
                onClick={() => { startedRef.current = false; setState('waiting'); }}>
                Retry
              </button>
            )}
          </div>
        </div>
      )}

      {!useRest && state==='approved' && <ApprovedView grand={grand}/>}
    </div>
  );
}

async function callCancelReaderAction({ paymentIntentId, readerId, locationId }) {
  const { data: session } = await supabase.auth.getSession();
  const token = session?.session?.access_token;
  if (!token) throw new Error('not authenticated');
  const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/stripe-cancel-reader-action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ payment_intent_id: paymentIntentId, reader_id: readerId, location_id: locationId }),
  });
  const j = await res.json();
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
          £{Number(grand).toFixed(2)} on {readerLabel}
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
      <div style={{ fontSize:14, color:'var(--t2)' }}>£{Number(grand).toFixed(2)} charged</div>
    </div>
  );
}

function RealCardWaiting({ grand, readerLabel, statusMsg }) {
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
        £{grand.toFixed(2)}
      </div>
      <div style={{ fontSize:15, color:'var(--t2)', fontWeight:600, marginBottom:4 }}>{statusMsg}</div>
      <div style={{ fontSize:12, color:'var(--t4)', marginBottom:8 }}>{readerLabel}</div>
      <div style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 20px', background:'var(--acc-d)', border:'1px solid var(--acc-b)', borderRadius:22, fontSize:12, color:'var(--acc)', fontWeight:700, marginBottom:24 }}>
        <div style={{ width:7,height:7,borderRadius:'50%',background:'var(--acc)',animation:'pulse 1.4s ease-in-out infinite'}}/>
        Reader is live
      </div>
    </>
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
        £{grand.toFixed(2)}
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
  const change   = Math.max(0, tendered - grand);
  const isValid  = tendered >= grand;

  const press = (d) => {
    if (d==='⌫') { setEntered(p=>p.slice(0,-1)); return; }
    if (d==='.' && entered.includes('.')) return;
    if (entered.includes('.') && entered.split('.')[1]?.length>=2) return;
    if (entered.length >= 7) return;
    setEntered(p=>p+d);
  };

  const quickAmounts = [
    ...([5,10,20,50].filter(n=>n>=grand)),
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
            <div style={{ fontSize:compact?22:30, fontWeight:800, color:'var(--t1)', fontFamily:'var(--font-mono)', letterSpacing:'-.01em' }}>£{grand.toFixed(2)}</div>
          </div>
          <div style={{ textAlign:'right' }}>
            <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'.08em', marginBottom:3,
              color:isValid?'var(--grn)':entered?'var(--red)':'var(--t4)' }}>
              {isValid?'Change':'Short by'}
            </div>
            <div style={{ fontSize:compact?22:30, fontWeight:800, fontFamily:'var(--font-mono)', letterSpacing:'-.01em',
              color:isValid?'var(--grn)':entered?'var(--red)':'var(--t4)' }}>
              {isValid?`£${change.toFixed(2)}`:entered?`£${(grand-tendered).toFixed(2)}`:'—'}
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
            {entered ? `£${tendered.toFixed(2)}` : '£—'}
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
          }}>£{a}</button>
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
          {isValid ? `Complete · £${change.toFixed(2)} change` : 'Enter cash amount'}
        </button>
      </div>
    </div>
  );
}

// ─── Main checkout modal ──────────────────────────────────────────────────────
export default function CheckoutModal({ items, subtotal, service, total, orderType, covers, tableId, tabName, onClose, onComplete }) {
  const compact = useCompact();
  const { taxRates, deviceConfig, myDrawer } = useStore();
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

  const isBarTab = orderType==='bar-tab';
  const skipTip  = isBarTab || orderType==='takeaway' || orderType==='collection';
  const grand    = total + tipAmt;

  // Calculate tax breakdown
  const taxBreakdown = useMemo(() => {
    if (!taxRates?.length) return null;
    try { return calculateOrderTax(items?.filter(i=>!i.voided)||[], taxRates, orderType); } catch { return null; }
  }, [items, taxRates, orderType]);
  const hasTax = taxBreakdown?.breakdown?.length > 0;
  const hasExclusive = taxBreakdown?.hasExclusiveTax;

  const complete = (method, tip=tipAmt, tendered=null) => {
    onComplete({ method: method, tip, grand: total+tip, tendered, printReceipt });
  };

  const handleCardPress = () => {
    if (skipTip) setScreen('card_terminal');
    else setScreen('card_tip');
  };

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
  const showCourses = courseNums.length > 1;

  const contextLabel = isBarTab ? `Bar tab · ${tabName}`
    : tableId ? `${tableId.replace(/^[tbp]/,'')} · ${orderType}${covers>1?` · ${covers} covers`:''}`
    : orderType;

  const SCREENS = {
    review:'Checkout', card_tip:'Gratuity',
    card_terminal:'Card payment', cash:'Cash payment',
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
            {screen!=='review' && (
              <button className="btn btn-ghost btn-sm" onClick={()=>setScreen('review')}>← Back</button>
            )}
            <button onClick={onClose} style={{ width:32, height:32, borderRadius:9, border:'1px solid var(--bdr2)', background:'transparent', color:'var(--t3)', cursor:'pointer', fontFamily:'inherit', fontSize:18, display:'flex', alignItems:'center', justifyContent:'center' }}>×</button>
          </div>
        </div>

        <div style={{ flex:1, overflowY:'auto', padding:compact?'10px 14px':'18px 20px' }}>

          {/* ══ REVIEW ══════════════════════════════════════════════ */}
          {screen==='review' && (
            <>
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
                            {m.price>0&&<span style={{ color:'var(--acc)', marginLeft:6, fontFamily:'var(--font-mono)' }}>+£{m.price.toFixed(2)}</span>}
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
                        <div style={{ fontSize:namesOnly?11:compact?12:14, fontWeight:namesOnly?500:700, color:namesOnly?'var(--t3)':'var(--t1)', fontFamily:'var(--font-mono)' }}>£{(price*item.qty).toFixed(2)}</div>
                        {!namesOnly && disc && <div style={{ fontSize:11, color:'var(--t4)', textDecoration:'line-through', fontFamily:'var(--font-mono)' }}>£{(item.price*item.qty).toFixed(2)}</div>}
                      </div>
                    </div>
                  );
                    })}
                  </div>
                ))}
              </div>

              {/* Totals */}
              <div style={{ background:'var(--bg3)', borderRadius:compact?10:14, padding:compact?'10px 12px':'14px 16px', marginBottom:compact?12:20, border:'1px solid var(--bdr)' }}>
                {hasTax && hasExclusive ? (
                  // US exclusive — show net, then tax lines, then total
                  <>
                    <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, color:'var(--t3)', marginBottom:4 }}>
                      <span>Subtotal (ex. tax)</span>
                      <span style={{ fontFamily:'var(--font-mono)' }}>£{taxBreakdown.subtotal.toFixed(2)}</span>
                    </div>
                    {taxBreakdown.breakdown.map(b => {
                      const pct = (b.rate.rate*100).toFixed(3).replace(/\.?0+$/,'');
                      return <div key={b.rate.id} style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--t3)', marginBottom:4 }}>
                        <span>{b.rate.name} ({pct}%)</span>
                        <span style={{ fontFamily:'var(--font-mono)' }}>£{b.tax.toFixed(2)}</span>
                      </div>;
                    })}
                  </>
                ) : (
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, color:'var(--t3)', marginBottom: hasTax ? 2 : 5 }}>
                    <span>Subtotal{hasTax ? ' (incl. VAT)' : ''}</span>
                    <span style={{ fontFamily:'var(--font-mono)' }}>£{subtotal.toFixed(2)}</span>
                  </div>
                )}
                {hasTax && !hasExclusive && taxBreakdown.breakdown.map(b => {
                  const pct = (b.rate.rate*100).toFixed(1).replace('.0','');
                  return <div key={b.rate.id} style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'var(--t4)', marginBottom:4 }}>
                    <span>  of which {b.rate.name} ({pct}%)</span>
                    <span style={{ fontFamily:'var(--font-mono)' }}>£{b.tax.toFixed(2)}</span>
                  </div>;
                })}
                {service > 0 ? (
                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:13, color:'var(--t3)', marginBottom:5 }}>
                    <span>Service charge</span>
                    <span style={{ fontFamily:'var(--font-mono)' }}>£{service.toFixed(2)}</span>
                  </div>
                ) : orderType === 'dine-in' ? (
                  <div style={{ fontSize:12, color:'var(--t4)', marginBottom:5 }}>
                    No service charge
                  </div>
                ) : null}
                <div style={{ height:1, background:'var(--bdr)', margin:'8px 0' }}/>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
                  <span style={{ fontSize:15, fontWeight:600, color:'var(--t2)' }}>Total due</span>
                  <span style={{ fontSize:compact?20:26, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)', letterSpacing:'-.02em' }}>£{total.toFixed(2)}</span>
                </div>
              </div>

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
              <div style={{ display:'flex', gap:10, marginBottom:10 }}>
                <button onClick={handleCardPress} style={{
                  flex:1, padding:compact?'12px 10px':'22px 14px', borderRadius:compact?12:18, cursor:'pointer', fontFamily:'inherit',
                  background:'var(--card-bg)', border:`1.5px solid var(--card-border)`,
                  display:'flex', flexDirection:'column', alignItems:'center', gap:8,
                  transition:'transform .14s, box-shadow .14s',
                }}
                onMouseEnter={e=>{e.currentTarget.style.transform='translateY(-2px)';e.currentTarget.style.boxShadow='var(--sh2)';}}
                onMouseLeave={e=>{e.currentTarget.style.transform='';e.currentTarget.style.boxShadow='';}}>
                  <div style={{ fontSize:compact?24:36 }}>💳</div>
                  <div style={{ fontSize:compact?13:17, fontWeight:800, color:'var(--card-text)' }}>Card</div>
                  <div style={{ fontSize:11, color:'var(--card-sub)' }}>Tap, chip, contactless</div>
                  {!skipTip && <div style={{ fontSize:10, color:'var(--card-sub)', opacity:.7, marginTop:-2 }}>Tip step included</div>}
                </button>

                {_canTakeCash && <button onClick={()=>setScreen('cash')} style={{
                  flex:1, padding:compact?'12px 10px':'22px 14px', borderRadius:compact?12:18, cursor:'pointer', fontFamily:'inherit',
                  background:'var(--cash-bg)', border:`1.5px solid var(--cash-border)`,
                  display:'flex', flexDirection:'column', alignItems:'center', gap:8,
                  transition:'transform .14s, box-shadow .14s',
                }}
                onMouseEnter={e=>{e.currentTarget.style.transform='translateY(-2px)';e.currentTarget.style.boxShadow='var(--sh2)';}}
                onMouseLeave={e=>{e.currentTarget.style.transform='';e.currentTarget.style.boxShadow='';}}>
                  <div style={{ fontSize:compact?24:36 }}>💵</div>
                  <div style={{ fontSize:compact?13:17, fontWeight:800, color:'var(--cash-text)' }}>Cash</div>
                  <div style={{ fontSize:11, color:'var(--cash-sub)' }}>Change calculated</div>
                  <div style={{ fontSize:10, color:'var(--cash-sub)', opacity:.7, marginTop:-2 }}>Instant, no tip prompt</div>
                </button>}
              </div>

              {/* Split — secondary */}
              <button onClick={()=>setShowSplit(true)} style={{
                width:'100%', padding:'13px', borderRadius:13, cursor:'pointer', fontFamily:'inherit',
                background:'var(--bg3)', border:'1.5px solid var(--bdr2)',
                display:'flex', alignItems:'center', justifyContent:'center', gap:10,
                color:'var(--t3)', fontSize:13, fontWeight:600, transition:'all .14s',
              }}
              onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--acc-b)';e.currentTarget.style.color='var(--acc)';}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--bdr2)';e.currentTarget.style.color='var(--t3)';}}>
                <span>⚖</span>
                Split check · {covers} {covers===1?'guest':'guests'}
              </button>
            </>
          )}

          {screen==='card_tip' && (
            <TipPicker total={total} onSelect={(tip)=>{ setTipAmt(tip); setScreen('card_terminal'); }}/>
          )}

          {screen==='card_terminal' && (
            <CardTerminal
              items={items}
              grand={grand}
              tipAmt={tipAmt}
              onComplete={()=>complete('card')}
              onBack={()=>setScreen(skipTip?'review':'card_tip')}
            />
          )}

          {screen==='cash' && (
            <CashTransaction
              grand={total}
              onComplete={(tendered)=>complete('cash', 0, tendered)}
              onBack={()=>setScreen('review')}
            />
          )}
        </div>
      </div>

      {showSplit && (
        <SplitModal
          items={items}
          total={total}
          covers={covers}
          onComplete={(portions)=>{ setShowSplit(false); onComplete({ method:'split', tip:0, grand:total, portions, printReceipt }); }}
          onClose={()=>setShowSplit(false)}
        />
      )}
    </div>
  );
}
