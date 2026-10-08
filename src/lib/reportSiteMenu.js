// src/lib/reportSiteMenu.js
//
// EACH SITE'S OWN MENU, TAX AND STATIONS for the Back Office reports that read them
// (Product mix, Item sales trend, Menu engineering, Tax summary, Kitchen performance).
//
// WHY (Peter, 5 Oct 2026: "make every report we have multi site when sites are connected
// together"): these reports looked a check line's category, product and tax rate up in the
// SIGNED IN site's memory (the store). Fed another site's rows, that gave the wrong category
// (a category id is a per site copy), split one shared product into one row per site, and
// booked another site's VAT on the signed in site's rates. So with several sites on screen
// each site's rows are read against that site's own menu and rates, and the results are
// joined by what the sites actually share.
//
// THE RULES THIS FILE KEEPS
//   1. A SHARED PRODUCT IS ONE ROW. Every site holds its own copy of a shared product with
//      the same master_id (db.js, Peter's rules of 26 Apr 2026). Across sites the copies are
//      grouped by master id; a product with no master (a local one) is grouped by name, so
//      two sites that each made a local "Flat White" still land in one row.
//   2. A CATEGORY IS LOOKED UP AT ITS OWN SITE, then grouped by master id, else by its label.
//   3. TAX IS NEVER ANOTHER SITE'S RATES. A check's tax comes from, in order: the record the
//      check booked (US added-on, or a scaled UK record: taxShare.bookedTaxRecord), the
//      site's OWN rates and profiles (the same seam the till ran, recordedCheckTax), and when
//      those could not be read, the tax_amount stored on the check: a total with no rate
//      breakdown, and the report says so. The signed in site keeps the store's context, so a
//      single site reads exactly as it did.
//   4. A STATION NAME IS ONLY UNIQUE INSIDE ITS SITE. "Site, Station" once several sites are
//      on screen (two sites can both have a "kds food").
//
// PURE: no Supabase, no React. The reads are in src/lib/reportSites.js (fetchSiteMenu,
// fetchSiteCentres), the per report drawing in the report files. Runs under node --test.

import { buildLocalTaxCtx, recordedCheckTax } from './taxCompute.js';
import { bookedTaxRecord } from './taxShare.js';
import { saleVatLedger, hasRateLines, roundPence } from '../../supabase/functions/_shared/saleVat.js';
import { stationNameMap, stationLabel } from './kdsStationNames.js';
import { sumByVenueHour } from '../backoffice/sections/reports/_filters.js';

const lower = (v) => String(v ?? '').trim().toLowerCase();
const masterOf = (row) => row?.master_id ?? row?.masterId ?? null;

/**
 * One site's menu as the reports read it. Rows may be raw snake rows or the store's camel
 * rows (both casings are read). `taxCtx` is given for the signed in site (the store's own,
 * so its figures are the ones the till books); for another site it is built from the rows
 * read for it (buildLocalTaxCtx), or left null when the tax read failed.
 */
export function buildSiteMenu({ id, items = [], categories = [], taxRates = [], taxProfiles = [], defaultProfileId = null, taxCtx = undefined, taxLoaded = true } = {}) {
  const byItemId = new Map();
  const byName = new Map();
  for (const m of items || []) {
    if (!m || m.id == null) continue;
    byItemId.set(String(m.id), m);
    // The same keys ItemTrend has always matched a modifier line on: every name an item goes by.
    for (const k of [m.name, m.menuName, m.menu_name, m.kitchenName, m.kitchen_name, m.receiptName, m.receipt_name]) {
      const key = lower(k);
      if (key && !byName.has(key)) byName.set(key, m);
    }
  }
  const catById = new Map();
  for (const c of categories || []) if (c && c.id != null) catById.set(String(c.id), c);
  let ctx = taxCtx;
  if (ctx === undefined) {
    ctx = taxLoaded ? buildLocalTaxCtx({ taxProfiles: taxProfiles || [], menuItems: items || [], menuCategories: categories || [], venueDefaultProfileId: defaultProfileId, taxRates: taxRates || [] }) : null;
  }
  return {
    id: id != null ? String(id) : null,
    items: items || [], categories: categories || [], taxRates: taxRates || [],
    byItemId, byName, catById,
    taxCtx: ctx,
    // false = the rates could not be read: tax comes from what each check stored
    taxLoaded: !!ctx,
    hasRates: (taxRates || []).length > 0,
  };
}

