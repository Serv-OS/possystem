// src/lib/msm/msmMargin.js
//
// MULTI SITE MENU (17 Oct 2026, v5.11.75): margin as you price (design 4c). Pure, tested
// (msmMargin.test.js). Gross profit against the NET (ex VAT) selling price, with the stock engine's
// own maths (lib/stock/costing.js gpPct, gpAmount), from each venue's OWN recipe cost (recipes are
// keyed by venue item id; nothing is costed centrally).
//
// No recipe = "No recipe", never a figure (a company with no recipes shows that everywhere).
// VAT is the site's rate for that product (the central tax name and percent mapped at that site);
// UK menu prices include VAT, so net = price / (1 + rate). Live tax_rates.rate is a fraction (0.2 is
// 20%, lib/tax.js netOf); a rate above 1 is read as a percent (msmModel.rateFraction).

import { gpPct, gpAmount, recipeCost } from '../stock/costing.js';
import { mapTaxRate } from '../../../supabase/functions/_shared/msmPlan.js';
import { effectiveTaxByType } from '../../../supabase/functions/_shared/msmTax.js';
import { siteOverridesAfter } from './msmOrderTypes.js';
import { resolveLineTaxRate } from '../tax.js';
import { rateFraction } from '../../../supabase/functions/_shared/msmModel.js';

// The VAT key and the order type the till uses for an order type PRICE (round 2 review: a takeaway
// price's GP takes off the takeaway VAT, not the product's own).
const CHANNEL_TAX = { takeaway: ['takeaway', 'takeaway'], collection: ['takeaway', 'collection'], driveThru: ['takeaway', 'drive-thru'], dineIn: ['dine-in', 'dine-in'] };

const round2 = (n) => Math.round(n * 100 + (n >= 0 ? 1e-9 : -1e-9)) / 100;

/** Net (ex VAT) price of a VAT inclusive price. */
export function netOf(price, vatPct) {
  const p = Number(price);
  if (!Number.isFinite(p)) return null;
  return p / (1 + rateFraction(vatPct));
}

/**
 * One price's margin.
 *   price    the selling price at that site (VAT inclusive)
 *   vatPct   the VAT rate there, as tax_rates holds it (0.2 for 20%; 20 is read as 20% too)
 *   cost     the plate cost from the venue's recipe, or null when there is no recipe
 * Returns { noRecipe: true, words: 'No recipe' } or { net, cost, gp, gpPct, words }.
 */
export function marginFor({ price, vatPct = 0, cost = null, target = null }) {
  if (cost == null || !Number.isFinite(Number(cost))) return { noRecipe: true, words: 'No recipe' };
  const net = netOf(price, vatPct);
  const t = targetOf(target);
  if (net == null) return { noRecipe: false, net: null, cost: Number(cost), gp: null, gpPct: null, target: t, under: null, words: 'No price' };
  const pct = gpPct(net, cost);
  const shown = pct == null ? null : Math.round(pct * 10) / 10;
  return {
    noRecipe: false, net: round2(net), cost: round2(Number(cost)), gp: round2(gpAmount(net, cost)),
    gpPct: shown,
    // 5.12.105: against the RECIPE's own Target GP, and nothing else. No target, no verdict.
    target: t, under: t == null || shown == null ? null : shown < t,
    words: pct == null ? 'No price' : `${Math.round(pct)}% GP`,
  };
}

/** A recipe's Target GP as a number from 0 to 100, or null (none set, or not a number). */
export function targetOf(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
}

/**
 * The colour a GP figure takes (5.12.105; Peter, 25 Nov 2026: "we cant just make this stuff up").
 * It used to be green from a fixed 60% that nobody chose. Now: 'good' at or above the recipe's own
 * Target GP, 'low' under it, and 'plain' when the recipe has no target (a figure, no verdict).
 */
export function gpTone(margin) {
  if (!margin || margin.noRecipe || margin.gpPct == null) return 'none';
  if (margin.under == null) return 'plain';
  return margin.under ? 'low' : 'good';
}

/**
 * The grid's one line: "62% GP · target 70%" or "62% GP · no target". The box is as wide as the old
 * "62% GP · cost 1.20", and three parts wrapped onto a second line and ran into the row below, so
 * the cost moves to the hover words (gpHoverWords) and stays on the product sheet.
 */
export function gpCellWords(margin) {
  if (!margin) return '';
  if (margin.noRecipe) return margin.words || 'No recipe';
  return `${margin.words} · ${margin.target == null ? 'no target' : `target ${Math.round(margin.target * 10) / 10}%`}`;
}

/** The hover words for a GP box: the cost, and the verdict against the recipe's target. */
export function gpHoverWords(margin, money = (n) => String(n)) {
  if (!margin || margin.noRecipe) return '';
  const cost = `Cost ${money(margin.cost)}.`;
  if (margin.target == null) return `${cost} This product's recipe has no Target GP, so the figure is not judged. Set one on the recipe (Produce, Recipes, Details).`;
  return `${cost} ${margin.under ? 'Under' : 'At or above'} its recipe's Target GP of ${Math.round(margin.target * 10) / 10}%.`;
}

/** "62% GP · cost 1.20 · target 70%" or "... · no target set". */
export function gpWordsWithTarget(margin, money = (n) => String(n)) {
  if (!margin) return '';
  if (margin.noRecipe) return margin.words || 'No recipe';
  const target = margin.target == null ? 'no target set' : `target ${Math.round(margin.target * 10) / 10}%`;
  return `${margin.words} · cost ${money(margin.cost)} · ${target}`;
}

