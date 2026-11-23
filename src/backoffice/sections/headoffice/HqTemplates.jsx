// src/backoffice/sections/headoffice/HqTemplates.jsx
//
// Head office, project templates (slice 6, 18 Nov 2026): the Templates tab on Internal projects.
// A list on the left, the editor on the right: name, department, description, the project's
// length in days, the phases, and the task tree (a task with its phase, priority, due day from
// the start, and its sub tasks). Saving writes one hq_project_templates row; "Use this template"
// hands the template to the New project sheet. The shapes and the arithmetic are
// src/lib/hq/templates.js; a database without 20261203a shows the calm card.

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { fetchTemplates, saveTemplate, deleteTemplate, NOT_SET_UP_6 } from '../../../lib/hq/data.js';
import { normaliseTemplate, normaliseTask, templateProblem, templateWords, countTasks, newKey } from '../../../lib/hq/templates.js';
import { DEPARTMENTS, TASK_PRIORITIES, departmentLabel } from '../../../lib/hq/departments.js';
import { card, accBtn, btn, smallBtn, linkBtn, field, disabled, DepartmentChip, AmberLine, LoadingLine, EmptyCard, AbsentCard, Field } from './hqUi';

/** The company's templates, loaded once per org and on demand. */
export function useTemplates(orgId) {
  const [state, setState] = useState({ key: null, absent: false, error: null, templates: [] });
  const [tick, setTick] = useState(0);
  const key = `${orgId || ''}|${tick}`;
  useEffect(() => {
    let live = true;
    fetchTemplates(orgId).then((r) => {
      if (!live) return;
      setState({ key, absent: !!r.absent, error: r.absent ? null : (r.error ? r.message : null), templates: r.data || [] });
    });
    return () => { live = false; };
  }, [orgId, tick, key]);
  return { ...state, loading: state.key !== key, reload: () => setTick((n) => n + 1) };
}

const BLANK = () => normaliseTemplate({ name: '', department: 'operations', phases: [], tasks: [], duration_days: null });

/**
 * @param {object} p.hq        the hub context
 * @param {(tpl) => void} p.onUse  "Use this template": opens the New project sheet with it
 */
export default function HqTemplates({ hq, onUse }) {
  const data = useTemplates(hq.orgId);
  const [openId, setOpenId] = useState(null);   // a template id, 'new', or null
  const [msg, setMsg] = useState(null);
  const open = openId === 'new' ? null : data.templates.find((t) => t.id === openId) || null;

  if (data.absent) return <AbsentCard message={NOT_SET_UP_6} />;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 320px) 1fr', gap: 16, alignItems: 'start' }}>
      <div style={{ display: 'grid', gap: 8 }}>
        <button type="button" style={accBtn} onClick={() => { setOpenId('new'); setMsg(null); }}>New template</button>
        {data.loading && <LoadingLine>Loading</LoadingLine>}
        <AmberLine>{data.error}</AmberLine>
        {!data.loading && !data.templates.length && (
          <EmptyCard title="No templates yet" body="Build one here, or open a finished project and press Save as template." />
        )}
        {data.templates.map((t) => (
          <button key={t.id} type="button" onClick={() => { setOpenId(t.id); setMsg(null); }}
            style={{ ...card, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', color: 'var(--t1)', borderColor: openId === t.id ? 'var(--acc)' : 'var(--bdr)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <span style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
              <DepartmentChip id={t.department} />
            </div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4 }}>{templateWords(t)}</div>
          </button>
        ))}
      </div>
      <div>
        {openId === null && (
          <EmptyCard title="Pick a template" body="Open one on the left to read or change it, or make a new one. A project made from a template keeps its own copy: changing the template later does not change the project." />
        )}
        {openId !== null && (
          <TemplateEditor key={openId} hq={hq} template={open} onUse={onUse}
            onSaved={() => { data.reload(); setMsg('Saved.'); }}
            onDeleted={() => { data.reload(); setOpenId(null); }} />
        )}
        <AmberLine>{msg}</AmberLine>
      </div>
    </div>
  );
}

