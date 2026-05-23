import { useCompact } from '../lib/useCompact';
import { useState, useEffect, useMemo, useRef } from 'react';
import { ALLERGENS } from '../data/seed';
import SplitModal from '../components/SplitModal';
import { useStore } from '../store';
import { calculateOrderTax } from '../lib/tax';
import {
  resolvePlatformLocationId,
  getAssignedNetworkReader,
} from '../lib/networkReader';
import { getActiveLocationSync, supabase, ensureAuthToken } from '../lib/supabase';
// (readerDisplay imports removed — cancel now lets the natural cart-change effect refresh the reader after onBack)

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

  // ─── REST flow: start payment when network reader is available ────────
  useEffect(() => {
    if (!networkReader || !platformLocId || restState !== 'idle' || startedRef.current) return;
    startedRef.current = true;
    runRestFlow();
  }, [networkReader, platformLocId, restState]);

  // Smooth transition to "approved" → call onComplete after brief moment.
  // v5.5.172: pass the captured PI through so the parent can derive the
  // ACTUAL reader-collected tip (amountReceived - base bill).
  useEffect(() => {
    if (state === 'approved' || restState === 'success') {
      const t = setTimeout(() => onComplete(piResult), 900);
      return () => clearTimeout(t);
    }
  }, [state, restState, onComplete, piResult]);

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
          currency: 'gbp',                                              // TODO: read from location.currency
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
    // v5.5.178: do NOT immediately push the cart back. The cancel needs
    // ~1-2 seconds to propagate to the reader; if we push the live cart
    // right after, the reader's "cancelling" transition gets overwritten
    // and from the cashier's POV nothing happened. Wait 2 seconds, THEN
    // the natural cart-change effect from going back to the review screen
    // will refresh the reader display.
    onBack();
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

      {/* No network reader assigned → simulated (browser dev / unconfigured devices) */}
      {!useRest && state==='waiting' && (
        <SimulatedCardWaiting grand={grand} onSimulate={() => setState('approved')} onBack={onBack} />
      )}

      {!useRest && state==='approved' && <ApprovedView grand={grand}/>}
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

