// src/lib/msm/msmOrderTypes.js
//
// MULTI SITE MENU, ROUND 2 (17 Oct 2026, v5.11.75): price and VAT per order type, for the screens.
// Pure, tested (msmOrderTypes.test.js). Peter, 17 Oct 2026: "been able to set tax and price per
// order type and/or tax rate per order type ... making it a bit more idiot proof".
//
// WHAT THIS FILE ANSWERS
//   * Which order type prices show (design 5.1): the menu's own list (msm_menus.order_types) when it
//     has one, else every order type that has a price set anywhere in the group menu. Hidden ones
//     keep their prices; "Show every order type" opens the rest. Delivery is never one of them: it is
//     a platform price, set by the menu that platform uses at each site (Peter, UI issue 2).
//   * What a blank order type price falls back to, from the till's own chain
//     (msmModel.channelFallback, the same as lib/menuPricing.js): never typed by hand.
//   * Which VAT rows show (design 5.3): Eat in, Takeaway, Delivery, and Bar tab when the menu sells
//     bar tabs or a product already has one.
//   * The VAT rates a person can pick: the sites' OWN rates, by name and percent (publish maps each
//     one to that site's rate; msmTax.mapRateDescriptor), with how many sites have each.
//   * The live example under the VAT block: worked out with the real engine (lib/tax.js
//     resolveLineTaxRate), with the site's real overrides as publish would leave them (the four
//     order type keys from the group menu or kept by the site, every other key the site holds).

import { PUBLISHED_CHANNELS as CHANNELS, ORDER_TYPE_TAX_KEYS, channelFallback, has, money2 } from '../../../supabase/functions/_shared/msmModel.js';
import { mapRateDescriptor, cleanTaxByType } from '../../../supabase/functions/_shared/msmTax.js';
import { resolveLineTaxRate } from '../tax.js';
import { PRICE_TYPE_WORDS, TAX_TYPE_WORDS } from './msmWords.js';

const listOf = (v) => (Array.isArray(v) ? v : []);
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// ── Which order types show ──────────────────────────────────────────────────

/**
 * The order type prices the product sheet and the grid show.
 * Returns { types: [channel keys in CHANNELS order], fromSetting: bool, hidden: [the other keys] }.
 */
export function shownPriceTypes(central) {
  const setting = central?.menu?.order_types;
  let types;
  if (Array.isArray(setting)) types = CHANNELS.filter((c) => setting.includes(c));
  else {
    const used = new Set();
    for (const p of listOf(central?.products)) for (const c of CHANNELS) if (num(p?.default_channels?.[c]) != null) used.add(c);
    for (const ps of listOf(central?.productSites)) for (const c of CHANNELS) if (num(ps?.channel_prices?.[c]) != null) used.add(c);
    types = CHANNELS.filter((c) => used.has(c));
  }
  return { types, fromSetting: Array.isArray(setting), hidden: CHANNELS.filter((c) => !types.includes(c)) };
}

/** The VAT by order type rows: Eat in, Takeaway, Delivery, and Bar tab only when it is sold. */
export function shownTaxTypes(central) {
  const setting = central?.menu?.order_types;
  const barUsed = (Array.isArray(setting) && setting.includes('bar'))
    || listOf(central?.products).some((p) => p?.tax_by_type && has(p.tax_by_type, 'bar'));
  return ORDER_TYPE_TAX_KEYS.filter((k) => k !== 'bar' || barUsed);
}

// ── Fall backs (the till's chain) ───────────────────────────────────────────

/**
 * What the GROUP charges for an order type when its box is blank.
 * Returns { value, words } ("Blank uses the Standard price, 3.40").
 */
export function groupTypeFallback(product, ch) {
  const def = product?.default_channels || {};
  const base = num(product?.default_price);
  if (ch === 'driveThru' && num(def.takeaway) != null) return { value: num(def.takeaway), words: `Blank uses the Takeaway price, ${money2(def.takeaway)}` };
  return { value: base, words: base == null ? 'Blank uses the Standard price' : `Blank uses the Standard price, ${money2(base)}` };
}

/**
 * What a SITE charges for an order type when its own box is blank: the group's price for that order
 * type, else (drive thru) takeaway, else the site's Standard price, else the group's.
 *   siteStandard   the site's own Standard price as typed (or null): the sheet passes what is in the box
 * Returns { value, words }.
 */
export function siteTypeFallback(product, ps, ch, siteStandard = undefined) {
  const site = { ...(ps || {}), price: siteStandard === undefined ? ps?.price ?? null : siteStandard };
  const v = channelFallback(product, site, ch);
  const def = product?.default_channels || {};
  let from = 'the Standard price';
  if (num(def[ch]) != null) from = `the group's ${PRICE_TYPE_WORDS[ch]} price`;
  else if (ch === 'driveThru' && (num(site.channel_prices?.takeaway) != null || num(def.takeaway) != null)) from = 'the Takeaway price';
  return { value: v, words: v == null ? `Blank uses ${from}` : `Blank uses ${from}, ${money2(v)}` };
}