/**
 * A venue's plate costs by venue item id, from its recipes (menu_item_recipes rows) and a costing
 * context built with the stock engine (buildCostingCtx). A recipe that cannot be costed (a missing
 * ingredient price) is left out, so it reads "No recipe", never a wrong figure.
 *   links     [{ menu_item_id, recipe_id, portion }]
 *   recipes   Map or object recipeId -> recipe
 *   ctx       the costing context
 */
export function plateCosts(links, recipes, ctx) {
  const get = (id) => (recipes instanceof Map ? recipes.get(id) : recipes?.[id]);
  const out = new Map();
  for (const l of links || []) {
    const r = get(l.recipe_id);
    if (!r) continue;
    try {
      const c = recipeCost(r, ctx).totalCost * (Number(l.portion) > 0 ? Number(l.portion) : 1);
      if (Number.isFinite(c)) out.set(l.menu_item_id, c);
    } catch { /* not costable: "No recipe" */ }
  }
  return out;
}

/**
 * Margins for the grid's Show GP mode: per product, per site.
 *   central    { products, productSites }
 *   costs      { [locationId]: Map(venueItemId -> cost) }   (loaded one venue at a time)
 *   vat        { [locationId]: (product) => vatPct }         (the site's mapped rate)
 * Returns Map(productId -> Map(locationId -> marginFor(...))).
 */
export function siteMargins(central, costs, vat, targets = null) {
  const prices = new Map((central?.products || []).map((p) => [p.id, p]));
  const out = new Map();
  for (const ps of central?.productSites || []) {
    const p = prices.get(ps.product_id);
    if (!p) continue;
    const price = ps.price != null ? Number(ps.price) : Number(p.default_price);
    const costMap = costs?.[ps.location_id];
    const cost = costMap ? (costMap.get(ps.venue_item_id) ?? null) : null;
    const pct = typeof vat?.[ps.location_id] === 'function' ? vat[ps.location_id](p) : Number(p.tax_rate_percent) || 0;
    if (!out.has(p.id)) out.set(p.id, new Map());
    const target = targets?.[ps.location_id] ? (targets[ps.location_id].get(ps.venue_item_id) ?? null) : null;
    out.get(p.id).set(ps.location_id, marginFor({ price, vatPct: pct, cost, target }));
  }
  return out;
}

/**
 * GP before and after for the Change prices preview rows (msmPrice.js applyPriceChange rows).
 * Returns the rows with { gpBefore, gpAfter } added.
 */
export function withMargins(rows, central, costs, vat, targets = null) {
  const prod = new Map((central?.products || []).map((p) => [p.id, p]));
  const ps = new Map((central?.productSites || []).map((r) => [`${r.product_id}|${r.location_id}`, r]));
  return (rows || []).map((r) => {
    if (!r.locationId) return { ...r, gpBefore: null, gpAfter: null };
    const p = prod.get(r.productId);
    const s = ps.get(`${r.productId}|${r.locationId}`);
    const cost = s && costs?.[r.locationId] ? (costs[r.locationId].get(s.venue_item_id) ?? null) : null;
    const pct = typeof vat?.[r.locationId] === 'function' ? vat[r.locationId](p, r.channel || null) : Number(p?.tax_rate_percent) || 0;
    const target = s && targets?.[r.locationId] ? (targets[r.locationId].get(s.venue_item_id) ?? null) : null;
    return { ...r, gpBefore: marginFor({ price: r.before, vatPct: pct, cost, target }), gpAfter: marginFor({ price: r.after, vatPct: pct, cost, target }) };
  });
}

/**
 * The VAT percent to take off a site's price for its GP (17 Oct review): the site's OWN rate
 * (a kept tax_rate_id, else the group's rate mapped there by name and percent, as publish does),
 * and 0 when that rate is exclusive (US sales tax is added on top: the menu price is already net).
 * taxRates null (not read) falls back to the group's percent.
 */
export function siteVatPct(product, ps, taxRates, channel = null, productById = null) {
  const groupPct = Number(product?.tax_rate_percent) || 0;
  if (!Array.isArray(taxRates)) return groupPct;
  const kept = ps?.kept && typeof ps.kept === 'object' && Object.prototype.hasOwnProperty.call(ps.kept, 'tax_rate_id');
  const id = kept ? ps.kept.tax_rate_id : mapTaxRate(product, taxRates).id;
  // An order type price: that order type's VAT, as publish leaves the site's overrides and as the
  // till resolves it (lib/tax.js resolveLineTaxRate).
  if (channel && CHANNEL_TAX[channel]) {
    const [, orderType] = CHANNEL_TAX[channel];
    const tbt = effectiveTaxByType(product, productById || new Map());
    const keptTax = ps?.kept && typeof ps.kept === 'object' ? ps.kept.tax_overrides : null;
    const { overrides } = siteOverridesAfter(tbt, keptTax, taxRates);
    const { rate } = resolveLineTaxRate({ taxRateId: id, taxOverrides: overrides }, taxRates, orderType);
    if (rate) return rate.type === 'exclusive' ? 0 : Number(rate.rate) || 0;
  }
  const r = id ? taxRates.find((x) => x && x.id === id) : null;
  if (!r) return groupPct;
  if (r.type === 'exclusive') return 0;
  return Number(r.rate) || 0;
}

/** { [locationId]: (product, channel?) => vatPct } for withMargins and the grid, from each site's rates. */
export function vatMaps(central, ratesByLoc) {
  const ps = new Map((central?.productSites || []).map((r) => [`${r.product_id}|${r.location_id}`, r]));
  const byId = new Map((central?.products || []).map((p) => [p.id, p]));
  const out = {};
  for (const loc of Object.keys(ratesByLoc || {})) {
    out[loc] = (p, channel = null) => siteVatPct(p, ps.get(`${p?.id}|${loc}`), ratesByLoc[loc], channel, byId);
  }
  return out;
}