/** The menu row a check line was sold as, at its own site; null when the site no longer has it. */
export function lineMenuItem(line, siteMenu) {
  if (!line || !siteMenu) return null;
  const id = line.itemId ?? line.id ?? null;
  return id != null ? (siteMenu.byItemId.get(String(id)) || null) : null;
}

/**
 * The display name of a menu item: menuName first, and a variant child qualified by its
 * parent ("Latte — Large") exactly as ItemTrend names it (v5.5.945), so a group row carries
 * the name the single site report would.
 */
export function canonicalItemName(mItem, siteMenu) {
  const own = mItem?.menuName || mItem?.menu_name || mItem?.name || 'Unknown';
  const parentId = mItem?.parentId ?? mItem?.parent_id ?? null;
  const parent = parentId ? siteMenu?.byItemId?.get(String(parentId)) : null;
  const parentName = parent ? (parent.menuName || parent.menu_name || parent.name || '') : '';
  if (!parentName || own.toLowerCase().includes(parentName.toLowerCase())) return own;
  return `${parentName} — ${own}`;
}

/**
 * How a sold line is grouped ACROSS sites: { key, name, cat }.
 *   key   'master:<master_id>' for a shared product (every site's copy lands here);
 *         'name:<name>' otherwise (a local product, or one the site no longer has).
 *   name  the product's current name at its site, else the name on the line.
 *   cat   the category id ON THE LINE's SITE (resolve it with categoryFamily).
 * Rule 1 above.
 */
export function itemFamily(line, siteMenu) {
  const m = lineMenuItem(line, siteMenu);
  const name = m ? canonicalItemName(m, siteMenu) : (line?.name || 'Unknown');
  const master = masterOf(m);
  return {
    key: master ? `master:${master}` : `name:${lower(name)}`,
    name,
    cat: m?.cat ?? line?.cat ?? null,
  };
}

/**
 * How a category id (one site's copy) is grouped across sites: { key, label }.
 * Shared categories share a master id; others are matched on their label. An id the site
 * does not know keeps the id as its label, as the single site report shows it.
 */
export function categoryFamily(catId, siteMenu) {
  if (!catId) return { key: '__uncat', label: 'Uncategorized' };
  const c = siteMenu?.catById?.get(String(catId)) || null;
  const label = c ? (c.label || c.name || String(catId)) : String(catId);
  const master = masterOf(c);
  return { key: master ? `master:${master}` : (c ? `name:${lower(label)}` : `id:${catId}`), label };
}

/**
 * A modifier option's menu item at its site: the same four looks ItemTrend has always made
 * (id, the m-… tail of a composite option id, name, then label without a "×N" suffix).
 */
export function lookupModItem(mod, siteMenu) {
  if (!mod || !siteMenu) return null;
  const byId = siteMenu.byItemId, byName = siteMenu.byName;
  if (mod.id != null && byId.get(String(mod.id))) return byId.get(String(mod.id));
  if (mod.id != null) {
    const match = String(mod.id).match(/(?:^|[-_])m-([a-zA-Z0-9-]+)$/);
    if (match) {
      const hit = byId.get(`m-${match[1]}`);
      if (hit) return hit;
    }
  }
  if (mod.name) {
    const hit = byName.get(lower(mod.name));
    if (hit) return hit;
  }
  if (mod.label) {
    const hit = byName.get(lower(String(mod.label).replace(/\s*[×x]\s*\d+\s*$/i, '')));
    if (hit) return hit;
  }
  return null;
}

// ── the Product mix figures of one site, keyed to join across sites ──────────

const live = (checks) => (checks || []).filter((c) => c && c.status !== 'voided');

/**
 * Product mix "Items" of one site's checks: { rows: [{ key, name, cat, catKey, catLabel,
 * qty, rev, morning, lunch, afternoon, dinner, late, share, avgPrice }], totalRev }.
 * Same sums as the single site report, but keyed by itemFamily (rule 1) and with the category
 * named at this site (rule 2). `slotOf(closedAt)` is the time of day bucket on the site's clock.
 */
