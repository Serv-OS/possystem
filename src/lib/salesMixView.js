// src/lib/salesMixView.js
//
// THE SALES MIX SCREENS' VIEW MATHS (8 Oct 2026). The report (reports/SalesMix.jsx), its
// setup panel (SalesMixSetup.jsx), the Business summary strip (SalesMixStrip.jsx) and the Z
// report block (ZReportGroups.jsx) draw from these helpers, so every figure and every word
// they show can be tested without React. The money maths itself is in
// supabase/functions/_shared/salesMix.js (one place, shared with the owner function); this
// file only shapes a MixBlock into tiles, table rows, CSV rows and words.
//
// RULES
//   · Shares and points are never worked out in JSX: they come from salesMix.js and are
//     handed through as whole numbers.
//   · Money in a CSV is toFixed(2) with no symbol; shares are the whole numbers on screen.
//   · Plain words, no dashes, never the "not applicable" shorthand.

import { OTHER_GROUP, groupKeyOf } from '../../supabase/functions/_shared/accountingGroups.js';
import {
  OTHER_NAME, SETUP_OPTIONS, allOther, needsSetup, mixWords, optionFor, r2, toneVar,
} from '../../supabase/functions/_shared/salesMix.js';

export const BASIS_CSV = 'Item sales before check discounts and refunds';
export const STRIP_NOTE = 'Item sales before check discounts and refunds.';
export const SUMS_NOTE = 'Pick 7 days or fewer to see the sales mix across sites.';
export const CUSTOM_OPTION = '__custom';
export const KPI_MAX_GROUPS = 6;
export const SLIP_NAME_MAX = 22;

/** A tone name as the CSS it is drawn with: salesMix.js's own, shared with the owner app (one colour per group everywhere). */
export { toneVar };

/** 'YYYY-MM-DD' for a CSV file name (the ProductMix convention). */
export const csvDate = (d = new Date()) => d.toISOString().slice(0, 10);

/** The session key that remembers the setup panel was seen at a site. */
export const seenKey = (siteId) => `salesmix.setup.seen.${siteId}`;

/** The range is one business day: the share chart runs by hour. */
export const isOneDay = (range) => !!(range?.fromDay && range.fromDay === range.toDay);

