// Back Office section access: which parts of Back Office a login is shown (8 Oct 2026).
//
// Peter: "from the back office when we can invite someone to the back office we need to be able
// to limit what they can see via each tab. MO is a franchisee, we want him to be able to login to
// the back office. But he cannot mess with menus, inventory, produce etc. We only want to give
// him access to workforce, reports, team and customers, nothing else."
//
// THIS IS A SCREEN LOCK, NOT A DATABASE LOCK. A section a login may not open is gone from the
// sidebar and can never render, by any route. What the DATABASE lets that login read and write
// is unchanged: it is still decided by which venues the login is linked to. Never describe this
// as more than hiding screens.
//
// The rules:
//   * 15 top level sections, one stable key each (the list is in
//     supabase/functions/_shared/boSectionRules.js, shared with the create-user function).
//   * user_profiles.bo_sections: null = everything (every login before today, and the default).
//     A list = ONLY those sections.
//   * Owners and ServOS staff always open everything.
//   * A route that is in NO section (the in-app Company Admin, an unknown wf- route) is open
//     only to a login that opens everything.
//   * One function decides, canOpenRoute(). The sidebar, the route setter and the render all ask
//     it (src/backoffice/BackOfficeApp.jsx).
//
// Pure: no React, no Supabase. The sidebar list lives HERE so the app and these rules read one
// list. Tests that used to read it out of BackOfficeApp.jsx read this file now.

import {
  BO_SECTION_KEYS, EVERYTHING_ROLES, isEverythingRole, checkSections, storedSections,
  allowedKeys, capSections, withinSections, sameSections, isSectionsColumnMissing, sectionsFromAnswer,
} from '../../supabase/functions/_shared/boSectionRules.js';
// One reading of "that column is not there yet" for the whole app (PGRST204, 42703, the wording).
import { isMissingColumnError } from './kds/kdsSettings.js';

export {
  BO_SECTION_KEYS, EVERYTHING_ROLES, isEverythingRole, checkSections, storedSections,
  allowedKeys, capSections, withinSections, sameSections, isSectionsColumnMissing, sectionsFromAnswer,
};

