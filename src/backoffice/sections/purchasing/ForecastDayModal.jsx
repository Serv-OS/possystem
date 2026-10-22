// purchasing/ForecastDayModal.jsx: edit one day of the forecast (multi site stock Drop 3, v5.11.96,
// contract 3.2 and 4.2). The amount, a reason when it differs from the suggestion (Weather, Local
// event, Pre order or booking, Promotion, Closure, Other), a note, and optional amounts by hour.

import { useState } from 'react';
import { Modal, Btn, Field, ui } from '../stock/stockUi';
import { FORECAST_REASONS } from '../../../lib/stock/purchasingWords';
import { dayWords } from '../../../lib/stock/purchasingRules';

const HOURS = Array.from({ length: 24 }, (_, h) => h);

export default function ForecastDayModal({ day, amount = null, suggested = null, reason = null, note = '', hours = [], onSave, onClose }) {
  const [amt, setAmt] = useState(amount != null ? String(amount) : (suggested != null ? String(suggested) : ''));
  const [why, setWhy] = useState(reason || '');
  const [text, setText] = useState(note || '');
  const [byHour, setByHour] = useState(() => Object.fromEntries((hours || []).map((h) => [h.hour, String(h.amount)])));
  const [showHours, setShowHours] = useState((hours || []).length > 0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const n = amt.trim() === '' ? null : Number(amt);
  const changed = n != null && suggested != null && Math.abs(n - Number(suggested)) > 0.004;
  const save = async () => {
    if (n == null || !Number.isFinite(n) || n < 0) { setErr('Type an amount, 0 or more.'); return; }
    if (changed && !why) { setErr(`Pick a reason for ${dayWords(day)}.`); return; }
    const hourRows = showHours ? Object.entries(byHour).filter(([, v]) => String(v).trim() !== '').map(([h, v]) => ({ day, hour: Number(h), amount: Number(v), reason: why || null })) : [];
    if (hourRows.some((h) => !(h.amount >= 0))) { setErr('Each hour needs an amount, 0 or more.'); return; }
    setBusy(true); setErr(null);
    const r = await onSave?.({ day, amount: n, reason: why || null, reason_note: text.trim() || null, hours: hourRows });
    setBusy(false);
    if (r && r.error) setErr(r.error.message || String(r.error));
  };
  return (
    <Modal title={`Forecast for ${dayWords(day)}`} sub={suggested != null ? `Suggested ${suggested}` : 'No suggestion yet for this day.'} onClose={onClose} width={520}
      footer={<><Btn onClick={onClose}>Cancel</Btn><span style={{ marginLeft: 'auto' }} /><Btn kind="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Btn></>}>
      <Field label="Forecast sales">
        <input inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value)} style={{ ...ui.input, width: 160 }} aria-label="Forecast sales" />
      </Field>
      <Field label="Reason" hint={changed ? 'Needed when the forecast is not the suggestion.' : null}>
        <select value={why} onChange={(e) => setWhy(e.target.value)} style={{ ...ui.input, width: 240 }} aria-label="Reason">
          <option value="">No reason</option>
          {FORECAST_REASONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </Field>
      <Field label="Note">
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Football on the big screen" style={ui.input} aria-label="Note" />
      </Field>
      <Btn kind="link" small onClick={() => setShowHours((v) => !v)}>{showHours ? 'Hide hours' : 'Edit by hour'}</Btn>
      {showHours && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: 6, marginTop: 8 }}>
          {HOURS.map((h) => (
            <label key={h} style={{ fontSize: 12, color: 'var(--t3)' }}>{String(h).padStart(2, '0')}:00
              <input inputMode="decimal" value={byHour[h] ?? ''} onChange={(e) => setByHour((m) => ({ ...m, [h]: e.target.value }))} style={{ ...ui.input, padding: '5px 7px' }} aria-label={`Hour ${h}`} />
            </label>
          ))}
        </div>
      )}
      {err && <div role="alert" style={{ ...ui.err, marginTop: 10 }}>{err}</div>}
    </Modal>
  );
}
