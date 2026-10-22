// src/lib/stock/dashboardRules.js
//
// MULTI SITE STOCK, Drop 4a (migration 20261026a, contract 3.2 and 3.3): the words and the small
// sums behind the head office dashboard (Back Office > Reports > Stock and GP) and its Targets panel.
//
// Pure: no React, no client; dashboardRules.test.js drives every function. Every figure comes from
// the answer of stock_report_dashboard (the stored day totals, each venue on its own business day):
// nothing here works a GP out from the stock take off, nothing adds two currencies (one block of
// cards per currency), and a figure the server did not give is shown as words, never as a zero.

import { currencySymbol, signedMoney } from '../currency.js';
import { RULES_LINE as REPORT_RULES_LINE } from './reportRules.js';

// ── the fixed words (the mockup scrReport, word for word) ────────────────────────────────────────

/** The rules line: the one copy in reportRules.js, so the dashboard and every report say the same. */
export const RULES_LINE = REPORT_RULES_LINE;
export const DEMO_LINE = 'Demo history left out';
// A site (or the company row of its currency) whose days hold a check the demo files wrote: the stored
// sales totals keep no demo flag, so its sales and GP are not shown (the database answers null).
export const DEMO_SALES_LINE = 'Demo sales in these days';
export const NOT_SHOWN = 'Not shown';
// The loyalty, staff and comps cost of days before a site saved the plate cost of every sale.
export const COMPS_NOT_KNOWN = 'Not known';
export const COMPS_NOT_KNOWN_SUB = 'known once every sale has its plate cost';
export const PER_CURRENCY_LINE = 'Shown per currency';
export const LEAGUE_NOTE = 'Click a site to drill down: site, category, item, each movement, the invoice';
export const REPORTS_NOTE = 'Same controls on every one: sites, period, compare, drill down, export';
export const CHOOSE_KEY_ITEMS = 'Choose your key items';
export const KEY_ITEMS_HINT = 'Coffee groups usually track milk per milk drink, beans per shot and cups against cup drinks sold';
export const BY_TYPE_ACTUAL_NOTE = 'Actual cost by type comes with counts by type';
export const BUDGET_LATER = 'budget comes with the purchasing update';
export const READ_ONLY_TARGETS = 'Only a Stock control All sites login can change targets and key items. You can read them.';
export const KEY_ITEMS_FULL = 'That is 20 key items. Archive one first.';
export const MAX_KEY_ITEMS = 20;

/** The GP or cost of sales switch (reportKit SegToggle options). */
export const GP_MODES = Object.freeze([
  Object.freeze({ id: 'gp', label: 'GP' }),
  Object.freeze({ id: 'cost', label: 'Cost of sales' }),
]);

// ── numbers to words ─────────────────────────────────────────────────────────────────────────────

/** A number, or null for anything that is not one (null, '', 'abc', Infinity). */
export function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** '74.1%' (one decimal); '' when the figure is not known. */
export function pctText(v, dp = 1) {
  const n = num(v);
  return n == null ? '' : `${n.toFixed(dp)}%`;
}

/** '+7%', '-3.5%', '0%'; '' when not known. Up to one decimal, none when whole. */
export function signedPctText(v) {
  const n = num(v);
  if (n == null) return '';
  const r = Math.round(n * 10) / 10;
  const sign = r > 0 ? '+' : r < 0 ? '-' : '';
  return `${sign}${Math.abs(r).toLocaleString('en-GB', { maximumFractionDigits: 1 })}%`;
}

/** '2,288', '18.6' (up to dp decimals, thousands separated); '' when not known. */
export function qtyText(v, dp = 1) {
  const n = num(v);
  return n == null ? '' : n.toLocaleString('en-GB', { maximumFractionDigits: dp });
}

/**
 * Whole units with the row's own currency symbol, the mockup's gbp0: '£18,420', '-£240'. Never the
 * signed in site's currency for another site's row: the caller passes the row's currency.
 */
export function wholeMoney(v, currency) {
  const n = num(v);
  if (n == null) return '';
  const whole = Math.round(Math.abs(n));
  return `${n < 0 && whole !== 0 ? '-' : ''}${currencySymbol(currency)}${whole.toLocaleString('en-GB')}`;
}

/** Pennies kept ('£1,234.50' reads '£1234.50', the house money rule): '' when not known. */
export function moneyText(v, currency) {
  const n = num(v);
  return n == null ? '' : signedMoney(n, currency);
}

/** The server's rag word as a Pill tone: green good, amber warn, red bad, anything else null. */
export function toneOf(rag) {
  if (rag === 'green') return 'good';
  if (rag === 'amber') return 'warn';
  if (rag === 'red') return 'bad';
  return null;
}

/** '0 sales waiting', '1 sale waiting', '12 sales waiting'. */
export function notPostedWords(count) {
  const n = Math.max(0, Math.trunc(num(count) || 0));
  return n === 1 ? '1 sale waiting' : `${n.toLocaleString('en-GB')} sales waiting`;
}

