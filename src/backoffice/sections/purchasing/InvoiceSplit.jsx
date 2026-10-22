// purchasing/InvoiceSplit.jsx: split one supplier invoice across sites (multi site stock Drop 3,
// v5.11.96, contract 3.2, decision 13). By hand or by delivery (each line's site from the orders it
// paid for); the amounts must add up to the invoice total within a penny. Paperwork and Xero only:
// a split never moves stock or cost (each site received its own delivery).

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { moneyWords } from '../../../lib/stock/purchasingRules';
import { splitCheck } from '../../../lib/stock/purchasingWords';
import { Modal, Btn, TableWrap, Th, Td, ErrorLine, ui } from '../stock/stockUi';

export default function InvoiceSplit({ invoice, onDone, onClose }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const [rows, setRows] = useState([]);   // [{ location_id, amount, tax, basis, note }]
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let on = true;
    stockApi.invoiceSplits(invoice.id).then((r) => {
      if (!on) return;
      const got = r.error ? [] : (r.data || []);
      setRows(got.length ? got.map((x) => ({ location_id: x.location_id, amount: String(x.amount), tax: String(x.tax ?? 0), basis: x.basis || 'by_hand', po_id: x.po_id || null, note: x.note || '' }))
        : [{ location_id: invoice.location_id, amount: String(invoice.total ?? ''), tax: '0', basis: 'by_hand', po_id: null, note: '' }]);
      if (r.error && !r.needsUpdate) setError(r.error);
    });
    return () => { on = false; };
  }, [invoice.id, invoice.location_id, invoice.total]);
  const check = useMemo(() => splitCheck(rows, invoice.total), [rows, invoice.total]);
  const setRow = (i, k, v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const addSite = () => setRows((rs) => [...rs, { location_id: '', amount: '', tax: '0', basis: 'by_hand', po_id: null, note: '' }]);
  const evenly = () => {
    const n = rows.length || 1;
    const each = Math.floor((Number(invoice.total) || 0) * 100 / n) / 100;
    setRows((rs) => rs.map((r, i) => ({ ...r, amount: String(i === n - 1 ? Math.round(((Number(invoice.total) || 0) - each * (n - 1)) * 100) / 100 : each) })));
  };
  const save = async () => {
    if (!check.ok) { setError(new Error(check.words)); return; }
    if (rows.some((r) => !r.location_id)) { setError(new Error('Pick a site on every row.')); return; }
    setBusy(true); setError(null);
    const r = await stockApi.splitInvoice(invoice.id, rows.map((x) => ({ location_id: x.location_id, amount: Number(x.amount) || 0, tax: Number(x.tax) || 0, basis: x.basis, po_id: x.po_id, note: x.note || null })));
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    showToast?.('Split saved. Send to Xero posts one bill with a line per site.', 'success');
    onDone?.();
  };
  return (
    <Modal title="Split by site" sub={`Invoice ${invoice.invoice_number || ''} from ${invoice.supplier_name || 'the supplier'}: ${moneyWords(invoice.total)}`} onClose={onClose} width={680}
      footer={<>
        <span style={{ fontSize: 13, color: check.ok ? 'var(--t2)' : 'var(--red)' }}>{check.ok ? `Adds up to ${moneyWords(check.sum)}` : check.words}</span>
        <span style={{ marginLeft: 'auto' }} />
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" disabled={busy || !check.ok} onClick={save}>{busy ? 'Saving…' : 'Save split'}</Btn>
      </>}>
      <TableWrap>
        <thead><tr><Th>Site</Th><Th right>Amount (inc VAT)</Th><Th right>VAT</Th><Th>Note</Th><Th> </Th></tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <Td>
                <select value={r.location_id} onChange={(e) => setRow(i, 'location_id', e.target.value)} style={{ ...ui.input, width: 180 }} aria-label="Site">
                  <option value="">Pick a site</option>
                  {(sc.sites || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </Td>
              <Td right><input inputMode="decimal" value={r.amount} onChange={(e) => setRow(i, 'amount', e.target.value)} style={{ ...ui.input, width: 100, textAlign: 'right' }} aria-label="Amount" /></Td>
              <Td right><input inputMode="decimal" value={r.tax} onChange={(e) => setRow(i, 'tax', e.target.value)} style={{ ...ui.input, width: 80, textAlign: 'right' }} aria-label="VAT" /></Td>
              <Td><input value={r.note} onChange={(e) => setRow(i, 'note', e.target.value)} style={ui.input} aria-label="Note" /></Td>
              <Td right>{rows.length > 1 && <Btn small kind="link" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>Remove</Btn>}</Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <Btn small onClick={addSite}>Add a site</Btn>
        <Btn small onClick={evenly}>Split evenly</Btn>
      </div>
      <ErrorLine error={error} />
    </Modal>
  );
}
