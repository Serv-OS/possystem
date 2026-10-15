// supabase/functions/_shared/salesMix.js
//
// SALES MIX: item sales by sales group (Food, Drinks, Other sales) for one period.
//
// 8 Oct 2026, Peter: "the ability to report on bigger categories like say what is
// Food/drink/other split ... in hospitality a valued piece of data". This file is the ONE
// place for the maths behind the Back Office "Sales mix" report, the Business summary strip,
// the Z report block and the owner app's bars and card: the roll up, the shares, the series,
// the daypart split, the setup list and the owner view. Every surface calls these functions
// over the same inputs, so they always agree.
//
// WHICH GROUP AN ITEM IS IN (D2): makeGroupResolver from ./accountingGroups.js, over the
// SITE's own menu_categories rows plus that site's Xero mapping (xero_config.mapping) when it
// has one. The Xero daily invoice builds the very same resolver, so the invoice and the
// reports never disagree about where an item sits. This file only adds the camel/snake
// adapter the browser needs and the words for the 'other' bucket.
//
// THE MONEY (D3): till price times qty, nothing taken off. See lineSales.
//
// Pure ES module. Imports only ./accountingGroups.js and ./businessDay.js, so the owner
// snapshot function (Deno) and `npm test` (node) load exactly what ships. Money is added raw
// and rounded with r2 only when it is handed out. Shares are whole percents that add to 100.

import { makeGroupResolver, groupKeyOf, OTHER_GROUP } from './accountingGroups.js';
import { businessDayOf, wallClock, venueZone, dayStartMinutes } from './businessDay.js';

// ── constants ─────────────────────────────────────────────────────────────────

export const MIX_BASIS = 'item_sales';
export const OTHER_NAME = 'Other sales';
/** What the "Other sales" dropdown option writes: groupKeyOf('Other') === OTHER_GROUP, so a chosen Other is resolved, not unassigned. */
export const OTHER_TEXT = 'Other';
/** D1 words, in dropdown order. */
export const SUGGESTED_GROUPS = ['Food', 'Drinks', 'Alcohol', 'Retail', 'Other'];
export const SETUP_OPTIONS = [
  { value: '', label: 'No group yet' },
  { value: 'Food', label: 'Food' },
  { value: 'Drinks', label: 'Drinks' },
  { value: 'Alcohol', label: 'Alcohol' },
  { value: 'Retail', label: 'Retail' },
  { value: 'Other', label: 'Other sales' },
];
export const BASIS_NOTE = 'Item sales before check discounts and refunds, as Product mix. Share is the figure that matters.';
/** Shown only when a group's money is below zero (a refund line stored at a negative price): wholeShares counts such a line as 0. */
export const NEGATIVE_NOTE = 'Lines with a negative price count in the money, not in the shares.';
/**
 * 8 Oct 2026 (review): a sold gift card is money taken for goods not yet sold. The Xero daily
 * invoice carves it out before grouping (accountingGroups.js isGift), and it has no category to
 * set a group on, so here it is its own resolved group: never "no group", never a reason to open
 * the setup panel, and the Food and Drinks shares read the way the invoice's split does. It stays
 * in the total (D3: the groups add up to Product mix, which counts it).
 */
export const GIFT_GROUP = 'gift-cards';
export const GIFT_NAME = 'Gift cards';
// Colours BY KEY, never by rank, so Food keeps its colour when Drinks overtakes it on another
// period. Token names, drawn as var(--tone); all of them exist in both skins and both themes.
// Gift cards take the spare grey: a liability, not a sales group a manager chose.
export const GROUP_TONES = { food: 'acc', drinks: 'blu', alcohol: 'red', retail: 'orn', other: 't3', [GIFT_GROUP]: 't4' };
/** Custom keys, in money order, skipping tones a fixed key in the list already holds. */
export const TONE_CYCLE = ['acc', 'blu', 'orn', 'red'];
export const TONE_SPARE = 't4';
/**
 * A tone name as the CSS it is drawn with ('acc' -> 'var(--acc)'); a tone nobody set draws grey, like
 * Other sales. One place (8 Oct 2026, lane D): the report, the strip, the Z block and the owner app
 * all import this, so Food is the same colour on every screen.
 */
