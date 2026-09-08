// Bookings report — Back Office → Reports → Order reports → Bookings.
//
// Self-fetching module (same pattern as CashDrawer / LoyaltyReport): the hub
// passes rangeFrom/rangeTo Dates, this module resolves the location itself and
// loads camelCase booking rows via loadBookingsRange (table-absent-safe — a
// venue without migration 20260811b just sees the empty state).
//
// Content: KPI band (bookings / covers / no-show / cancellation / widget share /
// package attach) → covers-by-day bars → status breakdown → by-source table →
// peak-times bar list → bookings table (≤200 rows, newest first) + CSV export.

import { useEffect, useState, useMemo } from 'react';
import { useStore } from '../../../store';
import { getLocationId } from '../../../lib/supabase';
import { loadBookingsRange } from '../../../lib/bookings/bookingsData';
import { StatTile, ExportBtn, EmptyState, BarRow } from './_charts';
import { toCsv, downloadCsv } from './_csv';

const STATUS_META = {
  confirmed: { label:'Confirmed', bg:'var(--acc-d)',                 color:'var(--acc)' },
  prepaid:   { label:'Prepaid',   bg:'var(--grn-d)',                 color:'var(--grn)' },
  due:       { label:'Due',       bg:'var(--bg3)',                   color:'var(--t3)' },
  late:      { label:'Late',      bg:'rgba(232,160,32,.12)',         color:'var(--amb,#e8a020)' },
  dining:    { label:'Dining',    bg:'var(--grn-d)',                 color:'var(--grn)' },
  departed:  { label:'Departed',  bg:'var(--bg3)',                   color:'var(--t3)' },
  cancelled: { label:'Cancelled', bg:'var(--red-d)',                 color:'var(--red)' },
  no_show:   { label:'No-show',   bg:'var(--red-d)',                 color:'var(--red)' },
};

const SOURCE_LABELS = {
  host:    '🧑‍💼 Host stand',
  phone:   '📞 Phone',
  widget:  '🌐 Web widget',
  walk_in: '🚶 Walk-in',
  events:  '🎉 Events',
  pos:     '🧾 POS',
};

// Statuses still ahead of (or on) the floor — everything not yet resolved.
const UPCOMING = new Set(['confirmed', 'prepaid', 'due', 'late']);

const fmtDayKey = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fmtDateShort = (iso) => {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
};