// ── VAT choices ─────────────────────────────────────────────────────────────

/**
 * The VAT rates people can pick, from the sites' own rates (active only), by name and percent,
 * most sites first: [{ name, percent, label, sites, value }]. value is `${name}|${percent}`.
 *   ratesByLoc   { [locationId]: [tax_rates rows] }
 */
export function siteRateChoices(ratesByLoc, siteIds = null) {
  const seen = new Map();
  const locs = siteIds || Object.keys(ratesByLoc || {});
  for (const loc of locs) {
    const here = new Set();
    for (const r of listOf(ratesByLoc?.[loc])) {
      if (!r || r.active === false || num(r.rate) == null) continue;
      const name = String(r.name ?? '').trim();
      const k = `${name.toLowerCase()}|${Number(r.rate)}`;
      if (here.has(k)) continue;
      here.add(k);
      if (!seen.has(k)) seen.set(k, { name, percent: Number(r.rate), sites: 0 });
      seen.get(k).sites++;
    }
  }
  return [...seen.values()]
    .sort((a, b) => (b.sites - a.sites) || (b.percent - a.percent) || a.name.localeCompare(b.name))
    .map((t) => ({ ...t, label: `${t.name || 'VAT'} (${t.percent}%)`, value: `${t.name}|${t.percent}` }));
}

/** A picked choice value back to { name, percent } (or null for "Same as the product's VAT"). */
export function choiceToRate(value) {
  if (!value) return null;
  const i = String(value).lastIndexOf('|');
  if (i < 0) return null;
  const pct = Number(String(value).slice(i + 1));
  return Number.isFinite(pct) ? { name: String(value).slice(0, i), percent: pct } : null;
}
export const rateToChoice = (r) => (r ? `${r.name ?? ''}|${Number(r.percent)}` : '');

/**
 * The sites that have no rate matching a choice (publish would block there, in words).
 * Returns [locationId].
 */
export function sitesMissingRate(rate, ratesByLoc, siteIds) {
  if (!rate) return [];
  return listOf(siteIds).filter((loc) => Array.isArray(ratesByLoc?.[loc]) && !mapRateDescriptor(rate, ratesByLoc[loc]).ok);
}

// ── The live example ────────────────────────────────────────────────────────

/**
 * A site's tax_overrides as publish would leave them for a product: the four order type keys from
 * the group menu (mapped to the site's own rates) unless the site keeps its own, and every other
 * key the site holds (counter, drive-thru, collection), as it is.
 *   taxByType   the group's VAT by order type ({ takeaway: { name, percent } })
 *   kept        the site's kept tax_overrides (msm_product_sites.kept.tax_overrides): a key's value
 *               is a rate id, null (the site default) or false (no key at that site)
 *   rates       the site's tax_rates rows
 * Returns { overrides, unmatched: [keys with no matching rate at the site] }.
 */
export function siteOverridesAfter(taxByType, kept, rates) {
  const out = {};
  const unmatched = [];
  const k = kept && typeof kept === 'object' ? kept : {};
  for (const [key, v] of Object.entries(k)) if (!ORDER_TYPE_TAX_KEYS.includes(key)) out[key] = v;
  const group = cleanTaxByType(taxByType) || {};
  for (const key of ORDER_TYPE_TAX_KEYS) {
    if (has(k, key)) { if (k[key] !== false) out[key] = k[key]; continue; }
    if (!group[key]) continue;
    const m = mapRateDescriptor(group[key], rates);
    if (m.ok) out[key] = m.id; else unmatched.push(key);
  }
  return { overrides: out, unmatched };
}

/**
 * "A 3.50 Galaxy donut, takeaway at Leeds: VAT 0.00 (Zero Rate)." Worked out with the real engine.
 *   product     { name, tax_rate_name, tax_rate_percent }
 *   taxByType   the group's VAT by order type (as the sheet holds it now)
 *   kept        the site's kept tax_overrides (or null)
 *   rates       the site's tax_rates rows (null when not read)
 *   orderType   'dine-in' | 'takeaway' | 'collection' | 'delivery' | 'bar-tab' ...
 *   price       the price the site charges
 *   siteName
 * Returns { ok, words, rate } (ok false: words say why there is no example).
 */
