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

/**
 * Every row a menu sync writes is keyed by this plus its exact full name. The same constant as
 * SYNC_KEY_PREFIX in supabase/functions/_shared/ezcaterMenuSync.ts (a test holds them together).
 */
export const SYNC_KEY_PREFIX = 'exact:';

/**
 * True for an option key a sync writes today: 'exact:' plus a JSON array of the item, group and
 * value (review round 6, optionIdentity in _shared/ezcaterMenuSync.ts). Keys of earlier rounds
 * ('exact:group|value', 'exact:item|group|value') are not.
 */
export function isCurrentOptionKey(ezKey) {
  const k = typeof ezKey === 'string' ? ezKey : '';
  if (k.indexOf(SYNC_KEY_PREFIX) !== 0) return false;
  const t = k.slice(SYNC_KEY_PREFIX.length);
  if (t.charAt(0) !== '[') return false;
  try {
    const a = JSON.parse(t);
    return Array.isArray(a) && a.length === 3 && a.every((x) => typeof x === 'string') && !!a[0] && !!a[2];
  } catch { return false; }
}

/**
 * What decided_as says, as a person reads it. An option's decided_as holds its item, group and
 * value apart (a JSON object, decidedAsOf in _shared/ezcaterMenuSync.ts): written out here as
 * '<item> › <group>: <value>'. Any other text is shown as it is.
 */
