// src/surfaces/manager/ManagerForecastEdit.jsx
//
// MULTI SITE STOCK Drop 3 (contract 3.4, design 2.9, Peter: the forecast is the AI rota's and manager
// edits show on the rota too): the next 7 days' sales forecast for this venue on the phone. A manager
// changes a day with a reason ('Weather', 'Local event', 'Pre order or booking', 'Promotion', 'Closure',
// 'Other') and Save sends it through manager-approve forecast.edit (stock_save_forecast): the same row
// the rota reads (wf_sales_forecast), so the rota, the Order pad and the kitchen plan all see it.

import { useEffect, useState } from 'react';
import { managerApprove } from '../../lib/manager/data';
import { FORECAST_REASONS, forecastDays, dayWord } from '../../lib/manager/kitchen';
import { money } from '../../lib/currency';
import { SheetFrame, PinGate, box, btn, card } from './ManagerTransfers';
import { mono } from './ui';

const reasonWords = (v) => FORECAST_REASONS.find((r) => r.value === v)?.label || '';

export default function ManagerForecastEdit({ ctx, onClose }) {
  const { snap, loc } = ctx;
  const [pin, setPin] = useState('');
  const [days, setDays] = useState(null);
  const [edits, setEdits] = useState({});          // day -> { amount, reason, note }
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // v5.11.99: the business day the Home tile uses (snap.businessDay), else the calendar day.
  const today = snap?.money?.businessDay || snap?.businessDay || snap?.today || null;

  useEffect(() => {
    if (!pin || days) return undefined;
    let live = true;
    managerApprove(loc, pin, 'forecast.edit', null, { read: true, ...(today ? { day: today } : {}) }).then((r) => {
      if (!live) return;
      if (r?.ok) setDays(Array.isArray(r.days) ? r.days : []);
      else { if (/pin|not allowed|approve/i.test(r?.error || '')) setPin(''); setErr(r?.error || 'Could not read the forecast'); }
    });
    return () => { live = false; };
  }, [pin, days, loc, today]);

  const setEdit = (day, k, v) => setEdits((m) => ({ ...m, [day]: { ...(m[day] || { amount: (days || []).find((d) => d.day === day)?.amount ?? '' }), [k]: v } }));

  const save = async () => {
    const { days: list, error } = forecastDays(days, edits);
    if (error) { setErr(error); return; }
    if (!list.length) { setMsg('Nothing changed.'); return; }
    setBusy(true); setErr(''); setMsg('');
    const r = await managerApprove(loc, pin, 'forecast.edit', null, { days: list });
    setBusy(false);
    if (r?.ok) { setMsg(`Saved ${list.length} day${list.length === 1 ? '' : 's'}. The rota shows it too.`); setEdits({}); setDays(null); }
    else { if (/pin|not allowed|approve/i.test(r?.error || '')) setPin(''); setErr(r?.error || 'Could not save the forecast'); }
  };

  if (!pin) return <SheetFrame title="Forecast" sub="One number for staff and stock: the same forecast as the AI rota." onClose={onClose}><PinGate onPin={setPin} /></SheetFrame>;

  return (
    <SheetFrame title="Forecast" sub="One number for staff and stock: the same forecast as the AI rota." onClose={onClose}>
      {msg && <div style={{ marginTop: 10, color: 'var(--grn)', fontWeight: 700, fontSize: 13 }}>{msg}</div>}
      {err && <div role="alert" style={{ marginTop: 10, color: 'var(--red)', fontWeight: 700, fontSize: 13 }}>{err}</div>}
      {!days && !err && <div style={{ color: 'var(--t3)', marginTop: 12, ...mono }}>Loading…</div>}
      {(days || []).map((d) => {
        const e = edits[d.day];
        return (
          <div key={d.day} className="sv-glass" style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 800 }}>{dayWord(d.day)}</div>
                <div style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>
                  {d.amount != null ? `Forecast ${money(d.amount)}` : 'No forecast yet'}{d.reason ? ` · ${reasonWords(d.reason)}` : ''}{d.edited_by_name ? ` · ${d.edited_by_name}` : ''}
                </div>
              </div>
              <input type="number" inputMode="decimal" min="0" step="any" aria-label={`${dayWord(d.day)} forecast`} value={e?.amount ?? d.amount ?? ''}
                onChange={(ev) => setEdit(d.day, 'amount', ev.target.value)} style={{ ...box, width: 110, textAlign: 'right' }} />
            </div>
            {e && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <select value={e.reason || ''} onChange={(ev) => setEdit(d.day, 'reason', ev.target.value || null)} aria-label="Reason" style={{ ...box, flex: '1 1 150px' }}>
                  <option value="">Pick a reason</option>
                  {FORECAST_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
                <input value={e.note || ''} onChange={(ev) => setEdit(d.day, 'note', ev.target.value.slice(0, 200))} placeholder="Note (optional)" aria-label="Note" style={{ ...box, flex: '2 1 180px' }} />
              </div>
            )}
          </div>
        );
      })}
      {days && days.length > 0 && (
        <button type="button" disabled={busy} onClick={save} className="sv-glass" style={{ ...btn('var(--grn)', !busy), width: '100%', marginTop: 12 }}>{busy ? 'Saving…' : 'Save'}</button>
      )}
    </SheetFrame>
  );
}
