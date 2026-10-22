// stock/suppliers/DeliveryExceptionsPanel.jsx: Exceptions and holidays (multi site stock Drop 3,
// v5.11.96, contract 3.2 and 4.2, map C17). The company calendar (bank holidays, Christmas week), this
// supplier's own holidays, and one site's closures: No delivery, or Deliver on another day. The
// Order pad, the order by reminders and the standing order runner all read them (nextDelivery).

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../../../store';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import { dayWords } from '../../../../lib/stock/purchasingRules';
import { Sheet, Btn, Field, Segmented, TableWrap, Th, Td, ErrorLine, EmptyLine, ui } from '../stockUi';

const KINDS = [{ value: 'no_delivery', label: 'No delivery' }, { value: 'deliver_instead', label: 'Deliver on another day' }];

export default function DeliveryExceptionsPanel({ orgId, supplier, onClose }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const editor = sc.canEditCompany('purchasing');
  const apply = useCallback((r) => {
    setError(r.error || null);
    setRows(r.error ? [] : (r.data || []).filter((x) => x.scope === 'company' || x.company_supplier_id === supplier?.id || (x.scope === 'site' && !x.company_supplier_id)));
  }, [supplier?.id]);
  const load = useCallback(() => stockApi.deliveryExceptions(orgId).then(apply), [orgId, apply]);
  useEffect(() => {
    let on = true;
    stockApi.deliveryExceptions(orgId).then((r) => { if (on) apply(r); });
    return () => { on = false; };
  }, [orgId, apply]);
  const startNew = () => setForm({ scope: 'supplier', name: '', from_day: '', to_day: '', kind: 'no_delivery', deliver_on: '', location_id: '' });
  const save = async () => {
    const f = form;
    if (!f.name.trim() || !f.from_day || !f.to_day) { setError(new Error('Give it a name and the days it covers.')); return; }
    if (f.to_day < f.from_day) { setError(new Error('The last day is before the first day.')); return; }
    if (f.kind === 'deliver_instead' && !f.deliver_on) { setError(new Error('Pick the day it is delivered instead.')); return; }
    if (f.scope === 'site' && !f.location_id) { setError(new Error('Pick the site.')); return; }
    setBusy(true); setError(null);
    const r = await stockApi.saveDeliveryException({
      ...(f.id ? { id: f.id } : {}), scope: f.scope, company_supplier_id: f.scope === 'supplier' ? supplier.id : null, location_id: f.scope === 'site' ? f.location_id : null,
      name: f.name.trim(), from_day: f.from_day, to_day: f.to_day, kind: f.kind, deliver_on: f.kind === 'deliver_instead' ? f.deliver_on : null,
    }, f.row_version ?? null);
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    showToast?.(`Saved ${f.name.trim()}.`, 'success');
    setForm(null); load();
  };
  const archive = async (x) => {
    const r = await stockApi.saveDeliveryException({ id: x.id, archived: true }, x.row_version ?? null);
    if (r.error) { showToast?.(r.error.message, 'error'); return; }
    load();
  };
  const scopeWords = (x) => (x.scope === 'company' ? 'Every supplier' : x.scope === 'supplier' ? (supplier?.name || 'This supplier') : sc.siteName(x.location_id) || 'A site');
  return (
    <Sheet title="Exceptions and holidays" sub="Company calendar: bank holidays, Christmas week, and the supplier's own holiday rules." onClose={onClose} width={720}
      footer={editor && !form ? <Btn kind="primary" onClick={startNew}>Add an exception</Btn> : null}>
      <ErrorLine error={error} />
      {rows === null ? <EmptyLine>Loading…</EmptyLine> : !rows.length ? <EmptyLine>No exceptions coming up.</EmptyLine> : (
        <TableWrap>
          <thead><tr><Th>Name</Th><Th>Who</Th><Th>Days</Th><Th>What happens</Th><Th> </Th></tr></thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.id}>
                <Td strong>{x.name}</Td>
                <Td>{scopeWords(x)}</Td>
                <Td>{x.from_day === x.to_day ? dayWords(x.from_day) : `${dayWords(x.from_day)} to ${dayWords(x.to_day)}`}</Td>
                <Td>{x.kind === 'no_delivery' ? 'No delivery' : `Delivered ${dayWords(x.deliver_on)} instead`}</Td>
                <Td right>{editor && <span style={{ display: 'inline-flex', gap: 6 }}><Btn small onClick={() => setForm({ ...x, deliver_on: x.deliver_on || '', location_id: x.location_id || '' })}>Change</Btn><Btn small kind="link" onClick={() => archive(x)}>Remove</Btn></span>}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      {form && (
        <div style={{ ...ui.card, padding: 14, borderRadius: 14, marginTop: 14 }}>
          <Field label="For">
            <Segmented small value={form.scope} onChange={(v) => setForm((f) => ({ ...f, scope: v }))} options={[{ value: 'company', label: 'Every supplier' }, { value: 'supplier', label: supplier?.name || 'This supplier' }, { value: 'site', label: 'One site' }]} />
          </Field>
          {form.scope === 'site' && (
            <Field label="Site">
              <select value={form.location_id} onChange={(e) => setForm((f) => ({ ...f, location_id: e.target.value }))} style={{ ...ui.input, width: 220 }} aria-label="Site">
                <option value="">Pick a site</option>
                {(sc.sites || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="Name"><input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Christmas Day" style={ui.input} aria-label="Name" /></Field>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Field label="From"><input type="date" value={form.from_day} onChange={(e) => setForm((f) => ({ ...f, from_day: e.target.value }))} style={{ ...ui.input, width: 160 }} aria-label="From" /></Field>
            <Field label="To"><input type="date" value={form.to_day} onChange={(e) => setForm((f) => ({ ...f, to_day: e.target.value }))} style={{ ...ui.input, width: 160 }} aria-label="To" /></Field>
          </div>
          <Field label="What happens"><Segmented small value={form.kind} onChange={(v) => setForm((f) => ({ ...f, kind: v }))} options={KINDS} /></Field>
          {form.kind === 'deliver_instead' && <Field label="Delivered on"><input type="date" value={form.deliver_on} onChange={(e) => setForm((f) => ({ ...f, deliver_on: e.target.value }))} style={{ ...ui.input, width: 160 }} aria-label="Delivered on" /></Field>}
          <div style={{ display: 'flex', gap: 8 }}>
            <Btn onClick={() => setForm(null)}>Cancel</Btn>
            <Btn kind="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Btn>
          </div>
        </div>
      )}
    </Sheet>
  );
}
