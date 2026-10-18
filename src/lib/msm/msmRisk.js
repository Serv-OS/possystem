// src/lib/msm/msmRisk.js
//
// MULTI SITE MENU, ROUND 2 (17 Oct 2026, v5.11.75): the warnings that need a TICK before "Add to
// draft" or "Publish" (design 6.5; Peter: "a bit more idiot proof"). Pure, tested
// (msmRisk.test.js). The screen shows the list as tick boxes and keeps the button grey until
// every one is ticked.
//
// THE RISKS
//   big_price        a price moves MORE than 20% either way (exactly 20% needs no tick)
//   zero_price       a product price set to 0.00, or an option that was above 0.00 set to 0.00
//   vat              any change to a product's VAT or its VAT by order type, or a site giving back
//                    (or keeping) its own VAT by order type
// Each tick's key holds the NEW value, so changing a price or VAT again after ticking it needs a new
// tick (round 2 review: the tick must prove the person saw the number).
//   removes_seller   turning off or removing a product that sold at that site in the last 7 days
//   trading          Publish now while any site of the publish is trading
//   overwrites       changes made at a site that this publish will overwrite (drift left unsettled)
//   made_required    an option group made "must choose" on products that sold in the last 7 days
// When the sales or trading read failed, the risk is shown anyway: "We could not check sales, so
// please check."

import { money2, toPence, has, channelFallback, PUBLISHED_CHANNELS, ORDER_TYPE_TAX_KEYS } from '../../../supabase/functions/_shared/msmModel.js';
import { effectiveTaxByType } from '../../../supabase/functions/_shared/msmTax.js';
import { isOptionOnlyItem } from '../menuRules.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const TAX_WORDS = { 'dine-in': 'Eat in', takeaway: 'Takeaway', delivery: 'Delivery', bar: 'Bar tab' };
const PRICE_WORDS = { dineIn: 'eat in', takeaway: 'takeaway', collection: 'collection', delivery: 'delivery', driveThru: 'drive thru' };
const json = (v) => JSON.stringify(v ?? null);
const rateWords = (r) => (r ? `${r.name}${r.percent != null ? ` (${Number(r.percent)}%)` : ''}` : 'the product\'s own VAT');

/** Is a move from `before` to `after` (pence) more than 20%? Exactly 20% is not. */
export function moreThan20(before, after) {
  if (before == null || after == null || Number.isNaN(before) || Number.isNaN(after)) return false;
  if (before === 0) return after !== 0;
  return Math.abs(after - before) * 5 > Math.abs(before);
}

/**
 * The risks of a set of changes.
 *   changes  msm_changes rows (with before)
 *   central  the live central menu
 *   sold     Map(`${loc}|${venueItemId}` -> count sold in the last 7 days), or null when that read failed
 *   trading  [{ location_id, trading }] or null when that read failed
 *   opts     { siteNames, publishNow: bool, sitesReached: [loc], drift: { [loc]: count },
 *              ratesByLoc: { [loc]: tax_rates rows } (optional: names a site's own rate) }
 *   central may be the menu before these changes (the sheets) or after them (Publish): a "before"
 *   the change row does not carry is read from the list's own product and option changes first.
 * Returns [{ code, key, words, action? }].
 */
