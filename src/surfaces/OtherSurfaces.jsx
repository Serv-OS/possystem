import { useState, useEffect } from 'react';
import { useStore } from '../store';
import { VERSION } from '../lib/version';
import { supabase, isMock } from '../lib/supabase';
import { money, currencySymbol } from '../lib/currency';
// v5.7.34 rate-null guards: per-unit tax lines book rate: null in the breakdown
import { breakdownLabel } from '../lib/receiptTax';
// ══════════════════════════════════════════════════════════════════════════════
// Payment Screen
// ══════════════════════════════════════════════════════════════════════════════
export function PaymentScreen({ subtotal, service, total, items, taxBreakdown, onClose, onComplete }) {
  const [step, setStep] = useState('tip');
  const [tipPct, setTipPct] = useState(12.5);
  const [customTip, setCustomTip] = useState('');
  const [method, setMethod] = useState(null);
  const [cash, setCash] = useState('');
  const [splits, setSplits] = useState(2);

  const tipAmt  = customTip !== '' ? parseFloat(customTip)||0 : subtotal * tipPct/100;
  const grand   = total + tipAmt;
  const change  = cash ? Math.max(0, parseFloat(cash) - grand) : 0;

  // Tax display — use breakdown if provided, otherwise skip
  const hasTax = taxBreakdown?.breakdown?.length > 0 || taxBreakdown?.totalTax > 0;
  const hasExclusive = taxBreakdown?.hasExclusiveTax;

  const S = (s) => (
    <div style={{
      padding:'8px 16px', borderRadius:8, cursor:'pointer', fontSize:12, fontWeight:500,
      border:`1px solid ${step===s?'var(--acc-b)':'var(--bdr)'}`,
      background: step===s?'var(--acc-d)':'transparent',
      color: step===s?'var(--acc)':'var(--t3)',
    }} onClick={() => setStep(s)}>{s.charAt(0).toUpperCase()+s.slice(1)}</div>
  );

  return (
    <div className="modal-back">
      <div style={{
        background:'var(--bg2)', border:'1px solid var(--bdr2)',
        borderRadius:24, width:'100%', maxWidth:460,
        maxHeight:'90vh', overflow:'auto', padding:24, boxShadow:'var(--sh3)',
      }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
          <div style={{ fontSize:18, fontWeight:600 }}>Checkout</div>
          <div style={{ display:'flex', gap:8 }}>
            {step!=='tip'&&<button className="btn btn-ghost btn-sm" onClick={()=>setStep('tip')}>← Back</button>}
            <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          </div>
        </div>

        {/* Order summary line */}
        <div style={{ background:'var(--bg3)', borderRadius:10, padding:'10px 14px', marginBottom:18 }}>
          <div style={{ fontSize:12, color:'var(--t3)', marginBottom:6 }}>{items.length} item{items.length!==1?'s':''}</div>
          {items.map(i => (
            <div key={i.uid} style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--t2)', marginBottom:2 }}>
              <span>{i.qty}× {i.name}</span><span>{money((i.price*i.qty))}</span>
            </div>
          ))}
          <div className="divider"/>
          {hasTax && hasExclusive ? (
            // US exclusive: show net subtotal, then tax, then total
            <>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--t3)' }}><span>Subtotal (ex. tax)</span><span>{money(taxBreakdown.subtotal)}</span></div>
              {taxBreakdown.breakdown.map((b, i) => (
                <div key={b.rate?.id ?? `pu-${i}`} style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--t3)', marginTop:2 }}><span>{breakdownLabel(b, 3)}</span><span>{money(b.tax)}</span></div>
              ))}
            </>
          ) : hasTax ? (
            // UK inclusive: show gross subtotal, then VAT breakdown
            <>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--t3)' }}><span>Subtotal (incl. VAT)</span><span>{money(subtotal)}</span></div>
              {taxBreakdown.breakdown.map((b, i) => (
                <div key={b.rate?.id ?? `pu-${i}`} style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'var(--t4)', marginTop:1 }}><span>  of which {breakdownLabel(b, 1)}</span><span>{money(b.tax)}</span></div>
              ))}
            </>
          ) : (
            <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--t3)' }}><span>Subtotal</span><span>{money(subtotal)}</span></div>
          )}
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--t3)', marginTop:2 }}><span>Service 12.5%</span><span>{money(service)}</span></div>
        </div>

        {/* Tip step */}
        {step === 'tip' && (
          <>
            <div style={{ fontSize:14, fontWeight:500, marginBottom:14 }}>Add a tip?</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:6, marginBottom:14 }}>
              {[0,10,12.5,15,20].map(p => (
                <button key={p} onClick={() => { setTipPct(p); setCustomTip(''); }} style={{
                  padding:'10px 4px', borderRadius:10, cursor:'pointer', textAlign:'center',
                  border:`1.5px solid ${tipPct===p&&customTip===''?'var(--acc)':'var(--bdr)'}`,
                  background: tipPct===p&&customTip===''?'var(--acc-d)':'var(--bg3)',
                  transition:'all .12s', fontFamily:'inherit',
                }}>
                  <div style={{ fontSize:13, fontWeight:600, color:tipPct===p&&customTip===''?'var(--acc)':'var(--t1)' }}>{p}%</div>
                  <div style={{ fontSize:10, color:'var(--t3)', marginTop:2 }}>{money((subtotal*p/100))}</div>
                </button>
              ))}
            </div>
            <div style={{ marginBottom:18 }}>
              <div style={{ fontSize:11, color:'var(--t3)', marginBottom:6 }}>Custom amount</div>
              <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                <span style={{ color:'var(--t3)', fontSize:18 }}>£</span>
                <input className="input" type="number" placeholder="0.00" value={customTip}
                  onChange={e => { setCustomTip(e.target.value); setTipPct(null); }}/>
              </div>
            </div>
            <div style={{ background:'var(--bg3)', borderRadius:10, padding:'12px 14px', marginBottom:18 }}>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--t3)', marginBottom:4 }}><span>Bill</span><span>{money(total)}</span></div>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--t3)', marginBottom:4 }}><span>Tip</span><span>{money(tipAmt)}</span></div>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:18, fontWeight:700, marginTop:8, paddingTop:8, borderTop:'1px solid var(--bdr)' }}><span>Grand total</span><span style={{color:'var(--acc)'}}>{money(grand)}</span></div>
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <button className="btn btn-ghost" style={{flex:1}} onClick={() => setStep('split')}>Split check</button>
              <button className="btn btn-acc" style={{flex:2}} onClick={() => setStep('method')}>Choose payment →</button>
            </div>
          </>
        )}

        {/* Method step */}
        {step === 'method' && (
          <>
            <div style={{ fontSize:17, fontWeight:700, marginBottom:4 }}>{money(grand)} due</div>
            <div style={{ fontSize:12, color:'var(--t3)', marginBottom:20 }}>Includes {money(tipAmt)} tip</div>
            {[
              { id:'card', icon:'💳', label:'Card payment', sub:'Stripe Terminal · tap, chip or swipe' },
              { id:'cash', icon:'💵', label:'Cash payment', sub:'Enter tendered amount and calculate change' },
            ].map(m => (
              <div key={m.id} style={{
                padding:16, background:'var(--bg3)', borderRadius:12, cursor:'pointer',
                border:`1px solid var(--bdr)`, display:'flex', alignItems:'center', gap:14, marginBottom:8,
                transition:'all .12s',
              }}
              onMouseEnter={e=>e.currentTarget.style.borderColor='var(--acc-b)'}
              onMouseLeave={e=>e.currentTarget.style.borderColor='var(--bdr)'}
              onClick={() => setStep(m.id)}>
                <div style={{ fontSize:26 }}>{m.icon}</div>
                <div><div style={{fontWeight:500}}>{m.label}</div><div style={{fontSize:12,color:'var(--t3)',marginTop:2}}>{m.sub}</div></div>
              </div>
            ))}
          </>
        )}

        {/* Card */}
        {step === 'card' && (
          <div style={{ textAlign:'center', padding:'32px 0' }}>
            <div style={{ fontSize:56, marginBottom:20 }}>💳</div>
            <div style={{ fontSize:24, fontWeight:700, marginBottom:8 }}>{money(grand)}</div>
            <div style={{ fontSize:13, color:'var(--t3)', marginBottom:32 }}>Present card to Stripe Reader S700</div>
            <div style={{
              display:'inline-flex', alignItems:'center', gap:8, padding:'10px 20px',
              background:'var(--acc-d)', border:'1px solid var(--acc-b)',
              borderRadius:20, fontSize:13, color:'var(--acc)', marginBottom:32,
            }}>
              <div style={{width:8,height:8,borderRadius:'50%',background:'var(--acc)',animation:'pulse 1.5s ease-in-out infinite'}}/>
              Waiting for card...
            </div>
            <br/>
            <button className="btn btn-grn btn-lg" onClick={onComplete}>Simulate payment ✓</button>
          </div>
        )}

        {/* Cash */}
        {step === 'cash' && (
          <>
            <div style={{ fontSize:16, fontWeight:600, marginBottom:20 }}>Cash · {money(grand)} due</div>
            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12 }}>
              <span style={{ fontSize:22, color:'var(--t3)' }}>£</span>
              <input className="input" type="number" placeholder="0.00" value={cash}
                onChange={e=>setCash(e.target.value)} style={{ fontSize:20, fontWeight:600, height:52 }}/>
            </div>
            <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:18 }}>
              {[5,10,20,50,Math.ceil(grand)].map(a=>(
                <button key={a} className="btn btn-ghost btn-sm" onClick={()=>setCash(String(a))}>{currencySymbol()}{a}</button>
              ))}
            </div>
            {cash && parseFloat(cash) >= grand && (
              <div style={{
                background:'var(--grn-d)', border:'1px solid var(--grn-b)',
                borderRadius:12, padding:'14px 18px', marginBottom:18,
                display:'flex', justifyContent:'space-between', alignItems:'center',
              }}>
                <span style={{ fontSize:14, color:'var(--grn)' }}>Change due</span>
                <span style={{ fontSize:26, fontWeight:700, color:'var(--grn)' }}>{money(change)}</span>
              </div>
            )}
            <button className="btn btn-grn btn-full btn-lg"
              disabled={!cash || parseFloat(cash) < grand}
              onClick={onComplete}>
              Complete cash payment
            </button>
          </>
        )}

        {/* Split */}
        {step === 'split' && (
          <>
            <div style={{ fontSize:15, fontWeight:500, marginBottom:18 }}>Split check evenly</div>
            <div style={{ display:'flex', gap:6, marginBottom:18 }}>
              {[2,3,4,5,6].map(n=>(
                <button key={n} onClick={()=>setSplits(n)} style={{
                  flex:1, padding:'10px 4px', borderRadius:10, cursor:'pointer', textAlign:'center',
                  border:`1.5px solid ${splits===n?'var(--acc)':'var(--bdr)'}`,
                  background: splits===n?'var(--acc-d)':'var(--bg3)',
                  fontFamily:'inherit',
                }}>
                  <div style={{fontSize:18,fontWeight:700,color:splits===n?'var(--acc)':'var(--t1)'}}>{n}</div>
                  <div style={{fontSize:10,color:'var(--t3)',marginTop:2}}>ways</div>
                </button>
              ))}
            </div>
            <div style={{ background:'var(--bg3)', borderRadius:12, padding:'14px 18px', marginBottom:18 }}>
              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:6 }}>
                <span style={{fontSize:13,color:'var(--t3)'}}>Total</span><span>{money(total)}</span>
              </div>
              <div style={{ display:'flex', justifyContent:'space-between' }}>
                <span style={{fontSize:15,fontWeight:500}}>Each person pays</span>
                <span style={{fontSize:24,fontWeight:700,color:'var(--acc)'}}>{money((total/splits))}</span>
              </div>
            </div>
            <button className="btn btn-grn btn-full btn-lg" onClick={onComplete}>Mark all paid ✓</button>
          </>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Tables Surface