// ── The sidebar ─────────────────────────────────────────────────────────────
// Moved here from BackOfficeApp.jsx on 8 Oct 2026, unchanged. Keep each row's shape exactly
// (label, icon, then single or children): src/lib/boSidebar.test.js and
// src/lib/ops/documentsFormsWiring.test.js read the rows as text.
//
// v5.5.367 ServOS: intent-based sidebar IA. Every child keeps the existing section id (route)
// from NAV in BackOfficeApp.jsx: this regroups, never re-wires.
// `single` = the header navigates straight to that route; `children` = a
// collapsible accordion of existing routes.
export const NAV_IA = [
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

// ── Section keys ────────────────────────────────────────────────────────────
// Sidebar label to stable key. Kept beside the rows, not inside them, so the row shape the
// sidebar tests read stays as it is. A row whose label is NOT here has no key: it shows only
// for a login that opens everything (fail closed), and boSections.test.js fails until it is added.
export const SECTION_KEY_BY_LABEL = Object.freeze({
  'Overview': 'overview',
  'Menu': 'menu',
  'Floor plan': 'floorplan',
  'Inventory': 'inventory',
  'Produce': 'produce',
  'Purchasing': 'purchasing',
  'Operations': 'operations',
  'Team': 'team',
  'Workforce': 'workforce',
  'Customers': 'customers',
  'Channels': 'channels',
  'Hardware': 'hardware',
  'Reports': 'reports',
  'Card payments': 'card-payments',
  'Settings': 'settings',
});

/** The key of a sidebar row, or null when the row has none. */
export function sectionKeyOfRow(row) {
  const key = row && Object.prototype.hasOwnProperty.call(SECTION_KEY_BY_LABEL, row.label) ? SECTION_KEY_BY_LABEL[row.label] : null;
  return key && BO_SECTION_KEYS.includes(key) ? key : null;
}

/** Every route id a sidebar row leads to. */
export function routesOfRow(row) {
  if (!row) return [];
  if (row.single) return [row.single];
  return (row.children || []).map((c) => c[0]);
}

/** [{ key, label }] for the 15 sections, in sidebar order. For tick boxes and plain wording. */
export const SECTIONS = Object.freeze(
  NAV_IA.map((row) => ({ key: sectionKeyOfRow(row), label: row.label })).filter((s) => s.key),
);

/**
 * Route id to section key, built FROM the sidebar (never typed out a second time).
 * Route ids and section keys are different things that share some spellings ('menu',
 * 'inventory', 'customers', 'reports'): never test a route id against the key list.
 */
export function buildRouteSections(nav = NAV_IA) {
  const map = new Map();
  for (const row of nav) {
    const key = sectionKeyOfRow(row);
    if (!key) continue;
    for (const id of routesOfRow(row)) if (!map.has(id)) map.set(id, key);
  }
  return map;
}
const ROUTE_SECTIONS = buildRouteSections(NAV_IA);

/** The section a route belongs to, or null when it belongs to none. */
export function sectionKeyOfRoute(routeId) {
  return typeof routeId === 'string' && ROUTE_SECTIONS.has(routeId) ? ROUTE_SECTIONS.get(routeId) : null;
}

/** A login that opens everything (mock mode has no login at all: it is the demo owner). */
export const EVERYTHING = Object.freeze({ role: 'owner', sections: null });

/**
 * THE rule. May this login open this route?
 *   everything (null list, owner, ServOS): yes, any route, as before 8 Oct 2026;
 *   a list: only a route whose section is on it. A route in no section is refused.
 * This hides screens. It is not a database lock (see the top of this file).
 */
export function canOpenRoute(routeId, profile) {
  const allowed = allowedKeys(profile);
  if (allowed === null) return true;
  const key = sectionKeyOfRoute(routeId);
  return !!key && allowed.includes(key);
}

/** The sidebar rows this login is shown. Everything = the list as it is. */
export function filterNav(nav, profile) {
  const allowed = allowedKeys(profile);
  if (allowed === null) return nav;
  return nav.filter((row) => { const key = sectionKeyOfRow(row); return !!key && allowed.includes(key); });
}

/** Where a login lands: the first route of its first section in sidebar order, or null for none. */
export function firstAllowedRoute(profile, nav = NAV_IA) {
  for (const row of filterNav(nav, profile)) {
    const first = routesOfRow(row)[0];
    if (first) return first;
  }
  return null;
}

/**
 * The route to show for a route that was asked for: itself when the login may open it, else
 * where the login lands (null when it may open nothing at all). Every way in goes through here.
 */
export function guardRoute(routeId, profile) {
  return canOpenRoute(routeId, profile) ? routeId : firstAllowedRoute(profile);
}

// Push to POS sits in the top bar on every screen and belongs to no section. It sends the menu
// (with discounts and tax), the floor plan and the device profiles to the tills, so it is shown
// only to a login that may open one of the sections it sends. A franchisee with Team, Workforce,
// Customers and Reports never sees it, so he cannot put somebody's half finished menu live.
export const PUSH_TO_POS_SECTIONS = Object.freeze(['menu', 'floorplan', 'hardware']);
export function canPushToPos(profile) {
  const allowed = allowedKeys(profile);
  return allowed === null || PUSH_TO_POS_SECTIONS.some((k) => allowed.includes(k));
}

// ── The Team screen ─────────────────────────────────────────────────────────

/** The shortcut Peter asked for by name: "workforce, reports, team and customers, nothing else". */
export const FRANCHISEE_SECTIONS = Object.freeze(['workforce', 'reports', 'team', 'customers']);

/** Ticked boxes to what is stored: every box ticked is "everything", kept as null. */
export function sectionsToStore(ticked) {
  const list = storedSections(Array.isArray(ticked) ? ticked : []);
  return list.length === BO_SECTION_KEYS.length ? null : list;
}

/** What is stored to ticked boxes: null ticks all 15. */
export function sectionsToTicks(stored) {
  return stored === null ? [...BO_SECTION_KEYS] : storedSections(stored);
}

/** Plain words for what a login can open: "Everything", "Nothing", or the section names. */
export function describeSections(stored) {
  if (stored === null) return 'Everything';
  const list = storedSections(stored);
  if (!list.length) return 'Nothing';
  return SECTIONS.filter((s) => list.includes(s.key)).map((s) => s.label).join(', ');
}

/**
 * Who is offered the tick boxes for a login (the database decides again in set_bo_sections):
 * an owner or ServOS staff, never for their own login, never for an owner's or ServOS's login.
 */
export function canEditSectionsFor({ callerRole, callerId, targetId, targetRole } = {}) {
  if (!isEverythingRole(callerRole)) return false;
  if (!targetId || !callerId || targetId === callerId) return false;
  if (isEverythingRole(targetRole)) return false;
  return true;
}

/**
 * May this person switch a login's Back Office access ON? Off is always allowed (it only takes
 * away). On is allowed when the login opens nothing this person cannot: a person who opens
 * everything (mySections null) may switch on any login; a limited person may not switch on an
 * unlimited login, one whose list is not known (undefined), or one with a wider list.
 * Review, 8 Oct 2026: without this a limited login could undo the switch off that grantBOAccess
 * does when a new login's limit did not land, or switch an unlimited teammate login back on
 * after the owner turned it off. The database says the same (user_profiles_bo_sections_guard in
 * supabase/migrations/20261008a_OPS_bo_sections.sql); this is the plain word on the screen.
 */
export function canSwitchLoginOn(targetSections, mySections) {
  if (mySections === null) return true;
  return withinSections(targetSections, mySections);
}

// ── Reading the signed in login's own profile (decision 8) ──────────────────
// Only "that column does not exist" means a feature is not installed. bo_sections missing =
// section access is not installed, and everyone opens everything, exactly as before 8 Oct 2026.
// ANY other failure (the network, a refusal, no row) must never widen access: the caller shows
// "Could not load your access. Try again." and no sidebar at all.
export const PROFILE_COLUMNS = Object.freeze(['role', 'org_id', 'location_id', 'bo_access', 'bo_sections']);
/** The columns the read may go without, and only when the database names that very column. */
export const OPTIONAL_PROFILE_COLUMNS = Object.freeze(['bo_sections', 'bo_access']);

/** The optional column this error says is missing, or null for any other error. */
export function missingProfileColumn(error, alreadyDropped = []) {
  if (!error) return null;
  return OPTIONAL_PROFILE_COLUMNS.find((c) => !alreadyDropped.includes(c) && isMissingColumnError(error, c)) || null;
}

/**
 * Read the profile through `readColumns(columnList)` (the caller's own Supabase read, which
 * answers { data, error }). At most three reads.
 *   { ok: true, row, sectionsInstalled }   sectionsInstalled false = the column is not there yet
 *   { ok: false, error }                   stop: nothing is known about this login
 */
export async function readProfileRow(readColumns) {
  const dropped = [];
  for (;;) {
    let res;
    try { res = await readColumns(PROFILE_COLUMNS.filter((c) => !dropped.includes(c)).join(', ')); }
    catch (e) { return { ok: false, error: e }; }
    const gone = missingProfileColumn(res?.error, dropped);
    if (gone) { dropped.push(gone); continue; }
    if (res?.error || !res?.data) return { ok: false, error: res?.error || null };
    return { ok: true, row: res.data, sectionsInstalled: !dropped.includes('bo_sections') };
  }
}

/**
 * Who is signed in, for the rules above, from the profile row. Not installed = everything.
 * Installed = what is stored, read strictly (anything that is not null or a list is nothing).
 */
export function sectionsFromProfileRow(row, sectionsInstalled) {
  if (!sectionsInstalled) return null;
  return storedSections(row ? row.bo_sections : undefined);
}
