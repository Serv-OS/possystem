// src/lib/stock/stockControlWords.js
//
// MULTI SITE STOCK, Drop 1 (migration 20261024a): who can do what with stock, in plain words.
//
//   Team (map 4.25, contract 3.5 and 4.4): the 'Stock control' line on a login card, its three
//   choices, and why a person may not change it. The level itself is the shared rule
//   stockLevelOf (supabase/functions/_shared/boSectionRules.js), the same one the database answers in
//   stock_level(p_uid, p_org): per company, owners of that company and ServOS staff always 'all'.
//   The database decides again in set_stock_control, whatever the screen shows.
//   Location settings: the Site groups card (who sees it, the editor's checks).
//
// Shown only in a multi site company: a one site company never sees any of this. Pure: unit tested
// in stockControlWords.test.js.

import { stockLevelOf } from '../../../supabase/functions/_shared/boSectionRules.js';

/** The three choices, lowest first, with the words under each. */
export const STOCK_CONTROL_CHOICES = Object.freeze([
  Object.freeze({ level: 'sites', label: 'Their sites', words: 'Counts, orders, deliveries, waste, transfers, batches and pars at their own sites, and local items.' }),
  Object.freeze({ level: 'sites_full', label: 'Their sites, full control', words: 'All of that, plus the price here and the supplier here at their own sites.' }),
  Object.freeze({ level: 'all', label: 'All sites', words: 'Edits the company stock list in the sections ticked above.' }),
]);

const LABELS = Object.freeze({ sites: 'Their sites', sites_full: 'Their sites, full control', all: 'All sites' });

/** A level in words: 'Their sites', 'Their sites, full control', 'All sites' (anything else: 'Their sites'). */
export function levelLabel(level) {
  return LABELS[level] || LABELS.sites;
}

/** The toast after a save: 'Stock control saved: Their sites, full control.' */
export function savedWords(level) {
  return `Stock control saved: ${levelLabel(level)}.`;
}

const sameOrg = (a, b) => typeof a === 'string' && typeof b === 'string' && a !== '' && a.toLowerCase() === b.toLowerCase();
const orgOf = (p) => (p.org_id !== undefined ? p.org_id : p.orgId);

/** Owner of THIS company, or ServOS staff (the database's 'owner' need). */
export function ownsCompany(profile, companyOrgId) {
  if (!profile || typeof profile !== 'object') return false;
  if (profile.role === 'super_admin') return true;
  return profile.role === 'owner' && sameOrg(orgOf(profile), companyOrgId);
}

const UNKNOWN = Object.freeze({ words: 'Not known', canChangeWhy: 'Could not read this login\'s Stock control. Reload the page.', level: null });

/**
 * The Stock control line of one login in the company being looked at.
 *   profile: the login's { role, org_id, stock_control } (org_id undefined: not read)
 *   companyOrgId: the company of the venue (orgCtx.venueOrgId), never the viewer's own org
 * Answer { words, canChangeWhy, level }: canChangeWhy is null when the login itself can be changed
 * (who is ASKING is checked by canChangeStockControl).
 */
export function stockControlLine({ profile, companyOrgId } = {}) {
  if (!profile || typeof profile !== 'object' || orgOf(profile) === undefined || !companyOrgId) return { ...UNKNOWN };
  if (profile.role === 'super_admin') return { words: 'All sites', canChangeWhy: 'ServOS staff always have All sites.', level: 'all' };
  if (!sameOrg(orgOf(profile), companyOrgId)) {
    return { words: 'Their sites (belongs to another company)', canChangeWhy: 'This login belongs to another company.', level: 'sites' };
  }
  if (profile.role === 'owner') return { words: 'All sites (owner)', canChangeWhy: 'An owner always has All sites.', level: 'all' };
  const level = stockLevelOf(profile, companyOrgId);
  return { words: levelLabel(level), canChangeWhy: null, level };
}

/**
 * May the person looking change this login's Stock control? The database rule (set_stock_control):
 * an owner of this company or ServOS staff, never their own login, only a login of this company
 * that is not an owner. Answer { ok, why } with the words shown when it is no.
 *   caller: { id, role, orgId }   target: { id, role, org_id, stock_control }
 */
export function canChangeStockControl({ caller, target, companyOrgId } = {}) {
  const line = stockControlLine({ profile: target, companyOrgId });
  if (line.canChangeWhy) return { ok: false, why: line.canChangeWhy };
  const me = caller || {};
  if (me.id && target && target.id === me.id) return { ok: false, why: 'This is your own login. You cannot change it.' };
  if (!ownsCompany(me, companyOrgId)) return { ok: false, why: 'Only the owner can change this.' };
  return { ok: true, why: null };
}

// -- Location settings: Site groups --------------------------------------------------------------

/** The Site groups card shows in a multi site company to owners of it and Stock control All sites. */
export function groupsCardShows(sc) {
  return !!(sc && sc.ready && sc.multi && sc.level === 'all');
}

/** A stock_co_site_groups row (or a scope group) as { id, name, locationIds, sortOrder, rowVersion }. */
export function groupFromRow(row) {
  const r = row || {};
  const ids = Array.isArray(r.location_ids) ? r.location_ids : Array.isArray(r.locationIds) ? r.locationIds : [];
  const rv = r.row_version ?? r.rowVersion;
  return {
    id: r.id || null, name: String(r.name || ''), locationIds: [...new Set(ids.filter(Boolean))],
    sortOrder: Number.isFinite(Number(r.sort_order ?? r.sortOrder)) ? Number(r.sort_order ?? r.sortOrder) : 0,
    rowVersion: rv == null ? null : Number(rv),
  };
}

/**
 * What stops a group being saved, in words, or null. The same checks the database makes
 * (stock_save_site_group): a name, at least one site, no second group of that name (case blind).
 */
export function groupProblem(draft, groups = []) {
  const name = String(draft?.name || '').trim();
  if (!name) return 'Give the group a name.';
  if (!(draft?.locationIds || []).filter(Boolean).length) return 'Pick at least one site.';
  const clash = (groups || []).map(groupFromRow).find((g) => g.id !== (draft.id || null) && g.name.trim().toLowerCase() === name.toLowerCase());
  if (clash) return `There is already a group called ${clash.name.trim()}.`;
  return null;
}

/** The p_group of stock_save_site_group: row_version only on an edit. */
export function groupSaveArg(draft, orgId) {
  const d = draft || {};
  const out = {
    org_id: orgId || null,
    name: String(d.name || '').trim(),
    location_ids: [...new Set((d.locationIds || []).filter(Boolean))],
    sort_order: Number.isFinite(Number(d.sortOrder)) ? Math.trunc(Number(d.sortOrder)) : 0,
  };
  if (d.id) { out.id = d.id; out.row_version = d.rowVersion == null ? null : Number(d.rowVersion); }
  return out;
}

/** A group's sites in words: 'North Site, South Site and 3 more' ('No sites' for none). */
export function groupSitesWords(group, siteName = (id) => id) {
  const names = (groupFromRow(group).locationIds).map((id) => siteName(id) || 'A closed site');
  if (!names.length) return 'No sites';
  if (names.length <= 3) return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}
