// src/surfaces/bookings/HostToolsSettings.jsx
//
// The host tools settings (16 Oct 2026, v5.11.70): the party sizes the
// booking page offers (a bigger party sends a request to the host stand's
// inbox), how many minutes late before the stand asks to release a table, and
// the venue's privacy notice linked under the booking page's consent box.
// Shown in Back Office, Table bookings. Saves through updateBookingRules like
// every other rule. The columns arrive with migration 20261016d: before it the
// section says so and nothing can be changed.

import { useState } from 'react';
import { useStore } from '../../store';
import { widgetPartyBounds, LATE_RELEASE_DEFAULT, safeLink } from '../../../supabase/functions/_shared/bookingHost.js';

const step = { width: 30, height: 30, borderRadius: 8, border: '1px solid var(--bdr2)', background: 'var(--bg2)', color: 'var(--t1)', fontSize: 16, cursor: 'pointer', fontFamily: 'inherit', lineHeight: 1, padding: 0 };

function StepRow({ label, sub, value, onChange, min, max, by = 1, fmt = (v) => v, disabled }) {
  const clamp = (v) => Math.min(max, Math.max(min, v));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--bdr)' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>{label}</div>
        {sub && <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 2, lineHeight: 1.45 }}>{sub}</div>}
      </div>
      <button style={step} disabled={disabled} onClick={() => onChange(clamp(Number(value) - by))} aria-label={`decrease ${label}`}>−</button>
      <div style={{ minWidth: 66, textAlign: 'center', fontSize: 14, fontWeight: 800, fontFamily: 'var(--font-mono)', color: 'var(--t1)' }}>{fmt(value)}</div>
      <button style={step} disabled={disabled} onClick={() => onChange(clamp(Number(value) + by))} aria-label={`increase ${label}`}>+</button>
    </div>
  );
}

export default function HostToolsSettings() {
  const bookingRules = useStore((s) => s.bookingRules);
  const updateBookingRules = useStore((s) => s.updateBookingRules);
  // A rules row read without the new columns: the database update has not run yet.
  const waiting = !!bookingRules && bookingRules.widgetMaxParty === undefined;
  const bounds = widgetPartyBounds(bookingRules || {});
  const release = Number(bookingRules?.lateReleaseMinutes) > 0 ? Number(bookingRules.lateReleaseMinutes) : LATE_RELEASE_DEFAULT;
  const [privacy, setPrivacy] = useState(null); // typed text, null = not edited
  const privacyNow = privacy ?? (bookingRules?.privacyUrl || '');
  const privacyBad = privacyNow.trim() && !safeLink(privacyNow);
  const patch = (p) => updateBookingRules?.(p);

  return (
    <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 14, marginTop: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.04em' }}>Large parties, late parties and privacy</div>
      <div style={{ fontSize: 11, color: 'var(--t4)', marginTop: 4, lineHeight: 1.4 }}>
        A party bigger than the largest online party sees &ldquo;Larger party? Send a request&rdquo; on the booking page; the request lands in the host stand&rsquo;s Requests inbox.
      </div>
      {waiting && (
        <div role="note" style={{ marginTop: 10, padding: '9px 11px', borderRadius: 9, background: 'var(--bg2)', border: '1px dashed var(--bdr2)', fontSize: 12.5, color: 'var(--t2)', lineHeight: 1.45 }}>
          These settings arrive with the database update (20261016d). Until then the booking page offers 1 to 12 guests and the stand asks after 15 minutes late.
        </div>
      )}
      <StepRow label="Largest online party" sub="Bigger parties send a request instead of booking."
        value={bounds.max} min={Math.max(2, bounds.min)} max={50} disabled={waiting}
        onChange={(v) => patch({ widgetMaxParty: v })} fmt={(v) => `${v} guests`} />
      <StepRow label="Smallest online party" sub="Usually 1. Raise it for a venue that only takes groups online."
        value={bounds.min} min={1} max={Math.min(10, bounds.max)} disabled={waiting}
        onChange={(v) => patch({ widgetMinParty: v })} fmt={(v) => `${v}`} />
      <StepRow label="Ask about a late party after" sub="The host stand shows Still waiting? with Open and Hold once a party is this late."
        value={release} min={5} max={60} by={5} disabled={waiting}
        onChange={(v) => patch({ lateReleaseMinutes: v })} fmt={(v) => `${v} min`} />
      <div style={{ padding: '10px 0' }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>Privacy notice link</div>
        <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 2, lineHeight: 1.45 }}>Shown under the booking page&rsquo;s marketing box, so guests can read how their details are used.</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <input value={privacyNow} disabled={waiting} onChange={(e) => setPrivacy(e.target.value)} placeholder="https://your-venue.co.uk/privacy"
            style={{ flex: 1, padding: '8px 10px', borderRadius: 9, border: `1px solid ${privacyBad ? 'var(--red)' : 'var(--bdr2)'}`, background: 'var(--bg2)', color: 'var(--t1)', fontFamily: 'inherit', fontSize: 13 }} />
          <button className="btn btn-ghost btn-xs" disabled={waiting || privacy === null || !!privacyBad}
            onClick={() => { patch({ privacyUrl: privacyNow.trim() || null }); setPrivacy(null); }} style={{ height: 38, padding: '0 14px' }}>Save</button>
        </div>
        {privacyBad && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 4 }}>Start the link with https://</div>}
      </div>
    </div>
  );
}
