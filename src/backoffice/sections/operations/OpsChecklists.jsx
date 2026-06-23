// OpsChecklists — admin builder for checklist templates (Back Office → Operations → Checklists).
// Two-pane master/detail: left = template list, right = inline editor.
// Templates here drive what staff see on the floor app's Checklists area.

import { useEffect, useState, useCallback } from 'react';
import { useStore } from '../../../store';
import { getActiveLocationSync, getLocationId } from '../../../lib/supabase';
import { fetchChecklists, upsertChecklist, archiveChecklist } from '../../../lib/ops/checklists';
import { fetchTempUnits } from '../../../lib/ops/data';
import { Icon } from '../../../components/ServOSIcons';

const AREAS = ['BOH', 'FOH', 'MOD', 'opening', 'closing', 'cleaning', 'delivery', 'other'];
const DAYS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun']];
const ASSIGNEES = ['Staff', 'MOD', 'Opening duty', 'Closing duty', 'Kitchen', 'Front of house', 'Cleaner'];
const field = { width: '100%', background: 'var(--bg2)', color: 'var(--t1)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '8px 10px', fontSize: 13, outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit' };
const lbl = { display: 'block', fontSize: 11, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 5 };
const monoLbl = { display: 'block', fontSize: 10.5, fontWeight: 700, color: 'var(--t3)', textTransform: 'uppercase', letterSpacing: '.08em', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' };

const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
const freqLine = (l) => `${cap(l.frequency || '')}${l.timeOfDay ? ` · ${l.timeOfDay}` : ''}`;
// relative-time helper → "Nd ago" / "Nh ago" / "just now"
function relTime(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!t) return null;
  const diff = Date.now() - t;
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

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
    const next = data || [];
    setLists(next); setUnits(u || []); setLoading(false);
    // Default-select the first template so the right pane is always populated.
    setEditing(prev => {
      if (prev === 'new') return prev;
      if (prev && prev.id) { const fresh = next.find(x => x.id === prev.id); if (fresh) return fresh; }
      return next.length ? next[0] : null;
    });
  }, [locId]);
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  // subtitle: "Applies to all sites · last edited Nd ago"
  const lastEditedIso = lists.reduce((acc, l) => (l.updatedAt && (!acc || l.updatedAt > acc) ? l.updatedAt : acc), null);
  const lastRel = relTime(lastEditedIso);
  const subtitle = lastRel ? `Applies to all sites · last edited ${lastRel}` : 'Applies to all sites';

  return (
    <div style={{ height: '100%', overflowY: 'auto', background: 'var(--bg0)', padding: '22px 26px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 2 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--t1)', flex: 1 }}>Checklist templates</h1>
        <button onClick={() => setEditing('new')} className="btn btn-acc" style={{ padding: '9px 16px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>+ New template</button>
      </div>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 16 }}>{subtitle}</div>

      {loading ? <div style={{ color: 'var(--t3)' }}>Loading…</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16, alignItems: 'start' }}>
          {/* Left: template list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {lists.length === 0 ? (
              <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 12, padding: 20, color: 'var(--t3)', fontSize: 13 }}>No templates yet.</div>
            ) : lists.map(l => {
              const sel = editing && editing.id === l.id;
              return (
                <button key={l.id} onClick={() => setEditing(l)} style={{
                  display: 'block', textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--t1)',
                  background: sel ? 'var(--acc-d)' : 'var(--bg1)',
                  border: '1px solid var(--bdr)', borderLeft: sel ? '3px solid var(--acc)' : '1px solid var(--bdr)',
                  borderRadius: 12, padding: sel ? '12px 16px 12px 14px' : '12px 16px',
                }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: sel ? 'var(--acc)' : 'var(--t1)' }}>{l.name || 'Untitled template'}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>{freqLine(l)}</div>
                </button>
              );
            })}
          </div>

          {/* Right: inline editor */}
          <div>
            {editing ? (
              <Editor key={editing === 'new' ? 'new' : editing.id} locId={locId} units={units} list={editing === 'new' ? null : editing}
                onClose={() => setEditing(lists.length ? lists[0] : null)} onSaved={reload} showToast={showToast} />
            ) : (
              <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 16, padding: 40, color: 'var(--t3)', fontSize: 13, textAlign: 'center' }}>
                Select a template, or create a new one.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Editor({ locId, units, list, onClose, onSaved, showToast }) {
  const [d, setD] = useState(() => list ? { ...list } : { name: '', area: 'opening', frequency: 'daily', daysOfWeek: [], timeOfDay: '', graceMinutes: 120, assigneeRole: 'Staff', active: true });
  const [tasks, setTasks] = useState(() => list ? list.tasks.map(t => ({ ...t })) : [{ label: '', taskType: 'check', evidenceRequired: false, tempUnitId: null, active: true }]);
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
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

  // Frequency dropdown combines frequency + time (e.g. "Daily · 07:00").
  const freqValue = `${d.frequency || 'daily'}|${d.timeOfDay || ''}`;
  const FREQ_OPTS = [
    ['daily|07:00', 'Daily · 07:00'], ['daily|22:00', 'Daily · 22:00'], ['daily|', 'Daily'],
    ['weekly|', 'Weekly'], ['monthly|', 'Monthly'],
  ];
  // ensure the current combo is selectable even if not in the canned list
  const hasFreqOpt = FREQ_OPTS.some(([v]) => v === freqValue);
  const freqOpts = hasFreqOpt ? FREQ_OPTS : [[freqValue, freqLine(d) || cap(d.frequency || 'daily')], ...FREQ_OPTS];
  const onFreqChange = (e) => { const [f, t] = e.target.value.split('|'); setD(x => ({ ...x, frequency: f, timeOfDay: t || '' })); };

  const hasAssignee = ASSIGNEES.some(a => a === (d.assigneeRole || ''));

  return (
    <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr2)', borderRadius: 16, padding: 22 }}>
      {/* Name */}
      <label style={monoLbl}>Template name</label>
      <input
        value={d.name}
        onChange={e => up('name', e.target.value)}
        placeholder="Untitled template"
        style={{ width: '100%', background: 'transparent', color: 'var(--t1)', border: 0, borderBottom: '1px solid transparent', padding: '4px 0', marginTop: 4, marginBottom: 18, fontSize: 24, fontWeight: 700, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box' }}
        onFocus={e => e.target.style.borderBottom = '1px solid var(--acc-b)'}
        onBlur={e => e.target.style.borderBottom = '1px solid transparent'}
      />

      {/* Two primary dropdowns */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 18 }}>
        <div>
          <label style={monoLbl}>Frequency</label>
          <select style={{ ...field, marginTop: 5 }} value={freqValue} onChange={onFreqChange}>
            {freqOpts.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
          </select>
        </div>
        <div>
          <label style={monoLbl}>Assignee</label>
          <select style={{ ...field, marginTop: 5 }} value={d.assigneeRole || ''} onChange={e => up('assigneeRole', e.target.value)}>
            {!hasAssignee && d.assigneeRole ? <option value={d.assigneeRole}>{d.assigneeRole}</option> : null}
            {ASSIGNEES.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>

      {/* Tasks */}
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ ...monoLbl, marginBottom: 0, color: 'var(--t2)' }}>{`Tasks · ${tasks.length}`}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {tasks.map((t, i) => (
          <TaskPill
            key={i}
            t={t}
            editing={editingTask === i}
            onLabel={(v) => upTask(i, 'label', v)}
            onEdit={() => setEditingTask(i)}
            onEndEdit={() => setEditingTask(null)}
            onCamera={() => upTask(i, 'evidenceRequired', !t.evidenceRequired)}
            onToggle={() => upTask(i, 'active', t.active === false)}
            onUp={() => move(i, -1)}
            onDown={() => move(i, 1)}
            onDelete={() => setTasks(tasks.filter((_, j) => j !== i))}
          />
        ))}
      </div>

      <button onClick={() => setTasks([...tasks, { label: '', taskType: 'check', evidenceRequired: false, tempUnitId: null, active: true }])} style={{ marginTop: 10, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '7px 14px', fontSize: 12, color: 'var(--t1)', cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Icon name="plus" size={13} /> Add task
      </button>

      {/* Advanced (Area / Grace / Days / Temp-link) */}
      <div style={{ marginTop: 18, borderTop: '1px solid var(--bdr)', paddingTop: 14 }}>
        <button onClick={() => setShowAdvanced(s => !s)} style={{ background: 'transparent', border: 0, color: 'var(--t3)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 6, padding: 0 }}>
          <Icon name="chevron" size={13} /> {showAdvanced ? 'Hide advanced' : 'Advanced settings'}
        </button>

        {showAdvanced && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
              <div><label style={lbl}>Area</label><select style={field} value={d.area} onChange={e => up('area', e.target.value)}>{AREAS.map(a => <option key={a} value={a}>{a}</option>)}</select></div>
              <div><label style={lbl}>Due time</label><input style={field} value={d.timeOfDay || ''} onChange={e => up('timeOfDay', e.target.value)} placeholder="09:00" /></div>
              <div><label style={lbl}>Grace (min)</label><input type="number" style={field} value={d.graceMinutes ?? 120} onChange={e => up('graceMinutes', Number(e.target.value) || 0)} /></div>
            </div>
            <div style={{ marginTop: 12 }}><label style={lbl}>Days (blank = every day)</label>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>{DAYS.map(([dv, dl]) => { const on = (d.daysOfWeek || []).includes(Number(dv)); return <button key={dv} onClick={() => toggleDay(dv)} style={{ padding: '5px 10px', borderRadius: 6, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', border: `1px solid ${on ? 'var(--acc)' : 'var(--bdr)'}`, background: on ? 'var(--acc-d)' : 'var(--bg1)', color: on ? 'var(--acc)' : 'var(--t3)' }}>{dl}</button>; })}</div>
            </div>
            {/* per-task temp-unit linking */}
            <div style={{ marginTop: 14 }}>
              <label style={lbl}>Temp-link tasks</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {tasks.map((t, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ flex: 1, fontSize: 12, color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.label || `Task ${i + 1}`}</span>
                    <select style={{ ...field, width: 180, padding: '4px 6px' }} value={t.tempUnitId || ''} onChange={e => upTask(i, 'tempUnitId', e.target.value || null)}>
                      <option value="">none</option>{units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
        {list && <button onClick={async () => { await archiveChecklist(list.id, locId); onSaved(); }} style={{ padding: '10px 14px', borderRadius: 8, background: 'var(--red-d)', border: '1px solid var(--red-b)', color: 'var(--red)', cursor: 'pointer', fontFamily: 'inherit' }}>Archive</button>}
        {list && <button onClick={onClose} style={{ padding: '10px 14px', borderRadius: 8, background: 'transparent', border: '1px solid var(--bdr2)', color: 'var(--t2)', cursor: 'pointer', fontFamily: 'inherit' }}>Cancel</button>}
        <button onClick={save} disabled={busy} className="btn btn-acc" style={{ marginLeft: 'auto', padding: '10px 22px', borderRadius: 8, background: 'var(--acc)', color: '#fff', border: 0, fontWeight: 700, cursor: 'pointer', opacity: busy ? 0.6 : 1, fontFamily: 'inherit' }}>{busy ? 'Saving…' : 'Save template'}</button>
      </div>
    </div>
  );
}
// Glass task pill — drag handle, inline-edit label, temp-linked badge, camera + enabled toggles, hover-only delete.
function TaskPill({ t, editing, onLabel, onEdit, onEndEdit, onCamera, onToggle, onUp, onDown, onDelete }) {
  const [hover, setHover] = useState(false);
  const on = t.active !== false;
  const tempLinked = !!t.tempUnitId;
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--bg2)', border: '1px solid var(--bdr)', borderRadius: 12, padding: '10px 12px' }}
    >
      {/* drag handle / reorder (handle nudges up; hover arrows for both directions) */}
      <span onClick={onUp} title="Move up (drag to reorder)" style={{ cursor: 'grab', color: 'var(--t3)', fontSize: 16, lineHeight: 1, userSelect: 'none', letterSpacing: '-1px', padding: '0 2px' }}>···</span>
      {hover && (
        <div style={{ display: 'flex', flexDirection: 'column', marginRight: -4 }}>
          <button onClick={onUp} style={arrowBtn} title="Move up">▲</button>
          <button onClick={onDown} style={arrowBtn} title="Move down">▼</button>
        </div>
      )}

      {/* label — plain text, click to inline-edit */}
      {editing ? (
        <input
          autoFocus
          value={t.label}
          onChange={e => onLabel(e.target.value)}
          onBlur={onEndEdit}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') onEndEdit(); }}
          placeholder="Task description"
          style={{ flex: 1, background: 'transparent', color: 'var(--t1)', border: 0, borderBottom: '1px solid var(--acc-b)', padding: '2px 0', fontSize: 13.5, outline: 'none', fontFamily: 'inherit' }}
        />
      ) : (
        <span onClick={onEdit} style={{ flex: 1, fontSize: 13.5, color: t.label ? 'var(--t1)' : 'var(--t3)', cursor: 'text' }}>{t.label || 'Task description'}</span>
      )}

      {/* TEMP-LINKED badge (teal) */}
      {tempLinked && (
        <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--signal)', background: 'rgba(21,194,106,0.12)', border: '1px solid rgba(21,194,106,0.3)', padding: '3px 7px', borderRadius: 6, whiteSpace: 'nowrap' }}>Temp-linked</span>
      )}

      {/* camera toggle — amber when evidence required, muted otherwise */}
      <button onClick={onCamera} title={t.evidenceRequired ? 'Photo required' : 'Photo optional'} style={{ background: 'transparent', border: 0, cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 4, color: t.evidenceRequired ? 'var(--amber)' : 'var(--t3)' }}>
        <Icon name="camera" size={16} />
      </button>

      {/* enabled toggle switch (green pill) */}
      <button onClick={onToggle} title={on ? 'Enabled' : 'Disabled'} style={{ width: 34, height: 19, borderRadius: 10, border: 0, cursor: 'pointer', padding: 0, position: 'relative', flexShrink: 0, background: on ? 'var(--grn)' : 'var(--bg4)', transition: 'background .15s' }}>
        <span style={{ position: 'absolute', top: 2, left: on ? 17 : 2, width: 15, height: 15, borderRadius: '50%', background: '#fff', transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,.3)' }} />
      </button>

      {/* delete — hover only */}
      <button onClick={onDelete} title="Remove task" style={{ background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 2, opacity: hover ? 1 : 0, pointerEvents: hover ? 'auto' : 'none', transition: 'opacity .12s' }}>
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
const arrowBtn = { background: 'transparent', border: 0, color: 'var(--t3)', cursor: 'pointer', fontSize: 9, lineHeight: 1, padding: 1 };
