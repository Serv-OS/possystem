// supabase/functions/_shared/ezcaterMatch.ts
//
// MIRROR OF src/lib/ezcaterMatch.js. Same rules, same numbers, same words.
//
// The edge function cannot import out of src/: it is deployed on its own, and
// sometimes by pasting the files under supabase/functions into the Supabase
// dashboard editor, so a relative import climbing out of this folder would not
// survive. So the rules live twice, and src/lib/ezcaterMatchParity.test.js runs
// one shared case table through BOTH files and compares every output, plus the
// rule tables field by field. Change one file, change the other, same commit.
//
// PURE. No imports, no supabase client, no fetch, no Deno globals, no clock.
//
// ============================================================================
//  WHY THIS EXISTS. READ BEFORE CHANGING THE KEY.
// ============================================================================
//
// We have the ezCater Orders API but NOT the Menus API. The venue builds its
// ezCater menu by hand in the Partner Portal, so an order line usually carries
// posItemId = null. itemId is what KDS routing, 86, stock depletion and product
// reporting key on, so an unmatched line is a plain text ticket: no station, no
// stock, no product mix.
//
// What ezCater sends on a line, and how much of it we can trust as a key:
//
//   posItemId          STABLE, because it is OUR id as ezCater holds it. It
//                      carries whatever was put on their side against that
//                      product: our menu item id, or our own short ITEM CODE
//                      (menu_items.item_code, FLATWHITE, CAESARSAL). Either
//                      already names our item, so it needs no link row at all,
//                      and a code is the one a person could enter by hand.
//                      HOW IT GETS THERE IS NOT SETTLED. The only documented
//                      writer is the Menus API menuCreate, which we do not have
//                      permission for; whether a venue can type one into the
//                      Partner Portal is documented nowhere and only ezCater
//                      can answer. On a Partner Portal menu it is null today,
//                      so nothing here may require it.
//   uuid               the ORDER LINE, not the product. Different per order.
//                      Never a match key.
//   menuItemSizeId     ezCater's own menu side id. Every doc placeholder for it
//                      is prefixed "ezcater-menu-version-...", and a menu
//                      publish returns a new menuUuid, so it looks scoped to a
//                      menu VERSION. ezCater never promises it survives a
//                      republish. Keying on it would silently drop every link
//                      the day the venue edits their ezCater menu.
//   name               free text the venue typed. Stable until they retype it.
//
// So the key is the NORMALISED NAME. It is the only thing on an ezCater line
// that survives a menu republish. The cost is honest and visible: rename the
// item on ezCater and the link needs making again, which is why ez_name is
// stored verbatim next to it and the screen can show what was seen.
//
// THE KEY KEEPS THE SIZE WORD. "Half Tray" and "Full Tray" are two rows, two
// matches and two products, because they are two products to a kitchen. Only
// the container word ("tray", "pan", "size") is dropped from a key. The SCORER
// still ignores the size, so both still find our one "Caesar Salad" to suggest.
// normaliseKeyName is the key form, normaliseItemName is the comparing form.
// ============================================================================

export type MatchKind = 'item' | 'option';

export interface Suggestion {
  itemId: string;
  name: string;
  score: number;
  why: string;
}

export interface OptionSuggestion {
  optionId: string;
  groupId: string;
  name: string;
  groupLabel: string;
  itemId: string | null;
  score: number;
  why: string;
}

export interface LinkDecision {
  action: 'linked' | 'suggest' | 'none';
  itemId?: string | null;
  optionId?: string | null;
  groupId?: string | null;
  reason: string;
  source?: string;
  stale?: boolean;
}

export interface LineMatch {
  matched: boolean;
  source: string | null;
}

// ----------------------------------------------------------------------------
// Rule tables. Frozen so a caller cannot quietly change the rules at runtime.
// ----------------------------------------------------------------------------

/**
 * Size words, mapped to a canonical size. Used two ways: dropped when they
 * trail a name, and compared as a size signal when they appear anywhere.
 */
export const SIZE_WORDS: Record<string, string> = Object.freeze({
  small: 'small', sm: 'small',
  medium: 'medium', med: 'medium', md: 'medium',
  large: 'large', lg: 'large', lge: 'large',
  xl: 'xlarge', xlarge: 'xlarge',
  half: 'half', full: 'full',
  mini: 'mini', jumbo: 'jumbo',
  regular: 'regular', reg: 'regular',
});

/**
 * Catering container words. Not a size, but pure noise on the end of a name.
 * "Caesar Salad Half Pan" and "Caesar Salad" are the same product to a kitchen.
 */
export const CONTAINER_WORDS: string[] = Object.freeze(['tray', 'pan', 'size']) as string[];

/** Every word that is dropped when it trails a name. */
export const TRAILING_DROP: string[] = Object.freeze(
  Object.keys(SIZE_WORDS).concat(CONTAINER_WORDS).sort(),
) as string[];

/** Scoring weights. One place, so both mirrors can be compared field by field. */
export const WEIGHTS = Object.freeze({
  exact: 1,
  containBase: 0.75,
  containRange: 0.15,
  tokenWeight: 0.7,
  sizeBonus: 0.05,
  sizePenalty: 0.1,
  priceBonus: 0.05,
  groupSameBonus: 0.05,
  groupCloseBonus: 0.02,
  groupWrongFactor: 0.8,
  nonExactCap: 0.98,
});

/** Below this a suggestion is noise, so it is not offered at all. */
export const DEFAULT_MIN_SCORE = 0.35;

