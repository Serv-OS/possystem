import { useState, useCallback, useEffect, useRef, lazy, Suspense } from 'react';
import './styles/globals.css';
// v5.5.3: TENANT FENCE. Run BEFORE any other module that reads location-scoped
// localStorage. Compares the currently-active location to the last-recorded
// active-location tag, and if they differ, wipes every stale rpos-* key. This
// prevents Loc 1's open sessions / closed checks / config snapshot / printer
// list from bleeding into Loc 2 when the same browser is repurposed.
//
// Why this import statement and not a function call: ES modules execute imports
// top-down at module-init time, so the fence runs at app load BEFORE the store
// module (./store), SyncBridge, and useSupabaseInit get a chance to read any
// localStorage keys. The other invocation points (PairingScreen.onPair,
// LocationSwitcher.switchTo, setResolvedLocationId) are belt-and-suspenders.
import { enforceTenantFence } from './lib/supabase';
enforceTenantFence();

import { useStore } from './store';
import { useCardScan } from './lib/useCardScan';
import { resolveSignIn } from './lib/staffAuth';
import { logSignIn } from './lib/signInAudit';
import { loadStaffRoster } from './lib/staffRoster';
import PINScreen from './surfaces/PINScreen';
import ShiftStartPrompt from './components/ShiftStartPrompt';
import POSSurface from './surfaces/POSSurface';
import BarSurface from './surfaces/BarSurface';
import TablesSurface from './surfaces/TablesSurface';
import { KDSSurface } from './surfaces/OtherSurfaces';
import MPOSSurface from './surfaces/MPOSSurface';
import TimeClockSurface from './surfaces/TimeClockSurface';
import OwnerSurface from './surfaces/OwnerSurface';
import MenuBoardSurface from './surfaces/MenuBoardSurface';
import WaitlistSurface from './surfaces/waitlist/WaitlistSurface';
import BookingsSurface from './surfaces/bookings/BookingsSurface';
import ManagerSurface from './surfaces/ManagerSurface';
import StaffSurface from './surfaces/StaffSurface';
import KioskAutoUpdate from './components/KioskAutoUpdate';
import ChangeDueOverlay from './components/ChangeDueOverlay';
import MenuDiag from './components/MenuDiag';
import OnboardingSignSurface from './surfaces/OnboardingSignSurface';
import RyftTestSurface from './surfaces/RyftTestSurface';
import ReaderDemoSurface from './surfaces/ReaderDemoSurface';
// v5.5.889: customer web routes are LAZY — they were riding in the one 5.1MB bundle every
// till and kiosk downloaded. Customer sessions are short + fresh-loaded, so a split chunk is
// safe there; operational surfaces (POS/kiosk/KDS/…) stay static so a mid-shift till never
// has to fetch a chunk after a deploy.
const CustomerBoot = lazy(() => import('./surfaces/CustomerBoot'));
// v5.5.890: What's New modal (carries the 1MB changelog array) loads only when opened.
const WhatsNewModal = lazy(() => import('./components/WhatsNewModal'));
import GroupOrderSurface from './surfaces/GroupOrderSurface';
import { parseCustomerUrl as parseCustomerUrlForBoot } from './lib/customerUrl';
import AIChat from './components/AIChat';

function AIAssistantSurface() {
  const { staff } = useStore();
  return (
    <div style={{ flex:1, display:'flex', flexDirection:'column', overflow:'hidden', background:'var(--bg)' }}>
      {/* Header */}
      <div style={{ padding:'16px 24px 14px', borderBottom:'1px solid var(--bdr)', flexShrink:0, background:'var(--bg1)' }}>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          <div style={{ width:36, height:36, borderRadius:10, background:'var(--acc-d)', border:'1px solid var(--acc-b)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:18 }}>✦</div>
          <div>
            <div style={{ fontSize:16, fontWeight:800, color:'var(--t1)' }}>AI Shift Assistant</div>
            <div style={{ fontSize:11, color:'var(--t3)', marginTop:1 }}>Powered by Claude · Ask about your shift</div>
          </div>
          <div style={{ marginLeft:'auto', display:'flex', alignItems:'center', gap:6, padding:'4px 10px', borderRadius:20, background:'var(--grn-d)', border:'1px solid var(--grn-b)' }}>
            <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--grn)' }}/>
            <span style={{ fontSize:11, fontWeight:700, color:'var(--grn)' }}>Live</span>
          </div>
        </div>
        <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginTop:12 }}>
          {['📊 Shift summary', '🍺 Item sales', '⏰ Busiest hour', '🪑 Open tables', '⚠️ Allergen lookup', '👤 Server stats', '🖨 Printers', '🚫 86 an item'].map(c => (
            <span key={c} style={{ fontSize:11, padding:'3px 8px', borderRadius:20, background:'var(--bg3)', border:'1px solid var(--bdr)', color:'var(--t3)', fontWeight:600 }}>{c}</span>
          ))}
        </div>
      </div>
      {/* Chat */}
      <div style={{ flex:1, overflow:'hidden' }}>
        <AIChat
          mode="foh"
          staff={staff}
          placeholder="Ask about today's shift, allergens, printer status…"
        />
      </div>
    </div>
  );
}
// v5.5.889: Back Office is LAZY — it's ~60% of the app (menu manager, 20+ reports, workforce,
// all admin screens) and tills/kiosks never open it. Splitting it out is the single biggest
// first-load win for every operational device and customer page.
const BackOfficeApp = lazy(() => import('./backoffice/BackOfficeApp'));
import { isMock, supabase } from './lib/supabase';
import PairingScreen from './surfaces/PairingScreen';
import ModeSelector from './surfaces/ModeSelector';
import CompanyAdminApp from './admin/CompanyAdminApp';
import KioskSurface from './surfaces/KioskSurface';
import CustomerDisplaySurface from './surfaces/CustomerDisplaySurface';
import DeviceSetup from './surfaces/DeviceSetup';
import StatusDrawer from './components/StatusDrawer';
import SupportChat from './components/SupportChat';
import SyncBridge from './sync/SyncBridge';
import { fetchMenuCategoryLinks } from './lib/db';
import { normaliseMenuRow, assembleTaxProfiles } from './lib/rowMapping';
import MasterOfflineModal from './components/MasterOfflineModal';
import ActivityFeed from './components/ActivityFeed';
import ConfigSyncBanner from './components/ConfigSyncBanner';
import OrdersHub from './surfaces/OrdersHub';
import useSupabaseInit from './lib/useSupabaseInit';
import { VERSION } from './lib/version';
import { money, currencySymbol } from './lib/currency';
import { ServOSIcon } from './components/ServOSBrand';
import { Icon } from './components/ServOSIcons';

// v5.5.890: the CHANGELOG array (~1MB of source, 9,300 lines) moved to src/lib/changelog.js
// and only loads with the lazy What's New modal. Every deploy still adds its entry at the
// top of that file — see components/WhatsNewModal.jsx.




















