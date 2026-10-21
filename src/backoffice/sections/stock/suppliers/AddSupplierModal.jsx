/**
 * AddSupplierModal: + Add supplier (company editors) or + Add a local supplier (everyone else) in
 * a multi site company (mockup scrSuppliers, Drop 1 contract 3.4 and 4.3).
 *
 * A company supplier: name, contact, order email, phone, payment terms and the sites that can
 * order, pre ticked from the picker; one stock_save_supplier call with the ticked sites. A local
 * supplier belongs to one site (presetSites[0]): the same call with no sites, so the database makes
 * it local to that site, where its manager can edit it freely (decision 3).
 */

import { useMemo, useState } from 'react';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import { detailsPayload, detailsDraft } from '../../../../lib/stock/supplierListRules';
import { Btn, Modal, Field, SiteChecklist, ui, ErrorLine } from '../stockUi';

export default function AddSupplierModal({ local = false, presetSites = [], onSaved, onClose }) {
  const sc = useStockScope();
  const [form, setForm] = useState(() => detailsDraft(null));
  const [ticked, setTicked] = useState(() => (local ? [] : [...(presetSites || [])]));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const localSite = local ? (presetSites || [])[0] || null : null;
  const groups = useMemo(() => (sc.groups || []).map((g) => ({ id: g.id, name: g.name, location_ids: g.locationIds || g.location_ids || [] })), [sc.groups]);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const dirty = !!(form.name || form.email || form.phone || form.contact_name || form.payment_terms_days);

  const save = async () => {
    const checked = detailsPayload(form);
    if (!checked.ok) { setError(new Error(checked.error)); return; }
    if (local && !localSite) { setError(new Error('Pick the site this supplier is for.')); return; }
    // with no site ticked the database would make it a local supplier of one site, not a company one
    if (!local && !ticked.length) { setError(new Error('Tick at least one site that can order from it.')); return; }
    const s = checked.supplier;
    const supplier = {
      location_id: local ? localSite : ticked[0],
      name: s.name, contact_name: s.contact_name, email: s.email, phone: s.phone, payment_terms_days: s.payment_terms_days,
    };
    const sites = local ? null : ticked.map((id) => ({ location_id: id, on: true }));
    setBusy(true); setError(null);
    const r = await stockApi.saveSupplier({ supplier, sites, version: null, section: 'purchasing' });
    setBusy(false);
    if (r.error) { setError(r.error); return; }
    onSaved?.(r.data?.id || null, s.name);
  };

  const title = local ? `Add a local supplier (${sc.siteName(localSite) || 'one site'} only)` : 'Add supplier';
  return (
    <Modal title={title} onClose={onClose} width={560} dirty={dirty}
      footer={<>
        <div style={{ flex: 1 }}>{error && <ErrorLine error={error} />}</div>
        <Btn onClick={onClose}>Cancel</Btn>
        <Btn kind="primary" onClick={save} disabled={busy || !form.name.trim()}>{busy ? 'Saving…' : 'Save'}</Btn>
      </>}>
      <Field label="Name"><input value={form.name} onChange={set('name')} style={ui.input} autoFocus /></Field>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', columnGap: 14 }}>
        <Field label="Contact"><input value={form.contact_name} onChange={set('contact_name')} style={ui.input} /></Field>
        <Field label="Order email"><input value={form.email} onChange={set('email')} style={ui.input} placeholder="orders@example.com" inputMode="email" /></Field>
        <Field label="Phone"><input value={form.phone} onChange={set('phone')} style={ui.input} inputMode="tel" /></Field>
        <Field label="Payment terms (days)"><input value={form.payment_terms_days} onChange={set('payment_terms_days')} style={ui.input} inputMode="numeric" /></Field>
      </div>
      {!local && (
        <Field label="Can order" hint="Pre ticked from the picker. Each site adds its own account number on the Sites tab.">
          <SiteChecklist sites={sc.sites || []} value={ticked} onChange={setTicked} groups={groups} />
        </Field>
      )}
      {local && (
        <div style={{ ...ui.sub }}>Only {sc.siteName(localSite) || 'this site'} can order from it. Head office can make it a company supplier later.</div>
      )}
    </Modal>
  );
}
