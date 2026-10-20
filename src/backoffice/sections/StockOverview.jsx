/**
 * StockOverview — the landing page for stock control (Inventory → Overview).
 * A guided, at-a-glance hub: stock value, a step-by-step setup checklist with live
 * status, "needs attention" prompts, and a live movement feed. Reads existing data
 * only (no migration). Designed to make the whole system feel like a guided process.
 */

import { useState, useEffect, useCallback } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { money, currencySymbol, signedMoney } from '../../lib/currency';
import { lineValue, negativeStock } from '../../lib/stock/valuation';
import { fetchInventoryItems, fetchSuppliers, fetchRecentMovements, movementLabel, fetchStockOutboxHealth, releaseStockOutbox, fetchCostRule, saveCostRule, fetchSharedStockStatus } from '../../lib/stock/data';
import { newsWords } from '../../lib/stock/company/stockCompanyRules';
import { COST_RULES, COST_RULE_WORDS, normCostRule } from '../../lib/stock/phase0Rules';
import { healthWords, heldReason } from '../../lib/stock/centralMode.js';
import { displayInUnits } from '../../lib/stock/uom';
import { fetchRecipes } from '../../lib/stock/recipes';
import { fetchPurchaseOrders } from '../../lib/stock/purchasing';
import { areasReady, fetchAreas, fetchAreaHoldings } from '../../lib/stock/areas';
import { areasBelowZero, countStatusText } from '../../lib/stock/areaRules';
import { fetchCounts } from '../../lib/stock/counts';

const card = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: 18 };

