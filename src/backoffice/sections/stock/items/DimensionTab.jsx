// src/backoffice/sections/stock/items/DimensionTab.jsx
//
// MULTI SITE STOCK Drop 1: today's Dimension and Measure tab (unit bridges, for example
// 1 each = 110 g) from src/backoffice/sections/StockItems.jsx on main, copied for the company item
// page with the same look and words. What changed:
//   - it reads the COMPANY bridges of the item detail read (stock_item_detail);
//   - every save is a company save through stockApi (stock_save_bridge, stock_archive_bridge) in
//     the company form { id, item_id, location_id: homeSiteId } with the company bridge's
//     row_version. The server writes every site's bridge row and recomputes each site's cost;
//   - `locked` greys every box and button, never hides them;
//   - no em or en dash in the words (house rule).

import { useState } from 'react';
import { useStore } from '../../../../store';
import { stockApi } from '../../../../lib/stock/stockApi';
import { reportSave } from '../../../../lib/saveHealth';
import { UNITS, DIMENSIONS } from '../../../../lib/stock/units';
import { bridgesOf, queuedNote } from '../../../../lib/stock/itemPageRules';

const UNIT_OPTS = Object.entries(UNITS).map(([code, u]) => ({ code, ...u }));
const DIM_ORDER = [DIMENSIONS.COUNT, DIMENSIONS.WEIGHT, DIMENSIONS.VOLUME];
const fieldStyle = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box' };

function UnitSelect({ value, onChange, style, disabled }) {
  return (
    <select value={value || ''} disabled={disabled} onChange={e => onChange(e.target.value)}
      style={{ background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 6, padding: '7px 8px', fontSize: 13, ...style }}>
      {DIM_ORDER.map(dim => (
        <optgroup key={dim} label={dim[0] + dim.slice(1).toLowerCase()}>
          {UNIT_OPTS.filter(u => u.dimension === dim).map(u => (
            <option key={u.code} value={u.code}>{u.label} ({u.code})</option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export default function DimensionTab({ detail, homeSiteId, locked = false, reload }) {
  const showToast = useStore(s => s.showToast);
  const itemId = detail?.item?.id || null;
  const baseUnit = detail?.item?.base_unit || 'each';
  const [row, setRow] = useState({ fromQty: 1, fromUnit: baseUnit, toQty: '', toUnit: 'g' });
  const [busy, setBusy] = useState(false);
  const bridges = bridgesOf(detail);
  const dim = UNITS[baseUnit]?.dimension;

  const add = async () => {
    if (locked) return;
    if (!(Number(row.fromQty) > 0) || !(Number(row.toQty) > 0)) { showToast?.('Enter both quantities', 'error'); return; }
    setBusy(true);
    const r = await stockApi.saveBridge({
      item_id: itemId, location_id: homeSiteId,
      from_qty: Number(row.fromQty), from_unit: row.fromUnit, to_qty: Number(row.toQty), to_unit: row.toUnit,
    }, null);
    setBusy(false);
    reportSave('unit conversion', r.error);
    if (r.error) { showToast?.(r.error.message, 'error'); if (r.conflict) reload?.(); return; }
    // `partial` means the bridge saved but a site's cost recompute did not. Clear the form and
    // reload anyway: treating it as a failure would leave people saving a row that already exists.
    const partial = r.data?.partial || null;
    const note = queuedNote(r.queued);
    if (partial) showToast?.(partial, 'warning');
    else if (note) showToast?.(`Saved. ${note}`, 'success');
    setRow({ fromQty: 1, fromUnit: baseUnit, toQty: '', toUnit: 'g' });
    reload?.();
  };
  const remove = async (b) => {
    if (locked) return;
    const r = await stockApi.archiveBridge(b.id, b.rowVersion, true);
    reportSave('unit conversion delete', r.error);
    if (r.error) { showToast?.(`Bridge NOT removed: ${r.error.message || 'recipe conversions still use it'}`, 'error'); if (r.conflict) reload?.(); return; }
    reload?.();
  };

  return (
    <div style={{ maxWidth: 680 }}>
      <p style={{ fontSize: 13, color: 'var(--t2)', marginTop: 0 }}>
        Base unit is <b>{baseUnit}</b> ({dim?.toLowerCase()}). Add a bridge whenever you buy or recipe in a
        <i> different dimension</i>: e.g. buy onions by the each but recipe in grams: <b>1 each = 110 g</b>.
        Same-dimension conversions (kg↔g, L↔ml) are automatic.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
        {bridges.length === 0 && <div style={{ fontSize: 12, color: 'var(--t3)' }}>No bridges yet.</div>}
        {bridges.map(c => (
          <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 7, padding: '8px 12px' }}>
            <span style={{ fontSize: 13, color: 'var(--t1)' }}>{c.fromQty} {c.fromUnit} = {c.toQty} {c.toUnit}</span>
            <button disabled={locked} aria-label="Remove this bridge" onClick={() => remove(c)} style={{ marginLeft: 'auto', background: 'transparent', border: 0, color: 'var(--t3)', cursor: locked ? 'not-allowed' : 'pointer', fontSize: 16, opacity: locked ? 0.55 : 1 }}>×</button>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap', ...(locked ? { opacity: 0.55 } : null) }}>
        <input disabled={locked} type="number" min="0" step="any" value={row.fromQty} onChange={e => setRow(r => ({ ...r, fromQty: e.target.value }))} style={{ ...fieldStyle, width: 70 }} />
        <UnitSelect disabled={locked} value={row.fromUnit} onChange={v => setRow(r => ({ ...r, fromUnit: v }))} />
        <span style={{ color: 'var(--t3)' }}>=</span>
        <input disabled={locked} type="number" min="0" step="any" value={row.toQty} onChange={e => setRow(r => ({ ...r, toQty: e.target.value }))} style={{ ...fieldStyle, width: 70 }} placeholder="qty" />
        <UnitSelect disabled={locked} value={row.toUnit} onChange={v => setRow(r => ({ ...r, toUnit: v }))} />
        <button onClick={add} disabled={locked || busy} style={{ padding: '8px 16px', borderRadius: 7, background: 'var(--acc)', color: '#fff', border: 0, cursor: locked ? 'not-allowed' : 'pointer', fontSize: 13, fontWeight: 700, opacity: busy ? 0.6 : 1 }}>{busy ? 'Adding…' : 'Add bridge'}</button>
      </div>
    </div>
  );
}
