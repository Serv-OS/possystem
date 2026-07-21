import { useState, useMemo } from 'react';
import { useStore } from '../store';
import { printService } from '../lib/printer';
import { money } from '../lib/currency';
import { calculateOrderTax } from '../lib/tax';

const REFUND_REASONS = [
  'Wrong item served','Quality issue','Customer complaint',
  'Overcharge / pricing error','Allergy / dietary concern',
  'Item not received','Manager discretion','Other',
];
const managersFrom = (staffMembers) =>
  (staffMembers || [])
    .filter(s => s.role === 'Manager' && s.active !== false)
    .map(s => ({ pin: s.pin, name: s.name, id: s.id }));
const METHOD_ICON = {card:'💳',cash:'💵',split:'⚖','bar-tab':'🍸'};
const STATUS_META = {
  paid:           {color:'var(--grn)',bg:'var(--grn-d)',border:'var(--grn-b)',label:'Paid'},
  partial_refund: {color:'var(--acc)',bg:'var(--acc-d)',border:'var(--acc-b)',label:'Part refund'},
  refunded:       {color:'var(--red)',bg:'var(--red-d)',border:'var(--red-b)',label:'Refunded'},
};

function fmtTime(d){
  const date=new Date(d),now=new Date(),diff=now-date;
  if(diff<60000)    return 'Just now';
  if(diff<3600000)  return `${Math.floor(diff/60000)}m ago`;
  if(diff<86400000) return date.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'});
  return date.toLocaleDateString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
}

