// MMenu — phone-native menu browser. Search-first because typing on a phone
// is faster than drilling 4 levels deep. Falls back to category chips and a
// vertical item list when there's no query.
//
// Tapping an item opens MItemDetail (full-screen modifier flow). The cart
// bar at the bottom counts items in the active order (table session OR
// walkInOrder, routed by the store).

import { useState, useMemo } from 'react';
import { useStore } from '../../store';
import { Sx, money } from './MShellStyles';

export default function MMenu({ onPickItem, onOpenCart, onBack, headerTitle, headerSub }) {
  const {
    activeTableId, tables, walkInOrder,
    menuCategories = [], menuItems = [], eightySixIds = [],
  } = useStore();

  const [query, setQuery] = useState('');
  const [activeCatId, setActiveCatId] = useState(null);

  // Items in the active order — works for both table session and walk-in
  const activeItems = useMemo(() => {
    if (activeTableId) {
      const t = tables.find(x => x.id === activeTableId);
      return (t?.session?.items || []).filter(i => !i.voided);
    }
    return walkInOrder?.items || [];
  }, [activeTableId, tables, walkInOrder]);

  const cartCount = activeItems.reduce((s, i) => s + (i.qty || 0), 0);
  const cartSubtotal = activeItems.reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);

  // Top-level categories (no parent)
  const visibleCategories = useMemo(() =>
    menuCategories.filter(c => !c.parentId && c.visible !== false)
  , [menuCategories]);

  // Default to first category if nothing selected
  const effectiveCatId = activeCatId || visibleCategories[0]?.id;

  // Filter logic
  const filteredItems = useMemo(() => {
    const all = (menuItems || []).filter(i => !i.hidden && !eightySixIds.includes(i.id));
    if (query.trim()) {
      const q = query.toLowerCase();
      return all
        .filter(i =>
          (i.name || '').toLowerCase().includes(q) ||
          (i.description || '').toLowerCase().includes(q) ||
          (i.kitchenName || '').toLowerCase().includes(q)
        )
        .slice(0, 60);
    }
    return all.filter(i =>
      i.cat === effectiveCatId ||
      (Array.isArray(i.cats) && i.cats.includes(effectiveCatId))
    );
  }, [menuItems, eightySixIds, query, effectiveCatId]);

  return (
    <div style={Sx.shell}>
      {/* Header */}
      <div style={Sx.header}>
        <button onClick={onBack} style={Sx.iconBtn} aria-label="Back">←</button>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={Sx.hTitle}>{headerTitle || 'Add items'}</div>
          {headerSub && <div style={Sx.hSub}>{headerSub}</div>}
        </div>
      </div>

      {/* Search box */}
      <div style={{ padding:'10px 12px', flexShrink:0, background:'var(--bg)' }}>
        <div style={{ position:'relative' }}>
          <span style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', fontSize:14, color:'var(--t4)', pointerEvents:'none' }}>🔍</span>
          <input
            value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the menu…"
            style={{
              width:'100%', padding:'12px 38px 12px 36px', borderRadius:12, border:'1px solid var(--bdr2)',
              background:'var(--bg2)', color:'var(--t1)', fontSize:14, fontFamily:'inherit', outline:'none', boxSizing:'border-box',
            }}
            autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}/>
          {query && (
            <button onClick={() => setQuery('')} style={{
              position:'absolute', right:6, top:'50%', transform:'translateY(-50%)',
              width:30, height:30, borderRadius:'50%', border:'none', background:'var(--bg3)', color:'var(--t3)',
              cursor:'pointer', fontFamily:'inherit', fontSize:14,
            }}>×</button>
          )}
        </div>
      </div>

      {/* Category chips — hidden during search */}
      {!query && (
        <div style={{ padding:'2px 12px 8px', display:'flex', gap:6, overflowX:'auto', flexShrink:0, WebkitOverflowScrolling:'touch' }}>
          {visibleCategories.length === 0 && (
            <div style={{ fontSize:12, color:'var(--t4)', padding:'6px 0' }}>Menu not loaded yet.</div>
          )}
          {visibleCategories.map(c => {
            const active = c.id === effectiveCatId;
            return (
              <button key={c.id} onClick={() => setActiveCatId(c.id)} style={{
                padding:'8px 14px', borderRadius:99, border:`1.5px solid ${active ? 'var(--acc)' : 'var(--bdr2)'}`,
                background: active ? 'var(--acc-d)' : 'var(--bg2)',
                color: active ? 'var(--acc)' : 'var(--t2)',
                fontSize:12, fontWeight:700, whiteSpace:'nowrap', cursor:'pointer', fontFamily:'inherit', flexShrink:0,
              }}>{c.name}</button>
            );
          })}
        </div>
      )}

      {/* Items list */}
      <div style={{ ...Sx.scroller, paddingBottom: cartCount > 0 ? 110 : 32 }}>
        {filteredItems.length === 0 ? (
          <div style={Sx.emptyBlock}>
            <div style={{ fontSize:36, marginBottom:8, opacity:.3 }}>🍽</div>
            <div style={{ fontSize:14, color:'var(--t3)', fontWeight:700, marginBottom:4 }}>
              {query ? `No items match "${query}"` : 'No items in this category'}
            </div>
            <div style={{ fontSize:12 }}>{query ? 'Try a different search term.' : 'Pick another category or load the menu.'}</div>
          </div>
        ) : (
          <div style={{ padding:'8px 12px' }}>
            {filteredItems.map(item => (
              <ItemRow key={item.id} item={item} onTap={() => onPickItem?.(item)} />
            ))}
          </div>
        )}
      </div>

      {/* Sticky cart bar */}
      {cartCount > 0 && (
        <div style={{
          position:'absolute', left:12, right:12,
          bottom:'calc(12px + env(safe-area-inset-bottom))',
        }}>
          <button onClick={onOpenCart} style={{
            width:'100%', padding:'14px 14px', borderRadius:14, border:'none',
            background:'var(--acc)', color:'#0b0c10', cursor:'pointer', fontFamily:'inherit',
            display:'flex', alignItems:'center', gap:10, boxShadow:'0 6px 22px rgba(0,0,0,.32)',
          }}>
            <span style={{ background:'#0b0c10', color:'var(--acc)', borderRadius:99, padding:'2px 9px', fontWeight:800, fontSize:12 }}>{cartCount}</span>
            <span style={{ flex:1, fontWeight:800, fontSize:14, textAlign:'left' }}>View order</span>
            <span style={{ fontWeight:800, fontSize:14, fontFamily:'var(--font-mono)' }}>{money(cartSubtotal)}</span>
            <span style={{ fontSize:18, fontWeight:800 }}>›</span>
          </button>
        </div>
      )}
    </div>
  );
}

function ItemRow({ item, onTap }) {
  const price = item?.pricing?.base ?? item?.price ?? 0;
  const hasMods = item?.assignedModifierGroups?.length > 0 || item?.modifierGroups?.length > 0 || item?.type === 'modifiable';
  return (
    <button onClick={onTap} style={{
      width:'100%', padding:'12px 14px', background:'var(--bg2)', borderRadius:12, border:'1px solid var(--bdr)',
      marginBottom:8, display:'flex', gap:10, alignItems:'center', cursor:'pointer', minHeight:64, fontFamily:'inherit', textAlign:'left',
    }}>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
          {item.name}
        </div>
        {item.description && (
          <div style={{ fontSize:11, color:'var(--t4)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            {item.description}
          </div>
        )}
      </div>
      <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:4, flexShrink:0 }}>
        <div style={{ fontSize:14, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>
          {money(price)}
        </div>
        {hasMods && <span style={{ ...Sx.pill, background:'var(--bg3)', color:'var(--t4)', border:'1px solid var(--bdr)' }}>OPTIONS</span>}
      </div>
    </button>
  );
}
