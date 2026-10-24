// src/lib/ownerStock.js: the Owner app's Stock line and Stock card, the part that is not drawing.
//
// v5.11.92 (multi site stock Drop 4a, 21 Oct 2026). Every venue card gets one line under its
// stats: 'Stock £3,210 · GP 72.8% · gap 1.3% · waste 1.9% · last count Mon 13 Oct', with the gap
// and the waste coloured red, amber or green by the database's own targets. The venue screen gets
// a Stock card: the same figures as tiles, each with its colour, then what needs attention.
//
// THE RULES THIS FILE KEEPS
//   * Every figure is the function's (owner-snapshot's `stock` block, from stock_report_league and
//     stock_report_dashboard: stored day totals, demo history left out, each venue on its own
//     business day). Nothing here works a percent out; this file only finds the words.
//   * AN OLD FUNCTION. The app ships before the function is deployed. A function from before the
//     stock block says so (no 'stock' in `features`) and the card shows nothing at all: never a
//     wrong label. A function WITH the feature that has nothing true to show for a venue sends
//     `stock: null` and a `stock_reason`, and the card shows that reason in grey (stockNote), except
//     'no_stock' (v5.11.100): a venue with no stock draws nothing at all.
//   * Colours are the database's rag words ('green', 'amber', 'red'); a missing one is grey.
//   * No em or en dash anywhere; money in the venue's own currency.
//
// PURE: node:test loads it (src/lib/ownerStock.test.js).

import { hasFeature } from './ownerCompare.js';

/** True when the snapshot's own function sends the stock block. */
export const canStock = (snapshot) => hasFeature(snapshot, 'stock');

// v5.11.100 (owner, 23 Oct 2026): a venue that holds no stock draws NOTHING (no card, no line, no
// note), so the Stock card and line appear by themselves once the venue holds stock. Only a real
// problem keeps its grey note: the function is too old, or the stock could not be read.
export const STOCK_NOTES = Object.freeze({
  not_installed: 'Stock reports need a ServOS update',
  failed: 'Stock could not be read',
});

/** The reasons that draw nothing at all (the venue has no stock yet). */
export const SILENT_STOCK_REASONS = Object.freeze(['no_stock']);

/** The grey words for a venue with no stock block, or null when nothing is drawn (no stock, no reason). */
export function stockNote(reason) {
  if (SILENT_STOCK_REASONS.includes(reason)) return null;
  return STOCK_NOTES[reason] || null;
}

