import { useState, useEffect } from 'react';
import { useStore } from '../store';
import { broadcastConfigPush } from '../sync/SyncBridge';
import { supabase, isMock, getLocationId, setResolvedLocationId, clearResolvedLocationId } from '../lib/supabase';
import BOLogin from './BOLogin';
import LocationSwitcher from './LocationSwitcher';
import { VERSION } from '../lib/version';
import { CUSTOMER_ROOT, customerUrl } from '../lib/env';
import MenuManager from './sections/MenuManager';
import FloorPlanBuilder from './sections/FloorPlanBuilder';
import DeviceProfiles from './sections/DeviceProfiles';
import DeviceRegistry from './sections/DeviceRegistry';
import KioskRegistry from './sections/KioskRegistry';
import OnlineOrdering from './sections/OnlineOrdering';
import StaffManager from './sections/StaffManager';
import PrintRouting from './sections/PrintRouting';
import PrinterRegistry from './sections/PrinterRegistry';
import CardReaders from './sections/CardReaders';
import CashDrawers from './sections/CashDrawers';
import BOReports from './sections/BOReports';
import EODClose from './sections/EODClose';
import Customers from './sections/Customers';
import Shift from './sections/Shift';
import Inventory from './sections/Inventory';
import SupabaseSetup from '../lib/SupabaseSetup';
import CompanyAdmin from './sections/CompanyAdmin';
import AIAssistantSection from './sections/AIAssistantSection';
import NetworkStatus from './sections/NetworkStatus';
import LocationSettings from './sections/LocationSettings';
import ReceiptBranding from './sections/ReceiptBranding';
import TaxManager from './sections/TaxManager';
import PettyCash from './sections/PettyCash';
import Challenge21 from './sections/Challenge21';
import DiscountManager from './sections/DiscountManager';
import GiftCards from './sections/GiftCards';
import MessageTemplates from './sections/MessageTemplates';
import LoyaltyManager from './sections/LoyaltyManager';

const NAV = [
  { id:'overview',   label:'Overview',        icon:'◈',  group:'Dashboard' },
  { id:'menu',       label:'Menu manager',    icon:'🍽',  group:'Configuration' },
  { id:'floorplan',  label:'Floor plan',      icon:'⬚',  group:'Configuration' },
  { id:'inventory',  label:'Inventory',       icon:'📦',  group:'Configuration' },
  { id:'profiles',   label:'Device profiles', icon:'📋',  group:'Devices' },
  { id:'devices',    label:'Devices',         icon:'📱',  group:'Devices' },
  { id:'kiosks',      label:'Kiosks',           icon:'🖥️',  group:'Devices' },
  { id:'online',     label:'Online ordering',  icon:'🌐',  group:'Devices' },
  { id:'printers',   label:'Printers',        icon:'🖨',  group:'Devices' },
  { id:'cardreaders',label:'Card readers',    icon:'💳',  group:'Devices' },
  { id:'cashdrawers', label:'Cash drawers',       icon:'\u{1F4B0}', group:'Devices' },
  { id:'staff',      label:'Staff & access',  icon:'👥',  group:'Configuration' },
  { id:'printing',   label:'Production printing',   icon:'🖨',  group:'Configuration' },
  { id:'reports',    label:'Reports',           icon:'📊',  group:'Analytics' },
  { id:'shift',      label:'Shift',             icon:'⏱', group:'Analytics' },
  { id:'eod',        label:'Close day',        icon:'🔒',  group:'Analytics' },
  { id:'pettycash',  label:'Petty cash',        icon:'\u{1F4B0}', group:'Analytics' },
  { id:'customers',  label:'Customers',         icon:'\u{1F465}', group:'Analytics' },
  { id:'tax',        label:'Tax & VAT',          icon:'%',   group:'Analytics' },
  { id:'ai',         label:'AI Assistant',      icon:'✦',   group:'Analytics' },
  { id:'network',    label:'Network & Sync',     icon:'📡',  group:'Analytics' },
  { id:'location',   label:'Location settings', icon:'⚙️',  group:'Analytics' },
  { id: 'discounts', label: 'Discounts',     icon: '🏷', group: 'Configuration' },
  { id: 'receipt', label: 'Receipt', icon: '🧾', group: 'Configuration' },
  { id: 'challenge21', label: 'Challenge ID', icon: '\u{1F4AA}', group: 'Configuration' },
  { id: 'giftcards', label: 'Gift Cards', icon: '\u{1F381}', group: 'Analytics' },
  { id: 'loyalty', label: 'Loyalty', icon: '\u{2B50}', group: 'Analytics' },
  { id: 'messages', label: 'Messages', icon: '\u{1F4AC}', group: 'Configuration' },
];