export function siteItemRows(checks, siteMenu, slotOf = () => 'other') {
  const map = {};
  let totalRev = 0;
  for (const c of live(checks)) {
    const slot = slotOf(c.closedAt);
    for (const i of c.items || []) {
      if (!i || i.voided) continue;
      const fam = itemFamily(i, siteMenu);
      const cat = categoryFamily(fam.cat, siteMenu);
      if (!map[fam.key]) map[fam.key] = { key: fam.key, name: fam.name, cat: fam.cat, catKey: cat.key, catLabel: fam.cat ? cat.label : '', qty: 0, rev: 0, morning: 0, lunch: 0, afternoon: 0, dinner: 0, late: 0, other: 0 };
      const qty = i.qty || 1;
      const rev = (i.price || 0) * qty;
      map[fam.key].qty += qty;
      map[fam.key].rev += rev;
      map[fam.key][slot] = (map[fam.key][slot] || 0) + qty;
      totalRev += rev;
    }
  }
  const rows = Object.values(map).sort((a, b) => b.rev - a.rev);
  for (const r of rows) { r.share = totalRev > 0 ? (r.rev / totalRev) * 100 : 0; r.avgPrice = r.qty ? r.rev / r.qty : 0; }
  return { rows, totalRev };
}

/** Product mix "Categories" of one site: rows keyed by categoryFamily. */
export function siteCategoryRows(checks, siteMenu) {
  const map = {};
  let totalRev = 0;
  for (const c of live(checks)) {
    for (const i of c.items || []) {
      if (!i || i.voided) continue;
      const fam = itemFamily(i, siteMenu);
      const cat = categoryFamily(fam.cat, siteMenu);
      if (!map[cat.key]) map[cat.key] = { key: cat.key, label: cat.label, qty: 0, rev: 0, items: new Set() };
      const qty = i.qty || 1;
      const rev = (i.price || 0) * qty;
      map[cat.key].qty += qty;
      map[cat.key].rev += rev;
      map[cat.key].items.add(fam.key);
      totalRev += rev;
    }
  }
  const rows = Object.values(map).map((r) => ({ ...r, itemCount: r.items.size })).sort((a, b) => b.rev - a.rev);
  for (const r of rows) r.share = totalRev > 0 ? (r.rev / totalRev) * 100 : 0;
  return { rows, totalRev };
}

/** Product mix "Modifiers" of one site: a modifier has no master, so it is keyed by its name. */
export function siteModifierRows(checks) {
  const map = {};
  let totalItemCount = 0;
  for (const c of live(checks)) {
    for (const i of c.items || []) {
      if (!i || i.voided) continue;
      const qty = i.qty || 1;
      totalItemCount += qty;
      for (const m of i.mods || []) {
        const name = m?.name || m?.label || 'Unnamed modifier';
        const key = `name:${lower(name)}`;
        if (!map[key]) map[key] = { key, name, qty: 0, revenue: 0 };
        map[key].qty += qty;
        map[key].revenue += (m?.price || 0) * qty;
      }
    }
  }
  const rows = Object.values(map).sort((a, b) => b.qty - a.qty);
  for (const r of rows) r.attachRate = totalItemCount > 0 ? (r.qty / totalItemCount) * 100 : 0;
  return { rows, totalItemCount };
}

/**
 * Rows from several sites joined on their key: [{ key, label, bySite: { [siteId]: row },
 * ...sums }], biggest `sortBy` first. `fields` are added up across sites; the label is the
 * first site's (a shared product has one name; a name keyed row has the same name by
 * definition). `items` Sets are unioned into itemCount when present.
 */
export function joinSiteRows(perSite, fields, { sortBy = fields[0], labelOf = (r) => r.name ?? r.label } = {}) {
  const out = new Map();
  for (const { siteId, rows } of perSite || []) {
    for (const r of rows || []) {
      let g = out.get(r.key);
      if (!g) {
        g = { key: r.key, label: labelOf(r), bySite: {}, items: new Set() };
        for (const f of fields) g[f] = 0;
        if (r.catLabel !== undefined) { g.catLabel = r.catLabel; g.catKey = r.catKey; }
        out.set(r.key, g);
      }
      g.bySite[siteId] = r;
      for (const f of fields) g[f] += Number(r[f]) || 0;
      if (r.items instanceof Set) for (const k of r.items) g.items.add(k);
    }
  }
  const rows = [...out.values()].map((g) => ({ ...g, itemCount: g.items.size, items: undefined }));
  rows.sort((a, b) => (b[sortBy] - a[sortBy]) || (a.label < b.label ? -1 : 1));
  return rows;
}

