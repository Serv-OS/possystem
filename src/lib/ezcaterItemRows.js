// src/lib/ezcaterItemRows.js
//
// The view model behind Back Office, Channels, 3rd Party orders, "Item matching".
// Pure functions only: no React, no Supabase, no imports except the matching
// rules. The screen is a thin shell over this file so the parts that can be
// wrong are the parts that are tested.
//
// WHAT A ROW IS
// An ezcater_item_links row is a SIGHTING first and a link second. The webhook
// writes one the first time ezCater sends a name, with no target on it, and a
// person later says which of our products it is. So one row is in exactly one
// of three states:
//
//   unmatched  we have seen this name and nobody has said what it is
//   matched    it points at one of our menu items or modifier options
//   ignored    a person said it is not on our menu, stop asking
//
// The state is DERIVED from the columns, never read from a state column. That
// is deliberate: it means this file, the screen and the edge function all work
// against 20260917_OPS_ezcater_item_links.sql exactly as written, with no extra
// column to feature detect and nothing to go stale if the file is re-run.
//
//   menu_item_id / option_id set  ->  matched
//   neither set, matched_by 'ignored'  ->  ignored
//   neither set  ->  unmatched
//
// WHY ORDERING IS "UNMATCHED FIRST, NEWEST FIRST"
// The only reason to open this screen is the work that is outstanding, and the
// most useful unmatched item is the one that just arrived on an order, because
// that is the order sitting on the pass as a plain text ticket right now.

import { suggestMatches, matchOptions, buildLinkKey, normaliseItemName, displayNameOf } from './ezcaterMatch.js';

// ----------------------------------------------------------------------------
// "Matching is not switched on yet"
// ----------------------------------------------------------------------------

/**
 * Postgres and PostgREST codes that all mean the same thing to this screen:
 * the ezcater_item_links table is not there yet because Peter has not run the
 * migration. 42P01 is Postgres undefined_table, PGRST205 is PostgREST failing
 * to find it in its schema cache, PGRST202 is the same for a function.
 */
export const ABSENT_CODES = Object.freeze(['42P01', 'PGRST205', 'PGRST202', 'PGRST204']);

const textOf = (err) => {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return String(err.message || err.error || err.details || err.hint || '');
};

/**
 * True when the failure means "this is not switched on yet" rather than "this
 * broke". Three separate ways to end up here, and the screen must say the same
 * calm thing for all of them:
 *
 *   1. the table is missing, because the migration has not been run
 *   2. the edge function is not deployed yet, so invoke 404s. Edge functions do
 *      NOT deploy with the web app, which is the oldest trap in this codebase
 *   3. the function answered { enabled: false }, having caught (1) itself
 *
 * Anything else is a real error and must be shown as one. Swallowing a real
 * error here would leave a venue staring at "not switched on yet" while their
 * orders quietly failed to route.
 */
export function isMatchingOff(err) {
  if (!err) return false;
  const code = String((err && err.code) || '');
  if (ABSENT_CODES.indexOf(code) !== -1) return true;
  const msg = textOf(err).toLowerCase();
  if (!msg) return false;
  return (
    /relation .*does not exist/.test(msg)
    || /could not find the table/.test(msg)
    || /schema cache/.test(msg)
    || /ezcater_item_links/.test(msg)
    || /function not found/.test(msg)
    || /not deployed/.test(msg)
    || /failed to send a request to the edge function/.test(msg)
    || /\b404\b/.test(msg)
  );
}

// ----------------------------------------------------------------------------
// Rows
// ----------------------------------------------------------------------------

const str = (v) => (v === undefined || v === null || v === '' ? null : String(v));
const first = (row, snake, camel) => {
  const a = str(row ? row[snake] : null);
  return a !== null ? a : str(row ? row[camel] : null);
};

