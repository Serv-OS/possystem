// src/backoffice/sections/headoffice/HqProjects.jsx
//
// Head office, Internal projects: current and future projects from every department, as cards.
// The card's percent and risk come from its tasks (src/lib/hq/projectRollup.js), the status
// from a person. Opening a card shows the project inside this screen (HqProjectDetail.jsx,
// state not a route). The create sheet and the card are exported so Departments reuses them.

import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { fetchProjects, fetchTasks, fetchUpdates, saveProject, saveTask, addUpdate } from '../../../lib/hq/data.js';
import { projectCard, statusCounts, myWork } from '../../../lib/hq/projectRollup.js';
import { DEPARTMENTS, PROJECT_STATUSES } from '../../../lib/hq/departments.js';
import HqProjectDetail from './HqProjectDetail';
import {
  page, card, mono, accBtn, btn, smallBtn, field, disabled, dateText, siteName, NA,
  PageHead, SectionHead, Pill, StatusBadge, DepartmentChip, ProgressBar, AbsentCard, AmberLine, LoadingLine, EmptyCard, Sheet, Field, hqHandoff,
} from './hqUi';

const FILTERS = [['all', 'All'], ['in_progress', 'In progress'], ['at_risk', 'At risk'], ['blocked', 'Blocked'], ['planning', 'Planning'], ['done', 'Done']];

/** Everything the projects screens read, loaded together. */
export function useProjectData(orgId) {
  const [state, setState] = useState({ key: null, absent: false, error: null, projects: [], tasks: [], updates: [] });
  const [tick, setTick] = useState(0);
  const key = `${orgId || ''}|${tick}`;   // loading until the state carries the asked key
  useEffect(() => {
    let live = true;
    Promise.all([fetchProjects(orgId), fetchTasks(orgId), fetchUpdates(orgId)]).then(([p, t, u]) => {
      if (!live) return;
      if (p.absent || t.absent || u.absent) { setState((s) => ({ ...s, key, absent: true })); return; }
      const first = [p, t, u].find((r) => r.error);
      setState({ key, absent: false, error: first ? first.message : null, projects: p.data || [], tasks: t.data || [], updates: u.data || [] });
    });
    return () => { live = false; };
  }, [orgId, tick, key]);
  return { ...state, loading: state.key !== key, reload: () => setTick((n) => n + 1) };
}

/** The cards, newest change first. */
export function buildCards(projects, tasks, updates, today) {
  const tasksBy = new Map(); const updatesBy = new Map();
  for (const t of tasks || []) { if (!tasksBy.has(t.project_id)) tasksBy.set(t.project_id, []); tasksBy.get(t.project_id).push(t); }
  for (const u of updates || []) { if (!updatesBy.has(u.project_id)) updatesBy.set(u.project_id, []); updatesBy.get(u.project_id).push(u); }
  return (projects || []).map((p) => projectCard(p, tasksBy.get(p.id) || [], updatesBy.get(p.id) || [], today));
}

