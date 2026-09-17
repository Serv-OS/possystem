// src/lib/itemCode.js
//
// THE SHORT CODE A VENUE GIVES ONE OF ITS PRODUCTS.
//
// Peter, 17 Sep: "we should be able to give ezCater a SKU or code for each
// product, but if it is missing it should still be able to receive the order".
// Both halves matter, and the second one is the important one: a code is an
// OPTIONAL shortcut. Nothing anywhere may require it.
//
// WHAT IT IS
//   menu_items.item_code, 3 to 16 letters and digits, upper case, unique per
//   location. The same code goes on ezCater's side against the same product (in
//   their words, its POS id), and from then on ezCater sends it back on every
//   order line as posItemId. src/lib/ezcaterMatch.js treats that as a certain
//   match, which outranks even a saved link.
//
//   HOW IT GETS ONTO THEIR SIDE IS NOT SETTLED. The only documented writer is
//   the Menus API menuCreate, which we do not have permission for. Whether a
//   venue can type one into the Partner Portal is documented nowhere and only
//   ezCater can answer. None of that changes this file: the code is ours, we
//   hold it, we can hand it over, and it costs nothing while it is unused.
//
// WHY NOT menu_items.id
//   It is text, but it holds long generated values ('m-1726587411234'). Nobody
//   types that into a portal by hand without mistyping it.
//
// WHAT HAPPENS WHEN IT IS MISSING
//   Nothing. No code on a product, no code in their portal, or the migration
//   not run at all: the order arrives exactly as it does today and matching
//   falls through to the saved links and the name rules.
//
// This file is PURE except for loadItemCodes at the bottom, which takes the
// Supabase client as an argument and can never throw.

/** Shortest code we will save. Two characters is a typo, not a code. */
export const ITEM_CODE_MIN = 3;
/** Longest. Past this it stops being something a person types into a portal. */
export const ITEM_CODE_MAX = 16;
/** What Suggest aims for, so a suggested code stays readable. */
export const ITEM_CODE_SUGGEST_LEN = 9;

/** The help line under the field. Short plain words, no jargon. */
export const ITEM_CODE_HELP =
  'The code to give ezCater and other partner portals. Letters and numbers, 3 to 16.';

// ----------------------------------------------------------------------------
// The two forms of a code
// ----------------------------------------------------------------------------

/**
 * The SAVED form: upper case, letters and digits only, never longer than
 * ITEM_CODE_MAX. This is what a person's typing becomes, so "flat white!" and
 * "Flat-White" both save as FLATWHITE and two people cannot create two codes
 * that look the same on a screen.
 */
export function normaliseItemCode(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  // Accents off first, so "Crème" contributes CREME rather than losing letters.
  s = s.normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return s.slice(0, ITEM_CODE_MAX);
}

/**
 * The COMPARING form: trimmed and upper case, and nothing else.
 *
 * Deliberately gentler than normaliseItemCode. This is used against text a
 * partner sends us, and dropping punctuation there could make their "M-123"
 * equal our "M123", which is a wrong match nobody asked for. Case and stray
 * spaces are the only differences we forgive.
 */
export function itemCodeKey(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
}

/**
 * What a writer puts in the column: trimmed, or null when there is nothing.
 *
 * It does NOT re-run normaliseItemCode. The editor normalises what a person
 * types, and everything else that reaches a save carries a code THE DATABASE
 * ALREADY HOLDS. Normalising here would silently rewrite a code somebody set
 * another way (say FLAT-WHITE to FLATWHITE) on the next unrelated menu save,
 * and their partner's side would still hold the old one.
 */
