// src/backoffice/sections/Workforce.jsx
//
// Workforce (staff management) — a Back Office section group, rendered inside the
// BO content area with the BO/ServOS UI. Real build (no demo data):
//   • Staff are added here (persisted) and can be promoted to a POS system user
//     ("Set as POS user") which creates them in Team (staff_members / Supabase).
//   • Rota / timesheets / tronc / compliance build from real staff + show empty
//     states until populated. POS-sourced numbers (sales, clock-ins, tips) wire
//     to the POS in the hardening pass.

import { useState, useEffect, useMemo, Fragment } from 'react';
import { useStore } from '../../store';
import { supabase } from '../../lib/supabase';
import { Icon } from '../../components/ServOSIcons';
// 5.12.57: no seed numbers on any screen (the dashboard read the seed forecast and rates, so it
// always said 0 and All clear); positions are the site's own.
import { isHourly, FIXED_HOLIDAY_DAYS } from '../../staff/labour';
import { loadStaff, saveStaff, offboardStaff, markPosUser, loadRoles, loadSections, loadSettings, loadDocuments, loadTimesheets, loadOnboarding, loadAccrual, accrualBalances, signedDocUrl, saveStaffBank, saveOnboarding, sendEmail, sendPortalInvite, loadCompanySites, loadCompanyStaffRecords, loadSiteRoles, addStaffSite, linkStaffRecords, unlinkStaffRecord, setPrimaryLocation } from '../../staff/wfData';
import { buildWeek } from '../../staff/wfWeek';
import { otherSites, linkCandidates, sitesToAdd, linkErrorWords } from '../../staff/peopleAcrossSites';
import WfRota from './workforce/WfRota';
import { PickTemplateModal, freshSteps, genToken, toHtml, signEmailHtml, normalizeCase } from './workforce/WfOnboarding';
import WfTimesheets from './workforce/WfTimesheets';
import WfPayroll from './workforce/WfPayroll';
import WfTronc from './workforce/WfTronc';
import WfPay from './workforce/WfPay';
import WfLeave from './workforce/WfLeave';
import WfOnboarding from './workforce/WfOnboarding';
import WfCompliance, { DOC_LABEL, DOC_GROUP, GROUP_ORDER, GROUP_LABEL } from './workforce/WfCompliance';
import WfTraining from './workforce/WfTraining';
import WfAnnouncements from './workforce/WfAnnouncements';
import WfSettings from './workforce/WfSettings';
// 5.11.102: Team chat (groups, reports to check, settings, word lists, log, export, open a DM).
import WfChat from './workforce/WfChat';
import { activeRegionPack, venueMoney } from '../../lib/regionPack';
import { rotaStaffOf, headOfficeSwitchOn } from '../../lib/headOffice';
import { adoptVenueRegion } from '../../lib/locationTime';
import { getActiveCurrencyCode } from '../../lib/currency';
import { loadPrivateDetails, HIDDEN_WORDS } from '../../staff/privateDetails';
// 5.12.57: the words that follow the venue's law (Holiday or PTO, Tronc or Tip pool, the leaver balance).
import { holidayWord, tipPoolName, ukHoliday, leaverBalanceWords } from '../../staff/payLaw';

// v5.11.101: the venue's money and region (the region pack follows the venue's currency). A UK venue
// reads byte for byte as before.
const money = (n, dp = 0) => venueMoney(n, dp);
const rateText = (r) => `${venueMoney(r, 2)}/h`;
const salaryText = (a) => `${activeRegionPack().currencySymbol}${Math.round(a / 1000)}k/yr`;
const HUE = { mgmt: 250, bar: 200, floor: 150, kitchen: 38, door: 285 };
const groupColor = grp => `oklch(var(--cat-l) var(--cat-c) ${HUE[grp] ?? 250})`;
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
  'wf-training': ['Training', 'Modules, assignment & completion'],
  'wf-pay': ['Positions & rates', 'Add, edit & remove positions and their pay'],
  'wf-tronc': ['Tronc / tips', 'Pooled tip distribution'],
  'wf-announce': ['Announcements', 'Team messaging'],
  'wf-chat': ['Team chat', 'Groups, reports to check and chat settings'],
  'wf-settings': ['Workforce settings', 'Venues, roles & sections'],
};

