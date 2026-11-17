// src/backoffice/sections/headoffice/HqProjectDetail.jsx
//
// One internal project, opened inside the Internal projects screen: the header (status, owner,
// dates), then Phases | Tasks | Updates. Tasks and sub tasks are rows with a done toggle; each
// row opens a small edit sheet. When a task flips to done or blocked an 'activity' update is
// posted so the owner's feed says what moved. Delete is the one place that asks with
// window.confirm (a Back Office desktop screen).

import { useState } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { saveProject, saveTask, deleteTask, addUpdate } from '../../../lib/hq/data.js';
import { groupByPhase, taskTree, progressOf } from '../../../lib/hq/projectRollup.js';
import { PROJECT_STATUSES, TASK_STATUSES, TASK_PRIORITIES, departmentLabel } from '../../../lib/hq/departments.js';
import {
  page, card, mono, accBtn, btn, smallBtn, linkBtn, field, disabled, dateText, dateTimeText, siteName,
  SectionHead, Chip, StatusBadge, DepartmentChip, ProgressBar, AmberLine, TabRow, Sheet, Field,
} from './hqUi';

const PRIORITY_TONE = { P0: 'red', P1: 'orn', P2: 't3', P3: 't4' };
const phaseNames = (phases) => (Array.isArray(phases) ? phases.map((p) => (typeof p === 'string' ? p : p?.name)).filter(Boolean) : []);

export default function HqProjectDetail({ hq, project, tasks, updates, onBack, reload }) {
  const [tab, setTab] = useState('phases');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null);      // a task row, or { project_id, parent_task_id, phase } for a new one
  const progress = progressOf(tasks);
  const phases = phaseNames(project.phases);
  const currency = hq.currency;

  const run = async (fn) => {
    setBusy(true); setMsg(null);
    const res = await fn();
    setBusy(false);
    if (res?.error) { setMsg(res.message); return false; }
    reload();
    return true;
  };

  const setStatus = (status) => run(() => saveProject({ ...project, status }, hq.orgId, hq.userName));
  const addPhase = (name) => run(() => saveProject({ ...project, phases: [...phases, name] }, hq.orgId, hq.userName));

  /** Save a task; a flip to done or blocked also posts an activity line. */
  const saveRow = async (next, before) => {
    const ok = await run(() => saveTask({ ...next, project_id: project.id }, hq.orgId, hq.userName));
    if (!ok) return false;
    const was = before?.status; const now = next.status;
    if (was !== now && (now === 'done' || now === 'blocked')) {
      const body = now === 'done' ? `Marked done: ${next.title}` : `Blocked: ${next.title}${next.blocked_reason ? ` (${next.blocked_reason})` : ''}`;
      await addUpdate({ projectId: project.id, taskId: next.id || null, body, kind: 'activity' }, hq.orgId, hq.userName);
      reload();
    }
    return true;
  };
  const toggleDone = (t) => saveRow({ ...t, status: t.status === 'done' ? 'todo' : 'done' }, t);
  const remove = async (t) => {
    if (!window.confirm(`Delete "${t.title}"? Its sub tasks go with it.`)) return;
    await run(() => deleteTask(t.id));
  };

  const rowProps = { tasks, currency, busy, onToggle: toggleDone, onEdit: (t) => setEditing(t), onSub: (t) => setEditing({ project_id: project.id, parent_task_id: t.id, phase: t.phase || null }), onDelete: remove };

  return (
    <div style={page}>
      <button type="button" style={{ ...linkBtn, display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 12 }} onClick={onBack}><Icon name="back" size={14} />Back to Internal projects</button>
      <div style={{ ...card, padding: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
              <StatusBadge status={project.status} />
              <DepartmentChip id={project.department} />
              <Chip tone="t3">{siteName(hq.sites, project.location_id)}</Chip>
            </div>
            <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--t1)' }}>{project.name}</h1>
            {project.description && <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 4 }}>{project.description}</div>}
            <div style={{ display: 'flex', gap: 16, fontSize: 12.5, color: 'var(--t3)', marginTop: 10, flexWrap: 'wrap' }}>
              <span>Owner <b style={{ color: 'var(--t2)' }}>{project.owner_name || 'nobody yet'}</b></span>
              <span>Department <b style={{ color: 'var(--t2)' }}>{departmentLabel(project.department)}</b></span>
              <span>Start <b style={{ color: 'var(--t2)' }}>{dateText(project.start_date, currency)}</b></span>
              <span>Due <b style={{ color: 'var(--t2)' }}>{dateText(project.due_date, currency)}</b></span>
            </div>
          </div>
          <div style={{ minWidth: 220 }}>
            <Field label="Status">
              <select style={{ ...field, ...disabled(busy) }} disabled={busy} value={project.status} onChange={(e) => setStatus(e.target.value)}>
                {PROJECT_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </Field>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--t3)', margin: '10px 0 4px' }}>
              <span>{progress.total ? `${progress.done} of ${progress.total} tasks done` : 'No tasks yet'}</span>
              <span className="mono" style={mono}>{progress.pct}%</span>
            </div>
            <ProgressBar pct={progress.pct} />
          </div>
        </div>
      </div>
      <AmberLine>{msg}</AmberLine>

      <TabRow style={{ margin: '16px 0 12px' }} value={tab} onChange={setTab} tabs={[['phases', 'Phases'], ['tasks', `Tasks (${tasks.length})`], ['updates', `Updates (${updates.length})`]]} />

      {tab === 'phases' && (
        <div style={{ display: 'grid', gap: 12 }}>
          {groupByPhase(tasks, phases).map((g) => (
            <div key={g.name || '(none)'} style={card}>
              <div style={{ fontSize: 14, fontWeight: 700, color: g.name ? 'var(--t1)' : 'var(--t3)', marginBottom: 8 }}>{g.name || 'No phase'}</div>
              {g.tasks.map((t) => <TaskRow key={t.id} t={t} {...rowProps} />)}
              <AddTaskRow busy={busy} onAdd={(title) => saveRow({ project_id: project.id, title, phase: g.name || null, status: 'todo', priority: 'P2' }, null)} />
            </div>
          ))}
          {!phases.length && !tasks.length && <div style={{ fontSize: 13, color: 'var(--t3)' }}>No phases yet. Add the first one below, then add tasks inside it.</div>}
          <AddPhase busy={busy} onAdd={addPhase} />
        </div>
      )}

      {tab === 'tasks' && (
        <div style={card}>
          {taskTree(tasks).map((t) => <TaskRow key={t.id} t={t} {...rowProps} />)}
          {!tasks.length && <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 8 }}>No tasks yet.</div>}
          <AddTaskRow busy={busy} onAdd={(title) => saveRow({ project_id: project.id, title, status: 'todo', priority: 'P2' }, null)} />
        </div>
      )}

      {tab === 'updates' && <Updates hq={hq} project={project} updates={updates} currency={currency} reload={reload} />}

      {editing && (
        <TaskSheet
          task={editing} tasks={tasks} phases={phases} currency={currency}
          onClose={() => setEditing(null)}
          onSave={async (next) => { const ok = await saveRow(next, editing.id ? editing : null); if (ok) setEditing(null); }}
        />
      )}
    </div>
  );
}

