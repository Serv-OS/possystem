import { useState, useEffect, useMemo, useRef } from 'react';
import { useStore, loadVenueMenu, whenMenuLoadIdle, whenMenuWritesIdle, beginMenuRead, applyVenueMenuRead, saveUnsavedMenuRows, failedCreateIds, MENU_WAIT_MS, instructionGroupsBase, setInstructionGroupsBase } from '../store';
import { withTimeout } from '../lib/withTimeout';
import { pushedByName } from '../lib/pushedBy';
import { mergeInstructionGroups } from '../lib/threeWayMerge';
import { ServOSIcon } from '../components/ServOSBrand';
import { Icon } from '../components/ServOSIcons';
import SupportChat from '../components/SupportChat';
import { broadcastConfigPush } from '../sync/SyncBridge';
import { supabase, isMock, platformSupabase, getLocationId, setResolvedLocationId, clearResolvedLocationId } from '../lib/supabase';
import BOLogin from './BOLogin';
import SecondStepGate from '../components/secondStep/SecondStepGate';
import SignInSecurity from './sections/SignInSecurity';
import { isRealLogin, sessionProvesSecondStep } from '../lib/secondStep/rules';
import { hasWeakPasswordNote } from '../lib/secondStep/client';
import LocationSwitcher from './LocationSwitcher';
import { VERSION } from '../lib/version';
import { CUSTOMER_ROOT, customerUrl } from '../lib/env';
import { fetchTableTombstones, fetchFloorPlanVersioned, insertConfigPush } from '../lib/db';
import { readVenueMenu, unsavedMenuRows, unsavedWords, menuSnapshotFromRead, emptyItemsReadSuspect, venueItemCount } from '../lib/venueMenuRead';
import { toTopLevelWords } from '../lib/menuWriters';
import { taggedVenueRows } from '../lib/venueTaxRates';
import { settleBoVenue, foreignVenueSlices, venueRowsOnly } from '../lib/boVenueBoot';
import { startBoSessionWatch, sameAuthUser } from '../lib/boSessions';
import { loadPlanState, mergeTombs, tombstonesFromRows, normaliseFloorRow, nextSeq } from '../lib/tablePlan';
import { refreshTablePlan } from '../sync/TablePlanSync';
import { normaliseSections } from '../lib/sectionPlan';
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
import CardPayments from './sections/CardPayments';
import CashDrawers from './sections/CashDrawers';
import BOReports from './sections/BOReports';
import EODClose from './sections/EODClose';
import Customers from './sections/Customers';
import Shift from './sections/Shift';
import Inventory from './sections/Inventory';
import StockItems from './sections/StockItems';
import StockOverview from './sections/StockOverview';
import OpsOverview from './sections/operations/OpsOverview';
import OpsTemperature from './sections/operations/OpsTemperature';
import OpsMaintenance from './sections/operations/OpsMaintenance';
import OpsCompliance from './sections/operations/OpsCompliance';
import OpsChecklists from './sections/operations/OpsChecklists';
import OpsNotifications from './sections/operations/OpsNotifications';
import OpsDevices from './sections/operations/OpsDevices';
import OpsPrepSchedule from './sections/operations/OpsPrepSchedule';
import OpsDocuments from './sections/operations/OpsDocuments';
import OpsForms from './sections/operations/OpsForms';
import WaitlistConfig from './sections/WaitlistConfig';
import WaitlistInsights from './sections/WaitlistInsights';
import StockReports from './sections/StockReports';
import StockCounts from './sections/StockCounts';
import Wastage from './sections/Wastage';
import Recipes from './sections/Recipes';
import Batches from './sections/Batches';
import Suppliers from './sections/Suppliers';
import PurchaseOrders from './sections/PurchaseOrders';
import PriceChanges from './sections/PriceChanges';
import Invoices from './sections/Invoices';
import OrderPad from './sections/OrderPad';
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
import Workforce from './sections/Workforce';
import ReviewManager from './sections/ReviewManager';
import WifiManager from './sections/WifiManager';
import Promotions from './sections/marketing/Promotions';
import Segments from './sections/marketing/Segments';
import Campaigns from './sections/marketing/Campaigns';
import QuickSend from './sections/marketing/QuickSend';
import Workflows from './sections/marketing/Workflows';
import MarketingReports from './sections/marketing/MarketingReports';
import CateringSettings from './sections/CateringSettings';
import MenuAppearance from './sections/MenuAppearance';
import CateringOrders from './sections/CateringOrders';
import HubRise from './sections/HubRise';
import UberDirect from './sections/UberDirect';
import DeliveriesBoard from './sections/DeliveriesBoard';
import Compliance from './sections/marketing/Compliance';
import SendingDomain from './sections/marketing/SendingDomain';
import XeroIntegration from './sections/XeroIntegration';
import MenuBoards from './sections/MenuBoards';
import OrderScreens from './sections/OrderScreens';
import PrintMenu from './sections/PrintMenu';
import PackageBuilder from './sections/PackageBuilder';
import TableBookings from './sections/TableBookings';
import ServosMessages from './sections/ServosMessages';
import VenueMessagePopup from '../components/VenueMessagePopup';
import { money, currencySymbol } from '../lib/currency';
import { subscribeSaveHealth } from '../lib/saveHealth';
import { shouldRegate, sessionIdOf, idleTooLong, idleSignOutMessage, ACTIVITY_EVENTS } from '../lib/backOfficeSession';

// Open-group height for the sidebar's collapse animation: rows are ~34px (8px padding, 12.8px
// text, 1px gap) plus the list's own padding. Generous per row so nothing is ever clipped; the
// transition only needs a ceiling. Pure, pinned by src/lib/boSidebar.test.js.
export const navGroupMaxHeight = (rows) => Math.max(1, Number(rows) || 0) * 44 + 24;

const NAV = [
  { id:'overview',   label:'Overview',        icon:'◈',  group:'Dashboard' },
  { id:'menu',       label:'Menu manager',    icon:'🍽',  group:'Configuration' },
  { id:'floorplan',  label:'Floor plan',      icon:'⬚',  group:'Configuration' },
  { id:'stock-overview', label:'Stock overview', icon:'📦',  group:'Configuration' },
  { id:'inventory',  label:'Daily counts',    icon:'📦',  group:'Configuration' },
  { id:'stock-counts', label:'Stock counts',  icon:'📋',  group:'Configuration' },
  { id:'wastage',    label:'Wastage',         icon:'🗑',  group:'Configuration' },
  { id:'stock-reports', label:'Stock reports', icon:'📊',  group:'Configuration' },
  { id:'stock-items', label:'Stock items',     icon:'📦',  group:'Configuration' },
  { id:'recipes',    label:'Recipes',         icon:'📖',  group:'Configuration' },
  { id:'batches',    label:'Batches',         icon:'🍲',  group:'Configuration' },
  { id:'ops-overview',    label:'Compliance overview', icon:'🌡', group:'Operations' },
  { id:'ops-temperature', label:'Temperature units',   icon:'🌡', group:'Operations' },
  { id:'ops-checklists',  label:'Checklists',          icon:'☑', group:'Operations' },
  { id:'ops-prep',        label:'Prep schedule',       icon:'🍳', group:'Operations' },
  { id:'ops-maintenance', label:'Maintenance',         icon:'🛠', group:'Operations' },
  { id:'ops-notifications', label:'Alert rules',       icon:'🔔', group:'Operations' },
  { id:'ops-compliance',  label:'Compliance calendar', icon:'📅', group:'Operations' },
  { id:'ops-devices',     label:'Devices',             icon:'📱', group:'Operations' },
  { id:'ops-documents',   label:'Documents',           icon:'📄', group:'Operations' },
  { id:'ops-forms',       label:'Forms',               icon:'📝', group:'Operations' },
  { id:'order-pad',  label:'Order pad',       icon:'🛒',  group:'Configuration' },
  { id:'suppliers',  label:'Suppliers',       icon:'🚚',  group:'Configuration' },
  { id:'purchase-orders', label:'Orders', icon:'🧾', group:'Configuration' },
  { id:'price-changes', label:'Price changes', icon:'📈', group:'Configuration' },
  { id:'invoices',   label:'Invoices',        icon:'📄',  group:'Configuration' },
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
  { id:'card-payments', label:'Card payments',  icon:'💳',  group:'Analytics' },
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
  { id: 'reviews', label: 'Reviews', icon: '\u{2B50}', group: 'Analytics' },
  { id: 'wifi', label: 'WiFi', icon: '\u{1F4F6}', group: 'Analytics' },
  { id: 'promotions', label: 'Promotions', icon: '\u{1F3AB}', group: 'Analytics' },
  { id: 'segments', label: 'Segments', icon: '\u{1F465}', group: 'Analytics' },
  { id: 'campaigns', label: 'Campaigns', icon: '\u{1F4E3}', group: 'Analytics' },
  { id: 'quicksend', label: 'Quick send', icon: '\u{1F4EC}', group: 'Analytics' },
  { id: 'workflows', label: 'Automations', icon: '\u{1F500}', group: 'Analytics' },
  { id: 'marketing-reports', label: 'Marketing report', icon: '\u{1F4C8}', group: 'Analytics' },
  { id: 'compliance', label: 'Marketing compliance', icon: '\u{1F6E1}', group: 'Analytics' },
  { id: 'security', label: 'Sign in security', icon: '\u{1F510}', group: 'Settings' },
  { id: 'servos-messages', label: 'Messages from ServOS', icon: '\u{1F514}', group: 'Settings' },
];

