// purchasing/CreditRequestModal.jsx: a new or changed credit request (multi site stock Drop 3,
// v5.11.96, contract 3.2 and 4.2). The site, supplier, reason and lines (what was charged, what was
// agreed); the amount is the sum of the lines. Saving emails nothing by itself: Email again sends it.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { fetchSuppliers } from '../../../lib/stock/data';
import { moneyWords } from '../../../lib/stock/purchasingRules';
import { CREDIT_REASONS } from '../../../lib/stock/purchasingWords';
import { Modal, Btn, Field, TableWrap, Th, Td, ErrorLine, ui } from '../stock/stockUi';

const blank = () => ({ description: '', qty: '1', unit_price_charged: '', unit_price_agreed: '', inventory_item_id: null });
const lineAmount = (l) => {
  const q = Number(l.qty) || 0;
  const c = Number(l.unit_price_charged) || 0;
  const a = l.unit_price_agreed === '' || l.unit_price_agreed == null ? 0 : Number(l.unit_price_agreed) || 0;
  return Math.round(q * (a > 0 ? c - a : c) * 100) / 100;
};

export default function CreditRequestModal({ request = null, onDone, onClose }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const [loc, setLoc] = useState(request?.location_id || sc.oneSite?.id || '');
  const [supplierId, setSupplierId] = useState(request?.supplier_id || '');
  const [suppliers, setSuppliers] = useState([]);
  const [reason, setReason] = useState(request?.reason || 'overcharge');
  const [note, setNote] = useState(request?.note || '');
  const [lines, setLines] = useState(() => (request?.lines?.length ? request.lines.map((l) => ({ ...l, qty: String(l.qty), unit_price_charged: l.unit_price_charged ?? '', unit_price_agreed: l.unit_price_agreed ?? '' })) : [blank()]));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let on = true;
    if (!loc) return undefined;
    fetchSuppliers(loc).then((r) => { if (on) setSuppliers(r.data || []); });
    return () => { on = false; };
  }, [loc]);
  const total = useMemo(() => lines.reduce((s, l) => s + lineAmount(l), 0), [lines]);
  const setLine = (i, k, v) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const save = async () => {
    if (!loc || !supplierId) { setError(new Error('Pick the site and the supplier.')); return; }
    const good = lines.filter((l) => l.description.trim() && Number(l.qty) > 0);
    if (!good.length) { setError(new Error('Add at least one line with a description and a quantity.')); return; }
    setBusy(true); setError(null);
    const r = await stockApi.saveCreditRequest({
      ...(request?.id ? { id: request.id } : {}), location_id: loc, supplier_id: supplierId, invoice_id: request?.invoice_id || null, po_id: request?.po_id || null, reason, note: note.trim() || null,
      lines: good.map((l) => ({ inventory_item_id: l.inventory_item_id || null, description: l.description.trim(), qty: Number(l.qty), unit_price_charged: l.unit_price_charged === '' ? null : Number(l.unit_price_charged), unit_price_agreed: l.unit_price_agreed === '' ? null : Number(l.unit_price_agreed), amount: lineAmount(l) })),
    }, request?.row_version ?? null);
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    showToast?.('Credit request saved.', 'success');
    onDone?.();
  };
  return (
    <Modal title={request?.id ? 'Credit request' : 'New credit request'} onClose={onClose} width={760} dirty
      footer={<><span style={{ fontSize: 13 }}>Amount <b>{moneyWords(total)}</b></span><span style={{ marginLeft: 'auto' }} /><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Btn></>}>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Field label="Site">
          <select value={loc} onChange={(e) => { setLoc(e.target.value); setSupplierId(''); }} disabled={!!request?.id} style={{ ...ui.input, width: 200 }} aria-label="Site">
            <option value="">Pick a site</option>
            {(sc.sites || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Supplier">
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} disabled={!!request?.id} style={{ ...ui.input, width: 220 }} aria-label="Supplier">
            <option value="">Pick a supplier</option>
            {(loc ? suppliers : []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </Field>
        <Field label="Reason">
          <select value={reason} onChange={(e) => setReason(e.target.value)} style={{ ...ui.input, width: 180 }} aria-label="Reason">
            {CREDIT_REASONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </Field>
      </div>
      <TableWrap minWidth={640}>
        <thead><tr><Th>What</Th><Th right>Qty</Th><Th right>Charged each</Th><Th right>Agreed each</Th><Th right>Amount</Th><Th> </Th></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <Td><input value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)} style={ui.input} aria-label="What" /></Td>
              <Td right><input inputMode="decimal" value={l.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} style={{ ...ui.input, width: 64, textAlign: 'right' }} aria-label="Qty" /></Td>
              <Td right><input inputMode="decimal" value={l.unit_price_charged} onChange={(e) => setLine(i, 'unit_price_charged', e.target.value)} style={{ ...ui.input, width: 90, textAlign: 'right' }} aria-label="Charged each" /></Td>
              <Td right><input inputMode="decimal" value={l.unit_price_agreed} onChange={(e) => setLine(i, 'unit_price_agreed', e.target.value)} style={{ ...ui.input, width: 90, textAlign: 'right' }} aria-label="Agreed each" /></Td>
              <Td num>{moneyWords(lineAmount(l))}</Td>
              <Td right>{lines.length > 1 && <Btn small kind="link" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</Btn>}</Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
      <div style={{ marginTop: 8 }}><Btn small onClick={() => setLines((ls) => [...ls, blank()])}>Add a line</Btn></div>
      <Field label="Note" style={{ marginTop: 12 }}><input value={note} onChange={(e) => setNote(e.target.value)} style={ui.input} aria-label="Note" /></Field>
      <ErrorLine error={error} />
    </Modal>
  );
}
