// src/lib/online/menuSearch.js
//
// MENU SEARCH on the online page (5.12.34). PURE, tested in menuSearch.test.js.
//
// Filters the rows the page already shows (the itemsForCat rows: sold alone, visible on this
// channel, on the menu), never the raw table, so option only sub items and hidden products can
// never surface through search. The accessors are injected so the menu language switch
// (lib/menuText.js itemName / itemDescription / categoryLabel) is what is searched, not the
// English alone. The section label counts too: "pizza" finds the pizzas named Pepperoni.

/** Trimmed, lower case, single spaced. */
export function normaliseQuery(q) {
  return String(q ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Every word of the query appears in the name, the description or the section it sits in
 *  (accents ignored). `section` gives the section label(s) a row is shown under, so "pizza" finds
 *  Pepperoni and Margherita in Sourdough Pizza, as a customer expects. */
export function matchesSearch(row, query, { name, description, section } = {}) {
  const q = normaliseQuery(query);
  if (!q) return true;
  const sec = section ? section(row) : null;
  const secWords = Array.isArray(sec) ? sec.join(' ') : (sec ?? '');
  const hay = fold(`${(name ? name(row) : (row?.menu_name || row?.name)) ?? ''} ${(description ? description(row) : row?.description) ?? ''} ${secWords}`);
  return fold(q).split(' ').every((w) => hay.includes(w));
}

/** The rows that match, in the order given, each row once. */
export function searchMenuRows(rows, query, accessors = {}) {
  const q = normaliseQuery(query);
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    if (matchesSearch(r, q, accessors)) out.push(r);
  }
  return out;
}

/** "3 results" / "1 result" / "No results for 'x'". */
export function searchCountWords(count, query) {
  const n = Math.max(0, Number(count) || 0);
  if (!n) return `No results for '${normaliseQuery(query)}'`;
  return n === 1 ? '1 result' : `${n} results`;
}
