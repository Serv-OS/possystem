// OpsCompliance — the EHO-ready compliance calendar: a month coloured by status,
// a day drill-in (every reading, breach, corrective action + maintenance raised),
// and a CSV export of the audit trail. (Back Office → Operations → Compliance calendar.)

import { useEffect, useMemo, useState, useCallback } from 'react';
import { getActiveLocationSync, getLocationId } from '../../../lib/supabase';
import { fetchTempUnits, fetchSchedules, fetchReadings, fetchCorrectiveActions } from '../../../lib/ops/data';
import { hhmmToMin, runsOnDay, windowStatus, summarize, displayTemp } from '../../../lib/ops/temp';

const mono = { fontFamily: 'var(--font-mono)' };
const ymd = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const DAY_COL = { green: 'var(--grn)', amber: 'var(--orn)', coral: 'var(--red)', idle: 'transparent' };

export default function OpsCompliance() {
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [month, setMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [data, setData] = useState({ units: [], scheds: [], readings: [], corr: [], loading: true });
  const [selDay, setSelDay] = useState(null);

  const monthStart = useMemo(() => new Date(month.y, month.m, 1), [month]);
  const monthEnd = useMemo(() => new Date(month.y, month.m + 1, 1), [month]);

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const [{ data: units }, { data: scheds }, { data: readings }, { data: corr }] = await Promise.all([
      fetchTempUnits(loc, true), fetchSchedules(loc),
      fetchReadings(monthStart.toISOString(), monthEnd.toISOString(), loc, 5000),
      fetchCorrectiveActions(monthStart.toISOString(), monthEnd.toISOString(), loc),
    ]);
    setData({ units: units || [], scheds: scheds || [], readings: readings || [], corr: corr || [], loading: false });
  }, [locId, monthStart, monthEnd]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [month]);

  // per-day status
  const dayStatus = useMemo(() => {
    const byDay = {};
    const readByDay = {}; data.readings.forEach(r => { (readByDay[ymd(r.recordedAt)] ??= []).push(r); });
    const schedByUnit = {}; data.scheds.forEach(s => { (schedByUnit[s.tempUnitId] ??= []).push(s); });
    const today = ymd(new Date());
    const days = new Date(month.y, month.m + 1, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const date = new Date(month.y, month.m, d);
      const key = ymd(date);
      if (key > today) { byDay[key] = 'idle'; continue; }
      const reads = readByDay[key] || [];
      const anyBreach = reads.some(r => !r.inRange);
      // expected windows that day (past days fully required)
      const statuses = [];
      data.units.filter(u => !u.archivedAt).forEach(u => {
        (schedByUnit[u.id] || []).filter(s => runsOnDay(s.daysOfWeek, date)).forEach(s => {
          const wMin = hhmmToMin(s.timeOfDay) ?? 0;
          const satisfied = reads.some(r => r.tempUnitId === u.id && (() => { const rd = new Date(r.recordedAt); return rd.getHours() * 60 + rd.getMinutes() >= wMin - 5; })());
          statuses.push(windowStatus({ windowMin: wMin, graceMin: s.graceMinutes, nowMin: 24 * 60, satisfied })); // whole past day
        });
      });
      const sum = summarize(statuses);
      if (anyBreach || sum.missed > 0) byDay[key] = 'coral';
      else if (statuses.length === 0 && reads.length === 0) byDay[key] = 'idle';
      else if (sum.done === sum.total && sum.total > 0) byDay[key] = 'green';
      else byDay[key] = reads.length ? 'green' : 'amber';
    }
    return byDay;
  }, [data, month]);

  const exportCsv = () => {
    const rows = [['Date', 'Time', 'Unit', 'Reading°C', 'In range', 'Severity', 'By', 'Source']];
    data.readings.slice().reverse().forEach(r => {
      const u = data.units.find(x => x.id === r.tempUnitId);
      rows.push([ymd(r.recordedAt), new Date(r.recordedAt).toLocaleTimeString('en-GB'), u?.name || r.tempUnitId, r.readingC, r.inRange ? 'yes' : 'NO', r.severity, r.operatorName || '', r.source]);
    });
    const csv = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `compliance-${month.y}-${String(month.m + 1).padStart(2, '0')}.csv`; a.click();
  };

  const firstDow = (new Date(month.y, month.m, 1).getDay() + 6) % 7; // Mon-first
  const daysInMonth = new Date(month.y, month.m + 1, 0).getDate();
  const cells = [...Array(firstDow).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const monthLabel = monthStart.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 16 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--t1)', flex: 1 }}>Compliance calendar</h1>
        <button onClick={() => setMonth(m => ({ y: m.m === 0 ? m.y - 1 : m.y, m: (m.m + 11) % 12 }))} style={navBtn}>‹</button>
        <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)', minWidth: 140, textAlign: 'center', ...mono }}>{monthLabel}</span>
        <button onClick={() => setMonth(m => ({ y: m.m === 11 ? m.y + 1 : m.y, m: (m.m + 1) % 12 }))} style={navBtn}>›</button>
        <button onClick={exportCsv} className="btn btn-acc" style={{ padding: '9px 16px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Export EHO (CSV)</button>
      </div>

      <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 16, maxWidth: 720 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 6 }}>
          {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => <div key={d} style={{ textAlign: 'center', fontSize: 11, color: 'var(--t3)', fontWeight: 700, ...mono }}>{d}</div>)}
          {cells.map((d, i) => {
            if (d == null) return <div key={i} />;
            const key = ymd(new Date(month.y, month.m, d));
            const status = dayStatus[key] || 'idle';
            const sel = selDay === key;
            return (
              <button key={i} onClick={() => setSelDay(key)} style={{ aspectRatio: '1', borderRadius: 10, border: `1px solid ${sel ? 'var(--acc)' : 'var(--bdr)'}`, background: status === 'idle' ? 'var(--bg2)' : `color-mix(in srgb, ${DAY_COL[status]} 22%, var(--bg2))`, color: 'var(--t1)', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, padding: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 700, ...mono }}>{d}</span>
                {status !== 'idle' && <span style={{ width: 7, height: 7, borderRadius: 999, background: DAY_COL[status] }} />}
              </button>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 16, marginTop: 14, fontSize: 11.5, color: 'var(--t3)' }}>
          {[['green', 'Compliant'], ['amber', 'Minor'], ['coral', 'Breach / missed']].map(([c, l]) => <span key={c} style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 9, height: 9, borderRadius: 999, background: DAY_COL[c] }} />{l}</span>)}
        </div>
      </div>

      {selDay && <DayDetail day={selDay} units={data.units} readings={data.readings.filter(r => ymd(r.recordedAt) === selDay)} corr={data.corr.filter(c => ymd(c.createdAt) === selDay)} onClose={() => setSelDay(null)} />}
    </div>
  );
}
const navBtn = { width: 34, height: 34, borderRadius: 8, border: '1px solid var(--bdr)', background: 'var(--bg2)', color: 'var(--t1)', cursor: 'pointer', fontSize: 16, fontFamily: 'inherit' };

