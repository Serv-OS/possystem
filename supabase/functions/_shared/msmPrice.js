// supabase/functions/_shared/msmPrice.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): the Change prices tool's maths. Pure, tested
// (src/lib/msm/msmPrice.test.js). The screen previews with it and stages its result.
//
// Peter, 17 Oct 2026: one Change prices tool: a product, a category or the whole menu; up or
// down by pounds or percent; all sites or chosen sites.
//
// THE RULES (design 4b, plus review nit 10)
//   * Work in whole pence. Percent: price x (1 +/- p/100), half up.
//   * All sites: the default price changes; every site that follows the default moves with it
//     (no new rows); every site override changes too. "Set to" at all sites sets the default
//     and CLEARS every override in scope (the preview counts them: "clears 14 site prices").
//   * Chosen sites: the default stays. Each chosen site's price is worked out from its current
//     price (its override, or the default) and stored as its override.
//   * An override that ends equal to the default is cleared (the site follows the default).
//   * Rounding never goes against the change: an increase never ends below the old price, a
//     decrease never above it. Ties round up.
//   * Never below zero: clamped to 0.00 and flagged.
//   * Set to: the exact price; rounding is not applied to an exact price.
//   * Sizes follow their product unless excluded. A variants parent (whose own price is never
//     charged) and an archived product are never changed.

import { CHANNELS, toPence, fromPence, has, channelFallback } from './msmModel.js';

// ── Rounding ────────────────────────────────────────────────────────────────

// Nearest price whose last digit (of the pence) is in `endings`. Ties go up.
function nearestEnding(p, endings) {
  const ends = [...new Set((endings || []).map((d) => Number(d)).filter((d) => d >= 0 && d <= 9))];
  if (!ends.length) return p;
  let best = null, bestDist = Infinity;
  for (let q = p - 10; q <= p + 10; q++) {
    if (q < 0) continue;
    if (!ends.includes(((q % 10) + 10) % 10)) continue;
    const d = Math.abs(q - p);
    if (d < bestDist || (d === bestDist && q > best)) { best = q; bestDist = d; }
  }
  return best == null ? p : best;
}

// The next allowed price above (dir +1) or below (dir -1) `p`, for the never against rule.
function stepAllowed(p, rounding, dir) {
  for (let q = p + dir, i = 0; i < 20; q += dir, i++) {
    if (q < 0) return 0;
    if (allowed(q, rounding)) return q;
  }
  return p;
}

function allowed(p, rounding) {
  if (!rounding || rounding.mode === 'none' || !rounding.mode) return true;
  if (rounding.mode === '5p') return p % 5 === 0;
  if (rounding.mode === 'ending') return (rounding.endings || []).map(Number).includes(p % 10);
  return true;
}

/**
 * Round `p` (pence) by `rounding` ({ mode: 'none' | '5p' | 'ending', endings: [0,5,9] }), never
 * against the change: `dir` is +1 for an increase, -1 for a decrease, `oldP` the price before.
 */
export function roundPence(p, rounding, dir, oldP) {
  let q = p;
  const mode = rounding?.mode || 'none';
  if (mode === '5p') q = Math.floor((p + 2.5) / 5) * 5;          // nearest 5p, ties up
  else if (mode === 'ending') q = nearestEnding(p, rounding.endings);
  if (oldP != null && dir > 0 && q < oldP) q = allowed(oldP, rounding) ? oldP : stepAllowed(oldP, rounding, +1);
  if (oldP != null && dir < 0 && q > oldP) q = allowed(oldP, rounding) ? oldP : stepAllowed(oldP, rounding, -1);
  return q;
}

/**
 * One price changed. Returns { pence, clamped }.
 *   oldP     pence before
 *   change   { direction: 'up' | 'down', mode: 'amount' | 'percent' | 'set', value }
 *            value: pounds for amount and set, a percent for percent.
 */
export function changeOne(oldP, change, rounding) {
  const mode = change?.mode || 'amount';
  if (mode === 'set') {
    const p = toPence(change.value);
    if (p === null || Number.isNaN(p)) return { pence: oldP, clamped: false, invalid: true };
    return p < 0 ? { pence: 0, clamped: true } : { pence: p, clamped: false };
  }
  const dir = change?.direction === 'down' ? -1 : 1;
  let raw;
  if (mode === 'percent') {
    // The direction says up or down; a minus sign typed into the box never flips it.
    const pct = Math.abs(Number(change.value));
    if (!Number.isFinite(pct)) return { pence: oldP, clamped: false, invalid: true };
    const exact = oldP * (1 + dir * pct / 100);
    raw = Math.floor(exact + 0.5 + 1e-9);                         // half up
  } else {
    const d = toPence(change.value);
    if (d === null || Number.isNaN(d)) return { pence: oldP, clamped: false, invalid: true };
    raw = oldP + dir * Math.abs(d);
  }
  let q = roundPence(raw, rounding, dir, oldP);
  if (q < 0) return { pence: 0, clamped: true };
  return { pence: q, clamped: false };
}