/** 'A', 'A and B', 'A, B and C'. */
export function joinNames(names) {
  const list = (Array.isArray(names) ? names : []).map((n) => String(n ?? '')).filter(Boolean);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** A name cut to fit an 80mm slip line, with an ellipsis when it was longer. */
export function cutName(name, max = SLIP_NAME_MAX) {
  const s = String(name ?? '');
  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

/** Signed percent change, as _filters.pctDelta: null when there is nothing before. */
export function changePct(current, previous) {
  const prev = Number(previous);
  if (!prev || !Number.isFinite(prev)) return null;
  return (((Number(current) || 0) - prev) / Math.abs(prev)) * 100;
}

// ── KPI band ──────────────────────────────────────────────────────────────────

/**
 * The tiles: "Item sales" first, then one per group, at most KPI_MAX_GROUPS of them (the top
 * five by money plus Other sales when it exists; the table has every group). A tile for Other
 * sales is 'warn' when most sales have no group yet.
 */
export function kpiTiles(view, { maxGroups = KPI_MAX_GROUPS } = {}) {
  if (!view) return [];
  const groups = Array.isArray(view.groups) ? view.groups : [];
  const named = groups.filter((g) => g.key !== OTHER_GROUP).slice(0, Math.max(0, maxGroups - 1));
  const other = groups.find((g) => g.key === OTHER_GROUP);
  const shown = other ? [...named, other] : named;
  const warn = needsSetup(view);
  return [
    { kind: 'total', key: '__total', label: 'Item sales', money: view.total, cmp_money: view.cmp_total, qty: view.qty, checks: view.checks },
    ...shown.map((g) => ({
      kind: 'group', key: g.key, label: g.name, share: g.share, money: g.money, cmp_money: g.cmp_money,
      pts: g.pts, tone: g.tone, warn: g.key === OTHER_GROUP && warn,
    })),
  ];
}

// ── the groups table ──────────────────────────────────────────────────────────

/**
 * Flat rows for the groups table: a row per group in the view's order (money desc, Other sales
 * last), each followed by its categories when its key is in `expanded`. Category shares are
 * of the TOTAL, so the column keeps one meaning; the share of the group rides along for the
 * title attribute.
 */
export function groupTableRows(view, expanded = new Set()) {
  if (!view) return [];
  const total = Number(view.total) || 0;
  const rows = [];
  for (const g of view.groups || []) {
    const cats = Array.isArray(g.categories) ? g.categories : [];
    const open = expanded.has(g.key);
    rows.push({
      id: `g:${g.key}`, kind: 'group', key: g.key, name: g.name, tone: g.tone,
      money: g.money, share: g.share, qty: g.qty, avg_price: g.avg_price, items: g.items,
      cmp_money: g.cmp_money, pts: g.pts, unresolved: g.unresolved, open, catCount: cats.length,
    });
    if (!open) continue;
    cats.forEach((c, i) => rows.push({
      id: `c:${g.key}:${c.id ?? i}`, kind: 'cat', groupKey: g.key, groupName: g.name, catId: c.id,
      label: c.label, money: c.money, qty: c.qty,
      shareOfTotal: total > 0 ? Math.round((c.money / total) * 100) : 0,
      shareOfGroup: c.share,
      avg: c.qty ? r2(c.money / c.qty) : null,
    }));
  }
  return rows;
}

/** The totals row of the groups table. */
export function groupTotals(view) {
  const total = Number(view?.total) || 0;
  const qty = Number(view?.qty) || 0;
  return { total, qty, avg: qty ? r2(total / qty) : null, items: Number(view?.items) || 0 };
}

/** Every group's key, for "Show categories". */
export const allGroupKeys = (view) => (view?.groups || []).map((g) => g.key);

/** The reconcile line under the table: how the groups tie to the Z report's Gross sales. */
export function reconcileWords(recon, fmt) {
  if (!recon) return '';
  if (recon.diff === 0) return `Equals Gross sales on the Z report: ${fmt(recon.subtotal)}.`;
  const n = recon.off;
  return `Gross sales on the Z report is ${fmt(recon.subtotal)}; the lines differ by ${fmt(recon.diff)} (${n} check${n === 1 ? '' : 's'} whose stored subtotal is not the sum of their lines).`;
}

// ── callout and notes ─────────────────────────────────────────────────────────

/**
 * Which callout the report shows above the band, or null when every penny has a group:
 *   'most'   home site, more than half unresolved (with the Set up groups button)
 *   'some'   home site, 1 to 50 percent unresolved (with a link)
 *   'other'  another site, any amount unresolved (groups are set in its own Back Office)
 */
export function calloutFor(view, { isHome = true, siteName = '' } = {}) {
  if (!view || !(view.total > 0)) return null;
  const n = Number(view.unresolved_share) || 0;
  if (n <= 0) return null;
  if (!isHome) return { kind: 'other', n, siteName };
  return { kind: needsSetup(view) ? 'most' : 'some', n, siteName };
}

/** The site's Xero mapping overrides at least one category or item (those win). */
export function mappingHasOverrides(mapping) {
  const n = (o) => (o && typeof o === 'object' ? Object.keys(o).length : 0);
  return n(mapping?.categoryGroups) + n(mapping?.itemGroups) > 0;
}

/**
 * The panel opens by itself once per site per browser session when the signed in site has
 * sales and more than half of them have no group. Never for another site, never while the
 * menu loads, never with no categories or no sales, never once it has been seen.
 */
export function shouldAutoOpen({ isHome, menuLoading, hasCategories, view, seen }) {
  return !!isHome && !menuLoading && !!hasCategories && !seen && needsSetup(view);
}

/** The sites whose mix is mostly unresolved, by name, for the split header line. */
export function needsSetupNames(parts, viewOf) {
  return (parts || []).filter((p) => needsSetup(viewOf(p))).map((p) => p.name);
}

// ── series across sites ───────────────────────────────────────────────────────

/**
 * Several sites' line series (each on its own clock) added bucket by bucket. Day buckets sort
 * ascending; hour buckets keep the first list's order (its day start) and new hours follow.
 * Keys by money desc, Other sales last.
 */
export function mergeSeries(list) {
  const all = (Array.isArray(list) ? list : []).filter(Boolean);
  const isHourly = all.length > 0 && all.every((s) => s.isHourly);
  const series = {};
  const totals = new Map();
  const order = [];
  for (const s of all) {
    for (const k of s.xKeys || []) if (!order.includes(k)) order.push(k);
    for (const [bucket, b] of Object.entries(s.series || {})) {
      const out = (series[bucket] ||= { key: bucket, total: 0 });
      for (const [g, v] of Object.entries(b)) {
        if (g === 'key' || g === 'total') continue;
        out[g] = (out[g] || 0) + (Number(v) || 0);
        out.total += Number(v) || 0;
        totals.set(g, (totals.get(g) || 0) + (Number(v) || 0));
      }
    }
  }
  const keys = [...totals.entries()]
    .sort((a, b) => (a[0] === OTHER_GROUP ? 1 : b[0] === OTHER_GROUP ? -1 : (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0]), 'en')))
    .map(([k]) => k);
  for (const b of Object.values(series)) for (const k of keys) if (b[k] == null) b[k] = 0;
  const xKeys = isHourly ? order.filter((k) => series[k]) : Object.keys(series).sort();
  return { series, xKeys, isHourly, keys };
}