/** A calendar day as 'Mon 13 Oct', whatever the browser's zone; '' for anything else. */
export function dayWords(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return '';
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

// ── the totals: site rows first, then one company row per currency ───────────────────────────────

const asList = (v) => (Array.isArray(v) ? v : []);
const isCompanyRow = (r) => r && typeof r === 'object' && (r.location_id == null || r.location_id === '');

/** The company rows (location_id null), one per currency. Never added together. */
export function companyRows(totals) {
  return asList(totals).filter(isCompanyRow);
}

/** The site rows (location_id set). */
export function siteRows(totals) {
  return asList(totals).filter((r) => r && typeof r === 'object' && !isCompanyRow(r));
}

/** The one name of a site: siteById may be a Map, a plain object or a function (id) => name. */
export function siteNameOf(siteById, id, fallback = 'A site') {
  if (id == null) return fallback;
  let s = null;
  if (typeof siteById === 'function') s = siteById(id);
  else if (siteById instanceof Map) s = siteById.get(id) ?? siteById.get(String(id));
  else if (siteById && typeof siteById === 'object') s = siteById[id];
  if (s == null) return fallback;
  if (typeof s === 'string') return s || fallback;
  return s.name || fallback;
}

// ── the cards ────────────────────────────────────────────────────────────────────────────────────

/** Which figure a card compares with the compare period, and how: [metric key, kind]. */
export const CARD_COMPARE = Object.freeze({
  sales: Object.freeze(['sales_net', 'money']),
  gp: Object.freeze(['gp_pct_actual', 'pct']),
  cost: Object.freeze(['actual_pct', 'pct']),
  gap: Object.freeze(['gap_pct', 'pct']),
  comps: Object.freeze(['comps_cost', 'money']),
  purchases: Object.freeze(['purchases', 'money']),
  stock: Object.freeze(['stock_value_now', 'money']),
});

/**
 * The seven cards of one totals row (a company row, or a site row on one site), in the mockup's
 * order and words. mode 'gp' shows GP %, 'cost' swaps that card to cost of sales %.
 * Each card: { key, label, value, sub, tone (a Pill tone or null: a grey line), report (the report
 * behind the number, or null), compare: [metric key, kind] | null }.
 */
export function cardsOf(row, { mode = 'gp', currency = null } = {}) {
  const r = row || {};
  const cur = currency || r.currency || null;
  const rag = r.rag || {};
  const sales = num(r.sales_net);
  const salesValue = wholeMoney(sales, cur);
  const gpMode = mode !== 'cost';
  const gpValue = gpMode ? pctText(r.gp_pct_actual) : pctText(r.actual_pct);
  const gpTheo = gpMode ? pctText(r.gp_pct_theo) : pctText(r.theo_pct);
  const gapPct = num(r.gap_pct);
  const gapValue = num(r.gap_value);
  const gapMoney = gapValue == null ? '' : gapValue > 0 ? `${wholeMoney(gapValue, cur)} surplus` : wholeMoney(-gapValue, cur);
  const wastePct = pctText(r.waste_pct) || '0.0%';
  const budget = num(r.budget);
  const purchases = num(r.purchases);
  const days = num(r.days_on_hand);
  const notPosted = num(r.not_posted_count) || 0;
  const comps = num(r.comps_cost);
  if (r.demo_sales === true) {
    // the database left this row's sales out (a demo check in the days): words, never a figure
    const hidden = (key, label, report, compare) => ({ key, label, value: NOT_SHOWN, sub: DEMO_SALES_LINE, tone: null, report, compare });
    return [
      hidden('sales', 'Sales', 'stock_cogs', CARD_COMPARE.sales),
      hidden('gp', gpMode ? 'GP % actual' : 'Cost of sales % actual', 'stock_cogs', gpMode ? CARD_COMPARE.gp : CARD_COMPARE.cost),
      { ...hidden('gap', 'Gap', 'stock_gap', CARD_COMPARE.gap), sub: `${gapMoney || wholeMoney(0, cur)} · ${DEMO_SALES_LINE.toLowerCase()}` },
      hidden('comps', 'Loyalty, staff and comps', 'stock_cogs', CARD_COMPARE.comps),
      ...cardsOf({ ...r, demo_sales: false }, { mode, currency }).slice(4),
    ];
  }
  return [
    {
      key: 'sales', label: 'Sales',
      value: salesValue || 'No data',
      sub: sales == null ? 'Sales not read' : sales === 0 ? 'No sales' : `${pctText(r.sales_with_recipe_pct) || '0.0%'} with a recipe`,
      tone: null, report: 'stock_cogs', compare: CARD_COMPARE.sales,
    },
    {
      key: 'gp', label: gpMode ? 'GP % actual' : 'Cost of sales % actual',
      value: gpValue || 'No sales',
      sub: `theoretical ${gpTheo || 'not known'}`,
      tone: toneOf(rag.gp_pct), report: 'stock_cogs', compare: gpMode ? CARD_COMPARE.gp : CARD_COMPARE.cost,
    },
    {
      key: 'gap', label: 'Gap',
      value: gapPct == null ? 'No sales' : `${pctText(gapPct)} of sales`,
      sub: `${gapMoney || wholeMoney(0, cur)} · waste ${wastePct}`,
      tone: toneOf(rag.gap_pct), report: 'stock_gap', compare: CARD_COMPARE.gap,
    },
    {
      key: 'comps', label: 'Loyalty, staff and comps',
      value: comps == null ? COMPS_NOT_KNOWN : wholeMoney(comps, cur),
      sub: comps == null ? COMPS_NOT_KNOWN_SUB : `${pctText(r.comps_pct) || '0.0%'} of sales, own line`,
      tone: null, report: 'stock_cogs', compare: CARD_COMPARE.comps,
    },
    {
      key: 'purchases', label: 'Purchases',
      value: wholeMoney(purchases, cur) || wholeMoney(0, cur),
      sub: budget == null ? BUDGET_LATER : `of ${wholeMoney(budget, cur)} budget`,
      tone: budget == null ? null : (purchases || 0) > budget ? 'bad' : 'good',
      report: 'stock_purchases', compare: CARD_COMPARE.purchases,
    },
    {
      key: 'stock', label: 'Stock value now',
      value: wholeMoney(r.stock_value_now, cur) || 'No data',
      sub: days == null ? 'days on hand: no use yet' : `days on hand ${qtyText(days, 1)}`,
      tone: null, report: 'stock_value', compare: CARD_COMPARE.stock,
    },
    {
      key: 'not_posted', label: 'Not yet posted to stock',
      value: wholeMoney(r.not_posted_value, cur) || wholeMoney(0, cur),
      sub: notPostedWords(notPosted),
      tone: notPosted > 0 ? 'warn' : null, report: null, compare: null,
    },
  ];
}

/**
 * One block of cards per company row, so two currencies are never added: [{ currency, cards }].
 * On one site (one site row and its company row) the company row is still the one shown: it is
 * that site's figures in that site's currency.
 */
export function cardBlocks(totals, { mode = 'gp' } = {}) {
  return companyRows(totals).map((r) => ({ currency: r.currency || null, row: r, cards: cardsOf(r, { mode, currency: r.currency || null }) }));
}

/** The compare row for a block: the compare answer's company row in the same currency. */
export function compareRowFor(compareTotals, currency) {
  const rows = companyRows(compareTotals);
  return rows.find((r) => (r.currency || null) === (currency || null)) || (rows.length === 1 && !currency ? rows[0] : null) || null;
}

// ── key item tiles ───────────────────────────────────────────────────────────────────────────────

/**
 * One row per key ratio for the tiles: the company row (location_id null) of each ratio, else the
 * first site row of it. Order kept.
 */
export function tileRows(keyItems) {
  const list = asList(keyItems).filter((r) => r && r.ratio_id != null);
  const byRatio = new Map();
  for (const r of list) {
    const have = byRatio.get(r.ratio_id);
    if (!have || (!isCompanyRow(have) && isCompanyRow(r))) byRatio.set(r.ratio_id, r);
  }
  return [...byRatio.values()];
}

const isEach = (unit) => String(unit || '').trim().toLowerCase() === 'each';

/**
 * The thing a count tile counts, from its name's first word: 'Cups used against cup drinks sold'
 * gives 'cups' (the mockup's '122 cups not rung through'). '' when the name is one word or the first
 * word is not plain letters, so the pill then reads '122 not rung through'.
 */
export function countNoun(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || !/^[A-Za-z]+$/.test(words[0])) return '';
  return words[0].toLowerCase();
}