export function riskChecks(changes, central, sold = null, trading = null, opts = {}) {
  const C = central || {};
  const out = [];
  const seen = new Set();
  const add = (code, key, words, extra = {}) => { const k = `${code}|${key}`; if (seen.has(k)) return; seen.add(k); out.push({ code, key: k, words, ...extra }); };
  const siteName = (loc) => (opts.siteNames instanceof Map ? opts.siteNames.get(loc) : opts.siteNames?.[loc]) || 'a site';
  const product = new Map(listOf(C.products).map((p) => [p.id, p]));
  const option = new Map(listOf(C.options).map((o) => [o.id, o]));
  const group = new Map(listOf(C.groups).map((g) => [g.id, g]));
  const ps = new Map(listOf(C.productSites).map((r) => [`${r.product_id}|${r.location_id}`, r]));
  const pName = (id) => product.get(id)?.menu_name || product.get(id)?.name || 'A product';
  const soldAt = (loc, pid) => {
    const row = ps.get(`${pid}|${loc}`);
    if (!row || !sold) return null;
    return Number(sold.get(`${loc}|${row.venue_item_id}`) || 0);
  };
  // The group price and an option's price before and after, from the list's own changes first (so a
  // site that follows reads the right one whichever menu `central` is).
  const defBefore = new Map(), defAfter = new Map(), optBefore = new Map(), optAfter = new Map(), chBefore = new Map();
  for (const ch of listOf(changes)) {
    const a = ch.after || {}, b = ch.before || {};
    if (ch.target === 'product' && has(a, 'default_price')) { if (has(b, 'default_price') && b.default_price != null) defBefore.set(ch.entity_id, b.default_price); defAfter.set(ch.entity_id, a.default_price); }
    if (ch.target === 'product' && has(a, 'default_channels') && has(b, 'default_channels')) chBefore.set(ch.entity_id, b.default_channels || {});
    if (ch.target === 'modifier_option' && has(a, 'price')) { if (has(b, 'price') && b.price != null) optBefore.set(ch.entity_id, b.price); optAfter.set(ch.entity_id, a.price); }
  }
  const dB = (pid) => (defBefore.has(pid) ? defBefore.get(pid) : product.get(pid)?.default_price);
  const dA = (pid) => (defAfter.has(pid) ? defAfter.get(pid) : product.get(pid)?.default_price);
  const oB = (oid) => (optBefore.has(oid) ? optBefore.get(oid) : option.get(oid)?.price);
  const oA = (oid) => (optAfter.has(oid) ? optAfter.get(oid) : option.get(oid)?.price);
  const rateName = (loc, id) => {
    const r = listOf(opts.ratesByLoc?.[loc]).find((x) => x && String(x.id) === String(id));
    return r ? `${r.name}${r.rate != null ? ` (${Number(r.rate)}%)` : ''}` : null;
  };
  for (const ch of listOf(changes)) {
    const a = ch.after || {}, b = ch.before || {};
    // Prices. The key holds the new price: a new price needs a new tick.
    const priceRisk = (who, where, was, now) => {
      const x = toPence(was), y = toPence(now);
      if (x == null || y == null || Number.isNaN(x) || Number.isNaN(y)) return;
      if (y === 0 && x > 0) add('zero_price', `${who}|${where}|${y}`, `${who} would be free (0.00) ${where}.`);
      else if (moreThan20(x, y)) {
        const pct = Math.round((Math.abs(y - x) * 100) / Math.max(1, x));
        add('big_price', `${who}|${where}|${y}`, `${who} goes from ${money2(was)} to ${money2(now)} ${where} (${y > x ? 'up' : 'down'} ${pct}%). I meant this.`);
      }
    };
    if (ch.target === 'product' && 'default_price' in a && ch.op !== 'create') priceRisk(pName(ch.entity_id), 'at every site that follows the group price', dB(ch.entity_id), a.default_price);
    if (ch.target === 'product' && ch.op === 'create' && Number(a.default_price) === 0 && !isOptionOnlyItem(a)) add('zero_price', `${a.name}|new`, `${a.name || 'A new product'} would be free (0.00).`);
    if (ch.target === 'product_site' && 'price' in a) {
      priceRisk(pName(ch.entity_id), `at ${siteName(ch.location_id)}`, b.price ?? dB(ch.entity_id), a.price ?? dA(ch.entity_id));
    }
    // Order type prices (round 2 review): the group's and a site's own, per order type.
    if (ch.target === 'product' && 'default_channels' in a && ch.op !== 'create') {
      const p = product.get(ch.entity_id) || {};
      const was = chBefore.has(ch.entity_id) ? chBefore.get(ch.entity_id) : (p.default_channels || {});
      const now = a.default_channels || {};
      for (const k of PUBLISHED_CHANNELS) {
        if (toPence(was[k]) === toPence(now[k])) continue;
        const x = channelFallback({ ...p, default_price: dB(ch.entity_id), default_channels: was }, null, k);
        const y = channelFallback({ ...p, default_price: dA(ch.entity_id), default_channels: now }, null, k);
        priceRisk(`${pName(ch.entity_id)} ${PRICE_WORDS[k]} price`, 'at every site that follows it', x, y);
      }
    }
    if (ch.target === 'product_site' && 'channel_prices' in a) {
      const p = product.get(ch.entity_id) || {};
      const row = ps.get(`${ch.entity_id}|${ch.location_id}`) || {};
      const was = has(b, 'channel_prices') ? (b.channel_prices || {}) : (row.channel_prices || {});
      const now = a.channel_prices || {};
      const base = { ...p, default_price: dA(ch.entity_id) };
      for (const k of PUBLISHED_CHANNELS) {
        if (toPence(was[k]) === toPence(now[k])) continue;
        const x = channelFallback({ ...p, default_price: dB(ch.entity_id) }, { price: has(b, 'price') ? b.price : row.price, channel_prices: was }, k);
        const y = channelFallback(base, { price: has(a, 'price') ? a.price : row.price, channel_prices: now }, k);
        priceRisk(`${pName(ch.entity_id)} ${PRICE_WORDS[k]} price`, `at ${siteName(ch.location_id)}`, x, y);
      }
    }
    if (ch.target === 'modifier_option' && 'price' in a && ch.op !== 'create') {
      const o = option.get(ch.entity_id);
      const who = `${o?.name || 'An option'} in ${group.get(o?.group_id)?.name || 'its group'}`;
      priceRisk(who, 'at every site that follows it', oB(ch.entity_id), a.price);
    }
    if (ch.target === 'modifier_option_site' && 'price' in a && ch.op !== 'create') {
      const o = option.get(ch.entity_id);
      priceRisk(`${o?.name || 'An option'} in ${group.get(o?.group_id)?.name || 'its group'}`, `at ${siteName(ch.location_id)}`, b.price ?? oB(ch.entity_id), a.price ?? oA(ch.entity_id));
    }
    // VAT. The key holds the new rate: picking another rate needs a new tick.
    if (ch.target === 'product' && ('tax_rate_name' in a || 'tax_rate_percent' in a) && ch.op !== 'create') {
      const p = product.get(ch.entity_id);
      const to = { name: a.tax_rate_name ?? p?.tax_rate_name, percent: a.tax_rate_percent ?? p?.tax_rate_percent };
      add('vat', `${ch.entity_id}|rate|${json(to)}`, `${pName(ch.entity_id)} VAT changes from ${rateWords({ name: b.tax_rate_name ?? p?.tax_rate_name, percent: b.tax_rate_percent ?? p?.tax_rate_percent })} to ${rateWords(to)}. I have checked this is right.`);
    }
    if (ch.target === 'product' && 'tax_by_type' in a) {
      const before = has(b, 'tax_by_type') ? (b.tax_by_type || {}) : (product.get(ch.entity_id)?.tax_by_type || {});
      const after = a.tax_by_type || {};
      for (const k of Object.keys(TAX_WORDS)) {
        if (json(before[k]) === json(after[k])) continue;
        add('vat', `${ch.entity_id}|${k}|${json(after[k])}`, `${pName(ch.entity_id)} ${TAX_WORDS[k].toLowerCase()} VAT changes from ${rateWords(before[k])} to ${rateWords(after[k])}. I have checked this is right.`);
      }
    }
    // A site's own VAT by order type given back ("Use the group's") or kept (Keep the site's).
    if (ch.target === 'product_site' && 'kept' in a) {
      const row = ps.get(`${ch.entity_id}|${ch.location_id}`) || {};
      const kb = has(b, 'kept') ? (b.kept || {}) : (row.kept || {});
      const tb = kb.tax_overrides && typeof kb.tax_overrides === 'object' ? kb.tax_overrides : {};
      const ta = a.kept && typeof a.kept.tax_overrides === 'object' && a.kept.tax_overrides ? a.kept.tax_overrides : {};
      const groupTbt = effectiveTaxByType(product.get(ch.entity_id), product);
      for (const k of ORDER_TYPE_TAX_KEYS) {
        if (has(tb, k) === has(ta, k) && json(tb[k]) === json(ta[k])) continue;
        const where = siteName(ch.location_id);
        const ownWords = (v) => (v === false ? 'the product\'s own VAT' : v === null ? 'its default VAT' : rateName(ch.location_id, v) || 'its own rate');
        const words = has(ta, k)
          ? `${where} keeps its own ${TAX_WORDS[k].toLowerCase()} VAT (${ownWords(ta[k])}) for ${pName(ch.entity_id)}. I have checked this is right.`
          : `${where} stops using its own ${TAX_WORDS[k].toLowerCase()} VAT (${ownWords(tb[k])}) for ${pName(ch.entity_id)} and uses the group's (${rateWords(groupTbt[k] || null)}). I have checked this is right.`;
        add('vat', `${ch.entity_id}|${ch.location_id}|kept|${k}|${has(ta, k) ? json(ta[k]) : 'group'}`, words);
      }
    }
    // Removing something that sells.
    const offAt = [];
    if (ch.target === 'product_site' && a.active === false) offAt.push(ch.location_id);
    if (ch.target === 'product' && (ch.op === 'remove' || a.archived === true)) for (const s of listOf(C.sites)) offAt.push(s.location_id);
    for (const loc of offAt) {
      const n = soldAt(loc, ch.entity_id);
      if (n === null && sold === null) add('removes_seller', `${ch.entity_id}|${loc}`, `${pName(ch.entity_id)} comes off the till at ${siteName(loc)}. We could not check sales, so please check.`);
      else if (n > 0) add('removes_seller', `${ch.entity_id}|${loc}`, `${pName(ch.entity_id)} sold ${n} time${n === 1 ? '' : 's'} at ${siteName(loc)} in the last 7 days and will come off the till.`);
    }
    // An option group made required.
    if (ch.target === 'modifier_group' && 'min' in a && Number(a.min) > 0 && !(Number(b.min ?? group.get(ch.entity_id)?.min ?? 0) > 0)) {
      const users = listOf(C.products).filter((p) => !p.archived && listOf(p.modifier_groups).some((x) => (typeof x === 'string' ? x : x?.groupId) === ch.entity_id));
      const selling = sold ? users.filter((p) => listOf(C.sites).some((s) => (soldAt(s.location_id, p.id) || 0) > 0)) : users;
      if (selling.length) add('made_required', ch.entity_id, `Customers at every site will have to pick a ${group.get(ch.entity_id)?.name || 'option'} for ${selling.length} product${selling.length === 1 ? '' : 's'}${sold ? '' : ' (we could not check sales, so please check)'}.`);
    }
  }
  // Publish now while sites are trading.
  if (opts.publishNow) {
    const reach = new Set(listOf(opts.sitesReached));
    if (trading === null) add('trading', 'unknown', 'We could not check which sites are trading. Tills change between sales. Schedule it for tonight instead if any site is busy.', { action: 'schedule_tonight' });
    else {
      const busy = listOf(trading).filter((t) => t.trading && (!reach.size || reach.has(t.location_id))).map((t) => siteName(t.location_id));
      if (busy.length) add('trading', 'now', `${busy.length > 2 ? `${busy.slice(0, 2).join(', ')} and ${busy.length - 2} more` : busy.join(' and ')} ${busy.length === 1 ? 'is' : 'are'} trading now. Tills change between sales.`, { action: 'schedule_tonight' });
    }
  }
  // Changes made at a site that this publish overwrites.
  for (const [loc, n] of Object.entries(opts.drift || {})) {
    if (n > 0) add('overwrites', loc, `This publish overwrites ${n} change${n === 1 ? '' : 's'} made at ${siteName(loc)}.`);
  }
  return out;
}

/** Every risk ticked? (ticked: Set of keys) */
export const allTicked = (risks, ticked) => listOf(risks).every((r) => ticked && ticked.has(r.key));