export const toneVar = (tone) => `var(--${tone || GROUP_TONES.other})`;
// The fallback dayparts when a site has no service periods set (0.6 of the build spec):
// Morning runs from the business day start to 10:59; Evening takes every hour from 17:00 and
// every hour before the day start (a 02:00 sale on a 06:00 day is the end of the evening's trade).
export const DAY_BANDS = [
  { id: 'morning', name: 'Morning', sub: 'before 11:00' },
  { id: 'midday', name: 'Midday', sub: '11:00 to 14:00' },
  { id: 'afternoon', name: 'Afternoon', sub: '14:00 to 17:00' },
  { id: 'evening', name: 'Evening', sub: 'from 17:00' },
];
export const BANDS_NOTE = 'Morning before 11:00, Midday 11:00 to 14:00, Afternoon 14:00 to 17:00, Evening from 17:00.';
export const OUTSIDE_ID = '__outside';
export const OUTSIDE_NAME = 'Outside service periods';
/** The category bucket for a line with no category id. */
export const NO_CAT = '__none';
export const NO_CAT_LABEL = 'No category';
/** A category id no site row knows. */
export const UNKNOWN_CAT_LABEL = 'Unknown category';

export const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── liveness ──────────────────────────────────────────────────────────────────

/**
 * A check that counts. Raw Deno rows (status 'void' or voided true) and normalised Back Office
 * rows (status 'voided') give the same answer. refunded and partial_refund are live: refunds
 * are not deducted (D3).
 */
export function isLiveCheck(c) {
  if (!c || c.voided === true) return false;
  const s = String(c.status || '').toLowerCase();
  return s !== 'void' && s !== 'voided';
}

/** A line that counts: not voided on the ticket. */
export function isLiveLine(i) {
  return !!i && !i.voided && i.status !== 'voided';
}

/** The close instant in ms from either row shape (closedAt ms, closed_at ISO), or null. */
export function closedMsOf(c) {
  if (!c) return null;
  let ms;
  if (typeof c.closedAt === 'number') ms = c.closedAt;
  else if (c.closed_at) ms = Date.parse(c.closed_at);
  else if (c.closedAt) ms = Date.parse(c.closedAt);
  else ms = NaN;
  return Number.isFinite(ms) ? ms : null;
}

// ── the basis (the one place) ─────────────────────────────────────────────────

export function lineQty(i) {
  return Number(i?.qty) || 1;
}

/**
 * 8 Oct 2026, D3: till price times qty, nothing taken off. Product mix (ProductMix.jsx lines
 * 69 and 91), the stored check subtotal and the Z report Gross sales all sum exactly this, so
 * groups, categories and items tie to one total (checked live at Leeds: 1,111 checks, stored
 * subtotal 7,708.70 = price times qty 7,708.70). The line's own discount is NOT applied (the
 * till does not net it from the stored subtotal either). Modifier prices are already inside
 * price (cartUnitPrice, reprice modSum); adding mods would count every syrup twice. A negative
 * price stays negative, as Product mix shows it. A price that is not a number counts 0. A qty of
 * 0 counts as 1, as Product mix (i.qty || 1); the Xero invoice drops such a line (qtyOf > 0), so
 * the groups agree with the invoice on WHERE a line sits, and with Product mix on HOW MUCH.
 */
export function lineSales(i) {
  return (Number(i?.price) || 0) * lineQty(i);
}

// ── categories and the resolver ───────────────────────────────────────────────

/**
 * Store rows, reportSiteMenu rows or raw database rows as the resolver wants them:
 * { id, parent_id, label, accounting_group, master_id, local: true }. CAMEL FIRST on purpose:
 * store.updateCategory merges the camel patch { accountingGroup } optimistically while the raw
 * accounting_group key stays stale until the writer refreshes the row; raw Deno rows have no
 * camel keys, so snake wins there. Rows with no id are dropped.
 */
export function toResolverCategories(rows) {
  const out = [];
  for (const c of Array.isArray(rows) ? rows : []) {
    if (!c || c.id == null) continue;
    // By KEY, not by value: a camel parentId of null (moved to the top level) must not fall
    // through to the stale raw parent_id.
    const parent = 'parentId' in c ? c.parentId : c.parent_id;
    const group = 'accountingGroup' in c ? c.accountingGroup : c.accounting_group;
    const master = 'master_id' in c ? c.master_id : c.masterId;
    out.push({
      id: String(c.id),
      parent_id: parent ?? null,
      label: c.label ?? c.name ?? 'Category',
      accounting_group: String(group ?? ''),
      master_id: master ?? null,
      local: true,
    });
  }
  return out;
}

/** The same, keeping only one site's rows (by location_id or locationId). */
export function categoriesOfSite(rows, siteId) {
  const want = String(siteId);
  return toResolverCategories((Array.isArray(rows) ? rows : []).filter((c) => c && String(c.location_id ?? c.locationId) === want));
}

/** The words for a key nobody has named: 'Other sales' for other, else the key with its dashes as spaces. */
export function fallbackName(key) {
  if (key === OTHER_GROUP) return OTHER_NAME;
  return String(key ?? '').replace(/-/g, ' ').replace(/^./, (ch) => ch.toUpperCase());
}

