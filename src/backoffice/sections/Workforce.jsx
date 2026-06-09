// src/backoffice/sections/Workforce.jsx
//
// Workforce (staff management) — a Back Office section group, rendered inside the
// BO content area with the BO/ServOS UI. Real build (no demo data):
//   • Staff are added here (persisted) and can be promoted to a POS system user
//     ("Set as POS user") which creates them in Team (staff_members / Supabase).
//   • Rota / timesheets / tronc / compliance build from real staff + show empty
//     states until populated. POS-sourced numbers (sales, clock-ins, tips) wire
//     to the POS in the hardening pass.

import { useState, useEffect, useMemo } from 'react';
import { useStore } from '../../store';
import { supabase } from '../../lib/supabase';
import { Icon } from '../../components/ServOSIcons';
import { DAYS, TODAY, SECTIONS, ROLES, SECTION_REQ, FORECAST, PAYROWS } from '../../staff/seed';
import { hoursOf, effectiveRate, wageByDay, labourPct, LABOUR_TARGET, troncRun, tsVariance } from '../../staff/labour';
import { loadStaff, saveStaff, softDeleteStaff, markPosUser } from '../../staff/wfData';

const money = (n, dp = 0) => '£' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const HUE = { mgmt: 250, bar: 200, floor: 150, kitchen: 38, door: 285 };
const groupColor = grp => `oklch(var(--cat-l) var(--cat-c) ${HUE[grp] ?? 250})`;
const GRP_SECTION = { bar: 'Bar', floor: 'Floor', kitchen: 'Kitchen', door: 'Door', mgmt: 'Management' };
const initials = n => (n || '').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';

const SUBS = {
  'wf-dashboard': ['Dashboard', 'Today across the group'],
  'wf-rota': ['Rota', 'Schedule & labour'],
  'wf-timesheets': ['Timesheets', 'Clocked vs scheduled'],
  'wf-timeoff': ['Time off & availability', 'Leave, availability & swaps'],
  'wf-staff': ['Staff', 'HR records'],
  'wf-onboarding': ['Onboarding', 'New starter setup'],
  'wf-compliance': ['Compliance', 'Documents & expiries'],
  'wf-pay': ['Pay & rates', 'Rates, labour & cost'],
  'wf-tronc': ['Tronc / tips', 'Pooled tip distribution'],
  'wf-announce': ['Announcements', 'Team messaging'],
  'wf-settings': ['Workforce settings', 'Venues, roles & sections'],
};

