// v4.6.16: Shifts report.
// No persistent clock-in/out capture yet, so shifts are derived from closed-check timestamps:
//
//   Business-day shift  = all checks closed between business-day-start and next-day-start.
//                         One row per day with total stats and shift duration (first check → last).
//   Server session      = within a business day, each server's first-check-to-last-check window
//                         is treated as their session. Rough but useful — accurate to within the
//                         service gap before their first and after their last order.
//
// When we add real clock-in/out events (Wave 5+ staff management), this file swaps the
// derivation for real session records. Everything downstream stays the same.

import { useMemo, useState } from 'react';
import { StatTile, ExportBtn, EmptyState } from './_charts';
import { toCsv, downloadCsv } from './_csv';
import { classifyShift } from './_filters';
import { money } from '../../../lib/currency';

// Group checks into business days. Business day starts at 00:00 local by default;
// locationConfig.businessDayStart could override but that's not piped down yet.
function groupByBusinessDay(checks) {
  const map = {};
  (checks || []).filter(c => c.closedAt).forEach(c => {
    const d = new Date(c.closedAt);
    const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (!map[key]) map[key] = { key, date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), checks: [] };
    map[key].checks.push(c);
  });
  return Object.values(map).sort((a, b) => b.date - a.date);
}

// Aggregate a check bundle into shift stats. Reused for both business-day and server session.
function aggregate(checks) {
  const paid       = checks.filter(c => c.status !== 'voided');
  const revenue    = paid.reduce((s, c) => s + (c.total || 0), 0);
  const covers     = paid.reduce((s, c) => s + (c.covers || 1), 0);
  const tips       = paid.reduce((s, c) => s + (c.tip || 0), 0);
  const cash       = paid.filter(c => (c.method || '').toLowerCase() === 'cash').reduce((s, c) => s + (c.total || 0), 0);
  const voidCount  = checks.filter(c => c.status === 'voided').length;
  const voidValue  = checks.filter(c => c.status === 'voided').reduce((s, c) => s + (c.total || 0), 0);
  const discounts  = paid.reduce((s, c) => s + (c.discounts || []).reduce((x, d) => x + (d.amount || d.value || 0), 0), 0);
  const refunds    = paid.reduce((s, c) => s + (c.refunds || []).reduce((x, r) => x + (r.amount || 0), 0), 0);
  const times      = checks.map(c => c.closedAt).filter(Boolean).sort((a, b) => a - b);
  const firstAt    = times[0] || null;
  const lastAt     = times[times.length - 1] || null;
  const durationMs = firstAt && lastAt ? (lastAt - firstAt) : 0;
  return {
    checkCount: paid.length, revenue, covers, tips, cash, voidCount, voidValue, discounts, refunds,
    firstAt, lastAt, durationMs, avgCheck: paid.length ? revenue / paid.length : 0,
  };
}