// A local copy of accountingGroups.isGift (not exported there): a sold gift card on a ticket.
const isGiftLine = (i) => !!(i?.isGiftCard || i?.giftCard === true || i?.is_gift_card);
const GIFT_RESULT = Object.freeze({ key: GIFT_GROUP, catId: null, resolved: true });

/**
 * The resolver every Sales mix surface uses: makeGroupResolver over the site's own rows, with
 * two changes. Key 'other' is ALWAYS named "Other sales", even when a category's text says
 * 'Other' (the dropdown's "Other sales" option writes that text). A sold gift card is the
 * "Gift cards" group before any category or Xero rule is asked, as the invoice carves it out
 * first (see GIFT_GROUP).
 */
export function makeMixResolver(mapping, rows) {
  const base = makeGroupResolver(mapping && typeof mapping === 'object' ? mapping : {}, toResolverCategories(rows));
  return {
    ...base,
    itemGroup: (line) => (isGiftLine(line) ? GIFT_RESULT : base.itemGroup(line)),
    groupName: (key) => (key === OTHER_GROUP ? OTHER_NAME : key === GIFT_GROUP ? GIFT_NAME : base.groupName(key)),
  };
}

/** A group's name across several sites: the first resolver that names it with more than the fallback words, else those words. */
export function nameAcross(resolvers, key) {
  const fb = fallbackName(key);
  if (key === OTHER_GROUP) return OTHER_NAME;
  for (const r of Array.isArray(resolvers) ? resolvers : []) {
    const n = r?.groupName?.(key);
    if (n && n !== fb) return n;
  }
  return fb;
}

// A local copy of accountingGroups.stemOf (not exported there): the id less its venue suffix.
const stem = (id) => String(id ?? '').replace(/_[0-9a-f]{8}$/i, '');

/**
 * (id) => a key that is the same for every venue's copy of one category (master_id, else the id
 * stem). Used only when several venues are merged into one view (the owner app's group detail).
 */
export function catFamilyKey(resolver) {
  return (id) => String(resolver?.localCat?.(id)?.master_id || stem(id));
}

// ── the accumulator ───────────────────────────────────────────────────────────

/** An empty roll up. groups: Map key -> { key, money, qty, lines, unresolved, items: Set, cats: Map }. */
export function newMix() {
  return { total: 0, qty: 0, lines: 0, checks: 0, unresolved: 0, groups: new Map() };
}

function groupEntry(mix, key) {
  let e = mix.groups.get(key);
  if (!e) mix.groups.set(key, (e = { key, money: 0, qty: 0, lines: 0, unresolved: 0, items: new Set(), cats: new Map() }));
  return e;
}

/** Adds one ticket line. A voided line adds nothing. catKeyOf merges category copies across venues. */
export function addLineToMix(mix, line, resolver, catKeyOf = null) {
  if (!isLiveLine(line)) return;
  const v = lineSales(line);
  const q = lineQty(line);
  const g = resolver.itemGroup(line);
  const e = groupEntry(mix, g.key);
  e.money += v;
  e.qty += q;
  e.lines += 1;
  e.items.add(String(line.itemId ?? line.id ?? ('name:' + String(line.name || '').toLowerCase())));
  if (g.resolved === false) { e.unresolved += v; mix.unresolved += v; }
  const catId = g.catId ?? line.cat ?? (Array.isArray(line.cats) ? line.cats[0] : null) ?? null;
  const catKey = catId == null ? NO_CAT : (catKeyOf ? catKeyOf(catId) : String(catId));
  let c = e.cats.get(catKey);
  if (!c) {
    const label = catId == null ? NO_CAT_LABEL : (resolver.categoryLabel(catId) || UNKNOWN_CAT_LABEL);
    e.cats.set(catKey, (c = { id: catId == null ? null : String(catId), label, money: 0, qty: 0 }));
  }
  c.money += v;
  c.qty += q;
  mix.total += v;
  mix.qty += q;
  mix.lines += 1;
}

/** Adds one check. A voided check, or one with no items list, adds nothing (not even to checks). */
export function addCheckToMix(mix, check, resolver, catKeyOf = null) {
  if (!isLiveCheck(check) || !Array.isArray(check.items)) return;
  mix.checks += 1;
  for (const line of check.items) addLineToMix(mix, line, resolver, catKeyOf);
}

export function mixFromChecks(checks, resolver, catKeyOf = null) {
  const mix = newMix();
  for (const c of Array.isArray(checks) ? checks : []) addCheckToMix(mix, c, resolver, catKeyOf);
  return mix;
}

// ── shares ────────────────────────────────────────────────────────────────────

/**
 * Whole numbers that add to exactly `total`, each in proportion to its value (largest remainder:
 * floor each exact part, then hand the missing points one each to the largest fractions, the
 * earlier index winning a tie). All zeros when the values sum to 0 or total is 0. A negative
 * value counts as 0. wholeShares is this with a total of 100; a group's categories take its
 * whole share as their total, so they add up to the group (8 Oct 2026, review).
 */
