// src/staff/StaffShiftSwaps.jsx
//
// v5.11.101: open shifts, swaps and availability in the staff app (?mode=staff, StaffSurface Shifts tab).
//   * "Can't do this shift" on my own shift: open it to everyone in my position, or offer it to one
//     colleague.
//   * Open shifts I could take (a manager's open shift, or a colleague's dropped shift): Claim. One I
//     cannot take says why (it overlaps my shift, I am on leave, I marked myself unavailable, the
//     hours cap), so nobody taps and gets refused.
//   * Offers to me: Accept or Decline. My requests and what happened to them.
//   * My weekly availability: Available / Preferred / Unavailable per weekday (the same record a
//     manager sets in Workforce, Leave).
// Every change goes to staff-portal, and the database judges it (the first claim wins). The venue
// setting decides whether a claim happens straight away or waits for a manager; the words say which.
// Mobile first; the venue's skin tokens (var(--acc) etc.), as the rest of the staff app.

import { useState } from 'react';
import { openShiftsEmptyWords } from '../../supabase/functions/_shared/openShiftsHidden.js';
import { dayText, timeText } from './staffDates';

const glass = { padding: '14px 16px', borderRadius: 16 };
const small = { background: 'none', border: '1px solid var(--bdr)', borderRadius: 999, padding: '6px 13px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
const solid = { ...small, background: 'var(--acc)', border: 'none', color: '#fff' };
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const STATES = [['available', 'Available'], ['preferred', 'Preferred'], ['unavailable', 'Unavailable']];
const STATUS_WORDS = { open: 'Waiting for someone to take it', pending: 'Waiting for a manager', approved: 'Done', declined: 'Declined', cancelled: 'Cancelled', claimed: 'Taken', denied: 'Declined' };
const STATUS_TONE = { open: 'var(--t3)', pending: 'var(--amber)', approved: 'var(--grn)', declined: 'var(--red)', cancelled: 'var(--t4)' };

function ErrLine({ children }) {
  return children ? <div style={{ color: 'var(--red)', fontSize: 12.5, fontWeight: 600, margin: '8px 0' }}>{children}</div> : null;
}

/** The "Can't do this shift" panel under one of my shifts. */
export function CantDoPanel({ shift, colleagues, myRole, call, onDone, onClose }) {
  const [mode, setMode] = useState('open');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const same = (colleagues || []).filter(c => !myRole || c.roleKey === myRole);
  const send = async () => {
    setBusy(true); setErr('');
    try {
      const r = await call({ action: 'shift_drop', shift_id: shift.id, to_staff_id: mode === 'offer' ? to : null, note });
      onDone(r.kind === 'offer' ? 'Offered. They get a text to accept or decline.' : `It is up for grabs. ${r.texted ? `${r.texted} colleague${r.texted === 1 ? '' : 's'} who could take it got a text.` : 'Colleagues who could take it see it in the app.'}`);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--bdr)' }}>
      <div style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.5, marginBottom: 8 }}>It stays your shift until someone takes it.</div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, marginBottom: 6 }}>
        <input type="radio" checked={mode === 'open'} onChange={() => setMode('open')} /> Open it to everyone in my position
      </label>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13.5, marginBottom: 8 }}>
        <input type="radio" checked={mode === 'offer'} onChange={() => setMode('offer')} disabled={!same.length} /> Offer it to a colleague
      </label>
      {mode === 'offer' && (
        <select value={to} onChange={e => setTo(e.target.value)} style={{ width: '100%', padding: '11px 12px', borderRadius: 12, border: '1px solid var(--bdr)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit', marginBottom: 8 }}>
          <option value="">Pick a colleague</option>
          {same.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}
      <input value={note} onChange={e => setNote(e.target.value.slice(0, 300))} placeholder="Note (optional), e.g. dentist"
        style={{ width: '100%', padding: '11px 12px', borderRadius: 12, border: '1px solid var(--bdr)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit', boxSizing: 'border-box' }} />
      <ErrLine>{err}</ErrLine>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button onClick={onClose} disabled={busy} style={{ ...small, color: 'var(--t3)' }}>Keep it</button>
        <button onClick={send} disabled={busy || (mode === 'offer' && !to)} style={{ ...solid, flex: 1, padding: '10px 14px', opacity: busy || (mode === 'offer' && !to) ? 0.6 : 1 }}>{busy ? 'Sending…' : mode === 'offer' ? 'Offer it' : 'Put it up'}</button>
      </div>
    </div>
  );
}