// ══════════════════════════════════════════════════════════════════════════════
export function TablesSurface() {
  const { tables, updateTable, openTable, closeTable, showToast, setSurface, setTableId } = useStore();
  const [selId, setSelId] = useState(null);
  const sel = tables.find(t => t.id === selId);

  const STATUS = {
    available: { color:'var(--grn)',  label:'Available' },
    open:      { color:'var(--blu)',  label:'Open' },
    occupied:  { color:'var(--acc)',  label:'Occupied' },
    reserved:  { color:'#a855f7',  label:'Reserved' },
    cleaning:  { color:'var(--t3)',label:'Cleaning' },
  };

  const fmt = (mins) => {
    if (!mins) return '—';
    const m = parseInt(mins);
    return m >= 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m`;
  };

  const handleAction = (action) => {
    if (!sel) return;
    switch (action) {
      case 'open':     openTable(sel.id); showToast(`${sel.label} opened`, 'success'); break;
      case 'seat':     updateTable(sel.id,{status:'occupied',seated:0}); showToast(`${sel.label} seated`,'success'); break;
      case 'close':    closeTable(sel.id); showToast(`${sel.label} closed`,'info'); setSelId(null); break;
      case 'reserve':  updateTable(sel.id,{status:'reserved',reservation:'Next available'}); showToast(`${sel.label} reserved`,'info'); break;
      case 'view':     setTableId(sel.id); setSurface('pos'); break;
      case 'print':    showToast('Check printed to pass printer','info'); break;
      case 'transfer': showToast('Select destination table to transfer','info'); break;
    }
  };

  const sections = ['main','bar','patio'];
  const secLabel = { main:'Main dining', bar:'Bar', patio:'Patio' };

  return (
    <div style={{ display:'flex', flex:1, overflow:'hidden' }}>
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {/* Header */}
        <div style={{ height:52, display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 20px', borderBottom:'1px solid var(--bdr)', background:'var(--bg2)', flexShrink:0 }}>
          <div><div style={{fontSize:15,fontWeight:600}}>Floor plan</div><div style={{fontSize:11,color:'var(--t3)'}}>Live view · {new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</div></div>
          <div style={{ display:'flex', gap:16, fontSize:12, color:'var(--t3)' }}>
            {Object.entries(STATUS).map(([s,{color,label}])=>(
              <span key={s}><span style={{color}}>{tables.filter(t=>t.status===s).length}</span> {label}</span>
            ))}
          </div>
        </div>

        {/* Floor canvas */}
        <div style={{ flex:1, overflow:'auto', padding:16 }}>
          {/* Section labels + tables */}
          <div style={{ position:'relative', background:'var(--bg3)', border:'1px solid var(--bdr)', borderRadius:20, minHeight:320, marginBottom:16 }}>
            {sections.map(sec => (
              <div key={sec} style={{
                position:'absolute', fontSize:10, fontWeight:600, color:'var(--t3)',
                textTransform:'uppercase', letterSpacing:'.08em',
                left: sec==='main'?16: sec==='bar'?406:498,
                top: 14,
              }}>{secLabel[sec]}</div>
            ))}
            {tables.map(t => {
              const st = STATUS[t.status] || STATUS.available;
              const isSelected = selId === t.id;
              return (
                <div key={t.id} style={{
                  position:'absolute', left:t.x, top:t.y, width:t.w, height:t.h,
                  cursor:'pointer',
                }} onClick={() => setSelId(selId===t.id?null:t.id)}>
                  <div style={{
                    width:'100%', height:'100%',
                    borderRadius: t.shape==='rd'?'50%':'10px',
                    background: st.color+'14',
                    border:`2px solid ${isSelected?st.color:st.color+'44'}`,
                    boxShadow: isSelected?`0 0 0 3px ${st.color}33`:'none',
                    display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
                    gap:2, transition:'all .15s',
                  }}>
                    <div style={{ fontSize:11, fontWeight:700, color:st.color }}>{t.label}</div>
                    <div style={{ fontSize:9, color:st.color, opacity:.7 }}>
                      {t.status==='occupied'?fmt(t.seated):
                       t.status==='reserved'?t.reservation||'—':
                       t.status==='open'?'Ordering':
                       `${t.covers}cvr`}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Selected table detail */}
          {sel && (
            <div style={{ background:'var(--bg3)', border:'1px solid var(--bdr)', borderRadius:16, padding:18, animation:'slideUp .15s ease' }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
                <div style={{ fontSize:18, fontWeight:600 }}>{sel.label}</div>
                <span className={`badge badge-${sel.status==='available'?'grn':sel.status==='occupied'?'acc':sel.status==='open'?'blu':'pur'}`}>
                  {STATUS[sel.status]?.label}
                </span>
              </div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, marginBottom:14 }}>
                {[['Covers',sel.covers],['Seated',fmt(sel.seated)],['Check',sel.orderTotal!=null?`${money(sel.orderTotal)}`:'—'],['Server',sel.server||'—']].map(([k,v])=>(
                  <div key={k} style={{ background:'var(--bg4)', borderRadius:8, padding:'9px 10px' }}>
                    <div style={{ fontSize:10, color:'var(--t3)', marginBottom:3 }}>{k}</div>
                    <div style={{ fontSize:15, fontWeight:600 }}>{v}</div>
                  </div>
                ))}
              </div>
              <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                {sel.status==='available' && <>
                  <button className="btn btn-grn" onClick={()=>handleAction('open')}>Open table &amp; order</button>
                  <button className="btn btn-ghost" onClick={()=>handleAction('reserve')}>Reserve</button>
                </>}
                {sel.status==='reserved' && <>
                  <button className="btn btn-acc" onClick={()=>handleAction('seat')}>Seat now</button>
                  <button className="btn btn-ghost" onClick={()=>handleAction('close')}>Cancel reservation</button>
                </>}
                {(sel.status==='open'||sel.status==='occupied') && <>
                  <button className="btn btn-acc" onClick={()=>handleAction('view')}>View &amp; add to order</button>
                  <button className="btn btn-ghost" onClick={()=>handleAction('print')}>Print check</button>
                  <button className="btn btn-ghost" onClick={()=>handleAction('transfer')}>Transfer table</button>
                  <button className="btn btn-red" onClick={()=>handleAction('close')}>Close table</button>
                </>}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// KDS Surface
// ══════════════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════════════
// KDS Surface — redesigned
// ══════════════════════════════════════════════════════════════════════════════
// v5.5.913: mods arrive as plain strings from the till, but as OBJECTS from the catering
// release path. Rendering an object as a React child throws and the wall screen dies into an
// error page that survives reload — so coerce at every read site.
const modText = (m) => String(m?.name ?? m?.label ?? m ?? '').trim();

export function KDSSurface() {
  const { kdsTickets: storeTickets, bumpTicket, showToast, deviceConfig } = useStore();

  // Read device info from localStorage
  const pairedDevice = (() => { try { return JSON.parse(localStorage.getItem('rpos-device') || 'null'); } catch { return null; } })();
  const localDeviceConfig = (() => { try { return JSON.parse(localStorage.getItem('rpos-device-config') || 'null'); } catch { return null; } })();
  const kdsName = pairedDevice?.name || localDeviceConfig?.profileName || 'Kitchen display';
  const centreName = localDeviceConfig?.centreName || null;
  const locationId = pairedDevice?.locationId || null;
  const centreId = localDeviceConfig?.centreId || pairedDevice?.centreId || null;

  // Heartbeat — update last_seen every 60s so Status drawer shows correct KDS online state
  useEffect(() => {
    if (!pairedDevice?.id || isMock) return;
    const beat = async () => {
      try {
        const { updateDeviceHeartbeat } = await import('../lib/db.js');
        updateDeviceHeartbeat(pairedDevice.id);
      } catch {}
    };
    beat();
    const id = setInterval(beat, 60000);
    return () => clearInterval(id);
  }, [pairedDevice?.id]);

  // Local tickets state — loaded from Supabase + synced via realtime
  const [liveTickets, setLiveTickets] = useState(null);
  const [heldTickets, setHeldTickets] = useState([]);
  const [historyTickets, setHistoryTickets] = useState([]);
  const [showHistory, setShowHistory] = useState(false);
  const [, setTick] = useState(0);
  const [filter, setFilter] = useState(centreId || 'all');

  const mapRow = (row) => ({
    id: row.id,
    table: row.table_label || row.table || '',
    server: row.server || '',
    covers: row.covers || 1,
    centreId: row.centre_id || row.centreId || null,
    sentAt: row.sent_at ? new Date(row.sent_at).getTime() : Date.now(),
    bumpedAt: row.bumped_at ? new Date(row.bumped_at).getTime() : null,
    minutes: 0,
    firedCourses: row.fired_courses || row.firedCourses || [0, 1],
    allCourses: row.all_courses || row.allCourses || [],
    items: (typeof row.items === 'string' ? JSON.parse(row.items) : (row.items || [])).map(i => ({ ...i, _bumped: i._bumped || false })),
  });

  useEffect(() => {
    if (isMock || !locationId) { setLiveTickets(null); return; }
    const load = async () => {
      try {
        let q = supabase.from('kds_tickets').select('*').eq('location_id', locationId).in('status', ['pending','held']).order('sent_at', { ascending: true });
        if (centreId) q = q.eq('centre_id', centreId);
        const { data } = await q;
        if (data) {
          setLiveTickets(data.filter(r=>r.status==='pending').map(mapRow));
          setHeldTickets(data.filter(r=>r.status==='held').map(mapRow));
        }
      } catch(e) { setLiveTickets(null); }
    };
    load();
    const channel = supabase
      .channel(`kds-tickets-${locationId}${centreId ? `-${centreId}` : ''}`)
      .on('postgres_changes', { event:'INSERT', schema:'public', table:'kds_tickets', filter:`location_id=eq.${locationId}` }, (payload) => {
        const ticket = mapRow(payload.new);
        if (centreId && ticket.centreId !== centreId) return;
        setLiveTickets(prev => prev ? [...prev, ticket] : [ticket]);
      })
      .on('postgres_changes', { event:'UPDATE', schema:'public', table:'kds_tickets', filter:`location_id=eq.${locationId}` }, (payload) => {
        const updated = mapRow(payload.new);
        if (payload.new.status === 'bumped') {
          setLiveTickets(prev => prev ? prev.filter(t => t.id !== payload.new.id) : prev);
          setHeldTickets(prev => prev.filter(t => t.id !== payload.new.id));
        } else if (payload.new.status === 'held') {
          // v5.5.913: the INSERT handler filters by centre but this one never did, so ANY
          // per-item tick anywhere in the venue appended a foreign ticket to this screen.
          // The bumped branch above stays unguarded on purpose — it still needs to clean up
          // rows that leaked in before this fix.
          if (centreId && updated.centreId !== centreId) return;
          setLiveTickets(prev => prev ? prev.filter(t => t.id !== payload.new.id) : prev);
          setHeldTickets(prev => { const ex=prev.some(t=>t.id===updated.id); return ex?prev.map(t=>t.id===updated.id?updated:t):[...prev,updated]; });
        } else if (payload.new.status === 'pending') {
          if (centreId && updated.centreId !== centreId) return;
          setHeldTickets(prev => prev.filter(t => t.id !== payload.new.id));
          setLiveTickets(prev => prev ? (prev.some(t=>t.id===updated.id)?prev.map(t=>t.id===updated.id?updated:t):[...prev,updated]) : [updated]);
        } else {
          setLiveTickets(prev => prev ? prev.map(t => t.id === payload.new.id ? updated : t) : prev);
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [locationId, centreId]);

  const handleBump = async (ticketId) => {
    if (liveTickets !== null) {
      setLiveTickets(prev => prev.filter(t => t.id !== ticketId));
      if (!isMock) await supabase.from('kds_tickets').update({ status:'bumped', bumped_at:new Date().toISOString() }).eq('id', ticketId);
    } else { bumpTicket(ticketId); }
    showToast('Ticket bumped', 'success');
  };

  const handleHold = async (ticketId) => {
    const ticket = (liveTickets||[]).find(t=>t.id===ticketId);
    if (!ticket) return;
    setLiveTickets(prev => prev ? prev.filter(t => t.id !== ticketId) : prev);
    setHeldTickets(prev => [...prev, ticket]);
    if (!isMock) await supabase.from('kds_tickets').update({ status:'held' }).eq('id', ticketId);
    showToast('Ticket held', 'info');
  };

  const handleUnhold = async (ticketId) => {
    const ticket = heldTickets.find(t=>t.id===ticketId);
    if (!ticket) return;
    setHeldTickets(prev => prev.filter(t => t.id !== ticketId));
    setLiveTickets(prev => prev ? [...prev, {...ticket, sentAt:Date.now()}] : [{...ticket, sentAt:Date.now()}]);
    if (!isMock) await supabase.from('kds_tickets').update({ status:'pending' }).eq('id', ticketId);
    showToast('Ticket back in queue', 'success');
  };

  const loadHistory = async () => {
    setShowHistory(true);
    if (isMock) return;
    try {
      let q = supabase.from('kds_tickets').select('*').eq('location_id', locationId).eq('status','bumped').order('bumped_at', { ascending:false }).limit(30);
      if (centreId) q = q.eq('centre_id', centreId);
      const { data } = await q;
      if (data) setHistoryTickets(data.map(mapRow));
    } catch(e) { console.warn('history load failed', e); }
  };

  const handleRecall = async (ticketId) => {
    const ticket = historyTickets.find(t=>t.id===ticketId);
    if (!ticket) return;
    const recalled = { ...ticket, sentAt: Date.now() };
    setHistoryTickets(prev => prev.filter(t => t.id !== ticketId));
    setLiveTickets(prev => prev ? [...prev, recalled] : [recalled]);
    if (!isMock) await supabase.from('kds_tickets').update({ status:'pending', bumped_at:null, sent_at:new Date().toISOString() }).eq('id', ticketId);
    setShowHistory(false);
    showToast('Ticket recalled', 'success');
  };

  const handleBumpItem = async (ticketId, itemIndex) => {
    const ticket = (liveTickets||[]).find(t=>t.id===ticketId);
    if (!ticket) return;
    const updatedItems = ticket.items.map((it, i) => i === itemIndex ? { ...it, _bumped: true } : it);
    const allBumped = updatedItems.every(i => i._bumped);
    if (allBumped) { handleBump(ticketId); return; }
    setLiveTickets(prev => prev ? prev.map(t => t.id === ticketId ? { ...t, items: updatedItems } : t) : prev);
    if (!isMock) await supabase.from('kds_tickets').update({ items: updatedItems }).eq('id', ticketId);
  };

  const tickets = liveTickets !== null ? liveTickets : storeTickets;

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 30000);
    return () => clearInterval(id);
  }, []);

  const urgency = (m) => m>=25?'urgent':m>=12?'warning':'ok';
  const fmt = (m) => m>=60?`${Math.floor(m/60)}h ${m%60}m`:`${m}m`;
  const URG = {
    urgent:  { color:'var(--red)',  bg:'rgba(239,68,68,.08)',  border:'rgba(239,68,68,.25)' },
    warning: { color:'var(--acc)',  bg:'rgba(232,160,32,.08)', border:'rgba(232,160,32,.25)' },
    ok:      { color:'var(--grn)',  bg:'transparent',          border:'var(--bdr)' },
  };
  const HELD_STYLE = { color:'#a78bfa', bg:'rgba(167,139,250,.08)', border:'rgba(167,139,250,.25)' };
  const COURSE_LABEL = { 0:'Immediate', 1:'Course 1', 2:'Course 2', 3:'Course 3' };

  function getLiveMinutes(ticket) {
    const ts = ticket.sentAt instanceof Date ? ticket.sentAt.getTime() : typeof ticket.sentAt === 'string' ? new Date(ticket.sentAt).getTime() : Number(ticket.sentAt);
    // v5.5.914: a missing or unparseable sentAt used to fall straight through —
    // Math.max(0, Math.floor(NaN)) is still NaN, so the card read "NaNm" on the wall AND
    // urgency(NaN) put the ticket in the wrong bucket, quietly skewing the on-time counts
    // in the header. Treat an unknown age as brand new rather than as garbage.
    if (!Number.isFinite(ts)) return 0;
    return Math.max(0, Math.floor((Date.now() - ts) / 60000));
  }

  function getStationLabel(ticket) {
    try { const r = JSON.parse(localStorage.getItem('rpos-print-routing')||'null'); return r?.centres?.find(c=>c.id===(ticket.centreId||ticket.station))?.name; } catch{}
    return ticket.station || 'Kitchen';
  }

  const stations = ['all', ...new Set(tickets.map(t=>t.centreId||t.station||'pc1').filter(Boolean))];
  const displayed = tickets.filter(t => filter==='all' || (t.centreId||t.station||'pc1')===filter);

  // ── RUNNING ROLL-UP — everything this screen still has to make (v5.5.913) ──────
  // A chef looking at 20 tickets cannot see that eight of them want fries. This totals
  // the outstanding work into one line: "12 Margherita, 8 Fries".
  //
  // Aggregated over `displayed` — the EXACT array the cards render from — so the total can
  // never disagree with what is on screen. Deliberately TICKET-level, not item-level: the
  // production centre lives on the ticket (kds_tickets.centre_id), and catering tickets are
  // written with centre_id null and items that carry no centre at all, so an item-level test
  // would show an empty summary on the very screen that has that food.
  const rollUp = (() => {
    const map = new Map();
    for (const tk of displayed) {
      let items = tk.items || [];
      if (typeof items === 'string') { try { items = JSON.parse(items); } catch { items = []; } }
      const fired = tk.firedCourses || [0, 1];
      for (const it of items) {
        if (it._bumped) continue;                          // already made — never say cook it again
        if (it.voided) continue;
        if (!fired.includes(it.course ?? 1)) continue;      // held course: not to be fired yet
        const name = String(it.name || 'Item');
        const mods = (Array.isArray(it.mods) ? it.mods : (it.mods ? [it.mods] : []))
          .map(modText).filter(Boolean);
        const key = name + '||' + mods.slice().sort().join('~');
        const qty = Number(it.qty) || 0;                   // sum QTY, never row count — one line can be 12
        const row = map.get(key);
        if (row) row.qty += qty; else map.set(key, { key, name, mods, qty });
      }
    }
    return [...map.values()].sort((a,b) => b.qty - a.qty || a.name.localeCompare(b.name));
  })();
  const rollUpTotal = rollUp.reduce((sum, r) => sum + r.qty, 0);
  const counts = {
    urgent:  displayed.filter(t=>urgency(getLiveMinutes(t))==='urgent').length,
    warning: displayed.filter(t=>urgency(getLiveMinutes(t))==='warning').length,
    ok:      displayed.filter(t=>urgency(getLiveMinutes(t))==='ok').length,
  };

  const TicketCard = ({ ticket, isHeld=false, isHistory=false }) => {
    const liveMin = isHeld||isHistory ? 0 : getLiveMinutes(ticket);
    const urg = isHeld ? 'held' : urgency(liveMin);
    const u = urg==='held' ? HELD_STYLE : URG[urg];
    const firedCourses = ticket.firedCourses || [0,1];
    const allItems = ticket.items || [];
    const firedItems = allItems.filter(i => firedCourses.includes(i.course??1));
    const pendingItems = allItems.filter(i => !firedCourses.includes(i.course??1));
    const firedByCourse = {};
    firedItems.forEach(i => { const c=i.course??1; if(!firedByCourse[c])firedByCourse[c]=[]; firedByCourse[c].push({...i,_origIdx:allItems.indexOf(i)}); });
    const pendingByCourse = {};
    pendingItems.forEach(i => { const c=i.course??1; if(!pendingByCourse[c])pendingByCourse[c]=[]; pendingByCourse[c].push({...i,_origIdx:allItems.indexOf(i)}); });

    // v4.6.14: larger qty badge + item name, amber mods (red reserved for card-level LATE state).
    const ItemRow = ({ item }) => (
      <div style={{ display:'flex', alignItems:'flex-start', gap:12, paddingBottom:10, opacity:item._bumped?0.3:1, transition:'opacity .2s' }}>
        {!isHeld && !isHistory && (
          <button onClick={()=>handleBumpItem(ticket.id, item._origIdx)}
            title="Bump this item"
            style={{ width:26, height:26, borderRadius:7, border:`1.5px solid ${item._bumped?'var(--grn)':'var(--bdr2)'}`,
              background:item._bumped?'var(--grn-d)':'transparent', cursor:'pointer', flexShrink:0, marginTop:3,
              display:'flex', alignItems:'center', justifyContent:'center', fontSize:14, color:item._bumped?'var(--grn)':'var(--t4)', fontWeight:900 }}>
            {item._bumped ? '✓' : ''}
          </button>
        )}
        <div style={{ width:32, height:32, borderRadius:8, background:'var(--bg3)', border:'1px solid var(--bdr2)',
          display:'flex', alignItems:'center', justifyContent:'center', fontSize:15, fontWeight:700,
          color:item._bumped?'var(--t4)':'var(--t1)', flexShrink:0, fontFamily:'var(--font-mono)',
          textDecoration:item._bumped?'line-through':'' }}>
          {item.qty}
        </div>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={{ fontSize:16, fontWeight:700, color:item._bumped?'var(--t4)':'var(--t1)', lineHeight:1.3, textDecoration:item._bumped?'line-through':'' }}>{item.name}</div>
          {(Array.isArray(item.mods)?item.mods:(item.mods?[item.mods]:[])).map((mod,mi)=>(
            <div key={mi} style={{ fontSize:13, color:'var(--acc)', fontWeight:600, marginTop:3, lineHeight:1.4 }}>{modText(mod)}</div>
          ))}
        </div>
      </div>
    );

    // v4.6.14: card refresh inspired by Fresh KDS. Bigger table label, dedicated
    // ON TIME / CAUTION / LATE status pill with a larger mono timer, pill-style
    // course headers instead of emoji, bigger item rows, and a dominant bump button.
    // Dark palette preserved. Flex-col with the v4.6.13 height cap and internal items scroll.
    const statusLabel = urg === 'urgent' ? 'LATE' : urg === 'warning' ? 'CAUTION' : 'ON TIME';
    const statusBg    = urg === 'urgent' ? 'var(--red-d)' : urg === 'warning' ? 'var(--acc-d)' : 'var(--grn-d)';
    const cardBorder  = urg === 'urgent' ? `1.5px solid ${u.color}55` : '1px solid var(--bdr)';
    const firingTone  = { color:'var(--acc)', bg:'rgba(232,160,32,.12)', border:'rgba(232,160,32,.4)' };
    const holdTone    = { color:'var(--t3)',  bg:'var(--bg3)',           border:'var(--bdr2)' };
    const CourseBadge = ({ label, tone }) => (
      <div style={{
        display:'inline-flex', alignItems:'center', padding:'4px 9px', borderRadius:6,
        background:tone.bg, border:`1px solid ${tone.border}`,
        fontSize:10, fontWeight:800, color:tone.color, letterSpacing:'.08em', fontFamily:'var(--font-mono)',
      }}>{label}</div>
    );

    return (
      <div style={{ background:'var(--bg1)', border:cardBorder, borderRadius:14, overflow:'hidden',
        boxShadow:urg==='urgent'?`0 0 24px ${u.color}33`:'none', opacity:isHeld?0.92:1,
        display:'flex', flexDirection:'column', maxHeight:'calc(100vh - 190px)' }}>

        <div style={{ padding:'14px 16px 12px', borderBottom:'1px solid var(--bdr)', flexShrink:0, display:'flex', alignItems:'flex-start', gap:12 }}>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:22, fontWeight:800, color:'var(--t1)', letterSpacing:'-.01em', lineHeight:1, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>
              {ticket.table||'Walk-in'}
            </div>
            <div style={{ fontSize:11, color:'var(--t4)', marginTop:6, display:'flex', gap:12, fontFamily:'var(--font-mono)', flexWrap:'wrap' }}>
              {ticket.server&&<span>{ticket.server}</span>}
              {ticket.covers>1&&<span>{ticket.covers} cv</span>}
              <span>{getStationLabel(ticket)}</span>
            </div>
          </div>
          {!isHeld&&!isHistory&&(
            <div style={{ padding:'6px 12px', borderRadius:10, background:statusBg, border:`1px solid ${u.color}55`,
              display:'flex', flexDirection:'column', alignItems:'flex-end', gap:2, flexShrink:0,
              animation:urg==='urgent'?'pulse 1.4s ease-in-out infinite':'none' }}>
              <span style={{ fontSize:10, fontWeight:800, color:u.color, fontFamily:'var(--font-mono)', letterSpacing:'.07em', lineHeight:1 }}>{statusLabel}</span>
              <span style={{ fontSize:22, fontWeight:800, color:u.color, fontFamily:'var(--font-mono)', lineHeight:1.1 }}>{fmt(liveMin)}</span>
            </div>
          )}
          {isHeld&&(
            <div style={{ padding:'6px 12px', borderRadius:10, background:HELD_STYLE.bg, border:`1px solid ${HELD_STYLE.border}`, alignSelf:'flex-start' }}>
              <span style={{ fontSize:10, fontWeight:800, color:HELD_STYLE.color, fontFamily:'var(--font-mono)', letterSpacing:'.07em' }}>ON HOLD</span>
            </div>
          )}
          {isHistory&&(
            <div style={{ padding:'6px 12px', borderRadius:10, background:'var(--bg3)', border:'1px solid var(--bdr)',
              display:'flex', flexDirection:'column', alignItems:'flex-end', gap:2, alignSelf:'flex-start' }}>
              <span style={{ fontSize:10, fontWeight:800, color:'var(--t3)', fontFamily:'var(--font-mono)', letterSpacing:'.07em', lineHeight:1 }}>BUMPED</span>
              {ticket.bumpedAt&&<span style={{ fontSize:13, fontWeight:700, color:'var(--t2)', fontFamily:'var(--font-mono)', lineHeight:1.1 }}>{new Date(ticket.bumpedAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})}</span>}
            </div>
          )}
        </div>

        <div style={{ padding:'12px 16px', flex:1, overflowY:'auto', minHeight:0 }}>
          {Object.entries(firedByCourse).sort(([a],[b])=>a-b).map(([course,cItems], cIdx)=>{
            const last = cIdx === Object.keys(firedByCourse).length-1 && pendingItems.length === 0;
            return (
              <div key={course} style={{ marginBottom: last ? 0 : 14 }}>
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
                  <CourseBadge label={`${(COURSE_LABEL[course]||`COURSE ${course}`).toUpperCase()} — FIRING`} tone={firingTone}/>
                  <div style={{ flex:1, height:1, background:'var(--bdr)' }}/>
                </div>
                {cItems.map(item=><ItemRow key={item._origIdx} item={item}/>)}
              </div>
            );
          })}
          {pendingItems.length>0 && Object.entries(pendingByCourse).sort(([a],[b])=>a-b).map(([course,cItems], cIdx)=>{
            const last = cIdx === Object.keys(pendingByCourse).length-1;
            return (
              <div key={course} style={{ marginBottom: last ? 0 : 14 }}>
                <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
                  <CourseBadge label={`${(COURSE_LABEL[course]||`COURSE ${course}`).toUpperCase()} — HOLD`} tone={holdTone}/>
                  <div style={{ flex:1, height:1, background:'var(--bdr)' }}/>
                </div>
                {cItems.map(item=><ItemRow key={item._origIdx} item={item}/>)}
              </div>
            );
          })}
        </div>

        <div style={{ padding:'12px 16px', borderTop:'1px solid var(--bdr)', display:'flex', gap:8, flexShrink:0 }}>
          {isHistory?(
            <button onClick={()=>handleRecall(ticket.id)} style={{ flex:1, height:44, borderRadius:10, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:14, fontWeight:800 }}>↩ Recall to queue</button>
          ):isHeld?(
            <>
              <button onClick={()=>handleUnhold(ticket.id)} style={{ flex:3, height:44, borderRadius:10, cursor:'pointer', fontFamily:'inherit', background:HELD_STYLE.color, border:'none', color:'#fff', fontSize:14, fontWeight:800 }}>↩ Back to queue</button>
              <button onClick={()=>handleBump(ticket.id)} style={{ flex:1, height:44, borderRadius:10, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t3)', fontSize:13, fontWeight:700 }}>Bump ✓</button>
            </>
          ):(
            <>
              <button onClick={()=>handleBump(ticket.id)} style={{ flex:3, height:44, borderRadius:10, cursor:'pointer', fontFamily:'inherit', background:'var(--grn)', border:'none', color:'#052e16', fontSize:15, fontWeight:800 }}
                onMouseEnter={e=>e.currentTarget.style.background='#16a34a'} onMouseLeave={e=>e.currentTarget.style.background='var(--grn)'}>
                Bump ✓
              </button>
              <button onClick={()=>handleHold(ticket.id)} title="Hold" style={{ width:44, height:44, borderRadius:10, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr)', color:HELD_STYLE.color, fontSize:18, fontWeight:700 }}>⏸</button>
            </>
          )}
        </div>
      </div>
    );
  };

  return (
    // v5.5.913 — WHY height:100% AND minHeight:0 ARE LOAD-BEARING.
    // On a paired kitchen screen App.jsx renders KDSSurface as a DIRECT child of #root, and
    // #root is display:block (globals.css). `flex:1` is inert without a flex parent, so this
    // div's height resolved to auto and grew to the full height of all the tickets. The board
    // below (flex:1, overflowY:auto) was therefore exactly as tall as its own content and NEVER
    // had anything to scroll — the excess spilled onto #root{overflow:hidden} and was hard
    // clipped. Measured on a 1024x600 screen with 40 tickets: 2044px of tickets unreachable,
    // no scrollbar anywhere, no input could ever get to them.
    // height:100% resolves against #root's own height:100% on that path, AND against the
    // stretched flex parent on the in-app path — so it is correct under both, which is why the
    // fix belongs here rather than at the three call sites.
    <div style={{ display:'flex', flex:1, flexDirection:'column', height:'100%', minHeight:0,
                  overflow:'hidden', background:'var(--bg)' }}>
      <div style={{ height:52, display:'flex', alignItems:'center', gap:14, padding:'0 18px', borderBottom:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0 }}>
        <div>
          <div style={{ fontSize:14, fontWeight:800, color:'var(--t1)', letterSpacing:'-.01em' }}>{kdsName}</div>
          <div style={{ fontSize:10, color:'var(--t3)', fontWeight:600 }}>
            {centreName&&<span style={{ marginRight:6 }}>{centreName} ·</span>}
            {displayed.length} ticket{displayed.length!==1?'s':''}{heldTickets.length>0?` · ${heldTickets.length} held`:''} · <span style={{ fontFamily:'monospace' }}>v{VERSION}</span>
          </div>
        </div>
        <div style={{ display:'flex', gap:6 }}>
          {counts.urgent>0&&<span style={{ padding:'3px 10px', borderRadius:10, fontSize:11, fontWeight:700, background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)' }}>{counts.urgent} urgent</span>}
          {counts.warning>0&&<span style={{ padding:'3px 10px', borderRadius:10, fontSize:11, fontWeight:700, background:'var(--acc-d)', border:'1px solid var(--acc-b)', color:'var(--acc)' }}>{counts.warning} warn</span>}
          {counts.ok>0&&<span style={{ padding:'3px 10px', borderRadius:10, fontSize:11, fontWeight:700, background:'var(--grn-d)', border:'1px solid var(--grn-b)', color:'var(--grn)' }}>{counts.ok} ok</span>}
        </div>
        <div style={{ marginLeft:'auto', display:'flex', gap:6, alignItems:'center' }}>
          <button onClick={showHistory?()=>setShowHistory(false):loadHistory}
            style={{ padding:'4px 12px', borderRadius:20, cursor:'pointer', fontFamily:'inherit', fontSize:11, fontWeight:700,
              background:showHistory?'var(--acc-d)':'transparent', border:`1px solid ${showHistory?'var(--acc-b)':'var(--bdr)'}`, color:showHistory?'var(--acc)':'var(--t3)' }}>
            📋 History
          </button>
          {stations.length>1&&stations.map(s=>(
            <button key={s} onClick={()=>setFilter(s)} style={{ padding:'4px 12px', borderRadius:20, cursor:'pointer', fontFamily:'inherit',
              background:filter===s?'var(--acc-d)':'transparent', border:`1px solid ${filter===s?'var(--acc-b)':'var(--bdr)'}`,
              color:filter===s?'var(--acc)':'var(--t3)', fontSize:11, fontWeight:700 }}>
              {s==='all'?'All stations':(getStationLabel({centreId:s,station:s})||s)}
            </button>
          ))}
        </div>
      </div>

      {showHistory?(
        <div style={{ flex:1, overflowY:'auto', padding:14, minHeight:0 }}>
          <div style={{ fontSize:12, fontWeight:700, color:'var(--t3)', marginBottom:12 }}>Bumped tickets — tap Recall to bring back</div>
          {historyTickets.length===0?(
            <div style={{ textAlign:'center', padding:'60px', color:'var(--t4)', fontSize:13 }}>No history yet</div>
          ):(
            <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(240px,1fr))', gap:12 }}>
              {historyTickets.map(t=><TicketCard key={t.id} ticket={t} isHistory/>)}
            </div>
          )}
        </div>
      ):(
        // v5.5.914: board and the TO MAKE list sit side by side. A horizontal strip could only
        // ever show four or five items before running out of width; a full-height column shows
        // the entire prep list at once, which is the whole reason the total exists.
        <div style={{ flex:1, display:'flex', minHeight:0 }}>
        <div style={{ flex:1, overflowY:'auto', padding:14, minHeight:0 }}>
          {heldTickets.length>0&&(
            <div style={{ marginBottom:16 }}>
              <div style={{ fontSize:11, fontWeight:800, color:'#a78bfa', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>⏸ On hold</div>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(240px,1fr))', gap:12, marginBottom:12 }}>
                {heldTickets.map(t=><TicketCard key={t.id} ticket={t} isHeld/>)}
              </div>
              <div style={{ height:1, background:'var(--bdr)', margin:'4px 0 16px' }}/>
            </div>
          )}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(240px,1fr))', gap:12, alignContent:'start' }}>
            {displayed.length===0&&(
              <div style={{ gridColumn:'1/-1', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', padding:'80px 0', color:'var(--t3)' }}>
                <div style={{ width:64, height:64, borderRadius:18, background:'var(--grn-d)', border:'2px solid var(--grn-b)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:30, marginBottom:16 }}>✓</div>
                <div style={{ fontSize:16, fontWeight:800, color:'var(--t2)', marginBottom:4 }}>Kitchen clear</div>
                <div style={{ fontSize:12 }}>All orders bumped</div>
              </div>
            )}
            {displayed.map(t=><TicketCard key={t.id} ticket={t}/>)}
          </div>
        </div>

        {/* ── TO MAKE — the whole outstanding prep list, always fully visible ──────
            A full-height column rather than a strip along the top: a strip runs out of
            width after four or five items, which is exactly the thing being complained
            about. This shows every line at once, and only scrolls in the extreme case. */}
        {rollUp.length>0 && (
          <div style={{ width:250, flexShrink:0, borderLeft:'1px solid var(--bdr)',
            background:'var(--bg1)', display:'flex', flexDirection:'column', minHeight:0 }}>
            <div style={{ flexShrink:0, padding:'12px 14px 10px', borderBottom:'1px solid var(--bdr)' }}>
              <div style={{ fontSize:10, fontWeight:800, letterSpacing:'.1em', color:'var(--t4)' }}>TO MAKE</div>
              <div style={{ fontSize:26, fontWeight:800, color:'var(--t1)', lineHeight:1.1, marginTop:2 }}>
                {rollUpTotal}<span style={{ fontSize:12, fontWeight:700, color:'var(--t4)', marginLeft:6 }}>
                  item{rollUpTotal===1?'':'s'}</span>
              </div>
            </div>
            <div style={{ flex:1, overflowY:'auto', minHeight:0, padding:'6px 0' }}>
              {rollUp.map(r => (
                <div key={r.key} style={{ display:'flex', alignItems:'baseline', gap:10,
                  padding:'8px 14px', borderBottom:'1px solid var(--bdr)' }}>
                  <span style={{ fontSize:22, fontWeight:800, color:'var(--acc)', minWidth:32,
                    textAlign:'right', flexShrink:0 }}>{r.qty}</span>
                  <div style={{ minWidth:0 }}>
                    <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)', lineHeight:1.25 }}>{r.name}</div>
                    {r.mods.length>0 && (
                      <div style={{ fontSize:11, fontWeight:600, color:'var(--t4)', lineHeight:1.35, marginTop:1 }}>
                        {r.mods.join(' · ')}
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        </div>
      )}
    </div>
  );
}