/**
 * The words of one tile (the mockup tile): { key, title, kind, recipeText, actualText, pillText,
 * tone, ratioId }. Units in ml or g read 'Recipe 200 ml' / 'Actual 214 ml' with a '+7%' pill; a
 * count ('each') reads '2,288 sold' / '2,410 used' with '122 not rung through' when more were used
 * than the recipe says the sales took ('122 cups not rung through', countNoun).
 */
export function tileOf(row) {
  const r = row || {};
  const unit = String(r.used_unit || '').trim();
  const recipe = num(r.recipe_amount);
  const perSold = num(r.per_sold);
  const sold = num(r.sold_qty);
  const used = num(r.used_qty);
  const diff = num(r.diff_pct);
  const base = { key: String(r.ratio_id ?? r.name ?? ''), ratioId: r.ratio_id ?? null, title: r.name || 'Key item' };
  if (isEach(unit)) {
    const expected = sold == null ? null : sold * (recipe == null ? 1 : recipe);
    const extra = used != null && expected != null ? used - expected : null;
    let pillText; let tone;
    if (sold == null || used == null) { pillText = 'No sales'; tone = null; }
    else if (extra > 0.5) { const noun = countNoun(r.name); pillText = `${qtyText(Math.round(extra), 0)}${noun ? ` ${noun}` : ''} not rung through`; tone = toneOf(r.rag) || 'warn'; }
    else { pillText = diff == null ? 'Matches the recipe' : signedPctText(diff); tone = toneOf(r.rag) || 'good'; }
    return { ...base, kind: 'count', recipeText: sold == null ? 'No sales' : `${qtyText(sold, 0)} sold`, actualText: used == null ? 'Not known' : `${qtyText(used, 0)} used`, pillText, tone };
  }
  let pillText; let tone;
  if (recipe == null) { pillText = 'Set the recipe amount'; tone = null; }
  else if (perSold == null) { pillText = 'No sales'; tone = null; }
  else { pillText = signedPctText(diff == null ? ((perSold - recipe) / recipe) * 100 : diff); tone = toneOf(r.rag); }
  return {
    ...base, kind: 'ratio',
    recipeText: recipe == null ? 'Not set' : `${qtyText(recipe, 1)} ${unit}`.trim(),
    actualText: perSold == null ? 'No sales' : `${qtyText(perSold, 1)} ${unit}`.trim(),
    pillText, tone,
  };
}

// ── the site league ──────────────────────────────────────────────────────────────────────────────

/**
 * The 13 columns, exactly (contract 3.2). kind: text, money, pct, budget, qty, day, count; rag: the
 * rag key that colours the cell; report: the report a number click opens, with the row's site.
 */