/** How many suggestions a picker gets by default. */
export const DEFAULT_LIMIT = 5;

// ----------------------------------------------------------------------------
// normaliseItemName
// ----------------------------------------------------------------------------

// Run AFTER punctuation has become spaces, so "serves 10-12" is already
// "serves 10 12" by the time these see it. That is why no pattern here looks
// for a hyphen.
const NOISE_PATTERNS: RegExp[] = [
  // "per person", "per head", "per guest", "per pax"
  /\bper\s+(person|people|head|heads|guest|guests|pax)\b/g,
  // "serves 10", "serves 10 12", "serves 10 to 12", "feeds 8 people"
  /\b(serves|serving|feeds)\s+\d+(\s+(to\s+)?\d+)?(\s+(people|persons?|guests?|pax))?\b/g,
  // "10 person", "12 people", "20 guests"
  /\b\d+\s*(person|people|guest|guests|pax)\b/g,
];

function stripBrackets(s: string): string {
  let out = s;
  // Three passes handles simple nesting and stays deterministic.
  for (let i = 0; i < 3; i++) {
    const next = out
      .replace(/\([^()]*\)/g, ' ')
      .replace(/\[[^[\]]*\]/g, ' ')
      .replace(/\{[^{}]*\}/g, ' ');
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Tokens of a name BEFORE trailing size words are dropped. Internal, because
 * the size signal needs to see the words that normaliseItemName removes.
 */
function rawTokens(value: unknown): string[] {
  let s = String(value == null ? '' : value).toLowerCase();
  // Accents off, so "Crème" and "Creme" are one product.
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/&/g, ' and ');
  s = stripBrackets(s);
  // Apostrophes vanish rather than splitting a word: "chef's" keeps as "chefs".
  s = s.replace(/['‘’ʼ`]/g, '');
  // Everything else that is not a letter or a digit becomes a gap.
  s = s.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  for (const re of NOISE_PATTERNS) s = s.replace(re, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s ? s.split(' ') : [];
}

/**
 * Drop the trailing words in `drop`, never emptying the name. A name that is
 * nothing but dropped words keeps its first word, because on a modifier option
 * that single word IS the product.
 */
function dropTrailing(tokens: string[], drop: string[]): string {
  let end = tokens.length;
  while (end > 1 && drop.indexOf(tokens[end - 1]) !== -1) end--;
  return tokens.slice(0, end).join(' ');
}

/**
 * The COMPARING form of a name: lower case, no punctuation, no bracketed
 * suffix, no catering noise, no trailing size or container word.
 *
 * This is what the scorer works in, so "Caesar Salad Half Tray" and "Caesar
 * Salad" still recognise each other as the same product.
 */
export function normaliseItemName(value: unknown): string {
  return dropTrailing(rawTokens(value), TRAILING_DROP);
}

/**
 * The KEY form of a name. Same as normaliseItemName EXCEPT that the size word
 * stays: only the container word ("tray", "pan", "size") is dropped.
 *
 * WHY THE KEY KEEPS THE SIZE AND THE SCORER DOES NOT.
 * A venue sells "Caesar Salad Half Tray" and "Caesar Salad Full Tray" on
 * ezCater. Both are the same dish to a scorer, so both should still find our
 * "Caesar Salad" when we look for something to suggest. But they are TWO
 * products to a kitchen, with different stock and different money, so they must
 * be two link ROWS: one manual match must never route both, and the Back Office
 * screen has to be able to show them apart.
 */
export function normaliseKeyName(value: unknown): string {
  return dropTrailing(rawTokens(value), CONTAINER_WORDS);
}

/** Distinct words of a normalised name, in first seen order. */
export function nameTokens(value: unknown): string[] {
  const seen: string[] = [];
  for (const t of normaliseItemName(value).split(' ')) {
    if (t && seen.indexOf(t) === -1) seen.push(t);
  }
  return seen;
}

/**
 * The size a name carries, canonical, or null. The LAST size word wins, because
 * catering names put the size at the end far more often than at the front.
 */
export function sizeWordOf(value: unknown): string | null {
  const tokens = rawTokens(value);
  let found: string | null = null;
  for (const t of tokens) {
    if (Object.prototype.hasOwnProperty.call(SIZE_WORDS, t)) found = SIZE_WORDS[t];
  }
  return found;
}

/**
 * Size names that say nothing about the product, so they never join a name.
 * ezCater allows an item with one size to leave the size blank or give it a
 * placeholder, and "Chocolate Cake, 1" must still be our "Chocolate Cake".
 * Compared in key form (normaliseKeyName).
 */
export const GENERIC_SIZE_NAMES: string[] = Object.freeze([
  '1', 'one', 'each', 'ea', 'item', 'default', 'standard', 'single', 'one size', 'n a', 'na', 'none',
]) as string[];

/**
 * The name one ezCater SELLABLE THING is known by: the item name, plus the size
 * the customer picked when that size says something.
 *
 * WHY. An ezCater order line carries the item name ("Caesar Salad") and the size
 * separately (menuItemSizeName, "Half Tray"). Keyed on the name alone, a Half
 * Tray and a Full Tray were ONE link row, so one match routed both and took the
 * same stock for both. Joined here, they are two rows, which is what the key
 * rule (normaliseKeyName keeps the size word) always intended.
 *
 * The SAME function builds the name for a line on a real order (ingest) and for
 * a size on a menu pasted into Back Office, so a pasted row and a later order
 * land on the same key and never make two rows.
 *
 * The size is left off when it is blank, a placeholder (GENERIC_SIZE_NAMES),
 * nothing but catering noise ("Serves 10", which the key would strip anyway),
 * or already inside the name.
 *
 * Rows saved before this kept only the name. For a size made of size words
 * ("Half Tray", "Large") the older key is exactly legacyLinkKey of the joined
 * name, so every earlier match is still found.
 */
export function ezLineName(name: unknown, sizeName?: unknown): string {
  const n = String(name == null ? '' : name).replace(/\s+/g, ' ').trim();
  const s = String(sizeName == null ? '' : sizeName).replace(/\s+/g, ' ').trim();
  if (!s || !n) return n;
  const sk = normaliseKeyName(s);
  if (!sk || GENERIC_SIZE_NAMES.indexOf(sk) !== -1) return n;
  const nk = normaliseKeyName(n);
  if ((' ' + nk + ' ').indexOf(' ' + sk + ' ') !== -1) return n;
  return n + ', ' + s;
}

/**
 * The name one of OUR sizes is matched by. On our menu a size is its own
 * menu_items row under the product (parent_id), usually called just "Large" or
 * "Half Tray". Matched as "Large" it would find every large thing ezCater sells
 * and none of them rightly, so it is matched as "Caesar Salad, Half Tray": the
 * same shape ezLineName gives their side.
 *
 * A size already named in full ("Caesar Salad Large") is left as it is.
 */
export function ourSizeName(parentName: unknown, sizeName: unknown): string {
  const p = String(parentName == null ? '' : parentName).replace(/\s+/g, ' ').trim();
  const s = String(sizeName == null ? '' : sizeName).replace(/\s+/g, ' ').trim();
  if (!p) return s;
  if (!s) return p;
  const pk = normaliseKeyName(p);
  const sk = normaliseKeyName(s);
  if (pk && (' ' + sk + ' ').indexOf(' ' + pk + ' ') !== -1) return s;
  return ezLineName(p, s);
}

// ----------------------------------------------------------------------------
// scoreMatch
// ----------------------------------------------------------------------------

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The names one of our items can legitimately be known by, best first. */
function ourNames(item: any): string[] {
  if (typeof item === 'string') return item ? [item] : [];
  const out: string[] = [];
  for (const key of ['name', 'menuName', 'label']) {
    const v = item && item[key];
    if (typeof v === 'string' && v.trim() && out.indexOf(v) === -1) out.push(v);
  }
  return out;
}

/** The display name we put in front of the operator. */
export function displayNameOf(item: any): string {
  const names = ourNames(item);
  return names.length ? names[0] : '';
}

/** Their side, tolerating a bare string or a mapped order line. */
function theirParts(theirLine: any): { name: string; price: number | null; group: string } {
  if (typeof theirLine === 'string') return { name: theirLine, price: null, group: '' };
  const l = theirLine || {};
  const bare = l.name != null ? l.name : (l.label != null ? l.label : '');
  // A line from a real order carries its size apart from its name. See ezLineName.
  const name = l.sizeName != null && l.sizeName !== '' ? ezLineName(bare, l.sizeName) : bare;
  const group = l.groupLabel != null ? l.groupLabel
    : (l.customizationTypeName != null ? l.customizationTypeName : '');
  return { name: String(name || ''), price: numOrNull(l.price), group: String(group || '') };
}

const samePrice = (a: number | null, b: number | null): boolean =>
  a !== null && b !== null && Math.abs(a - b) < 0.005;

/** Name only, one candidate name against one of ours. Returns the raw parts. */
function nameScore(theirName: unknown, ourName: unknown): { base: number; why: string; exact?: boolean } {
  const a = normaliseItemName(theirName);
  const b = normaliseItemName(ourName);
  if (!a || !b) return { base: 0, why: 'no words match' };
  if (a === b) return { base: WEIGHTS.exact, why: 'same name', exact: true };

  const aT = nameTokens(theirName);
  const bT = nameTokens(ourName);

  // Whole word containment, so "ham" never matches inside "hamburger".
  const padA = ' ' + a + ' ';
  const padB = ' ' + b + ' ';
  if (padA.indexOf(padB) !== -1 || padB.indexOf(padA) !== -1) {
    const short = Math.min(aT.length, bT.length);
    const long = Math.max(aT.length, bT.length);
    const ratio = long ? short / long : 0;
    const base = WEIGHTS.containBase + WEIGHTS.containRange * ratio;
    const why = padA.indexOf(padB) !== -1 ? 'our name is in theirs' : 'their name is in ours';
    return { base, why };
  }

  let shared = 0;
  for (const t of aT) if (bT.indexOf(t) !== -1) shared++;
  if (!shared) return { base: 0, why: 'no words match' };
  const dice = (2 * shared) / (aT.length + bT.length);
  return { base: WEIGHTS.tokenWeight * dice, why: shared + ' of ' + aT.length + ' words match' };
}

/**
 * How well one ezCater line matches one of our menu items.
 *
 * theirName is a name, or the whole mapped line when the price should count.
 * ourItem is one of our menu items ({ id, name, menuName, price }).
 *
 * Returns { score, why }. why is short plain words for an operator screen.
 * Never random: the same two arguments always give the same number.
 *
 * PRICE IS A BONUS, NEVER A PENALTY. ezCater gives a line total that already
 * includes its paid modifiers and no unit price at all, so our per unit figure
 * is only right when the line had no paid options. A price that agrees is worth
 * something; a price that disagrees proves nothing.
 */
export function scoreMatch(theirName: any, ourItem: any): { score: number; why: string } {
  const their = theirParts(theirName);
  const candidates = ourNames(ourItem);
  if (!candidates.length || !their.name) return { score: 0, why: 'no words match' };

  let best: { base: number; why: string; exact?: boolean } | null = null;
  for (const cand of candidates) {
    const r = nameScore(their.name, cand);
    if (!best || r.base > best.base) best = r;
  }

  const parts = [best!.why];
  let score = best!.base;

  if (score > 0) {
    const theirSize = sizeWordOf(their.name);
    let ourSize: string | null = null;
    for (const cand of candidates) {
      const s = sizeWordOf(cand);
      if (s) { ourSize = s; break; }
    }
    if (theirSize && ourSize) {
      if (theirSize === ourSize) { score += WEIGHTS.sizeBonus; parts.push('same size'); }
      else { score -= WEIGHTS.sizePenalty; parts.push('different size'); }
    }

    const ourPrice = typeof ourItem === 'string' ? null
      : numOrNull(ourItem && (ourItem.price !== undefined ? ourItem.price : ourItem.unitPrice));
    if (samePrice(their.price, ourPrice)) { score += WEIGHTS.priceBonus; parts.push('same price'); }
  }

  if (score < 0) score = 0;
  const cap = best!.exact ? WEIGHTS.exact : WEIGHTS.nonExactCap;
  if (score > cap) score = cap;
  return { score: round3(score), why: parts.join(', ') };
}

// ----------------------------------------------------------------------------
// suggestMatches
// ----------------------------------------------------------------------------

/** Stable order: best score first, then name, then id. Never the input order. */
function bySuggestion(a: any, b: any): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a._key !== b._key) return a._key < b._key ? -1 : 1;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.itemId < b.itemId ? -1 : (a.itemId > b.itemId ? 1 : 0);
}

/**
 * The ranked shortlist an operator picks from. Never longer than limit, never
 * below minScore, and the same list every time for the same input.
 */
export function suggestMatches(
  theirLine: any,
  ourItems: any[],
  opts?: { limit?: number; minScore?: number },
): Suggestion[] {
  const o = opts || {};
  const limit = Number.isFinite(o.limit as number) ? Math.max(0, Math.floor(o.limit as number)) : DEFAULT_LIMIT;
  const minScore = Number.isFinite(o.minScore as number) ? (o.minScore as number) : DEFAULT_MIN_SCORE;
  const list = Array.isArray(ourItems) ? ourItems : [];

  const best = new Map<string, any>();
  for (const item of list) {
    const id = item && item.id != null ? String(item.id) : '';
    if (!id) continue;
    const r = scoreMatch(theirLine, item);
    if (r.score < minScore || r.score <= 0) continue;
    const name = displayNameOf(item);
    const row = { itemId: id, name, score: r.score, why: r.why, _key: normaliseItemName(name) };
    const prev = best.get(id);
    if (!prev || row.score > prev.score) best.set(id, row);
  }

  const out = Array.from(best.values()).sort(bySuggestion).slice(0, limit);
  return out.map((r) => ({ itemId: r.itemId, name: r.name, score: r.score, why: r.why }));
}

// ----------------------------------------------------------------------------
// Link keys and the link index
// ----------------------------------------------------------------------------

/**
 * The key a link row is stored under: the key form of the name (the size word
 * kept, see normaliseKeyName), and for an option the key form of the group name
 * in front of it so "Large" under Size and "Large" under Drink are two
 * different things.
 *
 * Returns '' when there is no usable name. A caller must never write a link
 * with an empty key.
 */
export function buildLinkKey(line: any, kind?: MatchKind): string {
  const k = kind || (line && line.kind) || 'item';
  const their = theirParts(line);
  const name = normaliseKeyName(their.name);
  if (k === 'option') {
    const group = normaliseKeyName(their.group);
    return name ? group + '|' + name : '';
  }
  return name;
}

/**
 * The key this name WOULD have had under the older rule, which dropped the size
 * word as well. Rows saved before the size was kept are stored under this, so
 * every lookup falls back to it and a venue's earlier matching work keeps
 * routing. Nothing NEW is ever written under it.
 */
export function legacyLinkKey(line: any, kind?: MatchKind): string {
  const k = kind || (line && line.kind) || 'item';
  const their = theirParts(line);
  const name = normaliseItemName(their.name);
  if (k === 'option') {
    const group = normaliseItemName(their.group);
    return name ? group + '|' + name : '';
  }
  return name;
}

/** Every key a saved row for this line could be under, today's first. */
export function linkKeyCandidates(line: any, kind?: MatchKind): string[] {
  const k = kind || (line && line.kind) || 'item';
  const out: string[] = [];
  const now = buildLinkKey(line, k);
  if (now) out.push(now);
  const old = legacyLinkKey(line, k);
  if (old && old !== now) out.push(old);
  return out;
}

/**
 * The saved row for one line, today's key first and the older key second.
 * Returns { key, link } so a caller can bump the row UNDER THE KEY IT IS
 * ACTUALLY STORED WITH, or null when there is none.
 */
export function findLink(idx: any, line: any, kind?: MatchKind): { key: string; link: any } | null {
  if (!idx || typeof idx.get !== 'function') return null;
  const k = kind || (line && line.kind) || 'item';
  for (const key of linkKeyCandidates(line, k)) {
    const link = idx.get(k + ':' + key);
    if (link) return { key, link };
  }
  return null;
}

const pick = (row: any, snake: string, camel: string): any => {
  if (!row) return null;
  const a = row[snake];
  if (a !== undefined && a !== null && a !== '') return a;
  const b = row[camel];
  if (b !== undefined && b !== null && b !== '') return b;
  return null;
};

/**
 * Index link rows by 'kind:key'. Takes the rows straight off the table
 * (snake_case) or already camelCased, or a plain object keyed by ez_key.
 */
export function indexLinks(links: any): Map<string, any> {
  const idx = new Map<string, any>();
  if (!links) return idx;

  const add = (row: any, fallbackKey: string | null) => {
    if (!row) return;
    const kind = String(pick(row, 'kind', 'kind') || 'item');
    const key = String(pick(row, 'ez_key', 'ezKey') || fallbackKey || '');
    if (!key) return;
    idx.set(kind + ':' + key, {
      kind,
      ezKey: key,
      ezName: pick(row, 'ez_name', 'ezName'),
      ezGroup: pick(row, 'ez_group', 'ezGroup'),
      menuItemId: pick(row, 'menu_item_id', 'menuItemId'),
      optionId: pick(row, 'option_id', 'optionId'),
      source: String(pick(row, 'source', 'source') || 'manual'),
    });
  };

  if (Array.isArray(links)) {
    for (const row of links) add(row, null);
  } else if (links instanceof Map) {
    for (const [k, row] of links) add(row, k);
  } else if (typeof links === 'object') {
    for (const k of Object.keys(links)) add(links[k], k);
  }
  return idx;
}

// ----------------------------------------------------------------------------
// Item codes. Our own short id, come back to us on their line.
// ----------------------------------------------------------------------------

/**
 * The comparing form of an item code: trimmed and upper case, nothing else.
 *
 * Case and stray spaces are the only differences forgiven. Punctuation is NOT
 * stripped, because this runs against text a partner typed: dropping it could
 * make their "M-123" equal our "M123", and a wrong match here routes the wrong
 * food. src/lib/itemCode.js itemCodeKey is the same rule for the app side.
 */
export function itemCodeKey(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
}

/**
 * Our items indexed by their item code: Map('FLATWHITE' -> { itemId, code }).
 *
 * Takes our menu (itemCode or item_code on each row) or an index already built,
 * which is how the option arm gets one without holding the item list.
 *
 * A code that somehow names TWO of our items is dropped from the index
 * entirely. The database has a unique index that makes that impossible, so if
 * it ever happens something is wrong, and "certain" is exactly what such a code
 * is not: the line falls through to the ordinary rules and a person decides.
 */
export function indexItemCodes(ourItems: any): Map<string, { itemId: string; code: string }> {
  if (ourItems instanceof Map) return ourItems;
  const idx = new Map<string, { itemId: string; code: string }>();
  const clash: string[] = [];
  for (const it of Array.isArray(ourItems) ? ourItems : []) {
    if (!it) continue;
    const id = it.id != null ? String(it.id) : '';
    const raw = it.itemCode !== undefined && it.itemCode !== null ? it.itemCode : it.item_code;
    const key = itemCodeKey(raw);
    if (!id || !key) continue;
    const prev = idx.get(key);
    if (prev) {
      if (prev.itemId !== id) clash.push(key);
      continue;
    }
    idx.set(key, { itemId: id, code: key });
  }
  for (const k of clash) idx.delete(k);
  return idx;
}

/**
 * The item one of their ids names, when that id is one of our codes. Returns
 * { itemId, code } or null. An unknown code is simply null: it changes nothing
 * and the line goes on to the ordinary rules.
 */
export function findItemCodeMatch(codes: any, value: unknown): { itemId: string; code: string } | null {
  const key = itemCodeKey(value);
  if (!key) return null;
  const idx = codes instanceof Map ? codes : indexItemCodes(codes);
  const hit = idx.get(key);
  return hit ? { itemId: hit.itemId, code: hit.code } : null;
}

/** Their posItemId on a line or a customization, as a string, or ''. */
function theirPosId(line: any): string {
  if (!line || typeof line !== 'object') return '';
  return line.itemId != null ? String(line.itemId) : '';
}

// ----------------------------------------------------------------------------
// autoLinkDecision
// ----------------------------------------------------------------------------

/** Our items whose normalised name is exactly theirs. */
function exactNameMatches(theirName: unknown, ourItems: any[]): any[] {
  const target = normaliseItemName(theirName);
  if (!target) return [];
  const hits: any[] = [];
  const list = Array.isArray(ourItems) ? ourItems : [];
  for (const item of list) {
    const id = item && item.id != null ? String(item.id) : '';
    if (!id) continue;
    for (const cand of ourNames(item)) {
      if (normaliseItemName(cand) === target) { hits.push(item); break; }
    }
  }
  return hits;
}

const idsOf = (list: any[]): Set<string> => {
  const s = new Set<string>();
  for (const item of list || []) if (item && item.id != null) s.add(String(item.id));
  return s;
};

/**
 * True when BOTH sides name a size and the sizes are not the same.
 *
 * The names normalise equal (the scorer drops the size on purpose), so without
 * this their "Large" auto links to our "Small": one exact name, nothing else
 * exact, linked. The scorer already docks such a pair; an auto link must refuse
 * it outright and let a person pick, because the wrong size is the wrong food,
 * the wrong stock and the wrong money.
 *
 * One side with no size at all is NOT a clash: our plain "Caesar Salad" is the
 * right answer for their "Caesar Salad Large" when it is the only Caesar we
 * sell.
 */
function sizeClash(theirName: unknown, ourItem: any): boolean {
  const theirSize = sizeWordOf(theirName);
  if (!theirSize) return false;
  // The same candidate the scorer reads a size from: the first name of ours
  // that carries one.
  let ourSize: string | null = null;
  for (const cand of ourNames(ourItem)) {
    const s = sizeWordOf(cand);
    if (s) { ourSize = s; break; }
  }
  return !!ourSize && ourSize !== theirSize;
}

/**
 * What to do with one ezCater line, with no human in the loop.
 *
 *   linked   we are confident enough to fill itemId in ourselves
 *   suggest  a person picks from suggestMatches
 *   none     nothing close enough to offer
 *
 * The order is the whole point:
 *   0. their posItemId IS ONE OF OUR ITEM CODES. Certain, and it outranks
 *      everything below, including a saved link: a code only comes back because
 *      it was put on their side against that product, which is a more direct
 *      answer than a link guessed from a name months ago. An unknown code is
 *      not a refusal, it is simply not a match, and rule 1 carries on.
 *   1. an existing link wins. A person already decided, or we already decided
 *      and nobody corrected it.
 *   2. a posItemId that names a real item of ours wins next. That id is only
 *      ever there because somebody put it there, through menuCreate or by hand.
 *   3. ONE exact normalised name, and no other exact name, auto links.
 *   4. anything else only suggests.
 *
 * Two items that both match exactly is the case this rule exists for: a venue
 * with "Caesar Salad Small" and "Caesar Salad Large" normalises both to
 * "caesar salad", and guessing between them would send the wrong food to the
 * wrong station and deplete the wrong stock. So it never guesses.
 */
export function autoLinkDecision(
  theirLine: any,
  ourItems: any[],
  existingLinks: any,
  opts?: { kind?: MatchKind; minScore?: number; itemCodes?: any },
): LinkDecision {
  const o = opts || {};
  const kind = o.kind || 'item';
  const minScore = Number.isFinite(o.minScore as number) ? (o.minScore as number) : DEFAULT_MIN_SCORE;
  const list = Array.isArray(ourItems) ? ourItems : [];

  if (kind === 'option') {
    return autoLinkOption(theirLine, list, existingLinks, minScore, o.itemCodes);
  }

  const their = theirParts(theirLine);
  const known = idsOf(list);
  let stale = false;

  // 0. their posItemId is one of our item codes. Nothing outranks this.
  const coded = findItemCodeMatch(o.itemCodes !== undefined ? o.itemCodes : list, theirPosId(theirLine));
  if (coded) {
    return {
      action: 'linked',
      itemId: coded.itemId,
      reason: 'their menu has our item code',
      source: 'itemCode',
    };
  }

  // 1. an existing link. Today's key first, then the older size-dropping key,
  // so work saved before the key kept the size still routes.
  const hit = findLink(indexLinks(existingLinks), theirLine, 'item');
  const link = hit ? hit.link : null;
  if (link && link.menuItemId) {
    const id = String(link.menuItemId);
    // An empty menu means we cannot prove anything is gone, so trust the link.
    if (!known.size || known.has(id)) {
      return { action: 'linked', itemId: id, reason: 'already matched', source: link.source };
    }
    stale = true;
  }

  // 2. their menu carries our id
  const posItemId = theirLine && typeof theirLine === 'object' && theirLine.itemId != null
    ? String(theirLine.itemId) : '';
  if (posItemId && known.has(posItemId)) {
    const out: LinkDecision = {
      action: 'linked', itemId: posItemId, reason: 'their menu has our id', source: 'posItemId',
    };
    if (stale) out.stale = true;
    return out;
  }

  // 3. exactly one exact name, and no size clash with it
  const exact = exactNameMatches(their.name, list);
  if (exact.length === 1) {
    if (sizeClash(their.name, exact[0])) {
      const out: LinkDecision = { action: 'suggest', reason: 'different size, check it' };
      if (stale) out.stale = true;
      return out;
    }
    const out: LinkDecision = {
      action: 'linked', itemId: String(exact[0].id), reason: 'same name', source: 'auto',
    };
    if (stale) out.stale = true;
    return out;
  }
  if (exact.length > 1) {
    const out: LinkDecision = { action: 'suggest', reason: 'more than one item with that name' };
    if (stale) out.stale = true;
    return out;
  }

  // 4. close enough to show somebody
  const near = suggestMatches(theirLine, list, { limit: 1, minScore });
  const out: LinkDecision = near.length
    ? { action: 'suggest', reason: 'close names to check' }
    : { action: 'none', reason: stale ? 'the old match is gone' : 'no match' };
  if (stale) out.stale = true;
  return out;
}

// ----------------------------------------------------------------------------
// matchOptions
// ----------------------------------------------------------------------------

/**
 * Flatten our modifier groups into one option list, each option carrying the
 * group it came from. Options are matched inside the whole menu, not one group,
 * because ezCater's customizationTypeName is the venue's own typing and often
 * does not line up with our group names at all.
 */
function flattenOptions(ourGroups: any[]): any[] {
  const out: any[] = [];
  for (const g of Array.isArray(ourGroups) ? ourGroups : []) {
    if (!g) continue;
    const groupId = g.id != null ? String(g.id) : '';
    const groupLabel = displayNameOf(g);
    for (const opt of Array.isArray(g.options) ? g.options : []) {
      if (!opt) continue;
      const optionId = opt.id != null ? String(opt.id) : '';
      if (!optionId) continue;
      out.push({ optionId, groupId, groupLabel, option: opt });
    }
  }
  return out;
}

function byOptionSuggestion(a: any, b: any): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a._key !== b._key) return a._key < b._key ? -1 : 1;
  if (a.groupLabel !== b.groupLabel) return a.groupLabel < b.groupLabel ? -1 : 1;
  return a.optionId < b.optionId ? -1 : (a.optionId > b.optionId ? 1 : 0);
}