export default function App() {
  const { staff, surface, setSurface, toast, shift, theme, setTheme, appMode, deviceConfig } = useStore();
  const [showWhatsNew, setShowWhatsNew] = useState(false);
  const [syncPulse, setSyncPulse] = useState(false);

  useSupabaseInit(); // Load state from Supabase on mount (no-op in mock mode)

  const handleSyncPulse = useCallback(() => {
    setSyncPulse(true);
    setTimeout(() => setSyncPulse(false), 600);
  }, []);

  // Start Supabase Realtime on mount — NEVER use loc-demo, retry until real locationId resolves
  useEffect(() => {
    let cleanup;
    let retryTimer;
    const boot = async () => {
      try {
        const [{ startRealtime }, { getLocationId }] = await Promise.all([
          import('./lib/realtime.js'),
          import('./lib/supabase.js'),
        ]);
        // Try up to 5 times with 2s gap to get the real locationId
        for (let attempt = 0; attempt < 5; attempt++) {
          const locationId = await getLocationId().catch(() => null);
          if (locationId && locationId !== 'loc-demo') {
            cleanup = startRealtime(useStore, locationId);
            return;
          }
          await new Promise(r => { retryTimer = setTimeout(r, 2000); });
        }
        // If still no real locationId after retries, try once from paired device localStorage
        try {
          const dev = JSON.parse(localStorage.getItem('rpos-device') || '{}');
          if (dev.locationId && dev.locationId !== 'loc-demo') {
            const { startRealtime } = await import('./lib/realtime.js');
            cleanup = startRealtime(useStore, dev.locationId);
          }
        } catch {}
      } catch {}
    };
    boot();
    return () => { cleanup?.(); clearTimeout(retryTimer); };
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // ── Customer-facing surfaces ──────────────────────────────────────────
  // Subdomain-based routing: (slug).serv-os.app → online ordering or QR
  // table-side. Falls back to ?loc=<slug>&surface=... query for testing
  // before DNS is wired. Resolved BEFORE the operator mode dispatch so
  // customers never see the device pairing / mode selector screens.
  // Operator URLs (?mode=pos / mpos / office / admin / kiosk) take
  // precedence so an operator on the same hostname still gets their tools.
  const CUSTOMER_MODES = ['online', 'qr', 'gift', 'gift_balance', 'gift_success', 'account', 'review', 'wifi', 'catering', 'waitlist', 'waitlist_status', 'book'];
  const urlMode = new URLSearchParams(window.location.search).get('mode');
  // Public Workforce contract-signing page: /sign/<token>
  const signMatch = window.location.pathname.match(/^\/sign\/([A-Za-z0-9_-]{8,})/);
  if (signMatch) return <OnboardingSignSurface token={signMatch[1]} />;
  // Dev: Ryft sandbox payment harness (?mode=ryft-test) — sandbox only.
  if (urlMode === 'ryft-test') return <RyftTestSurface />;
  if (!urlMode) {
    const customerCtx = parseCustomerUrlForBoot();
    // Multi-site group landing pages — /order/<groupSlug> (or ?group=) for online
    // ordering, /cater/<groupSlug> (or ?cater=) for catering. Resolves a COMPANY
    // (platform companies.slug), not a venue; the customer picks a venue and is
    // handed to that venue's existing online/catering URL. A single eligible venue
    // skips the picker and redirects straight in.
    if ((customerCtx?.mode === 'group' || customerCtx?.mode === 'group_catering') && customerCtx.groupSlug) {
      return <GroupOrderSurface groupSlug={customerCtx.groupSlug}
        variant={customerCtx.mode === 'group_catering' ? 'catering' : 'online'} />;
    }
    if (customerCtx?.slug && CUSTOMER_MODES.includes(customerCtx.mode)) {
      return (
        <Suspense fallback={<div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t3, #888)', fontSize: 15 }}>Loading…</div>}>
          <CustomerBoot slug={customerCtx.slug} mode={customerCtx.mode} tableId={customerCtx.tableId} />
        </Suspense>
      );
    }
  }

  // ── Device mode selection ─────────────────────────────────────────────
  // Priority: URL ?mode=X param > localStorage > first-visit selector
  // This lets users bookmark /app?mode=pos, /app?mode=office, /app?mode=admin
  const storedMode = localStorage.getItem('rpos-device-mode');
  const deviceMode = isMock ? (urlMode || 'pos') : (urlMode || storedMode || null);

  // If URL param set, save to localStorage so it persists.
  // ?mode=readerdemo is deliberately NOT persisted: it is a sales prop opened ad
  // hoc on a laptop, and making it the browser's sticky default mode would turn
  // the owner's next plain visit into a fake card reader.
  if (urlMode && urlMode !== storedMode && urlMode !== 'readerdemo') {
    localStorage.setItem('rpos-device-mode', urlMode);
  }

  // First visit — ask what this device is for
  if (!deviceMode) return (
    <ModeSelector
      onSelectPOS={() => { localStorage.setItem('rpos-device-mode', 'pos'); window.location.href = '?mode=pos'; }}
      onSelectMPOS={() => { localStorage.setItem('rpos-device-mode', 'mpos'); window.location.href = '?mode=mpos'; }}
      onSelectClock={() => { localStorage.setItem('rpos-device-mode', 'clock'); window.location.href = '?mode=clock'; }}
      onSelectMenuBoard={() => { localStorage.setItem('rpos-device-mode', 'menuboard'); window.location.href = '?mode=menuboard'; }}
      onSelectWaitlist={() => { localStorage.setItem('rpos-device-mode', 'waitlist'); window.location.href = '?mode=waitlist'; }}
      onSelectBookings={() => { localStorage.setItem('rpos-device-mode', 'bookings'); window.location.href = '?mode=bookings'; }}
      onSelectManager={() => { localStorage.setItem('rpos-device-mode', 'manager'); window.location.href = '?mode=manager'; }}
      onSelectBackOffice={() => { localStorage.setItem('rpos-device-mode', 'backoffice'); window.location.href = '?mode=office'; }}
      onSelectAdmin={() => { localStorage.setItem('rpos-device-mode', 'admin'); window.location.href = '?mode=admin'; }}
    />
  );

  // Company Admin — completely separate internal app
  if (deviceMode === 'admin') return <CompanyAdminApp />;

  // Kiosk — standalone customer-facing self-ordering surface
  if (deviceMode === 'kiosk') return <KioskSurface />;

  // Customer-facing display — dedicated second screen (e.g. Sunmi D3 Pro rear).
  // Read-only mirror of a till (idle ads → live cart → payment status). Resolves
  // its target via ?till=<deviceId> or this device's own pairing; self-contained
  // (no SyncBridge — it only subscribes to the display broadcast).
  if (deviceMode === 'customer-display') return <CustomerDisplaySurface />;

  // Owner snapshot — mobile-first, self-contained (own BO login + owner-snapshot
  // edge fn). Read-only top-down view across every venue the owner can access.
  if (deviceMode === 'owner') return <OwnerSurface />;

  // Digital menu board — read-only Android-TV display. Resolves its own location,
  // renders one menu_boards "screen" with the auto-fit/auto-balance engine, live
  // over Realtime. No SyncBridge (like customer-display).
  if (deviceMode === 'menuboard') return <><KioskAutoUpdate /><MenuBoardSurface /></>;

  // Demo card reader — a browser-window replica of an Adyen reader for sales
  // demos (?mode=readerdemo). A real software terminal: registers, pairs and
  // takes terminal_jobs like the paxpay app; its sales settle as simulated card
  // payments marked DEMO. Self-contained (no SyncBridge, like customer-display).
  if (deviceMode === 'readerdemo') return <ReaderDemoSurface />;

  // Operations — RETIRED as a standalone surface (v5.5.754). Folded into the Manager app
  // (?mode=manager), which renders the exact same Ops screens (the Ops tab is available to
  // EVERY role) off the SAME ops_devices pairing — so an already-paired Ops tablet lands
  // straight on the PIN screen, no re-pair. Redirect ?mode=ops (and migrate a device whose
  // stored mode is 'ops') to the Manager app.
  if (deviceMode === 'ops') {
    if (storedMode === 'ops') localStorage.setItem('rpos-device-mode', 'manager');
    window.location.replace('?mode=manager');
    return null;
  }
  if (deviceMode === 'waitlist') return <><KioskAutoUpdate /><WaitlistSurface /></>;

  // Table Bookings — host-stand diary/floor/book. SyncBridge-backed: the diary,
  // the floor canvas and the optimiser all read the SAME tables + sessions the
  // POS reads (INTEGRATION.md — bookings never keeps its own floor plan copy).
  if (deviceMode === 'bookings') return <><KioskAutoUpdate /><SyncBridge onSyncPulse={handleSyncPulse}/><BookingsSurface /></>;

  // ServOS Staff — the staff SELF-SERVICE app on their own phone (v5.5.996):
  // shifts, announcements, timesheets, own details; training joins later.
  // Email+password login (invited from Onboarding), no device pairing, no
  // SyncBridge — the staff-portal edge fn serves only that person's data.
  if (deviceMode === 'staff') return <StaffSurface />;

  // ServOS Manager — owner app + ops tablet merged into one role-adaptive phone app. Pairs itself
  // (ops_devices claim-code + heartbeat) then staff PIN; role gates the bottom tabs. Read-only-ish
  // manager console (no SyncBridge); standalone store-distributed build.
  if (deviceMode === 'manager') return <><KioskAutoUpdate /><ManagerSurface /></>;

  // Back office mode — go to email login (no pairing needed)
  if (deviceMode === 'backoffice' || deviceMode === 'office') return <><SyncBridge onSyncPulse={handleSyncPulse}/><Suspense fallback={<div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--t3, #888)', fontSize: 15 }}>Loading Back Office…</div>}><BackOfficeApp /></Suspense></>;

  // POS / MPOS modes both need a paired device for locationId resolution
  const pairedDevice = (() => { try { return JSON.parse(localStorage.getItem('rpos-device') || 'null'); } catch { return null; } })();
  if (!pairedDevice) return <PairingScreen onPaired={() => window.location.reload()} />;

  // MPOS — phone-shaped POS for servers/runners. Reuses the same store + sync
  // layer as ?mode=pos but with a portrait, single-column UI. Phase 1A: walk-in
  // only, cash + REST card. Phase 1B will add Stripe Tap to Pay native bridges.
  if (deviceMode === 'mpos') return <><SyncBridge onSyncPulse={handleSyncPulse}/><MposDeviceProfileSync pairedDevice={pairedDevice}/><MPOSSurface /></>;

  // Time Clock — dedicated second-tablet surface for staff to clock in/out + breaks.
  // Pairs to a location like a POS; punches write server-side via workforce-clock.
  if (deviceMode === 'clock') return <><KioskAutoUpdate /><TimeClockSurface /></>;

  // Validate device against Supabase (checks if admin removed it)
  // Uses a component so hooks work properly
  // v5.7.8 - ?diag=menu mounts the read-only stale-till truth panel over the POS
  // (PIN screen included: it floats above whatever ValidatedPOSApp renders).
  const diagMenu = new URLSearchParams(window.location.search).get('diag') === 'menu';
  return <>
    {diagMenu && <MenuDiag />}
    <ValidatedPOSApp pairedDevice={pairedDevice} staff={staff} surface={surface} setSurface={setSurface} toast={toast} shift={shift} theme={theme} setTheme={setTheme} syncPulse={syncPulse} handleSyncPulse={handleSyncPulse} showWhatsNew={showWhatsNew} setShowWhatsNew={setShowWhatsNew} deviceConfig={deviceConfig} />
  </>;
}

// v5.5.645: persistent Training Mode banner. Shown on every POS surface whenever
// this device's profile has training_mode on. Deliberately loud + theme-independent
// so staff can never mistake a training till for a live one. Reads the store flag
// kept in lock-step with the module singleton that gates every commit path.
function TrainingModeBanner() {
  const on = useStore(s => s.trainingMode);
  if (!on) return null;
  return (
    <div role="status" aria-live="polite" style={{
      flexShrink: 0,
      background: 'repeating-linear-gradient(135deg, #B45309 0 18px, #92400E 18px 36px)',
      color: '#FFF7ED', fontWeight: 800, fontSize: 13, letterSpacing: '.02em',
      padding: '9px 16px', textAlign: 'center',
      borderBottom: '2px solid #FCD34D',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
      textShadow: '0 1px 2px rgba(0,0,0,.35)',
    }}>
      <span style={{ width: 9, height: 9, borderRadius: '50%', background: '#FCD34D', boxShadow: '0 0 0 3px rgba(252,211,77,.35)', flexShrink: 0 }} />
      <span>TRAINING MODE — nothing is saved. No orders, payments, stock, receipts or kitchen tickets are committed.</span>
    </div>
  );
}

// ── v5.7.7: ONE device-profile field mapping ─────────────────────────────────
// The boot fetch, the device_profiles realtime handler and the silent self-heal
// refresh all build this till's deviceConfig through these two helpers. They
// used to be hand-maintained copies and drifted (the realtime copy had lost
// isMaster and the sign-out policy), so a till could run one config shape at
// boot and a different one after a live profile edit.
function profileRowToProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    defaultSurface: row.default_surface || 'tables',
    enabledOrderTypes: row.enabled_order_types || ['dine-in'],
    assignedSection: row.assigned_section || null,
    // v5.8.27: MPOS payment settings. These were never mapped here, so a handset
    // kept whatever mode it had when it was PAIRED and every profile refresh
    // (Push to POS, wake, 5-min timer) silently reset it to Tap to Pay. A venue
    // that switched the MPOS profile to "Assigned network reader" could never
    // get the handset to use its card reader.
    paymentMode: row.payment_mode || 'tap_to_pay',
    assignedReaderId: row.assigned_reader_id || null,
    runnerMode: row.runner_mode === true,
    customerDisplayMode: row.customer_display_mode || 'auto',
    hiddenFeatures: row.hidden_features || [],
    tableServiceEnabled: row.table_service_enabled !== false,
    quickScreenEnabled: row.quick_screen_enabled !== false,
    serviceCharge: row.service_charge || null,
    isMaster: row.is_master === true,
    autoPrintReceiptOnClose: row.auto_print_receipt_on_close !== false,
    orderNotifications: row.order_notifications !== false,
    menuId: row.menu_id || null,
    trainingMode: row.training_mode === true,   // v5.5.645: per-device training
    signoutIdleSeconds: row.signout_idle_seconds || 0,   // v5.5.731 auto sign-out
    signoutOnPay: row.signout_on_pay === true,
    signoutOnSend: row.signout_on_send === true,
  };
}

function configFromProfile(profile) {
  return {
    profileId: profile.id, profileName: profile.name,
    defaultSurface: profile.defaultSurface || 'tables',
    enabledOrderTypes: profile.enabledOrderTypes || ['dine-in'],
    assignedSection: profile.assignedSection || null,
    paymentMode: profile.paymentMode || 'tap_to_pay',           // v5.8.27, see profileRowToProfile
    assignedReaderId: profile.assignedReaderId || null,
    runnerMode: profile.runnerMode === true,
    customerDisplayMode: profile.customerDisplayMode || 'auto',
    hiddenFeatures: profile.hiddenFeatures || [],
    tableServiceEnabled: profile.tableServiceEnabled !== false,
    quickScreenEnabled: profile.quickScreenEnabled !== false,
    serviceCharge: profile.serviceCharge || null,
    isMaster: profile.isMaster === true,
    autoPrintReceiptOnClose: profile.autoPrintReceiptOnClose !== false,
    orderNotifications: profile.orderNotifications !== false,
    menuId: profile.menuId || null,
    trainingMode: profile.trainingMode === true,   // v5.5.645: per-device training
    // v5.5.731: auto sign-out policy, how this device signs the operator out
    signout: {
      idleSeconds: Number(profile.signoutIdleSeconds) || 0,
      onPay: profile.signoutOnPay === true,
      onSend: profile.signoutOnSend === true,
    },
    // Keep the terminal name a previous config may have stamped on this till.
    terminalName: useStore.getState().deviceConfig?.terminalName,
  };
}

// v5.8.28: the MPOS route returns before ValidatedPOSApp mounts, so it never ran
// the device-profile refresh the till gets (Push to POS, wake, 5-min timer). Its
// deviceConfig was whatever pairing wrote, which never included payment_mode, so
// a handset was Tap to Pay forever no matter what the profile said. This does
// for the handset exactly what ValidatedPOSApp does for the till, with the same
// mapping (profileRowToProfile -> configFromProfile) and the same change gate.
function MposDeviceProfileSync({ pairedDevice }) {
  useEffect(() => {
    if (!pairedDevice?.id || !supabase) return;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return; inFlight = true;
      try {
        const { data } = await supabase.from('devices').select('id, status, profile_id').eq('id', pairedDevice.id).single();
        if (!data?.profile_id) return;
        const { data: row } = await supabase.from('device_profiles').select('*').eq('id', data.profile_id).single();
        if (!row) return;
        const next = configFromProfile(profileRowToProfile(row));
        const prev = useStore.getState().deviceConfig;
        if (!deviceConfigChanged(prev, next)) return;
        try { localStorage.setItem('rpos-device-config', JSON.stringify(next)); } catch { /* quota */ }
        useStore.getState().setDeviceConfig(next);
      } catch { /* offline: keep the cache */ }
      finally { inFlight = false; }
    };
    refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    window.addEventListener('rpos-config-push', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', onVisible);
    const t = setInterval(refresh, 5 * 60 * 1000);
    return () => {
      window.removeEventListener('rpos-config-push', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(t);
    };
  }, [pairedDevice?.id]);
  return null;
}

// v5.7.7: material-change gate. setDeviceConfig snaps the surface back to
// defaultSurface, so blind re-apply on every silent refresh would yank the
// operator off whatever screen they were on. Objects and arrays compare by
// value so a byte-identical refresh is a true no-op.
const CONFIG_COMPARE_KEYS = [
  'profileId', 'profileName', 'defaultSurface', 'assignedSection',
  'tableServiceEnabled', 'quickScreenEnabled', 'isMaster',
  'autoPrintReceiptOnClose', 'orderNotifications', 'menuId', 'trainingMode',
  'enabledOrderTypes', 'hiddenFeatures', 'serviceCharge', 'signout',
  'paymentMode', 'assignedReaderId', 'runnerMode', 'customerDisplayMode',   // v5.8.27
];
function deviceConfigChanged(prev, next) {
  if (!prev) return true;
  return CONFIG_COMPARE_KEYS.some(k => {
    const a = prev[k], b = next[k];
    if ((a && typeof a === 'object') || (b && typeof b === 'object')) {
      try { return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null); } catch { return true; }
    }
    return (a ?? null) !== (b ?? null);
  });
}

function ValidatedPOSApp({ pairedDevice, staff, surface, setSurface, toast, shift, theme, setTheme, syncPulse, handleSyncPulse, showWhatsNew, setShowWhatsNew, deviceConfig }) {
  const [deviceValid, setDeviceValid] = useState(null); // null=checking, true=ok, false=revoked
  const [masterOffline, setMasterOffline] = useState(false);
  const [masterInfo, setMasterInfo] = useState(null);
  // OrderAlert state lives on the store; ValidatedPOSApp owns the render
  // for it because that's where the operator UI tree lives.
  const orderAlert = useStore(s => s.orderAlert);
  const dismissOrderAlert = useStore(s => s.dismissOrderAlert);
  // No "dismissed" state — master offline is a hard block

  // v5.5.350: ServOS skin flag — the POS family is a staff surface. Set on
  // <html> so portaled modals inherit it; removed on unmount so customer
  // surfaces (which never set it) keep their existing look. Presentational only.
  useEffect(() => {
    document.documentElement.setAttribute('data-skin', 'servos');
    return () => document.documentElement.removeAttribute('data-skin');
  }, []);

  // Start master/child sync after device is validated
  useEffect(() => {
    if (!pairedDevice || isMock || deviceValid !== true) return;

    let stopped = false;
    const boot = async () => {
      try {
        const { getLocationId } = await import('./lib/supabase.js');
        const locId = await getLocationId().catch(() => null);
        if (!locId || stopped) return;

        const { startMasterHeartbeat, startChildMonitor, startChildHeartbeat } = await import('./sync/MasterSync.js');

        // isMaster is written to rpos-device-config during device validation (refreshDevice)
        // which queries device_profiles from Supabase — always authoritative
        const cfg = JSON.parse(localStorage.getItem('rpos-device-config') || '{}');
        const isMasterDevice = cfg.isMaster === true;

        if (isMasterDevice) {
          // Master: write heartbeat immediately, never monitor
          startMasterHeartbeat({
            deviceId: pairedDevice.id,
            locationId: locId,
            deviceName: pairedDevice.name,
            version: VERSION,
          });
        } else {
          // Child: report our own heartbeat (v5.5.870 — so Network Status sees this till's version
          // too), then wait 20s before monitoring the master (gives it time to write on startup).
          startChildHeartbeat({ deviceId: pairedDevice.id, locationId: locId, deviceName: pairedDevice.name, version: VERSION });
          await new Promise(r => setTimeout(r, 20_000));
          if (!stopped) startChildMonitor({ locationId: locId });
        }

        // v4.3 — Print reliability
        // PrintOrchestrator: runs on every native-bridge device (master or child) so any
        //   terminal can dispatch jobs. Pickup is the print_jobs realtime INSERT
        //   subscription; the poll behind it is only a backstop (v5.6.83: master 20s,
        //   children 30s, 10s grace so master claims first under normal conditions).
        //   It is the SINGLE owner of claim state wherever it runs.
        // PrintRetrier: the fallback scheduler for a master with NO native bridge, where
        //   the orchestrator refuses to start and the LAN print-agent does the printing.
        //   Since v5.6.83 it stands down by itself when the orchestrator is running —
        //   the two used to run together and write conflicting statuses to the same
        //   print_jobs rows (pending at 30s vs failed at 60s).
        try {
          if (stopped) return;
          const { startPrintOrchestrator } = await import('./sync/PrintOrchestrator.js');
          startPrintOrchestrator({
            deviceId: pairedDevice.id,
            locationId: locId,
            isMaster: isMasterDevice,
          });

          if (isMasterDevice) {
            const { startPrintRetrier } = await import('./sync/PrintRetrier.js');
            startPrintRetrier();
          }
        } catch (e) {
          console.warn('[PrintReliability] boot error:', e.message);
        }
      } catch (e) {
        console.warn('[MasterSync] boot error:', e.message);
      }
    };

    boot();
    return () => { stopped = true; };
  }, [deviceValid]);

  useEffect(() => {
    const onOffline = (e) => { setMasterInfo(e.detail); setMasterOffline(true); };
    const onOnline  = (e) => { setMasterInfo(e.detail); setMasterOffline(false); };
    window.addEventListener('rpos-master-offline', onOffline);
    window.addEventListener('rpos-master-online',  onOnline);
    return () => {
      window.removeEventListener('rpos-master-offline', onOffline);
      window.removeEventListener('rpos-master-online',  onOnline);
    };
  }, []);

  useEffect(() => {
    if (isMock) { setDeviceValid(true); return; }

    // Generate a unique session token for this browser tab
  const SESSION_TOKEN_KEY = `rpos-session-${pairedDevice.id}`;
  const mySessionToken = (() => {
    let t = sessionStorage.getItem(SESSION_TOKEN_KEY);
    if (!t) { t = `sess-${Date.now()}-${Math.random().toString(36).slice(2,8)}`; sessionStorage.setItem(SESSION_TOKEN_KEY, t); }
    return t;
  })();

  // Check if this is a forced reclaim (user clicked Reconnect)
  const isReclaim = !!sessionStorage.getItem(`rpos-reclaim-${pairedDevice.id}`);
  if (isReclaim) sessionStorage.removeItem(`rpos-reclaim-${pairedDevice.id}`);

  // ── v5.7.7: SINGLE apply path for deviceConfig ─────────────────────────────
  // Boot, the device_profiles realtime handler and the silent refresh all land
  // here. Applies only on material change (see deviceConfigChanged) so silent
  // refreshes never disturb a till whose config is already current. Toasts:
  // announce=true keeps the realtime handler's existing toast; silent refreshes
  // only toast when Training Mode actually flips (staff must always know).
  const applyDeviceConfig = (config, { announce = false } = {}) => {
    const prev = useStore.getState().deviceConfig;
    if (!deviceConfigChanged(prev, config)) return;
    const trainingFlipped = (prev?.trainingMode === true) !== (config.trainingMode === true);
    localStorage.setItem('rpos-device-config', JSON.stringify(config));
    useStore.getState().setDeviceConfig(config);
    if (announce || trainingFlipped) {
      useStore.getState().showToast(config.trainingMode === true ? 'Training mode ON — nothing will be saved' : 'Device profile updated', 'info');
    }
  };

  // ── v5.7.7: profile channel is REWIRABLE ───────────────────────────────────
  // It used to be wired ONCE at mount with whatever profileId localStorage held,
  // so a till reassigned to a different profile in Back Office kept listening to
  // the old profile (or to nothing) until a true cold start, which is the root of the
  // "Sunmi till stuck on a deleted menu pin" incident. wireProfileChannel is now
  // called again whenever the devices row reports a different profile_id.
  let profileChannel = null;
  let wiredProfileId = null;
  const wireProfileChannel = (profileId) => {
    if (!profileId || profileId === wiredProfileId) return;
    if (profileChannel) supabase.removeChannel(profileChannel);
    wiredProfileId = profileId;
    profileChannel = supabase
      .channel(`profile-${profileId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'device_profiles',
        filter: `id=eq.${profileId}`,
      }, (payload) => {
        // Profile settings changed: re-apply immediately through the SAME
        // mapping + apply path as boot and the silent refresh (v5.7.7: the
        // handler used to keep its own field-mapping copy, which had drifted).
        if (!payload.new) return;
        applyDeviceConfig(configFromProfile(profileRowToProfile(payload.new)), { announce: true });
      })
      .subscribe();
  };

  const refreshDevice = async () => {
      // If reclaiming: write our token to Supabase FIRST — this kicks the other session immediately
      if (isReclaim) {
        await supabase.from('devices').update({ session_token: mySessionToken }).eq('id', pairedDevice.id);
      }
      const { data } = await supabase.from('devices').select('id, status, profile_id, name, session_token').eq('id', pairedDevice.id).single();
      if (!data || data.status === 'removed') {
        localStorage.removeItem('rpos-device');
        setDeviceValid(false);
        return;
      }
      // Check if another session has claimed this device (only if we're NOT reclaiming)
      if (!isReclaim && data.session_token && data.session_token !== mySessionToken) {
        setDeviceValid('kicked');
        return;
      }
      // Claim this device for our session (if not already done via reclaim above)
      if (!isReclaim) {
        await supabase.from('devices').update({ session_token: mySessionToken }).eq('id', pairedDevice.id);
      }
      // Refresh device name + profile
      const current = JSON.parse(localStorage.getItem('rpos-device') || '{}');
      if (data.name !== current.name || data.profile_id !== current.profileId) {
        localStorage.setItem('rpos-device', JSON.stringify({ ...current, name: data.name, profileId: data.profile_id }));
      }
      // v5.7.7: a profile REASSIGNMENT must move the realtime listener too
      wireProfileChannel(data.profile_id);
      // Apply profile settings — fetch directly from Supabase for accuracy
      if (data.profile_id) {
        try {
          // Always fetch from Supabase first — this is the single source of truth
          let profile = null;
          try {
            const { data: dbProfile } = await supabase
              .from('device_profiles')
              .select('*')
              .eq('id', data.profile_id)
              .single();
            if (dbProfile) profile = profileRowToProfile(dbProfile);   // v5.7.7: unified mapping
          } catch {}
          // Fallback: localStorage > config snapshot only (NO hardcoded defaults — deleted means deleted)
          if (!profile) {
            const storedProfiles = JSON.parse(localStorage.getItem('rpos-device-profiles') || 'null');
            const snapProfiles = (() => { try { return JSON.parse(localStorage.getItem('rpos-config-snapshot') || '{}')?.profiles || null; } catch { return null; } })();
            const allProfiles = [...(storedProfiles || []), ...(snapProfiles || [])];
            profile = allProfiles.find(p => p.id === data.profile_id) || null;
          }
          if (profile) {
            applyDeviceConfig(configFromProfile(profile));   // v5.7.7: unified mapping + apply path
          } else {
            // Profile ID not found in hardcoded list — try to find it in config push payload
            const existingConfig = JSON.parse(localStorage.getItem('rpos-device-config') || 'null');
            // Check if we have a name for this profile from a previous config push
            let profileName = existingConfig?.profileName;
            if (!profileName || profileName === data.name) {
              // Try config pushes for profile name
              try {
                const { data: pushData } = await supabase
                  .from('config_pushes')
                  .select('payload')
                  .eq('location_id', pairedDevice.location_id)
                  .order('pushed_at', { ascending: false })
                  .limit(1)
                  .single();
                const profiles = pushData?.payload?.profiles || [];
                const found = profiles.find(p => p.id === data.profile_id);
                if (found) profileName = found.name;
              } catch {}
              if (!profileName || profileName === data.name) {
                profileName = data.name || pairedDevice.name || 'POS Terminal';
              }
            }
            const minConfig = {
              profileId: data.profile_id || 'custom',
              profileName: profileName,
              defaultSurface: existingConfig?.defaultSurface || 'tables',
              enabledOrderTypes: existingConfig?.enabledOrderTypes || ['dine-in','takeaway','collection'],
              assignedSection: existingConfig?.assignedSection || null,
              hiddenFeatures: existingConfig?.hiddenFeatures || [],
              tableServiceEnabled: existingConfig?.tableServiceEnabled !== false,
              quickScreenEnabled: existingConfig?.quickScreenEnabled !== false,
              serviceCharge: existingConfig?.serviceCharge || null,
              autoPrintReceiptOnClose: existingConfig?.autoPrintReceiptOnClose !== false,
              orderNotifications: existingConfig?.orderNotifications !== false,
              menuId: existingConfig?.menuId || null,
              trainingMode: existingConfig?.trainingMode === true,   // v5.5.645: preserve training flag on fallback
            };
            applyDeviceConfig(minConfig);   // v5.7.7: same apply path (change-gated)
          }
        } catch(e) {}
      }
      // Always ensure serviceCharge is in deviceConfig (backfill for existing sessions)
      const currentConfig = useStore.getState().deviceConfig;
      if (currentConfig && !currentConfig.serviceCharge && currentConfig.profileId) {
        try {
          const profiles = JSON.parse(localStorage.getItem('rpos-device-profiles') || '[]');
          const match = profiles.find(p => p.id === currentConfig.profileId);
          if (match?.serviceCharge) {
            useStore.getState().setDeviceConfig({ ...currentConfig, serviceCharge: match.serviceCharge });
          }
        } catch {}
      }
      setDeviceValid(true);
    };

    // Initial check
    refreshDevice().catch(() => setDeviceValid(true));

    // ── v5.7.7: SELF-HEALING deviceConfig ──────────────────────────────────────
    // Sunmi WebViews kill websockets on sleep and keep page state on refresh, so
    // a missed realtime event used to be missed forever and a till could keep
    // filtering by a menu pin that no longer exists anywhere in the DB. This
    // refresh re-reads the devices row (the source of truth for profile_id) and
    // the profile itself from the DB, then re-applies through the same path as
    // boot and realtime. It NO-OPS silently on any fetch failure so an offline
    // till keeps its cache (never blank a working till because the wifi
    // blipped) and it deliberately skips the localStorage profile fallback,
    // which is exactly the path that used to resurrect stale pins.
    let refreshInFlight = false;
    const refreshDeviceProfile = async () => {
      if (refreshInFlight || !pairedDevice?.id) return;
      refreshInFlight = true;
      try {
        const { data } = await supabase.from('devices').select('id, status, profile_id, name').eq('id', pairedDevice.id).single();
        if (!data || data.status === 'removed') return;   // removal/kick handling stays refreshDevice's job
        const current = JSON.parse(localStorage.getItem('rpos-device') || '{}');
        if (data.name !== current.name || data.profile_id !== current.profileId) {
          localStorage.setItem('rpos-device', JSON.stringify({ ...current, name: data.name, profileId: data.profile_id }));
        }
        wireProfileChannel(data.profile_id);
        if (!data.profile_id) return;
        const { data: dbProfile } = await supabase.from('device_profiles').select('*').eq('id', data.profile_id).single();
        if (!dbProfile) return;   // fetch failed or profile gone: keep the working cache
        applyDeviceConfig(configFromProfile(profileRowToProfile(dbProfile)));
      } catch { /* offline: keep the cache */ }
      finally { refreshInFlight = false; }
      // v5.7.18 - MENUS + CATEGORY LINKS self-heal on the same cycle. Timed
      // menus live on the menus rows (schedule/priority/is_default) and on
      // menu_category_links (a links-only menu with no links loaded counts as
      // empty and can never win the resolver). Both used to reach a till only
      // on Push to POS or a lucky boot. Re-read both (tiny tables), normalise,
      // apply only on change. Items/categories stay push-delivered.
      try {
        const st = useStore.getState();
        const locId = st.location?.id;
        if (!locId || locId === 'loc-demo') return;
        const [menusQ, linksQ] = await Promise.all([
          supabase.from('menus').select('*').eq('location_id', locId).order('sort_order'),
          fetchMenuCategoryLinks(locId),
        ]);
        if (Array.isArray(menusQ.data) && menusQ.data.length) {
          const mapped = menusQ.data.map(normaliseMenuRow);
          const key = rows => JSON.stringify(rows.map(m => [m.id, m.isDefault, m.isActive, m.priority ?? 0, m.schedule ?? null]).sort());
          if (key(mapped) !== key(st.menus || [])) useStore.setState({ menus: mapped });
        }
        if (Array.isArray(linksQ.data)) {
          const lkey = rows => JSON.stringify(rows.map(l => [l.menu_id, l.category_id]).sort());
          if (lkey(linksQ.data) !== lkey(st.categoryLinks || [])) st.setCategoryLinks(linksQ.data);
        }
      } catch { /* best-effort */ }
      // v5.7.33 - TAX PROFILES self-heal on the same cycle (delivery only -
      // nothing computes with them yet). Small tables, same pattern as menus
      // above: re-read, normalise via the one shared assembler, apply only on
      // change. Its own try + Promise.all so a profiles read failing can never
      // take the menus/links heal down with it, and vice versa. BOTH reads must
      // succeed before applying - a half-failed read must not leave line-less
      // profiles in the store.
      try {
        const st = useStore.getState();
        const locId = st.location?.id;
        if (!locId || locId === 'loc-demo') return;
        const [profQ, lineQ, defQ] = await Promise.all([
          supabase.from('tax_profiles').select('*').eq('location_id', locId).order('sort_order'),
          supabase.from('tax_profile_lines').select('*').eq('location_id', locId).order('sort_order'),
          supabase.from('locations').select('default_tax_profile_id').eq('id', locId).maybeSingle(),
        ]);
        // v5.7.33 review fix: the venue default heals too, INCLUDING a clear
        // to null (a successful read always applies; a failed read keeps prior).
        if (defQ && !defQ.error && defQ.data) {
          const dv = defQ.data.default_tax_profile_id ?? null;
          if (dv !== (useStore.getState().venueDefaultTaxProfileId ?? null)) useStore.setState({ venueDefaultTaxProfileId: dv });
        }
        if (Array.isArray(profQ.data) && Array.isArray(lineQ.data)) {
          const mapped = assembleTaxProfiles(profQ.data, lineQ.data);
          const pkey = rows => JSON.stringify((rows || []).map(p => [
            p.id, p.name, p.active, p.sortOrder, p.rounding,
            (p.lines || []).map(l => [l.id, l.name, l.jurisdiction, l.rate, l.flatAmount, l.lineType, l.mode, l.compound, l.taxable, l.taxBasis, l.orderTypes, l.sortOrder, l.active]),
          ]).sort());
          if (pkey(mapped) !== pkey(st.taxProfiles || [])) useStore.setState({ taxProfiles: mapped });
        }
      } catch { /* best-effort */ }
    };

    // Refresh triggers: wake from sleep, network back, 5-minute heartbeat, and
    // every Push to POS (realtime.js dispatches rpos-config-push on arrival so
    // Push to POS always delivers the CURRENT profile too).
    const onVisible = () => { if (document.visibilityState === 'visible') refreshDeviceProfile(); };
    const onOnline = () => refreshDeviceProfile();
    const onConfigPush = () => refreshDeviceProfile();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    window.addEventListener('rpos-config-push', onConfigPush);
    const refreshInterval = setInterval(refreshDeviceProfile, 5 * 60 * 1000);

    // Subscribe to realtime changes on this device row
    const channel = supabase
      .channel(`device-${pairedDevice.id}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'devices',
        filter: `id=eq.${pairedDevice.id}`,
      }, (payload) => {
        const updatedToken = payload.new?.session_token;
        // If session_token changed and it's not ours → we've been displaced
        if (updatedToken && updatedToken !== mySessionToken) {
          setDeviceValid('kicked');
          return;
        }
        // Otherwise refresh profile
        refreshDevice().catch(() => {});
      })
      .subscribe();

    // Wire the profile channel now with the cached profile_id so live edits land
    // immediately; refreshDevice / refreshDeviceProfile rewire it if the DB says
    // this device now points at a different profile (v5.7.7: it was wired once
    // and never moved, so reassigned tills listened to the wrong profile).
    const currentProfileId = JSON.parse(localStorage.getItem('rpos-device') || '{}')?.profileId;
    wireProfileChannel(currentProfileId);

    return () => {
      supabase.removeChannel(channel);
      if (profileChannel) supabase.removeChannel(profileChannel);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('rpos-config-push', onConfigPush);
      clearInterval(refreshInterval);
    };
  }, []);

  if (deviceValid === null) return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--bg)', color:'var(--t3)', fontSize:14 }}>
      Checking device…
    </div>
  );
  if (deviceValid === false) return <PairingScreen onPaired={() => window.location.reload()} />;

  if (deviceValid === 'kicked') return (
    <div style={{ minHeight:'100vh', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', background:'#0f1117', fontFamily:'inherit', gap:20, padding:40, position:'relative', zIndex:9999 }}>
      <div style={{ fontSize:48 }}>⚠️</div>
      <div style={{ fontSize:22, fontWeight:800, color:'#f1f5f9', textAlign:'center' }}>This terminal has been disconnected</div>
      <div style={{ fontSize:15, color:'#64748b', textAlign:'center', maxWidth:400, lineHeight:1.7 }}>
        Another device or browser window has connected to <strong style={{color:'#e2e8f0'}}>{pairedDevice.name}</strong>.<br/>
        Each POS device can only be active in one place at a time.
      </div>
      <a href="?mode=pos" onClick={() => {
          sessionStorage.setItem(`rpos-reclaim-${pairedDevice.id}`, '1');
          sessionStorage.removeItem(`rpos-session-${pairedDevice.id}`);
          localStorage.setItem('rpos-device-mode', 'pos');
        }}
        style={{ padding:'14px 32px', borderRadius:12, background:'#6366f1', color:'#fff', fontWeight:700, fontSize:15, textDecoration:'none', fontFamily:'inherit', display:'inline-block' }}>
        Reconnect this terminal
      </a>
      <div style={{ fontSize:12, color:'#334155' }}>v{VERSION}</div>
    </div>
  );

  // ── v5.6.83: SyncBridge mounts ONCE, and never moves ────────────────────────
  // Every branch below used to return SyncBridge inside its own root element — a
  // Fragment for the PIN screen, a <div> for the signed-in shell. React treats a
  // change of root element type as a different tree, so it UNMOUNTED everything and
  // built it again on every sign-in and every sign-out. SyncBridge's cleanup ran and
  // its ~25-query boot ran again behind it: config push, a nine-leg fetch, tax rates,
  // discounts, 500 closed checks over 30 days, bookings, order queue, bar tabs, the
  // lot. On a till configured to sign out after each sale, staff were waiting for a
  // full application boot between orders.
  //
  // So the branches now choose only the BODY. The bridge sits above them in a fixed
  // slot and stays mounted while the body swaps underneath it. (SyncBridge also holds
  // a location-keyed boot latch of its own as a second line of defence.)
  const pairedDeviceType = pairedDevice?.type;
  const isKdsDevice = pairedDeviceType === 'kds'
    // For non-KDS devices, also check deviceConfig (set during pairing)
    || (deviceConfig?.defaultSurface === 'kds'
        && !deviceConfig?.profileName?.toLowerCase().includes('counter')
        && !deviceConfig?.profileName?.toLowerCase().includes('bar')
        && !deviceConfig?.profileName?.toLowerCase().includes('server'));

  let body;
  if (isKdsDevice) {
    // KDS devices always show KDS surface regardless of URL mode
    body = <><KioskAutoUpdate /><KDSSurface /></>;
  } else if (!staff) {
    body = <PINScreen />;
  } else if (surface === 'kiosk' || deviceConfig?.defaultSurface === 'kiosk') {
    // Kiosk — full screen, no staff sidebar, no shift bar
    body = <KioskSurface />;
  } else if (deviceConfig?.defaultSurface === 'mpos') {
    // MPOS — full screen, phone-shaped router. Picked up by defaultSurface in addition
    // to the URL-based ?mode=mpos path (which is checked earlier in the component).
    body = <MPOSSurface />;
  } else {
    body = (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden' }}>
      {masterOffline && (
        <MasterOfflineModal
          masterName={masterInfo?.device_name}
          lastSeen={masterInfo}
        />
      )}
      
      <CardUserSwitch />
      <AutoSignout />
      <ShiftBar version={VERSION} onWhatsNew={()=>setShowWhatsNew(true)} theme={theme} onToggleTheme={()=>setTheme(theme==='dark'?'light':'dark')} syncPulse={syncPulse}/>
      <ConfigSyncBanner />
      <TrainingModeBanner />
      {/* v5.5.356 ServOS: floating panels — padding + gap so the rail and
          surface panels sit as separate rounded glass cards over the scene */}
      <div style={{ display:'flex', flex:1, overflow:'hidden', gap:14, padding:16 }}>
        <Sidebar surface={surface} setSurface={setSurface} />
        {/* v5.5.365 ServOS: overflow visible so the floating panels' shadows aren't
            clipped square by this wrapper — they reach the body's padding instead */}
        <div style={{ display:'flex', flex:1, overflow:'visible', minWidth:0 }}>
          {surface==='tables'     && <TablesSurface />}
          {surface==='pos'        && <POSSurface />}
          {surface==='bar'        && <BarSurface />}
          {surface==='orders'     && <OrdersHub />}
          {surface==='kds'        && <KDSSurface />}
          {surface==='ai'         && <AIAssistantSurface />}
        </div>
      </div>
      {toast && <Toast toast={toast} />}
      {/* First till sign-in of the day: "Start your shift?" (venue opt-in). */}
      <ShiftStartPrompt />
      <ChangeDueOverlay />
      {orderAlert && surface !== 'kds' && <OrderAlert alert={orderAlert} onDismiss={dismissOrderAlert} setSurface={setSurface} />}
      {showWhatsNew && <Suspense fallback={null}><WhatsNewModal onClose={()=>setShowWhatsNew(false)} /></Suspense>}
    </div>
    );
  }

  // The bridge is ALWAYS child 0 of this Fragment. React keeps a child in a fixed slot
  // mounted across re-renders, so only {body} is torn down and rebuilt when the
  // operator signs in or out.
  return (
    <>
      <SyncBridge onSyncPulse={handleSyncPulse}/>
      {body}
    </>
  );
}

const NAV = [
  { id:'bar',     label:'Bar',    icon:'bar' },
  { id:'tables',  label:'Floor',  icon:'floor' },
  { id:'pos',     label:'POS',    icon:'pos' },
  { id:'orders',  label:'Orders', icon:'orders' },
  { id:'ai',      label:'AI',     icon:'ai' },
  // icon = ServOS line-icon name (see components/ServOSIcons.jsx); was emoji.
  // KDS is NOT in the nav — KDS devices are separate terminals that boot straight to KDS surface
];

// Fast user-switch: while a staff member is signed in on the till, another can tap their card (native
// NFC or USB reader) to swap the active operator instantly — no logout. Matches against a FRESH staff
// roster (the store's list goes stale — cards can be enrolled mid-shift while this till stays logged
// in — which is why a second card used to "stick to one user"); a miss re-fetches once and retries so
// a just-enrolled card works immediately. Ignores unknown cards + the current user's own card, and
// never eats typed input (the hook guards inputs). Renders nothing.
function CardUserSwitch() {
  const staff = useStore(s => s.staff);
  const login = useStore(s => s.login);
  const showToast = useStore(s => s.showToast);
  const rosterRef = useRef([]);
  useEffect(() => {   // warm the roster on mount (also kept current by the miss-retry below)
    let alive = true;
    loadStaffRoster().then(r => { if (alive && r.length) rosterRef.current = r; }).catch(() => {});
    return () => { alive = false; };
  }, []);
  const onCard = async (cardId) => {
    let r = resolveSignIn(rosterRef.current, { cardId });
    if (!r.ok) {                                    // maybe a just-enrolled card → re-fetch once + retry
      const fresh = await loadStaffRoster().catch(() => []);
      if (fresh.length) rosterRef.current = fresh;
      r = resolveSignIn(rosterRef.current, { cardId });
    }
    if (!r.ok) return;                              // genuinely unknown card → ignore quietly
    if (staff && String(r.staff.id) === String(staff.id)) return;   // already this operator
    // v5.5.734: don't switch operator mid-transaction. A checkout / card hold holds _signoutBlock;
    // swapping now would null the live cart and orphan the in-flight payment (charged, unrecorded).
    if (useStore.getState()._signoutBlock > 0) { showToast?.('Finish the current payment first', 'info'); return; }
    login(r.staff);
    try { logSignIn(r.staff.id, 'card'); } catch { /* best-effort */ }
    showToast?.(`Switched to ${r.staff.name}`);
  };
  useCardScan(onCard, !!staff);
  return null;
}

// Idle auto sign-out (per device profile). After N seconds with no activity the operator is signed
// out so a shared till doesn't sit open on one person. Any tap / key / scroll resets the timer. The
// pay/send sign-out triggers live in the store (maybeAutoSignout); this handles the idle one.
function AutoSignout() {
  const staff = useStore(s => s.staff);
  const idleSeconds = useStore(s => s.deviceConfig?.signout?.idleSeconds || 0);
  const logout = useStore(s => s.logout);
  const showToast = useStore(s => s.showToast);
  useEffect(() => {
    if (!staff || !idleSeconds || idleSeconds < 5) return undefined;
    let timer = null;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fire, idleSeconds * 1000);
    };
    const fire = () => {
      // Never sign out mid-transaction — an open payment surface holds _signoutBlock. Re-arm and
      // re-check next tick so a genuinely-idle till still logs out once the payment finishes.
      if (useStore.getState()._signoutBlock > 0) { arm(); return; }
      if (useStore.getState().staff) { logout(); showToast?.('Signed out — inactive', 'info'); }
    };
    const evs = ['pointerdown', 'keydown', 'wheel', 'touchstart'];
    evs.forEach(e => window.addEventListener(e, arm, { passive: true }));
    arm();   // arm on sign-in
    return () => { if (timer) clearTimeout(timer); evs.forEach(e => window.removeEventListener(e, arm)); };
  }, [staff, idleSeconds, logout, showToast]);
  return null;
}