export default function HqProjects({ hq }) {
  const data = useProjectData(hq.orgId);
  const [filter, setFilter] = useState('all');
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState(null);
  const [busyTask, setBusyTask] = useState(null);
  const [msg, setMsg] = useState(null);

  const cards = useMemo(() => buildCards(data.projects, data.tasks, data.updates, hq.today), [data.projects, data.tasks, data.updates, hq.today]);
  const counts = useMemo(() => statusCounts(cards), [cards]);
  const shown = filter === 'all' ? cards : cards.filter((c) => c.shownStatus === filter);
  const mine = useMemo(() => myWork(data.tasks, hq.userId).slice(0, 5), [data.tasks, hq.userId]);
  const projectName = (id) => data.projects.find((p) => p.id === id)?.name || 'Project';

  const markDone = async (t) => {
    setBusyTask(t.id); setMsg(null);
    const res = await saveTask({ ...t, status: 'done' }, hq.orgId, hq.userName);
    if (res.error) setMsg(res.message);
    else { await addUpdate({ projectId: t.project_id, taskId: t.id, body: `Marked done: ${t.title}`, kind: 'activity' }, hq.orgId, hq.userName); data.reload(); }
    setBusyTask(null);
  };

  if (data.absent) {
    return (
      <div style={page}>
        <PageHead title="Internal projects" sub="Current and future projects from every department. Open a card to post an update for the owner." />
        <AbsentCard message="Ask ServOS to run migration 20261130a." />
      </div>
    );
  }

  const open = openId ? data.projects.find((p) => p.id === openId) : null;
  if (open) {
    return (
      <HqProjectDetail
        hq={hq}
        project={open}
        tasks={data.tasks.filter((t) => t.project_id === open.id)}
        updates={data.updates.filter((u) => u.project_id === open.id)}
        onBack={() => setOpenId(null)}
        reload={data.reload}
      />
    );
  }

  return (
    <div style={page}>
      <PageHead
        title="Internal projects"
        sub="Current and future projects from every department. Open a card to post an update for the owner."
        right={<button type="button" style={accBtn} onClick={() => setCreating(true)}>New project</button>}
      />
      {data.loading && <LoadingLine>Loading</LoadingLine>}
      <AmberLine>{data.error}</AmberLine>
      <AmberLine>{msg}</AmberLine>

      {mine.length > 0 && (
        <div style={{ ...card, marginBottom: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginBottom: 8 }}>My work</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {mine.map((t) => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                <span style={{ flex: 1, color: 'var(--t1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                <span style={{ color: 'var(--t3)', fontSize: 12 }}>{projectName(t.project_id)}</span>
                <span className="mono" style={{ ...mono, color: t.due_date && t.due_date < hq.today ? 'var(--red)' : 'var(--t3)', fontSize: 12, minWidth: 90, textAlign: 'right' }}>{t.due_date ? dateText(t.due_date, hq.currency, { day: 'numeric', month: 'short' }) : 'No due date'}</span>
                <button type="button" style={{ ...smallBtn, ...disabled(busyTask === t.id) }} disabled={busyTask === t.id} onClick={() => markDone(t)}>Done</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        {FILTERS.map(([id, label]) => <Pill key={id} on={filter === id} count={counts[id]} onClick={() => setFilter(id)}>{label}</Pill>)}
      </div>

      {!data.loading && !shown.length && (
        <EmptyCard title={cards.length ? 'Nothing in this state' : 'No projects yet'} body={cards.length ? 'Pick another filter.' : 'Start the first one and the owner sees it here and on each department tab.'}>
          {!cards.length && <button type="button" style={accBtn} onClick={() => setCreating(true)}>New project</button>}
        </EmptyCard>
      )}
      <CardGrid cards={shown} sites={hq.sites} currency={hq.currency} onOpen={(c) => setOpenId(c.id)} />

      {creating && <CreateProjectSheet hq={hq} onClose={() => setCreating(false)} onSaved={(p) => { setCreating(false); data.reload(); if (p?.id) setOpenId(p.id); }} />}
    </div>
  );
}

export function CardGrid({ cards, sites, currency, onOpen }) {
  if (!cards.length) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12 }}>
      {cards.map((c) => <ProjectCard key={c.id} c={c} sites={sites} currency={currency} onOpen={() => onOpen(c)} />)}
    </div>
  );
}

export function ProjectCard({ c, sites, currency, onOpen }) {
  const tone = c.shownStatus === 'blocked' ? 'red' : c.shownStatus === 'at_risk' ? 'orn' : c.shownStatus === 'done' ? 'acc' : 'grn';
  return (
    <button type="button" onClick={onOpen} style={{ ...card, textAlign: 'left', cursor: 'pointer', fontFamily: 'inherit', display: 'flex', flexDirection: 'column', gap: 10, color: 'var(--t1)' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <StatusBadge status={c.shownStatus} />
        <DepartmentChip id={c.department} />
      </div>
      <div>
        <div style={{ fontSize: 15, fontWeight: 700 }}>{c.name}</div>
        {c.description && <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.description}</div>}
      </div>
      <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr)', borderRadius: 8, padding: '8px 10px', fontSize: 12.5 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--t4)', marginBottom: 3 }}>Latest update</div>
        <div style={{ color: c.latest ? 'var(--t2)' : 'var(--t4)', lineHeight: 1.5, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{c.latest ? c.latest.body : 'No update posted yet'}</div>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--t3)' }}>
        <span>{c.owner_name || 'No owner'}</span>
        <span>{siteName(sites, c.location_id)}</span>
      </div>
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--t3)', marginBottom: 4 }}>
          <span>{c.progress.total ? `${c.progress.done} of ${c.progress.total} tasks` : 'No tasks'}</span>
          <span className="mono" style={mono}>{c.progress.pct}%</span>
        </div>
        <ProgressBar pct={c.progress.pct} tone={tone} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--t3)', gap: 8, flexWrap: 'wrap' }}>
        <span>Due {c.due_date ? dateText(c.due_date, currency, { day: 'numeric', month: 'short' }) : NA}</span>
        <span>Updated {dateText(c.updated_at, currency, { day: 'numeric', month: 'short' })}</span>
      </div>
      {c.risk && <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: c.risk.kind === 'blocked' ? 'var(--red)' : 'var(--orn)' }}><Icon name="warn" size={13} />{c.risk.reason}</div>}
    </button>
  );
}