// ─── Gift card entry (v5.5.193) ─────────────────────────────────────────────
const GIFT_FUNCTIONS_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1`;

function GiftCardEntry({ totalMinor, giftAlreadyApplied, onApplied, onBack, tableId, orderType }) {
  const compact = useCompact();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [cardInfo, setCardInfo] = useState(null); // looked-up card details
  const codeRef = useRef(null);

  useEffect(() => { codeRef.current?.focus(); }, []);

  // Step 1: look up the card to check balance and PIN requirement
  const handleLookup = async () => {
    if (code.replace(/[\s-]/g, '').length < 16) {
      setError('Enter the full 16 character code');
      return;
    }
    setError(null); setLoading(true); setCardInfo(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error('Not authenticated');
      const res = await fetch(`${GIFT_FUNCTIONS_URL}/gift-lookup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ code: code.replace(/[\s-]/g, ''), location_id: getActiveLocationSync() }),
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

  // Step 2: redeem
  const handleRedeem = async () => {
    if (!cardInfo) return;
    setError(null); setLoading(true);
    try {
      const alreadyApplied = giftAlreadyApplied?.applied || 0;
      const remainingDue = totalMinor - alreadyApplied;
      const redeemAmount = Math.min(cardInfo.balance, remainingDue);
      if (redeemAmount <= 0) { setError('Nothing to redeem'); setLoading(false); return; }

      const idempotencyKey = `pos:${tableId || 'walkin'}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;

      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      const res = await fetch(`${GIFT_FUNCTIONS_URL}/gift-redeem`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          code: code.replace(/[\s-]/g, ''),
          amount: redeemAmount,
          order_id: tableId || `walkin-${Date.now()}`,
          location_id: getActiveLocationSync(),
          channel: 'pos',
          idempotency_key: idempotencyKey,
        }),
      });
      const j = await res.json();
      if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);

      onApplied({
        card_id: j.card_id,
        code_last4: cardInfo.code_last4,
        applied: j.applied,
        remaining_balance: j.remaining_balance,
        idempotency_key: idempotencyKey,
        currency: j.currency || 'gbp',
      });
    } catch (e) {
      setError(String(e?.message ?? e));
    } finally {
      setLoading(false);
    }
  };

  const sym = String.fromCodePoint(0x00A3);
  const alreadyAppliedAmt = (giftAlreadyApplied?.applied || 0) / 100;
  const remainingDue = (totalMinor - (giftAlreadyApplied?.applied || 0)) / 100;

  return (
    <div>
      <div style={{ textAlign:'center', marginBottom:compact?12:20 }}>
        <div style={{ fontSize:compact?28:40, marginBottom:6 }}>{String.fromCodePoint(0x1F381)}</div>
        <div style={{ fontSize:compact?18:24, fontWeight:800, color:'var(--t1)' }}>
          {sym}{remainingDue.toFixed(2)} due
        </div>
        {alreadyAppliedAmt > 0 && (
          <div style={{ fontSize:12, color:'var(--grn)', marginTop:4 }}>
            {sym}{alreadyAppliedAmt.toFixed(2)} already applied from gift card
          </div>
        )}
      </div>

      {/* Code entry */}
      {!cardInfo && (
        <div>
          <label style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6, display:'block' }}>
            Gift card code
          </label>
          <input
            ref={codeRef}
            type="text"
            value={code}
            onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z2-9\s-]/g, ''))}
            placeholder="ABCD EFGH JKLM NPQR"
            maxLength={19}
            style={{
              width:'100%', padding:'12px 14px', borderRadius:12,
              border:'2px solid var(--bdr2)', background:'var(--bg2)', color:'var(--t1)',
              fontSize:18, fontFamily:'var(--font-mono, monospace)', letterSpacing:'0.15em',
              textAlign:'center', outline:'none', boxSizing:'border-box',
            }}
            onKeyDown={e => e.key === 'Enter' && handleLookup()}
          />
          <button
            onClick={handleLookup}
            disabled={loading || code.replace(/[\s-]/g, '').length < 16}
            style={{
              width:'100%', marginTop:12, padding:'14px', borderRadius:12,
              border:'none', cursor:'pointer', fontFamily:'inherit',
              background:'var(--acc)', color:'#0b0c10', fontSize:15, fontWeight:800,
              opacity: loading || code.replace(/[\s-]/g, '').length < 16 ? 0.5 : 1,
            }}
          >
            {loading ? 'Checking...' : 'Look up card'}
          </button>
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
            onClick={handleRedeem}
            disabled={loading}
            style={{
              width:'100%', marginTop:14, padding:'14px', borderRadius:12,
              border:'none', cursor:'pointer', fontFamily:'inherit',
              background:'var(--acc)', color:'#0b0c10', fontSize:15, fontWeight:800,
              opacity: loading ? 0.5 : 1,
            }}
          >
            {loading ? 'Processing...' : `Apply ${sym}${(Math.min(cardInfo.balance, Math.round(remainingDue * 100)) / 100).toFixed(2)} from gift card`}
          </button>

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

  // v5.5.193: gift card partial payment state
  const [giftApplied, setGiftApplied] = useState(null);
  // giftApplied: { card_id, code_last4, applied, remaining_balance, idempotency_key, currency }

  const isBarTab = orderType==='bar-tab';
  const skipTip  = isBarTab || orderType==='takeaway' || orderType==='collection';
  const giftCredit = giftApplied?.applied ? giftApplied.applied / 100 : 0;
  const grand    = Math.max(0, total + tipAmt - giftCredit);

  // Calculate tax breakdown
  const taxBreakdown = useMemo(() => {
    if (!taxRates?.length) return null;
    try { return calculateOrderTax(items?.filter(i=>!i.voided)||[], taxRates, orderType); } catch { return null; }
  }, [items, taxRates, orderType]);
  const hasTax = taxBreakdown?.breakdown?.length > 0;
  const hasExclusive = taxBreakdown?.hasExclusiveTax;

  const complete = (method, tip=tipAmt, tendered=null) => {
    onComplete({
      method: giftApplied && grand > 0 ? `gift_card+${method}` : giftApplied ? 'gift_card' : method,
      tip,
      grand: total+tip,
      tendered,
      printReceipt,
      giftCard: giftApplied || undefined,
    });
  };

  // v5.5.172: tipping is collected ON THE READER for card payments — Stripe
  // Terminal Configuration handles the % / custom / no-tip prompt customer-
  // side. The POS no longer pre-collects a tip. Goes straight from review
  // to card_terminal. The actual tip the customer chose comes back via the
  // payment intent's amount_received and is reflected in `complete()` below.
  const handleCardPress = () => {
    setScreen('card_terminal');
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
    gift_card:'Gift card',
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
                dismissing the modal while the customer is mid-tap. */}
            {screen!=='review' && screen!=='card_terminal' && (
              <button className="btn btn-ghost btn-sm" onClick={()=>setScreen('review')}>← Back</button>
            )}
            {screen!=='card_terminal' && (
              <button onClick={onClose} style={{ width:32, height:32, borderRadius:9, border:'1px solid var(--bdr2)', background:'transparent', color:'var(--t3)', cursor:'pointer', fontFamily:'inherit', fontSize:18, display:'flex', alignItems:'center', justifyContent:'center' }}>×</button>
            )}
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
                  <span style={{ fontSize:15, fontWeight:600, color:'var(--t2)' }}>{giftApplied ? 'Subtotal' : 'Total due'}</span>
                  <span style={{ fontSize:giftApplied?(compact?16:18):(compact?20:26), fontWeight:800, color:giftApplied?'var(--t2)':'var(--acc)', fontFamily:'var(--font-mono)', letterSpacing:'-.02em' }}>{String.fromCodePoint(0x00A3)}{total.toFixed(2)}</span>
                </div>
                {giftApplied && (
                  <>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginTop:4 }}>
                      <span style={{ fontSize:13, color:'var(--grn)', fontWeight:600 }}>{String.fromCodePoint(0x1F381)} Gift card (...{giftApplied.code_last4})</span>
                      <span style={{ fontSize:14, fontWeight:700, color:'var(--grn)', fontFamily:'var(--font-mono)' }}>{String.fromCodePoint(0x2212)}{String.fromCodePoint(0x00A3)}{giftCredit.toFixed(2)}</span>
                    </div>
                    <div style={{ height:1, background:'var(--bdr)', margin:'6px 0' }}/>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline' }}>
                      <span style={{ fontSize:15, fontWeight:700, color:'var(--t1)' }}>Remaining due</span>
                      <span style={{ fontSize:compact?20:26, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)', letterSpacing:'-.02em' }}>{String.fromCodePoint(0x00A3)}{grand.toFixed(2)}</span>
                    </div>
                  </>
                )}
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
                  {/* v5.5.172: tip prompt is now ON THE READER, not on POS */}
                  <div style={{ fontSize:10, color:'var(--card-sub)', opacity:.7, marginTop:-2 }}>Tip prompt on reader</div>
                </button>

                {_canTakeCash && <button onClick={()=>setScreen('cash')} style={{
                  flex:1, padding:compact?'12px 10px':'22px 14px', borderRadius:compact?12:18, cursor:'pointer', fontFamily:'inherit',
                  background:'var(--cash-bg)', border:`1.5px solid var(--cash-border)`,
                  display:'flex', flexDirection:'column', alignItems:'center', gap:8,
                  transition:'transform .14s, box-shadow .14s',
                }}
                onMouseEnter={e=>{e.currentTarget.style.transform='translateY(-2px)';e.currentTarget.style.boxShadow='var(--sh2)';}}
                onMouseLeave={e=>{e.currentTarget.style.transform='';e.currentTarget.style.boxShadow='';}}>
                  <div style={{ fontSize:compact?24:36 }}>{String.fromCodePoint(0x1F4B5)}</div>
                  <div style={{ fontSize:compact?13:17, fontWeight:800, color:'var(--cash-text)' }}>Cash</div>
                  <div style={{ fontSize:11, color:'var(--cash-sub)' }}>Change calculated</div>
                  <div style={{ fontSize:10, color:'var(--cash-sub)', opacity:.7, marginTop:-2 }}>Instant, no tip prompt</div>
                </button>}
              </div>

              {/* v5.5.193: Gift card button */}
              <button onClick={()=>setScreen('gift_card')} style={{
                width:'100%', padding:'13px', borderRadius:13, cursor:'pointer', fontFamily:'inherit',
                background:'var(--bg3)', border:'1.5px solid var(--bdr2)',
                display:'flex', alignItems:'center', justifyContent:'center', gap:10,
                color:'var(--t3)', fontSize:13, fontWeight:600, transition:'all .14s',
                marginBottom:10,
              }}
              onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--acc-b)';e.currentTarget.style.color='var(--acc)';}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--bdr2)';e.currentTarget.style.color='var(--t3)';}}>
                <span>{String.fromCodePoint(0x1F381)}</span>
                {giftApplied
                  ? `Gift card applied: ${String.fromCodePoint(0x00A3)}${giftCredit.toFixed(2)} (${String.fromCodePoint(0x00A3)}${grand.toFixed(2)} remaining)`
                  : 'Pay with gift card'}
              </button>

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
              onComplete={(pi)=>{
                // v5.5.172: derive the real reader-collected tip from the
                // captured PaymentIntent. amountReceived = (base + tip).
                // Fall back to 0 if the simulated path (no reader) ran.
                const receivedMinor = pi?.amountReceived ?? null;
                const receivedGbp   = receivedMinor != null ? receivedMinor / 100 : null;
                const realTip = receivedGbp != null ? Math.max(0, +(receivedGbp - total).toFixed(2)) : 0;
                complete('card', realTip);
              }}
              onBack={()=>setScreen('review')}
            />
          )}

          {screen==='cash' && (
            <CashTransaction
              grand={total}
              onComplete={(tendered)=>complete('cash', 0, tendered)}
              onBack={()=>setScreen('review')}
            />
          )}

          {screen==='gift_card' && (
            <GiftCardEntry
              totalMinor={Math.round((total + tipAmt) * 100)}
              giftAlreadyApplied={giftApplied}
              onApplied={(result) => {
                setGiftApplied(result);
                const remainingDue = Math.round((total + tipAmt) * 100) - result.applied;
                if (remainingDue <= 0) {
                  // Gift card covers full amount
                  complete('gift_card', tipAmt);
                } else {
                  // Partial: go back to review to pay remainder
                  setScreen('review');
                }
              }}
              onBack={()=>setScreen('review')}
              tableId={tableId}
              orderType={orderType}
            />
          )}
        </div>
      </div>

      {showSplit && (
        <SplitModal
          items={items}
          total={total}
          covers={covers}
          canTakeCash={_canTakeCash}
          onComplete={(portions)=>{ setShowSplit(false); onComplete({ method:'split', tip:0, grand:total, portions, printReceipt }); }}
          onClose={()=>setShowSplit(false)}
        />
      )}
    </div>
  );
}
