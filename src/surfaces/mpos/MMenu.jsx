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
import MAllergenPicker from './MAllergenPicker';
import MVoiceOrder from './MVoiceOrder';

export default function MMenu({ onPickItem, onOpenCart, onBack, headerTitle, headerSub }) {
  const {
    activeTableId, tables, walkInOrder,
    menuCategories = [], menuItems = [], eightySixIds = [],
    allergens = [],
  } = useStore();

  const [query, setQuery] = useState('');
  const [activeCatId, setActiveCatId] = useState(null);
  const [showAllergens, setShowAllergens] = useState(false);
  const [showVoice, setShowVoice] = useState(false);

  // Compute allergen overlap for a given item — shared across the menu list
  // and the search results so the warning style is consistent. We keep the
  // item visible (rather than hiding) so the server can still pick it after
  // a manager override / customer clarification.
  const allergenHits = (item) => {
    if (!allergens?.length) return [];
    const itemAllergens = item.allergens || [];
    return itemAllergens.filter(a => allergens.includes(a));
  };

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

  // Items by predicate. Hide child variants here (parentId set) so they don't
  // appear as their own rows — they show up inside the parent variant picker.
  const itemsForCategory = (catId) => (menuItems || []).filter(i =>
    !i.hidden && !eightySixIds.includes(i.id) && !i.parentId &&
    (i.cat === catId || (Array.isArray(i.cats) && i.cats.includes(catId)))
  );

  // Search results — flatten everything matching the query (also hides children)
  const searchResults = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return (menuItems || [])
      .filter(i => !i.hidden && !eightySixIds.includes(i.id) && !i.parentId)
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
        {/* Voice-order mic — opens MVoiceOrder bottom sheet */}
        <button onClick={() => setShowVoice(true)} aria-label="Voice order" style={{
          ...Sx.iconBtn,
          background:'var(--acc-d)', border:'1px solid var(--acc-b)',
          color:'var(--acc)', fontSize:18,
        }}>🎤</button>
        {/* Allergy chip — opens the picker. Active state when any allergen is filtered. */}
        <button onClick={() => setShowAllergens(true)} aria-label="Allergy filter" style={{
          ...Sx.iconBtn,
          width:'auto', padding:'0 12px', minWidth:38, gap:5,
          background: allergens.length > 0 ? 'var(--red-d)' : 'var(--bg2)',
          border: `1px solid ${allergens.length > 0 ? 'var(--red-b)' : 'var(--bdr2)'}`,
          color: allergens.length > 0 ? 'var(--red)' : 'var(--t2)',
          fontSize:13, fontWeight:800,
        }}>
          <span style={{ fontSize:14 }}>⚠</span>
          {allergens.length > 0 && <span style={{ fontFamily:'var(--font-mono)' }}>{allergens.length}</span>}
        </button>
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
            allergenHits={allergenHits}
            empty={
              showSearch
                ? { icon:'🔍', title:`No items match "${query}"`, sub:'Try a different search term.' }
                : { icon:'🍽', title:'No items in this category', sub:'Pick another category.' }
            }
            onPick={onPickItem}
          />
        )}
      </div>

      {/* Active allergen warning banner (when filter is on) */}
      {allergens.length > 0 && !showAllergens && (
        <div style={{
          margin:'0 12px 4px', padding:'8px 12px', borderRadius:10,
          background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)',
          fontSize:11, fontWeight:700, display:'flex', alignItems:'center', gap:8, flexShrink:0,
        }}>
          <span style={{ fontSize:14 }}>⚠</span>
          <span style={{ flex:1, lineHeight:1.4 }}>Filtering for {allergens.length} allergen{allergens.length === 1 ? '' : 's'} — flagged items shown crossed out</span>
          <button onClick={() => setShowAllergens(true)} style={{
            background:'transparent', border:'none', color:'var(--red)', fontWeight:800, fontSize:11,
            fontFamily:'inherit', cursor:'pointer', padding:'2px 6px',
          }}>Edit</button>
        </div>
      )}

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

      {/* Allergen picker overlay */}
      {showAllergens && <MAllergenPicker onClose={() => setShowAllergens(false)} />}

      {/* Voice-order overlay */}
      {showVoice && <MVoiceOrder onClose={() => setShowVoice(false)} />}
    </div>
  );
}