// v5.5.367 ServOS: intent-based 10-section sidebar IA. Every child keeps the
// existing section id (route) from NAV above — this regroups, never re-wires.
// `single` = the header navigates straight to that route; `children` = a
// collapsible accordion of existing routes.
const NAV_IA = [
  { label:'Overview',   icon:'home',      single:'overview' },
  { label:'Menu',       icon:'list',      children:[['menu','Items & modifiers'],['discounts','Discounts'],['tax','Tax & VAT'],['challenge21','Challenge ID']] },
  { label:'Floor plan', icon:'floor',     single:'floorplan' },
  { label:'Inventory',  icon:'inventory', children:[['stock-overview','Overview'],['stock-items','Stock items'],['stock-counts','Stock counts'],['wastage','Wastage'],['inventory','Daily counts'],['stock-reports','Reports']] },
  { label:'Produce',    icon:'inventory', children:[['recipes','Recipes'],['batches','Batches']] },
  { label:'Purchasing', icon:'channels',  children:[['order-pad','Order pad'],['suppliers','Suppliers'],['purchase-orders','Orders'],['invoices','Invoices'],['price-changes','Price changes']] },
  { label:'Operations', icon:'inventory', children:[['ops-overview','Compliance'],['ops-temperature','Temperature'],['ops-checklists','Checklists'],['ops-prep','Prep schedule'],['ops-maintenance','Maintenance'],['ops-notifications','Alert rules'],['ops-compliance','Calendar'],['ops-documents','Documents'],['ops-forms','Forms'],['ops-devices','Devices']] },
  { label:'Team',       icon:'user',      single:'staff' },
  { label:'Workforce',  icon:'team',      children:[['wf-dashboard','Dashboard'],['wf-rota','Rota'],['wf-timesheets','Timesheets'],['wf-payroll','Payroll'],['wf-timeoff','Time off & availability'],['wf-staff','Staff'],['wf-onboarding','Onboarding'],['wf-compliance','Compliance'],['wf-training','Training'],['wf-pay','Positions & rates'],['wf-tronc','Tronc / tips'],['wf-announce','Announcements'],['wf-settings','Workforce settings']] },
  { label:'Customers',  icon:'customers', children:[['customers','Customers'],['promotions','Promotions'],['segments','Segments'],['campaigns','Campaigns'],['quicksend','Quick send'],['workflows','Automations'],['marketing-reports','Marketing report'],['compliance','Marketing compliance'],['wifi','WiFi'],['reviews','Reviews'],['loyalty','Loyalty'],['giftcards','Gift cards'],['messages','Messages']] },
  { label:'Channels',   icon:'channels',  children:[['online','Online ordering'],['catering','Catering ordering'],['catering-orders','Advance orders'],['hubrise','3rd Party orders'],['uber-direct','Delivery'],['deliveries-live','Deliveries (live)'],['waitlist','Tables Ready'],['table-bookings','Table bookings'],['packages','Packages & events'],['menu-appearance','Appearance'],['kiosks','Kiosks'],['menuboards','Menu boards'],['order-screens','Order screens'],['print-menu','Print menu']] },
  { label:'Hardware',   icon:'hardware',  children:[['devices','Terminals'],['profiles','Device profiles'],['printers','Printers'],['printing','Production printing'],['cardreaders','Card readers'],['cashdrawers','Cash drawers'],['network','Network & sync']] },
  { label:'Reports',    icon:'reports',   children:[['reports','All reports'],['shift','Shifts'],['eod','Close day'],['pettycash','Petty cash'],['waitlist-insights','Tables Ready']] },
  { label:'Card payments', icon:'card',   single:'card-payments' },
  { label:'Settings',   icon:'settings',  children:[['location','Location settings'],['security','Sign in security'],['servos-messages','Messages from ServOS'],['receipt','Receipt'],['sending-domain','Email domain'],['xero','Xero (accounting)'],['ai','AI assistant']] },
];

// v5.5.951 — the "Premium Sauces vanished" guard. Menu writers used to log failures
// to the console and nothing else, while the screen showed the change as saved; a
// tab whose login had silently expired could edit for hours and lose EVERYTHING on
// refresh (reads stay alive on anon policies, so the app still looked signed in).
// This banner is undismissable while saves are failing and clears itself on the
// next successful save. saveHealth also auto-kicks a session refresh on auth errors.
// v5.5.971 — THE BACK OFFICE NEVER RENDERED TOASTS.
// store.showToast() sets `toast`, but the only <Toast> in the app lives inside
// the POS shell (App.jsx ValidatedPOSApp). The Back Office returns from an
// EARLIER branch (App.jsx:275), so every confirmation AND every error message
// in every BO screen — "Save failed", "Could not save to cloud", "Rate card
// saved" — has been silently discarded since the BO was built. Same family as
// the vanishing-categories saga: the app knew, the operator never did.
function BackOfficeToast() {
  const toast = useStore(s => s.toast);
  if (!toast) return null;
  const map = {
    success: { bg:'var(--grn-d)', bdr:'var(--grn-b)', color:'var(--grn)' },
    error:   { bg:'var(--red-d)', bdr:'var(--red-b)', color:'var(--red)' },
    warning: { bg:'var(--acc-d)', bdr:'var(--acc-b)', color:'var(--acc)' },
    info:    { bg:'var(--bg3)',   bdr:'var(--bdr2)',  color:'var(--t1)'  },
  };
  const c = map[toast.type] || map.info;
  return (
    <div className="toast" key={toast.key}
      style={{ background:c.bg, border:`1px solid ${c.bdr}`, color:c.color, zIndex:100003 }}>
      {toast.msg}
    </div>
  );
}

// Supabase flags a password that is too short or appears in a known data leak at sign in
// (BOLogin notes it). Peter: "a lot of people using basic passwords". Stays until changed.
// 27 Sep 2026 (Peter: "every products tax rate has been removed but they where there earlier"):
// he had two Back Office sessions open at Leeds, and the older one wrote its stale products back
// over the tax he had just applied. Every tab now says when another tab of this browser is open on
// the same venue (lib/boSessions.js). Keyed by venue where it is mounted, so a venue switch starts
// a fresh watch.
function OtherTabBanner({ venue }) {
  const [others, setOthers] = useState(0);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (!venue) return undefined;
    const stop = startBoSessionWatch({ venue, onChange: (n) => { setOthers(n); if (n > 0) setHidden(false); } });
    window.addEventListener('pagehide', stop);
    return () => { window.removeEventListener('pagehide', stop); stop(); };
  }, [venue]);
  if (!others || hidden) return null;
  return (
    <div data-testid="other-tab-banner" style={{
      display:'flex', alignItems:'center', gap:14, flexWrap:'wrap', padding:'10px 24px',
      background:'rgba(245,166,35,0.12)', borderBottom:'1px solid rgba(245,166,35,0.45)',
      color:'var(--t1)', fontSize:13.5, lineHeight:1.5,
    }}>
      <span style={{ flex:1, minWidth:240 }}>
        <strong>Back Office is open in another tab for this venue.</strong> Changes made there do not show here until you reload this page. Close the tabs you are not using.
      </span>
      <button onClick={() => window.location.reload()} style={{
        padding:'7px 14px', borderRadius:9, border:'none', background:'var(--acc)', color:'#06130C',
        fontWeight:700, fontSize:13, cursor:'pointer', fontFamily:'inherit',
      }}>Reload</button>
      <button onClick={() => setHidden(true)} style={{
        padding:'7px 12px', borderRadius:9, border:'1px solid var(--bdr)', background:'transparent', color:'var(--t2)',
        fontWeight:700, fontSize:13, cursor:'pointer', fontFamily:'inherit',
      }}>Hide</button>
    </div>
  );
}

function WeakPasswordBanner({ onFix }) {
  const [show, setShow] = useState(() => hasWeakPasswordNote());
  useEffect(() => {
    const hide = () => setShow(false);
    window.addEventListener('rpos-weak-password-cleared', hide);
    return () => window.removeEventListener('rpos-weak-password-cleared', hide);
  }, []);
  if (!show) return null;
  return (
    <div data-testid="weak-password-banner" style={{
      display:'flex', alignItems:'center', gap:14, flexWrap:'wrap', padding:'10px 24px',
      background:'rgba(245,166,35,0.12)', borderBottom:'1px solid rgba(245,166,35,0.45)',
      color:'var(--t1)', fontSize:13.5, lineHeight:1.5,
    }}>
      <span style={{ flex:1, minWidth:240 }}>
        <strong>Your password is weak.</strong> It is too short or has appeared in a data leak. Please change it now.
      </span>
      <button onClick={onFix} style={{
        padding:'7px 14px', borderRadius:9, border:'none', background:'var(--acc)', color:'#06130C',
        fontWeight:700, fontSize:13, cursor:'pointer', fontFamily:'inherit',
      }}>Change password</button>
    </div>
  );
}

function SaveHealthBanner() {
  const [health, setHealth] = useState({ broken: false });
  useEffect(() => subscribeSaveHealth(setHealth), []);
  if (!health.broken) return null;
  return (
    <div style={{
      position:'fixed', top:0, left:0, right:0, zIndex:100002,
      background:'var(--red, #d33)', color:'#fff', padding:'12px 18px',
      fontSize:13.5, fontWeight:800, textAlign:'center', lineHeight:1.45,
      boxShadow:'0 2px 18px rgba(0,0,0,.45)',
    }}>
      {health.offline
        ? '⚠ NO CONNECTION TO THE SERVER — the last change did not reach us and was not saved. Check this device\u2019s internet; we keep trying, and this bar clears the moment a save gets through.'
        : health.denied
          ? '⚠ YOU ARE NOT SET UP FOR THIS VENUE — nothing you change here can save. This is not a fault: your login has not been given this venue. Switch back to your own venue, or ask the owner to add you to this one.'
          : health.authy
            ? '⚠ YOUR CHANGES ARE NOT SAVING — your sign-in has expired. Refresh this page and sign in again, then REDO the change you just made.'
            : `⚠ YOUR CHANGES ARE NOT SAVING — ${health.message || 'database write failed'}. Redo the change once this clears.`}
      <span style={{ fontWeight:500, opacity:.9 }}> Anything edited while this bar is showing will be lost.</span>
    </div>
  );
}

/**
 * Resolve a location id we are certain the signed-in user can actually write to.
 *
 * The back office kept a location id in localStorage and handed it straight to
 * the Ops database. When that value was wrong — stale, from another environment,
 * or a Platform id rather than an Ops one — every insert was rejected by row
 * level security and the user got "your changes are not saving" with no way to
 * tell why, and no way to clear it without a console.
 *
 * There are two id spaces: the Ops database (shifts, orders, checks) and the
 * Platform database (billing, payments, devices). Most venues share an id, but
 * not all — Platform carries `ops_location_id` as the mapping. Anything talking
 * to Ops must use the Ops id.
 *
 * So: verify, then translate, then give up cleanly. Never hand back an id the
 * user cannot use.
 *
 * @returns {Promise<{id: string|null, changed: boolean, reason: string}>}
 */
async function resolveWritableLocation(candidate, accessibleIds) {
  if (!candidate) return { id: null, changed: false, reason: 'none stored' };

  // Already an Ops id this user can reach — the normal path, no work done.
  if (accessibleIds.has(candidate)) return { id: candidate, changed: false, reason: 'ok' };

  // Not reachable. Before discarding it, see if it is the Platform id for a
  // venue the user *can* reach, and swap it for the Ops one.
  if (platformSupabase) {
    try {
      const { data } = await platformSupabase
        .from('locations').select('ops_location_id').eq('id', candidate).maybeSingle();
      const mapped = data?.ops_location_id || null;
      if (mapped && accessibleIds.has(mapped)) {
        console.warn('[BackOfficeApp] stored location', candidate, 'was a Platform id — translated to Ops id', mapped);
        return { id: mapped, changed: true, reason: 'translated from platform id' };
      }
    } catch (e) {
      console.warn('[BackOfficeApp] platform id translation failed:', e?.message);
    }
  }

  // Genuinely unusable. Say so loudly and let the caller re-resolve, rather
  // than writing rows that RLS is certain to reject.
  console.warn('[BackOfficeApp] stored location', candidate, 'is not accessible and has no Ops mapping — discarding');
  return { id: null, changed: true, reason: 'not accessible' };
}

