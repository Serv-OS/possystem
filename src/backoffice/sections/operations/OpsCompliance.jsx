// OpsCompliance — the EHO-ready compliance history: a month coloured by status on the
// left, a day-detail event TIMELINE on the right (every temperature round, checklist
// sign-off, breach/corrective action + maintenance raised), and a CSV export of the
// audit trail. (Back Office → Operations → Compliance.)

import { useEffect, useMemo, useState, useCallback } from 'react';
import { getActiveLocationSync, getLocationId, getAvailableLocations } from '../../../lib/supabase';
import { fetchTempUnits, fetchSchedules, fetchReadings, fetchCorrectiveActions, fetchMaintenance } from '../../../lib/ops/data';
import { fetchRunsRange, fetchChecklists } from '../../../lib/ops/checklists';
import { hhmmToMin, runsOnDay, windowStatus, summarize, displayTemp } from '../../../lib/ops/temp';
const mono = { fontFamily: 'var(--font-mono)' };
const ymd = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
const DAY_COL = { green: 'var(--grn)', amber: 'var(--orn)', coral: 'var(--red)', idle: 'transparent' };
const hhmm = (t) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

export default function OpsCompliance() {
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [siteName, setSiteName] = useState('');
  const [month, setMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const [data, setData] = useState({ units: [], scheds: [], readings: [], corr: [], runs: [], maint: [], checklists: [], loading: true });
  const [selDay, setSelDay] = useState(null);

  const monthStart = useMemo(() => new Date(month.y, month.m, 1), [month]);
  const monthEnd = useMemo(() => new Date(month.y, month.m + 1, 1), [month]);

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const mFrom = ymd(monthStart), mTo = ymd(new Date(month.y, month.m + 1, 0));
    const [{ data: units }, { data: scheds }, { data: readings }, { data: corr }, { data: runs }, { data: maint }, { data: checklists }] = await Promise.all([
      fetchTempUnits(loc, true), fetchSchedules(loc),
      fetchReadings(monthStart.toISOString(), monthEnd.toISOString(), loc, 5000),
      fetchCorrectiveActions(monthStart.toISOString(), monthEnd.toISOString(), loc),
      fetchRunsRange(mFrom, mTo, loc),
      fetchMaintenance(loc),
      fetchChecklists(loc),
    ]);
    setData({ units: units || [], scheds: scheds || [], readings: readings || [], corr: corr || [], runs: runs || [], maint: maint || [], checklists: checklists || [], loading: false });
  }, [locId, monthStart, monthEnd, month]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { reload(); }, [month]);

  // resolve the site name for the subtitle
  useEffect(() => {
    let alive = true;
    (async () => {
      const loc = locId || getActiveLocationSync();
      if (!loc) return;
      try {
        const locs = await getAvailableLocations();
        const hit = (locs || []).find(l => l.id === loc);
        if (alive && hit?.name) setSiteName(hit.name);
      } catch { /* fall back gracefully to no site name */ }
    })();
    return () => { alive = false; };
  }, [locId]);

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

  // pick a default selected day so the right panel is populated on load: today if it's
  // in the visible month, else the most recent past day in this month.
  useEffect(() => {
    if (selDay && selDay.startsWith(`${month.y}-${String(month.m + 1).padStart(2, '0')}`)) return;
    const today = new Date();
    const inThisMonth = today.getFullYear() === month.y && today.getMonth() === month.m;
    if (inThisMonth) { setSelDay(ymd(today)); return; }
    const days = new Date(month.y, month.m + 1, 0).getDate();
    setSelDay(ymd(new Date(month.y, month.m, days)));
  }, [month, selDay]);

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
  const today = ymd(new Date());

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 18 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--t1)' }}>Compliance history</h1>
          <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 3 }}>{[siteName, monthLabel].filter(Boolean).join(' · ')}</div>
        </div>
        {/* month nav grouped into a rounded pill */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, padding: 3, borderRadius: 999, border: '1px solid var(--bdr)', background: 'var(--bg2)' }}>
          <button onClick={() => setMonth(m => ({ y: m.m === 0 ? m.y - 1 : m.y, m: (m.m + 11) % 12 }))} style={pillBtn} aria-label="Previous month">‹</button>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', minWidth: 110, textAlign: 'center', ...mono }}>{monthLabel}</span>
          <button onClick={() => setMonth(m => ({ y: m.m === 11 ? m.y + 1 : m.y, m: (m.m + 1) % 12 }))} style={pillBtn} aria-label="Next month">›</button>
        </div>
        {/* CSV export demoted to a secondary / ghost button */}
        <button onClick={exportCsv} style={ghostBtn}>Export CSV</button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 360px', gap: 18, alignItems: 'start' }}>
        {/* LEFT — calendar grid */}
        <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 16 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 6 }}>
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <div key={i} style={{ textAlign: 'center', fontSize: 11, color: 'var(--t3)', fontWeight: 700, ...mono }}>{d}</div>)}
            {cells.map((d, i) => {
              if (d == null) return <div key={i} />;
              const key = ymd(new Date(month.y, month.m, d));
              const status = dayStatus[key] || 'idle';
              const sel = selDay === key;
              const future = key > today;
              return (
                <button key={i} onClick={() => setSelDay(key)} style={{ aspectRatio: '1', borderRadius: 10, border: `1px solid ${sel ? 'var(--acc)' : 'var(--bdr)'}`, background: sel ? 'var(--acc-d)' : 'var(--bg2)', color: 'var(--t1)', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, padding: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: future ? 'var(--t4)' : 'var(--t1)', ...mono }}>{d}</span>
                  {!future && status !== 'idle' && <span style={{ width: 7, height: 7, borderRadius: 999, background: DAY_COL[status] }} />}
                </button>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 16, marginTop: 14, fontSize: 11.5, color: 'var(--t3)' }}>
            {[['green', 'Fully compliant'], ['amber', 'Minor exception'], ['coral', 'Failure / breach']].map(([c, l]) => <span key={c} style={{ display: 'flex', alignItems: 'center', gap: 6 }}><span style={{ width: 9, height: 9, borderRadius: 999, background: DAY_COL[c] }} />{l}</span>)}
          </div>
        </div>

        {/* RIGHT — day detail timeline */}
        {selDay && (
          <DayDetail
            day={selDay}
            units={data.units}
            readings={data.readings.filter(r => ymd(r.recordedAt) === selDay)}
            corr={data.corr.filter(c => ymd(c.createdAt) === selDay)}
            runs={data.runs.filter(r => r.runDate === selDay)}
            maint={data.maint.filter(m => ymd(m.createdAt) === selDay)}
            checklists={data.checklists}
          />
        )}
      </div>
    </div>
  );
}

