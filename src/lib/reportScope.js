// src/lib/reportScope.js
//
// THE REPORT SCOPE: which sites a Back Office report is looking at.
//
// WHY (Peter, 5 Oct 2026): "make every report we have multi site when sites are connected
// together, and you can filter them down to just one site. Like full multi site reporting
// rather than just one multi site report." Until now there was no site filter at all: every
// report read the one site the login was signed in to, and Location compare kept its own
// idea of "my sites".
//
// THE RULES THIS FILE KEEPS
//   1. CONNECTED = SAME COMPANY AND READABLE. A site is in the scope when it has the same
//      locations.org_id as the signed in site AND the database lets this login read it
//      (accessible_location_ids(), the rule behind the closed_checks_read policy). One rule.
//      Before this, three paths disagreed (user_locations rows in db.js, the owner snapshot,
//      and the database rule), so one Coffee Boy owner saw 5 of 6 sites, and 4 owner logins
//      that hold sites in 2 to 4 companies would have had them added together.
//   2. EVERY SITE ON ITS OWN CLOCK AND BUSINESS DAY. The period is a set of business days
//      ("Last 7 days" = 29 Sep to 5 Oct); each site turns those days into its own instants
//      (siteRange below). Barnsley Train Station starts its day at 00:00, the others 06:30.
//   3. CURRENCIES ARE NEVER ADDED TOGETHER. canShowCombinedTotal is true only when every
//      ticked site shares one known currency.
//   4. IT STARTS ON THE SITE YOU ARE SIGNED IN TO and remembers the last choice, per login
//      and per company (Peter's decision 3).
//   5. A REPORT THAT IS NOT MULTI SITE YET NEVER MIXES ROWS. REPORT_SITE_MODE below is the
//      flag list; a report gets several sites' rows only when its flag says 'multi'.
//
// PURE: no Supabase, no React. The reads are in src/lib/reportSites.js, the loader in
// src/lib/reportScopeLoad.js. Runs under node --test.

import { venueRange } from '../backoffice/sections/reports/_filters.js';
import { compareRange } from './reportCompare.js';

// ── the flag list: how each report takes sites ───────────────────────────────
//
//   'multi'  ready for several sites: it gets every ticked site's rows, tagged.
//   'one'    rides only on the rows and config it is handed, so it can show ANY one site.
//            Several ticked = it shows one of them, with a note and a chooser.
//   'home'   reads something of the signed in site from memory or by its own query (the
//            menu, tax rates, staff, a drawer), so it shows the signed in site only.
//   'all'    the overview: always every connected site.
//
// STEP 3 (5 Oct 2026) flipped the first eleven to 'multi': each has a site split (a group
// total on top, then a row or column per site, a Site column in its CSV; the shared maths is
// src/lib/reportSplit.js). Transactions is among them: the LIST shows any ticked site, and
// refunds, receipts and the reversal retry stay locked to the signed in site inside the
// report (reportSplit.actionLock).
// STEP 4 (5 Oct 2026) flipped items, item_trend, menu_eng, tax, tips and kds_perf: each
// site's lines are now read against ITS OWN menu, tax rates and production centres
// (src/lib/reportSiteMenu.js), so another site's rows get the right categories, one row per
// shared product (by master id), its own VAT and its own station names. The tip pool
// calculator and the 86 list stay one site at a time inside their reports.
export const REPORT_SITE_MODE = {
  summary: 'multi', daily_trend: 'multi', order_types: 'multi', order_sources: 'multi', daypart: 'multi',
  servers: 'multi', shifts: 'multi', exceptions: 'multi', payments: 'multi', tables: 'multi',
  transactions: 'multi',
  items: 'multi', item_trend: 'multi', menu_eng: 'multi', sales_mix: 'multi', tax: 'multi', tips: 'multi', kds_perf: 'multi',
  payroll: 'home', daily_trading: 'home', bookings: 'home', cash_drawer: 'home',
  zreport: 'home', open: 'home',
  location_compare: 'all',
};

// One site ON PURPOSE (a slip, a drawer, or an action that belongs to one site). The note
// says so, where the others say "for now".
export const ONE_SITE_BY_DESIGN = new Set(['zreport', 'open', 'cash_drawer']);