export default function BackOfficeApp() {
  const { setAppMode, staff, closedChecks, tables, devices } = useStore();
  const [authUser, setAuthUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(isMock);
  const [section, setSection] = useState('overview');
  const [orgCtx, setOrgCtx] = useState(null); // { orgName, locationName, locationId, orgId, role }
  const [showLocationSwitcher, setShowLocationSwitcher] = useState(false);

  // Check Supabase session on mount
  useEffect(() => {
    if (isMock) return;
    // v5.5.306: the Supabase client shares storageKey 'rpos-auth' with the
    // anonymous sign-in used by ensureAuthToken() (payments / edge functions /
    // POS device token). An anonymous session is NOT a back-office login — if
    // we treat it as one, the BO renders with no login prompt and no location
    // ("blank back office"). Reject anonymous users so BOLogin shows instead.
    const realUser = (u) => (u && !u.is_anonymous && u.email ? u : null);
    supabase.auth.getSession().then(({ data }) => {
      setAuthUser(realUser(data?.session?.user));
      setAuthChecked(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // v5.5.238: clear location overrides on sign-out so a second user logging
      // into the same browser never inherits the previous user's location.
      // This is the safety net — sign-out buttons also clear, but this catches
      // session expiry, signOut from DevTools, multi-tab races, etc.
      if (event === 'SIGNED_OUT') {
        localStorage.removeItem('rpos-bo-location');
        clearResolvedLocationId();
      }
      setAuthUser(realUser(session?.user));
    });
    return () => subscription.unsubscribe();
  }, []);

  // Load org/location context once user is known
  useEffect(() => {
    if (!authUser || isMock) return;
    (async () => {
      // v5.5.241: profile query rewrite. Previous versions used PostgREST
      // embedded resource syntax (organisations(name), locations(name)) which
      // fails when PostgREST's schema cache is stale — *both* the primary and
      // fallback queries used it, so a stale cache left orgCtx.locationId null
      // → "No location assigned" banner even for users WITH a location.
      // Now we query plain columns only, then fetch names separately. This
      // makes the login query immune to PostgREST schema cache issues.
      let profile = null;

      // Step 1: fetch core profile — plain columns only, no embedded resources
      let { data, error } = await supabase
        .from('user_profiles')
        .select('role, org_id, location_id, bo_access')
        .eq('id', authUser.id)
        .single();
      // Fallback: if bo_access column doesn't exist yet, retry without it
      if (error) {
        console.warn('[BackOfficeApp] profile SELECT failed:', error.message, '— retrying without bo_access');
        ({ data, error } = await supabase
          .from('user_profiles')
          .select('role, org_id, location_id')
          .eq('id', authUser.id)
          .single());
      }
      if (error || !data) {
        console.error('[BackOfficeApp] user_profiles query failed:', error?.message);
        setOrgCtx({ role: null, boAccess: true, orgId: null, orgName: 'Serv OS', locationId: null, locationName: null });
        return;
      }
      profile = data;

      // Step 2: resolve effective location
      let overrideLocId = null;
      try { overrideLocId = JSON.parse(localStorage.getItem('rpos-bo-location') || 'null'); } catch (e) { console.warn('[BackOfficeApp] bad rpos-bo-location:', e?.message); }

      // v5.5.236: validate override belongs to this user
      if (overrideLocId && overrideLocId !== profile.location_id && profile.role !== 'super_admin') {
        try {
          const { fetchAccessibleLocations } = await import('../lib/db.js');
          const { data: accessible } = await fetchAccessibleLocations();
          const accessibleIds = new Set((accessible || []).map(l => l.id));
          if (!accessibleIds.has(overrideLocId)) {
            console.warn('[BackOfficeApp] rpos-bo-location', overrideLocId, 'not in user accessible locations — clearing');
            localStorage.removeItem('rpos-bo-location');
            overrideLocId = null;
          }
        } catch (e) { console.warn('[BackOfficeApp] accessible locations check failed:', e?.message); }
      }

      let effectiveLocId = overrideLocId || profile.location_id;

      // Auto-select first accessible location if none resolved
      if (!effectiveLocId) {
        try {
          const { fetchAccessibleLocations } = await import('../lib/db.js');
          const { data: accessible } = await fetchAccessibleLocations();
          if (accessible?.length) {
            effectiveLocId = accessible[0].id;
            console.log('[BackOfficeApp] auto-selected first accessible location:', effectiveLocId, accessible[0].name);
          }
        } catch (e) { console.warn('[BackOfficeApp] accessible locations auto-select failed:', e?.message); }
      }

      // Step 3: fetch org + location names separately (can fail gracefully)
      let orgName = 'Serv OS';
      let locationName = null;
      try {
        const [orgRes, locRes] = await Promise.all([
          profile.org_id
            ? supabase.from('organisations').select('name').eq('id', profile.org_id).single()
            : Promise.resolve({ data: null }),
          effectiveLocId
            ? supabase.from('locations').select('name').eq('id', effectiveLocId).single()
            : Promise.resolve({ data: null }),
        ]);
        if (orgRes.data?.name) orgName = orgRes.data.name;
        if (locRes.data?.name) locationName = locRes.data.name;
      } catch (e) { console.warn('[BackOfficeApp] org/location name lookup failed:', e?.message); }

      setOrgCtx({
        role: profile.role,
        boAccess: profile.role === 'super_admin' || profile.bo_access !== false,
        orgId: profile.org_id,
        orgName,
        locationId: effectiveLocId,
        locationName,
      });
      if (effectiveLocId) {
        setResolvedLocationId(effectiveLocId);
        loadLocationData(effectiveLocId);
      }
    })();
  }, [authUser]);

  const loadLocationData = async (locationId) => {
    if (!locationId) return;
    const { fetchMenus, fetchMenuCategories, fetchMenuItems, fetchFloorPlan } = await import('../lib/db.js');
    const [menusRes, catsRes, itemsRes, floorRes, modGroupsRes] = await Promise.all([
      fetchMenus(locationId),
      fetchMenuCategories(locationId),
      fetchMenuItems(locationId),
      fetchFloorPlan(locationId),
      // Load modifier group definitions from Supabase
      supabase ? supabase.from('modifier_groups').select('*').eq('location_id', locationId).order('sort_order') : { data: null },
    ]);
    const { useStore } = await import('../store/index.js');
    const patch = {};
    if (menusRes.data?.length)   patch.menus          = menusRes.data;
    if (catsRes.data?.length)    patch.menuCategories  = catsRes.data.map(c => ({
      ...c,
      menuId: c.menu_id ?? c.menuId,
      parentId: c.parent_id ?? c.parentId,
      accountingGroup: c.accounting_group ?? c.accountingGroup,
      sortOrder: c.sort_order ?? c.sortOrder,
      defaultCourse: c.default_course ?? c.defaultCourse ?? 1,
      spacerSlots: c.spacer_slots ?? c.spacerSlots ?? [],
    }));
    if (itemsRes.data?.length)   patch.menuItems       = itemsRes.data.map(item => ({
      ...item,
      menuName:    item.menu_name    ?? item.menuName    ?? item.name ?? 'Item',
      receiptName: item.receipt_name ?? item.receiptName ?? item.name ?? 'Item',
      kitchenName: item.kitchen_name ?? item.kitchenName ?? item.name ?? 'Item',
      sortOrder:   item.sort_order   ?? item.sortOrder   ?? 0,
      isDefault:   item.is_default   ?? item.isDefault,
      soldAlone:   item.sold_alone   ?? item.soldAlone,
      parentId:    item.parent_id    ?? item.parentId,
      assignedModifierGroups: item.assigned_modifier_groups ?? item.assignedModifierGroups ?? [],
      // THE BUG: this line was missing for months. Without it, BackOfficeApp's loader leaves
      // assignedInstructionGroups undefined on every item. MenuManager shows empty. Push
      // builds a snapshot where JSON.stringify drops the undefined field — POS receives
      // items without instruction groups — from the user's POV they “vanish on push”.
      // The DB still has the data in assigned_instruction_groups (jsonb) the whole time.
      assignedInstructionGroups: item.assigned_instruction_groups ?? item.assignedInstructionGroups ?? [],
      taxRateId:   item.tax_rate_id  ?? item.taxRateId  ?? null,
      taxOverrides: item.tax_overrides ?? item.taxOverrides ?? {},
      // v4.6.3: ownership / sharing fields (added by v4.6.0 schema migration)
      scope:        item.scope         ?? 'local',
      orgId:        item.org_id        ?? item.orgId        ?? null,
      masterId:     item.master_id     ?? item.masterId     ?? null,
      lockPricing:  item.lock_pricing  ?? item.lockPricing  ?? false,
      lockedFields: item.locked_fields ?? item.lockedFields ?? [],
    }));
    // v5.5.2: map raw floor_tables rows to the camelCase shape the rest of the app expects
    // (maxCovers, sortOrder) AND preserve locationId so the cross-location guard in
    // upsertFloorTable has data to work with. Previously the BO just spread raw DB rows in.
    if (floorRes.data?.tables?.length) patch.tables = floorRes.data.tables.map(t => ({
      id: t.id,
      label: t.label,
      x: t.x, y: t.y, w: t.w, h: t.h,
      shape: t.shape,
      maxCovers: t.max_covers ?? t.maxCovers ?? 4,
      section: t.section ?? null,
      sortOrder: t.sort_order ?? t.sortOrder ?? 0,
      locationId: t.location_id,
      status: 'available',
      session: null,
    }));
    // Map modifier groups from snake_case DB columns to camelCase store format
    if (modGroupsRes.data?.length) patch.modifierGroupDefs = modGroupsRes.data.map(g => ({
      id: g.id, name: g.name, min: g.min ?? 0, max: g.max ?? 1,
      selectionType: g.selection_type ?? 'single',
      options: g.options ?? [],
      sortOrder: g.sort_order ?? 0,
    }));

    // Load tax rates for this location
    if (supabase) {
      const { data: taxRates } = await supabase
        .from('tax_rates')
        .select('*')
        .eq('location_id', locationId)
        .eq('active', true)
        .order('rate', { ascending: false });
      if (taxRates?.length) patch.taxRates = taxRates.map(r => ({
        id: r.id, name: r.name, code: r.code,
        rate: parseFloat(r.rate), type: r.type,
        appliesTo: r.applies_to || ['all'],
        isDefault: r.is_default, active: r.active,
      }));
    }

    if (Object.keys(patch).length) useStore.setState(patch);
  };

  // Show spinner while checking session
  if (!authChecked) return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--bg)' }}>
      <div style={{ color:'var(--t3)', fontSize:13 }}>Loading…</div>
    </div>
  );

  // Show login screen if not authenticated
  if (!authUser && !isMock) return <BOLogin onLogin={setAuthUser} />;

  // v5.5.15: gate access to the back office on the bo_access flag.
  // While orgCtx is null we're still loading the profile — show spinner.
  // If profile loaded and boAccess is explicitly false, show denial screen
  // with sign-out. super_admin always passes (set in the useEffect above).
  if (!isMock && authUser && orgCtx === null) return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--bg)' }}>
      <div style={{ color:'var(--t3)', fontSize:13 }}>Loading profile…</div>
    </div>
  );
  if (!isMock && authUser && orgCtx && !orgCtx.boAccess) return (
    <div style={{ minHeight:'100vh', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', background:'var(--bg)', color:'var(--t1)', padding:32, gap:18 }}>
      <div style={{ fontSize:36 }}>🔒</div>
      <div style={{ fontSize:18, fontWeight:800, color:'var(--t1)' }}>No back-office access</div>
      <div style={{ fontSize:13, color:'var(--t3)', textAlign:'center', maxWidth:360, lineHeight:1.5 }}>
        Your account ({authUser.email}) doesn't have permission to use the back office.
        Contact your administrator if you think this is wrong.
      </div>
      <button onClick={() => { localStorage.removeItem('rpos-bo-location'); supabase.auth.signOut().then(() => window.location.reload()); }}
        style={{ marginTop:8, padding:'10px 22px', borderRadius:8, border:'1px solid var(--bdr)', background:'transparent', color:'var(--t2)', cursor:'pointer', fontFamily:'inherit', fontSize:13 }}>
        Sign out
      </button>
    </div>
  );

  const groups = [...new Set(NAV.map(n => n.group))];

  return (
    <div style={{
      display:'flex', height:'100vh', background:'var(--bg)', color:'var(--t1)',
      fontFamily:'inherit', overflow:'hidden',
    }}>
      {/* ── Sidebar ─────────────────────────────────────── */}
      <div style={{
        width:228, background:'var(--bg1)', borderRight:'1px solid var(--bdr)',
        display:'flex', flexDirection:'column', flexShrink:0,
      }}>
        {/* Brand */}
        <div style={{ padding:'16px 16px 14px', borderBottom:'1px solid var(--bdr)' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <div style={{
              width:34, height:34, borderRadius:9,
              background:'var(--acc)', display:'flex',
              alignItems:'center', justifyContent:'center',
              fontSize:16, fontWeight:800, color:'#0b0c10', flexShrink:0,
            }}>{orgCtx?.orgName?.[0] || 'R'}</div>
            <div>
              <div style={{ fontSize:13, fontWeight:800, color:'var(--t1)', letterSpacing:'-.01em' }}>
                {orgCtx?.orgName || 'Serv OS'}
              </div>
              <div style={{ fontSize:10, color:'var(--acc)', fontWeight:700, letterSpacing:'.05em', textTransform:'uppercase' }}>
                {orgCtx?.locationName || 'Back Office'}
              </div>
            </div>
          </div>
        </div>

        {/* Nav groups */}
        <div style={{ flex:1, overflowY:'auto', padding:'12px 8px' }}>
          {groups.map(group => (
            <div key={group} style={{ marginBottom:20 }}>
              <div style={{
                fontSize:9, fontWeight:800, color:'var(--t4)',
                textTransform:'uppercase', letterSpacing:'.1em',
                padding:'0 10px', marginBottom:4,
              }}>{group}</div>
              {NAV.filter(n => n.group === group).map(n => {
                const active = section === n.id;
                return (
                  <button key={n.id} onClick={() => setSection(n.id)} style={{
                    width:'100%', padding:'8px 10px', borderRadius:9,
                    cursor:'pointer', textAlign:'left', fontSize:13,
                    fontWeight: active ? 700 : 400, border:'none',
                    fontFamily:'inherit',
                    background: active ? 'var(--acc-d)' : 'transparent',
                    color: active ? 'var(--acc)' : 'var(--t2)',
                    marginBottom:1, display:'flex', alignItems:'center', gap:9,
                    borderLeft:`2px solid ${active ? 'var(--acc)' : 'transparent'}`,
                    transition:'all .1s',
                  }}>
                    <span style={{ fontSize:14, width:18, textAlign:'center' }}>{n.icon}</span>
                    {n.label}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer */}
        <div style={{ padding:'10px 8px 14px', borderTop:'1px solid var(--bdr)' }}>
          <div style={{
            padding:'8px 10px', marginBottom:6,
            fontSize:12, color:'var(--t3)',
            display:'flex', alignItems:'center', gap:8,
          }}>
            <div style={{
              width:26, height:26, borderRadius:'50%',
              background:'var(--acc-d)', border:'1.5px solid var(--acc-b)',
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:10, fontWeight:800, color:'var(--acc)', flexShrink:0,
            }}>{staff?.initials || 'MG'}</div>
            <div>
              <div style={{ fontSize:12, fontWeight:700, color:'var(--t1)' }}>{staff?.name || 'Manager'}</div>
              <div style={{ fontSize:10, color:'var(--t4)' }}>{staff?.role || 'Admin'}</div>
            </div>
          </div>
          <button onClick={() => { localStorage.removeItem('rpos-device'); localStorage.removeItem('rpos-device-config'); localStorage.setItem('rpos-device-mode','pos'); window.location.href = '?mode=pos'; }} style={{
            width:'100%', padding:'9px 10px', borderRadius:9,
            cursor:'pointer', textAlign:'left', fontSize:12,
            fontWeight:600, border:'1px solid var(--bdr)',
            fontFamily:'inherit', background:'var(--bg3)',
            color:'var(--t2)', display:'flex', alignItems:'center', gap:8,
            transition:'all .1s', marginBottom:6,
          }}>
            <span style={{ fontSize:16 }}>←</span> Back to POS
          </button>
          {!isMock && (
            <button onClick={() => setShowLocationSwitcher(true)} style={{
              width:'100%', padding:'9px 10px', borderRadius:9,
              cursor:'pointer', textAlign:'left', fontSize:12,
              fontWeight:600, border:'1px solid var(--bdr)',
              fontFamily:'inherit', background:'transparent',
              color:'var(--t3)', display:'flex', alignItems:'center', gap:8,
              marginBottom:6, transition:'all .1s',
            }}
              title={orgCtx?.locationName ? `Currently at ${orgCtx.locationName}` : 'Switch location'}>
              <span>📍</span>
              <span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {orgCtx?.locationName || 'Switch location'}
              </span>
              <span style={{ fontSize:10, color:'var(--t4)' }}>▾</span>
            </button>
          )}
          {authUser && !isMock && (
            <button onClick={() => { localStorage.removeItem('rpos-bo-location'); clearResolvedLocationId(); supabase.auth.signOut().then(() => window.location.reload()); }} style={{
              width:'100%', padding:'8px 10px', borderRadius:9,
              cursor:'pointer', textAlign:'left', fontSize:12,
              fontWeight:600, border:'1px solid var(--bdr)',
              fontFamily:'inherit', background:'transparent',
              color:'var(--t4)', display:'flex', alignItems:'center', gap:8,
            }}>
              <span>⎋</span> Sign out
            </button>
          )}
          {!isMock && (
            <div style={{ height: 4 }} />
          )}
        </div>
      </div>

      {/* ── Main content ─────────────────────────────────── */}
      <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden' }}>
        {/* Top bar */}
        <div style={{
          height:52, borderBottom:'1px solid var(--bdr)',
          background:'var(--bg1)', display:'flex',
          alignItems:'center', justifyContent:'space-between',
          padding:'0 24px', flexShrink:0,
        }}>
          <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)' }}>
            {NAV.find(n => n.id === section)?.label}
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            {/* Quick nav — switch between modes */}
            <div style={{ display:'flex', gap:4 }}>
              <a href="?mode=pos" onClick={() => { localStorage.removeItem('rpos-device'); localStorage.removeItem('rpos-device-config'); }} style={{ padding:'5px 12px', borderRadius:7, border:'1px solid var(--bdr)', background:'var(--bg3)', color:'var(--t2)', fontSize:12, fontWeight:700, cursor:'pointer', fontFamily:'inherit', textDecoration:'none', display:'flex', alignItems:'center', gap:5 }}>🖥 POS</a>
              <a href="?mode=office" style={{ padding:'5px 12px', borderRadius:7, border:'1px solid var(--acc-b)', background:'var(--acc-d)', color:'var(--acc)', fontSize:12, fontWeight:700, cursor:'pointer', fontFamily:'inherit', textDecoration:'none' }}>🏢 Office</a>
              <a href="?mode=admin" style={{ padding:'5px 12px', borderRadius:7, border:'1px solid var(--bdr)', background:'var(--bg3)', color:'var(--t3)', fontSize:12, fontWeight:700, cursor:'pointer', fontFamily:'inherit', textDecoration:'none' }}>🔐 Admin</a>
            </div>
            {/* Push to POS button */}
            <PushToPOSButton />
            <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, color:'var(--t3)' }}>
              <div style={{ width:7, height:7, borderRadius:'50%', background:'var(--grn)', boxShadow:'0 0 6px var(--grn)' }}/>
              <span>Live</span>
              <span style={{ color:'var(--bdr2)' }}>·</span>
              <span>{new Date().toLocaleDateString('en-GB', { weekday:'short', day:'numeric', month:'short' })}</span>
              <span style={{ color:'var(--bdr2)' }}>·</span>
              <span style={{ fontFamily:'monospace', fontSize:11, color:'var(--t4)' }}>{VERSION}</span>
            </div>
          </div>
        </div>

        {/* v5.5.158: every BO section now follows the same full-width
            responsive spec. The .bo-page-shell class in globals.css clamps
            the inner page wrapper to max-width 1600px, applies fluid
            padding (16px → 48px), and overrides any per-section maxWidth
            via !important so we don't have to edit 20 files individually. */}
        <div className="bo-page-shell">
          {section === 'overview'   && <BOOverview setSection={setSection} orgCtx={orgCtx} />}
          {section === 'menu'       && <MenuManager />}
          {section === 'floorplan'  && <FloorPlanBuilder />}
          {section === 'inventory'  && <Inventory />}
          {section === 'profiles'   && <DeviceProfiles />}
          {section === 'devices'    && <DeviceRegistry />}
          {section === 'kiosks'     && <KioskRegistry />}
          {section === 'online'     && <OnlineOrdering setSection={setSection} />}
          {section === 'printers'   && <PrinterRegistry />}
          {section === 'cardreaders'&& <CardReaders />}
          {section === 'cashdrawers' && <CashDrawers />}
          {section === 'staff'      && <StaffManager />}
          {section === 'printing'   && <PrintRouting />}
          {section === 'reports'    && <BOReports />}
          {section === 'shift'      && <Shift />}
          {section === 'eod'        && <EODClose />}
          {section === 'pettycash'  && <PettyCash />}
          {section === 'customers'  && <Customers />}
          {section === 'admin'       && <CompanyAdmin />}
          {section === 'ai'         && <AIAssistantSection />}
          {section === 'network'     && <NetworkStatus />}
          {section === 'location'   && <LocationSettings />}
          {section === 'receipt' && <ReceiptBranding/>}
          {section === 'tax'        && <TaxManager />}
          {section === 'discounts'  && <DiscountManager />}
          {section === 'challenge21' && <Challenge21 />}
          {section === 'giftcards' && <GiftCards />}
          {section === 'loyalty' && <LoyaltyManager />}
          {section === 'messages' && <MessageTemplates />}
        </div>
      </div>
      {showLocationSwitcher && <LocationSwitcher onClose={() => setShowLocationSwitcher(false)} />}
    </div>
  );
}

// ── Push to POS button ────────────────────────────────────────────────────────
function PushToPOSButton() {
  const { pendingBOChanges, clearBOChanges, tables, locationSections, menuItems, menuCategories, menus, staff } = useStore();
  const [pushing, setPushing] = useState(false);
  const [justPushed, setJustPushed] = useState(false);

  const handlePush = async () => {
    setPushing(true);

    // Build config snapshot — layout + menu config (not operational/session state)
    // Include print routing config in snapshot
    // Load routing from Supabase (source of truth), fall back to localStorage
    let printRouting = { centres:[], routing:{} };
    let printers = [];
    try {
      const locId = await getLocationId();
      if (locId && supabase) {
        const [rtRes, prnRes] = await Promise.all([
          supabase.from('print_routing').select('centres,routing').eq('location_id', locId).single(),
          supabase.from('printers').select('*').eq('location_id', locId),
        ]);
        if (rtRes.data) printRouting = { centres: rtRes.data.centres||[], routing: rtRes.data.routing||{} };
        if (prnRes.data) printers = prnRes.data.map(r => ({ id:r.id, name:r.name, model:r.meta?.model, connectionType:r.connection, address:r.ip, port:r.port||9100, paperWidth:r.paper_width||80, roles:r.meta?.roles||[], location:r.meta?.location||'' }));
      }
    } catch {}
    // Fallback to localStorage if Supabase failed
    if (!printRouting.centres.length) {
      try { printRouting = JSON.parse(localStorage.getItem('rpos-print-routing') || 'null') || { centres:[], routing:{} }; } catch {}
    }
    if (!printers.length) {
      try { printers = JSON.parse(localStorage.getItem('rpos-printers') || '[]'); } catch {}
    }
    const deviceProfiles = (() => { try { return JSON.parse(localStorage.getItem('rpos-device-profiles') || 'null') || []; } catch { return []; } })();

    // Resolve location once, stamp it on the snapshot. v5.5.2: lets the POS hydrator
    // detect cross-location config-push leakage and lets every table in the snapshot
    // carry its source location_id (used by the cross-location upsert guard).
    let snapshotLocationId = null;
    try {
      const { getLocationId } = await import('../lib/supabase.js');
      snapshotLocationId = await getLocationId();
    } catch (e) { console.warn('[handlePush] snapshot locationId resolve failed:', e?.message); }

    const snapshot = {
      version: Date.now(),
      pushedAt: new Date().toISOString(),
      pushedBy: staff?.name || 'Manager',
      locationId: snapshotLocationId,
      printRouting: printRouting || { centres:[], routing:{} },
      printers,
      tables: tables.map(t => ({
        id:t.id, label:t.label, x:t.x, y:t.y, w:t.w, h:t.h,
        shape:t.shape, maxCovers:t.maxCovers, section:t.section,
        locationId: t.locationId || snapshotLocationId,
      })),
      locationSections,
      menus,
      menuItems,
      menuCategories,
      taxRates: useStore.getState().taxRates || [],
      discountPresets: useStore.getState().discountPresets || [],
      discountRules: useStore.getState().discountRules || [],
      quickScreenIds: useStore.getState().quickScreenIds || [],
      changeCount: pendingBOChanges,
      profiles: deviceProfiles,
      modifierGroupDefs: useStore.getState().modifierGroupDefs || [],
      instructionGroupDefs: useStore.getState().instructionGroupDefs || [],
    };

    // Persist snapshot so POS tabs that open later can still receive it
    try {
      localStorage.setItem('rpos-config-snapshot', JSON.stringify(snapshot));
    } catch {}

    // Write to Supabase so physical devices on other machines receive it
    import('../lib/db.js').then(async ({ insertConfigPush, upsertMenuItem, upsertMenuCategory }) => {
      const { getLocationId } = await import('../lib/supabase.js');
      const locationId = await getLocationId();

      // Write config push (for realtime notification to POS devices)
      insertConfigPush({ pushed_by: staff?.name || 'Manager', snapshot, change_count: pendingBOChanges }, locationId);

      // Also write ALL menu items and categories to Supabase so they're queryable
      // This makes Supabase the source of truth, not just the snapshot
      if (locationId && menuItems?.length) {
        for (const item of menuItems.filter(i => !i.archived)) {
          upsertMenuItem({
            ...item,
            location_id: locationId,
            tax_rate_id: item.taxRateId ?? item.tax_rate_id ?? null,
            tax_overrides: item.taxOverrides ?? item.tax_overrides ?? {},
          }, locationId).catch(e => console.warn('[push] upsertMenuItem failed for', item.id, item.name, '—', e?.message || e));
        }
      }
      if (locationId && menuCategories?.length) {
        for (const cat of menuCategories) {
          upsertMenuCategory({ ...cat, location_id: locationId }, locationId).catch(e => console.warn('[push] upsertMenuCategory failed for', cat.id, cat.label, '—', e?.message || e));
        }
      }
    });

    // Broadcast to all open POS terminals in this browser session
    broadcastConfigPush(snapshot);

    clearBOChanges();
    setPushing(false);
    setJustPushed(true);
    setTimeout(() => setJustPushed(false), 3000);
  };

  if (justPushed) {
    return (
      <div style={{ display:'flex', alignItems:'center', gap:7, padding:'6px 14px', borderRadius:10, background:'var(--grn-d)', border:'1px solid var(--grn-b)' }}>
        <div style={{ width:7, height:7, borderRadius:'50%', background:'var(--grn)' }}/>
        <span style={{ fontSize:12, fontWeight:700, color:'var(--grn)' }}>Pushed to all terminals</span>
      </div>
    );
  }

  return (
    <button
      onClick={handlePush}
      disabled={pushing}
      style={{
        display:'flex', alignItems:'center', gap:8,
        padding:'7px 16px', borderRadius:10, cursor:'pointer',
        fontFamily:'inherit', fontSize:13, fontWeight:700, border:'none',
        background: pendingBOChanges > 0 ? 'var(--acc)' : 'var(--bg3)',
        color: pendingBOChanges > 0 ? '#0b0c10' : 'var(--t3)',
        transition:'all .15s',
        boxShadow: pendingBOChanges > 0 ? '0 0 12px var(--acc-b)' : 'none',
      }}
    >
      {pendingBOChanges > 0 && (
        <span style={{
          fontSize:10, fontWeight:800, padding:'1px 6px', borderRadius:20,
          background:'rgba(0,0,0,.2)', color:'inherit',
        }}>{pendingBOChanges}</span>
      )}
      <span>Push to POS</span>
      <span style={{ fontSize:15 }}>→</span>
    </button>
  );
}
function BOOverview({ setSection, orgCtx }) {
  const { closedChecks, tables, staff: currentStaff } = useStore();

  // v5.5.296: Fetch live data directly from Supabase instead of relying on the
  // store's devices/sessions (which are only populated on POS, not back office).
  const locId = orgCtx?.locationId || null;
  const [liveDevices, setLiveDevices] = useState([]);
  const [liveSessions, setLiveSessions] = useState([]);

  useEffect(() => {
    if (!locId || isMock || !supabase) return;
    // Fetch registered devices for this location
    supabase.from('devices').select('id, name, status, type')
      .eq('location_id', locId)
      .then(({ data }) => { if (data) setLiveDevices(data); });
    // Fetch active table sessions (open orders on tables right now)
    supabase.from('active_sessions').select('table_id, session')
      .eq('location_id', locId)
      .then(({ data }) => { if (data) setLiveSessions(data); });
  }, [locId]);

  // Today = since midnight local time
  // v5.5.279: scope by locationId — previously showed revenue from ALL locations
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayChecks = closedChecks.filter(c =>
    c.closedAt && new Date(c.closedAt) >= todayStart &&
    (!locId || c.locationId === locId)
  );

  // Open orders = active sessions with items (not yet paid)
  const activeSessions = liveSessions.filter(s => s.session?.items?.length > 0);
  const openOrdersValue = activeSessions
    .reduce((sum, s) => sum + s.session.items.reduce((t, i) => t + (i.price || 0) * (i.qty || 1), 0), 0);
  const openOrdersCount = activeSessions.length;

  const revenue     = todayChecks.reduce((s, c) => s + c.total, 0);
  const covers      = todayChecks.reduce((s, c) => s + (c.covers || 1), 0);
  const onlineDevs  = liveDevices.filter(d => d.status === 'active').length;
  const totalTables = tables.filter(t => !t.parentId).length;
  const activeTbls  = liveSessions.length;

  const stats = [
    { label:"Revenue today",   value:`£${revenue.toFixed(2)}`, color:'var(--acc)', sub:`${todayChecks.length} closed checks` },
    { label:'Covers today',    value:covers,                    color:'var(--blu)', sub:`£${covers > 0 ? (revenue / covers).toFixed(2) : '0.00'}/head` },
    { label:'Tables active',   value:activeTbls,                color:'var(--grn)', sub:`of ${totalTables} tables` },
    { label:'Terminals online',value:`${onlineDevs}/${liveDevices.length}`, color: onlineDevs === liveDevices.length && liveDevices.length > 0 ? 'var(--grn)' : 'var(--acc)', sub:'this site' },
  ];

  const quickActions = [
    { icon:'🍽', label:'Edit menu',        sub:'Update items, prices, allergens',  target:'menu' },
    { icon:'⬚',  label:'Floor plan',       sub:'Move tables, add sections',       target:'floorplan' },
    { icon:'📋', label:'Device profiles',  sub:'Configure terminal behaviour',    target:'profiles' },
    { icon:'📱', label:'Add terminal',       sub:'Pair a new Sunmi device',                    target:'devices' },
    { icon:'🖨', label:'Manage printers',    sub:'Add NT311 and other ESC/POS printers',       target:'printers' },
    { icon:'👥', label:'Manage staff',       sub:'Add servers, change PINs',                   target:'staff' },
    { icon:'🗺', label:'Production printing', sub:'Route orders to kitchen & receipt printers', target:'printing' },
  ];

  return (
    <div style={{ flex:1, overflowY:'auto', padding:28 }}>
      <SupabaseSetup />

      {/* No location warning */}
      {!orgCtx?.locationId && !isMock && (
        <div style={{ padding:'14px 18px', borderRadius:10, background:'#fef9c3', border:'1px solid #fde047', marginBottom:20, fontSize:13 }}>
          <strong>⚠️ No location assigned to your account.</strong> Go to <button onClick={() => setSection('admin')} style={{ background:'none', border:'none', cursor:'pointer', color:'var(--acc)', fontWeight:700, fontSize:13, padding:0, textDecoration:'underline' }}>Company Admin</button> → create an organisation and location first.
        </div>
      )}

      <div style={{ marginBottom:28 }}>
        <div style={{ fontSize:11, fontWeight:700, color:'var(--acc)', letterSpacing:'.08em', textTransform:'uppercase', marginBottom:4 }}>
          {orgCtx?.locationName ? `${orgCtx.orgName} · ${orgCtx.locationName}` : orgCtx?.orgName || 'Serv OS'}
        </div>
        <div style={{ fontSize:24, fontWeight:800, color:'var(--t1)', letterSpacing:'-.01em', marginBottom:4 }}>
          Good {new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}
          {currentStaff?.name ? `, ${currentStaff.name}` : ''}
        </div>
        <div style={{ fontSize:13, color:'var(--t3)' }}>
          {new Date().toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long', year:'numeric' })}
        </div>
      </div>

      {/* KPI row */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:28 }}>
        {stats.map(s => (
          <div key={s.label} style={{
            background:'var(--bg1)', border:'1px solid var(--bdr)',
            borderRadius:14, padding:'18px 20px',
          }}>
            <div style={{ fontSize:10, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:10 }}>{s.label}</div>
            <div style={{ fontSize:28, fontWeight:800, color:s.color, fontFamily:'var(--font-mono)', letterSpacing:'-.02em' }}>{s.value}</div>
            <div style={{ fontSize:11, color:'var(--t3)', marginTop:5 }}>{s.sub}</div>
          </div>
        ))}
      </div>

      {/* Quick actions */}
      <div style={{ fontSize:13, fontWeight:700, color:'var(--t2)', marginBottom:12 }}>Quick actions</div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:28 }}>
        {quickActions.map(a => (
          <button key={a.label} onClick={() => setSection(a.target)} style={{
            background:'var(--bg1)', border:'1px solid var(--bdr)',
            borderRadius:14, padding:'16px 18px', cursor:'pointer',
            textAlign:'left', fontFamily:'inherit', transition:'all .14s',
            display:'flex', alignItems:'flex-start', gap:12,
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--acc-b)'; e.currentTarget.style.background = 'var(--acc-d)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--bdr)'; e.currentTarget.style.background = 'var(--bg1)'; }}>
            <span style={{ fontSize:22, flexShrink:0 }}>{a.icon}</span>
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)', marginBottom:3 }}>{a.label}</div>
              <div style={{ fontSize:11, color:'var(--t3)' }}>{a.sub}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Terminal simulator */}
      <div style={{ fontSize:13, fontWeight:700, color:'var(--t2)', marginBottom:12 }}>Open terminals for testing</div>
      <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:14, padding:'18px 20px', marginBottom:20 }}>
        <div style={{ fontSize:12, color:'var(--t3)', marginBottom:16, lineHeight:1.5 }}>
          Each URL below opens an independent POS terminal in a new tab — different profile, separate session storage. Open multiple at once to test how the bar terminal differs from the counter.
        </div>
        <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:8 }}>
          {[
            { param:'counter',  label:'Counter 1',    profile:'Main counter',    icon:'🖥', color:'#3b82f6', desc:'Full features, all order types' },
            { param:'counter2', label:'Counter 2',    profile:'Main counter',    icon:'🖥', color:'#3b82f6', desc:'Second counter terminal' },
            { param:'bar',      label:'Bar',          profile:'Bar terminal',    icon:'🍸', color:'#e8a020', desc:'Bar tabs default, dine-in only' },
            { param:'handheld', label:'Handheld 1',   profile:'Server handheld', icon:'📱', color:'#22c55e', desc:'POS default, dine-in only' },
            { param:'kiosk',    label:'Kiosk 1',      profile:'Kiosk',           icon:'⬜', color:'#a855f7', desc:'Self-service, no staff features' },
            { param:'kds',      label:'KDS',          profile:'Kitchen display',  icon:'📋', color:'#ef4444', desc:'Kitchen display only' },
          ].map(t => {
            const url = `${window.location.origin}${window.location.pathname}?t=${t.param}`;
            return (
              <div key={t.param} style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 12px', background:'var(--bg3)', borderRadius:10, border:'1px solid var(--bdr)' }}>
                <span style={{ fontSize:20, flexShrink:0 }}>{t.icon}</span>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:13, fontWeight:700, color:'var(--t1)' }}>{t.label}</div>
                  <div style={{ fontSize:10, color:'var(--t4)', marginTop:1 }}>{t.desc}</div>
                </div>
                <a href={url} target="_blank" rel="noopener" style={{
                  padding:'5px 12px', borderRadius:8, textDecoration:'none',
                  background:`${t.color}22`, border:`1px solid ${t.color}44`,
                  color:t.color, fontSize:11, fontWeight:700, flexShrink:0, cursor:'pointer',
                }}>Open ↗</a>
              </div>
            );
          })}
        </div>
        <div style={{ marginTop:12, fontSize:11, color:'var(--t4)', padding:'8px 12px', background:'var(--bg3)', borderRadius:8 }}>
          💡 Each tab has independent state — ordering on the bar tab doesn't affect the counter tab until Supabase sync is enabled in Phase 2
        </div>
      </div>
    </div>
  );
}