export function vatExample({ product, taxByType, kept = null, rates, orderType = 'takeaway', price, siteName = 'this site' }) {
  if (!Array.isArray(rates)) return { ok: false, words: `Reading ${siteName}'s VAT rates…`, rate: null };
  if (!rates.length) return { ok: false, words: `${siteName} has no VAT rates set up. Add them in Settings, Tax.`, rate: null };
  const own = product?.tax_rate_percent == null ? { id: null, ok: true } : mapRateDescriptor({ name: product.tax_rate_name, percent: product.tax_rate_percent }, rates);
  const { overrides, unmatched } = siteOverridesAfter(taxByType, kept, rates);
  const key = orderType === 'dine-in' || orderType === 'takeaway' || orderType === 'delivery' || orderType === 'bar'
    ? orderType : orderType === 'collection' || orderType === 'drive-thru' ? 'takeaway' : orderType === 'bar-tab' ? 'bar' : orderType;
  if (unmatched.includes(key)) {
    const want = cleanTaxByType(taxByType)?.[key];
    return { ok: false, words: `${siteName} has no ${want?.name || 'matching'} rate${want ? ` at ${want.percent}%` : ''}. Add it in Settings, Tax, or that site cannot be published.`, rate: null };
  }
  if (!own.ok) return { ok: false, words: `${siteName} has no ${product.tax_rate_name || 'matching'} rate at ${product.tax_rate_percent}%. Add it in Settings, Tax.`, rate: null };
  const { rate } = resolveLineTaxRate({ taxRateId: own.id, taxOverrides: overrides }, rates, orderType);
  const p = num(price);
  const who = `${p != null ? `A ${money2(p)} ` : 'A '}${product?.name || 'product'}`;
  const typeWord = String(orderType === 'collection' ? 'collection' : TAX_TYPE_WORDS[key] || orderType).toLowerCase();
  if (!rate) return { ok: true, words: `${who}, ${typeWord} at ${siteName}: no VAT rate applies.`, rate: null };
  const pct = Number(rate.rate) || 0;
  if (p == null) return { ok: true, words: `${product?.name || 'This product'}, ${typeWord} at ${siteName}: ${rate.name} (${pct}%).`, rate };
  const inclusive = rate.type !== 'exclusive';
  const vat = inclusive ? p - p / (1 + pct / 100) : p * (pct / 100);
  const vatWords = `VAT ${money2(Math.round(vat * 100) / 100)}${inclusive ? '' : ' added'} (${rate.name}${pct ? `, ${pct}%` : ''})`;
  return { ok: true, words: `${who}, ${typeWord} at ${siteName}: ${vatWords}.`, rate };
}

// ── The grid's VAT view ─────────────────────────────────────────────────────

const rateWords = (r) => (r ? `${r.name || 'VAT'} ${Number(r.percent ?? r.rate)}%` : 'No VAT rate');

/**
 * The VAT a product is charged for one order type key ('dine-in', 'takeaway', 'delivery', 'bar'):
 * the group's (its VAT by order type, else its own VAT), or at a site, the site's own value when it
 * keeps one (a rate there, "the site's default", or "the product's VAT" for no key).
 *   product   central product (a size reads its product's VAT by order type)
 *   parent    its product when it is a size (or null)
 *   ps        the product at that site (or null for the group column)
 *   rates     that site's tax_rates rows (or null)
 * Returns { words, own (the site keeps its own), byType (an order type VAT, not the product's own) }.
 */
export function vatCell(product, parent, ps, key, rates = null) {
  const tbt = cleanTaxByType((parent || product)?.tax_by_type) || {};
  const own = product?.tax_rate_percent == null ? null : { name: product.tax_rate_name, percent: product.tax_rate_percent };
  const group = tbt[key] ? { words: rateWords(tbt[key]), byType: true } : { words: rateWords(own), byType: false };
  if (!ps) return { ...group, own: false };
  const kept = ps.kept && typeof ps.kept === 'object' ? ps.kept.tax_overrides : null;
  if (!kept || typeof kept !== 'object' || !has(kept, key)) return { ...group, own: false };
  const v = kept[key];
  if (v === false) return { words: rateWords(own), own: true, byType: false };
  if (v === null) return { words: "Site's default VAT", own: true, byType: true };
  const r = listOf(rates).find((x) => x && String(x.id) === String(v));
  return { words: r ? rateWords(r) : 'Its own VAT', own: true, byType: true };
}

/**
 * The price the till charges in the VAT example for one order type at one site (round 2 review: the
 * example used the Standard price for every order type). The till's chain: the site's own box for
 * that order type, else what it falls back to (msmModel.channelFallback). Delivery is a platform
 * price set by the platform's menu: the example uses the Standard price there.
 *   orderType      'dine-in' | 'takeaway' | 'collection' | 'delivery' | 'drive-thru'
 *   product        the product as the sheet holds it ({ default_price, default_channels })
 *   ps             the site row as the sheet holds it ({ price, channel_prices })
 */
export function examplePrice(orderType, product, ps) {
  const key = { 'dine-in': 'dineIn', takeaway: 'takeaway', collection: 'collection', 'drive-thru': 'driveThru' }[orderType] || null;
  const site = ps || {};
  const standard = num(site.price) ?? num(product?.default_price);
  if (!key) return standard;
  const own = num(site.channel_prices?.[key]);
  if (own != null) return own;
  return channelFallback(product, site, key) ?? standard;
}
