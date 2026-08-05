// src/backoffice/sections/workforce/WfPay.jsx
//
// Workforce → PAY & RATES. Two parts:
//   (1) Editable RATE CARD — roles.list table with per-row Edit + Add role.
//   (2) PERIOD PAY — server-side compute of approved hours + pay per staff.
// Pay math is NEVER trusted client-side; the compute action runs on the server.

import { useState, useEffect, useMemo } from 'react';
import { Icon } from '../../../components/ServOSIcons';
import { Card, EmptyState, Badge, RoleChip, money, th, td, inputStyle, labelStyle, groupColor, GRP_SECTION, LoadingCard } from '../../../staff/wfUi';
import * as wf from '../../../staff/wfData';

const PAY_TYPES = [
  { v: 'hourly', lbl: 'Hourly' },
  { v: 'salaried', lbl: 'Salaried' },
  { v: 'ageBanded', lbl: 'Age-banded' },
];

const blankRole = () => ({
  key: '', lbl: '', grp: 'floor', payType: 'hourly',
  rate: null, salary: null, contractedWeek: 40, troncWeight: 1, requiresSIA: false,
});

function rateLabel(r) {
  if (r.payType === 'salaried') return r.salary != null ? `${money(Math.round(r.salary / 1000))}k/yr` : '—';
  if (r.payType === 'ageBanded') return 'banded';
  return r.rate != null ? `${money(r.rate, 2)}/h` : '—';
}

