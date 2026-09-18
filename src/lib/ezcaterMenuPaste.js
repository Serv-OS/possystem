// src/lib/ezcaterMenuPaste.js
//
// LOAD THE CATERER'S WHOLE EZCATER MENU BEFORE ANY ORDER.
//
// Peter, 18 Sep 2026: "we cant have it that we match products after an order
// has been placed that makes no sense someone would have to order the entire
// menu". Until now ezcater_item_links only got a row when a name arrived on an
// order, so Item matching could only ever show what had already been ordered.
//
// There is no API for this. ezCater confirmed in writing (17 Sep 2026) that
// this integration has no Menus API, and their menu ids change on every
// republish, so the name is the only durable key. What the caterer DOES have is
// their menu on screen:
//
//   * ezManage (the caterer portal) has a Menus tab. Caterers cannot edit their
//     menu there, they view it and request changes, and it links to the menu as
//     customers see it on the ezCater marketplace.
//   * ezCater's help pages describe no menu export (no CSV, no PDF download) in
//     ezManage. The Reports tab downloads ORDER reports, which list item names.
//
// So: select all on that menu page, copy, paste it into Back Office, and this
// file turns the text into items, sizes and customisation options. A CSV or
// spreadsheet (a Reports download, or a menu the venue keeps themselves) is
// read too, by its header row.
//
// THE MENU SHAPE (ezCater's menu guidance and ItemSelectionInput docs):
//   category > item (name, description) > selections, each a size name
//   ("Half Tray", '12" Pizza', or blank when there is one size), a price and a
//   "serves" number > options (a named group, required or not, min and max) >
//   choices (a name, and a price when it costs extra, shown as "+$1.50").
//
// PURE. No React, no Supabase, no clock. The Back Office screen parses, shows
// what it understood, and only then sends the names to ezcater-connect
// items_paste, which re-keys every name with the shared rules and writes the
// rows. A pasted row is exactly the row a first order would have written
// (seen_count 0, never on an order yet), so a later real order lands on it.

import {
  autoLinkDecision, buildLinkKey, ezLineName, indexLinks, findLink, displayNameOf,
} from './ezcaterMatch.js';

/** More than this and the paste is refused rather than half saved. */
export const PASTE_MAX_ENTRIES = 1500;
/** About 400 KB of text. A real catering menu is a small fraction of this. */
export const PASTE_MAX_CHARS = 400000;
/** Longest name kept. Past this a "name" is a paragraph that was misread. */
export const PASTE_MAX_NAME = 120;

// ----------------------------------------------------------------------------
// Small text helpers
// ----------------------------------------------------------------------------

const clean = (s) => String(s == null ? '' : s).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

// Separators a copied page puts between a name, a size and a price: hyphen,
// en dash, em dash, pipe, colon, middle dot, bullet.
const SEP = '[-\\u2013\\u2014|:\\u00b7\\u2022,]';
const EDGE_SEP = new RegExp('^(?:\\s|' + SEP + ')+|(?:\\s|' + SEP + ')+$', 'g');
const trimSeps = (s) => clean(String(s).replace(EDGE_SEP, ''));

// A price: "$45", "$1,250.00", "\u00a312.50", "\u20ac9", or a bare "45.00". An optional
// "+" in front marks a choice that costs extra. "/person", "per person", "ea"
// and "each" after it are part of the price, not of the name.
const PRICE_RE = new RegExp(
  '(\\+\\s*)?(?:[$\\u00a3\\u20ac]\\s?(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?|\\b(\\d{1,5})\\.(\\d{2})(?!\\d))'
  + '(?:\\s*(?:\\/\\s*|per\\s+)(?:person|guest|head|pp|each|ea|item|tray|dozen)\\b|\\s+(?:each|ea)\\b)?',
  'i',
);

/**
 * Pull one price out of a line. Returns { price, plus, rest } or null.
 * rest is the line with the price taken out, edges tidied.
 */
