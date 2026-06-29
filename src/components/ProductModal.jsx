import { useState } from 'react';
import { useStore } from '../store';
import { ALLERGENS, PIZZA_TOPPINGS, PIZZA_BASES, PIZZA_CRUSTS, PIZZA_SIZES } from '../data/seed';
import { money, currencySymbol } from '../lib/currency';

// ── Main product modal dispatcher ─────────────────────────────────────────────
export default function ProductModal({ item, activeAllergens = [], onConfirm, onCancel }) {
  if (!item) return null;
  if (item.type === 'pizza')    return <PizzaModal    item={item} activeAllergens={activeAllergens} onConfirm={onConfirm} onCancel={onCancel} />;
  if (item.type === 'variants') return <VariantsModal item={item} activeAllergens={activeAllergens} onConfirm={onConfirm} onCancel={onCancel} />;

  // Items with assigned modifier/instruction groups (new system) or legacy modifierGroups
  const hasAssigned = (item.assignedModifierGroups?.length > 0) || (item.assignedInstructionGroups?.length > 0);
  const hasLegacy   = item.modifierGroups?.length > 0;
  if (item.type === 'modifiers' || item.type === 'modifiable' || hasAssigned || hasLegacy) {
    return <ModifiersModal item={item} activeAllergens={activeAllergens} onConfirm={onConfirm} onCancel={onCancel} />;
  }
  return null;
}

// ── Shared shell ──────────────────────────────────────────────────────────────
function ModalShell({ item, price, children, onAdd, canAdd, onCancel, addLabel = 'Add to order' }) {
  const flagged = (item.allergens || []).filter(a => activeAllergens.includes(a));

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div style={{
        background:'var(--bg2)', border:'1px solid var(--bdr2)', borderRadius:24,
        width:'100%', maxWidth:500, maxHeight:'90vh', overflow:'auto',
        boxShadow:'var(--sh3)', display:'flex', flexDirection:'column',
      }}>
        {/* Header */}
        <div style={{ padding:'20px 24px 16px', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12 }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:19, fontWeight:700, lineHeight:1.2, marginBottom:4 }}>{item.name}</div>
              {item.description && <div style={{ fontSize:13, color:'var(--t2)', lineHeight:1.5 }}>{item.description}</div>}
            </div>
            <button onClick={onCancel} style={{ fontSize:20, color:'var(--t3)', background:'none', border:'none', cursor:'pointer', lineHeight:1, padding:0, flexShrink:0 }}>×</button>
          </div>

          {/* Allergen flags */}
          {item.allergens?.length > 0 && (
            <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginTop:10 }}>
              {item.allergens.map(a => {
                const al = ALLERGENS.find(x => x.id === a);
                const isFlagged = activeAllergens.includes(a);
                return (
                  <span key={a} style={{
                    fontSize:11, padding:'2px 7px', borderRadius:6, fontWeight:500,
                    background: isFlagged ? 'var(--red-d)' : 'var(--bg3)',
                    border: `1px solid ${isFlagged ? 'var(--red-b)' : 'var(--bdr)'}`,
                    color: isFlagged ? 'var(--red)' : 'var(--t3)',
                  }}>{al?.icon} {al?.label}</span>
                );
              })}
            </div>
          )}
        </div>

        {/* Content */}
        <div style={{ flex:1, overflowY:'auto', padding:'16px 24px' }}>{children}</div>

        {/* Footer */}
        <div style={{ padding:'16px 24px', borderTop:'1px solid var(--bdr)', flexShrink:0 }}>
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <button className="btn btn-ghost" onClick={onCancel} style={{ minWidth:80 }}>Cancel</button>
            <button
              className="btn btn-acc"
              style={{ flex:1, fontSize:15, height:48, borderRadius:12, opacity: canAdd ? 1 : 0.4 }}
              disabled={!canAdd}
              onClick={canAdd ? onAdd : undefined}
            >
              {addLabel} · <strong>{money(price)}</strong>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Need to pass activeAllergens through to ModalShell
function ModalShellWrapper({ item, price, children, onAdd, canAdd, onCancel, addLabel, cancelLabel, activeAllergens }) {
  const flagged = (item.allergens || []).filter(a => activeAllergens.includes(a));

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div style={{
        background:'var(--bg2)', border:'1px solid var(--bdr2)', borderRadius:24,
        width:'100%', maxWidth:500, maxHeight:'92vh', overflow:'auto',
        boxShadow:'var(--sh3)', display:'flex', flexDirection:'column',
      }}>
        <div style={{ padding:'20px 24px 16px', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12 }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:19, fontWeight:700, lineHeight:1.2, marginBottom:4 }}>{item.name}</div>
              {item.description && <div style={{ fontSize:13, color:'var(--t2)', lineHeight:1.5 }}>{item.description}</div>}
            </div>
            <button onClick={onCancel} style={{ fontSize:22, color:'var(--t3)', background:'none', border:'none', cursor:'pointer', lineHeight:1, padding:0, flexShrink:0 }}>×</button>
          </div>
          {item.allergens?.length > 0 && (
            <div style={{ display:'flex', flexWrap:'wrap', gap:4, marginTop:10 }}>
              {item.allergens.map(a => {
                const al = ALLERGENS.find(x => x.id === a);
                const isActive = activeAllergens.includes(a);
                return (
                  <span key={a} style={{
                    fontSize:11, padding:'2px 7px', borderRadius:6, fontWeight:500,
                    background: isActive ? 'var(--red-d)' : 'var(--bg3)',
                    border: `1px solid ${isActive ? 'var(--red-b)' : 'var(--bdr)'}`,
                    color: isActive ? 'var(--red)' : 'var(--t3)',
                  }}>{al?.icon} {al?.label}</span>
                );
              })}
            </div>
          )}
          {flagged.length > 0 && (
            <div style={{ marginTop:10, padding:'8px 12px', borderRadius:8, background:'var(--red-d)', border:'1px solid var(--red-b)', fontSize:12, color:'var(--red)' }}>
              ⚠ Contains active guest allergen — confirm before adding
            </div>
          )}
        </div>
        <div style={{ flex:1, overflowY:'auto', padding:'16px 24px' }}>{children}</div>
        <div style={{ padding:'16px 24px', borderTop:'1px solid var(--bdr)', flexShrink:0 }}>
          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn-ghost" onClick={onCancel} style={{ minWidth:80 }}>{cancelLabel || 'Cancel'}</button>
            <button
              className="btn btn-acc"
              style={{ flex:1, fontSize:15, height:48, borderRadius:12, opacity: canAdd ? 1 : 0.4 }}
              disabled={!canAdd}
              onClick={canAdd ? onAdd : undefined}
            >
              {addLabel || 'Add to order'} · <strong>{money(price)}</strong>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Variants modal — pick variant then optionally configure modifiers ──────────