export default function Workforce({ section, orgCtx }) {
  const { addStaffMember, removeStaffMember, showToast } = useStore();
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
  // 5.12.58: the site's own region (money, phone format, NI number or SSN) is set before any Workforce
  // screen draws. It used to follow whichever venue the browser read last, so a US site opened after a
  // UK one showed pounds, +44 phones and a National Insurance box (Peter, Mozz Woodbine, 3 Nov 2026).
  const [regionFor, setRegionFor] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!locationId) return undefined;
    adoptVenueRegion(locationId).catch(() => null).then(() => { if (alive) setRegionFor(locationId); });
    return () => { alive = false; };
  }, [locationId]);
  const [settings, setSettings] = useState({ currency: getActiveCurrencyCode(), labourTargetPct: 0.28, accrualRate: 0.1207, premiums: {}, salesSource: 'pos' });

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

  // 5.12.57 (US basics batch 2, Peter 3 Nov 2026): ID numbers and bank details come only through the
  // database door, for owners, admins and logins with Can see payroll details (Team). Everyone else sees
  // Hidden, and a save never sends a hidden value back (so it cannot be wiped).
  const [priv, setPriv] = useState({ byId: {}, hidden: false, loaded: false });
  const [privTick, setPrivTick] = useState(0);
  const staffIdsKey = staff.map(s => s.id).filter(id => id && !String(id).startsWith('tmp-')).join(',');
  useEffect(() => {
    let alive = true;
    const ids = staffIdsKey ? staffIdsKey.split(',') : [];
    if (!ids.length) { setPriv({ byId: {}, hidden: false, loaded: true }); return undefined; }
    loadPrivateDetails(ids).then(r => { if (alive) setPriv({ ...r, loaded: true }); });
    return () => { alive = false; };
  }, [staffIdsKey, privTick]);
  const privateOk = priv.loaded && !priv.hidden;
  const staffView = useMemo(() => staff.map(s => (priv.byId[s.id] ? { ...s, ...priv.byId[s.id] } : s)), [staff, priv]);

  const week = useMemo(() => buildWeek(), []);
  const ctx = useMemo(() => ({ locationId, orgId: orgCtx?.orgId || null, locName: orgCtx?.locationName || 'our team', actor: { id: orgCtx?.userId || null, name: orgCtx?.userName || null } }), [locationId, orgCtx]);
  // onSettingsSaved / onRolesChanged: child sections push saved state back up
  // so the rest of Workforce (staff role dropdown, rota, pay maths) sees the
  // change without a reload — deleted positions must leave dropdowns at once.
  const sectionProps = {
    ctx, staff: staffView, privateHidden: !privateOk, roles, sections, settings, week, showToast,
    onSettingsSaved: setSettings,
    onRolesChanged: (list) => { const map = {}; (list || []).forEach(r => { map[r.key] = r; }); setRoles({ list: list || [], map }); },
  };
  // 5.12.58: the site's own positions only. An empty site used to fall back to the built in samples
  // (Bartender, Barback, ... at 12.50), so deleted positions came back in Add staff member.
  const rolesMap = roles.map || {};
  const [title0, sub] = SUBS[section] || ['Workforce', ''];
  // 5.12.57: at a US venue the tip pool is called the Tip pool (UK: Tronc / tips, as before).
  const title = section === 'wf-tronc' ? tipPoolName(activeRegionPack()) : title0;

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
        setPrivTick(t => t + 1);
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
    // Settle up BEFORE the leaver disappears from every list. The accrual
    // ledger keeps the answer: positive balance = untaken holiday the final
    // payslip owes THEM; negative = holiday taken beyond what they accrued,
    // owed BACK. Silently archiving someone hid both.
    try {
      // loadAccrual is already in this file's static imports (line ~17). A
      // click-time dynamic import is the exact pattern CLAUDE.md bans — it can
      // silently fail in the production bundle, which here would mean the
      // leaver owes-back warning simply never appears.
      const rows = await loadAccrual(locationId);
      const bal = (rows || []).filter(r => r.staffId === id)
        .reduce((a, r) => a + Number(r.accruedHours ?? r.accrued_hours ?? 0), 0);
      const person = staff.find(x => x.id === id);
      // v5.6.10 — the dialog states EVERYTHING that is about to happen, and the
      // access revocation is part of the same server action as the archive:
      // before this, a leaver's till PIN and Back Office login kept working
      // until someone remembered two separate manual toggles.
      const accessNote = '\n\nArchiving also signs them out for good: their till PIN stops working, their Back Office access to this venue is removed, and their staff app locks.';
      if (Math.abs(bal) >= 0.05) {
        // 5.12.57: at a US venue the balance is PTO, and taking an overdrawn balance back from final pay
        // is unlawful in several states: say the balance and check with the payroll provider. UK as before.
        const usMsg = leaverBalanceWords({ name: person?.name || 'This person', bal, pack: activeRegionPack(), accessNote });
        const msg = usMsg || (bal > 0
          ? `${person?.name || 'This person'} leaves with ${bal.toFixed(1)} hours of accrued holiday UNTAKEN.\n\nThat is owed to them — approve a final paid-holiday request (or add it to their final payroll) BEFORE archiving.${accessNote}\n\nArchive now?`
          : `${person?.name || 'This person'} leaves ${Math.abs(bal).toFixed(1)} hours OVERDRAWN on holiday.\n\nThat was paid but never accrued — recover it from their final pay if their contract allows.${accessNote}\n\nArchive now?`);
        if (!confirm(msg)) return;
      } else if (!confirm(`Archive ${person?.name || 'this person'} as a leaver?${accessNote}`)) return;
    } catch (e) { console.warn('[wf] leaver balance check:', e?.message || e); }
    const prev = staff;
    setStaff(st => st.filter(x => x.id !== id)); // optimistic; server does the real work
    try {
      const r = await offboardStaff(id);
      const bits = [];
      if (r?.posDeactivated) bits.push('till PIN deactivated');
      if (r?.boVenueRevoked) bits.push(r?.boLoginDisabled ? 'Back Office login disabled' : 'Back Office access to this venue removed');
      showToast?.(`Archived as a leaver${bits.length ? ` · ${bits.join(' · ')}` : ''}`, 'success');
    } catch (e) {
      setStaff(prev);
      showToast?.(`NOT archived — ${e.message || 'the change was rejected'}`, 'error');
    }
  };

  const setAsPosUser = async (s, { pin, role }) => {
    // v5.6.2 — this used to be a DOUBLE silent failure: the staff_members
    // upsert's error was never read (supabase-js returns errors, it does not
    // throw), markPosUser console.warn'd its own, and then the success toast
    // fired regardless. Peter watched it claim success while the database
    // stayed untouched. Both writes are now checked, the optimistic state is
    // reverted on failure, and the toast tells the truth.
    // v5.6.5 — staff_members.id and wf_staff.pos_user_id are BOTH uuid columns.
    // This used to send the screen-local `s-<timestamp>` id straight into them,
    // so the insert failed with 'invalid input syntax for type uuid' EVERY time
    // since the feature shipped — invisible until v5.6.2 stopped swallowing the
    // error. The Team page works because it lets the DB generate the uuid; here
    // we need the id up front (it links the HR record), so mint a real one.
    const id = crypto.randomUUID();
    // Same duplicate-PIN guard the Team page has — two people on one PIN makes
    // till login ambiguous, and the DB would accept it.
    const clash = (useStore.getState().staffMembers || []).find(m => m.active !== false && m.pin && m.pin === pin);
    if (clash) {
      setPosFor(null);
      showToast?.(`That PIN is already used by ${clash.name} — pick another`, 'error');
      return;
    }
    const member = { id, name: s.name, role, pin, color: '#3b82f6', initials: initials(s.name), permissions: [], active: true };
    addStaffMember(member); // immediate — shows on the Team page (store keeps OUR id now)
    try {
      if (supabase && orgCtx?.locationId) {
        const { error } = await supabase.from('staff_members').upsert({ id, location_id: orgCtx.locationId, org_id: orgCtx.orgId || null, name: s.name, role, pin, color: '#3b82f6', initials: initials(s.name), permissions: [], active: true });
        if (error) throw new Error(error.message);
      }
      await markPosUser(s.id, id); // link the HR record (wf_staff) → POS user (staff_members); throws on failure
    } catch (e) {
      removeStaffMember?.(id);
      setPosFor(null);
      showToast?.(`Could not set ${s.name} up on the POS: ${e?.message || 'save failed'}${/pin|duplicate|unique/i.test(String(e?.message)) ? ' — that PIN may already be in use' : ''}`, 'error');
      return;
    }
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

      {locationId && regionFor !== locationId && <Card style={{ textAlign: 'center', padding: 44, color: 'var(--t3)' }}>Loading {locName}…</Card>}
      {(!locationId || regionFor === locationId) && <>
      {key === 'dashboard' && <WfDashboard staff={staff} positionCount={(roles.list || []).length} />}
      {/* 5.12.56: head office staff are salaried and never clock in, so they never go on the rota (no rota cost at the site). */}
      {key === 'rota' && <WfRota {...sectionProps} staff={rotaStaffOf(staff, settings)} />}
      {key === 'staff' && (loading
        ? <Card style={{ textAlign: 'center', padding: 44, color: 'var(--t3)' }}>Loading staff…</Card>
        : <WfStaff staff={staffView} roles={rolesMap} holidayHours={holidayHours} headOffice={headOfficeSwitchOn(settings)} onAdd={() => setAddOpen(true)} onView={setViewing} onEdit={setEditing} onSetPos={setPosFor} onRemove={removeStaff} />)}
      {key === 'timesheets' && <WfTimesheets {...sectionProps} />}
      {key === 'payroll' && <WfPayroll {...sectionProps} />}
      {key === 'pay' && <WfPay {...sectionProps} />}
      {key === 'tronc' && <WfTronc {...sectionProps} />}
      {key === 'compliance' && <WfCompliance {...sectionProps} />}
      {key === 'training' && <WfTraining {...sectionProps} />}
      {key === 'timeoff' && <WfLeave {...sectionProps} />}
      {key === 'onboarding' && <WfOnboarding {...sectionProps} />}
      {key === 'announce' && <WfAnnouncements {...sectionProps} />}
      {key === 'settings' && <WfSettings {...sectionProps} />}
      {key === 'chat' && <WfChat ctx={{ venueOrgId: orgCtx?.venueOrgId || null }} showToast={showToast} />}

      {viewing && <StaffDetailModal staff={viewing} privateOk={privateOk} roles={rolesMap} ctx={ctx} showToast={showToast} onPeopleChanged={() => loadStaff(locationId).then(rows => setStaff(rows))} onClose={() => setViewing(null)} onEdit={(s) => { setViewing(null); setEditing(s); }} onSetPos={(s) => { setViewing(null); setPosFor(s); }}
        onPatch={(patch) => { setStaff(st => st.map(x => x.id === viewing.id ? { ...x, ...patch } : x)); setViewing(v => v ? { ...v, ...patch } : v); }} />}
      {(addOpen || editing) && <AddStaffModal locName={locName} staff={editing} privateOk={privateOk} roles={rolesMap} sections={sections} headOffice={headOfficeSwitchOn(settings)} onClose={() => { setAddOpen(false); setEditing(null); }} onSave={saveMember} />}
      {posFor && <PosUserModal staff={posFor} roles={rolesMap} onClose={() => setPosFor(null)} onSave={(opts) => setAsPosUser(posFor, opts)} />}
      </>}
    </div>
  );
}

