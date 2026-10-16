// src/surfaces/bookings/LatePrompt.jsx
//
// Late party release (16 Oct 2026, v5.11.70 host tools, plan item 11). A
// booking that never arrives used to paint its table red for the whole turn
// and nothing asked the host about it. Once a party is late by the venue's
// release minutes (Rules, default 15), the Service list shows "Still
// waiting?" with Open (the booking card, where No-show frees the table) and
// Hold 15 min. The rule is lateState in supabase/functions/_shared/bookingHost.js
// (tested). Venue clock (buildScheduleCtx with the venue timezone), never the
// iPad's: a stand in California for a Leeds venue still counts Leeds minutes.

import { useEffect, useState } from 'react';
import { useStore } from '../../store';
import { buildScheduleCtx } from '../../lib/scheduleCtx.js';
import { lateState, LATE_RELEASE_DEFAULT } from '../../../supabase/functions/_shared/bookingHost.js';
import { bookingName } from './bits.jsx';

const HOLD_MIN = 15;

export default function LatePrompt({ onOpen }) {
  const bookings = useStore((s) => s.bookings) || [];
  const tables = useStore((s) => s.tables) || [];
  const bookingsDate = useStore((s) => s.bookingsDate);
  const releaseRaw = useStore((s) => s.bookingRules?.lateReleaseMinutes);
  const tz = useStore((s) => s.locationConfig?.timezone);
  const [, setTick] = useState(0);
  const [held, setHeld] = useState({}); // booking id -> venue minute the hold ends
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, []);
  const ctx = buildScheduleCtx(tz || undefined);
  if (bookingsDate && bookingsDate !== ctx.ymd) return null;
  const nowMin = ctx.nowMinutes;
  const release = Number(releaseRaw) > 0 ? Number(releaseRaw) : LATE_RELEASE_DEFAULT;
  const late = bookings
    .map((b) => ({ b, st: lateState({ booking: b, nowMin, releaseMinutes: release }) }))
    .filter((x) => x.st?.release && !(held[x.b.id] > nowMin))
    .sort((a, z) => z.st.lateBy - a.st.lateBy)
    .slice(0, 3);
  if (!late.length) return null;
  const labelOf = (id) => tables.find((t) => t.id === id)?.label || String(id).slice(-4);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
      {late.map(({ b, st }) => (
        <div key={b.id} role="status" style={{ padding: '9px 10px', borderRadius: 10, background: 'color-mix(in srgb, var(--red) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--red) 35%, transparent)' }}>
          <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--red)' }}>Still waiting? {st.lateBy} min late</div>
          <div style={{ fontSize: 12, color: 'var(--t2)', marginTop: 2, lineHeight: 1.35 }}>
            {bookingName(b)} · {b.covers} cvr · {(b.tables || []).map(labelOf).join('+')} at {String(b.startTime || '').slice(0, 5)}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button className="btn btn-ghost" onClick={() => onOpen?.(b.id)} style={{ flex: 1, height: 34, fontSize: 12, fontWeight: 800 }}>Open</button>
            <button className="btn btn-ghost" onClick={() => setHeld((h) => ({ ...h, [b.id]: nowMin + HOLD_MIN }))} style={{ flex: 1, height: 34, fontSize: 12 }}>Hold {HOLD_MIN} min</button>
          </div>
        </div>
      ))}
    </div>
  );
}