// ── Online ordering section ─────────────────────────────────────────────────
// Phase 3a — quick-glance hub for the online + QR surfaces. The persistent
// settings (slug, online_enabled, qr_enabled, opening_hours) live in
// Location Settings for now; this page surfaces what's running, gives a
// one-click path to edit the controls, and shows the live customer URLs
// for sharing / QR-printing. Phase 4 will add the order queue and the
// branding editor here too.
function OnlineOrderingSection({ setSection }) {
  const [loading, setLoading] = useState(true);
  const [row, setRow] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { platformSupabase, getLocationId } = await import('../lib/supabase');
        if (!platformSupabase) { setLoading(false); return; }
        const locId = await getLocationId().catch(() => null);
        let r = null;
        if (locId) {
          const { data } = await platformSupabase.from('locations')
            .select('id, name, online_slug, online_enabled, qr_enabled, opening_hours, timezone')
            .eq('ops_location_id', locId).maybeSingle();
          r = data;
          if (!r) {
            const { data: r2 } = await platformSupabase.from('locations')
              .select('id, name, online_slug, online_enabled, qr_enabled, opening_hours, timezone')
              .eq('id', locId).maybeSingle();
            r = r2;
          }
        }
        if (alive) setRow(r);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, []);

  const ROOT = CUSTOMER_ROOT;
  const slug = row?.online_slug;
  const onlineEnabled = !!row?.online_enabled;
  const qrEnabled     = !!row?.qr_enabled;

  return (
    <div style={{ padding:'32px 40px', maxWidth:880 }}>
      <div style={{ fontSize:22, fontWeight:800, color:'var(--t1)', marginBottom:4 }}>🌐 Online ordering</div>
      <div style={{ fontSize:13, color:'var(--t3)', marginBottom:24 }}>
        Customer-facing surfaces for online (collection / delivery) and QR table-side ordering.
      </div>

      {loading && <div style={{ color:'var(--t4)', fontSize:13 }}>Loading…</div>}

      {!loading && !row && (
        <div style={{ padding:'14px 16px', borderRadius:12, background:'var(--bg1)', border:'1px solid var(--bdr)', color:'var(--t3)', fontSize:13 }}>
          Couldn't load this location's online ordering settings. Open <button onClick={() => setSection('location')} style={linkBtnStyle()}>Location settings</button> to configure.
        </div>
      )}

      {!loading && row && (
        <>
          {/* Status grid */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(260px, 1fr))', gap:14, marginBottom:24 }}>
            <StatusCard
              title="🌐 Online ordering"
              enabled={onlineEnabled}
              slug={slug}
              urlSuffix=""
              root={ROOT}
              desc="Remote orders — collection / delivery, customer details, Stripe checkout."
              setSection={setSection}/>
            <StatusCard
              title="📱 QR table-side"
              enabled={qrEnabled}
              slug={slug}
              urlSuffix="/t/<table-id>"
              root={ROOT}
              desc="Diners scan a QR at their table — items fire into that table's session on the POS."
              setSection={setSection}/>
          </div>

          {/* Quick actions */}
          <div style={{ padding:'18px 20px', background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:14, marginBottom:18 }}>
            <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)', marginBottom:8 }}>Manage</div>
            <div style={{ fontSize:12, color:'var(--t4)', marginBottom:12, lineHeight:1.6 }}>
              Slug, enable toggles and opening hours all live in Location Settings for now.
              Phase 4 will move branding (logo, colors, hero image) and an order-feed view in here.
            </div>
            <div style={{ display:'flex', gap:10, flexWrap:'wrap' }}>
              <button onClick={() => setSection('location')} style={primaryBtn()}>
                Open Location Settings
              </button>
              {slug && (
                <a href={customerUrl(slug, '')} target="_blank" rel="noopener"
                  style={{ ...secondaryBtn(), textDecoration:'none' }}>
                  Preview online ↗
                </a>
              )}
              {slug && (
                <a href={customerUrl(slug, '/t/t1')} target="_blank" rel="noopener"
                  style={{ ...secondaryBtn(), textDecoration:'none' }}>
                  Preview QR (table t1) ↗
                </a>
              )}
              {slug && (
                <a href={customerUrl(slug, '/gift')} target="_blank" rel="noopener"
                  style={{ ...secondaryBtn(), textDecoration:'none' }}>
                  Preview gift cards ↗
                </a>
              )}
              {slug && (
                <a href={customerUrl(slug, '/account')} target="_blank" rel="noopener"
                  style={{ ...secondaryBtn(), textDecoration:'none' }}>
                  Preview loyalty portal ↗
                </a>
              )}
              <button onClick={() => setSection('giftcards')} style={secondaryBtn()}>
                Gift card settings
              </button>
              <button onClick={() => setSection('loyalty')} style={secondaryBtn()}>
                Loyalty program
              </button>
            </div>
          </div>

          {!slug && (
            <div style={{ padding:'12px 14px', borderRadius:10, background:'var(--acc-d)', border:'1px solid var(--acc-b)', color:'var(--acc)', fontSize:12, lineHeight:1.6 }}>
              ⓘ No slug set yet. Set one in Location Settings to enable customer-facing URLs.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function StatusCard({ title, enabled, slug, urlSuffix, root, desc, setSection }) {
  const url = slug ? `https://${slug}.${root}${urlSuffix}` : `(slug).${root}${urlSuffix}`;
  return (
    <div style={{ padding:'18px 20px', background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:14 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
        <div style={{ fontSize:14, fontWeight:700, color:'var(--t1)' }}>{title}</div>
        <span style={{
          padding:'3px 10px', borderRadius:99, fontSize:10, fontWeight:800, letterSpacing:'.04em', textTransform:'uppercase',
          background: enabled ? 'var(--grn-d)' : 'var(--bg3)',
          color: enabled ? 'var(--grn)' : 'var(--t4)',
          border: `1px solid ${enabled ? 'var(--grn-b)' : 'var(--bdr)'}`,
        }}>{enabled ? 'On' : 'Off'}</span>
      </div>
      <div style={{ fontSize:11, color:'var(--t4)', marginBottom:10, lineHeight:1.5 }}>{desc}</div>
      <code style={{ display:'block', padding:'8px 10px', borderRadius:8, background:'var(--bg3)', color: slug ? 'var(--acc)' : 'var(--t4)', fontSize:11, fontFamily:'var(--font-mono, monospace)', overflowWrap:'anywhere' }}>{url}</code>
    </div>
  );
}

function linkBtnStyle() {
  return { background:'transparent', border:'none', color:'var(--acc)', textDecoration:'underline', cursor:'pointer', fontFamily:'inherit', padding:0, fontSize:'inherit' };
}
function primaryBtn() {
  return { padding:'10px 16px', borderRadius:8, border:'none', background:'var(--acc)', color:'#0b0c10', fontSize:12, fontWeight:700, cursor:'pointer', fontFamily:'inherit' };
}
function secondaryBtn() {
  return { padding:'10px 16px', borderRadius:8, border:'1px solid var(--bdr)', background:'var(--bg3)', color:'var(--t2)', fontSize:12, fontWeight:700, cursor:'pointer', fontFamily:'inherit' };
}
