import { useState, useEffect } from 'react';
import { useStore } from '../../store';
import { supabase, isMock } from '../../lib/supabase';
import { nfcAvailable, scanCardOnce } from '../../lib/nfc';

const ROLES = ['Manager','Server','Bartender','Cashier','Kitchen','Host'];
const ROLE_COLORS = { Manager:'#e8a020', Server:'#3b82f6', Bartender:'#22c55e', Cashier:'#a855f7', Kitchen:'#ef4444', Host:'#7C5CFF' };
const PERM_GROUPS = [
  { group:'Orders',     perms:[{id:'void',label:'Void items'},{id:'discount',label:'Apply discounts'},{id:'priceOverride',label:'Override price'}] },
  { group:'Payments',   perms:[{id:'refund',label:'Process refunds'},{id:'cashup',label:'Cash up drawer'},{id:'openDrawer',label:'Open cash drawer'}] },
  { group:'Management', perms:[{id:'reports',label:'View reports'},{id:'eod',label:'End of day close'},{id:'menu86',label:'86 menu items'},{id:'staff',label:'Manage staff'}] },
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

export default function StaffManager() {
  const { staffMembers, addStaffMember, updateStaffMember, removeStaffMember, markBOChange, showToast } = useStore();

  // v5.5.17: BO-access state. Each staff member can optionally be linked to
  // an auth user (user_profiles.id stored in staff_members.auth_user_id).
  // The map below caches the auth user's profile so the detail panel can
  // show email + bo_access flag without re-querying on every render.
  // Keyed by staff_member.id; value is { authUserId, email, boAccess } | null.
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
        .select('id, name, role, pin, color, initials, permissions, active, auth_user_id, nfc_card_id')
        .eq('location_id', locationId).eq('active', true);
      if (error && /auth_user_id|column.*not.*exist|PGRST204/i.test(error.message || '')) {
        console.warn('[StaffManager] auth_user_id column missing — falling back. Run supabase/migrations/20260430_staff_auth_link.sql to enable BO access linking.');
        ({ data: rows } = await supabase
          .from('staff_members')
          .select('id, name, role, pin, color, initials, permissions, active')
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
        })) });
        // Bulk-fetch profiles for any linked auth users
        const linkedIds = rows.map(r => r.auth_user_id).filter(Boolean);
        if (linkedIds.length > 0) {
          let { data: profiles, error: profErr } = await supabase
            .from('user_profiles')
            .select('id, email, bo_access')
            .in('id', linkedIds);
          // Defensive — fall back without bo_access if column missing
          if (profErr && /bo_access|column.*not.*exist|PGRST204/i.test(profErr.message || '')) {
            ({ data: profiles } = await supabase
              .from('user_profiles')
              .select('id, email')
              .in('id', linkedIds));
          }
          const linkMap = {};
          rows.forEach(r => {
            if (!r.auth_user_id) return;
            const p = (profiles || []).find(x => x.id === r.auth_user_id);
            if (p) linkMap[r.id] = { authUserId: p.id, email: p.email, boAccess: p.bo_access !== false };
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

  const save = (id, patch) => {
    updateStaffMember(id, patch);
    markBOChange();

    // Persist patch to Supabase (real mode only). Fire-and-forget but
    // surface silent 0-row updates (v4.4.1 lesson) via a toast.
    if (isMock) return;
    if (String(id).startsWith('s-')) {
      // In-memory row that was never inserted to Supabase (addMember fallback
      // path when locationId was unavailable). Nothing to update server-side.
      return;
    }
    (async () => {
      try {
        const { data, error } = await supabase
          .from('staff_members')
          .update(patch)
          .eq('id', id)
          .select('id');
        if (error) throw error;
        if (!data || data.length === 0) {
          console.warn('[StaffManager] save: 0 rows updated for id', id, 'patch', patch);
          showToast('Save did not land — row not found on server', 'error');
        }
      } catch (e) {
        console.error('[StaffManager] save failed:', e.message, 'patch', patch);
        showToast(`Save failed: ${e.message}`, 'error');
      }
    })();
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
    save(id, { nfc_card_id: r.cardId });
    showToast('Card assigned', 'success');
  };

  const addMember = () => {
    if (!newForm.name.trim()) return;
    // v5.5.292: Block duplicate PINs
    if (newForm.pin && newForm.pin.length === 4 && isPinTaken(newForm.pin, null)) {
      showToast(`PIN already used by ${getPinOwner(newForm.pin, null)?.name || 'another staff member'}`, 'error');
      return;
    }
    const perms = newForm.permissions.length ? newForm.permissions : ROLE_DEFAULTS[newForm.role] || [];
    const member = { ...newForm, name:newForm.name.trim(), permissions:perms, initials:initials(newForm.name) };
    addStaffMember(member);
    // Save to Supabase
    if (!isMock) {
      (async () => {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return;
        const { data: profile } = await supabase.from('user_profiles').select('org_id, location_id').eq('id', user.id).single();
        // Get location_id — from profile, or find first location in their org
        let locationId = profile?.location_id;
        if (!locationId && profile?.org_id) {
          const { data: locs } = await supabase.from('locations').select('id').eq('org_id', profile.org_id).limit(1);
          locationId = locs?.[0]?.id;
          // Also update user profile so we don't have to look this up again
          if (locationId) await supabase.from('user_profiles').update({ location_id: locationId }).eq('id', user.id);
        }
        if (locationId) {
          const { error } = await supabase.from('staff_members').insert({
            location_id: locationId, org_id: profile?.org_id,
            name: member.name, role: member.role, pin: member.pin,
            color: member.color || '#3b82f6', initials: member.initials,
            permissions: member.permissions || [],
            active: true,
          });
          if (error) console.error('Staff save failed:', error.message);
        } else {
          console.warn('Cannot save staff — no location_id found for this user');
        }
      })();
    }
    markBOChange();
    showToast(`${newForm.name} added`, 'success');
    setShowAdd(false);
    setNewForm({ name:'', role:'Server', color:'#3b82f6', pin:'', permissions:[] });
  };

  const deleteMember = (id) => {
    removeStaffMember(id);
    if (!isMock && !String(id).startsWith('s-')) {
      supabase.from('staff_members').update({ active: false }).eq('id', id);
    }
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
    if (grantForm.password.length < 8) { setGrantError('Password must be at least 8 characters'); return; }
    if (grantForm.password !== grantForm.confirmPassword) { setGrantError('Passwords do not match'); return; }
    if (isMock) { setGrantError('Mock mode — auth user creation not available'); return; }

    setGrantBusy(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      const { data: meProfile } = await supabase.from('user_profiles').select('org_id, location_id').eq('id', user.id).single();
      const orgId = meProfile?.org_id;
      const locId = meProfile?.location_id;
      if (!orgId) { setGrantError('Your account is not linked to an org — cannot create users'); setGrantBusy(false); return; }

      const auth = JSON.parse(localStorage.getItem('rpos-auth') || 'null');
      const member = staffMembers.find(s => s.id === staffId);
      const resp = await fetch('https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/create-user', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${auth?.access_token}` },
        body: JSON.stringify({
          email: grantForm.email.trim(),
          password: grantForm.password,
          fullName: member?.name || '',
          orgId,
          locationId: locId || null,
          role: 'manager',
        }),
      });
      const result = await resp.json();
      if (result.error) { setGrantError(result.error); setGrantBusy(false); return; }
      const newUserId = result.id;
      if (!newUserId) { setGrantError('Edge function did not return a user id'); setGrantBusy(false); return; }

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

      // Update local state
      setAuthLinks(prev => ({ ...prev, [staffId]: { authUserId: newUserId, email: grantForm.email.trim(), boAccess: true } }));
      useStore.setState({
        staffMembers: useStore.getState().staffMembers.map(s =>
          s.id === staffId ? { ...s, authUserId: newUserId } : s
        ),
      });

      setShowGrantBO(null);
      setGrantForm({ email:'', password:'', confirmPassword:'' });
      setGrantBusy(false);
      showToast(`✓ Back-office access granted — ${grantForm.email.trim()} can now sign in`, 'success');
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
                value={sel.name} onChange={e=>save(sel.id,{name:e.target.value,initials:initials(e.target.value)})}/>
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

            {/* NFC staff card — tap-to-sign-in. Assign by tapping a card on a till (reader present);
                the card then works on ANY till. PIN stays as the fallback. */}
            <div style={{ marginBottom:20, padding:'12px 14px', background:'var(--bg2)', borderRadius:12, border:'1px solid var(--bdr)' }}>
              <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:12, fontWeight:700, color:'var(--t1)', marginBottom:2 }}>NFC card</div>
                  <div style={{ fontSize:10, color:'var(--t3)' }}>Tap a card/fob to sign in — works on any till. {nfcAvailable() ? 'Tap a card to assign it.' : 'Open Back Office on a till with a reader to assign cards.'}</div>
                </div>
                {sel.nfcCardId ? (
                  <div style={{ display:'flex', gap:6, alignItems:'center' }}>
                    <span style={{ fontSize:12, color:'var(--grn)', fontWeight:700 }}>✓ Card set</span>
                    {nfcAvailable() && <button onClick={()=>scanCard(sel.id)} disabled={scanningCard} style={{ padding:'4px 10px', borderRadius:7, cursor:scanningCard?'wait':'pointer', fontFamily:'inherit', background:'var(--bg3)', border:'1px solid var(--bdr2)', color:'var(--t2)', fontSize:11, fontWeight:600 }}>{scanningCard?'Tap card…':'Replace'}</button>}
                    <button onClick={()=>save(sel.id,{nfc_card_id:null})} style={{ padding:'4px 10px', borderRadius:7, cursor:'pointer', fontFamily:'inherit', background:'var(--red-d)', border:'1px solid var(--red-b)', color:'var(--red)', fontSize:11, fontWeight:600 }}>Remove</button>
                  </div>
                ) : (
                  nfcAvailable()
                    ? <button onClick={()=>scanCard(sel.id)} disabled={scanningCard} style={{ padding:'6px 14px', borderRadius:8, cursor:scanningCard?'wait':'pointer', fontFamily:'inherit', background:'var(--acc)', border:'none', color:'#0b0c10', fontSize:12, fontWeight:700 }}>{scanningCard?'Tap card now…':'Scan card'}</button>
                    : <span style={{ fontSize:11, color:'var(--t4)' }}>No reader here</span>
                )}
              </div>
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
                        <div style={{ fontSize:10, color:'var(--t3)' }}>Give this staff member email + password to sign in to the back office for reports, menu, settings, etc.</div>
                      </div>
                      <button
                        onClick={()=>{ setShowGrantBO(sel.id); setGrantForm({ email:'', password:'', confirmPassword:'' }); setGrantError(''); }}
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
                    </div>
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
          <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr2)', borderRadius:18, width:'100%', maxWidth:420, padding:22, boxShadow:'var(--sh3)' }}>
            <div style={{ fontSize:15, fontWeight:800, color:'var(--t1)', marginBottom:6 }}>Grant back-office access</div>
            <div style={{ fontSize:11, color:'var(--t3)', marginBottom:14 }}>
              Create sign-in credentials for {staffMembers.find(s=>s.id===showGrantBO)?.name}.
              They'll be able to sign in to the back office to view reports, edit the menu, etc.
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
              <div>
                <label style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:5, display:'block' }}>Email *</label>
                <input style={inp} type="email" value={grantForm.email} onChange={e=>setGrantForm(f=>({...f,email:e.target.value}))} placeholder="staff@example.com" autoFocus/>
              </div>
              <div>
                <label style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:5, display:'block' }}>Password *</label>
                <input style={inp} type="password" value={grantForm.password} onChange={e=>setGrantForm(f=>({...f,password:e.target.value}))} placeholder="Min 8 characters"/>
              </div>
              <div>
                <label style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.08em', marginBottom:5, display:'block' }}>Confirm password *</label>
                <input style={inp} type="password" value={grantForm.confirmPassword} onChange={e=>setGrantForm(f=>({...f,confirmPassword:e.target.value}))} placeholder="Repeat password"/>
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
              <button onClick={()=>{ if(pinInput.length===4 && !isPinTaken(pinInput,showPin)){ save(showPin,{pin:pinInput}); showToast('PIN updated','success'); setShowPin(null); setPinInput(''); setPinError(''); } }} disabled={pinInput.length!==4||isPinTaken(pinInput,showPin)} style={{ flex:2, padding:'9px', borderRadius:9, cursor:'pointer', fontFamily:'inherit', background:isPinTaken(pinInput,showPin)?'var(--red)':'var(--acc)', border:'none', color:'#0b0c10', fontSize:14, fontWeight:800, opacity:(pinInput.length===4&&!isPinTaken(pinInput,showPin))?1:.4 }}>Save PIN</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
