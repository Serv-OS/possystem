// MMenu — phone-native menu browser with a TWO-STEP flow:
//   1) Categories grid — big tappable cards. The category name is unambiguous,
//      colour-coded by category.color when present.
//   2) Items list — drill into a category, header shows the category name with
//      a back arrow to return to the grid.
// Search box is always visible at the top and bypasses the category step
// when a query is present.

import { useState, useMemo, useEffect } from 'react';
import { useStore } from '../../store';
import { fetchMenuCategoryLinks } from '../../lib/db';
import { Sx, money } from './MShellStyles';
import MAllergenPicker from './MAllergenPicker';
import MVoiceOrder from './MVoiceOrder';
import { resolveActiveMenu } from '../../lib/mpos/resolveActiveMenu';

export default function MMenu({ onPickItem, onOpenCart, onBack, headerTitle, headerSub }) {
  const {
    activeTableId, tables, walkInOrder,
    menuCategories = [], menuItems = [], eightySixIds = [],
    allergens = [], menus = [], deviceConfig,
  } = useStore();
  // Active menu resolution — same logic the desktop POS uses (resolveActiveMenu
  // ports POSSurface's deviceMenuId chain). Honours device-profile pinning,
  // schedule-based scheduling, default-flagged menus, in priority order. This
  // is what fixes "I set Main in BO but the phone still shows Test menu" —
  // we now use the EXACT same resolver.
  const effectiveMenuId = useMemo(
    () => resolveActiveMenu({ menus, deviceConfig }),
    [menus, deviceConfig]
  );

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

  // v5.5.788: mirror the POS rule (v4.7.6) — a menu owns a category via
  // category.menuId (primary home) OR the menu_category_links join table.
  // MPOS previously matched menuId only, so categories joined to the active
  // menu via links showed on the POS/bar but never on the phone.
  const [categoryLinks, setCategoryLinks] = useState([]);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { data } = await fetchMenuCategoryLinks();
        if (alive) setCategoryLinks(data || []);
      } catch (e) {
        console.warn('[MMenu] fetchMenuCategoryLinks failed:', e?.message || e);
      }
    })();
    return () => { alive = false; };
  }, []);
  const linkedCatIds = useMemo(() => effectiveMenuId
    ? new Set((categoryLinks || []).filter(l => l.menu_id === effectiveMenuId).map(l => l.category_id))
    : new Set(), [categoryLinks, effectiveMenuId]);

  // Top-level visible categories — STRICT filter when an active menu is set.
  // If the user explicitly set "Main" in BO and a category belongs to "Test"
  // (a different menuId), we hide it — even if that means the menu is empty.
  // The earlier "fall back to all" behaviour was wrong: it leaked test
  // categories into the live menu when activeMenuId didn't match anything.
  //
  // Categories with no menuId at all still pass — they're treated as "global"
  // (legacy data shape).
  const topLevelCategories = useMemo(() => {
    const allTop = menuCategories.filter(c => !c.parentId && c.visible !== false);
    if (!effectiveMenuId) return allTop;
    return allTop.filter(c => !c.menuId || c.menuId === effectiveMenuId || linkedCatIds.has(c.id));
  }, [menuCategories, effectiveMenuId, linkedCatIds]);

  // Items by predicate. Hide child variants here (parentId set) so they don't
  // appear as their own rows — they show up inside the parent variant picker.
  // v5.5.144: do NOT filter out 86'd items here — the ItemRow renderer below
  // shows them greyed-out with an OUT OF STOCK pill instead of vanishing,
  // matching the main POS behaviour and what every customer surface does.
  const itemsForCategory = (catId) => (menuItems || []).filter(i =>
    !i.hidden && !i.parentId &&
    (i.cat === catId || (Array.isArray(i.cats) && i.cats.includes(catId)))
  );

  // Active-menu category id set — used to filter search results to items in
  // the active menu only. Without this, searching "lager" would surface
  // items from Test / Brunch / etc. menus.
  const activeMenuCategoryIds = useMemo(() => {
    const set = new Set(topLevelCategories.map(c => c.id));
    // Include sub-categories whose parent is in the active menu
    menuCategories.forEach(c => {
      if (c.parentId && set.has(c.parentId)) set.add(c.id);
    });
    return set;
  }, [topLevelCategories, menuCategories]);
  const itemBelongsToActiveMenu = (i) => {
    if (activeMenuCategoryIds.size === 0) return true; // no filter set
    if (i.cat && activeMenuCategoryIds.has(i.cat)) return true;
    if (Array.isArray(i.cats) && i.cats.some(id => activeMenuCategoryIds.has(id))) return true;
    return false;
  };

  // Search results — flatten everything matching the query (also hides children).
  // Now also restricted to the active menu so test-menu items don't leak in.
  const searchResults = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return (menuItems || [])
      // v5.5.144: 86'd items stay in the search results so customers/staff
      // can still see them (greyed out + OUT OF STOCK pill), matching the
      // category-list behaviour and the main POS.
      .filter(i => !i.hidden && !i.parentId)
      .filter(itemBelongsToActiveMenu)
      .filter(i =>
        (i.name || '').toLowerCase().includes(q) ||
        (i.description || '').toLowerCase().includes(q) ||
        (i.kitchenName || '').toLowerCase().includes(q)
      )
      .slice(0, 80);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuItems, eightySixIds, query, activeMenuCategoryIds]);

  // Build a parent-id → children index once. Used for:
  //  • Detecting which top-level items are actually variant parents (any item
  //    with at least one child via parentId) — independent of the `type`
  //    field which can vary by data source.
  //  • Computing the "from" price (cheapest child) so menu cards don't show
  //    £0 for parents whose price lives on the children.
  const childrenIndex = useMemo(() => {
    const idx = {};
    (menuItems || []).forEach(i => {
      if (i.parentId) {
        if (!idx[i.parentId]) idx[i.parentId] = [];
        idx[i.parentId].push(i);
      }
    });
    return idx;
  }, [menuItems]);
  const variantInfo = (item) => {
    const kids = childrenIndex[item.id] || [];
    if (!kids.length) return null;
    const prices = kids.map(k => Number(k?.pricing?.base ?? k?.price ?? 0)).filter(p => p > 0);
    return { kids, fromPrice: prices.length ? Math.min(...prices) : 0 };
  };

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
            variantInfo={variantInfo}
            eightySixIds={eightySixIds}
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
function ItemsList({ items, empty, onPick, allergenHits, variantInfo, eightySixIds = [] }) {
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
      {items.map(item => {
        // v5.5.141: 86 awareness — operator 86 OR auto-86 from daily count
        // exhaustion. Greys the row out, shows OUT OF STOCK pill, blocks tap.
        const is86 = eightySixIds.includes(item.id)
          || (item.parentId && eightySixIds.includes(item.parentId))
          || (item.parent_id && eightySixIds.includes(item.parent_id));
        return (
          <ItemRow
            key={item.id} item={item}
            onTap={() => is86 ? null : onPick?.(item)}
            allergenHits={allergenHits ? allergenHits(item) : []}
            variantInfo={variantInfo ? variantInfo(item) : null}
            is86={is86}
          />
        );
      })}
    </div>
  );
}