// ── the site matrices ─────────────────────────────────────────────────────────

/**
 * The two SiteMatrix tables of a currency block: item sales per group per site (with an
 * "Item sales" total row) and each group's share at each site.
 *   partViews  [{ id, view }] in the block's order
 */
export function siteMatrixRows(blockView, partViews) {
  const list = Array.isArray(partViews) ? partViews : [];
  const at = (id, key) => (list.find((p) => p.id === id)?.view?.groups || []).find((g) => g.key === key) || null;
  const groups = blockView?.groups || [];
  const money = groups.map((g) => ({
    key: g.key, label: g.name, kind: 'money', total: g.money,
    bySite: Object.fromEntries(list.map((p) => [p.id, at(p.id, g.key)?.money || 0])),
  }));
  money.push({
    key: '__total', label: 'Item sales', kind: 'money', strong: true, total: blockView?.total || 0,
    bySite: Object.fromEntries(list.map((p) => [p.id, p.view?.total || 0])),
  });
  const share = groups.map((g) => ({
    key: g.key, label: g.name, total: g.share,
    bySite: Object.fromEntries(list.map((p) => [p.id, at(p.id, g.key)?.share || 0])),
  }));
  return { money, share };
}

// ── CSV ───────────────────────────────────────────────────────────────────────

const fixed = (n) => (Number(n) || 0).toFixed(2);
const pctOrBlank = (p) => (p == null || !Number.isFinite(p) ? '' : p.toFixed(2));

export const GROUPS_CSV_COLUMNS = [
  { label: 'Group', key: 'group' },
  { label: 'Group key', key: 'groupKey' },
  { label: 'Item sales', key: (r) => fixed(r.money) },
  { label: 'Share %', key: 'share' },
  { label: 'Previous item sales', key: (r) => (r.hasCmp ? fixed(r.cmp_money) : '') },
  { label: 'Change %', key: (r) => (r.hasCmp ? pctOrBlank(changePct(r.money, r.cmp_money)) : '') },
  { label: 'Share change pts', key: (r) => (r.pts == null ? '' : r.pts) },
  { label: 'Qty', key: 'qty' },
  { label: 'Avg price', key: (r) => (r.avg_price == null ? '' : fixed(r.avg_price)) },
  { label: 'Items', key: 'items' },
  { label: 'Unresolved item sales', key: (r) => fixed(r.unresolved) },
  { label: 'Basis', key: () => BASIS_CSV },
  { label: 'Period from', key: 'from' },
  { label: 'Period to', key: 'to' },
  { label: 'Currency', key: 'currency' },
];

