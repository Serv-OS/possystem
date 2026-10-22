// src/surfaces/manager/ManagerShopBuy.jsx
//
// MULTI SITE STOCK Drop 3 (contract 3.4, map 4.23): a shop buy on the phone. Someone popped to the shop
// or the cash and carry: pick the shop (a supplier of this venue, for example 'Local shop'), add what
// was bought with the amount in the item's own unit and what it cost, photograph the receipt, and Book
// it. manager-approve shop.buy posts it through stock_post_invoice with shop_buy (no order): the stock
// comes in at the price paid, and the receipt is kept as the invoice photo. A manager PIN unlocks it.

import { useEffect, useMemo, useState } from 'react';
import { managerApprove } from '../../lib/manager/data';
import { shopBuyLines } from '../../lib/manager/kitchen';
import { photoInputProps, photoButtonLabel } from '../../lib/cameraCapture';
import { money } from '../../lib/currency';
import { SheetFrame, PinGate, box, btn, card } from './ManagerTransfers';
import { mono } from './ui';

const fileToBase64 = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(new Error('Could not read the photo')); r.readAsDataURL(f); });
const newId = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : null);

export default function ManagerShopBuy({ ctx, onClose }) {
  const { snap, loc, refreshSnap } = ctx;
  const [pin, setPin] = useState('');
  const [items, setItems] = useState(null);
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);              // [{ itemId, name, unit, qty, total }]
  const [supplierId, setSupplierId] = useState('');
  const [receiptNo, setReceiptNo] = useState('');
  const [photo, setPhoto] = useState(null);          // { b64, type }
  const [clientId, setClientId] = useState(newId);   // one id per buy: a retry is answered duplicate, never booked twice
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const suppliers = (snap?.kitchen?.orderBy || []).filter((s) => !s.internal);

  useEffect(() => {
    if (!pin || items) return undefined;
    let live = true;
    managerApprove(loc, pin, 'stock.items', 'items', { offset: 0 }).then((r) => {
      if (!live) return;
      if (r?.ok) setItems(r.items || []);
      else { if (/pin|not allowed|approve/i.test(r?.error || '')) setPin(''); setErr(r?.error || 'Could not read the items'); }
    });
    return () => { live = false; };
  }, [pin, items, loc]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return (items || []).filter((i) => String(i.name || '').toLowerCase().includes(q) && !rows.some((r) => r.itemId === i.id)).slice(0, 20);
  }, [items, search, rows]);
  const total = rows.reduce((s, r) => s + (Number(String(r.total).replace(',', '.')) || 0), 0);
  const setRow = (id, k, v) => setRows((list) => list.map((r) => (r.itemId === id ? { ...r, [k]: v } : r)));

  const onPhoto = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try { setPhoto({ b64: await fileToBase64(f), type: f.type || 'image/jpeg' }); } catch (ex) { setErr(ex?.message || 'Could not read the photo'); }
  };

  const book = async () => {
    if (!supplierId) { setErr('Pick the shop or supplier.'); return; }
    const { lines, error, total: sum } = shopBuyLines(rows);
    if (error) { setErr(error); return; }
    setBusy(true); setErr(''); setMsg('');
    const body = { supplier_id: supplierId, receipt_number: receiptNo || null, total: sum, client_id: clientId, lines, scan: photo ? { image_base64: photo.b64, media_type: photo.type } : null };
    let r = await managerApprove(loc, pin, 'shop.buy', null, body);
    // a large photo can be refused by the body limit: the stock is what matters, send it again without
    if (!r?.ok && photo && /413|too large|payload/i.test(r?.error || '')) r = await managerApprove(loc, pin, 'shop.buy', null, { ...body, scan: null });
    setBusy(false);
    if (r?.ok) {
      setMsg(r.duplicate ? 'Already booked.' : `Booked ${lines.length} item${lines.length === 1 ? '' : 's'} into stock (${money(sum)}).`);
      setRows([]); setReceiptNo(''); setPhoto(null); setClientId(newId()); refreshSnap?.();
    } else { if (/pin|not allowed|approve/i.test(r?.error || '')) setPin(''); setErr(r?.error || 'Could not book it'); }
  };

  if (!pin) return <SheetFrame title="Shop buy" sub="Bought at a shop, booked into stock" onClose={onClose}><PinGate onPin={setPin} /></SheetFrame>;

  return (
    <SheetFrame title="Shop buy" sub="Bought at a shop, booked into stock" onClose={onClose}>
      {msg && <div style={{ marginTop: 10, color: 'var(--grn)', fontWeight: 700, fontSize: 13 }}>{msg}</div>}
      {err && <div role="alert" style={{ marginTop: 10, color: 'var(--red)', fontWeight: 700, fontSize: 13 }}>{err}</div>}
      <div className="sv-glass" style={card}>
        <label style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>Shop or supplier
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} style={{ ...box, marginTop: 6 }} aria-label="Shop or supplier">
            <option value="">Pick one</option>
            {suppliers.map((s) => <option key={s.supplierId} value={s.supplierId}>{s.name}</option>)}
          </select>
        </label>
        {suppliers.length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6 }}>No supplier here yet. Add a local shop as a supplier in Back Office.</div>}
        <input value={receiptNo} onChange={(e) => setReceiptNo(e.target.value.slice(0, 60))} placeholder="Receipt number (optional)" aria-label="Receipt number" style={{ ...box, marginTop: 10 }} />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search an item to add" aria-label="Search an item" style={{ ...box, marginTop: 10 }} />
        {!items && <div style={{ color: 'var(--t3)', fontSize: 12, marginTop: 8 }}>Loading items…</div>}
        {shown.map((i) => (
          <button key={i.id} type="button" onClick={() => { setRows((list) => [...list, { itemId: i.id, name: i.name, unit: i.base_unit, qty: '', total: '' }]); setSearch(''); }}
            className="sv-glass" style={{ ...btn('var(--t1)'), width: '100%', textAlign: 'left', marginTop: 6 }}>{i.name} <span style={{ color: 'var(--t3)', fontSize: 11 }}>{i.base_unit}</span></button>
        ))}
      </div>
      {rows.map((r) => (
        <div key={r.itemId} className="sv-glass" style={{ ...card, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 140px', minWidth: 0, fontSize: 13, fontWeight: 700 }}>{r.name}</div>
          <input type="number" inputMode="decimal" min="0" step="any" value={r.qty} onChange={(e) => setRow(r.itemId, 'qty', e.target.value)} aria-label={`${r.name} amount`} placeholder={r.unit} style={{ ...box, width: 90, textAlign: 'right' }} />
          <input type="number" inputMode="decimal" min="0" step="any" value={r.total} onChange={(e) => setRow(r.itemId, 'total', e.target.value)} aria-label={`${r.name} cost`} placeholder="Cost" style={{ ...box, width: 90, textAlign: 'right' }} />
          <button type="button" onClick={() => setRows((list) => list.filter((x) => x.itemId !== r.itemId))} className="sv-glass" style={btn('var(--red)')}>Remove</button>
        </div>
      ))}
      <div className="sv-glass" style={card}>
        <label className="sv-glass" style={{ ...btn('var(--t1)'), display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {photo ? 'Receipt photo added' : `${photoButtonLabel()} of the receipt`}
          <input {...photoInputProps(undefined, 'image/*,application/pdf')} onChange={onPhoto} style={{ display: 'none' }} />
        </label>
        <div style={{ fontSize: 12.5, fontWeight: 700, marginTop: 10, ...mono }}>Total {money(total)}</div>
        <button type="button" disabled={busy || !rows.length} onClick={book} className="sv-glass" style={{ ...btn('var(--grn)', !busy && rows.length > 0), width: '100%', marginTop: 10 }}>{busy ? 'Booking…' : 'Book into stock'}</button>
      </div>
    </SheetFrame>
  );
}