// Reports that read every item of every check. Across more than one site they are capped
// (Peter's decision 4: "item level reports across all sites capped at 7 days").
export const ITEM_LEVEL_REPORTS = new Set(['items', 'item_trend', 'menu_eng', 'sales_mix']);
export const ITEM_MULTI_MAX_DAYS = 7;
export const ITEM_CAP_TEXT = 'Item reports across several sites cover up to 7 days. Pick one site for longer.';

// Money reports that can draw from the server day sums (src/lib/reportDaySums.js): their
// site split reads either rows or sums (reportSplit.js has the adapters). A report that is
// not here always has its rows read in the browser.
export const DAY_SUMS_REPORTS = new Set(['summary', 'daily_trend', 'payments', 'order_types']);
// Several sites over more days than this is too heavy to read row by row on the database
// the tills use (design, section 5): the day sums are asked instead, when they are there.
export const ROWS_MULTI_MAX_DAYS = 7;

export function siteModeFor(view) {
  if (typeof view === 'string' && view.startsWith('loyalty_')) return 'home';
  return REPORT_SITE_MODE[view] || 'home';
}

// ── who is connected ─────────────────────────────────────────────────────────

const tidyName = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const upper = (v) => (v ? String(v).toUpperCase() : null);

/**
 * The sites of the signed in site's company that this login may read.
 *   locations    Ops locations rows: { id, name, org_id, currency, timezone }
 *   readableIds  what accessible_location_ids() answered; null = could not ask
 * No company on the signed in site, or the read list unknown = the signed in site alone:
 * never a guess that widens what is shown. The signed in site is always in the answer.
 */
export function connectedSites({ homeId, locations, readableIds } = {}) {
  if (!homeId) return [];
  const rows = Array.isArray(locations) ? locations : [];
  const home = rows.find((l) => String(l?.id) === String(homeId)) || { id: homeId };
  const orgId = home.org_id || null;
  const readable = Array.isArray(readableIds) ? new Set(readableIds.map(String)) : null;
  const out = new Map([[String(homeId), home]]);
  if (orgId && readable) {
    for (const l of rows) {
      if (!l?.id || l.org_id !== orgId || !readable.has(String(l.id))) continue;
      if (!out.has(String(l.id))) out.set(String(l.id), l);
    }
  }
  return [...out.values()];
}

// ── the remembered choice ────────────────────────────────────────────────────

/** Where the last choice is kept: per login and per company. */
export function choiceKey(userId, companyId) {
  return `rpos-report-sites:${userId || 'anon'}:${companyId || 'none'}`;
}

/** The saved choice, { all: true } or { ids: [...] }; null for none or unreadable. */
export function readSiteChoice(storage, key) {
  try {
    const v = JSON.parse(storage?.getItem(key) || 'null');
    if (v?.all === true) return { all: true };
    if (Array.isArray(v?.ids)) return { ids: v.ids.map(String) };
  } catch { /* private mode, or not JSON: no choice */ }
  return null;
}

export function writeSiteChoice(storage, key, choice) {
  try { storage?.setItem(key, JSON.stringify(choice?.all ? { all: true } : { ids: (choice?.ids || []).map(String) })); }
  catch { /* quota or private mode: the choice lasts for this visit only */ }
}

/**
 * The ticked site ids from a saved choice. No choice = the signed in site. Ids that are no
 * longer in the scope (a site unlinked, another company) are dropped; none left = the
 * signed in site. "All sites" stays all as sites are added.
 */
export function resolveTicked(choice, sites, homeId) {
  const ids = (sites || []).map((s) => String(s.id));
  const home = ids.includes(String(homeId)) ? String(homeId) : ids[0];
  if (!ids.length) return [];
  if (choice?.all) return ids;
  const kept = Array.isArray(choice?.ids) ? ids.filter((id) => choice.ids.includes(id)) : [];
  return kept.length ? kept : [home];
}

/** Tick or untick one site. The last ticked site cannot be unticked. */
export function toggleTicked(tickedIds, id, sites) {
  const all = (sites || []).map((s) => String(s.id));
  const cur = new Set((tickedIds || []).map(String));
  const key = String(id);
  if (!all.includes(key)) return all.filter((x) => cur.has(x));
  if (cur.has(key)) { if (cur.size > 1) cur.delete(key); } else cur.add(key);
  return all.filter((x) => cur.has(x));
}