// ── shared ──
function Card({ children, style }) {
  return <div style={{ background: 'var(--glass-bg)', backdropFilter: 'blur(22px) saturate(150%)', WebkitBackdropFilter: 'blur(22px) saturate(150%)', border: '1px solid var(--glass-border)', boxShadow: 'var(--glass-shadow), var(--glass-hi)', borderRadius: 16, padding: 18, ...style }}>{children}</div>;
}
function RoleChip({ role, roles = {} }) {
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
// 5.12.57: only figures that are real. The labour %, wage cost and needs action tiles were built
// from the seed forecast and the seed rates, so they always read 0 and All clear: they are gone
// and the dashboard says where labour lives instead.
function WfDashboard({ staff = [], positionCount = 0 }) {
  const active = staff.filter(s => s.status !== 'leaver').length;
  const stats = [
    { k: 'Staff', v: String(active), sub: active === 0 ? 'Add your team' : 'on the books', col: 'var(--t1)' },
    { k: 'Positions', v: String(positionCount), sub: positionCount === 0 ? 'Add them in Positions and rates' : 'with their pay', col: 'var(--acc)' },
  ];
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
        {stats.map(s => (
          <Card key={s.k} style={{ position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: s.col }} />
            <div className="mono" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--t3)' }}>{s.k}</div>
            <div className="mono" style={{ fontSize: 28, fontWeight: 800, letterSpacing: '-.02em', marginTop: 10, color: s.col }}>{s.v}</div>
            <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 6 }}>{s.sub}</div>
          </Card>
        ))}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--t3)' }}>See Rota and Reports for labour: the rota shows the planned wage cost against sales, and Reports shows what was paid.</div>
    </div>
  );
}

