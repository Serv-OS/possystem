// src/lib/hq/primeCost.js
//
// The head office scorecard's arithmetic. Pure: no React, no database.
//
// Prime cost = (COGS + labour) / net sales, as a percentage. Each site's figures come from two
// places, and the till always wins:
//   * the Owner snapshot (supabase/functions/owner-snapshot): net sales, labour money and
//     labour %, and the stock block's actual GP % when the site runs stock;
//   * hq_daily_numbers: what the tills cannot know (cash, morale, hires, turnover, the three
//     projected dayparts) and, for a day the tills did not see, typed or pasted net sales,
//     COGS and labour.
// A figure that neither place has is null, and the screen says so. Never a guessed zero.

import { sourcesMap, partsOf } from './systemDay.js';

export const PRIME_COST_TARGET = 60;

const num = (v) => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

/** (cogs + labour) / net as a percentage, one decimal, or null when a part is missing or net is 0. */
export function primeCostPct({ net, cogs, labour } = {}) {
  const n = num(net); const c = num(cogs); const l = num(labour);
  if (n === null || n <= 0 || c === null || l === null) return null;
  return r1(((c + l) / n) * 100);
}

/** COGS % from the snapshot's stock block: 100 minus actual GP (theoretical GP when actual is missing). */
export function cogsPctFromStock(stock) {
  if (!stock) return null;
  const gp = num(stock.gp_pct_actual ?? stock.gp_pct_theo ?? stock.gp_pct);
  return gp === null ? null : r1(100 - gp);
}

/** Which word for a morale score out of 10. */
export function moraleWord(score) {
  const s = num(score);
  if (s === null) return null;
  if (s >= 8) return 'Strong';
  if (s >= 6.5) return 'Steady';
  return 'Watch';
}

/** Green under the target, orange on or over it, null when there is no figure. */
export function primeTone(pct, target = PRIME_COST_TARGET) {
  const p = num(pct);
  if (p === null) return null;
  return p < target ? 'grn' : 'orn';
}

/**
 * One site's scorecard row.
 *  venue: a venue from the Owner snapshot (may be null when the function could not be reached)
 *  typed: the newest hq_daily_numbers row for the site (may be null)
 * Returns the merged figures plus `from`, naming where each came from, so the screen can
 * mark a typed figure.
 */
export function siteRow({ id, name, code, currency, venue = null, typed = null, target = PRIME_COST_TARGET } = {}) {
  const t = venue?.today || venue || {};
  const snapNet = num(t.net_sales);
  const snapLabour = num(t.labour);
  const typedNet = num(typed?.net_sales);
  const typedCogs = num(typed?.cogs);
  const typedLabour = num(typed?.labour);

  // A saved day names where each figure came from (slice 3 sources map); a row without one was typed or pasted.
  const saved = sourcesMap(typed);
  const savedFrom = (col) => (saved ? (saved[col] || 'typed') : (typed?.source === 'csv' ? 'csv' : 'typed'));
  const net = snapNet !== null && snapNet > 0 ? snapNet : typedNet;
  const netFrom = snapNet !== null && snapNet > 0 ? 'till' : (typedNet !== null ? savedFrom('net_sales') : null);

  let labourPct = null; let labourFrom = null;
  if (snapLabour !== null && net !== null && net > 0 && netFrom === 'till') { labourPct = r1((snapLabour / net) * 100); labourFrom = 'till'; }
  else if (typedLabour !== null && net !== null && net > 0) { labourPct = r1((typedLabour / net) * 100); labourFrom = savedFrom('labour'); }

  let cogsPct = cogsPctFromStock(venue?.stock); let cogsFrom = cogsPct === null ? null : 'stock';
  if (cogsPct === null && typedCogs !== null && net !== null && net > 0) { cogsPct = r1((typedCogs / net) * 100); cogsFrom = savedFrom('cogs'); }

  const prime = cogsPct === null || labourPct === null ? null : r1(cogsPct + labourPct);
  const compare = venue?.compare || null;
  const weekCompare = venue?.week_compare || null;

  return {
    id, name, code: code || shortCode(name), currency: currency || venue?.currency || null,
    net, labourPct, cogsPct, prime, tone: primeTone(prime, target),
    momPct: num(compare?.pct), momReason: compare?.reason || null,
    wowPct: num(weekCompare?.pct ?? weekCompare?.vs_last_week_pct),
    morale: num(typed?.morale_score), moraleWord: moraleWord(typed?.morale_score),
    hires: num(typed?.hires_needed), turnoverPct: num(typed?.turnover_pct), cash: num(typed?.cash_on_hand),
    rating: num(typed?.review_rating), reviews: num(typed?.reviews_count),
    projected: { lunch: num(typed?.projected_lunch), dinner: num(typed?.projected_dinner), late: num(typed?.projected_late) },
    // Slice 3: the venue's own service periods, [{ key, name, amount }] (older rows: lunch, dinner, late).
    parts: partsOf(typed),
    typedOn: typed?.business_date || null,
    // Slice 3: a saved day names where each figure came from (typed.sources); a row from before
    // that was typed or pasted, so every figure it holds counts as typed.
    from: { net: netFrom, labour: labourFrom, cogs: cogsFrom, ...fieldSources(typed) },
  };
}

