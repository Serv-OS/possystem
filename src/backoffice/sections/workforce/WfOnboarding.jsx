import { useState, useEffect, useMemo } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { Card, EmptyState, Badge, RoleChip, money, th, td, inputStyle, labelStyle, groupColor, cellTint, GRP_SECTION, initials, LoadingCard } from '../../../staff/wfUi';
import * as wf from '../../../staff/wfData';

const STEPS = ['Offer accepted', 'Right to work', 'Contract signed', 'Bank & tax details', 'Uniform & induction', 'POS user created', 'First shift booked'];

const makeSteps = () => STEPS.map(k => ({ key: k, status: 'pending', completedAt: null }));
const countDone = c => (c.steps || []).filter(s => s.status === 'complete').length;

function ProgressBar({ done, total }) {
  const pct = total ? Math.round((done / total) * 100) : 0;
  const col = done >= total ? 'var(--grn)' : 'var(--acc)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, height: 8, borderRadius: 999, background: 'var(--inset)', border: '1px solid var(--inset-border)', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: col, borderRadius: 999, transition: 'width .2s ease' }} />
      </div>
      <span className="mono" style={{ fontSize: 11, fontWeight: 700, color: 'var(--t2)', whiteSpace: 'nowrap' }}>{done}/{total}</span>
    </div>
  );
}

function StartModal({ candidates, roles, onClose, onStart }) {
  const [staffId, setStaffId] = useState(candidates[0]?.id || '');
  const sel = candidates.find(s => s.id === staffId);
  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 480 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Start onboarding</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}><Icon name="close" size={14} /></button>
        </div>
        {candidates.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--t3)', lineHeight: 1.6, padding: '8px 0 4px' }}>Every team member already has an onboarding case. Add a new staff member first to start another.</div>
        ) : (
          <>
            <label style={labelStyle}>New starter</label>
            <select style={inputStyle} value={staffId} onChange={e => setStaffId(e.target.value)}>
              {candidates.map(s => <option key={s.id} value={s.id}>{s.name}{s.role ? ` — ${roles.map?.[s.role]?.lbl || s.role}` : ''}</option>)}
            </select>
            <p style={{ fontSize: 12, color: 'var(--t3)', lineHeight: 1.6, marginTop: 12 }}>This creates a {STEPS.length}-step checklist you can work through as the new starter joins.</p>
          </>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {candidates.length > 0 && <button className="btn btn-acc" disabled={!sel} onClick={() => sel && onStart(sel)}><Icon name="plus" size={14} /> Start onboarding</button>}
        </div>
      </div>
    </div>
  );
}