// ── the Item sales trend of one site, keyed to join across sites ─────────────

export const TREND_STANDALONE = '__standalone';

/**
 * One site's item by day matrix, the same way the single site report builds it (parent lines,
 * then modifier components that are menu items of their own, with a provenance breakdown),
 * keyed by itemFamily so sites join on shared products.
 *   dayOf(closedAt)  the business day on the SITE's own clock ('YYYY-MM-DD')
 *   days             the day axis; a check on a day not in it is left out
 * Returns { rows: [{ key, name, cat, catKey, catLabel, total, totalRev, byDay, byDayRev, sources }],
 *           totalsByDay, totalsByDayRev }.
 */
export function siteTrendRows(checks, siteMenu, { dayOf, days, includeMods = true } = {}) {
  const map = {};
  const totalsByDay = {}, totalsByDayRev = {};
  const dayKeys = new Set(days || []);
  const bump = (fam, qty, rev, day, source) => {
    let r = map[fam.key];
    if (!r) {
      const cat = categoryFamily(fam.cat, siteMenu);
      r = map[fam.key] = { key: fam.key, name: fam.name, cat: fam.cat, catKey: cat.key, catLabel: fam.cat ? cat.label : '', total: 0, totalRev: 0, byDay: {}, byDayRev: {}, sources: {} };
    }
    r.total += qty; r.totalRev += rev;
    r.byDay[day] = (r.byDay[day] || 0) + qty;
    r.byDayRev[day] = (r.byDayRev[day] || 0) + rev;
    r.sources[source] = (r.sources[source] || 0) + qty;
    totalsByDay[day] = (totalsByDay[day] || 0) + qty;
    totalsByDayRev[day] = (totalsByDayRev[day] || 0) + rev;
  };
  for (const c of live(checks)) {
    if (!c.closedAt) continue;
    const day = dayOf(c.closedAt);
    if (!dayKeys.has(day)) continue;
    for (const i of c.items || []) {
      if (!i || i.voided) continue;
      const lineQty = i.qty || 1;
      const lineRev = (i.price || 0) * lineQty;
      const fam = itemFamily(i, siteMenu);
      bump(fam, lineQty, lineRev, day, TREND_STANDALONE);
      if (!includeMods) continue;
      for (const m of i.mods || []) {
        if (!m || m._instruction) continue;
        const mItem = lookupModItem(m, siteMenu);
        if (!mItem) continue;
        const compQty = (Number(m.qty) || 1) * lineQty;
        const compRev = (Number(m.price) || 0) * lineQty;
        bump(itemFamily({ itemId: mItem.id, name: mItem.name, cat: mItem.cat }, siteMenu), compQty, compRev, day, fam.name);
      }
    }
  }
  return { rows: Object.values(map), totalsByDay, totalsByDayRev };
}

/**
 * Several sites' trend rows joined on their key: each row carries the group's byDay /
 * byDayRev / sources and bySite: { [siteId]: { total, totalRev } }.
 */
export function joinTrendRows(perSite) {
  const out = new Map();
  for (const { siteId, rows } of perSite || []) {
    for (const r of rows || []) {
      let g = out.get(r.key);
      if (!g) {
        g = { key: r.key, name: r.name, cat: r.cat, catKey: r.catKey, catLabel: r.catLabel, total: 0, totalRev: 0, byDay: {}, byDayRev: {}, sources: {}, bySite: {} };
        out.set(r.key, g);
      }
      g.total += r.total; g.totalRev += r.totalRev;
      for (const [d, v] of Object.entries(r.byDay)) g.byDay[d] = (g.byDay[d] || 0) + v;
      for (const [d, v] of Object.entries(r.byDayRev)) g.byDayRev[d] = (g.byDayRev[d] || 0) + v;
      for (const [s, v] of Object.entries(r.sources)) g.sources[s] = (g.sources[s] || 0) + v;
      g.bySite[siteId] = { total: r.total, totalRev: r.totalRev };
    }
  }
  return [...out.values()];
}

// ── the Menu engineering figures of one site ─────────────────────────────────