/**
 * The ranked shortlist for one ezCater customization against our modifier
 * options. Their customizationTypeName is scored against our group name and
 * their name against our option name.
 *
 * The group is a nudge, not a gate: the same option name in a clearly different
 * group is knocked down but never hidden, because a venue that types its own
 * group names has no reason to type ours.
 */
export function matchOptions(
  theirMod: any,
  ourGroups: any[],
  opts?: { limit?: number; minScore?: number },
): OptionSuggestion[] {
  const o = opts || {};
  const limit = Number.isFinite(o.limit as number) ? Math.max(0, Math.floor(o.limit as number)) : DEFAULT_LIMIT;
  const minScore = Number.isFinite(o.minScore as number) ? (o.minScore as number) : DEFAULT_MIN_SCORE;
  const their = theirParts(theirMod);
  if (!their.name) return [];

  const rows: any[] = [];
  for (const entry of flattenOptions(ourGroups)) {
    const r = scoreMatch(theirMod, entry.option);
    let score = r.score;
    const parts = r.why ? [r.why] : [];

    if (score > 0 && their.group && entry.groupLabel) {
      const g = scoreMatch(their.group, { name: entry.groupLabel });
      if (g.score >= WEIGHTS.exact) { score += WEIGHTS.groupSameBonus; parts.push('same group'); }
      else if (g.score >= 0.5) { score += WEIGHTS.groupCloseBonus; parts.push('close group'); }
      else { score = score * WEIGHTS.groupWrongFactor; parts.push('different group'); }
    }

    if (score > WEIGHTS.exact) score = WEIGHTS.exact;
    score = round3(score);
    if (score < minScore || score <= 0) continue;

    const optName = displayNameOf(entry.option);
    rows.push({
      optionId: entry.optionId,
      groupId: entry.groupId,
      name: optName,
      groupLabel: entry.groupLabel,
      itemId: entry.option.itemId != null ? String(entry.option.itemId) : null,
      score,
      why: parts.join(', '),
      _key: normaliseItemName(optName),
    });
  }

  return rows.sort(byOptionSuggestion).slice(0, limit).map((r) => ({
    optionId: r.optionId,
    groupId: r.groupId,
    name: r.name,
    groupLabel: r.groupLabel,
    itemId: r.itemId,
    score: r.score,
    why: r.why,
  }));
}

