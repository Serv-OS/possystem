import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useStore } from '../../store';
import { money } from '../../lib/currency';

// ══════════════════════════════════════════════════════════════════════════════
// CANVAS MENU MANAGER
// Free-form drag-anywhere layout for menu items, variants, and modifier groups.
// Items live on a 2D canvas; operator can arrange them in any flow.
// ══════════════════════════════════════════════════════════════════════════════

const CANVAS_W = 2400;
const CANVAS_H = 1600;
const CARD_W   = 160;
const CARD_H   = 100;
const GROUP_PAD = 20;

const inp = { background:'var(--bg3)', border:'1.5px solid var(--bdr2)', borderRadius:9, padding:'7px 10px', color:'var(--t1)', fontSize:12, fontFamily:'inherit', outline:'none', width:'100%', boxSizing:'border-box' };

export default function CanvasMenu({ catId }) {
  const { menuItems, menuCategories, modifierGroupDefs, updateMenuItem, markBOChange, showToast, addMenuItem } = useStore();

  // Canvas position states per item: { [itemId]: {x, y} }
  // Stored in menuItem.canvasPos = {x, y}
  const [selId, setSelId]         = useState(null);
  const [dragging, setDragging]   = useState(null); // {id, offX, offY}
  const [viewport, setViewport]   = useState({ x:0, y:0, scale:1 });
  const [panning, setPanning]     = useState(false);
  const [panStart, setPanStart]   = useState(null);
  const [catFilter, setCatFilter] = useState('all');
  const [search, setSearch]       = useState('');
  const [showPanel, setShowPanel] = useState(true);

  const canvasRef = useRef(null);

  // Items to show on canvas
  const roots = useMemo(() => menuCategories.filter(c => !c.parentId && !c.isSpecial)
    .sort((a,b) => (a.sortOrder||0)-(b.sortOrder||0)), [menuCategories]);

  const canvasItems = useMemo(() => {
    let items = menuItems.filter(i => !i.archived && i.type !== 'subitem' && !i.parentId);
    // When embedded in a category, filter to that category by default
    const activeCat = catId || (catFilter !== 'all' ? catFilter : null);
    if (activeCat) items = items.filter(i => i.cat === activeCat || (i.cats||[]).includes(activeCat));
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter(i => (i.menuName||i.name||'').toLowerCase().includes(q));
    }
    return items;
  }, [menuItems, catId, catFilter, search]);

  const GRID = 20;
  const COLS = Math.floor((CANVAS_W - 80) / (CARD_W + GRID));
  const getPos = (item) => {
    if (item.canvasPos) return item.canvasPos;
    const i = item.sortOrder ?? 0;
    const col = i % COLS, row = Math.floor(i / COLS);
    return { x: 40 + col * (CARD_W + GRID), y: 40 + row * (CARD_H + GRID) };
  };
  const catFor  = (item) => menuCategories.find(c => c.id === item.cat);

  // ── Drag item ─────────────────────────────────────────────────────────────
  const onItemMouseDown = useCallback((e, id) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const item = menuItems.find(i => i.id === id);
    if (!item) return;
    const pos = getPos(item);
    const mx = (e.clientX - canvasRect.left - viewport.x) / viewport.scale;
    const my = (e.clientY - canvasRect.top  - viewport.y) / viewport.scale;
    setDragging({ id, offX: mx - pos.x, offY: my - pos.y });
    setSelId(id);
  }, [menuItems, viewport]);

  const onCanvasMouseMove = useCallback((e) => {
    if (panning && panStart) {
      const dx = e.clientX - panStart.x;
      const dy = e.clientY - panStart.y;
      setViewport(v => ({ ...v, x: panStart.vx + dx, y: panStart.vy + dy }));
      return;
    }
    if (!dragging) return;
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const mx = (e.clientX - canvasRect.left - viewport.x) / viewport.scale;
    const my = (e.clientY - canvasRect.top  - viewport.y) / viewport.scale;
    const GRID = 20;
    const rawX = mx - dragging.offX;
    const rawY = my - dragging.offY;
    const newX = Math.max(0, Math.min(CANVAS_W - CARD_W, Math.round(rawX/GRID)*GRID));
    const newY = Math.max(0, Math.min(CANVAS_H - CARD_H, Math.round(rawY/GRID)*GRID));
    updateMenuItem(dragging.id, { canvasPos: { x: newX, y: newY } });
  }, [dragging, panning, panStart, viewport, updateMenuItem]);

  const onCanvasMouseUp = useCallback(() => {
    if (dragging) {
      // Only reorder items visible in this category view — don't touch other categories
      const activeCat = catId || (catFilter !== 'all' ? catFilter : null);
      const scopedItems = menuItems.filter(i => {
        if (i.archived || i.parentId) return false;
        if (!activeCat) return true;
        return i.cat === activeCat || (i.cats||[]).includes(activeCat);
      });
      const sorted = [...scopedItems].sort((a,b) => {
        const pa = a.canvasPos || { x:0, y:(a.sortOrder||0)*120 };
        const pb = b.canvasPos || { x:0, y:(b.sortOrder||0)*120 };
        return pa.y !== pb.y ? pa.y - pb.y : pa.x - pb.x;
      });
      sorted.forEach((item, idx) => {
        if ((item.sortOrder??999) !== idx) updateMenuItem(item.id, { sortOrder: idx });
      });
      markBOChange();
      setDragging(null);
    }
    if (panning) setPanning(false);
  }, [dragging, panning, catId, catFilter, markBOChange, menuItems, updateMenuItem]);

  // ── Pan canvas ────────────────────────────────────────────────────────────
  const onCanvasMouseDown = useCallback((e) => {
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      e.preventDefault();
      setPanning(true);
      setPanStart({ x: e.clientX, y: e.clientY, vx: viewport.x, vy: viewport.y });
    }
  }, [viewport]);

  // ── Zoom ──────────────────────────────────────────────────────────────────
  const onWheel = useCallback((e) => {
    e.preventDefault();
    const canvasRect = canvasRef.current.getBoundingClientRect();
    const mx = e.clientX - canvasRect.left;
    const my = e.clientY - canvasRect.top;
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    setViewport(v => {
      const newScale = Math.max(0.3, Math.min(2, v.scale * factor));
      return {
        scale: newScale,
        x: mx - (mx - v.x) * (newScale / v.scale),
        y: my - (my - v.y) * (newScale / v.scale),
      };
    });
  }, []);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [onWheel]);

  const autoLayout = () => {
    const GRID = 20, COLS = Math.floor((CANVAS_W - 80) / (CARD_W + GRID));
    canvasItems.forEach((item, i) => {
      const col = i % COLS, row = Math.floor(i / COLS);
      const x = 40 + col * (CARD_W + GRID);
      const y = 40 + row * (CARD_H + GRID);
      updateMenuItem(item.id, { canvasPos: { x, y }, sortOrder: i });
    });
    markBOChange();
    showToast('Auto-layout applied', 'success');
  };

  const selItem = menuItems.find(i => i.id === selId);
  const selCat  = selItem ? catFor(selItem) : null;

  return (
    <div style={{ display:'flex', height:'100%', overflow:'hidden', userSelect: dragging ? 'none' : 'auto' }}>

      {/* ── Sidebar: category filter + controls ──────────────────────── */}
      {showPanel && (
        <div style={{ width:220, flexShrink:0, borderRight:'1px solid var(--bdr)', display:'flex', flexDirection:'column', overflow:'hidden', background:'var(--bg1)' }}>
          <div style={{ padding:'10px 12px', borderBottom:'1px solid var(--bdr)', display:'flex', gap:6, alignItems:'center' }}>
            <span style={{ fontSize:12, fontWeight:800, color:'var(--t1)', flex:1 }}>Canvas Menu</span>
            <button onClick={()=>setShowPanel(false)} style={{ background:'none', border:'none', color:'var(--t4)', cursor:'pointer', fontSize:16 }}>‹</button>
          </div>

          {/* Search */}
          <div style={{ padding:'8px', borderBottom:'1px solid var(--bdr)' }}>
            <input style={inp} placeholder="Search items…" value={search} onChange={e=>setSearch(e.target.value)}/>
          </div>

          {/* Category filter */}
          <div style={{ flex:1, overflowY:'auto', padding:'6px' }}>
            <div style={{ fontSize:9, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', padding:'4px 6px 6px' }}>Filter by category</div>
            {[{id:'all', label:'All items', icon:'🍽', color:'var(--acc)'}, ...roots].map(c => {
              const count = c.id === 'all' ? canvasItems.length : menuItems.filter(i => !i.archived && !i.parentId && i.cat === c.id).length;
              const active = catFilter === c.id;
              return (
                <button key={c.id} onClick={() => setCatFilter(c.id)}
                  style={{ display:'flex', alignItems:'center', gap:7, width:'100%', padding:'7px 8px', borderRadius:8, border:'none', cursor:'pointer', fontFamily:'inherit', marginBottom:2,
                    background: active ? (c.color||'var(--acc)')+'18' : 'transparent',
                    color: active ? (c.color||'var(--acc)') : 'var(--t2)' }}>
                  <span style={{ fontSize:16 }}>{c.icon}</span>
                  <span style={{ flex:1, fontSize:11, fontWeight:active?700:400, textAlign:'left' }}>{c.label}</span>
                  <span style={{ fontSize:9, color:'var(--t4)' }}>{count}</span>
                </button>
              );
            })}
          </div>

          {/* Canvas controls */}
          <div style={{ padding:'8px', borderTop:'1px solid var(--bdr)', display:'flex', flexDirection:'column', gap:5 }}>
            <div style={{ fontSize:9, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:2 }}>Canvas controls</div>
            <button onClick={autoLayout} style={{ padding:'6px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t2)', fontSize:11, fontWeight:600 }}>⊞ Auto layout</button>
            <button onClick={() => setViewport({x:0,y:0,scale:1})} style={{ padding:'6px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t2)', fontSize:11, fontWeight:600 }}>⊙ Reset view</button>
            <div style={{ fontSize:9, color:'var(--t4)', lineHeight:1.5, marginTop:2 }}>
              Drag items freely · Scroll to zoom<br/>Alt+drag or middle-click to pan
            </div>
            <div style={{ fontSize:10, fontWeight:700, color:'var(--t4)' }}>Zoom: {Math.round(viewport.scale*100)}%</div>
          </div>
        </div>
      )}

      {/* ── Canvas ───────────────────────────────────────────────────── */}
      <div style={{ flex:1, position:'relative', overflow:'hidden', background:'var(--bg)', cursor: panning ? 'grabbing' : dragging ? 'grabbing' : 'default' }}
        ref={canvasRef}
        onMouseDown={onCanvasMouseDown}
        onMouseMove={onCanvasMouseMove}
        onMouseUp={onCanvasMouseUp}
        onMouseLeave={onCanvasMouseUp}>

        {/* Collapse sidebar button */}
        {!showPanel && (
          <button onClick={()=>setShowPanel(true)} style={{ position:'absolute', top:12, left:12, zIndex:10, padding:'6px 10px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg1)', color:'var(--t2)', cursor:'pointer', fontSize:11, fontWeight:600 }}>› Panel</button>
        )}

        {/* Grid dots background */}
        <svg style={{ position:'absolute', inset:0, width:'100%', height:'100%', pointerEvents:'none' }}>
          <defs>
            <pattern id="grid" x={viewport.x % (20*viewport.scale)} y={viewport.y % (20*viewport.scale)}
              width={20*viewport.scale} height={20*viewport.scale} patternUnits="userSpaceOnUse">
              <circle cx={20*viewport.scale/2} cy={20*viewport.scale/2} r="1" fill="var(--bdr)" opacity="0.5"/>
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)"/>
        </svg>

        {/* Transformed canvas */}
        <div style={{ position:'absolute', transformOrigin:'0 0', transform:`translate(${viewport.x}px,${viewport.y}px) scale(${viewport.scale})`, width:CANVAS_W, height:CANVAS_H }}>

          {canvasItems.map(item => {
            const pos     = getPos(item);
            const cat     = catFor(item);
            const color   = cat?.color || 'var(--acc)';
            const isSel   = selId === item.id;
            const isDrag  = dragging?.id === item.id;
            const variantKids = menuItems.filter(c => c.parentId === item.id && !c.archived);
            const hasVars = variantKids.length > 0;
            const hasMods = (item.assignedModifierGroups||[]).length > 0;
            const price   = item.pricing?.base ?? item.price ?? 0;
            const fromP   = hasVars ? Math.min(...variantKids.map(v => v.pricing?.base ?? v.price ?? 0)) : price;

            return (
              <div key={item.id}
                onMouseDown={e => onItemMouseDown(e, item.id)}
                style={{
                  position:'absolute', left:pos.x, top:pos.y, width:CARD_W,
                  borderRadius:14, overflow:'hidden',
                  border:`2px solid ${isSel ? 'var(--acc)' : color+'44'}`,
                  background:'var(--bg1)',
                  boxShadow: isSel ? `0 0 0 3px var(--acc-b), 0 8px 24px rgba(0,0,0,.2)` : isDrag ? '0 16px 40px rgba(0,0,0,.3)' : '0 2px 8px rgba(0,0,0,.1)',
                  cursor: isDrag ? 'grabbing' : 'grab',
                  zIndex: isDrag ? 100 : isSel ? 10 : 1,
                  transition: isDrag ? 'none' : 'box-shadow .15s',
                  userSelect:'none',
                }}>
                {/* Colour accent */}
                <div style={{ height:3, background:color, width:'100%' }}/>
                <div style={{ padding:'9px 10px 8px' }}>
                  <div style={{ fontSize:12, fontWeight:700, color:isSel?'var(--acc)':'var(--t1)', lineHeight:1.3, marginBottom:3, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                    {item.menuName||item.name}
                  </div>
                  <div style={{ fontSize:13, fontWeight:800, color:color, fontFamily:'var(--font-mono)', marginBottom:4 }}>
                    {hasVars ? `from ${money(fromP)}` : price > 0 ? `${money(price)}` : 'free'}
                  </div>
                  <div style={{ display:'flex', gap:3, flexWrap:'wrap' }}>
                    {hasVars && <span style={{ fontSize:8, padding:'1px 5px', borderRadius:5, background:color+'22', color, fontWeight:700 }}>▼ {variantKids.length} sizes</span>}
                    {hasMods && <span style={{ fontSize:8, padding:'1px 5px', borderRadius:5, background:'var(--acc-d)', color:'var(--acc)', fontWeight:700 }}>⊕</span>}
                    {(item.allergens||[]).length>0 && <span style={{ fontSize:8, color:'var(--red)', fontWeight:700 }}>⚠</span>}
                    {cat && <span style={{ fontSize:8, padding:'1px 5px', borderRadius:5, background:color+'18', color }}>{cat.icon}</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Item detail panel — bottom of canvas when item selected */}
        {selItem && (
          <div style={{ position:'absolute', bottom:0, left:0, right:0, background:'var(--bg1)', borderTop:'1px solid var(--bdr)', padding:'10px 16px', display:'flex', alignItems:'center', gap:14, boxShadow:'0 -4px 20px rgba(0,0,0,.1)' }}>
            <div style={{ width:8, height:8, borderRadius:'50%', background:selCat?.color||'var(--acc)', flexShrink:0 }}/>
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{selItem.menuName||selItem.name}</div>
              <div style={{ fontSize:10, color:'var(--t3)' }}>{selCat?.label} · {money((selItem.pricing?.base??selItem.price??0))} · drag to reposition</div>
            </div>
            <div style={{ display:'flex', gap:6 }}>
              {menuItems.filter(c=>c.parentId===selId&&!c.archived).map(v=>(
                <span key={v.id} style={{ fontSize:11, fontWeight:600, padding:'3px 9px', borderRadius:8, background:(selCat?.color||'var(--acc)')+'22', color:selCat?.color||'var(--acc)', border:`1px solid ${(selCat?.color||'var(--acc)')}44` }}>
                  {v.menuName||v.name} {money((v.pricing?.base??v.price??0))}
                </span>
              ))}
              {(selItem.assignedModifierGroups||[]).map(ag=>{
                const def = modifierGroupDefs?.find(d=>d.id===ag.groupId);
                return def ? <span key={ag.groupId} style={{ fontSize:11, fontWeight:600, padding:'3px 9px', borderRadius:8, background:'var(--acc-d)', color:'var(--acc)', border:'1px solid var(--acc-b)' }}>⊕ {def.name}</span> : null;
              })}
            </div>
            <button onClick={()=>setSelId(null)} style={{ padding:'5px 10px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t4)', fontSize:11 }}>✕</button>
          </div>
        )}

        {/* Empty state */}
        {canvasItems.length === 0 && (
          <div style={{ position:'absolute', inset:0, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:10, color:'var(--t4)', pointerEvents:'none' }}>
            <span style={{ fontSize:48, opacity:.1 }}>🍽</span>
            <span style={{ fontSize:14, fontWeight:600 }}>No items in this category</span>
          </div>
        )}
      </div>
    </div>
  );
}