export default function Workforce({ section, orgCtx }) {
  const { addStaffMember, showToast } = useStore();
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [posFor, setPosFor] = useState(null); // staff being promoted to a POS user

  // Workforce is scoped to the location selected in the Back Office (bottom-left
  // switcher). Multi-site rollups live in Reports, not here.
  const locationId = orgCtx?.locationId || null;
  const locName = orgCtx?.locationName || 'This location';
  const key = (section || 'wf-dashboard').replace('wf-', '');

  // Load this location's staff (wf_staff, RLS-fenced) on mount + on location change.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadStaff(locationId).then(rows => { if (alive) { setStaff(rows); setLoading(false); } });
    return () => { alive = false; };
  }, [locationId]);
  const [title, sub] = SUBS[section] || ['Workforce', ''];

  // Rota roster: real staff grouped by their role's section.
  const groups = useMemo(() => {
    const by = {};
    staff.forEach(s => { const grp = ROLES[s.role]?.grp || 'floor'; (by[grp] = by[grp] || []).push(s); });
    return Object.keys(by).map(grp => ({ name: GRP_SECTION[grp] || grp, staff: by[grp] }));
  }, [staff]);

  // Add an HR record: optimistic, then persist to wf_staff; roll back on failure.
  const addStaff = async (data) => {
    setAddOpen(false);
    const tmpId = `tmp-${Date.now()}`;
    setStaff(st => [...st, { ...data, id: tmpId, days: {} }]);
    try {
      const saved = await saveStaff(data, locationId, orgCtx?.orgId);
      setStaff(st => st.map(x => x.id === tmpId ? { ...saved, days: {} } : x));
    } catch (e) {
      setStaff(st => st.filter(x => x.id !== tmpId));
      showToast?.(`Couldn't save ${data.name}: ${e.message || 'error'}`, 'error');
    }
  };

  const removeStaff = async (id) => {
    setStaff(st => st.filter(x => x.id !== id)); // soft-delete (leaver) — history preserved
    try { await softDeleteStaff(id); } catch (e) { console.warn('[wf] remove:', e?.message || e); }
  };

  const setAsPosUser = async (s, { pin, role }) => {
    const id = `s-${Date.now()}`;
    const member = { id, name: s.name, role, pin, color: '#3b82f6', initials: initials(s.name), permissions: [], active: true };
    addStaffMember(member); // immediate — shows on the Team page
    try {
      if (supabase && orgCtx?.locationId) {
        await supabase.from('staff_members').upsert({ id, location_id: orgCtx.locationId, org_id: orgCtx.orgId || null, name: s.name, role, pin, color: '#3b82f6', initials: initials(s.name), permissions: [], active: true });
      }
      await markPosUser(s.id, id); // link the HR record (wf_staff) → POS user (staff_members)
    } catch (e) { console.warn('[workforce] POS user persist failed:', e?.message || e); }
    setStaff(st => st.map(x => x.id === s.id ? { ...x, posUserId: id, posRole: role } : x));
    setPosFor(null);
    showToast?.(`${s.name} added as a POS user — see Team`);
  };

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 20, flexWrap: 'wrap' }}>
        <div>
          <div className="mono" style={{ fontSize: 10.5, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--acc)' }}>Workforce · {locName}</div>
          <h1 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.02em', marginTop: 6 }}>{title}</h1>
          <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 2 }}>{sub}</div>
        </div>
        <div style={{ flex: 1 }} />
        {key === 'staff' && <button className="btn btn-acc" onClick={() => setAddOpen(true)}><Icon name="plus" size={15} /> Add staff member</button>}
      </div>

      {key === 'dashboard' && <WfDashboard groups={groups} staffCount={staff.length} />}
      {key === 'rota' && <WfRota groups={groups} />}
      {key === 'staff' && (loading
        ? <Card style={{ textAlign: 'center', padding: 44, color: 'var(--t3)' }}>Loading staff…</Card>
        : <WfStaff staff={staff} onAdd={() => setAddOpen(true)} onSetPos={setPosFor} onRemove={removeStaff} />)}
      {key === 'timesheets' && <EmptyState icon="status" title="No timesheets yet" body="Timesheets appear when staff clock in/out against scheduled shifts. Build the rota and publish it first." />}
      {key === 'pay' && <WfPay />}
      {key === 'tronc' && <EmptyState icon="tag" title="No tronc run yet" body="The tip pool (card tips + service charge) comes from the POS. Once staff and hours exist, the weekly run splits the pool by hours × role points." />}
      {key === 'compliance' && <EmptyState icon="warn" title="No documents yet" body="Right-to-work, food hygiene, SIA and other documents are tracked per staff member. Add staff, then upload their documents here." />}
      {['timeoff', 'onboarding', 'announce', 'settings'].includes(key) && <WfPlaceholder title={title} />}

      {addOpen && <AddStaffModal locName={locName} onClose={() => setAddOpen(false)} onSave={addStaff} />}
      {posFor && <PosUserModal staff={posFor} onClose={() => setPosFor(null)} onSave={(opts) => setAsPosUser(posFor, opts)} />}
    </div>
  );
}

