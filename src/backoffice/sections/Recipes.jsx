/**
 * Recipes — back-office recipe builder (Produce → Recipes).
 *
 * Two modes:
 *  • Dishes — a list of your POS menu products (search), each badged "recipe ✓" or
 *    "no recipe". Click a product to build/edit its recipe; cost & GP show live
 *    against its menu price. This is the easy way to find "Heineken Half" etc.
 *  • Prep — sub-recipes that produce a made-here stock item (cost ÷ yield).
 *
 * Ingredient lines accept the component's own units (Keg, Bottle, 175ml glass) AND
 * same-dimension standard units (ml, cl, l, pt) so a half-pint is "0.5 pt" or "284 ml".
 * Costing is the pure engine (costing.js + uom.js).
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { money, currencySymbol } from '../../lib/currency';
import { UNITS, DIMENSIONS } from '../../lib/stock/units';
import { componentUnitCost, foodCostPct, gpAmount, gpPct } from '../../lib/stock/costing';
import { toBase, unitOptions } from '../../lib/stock/uom';
import { fetchInventoryItems } from '../../lib/stock/data';
import {
  fetchRecipes, upsertRecipe, replaceRecipeLines, setRecipeArchived,
  linkMenuItemRecipe, buildCostingCtx, recomputeMadeItemCost, costRecipeWith,
} from '../../lib/stock/recipes';
import { resolveTaxRate, netOf } from '../../lib/tax';

const UNIT_OPTS = Object.entries(UNITS).map(([code, u]) => ({ code, ...u }));
const DIM_ORDER = [DIMENSIONS.COUNT, DIMENSIONS.WEIGHT, DIMENSIONS.VOLUME];
const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };
const fmtCost = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : currencySymbol() + Number(v).toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));
// Standard units in the same dimension as an item's base unit (so a litre item also offers ml/cl/pt).
const sameDimGlobals = (baseUnit) => { const dim = UNITS[baseUnit]?.dimension; return UNIT_OPTS.filter(u => u.dimension === dim).map(u => u.code); };

function UnitSelect({ value, onChange, width = 110 }) {
  return (
    <select value={value || ''} onChange={e => onChange(e.target.value)} style={{ ...field, width }}>
      {DIM_ORDER.map(dim => (
        <optgroup key={dim} label={dim[0] + dim.slice(1).toLowerCase()}>
          {UNIT_OPTS.filter(u => u.dimension === dim).map(u => <option key={u.code} value={u.code}>{u.code}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

export default function Recipes() {
  const showToast = useStore(s => s.showToast);
  const menuItems = useStore(s => s.menuItems) || [];
  const taxRates = useStore(s => s.taxRates) || [];
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [recipes, setRecipes] = useState([]);
  const [items, setItems] = useState([]);
  const [ctx, setCtx] = useState({ itemsById: {}, recipesByOutputItem: {} });
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState('dishes');     // 'dishes' | 'prep'
  const [search, setSearch] = useState('');
  const [selectedKey, setSelectedKey] = useState(null);  // dishes: menuItemId · prep: recipeId
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async (keep) => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const [{ data: recs }, { data: its }, c] = await Promise.all([fetchRecipes(loc), fetchInventoryItems(loc), buildCostingCtx(loc)]);
    setRecipes(recs || []); setItems(its || []); setCtx(c); setLoading(false);
    if (keep?.menuItemId) { const r = (recs || []).find(x => String(x.menuItemId) === String(keep.menuItemId)); if (r) { setDraft(structuredClone(r)); } }
    else if (keep?.recipeId) { const r = (recs || []).find(x => x.id === keep.recipeId); if (r) { setDraft(structuredClone(r)); setSelectedKey(keep.recipeId); } }
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  // menu-item display helpers (parent-qualified names; hide variant containers + sub-items)
  const menuMeta = useMemo(() => {
    const byId = {}; menuItems.forEach(m => { byId[String(m.id)] = m; });
    const parents = new Set(menuItems.filter(m => m.parentId).map(m => String(m.parentId)));
    const label = (m) => { if (!m?.parentId) return m?.name || ''; const p = byId[String(m.parentId)]; if (!p) return m.name || ''; const n = (m.name || '').trim(); return n.toLowerCase().startsWith((p.name || '').toLowerCase()) ? n : `${p.name} ${n}`.trim(); };
    return { byId, parents, label };
  }, [menuItems]);
  const recipeByMenuId = useMemo(() => { const m = {}; recipes.forEach(r => { if (r.recipeType === 'MENU' && r.menuItemId) m[String(r.menuItemId)] = r; }); return m; }, [recipes]);

  const dishProducts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return menuItems
      .filter(m => !m.archived && m.type !== 'subitem' && !menuMeta.parents.has(String(m.id)))
      .map(m => ({ m, label: menuMeta.label(m), recipe: recipeByMenuId[String(m.id)] || null }))
      .filter(x => !q || x.label.toLowerCase().includes(q))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [menuItems, menuMeta, recipeByMenuId, search]);

  const prepRecipes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return recipes.filter(r => r.recipeType !== 'MENU').filter(r => !q || (r.name || '').toLowerCase().includes(q));
  }, [recipes, search]);

  const madeItems = useMemo(() => items.filter(i => i.kind === 'MADE' && !i.archivedAt), [items]);
  const itemName = useCallback((id) => items.find(i => i.id === id)?.name || '—', [items]);

  const cost = useMemo(() => (draft ? costRecipeWith(draft, ctx) : null), [draft, ctx]);
  // ex-VAT net of a menu item's selling price — GP must be on the net, not the
  // VAT-inclusive shelf price. Variants inherit their parent's tax rate.
  const netSellPrice = useCallback((mi) => {
    if (!mi) return null;
    const gross = mi?.pricing?.base ?? mi?.price ?? null;
    if (gross == null) return null;
    let taxRateId = mi.taxRateId ?? mi.tax_rate_id ?? null;
    let taxOverrides = mi.taxOverrides ?? mi.tax_overrides ?? {};
    if (!taxRateId && mi.parentId) {
      const p = menuMeta.byId[String(mi.parentId)];
      if (p) { taxRateId = p.taxRateId ?? p.tax_rate_id ?? null; if (!Object.keys(taxOverrides).length) taxOverrides = p.taxOverrides ?? p.tax_overrides ?? {}; }
    }
    return netOf(gross, resolveTaxRate({ taxRateId, taxOverrides }, taxRates, 'dine-in'));
  }, [taxRates, menuMeta]);
  const menuItemForDraft = (draft && draft.recipeType === 'MENU' && draft.menuItemId) ? menuMeta.byId[String(draft.menuItemId)] : null;
  const menuPrice = menuItemForDraft ? (menuItemForDraft?.pricing?.base ?? menuItemForDraft?.price ?? null) : null;     // gross (shelf) price
  const menuPriceNet = useMemo(() => netSellPrice(menuItemForDraft), [menuItemForDraft, netSellPrice]);                 // ex-VAT, GP basis

  const selectDish = (x) => {
    setSelectedKey(String(x.m.id));
    setDraft(x.recipe ? structuredClone(x.recipe)
      : { recipeType: 'MENU', menuItemId: String(x.m.id), name: x.label, portion: 1, yieldQty: 1, yieldUnit: 'each', wastagePct: 0, gpTargetPct: '', method: '', lines: [] });
  };
  const selectPrep = (r) => { setSelectedKey(r.id); setDraft(structuredClone(r)); };
  const newPrep = () => { setSelectedKey(null); setDraft({ recipeType: 'PREP', name: '', outputItemId: null, yieldQty: 1, yieldUnit: 'each', wastagePct: 0, method: '', lines: [] }); };

  const upd = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  const addLine = (invItem) => setDraft(d => ({ ...d, lines: [...d.lines, { componentItemId: invItem.id, qty: 1, unit: invItem.baseUnit, usablePct: 100 }] }));
  const updLine = (i, k, v) => setDraft(d => ({ ...d, lines: d.lines.map((l, j) => j === i ? { ...l, [k]: v } : l) }));
  const rmLine = (i) => setDraft(d => ({ ...d, lines: d.lines.filter((_, j) => j !== i) }));

  const save = async () => {
    if (draft.recipeType === 'PREP' && !draft.outputItemId) { showToast?.('Choose the made-here item this prep produces', 'error'); return; }
    if (!draft.name?.trim()) upd('name', draft.recipeType === 'MENU' ? 'Dish' : 'Prep');
    setSaving(true);
    const { data, error } = await upsertRecipe({ ...draft, name: draft.name?.trim() || (draft.recipeType === 'MENU' ? menuMeta.label(menuMeta.byId[String(draft.menuItemId)] || {}) : 'Prep') }, locId);
    if (error) { setSaving(false); showToast?.('Save failed: ' + error.message, 'error'); return; }
    const rid = data?.id || draft.id;
    await replaceRecipeLines(rid, draft.lines, locId);
    if (draft.recipeType === 'MENU' && draft.menuItemId) await linkMenuItemRecipe(draft.menuItemId, rid, draft.portion || 1, locId);
    if (draft.recipeType === 'PREP' && draft.outputItemId) await recomputeMadeItemCost(draft.outputItemId, locId);
    setSaving(false); showToast?.('Recipe saved', 'success');
    await reload(draft.recipeType === 'MENU' ? { menuItemId: draft.menuItemId } : { recipeId: rid });
  };
  const archive = async () => {
    if (!draft?.id) return;
    if (!confirm('Remove this recipe?')) return;
    await setRecipeArchived(draft.id, true, locId);
    showToast?.('Recipe removed', 'info'); setDraft(null); setSelectedKey(null); await reload();
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '330px 1fr', height: '100%', minHeight: 0, background: 'var(--bg0)' }}>
      <aside style={{ borderRight: '1px solid var(--bdr)', background: 'var(--bg1)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 14 }}>
          <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
            {[['dishes', 'Dishes'], ['prep', 'Prep']].map(([id, label]) => (
              <button key={id} onClick={() => { setMode(id); setDraft(null); setSelectedKey(null); }} style={{ flex: 1, fontSize: 12, fontWeight: 700, padding: '7px 0', borderRadius: 7, cursor: 'pointer', background: mode === id ? 'var(--acc)' : 'var(--bg2)', color: mode === id ? '#fff' : 'var(--t3)', border: '1px solid ' + (mode === id ? 'var(--acc)' : 'var(--bdr)') }}>{label}</button>
            ))}
          </div>
          <div style={{ position: 'relative' }}>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder={mode === 'dishes' ? 'Search menu products…' : 'Search prep recipes…'} style={{ ...field, paddingRight: mode === 'prep' ? 40 : 10 }} />
            {mode === 'prep' && <button onClick={newPrep} title="New prep recipe" style={{ position: 'absolute', top: 4, right: 6, width: 28, height: 28, borderRadius: 6, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 18, cursor: 'pointer' }}>+</button>}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {loading && <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>}

          {!loading && mode === 'dishes' && dishProducts.length === 0 && <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>No menu products found. Add menu items in Menu manager first.</div>}
          {!loading && mode === 'dishes' && dishProducts.map(x => {
            const sel = String(x.m.id) === String(selectedKey);
            const linked = !!x.recipe;
            return (
              <div key={x.m.id} onClick={() => selectDish(x)} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 16px', cursor: 'pointer', borderLeft: '3px solid ' + (sel ? 'var(--acc)' : 'transparent'), background: sel ? 'var(--bg2)' : 'transparent' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{x.label}</div>
                  <div style={{ fontSize: 11, marginTop: 2, color: linked ? 'var(--grn, #16a34a)' : 'var(--t4)' }}>{linked ? `✓ recipe · ${x.recipe.lines?.length || 0} ingredient${(x.recipe.lines?.length || 0) === 1 ? '' : 's'}` : 'no recipe yet'}</div>
                </div>
                {!linked && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t4)', border: '1px solid var(--bdr)', borderRadius: 20, padding: '2px 7px' }}>add</span>}
              </div>
            );
          })}

          {!loading && mode === 'prep' && prepRecipes.length === 0 && <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>No prep recipes. Press + to add one (produces a made-here stock item).</div>}
          {!loading && mode === 'prep' && prepRecipes.map(r => {
            const sel = r.id === selectedKey;
            return (
              <div key={r.id} onClick={() => selectPrep(r)} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 16px', cursor: 'pointer', borderLeft: '3px solid ' + (sel ? 'var(--acc)' : 'transparent'), background: sel ? 'var(--bg2)' : 'transparent' }}>
                <div style={{ width: 32, height: 32, borderRadius: 7, background: 'var(--bg3)', display: 'grid', placeItems: 'center', fontSize: 14, flexShrink: 0 }}>🍲</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, color: 'var(--t1)' }}>{r.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>→ {itemName(r.outputItemId)}</div>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      <main style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        {!draft && (
          <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--t3)', textAlign: 'center', padding: 24 }}>
            <div><div style={{ fontSize: 40, marginBottom: 10 }}>📖</div><div style={{ fontSize: 15, color: 'var(--t2)' }}>{mode === 'dishes' ? 'Pick a menu product on the left to build its recipe.' : 'Pick a prep recipe, or press + to add one.'}</div></div>
          </div>
        )}
        {draft && (
          <>
            <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <h1 style={{ fontSize: 21, fontWeight: 600, margin: 0, color: 'var(--t1)' }}>{draft.recipeType === 'MENU' ? (menuMeta.label(menuMeta.byId[String(draft.menuItemId)] || {}) || draft.name) : (draft.name || 'New prep recipe')}</h1>
                <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 3 }}>{draft.recipeType === 'MENU' ? `Dish recipe${menuPrice != null ? ` · sells at ${money(menuPrice)}${menuPriceNet != null && menuPriceNet < menuPrice ? ` (${money(menuPriceNet)} ex VAT)` : ''}` : ''}` : 'Prep / sub-recipe'} · {draft.lines.length} ingredient{draft.lines.length === 1 ? '' : 's'}</div>
              </div>
              <RecipeStats draft={draft} cost={cost} menuPrice={menuPriceNet} />
              {draft.id && <button onClick={archive} style={{ padding: '8px 14px', borderRadius: 8, cursor: 'pointer', background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t2)', fontSize: 13 }}>Remove</button>}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px', minHeight: 0 }}>
              <div style={{ maxWidth: 780 }}>
                {draft.recipeType === 'MENU' ? (
                  <div style={{ marginBottom: 14, maxWidth: 200 }}><label style={lbl}>GP target %</label><input type="number" min="0" max="100" value={draft.gpTargetPct ?? ''} onChange={e => upd('gpTargetPct', e.target.value)} style={field} placeholder="e.g. 70" /></div>
                ) : (
                  <>
                    <div style={{ marginBottom: 14 }}><label style={lbl}>Recipe name</label><input value={draft.name} onChange={e => upd('name', e.target.value)} style={field} placeholder="e.g. Pizza dough" /></div>
                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 14, marginBottom: 14 }}>
                      <div><label style={lbl}>Produces (made item)</label>
                        <select value={draft.outputItemId || ''} onChange={e => { const it = madeItems.find(m => m.id === e.target.value); upd('outputItemId', e.target.value || null); if (it) upd('yieldUnit', it.baseUnit); }} style={field}>
                          <option value="">— choose made-here item —</option>
                          {madeItems.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                        </select>
                      </div>
                      <div><label style={lbl}>Yield qty</label><input type="number" min="0" step="any" value={draft.yieldQty} onChange={e => upd('yieldQty', e.target.value)} style={field} /></div>
                      <div><label style={lbl}>Yield unit</label><UnitSelect value={draft.yieldUnit} onChange={v => upd('yieldUnit', v)} width="100%" /></div>
                      <div><label style={lbl}>Wastage %</label><input type="number" min="0" max="100" value={draft.wastagePct} onChange={e => upd('wastagePct', e.target.value)} style={field} /></div>
                    </div>
                  </>
                )}

                <label style={lbl}>Ingredients</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                  {draft.lines.length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No ingredients yet — add stock items below (e.g. the Heineken keg, used 0.5 pt).</div>}
                  {draft.lines.map((l, i) => {
                    const comp = ctx.itemsById[l.componentItemId];
                    const noCost = comp && (comp.currentCost == null || !(comp.currentCost > 0)) && comp.kind !== 'MADE';
                    let lc = null, convErr = false;
                    if (comp) { try { lc = toBase(Number(l.qty), l.unit, comp) * componentUnitCost(l.componentItemId, ctx); } catch { convErr = true; } }
                    return (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 7, padding: '8px 10px' }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{itemName(l.componentItemId)}</div>
                          <div style={{ fontSize: 11, color: noCost ? 'var(--red, #ef4444)' : 'var(--t3)', marginTop: 1 }}>
                            {noCost ? '⚠ no price set — add a supplier price on this item' : (comp ? `${fmtCost(comp.currentCost)} / ${comp.baseUnit}` : '')}
                          </div>
                        </div>
                        <span style={{ fontSize: 12, color: 'var(--t3)' }}>uses</span>
                        <input type="number" min="0" step="any" value={l.qty} onChange={e => updLine(i, 'qty', e.target.value)} placeholder="qty" style={{ ...field, width: 72 }} />
                        {comp
                          ? <select value={l.unit} onChange={e => updLine(i, 'unit', e.target.value)} style={{ ...field, width: 128 }}>
                              {unitOptions(comp, sameDimGlobals(comp.baseUnit)).map(o => <option key={o.token} value={o.token}>{o.label}</option>)}
                            </select>
                          : <UnitSelect value={l.unit} onChange={v => updLine(i, 'unit', v)} width={92} />}
                        <span style={{ fontSize: 13, color: 'var(--t3)' }}>=</span>
                        <span style={{ width: 74, textAlign: 'right', fontSize: 13, fontWeight: 600, color: convErr ? 'var(--red, #ef4444)' : 'var(--t1)' }}>{convErr ? 'unit?' : lc == null ? '—' : money(lc)}</span>
                        <button onClick={() => rmLine(i)} style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 16 }}>×</button>
                      </div>
                    );
                  })}
                </div>
                <IngredientPicker items={items} onPick={addLine} />

                <div style={{ marginTop: 16 }}><label style={lbl}>Method (optional)</label><textarea value={draft.method || ''} onChange={e => upd('method', e.target.value)} style={{ ...field, minHeight: 64, resize: 'vertical' }} /></div>

                <button onClick={save} disabled={saving} style={{ marginTop: 16, padding: '10px 22px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: saving ? 0.6 : 1 }}>
                  {saving ? 'Saving…' : draft.id ? 'Save recipe' : 'Create recipe'}
                </button>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function RecipeStats({ draft, cost, menuPrice }) {
  if (cost?.error) return <div style={{ fontSize: 12, color: 'var(--red, #ef4444)', maxWidth: 220, textAlign: 'right' }}>{cost.error}</div>;
  const plate = draft.recipeType === 'MENU' ? cost?.totalCost : cost?.costPerYieldBase;
  const stat = (label, val, color) => (
    <div><div style={{ fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div><div style={{ fontSize: 18, fontWeight: 700, color: color || 'var(--t1)' }}>{val}</div></div>
  );
  if (draft.recipeType !== 'MENU') {
    return <div style={{ display: 'flex', gap: 20, textAlign: 'right' }}>{stat('Cost', plate == null ? '—' : money(plate))}<div style={{ fontSize: 12, color: 'var(--t3)', alignSelf: 'flex-end' }}>per {draft.yieldUnit}</div></div>;
  }
  const price = menuPrice == null ? null : Number(menuPrice);
  const gp = price != null && plate != null ? gpPct(price, plate) : null;
  const target = draft.gpTargetPct === '' || draft.gpTargetPct == null ? null : Number(draft.gpTargetPct);
  const below = gp != null && target != null && gp < target;
  return (
    <div style={{ display: 'flex', gap: 20, textAlign: 'right' }}>
      {stat('Plate cost', plate == null ? '—' : money(plate))}
      {stat('Food cost', price != null && plate != null ? (foodCostPct(plate, price)?.toFixed(1) + '%') : '—')}
      {stat('GP', price != null && plate != null ? money(gpAmount(price, plate)) : '—')}
      {stat('GP %', gp == null ? '—' : gp.toFixed(1) + '%', below ? 'var(--red, #ef4444)' : 'var(--grn, #16a34a)')}
    </div>
  );
}

function IngredientPicker({ items, onPick }) {
  const [q, setQ] = useState('');
  const [focused, setFocused] = useState(false);
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter(i => !i.archivedAt && (!s || i.name.toLowerCase().includes(s))).slice(0, 10);
  }, [q, items]);
  return (
    <div style={{ position: 'relative' }}>
      <input value={q} onChange={e => setQ(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 150)} placeholder="Add an ingredient (search your stock items)…" style={field} />
      {focused && matches.length > 0 && (
        <div style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, marginTop: 4, overflow: 'hidden', boxShadow: '0 10px 30px rgba(0,0,0,0.3)', maxHeight: 280, overflowY: 'auto' }}>
          {matches.map(i => (
            <div key={i.id} onClick={() => { onPick(i); setQ(''); }} style={{ padding: '9px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--t1)', display: 'flex', justifyContent: 'space-between' }}>
              <span>{i.name}</span><span style={{ color: 'var(--t3)', fontSize: 11 }}>{i.kind === 'MADE' ? 'prep · ' : ''}{fmtCost(i.currentCost)}/{i.baseUnit}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
