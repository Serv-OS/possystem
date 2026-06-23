// OpsOverview — live compliance dashboard (Back Office → Operations → Compliance).
// KPI strip + today's unit status + recent breaches, in the same green/amber/coral
// language as the floor app.

import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase, getActiveLocationSync, getLocationId } from '../../../lib/supabase';
import { fetchTempUnits, fetchSchedules, fetchReadings, fetchCorrectiveActions, fetchMaintenance, fetchAlerts, ackAlert } from '../../../lib/ops/data';
import { useStore } from '../../../store';
import { hhmmToMin, runsOnDay, windowStatus, summarize, displayTemp } from '../../../lib/ops/temp';

const mono = { fontFamily: 'var(--font-mono)' };
const card = { background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '14px 16px' };
const todayBounds = () => { const s = new Date(); s.setHours(0, 0, 0, 0); const e = new Date(s); e.setDate(e.getDate() + 1); return { fromIso: s.toISOString(), toIso: e.toISOString() }; };
const STATE_COL = { done: 'var(--grn)', due: 'var(--orn)', over: 'var(--red)', idle: 'var(--t4)' };

// Per-site KPI roll-up (reused for the active site + every site in the league).
async function siteSnapshot(loc) {
  const { fromIso } = todayBounds();
  const [{ data: units }, { data: scheds }, { data: readings }, { data: corr }, { data: maint }] = await Promise.all([
    fetchTempUnits(loc), fetchSchedules(loc), fetchReadings(fromIso, null, loc, 3000), fetchCorrectiveActions(fromIso, null, loc), fetchMaintenance(loc),
  ]);
  const now = new Date(); const nowMin = now.getHours() * 60 + now.getMinutes();
  const schedByUnit = {}; (scheds || []).forEach(s => { (schedByUnit[s.tempUnitId] ??= []).push(s); });
  const readByUnit = {}; (readings || []).forEach(r => { (readByUnit[r.tempUnitId] ??= []).push(r); });
  const all = [];
  (units || []).forEach(u => (schedByUnit[u.id] || []).filter(s => runsOnDay(s.daysOfWeek, now)).forEach(s => {
    const wMin = hhmmToMin(s.timeOfDay) ?? 0;
    const satisfied = (readByUnit[u.id] || []).some(r => { const rd = new Date(r.recordedAt); return rd.getHours() * 60 + rd.getMinutes() >= wMin - 5; });
    all.push(windowStatus({ windowMin: wMin, graceMin: s.graceMinutes, nowMin, satisfied }));
  }));
  const sum = summarize(all);
  return { compliancePct: sum.compliancePct, checksDone: sum.done, checksTotal: sum.done + sum.due + sum.missed, exceptions: (corr || []).length, openMaint: (maint || []).filter(m => !['resolved', 'cancelled'].includes(m.status)).length };
}

