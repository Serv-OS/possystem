// OpsChecklists — admin builder for task checklists (Back Office → Operations → Checklists).
// Templates here drive what staff see on the floor app's Checklists area.

import { useEffect, useState, useCallback } from 'react';
import { useStore } from '../../../store';
import { getActiveLocationSync, getLocationId } from '../../../lib/supabase';
import { fetchChecklists, upsertChecklist, archiveChecklist } from '../../../lib/ops/checklists';
import { fetchTempUnits } from '../../../lib/ops/data';

const AREAS = ['BOH', 'FOH', 'MOD', 'opening', 'closing', 'cleaning', 'delivery', 'other'];
const DAYS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun']];
const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };

export default function OpsChecklists() {
  const showToast = useStore(s => s.showToast);
  const [locId, setLocId] = useState(getActiveLocationSync());
  const [lists, setLists] = useState([]);
  const [units, setUnits] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

  const reload = useCallback(async () => {
    const loc = locId || getActiveLocationSync() || await getLocationId().catch(() => null);
    if (loc && loc !== locId) setLocId(loc);
    const [{ data }, { data: u }] = await Promise.all([fetchChecklists(loc), fetchTempUnits(loc)]);
    setLists(data || []); setUnits(u || []); setLoading(false);
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 4 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--t1)', flex: 1 }}>Checklists</h1>
        <button onClick={() => setEditing('new')} className="btn btn-acc" style={{ padding: '9px 16px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>+ New checklist</button>
      </div>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 16 }}>Opening / closing / cleaning / QA routines staff work through on the floor app.</div>

      {loading ? <div style={{ color: 'var(--t3)' }}>Loading…</div> : lists.length === 0 ? (
        <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 20, color: 'var(--t3)' }}>No checklists yet.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {lists.map(l => (
            <button key={l.id} onClick={() => setEditing(l)} style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '12px 16px', cursor: 'pointer', textAlign: 'left', color: 'var(--t1)', fontFamily: 'inherit' }}>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: 'var(--acc)', background: 'var(--acc-d)', padding: '3px 8px', borderRadius: 6 }}>{l.area}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{l.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--t3)' }}>{l.tasks.length} tasks · {l.frequency}{l.timeOfDay ? ` · ${l.timeOfDay}` : ''}{l.assigneeRole ? ` · ${l.assigneeRole}` : ''}</div>
              </div>
              <span style={{ fontSize: 12, color: 'var(--t3)' }}>Edit ›</span>
            </button>
          ))}
        </div>
      )}

      {editing && <Editor locId={locId} units={units} list={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} showToast={showToast} />}
    </div>
  );
}