/** How many ezCater lines this row has been seen on. Never negative, never NaN. */
function seenOf(row) {
  const raw = row && (row.seen_count !== undefined ? row.seen_count : row.seenCount);
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

/**
 * One table row into one screen row. Takes the row straight off the table
 * (snake_case) or already camelCased, the same tolerance indexLinks has.
 *
 * Returns null for a row with no usable key or name, because such a row cannot
 * be shown (nothing to label it) and cannot be saved (the key check would
 * reject it). Dropping it is strictly better than rendering a blank line the
 * operator can click.
 */
export function toRow(dbRow) {
  if (!dbRow || typeof dbRow !== 'object') return null;
  const ezKey = first(dbRow, 'ez_key', 'ezKey');
  const ezName = first(dbRow, 'ez_name', 'ezName');
  if (!ezKey || !ezName) return null;

  const kind = first(dbRow, 'kind', 'kind') === 'option' ? 'option' : 'item';
  const menuItemId = first(dbRow, 'menu_item_id', 'menuItemId');
  const optionId = first(dbRow, 'option_id', 'optionId');
  const matchedBy = first(dbRow, 'matched_by', 'matchedBy');

  let state = 'unmatched';
  if (menuItemId || optionId) state = 'matched';
  else if (matchedBy === 'ignored') state = 'ignored';

  return {
    kind,
    ezKey,
    ezName,
    ezGroup: first(dbRow, 'ez_group', 'ezGroup'),
    menuItemId,
    optionId,
    source: first(dbRow, 'source', 'source') || 'auto',
    matchedBy,
    seenCount: seenOf(dbRow),
    lastSeenAt: first(dbRow, 'last_seen_at', 'lastSeenAt'),
    state,
  };
}

/** Sort key for "newest first": a missing timestamp sorts last, never first. */
const seenAtMs = (row) => {
  const t = row && row.lastSeenAt ? Date.parse(row.lastSeenAt) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
};

const STATE_ORDER = { unmatched: 0, matched: 1, ignored: 2 };

/**
 * Unmatched first, then matched, then the ones a person silenced. Inside each
 * group, most recently seen first, then most seen, then by name so the list is
 * the same list every time and does not shuffle under the operator's cursor
 * while they work down it.
 */
export function sortRows(rows) {
  return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) => {
    const sa = STATE_ORDER[a.state] ?? 3;
    const sb = STATE_ORDER[b.state] ?? 3;
    if (sa !== sb) return sa - sb;
    const ta = seenAtMs(a);
    const tb = seenAtMs(b);
    if (ta !== tb) return tb - ta;
    if (a.seenCount !== b.seenCount) return b.seenCount - a.seenCount;
    if (a.ezName !== b.ezName) return a.ezName < b.ezName ? -1 : 1;
    return a.ezKey < b.ezKey ? -1 : (a.ezKey > b.ezKey ? 1 : 0);
  });
}

/** Table rows straight from the edge function into the list the screen renders. */
export function rowsFrom(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const row = toRow(raw);
    if (row) out.push(row);
  }
  return sortRows(out);
}

/** Only the rows of one kind: the Items tab and the Options tab. */
export function ofKind(rows, kind) {
  const want = kind === 'option' ? 'option' : 'item';
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.kind === want);
}

/** Counts for one tab. `outstanding` is the number the heading reports. */
export function countRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let matched = 0;
  let ignored = 0;
  let unmatched = 0;
  for (const r of list) {
    if (!r) continue;
    if (r.state === 'matched') matched++;
    else if (r.state === 'ignored') ignored++;
    else unmatched++;
  }
  return { total: matched + ignored + unmatched, matched, ignored, unmatched, outstanding: unmatched };
}

// ----------------------------------------------------------------------------
// Copy
// ----------------------------------------------------------------------------

/**
 * The plain line at the top of a tab. Short words, correct singular, and it
 * says the good news rather than "0" when there is nothing to do.
 */
