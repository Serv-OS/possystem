import { useState, useEffect, lazy, Suspense } from 'react';
import { VERSION } from '../lib/version';
import { supabase } from '../lib/supabase';
import BOLogin from '../backoffice/BOLogin';
import SecondStepGate from '../components/secondStep/SecondStepGate';
import AdminSecondSteps from './sections/AdminSecondSteps';
import AdminVenueMessages from './sections/AdminVenueMessages';
import AdminUpdateEmails from './sections/AdminUpdateEmails';
import { isRealLogin, sessionProvesSecondStep, MIN_PASSWORD_LENGTH } from '../lib/secondStep/rules';
import { currentAccessToken } from '../lib/secondStep/client';
import AdminBillingManager from './sections/AdminBillingManager';
import AdminRevenue from './sections/AdminRevenue';
import AdminReseller from './sections/AdminReseller';
import AdminCustomerImport from './sections/AdminCustomerImport';
import { money, CURRENCIES } from '../lib/currency';
// 27 Oct 2026: a new venue starts on Starter in its own currency (99 GBP, 149 USD).
import { newVenueSubscription, saasPlanName } from '../lib/saasNewVenue';
import { seedVenueTaxRates, seedWords } from '../lib/venueTaxRates';
import { ServOSIcon, ServOSWordmark } from '../components/ServOSBrand';
import { Icon } from '../components/ServOSIcons';
import TimezoneOptions from '../components/TimezoneOptions';
import { defaultTimezoneFor } from '../lib/timezones';
// 5 Nov 2026: Delete organisation: all locations and wipe all data. The screen only asks the
// org-admin function; the wipe runs on the server (SQL 20261125a Ops, 20261125b Platform).
import { callOrgAdmin } from '../lib/orgAdmin';
import { ORG_WIPE_TITLE, LOCATION_WIPE_TITLE, nameMatches, wipeSummary, wipeDoneLine } from '../lib/orgWipeRules';

// v5.11.75: loaded only when a company is opened here, so the Multi site menu code never rides in
// the bundle every till downloads.
const AdminMultiSiteMenu = lazy(() => import('./sections/AdminMultiSiteMenu'));