/**
 * The option arm of autoLinkDecision. Same rules, option ids instead.
 *
 * itemCodes has to be handed in here: this arm is given our modifier GROUPS,
 * not our menu items, so it cannot build the code index itself.
 *
 * A customization carries an id of its own, posCustomizationId, which the
 * mapper puts on the same itemId field as a line's posItemId. When it holds one
 * of our codes, the option is matched to that product, and to one of our
 * options as well if an option points at it.
 */
function autoLinkOption(
  theirMod: any,
  ourGroups: any[],
  existingLinks: any,
  minScore: number,
  itemCodes?: any,
): LinkDecision {
  const their = theirParts(theirMod);
  const flat = flattenOptions(ourGroups);
  const byId = new Map<string, any>();
  for (const e of flat) byId.set(e.optionId, e);
  let stale = false;

  const hit = findLink(indexLinks(existingLinks), theirMod, 'option');
  const link = hit ? hit.link : null;

  // 0. their id is one of our item codes. Certain, and it outranks the link.
  const coded = findItemCodeMatch(itemCodes, theirPosId(theirMod));
  if (coded) {
    let owner: any = null;
    for (const e of flat) {
      if (e.option && e.option.itemId != null && String(e.option.itemId) === coded.itemId) { owner = e; break; }
    }
    // The code names the PRODUCT. When one of our options points at it, that is
    // the option. When none does, an option a person already chose is kept:
    // knowing which product it is does not unknow which option it is.
    const savedOption = link && link.optionId ? String(link.optionId) : null;
    const optionId = owner ? owner.optionId : savedOption;
    const inMenu = optionId ? byId.get(optionId) : null;
    return {
      action: 'linked',
      optionId: optionId || null,
      groupId: owner ? owner.groupId : (inMenu ? inMenu.groupId : null),
      itemId: coded.itemId,
      reason: 'their menu has our item code',
      source: 'itemCode',
    };
  }

  if (link && link.optionId) {
    const id = String(link.optionId);
    const hit = byId.get(id);
    if (!flat.length || hit) {
      return {
        action: 'linked',
        optionId: id,
        groupId: hit ? hit.groupId : null,
        itemId: link.menuItemId != null ? String(link.menuItemId)
          : (hit && hit.option.itemId != null ? String(hit.option.itemId) : null),
        reason: 'already matched',
        source: link.source,
      };
    }
    stale = true;
  }

  // Exactly one option in the whole menu with that exact name.
  const target = normaliseItemName(their.name);
  const exact = target ? flat.filter((e) => normaliseItemName(displayNameOf(e.option)) === target) : [];
  if (exact.length === 1) {
    const e = exact[0];
    if (sizeClash(their.name, e.option)) {
      const out: LinkDecision = { action: 'suggest', reason: 'different size, check it' };
      if (stale) out.stale = true;
      return out;
    }
    const out: LinkDecision = {
      action: 'linked',
      optionId: e.optionId,
      groupId: e.groupId,
      itemId: e.option.itemId != null ? String(e.option.itemId) : null,
      reason: 'same name',
      source: 'auto',
    };
    if (stale) out.stale = true;
    return out;
  }
  if (exact.length > 1) {
    const out: LinkDecision = { action: 'suggest', reason: 'more than one option with that name' };
    if (stale) out.stale = true;
    return out;
  }

  const near = matchOptions(theirMod, ourGroups, { limit: 1, minScore });
  const out: LinkDecision = near.length
    ? { action: 'suggest', reason: 'close names to check' }
    : { action: 'none', reason: stale ? 'the old match is gone' : 'no match' };
  if (stale) out.stale = true;
  return out;
}