/** sales-mix-groups: one row per group and a Total row. */
export function groupsCsvRows(view, { from = '', to = '', currency = '' } = {}) {
  if (!view) return [];
  const hasCmp = view.cmp_total != null;
  const rows = (view.groups || []).map((g) => ({
    group: g.name, groupKey: g.key, money: g.money, share: g.share, cmp_money: g.cmp_money, hasCmp,
    pts: g.pts, qty: g.qty, avg_price: g.avg_price, items: g.items, unresolved: g.unresolved, from, to, currency,
  }));
  const t = groupTotals(view);
  rows.push({
    group: 'Total', groupKey: '', money: view.total, share: view.total > 0 ? 100 : 0, cmp_money: view.cmp_total, hasCmp,
    pts: null, qty: view.qty, avg_price: t.avg, items: view.items, unresolved: view.unresolved, from, to, currency,
  });
  return rows;
}

export const CATEGORIES_CSV_COLUMNS = [
  { label: 'Group', key: 'group' },
  { label: 'Category', key: 'category' },
  { label: 'Category id', key: 'categoryId' },
  { label: 'Item sales', key: (r) => fixed(r.money) },
  { label: 'Share of total %', key: 'shareOfTotal' },
  { label: 'Share of group %', key: 'shareOfGroup' },
  { label: 'Qty', key: 'qty' },
  { label: 'Avg price', key: (r) => (r.avg == null ? '' : fixed(r.avg)) },
  { label: 'Basis', key: () => BASIS_CSV },
  { label: 'Period from', key: 'from' },
  { label: 'Period to', key: 'to' },
  { label: 'Currency', key: 'currency' },
];

/** sales-mix-categories: every category of every group (the view must carry all categories). */
export function categoriesCsvRows(view, { from = '', to = '', currency = '' } = {}) {
  return groupTableRows(view, new Set(allGroupKeys(view)))
    .filter((r) => r.kind === 'cat')
    .map((r) => ({
      group: r.groupName, category: r.label, categoryId: r.catId ?? '', money: r.money,
      shareOfTotal: r.shareOfTotal, shareOfGroup: r.shareOfGroup, qty: r.qty, avg: r.avg, from, to, currency,
    }));
}

/** sales-mix-groups-by-site: the Site column is added by exportSites; these follow it. */
export const GROUPS_BY_SITE_CSV_COLUMNS = [
  { label: 'Currency', key: 'currency' },
  { label: 'Group', key: 'group' },
  { label: 'Group key', key: 'groupKey' },
  { label: 'Item sales', key: (r) => fixed(r.money) },
  { label: 'Share %', key: 'share' },
  { label: 'Qty', key: 'qty' },
  { label: 'Avg price', key: (r) => (r.avg_price == null ? '' : fixed(r.avg_price)) },
  { label: 'Items', key: 'items' },
  { label: 'Unresolved item sales', key: (r) => fixed(r.unresolved) },
  { label: 'Basis', key: () => BASIS_CSV },
  { label: 'Period from', key: 'from' },
  { label: 'Period to', key: 'to' },
];

/** One site's groups as CSV rows, tagged for exportSites (siteName first). */
export function groupsBySiteCsvRows(part, view) {
  if (!part || !view) return [];
  const from = part.site?.range?.fromDay || '', to = part.site?.range?.toDay || '';
  return (view.groups || []).map((g) => ({
    siteId: part.id, siteName: part.name, currency: part.currency || '',
    group: g.name, groupKey: g.key, money: g.money, share: g.share, qty: g.qty, avg_price: g.avg_price,
    items: g.items, unresolved: g.unresolved, from, to,
  }));
}

// ── the Business summary strip ────────────────────────────────────────────────

/**
 * What the strip draws: the segments of its one stacked bar (every group, Other sales last),
 * the words for its aria label, and which hint line to show: 'all' when nothing is set up,
 * 'most' when more than half has no group, else null. `failed` (the menu could not be read)
 * is one grey segment and its own hint.
 */
export function stripModel(view, { failed = false } = {}) {
  if (!view || !(view.total > 0)) return null;
  if (failed) {
    return {
      segments: [{ key: OTHER_GROUP, name: OTHER_NAME, share: 100, money: view.total, tone: 't3' }],
      words: `${OTHER_NAME} 100%`, hint: 'failed', allOther: true,
    };
  }
  const segments = (view.groups || []).filter((g) => g.share > 0 || g.money > 0)
    .map((g) => ({ key: g.key, name: g.name, share: g.share, money: g.money, tone: g.tone }));
  const all = allOther(view);
  return { segments, words: mixWords(segments), hint: all ? 'all' : needsSetup(view) ? 'most' : null, allOther: all };
}

