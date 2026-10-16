// src/surfaces/bookings/ServicePeriodsEditor.jsx
//
// Service periods and booking rules (16 Oct 2026, bookings audit section 3 item 6). One editor,
// used on the host stand Rules screen and in Back Office Table bookings:
//   services        lunch, dinner, any number per day, each with its weekdays, start, end (an end
//                   at or before the start runs past midnight) and an optional last seating
//                   (before midnight: a booking belongs to the day it starts on)
//   slot interval   the minutes between bookable times
//   closed days     weekdays with no service
//   closed dates    date ranges (holidays) or times on dates (an evening private hire), for
//                   everyone or for the online widget only
//   online notice   how long before the time online bookings close
// Every change writes through updateBookingRules (optimistic, then saved), like the rest of the
// Rules screen. A service is saved only once it is complete (start, end, at least one day), so a
// half typed row never reaches the widget. The rules themselves are pure and tested in
// src/lib/bookings/optimiser.js (servicePeriods.test.js).
//
// Before migration 20261016e the columns are not on the database: the editor says so in words
// and saves nothing for them (the slot interval still saves, its column is old).

import { useMemo, useState } from 'react';
import {
  checkPeriod, checkBlock, serviceWindows, describeWindows, servicePeriodsOf, addDaysISO, sayDay,
  WEEKDAY_SHORT, toMin, blockReason,
} from '../../lib/bookings/optimiser.js';

const DAYS = [1, 2, 3, 4, 5, 6, 7];
const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const LUNCH_DINNER = () => ([
  { id: newId('p'), name: 'Lunch', days: [...DAYS], start: '12:00', end: '15:00', lastSeating: '13:30' },
  { id: newId('p'), name: 'Dinner', days: [...DAYS], start: '17:00', end: '22:30', lastSeating: '21:00' },
]);

const S = {
  card: { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 14 },
  h: { fontSize: 13, fontWeight: 800, color: 'var(--t1)' },
  hint: { fontSize: 12, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 },
  sub: { fontSize: 12, fontWeight: 700, color: 'var(--t2)', marginTop: 14 },
  inp: { padding: '7px 9px', borderRadius: 9, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 13, boxSizing: 'border-box', minWidth: 0 },
  btn: { padding: '8px 12px', borderRadius: 9, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' },
  x: { border: 'none', background: 'transparent', color: 'var(--t3)', cursor: 'pointer', fontSize: 18, padding: '0 4px', lineHeight: 1, fontFamily: 'inherit' },
  err: { fontSize: 12, color: 'var(--red)', marginTop: 6 },
  note: { fontSize: 12, color: 'var(--t3)', marginTop: 6 },
  row: { border: '1px solid var(--bdr)', borderRadius: 10, padding: 10, marginTop: 10, background: 'var(--bg2)' },
  lbl: { fontSize: 11, fontWeight: 700, color: 'var(--t3)', display: 'block', marginBottom: 3 },
};

function DayPills({ value = [], onChange, disabled, danger = false }) {
  const on = new Set((value || []).map(Number));
  return (
    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
      {DAYS.map((d) => {
        const active = on.has(d);
        const col = danger ? 'var(--red)' : 'var(--acc)';
        return (
          <button key={d} type="button" disabled={disabled} aria-pressed={active}
            onClick={() => onChange(active ? [...on].filter((x) => x !== d).sort() : [...on, d].sort())}
            style={{
              minWidth: 40, height: 32, borderRadius: 8, fontSize: 12, fontWeight: 700, fontFamily: 'inherit',
              cursor: disabled ? 'default' : 'pointer',
              border: `1.5px solid ${active ? col : 'var(--bdr2)'}`,
              background: active ? `color-mix(in srgb, ${col} 14%, transparent)` : 'var(--bg1)',
              color: active ? col : 'var(--t3)',
            }}>{WEEKDAY_SHORT[d]}</button>
        );
      })}
    </div>
  );
}

function StepRow({ label, sub, value, onChange, step, min, max, fmt, disabled }) {
  const clamp = (v) => Math.min(max, Math.max(min, v));
  const b = { ...S.btn, width: 32, height: 32, padding: 0, fontSize: 16 };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderTop: '1px solid var(--bdr)', marginTop: 12, flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 200px', minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{label}</div>
        {sub && <div style={S.hint}>{sub}</div>}
      </div>
      <button type="button" style={b} disabled={disabled} onClick={() => onChange(clamp(Number(value) - step))} aria-label={`decrease ${label}`}>-</button>
      <div style={{ minWidth: 70, textAlign: 'center', fontSize: 14, fontWeight: 800, fontFamily: 'var(--font-mono, ui-monospace, monospace)', color: 'var(--t1)' }}>{fmt(value)}</div>
      <button type="button" style={b} disabled={disabled} onClick={() => onChange(clamp(Number(value) + step))} aria-label={`increase ${label}`}>+</button>
    </div>
  );
}

