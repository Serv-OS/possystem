// src/surfaces/bookings/RequestsInbox.jsx
//
// Booking requests inbox (16 Oct 2026, v5.11.70 host tools, plan item 5).
// A button on the Diary with the count of requests waiting, and a panel that
// lists them: a party too big to book online ("Larger party? Send a request"),
// or a request an older booking page left as "the venue will confirm". Each
// has Accept (booked on the server through create_booking, the guest gets the
// confirmation), Call (the guest's number) and Decline (a short text to the
// guest). It checks every 45 seconds and raises a message on the stand when a
// new one arrives, whichever screen is showing.
// Data: booking-host (requests, request_accept, request_decline).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store';
import { loadRequests, acceptRequest, declineRequest } from '../../lib/bookings/hostData.js';
import { DECLINE_DEFAULT } from '../../../supabase/functions/_shared/bookingHost.js';

const POLL_MS = 45000;
const sayDate = (d) => {
  if (!d) return 'no date given';
  try { return new Date(`${d}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }); } catch { return d; }
};

export default function RequestsInbox() {
  const showToast = useStore((s) => s.showToast);
  const operator = useStore((s) => s.bookingsOperator?.name || s.staff?.name || null);
  const venueName = useStore((s) => s.locationConfig?.name || '');
  const [res, setRes] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null);       // request id in flight
  const [decline, setDecline] = useState(null); // { id, text }
  const [note, setNote] = useState(null);       // { id, ok, text }
  const seen = useRef(null);                    // request ids already known, null before the first load

  const refresh = useCallback(async () => {
    const r = await loadRequests();
    setRes(r);
    if (!r?.ok) return;
    const ids = new Set((r.rows || []).map((x) => x.id));
    if (seen.current) {
      const fresh = (r.rows || []).filter((x) => !seen.current.has(x.id));
      if (fresh.length) {
        const f = fresh[0];
        showToast?.(fresh.length > 1 ? `${fresh.length} new booking requests` : `New booking request: ${f.name}, party of ${f.party}`, 'warning', 6000);
        try { navigator.vibrate?.([30, 60, 30]); } catch { /* no haptics */ }
      }
    }
    seen.current = ids;
  }, [showToast]);

  useEffect(() => {
    let alive = true;
    const tick = () => { if (alive) refresh(); };
    const t0 = setTimeout(tick, 0);
    const t = setInterval(tick, POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; clearTimeout(t0); clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [refresh]);

  const rows = res?.ok ? (res.rows || []) : [];
  if (res && !res.ok && res.notDeployed) return null; // nothing to show until booking-host is deployed

  const accept = async (r) => {
    setBusy(r.id); setNote(null);
    const out = await acceptRequest(r.id, { by: operator });
    setBusy(null);
    if (out?.ok) {
      setNote({ id: r.id, ok: true, text: `Booked ${r.name} on ${out.table || 'a table'} at ${out.time} on ${sayDate(out.date)}. The guest gets the confirmation.` });
      showToast?.(`Request booked: ${r.name}, ${out.time} ${sayDate(out.date)}`, 'success');
      const st = useStore.getState();
      if (!st.bookingsDate || st.bookingsDate === out.date) st.loadBookingsFromDB?.(null, st.bookingsDate || out.date);
      refresh();
      return;
    }
    setNote({ id: r.id, ok: false, text: out?.error || 'Not booked. Try again.' });
  };

  const sendDecline = async () => {
    if (!decline) return;
    const r = rows.find((x) => x.id === decline.id);
    setBusy(decline.id); setNote(null);
    const out = await declineRequest(decline.id, { message: decline.text, by: operator, sendSms: !!r?.phone });
    setBusy(null);
    if (out?.ok) {
      setDecline(null);
      showToast?.(out.sms?.sent ? 'Request declined, the guest was texted.' : `Request declined. The text did not go${out.sms?.reason ? ` (${out.sms.reason})` : ''}.`, out.sms?.sent ? 'success' : 'warning');
      refresh();
      return;
    }
    setNote({ id: decline.id, ok: false, text: out?.error || 'Not declined. Try again.' });
  };

  const count = rows.length;
  return (
    <>
      <button className="btn btn-ghost btn-xs" onClick={() => setOpen(true)}
        style={{ fontWeight: 800, display: 'inline-flex', alignItems: 'center', gap: 6, color: count ? 'var(--orn)' : undefined, borderColor: count ? 'var(--orn)' : undefined }}>
        Requests
        <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999, display: 'inline-grid', placeItems: 'center', fontSize: 10.5, fontWeight: 800,
          background: count ? 'var(--orn)' : 'var(--bg3)', color: count ? 'var(--bg)' : 'var(--t3)' }}>{count}</span>
      </button>
      {open && (
        <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 100001, background: 'rgba(8,9,12,0.5)', display: 'flex', justifyContent: 'flex-end' }}>
          <div role="dialog" aria-label="Booking requests" onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(440px, 100%)', height: '100%', overflowY: 'auto', background: 'var(--bg1)', color: 'var(--t1)', borderLeft: '1px solid var(--bdr)', padding: 16, boxSizing: 'border-box' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 17, fontWeight: 800 }}>Booking requests</div>
                <div style={{ fontSize: 12, color: 'var(--t3)' }}>Large parties and online requests waiting for an answer</div>
              </div>
              <button onClick={() => setOpen(false)} aria-label="Close" style={{ background: 'none', border: 'none', color: 'var(--t4)', cursor: 'pointer', fontSize: 18 }}>✕</button>
            </div>
            {res && !res.ok && <div role="alert" style={{ fontSize: 13, color: 'var(--red)', fontWeight: 700 }}>{res.error}</div>}
            {res?.ok && count === 0 && <div style={{ fontSize: 13, color: 'var(--t3)' }}>No requests waiting.</div>}
            {rows.map((r) => (
              <div key={r.id} style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--bg2)', border: '1px solid var(--bdr)', marginBottom: 10 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ fontSize: 15, fontWeight: 800, flex: 1, minWidth: 0 }}>{r.name}</span>
                  <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 999, color: 'var(--orn)', background: 'color-mix(in srgb, var(--orn) 12%, transparent)' }}>
                    {r.kind === 'large_party' ? 'Large party' : 'Request'}
                  </span>
                </div>
                <div style={{ fontSize: 13.5, fontWeight: 700, marginTop: 4, fontFamily: 'var(--font-mono)' }}>
                  {r.party} guests · {sayDate(r.date)}{r.time ? ` · ${r.time}` : ''}
                </div>
                {r.phone && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2, fontFamily: 'var(--font-mono)' }}>{r.phone}{r.email ? ` · ${r.email}` : ''}</div>}
                {r.note && <div style={{ fontSize: 12.5, color: 'var(--t2)', marginTop: 6, lineHeight: 1.4 }}>{r.note}</div>}
                {note?.id === r.id && <div role={note.ok ? 'status' : 'alert'} style={{ fontSize: 12.5, marginTop: 8, fontWeight: 700, lineHeight: 1.45, color: note.ok ? 'var(--grn)' : 'var(--red)' }}>{note.text}</div>}
                {decline?.id === r.id ? (
                  <div style={{ marginTop: 8 }}>
                    <textarea value={decline.text} onChange={(e) => setDecline({ ...decline, text: e.target.value })} aria-label="Message to the guest"
                      style={{ width: '100%', minHeight: 70, boxSizing: 'border-box', background: 'var(--bg3)', border: '1px solid var(--bdr2)', borderRadius: 9, color: 'var(--t1)', padding: 8, fontFamily: 'inherit', fontSize: 13 }} />
                    <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 2 }}>{r.phone ? 'Texted to the guest.' : 'No mobile on the request, so nothing is texted.'}</div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                      <button className="btn btn-ghost" onClick={() => setDecline(null)} disabled={busy === r.id} style={{ flex: 1, height: 40 }}>Back</button>
                      <button className="btn btn-red" onClick={sendDecline} disabled={busy === r.id} style={{ flex: 2, height: 40, fontWeight: 800 }}>{busy === r.id ? 'Sending…' : 'Decline'}</button>
                    </div>
                  </div>
                ) : (
                  <>
                  {/* A tablet has no hover, so the reason Accept is grey is written out. */}
                  {(!r.time || !r.date) && (
                    <div style={{ fontSize: 12, color: 'var(--orn)', marginTop: 6, fontWeight: 700, lineHeight: 1.4 }}>
                      No {r.date ? 'time' : 'date'} on this request. Call the guest, then book it on the Book screen.
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button className="btn btn-acc" onClick={() => accept(r)} disabled={busy === r.id || !r.date || !r.time} title={!r.time ? 'No time on the request: call the guest' : undefined}
                      style={{ flex: 2, height: 40, fontWeight: 800 }}>{busy === r.id ? 'Booking…' : 'Accept'}</button>
                    {r.phone
                      ? <a className="btn btn-ghost" href={`tel:${r.phone}`} style={{ flex: 1, height: 40, display: 'grid', placeItems: 'center', textDecoration: 'none', fontWeight: 700 }}>Call</a>
                      : <button className="btn btn-ghost" disabled style={{ flex: 1, height: 40 }}>Call</button>}
                    <button className="btn btn-ghost" onClick={() => setDecline({ id: r.id, text: DECLINE_DEFAULT(venueName) })} disabled={busy === r.id} style={{ flex: 1, height: 40 }}>Decline</button>
                  </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
