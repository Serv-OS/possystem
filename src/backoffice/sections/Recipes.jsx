/**
 * Recipes — back-office recipe & sub-recipe builder (Produce → Recipes).
 * Slice 3a of the Stock & Production system.
 *
 *  • Dish recipe → links a menu product to its stock-item spec; shows live plate
 *    cost, food-cost %, GP £/% vs the menu price, with a GP-target flag.
 *  • Prep recipe → produces a Made-here stock item; its rolled cost ÷ yield becomes
 *    that item's unit cost (persisted on save), so dishes using it re-cost.
 *
 * Costing is the pure engine (costing.js); nesting/cycles handled there. Sale
 * depletion into the ledger is wired in slice 3b.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { money, currencySymbol } from '../../lib/currency';
import { UNITS, DIMENSIONS } from '../../lib/stock/units';
import { convert } from '../../lib/stock/conversion';
import { componentUnitCost, foodCostPct, gpAmount, gpPct } from '../../lib/stock/costing';
import { fetchInventoryItems } from '../../lib/stock/data';
import {
  fetchRecipes, upsertRecipe, replaceRecipeLines, setRecipeArchived,
  linkMenuItemRecipe, unlinkMenuItem, buildCostingCtx, recomputeMadeItemCost, costRecipeWith,
} from '../../lib/stock/recipes';

const TYPES = [
  { id: 'MENU', label: 'Dish', desc: 'A sellable menu item’s spec — drives food cost & GP.' },
  { id: 'PREP', label: 'Prep / sub-recipe', desc: 'Produces a made-here stock item used by other recipes.' },
];
const UNIT_OPTS = Object.entries(UNITS).map(([code, u]) => ({ code, ...u }));
const DIM_ORDER = [DIMENSIONS.COUNT, DIMENSIONS.WEIGHT, DIMENSIONS.VOLUME];
const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };
const fmtCost = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : currencySymbol() + Number(v).toFixed(4).replace(/0+$/, '').replace(/\.$/, ''));

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

const blank = () => ({ name: '', recipeType: 'MENU', outputItemId: null, menuItemId: null, portion: 1, yieldQty: 1, yieldUnit: 'each', wastagePct: 0, gpTargetPct: '', method: '', lines: [] });

export default function Recipes() {
  const showToast = useStore(s => s.showToast);
  const menuItems = useStore(s => s.menuItems) || [];
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [recipes, setRecipes] = useState([]);
  const [items, setItems] = useState([]);          // inventory items
  const [ctx, setCtx] = useState({ itemsById: {}, recipesByOutputItem: {} });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async (keepId) => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const [{ data: recs }, { data: its }, c] = await Promise.all([fetchRecipes(loc), fetchInventoryItems(loc), buildCostingCtx(loc)]);
    setRecipes(recs || []); setItems(its || []); setCtx(c); setLoading(false);
    if (keepId) { const f = (recs || []).find(r => r.id === keepId); if (f) { setDraft(structuredClone(f)); setSelectedId(keepId); } }
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return recipes.filter(r => {
      if (filter !== 'all' && r.recipeType !== filter) return false;
      if (q && !r.name.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [recipes, search, filter]);

  const madeItems = useMemo(() => items.filter(i => i.kind === 'MADE' && !i.archivedAt), [items]);
  const itemName = useCallback((id) => items.find(i => i.id === id)?.name || '—', [items]);
  const menuItemName = useCallback((id) => menuItems.find(m => String(m.id) === String(id))?.name || '(unlinked)', [menuItems]);

  // Live cost of the draft recipe.
  const cost = useMemo(() => {
    if (!draft) return null;
    return costRecipeWith(draft, ctx);
  }, [draft, ctx]);
  const menuPrice = useMemo(() => {
    if (!draft || draft.recipeType !== 'MENU' || !draft.menuItemId) return null;
    const mi = menuItems.find(m => String(m.id) === String(draft.menuItemId));
    return mi?.pricing?.base ?? mi?.price ?? null;
  }, [draft, menuItems]);

  const select = (r) => { setDraft(structuredClone(r)); setSelectedId(r.id); };
  const startNew = () => { setDraft(blank()); setSelectedId(null); };
  const upd = (k, v) => setDraft(d => ({ ...d, [k]: v }));

  const addLine = (invItem) => setDraft(d => ({ ...d, lines: [...d.lines, { componentItemId: invItem.id, qty: 1, unit: invItem.baseUnit, usablePct: 100 }] }));
  const updLine = (i, k, v) => setDraft(d => ({ ...d, lines: d.lines.map((l, j) => j === i ? { ...l, [k]: v } : l) }));
  const rmLine = (i) => setDraft(d => ({ ...d, lines: d.lines.filter((_, j) => j !== i) }));

  const save = async () => {
    if (!draft.name.trim()) { showToast?.('Name is required', 'error'); return; }
    if (draft.recipeType === 'PREP' && !draft.outputItemId) { showToast?.('Choose the made-here item this prep produces', 'error'); return; }
    setSaving(true);
    const { data, error } = await upsertRecipe(draft, locId);
    if (error) { setSaving(false); showToast?.('Save failed: ' + error.message, 'error'); return; }
    const rid = data?.id || draft.id;
    await replaceRecipeLines(rid, draft.lines, locId);
    if (draft.recipeType === 'MENU') {
      if (draft.menuItemId) await linkMenuItemRecipe(draft.menuItemId, rid, draft.portion || 1, locId);
      else await unlinkMenuItem(draft.menuItemId, locId).catch(() => {});
    } else if (draft.outputItemId) {
      await recomputeMadeItemCost(draft.outputItemId, locId);
    }
    setSaving(false); showToast?.('Recipe saved', 'success');
    await reload(rid);
  };
  const archive = async () => {
    if (!draft?.id) return;
    await setRecipeArchived(draft.id, true, locId);
    showToast?.('Archived', 'info'); setDraft(null); setSelectedId(null); await reload();
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', height: '100%', minHeight: 0, background: 'var(--bg0)' }}>
      <aside style={{ borderRight: '1px solid var(--bdr)', background: 'var(--bg1)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 14, position: 'relative' }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search recipes…" style={{ ...field, paddingRight: 40 }} />
          <button onClick={startNew} title="New recipe" style={{ position: 'absolute', top: 14, right: 16, width: 28, height: 28, borderRadius: 6, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 18, cursor: 'pointer' }}>+</button>
          <div style={{ display: 'flex', gap: 5, marginTop: 10 }}>
            {[{ id: 'all', label: 'All' }, { id: 'MENU', label: 'Dishes' }, { id: 'PREP', label: 'Prep' }].map(f => (
              <button key={f.id} onClick={() => setFilter(f.id)} style={{ fontSize: 11, padding: '4px 9px', borderRadius: 5, cursor: 'pointer', background: filter === f.id ? 'var(--bg3)' : 'transparent', color: filter === f.id ? 'var(--t1)' : 'var(--t3)', border: '1px solid ' + (filter === f.id ? 'var(--bg3)' : 'var(--bdr)') }}>{f.label}</button>
            ))}
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {loading && <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>}
          {!loading && filtered.length === 0 && <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>No recipes yet. Press <b>+</b> to build one. You’ll need stock items first (Inventory → Stock items).</div>}
          {filtered.map(r => {
            const sel = r.id === selectedId;
            return (
              <div key={r.id} onClick={() => select(r)} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 16px', cursor: 'pointer', borderLeft: '3px solid ' + (sel ? 'var(--acc)' : 'transparent'), background: sel ? 'var(--bg2)' : 'transparent' }}>
                <div style={{ width: 34, height: 34, borderRadius: 7, background: 'var(--bg3)', display: 'grid', placeItems: 'center', fontSize: 15, flexShrink: 0 }}>{r.recipeType === 'MENU' ? '🍽' : '🍲'}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 13, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>{r.recipeType === 'MENU' ? `Dish · ${menuItemName(r.menuItemId)}` : `Prep → ${itemName(r.outputItemId)}`}</div>
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      <main style={{ display: 'flex', flexDirection: 'column', minHeight: 0, overflow: 'hidden' }}>
        {!draft && (
          <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--t3)', textAlign: 'center', padding: 24 }}>
            <div><div style={{ fontSize: 40, marginBottom: 10 }}>📖</div><div style={{ fontSize: 15, color: 'var(--t2)' }}>Select a recipe, or press + to build one.</div></div>
          </div>
        )}
        {draft && (
          <>
            <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--bdr)', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
              <div style={{ flex: 1, minWidth: 200 }}>
                <h1 style={{ fontSize: 21, fontWeight: 600, margin: 0, color: 'var(--t1)' }}>{draft.name || 'New recipe'}</h1>
                <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 3 }}>{draft.recipeType === 'MENU' ? 'Dish' : 'Prep'} · {draft.lines.length} ingredient{draft.lines.length === 1 ? '' : 's'}</div>
              </div>
              <RecipeStats draft={draft} cost={cost} menuPrice={menuPrice} />
              {draft.id && <button onClick={archive} style={{ padding: '8px 14px', borderRadius: 8, cursor: 'pointer', background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t2)', fontSize: 13 }}>Archive</button>}
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 22px', minHeight: 0 }}>
              <div style={{ maxWidth: 760 }}>
                <div style={{ marginBottom: 14 }}><label style={lbl}>Name</label><input value={draft.name} onChange={e => upd('name', e.target.value)} style={field} placeholder="e.g. Margherita pizza, or Pizza dough" /></div>

                <div style={{ marginBottom: 14 }}>
                  <label style={lbl}>Type</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {TYPES.map(t => (
                      <button key={t.id} onClick={() => upd('recipeType', t.id)} style={{ flex: 1, textAlign: 'left', padding: '10px 12px', borderRadius: 8, cursor: 'pointer', background: draft.recipeType === t.id ? 'var(--acc-d, rgba(249,115,22,0.10))' : 'var(--bg2)', border: '1.5px solid ' + (draft.recipeType === t.id ? 'var(--acc)' : 'var(--bdr)') }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: draft.recipeType === t.id ? 'var(--acc)' : 'var(--t1)' }}>{t.label}</div>
                        <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>{t.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {draft.recipeType === 'MENU' ? (
                  <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 14, marginBottom: 14 }}>
                    <div><label style={lbl}>Menu item</label>
                      <select value={draft.menuItemId || ''} onChange={e => upd('menuItemId', e.target.value || null)} style={field}>
                        <option value="">— link a menu product —</option>
                        {menuItems.filter(m => !m.archived).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                      </select>
                    </div>
                    <div><label style={lbl}>GP target %</label><input type="number" min="0" max="100" value={draft.gpTargetPct ?? ''} onChange={e => upd('gpTargetPct', e.target.value)} style={field} placeholder="e.g. 70" /></div>
                  </div>
                ) : (
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
                )}

                {/* Ingredient lines */}
                <label style={lbl}>Ingredients</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                  {draft.lines.length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No ingredients yet — add stock items below.</div>}
                  {draft.lines.map((l, i) => {
                    const comp = ctx.itemsById[l.componentItemId];
                    const noCost = comp && (comp.currentCost == null || !(comp.currentCost > 0)) && comp.kind !== 'MADE';
                    let lc = null, convErr = false;
                    if (comp) { try { lc = convert(Number(l.qty), l.unit, comp.baseUnit, { itemConversions: comp.itemConversions || [] }) * componentUnitCost(l.componentItemId, ctx); } catch { convErr = true; } }
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
                        <UnitSelect value={l.unit} onChange={v => updLine(i, 'unit', v)} width={92} />
                        <span style={{ fontSize: 13, color: 'var(--t3)' }}>=</span>
                        <span style={{ width: 74, textAlign: 'right', fontSize: 13, fontWeight: 600, color: convErr ? 'var(--red, #ef4444)' : 'var(--t1)' }}>{convErr ? 'unit?' : lc == null ? '—' : money(lc)}</span>
                        <button onClick={() => rmLine(i)} style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 16 }}>×</button>
                      </div>
                    );
                  })}
                </div>
                <IngredientPicker items={items} onPick={addLine} />

                <div style={{ marginTop: 16 }}><label style={lbl}>Method (optional)</label><textarea value={draft.method || ''} onChange={e => upd('method', e.target.value)} style={{ ...field, minHeight: 70, resize: 'vertical' }} /></div>

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
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return items.filter(i => !i.archivedAt && i.name.toLowerCase().includes(s)).slice(0, 8);
  }, [q, items]);
  return (
    <div style={{ position: 'relative' }}>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search stock items to add…" style={field} />
      {matches.length > 0 && (
        <div style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, marginTop: 4, overflow: 'hidden', boxShadow: '0 10px 30px rgba(0,0,0,0.3)' }}>
          {matches.map(i => (
            <div key={i.id} onClick={() => { onPick(i); setQ(''); }} style={{ padding: '9px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--t1)', display: 'flex', justifyContent: 'space-between' }}>
              <span>{i.name}</span><span style={{ color: 'var(--t3)', fontSize: 11 }}>{i.kind === 'MADE' ? 'prep' : ''} {fmtCost(i.currentCost)}/{i.baseUnit}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
