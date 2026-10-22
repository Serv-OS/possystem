// src/lib/stock/menuEngineering.js
//
// MULTI SITE STOCK, Drop 4a (contract section 7, web-reports): the Star, Plowhorse, Puzzle, Dog
// rule the Product GP report shows, as pure functions node:test can drive.
//
// The database answers `class` on every product row (contract 1.6.3): popularity above 70% of the
// average share, and GP per unit above the average. This file says the same rule for the screen
// (the summary tiles, a row the database could not class) and pins it in menuEngineering.test.js.
// reports/MenuEngineering.jsx (the till sales report, medians of price) is untouched: its words
// (Stars, Plow Horses, Puzzles, Dogs) are kept, its maths is not, because here GP is real plate
// cost from the stock take off, not an average price.
//
// Averages are weighted: the average GP per unit is total GP over total units sold, the average
// share is 100 over the number of products with a known plate cost. A product with no takes in the
// window (theo_cost null) or nothing sold is 'Unknown' and never moves the averages.

export const CLASSES = Object.freeze(['Star', 'Plowhorse', 'Puzzle', 'Dog']);

/** Popular = share of units above this part of the average share (the classic 70% rule). */
export const POPULARITY_FACTOR = 0.7;

export const CLASS_WORDS = Object.freeze({
  Star: { label: 'Stars', blurb: 'Sell well and earn well.', action: 'Promote, feature, protect.', tone: 'good' },
  Plowhorse: { label: 'Plow Horses', blurb: 'Sell well, earn little.', action: 'Look at the price or the plate cost.', tone: 'acc' },
  Puzzle: { label: 'Puzzles', blurb: 'Earn well, sell little.', action: 'Move it on the menu, rename it, photograph it.', tone: 'blue' },
  Dog: { label: 'Dogs', blurb: 'Sell little, earn little.', action: 'Take it off unless it has a reason to stay.', tone: 'bad' },
  Unknown: { label: 'Plate cost not known', blurb: 'No recipe takes in the window.', action: 'Link a recipe to the product.', tone: 'neutral' },
});

const num = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** GP money of a row: the row's gp, else net sales minus plate cost, else null (cost not known). */
export function gpOf(row) {
  const gp = num(row?.gp);
  if (gp != null) return gp;
  const theo = num(row?.theo_cost);
  const net = num(row?.sales_net);
  if (theo == null || net == null) return null;
  return net - theo;
}

/** True when a row can be classed: something sold and a known plate cost. */
export function isKnown(row) {
  return num(row?.sold_qty) > 0 && num(row?.theo_cost) != null;
}

/**
 * The lines every class is judged against, from the rows on screen.
 * { products, total_qty, avg_share, popularity_floor, avg_gp_per_unit }, nulls when nothing is known.
 */
export function engineeringThresholds(rows) {
  const known = (rows || []).filter(isKnown);
  const n = known.length;
  const totalQty = known.reduce((a, r) => a + num(r.sold_qty), 0);
  const totalGp = known.reduce((a, r) => a + (gpOf(r) ?? 0), 0);
  return {
    products: n,
    total_qty: totalQty,
    avg_share: n ? 100 / n : null,
    popularity_floor: n ? (POPULARITY_FACTOR * 100) / n : null,
    avg_gp_per_unit: totalQty > 0 ? totalGp / totalQty : null,
  };
}

/** One row's class against the thresholds: Star, Plowhorse, Puzzle, Dog or Unknown. */
export function classOf(row, t) {
  if (!isKnown(row) || !t || !(t.total_qty > 0) || t.avg_gp_per_unit == null) return 'Unknown';
  const qty = num(row.sold_qty);
  const gp = gpOf(row);
  if (gp == null) return 'Unknown';
  const share = (qty / t.total_qty) * 100;
  const popular = share > t.popularity_floor;
  const earns = gp / qty > t.avg_gp_per_unit;
  if (popular && earns) return 'Star';
  if (popular) return 'Plowhorse';
  if (earns) return 'Puzzle';
  return 'Dog';
}

/**
 * Rows with gp, gp_per_unit, popularity_share and class filled. A class the database already
 * answered is kept (it judged the whole set, the screen may hold one page of it); a missing or
 * unknown one is worked out here against the rows given.
 */