// ── shared ──
function Card({ children, style }) {
  return <div style={{ background: 'var(--glass-bg)', backdropFilter: 'blur(22px) saturate(150%)', WebkitBackdropFilter: 'blur(22px) saturate(150%)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow), var(--glass-hi)', borderRadius: 16, padding: 18, ...style }}>{children}</div>;
}
function RoleChip({ role }) {
  const r = ROLES[role]; if (!r) return <span style={{ color: 'var(--t3)' }}>{role}</span>; const col = groupColor(r.grp);
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: col }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: col }} />{r.lbl}</span>;
}
const BADGE = { green: ['var(--grn-d)', 'var(--grn-b)', 'var(--grn)'], amber: ['rgba(245,166,35,.13)', 'rgba(245,166,35,.30)', 'var(--amber)'], red: ['var(--red-d)', 'var(--red-b)', 'var(--red)'], blue: ['var(--blu-d)', 'var(--blu-b)', 'var(--blu)'] };
function Badge({ tone = 'green', children }) { const [bg, bd, fg] = BADGE[tone]; return <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: bg, border: `1px solid ${bd}`, color: fg, whiteSpace: 'nowrap' }}>{children}</span>; }
const th = { padding: '11px 10px', textAlign: 'left', fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)', borderBottom: '1px solid var(--glass-border)' };
const td = { padding: '10px 10px', borderBottom: '1px solid var(--bdr)', verticalAlign: 'middle', fontSize: 13 };
function EmptyState({ icon = 'sparkle', title, body, cta, onCta }) {
  return (
    <Card style={{ textAlign: 'center', padding: 44, maxWidth: 560, margin: '0 auto' }}>
      <div style={{ width: 52, height: 52, borderRadius: 14, margin: '0 auto 14px', background: 'var(--inset)', border: '1px solid var(--inset-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t3)' }}><Icon name={icon} size={24} /></div>
      <div style={{ fontSize: 17, fontWeight: 700 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--t3)', marginTop: 8, lineHeight: 1.6 }}>{body}</div>
      {cta && <button className="btn btn-acc" style={{ marginTop: 16 }} onClick={onCta}>{cta}</button>}
    </Card>
  );
}

// ── Dashboard ──
function WfDashboard({ groups, staffCount }) {
  const wage = wageByDay(groups);
  const pct = labourPct(wage[TODAY], FORECAST[TODAY]); const over = pct > LABOUR_TARGET; const hasSales = FORECAST[TODAY] > 0;
  const stats = [
    { k: 'Staff', v: String(staffCount), sub: staffCount === 0 ? 'Add your team' : 'on the books', col: 'var(--t1)' },
    { k: 'Labour % today', v: hasSales ? Math.round(pct * 100) + '%' : '—', sub: hasSales ? `vs ${Math.round(LABOUR_TARGET * 100)}% target` : 'Set a sales forecast', col: hasSales ? (over ? 'var(--red)' : 'var(--grn)') : 'var(--t3)' },
    { k: 'Wage cost today', v: money(wage[TODAY]), sub: hasSales ? `Forecast ${money(FORECAST[TODAY])}` : 'From the rota', col: 'var(--acc)' },
    { k: 'Needs action', v: '0', sub: 'All clear', col: 'var(--amber)' },
  ];
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14 }}>
      {stats.map(s => (
        <Card key={s.k} style={{ position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: s.col }} />
          <div className="mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)' }}>{s.k}</div>
          <div className="mono" style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-.02em', marginTop: 10, color: s.col }}>{s.v}</div>
          <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6 }}>{s.sub}</div>
        </Card>
      ))}
    </div>
  );
}