export function takePrice(line) {
  const s = String(line == null ? '' : line);
  const m = PRICE_RE.exec(s);
  if (!m) return null;
  const whole = m[2] != null ? m[2].replace(/,/g, '') : m[4];
  const frac = m[2] != null ? (m[3] || '0') : m[5];
  const price = Number(whole + '.' + String(frac).padEnd(2, '0'));
  if (!Number.isFinite(price)) return null;
  const rest = trimSeps(s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length));
  return { price: Math.round(price * 100) / 100, plus: !!m[1], rest };
}

const SERVES_RE = /\b(?:serves|feeds|serving)\s*:?\s*(\d{1,4})(?:\s*(?:-|to|\u2013|\u2014)\s*(\d{1,4}))?(?:\s*(?:people|persons?|guests?|pax))?\b/i;
const PEOPLE_RE = /\b(\d{1,4})(?:\s*(?:-|to|\u2013)\s*(\d{1,4}))?\s*(?:people|persons?|guests?|pax)\b/i;

/** "Serves 10-12" out of a line. Returns { serves, rest } or null. */
export function takeServes(line) {
  const s = String(line == null ? '' : line);
  const m = SERVES_RE.exec(s) || PEOPLE_RE.exec(s);
  if (!m) return null;
  const rest = trimSeps((s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length)).replace(/\(\s*\)/g, ' '));
  return { serves: m[2] ? m[1] + '-' + m[2] : m[1], rest };
}

// Things a copied web page is full of that are never a menu name.
const JUNK = [
  /^add( to (cart|order|bag))?$/i, /^(most )?popular$/i, /^(new|sold out|unavailable|featured)$/i,
  /^view (photos?|details|item|more)$/i, /^see (more|less|all)$/i, /^(photo|image|picture)s?$/i,
  /^(qty|quantity)\b.*$/i, /^(min(imum)?|max(imum)?)\b.*$/i, /^order (now|online)$/i,
  /^(each|ea|per person|\/\s*person|pp|per guest)$/i, /^\(?\d+\)?$/, /^[\d.]+\s*(stars?|reviews?|ratings?)\b.*$/i,
  /^\d+\s*(cal|kcal|calories)\b.*$/i, /^(close|back|menu|search|sign in|log ?in|help|cart)$/i,
  /^(vegetarian|vegan|gluten[- ]free|halal|kosher|spicy|healthy)$/i, /^(required|optional)$/i,
  /^(individually (wrapped|packaged))$/i,
];
const isJunk = (s) => !s || JUNK.some((re) => re.test(s));

