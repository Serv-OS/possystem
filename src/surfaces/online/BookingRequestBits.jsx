// src/surfaces/online/BookingRequestBits.jsx
//
// Two booking page pieces for the host tools (16 Oct 2026, v5.11.70):
//
//   LargePartyRequest  "Larger party? Send a request": a party above the
//                      venue's online limit sends its date, time, size and
//                      contact details to the host stand's Requests inbox
//                      (booking-widget action 'request'). Nothing is booked.
//   PayLinkPage        the page behind a pay link the host stand texted
//                      (?pay=<booking id>&t=<token>): the booking, what it
//                      owes, and the same card form an online booking uses.
//
// Both talk to booking-widget only, like the rest of the booking page.

import { useEffect, useState } from 'react';
import { supabase, ensureAuthToken, isMock } from '../../lib/supabase';

async function callWidget(body) {
  if (!supabase) return { ok: false, error: 'offline' };
  try {
    const { data, error } = await supabase.functions.invoke('booking-widget', { body });
    if (error) return { ok: false, error: error.message || 'network' };
    return data || { ok: false, error: 'empty' };
  } catch (e) {
    return { ok: false, error: e?.message || 'network' };
  }
}

const sayDate = (iso) => {
  try { return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); } catch { return iso; }
};

export function LargePartyRequest({ opsId, venueName, minParty = 13, date, today, maxDate, name: name0 = '', phone: phone0 = '', email: email0 = '', brand, onBrand, styles: S, onClose }) {
  const [party, setParty] = useState(minParty);
  const [day, setDay] = useState(date || today);
  const [time, setTime] = useState('19:00');
  const [name, setName] = useState(name0);
  const [phone, setPhone] = useState(phone0);
  const [email, setEmail] = useState(email0);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');

  const send = async () => {
    if (busy) return;
    if (!name.trim() || String(phone).replace(/\D/g, '').length < 7) { setErr('Add your name and a mobile number so the venue can reply.'); return; }
    setBusy(true); setErr('');
    const r = await callWidget({ action: 'request', location_id: opsId, date: day, time, party, name: name.trim(), phone, email: email.trim() || undefined, note: note.trim() || undefined });
    setBusy(false);
    if (r?.ok) { setDone(true); return; }
    setErr(r?.error === 'too_many_requests' ? 'Lots of requests right now. Please try again in a few minutes, or call the venue.' : 'The request did not send. Please try again, or call the venue.');
  };

  const box = { marginTop: 4, padding: '14px 16px', borderRadius: 12, border: '1px solid var(--line)', background: 'var(--card)' };
  if (done) {
    return (
      <div style={box} role="status">
        <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--ink)' }}>Request sent</div>
        <div style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.55, marginTop: 4 }}>
          {venueName} has your request for {party} guests on {sayDate(day)} at {time}. They will call or text you to confirm. Nothing is booked yet.
        </div>
        <button type="button" onClick={onClose} style={{ ...S.linkBtn, fontSize: 13, marginTop: 8 }}>Close</button>
      </div>
    );
  }
  return (
    <div style={box}>
      <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--ink)' }}>Send a request for a larger party</div>
      <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5, marginTop: 2, marginBottom: 10 }}>The venue checks the tables and gets back to you.</div>
      {/* Guests on its own row: three date and time boxes side by side overflow a phone. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 8, marginBottom: 8 }}>
        <label style={{ fontSize: 12, color: 'var(--muted)', minWidth: 0, gridColumn: '1 / -1' }}>Guests
          <input type="number" min={minParty} max={200} value={party} onChange={(e) => setParty(Math.max(1, Math.min(200, Math.round(Number(e.target.value) || minParty))))} style={{ ...S.input, marginTop: 4 }} />
        </label>
        <label style={{ fontSize: 12, color: 'var(--muted)', minWidth: 0 }}>Date
          <input type="date" value={day} min={today} max={maxDate} onChange={(e) => { if (e.target.value) setDay(e.target.value); }} style={{ ...S.input, marginTop: 4, width: '100%', minWidth: 0, boxSizing: 'border-box' }} />
        </label>
        <label style={{ fontSize: 12, color: 'var(--muted)', minWidth: 0 }}>Time
          <input type="time" value={time} step={900} onChange={(e) => setTime(e.target.value)} style={{ ...S.input, marginTop: 4, width: '100%', minWidth: 0, boxSizing: 'border-box' }} />
        </label>
      </div>
      <div style={{ display: 'grid', gap: 8 }}>
        <input style={S.input} placeholder="Full name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
        <input style={S.input} placeholder="Mobile number" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        <input style={S.input} placeholder="Email (optional)" type="email" inputMode="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input style={S.input} placeholder="Occasion, allergies, anything else (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {err && <div role="alert" style={{ marginTop: 8, fontSize: 13, fontWeight: 600, color: '#b91c1c' }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" onClick={onClose} style={{ flex: 1, height: 44, borderRadius: 11, border: '1px solid var(--line)', background: 'var(--card)', color: 'var(--ink)', fontWeight: 700, fontFamily: 'inherit', cursor: 'pointer' }}>Back</button>
        <button type="button" onClick={send} disabled={busy} style={{ flex: 2, height: 44, borderRadius: 11, border: 'none', background: brand, color: onBrand, fontWeight: 800, fontFamily: 'inherit', cursor: 'pointer', opacity: busy ? 0.6 : 1 }}>
          {busy ? 'Sending…' : 'Send request'}
        </button>
      </div>
    </div>
  );
}

const fmtAmount = (minor, currency) => {
  const cur = String(currency || 'GBP').toUpperCase();
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format((Number(minor) || 0) / 100); } catch { return `${cur} ${((Number(minor) || 0) / 100).toFixed(2)}`; }
};

export function PayLinkPage({ bookingId, token, opsId, venueName, shell, shellComponent, paymentCard, styles: S, brand, onBrand }) {
  const Shell = shellComponent;
  const PaymentCard = paymentCard;
  const [info, setInfo] = useState(null);
  const [paid, setPaid] = useState(false);
  useEffect(() => {
    let off = false;
    (async () => {
      try { await ensureAuthToken(); } catch { /* anon best effort, the fn is public */ }
      const r = await callWidget({ action: 'pay_info', location_id: opsId, booking_id: bookingId, pay_token: token });
      if (!off) setInfo(r || { ok: false });
    })();
    return () => { off = true; };
  }, [bookingId, token, opsId]);

  const card = { ...S.card, textAlign: 'center', padding: '34px 22px' };
  const b = info?.booking || null;
  const line = b ? `${sayDate(b.date)} · ${b.time} · ${b.party} ${Number(b.party) === 1 ? 'guest' : 'guests'}` : '';
  if (!info) return <Shell {...shell}><div style={card}><div style={{ color: 'var(--muted)', fontSize: 14 }}>Loading your booking…</div></div></Shell>;
  if (paid || info.paid) {
    return (
      <Shell {...shell}>
        <div style={card}>
          <div aria-hidden style={{ width: 64, height: 64, borderRadius: '50%', margin: '0 auto 16px', background: brand, color: onBrand, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 34, fontWeight: 800 }}>✓</div>
          <div style={S.h1}>Your table at {venueName} is confirmed</div>
          {line && <div style={{ fontSize: 15, fontWeight: 700, margin: '12px 0 4px', color: 'var(--ink)' }}>{line}</div>}
          <div style={S.sub}>Thank you. Just give your name when you arrive.</div>
        </div>
      </Shell>
    );
  }
  if (!info.ok) {
    const why = (info.error === 'bad_link' || info.error === 'unknown_booking') ? 'This payment link is not valid. Please call the venue.'
      : info.error === 'due_mismatch' ? 'This payment link is out of date. Please call the venue for a new one.'
      : info.error === 'closed' ? 'This booking is no longer waiting for payment. Please call the venue if you think that is wrong.'
      : info.error === 'nothing_due' ? 'There is nothing to pay on this booking.'
      : info.error === 'payment_unavailable' ? 'Card payments are not available right now. Please call the venue.'
      : 'We could not load this booking. Please try again, or call the venue.';
    return <Shell {...shell}><div style={card}><div style={S.h1}>Payment link</div><div style={S.sub}>{why}</div></div></Shell>;
  }
  const kind = info.paymentDue?.kind;
  return (
    <Shell {...shell}>
      <div style={card}>
        <div style={{ fontSize: 38, marginBottom: 10 }}>💳</div>
        <div style={S.h1}>{kind === 'hold' ? 'Save a card to hold your table' : `Pay ${fmtAmount(info.paymentDue?.amountMinor, info.paymentDue?.currency)} to confirm your table`}</div>
        <div style={{ fontSize: 15, fontWeight: 700, margin: '12px 0 4px', color: 'var(--ink)' }}>{line}</div>
        {b?.packageName && <div style={{ fontSize: 13.5, color: 'var(--muted)', marginBottom: 12 }}>{b.packageName}</div>}
        {!isMock && supabase ? (
          <PaymentCard paymentDue={info.paymentDue} adyen={info.adyen} bookingId={bookingId} opsId={opsId} venueName={venueName}
            required payToken={token}
            heldNote={kind === 'hold' ? 'Nothing is taken today. The venue keeps your table once the card is saved.' : 'Your table is held while you pay. The booking confirms once payment goes through.'}
            onPaid={(status) => { if (status === 'confirmed' || status === 'prepaid') setPaid(true); }} />
        ) : (
          <div style={S.sub}>Payments cannot run on this preview.</div>
        )}
      </div>
    </Shell>
  );
}
