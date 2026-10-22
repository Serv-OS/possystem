/**
 * SupplierDetailsTab: the company fields of one supplier (mockup scrSupplier Details, Drop 1
 * contract 3.4 and 4.3): today's form fields plus Accept price changes, Minimum order, Maximum
 * order, Delivery fee and How orders reach them. One stock_save_supplier call with the company
 * row_version. Delivery days and the cut off are on the Order rules tab, and the account number is
 * each site's own (Sites tab).
 *
 * Someone saved first: SavedFirstModal shows each field the other person changed that this screen
 * says otherwise; "Save mine on top" saves this screen on their version (the table says what goes
 * back to "Yours", and both changes are in the log). When nothing of theirs clashes, the screen
 * simply saves again on their version.
 * Not an editor: the fields are greyed under the lock line, never hidden.
 */

import { useMemo, useState } from 'react';
import { useStore } from '../../../../store';
import { useStockScope } from '../../../StockScope';
import { stockApi } from '../../../../lib/stock/stockApi';
import { DETAILS_FIELDS, ORDER_METHODS, detailsDraft, detailsPayload, onTopPlan, savedWords } from '../../../../lib/stock/supplierListRules';
import { Btn, Field, ui, ErrorLine, useConfirm } from '../stockUi';
import LockLine from '../LockLine';
import SavedFirstModal from '../SavedFirstModal';

const labelOf = (key) => DETAILS_FIELDS.find((f) => f.key === key)?.label || key;

