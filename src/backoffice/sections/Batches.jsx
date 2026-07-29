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
import { getActiveLocationSync, getLocationId , isMock } from '../../lib/supabase';
import { money, currencySymbol } from '../../lib/currency';
import { buildCostingCtx } from '../../lib/stock/recipes';
import { fetchRecipes } from '../../lib/stock/recipes';
import { fetchInventoryItems } from '../../lib/stock/data';
import { planBatch, produceBatch, fetchBatches } from '../../lib/stock/production';
import { PageHeader, PrimaryBtn, ReportTable, Money, Tag } from './reports/reportKit';

const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };

export default function Batches() {
  // v5.5.931 — "needed today" suggestion inputs
  const [needed, setNeeded] = useState([]);
  const r1 = (v) => Math.round(Number(v) * 10) / 10;
  useEffect(() => {
    (async () => {
      const loc = getActiveLocationSync() || await getLocationId().catch(() => null);
      if (!loc || isMock || !supabase) return;
      const dow = new Date().getDay();
      const [{ data: its }, { data: scheds }, prof] = await Promise.all([
        fetchInventoryItems(loc),
        supabase.from('prep_schedule').select('output_item_id, qty, unit, days_of_week, active').eq('location_id', loc).eq('active', true),
        supabase.rpc('stock_usage_by_weekday', { p_location_id: loc, p_weeks: 8 }).then(r => r.data || []),
      ]);
      const profByItem = {};
      prof.forEach(r => { (profByItem[r.inventory_item_id] ??= [0,0,0,0,0,0,0])[r.dow] = Number(r.avg_daily_base) || 0; });
      const made = (its || []).filter(i => i.kind === 'MADE' && !i.archivedAt);
      const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const out = [];
      for (const item of made) {
        const p = profByItem[item.id];
        const myScheds = (scheds || []).filter(x => x.output_item_id === item.id);
        const cookDays = new Set(myScheds.flatMap(x => (Array.isArray(x.days_of_week) && x.days_of_week.length) ? x.days_of_week : [0,1,2,3,4,5,6]));
        // horizon: today up to (exclusive) the NEXT scheduled cook day; no schedule = today only
        let span = 1;
        if (cookDays.size) { for (let d = 1; d <= 7; d++) { if (cookDays.has((dow + d) % 7)) { span = d; break; } } }
        let expected = 0;
        if (p) for (let d = 0; d < span; d++) expected += p[(dow + d) % 7] || 0;
        const scheduled = myScheds.filter(x => !Array.isArray(x.days_of_week) || !x.days_of_week.length || x.days_of_week.includes(dow))
          .reduce((sum, x) => sum + (Number(x.qty) || 0), 0);
        const onHand = Number(item.onHand) || 0;
        const topUp = Math.max(0, expected - onHand - scheduled);
        if (expected > 0 || scheduled > 0) out.push({
          item, onHand, scheduled, expected, topUp, unit: item.baseUnit,
          horizon: span === 1 ? 'end of today' : DAYS[(dow + span) % 7],
        });
      }
      out.sort((a, b) => b.topUp - a.topUp);
      setNeeded(out);
    })();
  }, []);

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

  /* Batch history — flat, read-only. Columns match the previous table 1:1. */
  const batchCols = useMemo(() => [
    { key: 'date', label: 'Date', render: b => <span style={{ color: 'var(--t3)' }}>{b.producedAt ? new Date(b.producedAt).toLocaleDateString() : '—'}</span> },
    { key: 'item', label: 'Item', render: b => <span style={{ color: 'var(--t1)', fontWeight: 500 }}>{b.outputName || itemName(b.outputItemId)}</span> },
    { key: 'output', label: 'Output', align: 'right', render: b => <span style={{ color: 'var(--t1)' }}>{b.actualQty} {b.outputUnit}</span> },
    {
      key: 'planned', label: 'Planned', align: 'right',
      render: b => {
        const variance = b.plannedQty != null && b.actualQty != null && b.actualQty < b.plannedQty;
        return <span style={{ color: variance ? 'var(--red)' : 'var(--t3)' }}>{b.plannedQty} {b.outputUnit}</span>;
      },
    },
    { key: 'cost', label: 'Cost', align: 'right', render: b => <Money v={b.actualCost} /> },
    { key: 'unitCost', label: 'Unit cost', align: 'right', render: b => <span style={{ color: 'var(--t3)' }}>{b.outputUnitCost == null ? '—' : currencySymbol() + Number(b.outputUnitCost).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}</span> },
    { key: 'lot', label: 'Lot', render: b => <span style={{ color: 'var(--t3)' }}>{b.lotCode || ''}</span> },
    { key: 'expiry', label: 'Use-by', render: b => <span style={{ color: 'var(--t3)' }}>{b.expiryAt ? new Date(b.expiryAt).toLocaleDateString() : ''}</span> },
    { key: 'status', label: 'Status', render: b => (b.status ? <Tag label={b.status} tone={b.status === 'COMPLETED' ? 'good' : 'neutral'} /> : null) },
  ], [itemName]);

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
      {/* ── NEEDED TODAY (v5.5.931) — the plan + the top-up, from real data ─────────
          For each made-here item: what today's schedule says to make, PLUS a top-up when
          expected usage (weekday pattern, v5.5.926) up to the next scheduled cook exceeds
          what is on hand + planned. The exact "we make these on Mondays but sales might
          need more" ask. Suggestions only — producing stays a human decision. */}
      {needed.length > 0 && (
        <div style={{ border: '1px solid var(--acc)', borderRadius: 12, padding: '14px 18px', margin: '14px 0', background: 'var(--bg1)' }}>
          <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.06em', color: 'var(--t4)', marginBottom: 10 }}>NEEDED TODAY</div>
          {needed.map(n => (
            <div key={n.item.id} style={{ display: 'flex', alignItems: 'baseline', gap: 10, padding: '6px 0', borderBottom: '1px solid var(--bdr)', fontSize: 13 }}>
              <b style={{ color: 'var(--t1)', flex: 1 }}>{n.item.name}</b>
              <span style={{ color: 'var(--t3)' }}>on hand {r1(n.onHand)}</span>
              {n.scheduled > 0 && <span style={{ color: 'var(--t3)' }}>· planned {r1(n.scheduled)}</span>}
              <span style={{ color: 'var(--t3)' }}>· expect to use {r1(n.expected)} by {n.horizon}</span>
              <b style={{ color: n.topUp > 0 ? 'var(--amb,#e8a020)' : 'var(--grn)' }}>
                {n.topUp > 0 ? `make ${r1(n.topUp)} ${n.unit}` : 'covered'}</b>
            </div>
          ))}
        </div>
      )}
      <PageHeader
        eyebrow="PRODUCE"
        title="Batches"
        subtitle="Make a prep/sub-recipe item — consumes the ingredients and adds the made item to stock at production cost."
      />

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
                  <Stat label="vs planned yield" value={`${actualQty} / ${recipe.yieldQty} ${recipe.yieldUnit}`} color={actualQty < recipe.yieldQty ? 'var(--red)' : 'var(--t1)'} />
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
            {plan?.error && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--red)' }}>{plan.error}</div>}

            <div style={{ marginTop: 16 }}>
              <PrimaryBtn onClick={produce} disabled={busy || !recipe || !(actualQty > 0)}>
                {busy ? 'Producing…' : 'Produce batch'}
              </PrimaryBtn>
            </div>
          </>
        )}
      </div>

      {/* History */}
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginBottom: 10 }}>Batch history</div>
      <div style={{ maxWidth: 1000 }}>
        <ReportTable
          columns={batchCols}
          rows={batches}
          empty={loading ? 'Loading…' : 'No batches produced yet.'}
        />
      </div>
    </div>
  );
}

function Stat({ label, value, color }) {
  return <div><div style={{ fontSize: 11, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div><div style={{ fontSize: 17, fontWeight: 700, color: color || 'var(--t1)' }}>{value}</div></div>;
}