export function TemplateEditor({ hq, template, onSaved, onDeleted, onUse }) {
  const [t, setT] = useState(() => (template ? normaliseTemplate(template) : BLANK()));
  const [phasesText, setPhasesText] = useState(() => (template ? normaliseTemplate(template).phases.join(', ') : ''));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const set = (k) => (e) => setT((s) => ({ ...s, [k]: e.target.value }));
  const phases = useMemo(() => phasesText.split(',').map((s) => s.trim()).filter(Boolean), [phasesText]);
  const total = countTasks(t.tasks);
  // The row's id once it exists: a NEW template that was just saved keeps its id in state (the parent
  // still holds template null until its list reloads), so a second Save updates, never inserts twice.
  const id = t.id || template?.id || null;

  const save = async () => {
    const next = normaliseTemplate({ ...t, phases, id, org_id: t.org_id || template?.org_id || hq.orgId });
    const problem = templateProblem(next);
    if (problem) { setMsg(problem); return; }
    setSaving(true); setMsg(null);
    const res = await saveTemplate(next, hq.orgId, hq.userName);
    setSaving(false);
    if (res.error) { setMsg(res.message); return; }
    setT(normaliseTemplate(res.data));
    onSaved(res.data);
  };
  const remove = async () => {
    if (!id) return;
    if (!window.confirm(`Delete the template "${t.name}"? Projects already made from it are not touched.`)) return;
    setSaving(true);
    const res = await deleteTemplate(id);
    setSaving(false);
    if (res.error) { setMsg(res.message); return; }
    onDeleted();
  };

  // The task tree edits: by key, two levels (a task and its sub tasks).
  const updateTask = (key, patch) => setT((s) => ({ ...s, tasks: s.tasks.map((x) => (x.key === key ? { ...x, ...patch } : { ...x, children: x.children.map((c) => (c.key === key ? { ...c, ...patch } : c)) })) }));
  const addTask = () => setT((s) => ({ ...s, tasks: [...s.tasks, normaliseTask({ key: newKey(), title: '' })] }));
  const addSub = (parentKey) => setT((s) => ({ ...s, tasks: s.tasks.map((x) => (x.key === parentKey ? { ...x, children: [...x.children, normaliseTask({ key: newKey(), title: '' })] } : x)) }));
  const removeTask = (key) => setT((s) => ({ ...s, tasks: s.tasks.filter((x) => x.key !== key).map((x) => ({ ...x, children: x.children.filter((c) => c.key !== key) })) }));
  const move = (key, dir) => setT((s) => {
    const swap = (list) => { const i = list.findIndex((x) => x.key === key); if (i < 0) return list; const j = i + dir; if (j < 0 || j >= list.length) return list; const out = list.slice(); [out[i], out[j]] = [out[j], out[i]]; return out; };
    const roots = swap(s.tasks);
    return { ...s, tasks: roots === s.tasks ? s.tasks.map((x) => ({ ...x, children: swap(x.children) })) : roots };
  });

  return (
    <div style={{ ...card, padding: 18 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', marginBottom: 14, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--t1)' }}>{id ? 'Template' : 'New template'}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          {id && typeof onUse === 'function' && <button type="button" style={btn} onClick={() => onUse(normaliseTemplate({ ...t, phases, id }))}>Use this template</button>}
          {id && <button type="button" style={{ ...btn, color: 'var(--t3)' }} disabled={saving} onClick={remove}>Delete</button>}
          <button type="button" style={{ ...accBtn, ...disabled(saving) }} disabled={saving} onClick={save}>{saving ? 'Saving' : 'Save template'}</button>
        </div>
      </div>
      <div style={{ display: 'grid', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
          <Field label="Name"><input style={field} value={t.name} onChange={set('name')} placeholder="Open a new site" /></Field>
          <Field label="Department">
            <select style={field} value={t.department} onChange={set('department')}>{DEPARTMENTS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select>
          </Field>
          <Field label="Length, days from start"><input style={field} type="number" min="0" value={t.duration_days ?? ''} onChange={(e) => setT((s) => ({ ...s, duration_days: e.target.value === '' ? null : e.target.value }))} placeholder="45" /></Field>
        </div>
        <Field label="Description"><textarea style={{ ...field, minHeight: 56, resize: 'vertical' }} value={t.description || ''} onChange={set('description')} /></Field>
        <Field label="Phases, comma separated, in order"><input style={field} value={phasesText} onChange={(e) => setPhasesText(e.target.value)} placeholder="Plan, Build, Open" /></Field>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)' }}>Tasks <span style={{ color: 'var(--t3)', fontWeight: 500 }}>({total})</span></div>
            <div style={{ fontSize: 12, color: 'var(--t3)' }}>Due day counts from the project's start date. Blank = no due date.</div>
          </div>
          {t.tasks.map((task, i) => (
            <div key={task.key}>
              <TaskLine task={task} phases={phases} first={i === 0} last={i === t.tasks.length - 1}
                onChange={(patch) => updateTask(task.key, patch)} onRemove={() => removeTask(task.key)} onMove={(d) => move(task.key, d)} onSub={() => addSub(task.key)} />
              {task.children.map((c, j) => (
                <TaskLine key={c.key} task={c} phases={phases} depth={1} first={j === 0} last={j === task.children.length - 1}
                  onChange={(patch) => updateTask(c.key, patch)} onRemove={() => removeTask(c.key)} onMove={(d) => move(c.key, d)} />
              ))}
            </div>
          ))}
          <button type="button" style={{ ...smallBtn, marginTop: 8 }} onClick={addTask}>+ Add task</button>
        </div>
        <AmberLine>{msg}</AmberLine>
        <div style={{ fontSize: 12, color: 'var(--t4)' }}>{departmentLabel(t.department)} · a project made from this keeps its own copy of these tasks.</div>
      </div>
    </div>
  );
}

function TaskLine({ task, phases, depth = 0, first, last, onChange, onRemove, onMove, onSub }) {
  const sel = { ...field, padding: '6px 8px', fontSize: 12.5 };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(160px, 2fr) 1fr 96px 90px auto', gap: 8, alignItems: 'center', padding: '5px 0', borderBottom: '1px solid var(--bdr)', marginLeft: depth * 26 }}>
      <input style={sel} value={task.title} onChange={(e) => onChange({ title: e.target.value })} placeholder={depth ? 'Sub task' : 'Task'} aria-label={depth ? 'Sub task title' : 'Task title'} />
      <select style={sel} value={task.phase || ''} onChange={(e) => onChange({ phase: e.target.value || null })} aria-label="Phase">
        <option value="">No phase</option>
        {phases.map((p) => <option key={p} value={p}>{p}</option>)}
        {task.phase && !phases.includes(task.phase) && <option value={task.phase}>{task.phase}</option>}
      </select>
      <select style={sel} value={task.priority} onChange={(e) => onChange({ priority: e.target.value })} aria-label="Priority">
        {TASK_PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
      </select>
      <input style={sel} type="number" min="0" value={task.due_days ?? ''} onChange={(e) => onChange({ due_days: e.target.value === '' ? null : e.target.value })} placeholder="Due day" aria-label="Due day" />
      <div style={{ display: 'flex', gap: 4 }}>
        <button type="button" style={{ ...smallBtn, padding: '3px 7px' }} disabled={first} onClick={() => onMove(-1)} aria-label="Move up">▲</button>
        <button type="button" style={{ ...smallBtn, padding: '3px 7px' }} disabled={last} onClick={() => onMove(1)} aria-label="Move down">▼</button>
        {onSub && <button type="button" style={{ ...smallBtn, padding: '3px 8px' }} onClick={onSub} title="Add sub task">+ Sub</button>}
        <button type="button" style={{ ...smallBtn, padding: '3px 6px', color: 'var(--t3)' }} onClick={onRemove} aria-label="Remove"><Icon name="trash" size={13} /></button>
      </div>
    </div>
  );
}

/** A small text button used by the project screens ("Save as template"). */
export const TemplateLink = ({ children, onClick }) => <button type="button" style={linkBtn} onClick={onClick}>{children}</button>;