function CaseCard({ kase, staffMember, roles, onToggle }) {
  const done = countDone(kase);
  const complete = done >= STEPS.length;
  const name = staffMember?.name || 'Unknown';
  const col = groupColor(roles.map?.[kase.roleKey]?.grp || 'mgmt');
  return (
    <Card>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ width: 38, height: 38, borderRadius: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: col, background: cellTint(col, 14), border: `1px solid ${cellTint(col, 30)}` }}>{initials(name)}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--t1)' }}>{name}</div>
          {kase.roleKey && <div style={{ marginTop: 2 }}><RoleChip role={kase.roleKey} roles={roles.map} /></div>}
        </div>
        {complete ? <Badge tone="green">Complete</Badge> : <Badge tone="amber">In progress</Badge>}
      </div>
      <div style={{ marginBottom: 14 }}><ProgressBar done={done} total={STEPS.length} /></div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {STEPS.map((key, i) => {
          const st = kase.steps?.[i] || { key, status: 'pending' };
          const isDone = st.status === 'complete';
          return (
            <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 10, background: 'var(--inset)', border: '1px solid var(--inset-border)' }}>
              <div style={{ width: 22, height: 22, borderRadius: 7, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: isDone ? 'var(--grn-d)' : 'var(--bg3)', border: `1px solid ${isDone ? 'var(--grn-b)' : 'var(--bdr2)'}`, color: isDone ? 'var(--grn)' : 'var(--t4)' }}>
                {isDone ? <Icon name="check" size={13} /> : <span className="mono" style={{ fontSize: 10, fontWeight: 700 }}>{i + 1}</span>}
              </div>
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: isDone ? 'var(--t3)' : 'var(--t1)', textDecoration: isDone ? 'line-through' : 'none' }}>{key}</span>
              <button className={`btn btn-xs ${isDone ? 'btn-ghost' : 'btn-acc'}`} onClick={() => onToggle(kase, i)}>{isDone ? 'Undo' : 'Mark done'}</button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export default function WfOnboarding({ ctx, staff, roles, sections, settings, week, showToast }) {
  const [cases, setCases] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showStart, setShowStart] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    wf.loadOnboarding(ctx.locationId)
      .then(rows => { if (alive) setCases(rows || []); })
      .catch(() => { if (alive) setCases([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [ctx.locationId]);

  const staffById = useMemo(() => Object.fromEntries((staff || []).map(s => [s.id, s])), [staff]);
  const candidates = useMemo(() => {
    const taken = new Set(cases.map(c => c.staffId));
    return (staff || []).filter(s => !taken.has(s.id));
  }, [staff, cases]);

  async function persist(updated) {
    const prev = cases;
    setCases(cs => cs.map(c => (c.staffId === updated.staffId && c.id === updated.id ? updated : c)));
    try {
      const saved = await wf.saveOnboarding(updated, ctx.locationId, ctx.orgId);
      setCases(cs => cs.map(c => (c === updated || (c.staffId === saved.staffId && (c.id === updated.id)) ? saved : c)));
    } catch (e) {
      setCases(prev);
      showToast('Could not save onboarding — reloading.', 'error');
      try { setCases(await wf.loadOnboarding(ctx.locationId) || []); } catch { /* keep prev */ }
    }
  }

  async function startCase(member) {
    setShowStart(false);
    const draft = { id: `tmp-${Date.now()}`, staffId: member.id, roleKey: member.role || null, steps: makeSteps(), status: 'inProgress', firstShiftDate: null };
    setCases(cs => [draft, ...cs]);
    try {
      const saved = await wf.saveOnboarding(draft, ctx.locationId, ctx.orgId);
      setCases(cs => cs.map(c => (c.id === draft.id ? saved : c)));
      showToast(`Onboarding started for ${member.name}.`, 'success');
    } catch (e) {
      setCases(cs => cs.filter(c => c.id !== draft.id));
      showToast('Could not start onboarding — try again.', 'error');
    }
  }

  function toggleStep(kase, idx) {
    const steps = (kase.steps && kase.steps.length ? kase.steps : makeSteps()).map((s, i) => {
      if (i !== idx) return s;
      const nowDone = s.status !== 'complete';
      return { ...s, status: nowDone ? 'complete' : 'pending', completedAt: nowDone ? new Date().toISOString() : null };
    });
    const allDone = steps.every(s => s.status === 'complete');
    persist({ ...kase, steps, status: allDone ? 'complete' : 'inProgress' });
  }

  if (loading) return <LoadingCard label="Loading onboarding…" />;

  if (cases.length === 0) {
    return (
      <>
        <EmptyState
          icon="team"
          title="No onboarding in progress"
          body="Start a new-starter checklist to track right-to-work, contracts, bank details and induction in one place. Cases appear here as you onboard new team members."
          cta="Start onboarding"
          onCta={() => setShowStart(true)}
        />
        {showStart && <StartModal candidates={candidates} roles={roles} onClose={() => setShowStart(false)} onStart={startCase} />}
      </>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Onboarding</h2>
          <div style={{ fontSize: 12.5, color: 'var(--t3)', marginTop: 3 }}>{cases.length} {cases.length === 1 ? 'case' : 'cases'} · {cases.filter(c => countDone(c) >= STEPS.length).length} complete</div>
        </div>
        <button className="btn btn-acc" onClick={() => setShowStart(true)}><Icon name="plus" size={14} /> Start onboarding</button>
      </div>
      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {cases.map(kase => (
          <CaseCard key={kase.id} kase={kase} staffMember={staffById[kase.staffId]} roles={roles} onToggle={toggleStep} />
        ))}
      </div>
      {showStart && <StartModal candidates={candidates} roles={roles} onClose={() => setShowStart(false)} onStart={startCase} />}
    </>
  );
}