/**
 * Items as Menu engineering sums them (qty, revenue, average price), keyed by itemFamily.
 * Quadrants are worked out by the caller on whichever set of items is on screen (one site's,
 * or the group's), as the single site report does on its own items.
 */
export function siteEngineeringItems(checks, siteMenu) {
  const map = {};
  for (const c of live(checks)) {
    for (const i of c.items || []) {
      if (!i || i.voided) continue;
      const fam = itemFamily(i, siteMenu);
      if (!map[fam.key]) {
        const cat = categoryFamily(fam.cat, siteMenu);
        map[fam.key] = { key: fam.key, name: fam.name, cat: fam.cat, catKey: cat.key, catLabel: fam.cat ? cat.label : '', qty: 0, rev: 0 };
      }
      const qty = i.qty || 1;
      map[fam.key].qty += qty;
      map[fam.key].rev += (i.price || 0) * qty;
    }
  }
  return Object.values(map).map((it) => ({ ...it, avgPrice: it.qty ? it.rev / it.qty : 0 }));
}

/** The middle value of a list (the quadrant threshold). */
export function median(arr) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Kasavana-Smith: items against the medians of the set they are in. Adds `quadrant` in place. */
export function classifyItems(items) {
  const popMed = median(items.map((i) => i.qty));
  const contribMed = median(items.map((i) => i.avgPrice));
  for (const it of items) {
    const highPop = it.qty >= popMed, highContrib = it.avgPrice >= contribMed;
    it.quadrant = highPop && highContrib ? 'star' : highPop ? 'plow' : highContrib ? 'puzzle' : 'dog';
  }
  items.sort((a, b) => b.rev - a.rev);
  return { items, popMed, contribMed };
}

// ── tax ───────────────────────────────────────────────────────────────────────
//
// 8 Oct 2026 (the VAT audit): the tax of a check is read by the ONE rule every report shares
// (supabase/functions/_shared/saleVat.js). The split by rate comes from the record the check
// STORED (what was booked) whenever it has one; an older check with no record is worked out
// again through its own site's engine, as before. Each rate is named by its name (rate rows
// carry `name`, never `label`, so every row used to read "Unrated").

/** The name of a rate as the Tax report shows it: its name, else its code, else "No rate". */
export function taxRateLabel(rate) {
  if (!rate || typeof rate !== 'object') return 'No rate';
  return rate.name || rate.label || rate.code || 'No rate';
}

/**
 * The tax one closed check carries, read against ITS OWN site (rule 3). Same shape as
 * recordedCheckTax plus `source`: 'booked' (the check's own record), 'rates' (the site's
 * rates and profiles) or 'stored' (only tax_amount: no breakdown).
 */
export function siteCheckTax(check, siteMenu) {
  const booked = bookedTaxRecord(check);
  if (booked) return { ...booked, source: 'booked' };
  const own = check?.taxBreakdown;
  if (hasRateLines(own)) return { ...own, source: 'booked' };
  if (siteMenu?.taxCtx) return { ...recordedCheckTax(check, siteMenu.taxCtx), source: 'rates' };
  const tax = Number(check?.taxAmount) || 0;
  const gross = Number(check?.total) || 0;
  return { totalTax: tax, subtotal: Math.max(0, gross - tax), total: gross, breakdown: [], hasExclusiveTax: false, source: 'stored' };
}

/**
 * Two sites' rates are two rows (different ids), so a rate is matched across sites on what it
 * IS: its name, its percentage and whether it is inclusive. "Standard Rate 20% inclusive" at
 * Leeds and at Preston is one line.
 */
export function rateFamilyKey(b) {
  const r = b?.rate || null;
  if (!r) return '__unrated';
  return `${lower(taxRateLabel(r))}|${Number(r.rate) || 0}|${r.type === 'inclusive' ? 'inc' : 'exc'}`;
}

/**
 * The Tax report's roll up of a list of checks (one site or the signed in site), through
 * `taxOf(check)` for the split by rate. 8 Oct 2026: the report's figures are the shared VAT
 * ledger (saleVatLedger): VAT on sales is what each check booked, refunds come off on the day
 * they were made (inside `range` when given), a check with no VAT is named. `variance` is the
 * VAT booked against the item rules as they are today (the recompute), and `varianceSales`
 * names the checks behind it, biggest first.
 *   { rateRows, orderTypeRows, ledger, salesVat, refundVat, vatDue, displayTax, totalStoredTax,
 *     totalDerivedTax, hasStoredCount, derivedOnlyCount, totalNet, totalGross, effectiveTaxRate,
 *     variance, varianceSales, sources }
 */