// ── Staff (HR list + CRUD) ──
function WfStaff({ staff, onAdd, onSetPos, onRemove }) {
  if (staff.length === 0) return <EmptyState icon="team" title="No staff yet" body="Add your team here. Each person is an HR record — you can then set them as a POS user to give them till access on the Team page." cta="Add staff member" onCta={onAdd} />;
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{['Name', 'Role', 'Contract', 'Mobile', 'POS access', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
        <tbody>
          {staff.map(s => {
            const role = ROLES[s.role]; const rate = role ? (role.rate ? `£${role.rate.toFixed(2)}/h` : `£${role.salary / 1000}k`) : '';
            return (
              <tr key={s.id}>
                <td style={td}><div style={{ display: 'flex', alignItems: 'center', gap: 9 }}><span style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--inset)', border: '1px solid var(--inset-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: 'var(--t3)', flexShrink: 0 }}>{initials(s.name)}</span><b style={{ fontWeight: 600 }}>{s.name}</b></div></td>
                <td style={td}><RoleChip role={s.role} /> <span className="mono" style={{ fontSize: 11, color: 'var(--t4)', marginLeft: 4 }}>{rate}</span></td>
                <td style={{ ...td, color: 'var(--t2)' }}>{s.contractType || '—'}</td>
                <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--t2)' }}>{s.mobile || '—'}</td>
                <td style={td}>{s.posUserId ? <Badge tone="green">POS user ✓</Badge> : <button className="btn btn-ghost btn-xs" onClick={() => onSetPos(s)}>Set as POS user</button>}</td>
                <td style={{ ...td, textAlign: 'right' }}><button className="btn btn-ghost btn-xs" onClick={() => onRemove(s.id)} title="Remove"><Icon name="close" size={13} /></button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}

const inputStyle = { width: '100%', background: 'var(--bg3)', border: '1.5px solid var(--bdr2)', borderRadius: 10, padding: '10px 12px', height: 42, fontSize: 13, color: 'var(--t1)', fontFamily: 'inherit', outline: 'none' };
const labelStyle = { display: 'block', fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)', marginBottom: 6 };

function AddStaffModal({ locName, onClose, onSave }) {
  const [f, setF] = useState({ name: '', role: 'server', contractType: 'partTime', mobile: '', email: '', dob: '', startDate: '' });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  const valid = f.name.trim().length > 1;
  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 480 }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Add staff member</div>
        <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 16 }}>HR record for {locName}. Set them as a POS user afterwards to grant till access.</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={{ gridColumn: '1 / -1' }}><label style={labelStyle}>Full name</label><input style={inputStyle} value={f.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Jordan Lee" autoFocus /></div>
          <div><label style={labelStyle}>Role</label><select style={inputStyle} value={f.role} onChange={e => set('role', e.target.value)}>{Object.entries(ROLES).map(([k, r]) => <option key={k} value={k}>{r.lbl}</option>)}</select></div>
          <div><label style={labelStyle}>Contract</label><select style={inputStyle} value={f.contractType} onChange={e => set('contractType', e.target.value)}><option value="zeroHours">Zero hours</option><option value="partTime">Part time</option><option value="fullTime">Full time</option><option value="salaried">Salaried</option></select></div>
          <div><label style={labelStyle}>Mobile (SMS)</label><input style={inputStyle} value={f.mobile} onChange={e => set('mobile', e.target.value)} placeholder="+44 7700 900000" /></div>
          <div><label style={labelStyle}>Email</label><input style={inputStyle} value={f.email} onChange={e => set('email', e.target.value)} placeholder="name@email.com" /></div>
          <div><label style={labelStyle}>Date of birth</label><input style={inputStyle} type="date" value={f.dob} onChange={e => set('dob', e.target.value)} /></div>
          <div><label style={labelStyle}>Start date</label><input style={inputStyle} type="date" value={f.startDate} onChange={e => set('startDate', e.target.value)} /></div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 20 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-acc" disabled={!valid} onClick={() => onSave(f)}>Add staff member</button>
        </div>
      </div>
    </div>
  );
}

function PosUserModal({ staff, onClose, onSave }) {
  const [pin, setPin] = useState('');
  const [role, setRole] = useState(ROLES[staff.role]?.lbl || 'Server');
  const POS_ROLES = ['Manager', 'Supervisor', 'Bartender', 'Server', 'Host', 'Chef', 'Kitchen Porter'];
  const valid = /^\d{4}$/.test(pin);
  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 400 }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Set {staff.name} as a POS user</div>
        <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 16 }}>Creates a till login on the Team page. They'll use this 4-digit PIN to clock in and operate the POS.</div>
        <div style={{ marginBottom: 12 }}><label style={labelStyle}>POS role</label><select style={inputStyle} value={role} onChange={e => setRole(e.target.value)}>{POS_ROLES.map(r => <option key={r} value={r}>{r}</option>)}</select></div>
        <div style={{ marginBottom: 16 }}><label style={labelStyle}>4-digit PIN</label><input style={{ ...inputStyle, letterSpacing: 6, fontFamily: 'var(--font-mono)', fontSize: 18 }} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="0000" inputMode="numeric" /></div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-acc" disabled={!valid} onClick={() => onSave({ pin, role })}>Create POS user</button>
        </div>
      </div>
    </div>
  );
}

