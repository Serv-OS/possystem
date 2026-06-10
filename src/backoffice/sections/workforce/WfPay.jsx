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

export default function WfPay({ ctx, staff, roles, sections, settings, week, showToast }) {
  const [roleList, setRoleList] = useState(roles?.list || []);
  const [editing, setEditing] = useState(null);     // role object being edited (or new)
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  // Seed local roles from props; refresh when the location's roles change.
  useEffect(() => { setRoleList(roles?.list || []); }, [roles]);

  const reloadRoles = async () => {
    setLoading(true);
    try {
      const fresh = await wf.loadRoles(ctx.locationId, ctx.orgId);
      setRoleList(fresh.list || []);
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
      setRoleList(prev => {
        const i = prev.findIndex(r => r.id === saved.id || r.key === saved.key);
        if (i >= 0) { const next = prev.slice(); next[i] = saved; return next; }
        return [...prev, saved];
      });
      setEditing(null);
      showToast('Rate card saved', 'success');
    } catch (e) {
      showToast(e.message || 'Save failed', 'error');
      reloadRoles();
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

      {/* Payroll runs (wages + tips) live in Workforce → Payroll. */}

      {editing && (
        <RoleEditor
          role={editing}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={saveRole}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
function RoleEditor({ role, busy, onClose, onSave }) {
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

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-acc" onClick={submit} disabled={busy || !valid}>
            <Icon name="check" size={14} /> {busy ? 'Saving…' : 'Save role'}
          </button>
        </div>
      </div>
    </div>
  );
}
