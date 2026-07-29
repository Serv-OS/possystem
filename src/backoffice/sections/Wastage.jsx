/**
 * Wastage — log waste against stock items (Inventory → Wastage). Slice 5.
 * Logging posts a WASTE movement (valued at cost) + an audit row. Requires the
 * wastage migration (20260622b_wastage.sql).
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { money } from '../../lib/currency';
import { UNITS, DIMENSIONS } from '../../lib/stock/units';
import { fetchInventoryItems } from '../../lib/stock/data';
import PosWasteModal from '../../components/PosWasteModal';
import { logWaste, fetchWaste, WASTE_REASONS } from '../../lib/stock/waste';

const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };
const UNIT_OPTS = Object.entries(UNITS).map(([code, u]) => ({ code, ...u }));
const DIM_ORDER = [DIMENSIONS.COUNT, DIMENSIONS.WEIGHT, DIMENSIONS.VOLUME];
const isoDaysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(0, 0, 0, 0); return d.toISOString(); };

export default function Wastage() {
  const showToast = useStore(s => s.showToast);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [items, setItems] = useState([]);
  const [showProductWaste, setShowProductWaste] = useState(false);
  const [log, setLog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [row, setRow] = useState({ item: null, qty: '', unit: 'each', reason: WASTE_REASONS[0], note: '' });
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const [{ data: its }, { data: w }] = await Promise.all([fetchInventoryItems(loc), fetchWaste(isoDaysAgo(30), null, loc)]);
    setItems(its || []); setLog(w || []); setLoading(false);
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return items.filter(i => !i.archivedAt && i.name.toLowerCase().includes(s)).slice(0, 8);
  }, [q, items]);
  const total = useMemo(() => log.reduce((s, w) => s + (w.costValue || 0), 0), [log]);
  const lostSaleTotal = useMemo(() => log.reduce((s, w) => s + (w.saleValue || 0), 0), [log]);

  const pick = (it) => { setRow(r => ({ ...r, item: it, unit: it.baseUnit })); setQ(''); };
  const submit = async () => {
    if (!row.item) { showToast?.('Pick an item', 'error'); return; }
    if (!(Number(row.qty) > 0)) { showToast?.('Enter a quantity', 'error'); return; }
    setBusy(true);
    const { error } = await logWaste({ inventoryItemId: row.item.id, qty: row.qty, unit: row.unit, reason: row.reason, note: row.note }, locId);
    setBusy(false);
    if (error) { showToast?.(error.message, 'error'); return; }
    showToast?.('Waste logged', 'success');
    setRow({ item: null, qty: '', unit: 'each', reason: WASTE_REASONS[0], note: '' });
    await reload();
  };

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px', maxWidth: 900 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px', color: 'var(--t1)' }}>Wastage</h1>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 18 }}>Record spoilage, breakage, over-production etc. It comes off stock and is valued at cost — and counts as explained loss, so it doesn’t show up as a mystery in “The Gap”.</div>

      {/* Log form */}
      <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, marginBottom: 24 }}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginRight: 'auto' }}>Log waste</div>
          {/* v5.5.927: BO could only waste STOCK items. Wasting a SELLING item (a dropped
              burger) goes through the same modal the POS uses — recipe explosion deducts
              the patty, records cost AND the lost sale. One behaviour everywhere. */}
          <button onClick={() => setShowProductWaste(true)} style={{ padding: '7px 13px', borderRadius: 8, background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t1)', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
            Waste a menu item…
          </button>
        </div>
        {!row.item ? (
          <div style={{ position: 'relative', maxWidth: 360 }}>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search a stock item…" style={field} />
            {matches.length > 0 && (
              <div style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, marginTop: 4, overflow: 'hidden', boxShadow: '0 10px 30px rgba(0,0,0,0.3)' }}>
                {matches.map(i => <div key={i.id} onClick={() => pick(i)} style={{ padding: '9px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--t1)' }}>{i.name}</div>)}
              </div>
            )}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 160 }}><label style={lbl}>Item</label><div style={{ ...field, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>{row.item.name}<button onClick={() => setRow(r => ({ ...r, item: null }))} style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer' }}>×</button></div></div>
            <div><label style={lbl}>Qty</label><input type="number" min="0" step="any" value={row.qty} onChange={e => setRow(r => ({ ...r, qty: e.target.value }))} style={{ ...field, width: 90 }} /></div>
            <div><label style={lbl}>Unit</label>
              <select value={row.unit} onChange={e => setRow(r => ({ ...r, unit: e.target.value }))} style={{ ...field, width: 120 }}>
                {DIM_ORDER.map(dim => <optgroup key={dim} label={dim[0] + dim.slice(1).toLowerCase()}>{UNIT_OPTS.filter(u => u.dimension === dim).map(u => <option key={u.code} value={u.code}>{u.code}</option>)}</optgroup>)}
              </select>
            </div>
            <div><label style={lbl}>Reason</label>
              <select value={row.reason} onChange={e => setRow(r => ({ ...r, reason: e.target.value }))} style={{ ...field, width: 160 }}>
                {WASTE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div style={{ flex: 1, minWidth: 140 }}><label style={lbl}>Note</label><input value={row.note} onChange={e => setRow(r => ({ ...r, note: e.target.value }))} style={field} placeholder="optional" /></div>
            <button onClick={submit} disabled={busy} style={{ padding: '9px 18px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>Log waste</button>
          </div>
        )}
      </div>

      {/* Log */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>Last 30 days</div>
        <div style={{ fontSize: 14, color: 'var(--t1)' }}>Waste at cost: <b style={{ color: 'var(--red, #ef4444)' }}>{money(total)}</b>{lostSaleTotal > 0 && <span> · lost sales: <b style={{ color: 'var(--red, #ef4444)' }}>{money(lostSaleTotal)}</b></span>}</div>
      </div>
      {loading && <div style={{ fontSize: 12, color: 'var(--t3)' }}>Loading…</div>}
      {!loading && log.length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No waste logged yet.</div>}
      {log.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead><tr style={{ color: 'var(--t3)', textAlign: 'left' }}>{['Date', 'Item', 'Qty', 'Reason', 'Cost', 'Lost sale', 'Note'].map(h => <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid var(--bdr)', fontWeight: 600 }}>{h}</th>)}</tr></thead>
          <tbody>{log.map(w => (
            <tr key={w.id} style={{ color: 'var(--t1)' }}>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: 'var(--t3)' }}>{new Date(w.occurredAt).toLocaleString()}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)' }}>{w.itemName}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)' }}>{w.qty} {w.unit}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: 'var(--t3)' }}>{w.reason}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)' }}>{w.costValue == null ? '—' : money(w.costValue)}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: 'var(--t3)' }}>{w.saleValue == null ? '—' : money(w.saleValue)}</td>
              <td style={{ padding: '6px 8px', borderBottom: '1px solid var(--bg2)', color: 'var(--t3)' }}>{w.note || ''}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <PosWasteModal open={showProductWaste} onClose={() => { setShowProductWaste(false); reload(); }} showToast={showToast} />
    </div>
  );
}
