/**
 * Batches — production runs (Produce → Batches). Slice "production batches".
 *
 * Produce a made-here stock item from its PREP recipe: pick the recipe, enter the
 * actual output, and the batch consumes the component stock and adds the made item
 * to stock at real production cost (posted to the ledger). Shows planned-vs-actual
 * yield and keeps full batch history (lot, expiry) for traceability.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { money, currencySymbol } from '../../lib/currency';
import { buildCostingCtx } from '../../lib/stock/recipes';
import { fetchRecipes } from '../../lib/stock/recipes';
import { fetchInventoryItems } from '../../lib/stock/data';
import { planBatch, produceBatch, fetchBatches } from '../../lib/stock/production';

const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };

export default function Batches() {
  const showToast = useStore(s => s.showToast);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [recipes, setRecipes] = useState([]);
  const [items, setItems] = useState([]);
  const [ctx, setCtx] = useState({ itemsById: {}, recipesByOutputItem: {} });
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [recipeId, setRecipeId] = useState('');
  const [qty, setQty] = useState('');
  const [lot, setLot] = useState('');
  const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const [{ data: recs }, { data: its }, c, { data: bs }] = await Promise.all([
      fetchRecipes(loc), fetchInventoryItems(loc), buildCostingCtx(loc), fetchBatches(loc),
    ]);
    setRecipes((recs || []).filter(r => r.recipeType !== 'MENU' && r.outputItemId));
    setItems(its || []); setCtx(c); setBatches(bs || []); setLoading(false);
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const itemName = useCallback((id) => items.find(i => i.id === id)?.name || '—', [items]);
  const recipe = useMemo(() => recipes.find(r => r.id === recipeId) || null, [recipes, recipeId]);
  const actualQty = qty === '' ? (recipe?.yieldQty ?? 0) : Number(qty);

  const plan = useMemo(() => {
    if (!recipe) return null;
    try {
      return planBatch(
        { outputItemId: recipe.outputItemId, yieldQty: recipe.yieldQty, yieldUnit: recipe.yieldUnit, wastagePct: recipe.wastagePct },
        recipe.lines, actualQty, recipe.yieldUnit, ctx,
      );
    } catch (e) { return { error: e.message }; }
  }, [recipe, actualQty, ctx]);

  const produce = async () => {
    if (!recipe) { showToast?.('Pick a recipe', 'error'); return; }
    if (!(actualQty > 0)) { showToast?.('Enter an output quantity', 'error'); return; }
    setBusy(true);
    const { error } = await produceBatch({ recipeId: recipe.id, actualQty, outputUnit: recipe.yieldUnit, lotCode: lot, expiryAt: expiry || null }, locId);
    setBusy(false);
    if (error) { showToast?.('Batch failed: ' + error.message, 'error'); return; }
    showToast?.(`Produced ${actualQty} ${recipe.yieldUnit} of ${itemName(recipe.outputItemId)}`, 'success');
    setQty(''); setLot(''); setExpiry('');
    await reload();
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, margin: '0 0 4px', color: 'var(--t1)' }}>Production batches</h1>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 20 }}>Make a prep/sub-recipe item — consumes the ingredients and adds the made item to stock at production cost.</div>

      {/* New batch */}
      <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, maxWidth: 880, marginBottom: 26 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginBottom: 14 }}>New batch</div>
        {recipes.length === 0 && !loading && (
          <div style={{ fontSize: 13, color: 'var(--t3)' }}>No prep recipes yet. Create one in <b>Produce → Recipes</b> (type “Prep / sub-recipe”) that produces a made-here stock item.</div>
        )}
        {recipes.length > 0 && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 14 }}>
              <div><label style={lbl}>Recipe</label>
                <select value={recipeId} onChange={e => { setRecipeId(e.target.value); setQty(''); }} style={field}>
                  <option value="">— choose prep recipe —</option>
                  {recipes.map(r => <option key={r.id} value={r.id}>{r.name} → {itemName(r.outputItemId)}</option>)}
                </select>
              </div>
              <div><label style={lbl}>Output qty{recipe ? ` (${recipe.yieldUnit})` : ''}</label><input type="number" min="0" step="any" value={qty} onChange={e => setQty(e.target.value)} placeholder={recipe ? String(recipe.yieldQty) : ''} style={field} /></div>
              <div><label style={lbl}>Lot code</label><input value={lot} onChange={e => setLot(e.target.value)} style={field} placeholder="optional" /></div>
              <div><label style={lbl}>Use-by</label><input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} style={field} /></div>
            </div>

            {recipe && plan && !plan.error && (
              <div style={{ marginTop: 16, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 9, padding: 14 }}>
                <div style={{ display: 'flex', gap: 26, marginBottom: 10, flexWrap: 'wrap' }}>
                  <Stat label="Batch cost" value={money(plan.totalCost)} />
                  <Stat label={`Cost / ${recipe.yieldUnit}`} value={currencySymbol() + plan.outputUnitCost.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} />
                  <Stat label="vs planned yield" value={`${actualQty} / ${recipe.yieldQty} ${recipe.yieldUnit}`} color={actualQty < recipe.yieldQty ? 'var(--red, #ef4444)' : 'var(--t1)'} />
                </div>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 6 }}>Will consume</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {plan.consume.map(c => (
                    <div key={c.itemId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, color: 'var(--t2)' }}>
                      <span>{itemName(c.itemId)}</span>
                      <span>{c.qtyBase.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')} {ctx.itemsById[c.itemId]?.baseUnit} · {money(c.qtyBase * c.unitCost)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {plan?.error && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--red, #ef4444)' }}>{plan.error}</div>}

            <button onClick={produce} disabled={busy || !recipe || !(actualQty > 0)} style={{ marginTop: 16, padding: '10px 22px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: (busy || !recipe) ? 0.6 : 1 }}>
              {busy ? 'Producing…' : 'Produce batch'}
            </button>
          </>
        )}
      </div>

      {/* History */}
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginBottom: 10 }}>Batch history</div>
      {loading && <div style={{ fontSize: 12, color: 'var(--t3)' }}>Loading…</div>}
      {!loading && batches.length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No batches produced yet.</div>}
      {batches.length > 0 && (
        <table style={{ width: '100%', maxWidth: 1000, borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: 'var(--t3)', textAlign: 'left' }}>
              {['Date', 'Item', 'Output', 'Planned', 'Cost', 'Unit cost', 'Lot', 'Use-by', 'Status'].map(h => (
                <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid var(--bdr)', fontWeight: 600 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {batches.map(b => {
              const variance = b.plannedQty != null && b.actualQty != null && b.actualQty < b.plannedQty;
              return (
                <tr key={b.id} style={{ color: 'var(--t1)' }}>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: 'var(--t3)' }}>{b.producedAt ? new Date(b.producedAt).toLocaleDateString() : '—'}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)' }}>{b.outputName || itemName(b.outputItemId)}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)' }}>{b.actualQty} {b.outputUnit}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: variance ? 'var(--red, #ef4444)' : 'var(--t3)' }}>{b.plannedQty} {b.outputUnit}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)' }}>{b.actualCost == null ? '—' : money(b.actualCost)}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: 'var(--t3)' }}>{b.outputUnitCost == null ? '—' : currencySymbol() + Number(b.outputUnitCost).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: 'var(--t3)' }}>{b.lotCode || ''}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: 'var(--t3)' }}>{b.expiryAt ? new Date(b.expiryAt).toLocaleDateString() : ''}</td>
                  <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: b.status === 'COMPLETED' ? 'var(--grn, #16a34a)' : 'var(--t3)' }}>{b.status}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Stat({ label, value, color }) {
  return <div><div style={{ fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div><div style={{ fontSize: 17, fontWeight: 700, color: color || 'var(--t1)' }}>{value}</div></div>;
}