// A size is short and made of size words: "Half Tray", "Large", '12" Pizza',
// "Box of 12", "Individual", "2 Dozen".
const SIZE_HINT = /\b(small|medium|large|regular|half|full|mini|jumbo|x-?large|xl|individual|single|double|family|party|tray|pan|platter|box|boxed|dozen|pint|quart|gallon|liters?|litres?|ltr|l|bottles?|cans?|pieces?|pcs?|count|ct|oz|lbs?|pounds?|inch|in|size|portion|each|package|pack|bowl|bucket|carafe|jug|servings?)\b|["\u201d\u2033]|^\d+\s*(x\s*)?\S*$/i;
const isSizeLike = (s) => {
  const w = clean(s).split(' ').filter(Boolean);
  return w.length > 0 && w.length <= 5 && SIZE_HINT.test(s);
};

const GROUP_WORD = /^(choose|select|pick|add|add[- ]?ons?|extras?|options?|customi[sz](e|ations?)|sides?|toppings?|dressings?|sauces?|proteins?|breads?|cheeses?|drinks?|beverages?|substitut\w*|upgrades?|make it|would you like|your choice)\b/i;
const GROUP_FLAG = /\((required|optional)\)|\b(required|optional)\s*$|\b(choose|select|pick)\s+(up to\s+|any\s+)?\d+\b|\bup to \d+\b/i;
const isGroupHeading = (s) => {
  const t = clean(s);
  if (!t || t.length > 80) return false;
  if (GROUP_FLAG.test(t) || GROUP_WORD.test(t)) return true;
  return /:$/.test(t) && t.split(' ').length <= 6;
};

/** { required, min, max } read from a group heading. */
function groupRules(s) {
  const t = clean(s);
  const out = { required: /\brequired\b/i.test(t), min: null, max: null };
  const upTo = /\bup to (\d+)\b/i.exec(t);
  if (upTo) out.max = Number(upTo[1]);
  const exactly = /\b(?:choose|select|pick)\s+(\d+)\b/i.exec(t);
  if (exactly && !upTo) { out.min = Number(exactly[1]); out.max = Number(exactly[1]); out.required = true; }
  if (out.required && out.min == null) out.min = 1;
  return out;
}

const groupName = (s) => clean(clean(s)
  .replace(/\([^()]*\)/g, ' ')
  .replace(/\b(required|optional)\s*$/i, ' ')
  .replace(/:$/, ''));

// A leading tick box, bullet or radio in front of a choice.
const CHOICE_MARK = /^(?:[-*\u2022\u00b7\u25cb\u25cf\u25ef\u25a1\u2610\u2611\u2713\u2714]|\(\s?\)|\[\s?\])\s*/;

const isDescription = (s) => {
  const t = clean(s);
  if (!t) return false;
  const words = t.split(' ').length;
  return t.length > 60 || words >= 8 || /[.!]$/.test(t) || (t.indexOf(',') !== -1 && words >= 3);
};

const isAllCaps = (s) => /[A-Z]/.test(s) && s === s.toUpperCase() && !/[a-z]/.test(s);

// ----------------------------------------------------------------------------
// Tables: CSV, TSV, a spreadsheet copied as cells
// ----------------------------------------------------------------------------

/** One CSV line into cells, honouring quotes. Tabs split too when asked. */
export function splitRow(line, delim) {
  if (delim === '\t') return String(line).split('\t').map(clean);
  const out = [];
  let cur = '';
  let q = false;
  const s = String(line);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"' && s[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim) { out.push(clean(cur)); cur = ''; }
    else cur += ch;
  }
  out.push(clean(cur));
  return out;
}

const COLS = {
  category: /^(category|section|menu section|menu category|group name)$/i,
  item: /^(item|items|item name|menu item|menu item name|product|product name|name|dish)$/i,
  size: /^(size|size name|item size|selection|serving size|portion|variant)$/i,
  price: /^(price|unit price|item price|cost|amount)$/i,
  serves: /^(serves|servings|feeds)$/i,
  group: /^(customi[sz]ation type|customi[sz]ation group|option group|options group|modifier group|option|options|group)$/i,
  choice: /^(customi[sz]ation|customi[sz]ations|choice|choices|option name|option choice|modifier|modifiers)$/i,
};

/** Column index per role, or null when the header names no item column. */
export function readHeader(cells) {
  const idx = {};
  (cells || []).forEach((c, i) => {
    const t = clean(c);
    for (const role of Object.keys(COLS)) {
      if (idx[role] == null && COLS[role].test(t)) { idx[role] = i; break; }
    }
  });
  return idx.item != null || idx.choice != null ? idx : null;
}

