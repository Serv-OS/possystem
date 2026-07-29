/**
 * PriceChanges — Purchasing → Price changes. (v5.5.922)
 *
 * Every cost movement per product, oldest cost → what it is now, from item_cost_history —
 * a table the costing engine has been quietly writing on every priced receipt and invoice
 * since the stock module shipped. Nothing here computes anything new; it SURFACES history
 * that already exists, because a supplier creeping prices 3% a month is invisible when the
 * only place a cost appears is the item editor.
 *
 * Costs are shown per COUNT UNIT (£/Bottle, not £/ml) using the item's count-default pack —
 * the same honesty rule as the v5.5.919 par fix. base_unit_cost × qtyInBase, display only.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { getActiveLocationSync, getLocationId, supabase, isMock } from '../../lib/supabase';
import { money } from '../../lib/currency';
import { fetchInventoryItems } from '../../lib/stock/data';
import { PageHeader, Tag } from './reports/reportKit';

const field = { background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };

export default function PriceChanges() {
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [rows, setRows] = useState(null);
  const [items, setItems] = useState([]);
  const [q, setQ] = useState('');
  const [days, setDays] = useState(90);
  const [onlyRises, setOnlyRises] = useState(false);

  useEffect(() => { if (!locId) getLocationId().then(id => id && setLocId(id)); }, [locId]);
  const load = useCallback(async () => {
    if (!locId || isMock || !supabase) { setRows([]); return; }
    const since = new Date(Date.now() - days * 86400000).toISOString();
    const [{ data: hist }, { data: its }] = await Promise.all([
      supabase.from('item_cost_history')
        .select('inventory_item_id, base_unit_cost, source, effective_from')
        .eq('location_id', locId).gte('effective_from', since)
        .order('effective_from', { ascending: true }).limit(4000),
      fetchInventoryItems(locId).then(r => ({ data: r.data || [] })),
    ]);
    setItems(its);
    // Collapse each item's history in the window into first→last, counting steps.
    const byItem = new Map();
    for (const h of (hist || [])) {
      const e = byItem.get(h.inventory_item_id);
      if (!e) byItem.set(h.inventory_item_id, { first: h, last: h, steps: 1 });
      else { e.last = h; e.steps++; }
    }
    setRows([...byItem.entries()].map(([itemId, e]) => ({ itemId, ...e })));
  }, [locId, days]);
  useEffect(() => { load(); }, [load]);

  const itemById = useMemo(() => Object.fromEntries(items.map(i => [i.id, i])), [items]);
  // £/count-unit conversion — display only, never stored.
  const perPack = useCallback((item, baseCost) => {
    const fmt = (item?.packaging || []).find(f => f.isCountDefault) || (item?.packaging || [])[0];
    if (!fmt || !(Number(fmt.qtyInBase) > 0)) return { cost: Number(baseCost), label: item?.baseUnit || '' };
    return { cost: Number(baseCost) * Number(fmt.qtyInBase), label: fmt.name };
  }, []);

  const view = useMemo(() => (rows || [])
    .map(r => {
      const item = itemById[r.itemId];
      if (!item) return null;
      const from = perPack(item, r.first.base_unit_cost);
      const to = perPack(item, r.last.base_unit_cost);
      const deltaPct = from.cost > 0 ? ((to.cost - from.cost) / from.cost) * 100 : (to.cost > 0 ? 100 : 0);
      return { ...r, item, from, to, deltaPct, changed: Math.abs(to.cost - from.cost) > 0.005 };
    })
    .filter(Boolean)
    .filter(r => r.changed)
    .filter(r => !onlyRises || r.deltaPct > 0)
    .filter(r => !q.trim() || r.item.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct)),
  [rows, itemById, perPack, onlyRises, q]);

  return (
    <div style={{ padding: '22px 26px', maxWidth: 980 }}>
      <PageHeader eyebrow="PURCHASING" title="Price changes"
        subtitle="How each product's cost has moved — biggest movers first. Prices per pack, from every priced delivery and invoice." />
      <div style={{ display: 'flex', gap: 10, margin: '14px 0', alignItems: 'center', flexWrap: 'wrap' }}>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search product…" style={{ ...field, width: 220 }} />
        <select value={days} onChange={e => setDays(Number(e.target.value))} style={{ ...field, cursor: 'pointer' }}>
          <option value={30}>Last 30 days</option><option value={90}>Last 90 days</option>
          <option value={180}>Last 6 months</option><option value={365}>Last year</option>
        </select>
        <label style={{ fontSize: 12.5, color: 'var(--t2)', display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyRises} onChange={e => setOnlyRises(e.target.checked)} /> Rises only
        </label>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--t3)' }}>{view.length} product{view.length === 1 ? '' : 's'} moved</span>
      </div>

      {rows == null && <div style={{ color: 'var(--t3)', fontSize: 13 }}>Loading…</div>}
      {rows != null && view.length === 0 && (
        <div style={{ color: 'var(--t3)', fontSize: 13, padding: '30px 0' }}>
          No price movements in this window. Costs update when deliveries are accepted with a price, or invoices are posted.
        </div>
      )}
      {view.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left', color: 'var(--t3)' }}>
              {['Product', 'Was', 'Now', 'Change', 'Updates', 'Last change'].map((h, i) => (
                <th key={h} style={{ padding: '8px 10px', borderBottom: '1px solid var(--bdr)', fontWeight: 600, textAlign: i >= 1 && i <= 4 ? 'right' : 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.map(r => (
              <tr key={r.itemId}>
                <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--bdr)', color: 'var(--t1)' }}>
                  {r.item.name} <span style={{ fontSize: 11, color: 'var(--t4)' }}>/ {r.to.label}</span>
                </td>
                <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--bdr)', textAlign: 'right', color: 'var(--t3)' }}>{money(r.from.cost)}</td>
                <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--bdr)', textAlign: 'right', color: 'var(--t1)', fontWeight: 700 }}>{money(r.to.cost)}</td>
                <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--bdr)', textAlign: 'right' }}>
                  <Tag label={`${r.deltaPct > 0 ? '+' : ''}${Math.round(r.deltaPct * 10) / 10}%`} tone={r.deltaPct > 0 ? 'bad' : 'good'} />
                </td>
                <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--bdr)', textAlign: 'right', color: 'var(--t3)' }}>{r.steps}</td>
                <td style={{ padding: '8px 10px', borderBottom: '1px solid var(--bdr)', color: 'var(--t3)', fontSize: 12 }}>
                  {new Date(r.last.effective_from).toLocaleDateString('en-GB')} <span style={{ color: 'var(--t4)' }}>· {r.last.source.toLowerCase()}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
