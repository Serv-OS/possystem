import { useState } from 'react';
import { PRODUCTION_CENTRES } from '../data/seed';
import { printService } from '../lib/printer';
import { useStore } from '../store';
import { calculateOrderTax } from '../lib/tax';

// ── Receipt display & print ───────────────────────────────────────────────────
export function ReceiptModal({ items, subtotal, service, total, checkDiscount, orderType, tableLabel, server, covers, customer, ref: checkRef, method, tip, onClose }) {
  const { location, taxRates } = useStore();
  const now = new Date();
  const nonVoided = items.filter(i => !i.voided);
  const [printing, setPrinting] = useState(false);

  // Calculate tax breakdown for receipt
  const taxBreakdown = (() => {
    if (!taxRates?.length) return null;
    try { return calculateOrderTax(nonVoided, taxRates, orderType || 'dine-in'); }
    catch { return null; }
  })();

  const handlePrint = async () => {
    setPrinting(true);
    try {
      await printService.printReceipt({
        location,
        check: { ref: checkRef, server, tableLabel, orderType, covers, method },
        items: nonVoided,
        totals: { subtotal, service, tip: tip || 0, grand: total + (tip || 0), taxBreakdown },
      });
    } catch (err) {
      // Fallback to browser print on failure
      const win = window.open('', '_blank', 'width=380,height=700');
    win.document.write(`
      <html><head><title>Receipt</title>
      <style>
        * { margin:0; padding:0; box-sizing:border-box; }
        body { font-family: 'Courier New', monospace; font-size:12px; width:320px; padding:16px; color:#000; background:#fff; }
        .center { text-align:center; }
        .bold { font-weight:bold; }
        .big { font-size:16px; }
        .line { border-top:1px dashed #000; margin:8px 0; }
        .row { display:flex; justify-content:space-between; margin:3px 0; }
        .muted { color:#666; font-size:11px; }
        .allergen { color:#cc0000; font-size:10px; padding-left:12px; }
        .total-row { font-size:14px; font-weight:bold; border-top:2px solid #000; padding-top:6px; margin-top:4px; }
        .void { text-decoration:line-through; color:#999; }
      </style>
      </head><body>
      <div class="center bold big">Serv OS</div>
      <div class="center muted" style="margin:4px 0 8px">
        ${tableLabel ? tableLabel : customer?.name ? customer.name : orderType}<br>
        ${server ? `Server: ${server}` : ''}${covers>1 ? ` · ${covers} covers` : ''}<br>
        ${now.toLocaleString('en-GB')}
      </div>
      <div class="line"></div>
      ${nonVoided.map(item => {
        const disc = item.discount;
        const price = disc
          ? (disc.type==='percent' ? item.price*(1-disc.value/100) : Math.max(0,item.price-disc.value/item.qty))
          : item.price;
        return `
          <div class="row">
            <span>${item.qty > 1 ? item.qty+"× " : ""}${item.receiptName||item.name}</span>
            <span>£${(price*item.qty).toFixed(2)}</span>
          </div>
          ${item.mods?.length ? `<div class="muted" style="padding-left:12px">${item.mods.map(m=>m.label).join(', ')}</div>` : ''}
          ${item.notes ? `<div class="muted" style="padding-left:12px">📝 ${item.notes}</div>` : ''}
          ${disc ? `<div class="muted" style="padding-left:12px">🏷 ${disc.label} (−£${(item.price*item.qty - price*item.qty).toFixed(2)})</div>` : ''}
          ${item.allergens?.length ? `<div class="allergen">⚠ ALLERGENS: ${item.allergens.map(a=>a.toUpperCase()).join(', ')}</div>` : ''}
        `;
      }).join('')}
      <div class="line"></div>
      <div class="row muted"><span>Subtotal</span><span>£${subtotal.toFixed(2)}</span></div>
      ${checkDiscount > 0 ? `<div class="row" style="color:#1a7a3a"><span>Discount</span><span>−£${checkDiscount.toFixed(2)}</span></div>` : ''}
      ${service > 0 ? `<div class="row muted"><span>Service charge (12.5%)</span><span>£${service.toFixed(2)}</span></div>` : ''}
      <div class="row total-row"><span>TOTAL</span><span>£${total.toFixed(2)}</span></div>
      ${(taxBreakdown?.breakdown||[]).filter(b=>b.tax>0).map(b => {
        const pct = (b.rate.rate*100).toFixed(1).replace('.0','');
        const label = b.rate.type==='exclusive' ? `${b.rate.name} (${pct}%)` : `of which ${b.rate.name} (${pct}%)`;
        return `<div class="row muted" style="font-size:10px"><span>${label}</span><span>£${b.tax.toFixed(2)}</span></div>`;
      }).join('')}
      <div class="line"></div>
      <div class="center muted" style="margin-top:8px">Thank you for dining with us</div>
      </body></html>
    `);
      win.document.close();
      win.focus();
      setTimeout(() => { win.print(); }, 300);
    }
    setPrinting(false);
  };

  return (
    <div className="modal-back" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:'var(--bg2)',border:'1px solid var(--bdr2)',borderRadius:20,width:'100%',maxWidth:380,maxHeight:'88vh',overflow:'auto',boxShadow:'var(--sh3)'}}>

        {/* Header */}
        <div style={{padding:'16px 20px 12px',borderBottom:'1px solid var(--bdr)',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <div style={{fontSize:15,fontWeight:700,color:'var(--t1)'}}>Check</div>
          <div style={{display:'flex',gap:8}}>
            <button onClick={handlePrint} disabled={printing} style={{padding:'6px 14px',borderRadius:8,cursor:'pointer',fontFamily:'inherit',background:'var(--acc)',border:'none',color:'#0e0f14',fontSize:12,fontWeight:700}}>{printing ? '…' : '🖨 Print'}</button>
            <button onClick={onClose} style={{background:'none',border:'none',color:'var(--t3)',cursor:'pointer',fontSize:22}}>×</button>
          </div>
        </div>

        {/* Receipt preview */}
        <div style={{padding:'16px 20px',fontFamily:'DM Mono, monospace'}}>
          <div style={{textAlign:'center',marginBottom:12}}>
            <div style={{fontSize:14,fontWeight:700,color:'var(--t1)'}}>Serv OS</div>
            <div style={{fontSize:11,color:'var(--t3)',marginTop:3}}>
              {tableLabel || orderType}{server?` · ${server}`:''}{covers>1?` · ${covers} covers`:''}
            </div>
            <div style={{fontSize:11,color:'var(--t3)'}}>{now.toLocaleString('en-GB')}</div>
          </div>

          <div style={{borderTop:'1px dashed var(--bdr2)',margin:'10px 0'}}/>

          {nonVoided.map(item => {
            const disc = item.discount;
            const price = disc
              ? (disc.type==='percent' ? item.price*(1-disc.value/100) : Math.max(0,item.price-disc.value/item.qty))
              : item.price;
            return (
              <div key={item.uid} style={{marginBottom:6}}>
                <div style={{display:'flex',justifyContent:'space-between',fontSize:12,color:'var(--t1)'}}>
                  <span>{item.qty>1?`${item.qty}× `:''}{item.receiptName||item.name}</span>
                  <span>£{(price*item.qty).toFixed(2)}</span>
                </div>
                {item.mods?.length>0&&<div style={{fontSize:10,color:'var(--t3)',paddingLeft:12}}>{item.mods.map(m=>m.label).join(', ')}</div>}
                {item.notes&&<div style={{fontSize:10,color:'#f97316',paddingLeft:12}}>📝 {item.notes}</div>}
                {disc&&<div style={{fontSize:10,color:'var(--grn)',paddingLeft:12}}>🏷 {disc.label} −£{(item.price*item.qty-price*item.qty).toFixed(2)}</div>}
                {item.allergens?.length>0&&<div style={{fontSize:10,color:'var(--red)',paddingLeft:12,fontWeight:600}}>⚠ {item.allergens.map(a=>a.toUpperCase()).join(' · ')}</div>}
              </div>
            );
          })}

          <div style={{borderTop:'1px dashed var(--bdr2)',margin:'10px 0'}}/>

          <div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:'var(--t3)',marginBottom:3}}><span>Subtotal</span><span>£{subtotal.toFixed(2)}</span></div>
          {checkDiscount>0&&<div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:'var(--grn)',marginBottom:3}}><span>Discount</span><span>−£{checkDiscount.toFixed(2)}</span></div>}
          {service>0&&<div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:'var(--t3)',marginBottom:3}}><span>Service (12.5%)</span><span>£{service.toFixed(2)}</span></div>}

          {/* Tax breakdown */}
          {taxBreakdown?.breakdown?.filter(b=>b.tax>0).map(b => {
            const pct = (b.rate.rate*100).toFixed(1).replace('.0','');
            const label = b.rate.type==='exclusive' ? `${b.rate.name} (${pct}%)` : `of which ${b.rate.name} (${pct}%)`;
            return <div key={b.rate.id} style={{display:'flex',justifyContent:'space-between',fontSize:10,color:'var(--t4)',marginBottom:2}}><span>{label}</span><span>£{b.tax.toFixed(2)}</span></div>;
          })}

          <div style={{display:'flex',justifyContent:'space-between',fontSize:16,fontWeight:700,borderTop:'1px solid var(--bdr3)',paddingTop:8,marginTop:6}}>
            <span style={{color:'var(--t1)'}}>Total</span>
            <span style={{color:'var(--acc)'}}>£{total.toFixed(2)}</span>
          </div>

          <div style={{borderTop:'1px dashed var(--bdr2)',margin:'12px 0 4px'}}/>
          <div style={{textAlign:'center',fontSize:10,color:'var(--t4)'}}>Thank you for dining with us</div>
        </div>
      </div>
    </div>
  );
}