function parseTable(lines, delim) {
  const warnings = [];
  const items = [];
  let head = null;
  let current = null;
  const byName = new Map();

  for (const raw of lines) {
    if (!clean(raw)) continue;
    const cells = splitRow(raw, delim);
    const h = readHeader(cells);
    // A second header (our own export has one for Options) restarts the roles.
    if (h && (!head || cells.some((c) => COLS.item.test(c) || COLS.choice.test(c)))) {
      const looksLikeHeader = cells.every((c) => !c || !takePrice(c));
      if (looksLikeHeader) { head = h; continue; }
    }
    if (!head) continue;
    const at = (role) => (head[role] != null ? clean(cells[head[role]]) : '');
    const name = at('item');
    const size = at('size');
    const priceCell = at('price');
    const p = priceCell ? takePrice(priceCell.indexOf('$') === -1 && /^\d+(\.\d+)?$/.test(priceCell) ? '$' + priceCell : priceCell) : null;
    const serves = at('serves');
    const group = at('group');
    const choice = at('choice');

    if (name) {
      const key = name.toLowerCase();
      current = byName.get(key) || null;
      if (!current) {
        current = { category: at('category') || null, name: name.slice(0, PASTE_MAX_NAME), description: null, price: null, serves: null, sizes: [], groups: [] };
        byName.set(key, current);
        items.push(current);
      }
    }
    if (!current && (group || choice)) {
      // Options with no item in front of them still get listed, under no item.
      current = { category: null, name: '', description: null, price: null, serves: null, sizes: [], groups: [] };
      items.push(current);
    }
    if (!current) continue;

    if (group || choice) {
      const gName = group || 'Options';
      let g = current.groups.find((x) => x.name.toLowerCase() === gName.toLowerCase());
      if (!g) { g = { name: gName, required: false, min: null, max: null, choices: [] }; current.groups.push(g); }
      if (choice && !g.choices.some((c) => c.name.toLowerCase() === choice.toLowerCase())) {
        g.choices.push({ name: choice.slice(0, PASTE_MAX_NAME), price: p ? p.price : null });
      }
      continue;
    }
    if (size) {
      if (!current.sizes.some((s) => s.name.toLowerCase() === size.toLowerCase())) {
        current.sizes.push({ name: size.slice(0, PASTE_MAX_NAME), price: p ? p.price : null, serves: serves || null });
      }
    } else if (p && current.price == null) {
      current.price = p.price;
      if (serves) current.serves = serves;
    }
  }
  if (!head) warnings.push('We could not find a column called Item or Name in that table.');
  return { format: 'table', items: items.filter((it) => it.name || it.groups.length), warnings };
}

// ----------------------------------------------------------------------------
// Free text: the ezCater menu page, selected and copied
// ----------------------------------------------------------------------------

