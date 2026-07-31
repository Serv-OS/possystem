import { useState } from 'react';
import { ALLERGENS } from '../data/seed';
import { money } from '../lib/currency';
import { useStore } from '../store';

export default function OrderReviewModal({ items, subtotal, service, total, checkDiscount, orderType, tableLabel, server, covers, customer, onClose, onCheckout, onPrint }) {
  const [mode, setMode] = useState('compact');  // compact | detailed
  // v5.5.961: this device's profile can hide course management entirely
  const hideCourses = useStore(s => (s.deviceConfig?.hiddenFeatures || []).includes('courses'));
  const nonVoided = items.filter(i => !i.voided);
  const sentCount  = nonVoided.filter(i => i.status==='sent').length;
  const pendingCount = nonVoided.filter(i => i.status==='pending').length;

  const contextLine = tableLabel
    ? `${tableLabel}${covers>1?` · ${covers} covers`:''} · ${server}`
    : customer?.name
      ? `${customer.name} · ${orderType}`
      : orderType;

  return (
    <div className="modal-back" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{
        background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:22,
        width:'100%', maxWidth:420, maxHeight:'90vh',
        display:'flex', flexDirection:'column',
        boxShadow:'var(--sh3)', overflow:'hidden',
        animation:'slideUp .18s cubic-bezier(.2,.8,.3,1)',
      }}>

        {/* Header */}
        <div style={{ padding:'14px 18px 10px', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
            <div>
              <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)' }}>Order review</div>
              <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>{contextLine}</div>
            </div>
            <button onClick={onClose} style={{ width:30, height:30, borderRadius:8, border:'1px solid var(--bdr2)', background:'transparent', color:'var(--t3)', cursor:'pointer', fontFamily:'inherit', fontSize:18, display:'flex', alignItems:'center', justifyContent:'center' }}>×</button>
          </div>

          {/* Mode toggle + stats */}
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            <div style={{ display:'flex', background:'var(--bg3)', borderRadius:9, padding:3, border:'1px solid var(--bdr)' }}>
              {[['compact','Compact'],['detailed','Detailed']].map(([m,l]) => (
                <button key={m} onClick={()=>setMode(m)} style={{
                  padding:'4px 12px', borderRadius:7, cursor:'pointer', fontFamily:'inherit',
                  background:mode===m?'var(--bg1)':'transparent',
                  border:mode===m?'1px solid var(--bdr2)':'1px solid transparent',
                  color:mode===m?'var(--t1)':'var(--t3)',
                  fontSize:11, fontWeight:mode===m?700:500, transition:'all .12s',
                }}>{l}</button>
              ))}
            </div>
            <div style={{ marginLeft:'auto', display:'flex', gap:6 }}>
              {sentCount>0&&<span style={{ fontSize:10, fontWeight:700, padding:'3px 8px', borderRadius:20, background:'var(--grn-d)', border:'1px solid var(--grn-b)', color:'var(--grn)' }}>✓ {sentCount} sent</span>}
              {pendingCount>0&&<span style={{ fontSize:10, fontWeight:700, padding:'3px 8px', borderRadius:20, background:'var(--acc-d)', border:'1px solid var(--acc-b)', color:'var(--acc)' }}>⏳ {pendingCount} pending</span>}
            </div>
          </div>
        </div>

        {/* Items */}
        <div style={{ flex:1, overflowY:'auto', padding:'8px 0' }}>
          {nonVoided.length === 0 && (
            <div style={{ textAlign:'center', padding:'40px 0', color:'var(--t3)' }}>
              <div style={{ fontSize:30, opacity:.4, marginBottom:8 }}>🧾</div>
              <div style={{ fontSize:13, fontWeight:600 }}>No items on this order</div>
            </div>
          )}

          {/* Compact mode */}
          {mode==='compact' && nonVoided.map((item, idx) => {
            const disc = item.discount;
            const price = disc
              ? (disc.type==='percent' ? item.price*(1-disc.value/100) : Math.max(0,item.price-disc.value/item.qty))
              : item.price;
            const isLast = idx===nonVoided.length-1;
            return (
              <div key={item.uid} style={{
                display:'flex', alignItems:'baseline', justifyContent:'space-between',
                padding:'7px 18px', borderBottom:isLast?'none':'1px solid var(--bdr)',
                background:idx%2===0?'transparent':'rgba(255,255,255,.02)',
              }}>
                <div style={{ display:'flex', alignItems:'baseline', gap:8, flex:1, minWidth:0 }}>
                  {item.qty>1&&<span style={{ fontSize:12, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)', flexShrink:0 }}>{item.qty}×</span>}
                  <span style={{ fontSize:13, fontWeight:500, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.name}</span>
                  {item.status==='sent'&&<span style={{ fontSize:9, color:'var(--grn)', fontWeight:700, flexShrink:0 }}>✓</span>}
                </div>
                <span style={{ fontSize:13, fontWeight:700, color:'var(--t2)', fontFamily:'var(--font-mono)', flexShrink:0, marginLeft:12 }}>{money((price*item.qty))}</span>
              </div>
            );
          })}

          {/* Detailed mode */}
          {mode==='detailed' && nonVoided.map((item, idx) => {
            const disc = item.discount;
            const price = disc
              ? (disc.type==='percent' ? item.price*(1-disc.value/100) : Math.max(0,item.price-disc.value/item.qty))
              : item.price;
            const isLast = idx===nonVoided.length-1;
            return (
              <div key={item.uid} style={{
                padding:'10px 18px', borderBottom:isLast?'none':'1px solid var(--bdr)',
                borderLeft:`3px solid ${item.status==='sent'?'var(--grn)':'var(--bg4)'}`,
              }}>
                <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:10 }}>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', display:'flex', alignItems:'center', gap:6 }}>
                      {item.qty>1&&<span style={{ fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>{item.qty}×</span>}
                      {item.name}
                      {item.status==='sent'&&<span style={{ fontSize:10, fontWeight:700, color:'var(--grn)', padding:'1px 6px', borderRadius:20, background:'var(--grn-d)', border:'1px solid var(--grn-b)' }}>Sent</span>}
                    </div>
                    {item.mods?.filter(m=>m.label).map((m,i)=>(
                      <div key={i} style={{ fontSize:11, color:'var(--t4)', marginTop:1 }}>
                        {m.groupLabel?`${m.groupLabel}: ${m.label}`:m.label}
                        {m.price>0&&<span style={{ color:'var(--acc)', marginLeft:6, fontFamily:'var(--font-mono)' }}>+{money(m.price)}</span>}
                      </div>
                    ))}
                    {item.notes&&<div style={{ fontSize:11, color:'var(--orn)', marginTop:2, fontStyle:'italic' }}>📝 {item.notes}</div>}
                    {disc&&<div style={{ fontSize:11, color:'var(--grn)', marginTop:2, fontWeight:600 }}>🏷 {disc.label}</div>}
                    {item.allergens?.length>0&&(
                      <div style={{ fontSize:10, color:'var(--red)', marginTop:2, fontWeight:600 }}>
                        ⚠ {item.allergens.map(a=>ALLERGENS.find(x=>x.id===a)?.label).filter(Boolean).join(' · ')}
                      </div>
                    )}
                    <div style={{ display:'flex', gap:4, marginTop:5, flexWrap:'wrap' }}>
                      {item.seat&&item.seat!=='shared'&&<span style={{ fontSize:10, padding:'1px 6px', borderRadius:4, background:'var(--acc-d)', color:'var(--acc)', fontWeight:700, border:'1px solid var(--acc-b)' }}>Seat {item.seat}</span>}
                      {!hideCourses&&item.course>0&&<span style={{ fontSize:10, padding:'1px 6px', borderRadius:4, background:'var(--bg3)', color:'var(--t3)', fontWeight:700, border:'1px solid var(--bdr)' }}>Course {item.course}</span>}
                    </div>
                  </div>
                  <div style={{ textAlign:'right', flexShrink:0 }}>
                    <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)', fontFamily:'var(--font-mono)' }}>{money((price*item.qty))}</div>
                    {disc&&<div style={{ fontSize:10, color:'var(--t4)', textDecoration:'line-through', fontFamily:'var(--font-mono)' }}>{money((item.price*item.qty))}</div>}
                    {item.qty>1&&!disc&&<div style={{ fontSize:10, color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{money(item.price)} ea</div>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Totals */}
        <div style={{ padding:'12px 18px 8px', borderTop:'1px solid var(--bdr)', flexShrink:0, background:'var(--bg2)' }}>
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--t3)', marginBottom:3 }}>
            <span>Subtotal</span><span style={{ fontFamily:'var(--font-mono)' }}>{money(subtotal)}</span>
          </div>
          {checkDiscount>0&&<div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--grn)', marginBottom:3 }}>
            <span>Discount</span><span style={{ fontFamily:'var(--font-mono)' }}>−{money(checkDiscount)}</span>
          </div>}
          {service>0
            ?<div style={{ display:'flex', justifyContent:'space-between', fontSize:12, color:'var(--t3)', marginBottom:3 }}>
               <span>Service (12.5%)</span><span style={{ fontFamily:'var(--font-mono)' }}>{money(service)}</span>
             </div>
            :<div style={{ fontSize:11, color:'var(--grn)', fontWeight:600, marginBottom:3 }}>✓ No service charge</div>
          }
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:20, fontWeight:800, borderTop:'1px solid var(--bdr)', paddingTop:8, marginTop:4 }}>
            <span>Total</span>
            <span style={{ color:'var(--acc)', fontFamily:'var(--font-mono)' }}>{money(total)}</span>
          </div>
        </div>

        {/* Actions */}
        <div style={{ padding:'8px 16px 14px', display:'flex', gap:6, flexShrink:0 }}>
          {onPrint && <button className="btn btn-ghost btn-sm" style={{ flexShrink:0 }} onClick={onPrint}>🖨 Print</button>}
          <button className="btn btn-ghost" style={{ flex:1 }} onClick={onClose}>Close</button>
          <button className="btn btn-acc" style={{ flex:2, height:44, fontSize:14, fontWeight:800 }} onClick={onCheckout}>
            Checkout · {money(total)} →
          </button>
        </div>
      </div>
    </div>
  );
}