function VariantsModal({ item, activeAllergens, onConfirm, onCancel }) {
  const { modifierGroupDefs, instructionGroupDefs } = useStore.getState();
  const [selected, setSelected]     = useState(null);   // chosen variant
  const [step, setStep]             = useState('pick');  // 'pick' | 'modify'
  const [selections, setSelections] = useState({});
  const [instSel, setInstSel]       = useState({});
  const [qty, setQty]               = useState(1);
  const [notes, setNotes]           = useState('');

  // Label for what the variants represent — stored on parent, e.g. "Size", "Type", "Cut"
  const variantLabel = item.variantLabel || 'Option';

  // Combine modifier groups from the parent item AND the selected child item
  const childItem   = selected?._childItem;
  const parentGroups= (item.assignedModifierGroups || []);
  const childGroups = (childItem?.assignedModifierGroups || []);
  // Deduplicate by groupId — child groups take precedence
  const allGroupIds = [...new Set([...parentGroups.map(g=>g.groupId), ...childGroups.map(g=>g.groupId)])];
  const groupAssignments = allGroupIds.map(gid => {
    const childA  = childGroups.find(g=>g.groupId===gid);
    const parentA = parentGroups.find(g=>g.groupId===gid);
    return childA || parentA;
  });
  const allGroups = groupAssignments
    .map(asgn => {
      const def = modifierGroupDefs?.find(g=>g.id===asgn.groupId);
      if (!def) return null;
      return {
        id: def.id,
        label: def.name,
        selectionType: def.selectionType || (def.max===1?'single':'multiple'),
        min: asgn.min ?? def.min ?? 0,
        max: asgn.max ?? def.max ?? 1,
        options: (def.options||[]).map(o=>({...o, label:o.label||o.name})),
        _type: 'modifier',
      };
    })
    .filter(Boolean);
  // Shape-tolerant: accept legacy string[] and new [{groupId,min}][]; preserve per-assignment min
  const _normInst = arr => (arr||[]).map(e => typeof e === 'string' ? { groupId: e } : e);
  const _mergedInst = [..._normInst(item.assignedInstructionGroups), ..._normInst(childItem?.assignedInstructionGroups)];
  const _seenInst = new Set();
  const _uniqueInst = _mergedInst.filter(a => _seenInst.has(a.groupId) ? false : _seenInst.add(a.groupId));
  const instGroups = _uniqueInst.map(a => {
    const def = instructionGroupDefs?.find(g => g.id === a.groupId);
    return def ? { ...def, min: a.min ?? def.min ?? 0 } : null;
  }).filter(Boolean);

  const hasModifiers = allGroups.length > 0 || instGroups.length > 0;
  const allRequired  = allGroups.filter(g=>(g.min||0)>0).every(g => {
    const cur = selections[g.id];
    return g.selectionType==='single' ? !!cur : (Array.isArray(cur)?cur.length:0) >= (g.min||1);
  }) && instGroups.filter(g=>(g.min||0)>0).every(g => !!instSel[g.id]);

  const extraCost = Object.values(selections).flat().filter(Boolean).reduce((s,m)=>s+(m?.price||0),0);
  const basePrice = selected ? selected.price : 0;
  const price     = (basePrice + extraCost) * qty;
  const canAdd    = !!selected && allRequired;

  const toggleSingle = (gid, opt) => setSelections(s=>({...s,[gid]:s[gid]?.id===opt.id?null:opt}));
  const addMulti     = (gid, opt) => setSelections(s=>{
    const cur=s[gid]||[]; const g=allGroups.find(g=>g.id===gid);
    const maxSel=g?.max>=99||!g?.max?999:g.max;
    if(cur.length>=maxSel)return s;
    return {...s,[gid]:[...cur,{...opt,_uid:Date.now()+Math.random()}]};
  });
  const removeMulti  = (gid, uid) => setSelections(s=>({...s,[gid]:(s[gid]||[]).filter(o=>o._uid!==uid)}));
  const toggleInst   = (gid, val) => setInstSel(s=>({...s,[gid]:s[gid]===val?null:val}));

  const handleAdd = () => {
    const target = childItem || item;
    const mods = Object.entries(selections).flatMap(([gid,val])=>{
      if(!val) return [];
      const group = allGroups.find(g=>g.id===gid);
      const arr   = Array.isArray(val)?val:[val];
      return arr.filter(Boolean).map(m=>({groupLabel:group?.label, label:m.label||m.name||'', price:m.price||0}));
    });
    instGroups.forEach(g=>{ if(instSel[g.id]) mods.push({groupLabel:g.name, label:instSel[g.id], price:0, _instruction:true}); });

    // Build display name: "Lager — Pint" or "Ribeye — Large — Chips, Peppercorn"
    const modParts = mods.filter(m=>!m._instruction).map(m=>m.label);
    const instParts= Object.values(instSel).filter(Boolean);
    const extras   = [...modParts,...instParts];
    // displayName = "Lager — Pint" — mods render on separate lines below, not in the name
    const displayName = `${item.menuName||item.name} — ${selected.label}`;

    onConfirm(target, mods, null, { notes:notes.trim(), qty, linePrice:price, displayName });
  };

  return (
    <ModalShellWrapper item={item} price={price} canAdd={canAdd}
      onAdd={step==='pick'&&hasModifiers ? ()=>setStep('modify') : handleAdd}
      addLabel={step==='pick'&&hasModifiers&&selected ? 'Next →' : 'Add to order'}
      onCancel={step==='modify' ? ()=>setStep('pick') : onCancel}
      cancelLabel={step==='modify' ? '← Back' : 'Cancel'}
      activeAllergens={activeAllergens}>

      {step==='pick' && (<>
        {/* Item name */}
        <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)', marginBottom:6 }}>{item.menuName||item.name}</div>

        {/* Step indicator — only shown when modifiers follow */}
        {hasModifiers && (
          <div style={{ display:'flex', gap:6, marginBottom:14, alignItems:'center' }}>
            <div style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 12px', borderRadius:20, background:'var(--acc-d)', border:'1.5px solid var(--acc-b)' }}>
              <div style={{ width:18,height:18,borderRadius:'50%',background:'var(--acc)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:900,color:'#0b0c10' }}>1</div>
              <span style={{ fontSize:12, fontWeight:800, color:'var(--acc)' }}>Pick {variantLabel.toLowerCase()}</span>
            </div>
            <span style={{ color:'var(--t4)', fontSize:14 }}>→</span>
            <div style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 12px', borderRadius:20, background:'var(--bg3)', border:'1px solid var(--bdr)' }}>
              <div style={{ width:18,height:18,borderRadius:'50%',background:'var(--bg4)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:800,color:'var(--t4)' }}>2</div>
              <span style={{ fontSize:12, color:'var(--t4)' }}>Choose options</span>
            </div>
          </div>
        )}

        <div style={{ fontSize:13, fontWeight:800, color:'var(--t2)', marginBottom:10 }}>
          Choose {variantLabel.toLowerCase()}
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:7, marginBottom:20 }}>
          {(item.variants||[]).map(v => {
            const isSel = selected?.id===v.id;
            return (
              <button key={v.id} onClick={()=>setSelected(v)} style={{
                padding:'12px 14px', borderRadius:12, cursor:'pointer', textAlign:'left',
                border:`2px solid ${isSel?'var(--acc)':'var(--bdr)'}`,
                background:isSel?'var(--acc-d)':'var(--bg3)',
                display:'flex', alignItems:'center', justifyContent:'space-between',
                transition:'all .1s', fontFamily:'inherit',
              }}>
                <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{ width:20, height:20, borderRadius:'50%', border:`2px solid ${isSel?'var(--acc)':'var(--bdr2)'}`, background:isSel?'var(--acc)':'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                    {isSel && <div style={{ width:7, height:7, borderRadius:'50%', background:'#0b0c10' }}/>}
                  </div>
                  <span style={{ fontSize:15, fontWeight:isSel?700:500, color:isSel?'var(--acc)':'var(--t1)' }}>{v.label}</span>
                </div>
                <span style={{ fontSize:16, fontWeight:800, color:isSel?'var(--acc)':'var(--t2)', fontFamily:'var(--font-mono)' }}>{money(v.price)}</span>
              </button>
            );
          })}
        </div>

        <div style={{ display:'flex', alignItems:'center', gap:16, marginBottom:14 }}>
          <span style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em' }}>Quantity</span>
          <div style={{ display:'flex', alignItems:'center', gap:12, marginLeft:'auto' }}>
            <button onClick={()=>setQty(q=>Math.max(1,q-1))} style={{ width:32,height:32,borderRadius:'50%',border:'1px solid var(--bdr2)',background:'transparent',color:'var(--t1)',fontSize:20,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer' }}>−</button>
            <span style={{ fontSize:18, fontWeight:600, minWidth:24, textAlign:'center' }}>{qty}</span>
            <button onClick={()=>setQty(q=>q+1)} style={{ width:32,height:32,borderRadius:'50%',border:'1px solid var(--bdr2)',background:'transparent',color:'var(--t1)',fontSize:20,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer' }}>+</button>
          </div>
        </div>
        <div>
          <span style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em' }}>Notes (optional)</span>
          <textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder="e.g. No ice" rows={2}
            style={{ width:'100%', marginTop:6, background:'var(--bg3)', border:'1px solid var(--bdr2)', borderRadius:8, padding:'8px 12px', color:'var(--t1)', fontSize:13, fontFamily:'inherit', resize:'none', outline:'none' }}/>
        </div>
      </>)}

      {step==='modify' && (<>
        {/* Step 2: modifiers */}
        {/* Step 2 header */}
        <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)', marginBottom:4 }}>{item.menuName||item.name}</div>
        <div style={{ display:'flex', gap:6, marginBottom:14, alignItems:'center' }}>
          <div style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 12px', borderRadius:20, background:'var(--grn-d)', border:'1.5px solid var(--grn-b)' }}>
            <span style={{ fontSize:13, color:'var(--grn)', fontWeight:700 }}>✓</span>
            <span style={{ fontSize:12, color:'var(--grn)', fontWeight:700 }}>{selected?.label}</span>
          </div>
          <span style={{ color:'var(--t4)', fontSize:14 }}>→</span>
          <div style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 12px', borderRadius:20, background:'var(--acc-d)', border:'1.5px solid var(--acc-b)' }}>
            <div style={{ width:18,height:18,borderRadius:'50%',background:'var(--acc)',display:'flex',alignItems:'center',justifyContent:'center',fontSize:10,fontWeight:900,color:'#0b0c10' }}>2</div>
            <span style={{ fontSize:12, fontWeight:800, color:'var(--acc)' }}>Choose options</span>
          </div>
        </div>

        {allGroups.map(group=>{
          const required   = (group.min||0)>0;
          const selType    = group.selectionType||'single';
          const cur        = selections[group.id];
          const selCount   = Array.isArray(cur)?cur.length:(cur?1:0);
          const maxSel     = group.max>=99||!group.max?999:group.max;
          return (
            <div key={group.id} style={{ marginBottom:18 }}>
              <div style={{ display:'flex', gap:8, alignItems:'center', marginBottom:8, flexWrap:'wrap' }}>
                <span style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em' }}>{group.label}</span>
                {required && <span style={{ fontSize:10, color:'var(--red)', fontWeight:700 }}>Required</span>}
                {!required && <span style={{ fontSize:10, color:'var(--t4)' }}>Optional</span>}
                {selType!=='single' && <span style={{ fontSize:10, color:'var(--t3)' }}>{maxSel>=999?'Any amount':`Up to ${maxSel}`}</span>}
                {selCount>0 && <span style={{ fontSize:10, color:'var(--acc)', fontWeight:700 }}>{selCount} selected</span>}
              </div>
              <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
                {(group.options||[]).map(opt=>{
                  if(selType==='single'){
                    const isSel=cur?.id===opt.id;
                    return (
                      <button key={opt.id} onClick={()=>toggleSingle(group.id,opt)}
                        style={{ display:'flex', alignItems:'center', gap:9, padding:'9px 12px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', border:`1.5px solid ${isSel?'var(--acc)':'var(--bdr)'}`, background:isSel?'var(--acc-d)':'var(--bg3)', justifyContent:'space-between' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:9, flex:1, minWidth:0 }}>
                          <div style={{ width:16,height:16,borderRadius:'50%',border:`2px solid ${isSel?'var(--acc)':'var(--bdr2)'}`,background:isSel?'var(--acc)':'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}>
                            {isSel&&<div style={{ width:5,height:5,borderRadius:'50%',background:'#0b0c10' }}/>}
                          </div>
                          <span style={{ fontSize:13, fontWeight:isSel?700:400, minWidth:0, overflowWrap:'anywhere', color:isSel?'var(--acc)':'var(--t1)' }}>{opt.label||opt.name}</span>
                        </div>
                        <span style={{ fontSize:12, flexShrink:0, color:isSel?'var(--acc)':'var(--t3)' }}>{opt.price>0?`+${money(opt.price)}`:isSel?'✓':''}</span>
                      </button>
                    );
                  } else {
                    const instances=(cur||[]).filter(o=>o.id===opt.id);
                    const qtyOpt=instances.length;
                    const atMax=selCount>=maxSel;
                    return (
                      <div key={opt.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'9px 12px', borderRadius:9, border:`1.5px solid ${qtyOpt>0?'var(--acc)':'var(--bdr)'}`, background:qtyOpt>0?'var(--acc-d)':'var(--bg3)' }}>
                        <span style={{ flex:1, minWidth:0, overflowWrap:'anywhere', fontSize:13, fontWeight:qtyOpt>0?700:400, color:qtyOpt>0?'var(--acc)':'var(--t1)' }}>{opt.label||opt.name}</span>
                        <span style={{ fontSize:12, flexShrink:0, color:qtyOpt>0?'var(--acc)':'var(--t3)', marginRight:6 }}>{opt.price>0?`+${money(opt.price)}`:'free'}</span>
                        {qtyOpt>0&&<button onClick={()=>removeMulti(group.id,instances[instances.length-1]._uid)} style={{ width:26,height:26,borderRadius:6,border:'1.5px solid var(--acc-b)',background:'var(--bg1)',color:'var(--acc)',cursor:'pointer',fontSize:14,display:'flex',alignItems:'center',justifyContent:'center' }}>−</button>}
                        {qtyOpt>0&&<span style={{ fontSize:12, fontWeight:800, color:'var(--acc)', minWidth:14, textAlign:'center' }}>{qtyOpt}</span>}
                        <button onClick={()=>!atMax&&addMulti(group.id,opt)} disabled={atMax} style={{ width:26,height:26,borderRadius:6,border:`1.5px solid ${atMax?'var(--bdr)':'var(--acc)'}`,background:atMax?'var(--bg2)':'var(--acc)',color:atMax?'var(--t4)':'#0b0c10',cursor:atMax?'not-allowed':'pointer',fontSize:14,display:'flex',alignItems:'center',justifyContent:'center',opacity:atMax?.4:1 }}>+</button>
                      </div>
                    );
                  }
                })}
              </div>
            </div>
          );
        })}

        {instGroups.map(g=>(
          <div key={g.id} style={{ marginBottom:16 }}>
            <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>{g.name}</div>
            <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
              {(g.options||[]).map(opt=>{
                const isSel=instSel[g.id]===opt;
                return (
                  <button key={opt} onClick={()=>toggleInst(g.id,opt)}
                    style={{ display:'flex', alignItems:'center', gap:9, padding:'9px 12px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', border:`1.5px solid ${isSel?'var(--grn)':'var(--bdr)'}`, background:isSel?'var(--grn-d)':'var(--bg3)', justifyContent:'space-between' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:9 }}>
                      <div style={{ width:16,height:16,borderRadius:'50%',border:`2px solid ${isSel?'var(--grn)':'var(--bdr2)'}`,background:isSel?'var(--grn)':'transparent',flexShrink:0 }}/>
                      <span style={{ fontSize:13, color:isSel?'var(--grn)':'var(--t1)', fontWeight:isSel?700:400 }}>{opt}</span>
                    </div>
                    {isSel&&<span style={{ fontSize:11, color:'var(--grn)' }}>✓</span>}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </>)}
    </ModalShellWrapper>
  );
}

// ── Modifiers modal (steak cooking, cocktail base, etc.) ──────────────────────
function ModifiersModal({ item, activeAllergens, onConfirm, onCancel }) {
  const { modifierLibrary, menuItems, modifierGroupDefs, instructionGroupDefs } = useStore.getState();
  const [selections, setSelections]     = useState({});
  const [instSelections, setInstSel]    = useState({});
  const [qty, setQty]   = useState(1);
  const [notes, setNotes] = useState('');

  // ── Build the list of all groups to show ──────────────────────────────────
  // Priority: new assigned system > legacy inline modifierGroups
  const buildGroups = () => {
    const all = [];

    // 1. New system: assigned modifier groups (from Product Builder)
    if (item.assignedModifierGroups?.length) {
      item.assignedModifierGroups.forEach(assignment => {
        const def = modifierGroupDefs?.find(g => g.id === assignment.groupId);
        if (def) all.push({
          id: def.id,
          label: def.name,
          selectionType: def.selectionType || (def.max === 1 ? 'single' : 'multiple'),
          min: assignment.min ?? def.min ?? 0,
          max: assignment.max ?? def.max ?? 1,
          options: (def.options || []).map(o => ({ ...o, label: o.label || o.name })),
          _type: 'modifier',
        });
      });
    }

    // 2. Legacy inline modifier groups
    if (item.modifierGroups?.length) {
      item.modifierGroups.forEach(g => {
        const options = g.modifierIds?.length
          ? g.modifierIds.map(id => {
              const sub = menuItems.find(i => i.id === id && i.type === 'subitem');
              if (sub) return { id: sub.id, label: sub.menuName || sub.name, price: sub.pricing?.base ?? sub.price ?? 0 };
              const lib = modifierLibrary?.find(m => m.id === id);
              if (lib) return { id: lib.id, label: lib.name, price: lib.price || 0 };
              return null;
            }).filter(Boolean)
          : (g.options || []);
        if (options.length) all.push({ ...g, options, _type: 'modifier' });
      });
    }

    return all;
  };

  // Instruction groups (no price, separate state) — shape-tolerant + preserve per-assignment min
  const instrGroups = (item.assignedInstructionGroups || [])
    .map(e => typeof e === 'string' ? { groupId: e } : e)
    .map(a => {
      const def = instructionGroupDefs?.find(g => g.id === a.groupId);
      return def ? { ...def, min: a.min ?? def.min ?? 0 } : null;
    })
    .filter(Boolean);

  const allModGroups = buildGroups();

  const getSelType = (group) => {
    if (group.selectionType) return group.selectionType;
    if (group.max === 1) return 'single';
    return 'multiple';
  };
  const isRequired = (group) => group.min > 0 || group.required;

  // Single select: toggle one option
  const toggleSingle = (groupId, opt) => setSelections(s => ({
    ...s, [groupId]: s[groupId]?.id === opt.id ? null : opt
  }));

  // Multi select: each press adds one more (allows duplicates), up to max
  const addMulti = (groupId, opt) => setSelections(s => {
    const cur = s[groupId] || [];
    const group = allModGroups.find(g => g.id === groupId);
    const maxSel = group?.max >= 99 ? 999 : (group?.max || 999);
    if (cur.length >= maxSel) return s;
    return { ...s, [groupId]: [...cur, { ...opt, _uid: Date.now() + Math.random() }] };
  });

  // Remove one instance of an option
  const removeMulti = (groupId, uid) => setSelections(s => ({
    ...s, [groupId]: (s[groupId] || []).filter(o => o._uid !== uid)
  }));

  const toggleInst = (groupId, opt) => setInstSel(s => ({ ...s, [groupId]: s[groupId] === opt ? null : opt }));

  const allRequired = allModGroups
    .filter(g => isRequired(g))
    .every(g => {
      const selType = getSelType(g);
      if (selType === 'single') return !!selections[g.id];
      return (selections[g.id]?.length || 0) >= (g.min || 1);
    }) && instrGroups.filter(g => isRequired(g)).every(g => !!instSelections[g.id]);

  const extraCost = Object.values(selections).flat().filter(Boolean).reduce((s, m) => s + (m?.price || 0), 0);
  const basePrice = item.pricing?.base ?? item.price ?? 0;
  const price = (basePrice + extraCost) * qty;

  const buildDisplayName = () => {
    // Count occurrences of each mod label
    const allMods = Object.values(selections).flat().filter(Boolean);
    const labelCounts = {};
    allMods.forEach(m => { const k=m.label||m.name||''; labelCounts[k] = (labelCounts[k]||0) + 1; });
    const modParts = [...new Set(allMods.map(m => m.label||m.name||''))].map(label =>
      labelCounts[label] > 1 ? `${labelCounts[label]}× ${label}` : label
    );
    const instParts = Object.values(instSelections).filter(Boolean);
    // Name is the item name — mods show on separate rows, instructions go in name
    const nameExtras = instParts.length ? ` · ${instParts.join(', ')}` : '';
    return `${item.menuName || item.name}${nameExtras}`;
  };

  const handleAdd = () => {
    const mods = Object.entries(selections).flatMap(([gid, val]) => {
      if (!val) return [];
      const group = allModGroups.find(g => g.id === gid);
      const arr = Array.isArray(val) ? val : [val];
      return arr.filter(Boolean).map(m => ({ groupLabel: group?.label||group?.name, label: m.label||m.name||'', price: m.price || 0 }));
    });
    // Add instructions as zero-price mods for kitchen printing
    Object.entries(instSelections).forEach(([gid, val]) => {
      if (val) {
        const g = instrGroups.find(ig => ig.id === gid);
        mods.push({ groupLabel: g?.name, label: val, price: 0, _instruction: true });
      }
    });
    onConfirm(item, mods, null, {
      notes: notes.trim(), qty, linePrice: price,
      displayName: buildDisplayName(),
    });
  };

  return (
    <ModalShellWrapper item={item} price={price} canAdd={allRequired} onAdd={handleAdd} onCancel={onCancel} activeAllergens={activeAllergens}>
      {allModGroups.map(group => {
        const options = group.options || [];
        const selType = getSelType(group);
        const required = isRequired(group);
        const maxSel = group.max >= 99 || !group.max ? 999 : group.max;
        const cur = selections[group.id];
        const selectedCount = Array.isArray(cur) ? cur.length : (cur ? 1 : 0);
        const isUnlimited = !group.max || group.max >= 99;

        return (
          <div key={group.id} style={{ marginBottom:20 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10, flexWrap:'wrap' }}>
              <span className="label-xs">{group.label || group.name || 'Options'}</span>
              {required && <span style={{ fontSize:11, color:'var(--red)', fontWeight:600 }}>Required</span>}
              {!required && <span style={{ fontSize:11, color:'var(--t4)' }}>Optional</span>}
              {selType === 'single' && <span style={{ fontSize:11, color:'var(--t3)' }}>Pick one</span>}
              {selType !== 'single' && !isUnlimited && <span style={{ fontSize:11, color:'var(--t3)' }}>Up to {maxSel}</span>}
              {selType !== 'single' && isUnlimited && <span style={{ fontSize:11, color:'var(--t3)' }}>Add as many as you like</span>}
              {selectedCount > 0 && <span style={{ fontSize:11, color:'var(--acc)', fontWeight:700 }}>{selectedCount} selected</span>}
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {options.map(opt => {
                if (selType === 'single') {
                  const isSelected = cur?.id === opt.id;
                  return (
                    <button key={opt.id} onClick={() => toggleSingle(group.id, opt)}
                      style={{ padding:'11px 14px', borderRadius:10, cursor:'pointer', border:`1.5px solid ${isSelected?'var(--acc)':'var(--bdr)'}`, background:isSelected?'var(--acc-d)':'var(--bg3)', display:'flex', alignItems:'center', justifyContent:'space-between', transition:'all .12s', fontFamily:'inherit' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:8, flex:1, minWidth:0 }}>
                        <div style={{ width:18, height:18, borderRadius:'50%', border:`2px solid ${isSelected?'var(--acc)':'var(--bdr2)'}`, background:isSelected?'var(--acc)':'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                          {isSelected && <div style={{ width:6, height:6, borderRadius:'50%', background:'#0e0f14' }}/>}
                        </div>
                        <span style={{ fontSize:14, fontWeight:500, minWidth:0, overflowWrap:'anywhere', color:isSelected?'var(--acc)':'var(--t1)' }}>{opt.label||opt.name}</span>
                      </div>
                      <span style={{ fontSize:13, fontWeight:600, flexShrink:0, color:isSelected?'var(--acc)':'var(--t3)' }}>
                        {opt.price > 0 ? `+${money(opt.price)}` : isSelected ? '✓' : ''}
                      </span>
                    </button>
                  );
                } else {
                  // Multi-select: show qty controls, allow multiples of same item
                  const instances = (cur || []).filter(o => o.id === opt.id);
                  const qty = instances.length;
                  const atMax = selectedCount >= maxSel;
                  return (
                    <div key={opt.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 14px', borderRadius:10, border:`1.5px solid ${qty>0?'var(--acc)':'var(--bdr)'}`, background:qty>0?'var(--acc-d)':'var(--bg3)', transition:'all .12s' }}>
                      <span style={{ fontSize:14, fontWeight:500, color:qty>0?'var(--acc)':'var(--t1)', flex:1, minWidth:0, overflowWrap:'anywhere' }}>{opt.label||opt.name}</span>
                      <span style={{ fontSize:13, flexShrink:0, color:qty>0?'var(--acc)':'var(--t3)', marginRight:8 }}>
                        {opt.price > 0 ? `+${money(opt.price)}` : 'free'}
                      </span>
                      <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                        {qty > 0 && (
                          <button onClick={() => removeMulti(group.id, instances[instances.length-1]._uid)}
                            style={{ width:28, height:28, borderRadius:7, border:'1.5px solid var(--acc-b)', background:'var(--bg1)', color:'var(--acc)', cursor:'pointer', fontSize:16, display:'flex', alignItems:'center', justifyContent:'center' }}>−</button>
                        )}
                        {qty > 0 && <span style={{ fontSize:13, fontWeight:800, color:'var(--acc)', minWidth:16, textAlign:'center' }}>{qty}</span>}
                        <button onClick={() => !atMax && addMulti(group.id, opt)} disabled={atMax}
                          style={{ width:28, height:28, borderRadius:7, border:`1.5px solid ${atMax?'var(--bdr)':'var(--acc)'}`, background:atMax?'var(--bg2)':'var(--acc)', color:atMax?'var(--t4)':'#0b0c10', cursor:atMax?'not-allowed':'pointer', fontSize:16, display:'flex', alignItems:'center', justifyContent:'center', opacity:atMax?.4:1 }}>+</button>
                      </div>
                    </div>
                  );
                }
              })}
              {options.length === 0 && (
                <div style={{ fontSize:12, color:'var(--t4)', padding:'8px 12px', background:'var(--bg3)', borderRadius:8 }}>
                  No options configured — add sub items to this modifier group in the Menu Manager
                </div>
              )}
            </div>
          </div>
        );
      })}

      {/* Instruction groups (no price change) */}
      {instrGroups.map(g => {
        const sel = instSelections[g.id];
        return (
          <div key={g.id} style={{ marginBottom:20 }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
              <span className="label-xs">{g.name}</span>
              <span style={{ fontSize:11, color:'var(--t4)' }}>Preparation · no charge</span>
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {(g.options || []).map(opt => (
                <button key={opt} onClick={() => toggleInst(g.id, opt)}
                  style={{ padding:'11px 14px', borderRadius:10, cursor:'pointer', fontFamily:'inherit', textAlign:'left',
                    border:`1.5px solid ${sel===opt?'var(--grn)':'var(--bdr)'}`,
                    background:sel===opt?'var(--grn-d)':'var(--bg3)', transition:'all .12s',
                    display:'flex', alignItems:'center', gap:10 }}>
                  <div style={{ width:18, height:18, borderRadius:'50%', border:`2px solid ${sel===opt?'var(--grn)':'var(--bdr2)'}`, background:sel===opt?'var(--grn)':'transparent', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center' }}>
                    {sel===opt && <div style={{ width:6, height:6, borderRadius:'50%', background:'#0b0c10' }}/>}
                  </div>
                  <span style={{ fontSize:14, fontWeight:500, color:sel===opt?'var(--grn)':'var(--t1)' }}>{opt}</span>
                </button>
              ))}
            </div>
          </div>
        );
      })}

      <div style={{ display:'flex', alignItems:'center', gap:16, paddingTop:4, marginBottom:16 }}>
        <div className="label-xs">Quantity</div>
        <div style={{ display:'flex', alignItems:'center', gap:12, marginLeft:'auto' }}>
          <button onClick={() => setQty(q => Math.max(1, q-1))} style={{ width:32, height:32, borderRadius:'50%', border:'1px solid var(--bdr2)', background:'transparent', color:'var(--t1)', fontSize:20, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}>−</button>
          <span style={{ fontSize:18, fontWeight:600, minWidth:24, textAlign:'center' }}>{qty}</span>
          <button onClick={() => setQty(q => q+1)} style={{ width:32, height:32, borderRadius:'50%', border:'1px solid var(--bdr2)', background:'transparent', color:'var(--t1)', fontSize:20, display:'flex', alignItems:'center', justifyContent:'center', cursor:'pointer' }}>+</button>
        </div>
      </div>

      <div>
        <div className="label-xs" style={{ marginBottom:6 }}>Notes (optional)</div>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Allergy note, special request..." rows={2}
          style={{ width:'100%', background:'var(--bg3)', border:'1px solid var(--bdr2)', borderRadius:8, padding:'8px 12px', color:'var(--t1)', fontSize:13, fontFamily:'inherit', resize:'none', outline:'none' }}/>
      </div>
    </ModalShellWrapper>
  );
}

// ── Pizza modal (half & half builder) ─────────────────────────────────────────
function PizzaModal({ item, activeAllergens, onConfirm, onCancel }) {
  // Use per-item overrides if configured, fall back to global constants
  const availSizes  = item.pizzaSizes  || PIZZA_SIZES;
  const availBases  = item.pizzaBases  ? PIZZA_BASES.filter(b => item.pizzaBases.includes(b.id))  : PIZZA_BASES;
  const availCrusts = item.pizzaCrusts ? PIZZA_CRUSTS.filter(c => item.pizzaCrusts.includes(c.id)) : PIZZA_CRUSTS;

  const [size,  setSize]  = useState(availSizes[Math.min(1, availSizes.length-1)] || availSizes[0]);
  const [base,  setBase]  = useState(availBases[0]);
  const [crust, setCrust] = useState(availCrusts[0]);
  const [split, setSplit] = useState('whole');
  const [side,  setSide]  = useState('whole');
  const [left,  setLeft]  = useState(item.defaultToppings ? PIZZA_TOPPINGS.filter(t => (item.defaultToppings||[]).includes(t.id)) : []);
  const [right, setRight] = useState([]);
  const [notes, setNotes] = useState('');

  const toppingCost =
    left.filter(t => !right.find(r => r.id === t.id)).reduce((s,t) => s + t.price * .5, 0) +
    right.filter(t => !left.find(l => l.id === t.id)).reduce((s,t) => s + t.price * .5, 0) +
    left.filter(t =>  right.find(r => r.id === t.id)).reduce((s,t) => s + t.price, 0);
  const total = size.basePrice + (crust.extra || 0) + toppingCost;

  const toggleTop = (top) => {
    if (split === 'whole') {
      const inL = !!left.find(t => t.id === top.id);
      if (inL) { setLeft(l => l.filter(t => t.id !== top.id)); setRight(r => r.filter(t => t.id !== top.id)); }
      else      { setLeft(l => [...l, top]); setRight(r => [...r, top]); }
    } else if (side === 'left') {
      setLeft(l => l.find(t => t.id === top.id) ? l.filter(t => t.id !== top.id) : [...l, top]);
    } else {
      setRight(r => r.find(t => t.id === top.id) ? r.filter(t => t.id !== top.id) : [...r, top]);
    }
  };

  const toppingState = (top) => {
    const inL = !!left.find(t => t.id === top.id);
    const inR = !!right.find(t => t.id === top.id);
    if (inL && inR) return 'both';
    if (inL)        return 'left';
    if (inR)        return 'right';
    return 'off';
  };

  const SC = { left:'#3b82f6', right:'#22c55e', both:'#a855f7', whole:'#f0a500' };

  const handleAdd = () => {
    const cfg = { size, base, crust, split, toppings:{ left, right } };
    const allTops = split==='whole' ? left : [...new Map([...left,...right].map(t=>[t.id,t])).values()];
    const topAllergens = allTops.flatMap(t => t.allergens || []);
    const allAllergens = [...new Set([...(item.allergens||[]), ...(base.allergens||[]), ...(crust.allergens||[]), ...topAllergens])];
    const displayName = split==='whole'
      ? `${item.name} — ${size.name}`
      : `${item.name} — Half & half (${size.name})`;
    const modsArr = [];
    if (split==='half') {
      if (left.length)  modsArr.push({ label: `Left: ${left.map(t=>t.name).join(', ')}` });
      if (right.length) modsArr.push({ label: `Right: ${right.map(t=>t.name).join(', ')}` });
    } else {
      if (left.length) modsArr.push({ label: left.map(t=>t.name).join(', ') });
    }
    modsArr.push({ label: `${base.name} base · ${crust.name}` });
    if (notes.trim()) modsArr.push({ label: notes.trim() });
    onConfirm({ ...item, allergens: allAllergens, price: total }, modsArr, cfg, { displayName, qty: 1, linePrice: total, notes });
  };

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onCancel()}>
      <div style={{ background:'var(--bg2)', border:'1px solid var(--bdr2)', borderRadius:24, width:'100%', maxWidth:620, maxHeight:'92vh', overflow:'auto', boxShadow:'var(--sh3)' }}>
        {/* Header */}
        <div style={{ padding:'18px 24px', borderBottom:'1px solid var(--bdr)', display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ fontSize:18, fontWeight:700 }}>{item.name}</div>
          <button onClick={onCancel} style={{ fontSize:22, color:'var(--t3)', background:'none', border:'none', cursor:'pointer' }}>×</button>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'1fr 188px' }}>
          {/* Builder */}
          <div style={{ padding:'18px 20px', borderRight:'1px solid var(--bdr)', overflowY:'auto', maxHeight:'70vh' }}>

            {/* Size */}
            <div style={{ marginBottom:16 }}>
              <div className="label-xs" style={{ marginBottom:8 }}>Size</div>
              <div style={{ display:'flex', gap:6 }}>
                {availSizes.map(s => (
                  <button key={s.id} onClick={() => setSize(s)} style={{
                    flex:1, padding:'9px 6px', borderRadius:9, cursor:'pointer', textAlign:'center',
                    border:`1.5px solid ${size.id===s.id?'var(--acc)':'var(--bdr)'}`,
                    background:size.id===s.id?'var(--acc-d)':'var(--bg3)', transition:'all .12s', fontFamily:'inherit',
                  }}>
                    <div style={{ fontSize:12, fontWeight:500, color:size.id===s.id?'var(--acc)':'var(--t1)' }}>{s.name}</div>
                    <div style={{ fontSize:11, color:'var(--t3)' }}>{currencySymbol()}{s.basePrice}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Base */}
            <div style={{ marginBottom:16 }}>
              <div className="label-xs" style={{ marginBottom:8 }}>Base</div>
              <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
                {availBases.map(b => (
                  <button key={b.id} onClick={() => setBase(b)} style={{
                    padding:'6px 11px', borderRadius:7, cursor:'pointer', fontSize:12, fontWeight:500,
                    border:`1.5px solid ${base.id===b.id?'var(--acc)':'var(--bdr)'}`,
                    background:base.id===b.id?'var(--acc-d)':'var(--bg3)',
                    color:base.id===b.id?'var(--acc)':'var(--t2)', fontFamily:'inherit',
                  }}>{b.name}</button>
                ))}
              </div>
            </div>

            {/* Crust */}
            <div style={{ marginBottom:16 }}>
              <div className="label-xs" style={{ marginBottom:8 }}>Crust</div>
              <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
                {availCrusts.map(c => (
                  <button key={c.id} onClick={() => setCrust(c)} style={{
                    padding:'6px 11px', borderRadius:7, cursor:'pointer', fontSize:12, fontWeight:500,
                    border:`1.5px solid ${crust.id===c.id?'var(--acc)':'var(--bdr)'}`,
                    background:crust.id===c.id?'var(--acc-d)':'var(--bg3)',
                    color:crust.id===c.id?'var(--acc)':'var(--t2)', fontFamily:'inherit',
                  }}>{c.name}{c.extra?` +${currencySymbol()}${c.extra}`:''}</button>
                ))}
              </div>
            </div>

            {/* Split */}
            <div style={{ marginBottom:16 }}>
              <div className="label-xs" style={{ marginBottom:8 }}>Style</div>
              <div style={{ display:'flex', border:'1px solid var(--bdr)', borderRadius:9, overflow:'hidden' }}>
                {[['whole','Whole pizza'],['half','Half & half']].map(([v,l]) => (
                  <button key={v} onClick={() => { setSplit(v); setSide(v==='whole'?'whole':'left'); }} style={{
                    flex:1, padding:'8px', cursor:'pointer', fontSize:12, fontWeight:600,
                    background:split===v?'var(--acc)':'transparent',
                    color:split===v?'#0e0f14':'var(--t3)',
                    border:'none', fontFamily:'inherit', transition:'all .15s',
                  }}>{l}</button>
                ))}
              </div>
            </div>

            {/* Half selector */}
            {split === 'half' && (
              <div style={{ marginBottom:16 }}>
                <div style={{ display:'flex', gap:6, marginBottom:8 }}>
                  {['left','right'].map(s => {
                    const count = (s==='left'?left:right).length;
                    const col = SC[s];
                    return (
                      <button key={s} onClick={() => setSide(s)} style={{
                        flex:1, padding:'9px 8px', borderRadius:9, cursor:'pointer', textAlign:'center',
                        border:`1.5px solid ${side===s?col:'var(--bdr)'}`,
                        background:side===s?(s==='left'?'rgba(59,130,246,.1)':'rgba(34,197,94,.1)'):'var(--bg3)',
                        fontFamily:'inherit',
                      }}>
                        <div style={{ fontSize:12, fontWeight:600, color:side===s?col:'var(--t2)' }}>{s==='left'?'Left':'Right'} half</div>
                        <div style={{ fontSize:10, color:'var(--t3)', marginTop:2 }}>{count} topping{count!==1?'s':''}</div>
                      </button>
                    );
                  })}
                </div>
                <div style={{ padding:'6px 10px', borderRadius:7, fontSize:12, background:side==='left'?'rgba(59,130,246,.08)':'rgba(34,197,94,.08)', color:side==='left'?SC.left:SC.right }}>
                  Tapping toppings adds to <strong>{side}</strong> half
                </div>
              </div>
            )}

            {/* Toppings */}
            <div className="label-xs" style={{ marginBottom:8 }}>Toppings</div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:5 }}>
              {PIZZA_TOPPINGS.map(top => {
                const st = toppingState(top);
                const col = SC[st] || SC.whole;
                const active = st !== 'off';
                return (
                  <button key={top.id} onClick={() => toggleTop(top)} style={{
                    padding:'8px 5px', borderRadius:8, cursor:'pointer', textAlign:'center',
                    border:`1.5px solid ${active?col+'88':'var(--bdr)'}`,
                    background:active?col+'14':'var(--bg3)', transition:'all .12s', fontFamily:'inherit',
                  }}>
                    <div style={{ width:9, height:9, borderRadius:'50%', background:top.color, margin:'0 auto 4px' }}/>
                    <div style={{ fontSize:10, fontWeight:500, color:active?col:'var(--t2)', lineHeight:1.2 }}>{top.name}</div>
                    {top.price>0&&<div style={{ fontSize:9, color:'var(--t3)' }}>+{currencySymbol()}{top.price}</div>}
                    {active&&st!=='both'&&st!=='whole'&&<div style={{ fontSize:9, fontWeight:700, color:col, textTransform:'uppercase' }}>{st}</div>}
                    {st==='both'&&<div style={{ fontSize:9, fontWeight:700, color:col }}>both</div>}
                  </button>
                );
              })}
            </div>

            <div style={{ marginTop:14 }}>
              <div className="label-xs" style={{ marginBottom:6 }}>Notes</div>
              <textarea value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Extra crispy, well done, etc." rows={2}
                style={{ width:'100%', background:'var(--bg3)', border:'1px solid var(--bdr2)', borderRadius:8, padding:'8px 12px', color:'var(--t1)', fontSize:13, fontFamily:'inherit', resize:'none', outline:'none' }}/>
            </div>
          </div>

          {/* Summary panel */}
          <div style={{ padding:'18px 16px', display:'flex', flexDirection:'column' }}>
            <div className="label-xs" style={{ marginBottom:10 }}>Your pizza</div>
            <div style={{ fontSize:12, color:'var(--t3)', marginBottom:4 }}>{size.name} · {crust.name}</div>
            <div style={{ fontSize:12, color:'var(--t3)', marginBottom:12 }}>{base.name} base</div>

            {split==='half' ? (
              <>
                <div style={{ background:'rgba(59,130,246,.08)', borderRadius:8, padding:'8px 10px', marginBottom:6 }}>
                  <div style={{ fontSize:10, fontWeight:700, color:SC.left, marginBottom:4 }}>LEFT HALF</div>
                  {left.length ? left.map(t=><div key={t.id} style={{display:'flex',alignItems:'center',gap:5,fontSize:11,color:'var(--t2)',marginBottom:2}}><div style={{width:7,height:7,borderRadius:'50%',background:t.color}}/>{t.name}</div>) : <div style={{fontSize:11,color:'var(--t3)',fontStyle:'italic'}}>No toppings</div>}
                </div>
                <div style={{ background:'rgba(34,197,94,.08)', borderRadius:8, padding:'8px 10px', marginBottom:10 }}>
                  <div style={{ fontSize:10, fontWeight:700, color:SC.right, marginBottom:4 }}>RIGHT HALF</div>
                  {right.length ? right.map(t=><div key={t.id} style={{display:'flex',alignItems:'center',gap:5,fontSize:11,color:'var(--t2)',marginBottom:2}}><div style={{width:7,height:7,borderRadius:'50%',background:t.color}}/>{t.name}</div>) : <div style={{fontSize:11,color:'var(--t3)',fontStyle:'italic'}}>No toppings</div>}
                </div>
              </>
            ) : (
              <div style={{ background:'rgba(240,165,0,.08)', borderRadius:8, padding:'8px 10px', marginBottom:10 }}>
                <div style={{ fontSize:10, fontWeight:700, color:'var(--acc)', marginBottom:4 }}>WHOLE PIZZA</div>
                {left.length ? left.map(t=><div key={t.id} style={{display:'flex',alignItems:'center',gap:5,fontSize:11,color:'var(--t2)',marginBottom:2}}><div style={{width:7,height:7,borderRadius:'50%',background:t.color}}/>{t.name}</div>) : <div style={{fontSize:11,color:'var(--t3)',fontStyle:'italic'}}>Cheese only</div>}
              </div>
            )}

            <div style={{ borderTop:'1px solid var(--bdr)', paddingTop:10, marginTop:'auto' }}>
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'var(--t3)', marginBottom:2 }}><span>Base</span><span>{money(size.basePrice)}</span></div>
              {crust.extra>0&&<div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'var(--t3)', marginBottom:2 }}><span>Crust</span><span>+{money(crust.extra)}</span></div>}
              {toppingCost>0&&<div style={{ display:'flex', justifyContent:'space-between', fontSize:11, color:'var(--t3)', marginBottom:2 }}><span>Toppings</span><span>+{money(toppingCost)}</span></div>}
              <div style={{ display:'flex', justifyContent:'space-between', fontSize:16, fontWeight:700, marginTop:6, color:'var(--acc)' }}><span>Total</span><span>{money(total)}</span></div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ padding:'14px 24px', borderTop:'1px solid var(--bdr)' }}>
          <div style={{ display:'flex', gap:8 }}>
            <button className="btn btn-ghost" onClick={onCancel} style={{ minWidth:80 }}>Cancel</button>
            <button className="btn btn-acc" onClick={handleAdd} style={{ flex:1, height:46, fontSize:15, borderRadius:12 }}>
              Add pizza · <strong>{money(total)}</strong>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Allergen warning modal ────────────────────────────────────────────────────
export function AllergenModal({ item, activeAllergens, onConfirm, onCancel }) {
  const flagged = (item.allergens || []).filter(a => activeAllergens.includes(a));
  return (
    <div className="modal-back">
      <div className="modal-box" style={{ maxWidth:380 }}>
        <div style={{ width:52, height:52, borderRadius:'50%', background:'var(--red-d)', border:'2px solid var(--red-b)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:22, margin:'0 auto 16px' }}>⚠</div>
        <div style={{ fontSize:18, fontWeight:600, textAlign:'center', marginBottom:4 }}>Allergen warning</div>
        <div style={{ fontSize:13, color:'var(--t2)', textAlign:'center', marginBottom:20 }}>This item contains an active guest allergen filter</div>
        <div style={{ fontSize:15, fontWeight:500, marginBottom:10 }}>{item.name}</div>
        <div style={{ display:'flex', flexWrap:'wrap', gap:5, marginBottom:16 }}>
          {flagged.map(a => {
            const al = ALLERGENS.find(x => x.id === a);
            return <span key={a} style={{ padding:'3px 9px', borderRadius:20, fontSize:12, fontWeight:600, background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)' }}>{al?.icon} {al?.label}</span>;
          })}
        </div>
        <div style={{ background:'var(--red-d)', border:'1px solid var(--red-b)', borderRadius:10, padding:'10px 14px', marginBottom:20, fontSize:12, color:'var(--red)', lineHeight:1.6 }}>
          Confirming adds this item and creates an allergen audit record. Ensure the guest has been informed.
        </div>
        <div style={{ display:'flex', gap:8 }}>
          <button className="btn btn-ghost" style={{ flex:1 }} onClick={onCancel}>Remove item</button>
          <button className="btn btn-red" style={{ flex:1 }} onClick={onConfirm}>Confirm — add anyway</button>
        </div>
      </div>
    </div>
  );
}