// ── Reprint tickets modal ─────────────────────────────────────────────────────
export function ReprintModal({ items, tableLabel, onClose, onReprint }) {
  const [selected, setSelected] = useState(new Set(items.filter(i=>!i.voided).map(i=>i.uid)));

  // Group by production centre
  const centres = {};
  items.filter(i=>!i.voided).forEach(item => {
    const cid = item.centreId || 'pc1';
    if (!centres[cid]) centres[cid] = [];
    centres[cid].push(item);
  });

  const centreNames = { pc1:'Hot kitchen', pc2:'Cold section', pc3:'Pizza oven', pc4:'Bar', pc5:'Expo / pass' };

  const toggle = (uid) => setSelected(s => {
    const n = new Set(s);
    n.has(uid) ? n.delete(uid) : n.add(uid);
    return n;
  });

  return (
    <div className="modal-back" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:'var(--bg2)',border:'1px solid var(--bdr2)',borderRadius:20,width:'100%',maxWidth:380,boxShadow:'var(--sh3)',overflow:'hidden'}}>
        <div style={{padding:'16px 20px 12px',borderBottom:'1px solid var(--bdr)',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <div>
            <div style={{fontSize:15,fontWeight:700,color:'var(--t1)'}}>Reprint production tickets</div>
            <div style={{fontSize:11,color:'var(--t3)',marginTop:2}}>{tableLabel} · Select items to reprint</div>
          </div>
          <button onClick={onClose} style={{background:'none',border:'none',color:'var(--t3)',cursor:'pointer',fontSize:22}}>×</button>
        </div>

        <div style={{padding:'12px 16px',maxHeight:340,overflowY:'auto'}}>
          {Object.entries(centres).map(([cid, citems]) => (
            <div key={cid} style={{marginBottom:14}}>
              <div style={{fontSize:10,fontWeight:700,color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.07em',marginBottom:8,display:'flex',alignItems:'center',gap:6}}>
                <span style={{width:6,height:6,borderRadius:'50%',background:'var(--acc)',display:'inline-block'}}/>
                {centreNames[cid] || cid}
              </div>
              {citems.map(item => {
                const on = selected.has(item.uid);
                return (
                  <div key={item.uid} onClick={()=>toggle(item.uid)} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',borderRadius:8,cursor:'pointer',background:on?'var(--bg3)':'transparent',border:`1px solid ${on?'var(--bdr2)':'transparent'}`,marginBottom:4}}>
                    <div style={{width:16,height:16,borderRadius:3,border:`2px solid ${on?'var(--acc)':'var(--bdr2)'}`,background:on?'var(--acc)':'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                      {on&&<div style={{width:7,height:7,background:'#0e0f14',borderRadius:1}}/>}
                    </div>
                    <div style={{flex:1}}>
                      <div style={{fontSize:12,fontWeight:600,color:on?'var(--t1)':'var(--t3)'}}>{item.qty>1?`${item.qty}× `:''}{item.receiptName||item.name}</div>
                      {item.mods?.length>0&&<div style={{fontSize:10,color:'var(--t4)'}}>{item.mods.map(m=>m.label).join(', ')}</div>}
                      {item.notes&&<div style={{fontSize:10,color:'#f97316'}}>{item.notes}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <div style={{padding:'10px 16px 16px',borderTop:'1px solid var(--bdr)',display:'flex',gap:8}}>
          <button className="btn btn-ghost" style={{flex:1}} onClick={onClose}>Cancel</button>
          <button
            className="btn btn-acc" style={{flex:2,height:44}}
            disabled={selected.size===0}
            onClick={()=>{ onReprint([...selected]); onClose(); }}
          >
            🖨 Reprint {selected.size} item{selected.size!==1?'s':''}
          </button>
        </div>
      </div>
    </div>
  );
}