// ── Categories grid — big tappable cards, 2-up. Name is the hero — colour
// strip + small icon are accents that never compete with the text.
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
        // Pick the clearest available label — falls back through naming
        // conventions used elsewhere in the codebase. Last resort is a
        // truncated id so the card never appears blank.
        const label = c.name || c.menuName || c.label || c.title || (c.id ? `Category ${String(c.id).slice(-4)}` : 'Category');
        return (
          <button key={c.id} onClick={() => onPick(c)} style={{
            padding:0, borderRadius:14, border:'1px solid var(--bdr)',
            background:'var(--bg2)', overflow:'hidden',
            cursor:'pointer', fontFamily:'inherit', textAlign:'left',
            display:'flex', flexDirection:'column',
            minHeight:120, color:'var(--t1)',
          }}>
            {/* Solid colour strip at top — clear identifier without obscuring text */}
            <div style={{ height:8, background:accent, flexShrink:0 }}/>
            <div style={{ flex:1, padding:'14px 14px', display:'flex', flexDirection:'column', justifyContent:'space-between' }}>
              <div style={{
                fontSize:18, fontWeight:800, color:'var(--t1)', lineHeight:1.2,
                wordBreak:'break-word', hyphens:'auto',
              }}>
                {label}
              </div>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginTop:8 }}>
                <span style={{
                  fontSize:11, fontWeight:800, color: accent, textTransform:'uppercase', letterSpacing:'.06em',
                  padding:'3px 8px', borderRadius:99, background:`${accent}1a`,
                }}>
                  {countFor(c)} item{countFor(c) === 1 ? '' : 's'}
                </span>
                <span style={{ fontSize:18, color:'var(--t4)' }}>›</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Items list (used for both category drill-in and search results) ──────────
function ItemsList({ items, empty, onPick, allergenHits }) {
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
      {items.map(item => (
        <ItemRow
          key={item.id} item={item}
          onTap={() => onPick?.(item)}
          allergenHits={allergenHits ? allergenHits(item) : []}
        />
      ))}
    </div>
  );
}

function ItemRow({ item, onTap, allergenHits = [] }) {
  const price = item?.pricing?.base ?? item?.price ?? 0;
  const hasMods =
    item?.assignedModifierGroups?.length > 0 ||
    item?.modifierGroups?.length > 0 ||
    item?.type === 'modifiable';
  const flagged = allergenHits.length > 0;
  return (
    <button onClick={onTap} style={{
      width:'100%', padding:'12px 14px',
      background: flagged ? 'var(--red-d)' : 'var(--bg2)',
      borderRadius:12,
      border:`1px solid ${flagged ? 'var(--red-b)' : 'var(--bdr)'}`,
      marginBottom:8, display:'flex', gap:10, alignItems:'center', cursor:'pointer',
      minHeight:64, fontFamily:'inherit', textAlign:'left',
      opacity: flagged ? .85 : 1,
    }}>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{
          fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:2,
          overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
          textDecoration: flagged ? 'line-through' : 'none',
        }}>
          {item.name}
        </div>
        {flagged ? (
          <div style={{ fontSize:11, color:'var(--red)', fontWeight:700, lineHeight:1.4 }}>
            ⚠ Contains: {allergenHits.join(', ')}
          </div>
        ) : item.description ? (
          <div style={{ fontSize:11, color:'var(--t4)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            {item.description}
          </div>
        ) : null}
      </div>
      <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:4, flexShrink:0 }}>
        <div style={{ fontSize:14, fontWeight:800, color: flagged ? 'var(--red)' : 'var(--acc)', fontFamily:'var(--font-mono)' }}>
          {money(price)}
        </div>
        {hasMods && <span style={{ ...Sx.pill, background:'var(--bg3)', color:'var(--t4)', border:'1px solid var(--bdr)' }}>OPTIONS</span>}
      </div>
    </button>
  );
}