const pillBtn = { width: 30, height: 30, borderRadius: 999, border: 0, background: 'transparent', color: 'var(--t1)', cursor: 'pointer', fontSize: 16, fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center' };
const ghostBtn = { padding: '9px 14px', borderRadius: 8, background: 'transparent', color: 'var(--t2)', border: '1px solid var(--bdr)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' };

// ── the day timeline ──────────────────────────────────────────────────────────
// Builds one time-sorted list of event cards from temperature rounds (rolled up per
// AM/PM round), checklist sign-offs, corrective actions and maintenance raised.
function DayDetail({ day, units, readings, corr, runs, maint, checklists }) {
  const uName = (id) => units.find(u => u.id === id)?.name || '—';
  const clName = (id) => checklists.find(c => c.id === id)?.name || 'Checklist';
  const clTotal = (id) => (checklists.find(c => c.id === id)?.tasks?.length) || 0;

  const events = useMemo(() => {
    const out = [];

    // (a) temperature rounds rolled up per AM/PM round
    const rounds = {}; // 'AM' | 'PM' → { reads:[] }
    readings.forEach(r => {
      const h = new Date(r.recordedAt).getHours();
      const round = h < 12 ? 'AM' : 'PM';
      (rounds[round] ??= []).push(r);
    });
    Object.entries(rounds).forEach(([round, reads]) => {
      const inRangeN = reads.filter(r => r.inRange).length;
      const total = reads.length;
      const last = reads.reduce((a, b) => new Date(a.recordedAt) > new Date(b.recordedAt) ? a : b);
      const firstAt = reads.reduce((a, b) => new Date(a.recordedAt) < new Date(b.recordedAt) ? a : b).recordedAt;
      out.push({
        at: firstAt,
        tone: inRangeN === total ? 'green' : 'coral',
        title: `${round} temperature round`,
        sub: `${inRangeN}/${total} in range · ${hhmm(last.recordedAt)}`,
      });
    });

    // (b) checklist runs signed off
    runs.forEach(r => {
      const total = clTotal(r.checklistId);
      out.push({
        at: r.completedAt || (day + 'T12:00:00'),
        tone: 'green',
        title: clName(r.checklistId),
        sub: `${total}/${total} · signed ${r.completedByName || '—'}`,
      });
    });

    // (c) corrective actions
    corr.forEach(c => {
      const reading = readings.find(r => r.id === c.sourceId);
      const unit = reading ? uName(reading.tempUnitId) : (c.sourceType === 'reading' ? 'Reading' : (c.sourceType || 'Unit'));
      const temp = reading ? displayTemp(reading.readingC, 'C').label : '';
      out.push({
        at: c.createdAt,
        tone: 'coral',
        title: [unit, temp].filter(Boolean).join(' '),
        sub: `corrective: ${(c.action || '').replace(/_/g, ' ') || '—'}`,
      });
    });

    // (d) maintenance raised
    maint.forEach(m => {
      out.push({
        at: m.createdAt,
        tone: 'maint',
        title: 'Maintenance raised',
        sub: `${m.assetType || m.title || 'asset'} · assigned ${hhmm(m.createdAt)}`,
      });
    });

    return out.sort((a, b) => new Date(a.at) - new Date(b.at));
  }, [readings, runs, corr, maint, day]); // eslint-disable-line react-hooks/exhaustive-deps

  // day summary: exceptions = breach readings + corrective actions + maintenance raised
  const breachReads = readings.filter(r => !r.inRange).length;
  const exceptions = corr.length || breachReads;
  const allCorrected = exceptions > 0 && corr.length > 0 && corr.every(c => c.status === 'closed' || c.status === 'resolved' || !!c.maintenanceRequestId);
  const plural = exceptions === 1 ? '' : 'S';

  const TONE_BORDER = { green: 'var(--grn)', coral: 'var(--red)', maint: 'var(--orn)' };

  return (
    <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 18 }}>
      <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--t1)' }}>{new Date(day + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</div>
      {exceptions > 0 && (
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em', marginTop: 4, marginBottom: 14, color: allCorrected ? 'var(--orn)' : 'var(--red)', ...mono }}>
          {`${exceptions} EXCEPTION${plural} · ${allCorrected ? 'CORRECTED' : 'OPEN'}`}
        </div>
      )}
      {exceptions === 0 && <div style={{ height: 14 }} />}

      {events.length === 0 ? (
        <div style={{ fontSize: 13, color: 'var(--t3)' }}>No activity logged.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {events.map((e, i) => (
            <div key={i} style={{ background: 'var(--bg2)', borderRadius: 10, borderLeft: `4px solid ${TONE_BORDER[e.tone] || 'var(--bdr2)'}`, padding: 12 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--t1)' }}>{e.title}</div>
              <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 3, ...mono }}>{e.sub}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