function parseText(rawLines) {
  // Meaningful lines only, remembering which followed a blank line: a heading
  // on a copied page usually does.
  const lines = [];
  let blank = true;
  for (const raw of rawLines) {
    const t = clean(raw);
    if (!t) { blank = true; continue; }
    lines.push({ text: t, blankBefore: blank });
    blank = false;
  }

  const items = [];
  let category = null;
  let item = null;
  let group = null;
  let lastSize = null;
  let lastChoice = null;
  let lastWasItemName = false;

  const kind = (t) => {
    if (isJunk(t)) return 'junk';
    const p = takePrice(t);
    if (p && !p.rest) return p.plus ? 'plusPrice' : 'price';
    const sv = takeServes(t);
    if (sv && !sv.rest && !p) return 'serves';
    return 'text';
  };

  /** Does an item start at line i? A price (or a priced size) must follow soon. */
  const itemStartsAt = (i) => {
    const here = lines[i];
    if (!here) return false;
    const p0 = takePrice(here.text);
    if (p0 && !p0.plus && p0.rest) return true;
    // A sentence about food is a description, never the start of an item.
    if (!p0 && isDescription(here.text)) return false;
    for (let j = i + 1, seen = 0; j < lines.length && seen < 4; j++) {
      const t = lines[j].text;
      const k = kind(t);
      if (k === 'junk' || k === 'serves') continue;
      seen++;
      if (k === 'price') return true;
      if (k === 'plusPrice') return false;
      const p = takePrice(t);
      if (p && !p.plus && p.rest && isSizeLike(takeServes(p.rest) ? takeServes(p.rest).rest || p.rest : p.rest)) return true;
      if (p) return false;
      if (isSizeLike(t) && j + 1 < lines.length && kind(lines[j + 1].text) === 'price') return true;
      if (isDescription(t)) continue;
      // A short line straight under the name, with no blank line between, and
      // a price after it: "Brownie Bites / Fudgy and rich / $18.00". A heading
      // is normally set apart by a blank line, so one is not read this way.
      if (seen === 1 && !lines[j].blankBefore && !isSizeLike(t)
        && j + 1 < lines.length && kind(lines[j + 1].text) === 'price') return true;
      return false;
    }
    return false;
  };

  const newItem = (name, price) => {
    const sv = takeServes(name);
    const nm = trimSeps(sv && sv.rest ? sv.rest : name).slice(0, PASTE_MAX_NAME);
    item = { category, name: nm, description: null, price: price == null ? null : price, serves: sv ? sv.serves : null, sizes: [], groups: [] };
    items.push(item);
    group = null; lastSize = null; lastChoice = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const { text: t, blankBefore } = lines[i];
    const k = kind(t);
    if (k === 'junk') continue;

    if (k === 'serves') {
      const sv = takeServes(t);
      if (lastSize && !lastSize.serves) lastSize.serves = sv.serves;
      else if (item && !item.serves) item.serves = sv.serves;
      continue;
    }
    if (k === 'price' || k === 'plusPrice') {
      const p = takePrice(t);
      if (k === 'plusPrice' && lastChoice && lastChoice.price == null) lastChoice.price = p.price;
      else if (lastSize && lastSize.price == null) lastSize.price = p.price;
      else if (item && item.price == null && !item.sizes.length) item.price = p.price;
      lastWasItemName = false;
      continue;
    }

    // A named text line from here on.
    if (isGroupHeading(t) && item && !takePrice(t)) {
      const r = groupRules(t);
      const name = groupName(t);
      if (name) {
        group = { name: name.slice(0, PASTE_MAX_NAME), required: r.required, min: r.min, max: r.max, choices: [] };
        item.groups.push(group);
        lastChoice = null; lastSize = null;
      }
      lastWasItemName = false;
      continue;
    }

    const p = takePrice(t);

    if (group) {
      const marked = CHOICE_MARK.test(t);
      const plus = p && p.plus;
      const startsItem = !marked && !plus && itemStartsAt(i);
      const nextStartsItem = !marked && !plus && !p && itemStartsAt(i + 1) && !isSizeLike(lines[i + 1] ? lines[i + 1].text : '');
      const heading = nextStartsItem && (blankBefore || isAllCaps(t));
      if (!startsItem && !heading) {
        const body = clean((p ? p.rest : t).replace(CHOICE_MARK, ''));
        if (body && !isDescription(body)) {
          lastChoice = { name: body.slice(0, PASTE_MAX_NAME), price: p ? p.price : null };
          if (!group.choices.some((c) => c.name.toLowerCase() === lastChoice.name.toLowerCase())) group.choices.push(lastChoice);
        }
        continue;
      }
      group = null;
      lastChoice = null;
      if (heading) { category = t.slice(0, PASTE_MAX_NAME); item = null; lastWasItemName = false; continue; }
    }

    // A size of the current item: "Half Tray (Serves 10) $65.00", or "Half
    // Tray" with its price on the next line. Only when the item has no price of
    // its own yet or already has sizes, so the next priced item on the page is
    // never swallowed as a size.
    if (item && (item.price == null || item.sizes.length)) {
      const body = p ? p.rest : t;
      const sv = takeServes(body);
      const sizeName = trimSeps(sv && sv.rest ? sv.rest : (sv ? '' : body));
      const nextIsPrice = !p && lines[i + 1] && kind(lines[i + 1].text) === 'price';
      if (sizeName && isSizeLike(sizeName) && (p || nextIsPrice || sv)) {
        lastSize = { name: sizeName.slice(0, PASTE_MAX_NAME), price: p && !p.plus ? p.price : null, serves: sv ? sv.serves : null };
        if (!item.sizes.some((s) => s.name.toLowerCase() === lastSize.name.toLowerCase())) item.sizes.push(lastSize);
        lastWasItemName = false;
        continue;
      }
    }

    if (p && !p.plus && p.rest && !isDescription(p.rest)) {
      newItem(p.rest, p.price);
      lastWasItemName = false;
      continue;
    }

    if (itemStartsAt(i)) {
      // "Caesar Salad" then "Crisp romaine" then "$45": the second line is the
      // description of the first, not a new item.
      if (lastWasItemName && item && item.price == null && !item.sizes.length && !item.description) {
        item.description = t;
        lastWasItemName = false;
        continue;
      }
      newItem(t, null);
      lastWasItemName = true;
      continue;
    }

    if (isDescription(t)) {
      if (item && !item.description) item.description = t;
      lastWasItemName = false;
      continue;
    }

    // Anything else short and unpriced is a heading.
    category = t.slice(0, PASTE_MAX_NAME);
    item = null;
    group = null;
    lastSize = null;
    lastChoice = null;
    lastWasItemName = false;
  }

  return { format: 'text', items: items.filter((it) => it.name), warnings: [] };
}