// ── Staff (HR list + CRUD) ──
function WfStaff({ staff, roles = {}, holidayHours = {}, headOffice = false, onAdd, onView, onEdit, onSetPos, onRemove }) {
  // 5.12.57: a US venue's column is PTO, and a salaried person has no statutory 28 days there.
  const pack = activeRegionPack();
  if (staff.length === 0) return <EmptyState icon="team" title="No staff yet" body="Add your team here. Each person is an HR record — you can then set them as a POS user to give them till access on the Team page." cta="Add staff member" onCta={onAdd} />;
  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead><tr>{['Name', 'Position', 'Pay rate', 'Contract', holidayWord(pack), 'Mobile', 'POS access', ''].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
        <tbody>
          {staff.map(s => {
            const role = roles[s.role];
            const baseRate = role ? (role.rate != null ? rateText(role.rate) : (role.salary ? salaryText(role.salary) : '—')) : '—';
            const hasOverride = s.rateOverride != null && s.rateOverride !== '';
            // 5.12.56: a head office person shows their salary and a Head office label instead of a rate.
            const ho = headOffice && s.headOffice === true;
            const rateLbl = ho ? (s.salaryAnnual ? salaryText(s.salaryAnnual) : 'No salary set') : hasOverride ? rateText(s.rateOverride) : baseRate;
            return (
              <tr key={s.id}>
                <td style={td}><button onClick={() => onView?.(s)} title="View profile" style={{ display: 'flex', alignItems: 'center', gap: 9, background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}><span style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--inset)', border: '1px solid var(--inset-border)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: 'var(--t3)', flexShrink: 0 }}>{initials(s.name)}</span><b style={{ fontWeight: 600, color: 'var(--t1)', borderBottom: '1px dotted var(--bdr2)' }}>{s.name}</b></button></td>
                <td style={td}><RoleChip role={s.role} roles={roles} /></td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}><span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{rateLbl}</span>{ho ? <span style={{ marginLeft: 6 }}><Badge tone="blue">Head office</Badge></span> : hasOverride && <span style={{ marginLeft: 6 }}><Badge tone="blue">override</Badge></span>}</td>
                <td style={{ ...td, color: 'var(--t2)' }}>{s.contractType || '—'}</td>
                <td style={{ ...td, whiteSpace: 'nowrap' }}>
                  {isHourly(s, role)
                    ? <><span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{Number(holidayHours[s.id] || 0).toFixed(1)}h</span><span style={{ fontSize: 11, color: 'var(--t4)', marginLeft: 5 }}>accrued</span></>
                    : ukHoliday(pack) || s.holidayEntitlementDays != null
                      ? <><span className="mono" style={{ fontSize: 12, fontWeight: 700 }}>{s.holidayEntitlementDays ?? FIXED_HOLIDAY_DAYS}d</span><span style={{ fontSize: 11, color: 'var(--t4)', marginLeft: 5 }}>fixed</span></>
                      : <span style={{ fontSize: 11, color: 'var(--t4)' }}>By your policy</span>}
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

function AddStaffModal({ locName, staff, privateOk = true, roles = {}, sections = [], headOffice = false, onClose, onSave }) {
  const isEdit = !!staff;
  const roleOpts = Object.entries(roles);
  const ec = (isEdit && staff.emergencyContact) || {};
  const pack = activeRegionPack();
  const usFields = pack.payrollFields.includes('ssnLast4');
  const [f, setF] = useState(isEdit
    ? { name: staff.name || '', role: staff.role && roles[staff.role] ? staff.role : '', contractType: staff.contractType || 'partTime', mobile: staff.mobile || '', email: staff.email || '', dob: staff.dob || '', startDate: staff.startDate || '', rateOverride: staff.rateOverride != null ? String(staff.rateOverride) : '', address: staff.address || '', niNumber: staff.niNumber || '', ecName: ec.name || '', ecPhone: ec.phone || '', ecRelation: ec.relationship || '', ...(usFields ? { ssnLast4: staff.ssnLast4 || '', payrollEmployeeId: staff.payrollEmployeeId || '' } : {}) }
    : { name: '', role: roleOpts[0]?.[0] || '', contractType: 'partTime', mobile: '', email: '', dob: '', startDate: '', rateOverride: '', address: '', niNumber: '', ecName: '', ecPhone: '', ecRelation: '', ...(usFields ? { ssnLast4: '', payrollEmployeeId: '' } : {}) });
  const set = (k, v) => setF(p => ({ ...p, [k]: v }));
  // 5.12.56: head office (Workforce settings, Head office staff). Only carried while the switch is on,
  // so a site that never turned it on never writes the two columns.
  const [ho, setHo] = useState({ on: !!(isEdit && staff.headOffice), salary: isEdit && staff.salaryAnnual != null ? String(staff.salaryAnnual) : '' });
  // v5.5.993 — which sections this person works in. Never settable before,
  // so the column was empty everywhere and anything keyed on it was dead.
  const [secIds, setSecIds] = useState((isEdit && Array.isArray(staff.sectionIds)) ? staff.sectionIds : []);
  const toggleSec = (id) => setSecIds(cur => cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id]);
  // 5.12.58: a real position of this site is needed (its pay rate and rota come from it).
  const valid = f.name.trim().length > 1 && !!f.role && !!roles[f.role];
  const roleRate = roles[f.role]?.rate;
  const submit = () => {
    const { ecName, ecPhone, ecRelation, ...rest } = f;
    const emergencyContact = (ecName || ecPhone || ecRelation) ? { name: ecName || null, phone: ecPhone || null, relationship: ecRelation || null } : null;
    const payload = { ...rest, rateOverride: f.rateOverride === '' ? null : Number(f.rateOverride), emergencyContact, sectionIds: secIds };
    if (headOffice) { payload.headOffice = ho.on; payload.salaryAnnual = ho.salary === '' ? null : Number(ho.salary); }
    // 5.12.57: a private value this login may not see is never sent back unless they typed a new one.
    if (isEdit && !privateOk) { if (!String(f.niNumber || '').trim()) delete payload.niNumber; if (!String(f.ssnLast4 || '').trim()) delete payload.ssnLast4; }
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
          <div><label style={labelStyle}>Position</label>
            {roleOpts.length === 0
              ? <div style={{ ...inputStyle, display: 'flex', alignItems: 'center', height: 'auto', minHeight: 42, color: 'var(--amber)', fontSize: 12 }}>No positions yet. Add one in Workforce, Positions first.</div>
              : <select style={inputStyle} value={f.role} onChange={e => set('role', e.target.value)}>
                  {!f.role && <option value="">{isEdit && staff.role ? 'Their position was removed: pick one' : 'Pick a position'}</option>}
                  {roleOpts.map(([k, r]) => <option key={k} value={k}>{r.lbl}</option>)}
                </select>}
          </div>
          <div><label style={labelStyle}>Pay rate override ({pack.currencySymbol}/h)</label><input style={inputStyle} value={f.rateOverride} onChange={e => set('rateOverride', e.target.value.replace(/[^0-9.]/g, ''))} placeholder={roleRate != null ? `Position default ${venueMoney(roleRate, 2)}` : 'Position default'} inputMode="decimal" /></div>
          <div><label style={labelStyle}>Contract</label><select style={inputStyle} value={f.contractType} onChange={e => set('contractType', e.target.value)}><option value="zeroHours">Zero hours</option><option value="partTime">Part time</option><option value="fullTime">Full time</option><option value="salaried">Salaried</option></select></div>
          {headOffice && (
            <div style={{ gridColumn: '1 / -1', padding: '12px 14px', borderRadius: 12, background: 'var(--inset)', border: '1px solid var(--inset-border)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13.5, fontWeight: 700, color: 'var(--t1)', cursor: 'pointer' }}>
                <input type="checkbox" checked={ho.on} onChange={e => setHo(p => ({ ...p, on: e.target.checked }))} />
                Head office
              </label>
              <div style={{ fontSize: 11.5, color: 'var(--t3)', marginTop: 6, lineHeight: 1.5 }}>
                Paid their annual salary each pay period. No clock in, not on the rota, and not in {locName}'s labour. Shown as Head office in the Owner app.
              </div>
              {ho.on && (
                <div style={{ marginTop: 10 }}>
                  <label style={labelStyle}>Annual salary ({pack.currencySymbol})</label>
                  <input style={inputStyle} value={ho.salary} onChange={e => setHo(p => ({ ...p, salary: e.target.value.replace(/[^0-9.]/g, '') }))} placeholder="e.g. 45000" inputMode="decimal" />
                  {!ho.salary && <div style={{ fontSize: 11, color: 'var(--amber)', marginTop: 6 }}>No salary set: nothing is paid until you add one.</div>}
                </div>
              )}
            </div>
          )}
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
          <div><label style={labelStyle}>Mobile (SMS)</label><input style={inputStyle} value={f.mobile} onChange={e => set('mobile', e.target.value)} placeholder={pack.country === 'US' ? '(801) 555-1234' : '+44 7700 900000'} /></div>
          <div><label style={labelStyle}>Email</label><input style={inputStyle} value={f.email} onChange={e => set('email', e.target.value)} placeholder="name@email.com" /></div>
          <div><label style={labelStyle}>Date of birth</label><input style={inputStyle} type="date" value={f.dob} onChange={e => set('dob', e.target.value)} /></div>
          <div><label style={labelStyle}>Start date</label><input style={inputStyle} type="date" value={f.startDate} onChange={e => set('startDate', e.target.value)} /></div>
          <div style={{ gridColumn: '1 / -1' }}><label style={labelStyle}>Home address</label><input style={inputStyle} value={f.address} onChange={e => set('address', e.target.value)} placeholder={pack.country === 'US' ? 'Street, city, state, ZIP' : 'House, street, town, postcode'} /></div>
          {usFields ? (<>
            <div><label style={labelStyle}>SSN (last 4 only)</label><input style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }} value={f.ssnLast4} onChange={e => set('ssnLast4', e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder={isEdit && !privateOk ? 'Hidden: type 4 digits to replace' : '1234'} inputMode="numeric" />
              <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 4 }}>Never the whole number.</div></div>
            <div><label style={labelStyle}>Payroll employee ID</label><input style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }} value={f.payrollEmployeeId} onChange={e => set('payrollEmployeeId', e.target.value.slice(0, 40))} placeholder="From your payroll provider" />
              <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 4 }}>Included in the US payroll export.</div></div>
          </>) : (
          <div style={{ gridColumn: '1 / -1' }}><label style={labelStyle}>National Insurance number</label><input style={{ ...inputStyle, fontFamily: 'var(--font-mono)', textTransform: 'uppercase' }} value={f.niNumber} onChange={e => set('niNumber', e.target.value.toUpperCase().replace(/[^A-Z0-9 ]/g, '').slice(0, 13))} placeholder={isEdit && !privateOk ? 'Hidden: type a new one to replace it' : 'QQ 12 34 56 C'} />
            <div style={{ fontSize: 10.5, color: 'var(--t4)', marginTop: 4 }}>Needed by your payroll company — included in the payroll export.</div></div>
          )}
          <div style={{ gridColumn: '1 / -1', marginTop: 4 }}><div className="mono" style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.1em', textTransform: 'uppercase', color: 'var(--acc)' }}>Emergency contact</div></div>
          <div><label style={labelStyle}>Contact name</label><input style={inputStyle} value={f.ecName} onChange={e => set('ecName', e.target.value)} placeholder="e.g. Sam Lee" /></div>
          <div><label style={labelStyle}>Contact phone</label><input style={inputStyle} value={f.ecPhone} onChange={e => set('ecPhone', e.target.value)} placeholder={pack.country === 'US' ? '(801) 555-1234' : '+44 7700 900000'} /></div>
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
// v5.5.995 — one source of truth. This modal had its OWN copy of the label map
// (already drifted: 'Allergen' vs 'Allergen Training') and no grouping.
// Shared constants live in WfCompliance.
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
function StaffDetailModal({ staff: s, privateOk = true, roles = {}, ctx, showToast, onClose, onEdit, onSetPos, onPatch, onPeopleChanged }) {
  const role = roles[s.role];
  const [data, setData] = useState({ docs: [], timesheets: [], onb: null, holidayHrs: 0, loading: true });
  const [inviteBusy, setInviteBusy] = useState(false);
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
        // v5.6.9 — heal before judging. The RAW row's status/steps were stamped
        // before the evidence existed (POS access granted, bank added from the
        // staff app…), so this badge said "In progress" on a finished case —
        // the same bug the Onboarding screen and rota gate had (v5.6.1), on a
        // third surface. normalizeCase derives from meta + the staff record.
        onb: (() => { const raw = (onbs || []).find(o => o.staffId === s.id); return raw ? normalizeCase(raw, s) : null; })(),
        holidayHrs: bal[s.id] || 0,
        loading: false,
      });
    })();
    return () => { live = false; };
  }, [s.id, ctx.locationId]);

  const baseRate = role ? (role.rate != null ? rateText(role.rate) : (role.salary ? salaryText(role.salary) : '—')) : '—';
  const payRate = s.rateOverride != null && s.rateOverride !== '' ? `${rateText(s.rateOverride)} (override)` : baseRate;
  const pack = activeRegionPack();
  const fields = [
    ['Position', role?.lbl || s.role || '—'], ['Pay rate', payRate],
    ['Contract', CONTRACT_LABEL[s.contractType] || s.contractType || '—'], ['Status', s.status || 'active'],
    ['Mobile', s.mobile || '—'], ['Email', s.email || '—'],
    ['Date of birth', s.dob || '—'], ['Start date', s.startDate || '—'],
    ['Address', s.address || '—'],
    ['Emergency contact', s.emergencyContact ? `${s.emergencyContact.name || '—'}${s.emergencyContact.phone ? ` · ${s.emergencyContact.phone}` : ''}${s.emergencyContact.relationship ? ` (${s.emergencyContact.relationship})` : ''}` : '—'],
    // v5.11.101: the payroll fields follow the venue (UK: NI number; US: SSN last 4 and the payroll id).
    // 5.12.57: hidden unless this login may see ID numbers (owner, admin, Can see payroll details).
    ...(pack.payrollFields.includes('niNumber') ? [['NI number', privateOk ? (s.niNumber || '—') : HIDDEN_WORDS]] : []),
    ...(pack.payrollFields.includes('ssnLast4') ? [['SSN (last 4)', privateOk ? (s.ssnLast4 ? `***-**-${s.ssnLast4}` : '—') : HIDDEN_WORDS], ['Payroll employee ID', s.payrollEmployeeId || '—']] : []),
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
            <div style={labelStyle}>{holidayWord(pack)} accrued</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 800, marginTop: 4 }}>{Number(data.holidayHrs).toFixed(1)}h</div>
          </div>
          <div style={{ padding: '12px 14px', borderRadius: 12, background: 'var(--inset)', border: '1px solid var(--inset-border)' }}>
            <div style={labelStyle}>Onboarding</div>
            <div style={{ fontSize: 13.5, marginTop: 6 }}>{data.onb ? (data.onb.status === 'complete' ? <Badge tone="green">Complete</Badge> : <Badge tone="amber">In progress</Badge>) : <span style={{ color: 'var(--t4)' }}>Not started</span>}</div>
          </div>
        </div>

        {pack.bankDetails ? <>
          <SectionTitle>Bank details (for payroll)</SectionTitle>
          <BankPanel s={s} ctx={ctx} showToast={showToast} onPatch={onPatch} />
        </> : <div style={{ fontSize: 12, color: 'var(--t3)', marginBottom: 16 }}>Bank details are held by your payroll provider for a US venue, so they are not kept here.</div>}

        <SectionTitle>Contract</SectionTitle>
        <ContractPanel s={s} role={role} onb={data.onb} loading={data.loading} ctx={ctx} showToast={showToast}
          onCase={(c) => setData(d => ({ ...d, onb: c }))} />

        <SectionTitle>Staff app</SectionTitle>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, color: 'var(--t3)' }}>
            {s.email ? 'Email them a link to create (or reset) their staff app login.' : 'Add an email address to invite them to the staff app.'}
          </span>
          <button className="btn btn-ghost btn-sm" disabled={!s.email || inviteBusy}
            onClick={async () => {
              setInviteBusy(true);
              try { await sendPortalInvite(s.id); showToast(`Staff app invite emailed to ${s.email}`, 'success'); }
              catch (e) { showToast(e.message || 'Could not send the invite', 'error'); }
              finally { setInviteBusy(false); }
            }}>
            <Icon name="status" size={13} /> {inviteBusy ? 'Sending…' : 'Send app invite'}
          </button>
        </div>

        <SectionTitle>Sites</SectionTitle>
        <SitesPanel s={s} ctx={ctx} roles={roles} showToast={showToast} onChanged={onPeopleChanged} />

        <SectionTitle>Documents</SectionTitle>
        {data.loading ? <Muted>Loading…</Muted> : data.docs.length === 0 ? <Muted>No documents on file.</Muted> : (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
            <tbody>
              {[...data.docs]
                .sort((a, b) => GROUP_ORDER.indexOf(DOC_GROUP[a.type] || 'other') - GROUP_ORDER.indexOf(DOC_GROUP[b.type] || 'other') || String(a.type).localeCompare(String(b.type)))
                .map((d, i, arr) => { const [lbl, tone] = docStat(d);
                const grp = DOC_GROUP[d.type] || 'other';
                const prevGrp = i > 0 ? (DOC_GROUP[arr[i - 1].type] || 'other') : null;
                return (
                <Fragment key={d.id}>
                {grp !== prevGrp && (
                  <tr><td colSpan={4} style={{ padding: '8px 8px 3px', fontSize: 10, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase', color: 'var(--t4)' }}>{GROUP_LABEL[grp]}</td></tr>
                )}
                <tr>
                  <td style={{ ...td, padding: '7px 8px' }}>{DOC_LABEL[d.type] || d.type}</td>
                  <td style={{ ...td, padding: '7px 8px' }}><Badge tone={tone}>{lbl}</Badge></td>
                  <td style={{ ...td, padding: '7px 8px', fontFamily: 'var(--font-mono)', color: 'var(--t3)', fontSize: 12 }}>{d.expiry || '—'}</td>
                  <td style={{ ...td, padding: '7px 8px', textAlign: 'right' }}><DetailDocView path={d.fileUrl} /></td>
                </tr>
                </Fragment>
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
// 5.12.36 (Peter, 2 Nov 2026: "one member of staff might work at 2 sites or 3 sites" and "a pos user
// shared between sites with the same pin, changed at one location changed at both"). One staff record
// per site stays (the site's position, rate, rota and timesheets); the records of one person are
// linked. Linked: their week counts across every site for US overtime, their PIN, card and own details
// are shared. Every change goes through a database door that checks access to every site.
function SitesPanel({ s, ctx, roles = {}, showToast, onChanged }) {
  const [state, setState] = useState({ loading: true, sites: [], records: [] });
  const [tick, setTick] = useState(0);
  // 5.12.39 (Peter: "people might work across all sites"): tick any number of sites, each with its
  // own position and pay rate there.
  const [picked, setPicked] = useState({});        // { locationId: { role, rate } }
  const [siteRoles, setSiteRoles] = useState({});  // { locationId: [role] }
  const [busy, setBusy] = useState('');
  const [confirmLink, setConfirmLink] = useState(null);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  useEffect(() => {
    let live = true;
    (async () => {
      const [sites, records] = await Promise.all([loadCompanySites(ctx.orgId), loadCompanyStaffRecords(ctx.orgId)]);
      if (live) setState({ loading: false, sites, records });
    })();
    return () => { live = false; };
  }, [ctx.orgId, s.id, tick]);
  // Each ticked site's own positions (read only; never seeds defaults at another site).
  const pickedKey = Object.keys(picked).sort().join(',');
  useEffect(() => {
    let live = true;
    const need = Object.keys(picked).filter(id => !siteRoles[id]);
    if (!need.length) return undefined;
    Promise.all(need.map(id => loadSiteRoles(id).then(list => [id, list]))).then(rows => {
      if (!live) return;
      setSiteRoles(prev => ({ ...prev, ...Object.fromEntries(rows) }));
      setPicked(prev => {
        const next = { ...prev };
        for (const [id, list] of rows) if (next[id] && !next[id].role) next[id] = { ...next[id], role: list.some(r => r.key === s.role) ? s.role : (list[0]?.key || s.role || '') };
        return next;
      });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickedKey, s.role]);

  const names = useMemo(() => Object.fromEntries(state.sites.map(x => [x.id, x.name])), [state.sites]);
  const me = useMemo(() => {
    const row = state.records.find(r => r.id === s.id);
    return { id: s.id, name: s.name, email: s.email, mobile: s.mobile, personId: row?.person_id ?? s.personId ?? null, locationId: ctx.locationId };
  }, [state.records, s, ctx.locationId]);
  const linked = otherSites(me, state.records, names);
  const candidates = linkCandidates(me, state.records, names);
  const canAdd = sitesToAdd(me, state.records, state.sites);
  const roleName = (key, loc) => roles[key]?.lbl || (siteRoles[loc] || []).find(r => r.key === key)?.lbl || key || 'No position';
  const togglePick = (id) => setPicked(p => { const n = { ...p }; if (n[id]) delete n[id]; else n[id] = { role: '', rate: '' }; return n; });
  const pickedIds = Object.keys(picked);

  const run = async (label, fn, done) => {
    setBusy(label);
    try { await fn(); if (done) showToast?.(done, 'success'); setTick(t => t + 1); setPicked({}); onChanged?.(); }
    catch (e) { showToast?.(linkErrorWords(e), 'error'); }
    finally { setBusy(''); setConfirmLink(null); setConfirmUnlink(false); }
  };

  if (state.loading) return <Muted>Loading…</Muted>;
  if (state.sites.length < 2) return <Muted>This company has one site.</Muted>;
  const box = { padding: '10px 12px', borderRadius: 10, background: 'var(--inset)', border: '1px solid var(--inset-border)', marginBottom: 8 };
  return (
    <div style={{ marginBottom: 16 }}>
      {linked.length > 0 ? (
        <div style={box}>
          <div style={{ fontSize: 12.5, color: 'var(--t2)', marginBottom: 6 }}>
            {/* 5.12.57: the 40 hour overtime week is a US rule: a UK site does not mention it. */}
            <b>Also works at</b>. {activeRegionPack().country === 'US' ? 'Their hours at every site count toward one 40 hour week for overtime. ' : ''}Their PIN, card and own details are the same everywhere.
          </div>
          {linked.map(l => (
            <div key={l.staffId} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, padding: '3px 0' }}>
              <b>{l.site}</b><span style={{ color: 'var(--t3)' }}>{roleName(l.role, l.locationId)}{l.rate != null ? ` · ${rateText(l.rate)}` : ''}</span>
              {l.leaver && <Badge tone="grey">Leaver</Badge>}
            </div>
          ))}
          {/* 5.12.55: holiday and PTO are earned at every site and taken at the primary location. */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12.5, marginTop: 8 }}>
            <span style={{ color: 'var(--t2)' }}><b>Primary location</b> for holiday and PTO:</span>
            <select className="input" style={{ padding: '4px 8px', fontSize: 12.5 }} disabled={!!busy}
              value={s.primaryVenueId || ctx.locationId}
              onChange={e => run('primary', () => setPrimaryLocation(s.id, e.target.value), 'Primary location saved')}>
              {[{ locationId: ctx.locationId, site: ctx.locName }, ...linked.filter(l => !l.leaver)].map(o => <option key={o.locationId} value={o.locationId}>{o.site}</option>)}
            </select>
            <span style={{ color: 'var(--t4)', fontSize: 11.5 }}>Earned at every site into one balance; time off is taken and paid here.</span>
          </div>
          <div style={{ marginTop: 8 }}>
            {!confirmUnlink
              ? <button className="btn btn-ghost btn-xs" disabled={!!busy} onClick={() => setConfirmUnlink(true)}>Unlink from other sites</button>
              : <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                  <span style={{ color: 'var(--t3)' }}>Their hours here will count on their own and their PIN stops sharing.</span>
                  <button className="btn btn-ghost btn-xs" onClick={() => setConfirmUnlink(false)}>Keep</button>
                  <button className="btn btn-acc btn-xs" disabled={!!busy} onClick={() => run('unlink', () => unlinkStaffRecord(s.id), `${s.name} is now at ${ctx.locName} only`)}>{busy === 'unlink' ? 'Unlinking…' : 'Unlink'}</button>
                </span>}
          </div>
        </div>
      ) : <div style={{ fontSize: 12.5, color: 'var(--t3)', marginBottom: 8 }}>Works at {ctx.locName} only.</div>}

      {candidates.map(c => (
        <div key={c.staffId} style={{ ...box, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13 }}>Looks like the same person at <b>{c.site}</b>: {c.name} ({c.why})</span>
          <span style={{ flex: 1 }} />
          {confirmLink !== c.staffId
            ? <button className="btn btn-ghost btn-xs" disabled={!!busy} onClick={() => setConfirmLink(c.staffId)}>Link</button>
            : <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                <span style={{ color: 'var(--t3)' }}>Their details and till PIN at {c.site} become this record's.</span>
                <button className="btn btn-ghost btn-xs" onClick={() => setConfirmLink(null)}>Cancel</button>
                <button className="btn btn-acc btn-xs" disabled={!!busy} onClick={() => run('link', () => linkStaffRecords(s.id, c.staffId), `${s.name} linked with ${c.site}`)}>{busy === 'link' ? 'Linking…' : 'Link them'}</button>
              </span>}
        </div>
      ))}

      {canAdd.length > 0 && (
        <div style={box}>
          <div style={{ fontSize: 12.5, color: 'var(--t2)', marginBottom: 8 }}><b>Also works at</b>: tick every site that applies, with their position and pay rate there.</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: pickedIds.length ? 10 : 0 }}>
            {canAdd.map(x => {
              const on = !!picked[x.id];
              return (
                <button key={x.id} className="btn btn-ghost btn-xs" onClick={() => togglePick(x.id)}
                  style={{ border: `1.5px solid ${on ? 'var(--acc)' : 'var(--bdr2)'}`, color: on ? 'var(--acc)' : 'var(--t2)' }}>{on ? '✓ ' : ''}{x.name}</button>
              );
            })}
            {canAdd.length > 1 && (
              <button className="btn btn-ghost btn-xs" onClick={() => setPicked(pickedIds.length === canAdd.length ? {} : Object.fromEntries(canAdd.map(x => [x.id, picked[x.id] || { role: '', rate: '' }])))}>
                {pickedIds.length === canAdd.length ? 'Clear' : 'Select all'}
              </button>
            )}
          </div>
          {pickedIds.length > 0 && (
            <>
              {canAdd.filter(x => picked[x.id]).map(x => (
                <div key={x.id} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
                  <b style={{ fontSize: 13, minWidth: 110 }}>{x.name}</b>
                  <select value={picked[x.id].role} onChange={e => setPicked(p => ({ ...p, [x.id]: { ...p[x.id], role: e.target.value } }))}
                    style={{ ...inputStyle, width: 'auto', minWidth: 130, height: 36, padding: '6px 10px' }} aria-label={`Position at ${x.name}`}>
                    {(siteRoles[x.id] || []).length === 0 && <option value={s.role || ''}>{roleName(s.role)}</option>}
                    {(siteRoles[x.id] || []).map(r => <option key={r.key} value={r.key}>{r.lbl}</option>)}
                  </select>
                  <input inputMode="decimal" placeholder="Position rate" value={picked[x.id].rate}
                    onChange={e => { const v = e.target.value.replace(/[^\d.]/g, ''); setPicked(p => ({ ...p, [x.id]: { ...p[x.id], rate: v } })); }}
                    style={{ ...inputStyle, width: 120, height: 36, padding: '6px 10px' }} aria-label={`Pay rate at ${x.name}`} />
                </div>
              ))}
              <button className="btn btn-acc btn-sm" disabled={!!busy} style={{ marginTop: 4 }}
                onClick={() => run('add', async () => {
                  // One site at a time: each press of the database door checks access to every site so far.
                  const done = [];
                  for (const id of pickedIds) {
                    try { await addStaffSite(s.id, id, picked[id].role || s.role || null, picked[id].rate); done.push(names[id] || 'a site'); }
                    catch (e) { if (done.length) showToast?.(`Added at ${done.join(', ')}.`, 'success'); throw e; }
                  }
                  showToast?.(`${s.name} now also works at ${done.join(', ')}${s.posUserId ? ', with the same PIN' : ''}`, 'success');
                }, null)}>
                {busy === 'add' ? 'Adding…' : pickedIds.length > 1 ? `Add ${pickedIds.length} sites` : 'Add site'}
              </button>
            </>
          )}
        </div>
      )}
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

function PosUserModal({ staff, roles = {}, onClose, onSave }) {
  const [pin, setPin] = useState('');
  // 5.12.57: a US kitchen calls the role Dishwasher (UK: Kitchen Porter, as before); the default is
  // the person's own position at this site when it is a till role, never a sample position.
  const POS_ROLES = ['Manager', 'Supervisor', 'Bartender', 'Server', 'Host', 'Chef', activeRegionPack().country === 'US' ? 'Dishwasher' : 'Kitchen Porter'];
  const [role, setRole] = useState(() => { const lbl = roles[staff.role]?.lbl; return lbl && POS_ROLES.includes(lbl) ? lbl : 'Server'; });
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
