// src/lib/msm/msmTaxProfiles.js
//
// MULTI SITE MENU, TAX PROFILES (5.12.104). Peter, Mozz, 25 Nov 2026: the group menu's Tax view
// read "No tax rate" in every box, and the product sheet offered only old style rates, while every
// site charged through its "Prepared food" tax profile (8.45% at three sites, 9.45% at two).
// "this is confusing to customers. this needs fixing".
//
// THE RULE (the planner's, msmPlan taxProfileFor; the database's, 20261209a):
//   * a product's tax is a NAME and a percent. A name WITH a percent is a rate, as always.
//   * a name with NO percent is a TAX PROFILE: each site uses its OWN real profile of that name,
//     with its own rates. A generated copy of an old rate is never one.
//   * no name and no percent: each site's own tax decides (the item's category, then the site's
//     default profile). Nothing about tax is written at the sites.
//
// profilesByLoc: { [locationId]: { profiles: [tax_profiles rows, each with .lines], defaultProfileId } }
// A site missing from it has not been read: nothing is said about it.
//
// Pure, tested in msmTaxProfiles.test.js.

import { profileRateWords } from '../taxProfileWords.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const lower = (s) => String(s ?? '').trim().toLowerCase();

export const PROFILE_CHOICE = 'profile:';

/** A site's real, live tax profiles (never a generated copy of a rate). */
export function realProfiles(siteTax) {
  return listOf(siteTax?.profiles).filter((p) => p && p.active !== false && !(p.generated_from_rate_id ?? p.generatedFromRateId));
}

/** The ONE real profile of that name at a site, or null (none, or two of the same name). */
export function profileNamed(siteTax, name) {
  const n = lower(name);
  if (!n) return null;
  const hit = realProfiles(siteTax).filter((p) => lower(p.name) === n);
  return hit.length === 1 ? hit[0] : null;
}

/** A site's default profile when it is a real one (the site runs on tax profiles), else null. */
export function siteDefaultProfile(siteTax) {
  const id = siteTax?.defaultProfileId;
  return id ? realProfiles(siteTax).find((p) => String(p.id) === String(id)) || null : null;
}

/** Does any of these sites charge through a real default tax profile? */
export function groupRunsOnProfiles(profilesByLoc, siteIds) {
  return listOf(siteIds).some((loc) => !!siteDefaultProfile(profilesByLoc?.[loc]));
}

/** Is this product's tax a profile by name (a name, no percent)? */
export const isProfileTax = (product) => !!lower(product?.tax_rate_name) && (product.tax_rate_percent == null || product.tax_rate_percent === '');

/** "8.45%", or "8.45% at 3 sites, 9.45% at 2 sites" when the sites' profiles differ. */
function ratesAcross(found) {
  const by = new Map();
  for (const p of found) { const w = profileRateWords(p); by.set(w, (by.get(w) || 0) + 1); }
  const parts = [...by.entries()].sort((a, b) => b[1] - a[1]);
  if (parts.length === 1) return parts[0][0];
  return parts.map(([w, n]) => `${w} at ${n} site${n === 1 ? '' : 's'}`).join(', ');
}

/**
 * The tax profiles head office can pick, by name, from the sites' own real profiles, most sites
 * first: [{ name, value, label, sites, of }]. value is `profile:<name>`.
 */
export function profileChoices(profilesByLoc, siteIds) {
  const seen = new Map();
  const locs = listOf(siteIds).filter((loc) => profilesByLoc?.[loc]);
  for (const loc of locs) {
    const here = new Set();
    for (const p of realProfiles(profilesByLoc[loc])) {
      const k = lower(p.name);
      if (!k || here.has(k)) continue;
      here.add(k);
      // Two of one name at a site cannot be picked there: not counted for that site.
      if (!profileNamed(profilesByLoc[loc], p.name)) continue;
      if (!seen.has(k)) seen.set(k, { name: String(p.name).trim(), found: [] });
      seen.get(k).found.push(p);
    }
  }
  return [...seen.values()]
    .sort((a, b) => (b.found.length - a.found.length) || a.name.localeCompare(b.name))
    .map((t) => ({
      name: t.name, value: `${PROFILE_CHOICE}${t.name}`, sites: t.found.length, of: locs.length,
      label: `${t.name} (${ratesAcross(t.found)})${t.found.length < locs.length ? ` (at ${t.found.length} of ${locs.length} sites)` : ''}`,
    }));
}

