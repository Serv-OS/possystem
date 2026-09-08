import { useState, useMemo, useRef, useCallback } from 'react';
import { useStore } from '../../store';
import { money } from '../../lib/currency';

// ══════════════════════════════════════════════════════════════════════════════
// MENU VISUALIZER
// Visual swim-lane menu builder. One column per category. Drag items between
// columns to move categories. Drag columns to reorder. Each item card shows
// the complete POS ordering flow: variants → modifiers → instructions.
// Assign menus to channels (POS / Kiosk / Online / Delivery) in the header.
// ══════════════════════════════════════════════════════════════════════════════

const CHANNELS = [
  { id:'pos',     label:'POS',     icon:'🖥' },
  { id:'kiosk',   label:'Kiosk',   icon:'📲' },
  { id:'online',  label:'Online',  icon:'🌐' },
  { id:'delivery',label:'Delivery',icon:'🚗' },
];

export default function MenuVisualizer() {
  const {
    menus, menuCategories, menuItems, modifierGroupDefs, instructionGroupDefs,
    updateMenu, addCategory, updateCategory, removeCategory,
    addMenuItem, updateMenuItem, archiveMenuItem, markBOChange, showToast,
    eightySixIds,
  } = useStore();

  const [selMenuId, setSelMenuId]   = useState(menus[0]?.id || 'menu-1');
  const [selItemId, setSelItemId]   = useState(null);
  const [expandedIds, setExpandedIds] = useState(new Set());
  const [addingCatName, setAddingCatName] = useState('');
  const [addingCat, setAddingCat]   = useState(false);

  // Drag state
  const [dragItem, setDragItem]   = useState(null); // { id, fromCatId }
  const [dragCat, setDragCat]     = useState(null); // category id
  const [overCatId, setOverCatId] = useState(null);
  const [overItemSlot, setOverItemSlot] = useState(null); // { catId, before:itemId }

  const selMenu = menus.find(m => m.id === selMenuId) || menus[0];

  // Categories in this menu, ordered
  const cats = useMemo(() =>
    menuCategories.filter(c => c.menuId === selMenuId && !c.parentId)
      .sort((a,b) => (a.sortOrder||0)-(b.sortOrder||0)),
    [menuCategories, selMenuId]
  );

  // Items per category
  const itemsForCat = useCallback((catId) =>
    menuItems.filter(i => !i.archived && !i.parentId && i.cat === catId)
      .sort((a,b) => (a.sortOrder??999)-(b.sortOrder??999)),
    [menuItems]
  );

  // Channel assignment on menu
  const channels = selMenu?.channels || {};
  const toggleChannel = (ch) => {
    const cur = { ...channels };
    cur[ch] = !cur[ch];
    updateMenu(selMenuId, { channels: cur });
    markBOChange();
  };

  // Flow for an item: [{ type: 'variant'|'modifier'|'instruction', group }]
  const getFlow = (item) => {
    const flow = [];
    const kids = menuItems.filter(c => c.parentId === item.id && !c.archived);
    if (kids.length > 0) {
      flow.push({ type:'variant', label: item.variantLabel||'Size', options: kids.map(k=>k.menuName||k.name) });
    }
    (item.assignedModifierGroups||[]).forEach(ag => {
      const def = modifierGroupDefs?.find(d=>d.id===ag.groupId);
      if (def) flow.push({ type:'modifier', group:def, required:(ag.min||0)>0 });
    });
    (item.assignedInstructionGroups||[]).forEach(e => {
      const gid = typeof e === 'string' ? e : e?.groupId;
      const def = instructionGroupDefs?.find(d=>d.id===gid);
      if (def) flow.push({ type:'instruction', group:def, required: (e?.min ?? def.min ?? 0) > 0 });
    });
    return flow;
  };

  // ── Drag: items ────────────────────────────────────────────────────────────
  const onItemDragStart = (e, itemId, fromCatId) => {
    e.stopPropagation();
    setDragItem({ id:itemId, fromCatId });
    e.dataTransfer.effectAllowed = 'move';
  };
  const onItemDragOver = (e, catId, beforeItemId) => {
    e.preventDefault(); e.stopPropagation();
    setOverCatId(catId); setOverItemSlot({ catId, before:beforeItemId });
  };
  const onItemDrop = (e, toCatId, beforeItemId) => {
    e.preventDefault(); e.stopPropagation();
    if (!dragItem) return;
    const { id, fromCatId } = dragItem;
    // Move to new cat
    if (fromCatId !== toCatId) {
      updateMenuItem(id, { cat:toCatId }); markBOChange();
      showToast('Item moved','success');
    }
    // Reorder within or across
    const catItems = itemsForCat(toCatId).filter(i=>i.id!==id);
    const insertIdx = beforeItemId ? catItems.findIndex(i=>i.id===beforeItemId) : catItems.length;
    const newOrder = [...catItems.slice(0,insertIdx), {id}, ...catItems.slice(insertIdx)];
    newOrder.forEach((item,idx) => updateMenuItem(item.id,{sortOrder:idx}));
    markBOChange();
    setDragItem(null); setOverCatId(null); setOverItemSlot(null);
  };
  const onItemDragEnd = () => { setDragItem(null); setOverCatId(null); setOverItemSlot(null); };

  // ── Drag: categories ──────────────────────────────────────────────────────
  const onCatDragStart = (e, catId) => { setDragCat(catId); e.dataTransfer.effectAllowed='move'; };
  const onCatDragOver  = (e, catId) => { e.preventDefault(); setOverCatId(catId); };
  const onCatDrop      = (e, toCatId) => {
    e.preventDefault();
    if (!dragCat || dragCat === toCatId) { setDragCat(null); return; }
    const arr = [...cats]; const from = arr.findIndex(c=>c.id===dragCat); const to = arr.findIndex(c=>c.id===toCatId);
    if (from<0||to<0) return;
    const [moved] = arr.splice(from,1); arr.splice(to,0,moved);
    arr.forEach((c,i)=>{ if((c.sortOrder||0)!==i) updateCategory(c.id,{sortOrder:i}); });
    markBOChange(); setDragCat(null); setOverCatId(null);
  };

  const selItem = menuItems.find(i=>i.id===selItemId);

  const addCat = () => {
    if (!addingCatName.trim()) return;
    addCategory({ menuId:selMenuId, label:addingCatName.trim(), icon:'🍽', color:'#3b82f6', parentId:null, sortOrder:cats.length });
    markBOChange(); setAddingCatName(''); setAddingCat(false);
  };

  const quickAddItem = (catId) => {
    addMenuItem({ name:'New item', menuName:'New item', receiptName:'New item', kitchenName:'New item',
      type:'simple', cat:catId, allergens:[], pricing:{base:0}, assignedModifierGroups:[], assignedInstructionGroups:[], cats:[], sortOrder:itemsForCat(catId).length });
    markBOChange();
    setTimeout(()=>{
      const last = useStore.getState().menuItems.slice(-1)[0];
      if (last) setSelItemId(last.id);
    },30);
  };

  const toggleExpand = (id) => {
    setExpandedIds(s => { const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n; });
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>

      {/* ── TOP BAR: menu selector + channel assignment ──────────────── */}
      <div style={{ padding:'10px 16px', borderBottom:'1px solid var(--bdr)', background:'var(--bg1)', display:'flex', alignItems:'center', gap:14, flexShrink:0, flexWrap:'wrap' }}>
        {/* Menu selector */}
        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
          <span style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em' }}>Menu</span>
          <select value={selMenuId} onChange={e=>setSelMenuId(e.target.value)} style={{ fontSize:13, fontWeight:700, color:'var(--t1)', background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:8, padding:'5px 10px', cursor:'pointer', fontFamily:'inherit' }}>
            {menus.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>

        <div style={{ width:1, height:24, background:'var(--bdr)', flexShrink:0 }}/>

        {/* Channel assignment */}
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <span style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', flexShrink:0 }}>Active on</span>
          {CHANNELS.map(ch=>{
            const on = channels[ch.id]!==false; // default to true
            return (
              <button key={ch.id} onClick={()=>toggleChannel(ch.id)} style={{ display:'flex', alignItems:'center', gap:4, padding:'4px 10px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', fontSize:11, fontWeight:on?700:400, border:`1.5px solid ${on?'var(--grn-b)':'var(--bdr)'}`, background:on?'var(--grn-d)':'var(--bg3)', color:on?'var(--grn)':'var(--t4)', transition:'all .12s' }}>
                <span>{ch.icon}</span>{ch.label}
              </button>
            );
          })}
        </div>

        <div style={{ marginLeft:'auto', display:'flex', gap:8, alignItems:'center' }}>
          <span style={{ fontSize:10, color:'var(--t4)' }}>{cats.length} categories · {cats.reduce((s,c)=>s+itemsForCat(c.id).length,0)} items</span>
          <button onClick={()=>setAddingCat(v=>!v)} style={{ padding:'5px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:12, fontWeight:700 }}>+ Category</button>
        </div>
      </div>

      {/* Add category inline form */}
      {addingCat && (
        <div style={{ padding:'8px 16px', borderBottom:'1px solid var(--bdr)', background:'var(--acc-d)', display:'flex', gap:8, alignItems:'center', flexShrink:0 }}>
          <input autoFocus value={addingCatName} onChange={e=>setAddingCatName(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')addCat();if(e.key==='Escape'){setAddingCat(false);setAddingCatName('');}}} placeholder="Category name e.g. Starters" style={{ flex:1, maxWidth:300, background:'var(--bg2)', border:'1.5px solid var(--acc)', borderRadius:8, padding:'6px 10px', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none' }}/>
          <button onClick={addCat} style={{ padding:'6px 14px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:12, fontWeight:700 }}>Add</button>
          <button onClick={()=>{setAddingCat(false);setAddingCatName('');}} style={{ padding:'6px 10px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t3)', fontSize:12 }}>Cancel</button>
        </div>
      )}

      {/* ── SWIM LANES ──────────────────────────────────────────────── */}
      <div style={{ flex:1, display:'flex', overflow:'hidden' }}>

        {/* Columns scroll area */}
        <div style={{ flex:1, overflowX:'auto', overflowY:'hidden', display:'flex', padding:'16px', gap:14, alignItems:'flex-start' }}>

          {cats.length === 0 && (
            <div style={{ margin:'60px auto', textAlign:'center', color:'var(--t4)' }}>
              <div style={{ fontSize:48, marginBottom:12, opacity:.15 }}>🍽</div>
              <div style={{ fontSize:15, fontWeight:600, color:'var(--t3)', marginBottom:8 }}>No categories yet</div>
              <div style={{ fontSize:12, color:'var(--t4)', marginBottom:16 }}>Add a category to start building this menu</div>
              <button onClick={()=>setAddingCat(true)} style={{ padding:'8px 20px', borderRadius:10, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:13, fontWeight:700 }}>+ Add first category</button>
            </div>
          )}

          {cats.map(cat => {
            const items = itemsForCat(cat.id);
            const isDragOver = overCatId === cat.id && !!dragItem;
            const isDraggingCat = dragCat === cat.id;
            const color = cat.color || '#3b82f6';

            return (
              <div key={cat.id} draggable={!dragItem}
                onDragStart={e=>onCatDragStart(e,cat.id)}
                onDragOver={e=>{if(dragCat)onCatDragOver(e,cat.id);else if(dragItem)onItemDragOver(e,cat.id,null);}}
                onDrop={e=>dragCat?onCatDrop(e,cat.id):onItemDrop(e,cat.id,null)}
                onDragEnd={()=>setDragCat(null)}
                style={{ width:220, flexShrink:0, display:'flex', flexDirection:'column', maxHeight:'calc(100vh - 160px)',
                  opacity:isDraggingCat?.4:1, transition:'opacity .15s',
                  background: isDragOver?`${color}10`:'var(--bg2)',
                  border:`2px solid ${isDragOver?color:overCatId===cat.id&&dragCat?color+'44':'var(--bdr)'}`,
                  borderRadius:14, overflow:'hidden',
                  boxShadow:isDragOver?`0 0 0 3px ${color}33`:'none' }}>

                {/* Category header */}
                <div style={{ padding:'10px 12px 8px', borderBottom:'1px solid var(--bdr)', background:color+'18', flexShrink:0 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:7 }}>
                    <span style={{ fontSize:8, color:'var(--t4)', cursor:'grab', flexShrink:0 }}>⠿</span>
                    <span style={{ fontSize:18, flexShrink:0 }}>{cat.icon}</span>
                    <span style={{ fontSize:13, fontWeight:800, color:color, flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{cat.label}</span>
                    <span style={{ fontSize:9, color:color, fontWeight:700, flexShrink:0 }}>{items.length}</span>
                    <button onClick={()=>{ if(confirm(`Delete "${cat.label}"?`)){removeCategory(cat.id);markBOChange();}}} style={{ width:18,height:18,borderRadius:5,border:'none',background:'transparent',color:'var(--t4)',cursor:'pointer',fontSize:12,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}>×</button>
                  </div>
                </div>

                {/* Items scroll */}
                <div style={{ flex:1, overflowY:'auto', padding:'8px' }}>
                  {items.map(item => {
                    const flow = getFlow(item);
                    const isExpanded = expandedIds.has(item.id);
                    const isSel = selItemId === item.id;
                    const is86 = eightySixIds.includes(item.id);
                    const isDragging = dragItem?.id === item.id;
                    const price = item.pricing?.base ?? item.price ?? 0;
                    const kids = menuItems.filter(c=>c.parentId===item.id&&!c.archived);
                    const fromP = kids.length>0?Math.min(...kids.map(k=>k.pricing?.base??k.price??0)):price;
                    const hasFlow = flow.length>0;

                    return (
                      <div key={item.id}
                        onDragOver={e=>onItemDragOver(e,cat.id,item.id)}
                        onDrop={e=>onItemDrop(e,cat.id,item.id)}
                        style={{ marginBottom:6, opacity:isDragging?.3:1 }}>
                        {/* Drop indicator above */}
                        {overItemSlot?.catId===cat.id && overItemSlot?.before===item.id && dragItem?.id!==item.id && (
                          <div style={{ height:3, background:'var(--acc)', borderRadius:2, marginBottom:4 }}/>
                        )}
                        <div
                          draggable
                          onDragStart={e=>onItemDragStart(e,item.id,cat.id)}
                          onDragEnd={onItemDragEnd}
                          onClick={()=>setSelItemId(isSel?null:item.id)}
                          style={{ borderRadius:10, border:`2px solid ${isSel?'var(--acc)':is86?'var(--red-b)':'var(--bdr)'}`, background:isSel?'var(--acc-d)':is86?'var(--red-d)':'var(--bg1)', cursor:'pointer', userSelect:'none', overflow:'hidden', boxShadow:isSel?'0 0 0 2px var(--acc-b)':'none', transition:'all .12s' }}>
                          {/* Color bar */}
                          <div style={{ height:2, background:is86?'var(--red)':color }}/>
                          <div style={{ padding:'8px 10px' }}>
                            <div style={{ display:'flex', alignItems:'flex-start', gap:6 }}>
                              <div style={{ flex:1, minWidth:0 }}>
                                <div style={{ fontSize:12, fontWeight:700, color:isSel?'var(--acc)':is86?'var(--red)':'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', lineHeight:1.3 }}>{item.menuName||item.name}</div>
                                <div style={{ fontSize:12, fontWeight:800, color:isSel?'var(--acc)':color, fontFamily:'var(--font-mono)', marginTop:2 }}>
                                  {kids.length>0?`from ${money(fromP)}`:`${money(price)}`}
                                </div>
                              </div>
                              <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:4, flexShrink:0 }}>
                                {is86&&<span style={{ fontSize:7, fontWeight:800, padding:'1px 4px', borderRadius:4, background:'var(--red-d)', color:'var(--red)', border:'1px solid var(--red-b)' }}>86'd</span>}
                                {hasFlow&&<button onClick={e=>{e.stopPropagation();toggleExpand(item.id);}} style={{ fontSize:9, color:'var(--t4)', background:'none', border:'none', cursor:'pointer', padding:0, lineHeight:1 }}>{isExpanded?'▲':'▼'} flow</button>}
                              </div>
                            </div>

                            {/* Flow visualization — the unique feature */}
                            {isExpanded && hasFlow && (
                              <div style={{ marginTop:8, paddingTop:7, borderTop:'1px solid var(--bdr)' }}>
                                {flow.map((step, si) => (
                                  <div key={si} style={{ marginBottom:5 }}>
                                    <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                                      <div style={{ width:16, height:16, borderRadius:'50%', background:step.type==='variant'?color:step.type==='modifier'?'var(--acc)':'var(--grn)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:8, fontWeight:800, color:'#fff', flexShrink:0 }}>{si+1}</div>
                                      <span style={{ fontSize:10, fontWeight:700, color:'var(--t2)' }}>
                                        {step.type==='variant'?step.label:step.group?.name}
                                        {step.type==='modifier'&&step.required&&<span style={{ fontSize:8, color:'var(--red)', marginLeft:3 }}>★</span>}
                                      </span>
                                      {step.type==='instruction'&&<span style={{ fontSize:8, color:'var(--grn)', fontWeight:600 }}>no charge</span>}
                                    </div>
                                    <div style={{ marginLeft:21, fontSize:9, color:'var(--t4)', lineHeight:1.4 }}>
                                      {step.type==='variant'
                                        ? step.options.slice(0,3).join(' · ') + (step.options.length>3?'…':'')
                                        : (step.group?.options||[]).slice(0,3).map(o=>o.name||o).join(' · ') + ((step.group?.options||[]).length>3?'…':'')}
                                    </div>
                                    {/* Nested modifier indicator */}
                                    {step.type==='modifier' && (step.group?.options||[]).some(o=>o.subGroupId) && (
                                      <div style={{ marginLeft:21, marginTop:2 }}>
                                        {(step.group.options||[]).filter(o=>o.subGroupId).map(o=>{
                                          const sub = modifierGroupDefs?.find(d=>d.id===o.subGroupId);
                                          return sub ? (
                                            <div key={o.id} style={{ fontSize:8, color:'var(--acc)', display:'flex', alignItems:'center', gap:3 }}>
                                              <span>↳ {o.name}: {sub.name}</span>
                                            </div>
                                          ) : null;
                                        })}
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}

                  {/* Drop zone at end of list */}
                  <div onDragOver={e=>onItemDragOver(e,cat.id,null)} onDrop={e=>onItemDrop(e,cat.id,null)}
                    style={{ minHeight:32, borderRadius:8, border:`1.5px dashed ${overItemSlot?.catId===cat.id&&overItemSlot?.before===null?color:'var(--bdr)'}`, background:overItemSlot?.catId===cat.id&&overItemSlot?.before===null?`${color}10`:'transparent', transition:'all .15s', display:'flex', alignItems:'center', justifyContent:'center' }}>
                    {(!dragItem||overItemSlot?.catId!==cat.id) && (
                      <button onClick={()=>quickAddItem(cat.id)} style={{ fontSize:11, fontWeight:600, color:color, background:'none', border:'none', cursor:'pointer', fontFamily:'inherit', padding:'6px 0', width:'100%', textAlign:'center' }}>+ Add item</button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Add category column */}
          {cats.length > 0 && (
            <div onClick={()=>setAddingCat(true)} style={{ width:180, flexShrink:0, height:100, borderRadius:14, border:'2px dashed var(--bdr)', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:6, cursor:'pointer', color:'var(--t4)', transition:'all .15s' }}
              onMouseEnter={e=>{e.currentTarget.style.borderColor='var(--acc)';e.currentTarget.style.color='var(--acc)';}}
              onMouseLeave={e=>{e.currentTarget.style.borderColor='var(--bdr)';e.currentTarget.style.color='var(--t4)';}}>
              <div style={{ fontSize:24 }}>+</div>
              <div style={{ fontSize:11, fontWeight:600 }}>Add category</div>
            </div>
          )}
        </div>

        {/* ── Item detail panel ─────────────────────────────────────── */}
        {selItem && (
          <ItemQuickEdit item={selItem} onClose={()=>setSelItemId(null)}
            menuItems={menuItems} menuCategories={menuCategories}
            modifierGroupDefs={modifierGroupDefs} instructionGroupDefs={instructionGroupDefs}
            updateMenuItem={(id,patch)=>{updateMenuItem(id,patch);markBOChange();}}
            addMenuItem={(item)=>{addMenuItem(item);markBOChange();}}
            onArchive={()=>{archiveMenuItem(selItem.id);setSelItemId(null);markBOChange();showToast('Archived','info');}}
            markBOChange={markBOChange} showToast={showToast}/>
        )}
      </div>
    </div>
  );
}

// ── Item quick-edit panel (slides in from right in visualizer) ────────────────
function ItemQuickEdit({ item, onClose, menuItems, menuCategories, modifierGroupDefs, instructionGroupDefs, updateMenuItem, addMenuItem, onArchive, markBOChange, showToast }) {
  const { eightySixIds, toggle86, modifierGroupDefs:allMods, instructionGroupDefs:allInsts } = useStore();
  const [sec, setSec] = useState('details');
  const [modSearch, setModSearch] = useState('');
  const [instSearch, setInstSearch] = useState('');

  const p = item.pricing || { base: item.price || 0 };
  const is86 = eightySixIds.includes(item.id);
  const variants = menuItems.filter(c=>c.parentId===item.id&&!c.archived).sort((a,b)=>(a.sortOrder??999)-(b.sortOrder??999));
  const isParent = variants.length>0;
  const isPizza = item.type==='pizza';

  const f = (k,v) => updateMenuItem(item.id,{[k]:v});
  const fp = (k,v) => updateMenuItem(item.id,{pricing:{...p,[k]:v===''?null:parseFloat(v)||0},...(k==='base'?{price:parseFloat(v)||0}:{})});

  const assignedMods = item.assignedModifierGroups||[];
  // Shape-tolerant: accept legacy string[] or new [{groupId,min?}] and always write objects
  const assignedInst = (item.assignedInstructionGroups||[]).map(e => typeof e === 'string' ? { groupId: e } : e);
  const hasInst = gid => assignedInst.some(a => a.groupId === gid);

  const addMod = gid => {
    if (assignedMods.find(ag=>ag.groupId===gid)) return;
    updateMenuItem(item.id,{assignedModifierGroups:[...assignedMods,{groupId:gid,min:0,max:1}]});
    setModSearch('');
  };
  const removeMod = gid => updateMenuItem(item.id,{assignedModifierGroups:assignedMods.filter(ag=>ag.groupId!==gid)});
  const updateMod = (gid,patch) => updateMenuItem(item.id,{assignedModifierGroups:assignedMods.map(ag=>ag.groupId===gid?{...ag,...patch}:ag)});
  const reorderMods = (from,to) => {
    const arr=[...assignedMods];const[m]=arr.splice(from,1);arr.splice(to,0,m);
    updateMenuItem(item.id,{assignedModifierGroups:arr});
  };
  const addInst = gid => { if(hasInst(gid))return; updateMenuItem(item.id,{assignedInstructionGroups:[...assignedInst, { groupId: gid }]}); setInstSearch(''); };
  const removeInst = gid => updateMenuItem(item.id,{assignedInstructionGroups:assignedInst.filter(a=>a.groupId!==gid)});

  const filteredMods = (allMods||[]).filter(g=>!assignedMods.find(ag=>ag.groupId===g.id)&&(modSearch===''||(g.name||'').toLowerCase().includes(modSearch.toLowerCase())));
  const filteredInst = (allInsts||[]).filter(g=>!hasInst(g.id)&&(instSearch===''||(g.name||'').toLowerCase().includes(instSearch.toLowerCase())));

  const SECS = [
    {id:'details',label:'Details'},
    !item.type?.includes('sub')&&{id:'pricing',label:'Pricing'},
    !item.type?.includes('sub')&&{id:'modifiers',label:`Mods${assignedMods.length>0?` (${assignedMods.length})`:''}` },
    !item.type?.includes('sub')&&isParent&&{id:'sizes',label:`Sizes (${variants.length})`},
    {id:'allergens',label:'Allergens'},
  ].filter(Boolean);

  const inp = {background:'var(--bg3)',border:'1.5px solid var(--bdr2)',borderRadius:9,padding:'7px 10px',color:'var(--t1)',fontSize:12,fontFamily:'inherit',outline:'none',width:'100%',boxSizing:'border-box'};
  const lbl = {fontSize:10,fontWeight:700,color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.07em',display:'block',marginBottom:5};

  return (
    <div style={{ width:380, borderLeft:'1px solid var(--bdr)', display:'flex', flexDirection:'column', background:'var(--bg1)', flexShrink:0, overflow:'hidden' }}>

      {/* Header */}
      <div style={{ padding:'12px 14px 0', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
        <div style={{ display:'flex', alignItems:'flex-start', gap:8, marginBottom:10 }}>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:14, fontWeight:800, color:'var(--t1)', lineHeight:1.3, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{item.menuName||item.name}</div>
            <div style={{ fontSize:10, color:'var(--t4)', marginTop:2 }}>{item.type} · {money((p.base||0))}{isParent?` · ${variants.length} sizes`:''}</div>
          </div>
          <button onClick={()=>toggle86(item.id)} style={{ fontSize:9,padding:'2px 7px',borderRadius:8,cursor:'pointer',fontFamily:'inherit',border:`1px solid ${is86?'var(--grn-b)':'var(--red-b)'}`,background:is86?'var(--grn-d)':'var(--red-d)',color:is86?'var(--grn)':'var(--red)',fontWeight:700,flexShrink:0 }}>{is86?'Un-86':'86'}</button>
          <button onClick={onClose} style={{ background:'none',border:'none',color:'var(--t4)',cursor:'pointer',fontSize:18,lineHeight:1 }}>×</button>
        </div>

        {/* Scope: local/shared/global */}
        <div style={{ display:'flex', gap:4, marginBottom:10 }}>
          {[['local','Local'],['shared','Shared'],['global','Global']].map(([v,l])=>{
            const act=(item.scope||'local')===v;
            return <button key={v} onClick={()=>f('scope',v)} style={{ padding:'3px 9px',borderRadius:8,cursor:'pointer',fontFamily:'inherit',fontSize:10,fontWeight:act?700:400,border:`1px solid ${act?'var(--acc)':'var(--bdr)'}`,background:act?'var(--acc-d)':'var(--bg3)',color:act?'var(--acc)':'var(--t4)',flex:1,textAlign:'center' }}>{l}</button>;
          })}
        </div>

        <div style={{ display:'flex', gap:0, overflowX:'auto' }}>
          {SECS.map(s=><button key={s.id} onClick={()=>setSec(s.id)} style={{ padding:'7px 11px',cursor:'pointer',fontFamily:'inherit',border:'none',borderBottom:`2px solid ${sec===s.id?'var(--acc)':'transparent'}`,background:'transparent',color:sec===s.id?'var(--acc)':'var(--t4)',fontSize:11,fontWeight:sec===s.id?700:400,whiteSpace:'nowrap',flexShrink:0 }}>{s.label}</button>)}
        </div>
      </div>

      <div style={{ flex:1, overflowY:'auto', padding:'14px' }}>

        {sec==='details' && (
          <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
            <div><span style={lbl}>POS name</span><input style={inp} value={item.menuName||''} onChange={e=>f('menuName',e.target.value)}/></div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              <div><span style={lbl}>Receipt</span><input style={inp} value={item.receiptName||''} onChange={e=>f('receiptName',e.target.value)}/></div>
              <div><span style={lbl}>Kitchen</span><input style={inp} value={item.kitchenName||''} onChange={e=>f('kitchenName',e.target.value)}/></div>
            </div>
            <div><span style={lbl}>Description</span><textarea style={{...inp,resize:'none',height:52}} value={item.description||''} onChange={e=>f('description',e.target.value)}/></div>
            <div>
              <span style={lbl}>Type</span>
              <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
                {[['simple','Simple'],['modifiable','Modifiable'],['variants','Has sizes'],['pizza','Pizza']].map(([v,l])=>{
                  const act=(item.type||'simple')===v||(v==='variants'&&isParent);
                  return <button key={v} onClick={()=>f('type',v)} style={{ padding:'3px 8px',borderRadius:7,cursor:'pointer',fontFamily:'inherit',fontSize:10,fontWeight:act?700:400,border:`1px solid ${act?'var(--acc)':'var(--bdr)'}`,background:act?'var(--acc-d)':'var(--bg3)',color:act?'var(--acc)':'var(--t4)' }}>{l}</button>;
                })}
              </div>
            </div>
            <div>
              <span style={lbl}>Visible on</span>
              <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
                {[['pos','POS'],['kiosk','Kiosk'],['online','Online'],['onlineDelivery','Delivery']].map(([k,l])=>{
                  const on=(item.visibility||{pos:true,kiosk:true,online:true,onlineDelivery:true})[k]!==false;
                  return <button key={k} onClick={()=>f('visibility',{...(item.visibility||{pos:true,kiosk:true,online:true,onlineDelivery:true}),[k]:!on})} style={{ padding:'3px 9px',borderRadius:9,cursor:'pointer',fontFamily:'inherit',fontSize:11,fontWeight:on?700:400,border:`1px solid ${on?'var(--grn-b)':'var(--bdr)'}`,background:on?'var(--grn-d)':'var(--bg3)',color:on?'var(--grn)':'var(--t4)' }}>{on?'✓ ':''}{l}</button>;
                })}
              </div>
            </div>
          </div>
        )}

        {sec==='pricing' && (
          <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
            <div style={{ padding:'8px 10px', background:'var(--bg3)', borderRadius:8, fontSize:11, color:'var(--t3)', marginBottom:4 }}>
              Scope: <strong>{item.scope||'local'}</strong> — {item.scope==='global'?'one price everywhere':item.scope==='shared'?'pricing inherited from shared rule':'price set on this item only'}
            </div>
            {[{k:'base',label:'Base price',accent:true},{k:'dineIn',label:'Dine-in'},{k:'takeaway',label:'Takeaway'},{k:'collection',label:'Collection'},{k:'delivery',label:'Delivery'}].map(({k,label,accent})=>(
              <div key={k}>
                <span style={lbl}>{label}</span>
                <div style={{ position:'relative' }}>
                  <span style={{ position:'absolute',left:10,top:'50%',transform:'translateY(-50%)',fontSize:accent?15:13,color:accent?'var(--acc)':'var(--t4)',fontWeight:700 }}>£</span>
                  <input type="number" step="0.01" min="0" style={{...inp,paddingLeft:26,fontSize:accent?15:13,fontWeight:accent?800:400,color:accent?'var(--acc)':'var(--t1)'}} value={k==='base'?(p.base||0):(p[k]!==null&&p[k]!==undefined?p[k]:'')} placeholder={k!=='base'?`${p.base||0} (base)`:''} onChange={e=>fp(k,e.target.value)}/>
                </div>
              </div>
            ))}
          </div>
        )}

        {sec==='modifiers' && (
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
            <div>
              <div style={{ fontSize:10,fontWeight:700,color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.07em',marginBottom:8 }}>Assigned groups <span style={{ fontWeight:400,textTransform:'none' }}>— drag to reorder</span></div>
              {assignedMods.length===0&&<div style={{ padding:'8px',fontSize:11,color:'var(--t4)',textAlign:'center',background:'var(--bg3)',borderRadius:8,marginBottom:8 }}>None assigned</div>}
              {assignedMods.map((ag,i)=>{
                const def=(allMods||[]).find(g=>g.id===ag.groupId);
                if(!def)return null;
                return (
                  <div key={ag.groupId} draggable
                    onDragStart={()=>{}} onDragEnd={()=>{}}
                    style={{ display:'flex',alignItems:'center',gap:7,padding:'7px 10px',marginBottom:5,borderRadius:9,border:'1.5px solid var(--bdr)',background:'var(--bg2)' }}>
                    <span style={{ fontSize:10,color:'var(--t4)',cursor:'grab' }}>⠿</span>
                    <div style={{ flex:1,minWidth:0 }}>
                      <div style={{ fontSize:12,fontWeight:700,color:'var(--t1)' }}>{def.name}</div>
                      <div style={{ fontSize:9,color:'var(--t4)' }}>{(def.options||[]).length} options</div>
                    </div>
                    <button onClick={()=>updateMod(ag.groupId,{min:(ag.min||0)>0?0:1})} style={{ padding:'2px 7px',borderRadius:7,cursor:'pointer',fontFamily:'inherit',fontSize:9,fontWeight:700,border:`1px solid ${(ag.min||0)>0?'var(--red-b)':'var(--bdr)'}`,background:(ag.min||0)>0?'var(--red-d)':'var(--bg3)',color:(ag.min||0)>0?'var(--red)':'var(--t4)',whiteSpace:'nowrap' }}>{(ag.min||0)>0?'Req':'Opt'}</button>
                    <button onClick={()=>removeMod(ag.groupId)} style={{ width:22,height:22,borderRadius:6,border:'1px solid var(--red-b)',background:'var(--red-d)',color:'var(--red)',cursor:'pointer',fontSize:12,display:'flex',alignItems:'center',justifyContent:'center' }}>×</button>
                  </div>
                );
              })}
              <div style={{ position:'relative',marginTop:4 }}>
                <span style={{ position:'absolute',left:9,top:'50%',transform:'translateY(-50%)',fontSize:12,color:'var(--t4)' }}>🔍</span>
                <input style={{...inp,paddingLeft:28,fontSize:12}} value={modSearch} onChange={e=>setModSearch(e.target.value)} placeholder="Search modifier groups…"/>
              </div>
              {filteredMods.slice(0,6).map(g=>(
                <div key={g.id} onClick={()=>addMod(g.id)} style={{ display:'flex',alignItems:'center',gap:8,padding:'7px 10px',marginTop:4,borderRadius:8,border:'1px solid var(--bdr)',cursor:'pointer',background:'var(--bg2)' }} onMouseEnter={e=>e.currentTarget.style.background='var(--bg3)'} onMouseLeave={e=>e.currentTarget.style.background='var(--bg2)'}>
                  <div style={{ flex:1 }}><div style={{ fontSize:12,fontWeight:600 }}>{g.name}</div><div style={{ fontSize:9,color:'var(--t4)' }}>{(g.options||[]).length} options</div></div>
                  <span style={{ fontSize:11,fontWeight:700,color:'var(--acc)' }}>+</span>
                </div>
              ))}
            </div>

            <div>
              <div style={{ fontSize:10,fontWeight:700,color:'var(--t3)',textTransform:'uppercase',letterSpacing:'.07em',marginBottom:8 }}>Instruction groups</div>
              {assignedInst.map(gid=>{const def=(allInsts||[]).find(g=>g.id===gid);return def?<div key={gid} style={{ display:'flex',alignItems:'center',gap:8,padding:'6px 10px',marginBottom:4,borderRadius:8,border:'1.5px solid var(--grn-b)',background:'var(--grn-d)' }}><span style={{ fontSize:12,fontWeight:700,color:'var(--grn)',flex:1 }}>{def.name}</span><button onClick={()=>removeInst(gid)} style={{ width:20,height:20,borderRadius:5,border:'1px solid var(--grn-b)',background:'transparent',color:'var(--grn)',cursor:'pointer',fontSize:12 }}>×</button></div>:null;})}
              <div style={{ position:'relative' }}><span style={{ position:'absolute',left:9,top:'50%',transform:'translateY(-50%)',fontSize:12,color:'var(--t4)' }}>🔍</span><input style={{...inp,paddingLeft:28,fontSize:12}} value={instSearch} onChange={e=>setInstSearch(e.target.value)} placeholder="Search instruction groups…"/></div>
              {filteredInst.slice(0,4).map(g=>(
                <div key={g.id} onClick={()=>addInst(g.id)} style={{ display:'flex',alignItems:'center',gap:8,padding:'7px 10px',marginTop:4,borderRadius:8,border:'1px solid var(--bdr)',cursor:'pointer' }} onMouseEnter={e=>e.currentTarget.style.background='var(--bg3)'} onMouseLeave={e=>e.currentTarget.style.background=''}>
                  <div style={{ flex:1 }}><div style={{ fontSize:12,fontWeight:600 }}>{g.name}</div></div>
                  <span style={{ fontSize:11,fontWeight:700,color:'var(--grn)' }}>+</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {sec==='sizes' && (
          <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
            <div style={{ fontSize:10,color:'var(--t3)',marginBottom:4 }}>Drag to reorder · prices set per size</div>
            {variants.map((v,vi)=>{
              const vp=v.pricing||{base:v.price||0};
              return (
                <div key={v.id} style={{ display:'grid',gridTemplateColumns:'18px 1fr 90px 32px',gap:6,alignItems:'center' }}>
                  <span style={{ fontSize:10,color:'var(--t4)',cursor:'grab',textAlign:'center' }}>⠿</span>
                  <input style={inp} value={v.menuName||v.name||''} onChange={e=>updateMenuItem(v.id,{menuName:e.target.value,name:e.target.value,receiptName:e.target.value,kitchenName:e.target.value})} placeholder={`Size ${vi+1}`}/>
                  <div style={{ position:'relative' }}>
                    <span style={{ position:'absolute',left:8,top:'50%',transform:'translateY(-50%)',fontSize:11,color:'var(--t4)' }}>£</span>
                    <input type="number" step="0.01" min="0" style={{...inp,paddingLeft:18,color:'var(--acc)',fontWeight:700}} value={vp.base||''} placeholder="0.00" onChange={e=>updateMenuItem(v.id,{pricing:{...vp,base:parseFloat(e.target.value)||0},price:parseFloat(e.target.value)||0})}/>
                  </div>
                  <button onClick={()=>{updateMenuItem(v.id,{archived:true,parentId:null});if(variants.filter(x=>x.id!==v.id).length===0)f('type','simple');}} style={{ width:32,height:34,borderRadius:7,border:'1px solid var(--red-b)',background:'var(--red-d)',color:'var(--red)',cursor:'pointer',fontSize:14,display:'flex',alignItems:'center',justifyContent:'center' }}>×</button>
                </div>
              );
            })}
            <button onClick={()=>{addMenuItem({name:'New size',menuName:'New size',type:'simple',parentId:item.id,cat:item.cat,allergens:[],pricing:{base:0},assignedModifierGroups:[],assignedInstructionGroups:[],sortOrder:variants.length});if(item.type!=='variants')f('type','variants');}} style={{ padding:'8px',borderRadius:9,cursor:'pointer',fontFamily:'inherit',background:'var(--bg3)',border:'1.5px dashed var(--bdr2)',color:'var(--t2)',fontSize:12,fontWeight:600 }}>+ Add size</button>
          </div>
        )}

        {sec==='allergens' && (
          <div style={{ display:'grid',gridTemplateColumns:'1fr 1fr',gap:5 }}>
            {[{id:'gluten',icon:'🌾',label:'Gluten'},{id:'milk',icon:'🥛',label:'Milk'},{id:'eggs',icon:'🥚',label:'Eggs'},{id:'nuts',icon:'🥜',label:'Nuts'},{id:'fish',icon:'🐟',label:'Fish'},{id:'shellfish',icon:'🦐',label:'Shellfish'},{id:'soya',icon:'🫘',label:'Soya'},{id:'sesame',icon:'⬛',label:'Sesame'},{id:'celery',icon:'🌿',label:'Celery'},{id:'mustard',icon:'🌱',label:'Mustard'},{id:'sulphites',icon:'🍷',label:'Sulphites'},{id:'lupin',icon:'🌼',label:'Lupin'},{id:'molluscs',icon:'🐚',label:'Molluscs'},{id:'peanuts',icon:'🥜',label:'Peanuts'}].map(a=>{
              const on=(item.allergens||[]).includes(a.id);
              return <button key={a.id} onClick={()=>f('allergens',on?(item.allergens||[]).filter(x=>x!==a.id):[...(item.allergens||[]),a.id])} style={{ display:'flex',alignItems:'center',gap:6,padding:'6px 8px',borderRadius:8,cursor:'pointer',fontFamily:'inherit',border:`1.5px solid ${on?'var(--red)':'var(--bdr)'}`,background:on?'var(--red-d)':'var(--bg3)' }}>
                <div style={{ width:14,height:14,borderRadius:3,border:`2px solid ${on?'var(--red)':'var(--bdr2)'}`,background:on?'var(--red)':'transparent',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center' }}>{on&&<div style={{ width:5,height:5,borderRadius:1,background:'#fff' }}/>}</div>
                <span style={{ fontSize:11,fontWeight:on?700:400,color:on?'var(--red)':'var(--t1)' }}>{a.icon} {a.label}</span>
              </button>;
            })}
          </div>
        )}

      </div>

      <div style={{ padding:'8px 14px',borderTop:'1px solid var(--bdr)',flexShrink:0 }}>
        <button onClick={()=>{if(confirm('Archive?'))onArchive();}} style={{ width:'100%',padding:'6px',borderRadius:8,cursor:'pointer',fontFamily:'inherit',background:'transparent',border:'1px solid var(--red-b)',color:'var(--red)',fontSize:11,fontWeight:600 }}>Archive item</button>
      </div>
    </div>
  );
}