const S = {
  shell: { display:'flex', height:'100vh', fontFamily:'inherit', background:'var(--bg)', color:'var(--t1)' },
  sidebar: { width:228, background:'var(--bg1)', borderRight:'1px solid var(--bdr)', display:'flex', flexDirection:'column', padding:'20px 0' },
  brand: { padding:'0 16px 18px', borderBottom:'1px solid var(--bdr)', marginBottom:14 },
  brandBadge: { width:34, height:34, borderRadius:8, background:'var(--acc)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:16, fontWeight:800, color:'#0b0c10', marginBottom:8 },
  main: { flex:1, overflowY:'auto', padding:'28px 36px' },
  h1: { fontSize:22, fontWeight:800, color:'var(--t1)', marginBottom:4, letterSpacing:'-.01em' },
  sub: { fontSize:13, color:'var(--t3)', marginBottom:24 },
  card: { background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:12, padding:20, marginBottom:16, boxShadow:'var(--sh)' },
  label: { fontSize:11, fontWeight:700, color:'var(--t3)', marginBottom:5, display:'block', textTransform:'uppercase', letterSpacing:'.06em' },
  input: { width:'100%', padding:'9px 12px', borderRadius:8, border:'1px solid var(--bdr2)', background:'var(--bg2)', color:'var(--t1)', fontSize:13, fontFamily:'inherit', outline:'none', boxSizing:'border-box' },
  row: { display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 },
  row3: { display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:12 },
  btn: { padding:'8px 14px', borderRadius:8, border:'none', cursor:'pointer', fontSize:13, fontWeight:700, fontFamily:'inherit' },
  btnPrimary: { background:'var(--acc)', color:'#0b0c10' },
  btnGhost: { background:'transparent', color:'var(--t2)', border:'1px solid var(--bdr2)' },
  btnDanger: { background:'transparent', color:'var(--red)', border:'1px solid var(--red-b)' },
  badge: { padding:'3px 8px', borderRadius:20, fontSize:11, fontWeight:700 },
};

// The admin portal's access token, read through supabase-js (which refreshes it when it
// expires) instead of straight from localStorage, so it is always the CURRENT token: after the
// second sign in step that is the aal2 token the database and the edge functions require
// (docs/SECOND_STEP.md). Null when signed out.
const getAccessToken = () => currentAccessToken(supabase);

async function sbFetch(path, opts = {}) {
  const token = await getAccessToken();
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const url = import.meta.env.VITE_SUPABASE_URL;
  if (!url || !key) return { data: null, error: { message: 'Not configured' } };
  const res = await fetch(`${url}/rest/v1/${path}`, {
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${token || key}`,
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

// The venue's permanent public ID, click to copy. It exists so another system can
// point at this venue without depending on its name: the POS calls a site "Leeds"
// while the CRM may hold three Leeds venues under different brands. Generated by
// the database on insert, so a venue can never be created without one.
function VenueCodeChip({ code }) {
  const [copied, setCopied] = useState(false);
  if (!code) {
    // Only possible on a venue created before the code column existed and never
    // backfilled. Say so rather than rendering a confusing blank.
    return <span style={{ fontSize:11, color:'var(--t4)' }} title="This venue has no ID yet">no ID</span>;
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1400); }
    catch { /* clipboard blocked: the code is on screen to copy by hand */ }
  };
  return (
    <button
      onClick={copy}
      title={copied ? 'Copied' : 'Click to copy this venue ID for the CRM'}
      style={{
        fontFamily:'var(--font-mono, monospace)', fontSize:11.5, fontWeight:700,
        letterSpacing:'.04em', padding:'3px 9px', borderRadius:7, cursor:'pointer',
        background: copied ? 'var(--grn-d)' : 'var(--bg3)',
        border: `1px solid ${copied ? 'var(--grn-b)' : 'var(--bdr)'}`,
        color: copied ? 'var(--grn)' : 'var(--t2)',
      }}
    >
      {copied ? 'Copied' : code}
    </button>
  );
}

// Sign out of the admin portal: ends THIS session on the server too (the old button only
// deleted the localStorage key, so the session stayed valid).
const adminSignOut = () => {
  try { localStorage.removeItem('rpos-bo-location'); } catch { /* private mode */ }
  supabase.auth.signOut({ scope: 'local' }).finally(() => window.location.reload());
};

export default function CompanyAdminApp() {
  const [authUser, setAuthUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(!supabase);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [roleChecked, setRoleChecked] = useState(false);
  const [recovering, setRecovering] = useState(false); // v5.5.343: password-reset link landing
  const [recoveryStepOk, setRecoveryStepOk] = useState(false);
  // SECOND SIGN IN STEP (docs/SECOND_STEP.md): the admin portal is the most powerful door, so
  // nothing loads (not even the role check) until the sign in is aal2.
  const [secondStepOk, setSecondStepOk] = useState(false);

  // The session comes from supabase-js (it refreshes an expired token) instead of being read
  // raw from localStorage. v5.5.306 still holds: an anonymous session (a till or payment token
  // sharing 'rpos-auth') is NOT an admin login, so BOLogin shows.
  useEffect(() => {
    if (!supabase) return undefined;
    const accept = (session) => (session && isRealLogin(session) && session.user?.email ? session.user : null);
    supabase.auth.getSession().then(({ data }) => { setAuthUser(accept(data?.session)); setAuthChecked(true); });
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      // v5.5.343: a password-reset link shows the set-new-password form instead of logging in.
      if (event === 'PASSWORD_RECOVERY') { setRecovering(true); return; }
      if (event === 'SIGNED_OUT') setSecondStepOk(false);
      // A passkey sign in is aal1 and is DONE, so it must not be sent round the gate again.
      if (session && isRealLogin(session) && !sessionProvesSecondStep(session)) setSecondStepOk(false);
      setAuthUser(accept(session));
    });
    return () => data?.subscription?.unsubscribe?.();
  }, []);

  // Verify the role from the database once the second step is done (never trust storage).
  useEffect(() => {
    if (!authUser || !secondStepOk) return;
    let live = true;
    sbFetch(`user_profiles?id=eq.${authUser.id}&select=role`)
      .then(({ data }) => {
        if (!live) return;
        const role = Array.isArray(data) ? data[0]?.role : data?.role;
        setIsSuperAdmin(role === 'super_admin');
        setRoleChecked(true);
      })
      .catch(() => { if (live) setRoleChecked(true); });
    return () => { live = false; };
  }, [authUser, secondStepOk]);

  if (recovering && !recoveryStepOk) {
    return <SecondStepGate supabase={supabase} mode="recovery" area="Company Admin" onPassed={() => setRecoveryStepOk(true)} onSignOut={adminSignOut} />;
  }
  if (recovering) return <BOLogin area="Company Admin" recovery onResetDone={() => { setRecovering(false); window.location.reload(); }} />;
  if (!authChecked) return <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--bg)', color:'var(--t3)', fontSize:13 }}>Loading…</div>;
  if (!authUser) return <BOLogin area="Company Admin" onLogin={(u) => setAuthUser(u)} />;
  if (!secondStepOk) {
    return <SecondStepGate supabase={supabase} mode="login" area="Company Admin" onPassed={() => setSecondStepOk(true)} onSignOut={adminSignOut} />;
  }
  if (!roleChecked) return <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--bg)', color:'var(--t3)', fontSize:13 }}>Loading…</div>;
  if (!isSuperAdmin) return (
    <div style={{ minHeight:'100vh', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', background:'var(--bg)', color:'var(--t3)', gap:16 }}>
      <Icon name="lock" size={32} />
      <div style={{ fontSize:16, fontWeight:700, color:'var(--t1)' }}>Access denied</div>
      <div style={{ fontSize:13 }}>This area requires super_admin access.</div>
      <button onClick={adminSignOut} style={{ marginTop:8, padding:'8px 20px', borderRadius:8, border:'1px solid var(--bdr2)', background:'transparent', color:'var(--t3)', cursor:'pointer', fontFamily:'inherit', fontSize:13 }}>Sign out</button>
    </div>
  );
  return <AdminPanel authUser={authUser} />;
}

/**
 * The one screen before an organisation or a location is deleted (Peter, 5 Nov 2026: "this should
 * say delete organizations - all locations and wipe all data"). It shows what the server counted
 * (a dry run, nothing changed yet), asks for the name typed out, and only then lets the red
 * button go. confirm() is never used: app shells show no confirm dialog at all.
 *
 *   wipe { kind: 'org' | 'location', target: { id, name }, preview, loading, typed, error, busy }
 */
function WipeModal({ wipe, onTyped, onConfirm, onClose }) {
  const isOrg = wipe.kind === 'org';
  const title = isOrg ? ORG_WIPE_TITLE : LOCATION_WIPE_TITLE;
  const name = wipe.target?.name || '';
  const summary = wipe.preview ? wipeSummary(wipe.preview) : null;
  const ready = !wipe.loading && !wipe.busy && !!wipe.preview && nameMatches(wipe.typed, name);
  return (
    <div className="modal-back" onClick={e => e.target === e.currentTarget && !wipe.busy && onClose()}
      style={{ position:'fixed', inset:0, background:'rgba(0,0,0,.6)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:50, padding:16 }}>
      <div role="dialog" aria-label={title} style={{ ...S.card, width:'100%', maxWidth:520, marginBottom:0, border:'1px solid var(--red-b)' }}>
        <div style={{ fontSize:17, fontWeight:800, color:'var(--red)', marginBottom:4 }}>{title}</div>
        <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:12 }}>{name}</div>
        {wipe.loading && <div style={{ fontSize:13, color:'var(--t3)' }}>Counting what would go…</div>}
        {!wipe.loading && wipe.preview && (
          <>
            <div style={{ fontSize:12, color:'var(--t3)', marginBottom:6 }}>This cannot be undone. It deletes:</div>
            <ul style={{ margin:'0 0 12px', paddingLeft:18, fontSize:13, color:'var(--t1)', lineHeight:1.6 }}>
              {isOrg && (wipe.preview.locations || []).map(l => <li key={l.id}><b>{l.name}</b> and every row of its data</li>)}
              {summary.lines.map(line => <li key={line}>{line}</li>)}
              <li>Files in storage (logos, documents, invoice scans, photos)</li>
              {isOrg && <li>The Platform company (gift cards, loyalty, online pages, payment records)</li>}
            </ul>
            <label style={S.label}>Type the {isOrg ? 'organisation' : 'location'} name to confirm</label>
            <input value={wipe.typed} onChange={e => onTyped(e.target.value)} placeholder={name} autoFocus disabled={wipe.busy}
              onKeyDown={e => { if (e.key === 'Enter' && ready) onConfirm(); if (e.key === 'Escape' && !wipe.busy) onClose(); }}
              style={{ ...S.input, marginBottom:12 }} aria-label="Name to confirm" />
          </>
        )}
        {wipe.error && <div style={{ fontSize:13, color:'var(--red)', marginBottom:12 }}>{wipe.error}</div>}
        <div style={{ display:'flex', gap:8, justifyContent:'flex-end' }}>
          <button type="button" onClick={onClose} disabled={wipe.busy} style={{ ...S.btn, ...S.btnGhost }}>Cancel</button>
          <button type="button" onClick={onConfirm} disabled={!ready} style={{ ...S.btn, background:'var(--red)', color:'#fff', opacity: ready ? 1 : .5 }}>
            {wipe.busy ? 'Deleting…' : (isOrg ? 'Delete organisation and all its data' : 'Delete location and all its data')}
          </button>
        </div>
      </div>
    </div>
  );
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
  // Batch 9 (Peter, 4 Nov 2026): a new site's currency box starts blank and must be picked before the
  // site can be saved, like the time zone since 5.12.57. Until it is picked the time zone box stays
  // blank too; once picked the time zone default follows the currency as before.
  const locTzDefault = form.locCurrency ? defaultTimezoneFor(form.locCurrency) : '';
  const [working, setWorking] = useState(false);
  const [msg, setMsg] = useState({ type:'', text:'' });
  const [wipe, setWipe] = useState(null);   // 5 Nov 2026: the delete and wipe screen (WipeModal)

  const loadAllUsers = async () => {
    // Fetches every user_profiles row across all orgs. Only callable from
    // CompanyAdminApp which is gated to super_admin role. RLS policy on
    // user_profiles must allow super_admin to read all rows — otherwise
    // this returns only the calling user's own row and the picker is empty.
    try {
      // v5.5.309: exclude anonymous users (kiosk/online sessions). They have a
      // user_profiles row with a null email — filtering email=not.is.null keeps
      // the picker to real people you'd actually grant location access to.
      const { data } = await sbFetch(`user_profiles?select=id,email,full_name,org_id,role,location_id,user_locations(location_id)&email=not.is.null&order=email.asc`);
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

  // v5.5.310: provision the Platform DB mirror (company + location) for an ops
  // location id. Idempotent server-side. Logs but doesn't block on failure —
  // the ops location is already created; provisioning can be retried.
  // Returns { ok, service }: `service` is the venue's loyalty code text service after provisioning
  // (22 Oct 2026, { ok, state, words }), null when the function did not answer.
  const provisionLocation = async (opsLocationId) => {
    try {
      const token = await getAccessToken();
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/provision-location`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ ops_location_id: opsLocationId }),
      });
      const pr = await resp.json().catch(() => ({}));
      if (!resp.ok) console.warn('[provisionLocation] failed:', pr?.error);
      const service = pr?.service || null;
      return { ok: resp.ok, service };
    } catch (pe) { console.warn('[provisionLocation] threw:', pe?.message); return { ok: false, service: null }; }
  };

  // 22 Oct 2026: a venue's loyalty code texts carry its name. After a rename, loyalty-otp
  // ensure_service renames (or makes) the venue's own text service and answers in plain words.
  // Best effort: the nightly check and Back Office's Fix button cover a refusal.
  const ensureOtpService = async (opsLocationId) => {
    try {
      const token = await getAccessToken();
      const resp = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/loyalty-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ action: 'ensure_service', location_id: opsLocationId }),
      });
      const r = await resp.json().catch(() => ({}));
      if (!resp.ok) { console.warn('[ensureOtpService] refused:', r?.error); return null; }
      return r || null;
    } catch (e) { console.warn('[ensureOtpService] threw:', e?.message); return null; }
  };

  // ── Rename org ──────────────────────────────────────────────────────────────
  const saveRenameOrg = async () => {
    if (!editingOrg?.name?.trim()) return;
    await sbFetch(`organisations?id=eq.${editingOrg.id}`, { method:'PATCH', body:{ name: editingOrg.name.trim() }, prefer:'' });
    setEditingOrg(null);
    await loadOrgs();
    if (selectedOrg?.id === editingOrg.id) setSelectedOrg(o => ({ ...o, name: editingOrg.name.trim() }));
    ok('✓ Organisation renamed');
  };

  // ── Delete org: all locations and wipe all data ─────────────────────────────
  // 5 Nov 2026 (Peter: "Delete button doesn't do anything, this should say delete organizations -
  // all locations and wipe all data"). The old code deleted 13 hand listed tables from the browser
  // and ignored every error, so the organisation never went. Now: the org-admin function counts
  // first (a dry run), the name is typed, and the server wipes every table, the logins, the
  // Platform rows and the stored files. See lib/orgWipeRules.js and the SQL files.
  const openWipe = async (kind, target) => {
    setMsg({ type:'', text:'' });
    setWipe({ kind, target, preview:null, loading:true, typed:'', error:'', busy:false });
    try {
      const preview = await callOrgAdmin(kind === 'org' ? 'preview' : 'preview_location', kind === 'org' ? { org_id: target.id } : { location_id: target.id });
      setWipe(w => (w && w.target?.id === target.id ? { ...w, preview, loading:false } : w));
    } catch (e) {
      setWipe(w => (w && w.target?.id === target.id ? { ...w, loading:false, error: e.message } : w));
    }
  };
  const deleteOrg = (org) => openWipe('org', org);

  const confirmWipe = async () => {
    if (!wipe || wipe.busy || !wipe.preview) return;
    const { kind, target, typed } = wipe;
    if (!nameMatches(typed, target.name)) return;
    setWipe(w => ({ ...w, busy:true, error:'' }));
    setWorking(true);
    try {
      const report = kind === 'org'
        ? await callOrgAdmin('delete_org', { org_id: target.id, name_typed: typed })
        : await callOrgAdmin('delete_location', { location_id: target.id, name_typed: typed });
      setWipe(null);
      if (kind === 'org') {
        if (selectedOrg?.id === target.id) { setSelectedOrg(null); setSection('orgs'); }
        await loadOrgs();
        await loadAllUsers();
      } else if (selectedOrg) {
        await loadLocations(selectedOrg.id);
        await loadUsers(selectedOrg.id);
      }
      const lines = Array.isArray(report?.storage?.errors) && report.storage.errors.length ? ' ' + report.storage.errors.join('; ') : '';
      ok(`\u2713 ${wipeDoneLine(kind, target.name, report)}${lines}`);
    } catch (e) {
      setWipe(w => (w ? { ...w, busy:false, error: e.message } : w));
    }
    setWorking(false);
  };

  // ── Rename location ──────────────────────────────────────────────────────────
  const saveRenameLocation = async () => {
    if (!editingLoc?.name?.trim()) return;
    const renamedId = editingLoc.id;
    await sbFetch(`locations?id=eq.${renamedId}`, { method:'PATCH', body:{ name: editingLoc.name.trim() }, prefer:'' });
    setEditingLoc(null);
    await loadLocations(selectedOrg.id);
    const service = await ensureOtpService(renamedId);
    if (service && service.ok === false) err(`✓ Location renamed, but ${service.words} Open Back Office > Messages > Verification code and press Fix.`);
    else ok(`✓ Location renamed${service?.words ? `. ${service.words}` : ''}`);
  };

  // ── Delete location and wipe all its data (same screen as the organisation) ──
  const deleteLocation = (loc) => openWipe('location', loc);

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
    if (!form.locCurrency) return err('Pick the currency for this site.');
    if (!(form.locTz || locTzDefault)) return err('Pick the time zone. US sites span several zones.');
    setWorking(true); setMsg({ type:'', text:'' });
    const { data, error:e } = await sbFetch('locations', { method:'POST', body:{
      org_id: selectedOrg.id, name: form.locName.trim(),
      address: form.locAddress || '', timezone: form.locTz || locTzDefault,
      currency: form.locCurrency, status: 'active',
    }});
    const loc = Array.isArray(data) ? data[0] : data;
    if (e || !loc) { setWorking(false); return err(e?.message || 'Failed'); }
    // v5.5.310: mirror the new location into the Platform DB so loyalty, gift
    // cards, online ordering, QR, Challenge 21, message templates and location
    // settings can resolve its company. Without this the location errors with
    // "No platform row found for ops location ...".
    const provisioned = await provisionLocation(loc.id);
    const maxDevices = parseInt(form.maxDevices) || 3;
    await sbFetch('subscriptions', { method:'POST', body:{ org_id:selectedOrg.id, location_id:loc.id, ...newVenueSubscription(loc.currency || form.locCurrency), gmv_this_month:0, billing_period_start:new Date().toISOString().slice(0,10) } });
    await sbFetch('location_features', { method:'POST', body:{ location_id:loc.id, feature:'max_devices', enabled:true, price_per_month:maxDevices } });
    // 27 Sep 2026 (Peter: "for some reason every products tax rate has been removed ... please
    // chase"): the new venue gets its country's standard tax rates now (lib/venueTaxRates.js;
    // UK: Standard 20% default, Reduced 5%, Zero, in one insert; US venues keep the tax profile
    // flow). No creation path did this, and four Coffee Boy venues traded for days without any.
    const taxSeed = await seedVenueTaxRates({
      locationId: loc.id, currency: loc.currency || form.locCurrency,
      readExisting: (id) => sbFetch(`tax_rates?select=id&location_id=eq.${encodeURIComponent(id)}`),
      insertRows: (rows) => sbFetch('tax_rates', { method:'POST', body: rows }),
    });
    const taxWords = seedWords(taxSeed, `"${loc.name}"`);
    const serviceWords = provisioned?.service?.words || '';
    setWorking(false);
    if (!taxSeed.ok) err(`✓ "${loc.name}" created, but ${taxWords}`);
    else if (provisioned?.service && provisioned.service.ok === false) err(`✓ "${loc.name}" created, but ${serviceWords} Open Back Office > Messages > Verification code and press Fix.`);
    else ok(`✓ "${loc.name}" created${taxWords ? `. ${taxWords}` : ''}${serviceWords ? `. ${serviceWords}` : ''}`);
    setForm(p => ({ ...p, locName:'', locAddress:'', maxDevices:'' }));
    setSection('org-detail');
    await loadLocations(selectedOrg.id);
  };

  // ── Create user ──────────────────────────────────────────────────────────────
  const createUser = async () => {
    if (!form.inviteEmail?.trim()) return err('Email required');
    if (!form.invitePassword?.trim() || form.invitePassword.length < MIN_PASSWORD_LENGTH) return err(`Password min ${MIN_PASSWORD_LENGTH} characters`);
    setWorking(true); setMsg({ type:'', text:'' });
    const token = await getAccessToken();
    try {
      const resp = await fetch('https://tbetcegmszzotrwdtqhi.supabase.co/functions/v1/create-user', {
        method:'POST',
        headers:{ 'Content-Type':'application/json', 'Authorization':`Bearer ${token}` },
        body: JSON.stringify({ email:form.inviteEmail.trim(), password:form.invitePassword, fullName:form.inviteName||'', orgId:selectedOrg.id, locationId:form.inviteLocationId||locations[0]?.id||null, role:'owner' }),
      });
      const result = await resp.json();
      setWorking(false);
      if (result.error) return err(result.error);
      ok(result.alreadyExisted ? `✓ ${result.email} already had a login. It is now linked to ${selectedOrg.name} and the password you typed is set.` : `✓ User created: ${result.email}`);
      setForm(p => ({ ...p, inviteEmail:'', invitePassword:'', inviteName:'', inviteLocationId:'' }));
      setSection('org-detail');
      await Promise.all([loadUsers(selectedOrg.id), loadAllUsers()]);
    } catch(e) { setWorking(false); err(e.message); }
  };

  const toggleUserLocation = async (userId, locationId, hasAccess) => {
    const u = allUsers.find(u => u.id === userId) || users.find(u => u.id === userId);
    if (hasAccess) {
      const { error } = await sbFetch(`user_locations?user_id=eq.${userId}&location_id=eq.${locationId}`, { method:'DELETE', prefer:'' });
      if (error) return err('Failed to remove: ' + error.message);
      // v5.5.308: a user can "have access" to a location via TWO sources:
      //   (1) a user_locations junction row, and
      //   (2) user_profiles.location_id (their primary).
      // The delete above only removes (1). If this location is also their
      // primary, the user still shows as having access and the untick appears
      // to do nothing. So when removing access to the primary, reassign the
      // primary to a remaining accessible location (or null if none left).
      if (u?.location_id === locationId) {
        const remaining = (u.user_locations || [])
          .map(ul => ul.location_id)
          .filter(id => id && id !== locationId);
        await sbFetch(`user_profiles?id=eq.${userId}`, { method:'PATCH', body:{ location_id: remaining[0] || null }, prefer:'' });
      }
    } else {
      const { error } = await sbFetch('user_locations', { method:'POST', body:{ user_id:userId, location_id:locationId } });
      if (error) return err('Failed to add: ' + error.message);
      // v5.5.14: only set user_profiles.location_id if the user has none yet.
      // If they already have a primary location (most users do), don't change
      // it — that would silently relocate them away from their original org.
      // Cross-org access is correctly handled by the user_locations row alone.
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
          {/* v5.5.328: real Serv OS logo + wordmark (was an "S" badge + plain text) */}
          <ServOSIcon size={34} style={{ marginBottom:8 }} />
          <div style={{ marginBottom:2 }}><ServOSWordmark fontSize={15} /></div>
          <div style={{ fontSize:11, color:'var(--acc)', fontWeight:700, letterSpacing:'.06em', textTransform:'uppercase' }}>Company Admin</div>
        </div>
        {[
          { id:'orgs', label:'All organisations', icon:'building' },
          { id:'new-org', label:'+ New organisation' },
          { id:'billing', label:'Processing', icon:'card' },
          { id:'revenue', label:'Revenue', icon:'trendUp' },
          { id:'reseller', label:'FranPOS', icon:'receipt' },
          { id:'venue-messages', label:'Messages and emails', icon:'megaphone' },
          { id:'customer-import', label:'Import customers', icon:'inbox' },
          { id:'second-step', label:'Sign in security', icon:'lock' },
        ].map(n => (
          <button key={n.id} onClick={() => { setSection(n.id); setMsg({ type:'', text:'' }); }}
            style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 16px', margin:'1px 8px', borderRadius:8, cursor:'pointer', fontSize:13,
              fontWeight: section===n.id ? 700 : 400,
              background: section===n.id ? 'var(--acc-d)' : 'none',
              color: section===n.id ? 'var(--acc)' : 'var(--t2)',
              border:'none', fontFamily:'inherit', width:'calc(100% - 16px)', textAlign:'left' }}>
            {n.icon && <Icon name={n.icon} size={16} />}{n.label}
          </button>
        ))}
        {selectedOrg && (
          <button onClick={() => setSection('org-detail')}
            style={{ display:'block', width:'calc(100% - 16px)', margin:'1px 8px', textAlign:'left', padding:'6px 16px', borderRadius:8, border:'none', cursor:'pointer', fontSize:12, color:'var(--acc)', background:section==='org-detail'?'#1e1a3a':'none', fontFamily:'inherit' }}>
            └ {selectedOrg.name}
          </button>
        )}
        <div style={{ flex:1 }} />
        <div style={{ padding:'0 12px' }}>
          <div style={{ fontSize:11, color:'var(--t4)', padding:'0 6px', marginBottom:6 }}>{authUser.email}</div>
          <button onClick={adminSignOut} style={{ ...S.btn, ...S.btnGhost, width:'100%', fontSize:12 }}>Sign out</button>
          <button onClick={() => { localStorage.removeItem('rpos-device-mode'); window.location.href='/'; }} style={{ width:'100%', padding:'6px', background:'none', border:'none', cursor:'pointer', fontSize:11, color:'var(--t4)', marginTop:4, fontFamily:'inherit' }}>← Switch device mode</button>
          <div style={{ fontSize:10, color:'var(--t4)', textAlign:'center', marginTop:8, fontFamily:'monospace' }}>v{VERSION}</div>
        </div>
      </div>

      {/* ── Main ── */}
      <div style={S.main}>
        {ms && msg.text && (
          <div style={{ background:ms.bg, border:`1px solid ${ms.border}`, color:ms.color, borderRadius:10, padding:'12px 16px', marginBottom:20, fontSize:13 }}>{msg.text}</div>
        )}
        {wipe && <WipeModal wipe={wipe} onTyped={t => setWipe(w => (w ? { ...w, typed:t } : w))} onConfirm={confirmWipe} onClose={() => setWipe(null)} />}

        {/* ── Processing: payment accounts & pricing ── */}
        {section === 'billing' && <AdminBillingManager authUser={authUser} />}

        {/* ── Revenue: what the platform makes (payments + SaaS) ── */}
        {section === 'revenue' && <AdminRevenue />}
        {section === 'reseller' && <AdminReseller />}
        {/* Customer import: ServOS staff only, never in Back Office. */}
        {section === 'customer-import' && <AdminCustomerImport orgs={orgs} sbFetch={sbFetch} />}
        {/* Second sign in step: who has set up, and the ServOS reset for a lost phone. */}
        {section === 'second-step' && <AdminSecondSteps />}
        {/* 5 Oct 2026: a pop up on the tills and Back Office of chosen venues, until someone taps Got it. */}
        {section === 'venue-messages' && <AdminVenueMessages />}
        {/* 8 Oct 2026: the weekly what's new email to every Back Office login of the chosen companies, below the pop up sender. */}
        {section === 'venue-messages' && <AdminUpdateEmails />}

        {/* ── Orgs list ── */}
        {section === 'orgs' && (
          <>
            <div style={{ ...S.h1, display:'flex', alignItems:'center', gap:8 }}><Icon name="building" size={20} />Organisations</div>
            <div style={S.sub}>All restaurants on the platform · {orgs.length} total</div>
            <button onClick={() => setSection('new-org')} style={{ ...S.btn, ...S.btnPrimary, marginBottom:20 }}>+ New organisation</button>
            <div style={S.card}>
              {loading
                ? <div style={{ color:'var(--t3)', fontSize:13 }}>Loading… <button onClick={loadOrgs} style={{ ...S.btn, ...S.btnGhost, padding:'3px 10px', fontSize:11, marginLeft:8 }}>Retry</button></div>
                : orgs.length === 0
                  ? <div style={{ color:'var(--t3)', fontSize:13, padding:'20px 0' }}>No organisations yet</div>
                  : orgs.map(o => (
                    <div key={o.id} style={{ display:'flex', alignItems:'center', gap:12, padding:'14px 0', borderBottom:'1px solid var(--bdr)' }}>
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
                            <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>{o.name}</div>
                            <div style={{ fontSize:12, color:'var(--t3)', fontFamily:'monospace' }}>{o.slug}</div>
                          </div>
                          <span style={{ ...S.badge, background:'#0d2e1a', color:'#86efac' }}>{o.status}</span>
                          <div style={{ fontSize:12, color:'var(--t3)' }}>{new Date(o.created_at).toLocaleDateString('en-GB')}</div>
                          <button onClick={() => selectOrg(o)} style={{ ...S.btn, ...S.btnGhost, padding:'5px 12px', fontSize:12 }}>Manage →</button>
                          <button onClick={() => setEditingOrg({ id:o.id, name:o.name })} style={{ ...S.btn, ...S.btnGhost, padding:'5px 12px', fontSize:12 }}><Icon name="pencil" size={14} /></button>
                          <button onClick={() => deleteOrg(o)} disabled={working} title={ORG_WIPE_TITLE} style={{ ...S.btn, ...S.btnDanger, padding:'5px 12px', fontSize:12, display:'inline-flex', alignItems:'center', gap:4 }}><Icon name="trash" size={14} />Delete organisation</button>
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
                  <button onClick={() => { setSection('create-user'); setMsg({type:'',text:''}); }} style={{ ...S.btn, ...S.btnGhost, display:'inline-flex', alignItems:'center', gap:6 }}><Icon name="user" size={14} />Create user</button>
                </div>

                <div style={S.card}>
                  <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:20, display:'flex', alignItems:'center', gap:6 }}><Icon name="mapPin" size={16} />Locations & User Access</div>
                  {locations.length === 0
                    ? <div style={{ color:'var(--t3)', fontSize:13 }}>No locations yet — add one above</div>
                    : locations.map((loc, idx) => {
                        const maxDev = loc.location_features?.find(f=>f.feature==='max_devices')?.price_per_month || 3;
                        const planKey = loc.subscriptions?.[0]?.plan;
                        const plan = planKey ? saasPlanName(planKey, loc.currency) : 'No plan';
                        const gmv = loc.subscriptions?.[0]?.gmv_this_month || 0;
                        const locUsers = usersForLocation(loc.id);
                        const isEditingUsers = editUsersFor === loc.id;
                        const isEditingName = editingLoc?.id === loc.id;

                        return (
                          <div key={loc.id} style={{ paddingBottom:24, marginBottom:24, borderBottom: idx < locations.length-1 ? '1px solid var(--bdr)' : 'none' }}>
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
                                  <div style={{ fontSize:15, fontWeight:700, color:'var(--t1)' }}>{loc.name}</div>
                                  <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                                    {/* The venue's permanent public ID. Paste this into the CRM record
                                        when the venue is set up: it is how support knows which site is
                                        asking, whatever anyone later renames things to. */}
                                    <VenueCodeChip code={loc.venue_code} />
                                    <span style={{ ...S.badge, background:'var(--acc-d)', color:'#a5b4fc' }}>{plan}</span>
                                    <span style={{ fontSize:12, color:'var(--t3)' }}>{maxDev} devices</span>
                                    <span style={{ fontSize:12, color:'var(--t3)' }}>{money(parseFloat(gmv))} GMV</span>
                                  </div>
                                  <div style={{ marginLeft:'auto', display:'flex', gap:8 }}>
                                    <button onClick={() => setEditingLoc({ id:loc.id, name:loc.name })} style={{ ...S.btn, ...S.btnGhost, padding:'4px 10px', fontSize:11, display:'inline-flex', alignItems:'center', gap:4 }}><Icon name="pencil" size={12} />Rename</button>
                                    <button onClick={() => deleteLocation(loc)} disabled={working} title={LOCATION_WIPE_TITLE} style={{ ...S.btn, ...S.btnDanger, padding:'4px 10px', fontSize:11, display:'inline-flex', alignItems:'center', gap:4 }}><Icon name="trash" size={12} />Delete</button>
                                  </div>
                                </>
                              )}
                            </div>

                            {/* Users section */}
                            <div style={{ paddingLeft:0 }}>
                              <div style={{ fontSize:11, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.06em', marginBottom:10 }}>Users with access</div>
                              {isEditingUsers ? (
                                <div style={{ background:'var(--bg)', borderRadius:10, padding:16, border:'1px solid var(--bdr2)' }}>
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
                                    // v5.5.309: defensively drop anonymous/emailless
                                    // profiles (kiosk/online sessions) so the picker
                                    // only lists real users.
                                    const allShown = (allUsers.length > 0 ? allUsers : users).filter(u => u.email);
                                    const filtered = q
                                      ? allShown.filter(u =>
                                          (u.email || '').toLowerCase().includes(q) ||
                                          (u.full_name || '').toLowerCase().includes(q))
                                      : allShown;
                                    if (allShown.length === 0) {
                                      return <div style={{ fontSize:13, color:'var(--t4)', marginBottom:12 }}>No users in the platform yet — create one first</div>;
                                    }
                                    if (filtered.length === 0) {
                                      return <div style={{ fontSize:13, color:'var(--t4)', marginBottom:12 }}>No users match "{userSearch}"</div>;
                                    }
                                    return filtered.map(u => {
                                      const has = locUsers.some(lu => lu.id === u.id);
                                      const sameOrg = u.org_id === selectedOrg?.id;
                                      return (
                                        <label key={u.id} style={{ display:'flex', alignItems:'center', gap:10, marginBottom:12, cursor:'pointer' }}>
                                          <input type="checkbox" checked={has}
                                            onChange={() => toggleUserLocation(u.id, loc.id, has)}
                                            style={{ accentColor:'var(--acc)', width:16, height:16, flexShrink:0 }}
                                          />
                                          <div style={{ flex:1, minWidth:0 }}>
                                            <div style={{ fontSize:13, fontWeight:600, color:'var(--t1)' }}>{u.full_name || u.email}</div>
                                            <div style={{ fontSize:11, color:'var(--acc)', fontFamily:'monospace' }}>{u.email || '—'}</div>
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
                                    ? <span style={{ fontSize:13, color:'var(--t4)' }}>No users assigned to this location</span>
                                    : locUsers.map(u => (
                                        <div key={u.id} style={{ background:'var(--acc-d)', border:'1px solid #3730a3', borderRadius:8, padding:'6px 12px' }}>
                                          <div style={{ fontSize:12, fontWeight:700, color:'var(--t1)' }}>{u.full_name || u.email}</div>
                                          <div style={{ fontSize:11, color:'var(--acc)', fontFamily:'monospace' }}>{u.email}</div>
                                        </div>
                                      ))
                                  }
                                  <button onClick={() => setEditUsersFor(loc.id)} style={{ ...S.btn, ...S.btnGhost, padding:'5px 12px', fontSize:12 }}>
                                    {locUsers.length ? <span style={{ display:'inline-flex', alignItems:'center', gap:5 }}><Icon name="pencil" size={13} />Edit access</span> : '+ Add user'}
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })
                  }
                </div>

                {/* v5.11.75: who may open the Multi site menu (named logins, ServOS only). */}
                <Suspense fallback={null}><AdminMultiSiteMenu org={selectedOrg} allUsers={allUsers} /></Suspense>
              </>
            )}

            {/* ── Add location form ── */}
            {section === 'new-location' && (
              <div style={S.card}>
                <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:16 }}>Add location to {selectedOrg.name}</div>
                <div style={S.row}>
                  <div><label style={S.label}>Location name *</label><input style={S.input} placeholder="e.g. Oxford Street" value={form.locName||''} onChange={e=>f('locName',e.target.value)} /></div>
                  <div><label style={S.label}>Address</label><input style={S.input} placeholder="123 High St, London" value={form.locAddress||''} onChange={e=>f('locAddress',e.target.value)} /></div>
                </div>
                <div style={S.row3}>
                  <div><label style={S.label}>Timezone</label>
                    <select style={S.input} value={form.locTz||locTzDefault} onChange={e=>f('locTz',e.target.value)}>
                      {!(form.locTz||locTzDefault) && <option value="">Pick the time zone</option>}
                      <TimezoneOptions value={form.locTz||locTzDefault} />
                    </select>
                  </div>
                  <div><label style={S.label}>Currency</label>
                    <select style={S.input} value={form.locCurrency||''} onChange={e=>f('locCurrency',e.target.value)}>
                      {!form.locCurrency && <option value="">Pick a currency</option>}
                      {Object.values(CURRENCIES).map(c => <option key={c.code} value={c.code}>{c.code} {c.symbol}</option>)}
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
                <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:16, display:'flex', alignItems:'center', gap:6 }}><Icon name="user" size={16} />Create back-office user for {selectedOrg.name}</div>
                <div style={S.row}>
                  <div><label style={S.label}>Email *</label><input type="email" style={S.input} placeholder="owner@restaurant.com" value={form.inviteEmail||''} onChange={e=>f('inviteEmail',e.target.value)} /></div>
                  <div><label style={S.label}>Full name</label><input style={S.input} placeholder="Sarah Smith" value={form.inviteName||''} onChange={e=>f('inviteName',e.target.value)} /></div>
                </div>
                <div style={S.row}>
                  <div><label style={S.label}>Password *</label><input type="password" style={S.input} placeholder={`Min ${MIN_PASSWORD_LENGTH} characters`} value={form.invitePassword||''} onChange={e=>f('invitePassword',e.target.value)} /></div>
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