export function outstandingLine(counts, kind) {
  const c = counts || {};
  const n = Number(c.outstanding) || 0;
  const noun = kind === 'option' ? 'options' : 'items';
  if (!c.total) return `Nothing from ezCater yet. Their ${noun} show up here after the first order.`;
  if (n === 0) return `All their ${noun} are matched.`;
  if (n === 1) return `1 of their ${noun} is not matched yet.`;
  return `${n} of their ${noun} are not matched yet.`;
}

/** The small grey line under a row: how often ezCater has sent it. */
export function seenLine(row) {
  const n = row ? row.seenCount : 0;
  if (!n) return 'Not on an order yet';
  return n === 1 ? 'On 1 order' : `On ${n} orders`;
}

// ----------------------------------------------------------------------------
// The picker
// ----------------------------------------------------------------------------

/**
 * A menu_items row's price.
 *
 * THERE IS NO `price` COLUMN ON menu_items. The price lives in the `pricing`
 * jsonb, the same place MenuManager and src/lib/menuPricing.js read it from
 * (pricing.base, with the older pricing.price as a fallback). The screen used
 * to select a `price` column that does not exist, which failed the whole select
 * and left the picker permanently empty with every matched row reading "Deleted
 * from our menu".
 *
 * The scalar `it.price` is still read last, because rows already in memory from
 * the store carry it and a test fixture may too.
 *
 * Returns null when there is no price. Null is "no price", never zero: a zero
 * would claim an agreement with an ezCater line that costs nothing and hand out
 * a price bonus it did not earn.
 */