/** Owner id: we have no people picker yet, so the id is set only when the typed owner name is the
 *  signed in user's own name. Any other name is kept as text with no id. */
export function ownerIdFor(ownerName, hq) {
  const a = String(ownerName || '').trim().toLowerCase();
  const b = String(hq?.userName || '').trim().toLowerCase();
  return a && b && a === b ? hq.userId : null;
}

export function CreateProjectSheet({ hq, onClose, onSaved, department = null }) {
  const preset = department || hqHandoff.projectDept || 'operations';
  const [f, setF] = useState({ name: '', description: '', department: preset, location_id: '', owner_name: hq.userName || '', status: 'planning', start_date: hq.today, due_date: '', phases: '' });
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  useEffect(() => { hqHandoff.projectDept = null; }, []);
  const set = (k) => (e) => setF((s) => ({ ...s, [k]: e.target.value }));

  const save = async () => {
    setSaving(true); setMsg(null);
    const res = await saveProject({
      name: f.name, description: f.description.trim() || null, department: f.department, location_id: f.location_id || null,
      owner_name: f.owner_name.trim() || null, owner_id: ownerIdFor(f.owner_name, hq), status: f.status,
      start_date: f.start_date || null, due_date: f.due_date || null,
      phases: f.phases.split(',').map((s) => s.trim()).filter(Boolean),
    }, hq.orgId, hq.userName);
    setSaving(false);
    if (res.error) setMsg(res.message); else onSaved(res.data);
  };

  return (
    <Sheet title="New project" onClose={onClose}>
      <div style={{ display: 'grid', gap: 12 }}>
        <Field label="Name"><input style={field} value={f.name} onChange={set('name')} placeholder="Open the Daybreak kitchen" /></Field>
        <Field label="Description"><textarea style={{ ...field, minHeight: 64, resize: 'vertical' }} value={f.description} onChange={set('description')} /></Field>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <Field label="Department">
            <select style={field} value={f.department} onChange={set('department')}>{DEPARTMENTS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}</select>
          </Field>
          <Field label="Site">
            <select style={field} value={f.location_id} onChange={set('location_id')}><option value="">All sites</option>{hq.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          </Field>
          <Field label="Owner name"><input style={field} value={f.owner_name} onChange={set('owner_name')} /></Field>
          <Field label="Status">
            <select style={field} value={f.status} onChange={set('status')}>{PROJECT_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
          </Field>
          <Field label="Start date"><input type="date" style={field} value={f.start_date} onChange={set('start_date')} /></Field>
          <Field label="Due date"><input type="date" style={field} value={f.due_date} onChange={set('due_date')} /></Field>
        </div>
        <Field label="Phases, comma separated"><input style={field} value={f.phases} onChange={set('phases')} placeholder="Plan, Build, Open" /></Field>
        <AmberLine>{msg}</AmberLine>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" style={btn} onClick={onClose}>Cancel</button>
          <button type="button" style={{ ...accBtn, ...disabled(saving) }} disabled={saving} onClick={save}>{saving ? 'Saving' : 'Create project'}</button>
        </div>
      </div>
    </Sheet>
  );
}

