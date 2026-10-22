// src/backoffice/sections/stock/TransferListsPicker.jsx
//
// MULTI SITE STOCK (v5.11.96, Drop 3, contract 3.3 and 4.3, map K4): the site's saved transfer lists
// ('Tuesday bakery run'). Pick one to fill the lines, or 'Save as a list' to keep the lines on screen.
// onPick(list) gets { id, name, to_location_id, lines: [{ company_item_id, qty_base }] }; onSave()
// returns the lines to keep ([{ company_item_id, qty_base }] and an optional to_location_id), or null.
// Lists are paperwork: nothing here moves stock.

import { useCallback, useEffect, useState } from 'react';
import { useStore } from '../../../store';
import { stockApi } from '../../../lib/stock/stockApi';
import { Btn, ui } from './stockUi';

export default function TransferListsPicker({ siteId, onPick, onSave }) {
  const showToast = useStore((s) => s.showToast);
  const [lists, setLists] = useState([]);
  const [naming, setNaming] = useState(null);   // the name being typed for Save as a list
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await stockApi.transferLists(siteId);
    setLists(r.error ? [] : (r.data || []));
  }, [siteId]);
  useEffect(() => { const t = setTimeout(load, 0); return () => clearTimeout(t); }, [load]);

  const save = async () => {
    const name = String(naming || '').trim();
    if (!name) { showToast?.('Give the list a name.', 'error'); return; }
    const got = onSave?.();
    if (!got || !(got.lines || []).length) { showToast?.('Add at least one item with an amount.', 'error'); return; }
    setBusy(true);
    const r = await stockApi.saveTransferList({ location_id: siteId, to_location_id: got.to_location_id || null, name, lines: got.lines.slice(0, 300) });
    setBusy(false);
    if (r.error) { showToast?.(r.error.message, 'error'); return; }
    showToast?.('List saved.', 'success');
    setNaming(null);
    await load();
  };

  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ ...ui.label, marginBottom: 0 }}>Saved lists</span>
      <select value="" onChange={(e) => { const l = lists.find((x) => x.id === e.target.value); if (l) onPick?.(l); }} style={{ ...ui.input, width: 'auto', minWidth: 160 }} aria-label="Saved lists">
        <option value="">{lists.length ? 'Pick a list' : 'No lists yet'}</option>
        {lists.map((l) => <option key={l.id} value={l.id}>{l.name} ({(l.lines || []).length})</option>)}
      </select>
      {naming === null
        ? <Btn small onClick={() => setNaming('')}>Save as a list</Btn>
        : (
          <>
            <input autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} placeholder="Tuesday bakery run" style={{ ...ui.input, width: 180 }} />
            <Btn small kind="primary" disabled={busy} onClick={save}>{busy ? 'Saving...' : 'Save'}</Btn>
            <Btn small onClick={() => setNaming(null)} disabled={busy}>Cancel</Btn>
          </>
        )}
    </div>
  );
}