export function readableDecidedAs(text) {
  const t = typeof text === 'string' ? text.trim() : '';
  if (t.charAt(0) !== '{') return t;
  try {
    const o = JSON.parse(t);
    if (!o || typeof o !== 'object' || typeof o.value !== 'string') return t;
    const group = typeof o.group === 'string' ? o.group.trim() : '';
    const item = typeof o.item === 'string' ? o.item.trim() : '';
    const value = group ? `${group}: ${o.value.trim()}` : o.value.trim();
    return item ? `${item} \u203a ${value}` : value;
  } catch { return t; }
}

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
 *
 * opts.syncReady (items_list menu_sync_ready: migration 20260919m has run) marks
 * every row no menu sync wrote (its key is not a synced key) as offMenu. From
 * then on orders only use synced rows, by exact name and published id, so such
 * a row (a sighting or a match saved before the sync) can never route anything:
 * the card lists it apart, read only, never as work to do.
 *
 * opts.menuAt (the last whole sync's time, ezcater_menu_syncs.last_ok_at) marks
 * a synced row that sync did not write as gone: ezCater no longer sells that
 * exact name (renamed, resized or taken off). Its match still routes a change to
 * an order placed before, so it stays listed, last, and is not work to do.
 */
export function toRow(dbRow, opts) {
  if (!dbRow || typeof dbRow !== 'object') return null;
  const ezKey = first(dbRow, 'ez_key', 'ezKey');
  const ezName = first(dbRow, 'ez_name', 'ezName');
  if (!ezKey || !ezName) return null;

  const kind = first(dbRow, 'kind', 'kind') === 'option' ? 'option' : 'item';
  const menuItemId = first(dbRow, 'menu_item_id', 'menuItemId');
  const optionId = first(dbRow, 'option_id', 'optionId');
  const matchedBy = first(dbRow, 'matched_by', 'matchedBy');

  const source = first(dbRow, 'source', 'source') || 'auto';
  const syncedAt = first(dbRow, 'synced_at', 'syncedAt');
  // A row a menu sync wrote: keyed by its exact full name (SYNC_KEY_PREFIX).
  // An option row is keyed by its item, group and value, structured (isCurrentOptionKey, review
  // round 6). One keyed by an earlier round's rule was written by an earlier sync: orders never
  // use it (isCurrentSyncKey in _shared/ezcaterMenuSync.ts), so it is listed with the older rows.
  const synced = ezKey.indexOf(SYNC_KEY_PREFIX) === 0
    && (kind !== 'option' || isCurrentOptionKey(ezKey));

  // EXACT MEANS EXACT (mirrors trustedTarget in supabase/functions/_shared/ezcaterMenuSync.ts).
  // On a SYNCED row only a staff match or an exact auto link (matched_by 'exact') on an ITEM routes
  // an order. Any other automatic link on a synced row (an option's included: options are never
  // auto linked, review round 6) routes nothing, so the card lists it as not matched yet, never
  // as done.
  // items_list also says when an automatic link routes nothing for a reason only the server can
  // tell (auto_idle: a name that is not plain, or a row an earlier sync keyed).
  const untrusted = synced && (menuItemId || optionId)
    && (!(source === 'manual' || (source === 'auto' && matchedBy === 'exact' && kind === 'item'))
      || (source === 'auto' && dbRow.auto_idle === true));

  let state = 'unmatched';
  if ((menuItemId || optionId) && !untrusted) state = 'matched';
  else if (!menuItemId && !optionId && matchedBy === 'ignored') state = 'ignored';

  // A synced SIZE row: one size of an item ezCater sells in several sizes. Like every synced row
  // it is saved by the key the sync gave it (saveBody), never a key rebuilt from its name.
  const ezSizeName = kind === 'item' && synced ? first(dbRow, 'ez_size_name', 'ezSizeName') : null;
  const sizeRow = !!ezSizeName;
  // A single size item's ONE size (ez_only_size): staff see "Turkey Sandwich, sold only as Box"
  // and never match blind. It is part of the row's exact full name.
  const ezOnlySize = kind === 'item' && synced && !sizeRow ? first(dbRow, 'ez_only_size', 'ezOnlySize') : null;

  // LOOK AGAIN: a staff decision made for a different name than this synced row's exact full name
  // (carried over from before the sync). Worked out by ezcater-connect items_list (lookAgainOf in
  // _shared/ezcaterMenuSync.ts). A sync never changes a staff decision; this asks a person to check it.
  const lookAgainRaw = dbRow.look_again !== undefined ? dbRow.look_again : dbRow.lookAgain;
  const lookAgain = lookAgainRaw === true && (state === 'matched' || state === 'ignored');
  const offMenu = !!(opts && opts.syncReady) && !synced;
  const menuAtMs = opts && opts.menuAt ? Date.parse(opts.menuAt) : NaN;
  const syncedMs = syncedAt ? Date.parse(syncedAt) : NaN;
  const gone = synced && Number.isFinite(menuAtMs) && Number.isFinite(syncedMs) && syncedMs < menuAtMs;

  return {
    kind,
    ezKey,
    ezName,
    ezSizeName: sizeRow ? ezSizeName : null,
    sizeRow,
    ezOnlySize,
    ezCategory: first(dbRow, 'ez_category', 'ezCategory'),
    syncedAt,
    synced,
    gone,
    ezGroup: first(dbRow, 'ez_group', 'ezGroup'),
    // The ezCater item a synced option customizes: its match is for that item only.
    ezItemName: kind === 'option' && synced ? first(dbRow, 'ez_item_name', 'ezItemName') : null,
    menuItemId,
    optionId,
    source,
    matchedBy,
    untrusted: !!untrusted,
    lookAgain,
    // What the person saw, readable (an option's decided_as holds its parts apart).
    decidedAs: readableDecidedAs(first(dbRow, 'decided_as', 'decidedAs')) || null,
    offMenu,
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
 * Where a row sorts: unmatched, then matches to look at again, then matched, then silenced, then
 * names ezCater no longer sells (gone), then rows no sync wrote (offMenu).
 */
const rankOf = (r) => {
  if (r && r.offMenu) return 5;
  if (r && r.gone) return 4;
  if (r && r.lookAgain) return 0.5;
  return STATE_ORDER[r && r.state] ?? 3;
};

/**
 * Unmatched first, then matches to look at again, then matched, then the ones
 * a person silenced (names ezCater no longer sells, then rows no sync wrote,
 * once the sync is set up, last). Inside each group, most recently seen first,
 * then most seen, then by name so the list is the same list every time and does
 * not shuffle under the operator's cursor while they work down it.
 */
export function sortRows(rows) {
  return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) => {
    const sa = rankOf(a);
    const sb = rankOf(b);
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
export function rowsFrom(list, opts) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const row = toRow(raw, opts);
    if (row) out.push(row);
  }
  return sortRows(out);
}

/** Only the rows of one kind: the Items tab and the Options tab. */
export function ofKind(rows, kind) {
  const want = kind === 'option' ? 'option' : 'item';
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.kind === want);
}

/**
 * Counts for one tab. `outstanding` is the number the heading reports. A name ezCater no longer
 * sells (gone) is not one of their items any more and never work to do, so it is not counted
 * here at all (goneCount counts it).
 */
export function countRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  let matched = 0;
  let ignored = 0;
  let unmatched = 0;
  for (const r of list) {
    if (!r || r.gone) continue;
    if (r.state === 'matched') matched++;
    else if (r.state === 'ignored') ignored++;
    else unmatched++;
  }
  return { total: matched + ignored + unmatched, matched, ignored, unmatched, outstanding: unmatched };
}

