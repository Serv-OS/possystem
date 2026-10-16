// src/surfaces/online/ManageBookingPage.jsx
//
// The guest's own booking page (16 Oct 2026): https://<venue>.<root>/book?manage=<token>.
// The link is in every booking text and email, and on the Booked screen. The guest sees their
// booking, adds it to their calendar, changes the date, time or party, or cancels it.
//
// This page only talks to the booking-widget function (manage_info, manage_slots,
// manage_change, manage_cancel); the token is the only thing it sends. Every rule (the venue's
// cancellation window, money already paid, a paid booking that would need a top up, the
// venue's switch) is decided there, and every refusal comes back in words, which this page
// shows as they are. BookingWidget.jsx renders it inside its venue branded Shell.

import { useEffect, useState } from 'react';
import { supabase, ensureAuthToken } from '../../lib/supabase';

const MONO = 'var(--font-mono, ui-monospace, monospace)';

async function callManage(body) {
  if (!supabase) return { ok: false, error: 'offline', message: 'This page cannot reach the venue right now. Please try again later.' };
  try {
    const { data, error } = await supabase.functions.invoke('booking-widget', { body });
    if (error) return { ok: false, error: 'network', message: 'We could not reach the venue just now. Please try again in a minute.' };
    return data || { ok: false, error: 'empty', message: 'Something went wrong. Please try again.' };
  } catch {
    return { ok: false, error: 'network', message: 'We could not reach the venue just now. Please try again in a minute.' };
  }
}

const card = {
  background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 16,
  padding: '22px 18px', boxShadow: '0 1px 2px rgba(36,31,28,.04)', marginBottom: 14,
};
const lbl = { fontSize: 11, fontWeight: 700, color: 'var(--muted)', letterSpacing: '.06em', textTransform: 'uppercase', marginBottom: 8 };
const input = {
  width: '100%', boxSizing: 'border-box', height: 44, borderRadius: 11, border: '1px solid var(--line)',
  background: 'var(--card)', color: 'var(--ink)', padding: '0 14px', fontSize: 15, fontFamily: 'inherit', outline: 'none',
};
const addDays = (iso, n) => {
  const t = Date.parse(`${iso}T12:00:00Z`);
  return Number.isNaN(t) ? iso : new Date(t + n * 86400000).toISOString().slice(0, 10);
};
const dateWords = (iso) => {
  const t = Date.parse(`${iso}T12:00:00Z`);
  return Number.isNaN(t) ? iso : new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(t));
};
const toldLine = (told) => {
  if (!told) return null;
  if (told.sms && told.email) return 'We have sent you a text and an email.';
  if (told.sms) return 'We have sent you a text.';
  if (told.email) return 'We have sent you an email.';
  return null;
};

