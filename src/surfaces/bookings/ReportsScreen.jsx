// src/surfaces/bookings/ReportsScreen.jsx
//
// Reports — the last 7 days ending today, computed from REAL bookings rows
// (loadBookingsRange) + the store's live diary. The range fetch runs on mount
// and again when the location resolves; the store's `bookings` (today's diary,
// realtime-updated) is merged over the fetched rows by id, so "this week"
// keeps moving as bookings land without a re-fetch. 16 Oct 2026 (audit item
// 22): money is what was actually TAKEN (captured booking_payments for the
// week's bookings), never package prices; the days are the VENUE's days.
//
// Table capacities come from the store's floor plan (maxCovers), exactly like
// the diary's KPI strip — split-check children (parentId) are excluded.

import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store';
import { loadBookingsRange, loadCapturedMinorByBooking } from '../../lib/bookings/bookingsData';
import { mono, tintBg, money, EmptyNote } from './bits.jsx';
import { useVenueClock } from './useVenueClock.js';
import { daysEnding } from '../../lib/bookings/venueClock.js';

const CHART_H = 150;   // bar area inside the ~170px chart body

const SOURCES = [
  ['widget', 'Booking widget'],
  ['host', 'Host stand'],
  ['phone', 'Phone'],
  ['walk_in', 'Walk-in'],
  ['events', 'Events'],
  ['pos', 'POS'],
];


const label = { fontSize: 12, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '.07em', color: 'var(--t3)' };
const panel = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 14, padding: '16px 18px' };

