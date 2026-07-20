/**
 * PurchaseOrders — create, send and receive POs (Purchasing → Purchase orders).
 * Slice 7. Receiving posts PURCHASE_RECEIPT to the stock ledger + updates cost.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId } from '../../lib/supabase';
import { money, currencySymbol } from '../../lib/currency';
import { fetchSuppliers, fetchInventoryItems } from '../../lib/stock/data';
import { fetchPurchaseOrders, savePurchaseOrder, setPOStatus, receivePurchaseOrder } from '../../lib/stock/purchasing';
import { PageHeader, PrimaryBtn, Tag } from './reports/reportKit';

const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };
// PO status → reportKit Tag tone. Labels still carry the exact status word.
const STATUS_TONE = { DRAFT: 'neutral', SENT: 'neutral', PARTIAL: 'warn', RECEIVED: 'good', CANCELLED: 'bad' };
// NET (ex-VAT) pack price — the cost basis fetchInventoryItems already resolved.
const spNet = (sp) => (sp && sp.netPackPrice != null) ? Number(sp.netPackPrice) : Number(sp?.packPrice || 0);

export default function PurchaseOrders() {
  const showToast = useStore(s => s.showToast);
  const taxRates = useStore(s => s.taxRates) || [];
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [pos, setPos] = useState([]);
  const [suppliers, setSuppliers] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState(null);
  const [selId, setSelId] = useState(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (keepId) => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const [{ data: p }, { data: s }, { data: it }] = await Promise.all([fetchPurchaseOrders(loc), fetchSuppliers(loc), fetchInventoryItems(loc)]);
    setPos(p || []); setSuppliers(s || []); setItems(it || []); setLoading(false);
    if (keepId) { const f = (p || []).find(x => x.id === keepId); if (f) { setDraft(structuredClone(f)); setSelId(keepId); } }
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const supName = useCallback((id) => suppliers.find(s => s.id === id)?.name || '—', [suppliers]);
  const itemName = useCallback((id) => items.find(i => i.id === id)?.name || '—', [items]);
  const ratesById = useMemo(() => { const m = {}; taxRates.forEach(r => { m[r.id] = r; }); return m; }, [taxRates]);
  const lineRateDec = useCallback((l) => Number(ratesById[l.purchaseTaxRateId]?.rate || 0), [ratesById]);
  const newPO = () => { setDraft({ supplierId: suppliers[0]?.id || '', reference: '', expectedDate: '', notes: '', status: 'DRAFT', lines: [] }); setSelId(null); };

  const upd = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  const addItemLine = (it) => {
    const sp = (it.supplierProducts || []).find(s => s.supplierId === draft.supplierId) || (it.supplierProducts || [])[0];
    setDraft(d => ({ ...d, lines: [...d.lines, {
      inventoryItemId: it.id, description: it.name, qtyPacks: 1,
      packQty: sp?.packQty || 1, innerQty: sp?.innerQty || 1, innerUnit: sp?.innerUnit || it.baseUnit,
      unitPrice: spNet(sp), qtyReceived: 0, supplierProductId: sp?.id || null,
      purchaseTaxRateId: sp?.purchaseTaxRateId || it.purchaseTaxRateId || null,
    }] }));
  };
  const updLine = (i, k, v) => setDraft(d => ({ ...d, lines: d.lines.map((l, j) => j === i ? { ...l, [k]: v } : l) }));
  const rmLine = (i) => setDraft(d => ({ ...d, lines: d.lines.filter((_, j) => j !== i) }));
  const total = useMemo(() => (draft?.lines || []).reduce((s, l) => s + (Number(l.qtyPacks) || 0) * (Number(l.unitPrice) || 0), 0), [draft]);
  const vatTotal = useMemo(() => (draft?.lines || []).reduce((s, l) => s + (Number(l.qtyPacks) || 0) * (Number(l.unitPrice) || 0) * lineRateDec(l), 0), [draft, lineRateDec]);

  const save = async (status) => {
    if (!draft.supplierId) { showToast?.('Pick a supplier', 'error'); return; }
    setBusy(true);
    const { data, error } = await savePurchaseOrder({ ...draft, status: status || draft.status }, draft.lines, locId);
    setBusy(false);
    if (error) { showToast?.(error.message, 'error'); return; }
    showToast?.(status === 'SENT' ? 'PO sent' : 'Saved', 'success');
    await reload(data?.id || selId);
  };
  const receive = async () => {
    if (!draft?.id) return;
    if (!confirm('Receive this whole order into stock? This adds stock and updates costs.')) return;
    setBusy(true);
    const { error } = await receivePurchaseOrder(draft.id, locId);
    setBusy(false);
    if (error) { showToast?.(error.message, 'error'); return; }
    showToast?.('Received into stock', 'success');
    await reload(draft.id);
  };
  const cancel = async () => { if (draft?.id) { await setPOStatus(draft.id, 'CANCELLED', locId); await reload(draft.id); } };

  const editable = !draft?.id || draft.status === 'DRAFT';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--bg)' }}>
      <div style={{ padding: '22px 26px 0', flexShrink: 0 }}>
        <PageHeader eyebrow="PURCHASING" title="Purchase orders" subtitle="Raise orders, send them to suppliers, then receive the delivery into stock." />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', flex: 1, minHeight: 0, borderTop: '1px solid var(--bdr)', background: 'var(--bg)' }}>
      <aside style={{ borderRight: '1px solid var(--bdr)', background: 'var(--bg1)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 14 }}>
          <button onClick={newPO} style={{ width: '100%', padding: '9px 0', borderRadius: 7, background: 'var(--acc)', color: '#0b0c10', border: 0, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>+ New purchase order</button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>}
          {!loading && pos.length === 0 && <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>No orders yet.</div>}
          {pos.map(p => (
            <div key={p.id} onClick={() => { setDraft(structuredClone(p)); setSelId(p.id); }} style={{ padding: '11px 16px', cursor: 'pointer', borderLeft: '3px solid ' + (p.id === selId ? 'var(--acc)' : 'transparent'), background: p.id === selId ? 'var(--bg2)' : 'transparent' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, color: 'var(--t1)' }}>{supName(p.supplierId)}</span>
                <Tag label={p.status} tone={STATUS_TONE[p.status]} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>{p.reference || ''} · {p.lines.length} line{p.lines.length === 1 ? '' : 's'} · {money(p.subtotal || 0)}</div>
            </div>
          ))}
        </div>
      </aside>

      <main style={{ overflowY: 'auto', minHeight: 0 }}>
        {!draft && <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: 'var(--t3)' }}>Select an order, or create one.</div>}
        {draft && (
          <div style={{ padding: '22px 26px', maxWidth: 900 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16, flexWrap: 'wrap' }}>
              <h2 style={{ fontSize: 19, fontWeight: 700, letterSpacing: '-.3px', margin: 0, color: 'var(--t1)', flex: 1 }}>{draft.id ? `Order · ${supName(draft.supplierId)}` : 'New purchase order'}</h2>
              {draft.id && <Tag label={draft.status} tone={STATUS_TONE[draft.status]} />}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 14, marginBottom: 16 }}>
              <div><label style={lbl}>Supplier</label>
                <select disabled={!editable} value={draft.supplierId} onChange={e => upd('supplierId', e.target.value)} style={field}>
                  <option value="">— supplier —</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div><label style={lbl}>Reference</label><input disabled={!editable} value={draft.reference || ''} onChange={e => upd('reference', e.target.value)} style={field} /></div>
              <div><label style={lbl}>Expected date</label><input disabled={!editable} type="date" value={draft.expectedDate || ''} onChange={e => upd('expectedDate', e.target.value)} style={field} /></div>
            </div>

            <label style={lbl}>Lines</label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
              {draft.lines.length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No lines yet — add stock items below.</div>}
              {draft.lines.map((l, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 7, padding: '8px 10px' }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{itemName(l.inventoryItemId) || l.description}</span>
                  <input disabled={!editable} type="number" min="0" step="any" value={l.qtyPacks} onChange={e => updLine(i, 'qtyPacks', e.target.value)} style={{ ...field, width: 64 }} title="packs" />
                  <span style={{ fontSize: 11, color: 'var(--t3)' }}>× {l.packQty}×{l.innerQty}{l.innerUnit} @</span>
                  <input disabled={!editable} type="number" min="0" step="any" value={l.unitPrice} onChange={e => updLine(i, 'unitPrice', e.target.value)} style={{ ...field, width: 78 }} title="price per pack, ex VAT" />
                  {lineRateDec(l) > 0 && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--t4)' }} title="purchase VAT">+{Math.round(lineRateDec(l) * 100)}%</span>}
                  <span style={{ width: 70, textAlign: 'right', fontSize: 13, color: 'var(--t2)' }}>{money((Number(l.qtyPacks) || 0) * (Number(l.unitPrice) || 0))}</span>
                  {editable && <button onClick={() => rmLine(i)} style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 16 }}>×</button>}
                </div>
              ))}
            </div>
            {editable && <ItemPicker items={items} onPick={addItemLine} />}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 18, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 14, color: 'var(--t1)', marginRight: 'auto' }}>
                Subtotal (ex VAT): <b>{money(total)}</b>
                {vatTotal > 0.005 && <span style={{ color: 'var(--t3)' }}> · VAT {money(vatTotal)} · <b style={{ color: 'var(--t1)' }}>pay {money(total + vatTotal)}</b></span>}
              </div>
              {editable && <button onClick={() => save('DRAFT')} disabled={busy} style={{ padding: '9px 16px', borderRadius: 8, background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t1)', fontSize: 13, cursor: 'pointer' }}>Save draft</button>}
              {editable && <PrimaryBtn onClick={() => save('SENT')} disabled={busy || !draft.lines.length}>Save &amp; mark sent</PrimaryBtn>}
              {draft.id && (draft.status === 'SENT' || draft.status === 'PARTIAL') && <PrimaryBtn onClick={receive} disabled={busy}>Receive into stock</PrimaryBtn>}
              {draft.id && draft.status !== 'RECEIVED' && draft.status !== 'CANCELLED' && <button onClick={cancel} style={{ padding: '9px 14px', borderRadius: 8, background: 'transparent', border: '1px solid var(--bdr)', color: 'var(--t3)', fontSize: 13, cursor: 'pointer' }}>Cancel order</button>}
            </div>
            {draft.status === 'RECEIVED' && <div style={{ marginTop: 12, fontSize: 12, color: 'var(--grn)' }}>✓ Received into stock — costs updated. See each item's Stock tab for the delivery movement.</div>}
          </div>
        )}
      </main>
      </div>
    </div>
  );
}

function ItemPicker({ items, onPick }) {
  const [q, setQ] = useState('');
  const [focused, setFocused] = useState(false);
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter(i => !i.archivedAt && (!s || i.name.toLowerCase().includes(s))).slice(0, 10);
  }, [q, items]);
  return (
    <div style={{ position: 'relative', maxWidth: 360 }}>
      <input value={q} onChange={e => setQ(e.target.value)} onFocus={() => setFocused(true)} onBlur={() => setTimeout(() => setFocused(false), 150)} placeholder="Add stock item to order…" style={field} />
      {focused && matches.length > 0 && (
        <div style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, marginTop: 4, overflow: 'hidden', boxShadow: 'var(--sh2)' }}>
          {matches.map(i => <div key={i.id} onClick={() => { onPick(i); setQ(''); }} style={{ padding: '9px 12px', cursor: 'pointer', fontSize: 13, color: 'var(--t1)' }}>{i.name}</div>)}
        </div>
      )}
    </div>
  );
}