export function taxAnalysisOf(checks, taxOf, { range = null, hasRates = true, keyOf = (b) => (b.rate?.id || '__unrated') } = {}) {
  const byRate = {};
  const byOrderType = {};
  const sources = { booked: 0, rates: 0, stored: 0 };
  const diffs = [];
  let totalStoredTax = 0, totalDerivedTax = 0, hasStoredCount = 0, derivedOnlyCount = 0, totalNet = 0, totalGross = 0;
  const live = [];
  for (const c of checks || []) {
    if (!c || c.status === 'voided') continue;
    live.push(c);
    let result;
    try { result = taxOf(c) || {}; } catch { result = {}; }
    const src = result.source === 'rates' ? 'rates' : result.source === 'stored' ? 'stored' : (result.source === 'booked' || hasRateLines(c.taxBreakdown) || bookedTaxRecord(c)) ? 'booked' : 'rates';
    sources[src] += 1;
    const derived = Number(result.totalTax) || 0;
    totalDerivedTax += derived;
    totalNet        += result.subtotal || result.totalNet || 0;
    if (c.taxAmount != null) {
      totalStoredTax += c.taxAmount; hasStoredCount++;
      const d = roundPence(c.taxAmount - derived);
      if (Math.abs(d) > 0.01 + 1e-9) diffs.push({ id: c.id, ref: c.ref, diff: d });
    } else { derivedOnlyCount++; }
    totalGross += c.total || 0;
    for (const b of result.breakdown || []) {
      const key = keyOf(b);
      if (!byRate[key]) {
        byRate[key] = { key, rateId: b.rate?.id || '__unrated', label: taxRateLabel(b.rate), rate: b.rate?.rate || 0, type: b.rate?.type || '', tax: 0, net: 0, gross: 0, items: 0 };
      }
      byRate[key].tax += b.tax || 0; byRate[key].net += b.net || 0; byRate[key].gross += b.gross || 0; byRate[key].items += b.items || 0;
    }
    const ot = c.orderType || 'dine-in';
    if (!byOrderType[ot]) byOrderType[ot] = { orderType: ot, tax: 0, net: 0, gross: 0, checks: 0 };
    byOrderType[ot].tax += derived;
    byOrderType[ot].net += result.subtotal || result.totalNet || 0;
    byOrderType[ot].gross += c.total || 0;
    byOrderType[ot].checks += 1;
  }
  const ledger = saleVatLedger(live, { range, hasRates });
  diffs.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  return {
    rateRows: Object.values(byRate).sort((a, b) => b.tax - a.tax),
    orderTypeRows: Object.values(byOrderType).sort((a, b) => b.tax - a.tax),
    ledger,
    salesVat: ledger.salesVat, refundVat: ledger.refundVat, vatDue: ledger.vatDue,
    // The headline VAT: what was booked, less refunds (the shared rule). Kept under its old name too.
    displayTax: ledger.vatDue,
    totalStoredTax, totalDerivedTax, hasStoredCount, derivedOnlyCount, totalNet, totalGross,
    effectiveTaxRate: totalNet > 0 ? (totalDerivedTax / totalNet) * 100 : 0,
    variance: totalStoredTax > 0 ? totalStoredTax - totalDerivedTax : 0,
    varianceSales: diffs.slice(0, 5),
    sources,
  };
}

/**
 * The Tax report's roll up of one site's checks, through the site's own tax source
 * (siteCheckTax). Same figures as the single site report, with rates matched across sites on
 * what they are (rateFamilyKey), plus how many checks came from each source.
 */
export function siteTaxAnalysis(checks, siteMenu, { range = null } = {}) {
  const hasRates = !siteMenu || siteMenu.hasRates !== false;
  return taxAnalysisOf(checks, (c) => siteCheckTax(c, siteMenu), { range, hasRates, keyOf: rateFamilyKey });
}

