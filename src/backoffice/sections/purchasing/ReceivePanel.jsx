// purchasing/ReceivePanel.jsx: receive one delivery from the Deliveries board (multi site stock Drop 3,
// v5.11.96, contract 3.2 and 4.2). Lines with ordered, received (typed) and price; the temperature
// (over 8 C is turned away, as the phone does); a photo of the note (kept on the order, paperwork
// only); "Save for later" keeps what was typed without booking anything (savePartReceive); "Finish"
// books it (receivePurchaseOrder: stock, cost and a balance order for short lines). "Add a line" for a
// missed or substitute product (with the allergen notice); "Not coming" on a short line raises a
// credit request. Everything acts on the order's own site.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { supabase } from '../../../lib/supabase';
import { stockApi } from '../../../lib/stock/stockApi';
import { fetchInventoryItems } from '../../../lib/stock/data';
import { pickSupplierProduct } from '../../../lib/stock/costing';
import { receivePurchaseOrder, savePartReceive, attachInvoiceToPO, KITCHEN_RECEIVE_WORDS } from '../../../lib/stock/purchasing';
import { moneyWords } from '../../../lib/stock/purchasingRules';
import { tempCheck, SUBSTITUTE_NOTICE, ACCEPT_MAX_C } from '../../../lib/stock/purchasingWords';
import { Sheet, Btn, Field, TableWrap, Th, Td, Notice, ErrorLine, EmptyLine, ui } from '../stock/stockUi';

const LINE_COLS = 'id, inventory_item_id, supplier_product_id, description, qty_packs, pack_qty, inner_qty, inner_unit, unit_price, qty_received, sort_order';

