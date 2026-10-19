// src/lib/msm/msmOptionSpread.js
//
// MULTI SITE MENU, ROUND 2 (17 Oct 2026, v5.11.75, design 4): the Price check for OPTIONS. The same
// rows the product spread gives (lib/msm/msmPublishView.js spreadRows), one per option of a group
// in the group menu: its price at every site where it is on (the site's own price, else the
// option's default), the lowest, the highest, the spread and the sites more than 15% off the usual
// (middle) price. Pure, tested (msmOptionSpread.test.js).

import { toPence } from '../../../supabase/functions/_shared/msmModel.js';

const listOf = (v) => (Array.isArray(v) ? v : []);

/**
 *   central   the group menu (the draft applied)
 *   siteIds   the sites to compare
 * Returns [{ product: { id, name, groupId }, prices: [{ loc, price, pence }], min, max, spread, pct,
 * median, outliers: Set(loc) }], widest first.
 */
export function optionSpreadRows(central, siteIds, { outlierPct = 15 } = {}) {
  const groups = new Map(listOf(central?.groups).filter((g) => g && !g.archived).map((g) => [g.id, g]));
  const os = new Map(listOf(central?.optionSites).map((r) => [`${r.option_id}|${r.location_id}`, r]));
  const out = [];
  for (const o of listOf(central?.options)) {
    const g = groups.get(o?.group_id);
    if (!o || o.archived || !g) continue;
    const prices = [];
    for (const loc of listOf(siteIds)) {
      const r = os.get(`${o.id}|${loc}`);
      if (!r || r.active !== true) continue;
      const price = r.price != null ? Number(r.price) : Number(o.price ?? 0);
      prices.push({ loc, price, pence: toPence(price) });
    }
    if (prices.length < 2) continue;
    const pence = prices.map((x) => x.pence).sort((a, b) => a - b);
    const min = pence[0], max = pence[pence.length - 1];
    const mid = Math.floor(pence.length / 2);
    const median = pence.length % 2 ? pence[mid] : Math.round((pence[mid - 1] + pence[mid]) / 2);
    const outliers = new Set(median > 0 ? prices.filter((x) => Math.abs(x.pence - median) * 100 > outlierPct * median).map((x) => x.loc) : prices.filter((x) => x.pence !== median).map((x) => x.loc));
    out.push({
      product: { id: o.id, name: `${o.name} (${g.name})`, groupId: g.id }, prices,
      min: min / 100, max: max / 100, spread: (max - min) / 100,
      pct: min > 0 ? Math.round(((max - min) * 1000) / min) / 10 : null, median: median / 100, outliers,
    });
  }
  return out.sort((a, b) => b.spread - a.spread || (b.pct ?? 0) - (a.pct ?? 0) || a.product.name.localeCompare(b.product.name));
}

/** One line over the option spread: "4 of 12 options are priced differently between sites; the widest is ...". */
export function optionSpreadSummary(rows) {
  const list = listOf(rows);
  const differ = list.filter((r) => r.spread > 0);
  if (!differ.length) return `Every option costs the same at every site${list.length ? ` (${list.length} option${list.length === 1 ? '' : 's'} compared)` : ''}.`;
  const w = differ[0];
  const money = (v) => (Math.round(v * 100) / 100).toFixed(2);
  return `${differ.length} of ${list.length} option${list.length === 1 ? ' is' : 's are'} priced differently between sites; the widest is ${w.product.name}, ${money(w.spread)}${w.pct != null ? ` (${w.pct}%)` : ''}.`;
}
