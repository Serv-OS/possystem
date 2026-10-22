// purchasing/CreditNoteModal.jsx: add the supplier's credit note to a request (multi site stock Drop 3,
// v5.11.96, contract 3.2 and 4.2): number, date, amount and VAT, typed or read from a scan; when the
// request's amount is covered it becomes Received. A credit note never changes stock value.

import { useState } from 'react';
import { useStore } from '../../../store';
import { stockApi } from '../../../lib/stock/stockApi';
import { scanInvoice } from '../../../lib/stock/purchasing';
import { moneyWords } from '../../../lib/stock/purchasingRules';
import { Modal, Btn, Field, ErrorLine, ui } from '../stock/stockUi';

const toB64 = (file) => new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1] || ''); r.onerror = reject; r.readAsDataURL(file); });

export default function CreditNoteModal({ request, onDone, onClose }) {
  const showToast = useStore((s) => s.showToast);
  const [number, setNumber] = useState('');
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState(request?.amount != null ? String(request.amount) : '');
  const [tax, setTax] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const scan = async (file) => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const { data, error: e } = await scanInvoice(await toB64(file), file.type || 'image/jpeg', request.location_id);
      if (e) throw e;
      if (data?.invoice_number) setNumber(String(data.invoice_number));
      if (data?.invoice_date) setDay(String(data.invoice_date).slice(0, 10));
      if (data?.total != null) setAmount(String(Math.abs(Number(data.total))));
      if (data?.tax != null) setTax(String(Math.abs(Number(data.tax))));
    } catch (e) { setError(e); }
    setBusy(false);
  };
  const save = async () => {
    const a = Number(amount);
    if (!(a >= 0) || amount === '') { setError(new Error('Type the amount of the credit note.')); return; }
    setBusy(true); setError(null);
    const r = await stockApi.saveCreditNote({ location_id: request.location_id, supplier_id: request.supplier_id || null, request_id: request.id, number: number.trim() || null, note_date: day, amount: a, tax: Number(tax) || 0, image_path: null });
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    showToast?.('Credit note added.', 'success');
    onDone?.();
  };
  return (
    <Modal title="Add credit note" sub={`For the request of ${moneyWords(request?.amount)}`} onClose={onClose} width={520}
      footer={<><Btn onClick={onClose}>Cancel</Btn><span style={{ marginLeft: 'auto' }} /><Btn kind="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Btn></>}>
      <Field label="Scan the credit note" hint="Or type it below.">
        <input type="file" accept="image/*,application/pdf" onChange={(e) => scan(e.target.files?.[0])} aria-label="Scan the credit note" />
      </Field>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <Field label="Number"><input value={number} onChange={(e) => setNumber(e.target.value)} style={{ ...ui.input, width: 160 }} aria-label="Number" /></Field>
        <Field label="Date"><input type="date" value={day} onChange={(e) => setDay(e.target.value)} style={{ ...ui.input, width: 160 }} aria-label="Date" /></Field>
        <Field label="Amount"><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ ...ui.input, width: 120 }} aria-label="Amount" /></Field>
        <Field label="VAT"><input inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} style={{ ...ui.input, width: 100 }} aria-label="VAT" /></Field>
      </div>
      <ErrorLine error={error} />
    </Modal>
  );
}
