import { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { supabase, isMock } from '../../lib/supabase';
import { reportSave } from '../../lib/saveHealth';
import { nfcAvailable, scanCardOnce, normalizeCardId } from '../../lib/nfc';
import { MIN_PASSWORD_LENGTH } from '../../lib/secondStep/rules';
import { currentAccessToken } from '../../lib/secondStep/client';
import { isMissingRpc } from '../../lib/deviceFence';
import {
  BO_SECTION_KEYS, SECTIONS, FRANCHISEE_SECTIONS, allowedKeys, isEverythingRole, canEditSectionsFor,
  sectionsToStore, sectionsToTicks, describeSections, sameSections, withinSections, sectionsFromAnswer,
  isSectionsColumnMissing, canSwitchLoginOn,
} from '../../lib/boSections';

const ROLES = ['Manager','Server','Bartender','Cashier','Kitchen','Host'];
const ROLE_COLORS = { Manager:'#e8a020', Server:'#3b82f6', Bartender:'#22c55e', Cashier:'#a855f7', Kitchen:'#ef4444', Host:'#7C5CFF' };
const PERM_GROUPS = [
  { group:'Orders',     perms:[{id:'void',label:'Void items'},{id:'discount',label:'Apply discounts'},{id:'priceOverride',label:'Override price'}] },
  { group:'Payments',   perms:[{id:'refund',label:'Process refunds'},{id:'cashup',label:'Cash up drawer'},{id:'openDrawer',label:'Open cash drawer'}] },
  { group:'Management', perms:[{id:'reports',label:'View reports'},{id:'eod',label:'End of day close'},{id:'menu86',label:'86 menu items'},{id:'staff',label:'Manage staff'}] },
  // Manager phone app (?mode=manager) — these WIDEN which tabs this person sees on top of their role
  // preset (owner/manager already see everything; tick a box to give a supervisor/server more). Keys
  // must match PERM_TO_FLAG in src/lib/manager/access.js.
  { group:'Manager app', perms:[
    {id:'manager_reports',   label:'Reports & takings'},
    {id:'manager_team',      label:'Team — who’s on'},
    {id:'manager_approvals', label:'Approvals (timesheets & time off)'},
    {id:'manager_ops',       label:'Operations checks'},
    {id:'manager_kitchen',   label:'Kitchen — stock & prep'},
  ] },
];
const ROLE_DEFAULTS = {
  Manager:   ['void','discount','priceOverride','refund','cashup','openDrawer','reports','eod','menu86','staff'],
  Server:    [],
  Bartender: ['void','openDrawer'],
  Cashier:   ['cashup','openDrawer'],
  Kitchen:   [],
  Host:      ['waitlist'],
};

const inp = { background:'var(--bg3)', border:'1.5px solid var(--bdr2)', borderRadius:9, padding:'8px 11px', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', width:'100%', boxSizing:'border-box' };

function initials(name) {
  return (name||'').split(' ').map(w=>w[0]).join('').toUpperCase().slice(0,2) || '?';
}
function randomColor() {
  const palette = ['#3b82f6','#e8a020','#22c55e','#a855f7','#ef4444','#22d3ee','#f97316','#ec4899'];
  return palette[Math.floor(Math.random()*palette.length)];
}

// ── What can they open? (8 Oct 2026) ─────────────────────────────────────────
// Peter: "we need to be able to limit what they can see via each tab ... MO is a franchisee ...
// we only want to give him access to workforce, reports, team and customers, nothing else."
// The 15 top level parts of Back Office as tick boxes, with his two shortcuts. `ticks` is a
// list of section keys; every box ticked means everything (lib/boSections.js sectionsToStore).
// This chooses which SCREENS a login is shown. It is not a database lock.
function SectionPicker({ ticks, onChange, disabled = false }) {
  const all = ticks.length === BO_SECTION_KEYS.length;
  const franchisee = sameSections(ticks, [...FRANCHISEE_SECTIONS]);
  const toggle = (key) => onChange(ticks.includes(key) ? ticks.filter(k => k !== key) : [...ticks, key]);
  const shortcut = (on) => ({
    padding:'5px 12px', borderRadius:10, cursor: disabled ? 'default' : 'pointer', fontFamily:'inherit', fontSize:12, fontWeight:700,
    border:`1.5px solid ${on ? 'var(--acc)' : 'var(--bdr2)'}`, background: on ? 'var(--acc-d)' : 'var(--bg3)', color: on ? 'var(--acc)' : 'var(--t2)',
  });
  return (
    <div data-testid="bo-section-picker">
      <div style={{ display:'flex', gap:6, flexWrap:'wrap', marginBottom:6 }}>
        <button type="button" disabled={disabled} onClick={() => onChange([...BO_SECTION_KEYS])} style={shortcut(all)}>Everything</button>
        <button type="button" disabled={disabled} onClick={() => onChange([...FRANCHISEE_SECTIONS])} style={shortcut(franchisee)}>Franchisee</button>
      </div>
      <div style={{ fontSize:11, color:'var(--t3)', marginBottom:8 }}>Franchisee is {describeSections([...FRANCHISEE_SECTIONS])}.</div>
      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:4 }}>
        {SECTIONS.map(({ key, label }) => {
          const has = ticks.includes(key);
          return (
            <button type="button" key={key} role="checkbox" aria-checked={has} disabled={disabled} onClick={() => toggle(key)}
              style={{ display:'flex', alignItems:'center', gap:8, padding:'7px 10px', borderRadius:8, cursor: disabled ? 'default' : 'pointer', fontFamily:'inherit', textAlign:'left',
                border:`1.5px solid ${has ? 'var(--acc)' : 'var(--bdr)'}`, background: has ? 'var(--acc-d)' : 'var(--bg3)' }}>
              <span style={{ width:16, height:16, borderRadius:4, border:`2px solid ${has ? 'var(--acc)' : 'var(--bdr2)'}`, background: has ? 'var(--acc)' : 'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                {has && <span style={{ width:6, height:6, borderRadius:1, background:'#0b0c10' }}/>}
              </span>
              <span style={{ fontSize:12, fontWeight: has ? 600 : 400, color: has ? 'var(--acc)' : 'var(--t1)' }}>{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// The Back Office logins behind these ids, as this person is allowed to read them (their own
// row and their teammates'). 8 Oct 2026: role and bo_sections ride along so each login can say
// what it can open. bo_sections is dropped from the read ONLY when the database says that
// column does not exist (section access not installed: everyone opens everything). It has its
// own step so a missing bo_sections never takes bo_access down with it.
async function readLogins(ids) {
  if (!ids.length) return [];
  const read = (cols) => supabase.from('user_profiles').select(cols).in('id', ids);
  let hasSections = true;
  let { data, error } = await read('id, email, role, bo_access, bo_sections');
  if (error && isSectionsColumnMissing(error)) {
    hasSections = false;
    ({ data, error } = await read('id, email, role, bo_access'));
  }
  // Defensive — fall back without bo_access if column missing
  if (error && /bo_access|column.*not.*exist|PGRST204/i.test(error.message || '')) {
    hasSections = false;
    ({ data } = await read('id, email'));
  }
  return (data || []).map(p => ({
    authUserId: p.id, email: p.email, boAccess: p.bo_access !== false, role: p.role ?? null,
    // null = everything, a list = only those, undefined = could not be read (never shown as everything).
    sections: hasSections ? sectionsFromAnswer(p.bo_sections) : null,
  }));
}

export default function StaffManager({ orgCtx = null } = {}) {
  const { staffMembers, addStaffMember, updateStaffMember, removeStaffMember, markBOChange, showToast } = useStore();

  // Who is looking at this screen (8 Oct 2026, section access). orgCtx is the signed in login's
  // own profile, read once by BackOfficeApp. Only an owner or ServOS staff is offered the tick
  // boxes; the database decides again in set_bo_sections, whatever this screen shows.
  const myId = orgCtx?.userId || null;
  const myRole = orgCtx?.role || null;
  const sectionsInstalled = !isMock && orgCtx?.sectionsInstalled === true;
  // What this person may open themselves: null = everything, else their own list.
  const mySections = isMock ? null : allowedKeys({ role: myRole, sections: orgCtx?.boSections });
  const iSetSections = isEverythingRole(myRole);
  const [grantTicks, setGrantTicks] = useState(() => [...BO_SECTION_KEYS]);
  const [editSections, setEditSections] = useState(null); // { staffId, ticks } | null
  const [sectionsBusy, setSectionsBusy] = useState(false);

  // v5.5.17: BO-access state. Each staff member can optionally be linked to
  // an auth user (user_profiles.id stored in staff_members.auth_user_id).
  // The map below caches the auth user's profile so the detail panel can
  // show email + bo_access flag without re-querying on every render.
  // Keyed by staff_member.id; value is { authUserId, email, boAccess, role, sections } | null
  // (sections: null = everything, a list = only those parts of Back Office, undefined = unknown).
  const [authLinks, setAuthLinks] = useState({});
  const [showGrantBO, setShowGrantBO] = useState(null); // staff_member.id | null
  const [grantForm, setGrantForm] = useState({ email:'', password:'', confirmPassword:'' });
  const [grantBusy, setGrantBusy] = useState(false);
  const [grantError, setGrantError] = useState('');

  // Load staff from Supabase on mount (real mode only)
  useEffect(() => {
    if (isMock) return;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: profile } = await supabase.from('user_profiles').select('org_id, location_id').eq('id', user.id).single();
      let locationId = profile?.location_id;
      // Auto-assign first location if none set
      if (!locationId && profile?.org_id) {
        const { data: locs } = await supabase.from('locations').select('id').eq('org_id', profile.org_id).limit(1);
        locationId = locs?.[0]?.id;
        if (locationId) await supabase.from('user_profiles').update({ location_id: locationId }).eq('id', user.id);
      }
      if (!locationId) return;
      // v5.5.17: also SELECT auth_user_id so we can show / toggle BO access.
      // Defensive: if column missing (pre-migration), drop it from the SELECT.
      let { data: rows, error } = await supabase
        .from('staff_members')
        .select('id, name, role, pin, color, initials, permissions, active, auth_user_id, nfc_card_id, auth_method')
        .eq('location_id', locationId).eq('active', true);
      if (error && /auth_user_id|column.*not.*exist|PGRST204/i.test(error.message || '')) {
        console.warn('[StaffManager] auth_user_id column missing — falling back. Run supabase/migrations/20260430_staff_auth_link.sql to enable BO access linking.');
        // v5.5.730: keep nfc_card_id + auth_method in the fallback — dropping them made every staff
        // show as PIN with no card in the BO (only auth_user_id is the actually-missing column).
        ({ data: rows } = await supabase
          .from('staff_members')
          .select('id, name, role, pin, color, initials, permissions, active, nfc_card_id, auth_method')
          .eq('location_id', locationId).eq('active', true));
      }
      if (rows?.length) {
        useStore.setState({ staffMembers: rows.map(r => ({
          id: r.id, name: r.name, role: r.role, pin: r.pin,
          color: r.color || '#3b82f6', initials: r.initials || r.name.slice(0,2).toUpperCase(),
          permissions: Array.isArray(r.permissions) ? r.permissions : (ROLE_DEFAULTS[r.role] || []),
          active: r.active,
          authUserId: r.auth_user_id || null,
          nfcCardId: r.nfc_card_id || null,
          authMethod: r.auth_method || 'pin',
        })) });
        // Bulk-fetch profiles for any linked auth users
        const linkedIds = rows.map(r => r.auth_user_id).filter(Boolean);
        if (linkedIds.length > 0) {
          const logins = await readLogins(linkedIds);
          const linkMap = {};
          rows.forEach(r => {
            if (!r.auth_user_id) return;
            const p = logins.find(x => x.authUserId === r.auth_user_id);
            if (p) linkMap[r.id] = p;
          });
          setAuthLinks(linkMap);
        }
      }
    })();
  }, []);

  const saveStaffToSupabase = async (member, locationId, orgId) => {
    await supabase.from('staff_members').upsert({
      id: member.id.startsWith('s-') ? undefined : member.id, // let Supabase generate UUID for new records
      location_id: locationId, org_id: orgId,
      name: member.name, role: member.role, pin: member.pin,
      color: member.color, initials: member.initials, active: true,
    }, { onConflict: 'id' });
  };

  const deleteStaffFromSupabase = async (id) => {
    if (!id.startsWith('s-')) { // only delete real UUIDs
      await supabase.from('staff_members').update({ active: false }).eq('id', id);
    }
  };
  const [selId, setSelId]     = useState(null);
  const [scanningCard, setScanningCard] = useState(false);
  const [cardEntry, setCardEntry] = useState(''); // Back-Office USB-reader capture box
  const [showAdd, setShowAdd] = useState(false);
  const [showPin, setShowPin] = useState(null);
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState(''); // v5.5.292: duplicate PIN warning
  const [newForm, setNewForm] = useState({ name:'', role:'Server', color:'#3b82f6', pin:'', permissions:[] });

  // v5.5.292: Check if a PIN is already used by another active staff member at this location
  const isPinTaken = (pin, excludeId) => {
    if (!pin || pin.length !== 4) return false;
    return staffMembers.some(s => s.active !== false && s.id !== excludeId && s.pin === pin);
  };
  const getPinOwner = (pin, excludeId) => {
    if (!pin || pin.length !== 4) return null;
    return staffMembers.find(s => s.active !== false && s.id !== excludeId && s.pin === pin);
  };

  const sel = staffMembers.find(s => s.id === selId);

  // The name box commits on blur, not per keystroke. save() now rolls the panel back
  // when the database refuses a write, and a per-keystroke save fires one request per
  // character — each closing over its own already-stale snapshot, so a single refusal
  // mid-word would rewind the field to whatever it held several letters ago. Every
  // other control here writes one discrete value, so only this field needs a draft.
  const [nameDraft, setNameDraft] = useState(null);
  useEffect(() => { setNameDraft(null); }, [selId]);
  const commitName = () => {
    const next = (nameDraft ?? '').trim();
    setNameDraft(null);
    if (!sel || !next || next === sel.name) return;
    save(sel.id, { name: next, initials: initials(next) });
  };

  // Resolves true only when the change is actually persisted (or we're in mock mode) —
  // callers must not claim success before awaiting it.
  const save = async (id, patch) => {
    // The store keeps some fields camelCase but the DB columns are snake_case. Mirror the snake-case
    // patch onto the camelCase the UI reads, so the change shows immediately (toggle moves, card
    // status updates). The DB still receives the snake-case `patch` below.
    const localPatch = { ...patch };
    if ('auth_method' in patch) localPatch.authMethod = patch.auth_method;
    if ('nfc_card_id' in patch) localPatch.nfcCardId = patch.nfc_card_id;
    // Snapshot the fields we're about to overwrite so a rejected write can be undone —
    // the panel must never keep showing a PIN/role/card the database refused.
    const before = staffMembers.find(s => s.id === id);
    const undo = () => {
      if (!before) return;
      const revert = {};
      for (const k of Object.keys(localPatch)) if (k in before) revert[k] = before[k];
      if (Object.keys(revert).length) updateStaffMember(id, revert);
    };
    updateStaffMember(id, localPatch);
    markBOChange();

    // Persist patch to Supabase (real mode only), surfacing silent 0-row
    // updates (v4.4.1 lesson) via a toast + the saveHealth banner.
    if (isMock) return true;
    if (String(id).startsWith('s-')) {
      // In-memory row whose UUID hasn't come back from Supabase yet (the store stamps
      // a local `s-…` id on add). There is nothing to update server-side, so undo the
      // optimistic change and say so instead of letting the edit look saved.
      undo();
      showToast('Not saved on the server yet — refresh the page, then edit this staff member', 'error');
      return false;
    }
    try {
      const { data, error } = await supabase
        .from('staff_members')
        .update(patch)
        .eq('id', id)
        .select('id');
      if (error) throw error;
      if (!data || data.length === 0) {
        console.warn('[StaffManager] save: 0 rows updated for id', id, 'patch', patch);
        reportSave('staff member', new Error(`Update matched 0 rows for id=${id}`));
        undo();
        showToast('Save did not land — row not found on server', 'error');
        return false;
      }
      reportSave('staff member', null);
      return true;
    } catch (e) {
      console.error('[StaffManager] save failed:', e.message, 'patch', patch);
      reportSave('staff member', e);
      undo();
      showToast(`Save failed: ${e.message}`, 'error');
      return false;
    }
  };

  // Assign an NFC card by tapping it on a reader (works when BO runs on a till). Card UIDs are
  // global, so the assigned card works on any till. Persists via the generic save() path.
  const scanCard = async (id) => {
    if (scanningCard) return;
    setScanningCard(true);
    const r = await scanCardOnce();
    setScanningCard(false);
    if (!r.ok) { showToast(r.error === 'timeout' ? 'No card detected — try again' : 'Card scanning isn’t available on this device', 'error'); return; }
    const taken = staffMembers.find(s => s.id !== id && s.nfcCardId && s.nfcCardId === r.cardId);
    if (taken) { showToast(`That card is already assigned to ${taken.name}`, 'error'); return; }
    if (await save(id, { nfc_card_id: r.cardId })) showToast('Card assigned', 'success');
  };

  // Back-Office enrolment: a USB NFC reader (keyboard-wedge) types the card UID into the box; save it.
  const saveCardEntry = async (id) => {
    const cid = normalizeCardId(cardEntry);
    if (!cid) { showToast('Tap a card on the reader, or type its ID first', 'error'); return; }
    const taken = staffMembers.find(s => s.id !== id && s.nfcCardId && s.nfcCardId === cid);
    if (taken) { showToast(`That card is already assigned to ${taken.name}`, 'error'); return; }
    // Keep the typed card ID in the box if the write failed, so it can be retried.
    if (await save(id, { nfc_card_id: cid })) { setCardEntry(''); showToast('Card assigned', 'success'); }
  };

  const addMember = async () => {
    if (!newForm.name.trim()) return;
    // v5.5.292: Block duplicate PINs
    if (newForm.pin && newForm.pin.length === 4 && isPinTaken(newForm.pin, null)) {
      showToast(`PIN already used by ${getPinOwner(newForm.pin, null)?.name || 'another staff member'}`, 'error');
      return;
    }
    const perms = newForm.permissions.length ? newForm.permissions : ROLE_DEFAULTS[newForm.role] || [];
    const member = { ...newForm, name:newForm.name.trim(), permissions:perms, initials:initials(newForm.name) };
    addStaffMember(member);
    // The store stamps its own local `s-…` id; grab it so a rejected insert can be
    // rolled straight back off the screen instead of leaving a phantom staff member.
    const st = useStore.getState().staffMembers;
    const localId = st[st.length - 1]?.id;
    markBOChange();
    setShowAdd(false);
    setNewForm({ name:'', role:'Server', color:'#3b82f6', pin:'', permissions:[] });

    if (isMock) { showToast(`${member.name} added`, 'success'); return; }

    // Save to Supabase — the success toast fires only once the row has landed.
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not signed in');
      const { data: profile } = await supabase.from('user_profiles').select('org_id, location_id').eq('id', user.id).single();
      // Get location_id — from profile, or find first location in their org
      let locationId = profile?.location_id;
      if (!locationId && profile?.org_id) {
        const { data: locs } = await supabase.from('locations').select('id').eq('org_id', profile.org_id).limit(1);
        locationId = locs?.[0]?.id;
        // Also update user profile so we don't have to look this up again
        if (locationId) await supabase.from('user_profiles').update({ location_id: locationId }).eq('id', user.id);
      }
      if (!locationId) throw new Error('No location found for this user');
      const { error } = await supabase.from('staff_members').insert({
        location_id: locationId, org_id: profile?.org_id,
        name: member.name, role: member.role, pin: member.pin,
        color: member.color || '#3b82f6', initials: member.initials,
        permissions: member.permissions || [],
        active: true,
      });
      if (error) throw error;
      reportSave('staff member', null);
      showToast(`${member.name} added`, 'success');
    } catch (e) {
      console.error('Staff save failed:', e.message);
      reportSave('staff member', e);
      if (localId) removeStaffMember(localId);
      showToast(`"${member.name}" was NOT saved — fix the problem and add them again`, 'error');
    }
  };

  const deleteMember = async (id) => {
    // Remove from the DB FIRST: if the soft-delete is rejected the person can still
    // sign in on the till, so the list must keep showing them.
    if (!isMock && !String(id).startsWith('s-')) {
      const { data, error } = await supabase.from('staff_members').update({ active: false }).eq('id', id).select('id');
      const failure = error || (!data || data.length === 0
        ? new Error(`Remove matched 0 rows for id=${id} — RLS may have blocked it`)
        : null);
      reportSave('staff member remove', failure);
      if (failure) {
        showToast('Remove failed — this person can still sign in on the till', 'error');
        return;
      }
    }
    removeStaffMember(id);
    markBOChange();
    if (selId === id) setSelId(null);
    showToast('Staff member removed', 'info');
  };

  const togglePerm = (id, perm) => {
    const member = staffMembers.find(s => s.id === id);
    if (!member) return;
    const cur = member.permissions || [];
    save(id, { permissions: cur.includes(perm) ? cur.filter(p=>p!==perm) : [...cur,perm] });
  };

  // v5.5.17: BO access lifecycle
  //
  // grantBOAccess: creates an auth user via the create-user edge function
  // (same one CompanyAdminApp uses), then links the new user_profiles.id
  // back onto staff_members.auth_user_id. The user can sign in to the BO
  // immediately afterwards. bo_access defaults true on the new user.
  const grantBOAccess = async (staffId) => {
    setGrantError('');
    if (!grantForm.email.trim()) { setGrantError('Email required'); return; }
    if (grantForm.password.length < MIN_PASSWORD_LENGTH) { setGrantError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`); return; }
    if (grantForm.password !== grantForm.confirmPassword) { setGrantError('Passwords do not match'); return; }
    if (isMock) { setGrantError('Mock mode — auth user creation not available'); return; }
    // What this login should open (8 Oct 2026). Only an owner or ServOS staff choose, and only
    // once the database has the column. undefined = nothing is sent: the server then gives the
    // login everything, or, when the person making it is limited, exactly their own list.
    const wanted = (iSetSections && sectionsInstalled) ? sectionsToStore(grantTicks) : undefined;
    if (Array.isArray(wanted) && wanted.length === 0) { setGrantError('Tick at least one part of Back Office.'); return; }

    setGrantBusy(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const { data: meProfile } = await supabase.from('user_profiles').select('org_id, location_id').eq('id', user.id).single();
      const orgId = meProfile?.org_id;
      const locId = meProfile?.location_id;
      if (!orgId) { setGrantError('Your account is not linked to an org — cannot create users'); setGrantBusy(false); return; }

      // The CURRENT (refreshed, aal2 after the second step) token, not a raw localStorage read.
      const token = await currentAccessToken(supabase);
      const member = staffMembers.find(s => s.id === staffId);
      const resp = await fetch('https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/create-user', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${token}` },
        body: JSON.stringify({
          email: grantForm.email.trim(),
          password: grantForm.password,
          fullName: member?.name || '',
          orgId,
          locationId: locId || null,
          role: 'manager',
          ...(wanted !== undefined ? { sections: wanted } : {}),
        }),
      });
      const result = await resp.json();
      if (result.error) { setGrantError(result.error); setGrantBusy(false); return; }
      const newUserId = result.userId || result.id;   // fn returns userId; result.id kept for compat
      if (!newUserId) { setGrantError('Edge function did not return a user id'); setGrantBusy(false); return; }

      // ── Did the limit land? (8 Oct 2026) ──────────────────────────────────
      // `expected` is the limit this login MUST have: the one ticked here, or, for a limited
      // person, their own list (a login never opens more than whoever made it). null = no limit.
      // The server answers with what it stored (`sections`). An answer WITHOUT it comes from an
      // older create-user that knows nothing about lists, so that login opens EVERYTHING,
      // whatever was asked: it is never treated as limited.
      const expected = wanted !== undefined ? wanted : mySections;
      let landed = sectionsFromAnswer(result.sections);
      let limitSaved = expected === null || withinSections(landed, expected);
      if (!limitSaved && iSetSections) {
        // The owner's own way in: the same change through the database function.
        const { data: fix, error: fixErr } = await supabase.rpc('set_bo_sections', { p_user: newUserId, p_sections: expected });
        const fixed = !fixErr && fix?.ok === true ? sectionsFromAnswer(fix.sections) : undefined;
        if (withinSections(fixed, expected)) { landed = fixed; limitSaved = true; }
        else console.warn('[grantBOAccess] the limit could not be saved:', fixErr?.message || 'no answer');
      }
      // FAIL CLOSED: a login that should be limited and is not must not be usable. This one was
      // made a moment ago by this screen, so switching it off takes nothing away from anybody.
      // (An email that ALREADY had a login is left alone: switching that off could lock a
      // person out of a Back Office they already use.)
      let switchedOff = false;
      if (!limitSaved && !result.alreadyExisted) {
        const { data: off, error: offErr } = await supabase.from('user_profiles').update({ bo_access: false }).eq('id', newUserId).select('id');
        switchedOff = !offErr && Array.isArray(off) && off.length > 0;
      }

      // Link the new auth user to this staff_member.
      const { error: linkErr } = await supabase
        .from('staff_members')
        .update({ auth_user_id: newUserId })
        .eq('id', staffId);
      if (linkErr) {
        console.warn('[grantBOAccess] link update failed:', linkErr.message);
        setGrantError('User created but linking to staff member failed: ' + linkErr.message);
        setGrantBusy(false);
        return;
      }

      // Update local state, from the row itself where it can be read (what the login REALLY
      // has: its role, whether it is on, what it can open), never from what was asked for.
      const [fresh] = await readLogins([newUserId]).catch(() => []);
      const link = fresh || {
        authUserId: newUserId, email: grantForm.email.trim(), boAccess: !switchedOff, role: null,
        sections: limitSaved ? landed : undefined,
      };
      setAuthLinks(prev => ({ ...prev, [staffId]: link }));
      useStore.setState({
        staffMembers: useStore.getState().staffMembers.map(s =>
          s.id === staffId ? { ...s, authUserId: newUserId } : s
        ),
      });

      setShowGrantBO(null);
      setGrantForm({ email:'', password:'', confirmPassword:'' });
      setGrantBusy(false);
      if (limitSaved) {
        const opens = isEverythingRole(link.role) || link.sections === undefined ? '' : ` It can open: ${describeSections(link.sections)}.`;
        showToast(`Back Office login made. ${grantForm.email.trim()} can now sign in.${opens}`, 'success');
      } else if (switchedOff) {
        showToast(iSetSections
          ? 'The login was made, but its limit was NOT saved, so it is switched off. Set what it can open, then switch it on.'
          : 'The login was made, but its limit was NOT saved, so it is switched off. Ask the owner to set what it can open.', 'error', 15000);
      } else {
        showToast('The limit was NOT saved. This login can open EVERYTHING in Back Office. Switch its access off now, then ask ServOS.', 'error', 20000);
      }
    } catch (e) {
      setGrantError(e.message);
      setGrantBusy(false);
    }
  };

  // toggleBOAccess: flips user_profiles.bo_access without touching the auth
  // record. Lets you temporarily revoke without losing the credential.
  const toggleBOAccess = async (staffId) => {
    const link = authLinks[staffId];
    if (!link) return;
    const next = !link.boAccess;
    // 8 Oct 2026 (review): switching ON is for a person who can open everything the login can.
    // A limited login could otherwise undo the switch off grantBOAccess does when a new login's
    // limit did not land, or switch an unlimited teammate login back on after the owner turned it
    // off. Off is always allowed. The database refuses the same write (the guard on
    // user_profiles); this is the plain word before the request is made.
    if (next && !canSwitchLoginOn(link.sections, mySections)) {
      showToast('Only the owner can switch this login on.', 'error');
      return;
    }
    const { error } = await supabase
      .from('user_profiles')
      .update({ bo_access: next })
      .eq('id', link.authUserId);
    if (error) {
      if (/bo_access|column.*not.*exist|PGRST204/i.test(error.message || '')) {
        showToast('Run supabase/migrations/20260430_staff_auth_link.sql first — bo_access column missing', 'error');
        return;
      }
      showToast('Failed to update access: ' + error.message, 'error');
      return;
    }
    setAuthLinks(prev => ({ ...prev, [staffId]: { ...link, boAccess: next } }));
    showToast(next ? '✓ Back-office access enabled' : 'Back-office access disabled', 'success');
  };

  // saveSections (8 Oct 2026): what an existing login can open. The ONLY way a person changes
  // it is the database function set_bo_sections, which checks again who is asking (an owner of
  // the same company or ServOS staff, never your own login, never an owner's). The screen
  // believes the function's answer, not what it sent.
  const saveSections = async () => {
    if (!editSections) return;
    const { staffId, ticks } = editSections;
    const link = authLinks[staffId];
    if (!link) return;
    if (!ticks.length) { showToast('Tick at least one. To stop this login, switch its Back Office access off.', 'error'); return; }
    const toStore = sectionsToStore(ticks);
    setSectionsBusy(true);
    try {
      const { data, error } = await supabase.rpc('set_bo_sections', { p_user: link.authUserId, p_sections: toStore });
      if (error) {
        showToast(isMissingRpc(error) ? 'Not saved. This needs a database update first.' : `Not saved. ${error.message}`, 'error', 9000);
        return;
      }
      const landed = data?.ok === true ? sectionsFromAnswer(data.sections) : undefined;
      if (!sameSections(landed, toStore)) { showToast('Not saved. Reload the page and check.', 'error', 9000); return; }
      setAuthLinks(prev => (prev[staffId] ? { ...prev, [staffId]: { ...prev[staffId], sections: landed } } : prev));
      setEditSections(null);
      showToast('Saved. It applies the next time they open Back Office.', 'success', 5000);
    } catch (e) {
      showToast(`Not saved. ${e?.message || 'Try again.'}`, 'error', 9000);
    } finally {
      setSectionsBusy(false);
    }
  };

  // What a login can open, in plain words, and whether this person may change it. Rendered
  // inside the Back-office access card of a staff member who has a login.
  const sectionAccess = (staffId, link) => {
    const everything = isEverythingRole(link.role) || !sectionsInstalled;
    const words = everything ? 'Everything' : (link.sections === undefined ? 'Not known' : describeSections(link.sections));
    const editable = sectionsInstalled && link.sections !== undefined
      && canEditSectionsFor({ callerRole: myRole, callerId: myId, targetId: link.authUserId, targetRole: link.role });
    // One plain line saying why there are no tick boxes, when there are none.
    let why = '';
    if (!sectionsInstalled) why = 'Choosing what a login can open needs a database update.';
    else if (isEverythingRole(link.role)) why = 'An owner always opens everything.';
    else if (myId && link.authUserId === myId) why = 'This is your own login. You cannot change it.';
    else if (!iSetSections) why = 'Only the owner can change this.';
    else if (link.sections === undefined) why = 'Could not read what this login can open. Reload the page.';
    const editing = editable && editSections?.staffId === staffId;
    return (
      <div data-testid="bo-section-access" style={{ borderTop:'1px solid var(--bdr)', paddingTop:10, marginBottom:8 }}>
        <div style={{ display:'flex', alignItems:'flex-start', gap:10 }}>
          <div style={{ flex:1 }}>
            <div style={{ fontSize:12, fontWeight:700, color:'var(--t1)', marginBottom:2 }}>What can they open?</div>
            <div style={{ fontSize:12, color: link.sections === undefined && !everything ? 'var(--red)' : 'var(--t2)', fontWeight:600 }}>{words}</div>
            {why && <div style={{ fontSize:10, color:'var(--t3)', marginTop:3 }}>{why}</div>}
          </div>
          {editable && !editing && (
            <button onClick={()=>setEditSections({ staffId, ticks: sectionsToTicks(link.sections) })}
              style={{ padding:'4px 10px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:11, fontWeight:600 }}>Change</button>
          )}
        </div>
        {editing && (
          <div style={{ marginTop:10 }}>
            <SectionPicker ticks={editSections.ticks} disabled={sectionsBusy} onChange={(ticks)=>setEditSections({ staffId, ticks })}/>
            <div style={{ display:'flex', gap:8, marginTop:10 }}>
              <button onClick={()=>setEditSections(null)} disabled={sectionsBusy} style={{ flex:1, padding:'8px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:12 }}>Cancel</button>
              <button onClick={saveSections} disabled={sectionsBusy || editSections.ticks.length === 0}
                style={{ flex:2, padding:'8px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:13, fontWeight:800, opacity:(sectionsBusy || editSections.ticks.length === 0) ? .5 : 1 }}>
                {sectionsBusy ? 'Saving…' : 'Save'}
              </button>
            </div>
            {editSections.ticks.length === 0 && (
              <div style={{ fontSize:10, color:'var(--t3)', marginTop:6 }}>Tick at least one. To stop this login, switch its Back Office access off.</div>
            )}
          </div>
        )}
      </div>
    );
  };

  // unlinkBOAccess: clears auth_user_id from staff_members. Does NOT delete
  // the auth user — they can still exist in user_profiles, just unlinked
  // from this staff member. Useful when a person leaves the business.
  const unlinkBOAccess = async (staffId) => {
    if (!confirm('Unlink back-office access? The user account is preserved but no longer linked to this staff member.')) return;
    const { error } = await supabase
      .from('staff_members')
      .update({ auth_user_id: null })
      .eq('id', staffId);
    if (error) { showToast('Failed to unlink: ' + error.message, 'error'); return; }
    setAuthLinks(prev => { const next = { ...prev }; delete next[staffId]; return next; });
    useStore.setState({
      staffMembers: useStore.getState().staffMembers.map(s =>
        s.id === staffId ? { ...s, authUserId: null } : s
      ),
    });
    showToast('Unlinked', 'info');
  };

  return (
    <div style={{ display:'flex', height:'100%', overflow:'hidden' }}>

      {/* ── Staff list ────────────────────────────────────────── */}
      <div style={{ width:280, borderRight:'1px solid var(--bdr)', display:'flex', flexDirection:'column', overflow:'hidden' }}>
        <div style={{ padding:'10px 12px', borderBottom:'1px solid var(--bdr)', background:'var(--bg1)', display:'flex', alignItems:'center', gap:8, flexShrink:0 }}>
          <span style={{ fontSize:13, fontWeight:800, color:'var(--t1)', flex:1 }}>Staff</span>
          <span style={{ fontSize:11, color:'var(--t4)' }}>{staffMembers.length} members</span>
          <button onClick={()=>setShowAdd(true)} style={{ padding:'5px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:12, fontWeight:700 }}>+ Add</button>
        </div>

        <div style={{ flex:1, overflowY:'auto', padding:'8px' }}>
          {staffMembers.map(s => {
            const color = ROLE_COLORS[s.role] || '#3b82f6';
            const active = selId === s.id;
            return (
              <div key={s.id} onClick={()=>setSelId(active?null:s.id)}
                style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', marginBottom:5, borderRadius:11, cursor:'pointer',
                  border:`1.5px solid ${active?'var(--acc)':'var(--bdr)'}`, background:active?'var(--acc-d)':'var(--bg3)' }}>
                {/* Avatar */}
                <div style={{ width:36, height:36, borderRadius:'50%', background:s.color||color, display:'flex', alignItems:'center', justifyContent:'center', fontSize:13, fontWeight:800, color:'#fff', flexShrink:0 }}>
                  {initials(s.name)}
                </div>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:700, color:active?'var(--acc)':'var(--t1)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.name}</div>
                  <div style={{ fontSize:11, fontWeight:600, color }}>
                    {s.role}
                    {s.pin ? ' · PIN set' : <span style={{ color:'var(--red)' }}> · No PIN</span>}
                  </div>
                </div>
                <div style={{ width:8, height:8, borderRadius:'50%', background:active?'var(--acc)':s.pin?'var(--grn)':'var(--red)', flexShrink:0 }}/>
              </div>
            );
          })}
          {staffMembers.length === 0 && (
            <div style={{ textAlign:'center', padding:'32px 8px', color:'var(--t4)', fontSize:11 }}>No staff yet — click + Add to get started</div>
          )}
        </div>
      </div>

      {/* ── Detail / editor ──────────────────────────────────── */}
      {sel ? (
        <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
          {/* Header */}
          <div style={{ padding:'12px 16px', borderBottom:'1px solid var(--bdr)', background:'var(--bg1)', display:'flex', alignItems:'center', gap:12, flexShrink:0 }}>
            <div style={{ width:48, height:48, borderRadius:'50%', background:sel.color||ROLE_COLORS[sel.role]||'#3b82f6', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, fontWeight:800, color:'#fff', flexShrink:0 }}>
              {initials(sel.name)}
            </div>
            <div style={{ flex:1 }}>
              <input style={{ ...inp, fontSize:16, fontWeight:800, border:'none', background:'transparent', padding:'0 0 3px', width:'auto', maxWidth:260 }}
                value={nameDraft ?? sel.name} onChange={e=>setNameDraft(e.target.value)}
                onBlur={commitName} onKeyDown={e=>{ if (e.key==='Enter') e.currentTarget.blur(); }}/>
              <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                {ROLES.map(r=>(
                  <button key={r} onClick={()=>save(sel.id,{role:r})} style={{ padding:'2px 8px', borderRadius:12, cursor:'pointer', fontFamily:'inherit', fontSize:10, fontWeight:sel.role===r?700:400, border:`1px solid ${sel.role===r?ROLE_COLORS[r]:'var(--bdr)'}`, background:sel.role===r?ROLE_COLORS[r]+'22':'transparent', color:sel.role===r?ROLE_COLORS[r]:'var(--t4)' }}>{r}</button>
                ))}
              </div>
            </div>
            {/* Avatar colour */}
            <div style={{ display:'flex', gap:4 }}>
              {['#3b82f6','#e8a020','#22c55e','#a855f7','#ef4444','#f97316'].map(c=>(
                <button key={c} onClick={()=>save(sel.id,{color:c})} style={{ width:18,height:18,borderRadius:'50%',background:c,border:'none',cursor:'pointer',outline:(sel.color||'#3b82f6')===c?'2px solid var(--t1)':'none',outlineOffset:2 }}/>
              ))}
            </div>
            <button onClick={()=>deleteMember(sel.id)} style={{ padding:'5px 10px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', fontSize:11, fontWeight:600 }}>Remove</button>
          </div>

          <div style={{ flex:1, overflowY:'auto', padding:'16px' }}>
            {/* PIN */}
            <div style={{ marginBottom:20, padding:'12px 14px', background:'var(--bg2)', borderRadius:12, border:'1px solid var(--bdr)' }}>
              <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:sel.pin?4:0 }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'var(--t1)', marginBottom:2 }}>Login PIN</div>
                  <div style={{ fontSize:10, color:'var(--t3)' }}>4-digit PIN used at the POS login screen. Required for all staff.</div>
                </div>
                {sel.pin ? (
                  <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                    <span style={{ fontSize:12, color:'var(--grn)', fontWeight:700 }}>✓ PIN set</span>
                    <button onClick={()=>{ setShowPin(sel.id); setPinInput(''); }} style={{ padding:'4px 10px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:11, fontWeight:600 }}>Change</button>
                    <button onClick={()=>save(sel.id,{pin:''})} style={{ padding:'4px 10px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', fontSize:11, fontWeight:600 }}>Clear</button>
                  </div>
                ) : (
                  <button onClick={()=>{ setShowPin(sel.id); setPinInput(''); }} style={{ padding:'6px 14px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:12, fontWeight:700 }}>Set PIN</button>
                )}
              </div>
              {sel.pin && <div style={{ display:'flex', gap:6 }}>{Array(4).fill(null).map((_,i)=><div key={i} style={{ width:16, height:16, borderRadius:'50%', background:'var(--t3)' }}/>)}</div>}
            </div>

            {/* Sign-in method — PIN or Card (enforced at the till). A 'Card' staff is refused a PIN
                (manager override aside) — that's the security win. Assign cards here with a USB NFC
                reader: tap a card and its ID fills the box, then Save. Card works on any till. */}
            <div style={{ marginBottom:20, padding:'12px 14px', background:'var(--bg2)', borderRadius:12, border:'1px solid var(--bdr)' }}>
              <div style={{ fontSize:12, fontWeight:700, color:'var(--t1)', marginBottom:2 }}>Sign-in method</div>
              <div style={{ fontSize:10, color:'var(--t3)', marginBottom:10 }}>How this person signs in at the till. Card = more secure (a shared PIN won’t sign them in).</div>
              <div style={{ display:'flex', gap:8, marginBottom: (sel.authMethod==='card') ? 12 : 0 }}>
                {['pin','card'].map(m => (
                  <button key={m} onClick={()=>save(sel.id,{auth_method:m})} style={{
                    flex:1, padding:'8px 0', borderRadius:9, cursor:'pointer', fontFamily:'inherit', fontSize:12, fontWeight:700,
                    border:`1.5px solid ${(sel.authMethod||'pin')===m ? 'var(--acc)' : 'var(--bdr)'}`,
                    background:(sel.authMethod||'pin')===m ? 'var(--acc-d, rgba(232,160,32,.10))' : 'transparent',
                    color:(sel.authMethod||'pin')===m ? 'var(--acc)' : 'var(--t3)',
                  }}>{m==='pin' ? '🔢 PIN' : '💳 Card'}</button>
                ))}
              </div>
              {sel.authMethod==='card' && (
                <div>
                  <div style={{ fontSize:11, marginBottom:8, color: sel.nfcCardId ? 'var(--grn)' : 'var(--red)', fontWeight:700 }}>
                    {sel.nfcCardId ? '✓ Card assigned' : '⚠ No card yet — assign one below, or they can’t sign in'}
                  </div>
                  <div style={{ display:'flex', gap:6 }}>
                    <input value={cardEntry} onChange={e=>setCardEntry(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter') saveCardEntry(sel.id); }}
                      placeholder="Tap card on the USB reader, or type the ID"
                      style={{ flex:1, padding:'8px 10px', borderRadius:8, border:'1px solid var(--bdr2)', background:'var(--bg3)', color:'var(--t1)', fontSize:12, fontFamily:'inherit' }}/>
                    <button onClick={()=>saveCardEntry(sel.id)} style={{ padding:'8px 12px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:12, fontWeight:700 }}>Save card</button>
                    {nfcAvailable() && <button onClick={()=>scanCard(sel.id)} disabled={scanningCard} style={{ padding:'8px 10px', borderRadius:8, cursor:scanningCard?'wait':'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:11, fontWeight:600 }}>{scanningCard?'Tap…':'Scan'}</button>}
                    {sel.nfcCardId && <button onClick={()=>save(sel.id,{nfc_card_id:null})} style={{ padding:'8px 10px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', fontSize:11, fontWeight:600 }}>Remove</button>}
                  </div>
                  <div style={{ fontSize:10, color:'var(--t4)', marginTop:6 }}>Use a 13.56MHz USB NFC reader on this computer — tap a card, its ID fills the box, then Save.</div>
                </div>
              )}
            </div>

            {/* v5.5.17: Back-office access card. Lets the operator give a
                staff member email + password to sign in to the BO, separate
                from their POS PIN. Shown for all staff but most stay
                POS-PIN-only. */}
            <div style={{ marginBottom:20, padding:'12px 14px', background:'var(--bg2)', borderRadius:12, border:'1px solid var(--bdr)' }}>
              {(() => {
                const link = authLinks[sel.id];
                if (!link) {
                  return (
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:12, fontWeight:700, color:'var(--t1)', marginBottom:2 }}>Back-office access</div>
                        <div style={{ fontSize:10, color:'var(--t3)' }}>Give this staff member an email and password to sign in to Back Office.{iSetSections && sectionsInstalled ? ' You choose what they can open.' : ''}</div>
                      </div>
                      <button
                        onClick={()=>{ setShowGrantBO(sel.id); setGrantForm({ email:'', password:'', confirmPassword:'' }); setGrantTicks([...BO_SECTION_KEYS]); setGrantError(''); }}
                        style={{ padding:'6px 14px', borderRadius:8, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:12, fontWeight:700 }}
                      >Grant access</button>
                    </div>
                  );
                }
                return (
                  <>
                    <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:8 }}>
                      <div style={{ flex:1 }}>
                        <div style={{ fontSize:12, fontWeight:700, color:'var(--t1)', marginBottom:2 }}>Back-office access</div>
                        <div style={{ fontSize:10, color:'var(--t3)', fontFamily:'monospace' }}>{link.email}</div>
                      </div>
                      {/* 8 Oct 2026 (review): a switched off login that this person may not switch
                          on (it opens more than they do) gets plain words, not a dead button. */}
                      {link.boAccess || canSwitchLoginOn(link.sections, mySections) ? (
                        <button
                          onClick={()=>toggleBOAccess(sel.id)}
                          style={{
                            padding:'6px 14px', borderRadius:8, cursor:'pointer', fontFamily:'inherit',
                            background: link.boAccess ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.16)',
                            border: link.boAccess ? '1px solid rgba(34,197,94,0.4)' : '1px solid rgba(239,68,68,0.4)',
                            color: link.boAccess ? '#86efac' : '#fca5a5',
                            fontSize:11, fontWeight:700,
                          }}
                        >{link.boAccess ? '✓ Enabled — click to disable' : '✗ Disabled — click to enable'}</button>
                      ) : (
                        <div data-testid="bo-switch-on-owner-only" style={{ padding:'6px 14px', borderRadius:8, background:'rgba(239,68,68,0.16)', border:'1px solid rgba(239,68,68,0.4)', color:'#fca5a5', fontSize:11, fontWeight:700, textAlign:'right', lineHeight:1.4 }}>
                          Switched off.<br/>Only the owner can switch this login on.
                        </div>
                      )}
                    </div>
                    {sectionAccess(sel.id, link)}
                    <div style={{ display:'flex', gap:6, justifyContent:'flex-end' }}>
                      <button
                        onClick={()=>unlinkBOAccess(sel.id)}
                        style={{ padding:'4px 10px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t3)', fontSize:10, fontWeight:600 }}
                        title="Disconnect this auth user from the staff record. The user account is preserved."
                      >Unlink</button>
                    </div>
                  </>
                );
              })()}
            </div>

            {/* Permissions */}
            <div style={{ marginBottom:12 }}>
              <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)' }}>Permissions</div>
                <button onClick={()=>save(sel.id,{permissions:ROLE_DEFAULTS[sel.role]||[]})} style={{ fontSize:10, padding:'2px 8px', borderRadius:10, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t4)' }}>Reset to {sel.role} defaults</button>
              </div>
              <div style={{ fontSize:10, color:'var(--t3)', marginBottom:12 }}>Permissions without a tick require manager PIN override at POS.</div>

              {PERM_GROUPS.map(({ group, perms }) => (
                <div key={group} style={{ marginBottom:14 }}>
                  <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:6 }}>{group}</div>
                  <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                    {perms.map(({ id, label }) => {
                      const has = (sel.permissions||[]).includes(id);
                      return (
                        <div key={id} onClick={()=>togglePerm(sel.id, id)}
                          style={{ display:'flex', alignItems:'center', gap:9, padding:'8px 11px', borderRadius:8, cursor:'pointer',
                            border:`1.5px solid ${has?'var(--acc)':'var(--bdr)'}`, background:has?'var(--acc-d)':'var(--bg3)' }}>
                          <div style={{ width:18, height:18, borderRadius:4, border:`2px solid ${has?'var(--acc)':'var(--bdr2)'}`, background:has?'var(--acc)':'transparent', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
                            {has && <div style={{ width:7, height:7, borderRadius:1, background:'#0b0c10' }}/>}
                          </div>
                          <span style={{ fontSize:12, fontWeight:has?600:400, color:has?'var(--acc)':'var(--t1)', flex:1 }}>{label}</span>
                          {has && <span style={{ fontSize:10, color:'var(--acc)', fontWeight:700 }}>Allowed</span>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:8, color:'var(--t4)' }}>
          <div style={{ fontSize:32, opacity:.15 }}>👤</div>
          <div style={{ fontSize:12, fontWeight:600, color:'var(--t3)' }}>Select a staff member to edit</div>
        </div>
      )}

      {/* ── Add staff modal ───────────────────────────────────── */}
      {showAdd && (
        <div className="modal-back" onClick={e=>e.target===e.currentTarget&&setShowAdd(false)}>
          <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:18, width:'100%', maxWidth:420, padding:22, boxShadow:'var(--sh3)' }}>
            <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)', marginBottom:14 }}>Add staff member</div>
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              <div>
                <label style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:5, display:'block' }}>Full name</label>
                <input style={inp} value={newForm.name} onChange={e=>setNewForm(f=>({...f,name:e.target.value}))} placeholder="e.g. Jane Smith" autoFocus/>
              </div>
              <div>
                <label style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:5, display:'block' }}>Role</label>
                <div style={{ display:'flex', gap:5, flexWrap:'wrap' }}>
                  {ROLES.map(r=>(
                    <button key={r} onClick={()=>setNewForm(f=>({...f,role:r,permissions:ROLE_DEFAULTS[r]||[]}))} style={{ padding:'5px 12px', borderRadius:10, cursor:'pointer', fontFamily:'inherit', fontSize:12, fontWeight:newForm.role===r?700:400, border:`1.5px solid ${newForm.role===r?ROLE_COLORS[r]:'var(--bdr)'}`, background:newForm.role===r?ROLE_COLORS[r]+'22':'var(--bg3)', color:newForm.role===r?ROLE_COLORS[r]:'var(--t2)' }}>{r}</button>
                  ))}
                </div>
              </div>
              <div>
                <label style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:5, display:'block' }}>PIN (4 digits)</label>
                <input style={{...inp, borderColor:newForm.pin.length===4&&isPinTaken(newForm.pin,null)?'var(--red)':undefined}} type="password" maxLength={4} inputMode="numeric" value={newForm.pin} onChange={e=>setNewForm(f=>({...f,pin:e.target.value.replace(/\D/g,'').slice(0,4)}))} placeholder="0000"/>
                {newForm.pin.length===4 && isPinTaken(newForm.pin, null) && (
                  <div style={{ fontSize:10, color:'var(--red)', fontWeight:600, marginTop:3 }}>PIN already used by {getPinOwner(newForm.pin, null)?.name || 'another staff member'}</div>
                )}
              </div>
              <div>
                <label style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:5, display:'block' }}>Colour</label>
                <div style={{ display:'flex', gap:4 }}>
                  {['#3b82f6','#e8a020','#22c55e','#a855f7','#ef4444','#f97316','#22d3ee','#ec4899'].map(c=>(
                    <button key={c} onClick={()=>setNewForm(f=>({...f,color:c}))} style={{ width:24,height:24,borderRadius:'50%',background:c,border:'none',cursor:'pointer',outline:newForm.color===c?'2px solid var(--t1)':'none',outlineOffset:2 }}/>
                  ))}
                </div>
              </div>
            </div>
            <div style={{ display:'flex', gap:8, marginTop:16 }}>
              <button onClick={()=>setShowAdd(false)} style={{ flex:1, padding:'9px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:13 }}>Cancel</button>
              <button onClick={addMember} disabled={!newForm.name.trim()||(newForm.pin.length===4&&isPinTaken(newForm.pin,null))} style={{ flex:2, padding:'9px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:14, fontWeight:800, opacity:(newForm.name.trim()&&!(newForm.pin.length===4&&isPinTaken(newForm.pin,null)))?1:.4 }}>Add staff member</button>
            </div>
          </div>
        </div>
      )}

      {/* v5.5.17: Grant back-office access modal */}
      {showGrantBO && (
        <div className="modal-back" onClick={e=>e.target===e.currentTarget&&setShowGrantBO(null)}>
          <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:18, width:'100%', maxWidth:460, maxHeight:'92vh', overflowY:'auto', padding:22, boxShadow:'var(--sh3)' }}>
            <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)', marginBottom:6 }}>Grant back-office access</div>
            <div style={{ fontSize:11, color:'var(--t3)', marginBottom:14 }}>
              Make an email and password for {staffMembers.find(s=>s.id===showGrantBO)?.name} to sign in to Back Office.
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              <div>
                <label style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:5, display:'block' }}>Email *</label>
                <input style={inp} type="email" value={grantForm.email} onChange={e=>setGrantForm(f=>({...f,email:e.target.value}))} placeholder="staff@example.com" autoFocus/>
              </div>
              <div>
                <label style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:5, display:'block' }}>Password *</label>
                <input style={inp} type="password" value={grantForm.password} onChange={e=>setGrantForm(f=>({...f,password:e.target.value}))} placeholder={`Min ${MIN_PASSWORD_LENGTH} characters`}/>
              </div>
              <div>
                <label style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:5, display:'block' }}>Confirm password *</label>
                <input style={inp} type="password" value={grantForm.confirmPassword} onChange={e=>setGrantForm(f=>({...f,confirmPassword:e.target.value}))} placeholder="Repeat password"/>
              </div>
              {/* 8 Oct 2026: what the new login can open. An owner (or ServOS) chooses; anybody
                  else is told plainly what it will be. A limited person passes on their own list. */}
              <div data-testid="bo-grant-sections">
                <label style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:5, display:'block' }}>What can they open?</label>
                {iSetSections && sectionsInstalled ? (
                  <SectionPicker ticks={grantTicks} onChange={setGrantTicks} disabled={grantBusy}/>
                ) : (
                  <div style={{ fontSize:12, color:'var(--t2)', lineHeight:1.5 }}>
                    {mySections !== null
                      ? `The same as you: ${describeSections(mySections)}.`
                      : iSetSections
                        ? 'Everything. Choosing what a login can open needs a database update.'
                        : 'Everything. Only the owner can limit a login.'}
                  </div>
                )}
              </div>
              {grantError && (
                <div style={{ padding:'8px 12px', background:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:8, color:'#fca5a5', fontSize:12 }}>
                  {grantError}
                </div>
              )}
              <div style={{ fontSize:10, color:'var(--t4)', lineHeight:1.5, padding:'8px 0' }}>
                The staff member can change this password later. They'll sign in at the same back-office URL you're using now.
              </div>
            </div>
            <div style={{ display:'flex', gap:8, marginTop:16 }}>
              <button onClick={()=>setShowGrantBO(null)} disabled={grantBusy} style={{ flex:1, padding:'9px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:13 }}>Cancel</button>
              <button onClick={()=>grantBOAccess(showGrantBO)} disabled={grantBusy} style={{ flex:2, padding:'9px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:14, fontWeight:800, opacity:grantBusy?.6:1 }}>{grantBusy?'Creating…':'Grant access →'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Set PIN modal ─────────────────────────────────────── */}
      {showPin && (
        <div className="modal-back" onClick={e=>e.target===e.currentTarget&&setShowPin(null)}>
          <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:18, width:'100%', maxWidth:320, padding:22, boxShadow:'var(--sh3)' }}>
            <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)', marginBottom:6 }}>Set PIN</div>
            <div style={{ fontSize:11, color:'var(--t3)', marginBottom:14 }}>Enter a 4-digit PIN for {staffMembers.find(s=>s.id===showPin)?.name}. Each staff member must have a unique PIN.</div>
            <div style={{ display:'flex', gap:8, justifyContent:'center', marginBottom:16 }}>
              {Array(4).fill(null).map((_,i)=>(
                <div key={i} style={{ width:44, height:54, borderRadius:10, border:`2px solid ${i<pinInput.length?(isPinTaken(pinInput,showPin)?'var(--red)':'var(--acc)'):'var(--bdr2)'}`, background:i<pinInput.length?(isPinTaken(pinInput,showPin)?'var(--red-d)':'var(--acc-d)'):'var(--bg3)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:22, fontWeight:800, color:isPinTaken(pinInput,showPin)?'var(--red)':'var(--acc)' }}>
                  {i<pinInput.length?'●':''}
                </div>
              ))}
            </div>
            {/* Duplicate PIN warning */}
            {pinInput.length===4 && isPinTaken(pinInput,showPin) && (
              <div style={{ padding:'6px 12px', background:'var(--red-d)', border:'1px solid var(--red-b)', borderRadius:8, marginBottom:10, fontSize:11, color:'var(--red)', fontWeight:600, textAlign:'center' }}>
                This PIN is already used by {getPinOwner(pinInput,showPin)?.name || 'another staff member'}
              </div>
            )}
            {/* Numpad */}
            <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:8, marginBottom:12 }}>
              {[1,2,3,4,5,6,7,8,9,'',0,'⌫'].map((k,i)=>(
                <button key={i} onClick={()=>{
                  if (k==='⌫') { setPinInput(p=>p.slice(0,-1)); setPinError(''); }
                  else if (k!=='' && pinInput.length<4) setPinInput(p=>p+k);
                }} style={{ height:48, borderRadius:11, cursor:k===''?'default':'pointer', fontFamily:'inherit', background:k===''?'transparent':'var(--bg3)', border:k===''?'none':'1px solid var(--bdr2)', color:k==='⌫'?'var(--red)':'var(--t1)', fontSize:18, fontWeight:700, opacity:k===''?.3:1 }}>{k}</button>
              ))}
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={()=>{setShowPin(null);setPinInput('');setPinError('');}} style={{ flex:1, padding:'9px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:13 }}>Cancel</button>
              <button onClick={async ()=>{ if(pinInput.length===4 && !isPinTaken(pinInput,showPin)){ const id=showPin, pin=pinInput; setShowPin(null); setPinInput(''); setPinError(''); if (await save(id,{pin})) showToast('PIN updated','success'); } }} disabled={pinInput.length!==4||isPinTaken(pinInput,showPin)} style={{ flex:2, padding:'9px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:isPinTaken(pinInput,showPin)?'var(--red)':'var(--acc)', border:'none', color:'#0b0c10', fontSize:14, fontWeight:800, opacity:(pinInput.length===4&&!isPinTaken(pinInput,showPin))?1:.4 }}>Save PIN</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