// ── the Z report block ────────────────────────────────────────────────────────

/** The slip's lines: a row per group with its name cut to the slip width, and the total. */
export function slipModel(view) {
  if (!view || !(view.total > 0 || view.lines > 0)) return null;
  return {
    rows: (view.groups || []).filter((g) => g.money > 0 || g.share > 0)
      .map((g) => ({ key: g.key, name: cutName(g.name), share: g.share, money: g.money })),
    total: view.total,
    allOther: allOther(view),
  };
}

// ── the setup panel ───────────────────────────────────────────────────────────

/**
 * The dropdown: the suggested words, "Other sales", then every distinct custom text already
 * stored on this site's top level categories (deduped by key), then "Custom…".
 */
export function setupOptionList(rows, base = SETUP_OPTIONS) {
  const out = [...base];
  const seen = new Set(out.map((o) => groupKeyOf(o.value)));
  for (const r of rows || []) {
    const text = String(r?.text ?? '').trim();
    const key = groupKeyOf(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ value: text, label: text });
  }
  out.push({ value: CUSTOM_OPTION, label: 'Custom…' });
  return out;
}

/** The select value a stored text shows as: '' for none, the suggested word, else the text itself. */
export function setupValueFor(text) {
  const opt = optionFor(text);
  return opt === 'custom' ? String(text ?? '').trim() : opt;
}

/** The ids whose staged text differs from what is stored, in row order. */
export function stagedChanges(rows, staged) {
  const out = [];
  for (const r of rows || []) {
    if (!staged || !(r.id in staged)) continue;
    const next = String(staged[r.id] ?? '');
    if (next !== String(r.text ?? '')) out.push({ id: r.id, label: r.label, text: next });
  }
  return out;
}

/** 'Save', 'Save 1 change', 'Save 3 changes', 'Saving…'. */
export function saveLabel(count, saving = false) {
  if (saving) return 'Saving…';
  if (!count) return 'Save';
  return count === 1 ? 'Save 1 change' : `Save ${count} changes`;
}

export const savedToast = (n) => (n === 1 ? 'Saved 1 group' : `Saved ${n} groups`);
export const notSavedToast = (k, n) => `${k} of ${n} not saved`;

/** The outcomes of store.updateCategory that mean the write landed. */
const LANDED = new Set(['applied', 'merged', 'already', 'noop']);

/**
 * null when the write landed, else the plain words for the row's red line.
 * r = the result of store.updateCategory (menuWriters.categories.edit).
 */
export function saveFailure(r) {
  if (r?.ok && (!r.outcome || LANDED.has(r.outcome))) return null;
  if (r?.outcome === 'conflict') return 'Not saved: changed in another window. Close and reopen to see it.';
  if (r?.refused) return 'Not saved: not allowed for this sign in. Finish the second step first.';
  if (r?.outcome === 'gone') return 'Not saved: this category is no longer at this site.';
  return 'Not saved: the database did not answer. Try again.';
}

/** The status line: how many top level categories still have no group. */
export function setupStatus(setup) {
  const total = Number(setup?.total) || 0;
  const unset = Number(setup?.unset) || 0;
  return unset > 0
    ? { ok: false, strong: `${unset} of ${total}`, rest: ' top level categories have no group yet, so their sales show as Other sales.' }
    : { ok: true, strong: 'Every', rest: ' top level category has a group.' };
}

/** The sub line of a setup row: how many sub categories follow it. */
export function subWords(row) {
  const n = Number(row?.subCount) || 0;
  return n > 0 ? `${n} sub categories follow` : 'No sub categories';
}

/** The second sub line, when some sub categories carry their own group. */
export function subOwnWords(row) {
  const n = Number(row?.subOwn) || 0;
  return n > 0 ? `${n} of them have their own group, set in Menu Manager.` : '';
}
