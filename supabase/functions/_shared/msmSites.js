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

import { newItemId, samePrice, keepsNoPrice, pricedBySizes, PUBLISHED_CHANNELS } from './msmModel.js';

const listOf = (v) => (Array.isArray(v) ? v : []);

/**
 * The changes that add a site.
 *   central   central state (live)
 *   opts      { locationId, venueMenuId (an existing venue menu to write into, or null to make one),
 *               prices: 'default' | 'copy', copyFrom (locationId), productIds (limit, default all) }
 * Returns { changes, count, optionCount, leftOut: [product names], words }.
 *
 * 18 Oct follow up: copying from a site where a product has NO price (it keeps "no price" and has no
 * price of its own for any order type) leaves that product out, in words: the new site would
 * otherwise sell it at the group price nobody set there. An option only sub item is never left out
 * (the options at the new site point at it; its own price is never charged), nor a product priced by
 * its sizes. A product with an order type price but no Standard price there goes with its order type
 * prices, and the words say its Standard price is the group's at the new site. Never a kept value on
 * these creates: a kept value on a site create is the Bring in sign (msmPlan).
 */
export function planAddSite(central, opts = {}) {
  const loc = opts.locationId;
  if (!loc) return { changes: [], count: 0, leftOut: [], words: 'Pick a site.' };
  if (listOf(central?.sites).some((s) => s.location_id === loc)) return { changes: [], count: 0, leftOut: [], words: 'That site is already in the group menu.' };
  const only = opts.productIds ? new Set(opts.productIds) : null;
  const copy = opts.prices === 'copy' && opts.copyFrom ? opts.copyFrom : null;
  const psFrom = new Map(listOf(central?.productSites).filter((r) => r.location_id === copy).map((r) => [r.product_id, r]));
  const changes = [{ target: 'menu_site', entity_id: central?.menu?.id || null, location_id: loc, op: 'create', after: { venue_menu_id: opts.venueMenuId || null } }];
  let count = 0;
  const leftOut = [];
  const standardOnlyGroup = [];
  const products = listOf(central?.products);
  for (const p of products) {
    if (p.archived) continue;
    // Round 2 (UI items 6 and 8, 17 Oct verification): there is no "site only extra". The old
    // site_only_location_id mark never leaves a product out: every product follows one rule.
    if (only && !only.has(p.id)) continue;
    const src = psFrom.get(p.id);
    if (copy && (!src || src.active === false)) continue;                          // copy what that site sells
    if (copy && keepsNoPrice(src) && src.price == null && !(p.type === 'subitem' && p.sold_alone !== true) && !pricedBySizes(p, products)) {
      const typePrice = PUBLISHED_CHANNELS.some((k) => src.channel_prices && src.channel_prices[k] != null);
      if (!typePrice) { leftOut.push(p.menu_name || p.name || 'A product'); continue; }
      standardOnlyGroup.push(p.menu_name || p.name || 'A product');
    }
    const price = copy && src && src.price != null && !samePrice(src.price, p.default_price) ? Number(src.price) : null;
    const channel = copy && src && src.channel_prices ? { ...src.channel_prices } : null;
    changes.push({
      target: 'product_site', entity_id: p.id, location_id: loc, op: 'create',
      after: { venue_item_id: newItemId(p, loc), active: true, price, channel_prices: channel },
    });
    // The old one site mark is cleared as the product goes on at another site (as msmEdit does).
    if (p.site_only_location_id && p.site_only_location_id !== loc) {
      changes.push({ target: 'product', entity_id: p.id, location_id: null, op: 'update', after: { site_only_location_id: null }, before: { site_only_location_id: p.site_only_location_id } });
    }
    count++;
  }
  // Round 2: every option of the option groups those products use (and the groups their options
  // ask next) gets a row at the new site, on (or as the copied site has it), since no row means
  // off. A group still waiting for its one time refresh has no option rows: it goes as round 1.
  const included = new Set(changes.filter((c) => c.target === 'product_site').map((c) => c.entity_id));
  const groupIds = new Set();
  for (const p of listOf(central?.products)) if (included.has(p.id)) for (const g of listOf(p.modifier_groups)) { const id = typeof g === 'string' ? g : g?.groupId; if (id) groupIds.add(id); }
  const options = listOf(central?.options).filter((o) => o && !o.archived);
  for (let grew = true, n = 0; grew && n < 10; n++) {
    grew = false;
    for (const o of options) if (groupIds.has(o.group_id) && o.sub_group_id && !groupIds.has(o.sub_group_id)) { groupIds.add(o.sub_group_id); grew = true; }
  }
  const osFrom = new Map(listOf(central?.optionSites).filter((r) => r.location_id === copy).map((r) => [r.option_id, r]));
  let optionCount = 0;
  for (const o of options) {
    if (!groupIds.has(o.group_id)) continue;
    const src = osFrom.get(o.id);
    const active = copy ? !!(src && src.active === true) : true;
    const price = copy && src && src.price != null && !samePrice(src.price, o.price) ? Number(src.price) : null;
    changes.push({ target: 'modifier_option_site', entity_id: o.id, location_id: loc, op: 'create', after: { active, price } });
    optionCount++;
  }
  const names = (xs) => (xs.length <= 3 ? xs.join(', ') : `${xs.slice(0, 3).join(', ')} and ${xs.length - 3} more`);
  const words = [`${count} product${count === 1 ? '' : 's'} will go on sale at the new site`];
  if (leftOut.length) words.push(`${leftOut.length} product${leftOut.length === 1 ? ' has' : 's have'} no price at the site you copy from, so ${leftOut.length === 1 ? 'it is' : 'they are'} left out: ${names(leftOut)}`);
  if (standardOnlyGroup.length) words.push(`${names(standardOnlyGroup)} ${standardOnlyGroup.length === 1 ? 'has' : 'have'} no Standard price there, so at the new site ${standardOnlyGroup.length === 1 ? 'it takes' : 'they take'} the group price`);
  return { changes, count, optionCount, leftOut, words: words.join('. ') };
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
