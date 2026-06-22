/**
 * StockOverview — the landing page for stock control (Inventory → Overview).
 * A guided, at-a-glance hub: stock value, a step-by-step setup checklist with live
 * status, "needs attention" prompts, and a live movement feed. Reads existing data
 * only (no migration). Designed to make the whole system feel like a guided process.
 */

import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { money, currencySymbol } from '../../lib/currency';
import { fetchInventoryItems, fetchSuppliers, fetchRecentMovements, movementLabel } from '../../lib/stock/data';
import { fetchRecipes } from '../../lib/stock/recipes';
import { fetchPurchaseOrders } from '../../lib/stock/purchasing';

const card = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 18 };

export default function StockOverview({ setSection }) {
  const menuItems = useStore(s => s.menuItems) || [];
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [d, setD] = useState(null);

  const load = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const [{ data: items }, { data: recipes }, { data: suppliers }, { data: pos }, { data: moves }] = await Promise.all([
      fetchInventoryItems(loc), fetchRecipes(loc), fetchSuppliers(loc), fetchPurchaseOrders(loc), fetchRecentMovements(loc, 12),
    ]);
    setD({ items: items || [], recipes: recipes || [], suppliers: suppliers || [], pos: pos || [], moves: moves || [] });
  }, [locId]);
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const go = (s) => setSection?.(s);

  if (!d) return <div style={{ padding: 26, color: 'var(--t3)' }}>Loading…</div>;

  const items = d.items.filter(i => !i.archivedAt);
  const purchasable = items.filter(i => i.kind === 'PURCHASED');
  const priced = purchasable.filter(i => i.currentCost != null && i.currentCost > 0);
  const noPrice = purchasable.filter(i => !(i.currentCost != null && i.currentCost > 0));
  const stockValue = items.reduce((s, i) => s + (Number(i.onHand) || 0) * (Number(i.currentCost) || 0), 0);
  const withStock = items.filter(i => (Number(i.onHand) || 0) > 0);
  const dishes = d.recipes.filter(r => r.recipeType === 'MENU');
  const linkedMenuIds = new Set(dishes.map(r => String(r.menuItemId)).filter(Boolean));
  const sellable = menuItems.filter(m => !m.archived && m.type !== 'subitem');
  const unlinked = sellable.filter(m => !linkedMenuIds.has(String(m.id)));
  const itemName = (id) => items.find(i => i.id === id)?.name || '—';

  const steps = [
    { n: 1, label: 'Add your stock items', done: items.length > 0, detail: `${items.length} item${items.length === 1 ? '' : 's'}`, cta: 'Stock items', to: 'stock-items' },
    { n: 2, label: 'Set a price on each item', done: purchasable.length > 0 && noPrice.length === 0, detail: `${priced.length} of ${purchasable.length} priced`, cta: 'Add prices', to: 'stock-items' },
    { n: 3, label: 'Build recipes & link to menu', done: dishes.length > 0, detail: `${dishes.length} dish recipe${dishes.length === 1 ? '' : 's'} · ${unlinked.length} menu item${unlinked.length === 1 ? '' : 's'} without one`, cta: 'Recipes', to: 'recipes' },
    { n: 4, label: 'Count your stock on hand', done: withStock.length > 0, detail: `${withStock.length} item${withStock.length === 1 ? '' : 's'} with stock`, cta: 'Set counts', to: 'stock-items' },
    { n: 5, label: 'Add suppliers & receive deliveries', done: d.suppliers.length > 0, detail: `${d.suppliers.length} supplier${d.suppliers.length === 1 ? '' : 's'} · ${d.pos.length} order${d.pos.length === 1 ? '' : 's'}`, cta: 'Purchasing', to: 'suppliers' },
  ];
  const doneCount = steps.filter(s => s.done).length;

  const stat = (label, value, sub, onClick, accent) => (
    <div onClick={onClick} style={{ ...card, flex: 1, minWidth: 150, cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: accent || 'var(--t1)', marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>{sub}</div>}
    </div>
  );

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '24px 26px' }}>
      <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 2px', color: 'var(--t1)' }}>Stock control</h1>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 20 }}>Your live stock value, costs and movements — and a guided setup so it’s right end to end.</div>

      {/* Stat row */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 22 }}>
        {stat('Stock on hand', money(stockValue), `${items.length} item${items.length === 1 ? '' : 's'} tracked`)}
        {stat('Need a price', String(noPrice.length), noPrice.length ? 'tap to fix' : 'all priced ✓', noPrice.length ? () => go('stock-items') : null, noPrice.length ? 'var(--red, #ef4444)' : 'var(--grn, #16a34a)')}
        {stat('Recipes', String(dishes.length), `${unlinked.length} menu items unlinked`, () => go('recipes'))}
        {stat('Suppliers', String(d.suppliers.length), `${d.pos.length} purchase order${d.pos.length === 1 ? '' : 's'}`, () => go('suppliers'))}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)', gap: 18, alignItems: 'start' }}>
        {/* Guided setup */}
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>Set up your stock</div>
            <div style={{ fontSize: 12, color: 'var(--t3)' }}>{doneCount}/5 done</div>
          </div>
          <div style={{ height: 6, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden', margin: '8px 0 16px' }}>
            <div style={{ width: `${(doneCount / 5) * 100}%`, height: '100%', background: 'var(--grn, #16a34a)', transition: 'width .3s' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {steps.map(s => (
              <div key={s.n} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--bdr)' }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', fontSize: 13, fontWeight: 800, background: s.done ? 'var(--grn, #16a34a)' : 'var(--bg4, var(--bg3))', color: s.done ? '#fff' : 'var(--t3)' }}>{s.done ? '✓' : s.n}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{s.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 1 }}>{s.detail}</div>
                </div>
                <button onClick={() => go(s.to)} style={{ padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: s.done ? 'var(--bg3)' : 'var(--acc)', color: s.done ? 'var(--t2)' : '#fff', border: s.done ? '1px solid var(--bdr)' : 0, flexShrink: 0 }}>{s.cta}</button>
              </div>
            ))}
          </div>
        </div>

        {/* Right column: attention + activity */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {(noPrice.length > 0 || unlinked.length > 0) && (
            <div style={card}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 10 }}>Needs attention</div>
              {noPrice.length > 0 && (
                <Attn color="var(--red, #ef4444)" title={`${noPrice.length} item${noPrice.length === 1 ? '' : 's'} with no price`} sub="costs & GP can’t be worked out until these have a supplier price" items={noPrice.slice(0, 4).map(i => i.name)} cta="Fix prices" onClick={() => go('stock-items')} />
              )}
              {unlinked.length > 0 && (
                <Attn color="#e8a020" title={`${unlinked.length} menu item${unlinked.length === 1 ? '' : 's'} without a recipe`} sub="these won’t deplete stock or show a cost when sold" items={unlinked.slice(0, 4).map(i => i.name)} cta="Build recipes" onClick={() => go('recipes')} />
              )}
            </div>
          )}

          <div style={card}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 10 }}>Recent stock movements</div>
            {d.moves.length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No movements yet. Set a count, receive a delivery, or ring up a recipe-linked item to see activity here.</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {d.moves.map(m => {
                const pos = m.qtyBase >= 0;
                return (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                    <span style={{ width: 92, color: 'var(--t3)', flexShrink: 0 }}>{movementLabel(m.movementType)}</span>
                    <span style={{ flex: 1, minWidth: 0, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{itemName(m.inventoryItemId)}</span>
                    <span style={{ color: pos ? 'var(--grn, #16a34a)' : 'var(--red, #ef4444)', flexShrink: 0 }}>{pos ? '+' : ''}{Math.round(m.qtyBase * 1000) / 1000}</span>
                    <span style={{ width: 60, textAlign: 'right', color: 'var(--t3)', flexShrink: 0 }}>{m.valueDelta == null ? '' : money(m.valueDelta)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Attn({ color, title, sub, items, cta, onClick }) {
  return (
    <div style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderLeft: `3px solid ${color}`, marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{title}</div>
        <button onClick={onClick} style={{ padding: '5px 10px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: 'var(--bg3)', color: 'var(--t1)', border: '1px solid var(--bdr)', flexShrink: 0 }}>{cta}</button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>{sub}</div>
      {items.length > 0 && <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4 }}>{items.join(' · ')}{items.length >= 4 ? ' …' : ''}</div>}
    </div>
  );
}