export default function ReceivePanel({ po, onDone, onClose }) {
  const showToast = useStore((s) => s.showToast);
  const loc = po?.location_id;
  const [lines, setLines] = useState(null);
  const [supplierId, setSupplierId] = useState(null);
  const [got, setGot] = useState({});          // line id -> { qty, price }
  const [temp, setTemp] = useState('');
  const [dry, setDry] = useState(false);
  const [photo, setPhoto] = useState(null);
  const [items, setItems] = useState(null);    // for Add a line
  const [adding, setAdding] = useState('');
  const [subs, setSubs] = useState(new Set()); // line ids added here as substitutes
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let on = true;
    if (!supabase || !po?.po_id) return undefined;
    (async () => {
      const head = await supabase.from('purchase_orders').select('supplier_id').eq('location_id', loc).eq('id', po.po_id).maybeSingle();
      let r = await supabase.from('po_lines').select(`${LINE_COLS}, qty_draft`).eq('location_id', loc).eq('po_id', po.po_id).order('sort_order').limit(300);
      if (r.error && /qty_draft/.test(r.error.message || '')) r = await supabase.from('po_lines').select(LINE_COLS).eq('location_id', loc).eq('po_id', po.po_id).order('sort_order').limit(300);
      if (!on) return;
      setSupplierId(head.data?.supplier_id || null);
      setLines(r.data || []); setError(r.error || null);
      setGot(Object.fromEntries((r.data || []).map((l) => [l.id, { qty: l.qty_draft != null ? String(l.qty_draft) : String(Math.max(0, Number(l.qty_packs) - Number(l.qty_received || 0))), price: String(l.unit_price ?? '') }])));
    })();
    return () => { on = false; };
  }, [po?.po_id, loc]);

  const t = tempCheck(temp, dry);
  const shortOf = (l) => Math.max(0, (Number(l.qty_packs) || 0) - (Number(got[l.id]?.qty) || 0));
  const total = useMemo(() => (lines || []).reduce((s, l) => s + (Number(got[l.id]?.qty) || 0) * (Number(got[l.id]?.price) || 0), 0), [lines, got]);
  const set = (id, k, v) => setGot((g) => ({ ...g, [id]: { ...g[id], [k]: v } }));

  const saveLater = async () => {
    setBusy(true);
    const r = await savePartReceive(po.po_id, Object.fromEntries(Object.entries(got).map(([id, x]) => [id, x.qty === '' ? null : Number(x.qty)])), loc);
    setBusy(false);
    if (r.error) { showToast?.(r.error.message, 'error'); return; }
    showToast?.('Saved for later. Nothing is in stock until you press Finish.', 'success');
    onDone?.();
  };
  const finish = async () => {
    if (po.internal) { showToast?.(KITCHEN_RECEIVE_WORDS, 'error'); return; }
    if (!t.known) { setError(new Error('Type the temperature, or tick Dry goods.')); return; }
    if (t.tooWarm) { setError(new Error(`Over ${ACCEPT_MAX_C} C: turn the delivery away. Nothing is booked.`)); return; }
    setBusy(true); setError(null);
    const receipts = (lines || []).map((l) => ({ lineId: l.id, qtyPacks: Number(got[l.id]?.qty) || 0, unitPrice: got[l.id]?.price === '' ? null : Number(got[l.id]?.price) }));
    const { error: e, data } = await receivePurchaseOrder(po.po_id, loc, receipts);
    if (e) { setBusy(false); setError(e); return; }
    if (photo) await attachInvoiceToPO(po.po_id, photo, { supplierId }, loc);
    setBusy(false);
    showToast?.(data?.shortedCount ? `Received. ${data.shortedCount} short line${data.shortedCount === 1 ? '' : 's'} moved to a balance order.` : 'Received into stock.', 'success');
    onDone?.();
  };
  const notComing = async (l) => {
    const qty = shortOf(l);
    if (!(qty > 0)) return;
    const price = Number(got[l.id]?.price ?? l.unit_price) || 0;
    const r = await stockApi.saveCreditRequest({ location_id: loc, supplier_id: supplierId, po_id: po.po_id, reason: 'not_coming', note: null,
      lines: [{ inventory_item_id: l.inventory_item_id, description: l.description, qty, unit_price_charged: price, unit_price_agreed: null, amount: Math.round(qty * price * 100) / 100 }] });
    showToast?.(r.error ? r.error.message : `Credit request raised for ${qty} x ${l.description}.`, r.error ? 'error' : 'success');
  };
  const openAdd = async () => { if (!items) { const r = await fetchInventoryItems(loc); setItems((r.data || []).filter((i) => !i.archivedAt && i.kind !== 'MADE')); } setAdding(' '); };
  const addLine = async (itemId) => {
    const it = (items || []).find((i) => i.id === itemId);
    if (!it) return;
    const sp = (it.supplierProducts || []).find((p) => p.supplierId === supplierId) || pickSupplierProduct(it);
    const row = { location_id: loc, po_id: po.po_id, inventory_item_id: it.id, supplier_product_id: sp?.id || null, description: it.name, qty_packs: 0,
      pack_qty: Number(sp?.packQty) || 1, inner_qty: Number(sp?.innerQty) || 1, inner_unit: sp?.innerUnit || it.baseUnit, unit_price: sp ? Number(sp.netPackPrice ?? sp.packPrice ?? 0) : 0, qty_received: 0, sort_order: (lines || []).length };
    const { data, error: e } = await supabase.from('po_lines').insert(row).select(LINE_COLS).single();
    if (e) { showToast?.(e.message, 'error'); return; }
    setLines((ls) => [...(ls || []), data]);
    setGot((g) => ({ ...g, [data.id]: { qty: '1', price: String(data.unit_price ?? '') } }));
    setSubs((s) => new Set([...s, data.id]));
    setAdding('');
  };

  return (
    <Sheet title={`Receive ${po.reference || 'order'}`} sub={`${po.supplier_name || ''} at ${po.site_name || 'this site'}`} onClose={onClose} width={760}
      footer={<>
        <span style={{ fontSize: 13 }}>Received value <b>{moneyWords(total)}</b> ex VAT</span>
        <span style={{ marginLeft: 'auto' }} />
        <Btn disabled={busy} onClick={saveLater}>Save for later</Btn>
        <Btn kind="primary" disabled={busy || !lines?.length || t.tooWarm} onClick={finish}>{busy ? 'Saving…' : 'Finish'}</Btn>
      </>}>
      {po.internal && <div style={{ marginBottom: 12 }}><Notice tone="warn">{KITCHEN_RECEIVE_WORDS}</Notice></div>}
      <ErrorLine error={error} />
      {lines === null ? <EmptyLine>Loading…</EmptyLine> : (
        <TableWrap minWidth={640}>
          <thead><tr><Th>Item</Th><Th right>Ordered</Th><Th right>Received</Th><Th right>Price</Th><Th> </Th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <Td>{l.description}{subs.has(l.id) && <div style={{ fontSize: 11.5, color: 'var(--amber, #F5A623)', marginTop: 3 }}>{SUBSTITUTE_NOTICE}</div>}</Td>
                <Td num grey>{Number(l.qty_packs)}</Td>
                <Td right><input inputMode="decimal" value={got[l.id]?.qty ?? ''} onChange={(e) => set(l.id, 'qty', e.target.value)} style={{ ...ui.input, width: 70, textAlign: 'right' }} aria-label={`Received, ${l.description}`} /></Td>
                <Td right><input inputMode="decimal" value={got[l.id]?.price ?? ''} onChange={(e) => set(l.id, 'price', e.target.value)} style={{ ...ui.input, width: 80, textAlign: 'right' }} aria-label={`Price, ${l.description}`} /></Td>
                <Td right>{shortOf(l) > 0 && !subs.has(l.id) && <Btn small onClick={() => notComing(l)}>Not coming</Btn>}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <div style={{ marginTop: 10 }}>
        {adding ? (
          <select autoFocus defaultValue="" onChange={(e) => addLine(e.target.value)} style={{ ...ui.input, width: 320 }} aria-label="Add a line">
            <option value="" disabled>Pick the product that came</option>
            {(items || []).map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
        ) : <Btn small onClick={openAdd}>Add a line</Btn>}
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 16 }}>
        <Field label="Temperature (C)" hint={t.tooWarm ? `Over ${ACCEPT_MAX_C} C: turn it away.` : null} style={{ marginBottom: 0 }}>
          <input inputMode="decimal" value={temp} onChange={(e) => setTemp(e.target.value)} disabled={dry} style={{ ...ui.input, width: 100 }} aria-label="Temperature" />
        </Field>
        <label style={{ fontSize: 13, display: 'inline-flex', gap: 6, alignItems: 'center' }}><input type="checkbox" checked={dry} onChange={(e) => setDry(e.target.checked)} /> Dry goods (no temperature)</label>
        <Field label="Photo of the note" style={{ marginBottom: 0 }}>
          <input type="file" accept="image/*,application/pdf" onChange={(e) => setPhoto(e.target.files?.[0] || null)} aria-label="Photo of the note" />
        </Field>
      </div>
    </Sheet>
  );
}
