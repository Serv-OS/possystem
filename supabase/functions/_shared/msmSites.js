// supabase/functions/_shared/msmSites.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): a new site in minutes (design 4e), and saved site
// groups (design review: "Site B and Site C share 190 prices: make a group?"). Pure, tested
// (src/lib/msm/msmSites.test.js).
//
// ADD A SITE stages ONE change set: the site row, every product of the group menu on sale at that
// site, with the default prices or a copy of another site's (each copied price becomes an override
// only where it differs from the default). Publish then creates, in foreign key order, the venue
// menu, its categories (parents first), modifier group copies (options remapped to the new site's
// sub item ids), the products and the menu links (msmPlan.js). Tax is mapped by name and rate; a
// missing rate blocks the site with words.

import { newItemId, samePrice } from './msmModel.js';

const listOf = (v) => (Array.isArray(v) ? v : []);

/**
 * The changes that add a site.
 *   central   central state (live)
 *   opts      { locationId, venueMenuId (an existing venue menu to write into, or null to make one),
 *               prices: 'default' | 'copy', copyFrom (locationId), productIds (limit, default all) }
 * Returns { changes, count, words }.
 */
export function planAddSite(central, opts = {}) {
  const loc = opts.locationId;
  if (!loc) return { changes: [], count: 0, words: 'Pick a site.' };
  if (listOf(central?.sites).some((s) => s.location_id === loc)) return { changes: [], count: 0, words: 'That site is already in the group menu.' };
  const only = opts.productIds ? new Set(opts.productIds) : null;
  const copy = opts.prices === 'copy' && opts.copyFrom ? opts.copyFrom : null;
  const psFrom = new Map(listOf(central?.productSites).filter((r) => r.location_id === copy).map((r) => [r.product_id, r]));
  const changes = [{ target: 'menu_site', entity_id: central?.menu?.id || null, location_id: loc, op: 'create', after: { venue_menu_id: opts.venueMenuId || null } }];
  let count = 0;
  for (const p of listOf(central?.products)) {
    if (p.archived) continue;
    if (p.site_only_location_id && p.site_only_location_id !== loc) continue;      // another site's own extra
    if (only && !only.has(p.id)) continue;
    const src = psFrom.get(p.id);
    if (copy && (!src || src.active === false)) continue;                          // copy what that site sells
    const price = copy && src && src.price != null && !samePrice(src.price, p.default_price) ? Number(src.price) : null;
    const channel = copy && src && src.channel_prices ? { ...src.channel_prices } : null;
    changes.push({
      target: 'product_site', entity_id: p.id, location_id: loc, op: 'create',
      after: { venue_item_id: newItemId(p, loc), active: true, price, channel_prices: channel },
    });
    count++;
  }
  return { changes, count, words: `${count} product${count === 1 ? '' : 's'} will go on sale at the new site` };
}

/**
 * Sites that share most prices, for "make a group?" hints.
 *   central   central state
 *   min       the least number of shared override prices worth a hint
 * Returns [{ a, b, shared }], biggest first.
 */
export function groupHints(central, min = 20) {
  const byProduct = new Map();
  for (const ps of listOf(central?.productSites)) {
    if (ps.price == null) continue;
    if (!byProduct.has(ps.product_id)) byProduct.set(ps.product_id, []);
    byProduct.get(ps.product_id).push(ps);
  }
  const pairs = new Map();
  for (const rows of byProduct.values()) {
    for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
      if (!samePrice(rows[i].price, rows[j].price)) continue;
      const [a, b] = [rows[i].location_id, rows[j].location_id].sort();
      const k = `${a}|${b}`;
      pairs.set(k, (pairs.get(k) || 0) + 1);
    }
  }
  return [...pairs.entries()].map(([k, shared]) => { const [a, b] = k.split('|'); return { a, b, shared }; })
    .filter((x) => x.shared >= min).sort((x, y) => y.shared - x.shared);
}