export default function ManageBookingPage({ token, brand, onBrand }) {
  const [nonce, setNonce] = useState(0);
  const infoKey = `${token}|${nonce}`;
  const [infoRes, setInfoRes] = useState(null);   // { key, info }
  const [override, setOverride] = useState(null); // the booking as a change or cancel returned it
  const loading = !override && (!infoRes || infoRes.key !== infoKey);
  const info = override || (!loading ? infoRes.info : null);

  const [mode, setMode] = useState('summary');    // 'summary' | 'change' | 'cancel'
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);         // words after a change or cancel

  // The change form. Untouched fields fall back to the booking (derived, never synced).
  const [pDate, setPDate] = useState(null);
  const [pParty, setPParty] = useState(null);
  const [pTime, setPTime] = useState(null);
  const date = pDate || info?.date || '';
  const party = pParty || info?.party || 2;
  const [slotsNonce, setSlotsNonce] = useState(0);
  const slotsKey = `${date}|${party}|${slotsNonce}`;
  const [slotsRes, setSlotsRes] = useState(null); // { key, slots, message }
  const slotsLoading = mode === 'change' && (!slotsRes || slotsRes.key !== slotsKey);

  useEffect(() => {
    let off = false;
    const key = `${token}|${nonce}`;
    (async () => {
      try { await ensureAuthToken(); } catch { /* the function is public */ }
      const r = await callManage({ action: 'manage_info', token });
      if (!off) setInfoRes({ key, info: r });
    })();
    return () => { off = true; };
  }, [token, nonce]);

  useEffect(() => {
    if (mode !== 'change' || !date) return undefined;
    let off = false;
    const key = `${date}|${party}|${slotsNonce}`;
    (async () => {
      const r = await callManage({ action: 'manage_slots', token, date, party });
      if (off) return;
      setSlotsRes({ key, slots: r?.ok && Array.isArray(r.slots) ? r.slots : [], message: r?.ok ? (r.message || '') : (r?.message || 'We could not load times. Please try again.') });
    })();
    return () => { off = true; };
  }, [mode, token, date, party, slotsNonce]);

  if (loading) {
    return <div style={card}><div style={{ textAlign: 'center', padding: '30px 0', color: 'var(--muted)', fontSize: 14 }}>Loading your booking</div></div>;
  }
  if (!info?.ok) {
    return (
      <div style={{ ...card, textAlign: 'center', padding: '30px 22px' }}>
        <div style={{ fontSize: 18, fontWeight: 800, color: 'var(--ink)', marginBottom: 8 }}>We could not open this booking</div>
        <div style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.6 }}>{info?.message || 'Please check the link in your message.'}</div>
        {(info?.error === 'network' || info?.error === 'lookup_failed') && (
          <button type="button" onClick={() => setNonce((n) => n + 1)} style={{ marginTop: 14, ...ghostBtn }}>Try again</button>
        )}
      </div>
    );
  }

  const slots = (!slotsLoading && slotsRes?.slots) || [];
  const slotsMsg = !slotsLoading ? (slotsRes?.message || '') : '';
  const time = pTime && slots.some((s) => s.time === pTime && !s.full) ? pTime : null;
  const partyOptions = Array.from({ length: Math.max(info.maxCovers || 12, info.party || 1) - (info.minCovers || 1) + 1 }, (_, i) => (info.minCovers || 1) + i);
  const btn = {
    width: '100%', height: 48, borderRadius: 12, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
    fontSize: 15, fontWeight: 800, background: brand, color: onBrand,
  };
  const status = info.view === 'cancelled' ? 'Cancelled' : info.view === 'awaiting_payment' ? 'Waiting for payment' : info.view === 'closed' ? 'Finished' : 'Booked';

  // iPhone and iPad: a download link puts booking.ics in Files. Opening the event instead goes
  // straight to Safari's Add to Calendar sheet. Desktop and Android keep the download.
  const downloadIcs = () => {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent || '')
      || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
    if (ios) {
      window.location.href = `data:text/calendar;charset=utf-8,${encodeURIComponent(info.calendar.ics)}`;
      return;
    }
    try {
      const blob = new Blob([info.calendar.ics], { type: 'text/calendar;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'booking.ics';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch { /* the Google link still works */ }
  };

  const saveChange = async () => {
    if (!time || busy) return;
    setBusy(true); setErr('');
    const r = await callManage({ action: 'manage_change', token, date, time, party });
    setBusy(false);
    if (!r?.ok) {
      setErr(r?.message || 'We could not change your booking. Please try again.');
      if (r?.error === 'slot_gone' || r?.error === 'slot_full') { setPTime(null); setSlotsNonce((n) => n + 1); }
      return;
    }
    setOverride(r);
    setSlotsRes(null);   // the next visit to the form loads fresh times, never this old reply
    setMode('summary'); setPDate(null); setPParty(null); setPTime(null);
    setDone(r.unchanged ? 'Nothing changed.' : ['Your booking is changed.', r.moneyNote, toldLine(r.told)].filter(Boolean).join(' '));
  };

  const confirmCancel = async () => {
    if (busy) return;
    setBusy(true); setErr('');
    const r = await callManage({ action: 'manage_cancel', token });
    setBusy(false);
    if (!r?.ok) { setErr(r?.message || 'We could not cancel your booking. Please try again.'); return; }
    setOverride(r);
    setMode('summary');
    setDone(['Your booking is cancelled.', info.cancelNote && !/Nothing was taken/.test(info.cancelNote) ? info.cancelNote : null, toldLine(r.told)].filter(Boolean).join(' '));
  };

  return (
    <div>
      {done && (
        <div role="status" style={{ ...card, padding: '14px 16px', border: `1.5px solid ${brand}`, background: `${brand}14`, fontSize: 14, fontWeight: 700, color: 'var(--ink)', lineHeight: 1.5 }}>
          {done}
        </div>
      )}

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: 'var(--ink)', letterSpacing: '-.01em' }}>
            {info.guestName ? `${info.guestName}, your booking` : 'Your booking'}
          </div>
          <span style={{
            fontSize: 11, fontWeight: 800, padding: '4px 10px', borderRadius: 999, whiteSpace: 'nowrap',
            background: info.view === 'cancelled' ? 'rgba(220,38,38,.1)' : `${brand}1f`,
            color: info.view === 'cancelled' ? '#b91c1c' : 'var(--ink)',
          }}>{status}</span>
        </div>
        <div style={{ fontFamily: MONO, fontSize: 15, fontWeight: 700, color: 'var(--ink)', margin: '12px 0 4px' }}>
          {info.dateWords || dateWords(info.date)} · {info.time} · {info.party} {info.party === 1 ? 'guest' : 'guests'}
        </div>
        <div style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.6 }}>
          {info.venue}{info.address ? `, ${info.address}` : ''}
        </div>
        {info.packageName && <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--ink)', marginTop: 8 }}>{info.packageName}</div>}
        {info.paidLine && <div style={{ fontSize: 13, fontWeight: 700, color: '#15803d', marginTop: 4 }}>{info.paidLine}</div>}
        {info.phone && (
          <a href={`tel:${String(info.phone).replace(/[^\d+]/g, '')}`} style={{ display: 'inline-block', marginTop: 10, fontSize: 14, fontWeight: 700, color: brand, textDecoration: 'none' }}>
            Call {info.venue}: {info.phone}
          </a>
        )}

        {info.view !== 'cancelled' && info.view !== 'closed' && info.calendar?.google && (
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <a href={info.calendar.google} target="_blank" rel="noopener noreferrer" style={{ ...ghostBtn, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>Add to Google Calendar</a>
            {info.calendar.ics && <button type="button" onClick={downloadIcs} style={ghostBtn}>Apple or Outlook calendar</button>}
          </div>
        )}

        {info.why && (
          <div style={{ marginTop: 14, padding: '10px 12px', borderRadius: 10, background: 'rgba(0,0,0,.04)', fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.5 }}>
            {info.why}
          </div>
        )}
      </div>

      {mode === 'summary' && (info.canChange || info.canCancel) && (
        <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {info.canChange && (
            <button type="button" style={btn} onClick={() => { setSlotsRes(null); setMode('change'); setErr(''); setDone(null); }}>Change date, time or guests</button>
          )}
          {info.canCancel && (
            <button type="button" style={{ ...btn, background: 'transparent', color: '#b91c1c', border: '1.5px solid rgba(185,28,28,.5)' }}
              onClick={() => { setMode('cancel'); setErr(''); setDone(null); }}>Cancel booking</button>
          )}
          {/* Only for a booking that can be changed: one still waiting for payment can be cancelled
              right up to its time (nothing was paid), so the window line would be wrong there. */}
          {info.windowHours > 0 && info.canChange && (
            <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5, textAlign: 'center' }}>
              You can change or cancel online until {info.windowHours} {info.windowHours === 1 ? 'hour' : 'hours'} before your booking.
            </div>
          )}
        </div>
      )}

      {mode === 'cancel' && (
        <div style={card}>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--ink)', marginBottom: 6 }}>Cancel this booking?</div>
          <div style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 14 }}>
            The table will be released for other guests.{info.cancelNote ? ` ${info.cancelNote}` : ''}
          </div>
          <button type="button" disabled={busy} onClick={confirmCancel}
            style={{ ...btn, background: '#b91c1c', color: '#fff', opacity: busy ? 0.6 : 1 }}>
            {busy ? 'Cancelling' : 'Yes, cancel my booking'}
          </button>
          <button type="button" disabled={busy} onClick={() => setMode('summary')} style={{ ...ghostBtn, width: '100%', marginTop: 10, height: 44 }}>Keep my booking</button>
          {err && <div role="alert" style={errBox}>{err}</div>}
        </div>
      )}

      {mode === 'change' && (
        <div style={card}>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--ink)', marginBottom: 14 }}>Change your booking</div>

          <div style={lbl}>Guests</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
            {partyOptions.map((n) => {
              const on = party === n;
              return (
                <button key={n} type="button" aria-pressed={on} onClick={() => { setPParty(n); setPTime(null); setErr(''); }}
                  style={{
                    minWidth: 44, height: 44, padding: '0 8px', borderRadius: 11, fontSize: 15, fontWeight: 800,
                    cursor: 'pointer', fontFamily: 'inherit',
                    border: on ? `1.5px solid ${brand}` : '1px solid var(--line)',
                    background: on ? brand : 'var(--card)', color: on ? onBrand : 'var(--ink)',
                  }}>{n}</button>
              );
            })}
          </div>

          <div style={lbl}>Date</div>
          <input type="date" aria-label="New date" value={date} min={info.today} max={addDays(info.today, info.maxDaysAhead || 90)}
            onChange={(e) => { if (e.target.value) { setPDate(e.target.value); setPTime(null); setErr(''); } }}
            style={{ ...input, marginBottom: 18 }} />

          <div style={lbl}>Times</div>
          {slotsLoading ? (
            <div style={{ padding: '14px 0', fontSize: 13, color: 'var(--muted)' }}>Loading times</div>
          ) : slotsMsg && !slots.length ? (
            <div style={{ padding: '10px 0', fontSize: 13.5, color: 'var(--ink)', lineHeight: 1.5 }}>{slotsMsg}</div>
          ) : slots.length === 0 ? (
            <div style={{ padding: '10px 0', fontSize: 13, color: 'var(--muted)' }}>No times on this date. Try another day.</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
              {slots.map((s) => {
                const on = time === s.time;
                const full = s.full && !s.current;
                return (
                  <button key={s.time} type="button" disabled={full} aria-pressed={on}
                    onClick={() => { setPTime(s.time); setErr(''); }}
                    style={{
                      padding: '12px 2px', borderRadius: 10, textAlign: 'center', fontSize: 13, fontWeight: 700, fontFamily: MONO,
                      cursor: full ? 'default' : 'pointer',
                      border: on ? `1.5px solid ${brand}` : s.current ? '1.5px dashed var(--line)' : '1px solid var(--line)',
                      background: on ? `${brand}1f` : full ? 'transparent' : 'var(--card)',
                      color: on ? brand : full ? 'var(--muted)' : 'var(--ink)',
                      opacity: full ? 0.55 : 1,
                    }}>{s.time}</button>
                );
              })}
            </div>
          )}
          {slots.some((s) => s.current) && (
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 8 }}>The dashed time is your booking now.</div>
          )}

          <button type="button" disabled={!time || busy} onClick={saveChange}
            style={{ ...btn, marginTop: 18, opacity: !time || busy ? 0.5 : 1, cursor: !time || busy ? 'default' : 'pointer' }}>
            {busy ? 'Saving' : time ? `Move to ${dateWords(date)} at ${time}, ${party} ${party === 1 ? 'guest' : 'guests'}` : 'Pick a time'}
          </button>
          <button type="button" disabled={busy} onClick={() => { setMode('summary'); setPDate(null); setPParty(null); setPTime(null); setErr(''); }}
            style={{ ...ghostBtn, width: '100%', marginTop: 10, height: 44 }}>Keep it as it is</button>
          {err && <div role="alert" style={errBox}>{err}</div>}
        </div>
      )}
    </div>
  );
}

const ghostBtn = {
  height: 40, padding: '0 14px', borderRadius: 10, border: '1px solid var(--line)', background: 'var(--card)',
  color: 'var(--ink)', fontSize: 13.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
};
const errBox = {
  marginTop: 12, padding: '10px 12px', borderRadius: 10, background: 'rgba(220,38,38,.08)',
  color: '#b91c1c', fontSize: 13.5, fontWeight: 700, lineHeight: 1.5,
};