// ── Rota (the spine) — builds from real staff ──
function WfRota({ groups }) {
  const [view, setView] = useState('a');
  const [pub, setPub] = useState(false);
  const wage = wageByDay(groups);
  if (groups.length === 0) return <EmptyState icon="floor" title="No rota yet" body="Add staff first — then they appear here grouped by section and you can build their shifts. The labour footer (wage vs sales) updates live as you schedule." />;
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <div style={{ display: 'inline-flex', padding: 3, borderRadius: 11, background: 'var(--inset)', border: '1px solid var(--inset-border)' }}>
          {[['a', 'By staff'], ['b', 'By section']].map(([k, lbl]) => (
            <button key={k} onClick={() => setView(k)} style={{ padding: '7px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, background: view === k ? 'var(--bg1)' : 'transparent', boxShadow: view === k ? 'var(--glass-hi)' : 'none', color: view === k ? 'var(--t1)' : 'var(--t3)' }}>{lbl}</button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn btn-acc btn-sm" onClick={() => setPub(true)}>Publish rota →</button>
      </div>
      <Card style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>{view === 'a' ? <RotaByStaff groups={groups} wage={wage} /> : <RotaBySection groups={groups} />}</div>
      </Card>
      {pub && <PublishModal groups={groups} onClose={() => setPub(false)} />}
    </>
  );
}
const cellTint = (col, a) => `color-mix(in oklch, ${col} ${a}%, transparent)`;
function RotaByStaff({ groups, wage }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 880 }}>
      <thead><tr><th style={{ ...th, minWidth: 200 }}>Staff · role</th>{DAYS.map((d, i) => <th key={i} style={{ ...th, textAlign: 'center', color: i === TODAY ? 'var(--acc)' : 'var(--t3)' }}>{d[0]} {d[1]}</th>)}</tr></thead>
      <tbody>{groups.map(g => <RotaGroupRows key={g.name} g={g} />)}</tbody>
      <tfoot>
        <FootRow label="Forecast sales" cells={FORECAST.map(f => f ? money(f) : '—')} />
        <FootRow label="Wage cost" cells={wage.map(w => money(w))} />
        <tr><td style={{ ...td, fontWeight: 700, color: 'var(--t2)' }}>Labour % <span style={{ color: 'var(--t4)', fontWeight: 400 }}>(target {Math.round(LABOUR_TARGET * 100)}%)</span></td>{wage.map((w, i) => { const has = FORECAST[i] > 0; const p = labourPct(w, FORECAST[i]); const over = p > LABOUR_TARGET; return <td key={i} style={{ ...td, textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 800, color: !has ? 'var(--t4)' : over ? 'var(--red)' : 'var(--grn)' }}>{has ? Math.round(p * 100) + '%' : '—'}</td>; })}</tr>
      </tfoot>
    </table>
  );
}
function RotaGroupRows({ g }) {
  return (
    <>
      <tr><td colSpan={8} style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--t4)', background: 'var(--inset)', fontWeight: 700 }}>{g.name}</td></tr>
      {g.staff.map(s => {
        const role = ROLES[s.role]; const days = s.days || {};
        const rateLbl = role ? (role.rate ? `£${role.rate.toFixed(2)}/h${s.band ? ' · ' + s.band : ''}` : `£${role.salary / 1000}k · salaried`) : '';
        return (
          <tr key={s.id || s.name}>
            <td style={{ ...td, borderRight: '1px solid var(--bdr)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                <span style={{ width: 26, height: 26, borderRadius: '50%', background: 'var(--inset)', border: '1px solid var(--inset-border)', flexShrink: 0 }} />
                <div style={{ minWidth: 0 }}><div style={{ fontWeight: 600 }}>{s.name}</div><div style={{ fontSize: 10.5, color: 'var(--t3)', display: 'flex', alignItems: 'center', gap: 6, marginTop: 1 }}><RoleChip role={s.role} /><span style={{ fontFamily: 'var(--font-mono)' }}>{rateLbl}</span></div></div>
              </div>
            </td>
            {Array.from({ length: 7 }, (_, i) => {
              const c = days[i]; const tcol = i === TODAY ? 'var(--inset)' : undefined;
              if (Array.isArray(c)) { const col = groupColor(c[2]); const hrs = hoursOf(c[0], c[1]); return <td key={i} style={{ ...td, padding: 4, background: tcol }}><div style={{ borderRadius: 9, padding: '6px 8px', background: cellTint(col, 13), border: `1px solid ${cellTint(col, 30)}`, borderLeft: `2.5px solid ${col}` }}><div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, fontWeight: 700 }}>{c[0]}–{c[1]}</div><div style={{ fontSize: 10, color: 'var(--t3)' }}>{hrs}h</div></div></td>; }
              return <td key={i} style={{ ...td, textAlign: 'center', background: tcol }}><button style={{ width: 26, height: 26, borderRadius: 8, border: '1px dashed var(--bdr2)', background: 'transparent', color: 'var(--t4)', cursor: 'pointer', fontSize: 15 }}>+</button></td>;
            })}
          </tr>
        );
      })}
    </>
  );
}
function FootRow({ label, cells }) { return <tr><td style={{ ...td, fontWeight: 600, color: 'var(--t2)' }}>{label}</td>{cells.map((c, i) => <td key={i} style={{ ...td, textAlign: 'center', fontFamily: 'var(--font-mono)', color: 'var(--t2)' }}>{c}</td>)}</tr>; }
function RotaBySection({ groups }) {
  const map = {}; Object.keys(SECTION_REQ).forEach(s => map[s] = {});
  groups.forEach(g => g.staff.forEach(s => { for (let i = 0; i < 7; i++) { const c = (s.days || {})[i]; if (Array.isArray(c) && map[c[2]]) { (map[c[2]][i] = map[c[2]][i] || []).push(s.name.split(' ')[0]); } } }));
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 880 }}>
      <thead><tr><th style={{ ...th, minWidth: 160 }}>Section</th>{DAYS.map((d, i) => <th key={i} style={{ ...th, textAlign: 'center', color: i === TODAY ? 'var(--acc)' : 'var(--t3)' }}>{d[0]} {d[1]}</th>)}</tr></thead>
      <tbody>{Object.keys(SECTION_REQ).map(sec => { const req = SECTION_REQ[sec]; const col = groupColor(sec); return (
        <tr key={sec}><td style={{ ...td, borderRight: '1px solid var(--bdr)' }}><div style={{ fontWeight: 600, color: col }}>{SECTIONS[sec]}</div><div style={{ fontSize: 10.5, color: 'var(--t4)' }}>Min {req}</div></td>
          {Array.from({ length: 7 }, (_, i) => { const ppl = map[sec][i] || []; const n = ppl.length; const ok = n >= req; return <td key={i} style={{ ...td, textAlign: 'center', background: i === TODAY ? 'var(--inset)' : undefined }}><span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: ok ? 'var(--grn)' : n === 0 ? 'var(--t4)' : 'var(--red)' }}>{n}/{req}</span></td>; })}
        </tr>); })}</tbody>
    </table>
  );
}

