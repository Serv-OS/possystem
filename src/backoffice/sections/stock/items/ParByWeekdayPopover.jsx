// stock/items/ParByWeekdayPopover.jsx: par by day of the week, or days of cover, for one item at one
// site (multi site stock Drop 3, v5.11.96, contract 3.2, map G13). A par for a delivery day wins over
// the usual par on the Order pad; days of cover becomes a par of forecast use per day times the days
// (worked out on the pad, never stored as a par). Saved through stock_save_item_site (site facts).

import { useState } from 'react';
import { Modal, Btn, Field, ui } from '../stockUi';
import { parsFromTyped } from '../../../../lib/stock/purchasingRules';

const DAYS = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'], [0, 'Sunday']];

export default function ParByWeekdayPopover({ item, site, onSave, onClose }) {
  const [typed, setTyped] = useState(() => Object.fromEntries(DAYS.map(([d]) => [d, site?.parByWeekday?.[d] ?? site?.parByWeekday?.[String(d)] ?? ''])));
  const [cover, setCover] = useState(site?.coverDays != null ? String(site.coverDays) : '');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const p = parsFromTyped(typed);
    if (p.error) { setErr(p.error); return; }
    const c = cover.trim() === '' ? null : Number(cover);
    if (c !== null && !(Number.isFinite(c) && c > 0 && c <= 60)) { setErr('Days of cover is a number from 1 to 60, or empty.'); return; }
    setBusy(true); setErr(null);
    const r = await onSave?.({ par_by_weekday: p.value, cover_days: c });
    setBusy(false);
    if (r && r.error) { setErr(r.error.message || String(r.error)); return; }
    onClose?.();
  };
  return (
    <Modal title={`Par by day: ${item?.name || ''}`} sub={`At ${site?.name || 'this site'}. The par for the delivery day wins on the Order pad.`} onClose={onClose} width={480}
      footer={<><Btn onClick={onClose}>Cancel</Btn><span style={{ marginLeft: 'auto' }} /><Btn kind="primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Btn></>}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {DAYS.map(([d, name]) => (
          <label key={d} style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>{name}
            <input inputMode="decimal" value={typed[d]} onChange={(e) => setTyped((t) => ({ ...t, [d]: e.target.value }))} style={{ ...ui.input, width: 90, textAlign: 'right' }} aria-label={`Par on ${name}`} />
          </label>
        ))}
      </div>
      <Field label="Or days of cover" hint="The pad works out a par from the forecast use per day times these days." style={{ marginTop: 14 }}>
        <input inputMode="decimal" value={cover} onChange={(e) => setCover(e.target.value)} style={{ ...ui.input, width: 100 }} aria-label="Days of cover" />
      </Field>
      {site?.unit && <div style={ui.sub}>Pars are in {site.unit}, like the par on the count sheet.</div>}
      {err && <div role="alert" style={{ ...ui.err, marginTop: 8 }}>{err}</div>}
    </Modal>
  );
}
