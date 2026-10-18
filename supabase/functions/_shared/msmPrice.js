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
//
// ROUND 2 (17 Oct 2026, design 1.4 and 5.4)
//   * Option groups as a scope: an option's default price moves at Every site (sites with a
//     price of their own move too, or follow again when they end equal), or Only some sites get a
//     price of their own. The same maths. Free options (0.00) stay free on an amount change unless
//     the person says otherwise (keepFree, on unless false).
//   * An option only sub item (type subitem, not sold on its own) is never in a product scope: its
//     own price is never charged. A sub item sold on its own is a product like any other.
//   * alsoChannels: a Standard price change also moves every order type price that is SET (the
//     group's, or a site's own), one line per order type; prices that follow move by themselves.
//     A site's own order type price is cleared to follow only when what it would follow really is
//     the new value (the group's own order type price moving in the same run), never on a guess.
//   * An option with a minus price (it takes money off) is never moved: it is left as it is and
//     counted ("1 option that takes money off was left as it is").
//     The screen ticks it by default; off, the preview names the order types it will not reach.

import { CHANNELS, PUBLISHED_CHANNELS, toPence, fromPence, has, channelFallback } from './msmModel.js';

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
  const optionOnly = (p) => p.type === 'subitem' && p.sold_alone !== true;
  return [...out].filter((id) => byId.has(id) && !exclude.has(id) && byId.get(id).type !== 'variants' && !optionOnly(byId.get(id))).map((id) => byId.get(id));
}