function TaskRow({ t, depth = 0, tasks, currency, busy, onToggle, onEdit, onSub, onDelete }) {
  const done = t.status === 'done';
  const blocked = t.status === 'blocked';
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: '1px solid var(--bdr)', marginLeft: depth * 26 }}>
        <button type="button" aria-label={done ? 'Mark not done' : 'Mark done'} disabled={busy} onClick={() => onToggle(t)}
          style={{ width: 18, height: 18, borderRadius: 5, border: `1.5px solid ${done ? 'var(--grn)' : 'var(--bdr2)'}`, background: done ? 'var(--grn)' : 'transparent', color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', padding: 0, flexShrink: 0 }}>
          {done && <Icon name="check" size={12} />}
        </button>
        <button type="button" onClick={() => onEdit(t)} style={{ ...linkBtn, color: done ? 'var(--t4)' : 'var(--t1)', fontWeight: 500, textDecoration: done ? 'line-through' : 'none', flex: 1, textAlign: 'left', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</button>
        {blocked && <Chip tone="red">Blocked</Chip>}
        {t.status === 'in_progress' && <Chip tone="grn">In progress</Chip>}
        <span style={{ fontSize: 12, color: 'var(--t3)', minWidth: 80, textAlign: 'right' }}>{t.owner_name || ''}</span>
        <span className="mono" style={{ ...mono, fontSize: 12, color: 'var(--t3)', minWidth: 70, textAlign: 'right' }}>{t.due_date ? dateText(t.due_date, currency, { day: 'numeric', month: 'short' }) : ''}</span>
        <Chip tone={PRIORITY_TONE[t.priority] || 't3'}>{t.priority || 'P2'}</Chip>
        <button type="button" style={{ ...smallBtn, padding: '3px 8px' }} onClick={() => onSub(t)} title="Add sub task">+ Sub task</button>
        <button type="button" style={{ ...smallBtn, padding: '3px 6px', color: 'var(--t3)' }} onClick={() => onDelete(t)} aria-label="Delete"><Icon name="trash" size={13} /></button>
      </div>
      {(t.children || []).map((c) => <TaskRow key={c.id} t={c} depth={depth + 1} tasks={tasks} currency={currency} busy={busy} onToggle={onToggle} onEdit={onEdit} onSub={onSub} onDelete={onDelete} />)}
    </>
  );
}

function AddTaskRow({ busy, onAdd }) {
  const [title, setTitle] = useState('');
  const add = async () => { const t = title.trim(); if (!t) return; await onAdd(t); setTitle(''); };
  return (
    <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
      <input style={{ ...field, flex: 1 }} placeholder="Add task" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
      <button type="button" style={{ ...btn, ...disabled(busy || !title.trim()) }} disabled={busy || !title.trim()} onClick={add}>Add</button>
    </div>
  );
}

function AddPhase({ busy, onAdd }) {
  const [name, setName] = useState('');
  const add = async () => { const n = name.trim(); if (!n) return; await onAdd(n); setName(''); };
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <input style={{ ...field, maxWidth: 320 }} placeholder="Add phase" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
      <button type="button" style={{ ...btn, ...disabled(busy || !name.trim()) }} disabled={busy || !name.trim()} onClick={add}>Add phase</button>
    </div>
  );
}

function TaskSheet({ task, tasks, phases, currency, onClose, onSave }) {
  const [f, setF] = useState({
    title: task.title || '', description: task.description || '', status: task.status || 'todo', priority: task.priority || 'P2',
    owner_name: task.owner_name || '', phase: task.phase || '', start_date: task.start_date || '', due_date: task.due_date || '',
    blocked_reason: task.blocked_reason || '', depends_on_id: task.depends_on_id || '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));
  const others = tasks.filter((t) => t.id !== task.id);
  const save = async () => {
    setSaving(true);
    await onSave({ ...task, ...f, description: f.description.trim() || null, owner_name: f.owner_name.trim() || null, phase: f.phase || null, start_date: f.start_date || null, due_date: f.due_date || null, depends_on_id: f.depends_on_id || null, blocked_reason: f.blocked_reason.trim() || null });
    setSaving(false);
  };
  return (
    <Sheet title={task.id ? 'Edit task' : (task.parent_task_id ? 'New sub task' : 'New task')} onClose={onClose}>
      <div style={{ display: 'grid', gap: 12 }}>
        <Field label="Title"><input style={field} value={f.title} onChange={set('title')} autoFocus /></Field>
        <Field label="Description"><textarea style={{ ...field, minHeight: 60, resize: 'vertical' }} value={f.description} onChange={set('description')} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Status"><select style={field} value={f.status} onChange={set('status')}>{TASK_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></Field>
          <Field label="Priority"><select style={field} value={f.priority} onChange={set('priority')}>{TASK_PRIORITIES.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select></Field>
          <Field label="Owner name"><input style={field} value={f.owner_name} onChange={set('owner_name')} /></Field>
          <Field label="Phase"><select style={field} value={f.phase} onChange={set('phase')}><option value="">No phase</option>{phases.map((p) => <option key={p} value={p}>{p}</option>)}{f.phase && !phases.includes(f.phase) && <option value={f.phase}>{f.phase}</option>}</select></Field>
          <Field label="Start date"><input type="date" style={field} value={f.start_date} onChange={set('start_date')} /></Field>
          <Field label="Due date"><input type="date" style={field} value={f.due_date} onChange={set('due_date')} /></Field>
        </div>
        {f.status === 'blocked' && <Field label="Blocked reason"><input style={field} value={f.blocked_reason} onChange={set('blocked_reason')} placeholder="What is in the way" /></Field>}
        <Field label="Depends on">
          <select style={field} value={f.depends_on_id} onChange={set('depends_on_id')}><option value="">Nothing</option>{others.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select>
        </Field>
        {task.due_date && <div style={{ fontSize: 12, color: 'var(--t4)' }}>Was due {dateText(task.due_date, currency)}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" style={btn} onClick={onClose}>Cancel</button>
          <button type="button" style={{ ...accBtn, ...disabled(saving || !f.title.trim()) }} disabled={saving || !f.title.trim()} onClick={save}>{saving ? 'Saving' : 'Save task'}</button>
        </div>
      </div>
    </Sheet>
  );
}

function Updates({ hq, project, updates, currency, reload }) {
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [msg, setMsg] = useState(null);
  const post = async () => {
    setPosting(true); setMsg(null);
    const res = await addUpdate({ projectId: project.id, body }, hq.orgId, hq.userName);
    setPosting(false);
    if (res.error) setMsg(res.message); else { setBody(''); reload(); }
  };
  const feed = [...updates].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={card}>
        <SectionHead title="Post an update for the owner" style={{ margin: '0 0 8px' }} />
        <textarea style={{ ...field, minHeight: 72, resize: 'vertical' }} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What moved, what is stuck, what you need." />
        <AmberLine>{msg}</AmberLine>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" style={{ ...accBtn, ...disabled(posting || !body.trim()) }} disabled={posting || !body.trim()} onClick={post}>{posting ? 'Posting' : 'Post'}</button>
        </div>
      </div>
      <div style={card}>
        {!feed.length && <div style={{ fontSize: 13, color: 'var(--t3)' }}>No updates yet.</div>}
        {feed.map((u) => (
          <div key={u.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--bdr)', display: 'flex', gap: 10 }}>
            <Icon name={u.kind === 'activity' ? 'checkCircle' : 'chat'} size={15} style={{ color: u.kind === 'activity' ? 'var(--t4)' : 'var(--acc)', marginTop: 2, flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, color: u.kind === 'activity' ? 'var(--t3)' : 'var(--t1)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{u.body}</div>
              <div style={{ fontSize: 11.5, color: 'var(--t4)', marginTop: 3 }}>{u.author_name || 'Someone'}, {dateTimeText(u.created_at, currency)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