const SOURCE_FIELDS = { morale: 'morale_score', hires: 'hires_needed', turnover: 'turnover_pct', rating: 'review_rating', reviews: 'reviews_count', projected: 'projected_lunch' };
/** { morale, hires, turnover, rating, reviews, projected }: 'typed' | 'csv' | 'forecast' | 'reviews' | 'workforce' | ... | null, from a saved day's sources map. */
export function fieldSources(typed) {
  const out = {};
  const map = sourcesMap(typed);
  for (const [k, col] of Object.entries(SOURCE_FIELDS)) {
    if (!typed || typed[col] === null || typed[col] === undefined) { out[k] = null; continue; }
    out[k] = map ? (map[col] || null) : (typed.source === 'csv' ? 'csv' : 'typed');
  }
  // The parts: typed when any period was overridden, else the one source they share.
  const parts = partsOf(typed);
  if (!parts.length) out.projected = null;
  else if (map?.parts) { const srcs = Object.values(map.parts); out.projected = srcs.includes('typed') ? 'typed' : (srcs[0] || null); }
  else out.projected = map ? (map.projected_lunch || map.projected_dinner || map.projected_late || null) : (typed.source === 'csv' ? 'csv' : 'typed');
  return out;
}

/** Three letters for the ladder: initials of three words, else first letter + next consonant + the
 *  second word's first letter ("Delta Center" DLC, "Milk Block" MLB), else first letter + two
 *  consonants ("Provo" PRV, "Sandy" SND). A site can carry its own code later. */
export function shortCode(name) {
  const words = String(name || '').toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  if (words.length >= 3) return words.slice(0, 3).map((w) => w[0]).join('');
  const cons = (w) => w.slice(1).replace(/[AEIOU]/g, '');
  if (words.length === 2) return (words[0][0] + (cons(words[0])[0] || words[0][1] || '') + words[1][0]).slice(0, 3);
  const w = words[0];
  return (w[0] + cons(w) + w.slice(1)).slice(0, 3);
}

/** Sites in prime cost order, lowest first; a site with no figure goes last, higher sales first among equals. */
export function rankSites(rows) {
  const sorted = [...(rows || [])].sort((a, b) => {
    const ap = a.prime === null || a.prime === undefined; const bp = b.prime === null || b.prime === undefined;
    if (ap && bp) return (b.net || 0) - (a.net || 0);
    if (ap) return 1;
    if (bp) return -1;
    if (a.prime !== b.prime) return a.prime - b.prime;
    return (b.net || 0) - (a.net || 0);
  });
  return sorted.map((r, i) => ({ ...r, rank: r.prime === null || r.prime === undefined ? null : i + 1 }));
}

/**
 * The group's figures. Prime cost is weighted by sales, so a big site counts for more, and
 * only sites with a full set of figures are in it. Morale is a plain average of the sites
 * that have one. Hires and cash add up. Rating is weighted by review count when counts exist.
 */
export function portfolio(rows) {
  const list = rows || [];
  let net = 0; let cost = 0; let sites = 0;
  for (const r of list) {
    if (r.prime === null || r.prime === undefined || !r.net) continue;
    net += r.net; cost += (r.prime / 100) * r.net; sites += 1;
  }
  const morale = avg(list.map((r) => r.morale));
  const hires = sum(list.map((r) => r.hires));
  const cash = sum(list.map((r) => r.cash));
  const turnover = avg(list.map((r) => r.turnoverPct));
  const reviews = sum(list.map((r) => r.reviews));
  const rated = list.filter((r) => r.rating !== null && r.rating !== undefined);
  let rating = null;
  if (rated.length) {
    const withCounts = rated.filter((r) => r.reviews);
    rating = withCounts.length
      ? Math.round((withCounts.reduce((s, r) => s + r.rating * r.reviews, 0) / withCounts.reduce((s, r) => s + r.reviews, 0)) * 100) / 100
      : Math.round(avg(rated.map((r) => r.rating)) * 100) / 100;
  }
  const netToday = sum(list.map((r) => r.net));
  return {
    prime: net > 0 ? r1((cost / net) * 100) : null, primeSites: sites,
    netToday, morale: morale === null ? null : r1(morale), hires, cash, turnover: turnover === null ? null : r1(turnover),
    rating, reviews,
    leader: rankSites(list).find((r) => r.rank === 1) || null,
  };
}

function avg(values) {
  const v = values.map(num).filter((x) => x !== null);
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}
function sum(values) {
  const v = values.map(num).filter((x) => x !== null);
  return v.length ? v.reduce((s, x) => s + x, 0) : null;
}

/** "$7.9k", "$34k", "$412", with the venue's currency symbol. Never rounds under a thousand. */
export function shortMoney(n, currency = 'USD') {
  const v = num(n);
  if (v === null) return null;
  const sym = currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : '$';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e6) return `${sign}${sym}${(abs / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}m`;
  if (abs >= 1e4) return `${sign}${sym}${Math.round(abs / 1e3)}k`;
  if (abs >= 1e3) return `${sign}${sym}${(abs / 1e3).toFixed(1)}k`;
  return `${sign}${sym}${Math.round(abs)}`;
}