export default function BackOfficeApp() {
  const { setAppMode, staff, closedChecks, tables, devices, theme, setTheme } = useStore();
  // v5.5.328: apply the saved light/dark theme on back-office boot. The store's
  // setTheme sets data-theme when toggled, but on a fresh BO load nothing has
  // applied it yet, so without this the BO always starts dark.
  useEffect(() => { try { document.documentElement.setAttribute('data-theme', theme || 'dark'); } catch {} }, [theme]);
  // v5.5.350: ServOS skin flag — back office is a staff surface (on <html> so
  // portaled modals inherit it). TODO(servos): the companion spec wants BO to
  // DEFAULT to light; today POS + BO share one store `theme`, so changing the
  // default would alter behaviour — left bound to the existing toggle for now.
  useEffect(() => { document.documentElement.setAttribute('data-skin','servos'); return () => document.documentElement.removeAttribute('data-skin'); }, []);
  const [authUser, setAuthUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(isMock);
  const [recovering, setRecovering] = useState(false); // v5.5.343: password-reset link landing
  // SECOND SIGN IN STEP (docs/SECOND_STEP.md): nothing of the Back Office loads until the
  // SecondStepGate says this sign in did Face ID, fingerprint or an authenticator code (aal2).
  // It closes again if the session ever drops back to password only (a reset by an owner).
  const [secondStepOk, setSecondStepOk] = useState(isMock);
  const [recoveryStepOk, setRecoveryStepOk] = useState(false);
  const bootedPasswordOnly = useRef(false);
  // The sign in that has already passed the gate in THIS tab. Memory only: a
  // reload asks again, and nothing a browser could be told to lie about decides
  // it (the fence is the database, this is only the screen).
  const passedSessionId = useRef(null);
  const [section, setSection] = useState('overview');
  const [orgCtx, setOrgCtx] = useState(null); // { orgName, locationName, locationId, orgId, role }
  const [showLocationSwitcher, setShowLocationSwitcher] = useState(false);
  const [showSupport, setShowSupport] = useState(false);
  // v5.5.367 ServOS: which nav accordion is open (single-open); auto-opens the
  // section that contains the current route.
  const [openNav, setOpenNav] = useState(null);
  useEffect(() => {
    const k = NAV_IA.find(s => s.single === section || (s.children||[]).some(c => c[0] === section))?.label;
    if (k) setOpenNav(k);
  }, [section]);

  // Check Supabase session on mount
  useEffect(() => {
    if (isMock) return;
    // v5.5.306: the Supabase client shares storageKey 'rpos-auth' with the
    // anonymous sign-in used by ensureAuthToken() (payments / edge functions /
    // POS device token). An anonymous session is NOT a back-office login — if
    // we treat it as one, the BO renders with no login prompt and no location
    // ("blank back office"). Reject anonymous users so BOLogin shows instead.
    const realUser = (u) => (u && !u.is_anonymous && u.email ? u : null);
    // v5.5.307: if a stray anonymous session is in storage (created by a prior
    // ensureAuthToken call before this build), sign it out so it can't linger
    // and so getLocationId/data paths don't run against a userless session.
    const cleanAnon = (u) => { if (u && u.is_anonymous) { supabase.auth.signOut().catch(() => {}); return true; } return false; };
    supabase.auth.getSession().then(({ data }) => {
      const u = data?.session?.user;
      // A page that STARTS on a password only sign in (reloaded mid second step): the rest of
      // the page (SyncBridge, realtime) booted with a token the database may refuse, so once
      // the gate passes we reload for a clean start on the finished sign in.
      bootedPasswordOnly.current = !!(data?.session && isRealLogin(data.session) && !sessionProvesSecondStep(data.session));
      if (!cleanAnon(u)) setAuthUser(realUser(u));
      setAuthChecked(true);
    });
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      // v5.5.343: user clicked a password-reset link → show the set-new-password
      // form (BOLogin recovery) instead of logging them straight into the BO.
      if (event === 'PASSWORD_RECOVERY') { setRecovering(true); return; }
      // v5.5.238: clear location overrides on sign-out so a second user logging
      // into the same browser never inherits the previous user's location.
      // This is the safety net — sign-out buttons also clear, but this catches
      // session expiry, signOut from DevTools, multi-tab races, etc.
      if (event === 'SIGNED_OUT') {
        localStorage.removeItem('rpos-bo-location');
        clearResolvedLocationId();
        setSecondStepOk(false);
      }
      // Second step: a sign in that went BACKWARDS must pass the gate again.
      // NOT simply "this token is a password one" (21 Sep 2026, live): supabase-js
      // raises an auth event when the tab comes back to the front and on every
      // token refresh, and a password sign in keeps a password token for its whole
      // life, so that test was true every single time. Peter: "the back office is
      // logging out every time you click off the page". It was the gate reopening.
      // shouldRegate compares the auth server's own session_id with the one that
      // already passed in this tab, so a refresh of the SAME sign in is left alone.
      if (shouldRegate({ session, passedId: passedSessionId.current })) setSecondStepOk(false);
      // Ignore anonymous sessions entirely (and don't re-sign-out on the
      // SIGNED_IN(anon) event — ensureAuthToken no longer creates them in
      // office mode, so this only guards legacy/edge cases).
      const u = session?.user;
      if (u && u.is_anonymous) { setAuthUser(null); return; }
      // 27 Sep 2026: the same person's refresh keeps the user object, so the venue effect
      // (keyed on authUser) does not re-read the venue key another tab may have changed.
      const next = realUser(u);
      setAuthUser(prev => (sameAuthUser(prev, next) ? prev : next));
    });
    return () => subscription.unsubscribe();
  }, []);

  // ── SIGNED OUT AFTER 30 MINUTES ALONE (Peter, 21 Sep 2026) ────────────────
  // "we should have it so if there is not activity for a while it logs out".
  // A Back Office left open on a counter is a way in for anybody who walks past,
  // and it used to stay open indefinitely. Mouse, key, wheel or touch counts as
  // somebody being here; a tab in the background does NOT, which is the whole
  // point. Checked once a minute rather than on a long timer, so a laptop that
  // slept through the window is signed out when it wakes, not half an hour later.
  useEffect(() => {
    if (isMock || !authUser) return;
    let last = Date.now();
    const touch = () => { last = Date.now(); };
    for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, touch, { passive: true });
    const onVisible = () => { if (!document.hidden) check(); };
    document.addEventListener('visibilitychange', onVisible);
    const check = () => {
      if (!idleTooLong(last)) return;
      clearInterval(timer);
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, touch);
      document.removeEventListener('visibilitychange', onVisible);
      try { sessionStorage.setItem('rpos-bo-idle-note', idleSignOutMessage()); } catch { /* the message is a nicety */ }
      localStorage.removeItem('rpos-bo-location');
      clearResolvedLocationId();
      supabase.auth.signOut({ scope: 'local' }).finally(() => window.location.reload());
    };
    const timer = setInterval(check, 60_000);
    return () => {
      clearInterval(timer);
      for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, touch);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [authUser]);

  // Load org/location context once user is known AND has passed the second step
  // (before that the database refuses a password only sign in once enforcement is on).
  useEffect(() => {
    if (!authUser || isMock || !secondStepOk) return;
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
        setOrgCtx({ role: null, boAccess: true, orgId: null, orgName: 'Serv OS', locationId: null, locationName: null, userId: authUser?.id || null, userName: authUser?.email || null });
        return;
      }
      profile = data;

      // Step 2: resolve effective location
      let overrideLocId = null;
      try { overrideLocId = JSON.parse(localStorage.getItem('rpos-bo-location') || 'null'); } catch (e) { console.warn('[BackOfficeApp] bad rpos-bo-location:', e?.message); }

      // Validate the stored location for EVERY user, every load.
      //
      // This check used to be skipped when the stored id happened to equal the
      // user's own profile location, and skipped entirely for super_admins —
      // so the people most likely to be carrying a stale id were the ones least
      // likely to have it caught. It also only ever cleared a bad id; it never
      // recognised a Platform id, which is a legitimate value in the wrong id
      // space and is translatable rather than junk.
      let accessibleIds = null;
      try {
        const { fetchAccessibleLocations } = await import('../lib/db.js');
        const { data: accessible } = await fetchAccessibleLocations();
        accessibleIds = new Set((accessible || []).map(l => l.id));
      } catch (e) { console.warn('[BackOfficeApp] accessible locations check failed:', e?.message); }

      if (overrideLocId && accessibleIds) {
        const res = await resolveWritableLocation(overrideLocId, accessibleIds);
        if (res.changed) {
          // Self-heal the stored value so the next load is clean and nobody has
          // to be talked through clearing localStorage.
          if (res.id) { try { localStorage.setItem('rpos-bo-location', JSON.stringify(res.id)); } catch { /* quota */ } }
          else { localStorage.removeItem('rpos-bo-location'); }
        }
        overrideLocId = res.id;
      }

      let effectiveLocId = overrideLocId || profile.location_id;

      // The profile's own location gets the same treatment — it is no more
      // trustworthy than the stored one if the two databases have drifted.
      if (effectiveLocId && accessibleIds && !accessibleIds.has(effectiveLocId)) {
        const res = await resolveWritableLocation(effectiveLocId, accessibleIds);
        effectiveLocId = res.id;
      }

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
        userId: authUser?.id || null,
        userName: profile.full_name || authUser?.email || null,
      });
      if (effectiveLocId) {
        setResolvedLocationId(effectiveLocId);
        // v5.5.761: persist the resolved location to rpos-bo-location so getActiveLocationSync()
        // sees it. Previously that key was written ONLY on a manual location switch, so a BO that
        // auto-resolved a single location left every getActiveLocationSync() consumer (all the
        // Marketing sections, Review card, WiFi, etc.) showing "Pick a location to manage …".
        try { localStorage.setItem('rpos-bo-location', JSON.stringify(effectiveLocId)); } catch { /* quota */ }
        // 27 Sep 2026 (Peter: "every products tax rate has been removed ... please chase"):
        // SyncBridge booted at page load for rpos-bo-location, else the venue this browser is
        // paired to, and applied THAT venue's push and discounts. When it is not the venue resolved
        // here, the page reloads once so the boot runs for this venue; if it still differs, the
        // other venue's tax rates, discounts and packages are cleared (lib/boVenueBoot.js). A Leeds
        // Back Office that booted Train Station's push pushed its rates and discounts to Leeds.
        let tabStorage = null;
        try { tabStorage = window.sessionStorage; } catch { tabStorage = null; }
        const bootAction = settleBoVenue({ bootedFor: useStore.getState().bootLocationId, venue: effectiveLocId, storage: tabStorage });
        if (bootAction === 'reload') {
          console.warn('[BackOfficeApp] booted for', useStore.getState().bootLocationId, 'but this Back Office is for', effectiveLocId, ': reloading once for the right venue');
          window.location.reload();
          return;
        }
        if (bootAction === 'purge') useStore.setState(foreignVenueSlices());
        loadLocationData(effectiveLocId);
      }
    })();
  }, [authUser, secondStepOk]);

  // 27 Sep 2026 (Peter: "I archived choc babychino but its still on the menu board"): the menu
  // comes from ONE fresh read of the database (lib/venueMenuRead.js readVenueMenu, the same
  // read Push to POS sends the tills), applied through store loadVenueMenu: menus, categories,
  // products, modifier groups, tax rates and profiles, each through the one mapper that keeps
  // the row's updated_at (srvAt) for compare and set. A row with a save of this tab on its way
  // keeps this tab's copy. Tax rates take the read as it is, an empty list included (Leeds had
  // none of its own and this loader kept Train Station's). While it runs the store says
  // menuLoading, and Push to POS waits for it.
  const loadLocationData = async (locationId) => {
    if (!locationId) return;
    await loadVenueMenu(locationId);

    // v5.9.4: the floor plan, through sync/TablePlanSync (lib/tablePlan.js), applied to the store
    // AS IT IS NOW (not a copy taken before the waits above). The read is the plan version:
    // definitions from it, each stamped with the database updated_at and the compare-and-set base
    // this tab's edits are checked against (FloorPlanBuilder); tombstones remove; the sessions
    // SyncBridge loaded into this store are kept (this loader used to null every session); a table
    // holding an open order stays reachable, flagged planRemoved (shown read only, never editable).
    await refreshTablePlan({ locationId, mode: 'full', reason: 'backoffice', backOffice: true });
  };

  // 27 Sep 2026: read the venue again every time this tab comes back to the front. It used to
  // happen only by accident (the auth event supabase-js raises on return), and Peter pressed
  // Push to POS half a second after coming back, before that reload landed. The push and the
  // bulk strips now wait for a load that is running (store whenMenuLoadIdle).
  const activeLocationId = orgCtx?.locationId || null;
  useEffect(() => {
    if (isMock || !activeLocationId) return;
    const onVisible = () => { if (!document.hidden) loadVenueMenu(activeLocationId); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [activeLocationId]);

  // Show spinner while checking session
  if (!authChecked) return (
    <div style={{ minHeight:'100vh', display:'flex', alignItems:'center', justifyContent:'center', background:'var(--bg)' }}>
      <div style={{ color:'var(--t3)', fontSize:13 }}>Loading…</div>
    </div>
  );

  // Sign out from the second step screens: this browser only (a person abandoning the step
  // must not sign themselves out of every other device), then back to the password screen.
  const signOutHere = () => {
    localStorage.removeItem('rpos-bo-location');
    clearResolvedLocationId();
    supabase.auth.signOut({ scope: 'local' }).finally(() => window.location.reload());
  };

  // v5.5.343: password-reset landing: set-new-password form, then back to login. A login that
  // has a second step passes it FIRST (a reset link alone must never take over an account; the
  // auth server also refuses the password change without it).
  if (recovering && !isMock && !recoveryStepOk) {
    return <SecondStepGate supabase={supabase} mode="recovery" area="Back Office" onPassed={() => setRecoveryStepOk(true)} onSignOut={signOutHere} />;
  }
  if (recovering) return <BOLogin recovery onResetDone={() => { setRecovering(false); window.location.replace(window.location.pathname + '?mode=office'); }} />;

  // Show login screen if not authenticated
  if (!authUser && !isMock) return <BOLogin onLogin={setAuthUser} />;

  // The second step: Face ID, fingerprint or an authenticator app code. Cannot be skipped.
  if (!isMock && authUser && !secondStepOk) {
    // Realtime keeps the token it joined with: supabase-js hands it a new one on SIGNED_IN and
    // TOKEN_REFRESHED only, never on MFA_CHALLENGE_VERIFIED. Without this, a fresh sign in left
    // every live channel on the password only token for up to an hour, and once enforcement is
    // on the fence refuses those rows and live alerts go quiet (fix round, 20 Sep 2026).
    const passed = async (result) => {
      try {
        const { data } = await supabase.auth.getSession();
        const token = data?.session?.access_token;
        if (token && supabase.realtime?.setAuth) await supabase.realtime.setAuth(token);
      } catch { /* the reload below, or the next refresh, puts it right */ }
      // Only a real upgrade is worth a reload; stepping aside must never reload, or a password
      // only session with the break glass off loops for ever (20 Sep 2026).
      // Remember WHICH sign in passed, so a token refresh or a tab coming back to
      // the front is not mistaken for a sign in that went backwards.
      try {
        const { data } = await supabase.auth.getSession();
        passedSessionId.current = sessionIdOf(data?.session);
      } catch { /* the gate still passes; the worst case is being asked again */ }
      if (result?.upgraded && bootedPasswordOnly.current) window.location.reload();
      else setSecondStepOk(true);
    };
    return <SecondStepGate supabase={supabase} mode="login" area="Back Office" onPassed={passed} onSignOut={signOutHere} />;
  }

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
      display:'flex', height:'100vh', background:'transparent', color:'var(--t1)',
      fontFamily:'inherit', overflow:'hidden',
    }}>
      <SaveHealthBanner />
      <BackOfficeToast />
      {/* 5 Oct 2026 (Peter: "a POP UP from the admin"): a message from ServOS for the venue this
          person is signed in to, until someone taps Got it (components/VenueMessagePopup.jsx). */}
      {authUser && !isMock && orgCtx?.locationId && (
        <VenueMessagePopup host="backoffice" locationId={orgCtx.locationId} user={authUser} userName={orgCtx?.userName || null} />
      )}
      {/* ── Sidebar (glass) ─────────────────────────────── */}
      <div style={{
        width:236, background:'var(--glass-bg)',
        backdropFilter:'blur(22px) saturate(150%)', WebkitBackdropFilter:'blur(22px) saturate(150%)',
        borderRight:'1px solid var(--glass-border)',
        display:'flex', flexDirection:'column', flexShrink:0,
      }}>
        {/* Brand */}
        <div style={{ padding:'16px 16px 14px', borderBottom:'1px solid var(--bdr)' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            {/* v5.5.328: real Serv OS logo mark (was a generic org-initial box) */}
            <ServOSIcon size={34} style={{ flexShrink:0 }} />
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

        {/* Nav — ServOS 10-section collapsible IA */}
        {/* minHeight:0 lets this flex child shrink and scroll; without it the list grew to its
            content and the footer covered the last entries (Print menu). */}
        <div style={{ flex:1, minHeight:0, overflowY:'auto', padding:'10px 8px', display:'flex', flexDirection:'column', gap:2 }}>
          {NAV_IA.map(sec => {
            if (sec.single) {
              const active = section === sec.single;
              return (
                <button key={sec.label} onClick={() => setSection(sec.single)} style={{
                  display:'flex', alignItems:'center', gap:11, padding:'10px 11px', borderRadius:11,
                  cursor:'pointer', fontFamily:'inherit', textAlign:'left', width:'100%',
                  border:`1px solid ${active?'var(--acc-b)':'transparent'}`,
                  background: active ? 'var(--acc-d)' : 'transparent',
                  boxShadow: active ? 'var(--glass-hi)' : 'none',
                  color: active ? 'var(--acc)' : 'var(--t1)', transition:'all .12s',
                }}>
                  <Icon name={sec.icon} size={19} style={{ color: active?'var(--acc)':'var(--t3)' }} />
                  <span style={{ flex:1, fontSize:13.5, fontWeight: active?600:500 }}>{sec.label}</span>
                </button>
              );
            }
            const open = openNav === sec.label;
            const hasActive = sec.children.some(c => c[0] === section);
            return (
              <div key={sec.label}>
                <button onClick={() => setOpenNav(open ? null : sec.label)} style={{
                  display:'flex', alignItems:'center', gap:11, padding:'10px 11px', borderRadius:11,
                  cursor:'pointer', fontFamily:'inherit', textAlign:'left', width:'100%',
                  border:`1px solid ${hasActive?'var(--acc-b)':'transparent'}`,
                  background: hasActive ? 'var(--acc-d)' : 'transparent',
                  boxShadow: hasActive ? 'var(--glass-hi)' : 'none',
                  color: hasActive ? 'var(--acc)' : 'var(--t1)', transition:'all .12s',
                }}>
                  <Icon name={sec.icon} size={19} style={{ color: hasActive?'var(--acc)':'var(--t3)' }} />
                  <span style={{ flex:1, fontSize:13.5, fontWeight: hasActive?600:500 }}>{sec.label}</span>
                  <Icon name="chevron" size={13} style={{ color:'var(--t4)', transform: open?'rotate(90deg)':'none', transition:'transform .2s' }} />
                </button>
                {/* v5.9.69: the cap comes from the row count. A fixed 460px (June reskin) clipped the tail of any
                    group past 13 rows: Channels reached 14 and "Print menu" vanished under Hardware (Peter, 26 Sep). */}
                <div style={{ maxHeight: open ? navGroupMaxHeight(sec.children.length) : 0, overflow:'hidden', transition:'max-height .26s ease' }}>
                  <div style={{ marginLeft:21, borderLeft:'1px solid var(--hair, var(--bdr))', display:'flex', flexDirection:'column', gap:1, padding:'3px 0 6px 13px' }}>
                    {sec.children.map(([id, label]) => {
                      const active = section === id;
                      return (
                        <button key={id} onClick={() => setSection(id)} style={{
                          display:'flex', alignItems:'center', gap:9, padding:'8px 11px', borderRadius:9,
                          cursor:'pointer', fontFamily:'inherit', textAlign:'left', width:'100%', border:'none',
                          background: active ? 'var(--acc-d)' : 'transparent',
                          color: active ? 'var(--acc)' : 'var(--t3)', fontSize:12.8, fontWeight: active?600:400,
                          transition:'all .1s',
                        }}>
                          <span style={{ width:5, height:5, borderRadius:'50%', background:'currentColor', opacity: active?1:0.4, flexShrink:0 }} />
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
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
          {/* v5.5.328: light / dark theme toggle (reuses the store theme + [data-theme] CSS) */}
          <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} style={{
            width:'100%', padding:'9px 10px', borderRadius:9,
            cursor:'pointer', textAlign:'left', fontSize:12,
            fontWeight:600, border:'1px solid var(--bdr)',
            fontFamily:'inherit', background:'transparent',
            color:'var(--t3)', display:'flex', alignItems:'center', gap:8,
            transition:'all .1s', marginBottom:6,
          }}>
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
            {theme === 'dark' ? 'Light mode' : 'Dark mode'}
          </button>
          <button onClick={() => { localStorage.removeItem('rpos-device'); localStorage.removeItem('rpos-device-config'); localStorage.setItem('rpos-device-mode','pos'); window.location.href = '?mode=pos'; }} style={{
            width:'100%', padding:'9px 10px', borderRadius:9,
            cursor:'pointer', textAlign:'left', fontSize:12,
            fontWeight:600, border:'1px solid var(--bdr)',
            fontFamily:'inherit', background:'var(--bg3)',
            color:'var(--t2)', display:'flex', alignItems:'center', gap:8,
            transition:'all .1s', marginBottom:6,
          }}>
            <Icon name="back" size={15} /> Back to POS
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
              <Icon name="pin" size={14} />
              <span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                {orgCtx?.locationName || 'Switch location'}
              </span>
              <span style={{ fontSize:10, color:'var(--t4)' }}>▾</span>
            </button>
          )}
          {/* Support chat — sits under the venue so it reads as "here, at this
              site", and above Sign out, which stays the last thing in the list. */}
          <button onClick={() => setShowSupport(true)} title="Chat with the ServOS team" style={{
            width:'100%', padding:'9px 10px', borderRadius:9,
            cursor:'pointer', textAlign:'left', fontSize:12,
            fontWeight:600, border:'1px solid var(--bdr)',
            fontFamily:'inherit', background:'transparent',
            color:'var(--t3)', display:'flex', alignItems:'center', gap:8,
            marginBottom:6, transition:'all .1s',
          }}>
            <Icon name="support" size={14} />
            <span style={{ flex:1 }}>Support</span>
          </button>
          {authUser && !isMock && (
            <button onClick={() => { localStorage.removeItem('rpos-bo-location'); clearResolvedLocationId(); supabase.auth.signOut().then(() => window.location.reload()); }} style={{
              width:'100%', padding:'8px 10px', borderRadius:9,
              cursor:'pointer', textAlign:'left', fontSize:12,
              fontWeight:600, border:'1px solid var(--bdr)',
              fontFamily:'inherit', background:'transparent',
              color:'var(--t4)', display:'flex', alignItems:'center', gap:8,
            }}>
              <Icon name="signout" size={14} /> Sign out
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
          height:56, borderBottom:'1px solid var(--glass-border)',
          background:'var(--glass-bg)', backdropFilter:'blur(22px) saturate(150%)', WebkitBackdropFilter:'blur(22px) saturate(150%)',
          display:'flex', alignItems:'center', justifyContent:'space-between',
          padding:'0 24px', flexShrink:0,
        }}>
          <div style={{ fontSize:16, fontWeight:600, color:'var(--t1)', letterSpacing:'-.015em' }}>
            {NAV.find(n => n.id === section)?.label || (section?.startsWith('wf-') ? 'Workforce' : '')}
          </div>
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            {/* Quick nav: POS / Office segmented (Office active) */}
            <div style={{ display:'inline-flex', gap:2, padding:3, borderRadius:11, background:'var(--inset)', border:'1px solid var(--inset-border)' }}>
              <a href="?mode=pos" onClick={() => { localStorage.removeItem('rpos-device'); localStorage.removeItem('rpos-device-config'); }} style={{ padding:'6px 12px', borderRadius:8, color:'var(--t3)', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'inherit', textDecoration:'none', display:'inline-flex', alignItems:'center', gap:6 }}><Icon name="pos" size={14}/>POS</a>
              <a href="?mode=office" style={{ padding:'6px 12px', borderRadius:8, background:'var(--glass-bg)', boxShadow:'var(--glass-hi)', color:'var(--t1)', fontSize:12, fontWeight:600, cursor:'pointer', fontFamily:'inherit', textDecoration:'none', display:'inline-flex', alignItems:'center', gap:6 }}><Icon name="office" size={14}/>Office</a>
            </div>
            {/* Push to POS button */}
            {/* 27 Sep 2026: a display name, never the email (config_pushes is readable with the
                public key: lib/pushedBy.js). The raw names go down, so the button can fall back
                to the staff name before "Manager". */}
            <PushToPOSButton nameCandidates={[authUser?.user_metadata?.full_name, authUser?.user_metadata?.name, orgCtx?.userName]} />
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
        <WeakPasswordBanner onFix={() => setSection('security')} />
        <OtherTabBanner key={orgCtx?.locationId || 'none'} venue={orgCtx?.locationId || null} />
        <div className="bo-page-shell">
          {section === 'overview'   && <BOOverview setSection={setSection} orgCtx={orgCtx} />}
          {section === 'security'   && <SignInSecurity orgCtx={orgCtx} />}
          {section === 'servos-messages' && <ServosMessages locationId={orgCtx?.locationId || null} />}
          {section === 'reviews'    && <ReviewManager />}
          {section === 'wifi'       && <WifiManager />}
          {section === 'promotions' && <Promotions />}
          {section === 'segments' && <Segments />}
          {section === 'campaigns' && <Campaigns />}
          {section === 'quicksend' && <QuickSend />}
          {section === 'workflows' && <Workflows />}
          {section === 'marketing-reports' && <MarketingReports />}
          {section === 'compliance' && <Compliance />}
          {section === 'sending-domain' && <SendingDomain />}
          {section === 'xero' && <XeroIntegration />}
          {section?.startsWith('wf-') && <Workforce section={section} orgCtx={orgCtx} />}
          {section === 'menu'       && <MenuManager />}
          {section === 'floorplan'  && <FloorPlanBuilder />}
          {section === 'inventory'  && <Inventory />}
          {section === 'stock-overview' && <StockOverview setSection={setSection} />}
          {section === 'stock-reports' && <StockReports />}
          {section === 'stock-counts' && <StockCounts />}
          {section === 'wastage'    && <Wastage />}
          {section === 'stock-items' && <StockItems />}
          {section === 'recipes'    && <Recipes />}
          {section === 'batches'    && <Batches />}
          {section === 'ops-overview'    && <OpsOverview setSection={setSection} />}
          {section === 'ops-temperature' && <OpsTemperature />}
          {section === 'ops-checklists'  && <OpsChecklists />}
          {section === 'ops-prep'        && <OpsPrepSchedule />}
          {section === 'ops-maintenance' && <OpsMaintenance />}
          {section === 'ops-notifications' && <OpsNotifications />}
          {section === 'ops-compliance'  && <OpsCompliance />}
          {section === 'ops-devices'     && <OpsDevices />}
          {section === 'ops-documents'   && <OpsDocuments />}
          {section === 'ops-forms'       && <OpsForms />}
          {section === 'waitlist'          && <WaitlistConfig setSection={setSection} />}
          {section === 'waitlist-insights' && <WaitlistInsights />}
          {section === 'order-pad'  && <OrderPad />}
          {section === 'suppliers'  && <Suppliers />}
          {section === 'purchase-orders' && <PurchaseOrders />}
          {section === 'price-changes' && <PriceChanges />}
          {section === 'invoices'   && <Invoices />}
          {section === 'profiles'   && <DeviceProfiles />}
          {section === 'devices'    && <DeviceRegistry />}
          {section === 'kiosks'     && <KioskRegistry />}
          {section === 'online'     && <OnlineOrdering setSection={setSection} />}
          {section === 'catering'   && <CateringSettings />}
          {section === 'menu-appearance' && <MenuAppearance />}
          {section === 'catering-orders' && <CateringOrders />}
          {section === 'hubrise'    && <HubRise />}
          {section === 'uber-direct' && <UberDirect />}
          {section === 'deliveries-live' && <DeliveriesBoard />}
          {section === 'menuboards' && <MenuBoards />}
          {section === 'order-screens' && <OrderScreens />}
          {section === 'table-bookings' && <TableBookings />}
          {section === 'packages'   && <PackageBuilder />}
          {section === 'print-menu' && <PrintMenu />}
          {section === 'printers'   && <PrinterRegistry />}
          {section === 'cardreaders'&& <CardReaders />}
          {section === 'cashdrawers' && <CashDrawers />}
          {section === 'staff'      && <StaffManager />}
          {section === 'printing'   && <PrintRouting />}
          {section === 'reports'    && <BOReports setSection={setSection} />}
          {section === 'card-payments' && <CardPayments />}
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
      {/* left:236 clears the Back Office sidebar. The context differs from the
          till: a back office user has a login, not a PIN, and no terminal. */}
      <SupportChat
        open={showSupport}
        onClose={() => setShowSupport(false)}
        left={236}
        context={{
          Venue: orgCtx?.locationName || 'No venue selected',
          // The id is what the CRM can map; the name alone is ambiguous across brands.
          ...(orgCtx?.locationId ? { VenueId: orgCtx.locationId } : {}),
          'Signed in': authUser?.email || 'Not signed in',
          Area: 'Back Office',
        }}
      />
    </div>
  );
}

// ── Push to POS button ────────────────────────────────────────────────────────
// 27 Sep 2026 (review round 3): the send (insertConfigPush) has a time limit too. A big menu is
// a big row, so it gets longer than a read. Out of time is not "not sent": the row may land.
const PUSH_SEND_MS = MENU_WAIT_MS * 2;
const PUSH_MAY_LAND = 'The push may still land: the database did not answer in time. Check the tills before pushing again.';

// 27 Sep 2026. Peter: "I archived choc babychino but its still on the menu board". Push to POS
// used to (1) build the tills' snapshot from this tab's MEMORY, taken when the button last
// rendered, and (2) write every product, category and menu in that memory back over the
// database. A Back Office loaded at 13:52 pushed at 13:59 and un-archived the Choc Babyccino
// another window had archived at 13:56, and put back its old tax rates; a push half a second
// after returning to a tab sent a menu from before the reload. Now a push:
//   1. waits for a venue load that is running and for this tab's own saves to land,
//   2. reads the menu FRESH from the database (lib/venueMenuRead.js, one read, one mapper),
//      and stops, sending nothing, if that read fails,
//   3. lists anything on this screen the database does not have and saves it INSERT ONLY
//      when the person says so (never silently),
//   4. sends the tills exactly what the database holds, and shows the same on this screen.
// It writes no existing menu row, ever. The tables have worked this way since v5.9.4.
function PushToPOSButton({ nameCandidates = [] }) {
  const { pendingBOChanges, clearBOChanges, tables, locationSections, staff, menuLoading } = useStore();
  const [pushing, setPushing] = useState(false);
  const [justPushed, setJustPushed] = useState(false);
  // A display name only, never an email: config_pushes is readable with the public key.
  // 27 Sep 2026 (review round 3): the signed in person's names first, then the staff name, then
  // "Manager" (lib/pushedBy.js skips anything with an @). The parent used to settle the name
  // itself, so it was already "Manager" here and the staff name was never reached.
  const who = pushedByName(...(Array.isArray(nameCandidates) ? nameCandidates : [nameCandidates]), staff?.name);

  // The button is given back in handlePush's finally, however the push ends.
  const stop = (msg) => {
    useStore.getState().showToast?.(msg, 'error', 9000);
  };

  const handlePush = async () => {
    setPushing(true);
    // 27 Sep 2026 (review round 3): the button is ALWAYS given back, however the push ends. A
    // throw anywhere below used to leave it disabled on "Pushing..." until the page reloaded.
    try {
      // Resolve location once, stamp it on the snapshot. v5.5.2: lets the POS hydrator
      // detect cross-location config-push leakage and lets every table in the snapshot
      // carry its source location_id (used by the cross-location upsert guard).
      let snapshotLocationId = null;
      try { snapshotLocationId = await getLocationId(); }
      catch (e) { console.warn('[handlePush] snapshot locationId resolve failed:', e?.message); }

      // 1 + 2. The menu: a reload in flight lands first, this tab's saves land first, then ONE
      // fresh read. Nothing from this component's render (the old closure) is used.
      let menuRead = null;
      let menuTicket = null;
      if (!isMock) {
        if (!snapshotLocationId || snapshotLocationId === 'loc-demo') { stop('Push stopped: could not tell which venue this is. Nothing was sent. Try again.'); return; }
        // Every wait and read has a time limit (MENU_WAIT_MS). A read that hangs (a stale socket
        // just after Safari resumes the tab, the very moment this runs) used to leave Push to POS
        // disabled with a wait cursor and no word.
        const waitFor = (p, label, ms = MENU_WAIT_MS) => withTimeout(p, ms, label);
        const readMenu = () => waitFor(readVenueMenu(supabase, snapshotLocationId), 'menu read')
          .catch((e) => ({ ok: false, failed: ['timed out'], error: e }));
        try {
          // A little longer than the load's own limit, so a load that gives up ends first.
          await waitFor(whenMenuLoadIdle(), 'menu load', MENU_WAIT_MS + 5000);
          await waitFor(whenMenuWritesIdle(), 'menu saves');
        } catch (e) {
          console.warn('[handlePush] waited too long:', e?.message || e);
          stop('Push stopped: the menu is still loading or saving. Nothing was sent. Try again.');
          return;
        }
        // 27 Sep 2026 (review round 3): an EMPTY product read while this screen holds this venue's
        // products is suspect (a narrowed read answers with no rows and no error). The tills are
        // never sent an empty menu on it (lib/venueMenuRead.js emptyItemsReadSuspect).
        const emptyReadStop = () => {
          const st = useStore.getState();
          if (!emptyItemsReadSuspect(st, menuRead, snapshotLocationId)) return false;
          console.warn('[handlePush] the product read came back EMPTY while this screen holds this venue\'s products');
          stop(`Push stopped: the database sent back NO products for this venue, but this screen has ${venueItemCount(st, snapshotLocationId)}. Nothing was sent. Check you are signed in, then reload the page.`);
          return true;
        };
        menuTicket = beginMenuRead();
        menuRead = await readMenu();
        if (!menuRead.ok) {
          console.warn('[handlePush] menu read failed:', (menuRead.failed || []).join(', '), menuRead.error?.message || '');
          stop('Push stopped: could not read the menu. Nothing was sent. Try again.');
          return;
        }
        if (emptyReadStop()) return;
        // 3. Rows on this screen the database does not have: say so, and save them only on OK.
        // Only this venue's, and (27 Sep 2026) only rows whose own first save FAILED in this
        // window, of every kind: a category or menu deleted in another window stays deleted.
        const unsaved = unsavedMenuRows(useStore.getState(), menuRead, snapshotLocationId, { failed: failedCreateIds() });
        if (unsaved.total) {
          if (!window.confirm(unsavedWords(unsaved))) { stop('Push stopped. Nothing was sent.'); return; }
          let saved;
          try { saved = await waitFor(saveUnsavedMenuRows(unsaved), 'saving new rows'); }
          catch (e) { saved = { ok: false, failed: [{ kind: 'save', name: 'new rows', error: e?.message || 'took too long' }] }; }
          if (!saved.ok) {
            const first = saved.failed.slice(0, 3).map(f => `${f.name || f.kind} (${f.error})`).join('; ');
            const moved = saved.toTopLevel?.length ? ` ${toTopLevelWords(saved.toTopLevel)}` : '';
            stop(`Push stopped: ${saved.failed.length} of them could not be saved: ${first}. Nothing was sent.${moved}`);
            return;
          }
          // 27 Sep 2026: a sub category whose parent category was deleted in another window is
          // saved at the TOP level (lib/menuWriters.js categoryParentRetry), never lost and never
          // stopping every push; the person is told which, and where it went.
          if (saved.toTopLevel?.length) useStore.getState().showToast?.(toTopLevelWords(saved.toTopLevel), 'warning', 12000);
          try { await waitFor(whenMenuWritesIdle(), 'menu saves'); }
          catch { stop('Push stopped: the menu is still saving. Nothing was sent. Try again.'); return; }
          menuTicket = beginMenuRead();
          menuRead = await readMenu();
          if (!menuRead.ok) { stop('Push stopped: could not read the menu. Nothing was sent. Try again.'); return; }
          if (emptyReadStop()) return;
        }
      }

      // Build config snapshot — layout + menu config (not operational/session state)
      // Include print routing config in snapshot
      // Load routing from Supabase (source of truth), fall back to localStorage
      let printRouting = { centres:[], routing:{} };
      let printers = [];
      // v5.5.799: takeaway customer-details level rides the snapshot so tills refresh
      // on push (fallback: whatever this session already has, default 'full').
      let takeawayCustomerDetails = useStore.getState().takeawayCustomerDetails || 'full';
      // v5.5.962: quick-screen mode is read from the DB at push time, NOT from the
      // BO store — an unhydrated store defaults to 'manual' and a push would flip
      // every till in an auto/hybrid venue back to manual. null = omit from the
      // snapshot entirely (absent fields are a no-op on tills).
      let quickScreenModePush = null;
      // 27 Sep 2026: the Quick Screen list from the same read (this tab's copy only if it fails).
      let quickScreenIdsPush = useStore.getState().quickScreenIds || [];
      try {
        const locId = snapshotLocationId;
        if (locId && supabase) {
          const [rtRes, prnRes, locRes] = await Promise.all([
            supabase.from('print_routing').select('centres,routing').eq('location_id', locId).single(),
            supabase.from('printers').select('*').eq('location_id', locId),
            supabase.from('locations').select('pos_settings, quick_screen_mode, quick_screen_ids').eq('id', locId).maybeSingle(),
          ]);
          if (rtRes.data) printRouting = { centres: rtRes.data.centres||[], routing: rtRes.data.routing||{} };
          if (prnRes.data) printers = prnRes.data.map(r => ({ id:r.id, name:r.name, model:r.meta?.model, connectionType:r.connection, address:r.ip, port:r.port||9100, paperWidth:r.paper_width||80, roles:r.meta?.roles||[], location:r.meta?.location||'' }));
          if (locRes.data) {
            takeawayCustomerDetails = locRes.data.pos_settings?.takeaway_customer_details || 'full';
            quickScreenModePush = ['manual','auto','hybrid'].includes(locRes.data.quick_screen_mode) ? locRes.data.quick_screen_mode : null;
            if (Array.isArray(locRes.data.quick_screen_ids)) quickScreenIdsPush = locRes.data.quick_screen_ids;
          }
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

      // v5.9.4 table plan (lib/tablePlan.js). The tables in a push come from a FRESH read of the
      // plan, never from this tab's store: a Back Office tab left open for hours (or one that missed
      // another Back Office's delete) used to push its old names and deleted tables to every till.
      // Each table carries the database updated_at it was read with (srvAt), and the snapshot says
      // so (tablePlan.v 2, fromRead), so a till keeps whichever copy the database stamped later.
      // The deletes ride along as tombstones: the database's (server deleted_at) plus any this
      // machine holds locally (a delete made before the tombstone table existed). Their local seq
      // is stripped: it is this machine's counter and means nothing on a till.
      // If the fresh read fails, this tab's tables go out UNSTAMPED (fromRead false): a till then
      // treats them like an old push and adds or renames nothing its own plan read has decided.
      let pushTombstones = {};
      let pushTables = null;
      let pushPlan = { v: 2, fromRead: false, srvReadAt: 0 };
      // Sections (lib/sectionPlan.js): the venue's SAVED list from the same fresh read when it has
      // one, else this tab's list (a venue with nothing saved yet pushes what it always pushed).
      let pushSections = locationSections;
      if (snapshotLocationId) {
        try {
          const readSeq = nextSeq();
          const [fp, tRes] = await Promise.all([
            fetchFloorPlanVersioned(snapshotLocationId).catch(e => ({ data: null, error: e })),
            fetchTableTombstones(snapshotLocationId).catch(e => ({ data: null, error: e })),
          ]);
          const state = loadPlanState(snapshotLocationId);
          const tombs = mergeTombs(state.tombs, tombstonesFromRows(tRes?.data, readSeq), { cleared: state.cleared });
          // A LOCAL mark for a table the fresh read still has is out of date (the row was re-created,
          // or the delete never went through): never send it. Server marks go as they are; a till
          // compares them with each copy's updated_at.
          const inRead = new Set((Array.isArray(fp?.data?.tables) ? fp.data.tables : []).map(r => r.id));
          for (const [id, t] of Object.entries(tombs)) if (!t.srv && inRead.has(id)) delete tombs[id];
          const savedSecs = normaliseSections(fp?.data?.sections);
          if (savedSecs && savedSecs.length) pushSections = savedSecs;
          pushTombstones = Object.fromEntries(Object.entries(tombs).map(([id, t]) => [id, { at: t.at, srv: !!t.srv, ...(t.label ? { label: t.label } : {}) }]));
          if (Array.isArray(fp?.data?.tables) && fp.data.tables.length) {
            pushTables = fp.data.tables.map(r => {
              const t = normaliseFloorRow(r, { locationId: snapshotLocationId });
              return {
                id: t.id, label: t.label, x: t.x, y: t.y, w: t.w, h: t.h,
                shape: t.shape, maxCovers: t.maxCovers, section: t.section, sortOrder: t.sortOrder,
                locationId: t.locationId || snapshotLocationId,
                srvAt: t.srvAt || 0, srvIso: t.srvIso || null,
              };
            });
            pushPlan = { v: 2, fromRead: true, srvReadAt: fp.data.srvReadAt || 0 };
          }
        } catch (e) { console.warn('[handlePush] table plan read failed, pushing unstamped tables:', e?.message || e); }
      }
      if (!pushTables) {
        pushTables = tables.filter(t => !t.planRemoved && !t.parentId && !t._isNew).map(t => ({
          id:t.id, label:t.label, x:t.x, y:t.y, w:t.w, h:t.h,
          shape:t.shape, maxCovers:t.maxCovers, section:t.section, sortOrder:t.sortOrder,
          locationId: t.locationId || snapshotLocationId,
        }));
      }

      // The menu part: the fresh read, never this tab's memory (27 Sep 2026). Demo mode (no
      // database) sends what the demo screen shows, as it always did. Only the product fields
      // that have NO database column (variantLabel, the pizza fields: ITEM_EXTRA_KEYS) come from
      // this window's rows with the same id, as they always rode the push.
      const menuPart = menuRead ? menuSnapshotFromRead(menuRead, { extrasFrom: useStore.getState().menuItems }) : (() => {
        const st = useStore.getState();
        return {
          menus: st.menus || [], menuItems: st.menuItems || [], menuCategories: st.menuCategories || [],
          modifierGroupDefs: st.modifierGroupDefs || [], taxRates: st.taxRates || [],
          taxProfiles: st.taxProfiles || [], venueDefaultTaxProfileId: st.venueDefaultTaxProfileId ?? null,
        };
      })();

      // Instruction groups have no table: they live only in pushes. 27 Sep 2026: a window left open
      // used to push its own list and undo groups another window had added and pushed since. The
      // latest push's list is read and THIS window's changes are laid onto it, group by group
      // (lib/threeWayMerge.js mergeInstructionGroups; the base is the list this window last
      // received or pushed). If that read fails, this window's list goes as it always did.
      const myInstructionGroups = useStore.getState().instructionGroupDefs;
      let instructionGroupDefs = myInstructionGroups || [];
      if (!isMock && supabase && snapshotLocationId) {
        try {
          const { data: lastPush, error: lastErr } = await withTimeout(
            supabase.from('config_pushes').select('snapshot->instructionGroupDefs')
              .eq('location_id', snapshotLocationId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
            MENU_WAIT_MS, 'last push read');
          if (!lastErr) instructionGroupDefs = mergeInstructionGroups(instructionGroupsBase(), instructionGroupDefs, lastPush?.instructionGroupDefs);
          else console.warn('[handlePush] last push unreadable, instruction groups go as this window has them:', lastErr.message);
        } catch (e) { console.warn('[handlePush] last push unreadable, instruction groups go as this window has them:', e?.message || e); }
      }

      const snapshot = {
        version: Date.now(),
        pushedAt: new Date().toISOString(),
        pushedBy: who,
        locationId: snapshotLocationId,
        printRouting: printRouting || { centres:[], routing:{} },
        printers,
        // v5.9.4: see the table plan note above (fresh read, database times, tombstones).
        tables: pushTables,
        tablePlan: pushPlan,
        tableTombstones: pushTombstones,
        locationSections: pushSections,
        // menus, menuItems, menuCategories, modifierGroupDefs, taxRates, and (when they read)
        // taxProfiles + venueDefaultTaxProfileId: lib/venueMenuRead.js menuSnapshotFromRead.
        // v5.7.33: tax profiles + the venue default ride the push so tills get them on Push to
        // POS; absent is a no-op till-side (applyConfigUpdate guards on key presence).
        ...menuPart,
        // 27 Sep 2026: this venue's own presets and rules only (lib/venueTaxRates.js taggedVenueRows).
        // Every Leeds push from 26 Sep 06:47 carried Train Station's presets and Provo's rules.
        // Demo mode has one pretend venue and untagged rows, so it sends what it shows.
        discountPresets: isMock ? (useStore.getState().discountPresets || []) : taggedVenueRows(useStore.getState().discountPresets || [], snapshotLocationId),
        discountRules: isMock ? (useStore.getState().discountRules || []) : taggedVenueRows(useStore.getState().discountRules || [], snapshotLocationId),
        quickScreenIds: quickScreenIdsPush,
        // v5.5.962 Smart Quick Screen — mode (from the DB read above, omitted when
        // unknown) + best-seller lists ride the push. quickScreenAuto null is
        // filtered till-side by the hasEntries guard.
        ...(quickScreenModePush ? { quickScreenMode: quickScreenModePush } : {}),
        quickScreenAuto: useStore.getState().quickScreenAuto || null,
        takeawayCustomerDetails,
        changeCount: pendingBOChanges,
        profiles: deviceProfiles,
        instructionGroupDefs,
        // v5.6.25 Table Bookings — packages + rules ride the push so they survive
        // a POS reload (INTEGRATION.md invariant 7). Absent/empty = no-op till-side.
        // 27 Sep 2026: this venue's packages only (lib/boVenueBoot.js venueRowsOnly); Leeds pushed Provo's.
        packages: venueRowsOnly(useStore.getState().packages || [], snapshotLocationId),
        ...(useStore.getState().bookingRules ? { bookingRules: useStore.getState().bookingRules } : {}),
      };

      // Write to Supabase so physical devices on other machines receive it. Awaited: a push the
      // tills were never told about must not say "Pushed". pushed_by is the signed in person's
      // display name (never the email: this table is readable with the public key).
      if (!isMock) {
        // 27 Sep 2026 (review round 3): the send has a time limit (PUSH_SEND_MS). withTimeout is
        // called as the imported function, never as a method pulled off an object (v5.8.59:
        // lib/withTimeout.js). Out of time is NOT "not sent": the row may still land, so the
        // person is told to check the tills before pushing again.
        let res;
        try {
          res = await withTimeout(insertConfigPush({ pushed_by: who, snapshot, change_count: pendingBOChanges }, snapshotLocationId), PUSH_SEND_MS, 'sending the push');
        } catch (e) {
          console.warn('[handlePush] the send did not answer:', e?.message || e);
          useStore.getState().showToast?.(PUSH_MAY_LAND, 'warning', 12000);
          return;
        }
        if (res?.error) {
          stop(`Push failed: the tills were not told (${res.error.message || 'the database refused it'}). Try again.`);
          return;
        }
      }

      // Persist snapshot so POS tabs that open later can still receive it
      try {
        localStorage.setItem('rpos-config-snapshot', JSON.stringify(snapshot));
      } catch {}

      // Broadcast to all open POS terminals in this browser session
      broadcastConfigPush(snapshot);

      // 4. This screen shows what the tills just received (the same read).
      if (menuRead) applyVenueMenuRead(menuRead, { ...menuTicket, locationId: snapshotLocationId });
      // (Unless the list was edited while this push ran: that edit stays on screen for the next.)
      if (useStore.getState().instructionGroupDefs === myInstructionGroups) useStore.setState({ instructionGroupDefs });
      setInstructionGroupsBase(instructionGroupDefs);

      clearBOChanges();
      setJustPushed(true);
      setTimeout(() => setJustPushed(false), 3000);
    } catch (e) {
      console.warn('[handlePush] failed:', e?.message || e);
      stop(`Push did not finish (${e?.message || 'unexpected error'}). Check the tills before pushing again.`);
    } finally {
      setPushing(false);
    }
  };

  if (justPushed) {
    return (
      <div style={{ display:'flex', alignItems:'center', gap:7, padding:'6px 14px', borderRadius:10, background:'var(--grn-d)', border:'1px solid var(--grn-b)' }}>
        <div style={{ width:7, height:7, borderRadius:'50%', background:'var(--grn)' }}/>
        <span style={{ fontSize:12, fontWeight:700, color:'var(--grn)' }}>Pushed to all terminals</span>
      </div>
    );
  }

  // Not while a push runs, and not while the venue is being read again (coming back to the tab):
  // the push would otherwise wait on a menu the person cannot see yet.
  const busy = pushing || menuLoading;
  return (
    <button
      onClick={handlePush}
      disabled={busy}
      title={menuLoading && !pushing ? 'Loading the latest menu…' : undefined}
      style={{
        display:'flex', alignItems:'center', gap:8,
        padding:'7px 16px', borderRadius:10, cursor: busy ? 'wait' : 'pointer',
        fontFamily:'inherit', fontSize:13, fontWeight:700, border:'none',
        background: pendingBOChanges > 0 ? 'var(--acc)' : 'var(--bg3)',
        color: pendingBOChanges > 0 ? '#0b0c10' : 'var(--t3)',
        transition:'all .15s',
        boxShadow: pendingBOChanges > 0 ? '0 0 12px var(--acc-b)' : 'none',
        opacity: busy ? 0.7 : 1,
      }}
    >
      {pendingBOChanges > 0 && (
        <span style={{
          fontSize:10, fontWeight:800, padding:'1px 6px', borderRadius:20,
          background:'rgba(0,0,0,.2)', color:'inherit',
        }}>{pendingBOChanges}</span>
      )}
      <span>{pushing ? 'Pushing…' : 'Push to POS'}</span>
      <span style={{ fontSize:15 }}>→</span>
    </button>
  );
}
// ── Overview snapshot helpers (v5.5.340) ────────────────────────────────────
const SOURCE_META = [
  { key:'pos',      label:'POS / Counter',   color:'#3b82f6' },
  { key:'mpos',     label:'Mobile POS',      color:'#22d3ee' },
  { key:'kiosk',    label:'Kiosk',           color:'#a855f7' },
  { key:'online',   label:'Online ordering', color:'#22c55e' },
  { key:'qr',       label:'QR table',        color:'#e8a020' },
  { key:'catering', label:'Catering',        color:'#14b8a6' },
  { key:'delivery', label:'Delivery apps',   color:'#ef4444' },
];
const ORDER_TYPE_LABEL = { 'dine-in':'Dine-in', takeaway:'Takeaway', collection:'Collection', delivery:'Delivery', 'bar-tab':'Bar tab', counter:'Counter', 'drive-thru':'Drive thru' };
function payBucket(method) {
  const m = (method || '').toLowerCase();
  if (m.includes('split'))   return 'Split';
  if (m.includes('gift'))    return 'Gift card';
  if (m.includes('cash'))    return 'Cash';
  if (m.includes('loyalty')) return 'Loyalty';
  if (m.includes('card'))    return 'Card';
  return method ? method[0].toUpperCase() + method.slice(1) : 'Other';
}

// Compact horizontal-bar list card for the overview snapshots.
function SnapCard({ title, rows, onClick, empty }) {
  const max = Math.max(1, ...rows.map(r => r.value || 0));
  return (
    <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:14, padding:'16px 18px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline', marginBottom:14 }}>
        <div style={{ fontSize:11, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em' }}>{title}</div>
        {onClick && <button onClick={onClick} style={{ fontSize:11, color:'var(--acc)', background:'none', border:'none', cursor:'pointer', fontFamily:'inherit', fontWeight:700 }}>Reports →</button>}
      </div>
      {rows.length === 0 ? (
        <div style={{ fontSize:12, color:'var(--t4)', padding:'6px 0' }}>{empty || 'Nothing yet today'}</div>
      ) : rows.map((r, i) => (
        <div key={r.label + i} style={{ marginBottom: i === rows.length - 1 ? 0 : 10, opacity: r.soon ? 0.45 : 1 }}>
          <div style={{ display:'flex', justifyContent:'space-between', fontSize:12, marginBottom:4, gap:8 }}>
            <span style={{ color:'var(--t2)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{r.label}</span>
            <span style={{ color:'var(--t1)', fontWeight:700, fontFamily:'var(--font-mono)', flexShrink:0 }}>{r.display}</span>
          </div>
          <div style={{ height:6, borderRadius:3, background:'var(--bg3)', overflow:'hidden' }}>
            <div style={{ height:'100%', width:`${Math.round(((r.value || 0) / max) * 100)}%`, background:r.color || 'var(--acc)', borderRadius:3 }}/>
          </div>
        </div>
      ))}
    </div>
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
  const tomorrowStart = new Date(todayStart); tomorrowStart.setDate(tomorrowStart.getDate() + 1);
  // Bound to TODAY only (both ends): catering is dated to its event day, so without an
  // upper bound a future pre-order would inflate "today" and diverge from the P&L.
  const todayChecks = closedChecks.filter(c => {
    if (!c.closedAt) return false;
    const t = new Date(c.closedAt);
    return t >= todayStart && t < tomorrowStart && (!locId || c.locationId === locId);
  });

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
    { label:"Revenue today",   value:`${money(revenue)}`, color:'var(--acc)', sub:`${todayChecks.length} closed checks` },
    { label:'Covers today',    value:covers,                    color:'var(--blu)', sub:`${currencySymbol()}${covers > 0 ? (revenue / covers).toFixed(2) : '0.00'}/head` },
    { label:'Tables active',   value:activeTbls,                color:'var(--grn)', sub:`of ${totalTables} tables` },
    { label:'Terminals online',value:`${onlineDevs}/${liveDevices.length}`, color: onlineDevs === liveDevices.length && liveDevices.length > 0 ? 'var(--grn)' : 'var(--acc)', sub:'this site' },
  ];

  // v5.5.340: today's snapshot aggregates for the overview dashboard.
  const snap = useMemo(() => {
    const sources = {}, users = {}, products = {}, methods = {}, types = {};
    let discTotal = 0, discCount = 0, tips = 0, refunds = 0;
    todayChecks.forEach(c => {
      // v5.5.856: channel orders bucket by their PLATFORM (Deliveroo / Uber Eats / Just
      // Eat…) — 'hubrise' is the pipe, not a source. Prefixed so a platform name can
      // never collide with a built-in source key.
      // v5.5.862: whitelist, not passthrough — `source` can carry internal payment-path
      // stamps (pos_send_to_terminal, pax_table_pay); those are POS sales.
      const _raw = (c.source || 'pos').toLowerCase();
      const _src = ['kiosk', 'online', 'qr', 'catering', 'hubrise'].includes(_raw) ? _raw : 'pos';
      const _bucket = _src === 'hubrise' ? `hr:${c.customer?.channel || 'Delivery apps'}` : _src;
      sources[_bucket] = (sources[_bucket] || 0) + (c.total || 0);
      const u = c.server || 'Unknown';
      users[u] = (users[u] || 0) + (c.total || 0);
      const m = payBucket(c.method);
      methods[m] = (methods[m] || 0) + (c.total || 0);
      const t = c.orderType || 'dine-in';
      types[t] = (types[t] || 0) + (c.total || 0);
      tips += c.tip || 0;
      (c.discounts || []).forEach(d => { discTotal += (d.amount || d.value || 0); discCount += 1; });
      (c.refunds || []).forEach(r => { refunds += (r.amount || 0); });
      (c.items || []).forEach(it => {
        const n = it.name || 'Item';
        if (!products[n]) products[n] = { qty: 0, rev: 0 };
        products[n].qty += it.qty || 1;
        products[n].rev += (it.price || 0) * (it.qty || 1);
      });
    });
    return { sources, users, products, methods, types, discTotal, discCount, tips, refunds };
  }, [todayChecks]);

  const quickActions = [
    { icon:'list',     h:145, label:'Edit menu',        sub:'Update items, prices, allergens',  target:'menu' },
    { icon:'floor',    h:200, label:'Floor plan',       sub:'Move tables, add sections',       target:'floorplan' },
    { icon:'hardware', h:265, label:'Device profiles',  sub:'Configure terminal behaviour',    target:'profiles' },
    { icon:'pos',      h:210, label:'Add terminal',       sub:'Pair a new Sunmi device',                    target:'devices' },
    { icon:'print',    h:38,  label:'Manage printers',    sub:'Add NT311 and other ESC/POS printers',       target:'printers' },
    { icon:'team',     h:300, label:'Manage staff',       sub:'Add servers, change PINs',                   target:'staff' },
    { icon:'print',    h:330, label:'Production printing', sub:'Route orders to kitchen & receipt printers', target:'printing' },
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
            position:'relative', overflow:'hidden',
            background:'var(--glass-bg)', backdropFilter:'blur(22px) saturate(150%)', WebkitBackdropFilter:'blur(22px) saturate(150%)',
            border:'1px solid var(--glass-border)', boxShadow:'var(--glass-shadow), var(--glass-hi)',
            borderRadius:16, padding:'18px 20px',
          }}>
            <div style={{ position:'absolute', left:0, top:0, bottom:0, width:3, background:s.color }} />
            <div style={{ fontSize:10, fontWeight:700, color:'var(--t3)', textTransform:'uppercase', letterSpacing:'.1em', marginBottom:10, fontFamily:'var(--font-mono)' }}>{s.label}</div>
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
            background:'var(--glass-bg)', backdropFilter:'blur(22px) saturate(150%)', WebkitBackdropFilter:'blur(22px) saturate(150%)',
            border:'1px solid var(--glass-border)', boxShadow:'var(--glass-shadow), var(--glass-hi)',
            borderRadius:15, padding:'15px 17px', cursor:'pointer',
            textAlign:'left', fontFamily:'inherit', transition:'transform .14s, box-shadow .14s',
            display:'flex', alignItems:'center', gap:14,
          }}
          onMouseEnter={e => { e.currentTarget.style.transform='translateY(-2px)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform='translateY(0)'; }}>
            <span style={{ width:42, height:42, borderRadius:12, flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center',
              color:`oklch(var(--cat-l) var(--cat-c) ${a.h})`,
              background:`color-mix(in oklch, oklch(var(--cat-l) var(--cat-c) ${a.h}) 14%, transparent)`,
              border:`1px solid color-mix(in oklch, oklch(var(--cat-l) var(--cat-c) ${a.h}) 24%, transparent)` }}>
              <Icon name={a.icon} size={20} />
            </span>
            <div>
              <div style={{ fontSize:13.5, fontWeight:600, color:'var(--t1)', marginBottom:3 }}>{a.label}</div>
              <div style={{ fontSize:11.5, color:'var(--t3)' }}>{a.sub}</div>
            </div>
          </button>
        ))}
      </div>

      {/* ── Today's snapshot (v5.5.340) ── */}
      <div style={{ fontSize:13, fontWeight:700, color:'var(--t2)', marginBottom:12 }}>Today's snapshot</div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(2,1fr)', gap:12, marginBottom:28 }}>
        <SnapCard title="Sales by order source" onClick={() => setSection('reports')}
          rows={[
            ...SOURCE_META.filter(s => s.key !== 'delivery').map(s => { const v = snap.sources[s.key] || 0; return { label:s.label, value: s.soon ? 0 : v, color:s.color, soon:s.soon, display: s.soon ? 'Not connected' : money(v) }; }),
            // v5.5.856: one row PER delivery platform (was a single "Delivery apps" roll-up)
            ...Object.entries(snap.sources).filter(([k]) => k.startsWith('hr:')).sort((a, b) => b[1] - a[1])
              .map(([k, v]) => ({ label: k.slice(3), value: v, color:'#ef4444', display: money(v) })),
          ]}/>
        <SnapCard title="Sales by user" onClick={() => setSection('reports')} empty="No sales yet today"
          rows={Object.entries(snap.users).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([name,total]) => ({ label:name, value:total, display:money(total) }))}/>
        <SnapCard title="Top sellers" onClick={() => setSection('reports')} empty="No items sold yet today"
          rows={Object.entries(snap.products).map(([name,v])=>({ name, ...v })).sort((a,b)=>b.qty-a.qty).slice(0,6).map(p => ({ label:p.name, value:p.qty, color:'var(--grn)', display:`${p.qty} · ${money(p.rev)}` }))}/>
        <SnapCard title="Payment mix" onClick={() => setSection('reports')} empty="No payments yet today"
          rows={Object.entries(snap.methods).sort((a,b)=>b[1]-a[1]).map(([m,total]) => ({ label:m, value:total, color:'var(--blu)', display:money(total) }))}/>
        <SnapCard title="Sales by order type" onClick={() => setSection('reports')} empty="No sales yet today"
          rows={Object.entries(snap.types).sort((a,b)=>b[1]-a[1]).map(([t,total]) => ({ label: ORDER_TYPE_LABEL[t] || t, value:total, color:'#e8a020', display:money(total) }))}/>
        <div style={{ background:'var(--bg1)', border:'1px solid var(--bdr)', borderRadius:14, padding:'16px 18px' }}>
          <div style={{ fontSize:11, fontWeight:800, color:'var(--t4)', textTransform:'uppercase', letterSpacing:'.07em', marginBottom:14 }}>Discounts &amp; tips today</div>
          <div style={{ display:'flex', gap:16 }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:22, fontWeight:800, color:'var(--red)', fontFamily:'var(--font-mono)' }}>{money(snap.discTotal)}</div>
              <div style={{ fontSize:11, color:'var(--t3)', marginTop:3 }}>{snap.discCount} discount{snap.discCount===1?'':'s'} applied</div>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:22, fontWeight:800, color:'var(--grn)', fontFamily:'var(--font-mono)' }}>{money(snap.tips)}</div>
              <div style={{ fontSize:11, color:'var(--t3)', marginTop:3 }}>tips collected</div>
            </div>
            {snap.refunds > 0 && (
              <div style={{ flex:1 }}>
                <div style={{ fontSize:22, fontWeight:800, color:'var(--t2)', fontFamily:'var(--font-mono)' }}>{money(snap.refunds)}</div>
                <div style={{ fontSize:11, color:'var(--t3)', marginTop:3 }}>refunded</div>
              </div>
            )}
          </div>
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