const noticeWords = (m) => {
  const n = Math.max(0, Number(m) || 0);
  if (!n) return 'None';
  if (n % 60 === 0) return `${n / 60} h`;
  return n < 60 ? `${n} min` : `${Math.floor(n / 60)} h ${n % 60}`;
};

// rules  the merged rules (store rules over the defaults)
// patch  updateBookingRules
// ready  false when the database has not had migration 20261016e (bookingRules.servicePeriodsReady)
// today  'YYYY-MM-DD' on the venue clock, for the week preview
export default function ServicePeriodsEditor({ rules = {}, patch, ready = true, today = null }) {
  const saved = Array.isArray(rules.servicePeriods) ? rules.servicePeriods : [];
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState(saved);
  // Another device (or Back Office) changed them: follow, unless this screen holds an unsaved row.
  // (Adjusted while rendering, the React pattern for following a prop, not in an effect.)
  const [seenKey, setSeenKey] = useState(savedKey);
  if (seenKey !== savedKey) {
    setSeenKey(savedKey);
    if (!draft.some((p) => checkPeriod(p))) setDraft(JSON.parse(savedKey));
  }
  const errors = draft.map((p) => checkPeriod(p));
  const write = (list) => {
    setDraft(list);
    if (list.every((p) => !checkPeriod(p))) patch?.({ servicePeriods: list });
  };
  const setPeriod = (i, part, { save = true } = {}) => {
    const list = draft.map((p, j) => (j === i ? { ...p, ...part } : p));
    if (save) write(list); else setDraft(list);
  };

  const closed = Array.isArray(rules.closedWeekdays) ? rules.closedWeekdays : [];
  const blocks = Array.isArray(rules.dateBlocks) ? rules.dateBlocks : [];
  const [nb, setNb] = useState({ from: '', to: '', label: '', start: '', end: '', onlineOnly: false });
  const nbErr = nb.from ? checkBlock({ ...nb, to: nb.to || nb.from, start: nb.start || null, end: nb.end || null }) : null;
  const addBlock = () => {
    if (!nb.from || nbErr) return;
    const b = { id: newId('b'), from: nb.from, to: nb.to || nb.from, label: nb.label.trim() };
    if (nb.start && nb.end) { b.start = nb.start; b.end = nb.end; }
    if (nb.onlineOnly) b.onlineOnly = true;
    patch?.({ dateBlocks: [...blocks, b].sort((x, y) => String(x.from).localeCompare(String(y.from))) });
    setNb({ from: '', to: '', label: '', start: '', end: '', onlineOnly: false });
  };

  const { custom } = servicePeriodsOf(rules);
  const week = useMemo(() => {
    if (!today) return [];
    return Array.from({ length: 7 }, (_, i) => {
      const d = addDaysISO(today, i);
      const sw = serviceWindows(rules, d);
      const words = sw.closed === 'blocked' ? `Closed${blockReason(sw.block?.label) ? ` (${blockReason(sw.block?.label)})` : ''}`
        : sw.closed === 'closed_day' ? 'Closed'
        : describeWindows(sw.windows.filter((w) => !w.spill)) || 'Closed';
      return { d, words };
    });
  }, [rules, today]);

  const off = !ready;
  return (
    <div style={S.card}>
      <div style={S.h}>Service periods and booking rules</div>
      <div style={S.hint}>
        When the venue takes bookings: lunch, dinner, any number of services a day. The Book screen, the Edit sheet, the Timeline and the online booking page all follow these.
      </div>
      {off && (
        <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 10, border: '1px solid var(--orn)', color: 'var(--orn)', fontSize: 12.5, lineHeight: 1.5, background: 'color-mix(in srgb, var(--orn) 8%, transparent)' }}>
          Service periods need the database update 20261016e first. Until it is run the venue keeps one window, {String(rules.serviceStart || '17:00').slice(0, 5)} to {String(rules.serviceEnd || '23:00').slice(0, 5)}, every day. Only the time between booking slots can be saved until then.
        </div>
      )}

      {/* ── services ── */}
      <div style={S.sub}>Services</div>
      {draft.length === 0 && (
        <div style={S.note}>
          One window every day, {String(rules.serviceStart || '17:00').slice(0, 5)} to {String(rules.serviceEnd || '23:00').slice(0, 5)}.
          {' '}Add services to set lunch and dinner, different hours on different days, or a late service that ends past midnight.
        </div>
      )}
      {draft.map((p, i) => {
        const pastMidnight = p.start && p.end && toMin(p.end) <= toMin(p.start);
        return (
          <div key={p.id || i} style={S.row}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label style={{ flex: '1 1 120px', minWidth: 100 }}>
                <span style={S.lbl}>Name</span>
                <input style={{ ...S.inp, width: '100%' }} value={p.name || ''} disabled={off} placeholder="Lunch"
                  onChange={(e) => setPeriod(i, { name: e.target.value }, { save: false })}
                  onBlur={() => write(draft)} />
              </label>
              <label>
                <span style={S.lbl}>Start</span>
                <input type="time" style={S.inp} value={p.start || ''} disabled={off} onChange={(e) => setPeriod(i, { start: e.target.value })} />
              </label>
              <label>
                <span style={S.lbl}>End</span>
                <input type="time" style={S.inp} value={p.end || ''} disabled={off} onChange={(e) => setPeriod(i, { end: e.target.value })} />
              </label>
              <label>
                <span style={S.lbl}>Last seating</span>
                <input type="time" style={S.inp} value={p.lastSeating || ''} disabled={off} onChange={(e) => setPeriod(i, { lastSeating: e.target.value || null })} />
              </label>
              <button type="button" style={S.x} disabled={off} title="Remove this service" aria-label="Remove this service"
                onClick={() => write(draft.filter((_, j) => j !== i))}>×</button>
            </div>
            <div style={{ marginTop: 8 }}>
              <DayPills value={p.days} disabled={off} onChange={(days) => setPeriod(i, { days })} />
            </div>
            {errors[i]
              ? <div style={S.err}>{errors[i]} Not saved until it is fixed.</div>
              : <div style={S.note}>
                  {pastMidnight ? 'Runs past midnight. Nobody is booked in after midnight: a booking belongs to the day it starts on. ' : ''}
                  {p.lastSeating ? `Last booking ${p.lastSeating}.` : pastMidnight ? 'No last seating set: the last booking is the last slot before midnight.' : 'No last seating set: the last booking is one slot before the end.'}
                </div>}
          </div>
        );
      })}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        {draft.length === 0 && (
          <button type="button" style={S.btn} disabled={off} onClick={() => write(LUNCH_DINNER())}>Set up lunch and dinner</button>
        )}
        <button type="button" style={S.btn} disabled={off}
          onClick={() => write([...draft, { id: newId('p'), name: draft.length ? 'Service' : 'Dinner', days: [...DAYS], start: '17:00', end: '22:00', lastSeating: null }])}>
          Add a service
        </button>
        {draft.length > 0 && (
          <button type="button" style={S.btn} disabled={off} onClick={() => write([])}>Back to one window</button>
        )}
      </div>

      <StepRow label="Time between booking slots" sub="The gap between the times offered on the Book screen and online."
        value={rules.slotMinutes || 15} onChange={(v) => patch?.({ slotMinutes: v })}
        step={15} min={15} max={60} fmt={(v) => `${v} min`} />

      {/* ── closed days ── */}
      <div style={S.sub}>Closed days</div>
      <div style={S.hint}>No bookings at all on these days, at the stand or online. The stand can still seat walk ins.</div>
      <div style={{ marginTop: 8 }}>
        <DayPills value={closed} disabled={off} danger onChange={(v) => patch?.({ closedWeekdays: v })} />
      </div>

      {/* ── closed dates and blocks ── */}
      <div style={S.sub}>Closed dates and blocks</div>
      <div style={S.hint}>
        Holidays and refits: pick the first and last day. Private hire or a staff party: add the times too. Online only keeps the host stand open.
      </div>
      {blocks.length === 0 && <div style={S.note}>No dates blocked.</div>}
      {blocks.map((b) => (
        <div key={b.id || `${b.from}${b.start || ''}`} style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--t1)' }}>
          <span style={{ fontWeight: 800 }}>{blockReason(b.label) || (b.start && b.end ? 'Blocked' : 'Closed')}</span>
          <span style={{ color: 'var(--t3)' }}>
            {sayDay(b.from)}{b.to && b.to !== b.from ? ` to ${sayDay(b.to)}` : ''}
            {b.start && b.end ? `, ${b.start} to ${b.end}` : ', all day'}
            {b.onlineOnly ? ', online only' : ''}
          </span>
          <button type="button" style={S.x} disabled={off} title="Remove this block" aria-label="Remove this block"
            onClick={() => patch?.({ dateBlocks: blocks.filter((x) => x !== b) })}>×</button>
        </div>
      ))}
      <div style={{ ...S.row, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label>
          <span style={S.lbl}>From</span>
          <input type="date" style={S.inp} value={nb.from} disabled={off} onChange={(e) => setNb({ ...nb, from: e.target.value })} />
        </label>
        <label>
          <span style={S.lbl}>To</span>
          <input type="date" style={S.inp} value={nb.to} disabled={off} onChange={(e) => setNb({ ...nb, to: e.target.value })} />
        </label>
        <label>
          <span style={S.lbl}>From time</span>
          <input type="time" style={S.inp} value={nb.start} disabled={off} onChange={(e) => setNb({ ...nb, start: e.target.value })} />
        </label>
        <label>
          <span style={S.lbl}>To time</span>
          <input type="time" style={S.inp} value={nb.end} disabled={off} onChange={(e) => setNb({ ...nb, end: e.target.value })} />
        </label>
        <label style={{ flex: '1 1 140px', minWidth: 120 }}>
          <span style={S.lbl}>Reason (staff only)</span>
          <input style={{ ...S.inp, width: '100%' }} value={nb.label} disabled={off} placeholder="Christmas" onChange={(e) => setNb({ ...nb, label: e.target.value })} />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--t2)', height: 34 }}>
          <input type="checkbox" checked={nb.onlineOnly} disabled={off} onChange={(e) => setNb({ ...nb, onlineOnly: e.target.checked })} />
          Online only
        </label>
        <button type="button" style={S.btn} disabled={off || !nb.from || !!nbErr} onClick={addBlock}>Block</button>
      </div>
      {nbErr && <div style={S.err}>{nbErr}</div>}

      <StepRow label="Online notice" sub="Online bookings close this long before the time. The host stand is never held to it."
        value={rules.minNoticeMinutes || 0} onChange={(v) => patch?.({ minNoticeMinutes: v })}
        step={30} min={0} max={2880} fmt={noticeWords} disabled={off} />

      {/* ── the week as the rules read it ── */}
      {week.length > 0 && (
        <>
          <div style={S.sub}>The next 7 days{custom ? '' : ' (one window)'}</div>
          <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: 'minmax(90px, auto) 1fr', gap: '4px 12px', fontSize: 12.5 }}>
            {week.map((w) => (
              <div key={w.d} style={{ display: 'contents' }}>
                <span style={{ fontWeight: 700, color: 'var(--t2)' }}>{sayDay(w.d)}</span>
                <span style={{ color: w.words.startsWith('Closed') ? 'var(--red)' : 'var(--t1)' }}>{w.words}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
