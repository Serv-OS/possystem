// src/backoffice/sections/stock/items/UnitsTab.jsx
//
// MULTI SITE STOCK Drop 1: today's Units tab (pack of packs: Keg, Case, Bottle, 175ml glass) from
// src/backoffice/sections/StockItems.jsx on main, copied for the company item page with the same
// look and words. What changed:
//   - it reads the COMPANY packs of the item detail read (stock_item_detail), not a site's rows;
//   - every save is a company save through stockApi (stock_save_pack, stock_archive_pack,
//     stock_set_pack_default) in the company form: { id, item_id, location_id: homeSiteId } with
//     the company pack's row_version. The server writes every site's pack row, so every site counts
//     in the same packs. data.js is never used here (its versions are one site's row versions);
//   - `locked` (a login that cannot change company records) greys every box and button, never
//     hides them (the database would refuse them anyway);
//   - no em or en dash in the words (house rule).
// A pack a recipe uses cannot be removed: the database says so ("used in a recipe") and the words
// are shown as they come.

import { useState } from 'react';
import { useStore } from '../../../../store';
import { stockApi } from '../../../../lib/stock/stockApi';
import { reportSave } from '../../../../lib/saveHealth';
import { queuedNote, packsOf } from '../../../../lib/stock/itemPageRules';

const fieldStyle = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };
const badge = () => ({ fontSize: 10, fontWeight: 700, color: 'var(--acc)', padding: '3px 7px', borderRadius: 20, background: 'var(--acc-d, rgba(249,115,22,0.12))' });
const ghostBtn = { fontSize: 10, padding: '3px 7px', borderRadius: 6, background: 'var(--bg2)', border: '1px solid var(--bdr)', color: 'var(--t3)', cursor: 'pointer' };
const offLook = (locked) => (locked ? { opacity: 0.55, cursor: 'not-allowed' } : null);

