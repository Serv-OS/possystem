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
import { hoursOf, effectiveRate, wageByDay, labourPct, LABOUR_TARGET, troncRun, tsVariance, isHourly, FIXED_HOLIDAY_DAYS } from '../../staff/labour';
import { loadStaff, saveStaff, softDeleteStaff, markPosUser, loadRoles, loadSections, loadSettings, loadDocuments, loadTimesheets, loadOnboarding, loadAccrual, accrualBalances, signedDocUrl, saveStaffBank, saveOnboarding, sendEmail } from '../../staff/wfData';
import { buildWeek } from '../../staff/wfWeek';
import WfRota from './workforce/WfRota';
import { PickTemplateModal, freshSteps, genToken, toHtml, signEmailHtml } from './workforce/WfOnboarding';
import WfTimesheets from './workforce/WfTimesheets';
import WfPayroll from './workforce/WfPayroll';
import WfTronc from './workforce/WfTronc';
import WfPay from './workforce/WfPay';
import WfLeave from './workforce/WfLeave';
import WfOnboarding from './workforce/WfOnboarding';
import WfCompliance from './workforce/WfCompliance';
import WfAnnouncements from './workforce/WfAnnouncements';
import WfSettings from './workforce/WfSettings';

const money = (n, dp = 0) => '£' + Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const HUE = { mgmt: 250, bar: 200, floor: 150, kitchen: 38, door: 285 };
const groupColor = grp => `oklch(var(--cat-l) var(--cat-c) ${HUE[grp] ?? 250})`;
const GRP_SECTION = { bar: 'Bar', floor: 'Floor', kitchen: 'Kitchen', door: 'Door', mgmt: 'Management' };
const initials = n => (n || '').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';

const SUBS = {
  'wf-dashboard': ['Dashboard', 'Today across the group'],
  'wf-rota': ['Rota', 'Schedule & labour'],
  'wf-timesheets': ['Timesheets', 'Clocked vs scheduled'],
  'wf-payroll': ['Payroll', 'Pay runs — wages + tips'],
  'wf-timeoff': ['Time off & availability', 'Leave, availability & swaps'],
  'wf-staff': ['Staff', 'HR records'],
  'wf-onboarding': ['Onboarding', 'New starter setup'],
  'wf-compliance': ['Compliance', 'Documents & expiries'],
  'wf-pay': ['Positions & rates', 'Add, edit & remove positions and their pay'],
  'wf-tronc': ['Tronc / tips', 'Pooled tip distribution'],
  'wf-announce': ['Announcements', 'Team messaging'],
  'wf-settings': ['Workforce settings', 'Venues, roles & sections'],
};

