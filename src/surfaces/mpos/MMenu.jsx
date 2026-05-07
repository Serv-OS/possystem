// MMenu — phone-native menu browser with a TWO-STEP flow:
//   1) Categories grid — big tappable cards. The category name is unambiguous,
//      colour-coded by category.color when present.
//   2) Items list — drill into a category, header shows the category name with
//      a back arrow to return to the grid.
// Search box is always visible at the top and bypasses the category step
// when a query is present.

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

  // Live cart count + total
  const activeItems = useMemo(() => {
    if (activeTableId) {
      const t = tables.find(x => x.id === activeTableId);
      return (t?.session?.items || []).filter(i => !i.voided);
    }
    return walkInOrder?.items || [];
  }, [activeTableId, tables, walkInOrder]);
  const cartCount = activeItems.reduce((s, i) => s + (i.qty || 0), 0);
  const cartSubtotal = activeItems.reduce((s, i) => s + (i.price || 0) * (i.qty || 0), 0);

  // Top-level visible categories
  const topLevelCategories = useMemo(() =>
    menuCategories.filter(c => !c.parentId && c.visible !== false)
  , [menuCategories]);

  // Items by predicate
  const itemsForCategory = (catId) => (menuItems || []).filter(i =>
    !i.hidden && !eightySixIds.includes(i.id) &&
    (i.cat === catId || (Array.isArray(i.cats) && i.cats.includes(catId)))
  );

  // Search results — flatten everything matching the query
  const searchResults = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return (menuItems || [])
      .filter(i => !i.hidden && !eightySixIds.includes(i.id))
      .filter(i =>
        (i.name || '').toLowerCase().includes(q) ||
        (i.description || '').toLowerCase().includes(q) ||
        (i.kitchenName || '').toLowerCase().includes(q)
      )
      .slice(0, 80);
  }, [menuItems, eightySixIds, query]);

  // Picked category, only when not searching
  const showSearch = query.trim().length > 0;
  const showCategory = !showSearch && activeCatId != null;
  const showCategoryGrid = !showSearch && activeCatId == null;

  const activeCategory = showCategory ? topLevelCategories.find(c => c.id === activeCatId) : null;
  const itemsToShow = showSearch ? searchResults : (showCategory ? itemsForCategory(activeCatId) : []);

  // Header title — different for each step
  let resolvedTitle = headerTitle || 'New order';
  if (showSearch) resolvedTitle = `${searchResults.length} match${searchResults.length === 1 ? '' : 'es'}`;
  else if (showCategory) resolvedTitle = activeCategory?.name || 'Items';

  // Back behaviour: from items grid → go to categories grid; from categories → close
  const handleBack = () => {
    if (showCategory) {
      setActiveCatId(null);
      return;
    }
    onBack?.();
  };

  return (
    <div style={Sx.shell}>
      {/* Header */}
      <div style={Sx.header}>
        <button onClick={handleBack} style={Sx.iconBtn} aria-label="Back">←</button>
        <div style={{ flex:1, minWidth:0 }}>
          <div style={Sx.hTitle}>{resolvedTitle}</div>
          {(headerSub && !showCategory && !showSearch) && <div style={Sx.hSub}>{headerSub}</div>}
          {showCategory && activeCategory && (
            <div style={Sx.hSub}>{itemsForCategory(activeCatId).length} item{itemsForCategory(activeCatId).length === 1 ? '' : 's'}</div>
          )}
        </div>
      </div>

      {/* Search box — always visible */}
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

      {/* Body — categories grid OR items list */}
      <div style={{ ...Sx.scroller, paddingBottom: cartCount > 0 ? 110 : 32 }}>
        {showCategoryGrid && (
          <CategoriesGrid
            categories={topLevelCategories}
            countFor={(c) => itemsForCategory(c.id).length}
            onPick={(c) => setActiveCatId(c.id)}
          />
        )}

        {(showCategory || showSearch) && (
          <ItemsList
            items={itemsToShow}
            empty={
              showSearch
                ? { icon:'🔍', title:`No items match "${query}"`, sub:'Try a different search term.' }
                : { icon:'🍽', title:'No items in this category', sub:'Pick another category.' }
            }
            onPick={onPickItem}
          />
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

// ── Categories grid — big tappable cards, 2-up ────────────────────────────────
function CategoriesGrid({ categories, countFor, onPick }) {
  if (!categories?.length) {
    return (
      <div style={Sx.emptyBlock}>
        <div style={{ fontSize:36, marginBottom:8, opacity:.3 }}>🍽</div>
        <div style={{ fontSize:14, color:'var(--t3)', fontWeight:700, marginBottom:4 }}>Menu not loaded yet</div>
        <div style={{ fontSize:12 }}>Categories will appear here once the menu syncs.</div>
      </div>
    );
  }
  return (
    <div style={{ padding:'10px 12px', display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
      {categories.map(c => {
        const accent = c.color || '#3b82f6';
        return (
          <button key={c.id} onClick={() => onPick(c)} style={{
            padding:'18px 14px', borderRadius:14, border:`1.5px solid ${accent}40`,
            background:`linear-gradient(135deg, ${accent}10, ${accent}22)`,
            cursor:'pointer', fontFamily:'inherit', textAlign:'left',
            display:'flex', flexDirection:'column', justifyContent:'space-between',
            minHeight:108, color:'var(--t1)',
          }}>
            <div style={{ fontSize:24, marginBottom:8, lineHeight:1 }}>{c.icon || '🍽'}</div>
            <div>
              <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)', marginBottom:3, lineHeight:1.2 }}>
                {c.name}
              </div>
              <div style={{ fontSize:11, fontWeight:700, color: accent, textTransform:'uppercase', letterSpacing:'.06em' }}>
                {countFor(c)} item{countFor(c) === 1 ? '' : 's'}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Items list (used for both category drill-in and search results) ──────────
function ItemsList({ items, empty, onPick }) {
  if (!items.length) {
    return (
      <div style={Sx.emptyBlock}>
        <div style={{ fontSize:36, marginBottom:8, opacity:.3 }}>{empty.icon}</div>
        <div style={{ fontSize:14, color:'var(--t3)', fontWeight:700, marginBottom:4 }}>{empty.title}</div>
        <div style={{ fontSize:12 }}>{empty.sub}</div>
      </div>
    );
  }
  return (
    <div style={{ padding:'8px 12px' }}>
      {items.map(item => <ItemRow key={item.id} item={item} onTap={() => onPick?.(item)} />)}
    </div>
  );
}

function ItemRow({ item, onTap }) {
  const price = item?.pricing?.base ?? item?.price ?? 0;
  const hasMods =
    item?.assignedModifierGroups?.length > 0 ||
    item?.modifierGroups?.length > 0 ||
    item?.type === 'modifiable';
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
