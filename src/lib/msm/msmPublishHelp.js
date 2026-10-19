// src/lib/msm/msmPublishHelp.js
//
// MULTI SITE MENU, ROUND 2 (17 Oct 2026, v5.11.75): small pure helpers for Review and publish, the
// foolproof layer (design 2 items 17 and 18, design 4, design 6.3 and 6.5). Tested
// (msmPublishHelp.test.js).
//   tradingWords     "Leeds is trading now (14:05 there). Headingley is not busy now (23:10 there)."
//   optionOffFix     the draft change behind "Turn the option off there too" on a health warning
//   healthProduct    which product a health line is about, for its [Open product] button

const listOf = (v) => (Array.isArray(v) ? v : []);

/** "14:05" from msm_sites_trading's local_time (a wall clock timestamp with no zone). */
export function clockOf(localTime) {
  const m = /[T ](\d{2}):(\d{2})/.exec(String(localTime || ''));
  return m ? `${m[1]}:${m[2]}` : null;
}

/**
 * Which sites of a publish are trading now, in words.
 *   rows       msm_sites_trading rows [{ location_id, trading, local_time }], or null (the read failed)
 *   siteNames  { loc: name }
 *   reach      the sites the publish reaches (all when empty)
 * Returns { busy: [names], quiet: [names], words } (words '' when nothing to say).
 */
export function tradingWords(rows, siteNames = {}, reach = []) {
  if (rows === null) return { busy: [], quiet: [], words: 'We could not check which sites are trading right now.' };
  const only = new Set(listOf(reach));
  const list = listOf(rows).filter((r) => !only.size || only.has(r.location_id));
  const busy = [], quiet = [];
  const parts = [];
  for (const r of list) {
    const name = siteNames[r.location_id] || 'One site';
    const at = clockOf(r.local_time);
    (r.trading ? busy : quiet).push(name);
    parts.push(`${name} ${r.trading ? 'is trading now' : 'is not busy now'}${at ? ` (${at} there)` : ''}`);
  }
  if (!parts.length) return { busy, quiet, words: '' };
  return { busy, quiet, words: `${parts.join('. ')}.` };
}

/**
 * "Turn the option off there too" for an option whose sub item is turned off at a site (health
 * warning option_inactive, which names the venue group and venue option ids).
 *   central   the group menu with the draft applied
 * Returns [changes] (an option site turned off), [] when none of them is the group menu's.
 */
export function optionOffFix(central, locationId, venueGroupId, venueOptionIds) {
  const gs = listOf(central?.groupSites).find((r) => r.location_id === locationId && r.venue_group_id === venueGroupId);
  if (!gs) return [];
  const ids = new Set(listOf(venueOptionIds));
  const groupOptions = new Set(listOf(central?.options).filter((o) => o.group_id === gs.group_id).map((o) => o.id));
  return listOf(central?.optionSites)
    .filter((os) => os.location_id === locationId && groupOptions.has(os.option_id) && os.venue_option_id && ids.has(os.venue_option_id) && os.active !== false)
    .map((os) => ({ target: 'modifier_option_site', entity_id: os.option_id, location_id: locationId, op: 'update', after: { active: false }, before: { active: true } }));
}

/** The group menu product a health line is about (null when it names none or it is not there). */
export function healthProduct(central, problem) {
  const id = problem && problem.productId;
  if (!id) return null;
  return listOf(central?.products).find((p) => p.id === id) || null;
}

// The draft fields that change what a delivery app shows (names, prices, option groups, VAT).
const MENU_FIELDS = new Set(['name', 'menu_name', 'description', 'default_price', 'default_channels', 'price', 'channel_prices', 'active', 'archived',
  'modifier_groups', 'tax_rate_name', 'tax_rate_percent', 'tax_by_type', 'image', 'category_id', 'min', 'max', 'selection_type', 'group_id', 'product_id', 'sub_group_id']);

/**
 * The HubRise reminder (design 1.8): HubRise keeps its own copy of a site's menu, so after a publish
 * that changes products, prices, option groups or VAT, the catalogue is pushed again at each site
 * that uses it. null when the draft changes nothing a delivery app shows.
 */
export function hubriseReminder(changes) {
  const hit = listOf(changes).some((c) => c && (c.op === 'create' || c.op === 'remove' || Object.keys(c.after || {}).some((k) => MENU_FIELDS.has(k))));
  if (!hit) return null;
  return 'Delivery apps through HubRise keep their own copy of the menu. After this is published, push the catalogue again at each site that uses HubRise (Back Office, Integrations, HubRise), so Deliveroo, Uber Eats and Just Eat show the same.';
}