/** The options a scope covers: scope.optionGroupIds (every option of those groups) and scope.optionIds. */
export function optionsInScope(central, scope = {}) {
  const groups = new Set(scope.optionGroupIds || []);
  const ids = new Set(scope.optionIds || []);
  if (!groups.size && !ids.size) return [];
  const liveGroup = new Set((central?.groups || []).filter((g) => g && !g.archived).map((g) => g.id));
  return (central?.options || []).filter((o) => o && !o.archived && liveGroup.has(o.group_id) && (groups.has(o.group_id) || ids.has(o.id)));
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
function runChannel(central, opts, channel, onlySet) {
  const rounding = opts.rounding || { mode: 'none' };
  const change = opts.change || { direction: 'up', mode: 'amount', value: 0 };
  const isSet = change.mode === 'set';
  const products = productsInScope(central, opts.scope || {});
  // onlySet: only the prices of this order type that are SET (alsoChannels), never those that follow.
  const setAnywhere = (p) => chanOf(p.default_channels, channel) != null || (central?.productSites || []).some((ps) => ps.product_id === p.id && chanOf(ps.channel_prices, channel) != null);
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
    if (channel || opts.alsoChannels) return [];
    const keys = [];
    for (const k of PUBLISHED_CHANNELS) {
      if (chanOf(ps ? ps.channel_prices : null, k) != null || chanOf(p.default_channels, k) != null) keys.push(k);
    }
    return keys;
  };

  for (const p of products) {
    if (onlySet && !setAnywhere(p)) continue;
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
      const skipGroup = onlySet && defOwn == null;
      const r = changeOne(groupEff, change, rounding);
      if (r.invalid) continue;
      const newDef = r.pence;
      if (r.clamped) clamped++;
      const defPinned = pinnedOf(p, null);
      if (!skipGroup) rows.push({ productId: p.id, locationId: null, channel, before: fromPence(groupEff), after: fromPence(newDef), changed: newDef !== groupEff, clamped: r.clamped, follows: false, clears: false, staged: false, off: false, pinned: defPinned });
      if (!skipGroup && (newDef !== groupEff || (channel && defOwn == null))) {
        const after = channel
          ? { default_channels: { ...(p.default_channels || {}), [channel]: fromPence(newDef) } }
          : { default_price: fromPence(newDef) };
        changes.push({ target: 'product', entity_id: p.id, location_id: null, op: 'update', after, _ch: channel });
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
        if (own == null && onlySet) continue;      // it follows: moved by the Standard price or the group's
        if (own == null && (fallback === groupEff || defOwn != null || !channel)) {
          if (off) continue;
          const after = newDef;
          rows.push({ productId: p.id, locationId: ps.location_id, channel, before: fromPence(before), after: fromPence(after), changed: after !== before, clamped: r.clamped, follows: true, clears: false, staged: false, off: false, pinned });
          if (after !== before) touchedSites.add(ps.location_id);
          continue;
        }
        if (before == null || Number.isNaN(before)) continue;
        let next, rc = false, clearIt = false;
        if (isSet) { next = newDef; clearIt = true; }
        else {
          const r2 = changeOne(before, change, rounding);
          next = r2.pence; rc = r2.clamped;
          // Back on the group's price: follow it again. In an "also order type prices" run that is
          // only true when the group has its OWN price for this order type and it moves here; with
          // none, a cleared site price falls back to the site's own Standard price, not newDef.
          if (next === newDef && (!onlySet || defOwn != null)) clearIt = true;
        }
        // Nothing to stage: no price of its own and the new group price is already what it charges.
        if (own == null && clearIt) {
          if (!off) rows.push({ productId: p.id, locationId: ps.location_id, channel, before: fromPence(before), after: fromPence(next), changed: next !== before, clamped: rc, follows: true, clears: false, staged: false, off: false, pinned });
          if (!off && next !== before) touchedSites.add(ps.location_id);
          continue;
        }
        if (rc && !off) clamped++;
        if (clearIt && own != null) clears++;
        rows.push({ productId: p.id, locationId: ps.location_id, channel, before: fromPence(before), after: fromPence(next), changed: next !== before || (clearIt && own != null), clamped: rc, follows: false, clears: clearIt && own != null, staged: true, off, pinned });
        if (off) offSites.add(ps.location_id);
        else touchedSites.add(ps.location_id);
        changes.push(siteChange(ps, channel, clearIt ? null : fromPence(next)));
      }
    } else {
      for (const loc of chosen) {
        const ps = psBy.get(`${p.id}|${loc}`);
        if (!ps || ps.active === false) continue;
        const own = siteOwn(ps);
        if (onlySet && own == null && defOwn == null) continue;   // follows the Standard price there
        const followVal = siteFallbackNow(ps);
        const before = own ?? followVal;
        if (before == null || Number.isNaN(before)) continue;
        const r = changeOne(before, change, rounding);
        if (r.invalid) continue;
        if (r.clamped) clamped++;
        // followVal is worked out from the site's Standard price BEFORE this change; in an "also order
        // type prices" run the Standard price moves too, so never clear to follow there.
        const clearIt = !onlySet && r.pence === followVal;
        const pinned = pinnedOf(p, ps);
        if (pinned.length) pinnedRows++;
        const willStage = !(r.pence === before && (clearIt ? own == null : own === r.pence));
        if (clearIt && own != null) clears++;
        rows.push({ productId: p.id, locationId: loc, channel, before: fromPence(before), after: fromPence(r.pence), changed: r.pence !== before, clamped: r.clamped, follows: clearIt, clears: clearIt && own != null, staged: willStage, off: false, pinned });
        if (!willStage) continue;
        touchedSites.add(loc);
        changes.push(siteChange(ps, channel, clearIt ? null : fromPence(r.pence)));
      }
    }
  }
  return { rows, changes, touchedSites, offSites, clears, clamped, pinnedRows, products: products.length };
}

/**
 * Work out a price change over a scope. Pure.
 *   central   { products, productSites, categories, sites, groups, options, optionSites }
 *   opts      { scope, change, rounding, channel (null = Standard), sites: 'all' | [locationIds],
 *               alsoChannels (Standard only: move the order type prices that are set too),
 *               keepFree (options: leave 0.00 options at 0.00 on an amount change; default on) }
 * Returns {
 *   rows:     every price shown in the preview: { productId | optionId, groupId?, locationId (null
 *             = the group's), channel (null = Standard), before, after, changed, clamped, follows,
 *             clears, staged, off, pinned, freeKept }
 *   changes:  msm_changes rows to stage ({ target, entity_id, location_id, op: 'update', after })
 *   summary:  { prices, sites, clears, clamped, products, offSites, pinned, options, freeKept }
 * }
 */