function ShiftBar({ version, onWhatsNew, theme, onToggleTheme, syncPulse }) {
  const { deviceConfig, setSurface, orderQueue, tables, tabs, closedChecks, shift } = useStore();
  const pairedDevice = (() => { try { return JSON.parse(localStorage.getItem('rpos-device') || 'null'); } catch { return null; } })();
  const terminalName = deviceConfig?.terminalName || pairedDevice?.name || 'POS';
  const storedProfiles = (() => { try { return JSON.parse(localStorage.getItem('rpos-device-profiles') || 'null'); } catch { return null; } })();
  const DEFAULT_PROFILES = [
    { id:'prof-1', name:'Main counter' },
    { id:'prof-2', name:'Bar terminal' },
    { id:'prof-3', name:'Server handheld' },
  ];
  const allProfiles = storedProfiles || DEFAULT_PROFILES;
  const profileName = deviceConfig?.profileName
    || allProfiles.find(p => p.id === pairedDevice?.profileId)?.name
    || null;

  const activeOrders = (orderQueue?.filter(o => !['collected','paid'].includes(o.status)).length || 0)
    + (tables?.filter(t => t.status !== 'available').length || 0)
    + (tabs?.filter(t => t.status !== 'closed').length || 0);
  const urlParam = deviceConfig?.param;

  // Printer status — poll bridge every 30s
  const [printerStatus, setPrinterStatus] = useState(null); // null | 'online' | 'offline'
  const [printers, setPrinters] = useState(() => { try { return JSON.parse(localStorage.getItem('rpos-printers') || '[]'); } catch { return []; } });

  useEffect(() => {
    const update = () => { try { setPrinters(JSON.parse(localStorage.getItem('rpos-printers') || '[]')); } catch {} };
    window.addEventListener('rpos-printers-updated', update);
    window.addEventListener('storage', update);
    return () => { window.removeEventListener('rpos-printers-updated', update); window.removeEventListener('storage', update); };
  }, []);

  useEffect(() => {
    if (!printers.length) return;
    const check = async () => {
      const cfg = (() => { try { return JSON.parse(localStorage.getItem('rpos-printer-config') || '{}'); } catch { return {}; } })();
      const bridgeUrl = cfg.bridgeUrl || 'http://localhost:3001';
      try {
        const res = await fetch(`${bridgeUrl}/status`, { signal: AbortSignal.timeout(3000) });
        const data = await res.json();
        setPrinterStatus(data.ok ? 'online' : 'offline');
      } catch {
        setPrinterStatus('offline');
      }
    };
    check();
    const id = setInterval(check, 30000);
    return () => clearInterval(id);
  }, [printers.length]);

  return (
    <div style={{ height:58, display:'flex', alignItems:'center', gap:14, background:'var(--glass-bg)', backdropFilter:'blur(22px) saturate(150%)', WebkitBackdropFilter:'blur(22px) saturate(150%)', borderBottom:'1px solid var(--glass-border)', flexShrink:0, padding:'0 16px' }}>
      {/* Logo tile */}
      <div style={{ width:40, height:40, borderRadius:11, display:'flex', alignItems:'center', justifyContent:'center', background:'var(--glass-bg)', border:'1px solid var(--glass-border)', boxShadow:'var(--glass-hi)', flexShrink:0 }}>
        <ServOSIcon size={20} />
      </div>

      {/* Terminal identity */}
      <div style={{ display:'flex', flexDirection:'column', gap:1, flexShrink:0 }}>
        <div style={{ fontSize:15, fontWeight:600, color:'var(--t1)', letterSpacing:'-.01em', lineHeight:1.1 }}>{terminalName}</div>
        <div style={{ fontFamily:'var(--font-mono)', fontSize:9.5, fontWeight:500, color: profileName ? 'var(--t2)' : 'var(--t4)', letterSpacing:'.22em', textTransform:'uppercase', whiteSpace:'nowrap' }}>
          {profileName || 'No profile'}{urlParam && <span style={{ marginLeft:5, padding:'0 4px', background:'var(--inset)', borderRadius:3, color:'var(--t4)', fontSize:8 }}>?t={urlParam}</span>}
        </div>
      </div>

      <div style={{ width:1, height:30, background:'var(--glass-border)', flexShrink:0 }}/>

      {/* Shift pill */}
      <div style={{ display:'inline-flex', alignItems:'center', gap:7, padding:'7px 12px', borderRadius:999, background:'var(--inset)', border:'1px solid var(--inset-border)', flexShrink:0 }}>
        <span style={{ width:8, height:8, borderRadius:'50%', background:'var(--grn)', boxShadow:'0 0 9px var(--grn)' }}/>
        <span style={{ fontFamily:'var(--font-mono)', fontSize:10.5, fontWeight:600, letterSpacing:'.1em', textTransform:'uppercase', color:'var(--t1)', whiteSpace:'nowrap' }}>{shift.name || 'Current shift'}</span>
        {syncPulse && <div style={{ width:6, height:6, borderRadius:'50%', background:'var(--acc)', boxShadow:'0 0 8px var(--acc)', animation:'pulse .6s ease-out' }}/>}
      </div>

      <div style={{ flex:1 }}/>

      {/* clock */}
      <div style={{ fontFamily:'var(--font-mono)', fontSize:11, letterSpacing:'.04em', color:'var(--t3)', whiteSpace:'nowrap', flexShrink:0 }}>
        {new Date().toLocaleString('en-GB',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}
      </div>

      {/* theme segmented (sun | moon) */}
      <div style={{ display:'inline-flex', padding:3, borderRadius:11, background:'var(--inset)', border:'1px solid var(--inset-border)', flexShrink:0 }}>
        <button onClick={()=>{ if(theme!=='light') onToggleTheme(); }} title="Light" style={{ width:30, height:26, border:'none', borderRadius:8, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', background: theme==='light'?'var(--glass-bg)':'transparent', boxShadow: theme==='light'?'var(--glass-hi)':'none', color: theme==='light'?'var(--signal-glow,#46E08C)':'var(--t3)', fontFamily:'inherit' }}>
          <Icon name="sun" size={15} />
        </button>
        <button onClick={()=>{ if(theme!=='dark') onToggleTheme(); }} title="Dark" style={{ width:30, height:26, border:'none', borderRadius:8, cursor:'pointer', display:'flex', alignItems:'center', justifyContent:'center', background: theme==='dark'?'var(--glass-bg)':'transparent', boxShadow: theme==='dark'?'var(--glass-hi)':'none', color: theme==='dark'?'var(--signal-glow,#46E08C)':'var(--t3)', fontFamily:'inherit' }}>
          <Icon name="moon" size={15} />
        </button>
      </div>

      {/* Activity feed bell — orders / nudges / menu changes / ops, with a slide-over timeline */}
      <ActivityFeed />

      {/* Orders badge */}
      <button onClick={() => setSurface('orders')} style={{
        display:'flex', alignItems:'center', gap:8, padding:'7px 12px', borderRadius:11, cursor:'pointer',
        background: activeOrders>0 ? 'linear-gradient(180deg, rgba(47,217,132,0.18), rgba(21,194,106,0.08))' : 'var(--inset)',
        border:`1px solid ${activeOrders>0 ? 'rgba(21,194,106,0.45)' : 'var(--inset-border)'}`,
        fontFamily:'inherit', fontSize:13, fontWeight:600, color:'var(--t1)', flexShrink:0,
      }}>
        <Icon name="orders" size={16} style={{ color: activeOrders>0?'var(--acc)':'var(--t3)' }} />
        <span>Orders</span>
        {activeOrders>0 && <span style={{ fontFamily:'var(--font-mono)', fontSize:11, background:'var(--signal,#15C26A)', color:'#06130C', padding:'2px 7px', borderRadius:999, fontWeight:700 }}>{activeOrders}</span>}
      </button>

      {/* version + What's new */}
      <button onClick={onWhatsNew} style={{ display:'flex', alignItems:'center', gap:6, background:'none', border:'none', cursor:'pointer', fontFamily:'var(--font-mono)', fontSize:10, letterSpacing:'.04em', color:'var(--t4)', flexShrink:0, whiteSpace:'nowrap' }}>
        <span>v{version}</span>
        <span style={{ color:'var(--bdr3)' }}>·</span>
        <span style={{ color:'var(--uv-glow, #A48BFF)', fontWeight:600 }}>What's new</span>
      </button>
    </div>
  );
}

function Sidebar({ surface, setSurface }) {
  const { setAppMode, syncStatus, deviceConfig } = useStore();
  const [showStatus, setShowStatus] = useState(false);
  const [showSupport, setShowSupport] = useState(false);

  const hidden = deviceConfig?.hiddenFeatures || [];
  const allOk = syncStatus.printerOnline && !syncStatus.pendingChanges;
  const printers = (() => { try { return JSON.parse(localStorage.getItem('rpos-printers') || '[]'); } catch { return []; } })();
  const hasPrinters = printers.length > 0;

  // v4.5.1: trimmed to only the flags exposed in DeviceProfiles.jsx.
  // Removed: kds, reports, kiosk, floorplan/tables/floor/orders (none were exposed in the profile editor).
  const FEATURE_MAP = { barTabs:'bar', bar:'bar' };
  const visibleNav = NAV.filter(n => {
    // Table service disabled → hide floor plan
    if (n.id === 'tables' && deviceConfig && deviceConfig.tableServiceEnabled === false) return false;
    // Hidden features → hide matching nav item
    return !hidden.some(f => FEATURE_MAP[f] === n.id);
  });

  return (
    <>
    <nav style={{ width:'var(--nav)', background:'var(--glass-bg)', backdropFilter:'blur(22px) saturate(150%)', WebkitBackdropFilter:'blur(22px) saturate(150%)', border:'1px solid var(--glass-border)', borderRadius:20, boxShadow:'var(--glass-shadow), var(--glass-hi), var(--glass-lo)', display:'flex', flexDirection:'column', alignItems:'center', padding:'10px 0', gap:4, flexShrink:0, position:'relative', zIndex:60 }}>
      {visibleNav.map(n=>{
        const active=surface===n.id;
        return(<button key={n.id} onClick={()=>setSurface(n.id)} style={{ width:46, height:46, borderRadius:12, cursor:'pointer', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:3, background:active?'var(--acc-d)':'transparent', border:`1px solid ${active?'var(--acc-b)':'transparent'}`, boxShadow:active?'var(--glass-hi)':'none', color:active?'var(--acc)':'var(--t3)', transition:'all .15s', fontFamily:'inherit', position:'relative' }}>
          <Icon name={n.icon} size={21} stroke={active?2:1.7} />
          <span style={{ fontSize:9, fontWeight:700, letterSpacing:'.04em', color:active?'var(--acc)':'var(--t3)' }}>{n.label}</span>
        </button>);
      })}

      {/* Divider */}
      <div style={{ width:32, height:1, background:'var(--bdr)', margin:'4px 0' }}/>

      {/* Status button — shows dot if anything offline or pending */}
      <button onClick={() => setShowStatus(true)} title="Terminal status" style={{
        width:46, height:46, borderRadius:10, cursor:'pointer',
        display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:2,
        background:'transparent', border:'1px solid transparent',
        color: allOk ? 'var(--t3)' : 'var(--acc)', transition:'all .15s', fontFamily:'inherit',
        position:'relative',
      }}
      onMouseEnter={e=>{e.currentTarget.style.background='var(--bg3)';}}
      onMouseLeave={e=>{e.currentTarget.style.background='transparent';}}>
        <Icon name="status" size={20} />
        <span style={{ fontSize:9, fontWeight:700, letterSpacing:'.04em' }}>Status</span>
        {!allOk && hasPrinters && <div style={{ position:'absolute', top:6, right:8, width:7, height:7, borderRadius:'50%', background:'var(--acc)', boxShadow:'0 0 6px var(--acc)' }}/>}
        {!deviceConfig && <div style={{ position:'absolute', top:6, right:8, width:7, height:7, borderRadius:'50%', background:'var(--red)', boxShadow:'0 0 6px var(--red)' }}/>}
      </button>

      {/* Back Office button */}
      <button onClick={() => { window.location.href = "?mode=office"; }} title="Back Office" style={{
        width:46, height:46, borderRadius:10, cursor:'pointer',
        display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:2,
        background:'transparent', border:'1px solid transparent',
        color:'var(--t3)', transition:'all .15s', fontFamily:'inherit',
      }}
      onMouseEnter={e=>{e.currentTarget.style.background='var(--bg3)';e.currentTarget.style.color='var(--t1)';}}
      onMouseLeave={e=>{e.currentTarget.style.background='transparent';e.currentTarget.style.color='var(--t3)';}}>
        <Icon name="office" size={20} />
        <span style={{ fontSize:9, fontWeight:700, letterSpacing:'.04em' }}>Office</span>
      </button>

      {/* Support chat button */}
      <button onClick={() => setShowSupport(true)} title="Support" style={{
        width:46, height:46, borderRadius:10, cursor:'pointer',
        display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', gap:2,
        background:'transparent', border:'1px solid transparent',
        color:'var(--t3)', transition:'all .15s', fontFamily:'inherit',
      }}
      onMouseEnter={e=>{e.currentTarget.style.background='var(--bg3)';e.currentTarget.style.color='var(--t1)';}}
      onMouseLeave={e=>{e.currentTarget.style.background='transparent';e.currentTarget.style.color='var(--t3)';}}>
        <Icon name="support" size={20} />
        <span style={{ fontSize:9, fontWeight:700, letterSpacing:'.04em' }}>Support</span>
      </button>

      <div style={{ marginTop:'auto' }}><StaffAvatar /></div>
    </nav>

    {showStatus && <StatusDrawer onClose={() => setShowStatus(false)} />}
    <SupportChat open={showSupport} onClose={() => setShowSupport(false)} />
    </>
  );
}

function StaffAvatar() {
  const [open,setOpen]=useState(false);
  const { staff, logout }=useStore();
  if (!staff) return null;
  return(
    <div style={{ position:'relative', marginBottom:8 }}>
      <div onClick={()=>setOpen(o=>!o)} style={{ width:34, height:34, borderRadius:'50%', cursor:'pointer', background:staff.color+'22', border:`2px solid ${staff.color}55`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:700, color:staff.color }}>{staff.initials}</div>
      {open&&(<div style={{ position:'absolute', bottom:42, left:0, background:'var(--bg3)', border:'1px solid var(--bdr2)', borderRadius:12, padding:8, minWidth:160, boxShadow:'var(--sh3)', zIndex:50 }}>
        <div style={{ padding:'6px 10px', fontSize:13, fontWeight:600, color:'var(--t1)' }}>{staff.name}</div>
        <div style={{ padding:'2px 10px 8px', fontSize:12, color:'var(--t3)' }}>{staff.role}</div>
        <div style={{ height:1, background:'var(--bdr)', margin:'4px 0' }}/>
        <button onClick={()=>{logout();setOpen(false);}} style={{ width:'100%', padding:'7px 10px', borderRadius:8, cursor:'pointer', background:'transparent', border:'none', color:'var(--red)', fontSize:13, textAlign:'left', fontFamily:'inherit', fontWeight:500 }}>Sign out</button>
      </div>)}
    </div>
  );
}

function Toast({ toast }) {
  const map={success:{bg:'var(--grn-d)',bdr:'var(--grn-b)',color:'var(--grn)'},error:{bg:'var(--red-d)',bdr:'var(--red-b)',color:'var(--red)'},warning:{bg:'var(--acc-d)',bdr:'var(--acc-b)',color:'var(--acc)'},info:{bg:'var(--bg3)',bdr:'var(--bdr2)',color:'var(--t1)'}};
  const c=map[toast.type]||map.info;
  return <div className="toast" key={toast.key} style={{ background:c.bg, border:`1px solid ${c.bdr}`, color:c.color }}>{toast.msg}</div>;
}

// ─────────────────────────────────────────────────────────────────────────────
// OrderAlert — center-screen popup for an incoming order (v5.5.561, was a top
// banner). A dimmed backdrop + a card in the MIDDLE of the screen so staff can
// act on it without hunting for the Orders Hub:
//   • Channel order still awaiting a decision (HubRise, auto-accept OFF) → big
//     Reject / Accept buttons that run the same path as the Orders Hub.
//   • Online / kiosk / QR (or an already auto-accepted channel order) → View order
//     (jumps to the Orders Hub) / Dismiss.
//   • A channel cancellation (kind:'cancel') → red card, Dismiss only.
// Dismiss just closes the popup — the order stays in the Orders Hub. Rendered for
// POS / Bar / Tables / Orders (KDS is excluded at the call site; it has tickets).
function orderAlertBtn(bg) {
  return { flex: 1, height: 54, borderRadius: 12, border: 'none', cursor: 'pointer',
    background: bg, color: '#fff', fontSize: 17, fontWeight: 800, fontFamily: 'inherit' };
}
function OrderAlert({ alert, onDismiss, setSurface }) {
  const acceptOrderByRef = useStore(s => s.acceptOrderByRef);
  const acceptOrderByRefWithDelay = useStore(s => s.acceptOrderByRefWithDelay);
  const rejectOrderByRef = useStore(s => s.rejectOrderByRef);
  const order = useStore(s => (s.orderQueue || []).find(o => o.ref === alert.ref));
  // v5.5.852: ⏱ Delay on the popup too — staff accept from here in practice, so the
  // accept-with-delay path (v5.5.849, Orders Hub card) must also exist on this card.
  const [delayOpen, setDelayOpen] = useState(false);

  const SOURCE_META = {
    kiosk:  { icon: '📟', label: 'Kiosk',    bg: '#0ea5e9' },  // sky-500
    online: { icon: '🌐', label: 'Online',   bg: '#10b981' },  // emerald-500
    qr:     { icon: '📱', label: 'QR Code',  bg: '#a855f7' },  // purple-500
    hubrise:{ icon: '🛵', label: 'Delivery', bg: '#e8a020' },  // amber
  };
  const isCancel = alert.kind === 'cancel';
  const m = isCancel
    ? { icon: '⚠️', label: alert.who || 'Channel', bg: '#dc2626' }
    : (SOURCE_META[alert.source] || { icon: '🛎', label: alert.source || 'Order', bg: '#e8a020' });
  const total = Number(alert.total || 0);

  // A channel order that the operator still has to accept/reject (auto-accept off
  // → it arrives 'received'/'new', not yet 'prep').
  const needsDecision = !isCancel && alert.source === 'hubrise'
    && !['prep', 'ready', 'collected', 'cancelled'].includes(alert.status);

  const accept = () => { acceptOrderByRef?.(alert.ref); onDismiss(); };
  const acceptDelay = (mins) => { acceptOrderByRefWithDelay?.(alert.ref, mins); onDismiss(); };
  const reject = () => {
    if (!confirm(`Reject ${alert.who || 'this'} order ${alert.ref}? The channel will be notified.`)) return;
    rejectOrderByRef?.(alert.ref); onDismiss();
  };
  const view = () => { setSurface?.('orders'); onDismiss(); };

  const items = order?.items || [];

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) onDismiss(); }}
      style={{ position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        animation: 'fadeIn .18s ease', fontFamily: 'inherit' }}>
      <div key={alert.key} style={{
        width: 'min(440px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 32px)',
        background: 'var(--bg2)', color: 'var(--t1)', borderRadius: 18, overflow: 'hidden',
        boxShadow: '0 24px 70px rgba(0,0,0,0.55)', display: 'flex', flexDirection: 'column',
        animation: 'slideUp .26s cubic-bezier(0.2, 0.9, 0.3, 1.25)', border: '1px solid var(--bdr)' }}>

        {/* Coloured header */}
        <div style={{ background: m.bg, color: '#fff', padding: '18px 20px', display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ width: 52, height: 52, borderRadius: 14, background: 'rgba(255,255,255,0.22)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, flexShrink: 0 }}>{m.icon}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.09em', textTransform: 'uppercase', opacity: 0.9 }}>
              {isCancel ? 'Order cancelled' : `New ${m.label} order`}
            </div>
            <div style={{ fontSize: 21, fontWeight: 900, lineHeight: 1.2, marginTop: 2,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {alert.who || 'Guest'}
            </div>
            <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.92, marginTop: 2 }}>
              {alert.ref ? <>Ref <span style={{ fontFamily: 'monospace' }}>{alert.ref}</span></> : null}
              {total > 0 && <> · {money(total)}</>}
            </div>
          </div>
        </div>

        {/* Body */}
        {!isCancel && items.length > 0 && (
          <div style={{ padding: '14px 20px', overflowY: 'auto', borderBottom: '1px solid var(--bdr)' }}>
            {items.slice(0, 12).map((it, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, fontSize: 13.5, padding: '3px 0', color: 'var(--t2)' }}>
                <b style={{ color: 'var(--t1)', flexShrink: 0 }}>{it.qty || it.quantity || 1}×</b>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name || it.menuName || 'Item'}</span>
              </div>
            ))}
            {items.length > 12 && <div style={{ fontSize: 12, color: 'var(--t3)', marginTop: 4 }}>+{items.length - 12} more…</div>}
          </div>
        )}
        {isCancel && (
          <div style={{ padding: '16px 20px', fontSize: 13.5, color: 'var(--t2)', borderBottom: '1px solid var(--bdr)' }}>
            This order was cancelled on the channel. If the kitchen has started it, stop and reconcile.
          </div>
        )}

        {/* Actions */}
        {needsDecision && delayOpen && (
          <div style={{ padding: '12px 16px 0', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--t2)' }}>Kitchen running behind — accept for:</span>
            {[10, 15, 20, 30].map(mins => (
              <button key={mins} onClick={() => acceptDelay(mins)}
                style={{ padding: '8px 14px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
                  background: 'var(--bg1)', border: '1px solid var(--acc)', color: 'var(--acc)',
                  fontSize: 13, fontWeight: 800, whiteSpace: 'nowrap' }}>
                +{mins}m
              </button>
            ))}
          </div>
        )}
        <div style={{ padding: 16, display: 'flex', gap: 10 }}>
          {isCancel ? (
            <button onClick={onDismiss} style={orderAlertBtn('#475569')}>Dismiss</button>
          ) : needsDecision ? (
            <>
              <button onClick={reject} style={orderAlertBtn('#dc2626')}>Reject</button>
              <button onClick={() => setDelayOpen(v => !v)}
                style={{ ...orderAlertBtn(delayOpen ? '#b45309' : '#d97706'), flex: '0 0 auto', padding: '0 16px' }}>
                ⏱ Delay
              </button>
              <button onClick={accept} style={orderAlertBtn('#16a34a')}>Accept</button>
            </>
          ) : (
            <>
              <button onClick={onDismiss} style={orderAlertBtn('#475569')}>Dismiss</button>
              <button onClick={view} style={orderAlertBtn('#2563eb')}>View order</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