export function splitWhole(values, total) {
  const vals = (Array.isArray(values) ? values : []).map((v) => Math.max(0, Number(v) || 0));
  const sum = vals.reduce((s, v) => s + v, 0);
  const whole = Math.max(0, Math.round(Number(total) || 0));
  if (sum <= 0 || whole <= 0) return vals.map(() => 0);
  const exact = vals.map((v) => (v / sum) * whole);
  const out = exact.map((x) => Math.floor(x));
  let left = whole - out.reduce((s, v) => s + v, 0);
  const order = exact.map((x, i) => ({ i, frac: x - out[i] })).sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
  for (let k = 0; k < order.length && left > 0; k++, left--) out[order[k].i] += 1;
  return out;
}

/** Whole percents of the sum that add to exactly 100 (see splitWhole). */
export function wholeShares(values) {
  return splitWhole(values, 100);
}

/**
 * 8 Oct 2026 (review): the share of item sales with no group, by the SAME largest remainder pass
 * as the group shares, so the callout's figure and the Other sales tile never differ by a point
 * at the setup threshold. Unresolved money is always inside the 'other' group (the resolver's
 * fallback), so the pass runs over the groups with 'other' split into its chosen and its
 * unresolved parts; the unresolved part's whole percent is the answer. When every penny of
 * 'other' is unresolved this is exactly that group's share.
 */
function unresolvedShare(groups, unresolved) {
  if (!(unresolved > 0)) return 0;
  const vals = [];
  let at = -1;
  for (const g of groups) {
    if (g.key === OTHER_GROUP) { vals.push(Math.max(0, (g.money || 0) - unresolved)); at = vals.length; vals.push(unresolved); }
    else vals.push(g.money || 0);
  }
  if (at < 0) { at = vals.length; vals.push(unresolved); }
  return wholeShares(vals)[at];
}

/** '+3 pts', '-2 pts', '0 pts'; '' when there is no comparison. */
export function ptsText(pts) {
  if (pts == null) return '';
  return `${pts > 0 ? '+' : ''}${pts} pts`;
}

// ── views ─────────────────────────────────────────────────────────────────────

/** Fixed tones for the suggested keys; every other key takes the first cycle tone not held, in list order; then the spare. */
export function tonesFor(keys) {
  const out = {};
  const held = new Set();
  const list = Array.isArray(keys) ? keys : [];
  for (const k of list) if (GROUP_TONES[k]) { out[k] = GROUP_TONES[k]; held.add(GROUP_TONES[k]); }
  let i = 0;
  for (const k of list) {
    if (out[k]) continue;
    while (i < TONE_CYCLE.length && held.has(TONE_CYCLE[i])) i++;
    if (i < TONE_CYCLE.length) { out[k] = TONE_CYCLE[i]; held.add(TONE_CYCLE[i]); i++; } else out[k] = TONE_SPARE;
  }
  return out;
}

// Money desc, ties by name, 'other' always last whatever its size.
function orderGroups(list) {
  return list.sort((a, b) => {
    if (a.key === OTHER_GROUP) return 1;
    if (b.key === OTHER_GROUP) return -1;
    return (b.money - a.money) || String(a.name).localeCompare(String(b.name), 'en');
  });
}

// Shares, comparison shares, points and tones over an ordered group list; mutates and returns it.
function finishGroups(groups, { cmpTotal, hasCmp }) {
  const shares = wholeShares(groups.map((g) => g.money));
  const cmpShares = hasCmp ? wholeShares(groups.map((g) => g.cmp_money)) : null;
  const tones = tonesFor(groups.map((g) => g.key));
  groups.forEach((g, i) => {
    g.share = shares[i];
    g.cmp_share = hasCmp ? cmpShares[i] : null;
    g.pts = hasCmp && cmpTotal > 0 ? g.share - g.cmp_share : null;
    g.tone = tones[g.key];
    g.money = r2(g.money);
    g.cmp_money = r2(g.cmp_money);
    g.unresolved = r2(g.unresolved);
    g.avg_price = g.qty ? r2(g.money / g.qty) : null;
  });
  return groups;
}

/**
 * The MixBlock every surface draws: groups money desc with "Other sales" last, whole percent
 * shares adding to 100, the comparison period's share and the change in points, and the top
 * categories inside each group. A group present only in the comparison appears with money 0.
 */