/** The line under a site whose rates could not be read, or null. */
export function taxSourceNote(siteName, siteMenu, analysis) {
  if (siteMenu?.taxLoaded) return null;
  const n = analysis?.sources?.stored || 0;
  if (!n) return null;
  return `${siteName}: the tax rates could not be read, so ${n === 1 ? 'one check shows' : `${n} checks show`} the tax stored on the check with no rate breakdown.`;
}

// ── kitchen stations ─────────────────────────────────────────────────────────

/**
 * The label of a ticket's station when `many` sites are on screen: "Leeds, kds food".
 * One site: the station name alone, as the single site report shows it.
 */
export function siteStationLabel(centreId, siteName, centres, many = true) {
  const name = stationLabel(centreId, stationNameMap(centres));
  return many ? `${siteName || 'Site'}, ${name}` : name;
}

/** A station AT a site, so two sites' "kds food" never merge. */
export function stationKey(siteId, centreId) {
  return `${String(siteId)}\u0000${centreId || '__no_station'}`;
}

/** The value `p` percent of the sorted list are at or under (the single site report's rule). */
export function percentile(sortedMs, p) {
  if (!sortedMs || sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[idx];
}

/**
 * Kitchen performance of one site's tickets, as the single site report works it out: bump
 * time = bumped_at minus sent_at; stations keyed by stationKey(siteId, centreId) and named by
 * `labelOf(centreId)`; hours on the site's own wall clock.
 * Returns { totalCount, openCount, avgMs, p50, p90, p99, bumpMs (sorted), stations, countByHour, sumMsByHour }.
 */
export function siteKitchenStats(tickets, { siteId, timeZone, labelOf = (id) => id || 'No station' } = {}) {
  const bumped = (tickets || []).filter((t) => t && t.status === 'bumped' && t.sentAt && t.bumpedAt);
  const open = (tickets || []).filter((t) => t && t.status === 'pending');
  const bumpMs = bumped.map((t) => Math.max(0, t.bumpedAt - t.sentAt)).sort((a, b) => a - b);
  const byStation = {};
  for (const t of bumped) {
    const key = stationKey(siteId, t.centreId);
    if (!byStation[key]) byStation[key] = { key, siteId, centreId: t.centreId || null, count: 0, bumpMs: [] };
    byStation[key].count += 1;
    byStation[key].bumpMs.push(Math.max(0, t.bumpedAt - t.sentAt));
  }
  const stations = Object.values(byStation).map((s) => {
    const sorted = [...s.bumpMs].sort((a, b) => a - b);
    return {
      key: s.key, siteId, centreId: s.centreId, label: labelOf(s.centreId), count: s.count,
      avgMs: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
      p50: percentile(sorted, 50), p90: percentile(sorted, 90),
    };
  }).sort((a, b) => b.count - a.count);
  const countByHour = sumByVenueHour(bumped, (t) => t.sentAt, () => 1, timeZone);
  const sumMsByHour = sumByVenueHour(bumped, (t) => t.sentAt, (t) => Math.max(0, t.bumpedAt - t.sentAt), timeZone);
  return {
    totalCount: bumped.length, openCount: open.length,
    avgMs: bumpMs.reduce((a, b) => a + b, 0) / (bumpMs.length || 1),
    p50: percentile(bumpMs, 50), p90: percentile(bumpMs, 90), p99: percentile(bumpMs, 99),
    bumpMs, stations, countByHour, sumMsByHour,
  };
}

/** Several sites' kitchen stats as one: percentiles over every bump time, hours added up. */
export function joinKitchenStats(list) {
  const all = (list || []).flatMap((s) => s.bumpMs).sort((a, b) => a - b);
  const countByHour = Array(24).fill(0), sumMsByHour = Array(24).fill(0);
  for (const s of list || []) for (let h = 0; h < 24; h += 1) { countByHour[h] += s.countByHour[h]; sumMsByHour[h] += s.sumMsByHour[h]; }
  return {
    totalCount: all.length,
    openCount: (list || []).reduce((n, s) => n + s.openCount, 0),
    avgMs: all.reduce((a, b) => a + b, 0) / (all.length || 1),
    p50: percentile(all, 50), p90: percentile(all, 90), p99: percentile(all, 99),
    stations: (list || []).flatMap((s) => s.stations).sort((a, b) => b.count - a.count),
    countByHour, avgByHour: countByHour.map((n, h) => (n ? sumMsByHour[h] / n : 0)),
  };
}
