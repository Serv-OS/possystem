/**
 * stock/siteScope.js: the site picker's rules for the stock screens (v5.11.89, multi site stock
 * Drop 1, integration map 3). Pure: no React, no Supabase, so node --test drives it
 * (siteScope.test.js, with seeded random runs).
 *
 * The scope is one answer of the database function stock_site_scope (Drop 0a), turned into
 * camelCase by scopeFromRpc. It says which company the signed in venue belongs to, whether that
 * company is a multi site company, this login's Stock control level THERE (the server works it out
 * per company, the browser never does), the sites this login reaches, the site groups, and who
 * may change company records ("Ask Jane Smith or Tom Lee").
 *
 * Rule 2 of the map, the one this file protects: a one site company (multi false) always works on
 * the signed in venue, with today's rights. Nothing here ever hands a one site company another
 * site, a lock, or a company word.
 *
 * A choice is { kind: 'all' } | { kind: 'group', id } | { kind: 'site', id }. A site that is closed
 * is only ever chosen from the picker while "Show closed sites" is on; that choice carries
 * closed: true so the shell (which does not hold the show closed flag) still honours it. A stored
 * choice never keeps that flag, so a reload starts on open sites again.
 */

import { allowedKeys, isEverythingRole } from '../../../supabase/functions/_shared/boSectionRules.js';

/** The three Stock control levels, lowest first (a stored null is 'sites'). */
export const LEVELS = Object.freeze(['sites', 'sites_full', 'all']);

const asId = (v) => (v == null || v === '' ? null : String(v));
const asList = (v) => (Array.isArray(v) ? v : []);

/** Is this site open? A site with no status is open (coalesce(status, 'active') = 'active'). */
export function isOpenSite(site) {
  if (!site || typeof site !== 'object') return false;
  return site.status == null || site.status === '' || String(site.status).toLowerCase() === 'active';
}

/**
 * The scope a one site company (or any failure) gets: the signed in venue alone, today's screens.
 * failed true says it was not read from the database (missing function, an error, out of time).
 */
export function oneSiteScope(homeId, { failed = true } = {}) {
  const id = asId(homeId);
  return {
    ready: true, failed: !!failed, orgId: null, homeSite: id, openCount: id ? 1 : 0, multiSince: null,
    multi: false, level: 'sites', sections: null,
    sites: id ? [{ id, name: '', status: 'active', currency: null, kind: null }] : [],
    closedSites: [], groups: [], kitchens: [], editors: [],
  };
}

const siteOf = (s) => ({
  id: asId(s?.id), name: String(s?.name ?? ''), status: s?.status ?? 'active',
  currency: s?.currency ?? null, kind: s?.kind ?? null,
});

/**
 * stock_site_scope's answer in camelCase (Drop 0 contract 3.6). Anything that is not a usable
 * answer (not an object, no site at all) is a one site scope that failed: fail to today's screens.
 */
export function scopeFromRpc(data, homeId) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return oneSiteScope(homeId);
  const sites = asList(data.sites).map(siteOf).filter((s) => s.id);
  const closedSites = asList(data.closed_sites).map(siteOf).filter((s) => s.id);
  if (!sites.length && !closedSites.length) return oneSiteScope(homeId);
  const level = LEVELS.includes(data.level) ? data.level : 'sites';
  return {
    ready: true,
    failed: false,
    orgId: asId(data.org_id),
    homeSite: asId(data.home_site) || asId(homeId),
    openCount: Number(data.open_count) || 0,
    multiSince: data.multi_since || null,
    multi: data.multi === true,
    level,
    sections: Array.isArray(data.sections) ? data.sections.map(String) : null,
    sites,
    closedSites,
    groups: asList(data.groups).map((g) => ({
      id: asId(g?.id), name: String(g?.name ?? ''),
      locationIds: asList(g?.location_ids ?? g?.locationIds).map(asId).filter(Boolean),
      sortOrder: Number(g?.sort_order ?? g?.sortOrder) || 0,
    })).filter((g) => g.id),
    kitchens: asList(data.kitchens).map(asId).filter(Boolean),
    editors: asList(data.editors).map((e) => String(e ?? '').trim()).filter(Boolean),
  };
}

/** { multi, sites, closed }: the company as the picker draws it. */
export function companyShape(scope) {
  return { multi: !!scope?.multi, sites: asList(scope?.sites), closed: asList(scope?.closedSites) };
}

const findIn = (list, id) => asList(list).find((s) => s && s.id === id) || null;
const openSite = (scope, id) => findIn(scope?.sites, asId(id));
const closedSite = (scope, id) => findIn(scope?.closedSites, asId(id));