export function mixView(mix, cmpMix = null, resolver, { topCats = 3, nameOf = null } = {}) {
  const m = mix || newMix();
  const hasCmp = !!cmpMix;
  const keys = new Set([...m.groups.keys(), ...(hasCmp ? cmpMix.groups.keys() : [])]);
  const name = (key) => (key === OTHER_GROUP ? OTHER_NAME : (nameOf ? nameOf(key) : resolver.groupName(key)));
  const allItems = new Set();
  const groups = [];
  for (const key of keys) {
    const e = m.groups.get(key);
    const ce = hasCmp ? cmpMix.groups.get(key) : null;
    for (const it of e?.items ?? []) allItems.add(it);
    const cats = [...(e?.cats.values() ?? [])].sort((a, b) => b.money - a.money);
    const catShares = wholeShares(cats.map((c) => c.money));
    groups.push({
      key, name: name(key), tone: null,
      money: e?.money || 0, share: 0, cmp_money: ce?.money || 0, cmp_share: null, pts: null,
      qty: e?.qty || 0, lines: e?.lines || 0, items: e?.items.size || 0, avg_price: null, unresolved: e?.unresolved || 0,
      categories: cats.slice(0, topCats).map((c, i) => ({ id: c.id, label: c.label, money: r2(c.money), qty: c.qty, share: catShares[i] })),
    });
  }
  orderGroups(groups);
  const total = m.total;
  const cmpTotal = hasCmp ? cmpMix.total : null;
  // Before finishGroups rounds the money: the same raw figures the group shares are cut from.
  const unresolved_share = total > 0 ? unresolvedShare(groups, m.unresolved) : 0;
  return {
    basis: MIX_BASIS,
    total: r2(total), cmp_total: hasCmp ? r2(cmpTotal) : null,
    qty: m.qty, lines: m.lines, checks: m.checks, items: allItems.size,
    unresolved: r2(m.unresolved), unresolved_share,
    groups: finishGroups(groups, { cmpTotal, hasCmp }),
  };
}

/**
 * Several venues' blocks added per group key. ONLY ever over blocks of one currency. items are
 * added across venues (not distinct). categories are left empty: venue ids differ.
 */
export function mixRollup(blocks, { nameOf = null } = {}) {
  const list = (Array.isArray(blocks) ? blocks : []).filter(Boolean);
  if (!list.length) return null;
  const sum = { total: 0, cmp_total: null, qty: 0, lines: 0, checks: 0, items: 0, unresolved: 0 };
  const byKey = new Map();
  for (const b of list) {
    sum.total += b.total || 0;
    if (b.cmp_total != null) sum.cmp_total = (sum.cmp_total || 0) + b.cmp_total;
    sum.qty += b.qty || 0; sum.lines += b.lines || 0; sum.checks += b.checks || 0; sum.items += b.items || 0;
    sum.unresolved += b.unresolved || 0;
    for (const g of b.groups || []) {
      let e = byKey.get(g.key);
      if (!e) byKey.set(g.key, (e = { key: g.key, name: null, tone: null, money: 0, share: 0, cmp_money: 0, cmp_share: null, pts: null, qty: 0, lines: 0, items: 0, avg_price: null, unresolved: 0, categories: [] }));
      e.money += g.money || 0; e.cmp_money += g.cmp_money || 0; e.qty += g.qty || 0; e.lines += g.lines || 0; e.items += g.items || 0; e.unresolved += g.unresolved || 0;
      if (e.name == null && g.name && g.name !== fallbackName(g.key)) e.name = g.name;
    }
  }
  const groups = [...byKey.values()].map((e) => ({ ...e, name: e.key === OTHER_GROUP ? OTHER_NAME : (nameOf ? nameOf(e.key) : (e.name || fallbackName(e.key))) }));
  orderGroups(groups);
  const hasCmp = sum.cmp_total != null;
  const cmpTotal = sum.cmp_total;
  const unresolved_share = sum.total > 0 ? unresolvedShare(groups, sum.unresolved) : 0;
  return {
    basis: MIX_BASIS,
    total: r2(sum.total), cmp_total: hasCmp ? r2(sum.cmp_total) : null,
    qty: sum.qty, lines: sum.lines, checks: sum.checks, items: sum.items,
    unresolved: r2(sum.unresolved), unresolved_share,
    groups: finishGroups(groups, { cmpTotal, hasCmp }),
  };
}

/**
 * The owner card's thin bar: the top named groups by money plus one folded segment. The fold
 * takes the single group's own name and tone when it holds exactly one group with sales, else
 * it is "Other" in grey. Nothing named at all gives one "Other sales" segment.
 *
 * 8 Oct 2026 (review): a segment's share and points are the block's OWN whole shares added up,
 * never a second rounding over the segments alone. A group that sold in the comparison and
 * nothing now is not drawn, but its comparison money stays in the block's denominator, so the
 * points on the card are the very points the Sales mix detail card and the Back Office tile show
 * for that group (D2: every surface agrees). The drawn shares still add to 100: a group that is
 * not drawn has no money, so its share is 0.
 */