/** How many synced names ezCater no longer sells (gone). */
export function goneCount(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.gone).length;
}

/** The note about names ezCater no longer sells. '' when there are none. */
export function goneLine(n) {
  const c = Number(n) || 0;
  if (!c) return '';
  return c === 1
    ? '1 name ezCater no longer sells is listed last. Its match only reaches a change to an older order.'
    : `${c} names ezCater no longer sells are listed last. Their matches only reach changes to older orders.`;
}

/** The rows orders can use: every row, until the sync is set up; then only synced rows. */
export function liveRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && !r.offMenu);
}

/** Rows no menu sync wrote, once the sync is set up: they can never route an order. */
export function offMenuRows(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.offMenu);
}

/** How many staff decisions to look at again (never a gone name, never a row no sync wrote). */
export function lookAgainCount(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.lookAgain && !r.offMenu && !r.gone).length;
}

/** The plain line under the heading when some matches need a second look. '' when none do. */
export function lookAgainLine(n, kind) {
  const c = Number(n) || 0;
  if (!c) return '';
  const noun = kind === 'option' ? 'option' : 'item';
  return c === 1
    ? `1 ${noun} to check again: its ezCater name is not the one it was matched as.`
    : `${c} ${noun}s to check again: their ezCater names are not the ones they were matched as.`;
}

/** The note on one row to look at again: what the person saw when they matched it. */
export function lookAgainNote(row) {
  if (!row || !row.lookAgain) return '';
  const was = row.decidedAs ? ` It was matched as: ${row.decidedAs}.` : '';
  return `The ezCater name is not the one that was matched.${was} Orders print it by name until you check it.`;
}

/** The note about rows no sync wrote, once the sync is set up. '' when there are none. */
export function offMenuLine(n) {
  const c = Number(n) || 0;
  if (!c) return '';
  return `${c} older ${c === 1 ? 'name is' : 'names are'} from before the menu sync. Orders only use matches made on the synced menu, so ${c === 1 ? 'it is' : 'they are'} kept apart, to read only.`;
}

/**
 * One row saved before the menu sync, read only: its name, and what it was matched to. Kept so
 * staff can see their earlier work (the sync carries each match over to the synced name it was
 * made for, and asks staff to check the rest).
 */
export function olderNote(row, ourItems, ourGroups) {
  if (!row) return '';
  if (row.state === 'matched') return `Matched to ${matchedLabel(row, ourItems, ourGroups)} before the menu sync`;
  if (row.state === 'ignored') return 'Not on our menu, before the menu sync';
  return 'Not matched before the menu sync';
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
  if (!c.total) return `Nothing from ezCater yet. Press Sync ezCater menu to load their ${noun}.`;
  if (n === 0) return `All their ${noun} are matched.`;
  if (n === 1) return `1 of their ${noun} is not matched yet.`;
  return `${n} of their ${noun} are not matched yet.`;
}