/** What to save for a set of ticks: all of them is "All sites", so a new site joins it. */
export function choiceFor(tickedIds, sites) {
  const all = (sites || []).length;
  return all > 1 && (tickedIds || []).length === all ? { all: true } : { ids: (tickedIds || []).map(String) };
}

// ── the scope ────────────────────────────────────────────────────────────────

/**
 * @param {object} a
 * @param {string} a.homeId       the signed in site (Ops location id)
 * @param {string} [a.userId]
 * @param {object[]} [a.locations]   Ops locations rows (any company; the rule filters)
 * @param {string[]|null} [a.readableIds]
 * @param {Record<string, { timezone?: string, businessDayStart?: string, shifts?: any[], currency?: string }>} [a.clocks]
 *        each site's own clock, by Ops id (Platform locations by ops_location_id)
 * @param {object} [a.homeConfig]    getLocationConfig() for the signed in site: its clock wins
 *        for that site, so one site reads exactly as it did before there was a scope
 * @param {string[]} [a.tickedIds]
 * @param {{ available: boolean|null, reason?: string|null }} [a.daySums]
 */
export function buildReportScope({ homeId, userId = null, locations, readableIds, clocks = {}, homeConfig = null, tickedIds, daySums } = {}) {
  const rows = connectedSites({ homeId, locations, readableIds });
  const home = rows.find((l) => String(l.id) === String(homeId));
  const sites = rows.map((l) => {
    const id = String(l.id);
    const isHome = id === String(homeId);
    const c = clocks?.[id] || null;
    const own = isHome && homeConfig ? homeConfig : c;
    return {
      id,
      name: tidyName(l.name) || (isHome ? 'This site' : 'Site'),
      // No clock on record reads London 06:00, as getVenueClock always has; clockKnown says
      // so, and the server day sums refuse a site whose clock is a guess.
      timezone: own?.timezone || 'Europe/London',
      businessDayStart: own?.businessDayStart || '06:00',
      shifts: Array.isArray(own?.shifts) ? own.shifts : [],
      currency: upper(l.currency) || upper(c?.currency) || (isHome ? upper(homeConfig?.currency) : null),
      clockKnown: !!(own?.timezone && own?.businessDayStart),
      isHome,
    };
  }).sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.id < b.id ? -1 : 1));

  const ids = sites.map((s) => s.id);
  const wanted = Array.isArray(tickedIds) ? tickedIds.map(String) : null;
  let ticked = wanted ? ids.filter((id) => wanted.includes(id)) : [];
  if (!ticked.length) ticked = resolveTicked(null, sites, homeId);
  const tickedSites = sites.filter((s) => ticked.includes(s.id));
  const byId = new Map(sites.map((s) => [s.id, s]));
  const homeSite = byId.get(String(homeId)) || null;
  const scope = {
    companyId: home?.org_id || null,
    homeId: homeId ? String(homeId) : null,
    userId,
    sites,
    home: homeSite,
    tickedIds: ticked,
    ticked: tickedSites,
    // The site a one site report shows when several are ticked: the signed in site when it
    // is ticked, else the first ticked by name.
    primary: tickedSites.find((s) => s.isHome) || tickedSites[0] || homeSite,
    hasChoice: sites.length > 1,
    allTicked: sites.length > 0 && ticked.length === sites.length,
    daySums: { available: daySums?.available ?? null, reason: daySums?.reason ?? null },
    siteOf: (id) => byId.get(String(id)) || null,
    clockOf: (id) => {
      const s = byId.get(String(id));
      return s ? { timeZone: s.timezone, dayStart: s.businessDayStart } : null;
    },
    currencyOf: (id) => byId.get(String(id))?.currency || null,
  };
  scope.isMulti = isMulti(scope);
  scope.currencies = currenciesInScope(scope);
  scope.canShowCombinedTotal = canShowCombinedTotal(scope);
  return scope;
}

/** More than one site ticked. */
export const isMulti = (scope) => (scope?.ticked?.length || 0) > 1;