export function itemCodeForSave(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

/** One item's code, from either spelling, or null. */
export function codeOf(item) {
  if (!item) return null;
  const raw = item.itemCode !== undefined && item.itemCode !== null ? item.itemCode : item.item_code;
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  return s ? s : null;
}

/** The name we show a person for one of our items. */
export function itemNameOf(item) {
  if (!item) return '';
  const raw = item.menuName || item.menu_name || item.name || '';
  // One line, single spaces: this name goes into a two column list that a
  // person pastes somewhere, and a stray tab would split it into three.
  return String(raw).replace(/\s+/g, ' ').trim();
}

// ----------------------------------------------------------------------------
// Who already holds which code
// ----------------------------------------------------------------------------

/**
 * Every code in use at this venue, keyed by its comparing form:
 *   Map('FLATWHITE' -> { itemId, code, name })
 *
 * `items` is our menu (store shape or table rows). `extra` is an optional
 * Map/object of id -> code read straight from the database, which is what the
 * Back Office uses: it covers ARCHIVED products too, and those still hold their
 * code as far as the unique index is concerned.
 */
export function takenItemCodes(items, extra) {
  const out = new Map();
  const add = (id, code, name) => {
    const key = itemCodeKey(code);
    if (!key || !id) return;
    // First writer wins, so the answer does not depend on list order.
    if (out.has(key)) return;
    out.set(key, { itemId: String(id), code: key, name: name || '' });
  };

  if (extra instanceof Map) {
    for (const [id, code] of extra) add(id, code, '');
  } else if (extra && typeof extra === 'object') {
    for (const id of Object.keys(extra)) add(id, extra[id], '');
  }

  for (const it of Array.isArray(items) ? items : []) {
    if (!it || it.id == null) continue;
    add(it.id, codeOf(it), itemNameOf(it));
  }

  // A name for every row we could name, whichever list it came from first.
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || it.id == null) continue;
    const key = itemCodeKey(codeOf(it));
    const hit = key ? out.get(key) : null;
    if (hit && !hit.name && hit.itemId === String(it.id)) hit.name = itemNameOf(it);
  }

  return out;
}

const isTaken = (taken, key, selfId) => {
  if (!key) return null;
  const hit = taken instanceof Map ? taken.get(key) : null;
  if (!hit) return null;
  if (selfId != null && hit.itemId === String(selfId)) return null;
  return hit;
};

// ----------------------------------------------------------------------------
// Suggest
// ----------------------------------------------------------------------------

/**
 * A readable code built from the product's name: "Flat White" -> FLATWHITE,
 * "Caesar Salad" -> CAESARSAL. Capped at ITEM_CODE_SUGGEST_LEN so it stays
 * short enough to read back over a phone.
 *
 * If that code is already used at this venue it gets a number on the end
 * (FLATWHITE2, FLATWHITE3). A name with no letters or digits in it at all gets
 * no suggestion: '' comes back and the screen says to name the product first.
 */
export function suggestItemCode(name, taken, selfId) {
  const all = normaliseItemCode(name);
  if (!all) return '';

  let base = all.slice(0, ITEM_CODE_SUGGEST_LEN);
  const free = (code) => code.length >= ITEM_CODE_MIN
    && code.length <= ITEM_CODE_MAX
    && !isTaken(taken, code, selfId);

  // A name shorter than the minimum borrows digits to reach it: "PB" -> PB1.
  if (base.length >= ITEM_CODE_MIN && free(base)) return base;

  for (let n = base.length < ITEM_CODE_MIN ? 1 : 2; n <= 999; n++) {
    let suffix = String(n);
    // A one or two letter name borrows a leading zero so the code still reaches
    // the minimum: "PB" -> PB1, "A" -> A01.
    const short = ITEM_CODE_MIN - base.length - suffix.length;
    if (short > 0) suffix = suffix.padStart(suffix.length + short, '0');
    const stem = base.slice(0, ITEM_CODE_MAX - suffix.length);
    const candidate = stem + suffix;
    if (free(candidate)) return candidate;
  }
  return '';
}

// ----------------------------------------------------------------------------
// Check what a person typed
// ----------------------------------------------------------------------------

/**
 * What to save, or why we cannot. Never throws, never guesses.
 *
 *   { code: 'FLATWHITE', error: null }  save this
 *   { code: null,        error: null }  the box was cleared, save no code
 *   { code: null,        error: '...' } show this line, save nothing
 *
 * The message is plain words for an operator, not a validation string.
 */
export function checkItemCode(raw, opts) {
  const o = opts || {};
  const code = normaliseItemCode(raw);
  if (!code) return { code: null, error: null };

  if (code.length < ITEM_CODE_MIN) {
    return { code: null, error: `Use at least ${ITEM_CODE_MIN} letters or numbers.` };
  }

  const taken = o.taken instanceof Map ? o.taken : takenItemCodes(o.items, o.codesById);
  const clash = isTaken(taken, code, o.itemId);
  if (clash) {
    return {
      code: null,
      error: clash.name
        ? `${clash.name} already uses that code. Pick another one.`
        : 'Another product already uses that code. Pick another one.',
    };
  }

  return { code, error: null };
}

// ----------------------------------------------------------------------------
// Handing the codes over
// ----------------------------------------------------------------------------

/** The header of the two column list. */
export const ITEM_CODE_LIST_HEADER = ['Product', 'Item code'];

/**
 * Every product that has a code, as { name, code }, by name. Archived products
 * are left out: they are not on the menu, so nobody is typing their code into a
 * portal.
 */
