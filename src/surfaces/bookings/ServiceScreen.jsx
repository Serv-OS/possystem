// src/surfaces/bookings/ServiceScreen.jsx
//
// The combined host view (Peter, 13 Aug, with a SevenRooms-style reference):
// "combine the diary and floor into one system so we have a live view on the
// left, the booking in the center, live floor plan". Left rail = today's
// bookings grouped Next up / Seated (click selects), centre = the live floor
// (FloorScreen embedded — POS sessions, booking-count chips, walk-in seating),
// right = the same Inspector the timeline uses. The timeline itself stays one
// click away on its own tab.

import { useMemo } from 'react';
import { useStore } from '../../store';
import { toMin } from '../../lib/bookings/optimiser.js';
import {
  mono, tintBg, rulesOf, displayStatus, statusMeta, isDead,
  useNowMin, bookingName, todayISO, preorderStateFor, useNarrowStand,
} from './bits.jsx';
import FloorScreen from './FloorScreen.jsx';
import { Inspector } from './DiaryScreen.jsx';

export default function ServiceScreen({ sel, onSelect, onBook }) {
  const narrow = useNarrowStand();
  const bookings = useStore((s) => s.bookings) || [];
  const tables = useStore((s) => s.tables) || [];
  const packages = useStore((s) => s.packages) || [];
  const bookingRules = useStore((s) => s.bookingRules);
  const bookingsDate = useStore((s) => s.bookingsDate);
  const setBookingsDate = useStore((s) => s.setBookingsDate);

  const rules = rulesOf(bookingRules);
  const isToday = !bookingsDate || bookingsDate === todayISO();
  const tick = useNowMin();
  const nowMin = isToday ? tick : null;

  const topTables = useMemo(() => tables.filter((t) => !t.parentId), [tables]);

  const live = useMemo(() => bookings.filter((b) => !isDead(b) && b.status !== 'cancelled'), [bookings]);
  const byTime = (a, b) => toMin(a.startTime) - toMin(b.startTime) || bookingName(a).localeCompare(bookingName(b));
  const nextUp = useMemo(() => live.filter((b) => b.status !== 'dining').sort(byTime), [live]);
  const seated = useMemo(() => live.filter((b) => b.status === 'dining').sort(byTime), [live]);
  const doneCount = useMemo(() => bookings.filter((b) => ['departed', 'no_show'].includes(b.status)).length, [bookings]);

  const coversBooked = live.reduce((s, b) => s + (b.covers || 0), 0);
  const coversSeated = seated.reduce((s, b) => s + (b.covers || 0), 0);

  const shiftDay = (delta) => {
    const base = bookingsDate || todayISO();
    const d = new Date(`${base}T12:00:00`);
    d.setDate(d.getDate() + delta);
    setBookingsDate?.(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  };

  const selected = bookings.find((b) => b.id === sel) || null;

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>
      {/* ── left rail: today's list ── */}
      {/* On an 11 inch stand every pixel here is taken from the floor plan, which
          is the thing the host actually reads. Narrow trims this rail back. */}
      <div style={{ width: narrow ? 208 : 264, flexShrink: 0, background: 'var(--bg1)', borderRight: '1px solid var(--bdr)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: '10px 12px 0', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn btn-ghost btn-xs" onClick={() => shiftDay(-1)} style={{ ...mono }}>‹</button>
            <span style={{ flex: 1, textAlign: 'center', fontSize: 11.5, fontWeight: 700, color: 'var(--t2)', ...mono }}>
              {bookingsDate || todayISO()}{isToday ? ' · today' : ''}
            </span>
            <button className="btn btn-ghost btn-xs" onClick={() => shiftDay(1)} style={{ ...mono }}>›</button>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <MiniKpi label="Booked" value={`${coversBooked} cvr`} />
            <MiniKpi label="Seated" value={`${coversSeated} cvr`} col="var(--acc)" />
          </div>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 10px 12px' }}>
          <GroupLabel>Next up — {nextUp.length}</GroupLabel>
          {nextUp.length === 0 && <div style={{ fontSize: 11, color: 'var(--t4)', padding: '2px 2px 6px' }}>Nothing waiting.</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {nextUp.map((b) => <Row key={b.id} b={b} sel={sel} onSelect={onSelect} nowMin={nowMin} packages={packages} tables={topTables} />)}
          </div>

          <GroupLabel>Seated — {seated.length}</GroupLabel>
          {seated.length === 0 && <div style={{ fontSize: 11, color: 'var(--t4)', padding: '2px 2px 6px' }}>No one seated yet.</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {seated.map((b) => <Row key={b.id} b={b} sel={sel} onSelect={onSelect} nowMin={nowMin} packages={packages} tables={topTables} />)}
          </div>

          {doneCount > 0 && (
            <div style={{ fontSize: 10.5, color: 'var(--t4)', margin: '12px 2px 0' }}>{doneCount} finished or no-show today</div>
          )}
        </div>

        <div style={{ padding: 10, flexShrink: 0, borderTop: '1px solid var(--bdr)' }}>
          <button className="btn btn-acc" onClick={onBook} style={{ width: '100%', height: 38, borderRadius: 10, fontWeight: 800, fontSize: 12.5 }}>
            + New booking
          </button>
        </div>
      </div>

      {/* ── centre: the live floor (walk-in panel yields to the inspector) ── */}
      <FloorScreen onPickBooking={(id) => onSelect(id)} showWalkIn={!selected} />

      {/* ── right: inspector for the selected booking ── */}
      {/* MUST match the walk-in panel's width: the two swap places on the same
          edge, so any difference resizes the floor plan under the host's finger. */}
      {selected && (
        <div style={{ width: narrow ? 262 : 330, flexShrink: 0, background: 'var(--bg1)', borderLeft: '1px solid var(--bdr)', overflowY: 'auto' }}>
          <Inspector b={selected} nowMin={nowMin} packages={packages} rules={rules} tables={topTables} onClose={() => onSelect(null)} />
        </div>
      )}
    </div>
  );
}

function Row({ b, sel, onSelect, nowMin, packages, tables }) {
  const st = displayStatus(b, nowMin, packages);
  const meta = statusMeta(st);
  const isSel = b.id === sel;
  const po = preorderStateFor(b, packages);
  const pkg = b.packageId ? packages.find((p) => p.id === b.packageId) : null;
  const labels = (b.tables || []).map((id) => tables.find((t) => t.id === id)?.label || String(id).slice(-4)).join('+');
  return (
    <button
      onClick={() => onSelect(isSel ? null : b.id)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '8px 10px',
        borderRadius: 10, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit',
        background: isSel ? tintBg('var(--acc)') : 'var(--bg2)',
        border: `1.5px solid ${isSel ? 'var(--acc)' : 'var(--bdr)'}`,
        transition: 'all 140ms cubic-bezier(.2,.8,.3,1)',
      }}
    >
      <span style={{ width: 4, alignSelf: 'stretch', borderRadius: 4, background: meta?.col || 'var(--bdr2)', flexShrink: 0 }} />
      <span style={{ width: 40, flexShrink: 0, fontSize: 12, fontWeight: 800, color: 'var(--t1)', ...mono }}>
        {String(b.startTime || '').slice(0, 5)}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 12.5, fontWeight: 700, color: 'var(--t1)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {bookingName(b)}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--t3)', ...mono }}>
          {b.covers} cvr · {labels || '—'}
          {pkg && <span title={pkg.name} style={{ width: 7, height: 7, borderRadius: 999, background: 'var(--grn)', flexShrink: 0 }} />}
          {po && po.state !== 'complete' && (
            <span style={{ fontSize: 9, fontWeight: 800, color: 'var(--orn)' }}>pre {po.have}/{po.needed}</span>
          )}
        </span>
      </span>
    </button>
  );
}

const GroupLabel = ({ children }) => (
  <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', margin: '12px 2px 6px' }}>
    {children}
  </div>
);

const MiniKpi = ({ label, value, col }) => (
  <div style={{ flex: 1, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 10, padding: '7px 10px' }}>
    <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</div>
    <div style={{ fontSize: 14, fontWeight: 800, color: col || 'var(--t1)', ...mono }}>{value}</div>
  </div>
);