export function itemPriceOf(it) {
  const p = (it && it.pricing) || null;
  const candidates = [p ? p.base : null, p ? p.price : null, it ? it.price : null];
  for (const v of candidates) {
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** Our menu items in the shape scoreMatch wants, archived ones dropped. */
export function ourItemsFrom(list) {
  const out = [];
  for (const it of Array.isArray(list) ? list : []) {
    if (!it || it.archived) continue;
    const id = it.id != null ? String(it.id) : '';
    if (!id) continue;
    const name = it.name != null ? String(it.name) : '';
    const menuName = (it.menu_name != null ? it.menu_name : it.menuName);
    if (!name && !menuName) continue;
    const price = itemPriceOf(it);
    out.push({
      id,
      name,
      menuName: menuName != null ? String(menuName) : undefined,
      price: price === null ? undefined : price,
    });
  }
  return out;
}

/** Our modifier groups in the shape matchOptions wants. */
export function ourGroupsFrom(list) {
  const out = [];
  for (const g of Array.isArray(list) ? list : []) {
    if (!g) continue;
    const id = g.id != null ? String(g.id) : '';
    if (!id) continue;
    const options = [];
    for (const o of Array.isArray(g.options) ? g.options : []) {
      if (!o) continue;
      const oid = o.id != null ? String(o.id) : '';
      if (!oid) continue;
      options.push(o);
    }
    if (!options.length) continue;
    out.push({ id, name: g.name != null ? String(g.name) : '', options });
  }
  return out;
}

/**
 * Our price per item id, for the picker. null means we have no price for it,
 * and the screen then shows none rather than a made up zero.
 */
function pricesById(ourItems) {
  const m = new Map();
  for (const it of Array.isArray(ourItems) ? ourItems : []) {
    if (!it || it.id == null) continue;
    const n = Number(it.price);
    m.set(String(it.id), Number.isFinite(n) ? n : null);
  }
  return m;
}

/**
 * The shortlist under an unmatched row, already in the one shape the screen
 * renders, whichever tab it is on.
 *
 * Each entry: { id, name, note, why, score, price }
 *   id     what gets saved: our menu item id, or our option id
 *   note   the group an option came from, so two options called "Large" are
 *          told apart without the operator opening anything
 *   price  our price, or null when we have none. The screen shows it only when
 *          it is a number, because it is there to tell two same named items
 *          apart and a false zero would do the opposite.
 */
export function suggestionsFor(row, ourItems, ourGroups, opts) {
  if (!row || !row.ezName) return [];
  const limit = opts && Number.isFinite(opts.limit) ? opts.limit : 5;

  if (row.kind === 'option') {
    const their = { name: row.ezName, groupLabel: row.ezGroup || '' };
    return matchOptions(their, ourGroups, { limit }).map((s) => ({
      id: s.optionId,
      name: s.name,
      note: s.groupLabel || '',
      why: s.why,
      score: s.score,
      price: null,
      optionId: s.optionId,
      menuItemId: s.itemId || null,
    }));
  }

  const prices = pricesById(ourItems);
  return suggestMatches({ name: row.ezName }, ourItems, { limit }).map((s) => ({
    id: s.itemId,
    name: s.name,
    note: '',
    why: s.why,
    score: s.score,
    price: prices.has(s.itemId) ? prices.get(s.itemId) : null,
    optionId: null,
    menuItemId: s.itemId,
  }));
}

const fold = (s) => normaliseItemName(String(s || '')) || String(s || '').trim().toLowerCase();

/**
 * The search box behind the suggestions: plain substring, not fuzzy scoring.
 * Somebody typing "cae" is spelling out the name they already have in mind,
 * and token overlap scores a three letter fragment at zero, so the matcher's
 * ranking is the wrong tool for this box.
 *
 * Matching is done on the normalised name as well as the raw one, so "mac and
 * cheese" finds "Mac & Cheese".
 */
export function searchOurItems(query, ourItems, ourGroups, kind, opts) {
  const limit = opts && Number.isFinite(opts.limit) ? opts.limit : 25;
  const raw = String(query || '').trim();
  if (!raw) return [];
  const needleRaw = raw.toLowerCase();
  const needleFolded = fold(raw);

  const hits = [];
  const hit = (entry) => {
    const hayRaw = String(entry.name || '').toLowerCase();
    const hayFolded = fold(entry.name);
    const noteRaw = String(entry.note || '').toLowerCase();
    if (
      hayRaw.indexOf(needleRaw) !== -1
      || (needleFolded && hayFolded.indexOf(needleFolded) !== -1)
      || (noteRaw && noteRaw.indexOf(needleRaw) !== -1)
    ) hits.push(entry);
  };

  if (kind === 'option') {
    for (const g of Array.isArray(ourGroups) ? ourGroups : []) {
      for (const o of (g && Array.isArray(g.options) ? g.options : [])) {
        const oid = o && o.id != null ? String(o.id) : '';
        if (!oid) continue;
        hit({
          id: oid,
          name: displayNameOf(o),
          note: displayNameOf(g),
          why: '',
          score: 0,
          price: null,
          optionId: oid,
          menuItemId: o.itemId != null ? String(o.itemId) : null,
        });
      }
    }
  } else {
    for (const it of Array.isArray(ourItems) ? ourItems : []) {
      const id = it && it.id != null ? String(it.id) : '';
      if (!id) continue;
      const n = Number(it.price);
      hit({
        id,
        name: displayNameOf(it),
        note: '',
        why: '',
        score: 0,
        price: Number.isFinite(n) ? n : null,
        optionId: null,
        menuItemId: id,
      });
    }
  }

  // Names that START with what was typed first, then the rest, then by name.
  // Typing "cola" should not put "Diet Cola Float" above "Cola".
  hits.sort((a, b) => {
    const as = String(a.name || '').toLowerCase().indexOf(needleRaw) === 0 ? 0 : 1;
    const bs = String(b.name || '').toLowerCase().indexOf(needleRaw) === 0 ? 0 : 1;
    if (as !== bs) return as - bs;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });

  const seen = new Set();
  const out = [];
  for (const h of hits) {
    if (seen.has(h.id)) continue;
    seen.add(h.id);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

/** The name of whatever a matched row points at, for the "matched to" line. */
export function matchedLabel(row, ourItems, ourGroups) {
  if (!row || row.state !== 'matched') return '';
  if (row.optionId) {
    for (const g of Array.isArray(ourGroups) ? ourGroups : []) {
      for (const o of (g && Array.isArray(g.options) ? g.options : [])) {
        if (o && String(o.id) === row.optionId) {
          const gName = displayNameOf(g);
          const oName = displayNameOf(o);
          return gName ? `${oName} (${gName})` : oName;
        }
      }
    }
  }
  if (row.menuItemId) {
    for (const it of Array.isArray(ourItems) ? ourItems : []) {
      if (it && String(it.id) === row.menuItemId) return displayNameOf(it);
    }
  }
  // The link points at something that is not on the menu any more. Say so
  // rather than showing a blank, because this is the one case where a venue
  // needs to act: the routing behind it is dead.
  return 'Deleted from our menu';
}

// ----------------------------------------------------------------------------
// Saving
// ----------------------------------------------------------------------------

/**
 * The body for one items_save call, or { error } when it must not be sent.
 *
 * `choice` is one of:
 *   { menuItemId }            match an item
 *   { optionId, menuItemId? } match an option
 *   { ignored: true }         "Not on our menu"
 *   {}                        clear it back to unmatched
 *
 * The key is rebuilt from the name here rather than trusted from the row, so a
 * row that arrived with a key written by an older rule set is saved under the
 * key today's rules would look it up by. The edge function rebuilds it again
 * from the same shared rules; this is the client side half of that.
 */
export function saveBody(row, choice) {
  if (!row || !row.ezName) return { error: 'nothing to save' };
  const kind = row.kind === 'option' ? 'option' : 'item';
  const line = kind === 'option'
    ? { name: row.ezName, groupLabel: row.ezGroup || '' }
    : { name: row.ezName };
  const ezKey = buildLinkKey(line, kind);
  if (!ezKey) return { error: 'that name cannot be matched' };

  const c = choice || {};
  const ignored = c.ignored === true;
  const menuItemId = ignored ? null : str(c.menuItemId);
  const optionId = ignored ? null : str(c.optionId);

  if (kind === 'item' && optionId) return { error: 'an item cannot be matched to an option' };
  if (kind === 'option' && !ignored && menuItemId && !optionId) {
    return { error: 'an option needs one of our options, not an item' };
  }

  return {
    body: {
      kind,
      ez_key: ezKey,
      ez_name: row.ezName,
      ez_group: kind === 'option' ? (row.ezGroup || null) : null,
      menu_item_id: menuItemId,
      option_id: optionId,
      ignored,
    },
  };
}

/**
 * The row the list should show straight after a save, so the screen settles
 * before the reload comes back rather than flashing the old state. Same derive
 * rules as toRow, applied to what we just sent.
 */
export function applySaved(rows, sent) {
  if (!sent || !sent.ez_key) return Array.isArray(rows) ? rows : [];
  const kind = sent.kind === 'option' ? 'option' : 'item';
  const menuItemId = str(sent.menu_item_id);
  const optionId = str(sent.option_id);
  let state = 'unmatched';
  if (menuItemId || optionId) state = 'matched';
  else if (sent.ignored) state = 'ignored';

  let found = false;
  const next = (Array.isArray(rows) ? rows : []).map((r) => {
    if (!r || r.kind !== kind || r.ezKey !== sent.ez_key) return r;
    found = true;
    return {
      ...r,
      menuItemId,
      optionId,
      matchedBy: sent.ignored ? 'ignored' : null,
      source: 'manual',
      state,
    };
  });
  if (found) return sortRows(next);
  return sortRows(next.concat([{
    kind,
    ezKey: sent.ez_key,
    ezName: sent.ez_name,
    ezGroup: sent.ez_group || null,
    menuItemId,
    optionId,
    source: 'manual',
    matchedBy: sent.ignored ? 'ignored' : null,
    seenCount: 0,
    lastSeenAt: null,
    state,
  }]));
}
