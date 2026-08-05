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
import { fetchCounts, fetchCount, createCount, saveCountLine, approveCount, deleteCount, removeCountLine } from '../../lib/stock/counts';
import { toBase, fromBase, formatToken } from '../../lib/stock/uom';
import { reportSave } from '../../lib/saveHealth';

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

  // Unit helpers — count in the item's friendly units (Keg / Case / Bottle / base), mixed allowed.
  const itemsById = {}; (items || []).forEach(i => { itemsById[i.id] = i; });
  const uomFor = (id) => { const i = itemsById[id]; return i ? { baseUnit: i.baseUnit, itemConversions: (i.conversions || []).map(c => ({ fromQty: c.fromQty, fromUnit: c.fromUnit, toQty: c.toQty, toUnit: c.toUnit })), formats: (i.packaging || []).map(f => ({ id: f.id, name: f.name, qtyInBase: f.qtyInBase })) } : { baseUnit: 'each', itemConversions: [], formats: [] }; };
  // Count ONLY in the item's named units (Bottle/Case) when it has them — the base
  // unit (ml/g) is maths-only and never shown for counting. Fall back to base unit
  // for loose items with no packs defined.
  const countUnitsFor = (id) => { const u = uomFor(id); const fmts = [...u.formats].sort((a, b) => b.qtyInBase - a.qtyInBase).map(f => ({ token: formatToken(f.id), label: f.name })); return fmts.length ? fmts : [{ token: u.baseUnit, label: u.baseUnit }]; };
  const defaultTokenFor = (id) => { const i = itemsById[id]; const cd = (i?.packaging || []).find(f => f.isCountDefault); return cd ? formatToken(cd.id) : (i?.baseUnit || 'each'); };
  const countedBase = (line) => {
    const e = edits[line.id]; if (!e) return null;
    const u = uomFor(line.inventoryItemId);
    let any = false, sum = 0;
    for (const [tok, v] of Object.entries(e)) { if (v === '' || v == null) continue; const n = Number(v); if (!Number.isFinite(n)) continue; any = true; try { sum += toBase(n, tok, u); } catch { /* skip bad unit */ } }
    return any ? sum : null;
  };

  // v5.5.823: counts were create-only — an unwanted sheet could never be cleared.
  // Both paths refuse APPROVED counts server-side too, because approving posts
  // STOCK_COUNT_ADJ movements that The Gap measures against.
  const removeCount = async (e, c) => {
    e.stopPropagation();
    if (!window.confirm(`Delete "${c.name}"? This count hasn't been approved, so no stock will change.`)) return;
    setBusy(true);
    const { error } = await deleteCount(c.id, locId);
    setBusy(false);
    reportSave('stock count delete', error);
    if (error) { showToast(error.message || 'Could not delete the count', 'error'); return; }
    if (active?.id === c.id) setActive(null);
    showToast(`"${c.name}" deleted`, 'info');
    reload();
  };

  const removeLine = async (line) => {
    const name = itemName(line.inventoryItemId);
    if (!window.confirm(`Remove ${name} from this count?`)) return;
    const { error } = await removeCountLine(line.id, locId);
    reportSave('stock count line delete', error);
    if (error) { showToast(error.message || 'Could not remove that item', 'error'); return; }
    setActive(a => a ? { ...a, lines: a.lines.filter(l => l.id !== line.id) } : a);
    setEdits(prev => { const n = { ...prev }; delete n[line.id]; return n; });
    showToast(`${name} removed`, 'info');
  };

  const openCount = async (id) => {
    const { data } = await fetchCount(id, locId);
    if (!data) return;
    // Seed any previously-counted lines into their default unit so editing resumes.
    const init = {};
    data.lines.forEach(l => {
      if (l.countedQty != null) { const tok = defaultTokenFor(l.inventoryItemId); const inU = fromBase(l.countedQty, tok, uomFor(l.inventoryItemId)); init[l.id] = { [tok]: inU == null ? '' : String(r3(inU)) }; }
    });
    setActive(data); setEdits(init);
  };
  const startCount = async () => {
    setBusy(true);
    const { data, error } = await createCount({ name: `Count ${new Date().toLocaleDateString()}`, countType: 'FULL' }, locId);
    setBusy(false);
    reportSave('stock count', error);
    if (error) { showToast?.(error.message, 'error'); return; }
    await reload();
    if (data) openCount(data.id);
  };
  const onEdit = (lineId, token, v) => setEdits(e => ({ ...e, [lineId]: { ...(e[lineId] || {}), [token]: v } }));
  const onBlur = async (line) => {
    if (!edits[line.id]) return;
    const base = countedBase(line);
    const { error } = await saveCountLine(line.id, base == null ? '' : base, locId);
    reportSave('stock count line', error);
    // The typed figure stays in `edits` so the shelf walk isn't lost — Save progress retries it.
    if (error) showToast?.(`${itemName(line.inventoryItemId)} count NOT saved`, 'error');
  };
  /** Push every edited line; returns how many the database refused. */
  const flush = async () => {
    let failed = 0;
    for (const line of active.lines) {
      if (!edits[line.id]) continue;
      const base = countedBase(line);
      const { error } = await saveCountLine(line.id, base == null ? '' : base, locId);
      reportSave('stock count line', error);
      if (error) failed++;
    }
    return failed;
  };
  const saveProgress = async () => {
    const failed = await flush();
    if (failed) { showToast?.(`${failed} line${failed === 1 ? '' : 's'} NOT saved — check the connection`, 'error'); return; }
    showToast?.('Progress saved', 'success');
  };
  const approve = async () => {
    if (!confirm('Approve this count? It will adjust on-hand to your counted figures and post the differences to the ledger.')) return;
    setBusy(true);
    // Approving reconciles on-hand to what is STORED on the lines, so a line that
    // failed to save would silently reconcile stock to the old figure.
    const failed = await flush();
    if (failed) {
      setBusy(false);
      showToast?.(`${failed} line${failed === 1 ? '' : 's'} could not be saved — not approved, so no stock was changed`, 'error');
      return;
    }
    const { error } = await approveCount(active.id, locId);
    setBusy(false);
    reportSave('stock count approval', error);
    if (error) { showToast?.(error.message, 'error'); return; }
    showToast?.('Count approved — stock reconciled', 'success');
    const { data } = await fetchCount(active.id, locId);
    setActive(data); setEdits({}); await reload();
  };

  if (loading) return <div style={{ padding: 26, color: 'var(--t3)' }}>Loading…</div>;

  // ── Count sheet ──
  if (active) {
    const approved = active.status === 'APPROVED';
    const countedNum = active.lines.filter(l => countedBase(l) != null || (l.countedQty != null && !edits[l.id])).length;
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
            const u = uomFor(line.inventoryItemId);
            const units = countUnitsFor(line.inventoryItemId);
            const dToken = defaultTokenFor(line.inventoryItemId);
            const dLabel = units.find(x => x.token === dToken)?.label || u.baseUnit;
            const expDisp = fromBase(line.expectedQty, dToken, u);
            const base = countedBase(line);
            const variance = base == null ? null : base - line.expectedQty;
            return (
              <div key={line.id} style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 10, padding: '10px 14px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
                  <div style={{ fontSize: 14, color: 'var(--t1)' }}>{itemName(line.inventoryItemId)}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ fontSize: 11, color: 'var(--t3)' }}>system: {r3(expDisp == null ? line.expectedQty : expDisp)} {dLabel}</div>
                    {/* drop a single item off the sheet without binning the whole count */}
                    {!approved && (
                      <button onClick={() => removeLine(line)} title={`Remove ${itemName(line.inventoryItemId)} from this count`}
                        style={{ width: 24, height: 24, flexShrink: 0, borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit',
                          border: '1px solid var(--bdr)', background: 'var(--bg1)', color: 'var(--t3)', fontSize: 12, lineHeight: 1 }}>×</button>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
                  {units.map(uo => (
                    <div key={uo.token} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input type="number" inputMode="decimal" step="any" disabled={approved} value={edits[line.id]?.[uo.token] ?? ''}
                        onChange={e => onEdit(line.id, uo.token, e.target.value)} onBlur={() => onBlur(line)}
                        placeholder="0" style={{ ...field, width: 64, textAlign: 'right' }} />
                      <span style={{ fontSize: 11, color: 'var(--t3)' }}>{uo.label}</span>
                    </div>
                  ))}
                </div>
                {base != null && (() => {
                  const cDisp = fromBase(base, dToken, u);
                  const vDisp = (cDisp != null && expDisp != null) ? cDisp - expDisp : null;
                  return (
                    <div style={{ fontSize: 11, marginTop: 6, color: variance < 0 ? 'var(--red, #ef4444)' : variance > 0 ? 'var(--grn, #16a34a)' : 'var(--t3)' }}>
                      counted = {r3(cDisp == null ? base : cDisp)} {dLabel}{vDisp != null && vDisp !== 0 ? ` · ${vDisp > 0 ? '+' : ''}${r3(vDisp)} vs system` : ' · matches'}
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>

        {!approved && (
          <div style={{ position: 'sticky', bottom: 0, background: 'var(--bg0)', padding: '12px 0', borderTop: '1px solid var(--bdr)', display: 'flex', gap: 10 }}>
            <button onClick={saveProgress} style={{ flex: 1, padding: '12px', borderRadius: 10, background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t1)', fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>Save progress</button>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: c.status === 'APPROVED' ? 'var(--grn)' : 'var(--t3)' }}>{c.status}</div>
                {c.varianceValue != null && <div style={{ fontSize: 12, color: c.varianceValue < 0 ? 'var(--red)' : 'var(--t2)', marginTop: 2 }}>{money(c.varianceValue)}</div>}
              </div>
              {/* v5.5.823: an approved count has already adjusted stock and is the
                  evidence behind those movements, so only unapproved sheets can go. */}
              {c.status !== 'APPROVED' ? (
                <button onClick={e => removeCount(e, c)} title="Delete this count"
                  style={{ width: 30, height: 30, flexShrink: 0, borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
                    border: '1px solid var(--bdr)', background: 'var(--bg1)', color: 'var(--t3)', fontSize: 14 }}>×</button>
              ) : (
                <span title="Approved counts have already adjusted your stock and cannot be deleted"
                  style={{ width: 30, textAlign: 'center', color: 'var(--t4)', fontSize: 12 }}>🔒</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