// ----------------------------------------------------------------------------
// parseEzcaterMenu
// ----------------------------------------------------------------------------

/**
 * Pasted text (or the text of a CSV file) into
 *   { format, items: [{ category, name, description, price, serves,
 *                       sizes: [{ name, price, serves }],
 *                       groups: [{ name, required, min, max,
 *                                  choices: [{ name, price }] }] }],
 *     warnings }
 *
 * Best effort by design. Nothing here is saved until a person has looked at
 * what it understood, and a name read wrongly costs one row on the matching
 * list, never an order.
 */
export function parseEzcaterMenu(input) {
  let text = String(input == null ? '' : input);
  const warnings = [];
  if (text.length > PASTE_MAX_CHARS) {
    text = text.slice(0, PASTE_MAX_CHARS);
    warnings.push('That was very long, so only the first part was read.');
  }
  // A byte order mark from a spreadsheet export, and Windows line ends.
  text = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const firstLines = lines.filter((l) => clean(l)).slice(0, 5);

  let parsed = null;
  for (const delim of ['\t', ',', ';']) {
    const hit = firstLines.find((l) => l.indexOf(delim) !== -1 && readHeader(splitRow(l, delim)));
    if (hit) { parsed = parseTable(lines, delim); break; }
  }
  if (!parsed) {
    // Cells copied without a header: tabs become spaces and the text rules read
    // "Caesar Salad<TAB>45.00" as an item with its price.
    parsed = parseText(lines.map((l) => l.replace(/\t+/g, '  ')));
  }
  return { ...parsed, warnings: warnings.concat(parsed.warnings) };
}

/** Totals for the "we found" line. */
export function parsedCounts(parsed) {
  const items = (parsed && Array.isArray(parsed.items) ? parsed.items : []).filter((it) => it.name);
  let sizes = 0;
  let options = 0;
  for (const it of items) {
    sizes += it.sizes.length;
    for (const g of it.groups) options += g.choices.length;
  }
  return { items: items.length, sizes, options };
}

// ----------------------------------------------------------------------------
// Entries: one per name ezCater would send
// ----------------------------------------------------------------------------

/**
 * The names an order could carry, deduped by the key the webhook would file
 * them under:
 *   kind 'item'    one per size (ezLineName(item, size)), or the item itself
 *   kind 'option'  one per choice, with its group
 *
 * ezLineName is the SAME function the webhook uses on a real order line, so a
 * pasted "Caesar Salad" size "Half Tray" and an order for it are one row.
 */
export function pasteEntries(parsed) {
  const out = [];
  const seen = new Set();
  const add = (entry) => {
    const line = entry.kind === 'option' ? { name: entry.ez_name, groupLabel: entry.ez_group || '' } : { name: entry.ez_name };
    const key = buildLinkKey(line, entry.kind);
    if (!key) return;
    const k = entry.kind + ':' + key;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ ...entry, ez_key: key });
  };
  for (const it of (parsed && Array.isArray(parsed.items) ? parsed.items : [])) {
    if (it.name) {
      if (it.sizes.length) {
        for (const s of it.sizes) add({ kind: 'item', ez_name: ezLineName(it.name, s.name), ez_group: null, price: s.price });
      } else {
        add({ kind: 'item', ez_name: clean(it.name), ez_group: null, price: it.price });
      }
    }
    for (const g of it.groups) {
      for (const c of g.choices) add({ kind: 'option', ez_name: clean(c.name), ez_group: clean(g.name) || null, price: c.price });
    }
  }
  return out.slice(0, PASTE_MAX_ENTRIES);
}