/** Open shifts, offers to me and my requests. */
export function SwapsSection({ swaps, locale, call, onChanged }) {
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  if (!swaps) return null;
  const instant = swaps.mode === 'instant';
  const act = async (key, body, ok) => {
    setBusy(key); setErr(''); setMsg('');
    try { const r = await call(body); setMsg(ok(r)); await onChanged(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(null); }
  };
  const claimWords = (r) => (r.outcome === 'assigned' ? 'It is yours. It is on your shifts now.' : 'Asked. A manager decides, and we will text you.');
  const when = (x) => `${dayText(x.date, locale)} · ${timeText(x.start, locale)} to ${timeText(x.finish, locale)}`;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 6 }}>
      {msg && <div className="sv-glass" style={{ ...glass, color: 'var(--grn)', fontSize: 13, fontWeight: 700 }}>{msg}</div>}
      {err && <div className="sv-glass" style={{ ...glass, color: 'var(--red)', fontSize: 13, fontWeight: 700 }}>{err}</div>}

      {swaps.offers.map(o => (
        <div key={o.requestId} className="sv-glass" style={{ ...glass, border: '1px solid var(--acc)' }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--acc)', letterSpacing: '.06em', textTransform: 'uppercase' }}>Offered to you</div>
          <div style={{ fontSize: 14.5, fontWeight: 800, marginTop: 4 }}>{when(o)}</div>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>{o.fromName} cannot do it{o.role ? ` · ${o.role}` : ''}{o.note ? ` · ${o.note}` : ''}</div>
          {o.why && <div style={{ fontSize: 12, color: 'var(--amber)', marginTop: 6 }}>{o.why}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button disabled={!!busy} onClick={() => act(`d-${o.requestId}`, { action: 'swap_decline', request_id: o.requestId }, () => 'Declined. They have been told.')} style={{ ...small, color: 'var(--t2)' }}>Decline</button>
            <button disabled={!!busy || !!o.why} onClick={() => act(`c-${o.shiftId}`, { action: 'shift_claim', shift_id: o.shiftId }, claimWords)} style={{ ...solid, flex: 1, opacity: busy || o.why ? 0.6 : 1 }}>
              {busy === `c-${o.shiftId}` ? 'Sending…' : instant ? 'Accept' : 'Accept (manager approves)'}
            </button>
          </div>
        </div>
      ))}

      <div className="sv-glass" style={glass}>
        <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 4 }}>Open shifts</div>
        <div style={{ fontSize: 11.5, color: 'var(--t4)', marginBottom: swaps.open.length ? 8 : 0 }}>
          {swaps.open.length ? (instant ? 'Claim one and it is yours straight away. The first claim wins.' : 'Claim one and a manager approves it. The first claim wins.') : openShiftsEmptyWords(swaps.hidden)}
        </div>
        {swaps.open.map(o => (
          <div key={o.shiftId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', borderTop: '1px solid var(--bdr)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700 }}>{when(o)}</div>
              <div style={{ fontSize: 11.5, color: 'var(--t3)' }}>{[o.role, o.section, o.kind === 'drop' ? `${o.fromName} cannot do it` : null, o.note].filter(Boolean).join(' · ')}</div>
              {o.why && <div style={{ fontSize: 11.5, color: 'var(--amber)', marginTop: 2 }}>{o.why}</div>}
            </div>
            <button disabled={!!busy || !!o.why} onClick={() => act(`c-${o.shiftId}`, { action: 'shift_claim', shift_id: o.shiftId }, claimWords)} style={{ ...solid, opacity: busy || o.why ? 0.5 : 1 }}>
              {busy === `c-${o.shiftId}` ? '…' : 'Claim'}
            </button>
          </div>
        ))}
      </div>

      {swaps.mine.length > 0 && (
        <div className="sv-glass" style={glass}>
          <div style={{ fontSize: 13.5, fontWeight: 800, marginBottom: 6 }}>My swaps</div>
          {swaps.mine.map(m => {
            const canCancel = (m.side === 'giving' && (m.status === 'open' || m.status === 'pending')) || (m.side === 'taking' && m.status === 'pending');
            return (
              <div key={m.requestId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--bdr)', fontSize: 12.5 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 700 }}>{when(m)}</div>
                  <div style={{ color: 'var(--t3)' }}>
                    {m.side === 'giving' ? (m.kind === 'offer' ? `Offered to ${m.otherName || 'a colleague'}` : m.otherName ? `${m.otherName} is taking it` : 'Up for grabs') : (m.kind === 'claim' ? 'You claimed it' : `From ${m.otherName || 'a colleague'}`)}
                    {' · '}<b style={{ color: STATUS_TONE[m.status] || 'var(--t3)' }}>{STATUS_WORDS[m.status] || m.status}</b>
                  </div>
                </div>
                {canCancel && (
                  <button disabled={!!busy} onClick={() => act(`x-${m.requestId}`, { action: 'swap_cancel', request_id: m.requestId }, (r) => (r.outcome === 'reopened' ? 'Withdrawn. It is up for someone else again.' : 'Cancelled.'))} style={{ ...small, color: 'var(--t2)' }}>
                    {m.side === 'giving' ? 'Take it back' : 'Withdraw'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** My weekly availability (Monday to Sunday). */
export function AvailabilityCard({ availability, call, onChanged }) {
  const fromSnap = () => DAYS.map((_, i) => (availability?.perDay || []).find(d => Number(d.day) === i)?.state || 'available');
  const [editing, setEditing] = useState(false);
  const [days, setDays] = useState(fromSnap);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const current = fromSnap();
  const save = async () => {
    setBusy(true); setErr(''); setSaved('');
    try {
      await call({ action: 'availability_set', per_day: days.map((state, day) => ({ day, state })) });
      setEditing(false); setSaved('Saved. Your manager sees it on the rota.');
      await onChanged();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="sv-glass" style={{ ...glass, marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 13.5, fontWeight: 800 }}>My availability</span>
        <button onClick={() => { setDays(fromSnap()); setEditing(e => !e); setErr(''); setSaved(''); }} style={{ ...small, color: editing ? 'var(--t3)' : 'var(--acc)', padding: '5px 12px' }}>{editing ? 'Cancel' : 'Edit'}</button>
      </div>
      {saved && <div style={{ color: 'var(--grn)', fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>{saved}</div>}
      {!editing ? (
        <div style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.7 }}>
          {current.every(s => s === 'available') ? 'Available every day.' : DAYS.map((d, i) => (current[i] === 'available' ? null : <div key={d}>{d}: <b style={{ color: current[i] === 'unavailable' ? 'var(--red)' : 'var(--grn)' }}>{current[i] === 'unavailable' ? 'Unavailable' : 'Preferred'}</b></div>))}
        </div>
      ) : (
        <div>
          {DAYS.map((d, i) => (
            <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: i ? '1px solid var(--bdr)' : 'none' }}>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{d}</span>
              <div style={{ display: 'flex', gap: 4 }}>
                {STATES.map(([k, lbl]) => (
                  <button key={k} onClick={() => setDays(cur => cur.map((x, j) => (j === i ? k : x)))}
                    style={{ ...small, padding: '5px 9px', fontSize: 11, background: days[i] === k ? (k === 'unavailable' ? 'var(--red)' : 'var(--acc)') : 'transparent', color: days[i] === k ? '#fff' : 'var(--t2)', border: days[i] === k ? 'none' : '1px solid var(--bdr)' }}>{lbl}</button>
                ))}
              </div>
            </div>
          ))}
          <ErrLine>{err}</ErrLine>
          <button onClick={save} disabled={busy} style={{ ...solid, width: '100%', padding: '12px 14px', fontSize: 14, marginTop: 8, opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save availability'}</button>
          <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 8, lineHeight: 1.5 }}>Unavailable days stop you claiming open shifts on those days.</div>
        </div>
      )}
    </div>
  );
}