// ── Which products ──────────────────────────────────────────────────────────

/**
 * The products a scope covers. scope = { all, productIds, categoryIds, includeSizes = true,
 * excludeIds }. Categories include their sub categories. Archived products and variants
 * parents are left out.
 */
export function productsInScope(central, scope = {}) {
  const products = (central?.products || []).filter((p) => p && !p.archived);
  const cats = central?.categories || [];
  const out = new Set();
  const exclude = new Set(scope.excludeIds || []);
  if (scope.all) products.forEach((p) => out.add(p.id));
  for (const id of scope.productIds || []) out.add(id);
  if ((scope.categoryIds || []).length) {
    const wanted = new Set(scope.categoryIds);
    let grew = true;
    while (grew) {
      grew = false;
      for (const c of cats) if (c.parent_id && wanted.has(c.parent_id) && !wanted.has(c.id)) { wanted.add(c.id); grew = true; }
    }
    for (const p of products) if (wanted.has(p.category_id) || (p.extra_category_ids || []).some((c) => wanted.has(c))) out.add(p.id);
  }
  if (scope.includeSizes !== false) {
    for (const p of products) if (p.parent_product_id && out.has(p.parent_product_id)) out.add(p.id);
  }
  const byId = new Map(products.map((p) => [p.id, p]));
  return [...out].filter((id) => byId.has(id) && !exclude.has(id) && byId.get(id).type !== 'variants').map((id) => byId.get(id));
}

// ── The tool ────────────────────────────────────────────────────────────────

const chanOf = (obj, k) => (obj && has(obj, k) && obj[k] != null ? obj[k] : null);
const pence = (pounds) => (pounds == null ? null : toPence(pounds));

/**
 * Work out a price change over a scope. Pure.
 *   central   { products, productSites, categories, sites }
 *   opts      { scope, change, rounding, channel (null = In store), sites: 'all' | [locationIds] }
 * Returns {
 *   rows:     every price shown in the preview: { productId, locationId (null = the default),
 *             before, after, changed, clamped, follows (site follows the default), clears,
 *             staged (a change row was staged for it: it can be unticked), off (the product is
 *             turned off there: kept in step, not counted), pinned (In store change only: the
 *             channel prices set separately for it, which the till charges first and which stay) }
 *   changes:  msm_changes rows to stage ({ target, entity_id, location_id, op: 'update', after })
 *   summary:  { prices, sites, clears, clamped, products, offSites, pinned }
 * }
 */
