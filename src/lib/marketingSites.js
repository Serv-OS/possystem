// src/lib/marketingSites.js (6 Nov 2026, 5.12.69). PURE: no React, no Supabase; runs under node --test.
//
// THE RULE (Peter, 6 Nov 2026: "I need marketing to make sense from a multi site point of view ...
// a code made on one site can work on multiple sites, this needs logic behind it not just features"):
//
//   THE ORGANISATION OWNS, THE SITES USE.
//   Customers, loyalty, segments, campaigns, automations, offers and their codes, forms and the
//   website belong to the organisation (org_id). Every site sees every one of them, whichever site
//   the Back Office is signed in to. A site never owns a marketing thing; it can only be the place
//   a thing is aimed at ("Which sites") or the place a code was used.
//
// What this file keeps:
//   1. ONE WAY TO READ A THING'S SITES. rowSiteIds(kind, row): a campaign (schedule.location_ids),
//      an automation (entry_trigger.location_ids), an offer (venue_ids) and a form (location_id)
//      each carry their scope differently in the database; every screen asks here. Empty = every site.
//   2. ONE WAY TO FILTER. onSite(ids, siteId): the Sites control on a marketing page shows the things
//      aimed at that site or at every site. "All sites" shows everything.
//   3. ONE WAY TO NAME IT. siteBadge(ids, venues): "All sites" or the venue names, on every row.
//   4. THE CHOICE IS REMEMBERED per signed in venue (one key in the browser), starts on All sites
//      (the honest answer: the data is the whole organisation's), and never points at a venue the
//      company no longer has.
//   5. A NEW THING STARTS AIMED AT THE SITE YOU ARE LOOKING AT (defaultScope): on All sites it is
//      aimed at every site, on Leeds it is aimed at Leeds, one tap from All sites in the editor.

import { siteScopeIds, siteScopeLabel } from '../../supabase/functions/_shared/venueScope.js';

export const SHARED_NOTE = 'Marketing is shared across the organisation: customers, loyalty, segments, offers and codes, forms and the website belong to every site. Aim a send at some sites with Which sites.';

const KINDS = ['campaign', 'automation', 'offer', 'form'];
/** Automation triggers the engine never narrows by site (sign ups have no visits yet; manual and form
 *  enrolments are one person at a time), so a scope saved on them is not shown either. */
export const SCOPELESS_TRIGGERS = ['signup', 'manual', 'form_submitted'];

/** The venue ids a marketing thing is aimed at, whatever kind it is. Empty = every site. */
export function rowSiteIds(kind, row) {
  if (!row || typeof row !== 'object') return [];
  switch (kind) {
    case 'campaign': return siteScopeIds({ schedule: row.schedule });
    case 'automation': return SCOPELESS_TRIGGERS.includes(String(row.entry_trigger && row.entry_trigger.type || '')) ? [] : siteScopeIds({ entry_trigger: row.entry_trigger });
    case 'offer': return siteScopeIds({ location_ids: row.venue_ids });
    case 'form': return siteScopeIds({ location_ids: row.location_id ? [row.location_id] : [] });
    default: return [];
  }
}

/** Does a thing aimed at `ids` show when the Sites control is on `siteId`? '' or null = All sites. */
export function onSite(ids, siteId) {
  const site = String(siteId || '').trim().toLowerCase();
  if (!site) return true;
  const scope = siteScopeIds({ location_ids: ids });
  return scope.length === 0 || scope.includes(site);
}

/** The rows of one kind that show on the picked site, in their order. */
export function filterOnSite(kind, rows, siteId) {
  if (!KINDS.includes(kind)) throw new Error(`filterOnSite: unknown kind ${kind}`);
  return (Array.isArray(rows) ? rows : []).filter((r) => onSite(rowSiteIds(kind, r), siteId));
}

/** "All sites" or "Leeds, Hudds": the words on a row. */
export function siteBadge(ids, venues) { return siteScopeLabel(ids, venues); }

/** What a new thing is aimed at: the picked site, or every site. */
export function defaultScope(siteId) {
  const s = String(siteId || '').trim().toLowerCase();
  return s ? siteScopeIds({ location_ids: [s] }) : [];
}

/** The browser key the choice is remembered under: per signed in venue, so each login's company has its own. */
export const siteChoiceKey = (locId) => `rpos-mkt-site:${String(locId || '').trim() || 'none'}`;

/** The remembered choice, or '' (All sites) when there is none, it names a venue the company no longer has,
 *  or the company has one venue (no choice exists: a scope remembered before a venue closed must not stick). */
export function readSiteChoice(store, locId, venues) {
  if (!Array.isArray(venues) || venues.length < 2) return '';
  let raw = '';
  try { raw = String((store && store.getItem(siteChoiceKey(locId))) || ''); } catch { raw = ''; }
  const s = raw.trim().toLowerCase();
  if (!s) return '';
  const ok = (Array.isArray(venues) ? venues : []).some((v) => String(v && v.id || '').toLowerCase() === s);
  return ok ? s : '';
}

/** Remember the choice ('' = All sites). Never throws (a private window may refuse). */
export function writeSiteChoice(store, locId, siteId) {
  const s = String(siteId || '').trim().toLowerCase();
  try {
    if (!store) return;
    if (s) store.setItem(siteChoiceKey(locId), s); else store.removeItem(siteChoiceKey(locId));
  } catch { /* nothing to do: the choice lives for this page */ }
}

/** The venues a page shows in its Sites control: id + name, deduped, named. The control hides itself under 2. */
export function siteList(venues) {
  const out = [];
  const seen = new Set();
  for (const v of Array.isArray(venues) ? venues : []) {
    const id = String(v && (v.id || v.location_id) || '').trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: String(v.name || '').trim() || 'Unnamed site' });
  }
  return out;
}

/** The Marketing report's numbers for the picked site, from the By site split; null on All sites or an unknown site. */
export function siteReportRow(sitesReport, siteId) {
  const s = String(siteId || '').trim().toLowerCase();
  if (!s || !sitesReport || typeof sitesReport !== 'object') return null;
  const rows = Array.isArray(sitesReport.venues) ? sitesReport.venues : [];
  return rows.find((v) => String(v && v.location_id || '').toLowerCase() === s) || null;
}

/** The campaigns and automations with activity at the picked site: [{ key, name, kind, status?, v }]. */
export function siteReportRows(sitesReport, siteId) {
  const s = String(siteId || '').trim().toLowerCase();
  if (!s || !sitesReport || typeof sitesReport !== 'object') return [];
  const pick = (list, idKey, kind) => (Array.isArray(list) ? list : []).map((c) => ({
    key: c[idKey], name: c.name, kind, status: c.status,
    v: (Array.isArray(c.venues) ? c.venues : []).find((x) => String(x && x.location_id || '').toLowerCase() === s) || null,
  })).filter((x) => x.v);
  return [...pick(sitesReport.campaigns, 'campaign_id', 'Campaign'), ...pick(sitesReport.workflows, 'workflow_id', 'Automation')];
}
