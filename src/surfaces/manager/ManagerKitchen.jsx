// ManagerKitchen — stock to order (below par/reorder, grouped by supplier) + incoming deliveries
// (open POs: tap one to see every line and receive it on the phone) + batch cooks today (scheduled
// prep, tap to Record). Reads the shared snapshot; the pure decisions live in src/lib/manager/kitchen.js
// and src/lib/stock/purchasingRules.js. Recording a cook writes prep_log (training-gated, RLS-fenced).
// Raising and receiving an order go through manager-approve (device fence + PIN + audit): the phone is
// an anonymous paired session and purchase_orders / po_lines are RLS-fenced to Back Office users, so
// the Ops Deliveries screen could never show or receive an order here. NOT the KDS rail.
//
// v5.11.64: Raise order counts in the supplier's PACKS and shows the pack, the net price, the order
// value and the expected delivery day before the PIN (it used to send the par gap in base units,
// 32 eggs, which the server wrote as 32 packs at a price of 0). Incoming orders open into a sheet:
// type what arrived, or photograph the delivery note and the lines are matched by supplier SKU,
// then our SKU, then name; differences are highlighted; a temperature over 8 C turns Receive into
// Reject; PIN to confirm. Stock, costs, the goods in record and the order status update exactly as
// Back Office receiving does.
import { useState } from 'react';
import { belowPar, bySupplier, groupBatches, qtyText, orderPacksFor, orderValue } from '../../lib/manager/kitchen';
import { nextDeliveryYmd, matchScannedLine } from '../../lib/stock/purchasingRules';
import { localToUtcMs } from '../../lib/venueDate';
import { scanInvoice } from '../../lib/stock/purchasing';
import { photoInputProps, photoButtonLabel } from '../../lib/cameraCapture';
import { recordPrep } from '../../lib/prep';
import { managerRaisePO, managerReceivePO } from '../../lib/manager/data';
import { money } from '../../lib/currency';
import { Header, Stat, SectionTitle, mono } from './ui';
import { Icon } from '../../components/ServOSIcons';
import { useLayout } from './useLayout';

const DEL_PILL = { pending: ['Expected', 'var(--orn)'], overdue: ['Overdue', 'var(--red)'], accepted: ['Arrived', 'var(--grn)'], rejected: ['Rejected', 'var(--red)'] };
const ACCEPT_MAX_C = 8;   // the Ops Deliveries threshold; the server (manager-approve) holds the same figure
const shortDate = (s) => { if (!s) return null; const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s); return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }) : null; };
const timeOf = (ms) => (ms ? new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '');
const qtyLbl = (b) => [b.plannedQty != null ? b.plannedQty : null, b.unit].filter((x) => x != null && x !== '').join(' ');   // '10 l', never '10l'
const packText = (p) => (p ? `${p.packQty || 1} x ${p.innerQty} ${p.innerUnit || ''}`.trim() : '');
const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
// The venue's calendar day: the snapshot says it (v5.11.64); an older snapshot gets the tz reading.
const venueDay = (snap) => snap?.today || new Intl.DateTimeFormat('en-CA', { timeZone: snap?.tz || 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const isPinErr = (msg) => /pin|not allowed|approve/i.test(msg || '');
const fileToBase64 = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = () => rej(new Error('Could not read the photo')); r.readAsDataURL(f); });