/**
 * Their name as the screen shows it: a size row carries its size, and a single size item says
 * the one size it is sold as, so nobody matches "Turkey Sandwich" not knowing it is a Box.
 */
export function theirLabel(row) {
  if (!row) return '';
  if (row.sizeRow && row.ezSizeName) return `${row.ezName} (${row.ezSizeName})`;
  if (row.ezOnlySize) return `${row.ezName}, sold only as ${row.ezOnlySize}`;
  // An option is matched for one item: "Large, on Pizza" is not Large on Salad.
  if (row.kind === 'option' && row.ezItemName) return `${row.ezName}, on ${row.ezItemName}`;
  return row.ezName;
}

/**
 * The line under the Sync button: the last sync, in plain words. `sync` is the
 * ezcater_menu_syncs row items_list returns (null before the first sync).
 */
export function syncLine(sync) {
  if (!sync) return 'Not synced yet.';
  const when = (v) => {
    const t = v ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? new Date(t).toLocaleString() : null;
  };
  if (sync.status === 'running') return 'Syncing now.';
  const ok = when(sync.last_ok_at);
  const last = ok ? `Last synced ${ok}.` : 'Not synced yet.';
  if (sync.status === 'ok' || !sync.error) return last;
  return `${last} The last try did not complete: ${String(sync.error).slice(0, 200)}`;
}

/** The small grey line under a row: how often ezCater has sent it. */
export function seenLine(row) {
  const n = row ? row.seenCount : 0;
  const orders = n === 1 ? 'on 1 order' : `on ${n} orders`;
  // A name ezCater no longer sells: its match only reaches changes to orders placed before.
  if (row && row.gone) return n ? `No longer on their menu, ${orders}` : 'No longer on their menu';
  if (!n) return row && row.synced ? 'On their menu, not ordered yet' : 'Not on an order yet';
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
  // A size row is suggested on its item AND size, so "Caesar Salad" "Half Tray" puts our
  // "Caesar Salad Half" first. Suggestions only: a person still picks.
  // A single size item is suggested on its item and its one size too ("Turkey Sandwich" "Box"
  // puts our "Turkey Sandwich Box" first).
  const theirName = row.sizeRow && row.ezSizeName ? `${row.ezName} ${row.ezSizeName}`
    : (row.ezOnlySize ? `${row.ezName} ${row.ezOnlySize}` : row.ezName);
  return suggestMatches({ name: theirName }, ourItems, { limit }).map((s) => ({
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

  const c = choice || {};
  const ignored = c.ignored === true;
  const menuItemId = ignored ? null : str(c.menuItemId);
  const optionId = ignored ? null : str(c.optionId);

  if (kind === 'item' && optionId) return { error: 'an item cannot be matched to an option' };
  if (kind === 'option' && !ignored && menuItemId && !optionId) {
    return { error: 'an option needs one of our options, not an item' };
  }

  // A SYNCED row (after 20260919m) is saved by the key the sync gave it: its exact full name.
  // The edge function only ever UPDATES such a row, so this can decide a row but never invent
  // one. It also sends back what this screen showed (the name, and the size), which the edge
  // function records as decided_as.
  if (row.synced) {
    return {
      body: {
        synced: true,
        kind,
        ez_key: row.ezKey,
        ez_name: row.ezName,
        ez_group: kind === 'option' ? (row.ezGroup || null) : null,
        menu_item_id: menuItemId,
        option_id: optionId,
        ignored,
        seen_size: kind === 'item' ? (row.ezSizeName || row.ezOnlySize || null) : null,
        // The item this screen showed the option on: part of what the match was made for.
        seen_item: kind === 'option' ? (row.ezItemName || null) : null,
      },
    };
  }

  const line = kind === 'option'
    ? { name: row.ezName, groupLabel: row.ezGroup || '' }
    : { name: row.ezName };
  const ezKey = buildLinkKey(line, kind);
  if (!ezKey) return { error: 'that name cannot be matched' };

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
      // A save is a person looking at it now: nothing left to check.
      lookAgain: false,
      untrusted: false,
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