/** The currencies of the given sites (default: the ticked ones), each once; null = not known. */
export function currenciesInScope(scope, sites = scope?.ticked) {
  const out = [];
  for (const s of sites || []) { const c = s.currency || null; if (!out.includes(c)) out.push(c); }
  return out;
}

/** One total may be shown only when every site shares ONE known currency. */
export function canShowCombinedTotal(scope, sites = scope?.ticked) {
  const cur = currenciesInScope(scope, sites);
  return cur.length === 1 && !!cur[0];
}

/** The words on the Sites control: "Leeds", "All sites (6)", "3 of 6 sites". */
export function sitesLabel(scope) {
  const n = scope?.ticked?.length || 0, all = scope?.sites?.length || 0;
  if (n <= 1) return scope?.ticked?.[0]?.name || 'This site';
  return n === all ? `All sites (${all})` : `${n} of ${all} sites`;
}

// ── which sites one report is shown ──────────────────────────────────────────

/**
 * The sites whose rows `view` gets, and the note to show when that is not what is ticked.
 *   oneSiteId  the site picked in the note's chooser (a 'one' report with several ticked)
 * Returns { mode, sites, note, choices }: choices = the sites the note's chooser offers
 * ([] for none).
 */
export function sitesForView(view, scope, oneSiteId = null) {
  const mode = siteModeFor(view);
  const ticked = scope?.ticked || [];
  const home = scope?.home || null;
  if (!scope || !home) return { mode, sites: [], note: null, choices: [] };
  if (mode === 'all') {
    return { mode, sites: scope.sites, note: scope.hasChoice ? 'This overview always shows every site.' : null, choices: [] };
  }
  if (mode === 'multi') return { mode, sites: ticked, note: null, choices: [] };
  if (mode === 'one') {
    if (ticked.length <= 1) return { mode, sites: ticked.length ? ticked : [home], note: null, choices: [] };
    const site = ticked.find((s) => s.id === String(oneSiteId)) || scope.primary;
    return { mode, sites: [site], note: `This report shows one site at a time. Showing ${site.name}.`, choices: ticked };
  }
  const onlyHome = ticked.length === 1 && ticked[0].isHome;
  const note = onlyHome || !scope.hasChoice ? null
    : ONE_SITE_BY_DESIGN.has(view)
      ? `This report is for one site: the one you are signed in to. Showing ${home.name}.`
      : `This report shows the site you are signed in to for now. Showing ${home.name}.`;
  return { mode: 'home', sites: [home], note, choices: [] };
}

// ── each site's own range ────────────────────────────────────────────────────

/**
 * The shell's range read on ONE site's clock: the same business days (or the same service
 * times) as instants there, with that site's own comparison (the one percent rule is cut at
 * the same time of day on ITS clock). Same shape as getPeriodRange. For the site the range
 * was built on, it is the same instants.
 *
 * The days are the range's days: when two sites are far enough apart that "today" is a
 * different business day at one of them, that site is read over the range's day, not its own
 * (Location compare has always worked this way).
 */
export function siteRange(period, range, site, nowMs = Date.now()) {
  const vr = venueRange(range, { timezone: site?.timezone, businessDayStart: site?.businessDayStart });
  if (!vr) return null;
  const full = range.kind === 'service'
    ? { ...vr, kind: 'service', shiftName: range.shiftName, serviceStart: range.serviceStart, serviceEnd: range.serviceEnd }
    : vr;
  const compare = compareRange(period, full, nowMs);
  const fromMs = full.from.getTime(), toMs = full.to.getTime();
  return {
    ...full,
    prevFrom: compare ? compare.from : new Date(fromMs - 1 - (toMs - fromMs)),
    prevTo:   compare ? compare.to   : new Date(fromMs - 1),
    compare,
  };
}