// ── Pay & rates (rate card from config) ──
function WfPay() {
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{['Role', 'Pay type', 'Rate', 'Note', ''].map((h, i) => <th key={i} style={{ ...th, textAlign: i === 2 ? 'right' : 'left' }}>{h}</th>)}</tr></thead>
        <tbody>{PAYROWS.map((r, i) => (
          <tr key={i}><td style={td}><span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600, color: groupColor(r.grp) }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: groupColor(r.grp) }} />{r.role}</span></td><td style={{ ...td, color: 'var(--t2)' }}>{r.type}</td><td style={{ ...td, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{r.rate}</td><td style={{ ...td, color: 'var(--t3)', fontSize: 12 }}>{r.note || '—'}</td><td style={{ ...td, textAlign: 'right' }}><button className="btn btn-ghost btn-xs">Edit</button></td></tr>
        ))}</tbody>
      </table>
    </Card>
  );
}

function PublishModal({ groups, onClose }) {
  const recipients = groups.flatMap(g => g.staff);
  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 440 }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>Publish rota</div>
        <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 14 }}>Sends each person their own shifts by SMS with a confirm link.</div>
        {recipients.length === 0 ? <div style={{ fontSize: 13, color: 'var(--t3)', padding: '12px 0' }}>No staff scheduled yet.</div> : (
          <div style={{ border: '1px solid var(--bdr)', borderRadius: 10, maxHeight: 200, overflowY: 'auto', marginBottom: 14 }}>
            {recipients.map((s, i) => <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '9px 12px', borderBottom: i < recipients.length - 1 ? '1px solid var(--bdr)' : 'none', fontSize: 13 }}><span style={{ flex: 1 }}>{s.name}</span><span className="mono" style={{ fontSize: 11, color: s.mobile ? 'var(--t4)' : 'var(--red)' }}>{s.mobile || 'No mobile'}</span></div>)}
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9 }}><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-acc" onClick={onClose}>Publish & send SMS</button></div>
      </div>
    </div>
  );
}

function WfPlaceholder({ title }) {
  return <EmptyState icon="sparkle" title={title} body={`This Workforce screen is in the build queue. ${title} ships next, wired to the same staff + labour engine.`} />;
}
