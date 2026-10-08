// supabase/functions/_shared/accountingGroups.js
//
// THE DAY BY SALES GROUP AND TAX RATE (30 Sep 2026). The daily sales invoice
// (_shared/xeroInvoicePlan.js) posts one line per sales group ("Hot drinks", "Cold food")
// and tax rate, minus lines per discount group, like Lightspeed's "invoices by accounting
// groups". This file works out those amounts from the same closed_checks rows, with the same
// rules, as _shared/accountingDay.js (which it does not change: trading-report and
// owner-snapshot ship that file). Pure JS, imports only accountingDay.js, so `npm test`
// loads exactly what ships.
//
// Refunds: a refund that lists its own items, all with a known rate, puts its goods at those
// items' rates (the VAT per rate stays exactly the summary's); otherwise the summary's split.
//
// Per check and tax bucket r (the check's own split, from checkTenderParts):
//   goods_r    the goods money of every tender part at r, loyalty and promo credit included
//   D_r        the check's discounts at r, placed the way the till charged them (src/lib/
//              taxBasis.js allocateCheckBasis): an item's own discount (items[].discount, which
//              is where POSSurface keeps "Selected items" and category presets such as Staff
//              drinks) on that item; an auto discount on the items it names (appliedItems, by
//              saving); the rest of a check discount pro rata by the value after item discounts
//   gross_r    goods_r + D_r, shared over the check's items at r by their value BEFORE any
//              discount, then summed per sales group (so each group shows its full sales and
//              the discount lines show what was taken off); gift cards sold (items with
//              isGiftCard) are carved out first
// So, per rate, exactly:
//   sum of groups + gift cards sold - discounts - credits = the day's money sales at r
// (summary.sales.totals.byRate[r].sales), and the invoice ties to the till to the penny. For
// refunds the same holds for the day's total (and per rate for the VAT).
// Refunds use the refund entry's own items (else the check's) to weigh groups, by the value
// after each item's own discount (a refund posts the money back, with no discount lines).
//
// Which group an item is in (makeGroupResolver), first match wins:
//   1. mapping.itemGroups[itemId]
//   2. mapping.categoryGroups[category]
//   3. mapping.categoryGroups on the category's parents
//   4. the category's accounting_group text (Menu Manager), as a group of that name
//   5. a parent's accounting_group
//   6. 'other' (Other sales, warned about)
// A category id from another venue resolves through master_id to this venue's copy.

import {
  buildAccountingDay, checkTenderParts, refundParts, isVoidedCheck, taxContext, allocate, toMinor,
} from './accountingDay.js';

export const OTHER_GROUP = 'other';
export const DISCOUNT_GROUPS = ['customer', 'loyalty', 'staff', 'comp', 'promo'];
export const DISCOUNT_GROUP_NAMES = {
  customer: 'Customer discounts', loyalty: 'Loyalty rewards', staff: 'Staff discounts', comp: 'Comps and waste', promo: 'Promotions',
};