export const LEAGUE_COLUMNS = Object.freeze([
  Object.freeze({ key: 'site', label: 'Site', kind: 'text', report: null }),
  Object.freeze({ key: 'sales_net', label: 'Sales', kind: 'money', report: 'stock_cogs' }),
  Object.freeze({ key: 'gp_pct_theo', label: 'GP % theo', kind: 'pct', report: 'stock_cogs' }),
  Object.freeze({ key: 'gp_pct_actual', label: 'GP % actual', kind: 'pct', report: 'stock_cogs' }),
  Object.freeze({ key: 'gap_pct', label: 'Gap %', kind: 'pct', rag: 'gap_pct', report: 'stock_gap' }),
  Object.freeze({ key: 'waste_pct', label: 'Waste %', kind: 'pct', rag: 'waste_pct', report: 'stock_waste' }),
  Object.freeze({ key: 'comps_pct', label: 'Comps %', kind: 'pct', report: 'stock_cogs' }),
  Object.freeze({ key: 'purchases', label: 'Purchases against budget', kind: 'budget', report: 'stock_purchases', hint: 'Budget comes with the purchasing update' }),
  Object.freeze({ key: 'stock_value_now', label: 'Stock value', kind: 'money', report: 'stock_value' }),
  Object.freeze({ key: 'days_on_hand', label: 'Days on hand', kind: 'qty', report: 'stock_days_on_hand' }),
  Object.freeze({ key: 'last_full_count_day', label: 'Last full count', kind: 'day', report: 'stock_movement' }),
  Object.freeze({ key: 'no_recipe_pct', label: 'No recipe sales', kind: 'pct', report: 'stock_setup_health' }),
  Object.freeze({ key: 'below_par_count', label: 'Below par', kind: 'count', report: 'stock_par' }),
]);

/** The columns a central kitchen leaves blank (no sales of its own). */
const KITCHEN_BLANK = new Set(['gp_pct_theo', 'gp_pct_actual', 'gap_pct', 'comps_pct', 'no_recipe_pct']);

/**
 * One league cell: { text, grey, pill: { text, tone } | null, report }. A central kitchen row shows
 * 'None' for sales and blanks for GP. Money is whole units in the row's own currency.
 */
export function leagueCell(row, col) {
  const r = row || {};
  const c = col || {};
  const cur = r.currency || null;
  const rag = r.rag || {};
  const out = { text: '', grey: false, pill: null, report: c.report || null };
  if (r.kitchen === true && KITCHEN_BLANK.has(c.key)) return out;
  const v = r[c.key];
  switch (c.kind) {
    case 'text':
      out.text = r.site || siteNameOf(null, null);
      return out;
    case 'money':
      if (c.key === 'sales_net' && r.kitchen === true) { out.text = 'None'; out.grey = true; return out; }
      if (r.demo_sales === true && v == null) { out.text = c.key === 'sales_net' ? DEMO_SALES_LINE : ''; out.grey = true; return out; }
      out.text = wholeMoney(v, cur);
      return out;
    case 'pct': {
      out.text = pctText(v);
      const tone = c.rag ? toneOf(rag[c.rag]) : null;
      if (out.text && tone) out.pill = { text: out.text, tone };
      return out;
    }
    case 'budget': {
      const p = num(r.purchases);
      const b = num(r.budget);
      if (p == null) return out;
      out.text = b == null ? wholeMoney(p, cur) : `${wholeMoney(p, cur)} of ${wholeMoney(b, cur)}`;
      if (b != null && p > b) out.pill = { text: 'Over', tone: 'bad' };
      return out;
    }
    case 'qty': {
      const n = num(v);
      if (n == null) { out.text = 'No use'; out.grey = true; return out; }
      out.text = qtyText(n, 1);
      return out;
    }
    case 'day': {
      const words = r.last_full_count_words || (r.last_full_count_day ? dayWords(r.last_full_count_day) : '') || 'None yet';
      out.text = words;
      out.grey = words === 'None yet';
      return out;
    }
    case 'count': {
      const n = num(v);
      out.text = n == null ? '' : qtyText(Math.trunc(n), 0);
      return out;
    }
    default:
      out.text = v == null ? '' : String(v);
      return out;
  }
}

/** The value a league column sorts on: text for Site and Last full count, numbers elsewhere. */
export function leagueSortValue(row, key) {
  const r = row || {};
  if (key === 'site') return String(r.site || '').toLowerCase();
  if (key === 'last_full_count_day') return r.last_full_count_day || null;
  return num(r[key]);
}

/**
 * The league sorted (default sales desc). Nulls and blanks go last whatever the direction, and a
 * tie keeps the server's order (a stable sort), so two sites never swap between renders.
 */
export function sortLeague(rows, sort = null) {
  const list = asList(rows);
  const key = sort?.key || 'sales_net';
  const dir = sort?.dir === 'asc' ? 1 : -1;
  return list
    .map((r, i) => ({ r, i, v: leagueSortValue(r, key) }))
    .sort((a, b) => {
      const an = a.v == null || a.v === '';
      const bn = b.v == null || b.v === '';
      if (an && bn) return a.i - b.i;
      if (an) return 1;
      if (bn) return -1;
      let c = 0;
      if (typeof a.v === 'string' || typeof b.v === 'string') c = String(a.v).localeCompare(String(b.v));
      else c = a.v - b.v;
      return c === 0 ? a.i - b.i : c * dir;
    })
    .map((x) => x.r);
}

// ── needs attention ──────────────────────────────────────────────────────────────────────────────