export default function WfPay({ ctx, staff, roles, sections, settings, week, showToast, onRolesChanged }) {
  const [roleList, setRoleList] = useState(roles?.list || []);
  const [editing, setEditing] = useState(null);     // role object being edited (or new)
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  // v5.5.970 — future-dated rate changes (wf_rate_changes)
  const [rateChanges, setRateChanges] = useState([]);
  const [scheduling, setScheduling] = useState(false);

  // Seed local roles from props; refresh when the location's roles change.
  useEffect(() => { setRoleList(roles?.list || []); }, [roles]);

  // On open: apply any change that fell due since 03:05 (idempotent, server-side),
  // then load the schedule list. A same-day schedule lands without waiting for cron.
  useEffect(() => {
    let dead = false;
    (async () => {
      const applied = await wf.applyDueRateChanges();
      const list = await wf.loadRateChanges(ctx.locationId);
      if (dead) return;
      setRateChanges(list);
      if (applied > 0) { showToast(`${applied} scheduled rate change${applied === 1 ? '' : 's'} applied`, 'success'); reloadRoles(); }
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.locationId]);

  const reloadRoles = async () => {
    setLoading(true);
    try {
      const fresh = await wf.loadRoles(ctx.locationId, ctx.orgId);
      setRoleList(fresh.list || []);
      onRolesChanged?.(fresh.list || []);
    } catch (e) {
      showToast(e.message || 'Could not reload roles', 'error');
    } finally { setLoading(false); }
  };

  const roleMap = useMemo(() => {
    const m = {}; roleList.forEach(r => { m[r.key] = r; }); return m;
  }, [roleList]);

  const nameOf = id => (staff || []).find(s => s.id === id)?.name || id;

  async function saveRole(role) {
    setBusy(true);
    try {
      const saved = await wf.saveRole(role, ctx.locationId, ctx.orgId);
      let nextList;
      setRoleList(prev => {
        const i = prev.findIndex(r => r.id === saved.id || r.key === saved.key);
        nextList = i >= 0 ? prev.map((r, j) => j === i ? saved : r) : [...prev, saved];
        return nextList;
      });
      onRolesChanged?.(nextList);
      setEditing(null);
      showToast('Rate card saved', 'success');
    } catch (e) {
      showToast(e.message || 'Save failed', 'error');
      reloadRoles();
    } finally { setBusy(false); }
  }

  async function removeRole(role) {
    const used = (staff || []).filter(s => s.role === role.key).length;
    const msg = used
      ? `${used} staff member${used === 1 ? ' is' : 's are'} assigned to "${role.lbl}". Deleting may fail until they're moved. Try anyway?`
      : `Delete the "${role.lbl}" position?`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      await wf.deleteRole(role.id);
      const nextList = roleList.filter(r => r.id !== role.id);
      setRoleList(nextList);
      onRolesChanged?.(nextList);
      setEditing(null);
      showToast('Position deleted', 'success');
    } catch (e) {
      showToast(e.message || 'Could not delete', 'error');
    } finally { setBusy(false); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* ── (1) RATE CARD ────────────────────────────────────────────── */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Rate card</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>Base pay, tronc weighting and SIA flags per role.</div>
          </div>
          <button className="btn btn-acc btn-sm" onClick={() => setEditing(blankRole())}>
            <Icon name="plus" size={14} /> Add role
          </button>
        </div>

        {loading ? (
          <LoadingCard label="Loading roles…" />
        ) : roleList.length === 0 ? (
          <EmptyState
            icon="tag"
            title="No roles yet"
            body="Add your first role to build the rate card. Roles set base pay, tronc weighting and whether SIA cover is required."
            cta="Add role"
            onCta={() => setEditing(blankRole())}
          />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Role</th>
                  <th style={th}>Group</th>
                  <th style={th}>Pay type</th>
                  <th style={{ ...th, textAlign: 'right' }}>Rate</th>
                  <th style={{ ...th, textAlign: 'right' }}>Tronc weight</th>
                  <th style={th}>SIA</th>
                  <th style={{ ...th, textAlign: 'right' }} />
                </tr>
              </thead>
              <tbody>
                {roleList.map(r => (
                  <tr key={r.id || r.key}>
                    <td style={td}><RoleChip role={r.key} roles={roleMap} /></td>
                    <td style={{ ...td, color: 'var(--t3)' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 7, height: 7, borderRadius: '50%', background: groupColor(r.grp) }} />
                        {GRP_SECTION[r.grp] || r.grp}
                      </span>
                    </td>
                    <td style={{ ...td, color: 'var(--t2)' }}>{(PAY_TYPES.find(p => p.v === r.payType) || {}).lbl || r.payType}</td>
                    <td style={{ ...td, textAlign: 'right' }} className="mono">{rateLabel(r)}</td>
                    <td style={{ ...td, textAlign: 'right' }} className="mono">{Number(r.troncWeight ?? 1).toFixed(2)}</td>
                    <td style={td}>{r.requiresSIA ? <Badge tone="amber">SIA</Badge> : <span style={{ color: 'var(--t4)' }}>—</span>}</td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <button className="btn btn-ghost btn-xs" onClick={() => setEditing({ ...r })}>
                        <Icon name="edit" size={14} /> Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── (1b) SCHEDULED RATE CHANGES — future-dated rises (v5.5.970) ── */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Scheduled rate changes</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 2 }}>
              Plan NMW or pay rises in advance — the new rate applies automatically on the date you set. Future rota weeks already use it.
            </div>
          </div>
          <button className="btn btn-acc btn-sm" onClick={() => setScheduling(true)} disabled={!roleList.length}>
            <Icon name="plus" size={14} /> Schedule change
          </button>
        </div>
        {(() => {
          const staffName = (id) => (staff || []).find(s => s.id === id)?.name || 'staff member';
          const rows = rateChanges
            .filter(c => c.status !== 'cancelled')
            .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))
            .slice(-20);
          if (!rows.length) return <div style={{ fontSize: 12.5, color: 'var(--t4)' }}>Nothing scheduled. Example: set the new NMW rate today with an effective date of 1 April — it applies itself.</div>;
          return rows.map(c => {
            const role = roleMap[c.roleKey];
            const who = c.targetKind === 'role' ? (role?.lbl || c.roleKey) : staffName(c.staffId);
            const current = c.targetKind === 'role'
              ? (c.newSalaryAnnual != null ? (role?.salary != null ? `${money(role.salary)}/yr` : '—') : (role?.rate != null ? `${money(role.rate, 2)}/h` : '—'))
              : '—';
            const next = c.newSalaryAnnual != null ? `${money(c.newSalaryAnnual)}/yr` : `${money(c.newRate, 2)}/h`;
            return (
              <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--bdr)', fontSize: 13 }}>
                <Badge tone={c.status === 'applied' ? 'green' : 'amber'}>{c.status === 'applied' ? 'Applied' : 'Scheduled'}</Badge>
                <span style={{ fontWeight: 700, color: 'var(--t1)' }}>{who}</span>
                <span className="mono" style={{ color: 'var(--t3)' }}>{c.status === 'applied' ? '' : `${current} → `}{next}</span>
                <span style={{ color: 'var(--t3)' }}>from {c.effectiveFrom}</span>
                {c.note && <span style={{ color: 'var(--t4)', fontSize: 12 }}>· {c.note}</span>}
                <span style={{ flex: 1 }} />
                {c.status === 'scheduled' && (
                  <button className="btn btn-ghost btn-xs" onClick={async () => {
                    try { await wf.cancelRateChange(c.id); setRateChanges(list => list.map(x => x.id === c.id ? { ...x, status: 'cancelled' } : x)); showToast('Scheduled change cancelled', 'info'); }
                    catch (e) { showToast(e.message || 'Could not cancel', 'error'); }
                  }}>Cancel</button>
                )}
              </div>
            );
          });
        })()}
      </Card>

      {scheduling && (
        <ScheduleRateModal
          roles={roleList} staff={staff || []} busy={busy}
          onClose={() => setScheduling(false)}
          onSave={async (payload) => {
            setBusy(true);
            try {
              const row = await wf.scheduleRateChange(payload, ctx.locationId, ctx.orgId);
              setRateChanges(list => [...list, row]);
              setScheduling(false);
              showToast(`Rate change scheduled for ${payload.effectiveFrom}`, 'success');
            } catch (e) { showToast(e.message || 'Could not schedule', 'error'); }
            finally { setBusy(false); }
          }}
        />
      )}

      {/* Payroll runs (wages + tips) live in Workforce → Payroll. */}

      {editing && (
        <RoleEditor
          role={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={saveRole}
          onDelete={removeRole}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function RoleEditor({ role, busy, onClose, onSave, onDelete }) {
  const [draft, setDraft] = useState(role);
  const isNew = !role.id;
  const set = patch => setDraft(d => ({ ...d, ...patch }));

  const num = v => (v === '' || v == null ? null : Number(v));

  function submit() {
    const next = {
      ...draft,
      lbl: (draft.lbl || '').trim(),
      key: (draft.key || draft.lbl || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      rate: draft.payType === 'hourly' ? num(draft.rate) : draft.rate,
      salary: draft.payType === 'salaried' ? num(draft.salary) : draft.salary,
      contractedWeek: num(draft.contractedWeek) ?? 40,
      troncWeight: num(draft.troncWeight) ?? 1,
    };
    onSave(next);
  }

  const valid = (draft.lbl || '').trim().length > 0;

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 480 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{isNew ? 'Add role' : 'Edit role'}</div>
          <button className="btn btn-ghost btn-xs" onClick={onClose}><Icon name="close" size={14} /></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>Role name</label>
            <input style={inputStyle} value={draft.lbl || ''} placeholder="e.g. Bartender" onChange={e => set({ lbl: e.target.value })} />
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Group</label>
              <select style={inputStyle} value={draft.grp} onChange={e => set({ grp: e.target.value })}>
                {Object.entries(GRP_SECTION).map(([v, lbl]) => <option key={v} value={v}>{lbl}</option>)}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Pay type</label>
              <select style={inputStyle} value={draft.payType} onChange={e => set({ payType: e.target.value })}>
                {PAY_TYPES.map(p => <option key={p.v} value={p.v}>{p.lbl}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12 }}>
            {draft.payType === 'salaried' ? (
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Salary (£/yr)</label>
                <input style={inputStyle} type="number" step="100" value={draft.salary ?? ''} placeholder="28000" onChange={e => set({ salary: e.target.value })} />
              </div>
            ) : (
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Base rate (£/h)</label>
                <input style={inputStyle} type="number" step="0.01" value={draft.rate ?? ''} placeholder="12.50" disabled={draft.payType === 'ageBanded'} onChange={e => set({ rate: e.target.value })} />
              </div>
            )}
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Contracted week (h)</label>
              <input style={inputStyle} type="number" step="1" value={draft.contractedWeek ?? ''} placeholder="40" onChange={e => set({ contractedWeek: e.target.value })} />
            </div>
          </div>

          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end' }}>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>Tronc weight</label>
              <input style={inputStyle} type="number" step="0.25" value={draft.troncWeight ?? ''} placeholder="1" onChange={e => set({ troncWeight: e.target.value })} />
            </div>
            <label style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, height: 42, cursor: 'pointer', color: 'var(--t1)', fontSize: 13 }}>
              <input type="checkbox" checked={!!draft.requiresSIA} onChange={e => set({ requiresSIA: e.target.checked })} />
              Requires SIA licence
            </label>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 20 }}>
          {!isNew && (
            <button className="btn btn-ghost" style={{ color: 'var(--red)' }} disabled={busy} onClick={() => onDelete?.(role)}>
              <Icon name="close" size={13} /> Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-acc" onClick={submit} disabled={busy || !valid}>
            <Icon name="check" size={14} /> {busy ? 'Saving…' : 'Save role'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── v5.5.970 — Schedule a future-dated rate change ───────────────────────────
// Position-level (the customer ask: NMW/salary rises "at position level so they
// apply automatically") or a single staff member's override. On the effective
// date apply_due_wf_rate_changes() lands it on the live rate card; before then
// the rota already stamps the new rate for shifts on/after the date.
function ScheduleRateModal({ roles, staff, busy, onClose, onSave }) {
  const todayIso = new Date().toISOString().slice(0, 10);
  const [kind, setKind] = useState('role');
  const [roleKey, setRoleKey] = useState(roles[0]?.key || '');
  const [staffId, setStaffId] = useState('');
  const [rate, setRate] = useState('');
  const [salary, setSalary] = useState('');
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');

  const role = roles.find(r => r.key === roleKey);
  const salaried = kind === 'role' && role?.payType === 'salaried';
  const valid = date >= todayIso
    && (kind === 'role' ? !!roleKey : !!staffId)
    && (salaried ? Number(salary) > 0 : Number(rate) > 0);

  function submit() {
    if (!valid) return;
    onSave({
      targetKind: kind,
      roleKey: kind === 'role' ? roleKey : null,
      staffId: kind === 'staff' ? staffId : null,
      newRate: salaried ? null : Number(rate),
      newSalaryAnnual: salaried ? Number(salary) : null,
      effectiveFrom: date,
      note: note.trim() || null,
    });
  }

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: 'var(--bg1)', border: '1px solid var(--bdr2)', borderRadius: 16, width: '100%', maxWidth: 420, padding: 20, boxShadow: 'var(--sh3)' }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Schedule a rate change</div>
        <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 14 }}>
          The new amount applies automatically on the date you pick. History and past pay are never touched.
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button className={`btn btn-sm ${kind === 'role' ? 'btn-acc' : 'btn-ghost'}`} onClick={() => setKind('role')}>Position</button>
          <button className={`btn btn-sm ${kind === 'staff' ? 'btn-acc' : 'btn-ghost'}`} onClick={() => setKind('staff')}>Individual</button>
        </div>

        {kind === 'role' ? (
          <label style={labelStyle}>Position
            <select style={inputStyle} value={roleKey} onChange={e => setRoleKey(e.target.value)}>
              {roles.map(r => <option key={r.key} value={r.key}>{r.lbl}</option>)}
            </select>
          </label>
        ) : (
          <label style={labelStyle}>Staff member
            <select style={inputStyle} value={staffId} onChange={e => setStaffId(e.target.value)}>
              <option value="">Choose…</option>
              {staff.filter(s => s.status !== 'leaver').map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </label>
        )}

        {salaried ? (
          <label style={labelStyle}>New salary (per year)
            <input style={inputStyle} type="number" min="0" step="100" value={salary} onChange={e => setSalary(e.target.value)}
              placeholder={role?.salary != null ? `currently ${role.salary}` : ''} />
          </label>
        ) : (
          <label style={labelStyle}>New hourly rate
            <input style={inputStyle} type="number" min="0" step="0.01" value={rate} onChange={e => setRate(e.target.value)}
              placeholder={kind === 'role' && role?.rate != null ? `currently ${role.rate}` : ''} />
          </label>
        )}

        <label style={labelStyle}>Starts on
          <input style={inputStyle} type="date" min={todayIso} value={date} onChange={e => setDate(e.target.value)} />
        </label>
        <label style={labelStyle}>Note (optional)
          <input style={inputStyle} value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. NMW April increase" />
        </label>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn btn-acc" onClick={submit} disabled={!valid || busy}>
            <Icon name={busy ? 'clock' : 'check'} size={14} /> {busy ? 'Scheduling…' : 'Schedule'}
          </button>
        </div>
      </div>
    </div>
  );
}