export function barSegments(block, max = 3) {
  if (!block || !(block.total > 0)) return [];
  const groups = Array.isArray(block.groups) ? block.groups : [];
  const named = groups.filter((g) => g.key !== OTHER_GROUP);
  const single = [{ key: OTHER_GROUP, name: OTHER_NAME, share: 100, pts: null, tone: GROUP_TONES.other }];
  if (!named.length) return single;
  const headN = Math.max(1, max - 1);
  const head = named.slice(0, headN).filter((g) => g.money > 0);
  const rest = [...named.slice(headN), ...groups.filter((g) => g.key === OTHER_GROUP)].filter((g) => g.money > 0);
  const hasPts = block.cmp_total > 0;
  const seg = (list, key, name, tone) => {
    const share = list.reduce((s, g) => s + (g.share || 0), 0);
    const was = list.reduce((s, g) => s + (g.cmp_share || 0), 0);
    return { key, name, share, pts: hasPts ? share - was : null, tone };
  };
  const segs = head.map((g) => seg([g], g.key, g.name, g.tone));
  if (rest.length === 1) segs.push(seg(rest, rest[0].key, rest[0].name, rest[0].tone));
  else if (rest.length > 1) segs.push(seg(rest, 'rest', 'Other', GROUP_TONES.other));
  return segs.length ? segs : single;
}

/** "Food 62%  Drinks 31%  Other 7%" (two spaces between). */
export function mixWords(segments) {
  return (Array.isArray(segments) ? segments : []).map((s) => `${s.name} ${s.share}%`).join('  ');
}

/** More than half of item sales have no group: open the setup. */
export function needsSetup(block) {
  return !!block && block.total > 0 && block.unresolved_share > 50;
}

/** Every live penny is unresolved: nothing is set up at all. */
export function allOther(block) {
  return !!block && block.total > 0 && r2(block.unresolved) >= r2(block.total);
}

// ── series ────────────────────────────────────────────────────────────────────

const byMoneyOtherLast = (totals) => [...totals.entries()]
  .sort((a, b) => (a[0] === OTHER_GROUP ? 1 : b[0] === OTHER_GROUP ? -1 : (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0]), 'en')))
  .map(([k]) => k);

/**
 * The time axis of the share chart, LINE level (_filters.mixSeries is per check, one key per
 * check, so it cannot split one check between groups). One bucket per venue business day; or,
 * when every live check is on one business day (or hourly is forced), one per hour of the
 * venue's wall clock in the order the day runs (from the day start's hour, as _filters.mixSeries
 * does). Bucket: { key, total, [groupKey]: money }. Returns { series, xKeys, isHourly, keys }.
 */
export function mixSeriesLines(checks, resolver, clock, { hourly = null } = {}) {
  const tz = venueZone(clock?.timeZone);
  const dayStart = clock?.dayStart || '00:00';
  const live = [];
  for (const c of Array.isArray(checks) ? checks : []) {
    if (!isLiveCheck(c) || !Array.isArray(c.items)) continue;
    const ms = closedMsOf(c);
    if (ms == null) continue;
    live.push({ c, ms, day: businessDayOf(ms, tz, dayStart) });
  }
  const isHourly = hourly === true || (hourly == null && live.length > 0 && live.every((x) => x.day === live[0].day));
  const series = {};
  const totals = new Map();
  for (const { c, ms, day } of live) {
    const bucket = isHourly ? String(Math.floor(wallClock(ms, tz).minutes / 60)) : day;
    const b = (series[bucket] ||= { key: bucket, total: 0 });
    for (const line of c.items) {
      if (!isLiveLine(line)) continue;
      const v = lineSales(line);
      const k = resolver.itemGroup(line).key;
      b[k] = (b[k] || 0) + v;
      b.total += v;
      totals.set(k, (totals.get(k) || 0) + v);
    }
  }
  const keys = byMoneyOtherLast(totals);
  for (const b of Object.values(series)) for (const k of keys) if (b[k] == null) b[k] = 0;
  const startHour = Math.floor((dayStartMinutes(dayStart) ?? 0) / 60);
  const hourOfDay = (k) => (Number(k) - startHour + 24) % 24;
  const xKeys = Object.keys(series).sort((a, b) => (isHourly ? hourOfDay(a) - hourOfDay(b) : (a < b ? -1 : a > b ? 1 : 0)));
  return { series, xKeys, isHourly, keys };
}