export default function SupplierDetailsTab({ detail, editable, reload, onArchived = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const s = detail?.supplier || {};
  // SupplierPage remounts this tab on a new row_version, so the form always starts from the row read
  const [loaded] = useState(s);
  const [form, setForm] = useState(() => detailsDraft(s));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [clash, setClash] = useState(null); // { byName, at, rows, patch, version }
  const [confirm, confirmDialog] = useConfirm();
  const version = detail?.row_version ?? s.row_version ?? null;
  const currency = (sc.sites || []).find((x) => (detail?.sites || []).some((d) => d.location_id === x.id))?.currency || (sc.sites || [])[0]?.currency || 'GBP';
  // The site the save is named at: its own site for a local supplier, else a site in reach that has
  // its row. None known: the database picks a site of this login that has one.
  const placeOf = s.local_location_id || (detail?.sites || []).find((d) => d && d.site_supplier_id)?.location_id || null;
  const where = placeOf ? { location_id: placeOf } : {};

  const dirty = useMemo(() => JSON.stringify(detailsDraft(loaded)) !== JSON.stringify(form), [loaded, form]);
  const set = (k) => (e) => { const v = e?.target ? e.target.value : e; setForm((f) => ({ ...f, [k]: v })); };

  const send = async (supplier, v) => {
    setBusy(true); setError(null);
    const r = await stockApi.saveSupplier({ supplier: { id: s.id, ...where, ...supplier }, sites: null, version: v, section: 'purchasing' });
    setBusy(false);
    return r;
  };

  const save = async () => {
    const checked = detailsPayload(form);
    if (!checked.ok) { setError(new Error(checked.error)); return; }
    const r = await send(checked.supplier, version);
    if (r.conflict) {
      const fresh = await stockApi.supplierDetail(s.id);
      const theirs = fresh.data?.supplier || null;
      if (!theirs) { setError(r.error); return; }
      const plan = onTopPlan(loaded, checked.supplier, theirs, currency);
      const freshVersion = fresh.data?.row_version ?? theirs.row_version ?? null;
      if (!plan.rows.length) {
        // nothing of theirs clashes with this screen: save it again on their version, no question
        const again = await send(plan.patch, freshVersion);
        if (again.error) { setError(again.error); return; }
        showToast?.(savedWords(again.queued), 'success');
        await reload();
        return;
      }
      setClash({ byName: r.conflict.by_name || 'Someone', at: r.conflict.at || null, rows: plan.rows, patch: plan.patch, version: freshVersion });
      return;
    }
    if (r.error) { setError(r.error); return; }
    showToast?.(savedWords(r.queued), 'success');
    await reload();
  };

  // v5.11.96 (multi site stock Drop 3): "No delivery fee over the minimum" saves on its own, at once
  // (fee_waived_over_min), with the version this tab read.
  const saveWaiver = async (on) => {
    const r = await send({ fee_waived_over_min: on === true }, version);
    if (r.error) { setError(r.error); return; }
    showToast?.(on ? 'No delivery fee over the minimum.' : 'The delivery fee is charged on every order.', 'success');
    await reload();
  };

  // SavedFirstModal says "Saved on top of <First>'s version..." itself, and only when this answers
  // with no error: a refused save never gets a toast.
  const saveOnTop = async () => {
    if (!clash) return false;
    const r = await send(clash.patch, clash.version);
    setClash(null);
    // refused: the form keeps what was typed and says why (no reload, which would wipe it)
    if (r.error) { setError(r.error); return { error: r.error }; }
    await reload();
    return true;
  };

  const keepTheirs = async () => { setClash(null); await reload(); };

  const archive = async () => {
    const yes = await confirm({
      title: `Archive ${s.name}?`,
      words: 'No site can order from it after this. Its orders, invoices and price history are kept.',
      yes: 'Archive', no: 'Go back', danger: true,
    });
    if (!yes) return;
    setBusy(true);
    const r = await stockApi.archiveSupplier(s.id, version, true);
    setBusy(false);
    if (r.error) { showToast?.(r.error.message, 'error'); await reload(); return; }
    showToast?.(`${s.name} archived.`, 'info');
    if (onArchived) onArchived(); else await reload();
  };

  const restore = async () => {
    setBusy(true);
    const r = await stockApi.archiveSupplier(s.id, version, false);
    setBusy(false);
    if (r.error) { showToast?.(r.error.message, 'error'); return; }
    showToast?.(`${s.name} is back.`, 'success');
    await reload();
  };

  const locked = !editable;
  const box = { ...ui.input, ...(locked ? { opacity: 0.55 } : null) };
  const text = (key, extra = {}) => (
    <Field label={labelOf(key)}>
      <input value={form[key]} onChange={set(key)} disabled={locked || busy} style={box} {...extra} />
    </Field>
  );

  return (
    <div>
      {confirmDialog}
      {locked && <div style={{ marginBottom: 12 }}><LockLine entity="supplier" id={s.id} recordName={s.name} kind="company" /></div>}
      <div style={{ ...ui.card, maxWidth: 760 }}>
        {text('name')}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', columnGap: 14 }}>
          {text('email', { placeholder: 'orders@example.com', inputMode: 'email' })}
          {text('phone', { inputMode: 'tel' })}
          {text('contact_name')}
          {text('payment_terms_days', { inputMode: 'numeric' })}
          {text('min_order_value', { inputMode: 'decimal' })}
          {text('max_order_value', { inputMode: 'decimal' })}
          {text('delivery_fee', { inputMode: 'decimal' })}
        </div>
        <label style={{ ...ui.row, fontSize: 13, marginBottom: 12, cursor: locked ? 'default' : 'pointer', opacity: locked ? 0.55 : 1 }}>
          <input type="checkbox" checked={s.fee_waived_over_min === true} disabled={locked || busy} onChange={(e) => saveWaiver(e.target.checked)} />
          <span>No delivery fee over the minimum</span>
        </label>
        <Field label={labelOf('order_method')}>
          <div style={{ display: 'grid', gap: 6 }}>
            {ORDER_METHODS.map((m) => (
              <label key={m.value} style={{ ...ui.row, fontSize: 13, cursor: locked ? 'default' : 'pointer', opacity: locked ? 0.55 : 1 }}>
                <input type="radio" name={`order-method-${s.id}`} checked={form.order_method === m.value} disabled={locked || busy}
                  onChange={() => setForm((f) => ({ ...f, order_method: m.value }))} />
                <span>{m.label}</span>
              </label>
            ))}
          </div>
        </Field>
        <Field label={labelOf('notes')}>
          <textarea value={form.notes} onChange={set('notes')} disabled={locked || busy} style={{ ...box, minHeight: 56, resize: 'vertical' }} />
        </Field>
        <label style={{ ...ui.row, fontSize: 13, cursor: locked ? 'default' : 'pointer', opacity: locked ? 0.55 : 1 }}>
          <input type="checkbox" checked={form.accepts_price_changes} disabled={locked || busy}
            onChange={(e) => setForm((f) => ({ ...f, accepts_price_changes: e.target.checked }))} />
          <span>Accept price changes from this supplier</span>
        </label>
        <div style={{ ...ui.sub, marginTop: 6 }}>Unticked means agreed prices: each item carries an Agreed until date and an Allowed difference %.</div>

        {error && <div style={{ marginTop: 12 }}><ErrorLine error={error} /></div>}
        {!locked && (
          <div style={{ ...ui.row, marginTop: 18, flexWrap: 'wrap' }}>
            <Btn kind="primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</Btn>
            {dirty && <Btn onClick={() => { setForm(detailsDraft(loaded)); setError(null); }} disabled={busy}>Cancel</Btn>}
            <span style={{ flex: 1 }} />
            {s.archived_at
              ? <Btn onClick={restore} disabled={busy}>Bring it back</Btn>
              : <Btn kind="danger" onClick={archive} disabled={busy}>Archive</Btn>}
          </div>
        )}
      </div>

      {clash && (
        <SavedFirstModal byName={clash.byName} at={clash.at} rows={clash.rows} busy={busy}
          onKeepTheirs={keepTheirs} onSaveMine={saveOnTop} onClose={() => setClash(null)} />
      )}
    </div>
  );
}