export function applyPriceChange(central, opts = {}) {
  const channel = opts.channel && CHANNELS.includes(opts.channel) ? opts.channel : null;
  const rounding = opts.rounding || { mode: 'none' };
  const change = opts.change || { direction: 'up', mode: 'amount', value: 0 };
  const isSet = change.mode === 'set';
  const products = productsInScope(central, opts.scope || {});
  const siteLocs = (central?.sites || []).map((s) => s.location_id);
  const allSites = opts.sites === 'all' || !Array.isArray(opts.sites);
  const chosen = allSites ? siteLocs : opts.sites.filter((l) => siteLocs.includes(l));
  const psBy = new Map();
  for (const ps of central?.productSites || []) psBy.set(`${ps.product_id}|${ps.location_id}`, ps);

  const rows = [];
  const changes = [];
  const touchedSites = new Set();
  const offSites = new Set();
  let clears = 0, clamped = 0, pinnedRows = 0;

  // The channel prices set separately (In store changes only): the till charges these first.
  const pinnedOf = (p, ps) => {
    if (channel) return [];
    const keys = [];
    for (const k of CHANNELS) {
      if (chanOf(ps ? ps.channel_prices : null, k) != null || chanOf(p.default_channels, k) != null) keys.push(k);
    }
    return keys;
  };

  for (const p of products) {
    const defBase = toPence(p.default_price);
    // The group's price for the chosen channel: its own, else what it falls back to (the till's chain).
    const defOwn = channel ? toPence(chanOf(p.default_channels, channel)) : defBase;
    const groupEff = channel ? pence(channelFallback(p, null, channel)) : defBase;
    const siteRows = siteLocs.map((loc) => psBy.get(`${p.id}|${loc}`)).filter(Boolean);
    const siteOwn = (ps) => (channel ? toPence(chanOf(ps.channel_prices, channel)) : toPence(ps.price));
    // What a site charges with no price of its own for the chosen channel, today.
    const siteFallbackNow = (ps) => (channel ? pence(channelFallback(p, ps, channel)) : defBase);

    if (allSites) {
      if (groupEff == null || Number.isNaN(groupEff)) continue;
      const r = changeOne(groupEff, change, rounding);
      if (r.invalid) continue;
      const newDef = r.pence;
      if (r.clamped) clamped++;
      const defPinned = pinnedOf(p, null);
      rows.push({ productId: p.id, locationId: null, before: fromPence(groupEff), after: fromPence(newDef), changed: newDef !== groupEff, clamped: r.clamped, follows: false, clears: false, staged: false, off: false, pinned: defPinned });
      if (newDef !== groupEff || (channel && defOwn == null)) {
        const after = channel
          ? { default_channels: { ...(p.default_channels || {}), [channel]: fromPence(newDef) } }
          : { default_price: fromPence(newDef) };
        changes.push({ target: 'product', entity_id: p.id, location_id: null, op: 'update', after });
      }
      for (const ps of siteRows) {
        // A site where the product is turned off is kept in step too (its own price changes or
        // clears like any other), so turning it back on never brings back an old price.
        const off = ps.active === false;
        const own = siteOwn(ps);
        const fallback = siteFallbackNow(ps);
        const before = own ?? fallback;
        const pinned = pinnedOf(p, ps);
        if (pinned.length && !off) pinnedRows++;
        // A site with no price of its own FOLLOWS the group only when what it falls back to is
        // the group's price. A channel the group never priced falls back to the site's own In
        // store price (or takeaway, for drive thru): staging the group's channel price would
        // replace that, so such a site is treated as having its own price.
        if (own == null && (fallback === groupEff || defOwn != null || !channel)) {
          if (off) continue;
          const after = newDef;
          rows.push({ productId: p.id, locationId: ps.location_id, before: fromPence(before), after: fromPence(after), changed: after !== before, clamped: r.clamped, follows: true, clears: false, staged: false, off: false, pinned });
          if (after !== before) touchedSites.add(ps.location_id);
          continue;
        }
        if (before == null || Number.isNaN(before)) continue;
        let next, rc = false, clearIt = false;
        if (isSet) { next = newDef; clearIt = true; }
        else {
          const r2 = changeOne(before, change, rounding);
          next = r2.pence; rc = r2.clamped;
          if (next === newDef) clearIt = true;
        }
        // Nothing to stage: no price of its own and the new group price is already what it charges.
        if (own == null && clearIt) {
          if (!off) rows.push({ productId: p.id, locationId: ps.location_id, before: fromPence(before), after: fromPence(next), changed: next !== before, clamped: rc, follows: true, clears: false, staged: false, off: false, pinned });
          if (!off && next !== before) touchedSites.add(ps.location_id);
          continue;
        }
        if (rc && !off) clamped++;
        if (clearIt && own != null) clears++;
        rows.push({ productId: p.id, locationId: ps.location_id, before: fromPence(before), after: fromPence(next), changed: next !== before || (clearIt && own != null), clamped: rc, follows: false, clears: clearIt && own != null, staged: true, off, pinned });
        if (off) offSites.add(ps.location_id);
        else touchedSites.add(ps.location_id);
        changes.push(siteChange(ps, channel, clearIt ? null : fromPence(next)));
      }
    } else {
      for (const loc of chosen) {
        const ps = psBy.get(`${p.id}|${loc}`);
        if (!ps || ps.active === false) continue;
        const own = siteOwn(ps);
        const followVal = siteFallbackNow(ps);
        const before = own ?? followVal;
        if (before == null || Number.isNaN(before)) continue;
        const r = changeOne(before, change, rounding);
        if (r.invalid) continue;
        if (r.clamped) clamped++;
        const clearIt = r.pence === followVal;
        const pinned = pinnedOf(p, ps);
        if (pinned.length) pinnedRows++;
        const willStage = !(r.pence === before && (clearIt ? own == null : own === r.pence));
        if (clearIt && own != null) clears++;
        rows.push({ productId: p.id, locationId: loc, before: fromPence(before), after: fromPence(r.pence), changed: r.pence !== before, clamped: r.clamped, follows: clearIt, clears: clearIt && own != null, staged: willStage, off: false, pinned });
        if (!willStage) continue;
        touchedSites.add(loc);
        changes.push(siteChange(ps, channel, clearIt ? null : fromPence(r.pence)));
      }
    }
  }
  // The headline counts what reaches the tills: site prices on sale, never the group price row.
  const prices = rows.filter((r) => r.locationId && r.changed && !r.off).length;
  return {
    rows, changes,
    summary: { prices, sites: touchedSites.size, clears, clamped, products: products.length, offSites: offSites.size, pinned: pinnedRows },
  };
}

function siteChange(ps, channel, value) {
  const after = channel
    ? { channel_prices: { ...(ps.channel_prices || {}), [channel]: value } }
    : { price: value };
  return { target: 'product_site', entity_id: ps.product_id, location_id: ps.location_id, op: 'update', after };
}

/** The preview's headline: "84 prices change at 6 sites" (plus clears and clamps). */
export function priceChangeWords(summary) {
  const s = summary || {};
  const parts = [`${s.prices || 0} price${s.prices === 1 ? '' : 's'} change at ${s.sites || 0} site${s.sites === 1 ? '' : 's'}`];
  if (s.clears) parts.push(`clears ${s.clears} site price${s.clears === 1 ? '' : 's'}`);
  if (s.clamped) parts.push(`${s.clamped} would go below zero and stop at 0.00`);
  if (s.offSites) parts.push(`also keeps ${s.offSites} site${s.offSites === 1 ? '' : 's'} where it is off in step`);
  return parts.join(', ');
}