/** How many business days a range covers (0 when it is not a range). */
export function rangeDayCount(range) {
  const a = Date.parse(`${range?.fromDay}T00:00:00Z`), b = Date.parse(`${range?.toDay}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

/** The line an item report shows in place of its figures, or null when it may load. */
export function itemCapLine(view, sites, range) {
  if (!ITEM_LEVEL_REPORTS.has(view) || (sites || []).length <= 1) return null;
  return rangeDayCount(range) > ITEM_MULTI_MAX_DAYS ? ITEM_CAP_TEXT : null;
}

/**
 * Where a report's figures come from: 'rows' (read in the browser, paged) or 'sums' (the
 * server day sums). Sums only for several sites over a long period, for a report that can
 * draw from them, and only once the database function is known to be there.
 */
export function figuresFrom(view, sites, range, daySums) {
  const long = (sites || []).length > 1 && rangeDayCount(range) > ROWS_MULTI_MAX_DAYS;
  return long && DAY_SUMS_REPORTS.has(view) && daySums?.available === true ? 'sums' : 'rows';
}

// ── group figures ────────────────────────────────────────────────────────────

/**
 * Rows' money per currency: [{ key, currency, siteId, total }], in first seen order. Never
 * one sum. A site whose currency nobody knows is a total of its own (key 'unknown:<id>',
 * currency null, siteId set), never added to another: the same rule as
 * reportSplit.currencyBlocks, so the shell's header and the Transactions cards say what the
 * Business summary's blocks say (6 Oct 2026 review: they folded it into the signed in site's
 * currency). A row with no site at all (none tagged) counts in the signed in site's currency.
 */
export function totalsByCurrency(rows, scope, valueOf = (r) => r.total || 0) {
  const map = new Map();
  for (const r of rows || []) {
    const id = r.siteId ?? r.locationId ?? null;
    const known = id != null ? (scope?.currencyOf?.(id) || null) : (scope?.home?.currency || null);
    const key = known || (id != null ? `unknown:${id}` : 'unknown');
    const t = map.get(key) || map.set(key, { key, currency: known, siteId: known ? null : id, total: 0 }).get(key);
    t.total += valueOf(r);
  }
  return [...map.values()];
}

/**
 * The totals as words: "£120.00 and $80.00", an unknown currency as
 * "12.00 at Leeds (currency not set)". `money(n, currency)` is lib/currency's.
 */
export function totalsWords(totals, scope, money) {
  return (totals || []).map((t) => {
    if (t.currency) return money(t.total, t.currency);
    const name = scope?.siteOf?.(t.siteId)?.name || 'a site';
    return `${money(t.total)} at ${name} (currency not set)`;
  }).join(' and ');
}

/**
 * The words on a GROUP percent. Each site is compared on its own clock, so the words can
 * differ between the sites of one block (viewed at 3am UK, Leeds's "today" is still Monday
 * and reads "vs last Monday by 3am"; Barnsley Train Station's day started at midnight, so
 * its Monday is over and reads "vs the Monday before"). The chip must not describe one
 * site's cut for a sum that mixes them.
 *   compares  each site's compare (compareRange's answer), one per site of the block
 * Returns { vs, mixed }: vs = the one compare when every site says the same, else null;
 * mixed = true when the words differ (the chip then carries MIXED_COMPARE_TEXT).
 */
export const MIXED_COMPARE_TEXT = 'each site against its own same days';
export function groupCompareWords(compares) {
  const list = (compares || []).filter(Boolean);
  if (!list.length) return { vs: null, mixed: false };
  const labels = new Set(list.map((c) => c.label || ''));
  return labels.size === 1 ? { vs: list[0], mixed: false } : { vs: null, mixed: true };
}

/**
 * The group percent, like for like: only sites that have BOTH this period and the
 * comparison count, so a new site cannot make the group read "up 500%".
 *   rows  [{ current, previous }] one per site (previous null = did not load)
 * Returns { pct, current, previous, compared, sites, fresh, text } where text is the part in
 * brackets, "(2 of 6 sites, 4 new)" or '' when every site is compared.
 */
export function groupCompare(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let current = 0, previous = 0, compared = 0, fresh = 0;
  for (const r of list) {
    const cur = Number(r?.current) || 0, prev = Number(r?.previous) || 0;
    if (prev > 0) { compared += 1; current += cur; previous += prev; }
    else if (cur > 0) fresh += 1;
  }
  const pct = previous > 0 ? ((current - previous) / previous) * 100 : null;
  const parts = [];
  if (compared < list.length) parts.push(`${compared} of ${list.length} sites`);
  if (fresh > 0) parts.push(`${fresh} new`);
  return { pct, current, previous, compared, sites: list.length, fresh, text: parts.length ? `(${parts.join(', ')})` : '' };
}
