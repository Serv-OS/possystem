import { useState } from 'react';
import { useStore } from '../store';
import { money, currencySymbol } from '../lib/currency';

const FALLBACK_PRESETS = [
  { id:'staff50',  label:'Staff meal',       type:'percent', value:50,  requiresManager:false },
  { id:'staff_d',  label:'Staff drinks',      type:'percent', value:50,  requiresManager:false },
  { id:'loyalty',  label:'Loyalty 10%',       type:'percent', value:10,  requiresManager:false },
  { id:'nhs',      label:'NHS / Blue Light',  type:'percent', value:10,  requiresManager:false },
  { id:'happy',    label:'Happy hour 20%',    type:'percent', value:20,  requiresManager:false },
  { id:'comp',     label:'Comp (100%)',        type:'percent', value:100, requiresManager:true  },
];

const managersFrom = (staffMembers) =>
  (staffMembers || [])
    .filter(s => s.role === 'Manager' && s.active !== false)
    .map(s => ({ pin: s.pin, name: s.name, id: s.id }));

export default function DiscountModal({ items, subtotal, onConfirm, onCancel }) {
  const { staffMembers, staff: currentUser, discountPresets } = useStore();
  // Use DB-driven presets if available, otherwise fall back to hardcoded defaults
  const PRESETS = discountPresets?.length
    ? discountPresets.map(d => ({
        id: d.id, label: d.label || d.name, type: d.type, value: d.value,
        requiresManager: d.requiresManager ?? false,
        // v5.5.641: carry scope + categoryIds so a category-scoped preset auto-targets
        // the matching items instead of asking the operator to pick them by hand.
        scope: d.scope || 'global',
        categoryIds: d.categoryIds || d.category_ids || [],
      }))
    : FALLBACK_PRESETS;
  const mgrs = managersFrom(staffMembers);
  const managerLoggedIn = currentUser?.role === 'Manager';

  const [step, setStep]         = useState('amount');  // amount | apply | pin
  const [selected, setSelected] = useState(null);       // preset id or 'custom'
  const [customType, setCT]     = useState('percent');
  const [customVal, setCV]      = useState('');
  const [scope, setScope]       = useState('check');    // 'check' | 'items'
  const [itemSel, setItemSel]   = useState([]);         // selected item uids
  const [pin, setPin]           = useState('');
  const [pinErr, setPinErr]     = useState('');
  const [manager, setManager]   = useState(managerLoggedIn ? currentUser : null);

  const preset  = PRESETS.find(p=>p.id===selected);
  const needPin = preset?.requiresManager && !manager;

  const calcAmount = (base) => {
    if (selected==='custom') {
      const v = parseFloat(customVal)||0;
      return customType==='percent' ? base*v/100 : Math.min(v, base);
    }
    if (preset) return preset.type === 'amount' ? Math.min(preset.value, base) : base * preset.value / 100;
    return 0;
  };

  const canAdvance = selected && (selected!=='custom' || (parseFloat(customVal)>0));

  // Items that belong to the selected preset's category scope (auto-target — Bug fix:
  // a category-scoped preset should know its own items, not ask the operator to pick).
  const itemInCats = (item, cats) => !!cats?.length && (cats.includes(item.cat) || (Array.isArray(item.cats) && item.cats.some(c => cats.includes(c))));
  const categoryUids = (preset?.scope === 'category' && preset.categoryIds?.length)
    ? items.filter(i => !i.voided && itemInCats(i, preset.categoryIds)).map(i => i.uid)
    : null;

  // Build + emit the discount. Manager is passed explicitly so the auto-apply-after-PIN
  // path doesn't read the not-yet-committed manager state.
  const buildDiscount = (scopeVal, uids, mgr) => {
    const activeItems = scopeVal==='check'
      ? items.filter(i=>!i.voided)
      : items.filter(i=>uids.includes(i.uid)&&!i.voided);
    const base = scopeVal==='check' ? subtotal : activeItems.reduce((s,i)=>s+i.price*i.qty, 0);
    const amount = calcAmount(base);
    const label  = selected==='custom'
      ? `Custom ${customType==='percent'?customVal+'%':money(parseFloat(customVal))}`
      : preset.label;
    const type   = selected==='custom' ? customType : preset.type;
    const value  = selected==='custom' ? parseFloat(customVal)||0 : preset.value;
    onConfirm({
      id:`disc-${Date.now()}`, label, type, value, scope: scopeVal,
      itemUids: scopeVal==='items' ? activeItems.map(i=>i.uid) : null,
      amount, manager: mgr,
    });
  };

  // After the amount (+ any manager auth) is chosen: a category-scoped preset AUTO-APPLIES
  // to its matching items with no manual picking; everything else goes to the apply step.
  const proceedAfterAuth = (mgr) => {
    if (categoryUids && categoryUids.length) { buildDiscount('items', categoryUids, mgr); return; }
    // Category preset but nothing in the basket matches → show step 2 (don't silently apply £0).
    if (preset?.scope === 'category') { setScope('items'); setItemSel([]); }
    setStep('apply');
  };

  const handleAdvance = () => {
    if (needPin) { setStep('pin'); return; }
    proceedAfterAuth(manager);
  };

  const handleApply = () => buildDiscount(scope, itemSel, manager);

  const toggleItem = (uid) =>
    setItemSel(s => s.includes(uid) ? s.filter(x=>x!==uid) : [...s, uid]);

  const handleDigit = (d) => {
    if (pin.length>=4) return;
    const next = pin+d;
    setPin(next);
    if (next.length===4) {
      const m = mgrs.find(x=>x.pin===next);
      if (m) { setManager(m); setPinErr(''); setTimeout(()=>proceedAfterAuth(m),200); }
      else   { setPinErr('Incorrect manager PIN'); setTimeout(()=>setPin(''),600); }
    }
  };

  const visibleItems = items.filter(i=>!i.voided);

  return (
    <div className="modal-back">
      <div style={{background:'var(--bg2)',border:'1px solid var(--bdr2)',borderRadius:20,width:'100%',maxWidth:420,boxShadow:'var(--sh3)',overflow:'hidden'}}>

        {/* Header */}
        <div style={{padding:'16px 20px 12px',borderBottom:'1px solid var(--bdr)',display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <div>
            <div style={{fontSize:16,fontWeight:700,color:'var(--t1)'}}>Apply discount</div>
            <div style={{fontSize:11,color:'var(--t3)',marginTop:2}}>
              {step==='amount'?'Step 1 of 2 — choose amount':step==='apply'?'Step 2 of 2 — what does it apply to?':'Manager authorisation'}
            </div>
          </div>
          <button onClick={onCancel} style={{background:'none',border:'none',color:'var(--t3)',cursor:'pointer',fontSize:22}}>×</button>
        </div>

        <div style={{padding:'16px 20px'}}>

          {/* ── Step 1: Amount ── */}
          {step==='amount'&&(
            <>
              <div style={{fontSize:11,fontWeight:700,color:'var(--t2)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:10}}>Quick discounts</div>
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:6,marginBottom:16}}>
                {PRESETS.map(p=>(
                  <button key={p.id} onClick={()=>setSelected(p.id)} style={{padding:'10px 6px',borderRadius:10,cursor:'pointer',textAlign:'center',fontFamily:'inherit',border:`1.5px solid ${selected===p.id?'var(--acc)':'var(--bdr)'}`,background:selected===p.id?'var(--acc-d)':'var(--bg3)',position:'relative'}}>
                    {p.requiresManager&&<div style={{position:'absolute',top:4,right:4,width:6,height:6,borderRadius:'50%',background:'var(--acc)'}}/>}
                    <div style={{fontSize:11,fontWeight:700,color:selected===p.id?'var(--acc)':'var(--t1)',lineHeight:1.3}}>{p.label}</div>
                    <div style={{fontSize:14,fontWeight:800,color:selected===p.id?'var(--acc)':'var(--t2)',marginTop:3,fontFamily:'DM Mono,monospace'}}>{p.type==='amount'?`${currencySymbol()}${p.value}`:`${p.value}%`}</div>
                  </button>
                ))}
              </div>

              <div style={{fontSize:11,fontWeight:700,color:'var(--t2)',textTransform:'uppercase',letterSpacing:'.06em',marginBottom:8}}>Custom</div>
              <div style={{display:'flex',gap:6,marginBottom:8}}>
                {[['percent','% off'],['amount','£ off']].map(([t,l])=>(
                  <button key={t} onClick={()=>{setSelected('custom');setCT(t);}} style={{flex:1,padding:'8px',borderRadius:8,cursor:'pointer',fontFamily:'inherit',border:`1.5px solid ${selected==='custom'&&customType===t?'var(--acc)':'var(--bdr)'}`,background:selected==='custom'&&customType===t?'var(--acc-d)':'var(--bg3)',color:selected==='custom'&&customType===t?'var(--acc)':'var(--t2)',fontSize:12,fontWeight:700}}>{l}</button>
                ))}
              </div>
              {selected==='custom'&&(
                <input className="input" type="number" min="0" placeholder={customType==='percent'?'e.g. 15':'e.g. 5.00'} value={customVal} onChange={e=>setCV(e.target.value)} autoFocus style={{marginBottom:14,fontSize:18}}/>
              )}
              {selected&&preset?.requiresManager&&(
                <div style={{display:'flex',alignItems:'center',gap:8,padding:'8px 12px',borderRadius:8,background:'rgba(232,160,32,.1)',border:'1px solid var(--acc-b)',marginBottom:12}}>
                  <span>🔑</span><span style={{fontSize:12,color:'var(--acc)'}}>Requires manager PIN</span>
                </div>
              )}
              <div style={{display:'flex',gap:8}}>
                <button className="btn btn-ghost" style={{flex:1}} onClick={onCancel}>Cancel</button>
                <button className="btn btn-acc" style={{flex:2,height:44}} disabled={!canAdvance} onClick={handleAdvance}>
                  {categoryUids?.length ? `Apply to ${categoryUids.length} item${categoryUids.length!==1?'s':''} →` : 'Next — choose items →'}
                </button>
              </div>
            </>
          )}

          {/* ── Step 2: What does it apply to ── */}
          {step==='apply'&&(
            <>
              {manager&&<div style={{display:'flex',alignItems:'center',gap:8,padding:'8px 12px',borderRadius:8,background:'var(--grn-d)',border:'1px solid var(--grn-b)',marginBottom:12}}><span>✓</span><span style={{fontSize:12,fontWeight:600,color:'var(--grn)'}}>Authorised by {manager.name}</span></div>}

              {/* Whole check */}
              <button onClick={()=>setScope('check')} style={{width:'100%',padding:'12px 14px',borderRadius:10,cursor:'pointer',fontFamily:'inherit',textAlign:'left',display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:8,border:`1.5px solid ${scope==='check'?'var(--acc)':'var(--bdr)'}`,background:scope==='check'?'var(--acc-d)':'var(--bg3)'}}>
                <div>
                  <div style={{fontSize:13,fontWeight:700,color:scope==='check'?'var(--acc)':'var(--t1)'}}>Whole check</div>
                  <div style={{fontSize:11,color:'var(--t3)',marginTop:1}}>Apply to all {visibleItems.length} items</div>
                </div>
                <div style={{fontSize:15,fontWeight:800,color:scope==='check'?'var(--acc)':'var(--t2)',fontFamily:'DM Mono,monospace'}}>
                  −{money(calcAmount(subtotal))}
                </div>
              </button>

              {/* Specific items */}
              <button onClick={()=>setScope('items')} style={{width:'100%',padding:'10px 14px',borderRadius:10,cursor:'pointer',fontFamily:'inherit',textAlign:'left',marginBottom:scope==='items'?8:0,border:`1.5px solid ${scope==='items'?'var(--acc)':'var(--bdr)'}`,background:scope==='items'?'var(--acc-d)':'var(--bg3)',color:scope==='items'?'var(--acc)':'var(--t2)',fontSize:13,fontWeight:700}}>
                Specific items →
              </button>

              {scope==='items'&&(
                <div style={{background:'var(--bg3)',borderRadius:10,border:'1px solid var(--bdr)',padding:10,marginBottom:8}}>
                  {visibleItems.map(item=>{
                    const on = itemSel.includes(item.uid);
                    const base = item.price*item.qty;
                    return(
                      <div key={item.uid} onClick={()=>toggleItem(item.uid)} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 8px',borderRadius:8,cursor:'pointer',background:on?'var(--acc-d)':'transparent',marginBottom:4,border:`1px solid ${on?'var(--acc-b)':'transparent'}`}}>
                        <div style={{width:18,height:18,borderRadius:4,border:`2px solid ${on?'var(--acc)':'var(--bdr2)'}`,background:on?'var(--acc)':'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                          {on&&<div style={{width:8,height:8,background:'#0e0f14',borderRadius:2}}/>}
                        </div>
                        <div style={{flex:1}}>
                          <div style={{fontSize:12,fontWeight:600,color:on?'var(--acc)':'var(--t1)'}}>{item.qty>1?`${item.qty}× `:''}{item.name}</div>
                          {item.mods?.length>0&&<div style={{fontSize:10,color:'var(--t3)'}}>{item.mods.map(m=>m.label).join(', ')}</div>}
                        </div>
                        <div style={{textAlign:'right',flexShrink:0}}>
                          <div style={{fontSize:12,fontWeight:700,color:on?'var(--acc)':'var(--t2)',fontFamily:'DM Mono,monospace'}}>{money(base)}</div>
                          {on&&<div style={{fontSize:10,color:'var(--grn)'}}>−{money(calcAmount(base))}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div style={{display:'flex',gap:8,marginTop:4}}>
                <button className="btn btn-ghost" style={{flex:1}} onClick={()=>setStep('amount')}>← Back</button>
                <button className="btn btn-acc" style={{flex:2,height:44}}
                  disabled={scope==='items'&&itemSel.length===0}
                  onClick={handleApply}>
                  Apply {selected&&`— −${money(calcAmount(scope==='check'?subtotal:items.filter(i=>itemSel.includes(i.uid)).reduce((s,i)=>s+i.price*i.qty,0)))}`}
                </button>
              </div>
            </>
          )}

          {/* ── PIN step ── */}
          {step==='pin'&&(
            <>
              <div style={{fontSize:13,color:'var(--t2)',marginBottom:16,lineHeight:1.5}}>
                <strong style={{color:'var(--t1)'}}>{preset?.label}</strong> requires manager authorisation.
              </div>
              <div style={{display:'flex',justifyContent:'center',gap:12,marginBottom:pinErr?8:20}}>
                {[0,1,2,3].map(i=><div key={i} style={{width:14,height:14,borderRadius:'50%',background:i<pin.length?'var(--acc)':'var(--bg4)',border:`2px solid ${i<pin.length?'var(--acc)':'var(--bdr2)'}`,transition:'all .15s'}}/>)}
              </div>
              {pinErr&&<div style={{textAlign:'center',fontSize:12,color:'var(--red)',marginBottom:16,fontWeight:600}}>{pinErr}</div>}
              <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8,maxWidth:240,margin:'0 auto 16px'}}>
                {[1,2,3,4,5,6,7,8,9,'',0,'⌫'].map((d,i)=>(
                  <button key={i} onClick={()=>d==='⌫'?setPin(p=>p.slice(0,-1)):d!==''?handleDigit(String(d)):null} style={{height:52,borderRadius:12,cursor:d===''?'default':'pointer',background:d===''?'transparent':'var(--bg3)',border:d===''?'none':'1px solid var(--bdr2)',color:d==='⌫'?'var(--t3)':'var(--t1)',fontSize:d==='⌫'?18:20,fontWeight:700,fontFamily:'inherit',opacity:d===''?0:1}}>{d}</button>
                ))}
              </div>
              <button className="btn btn-ghost btn-full" onClick={()=>setStep('amount')}>← Back</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