function Editor({ locId, units, list, onClose, onSaved, showToast }) {
  const [d, setD] = useState(() => list ? { ...list } : { name: '', area: 'opening', frequency: 'daily', daysOfWeek: [], timeOfDay: '', graceMinutes: 120, assigneeRole: 'Staff', active: true });
  const [tasks, setTasks] = useState(() => list ? list.tasks.map(t => ({ ...t })) : [{ label: '', taskType: 'check', evidenceRequired: false, tempUnitId: null }]);
  const [busy, setBusy] = useState(false);
  const up = (k, v) => setD(x => ({ ...x, [k]: v }));
  const upTask = (i, k, v) => setTasks(t => t.map((x, j) => j === i ? { ...x, [k]: v } : x));
  const move = (i, dir) => setTasks(t => { const a = [...t]; const j = i + dir; if (j < 0 || j >= a.length) return a; [a[i], a[j]] = [a[j], a[i]]; return a; });
  const toggleDay = (day) => setD(x => ({ ...x, daysOfWeek: x.daysOfWeek?.includes(Number(day)) ? x.daysOfWeek.filter(dd => dd !== Number(day)) : [...(x.daysOfWeek || []), Number(day)] }));

  const save = async () => {
    if (!d.name.trim()) { showToast?.('Name required', 'error'); return; }
    setBusy(true);
    const { error } = await upsertChecklist(d, tasks, locId);
    setBusy(false);
    if (error) { showToast?.(error.message || 'Save failed', 'error'); return; }
    showToast?.('Saved', 'success'); onSaved();
  };

  return (
    <div className="modal-back" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'grid', placeItems: 'center', zIndex: 9999 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ background: 'var(--bg1)', border: '1px solid var(--bdr2)', borderRadius: 16, width: '100%', maxWidth: 580, maxHeight: '88vh', overflowY: 'auto', padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: 'var(--t1)' }}>{list ? 'Edit checklist' : 'New checklist'}</div>
          <button onClick={onClose} style={{ background: 'transparent', border: 0, fontSize: 22, color: 'var(--t3)', cursor: 'pointer' }}>×</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <div><label style={lbl}>Name</label><input style={field} value={d.name} onChange={e => up('name', e.target.value)} placeholder="Opening checks" /></div>
          <div><label style={lbl}>Area</label><select style={field} value={d.area} onChange={e => up('area', e.target.value)}>{AREAS.map(a => <option key={a} value={a}>{a}</option>)}</select></div>
          <div><label style={lbl}>Frequency</label><select style={field} value={d.frequency} onChange={e => up('frequency', e.target.value)}>{['daily', 'weekly', 'monthly'].map(f => <option key={f} value={f}>{f}</option>)}</select></div>
          <div><label style={lbl}>Due time</label><input style={field} value={d.timeOfDay || ''} onChange={e => up('timeOfDay', e.target.value)} placeholder="09:00" /></div>
          <div><label style={lbl}>Assignee role</label><input style={field} value={d.assigneeRole || ''} onChange={e => up('assigneeRole', e.target.value)} placeholder="Staff / MOD" /></div>
          <div><label style={lbl}>Grace (min)</label><input type="number" style={field} value={d.graceMinutes ?? 120} onChange={e => up('graceMinutes', Number(e.target.value) || 0)} /></div>
        </div>
        <div style={{ marginTop: 10 }}><label style={lbl}>Days (blank = every day)</label>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{DAYS.map(([dv, dl]) => { const on = (d.daysOfWeek || []).includes(Number(dv)); return <button key={dv} onClick={() => toggleDay(dv)} style={{ padding: '5px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr)'}`, background: on ? 'var(--acc-d)' : 'var(--bg1)', color: on ? 'var(--acc)' : 'var(--t3)' }}>{dl}</button>; })}</div>
        </div>

        <div style={{ marginTop: 18, marginBottom: 8, fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>Tasks</div>
        {tasks.map((t, i) => (
          <div key={i} style={{ background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 10, padding: 10, marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <button onClick={() => move(i, -1)} style={arrowBtn}>▲</button>
                <button onClick={() => move(i, 1)} style={arrowBtn}>▼</button>
              </div>
              <input style={{ ...field, flex: 1 }} placeholder="Task description" value={t.label} onChange={e => upTask(i, 'label', e.target.value)} />
              <select style={{ ...field, width: 100 }} value={t.taskType} onChange={e => upTask(i, 'taskType', e.target.value)}><option value="check">Check</option><option value="value">Value</option><option value="photo">Photo</option></select>
              <button onClick={() => setTasks(tasks.filter((_, j) => j !== i))} style={{ background: 'transparent', border: 0, color: 'var(--red)', cursor: 'pointer', fontSize: 16 }}>×</button>
            </div>
            <div style={{ display: 'flex', gap: 14, marginTop: 8, flexWrap: 'wrap', paddingLeft: 30 }}>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--t2)', cursor: 'pointer' }}><input type="checkbox" checked={t.evidenceRequired} onChange={e => upTask(i, 'evidenceRequired', e.target.checked)} /> Require photo</label>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--t2)' }}>Temp-linked:
                <select style={{ ...field, width: 160, padding: '4px 6px' }} value={t.tempUnitId || ''} onChange={e => upTask(i, 'tempUnitId', e.target.value || null)}>
                  <option value="">none</option>{units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </label>
            </div>
          </div>
        ))}
        <button onClick={() => setTasks([...tasks, { label: '', taskType: 'check', evidenceRequired: false, tempUnitId: null }])} style={{ background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '7px 14px', fontSize: 12, color: 'var(--t1)', cursor: 'pointer', fontFamily: 'inherit' }}>+ Add task</button>

        <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
          {list && <button onClick={async () => { await archiveChecklist(list.id, locId); onSaved(); }} style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--red-d)', border: '1px solid var(--red-b)', color: 'var(--red)', cursor: 'pointer', fontFamily: 'inherit' }}>Archive</button>}
          <button onClick={save} disabled={busy} className="btn btn-acc" style={{ marginLeft: 'auto', padding: '10px 22px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.6 : 1, fontFamily: 'inherit' }}>{busy ? 'Saving…' : 'Save checklist'}</button>
        </div>
      </div>
    </div>
  );
}
const arrowBtn = { background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 9, lineHeight: 1, padding: 1 };