export default function Workforce({ section, orgCtx }) {
  const { addStaffMember, showToast } = useStore();
  const [staff, setStaff] = useState([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState(null); // staff record being edited (HR + rate override)
  const [viewing, setViewing] = useState(null); // staff record whose detail profile is open
  const [posFor, setPosFor] = useState(null); // staff being promoted to a POS user

  // Workforce is scoped to the location selected in the Back Office (bottom-left
  // switcher). Multi-site rollups live in Reports, not here.
  const locationId = orgCtx?.locationId || null;
  const locName = orgCtx?.locationName || 'This location';
  const key = (section || 'wf-dashboard').replace('wf-', '');

  // Editable positions (wf_roles), sections (wf_sections) + venue settings.
  const [roles, setRoles] = useState({ list: [], map: {} });
  const [sections, setSections] = useState([]);
  const [settings, setSettings] = useState({ currency: 'GBP', labourTargetPct: 0.28, accrualRate: 0.1207, premiums: {}, salesSource: 'pos' });

  // Holiday accrued per staff (hours, from the accrual ledger) — shown on the
  // staff list rows; salaried staff show their fixed days instead.
  const [holidayHours, setHolidayHours] = useState({});

  // Load this location's staff (wf_staff, RLS-fenced) + config on mount / location change.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    loadStaff(locationId).then(rows => { if (alive) { setStaff(rows); setLoading(false); } });
    Promise.all([loadRoles(locationId, orgCtx?.orgId), loadSections(locationId), loadSettings(locationId)])
      .then(([r, s, set]) => { if (alive) { if (r) setRoles(r); if (s) setSections(s); if (set) setSettings(set); } })
      .catch(() => {});
    loadAccrual(locationId).then(rows => { if (alive) setHolidayHours(accrualBalances(rows || [])); }).catch(() => {});
    return () => { alive = false; };
  }, [locationId]);

  const week = useMemo(() => buildWeek(), []);
  const ctx = useMemo(() => ({ locationId, orgId: orgCtx?.orgId || null, locName: orgCtx?.locationName || 'our team', actor: { id: orgCtx?.userId || null, name: orgCtx?.userName || null } }), [locationId, orgCtx]);
  // onSettingsSaved / onRolesChanged: child sections push saved state back up
  // so the rest of Workforce (staff role dropdown, rota, pay maths) sees the
  // change without a reload — deleted positions must leave dropdowns at once.
  const sectionProps = {
    ctx, staff, roles, sections, settings, week, showToast,
    onSettingsSaved: setSettings,
    onRolesChanged: (list) => { const map = {}; (list || []).forEach(r => { map[r.key] = r; }); setRoles({ list: list || [], map }); },
  };
  const rolesMap = (roles.map && Object.keys(roles.map).length) ? roles.map : ROLES;
  const [title, sub] = SUBS[section] || ['Workforce', ''];

  // Rota roster: real staff grouped by their role's section.
  const groups = useMemo(() => {
    const by = {};
    staff.forEach(s => { const grp = ROLES[s.role]?.grp || 'floor'; (by[grp] = by[grp] || []).push(s); });
    return Object.keys(by).map(grp => ({ name: GRP_SECTION[grp] || grp, staff: by[grp] }));
  }, [staff]);

  // Add or edit an HR record (incl. per-employee pay-rate override): optimistic,
  // persist to wf_staff, roll back on failure.
  const saveMember = async (data) => {
    setAddOpen(false); setEditing(null);
    if (data.id) { // edit
      const prev = staff;
      setStaff(st => st.map(x => x.id === data.id ? { ...x, ...data } : x));
      try {
        const saved = await saveStaff(data, locationId, orgCtx?.orgId);
        setStaff(st => st.map(x => x.id === data.id ? { ...saved, days: x.days || {} } : x));
      } catch (e) { setStaff(prev); showToast?.(`Couldn't save ${data.name}: ${e.message || 'error'}`, 'error'); }
      return;
    }
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
      {key === 'rota' && <WfRota {...sectionProps} />}
      {key === 'staff' && (loading
        ? <Card style={{ textAlign: 'center', padding: 44, color: 'var(--t3)' }}>Loading staff…</Card>
        : <WfStaff staff={staff} roles={rolesMap} holidayHours={holidayHours} onAdd={() => setAddOpen(true)} onView={setViewing} onEdit={setEditing} onSetPos={setPosFor} onRemove={removeStaff} />)}
      {key === 'timesheets' && <WfTimesheets {...sectionProps} />}
      {key === 'payroll' && <WfPayroll {...sectionProps} />}
      {key === 'pay' && <WfPay {...sectionProps} />}
      {key === 'tronc' && <WfTronc {...sectionProps} />}
      {key === 'compliance' && <WfCompliance {...sectionProps} />}
      {key === 'timeoff' && <WfLeave {...sectionProps} />}
      {key === 'onboarding' && <WfOnboarding {...sectionProps} />}
      {key === 'announce' && <WfAnnouncements {...sectionProps} />}
      {key === 'settings' && <WfSettings {...sectionProps} />}

      {viewing && <StaffDetailModal staff={viewing} roles={rolesMap} ctx={ctx} showToast={showToast} onClose={() => setViewing(null)} onEdit={(s) => { setViewing(null); setEditing(s); }} onSetPos={(s) => { setViewing(null); setPosFor(s); }}
        onPatch={(patch) => { setStaff(st => st.map(x => x.id === viewing.id ? { ...x, ...patch } : x)); setViewing(v => v ? { ...v, ...patch } : v); }} />}
      {(addOpen || editing) && <AddStaffModal locName={locName} staff={editing} roles={rolesMap} sections={sections} onClose={() => { setAddOpen(false); setEditing(null); }} onSave={saveMember} />}
      {posFor && <PosUserModal staff={posFor} onClose={() => setPosFor(null)} onSave={(opts) => setAsPosUser(posFor, opts)} />}
    </div>
  );
}