/** The 4a kinds in the order shown, with the report behind each (and the tab it opens on) and whether Fix applies. */
export const ATTENTION_KINDS = Object.freeze([
  Object.freeze({ kind: 'negative_stock', label: 'Negative stock', report: 'stock_par', opts: Object.freeze({ level: 'negative' }) }),
  Object.freeze({ kind: 'below_minimum', label: 'Below minimum', report: 'stock_par', opts: Object.freeze({ level: 'below' }) }),
  Object.freeze({ kind: 'out_of_step', label: 'Sites out of step', report: 'stock_setup_health', fixable: true }),
  Object.freeze({ kind: 'invoice_review', label: 'Invoices to review', report: 'stock_purchases' }),
  Object.freeze({ kind: 'clock_disagrees', label: 'Clocks that disagree', report: 'stock_setup_health' }),
  Object.freeze({ kind: 'demo_history', label: 'Demo history', report: null }),
  Object.freeze({ kind: 'not_posted', label: 'Sales not yet posted to stock', report: null }),
]);

const kindLabel = (kind) => {
  const k = String(kind || '').trim().replace(/_/g, ' ');
  return k ? k.charAt(0).toUpperCase() + k.slice(1) : 'Other';
};

/**
 * The attention rows grouped by kind: [{ kind, label, count, report, opts, fixable, sites: [{ location_id,
 * site, count, words, ref }] }], known kinds first in their order, a kind the server adds later after
 * them with its own words. A kind with no rows is left out; a row with count 0 is left out.
 */
export function groupAttention(rows) {
  const list = asList(rows).filter((r) => r && r.kind && (num(r.count) || 0) > 0);
  const known = new Map(ATTENTION_KINDS.map((k) => [k.kind, k]));
  const groups = new Map();
  for (const r of list) {
    const def = known.get(r.kind) || { kind: r.kind, label: kindLabel(r.kind), report: null, fixable: false };
    if (!groups.has(r.kind)) groups.set(r.kind, { kind: r.kind, label: def.label, count: 0, report: def.report || null, opts: def.opts ? { ...def.opts } : null, fixable: def.fixable === true, sites: [] });
    const g = groups.get(r.kind);
    const n = Math.trunc(num(r.count) || 0);
    g.count += n;
    g.sites.push({ location_id: r.location_id ?? null, site: r.site || 'A site', count: n, words: r.words || '', ref: r.ref ?? null });
  }
  const order = ATTENTION_KINDS.map((k) => k.kind);
  return [...groups.values()].sort((a, b) => {
    const ai = order.indexOf(a.kind); const bi = order.indexOf(b.kind);
    return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi);
  });
}

/** 'North Site: 3, South Site: 1 and 2 more'. */
export function attentionSitesWords(sites) {
  const parts = asList(sites).map((s) => `${s.site || 'A site'}: ${qtyText(s.count, 0)}`);
  if (!parts.length) return '';
  if (parts.length <= 3) return parts.join(', ');
  return `${parts.slice(0, 2).join(', ')} and ${parts.length - 2} more`;
}

// ── GP by type ───────────────────────────────────────────────────────────────────────────────────

export const TYPE_LABELS = Object.freeze({ food: 'Food', drink: 'Drink', other: 'Other' });

/** The by type rows in the order food, drink, other (a type the server adds after them). */
export function byTypeRows(rows) {
  const order = ['food', 'drink', 'other'];
  const rank = (t) => { const i = order.indexOf(t); return i < 0 ? order.length : i; };
  return asList(rows)
    .map((r, i) => ({ r, i }))
    .filter((x) => x.r && x.r.type)
    .sort((a, b) => (rank(a.r.type) - rank(b.r.type)) || (a.i - b.i))
    .map((x) => ({ ...x.r, label: TYPE_LABELS[x.r.type] || kindLabel(x.r.type) }));
}

// ── the sub line: scope, period, compare ─────────────────────────────────────────────────────────

const idSet = (ids) => new Set(asList(ids).filter(Boolean).map(String));
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

/**
 * The scope in words: 'All sites' (every open site in siteById is ticked), a group's name (the ticked
 * set equals the group), one site's name, or 'n of m sites'. siteById: Map or object of { id, name,
 * status }; groups: [{ id, name, locationIds | location_ids }].
 */
export function scopeWords(sites, siteById, groups = []) {
  const ticked = idSet(sites);
  if (!ticked.size) return 'No sites';
  const entries = siteById instanceof Map ? [...siteById.entries()] : Object.entries(siteById || {});
  const open = entries.filter(([, s]) => !s || typeof s !== 'object' || s.status == null || s.status === '' || String(s.status).toLowerCase() === 'active').map(([id]) => String(id));
  const openSet = new Set(open);
  if (openSet.size && sameSet(ticked, openSet)) return 'All sites';
  for (const g of asList(groups)) {
    const ids = idSet(g?.locationIds || g?.location_ids);
    if (ids.size && sameSet(ticked, ids)) return g.name || 'A group';
  }
  if (ticked.size === 1) return siteNameOf(siteById, [...ticked][0], 'One site');
  const m = Math.max(openSet.size, ticked.size);
  return `${ticked.size} of ${m} sites`;
}

/** 'Mon 13 Oct to Sun 19 Oct', one day as 'Mon 13 Oct', or 'Between two counts'. */
export function periodWords(range) {
  if (!range) return '';
  if (range.betweenCounts === true) return 'Between two counts';
  const a = dayWords(range.fromDay || range.from);
  const b = dayWords(range.toDay || range.to);
  if (!a && !b) return '';
  if (!b || a === b) return a || b;
  if (!a) return b;
  return `${a} to ${b}`;
}

/** 'compared with last week' from a compare whose label reads 'vs last week'; null with none. */
export function compareWords(compare) {
  const label = String(compare?.label || '').trim();
  if (!label) return null;
  return `compared with ${label.replace(/^vs\.?\s+/i, '')}`;
}