// ── Refund Modal ──────────────────────────────────────────────────────────────
function RefundModal({check, onConfirm, onCancel}){
  const { staffMembers, staff: currentUser } = useStore();
  const mgrs = managersFrom(staffMembers);
  const managerLoggedIn = currentUser?.role === 'Manager';

  const [step,setStep]=useState('select');  // select|pin|reason|tender|cash_confirm
  const [isFullRefund,setFull]=useState(false);
  const [selections,setSelections]=useState(()=>
    Object.fromEntries(check.items.map(i=>[i.uid,{selected:false,qty:i.qty}]))
  );
  const [pin,setPin]=useState('');
  const [pinErr,setPinErr]=useState('');
  const [manager,setManager]=useState(managerLoggedIn ? currentUser : null);
  const [reason,setReason]=useState('');
  const [freeText,setFreeText]=useState('');
  const [tenderMethod,setTenderMethod]=useState(null);   // 'card'|'cash'
  const [cashHandedOver,setCashHandedOver]=useState(false);

  const refundedQtys=useMemo(()=>{
    const map={};
    check.refunds.forEach(r=>r.items.forEach(ri=>{
      map[ri.uid]=(map[ri.uid]||0)+ri.refundQty;
    }));
    return map;
  },[check.refunds]);

  const toggleItem=uid=>{
    setSelections(s=>({...s,[uid]:{...s[uid],selected:!s[uid].selected}}));
    if(isFullRefund)setFull(false);
  };
  const setQty=(uid,qty)=>setSelections(s=>({...s,[uid]:{...s[uid],qty}}));

  const toggleFull=()=>{
    const next=!isFullRefund;
    setFull(next);
    if(next){
      setSelections(Object.fromEntries(check.items.map(i=>{
        const remaining=i.qty-(refundedQtys[i.uid]||0);
        return [i.uid,{selected:remaining>0,qty:Math.max(1,remaining)}];
      })));
    }
  };

  const selectedItems=check.items
    .filter(i=>selections[i.uid]?.selected)
    .map(i=>({...i,refundQty:selections[i.uid]?.qty||1}));
  const refundTotal=selectedItems.reduce((s,i)=>s+i.price*i.refundQty,0);

  const handleDigit=d=>{
    if(pin.length>=4)return;
    const next=pin+d;
    setPin(next);
    if(next.length===4){
      const m=mgrs.find(x=>x.pin===next);
      if(m){setManager(m);setPinErr('');setTimeout(()=>setStep('reason'),200);}
      else{setPinErr('Incorrect manager PIN');setTimeout(()=>setPin(''),600);}
    }
  };

  const handleTender=(method)=>{
    setTenderMethod(method);
    if(method==='cash')setStep('cash_confirm');
    else setStep('card_terminal');
  };

  const handleComplete=()=>{
    const finalReason=reason==='Other'?(freeText.trim()||'Other'):reason;
    onConfirm({
      items:selectedItems, isFullRefund, manager,
      reason:finalReason, tenderMethod,
      amount:refundTotal,
    });
  };

  return(
    <div className="modal-back" onClick={e=>e.target===e.currentTarget&&onCancel()}>
      <div style={{background:'var(--bg2)',border:'1px solid var(--bdr2)',borderRadius:20,width:'100%',maxWidth:460,maxHeight:'88vh',overflow:'auto',boxShadow:'var(--sh3)'}}>

        {/* Header */}
        <div style={{padding:'16px 20px 12px',borderBottom:'1px solid var(--bdr)',display:'flex',alignItems:'center',justifyContent:'space-between',flexShrink:0}}>
          <div>
            <div style={{fontSize:16,fontWeight:700,color:'var(--t1)'}}>
              {step==='select'?'Issue refund'
              :step==='pin'?'Manager authorisation'
              :step==='reason'?'Refund reason'
              :step==='tender'?'Refund tender'
              :step==='cash_confirm'?'Hand back cash'
              :'Return to card'}
            </div>
            <div style={{fontSize:11,color:'var(--t3)',marginTop:2}}>{check.ref} · {check.tableLabel||check.orderType} · {check.server}</div>
          </div>
          <button onClick={onCancel} style={{background:'none',border:'none',color:'var(--t3)',cursor:'pointer',fontSize:22}}>×</button>
        </div>

        {/* Progress steps */}
        <div style={{padding:'8px 20px',borderBottom:'1px solid var(--bdr)',display:'flex',gap:4,alignItems:'center'}}>
          {['select','pin','reason','tender'].map((s,i,arr)=>{
            const done=['select','pin','reason','tender','cash_confirm','card_terminal'].indexOf(step)>i;
            const active=step===s||(step==='cash_confirm'&&s==='tender')||(step==='card_terminal'&&s==='tender');
            return(<>
              <div key={s} style={{display:'flex',alignItems:'center',gap:4}}>
                <div style={{width:20,height:20,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:700,
                  background:done?'var(--grn)':active?'var(--acc-d)':'var(--bg4)',
                  border:`2px solid ${done?'var(--grn)':active?'var(--acc)':'var(--bdr2)'}`,
                  color:done?'#fff':active?'var(--acc)':'var(--t4)'}}>
                  {done?'✓':i+1}
                </div>
                <span style={{fontSize:10,fontWeight:600,color:done?'var(--grn)':active?'var(--acc)':'var(--t4)',textTransform:'capitalize'}}>{s}</span>
              </div>
              {i<arr.length-1&&<div style={{flex:1,height:1,background:'var(--bdr)'}}/>}
            </>);
          })}
        </div>

        <div style={{padding:'16px 20px'}}>

          {/* ── Step 1: Select items ── */}
          {step==='select'&&(
            <>
              {/* Full check toggle */}
              <div onClick={toggleFull} style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'12px 14px',borderRadius:12,cursor:'pointer',marginBottom:14,border:`1.5px solid ${isFullRefund?'var(--acc)':'var(--bdr)'}`,background:isFullRefund?'var(--acc-d)':'var(--bg3)'}}>
                <div>
                  <div style={{fontSize:13,fontWeight:700,color:isFullRefund?'var(--acc)':'var(--t1)'}}>Entire check</div>
                  <div style={{fontSize:11,color:'var(--t3)',marginTop:1}}>Refund all remaining items</div>
                </div>
                <span style={{fontSize:14,fontWeight:800,color:isFullRefund?'var(--acc)':'var(--t2)',fontFamily:'DM Mono,monospace'}}>−{money(check.subtotal)}</span>
              </div>
              <div style={{fontSize:11,fontWeight:700,color:'var(--t2)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:8}}>Or select items</div>
              {check.items.map(item=>{
                const alreadyRefunded=refundedQtys[item.uid]||0;
                const remaining=item.qty-alreadyRefunded;
                const sel=selections[item.uid];
                const isOn=sel?.selected;
                if(remaining<=0)return(
                  <div key={item.uid} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',borderRadius:8,marginBottom:4,opacity:.4}}>
                    <div style={{width:16,height:16,borderRadius:3,border:'2px solid var(--red-b)',background:'var(--red-d)',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                      <div style={{width:8,height:2,background:'var(--red)',borderRadius:1}}/>
                    </div>
                    <span style={{flex:1,fontSize:12,color:'var(--t3)'}}>{item.name}</span>
                    <span style={{fontSize:10,color:'var(--red)'}}>refunded</span>
                  </div>
                );
                return(
                  <div key={item.uid} style={{marginBottom:4}}>
                    <div onClick={()=>toggleItem(item.uid)} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',borderRadius:8,cursor:'pointer',background:isOn?'var(--bg3)':'transparent',border:`1px solid ${isOn?'var(--bdr2)':'transparent'}`}}>
                      <div style={{width:16,height:16,borderRadius:3,border:`2px solid ${isOn?'var(--acc)':'var(--bdr2)'}`,background:isOn?'var(--acc)':'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                        {isOn&&<div style={{width:8,height:8,background:'#0e0f14',borderRadius:1}}/>}
                      </div>
                      <div style={{flex:1}}>
                        <div style={{fontSize:12,fontWeight:600,color:isOn?'var(--t1)':'var(--t2)'}}>{item.qty>1?`${item.qty}× `:''}{item.name}</div>
                        {item.mods?.length>0&&<div style={{fontSize:10,color:'var(--t3)'}}>{item.mods.map(m=>m.label).join(', ')}</div>}
                      </div>
                      <div style={{textAlign:'right',flexShrink:0}}>
                        <div style={{fontSize:12,fontWeight:700,color:isOn?'var(--acc)':'var(--t3)',fontFamily:'DM Mono,monospace'}}>{money(item.price)}</div>
                        {alreadyRefunded>0&&<div style={{fontSize:10,color:'var(--red)'}}>{alreadyRefunded} refunded</div>}
                      </div>
                    </div>
                    {isOn&&remaining>1&&(
                      <div style={{display:'flex',alignItems:'center',gap:8,paddingLeft:36,paddingBottom:4}}>
                        <span style={{fontSize:11,color:'var(--t3)'}}>Qty:</span>
                        <div style={{display:'flex',alignItems:'center',gap:4,background:'var(--bg3)',border:'1px solid var(--bdr)',borderRadius:6,overflow:'hidden'}}>
                          <button onClick={()=>setQty(item.uid,Math.max(1,(sel.qty||1)-1))} style={{width:24,height:22,background:'transparent',border:'none',color:'var(--t2)',fontSize:14,cursor:'pointer',fontFamily:'inherit'}}>−</button>
                          <div style={{width:24,textAlign:'center',fontSize:12,fontWeight:700,color:'var(--t1)'}}>{sel.qty||1}</div>
                          <button onClick={()=>setQty(item.uid,Math.min(remaining,(sel.qty||1)+1))} style={{width:24,height:22,background:'transparent',border:'none',color:'var(--t2)',fontSize:14,cursor:'pointer',fontFamily:'inherit'}}>+</button>
                        </div>
                        <span style={{fontSize:11,color:'var(--t4)'}}>of {remaining} remaining</span>
                      </div>
                    )}
                  </div>
                );
              })}
              {refundTotal>0&&<div style={{display:'flex',justifyContent:'space-between',fontSize:16,fontWeight:800,borderTop:'1px solid var(--bdr)',paddingTop:12,marginTop:12}}>
                <span style={{color:'var(--t2)'}}>Refund total</span>
                <span style={{color:'var(--red)',fontFamily:'DM Mono,monospace'}}>−{money(refundTotal)}</span>
              </div>}
              <div style={{display:'flex',gap:8,marginTop:16}}>
                <button className="btn btn-ghost" style={{flex:1}} onClick={onCancel}>Cancel</button>
                <button className="btn btn-acc" style={{flex:2,height:44}} disabled={!selectedItems.length} onClick={()=>setStep(managerLoggedIn ? 'reason' : 'pin')}>Authorise →</button>
              </div>
            </>
          )}

          {/* ── Step 2: Manager PIN ── */}
          {step==='pin'&&(
            <>
              <div style={{padding:'10px 14px',borderRadius:10,background:'var(--bg3)',border:'1px solid var(--bdr)',marginBottom:16,display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <span style={{fontSize:12,color:'var(--t3)'}}>{selectedItems.length} item{selectedItems.length!==1?'s':''} · manager PIN required</span>
                <span style={{fontSize:14,fontWeight:800,color:'var(--red)',fontFamily:'DM Mono,monospace'}}>−{money(refundTotal)}</span>
              </div>
              <div style={{display:'flex',justifyContent:'center',gap:12,marginBottom:pinErr?8:20}}>
                {[0,1,2,3].map(i=><div key={i} style={{width:14,height:14,borderRadius:'50%',background:i<pin.length?'var(--acc)':'var(--bg4)',border:`2px solid ${i<pin.length?'var(--acc)':'var(--bdr2)'}`,transition:'all .15s'}}/>)}
              </div>
              {pinErr&&<div style={{textAlign:'center',fontSize:12,color:'var(--red)',marginBottom:16,fontWeight:600}}>{pinErr}</div>}
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,maxWidth:240,margin:'0 auto 16px'}}>
                {[1,2,3,4,5,6,7,8,9,'',0,'⌫'].map((d,i)=>(
                  <button key={i} onClick={()=>d==='⌫'?setPin(p=>p.slice(0,-1)):d!==''?handleDigit(String(d)):null}
                    style={{height:52,borderRadius:12,cursor:d===''?'default':'pointer',background:d===''?'transparent':'var(--bg3)',border:d===''?'none':'1px solid var(--bdr2)',color:d==='⌫'?'var(--t3)':'var(--t1)',fontSize:d==='⌫'?18:20,fontWeight:700,fontFamily:'inherit',opacity:d===''?0:1}}>{d}
                  </button>
                ))}
              </div>
              <button className="btn btn-ghost btn-full" onClick={()=>setStep('select')}>← Back</button>
            </>
          )}

          {/* ── Step 3: Reason ── */}
          {step==='reason'&&(
            <>
              <div style={{display:'flex',alignItems:'center',gap:8,padding:'8px 12px',borderRadius:10,background:'var(--grn-d)',border:'1px solid var(--grn-b)',marginBottom:16}}>
                <span style={{color:'var(--grn)',fontWeight:700}}>✓ Authorised by {manager?.name}</span>
              </div>
              <div style={{fontSize:11,fontWeight:700,color:'var(--t2)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:8}}>Reason for refund</div>
              <div style={{display:'flex',flexDirection:'column',gap:5,marginBottom:14}}>
                {REFUND_REASONS.map(r=>(
                  <button key={r} onClick={()=>setReason(r)} style={{padding:'10px 14px',borderRadius:10,cursor:'pointer',textAlign:'left',fontFamily:'inherit',border:`1.5px solid ${reason===r?'var(--acc)':'var(--bdr)'}`,background:reason===r?'var(--acc-d)':'var(--bg3)',color:reason===r?'var(--acc)':'var(--t2)',fontSize:13}}>{r}</button>
                ))}
              </div>
              {reason==='Other'&&<input className="input" placeholder="Describe the reason…" value={freeText} onChange={e=>setFreeText(e.target.value)} style={{marginBottom:14}} autoFocus/>}
              <div style={{display:'flex',gap:8}}>
                <button className="btn btn-ghost" style={{flex:1}} onClick={()=>setStep(managerLoggedIn ? 'select' : 'pin')}>← Back</button>
                <button className="btn btn-acc" style={{flex:2,height:44}}
                  disabled={!reason||(reason==='Other'&&!freeText.trim())}
                  onClick={()=>setStep('tender')}>Choose tender →</button>
              </div>
            </>
          )}

          {/* ── Step 4: Tender ── */}
          {step==='tender'&&(
            <>
              <div style={{textAlign:'center',marginBottom:20}}>
                <div style={{fontSize:28,fontWeight:800,color:'var(--red)',fontFamily:'DM Mono,monospace',marginBottom:4}}>−{money(refundTotal)}</div>
                <div style={{fontSize:12,color:'var(--t3)'}}>How should this refund be tendered?</div>
              </div>
              {/* Original method note */}
              <div style={{padding:'8px 12px',borderRadius:8,background:'var(--bg3)',border:'1px solid var(--bdr)',marginBottom:14,fontSize:12,color:'var(--t3)',display:'flex',alignItems:'center',gap:8}}>
                <span>{METHOD_ICON[check.method]||'💳'}</span>
                <span>Originally paid by <strong style={{color:'var(--t2)'}}>{check.method}</strong> — refund to same method is recommended</span>
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:8,marginBottom:16}}>
                <button onClick={()=>handleTender('card')} style={{padding:'16px 18px',borderRadius:12,cursor:'pointer',fontFamily:'inherit',textAlign:'left',display:'flex',alignItems:'center',gap:14,background:'var(--bg3)',border:'1.5px solid var(--bdr)'}}>
                  <span style={{fontSize:28}}>💳</span>
                  <div>
                    <div style={{fontSize:14,fontWeight:700,color:'var(--t1)'}}>Return to card</div>
                    <div style={{fontSize:11,color:'var(--t3)',marginTop:2}}>Processed via Stripe Terminal · 1–3 business days</div>
                  </div>
                </button>
                <button onClick={()=>handleTender('cash')} style={{padding:'16px 18px',borderRadius:12,cursor:'pointer',fontFamily:'inherit',textAlign:'left',display:'flex',alignItems:'center',gap:14,background:'var(--bg3)',border:'1.5px solid var(--bdr)'}}>
                  <span style={{fontSize:28}}>💵</span>
                  <div>
                    <div style={{fontSize:14,fontWeight:700,color:'var(--t1)'}}>Cash payout</div>
                    <div style={{fontSize:11,color:'var(--t3)',marginTop:2}}>Hand back from cash drawer immediately</div>
                  </div>
                </button>
              </div>
              <button className="btn btn-ghost btn-full" onClick={()=>setStep('reason')}>← Back</button>
            </>
          )}

          {/* ── Step 4b: Cash confirm ── */}
          {step==='cash_confirm'&&(
            <>
              <div style={{textAlign:'center',padding:'20px 0 24px'}}>
                <div style={{fontSize:48,marginBottom:12}}>💵</div>
                <div style={{fontSize:28,fontWeight:800,color:'var(--red)',fontFamily:'DM Mono,monospace',marginBottom:6}}>{money(refundTotal)}</div>
                <div style={{fontSize:14,color:'var(--t2)',marginBottom:20}}>Hand this amount back to the guest from the cash drawer</div>
                <div style={{display:'flex',flexDirection:'column',gap:6,background:'var(--bg3)',border:'1px solid var(--bdr)',borderRadius:12,padding:'12px 16px',textAlign:'left',marginBottom:20}}>
                  <div style={{fontSize:12,color:'var(--t3)',fontWeight:600}}>Summary</div>
                  {selectedItems.map((i,idx)=>(
                    <div key={idx} style={{display:'flex',justifyContent:'space-between',fontSize:12,color:'var(--t2)'}}>
                      <span>{i.refundQty}× {i.name}</span>
                      <span style={{fontFamily:'DM Mono,monospace'}}>{money((i.price*i.refundQty))}</span>
                    </div>
                  ))}
                  <div style={{borderTop:'1px solid var(--bdr)',paddingTop:6,marginTop:4,display:'flex',justifyContent:'space-between',fontWeight:700,fontSize:13}}>
                    <span>Cash to return</span>
                    <span style={{color:'var(--red)',fontFamily:'DM Mono,monospace'}}>{money(refundTotal)}</span>
                  </div>
                </div>
                <div style={{display:'flex',gap:8}}>
                  <button className="btn btn-ghost" style={{flex:1}} onClick={()=>setStep('tender')}>← Back</button>
                  <button className="btn btn-grn" style={{flex:2,height:44}} onClick={handleComplete}>Cash handed back ✓</button>
                </div>
              </div>
            </>
          )}

          {/* ── Step 4c: Card terminal ── */}
          {step==='card_terminal'&&(
            <>
              <div style={{textAlign:'center',padding:'20px 0 24px'}}>
                <div style={{fontSize:48,marginBottom:12}}>💳</div>
                <div style={{fontSize:28,fontWeight:800,color:'var(--red)',fontFamily:'DM Mono,monospace',marginBottom:6}}>−{money(refundTotal)}</div>
                <div style={{fontSize:14,color:'var(--t2)',marginBottom:8}}>Refund to original card via Stripe Terminal</div>
                <div style={{fontSize:12,color:'var(--t3)',marginBottom:20}}>Customer does not need to re-present their card. Funds appear in 1–3 business days.</div>
                <div style={{display:'inline-flex',alignItems:'center',gap:8,padding:'10px 20px',background:'var(--acc-d)',border:'1px solid var(--acc-b)',borderRadius:20,fontSize:13,color:'var(--acc)',marginBottom:24}}>
                  <div style={{width:8,height:8,borderRadius:'50%',background:'var(--acc)'}}/>
                  Processing refund…
                </div>
                <br/>
                <div style={{display:'flex',gap:8,marginTop:8}}>
                  <button className="btn btn-ghost" style={{flex:1}} onClick={()=>setStep('tender')}>← Back</button>
                  <button className="btn btn-grn" style={{flex:2,height:44}} onClick={handleComplete}>Refund confirmed ✓</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Check History Panel ───────────────────────────────────────────────────────
export default function CheckHistory(){
  const {closedChecks,refundCheck,showToast,location,taxRates}=useStore();
  const [search,setSearch]=useState('');
  const [dateFilter,setDateFilter]=useState('today');
  const [selected,setSelected]=useState(null);
  const [showRefund,setShowRefund]=useState(false);
  const [reprinting,setReprinting]=useState(false);

  const selectedCheck=closedChecks.find(c=>c.id===selected);
  const now=new Date();
  const startOfDay=new Date(now.getFullYear(),now.getMonth(),now.getDate());
  const startOfWeek=new Date(startOfDay.getTime()-startOfDay.getDay()*86400000);

  const filtered=useMemo(()=>closedChecks.filter(c=>{
    const d=new Date(c.closedAt);
    if(dateFilter==='today'&&d<startOfDay)return false;
    if(dateFilter==='week'&&d<startOfWeek)return false;
    if(search){
      const q=search.toLowerCase();
      return c.ref?.toLowerCase().includes(q)||c.tableLabel?.toLowerCase().includes(q)||c.server?.toLowerCase().includes(q)||c.customer?.name?.toLowerCase().includes(q);
    }
    return true;
  }),[closedChecks,dateFilter,search]);

  const totals=useMemo(()=>({
    count:filtered.length,
    revenue:filtered.reduce((s,c)=>s+c.total,0),
    refunds:filtered.reduce((s,c)=>s+c.refunds.reduce((r,rf)=>r+rf.amount,0),0),
  }),[filtered]);

  const handleRefund=(opts)=>{
    refundCheck(selectedCheck.id,opts);
    setShowRefund(false);
    showToast(`Refund of ${money(opts.amount)} processed — ${opts.tenderMethod}`,'success');
  };

  const handleReprint = async () => {
    if (!selectedCheck || reprinting) return;
    setReprinting(true);
    try {
      // Build a fresh tax breakdown from the stored items so the reprinted
      // receipt matches what was printed originally.
      const nonVoided = (selectedCheck.items || []).filter(i => !i.voided);
      let taxBreakdown = null;
      if (taxRates?.length) {
        try {
          taxBreakdown = calculateOrderTax(nonVoided, taxRates, selectedCheck.orderType || 'dine-in');
        } catch {}
      }
      const result = await printService.printReceipt({
        location,
        check: {
          ref: selectedCheck.ref,
          server: selectedCheck.server,
          tableLabel: selectedCheck.tableLabel,
          orderType: selectedCheck.orderType,
          covers: selectedCheck.covers,
          method: selectedCheck.method,
          customer: selectedCheck.customer,
          // v5.5.720: carry the card-scheme block into re-prints (in-memory checks stamp
          // cardReceipt; DB-loaded checks carry it on paymentIntents[0].card)
          cardReceipt: selectedCheck.cardReceipt || null,
          paymentIntents: selectedCheck.paymentIntents || selectedCheck.payment_intents || null,
        },
        items: nonVoided,
        totals: {
          subtotal: selectedCheck.subtotal,
          service: selectedCheck.service || 0,
          tip: selectedCheck.tip || 0,
          grand: selectedCheck.total,
          taxBreakdown,
        },
      }, null, {
        // Distinct idempotency key so a reprint is never deduped against the
        // original close-check print.
        idempotencyKey: `reprint-${selectedCheck.ref}-${Date.now()}`,
        // v5.5.835: user-initiated reprint. Keeps the browser-print fallback so a
        // back-office laptop with no thermal printer can still print / save a PDF.
        allowBrowserFallback: true,
      });
      if (result?.ok === false) {
        showToast(`Reprint failed: ${result.error || 'unknown error'}`, 'error');
      } else {
        showToast(`Reprinted ${selectedCheck.ref}`, 'success');
      }
    } catch (err) {
      showToast(`Reprint failed: ${err?.message || err}`, 'error');
    } finally {
      setReprinting(false);
    }
  };

  return(
    <div style={{flex:1,display:'flex',overflow:'hidden'}}>

      {/* Left: list */}
      <div style={{width:280,flexShrink:0,display:'flex',flexDirection:'column',borderRight:'1px solid var(--bdr2)',overflow:'hidden',background:'var(--bg1)'}}>
        <div style={{padding:'10px 12px',borderBottom:'1px solid var(--bdr)',flexShrink:0}}>
          <div style={{position:'relative',marginBottom:8}}>
            <span style={{position:'absolute',left:10,top:'50%',transform:'translateY(-50%)',color:'var(--t3)',fontSize:13}}>🔍</span>
            <input className="input" placeholder="Ref, table, server…" value={search} onChange={e=>setSearch(e.target.value)} style={{paddingLeft:30,height:32,fontSize:12}}/>
            {search&&<button onClick={()=>setSearch('')} style={{position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',color:'var(--t3)',cursor:'pointer',fontSize:14}}>×</button>}
          </div>
          <div style={{display:'flex',gap:4,marginBottom:8}}>
            {[['today','Today'],['week','Week'],['all','All']].map(([f,l])=>(
              <button key={f} onClick={()=>setDateFilter(f)} style={{flex:1,padding:'4px',borderRadius:7,cursor:'pointer',fontFamily:'inherit',border:`1px solid ${dateFilter===f?'var(--acc-b)':'var(--bdr)'}`,background:dateFilter===f?'var(--acc-d)':'transparent',color:dateFilter===f?'var(--acc)':'var(--t3)',fontSize:11,fontWeight:600}}>{l}</button>
            ))}
          </div>
          <div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:'var(--t3)'}}>
            <span>{totals.count} check{totals.count!==1?'s':''}</span>
            <span style={{fontFamily:'DM Mono,monospace',color:'var(--t2)'}}>{money(totals.revenue)}</span>
          </div>
          {totals.refunds>0&&<div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:'var(--red)',marginTop:2}}>
            <span>↩ Refunded</span>
            <span style={{fontFamily:'DM Mono,monospace'}}>−{money(totals.refunds)}</span>
          </div>}
        </div>

        <div style={{flex:1,overflowY:'auto',padding:'6px 8px'}}>
          {filtered.length===0&&<div style={{textAlign:'center',padding:'40px 0',color:'var(--t3)'}}>
            <div style={{fontSize:32,marginBottom:8,opacity:.4}}>🧾</div>
            <div style={{fontSize:13,fontWeight:600,color:'var(--t2)',marginBottom:4}}>No checks</div>
            <div style={{fontSize:12}}>Completed orders appear here</div>
          </div>}
          {filtered.map(chk=>{
            const sm=STATUS_META[chk.status]||STATUS_META.paid;
            const isActive=selected===chk.id;
            const totalRefunded=chk.refunds.reduce((s,r)=>s+r.amount,0);
            return(
              <div key={chk.id} onClick={()=>setSelected(chk.id)} style={{
                padding:'10px',borderRadius:10,marginBottom:5,cursor:'pointer',
                background:isActive?'var(--bg3)':'var(--bg2)',
                border:`1.5px solid ${isActive?'var(--acc-b)':'var(--bdr)'}`,
              }}>
                <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:3}}>
                  <div style={{display:'flex',alignItems:'center',gap:6}}>
                    <span style={{fontSize:12,fontWeight:800,color:'var(--t1)',fontFamily:'DM Mono,monospace'}}>{chk.ref}</span>
                    <span style={{fontSize:10,fontWeight:700,padding:'1px 6px',borderRadius:20,background:sm.bg,color:sm.color,border:`1px solid ${sm.border}`}}>{sm.label}</span>
                  </div>
                  <span style={{fontSize:13,fontWeight:700,color:'var(--acc)',fontFamily:'DM Mono,monospace'}}>{money(chk.total)}</span>
                </div>
                <div style={{display:'flex',justifyContent:'space-between',fontSize:11,color:'var(--t3)',marginBottom:totalRefunded>0?3:0}}>
                  <span>{chk.tableLabel||chk.customer?.name||chk.orderType} · {chk.server}</span>
                  <span>{fmtTime(chk.closedAt)}</span>
                </div>
                {totalRefunded>0&&<div style={{fontSize:11,color:'var(--red)',fontFamily:'DM Mono,monospace'}}>↩ −{money(totalRefunded)} refunded</div>}
                <div style={{display:'flex',alignItems:'center',gap:5,marginTop:3}}>
                  <span style={{fontSize:11}}>{METHOD_ICON[chk.method]||'💳'}</span>
                  <span style={{fontSize:10,color:'var(--t4)'}}>{chk.items.length} items{chk.covers>1?` · ${chk.covers} cvr`:''}{chk.tip>0?` · tip ${money(chk.tip)}`:''}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Right: detail */}
      <div style={{flex:1,display:'flex',flexDirection:'column',overflow:'hidden'}}>
        {!selectedCheck?(
          <div style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',color:'var(--t3)',padding:24,textAlign:'center'}}>
            <div style={{fontSize:40,marginBottom:12,opacity:.4}}>🧾</div>
            <div style={{fontSize:14,fontWeight:600,color:'var(--t2)',marginBottom:6}}>Select a check</div>
            <div style={{fontSize:12,lineHeight:1.6}}>Tap a check to view the full audit trail and issue refunds</div>
          </div>
        ):(
          <>
            {/* Check header */}
            <div style={{padding:'14px 18px',borderBottom:'1px solid var(--bdr)',flexShrink:0}}>
              {(()=>{
                const sm=STATUS_META[selectedCheck.status]||STATUS_META.paid;
                const totalRefunded=selectedCheck.refunds.reduce((s,r)=>s+r.amount,0);
                return(
                  <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',gap:16}}>
                    <div>
                      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:4}}>
                        <span style={{fontSize:16,fontWeight:800,color:'var(--t1)',fontFamily:'DM Mono,monospace'}}>{selectedCheck.ref}</span>
                        <span style={{fontSize:11,fontWeight:700,padding:'2px 8px',borderRadius:20,background:sm.bg,color:sm.color,border:`1px solid ${sm.border}`}}>{sm.label}</span>
                      </div>
                      <div style={{fontSize:12,color:'var(--t3)',lineHeight:1.8}}>
                        {selectedCheck.tableLabel||selectedCheck.orderType}{selectedCheck.server?` · ${selectedCheck.server}`:''}{selectedCheck.covers>1?` · ${selectedCheck.covers} covers`:''}{selectedCheck.customer?.name?` · ${selectedCheck.customer.name}`:''}
                        <br/>
                        {METHOD_ICON[selectedCheck.method]||'💳'} paid by {selectedCheck.method} · {fmtTime(selectedCheck.closedAt)}
                      </div>
                    </div>
                    <div style={{textAlign:'right',flexShrink:0}}>
                      <div style={{fontSize:22,fontWeight:800,color:'var(--acc)',fontFamily:'DM Mono,monospace'}}>{money(selectedCheck.total)}</div>
                      {totalRefunded>0&&<div style={{fontSize:12,color:'var(--red)',fontFamily:'DM Mono,monospace'}}>↩ −{money(totalRefunded)}</div>}
                      {totalRefunded>0&&<div style={{fontSize:11,color:'var(--t3)'}}>net {money((selectedCheck.total-totalRefunded))}</div>}
                    </div>
                  </div>
                );
              })()}
            </div>

            <div style={{flex:1,overflowY:'auto',padding:'12px 18px'}}>

              {/* Items */}
              <div style={{fontSize:11,fontWeight:700,color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:8}}>Items</div>
              {selectedCheck.items.map((item,i)=>{
                const refundedQty=selectedCheck.refunds.reduce((s,r)=>{
                  const ri=r.items.find(ri=>ri.uid===item.uid);
                  return s+(ri?.refundQty||0);
                },0);
                const fullyRefunded=refundedQty>=item.qty;
                return(
                  <div key={i} style={{display:'flex',justifyContent:'space-between',marginBottom:6,padding:'7px 0',borderBottom:'1px solid var(--bdr)',opacity:fullyRefunded?.5:1}}>
                    <div style={{flex:1}}>
                      <div style={{fontSize:13,fontWeight:500,color:fullyRefunded?'var(--t4)':'var(--t2)',textDecoration:fullyRefunded?'line-through':'none'}}>
                        {item.qty>1?`${item.qty}× `:''}{item.name}
                        {refundedQty>0&&!fullyRefunded&&<span style={{fontSize:10,color:'var(--acc)',marginLeft:6,fontWeight:600}}>{item.qty-refundedQty} remaining</span>}
                        {fullyRefunded&&<span style={{fontSize:10,color:'var(--red)',marginLeft:6}}>refunded</span>}
                      </div>
                      {item.mods?.length>0&&<div style={{fontSize:11,color:'var(--t3)'}}>{item.mods.map(m=>m.label).join(', ')}</div>}
                      {item.notes&&<div style={{fontSize:11,color:'#f97316',fontStyle:'italic'}}>{item.notes}</div>}
                    </div>
                    <span style={{fontSize:13,fontWeight:600,color:'var(--t2)',fontFamily:'DM Mono,monospace',flexShrink:0}}>{money((item.price*item.qty))}</span>
                  </div>
                );
              })}

              {/* Totals */}
              <div style={{padding:'10px 0',marginBottom:12}}>
                <div style={{display:'flex',justifyContent:'space-between',fontSize:12,color:'var(--t3)',marginBottom:3}}><span>Subtotal</span><span style={{fontFamily:'DM Mono,monospace'}}>{money(selectedCheck.subtotal)}</span></div>
                {selectedCheck.service>0&&<div style={{display:'flex',justifyContent:'space-between',fontSize:12,color:'var(--t3)',marginBottom:3}}><span>Service (12.5%)</span><span style={{fontFamily:'DM Mono,monospace'}}>{money(selectedCheck.service)}</span></div>}
                {selectedCheck.tip>0&&<div style={{display:'flex',justifyContent:'space-between',fontSize:12,color:'var(--t3)',marginBottom:3}}><span>Tip</span><span style={{fontFamily:'DM Mono,monospace'}}>{money(selectedCheck.tip)}</span></div>}
                <div style={{display:'flex',justifyContent:'space-between',fontSize:16,fontWeight:700,borderTop:'1px solid var(--bdr3)',paddingTop:8,marginTop:4}}>
                  <span>Total paid</span><span style={{color:'var(--acc)',fontFamily:'DM Mono,monospace'}}>{money(selectedCheck.total)}</span>
                </div>
              </div>

              {/* Refund audit trail */}
              {selectedCheck.refunds.length>0&&(
                <div style={{background:'var(--red-d)',border:'1px solid var(--red-b)',borderRadius:12,padding:'12px 14px',marginBottom:12}}>
                  <div style={{fontSize:11,fontWeight:700,color:'var(--red)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:10}}>↩ Refund history</div>
                  {selectedCheck.refunds.map((r,i)=>(
                    <div key={i} style={{marginBottom:i<selectedCheck.refunds.length-1?12:0,paddingBottom:i<selectedCheck.refunds.length-1?12:0,borderBottom:i<selectedCheck.refunds.length-1?'1px solid var(--red-b)':'none'}}>
                      <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start',marginBottom:4}}>
                        <div>
                          <div style={{fontSize:13,fontWeight:700,color:'var(--red)',fontFamily:'DM Mono,monospace'}}>−{money(r.amount)}</div>
                          <div style={{fontSize:11,color:'var(--t3)',marginTop:1}}>{fmtTime(r.timestamp)} · {r.manager}</div>
                        </div>
                        <div style={{textAlign:'right'}}>
                          <span style={{fontSize:11,fontWeight:700,padding:'2px 7px',borderRadius:20,background:r.tenderMethod==='cash'?'var(--bg3)':'var(--bg3)',color:'var(--t2)',border:'1px solid var(--bdr)'}}>
                            {METHOD_ICON[r.tenderMethod]||'💳'} {r.tenderMethod==='cash'?'Cash':'Card'}
                          </span>
                        </div>
                      </div>
                      <div style={{fontSize:11,color:'var(--t3)',marginBottom:3}}>Reason: {r.reason}</div>
                      <div style={{fontSize:11,color:'var(--t3)'}}>{r.items.map(ri=>`${ri.refundQty}× ${ri.name}`).join(', ')}</div>
                    </div>
                  ))}
                  {/* Net summary */}
                  <div style={{borderTop:'1px solid var(--red-b)',paddingTop:8,marginTop:10,display:'flex',justifyContent:'space-between',fontSize:12,fontWeight:700}}>
                    <span style={{color:'var(--red)'}}>Total refunded</span>
                    <span style={{color:'var(--red)',fontFamily:'DM Mono,monospace'}}>−{money(selectedCheck.refunds.reduce((s,r)=>s+r.amount,0))}</span>
                  </div>
                  <div style={{display:'flex',justifyContent:'space-between',fontSize:12,fontWeight:700,marginTop:3}}>
                    <span style={{color:'var(--t2)'}}>Net revenue</span>
                    <span style={{color:'var(--acc)',fontFamily:'DM Mono,monospace'}}>{money((selectedCheck.total-selectedCheck.refunds.reduce((s,r)=>s+r.amount,0)))}</span>
                  </div>
                </div>
              )}
            </div>

            {/* Reprint + Refund CTAs */}
            <div style={{padding:'12px 18px',borderTop:'1px solid var(--bdr)',flexShrink:0,display:'flex',gap:8}}>
              <button onClick={handleReprint} disabled={reprinting} style={{flex:selectedCheck.status!=='refunded'?1:undefined,width:selectedCheck.status==='refunded'?'100%':undefined,height:42,borderRadius:10,cursor:reprinting?'wait':'pointer',fontFamily:'inherit',background:'var(--bg3)',border:'1px solid var(--bdr2)',color:'var(--t2)',fontSize:13,fontWeight:700,opacity:reprinting?0.6:1}}>
                {reprinting ? '…' : '🖨 Print receipt'}
              </button>
              {selectedCheck.status!=='refunded'&&(
                <button onClick={()=>setShowRefund(true)} style={{flex:1,height:42,borderRadius:10,cursor:'pointer',fontFamily:'inherit',background:'var(--red-d)',border:'1px solid var(--red-b)',color:'var(--red)',fontSize:13,fontWeight:700}}>
                  ↩ Issue refund
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {showRefund&&selectedCheck&&(
        <RefundModal check={selectedCheck} onConfirm={handleRefund} onCancel={()=>setShowRefund(false)}/>
      )}
    </div>
  );
}