/** The body ezcater-connect items_paste takes: names only, the server re-keys. */
export function pasteBody(entries) {
  return {
    entries: (Array.isArray(entries) ? entries : []).slice(0, PASTE_MAX_ENTRIES).map((e) => ({
      kind: e.kind === 'option' ? 'option' : 'item',
      ez_name: String(e.ez_name || '').slice(0, 200),
      ez_group: e.kind === 'option' && e.ez_group ? String(e.ez_group).slice(0, 200) : null,
    })),
  };
}

// ----------------------------------------------------------------------------
// The preview: what would match, before anything is saved
// ----------------------------------------------------------------------------

/**
 * Run the shared rules over every pasted name, with the screen's own menu, and
 * say what would happen. The edge function runs the same rules again on save
 * against the menu it reads itself, so this is a preview and never the record.
 *
 * status per row:
 *   matched  a saved match, or one exact name of ours (no size clash)
 *   decide   close names, or more than one exact name: a person picks
 *   none     nothing on our menu looks like it
 *   ignored  already marked "Not on our menu"
 * already is true when the name is on the list now; pasting it again adds
 * nothing and changes no decision.
 */
export function previewPaste(entries, ourItems, ourGroups, existingRows) {
  const existing = Array.isArray(existingRows) ? existingRows : [];
  const idx = indexLinks(existing.map((r) => ({
    kind: r.kind, ez_key: r.ezKey || r.ez_key, menu_item_id: r.menuItemId || r.menu_item_id,
    option_id: r.optionId || r.option_id, source: r.source,
  })));
  const stateByKey = new Map();
  for (const r of existing) {
    const key = r.ezKey || r.ez_key;
    if (key) stateByKey.set((r.kind === 'option' ? 'option' : 'item') + ':' + key, r.state || null);
  }
  const itemName = new Map();
  for (const it of Array.isArray(ourItems) ? ourItems : []) if (it && it.id != null) itemName.set(String(it.id), displayNameOf(it));
  const optName = new Map();
  for (const g of Array.isArray(ourGroups) ? ourGroups : []) {
    for (const o of (g && Array.isArray(g.options) ? g.options : [])) {
      if (o && o.id != null) optName.set(String(o.id), displayNameOf(o) + (g.name ? ' (' + g.name + ')' : ''));
    }
  }

  const rows = [];
  const counts = { total: 0, matched: 0, decide: 0, none: 0, ignored: 0, already: 0, fresh: 0 };
  for (const e of Array.isArray(entries) ? entries : []) {
    const kind = e.kind === 'option' ? 'option' : 'item';
    const line = kind === 'option' ? { name: e.ez_name, groupLabel: e.ez_group || '' } : { name: e.ez_name };
    const hit = findLink(idx, line, kind);
    const already = !!hit;
    const state = hit ? stateByKey.get(kind + ':' + hit.key) : null;

    let status;
    let target = null;
    if (state === 'ignored') status = 'ignored';
    else if (state === 'matched') {
      status = 'matched';
      target = hit.link.optionId ? optName.get(String(hit.link.optionId)) : itemName.get(String(hit.link.menuItemId || ''));
    } else {
      const d = autoLinkDecision(line, kind === 'option' ? ourGroups : ourItems, [], { kind });
      if (d.action === 'linked') {
        status = 'matched';
        target = d.optionId ? optName.get(String(d.optionId)) : itemName.get(String(d.itemId || ''));
      } else status = d.action === 'suggest' ? 'decide' : 'none';
    }

    counts.total++;
    counts[status]++;
    if (already) counts.already++; else counts.fresh++;
    rows.push({ kind, ezName: e.ez_name, ezGroup: e.ez_group || null, ezKey: e.ez_key || buildLinkKey(line, kind), status, already, target: target || null });
  }
  return { rows, counts };
}

/** The plain line under the preview. */
export function previewLine(counts) {
  const c = counts || {};
  if (!c.total) return 'We could not find any items in that. Try selecting the whole menu page and copying again.';
  const parts = [
    c.matched + ' matched',
    c.decide + ' need a decision',
    c.none + ' not on our menu',
  ];
  if (c.ignored) parts.push(c.ignored + ' you said are not on our menu');
  const tail = c.already ? ' ' + c.already + ' of them are already on your list.' : '';
  return parts.join(', ') + '.' + tail;
}