export function classifyProducts(rows) {
  const t = engineeringThresholds(rows);
  return (rows || []).map((r) => {
    const qty = num(r.sold_qty);
    const gp = gpOf(r);
    const given = typeof r.class === 'string' && CLASSES.includes(r.class) ? r.class : null;
    return {
      ...r,
      gp,
      gp_per_unit: qty > 0 && gp != null ? gp / qty : null,
      popularity_share: r.popularity_share != null ? num(r.popularity_share) : (t.total_qty > 0 && qty > 0 ? (qty / t.total_qty) * 100 : null),
      class: given || classOf(r, t),
    };
  });
}

/** Per class: how many products, units, net sales and GP. Every class is present, zeros when empty. */
export function engineeringSummary(rows) {
  const out = {};
  for (const c of [...CLASSES, 'Unknown']) out[c] = { count: 0, sold_qty: 0, sales_net: 0, gp: 0 };
  for (const r of classifyProducts(rows)) {
    const c = out[r.class] ? r.class : 'Unknown';
    out[c].count += 1;
    out[c].sold_qty += num(r.sold_qty) || 0;
    out[c].sales_net += num(r.sales_net) || 0;
    out[c].gp += r.gp || 0;
  }
  return out;
}

/** GP percent of a row, null when there are no net sales (never divide by zero). */
export function gpPctOf(salesNet, gp) {
  const net = num(salesNet);
  const g = num(gp);
  if (!net || g == null) return null;
  return (g / net) * 100;
}

/** The spread between the lowest and highest plate cost, as a percent of the lowest; null when unknown. */
export function spreadPct(low, high) {
  const l = num(low);
  const h = num(high);
  if (l == null || h == null || l <= 0) return null;
  return ((h - l) / l) * 100;
}

/**
 * Side by side: one row per product with a value per site (`site:<id>` keys) and the company sums.
 * rows are 'site_product' rows (each carries location_id). A product is its product_key (the
 * master id across sites) or its menu item id; a product sold in two currencies is two rows, so
 * the sums never add two currencies.
 * { rows, sites } where rows are sorted by sales_net desc.
 */
export function pivotBySite(rows, siteIds, valueKey = 'gp_pct') {
  const ids = Array.isArray(siteIds) ? siteIds : [];
  const byItem = new Map();
  for (const r of rows || []) {
    // One product across sites: the Multi site menu master id (product_key) when the database gives
    // it, else the menu item id. Two currencies are never summed: each currency is its own row.
    const product = r.product_key ?? r.menu_item_id;
    if (product == null) continue;
    const k = `${r.currency || ''}|${product}`;
    let p = byItem.get(k);
    if (!p) {
      p = { menu_item_id: r.menu_item_id, product_key: product, currency: r.currency, name: r.name, type: r.type, sold_qty: 0, sales_net: 0, theo_cost: null, gp: null, gp_pct: null, known: true };
      if (r.currency == null) delete p.currency;
      byItem.set(k, p);
    }
    p.sold_qty += num(r.sold_qty) || 0;
    p.sales_net += num(r.sales_net) || 0;
    const theo = num(r.theo_cost);
    if (theo == null) p.known = false;
    else p.theo_cost = (p.theo_cost || 0) + theo;
    if (r.location_id != null) p[`site:${r.location_id}`] = valueKey === 'class' ? r.class : num(r[valueKey]);
  }
  const out = [...byItem.values()].map((p) => {
    const theo = p.known ? p.theo_cost : null;
    const gp = theo == null ? null : p.sales_net - theo;
    const row = { ...p, theo_cost: theo, gp, gp_pct: gpPctOf(p.sales_net, gp) };
    delete row.known;
    for (const id of ids) if (!(`site:${id}` in row)) row[`site:${id}`] = null;
    return row;
  });
  out.sort((a, b) => (b.sales_net - a.sales_net) || String(a.name || '').localeCompare(String(b.name || '')));
  return { rows: out, sites: ids };
}

/**
 * Which sites must say 'Plate cost not known before <day>': windows whose takes_from day is after
 * the window's first day (or the window has no first day). [{ location_id, day }].
 */
export function plateCostNotes(windows, { withNone = false } = {}) {
  const out = [];
  for (const w of windows || []) {
    if (!w) continue;
    // withNone: a site with no takes at all yet says so too ({ day: null }).
    if (!w.takes_from) { if (withNone && w.from_day) out.push({ location_id: w.location_id, day: null }); continue; }
    if (!w.from_day || String(w.takes_from) > String(w.from_day)) out.push({ location_id: w.location_id, day: w.takes_from });
  }
  return out;
}
