import { useState } from 'react';
import { useStore } from '../store';
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
// v5.8.66: the kitchen display was redesigned and moved to src/surfaces/kds/KDSSurface.jsx.
// Re-exported here so App.jsx and anything else importing it from this file is unchanged.
export { KDSSurface } from './kds/KDSSurface.jsx';
