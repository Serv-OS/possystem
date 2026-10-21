/**
 * Change prices (multi site stock Drop 1): up or down by %, by an amount, or set a price; from
 * today or from a date; the company price (every site that follows it) or chosen sites (the price
 * here at each). The database works out every price first and the screen shows Before and After,
 * with how many recipes use each item, then Apply saves it (stock_change_prices: preview, then
 * apply). A dated change waits and applies on that day at each site.
 *
 * target: { itemIds } | { supplierItemIds } | { supplierId } | { categoryId }. Used by the Stock
 * items bulk bar and by a supplier's Items tab (section 'purchasing').
 *
 * The GP effect of a change needs the recipe cost read of Drop 2 (contract decision 9): until then
 * the screen says how many recipes use each item.
 */

import { useState } from 'react';
import { useStore } from '../../../../store';
import { money } from '../../../../lib/currency';
import { stockApi } from '../../../../lib/stock/stockApi';
import { dayWords } from '../../../../lib/stock/pauseRules';
import { PRICE_HOW, dateBoxWords, priceSpec } from '../../../../lib/stock/itemListRules';
import { Btn, Modal, Segmented, SiteChecklist, Field, Notice, TableWrap, Th, Td, ui } from '../stockUi';

// Props (contract 3.2): { target, sites, orgId, onDone, onClose } plus section. orgId is accepted
// and not needed: the database takes the company from the records the target names.
export default function ChangePricesModal({ target, sites, onDone, onClose, section = 'inventory' }) {
  const showToast = useStore((s) => s.showToast);
  const [how, setHow] = useState('percent');
  const [value, setValue] = useState('');
  const [when, setWhen] = useState('today');
  const [fromDay, setFromDay] = useState('');
  const [which, setWhich] = useState('company');
  const [chosen, setChosen] = useState([]);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Any change to the boxes throws the preview away: Apply only ever saves what was shown.
  const edit = (fn) => (v) => { fn(v); setPreview(null); setError(''); };
  const build = () => priceSpec({ target, how, value, fromDay: when === 'date' ? fromDay : '', sites: which === 'sites' ? chosen : null });

  const show = async () => {
    const { spec, error: bad } = build();
    if (bad) { setError(bad); return; }
    if (when === 'date' && !fromDay) { setError('Pick the day the new prices start.'); return; }
    setBusy(true); setError('');
    const r = await stockApi.changePrices(spec, { preview: true, section });
    setBusy(false);
    if (r.error) { setError(r.error.message); return; }
    setPreview({ spec, data: r.data || {} });
  };

  const apply = async () => {
    if (!preview) return;
    setBusy(true); setError('');
    const r = await stockApi.changePrices(preview.spec, { preview: false, section });
    setBusy(false);
    if (r.error) { setError(r.error.message); return; }
    const d = r.data || {};
    const words = Number(d.dated || 0) > 0
      ? `${d.dated} ${Number(d.dated) === 1 ? 'price changes' : 'prices change'} from ${d.from_day ? dayWords(d.from_day) : 'today'}.`
      : `${Number(d.changed || 0)} ${Number(d.changed) === 1 ? 'price' : 'prices'} changed.`;
    try { showToast?.(words, 'success'); } catch { /* no toast, no harm */ }
    onDone?.(r);
  };

  const rows = preview?.data?.rows || [];
  const siteName = (id) => (id ? (sites || []).find((s) => s.id === id)?.name || 'A site' : 'Company');
  const valueLabel = how === 'percent' ? 'Percent (minus for down)' : how === 'amount' ? 'Amount (minus for down)' : 'New price';

  return (
    <Modal title="Change prices" onClose={onClose} width={820} dirty={!!value && !busy}
      footer={<>
        <span style={{ flex: 1 }} />
        <Btn onClick={onClose}>Cancel</Btn>
        {!preview && <Btn kind="primary" disabled={busy || value === ''} onClick={show}>{busy ? 'Working it out…' : 'Show the change'}</Btn>}
        {preview && <Btn kind="primary" disabled={busy || !rows.length} onClick={apply}>{busy ? 'Saving…' : 'Apply'}</Btn>}
      </>}>
      <div style={{ display: 'grid', gap: 12 }}>
        <Segmented value={how} onChange={edit(setHow)} options={PRICE_HOW.map((h) => ({ value: h.value, label: h.label }))} />
        <Field label={valueLabel} style={{ marginBottom: 0 }}>
          <input type="number" step="any" value={value} onChange={(e) => edit(setValue)(e.target.value)} aria-label={valueLabel} style={{ ...ui.input, width: 160 }} />
        </Field>
        <div style={{ ...ui.row, flexWrap: 'wrap', gap: 10 }}>
          <Segmented value={when} onChange={edit(setWhen)} options={[{ value: 'today', label: 'From today' }, { value: 'date', label: 'From a date' }]} />
          {when === 'date' && (
            <>
              <input type="date" value={fromDay} onChange={(e) => edit(setFromDay)(e.target.value)} aria-label="From a date"
                style={{ ...ui.input, width: 170, ...(fromDay ? { border: '1px solid var(--acc)' } : {}) }} />
              {/* Safari draws today in grey in an empty date box: the words say whether a day is set. */}
              <span style={{ fontSize: 12, color: fromDay ? 'var(--t1)' : 'var(--t3)', fontWeight: fromDay ? 700 : 400 }}>
                {dateBoxWords(fromDay, { set: 'From', empty: 'No day picked yet.' })}
              </span>
            </>
          )}
        </div>
        <Segmented value={which} onChange={edit(setWhich)} options={[{ value: 'company', label: 'The company price (every site that follows it)' }, { value: 'sites', label: 'Chosen sites' }]} />
        {which === 'sites' && <SiteChecklist sites={sites || []} value={chosen} onChange={edit(setChosen)} />}
      </div>

      {error && <div style={{ ...ui.err, marginTop: 12 }}>{error}</div>}

      {preview && (
        <div style={{ marginTop: 14 }}>
          <Notice tone="info">{preview.data.words || `${preview.data.total ?? rows.length} prices change from ${preview.data.from_day ? dayWords(preview.data.from_day) : 'today'}`}</Notice>
          {rows.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <TableWrap minWidth={720}>
                <thead>
                  <tr><Th>Item</Th><Th>Supplier</Th><Th>Where</Th><Th right>Before</Th><Th right>After</Th><Th right>Used in</Th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.supplier_item_id}|${r.location_id || ''}`}>
                      <Td strong>{r.item_name}</Td>
                      <Td>{r.supplier_name}</Td>
                      <Td>{siteName(r.location_id)}</Td>
                      <Td right num grey>{money(r.before, r.currency)}</Td>
                      <Td right num strong>{money(r.after, r.currency)}</Td>
                      <Td right num>{Number(r.used_in || 0) === 1 ? '1 recipe' : `${Number(r.used_in || 0)} recipes`}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </div>
          )}
          {Number(preview.data.total || 0) > rows.length && <div style={{ ...ui.sub, marginTop: 6 }}>Showing the first {rows.length} of {preview.data.total}. Apply changes all of them.</div>}
          {!rows.length && <div style={{ ...ui.sub, marginTop: 8 }}>Nothing to change: no price matches.</div>}
        </div>
      )}
    </Modal>
  );
}