// ── shared ──
function Card({ children, style }) {
  return <div style={{ background: 'var(--glass-bg)', backdropFilter: 'blur(22px) saturate(150%)', WebkitBackdropFilter: 'blur(22px) saturate(150%)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow), var(--glass-hi)', borderRadius: 16, padding: 18, ...style }}>{children}</div>;
}
function RoleChip({ role, roles = ROLES }) {
  const r = roles[role]; if (!r) return <span style={{ color: 'var(--t3)' }}>{role || '—'}</span>; const col = groupColor(r.grp);
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: col }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: col }} />{r.lbl}</span>;
}
const BADGE = { green: ['var(--grn-d)', 'var(--grn-b)', 'var(--grn)'], amber: ['rgba(245,166,35,.13)', 'rgba(245,166,35,.30)', 'var(--amber)'], red: ['var(--red-d)', 'var(--red-b)', 'var(--red)'], blue: ['var(--blu-d)', 'var(--blu-b)', 'var(--blu)'], grey: ['var(--inset)', 'var(--inset-border)', 'var(--t3)'] };
function Badge({ tone = 'green', children }) { const [bg, bd, fg] = BADGE[tone] || BADGE.green; return <span style={{ display: 'inline-flex', alignItems: 'center', fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: bg, border: `1px solid ${bd}`, color: fg, whiteSpace: 'nowrap' }}>{children}</span>; }
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
function WfStaff({ staff, roles = ROLES, holidayHours = {}, onAdd, onView, onEdit, onSetPos, onRemove }) {
  if (staff.length === 0) return <EmptyState icon="team" title="No staff yet" body="Add your team here. Each person is an HR record — you can then set them as a POS user to give them till access on the Team page." cta="Add staff member" onCta={onAdd} />;
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{['Name', 'Position', 'Pay rate', 'Contract', 'Holiday', 'Mobile', 'POS access', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
        <tbody>
          {staff.map(s => {
            const role = roles[s.role];
            const baseRate = role ? (role.rate != null ? `£${Number(role.rate).toFixed(2)}/h` : (role.salary ? `£${Math.round(role.salary / 1000)}k/yr` : '—')) : '—';
            const hasOverride = s.rateOverride != null && s.rateOverride !== '';
            const rateLbl = hasOverride ? `£${Number(s.rateOverride).toFixed(2)}/h` : baseRate;
            return (
              <tr key={s.id}>
                <td style={td}><button onClick={() => onView?.(s)} title="View profile" style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}><span style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--inset)', border: '1px solid var(--inset-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: 'var(--t3)', flexShrink: 0 }}>{initials(s.name)}</span><b style={{ fontWeight: 600, color: 'var(--t1)', borderBottom: '1px dotted var(--bdr2)' }}>{s.name}</b></button></td>
                <td style={td}><RoleChip role={s.role} roles={roles} /></td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}><span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{rateLbl}</span>{hasOverride && <span style={{ marginLeft: 6 }}><Badge tone="blue">override</Badge></span>}</td>
                <td style={{ ...td, color: 'var(--t2)' }}>{s.contractType || '—'}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  {isHourly(s, role)
                    ? <><span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{Number(holidayHours[s.id] || 0).toFixed(1)}h</span><span style={{ fontSize: 11, color: 'var(--t4)', marginLeft: 5 }}>accrued</span></>
                    : <><span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{s.holidayEntitlementDays ?? FIXED_HOLIDAY_DAYS}d</span><span style={{ fontSize: 11, color: 'var(--t4)', marginLeft: 5 }}>fixed</span></>}
                </td>
                <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--t2)' }}>{s.mobile || '—'}</td>
                <td style={td}>{s.posUserId ? <Badge tone="green">POS user ✓</Badge> : <button className="btn btn-ghost btn-xs" onClick={() => onSetPos(s)}>Set as POS user</button>}</td>
                <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap' }}><button className="btn btn-ghost btn-xs" onClick={() => onEdit(s)}>Edit</button> <button className="btn btn-ghost btn-xs" onClick={() => onRemove(s.id)} title="Remove"><Icon name="close" size={13} /></button></td>
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

function AddStaffModal({ locName, staff, roles = ROLES, sections = [], onClose, onSave }) {
  const isEdit = !!staff;
  const roleOpts = Object.entries(roles);
  const ec = (isEdit && staff.emergencyContact) || {};
  const [f, setF] = useState(isEdit
    ? { name: staff.name || '', role: staff.role || roleOpts[0]?.[0] || 'server', contractType: staff.contractType || 'partTime', mobile: staff.mobile || '', email: staff.email || '', dob: staff.dob || '', startDate: staff.startDate || '', rateOverride: staff.rateOverride != null ? String(staff.rateOverride) : '', address: staff.address || '', niNumber: staff.niNumber || '', ecName: ec.name || '', ecPhone: ec.phone || '', ecRelation: ec.relationship || '' }
    : { name: '', role: roleOpts[0]?.[0] || 'server', contractType: 'partTime', mobile: '', email: '', dob: '', startDate: '', rateOverride: '', address: '', niNumber: '', ecName: '', ecPhone: '', ecRelation: '' });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  // v5.5.993 — which sections this person works in. Never settable before,
  // so the column was empty everywhere and anything keyed on it was dead.
  const [secIds, setSecIds] = useState((isEdit && Array.isArray(staff.sectionIds)) ? staff.sectionIds : []);
  const toggleSec = (id) => setSecIds(cur => cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]);
  const valid = f.name.trim().length > 1;
  const roleRate = roles[f.role]?.rate;
  const submit = () => {
    const { ecName, ecPhone, ecRelation, ...rest } = f;
    const emergencyContact = (ecName || ecPhone || ecRelation) ? { name: ecName || null, phone: ecPhone || null, relationship: ecRelation || null } : null;
    const payload = { ...rest, rateOverride: f.rateOverride === '' ? null : Number(f.rateOverride), emergencyContact, sectionIds: secIds };
    if (isEdit) payload.id = staff.id;
    onSave(payload);
  };
  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 480 }}>
        <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 4 }}>{isEdit ? 'Edit staff member' : 'Add staff member'}</div>
        <div style={{ fontSize: 13, color: 'var(--t3)', marginBottom: 16 }}>{isEdit ? `Editing ${staff.name}'s HR record at ${locName}.` : `HR record for ${locName}. Set them as a POS user afterwards to grant till access.`}</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <div style={{ gridColumn: '1 / -1' }}><label style={labelStyle}>Full name</label><input style={inputStyle} value={f.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Jordan Lee" autoFocus /></div>
          <div><label style={labelStyle}>Position</label><select style={inputStyle} value={f.role} onChange={e => set('role', e.target.value)}>{roleOpts.map(([k, r]) => <option key={k} value={k}>{r.lbl}</option>)}</select></div>
          <div><label style={labelStyle}>Pay rate override (£/h)</label><input style={inputStyle} value={f.rateOverride} onChange={e => set('rateOverride', e.target.value.replace(/[^0-9.]/g, ''))} placeholder={roleRate != null ? `Position default £${Number(roleRate).toFixed(2)}` : 'Position default'} inputMode="decimal" /></div>
          <div><label style={labelStyle}>Contract</label><select style={inputStyle} value={f.contractType} onChange={e => set('contractType', e.target.value)}><option value="zeroHours">Zero hours</option><option value="partTime">Part time</option><option value="fullTime">Full time</option><option value="salaried">Salaried</option></select></div>
          {sections.length > 0 && (
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={labelStyle}>Sections they work in</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {sections.map(sec => {
                  const on = secIds.includes(sec.id);
                  return (
                    <button
                      key={sec.id} type="button" onClick={() => toggleSec(sec.id)}
                      className={on ? 'btn btn-acc btn-sm' : 'btn btn-ghost btn-sm'}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 999 }}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: sec.color || 'var(--t3)', flexShrink: 0 }} />
                      {sec.name}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 6, lineHeight: 1.5 }}>
                Used to place their shifts on the rota’s <b>By section</b> view when a shift has no section of its own, and to target them with a section announcement. A shift’s own section always wins.
              </div>
            </div>
          )}
          <div><label style={labelStyle}>Mobile (SMS)</label><input style={inputStyle} value={f.mobile} onChange={e => set('mobile', e.target.value)} placeholder="+44 7700 900000" /></div>
          <div><label style={labelStyle}>Email</label><input style={inputStyle} value={f.email} onChange={e => set('email', e.target.value)} placeholder="name@email.com" /></div>
          <div><label style={labelStyle}>Date of birth</label><input style={inputStyle} type="date" value={f.dob} onChange={e => set('dob', e.target.value)} /></div>
          <div><label style={labelStyle}>Start date</label><input style={inputStyle} type="date" value={f.startDate} onChange={e => set('startDate', e.target.value)} /></div>
          <div style={{ gridColumn: '1 / -1' }}><label style={labelStyle}>Home address</label><input style={inputStyle} value={f.address} onChange={e => set('address', e.target.value)} placeholder="House, street, town, postcode" /></div>
          <div style={{ gridColumn: '1 / -1' }}><label style={labelStyle}>National Insurance number</label><input style={{ ...inputStyle, fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }} value={f.niNumber} onChange={e => set('niNumber', e.target.value.toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 13))} placeholder="QQ 12 34 56 C" />
            <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 4 }}>Needed by your payroll company — included in the payroll export.</div></div>
          <div style={{ gridColumn: '1 / -1', marginTop: 4 }}><div className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--acc)' }}>Emergency contact</div></div>
          <div><label style={labelStyle}>Contact name</label><input style={inputStyle} value={f.ecName} onChange={e => set('ecName', e.target.value)} placeholder="e.g. Sam Lee" /></div>
          <div><label style={labelStyle}>Contact phone</label><input style={inputStyle} value={f.ecPhone} onChange={e => set('ecPhone', e.target.value)} placeholder="+44 7700 900000" /></div>
          <div style={{ gridColumn: '1 / -1' }}><label style={labelStyle}>Relationship</label><input style={inputStyle} value={f.ecRelation} onChange={e => set('ecRelation', e.target.value)} placeholder="e.g. Partner, Parent" /></div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 20 }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-acc" disabled={!valid} onClick={submit}>{isEdit ? 'Save changes' : 'Add staff member'}</button>
        </div>
      </div>
    </div>
  );
}

