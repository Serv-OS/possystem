// OpsTemperature — admin config for temperature units, thresholds & schedules.
// These thresholds are the SINGLE SOURCE OF TRUTH for in-range vs breach; the mobile
// ops surface reads them. (Back Office → Operations → Temperature.)

import { useEffect, useMemo, useState, useCallback } from 'react';
import { useStore } from '../../../store';
import { getActiveLocationSync, getLocationId } from '../../../lib/supabase';
import { fetchTempUnits, upsertTempUnit, archiveTempUnit, fetchSchedules, upsertSchedule, deleteSchedule } from '../../../lib/ops/data';
import { TYPE_DEFAULTS, typeDefault, displayTemp, toStoredC } from '../../../lib/ops/temp';

const TYPES = Object.entries(TYPE_DEFAULTS).map(([id, d]) => ({ id, label: d.label }));
const DAYS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun']];
const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };
const th = { padding: '8px 10px', borderBottom: '1px solid var(--bdr)', fontWeight: 600, color: 'var(--t3)', textAlign: 'left', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.04em' };
const td = { padding: '9px 10px', borderBottom: '1px solid var(--bg2)', fontSize: 13, color: 'var(--t1)' };

export default function OpsTemperature() {
  const showToast = useStore(s => s.showToast);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [units, setUnits] = useState([]);
  const [scheds, setScheds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dispUnit, setDispUnit] = useState('C');
  const [editing, setEditing] = useState(null);   // unit being edited (or 'new')

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const [{ data: u }, { data: s }] = await Promise.all([fetchTempUnits(loc), fetchSchedules(loc)]);
    setUnits(u || []); setScheds(s || []); setLoading(false);
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const schedByUnit = useMemo(() => { const m = {}; scheds.forEach(s => { (m[s.tempUnitId] ??= []).push(s); }); return m; }, [scheds]);

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--t1)', flex: 1 }}>Temperature units</h1>
        <div className="seg" style={{ display: 'flex', gap: 2, background: 'var(--bg2)', borderRadius: 8, padding: 3 }}>
          {['C', 'F'].map(x => <button key={x} onClick={() => setDispUnit(x)} style={{ padding: '6px 12px', borderRadius: 6, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700, fontSize: 13, background: dispUnit === x ? 'var(--acc)' : 'transparent', color: dispUnit === x ? '#fff' : 'var(--t2)' }}>°{x}</button>)}
        </div>
        <button onClick={() => setEditing('new')} className="btn btn-acc" style={{ padding: '9px 16px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>+ Add unit</button>
      </div>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 16 }}>{units.length} monitored · these thresholds are what the floor app checks against.</div>

      {loading ? <div style={{ color: 'var(--t3)' }}>Loading…</div> : units.length === 0 ? (
        <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 20, color: 'var(--t3)' }}>No units yet — add your fridges, freezers, hot-holds and a delivery probe.</div>
      ) : (
        <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr>{['Unit', 'Type', 'Target range', 'Schedule', ''].map((h, i) => <th key={h} style={{ ...th, textAlign: i === 4 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
            <tbody>
              {units.map(u => {
                const rows = schedByUnit[u.id] || [];
                return (
                  <tr key={u.id}>
                    <td style={td}><div style={{ fontWeight: 600 }}>{u.name}</div>{u.area && <div style={{ fontSize: 11, color: 'var(--t3)' }}>{u.area}</div>}</td>
                    <td style={{ ...td, color: 'var(--t2)' }}>{typeDefault(u.type).label}</td>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{u.targetMinC == null ? '—' : `${displayTemp(u.targetMinC, dispUnit).value}–${displayTemp(u.targetMaxC, dispUnit).value}°${dispUnit}`}</td>
                    <td style={{ ...td, color: 'var(--t2)', fontSize: 12 }}>{rows.length ? rows.map(r => r.label || r.timeOfDay).join(' / ') : <span style={{ color: 'var(--t4)' }}>none</span>}</td>
                    <td style={{ ...td, textAlign: 'right' }}><button onClick={() => setEditing(u)} style={{ background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 7, padding: '5px 12px', fontSize: 12, color: 'var(--t1)', cursor: 'pointer', fontFamily: 'inherit' }}>Edit</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 12 }}>Defaults follow FSA / Safer Food Better Business: chilled ≤8°C (target 1–4); frozen ≤−18°C; hot holding ≥63°C. Editable per unit.</div>

      {editing && <UnitEditor locId={locId} unit={editing === 'new' ? null : editing} schedules={editing === 'new' ? [] : (schedByUnit[editing.id] || [])} dispUnit={dispUnit}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} showToast={showToast} />}
    </div>
  );
}

function UnitEditor({ locId, unit, schedules, dispUnit, onClose, onSaved, showToast }) {
  const [d, setD] = useState(() => unit ? { ...unit } : { name: '', type: 'fridge', area: '', targetMinC: TYPE_DEFAULTS.fridge.min, targetMaxC: TYPE_DEFAULTS.fridge.max, displayUnit: 'C', guidance: '', active: true });
  const [rows, setRows] = useState(schedules.map(s => ({ ...s })));
  const [busy, setBusy] = useState(false);
  const up = (k, v) => setD(x => ({ ...x, [k]: v }));
  const pickType = (t) => { const def = typeDefault(t); setD(x => ({ ...x, type: t, targetMinC: x.targetMinC ?? def.min, targetMaxC: x.targetMaxC ?? def.max, guidance: x.guidance || def.guidance })); };
  // edit ranges in the chosen display unit, store °C
  const minDisp = d.targetMinC == null ? '' : displayTemp(d.targetMinC, dispUnit).value;
  const maxDisp = d.targetMaxC == null ? '' : displayTemp(d.targetMaxC, dispUnit).value;

  const save = async () => {
    if (!d.name.trim()) { showToast?.('Name required', 'error'); return; }
    setBusy(true);
    const { data: saved, error } = await upsertTempUnit(d, locId);
    if (error || !saved) { setBusy(false); showToast?.(error?.message || 'Save failed', 'error'); return; }
    // sync schedules
    for (const r of rows) { if (r.timeOfDay) await upsertSchedule({ ...r, tempUnitId: saved.id }, locId); }
    setBusy(false); showToast?.('Saved', 'success'); onSaved();
  };
  const addRow = () => setRows(r => [...r, { label: '', timeOfDay: '', daysOfWeek: [], graceMinutes: 60 }]);
  const upRow = (i, k, v) => setRows(r => r.map((x, j) => j === i ? { ...x, [k]: v } : x));
  const rmRow = async (i) => { const r = rows[i]; if (r.id) await deleteSchedule(r.id, locId); setRows(rows.filter((_, j) => j !== i)); };
  const toggleDay = (i, day) => setRows(r => r.map((x, j) => j === i ? { ...x, daysOfWeek: x.daysOfWeek?.includes(Number(day)) ? x.daysOfWeek.filter(dd => dd !== Number(day)) : [...(x.daysOfWeek || []), Number(day)] } : x));

  return (
    <div className="modal-back" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'grid', placeItems: 'center', zIndex: 9999 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ background: 'var(--bg1)', border: '1px solid var(--bdr2)', borderRadius: 16, width: '100%', maxWidth: 560, maxHeight: '88vh', overflowY: 'auto', padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--t1)' }}>{unit ? 'Edit unit' : 'Add unit'}</div>
          <button onClick={onClose} style={{ background: 'transparent', border: 0, fontSize: 22, color: 'var(--t3)', cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div><label style={lbl}>Name</label><input style={field} value={d.name} onChange={e => up('name', e.target.value)} placeholder="Walk-in fridge" /></div>
          <div><label style={lbl}>Area</label><input style={field} value={d.area || ''} onChange={e => up('area', e.target.value)} placeholder="Kitchen" /></div>
          <div><label style={lbl}>Type</label>
            <select style={field} value={d.type} onChange={e => pickType(e.target.value)}>{TYPES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}</select>
          </div>
          <div><label style={lbl}>Display</label>
            <select style={field} value={d.displayUnit} onChange={e => up('displayUnit', e.target.value)}><option value="C">°C</option><option value="F">°F</option></select>
          </div>
          <div><label style={lbl}>Target min (°{dispUnit})</label><input type="number" step="any" style={field} value={minDisp} onChange={e => up('targetMinC', toStoredC(e.target.value, dispUnit))} /></div>
          <div><label style={lbl}>Target max (°{dispUnit})</label><input type="number" step="any" style={field} value={maxDisp} onChange={e => up('targetMaxC', toStoredC(e.target.value, dispUnit))} /></div>
        </div>
        <div style={{ marginTop: 12 }}><label style={lbl}>Guidance shown at entry</label><textarea style={{ ...field, minHeight: 50, resize: 'vertical' }} value={d.guidance || ''} onChange={e => up('guidance', e.target.value)} /></div>

        <div style={{ marginTop: 18, marginBottom: 8, fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>Check schedule</div>
        {rows.map((r, i) => (
          <div key={i} style={{ background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 10, padding: 12, marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <input style={{ ...field, width: 90 }} placeholder="AM" value={r.label || ''} onChange={e => upRow(i, 'label', e.target.value)} />
              <input style={{ ...field, width: 90 }} placeholder="06:00" value={r.timeOfDay || ''} onChange={e => upRow(i, 'timeOfDay', e.target.value)} />
              <input type="number" style={{ ...field, width: 90 }} placeholder="grace" value={r.graceMinutes ?? 60} onChange={e => upRow(i, 'graceMinutes', Number(e.target.value) || 0)} title="grace minutes" />
              <button onClick={() => rmRow(i)} style={{ marginLeft: 'auto', background: 'transparent', border: 0, color: 'var(--red)', cursor: 'pointer', fontSize: 16 }}>×</button>
            </div>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {DAYS.map(([dv, dl]) => { const on = (r.daysOfWeek || []).includes(Number(dv)); return <button key={dv} onClick={() => toggleDay(i, dv)} style={{ padding: '4px 9px', borderRadius: 6, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr)'}`, background: on ? 'var(--acc-d)' : 'var(--bg1)', color: on ? 'var(--acc)' : 'var(--t3)' }}>{dl}</button>; })}
              <span style={{ fontSize: 10.5, color: 'var(--t4)', alignSelf: 'center', marginLeft: 4 }}>blank = every day</span>
            </div>
          </div>
        ))}
        <button onClick={addRow} style={{ background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '7px 14px', fontSize: 12, color: 'var(--t1)', cursor: 'pointer', fontFamily: 'inherit' }}>+ Add a check time</button>

        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          {unit && <button onClick={async () => { await archiveTempUnit(unit.id, locId); onSaved(); }} className="btn btn-red" style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--red-d)', border: '1px solid var(--red-b)', color: 'var(--red)', cursor: 'pointer', fontFamily: 'inherit' }}>Archive</button>}
          <button onClick={save} disabled={busy} className="btn btn-acc" style={{ marginLeft: 'auto', padding: '10px 22px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.6 : 1, fontFamily: 'inherit' }}>{busy ? 'Saving…' : 'Save unit'}</button>
        </div>
      </div>
    </div>
  );
}