/** The same series with each bucket's money turned into whole percents of that bucket (100 in all, or 0 for an empty bucket). */
export function shareSeries(s) {
  const keys = s?.keys || [];
  const out = {};
  for (const [bucket, b] of Object.entries(s?.series || {})) {
    const shares = wholeShares(keys.map((k) => b[k] || 0));
    const row = { key: bucket, total: shares.reduce((t, v) => t + v, 0) };
    keys.forEach((k, i) => { row[k] = shares[i]; });
    out[bucket] = row;
  }
  return { series: out, xKeys: s?.xKeys || [], isHourly: !!s?.isHourly, keys };
}

// ── dayparts ──────────────────────────────────────────────────────────────────

/** 'HH:MM' (or 'HH:MM:SS') to minutes after midnight; null when it is not a time. */
export function clockMinutes(hhmm) {
  const m = /^\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*$/.exec(String(hhmm ?? ''));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * The service period an instant falls in on the venue's wall clock (a copy of
 * _filters.classifyShift, which this file cannot import from Deno): start inclusive, end
 * exclusive, an overnight period (end before start) honoured. null outside every period.
 */
export function shiftOf(ms, shifts, timeZone) {
  if (!Number.isFinite(ms) || !Array.isArray(shifts) || !shifts.length) return null;
  const minutes = wallClock(ms, venueZone(timeZone)).minutes;
  for (const s of shifts) {
    const start = clockMinutes(s?.start);
    const end = clockMinutes(s?.end);
    if (start == null || end == null) continue;
    const inside = end > start ? (minutes >= start && minutes < end) : (minutes >= start || minutes < end);
    if (inside) return s;
  }
  return null;
}

/** The fallback band for a wall clock hour, given the business day's start hour. */
export function bandOf(hour, dayStartHour) {
  const h = Number(hour) || 0;
  if (h >= 11 && h < 14) return DAY_BANDS[1];
  if (h >= 14 && h < 17) return DAY_BANDS[2];
  if (h >= 17 || h < (Number(dayStartHour) || 0)) return DAY_BANDS[3];
  return DAY_BANDS[0];
}

const validShifts = (shifts) => (Array.isArray(shifts) ? shifts : []).filter((s) => clockMinutes(s?.start) != null && clockMinutes(s?.end) != null);

/**
 * Item sales by group within each service period (locationConfig.shifts) or, when none are
 * set, within the four DAY_BANDS. rows: [{ id, name, sub, total, share, groups, shares }],
 * share of all item sales and shares within the row. In shifts mode a check outside every
 * period lands in an "Outside service periods" row, present only when there is one.
 */
export function daypartSplit(checks, resolver, clock, shifts) {
  const tz = venueZone(clock?.timeZone);
  const good = validShifts(shifts);
  const mode = good.length ? 'shifts' : 'bands';
  const dayStartHour = Math.floor(dayStartMinutes(clock?.dayStart || '00:00') / 60);
  const rows = new Map();
  const row = (id, name, sub) => {
    let r = rows.get(id);
    if (!r) rows.set(id, (r = { id, name, sub, total: 0, groups: {} }));
    return r;
  };
  if (mode === 'shifts') for (const s of good) row(String(s.id || s.name), String(s.name || s.id || ''), `${s.start} to ${s.end}`);
  else for (const b of DAY_BANDS) row(b.id, b.name, b.sub);
  const outside = { count: 0, money: 0 };
  const totals = new Map();
  for (const c of Array.isArray(checks) ? checks : []) {
    if (!isLiveCheck(c) || !Array.isArray(c.items)) continue;
    const ms = closedMsOf(c);
    if (ms == null) continue;
    let r;
    if (mode === 'shifts') {
      const s = shiftOf(ms, good, tz);
      if (s) r = row(String(s.id || s.name), String(s.name || s.id || ''), `${s.start} to ${s.end}`);
      else { r = row(OUTSIDE_ID, OUTSIDE_NAME, ''); outside.count += 1; }
    } else {
      const b = bandOf(Math.floor(wallClock(ms, tz).minutes / 60), dayStartHour);
      r = row(b.id, b.name, b.sub);
    }
    for (const line of c.items) {
      if (!isLiveLine(line)) continue;
      const v = lineSales(line);
      const k = resolver.itemGroup(line).key;
      r.groups[k] = (r.groups[k] || 0) + v;
      r.total += v;
      totals.set(k, (totals.get(k) || 0) + v);
      if (r.id === OUTSIDE_ID) outside.money += v;
    }
  }
  const keys = byMoneyOtherLast(totals);
  const list = [...rows.values()].filter((r) => r.id !== OUTSIDE_ID || outside.count > 0);
  const rowShares = wholeShares(list.map((r) => r.total));
  const out = list.map((r, i) => {
    const vals = keys.map((k) => r.groups[k] || 0);
    const shares = wholeShares(vals);
    const groups = {}, sh = {};
    keys.forEach((k, j) => { groups[k] = r2(vals[j]); sh[k] = shares[j]; });
    return { id: r.id, name: r.name, sub: r.sub, total: r2(r.total), share: rowShares[i], groups, shares: sh };
  });
  return { mode, rows: out, keys, outside: { count: outside.count, money: r2(outside.money) } };
}