export default function OpsOverview({ setSection }) {
  const showToast = useStore(s => s.showToast);
  const me = useStore(s => s.staff);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [st, setSt] = useState({ loading: true, units: [], byUnit: {}, summary: { compliancePct: 100, due: 0, missed: 0, done: 0, total: 0 }, corr: [], maint: [], alerts: [] });
  const [league, setLeague] = useState(null);   // [{id,name,kpi}] when >1 accessible site

  // Multi-site oversight: roll up every site the user can see (slice 6).
  useEffect(() => {
    let live = true;
    (async () => {
      const { fetchAccessibleLocations } = await import('../../../lib/db.js');
      const { data: locs } = await fetchAccessibleLocations();
      if (!live) return;
      if (!locs || locs.length <= 1) { setLeague([]); return; }
      const rows = await Promise.all(locs.map(async l => ({ id: l.id, name: l.name, kpi: await siteSnapshot(l.id) })));
      if (live) setLeague(rows);
    })().catch(() => { if (live) setLeague([]); });
    return () => { live = false; };
  }, []);

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const { fromIso, toIso } = todayBounds();
    const [{ data: units }, { data: scheds }, { data: readings }, { data: corr }, { data: maint }, { data: alerts }] = await Promise.all([
      fetchTempUnits(loc), fetchSchedules(loc), fetchReadings(fromIso, toIso, loc), fetchCorrectiveActions(fromIso, null, loc), fetchMaintenance(loc), fetchAlerts(loc, false),
    ]);
    const now = new Date(); const nowMin = now.getHours() * 60 + now.getMinutes();
    const schedByUnit = {}; (scheds || []).forEach(s => { (schedByUnit[s.tempUnitId] ??= []).push(s); });
    const readByUnit = {}; (readings || []).forEach(r => { (readByUnit[r.tempUnitId] ??= []).push(r); });
    const byUnit = {}; const all = [];
    (units || []).forEach(u => {
      const windows = (schedByUnit[u.id] || []).filter(s => runsOnDay(s.daysOfWeek, now)).map(s => {
        const wMin = hhmmToMin(s.timeOfDay) ?? 0;
        const satisfied = (readByUnit[u.id] || []).some(r => { const rd = new Date(r.recordedAt); return rd.getHours() * 60 + rd.getMinutes() >= wMin - 5; });
        return windowStatus({ windowMin: wMin, graceMin: s.graceMinutes, nowMin, satisfied });
      });
      const last = (readByUnit[u.id] || []).sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt))[0] || null;
      byUnit[u.id] = { state: windows.length ? summarize(windows).state : 'idle', last };
      windows.forEach(w => all.push(w));
    });
    setSt({ loading: false, units: units || [], byUnit, summary: summarize(all), corr: corr || [], maint: maint || [], alerts: alerts || [] });
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  // live alert push: a new breach alert refreshes the dashboard + toasts the manager
  useEffect(() => {
    if (!supabase || !locId) return;
    const ch = supabase.channel(`ops-alerts-${locId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'ops_alerts', filter: `location_id=eq.${locId}` },
        (p) => { showToast?.(p.new?.title || 'New ops alert', 'error'); reload(); })
      .subscribe();
    return () => { try { supabase.removeChannel(ch); } catch {} };
  }, [locId, reload, showToast]);

  const exceptions = useMemo(() => st.corr.length, [st.corr]);
  const openMaint = useMemo(() => st.maint.filter(m => m.status !== 'resolved' && m.status !== 'cancelled').length, [st.maint]);
  const openAlerts = useMemo(() => st.alerts.filter(a => a.status === 'sent'), [st.alerts]);
  const kpis = [
    { label: 'Compliance today', value: `${st.summary.compliancePct}%`, col: st.summary.compliancePct >= 90 ? 'var(--grn)' : st.summary.compliancePct >= 80 ? 'var(--orn)' : 'var(--red)' },
    { label: 'Checks done', value: `${st.summary.done}/${st.summary.done + st.summary.due + st.summary.missed}`, col: 'var(--t1)' },
    { label: 'Temp exceptions', value: exceptions, col: exceptions ? 'var(--red)' : 'var(--grn)' },
    { label: 'Open maintenance', value: openMaint, col: openMaint ? 'var(--orn)' : 'var(--grn)' },
  ];

  const ack = async (a) => { await ackAlert(a.id, 'Acknowledged', me?.name); showToast?.('Alert acknowledged', 'success'); reload(); };

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px' }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 4px', color: 'var(--t1)' }}>Compliance overview</h1>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 16 }}>{(league && league.length > 1 ? `${league.length} sites · ` : '')}{new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</div>

      {league && league.length > 1 && (() => {
        const g = league.reduce((a, r) => ({ comp: a.comp + r.kpi.compliancePct, done: a.done + r.kpi.checksDone, total: a.total + r.kpi.checksTotal, exc: a.exc + r.kpi.exceptions, maint: a.maint + r.kpi.openMaint }), { comp: 0, done: 0, total: 0, exc: 0, maint: 0 });
        const avg = Math.round(g.comp / league.length);
        const gk = [
          { label: 'Group compliance', value: `${avg}%`, col: avg >= 90 ? 'var(--grn)' : avg >= 80 ? 'var(--orn)' : 'var(--red)' },
          { label: 'Checks done today', value: `${g.done}/${g.total}`, col: 'var(--t1)' },
          { label: 'Temp exceptions', value: g.exc, col: g.exc ? 'var(--red)' : 'var(--grn)' },
          { label: 'Open maintenance', value: g.maint, col: g.maint ? 'var(--orn)' : 'var(--grn)' },
        ];
        const sorted = [...league].sort((a, b) => a.kpi.compliancePct - b.kpi.compliancePct);
        const barCol = (p) => p >= 90 ? 'var(--grn)' : p >= 80 ? 'var(--orn)' : 'var(--red)';
        return (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 14 }}>
              {gk.map(k => (
                <div key={k.label} style={{ ...card, borderLeft: `3px solid ${k.col}` }}>
                  <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', ...mono }}>{k.label}</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: k.col, marginTop: 6, ...mono }}>{k.value}</div>
                </div>
              ))}
            </div>
            <div style={{ ...card, marginBottom: 22, padding: 0, overflow: 'hidden' }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', padding: '12px 16px', borderBottom: '1px solid var(--bdr)', ...mono }}>Sites · worst first</div>
              {sorted.map(r => (
                <div key={r.id} style={{ display: 'grid', gridTemplateColumns: '1.6fr 1.4fr 90px 90px', gap: 12, alignItems: 'center', padding: '11px 16px', borderBottom: '1px solid var(--bg2)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--t1)' }}><span style={{ width: 8, height: 8, borderRadius: 999, background: barCol(r.kpi.compliancePct) }} />{r.name}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1, height: 8, borderRadius: 4, background: 'var(--bg3)', overflow: 'hidden' }}><div style={{ height: '100%', width: `${r.kpi.compliancePct}%`, background: barCol(r.kpi.compliancePct) }} /></div>
                    <span style={{ fontSize: 12.5, fontWeight: 700, color: barCol(r.kpi.compliancePct), ...mono }}>{r.kpi.compliancePct}%</span>
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 13, color: r.kpi.exceptions ? 'var(--red)' : 'var(--t3)', ...mono }} title="temp exceptions">{r.kpi.exceptions}</div>
                  <div style={{ textAlign: 'right', fontSize: 13, color: r.kpi.openMaint ? 'var(--orn)' : 'var(--t3)', ...mono }} title="open maintenance">{r.kpi.openMaint}</div>
                </div>
              ))}
              <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1.4fr 90px 90px', gap: 12, padding: '6px 16px 10px', fontSize: 10, color: 'var(--t4)', textTransform: 'uppercase', letterSpacing: '.05em', ...mono }}>
                <span>Site</span><span>Compliance</span><span style={{ textAlign: 'right' }}>Temp</span><span style={{ textAlign: 'right' }}>Maint.</span>
              </div>
            </div>
            <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8, ...mono }}>This site</div>
          </>
        );
      })()}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 18 }}>
        {kpis.map(k => (
          <div key={k.label} style={{ ...card, borderLeft: `3px solid ${k.col}` }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', ...mono }}>{k.label}</div>
            <div style={{ fontSize: 26, fontWeight: 800, color: k.col, marginTop: 6, ...mono }}>{k.value}</div>
          </div>
        ))}
      </div>

      {openAlerts.length > 0 && (
        <div style={{ ...card, borderLeft: '3px solid var(--red)', marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8, ...mono }}>Unacknowledged alerts</div>
          {openAlerts.map(a => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid var(--bg2)' }}>
              <div style={{ flex: 1 }}><div style={{ fontSize: 13, color: 'var(--t1)', fontWeight: 600 }}>{a.title}</div><div style={{ fontSize: 11.5, color: 'var(--t3)' }}>{a.body} · {new Date(a.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</div></div>
              <button onClick={() => ack(a)} className="btn btn-acc" style={{ padding: '6px 14px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>Acknowledge</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div style={card}>
          <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 10, ...mono }}>Units today</div>
          {st.units.length === 0 && <div style={{ fontSize: 13, color: 'var(--t3)' }}>No units configured. <button onClick={() => setSection?.('ops-temperature')} style={{ background: 'none', border: 0, color: 'var(--acc)', cursor: 'pointer', fontWeight: 700, fontFamily: 'inherit' }}>Add units →</button></div>}
          {st.units.map(u => { const b = st.byUnit[u.id] || {}; return (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--bg2)' }}>
              <span style={{ width: 9, height: 9, borderRadius: 999, background: STATE_COL[b.state] }} />
              <span style={{ flex: 1, fontSize: 13, color: 'var(--t1)' }}>{u.name}</span>
              {b.last ? <span style={{ fontSize: 13, fontWeight: 700, color: b.last.inRange ? 'var(--grn)' : 'var(--red)', ...mono }}>{displayTemp(b.last.readingC, u.displayUnit).label}</span> : <span style={{ fontSize: 12, color: 'var(--t4)', ...mono }}>—</span>}
            </div>
          ); })}
        </div>
        <div style={card}>
          <div style={{ fontSize: 11, fontWeight: 800, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 10, ...mono }}>Today's corrective actions</div>
          {st.corr.length === 0 ? <div style={{ fontSize: 13, color: 'var(--grn)' }}>None — all clear.</div> : st.corr.map(c => (
            <div key={c.id} style={{ padding: '7px 0', borderBottom: '1px solid var(--bg2)' }}>
              <div style={{ fontSize: 13, color: 'var(--t1)' }}>{c.action?.replace(/_/g, ' ')} <span style={{ color: c.severity === 'critical' ? 'var(--red)' : 'var(--orn)', fontSize: 11, fontWeight: 700 }}>· {c.severity}</span></div>
              <div style={{ fontSize: 11.5, color: 'var(--t3)' }}>{c.operatorName || '—'} · {new Date(c.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}{c.maintenanceRequestId ? ' · maintenance raised' : ''}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