export function applyPriceChange(central, opts = {}) {
  const channel = opts.channel && CHANNELS.includes(opts.channel) ? opts.channel : null;
  const runs = [runChannel(central, opts, channel, false)];
  // Delivery is a platform price (UI issue 2): never moved here, never published.
  if (!channel && opts.alsoChannels) for (const k of PUBLISHED_CHANNELS) runs.push(runChannel(central, opts, k, true));
  const opt = runOptions(central, opts);
  const rows = [...runs.flatMap((r) => r.rows), ...opt.rows];
  // One change per product or site, every order type merged in (each run set only its own key).
  const merged = new Map();
  const productOf = new Map((central?.products || []).map((p) => [p.id, p]));
  const psOf = new Map((central?.productSites || []).map((ps) => [`${ps.product_id}|${ps.location_id}`, ps]));
  for (const c of [...runs.flatMap((r) => r.changes), ...opt.changes]) {
    const key = `${c.target}|${c.entity_id}|${c.location_id || ''}`;
    const m = merged.get(key) || { target: c.target, entity_id: c.entity_id, location_id: c.location_id ?? null, op: 'update', after: {} };
    for (const [k, v] of Object.entries(c.after)) {
      if (k === 'default_channels') m.after.default_channels = { ...(m.after.default_channels || productOf.get(c.entity_id)?.default_channels || {}), ...pickChanged(v, c._ch) };
      else if (k === 'channel_prices') m.after.channel_prices = { ...(m.after.channel_prices || psOf.get(`${c.entity_id}|${c.location_id}`)?.channel_prices || {}), ...pickChanged(v, c._ch) };
      else m.after[k] = v;
    }
    merged.set(key, m);
  }
  const touchedSites = new Set([...runs.flatMap((r) => [...r.touchedSites]), ...opt.touchedSites]);
  const offSites = new Set(runs.flatMap((r) => [...r.offSites]));
  const sum = (k) => runs.reduce((n, r) => n + r[k], 0);
  // The headline counts what reaches the tills: site prices on sale, never the group price row.
  const prices = rows.filter((r) => r.locationId && r.changed && !r.off).length;
  return {
    rows, changes: [...merged.values()],
    summary: {
      prices, sites: touchedSites.size, clears: sum('clears') + opt.clears, clamped: sum('clamped') + opt.clamped,
      products: runs[0].products, offSites: offSites.size, pinned: runs[0].pinnedRows, options: opt.count, freeKept: opt.freeKept, minusKept: opt.minusKept,
    },
  };
}
const pickChanged = (obj, ch) => (ch && obj && typeof obj === 'object' ? { [ch]: obj[ch] } : obj || {});