/** The colour of a red, amber, green word; grey when the database gave none. */
export function stockTone(rag) {
  if (rag === 'green') return 'var(--grn, #16a34a)';
  if (rag === 'amber') return 'var(--amber, #F5A623)';
  if (rag === 'red') return 'var(--red)';
  return 'var(--t3)';
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** '72.8%' with one decimal, or null when there is no figure (the card then says so, never 0%). */
export function pctWords(v) {
  if (!isNum(v)) return null;
  return `${(Math.round(v * 10) / 10).toFixed(1)}%`;
}

/** '6.2' days with one decimal, or null. */
export function daysWords(v) {
  if (!isNum(v)) return null;
  return (Math.round(v * 10) / 10).toFixed(1);
}

/** 'Mon 13 Oct' from a 'YYYY-MM-DD' day (no clock involved), or null. */
export function dayWords(ymd) {
  if (typeof ymd !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const d = new Date(`${ymd}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(/,/g, '');
}

/** Whole pounds (or dollars) in the venue's currency, the Owner app's money format. */
export function moneyWords(n, currency = 'GBP', dp = 0) {
  try { return new Intl.NumberFormat('en-GB', { style: 'currency', currency: currency || 'GBP', minimumFractionDigits: dp, maximumFractionDigits: dp }).format(Number(n) || 0); }
  catch { return `${(Number(n) || 0).toFixed(dp)} ${currency || ''}`.trim(); }
}

const ragOf = (stock, metric) => (stock?.rag && typeof stock.rag === 'object' ? stock.rag[metric] ?? null : null);

/**
 * The Stock line's parts, in order: [{ key, text, tone }]. `tone` is a colour only on the gap
 * and the waste (the two figures with targets on the card); the rest are plain.
 *   Stock £3,210 · GP 72.8% · gap 1.3% · waste 1.9% · budget £4,880 of £5,100 · last count Mon 13 Oct
 * GP is the actual GP when the database has it, else the theoretical with the word 'theo'; no
 * sales in the period reads 'GP: no sales'. The budget part shows only when a budget is set
 * (none until the purchasing update). A central kitchen has no sales figures: 'kitchen' instead.
 * @returns {{ parts: { key: string, text: string, tone: string | null }[], text: string } | null}
 */
export function stockLine(stock, currency, fmt = moneyWords) {
  if (!stock || typeof stock !== 'object') return null;
  const cur = stock.currency || currency || 'GBP';
  // A value the database did not send reads 'value not known', never £0.
  const parts = [{ key: 'value', text: isNum(stock.value) ? `Stock ${fmt(stock.value, cur)}` : 'Stock value not known', tone: null }];
  if (stock.kitchen) {
    parts.push({ key: 'kitchen', text: 'central kitchen, no sales', tone: null });
  } else {
    const gpA = pctWords(stock.gp_pct_actual), gpT = pctWords(stock.gp_pct_theo);
    parts.push({ key: 'gp', text: gpA ? `GP ${gpA}` : gpT ? `GP ${gpT} theo` : 'GP: no sales', tone: null });
    const gap = pctWords(stock.gap_pct);
    parts.push({ key: 'gap', text: gap ? `gap ${gap}` : 'gap: no sales', tone: gap ? stockTone(ragOf(stock, 'gap_pct')) : null });
    const waste = pctWords(stock.waste_pct);
    parts.push({ key: 'waste', text: waste ? `waste ${waste}` : 'waste: no sales', tone: waste ? stockTone(ragOf(stock, 'waste_pct')) : null });
  }
  if (isNum(stock.budget) && stock.budget > 0) {
    parts.push({ key: 'budget', text: `budget ${fmt(stock.purchases, cur)} of ${fmt(stock.budget, cur)}`, tone: stockTone(ragOf(stock, 'budget_pct')) });
  }
  const day = dayWords(stock.last_full_count_day);
  parts.push({ key: 'count', text: day ? `last count ${day}` : 'no full count yet', tone: null });
  return { parts, text: parts.map((p) => p.text).join(' · ') };
}

/**
 * The Stock card's tiles for the venue screen: [{ key, label, text, tone }], every figure the
 * database's, each with its colour where it has a target. A figure the database has not got reads
 * 'No sales', 'No use' or 'None yet' in grey, never 0.
 */
export function stockTiles(stock, currency, fmt = moneyWords) {
  if (!stock || typeof stock !== 'object') return [];
  const cur = stock.currency || currency || 'GBP';
  const grey = 'var(--t3)';
  const plain = 'var(--t1)';
  const pctTile = (key, label, v, metric) => {
    const w = pctWords(v);
    return { key, label, text: w || 'No sales', tone: w ? (metric ? stockTone(ragOf(stock, metric)) : plain) : grey };
  };
  const day = dayWords(stock.last_full_count_day);
  const days = daysWords(stock.days_on_hand);
  const tiles = [
    { key: 'value', label: 'Stock value', text: isNum(stock.value) ? fmt(stock.value, cur) : 'Not known', tone: isNum(stock.value) ? plain : grey },
    pctTile('gp_theo', 'GP % theoretical', stock.gp_pct_theo, null),
    pctTile('gp_actual', 'GP % actual', stock.gp_pct_actual, 'gp_pct'),
    pctTile('gap', 'Gap %', stock.gap_pct, 'gap_pct'),
    pctTile('waste', 'Waste %', stock.waste_pct, 'waste_pct'),
    pctTile('comps', 'Loyalty, staff and comps %', stock.comps_pct, 'comps_pct'),
    { key: 'days', label: 'Days on hand', text: days || 'No use', tone: days ? stockTone(ragOf(stock, 'days_on_hand')) : grey },
    { key: 'count', label: 'Last full count', text: day || 'None yet', tone: day ? plain : grey },
    { key: 'par', label: 'Below par', text: String(Number(stock.below_par_count) || 0), tone: (Number(stock.below_par_count) || 0) > 0 ? stockTone('amber') : plain },
  ];
  if (isNum(stock.budget) && stock.budget > 0) {
    tiles.splice(6, 0, { key: 'budget', label: 'Purchases against budget', text: `${fmt(stock.purchases, cur)} of ${fmt(stock.budget, cur)}`, tone: stockTone(ragOf(stock, 'budget_pct')) });
  }
  return tiles;
}

export const ATTENTION_LABELS = Object.freeze({
  negative_stock: 'Negative stock',
  below_minimum: 'Below minimum',
  out_of_step: 'Site out of step',
  invoice_review: 'Invoices to review',
  clock_disagrees: 'Clock disagrees',
  demo_history: 'Demo history',
  not_posted: 'Sales not yet posted to stock',
});

const labelOf = (kind) => {
  if (ATTENTION_LABELS[kind]) return ATTENTION_LABELS[kind];
  const s = String(kind ?? '').replace(/[-_]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Other';
};

/**
 * The attention rows for the card: one per kind with its count and the database's words, the
 * biggest count first, rows worth nothing dropped.
 * @returns {{ kind: string, label: string, count: number, words: string | null }[]}
 */
export function attentionRows(list) {
  const byKind = new Map();
  for (const a of Array.isArray(list) ? list : []) {
    if (!a || typeof a !== 'object') continue;
    const kind = String(a.kind || 'other');
    const count = Math.max(0, Math.floor(Number(a.count) || 0));
    const e = byKind.get(kind) || { kind, label: labelOf(kind), count: 0, words: null };
    e.count += count;
    if (!e.words && typeof a.words === 'string' && a.words) e.words = a.words;
    byKind.set(kind, e);
  }
  return [...byKind.values()].filter((r) => r.count > 0).sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : 1));
}

/** The grey line under the Stock card's title. */
export function stockCardNote(stock) {
  const bits = ['Stored day totals, each venue on its own business day'];
  if (stock?.demo_left_out) bits.push('Demo history left out');
  if (stock?.not_posted && (Number(stock.not_posted.count) || 0) > 0) bits.push(`${stock.not_posted.count} sale${stock.not_posted.count === 1 ? '' : 's'} not yet posted to stock`);
  return `${bits.join('. ')}.`;
}
