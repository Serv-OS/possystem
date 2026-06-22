/**
 * StockCounts — par levels + physical stock counts (Inventory → Stock counts).
 * Mobile-friendly: start a count, walk the shelf entering what you actually have,
 * see live variance vs the system, then Approve to reconcile on-hand (posts
 * STOCK_COUNT_ADJ). Requires the par/counts migration (20260622_par_counts.sql).
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { money } from '../../lib/currency';
import { fetchInventoryItems } from '../../lib/stock/data';
import { fetchCounts, fetchCount, createCount, saveCountLine, approveCount, setCountStatus } from '../../lib/stock/counts';

const field = { background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '10px 12px', fontSize: 16, outline: 'none', boxSizing: 'border-box', textAlign: 'right' };
const r3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

export default function StockCounts() {
  const showToast = useStore(s => s.showToast);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [items, setItems] = useState([]);
  const [counts, setCounts] = useState([]);
  const [active, setActive] = useState(null);   // { ...count, lines }
  const [edits, setEdits] = useState({});       // lineId -> value (local)
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const [{ data: its }, { data: cs }] = await Promise.all([fetchInventoryItems(loc), fetchCounts(loc)]);
    setItems(its || []); setCounts(cs || []); setLoading(false);
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const itemName = useCallback((id) => items.find(i => i.id === id)?.name || '—', [items]);
  const itemUnit = useCallback((id) => items.find(i => i.id === id)?.baseUnit || '', [items]);

  const openCount = async (id) => {
    const { data } = await fetchCount(id, locId);
    if (data) { setActive(data); setEdits({}); }
  };
  const startCount = async () => {
    setBusy(true);
    const { data, error } = await createCount({ name: `Count ${new Date().toLocaleDateString()}`, countType: 'FULL' }, locId);
    setBusy(false);
    if (error) { showToast?.(error.message, 'error'); return; }
    await reload();
    if (data) openCount(data.id);
  };
  const onEdit = (lineId, v) => setEdits(e => ({ ...e, [lineId]: v }));
  const onBlur = async (line) => {
    const v = edits[line.id];
    if (v === undefined) return;
    await saveCountLine(line.id, v, locId);
  };
  const flush = async () => {
    for (const [lineId, v] of Object.entries(edits)) await saveCountLine(lineId, v, locId);
  };
  const approve = async () => {
    if (!confirm('Approve this count? It will adjust on-hand to your counted figures and post the differences to the ledger.')) return;
    setBusy(true);
    await flush();
    const { error } = await approveCount(active.id, locId);
    setBusy(false);
    if (error) { showToast?.(error.message, 'error'); return; }
    showToast?.('Count approved — stock reconciled', 'success');
    const { data } = await fetchCount(active.id, locId);
    setActive(data); setEdits({}); await reload();
  };

  if (loading) return <div style={{ padding: 26, color: 'var(--t3)' }}>Loading…</div>;

  // ── Count sheet ──
  if (active) {
    const approved = active.status === 'APPROVED';
    const countedNum = active.lines.filter(l => (edits[l.id] ?? l.countedQty) != null && (edits[l.id] ?? l.countedQty) !== '').length;
    return (
      <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '18px 20px', maxWidth: 640, margin: '0 auto' }}>
        <button onClick={() => { setActive(null); reload(); }} style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 13, marginBottom: 10 }}>← All counts</button>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 4 }}>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, color: 'var(--t1)' }}>{active.name}</h1>
          <span style={{ fontSize: 11, fontWeight: 700, color: approved ? 'var(--grn, #16a34a)' : 'var(--t3)' }}>{active.status}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 14 }}>{countedNum}/{active.lines.length} counted{approved ? ` · variance ${money(active.varianceValue || 0)}` : ''}</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 80 }}>
          {active.lines.map(line => {
            const val = edits[line.id] ?? (line.countedQty ?? '');
            const counted = val === '' || val == null ? null : Number(val);
            const variance = counted == null ? null : counted - line.expectedQty;
            return (
              <div key={line.id} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 10, padding: '10px 14px' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, color: 'var(--t1)' }}>{itemName(line.inventoryItemId)}</div>
                  <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 1 }}>
                    system: {r3(line.expectedQty)} {itemUnit(line.inventoryItemId)}
                    {variance != null && variance !== 0 && <span style={{ color: variance < 0 ? 'var(--red, #ef4444)' : 'var(--grn, #16a34a)', marginLeft: 8 }}>{variance > 0 ? '+' : ''}{r3(variance)}</span>}
                  </div>
                </div>
                <input type="number" inputMode="decimal" step="any" disabled={approved} value={val}
                  onChange={e => onEdit(line.id, e.target.value)} onBlur={() => onBlur(line)}
                  placeholder="count" style={{ ...field, width: 96 }} />
                <span style={{ fontSize: 12, color: 'var(--t3)', width: 28 }}>{itemUnit(line.inventoryItemId)}</span>
              </div>
            );
          })}
        </div>

        {!approved && (
          <div style={{ position: 'sticky', bottom: 0, background: 'var(--bg0)', padding: '12px 0', borderTop: '1px solid var(--bdr)', display: 'flex', gap: 10 }}>
            <button onClick={flush} style={{ flex: 1, padding: '12px', borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t1)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Save progress</button>
            <button onClick={approve} disabled={busy} style={{ flex: 2, padding: '12px', borderRadius: 10, background: 'var(--grn, #16a34a)', color: '#fff', border: 0, fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>{busy ? 'Approving…' : 'Approve & reconcile stock'}</button>
          </div>
        )}
      </div>
    );
  }

  // ── Count list ──
  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px', maxWidth: 720 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--t1)' }}>Stock counts</h1>
        <button onClick={startCount} disabled={busy || items.length === 0} style={{ padding: '10px 18px', borderRadius: 9, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 14, fontWeight: 700, cursor: 'pointer', opacity: (busy || !items.length) ? 0.6 : 1 }}>+ New count</button>
      </div>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 18 }}>Count what you physically have; Approve reconciles the system to your count and records the variance (feeds “The Gap” report).</div>
      {items.length === 0 && <div style={{ fontSize: 13, color: 'var(--t3)' }}>Add some stock items first (Inventory → Stock items).</div>}
      {counts.length === 0 && items.length > 0 && <div style={{ fontSize: 13, color: 'var(--t3)' }}>No counts yet. Press “New count” to walk the shelves.</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {counts.map(c => (
          <div key={c.id} onClick={() => openCount(c.id)} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 10, padding: '12px 16px', cursor: 'pointer' }}>
            <div>
              <div style={{ fontSize: 14, color: 'var(--t1)' }}>{c.name}</div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>{new Date(c.createdAt).toLocaleString()}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: c.status === 'APPROVED' ? 'var(--grn, #16a34a)' : 'var(--t3)' }}>{c.status}</div>
              {c.varianceValue != null && <div style={{ fontSize: 12, color: c.varianceValue < 0 ? 'var(--red, #ef4444)' : 'var(--t2)', marginTop: 2 }}>{money(c.varianceValue)}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