function ItemRow({ item, onTap, allergenHits = [], variantInfo = null, is86 = false }) {
  // If this item is a variant parent (children link to it via parentId), the
  // displayed price is "from £X" using the cheapest child — parents typically
  // have base price 0 since the price lives on the children.
  const isParent = !!variantInfo?.kids?.length;
  const ownPrice = item?.pricing?.base ?? item?.price ?? 0;
  const displayPrice = isParent ? (variantInfo.fromPrice || 0) : ownPrice;
  const hasMods =
    !isParent && (
      item?.assignedModifierGroups?.length > 0 ||
      item?.modifierGroups?.length > 0 ||
      item?.type === 'modifiable'
    );
  const flagged = allergenHits.length > 0;
  return (
    <button onClick={is86 ? undefined : onTap} disabled={is86} style={{
      width:'100%', padding:'12px 14px',
      background: flagged ? 'var(--red-d)' : 'var(--bg2)',
      borderRadius:12,
      border:`1px solid ${flagged ? 'var(--red-b)' : 'var(--bdr)'}`,
      marginBottom:8, display:'flex', gap:10, alignItems:'center',
      cursor: is86 ? 'not-allowed' : 'pointer',
      minHeight:64, fontFamily:'inherit', textAlign:'left',
      opacity: is86 ? .5 : (flagged ? .85 : 1),
      filter: is86 ? 'grayscale(0.6)' : undefined,
      position:'relative',
    }}>
      {is86 && (
        <div style={{
          position:'absolute', top:8, right:10, zIndex:2,
          padding:'2px 8px', borderRadius:8,
          background:'#1a1a1a', color:'#fff',
          fontSize:9, fontWeight:800, letterSpacing:'0.06em', textTransform:'uppercase',
        }}>OUT OF STOCK</div>
      )}
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
          {isParent && variantInfo.fromPrice > 0 ? (
            <>
              <span style={{ fontSize:9, fontWeight:700, color:'var(--t4)', marginRight:3 }}>FROM</span>
              {money(displayPrice)}
            </>
          ) : money(displayPrice)}
        </div>
        {isParent && (
          <span style={{ ...Sx.pill, background:'var(--acc-d)', color:'var(--acc)', border:'1px solid var(--acc-b)' }}>
            {variantInfo.kids.length} SIZES
          </span>
        )}
        {hasMods && <span style={{ ...Sx.pill, background:'var(--bg3)', color:'var(--t4)', border:'1px solid var(--bdr)' }}>OPTIONS</span>}
      </div>
    </button>
  );
}