const CONTRACT_LABEL = { zeroHours: 'Zero hours', partTime: 'Part time', fullTime: 'Full time', salaried: 'Salaried' };
const DOC_LABEL = { RTW: 'Right to Work', foodHygieneL2: 'Food Hygiene L2', allergenTraining: 'Allergen', SIA: 'SIA Licence', firstAid: 'First Aid', other: 'Other' };
function docStat(doc) {
  // Review state wins (mirrors WfCompliance.docStatus): an upload only counts
  // once a manager has approved it.
  if (doc && typeof doc === 'object') {
    if (doc.status === 'pending') return ['Pending review', 'amber'];
    if (doc.status === 'rejected') return ['Rejected', 'red'];
  }
  const expiry = doc && typeof doc === 'object' ? doc.expiry : doc;
  const hasFile = doc && typeof doc === 'object' ? !!doc.fileUrl : false;
  if (!expiry) return hasFile ? ['Valid', 'green'] : ['Missing', 'grey'];
  const days = Math.round((new Date(expiry + 'T00:00:00') - new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00')) / 86400000);
  if (days < 0) return ['Expired', 'red'];
  if (days <= 30) return ['Expiring', 'amber'];
  return ['Valid', 'green'];
}
function DetailDocView({ path }) {
  const [busy, setBusy] = useState(false);
  if (!path) return <span style={{ color: 'var(--t4)' }}>—</span>;
  return <button className="btn btn-ghost btn-xs" disabled={busy} onClick={async () => { setBusy(true); try { const u = await signedDocUrl(path, 120); if (u) window.open(u, '_blank', 'noopener'); } finally { setBusy(false); } }}>{busy ? '…' : 'View'}</button>;
}

// Staff profile — HR record + payroll bank + contract + documents + timesheets.
function StaffDetailModal({ staff: s, roles = ROLES, ctx, showToast, onClose, onEdit, onSetPos, onPatch }) {
  const role = roles[s.role];
  const [data, setData] = useState({ docs: [], timesheets: [], onb: null, holidayHrs: 0, loading: true });
  useEffect(() => {
    let live = true;
    (async () => {
      const [docs, ts, onbs, accrual] = await Promise.all([
        loadDocuments(ctx.locationId).catch(() => []),
        loadTimesheets(ctx.locationId, (() => { const d = new Date(); d.setDate(d.getDate() - 104 * 7); return d.toISOString().slice(0, 10); })(), new Date().toISOString().slice(0, 10)).catch(() => []),
        loadOnboarding(ctx.locationId).catch(() => []),
        loadAccrual(ctx.locationId).catch(() => []),
      ]);
      if (!live) return;
      const bal = accrualBalances(accrual || []);
      setData({
        docs: (docs || []).filter(d => d.staffId === s.id),
        timesheets: (ts || []).filter(t => t.staffId === s.id).slice(0, 6),
        onb: (onbs || []).find(o => o.staffId === s.id) || null,
        holidayHrs: bal[s.id] || 0,
        loading: false,
      });
    })();
    return () => { live = false; };
  }, [s.id, ctx.locationId]);

  const baseRate = role ? (role.rate != null ? `£${Number(role.rate).toFixed(2)}/h` : (role.salary ? `£${Math.round(role.salary / 1000)}k/yr` : '—')) : '—';
  const payRate = s.rateOverride != null && s.rateOverride !== '' ? `£${Number(s.rateOverride).toFixed(2)}/h (override)` : baseRate;
  const fields = [
    ['Position', role?.lbl || s.role || '—'], ['Pay rate', payRate],
    ['Contract', CONTRACT_LABEL[s.contractType] || s.contractType || '—'], ['Status', s.status || 'active'],
    ['Mobile', s.mobile || '—'], ['Email', s.email || '—'],
    ['Date of birth', s.dob || '—'], ['Start date', s.startDate || '—'],
    ['Address', s.address || '—'],
    ['Emergency contact', s.emergencyContact ? `${s.emergencyContact.name || '—'}${s.emergencyContact.phone ? ` · ${s.emergencyContact.phone}` : ''}${s.emergencyContact.relationship ? ` (${s.emergencyContact.relationship})` : ''}` : '—'],
    ['NI number', s.niNumber || '—'],
  ];

  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal-box" style={{ maxWidth: 600, maxHeight: '88vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <span style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--inset)', border: '1px solid var(--inset-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 800, color: 'var(--t2)' }}>{initials(s.name)}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{s.name}</div>
            <div style={{ marginTop: 2 }}><RoleChip role={s.role} roles={roles} /></div>
          </div>
          {s.posUserId ? <Badge tone="green">POS user ✓</Badge> : <button className="btn btn-ghost btn-xs" onClick={() => onSetPos?.(s)}>Set as POS user</button>}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 18px', marginBottom: 18 }}>
          {fields.map(([k, v]) => (
            <div key={k}><div style={labelStyle}>{k}</div><div style={{ fontSize: 13.5, color: 'var(--t1)', marginTop: 2 }}>{v}</div></div>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 18 }}>
          <div style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--inset)', border: '1px solid var(--inset-border)' }}>
            <div style={labelStyle}>Holiday accrued</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 800, marginTop: 4 }}>{Number(data.holidayHrs).toFixed(1)}h</div>
          </div>
          <div style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--inset)', border: '1px solid var(--inset-border)' }}>
            <div style={labelStyle}>Onboarding</div>
            <div style={{ fontSize: 13.5, marginTop: 6 }}>{data.onb ? (data.onb.status === 'complete' ? <Badge tone="green">Complete</Badge> : <Badge tone="amber">In progress</Badge>) : <span style={{ color: 'var(--t4)' }}>Not started</span>}</div>
          </div>
        </div>

        <SectionTitle>Bank details (for payroll)</SectionTitle>
        <BankPanel s={s} ctx={ctx} showToast={showToast} onPatch={onPatch} />

        <SectionTitle>Contract</SectionTitle>
        <ContractPanel s={s} role={role} onb={data.onb} loading={data.loading} ctx={ctx} showToast={showToast}
          onCase={(c) => setData(d => ({ ...d, onb: c }))} />

        <SectionTitle>Documents</SectionTitle>
        {data.loading ? <Muted>Loading…</Muted> : data.docs.length === 0 ? <Muted>No documents on file.</Muted> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
            <tbody>
              {data.docs.map(d => { const [lbl, tone] = docStat(d); return (
                <tr key={d.id}>
                  <td style={{ ...td, padding: '7px 8px' }}>{DOC_LABEL[d.type] || d.type}</td>
                  <td style={{ ...td, padding: '7px 8px' }}><Badge tone={tone}>{lbl}</Badge></td>
                  <td style={{ ...td, padding: '7px 8px', fontFamily: 'var(--font-mono)', color: 'var(--t3)', fontSize: 12 }}>{d.expiry || '—'}</td>
                  <td style={{ ...td, padding: '7px 8px', textAlign: 'right' }}><DetailDocView path={d.fileUrl} /></td>
                </tr>
              ); })}
            </tbody>
          </table>
        )}

        <SectionTitle>Recent timesheets</SectionTitle>
        {data.loading ? <Muted>Loading…</Muted> : data.timesheets.length === 0 ? <Muted>No timesheets yet — they appear once this person clocks in.</Muted> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 8 }}>
            <thead><tr><th style={th}>Date</th><th style={{ ...th, textAlign: 'right' }}>Hours</th><th style={th}>Status</th><th style={{ ...th, textAlign: 'right' }}>Pay</th></tr></thead>
            <tbody>
              {data.timesheets.map(t => (
                <tr key={t.id}>
                  <td style={{ ...td, padding: '7px 8px', fontFamily: 'var(--font-mono)', fontSize: 12 }}>{t.clockIn ? new Date(t.clockIn).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : '—'}</td>
                  <td style={{ ...td, padding: '7px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{Number(t.actualHours || 0).toFixed(2)}</td>
                  <td style={{ ...td, padding: '7px 8px' }}><Badge tone={t.status === 'approved' ? 'green' : 'grey'}>{t.status}</Badge></td>
                  <td style={{ ...td, padding: '7px 8px', textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{t.payAmount != null ? money(t.payAmount, 2) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9, marginTop: 18 }}>
          <button className="btn btn-ghost" onClick={onClose}>Close</button>
          <button className="btn btn-acc" onClick={() => onEdit?.(s)}><Icon name="edit" size={14} /> Edit details</button>
        </div>
      </div>
    </div>
  );
}
function SectionTitle({ children }) { return <div className="mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: 'var(--t3)', margin: '4px 0 8px' }}>{children}</div>; }
function Muted({ children }) { return <div style={{ fontSize: 13, color: 'var(--t3)', padding: '6px 0 14px' }}>{children}</div>; }

// Payroll bank details — full sort code + account number, editable in place.
// Older records may only hold the masked copy (full storage landed later);
// re-entering once upgrades them.
function BankPanel({ s, ctx, showToast, onPatch }) {
  const [editing, setEditing] = useState(false);
  const [sort, setSort] = useState('');
  const [acct, setAcct] = useState('');
  const [acctName, setAcctName] = useState('');   // v5.5.973 account holder name
  const [busy, setBusy] = useState(false);
  // Default the holder name to the staff member's own name — right most of the
  // time, and the manager only edits it for joint / parent accounts.
  const open = () => { setSort(s.bankSortCode || ''); setAcct(s.bankAccount || ''); setAcctName(s.bankAccountName || s.name || ''); setEditing(true); };
  const save = async () => {
    setBusy(true);
    try {
      const { masked, sort: savedSort, account, accountName } = await saveStaffBank(s.id, sort, acct, acctName);
      onPatch?.({ bankSortCode: savedSort, bankAccount: account, bankMasked: masked, bankAccountName: accountName });
      setEditing(false);
      showToast?.('Bank details saved', 'success');
    } catch (e) { showToast?.(e.message || 'Could not save', 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 12, background: 'var(--inset)', border: '1px solid var(--inset-border)', marginBottom: 16 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {s.bankAccountName && (s.bankAccount || s.bankMasked) && (
          <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--t1)', marginBottom: 2 }}>{s.bankAccountName}</div>
        )}
        {s.bankAccount ? (
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 700 }}>{s.bankSortCode || '——'}&ensp;{s.bankAccount}</div>
        ) : s.bankMasked ? (
          <>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 700 }}>{s.bankSortCode || '——'}&ensp;{s.bankMasked}</div>
            <div style={{ fontSize: 11.5, color: 'var(--amber)', marginTop: 2 }}>Only a masked copy is on file — re-enter the account number once to store it in full for payroll.</div>
          </>
        ) : (
          <div style={{ fontSize: 13, color: 'var(--t4)' }}>Not captured yet.</div>
        )}
      </div>
      <button className="btn btn-ghost btn-xs" onClick={open}>{s.bankMasked || s.bankAccount ? 'Edit' : 'Enter'}</button>
      {editing && (
        <div className="modal-back" onClick={e => e.target === e.currentTarget && setEditing(false)}>
          <div className="modal-box" style={{ maxWidth: 400 }}>
            <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 4 }}>Bank details — {s.name}</div>
            <div style={{ fontSize: 12.5, color: 'var(--t3)', marginBottom: 16 }}>For payroll. Stored in full on the staff record (org-fenced) so you can pay them via BACS.</div>
            <div style={{ marginBottom: 12 }}><label style={labelStyle}>Account name</label><input style={inputStyle} value={acctName} onChange={e => setAcctName(e.target.value)} placeholder="Name on the bank account" />
              <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 4 }}>As it appears at the bank — checked against the payee warning when paying manually. May differ from their own name (joint or parent account).</div>
            </div>
            <div style={{ marginBottom: 12 }}><label style={labelStyle}>Sort code</label><input style={inputStyle} value={sort} onChange={e => setSort(e.target.value)} placeholder="00-00-00" inputMode="numeric" /></div>
            <div style={{ marginBottom: 18 }}><label style={labelStyle}>Account number</label><input style={inputStyle} value={acct} onChange={e => setAcct(e.target.value.replace(/\D/g, '').slice(0, 10))} placeholder="12345678" inputMode="numeric" /></div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button className="btn btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
              <button className="btn btn-acc" disabled={busy || acct.replace(/\D/g, '').length < 4} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Contract management from the profile — view status, copy/email the sign
// link, and (re)generate from a template after onboarding. Contracts live on
// the person's wf_onboarding case (one case per person; created on demand) so
// the same /sign/<token> flow covers first issue and later changes.
function ContractPanel({ s, role, onb, loading, ctx, showToast, onCase }) {
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState(false);
  const meta = onb?.meta || {};
  const signUrl = meta.signToken ? `${window.location.origin}/sign/${meta.signToken}` : null;
  const hasContract = !!(meta.contractHtml || meta.contractPath);

  const saveCase = async (next) => {
    const steps = next.steps || [];
    next.status = steps.length && steps.every(x => x.status === 'complete') ? 'complete' : 'inProgress';
    const saved = await saveOnboarding(next, ctx.locationId, ctx.orgId);
    onCase?.(saved);
    return saved;
  };

  // (Re)generate: new contract text, signature cleared — it needs signing again.
  const generate = async (merged) => {
    const base = onb || { staffId: s.id, roleKey: s.role, steps: freshSteps(), status: 'inProgress', meta: {} };
    const token = base.meta?.signToken || genToken();
    const next = {
      ...base,
      meta: { ...(base.meta || {}), contractHtml: toHtml(merged), contractPath: null, signToken: token, signature: null, contractSentAt: null },
      steps: (base.steps || freshSteps()).map(x => x.key === 'contract' ? { ...x, status: 'sent', completedAt: null } : x),
    };
    await saveCase(next);
    showToast?.(meta.signature ? 'New contract generated — the previous signature no longer applies; send it for re-signing' : 'Contract generated — sign now, or email the link', 'success');
    setPick(false);
  };

  const emailLink = async () => {
    if (!s.email) { showToast?.('Add an email for this person first (Edit details)', 'error'); return; }
    setBusy(true);
    try {
      await sendEmail(s.email, `Sign your contract — ${ctx.locName}`, signEmailHtml(s.name, ctx.locName, signUrl), ctx.locationId);
      await saveCase({ ...onb, meta: { ...meta, contractSentAt: new Date().toISOString() } });
      showToast?.(`Sign link emailed to ${s.email}`, 'success');
    } catch (e) { showToast?.('Email failed: ' + (e.message || 'error'), 'error'); }
    finally { setBusy(false); }
  };

  const copyLink = async () => { try { await navigator.clipboard.writeText(signUrl); showToast?.('Sign link copied', 'success'); } catch { showToast?.(signUrl || '', 'info'); } };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', borderRadius: 12, background: 'var(--inset)', border: '1px solid var(--inset-border)', marginBottom: 16, flexWrap: 'wrap' }}>
      <div style={{ flex: 1, minWidth: 160 }}>
        {loading ? <span style={{ fontSize: 13, color: 'var(--t3)' }}>Loading…</span>
          : meta.signature ? (<>
            <Badge tone="green">Signed</Badge>
            <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 4 }}>By {meta.signature.name} · {new Date(meta.signature.signedAt).toLocaleDateString('en-GB')}</div>
          </>)
            : hasContract ? (<>
              <Badge tone="amber">Awaiting signature</Badge>
              {meta.contractSentAt && <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 4 }}>Link emailed {new Date(meta.contractSentAt).toLocaleDateString('en-GB')}</div>}
            </>)
              : <span style={{ fontSize: 13, color: 'var(--t4)' }}>No contract issued yet.</span>}
      </div>
      {!loading && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {hasContract && signUrl && (<>
            <button className="btn btn-ghost btn-xs" onClick={() => window.open(signUrl, '_blank', 'noopener')}>{meta.signature ? 'View' : 'Sign now'}</button>
            {!meta.signature && <button className="btn btn-ghost btn-xs" disabled={busy} onClick={emailLink}>{meta.contractSentAt ? 'Re-email' : 'Email link'}</button>}
            <button className="btn btn-ghost btn-xs" onClick={copyLink}>Copy link</button>
          </>)}
          <button className="btn btn-acc btn-xs" disabled={busy} onClick={() => setPick(true)}>{hasContract ? 'Regenerate' : 'Generate contract'}</button>
        </div>
      )}
      {pick && <PickTemplateModal kind="contract" member={s} role={role} ctx={ctx} title={hasContract ? `New contract for ${s.name}` : 'Generate contract'} cta={hasContract ? 'Replace contract' : 'Generate'} onClose={() => setPick(false)}
        onConfirm={async (m) => { try { await generate(m); } catch (e) { showToast?.('Could not generate: ' + (e.message || 'error'), 'error'); } }} />}
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

// Rota, Pay, Timesheets, Tronc, Leave, Onboarding, Compliance, Announcements and
// Settings now live as their own components under ./workforce/ (imported above),
// each wired to the wf_* tables + server-side compute.