/** The dashboard's sub line, the mockup's words, pieces joined with a middle dot. */
export function subLine({ scope, period, compare } = {}) {
  const parts = ['Head office dashboard'];
  if (scope) parts.push(scope);
  if (period) parts.push(period);
  const c = compareWords(compare);
  if (c) parts.push(c);
  parts.push('each venue on its own business day');
  return parts.join(' · ');
}

// ── the call ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The one call the dashboard makes (useStockReport(api, 'dashboard', args)): the report args of
 * reportsData.js plus the compare range for the second call. After a Targets save the screen asks
 * again with the hook's reload(), so nothing here changes for it.
 */
export function dashboardArgs({ orgId, sites, range, compare = null } = {}) {
  return {
    orgId: orgId || null,
    sites: asList(sites).filter(Boolean),
    from: range?.fromDay || range?.from || null,
    to: range?.toDay || range?.to || null,
    opts: { between_counts: range?.betweenCounts === true },
    compare: compare && (compare.from || compare.to) ? { from: compare.from || null, to: compare.to || null, label: compare.label || '' } : null,
  };
}

/** The compare answer's totals, whichever key the hook keeps them under; null with none. */
export function compareTotalsOf(report) {
  const r = report || {};
  const c = r.compare || r.then || r.previous || null;
  if (!c) return null;
  return asList(c.totals).length ? c.totals : null;
}

// ── the all reports grid ─────────────────────────────────────────────────────────────────────────

/**
 * The Catalog's stock category as grid buttons, the dashboard itself left out: [{ id, label, desc,
 * later: 'recipes' | 'purchasing' | null, laterWords }].
 */
export function reportGrid(categories, laterWords = {}) {
  const cat = asList(categories).find((c) => c && c.id === 'stock');
  return asList(cat?.reports)
    .filter((r) => r && r.id && r.id !== 'stock_home')
    .map((r) => ({ id: r.id, label: r.label || r.id, desc: r.desc || '', later: r.later || null, laterWords: r.later ? (laterWords[r.later] || 'Comes with a later update') : null }));
}

// ── targets: the panel's grid and its save rows ──────────────────────────────────────────────────

/** The key of one target cell: '<location id>:<metric>' or 'company:<metric>'. */
export const targetKey = (locationId, metric) => `${locationId || 'company'}:${metric}`;

/** The two halves of a key: { location_id (null for the company row), metric }. */
export function splitTargetKey(key) {
  const i = String(key || '').indexOf(':');
  if (i < 0) return { location_id: null, metric: String(key || '') };
  const loc = String(key).slice(0, i);
  return { location_id: loc === 'company' || loc === '' ? null : loc, metric: String(key).slice(i + 1) };
}

/**
 * The seven metrics as [{ key, label }], whatever shape targetRules.js exports them in: an array of
 * { key | id | metric, label }, an array of strings, or an object { key: label | { label } }.
 */
export function metricList(metrics) {
  if (Array.isArray(metrics)) {
    return metrics.map((m) => (typeof m === 'string' ? { key: m, label: m } : { key: m.key || m.id || m.metric, label: m.label || m.key || m.id || m.metric, ...m })).filter((m) => m.key);
  }
  if (metrics && typeof metrics === 'object') {
    return Object.entries(metrics).map(([key, v]) => ({ key, label: typeof v === 'string' ? v : (v && v.label) || key, ...(v && typeof v === 'object' ? v : {}) }));
  }
  return [];
}

/** A default as { green_to, amber_to } from { green_to, amber_to }, { green, amber } or [green, amber]. */
export function defaultTarget(defaults, metric) {
  const d = defaults ? defaults[metric] : null;
  if (Array.isArray(d)) return { green_to: num(d[0]), amber_to: num(d[1]) };
  if (d && typeof d === 'object') return { green_to: num(d.green_to ?? d.green), amber_to: num(d.amber_to ?? d.amber) };
  return { green_to: null, amber_to: null };
}

/** The saved row for a site (or the company, locationId null) and metric, else null. */
export function savedTarget(saved, locationId, metric) {
  return asList(saved).find((r) => r && r.metric === metric && (r.location_id || null) === (locationId || null)) || null;
}

/**
 * What a site is measured against: its own row, else the company row, else the default:
 * { green_to, amber_to, source: 'site' | 'company' | 'default' }.
 */
export function effectiveTarget(saved, locationId, metric, defaults = null) {
  const own = locationId ? savedTarget(saved, locationId, metric) : null;
  if (own) return { green_to: num(own.green_to), amber_to: num(own.amber_to), source: 'site' };
  const company = savedTarget(saved, null, metric);
  if (company) return { green_to: num(company.green_to), amber_to: num(company.amber_to), source: 'company' };
  return { ...defaultTarget(defaults, metric), source: 'default' };
}

/** A metric where a higher number is better (GP %); every other metric is better low. */
export function betterHigh(metric, betterHighList = ['gp_pct']) {
  return asList(betterHighList).includes(metric);
}

/** The range a metric's targets may take: days 0 to 365, percents 0 to 100. */
export function targetRange(metric) {
  return metric === 'days_on_hand' ? { min: 0, max: 365 } : { min: 0, max: 100 };
}

/**
 * The typed cell as numbers: { green_to, amber_to } (null for an empty box, NaN never: a word that
 * is not a number stays a string so targetProblem can say so).
 */