/** A group key from free text: lower case letters, digits and dashes, at most 40 characters. '' when nothing is left. */
export function groupKeyOf(text) {
  return String(text ?? '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

/** The discount group a till discount label belongs to when the mapping names none. */
export function discountGroupOf(label) {
  const s = String(label ?? '').toLowerCase();
  if (/staff|off\s*shift|employee|team/.test(s)) return 'staff';
  if (/comp\b|comp\s|\bcomp|waste|100\s*%/.test(s)) return 'comp';
  if (/loyal|reward|stamp|points/.test(s)) return 'loyalty';
  if (/promo|code|voucher|coupon/.test(s)) return 'promo';
  return 'customer';
}

/** The discount group of a loyalty or promo credit tender (never money: it lowers the sale). */
export function creditGroupOf(method) {
  return /loyal|reward|stamp|points/.test(String(method ?? '').toLowerCase()) ? 'loyalty' : 'promo';
}

const stemOf = (id) => String(id ?? '').replace(/_[0-9a-f]{8}$/i, '');

/**
 * The item and discount classifier for one venue. `categories` are menu_categories rows
 * { id, parent_id, label, accounting_group, master_id, local } where `local` marks this venue's
 * own rows (the loader also reads foreign ids seen on checks, local false).
 */
/**
 * @param {any} [mapping]
 * @param {any[]} [categories]
 * @returns {any}
 */
export function makeGroupResolver(mapping = {}, categories = []) {
  const m = mapping && typeof mapping === 'object' ? mapping : {};
  const byId = new Map();
  const localByStem = new Map();
  for (const c of Array.isArray(categories) ? categories : []) {
    if (!c || c.id == null) continue;
    byId.set(String(c.id), c);
  }
  for (const c of byId.values()) {
    if (c.local === false) continue;
    const stem = String(c.master_id || stemOf(c.id));
    if (!localByStem.has(stem)) localByStem.set(stem, c);
  }
  const localCat = (id) => {
    if (id == null || id === '') return null;
    const own = byId.get(String(id));
    if (own && own.local !== false) return own;
    const stem = String(own?.master_id || stemOf(id));
    return localByStem.get(stem) || null;
  };
  const catGroups = m.categoryGroups && typeof m.categoryGroups === 'object' ? m.categoryGroups : {};
  const itemGroups = m.itemGroups && typeof m.itemGroups === 'object' ? m.itemGroups : {};
  const agNames = new Map();
  const chain = (cat) => {
    const out = [];
    const seen = new Set();
    for (let c = cat; c && !seen.has(c.id) && out.length < 12; c = localCat(c.parent_id)) { seen.add(c.id); out.push(c); }
    return out;
  };
  const cache = new Map();

  /** { key, catId, resolved } for one check item. */
  const itemGroup = (item) => {
    const itemId = item?.itemId ?? item?.id ?? null;
    if (itemId != null && typeof itemGroups[itemId] === 'string' && itemGroups[itemId]) {
      const cat = localCat(item?.cat || item?.cats?.[0]);
      return { key: itemGroups[itemId], catId: cat ? String(cat.id) : null, resolved: true };
    }
    const rawCat = item?.cat || (Array.isArray(item?.cats) ? item.cats[0] : null) || null;
    const ck = String(rawCat ?? '');
    if (cache.has(ck)) return cache.get(ck);
    const cat = localCat(rawCat);
    const list = chain(cat);
    let out = null;
    for (const c of list) {
      const k = catGroups[c.id];
      if (typeof k === 'string' && k) { out = { key: k, catId: String(cat.id), resolved: k !== OTHER_GROUP }; break; }
    }
    if (!out) {
      for (const c of list) {
        const text = String(c.accounting_group ?? '').trim();
        const k = groupKeyOf(text);
        if (k) { if (!agNames.has(k)) agNames.set(k, text); out = { key: k, catId: String(cat.id), resolved: true }; break; }
      }
    }
    if (!out) out = { key: OTHER_GROUP, catId: cat ? String(cat.id) : null, resolved: false };
    cache.set(ck, out);
    return out;
  };

  const discountGroup = (label) => {
    const k = m.discounts?.labels?.[label];
    return typeof k === 'string' && DISCOUNT_GROUPS.includes(k) ? k : discountGroupOf(label);
  };

  const groupName = (key) => {
    const g = m.groups?.[key];
    if (g && typeof g.name === 'string' && g.name.trim()) return g.name.trim();
    if (agNames.has(key)) return agNames.get(key);
    if (key === OTHER_GROUP) return 'Other sales';
    return String(key).replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
  };

  const categoryLabel = (id) => byId.get(String(id))?.label || null;

  return { itemGroup, discountGroup, creditGroup: creditGroupOf, groupName, localCat, categoryLabel };
}

// ── helpers ──────────────────────────────────────────────────────────────────

const ratesOf = (p) => (p && p.byRate ? p.byRate : ((p?.sales || p?.tax) ? { default: { sales: p.sales || 0, tax: p.tax || 0 } } : {}));
const add = (obj, k, v) => { if (v) obj[k] = (obj[k] || 0) + v; };
const bucketBlank = (withDiscounts) => (withDiscounts ? { goods: {}, discounts: {}, credits: {}, gift: 0 } : { goods: {}, credits: {}, gift: 0 });
const isGift = (i) => !!(i?.isGiftCard || i?.giftCard === true || i?.is_gift_card);
const qtyOf = (i, refund) => {
  const q = Number(refund ? (i?.refundQty ?? i?.qty ?? 1) : (i?.qty ?? 1));
  return Number.isFinite(q) && q > 0 ? q : 0;
};
const valueOf = (i, refund) => Math.max(0, Math.round(Number(i?.price || 0) * qtyOf(i, refund) * 100));

/**
 * The line after its OWN item discount, in minor units (taxBasis.lineAfterItemDiscount's maths:
 * a percent off the line, or an amount off the whole line). For a refund, the part refunded.
 */
function afterItemDiscount(i, refund) {
  const base = valueOf(i, refund);
  const d = i?.discount;
  if (!d || typeof d !== 'object') return base;
  const v = Number(d.value);
  if (!Number.isFinite(v) || v <= 0) return base;
  let after;
  if (d.type === 'percent') after = Math.round(base * (1 - v / 100));
  else {
    const all = qtyOf(i, false) || 1;
    const share = refund ? Math.min(1, qtyOf(i, true) / all) : 1;
    after = base - Math.round(v * 100 * share);
  }
  return Math.max(0, Math.min(base, after));
}

const itemDiscountLabel = (i) => String(i?.discount?.label || i?.discount?.name || 'Item discount');

// A check discount's amount in minor units: as recorded, else worked out as the till does
// (percent of the subtotal after item discounts, else its value).
function checkDiscountMinor(d, subtotalAfter) {
  if (d.amount != null && d.amount !== '' && Number.isFinite(Number(d.amount))) return Math.max(0, toMinor(d.amount));
  const v = Number(d.value);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.max(0, d.type === 'percent' ? Math.round((subtotalAfter * v) / 100) : toMinor(v));
}

// The check's order type, for items whose rate depends on it (taxOverrides { 'dine-in': id, takeaway: id }).
const orderTypeOf = (row) => row?.tax_breakdown?.taxV2?.orderType || row?.order_type || row?.orderType || null;

// 8 Oct 2026: which override key a sale's order type reads when the item has none under its own
// key. MIRRORS src/lib/taxRule.js TAX_ORDER_TYPE_ALIASES (the till books with it; this file cannot
// import src/lib): collection and drive thru read Takeaway, a bar tab reads Bar. Change both
// together, or the Xero split by rate stops matching the VAT the till booked.
const TAX_ORDER_TYPE_ALIASES = { collection: 'takeaway', 'drive-thru': 'takeaway', 'bar-tab': 'bar' };
function itemOverrideFor(item, ot) {
  const ov = item?.taxOverrides;
  if (!ov || typeof ov !== 'object' || !ot) return null;
  if (ov[ot] !== undefined) return ov[ot];
  const alias = TAX_ORDER_TYPE_ALIASES[ot];
  return alias && ov[alias] !== undefined ? ov[alias] : null;
}

/**
 * Which of the check's tax buckets an item sits in: its own rate (the order type override
 * first, read as the till reads it) when the check has that bucket, else a bucket at the same
 * percentage, else null (estimated: spread over the check's buckets by their goods).
 */
function itemBucket(item, row, keys, bucketList, taxCtx) {
  if (keys.length === 1) return keys[0];
  const ot = orderTypeOf(row);
  const ov = itemOverrideFor(item, ot);
  const rateId = ov || item?.taxRateId || null;
  if (rateId == null) return null;
  if (keys.includes(`rate:${rateId}`)) return `rate:${rateId}`;
  const pct = taxCtx?.byId?.get(String(rateId))?.pct;
  if (pct == null) return null;
  const b = bucketList.find((x) => x && x.pct === pct && keys.includes(x.key));
  return b ? b.key : null;
}

/**
 * Spread `values` (one per item, minor units) over the rate keys: an item with a known bucket
 * goes there whole; one with none is split over `keys` by `weights`. Returns per item a map
 * { [rateKey]: minor } and whether any item was estimated.
 */
function placeItems(items, values, bucketsOf, keys, weights) {
  let estimated = false;
  const placed = items.map((it, i) => {
    const k = bucketsOf[i];
    if (k) return { [k]: values[i] };
    estimated = true;
    const split = allocate(values[i], keys.map((x) => weights[x] || 0));
    const out = {};
    keys.forEach((x, j) => { if (split[j]) out[x] = split[j]; });
    return out;
  });
  return { placed, estimated };
}

/**
 * Share one check's (or one refund's) goods per rate over its items, by group.
 *   goods     { [r]: minor } the goods money per rate (credits included)
 *   extra     { [r]: minor } discounts added back per rate (sales only)
 *   sources   [{ items, placed }] the items to weigh by, in order: the first with any value at a
 *             rate is used for that rate (a refund's own items, then the check's). Non gift items
 *             get groups; gift cards are carved out.
 * Writes into `side[r].goods` / `side[r].gift` and returns { unresolved, giftVat }.
 */
function spreadGroups(side, goods, extra, sources, resolver, ctx) {
  const keys = Object.keys(goods);
  let unresolved = 0, giftVat = false;
  for (const r of new Set([...keys, ...Object.keys(extra)])) {
    const total = (goods[r] || 0) + (extra[r] || 0);
    if (!total) continue;
    const b = side[r] || (side[r] = ctx.blank());
    // Gift cards sold at this rate, capped at what the rate holds.
    let giftVal = 0;
    const plain = [];
    const src = sources.find((x) => x.items.some((_, i) => (x.placed[i][r] || 0) > 0)) || { items: [], placed: [] };
    src.items.forEach((it, i) => {
      const v = src.placed[i][r] || 0;
      if (!v) return;
      if (isGift(it)) giftVal += v; else plain.push({ it, v });
    });
    const gift = Math.max(0, Math.min(giftVal, total));
    if (gift) {
      b.gift += gift;
      if (ctx.pctOf(r) > 0) giftVat = true;
    }
    const rest = total - gift;
    if (!rest) continue;
    if (!plain.length) {
      add(b.goods, 'other', rest);
      unresolved += rest;
      ctx.noteCategory(null, 'other', rest);
      continue;
    }
    const shares = allocate(rest, plain.map((p) => p.v));
    plain.forEach((p, i) => {
      if (!shares[i]) return;
      const g = resolver.itemGroup(p.it);
      add(b.goods, g.key, shares[i]);
      if (!g.resolved) unresolved += shares[i];
      ctx.noteCategory(g.catId, g.key, shares[i]);
    });
  }
  return { unresolved, giftVat };
}

/**
 * The day summed by sales group and tax rate, beside the ordinary summary.
 *   day, saleRows, refundRows, venue, taxRates   exactly as buildAccountingDay
 *   resolver                                     makeGroupResolver(mapping, categories)
 * Returns { summary, groups } with groups = {
 *   sales:   { [rateKey]: { goods: { [group]: minor }, discounts: { [discountGroup]: minor }, credits: { [discountGroup]: minor }, gift: minor } },
 *   refunds: { [rateKey]: { goods, credits, gift } },
 *   names:   { [group]: label },
 *   categories: { [categoryId]: { label, group, goods } }   (sales, before discounts, gift cards left out)
 *   discountLabels: { [label]: { group, amount, count } },
 *   unresolved: { goods, count }, goodsTotal, flags: [{ code, count, checkIds }] }
 * Money is in minor units. Without taxRates every figure sits under the rate key 'default'.
 */
/**
 * @param {{ day: any, saleRows?: any[], refundRows?: any[], venue?: any, taxRates?: any[] | null, resolver?: any }} args
 * @returns {{ summary: any, groups: any }}
 */
export function buildGroupedDay({ day, saleRows = [], refundRows = [], venue = {}, taxRates = null, resolver = makeGroupResolver() }) {
  const summary = buildAccountingDay({ day, saleRows, refundRows, venue, taxRates });
  const taxCtx = Array.isArray(taxRates) ? taxContext(taxRates) : null;
  const pctByKey = new Map((summary.taxBuckets || []).map((b) => [b.key, b.pct]));
  const flags = new Map();
  const flag = (code, id) => {
    const f = flags.get(code) || { code, count: 0, checkIds: [] };
    f.count += 1;
    if (id && f.checkIds.length < 25 && !f.checkIds.includes(id)) f.checkIds.push(id);
    flags.set(code, f);
  };
  const categories = {};
  const discountLabels = {};
  let unresolvedGoods = 0, unresolvedCount = 0, goodsTotal = 0;
  const groups = { sales: {}, refunds: {} };
  let trackCategories = true;
  const ctxFor = (withDiscounts) => ({
    blank: () => bucketBlank(withDiscounts),
    pctOf: (r) => pctByKey.get(r) ?? 0,
    noteCategory: (catId, key, v) => {
      if (!trackCategories) return;
      const id = catId || '(none)';
      const c = categories[id] || (categories[id] = { label: catId ? (resolver.categoryLabel(catId) || catId) : 'No category', group: key, goods: 0 });
      c.goods += v;
    },
  });

  // Sales: the same window, dedupe and void rules as buildAccountingDay.
  const seen = new Set();
  for (const row of saleRows) {
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    const at = Date.parse(row.closed_at);
    if (!(at >= day.fromMs && at < day.toMs)) continue;
    if (isVoidedCheck(row)) continue;
    const { parts, buckets = [] } = checkTenderParts(row, taxCtx);
    const goods = {};
    const creditsBy = {};
    for (const p of parts) {
      for (const [r, v] of Object.entries(ratesOf(p))) {
        add(goods, r, v.sales);
        if (p.kind === 'discount') {
          const c = creditsBy[r] || (creditsBy[r] = {});
          add(c, resolver.creditGroup(p.method), v.sales);
        }
      }
    }
    const moneyKeys = Object.keys(goods).filter((k) => goods[k]);
    if (!moneyKeys.length) continue;
    // A rate the check's breakdown names can hold an item even when no money landed there (a
    // free cookie at 0%): its full price and its discount then post at its own rate.
    const keys = [...moneyKeys, ...buckets.map((b) => b?.key).filter((k) => k && !moneyKeys.includes(k))];
    const items = (Array.isArray(row.items) ? row.items : []).filter((i) => i && typeof i === 'object' && !i.voided && qtyOf(i, false) > 0);
    const values = items.map((i) => valueOf(i, false));
    const afters = items.map((i) => afterItemDiscount(i, false));
    const bucketsOf = items.map((i) => itemBucket(i, row, keys, buckets, taxCtx));
    const { placed, estimated } = placeItems(items, values, bucketsOf, keys, goods);
    if (estimated && items.length) flag('group_rate_estimated', row.id);

    // Discounts per rate and discount group, in whole minor units, placed as the till charged
    // them: each lands on items (then on those items' rates), or on the money's rates when the
    // check lists no items to put it on.
    const extra = {};
    const discPer = {};
    const noteLabel = (label, grp, amt) => {
      const dl = discountLabels[label] || (discountLabels[label] = { group: grp, amount: 0, count: 0 });
      dl.amount += amt; dl.count += 1;
    };
    const put = (grp, perItem, amt) => {
      const perRate = {};
      let placedSum = 0;
      for (const [i, v] of perItem) {
        if (!v) continue;
        const byR = placed[i];
        const ks = Object.keys(byR);
        const tot = ks.reduce((s, k) => s + byR[k], 0);
        const split = allocate(v, ks.map((k) => (tot ? byR[k] : 1)));
        ks.forEach((k, q) => add(perRate, k, split[q]));
        placedSum += v;
      }
      if (amt > placedSum) {
        const split = allocate(amt - placedSum, moneyKeys.map((k) => goods[k]));
        moneyKeys.forEach((k, q) => add(perRate, k, split[q]));
      }
      for (const [r, v] of Object.entries(perRate)) {
        add(extra, r, v);
        const pr = discPer[r] || (discPer[r] = {});
        add(pr, grp, v);
      }
    };
    // 1. Each item's own discount (items[].discount), on that item.
    items.forEach((it, i) => {
      const off = values[i] - afters[i];
      if (off <= 0) return;
      const label = itemDiscountLabel(it);
      const grp = resolver.discountGroup(label);
      noteLabel(label, grp, off);
      put(grp, [[i, off]], off);
    });
    // 2. Check discounts: first what each names (an auto discount's appliedItems by saving; an
    //    older "selected items" entry's itemUids), then the rest pro rata by what is left of each
    //    item after its own discount and those.
    const plainIdx = items.map((it, i) => (isGift(it) ? -1 : i)).filter((i) => i >= 0);
    const remaining = afters.slice();
    const subtotalAfter = afters.reduce((s, v) => s + v, 0);
    const checkDiscounts = [];
    for (const d of Array.isArray(row.discounts) ? row.discounts : []) {
      if (!d || typeof d !== 'object') continue;
      const amt = checkDiscountMinor(d, subtotalAfter);
      if (!amt) continue;
      const label = String(d.label || d.name || 'Discount');
      const grp = resolver.discountGroup(label);
      noteLabel(label, grp, amt);
      const taken = new Map();
      let left = amt;
      if (Array.isArray(d.appliedItems)) {
        for (const ai of d.appliedItems) {
          if (!(left > 0)) break;
          if (ai?.uid == null) continue;
          const i = plainIdx.find((n) => items[n].uid != null && String(items[n].uid) === String(ai.uid));
          if (i == null) continue;
          const take = Math.min(Math.max(0, toMinor(ai.saving)), remaining[i], left);
          if (take > 0) { remaining[i] -= take; left -= take; taken.set(i, (taken.get(i) || 0) + take); }
        }
      } else if ((d.scope === 'item' || d.scope === 'items') && Array.isArray(d.itemUids) && d.itemUids.length) {
        const uids = new Set(d.itemUids.map(String));
        const target = plainIdx.filter((i) => uids.has(String(items[i].uid)));
        const shares = allocate(left, target.map((i) => remaining[i] || values[i]));
        target.forEach((i, j) => { if (shares[j]) { taken.set(i, (taken.get(i) || 0) + shares[j]); left -= shares[j]; } });
        target.forEach((i, j) => { remaining[i] = Math.max(0, remaining[i] - shares[j]); });
      }
      checkDiscounts.push({ grp, amt, taken, left });
    }
    for (const cd of checkDiscounts) {
      if (cd.left > 0 && plainIdx.length) {
        let w = plainIdx.map((i) => remaining[i]);
        if (!w.some((x) => x > 0)) w = plainIdx.map((i) => values[i]);
        if (w.some((x) => x > 0)) {
          const shares = allocate(cd.left, w);
          plainIdx.forEach((i, j) => { if (shares[j]) cd.taken.set(i, (cd.taken.get(i) || 0) + shares[j]); });
        }
      }
      put(cd.grp, [...cd.taken.entries()], cd.amt);
    }
    const res = spreadGroups(groups.sales, goods, extra, [{ items, placed }], resolver, ctxFor(true));
    for (const [r, byG] of Object.entries(discPer)) {
      const b = groups.sales[r] || (groups.sales[r] = bucketBlank(true));
      for (const [g, v] of Object.entries(byG)) add(b.discounts, g, v);
    }
    for (const [r, byG] of Object.entries(creditsBy)) {
      const b = groups.sales[r] || (groups.sales[r] = bucketBlank(true));
      for (const [g, v] of Object.entries(byG)) add(b.credits, g, v);
    }
    if (res.unresolved) { unresolvedGoods += res.unresolved; unresolvedCount += 1; }
    if (res.giftVat) flag('gift_card_vat_charged', row.id);
    goodsTotal += Object.values(goods).reduce((s, v) => s + v, 0) + Object.values(extra).reduce((s, v) => s + v, 0);
  }

  // Refunds: the same rules as buildAccountingDay (refund time, dedupe, skipped entries).
  trackCategories = false;
  const seenRefund = new Set();
  for (const row of refundRows) {
    if (!row || isVoidedCheck(row)) continue;
    const list = Array.isArray(row.refunds) ? row.refunds : [];
    list.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object') return;
      const rid = `${row.id}:${entry.id || i}`;
      if (seenRefund.has(rid)) return;
      seenRefund.add(rid);
      const r = refundParts(entry, row, taxCtx);
      let at = r.atMs;
      if (at == null) at = Date.parse(row.closed_at);
      if (!(at >= day.fromMs && at < day.toMs)) return;
      if (r.skipped) return;
      let goods = {};
      const taxAt = {};
      const creditsBy = {};
      for (const p of r.parts) {
        for (const [k, v] of Object.entries(ratesOf(p))) {
          add(goods, k, v.sales);
          add(taxAt, k, v.tax);
          if (p.kind === 'discount') {
            const c = creditsBy[k] || (creditsBy[k] = {});
            add(c, resolver.creditGroup(p.method), v.sales);
          }
        }
      }
      let keys = Object.keys(goods).filter((k) => goods[k]);
      if (!keys.length) return;
      // The refunded goods follow the refund's OWN items' rates when every item names one: the
      // neutral summary spreads a refund's goods over the check's rates pro rata, which on a
      // mixed rate check puts a 20% latte partly at 0% while its VAT stays at 20% (a credit note
      // line Xero would refuse). The VAT per rate is untouched, so the credit note still ties to
      // the till; only goods move between rates, and the total is the same.
      const own = (Array.isArray(entry.items) ? entry.items : []).filter((it) => it && typeof it === 'object' && !it.voided && qtyOf(it, true) > 0);
      if (keys.length > 1 && own.length && !Object.keys(creditsBy).length && !own.some(isGift)) {
        const at = own.map((it) => itemBucket(it, row, keys, r.buckets || [], taxCtx));
        if (at.every(Boolean)) {
          const perRate = {};
          own.forEach((it, i) => add(perRate, at[i], afterItemDiscount(it, true)));
          const rks = Object.keys(perRate).filter((k) => perRate[k]);
          const total = keys.reduce((sum, k) => sum + goods[k], 0);
          const split = allocate(total, rks.map((k) => perRate[k]));
          const next = {};
          rks.forEach((k, i) => { if (split[i]) next[k] = split[i]; });
          if (rks.length && Object.entries(taxAt).every(([k, t]) => !t || (next[k] || 0) > t)) {
            goods = next;
            keys = Object.keys(goods);
          }
        }
      }
      // The refund's own items weigh the groups; at a rate they do not reach (a refund's goods
      // are split over the check's rates pro rata), the check's items do.
      const sources = [];
      let estimated = false;
      const lists = [[entry.items, true], [row.items, false]];
      for (const [list, own] of lists) {
        const items = (Array.isArray(list) ? list : []).filter((it) => it && typeof it === 'object' && !it.voided && qtyOf(it, own) > 0);
        if (!items.length) continue;
        const values = items.map((it) => afterItemDiscount(it, own));
        const bucketsOf = items.map((it) => itemBucket(it, row, keys, r.buckets || [], taxCtx));
        const placedList = placeItems(items, values, bucketsOf, keys, goods);
        if (placedList.estimated && own === !!(Array.isArray(entry.items) && entry.items.length)) estimated = true;
        sources.push({ items, placed: placedList.placed });
      }
      if (estimated) flag('group_rate_estimated', row.id);
      const res = spreadGroups(groups.refunds, goods, {}, sources, resolver, ctxFor(false));
      for (const [k, byG] of Object.entries(creditsBy)) {
        const b = groups.refunds[k] || (groups.refunds[k] = bucketBlank(false));
        for (const [g, v] of Object.entries(byG)) add(b.credits, g, v);
      }
      if (res.giftVat) flag('gift_card_vat_charged', row.id);
    });
  }

  const names = {};
  for (const side of [groups.sales, groups.refunds]) {
    for (const b of Object.values(side)) for (const g of Object.keys(b.goods)) names[g] = resolver.groupName(g);
  }
  return {
    summary,
    groups: {
      sales: groups.sales,
      refunds: groups.refunds,
      names,
      categories,
      discountLabels,
      unresolved: { goods: unresolvedGoods, count: unresolvedCount },
      goodsTotal,
      flags: [...flags.values()],
    },
  };
}