// ----------------------------------------------------------------------------
// applyLinks
// ----------------------------------------------------------------------------

/**
 * Fill itemId in on mapped ezCater lines from saved links, and say per line
 * whether it matched and where the match came from.
 *
 *   source 'itemCode'  their id is one of our item codes
 *   source 'manual'    a person linked it
 *   source 'auto'      we linked it and nobody corrected it
 *   source 'posItemId' ezCater already carried our id on the line
 *   source null        nothing matched, itemId stays null
 *
 * A link BEATS posItemId, the same order autoLinkDecision uses: a person who
 * corrected a bad id must not have their correction quietly overruled on the
 * next order. AN ITEM CODE BEATS BOTH, also the same order: the code came back
 * because it was set against that product on their side.
 *
 * itemCodes is optional. Without it there is no code rule, which is exactly how
 * this behaved before codes existed.
 *
 * Does not mutate the lines it is given. Does not know our menu, so it cannot
 * tell that a linked item was since deleted; autoLinkDecision is where that is
 * checked, with the menu in hand.
 */
export function applyLinks(lines: any[], links: any, itemCodes?: any): any[] {
  const idx = indexLinks(links);
  const codes = indexItemCodes(itemCodes);
  const list = Array.isArray(lines) ? lines : [];

  return list.map((line) => {
    const src = line || {};
    const hit = findLink(idx, src, 'item');
    const link = hit ? hit.link : null;

    let itemId = src.itemId != null ? String(src.itemId) : null;
    let source: string | null = itemId ? 'posItemId' : null;
    if (link && link.menuItemId) {
      itemId = String(link.menuItemId);
      source = link.source === 'auto' ? 'auto' : 'manual';
    }
    const coded = findItemCodeMatch(codes, theirPosId(src));
    if (coded) {
      itemId = coded.itemId;
      source = 'itemCode';
    }

    const mods = (Array.isArray(src.mods) ? src.mods : []).map((mod: any) => {
      const m = mod || {};
      const mHit = findLink(idx, m, 'option');
      const mLink = mHit ? mHit.link : null;

      let mItemId = m.itemId != null ? String(m.itemId) : null;
      let mOptionId = m.optionId != null ? String(m.optionId) : null;
      let mSource: string | null = mItemId ? 'posItemId' : null;
      if (mLink && (mLink.optionId || mLink.menuItemId)) {
        if (mLink.optionId) mOptionId = String(mLink.optionId);
        if (mLink.menuItemId) mItemId = String(mLink.menuItemId);
        mSource = mLink.source === 'auto' ? 'auto' : 'manual';
      }
      // A code on a customization names one of our PRODUCTS, which is what
      // stock and 86 key on. Any option id a saved link gave is kept: knowing
      // which of our options it is does not contradict knowing the product.
      const mCoded = findItemCodeMatch(codes, theirPosId(m));
      if (mCoded) {
        mItemId = mCoded.itemId;
        mSource = 'itemCode';
      }

      return {
        ...m,
        itemId: mItemId,
        optionId: mOptionId,
        match: { matched: !!(mOptionId || mItemId), source: mSource },
      };
    });

    return { ...src, itemId, mods, match: { matched: !!itemId, source } };
  });
}

/**
 * Count what applyLinks produced, so a screen or a log can say "3 of 5 lines
 * matched" without walking the lines again.
 */
export function countMatches(lines: any[]): {
  total: number;
  matched: number;
  unmatched: number;
  mods: { total: number; matched: number; unmatched: number };
  allMatched: boolean;
} {
  const list = Array.isArray(lines) ? lines : [];
  let matched = 0;
  let modTotal = 0;
  let modMatched = 0;
  for (const line of list) {
    if (line && line.match && line.match.matched) matched++;
    for (const mod of Array.isArray(line && line.mods) ? line.mods : []) {
      modTotal++;
      if (mod && mod.match && mod.match.matched) modMatched++;
    }
  }
  return {
    total: list.length,
    matched,
    unmatched: list.length - matched,
    mods: { total: modTotal, matched: modMatched, unmatched: modTotal - modMatched },
    allMatched: list.length > 0 && matched === list.length,
  };
}
