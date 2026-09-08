/**
 * PurchaseOrders — create, send and receive POs (Purchasing → Purchase orders).
 * Slice 7. Receiving posts PURCHASE_RECEIPT to the stock ledger + updates cost.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useStore } from '../../store';
import { getActiveLocationSync, getLocationId, supabase } from '../../lib/supabase';
import { money, currencySymbol } from '../../lib/currency';
import { fetchSuppliers, fetchInventoryItems } from '../../lib/stock/data';
import { fetchPurchaseOrders, savePurchaseOrder, setPOStatus, receivePurchaseOrder, attachInvoiceToPO, fetchPOInvoices } from '../../lib/stock/purchasing';
import { reportSave } from '../../lib/saveHealth';
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
  // v5.5.920 — the list is a WORK QUEUE, not an archive. Default view shows only orders that
  // still need something done (awaiting send or delivery); received/cancelled live in their
  // own tabs. This is the owner's "one constant list" complaint fixed at the root.
  const [tab, setTab] = useState('open');           // 'open' | 'done' | 'all'
  const [q, setQ] = useState('');
  // v5.5.921 — the "accept into stock" panel: per-line received qty + delivery-note price.
  // null = closed; otherwise { [lineId]: { qtyPacks, unitPrice } } seeded from the order.
  const [receiving, setReceiving] = useState(null);
  const [poInvoices, setPoInvoices] = useState([]);

  const reload = useCallback(async (keepId) => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const [{ data: p }, { data: s }, { data: it }] = await Promise.all([fetchPurchaseOrders(loc), fetchSuppliers(loc), fetchInventoryItems(loc)]);
    setPos(p || []); setSuppliers(s || []); setItems(it || []); setLoading(false);
    if (keepId) { const f = (p || []).find(x => x.id === keepId); if (f) { setDraft(structuredClone(f)); setSelId(keepId); } }
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const supName = useCallback((id) => suppliers.find(s => s.id === id)?.name || '—', [suppliers]);
  const OPEN_STATUSES = ['DRAFT', 'SENT', 'PARTIAL'];
  const visible = useMemo(() => pos.filter(p => {
    if (tab === 'open' && !OPEN_STATUSES.includes(p.status)) return false;
    if (tab === 'done' && p.status !== 'RECEIVED') return false;
    const needle = q.trim().toLowerCase();
    if (needle && !(`${supName(p.supplierId)} ${p.reference || ''}`.toLowerCase().includes(needle))) return false;
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [pos, tab, q, supName]);
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
  // v5.5.923 — a RECEIVED order's money is what was ACCEPTED, not what was ordered. The header
  // subtotal is recomputed to accepted lines at receive time; without this the detail pane
  // showed ordered × delivery-price (order 10, receive 6: list £12, pane £20 — same order,
  // two numbers). The shorted remainder's value lives on its balance order.
  const qtyFor = useCallback((l) => draft?.status === 'RECEIVED' ? (Number(l.qtyReceived) || 0) : (Number(l.qtyPacks) || 0), [draft?.status]);
  const total = useMemo(() => (draft?.lines || []).reduce((s, l) => s + qtyFor(l) * (Number(l.unitPrice) || 0), 0), [draft, qtyFor]);
  const vatTotal = useMemo(() => (draft?.lines || []).reduce((s, l) => s + qtyFor(l) * (Number(l.unitPrice) || 0) * lineRateDec(l), 0), [draft, qtyFor, lineRateDec]);

  const save = async (status) => {
    if (!draft.supplierId) { showToast?.('Pick a supplier', 'error'); return; }
    setBusy(true);
    const { data, error } = await savePurchaseOrder({ ...draft, status: status || draft.status }, draft.lines, locId);
    setBusy(false);
    reportSave('purchase order', error);
    if (error) { showToast?.(error.message, 'error'); return; }
    showToast?.(status === 'SENT' ? 'Marked sent' : 'Saved', 'success');
    await reload(data?.id || selId);
    return data;
  };
  // v5.5.921 — actually SEND the order. Saves first (so what the supplier gets is what is on
  // screen), then po-send emails the order table and flips the status server-side only after
  // the email succeeded — SENT finally means sent. Falls back to mark-sent when the supplier
  // has no email on file.
  const supplierEmail = suppliers.find(sp => sp.id === draft?.supplierId)?.email || null;
  const sendToSupplier = async () => {
    const saved = await save('DRAFT');
    if (!saved?.id) return;
    setBusy(true);
    const { data: res, error } = await supabase.functions.invoke('po-send', {
      body: { po_id: saved.id, location_id: locId },
    });
    setBusy(false);
    if (error || res?.error) {
      const msg = res?.error === 'supplier_has_no_email'
        ? 'This supplier has no email on file — add one in Suppliers, or use Mark sent.'
        : (res?.error || error?.message || 'Send failed');
      showToast?.(msg, 'error'); return;
    }
    showToast?.(`Order emailed to ${res?.to}`, 'success');
    await reload(saved.id);
  };
  const openReceive = () => {
    // Seed with what was ordered — staff correct only what differs, which for a clean
    // delivery is nothing. Prices pre-filled from the PO so variance is one edit away.
    const seed = {};
    (draft.lines || []).forEach(l => { seed[l.id] = { qtyPacks: String(l.qtyPacks), unitPrice: String(l.unitPrice) }; });
    setReceiving(seed);
  };
  const acceptIntoStock = async () => {
    if (!draft?.id || !receiving) return;
    const receipts = (draft.lines || []).map(l => ({
      lineId: l.id,
      qtyPacks: Number(receiving[l.id]?.qtyPacks ?? l.qtyPacks) || 0,
      unitPrice: receiving[l.id]?.unitPrice ?? l.unitPrice,
    }));
    setBusy(true);
    const { error, data } = await receivePurchaseOrder(draft.id, locId, receipts);
    setBusy(false);
    reportSave('goods receipt', error);
    if (error) { showToast?.(error.message, 'error'); return; }
    setReceiving(null);
    showToast?.(data?.shortedCount
      ? `Received — ${data.shortedCount} shorted line${data.shortedCount === 1 ? '' : 's'} moved to a balance order`
      : 'Received into stock', 'success');
    await reload(draft.id);
  };
  const attachInvoice = async (file) => {
    if (!draft?.id || !file) return;
    setBusy(true);
    const { error } = await attachInvoiceToPO(draft.id, file, { supplierId: draft.supplierId }, locId);
    setBusy(false);
    reportSave('purchase invoice', error);
    if (error) { showToast?.(error.message, 'error'); return; }
    showToast?.('Invoice attached', 'success');
    const { data } = await fetchPOInvoices(draft.id, locId);
    setPoInvoices(data);
  };
  useEffect(() => {
    setReceiving(null);
    if (draft?.id) fetchPOInvoices(draft.id, locId).then(({ data }) => setPoInvoices(data)); else setPoInvoices([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft?.id]);
  const cancel = async () => {
    if (!draft?.id) return;
    const { error } = await setPOStatus(draft.id, 'CANCELLED', locId);
    reportSave('purchase order status', error);
    // A cancel that didn't land leaves a live order the supplier will still deliver.
    if (error) { showToast?.('Order NOT cancelled — it is still open', 'error'); return; }
    showToast?.('Order cancelled', 'info');
    await reload(draft.id);
  };

  const editable = !draft?.id || draft.status === 'DRAFT';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--bg)' }}>
      <div style={{ padding: '22px 26px 0', flexShrink: 0 }}>
        <PageHeader eyebrow="PURCHASING" title="Orders" subtitle="Orders sent to suppliers, waiting to be accepted into stock." />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', flex: 1, minHeight: 0, borderTop: '1px solid var(--bdr)', background: 'var(--bg)' }}>
      <aside style={{ borderRight: '1px solid var(--bdr)', background: 'var(--bg1)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 14 }}>
          <button onClick={newPO} style={{ width: '100%', padding: '9px 0', borderRadius: 7, background: 'var(--acc)', color: '#0b0c10', border: 0, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>+ New purchase order</button>
        </div>
        <div style={{ display: 'flex', gap: 6, padding: '0 14px 10px' }}>
          {[['open', 'Awaiting'], ['done', 'Received'], ['all', 'All']].map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)} style={{ flex: 1, padding: '6px 0', borderRadius: 7, fontSize: 11.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', border: '1px solid ' + (tab === id ? 'var(--acc)' : 'var(--bdr)'), background: tab === id ? 'var(--bg2)' : 'transparent', color: tab === id ? 'var(--t1)' : 'var(--t3)' }}>{label}</button>
          ))}
        </div>
        <div style={{ padding: '0 14px 10px' }}>
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search supplier / ref…" style={field} />
        </div>
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>}
          {!loading && visible.length === 0 && <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>{pos.length === 0 ? 'No orders yet.' : 'No orders in this view.'}</div>}
          {visible.map(p => (
            <div key={p.id} onClick={() => { setDraft(structuredClone(p)); setSelId(p.id); }} style={{ padding: '11px 16px', cursor: 'pointer', borderLeft: '3px solid ' + (p.id === selId ? 'var(--acc)' : 'transparent'), background: p.id === selId ? 'var(--bg2)' : 'transparent' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, color: 'var(--t1)' }}>{supName(p.supplierId)}</span>
                <Tag label={p.status} tone={STATUS_TONE[p.status]} />
              </div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 2 }}>{p.reference || ''} · {p.lines.length} line{p.lines.length === 1 ? '' : 's'} · {money(p.subtotal || 0)}{p.expectedDate ? ` · due ${p.expectedDate}` : ''}</div>
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
                  {draft.status === 'RECEIVED' && Number(l.qtyReceived) !== Number(l.qtyPacks) && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--org, #f59e0b)' }} title="short — remainder on the balance order">rec {Number(l.qtyReceived) || 0}</span>}
                  <span style={{ width: 70, textAlign: 'right', fontSize: 13, color: 'var(--t2)' }}>{money(qtyFor(l) * (Number(l.unitPrice) || 0))}</span>
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
              {editable && supplierEmail && <PrimaryBtn onClick={sendToSupplier} disabled={busy || !draft.lines.length}>Send to supplier</PrimaryBtn>}
              {editable && <button onClick={() => save('SENT')} disabled={busy || !draft.lines.length} style={{ padding: '9px 16px', borderRadius: 8, background: supplierEmail ? 'var(--bg2)' : 'var(--acc)', border: supplierEmail ? '1px solid var(--bdr)' : 0, color: supplierEmail ? 'var(--t1)' : '#0b0c10', fontSize: 13, fontWeight: 700, cursor: 'pointer', opacity: busy || !draft.lines.length ? 0.6 : 1 }} title={supplierEmail ? 'Mark sent without emailing' : 'No supplier email on file — marks the order sent without emailing'}>Mark sent</button>}
              {draft.id && (draft.status === 'SENT' || draft.status === 'PARTIAL') && !receiving && (
                <button onClick={async () => {
                  setBusy(true);
                  const { data: res, error: e } = await supabase.functions.invoke('po-send', { body: { po_id: draft.id, location_id: locId } });
                  setBusy(false);
                  let msg = '';
                  if (!e && res?.ok) msg = `Emailed to ${res.to}`;
                  else { try { msg = res?.error || (e?.context ? (await e.context.json())?.error : e?.message) || 'send failed'; } catch { msg = e?.message || 'send failed'; } }
                  showToast?.(msg, (!e && res?.ok) ? 'success' : 'error');
                }} disabled={busy} style={{ padding: '9px 14px', borderRadius: 8, background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t1)', fontSize: 13, cursor: 'pointer' }}>
                  ✉ Resend to supplier
                </button>
              )}
              {draft.id && (draft.status === 'SENT' || draft.status === 'PARTIAL') && !receiving && <PrimaryBtn onClick={openReceive} disabled={busy}>Accept delivery…</PrimaryBtn>}
              {draft.id && draft.status !== 'RECEIVED' && draft.status !== 'CANCELLED' && <button onClick={cancel} style={{ padding: '9px 14px', borderRadius: 8, background: 'transparent', border: '1px solid var(--bdr)', color: 'var(--t3)', fontSize: 13, cursor: 'pointer' }}>Cancel order</button>}
            </div>
            {receiving && (
              <div style={{ marginTop: 16, border: '1px solid var(--acc)', borderRadius: 10, padding: 16, background: 'var(--bg1)' }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--t1)', marginBottom: 4 }}>Accept delivery into stock</div>
                <div style={{ fontSize: 11.5, color: 'var(--t3)', marginBottom: 12 }}>
                  Check off against the delivery note — correct any quantity that differs and any price that changed.
                  Shorted lines automatically move to a balance order. Each line can only be received once.
                </div>
                {(draft.lines || []).map(l => {
                  const r = receiving[l.id] || {};
                  const short = Number(r.qtyPacks) < Number(l.qtyPacks);
                  const priceChanged = Number(r.unitPrice) !== Number(l.unitPrice);
                  return (
                    <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--bdr)' }}>
                      <span style={{ flex: 1, fontSize: 13, color: 'var(--t1)' }}>{l.description || itemName(l.inventoryItemId)}</span>
                      <span style={{ fontSize: 11, color: 'var(--t3)' }}>ordered {l.qtyPacks}</span>
                      <input type="number" min="0" step="any" value={r.qtyPacks ?? ''} onChange={e => setReceiving(x => ({ ...x, [l.id]: { ...x[l.id], qtyPacks: e.target.value } }))}
                        style={{ ...field, width: 74, borderColor: short ? 'var(--org, #f59e0b)' : 'var(--bdr)' }} title="packs received" />
                      <span style={{ fontSize: 11, color: 'var(--t3)' }}>@</span>
                      <input type="number" min="0" step="any" value={r.unitPrice ?? ''} onChange={e => setReceiving(x => ({ ...x, [l.id]: { ...x[l.id], unitPrice: e.target.value } }))}
                        style={{ ...field, width: 84, borderColor: priceChanged ? 'var(--org, #f59e0b)' : 'var(--bdr)' }} title="pack price on the delivery note, ex VAT" />
                      {short && <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--org, #f59e0b)' }}>short</span>}
                    </div>
                  );
                })}
                <div style={{ display: 'flex', gap: 10, marginTop: 14, alignItems: 'center' }}>
                  <label style={{ fontSize: 12, color: 'var(--t3)', cursor: 'pointer', border: '1px dashed var(--bdr)', borderRadius: 7, padding: '7px 12px' }}>
                    📎 Attach invoice
                    <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) attachInvoice(f); e.target.value = ''; }} />
                  </label>
                  <div style={{ marginRight: 'auto' }} />
                  <button onClick={() => setReceiving(null)} style={{ padding: '9px 14px', borderRadius: 8, background: 'transparent', border: '1px solid var(--bdr)', color: 'var(--t3)', fontSize: 13, cursor: 'pointer' }}>Back</button>
                  <PrimaryBtn onClick={acceptIntoStock} disabled={busy}>Accept into stock</PrimaryBtn>
                </div>
              </div>
            )}
            {poInvoices.length > 0 && (
              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--t3)' }}>
                📎 {poInvoices.length} invoice{poInvoices.length === 1 ? '' : 's'} attached
                {draft.status === 'RECEIVED' && (
                  <label style={{ marginLeft: 10, cursor: 'pointer', textDecoration: 'underline' }}>
                    add another<input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) attachInvoice(f); e.target.value = ''; }} />
                  </label>
                )}
              </div>
            )}
            {draft.status === 'RECEIVED' && poInvoices.length === 0 && (
              <div style={{ marginTop: 12, fontSize: 12, color: 'var(--t3)' }}>
                <label style={{ cursor: 'pointer', textDecoration: 'underline' }}>📎 Attach the supplier invoice
                  <input type="file" accept="image/*,.pdf" style={{ display: 'none' }} onChange={e => { const f = e.target.files?.[0]; if (f) attachInvoice(f); e.target.value = ''; }} />
                </label>
                {' '}— paperwork only, the stock is already in.
              </div>
            )}
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