/** The groups the picker offers: every site of the group is in this login's list, sorted. */
export function groupsFor(scope) {
  const known = new Set([...asList(scope?.sites), ...asList(scope?.closedSites)].map((s) => s.id));
  return asList(scope?.groups)
    .filter((g) => g && g.id && asList(g.locationIds).length > 0 && asList(g.locationIds).every((id) => known.has(id)))
    .slice()
    .sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name) || String(a.id).localeCompare(String(b.id)));
}

/**
 * Where the picker starts: level 'all' on All sites; anyone else on the signed in venue when it is
 * in their list, else their first site.
 */
export function defaultChoice(scope, homeId) {
  const home = asId(homeId);
  const sites = asList(scope?.sites);
  if (scope?.level === 'all' && sites.length > 1) return { kind: 'all' };
  if (home && openSite(scope, home)) return { kind: 'site', id: home };
  if (sites.length) return { kind: 'site', id: sites[0].id };
  return { kind: 'site', id: home };
}

/**
 * A choice that is still good for this scope, else the default. A site not in the list, a closed
 * site while closed sites are not shown (and not picked from the shown list), a group that is gone,
 * or anything that is not a choice falls back to defaultChoice. A one site company always resolves
 * to the signed in venue. All sites with one site in the list is that site.
 */
export function resolveChoice(scope, choice, homeId, { showClosed = false } = {}) {
  const home = asId(homeId);
  if (!scope || !scope.multi) return { kind: 'site', id: home };
  const fallback = defaultChoice(scope, home);
  if (!choice || typeof choice !== 'object') return fallback;
  if (choice.kind === 'all') {
    const sites = asList(scope.sites);
    return sites.length === 1 ? { kind: 'site', id: sites[0].id } : (sites.length ? { kind: 'all' } : fallback);
  }
  if (choice.kind === 'group') {
    const g = groupsFor(scope).find((x) => x.id === asId(choice.id));
    return g ? { kind: 'group', id: g.id } : fallback;
  }
  if (choice.kind === 'site') {
    const id = asId(choice.id);
    if (openSite(scope, id)) return { kind: 'site', id };
    if (closedSite(scope, id) && (showClosed || choice.closed === true)) return { kind: 'site', id, closed: true };
    return fallback;
  }
  return fallback;
}

/**
 * The sites a choice covers, as site objects, in the scope's order. opts: { showClosed, homeId }.
 * A one site company: its one site (the signed in venue).
 */
export function scopeSites(scope, choice, { showClosed = false, homeId = null } = {}) {
  if (!scope) return homeId ? [{ id: asId(homeId), name: '' }] : [];
  const open = asList(scope.sites);
  const closed = asList(scope.closedSites);
  if (!scope.multi) {
    const home = asId(homeId) || asId(scope.homeSite);
    const mine = home ? (openSite(scope, home) || closedSite(scope, home)) : null;
    return mine ? [mine] : open.slice(0, 1);
  }
  const c = resolveChoice(scope, choice, homeId ?? scope.homeSite, { showClosed });
  if (c.kind === 'all') return showClosed ? [...open, ...closed] : open.slice();
  if (c.kind === 'group') {
    const g = groupsFor(scope).find((x) => x.id === c.id);
    const ids = new Set(g ? g.locationIds : []);
    return [...open, ...(showClosed ? closed : [])].filter((s) => ids.has(s.id));
  }
  const one = openSite(scope, c.id) || closedSite(scope, c.id);
  return one ? [one] : [];
}

/**
 * The one site a screen works on, or null on All sites and groups.
 *   one site company, or no scope yet: { id: homeId } (the signed in venue, exactly today);
 *   a one site choice: that site; a login with one site in its list: that site; else null.
 */
export function oneSiteOf(scope, choice, homeId, { showClosed = false } = {}) {
  const home = asId(homeId);
  if (!scope || !scope.multi) {
    const known = home && scope ? (openSite(scope, home) || closedSite(scope, home)) : null;
    return known ? { ...known } : { id: home };
  }
  const c = resolveChoice(scope, choice, home, { showClosed });
  if (c.kind === 'site' && c.id) {
    const s = openSite(scope, c.id) || closedSite(scope, c.id);
    if (s) return { ...s };
  }
  const open = asList(scope.sites);
  if (open.length === 1) return { ...open[0] };
  return null;
}

/**
 * May this login change a COMPANY field from the screen of `sectionKey`?
 *   one site company: the Back Office section rule (exactly today's rights);
 *   multi site company: Stock control 'all' in this company (the server's level) and the section.
 * An owner of this company and ServOS staff are 'all' through the server and pass the section
 * rule as the database does (owners ignore a stored list).
 */
export function canEditCompany(scope, sectionKey, profileAccess) {
  if (!scope || !scope.multi) {
    const allowed = allowedKeys(profileAccess);
    return allowed === null || allowed.includes(sectionKey);
  }
  if (scope.level !== 'all') return false;
  if (scope.sections == null) return true;
  if (isEverythingRole(profileAccess?.role)) return true;
  return asList(scope.sections).includes(sectionKey);
}

