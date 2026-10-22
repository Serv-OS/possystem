// src/backoffice/sections/stock/FreshCloseDown.jsx
//
// MULTI SITE STOCK (v5.11.96, Drop 3, contract 3.3 and 4.3, map J6): the End of day fresh close
// down. Today's short life items at the site (made today or delivered today, use by today), what is
// left typed per line, and ONE stock_record_waste call books every line as waste with the reason
// 'End of day'. Nothing moves until Book as waste is pressed and the database answers. Over the
// company's limit the database asks for a manager PIN and the same call is sent again with it.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../../store';
import { stockApi } from '../../../lib/stock/stockApi';
import { logCloseDownWaste } from '../../../lib/stock/waste';
import ManagerPinPrompt from '../../../components/ManagerPinPrompt';
import { Sheet, Btn, ui, TableWrap, Th, Td, ErrorLine, EmptyLine } from './stockUi';

const r3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;

export default function FreshCloseDown({ siteId, onDone, onClose }) {
  const showToast = useStore((s) => s.showToast);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [left, setLeft] = useState({});        // inventory_item_id -> typed text
  const [busy, setBusy] = useState(false);
  const [pinAsk, setPinAsk] = useState(null);

  useEffect(() => {
    let live = true;
    stockApi.freshCloseDownList(siteId).then((r) => {
      if (!live) return;
      if (r.error) { setError(r.error); setRows([]); return; }
      setRows(Array.isArray(r.data) ? r.data : Array.isArray(r.data?.rows) ? r.data.rows : []);
    });
    return () => { live = false; };
  }, [siteId]);

  const lines = useMemo(() => (rows || []).map((r) => ({
    inventoryItemId: r.inventory_item_id, name: r.name, unit: r.unit, qtyBase: Number(left[r.inventory_item_id]) || 0,
  })).filter((l) => l.qtyBase > 0), [rows, left]);

  const book = async (pin = null) => {
    if (!lines.length) { showToast?.('Type what is left on at least one line.', 'error'); return; }
    setBusy(true);
    const res = await logCloseDownWaste({ lines, pin }, siteId);
    setBusy(false);
    if (res.pin) { setPinAsk({ words: res.error?.message || '', error: res.pin === 'needed' ? null : res.error?.message || null }); return; }
    setPinAsk(null);
    if (res.error) { showToast?.(res.error.message, 'error'); return; }
    if (res.training) { showToast?.('Training mode: waste not recorded', 'info'); onDone?.(); return; }
    showToast?.(`Booked ${res.count} item${res.count === 1 ? '' : 's'} as waste.`, 'success');
    onDone?.();
  };

  const dirty = Object.values(left).some((v) => String(v ?? '').trim() !== '');
  return (
    <Sheet title="End of day fresh close down" sub='Type what is left. It is booked as waste in one go, with the reason "end of day".' width={640} onClose={onClose} dirty={dirty && !busy}
      footer={<>
        <span style={{ fontSize: 13, color: 'var(--t3)', marginRight: 'auto' }}>{lines.length} of {(rows || []).length} lines to book</span>
        <Btn onClick={onClose} disabled={busy}>Cancel</Btn>
        <Btn kind="primary" onClick={() => book(null)} disabled={busy || !lines.length}>{busy ? 'Booking...' : 'Book as waste'}</Btn>
      </>}>
      <ErrorLine error={error} />
      {rows === null && <div style={{ fontSize: 13, color: 'var(--t3)' }}>Loading…</div>}
      {rows && rows.length === 0 && !error && <EmptyLine>No short life items made or delivered here today.</EmptyLine>}
      {rows && rows.length > 0 && (
        <TableWrap minWidth={480}>
          <thead><tr><Th>Item</Th><Th right>Made or delivered today</Th><Th right>Left</Th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const came = r3((Number(r.made_today) || 0) + (Number(r.delivered_today) || 0));
              return (
                <tr key={r.inventory_item_id}>
                  <Td strong>{r.name}</Td>
                  <Td right num grey={!came}>{came ? `${came} ${r.unit || ''}`.trim() : 'none'}</Td>
                  <Td right>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <input type="number" min="0" step="any" inputMode="decimal" aria-label={`Left: ${r.name}`} value={left[r.inventory_item_id] ?? ''}
                        onChange={(e) => setLeft((m) => ({ ...m, [r.inventory_item_id]: e.target.value }))}
                        style={{ ...ui.input, width: 90, textAlign: 'right' }} />
                      <span style={{ fontSize: 12, color: 'var(--t3)', minWidth: 28 }}>{r.unit || ''}</span>
                    </span>
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
      {pinAsk && <ManagerPinPrompt words={pinAsk.words} error={pinAsk.error} busy={busy} onCancel={() => setPinAsk(null)} onPin={(pin) => book(pin)} />}
    </Sheet>
  );
}