// 8 Oct 2026: canOpen is the Back Office section access rule (lib/boSections.js). A button that
// opens Produce or Purchasing is left out for a login that is not shown that part: never a dead
// button. The setter it is handed refuses a blocked route anyway (belt and braces).
export default function StockOverview({ setSection, canOpen = () => true }) {
  const menuItems = useStore(s => s.menuItems) || [];
  const showToast = useStore(s => s.showToast);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [d, setD] = useState(null);
  // v5.11.79 (stock plan 4.5, decision 2): where cost comes from at this venue.
  const [costRule, setCostRule] = useState(null);
  const [ruleBusy, setRuleBusy] = useState(false);
  // v5.11.80 (multi site stock): what head office changed here lately, and who the stock Editors are
  const [shared, setShared] = useState(null);

  const load = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    // 16 Oct 2026: stock areas (after the migration): the areas, the holdings below zero and the
    // counts that are ready to approve. Before it: nothing new on this page.
    const areasOn = await areasReady(loc);
    const [{ data: items }, { data: recipes }, { data: suppliers }, { data: pos }, { data: moves }, areaRes, holdRes, countRes, healthRes] = await Promise.all([
      fetchInventoryItems(loc), fetchRecipes(loc), fetchSuppliers(loc), fetchPurchaseOrders(loc), fetchRecentMovements(loc, 12),
      areasOn ? fetchAreas(loc) : Promise.resolve({ data: null }),
      areasOn ? fetchAreaHoldings(loc) : Promise.resolve({ data: {} }),
      areasOn ? fetchCounts(loc, 30) : Promise.resolve({ data: [] }),
      // v5.11.77 central stock depletion: the backlog card. Before migration 20261018c the RPC
      // does not exist and the card simply does not show.
      fetchStockOutboxHealth(loc).catch(() => ({ data: null, error: null })),
    ]);
    fetchCostRule(loc).then((r) => setCostRule(normCostRule(r?.data))).catch(() => setCostRule('price_list'));
    fetchSharedStockStatus(loc).then((r) => setShared(r?.data || null)).catch(() => setShared(null));
    setD({ items: items || [], recipes: recipes || [], suppliers: suppliers || [], pos: pos || [], moves: moves || [],
      areas: areaRes.data, holdings: holdRes.data || {}, counts: countRes.data || [],
      health: healthRes && !healthRes.error ? healthWords(healthRes.data) : null });
  }, [locId]);
  const [releasing, setReleasing] = useState(null);
  const [releaseMsg, setReleaseMsg] = useState('');
  const release = async (row) => {
    setReleasing(row.id); setReleaseMsg('');
    try {
      const { data, error } = await releaseStockOutbox(row.id);
      if (error) setReleaseMsg(error.message || 'Could not release it');
      else if (data && data.ok === false) setReleaseMsg(data.error || 'Could not release it');
      else setReleaseMsg('Released. Stock comes off on the next run (within a minute).');
      await load();
    } catch (e) { setReleaseMsg(e?.message || 'Could not release it'); }
    setReleasing(null);
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const go = (s) => setSection?.(s);
  const can = (s) => !!setSection && canOpen(s);

  if (!d) return <div style={{ padding: 26, color: 'var(--t3)' }}>Loading…</div>;

  const items = d.items.filter(i => !i.archivedAt);
  const purchasable = items.filter(i => i.kind === 'PURCHASED');
  const priced = purchasable.filter(i => i.currentCost != null && i.currentCost > 0);
  const noPrice = purchasable.filter(i => !(i.currentCost != null && i.currentCost > 0));
  // v5.11.65: stock below zero is worth nothing, not less than nothing (valuation.js); the
  // items below zero are named so the hole is seen, not folded into the total.
  const stockValue = items.reduce((s, i) => s + lineValue(i.onHand, i.currentCost), 0);
  const negatives = negativeStock(items);
  const negTotal = negatives.reduce((s, n) => s + n.value, 0);
  const withStock = items.filter(i => (Number(i.onHand) || 0) > 0);
  const dishes = d.recipes.filter(r => r.recipeType === 'MENU');
  const linkedMenuIds = new Set(dishes.map(r => String(r.menuItemId)).filter(Boolean));
  // a variants parent (a sized drink's container) is never sold and cannot carry a recipe, so it
  // is not a menu item "without a recipe" (Recipe GP leaves it out for the same reason)
  const parentIds = new Set(menuItems.filter(m => m.parentId && !m.archived).map(m => String(m.parentId)));
  const sellable = menuItems.filter(m => !m.archived && m.type !== 'subitem' && m.type !== 'variants' && !parentIds.has(String(m.id)));
  const unlinked = sellable.filter(m => !linkedMenuIds.has(String(m.id)));
  const itemName = (id) => items.find(i => i.id === id)?.name || '—';
  const areasOn = Array.isArray(d.areas);
  const areaCount = areasOn ? d.areas.length : 0;
  const belowAreas = areasOn ? areasBelowZero(d.holdings) : [];
  const belowItems = [...new Set(belowAreas.map(b => b.itemId))];
  const readyCounts = areasOn ? d.counts.filter(c => c.status !== 'APPROVED' && countStatusText(c.areas).ready) : [];

  const steps = [
    { n: 1, label: 'Add your stock items', done: items.length > 0, detail: `${items.length} item${items.length === 1 ? '' : 's'}`, cta: 'Stock items', to: 'stock-items' },
    // 16 Oct 2026: "the storage locations need to be set ahead of time"; the step shows until the venue has areas
    ...(areasOn && areaCount === 0 ? [{ n: 2, label: 'Set up your stock areas', done: false, detail: 'Cellar, fridges, freezer, dry store, bar: where stock lives and where counts happen', cta: 'Stock areas', to: 'stock-areas' }] : []),
    { n: 2, label: 'Set a price on each item', done: purchasable.length > 0 && noPrice.length === 0, detail: `${priced.length} of ${purchasable.length} priced`, cta: 'Add prices', to: 'stock-items' },
    { n: 3, label: 'Build recipes & link to menu', done: dishes.length > 0, detail: `${dishes.length} dish recipe${dishes.length === 1 ? '' : 's'} · ${unlinked.length} menu item${unlinked.length === 1 ? '' : 's'} without one`, cta: 'Recipes', to: 'recipes' },
    { n: 4, label: areasOn && areaCount > 0 ? 'Count by area' : 'Count your stock on hand', done: withStock.length > 0, detail: `${withStock.length} item${withStock.length === 1 ? '' : 's'} with stock`, cta: 'Stock counts', to: 'stock-counts' },
    { n: 5, label: 'Add suppliers & receive deliveries', done: d.suppliers.length > 0, detail: `${d.suppliers.length} supplier${d.suppliers.length === 1 ? '' : 's'} · ${d.pos.length} order${d.pos.length === 1 ? '' : 's'}`, cta: 'Purchasing', to: 'suppliers' },
  ].map((s, i) => ({ ...s, n: i + 1 }));
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
        {stat('Stock value', money(stockValue), negatives.length
          ? `${items.length} item${items.length === 1 ? '' : 's'} tracked · ${negatives.length} below zero (${signedMoney(negTotal)} left out)`
          : `${items.length} item${items.length === 1 ? '' : 's'} tracked`, negatives.length && can('stock-counts') ? () => go('stock-counts') : null)}
        {stat('Need a price', String(noPrice.length), noPrice.length ? 'tap to fix' : 'all priced ✓', noPrice.length ? () => go('stock-items') : null, noPrice.length ? 'var(--red, #ef4444)' : 'var(--grn, #16a34a)')}
        {stat('Recipes', String(dishes.length), `${unlinked.length} menu items unlinked`, can('recipes') ? () => go('recipes') : null)}
        {stat('Suppliers', String(d.suppliers.length), `${d.pos.length} purchase order${d.pos.length === 1 ? '' : 's'}`, can('suppliers') ? () => go('suppliers') : null)}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.3fr) minmax(0, 1fr)', gap: 18, alignItems: 'start' }}>
        {/* Guided setup */}
        <div style={card}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>Set up your stock</div>
            <div style={{ fontSize: 12, color: 'var(--t3)' }}>{doneCount}/{steps.length} done</div>
          </div>
          <div style={{ height: 6, background: 'var(--bg3)', borderRadius: 3, overflow: 'hidden', margin: '8px 0 16px' }}>
            <div style={{ width: `${(doneCount / steps.length) * 100}%`, height: '100%', background: 'var(--grn, #16a34a)', transition: 'width .3s' }} />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {steps.map(s => (
              <div key={s.n} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 12px', borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--bdr)' }}>
                <div style={{ width: 26, height: 26, borderRadius: '50%', flexShrink: 0, display: 'grid', placeItems: 'center', fontSize: 13, fontWeight: 800, background: s.done ? 'var(--grn, #16a34a)' : 'var(--bg4, var(--bg3))', color: s.done ? '#fff' : 'var(--t3)' }}>{s.done ? '✓' : s.n}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{s.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 1 }}>{s.detail}</div>
                </div>
                {can(s.to) && <button onClick={() => go(s.to)} style={{ padding: '6px 12px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: 'pointer', background: s.done ? 'var(--bg3)' : 'var(--acc)', color: s.done ? 'var(--t2)' : '#fff', border: s.done ? '1px solid var(--bdr)' : 0, flexShrink: 0 }}>{s.cta}</button>}
              </div>
            ))}
          </div>
        </div>

        {/* Right column: attention + activity */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {shared?.shared && (
            <div style={card} data-testid="stock-head-office">
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>Head office stock</div>
              <div style={{ fontSize: 13, color: 'var(--t2)', lineHeight: 1.5 }}>
                {newsWords(shared.news, (iso) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' })) || 'Nothing changed by head office in the last 14 days.'}
                {Array.isArray(shared.news?.names) && shared.news.names.length > 0 && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4 }}>{shared.news.names.slice(0, 8).join(', ')}{shared.news.names.length > 8 ? ' and more' : ''}</div>}
                <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6 }}>{shared.managed_items} stock items here are managed by head office{shared.editors ? ` (stock Editors: ${shared.editors})` : ''}. New items arrive with nothing on hand: count them.</div>
              </div>
            </div>
          )}
          {costRule && (
            <div style={card} data-testid="stock-cost-rule">
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 6 }}>Cost here</div>
              {COST_RULES.map((r) => (
                <label key={r} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '6px 0', cursor: ruleBusy ? 'default' : 'pointer' }}>
                  <input type="radio" name="cost-rule" checked={costRule === r} disabled={ruleBusy}
                    onChange={async () => {
                      setRuleBusy(true);
                      const { error } = await saveCostRule(r, null, locId);
                      setRuleBusy(false);
                      if (error) { showToast?.(`Cost rule not saved: ${error.message || error}`, 'error'); return; }
                      setCostRule(r);
                      showToast?.(`${COST_RULE_WORDS[r].label}: saved. No cost changed now; the next price save or delivery follows it.`, 'success');
                    }} />
                  <span>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--t1)' }}>{COST_RULE_WORDS[r].label}{r === 'price_list' ? ' (the default)' : ''}</span>
                    <span style={{ display: 'block', fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>{COST_RULE_WORDS[r].help}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          {(noPrice.length > 0 || unlinked.length > 0 || negatives.length > 0 || belowAreas.length > 0 || readyCounts.length > 0) && (
            <div style={card}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 10 }}>Needs attention</div>
              {readyCounts.length > 0 && (
                <Attn color="var(--grn, #16a34a)" title={`${readyCounts.length} count${readyCounts.length === 1 ? '' : 's'} ready to approve`} sub="every area is marked complete" items={readyCounts.slice(0, 4).map(c => c.name)} cta="Stock counts" onClick={can('stock-counts') ? () => go('stock-counts') : null} />
              )}
              {belowAreas.length > 0 && (
                <Attn color="var(--red, #ef4444)" title={`${belowAreas.length} area holding${belowAreas.length === 1 ? '' : 's'} below zero`} sub="sold or used from an area that never received it: record the move from the cellar, or count that area" items={belowItems.slice(0, 4).map(itemName)} cta="Stock items" onClick={can('stock-items') ? () => go('stock-items') : null} />
              )}
              {noPrice.length > 0 && (
                <Attn color="var(--red, #ef4444)" title={`${noPrice.length} item${noPrice.length === 1 ? '' : 's'} with no price`} sub="costs & GP can’t be worked out until these have a supplier price" items={noPrice.slice(0, 4).map(i => i.name)} cta="Fix prices" onClick={() => go('stock-items')} />
              )}
              {negatives.length > 0 && (
                <Attn color="var(--red, #ef4444)" title={`${negatives.length} item${negatives.length === 1 ? '' : 's'} below zero`} sub={`more sold or used than was ever received (${signedMoney(negTotal)} not counted in the value). Record the delivery or batch, or count the shelf.`} items={negatives.slice(0, 4).map(n => n.name)} cta="Stock counts" onClick={can('stock-counts') ? () => go('stock-counts') : null} />
              )}
              {unlinked.length > 0 && (
                <Attn color="#e8a020" title={`${unlinked.length} menu item${unlinked.length === 1 ? '' : 's'} without a recipe`} sub="these won’t deplete stock or show a cost when sold" items={unlinked.slice(0, 4).map(i => i.name)} cta="Build recipes" onClick={can('recipes') ? () => go('recipes') : null} />
              )}
            </div>
          )}

          {d.health && (
            <div style={{ ...card, borderLeft: `3px solid ${d.health.tone === 'alert' ? 'var(--red, #ef4444)' : d.health.tone === 'warn' ? '#e8a020' : d.health.tone === 'ok' ? 'var(--grn, #16a34a)' : 'var(--bdr)'}` }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)' }}>{d.health.title}</div>
              <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4 }}>{d.health.sub}</div>
              {d.health.mode !== 'browser' && d.health.pending === 0 && d.health.held === 0 && d.health.dead === 0 && (
                <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4 }}>Stock screens trail a sale by about 3 seconds, up to a minute.</div>
              )}
              {d.health.needsPerson.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
                  {d.health.needsPerson.slice(0, 5).map(row => (
                    <div key={row.id} style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--bg2)', border: '1px solid var(--bdr)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {row.kind === 'sale' ? 'Sale' : row.kind === 'refund' ? 'Refund' : row.kind === 'tomb' ? 'Void' : row.kind} · {row.check_id}
                        </div>
                        <button disabled={releasing === row.id} onClick={() => release(row)}
                          style={{ padding: '5px 10px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: 'var(--bg3)', color: 'var(--t1)', border: '1px solid var(--bdr)', flexShrink: 0 }}>
                          {releasing === row.id ? 'Releasing…' : 'Release'}
                        </button>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>{heldReason(row)}</div>
                    </div>
                  ))}
                  {d.health.needsPerson.length > 5 && <div style={{ fontSize: 11, color: 'var(--t4)' }}>and {d.health.needsPerson.length - 5} more</div>}
                </div>
              )}
              {releaseMsg && <div style={{ fontSize: 11, color: 'var(--t2)', marginTop: 8 }}>{releaseMsg}</div>}
            </div>
          )}

          <div style={card}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--t1)', marginBottom: 10 }}>Recent stock movements</div>
            {d.moves.length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No movements yet. Set a count, receive a delivery, or ring up a recipe-linked item to see activity here.</div>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {d.moves.map(m => {
                const pos = m.qtyBase >= 0;
                const it = (d.items || []).find(x => x.id === m.inventoryItemId);
                const disp = it ? displayInUnits(m.qtyBase, { baseUnit: it.baseUnit, formats: it.packaging || [] }) : { qty: Math.round(m.qtyBase * 1000) / 1000, label: '' };
                return (
                  <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
                    <span style={{ width: 92, color: 'var(--t3)', flexShrink: 0 }}>{movementLabel(m.movementType)}</span>
                    <span style={{ flex: 1, minWidth: 0, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{itemName(m.inventoryItemId)}</span>
                    <span style={{ color: pos ? 'var(--grn, #16a34a)' : 'var(--red, #ef4444)', flexShrink: 0 }}>{pos ? '+' : ''}{disp.qty} {disp.label}</span>
                    <span style={{ width: 60, textAlign: 'right', color: 'var(--t3)', flexShrink: 0 }}>{m.valueDelta == null ? '' : signedMoney(m.valueDelta)}</span>
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
        {onClick && <button onClick={onClick} style={{ padding: '5px 10px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer', background: 'var(--bg3)', color: 'var(--t1)', border: '1px solid var(--bdr)', flexShrink: 0 }}>{cta}</button>}
      </div>
      <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>{sub}</div>
      {items.length > 0 && <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4 }}>{items.join(' · ')}{items.length >= 4 ? ' …' : ''}</div>}
    </div>
  );
}