function DayDetail({ day, units, readings, corr, onClose }) {
  const uName = (id) => units.find(u => u.id === id)?.name || '—';
  return (
    <div style={{ marginTop: 16, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18, maxWidth: 720 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--t1)' }}>{new Date(day + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
        <button onClick={onClose} style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 20 }}>×</button>
      </div>
      <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6, ...mono }}>Readings</div>
      {readings.length === 0 ? <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 12 }}>No readings logged.</div> : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, marginBottom: 14 }}>
          <tbody>{readings.slice().reverse().map(r => (
            <tr key={r.id}>
              <td style={{ padding: '5px 8px', color: 'var(--t3)', ...mono }}>{new Date(r.recordedAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</td>
              <td style={{ padding: '5px 8px', color: 'var(--t1)' }}>{uName(r.tempUnitId)}</td>
              <td style={{ padding: '5px 8px', fontWeight: 700, color: r.inRange ? 'var(--grn)' : 'var(--red)', ...mono }}>{displayTemp(r.readingC, 'C').label}</td>
              <td style={{ padding: '5px 8px', color: r.inRange ? 'var(--grn)' : 'var(--red)', fontSize: 11, ...mono }}>{r.inRange ? 'IN RANGE' : 'BREACH'}</td>
              <td style={{ padding: '5px 8px', color: 'var(--t3)' }}>{r.operatorName || ''}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {corr.length > 0 && <>
        <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6, ...mono }}>Corrective actions</div>
        {corr.map(c => <div key={c.id} style={{ fontSize: 13, color: 'var(--t1)', padding: '4px 0' }}>{c.action?.replace(/_/g, ' ')} <span style={{ color: 'var(--t3)', fontSize: 11.5 }}>· {c.operatorName || '—'} · {new Date(c.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}{c.maintenanceRequestId ? ' · maintenance raised' : ''}</span></div>)}
      </>}
    </div>
  );
}
