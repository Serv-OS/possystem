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
import { fmtClock } from '../../lib/bookings/editRules.js';
import { lookupPreorderLinkBase } from '../../lib/bookings/bookingsData.js';
import { loadGuestMessages, loadManageToken, messageLine, nudgeConfirmation } from '../../lib/bookings/guestMessages.js';

const TONE = { ok: 'var(--grn)', bad: 'var(--red)', wait: 'var(--orn)' };

export default function GuestMessages({ b, sec }) {
  const showToast = useStore((s) => s.showToast);
  const venueTz = useStore((s) => s.locationConfig?.timezone);
  const [state, setState] = useState({ id: null, rows: null, token: null });
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([loadGuestMessages(b.id), loadManageToken(b.id)]).then(([rows, token]) => {
      if (alive) setState({ id: b.id, rows, token });
    });
    return () => { alive = false; };
  }, [b.id, nonce]);

  const ready = state.id === b.id;
  const rows = ready ? state.rows : undefined;
  const hasContact = !!(String(b.customer?.phone || '').trim() || String(b.customer?.email || '').trim());
  if (b.source === 'walk_in' && !(rows && rows.length)) return null;

  const clock = fmtClock(venueTz);
  // A day word when the message was not sent today on the venue clock.
  const fmtWhen = (d) => {
    const day = new Intl.DateTimeFormat('en-GB', { timeZone: venueTz || undefined, day: 'numeric', month: 'short' }).format(d);
    const today = new Intl.DateTimeFormat('en-GB', { timeZone: venueTz || undefined, day: 'numeric', month: 'short' }).format(new Date());
    return day === today ? clock(d) : `${day} ${clock(d)}`;
  };

  const copyLink = async () => {
    if (!state.token) { showToast?.('This booking has no guest link yet. It arrives with the bookings update (migration 20261016c).', 'info'); return; }
    const base = await lookupPreorderLinkBase(b.locationId);
    if (!base) { showToast?.('No venue web address set (Back Office, Location settings), so there is no link to copy.', 'error'); return; }
    const link = `${base}/book?manage=${state.token}`;
    try { await navigator.clipboard.writeText(link); showToast?.('Guest link copied. The guest can change or cancel with it.', 'success'); }
    catch { showToast?.(`Could not copy. The link is ${link}`, 'info'); }
  };

  const resend = async () => {
    if (busy) return;
    setBusy(true);
    nudgeConfirmation({ ...b, status: b.status || 'confirmed' });
    showToast?.('Asked to send the confirmation. A guest who already has it is not sent it twice.', 'info');
    setTimeout(() => { setBusy(false); setNonce((x) => x + 1); }, 2500);
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
        <div style={{ fontSize: 12.5, color: 'var(--t3)', lineHeight: 1.45 }}>Nothing sent yet. The confirmation goes within 5 minutes of booking, a reminder the day before and 2 hours before.</div>
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
          {['confirmed', 'prepaid'].includes(b.status) && rows && !rows.some((r) => r.kind === 'confirmation') && (
            <button className="btn btn-ghost" onClick={resend} disabled={busy} style={{ flex: 1, minWidth: 0, height: 34, fontSize: 11.5, fontWeight: 700 }}>
              {busy ? 'Sending' : 'Send confirmation'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
