// src/backoffice/sections/workforce/WfTraining.jsx
//
// Workforce › Training (v5.5.999, TRAINING_MODULE_PLAN.md slice 1) — build
// training MODULES (an ordered task list + a deadline), assign them by
// POSITION or by person, and watch completion. Staff do the training in the
// STAFF APP (?mode=staff → Tasks); ticks are stamped server-side by the
// staff-portal fn, so the matrix here is read from the same rows.

import { useState, useEffect, useMemo } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { Card, EmptyState, Badge, th, td, inputStyle, labelStyle, initials, LoadingCard } from '../../../staff/wfUi';
import * as wf from '../../../staff/wfData';

const todayIso = () => new Date().toISOString().slice(0, 10);
const fmtDate = iso => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—';
const newTaskId = () => `t-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;

function assignmentState(a) {
  if (a.status === 'complete') return ['Complete', 'green'];
  if (a.dueDate && a.dueDate < todayIso()) return ['Overdue', 'red'];
  if ((a.tasksDone || []).length > 0) return ['In progress', 'blue'];
  return ['Assigned', 'grey'];
}

export default function WfTraining({ ctx, staff, roles, showToast }) {
  const [mods, setMods] = useState([]);
  const [assigns, setAssigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);     // module being built/edited (object), or 'new'
  const [assigning, setAssigning] = useState(null); // module being assigned
  const roleList = useMemo(() => roles?.list || [], [roles]);

  async function reload() {
    const [m, a] = await Promise.all([
      wf.loadTrainingModules(ctx.locationId),
      wf.loadTrainingAssignments(ctx.locationId),
    ]);
    setMods(m || []); setAssigns(a || []);
  }
  useEffect(() => {
    let live = true;
    setLoading(true);
    reload().finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx?.locationId]);

  const byModule = useMemo(() => {
    const m = new Map();
    assigns.forEach(a => { if (!m.has(a.moduleId)) m.set(a.moduleId, []); m.get(a.moduleId).push(a); });
    return m;
  }, [assigns]);
  const staffById = useMemo(() => Object.fromEntries((staff || []).map(s => [s.id, s])), [staff]);

  async function saveModule(mod) {
    try {
      await wf.saveTrainingModule(mod, ctx.locationId, ctx.orgId);
      setEditing(null);
      await reload();
      showToast('Training module saved', 'success');
    } catch (e) { showToast(e.message || 'Could not save the module', 'error'); }
  }

  async function doAssign(module, staffIds) {
    try {
      await wf.assignTraining(module, staffIds, ctx.locationId, ctx.orgId, ctx?.actor?.name);
      setAssigning(null);
      await reload();
      showToast(`Assigned to ${staffIds.length} ${staffIds.length === 1 ? 'person' : 'people'} — it appears in their staff app now`, 'success');
    } catch (e) { showToast(e.message || 'Could not assign', 'error'); }
  }

  if (loading) return <LoadingCard label="Loading training…" />;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Training</div>
          <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 2 }}>Build modules, assign them by position or person. Staff complete them in the staff app.</div>
        </div>
        <button className="btn btn-acc" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> New module</button>
      </div>

      {mods.length === 0 ? (
        <EmptyState icon="clipboard" title="No training modules yet" body="Create your first module — e.g. “New starter basics”: a short list of tasks with a deadline. Tick “apply to new starters” and everyone you onboard gets it automatically." />
      ) : (
        <div style={{ display: 'grid', gap: 14 }}>
          {mods.map(mod => {
            const list = byModule.get(mod.id) || [];
            const complete = list.filter(a => a.status === 'complete').length;
            const overdue = list.filter(a => a.status !== 'complete' && a.dueDate && a.dueDate < todayIso()).length;
            return (
              <Card key={mod.id}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 220 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 15, fontWeight: 700 }}>{mod.name}</span>
                      {mod.status === 'draft' && <Badge tone="amber">Draft</Badge>}
                      {mod.autoAssign && <Badge tone="blue">New starters{mod.autoAssignRoles.length ? `: ${mod.autoAssignRoles.map(k => roles?.map?.[k]?.lbl || k).join(', ')}` : ''}</Badge>}
                    </div>
                    {mod.description && <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 4, lineHeight: 1.5 }}>{mod.description}</div>}
                    <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 6 }}>
                      {mod.tasks.length} task{mod.tasks.length === 1 ? '' : 's'} · due {mod.dueDays} days after assignment
                      {list.length > 0 && <> · <b style={{ color: 'var(--t2)' }}>{complete}/{list.length} complete</b>{overdue > 0 && <b style={{ color: 'var(--red)' }}> · {overdue} overdue</b>}</>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-acc btn-sm" onClick={() => setAssigning(mod)}><Icon name="team" size={13} /> Assign</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(mod)}><Icon name="edit" size={13} /> Edit</button>
                    <button className="btn btn-ghost btn-sm" style={{ color: 'var(--t4)' }} title="Archive this module (assignments are kept)"
                      onClick={async () => { if (window.confirm(`Archive “${mod.name}”?`)) { await wf.archiveTrainingModule(mod.id).catch(e => showToast(e.message, 'error')); reload(); } }}>
                      <Icon name="close" size={13} />
                    </button>
                  </div>
                </div>
                {list.length > 0 && (
                  <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
                    <thead><tr><th style={th}>Person</th><th style={th}>Progress</th><th style={th}>Due</th><th style={th}>Status</th></tr></thead>
                    <tbody>
                      {list.map(a => {
                        const p = staffById[a.staffId];
                        const [lbl, tone] = assignmentState(a);
                        return (
                          <tr key={a.id}>
                            <td style={td}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600 }}><span style={{ width: 24, height: 24, borderRadius: 7, background: 'var(--inset)', border: '1px solid var(--inset-border)', display: 'grid', placeItems: 'center', fontSize: 9.5, fontWeight: 700, color: 'var(--t2)' }}>{initials(p?.name)}</span>{p?.name || 'Unknown'}</span></td>
                            <td style={td} className="mono">{(a.tasksDone || []).length}/{mod.tasks.length}</td>
                            <td style={td} className="mono">{fmtDate(a.dueDate)}</td>
                            <td style={td}><Badge tone={tone}>{lbl}</Badge></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {editing && (
        <ModuleModal
          module={editing === 'new' ? null : editing}
          roleList={roleList} roles={roles}
          onSave={saveModule} onClose={() => setEditing(null)}
        />
      )}
      {assigning && (
        <AssignModal
          module={assigning} staff={staff} roles={roles}
          already={new Set((byModule.get(assigning.id) || []).map(a => a.staffId))}
          onAssign={doAssign} onClose={() => setAssigning(null)}
        />
      )}
    </>
  );
}

// ── module builder ───────────────────────────────────────────────────────────
function ModuleModal({ module: mod, roleList, roles, onSave, onClose }) {
  const [name, setName] = useState(mod?.name || '');
  const [description, setDescription] = useState(mod?.description || '');
  const [dueDays, setDueDays] = useState(String(mod?.dueDays ?? 14));
  const [autoAssign, setAutoAssign] = useState(!!mod?.autoAssign);
  const [autoRoles, setAutoRoles] = useState(mod?.autoAssignRoles || []);
  const [tasks, setTasks] = useState(mod?.tasks?.length ? mod.tasks : [{ id: newTaskId(), title: '', detail: '' }]);

  const setTask = (i, k, v) => setTasks(ts => ts.map((t, j) => j === i ? { ...t, [k]: v } : t));
  const valid = name.trim().length > 1 && tasks.some(t => t.title.trim());

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 560, maxHeight: '86vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>{mod ? 'Edit module' : 'New training module'}</div>
        <div style={{ fontSize: 12.5, color: 'var(--t3)', marginBottom: 16 }}>A module is a short course: tasks the person works through in the staff app, with a deadline.</div>

        <label style={labelStyle}>Module name</label>
        <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. New starter basics" autoFocus />

        <label style={{ ...labelStyle, marginTop: 12 }}>Description (optional)</label>
        <textarea style={{ ...inputStyle, height: 'auto', minHeight: 56, padding: '9px 12px', resize: 'vertical' }} value={description} onChange={e => setDescription(e.target.value)} placeholder="What this training covers and why it matters." />

        <label style={{ ...labelStyle, marginTop: 12 }}>Tasks (in order)</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {tasks.map((t, i) => (
            <div key={t.id} style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <span className="mono" style={{ fontSize: 11, color: 'var(--t4)', marginTop: 12, width: 18, textAlign: 'right' }}>{i + 1}.</span>
              <div style={{ flex: 1 }}>
                <input style={inputStyle} value={t.title} onChange={e => setTask(i, 'title', e.target.value)} placeholder={`Task ${i + 1} — e.g. Read the allergen guide`} />
                <input style={{ ...inputStyle, marginTop: 5, fontSize: 12 }} value={t.detail || ''} onChange={e => setTask(i, 'detail', e.target.value)} placeholder="Detail (optional) — where to find it, what good looks like" />
              </div>
              <button className="btn btn-ghost btn-xs" style={{ marginTop: 8, color: 'var(--t4)' }} disabled={tasks.length === 1} onClick={() => setTasks(ts => ts.filter((_, j) => j !== i))}><Icon name="close" size={12} /></button>
            </div>
          ))}
        </div>
        <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => setTasks(ts => [...ts, { id: newTaskId(), title: '', detail: '' }])}><Icon name="plus" size={13} /> Add task</button>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 14 }}>
          <div>
            <label style={labelStyle}>Due (days after assignment)</label>
            <input style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }} type="number" min="1" max="365" value={dueDays} onChange={e => setDueDays(e.target.value)} />
          </div>
        </div>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 14, cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" checked={autoAssign} onChange={e => setAutoAssign(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            <b>Apply to new starters automatically</b>
            <span style={{ display: 'block', fontSize: 11.5, color: 'var(--t3)', marginTop: 2 }}>Assigned the moment onboarding starts. Leave all positions unticked to apply to everyone.</span>
          </span>
        </label>
        {autoAssign && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
            {roleList.map(r => {
              const on = autoRoles.includes(r.key);
              return (
                <button key={r.key} type="button" className={on ? 'btn btn-acc btn-sm' : 'btn btn-ghost btn-sm'} style={{ borderRadius: 999 }}
                  onClick={() => setAutoRoles(cur => on ? cur.filter(k => k !== r.key) : [...cur, r.key])}>
                  {r.lbl || roles?.map?.[r.key]?.lbl || r.key}
                </button>
              );
            })}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-acc btn-sm" disabled={!valid}
            onClick={() => onSave({
              ...(mod || {}), name: name.trim(), description: description.trim(),
              dueDays, autoAssign, autoAssignRoles: autoAssign ? autoRoles : [],
              tasks: tasks.filter(t => t.title.trim()).map(t => ({ id: t.id, title: t.title.trim(), detail: (t.detail || '').trim() || null })),
              status: 'active',
            })}>
            <Icon name="check" size={13} /> Save module
          </button>
        </div>
      </div>
    </div>
  );
}

// ── assignment: by position, or hand-picked ─────────────────────────────────
function AssignModal({ module: mod, staff, roles, already, onAssign, onClose }) {
  const [selected, setSelected] = useState(new Set());
  const roleList = roles?.list || [];
  const toggle = id => setSelected(cur => { const n = new Set(cur); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const pickRole = key => setSelected(cur => {
    const n = new Set(cur);
    (staff || []).filter(s => s.role === key && !already.has(s.id)).forEach(s => n.add(s.id));
    return n;
  });
  const eligible = (staff || []).filter(s => s.status !== 'leaver');
  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 480, maxHeight: '86vh', overflowY: 'auto' }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Assign “{mod.name}”</div>
        <div style={{ fontSize: 12.5, color: 'var(--t3)', marginBottom: 14 }}>Due {mod.dueDays} days from today. It appears in their staff app immediately.</div>

        <label style={labelStyle}>Add everyone in a position</label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          {roleList.map(r => (
            <button key={r.key} type="button" className="btn btn-ghost btn-sm" style={{ borderRadius: 999 }} onClick={() => pickRole(r.key)}>
              + {r.lbl || r.key}
            </button>
          ))}
        </div>

        <label style={labelStyle}>People</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {eligible.map(s => {
            const done = already.has(s.id);
            const on = selected.has(s.id);
            return (
              <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 10, background: on ? 'var(--inset)' : 'transparent', cursor: done ? 'default' : 'pointer', opacity: done ? 0.5 : 1 }}>
                <input type="checkbox" disabled={done} checked={on || done} onChange={() => toggle(s.id)} />
                <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{s.name}</span>
                <span style={{ fontSize: 11, color: 'var(--t4)' }}>{roles?.map?.[s.role]?.lbl || s.role}{done ? ' · already assigned' : ''}</span>
              </label>
            );
          })}
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 18, justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-acc btn-sm" disabled={!selected.size} onClick={() => onAssign(mod, [...selected])}>
            <Icon name="check" size={13} /> Assign to {selected.size || '—'}
          </button>
        </div>
      </div>
    </div>
  );
}