export default function ManagerKitchen({ ctx }) {
  const { snap, snapErr: err, loc, operator, refreshSnap } = ctx;
  const L = useLayout();   // style values only (manager/layout.js)
  const [recording, setRecording] = useState(null);
  const [recErr, setRecErr] = useState('');
  const [recQty, setRecQty] = useState({});      // batchId -> what was actually made (v5.11.65; the planned figure used to be logged as made)
  const [recNote, setRecNote] = useState({});    // batchId -> 'logged, but stock not updated' in red, once hidden behind a green tick
  // Raise PO (per supplier) — secure write path: manager-approve po.raise (device fence + PIN + audit).
  const [poFor, setPoFor] = useState(null);      // supplier group whose order sheet is open
  const [poQty, setPoQty] = useState({});        // itemId -> PACKS (0 = removed from this order)
  const [poPin, setPoPin] = useState('');        // manager PIN, validated server-side, cached for the session
  const [poEntry, setPoEntry] = useState('');
  const [poErr, setPoErr] = useState('');
  const [poBusy, setPoBusy] = useState(false);
  const [poDone, setPoDone] = useState({});      // supplier -> { reference, expectedDate, subtotal } (raised this session)
  // Receive (one open order) — manager-approve po.receive.
  const [delOpen, setDelOpen] = useState(null);  // the order (snapshot deliveries row) whose sheet is open
  const [recv, setRecv] = useState({});          // lineId -> { qtyPacks, unitPrice }
  const [tempC, setTempC] = useState('');
  const [dryGoods, setDryGoods] = useState(false);
  const [scan, setScan] = useState(null);        // { header, matched: { [lineId]: { readQty, readPrice, diffQty, diffPrice } }, unmatched: [] }
  const [scanFile, setScanFile] = useState(null);  // { b64, type }
  const [scanBusy, setScanBusy] = useState(false);
  const [recvErr, setRecvErr] = useState('');
  const [recvBusy, setRecvBusy] = useState(false);
  const [recvDone, setRecvDone] = useState({});  // poId -> message (received this session)

  const today = venueDay(snap);
  const unlockPin = (fail) => { if (poEntry.length >= 4) setPoPin(poEntry); else fail?.('Enter your 4 to 6 digit PIN'); };

  // ── Raise order ──────────────────────────────────────────────────────────────
  const openPoSheet = (sup, lines) => {
    setPoFor(sup); setPoErr('');
    // the par gap in whole supplier packs (never fewer than one); an item with no pack starts at 0 and is left out
    setPoQty(Object.fromEntries(lines.map((i) => [i.itemId, orderPacksFor(i)])));
  };
  const stepQty = (id, d) => setPoQty((q) => ({ ...q, [id]: Math.max(0, (Number(q[id]) || 0) + d) }));
  const submitPO = async (sup, lines) => {
    const order = lines.filter((i) => i.pack && (Number(poQty[i.itemId]) || 0) > 0)
      .map((i) => ({ inventory_item_id: i.itemId, description: i.name, qty_packs: Number(poQty[i.itemId]) }));
    if (!order.length) { setPoErr('Nothing left on this order. Set a quantity.'); return; }
    setPoBusy(true); setPoErr('');
    const r = await managerRaisePO(loc, poPin, { supplierId: lines[0]?.supplierId || null, supplierName: sup, lines: order });
    setPoBusy(false);
    if (r?.ok) { setPoDone((d) => ({ ...d, [sup]: { reference: r.reference, expectedDate: r.expected_date || null, subtotal: r.subtotal } })); setPoFor(null); refreshSnap?.(); }
    else if (isPinErr(r?.error)) { setPoPin(''); setPoEntry(''); setPoErr(r?.error || 'PIN not recognised'); }
    else setPoErr(r?.error || 'Could not raise the order');
  };

  // ── Receive ──────────────────────────────────────────────────────────────────
  const outstandingOf = (l) => Math.max(0, (Number(l.qtyPacks) || 0) - (Number(l.qtyReceived) || 0));
  const openDelivery = (d) => {
    setDelOpen(d); setRecvErr('');
    setRecv(Object.fromEntries((d.orderLines || []).map((l) => [l.id, { qtyPacks: outstandingOf(l), unitPrice: l.unitPrice }])));
    setScan(null); setScanFile(null); setTempC(''); setDryGoods(false);
  };
  const setRecvLine = (id, k, v) => setRecv((m) => ({ ...m, [id]: { ...(m[id] || {}), [k]: v } }));
  const stepRecv = (l, d) => setRecv((m) => ({ ...m, [l.id]: { ...(m[l.id] || {}), qtyPacks: Math.max(0, (Number(m[l.id]?.qtyPacks) || 0) + d) } }));
  const asOrdered = (d) => { setRecv(Object.fromEntries((d.orderLines || []).map((l) => [l.id, { qtyPacks: outstandingOf(l), unitPrice: l.unitPrice }]))); setScan(null); };

  const onScanFile = async (e, d) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setScanBusy(true); setRecvErr('');
    try {
      const b64 = await fileToBase64(f);
      const { data, error } = await scanInvoice(b64, f.type);
      if (error) { setRecvErr(`Could not read the note: ${typeof error === 'string' ? error : error.message || 'try a clearer photo'}. You can still type what arrived.`); return; }
      setScanFile({ b64, type: f.type || 'image/jpeg' });
      // match every read line to this order: supplier SKU, then our SKU, then the name
      const cands = (d.orderLines || []).map((l) => ({ key: l.id, name: l.description, supplierSku: l.supplierSku, itemSku: l.itemSku }));
      const matched = {}; const unmatched = [];
      const next = { ...recv };
      for (const rl of (data.lines || [])) {
        const { match } = matchScannedLine(rl, cands.filter((c) => !matched[c.key]));
        if (!match) { unmatched.push(rl); continue; }
        const line = d.orderLines.find((l) => l.id === match.key);
        const readQty = Number(rl.qty) || 0;
        const readPrice = rl.unit_price != null && Number.isFinite(Number(rl.unit_price)) ? Number(rl.unit_price) : null;
        matched[match.key] = { readQty, readPrice, diffQty: r2(readQty - outstandingOf(line)), diffPrice: readPrice != null ? r2(readPrice - (Number(line.unitPrice) || 0)) : 0 };
        next[match.key] = { qtyPacks: readQty, unitPrice: readPrice != null ? readPrice : line.unitPrice };
      }
      setRecv(next);
      setScan({ header: { invoiceNumber: data.invoice_number || null, invoiceDate: data.invoice_date || null, total: data.total ?? null, raw: data }, matched, unmatched });
    } catch (ex) { setRecvErr(ex?.message || 'Could not read the photo'); }
    finally { setScanBusy(false); }
  };

  const tempNum = tempC === '' ? null : Number(tempC);
  const tempKnown = dryGoods || (tempNum != null && Number.isFinite(tempNum));
  const tooWarm = !dryGoods && tempNum != null && Number.isFinite(tempNum) && tempNum > ACCEPT_MAX_C;

  const submitReceive = async (d) => {
    const accept = !tooWarm;
    const receipts = (d.orderLines || []).map((l) => ({ line_id: l.id, qty_packs: Number(recv[l.id]?.qtyPacks) || 0, unit_price: recv[l.id]?.unitPrice === '' || recv[l.id]?.unitPrice == null ? null : Number(recv[l.id].unitPrice) }));
    if (accept && !receipts.some((r) => r.qty_packs > 0)) { setRecvErr('Nothing marked as arrived. Set a quantity, or set the temperature over 8 C to reject the delivery.'); return; }
    setRecvBusy(true); setRecvErr('');
    const scanBody = scan ? { invoice_number: scan.header.invoiceNumber, invoice_date: scan.header.invoiceDate, total: scan.header.total, raw: scan.header.raw, image_base64: scanFile?.b64 || null, media_type: scanFile?.type || null } : null;
    const args = { poId: d.id, accept, temperatureC: dryGoods ? null : tempNum, receipts, scan: scanBody };
    let r = await managerReceivePO(loc, poPin, args);
    // a large photo can be refused by the function body limit: the receive is the thing that matters,
    // so send it once more without the picture (the note can be attached again in Back Office)
    if (!r?.ok && scanBody?.image_base64 && /413|too large|payload/i.test(r?.error || '')) {
      r = await managerReceivePO(loc, poPin, { ...args, scan: { ...scanBody, image_base64: null } });
    }
    setRecvBusy(false);
    if (r?.ok) {
      const msg = r.rejected
        ? `Delivery from ${d.supplier || 'the supplier'} rejected (over ${ACCEPT_MAX_C} C). Nothing booked into stock; the order stays open.`
        : `Received ${r.received} line${r.received === 1 ? '' : 's'}: stock and costs updated${r.shorted ? `, balance order ${r.balance_reference || ''} raised for ${r.shorted} short line${r.shorted === 1 ? '' : 's'}` : ''}${r.invoice_id ? ', note kept on the order' : ''}.`;
      setRecvDone((m) => ({ ...m, [d.id]: msg })); setDelOpen(null); refreshSnap?.();
    } else if (isPinErr(r?.error)) { setPoPin(''); setPoEntry(''); setRecvErr(r?.error || 'PIN not recognised'); }
    else setRecvErr(r?.error || 'Could not receive the order');
  };

  const items = snap?.kitchen?.items || [];
  const incoming = (snap?.kitchen?.deliveries || []).filter((d) => !recvDone[d.id]);
  const short = belowPar(items);
  const groups = bySupplier(items);
  const supplierNames = Object.keys(groups).sort((a, b) => (a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b)));

  // Batch cooks: the snapshot passes the raw dueDate + dueTime; dueAtMs is that wall clock time in the
  // VENUE's timezone (snap.tz). v5.11.65: Date.parse read it in the device's zone, so a 10:00 UK cook
  // viewed from California turned overdue at 10:00 Pacific, eight hours late.
  const batches = (snap?.kitchen?.batches || []).map((b) => ({ ...b, dueAtMs: b.dueTime ? localToUtcMs(b.dueDate, b.dueTime, snap?.tz) : null }));
  const grp = groupBatches(batches);
  const batchTotal = grp.counts.done + grp.counts.overdue + grp.counts.due;

  const doRecord = async (b) => {
    // what was ACTUALLY made (defaults to the plan); a 38 of 40 batch is not a 100% yield
    const made = recQty[b.id] === undefined ? b.plannedQty : recQty[b.id];
    const n = Number(made);
    if (!(n > 0)) { setRecErr(`${b.name}: enter how much was made before recording.`); return; }
    setRecording(b.id); setRecErr('');
    const r = await recordPrep({ scheduleId: b.scheduleId, name: b.name, prepDate: b.dueDate, actualQty: n, unit: b.unit, operator }, loc);
    setRecording(null);
    if (!r?.ok) { setRecErr(r?.error || 'Could not record'); return; }
    // recordPrep logs the cook even when the batch could not move stock; that used to vanish behind the tick
    if (r.produceError) setRecNote((m) => ({ ...m, [b.id]: `Logged, but stock was NOT updated: ${r.produceError}` }));
    else setRecNote((m) => { const next = { ...m }; delete next[b.id]; return next; });
    refreshSnap?.();
  };

  const batchRow = (b, state) => {
    const busy = recording === b.id;
    const tone = state === 'overdue' ? 'var(--red)' : state === 'done' ? 'var(--grn)' : 'var(--t3)';
    const sub = state === 'done'
      ? `✓ logged ${timeOf(b.completedAtMs)}${b.assignee ? ` · ${b.assignee}` : ''}`
      : state === 'overdue'
      ? `overdue${b.dueTime ? ` · due ${b.dueTime}` : ''}`
      : (b.dueTime ? `due ${b.dueTime}` : 'today');
    return (
      <div key={b.id} className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, border: state === 'overdue' ? '1px solid var(--red-b)' : '1px solid var(--bdr)' }}>
        {state === 'done'
          ? <span style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--grn)', display: 'grid', placeItems: 'center', flexShrink: 0 }}><Icon name="check" size={14} style={{ color: '#06130C' }} /></span>
          : <Icon name="fire" size={16} style={{ color: tone, flexShrink: 0 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>{b.name}{qtyLbl(b) ? <span style={{ color: 'var(--t3)', fontWeight: 600 }}> · {qtyLbl(b)}</span> : null}</div>
          <div style={{ fontSize: 11, color: tone, ...mono }}>{sub}</div>
          {recNote[b.id] && <div style={{ fontSize: 11, color: 'var(--red)', fontWeight: 700, marginTop: 3, lineHeight: 1.4 }}>{recNote[b.id]}</div>}
        </div>
        {state !== 'done' && (
          <>
            {numInput(recQty[b.id] ?? (b.plannedQty ?? ''), (v) => setRecQty((m) => ({ ...m, [b.id]: v })), 64)}
            {b.unit ? <span style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{b.unit}</span> : null}
            <button onClick={() => doRecord(b)} disabled={busy} className="sv-glass"
              style={{ padding: '8px 14px', borderRadius: 999, border: '1px solid var(--grn-b)', cursor: busy ? 'default' : 'pointer', color: 'var(--grn)', fontWeight: 800, fontSize: 12.5, fontFamily: 'inherit', flexShrink: 0 }}>
              {busy ? '…' : 'Record'}
            </button>
          </>
        )}
      </div>
    );
  };

  // The manager PIN box, shared by Raise order and Receive (one PIN a session, verified server side).
  const pinBox = (setErr) => (!poPin && (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginBottom: 6 }}>Manager PIN to confirm</div>
      <input value={poEntry} type="password" inputMode="numeric" placeholder="PIN"
        onChange={(e) => { setErr(''); setPoEntry(e.target.value.replace(/\D/g, '').slice(0, 6)); }}
        onKeyDown={(e) => { if (e.key === 'Enter') unlockPin(setErr); }}
        style={{ width: 130, padding: '10px 12px', borderRadius: 11, border: '1px solid var(--bdr)', background: 'var(--inset, transparent)', color: 'var(--t1)', fontSize: 16, letterSpacing: '0.3em', fontFamily: 'var(--font-mono)', outline: 'none' }} />
      <button onClick={() => unlockPin(setErr)} className="sv-glass" style={{ marginLeft: 8, padding: '10px 16px', borderRadius: 11, border: '1px solid var(--bdr)', cursor: 'pointer', color: 'var(--t1)', fontWeight: 800, fontSize: 13, fontFamily: 'inherit' }}>Unlock</button>
    </div>
  ));
  const stepBtn = (onClick, label, disabled) => (
    <button onClick={onClick} disabled={disabled} className="sv-glass" style={{ width: 32, height: 32, borderRadius: 10, border: '1px solid var(--bdr)', cursor: disabled ? 'default' : 'pointer', color: disabled ? 'var(--t4)' : 'var(--t2)', fontSize: 16, fontWeight: 800, fontFamily: 'inherit', ...L.s.hit }}>{label}</button>
  );
  const numInput = (value, onChange, width = 72, extra = {}) => (
    <input type="number" inputMode="decimal" min="0" step="any" value={value ?? ''} onChange={(e) => onChange(e.target.value)}
      style={{ width, padding: '8px 9px', borderRadius: 10, border: '1px solid var(--bdr)', background: 'var(--inset, transparent)', color: 'var(--t1)', fontSize: 14, fontWeight: 700, textAlign: 'right', fontFamily: 'var(--font-mono)', outline: 'none', ...extra }} />
  );

  return (
    <div style={L.s.page2}>
      <Header title="Kitchen" sub="Stock · deliveries · prep" />
      {!snap && !err && <div style={{ color: 'var(--t3)', padding: 16, ...mono, ...L.s.span }}>Loading…</div>}
      {err && <div className="sv-glass" style={{ padding: 16, marginTop: 12, color: 'var(--t3)', fontSize: 13, ...L.s.span }}>Couldn’t load stock ({err}).</div>}

      {snap && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 12, ...L.s.kitchenStats }}>
            <Stat label="To order" value={short.length} tone={short.length ? 'var(--red)' : 'var(--grn)'} />
            <Stat label="Incoming" value={incoming.length} tone={incoming.length ? 'var(--orn)' : 'var(--t1)'} />
          </div>

          <div style={L.s.pane}>
          {short.length === 0 && (
            <div className="sv-glass" style={{ padding: 20, marginTop: 12, textAlign: 'center' }}>
              <Icon name="check" size={24} style={{ color: 'var(--grn)' }} />
              <div style={{ fontSize: 14, fontWeight: 700, marginTop: 6 }}>Everything’s at par</div>
              <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>No tracked item is below par or its reorder point.</div>
            </div>
          )}

          {supplierNames.map((sup) => {
            const lines = groups[sup];
            const sheetValue = orderValue(lines, poQty);
            const expected = nextDeliveryYmd(lines[0]?.deliveryDays, today);
            const lineCount = lines.filter((i) => i.pack && (Number(poQty[i.itemId]) || 0) > 0).length;
            const canRaise = sup !== 'Unassigned' && lines.some((i) => i.pack);
            return (
            <div key={sup}>
              <SectionTitle right={`${lines.length} item${lines.length === 1 ? '' : 's'}`}>{sup}</SectionTitle>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {lines.map((i) => (
                  <div key={i.itemId} className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, border: i.belowReorder ? '1px solid var(--red-b)' : '1px solid var(--bdr)' }}>
                    <Icon name="inventory" size={16} style={{ color: i.belowReorder ? 'var(--red)' : 'var(--t3)', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>{i.name}</div>
                      <div style={{ fontSize: 11, color: i.belowReorder ? 'var(--red)' : 'var(--t3)', ...mono }}>
                        {qtyText(i.onHand, i.unit)} on hand · par {i.par != null ? qtyText(i.par, i.unit) : '—'}{i.belowReorder ? ' · below reorder' : ''}
                      </div>
                    </div>
                    {i.shortfall > 0 && <span style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--orn)', ...mono }}>+{qtyText(i.shortfall, i.unit)}</span>}
                  </div>
                ))}

                {/* Raise order — per supplier. Sheet: packs per line (default = the par gap in whole packs),
                    the pack and its price under each name, the order value and expected day, then PIN → send. */}
                {poDone[sup] ? (
                  <div className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 14, border: '1px solid var(--grn-b)' }}>
                    <Icon name="check" size={15} style={{ color: 'var(--grn)', flexShrink: 0 }} />
                    <div style={{ fontSize: 12.5, color: 'var(--grn)', fontWeight: 700 }}>
                      Order {poDone[sup].reference} raised{poDone[sup].subtotal != null ? ` · ${money(poDone[sup].subtotal)} ex VAT` : ''}{poDone[sup].expectedDate ? ` · expected ${shortDate(poDone[sup].expectedDate)}` : ''}. It is under On order · incoming.
                    </div>
                  </div>
                ) : poFor === sup ? (
                  <div className="sv-glass" style={{ padding: 14, borderRadius: 14, border: '1px solid var(--acc-b, var(--bdr))', ...L.s.orderSheet }}>
                    <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 10 }}>Order from {sup}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {lines.map((i) => {
                        const q = Number(poQty[i.itemId]) || 0;
                        const noPack = !i.pack;
                        return (
                          <div key={i.itemId} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 600, textDecoration: q === 0 && !noPack ? 'line-through' : 'none', color: q === 0 || noPack ? 'var(--t4)' : 'var(--t1)' }}>{i.name}</div>
                              <div style={{ fontSize: 11, color: noPack ? 'var(--red)' : 'var(--t3)', ...mono }}>
                                {noPack ? 'No supplier pack in Back Office' : `${packText(i.pack)} · ${money(i.pack.packPrice)} a pack`}
                              </div>
                            </div>
                            {!noPack && (
                              <>
                                {stepBtn(() => stepQty(i.itemId, -1), '−', false)}
                                <span style={{ width: 28, textAlign: 'center', fontSize: 14, fontWeight: 800, ...mono }}>{q}</span>
                                {stepBtn(() => stepQty(i.itemId, 1), '+', false)}
                                <span style={{ width: 64, textAlign: 'right', fontSize: 12.5, fontWeight: 700, color: q ? 'var(--t1)' : 'var(--t4)', ...mono }}>{q ? money(q * (Number(i.pack.packPrice) || 0)) : ''}</span>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div style={{ marginTop: 12, fontSize: 12.5, fontWeight: 700, color: 'var(--t2)', ...mono }}>
                      Order value {money(sheetValue)} ex VAT{expected ? ` · expected ${shortDate(expected)}` : ''}
                    </div>
                    {pinBox(setPoErr)}
                    {poErr && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8 }}>{poErr}</div>}
                    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                      <button onClick={() => setPoFor(null)} className="sv-glass" style={{ flex: 1, padding: '12px 0', borderRadius: 12, border: '1px solid var(--bdr)', cursor: 'pointer', color: 'var(--t2)', fontWeight: 800, fontSize: 13, fontFamily: 'inherit' }}>Cancel</button>
                      <button onClick={() => submitPO(sup, lines)} disabled={poBusy || !poPin || !lineCount} className="sv-glass"
                        style={{ flex: 2, padding: '12px 0', borderRadius: 12, border: '1px solid var(--grn-b)', cursor: poBusy || !poPin || !lineCount ? 'default' : 'pointer', color: poPin && lineCount ? 'var(--grn)' : 'var(--t4)', fontWeight: 800, fontSize: 13, fontFamily: 'inherit' }}>
                        {poBusy ? 'Sending…' : `Send order (${lineCount} line${lineCount === 1 ? '' : 's'} · ${money(sheetValue)})`}
                      </button>
                    </div>
                  </div>
                ) : canRaise ? (
                  <button onClick={() => openPoSheet(sup, lines)} className="sv-glass"
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 0', borderRadius: 12, border: '1px solid var(--grn-b)', cursor: 'pointer', color: 'var(--grn)', fontWeight: 800, fontSize: 13, fontFamily: 'inherit', ...L.s.cta }}>
                    <Icon name="delivery" size={14} /> Raise order · {sup}
                  </button>
                ) : (
                  <div style={{ fontSize: 11, color: 'var(--t3)', lineHeight: 1.5, ...mono }}>
                    {sup === 'Unassigned' ? 'No supplier on these items. Add a supplier pack in Back Office, Stock, to order them here.' : 'No supplier pack in Back Office for these items yet.'}
                  </div>
                )}
              </div>
            </div>
            );
          })}
          </div>

          <div style={L.s.pane}>
          {(incoming.length > 0 || Object.keys(recvDone).length > 0) && (
            <>
              <SectionTitle right={`${incoming.length} ${incoming.length === 1 ? 'order' : 'orders'}`}>On order · incoming</SectionTitle>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, ...L.s.paneRows }}>
                {Object.entries(recvDone).map(([id, msg]) => (
                  <div key={id} className="sv-glass" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderRadius: 14, border: '1px solid var(--grn-b)' }}>
                    <Icon name="check" size={15} style={{ color: 'var(--grn)', flexShrink: 0 }} />
                    <div style={{ fontSize: 12.5, color: 'var(--grn)', fontWeight: 700 }}>{msg}</div>
                  </div>
                ))}
                {incoming.map((d) => {
                  const key = d.status === 'pending' && d.expectedDate && d.expectedDate < today ? 'overdue' : d.status;
                  const [pillLabel, pillCol] = DEL_PILL[key] || DEL_PILL.pending;
                  const when = d.expectedDate ? (d.expectedDate === today ? 'due today' : (key === 'overdue' ? `was due ${shortDate(d.expectedDate)}` : shortDate(d.expectedDate))) : 'no date set';
                  const open = delOpen?.id === d.id;
                  return (
                    <div key={d.id} style={{ display: 'contents' }}>
                    <button onClick={() => (open ? setDelOpen(null) : openDelivery(d))} className="sv-glass"
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 14, border: open ? '1px solid var(--acc-b, var(--bdr))' : '1px solid var(--bdr)', cursor: 'pointer', textAlign: 'left', color: 'var(--t1)', fontFamily: 'inherit', width: '100%' }}>
                      <Icon name="delivery" size={16} style={{ color: 'var(--t3)', flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 700 }}>{d.supplier || 'Supplier'}{d.reference ? <span style={{ color: 'var(--t3)', fontWeight: 600 }}> · {d.reference}</span> : null}</div>
                        <div style={{ fontSize: 11, color: key === 'overdue' ? 'var(--red)' : 'var(--t3)', ...mono }}>
                          {d.lines} line{d.lines === 1 ? '' : 's'} · {when}{d.value ? ` · ${money(d.value)}` : ''}
                        </div>
                      </div>
                      <span style={{ fontSize: 11, fontWeight: 700, color: pillCol, ...mono }}>{pillLabel}</span>
                    </button>

                    {open && (
                      <div className="sv-glass" style={{ padding: 14, borderRadius: 14, border: '1px solid var(--acc-b, var(--bdr))', ...L.s.orderSheet }}>
                        <div style={{ fontSize: 13, fontWeight: 800 }}>Order {d.reference || ''} from {d.supplier || 'the supplier'}</div>
                        <div style={{ fontSize: 11, color: key === 'overdue' ? 'var(--red)' : 'var(--t3)', marginTop: 2, ...mono }}>
                          {key === 'overdue' ? `Overdue since ${shortDate(d.expectedDate)}` : d.expectedDate ? `Expected ${shortDate(d.expectedDate)}` : 'No expected date set'}{d.value ? ` · ordered ${money(d.value)} ex VAT` : ''}
                        </div>

                        {(!d.orderLines || d.orderLines.length === 0) && (
                          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 10, lineHeight: 1.5 }}>The order lines did not come through. Update the app, or receive this order in Back Office, Orders.</div>
                        )}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
                          {(d.orderLines || []).map((l) => {
                            const rv = recv[l.id] || {};
                            const m = scan?.matched?.[l.id];
                            const differs = m && (Math.abs(m.diffQty) > 0.001 || Math.abs(m.diffPrice) > 0.004);
                            const outstanding = outstandingOf(l);
                            return (
                              <div key={l.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: differs ? '8px 10px' : 0, borderRadius: 10, background: differs ? 'color-mix(in srgb, var(--orn) 14%, transparent)' : 'transparent' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: 13, fontWeight: 600 }}>{l.description || 'Line'}</div>
                                    <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>
                                      {packText(l)} · ordered {outstanding}{l.qtyReceived ? ` (of ${l.qtyPacks}, ${l.qtyReceived} in)` : ''} · {money(l.unitPrice)} a pack
                                    </div>
                                    {differs && <div style={{ fontSize: 11, color: 'var(--orn)', fontWeight: 700, ...mono }}>
                                      note says {m.readQty}{Math.abs(m.diffQty) > 0.001 ? ` (${m.diffQty > 0 ? '+' : ''}${m.diffQty})` : ''}{Math.abs(m.diffPrice) > 0.004 ? ` · price ${money(m.readPrice)} (${m.diffPrice > 0 ? '+' : ''}${money(m.diffPrice)})` : ''}
                                    </div>}
                                  </div>
                                  {stepBtn(() => stepRecv(l, -1), '−', false)}
                                  {numInput(rv.qtyPacks, (v) => setRecvLine(l.id, 'qtyPacks', v), 56)}
                                  {stepBtn(() => stepRecv(l, 1), '+', false)}
                                </div>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
                                  <span style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>price a pack</span>
                                  {numInput(rv.unitPrice, (v) => setRecvLine(l.id, 'unitPrice', v), 84)}
                                  <span style={{ width: 72, textAlign: 'right', fontSize: 12.5, fontWeight: 700, ...mono }}>{money((Number(rv.qtyPacks) || 0) * (Number(rv.unitPrice) || 0))}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                        {scan?.unmatched?.length > 0 && (
                          <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--t3)', lineHeight: 1.5 }}>
                            <b style={{ color: 'var(--t2)' }}>On the note but not on this order:</b> {scan.unmatched.map((u) => `${u.description || 'line'}${u.qty != null ? ` x${u.qty}` : ''}`).join(', ')}. Nothing is booked for these.
                          </div>
                        )}

                        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                          <button onClick={() => asOrdered(d)} className="sv-glass" style={{ padding: '10px 14px', borderRadius: 11, border: '1px solid var(--bdr)', cursor: 'pointer', color: 'var(--t2)', fontWeight: 800, fontSize: 12.5, fontFamily: 'inherit' }}>✓ All as ordered</button>
                          <label className="sv-glass" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 11, border: '1px solid var(--bdr)', cursor: scanBusy ? 'default' : 'pointer', color: 'var(--t1)', fontWeight: 800, fontSize: 12.5, opacity: scanBusy ? 0.6 : 1 }}>
                            <Icon name="camera" size={14} /> {scanBusy ? 'Reading the note…' : `${photoButtonLabel()} of the delivery note`}
                            <input {...photoInputProps(undefined, 'image/*,application/pdf')} onChange={(e) => onScanFile(e, d)} disabled={scanBusy} style={{ display: 'none' }} />
                          </label>
                        </div>
                        {scan && <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 6, ...mono }}>Note read{scan.header.invoiceNumber ? ` · no. ${scan.header.invoiceNumber}` : ''}{scan.header.total != null ? ` · total ${money(scan.header.total)}` : ''} · {Object.keys(scan.matched).length} of {(d.orderLines || []).length} lines matched. Amber lines differ from the order.</div>}

                        {/* Temperature: the goods in record, as the Ops Deliveries screen writes it. */}
                        <div style={{ marginTop: 14 }}>
                          {d.delivery && d.delivery.temperatureC != null ? (
                            <div style={{ fontSize: 12, color: 'var(--t2)', ...mono }}>Temperature check: {d.delivery.temperatureC} C{d.delivery.checkedByName ? ` by ${d.delivery.checkedByName}` : ''}{d.delivery.status === 'rejected' ? ' · rejected' : ''}</div>
                          ) : null}
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>Delivery temperature (C)</span>
                            {numInput(tempC, (v) => { setTempC(v); if (v !== '') setDryGoods(false); }, 72, { opacity: dryGoods ? 0.4 : 1 })}
                            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--t2)', cursor: 'pointer' }}>
                              <input type="checkbox" checked={dryGoods} onChange={(e) => { setDryGoods(e.target.checked); if (e.target.checked) setTempC(''); }} /> Dry goods, no temperature
                            </label>
                          </div>
                          {tooWarm && <div style={{ fontSize: 12, color: 'var(--red)', fontWeight: 700, marginTop: 6 }}>Over {ACCEPT_MAX_C} C: this delivery will be rejected and nothing booked into stock.</div>}
                        </div>

                        {pinBox(setRecvErr)}
                        {recvErr && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 8, lineHeight: 1.4 }}>{recvErr}</div>}
                        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                          <button onClick={() => setDelOpen(null)} className="sv-glass" style={{ flex: 1, padding: '12px 0', borderRadius: 12, border: '1px solid var(--bdr)', cursor: 'pointer', color: 'var(--t2)', fontWeight: 800, fontSize: 13, fontFamily: 'inherit' }}>Close</button>
                          <button onClick={() => submitReceive(d)} disabled={recvBusy || !poPin || !tempKnown || !(d.orderLines || []).length} className="sv-glass"
                            style={{ flex: 2, padding: '12px 0', borderRadius: 12, border: `1px solid ${tooWarm ? 'var(--red-b)' : 'var(--grn-b)'}`, cursor: recvBusy || !poPin || !tempKnown ? 'default' : 'pointer', color: !poPin || !tempKnown ? 'var(--t4)' : tooWarm ? 'var(--red)' : 'var(--grn)', fontWeight: 800, fontSize: 13, fontFamily: 'inherit' }}>
                            {recvBusy ? 'Saving…' : tooWarm ? `Reject delivery (over ${ACCEPT_MAX_C} C)` : !tempKnown ? 'Enter the temperature first' : `Receive ${(d.orderLines || []).filter((l) => (Number(recv[l.id]?.qtyPacks) || 0) > 0).length} line${(d.orderLines || []).filter((l) => (Number(recv[l.id]?.qtyPacks) || 0) > 0).length === 1 ? '' : 's'}`}
                          </button>
                        </div>
                      </div>
                    )}
                    </div>
                  );
                })}
              </div>
              <div style={{ fontSize: 11, color: 'var(--t3)', marginTop: 8, lineHeight: 1.5, ...mono }}>Tap an order to see it and receive it. Stock and costs update as in Back Office.</div>
            </>
          )}

          {batchTotal > 0 && (
            <>
              <SectionTitle right={`${grp.counts.done}/${batchTotal} done`}>Batch cooks · today</SectionTitle>
              {recErr && <div className="sv-glass" style={{ padding: '10px 14px', marginBottom: 8, color: 'var(--red)', fontSize: 12.5, border: '1px solid var(--red-b)' }}>{recErr}</div>}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {grp.overdue.map((b) => batchRow(b, 'overdue'))}
                {grp.due.map((b) => batchRow(b, 'due'))}
                {grp.done.map((b) => batchRow(b, 'done'))}
              </div>
            </>
          )}

          {batchTotal === 0 && (
            <div className="sv-glass" style={{ padding: 16, marginTop: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 800 }}>Batch cooks</div>
              <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 }}>
                Nothing scheduled for today. Set up the prep list in Back Office → Operations → Prep schedule.
              </div>
            </div>
          )}
          </div>
        </>
      )}
    </div>
  );
}
