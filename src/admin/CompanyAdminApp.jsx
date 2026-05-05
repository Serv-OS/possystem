import { useState, useEffect } from 'react';
import { VERSION } from '../lib/version';
import BOLogin from '../backoffice/BOLogin';
import AdminBillingManager from './sections/AdminBillingManager';
import AdminStripeTest from './sections/AdminStripeTest';

const S = {
  shell: { display:'flex', height:'100vh', fontFamily:'inherit', background:'#0f1117', color:'#e2e8f0' },
  sidebar: { width:220, background:'#1a1d27', borderRight:'1px solid #2d3148', display:'flex', flexDirection:'column', padding:'24px 0' },
  brand: { padding:'0 20px 24px', borderBottom:'1px solid #2d3148', marginBottom:16 },
  brandBadge: { width:36, height:36, borderRadius:10, background:'#6366f1', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18, fontWeight:800, color:'#fff', marginBottom:10 },
  main: { flex:1, overflowY:'auto', padding:'32px 40px' },
  h1: { fontSize:22, fontWeight:800, color:'#f1f5f9', marginBottom:4 },
  sub: { fontSize:13, color:'#64748b', marginBottom:28 },
  card: { background:'#1a1d27', border:'1px solid #2d3148', borderRadius:12, padding:24, marginBottom:20 },
  label: { fontSize:12, fontWeight:600, color:'#94a3b8', marginBottom:5, display:'block' },
  input: { width:'100%', padding:'9px 12px', borderRadius:8, border:'1px solid #2d3148', background:'#0f1117', color:'#f1f5f9', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box' },
  row: { display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 },
  row3: { display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:12 },
  btn: { padding:'8px 16px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:'inherit' },
  btnPrimary: { background:'#6366f1', color:'#fff' },
  btnGhost: { background:'transparent', color:'#94a3b8', border:'1px solid #2d3148' },
  btnDanger: { background:'transparent', color:'#ef4444', border:'1px solid #7f1d1d' },
  badge: { padding:'3px 8px', borderRadius:20, fontSize:11, fontWeight:700 },
};

async function sbFetch(path, opts = {}) {
  const auth = JSON.parse(localStorage.getItem('rpos-auth') || 'null');
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const url = import.meta.env.VITE_SUPABASE_URL;
  if (!url || !key) return { data: null, error: { message: 'Not configured' } };
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${auth?.access_token || key}`,
      'Content-Type': 'application/json',
      'Prefer': opts.prefer !== undefined ? opts.prefer : 'return=representation',
    },
    method: opts.method || 'GET',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
  if (!res.ok) return { data: null, error: { message: data?.message || data?.details || res.statusText } };
  return { data, error: null };
}

export default function CompanyAdminApp() {
  const [authUser, setAuthUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);

  useEffect(() => {
    const auth = JSON.parse(localStorage.getItem('rpos-auth') || 'null');
    if (auth?.user && auth?.expires_at && Date.now() < auth.expires_at * 1000) {
      setAuthUser(auth.user);
      // Verify role from DB — don't trust localStorage alone
      sbFetch(`user_profiles?id=eq.${auth.user.id}&select=role`)
        .then(({ data }) => {
          const role = Array.isArray(data) ? data[0]?.role : data?.role;
          setIsSuperAdmin(role === 'super_admin');
          setAuthChecked(true);
        })
        .catch(() => setAuthChecked(true));
    } else {
      setAuthChecked(true);
    }
  }, []);

  if (!authChecked) return <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'#0f1117', color:'#64748b', fontSize:13 }}>Loading…</div>;
  if (!authUser) return <BOLogin onLogin={(u) => { setAuthUser(u); window.location.reload(); }} />;
  if (!isSuperAdmin) return (
    <div style={{ minHeight:'100vh', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', background:'#0f1117', color:'#64748b', gap:16 }}>
      <div style={{ fontSize:32 }}>🔒</div>
      <div style={{ fontSize:16, fontWeight:700, color:'#f1f5f9' }}>Access denied</div>
      <div style={{ fontSize:13 }}>This area requires super_admin access.</div>
      <button onClick={() => { localStorage.removeItem('rpos-auth'); window.location.reload(); }} style={{ marginTop:8, padding:'8px 20px', borderRadius:8, border:'1px solid #2d3148', background:'transparent', color:'#94a3b8', cursor:'pointer', fontFamily:'inherit', fontSize:13 }}>Sign out</button>
    </div>
  );
  return <AdminPanel authUser={authUser} />;
}

function AdminPanel({ authUser }) {
  const [section, setSection] = useState('orgs');
  const [orgs, setOrgs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedOrg, setSelectedOrg] = useState(null);
  const [locations, setLocations] = useState([]);
  const [users, setUsers] = useState([]);
  // v5.5.14: super_admin can grant any user access to any location/org. The
  // pre-v5.5.14 picker only showed users whose user_profiles.org_id matched
  // the currently-selected org, so a brand-new org appeared to have NO
  // available users to add — even though the super_admin themselves and
  // every other platform user could legitimately be granted access.
  // Load ALL users platform-wide and search/filter client-side.
  const [allUsers, setAllUsers] = useState([]);
  const [userSearch, setUserSearch] = useState('');
  const [editUsersFor, setEditUsersFor] = useState(null);
  const [editingOrg, setEditingOrg] = useState(null);   // { id, name }
  const [editingLoc, setEditingLoc] = useState(null);   // { id, name }
  const [form, setForm] = useState({});
  const [working, setWorking] = useState(false);
  const [msg, setMsg] = useState({ type:'', text:'' });

  const loadAllUsers = async () => {
    // Fetches every user_profiles row across all orgs. Only callable from
    // CompanyAdminApp which is gated to super_admin role. RLS policy on
    // user_profiles must allow super_admin to read all rows — otherwise
    // this returns only the calling user's own row and the picker is empty.
    try {
      const { data } = await sbFetch(`user_profiles?select=id,email,full_name,org_id,role,location_id,user_locations(location_id)&order=email.asc`);
      setAllUsers(Array.isArray(data) ? data : []);
    } catch { setAllUsers([]); }
  };

  const loadOrgs = async () => {
    setLoading(true);
    try {
      const { data } = await sbFetch('organisations?select=*&order=created_at.desc');
      setOrgs(Array.isArray(data) ? data : []);
    } catch { setOrgs([]); }
    setLoading(false);
  };

  const loadLocations = async (orgId) => {
    const { data } = await sbFetch(`locations?select=*,subscriptions(plan,gmv_this_month),location_features(feature,price_per_month)&org_id=eq.${orgId}&order=created_at.asc`);
    setLocations(Array.isArray(data) ? data : []);
  };

  const loadUsers = async (orgId) => {
    const { data } = await sbFetch(`user_profiles?select=*,user_locations(location_id)&org_id=eq.${orgId}&order=created_at.asc`);
    setUsers(Array.isArray(data) ? data : []);
  };

  // v5.5.14: kick off initial loads after function declarations to keep the
  // lint clean (no temporal-dead-zone reference inside useEffect callback).
  useEffect(() => { loadOrgs(); loadAllUsers(); }, []);

  const selectOrg = async (org) => {
    setSelectedOrg(org);
    setSection('org-detail');
    setMsg({ type:'', text:'' });
    setEditUsersFor(null);
    setEditingLoc(null);
    await Promise.all([loadLocations(org.id), loadUsers(org.id)]);
  };

  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));
  const ok = t => setMsg({ type:'ok', text:t });
  const err = t => setMsg({ type:'err', text:t });

  // ── Rename org ──────────────────────────────────────────────────────────────
  const saveRenameOrg = async () => {
    if (!editingOrg?.name?.trim()) return;
    await sbFetch(`organisations?id=eq.${editingOrg.id}`, { method:'PATCH', body:{ name: editingOrg.name.trim() }, prefer:'' });
    setEditingOrg(null);
    await loadOrgs();
    if (selectedOrg?.id === editingOrg.id) setSelectedOrg(o => ({ ...o, name: editingOrg.name.trim() }));
    ok('✓ Organisation renamed');
  };

  // ── Delete org ───────────────────────────────────────────────────────────────
  const deleteOrg = async (org) => {
    if (!confirm(`Delete "${org.name}" and ALL its locations, devices, menus and data? This cannot be undone.`)) return;
    setWorking(true);
    setMsg({ type:'', text:'' });
    try {
      // Get all locations for this org
      const { data: locs } = await sbFetch(`locations?org_id=eq.${org.id}&select=id`);
      const locIds = (locs || []).map(l => l.id);
      // Delete location data in order
      for (const locId of locIds) {
        await sbFetch(`kds_tickets?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
        await sbFetch(`closed_checks?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
        await sbFetch(`config_pushes?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
        await sbFetch(`devices?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
        await sbFetch(`staff_members?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
        await sbFetch(`floor_tables?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
        await sbFetch(`menu_items?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
        await sbFetch(`menu_categories?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
        await sbFetch(`menus?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
        await sbFetch(`sections?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
        await sbFetch(`subscriptions?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
        await sbFetch(`location_features?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
        await sbFetch(`eighty_six?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
      }
      // Delete user_locations and user_profiles for this org
      const { data: ups } = await sbFetch(`user_profiles?org_id=eq.${org.id}&select=id`);
      for (const up of ups || []) {
        await sbFetch(`user_locations?user_id=eq.${up.id}`, { method:'DELETE', prefer:'' });
      }
      await sbFetch(`user_profiles?org_id=eq.${org.id}`, { method:'DELETE', prefer:'' });
      // Finally delete locations and org
      if (locIds.length) await sbFetch(`locations?org_id=eq.${org.id}`, { method:'DELETE', prefer:'' });
      await sbFetch(`organisations?id=eq.${org.id}`, { method:'DELETE', prefer:'' });
      if (selectedOrg?.id === org.id) { setSelectedOrg(null); setSection('orgs'); }
      await loadOrgs();
      ok(`✓ "${org.name}" and all its data permanently deleted`);
    } catch(e) { err('Delete failed: ' + e.message); }
    setWorking(false);
  };

  // ── Rename location ──────────────────────────────────────────────────────────
  const saveRenameLocation = async () => {
    if (!editingLoc?.name?.trim()) return;
    await sbFetch(`locations?id=eq.${editingLoc.id}`, { method:'PATCH', body:{ name: editingLoc.name.trim() }, prefer:'' });
    setEditingLoc(null);
    await loadLocations(selectedOrg.id);
    ok('✓ Location renamed');
  };

  // ── Delete location ──────────────────────────────────────────────────────────
  const deleteLocation = async (loc) => {
    if (!confirm(`Delete "${loc.name}" and ALL its devices, menus, floor plan and data? This cannot be undone.`)) return;
    setWorking(true);
    setMsg({ type:'', text:'' });
    try {
      const locId = loc.id;
      await sbFetch(`kds_tickets?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
      await sbFetch(`closed_checks?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
      await sbFetch(`config_pushes?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
      await sbFetch(`devices?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
      await sbFetch(`staff_members?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
      await sbFetch(`floor_tables?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
      await sbFetch(`menu_items?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
      await sbFetch(`menu_categories?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
      await sbFetch(`menus?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
      await sbFetch(`sections?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
      await sbFetch(`subscriptions?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
      await sbFetch(`location_features?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
      await sbFetch(`eighty_six?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
      // Remove user_locations links but keep user_profiles
      await sbFetch(`user_locations?location_id=eq.${locId}`, { method:'DELETE', prefer:'' });
      // Null out primary location_id on any user who had this as primary
      await sbFetch(`user_profiles?location_id=eq.${locId}`, { method:'PATCH', body:{ location_id: null }, prefer:'' });
      await sbFetch(`locations?id=eq.${locId}`, { method:'DELETE', prefer:'' });
      await loadLocations(selectedOrg.id);
      await loadUsers(selectedOrg.id);
      ok(`✓ "${loc.name}" and all its data permanently deleted`);
    } catch(e) { err('Delete failed: ' + e.message); }
    setWorking(false);
  };

  // ── Create org ───────────────────────────────────────────────────────────────
  const createOrg = async () => {
    if (!form.name?.trim()) return err('Name required');
    setWorking(true); setMsg({ type:'', text:'' });
    const slug = (form.slug || form.name).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
    const { data, error:e } = await sbFetch('organisations', { method:'POST', body:{ name:form.name.trim(), slug, status:'active' } });
    setWorking(false);
    if (e) return err(e.message);
    const org = Array.isArray(data) ? data[0] : data;
    ok(`✓ "${org.name}" created`);
    setForm({});
    await loadOrgs();
    await selectOrg(org);
  };

  // ── Create location ──────────────────────────────────────────────────────────
  const createLocation = async () => {
    if (!form.locName?.trim()) return err('Name required');
    setWorking(true); setMsg({ type:'', text:'' });
    const { data, error:e } = await sbFetch('locations', { method:'POST', body:{
      org_id: selectedOrg.id, name: form.locName.trim(),
      address: form.locAddress || '', timezone: form.locTz || 'Europe/London',
      currency: form.locCurrency || 'GBP', status: 'active',
    }});
    const loc = Array.isArray(data) ? data[0] : data;
    if (e || !loc) { setWorking(false); return err(e?.message || 'Failed'); }
    const maxDevices = parseInt(form.maxDevices) || 3;
    await sbFetch('subscriptions', { method:'POST', body:{ org_id:selectedOrg.id, location_id:loc.id, plan:'free', gmv_this_month:0, billing_period_start:new Date().toISOString().slice(0,10) } });
    await sbFetch('location_features', { method:'POST', body:{ location_id:loc.id, feature:'max_devices', enabled:true, price_per_month:maxDevices } });
    setWorking(false);
    ok(`✓ "${loc.name}" created`);
    setForm(p => ({ ...p, locName:'', locAddress:'', maxDevices:'' }));
    setSection('org-detail');
    await loadLocations(selectedOrg.id);
  };

  // ── Create user ──────────────────────────────────────────────────────────────
  const createUser = async () => {
    if (!form.inviteEmail?.trim()) return err('Email required');
    if (!form.invitePassword?.trim() || form.invitePassword.length < 8) return err('Password min 8 chars');
    setWorking(true); setMsg({ type:'', text:'' });
    const auth = JSON.parse(localStorage.getItem('rpos-auth') || 'null');
    try {
      const resp = await fetch('https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/create-user', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${auth?.access_token}` },
        body: JSON.stringify({ email:form.inviteEmail.trim(), password:form.invitePassword, fullName:form.inviteName||'', orgId:selectedOrg.id, locationId:form.inviteLocationId||locations[0]?.id||null, role:'owner' }),
      });
      const result = await resp.json();
      setWorking(false);
      if (result.error) return err(result.error);
      ok(`✓ User created: ${result.email}`);
      setForm(p => ({ ...p, inviteEmail:'', invitePassword:'', inviteName:'', inviteLocationId:'' }));
      setSection('org-detail');
      await Promise.all([loadUsers(selectedOrg.id), loadAllUsers()]);
    } catch(e) { setWorking(false); err(e.message); }
  };

  const toggleUserLocation = async (userId, locationId, hasAccess) => {
    if (hasAccess) {
      const { error } = await sbFetch(`user_locations?user_id=eq.${userId}&location_id=eq.${locationId}`, { method:'DELETE', prefer:'' });
      if (error) return err('Failed to remove: ' + error.message);
    } else {
      const { error } = await sbFetch('user_locations', { method:'POST', body:{ user_id:userId, location_id:locationId } });
      if (error) return err('Failed to add: ' + error.message);
      // v5.5.14: only set user_profiles.location_id if the user has none yet.
      // If they already have a primary location (most users do), don't change
      // it — that would silently relocate them away from their original org.
      // Cross-org access is correctly handled by the user_locations row alone.
      const u = allUsers.find(u => u.id === userId) || users.find(u => u.id === userId);
      if (!u?.location_id) await sbFetch(`user_profiles?id=eq.${userId}`, { method:'PATCH', body:{ location_id:locationId }, prefer:'' });
    }
    // Refresh both lists so the picker reflects the change immediately.
    await Promise.all([
      selectedOrg ? loadUsers(selectedOrg.id) : Promise.resolve(),
      loadAllUsers(),
    ]);
    ok(hasAccess ? 'Access removed' : '✓ Access granted');
  };

  // v5.5.14: usersForLocation now derives from allUsers (which super_admin
  // can fully see), not the per-org users array. A user appears in a
  // location's "users with access" list if either:
  //   - they have a user_locations row for that location, OR
  //   - their user_profiles.location_id matches (legacy single-location setup)
  const usersForLocation = (locId) => {
    const source = allUsers.length > 0 ? allUsers : users;
    return source.filter(u => u.location_id === locId || u.user_locations?.some(ul => ul.location_id === locId));
  };

  const msgBg = { ok:{ bg:'#0d2e1a', border:'#166534', color:'#86efac' }, err:{ bg:'#2d0f0f', border:'#991b1b', color:'#fca5a5' } };
  const ms = msgBg[msg.type];

  return (
    <div style={S.shell}>
      {/* ── Sidebar ── */}
      <div style={S.sidebar}>
        <div style={S.brand}>
          <div style={S.brandBadge}>R</div>
          <div style={{ fontSize:14, fontWeight:800, color:'#f1f5f9' }}>Restaurant OS</div>
          <div style={{ fontSize:11, color:'#6366f1', fontWeight:700, letterSpacing:'.06em', textTransform:'uppercase' }}>Company Admin</div>
        </div>
        {[
          { id:'orgs', label:'All organisations', icon:'🏢' },
          { id:'new-org', label:'+ New organisation' },
          { id:'billing', label:'Billing & Stripe', icon:'💳' },
          { id:'stripe-test', label:'Stripe test', icon:'🧪' },
        ].map(n => (
          <button key={n.id} onClick={() => { setSection(n.id); setMsg({ type:'', text:'' }); }}
            style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 16px', margin:'1px 8px', borderRadius:8, cursor:'pointer', fontSize:13,
              fontWeight: section===n.id ? 700 : 400,
              background: section===n.id ? '#2d3148' : 'none',
              color: section===n.id ? '#f1f5f9' : '#94a3b8',
              border:'none', fontFamily:'inherit', width:'calc(100% - 16px)', textAlign:'left' }}>
            {n.icon} {n.label}
          </button>
        ))}
        {selectedOrg && (
          <button onClick={() => setSection('org-detail')}
            style={{ display:'block', width:'calc(100% - 16px)', margin:'1px 8px', textAlign:'left', padding:'6px 16px', borderRadius:8, border:'none', cursor:'pointer', fontSize:12, color:'#6366f1', background:section==='org-detail'?'#1e1a3a':'none', fontFamily:'inherit' }}>
            └ {selectedOrg.name}
          </button>
        )}
        <div style={{ flex:1 }} />
        <div style={{ padding:'0 12px' }}>
          <div style={{ fontSize:11, color:'#475569', padding:'0 6px', marginBottom:6 }}>{authUser.email}</div>
          <button onClick={() => { localStorage.removeItem('rpos-auth'); window.location.reload(); }} style={{ ...S.btn, ...S.btnGhost, width:'100%', fontSize:12 }}>Sign out</button>
          <button onClick={() => { localStorage.removeItem('rpos-device-mode'); window.location.href='/'; }} style={{ width:'100%', padding:'6px', background:'none', border:'none', cursor:'pointer', fontSize:11, color:'#475569', marginTop:4, fontFamily:'inherit' }}>← Switch device mode</button>
          <div style={{ fontSize:10, color:'#334155', textAlign:'center', marginTop:8, fontFamily:'monospace' }}>v{VERSION}</div>
        </div>
      </div>

      {/* ── Main ── */}
      <div style={S.main}>
        {ms && msg.text && (
          <div style={{ background:ms.bg, border:`1px solid ${ms.border}`, color:ms.color, borderRadius:10, padding:'12px 16px', marginBottom:20, fontSize:13 }}>{msg.text}</div>
        )}

        {/* ── Billing & Stripe accounts ── */}
        {section === 'billing' && <AdminBillingManager authUser={authUser} />}

        {/* ── Stripe test harness ── */}
        {section === 'stripe-test' && <AdminStripeTest />}

        {/* ── Orgs list ── */}
        {section === 'orgs' && (
          <>
            <div style={S.h1}>🏢 Organisations</div>
            <div style={S.sub}>All restaurants on the platform · {orgs.length} total</div>
            <button onClick={() => setSection('new-org')} style={{ ...S.btn, ...S.btnPrimary, marginBottom:20 }}>+ New organisation</button>
            <div style={S.card}>
              {loading
                ? <div style={{ color:'#64748b', fontSize:13 }}>Loading… <button onClick={loadOrgs} style={{ ...S.btn, ...S.btnGhost, padding:'3px 10px', fontSize:11, marginLeft:8 }}>Retry</button></div>
                : orgs.length === 0
                  ? <div style={{ color:'#64748b', fontSize:13, padding:'20px 0' }}>No organisations yet</div>
                  : orgs.map(o => (
                    <div key={o.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0', borderBottom:'1px solid #2d3148' }}>
                      {editingOrg?.id === o.id ? (
                        <>
                          <input autoFocus value={editingOrg.name} onChange={e => setEditingOrg(x => ({ ...x, name:e.target.value }))}
                            onKeyDown={e => { if(e.key==='Enter') saveRenameOrg(); if(e.key==='Escape') setEditingOrg(null); }}
                            style={{ ...S.input, flex:1, maxWidth:280 }} />
                          <button onClick={saveRenameOrg} style={{ ...S.btn, ...S.btnPrimary, padding:'6px 14px', fontSize:12 }}>Save</button>
                          <button onClick={() => setEditingOrg(null)} style={{ ...S.btn, ...S.btnGhost, padding:'6px 14px', fontSize:12 }}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <div style={{ flex:1 }}>
                            <div style={{ fontSize:14, fontWeight:700, color:'#f1f5f9' }}>{o.name}</div>
                            <div style={{ fontSize:12, color:'#64748b', fontFamily:'monospace' }}>{o.slug}</div>
                          </div>
                          <span style={{ ...S.badge, background:'#0d2e1a', color:'#86efac' }}>{o.status}</span>
                          <div style={{ fontSize:12, color:'#64748b' }}>{new Date(o.created_at).toLocaleDateString('en-GB')}</div>
                          <button onClick={() => selectOrg(o)} style={{ ...S.btn, ...S.btnGhost, padding:'5px 12px', fontSize:12 }}>Manage →</button>
                          <button onClick={() => setEditingOrg({ id:o.id, name:o.name })} style={{ ...S.btn, ...S.btnGhost, padding:'5px 12px', fontSize:12 }}>✏️</button>
                          <button onClick={() => deleteOrg(o)} disabled={working} style={{ ...S.btn, ...S.btnDanger, padding:'5px 12px', fontSize:12 }}>🗑</button>
                        </>
                      )}
                    </div>
                  ))
              }
            </div>
          </>
        )}

        {/* ── New org ── */}
        {section === 'new-org' && (
          <>
            <div style={S.h1}>New Organisation</div>
            <div style={S.sub}>Create a new restaurant company on the platform</div>
            <div style={S.card}>
              <div style={S.row}>
                <div><label style={S.label}>Name *</label><input style={S.input} placeholder="e.g. Dougboy Donuts" value={form.name||''} onChange={e=>f('name',e.target.value)} /></div>
                <div><label style={S.label}>Slug (auto)</label><input style={S.input} placeholder="dougboy-donuts" value={form.slug||''} onChange={e=>f('slug',e.target.value)} /></div>
              </div>
              <div style={{ display:'flex', gap:10 }}>
                <button onClick={createOrg} disabled={working} style={{ ...S.btn, ...S.btnPrimary }}>{working?'Creating…':'Create →'}</button>
                <button onClick={() => setSection('orgs')} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
              </div>
            </div>
          </>
        )}

        {/* ── Org detail ── */}
        {['org-detail','new-location','create-user'].includes(section) && selectedOrg && (
          <>
            <div style={{ display:'flex', alignItems:'center', gap:12, marginBottom:4 }}>
              <div style={S.h1}>{selectedOrg.name}</div>
              <span style={{ ...S.badge, background:'#0d2e1a', color:'#86efac' }}>{selectedOrg.status}</span>
            </div>
            <div style={S.sub}>Manage locations and user access</div>

            {section === 'org-detail' && (
              <>
                <div style={{ display:'flex', gap:10, marginBottom:24 }}>
                  <button onClick={() => setSection('new-location')} style={{ ...S.btn, ...S.btnPrimary }}>+ Add location</button>
                  <button onClick={() => { setSection('create-user'); setMsg({type:'',text:''}); }} style={{ ...S.btn, ...S.btnGhost }}>👤 Create user</button>
                </div>

                <div style={S.card}>
                  <div style={{ fontSize:14, fontWeight:700, color:'#e2e8f0', marginBottom:20 }}>📍 Locations & User Access</div>
                  {locations.length === 0
                    ? <div style={{ color:'#64748b', fontSize:13 }}>No locations yet — add one above</div>
                    : locations.map((loc, idx) => {
                        const maxDev = loc.location_features?.find(f=>f.feature==='max_devices')?.price_per_month || 3;
                        const plan = loc.subscriptions?.[0]?.plan || 'free';
                        const gmv = loc.subscriptions?.[0]?.gmv_this_month || 0;
                        const locUsers = usersForLocation(loc.id);
                        const isEditingUsers = editUsersFor === loc.id;
                        const isEditingName = editingLoc?.id === loc.id;

                        return (
                          <div key={loc.id} style={{ paddingBottom:24, marginBottom:24, borderBottom: idx < locations.length-1 ? '1px solid #2d3148' : 'none' }}>
                            {/* Location name row */}
                            <div style={{ display:'flex', alignItems:'center', gap:10, marginBottom:10 }}>
                              {isEditingName ? (
                                <>
                                  <input autoFocus value={editingLoc.name} onChange={e => setEditingLoc(x => ({ ...x, name:e.target.value }))}
                                    onKeyDown={e => { if(e.key==='Enter') saveRenameLocation(); if(e.key==='Escape') setEditingLoc(null); }}
                                    style={{ ...S.input, flex:1, maxWidth:280, fontSize:14, fontWeight:700 }} />
                                  <button onClick={saveRenameLocation} style={{ ...S.btn, ...S.btnPrimary, padding:'5px 12px', fontSize:12 }}>Save</button>
                                  <button onClick={() => setEditingLoc(null)} style={{ ...S.btn, ...S.btnGhost, padding:'5px 12px', fontSize:12 }}>Cancel</button>
                                </>
                              ) : (
                                <>
                                  <div style={{ fontSize:15, fontWeight:700, color:'#f1f5f9' }}>{loc.name}</div>
                                  <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                                    <span style={{ ...S.badge, background:'#1e1a3a', color:'#a5b4fc' }}>{plan}</span>
                                    <span style={{ fontSize:12, color:'#64748b' }}>{maxDev} devices</span>
                                    <span style={{ fontSize:12, color:'#64748b' }}>£{parseFloat(gmv).toFixed(2)} GMV</span>
                                  </div>
                                  <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
                                    <button onClick={() => setEditingLoc({ id:loc.id, name:loc.name })} style={{ ...S.btn, ...S.btnGhost, padding:'4px 10px', fontSize:11 }}>✏️ Rename</button>
                                    <button onClick={() => deleteLocation(loc)} disabled={working} style={{ ...S.btn, ...S.btnDanger, padding:'4px 10px', fontSize:11 }}>🗑 Delete</button>
                                  </div>
                                </>
                              )}
                            </div>

                            {/* Users section */}
                            <div style={{ paddingLeft:0 }}>
                              <div style={{ fontSize:11, fontWeight:700, color:'#64748b', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:10 }}>Users with access</div>
                              {isEditingUsers ? (
                                <div style={{ background:'#0f1117', borderRadius:10, padding:16, border:'1px solid #2d3148' }}>
                                  {/* v5.5.14: search input — searches across all platform users by email or name */}
                                  <input
                                    autoFocus
                                    placeholder="Search by email or name…"
                                    value={userSearch}
                                    onChange={e => setUserSearch(e.target.value)}
                                    style={{ ...S.input, width:'100%', marginBottom:14, fontSize:13 }}
                                  />
                                  {(() => {
                                    const q = userSearch.trim().toLowerCase();
                                    const allShown = allUsers.length > 0 ? allUsers : users;
                                    const filtered = q
                                      ? allShown.filter(u =>
                                          (u.email || '').toLowerCase().includes(q) ||
                                          (u.full_name || '').toLowerCase().includes(q))
                                      : allShown;
                                    if (allShown.length === 0) {
                                      return <div style={{ fontSize:13, color:'#475569', marginBottom:12 }}>No users in the platform yet — create one first</div>;
                                    }
                                    if (filtered.length === 0) {
                                      return <div style={{ fontSize:13, color:'#475569', marginBottom:12 }}>No users match "{userSearch}"</div>;
                                    }
                                    return filtered.map(u => {
                                      const has = locUsers.some(lu => lu.id === u.id);
                                      const sameOrg = u.org_id === selectedOrg?.id;
                                      return (
                                        <label key={u.id} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12, cursor:'pointer' }}>
                                          <input type="checkbox" checked={has}
                                            onChange={() => toggleUserLocation(u.id, loc.id, has)}
                                            style={{ accentColor:'#6366f1', width:16, height:16, flexShrink:0 }}
                                          />
                                          <div style={{ flex:1, minWidth:0 }}>
                                            <div style={{ fontSize:13, fontWeight:600, color:'#e2e8f0' }}>{u.full_name || u.email}</div>
                                            <div style={{ fontSize:11, color:'#6366f1', fontFamily:'monospace' }}>{u.email || '—'}</div>
                                          </div>
                                          {!sameOrg && <span style={{ ...S.badge, background:'#2d2540', color:'#c89bff', marginLeft:'auto', fontSize:10 }}>cross-org</span>}
                                          {has && <span style={{ ...S.badge, background:'#0d2e1a', color:'#86efac', marginLeft: sameOrg ? 'auto' : 6, fontSize:10 }}>✓ Access</span>}
                                        </label>
                                      );
                                    });
                                  })()}
                                  <button onClick={() => { setEditUsersFor(null); setUserSearch(''); }} style={{ ...S.btn, ...S.btnGhost, padding:'6px 16px', fontSize:12, marginTop:4 }}>Done</button>
                                </div>
                              ) : (
                                <div style={{ display:'flex', alignItems:'center', gap:10, flexWrap:'wrap' }}>
                                  {locUsers.length === 0
                                    ? <span style={{ fontSize:13, color:'#475569' }}>No users assigned to this location</span>
                                    : locUsers.map(u => (
                                        <div key={u.id} style={{ background:'#1e1a3a', border:'1px solid #3730a3', borderRadius:8, padding:'6px 12px' }}>
                                          <div style={{ fontSize:12, fontWeight:700, color:'#e2e8f0' }}>{u.full_name || u.email}</div>
                                          <div style={{ fontSize:11, color:'#6366f1', fontFamily:'monospace' }}>{u.email}</div>
                                        </div>
                                      ))
                                  }
                                  <button onClick={() => setEditUsersFor(loc.id)} style={{ ...S.btn, ...S.btnGhost, padding:'5px 12px', fontSize:12 }}>
                                    {locUsers.length ? '✏️ Edit access' : '+ Add user'}
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })
                  }
                </div>
              </>
            )}

            {/* ── Add location form ── */}
            {section === 'new-location' && (
              <div style={S.card}>
                <div style={{ fontSize:14, fontWeight:700, color:'#e2e8f0', marginBottom:16 }}>Add location to {selectedOrg.name}</div>
                <div style={S.row}>
                  <div><label style={S.label}>Location name *</label><input style={S.input} placeholder="e.g. Oxford Street" value={form.locName||''} onChange={e=>f('locName',e.target.value)} /></div>
                  <div><label style={S.label}>Address</label><input style={S.input} placeholder="123 High St, London" value={form.locAddress||''} onChange={e=>f('locAddress',e.target.value)} /></div>
                </div>
                <div style={S.row3}>
                  <div><label style={S.label}>Timezone</label>
                    <select style={S.input} value={form.locTz||'Europe/London'} onChange={e=>f('locTz',e.target.value)}>
                      <option value="Europe/London">Europe/London</option>
                      <option value="Europe/Paris">Europe/Paris</option>
                      <option value="America/New_York">America/New_York</option>
                      <option value="Asia/Dubai">Asia/Dubai</option>
                    </select>
                  </div>
                  <div><label style={S.label}>Currency</label>
                    <select style={S.input} value={form.locCurrency||'GBP'} onChange={e=>f('locCurrency',e.target.value)}>
                      <option value="GBP">GBP £</option>
                      <option value="EUR">EUR €</option>
                      <option value="USD">USD $</option>
                      <option value="AED">AED</option>
                    </select>
                  </div>
                  <div><label style={S.label}>Max POS devices</label><input style={S.input} type="number" min="1" max="20" placeholder="3" value={form.maxDevices||''} onChange={e=>f('maxDevices',e.target.value)} /></div>
                </div>
                <div style={{ display:'flex', gap:10 }}>
                  <button onClick={createLocation} disabled={working} style={{ ...S.btn, ...S.btnPrimary }}>{working?'Creating…':'Create location →'}</button>
                  <button onClick={() => setSection('org-detail')} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
                </div>
              </div>
            )}

            {/* ── Create user form ── */}
            {section === 'create-user' && (
              <div style={S.card}>
                <div style={{ fontSize:14, fontWeight:700, color:'#e2e8f0', marginBottom:16 }}>👤 Create back-office user for {selectedOrg.name}</div>
                <div style={S.row}>
                  <div><label style={S.label}>Email *</label><input type="email" style={S.input} placeholder="owner@restaurant.com" value={form.inviteEmail||''} onChange={e=>f('inviteEmail',e.target.value)} /></div>
                  <div><label style={S.label}>Full name</label><input style={S.input} placeholder="Sarah Smith" value={form.inviteName||''} onChange={e=>f('inviteName',e.target.value)} /></div>
                </div>
                <div style={S.row}>
                  <div><label style={S.label}>Password *</label><input type="password" style={S.input} placeholder="Min 8 characters" value={form.invitePassword||''} onChange={e=>f('invitePassword',e.target.value)} /></div>
                  <div><label style={S.label}>Primary location</label>
                    <select style={S.input} value={form.inviteLocationId||''} onChange={e=>f('inviteLocationId',e.target.value)}>
                      <option value="">First location (auto)</option>
                      {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  </div>
                </div>
                <div style={{ display:'flex', gap:10 }}>
                  <button onClick={createUser} disabled={working} style={{ ...S.btn, ...S.btnPrimary }}>{working?'Creating…':'Create user →'}</button>
                  <button onClick={() => setSection('org-detail')} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
