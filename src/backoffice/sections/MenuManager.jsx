/**
 * Menu Manager — designed to mirror the POS experience
 *
 * MENTAL MODEL (matches Toast / Square / Lightspeed):
 *
 *  Menu tab
 *  ├── Left: Category tree  (same order as POS nav)
 *  ├── Centre: Item GRID    (same cards as POS, drag to reorder)
 *  └── Right: Item editor   (slide-in, all config in one place)
 *       ├── Details
 *       ├── Variants   ← add size/type variations inline (no drag-to-link)
 *       ├── Modifiers  ← tick modifier groups; set required/max
 *       ├── Pricing    ← per-channel overrides
 *       └── Allergens
 *
 *  Modifier groups tab
 *  ├── Group list
 *  └── Group editor: add options as name+price pairs directly (no sub-item concept)
 *
 *  Instruction groups tab
 *  └── Same — options are plain strings
 */
import { useState, useMemo, useCallback, useEffect } from 'react';
import { useStore, findDuplicateProductName } from '../../store';
// PIZZA_* are used by PizzaBuilder below in unconditional JSX — without them the
// pizza tab throws ReferenceError during render and main.jsx's ErrorBoundary
// swaps the WHOLE app (POS shell included) for the red error page.
import { ALLERGENS, PIZZA_SIZES, PIZZA_BASES, PIZZA_CRUSTS, PIZZA_TOPPINGS } from '../../data/seed';
import { supabase, isMock, getLocationId, getActiveLocationSync } from '../../lib/supabase';
import { upsertMenuItem, uploadProductImage, deleteProductImage, saveQuickScreenIds, setMenuItemScope, linkCategoryToMenu, unlinkCategoryFromMenu, fetchMenuCategoryLinks } from '../../lib/db';
import { reportSave } from '../../lib/saveHealth';
import { rankQuickPicks, DAYPARTS } from '../../lib/quickRank';
import { getLocationConfig } from '../../lib/locationTime';
// v4.7.8: per-menu pricing tier UI (item-level)
import PerMenuPricingTiers from './PerMenuPricingTiers';
import MenuImportModal from '../components/MenuImportModal';
import { money } from '../../lib/currency';
import { orderOptionFlow } from '../../lib/optionFlow';
// v5.5.813: recipe-derived cost + GP% on the Items list. Same engine + same
// ex-VAT net-price basis as Inventory → Reports → Recipe GP, so the two screens
// can never disagree about a dish's margin.
import { fetchRecipes, buildCostingCtx, costRecipeWith } from '../../lib/stock/recipes';
import { resolveTaxRate, netOf } from '../../lib/tax';

// Dietary tags — stored on menu_items.tags (jsonb). The tag id is what the print
// menu + digital menu board map to a GF/V/VG/DF badge (see printMenu.js DIET map),
// so these ids MUST stay in that map's key set.
const DIET_TAGS = [
  { id:'vegetarian',  label:'Vegetarian', badge:'V',  icon:'🥗' },
  { id:'vegan',       label:'Vegan',      badge:'VG', icon:'🌱' },
  { id:'gluten-free', label:'Gluten-free',badge:'GF', icon:'🌾' },
  { id:'dairy-free',  label:'Dairy-free', badge:'DF', icon:'🥛' },
];

// ── Clone item helper ─────────────────────────────────────────────────────────
async function cloneItem(item, menuItems, addMenuItem, updateMenuItem, markBOChange, showToast, setSelItemId) {
  const baseName = item.menuName || item.name || 'Item';
  const cloneName = window.prompt('Name for the cloned item:', `${baseName} (Copy)`);
  if (!cloneName?.trim()) return; // cancelled

  const name = cloneName.trim();

  // DUPLICATE-NAME GUARD (v5.5.797) — refuse a clone name that matches a live
  // top-level product (trimmed, case-insensitive). Native alert: store toasts
  // don't render in ?mode=office, and this flow already uses window.prompt.
  const dup = findDuplicateProductName(menuItems, name);
  if (dup) {
    window.alert(`A product called "${dup.menuName || dup.name}" already exists — choose a different name.`);
    return;
  }

  // Clone the parent item — strip id, parentId, keep everything else
  const newItem = addMenuItem({
    name, menuName: name, receiptName: name, kitchenName: name,
    description:              item.description || '',
    type:                     item.type === 'variants' ? 'simple' : (item.type || 'simple'),
    cat:                      item.cat,
    cats:                     item.cats || [],
    price:                    item.price,
    pricing:                  item.pricing ? { ...item.pricing } : { base: item.price || 0 },
    allergens:                [...(item.allergens || [])],
    tags:                     [...(item.tags || [])],
    assignedModifierGroups:   [...(item.assignedModifierGroups || [])],
    assignedInstructionGroups:[...(item.assignedInstructionGroups || [])],
    optionGroupOrder:         Array.isArray(item.optionGroupOrder) ? [...item.optionGroupOrder] : null,   // v5.5.948 combined flow order
    modifierGroups:           item.modifierGroups ? [...item.modifierGroups] : undefined,
    visibility:               { ...(item.visibility || { pos:true, kiosk:true, online:true }) },
    soldAlone:                item.soldAlone ?? true,
    centreId:                 item.centreId || null,
    sortOrder:                (item.sortOrder ?? 0) + 1,
  });
  // Store-level backstop (stale list race) — same rule, same message
  if (!newItem) {
    window.alert(`A product called "${name}" already exists — choose a different name.`);
    return;
  }

  // Clone child variants if the original has sizes
  if (item.type === 'variants') {
    const children = menuItems.filter(c => c.parentId === item.id && !c.archived)
      .sort((a,b) => (a.sortOrder??999) - (b.sortOrder??999));

    // Update the cloned parent to be variants type
    await new Promise(r => setTimeout(r, 100)); // let addMenuItem settle
    const newParentId = useStore.getState().menuItems.slice(-1)[0]?.id;
    if (newParentId) {
      updateMenuItem(newParentId, { type: 'variants' });
      children.forEach((child, i) => {
        addMenuItem({
          name: child.menuName || child.name,
          menuName: child.menuName || child.name,
          receiptName: child.receiptName || child.name,
          kitchenName: child.kitchenName || child.name,
          type: 'simple',
          parentId: newParentId,
          cat: item.cat,
          price: child.price,
          pricing: child.pricing ? { ...child.pricing } : { base: child.price || 0 },
          allergens: [...(child.allergens || [])],
          tags: [...(child.tags || [])],
          assignedModifierGroups: [...(child.assignedModifierGroups || [])],
          sortOrder: i,
        });
      });
    }
  }

  markBOChange();
  showToast(`"${name}" cloned`, 'success');

  // Select the new item
  setTimeout(() => {
    const all = useStore.getState().menuItems;
    const newest = all.filter(i => i.name === name).slice(-1)[0];
    if (newest) setSelItemId(newest.id);
  }, 150);
}