export function parseTargetCell(cell) {
  const one = (v) => {
    if (v == null) return null;
    const t = String(v).trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : t;
  };
  return { green_to: one(cell?.green_to), amber_to: one(cell?.amber_to) };
}

/**
 * What stops one cell saving, in words, or null: both boxes or neither; numbers in range; green on
 * the better side of amber (the database's own words, so the screen says the same thing).
 */
export function targetProblem(metric, cell, betterHighList = ['gp_pct']) {
  const c = parseTargetCell(cell);
  if (c.green_to == null && c.amber_to == null) return null;
  if (c.green_to == null || c.amber_to == null) return 'Type both green and amber.';
  const { min, max } = targetRange(metric);
  for (const v of [c.green_to, c.amber_to]) {
    if (typeof v !== 'number' || v < min || v > max) return `Type a number from ${min} to ${max}.`;
  }
  const ok = betterHigh(metric, betterHighList) ? c.green_to >= c.amber_to : c.green_to <= c.amber_to;
  return ok ? null : 'Green must be the better side of amber.';
}

/** Every problem in a draft: { [key]: words }; {} when it can be saved. */
export function targetProblems(draft, betterHighList = ['gp_pct']) {
  const out = {};
  for (const [key, cell] of Object.entries(draft || {})) {
    const { metric } = splitTargetKey(key);
    const why = targetProblem(metric, cell, betterHighList);
    if (why) out[key] = why;
  }
  return out;
}

const sameNum = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(Number(a) - Number(b)) < 1e-9);

/**
 * The p_rows of stock_save_targets from what was typed: a changed cell with its row_version, a
 * cleared cell as a delete (a site row gone = back to the company row), a new cell with row_version
 * null, nothing for a cell that still says what is saved. At most 100 rows (the caller splits).
 */
export function targetSaveRows(draft, saved) {
  const rows = [];
  for (const [key, cell] of Object.entries(draft || {})) {
    const { location_id, metric } = splitTargetKey(key);
    const c = parseTargetCell(cell);
    const cleared = c.green_to == null && c.amber_to == null;
    const have = savedTarget(saved, location_id, metric);
    if (have) {
      if (cleared) { rows.push({ location_id, metric, delete: true, row_version: have.row_version ?? null }); continue; }
      if (sameNum(c.green_to, have.green_to) && sameNum(c.amber_to, have.amber_to)) continue;
      rows.push({ location_id, metric, green_to: c.green_to, amber_to: c.amber_to, row_version: have.row_version ?? null });
    } else if (!cleared) {
      rows.push({ location_id, metric, green_to: c.green_to, amber_to: c.amber_to, row_version: null });
    }
  }
  return rows;
}

/** 'Green 70, amber 65' for the Someone saved first table; '(none)' for no row. */
export function targetCellWords(cell) {
  if (!cell) return '(none)';
  const c = parseTargetCell(cell);
  if (c.green_to == null && c.amber_to == null) return '(none)';
  return `Green ${c.green_to ?? '?'}, amber ${c.amber_to ?? '?'}`;
}

/**
 * The Someone saved first rows for the targets panel: for each row we tried to save, what the fresh
 * read says and what we typed, labelled '<metric> at <site>' ('<metric>, company default').
 */
export function targetConflictRows(saveRows, fresh, metrics, siteName = () => 'a site') {
  const labels = Object.fromEntries(metricList(metrics).map((m) => [m.key, m.label]));
  return asList(saveRows).map((r) => {
    const theirs = savedTarget(fresh, r.location_id, r.metric);
    const where = r.location_id ? `at ${siteName(r.location_id) || 'a site'}` : 'company default';
    return {
      label: `${labels[r.metric] || r.metric}, ${where}`,
      theirs: targetCellWords(theirs),
      mine: r.delete ? '(cleared)' : targetCellWords(r),
    };
  });
}

/** The save rows again with the fresh versions (Save mine on top). */
export function withFreshVersions(saveRows, fresh) {
  return asList(saveRows).map((r) => {
    const f = savedTarget(fresh, r.location_id, r.metric);
    if (!f) return r.delete ? null : { ...r, row_version: null };
    return { ...r, row_version: f.row_version ?? null };
  }).filter(Boolean);
}

// ── key items: the editor's rules ────────────────────────────────────────────────────────────────

export const USED_UNITS = Object.freeze(['ml', 'g', 'each']);

/** What counts as sold, the quick choices first. */
export const SOLD_RULE_CHOICES = Object.freeze([
  Object.freeze({ id: 'drinks', label: 'All drinks', rule: Object.freeze({ kind: 'category', accounting_group: 'Drinks' }) }),
  Object.freeze({ id: 'food', label: 'All food', rule: Object.freeze({ kind: 'category', accounting_group: 'Food' }) }),
  Object.freeze({ id: 'all', label: 'Every sale', rule: Object.freeze({ kind: 'all' }) }),
  Object.freeze({ id: 'category', label: 'A category', rule: Object.freeze({ kind: 'category', accounting_group: '' }) }),
  Object.freeze({ id: 'items', label: 'Chosen products', rule: Object.freeze({ kind: 'items', menu_item_ids: Object.freeze([]) }) }),
]);

/** Which quick choice a stored sold_rule is ('category' for any other category). */
export function soldRuleChoice(rule) {
  const r = rule || {};
  if (r.kind === 'all') return 'all';
  if (r.kind === 'items') return 'items';
  if (r.kind === 'category') {
    const g = String(r.accounting_group || '').trim().toLowerCase();
    if (g === 'drinks') return 'drinks';
    if (g === 'food') return 'food';
    return 'category';
  }
  return 'all';
}