export default function ReportsScreen() {
  const currentLocationId = useStore((s) => s.currentLocationId);
  const storeBookings = useStore((s) => s.bookings) || [];
  const tables = useStore((s) => s.tables) || [];
  const { ymd: venueYmd } = useVenueClock();

  // The 7 VENUE days ending today, oldest first (rolls over on a stand left on).
  const days = daysEnding(venueYmd, 7);
  const fromISO = days[0].iso;
  const toISO = days[6].iso;                     // today

  // ── the range fetch (mount + location resolve + midnight rollover) ──────────
  const [fetched, setFetched] = useState(null);  // null = in flight
  // 5 Oct 2026: true when the week's read failed. The live diary below still shows, so the
  // screen keeps its figures and says plainly that the earlier days may be missing.
  const [weekFailed, setWeekFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setFetched(null);
    setWeekFailed(false);
    loadBookingsRange(currentLocationId, fromISO, toISO)
      .then(({ data, error }) => { if (alive) { setFetched(data || []); setWeekFailed(!!error); } })
      .catch(() => { if (alive) { setFetched([]); setWeekFailed(true); } });
    return () => { alive = false; };
  }, [currentLocationId, fromISO, toISO]);

  // ── merge: fetched range + the live diary (store wins, realtime fresh) ─────
  const rows = useMemo(() => {
    const inRange = (b) => b?.date >= fromISO && b?.date <= toISO;
    const map = new Map();
    for (const b of fetched || []) if (inRange(b)) map.set(b.id, b);
    for (const b of storeBookings) if (inRange(b)) map.set(b.id, b);
    return [...map.values()];
  }, [fetched, storeBookings, fromISO, toISO]);

  // ── money actually taken: captured booking_payments for the week's bookings ──
  // null = still reading, 'failed' = the ledger could not be read (said so).
  // 16 Oct 2026 (review): keyed on the MERGED rows, not the boot fetch. The screen stays mounted,
  // so a booking that arrived by realtime after the stand opened (the prepaid brunch) counted its
  // covers but none of its money. The previous figures stay on screen while a new read runs.
  const [paid, setPaid] = useState(null);
  // id and status: a booking whose payment lands later (pending payment to prepaid) reads again.
  const rowKey = useMemo(() => rows.map((b) => `${b.id}|${b.status}`).sort().join(','), [rows]);
  useEffect(() => {
    if (fetched === null) return undefined;
    let alive = true;
    const ids = rowKey ? rowKey.split(',').map((k) => k.split('|')[0]) : [];
    loadCapturedMinorByBooking(ids)
      .then((m) => { if (alive) setPaid(m === null ? 'failed' : m); })
      .catch(() => { if (alive) setPaid('failed'); });
    return () => { alive = false; };
    // fetched only gates the first read; rowKey carries every change that matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetched === null, rowKey]);

  // ── the maths ───────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const alive = rows.filter((b) => b.status !== 'cancelled');
    const covers = alive.reduce((s, b) => s + (b.covers || 0), 0);

    const noShows = rows.filter((b) => b.status === 'no_show').length;
    const noShowPct = rows.length ? (noShows / rows.length) * 100 : 0;

    // Money TAKEN, in minor units: the ledger read above, over every booking on
    // screen. While a new read is in flight, a booking it has not covered yet uses
    // the figure loadBookings summed for it (paidMinor), if the diary reloaded it.
    // Cancelled bookings still count: the money was taken.
    let takenMinor = 0, prepayMinor = 0;
    const ledger = paid instanceof Map ? paid : null;
    for (const b of rows) {
      const fromLedger = ledger?.get(b.id) || null;
      const total = fromLedger ? fromLedger.total : (b.paidMinor || 0);
      const pre = fromLedger ? fromLedger.prepay : (b.paidPrepayMinor || 0);
      takenMinor += total; prepayMinor += pre;
    }
    const committed = takenMinor / 100;
    const prepay = prepayMinor / 100;

    const floor = tables.filter((t) => !t.parentId);
    const capMap = new Map(floor.map((t) => [t.id, t.maxCovers || 0]));
    const capacity = floor.reduce((s, t) => s + (t.maxCovers || 0), 0);
    const utilisation = capacity > 0 ? (covers / (capacity * 7)) * 100 : null;

    let wasteSum = 0, wasteN = 0;
    for (const b of alive) {
      const seats = (b.tables || []).filter((id) => capMap.has(id)).reduce((s, id) => s + capMap.get(id), 0);
      if (seats > 0) { wasteSum += Math.max(0, seats - (b.covers || 0)); wasteN += 1; }
    }
    const waste = wasteN ? wasteSum / wasteN : null;

    const byDay = days.map((d) => alive.filter((b) => b.date === d.iso).reduce((s, b) => s + (b.covers || 0), 0));
    const srcCounts = SOURCES.map(([key]) => rows.filter((b) => (b.source || 'host') === key).length);

    return { covers, noShows, noShowPct, committed, prepay, capacity, utilisation, waste, byDay, srcCounts, total: rows.length };
    // days is rebuilt per render with identical content; fromISO pins the identity that matters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, tables, fromISO, paid]);

  const maxDay = Math.max(...stats.byDay, 1);

  if (fetched === null) {
    return (
      <div style={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center' }}>
        <div style={{ color: 'var(--t3)', fontSize: 13, ...mono }}>Crunching the last 7 days…</div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-0.01em' }}>Last 7 days</span>
        <span style={{ fontSize: 11, color: 'var(--t3)', ...mono }}>{fromISO} → {toISO}</span>
        <span style={{ fontSize: 11, color: 'var(--t4)' }}>today's diary is live — figures move as bookings land</span>
      </div>

      {weekFailed && (
        <div style={{ marginBottom: 14, fontSize: 12.5, color: 'var(--red)' }}>
          The last 7 days could not be loaded, so these figures only count the bookings on this screen today. Check the connection and open Reports again.
        </div>
      )}
      {rows.length === 0 && !weekFailed && (
        <div style={{ marginBottom: 14 }}>
          <EmptyNote title="No bookings in the last 7 days" sub="These figures light up as the diary fills." />
        </div>
      )}

      {/* KPI cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 16 }}>
        <Kpi k="Covers this week" v={stats.covers} s="non-cancelled bookings" />
        <Kpi k="No-show rate" v={`${stats.noShowPct.toFixed(1)}%`} s={`${stats.noShows} of ${stats.total} bookings`} col={stats.noShowPct > 5 ? 'var(--red)' : undefined} />
        <Kpi k="Deposits & prepay" v={paid === 'failed' ? 'Not visible' : money(stats.committed, 2)} s={paid === 'failed' ? 'card payments could not be read here' : paid === null ? 'reading card payments…' : 'taken by card at booking'} col="var(--grn)" />
        <Kpi k="Package revenue" v={paid === 'failed' ? 'Not visible' : money(stats.prepay, 2)} s="prepaid packages, taken by card" col="var(--grn)" />
        <Kpi k="Seat utilisation" v={stats.utilisation == null ? '—' : `${Math.round(stats.utilisation)}%`} s={stats.utilisation == null ? 'no floor plan yet' : 'booked covers ÷ seats × 7 days'} />
        <Kpi k="Wasted seats / booking" v={stats.waste == null ? '—' : stats.waste.toFixed(1)} s="avg empty seats after joins" />
      </div>

      {/* chart + sources */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'stretch' }}>
        <div style={{ ...panel, flex: '1.6 1 380px', minWidth: 320 }}>
          <div style={{ ...label, marginBottom: 16 }}>Covers by day</div>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14, height: CHART_H + 20 }}>
            {days.map((d, i) => {
              const c = stats.byDay[i];
              const isToday = d.iso === venueYmd;
              const h = c > 0 ? Math.max(4, Math.round((c / maxDay) * CHART_H)) : 2;
              return (
                <div key={d.iso} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                  <div style={{ fontSize: 12, fontWeight: 800, color: isToday ? 'var(--acc)' : 'var(--t2)', ...mono }}>{c}</div>
                  <div style={{
                    width: '100%', height: h, borderRadius: '6px 6px 0 0',
                    background: isToday ? 'var(--acc)' : c > 0 ? tintBg('var(--uv)', 45) : tintBg('var(--t1)', 8),
                  }} />
                  <div style={{ fontSize: 11, color: isToday ? 'var(--acc)' : 'var(--t3)', fontWeight: isToday ? 800 : 400 }}>{d.label}</div>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ ...panel, flex: '1 1 280px', minWidth: 260 }}>
          <div style={{ ...label, marginBottom: 16 }}>Where bookings come from</div>
          {SOURCES.map(([key, name], i) => {
            const n = stats.srcCounts[i];
            const pct = stats.total ? Math.round((n / stats.total) * 100) : 0;
            return (
              <div key={key} style={{ marginBottom: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 6 }}>
                  <span style={{ color: 'var(--t2)', fontWeight: 600 }}>{name}</span>
                  <span style={{ fontWeight: 700, ...mono }}>{pct}%</span>
                </div>
                <div style={{ height: 8, borderRadius: 4, background: tintBg('var(--t1)', 6) }}>
                  <div style={{ width: `${pct}%`, height: 8, borderRadius: 4, background: 'var(--uv)', transition: 'width 300ms cubic-bezier(.2,.8,.3,1)' }} />
                </div>
              </div>
            );
          })}
          <div style={{ fontSize: 11, color: 'var(--t3)', lineHeight: 1.6, marginTop: 14 }}>
            A guest found or added at booking is the same guest on the POS check, so spend, allergens and no-shows sit on one profile.
          </div>
        </div>
      </div>
    </div>
  );
}

function Kpi({ k, v, s, col }) {
  return (
    <div style={{ padding: '13px 15px', borderRadius: 13, background: 'var(--bg1)', border: '1px solid var(--bdr)' }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em' }}>{k}</div>
      <div style={{ fontSize: 24, fontWeight: 800, marginTop: 4, letterSpacing: '-0.02em', color: col || 'var(--t1)', ...mono }}>{v}</div>
      <div style={{ fontSize: 10, color: 'var(--t4)', marginTop: 2, lineHeight: 1.4 }}>{s}</div>
    </div>
  );
}
