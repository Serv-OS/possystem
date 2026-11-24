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
// 5.12.91: Part of the day and future weeks, one copy of the rules with the staff-portal.
import { weekOf, dayWords, allAvailable } from '../../supabase/functions/_shared/availabilityChoices.js';

const glass = { padding: '14px 16px', borderRadius: 16 };
const small = { background: 'none', border: '1px solid var(--bdr)', borderRadius: 999, padding: '6px 13px', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' };
const solid = { ...small, background: 'var(--acc)', border: 'none', color: '#fff' };
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const STATES = [['available', 'Available'], ['preferred', 'Preferred'], ['partial', 'Part day'], ['unavailable', 'Unavailable']];
// 5.12.91 (HR feedback batch 2, 24 Nov 2026): Preferred is purple, as in the Back Office. It was the
// same green as Available, so people could not tell the two apart.
const AV_COLOR = { available: 'var(--acc)', preferred: 'var(--pur)', partial: 'var(--amber)', unavailable: 'var(--red)' };
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
  // 5.12.61: a change never lands on a week already on the rota; the first week that can be set is
  // the next rota period (availability.changesFrom).
  // 5.12.91 (HR feedback batch 2, 24 Nov 2026): a pattern can be set for any week up to 26 weeks
  // ahead (students know their timetable months ahead), each applying from its week until the next
  // week that has one. A day can be Part of the day, with one of the site's own options. An older
  // server sends no `weeks` or `options`: the card then works as it did (one change, three choices).
  const weeks = Array.isArray(availability?.weeks) ? availability.weeks : [];
  const options = Array.isArray(availability?.options) ? availability.options : [];
  const upcoming = Array.isArray(availability?.upcoming) ? availability.upcoming
    : availability?.pending ? [{ from: availability.pending.from, perDay: weekOf(availability.pending.perDay), locked: false }] : [];
  const states = STATES.filter(([k]) => k !== 'partial' || options.length > 0);
  const now = weekOf(availability?.perDay);
  // The pattern a week starts from when nothing is filed for it: the one in effect that week.
  const patternFor = (week) => {
    const exact = upcoming.find(u => u.from === week);
    if (exact) return weekOf(exact.perDay);
    const before = upcoming.filter(u => u.from < week).pop();
    return weekOf(before ? before.perDay : availability?.perDay);
  };
  const firstWeek = weeks[0] || availability?.changesFrom || '';
  const [editing, setEditing] = useState(false);
  const [week, setWeek] = useState(firstWeek);
  const [days, setDays] = useState(() => patternFor(firstWeek));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [saved, setSaved] = useState('');
  const fromWords = (ymd) => dayText(ymd, { weekday: true });
  const open = (w) => { setWeek(w); setDays(patternFor(w)); setEditing(true); setErr(''); setSaved(''); };
  const setDay = (i, patch) => setDays(cur => cur.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const pick = (i, k) => setDay(i, k === 'partial' ? { state: k, note: days[i].note || options[0] || '' } : { state: k, note: undefined });
  const save = async () => {
    setBusy(true); setErr(''); setSaved('');
    try {
      const per_day = days.map((d, day) => (d.state === 'partial' ? { day, state: d.state, note: d.note } : { day, state: d.state }));
      const r = await call({ action: 'availability_set', per_day, ...(weeks.length ? { week_start: week } : {}) });
      setEditing(false); setSaved(r?.changesFrom ? `Saved. Applies from ${fromWords(r.changesFrom)}. Your manager sees it on the rota.` : 'Saved. Your manager sees it on the rota.');
      await onChanged();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const remove = async (w) => {
    setBusy(true); setErr(''); setSaved('');
    try { await call({ action: 'availability_clear', week_start: w }); setSaved(`Removed. The week of ${fromWords(w)} follows the pattern before it.`); await onChanged(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  };
  const lines = (pattern) => (allAvailable(pattern) ? 'Available every day.'
    : pattern.map((e, i) => (e.state === 'available' ? null : <div key={i}>{DAYS[i]}: <b style={{ color: AV_COLOR[e.state] || 'var(--grn)' }}>{dayWords(e)}</b></div>)));
  return (
    <div className="sv-glass" style={{ ...glass, marginTop: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{ fontSize: 13.5, fontWeight: 800 }}>My availability</span>
        <button onClick={() => (editing ? setEditing(false) : open(firstWeek))} style={{ ...small, color: editing ? 'var(--t3)' : 'var(--acc)', padding: '5px 12px' }}>{editing ? 'Cancel' : weeks.length ? 'Set a week' : 'Edit'}</button>
      </div>
      {saved && <div style={{ color: 'var(--grn)', fontSize: 12.5, fontWeight: 700, marginBottom: 6 }}>{saved}</div>}
      {!editing ? (
        <div style={{ fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.7 }}>
          <ErrLine>{err}</ErrLine>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t4)' }}>Now</div>
          {lines(now)}
          {upcoming.map(u => (
            <div key={u.from} style={{ marginTop: 6, paddingTop: 6, borderTop: '1px solid var(--bdr)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, fontSize: 11, fontWeight: 700, color: 'var(--amber)' }}>From {fromWords(u.from)}</span>
                {u.locked ? <span style={{ fontSize: 10.5, color: 'var(--t4)' }}>On the rota, ask your manager to change it</span>
                  : weeks.length > 0 && <>
                    <button onClick={() => open(u.from)} disabled={busy} style={{ ...small, padding: '3px 10px', fontSize: 11, color: 'var(--acc)' }}>Edit</button>
                    <button onClick={() => remove(u.from)} disabled={busy} style={{ ...small, padding: '3px 10px', fontSize: 11, color: 'var(--t3)' }}>Remove</button>
                  </>}
              </div>
              {lines(weekOf(u.perDay))}
            </div>
          ))}
          {weeks.length > 0 && <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 8, lineHeight: 1.5 }}>Know your timetable ahead? Tap Set a week for each week it changes. Each one carries on until the next week you set.</div>}
        </div>
      ) : (
        <div>
          {weeks.length > 0 ? (
            <label style={{ display: 'block', marginBottom: 10 }}>
              <span style={{ display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', marginBottom: 5, letterSpacing: '.04em', textTransform: 'uppercase' }}>From the week starting</span>
              <select value={week} onChange={e => { setWeek(e.target.value); setDays(patternFor(e.target.value)); }}
                style={{ width: '100%', padding: '11px 12px', borderRadius: 12, border: '1px solid var(--bdr)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit' }}>
                {weeks.map(w => <option key={w} value={w}>{fromWords(w)}{upcoming.some(u => u.from === w) ? ' (already set)' : ''}</option>)}
              </select>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--t4)', marginTop: 5, lineHeight: 1.5 }}>It applies from that week until the next week you set. Weeks already on the rota cannot be changed here.</span>
            </label>
          ) : availability?.words && <div style={{ fontSize: 11.5, color: 'var(--amber)', fontWeight: 700, lineHeight: 1.5, marginBottom: 6 }}>{availability.words}</div>}
          {DAYS.map((d, i) => (
            <div key={d} style={{ padding: '7px 0', borderTop: i ? '1px solid var(--bdr)' : 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ flex: '1 0 84px', fontSize: 13, fontWeight: 600 }}>{d}</span>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {states.map(([k, lbl]) => (
                    <button key={k} onClick={() => pick(i, k)}
                      style={{ ...small, padding: '5px 9px', fontSize: 11, background: days[i].state === k ? AV_COLOR[k] : 'transparent', color: days[i].state === k ? '#fff' : 'var(--t2)', border: days[i].state === k ? '1px solid transparent' : '1px solid var(--bdr)' }}>{lbl}</button>
                  ))}
                </div>
              </div>
              {days[i].state === 'partial' && (
                <select value={days[i].note || ''} onChange={e => setDay(i, { note: e.target.value })} aria-label={`${d}: which part of the day`}
                  style={{ width: '100%', marginTop: 6, padding: '9px 12px', borderRadius: 10, border: '1px solid var(--bdr)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 15, fontFamily: 'inherit' }}>
                  {options.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
              )}
            </div>
          ))}
          <ErrLine>{err}</ErrLine>
          <button onClick={save} disabled={busy} style={{ ...solid, width: '100%', padding: '12px 14px', fontSize: 14, marginTop: 8, opacity: busy ? 0.6 : 1 }}>{busy ? 'Saving…' : 'Save availability'}</button>
          <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 8, lineHeight: 1.6 }}>
            <b style={{ color: 'var(--acc)' }}>Available</b>: any time that day. <b style={{ color: 'var(--pur)' }}>Preferred</b>: you would like to work that day.{options.length > 0 && <> <b style={{ color: 'var(--amber)' }}>Part day</b>: you can work some of it, pick when.</>} <b style={{ color: 'var(--red)' }}>Unavailable</b>: you cannot work, and cannot claim open shifts that day.
          </div>
        </div>
      )}
    </div>
  );
}