/** 'All drinks', 'All food', 'Every sale', 'Category: Retail', '3 chosen products', 'Not set'. */
export function soldRuleWords(rule) {
  const r = rule || {};
  if (r.kind === 'all') return 'Every sale';
  if (r.kind === 'items') {
    const n = asList(r.menu_item_ids).length;
    return n === 1 ? '1 chosen product' : `${n} chosen products`;
  }
  if (r.kind === 'category') {
    const choice = soldRuleChoice(r);
    if (choice === 'drinks') return 'All drinks';
    if (choice === 'food') return 'All food';
    const g = String(r.accounting_group || '').trim();
    return g ? `Category: ${g}` : 'Not set';
  }
  return 'Not set';
}

/**
 * What stops a key item saving, in words, or null: a name, the stock item it uses, a unit, what
 * counts as sold, a recipe amount that is a number if typed, and the 20 live limit for a new one.
 */
export function keyRatioProblem(draft, live = []) {
  const d = draft || {};
  if (!String(d.name || '').trim()) return 'Give the key item a name.';
  if (!d.used_item_id) return 'Pick the stock item it uses.';
  if (!USED_UNITS.includes(String(d.used_unit || '').trim())) return 'Pick the unit: ml, g or each.';
  const rule = d.sold_rule || {};
  if (!['all', 'category', 'items'].includes(rule.kind)) return 'Pick what counts as sold.';
  if (rule.kind === 'category' && !String(rule.accounting_group || '').trim()) return 'Pick what counts as sold.';
  if (rule.kind === 'items' && !asList(rule.menu_item_ids).filter(Boolean).length) return 'Pick what counts as sold.';
  if (d.recipe_amount != null && String(d.recipe_amount).trim() !== '') {
    const n = Number(String(d.recipe_amount).trim());
    if (!Number.isFinite(n) || n < 0) return 'Type the recipe amount as a number.';
  }
  if (!d.id && asList(live).filter((r) => r && !r.archived_at).length >= MAX_KEY_ITEMS) return KEY_ITEMS_FULL;
  return null;
}

/** A search word made safe for a like pattern: % _ and backslash match themselves. */
export function likeWords(text) {
  return String(text || '').trim().replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The till products a key item can count as sold ('Chosen products'): live menu_items at the sites
 * in scope whose name holds the words, name order, at most 50. The client is passed in (the Ops
 * client on screen, a stand in under node:test). Answer { data: [{ id, name, location_id }], error }.
 * Under two letters asks nothing and answers no rows.
 */
export async function searchMenuProducts(client, { sites = [], search = '', limit = 30 } = {}) {
  const ids = asList(sites).filter(Boolean).map(String);
  const words = String(search || '').trim();
  if (!ids.length || words.length < 2) return { data: [], error: null };
  if (!client || typeof client.from !== 'function') return { data: [], error: new Error('No database') };
  const cap = Math.min(Math.max(Math.trunc(Number(limit) || 30), 1), 50);
  try {
    const res = await client.from('menu_items').select('id, name, location_id')
      .in('location_id', ids).eq('archived', false).ilike('name', `%${likeWords(words)}%`)
      .order('name').limit(cap);
    if (res?.error) return { data: [], error: res.error };
    return { data: asList(res?.data).filter((r) => r && r.id != null).map((r) => ({ id: String(r.id), name: r.name || 'Product', location_id: r.location_id ?? null })), error: null };
  } catch (e) {
    return { data: [], error: e instanceof Error ? e : new Error(String(e)) };
  }
}

/** One element of stock_save_key_ratios p_rows from the editor's draft. */
export function keyRatioSaveRow(draft, { archive = false } = {}) {
  const d = draft || {};
  const rule = d.sold_rule || { kind: 'all' };
  const amount = d.recipe_amount == null || String(d.recipe_amount).trim() === '' ? null : Number(String(d.recipe_amount).trim());
  const soldRule = rule.kind === 'category'
    ? { kind: 'category', accounting_group: String(rule.accounting_group || '').trim() }
    : rule.kind === 'items'
      ? { kind: 'items', menu_item_ids: [...new Set(asList(rule.menu_item_ids).filter(Boolean).map(String))] }
      : { kind: 'all' };
  return {
    id: d.id || null,
    name: String(d.name || '').trim(),
    used_item_id: d.used_item_id || null,
    used_unit: String(d.used_unit || '').trim(),
    sold_rule: soldRule,
    recipe_amount: Number.isFinite(amount) ? amount : null,
    sort_order: Number.isFinite(Number(d.sort_order)) ? Math.trunc(Number(d.sort_order)) : 0,
    row_version: d.row_version == null ? null : Number(d.row_version),
    archive: archive === true,
  };
}

/** A stock_key_ratios row as the editor's draft (the item's name rides along when known). */
export function keyRatioDraft(row, itemName = null) {
  const r = row || {};
  return {
    id: r.id || null,
    name: String(r.name || ''),
    used_item_id: r.used_item_id || null,
    used_item_name: itemName || r.used_item_name || '',
    used_unit: String(r.used_unit || 'ml'),
    sold_rule: r.sold_rule && typeof r.sold_rule === 'object' ? { ...r.sold_rule } : { kind: 'category', accounting_group: 'Drinks' },
    recipe_amount: r.recipe_amount == null ? '' : String(r.recipe_amount),
    sort_order: Number.isFinite(Number(r.sort_order)) ? Number(r.sort_order) : 0,
    row_version: r.row_version == null ? null : Number(r.row_version),
  };
}