// ── reconcile (Back Office only) ──────────────────────────────────────────────

/**
 * How the groups tie to the Z report's Gross sales. 8 Oct 2026 (review): the Z report's Gross
 * sales is the stored subtotal of EVERY check in the list, voided ones too (salesStats.js
 * computeSalesStats adds c.subtotal for each check and takes voids off later), while the mix
 * skips voided checks. So: gross = every check's subtotal (the Z report's figure), voided and
 * voidedSubtotal = the voided checks and what they held, subtotal = the live checks' subtotals
 * (gross less voidedSubtotal), off = live checks whose stored subtotal is not the sum of their
 * live lines, diff = subtotal less the mix total.
 */
export function reconcile(checks, mixTotal) {
  let gross = 0, subtotal = 0, voidedSubtotal = 0, voided = 0, off = 0;
  for (const c of Array.isArray(checks) ? checks : []) {
    if (!c) continue;
    const sub = Number(c.subtotal) || 0;
    gross += sub;
    if (!isLiveCheck(c)) { voided += 1; voidedSubtotal += sub; continue; }
    subtotal += sub;
    const lines = (Array.isArray(c.items) ? c.items : []).reduce((s, i) => s + (isLiveLine(i) ? lineSales(i) : 0), 0);
    if (r2(sub) !== r2(lines)) off += 1;
  }
  return { gross: r2(gross), voided, voidedSubtotal: r2(voidedSubtotal), subtotal: r2(subtotal), off, diff: r2(subtotal - (Number(mixTotal) || 0)) };
}

// ── the setup list ────────────────────────────────────────────────────────────

/**
 * The "Set up groups" panel's rows: one per TOP LEVEL category with its stored text, its key,
 * whether it is set, its sales in the period on screen (its own and its descendants'), how many
 * sub categories follow it, how many of those carry their own group, and whether the site's
 * Xero mapping overrides it (that wins). Sorted money desc then label.
 */
export function setupRows(categories, mapping, mix, resolver) {
  const cats = toResolverCategories(categories);
  const kids = new Map();
  for (const c of cats) {
    const p = c.parent_id == null ? null : String(c.parent_id);
    if (p == null) continue;
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(c);
  }
  const descendants = (root) => {
    const out = [];
    const seen = new Set([root.id]);
    let level = [root];
    for (let depth = 0; depth < 12 && level.length; depth++) {
      const next = [];
      for (const c of level) for (const k of kids.get(c.id) || []) { if (seen.has(k.id)) continue; seen.add(k.id); out.push(k); next.push(k); }
      level = next;
    }
    return out;
  };
  const moneyByCat = new Map();
  for (const e of mix?.groups?.values?.() ?? []) {
    for (const c of e.cats.values()) if (c.id != null) moneyByCat.set(String(c.id), (moneyByCat.get(String(c.id)) || 0) + c.money);
  }
  const catGroups = mapping?.categoryGroups && typeof mapping.categoryGroups === 'object' ? mapping.categoryGroups : {};
  const rows = cats.filter((c) => c.parent_id == null).map((c) => {
    const text = c.accounting_group;
    const key = groupKeyOf(text);
    const subs = descendants(c);
    const money = [c, ...subs].reduce((s, x) => s + (moneyByCat.get(x.id) || 0), 0);
    const xk = catGroups[c.id];
    return {
      id: c.id, label: c.label, text, key, set: key !== '', money,
      share: 0,
      subCount: subs.length,
      subOwn: subs.filter((x) => { const k = groupKeyOf(x.accounting_group); return k !== '' && k !== key; }).length,
      xero: typeof xk === 'string' && xk ? { key: xk, name: resolver?.groupName?.(xk) ?? fallbackName(xk) } : null,
    };
  });
  rows.sort((a, b) => (b.money - a.money) || String(a.label).localeCompare(String(b.label), 'en'));
  const shares = wholeShares(rows.map((r) => r.money));
  rows.forEach((r, i) => { r.share = shares[i]; r.money = r2(r.money); });
  return {
    rows,
    total: rows.length,
    unset: rows.filter((r) => !r.set).length,
    itemOverrides: Object.keys(mapping?.itemGroups && typeof mapping.itemGroups === 'object' ? mapping.itemGroups : {}).length,
  };
}

/** Which dropdown option a stored text is: '' (none), a suggested word, or 'custom'. */
export function optionFor(text) {
  const k = groupKeyOf(text);
  if (k === '') return '';
  const word = SUGGESTED_GROUPS.find((w) => groupKeyOf(w) === k);
  return word || 'custom';
}