/**
 * May this login change a SITE value at this site? 'site_facts' (par, reorder, min, area, counted
 * here): any level at a site in the list. 'site_price' (price here, supplier here, tick on, stop
 * ordering, pause there): a one site company, or 'sites_full' or 'all'.
 */
export function canEditSite(scope, siteId, what) {
  if (what !== 'site_facts' && what !== 'site_price') return false;
  if (!scope || !scope.multi) return true;
  const id = asId(siteId);
  if (!id || !(openSite(scope, id) || closedSite(scope, id))) return false;
  if (what === 'site_facts') return true;
  return scope.level === 'sites_full' || scope.level === 'all';
}

// ── remembered in the browser (never a rpos- key: those are purged on every venue switch) ─────────
const storeOf = (storage) => {
  if (storage) return storage;
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

/** Where the picker's choice is kept for one login in one company. */
export const choiceKey = (userId, orgId) => `servos-stock-sites:${userId}:${orgId}`;
/** Where the "can now be shared" banner's dismissal is kept. */
export const bannerKey = (userId, orgId) => `servos-stock-banner:${userId}:${orgId}`;

/** The stored choice, shape checked; null when there is none or it cannot be read. */
export function readChoice(userId, orgId, storage = null) {
  if (!userId || !orgId) return null;
  try {
    const s = storeOf(storage);
    const raw = s ? s.getItem(choiceKey(userId, orgId)) : null;
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (c && c.kind === 'all') return { kind: 'all' };
    if (c && (c.kind === 'group' || c.kind === 'site') && typeof c.id === 'string' && c.id) return { kind: c.kind, id: c.id };
    return null;
  } catch { return null; }
}

/** Keep the choice (without the closed flag). Never throws; true when it was written. */
export function writeChoice(userId, orgId, choice, storage = null) {
  if (!userId || !orgId || !choice || typeof choice !== 'object') return false;
  const keep = choice.kind === 'all' ? { kind: 'all' } : (choice.id ? { kind: choice.kind, id: String(choice.id) } : null);
  if (!keep || !['all', 'group', 'site'].includes(keep.kind)) return false;
  try {
    const s = storeOf(storage);
    if (!s) return false;
    s.setItem(choiceKey(userId, orgId), JSON.stringify(keep));
    return true;
  } catch { return false; }
}

/** When the banner was last dismissed (an ISO string), or null. */
export function readBannerDismissed(userId, orgId, storage = null) {
  if (!userId || !orgId) return null;
  try { const s = storeOf(storage); return (s && s.getItem(bannerKey(userId, orgId))) || null; } catch { return null; }
}

/** Remember the dismissal. Never throws. */
export function writeBannerDismissed(userId, orgId, atIso, storage = null) {
  if (!userId || !orgId) return false;
  try { const s = storeOf(storage); if (!s) return false; s.setItem(bannerKey(userId, orgId), String(atIso)); return true; } catch { return false; }
}

/**
 * Is the "Your stock can now be shared" banner due? Only for level 'all' in a multi site company,
 * when the company became multi site after the last dismissal (or it was never dismissed).
 */
export function bannerDue({ multi, level, multiSince, dismissedAt } = {}) {
  if (!multi || level !== 'all' || !multiSince) return false;
  const since = Date.parse(multiSince);
  if (!Number.isFinite(since)) return false;
  if (!dismissedAt) return true;
  const gone = Date.parse(dismissedAt);
  return !Number.isFinite(gone) || since > gone;
}

// ── words ──────────────────────────────────────────────────────────────────────────────────────

/** 'A', 'A and B', 'A, B and C' (joiner 'and' or 'or'). */
export function listWords(names, joiner = 'and') {
  const list = asList(names).map((n) => String(n ?? '').trim()).filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  return `${list.slice(0, -1).join(', ')} ${joiner} ${list[list.length - 1]}`;
}

/** Who to ask: 'head office', 'Jane Smith', 'Jane Smith or Tom Lee', 'Jane Smith, Tom Lee or Sam Ray'. */
export function editorsWords(editors) {
  return listWords(editors, 'or') || 'head office';
}

/**
 * The Sites cell (mockup sitesText): 'Local to <site>', 'None here', 'All 7' (or the one site's name
 * when the scope is one site), '<site>' when on at one, else '5 of 7'. Only sites in scope count.
 * siteById: a Map or an object of id to { name }.
 */
export function sitesText({ onIds, scopeIds, siteById, localId = null } = {}) {
  const nameOf = (id) => {
    if (!id) return '';
    const s = siteById instanceof Map ? siteById.get(id) : (siteById ? siteById[id] : null);
    return s?.name || '';
  };
  const scope = [...new Set(asList(scopeIds).map(asId).filter(Boolean))];
  const inScope = new Set(scope);
  const on = [...new Set(asList(onIds).map(asId).filter((id) => id && inScope.has(id)))];
  if (localId && on.length === 1) return `Local to ${nameOf(asId(localId)) || nameOf(on[0])}`;
  if (on.length === 0) return 'None here';
  if (on.length === scope.length) return scope.length === 1 ? nameOf(on[0]) : `All ${scope.length}`;
  if (on.length === 1) return nameOf(on[0]);
  return `${on.length} of ${scope.length}`;
}

/** What the picker is on: 'All sites', the group's name, or the site's name. */
export function scopeName(scope, choice, homeId = null) {
  if (!scope || !scope.multi) {
    const s = scopeSites(scope, null, { homeId });
    return s[0]?.name || '';
  }
  const c = resolveChoice(scope, choice, homeId ?? scope.homeSite, { showClosed: choice?.closed === true });
  if (c.kind === 'all') return 'All sites';
  if (c.kind === 'group') return groupsFor(scope).find((g) => g.id === c.id)?.name || 'All sites';
  return (openSite(scope, c.id) || closedSite(scope, c.id))?.name || '';
}

// ── the answer of useStockScope (StockScope.jsx adds the pieces that need React) ─────────────────

/** A login that opens everything: what a screen rendered with no provider uses (today's rule). */
const OPEN_ACCESS = Object.freeze({ role: 'owner', sections: null });

/**
 * Everything a stock screen reads from the picker, worked out once per render of the provider.
 * scope null = still loading (ready false, multi false: nothing new shows, nothing is hidden).
 * access undefined = no provider: everything editable by today's rule.
 */
export function scopeAnswer({ scope = null, choice = null, homeId = null, access, userId = null, showClosed = false } = {}) {
  const ready = !!scope && scope.ready !== false;
  const multi = ready && scope.multi === true;
  const home = asId(homeId) || asId(scope?.homeSite);
  const who = access === undefined ? OPEN_ACCESS : access;
  const resolved = multi ? resolveChoice(scope, choice, home, { showClosed }) : { kind: 'site', id: home };
  const sites = asList(scope?.sites);
  const closedSites = asList(scope?.closedSites);
  const siteById = new Map([...sites, ...closedSites].map((s) => [s.id, s]));
  const groups = groupsFor(scope);
  const group = resolved.kind === 'group' ? groups.find((g) => g.id === resolved.id) || null : null;
  const editors = asList(scope?.editors);
  const shownScope = ready ? scope : null;
  return {
    ready,
    failed: !!scope?.failed,
    multi,
    level: LEVELS.includes(scope?.level) ? scope.level : 'sites',
    orgId: scope?.orgId || null,
    userId: userId || null,
    homeSite: home,
    multiSince: scope?.multiSince || null,
    sites,
    closedSites,
    groups,
    editors,
    editorsText: editorsWords(editors),
    choice: resolved,
    scopeSites: scopeSites(shownScope, resolved, { showClosed, homeId: home }),
    oneSite: oneSiteOf(shownScope, resolved, home, { showClosed }),
    isAll: multi && resolved.kind === 'all',
    isGroup: multi && resolved.kind === 'group',
    group,
    siteById,
    siteName: (id) => siteById.get(asId(id))?.name || '',
    canEditCompany: (sectionKey) => canEditCompany(multi ? scope : null, sectionKey, who),
    canEditSite: (siteId, what) => canEditSite(multi ? scope : null, siteId, what),
  };
}

// ── the Someone saved first modal's words (SavedFirstModal.jsx) ─────────────────────────────────

/** 'Tom Lee' -> 'Tom'; nothing -> 'Someone'. */
export function firstNameOf(name) {
  const n = String(name ?? '').trim();
  return n ? n.split(/\s+/)[0] : 'Someone';
}

/** '2 minutes ago' within the hour ('just now', '1 minute ago'), 'at 14:05' after an hour. */
export function agoWords(atIso, nowMs = Date.now()) {
  const at = Date.parse(atIso);
  if (!Number.isFinite(at)) return 'just now';
  const mins = Math.floor((nowMs - at) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const d = new Date(at);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `at ${hh}:${mm}`;
}

/** The modal's title and first line from the rows that differ: { title, words, first }. */
export function savedFirstWords({ byName, at, rows, nowMs = Date.now() } = {}) {
  const who = String(byName ?? '').trim() || 'Someone';
  const list = asList(rows);
  const words = list.length === 1
    ? `${who} changed ${list[0].label} from ${list[0].from ?? list[0].mine} to ${list[0].theirs}.`
    : list.length > 1 ? `${who} changed ${list.length} things.` : `${who} saved this first.`;
  return { title: `${who} changed this ${agoWords(at, nowMs)}`, words, first: firstNameOf(who) };
}