export default function BookingsReport({ rangeFrom, rangeTo, fmtN = (n) => (n || 0).toLocaleString() }) {
  const floorTables = useStore(s => s.tables) || [];
  const [bookings, setBookings] = useState(null);   // null = loading
  const [loading, setLoading]   = useState(true);

  const fromISO = useMemo(() => (rangeFrom ? fmtDayKey(new Date(rangeFrom)) : null), [rangeFrom]);
  const toISO   = useMemo(() => (rangeTo   ? fmtDayKey(new Date(rangeTo))   : null), [rangeTo]);

  useEffect(() => {
    if (!fromISO || !toISO) { setBookings([]); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        const locId = await getLocationId().catch(() => null);
        if (!locId) { if (alive) setBookings([]); return; }
        const { data } = await loadBookingsRange(locId, fromISO, toISO);
        if (alive) setBookings(data || []);
      } catch (err) {
        console.warn('[BookingsReport] load failed:', err?.message || err);
        if (alive) setBookings([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [fromISO, toISO]);

  const rows = bookings || [];

  const tableLabel = (id) => floorTables.find(t => t.id === id)?.label || id;

  // ── KPIs ──────────────────────────────────────────────────────────────────
  const kpis = useMemo(() => {
    const total        = rows.length;
    const cancelled    = rows.filter(b => b.status === 'cancelled').length;
    const noShows      = rows.filter(b => b.status === 'no_show').length;
    const nonCancelled = rows.filter(b => b.status !== 'cancelled');
    const covers       = nonCancelled.reduce((s, b) => s + (Number(b.covers) || 0), 0);
    const widget       = rows.filter(b => b.source === 'widget').length;
    const withPackage  = nonCancelled.filter(b => b.packageId).length;
    return {
      total, covers, cancelled, noShows,
      noShowRate:  total ? (noShows   / total) * 100 : 0,
      cancelRate:  total ? (cancelled / total) * 100 : 0,
      widgetShare: total ? (widget    / total) * 100 : 0,
      packageRate: nonCancelled.length ? (withPackage / nonCancelled.length) * 100 : 0,
      withPackage,
      avgParty: nonCancelled.length ? covers / nonCancelled.length : 0,
    };
  }, [rows]);

  // ── Covers by day ─────────────────────────────────────────────────────────
  const days = useMemo(() => {
    if (!fromISO || !toISO) return [];
    const start = new Date(`${fromISO}T12:00:00`);
    const end   = new Date(`${toISO}T12:00:00`);
    const out = [];
    for (let t = start.getTime(); t <= end.getTime(); t += 24 * 60 * 60 * 1000) {
      out.push(fmtDayKey(new Date(t)));
    }
    return out;
  }, [fromISO, toISO]);

  const coversByDay = useMemo(() => {
    const map = Object.fromEntries(days.map(k => [k, 0]));
    rows.forEach(b => {
      if (b.status === 'cancelled') return;
      if (map[b.date] !== undefined) map[b.date] += Number(b.covers) || 0;
    });
    return days.map(k => map[k]);
  }, [rows, days]);

  // ── By source ─────────────────────────────────────────────────────────────
  const bySource = useMemo(() => {
    const map = {};
    rows.forEach(b => {
      const key = b.source || 'host';
      if (!map[key]) map[key] = { source: key, bookings: 0, covers: 0 };
      map[key].bookings += 1;
      map[key].covers   += Number(b.covers) || 0;
    });
    return Object.values(map)
      .filter(r => r.bookings > 0)
      .sort((a, b) => b.bookings - a.bookings);
  }, [rows]);

  // ── By status (compact) ───────────────────────────────────────────────────
  const byStatus = useMemo(() => {
    const count = (fn) => rows.filter(fn).length;
    return [
      { id:'departed',  label:'Departed',  n: count(b => b.status === 'departed'),   color:'var(--t2)' },
      { id:'dining',    label:'Dining',    n: count(b => b.status === 'dining'),     color:'var(--grn)' },
      { id:'upcoming',  label:'Upcoming',  n: count(b => UPCOMING.has(b.status)),    color:'var(--acc)' },
      { id:'no_show',   label:'No-shows',  n: count(b => b.status === 'no_show'),    color:'var(--red)' },
      { id:'cancelled', label:'Cancelled', n: count(b => b.status === 'cancelled'),  color:'var(--red)' },
    ];
  }, [rows]);

  // ── Peak times (count per hour of startTime) ──────────────────────────────
  const peakHours = useMemo(() => {
    const map = {};
    rows.forEach(b => {
      if (b.status === 'cancelled') return;
      const h = parseInt(String(b.startTime || '').slice(0, 2), 10);
      if (!Number.isFinite(h)) return;
      map[h] = (map[h] || 0) + 1;
    });
    return Object.entries(map)
      .map(([h, n]) => ({ hour: Number(h), n }))
      .sort((a, b) => a.hour - b.hour);
  }, [rows]);

  // ── Bookings table (≤200 rows, newest first) ──────────────────────────────
  const tableRows = useMemo(() =>
    [...rows]
      .sort((a, b) => `${b.date} ${b.startTime}`.localeCompare(`${a.date} ${a.startTime}`))
      .slice(0, 200)
  , [rows]);

  // ── CSV export (full range, not truncated) ────────────────────────────────
  const onExport = () => {
    const csv = toCsv(
      [...rows].sort((a, b) => `${b.date} ${b.startTime}`.localeCompare(`${a.date} ${a.startTime}`)),
      [
        { label:'Date',    key:'date' },
        { label:'Time',    key:'startTime' },
        { label:'Name',    key: b => b.customer?.name || '' },
        { label:'Covers',  key:'covers' },
        { label:'Tables',  key: b => (b.tables || []).map(tableLabel).join(' + ') },
        { label:'Status',  key: b => STATUS_META[b.status]?.label || b.status },
        { label:'Source',  key: b => (SOURCE_LABELS[b.source] || b.source || '').replace(/^\S+\s/, '') },
        { label:'Package', key: b => (b.packageId ? 'yes' : 'no') },
      ],
    );
    downloadCsv(`bookings-${fromISO}-to-${toISO}.csv`, csv);
  };

  if (loading) {
    return <div style={{ padding:'40px 20px', textAlign:'center', color:'var(--t4)' }}>Loading bookings…</div>;
  }
  if (rows.length === 0) {
    return <EmptyState icon="📅" message="No bookings in this range. Bookings taken at the host stand, by phone or through the web widget will appear here."/>;
  }

  const maxSourceBookings = Math.max(1, ...bySource.map(r => r.bookings));
  const maxHour = Math.max(1, ...peakHours.map(r => r.n));

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}><ExportBtn onClick={onExport}/></div>

      {/* KPI row */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(160px, 1fr))', gap:10, marginBottom:18 }}>
        <StatTile label="Total bookings" value={fmtN(kpis.total)}/>
        <StatTile label="Covers" value={fmtN(kpis.covers)} sub={`${kpis.avgParty.toFixed(1)} avg party`}/>
        <StatTile label="No-show rate" value={`${kpis.noShowRate.toFixed(1)}%`}
          sub={`${fmtN(kpis.noShows)} no-show${kpis.noShows === 1 ? '' : 's'}`}
          color={kpis.noShows > 0 ? 'var(--red)' : 'var(--grn)'}/>
        <StatTile label="Cancellation rate" value={`${kpis.cancelRate.toFixed(1)}%`}
          sub={`${fmtN(kpis.cancelled)} cancelled`}
          color={kpis.cancelled > 0 ? 'var(--amb,#e8a020)' : 'var(--grn)'}/>
        <StatTile label="Widget share" value={`${kpis.widgetShare.toFixed(1)}%`} sub="booked online" color="var(--acc)"/>
        <StatTile label="Package attach" value={`${kpis.packageRate.toFixed(1)}%`}
          sub={`${fmtN(kpis.withPackage)} with a package`} color="var(--acc)"/>
      </div>

      {/* Covers by day */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'16px', marginBottom:14 }}>
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:12 }}>Covers by day</div>
        <DayBars days={days} values={coversByDay}/>
      </div>

      {/* Status breakdown (compact) */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'14px 16px', marginBottom:14 }}>
        <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:10 }}>By status</div>
        <div style={{ display:'flex', gap:22, flexWrap:'wrap' }}>
          {byStatus.map(s => (
            <div key={s.id}>
              <div style={{ fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em' }}>{s.label}</div>
              <div style={{ fontSize:17, fontWeight:800, color: s.n > 0 ? s.color : 'var(--t4)', fontFamily:'var(--font-mono)', marginTop:2 }}>{fmtN(s.n)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* By source + peak times, side by side */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(320px, 1fr))', gap:14, marginBottom:14 }}>
        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden' }}>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', padding:'14px 16px 8px' }}>By source</div>
          <div style={{ display:'grid', gridTemplateColumns:'1.4fr 80px 80px 70px', padding:'7px 16px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.05em', gap:8 }}>
            <span>Source</span>
            <span style={{ textAlign:'right' }}>Bookings</span>
            <span style={{ textAlign:'right' }}>Covers</span>
            <span style={{ textAlign:'right' }}>%</span>
          </div>
          {bySource.map((r, i) => (
            <div key={r.source} style={{ display:'grid', gridTemplateColumns:'1.4fr 80px 80px 70px', padding:'9px 16px', borderBottom: i === bySource.length - 1 ? 'none' : '1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:8, background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
              <span style={{ color:'var(--t1)', fontWeight:600 }}>{SOURCE_LABELS[r.source] || r.source}</span>
              <span style={{ textAlign:'right', color: r.bookings === maxSourceBookings ? 'var(--acc)' : 'var(--t2)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{fmtN(r.bookings)}</span>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{fmtN(r.covers)}</span>
              <span style={{ textAlign:'right', color:'var(--t3)', fontFamily:'var(--font-mono)' }}>{kpis.total ? ((r.bookings / kpis.total) * 100).toFixed(1) : '0.0'}%</span>
            </div>
          ))}
        </div>

        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'14px 16px' }}>
          <div style={{ fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:12 }}>Peak times</div>
          {peakHours.length === 0 ? (
            <div style={{ fontSize:11, color:'var(--t4)', fontStyle:'italic' }}>No timed bookings.</div>
          ) : peakHours.map(r => (
            <BarRow key={r.hour} label={`${String(r.hour).padStart(2, '0')}:00`} value={r.n} max={maxHour}
              format={(v) => `${fmtN(v)} booking${v === 1 ? '' : 's'}`}/>
          ))}
        </div>
      </div>

      {/* Bookings table */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'auto' }}>
        <div style={{ display:'grid', gridTemplateColumns:'110px 60px 1.4fr 60px 100px 100px 120px 70px', padding:'9px 14px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.05em', gap:8, minWidth:740 }}>
          <span>Date</span>
          <span>Time</span>
          <span>Name</span>
          <span style={{ textAlign:'right' }}>Covers</span>
          <span>Table(s)</span>
          <span>Status</span>
          <span>Source</span>
          <span>Package</span>
        </div>
        {tableRows.map((b, i) => {
          const st = STATUS_META[b.status] || { label: b.status, bg:'var(--bg3)', color:'var(--t3)' };
          return (
            <div key={b.id || i} style={{ display:'grid', gridTemplateColumns:'110px 60px 1.4fr 60px 100px 100px 120px 70px', padding:'10px 14px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center', gap:8, minWidth:740, background: i % 2 === 0 ? 'transparent' : 'var(--bg2)' }}>
              <span style={{ color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{fmtDateShort(b.date)}</span>
              <span style={{ color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{b.startTime}</span>
              <span style={{ color:'var(--t1)', fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.customer?.name || '—'}</span>
              <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{b.covers}</span>
              <span style={{ color:'var(--t3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{(b.tables || []).map(tableLabel).join(' + ') || '—'}</span>
              <span>
                <span style={{ fontSize:10, fontWeight:800, padding:'2px 8px', borderRadius:5, background:st.bg, color:st.color, textTransform:'uppercase', letterSpacing:'.05em', whiteSpace:'nowrap' }}>{st.label}</span>
              </span>
              <span style={{ color:'var(--t3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{SOURCE_LABELS[b.source] || b.source}</span>
              <span style={{ color: b.packageId ? 'var(--grn)' : 'var(--t4)', fontWeight:700 }}>{b.packageId ? '✓ Yes' : '—'}</span>
            </div>
          );
        })}
      </div>
      {rows.length > 200 && (
        <div style={{ marginTop:10, padding:'8px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)' }}>
          ⓘ Showing the 200 most recent of {fmtN(rows.length)} bookings — export CSV for the full range.
        </div>
      )}
    </div>
  );
}

// ── Covers-by-day plain-div bar chart (HourBar idiom, day-keyed) ─────────────
function DayBars({ days, values }) {
  const max = Math.max(1, ...values);
  const todayKey  = fmtDayKey(new Date());
  const accentIdx = days.includes(todayKey) ? days.indexOf(todayKey) : days.length - 1;
  const many = days.length > 21;
  // Sparse x labels for long ranges — first / quarter points / last.
  const labelIdx = new Set(days.length <= 14
    ? days.map((_, i) => i)
    : [0, Math.floor((days.length - 1) / 4), Math.floor((days.length - 1) / 2), Math.floor(3 * (days.length - 1) / 4), days.length - 1]);
  const BAR_H = 118; // px height of the tallest bar
  return (
    <div style={{ display:'flex', alignItems:'flex-end', gap: many ? 2 : 4 }}>
      {days.map((k, i) => {
        const val = values[i];
        const barPx = Math.max(Math.round((val / max) * BAR_H), val > 0 ? 4 : 2);
        const isAccent = i === accentIdx;
        const d = new Date(`${k}T12:00:00`);
        const short = `${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()]} ${d.getDate()}/${d.getMonth() + 1}`;
        return (
          <div key={k} title={`${short}: ${val} covers`} style={{ flex:1, display:'flex', flexDirection:'column', justifyContent:'flex-end', alignItems:'center', gap:3, minWidth:0 }}>
            <div style={{ fontSize:9, color:'var(--t4)', fontFamily:'var(--font-mono)', whiteSpace:'nowrap' }}>
              {!many && val > 0 ? val : ''}
            </div>
            <div style={{
              width:'100%',
              background: isAccent ? 'var(--acc)' : val > 0 ? 'var(--acc-d)' : 'var(--bg3)',
              borderRadius:'3px 3px 0 0',
              transition:'height .3s',
              height: barPx,
              border: isAccent ? '1px solid var(--acc-b)' : '1px solid var(--bdr)',
              boxSizing:'border-box',
            }}/>
            <div style={{ fontSize:8, color: isAccent ? 'var(--acc)' : 'var(--t4)', fontWeight: isAccent ? 700 : 400, whiteSpace:'nowrap' }}>
              {labelIdx.has(i) ? (days.length <= 7 ? short : `${d.getDate()}/${d.getMonth() + 1}`) : ''}
            </div>
          </div>
        );
      })}
    </div>
  );
}