function formatDuration(ms) {
  if (!ms || ms < 60000) return '—';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function formatDate(d) {
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

// v4.6.16 day-based shifts — first-check-to-last-check per business day.
// Used as fallback when locationConfig.shifts is empty.
function DayBasedShifts({ checks, fmt, fmtN }) {
  const [expanded, setExpanded] = useState(null); // which day is drilled into

  const days = useMemo(() => groupByBusinessDay(checks), [checks]);

  // Per-server sessions for the expanded day
  const serverSessions = useMemo(() => {
    if (!expanded) return [];
    const day = days.find(d => d.key === expanded);
    if (!day) return [];
    const byServer = {};
    day.checks.forEach(c => {
      const s = c.server || c.staff || 'Unknown';
      if (!byServer[s]) byServer[s] = [];
      byServer[s].push(c);
    });
    return Object.entries(byServer)
      .map(([server, bundle]) => ({ server, ...aggregate(bundle) }))
      .sort((a, b) => (a.firstAt || 0) - (b.firstAt || 0));
  }, [expanded, days]);

  // Roll up stats per day
  const rollups = useMemo(() => days.map(d => ({ key: d.key, date: d.date, ...aggregate(d.checks) })), [days]);

  // Headline tiles — aggregates across all displayed shifts
  const headline = useMemo(() => {
    if (rollups.length === 0) return null;
    const totalRev     = rollups.reduce((s, r) => s + r.revenue, 0);
    const totalCovers  = rollups.reduce((s, r) => s + r.covers, 0);
    const totalChecks  = rollups.reduce((s, r) => s + r.checkCount, 0);
    const avgDuration  = rollups.reduce((s, r) => s + r.durationMs, 0) / rollups.length;
    return {
      shiftCount: rollups.length,
      avgRevenue: totalRev / rollups.length,
      avgCovers:  totalCovers / rollups.length,
      avgDuration,
      totalRev, totalCovers, totalChecks,
    };
  }, [rollups]);

  const onExport = () => {
    const rows = rollups.map(r => ({
      date: r.key,
      dow: r.date.toLocaleDateString('en-GB', { weekday: 'short' }),
      first: formatTime(r.firstAt),
      last: formatTime(r.lastAt),
      duration: formatDuration(r.durationMs),
      checks: r.checkCount,
      covers: r.covers,
      revenue: r.revenue.toFixed(2),
      tips: r.tips.toFixed(2),
      cash: r.cash.toFixed(2),
      discounts: r.discounts.toFixed(2),
      voids: `${r.voidCount} (${money(r.voidValue)})`,
    }));
    const csv = toCsv(rows, [
      { label:'Date',      key:'date' },
      { label:'Day',       key:'dow' },
      { label:'First',     key:'first' },
      { label:'Last',      key:'last' },
      { label:'Duration',  key:'duration' },
      { label:'Checks',    key:'checks' },
      { label:'Covers',    key:'covers' },
      { label:'Revenue',   key:'revenue' },
      { label:'Tips',      key:'tips' },
      { label:'Cash',      key:'cash' },
      { label:'Discounts', key:'discounts' },
      { label:'Voids',     key:'voids' },
    ]);
    downloadCsv(`shifts-${new Date().toISOString().slice(0,10)}.csv`, csv);
  };

  if (rollups.length === 0) {
    return <EmptyState icon="🕘" message="No shifts in this period. Widen the date range to see prior days."/>;
  }

  return (
    <div>
      <div style={{ display:'flex', justifyContent:'flex-end', marginBottom:12 }}><ExportBtn onClick={onExport}/></div>

      {/* Headline tiles */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:18 }}>
        <StatTile label={`Shifts (${headline.shiftCount})`} value={fmtN(headline.shiftCount)}          sub={`${fmtN(headline.totalChecks)} checks total`} color="var(--acc)"/>
        <StatTile label="Avg shift revenue"                  value={fmt(headline.avgRevenue)}            sub={`${fmt(headline.totalRev)} total`}/>
        <StatTile label="Avg shift covers"                   value={fmtN(Math.round(headline.avgCovers))} sub={`${fmtN(headline.totalCovers)} total`}/>
        <StatTile label="Avg shift duration"                 value={formatDuration(headline.avgDuration)} sub="first check → last check"/>
      </div>

      {/* Business-day shift table */}
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, overflow:'hidden' }}>
        <div style={{ padding:'10px 16px', background:'var(--bg3)', borderBottom:'1px solid var(--bdr)', fontSize:11, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.06em', display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <span>Business day shifts</span>
          <span style={{ fontWeight:400, textTransform:'none', color:'var(--t4)', fontSize:11 }}>click a row for per-staff sessions</span>
        </div>

        <div style={{ display:'grid', gridTemplateColumns:'26px 1.3fr 80px 80px 80px 70px 70px 110px 90px 100px', padding:'8px 16px', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', letterSpacing:'.05em', textTransform:'uppercase' }}>
          <span/>
          <span>Date</span>
          <span style={{ textAlign:'right' }}>First</span>
          <span style={{ textAlign:'right' }}>Last</span>
          <span style={{ textAlign:'right' }}>Duration</span>
          <span style={{ textAlign:'right' }}>Checks</span>
          <span style={{ textAlign:'right' }}>Covers</span>
          <span style={{ textAlign:'right' }}>Revenue</span>
          <span style={{ textAlign:'right' }}>Tips</span>
          <span style={{ textAlign:'right' }}>Voids</span>
        </div>

        {rollups.map(r => {
          const isOpen = expanded === r.key;
          return (
            <div key={r.key}>
              <button
                onClick={() => setExpanded(isOpen ? null : r.key)}
                style={{
                  display:'grid', gridTemplateColumns:'26px 1.3fr 80px 80px 80px 70px 70px 110px 90px 100px',
                  padding:'11px 16px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center',
                  width:'100%', textAlign:'left', background: isOpen ? 'var(--bg3)' : 'transparent',
                  border:'none', cursor:'pointer', fontFamily:'inherit',
                  color:'inherit',
                  transition:'background .15s',
                }}
              >
                <span style={{ color:'var(--t4)', fontSize:11, transition:'transform .2s', display:'inline-block', transform: isOpen ? 'rotate(90deg)' : 'none' }}>▶</span>
                <span style={{ color:'var(--t1)', fontWeight:600 }}>{formatDate(r.date)}</span>
                <span style={{ textAlign:'right', color:'var(--t3)', fontFamily:'var(--font-mono)' }}>{formatTime(r.firstAt)}</span>
                <span style={{ textAlign:'right', color:'var(--t3)', fontFamily:'var(--font-mono)' }}>{formatTime(r.lastAt)}</span>
                <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{formatDuration(r.durationMs)}</span>
                <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{r.checkCount}</span>
                <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{r.covers}</span>
                <span style={{ textAlign:'right', color:'var(--acc)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{fmt(r.revenue)}</span>
                <span style={{ textAlign:'right', color:'var(--grn)', fontFamily:'var(--font-mono)' }}>{fmt(r.tips)}</span>
                <span style={{ textAlign:'right', color: r.voidCount ? 'var(--red)' : 'var(--t4)', fontFamily:'var(--font-mono)' }}>
                  {r.voidCount ? `${r.voidCount} · ${fmt(r.voidValue)}` : '—'}
                </span>
              </button>

              {/* Per-server sessions for the selected day */}
              {isOpen && (
                <div style={{ background:'var(--bg2)', borderBottom:'1px solid var(--bdr)', padding:'8px 16px 12px 42px' }}>
                  <div style={{ fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:8 }}>
                    Server sessions · {serverSessions.length} staff on shift
                  </div>
                  {serverSessions.length === 0 ? (
                    <div style={{ fontSize:12, color:'var(--t4)', padding:'8px 0' }}>No server activity recorded.</div>
                  ) : (
                    <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:8, overflow:'hidden' }}>
                      <div style={{ display:'grid', gridTemplateColumns:'1.2fr 80px 80px 80px 70px 70px 110px 90px', padding:'7px 12px', borderBottom:'1px solid var(--bdr)', fontSize:10, fontWeight:700, color:'var(--t4)', letterSpacing:'.05em', textTransform:'uppercase' }}>
                        <span>Server</span>
                        <span style={{ textAlign:'right' }}>First</span>
                        <span style={{ textAlign:'right' }}>Last</span>
                        <span style={{ textAlign:'right' }}>Duration</span>
                        <span style={{ textAlign:'right' }}>Checks</span>
                        <span style={{ textAlign:'right' }}>Covers</span>
                        <span style={{ textAlign:'right' }}>Revenue</span>
                        <span style={{ textAlign:'right' }}>Avg check</span>
                      </div>
                      {serverSessions.map(s => (
                        <div key={s.server} style={{ display:'grid', gridTemplateColumns:'1.2fr 80px 80px 80px 70px 70px 110px 90px', padding:'9px 12px', borderBottom:'1px solid var(--bdr)', fontSize:12, alignItems:'center' }}>
                          <span style={{ color:'var(--t1)', fontWeight:600 }}>{s.server}</span>
                          <span style={{ textAlign:'right', color:'var(--t3)', fontFamily:'var(--font-mono)' }}>{formatTime(s.firstAt)}</span>
                          <span style={{ textAlign:'right', color:'var(--t3)', fontFamily:'var(--font-mono)' }}>{formatTime(s.lastAt)}</span>
                          <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{formatDuration(s.durationMs)}</span>
                          <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{s.checkCount}</span>
                          <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{s.covers}</span>
                          <span style={{ textAlign:'right', color:'var(--acc)', fontFamily:'var(--font-mono)', fontWeight:700 }}>{fmt(s.revenue)}</span>
                          <span style={{ textAlign:'right', color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{fmt(s.avgCheck)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ marginTop:14, padding:'10px 12px', background:'var(--bg3)', border:'1px dashed var(--bdr)', borderRadius:8, fontSize:11, color:'var(--t4)', lineHeight:1.7 }}>
        ⓘ Shifts are derived from closed-check timestamps — first check of the day = shift start, last check = shift end.
        When clock-in/out capture ships in staff management, this report switches to real session records automatically.
        Labour cost vs sales will follow once staff hourly rates are captured.
      </div>
    </div>
  );
}


// ─────────────────────────────────────────────────────────────────────────────
// v4.6.24 — Service-period grouped view.
// When locationConfig.shifts is defined (Breakfast/Lunch/Dinner in Location
// Settings), checks are bucketed by (business-day × service-period). Business
// day start from locationConfig.businessDayStart is honoured so a check
// closed at 02:00 belongs to the previous business day's last service.
// Falls back to DayBasedShifts when no services are configured.
// ─────────────────────────────────────────────────────────────────────────────

function groupByService(checks, shifts, businessDayStart) {
  const [bh, bm] = (businessDayStart || '00:00').split(':').map(Number);
  const bizStart = bh * 60 + bm;
  const map = {};
  (checks || []).filter(c => c.closedAt).forEach(c => {
    const shift = classifyShift(c.closedAt, shifts, businessDayStart);
    if (!shift) return;
    const d = new Date(c.closedAt);
    const minutesOfDay = d.getHours() * 60 + d.getMinutes();
    const dayDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    if (minutesOfDay < bizStart) dayDate.setDate(dayDate.getDate() - 1);
    const dayKey = `${dayDate.getFullYear()}-${String(dayDate.getMonth()+1).padStart(2,'0')}-${String(dayDate.getDate()).padStart(2,'0')}`;
    const key = `${dayKey}__${shift.id || shift.name}`;
    if (!map[key]) map[key] = { key, dayKey, dayDate, shift, checks: [] };
    map[key].checks.push(c);
  });
  return Object.values(map).sort((a, b) => {
    if (a.dayDate.getTime() !== b.dayDate.getTime()) return b.dayDate - a.dayDate;
    // Same day — order by shift start time, earliest first
    return (a.shift.start || '') < (b.shift.start || '') ? -1 : 1;
  });
}

function unclassifiedCheckCount(checks, shifts, businessDayStart) {
  if (!shifts?.length) return 0;
  return (checks || []).filter(c => c.closedAt && !classifyShift(c.closedAt, shifts, businessDayStart)).length;
}

function serviceAggregate(checks) {
  const paid      = checks.filter(c => c.status !== 'voided');
  const revenue   = paid.reduce((s, c) => s + (c.total || 0), 0);
  const covers    = paid.reduce((s, c) => s + (c.covers || 1), 0);
  const tips      = paid.reduce((s, c) => s + (c.tip || 0), 0);
  const paidCount = paid.length;
  return { revenue, covers, tips, paidCount, avgCheck: paidCount ? revenue / paidCount : 0 };
}

function ServicePeriodShifts({ checks, fmt, fmtN, locationConfig }) {
  const shifts = locationConfig?.shifts || [];
  const bds    = locationConfig?.businessDayStart || '00:00';
  const groups = useMemo(
    () => groupByService(checks, shifts, bds),
    [checks, shifts, bds]
  );
  const unclassified = useMemo(
    () => unclassifiedCheckCount(checks, shifts, bds),
    [checks, shifts, bds]
  );

  // Portfolio totals across all classified checks
  const totals = useMemo(() => {
    const all = groups.flatMap(g => g.checks);
    return serviceAggregate(all);
  }, [groups]);

  const exportCsv = () => {
    const rows = groups.map(g => {
      const a = serviceAggregate(g.checks);
      const servers = [...new Set(g.checks.map(c => c.server || 'Unknown'))];
      return {
        date:      `${g.dayDate.getFullYear()}-${String(g.dayDate.getMonth()+1).padStart(2,'0')}-${String(g.dayDate.getDate()).padStart(2,'0')}`,
        service:   g.shift.name,
        window:    `${g.shift.start}-${g.shift.end}`,
        revenue:   a.revenue.toFixed(2),
        covers:    a.covers,
        checks:    a.paidCount,
        tips:      a.tips.toFixed(2),
        avg_check: a.avgCheck.toFixed(2),
        servers:   servers.join('; '),
      };
    });
    downloadCsv(toCsv(rows), `shifts-by-service-${new Date().toISOString().slice(0,10)}.csv`);
  };

  if (!groups.length) {
    return (
      <div>
        <div style={{ fontSize:12, color:'var(--t4)', padding:'8px 12px', background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:8, marginBottom:16 }}>
          Service periods configured: {shifts.map(s => `${s.name} (${s.start}\u2013${s.end})`).join(' \u00b7 ')}
        </div>
        <EmptyState icon="\u{1F551}" message="No checks fell within any configured service period for this range."/>
      </div>
    );
  }

  return (
    <div>
      {/* Totals */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:16 }}>
        <StatTile label="Revenue" value={fmt(totals.revenue)} accent/>
        <StatTile label="Covers"  value={fmtN(totals.covers)}/>
        <StatTile label="Checks"  value={fmtN(totals.paidCount)}/>
        <StatTile label="Tips"    value={fmt(totals.tips)}/>
      </div>

      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12, flexWrap:'wrap', gap:10 }}>
        <div style={{ fontSize:12, color:'var(--t3)' }}>
          {groups.length} service period{groups.length !== 1 ? 's' : ''}
          <span style={{ color:'var(--t4)' }}> \u00b7 </span>
          defined services: {shifts.map(s => s.name).join(' / ')}
          {unclassified > 0 && (
            <span style={{ marginLeft:10, color:'var(--amb)' }}>
              \u26a0 {unclassified} check{unclassified !== 1 ? 's' : ''} outside any configured service
            </span>
          )}
        </div>
        <ExportBtn onClick={exportCsv}/>
      </div>

      {/* Service-period rows */}
      {groups.map(g => {
        const a = serviceAggregate(g.checks);
        const servers = [...new Set(g.checks.map(c => c.server || 'Unknown'))].sort();
        const dayLabel = g.dayDate.toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' });
        return (
          <div key={g.key} style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:'14px 16px', marginBottom:10 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12, flexWrap:'wrap', gap:8 }}>
              <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                <span style={{ fontSize:11, fontWeight:800, padding:'3px 10px', borderRadius:20, background:'var(--acc-d)', color:'var(--acc)', border:'1px solid var(--acc-b)', textTransform:'uppercase', letterSpacing:'.05em' }}>{g.shift.name}</span>
                <span style={{ fontSize:12, color:'var(--t4)', fontFamily:'var(--font-mono)' }}>{g.shift.start}\u2013{g.shift.end}</span>
                <span style={{ fontSize:12, color:'var(--t3)' }}>\u00b7 {dayLabel}</span>
              </div>
              <div style={{ fontSize:16, fontWeight:800, color:'var(--acc)', fontFamily:'var(--font-mono)' }}>{fmt(a.revenue)}</div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, marginBottom:10 }}>
              <MiniStat label="Covers"     value={fmtN(a.covers)}/>
              <MiniStat label="Checks"     value={fmtN(a.paidCount)}/>
              <MiniStat label="Avg check"  value={fmt(a.avgCheck)}/>
              <MiniStat label="Tips"       value={fmt(a.tips)}/>
            </div>
            {servers.length > 0 && (
              <div style={{ display:'flex', flexWrap:'wrap', gap:6, alignItems:'center' }}>
                <span style={{ fontSize:10, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginRight:4 }}>On shift</span>
                {servers.map(s => (
                  <span key={s} style={{ fontSize:11, padding:'3px 10px', borderRadius:20, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t2)' }}>{s}</span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div style={{ background:'var(--bg2)', border:'1px solid var(--bdr)', borderRadius:8, padding:'7px 10px' }}>
      <div style={{ fontSize:9, fontWeight:700, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:2 }}>{label}</div>
      <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', fontFamily:'var(--font-mono)' }}>{value}</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry point — picks the right view based on locationConfig
// ─────────────────────────────────────────────────────────────────────────────
export default function Shifts(props) {
  const hasServicePeriods = (props.locationConfig?.shifts?.length || 0) > 0;
  return hasServicePeriods
    ? <ServicePeriodShifts {...props}/>
    : <DayBasedShifts {...props}/>;
}