// ── Archive a variant / size row ──────────────────────────────────────────────
// Detaches a size from its parent and archives it. Two callers: the list view's
// inline × and the item editor's Variants tab — both used to fire this as
// `.then(({error}) => console.error(...))` under an unconditional green toast, so
// a rejected write left the size selling on every other till while the operator
// was told it was gone.
//   • reportSave so a failing session raises the Back Office save-health banner
//   • .eq('location_id') — the v5.5.834 modifier-group precedent (store/index.js
//     ~862): filtering on `id` alone is a cross-tenant hazard the moment two
//     venues share a row id
// Returns { error }; the caller reverts its optimistic state and warns on error.
async function archiveVariantRow(id) {
  if (isMock) return { error: null };
  const locId = getActiveLocationSync() || await getLocationId().catch(() => null);
  if (!locId || locId === 'loc-demo') {
    const error = new Error('No location');
    reportSave('variant archive', error);
    return { error };
  }
  const { data, error } = await supabase.from('menu_items')
    .update({ archived: true, parent_id: null, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('location_id', locId)
    .select('id');
  // An update that matched NO rows comes back as a plain success with an empty body —
  // a row RLS hides, or one carrying a different location_id than this session resolved,
  // reads exactly like a save. Ask for the id back and treat nothing as the failure it is.
  const err = error || (!data || data.length === 0
    ? new Error('Variant archive matched 0 rows — RLS blocked it or the row is scoped to another location')
    : null);
  reportSave('variant archive', err);
  return { error: err };
}

const ORDER_TYPES_TAX = ['dine-in', 'takeaway', 'delivery', 'bar', 'counter'];

function TaxSection({ item, onUpdate, markBOChange }) {
  const { taxRates, taxProfiles } = useStore();

  const setTaxRate = (id) => {
    onUpdate({ taxRateId: id || null, tax_rate_id: id || null });
    markBOChange();
  };
  // v5.7.33: tax PROFILE override (dark — tills still charge via the legacy
  // rates below until the calculation cutover). Same dual-spelling patch
  // pattern as setTaxRate so both save paths carry it.
  const setTaxProfile = (id) => {
    onUpdate({ taxProfileId: id || null, tax_profile_id: id || null });
    markBOChange();
  };
  const setOverride = (orderType, rateId) => {
    const overrides = { ...(item.taxOverrides || {}), [orderType]: rateId || null };
    // Clean null overrides
    Object.keys(overrides).forEach(k => { if (!overrides[k]) delete overrides[k]; });
    onUpdate({ taxOverrides: overrides, tax_overrides: overrides });
    markBOChange();
  };

  if (!taxRates?.length) return (
    <div style={{ padding:'20px 0', color:'var(--t4)', fontSize:12, textAlign:'center' }}>
      No tax rates configured.<br/>
      Go to <strong style={{ color:'var(--t2)' }}>Tax & VAT</strong> to set up rates first.
    </div>
  );

  const noneOption = <option value="">No tax</option>;
  const rateOptions = taxRates.map(r => {
    const pct = (parseFloat(r.rate) * 100).toFixed(1).replace('.0','');
    return <option key={r.id} value={r.id}>{r.name} ({pct}% {r.type === 'inclusive' ? 'incl.' : 'excl.'})</option>;
  });

  const activeProfiles = (taxProfiles || []).filter(p => p.active !== false);

  return (
    <div>
      {/* v5.7.33: tax PROFILE override — setup only, nothing charges with it yet */}
      {activeProfiles.length > 0 && (
        <div style={{ marginBottom:16 }}>
          <span style={{ fontSize:10, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', display:'block', marginBottom:5 }}>Tax profile (override)</span>
          <select value={item.taxProfileId || ''} onChange={e => setTaxProfile(e.target.value)}
            style={{ width:'100%', padding:'8px 11px', borderRadius:9, border:'1.5px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none' }}>
            <option value="">Inherit (category, then venue default)</option>
            {activeProfiles.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div style={{ fontSize:11, color:'var(--t4)', marginTop:5, lineHeight:1.6 }}>
            Profiles are the new way to set up tax (Tax &amp; VAT → Tax profiles). Until the calculation switchover, the legacy rate below is what actually charges.
          </div>
        </div>
      )}

      <div style={{ marginBottom:16 }}>
        <span style={{ fontSize:10, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', display:'block', marginBottom:5 }}>Default tax rate</span>
        <select value={item.taxRateId || ''} onChange={e => setTaxRate(e.target.value)}
          style={{ width:'100%', padding:'8px 11px', borderRadius:9, border:'1.5px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none' }}>
          {noneOption}{rateOptions}
        </select>
        <div style={{ fontSize:11, color:'var(--t4)', marginTop:5, lineHeight:1.6 }}>
          Applied to all order types unless overridden below.
        </div>
      </div>

      <div style={{ marginBottom:8 }}>
        <span style={{ fontSize:10, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', display:'block', marginBottom:8 }}>
          Per-order-type overrides
        </span>
        <div style={{ fontSize:11, color:'var(--t4)', marginBottom:10, lineHeight:1.6 }}>
          Override the tax rate for specific order types. Common UK use: set takeaway to Zero Rate for food items.
        </div>
        {ORDER_TYPES_TAX.map(ot => (
          <div key={ot} style={{ display:'grid', gridTemplateColumns:'100px 1fr', gap:8, alignItems:'center', marginBottom:6 }}>
            <span style={{ fontSize:12, color:'var(--t2)', fontWeight:600, textTransform:'capitalize' }}>{ot}</span>
            <select value={item.taxOverrides?.[ot] || ''}
              onChange={e => setOverride(ot, e.target.value)}
              style={{ padding:'6px 10px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg)', color:'var(--t1)', fontSize:12, fontFamily:'inherit', outline:'none' }}>
              <option value="">Use default</option>
              {rateOptions}
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Shared ───────────────────────────────────────────────────────────────────
const inp = { background:'var(--bg3)', border:'1.5px solid var(--bdr2)', borderRadius:9, padding:'8px 11px', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', width:'100%', boxSizing:'border-box' };
const lbl = { fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.1em', marginBottom:5, display:'block' };
const COLOURS = ['#3b82f6','#e8a020','#22c55e','#a855f7','#ef4444','#22d3ee','#f97316','#ec4899','#10b981','#8b5cf6','#eab308','#78716c'];
const ICONS   = ['🍽','🥗','🍖','🍕','🍸','☕','🎂','🥤','🌿','🔥','❄️','⭐','🌮','🦞','🍜','🥩','🍤','🥚','🥐'];

// ── Root ─────────────────────────────────────────────────────────────────────
// A number box whose value is NOT recomputed from the model on every keystroke.
//
// The min/max pick boxes used to derive `value` from the saved number and blank
// themselves whenever that number matched one of the quick buttons. Typing "12"
// therefore went: "1" -> saves min 1 -> 1 is a quick button -> box blanks -> the
// "1" is gone. Any number starting 1 to 5 was impossible to enter, so a "Box of
// 12" could never be given a minimum of 12. Holding the typed text locally
// while focused fixes it; the model still owns the value everywhere else.
function PickNumBox({ value, min, max, onCommit, style, placeholder = 'N' }) {
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const shown = typing ? text : (value == null ? '' : String(value));
  return (
    <input
      type="number" min={min} max={max} style={style} placeholder={placeholder}
      value={shown}
      onFocus={() => { setTyping(true); setText(value == null ? '' : String(value)); }}
      onBlur={() => {
        setTyping(false);
        const n = parseInt(text, 10);
        // An empty or nonsense entry falls back to the smallest legal value
        // rather than silently keeping a number the operator just cleared.
        onCommit(Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min);
      }}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseInt(e.target.value, 10);
        // Commit as they type ONLY once the value is already in range, so the
        // rest of the editor stays live without fighting the keystrokes.
        if (Number.isFinite(n) && n >= min && n <= max) onCommit(n);
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
    />
  );
}

export default function MenuManager() {
  const [tab, setTab] = useState('menu');
  const [importOpen, setImportOpen] = useState(false);
  const { menus } = useStore();
  const defaultMenuId = menus?.[0]?.id;
  return (
    <div className="bo-workspace" style={{ display:'flex', flexDirection:'column', height:'100%', overflow:'hidden' }}>
      <nav style={{ display:'flex', borderBottom:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0, alignItems:'center' }}>
        {[['menu','🍽 Menus'],['quick','⚡ Quick Screen'],['items','📋 Items'],['modifiers','⊕ Modifier groups'],['instructions','📝 Instruction groups']].map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)} style={{ padding:'0 20px', height:46, cursor:'pointer', fontFamily:'inherit', border:'none', borderBottom:`3px solid ${tab===id?'var(--acc)':'transparent'}`, background:'transparent', color:tab===id?'var(--acc)':'var(--t3)', fontSize:13, fontWeight:tab===id?800:500 }}>
            {label}
          </button>
        ))}
        <div style={{ flex:1 }} />
        <button
          onClick={()=>setImportOpen(true)}
          title="Drop a menu file, AI builds it"
          style={{ margin:'0 12px', padding:'0 14px', height:32, cursor:'pointer', fontFamily:'inherit', fontSize:12, fontWeight:700, border:'1px solid var(--acc-b)', borderRadius:8, background:'var(--acc-d)', color:'var(--acc)' }}>
          ↗ Import menu
        </button>
      </nav>
      <div style={{ flex:1, overflow:'hidden' }}>
        {tab==='menu'         && <MenuTab />}
        {tab==='quick'        && <QuickScreenManager />}
        {tab==='items'        && <ItemsLibrary />}
        {tab==='modifiers'    && <ModifiersTab />}
        {tab==='instructions' && <InstructionsTab />}
      </div>
      {importOpen && (
        <MenuImportModal
          menuId={defaultMenuId}
          onClose={()=>setImportOpen(false)}
        />
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MENU TAB
// ═══════════════════════════════════════════════════════════════════════════
function MenuTab() {
  const { menuCategories, menuItems, menus, addMenu, updateMenu, removeMenu, addCategory, updateCategory, removeCategory,
          addMenuItem, updateMenuItem, archiveMenuItem, eightySixIds, toggle86,
          markBOChange, showToast, modifierGroupDefs } = useStore();

  const [selMenuId, setSelMenuId] = useState(menus?.[0]?.id||'menu-1');
  // v5.5.955 — THE PHANTOM 'menu-1'. If Menu manager mounts before menus finish
  // loading, selMenuId froze on the hardcoded fallback (an id that exists nowhere)
  // and NEVER healed — every category created after that carried menuId 'menu-1'
  // and died on menu_categories_menu_id_fkey (silently pre-v951; the banner caught
  // it twice tonight). Snap to the first real menu the moment the list arrives, and
  // whenever the selected menu stops existing (e.g. deleted on another device).
  useEffect(() => {
    if (menus?.length && !menus.some(m => m.id === selMenuId)) setSelMenuId(menus[0].id);
  }, [menus, selMenuId]);
  const [addingMenu, setAddingMenu]   = useState(false);
  const [editingMenuId, setEditingMenuId] = useState(null); // v4.6.4: which menu's settings panel is open
  const [newMenuName, setNewMenuName] = useState('');
  const [selCatId, setSelCatId]   = useState(null);
  const [selItemId, setSelItemId] = useState(null);
  const [editingCat, setEditingCat] = useState(null);
  const [movingCatId, setMovingCatId] = useState(null);
  const [addingCat, setAddingCat]   = useState(false);
  // v5.5.815: category find-as-you-type + collapse/expand of parent groups.
  // Collapsed state is per venue on this device (a view preference, not data).
  const [catFilter, setCatFilter]   = useState('');
  const [collapsed, setCollapsed]   = useState(() => {
    try { const v = JSON.parse(localStorage.getItem(`rpos-cat-collapsed:${getActiveLocationSync() || 'default'}`) || '[]'); return new Set(Array.isArray(v) ? v : []); }
    catch { return new Set(); }
  });
  const toggleCollapsed = (id) => setCollapsed(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    try { localStorage.setItem(`rpos-cat-collapsed:${getActiveLocationSync() || 'default'}`, JSON.stringify([...next])); } catch {}
    return next;
  });
  // v4.7.5: cats↔menus join data, loaded on mount, mutated locally on link/unlink
  const [categoryLinks, setCategoryLinks] = useState([]);
  const [showLinkPicker, setShowLinkPicker] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await fetchMenuCategoryLinks();
      if (!alive) return;
      setCategoryLinks(data || []);
    })();
    return () => { alive = false; };
  }, []);
  const handleLinkCat = async (catId) => {
    if (!selMenuId || !catId) return;
    if ((categoryLinks||[]).some(l => l.menu_id === selMenuId && l.category_id === catId)) {
      setShowLinkPicker(false); return;
    }
    const result = await linkCategoryToMenu(selMenuId, catId, menuCategories.length);
    reportSave('menu category link', result.ok ? null : (result.error || new Error('Link failed')));
    if (result.ok) {
      setCategoryLinks(prev => [...prev, { menu_id: selMenuId, category_id: catId, sort_order: menuCategories.length }]);
      const cat = menuCategories.find(c => c.id === catId);
      showToast(`"${cat?.label || 'Category'}" linked to this menu`, 'success');
      markBOChange();
    } else {
      showToast(`Couldn't link: ${result.error?.message || 'unknown error'}`, 'error');
    }
    setShowLinkPicker(false);
  };
  const handleUnlinkCat = async (catId) => {
    const cat = menuCategories.find(c => c.id === catId);
    if (!confirm(`Unlink "${cat?.label || 'category'}" from this menu? Items in this category will stop showing on this menu.`)) return;
    const result = await unlinkCategoryFromMenu(selMenuId, catId);
    reportSave('menu category link', result.ok ? null : (result.error || new Error('Unlink failed')));
    if (result.ok) {
      setCategoryLinks(prev => prev.filter(l => !(l.menu_id === selMenuId && l.category_id === catId)));
      showToast(`"${cat?.label || 'Category'}" unlinked`, 'info');
      markBOChange();
    } else {
      showToast(`Couldn't unlink: ${result.error?.message || 'unknown error'}`, 'error');
    }
  };
  const [catForm, setCatForm]       = useState({ label:'', icon:'🍽', color:'#3b82f6', parentId:'' });
  const [dragCatId, setDragCatId]   = useState(null);
  const [overCatId, setOverCatId]   = useState(null);
  const [dragItemId, setDragItemId] = useState(null);
  const [overItemId, setOverItemId] = useState(null);
  const [expandedParentId, setExpandedParentId] = useState(null); // variant expand
  const [search, setSearch]         = useState('');
  const [viewMode, setViewMode]     = useState('grid'); // 'grid' | 'list'
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [addSearch, setAddSearch]     = useState('');

  // v4.7.5: roots include cats whose menu_id matches selMenuId OR which appear in
  // categoryLinks for selMenuId. This is what makes "linked categories" work.
  const linkedCatIdsForMenu = useMemo(() => {
    return new Set((categoryLinks||[]).filter(l => l.menu_id === selMenuId).map(l => l.category_id));
  }, [categoryLinks, selMenuId]);
  // v5.5.950: label tiebreak — sortOrder ties must never shuffle between renders/loads.
  const roots     = useMemo(()=>menuCategories.filter(c=>!c.parentId&&!c.isSpecial&&(!c.menuId||c.menuId===selMenuId||linkedCatIdsForMenu.has(c.id))).sort((a,b)=>((a.sortOrder||0)-(b.sortOrder||0)) || String(a.label||'').localeCompare(String(b.label||''))),[menuCategories,selMenuId,linkedCatIdsForMenu]);
  const selCat    = menuCategories.find(c=>c.id===selCatId);
  const selItem   = menuItems.find(i=>i.id===selItemId);

  // Items to show in grid — only orderable items (not sub-items, not archived)
  const gridItems = useMemo(()=>{
    if (!selCatId) return [];
    const subs  = menuCategories.filter(c=>c.parentId===selCatId).map(c=>c.id);
    const inCat = i => i.cat===selCatId || subs.includes(i.cat) || (i.cats||[]).includes(selCatId) || (i.cats||[]).some(c=>subs.includes(c));
    return menuItems
      .filter(i=>!i.archived && (i.type!=='subitem' || i.soldAlone) && !i.parentId && inCat(i))
      .sort((a,b)=>(a.sortOrder??999)-(b.sortOrder??999));
  },[selCatId, menuCategories, menuItems]);

  // Spacers stored as [{id, sortOrder}] on selCat.spacerSlots
  // Merged with gridItems by sortOrder — fully draggable via sortOrder updates
  const gridWithSpacers = useMemo(() => {
    if (!selCat) return gridItems;
    const spacers = (selCat.spacerSlots || []).map(s =>
      typeof s === 'object' ? s : { id: `spacer-${s}`, sortOrder: s }
    );
    if (!spacers.length) return gridItems;
    const all = [
      ...gridItems.map(i => ({ ...i, _spacer: false })),
      ...spacers.map(s => ({ ...s, _spacer: true })),
    ].sort((a, b) => (a.sortOrder ?? 999) - (b.sortOrder ?? 999));
    return all;
  }, [gridItems, selCat]);

  const addSpacer = () => {
    if (!selCat) return;
    const maxSort = Math.max(...gridWithSpacers.map(i => i.sortOrder ?? 0), 0);
    const existing = selCat.spacerSlots || [];
    const newSpacer = { id: `spacer-${Date.now()}`, sortOrder: maxSort + 1 };
    updateCategory(selCat.id, { spacerSlots: [...existing, newSpacer] });
    markBOChange();
  };

  const removeSpacer = (spacerId) => {
    if (!selCat) return;
    const existing = selCat.spacerSlots || [];
    updateCategory(selCat.id, { spacerSlots: existing.filter(s => (s.id || s) !== spacerId) });
    markBOChange();
  };

  // Unified reorder — handles dragging items AND spacers in the same grid
  const reorderGrid = useCallback((dragId, targetId) => {
    if (!dragId || dragId === targetId) return;
    const all = gridWithSpacers;
    const dragIdx = all.findIndex(i => i.id === dragId);
    const targetIdx = all.findIndex(i => i.id === targetId);
    if (dragIdx === -1 || targetIdx === -1) return;
    // Build new order
    const without = all.filter(i => i.id !== dragId);
    const newTargetIdx = without.findIndex(i => i.id === targetId);
    const insertAt = dragIdx < targetIdx ? newTargetIdx + 1 : newTargetIdx;
    const reordered = [...without.slice(0, insertAt), all[dragIdx], ...without.slice(insertAt)];
    // Assign new sortOrders sequentially
    reordered.forEach((item, idx) => {
      if (!item) return;
      if (item._spacer) return; // spacers updated below
      if ((item.sortOrder ?? 999) !== idx) updateMenuItem(item.id, { sortOrder: idx });
    });
    // Update spacers with new sort orders
    const newSpacers = reordered
      .map((item, idx) => item._spacer ? { id: item.id, sortOrder: idx } : null)
      .filter(Boolean);
    if (selCat) {
      updateCategory(selCat.id, { spacerSlots: newSpacers });
    }
    markBOChange();
    showToast('Order updated','success');
  }, [gridWithSpacers, updateMenuItem, updateCategory, selCat, markBOChange, showToast]);

  const searchResults = useMemo(()=>{
    if (!search.trim()) return [];
    const q = search.toLowerCase();
    return menuItems.filter(i=>!i.archived&&i.type!=='subitem'&&((i.menuName||i.name||'').toLowerCase().includes(q)||(i.description||'').toLowerCase().includes(q))).sort((a,b)=>(a.sortOrder??999)-(b.sortOrder??999));
  },[search, menuItems]);

  const displayItems = search.trim() ? searchResults : gridItems;

  // ── Category drag: same level = reorder, cross level = nest ──────────────
  const onCatDrop = useCallback((e, targetId) => {
    e.preventDefault();
    e.stopPropagation();   // v5.5.956: a row drop must not ALSO fire the container's catch-all
    if (!dragCatId || dragCatId===targetId) { setDragCatId(null); setOverCatId(null); return; }
    const dragged = menuCategories.find(c=>c.id===dragCatId);
    const target  = menuCategories.find(c=>c.id===targetId);
    if (!dragged) { setDragCatId(null); setOverCatId(null); return; }
    // ONLY reorder within the same parent level — no cross-level nesting via drag
    // (Use the ↕ Move button per category to change parent/nesting)
    // v5.5.956: 'end' = the container catch-all — send to the END of the dragged
    // item's OWN level (dropping below the list / in a gap used to just snap back).
    const isEnd = targetId==='end';
    if (isEnd || dragged.parentId===target?.parentId) {
      const level = dragged.parentId ?? null;
      const siblings = menuCategories.filter(c=>(c.parentId??null)===level)
        .sort((a,b)=>((a.sortOrder||0)-(b.sortOrder||0)) || String(a.label||'').localeCompare(String(b.label||'')));
      const without  = siblings.filter(c=>c.id!==dragCatId);
      // v5.5.950: DIRECTION-AWARE drop. Insert-before-target meant dragging DOWN landed
      // one slot above where you dropped — and moving onto the next-door neighbour did
      // nothing at all ("keeps not letting them go where I want"). Dragging downward now
      // lands AFTER the row you drop on; upward stays before it.
      const fromIdx = siblings.findIndex(c=>c.id===dragCatId);
      const toIdx   = siblings.findIndex(c=>c.id===targetId);
      let ti        = isEnd ? without.length : without.findIndex(c=>c.id===targetId);
      if (!isEnd && fromIdx < toIdx) ti += 1;
      const reordered = [...without.slice(0,ti), dragged, ...without.slice(ti)];
      // Renumber the WHOLE level 0..n — also heals legacy duplicate sortOrders on this
      // level, which were what let the order shuffle between page loads.
      reordered.forEach((c,i)=>{ if((c.sortOrder??-1)!==i) updateCategory(c.id,{sortOrder:i}); });
      markBOChange(); showToast(isEnd ? `${dragged.label} → end of its level` : 'Reordered','success');
    } else {
      // v5.5.956: never refuse SILENTLY — the invisible no-op read as "snapped back".
      showToast('Drag reorders within the same level — use the ↕ Move button to change parent', 'info');
    }
    setDragCatId(null); setOverCatId(null);
  },[dragCatId, menuCategories, updateCategory, markBOChange, showToast]);

  // ── Item drag: reorder in grid ────────────────────────────────────────────
  const onItemDrop = useCallback((e, targetId)=>{
    e.preventDefault();
    if (!dragItemId||dragItemId===targetId) { setDragItemId(null); setOverItemId(null); return; }
    const items   = displayItems.filter(i=>!i._isChild);
    const without = items.filter(i=>i.id!==dragItemId);
    const ti      = without.findIndex(i=>i.id===targetId);
    const reordered=[...without.slice(0,ti), items.find(i=>i.id===dragItemId), ...without.slice(ti)];
    reordered.forEach((item,idx)=>{ if(item&&(item.sortOrder??999)!==idx) updateMenuItem(item.id,{sortOrder:idx}); });
    markBOChange(); showToast('Order updated — reflects on POS instantly','success');
    setDragItemId(null); setOverItemId(null);
  },[dragItemId, displayItems, updateMenuItem, markBOChange, showToast]);

  const addItem = (type='simple')=>{
    // v5.5.949: auto-pick a free name. "+ Item" always minted a literal "New item",
    // so ONE un-renamed (or later-renamed-back) "New item" anywhere in the menu made
    // the button dead-end with an alert and no way to type a name — naming happens
    // AFTER creation in this flow. Now it mints "New item 2", "New item 3", …
    const freshName = (() => { let n='New item', i=2; while (findDuplicateProductName(menuItems, n)) n=`New item ${i++}`; return n; })();
    const created = addMenuItem({ name:freshName, menuName:freshName, receiptName:freshName, kitchenName:freshName,
      type, cat:selCatId||undefined, allergens:[],
      pricing:{base:0,dineIn:null,takeaway:null,collection:null,delivery:null},
      assignedModifierGroups:[], assignedInstructionGroups:[], cats:[], });
    if (!created) { window.alert(`A product called "${freshName}" already exists — rename it before adding another.`); return; }
    markBOChange();
    setTimeout(()=>{ const id=useStore.getState().menuItems.slice(-1)[0]?.id; if(id) setSelItemId(id); },30);
  };

  const saveNewCat = ()=>{
    if (!catForm.label.trim()) return;
    // v5.5.950: number within the SIBLING level (max+1), not the global category count —
    // the global counter minted sortOrders that collided across levels and left ties.
    const _sibs = menuCategories.filter(c => (c.parentId||null) === (catForm.parentId||null));
    // v5.5.955: NEVER stamp a menu id that isn't a real menu (the phantom 'menu-1'
    // race). v5.5.958: and if the venue has NO menu at all, create "Main menu"
    // loudly rather than minting menu-less categories — the serialised write chain
    // lands the menu row before the category (FK-safe).
    let _menuId = (menus||[]).some(m=>m.id===selMenuId) ? selMenuId : ((menus||[])[0]?.id || null);
    if (!_menuId) {
      const created = addMenu({ name: 'Main menu', isActive: true, isDefault: true });
      _menuId = created?.id || null;
      if (_menuId) { setSelMenuId(_menuId); showToast('This venue had no menu — created "Main menu" for you', 'success'); }
    }
    addCategory({ menuId:_menuId, ...catForm, parentId:catForm.parentId||null, sortOrder: _sibs.length ? Math.max(..._sibs.map(c=>c.sortOrder||0)) + 1 : 0 });
    markBOChange(); showToast(`"${catForm.label}" added`,'success');
    setCatForm({label:'',icon:'🍽',color:'#3b82f6',parentId:''}); setAddingCat(false);
  };

  const selMenu = (menus||[]).find(m=>m.id===selMenuId);

  return (
    <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>

      {/* ── PANEL 0: Menu selector ─────────────────────────────────────── */}
      <div style={{ width:224, borderRight:'1px solid var(--bdr)', display:'flex', flexDirection:'column', overflow:'hidden', background:'var(--bg2)', flexShrink:0 }}>
        <div style={{ padding:'8px 10px', borderBottom:'1px solid var(--bdr)', display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
          <span style={{ fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', flex:1 }}>Menus</span>
          <button onClick={()=>{setAddingMenu(true);setNewMenuName('');}}
            style={{ width:22,height:22,borderRadius:6,cursor:'pointer',background:'var(--acc)',border:'none',color:'#0b0c10',fontSize:15,fontWeight:700,display:'flex',alignItems:'center',justifyContent:'center' }}>+</button>
        </div>

        {/* Inline new menu form */}
        {addingMenu && (
          <div style={{ padding:'8px', borderBottom:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0 }}>
            <input autoFocus value={newMenuName} onChange={e=>setNewMenuName(e.target.value)}
              onKeyDown={e=>{
                if (e.key==='Enter' && newMenuName.trim()) {
                  const newId=`menu-${Date.now()}`;
                  addMenu({ id:newId, name:newMenuName.trim(), description:'', scope:'local', assignedProfiles:[], isDefault:false, isActive:true });
                  setSelMenuId(newId); setSelCatId(null);
                  markBOChange(); showToast(`"${newMenuName.trim()}" created`,'success');
                  setAddingMenu(false); setNewMenuName('');
                }
                if (e.key==='Escape') { setAddingMenu(false); setNewMenuName(''); }
              }}
              placeholder="Menu name…"
              style={{ ...inp, fontSize:12, marginBottom:6 }}/>
            <div style={{ display:'flex', gap:5 }}>
              <button onClick={()=>{
                  if (!newMenuName.trim()) return;
                  const newId=`menu-${Date.now()}`;
                  addMenu({ id:newId, name:newMenuName.trim(), description:'', scope:'local', assignedProfiles:[], isDefault:false, isActive:true });
                  setSelMenuId(newId); setSelCatId(null);
                  markBOChange(); showToast(`"${newMenuName.trim()}" created`,'success');
                  setAddingMenu(false); setNewMenuName('');
                }}
                disabled={!newMenuName.trim()}
                style={{ flex:1,padding:'5px',borderRadius:7,cursor:'pointer',fontFamily:'inherit',background:'var(--acc)',border:'none',color:'#0b0c10',fontSize:11,fontWeight:700,opacity:newMenuName.trim()?1:.4 }}>
                Create
              </button>
              <button onClick={()=>{setAddingMenu(false);setNewMenuName('');}}
                style={{ padding:'5px 8px',borderRadius:7,cursor:'pointer',fontFamily:'inherit',background:'var(--bg3)',border:'1px solid var(--bdr)',color:'var(--t3)',fontSize:11 }}>
                Cancel
              </button>
            </div>
          </div>
        )}

        <div style={{ flex:1, overflowY:'auto', padding:'6px' }}>
          {(menus||[]).map(m=>{
            const sched = m.schedule || null;
            const days = sched?.days || [1,2,3,4,5,6,7];
            const from = sched?.from || '09:00';
            const to   = sched?.to   || '23:59';
            const isEditing = editingMenuId === m.id;
            const dayLabels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
            return (
              <div key={m.id}>
                {/* mm-catrow gives the menu card the same hover-reveal behaviour
                    as the category rows (handoff marker 1). */}
                <div className="mm-catrow" style={{ position:'relative', display:'flex', alignItems:'center', gap:4, marginBottom:4,
                  borderRadius:9, border:`1.5px solid ${selMenuId===m.id?'var(--acc)':'var(--bdr)'}`,
                  background:selMenuId===m.id?'var(--acc-d)':'var(--bg1)', transition:'all .1s' }}>
                  <button onClick={()=>{ setSelMenuId(m.id); setSelCatId(null); }}
                    style={{ flex:1, minWidth:0, display:'flex', flexDirection:'column', padding:'9px 10px', cursor:'pointer', fontFamily:'inherit', textAlign:'left', border:'none', background:'transparent' }}>
                    <div title={m.name} style={{ fontSize:12.5, fontWeight:700, color:selMenuId===m.id?'var(--acc)':'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', paddingRight:44 }}>
                      {(m.isDefault ?? m.is_default)?'★ ':''}{m.name}
                      {sched && <span style={{ marginLeft:4, fontSize:9, color:'var(--t4)' }}>⏰</span>}
                    </div>
                    <div style={{ fontSize:10, color:'var(--t4)', marginTop:2 }}>
                      {sched ? `${sched.days?.length||7}d · ${sched.from}–${sched.to}` : 'Always active'}
                    </div>
                  </button>
                  <span className="mm-acts" style={{ position:'absolute', right:7, top:7, display:'flex', gap:4 }}>
                    <button onClick={()=>{ setEditingMenuId(isEditing ? null : m.id); }}
                      title="Edit menu settings"
                      style={{ width:20,height:20,borderRadius:5,border:'1px solid var(--bdr)',background:isEditing?'var(--acc-d)':'var(--bg1)',color:isEditing?'var(--acc)':'var(--t3)',cursor:'pointer',fontSize:11,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}>✎</button>
                    {!(m.isDefault ?? m.is_default) && (
                      <button className="mm-del" onClick={()=>{
                          if (!confirm(`Delete "${m.name}"? This won't delete its categories or items.`)) return;
                          if (selMenuId===m.id && menus.length>1) setSelMenuId(menus.find(x=>x.id!==m.id).id);
                          if (editingMenuId===m.id) setEditingMenuId(null);
                          removeMenu(m.id); markBOChange(); showToast(`"${m.name}" deleted`,'info');
                        }}
                        title="Delete menu"
                        style={{ width:20,height:20,borderRadius:5,border:'1px solid var(--bdr)',background:'var(--bg1)',color:'var(--t3)',cursor:'pointer',fontSize:12,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}>
                        ×
                      </button>
                    )}
                  </span>
                </div>
                {isEditing && (
                  <div style={{ padding:8, marginBottom:4, background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:8, fontSize:11 }}>
                    <div style={{ fontSize:10, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:6 }}>Schedule</div>
                    <div style={{ display:'flex', gap:3, flexWrap:'wrap', marginBottom:8 }}>
                      {dayLabels.map((lab, i) => {
                        const dayNum = i + 1;
                        const on = days.includes(dayNum);
                        return (
                          <button key={dayNum} onClick={()=>{
                            const next = on ? days.filter(d=>d!==dayNum) : [...days, dayNum].sort();
                            updateMenu(m.id, { schedule: { days: next, from, to } });
                            markBOChange();
                          }}
                            style={{ padding:'3px 7px', fontSize:10, fontWeight:600, borderRadius:4,
                              background: on ? 'var(--acc-d)' : 'var(--bg3)',
                              color: on ? 'var(--acc)' : 'var(--t3)',
                              border: '1px solid ' + (on ? 'var(--acc)' : 'var(--bdr)'),
                              cursor:'pointer' }}>{lab}</button>
                        );
                      })}
                    </div>
                    <div style={{ display:'flex', gap:5, alignItems:'center', marginBottom:8 }}>
                      <input type="time" value={from} onChange={e=>{ updateMenu(m.id, { schedule: { days, from: e.target.value, to } }); markBOChange(); }}
                        style={{ ...inp, fontSize:11, padding:'4px 6px', flex:1 }}/>
                      <span style={{ color:'var(--t3)' }}>to</span>
                      <input type="time" value={to} onChange={e=>{ updateMenu(m.id, { schedule: { days, from, to: e.target.value } }); markBOChange(); }}
                        style={{ ...inp, fontSize:11, padding:'4px 6px', flex:1 }}/>
                    </div>
                    {sched && (
                      <button onClick={()=>{ updateMenu(m.id, { schedule: null }); markBOChange(); showToast('Schedule cleared — always active','info'); }}
                        style={{ width:'100%', padding:'4px', fontSize:10, fontWeight:600, borderRadius:5, border:'1px dashed var(--bdr)', background:'transparent', color:'var(--t3)', cursor:'pointer', marginBottom:8 }}>
                        Clear schedule (always active)
                      </button>
                    )}
                    <div style={{ display:'flex', gap:6, alignItems:'center', marginBottom:6 }}>
                      <span style={{ fontSize:10, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', flex:1 }}>Priority</span>
                      <input type="number" min={0} max={99} value={m.priority ?? 0}
                        onChange={e=>{ updateMenu(m.id, { priority: parseInt(e.target.value)||0 }); markBOChange(); }}
                        style={{ ...inp, fontSize:11, padding:'3px 6px', width:50, textAlign:'right' }}/>
                    </div>
                    <div style={{ fontSize:10, color:'var(--t4)', lineHeight:1.4 }}>
                      Higher priority wins when multiple scheduled menus overlap.
                    </div>
                    {!(m.isDefault ?? m.is_default) && (
                      <button onClick={()=>{
                          (menus||[]).forEach(other => {
                            if (other.id !== m.id && (other.isDefault ?? other.is_default)) updateMenu(other.id, { isDefault: false, is_default: false });
                          });
                          updateMenu(m.id, { isDefault: true, is_default: true });
                          markBOChange(); showToast(`"${m.name}" is now the default`,'success');
                        }}
                        style={{ width:'100%', padding:'4px 8px', marginTop:6, fontSize:10, fontWeight:600, borderRadius:5, border:'1px solid var(--acc)', background:'var(--acc-d)', color:'var(--acc)', cursor:'pointer' }}>
                        Set as default
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── PANEL 1: Category tree ─────────────────────────────────────── */}
      {/* v5.5.813: widened toward the handoff's 336px so full category names
          render instead of truncating ("Burgers/Sandwiches", "Hot drinks"). */}
      <div style={{ width:300, borderRight:'1px solid var(--bdr)', display:'flex', flexDirection:'column', overflow:'hidden', background:'var(--bg1)', flexShrink:0 }}>
        <div style={{ padding:'8px 10px', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
          <div style={{ display:'flex', gap:6, alignItems:'center' }}>
            <span style={{ fontSize:12, fontWeight:700, color:'var(--t1)', flex:1 }}>Categories</span>
            <button onClick={()=>setAddingCat(v=>!v)} style={{ width:24, height:24, borderRadius:6, cursor:'pointer', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:15, fontWeight:700, display:'flex', alignItems:'center', justifyContent:'center' }}>+</button>
          </div>
          {/* v5.5.815: find-as-you-type filter over the category tree */}
          <div style={{ position:'relative', marginTop:7 }}>
            <span style={{ position:'absolute', left:8, top:'50%', transform:'translateY(-50%)', fontSize:10, color:'var(--t4)', pointerEvents:'none' }}>🔍</span>
            <input value={catFilter} onChange={e=>setCatFilter(e.target.value)}
              onKeyDown={e=>{ if(e.key==='Escape'){ e.stopPropagation(); setCatFilter(''); } }}
              placeholder="Filter categories…" aria-label="Filter categories"
              style={{ ...inp, fontSize:11.5, padding:'5px 24px 5px 24px' }}/>
            {catFilter && (
              <button onClick={()=>setCatFilter('')} aria-label="Clear category filter" title="Clear"
                style={{ position:'absolute', right:5, top:'50%', transform:'translateY(-50%)', width:16, height:16, borderRadius:4, border:'none', background:'var(--bg3)', color:'var(--t3)', cursor:'pointer', fontSize:10, lineHeight:1, display:'flex', alignItems:'center', justifyContent:'center' }}>×</button>
            )}
          </div>
        </div>

        {addingCat && (
          <div style={{ padding:'8px', borderBottom:'1px solid var(--bdr)', background:'var(--bg2)', flexShrink:0 }}>
            <input style={{ ...inp, fontSize:12, marginBottom:6 }} value={catForm.label} onChange={e=>setCatForm(f=>({...f,label:e.target.value}))} onKeyDown={e=>e.key==='Enter'&&saveNewCat()} placeholder="Category name…" autoFocus/>
            <div style={{ display:'flex', gap:3, flexWrap:'wrap', marginBottom:6 }}>
              {ICONS.slice(0,12).map(ic=><button key={ic} onClick={()=>setCatForm(f=>({...f,icon:ic}))} style={{ width:24,height:24,borderRadius:5,border:`1.5px solid ${catForm.icon===ic?'var(--acc)':'var(--bdr)'}`,background:catForm.icon===ic?'var(--acc-d)':'var(--bg3)',cursor:'pointer',fontSize:12 }}>{ic}</button>)}
            </div>
            <div style={{ display:'flex', gap:3, flexWrap:'wrap', marginBottom:6 }}>
              {COLOURS.map(c=><button key={c} onClick={()=>setCatForm(f=>({...f,color:c}))} style={{ width:16,height:16,borderRadius:'50%',background:c,border:'none',cursor:'pointer',outline:catForm.color===c?'2px solid white':'none',outlineOffset:1 }}/>)}
            </div>
            <select value={catForm.parentId} onChange={e=>setCatForm(f=>({...f,parentId:e.target.value}))} style={{ ...inp, fontSize:11, padding:'4px 7px', marginBottom:6 }}>
              <option value="">Root category</option>
              {roots.map(r=><option key={r.id} value={r.id}>Under: {r.label}</option>)}
            </select>
            <div style={{ display:'flex', gap:5 }}>
              <button onClick={()=>setAddingCat(false)} style={{ flex:1,padding:'4px',borderRadius:6,cursor:'pointer',fontFamily:'inherit',background:'var(--bg3)',border:'1px solid var(--bdr)',color:'var(--t3)',fontSize:11 }}>Cancel</button>
              <button onClick={saveNewCat} disabled={!catForm.label.trim()} style={{ flex:2,padding:'4px',borderRadius:6,cursor:'pointer',fontFamily:'inherit',background:'var(--acc)',border:'none',color:'#0b0c10',fontSize:11,fontWeight:700,opacity:catForm.label.trim()?1:.4 }}>Add</button>
            </div>
          </div>
        )}

        {/* v4.7.5: Link existing category */}
        {!addingCat && selMenuId && (
          <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--bdr)', flexShrink: 0 }}>
            <button onClick={() => setShowLinkPicker(s => !s)}
              style={{ width:'100%', padding:'5px 8px', borderRadius:6, border:'1px dashed var(--bdr2,var(--bdr))', background:'transparent', color:'var(--t3)', cursor:'pointer', fontSize:11, fontFamily:'inherit' }}>
              {showLinkPicker ? '✕ Cancel' : '+ Link existing category'}
            </button>
            {showLinkPicker && (
              <div style={{ marginTop:6, maxHeight:200, overflowY:'auto', background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:6, padding:4 }}>
                {(() => {
                  const inMenuCatIds = new Set([
                    ...menuCategories.filter(c => c.menuId === selMenuId).map(c => c.id),
                    ...(categoryLinks||[]).filter(l => l.menu_id === selMenuId).map(l => l.category_id),
                  ]);
                  const available = menuCategories
                    .filter(c => !c.parentId && !c.isSpecial && !inMenuCatIds.has(c.id))
                    .sort((a,b) => (a.label||'').localeCompare(b.label||''));
                  if (available.length === 0) {
                    return <div style={{ padding:8, fontSize:11, color:'var(--t3)', textAlign:'center' }}>No categories left to link.</div>;
                  }
                  return available.map(c => (
                    <button key={c.id} onClick={() => handleLinkCat(c.id)}
                      style={{ display:'flex', width:'100%', alignItems:'center', gap:8, padding:'5px 8px', border:'none', background:'transparent', cursor:'pointer', fontFamily:'inherit', fontSize:11.5, color:'var(--t1)', textAlign:'left', borderRadius:4 }}
                      onMouseEnter={e=>e.currentTarget.style.background='var(--bg3)'}
                      onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                      <span style={{ width:6, height:6, borderRadius:2, background:c.color || 'var(--t3)', flexShrink:0 }} />
                      <span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{c.label}</span>
                      {c.scope && c.scope !== 'local' && (
                        <span style={{ fontSize:9, fontFamily:'ui-monospace,monospace', fontWeight:700, letterSpacing:'0.06em', color:c.scope==='shared'?'#80b4ff':'#c89bff', textTransform:'uppercase' }}>{c.scope}</span>
                      )}
                    </button>
                  ));
                })()}
              </div>
            )}
          </div>
        )}

        {/* Root drop zone */}


        {/* v5.5.956: catch-all drop zone. Dropping BELOW the last row (or in any gap)
            used to hit an element with no drop handler — the browser cancelled the
            drag and the row "snapped back" (Liqueurs-to-bottom). Anywhere that isn't
            a category row now means "send to the END of its own level". Row drops
            stopPropagation, so this never double-fires. */}
        <div style={{ flex:1, overflowY:'auto', padding:'4px 6px' }}
          onDragOver={e=>{ if (dragCatId) e.preventDefault(); }}
          onDrop={e=>{ if (dragCatId) onCatDrop(e,'end'); }}>
          {/* v5.5.813 (handoff markers 1 + 2): row actions are hidden at rest and
              fade in on hover. They stay in the DOM and in tab order — revealed on
              :focus-within for keyboard users, and always shown on touch devices
              where there is no hover at all. The count cross-fades inside a
              fixed-width zone so nothing shifts. Delete is neutral until its own
              hover, keeping red reserved for real meaning. */}
          <style>{`
            .mm-catrow .mm-acts { opacity:0; pointer-events:none; transition:opacity .12s; }
            .mm-catrow:hover .mm-acts, .mm-catrow:focus-within .mm-acts { opacity:1; pointer-events:auto; }
            .mm-catrow .mm-count { transition:opacity .1s; }
            .mm-catrow:hover .mm-count, .mm-catrow:focus-within .mm-count { opacity:0; }
            .mm-catrow .mm-grip { opacity:0; transition:opacity .12s; }
            .mm-catrow:hover .mm-grip { opacity:.75; }
            .mm-del:hover { background:var(--red-d) !important; border-color:var(--red-b) !important; color:var(--red) !important; }
            @media (hover:none) {
              .mm-catrow .mm-acts { opacity:1; pointer-events:auto; }
              .mm-catrow:hover .mm-count { opacity:1; }
              .mm-catrow .mm-grip { opacity:.75; }
            }
          `}</style>
          {(() => {
            // v5.5.815: find-as-you-type. A root shows if it matches OR any of its
            // children match (so the hierarchy still reads); when a root matches,
            // all its children stay visible.
            const q = catFilter.trim().toLowerCase();
            const hit = c => (c.label || '').toLowerCase().includes(q);
            const kidsOf = id => menuCategories.filter(c => c.parentId === id).sort((a,b)=>((a.sortOrder||0)-(b.sortOrder||0)) || String(a.label||'').localeCompare(String(b.label||'')));  // v5.5.950 tiebreak
            const visibleRoots = q
              ? roots.filter(r => hit(r) || kidsOf(r.id).some(hit))
              : roots;
            if (q && visibleRoots.length === 0) {
              return <div style={{ textAlign:'center', padding:'20px 8px', color:'var(--t4)', fontSize:11 }}>No categories match “{catFilter.trim()}”</div>;
            }
            return visibleRoots.map(cat=>{
            const allKids  = kidsOf(cat.id);
            const children = q && !hit(cat) ? allKids.filter(hit) : allKids;
            // Collapsed is ignored while searching, and a collapsed parent always
            // opens if the selected category is one of its children — selection is
            // never hidden behind a closed group.
            const isCollapsed = !q && collapsed.has(cat.id) && !allKids.some(s=>s.id===selCatId);
            const count    = menuItems.filter(i=>!i.archived&&i.type!=='subitem'&&(i.cat===cat.id||children.some(s=>s.id===i.cat))).length;
            const active   = selCatId===cat.id;
            const over     = overCatId===cat.id;
            const dragging = dragCatId===cat.id;
            const draggedC = menuCategories.find(c=>c.id===dragCatId);
            const isReorder= over && draggedC?.parentId===cat.parentId;
            const color    = cat.color||'#3b82f6';
            return (
              <div key={cat.id} style={{ opacity:dragging?.3:1 }}>
                {isReorder && <div style={{ height:3, background:'var(--acc)', borderRadius:2, margin:'1px 4px' }}/>}
                <div className="mm-catrow" draggable onDragStart={e=>{setDragCatId(cat.id);e.dataTransfer.effectAllowed='move';}} onDragOver={e=>{e.preventDefault();setOverCatId(cat.id);}} onDragEnd={()=>{setDragCatId(null);setOverCatId(null);}} onDrop={e=>onCatDrop(e,cat.id)} onClick={()=>{setSelCatId(cat.id);setSelItemId(null);setSearch('');}}
                  style={{ display:'flex', alignItems:'center', gap:7, height:40, padding:'0 8px', borderRadius:8, marginTop:6, cursor:'grab', userSelect:'none', border:`1.5px solid ${!isReorder&&over?'var(--acc)':active?color+'55':'transparent'}`, background:!isReorder&&over?'var(--acc-d)':active?color+'18':'transparent' }}>
                  <span className="mm-grip" style={{ fontSize:8, color:'var(--t4)', flexShrink:0 }}>⣿</span>
                  {/* v5.5.815: collapse/expand — only on groups that have children */}
                  {allKids.length > 0 ? (
                    <button onClick={e=>{e.stopPropagation();toggleCollapsed(cat.id);}}
                      title={isCollapsed ? 'Expand group' : 'Collapse group'}
                      aria-label={isCollapsed ? 'Expand group' : 'Collapse group'}
                      style={{ width:15, height:15, flexShrink:0, border:'none', background:'transparent', cursor:'pointer', color:'var(--t4)', fontSize:9, lineHeight:1, padding:0, display:'flex', alignItems:'center', justifyContent:'center', transform:isCollapsed?'rotate(-90deg)':'none', transition:'transform .14s' }}>▼</button>
                  ) : <span style={{ width:15, flexShrink:0 }}/>}
                  <div style={{ width:8, height:8, borderRadius:3, background:color, flexShrink:0, boxShadow:'inset 0 0 0 1px rgba(0,0,0,.1)' }}/>
                  <CatGlyph cat={cat} size={20}/>
                  <span title={cat.label} style={{ fontSize:13.5, fontWeight:active?700:600, color:active?color:(count===0?'var(--t3)':'var(--t1)'), flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', minWidth:0 }}>{cat.label}</span>
                  {/* Fixed-width zone: count cross-fades out as actions fade in */}
                  <span style={{ position:'relative', width:70, height:20, flexShrink:0 }}>
                    <span className="mm-count" style={{ position:'absolute', right:2, top:'50%', transform:'translateY(-50%)', fontSize:11.5, fontVariantNumeric:'tabular-nums', color:count===0?'var(--t4)':'var(--t3)' }}>{count}</span>
                    <span className="mm-acts" style={{ position:'absolute', right:0, top:'50%', transform:'translateY(-50%)', display:'flex', gap:4 }}>
                      <button onClick={e=>{e.stopPropagation();setEditingCat(cat);}} title="Rename category" style={{ width:20,height:20,borderRadius:5,border:'1px solid var(--bdr)',background:'var(--bg1)',color:'var(--t3)',cursor:'pointer',fontSize:11,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}>✎</button>
                      <button onClick={e=>{e.stopPropagation();setMovingCatId(cat.id);}} title="Move / nest this category" style={{ width:20,height:20,borderRadius:5,border:'1px solid var(--bdr)',background:'var(--bg1)',color:'var(--t3)',cursor:'pointer',fontSize:11,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}>↕</button>
                      <button className="mm-del" onClick={e=>{e.stopPropagation();if(confirm(`Delete "${cat.label}"? Items in this category will become uncategorised.`)){removeCategory(cat.id);if(selCatId===cat.id)setSelCatId(null);markBOChange();}}} title="Delete category" style={{ width:20,height:20,borderRadius:5,border:'1px solid var(--bdr)',background:'var(--bg1)',color:'var(--t3)',cursor:'pointer',fontSize:12,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}>×</button>
                    </span>
                  </span>
                </div>
                {/* Subcats — hidden while the group is collapsed */}
                {!isCollapsed && children.map(sub=>{
                  const sa = selCatId===sub.id;
                  const so = overCatId===sub.id;
                  const dc = menuCategories.find(c=>c.id===dragCatId);
                  const sr = so && dc?.parentId===sub.parentId;
                  const sc = sub.color||'#3b82f6';
                  return (
                    <div key={sub.id} style={{ opacity:dragCatId===sub.id?.3:1 }}>
                      {sr && <div style={{ height:2, background:'var(--acc)', borderRadius:2, margin:'1px 12px' }}/>}
                      {(() => { const subCount = menuItems.filter(i=>!i.archived&&i.type!=='subitem'&&i.cat===sub.id).length; return (
                      <div className="mm-catrow" draggable onDragStart={e=>{setDragCatId(sub.id);e.dataTransfer.effectAllowed='move';}} onDragOver={e=>{e.preventDefault();setOverCatId(sub.id);}} onDragEnd={()=>{setDragCatId(null);setOverCatId(null);}} onDrop={e=>onCatDrop(e,sub.id)} onClick={()=>{setSelCatId(sub.id);setSelItemId(null);setSearch('');}}
                        style={{ display:'flex', alignItems:'center', gap:6, height:36, padding:'0 8px 0 12px', margin:'1px 0 0 26px', borderRadius:'0 7px 7px 0', cursor:'grab',
                          borderLeft:'2px solid var(--bdr)',
                          border:`1.5px solid ${!sr&&so?'var(--acc)':sa?sc+'55':'transparent'}`, borderLeftWidth:2, borderLeftColor:!sr&&so?'var(--acc)':sa?sc+'55':'var(--bdr)',
                          background:!sr&&so?'var(--acc-d)':sa?sc+'18':'transparent' }}>
                        <CatGlyph cat={sub} size={17}/>
                        <span title={sub.label} style={{ fontSize:13, fontWeight:sa?700:500, color:sa?sc:(subCount===0?'var(--t3)':'var(--t2)'), flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', minWidth:0 }}>{sub.label}</span>
                        <span style={{ position:'relative', width:64, height:18, flexShrink:0 }}>
                          <span className="mm-count" style={{ position:'absolute', right:2, top:'50%', transform:'translateY(-50%)', fontSize:11, fontVariantNumeric:'tabular-nums', color:subCount===0?'var(--t4)':'var(--t3)' }}>{subCount}</span>
                          <span className="mm-acts" style={{ position:'absolute', right:0, top:'50%', transform:'translateY(-50%)', display:'flex', gap:4 }}>
                            <button onClick={e=>{e.stopPropagation();setEditingCat(sub);}} title="Rename" style={{ width:18,height:18,borderRadius:4,border:'1px solid var(--bdr)',background:'var(--bg1)',color:'var(--t3)',cursor:'pointer',fontSize:10,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}>✎</button>
                            <button onClick={e=>{e.stopPropagation();setMovingCatId(sub.id);}} title="Move / un-nest" style={{ width:18,height:18,borderRadius:4,border:'1px solid var(--bdr)',background:'var(--bg1)',color:'var(--t3)',cursor:'pointer',fontSize:10,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}>↕</button>
                            <button className="mm-del" onClick={e=>{e.stopPropagation();if(confirm(`Delete "${sub.label}"?`)){removeCategory(sub.id);if(selCatId===sub.id)setSelCatId(null);markBOChange();}}} title="Delete" style={{ width:18,height:18,borderRadius:4,border:'1px solid var(--bdr)',background:'var(--bg1)',color:'var(--t3)',cursor:'pointer',fontSize:11,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}>×</button>
                          </span>
                        </span>
                      </div> ); })()}
                    </div>
                  );
                })}
              </div>
            );
            });
          })()}
          {roots.length===0 && <div style={{ textAlign:'center', padding:'20px 6px', color:'var(--t4)', fontSize:10 }}>No categories.<br/>Click + to add one.</div>}
        </div>
      </div>

      {/* ── PANEL 2: Item GRID (mirrors POS) ───────────────────────────── */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', minWidth:0 }}>
        {selCat || search.trim() ? (<>
          {/* Toolbar */}
          <div style={{ padding:'8px 12px', borderBottom:'1px solid var(--bdr)', background:'var(--bg1)', display:'flex', gap:8, alignItems:'center', flexShrink:0 }}>
            {selCat && (
              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                <div style={{ width:28, height:28, borderRadius:8, background:`${selCat.color||'#3b82f6'}22`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:16 }}>{selCat.icon}</div>
                <span style={{ fontSize:14, fontWeight:800, color:'var(--t1)' }}>{selCat.label}</span>
                <span style={{ fontSize:10, color:'var(--t4)' }}>{displayItems.length} items</span>
              </div>
            )}
            {selCat && !search && (
              <button onClick={addSpacer} title="Add blank spacer cell to this category's grid"
                style={{ padding:'5px 10px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t3)', fontSize:11, fontWeight:600, flexShrink:0, marginLeft:'auto' }}>
                + Spacer
              </button>
            )}
            <div style={{ position:'relative', flex:1, maxWidth:260 }}>
              <span style={{ position:'absolute', left:9, top:'50%', transform:'translateY(-50%)', fontSize:12, color:'var(--t4)' }}>🔍</span>
              <input style={{ ...inp, paddingLeft:28, fontSize:12 }} placeholder="Search all items…" value={search} onChange={e=>setSearch(e.target.value)}/>
              {search && <button onClick={()=>setSearch('')} style={{ position:'absolute', right:8, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', color:'var(--t4)', cursor:'pointer', fontSize:14 }}>×</button>}
            </div>
            <div style={{ marginLeft:'auto', display:'flex', gap:6 }}>
              <div style={{ display:'flex', borderRadius:8, overflow:'hidden', border:'1px solid var(--bdr)' }}>
                {[['grid','⊞ Grid'],['list','☰ List']].map(([m,l]) => (
                  <button key={m} onClick={()=>setViewMode(m)} style={{ padding:'5px 10px', cursor:'pointer', fontFamily:'inherit', background:viewMode===m?'var(--acc-d)':'var(--bg3)', border:'none', borderRight:'1px solid var(--bdr)', color:viewMode===m?'var(--acc)':'var(--t3)', fontSize:11, fontWeight:viewMode===m?700:400 }}>{l}</button>
                ))}
              </div>
              <button onClick={()=>setShowAddPanel(v=>!v)} style={{ padding:'6px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:12, fontWeight:700 }}>+ Add items</button>
            </div>
          </div>


          {/* ── Add items from library panel ─────────────────────── */}
          {showAddPanel && selCat && (() => {
            const catItemIds = new Set(displayItems.map(i=>i.id));
            const q = addSearch.toLowerCase().trim();
            const notInCat = menuItems.filter(i =>
              !i.archived && !i.parentId && (i.type!=='subitem'||i.soldAlone) &&
              i.cat !== selCat.id && !(i.cats||[]).includes(selCat.id) &&
              (q==='' || (i.menuName||i.name||'').toLowerCase().includes(q) || (i.description||'').toLowerCase().includes(q))
            ).sort((a,b)=>(a.menuName||a.name||'').localeCompare(b.menuName||b.name||''));
            const addToCat = (item) => {
              if (!item.cat) { updateMenuItem(item.id,{cat:selCat.id}); }
              else { updateMenuItem(item.id,{cats:[...(item.cats||[]).filter(c=>c!==selCat.id),selCat.id]}); }
              markBOChange(); showToast(`${item.menuName||item.name} added to ${selCat.label}`,'success');
            };
            const removeFromCat = (item) => {
              if (item.cat===selCat.id) { updateMenuItem(item.id,{cat:item.cats?.[0]||'',cats:(item.cats||[]).slice(1)}); }
              else { updateMenuItem(item.id,{cats:(item.cats||[]).filter(c=>c!==selCat.id)}); }
              markBOChange(); showToast(`Removed from ${selCat.label}`,'info');
            };
            return (
              <div style={{ borderBottom:'2px solid var(--acc-b)', background:'var(--acc-d)', flexShrink:0, maxHeight:260, display:'flex', flexDirection:'column', overflow:'hidden' }}>
                <div style={{ padding:'8px 12px', display:'flex', gap:8, alignItems:'center', flexShrink:0, borderBottom:'1px solid var(--acc-b)' }}>
                  <span style={{ fontSize:11, fontWeight:700, color:'var(--acc)' }}>Add items to {selCat.label}</span>
                  <div style={{ position:'relative', flex:1, maxWidth:320 }}>
                    <span style={{ position:'absolute',left:9,top:'50%',transform:'translateY(-50%)',fontSize:12,color:'var(--t4)' }}>🔍</span>
                    <input autoFocus style={{ ...inp, paddingLeft:28, fontSize:12 }} value={addSearch} onChange={e=>setAddSearch(e.target.value)} placeholder="Search items to add…"/>
                    {addSearch&&<button onClick={()=>setAddSearch('')} style={{ position:'absolute',right:8,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',color:'var(--t4)',cursor:'pointer',fontSize:14 }}>×</button>}
                  </div>
                  <button onClick={()=>{setShowAddPanel(false);setAddSearch('');}} style={{ padding:'4px 10px',borderRadius:7,cursor:'pointer',fontFamily:'inherit',background:'var(--bg3)',border:'1px solid var(--bdr)',color:'var(--t3)',fontSize:11 }}>Done</button>
                </div>
                <div style={{ overflowY:'auto', flex:1 }}>
                  {/* Items already in this category */}
                  {displayItems.length>0&&(
                    <div style={{ padding:'4px 12px 2px', fontSize:9, fontWeight:700, color:'var(--acc)', textTransform:'uppercase', letterSpacing:'.07em', marginTop:4 }}>
                      Already in {selCat.label} ({displayItems.length})
                    </div>
                  )}
                  {displayItems.map(item=>(
                    <div key={item.id} style={{ display:'flex',alignItems:'center',gap:10,padding:'6px 12px',borderBottom:'1px solid var(--acc-b)' }}>
                      <div style={{ flex:1,minWidth:0 }}>
                        <span style={{ fontSize:12,fontWeight:600,color:'var(--t1)' }}>{item.menuName||item.name}</span>
                        <span style={{ fontSize:10,color:'var(--t4)',marginLeft:8 }}>{money((item.pricing?.base??item.price??0))}</span>
                      </div>
                      <span style={{ fontSize:10,fontWeight:600,padding:'2px 7px',borderRadius:6,background:'var(--grn-d)',color:'var(--grn)',border:'1px solid var(--grn-b)' }}>✓ In menu</span>
                      <button onClick={()=>removeFromCat(item)} style={{ padding:'3px 8px',borderRadius:6,cursor:'pointer',fontFamily:'inherit',background:'var(--red-d)',border:'1px solid var(--red-b)',color:'var(--red)',fontSize:10,fontWeight:600 }}>Remove</button>
                    </div>
                  ))}
                  {/* Items NOT in this category */}
                  {notInCat.length>0&&(
                    <div style={{ padding:'4px 12px 2px', fontSize:9, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', marginTop:6 }}>
                      Available to add {addSearch?`matching "${addSearch}"`:''}
                    </div>
                  )}
                  {notInCat.slice(0,20).map(item=>{
                    const itemCat = menuCategories.find(c=>c.id===item.cat);
                    return (
                      <div key={item.id} style={{ display:'flex',alignItems:'center',gap:10,padding:'6px 12px',borderBottom:'1px solid var(--bdr)',background:'var(--bg2)' }}>
                        <div style={{ flex:1,minWidth:0 }}>
                          <span style={{ fontSize:12,fontWeight:600,color:'var(--t1)' }}>{item.menuName||item.name}</span>
                          {itemCat&&<span style={{ fontSize:9,color:'var(--t4)',marginLeft:7 }}>{itemCat.icon} {itemCat.label}</span>}
                          <span style={{ fontSize:10,color:'var(--t4)',marginLeft:8 }}>{money((item.pricing?.base??item.price??0))}</span>
                        </div>
                        <button onClick={()=>addToCat(item)} style={{ padding:'4px 10px',borderRadius:7,cursor:'pointer',fontFamily:'inherit',background:'var(--acc)',border:'none',color:'#0b0c10',fontSize:11,fontWeight:700,flexShrink:0 }}>+ Add</button>
                      </div>
                    );
                  })}
                  {notInCat.length===0&&addSearch&&(
                    <div style={{ padding:'12px',textAlign:'center',fontSize:11,color:'var(--t4)' }}>No items matching "{addSearch}" — create it in the Items tab</div>
                  )}
                  {notInCat.length===0&&!addSearch&&displayItems.length>0&&(
                    <div style={{ padding:'12px',textAlign:'center',fontSize:11,color:'var(--t4)' }}>All items are already in this category</div>
                  )}
                </div>
              </div>
            );
          })()}

          {viewMode==='list' ? (
            <ListItemView
              items={displayItems} menuItems={menuItems} selItemId={selItemId} setSelItemId={setSelItemId}
              catColor={selCat?.color||'var(--acc)'} addMenuItem={addMenuItem}
              updateMenuItem={updateMenuItem} markBOChange={markBOChange} showToast={showToast}
              eightySixIds={eightySixIds} modifierGroupDefs={modifierGroupDefs}/>
          ) : (<>
          <div style={{ flex:1, overflowY:'auto', overflowX:'auto', padding:'12px' }}
            onDragOver={e=>e.preventDefault()}
            onDrop={e=>{ if(dragItemId&&!overItemId){ const max=Math.max(...displayItems.map(i=>i.sortOrder??0),0); updateMenuItem(dragItemId,{sortOrder:max+1}); markBOChange(); setDragItemId(null); } }}>
            {displayItems.length===0 ? (
              <div style={{ textAlign:'center', padding:'48px 0', color:'var(--t4)' }}>
                <div style={{ fontSize:36, opacity:.15, marginBottom:10 }}>{selCat?.icon||'🍽'}</div>
                <div style={{ fontSize:13, fontWeight:600, color:'var(--t3)', marginBottom:8 }}>No items in {selCat?.label||'this category'}</div>
                <button onClick={()=>setShowAddPanel(true)} style={{ padding:'8px 18px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:13, fontWeight:700 }}>+ Add items to this category</button>
              </div>
            ) : (
              // v5.5.817: LOCKED TO THE POS GRID. This is a layout editor, not a
              // gallery — position N here is position N on the till, which is the
              // whole point of the Spacer cells. So the column count, row height and
              // gap are copied from POSSurface's item grid (repeat(6,1fr),
              // gridAutoRows minmax(110px,auto), gap 8). It must NEVER reflow to a
              // different column count: that would silently misrepresent the layout
              // the operator is building. When the pane is too narrow the columns
              // hold their minimum and the area scrolls sideways instead.
              <div style={{
                display:'grid',
                gridTemplateColumns:'repeat(6, minmax(118px, 1fr))',
                gridAutoRows:'minmax(110px, auto)',
                gap:8,
                alignContent:'start',
                maxWidth:1180,          // keeps till-like proportions on a big monitor
                minWidth:6*118 + 5*8,   // 6 columns never collapse below a usable size
              }}>
                {gridWithSpacers.map(item=>{
                  // Spacer cell — draggable blank layout cell
                  if (item._spacer) return (
                    <div key={item.id}
                      draggable
                      onDragStart={e=>{setDragItemId(item.id);e.dataTransfer.effectAllowed='move';}}
                      onDragOver={e=>{e.preventDefault();if(dragItemId&&dragItemId!==item.id)setOverItemId(item.id);}}
                      onDragLeave={()=>setOverItemId(null)}
                      onDragEnd={()=>{setDragItemId(null);setOverItemId(null);}}
                      onDrop={e=>{e.preventDefault();reorderGrid(dragItemId,item.id);setDragItemId(null);setOverItemId(null);}}
                      style={{ position:'relative', borderRadius:14, minHeight:90, opacity:dragItemId===item.id?.3:1,
                        border:`2px dashed ${overItemId===item.id?'var(--acc)':'var(--bdr2)'}`,
                        background:overItemId===item.id?'var(--acc-d)':'var(--bg3)',
                        display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:4,
                        cursor:'grab', transition:'all .1s' }}>
                      <span style={{ fontSize:20, opacity:.2 }}>□</span>
                      <span style={{ fontSize:9, color:'var(--t4)', fontWeight:600, letterSpacing:'.05em' }}>SPACER</span>
                      <button onClick={e=>{e.stopPropagation();removeSpacer(item.id);}}
                        style={{ position:'absolute', top:4, right:4, width:18, height:18, borderRadius:5, border:'1px solid var(--bdr)', background:'var(--bg4)', color:'var(--t4)', cursor:'pointer', fontSize:11, display:'flex', alignItems:'center', justifyContent:'center', fontFamily:'inherit' }}>×</button>
                    </div>
                  );

                  const active   = selItemId===item.id;
                  const isOver   = overItemId===item.id;
                  const isDragging= dragItemId===item.id;
                  const isParent = menuItems.some(c=>c.parentId===item.id&&!c.archived);
                  const is86     = eightySixIds.includes(item.id);
                  const p        = item.pricing||{base:item.price||0};
                  const children = menuItems.filter(c=>c.parentId===item.id&&!c.archived);
                  const catColor = (menuCategories.find(c=>c.id===item.cat)||selCat)?.color||'#3b82f6';
                  return (
                    <div key={item.id} style={{ opacity:isDragging?.3:1 }}>
                      {isOver && <div style={{ height:3, background:'var(--acc)', borderRadius:2, marginBottom:3 }}/>}
                      <div
                        draggable
                        onDragStart={e=>{setDragItemId(item.id);e.dataTransfer.effectAllowed='move';}}
                        onDragOver={e=>{e.preventDefault();if(dragItemId&&dragItemId!==item.id)setOverItemId(item.id);}}
                        onDragLeave={()=>setOverItemId(null)}
                        onDragEnd={()=>{setDragItemId(null);setOverItemId(null);}}
                        onDrop={e=>{e.preventDefault();reorderGrid(dragItemId,item.id);}}
                        onClick={()=>setSelItemId(active?null:item.id)}
                        style={{
                          // v5.5.813 (handoff marker 6): equal-height cards, ink price,
                          // 2-line clamped description, selection reads as a ring.
                          position:'relative', borderRadius:14, cursor:'pointer', userSelect:'none',
                          border:`2px solid ${active?'var(--acc)':'var(--bdr)'}`,
                          background:active?'var(--acc-d)':'var(--bg2)',
                          // height:100% so the card fills the POS-sized row box above
                          overflow:'hidden', height:'100%', minHeight:110, display:'flex', flexDirection:'column',
                          boxShadow:active?'0 0 0 3px var(--acc-b)':'none',
                          transition:'border-color .1s, box-shadow .1s',
                        }}>
                        {/* Colour bar — matches POS */}
                        <div style={{ position:'absolute', left:0, top:0, bottom:0, width:4, background:catColor, opacity:.8 }}/>
                        {/* marker 7: stock state is visible while scanning, not only after opening */}
                        {is86 && <span style={{ position:'absolute', top:9, right:9, zIndex:2, fontSize:9.5, fontWeight:800, padding:'2px 6px', borderRadius:6, background:'var(--red-d)', color:'var(--red)', border:'1px solid var(--red-b)', lineHeight:1.3 }}>86</span>}
                        <div style={{ padding:'11px 11px 10px 14px', display:'flex', flexDirection:'column', gap:5, flex:1 }}>
                          <div title={item.menuName||item.name} style={{ fontSize:14, fontWeight:700, color:active?'var(--acc)':'var(--t1)', lineHeight:1.25, paddingRight:is86?30:14 }}>
                            {item.menuName||item.name}
                          </div>
                          {item.description && <div style={{ fontSize:11.5, color:'var(--t4)', lineHeight:1.4, overflow:'hidden', display:'-webkit-box', WebkitLineClamp:2, WebkitBoxOrient:'vertical' }}>{item.description}</div>}
                          <div style={{ marginTop:'auto', display:'flex', alignItems:'center', gap:5, flexWrap:'wrap' }}>
                            {isParent ? (
                              <span style={{ fontSize:13, fontWeight:700, color:'var(--t1)', fontVariantNumeric:'tabular-nums' }}>from {money(Math.min(...children.map(c=>c.pricing?.base??c.price??0)))}</span>
                            ) : (
                              <span style={{ fontSize:14, fontWeight:700, color:'var(--t1)', fontVariantNumeric:'tabular-nums' }}>{p.base>0?`${money(p.base)}`:'free'}</span>
                            )}
                            {isParent && <span style={{ fontSize:9, padding:'1px 5px', borderRadius:8, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t3)', fontWeight:700 }}>sizes</span>}
                            {(item.assignedModifierGroups||[]).length>0 && <span style={{ fontSize:9, color:'var(--t3)', padding:'1px 5px', borderRadius:6, background:'var(--bg3)', border:'1px solid var(--bdr)', fontWeight:700 }}>⊕ options</span>}
                            {(item.allergens||[]).length>0 && <span style={{ fontSize:10, color:'#3B6FD8', fontWeight:700 }}>△{item.allergens.length}</span>}
                          </div>
                        </div>
                        {/* Drag handle — top right */}
                        <div style={{ position:'absolute', top:4, right:6, fontSize:9, color:'var(--t4)', cursor:'grab', lineHeight:1 }}>⣿</div>
                        {/* Variant expand toggle */}
                        {isParent && (
                          <button onClick={e=>{e.stopPropagation();setExpandedParentId(expandedParentId===item.id?null:item.id);}}
                            style={{ position:'absolute', bottom:6, right:6, fontSize:9, fontWeight:700, padding:'2px 6px', borderRadius:6, cursor:'pointer', fontFamily:'inherit',
                              background:expandedParentId===item.id?catColor+'33':'var(--bg4)', border:`1px solid ${expandedParentId===item.id?catColor+'55':'var(--bdr)'}`,
                              color:expandedParentId===item.id?catColor:'var(--t4)' }}>
                            {expandedParentId===item.id?'▲ hide':'▼ sizes'}
                          </button>
                        )}
                      </div>
                      {/* Inline variant children — shown when expanded */}
                      {isParent && expandedParentId===item.id && (
                        <div style={{ margin:'4px 0 0', padding:'8px', background:'var(--bg3)', borderRadius:10, border:`1px solid ${catColor}33` }}>
                          <div style={{ fontSize:9, fontWeight:700, color:catColor, textTransform:'uppercase', letterSpacing:'.07em', marginBottom:6 }}>Variants — {children.length} sizes</div>
                          <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                            {children.sort((a,b)=>(a.sortOrder??999)-(b.sortOrder??999)).map(child=>{
                              const cp = child.pricing?.base ?? child.price ?? 0;
                              const isSelChild = selItemId===child.id;
                              return (
                                <button key={child.id} onClick={e=>{e.stopPropagation();setSelItemId(isSelChild?null:child.id);}}
                                  style={{ display:'flex', flexDirection:'column', alignItems:'flex-start', padding:'8px 10px', borderRadius:10, cursor:'pointer', fontFamily:'inherit',
                                    border:`1.5px solid ${isSelChild?'var(--acc)':catColor+'44'}`, background:isSelChild?'var(--acc-d)':catColor+'11',
                                    minWidth:90, flex:'1 1 90px', maxWidth:140 }}>
                                  <div style={{ fontSize:12, fontWeight:700, color:isSelChild?'var(--acc)':'var(--t1)', marginBottom:4 }}>{child.menuName||child.name}</div>
                                  <div style={{ fontSize:13, fontWeight:800, color:catColor, fontFamily:'var(--font-mono)' }}>{money(cp)}</div>
                                  {(child.allergens||[]).length>0 && <div style={{ fontSize:9, color:'var(--red)', marginTop:3 }}>⚠ {child.allergens.length}</div>}
                                </button>
                              );
                            })}
                            <button onClick={e=>{e.stopPropagation();
                              addMenuItem({name:'New size', menuName:'New size', type:'simple', parentId:item.id, cat:item.cat,
                                allergens:[], pricing:{base:0}, assignedModifierGroups:[], cats:[]});
                              markBOChange(); showToast('Variant added','success');
                            }} style={{ display:'flex', alignItems:'center', justifyContent:'center', padding:'8px', borderRadius:10, cursor:'pointer', fontFamily:'inherit',
                              border:`1.5px dashed ${catColor}55`, background:'transparent', color:catColor, fontSize:20, minWidth:44, opacity:.6 }}>+</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div style={{ padding:'5px 12px', borderTop:'1px solid var(--bdr)', fontSize:9.5, color:'var(--t4)', background:'var(--bg1)', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
            <span style={{ display:'inline-flex', alignItems:'center', gap:5, fontWeight:700, color:'var(--t3)' }}>
              <span style={{ width:5, height:5, borderRadius:'50%', background:'var(--acc)' }}/>
              This is the POS layout — 6 columns, same as the till
            </span>
            <span>Drag cards to reorder · use + Spacer to leave a gap · reflects on POS instantly</span>
          </div>
          </>
          )}
        </>) : (
          <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:10, color:'var(--t4)' }}>
            <span style={{ fontSize:40, opacity:.12 }}>🍽</span>
            <span style={{ fontSize:13, fontWeight:600, color:'var(--t3)' }}>Select a category to see its items</span>
            <span style={{ fontSize:11, color:'var(--t4)' }}>or use search to find any item</span>
            <div style={{ position:'relative', marginTop:4 }}>
              <span style={{ position:'absolute', left:9, top:'50%', transform:'translateY(-50%)', fontSize:12, color:'var(--t4)' }}>🔍</span>
              <input style={{ ...inp, paddingLeft:28, width:260 }} placeholder="Search all items…" value={search} onChange={e=>setSearch(e.target.value)} autoFocus/>
            </div>
          </div>
        )}
      </div>

      {/* ── PANEL 3: Item editor ────────────────────────────────────────── */}
      {/* onArchive: archiveMenuItem is async and toasts its own failure — the
          "Archived" confirmation must wait for the row to actually flip. */}
      {selItem && (
        <ItemEditor key={selItem.id} item={selItem}
          allCategories={menuCategories.filter(c=>!c.isSpecial)}
          onUpdate={patch=>{updateMenuItem(selItem.id,patch);markBOChange();}}
          onArchive={async ()=>{const id=selItem.id;setSelItemId(null);markBOChange();if(await archiveMenuItem(id))showToast('Archived','info');}}
          onClone={()=>cloneItem(selItem,menuItems,addMenuItem,updateMenuItem,markBOChange,showToast,setSelItemId)}
          onClose={()=>setSelItemId(null)}
          is86={eightySixIds.includes(selItem.id)} onToggle86={()=>toggle86(selItem.id)}
          menuItems={menuItems} addMenuItem={addMenuItem} updateMenuItem={updateMenuItem}
          markBOChange={markBOChange} showToast={showToast}
        />
      )}

      {movingCatId && (() => {
        const movingCat = menuCategories.find(c=>c.id===movingCatId);
        return movingCat ? (
          <MoveCatModal cat={movingCat} allCats={menuCategories.filter(c=>!c.isSpecial)}
            onSave={parentId=>{ updateCategory(movingCatId,{parentId}); markBOChange(); setMovingCatId(null); showToast(parentId?'Nested as subcategory':'Moved to root','success'); }}
            onClose={()=>setMovingCatId(null)}/>
        ) : null;
      })()}
      {editingCat && (
        <CatModal cat={editingCat} roots={roots}
          onSave={p=>{updateCategory(editingCat.id,p);markBOChange();setEditingCat(null);showToast('Updated','success');}}
          onDelete={()=>{removeCategory(editingCat.id);setSelCatId(null);setEditingCat(null);markBOChange();}}
          onClose={()=>setEditingCat(null)}/>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// LIST ITEM VIEW
// Table-style list showing items with variants nested inline.
// Each row: drag handle · name · type · price · mods · allergens
// Variant children are shown indented under their parent, always visible.
// ═══════════════════════════════════════════════════════════════════════════
function ListItemView({ items, menuItems, selItemId, setSelItemId, catColor, addMenuItem, updateMenuItem, markBOChange, showToast, eightySixIds, modifierGroupDefs }) {
  const [collapsedIds, setCollapsedIds] = useState(new Set()); // empty = all expanded by default
  const [dragIdx, setDragIdx]   = useState(null);
  const [overIdx, setOverIdx]   = useState(null);

  const variantsOf = (parentId) =>
    menuItems.filter(c => c.parentId === parentId && !c.archived)
      .sort((a,b) => (a.sortOrder??999)-(b.sortOrder??999));

  const toggleExpand = id =>
    setCollapsedIds(s => { const n=new Set(s); n.has(id)?n.delete(id):n.add(id); return n; });

  const reorder = (from, to) => {
    const arr = [...items];
    const [moved] = arr.splice(from,1);
    arr.splice(to, 0, moved);
    arr.forEach((item,i) => { if((item.sortOrder??999)!==i) updateMenuItem(item.id,{sortOrder:i}); });
    markBOChange();
  };

  const addVariant = (parentId, cat, allergens, currentCount) => {
    addMenuItem({ name:`New size`, menuName:`New size`, receiptName:`New size`, kitchenName:`New size`,
      type:'simple', parentId, cat, allergens:[...allergens], pricing:{base:0},
      assignedModifierGroups:[], assignedInstructionGroups:[], sortOrder:currentCount });
    markBOChange();
    setTimeout(()=>{
      const last = useStore.getState().menuItems.slice(-1)[0];
      if(last) setSelItemId(last.id);
    }, 30);
  };

  const typeLabel = t => ({ simple:'Simple', modifiable:'Options', variants:'Has sizes', pizza:'Pizza', combo:'Combo', subitem:'Sub item' }[t] || t);
  const typeColor = t => ({ simple:'var(--t4)', modifiable:'var(--acc)', variants:'var(--grn)', pizza:'#f97316', combo:'#8b5cf6' }[t] || 'var(--t4)');

  return (
    <div style={{ flex:1, overflowY:'auto' }}>
      {/* Header row */}
      <div style={{ display:'grid', gridTemplateColumns:'28px 1fr 90px 80px 60px 50px', gap:0, padding:'6px 12px', borderBottom:'2px solid var(--bdr)', position:'sticky', top:0, background:'var(--bg1)', zIndex:5 }}>
        <div/>
        <div style={{ fontSize:9, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em' }}>Item</div>
        <div style={{ fontSize:9, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em' }}>Type</div>
        <div style={{ fontSize:9, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em' }}>Price</div>
        <div style={{ fontSize:9, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em' }}>Mods</div>
        <div style={{ fontSize:9, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em' }}>⚠</div>
      </div>

      {items.length === 0 && (
        <div style={{ padding:'40px', textAlign:'center', color:'var(--t4)', fontSize:12 }}>No items — click + Item to add one</div>
      )}

      {items.map((item, i) => {
        const isSel    = selItemId === item.id;
        const is86     = eightySixIds.includes(item.id);
        const expanded = !collapsedIds.has(item.id);
        const variants = variantsOf(item.id);
        const hasVars  = variants.length > 0 || (item.type||'simple')==='variants';
        const price    = item.pricing?.base ?? item.price ?? 0;
        const fromP    = hasVars && variants.length > 0 ? Math.min(...variants.map(v=>v.pricing?.base??v.price??0)) : price;
        const modCount = (item.assignedModifierGroups||[]).length + (item.assignedInstructionGroups||[]).length;
        const allergCount = (item.allergens||[]).length;


        return (
          <div key={item.id}>
            {/* Drop zone above */}
            {overIdx === i && dragIdx !== i && dragIdx !== i-1 && (
              <div style={{ height:3, background:'var(--acc)', marginLeft:12, marginRight:12, borderRadius:2 }}/>
            )}

            {/* Main item row */}
            <div
              draggable
              onDragStart={()=>setDragIdx(i)}
              onDragOver={e=>{e.preventDefault();setOverIdx(i);}}
              onDrop={e=>{e.preventDefault();if(dragIdx!==null&&dragIdx!==i)reorder(dragIdx,i);setDragIdx(null);setOverIdx(null);}}
              onDragEnd={()=>{setDragIdx(null);setOverIdx(null);}}
              onClick={()=>setSelItemId(isSel?null:item.id)}
              style={{ display:'grid', gridTemplateColumns:'28px 1fr 90px 80px 60px 50px', gap:0, padding:'8px 12px', cursor:'pointer', alignItems:'center',
                background:isSel?'var(--acc-d)':is86?'var(--red-d)':'transparent',
                borderBottom:'1px solid var(--bdr)',
                opacity:dragIdx===i?.4:1,
                transition:'background .1s' }}>
              <span style={{ fontSize:10, color:'var(--t4)', cursor:'grab', textAlign:'center' }}>⠿</span>
              <div style={{ display:'flex', alignItems:'center', gap:8, minWidth:0 }}>
                {hasVars && (
                  <button onClick={e=>{e.stopPropagation();toggleExpand(item.id);}} style={{ width:16, height:16, borderRadius:4, border:'1px solid var(--bdr)', background:'var(--bg3)', cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', fontSize:9, color:'var(--t4)', flexShrink:0, fontFamily:'inherit' }}>
                    {expanded?'▾':'▸'}
                  </button>
                )}
                <span style={{ fontSize:13, fontWeight:700, color:isSel?'var(--acc)':is86?'var(--red)':'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                  {item.menuName||item.name}
                </span>
                {is86 && <span style={{ fontSize:8, padding:'1px 4px', borderRadius:4, background:'var(--red-d)', color:'var(--red)', border:'1px solid var(--red-b)', flexShrink:0 }}>86</span>}
              </div>
              <span style={{ fontSize:10, fontWeight:600, color:typeColor(item.type||'simple') }}>{typeLabel(item.type||'simple')}</span>
              <span style={{ fontSize:12, fontWeight:700, color:catColor, fontFamily:'var(--font-mono)' }}>
                {hasVars && variants.length>0 ? `from ${money(fromP)}` : `${money(price)}`}
              </span>
              <span style={{ fontSize:11, color:modCount>0?'var(--acc)':'var(--t4)', fontWeight:modCount>0?700:400 }}>{modCount>0?`⊕ ${modCount}`:''}</span>
              <span style={{ fontSize:10, color:allergCount>0?'var(--red)':'var(--t4)' }}>{allergCount>0?allergCount:''}</span>
            </div>

            {/* Variant children — shown when parent is expanded */}
            {hasVars && expanded && (
              <div style={{ background:'var(--bg3)', borderBottom:'1px solid var(--bdr)' }}>
                {variants.map(v => {
                  const vp = v.pricing||{base:v.price||0};
                  const vSel = selItemId===v.id;
                  return (
                    <div key={v.id} onClick={e=>{e.stopPropagation();setSelItemId(vSel?null:v.id);}}
                      style={{ display:'grid', gridTemplateColumns:'28px 1fr 90px 80px 60px 50px', gap:0, padding:'6px 12px 6px 44px', cursor:'pointer', alignItems:'center',
                        background:vSel?'var(--acc-d)':'transparent', borderBottom:'1px solid var(--bdr)', transition:'background .1s' }}>
                      <div/>
                      <div style={{ display:'flex', alignItems:'center', gap:6, minWidth:0 }}>
                        <span style={{ fontSize:10, color:catColor, flexShrink:0 }}>└</span>
                        <input
                          style={{ fontSize:12, fontWeight:600, color:vSel?'var(--acc)':'var(--t1)', background:'transparent', border:'none', outline:'none', width:'100%', fontFamily:'inherit', cursor:'text' }}
                          value={v.menuName||v.name||''}
                          onClick={e=>e.stopPropagation()}
                          onChange={e=>{updateMenuItem(v.id,{menuName:e.target.value,name:e.target.value,receiptName:e.target.value,kitchenName:e.target.value});markBOChange();}}
                          placeholder="Size name"
                        />
                      </div>
                      <span style={{ fontSize:10, color:'var(--t4)' }}>size</span>
                      <div style={{ display:'flex', alignItems:'center', gap:2 }}>
                        <span style={{ fontSize:11, color:'var(--t4)', fontWeight:700 }}>£</span>
                        <input type="number" step="0.01" min="0"
                          style={{ fontSize:12, fontWeight:700, color:catColor, background:'transparent', border:'none', outline:'none', width:55, fontFamily:'inherit', cursor:'text' }}
                          value={vp.base!==undefined?vp.base:''}
                          onClick={e=>e.stopPropagation()}
                          onChange={e=>{updateMenuItem(v.id,{pricing:{...vp,base:parseFloat(e.target.value)||0},price:parseFloat(e.target.value)||0});markBOChange();}}
                          placeholder="0.00"
                        />
                      </div>
                      <span style={{ fontSize:10, color:(v.allergens||[]).length>0?'var(--red)':'var(--t4)' }}>
                        {(v.allergens||[]).length>0?(v.allergens||[]).length:''}
                      </span>
                      <button
                        onClick={async e => {
                          e.stopPropagation();
                          if (!confirm('Remove this size?')) return;
                          const prevParentId = v.parentId;
                          updateMenuItem(v.id, { archived:true, parentId:null });
                          markBOChange();
                          const { error } = await archiveVariantRow(v.id);
                          if (error) {
                            // The row is untouched in the DB — it comes straight back on
                            // the next config load and every other till is still selling it.
                            updateMenuItem(v.id, { archived:false, parentId:prevParentId });
                            showToast(`"${v.menuName||v.name||'Size'}" was NOT removed — it is still on sale. Check you're signed in, then try again`, 'error');
                            return;
                          }
                          showToast('Size removed', 'info');
                        }}
                        style={{ width:18,height:18,borderRadius:4,border:'1px solid var(--red-b)',background:'var(--red-d)',color:'var(--red)',cursor:'pointer',fontSize:11,display:'flex',alignItems:'center',justifyContent:'center' }}>×</button>
                    </div>
                  );
                })}
                {/* Add variant row */}
                <div style={{ padding:'5px 12px 5px 44px' }}>
                  <button onClick={e=>{e.stopPropagation();addVariant(item.id, item.cat, item.allergens||[], variants.length);if(item.type!=='variants'){updateMenuItem(item.id,{type:'variants'});markBOChange();}}}
                    style={{ fontSize:11, fontWeight:600, color:catColor, background:'none', border:`1px dashed ${catColor}55`, borderRadius:7, padding:'3px 10px', cursor:'pointer', fontFamily:'inherit' }}>
                    + Add size
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Drag drop footer */}
      <div style={{ padding:'4px 12px', borderTop:'1px solid var(--bdr)', fontSize:9, color:'var(--t4)', background:'var(--bg1)' }}>
        Drag rows to reorder · click row to edit · expand ▾ to see/edit sizes
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// ITEMS LIBRARY
// Flat list of ALL items including variant sub-items. The central item store.
// Search, filter by type or category, click to edit, add new items.
// Sub-items (variants) always shown indented under their parent.

// ── Items Library ─────────────────────────────────────────────────────────────
// ── v5.5.813: recipe-derived cost for the Items list ─────────────────────────
// Returns { [menuItemId]: plateCost } once recipes + costing context load.
// `null` while loading so the UI can stay quiet rather than flashing "No recipe"
// on every row before the data arrives.
function useRecipeCosts() {
  const [costs, setCosts] = useState(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (isMock) { if (alive) setCosts({}); return; }
        const loc = getActiveLocationSync() || await getLocationId().catch(() => null);
        if (!loc || loc === 'loc-demo') { if (alive) setCosts({}); return; }
        const [recRes, ctx] = await Promise.all([fetchRecipes(loc), buildCostingCtx(loc)]);
        if (!alive) return;
        const map = {};
        (recRes?.data || []).forEach(r => {
          if (r.recipeType !== 'MENU' || !r.menuItemId) return;
          const c = costRecipeWith(r, ctx);
          if (c && !c.error && Number.isFinite(c.totalCost)) map[String(r.menuItemId)] = c.totalCost;
        });
        setCosts(map);
      } catch { if (alive) setCosts({}); }
    })();
    return () => { alive = false; };
  }, []);
  return costs;
}

// Category glyph — the category's emoji, or a neutral initial tile when it has
// none (a real placeholder instead of the 🍽 cutlery emoji, which read as a
// deliberate icon). Handoff marker 3.
function CatGlyph({ cat, size = 20 }) {
  if (cat?.icon) return <span style={{ fontSize: size * 0.75, flexShrink: 0, width: size, textAlign: 'center' }}>{cat.icon}</span>;
  return (
    <span style={{
      flexShrink: 0, width: size, height: size, borderRadius: 6, background: 'var(--bg3)',
      color: 'var(--t3)', fontSize: size * 0.52, fontWeight: 800,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>{(cat?.label || '?').charAt(0).toUpperCase()}</span>
  );
}

function ItemsLibrary() {
  const { menuItems, menuCategories, addMenuItem, updateMenuItem, archiveMenuItem,
          eightySixIds, toggle86, markBOChange, showToast, taxRates, taxProfiles } = useStore();

  const recipeCosts = useRecipeCosts();          // v5.5.813 — B7 COST + GP%
  const [hovRow, setHovRow] = useState(null);
  const [bulkTaxId, setBulkTaxId] = useState(''); // v5.5.961 — bulk tax fix-up strip
  const [bulkProfileId, setBulkProfileId] = useState(''); // v5.7.34 — bulk tax profile apply

  // Ex-VAT net selling price — the same basis Inventory → Reports → Recipe GP
  // uses, so GP% can never disagree between the two screens.
  const netSell = useCallback((mi) => {
    const gross = mi?.pricing?.base ?? mi?.price ?? null;
    if (gross == null) return null;
    let taxRateId = mi.taxRateId ?? null;
    let taxOverrides = mi.taxOverrides ?? {};
    if (!taxRateId && mi.parentId) {
      const p = menuItems.find(x => String(x.id) === String(mi.parentId));
      if (p) { taxRateId = p.taxRateId ?? null; if (!Object.keys(taxOverrides).length) taxOverrides = p.taxOverrides ?? {}; }
    }
    return netOf(gross, resolveTaxRate({ taxRateId, taxOverrides }, taxRates || [], 'dine-in'));
  }, [menuItems, taxRates]);

  const [search,     setSearch]     = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [catFilter,  setCatFilter]  = useState('all');
  const [selItemId,  setSelItemId]  = useState(null);
  const [showArchived, setShowArchived] = useState(false);

  const allCats = useMemo(() => menuCategories.filter(c=>!c.isSpecial), [menuCategories]);

  const typeLabel = t => ({ simple:'Simple', modifiable:'Options', variants:'Has sizes', pizza:'Pizza', combo:'Combo', subitem:'Sub item' }[t]||t);
  const typeColor = t => ({ simple:'var(--t4)', modifiable:'var(--acc)', variants:'var(--grn)', pizza:'#f97316', combo:'#8b5cf6' }[t]||'var(--t4)');

  const archivedCount = useMemo(() => menuItems.filter(i => i.archived && !i.parentId).length, [menuItems]);

  // All top-level items, filtered and sorted by category then sortOrder
  const parents = useMemo(() => {
    if (showArchived) {
      let items = menuItems.filter(i => i.archived && !i.parentId);
      if (search.trim()) { const q=search.toLowerCase(); items=items.filter(i=>(i.menuName||i.name||'').toLowerCase().includes(q)); }
      return items.sort((a,b)=>(a.menuName||a.name||'').localeCompare(b.menuName||b.name||''));
    }
    // Sub-items view: show all sub-items (no parentId filter)
    let items = typeFilter === 'subitem'
      ? menuItems.filter(i => !i.archived && i.type === 'subitem')
      : menuItems.filter(i => !i.archived && !i.parentId);
    if (search.trim()) {
      const q = search.toLowerCase();
      items = items.filter(i => (i.menuName||i.name||'').toLowerCase().includes(q) || (i.description||'').toLowerCase().includes(q));
    }
    if (typeFilter !== 'all') items = items.filter(i => (i.type||'simple') === typeFilter);
    if (catFilter !== 'all')  items = items.filter(i => i.cat===catFilter||(i.cats||[]).includes(catFilter));
    // Sort by subGroup then sortOrder for sub-items, otherwise category order
    if (typeFilter === 'subitem') {
      return items.sort((a,b) => {
        const ga = a.subGroup||'', gb = b.subGroup||'';
        if (ga !== gb) return ga.localeCompare(gb);
        return (a.sortOrder??999)-(b.sortOrder??999);
      });
    }
    return items.sort((a,b) => {
      const ca = allCats.findIndex(c=>c.id===a.cat);
      const cb = allCats.findIndex(c=>c.id===b.cat);
      if (ca !== cb) return ca-cb;
      return (a.sortOrder??999)-(b.sortOrder??999);
    });
  }, [menuItems, allCats, search, typeFilter, catFilter, showArchived]);

  const variantsOf = pid => menuItems.filter(c=>c.parentId===pid&&!c.archived).sort((a,b)=>(a.sortOrder??999)-(b.sortOrder??999));
  const totalVariants = menuItems.filter(i=>!i.archived&&i.parentId).length;

  const addNewItem = () => {
    // v5.5.915: no arbitrary default category. It used to fall back to whichever root category
    // happened to be FIRST, so adding a product from the "All" view silently filed it under
    // something unrelated and nobody noticed until it turned up on the wrong screen. Adding
    // while a category is selected still lands in that category — that is the context you are
    // working in, not a guess — but from "All" the primary category is now left empty to choose.
    const defCat = catFilter!=='all' ? catFilter : '';
    // v5.5.949: auto-pick a free name — same dead-end fix as the Menus-tab addItem.
    const freshName = (() => { let n='New item', i=2; while (findDuplicateProductName(menuItems, n)) n=`New item ${i++}`; return n; })();
    const created = addMenuItem({ name:freshName, menuName:freshName, receiptName:freshName, kitchenName:freshName,
      type:'simple', cat:defCat, allergens:[], pricing:{base:0},
      assignedModifierGroups:[], assignedInstructionGroups:[], cats:[], sortOrder:999 });
    if (!created) { window.alert(`A product called "${freshName}" already exists — rename it before adding another.`); return; }
    markBOChange();
    setTimeout(()=>{ const last=useStore.getState().menuItems.slice(-1)[0]; if(last) setSelItemId(last.id); }, 30);
  };

  const addNewSpacer = () => {
    const defCat = catFilter!=='all' ? catFilter : (allCats.find(c=>!c.parentId)?.id||'');
    addMenuItem({ name:'Spacer', menuName:'', receiptName:'', kitchenName:'',
      type:'spacer', cat:defCat, allergens:[], pricing:{base:0},
      assignedModifierGroups:[], assignedInstructionGroups:[], cats:[], sortOrder:999,
      visibility:{ pos:true, kiosk:false, online:false, onlineDelivery:false } });
    markBOChange();
  };

  const addVariant = (parentId, cat, allergens, count) => {
    addMenuItem({ name:'New size', menuName:'New size', receiptName:'New size', kitchenName:'New size',
      type:'simple', parentId, cat, allergens:[...allergens], pricing:{base:0},
      assignedModifierGroups:[], assignedInstructionGroups:[], sortOrder:count });
    markBOChange();
    setTimeout(()=>{ const last=useStore.getState().menuItems.slice(-1)[0]; if(last) setSelItemId(last.id); }, 30);
  };

  const selItem = menuItems.find(i=>i.id===selItemId);

  // v5.5.813: ITEM · TYPE · PRICE · COST · GP% · MODS · ⚠ (handoff B5/B7 widths).
  // The handoff's mock had no Back Office sidebar; here the detail panel eats the
  // width the money columns were meant to fill. So COST + GP% show only while the
  // panel is closed — the list stays readable instead of scrolling sideways.
  const hdrSt = { fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em' };
  const showMoney = !selItem;
  const COL   = showMoney
    ? '26px minmax(200px,1fr) 100px 92px 84px 72px 88px 46px'
    : '26px minmax(150px,1fr) 96px 88px 84px 44px';
  const numSt = { fontVariantNumeric:'tabular-nums' };

  return (
    <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>

      {/* ── Left: items list ──────────────────────────────────────── */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', borderRight: selItem ? '1px solid var(--bdr)' : 'none' }}>

        {/* Toolbar */}
        <div style={{ padding:'10px 12px', borderBottom:'1px solid var(--bdr)', display:'flex', gap:8, alignItems:'center', flexWrap:'wrap', flexShrink:0 }}>
          <div style={{ position:'relative', flex:1, minWidth:160 }}>
            <span style={{ position:'absolute',left:9,top:'50%',transform:'translateY(-50%)',fontSize:12,color:'var(--t4)' }}>🔍</span>
            <input style={{ ...inp, paddingLeft:28 }} value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search all items…"/>
          </div>
          <select value={typeFilter} onChange={e=>setTypeFilter(e.target.value)} style={{ ...inp, width:'auto', cursor:'pointer', fontSize:11 }}>
            <option value="all">All types</option>
            <option value="simple">Simple</option>
            <option value="modifiable">Options (modifiable)</option>
            <option value="variants">Has sizes / variants</option>
            <option value="subitem">⊕ Sub items</option>
          </select>
          <select value={catFilter} onChange={e=>setCatFilter(e.target.value)} style={{ ...inp, width:'auto', cursor:'pointer', fontSize:11 }}>
            <option value="all">All categories</option>
            {allCats.map(c=><option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
          </select>
          <button onClick={()=>{setShowArchived(v=>!v);setSelItemId(null);}} style={{ padding:'7px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:showArchived?'var(--red-d)':'var(--bg3)', border:`1px solid ${showArchived?'var(--red-b)':'var(--bdr)'}`, color:showArchived?'var(--red)':'var(--t3)', fontSize:12, fontWeight:showArchived?700:400, flexShrink:0 }}>
            {showArchived ? '← Back to active' : `Archived${archivedCount>0?` (${archivedCount})`:''}`}
          </button>
          {!showArchived && <button onClick={addNewItem} style={{ padding:'7px 14px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:12, fontWeight:700, flexShrink:0 }}>+ Item</button>}
        </div>

        {/* Stats + legend (handoff B5) */}
        <div style={{ padding:'6px 12px', borderBottom:'1px solid var(--bdr)', fontSize:11, color:'var(--t3)', flexShrink:0, display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
          <span>{parents.length} items · {totalVariants} total sizes/variants</span>
          <span style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:14, fontSize:10.5, color:'var(--t4)' }}>
            <span style={{ display:'inline-flex', alignItems:'center', gap:5 }}>
              <span style={{ width:8, height:8, borderRadius:2, background:'var(--acc)' }}/>POS button colour
            </span>
            <span style={{ display:'inline-flex', alignItems:'center', gap:5 }}>
              <span style={{ background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', borderRadius:4, fontSize:9, fontWeight:800, padding:'1px 4px' }}>86</span>Out of stock
            </span>
          </span>
        </div>

        {/* v5.5.961: bulk tax fix-up. Peter priced the whole menu BEFORE creating tax
            rates, so every item sat with no rate and fixing them one-by-one through the
            editor's Tax tab was unworkable. This strip appears only while items are
            missing a rate: pick one, apply to all the gaps in a click. Items that
            already have a rate are never touched. */}
        {!showArchived && (() => {
          const missingTax = menuItems.filter(i => !i.archived && !i.taxRateId);
          if (missingTax.length === 0 || !(taxRates || []).length) return null;
          return (
            <div style={{ padding:'8px 12px', borderBottom:'1px solid var(--bdr)', background:'color-mix(in srgb, var(--amber, #F5A623) 12%, transparent)', display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', flexShrink:0 }}>
              <span style={{ fontSize:12, fontWeight:700, color:'var(--amber, #F5A623)' }}>⚠ {missingTax.length} item{missingTax.length===1?' has':'s have'} no tax rate</span>
              <select value={bulkTaxId} onChange={e=>setBulkTaxId(e.target.value)} style={{ ...inp, width:'auto', fontSize:11, cursor:'pointer' }}>
                <option value="">— pick the default rate —</option>
                {(taxRates||[]).map(t=><option key={t.id} value={t.id}>{t.name} ({t.rate}%)</option>)}
              </select>
              <button disabled={!bulkTaxId}
                onClick={()=>{
                  missingTax.forEach(i=>updateMenuItem(i.id,{ taxRateId: bulkTaxId }));
                  markBOChange();
                  const t=(taxRates||[]).find(r=>r.id===bulkTaxId);
                  showToast(`${t?.name||'Tax rate'} set on ${missingTax.length} item${missingTax.length===1?'':'s'}`,'success');
                }}
                style={{ padding:'6px 14px', borderRadius:8, cursor:bulkTaxId?'pointer':'not-allowed', fontFamily:'inherit', background:bulkTaxId?'var(--acc)':'var(--bg3)', border:'none', color:bulkTaxId?'#0b0c10':'var(--t4)', fontSize:12, fontWeight:800 }}>
                Apply to all {missingTax.length}
              </button>
              <span style={{ fontSize:10.5, color:'var(--t4)' }}>Only fills the gaps — items that already have a rate are untouched.</span>
            </div>
          );
        })()}

        {/* v5.7.34: bulk TAX PROFILE apply — the profiles sibling of the rate
            fix-up above. Two scopes: fill only the items with no profile, or
            stamp every active item (a US venue pointing its whole menu at one
            combined profile in a click). Writes item.taxProfileId only. */}
        {!showArchived && (() => {
          const profiles = (taxProfiles || []).filter(p => p.active !== false);
          if (!profiles.length) return null;
          const activeItems = menuItems.filter(i => !i.archived);
          const missingProfile = activeItems.filter(i => !i.taxProfileId);
          if (!activeItems.length) return null;
          const apply = (targets, label) => {
            targets.forEach(i => updateMenuItem(i.id, { taxProfileId: bulkProfileId }));
            markBOChange();
            const pName = profiles.find(p => p.id === bulkProfileId)?.name || 'Tax profile';
            showToast(`${pName} set on ${targets.length} item${targets.length===1?'':'s'} (${label})`, 'success');
          };
          return (
            <div style={{ padding:'8px 12px', borderBottom:'1px solid var(--bdr)', background:'color-mix(in srgb, var(--acc) 9%, transparent)', display:'flex', alignItems:'center', gap:10, flexWrap:'wrap', flexShrink:0 }}>
              <span style={{ fontSize:12, fontWeight:700, color:'var(--t2)' }}>Tax profile quick apply</span>
              <select value={bulkProfileId} onChange={e=>setBulkProfileId(e.target.value)} style={{ ...inp, width:'auto', fontSize:11, cursor:'pointer' }}>
                <option value="">— pick a profile —</option>
                {profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <button disabled={!bulkProfileId || !missingProfile.length}
                onClick={()=>apply(missingProfile, 'items without a profile')}
                style={{ padding:'6px 14px', borderRadius:8, cursor:(bulkProfileId&&missingProfile.length)?'pointer':'not-allowed', fontFamily:'inherit', background:(bulkProfileId&&missingProfile.length)?'var(--acc)':'var(--bg3)', border:'none', color:(bulkProfileId&&missingProfile.length)?'#0b0c10':'var(--t4)', fontSize:12, fontWeight:800 }}>
                Fill {missingProfile.length} without one
              </button>
              <button disabled={!bulkProfileId}
                onClick={()=>{ if (window.confirm(`Set this profile on ALL ${activeItems.length} items? Existing item profiles are replaced. Per-item legacy tax settings still take priority where set.`)) apply(activeItems, 'all items'); }}
                style={{ padding:'6px 14px', borderRadius:8, cursor:bulkProfileId?'pointer':'not-allowed', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr)', color:bulkProfileId?'var(--t1)':'var(--t4)', fontSize:12, fontWeight:800 }}>
                Apply to all {activeItems.length}
              </button>
              <span style={{ fontSize:10.5, color:'var(--t4)' }}>Categories and the venue default cover items with no profile of their own.</span>
            </div>
          );
        })()}

        {/* Column headers */}
        <div style={{ display:'grid', gridTemplateColumns:COL, gap:0, padding:'7px 12px', borderBottom:'2px solid var(--bdr)', background:'var(--bg2)', flexShrink:0, alignItems:'center' }}>
          <div/>
          <div style={hdrSt}>Item</div>
          <div style={hdrSt}>Type</div>
          <div style={{ ...hdrSt, textAlign:'right' }}>Price</div>
          {showMoney && <div style={{ ...hdrSt, textAlign:'right' }}>Cost</div>}
          {showMoney && <div style={{ ...hdrSt, textAlign:'right' }} title="Gross profit % — auto-calculated from the linked recipe, on the ex-VAT price">GP %</div>}
          <div style={{ ...hdrSt, textAlign:'center' }}>Mods</div>
          <div style={{ ...hdrSt, textAlign:'center' }} title="Allergens">⚠</div>
        </div>

        {/* Scrollable list */}
        <div style={{ flex:1, overflowY:'auto' }}>

          {/* ── Archived items view ── */}
          {showArchived && (
            <>
              {parents.length === 0 ? (
                <div style={{ textAlign:'center', padding:'48px', color:'var(--t4)', fontSize:13 }}>
                  <div style={{ fontSize:32, opacity:.12, marginBottom:12 }}>📦</div>
                  <div style={{ fontWeight:600, color:'var(--t3)' }}>No archived items</div>
                </div>
              ) : parents.map(item => {
                const isSel = selItemId === item.id;
                return (
                  <div key={item.id} onClick={()=>setSelItemId(isSel?null:item.id)}
                    style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 14px', cursor:'pointer',
                      background:isSel?'var(--acc-d)':'transparent', borderBottom:'1px solid var(--bdr)', transition:'background .1s' }}>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:13, fontWeight:600, color:isSel?'var(--acc)':'var(--t3)', textDecoration:'line-through', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {item.menuName||item.name}
                      </div>
                      <div style={{ fontSize:10, color:'var(--t4)', marginTop:2 }}>{item.type} · archived</div>
                    </div>
                    <button onClick={e=>{
                      e.stopPropagation();
                      updateMenuItem(item.id, { archived:false });
                      markBOChange();
                      showToast(`${item.menuName||item.name} restored`, 'success');
                      setSelItemId(null);
                    }} style={{ padding:'5px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--grn-d)', border:'1px solid var(--grn-b)', color:'var(--grn)', fontSize:11, fontWeight:700, flexShrink:0 }}>
                      Unarchive
                    </button>
                  </div>
                );
              })}
            </>
          )}

          {/* ── Sub-items flat list ── */}
          {!showArchived && typeFilter === 'subitem' && (
            <>
              {parents.length === 0 ? (
                <div style={{ textAlign:'center', padding:'48px', color:'var(--t4)', fontSize:13 }}>
                  <div style={{ fontSize:32, opacity:.12, marginBottom:12 }}>⊕</div>
                  <div style={{ fontWeight:600, color:'var(--t3)', marginBottom:6 }}>No sub-items yet</div>
                  <div style={{ fontSize:11, color:'var(--t4)', marginBottom:16, lineHeight:1.6 }}>Sub-items are modifier options — Whole Milk, Oat Milk, Chips etc.<br/>Create an item and set its type to "Sub item".</div>
                </div>
              ) : parents.map(item => {
                const isSel = selItemId === item.id;
                const price = item.pricing?.base ?? item.price ?? 0;
                return (
                  <div key={item.id} onClick={()=>setSelItemId(isSel?null:item.id)}
                    style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 14px', cursor:'pointer',
                      background:isSel?'var(--acc-d)':'transparent', borderBottom:'1px solid var(--bdr)', transition:'background .1s' }}>
                    {/* POS visibility toggle */}
                    <div onClick={e=>{e.stopPropagation();updateMenuItem(item.id,{soldAlone:!item.soldAlone});markBOChange();}}
                      title={item.soldAlone?'Visible on POS — click to hide':'Hidden from POS — click to show'}
                      style={{ width:32, height:18, borderRadius:9, background:item.soldAlone?'var(--grn)':'var(--bg5)', border:`1.5px solid ${item.soldAlone?'var(--grn)':'var(--bdr2)'}`, position:'relative', flexShrink:0, cursor:'pointer', transition:'all .2s' }}>
                      <div style={{ width:13, height:13, borderRadius:'50%', background:'#fff', position:'absolute', top:2, left:item.soldAlone?16:2, transition:'left .2s', boxShadow:'0 1px 3px #0003' }}/>
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontSize:13, fontWeight:600, color:isSel?'var(--acc)':'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {item.menuName||item.name}
                      </div>
                      <div style={{ fontSize:10, color:item.soldAlone?'var(--grn)':'var(--t4)', marginTop:1 }}>
                        {item.soldAlone ? '✓ Visible on POS' : 'Modifier only — not on POS'}
                      </div>
                    </div>
                    <span style={{ fontSize:12, fontWeight:700, color:'var(--acc)', fontFamily:'var(--font-mono)', flexShrink:0 }}>
                      {price>0?`${money(price)}`:'Free'}
                    </span>
                  </div>
                );
              })}
            </>
          )}

          {typeFilter !== 'subitem' && parents.length === 0 && (
            <div style={{ textAlign:'center', padding:'48px', color:'var(--t4)', fontSize:13 }}>
              <div style={{ fontSize:36, opacity:.12, marginBottom:12 }}>📋</div>
              <div style={{ fontWeight:600, color:'var(--t3)', marginBottom:8 }}>No items found</div>
              <button onClick={addNewItem} style={{ padding:'8px 18px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:13, fontWeight:700 }}>+ Add first item</button>
            </div>
          )}

          {typeFilter !== 'subitem' && parents.map(item => {
            const variants = variantsOf(item.id);
            const hasVars  = variants.length > 0 || (item.type||'simple')==='variants';
            const isSel    = selItemId === item.id;
            const is86     = eightySixIds.includes(item.id);
            const price    = item.pricing?.base ?? item.price ?? 0;
            const fromP    = hasVars && variants.length > 0 ? Math.min(...variants.map(v=>v.pricing?.base??v.price??0)) : price;
            const cat      = allCats.find(c=>c.id===item.cat);
            const color    = cat?.color || 'var(--acc)';
            const modCount = (item.assignedModifierGroups||[]).length + (item.assignedInstructionGroups||[]).length;
            const allergyN = (item.allergens||[]).length;
            // v5.5.813: recipe-derived plate cost + GP% on the ex-VAT net price.
            const cost     = recipeCosts ? recipeCosts[String(item.id)] ?? null : null;
            const netPrice = cost != null ? netSell(item) : null;
            const gp       = (cost != null && netPrice != null && netPrice > 0)
              ? Math.round(((netPrice - cost) / netPrice) * 100) : null;

            return (
              <div key={item.id}>
                {/* Parent row */}
                <div onClick={()=>setSelItemId(isSel?null:item.id)}
                  onMouseEnter={()=>setHovRow(item.id)} onMouseLeave={()=>setHovRow(null)}
                  style={{ display:'grid', gridTemplateColumns:COL, gap:0, padding:'9px 12px 9px 9px', cursor:'pointer', alignItems:'center',
                    // B3: selection always wins over the out-of-stock treatment.
                    borderLeft:`3px solid ${isSel?'var(--acc)':is86?'var(--red-b)':'transparent'}`,
                    background:isSel?'var(--acc-d)':is86?'var(--red-d)':(hovRow===item.id?'var(--bg2)':'transparent'),
                    borderBottom:item.type==='subitem'&&item.soldAlone?'none':'1px solid var(--bdr)', transition:'background .1s' }}>
                  <div style={{ width:9, height:9, borderRadius:'50%', background:color, flexShrink:0, boxShadow:'inset 0 0 0 1px rgba(0,0,0,.08)' }}/>
                  {/* B6: two-line identity — name, then category glyph + name */}
                  <div style={{ minWidth:0, paddingRight:10 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:7, minWidth:0 }}>
                      <span title={item.menuName||item.name} style={{ fontSize:13.5, fontWeight:700, color:isSel?'var(--acc)':is86?'var(--red)':'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {item.menuName||item.name}
                      </span>
                      {is86 && !isSel && <span style={{ flexShrink:0, fontSize:9, fontWeight:800, padding:'1px 5px', borderRadius:5, background:'var(--red-d)', color:'var(--red)', border:'1px solid var(--red-b)' }}>86'd</span>}
                    </div>
                    {cat ? (
                      <div style={{ display:'flex', alignItems:'center', gap:5, marginTop:2, minWidth:0 }}>
                        <CatGlyph cat={cat} size={14}/>
                        <span style={{ fontSize:11, color:'var(--t4)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{cat.label}</span>
                      </div>
                    ) : item.type === 'subitem' ? (
                      <div style={{ fontSize:11, color:'var(--t4)', marginTop:2 }}>Modifier option</div>
                    ) : (
                      <div style={{ fontSize:11, color:'var(--t4)', marginTop:2, fontStyle:'italic' }}>No category</div>
                    )}
                  </div>
                  {/* B4: TYPE as a quiet neutral pill */}
                  <span>
                    <span style={{ display:'inline-flex', alignItems:'center', gap:4, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t3)', borderRadius:6, padding:'2px 8px', fontSize:11, fontWeight:600 }}>
                      {(item.type||'simple')==='modifiable' && <span style={{ fontSize:9 }}>◈</span>}
                      {typeLabel(item.type||'simple')}
                    </span>
                  </span>
                  {/* B1: price is ink, tabular, right-aligned — no category colour */}
                  <span style={{ ...numSt, fontSize:13, fontWeight:700, color:'var(--t1)', textAlign:'right' }}>
                    {hasVars&&variants.length>0 ? `from ${money(fromP)}` : `${money(price)}`}
                  </span>
                  {/* B7: COST + GP% from the linked recipe (read-only, derived) */}
                  {showMoney && (
                    <span style={{ ...numSt, fontSize:12, color:'var(--t3)', textAlign:'right' }}>
                      {recipeCosts == null ? '' : cost != null ? money(cost)
                        : <span title="Cost comes from the linked recipe — add one in Produce → Recipes" style={{ fontSize:10.5, fontWeight:600, color:'var(--amber, #F5A623)' }}>No recipe</span>}
                    </span>
                  )}
                  {showMoney && (
                    <span style={{ ...numSt, fontSize:12.5, fontWeight:700, textAlign:'right', color: gp == null ? 'var(--t4)' : gp >= 62 ? 'var(--grn)' : 'var(--amber, #F5A623)' }}>
                      {recipeCosts == null ? '' : gp == null ? '—' : `${gp}%`}
                    </span>
                  )}
                  {/* B2: MODS as a neutral chip, hidden at zero */}
                  <span style={{ textAlign:'center' }}>
                    {modCount>0 && (
                      <span style={{ display:'inline-flex', alignItems:'center', gap:4, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t3)', borderRadius:6, padding:'2px 7px', fontSize:11, fontWeight:600 }}>
                        ⊕ {modCount}
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize:10.5, textAlign:'center', color:allergyN>0?'var(--t3)':'var(--t4)' }}>{allergyN>0?allergyN:''}</span>
                </div>

                {/* soldAlone toggle for sub-items */}
                {item.type==='subitem' && (
                  <div onClick={e=>e.stopPropagation()} style={{ padding:'6px 12px 6px 28px', background:item.soldAlone?'#16a34a11':'var(--bg3)', borderBottom:'1px solid var(--bdr)', display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
                    {/* Sliding toggle */}
                    <button onClick={()=>{ updateMenuItem(item.id,{soldAlone:!item.soldAlone,cat:item.soldAlone?'':item.cat}); markBOChange(); }}
                      style={{ display:'flex', alignItems:'center', gap:8, background:'none', border:'none', cursor:'pointer', padding:0, fontFamily:'inherit' }}>
                      <div style={{ width:36, height:20, borderRadius:10, background:item.soldAlone?'var(--grn)':'var(--bg5)', border:`1.5px solid ${item.soldAlone?'var(--grn)':'var(--bdr2)'}`, position:'relative', transition:'all .2s', flexShrink:0 }}>
                        <div style={{ width:14, height:14, borderRadius:'50%', background:'#fff', position:'absolute', top:2, left:item.soldAlone?18:2, transition:'left .2s', boxShadow:'0 1px 3px #0003' }}/>
                      </div>
                      <span style={{ fontSize:11, fontWeight:700, color:item.soldAlone?'var(--grn)':'var(--t4)' }}>
                        {item.soldAlone?'Sold alone — visible on POS':'Also sell standalone'}
                      </span>
                    </button>
                    {item.soldAlone && (
                      <div style={{ display:'flex', alignItems:'center', gap:6, marginLeft:'auto' }}>
                        <span style={{ fontSize:10, color:'var(--t3)' }}>Category:</span>
                        <select value={item.cat||''} onChange={e=>{updateMenuItem(item.id,{cat:e.target.value}); markBOChange();}}
                          style={{ ...inp, width:'auto', fontSize:11, padding:'3px 8px', color:item.cat?'var(--t1)':'var(--t4)', cursor:'pointer' }}>
                          <option value="">— pick a category —</option>
                          {allCats.map(c=><option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
                        </select>
                        {item.cat && <span style={{ fontSize:10, fontWeight:600, color:'var(--grn)' }}>✓ Will show on POS</span>}
                      </div>
                    )}
                  </div>
                )}
                {/* Variant children — always visible */}
                {hasVars && (
                  <div style={{ background:'var(--bg3)' }}>
                    {variants.map(v => {
                      const vp   = v.pricing||{base:v.price||0};
                      const vSel = selItemId===v.id;
                      const vAll = (v.allergens||[]).length;
                      return (
                        <div key={v.id} onClick={e=>{e.stopPropagation();setSelItemId(vSel?null:v.id);}}
                          style={{ display:'grid', gridTemplateColumns:COL, gap:0, padding:'6px 12px 6px 25px', cursor:'pointer', alignItems:'center',
                            borderLeft:`3px solid ${vSel?'var(--acc)':'transparent'}`,
                            background:vSel?'var(--acc-d)':'transparent', borderBottom:'1px solid var(--bdr)', transition:'background .1s' }}>
                          <div/>
                          <div style={{ display:'flex', alignItems:'center', gap:6, minWidth:0 }}>
                            <span style={{ fontSize:10, color:'var(--t4)', flexShrink:0, lineHeight:1 }}>└</span>
                            <span title={v.menuName||v.name} style={{ fontSize:12.5, fontWeight:600, color:vSel?'var(--acc)':'var(--t2)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{v.menuName||v.name}</span>
                          </div>
                          <span>
                            <span style={{ display:'inline-flex', alignItems:'center', background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t4)', borderRadius:6, padding:'1px 7px', fontSize:10, fontWeight:600 }}>size</span>
                          </span>
                          <span style={{ ...numSt, fontSize:12.5, fontWeight:700, color:'var(--t1)', textAlign:'right' }}>{money((vp.base||0))}</span>
                          {showMoney && <span/>}
                          {showMoney && <span/>}
                          <span/>
                          <span style={{ fontSize:10.5, textAlign:'center', color:vAll>0?'var(--t3)':'var(--t4)' }}>{vAll>0?vAll:''}</span>
                        </div>
                      );
                    })}
                    {/* Add size button */}
                    <div style={{ padding:'5px 12px 5px 28px', borderBottom:'1px solid var(--bdr)' }}>
                      <button onClick={e=>{e.stopPropagation();addVariant(item.id,item.cat,item.allergens||[],variants.length);if(item.type!=='variants')updateMenuItem(item.id,{type:'variants'});}}
                        style={{ fontSize:10, fontWeight:600, color, background:'none', border:`1px dashed ${color}55`, borderRadius:6, padding:'2px 10px', cursor:'pointer', fontFamily:'inherit' }}>
                        + Add size
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Right: item editor ────────────────────────────────────── */}
      {selItem && (
        <ItemEditor
          key={selItem.id}
          item={selItem}
          allCategories={allCats}
          onUpdate={patch=>{ updateMenuItem(selItem.id,patch); markBOChange(); }}
          onArchive={async ()=>{ const id=selItem.id; setSelItemId(null); markBOChange(); if (await archiveMenuItem(id)) showToast('Archived','info'); }}
          onClone={()=>cloneItem(selItem,menuItems,addMenuItem,updateMenuItem,markBOChange,showToast,setSelItemId)}
          onClose={()=>setSelItemId(null)}
          is86={eightySixIds.includes(selItem.id)}
          onToggle86={()=>toggle86(selItem.id)}
          menuItems={menuItems}
          addMenuItem={addMenuItem}
          updateMenuItem={updateMenuItem}
          markBOChange={markBOChange}
          showToast={showToast}
        />
      )}
    </div>
  );
}



// ═══════════════════════════════════════════════════════════════════════════
// ITEM EDITOR
// ═══════════════════════════════════════════════════════════════════════════
// ── Item image upload ─────────────────────────────────────────────────────────
function ItemImageUpload({ item, onUpdate, markBOChange, showToast }) {
  const [uploading, setUploading] = useState(false);
  const [locId, setLocId] = useState(null);

  useEffect(() => {
    getLocationId().then(id => { if (id) setLocId(id); }).catch(() => {});
  }, []);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return showToast('Please select an image file', 'error');
    if (file.size > 5 * 1024 * 1024) return showToast('Image must be under 5MB', 'error');

    // Re-resolve locId fresh every time — don't rely on stale state.
    // 'loc-demo' is truthy, so it has to be rejected explicitly or the storage
    // path and the row filter below both get written against a fake location.
    const resolvedLocId = locId || await getLocationId().catch(() => null);
    if (!resolvedLocId || resolvedLocId === 'loc-demo') return showToast('Could not resolve location', 'error');

    setUploading(true);
    const { url, error } = await uploadProductImage(item.id, resolvedLocId, file);
    setUploading(false);

    if (error) {
      console.error('Image upload failed:', error);
      showToast('Upload failed — check connection', 'error');
      return;
    }

    const prevImage = item.image ?? null;
    // 1. Update local store state
    onUpdate({ image: url });

    // 2. Directly write image to Supabase — targeted UPDATE, no full upsert needed
    // This bypasses any store/locationId timing issues
    if (supabase) {
      const { data, error: dbErr } = await supabase
        .from('menu_items')
        .update({ image: url, updated_at: new Date().toISOString() })
        .eq('id', item.id)
        .eq('location_id', resolvedLocId)
        .select('id');
      // Same two traps as archiveVariantRow: `id` alone is cross-tenant, and an
      // update that matched NO rows comes back as a plain success with an empty body.
      const err = dbErr || (!data?.length
        ? new Error('Image update matched 0 rows — RLS blocked it or the row is scoped to another location')
        : null);
      reportSave('item image', err);
      if (err) {
        onUpdate({ image: prevImage });
        showToast('Image was NOT saved — the tills still show the old one. Check you\'re signed in, then try again', 'error');
        return;
      }
    }

    markBOChange();
    showToast('Image uploaded', 'success');
  };

  const handleRemove = async () => {
    if (!confirm('Remove this image?')) return;
    const resolvedLocId = locId || await getLocationId().catch(() => null);
    if (!resolvedLocId || resolvedLocId === 'loc-demo') return showToast('Could not resolve location', 'error');

    const prevImage = item.image ?? null;
    onUpdate({ image: null });

    // The row is the record — clear it FIRST. Deleting the storage object before a
    // failed/blocked UPDATE would leave every surface pointing at a dead URL.
    if (supabase) {
      const { data, error } = await supabase
        .from('menu_items')
        .update({ image: null, updated_at: new Date().toISOString() })
        .eq('id', item.id)
        .eq('location_id', resolvedLocId)
        .select('id');
      const err = error || (!data?.length
        ? new Error('Image removal matched 0 rows — RLS blocked it or the row is scoped to another location')
        : null);
      reportSave('item image', err);
      if (err) {
        onUpdate({ image: prevImage });
        showToast('Image was NOT removed — it is still live on POS, kiosk and online. Check you\'re signed in, then try again', 'error');
        return;
      }
    }
    // Best-effort: probes four extensions, so most of these 404 by design.
    await deleteProductImage(item.id, resolvedLocId);

    markBOChange();
    showToast('Image removed', 'info');
  };

  return (
    <div>
      <span style={{ fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', display:'block', marginBottom:6 }}>
        Product image
        <span style={{ fontWeight:400, textTransform:'none', letterSpacing:0, marginLeft:4 }}>(POS, kiosk &amp; online ordering)</span>
      </span>

      {item.image ? (
        <div style={{ position:'relative', borderRadius:12, overflow:'hidden', border:'1px solid var(--bdr)', marginBottom:6 }}>
          <img src={item.image} alt={item.name} style={{ width:'100%', height:140, objectFit:'cover', display:'block' }} />
          <div style={{ position:'absolute', inset:0, background:'linear-gradient(to top, rgba(0,0,0,.6) 0%, transparent 60%)', display:'flex', alignItems:'flex-end', justifyContent:'space-between', padding:'10px 12px' }}>
            <span style={{ fontSize:11, color:'rgba(255,255,255,.8)', fontWeight:600 }}>✓ Image set</span>
            <div style={{ display:'flex', gap:6 }}>
              <label style={{ padding:'5px 10px', borderRadius:7, background:'rgba(255,255,255,.15)', color:'#fff', fontSize:11, fontWeight:600, cursor:'pointer', border:'1px solid rgba(255,255,255,.3)' }}>
                Replace
                <input type="file" accept="image/*" style={{ display:'none' }} onChange={handleFile} />
              </label>
              <button onClick={handleRemove} style={{ padding:'5px 10px', borderRadius:7, background:'rgba(239,68,68,.3)', color:'#fff', fontSize:11, fontWeight:600, cursor:'pointer', border:'1px solid rgba(239,68,68,.5)', fontFamily:'inherit' }}>
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : (
        <label style={{
          display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
          gap:6, padding:'20px 16px', borderRadius:12, cursor:'pointer',
          border:'2px dashed var(--bdr2)', background:'var(--bg3)',
          transition:'border-color .15s',
        }}
          onMouseEnter={e=>e.currentTarget.style.borderColor='var(--acc)'}
          onMouseLeave={e=>e.currentTarget.style.borderColor='var(--bdr2)'}
        >
          {uploading ? (
            <span style={{ fontSize:12, color:'var(--t3)' }}>Uploading…</span>
          ) : (
            <>
              <span style={{ fontSize:24 }}>🖼</span>
              <span style={{ fontSize:12, fontWeight:600, color:'var(--t2)' }}>Click to upload image</span>
              <span style={{ fontSize:10, color:'var(--t4)' }}>JPG, PNG or WebP · max 5MB</span>
            </>
          )}
          <input type="file" accept="image/*" style={{ display:'none' }} onChange={handleFile} disabled={uploading} />
        </label>
      )}
    </div>
  );
}

function ItemEditor({ item, allCategories, onUpdate, onArchive, onClone, onClose, is86, onToggle86, menuItems, addMenuItem, updateMenuItem, markBOChange, showToast }) {
  const { modifierGroupDefs, instructionGroupDefs } = useStore();
  const p        = item.pricing || { base: item.price || 0 };
  const isSub    = item.type === 'subitem';
  const isPizza  = item.type === 'pizza';
  const rootCats = allCategories.filter(c => !c.parentId);
  const subCats  = allCategories.filter(c =>  c.parentId);

  const [sec, setSec]             = useState('details');  // always open on Details (was 'flow' for products)
  const [modSearch, setModSearch] = useState('');
  const [instSearch, setInstSearch] = useState('');
  const [showAllCats, setShowAllCats] = useState(false);  // v5.5.813 — "Also in" chip cap
  const [dragModIdx, setDragModIdx] = useState(null);
  const [overModIdx, setOverModIdx] = useState(null);
  const [dragInstIdx, setDragInstIdx] = useState(null);
  const [overInstIdx, setOverInstIdx] = useState(null);

  const f   = (k,v) => onUpdate({ [k]: v });
  const fp  = (k,v) => onUpdate({ pricing: { ...p, [k]: v===''?null:parseFloat(v)||0 }, ...(k==='base'?{price:parseFloat(v)||0}:{}) });

  // ── Duplicate-name guard (v5.5.797) ────────────────────────────────────────
  // The POS-button-name input is draft-buffered (commit on blur / Enter) so a
  // rename that collides with another live top-level product can be refused
  // with an inline error, without blocking keystrokes mid-typing (e.g. typing
  // "Coke Zero" transiently passes through "Coke"). Variants/sub-items are
  // exempt — sizes legitimately repeat names across parents. Committing also
  // means the v5.5.796 modifier-group rename cascade fires once per rename,
  // not once per keystroke.
  const [nameDraft, setNameDraft] = useState(null);
  useEffect(() => { setNameDraft(null); }, [item.id]);
  const nameGuarded = !item.parentId && !['subitem','spacer'].includes(item.type || 'simple');
  const nameDup = (nameDraft != null && nameGuarded) ? findDuplicateProductName(menuItems, nameDraft, item.id) : null;
  const commitName = () => {
    if (nameDraft == null) return;
    if (nameGuarded && findDuplicateProductName(menuItems, nameDraft, item.id)) return; // blocked — inline error stays visible
    f('menuName', nameDraft);
    setNameDraft(null);
  };

  // ── Variants ───────────────────────────────────────────────────────────────
  const variants = menuItems.filter(c => c.parentId===item.id && !c.archived)
    .sort((a,b) => (a.sortOrder??999)-(b.sortOrder??999));
  const isParent = variants.length > 0;

  const addVariant = () => {
    addMenuItem({ name:'New size', menuName:'New size', receiptName:'New size', kitchenName:'New size',
      type:'simple', parentId:item.id, cat:item.cat, allergens:[...item.allergens||[]],
      pricing:{ base:0, dineIn:null, takeaway:null, collection:null, delivery:null },
      assignedModifierGroups:[], assignedInstructionGroups:[], sortOrder:variants.length });
    if (item.type !== 'variants') onUpdate({ type:'variants' });
    markBOChange();
  };
  const updVariant   = (id, patch) => { updateMenuItem(id, patch); markBOChange(); };
  const removeVariant = async id => {
    const removed = variants.find(v => v.id === id);
    updateMenuItem(id, { archived: true, parentId: null });
    markBOChange();
    const { error } = await archiveVariantRow(id);
    if (error) {
      // Nothing was archived — the variant returns on the next config load and
      // every other till carries on selling it. Put it back rather than lie.
      updateMenuItem(id, { archived: false, parentId: removed?.parentId ?? item.id });
      showToast(`"${removed?.menuName || removed?.name || 'Variant'}" was NOT removed — it is still on sale. Check you're signed in, then try again`, 'error');
      return;
    }
    showToast('Variant removed', 'info');
    if (variants.filter(v => v.id !== id).length === 0) onUpdate({ type: 'simple' });
  };
  const reorderVariants = (from, to) => {
    const arr = [...variants]; const [moved] = arr.splice(from, 1); arr.splice(to, 0, moved);
    arr.forEach((v,i) => { if ((v.sortOrder??999) !== i) updateMenuItem(v.id, { sortOrder:i }); });
    markBOChange();
  };

  // ── Modifier assignment ────────────────────────────────────────────────────
  const assignedMods = item.assignedModifierGroups || [];
  const addMod    = gid => { if (assignedMods.find(ag=>ag.groupId===gid)) return; onUpdate({ assignedModifierGroups:[...assignedMods,{groupId:gid}] }); markBOChange(); setModSearch(''); };
  const removeMod = gid => { onUpdate({ assignedModifierGroups:assignedMods.filter(ag=>ag.groupId!==gid) }); markBOChange(); };
  const updateMod = (gid,patch) => { onUpdate({ assignedModifierGroups:assignedMods.map(ag=>ag.groupId===gid?{...ag,...patch}:ag) }); markBOChange(); };
  const reorderMods = (from, to) => {
    const arr = [...assignedMods]; const [moved] = arr.splice(from,1); arr.splice(to,0,moved);
    onUpdate({ assignedModifierGroups:arr }); markBOChange();
  };

  // ── Instruction assignment ─────────────────────────────────────────────────
  // Shape-tolerant: accepts legacy ['gid', ...] strings OR new [{groupId, min?}] objects.
  // On any write we normalise to the object shape, so old data auto-upgrades next save.
  const assignedInst = (item.assignedInstructionGroups || []).map(e => typeof e === 'string' ? { groupId: e } : e);
  const hasInst     = gid => assignedInst.some(a => a.groupId === gid);
  const addInst    = gid => { if (hasInst(gid)) return; onUpdate({ assignedInstructionGroups:[...assignedInst, { groupId: gid }] }); markBOChange(); setInstSearch(''); };
  const removeInst = gid => { onUpdate({ assignedInstructionGroups:assignedInst.filter(a=>a.groupId!==gid) }); markBOChange(); };
  const updateInst = (gid, patch) => { onUpdate({ assignedInstructionGroups:assignedInst.map(a=>a.groupId===gid?{...a,...patch}:a) }); markBOChange(); };
  const reorderInst = (from, to) => {
    const arr = [...assignedInst]; const [moved] = arr.splice(from,1); arr.splice(to,0,moved);
    onUpdate({ assignedInstructionGroups:arr }); markBOChange();
  };

  // ── v5.5.948: ONE combined flow — instructions sortable AMONG modifier groups ──
  // The Flow tab used to render mods then instructions as two fixed blocks, so a
  // cooking preference could never be dragged above a modifier group. The combined
  // order lives on item.optionGroupOrder (menu_items.option_group_order) and every
  // surface renders through the same lib/optionFlow.js rule. Dragging also rewrites
  // the two per-kind arrays so anything still reading them alone stays consistent.
  const flowEntries = orderOptionFlow(item.optionGroupOrder, assignedMods, assignedInst, (x) => String(x.groupId));
  const reorderFlow = (from, to) => {
    const arr = [...flowEntries]; const [moved] = arr.splice(from, 1); arr.splice(to, 0, moved);
    onUpdate({
      optionGroupOrder: arr.map(e => e.id),
      assignedModifierGroups: arr.filter(e => e.kind === 'mod').map(e => e.g),
      assignedInstructionGroups: arr.filter(e => e.kind === 'inst').map(e => e.g),
    });
    markBOChange();
  };

  // ── Filtered search lists ──────────────────────────────────────────────────
  const filteredMods = (modifierGroupDefs||[]).filter(g =>
    !assignedMods.find(ag=>ag.groupId===g.id) &&
    (modSearch==='' || (g.name||'').toLowerCase().includes(modSearch.toLowerCase()))
  );
  const filteredInst = (instructionGroupDefs||[]).filter(g =>
    !hasInst(g.id) &&
    (instSearch==='' || (g.name||'').toLowerCase().includes(instSearch.toLowerCase()))
  );

  const SECS = [
    { id:'details',   label:'Details' },
    !isSub && { id:'flow', label:`Flow${isParent?` · sizes`:''}${assignedMods.length>0?` · ${assignedMods.length} mods`:''}` },
    !isSub && { id:'variants',  label:`Sizes${isParent?` (${variants.length})`:''}` },
    !isSub && { id:'modifiers', label:`Modifiers${assignedMods.length>0?` (${assignedMods.length})`:''}` },
    { id:'pricing',   label:'Pricing' },
    { id:'tax',       label:`Tax${item.taxRateId ? ' ✓' : ''}` },
    { id:'allergens', label:`Allergens & dietary${((item.allergens||[]).length + (item.tags||[]).length)>0?` (${(item.allergens||[]).length + (item.tags||[]).length})`:''}` },
    isPizza && { id:'pizza', label:'Pizza' },
  ].filter(Boolean);

  const lbl = { fontSize:10, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', display:'block', marginBottom:5 };

  return (
    <div style={{ width:420, borderLeft:'1px solid var(--bdr)', display:'flex', flexDirection:'column', overflow:'hidden', background:'var(--bg1)', flexShrink:0 }}>

      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div style={{ padding:'12px 16px 0', borderBottom:'1px solid var(--bdr)', flexShrink:0, background:'var(--bg1)' }}>
        <div style={{ display:'flex', alignItems:'flex-start', gap:8, marginBottom:10 }}>
          <div style={{ flex:1, minWidth:0 }}>
            {/* v5.5.813 (handoff marker 7): out-of-stock is labelled, not just a
                bare red number, so the state is unambiguous at a glance. */}
            <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
              <div style={{ fontSize:14, fontWeight:800, color:'var(--t1)', lineHeight:1.3, minWidth:0, overflow:'hidden', textOverflow:'ellipsis' }}>{item.menuName||item.name}</div>
              {is86 && (
                <span style={{ display:'inline-flex', alignItems:'center', gap:5, background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', borderRadius:999, padding:'2px 9px', fontSize:10, fontWeight:800, whiteSpace:'nowrap', flexShrink:0 }}>
                  <span style={{ width:5, height:5, borderRadius:'50%', background:'var(--red)' }}/>86 · Out of stock
                </span>
              )}
            </div>
            <div style={{ display:'flex', gap:5, marginTop:4, flexWrap:'wrap' }}>
              {[['simple','Simple'],['modifiable','Modifiable'],['variants','Has sizes'],['combo','Combo'],['subitem','Sub item']].map(([v,l]) => {
                const act = (item.type||'simple')===v || (v==='variants'&&isParent&&item.type!=='pizza');
                return <button key={v} onClick={()=>f('type',v)} style={{ padding:'2px 7px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', fontSize:9, fontWeight:act?700:400, border:`1px solid ${act?'var(--acc)':'var(--bdr)'}`, background:act?'var(--acc-d)':'var(--bg3)', color:act?'var(--acc)':'var(--t4)' }}>{l}</button>;
              })}
            </div>
          </div>
          <div style={{ display:'flex', gap:5, flexShrink:0 }}>
            <button onClick={onToggle86} style={{ fontSize:9, padding:'3px 8px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', border:`1px solid ${is86?'var(--grn-b)':'var(--red-b)'}`, background:is86?'var(--grn-d)':'var(--red-d)', color:is86?'var(--grn)':'var(--red)', fontWeight:700 }}>{is86?'Un-86':'86'}</button>
            <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--t4)', cursor:'pointer', fontSize:18, lineHeight:1 }}>×</button>
          </div>
        </div>
        {/* v5.5.813 (handoff marker 8): the tab strip still scrolls, but the
            scrollbar is hidden and a right edge-fade hints at more tabs. */}
        <style>{`.mm-tabs::-webkit-scrollbar{display:none}`}</style>
        <div style={{ position:'relative' }}>
        <div className="mm-tabs" style={{ display:'flex', gap:0, marginBottom:'-1px', overflowX:'auto', scrollbarWidth:'none', paddingRight:30 }}>
          {SECS.map(s => (
            <button key={s.id} onClick={()=>setSec(s.id)} style={{ padding:'8px 12px', cursor:'pointer', fontFamily:'inherit', border:'none', borderBottom:`2px solid ${sec===s.id?'var(--acc)':'transparent'}`, background:'transparent', color:sec===s.id?'var(--acc)':'var(--t4)', fontSize:11, fontWeight:sec===s.id?700:400, whiteSpace:'nowrap', flexShrink:0, transition:'color .12s' }}>{s.label}</button>
          ))}
        </div>
        <div style={{ position:'absolute', right:0, top:0, bottom:1, width:38, pointerEvents:'none',
          background:'linear-gradient(90deg, transparent, var(--bg1) 72%)' }}/>
        </div>
      </div>

      {/* ── Content ─────────────────────────────────────────────────────── */}
      <div style={{ flex:1, overflowY:'auto', padding:'16px' }}>

        {/* ════ DETAILS ════════════════════════════════════════════════════ */}
        {sec==='details' && (
          <div style={{ display:'flex', flexDirection:'column', gap:14 }}>

            <div>
              <span style={lbl}>POS button name</span>
              <input style={{ ...inp, ...(nameDup ? { border:'1.5px solid var(--red-b)' } : {}) }}
                value={nameDraft ?? (item.menuName||'')}
                onChange={e=>setNameDraft(e.target.value)}
                onBlur={commitName}
                onKeyDown={e=>{ if (e.key==='Enter') e.currentTarget.blur(); }}
                placeholder="Name shown on POS button"/>
              {nameDup && (
                <div style={{ fontSize:11, color:'var(--red)', marginTop:4, fontWeight:600 }}>
                  A product called “{nameDup.menuName || nameDup.name}” already exists
                </div>
              )}
            </div>

            {!isSub && (
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
                <div><span style={lbl}>Receipt name</span><input style={inp} value={item.receiptName||''} onChange={e=>f('receiptName',e.target.value)} placeholder="Same as above"/></div>
                <div><span style={lbl}>Kitchen / KDS</span><input style={inp} value={item.kitchenName||''} onChange={e=>f('kitchenName',e.target.value)} placeholder="Same as above"/></div>
              </div>
            )}

            {/* v5.5.28: description is editable for sub-items too. The text shows on the
                kiosk modifier picker when the option matches this sub-item by name. */}
            <div>
              <span style={lbl}>Description <span style={{ fontWeight:400, textTransform:'none', letterSpacing:0 }}>{isSub ? '(shown in modifier picker on kiosk)' : '(kiosk & online)'}</span></span>
              <textarea style={{ ...inp, resize:'none', height:56 }} value={item.description||''} onChange={e=>f('description',e.target.value)} placeholder={isSub ? 'Brief description shown when this sub-item appears in a modifier group…' : 'Brief description shown to customers…'}/>
            </div>

            <ItemImageUpload item={item} onUpdate={onUpdate} markBOChange={markBOChange} showToast={showToast} />

            <div>
              <span style={lbl}>Primary category</span>
              <select value={item.cat||''} onChange={e=>f('cat',e.target.value)} style={{ ...inp, cursor:'pointer' }}>
                <option value="">— none —</option>
                {rootCats.map(c=><optgroup key={c.id} label={`${c.icon} ${c.label}`}><option value={c.id}>{c.icon} {c.label}</option>{subCats.filter(s=>s.parentId===c.id).map(s=><option key={s.id} value={s.id}>  └ {s.label}</option>)}</optgroup>)}
              </select>
            </div>

            {/* v5.5.813 (handoff marker 9): with 26 categories this list ran ~6 rows
                and pushed Sharing + Lock pricing below the fold. Capped at 9 with a
                "+ N more" toggle. Unlike the mock these chips are TOGGLES, not a
                read-only list — so selected chips always sort first and stay
                visible, and the toggle only hides unselected ones. Nothing becomes
                unreachable. */}
            {(() => {
              const chipCats = [...rootCats, ...subCats].filter(c => c.id !== item.cat);
              const isOn = c => (item.cats || []).includes(c.id);
              const ordered = [...chipCats.filter(isOn), ...chipCats.filter(c => !isOn(c))];
              const shown = showAllCats ? ordered : ordered.slice(0, 9);
              const hidden = ordered.length - shown.length;
              return (
                <div>
                  <span style={lbl}>Also in</span>
                  <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
                    {shown.map(c=>{
                      const on = isOn(c);
                      return <button key={c.id} onClick={()=>{const cur=item.cats||[];onUpdate({cats:on?cur.filter(id=>id!==c.id):[...cur,c.id]});}} style={{ padding:'2px 7px', borderRadius:10, cursor:'pointer', fontFamily:'inherit', fontSize:10, fontWeight:on?700:400, border:`1px solid ${on?'var(--acc)':'var(--bdr)'}`, background:on?'var(--acc-d)':'var(--bg3)', color:on?'var(--acc)':'var(--t4)' }}>{c.icon} {c.label}</button>;
                    })}
                    {(hidden > 0 || showAllCats) && (
                      <button onClick={()=>setShowAllCats(v=>!v)} style={{ padding:'2px 9px', borderRadius:10, cursor:'pointer', fontFamily:'inherit', fontSize:10, fontWeight:700, border:'1px dashed var(--bdr2)', background:'transparent', color:'var(--acc)' }}>
                        {showAllCats ? 'Show fewer' : `+ ${hidden} more`}
                      </button>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* v4.6.2b: visibility (POS/Kiosk/Online/Delivery) UI removed — surface targeting will move to per-menu assignment in v4.6.3+. Existing visibility data preserved on items. */}
            {/* v4.6.3: Sharing & ownership scope. Only shown on top-level items (variants inherit). */}
            {/* v5.5.877 (Bug 1b): also hide on variant children (parentId set) — scope is a
                product-level property; sharing a child directly used to create a standalone
                product at peer locations. setMenuItemScope now redirects a child to its parent,
                but hiding the control keeps the operator on the correct (parent) row. */}
            {!isSub && !item.parentId && (
              <div>
                <span style={lbl}>Sharing</span>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginTop: 4 }}>
                  {[
                    { id: 'local',  label: 'Local',  desc: 'This location only.' },
                    { id: 'shared', label: 'Shared', desc: 'All locations in this org. Each can override price, category, image.' },
                    { id: 'global', label: 'Global', desc: 'Managed centrally. Edit once, applies everywhere. No overrides.' },
                  ].map(s => {
                    const on = (item.scope || 'local') === s.id;
                    return (
                      <button key={s.id} onClick={async () => {
                      // v4.7.0: setMenuItemScope handles the full promote/demote flow:
                      // - local→shared/global creates copies at peer locations
                      // - shared↔global rescopes all sibling rows
                      // - shared/global→local just clears flags on this row
                      const prev = item.scope || 'local';
                      // Optimistic UI update first
                      onUpdate({ scope: s.id });
                      try {
                        const result = await setMenuItemScope(item, s.id);
                        reportSave('item scope', result.ok ? null : (result.error || new Error('Scope change failed')));
                        if (!result.ok) {
                          showToast(`Couldn't change scope: ${result.error?.message || result.error || 'unknown'}`, 'error');
                          onUpdate({ scope: prev }); // revert
                          return;
                        }
                        if (result.action === 'promoted')   showToast(`"${item.name}" promoted to ${s.id} — copied to ${result.createdCount} other location(s)`, 'success');
                        else if (result.action === 'demoted')  showToast(`"${item.name}" set to local at this site only — siblings unchanged`, 'info');
                        else if (result.action === 'rescoped') showToast(`"${item.name}" rescoped to ${s.id} across ${result.updatedSiblings + 1} location(s)`, 'success');
                        markBOChange();
                      } catch (e) {
                        reportSave('item scope', e);
                        console.warn('[MenuManager] scope change failed:', e?.message || e);
                        showToast('Scope change failed: ' + (e?.message || 'unknown error'), 'error');
                        onUpdate({ scope: prev });
                      }
                    }} style={{
                        // v5.5.813 (handoff marker 10): equal cards with an explicit
                        // radio affordance. Selected keeps the existing amber accent —
                        // mapped to the theme's --amber so it holds up in dark + light.
                        background: on ? 'color-mix(in srgb, var(--amber, #F5A623) 11%, transparent)' : 'var(--bg2)',
                        border: '1.5px solid ' + (on ? 'color-mix(in srgb, var(--amber, #F5A623) 45%, transparent)' : 'var(--bdr)'),
                        borderRadius: 10, padding: 10, cursor: 'pointer', textAlign: 'left',
                        color: 'inherit', fontFamily: 'inherit', transition: 'background .12s, border-color .12s',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{
                            width: 14, height: 14, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center',
                            border: `1.5px solid ${on ? 'var(--amber, #F5A623)' : 'var(--bdr2)'}`,
                          }}>
                            {on && <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--amber, #F5A623)' }}/>}
                          </span>
                          <span style={{ fontWeight: 700, fontSize: 13, color: on ? 'var(--amber, #F5A623)' : 'var(--t1)' }}>{s.label}</span>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--t3)', lineHeight: 1.45, marginTop: 5 }}>{s.desc}</div>
                      </button>
                    );
                  })}
                </div>

                {(item.scope || 'local') !== 'local' && (
                  <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 6 }}>
                    <button onClick={() => onUpdate({ lockPricing: !item.lockPricing })} style={{
                      width: 32, height: 18, padding: 0, borderRadius: 9, flexShrink: 0,
                      background: item.lockPricing ? 'var(--acc)' : 'var(--bg3)',
                      border: 0, cursor: 'pointer', position: 'relative',
                    }}>
                      <span style={{
                        position: 'absolute', top: 2, left: item.lockPricing ? 16 : 2,
                        width: 14, height: 14, borderRadius: '50%',
                        background: item.lockPricing ? '#fff' : 'var(--t3)', transition: 'all .15s',
                      }} />
                    </button>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <span style={{ fontSize: 12.5, fontWeight: 500, color: 'var(--t1)' }}>Lock pricing</span>
                      <span style={{ fontSize: 11, color: 'var(--t3)' }}>Other locations can change category &amp; image but not price.</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {isSub && (
              <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                <div style={{ padding:'8px 10px', background:'var(--bg3)', borderRadius:8, fontSize:11, color:'var(--t3)', lineHeight:1.5 }}>
                  Sub items are modifier options — e.g. Whole Milk, Oat Milk, Chips. Assign them to modifier groups in the Modifier groups tab.
                </div>
                <div>
                  <span style={lbl}>Group tag</span>
                  <input style={inp} value={item.subGroup||''} onChange={e=>f('subGroup',e.target.value)} placeholder="e.g. Milks, Sauces, Proteins…"/>
                  <div style={{ fontSize:10, color:'var(--t4)', marginTop:4 }}>Groups sub-items in the Items → Sub items view. Not shown on POS.</div>
                </div>
              </div>
            )}

          </div>
        )}

        {/* ════ FLOW — complete customer journey in order ══════════════════ */}
        {sec==='flow' && !isSub && (
          <div style={{ display:'flex', flexDirection:'column', gap:0 }}>

            {/* Intro */}
            <div style={{ padding:'8px 12px', background:'var(--bg3)', borderRadius:10, marginBottom:14, fontSize:11, color:'var(--t3)', lineHeight:1.5 }}>
              This is the <strong style={{ color:'var(--t1)' }}>exact order</strong> the customer goes through when ordering this item on the POS. Drag modifier groups to reorder them.
            </div>

            {/* STEP 1: Sizes — if item has variants */}
            {(isParent || (item.type||'simple')==='variants') && (
              <div style={{ marginBottom:16 }}>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
                  <div style={{ width:22, height:22, borderRadius:'50%', background:'var(--acc)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:800, color:'#0b0c10', flexShrink:0 }}>1</div>
                  <span style={{ fontSize:12, fontWeight:700, color:'var(--t1)' }}>Choose {item.variantLabel||'Size'}</span>
                  <span style={{ fontSize:10, color:'var(--t4)' }}>customer picks one</span>
                </div>
                <div style={{ paddingLeft:30 }}>
                  {variants.length === 0 && (
                    <div style={{ padding:'10px', background:'var(--bg3)', borderRadius:8, fontSize:11, color:'var(--t4)', marginBottom:8 }}>No sizes yet — click "Sizes" tab to add them</div>
                  )}
                  {variants.map((v,vi) => {
                    const vp = v.pricing || { base: v.price || 0 };
                    return (
                      <div key={v.id} style={{ display:'grid', gridTemplateColumns:'1fr 90px 32px', gap:6, marginBottom:6, alignItems:'center' }}>
                        <input style={{ ...inp, fontSize:13, fontWeight:600 }} value={v.menuName||v.name||''} onChange={e=>updVariant(v.id,{menuName:e.target.value,name:e.target.value,receiptName:e.target.value,kitchenName:e.target.value})} placeholder={`Size ${vi+1}`}/>
                        <div style={{ position:'relative' }}>
                          <span style={{ position:'absolute', left:8, top:'50%', transform:'translateY(-50%)', fontSize:12, color:'var(--t4)', fontWeight:700 }}>£</span>
                          <input type="number" step="0.01" min="0" style={{ ...inp, paddingLeft:20, fontSize:13, fontWeight:700, color:'var(--acc)' }} value={vp.base!==undefined?vp.base:''} placeholder="0.00" onChange={e=>updVariant(v.id,{pricing:{...vp,base:parseFloat(e.target.value)||0},price:parseFloat(e.target.value)||0})}/>
                        </div>
                        <button onClick={()=>removeVariant(v.id)} style={{ width:32,height:34,borderRadius:7,border:'1px solid var(--red-b)',background:'var(--red-d)',color:'var(--red)',cursor:'pointer',fontSize:15,display:'flex',alignItems:'center',justifyContent:'center' }}>×</button>
                      </div>
                    );
                  })}
                  <button onClick={addVariant} style={{ padding:'7px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1.5px dashed var(--bdr2)', color:'var(--t3)', fontSize:11, fontWeight:600, marginTop:2 }}>+ Add {item.variantLabel||'size'}</button>
                </div>
              </div>
            )}

            {/* STEPS — v5.5.948: ONE combined list. Cooking preferences sit AMONG the
                modifier groups and drag anywhere; the order saves to optionGroupOrder
                and every surface (POS/kiosk/online/MPOS) renders it identically. */}
            {flowEntries.map((entry, i) => {
              const stepNum = isParent ? i+2 : i+1;
              if (entry.kind === 'mod') {
                const ag = entry.g;
                const def = (modifierGroupDefs||[]).find(g => g.id === ag.groupId);
                if (!def) return null;
                const isReq = (def.min||0) > 0; // read from group def — single source of truth
                const modeLabel = def.selectionType==='quantity' ? `qty, up to ${def.max||'∞'}` : def.selectionType==='multiple' ? `up to ${def.max||'∞'}` : 'pick 1';
                return (
                  <div key={ag.groupId} draggable
                    onDragStart={()=>setDragModIdx(i)} onDragOver={e=>{e.preventDefault();setOverModIdx(i);}}
                    onDrop={e=>{e.preventDefault();if(dragModIdx!==null&&dragModIdx!==i)reorderFlow(dragModIdx,i);setDragModIdx(null);setOverModIdx(null);}}
                    onDragEnd={()=>{setDragModIdx(null);setOverModIdx(null);}}
                    style={{ marginBottom:14, opacity:dragModIdx===i?.4:1, border:`1.5px solid ${overModIdx===i?'var(--acc)':'transparent'}`, borderRadius:10, padding:overModIdx===i?'4px':0, transition:'all .1s' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                      <div style={{ width:22, height:22, borderRadius:'50%', background:isReq?'var(--red)':'var(--bg4)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:800, color:isReq?'#fff':'var(--t3)', flexShrink:0 }}>{stepNum}</div>
                      <div style={{ flex:1, minWidth:0 }}>
                        <span style={{ fontSize:12, fontWeight:700, color:'var(--t1)' }}>{def.name}</span>
                        <span style={{ fontSize:9, color:'var(--t4)', marginLeft:6 }}>{isReq?'required':'optional'} · {modeLabel}</span>
                      </div>
                      <span style={{ fontSize:10, color:'var(--t4)', cursor:'grab' }}>⠿</span>
                      <button onClick={()=>removeMod(ag.groupId)} style={{ width:22,height:22,borderRadius:6,border:'1px solid var(--red-b)',background:'var(--red-d)',color:'var(--red)',cursor:'pointer',fontSize:12,display:'flex',alignItems:'center',justifyContent:'center' }}>×</button>
                    </div>
                    <div style={{ paddingLeft:30 }}>
                      {(def.options||[]).map(opt => (
                        <span key={opt.id} style={{ display:'inline-block', marginRight:6, marginBottom:4, padding:'3px 9px', borderRadius:12, fontSize:11, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t2)' }}>
                          {opt.name}{opt.price>0&&<span style={{ color:'var(--t4)', marginLeft:3 }}>+{money(opt.price)}</span>}
                          {opt.subGroupId && <span style={{ color:'var(--acc)', marginLeft:3, fontSize:9 }}>↳</span>}
                        </span>
                      ))}
                      {/* Nested modifier indicators */}
                      {(def.options||[]).filter(o=>o.subGroupId).map(o => {
                        const sub = (modifierGroupDefs||[]).find(d=>d.id===o.subGroupId);
                        return sub ? <div key={o.id} style={{ fontSize:9, color:'var(--acc)', marginTop:2 }}>↳ If "{o.name}": also shows <strong>{sub.name}</strong></div> : null;
                      })}
                    </div>
                  </div>
                );
              }
              // Instruction step — same drag index-space as the mods (one list, one order).
              const ag = entry.g;
              const def = (instructionGroupDefs||[]).find(g=>g.id===ag.groupId);
              if (!def) return null;
              // Per-assignment min overrides group-def min; either being >0 means required
              const effectiveMin = ag.min ?? def.min ?? 0;
              const isReq = effectiveMin > 0;
              return (
                <div key={ag.groupId} draggable
                  onDragStart={()=>setDragModIdx(i)} onDragOver={e=>{e.preventDefault();setOverModIdx(i);}}
                  onDrop={e=>{e.preventDefault();if(dragModIdx!==null&&dragModIdx!==i)reorderFlow(dragModIdx,i);setDragModIdx(null);setOverModIdx(null);}}
                  onDragEnd={()=>{setDragModIdx(null);setOverModIdx(null);}}
                  style={{ marginBottom:14, opacity:dragModIdx===i?.4:1, border:`1.5px solid ${overModIdx===i?'var(--acc)':'transparent'}`, borderRadius:10, padding:overModIdx===i?'4px':0, transition:'all .1s' }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8 }}>
                    <div style={{ width:22, height:22, borderRadius:'50%', background:isReq?'var(--red)':'var(--grn)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:800, color:'#fff', flexShrink:0 }}>{stepNum}</div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <span style={{ fontSize:12, fontWeight:700, color:'var(--t1)' }}>{def.name}</span>
                      <span style={{ fontSize:9, fontWeight:600, color:isReq?'var(--red)':'var(--grn)', marginLeft:6 }}>{isReq?'required':'optional'} · no charge</span>
                    </div>
                    <button onClick={()=>updateInst(ag.groupId,{min:isReq?0:1})} title={isReq?'Make optional':'Mark as required'}
                      style={{ padding:'3px 9px', borderRadius:6, border:`1px solid ${isReq?'var(--red-b)':'var(--bdr)'}`, background:isReq?'var(--red-d)':'var(--bg3)', color:isReq?'var(--red)':'var(--t3)', cursor:'pointer', fontSize:10, fontWeight:700 }}>{isReq?'Required':'Optional'}</button>
                    <span style={{ fontSize:10, color:'var(--t4)', cursor:'grab' }}>⣿</span>
                    <button onClick={()=>removeInst(ag.groupId)} style={{ width:22,height:22,borderRadius:6,border:'1px solid var(--grn-b)',background:'var(--grn-d)',color:'var(--grn)',cursor:'pointer',fontSize:12,display:'flex',alignItems:'center',justifyContent:'center' }}>×</button>
                  </div>
                  <div style={{ paddingLeft:30 }}>
                    {(def.options||[]).map((opt,oi) => (
                      <span key={oi} style={{ display:'inline-block', marginRight:6, marginBottom:4, padding:'3px 9px', borderRadius:12, fontSize:11, background:'var(--grn-d)', border:'1px solid var(--grn-b)', color:'var(--grn)' }}>{opt}</span>
                    ))}
                  </div>
                </div>
              );
            })}

            {/* Empty state */}
            {!isParent && assignedMods.length===0 && assignedInst.length===0 && (
              <div style={{ padding:'16px', textAlign:'center', color:'var(--t4)', fontSize:11 }}>
                No flow yet. Use the <strong>Modifiers</strong> tab to assign modifier and instruction groups.
              </div>
            )}

            {/* Add modifier/instruction quick-add */}
            <div style={{ marginTop:8, padding:'10px 12px', background:'var(--bg3)', borderRadius:10, border:'1px solid var(--bdr)' }}>
              <div style={{ fontSize:10, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Add to flow</div>
              <div style={{ position:'relative', marginBottom:6 }}>
                <span style={{ position:'absolute', left:9, top:'50%', transform:'translateY(-50%)', fontSize:12, color:'var(--t4)' }}>🔍</span>
                <input style={{ ...inp, paddingLeft:28, fontSize:12 }} value={modSearch} onChange={e=>setModSearch(e.target.value)} placeholder="Search modifier groups…"/>
              </div>
              {modSearch && filteredMods.slice(0,4).map(g => (
                <div key={g.id} onClick={()=>addMod(g.id)} style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', marginBottom:4, borderRadius:8, border:'1px solid var(--bdr)', cursor:'pointer', background:'var(--bg2)' }}
                  onMouseEnter={e=>e.currentTarget.style.background='var(--bg3)'} onMouseLeave={e=>e.currentTarget.style.background='var(--bg2)'}>
                  <span style={{ flex:1, fontSize:12, fontWeight:600 }}>{g.name}</span>
                  <span style={{ fontSize:11, fontWeight:700, color:'var(--acc)' }}>+</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ════ SIZES / VARIANTS ══════════════════════════════════════════ */}
        {sec==='variants' && !isSub && (
          <div style={{ display:'flex', flexDirection:'column', gap:16 }}>

            {/* Variant label */}
            <div>
              <span style={lbl}>Size label <span style={{ fontWeight:400, textTransform:'none' }}>(shown as heading in POS picker)</span></span>
              <div style={{ display:'flex', gap:4, flexWrap:'wrap', marginBottom:7 }}>
                {['Size','Serving','Type','Cut','Style','Strength','Format','Portion','Blend','Roast','Weight'].map(l=>{
                  const act=(item.variantLabel||'Size')===l;
                  return <button key={l} onClick={()=>onUpdate({variantLabel:l})} style={{ padding:'3px 9px', borderRadius:12, cursor:'pointer', fontFamily:'inherit', fontSize:11, fontWeight:act?700:400, border:`1px solid ${act?'var(--acc)':'var(--bdr)'}`, background:act?'var(--acc-d)':'var(--bg3)', color:act?'var(--acc)':'var(--t3)' }}>{l}</button>;
                })}
              </div>
              <input style={inp} value={item.variantLabel||''} onChange={e=>onUpdate({variantLabel:e.target.value})} placeholder="Custom label e.g. Colour, Region, Weight…"/>
            </div>

            {/* Variants list */}
            <div>
              <span style={lbl}>Sizes / variants <span style={{ fontWeight:400, textTransform:'none' }}>(each becomes a button on POS)</span></span>
              {variants.length === 0 && (
                <div style={{ padding:'12px', background:'var(--bg3)', borderRadius:9, fontSize:11, color:'var(--t4)', textAlign:'center', marginBottom:8 }}>No sizes yet — click "+ Add" below</div>
              )}
              {variants.map((v,vi) => {
                const vp = v.pricing || { base: v.price || 0 };
                return (
                  <div key={v.id} draggable onDragStart={()=>setDragModIdx(vi)} onDragOver={e=>{e.preventDefault();setOverModIdx(vi);}} onDrop={e=>{e.preventDefault();if(dragModIdx!==null&&dragModIdx!==vi){reorderVariants(dragModIdx,vi);}setDragModIdx(null);setOverModIdx(null);}} onDragEnd={()=>{setDragModIdx(null);setOverModIdx(null);}}
                    style={{ display:'grid', gridTemplateColumns:'18px 1fr 100px 32px', gap:6, alignItems:'center', marginBottom:6, opacity:dragModIdx===vi?.4:1, background:overModIdx===vi?'var(--acc-d)':'transparent', borderRadius:8, padding:'2px 0' }}>
                    <span style={{ fontSize:10, color:'var(--t4)', cursor:'grab', textAlign:'center' }}>⠿</span>
                    <input style={{ ...inp, fontSize:13, fontWeight:600 }} value={v.menuName||v.name||''} onChange={e=>updVariant(v.id,{menuName:e.target.value,name:e.target.value,receiptName:e.target.value,kitchenName:e.target.value})} placeholder={`${item.variantLabel||'Size'} ${vi+1}`}/>
                    <div style={{ position:'relative' }}>
                      <span style={{ position:'absolute', left:8, top:'50%', transform:'translateY(-50%)', fontSize:12, color:'var(--t4)', fontWeight:700 }}>£</span>
                      <input type="number" step="0.01" min="0" style={{ ...inp, paddingLeft:20, fontSize:13, fontWeight:700, color:'var(--acc)' }} value={vp.base!==undefined?vp.base:''} placeholder="0.00" onChange={e=>updVariant(v.id,{pricing:{...vp,base:parseFloat(e.target.value)||0},price:parseFloat(e.target.value)||0})}/>
                    </div>
                    <button onClick={()=>removeVariant(v.id)} style={{ width:32, height:34, borderRadius:7, border:'1px solid var(--red-b)', background:'var(--red-d)', color:'var(--red)', cursor:'pointer', fontSize:15, display:'flex', alignItems:'center', justifyContent:'center' }}>×</button>
                  </div>
                );
              })}
              <button onClick={addVariant} style={{ width:'100%', padding:'9px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1.5px dashed var(--bdr2)', color:'var(--t2)', fontSize:12, fontWeight:600, marginTop:4 }}>+ Add {item.variantLabel||'size'}</button>
            </div>

            {/* POS preview for variants */}
            {variants.length > 0 && (
              <div style={{ padding:'10px 12px', background:'var(--bg2)', borderRadius:10, border:'1px solid var(--bdr)' }}>
                <div style={{ fontSize:9, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>POS preview</div>
                <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', marginBottom:6 }}>Choose {item.variantLabel||'Size'}</div>
                <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                  {variants.map(v => {
                    const vp = v.pricing||{base:v.price||0};
                    return (
                      <div key={v.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'6px 10px', borderRadius:8, border:'1.5px solid var(--bdr)', background:'var(--bg3)' }}>
                        <div style={{ width:14,height:14,borderRadius:'50%',border:'2px solid var(--bdr2)',flexShrink:0 }}/>
                        <span style={{ fontSize:12, fontWeight:500, color:'var(--t1)', flex:1 }}>{v.menuName||v.name||'—'}</span>
                        <span style={{ fontSize:13, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>{money((vp.base||0))}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

          </div>
        )}

        {/* ════ MODIFIERS ═════════════════════════════════════════════════ */}
        {sec==='modifiers' && !isSub && (
          <div style={{ display:'flex', flexDirection:'column', gap:20 }}>

            {/* Block modifiers on parent items that have variants */}
            {isParent ? (
              <div style={{ padding:'16px 18px', background:'var(--acc-d)', border:'1.5px solid var(--acc-b)', borderRadius:12 }}>
                <div style={{ fontSize:13, fontWeight:700, color:'var(--acc)', marginBottom:6 }}>⚠ Assign modifiers to sizes, not the parent</div>
                <div style={{ fontSize:12, color:'var(--t2)', lineHeight:1.6 }}>
                  This item has {variants.length} size{variants.length!==1?'s':''} (variants). Modifiers must be assigned to each size individually — not to the parent product. Click a size in the Flow tab to edit its modifiers.
                </div>
              </div>
            ) : (<>
              <div>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
                <span style={{ ...lbl, margin:0 }}>Modifier groups</span>
                <span style={{ fontSize:9, color:'var(--t4)', fontWeight:400 }}>paid options — drag to reorder</span>
              </div>

              {/* Assigned groups */}
              {assignedMods.length === 0 ? (
                <div style={{ padding:'10px 12px', background:'var(--bg3)', borderRadius:8, fontSize:11, color:'var(--t4)', marginBottom:10, textAlign:'center' }}>No modifier groups assigned yet</div>
              ) : (
                <div style={{ marginBottom:10 }}>
                  {assignedMods.map((ag, i) => {
                    const def = (modifierGroupDefs||[]).find(g => g.id === ag.groupId);
                    if (!def) return null;
                    const isReq = (def.min||0) > 0; // single source of truth: group def
                    const modeLabel = def.selectionType==='quantity' ? `qty pick, max ${def.max>=99?'∞':def.max}` : def.selectionType==='multiple' ? `multi, max ${def.max>=99?'∞':def.max}` : 'pick 1';
                    return (
                      <div key={ag.groupId} draggable
                        onDragStart={()=>setDragModIdx(i)} onDragOver={e=>{e.preventDefault();setOverModIdx(i);}}
                        onDrop={e=>{e.preventDefault();if(dragModIdx!==null&&dragModIdx!==i)reorderMods(dragModIdx,i);setDragModIdx(null);setOverModIdx(null);}}
                        onDragEnd={()=>{setDragModIdx(null);setOverModIdx(null);}}
                        style={{ display:'grid', gridTemplateColumns:'18px 1fr auto', gap:6, alignItems:'center', padding:'8px 10px', marginBottom:5, borderRadius:9, border:`1.5px solid ${overModIdx===i?'var(--acc)':'var(--bdr)'}`, background:overModIdx===i?'var(--acc-d)':'var(--bg3)', opacity:dragModIdx===i?.4:1, cursor:'default' }}>
                        <span style={{ fontSize:10, color:'var(--t4)', cursor:'grab' }}>⠿</span>
                        <div>
                          <div style={{ fontSize:12, fontWeight:700, color:'var(--t1)' }}>{def.name}</div>
                          <div style={{ fontSize:9, color:'var(--t4)' }}>{(def.options||[]).length} options · {isReq?'required':'optional'} · {modeLabel}</div>
                        </div>
                        <button onClick={()=>removeMod(ag.groupId)} style={{ width:24,height:24,borderRadius:6,border:'1px solid var(--red-b)',background:'var(--red-d)',color:'var(--red)',cursor:'pointer',fontSize:13,display:'flex',alignItems:'center',justifyContent:'center' }}>×</button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Search to add */}
              <div style={{ position:'relative' }}>
                <span style={{ position:'absolute', left:9, top:'50%', transform:'translateY(-50%)', fontSize:12, color:'var(--t4)' }}>🔍</span>
                <input style={{ ...inp, paddingLeft:28, fontSize:12 }} value={modSearch} onChange={e=>setModSearch(e.target.value)} placeholder="Search modifier groups to add…"/>
              </div>
              {(modSearch || filteredMods.length <= 6) && filteredMods.length > 0 && (
                <div style={{ marginTop:4, border:'1px solid var(--bdr)', borderRadius:8, overflow:'hidden', background:'var(--bg2)' }}>
                  {filteredMods.slice(0,8).map(g => (
                    <div key={g.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', borderBottom:'1px solid var(--bdr)', cursor:'pointer' }} onClick={()=>addMod(g.id)}
                      onMouseEnter={e=>e.currentTarget.style.background='var(--bg3)'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:12, fontWeight:600, color:'var(--t1)' }}>{g.name}</div>
                        <div style={{ fontSize:9, color:'var(--t4)' }}>{(g.options||[]).map(o=>o.name||o.label).slice(0,4).join(' · ')}{(g.options||[]).length>4?'…':''}</div>
                      </div>
                      <button style={{ padding:'3px 9px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:10, fontWeight:700 }}>+ Add</button>
                    </div>
                  ))}
                  {filteredMods.length > 8 && <div style={{ padding:'6px 10px', fontSize:10, color:'var(--t4)', textAlign:'center' }}>{filteredMods.length-8} more — type to filter</div>}
                </div>
              )}
              {modSearch && filteredMods.length === 0 && (
                <div style={{ marginTop:4, padding:'8px 10px', fontSize:11, color:'var(--t4)', textAlign:'center', background:'var(--bg3)', borderRadius:8 }}>No matching groups — create one in the Modifier groups tab</div>
              )}
            </div>

            {/* Instruction groups */}
            <div>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
                <span style={{ ...lbl, margin:0 }}>Instruction groups</span>
                <span style={{ fontSize:9, color:'var(--t4)', fontWeight:400 }}>no price change (cooking pref, notes)</span>
              </div>

              {assignedInst.length > 0 && (
                <div style={{ marginBottom:8 }}>
                  {assignedInst.map(gid => {
                    const def = (instructionGroupDefs||[]).find(g=>g.id===gid);
                    if (!def) return null;
                    return (
                      <div key={gid} style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 10px', marginBottom:4, borderRadius:8, border:'1.5px solid var(--grn-b)', background:'var(--grn-d)' }}>
                        <div style={{ flex:1 }}>
                          <div style={{ fontSize:12, fontWeight:700, color:'var(--grn)' }}>{def.name}</div>
                          <div style={{ fontSize:9, color:'var(--grn)', opacity:.7 }}>{(def.options||[]).slice(0,4).join(' · ')}</div>
                        </div>
                        <button onClick={()=>removeInst(gid)} style={{ width:22,height:22,borderRadius:5,border:'1px solid var(--grn-b)',background:'transparent',color:'var(--grn)',cursor:'pointer',fontSize:13,display:'flex',alignItems:'center',justifyContent:'center' }}>×</button>
                      </div>
                    );
                  })}
                </div>
              )}

              <div style={{ position:'relative' }}>
                <span style={{ position:'absolute', left:9, top:'50%', transform:'translateY(-50%)', fontSize:12, color:'var(--t4)' }}>🔍</span>
                <input style={{ ...inp, paddingLeft:28, fontSize:12 }} value={instSearch} onChange={e=>setInstSearch(e.target.value)} placeholder="Search instruction groups to add…"/>
              </div>
              {(instSearch || filteredInst.length <= 6) && filteredInst.length > 0 && (
                <div style={{ marginTop:4, border:'1px solid var(--bdr)', borderRadius:8, overflow:'hidden', background:'var(--bg2)' }}>
                  {filteredInst.slice(0,6).map(g => (
                    <div key={g.id} style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 10px', borderBottom:'1px solid var(--bdr)', cursor:'pointer' }} onClick={()=>addInst(g.id)}
                      onMouseEnter={e=>e.currentTarget.style.background='var(--bg3)'} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:12, fontWeight:600, color:'var(--t1)' }}>{g.name}</div>
                        <div style={{ fontSize:9, color:'var(--t4)' }}>{(g.options||[]).slice(0,4).join(' · ')}</div>
                      </div>
                      <button style={{ padding:'3px 9px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', background:'var(--grn)', border:'none', color:'#fff', fontSize:10, fontWeight:700 }}>+ Add</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

          </>)}

          </div>
        )}

        {/* ════ PRICING ════════════════════════════════════════════════════ */}
        {sec==='pricing' && (
          <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
            {isParent && <div style={{ padding:'8px 10px', background:'var(--bg3)', borderRadius:8, fontSize:11, color:'var(--t3)' }}>This item has size variants — set prices on each size in the Sizes tab.</div>}
            {[
              { k:'base',         label:'Base price',     hint:'Used when no channel override is set', accent:true },
              { k:'dineIn',       label:'Dine-in',        hint:'Leave blank to use base price' },
              { k:'takeaway',     label:'Takeaway',       hint:'' },
              { k:'collection',   label:'Collection',     hint:'' },
              { k:'delivery',     label:'Delivery',       hint:'' },
            ].map(({k,label,hint,accent}) => (
              <div key={k}>
                <div style={{ display:'flex', alignItems:'baseline', gap:6, marginBottom:5 }}>
                  <span style={lbl}>{label}</span>
                  {hint && <span style={{ fontSize:9, color:'var(--t4)', fontWeight:400 }}>{hint}</span>}
                </div>
                <div style={{ position:'relative' }}>
                  <span style={{ position:'absolute', left:10, top:'50%', transform:'translateY(-50%)', fontSize:accent?16:13, color:accent?'var(--acc)':'var(--t4)', fontWeight:700 }}>£</span>
                  <input type="number" step="0.01" min="0" style={{ ...inp, paddingLeft:26, fontSize:accent?16:13, fontWeight:accent?800:400, color:accent?'var(--acc)':'var(--t1)' }} value={k==='base'?(p.base||0):(p[k]!==null&&p[k]!==undefined?p[k]:'')} placeholder={k!=='base'?`${p.base||0} (base)`:''} onChange={e=>fp(k,e.target.value)}/>
                  {k!=='base'&&p[k]!==null&&p[k]!==undefined&&<button onClick={()=>fp(k,'')} style={{ position:'absolute', right:8, top:'50%', transform:'translateY(-50%)', background:'none', border:'none', color:'var(--t4)', cursor:'pointer', fontSize:14 }}>×</button>}
                </div>
              </div>
            ))}
          {!isSub && <PerMenuPricingTiers item={item} onUpdate={onUpdate} />}
          </div>
        )}

        {/* ════ TAX ════════════════════════════════════════════════════════ */}
        {sec==='tax' && (
          <TaxSection item={item} onUpdate={onUpdate} markBOChange={markBOChange}/>
        )}

        {/* ════ ALLERGENS & DIETARY ════════════════════════════════════════ */}
        {sec==='allergens' && (
          <div>
            <span style={lbl}>Dietary — shows as a badge on the print menu &amp; menu board</span>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:5, marginBottom:16 }}>
              {DIET_TAGS.map(d=>{
                const on=(item.tags||[]).includes(d.id);
                return (
                  <button key={d.id} onClick={()=>onUpdate({tags:on?(item.tags||[]).filter(x=>x!==d.id):[...(item.tags||[]),d.id]})} style={{ display:'flex', alignItems:'center', gap:7, padding:'7px 9px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', textAlign:'left', border:`1.5px solid ${on?'var(--grn,#2f8f4e)':'var(--bdr)'}`, background:on?'var(--grn-d,rgba(47,143,78,.12))':'var(--bg3)', transition:'all .1s' }}>
                    <div style={{ width:16,height:16,borderRadius:3,border:`2px solid ${on?'var(--grn,#2f8f4e)':'var(--bdr2)'}`,background:on?'var(--grn,#2f8f4e)':'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}>
                      {on&&<div style={{ width:6,height:6,borderRadius:1,background:'#fff' }}/>}
                    </div>
                    <span style={{ fontSize:11, fontWeight:on?700:400, color:on?'var(--grn,#2f8f4e)':'var(--t1)' }}>{d.icon} {d.label} <b style={{ opacity:.7 }}>{d.badge}</b></span>
                  </button>
                );
              })}
            </div>
            <span style={lbl}>Declared allergens — EU 14 mandatory</span>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:5 }}>
              {ALLERGENS.map(a=>{
                const on=(item.allergens||[]).includes(a.id);
                return (
                  <button key={a.id} onClick={()=>onUpdate({allergens:on?(item.allergens||[]).filter(x=>x!==a.id):[...(item.allergens||[]),a.id]})} style={{ display:'flex', alignItems:'center', gap:7, padding:'7px 9px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', textAlign:'left', border:`1.5px solid ${on?'var(--red)':'var(--bdr)'}`, background:on?'var(--red-d)':'var(--bg3)', transition:'all .1s' }}>
                    <div style={{ width:16,height:16,borderRadius:3,border:`2px solid ${on?'var(--red)':'var(--bdr2)'}`,background:on?'var(--red)':'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}>
                      {on&&<div style={{ width:6,height:6,borderRadius:1,background:'#fff' }}/>}
                    </div>
                    <span style={{ fontSize:11, fontWeight:on?700:400, color:on?'var(--red)':'var(--t1)' }}>{a.icon} {a.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* ════ PIZZA ══════════════════════════════════════════════════════ */}
        {sec==='pizza' && isPizza && (
          <PizzaBuilder item={item} onUpdate={onUpdate} markBOChange={markBOChange}/>
        )}

      </div>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <div style={{ padding:'8px 16px', borderTop:'1px solid var(--bdr)', flexShrink:0, display:'flex', gap:8 }}>
        <button onClick={onClone} style={{ flex:1, padding:'7px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'transparent', border:'1px solid var(--acc-b)', color:'var(--acc)', fontSize:11, fontWeight:600 }}>⧉ Clone item</button>
        <button onClick={()=>{if(confirm('Archive this item?'))onArchive();}} style={{ flex:1, padding:'7px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'transparent', border:'1px solid var(--red-b)', color:'var(--red)', fontSize:11, fontWeight:600 }}>Archive item</button>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════════════════════
// PIZZA BUILDER
// Full per-item pizza configurator: sizes, bases, crusts, toppings
// pizzaSizes/pizzaBases/pizzaCrusts = null means "use global defaults"
// ═══════════════════════════════════════════════════════════════════════════
function PizzaBuilder({ item, onUpdate, markBOChange }) {
  const [newSizeName, setNewSizeName] = useState('');
  const [newSizePrice, setNewSizePrice] = useState('');

  // Per-item overrides (null = use globals)
  const sizes   = item.pizzaSizes  || PIZZA_SIZES;
  const bases   = item.pizzaBases  || PIZZA_BASES.map(b=>b.id);
  const crusts  = item.pizzaCrusts || PIZZA_CRUSTS.map(c=>c.id);
  const tops    = item.defaultToppings || [];
  const useCustomSizes  = !!item.pizzaSizes;
  const useCustomBases  = !!item.pizzaBases;
  const useCustomCrusts = !!item.pizzaCrusts;

  const u = (patch) => { onUpdate(patch); markBOChange(); };

  const addSize = () => {
    if (!newSizeName.trim()) return;
    const cur = useCustomSizes ? sizes : [...PIZZA_SIZES];
    u({ pizzaSizes: [...cur, { id:`sz-${Date.now()}`, name:newSizeName.trim(), basePrice:parseFloat(newSizePrice)||0 }] });
    setNewSizeName(''); setNewSizePrice('');
  };
  const updateSize = (id, patch) => u({ pizzaSizes: sizes.map(s=>s.id===id?{...s,...patch}:s) });
  const removeSize = (id) => u({ pizzaSizes: sizes.filter(s=>s.id!==id) });

  const toggleBase  = (id) => {
    const cur = useCustomBases  ? [...bases]             : PIZZA_BASES.map(b=>b.id);
    u({ pizzaBases:  cur.includes(id)?cur.filter(x=>x!==id):[...cur,id] });
  };
  const toggleCrust = (id) => {
    const cur = useCustomCrusts ? [...crusts]            : PIZZA_CRUSTS.map(c=>c.id);
    u({ pizzaCrusts: cur.includes(id)?cur.filter(x=>x!==id):[...cur,id] });
  };
  const toggleTop   = (id) => {
    u({ defaultToppings: tops.includes(id)?tops.filter(x=>x!==id):[...tops,id] });
  };

  const sbl = { fontSize:11, fontWeight:700, color:'var(--t2)', display:'block', marginBottom:8, paddingBottom:5, borderBottom:'1px solid var(--bdr)' };
  const badge = (txt, color) => <span style={{ fontSize:9, fontWeight:700, padding:'2px 7px', borderRadius:9, background:`${color}22`, color, border:`1px solid ${color}55`, marginLeft:6 }}>{txt}</span>;

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:22 }}>

      {/* ── SIZES ───────────────────────────────────────────────────── */}
      <div>
        <div style={{ display:'flex', alignItems:'center', marginBottom:8 }}>
          <span style={{ fontSize:11, fontWeight:700, color:'var(--t2)' }}>Sizes & prices</span>
          {badge(useCustomSizes?'Custom':'Global default','var(--acc)')}
          {useCustomSizes && <button onClick={()=>u({pizzaSizes:null})} style={{ marginLeft:'auto', fontSize:9, color:'var(--t4)', background:'none', border:'none', cursor:'pointer', fontFamily:'inherit' }}>Reset to global</button>}
        </div>

        {sizes.map((s,i) => (
          <div key={s.id} style={{ display:'grid', gridTemplateColumns:'1fr 90px 32px', gap:6, marginBottom:6, alignItems:'center' }}>
            <input value={s.name} onChange={e=>updateSize(s.id,{name:e.target.value})} style={{ ...inp, fontSize:12, fontWeight:600 }} placeholder={`Size ${i+1}`}/>
            <div style={{ position:'relative' }}>
              <span style={{ position:'absolute', left:8, top:'50%', transform:'translateY(-50%)', fontSize:11, color:'var(--t4)', fontWeight:700 }}>£</span>
              <input type="number" step="0.01" min="0" value={s.basePrice||''} onChange={e=>updateSize(s.id,{basePrice:parseFloat(e.target.value)||0})} style={{ ...inp, paddingLeft:20, fontSize:13, fontWeight:700, color:'var(--acc)' }} placeholder="0.00"/>
            </div>
            <button onClick={()=>removeSize(s.id)} style={{ width:32, height:34, borderRadius:7, border:'1px solid var(--red-b)', background:'var(--red-d)', color:'var(--red)', cursor:'pointer', fontSize:15, display:'flex', alignItems:'center', justifyContent:'center' }}>×</button>
          </div>
        ))}

        <div style={{ display:'grid', gridTemplateColumns:'1fr 90px auto', gap:6, marginTop:4 }}>
          <input value={newSizeName} onChange={e=>setNewSizeName(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addSize()} style={{ ...inp, fontSize:12 }} placeholder={'Size name e.g. Medium 11"'}/>
          <div style={{ position:'relative' }}>
            <span style={{ position:'absolute', left:8, top:'50%', transform:'translateY(-50%)', fontSize:11, color:'var(--t4)', fontWeight:700 }}>£</span>
            <input type="number" step="0.01" min="0" value={newSizePrice} onChange={e=>setNewSizePrice(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addSize()} style={{ ...inp, paddingLeft:20, fontSize:12 }} placeholder="0.00"/>
          </div>
          <button onClick={addSize} disabled={!newSizeName.trim()} style={{ padding:'7px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:12, fontWeight:700, opacity:newSizeName.trim()?1:.4 }}>+ Add</button>
        </div>
      </div>

      {/* ── BASES ───────────────────────────────────────────────────── */}
      <div>
        <div style={{ display:'flex', alignItems:'center', marginBottom:8 }}>
          <span style={{ fontSize:11, fontWeight:700, color:'var(--t2)' }}>Available bases</span>
          {badge(useCustomBases?'Custom':'All available','var(--grn)')}
        </div>
        <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
          {PIZZA_BASES.map(b => {
            const avail = useCustomBases ? bases.includes(b.id) : true;
            return (
              <button key={b.id} onClick={()=>toggleBase(b.id)} style={{ padding:'6px 12px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', fontSize:12, fontWeight:avail?700:400, border:`1.5px solid ${avail?'var(--acc)':'var(--bdr)'}`, background:avail?'var(--acc-d)':'var(--bg3)', color:avail?'var(--acc)':'var(--t3)' }}>
                {avail?'✓ ':''}{b.name}
                {b.allergens.length>0&&<span style={{ fontSize:9, color:'var(--t4)', marginLeft:4 }}>⚠</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── CRUSTS ──────────────────────────────────────────────────── */}
      <div>
        <div style={{ display:'flex', alignItems:'center', marginBottom:8 }}>
          <span style={{ fontSize:11, fontWeight:700, color:'var(--t2)' }}>Available crusts</span>
          {badge(useCustomCrusts?'Custom':'All available','var(--grn)')}
        </div>
        <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
          {PIZZA_CRUSTS.map(c => {
            const avail = useCustomCrusts ? crusts.includes(c.id) : true;
            return (
              <button key={c.id} onClick={()=>toggleCrust(c.id)} style={{ display:'flex', alignItems:'center', gap:5, padding:'6px 12px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', fontSize:12, fontWeight:avail?700:400, border:`1.5px solid ${avail?'var(--acc)':'var(--bdr)'}`, background:avail?'var(--acc-d)':'var(--bg3)', color:avail?'var(--acc)':'var(--t3)' }}>
                {avail?'✓ ':''}{c.name}
                {(c.extra||0)>0&&<span style={{ fontSize:10, color:'var(--t4)', fontFamily:'var(--font-mono)' }}>+{money(c.extra)}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── DEFAULT TOPPINGS ────────────────────────────────────────── */}
      <div>
        <div style={{ marginBottom:8 }}>
          <span style={{ fontSize:11, fontWeight:700, color:'var(--t2)' }}>Default toppings</span>
          <div style={{ fontSize:10, color:'var(--t4)', marginTop:3 }}>Pre-selected when customer opens this pizza. They can still add/remove any topping.</div>
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:5 }}>
          {PIZZA_TOPPINGS.map(t => {
            const on = tops.includes(t.id);
            return (
              <button key={t.id} onClick={()=>toggleTop(t.id)} style={{ display:'flex', alignItems:'center', gap:7, padding:'7px 10px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', textAlign:'left', border:`1.5px solid ${on?t.color||'var(--acc)':'var(--bdr)'}`, background:on?(t.color||'var(--acc)')+'18':'var(--bg3)', transition:'all .1s' }}>
                <div style={{ width:12,height:12,borderRadius:'50%',background:t.color||'var(--acc)',flexShrink:0,boxShadow:on?`0 0 6px ${t.color}88`:'none' }}/>
                <span style={{ fontSize:11, fontWeight:on?700:400, color:on?t.color||'var(--acc)':'var(--t1)', flex:1 }}>{t.name}</span>
                {t.price>0&&<span style={{ fontSize:10, color:'var(--t4)', fontFamily:'var(--font-mono)' }}>+{money(t.price)}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── POS PREVIEW ─────────────────────────────────────────────── */}
      <div style={{ padding:'12px', background:'var(--bg2)', borderRadius:10, border:'1px solid var(--bdr)' }}>
        <div style={{ fontSize:9, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:8 }}>Order flow preview</div>
        <div style={{ fontSize:11, color:'var(--t3)', lineHeight:2, marginBottom:4 }}>
          1. Choose size: <strong style={{ color:'var(--t1)' }}>{sizes.map(s=>s.name).join(' / ')}</strong><br/>
          2. Choose base: <strong style={{ color:'var(--t1)' }}>{(useCustomBases?PIZZA_BASES.filter(b=>bases.includes(b.id)):PIZZA_BASES).map(b=>b.name).join(' / ')}</strong><br/>
          3. Choose crust: <strong style={{ color:'var(--t1)' }}>{(useCustomCrusts?PIZZA_CRUSTS.filter(c=>crusts.includes(c.id)):PIZZA_CRUSTS).map(c=>c.name).join(' / ')}</strong><br/>
          4. Toppings: <strong style={{ color:'var(--t1)' }}>{tops.length?PIZZA_TOPPINGS.filter(t=>tops.includes(t.id)).map(t=>t.name).join(', '):'None pre-selected'}</strong>
        </div>
      </div>

    </div>
  );
}



// ═══════════════════════════════════════════════════════════════════════════
// MODIFIER GROUPS TAB
// Drag to reorder groups + options. Options support nested subGroupId.
// ═══════════════════════════════════════════════════════════════════════════
function ModifiersTab() {
  const { modifierGroupDefs:groups, addModifierGroupDef, updateModifierGroupDef,
          updateModifierGroupOption,
          removeModifierGroupDef, reorderModifierGroupDefs, markBOChange, showToast } = useStore();
  const [selId, setSelId]     = useState(null);
  const [newName, setNewName] = useState('');
  const [newOpt, setNewOpt]   = useState({ name:'', price:'' });
  const [itemSearch, setItemSearch] = useState('');
  const { menuItems } = useStore();
  const [dragGIdx, setDragGIdx] = useState(null);
  const [overGIdx, setOverGIdx] = useState(null);
  const [dragOIdx, setDragOIdx] = useState(null);
  const [overOIdx, setOverOIdx] = useState(null);

  const sel = groups?.find(g=>g.id===selId);
  const upd = patch => { updateModifierGroupDef(selId,patch); markBOChange(); };

  const addGroup = () => {
    if (!newName.trim()) return;
    addModifierGroupDef({ name:newName.trim(), min:0, max:1, selectionType:'single', options:[] });
    markBOChange(); setNewName('');
    setTimeout(()=>setSelId(useStore.getState().modifierGroupDefs?.slice(-1)[0]?.id),30);
  };

  const addOpt = () => {
    if (!newOpt.name.trim()) return;
    const opt = { id:`opt-${Date.now()}`, name:newOpt.name.trim(), price:parseFloat(newOpt.price)||0 };
    upd({ options:[...(sel.options||[]),opt] });
    setNewOpt({name:'',price:''});
  };

  const delOpt  = oid => upd({ options:(sel.options||[]).filter(o=>o.id!==oid) });
  const updOpt  = (oid,patch) => {
    updateModifierGroupOption(selId, oid, patch);
    markBOChange();
  };

  const reorderOpts = (from, to) => {
    const arr = [...(sel.options||[])];
    const [m] = arr.splice(from,1); arr.splice(to,0,m);
    upd({ options:arr });
  };

  const maxUnlimited = !sel?.max || sel.max >= 99;

  return (
    <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>

      {/* ── Left: group list ─────────────────────────────────────── */}
      <div style={{ width:270, borderRight:'1px solid var(--bdr)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'10px 12px', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
          <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:4 }}>Modifier groups</div>
          <div style={{ fontSize:10, color:'var(--t3)', lineHeight:1.5, marginBottom:8 }}>Paid options. Create here, assign to items via the item editor → Modifiers tab. Drag to reorder.</div>
          <div style={{ display:'flex', gap:6 }}>
            <input style={{ ...inp, flex:1, fontSize:12, padding:'6px 10px' }} value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addGroup()} placeholder="Group name e.g. Sides"/>
            <button onClick={addGroup} disabled={!newName.trim()} style={{ padding:'6px 14px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:13, fontWeight:700, opacity:newName.trim()?1:.4 }}>+</button>
          </div>
        </div>
        <div style={{ flex:1, overflowY:'auto', padding:'6px' }}>
          {(groups||[]).map((g,gi)=>(
            <div key={g.id} draggable
              onDragStart={()=>setDragGIdx(gi)} onDragOver={e=>{e.preventDefault();setOverGIdx(gi);}}
              onDrop={e=>{e.preventDefault();if(dragGIdx!==null&&dragGIdx!==gi){reorderModifierGroupDefs(dragGIdx,gi);markBOChange();/* v5.5.834: was the only modifier-group mutation missing this — add/edit/delete all mark, so a reorder alone never lit the "Push to POS" badge */}setDragGIdx(null);setOverGIdx(null);}}
              onDragEnd={()=>{setDragGIdx(null);setOverGIdx(null);}}
              onClick={()=>setSelId(g.id===selId?null:g.id)}
              style={{ display:'flex', alignItems:'center', gap:7, padding:'8px 10px', marginBottom:3, borderRadius:9, cursor:'pointer',
                border:`1.5px solid ${selId===g.id?'var(--acc)':overGIdx===gi?'var(--acc-b)':'var(--bdr)'}`,
                background:selId===g.id?'var(--acc-d)':overGIdx===gi?'var(--bg3)':'transparent',
                opacity:dragGIdx===gi?.4:1 }}>
              <span style={{ fontSize:10, color:'var(--t4)', cursor:'grab', flexShrink:0 }}>⠿</span>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12, fontWeight:700, color:selId===g.id?'var(--acc)':'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{g.name}</div>
                <div style={{ fontSize:9, color:'var(--t4)', marginTop:1 }}>{(g.options||[]).length} opts · {g.min>0?'required':'optional'}</div>
              </div>
              <button onClick={e=>{e.stopPropagation();if(confirm(`Remove "${g.name}"?`)){removeModifierGroupDef(g.id);if(selId===g.id)setSelId(null);markBOChange();}}} style={{ width:20,height:20,borderRadius:5,border:'1px solid var(--red-b)',background:'var(--red-d)',color:'var(--red)',cursor:'pointer',fontSize:12,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}>×</button>
            </div>
          ))}
          {(!groups||groups.length===0)&&<div style={{ textAlign:'center', padding:'32px 8px', color:'var(--t4)', fontSize:11 }}>No modifier groups yet</div>}
        </div>
      </div>

      {/* ── Right: editor ────────────────────────────────────────── */}
      {sel ? (
        <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>

          {/* Header */}
          <div style={{ padding:'12px 16px', borderBottom:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0 }}>
            <input style={{ ...inp, fontSize:16, fontWeight:800, border:'none', background:'transparent', padding:'0 0 10px', color:'var(--t1)' }} value={sel.name} onChange={e=>upd({name:e.target.value})} placeholder="Group name"/>

            {/* ── UNIFIED SELECTION MODE PICKER ── */}
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:6, marginBottom:10 }}>
              {[
                { id:'single',   label:'Pick 1',         hint:'Customer picks exactly one option',          icon:'◉' },
                { id:'multiple', label:'Pick many',       hint:'Different options, each selectable once',    icon:'☑' },
                { id:'quantity', label:'Pick with qty',   hint:'Same option can be chosen more than once',   icon:'＋' },
              ].map(mode => {
                const act = sel.selectionType === mode.id || (!sel.selectionType && mode.id === 'single');
                return (
                  <button key={mode.id} onClick={()=>{
                    // v5.5.34: when switching to 'quantity' mode (Pick with qty),
                    // default min to match max. Quantity-mode is for fixed-size
                    // containers like "Box of 3" / "Box of 6" where the customer
                    // MUST pick exactly that many. Defaulting min to max means the
                    // operator only has to set max — the rule "pick exactly N"
                    // is implied. They can still drop min for "between 1 and N"
                    // ranges if needed. Single and multiple modes preserve old
                    // default of min:sel.min||0 (optional).
                    const newMax = mode.id==='single' ? 1 : (sel.max||1)===1 ? 3 : (sel.max||3);
                    const newMin = mode.id==='quantity' ? newMax : (sel.min||0);
                    upd({ selectionType: mode.id, max: newMax, min: newMin });
                  }} style={{ padding:'8px 8px 7px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', textAlign:'left', border:`2px solid ${act?'var(--acc)':'var(--bdr)'}`, background:act?'var(--acc-d)':'var(--bg3)' }}>
                    <div style={{ fontSize:15, marginBottom:3 }}>{mode.icon}</div>
                    <div style={{ fontSize:11, fontWeight:700, color:act?'var(--acc)':'var(--t2)' }}>{mode.label}</div>
                    <div style={{ fontSize:9, color:'var(--t4)', lineHeight:1.4 }}>{mode.hint}</div>
                  </button>
                );
              })}
            </div>

            {/* ── REQUIRED / OPTIONAL + MIN + MAX ── */}
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>

              {/* Optional / Required toggle — always shown */}
              <div style={{ display:'flex', gap:5 }}>
                {[[false,'Optional — skip if desired'],[true,'Required — must pick']].map(([req,label])=>{
                  const act = req ? (sel.min||0)>0 : !(sel.min>0);
                  return <button key={label} onClick={()=>upd({ min: req ? (sel.selectionType==='single' ? 1 : (sel.min>1?sel.min:1)) : 0 })}
                    style={{ flex:1, padding:'6px 8px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', textAlign:'center',
                      border:`1.5px solid ${act?'var(--acc)':'var(--bdr)'}`, background:act?'var(--acc-d)':'var(--bg3)',
                      fontSize:10, fontWeight:act?700:400, color:act?'var(--acc)':'var(--t3)' }}>{label}</button>;
                })}
              </div>

              {/* Min picks — only shown for multi/quantity when required */}
              {sel.selectionType !== 'single' && (sel.min||0) > 0 && (
                <div style={{ display:'flex', alignItems:'center', gap:5, padding:'6px 10px', borderRadius:8, background:'var(--bg3)', border:'1px solid var(--bdr)' }}>
                  <span style={{ fontSize:10, color:'var(--t4)', flexShrink:0 }}>Min picks:</span>
                  {[1,2,3,4,5].map(v => {
                    const act = (sel.min||1) === v;
                    const valid = v <= (sel.max>=99 ? 99 : (sel.max||3));
                    if (!valid) return null;
                    return <button key={v} onClick={()=>upd({min:v})} style={{ width:28, height:28, borderRadius:7, cursor:'pointer', fontFamily:'inherit', fontSize:11, fontWeight:act?700:400, border:`1px solid ${act?'var(--acc)':'var(--bdr)'}`, background:act?'var(--acc-d)':'var(--bg3)', color:act?'var(--acc)':'var(--t3)', flexShrink:0 }}>{v}</button>;
                  })}
                  <PickNumBox value={sel.min||1} min={1} max={sel.max>=99?50:sel.max||3}
                    style={{ ...inp, width:48, padding:'3px 5px', fontSize:11 }}
                    onCommit={v=>upd({min:v})}/>
                  <span style={{ fontSize:9, color:'var(--t4)', flexShrink:0 }}>of {sel.max>=99?'∞':sel.max||3}</span>
                </div>
              )}

              {/* Max picks — only shown for multi/quantity */}
              {sel.selectionType !== 'single' && (
                <div style={{ display:'flex', alignItems:'center', gap:5 }}>
                  <span style={{ fontSize:10, color:'var(--t4)', flexShrink:0 }}>Max picks:</span>
                  {[['2',2],['3',3],['4',4],['5',5],['∞',99]].map(([l,v])=>{
                    const act = v===99 ? (sel.max||0)>=99 : (sel.max||3)===v;
                    return <button key={l} onClick={()=>upd({max:v, min: (sel.min||0)>v&&v<99?v:sel.min||0})} style={{ width:28, height:28, borderRadius:7, cursor:'pointer', fontFamily:'inherit', fontSize:11, fontWeight:act?700:400, border:`1px solid ${act?'var(--acc)':'var(--bdr)'}`, background:act?'var(--acc-d)':'var(--bg3)', color:act?'var(--acc)':'var(--t3)', flexShrink:0 }}>{l}</button>;
                  })}
                  <PickNumBox value={(sel.max||3)>=99?null:(sel.max||3)} min={2} max={50}
                    style={{ ...inp, width:48, padding:'3px 5px', fontSize:11 }}
                    onCommit={v=>upd({max:v, min:(sel.min||0)>v?v:sel.min||0})}/>
                </div>
              )}
            </div>
          </div>

          {/* Options */}
          <div style={{ flex:1, overflowY:'auto', padding:'14px 16px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
              <span style={{ fontSize:10, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em' }}>Options</span>
              <span style={{ fontSize:9, color:'var(--t4)' }}>drag to reorder · nested = links to another group</span>
            </div>

            {(sel.options||[]).map((opt,oi)=>(
              <div key={opt.id} draggable
                onDragStart={()=>setDragOIdx(oi)} onDragOver={e=>{e.preventDefault();setOverOIdx(oi);}}
                onDrop={e=>{e.preventDefault();if(dragOIdx!==null&&dragOIdx!==oi)reorderOpts(dragOIdx,oi);setDragOIdx(null);setOverOIdx(null);}}
                onDragEnd={()=>{setDragOIdx(null);setOverOIdx(null);}}
                style={{ marginBottom:8, padding:'8px 10px', borderRadius:10, border:`1px solid ${overOIdx===oi?'var(--acc)':'var(--bdr)'}`, background:'var(--bg2)', opacity:dragOIdx===oi?.4:1 }}>
                <div style={{ display:'grid', gridTemplateColumns:'14px 36px 1fr 90px auto', gap:6, alignItems:'center' }}>
                  <span style={{ fontSize:10, color:'var(--t4)', cursor:'grab' }}>⠿</span>
                  {/* Option image — shows inherited image from matching sub-item (set on the item itself) */}
                  <div style={{ width:36, height:36, borderRadius:7, overflow:'hidden', border:'1px solid var(--bdr)', background:'var(--bg3)', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, position:'relative' }}>
                    {(() => {
                      const itemMatch = (menuItems||[]).find(i =>
                        i.type === 'subitem' && !i.archived &&
                        (i.menuName || i.name || '').toLowerCase() === (opt.name||'').toLowerCase()
                      );
                      const img = opt.image || itemMatch?.image;
                      return img
                        ? <img src={img} style={{ width:'100%', height:'100%', objectFit:'cover' }} alt="" />
                        : <span style={{ fontSize:12, opacity:.3 }}>🖼</span>;
                    })()}
                  </div>
                  <input style={{ ...inp, fontSize:13, fontWeight:600 }} value={opt.name} onChange={e=>updOpt(opt.id,{name:e.target.value})} placeholder="Option name"/>
                  <div style={{ position:'relative' }}>
                    <span style={{ position:'absolute', left:8, top:'50%', transform:'translateY(-50%)', fontSize:11, color:'var(--t4)', fontWeight:700 }}>£</span>
                    <input type="number" step="0.01" min="0" style={{ ...inp, paddingLeft:20, fontSize:12, color:'var(--acc)' }} value={opt.price||''} placeholder="0.00" onChange={e=>updOpt(opt.id,{price:parseFloat(e.target.value)||0})}/>
                  </div>
                  <button onClick={()=>delOpt(opt.id)} style={{ width:28,height:34,borderRadius:7,border:'1px solid var(--red-b)',background:'var(--red-d)',color:'var(--red)',cursor:'pointer',fontSize:14,display:'flex',alignItems:'center',justifyContent:'center' }}>×</button>
                </div>

                {/* Nested sub-group selector */}
                <div style={{ marginTop:7, paddingTop:7, borderTop:'1px solid var(--bdr)', display:'flex', alignItems:'center', gap:7 }}>
                  <span style={{ fontSize:9, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.05em', flexShrink:0 }}>↳ Nested group:</span>
                  <select value={opt.subGroupId||''} onChange={e=>updOpt(opt.id,{subGroupId:e.target.value||undefined})}
                    style={{ ...inp, fontSize:11, padding:'3px 7px', flex:1, color:opt.subGroupId?'var(--acc)':'var(--t4)' }}>
                    <option value="">None — no sub-options</option>
                    {(groups||[]).filter(g=>g.id!==sel.id).map(g=><option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                  {opt.subGroupId && <span style={{ fontSize:9, color:'var(--acc)', fontWeight:700, flexShrink:0 }}>▼ shows when selected</span>}
                </div>
              </div>
            ))}

            {/* Add option — must come from Items list */}
            <div style={{ marginTop:6, padding:'10px 12px', background:'var(--bg3)', borderRadius:10, border:'1.5px dashed var(--bdr2)' }}>
              <div style={{ fontSize:10, fontWeight:700, color:'var(--t3)', marginBottom:6 }}>Add option from Items list</div>
              <div style={{ fontSize:10, color:'var(--t4)', marginBottom:8, lineHeight:1.5 }}>
                Items must be created in the <strong style={{ color:'var(--t2)' }}>Items tab</strong> with type <strong style={{ color:'var(--t2)' }}>Sub item</strong> before being added here.
              </div>
              <div style={{ position:'relative', marginBottom:6 }}>
                <span style={{ position:'absolute', left:8, top:'50%', transform:'translateY(-50%)', fontSize:11, color:'var(--t4)' }}>🔍</span>
                <input style={{ ...inp, paddingLeft:26, fontSize:12 }} value={itemSearch} onChange={e=>setItemSearch(e.target.value)} placeholder="Search sub-items by name…" autoComplete="off"/>
              </div>
              {itemSearch && (() => {
                const subItems = (menuItems||[])
                  .filter(it => it.type === 'subitem' && !it.archived)
                  .filter(it => (it.menuName||it.name||'').toLowerCase().includes(itemSearch.toLowerCase()))
                  .filter(it => !(sel.options||[]).some(o => o.name === (it.menuName||it.name)));
                if (subItems.length === 0) return (
                  <div style={{ fontSize:11, color:'var(--t4)', textAlign:'center', padding:'8px 0' }}>
                    No sub-items match — <span style={{ color:'var(--acc)', fontWeight:600 }}>create it in Items tab first</span>
                  </div>
                );
                return (
                  <div style={{ maxHeight:180, overflowY:'auto', display:'flex', flexDirection:'column', gap:3 }}>
                    {subItems.slice(0,20).map(it => {
                      const name = it.menuName || it.name || 'Unnamed';
                      const price = it.pricing?.base ?? it.price ?? 0;
                      return (
                        <button key={it.id} onClick={()=>{
                          upd({ options:[...(sel.options||[]), { id:`opt-${Date.now()}-${it.id}`, name, price, itemId: it.id }] });
                          setItemSearch('');
                        }} style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'7px 10px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--bg2)', border:'1px solid var(--bdr)', fontSize:12, color:'var(--t1)', textAlign:'left' }}
                        onMouseEnter={e=>e.currentTarget.style.borderColor='var(--acc)'}
                        onMouseLeave={e=>e.currentTarget.style.borderColor='var(--bdr)'}>
                          <span style={{ fontWeight:600 }}>{name}</span>
                          <span style={{ color:'var(--acc)', fontFamily:'var(--font-mono)', fontSize:11, flexShrink:0 }}>
                            {price > 0 ? `${money(price)}` : 'Free'}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
              {!itemSearch && (menuItems||[]).filter(it=>it.type==='subitem'&&!it.archived).length === 0 && (
                <div style={{ fontSize:11, color:'var(--t4)', textAlign:'center', padding:'4px 0' }}>
                  No sub-items yet — create them in the <strong>Items tab</strong> with type Sub item
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:8, color:'var(--t4)' }}>
          <div style={{ fontSize:40, opacity:.12 }}>⊕</div>
          <div style={{ fontSize:13, fontWeight:600, color:'var(--t3)' }}>Select a group to edit</div>
          <div style={{ fontSize:11, color:'var(--t4)' }}>Or create a new group above</div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// INSTRUCTION GROUPS TAB
// Drag to reorder groups and options within groups.
// ═══════════════════════════════════════════════════════════════════════════
function InstructionsTab() {
  const { instructionGroupDefs:groups, addInstructionGroupDef, updateInstructionGroupDef,
          removeInstructionGroupDef, reorderInstructionGroupDefs, markBOChange } = useStore();
  const [selId, setSelId]     = useState(null);
  const [newName, setNewName] = useState('');
  const [newOpt, setNewOpt]   = useState('');
  const [dragGIdx, setDragGIdx] = useState(null);
  const [overGIdx, setOverGIdx] = useState(null);
  const [dragOIdx, setDragOIdx] = useState(null);
  const [overOIdx, setOverOIdx] = useState(null);

  const sel = groups?.find(g=>g.id===selId);
  const upd = patch => { updateInstructionGroupDef(selId,patch); markBOChange(); };
  const addGroup = () => { if(!newName.trim())return; addInstructionGroupDef({name:newName.trim(),options:[]}); markBOChange(); setNewName(''); setTimeout(()=>setSelId(useStore.getState().instructionGroupDefs?.slice(-1)[0]?.id),30); };
  const addOpt   = () => { if(!newOpt.trim())return; upd({options:[...(sel.options||[]),newOpt.trim()]}); setNewOpt(''); };
  const reorderOpts = (from, to) => {
    const arr=[...(sel.options||[])]; const [m]=arr.splice(from,1); arr.splice(to,0,m); upd({options:arr});
  };

  return (
    <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>

      {/* ── Left: group list ─────────────────────────────────────── */}
      <div style={{ width:270, borderRight:'1px solid var(--bdr)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'10px 12px', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
          <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', marginBottom:4 }}>Instruction groups</div>
          <div style={{ fontSize:10, color:'var(--t3)', lineHeight:1.5, marginBottom:8 }}>Preparation choices (no price change). Drag to reorder. Assign to items via Modifiers tab.</div>
          <div style={{ display:'flex', gap:6 }}>
            <input style={{ ...inp, flex:1, fontSize:12, padding:'6px 10px' }} value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addGroup()} placeholder="e.g. Cooking preference"/>
            <button onClick={addGroup} disabled={!newName.trim()} style={{ padding:'6px 14px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:13, fontWeight:700, opacity:newName.trim()?1:.4 }}>+</button>
          </div>
        </div>
        <div style={{ flex:1, overflowY:'auto', padding:'6px' }}>
          {(groups||[]).map((g,gi)=>(
            <div key={g.id} draggable
              onDragStart={()=>setDragGIdx(gi)} onDragOver={e=>{e.preventDefault();setOverGIdx(gi);}}
              onDrop={e=>{e.preventDefault();if(dragGIdx!==null&&dragGIdx!==gi)reorderInstructionGroupDefs(dragGIdx,gi);setDragGIdx(null);setOverGIdx(null);}}
              onDragEnd={()=>{setDragGIdx(null);setOverGIdx(null);}}
              onClick={()=>setSelId(g.id===selId?null:g.id)}
              style={{ display:'flex', alignItems:'center', gap:7, padding:'8px 10px', marginBottom:3, borderRadius:9, cursor:'pointer',
                border:`1.5px solid ${selId===g.id?'var(--grn)':overGIdx===gi?'var(--grn-b)':'var(--bdr)'}`,
                background:selId===g.id?'var(--grn-d)':overGIdx===gi?'var(--bg3)':'transparent',
                opacity:dragGIdx===gi?.4:1 }}>
              <span style={{ fontSize:10, color:'var(--t4)', cursor:'grab', flexShrink:0 }}>⠿</span>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:12, fontWeight:700, color:selId===g.id?'var(--grn)':'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{g.name}</div>
                <div style={{ fontSize:9, color:'var(--t4)', marginTop:1 }}>{(g.options||[]).slice(0,3).join(' · ')}{(g.options||[]).length>3?'…':''}</div>
              </div>
              <button onClick={e=>{e.stopPropagation();if(confirm(`Remove "${g.name}"?`)){removeInstructionGroupDef(g.id);if(selId===g.id)setSelId(null);markBOChange();}}} style={{ width:20,height:20,borderRadius:5,border:'1px solid var(--red-b)',background:'var(--red-d)',color:'var(--red)',cursor:'pointer',fontSize:12,display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0 }}>×</button>
            </div>
          ))}
          {(!groups||groups.length===0)&&<div style={{ textAlign:'center', padding:'32px 8px', color:'var(--t4)', fontSize:11 }}>No instruction groups yet</div>}
        </div>
      </div>

      {/* ── Right: editor ────────────────────────────────────────── */}
      {sel ? (
        <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
          <div style={{ padding:'12px 16px', borderBottom:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0 }}>
            <input style={{ ...inp, fontSize:16, fontWeight:800, border:'none', background:'transparent', padding:'0 0 6px', color:'var(--t1)' }} value={sel.name} onChange={e=>upd({name:e.target.value})}/>
            <div style={{ fontSize:11, color:'var(--t3)', marginTop:2 }}>Printed on kitchen ticket. Customer picks one — no price change.</div>
          </div>
          <div style={{ flex:1, overflowY:'auto', padding:'14px 16px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:10 }}>
              <span style={{ fontSize:10, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.07em' }}>Options</span>
              <span style={{ fontSize:9, color:'var(--t4)' }}>drag to reorder</span>
            </div>

            {(sel.options||[]).map((opt,oi)=>(
              <div key={oi} draggable
                onDragStart={()=>setDragOIdx(oi)} onDragOver={e=>{e.preventDefault();setOverOIdx(oi);}}
                onDrop={e=>{e.preventDefault();if(dragOIdx!==null&&dragOIdx!==oi)reorderOpts(dragOIdx,oi);setDragOIdx(null);setOverOIdx(null);}}
                onDragEnd={()=>{setDragOIdx(null);setOverOIdx(null);}}
                style={{ display:'grid', gridTemplateColumns:'14px 1fr auto', gap:7, marginBottom:6, alignItems:'center',
                  background:overOIdx===oi?'var(--bg3)':'transparent', borderRadius:8, padding:'2px 0', opacity:dragOIdx===oi?.4:1 }}>
                <span style={{ fontSize:10, color:'var(--t4)', cursor:'grab', textAlign:'center' }}>⠿</span>
                <input style={inp} value={opt} onChange={e=>{const o=[...(sel.options||[])];o[oi]=e.target.value;upd({options:o});}}/>
                <button onClick={()=>upd({options:(sel.options||[]).filter((_,idx)=>idx!==oi)})} style={{ width:30,height:36,borderRadius:7,border:'1px solid var(--red-b)',background:'var(--red-d)',color:'var(--red)',cursor:'pointer',fontSize:14,display:'flex',alignItems:'center',justifyContent:'center' }}>×</button>
              </div>
            ))}

            <div style={{ display:'flex', gap:7, marginTop:8 }}>
              <input style={{ ...inp, flex:1 }} value={newOpt} onChange={e=>setNewOpt(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addOpt()} placeholder="e.g. Rare, Medium rare, Well done"/>
              <button onClick={addOpt} disabled={!newOpt.trim()} style={{ padding:'7px 14px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:12, fontWeight:600, opacity:newOpt.trim()?1:.4 }}>+ Add</button>
            </div>
          </div>
        </div>
      ) : (
        <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:8 }}>
          <div style={{ fontSize:40, opacity:.12 }}>📝</div>
          <div style={{ fontSize:13, fontWeight:600, color:'var(--t3)' }}>Select a group to edit</div>
        </div>
      )}
    </div>
  );
}


// ── Edit Category Modal ───────────────────────────────────────────────────────
function CatModal({ cat, roots, onSave, onDelete, onClose }) {
  // v5.7.33: taxProfileId rides the form — the patch flows through updateCategory
  // → sbUpsertCategory (store) AND the push path's upsertMenuCategory (db.js),
  // both of which now write tax_profile_id conditionally.
  const [f, setF] = useState({ label:cat.label, icon:cat.icon||'🍽', color:cat.color||'#3b82f6', parentId:cat.parentId||'', accountingGroup:cat.accountingGroup||'', defaultCourse:cat.defaultCourse??1, taxProfileId:cat.taxProfileId||'' });
  const set = (k,v) => setF(p=>({...p,[k]:v}));
  const { taxProfiles } = useStore();
  const activeProfiles = (taxProfiles || []).filter(p => p.active !== false);
  const COURSES = [{v:0,l:'Immediate',hint:'Drinks, bread — fires instantly with order'},{v:1,l:'Course 1',hint:'Starters / first plates'},{v:2,l:'Course 2',hint:'Mains'},{v:3,l:'Course 3',hint:'Desserts'}];
  return (
    <div className="modal-back" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:18, width:'100%', maxWidth:440, padding:'20px', boxShadow:'var(--sh3)' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
          <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)' }}>Edit category</div>
          <button onClick={onClose} style={{ background:'none', border:'none', color:'var(--t4)', cursor:'pointer', fontSize:20 }}>×</button>
        </div>
        <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
          <div><span style={lbl}>Name</span><input style={inp} value={f.label} onChange={e=>set('label',e.target.value)} autoFocus/></div>
          <div><span style={lbl}>Accounting group</span><input style={inp} value={f.accountingGroup} onChange={e=>set('accountingGroup',e.target.value)} placeholder="e.g. Food, Beverages"/></div>
          <div><span style={lbl}>Icon</span><div style={{ display:'flex', gap:3, flexWrap:'wrap' }}>{ICONS.map(ic=><button key={ic} onClick={()=>set('icon',ic)} style={{ width:28,height:28,borderRadius:7,border:`1.5px solid ${f.icon===ic?'var(--acc)':'var(--bdr)'}`,background:f.icon===ic?'var(--acc-d)':'var(--bg3)',cursor:'pointer',fontSize:14 }}>{ic}</button>)}</div></div>
          <div><span style={lbl}>Colour</span><div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>{COLOURS.map(c=><button key={c} onClick={()=>set('color',c)} style={{ width:20,height:20,borderRadius:'50%',background:c,border:'none',cursor:'pointer',outline:f.color===c?'3px solid var(--t1)':'none',outlineOffset:2 }}/>)}</div></div>
          <div>
            <span style={lbl}>Default course</span>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:5 }}>
              {COURSES.map(({v,l,hint})=>(
                <button key={v} onClick={()=>set('defaultCourse',v)} style={{ padding:'7px 10px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', textAlign:'left', border:`2px solid ${f.defaultCourse===v?'var(--acc)':'var(--bdr)'}`, background:f.defaultCourse===v?'var(--acc-d)':'var(--bg3)' }}>
                  <div style={{ fontSize:11, fontWeight:700, color:f.defaultCourse===v?'var(--acc)':'var(--t2)' }}>{v===0?'⚡':v===1?'1️⃣':v===2?'2️⃣':'3️⃣'} {l}</div>
                  <div style={{ fontSize:9, color:'var(--t4)', marginTop:2 }}>{hint}</div>
                </button>
              ))}
            </div>
          </div>
          <div><span style={lbl}>Parent</span>
            <select value={f.parentId} onChange={e=>set('parentId',e.target.value)} style={{ ...inp, cursor:'pointer' }}>
              <option value="">Root category</option>
              {roots.filter(r=>r.id!==cat.id).map(r=><option key={r.id} value={r.id}>Subcategory of: {r.label}</option>)}
            </select>
          </div>
          {/* v5.7.33: tax profile assignment — setup only, nothing charges with it yet */}
          {activeProfiles.length > 0 && (
            <div><span style={lbl}>Tax profile</span>
              <select value={f.taxProfileId} onChange={e=>set('taxProfileId',e.target.value)} style={{ ...inp, cursor:'pointer' }}>
                <option value="">Inherit venue default</option>
                {activeProfiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <div style={{ fontSize:10, color:'var(--t4)', marginTop:4, lineHeight:1.5 }}>
                Items in this category use this profile unless the item has its own override. Tills switch to profile based calculation in an upcoming update.
              </div>
            </div>
          )}
        </div>
        <div style={{ display:'flex', gap:7, marginTop:14 }}>
          <button onClick={()=>{if(confirm('Delete?'))onDelete();}} style={{ padding:'8px 12px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', fontSize:12, fontWeight:600 }}>Delete</button>
          <button onClick={onClose} style={{ flex:1, padding:'8px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:12 }}>Cancel</button>
          <button onClick={()=>onSave({...f,parentId:f.parentId||null,taxProfileId:f.taxProfileId||null})} disabled={!f.label.trim()} style={{ flex:2, padding:'8px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:13, fontWeight:800, opacity:f.label.trim()?1:.4 }}>Save</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MOVE CATEGORY MODAL — reliable nesting/unnesting via dropdown
// ═══════════════════════════════════════════════════════════════════════════
function MoveCatModal({ cat, allCats, onSave, onClose }) {
  const roots = allCats.filter(c => !c.parentId && c.id !== cat.id);
  const [parentId, setParentId] = useState(cat.parentId || '');
  return (
    <div className="modal-back" onClick={e=>e.target===e.currentTarget&&onClose()}>
      {/* v5.5.960: maxHeight + scrollable option list. With 20+ root categories the
          list ran past the viewport, the Move/Cancel buttons went off-page and the
          modal body had no scroll — the picker was unusable at Wing Fest scale. */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:18, width:'100%', maxWidth:380, padding:'20px', boxShadow:'var(--sh3)', maxHeight:'85vh', display:'flex', flexDirection:'column' }}>
        <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)', marginBottom:4, flexShrink:0 }}>Move "{cat.label}"</div>
        <div style={{ fontSize:12, color:'var(--t3)', marginBottom:16, flexShrink:0 }}>Choose where this category sits in the hierarchy.</div>
        <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:20, overflowY:'auto', flex:1, minHeight:0, paddingRight:4 }}>
          <div onClick={()=>setParentId('')} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', borderRadius:10, border:`2px solid ${parentId===''?'var(--acc)':'var(--bdr)'}`, background:parentId===''?'var(--acc-d)':'var(--bg3)', cursor:'pointer' }}>
            <div style={{ width:18,height:18,borderRadius:'50%',border:`2px solid ${parentId===''?'var(--acc)':'var(--bdr2)'}`,background:parentId===''?'var(--acc)':'transparent',flexShrink:0 }}/>
            <div>
              <div style={{ fontSize:12, fontWeight:700, color:parentId===''?'var(--acc)':'var(--t1)' }}>Root category</div>
              <div style={{ fontSize:10, color:'var(--t4)' }}>Appears at the top level of the menu</div>
            </div>
          </div>
          {roots.map(r=>(
            <div key={r.id} onClick={()=>setParentId(r.id)} style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', borderRadius:10, border:`2px solid ${parentId===r.id?'var(--acc)':'var(--bdr)'}`, background:parentId===r.id?'var(--acc-d)':'var(--bg3)', cursor:'pointer' }}>
              <div style={{ width:18,height:18,borderRadius:'50%',border:`2px solid ${parentId===r.id?'var(--acc)':'var(--bdr2)'}`,background:parentId===r.id?'var(--acc)':'transparent',flexShrink:0 }}/>
              <div>
                <div style={{ fontSize:12, fontWeight:700, color:parentId===r.id?'var(--acc)':'var(--t1)' }}>{r.icon} {r.label}</div>
                <div style={{ fontSize:10, color:'var(--t4)' }}>Nest as subcategory of {r.label}</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ display:'flex', gap:8, flexShrink:0 }}>
          <button onClick={onClose} style={{ flex:1, padding:'9px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:12 }}>Cancel</button>
          <button onClick={()=>onSave(parentId||null)} style={{ flex:2, padding:'9px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:13, fontWeight:800 }}>Move here</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// QUICK SCREEN MANAGER
// Drag items from the full menu onto a 16-slot grid — order and selection
// persists to store and reflects on POS ⚡ tab immediately
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// QUICK SCREEN MANAGER — Multiple named screens, variable grid, click-to-add
// ═══════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════
// QUICK SCREEN MANAGER — single grid, drag or click to add
// ═══════════════════════════════════════════════════════════════════════════
function QuickScreenManager() {
  const { menuItems, menuCategories, quickScreenIds, setQuickScreenIds, showToast, markBOChange,
          quickScreenMode, setQuickScreenMode, quickScreenAuto, setQuickScreenAuto } = useStore();
  const [catFilter, setCatFilter] = useState('');
  const [search, setSearch]       = useState('');
  const [dragSrc, setDragSrc]     = useState(null);
  const [overSlot, setOverSlot]   = useState(null);
  const [ranking, setRanking]     = useState(false);   // v5.5.962 recompute in flight

  const COLS  = 4;
  const SLOTS = 16;
  const slots = Array.from({ length: SLOTS }, (_, i) => quickScreenIds[i] || null);

  const allItems = menuItems.filter(i => !i.archived && (i.type !== 'subitem' || i.soldAlone) && !i.parentId);
  const roots    = menuCategories.filter(c => !c.parentId && !c.isSpecial).sort((a,b)=>(a.sortOrder||0)-(b.sortOrder||0));

  const listItems = allItems
    .filter(i => {
      if (catFilter) {
        const subIds = menuCategories.filter(c=>c.parentId===catFilter).map(c=>c.id);
        const inCat = i.cat===catFilter||(i.cats||[]).includes(catFilter)||subIds.includes(i.cat)||subIds.some(s=>(i.cats||[]).includes(s));
        if (!inCat) return false;
      }
      if (search) return (i.menuName||i.name||'').toLowerCase().includes(search.toLowerCase());
      return true;
    })
    .sort((a,b) => (a.sortOrder??999)-(b.sortOrder??999));

  const catFor = item => menuCategories.find(c => c.id === item?.cat);

  const save = async (newIds) => {
    const filtered = newIds.filter(Boolean);
    const prevIds  = quickScreenIds;
    setQuickScreenIds(filtered);
    markBOChange();
    if (isMock) return true;
    // Write directly using the supabase client already in scope — same as image uploads
    let err = null;
    try {
      const locId = await getLocationId();
      if (!locId || locId === 'loc-demo' || !supabase) throw new Error('Could not resolve location');
      const { data, error } = await supabase
        .from('locations')
        .update({ quick_screen_ids: filtered })
        .eq('id', locId)
        .select('id');
      // 0 rows is a plain success with an empty body — a policy matching nothing
      // reads exactly like a save. Ask for the id back and treat nothing as failure.
      err = error || (!data?.length ? new Error('Quick Screen update matched 0 rows') : null);
    } catch (e) { err = e; }
    reportSave('quick screen', err);   // v5.5.962: was a silent console.error swallow
    if (err) {
      console.error('[QuickScreen] save failed:', err.message);
      setQuickScreenIds(prevIds);      // the tills keep the grid that is actually stored
      showToast('Quick Screen was NOT saved — check you\'re signed in, then try again', 'error');
      return false;
    }
    return true;
  };

  // v5.5.962 Smart Quick Screen — mode switch + best-seller recompute.
  // Ranking runs HERE (Back Office) and is stored on the location row; the till
  // only ever reads the small stored lists, so it stays fast and offline-safe.
  const RANK_DAYS = 28;
  const saveSmart = async (mode, auto) => {
    const prevMode = quickScreenMode;
    const prevAuto = quickScreenAuto;
    setQuickScreenMode(mode);
    if (auto !== undefined) setQuickScreenAuto(auto);
    markBOChange();
    if (isMock) return true;
    let err = null;
    try {
      const locId = await getLocationId();
      // Was a bare `return false` — no report, no toast, and the optimistic mode
      // switch left in place, so an unresolved location looked like a mode change.
      if (!locId || locId === 'loc-demo' || !supabase) throw new Error('Could not resolve location');
      const patch = { quick_screen_mode: mode };
      if (auto !== undefined) patch.quick_screen_auto = auto;
      const { data, error } = await supabase.from('locations').update(patch).eq('id', locId).select('id');
      err = error || (!data?.length ? new Error('Quick Screen settings update matched 0 rows') : null);
    } catch (e) { err = e; }
    reportSave('quick screen', err);
    if (err) {
      setQuickScreenMode(prevMode);
      if (auto !== undefined) setQuickScreenAuto(prevAuto);
      showToast('Quick Screen settings NOT saved — check connection', 'error');
      return false;
    }
    return true;
  };

  const recompute = async (mode = quickScreenMode) => {
    if (isMock) {
      await saveSmart(mode);   // still switch the mode locally in demo
      showToast('Demo mode — no sales history to rank', 'info');
      return;
    }
    setRanking(true);
    try {
      const locId = await getLocationId();
      const since = new Date(Date.now() - RANK_DAYS * 864e5).toISOString();
      // Same fetch shape the AI shift assistant uses; voided checks are filtered
      // client-side (a .neq would also drop rows with NULL status).
      const { data, error } = await supabase
        .from('closed_checks')
        .select('items, closed_at, status')
        .eq('location_id', locId)
        .gte('closed_at', since)
        .order('closed_at', { ascending: false })
        .limit(5000);
      if (error) throw error;
      const checks = (data || []).filter(c => c.status !== 'voided');
      // v5.5.963: checkout lines carry the variant CHILD's id ("Half"/"Large") —
      // map to the master so a product ranks by all its variants combined.
      // Sub-items (modifier options) keep their own id.
      const byId = new Map(menuItems.map(m => [m.id, m]));
      const parentOf = (id) => {
        const it = byId.get(id);
        return (it?.parentId && it.type !== 'subitem') ? it.parentId : null;
      };
      // v5.7.22 — dayparts bucket on the VENUE's wall clock. Ranking from a
      // Back Office session in another timezone was shifting every sale into
      // the wrong daypart, and the wrong lists then shipped to every till.
      const venueTz = (await getLocationConfig(locId))?.timezone;
      const lists = rankQuickPicks(checks, { top: 24, parentOf, timezone: venueTz });
      const auto = { computed_at: new Date().toISOString(), days: RANK_DAYS, checks: checks.length, lists };
      // Success toast ONLY once the persist really landed — saveSmart already
      // toasted the failure (and showToast is single-slot: a success here would
      // overwrite the error and lie to the operator).
      const ok = await saveSmart(mode, auto);
      if (!ok) return;
      const total = DAYPARTS.reduce((s, d) => s + lists[d].length, 0);
      showToast(total
        ? `Ranked ${checks.length} checks from the last ${RANK_DAYS} days`
        : 'No sales history yet — pins will show until there is', 'success');
    } catch (e) {
      reportSave('quick screen', e);
      showToast('Could not rank sales — check connection', 'error');
    } finally { setRanking(false); }
  };

  const pickMode = (mode) => {
    if (mode === quickScreenMode) return;
    // Switching into a smart mode with stale/no rankings recomputes on the spot.
    const stale = !quickScreenAuto?.computed_at
      || (Date.now() - new Date(quickScreenAuto.computed_at).getTime()) > 24 * 3600e3;
    if (mode !== 'manual' && stale) recompute(mode);
    else saveSmart(mode);
  };

  const clearSlot = idx => {
    const next = [...slots]; next[idx] = null; save(next);
  };

  const addItem = async itemId => {
    if (slots.includes(itemId)) { showToast('Already on Quick Screen','warning'); return; }
    const next = [...slots];
    const firstEmpty = next.findIndex(s => !s);
    if (firstEmpty === -1) { showToast('Quick Screen is full — remove an item first','warning'); return; }
    next[firstEmpty] = itemId;
    // Toast only once the write has landed — save() toasts its own failure, and
    // showToast is single-slot, so a premature success would overwrite it.
    if (await save(next)) showToast('Added to Quick Screen','success');
  };

  const onSlotDrop = (e, idx) => {
    e.preventDefault();
    if (!dragSrc) { setOverSlot(null); return; }
    const next = [...slots];
    if (dragSrc.type === 'list') {
      if (next.includes(dragSrc.id)) { showToast('Already on Quick Screen','warning'); setDragSrc(null); setOverSlot(null); return; }
      next[idx] = dragSrc.id;
    } else if (dragSrc.type === 'slot') {
      const tmp = next[dragSrc.slotIdx]; next[dragSrc.slotIdx] = next[idx]; next[idx] = tmp;
    }
    save(next); setDragSrc(null); setOverSlot(null);
  };

  return (
    <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>

      {/* ── Left: grid ───────────────────────────────────────────────── */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', borderRight:'1px solid var(--bdr)' }}>
        <div style={{ padding:'12px 16px', borderBottom:'1px solid var(--bdr)', background:'var(--bg1)', flexShrink:0 }}>
          <div style={{ display:'flex', alignItems:'baseline', gap:10, marginBottom:2 }}>
            <span style={{ fontSize:15, fontWeight:800, color:'var(--t1)' }}>⚡ Quick Screen</span>
            <span style={{ fontSize:11, color:'var(--t4)' }}>{quickScreenIds.filter(Boolean).length}/{SLOTS} slots used</span>
          </div>
          <div style={{ fontSize:11, color:'var(--t3)' }}>Click an item to add it, or drag it onto a slot. Drag within the grid to reorder. ✕ to remove.</div>

          {/* v5.5.962 Smart Quick Screen — mode + best-seller rankings */}
          <div style={{ marginTop:10, display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
            {[['manual','Manual','Only your pinned items'],
              ['hybrid','Hybrid','Your pins first, best sellers fill the empty slots'],
              ['auto','Auto','Best sellers for the current daypart']].map(([id,label,desc])=>(
              <button key={id} onClick={()=>pickMode(id)} title={desc}
                style={{ padding:'5px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', fontSize:11, fontWeight:700,
                  background:quickScreenMode===id?'var(--acc-d)':'var(--bg3)',
                  border:`1.5px solid ${quickScreenMode===id?'var(--acc)':'var(--bdr)'}`,
                  color:quickScreenMode===id?'var(--acc)':'var(--t3)' }}>
                {label}
              </button>
            ))}
            <span style={{ fontSize:10.5, color:'var(--t4)' }}>
              {quickScreenMode==='manual' ? 'Pins only — exactly what you set below.'
               : quickScreenMode==='auto' ? 'Best sellers per daypart from real sales. Pins show only until sales data exists.'
               : 'Pins keep their slots; best sellers for the daypart fill the rest.'}
            </span>
          </div>

          {quickScreenMode!=='manual' && (
            <div style={{ marginTop:8, padding:'8px 10px', borderRadius:10, background:'var(--bg2)', border:'1px solid var(--bdr)' }}>
              <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                <span style={{ fontSize:10.5, color:'var(--t3)' }}>
                  {quickScreenAuto?.computed_at
                    ? `Ranked ${quickScreenAuto.checks ?? '?'} checks · last ${quickScreenAuto.days ?? RANK_DAYS} days · ${new Date(quickScreenAuto.computed_at).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}`
                    : 'No sales ranking computed yet.'}
                </span>
                <button onClick={()=>recompute()} disabled={ranking}
                  style={{ padding:'4px 10px', borderRadius:7, cursor:ranking?'wait':'pointer', fontFamily:'inherit', fontSize:10.5, fontWeight:700,
                    background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)' }}>
                  {ranking?'Ranking…':'↻ Refresh from sales'}
                </button>
              </div>
              {quickScreenAuto?.lists && (
                <div style={{ marginTop:6, display:'flex', gap:12, flexWrap:'wrap' }}>
                  {DAYPARTS.map(dp=>{
                    const names=(quickScreenAuto.lists[dp]||[]).slice(0,3)
                      .map(id=>{const it=menuItems.find(m=>m.id===id);return it?(it.menuName||it.name):null;})
                      .filter(Boolean);
                    return (
                      <span key={dp} style={{ fontSize:10, color:'var(--t4)' }}>
                        <span style={{ fontWeight:800, color:'var(--t3)', textTransform:'capitalize' }}>{dp}:</span>{' '}
                        {names.length?names.join(', '):'—'}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ flex:1, overflowY:'auto', padding:'16px' }}>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(155px,1fr))', gap:8 }}>
            {slots.map((itemId, idx) => {
              const item  = itemId ? menuItems.find(m => m.id === itemId) : null;
              const cat   = catFor(item);
              const color = cat?.color || 'var(--acc)';
              const isOver   = overSlot === idx;
              const isDrag   = dragSrc?.type==='slot' && dragSrc?.slotIdx===idx;
              const price    = item?.pricing?.base ?? item?.price ?? 0;
              const kids     = item ? menuItems.filter(c=>c.parentId===item.id&&!c.archived) : [];
              const fromP    = kids.length>0 ? Math.min(...kids.map(k=>k.pricing?.base??k.price??0)) : price;

              return (
                <div key={idx}
                  onDragOver={e=>{e.preventDefault();setOverSlot(idx);}}
                  onDragLeave={()=>setOverSlot(null)}
                  onDrop={e=>onSlotDrop(e,idx)}
                  style={{ minHeight:108, borderRadius:14,
                    border:`2px ${isOver?'solid':'dashed'} ${isOver?'var(--acc)':'var(--bdr)'}`,
                    background:isOver?'var(--acc-d)':item?'var(--bg2)':'var(--bg3)',
                    position:'relative', overflow:'hidden', opacity:isDrag?.3:1, transition:'all .1s',
                    cursor:item?'grab':'default',
                    ...(item?.image ? { backgroundImage:`url(${item.image})`, backgroundSize:'cover', backgroundPosition:'center' } : {}),
                  }}
                  draggable={!!item}
                  onDragStart={e=>{if(item){setDragSrc({type:'slot',id:itemId,slotIdx:idx});e.dataTransfer.effectAllowed='move';}}}
                  onDragEnd={()=>{setDragSrc(null);setOverSlot(null);}}>

                  {/* Dark overlay when image is set — same as POS */}
                  {item?.image && (
                    <div style={{ position:'absolute', inset:0, borderRadius:'inherit',
                      background:'linear-gradient(to top, rgba(0,0,0,.88) 0%, rgba(0,0,0,.55) 45%, rgba(0,0,0,.1) 100%)',
                      zIndex:0 }}/>
                  )}

                  {item ? (<>
                    {!item.image && <div style={{ position:'absolute',left:0,top:0,bottom:0,width:4,background:color,zIndex:1 }}/>}
                    <button onClick={()=>clearSlot(idx)} style={{ position:'absolute',top:4,right:4,width:18,height:18,borderRadius:5,border:'none',background:'rgba(0,0,0,.2)',color:'#fff',cursor:'pointer',fontSize:11,display:'flex',alignItems:'center',justifyContent:'center',zIndex:2 }}>×</button>
                    <div style={{ padding:'8px 8px 6px 12px', height:'100%', boxSizing:'border-box', display:'flex', flexDirection:'column', position:'relative', zIndex:1 }}>
                      {!item.image && <div style={{ fontSize:10, color:color, fontWeight:600, marginBottom:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{cat?.icon} {cat?.label}</div>}
                      {item.image && <div style={{ flex:1 }}/>}
                      <div style={{ fontSize:12, fontWeight:700, color:item.image?'#fff':'var(--t1)', flex:item.image?0:1, overflow:'hidden',
                        textShadow:item.image?'0 1px 4px rgba(0,0,0,1)':'none' }}>{item.menuName||item.name}</div>
                      <div style={{ fontSize:12, fontWeight:800, fontFamily:'var(--font-mono)', marginTop:'auto',
                        color:item.image?'#fff':color, textShadow:item.image?'0 1px 6px rgba(0,0,0,1)':'none' }}>
                        {kids.length>0?`from ${money(fromP)}`:`${money(price)}`}
                      </div>
                    </div>
                  </>) : (
                    <div style={{ height:'100%',display:'flex',alignItems:'center',justifyContent:'center',flexDirection:'column',gap:3 }}>
                      <span style={{ fontSize:18,opacity:.15 }}>+</span>
                      <span style={{ fontSize:8,color:'var(--t4)' }}>{idx+1}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ marginTop:14, display:'flex', gap:8 }}>
            {/* Same rule as addItem: toast only once the write has landed — save() toasts
                its own failure and showToast is single-slot, so a premature success lies. */}
            <button onClick={async()=>{ if (await save([])) showToast('Quick Screen cleared','info'); }}
              style={{ padding:'6px 14px',borderRadius:9,cursor:'pointer',fontFamily:'inherit',background:'var(--red-d)',border:'1px solid var(--red-b)',color:'var(--red)',fontSize:12,fontWeight:600 }}>Clear all</button>
            <button onClick={async()=>{ const ids=allItems.slice(0,SLOTS).map(i=>i.id); if (await save(ids)) showToast('Auto-filled','success'); }}
              style={{ padding:'6px 14px',borderRadius:9,cursor:'pointer',fontFamily:'inherit',background:'var(--bg3)',border:'1px solid var(--bdr2)',color:'var(--t2)',fontSize:12,fontWeight:600 }}>Auto-fill from menu</button>
          </div>
        </div>
      </div>

      {/* ── Right: item picker ───────────────────────────────────────── */}
      <div style={{ width:280, display:'flex', flexDirection:'column', overflow:'hidden', background:'var(--bg1)', flexShrink:0 }}>
        <div style={{ padding:'10px 12px', borderBottom:'1px solid var(--bdr)', flexShrink:0 }}>
          <div style={{ fontSize:12, fontWeight:700, color:'var(--t2)', marginBottom:8 }}>Add items →</div>
          <div style={{ position:'relative', marginBottom:7 }}>
            <span style={{ position:'absolute',left:8,top:'50%',transform:'translateY(-50%)',fontSize:11,color:'var(--t4)' }}>🔍</span>
            <input style={{ ...inp, paddingLeft:26, fontSize:11 }} value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search items…"/>
            {search && <button onClick={()=>setSearch('')} style={{ position:'absolute',right:7,top:'50%',transform:'translateY(-50%)',background:'none',border:'none',color:'var(--t4)',cursor:'pointer',fontSize:13 }}>×</button>}
          </div>
          <select value={catFilter} onChange={e=>setCatFilter(e.target.value)} style={{ ...inp, fontSize:11, cursor:'pointer' }}>
            <option value="">All categories</option>
            {roots.map(c=><option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
          </select>
        </div>
        <div style={{ flex:1, overflowY:'auto' }}>
          {listItems.map(item => {
            const cat     = catFor(item);
            const color   = cat?.color || 'var(--acc)';
            const inScreen = quickScreenIds.includes(item.id);
            const price   = item.pricing?.base ?? item.price ?? 0;
            return (
              <div key={item.id}
                draggable={!inScreen}
                onDragStart={e=>{if(!inScreen){setDragSrc({type:'list',id:item.id});e.dataTransfer.effectAllowed='move';}}}
                onDragEnd={()=>setDragSrc(null)}
                onClick={()=>!inScreen && addItem(item.id)}
                style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 12px',
                  borderBottom:'1px solid var(--bdr)',
                  background:inScreen?'var(--bg3)':dragSrc?.id===item.id?'var(--acc-d)':'var(--bg1)',
                  cursor:inScreen?'default':'pointer', opacity:inScreen?.6:1, transition:'background .1s' }}
                onMouseEnter={e=>{if(!inScreen)e.currentTarget.style.background='var(--bg3)';}}
                onMouseLeave={e=>{if(!inScreen)e.currentTarget.style.background='var(--bg1)';}}>
                <div style={{ width:3,height:32,borderRadius:2,background:color,flexShrink:0 }}/>
                <div style={{ flex:1,minWidth:0 }}>
                  <div style={{ fontSize:11,fontWeight:700,color:'var(--t1)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap' }}>{item.menuName||item.name}</div>
                  <div style={{ fontSize:9,color:'var(--t4)' }}>{cat?.icon} {cat?.label} · {money(price)}</div>
                </div>
                {inScreen
                  ? <span style={{ fontSize:9,fontWeight:700,color:'var(--grn)',flexShrink:0 }}>✓</span>
                  : <span style={{ fontSize:14,color:'var(--acc)',flexShrink:0,fontWeight:300 }}>+</span>
                }
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