export function itemCodeRows(items, codesById) {
  const byId = new Map();
  const extra = codesById instanceof Map
    ? codesById
    : new Map(Object.entries(codesById && typeof codesById === 'object' ? codesById : {}));

  for (const it of Array.isArray(items) ? items : []) {
    if (!it || it.id == null || it.archived) continue;
    const id = String(it.id);
    const code = itemCodeKey(codeOf(it) || extra.get(id) || '');
    if (!code) continue;
    const name = itemNameOf(it);
    if (!name) continue;
    if (byId.has(id)) continue;
    byId.set(id, { name, code });
  }

  return Array.from(byId.values()).sort((a, b) => {
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.code < b.code ? -1 : (a.code > b.code ? 1 : 0);
  });
}

/**
 * The text the "Copy item codes" button puts on the clipboard: a header row and
 * then one row per product, name and code separated by a tab.
 *
 * A tab, because the two places this is pasted are a spreadsheet (two columns,
 * no work) and one portal field at a time (the operator copies the code out of
 * the second column).
 */
export function itemCodesText(items, codesById) {
  const rows = itemCodeRows(items, codesById);
  if (!rows.length) return '';
  const lines = [ITEM_CODE_LIST_HEADER.join('\t')];
  for (const r of rows) lines.push(r.name + '\t' + r.code);
  return lines.join('\n');
}

// ----------------------------------------------------------------------------
// Living without the column
// ----------------------------------------------------------------------------

/**
 * True when a Supabase error means menu_items.item_code does not exist, because
 * 20260917_OPS_menu_item_code.sql has not been run yet (Peter runs migrations by
 * hand, so this window is real and can last days).
 *
 * PGRST204 is PostgREST's "column not in the schema cache" on a write, 42703 is
 * Postgres undefined_column on a read. Both name the column, which is what
 * keeps this from swallowing an unrelated failure.
 */
export function isMissingItemCodeColumn(err) {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || err.details || err.hint || '');
  if (!/item_code/i.test(msg)) return false;
  return code === 'PGRST204' || code === '42703' || /column/i.test(msg);
}

/**
 * True when the database refused a write because another product at this venue
 * already holds that code (23505 on the partial unique index).
 *
 * The screen checks for duplicates itself, so this only fires on the race, or
 * on a clash with an ARCHIVED product the screen's list did not include. Either
 * way the save must not be lost: the caller writes the item again without the
 * code and says so in plain words.
 */
export function isDuplicateItemCodeError(err) {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || err.details || '');
  if (code === '23505') return /item_code/i.test(msg) || /menu_items_item_code/i.test(msg);
  return /menu_items_item_code_unique/i.test(msg);
}

/** The line to show when the database refuses a code as a duplicate. */
export const ITEM_CODE_DUPLICATE_MESSAGE =
  'That item code is already used by another product, so it was not saved. Everything else was.';

// ----------------------------------------------------------------------------
// Reading the codes (the one impure function here)
// ----------------------------------------------------------------------------

/** PostgREST caps a select at 1000 rows. */
export const ITEM_CODE_PAGE = 1000;

/**
 * Every product's code at one venue, straight from the table.
 *
 *   { supported: true,  codes: Map(id -> code) }  the column is there
 *   { supported: false, codes: Map() }            it is not, hide the field
 *
 * ARCHIVED ROWS ARE INCLUDED ON PURPOSE. The unique index does not care that a
 * product was archived, so neither may the duplicate check: otherwise a person
 * types a code the screen accepts and the database refuses.
 *
 * Never throws. A read that fails for any other reason comes back supported,
 * with no codes: the field still works, and the database is the backstop for a
 * duplicate.
 */
export async function loadItemCodes(sb, locationId) {
  const out = { supported: true, codes: new Map(), error: null };
  if (!sb || !locationId) return out;
  try {
    const { data, error } = await sb.from('menu_items')
      .select('id, item_code')
      .eq('location_id', locationId)
      .order('id', { ascending: true })
      .limit(ITEM_CODE_PAGE);
    if (error) {
      if (isMissingItemCodeColumn(error)) out.supported = false;
      out.error = error;
      return out;
    }
    for (const row of Array.isArray(data) ? data : []) {
      if (!row || row.id == null) continue;
      const code = codeOf(row);
      if (code) out.codes.set(String(row.id), code);
    }
  } catch (e) {
    out.error = e;
    if (isMissingItemCodeColumn(e)) out.supported = false;
  }
  return out;
}
