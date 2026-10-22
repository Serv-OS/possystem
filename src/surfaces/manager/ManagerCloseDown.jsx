// src/surfaces/manager/ManagerCloseDown.jsx
//
// MULTI SITE STOCK Drop 3 (contract 3.4, J6, words 4.3): the end of day fresh close down on the phone.
// Today's short life items at this venue (made or delivered today, or a batch that expires today) are
// listed; type what is left and it is booked as waste in one go with the reason "End of day"
// (manager-approve waste.closedown, one stock_record_waste call). Over the venue's set value the
// database asks for a manager PIN: the phone asks for it and sends it to manager-approve, which proves
// it and passes only the PIN holder on. Any staff PIN opens the sheet.

import { useEffect, useState } from 'react';
import { managerApprove } from '../../lib/manager/data';
import { closeDownLines } from '../../lib/manager/kitchen';
import { pinAsked } from '../../lib/manager/stockPhone';
import { SheetFrame, PinGate, box, btn, card } from './ManagerTransfers';
import { mono } from './ui';

export default function ManagerCloseDown({ ctx, onClose }) {
  const { loc, refreshSnap } = ctx;
  const [pin, setPin] = useState('');
  const [rows, setRows] = useState(null);
  const [typed, setTyped] = useState({});
  const [ask, setAsk] = useState(null);            // the database's PIN words when it asks
  const [managerPin, setManagerPin] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pin || rows) return undefined;
    let live = true;
    managerApprove(loc, pin, 'waste.closedown', null, { list: true }).then((r) => {
      if (!live) return;
      if (r?.ok) setRows(Array.isArray(r.rows) ? r.rows : []);
      else { if (/pin|not allowed|approve/i.test(r?.error || '')) setPin(''); setErr(r?.error || 'Could not read the list'); }
    });
    return () => { live = false; };
  }, [pin, rows, loc]);

  const book = async (withPin = null) => {
    const lines = closeDownLines(rows, typed);
    if (!lines.length) { setErr('Type what is left on at least one line.'); return; }
    setBusy(true); setErr(''); setMsg('');
    const r = await managerApprove(loc, pin, 'waste.closedown', null, { lines, ...(withPin ? { manager_pin: withPin } : {}) });
    setBusy(false);
    const asked = pinAsked(r);
    if (asked) { setAsk({ kind: asked, words: r.error }); setManagerPin(''); return; }
    if (r?.ok) { setMsg(`Booked ${lines.length} item${lines.length === 1 ? '' : 's'} as waste.`); setAsk(null); setTyped({}); setRows(null); refreshSnap?.(); }
    else setErr(r?.error || 'Could not book the close down');
  };

  if (!pin) return <SheetFrame title="End of day fresh close down" sub='Type what is left. It is booked as waste in one go, with the reason "end of day".' onClose={onClose}><PinGate onPin={setPin} words="Staff PIN to open this" /></SheetFrame>;

  return (
    <SheetFrame title="End of day fresh close down" sub='Type what is left. It is booked as waste in one go, with the reason "end of day".' onClose={onClose}>
      {msg && <div style={{ marginTop: 10, color: 'var(--grn)', fontWeight: 700, fontSize: 13 }}>{msg}</div>}
      {err && <div role="alert" style={{ marginTop: 10, color: 'var(--red)', fontWeight: 700, fontSize: 13 }}>{err}</div>}
      {!rows && !err && <div style={{ color: 'var(--t3)', marginTop: 12, ...mono }}>Loading…</div>}
      {rows && rows.length === 0 && <div className="sv-glass" style={{ ...card, color: 'var(--t3)', fontSize: 13 }}>No short life items today.</div>}
      {(rows || []).map((r) => (
        <div key={r.inventory_item_id} className="sv-glass" style={{ ...card, display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{r.name}</div>
            <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>
              Made or delivered today {(Number(r.made_today) || 0) + (Number(r.delivered_today) || 0)} {r.unit || ''} · on hand {Number(r.on_hand) || 0}
            </div>
          </div>
          <input type="number" inputMode="decimal" min="0" step="any" aria-label={`${r.name} left`} placeholder="Left" value={typed[r.inventory_item_id] ?? ''}
            onChange={(e) => setTyped((m) => ({ ...m, [r.inventory_item_id]: e.target.value }))} style={{ ...box, width: 90, textAlign: 'right' }} />
        </div>
      ))}
      {ask && (
        <div className="sv-glass" style={{ ...card, border: '1px solid var(--orn)' }}>
          <div style={{ fontSize: 13, fontWeight: 800 }}>Manager PIN</div>
          <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 4 }}>{ask.words || 'This needs a manager PIN.'}</div>
          {ask.kind !== 'locked' && (
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input value={managerPin} type="password" inputMode="numeric" placeholder="PIN" aria-label="Manager PIN"
                onChange={(e) => setManagerPin(e.target.value.replace(/\D/g, '').slice(0, 6))} style={{ ...box, width: 140, fontFamily: 'var(--font-mono)' }} />
              <button type="button" disabled={busy || managerPin.length < 4} onClick={() => book(managerPin)} className="sv-glass" style={btn('var(--grn)', !busy && managerPin.length >= 4)}>Approve</button>
            </div>
          )}
        </div>
      )}
      {rows && rows.length > 0 && (
        <button type="button" disabled={busy} onClick={() => book()} className="sv-glass" style={{ ...btn('var(--red)', !busy), width: '100%', marginTop: 12 }}>{busy ? 'Booking…' : 'Book as waste'}</button>
      )}
    </SheetFrame>
  );
}