// Options (round 2): the same maths on msm_modifier_options.price and each site's own price.
function runOptions(central, opts) {
  const out = { rows: [], changes: [], touchedSites: new Set(), clears: 0, clamped: 0, count: 0, freeKept: 0, minusKept: 0 };
  const options = optionsInScope(central, opts.scope || {});
  if (!options.length) return out;
  const rounding = opts.rounding || { mode: 'none' };
  const change = opts.change || { direction: 'up', mode: 'amount', value: 0 };
  const isSet = change.mode === 'set';
  const keepFree = opts.keepFree !== false && change.mode === 'amount';
  const siteLocs = (central?.sites || []).map((s) => s.location_id);
  const allSites = opts.sites === 'all' || !Array.isArray(opts.sites);
  const chosen = allSites ? siteLocs : opts.sites.filter((l) => siteLocs.includes(l));
  const osBy = new Map((central?.optionSites || []).map((r) => [`${r.option_id}|${r.location_id}`, r]));
  const row = (o, loc, extra) => ({ optionId: o.id, groupId: o.group_id, locationId: loc, channel: null, pinned: [], ...extra });
  for (const o of options) {
    out.count++;
    const def = toPence(o.price ?? 0);
    // A minus price takes money off (design 1.4 keeps imported ones, "takes 0.50 off"): never
    // moved by a price change, which would clamp the discount to 0.00.
    const minus = (pence, loc, own) => { out.minusKept++; out.rows.push(row(o, loc, { before: fromPence(pence), after: fromPence(pence), changed: false, clamped: false, follows: own == null && loc != null, clears: false, staged: false, off: false, minusKept: true })); };
    if (allSites) {
      let newDef = def, rc = false;
      if (def < 0) minus(def, null, def);
      else if (keepFree && def === 0) out.freeKept++;
      else { const r = changeOne(def, change, rounding); if (r.invalid) continue; newDef = r.pence; rc = r.clamped; }
      if (rc) out.clamped++;
      out.rows.push(row(o, null, { before: fromPence(def), after: fromPence(newDef), changed: newDef !== def, clamped: rc, follows: false, clears: false, staged: newDef !== def, off: false, freeKept: keepFree && def === 0 }));
      if (newDef !== def) out.changes.push({ target: 'modifier_option', entity_id: o.id, location_id: null, op: 'update', after: { price: fromPence(newDef) } });
      for (const loc of siteLocs) {
        const os = osBy.get(`${o.id}|${loc}`);
        if (!os) continue;
        const off = os.active !== true;
        const own = os.price == null ? null : toPence(os.price);
        if (own != null && own < 0) { minus(own, loc, own); continue; }
        if (own == null && def < 0) continue;      // follows a minus default, which stays
        if (own == null) {
          if (!off) { out.rows.push(row(o, loc, { before: fromPence(def), after: fromPence(newDef), changed: newDef !== def, clamped: rc, follows: true, clears: false, staged: false, off: false })); if (newDef !== def) out.touchedSites.add(loc); }
          continue;
        }
        if (keepFree && own === 0) { out.freeKept++; out.rows.push(row(o, loc, { before: 0, after: 0, changed: false, clamped: false, follows: false, clears: false, staged: false, off, freeKept: true })); continue; }
        let next, c2 = false;
        if (isSet) next = newDef; else { const r2 = changeOne(own, change, rounding); next = r2.pence; c2 = r2.clamped; }
        const clearIt = next === newDef;
        if (c2 && !off) out.clamped++;
        if (clearIt) out.clears++;
        out.rows.push(row(o, loc, { before: fromPence(own), after: fromPence(next), changed: next !== own || clearIt, clamped: c2, follows: false, clears: clearIt, staged: true, off }));
        if (!off) out.touchedSites.add(loc);
        out.changes.push({ target: 'modifier_option_site', entity_id: o.id, location_id: loc, op: 'update', after: { price: clearIt ? null : fromPence(next) } });
      }
    } else {
      for (const loc of chosen) {
        const os = osBy.get(`${o.id}|${loc}`);
        if (!os || os.active !== true) continue;
        const own = os.price == null ? null : toPence(os.price);
        const before = own ?? def;
        if (before < 0) { minus(before, loc, own); continue; }
        if (keepFree && before === 0) { out.freeKept++; out.rows.push(row(o, loc, { before: 0, after: 0, changed: false, clamped: false, follows: own == null, clears: false, staged: false, off: false, freeKept: true })); continue; }
        const r = changeOne(before, change, rounding);
        if (r.invalid) continue;
        if (r.clamped) out.clamped++;
        const clearIt = r.pence === def;
        const willStage = !(r.pence === before && (clearIt ? own == null : own === r.pence));
        if (clearIt && own != null) out.clears++;
        out.rows.push(row(o, loc, { before: fromPence(before), after: fromPence(r.pence), changed: r.pence !== before, clamped: r.clamped, follows: clearIt, clears: clearIt && own != null, staged: willStage, off: false }));
        if (!willStage) continue;
        out.touchedSites.add(loc);
        out.changes.push({ target: 'modifier_option_site', entity_id: o.id, location_id: loc, op: 'update', after: { price: clearIt ? null : fromPence(r.pence) } });
      }
    }
  }
  return out;
}

function siteChange(ps, channel, value) {
  const after = channel
    ? { channel_prices: { ...(ps.channel_prices || {}), [channel]: value } }
    : { price: value };
  return { target: 'product_site', entity_id: ps.product_id, location_id: ps.location_id, op: 'update', after, _ch: channel };
}

/** The preview's headline: "84 prices change at 6 sites" (plus clears and clamps). */
export function priceChangeWords(summary) {
  const s = summary || {};
  const parts = [`${s.prices || 0} price${s.prices === 1 ? '' : 's'} change at ${s.sites || 0} site${s.sites === 1 ? '' : 's'}`];
  if (s.clears) parts.push(`clears ${s.clears} site price${s.clears === 1 ? '' : 's'}`);
  if (s.clamped) parts.push(`${s.clamped} would go below zero and stop at 0.00`);
  if (s.offSites) parts.push(`also keeps ${s.offSites} site${s.offSites === 1 ? '' : 's'} where it is off in step`);
  if (s.freeKept) parts.push(`${s.freeKept} free option price${s.freeKept === 1 ? '' : 's'} left at 0.00`);
  if (s.minusKept) parts.push(`${s.minusKept} option${s.minusKept === 1 ? '' : 's'} that take${s.minusKept === 1 ? 's' : ''} money off ${s.minusKept === 1 ? 'was' : 'were'} left as ${s.minusKept === 1 ? 'it is' : 'they are'}`);
  return parts.join(', ');
}