export default function UnitsTab({ detail, homeSiteId, locked = false, reload }) {
  const showToast = useStore(s => s.showToast);
  const itemId = detail?.item?.id || null;
  const baseUnit = detail?.item?.base_unit || 'each';
  const [row, setRow] = useState({ name: '', qty: '', of: baseUnit });
  const [adding, setAdding] = useState(false);
  const formats = packsOf(detail);
  const ofOptions = [{ value: baseUnit, label: baseUnit, qtyInBase: 1 }, ...formats.map(f => ({ value: String(f.id), label: f.name, qtyInBase: f.qtyInBase }))];
  const previewBase = (() => { const o = ofOptions.find(o => String(o.value) === String(row.of)); return (Number(row.qty) || 0) * (o?.qtyInBase || 0); })();
  const versionOf = (id) => formats.find(f => f.id === id)?.rowVersion ?? null;

  const add = async () => {
    if (locked) return;
    if (!row.name.trim()) { showToast?.('Give the unit a name (e.g. Keg)', 'error'); return; }
    if (!(Number(row.qty) > 0)) { showToast?.('Enter a size (e.g. 50)', 'error'); return; }
    const o = ofOptions.find(x => String(x.value) === String(row.of));
    const qtyInBase = Number(row.qty) * (o?.qtyInBase || 0);
    if (!(qtyInBase > 0)) { showToast?.('Invalid size', 'error'); return; }
    const parentId = (o && String(o.value) !== String(baseUnit)) ? o.value : null;
    const isFirst = formats.length === 0;
    setAdding(true);
    const r = await stockApi.savePack({
      item_id: itemId, location_id: homeSiteId, name: row.name.trim(), qty_in_base: qtyInBase,
      parent_pack_id: parentId, is_count_default: isFirst, is_purchase_default: isFirst,
    }, null);
    setAdding(false);
    reportSave('packaging unit', r.error);
    if (r.error) { showToast?.('Could not add unit: ' + (r.error.message || r.error), 'error'); if (r.conflict) reload?.(); return; }
    const note = queuedNote(r.queued);
    showToast?.(`Unit added: ${row.name.trim()}${note ? `. ${note}` : ''}`, 'success');
    setRow({ name: '', qty: '', of: baseUnit });
    reload?.();
  };
  const remove = async (id) => {
    if (locked) return;
    const r = await stockApi.archivePack(id, versionOf(id), true);
    reportSave('packaging unit delete', r.error);
    // a pack a recipe uses cannot be removed (20261019b): say why, in the database's words
    if (r.error) {
      const msg = r.error.message || '';
      showToast?.(/used in a recipe/i.test(msg) ? msg : (msg ? `Unit NOT removed: ${msg}` : 'Unit NOT removed'), 'error');
      if (r.conflict) reload?.();
      return;
    }
    reload?.();
  };
  const makeDefault = async (id, kind) => {
    if (locked) return;
    const r = await stockApi.setPackDefault(id, kind, versionOf(id));
    reportSave('default unit', r.error);
    // The buy default decides the quantities and prices that go onto purchase orders, so a badge
    // that moved without the row moving would misprice every future order.
    if (r.error) { showToast?.(`Could not set the ${kind === 'purchase' ? 'buy' : 'count'} unit: ${r.error.message}`, 'error'); if (r.conflict) reload?.(); return; }
    reload?.();
  };

  const sizeLabel = (p) => {
    if (p.parentFormatId) {
      const parent = formats.find(f => String(f.id) === String(p.parentFormatId));
      if (parent && parent.qtyInBase > 0) return `${Math.round((p.qtyInBase / parent.qtyInBase) * 1000) / 1000} × ${parent.name}  (${p.qtyInBase} ${baseUnit})`;
    }
    return `${p.qtyInBase} ${baseUnit}`;
  };

  return (
    <div style={{ maxWidth: 680 }}>
      <p style={{ fontSize: 13, color: 'var(--t2)', marginTop: 0 }}>
        Define the units your staff actually use: <b>Keg</b>, <b>Case</b>, <b>Bottle</b>, <b>175ml glass</b>. You then
        <b> buy, count and sell</b> in these; the maths happens in the background in {baseUnit} (which staff never see).
        A unit can be made of another (e.g. <b>Case = 6 × Bottle</b>).
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {formats.length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No units yet: add one below (e.g. Keg = 50 l).</div>}
        {formats.map(p => (
          <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '9px 14px' }}>
            <span style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 600, minWidth: 90 }}>1 {p.name}</span>
            <span style={{ fontSize: 12, color: 'var(--t3)' }}>= {sizeLabel(p)}</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
              {p.isCountDefault ? <span style={badge('count')}>📋 count</span> : <button disabled={locked} onClick={() => makeDefault(p.id, 'count')} style={{ ...ghostBtn, ...offLook(locked) }}>set count</button>}
              {p.isPurchaseDefault ? <span style={badge('buy')}>🛒 buy</span> : <button disabled={locked} onClick={() => makeDefault(p.id, 'purchase')} style={{ ...ghostBtn, ...offLook(locked) }}>set buy</button>}
              <button disabled={locked} aria-label={`Remove ${p.name}`} onClick={() => remove(p.id)} style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 16, ...offLook(locked) }}>×</button>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap', background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 10, padding: 14, ...(locked ? { opacity: 0.55 } : null) }}>
        <span style={{ fontSize: 13, color: 'var(--t3)', paddingBottom: 8 }}>1</span>
        <input disabled={locked} value={row.name} onChange={e => setRow(r => ({ ...r, name: e.target.value }))} placeholder="Keg / Case / Bottle / 175ml glass" style={{ ...fieldStyle, width: 200 }} />
        <span style={{ fontSize: 13, color: 'var(--t3)', paddingBottom: 8 }}>=</span>
        <input disabled={locked} type="number" min="0" step="any" value={row.qty} onChange={e => setRow(r => ({ ...r, qty: e.target.value }))} placeholder="50" style={{ ...fieldStyle, width: 80 }} />
        <select disabled={locked} value={row.of} onChange={e => setRow(r => ({ ...r, of: e.target.value }))} style={{ ...fieldStyle, width: 150 }}>
          {ofOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button onClick={add} disabled={adding || locked} style={{ padding: '8px 16px', borderRadius: 7, background: 'var(--acc)', color: '#fff', border: 0, cursor: locked ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, opacity: adding ? 0.6 : 1 }}>{adding ? 'Adding…' : 'Add unit'}</button>
        {previewBase > 0 && <div style={{ fontSize: 11, color: 'var(--t4)', width: '100%', marginTop: 4 }}>= {previewBase} {baseUnit}</div>}
      </div>
    </div>
  );
}