/** The select value for a product's tax when it is a profile by name, else ''. */
export const profileChoiceOf = (product) => (isProfileTax(product) ? `${PROFILE_CHOICE}${String(product.tax_rate_name).trim()}` : '');
/** A picked `profile:<name>` back to its name, or null when the value is not one. */
export const choiceToProfile = (value) => (String(value || '').startsWith(PROFILE_CHOICE) ? String(value).slice(PROFILE_CHOICE.length) : null);

/** The sites (read here) that have no single real profile of that name: publish would block there. */
export function sitesMissingProfile(name, profilesByLoc, siteIds) {
  if (!lower(name)) return [];
  return listOf(siteIds).filter((loc) => profilesByLoc?.[loc] && !profileNamed(profilesByLoc[loc], name));
}

/**
 * What the Tax view shows for a product at one site, when tax profiles decide it. null when they do
 * not (the product has a rate, or the site has no real default profile): the old cell stands.
 *   { words, named, missing }
 *   named     the group menu names the profile (bold); false = the site's own default (grey)
 */
export function siteTaxCell(product, loc, profilesByLoc) {
  const site = profilesByLoc?.[loc];
  if (!site) return null;
  if (isProfileTax(product)) {
    const p = profileNamed(site, product.tax_rate_name);
    if (!p) return { words: `No "${String(product.tax_rate_name).trim()}" profile here`, named: true, missing: true };
    return { words: `${p.name} ${profileRateWords(p)}`, named: true, missing: false };
  }
  if (lower(product?.tax_rate_name) || !(product?.tax_rate_percent == null || product.tax_rate_percent === '')) return null;   // a rate
  const def = siteDefaultProfile(site);
  return def ? { words: `${def.name} ${profileRateWords(def)}`, named: false, missing: false } : null;
}

/**
 * The product sheet's "Try it" line at a site that charges through tax profiles (5.12.117).
 * Peter, Mozz, 26 Nov 2026: the box read "Mozz - Sandy has no tax rates set up. Add them in
 * Settings, Tax." in red. Sandy has four tax profiles and charges through them; it has no old
 * style rates because it does not need any. The box only knew rates.
 *   product    { name, tax_rate_name, tax_rate_percent } as the sheet holds it
 *   typeWord   "takeaway", "eat in", ... (the order type picked in the box)
 * Returns { ok, words }, or null when profiles do not decide this product there (the rate rule stands).
 */
export function profileExample({ product, loc, profilesByLoc, siteName = 'this site', typeWord = '' }) {
  const cell = siteTaxCell(product, loc, profilesByLoc);
  if (!cell) return null;
  const who = product?.name || 'This product';
  if (cell.missing) {
    return { ok: false, words: `${siteName} has no tax profile called "${String(product.tax_rate_name).trim()}". Add it in that site's Tax settings, or that site cannot be published.` };
  }
  return { ok: true, words: `${who}${typeWord ? `, ${typeWord}` : ''} at ${siteName}: charged on ${cell.named ? 'the' : "the site's own"} tax profile, ${cell.words}.` };
}

/** The group column of the Tax view when tax profiles decide: { words, named } or null. */
export function groupTaxCell(product, profilesByLoc, siteIds) {
  if (isProfileTax(product)) return { words: `${String(product.tax_rate_name).trim()} profile`, named: true };
  if (lower(product?.tax_rate_name) || !(product?.tax_rate_percent == null || product.tax_rate_percent === '')) return null;
  return groupRunsOnProfiles(profilesByLoc, siteIds) ? { words: "Each site's own", named: false } : null;
}

/** tax_profiles + tax_profile_lines rows and each site's default, as profilesByLoc. */
export function assembleProfilesByLoc(siteIds, profileRows, lineRows, locationRows) {
  const out = {};
  for (const loc of listOf(siteIds)) out[loc] = { profiles: [], defaultProfileId: null };
  const linesBy = new Map();
  for (const l of listOf(lineRows)) { if (!l) continue; const k = String(l.profile_id); if (!linesBy.has(k)) linesBy.set(k, []); linesBy.get(k).push(l); }
  for (const p of listOf(profileRows)) {
    if (!p || !out[p.location_id]) continue;
    const lines = (linesBy.get(String(p.id)) || []).sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
    out[p.location_id].profiles.push({ ...p, lines });
  }
  for (const l of listOf(locationRows)) if (l && out[l.id]) out[l.id].defaultProfileId = l.default_tax_profile_id ?? null;
  return out;
}
