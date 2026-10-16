// src/surfaces/bookings/GuestMessages.jsx
//
// The Inspector's Messages section (16 Oct 2026): what the guest was sent and when, by text and
// email (confirmation, the day before and 2 hour reminders, change and cancel messages, the
// pre-order link), what failed and why, and the guest's own change and cancel link to copy or
// send again. Shared by the host stand Inspector and Back Office (the Inspector is exported).
//
// Reads booking_reminders (paired stands may read it from migration 20261016c; Back Office
// logins could already). Times on the venue clock. A failed read says so, never "nothing sent".

import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { fmtClock, venueToday } from '../../lib/bookings/editRules.js';
import { lookupPreorderLinkBase } from '../../lib/bookings/bookingsData.js';
import { loadGuestMessages, loadManageToken, messageLine, sendConfirmation, confirmResultWords, hasGuestContact } from '../../lib/bookings/guestMessages.js';

const TONE = { ok: 'var(--grn)', bad: 'var(--red)', wait: 'var(--orn)' };

export default function GuestMessages({ b, sec }) {
  const showToast = useStore((s) => s.showToast);
  const venueTz = useStore((s) => s.locationConfig?.timezone);
  // link: worked out before any tap, so "Copy guest link" writes to the clipboard at once (an
  // iPad only allows a clipboard write while the tap is still in progress, not after a network
  // read). base: false = read, no venue web address set.
  const [state, setState] = useState({ id: null, rows: null, token: null, base: null });
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([loadGuestMessages(b.id), loadManageToken(b.id), lookupPreorderLinkBase(b.locationId).catch(() => null)])
      .then(([rows, token, base]) => {
        if (alive) setState({ id: b.id, rows, token, base: base || false });
      });
    return () => { alive = false; };
  }, [b.id, b.locationId, nonce]);

  const ready = state.id === b.id;
  const rows = ready ? state.rows : undefined;
  // A guest record (customerId) may carry the phone or email the booking itself does not: the
  // messages use it, so it counts as a way to reach the guest (one rule, guestMessageWords.js).
  const hasContact = hasGuestContact(b);
  const live = ['confirmed', 'prepaid'].includes(b.status);
  const upcoming = !!b.date && b.date >= venueToday(venueTz);
  const link = ready && state.token && state.base ? `${state.base}/book?manage=${state.token}` : null;
  if (b.source === 'walk_in' && !(rows && rows.length)) return null;

  const clock = fmtClock(venueTz);
  // A day word when the message was not sent today on the venue clock.
  const fmtWhen = (d) => {
    const day = new Intl.DateTimeFormat('en-GB', { timeZone: venueTz || undefined, day: 'numeric', month: 'short' }).format(d);
    const today = new Intl.DateTimeFormat('en-GB', { timeZone: venueTz || undefined, day: 'numeric', month: 'short' }).format(new Date());
    return day === today ? clock(d) : `${day} ${clock(d)}`;
  };

  // No await before the clipboard write: the link was worked out when the section opened.
  const copyLink = () => {
    if (!ready) { showToast?.('Still loading the guest link. Try again in a moment.', 'info'); return; }
    if (!state.token) { showToast?.('This booking has no guest link yet. It arrives with the bookings update (migration 20261016c).', 'info'); return; }
    if (!link) { showToast?.('No venue web address set (Back Office, Location settings), so there is no link to copy.', 'error'); return; }
    let write;
    try { write = navigator.clipboard.writeText(link); } catch (e) { write = Promise.reject(e); }
    Promise.resolve(write).then(
      () => showToast?.('Guest link copied. The guest can change or cancel with it.', 'success'),
      () => showToast?.('This device would not copy the link. Open the booking in Back Office to copy it.', 'info'),
    );
  };

  // 17 Oct 2026 (v5.11.73): waits for the answer and says what really went, by text and by email.
  // It used to fire and say "Asked to send" whatever happened, and sent nothing at all when the
  // phone or email was only on the guest's record.
  const resend = async () => {
    if (busy) return;
    setBusy(true);
    const res = await sendConfirmation({ ...b, status: b.status || 'confirmed' });
    const said = confirmResultWords(res);
    showToast?.(said.text, said.tone);
    setBusy(false);
    setNonce((x) => x + 1);
  };

  return (
    <div style={sec}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 9 }}>Messages to the guest</div>
      {!hasContact && (
        <div style={{ fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.45 }}>No phone or email on this booking, so nothing is sent.</div>
      )}
      {hasContact && rows === undefined && <div style={{ fontSize: 12.5, color: 'var(--t4)' }}>Checking what was sent</div>}
      {hasContact && rows === null && <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>Could not read the messages from here.</div>}
      {hasContact && rows && rows.length === 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.45 }}>
          {live && upcoming
            ? 'No confirmation has gone to this guest yet. Tap Send confirmation to send it now. Reminders go the day before and 2 hours before.'
            : 'Nothing was sent to this guest.'}
        </div>
      )}
      {rows && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((r) => {
            const line = messageLine(r, fmtWhen);
            return (
              <div key={`${r.kind}-${r.channel}`} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <span style={{ width: 7, height: 7, borderRadius: 999, background: TONE[line.tone], marginTop: 5, flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700 }}>{line.title}</div>
                  <div style={{ fontSize: 12, color: line.tone === 'bad' ? 'var(--red)' : 'var(--t3)', lineHeight: 1.4 }}>{line.text}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {hasContact && (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn btn-ghost" onClick={copyLink} style={{ flex: 1, minWidth: 0, height: 34, fontSize: 11.5, fontWeight: 700 }}>Copy guest link</button>
          {live && upcoming && rows && !rows.some((r) => r.kind === 'confirmation') && (
            <button className="btn btn-ghost" onClick={resend} disabled={busy} style={{ flex: 1, minWidth: 0, height: 34, fontSize: 11.5, fontWeight: 700 }}>
              {busy ? 'Sending' : 'Send confirmation'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
