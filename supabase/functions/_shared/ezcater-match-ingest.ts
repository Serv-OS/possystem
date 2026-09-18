// supabase/functions/_shared/ezcater-match-ingest.ts
//
// WIRING THE MATCHER INTO INGEST.
//
// supabase/functions/_shared/ezcaterMatch.ts holds the RULES (what counts as a
// match). This file holds the JOB: read the venue's saved links and its menu,
// run those rules over one order's lines, fill in itemId, save what we learned,
// and hand back a row the webhook can upsert.
//
// WHY THIS EXISTS
// ezCater gave us the Orders API but not the Menus API, so the venue builds its
// ezCater menu by hand in the Partner Portal and the order lines arrive with
// posItemId = null. itemId is what KDS station routing, 86, stock depletion and
// product reporting all key on, so without this an ezCater order is a plain text
// ticket: no station, no stock, no product mix.
//
// ════════════════════════════════════════════════════════════════════════════
//  THE ONE RULE THAT OUTRANKS EVERY OTHER RULE IN THIS FILE
// ════════════════════════════════════════════════════════════════════════════
//
//  NO ORDER IS EVER REFUSED, DELAYED OR CHANGED BECAUSE MATCHING FAILED.
//
//  A missing ezcater_item_links table (the migration is run by hand, so there
//  WILL be a window where it does not exist), a failed read, a failed write, a
//  malformed row, anything: every path here swallows it, logs it, and returns
//  the row exactly as the mapper built it, with itemId left null. That is
//  today's behaviour, and today's behaviour is a working ticket.
//
//  Every exported impure function below is written so it cannot throw. The
//  webhook still wraps the call, because two guards cost nothing and a catering
//  order that never reaches the kitchen costs a customer.
// ════════════════════════════════════════════════════════════════════════════
//
// WHAT IT WRITES
//   EVERY name ezCater sends gets a row: the key, their spelling, their group,
//   how many lines have used it and when it was last seen. A row with NO target
//   is the normal first state and is what Back Office, Channels, 3rd Party
//   orders, "Item matching" lists for a person to answer. Without these rows
//   that screen has nothing to show.
//
// WHAT IT NEVER DOES
//   * it never OVERWRITES a decision. A person's match, a person's "Not on our
//     menu", or a target we filled in earlier, is never clobbered by an order
//     arriving. Ingest inserts rows that are absent (on conflict do nothing),
//     bumps counters on rows it saw, and fills the target in on a row that is
//     still a bare sighting: no target, nobody has touched it, source 'auto'.
//   * it never writes a link for a posItemId, or for one of our item codes.
//     Either already names our item, so a row would add nothing and would only
//     go stale.
//   * it never writes a link for a name it could not normalise. An empty key
//     would collapse every unnamed line onto one row and point them all at one
//     product. The migration has a check constraint as the backstop.
//   * it never guesses between two equally good matches. autoLinkDecision
//     suggests instead, and the line stays unmatched until a person picks.

import {
  applyLinks, autoLinkDecision, buildLinkKey, findLink, indexItemCodes, indexLinks, linkKeyCandidates, normaliseKeyName,
} from './ezcaterMatch.ts';
// The ezMatch stamp lives with the rest of the customer jsonb shape, in the
// mapper, not here.
import { withMatchedItems } from './ezcater-map.ts';

// ────────────────────────────────────────────────────────────────────────────
// Limits. All of them are about one pathological order, not about normal use.
// ────────────────────────────────────────────────────────────────────────────

/** PostgREST caps a select at 1000 rows, so the menu is read in pages. */
export const MENU_PAGE_SIZE = 1000;
/** Pages per table. 5000 menu items at one venue is already beyond belief. */
export const MENU_MAX_PAGES = 5;
/** New link rows written from one order. A 300 line catering order is real. */
export const MAX_LINK_WRITES = 200;
/** seen_count updates issued for one order. Counters, never routing. */
export const MAX_LINK_BUMPS = 200;
/**
 * How long the whole matching job may take before the order goes without it.
 *
 * Matching is best effort and the ORDER ALWAYS WINS. A slow menu read on a big
 * venue, or a Postgres that is thinking about something else, must never hold
 * up the order_queue write: past this the webhook gets the mapper's own row
 * back, the ticket prints as plain text exactly as it does today, and the next
 * order matches normally.
 */
export const MATCH_BUDGET_MS = 4000;

// ────────────────────────────────────────────────────────────────────────────
// Reading our menu into the shape the matcher wants
// ────────────────────────────────────────────────────────────────────────────

const text = (v: unknown): string => (v == null ? '' : String(v).trim());

/**
 * A menu_items row's price, for the small price BONUS in scoreMatch and nothing
 * else. Price never gates a match here (ezCater sends a line total that already
 * includes its paid modifiers, and US catering prices are their own anyway), so
 * the simple base price is enough and a missing one is not a problem.
 */
function basePrice(pricing: any): number | null {
  const p = pricing || {};
  if (p.base != null && Number.isFinite(Number(p.base))) return Number(p.base);
  if (p.price != null && Number.isFinite(Number(p.price))) return Number(p.price);
  return null;
}

/**
 * menu_items rows (snake_case, straight off the table) to the camelCase shape
 * scoreMatch reads: { id, name, menuName, price, itemCode }.
 *
 * ARCHIVED IS FILTERED HERE, NOT IN THE QUERY. `archived` is nullable, and in
 * Postgres `archived = false` and `archived <> true` both drop a NULL row, so a
 * server side filter would silently hide every item written before the column
 * had a default. Reading the flag and testing it in JS keeps those items.
 *
 * itemCode is null on every row until 20260917_OPS_menu_item_code.sql is run by
 * hand, and null for every product nobody gave a code to. Both are ordinary.
 */
export function menuItemsForMatch(rows: any): any[] {
  const out: any[] = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || r.archived === true) continue;
    const id = text(r.id);
    if (!id) continue;
    out.push({
      id,
      name: text(r.name),
      menuName: text(r.menu_name) || null,
      price: basePrice(r.pricing),
      itemCode: text(r.item_code) || null,
    });
  }
  return out;
}

/**
 * modifier_groups rows to the shape matchOptions reads:
 * { id, name, options: [{ id, name, itemId, price }] }.
 *
 * An option with no id is dropped: flattenOptions cannot address it, and a link
 * row pointing at nothing routes nothing.
 */
export function modifierGroupsForMatch(rows: any): any[] {
  const out: any[] = [];
  for (const g of Array.isArray(rows) ? rows : []) {
    if (!g) continue;
    const groupId = text(g.id);
    if (!groupId) continue;
    const options: any[] = [];
    for (const o of Array.isArray(g.options) ? g.options : []) {
      if (!o) continue;
      const optionId = text(o.id);
      if (!optionId) continue;
      const linked = o.itemId != null ? o.itemId : o.item_id;
      options.push({
        id: optionId,
        name: text(o.name) || text(o.label),
        itemId: linked != null && text(linked) ? text(linked) : null,
        price: Number.isFinite(Number(o.price)) ? Number(o.price) : null,
      });
    }
    if (!options.length) continue;
    out.push({ id: groupId, name: text(g.name), options });
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// The plan. PURE: a function of its arguments, testable without a database.
// ────────────────────────────────────────────────────────────────────────────

/** Their side's verbatim text. A line calls it name, a customization label. */
const rawName = (line: any): string => {
  if (typeof line === 'string') return line.trim();
  const l = line || {};
  return text(l.name) || text(l.label);
};

const rawGroup = (line: any): string => {
  const l = line || {};
  return text(l.groupLabel) || text(l.customizationTypeName);
};

// ────────────────────────────────────────────────────────────────────────────
// ezCater's own ids, from "Sync ezCater menu" (18 Sep 2026)
// ────────────────────────────────────────────────────────────────────────────
//
// A synced row carries ez_ids: the PUBLISHED ids ezCater's menu has for it right
// now (a size id for an item, a customization value id for an option). An order
// line's menuItemSizeId and a customization's customizationId are published ids,
// so a line whose id is on a synced row LANDS ON THAT ROW, whatever the name
// rules would have said. Published ids change on every republish, so an id we
// have never seen means ezCater republished: the caller re-syncs, and the line
// meanwhile falls back to name matching exactly as before.

/**
 * 'kind:publishedId' -> the key of the row that holds it. PURE.
 *
 * Current published ids (ez_ids) first, then the ids a row held on earlier versions of ezCater's
 * menu (ez_prior_ids, review round 4): an order placed on the previous version still lands on its
 * size after a republish. Published ids are regenerated, never reused, so a current id always
 * wins a clash.
 */
export function indexLinkIds(links: any): Map<string, string> {
  const out = new Map<string, string>();
  const list = Array.isArray(links) ? links : [];
  const pass = (snake: string, camel: string) => {
    for (const row of list) {
      if (!row) continue;
      const kind = text(row.kind) || 'item';
      const key = text(row.ez_key) || text(row.ezKey);
      const ids = Array.isArray(row[snake]) ? row[snake] : (Array.isArray(row[camel]) ? row[camel] : []);
      if (!key) continue;
      for (const id of ids) {
        const v = text(id);
        if (v && !out.has(kind + ':' + v)) out.set(kind + ':' + v, key);
      }
    }
  };
  pass('ez_ids', 'ezIds');
  pass('ez_prior_ids', 'ezPriorIds');
  return out;
}

/** True once the venue's menu has been synced at least once (some row carries ezCater ids). */
export function hasSyncedMenu(links: any): boolean {
  return hasSyncedKind(links, 'item') || hasSyncedKind(links, 'option');
}

/**
 * True once some row of this KIND carries ezCater ids. Items and options are asked separately:
 * when a menu's option values could not be read (a schema without a readable value level), the
 * items are synced and the options are not, and every customizationId on every order would
 * otherwise look "unseen" and ask for a re-sync that can never find it (review round 4). PURE.
 */
export function hasSyncedKind(links: any, kind: 'item' | 'option'): boolean {
  return (Array.isArray(links) ? links : []).some((r) => {
    if (!r || (text(r.kind) || 'item') !== kind) return false;
    const ids = Array.isArray(r.ez_ids) ? r.ez_ids : r.ezIds;
    const prior = Array.isArray(r.ez_prior_ids) ? r.ez_prior_ids : r.ezPriorIds;
    return (Array.isArray(ids) && ids.length > 0) || (Array.isArray(prior) && prior.length > 0);
  });
}

/**
 * The published ids on these lines that no synced row holds: the sign ezCater republished the
 * menu since our last sync. Per kind, empty until that kind has synced once, because before that
 * every id is unseen and none of them means anything. PURE.
 */
export function unseenMenuIds(lines: any[], links: any, max = 20): string[] {
  const items = hasSyncedKind(links, 'item');
  const options = hasSyncedKind(links, 'option');
  if (!items && !options) return [];
  const ids = indexLinkIds(links);
  const out: string[] = [];
  const add = (kind: string, id: unknown) => {
    const v = text(id);
    if (v && !ids.has(kind + ':' + v) && !out.includes(v) && out.length < max) out.push(v);
  };
  for (const l of Array.isArray(lines) ? lines : []) {
    if (!l) continue;
    if (items) add('item', l.ezSizeId);
    if (options) for (const m of Array.isArray(l.mods) ? l.mods : []) add('option', m && m.ezItemId);
  }
  return out;
}

/** '#' separates an item's name key from its size on a size row. Mirrors SIZE_KEY_SEP. */
const SIZE_SEP = '#';
/** A row for ONE size of an item with several sizes on ezCater. */
export const isSizeRowKey = (key: unknown): boolean => text(key).includes(SIZE_SEP);

/**
 * A size's part of a size row key: its key form, else a plain fold (a size can be only noise).
 * Lives here (not in ezcaterMenuSync.ts, which re-exports it) so an order line can find its size
 * row by name and size with exactly the rule the sync wrote it under.
 */
export function sizeKeyPart(size: unknown): string {
  const k = normaliseKeyName(size);
  if (k) return k;
  return String(size == null ? '' : size).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * matched_by on a row a person CLEARED with the screen from this deploy on (review round 5).
 * Rows cleared BEFORE this deploy were written as source 'manual', no target, matched_by null,
 * and orders still auto linked them by exact name; they keep doing exactly that. Only a clear
 * recorded with this mark is a permanent no.
 */
export const CLEARED_MARK = 'cleared';

/**
 * A person's "no": a row staff saved with no target AND marked it: a clear made after this deploy
 * (matched_by 'cleared'), or Not on our menu (matched_by 'ignored'). Nothing automatic matches
 * over it. An old unmarked clear is not a no (review round 5: yesterday's routing keeps working).
 */
export const personSaidNo = (link: any): boolean => {
  if (!link || text(link.source) !== 'manual' || text(link.menuItemId) || text(link.optionId)) return false;
  const by = text(link.matchedBy != null ? link.matchedBy : link.matched_by);
  return by === CLEARED_MARK || by === 'ignored';
};

/** The raw link rows, whatever shape they came in (array, Map or object keyed by ez_key). */
function linkRowsOf(links: any): any[] {
  if (Array.isArray(links)) return links.filter(Boolean);
  const out: any[] = [];
  if (links instanceof Map) { for (const [k, r] of links) if (r) out.push({ ez_key: k, ...r }); return out; }
  if (links && typeof links === 'object') for (const k of Object.keys(links)) if (links[k]) out.push({ ez_key: k, ...links[k] });
  return out;
}

/**
 * indexLinks, plus each row's matched_by (as matchedBy), which personSaidNo needs to tell a
 * marked clear from an old one. PURE.
 */
export function indexLinksWithMarks(links: any): Map<string, any> {
  const idx = indexLinks(links);
  for (const r of linkRowsOf(links)) {
    const key = text(r.ez_key) || text(r.ezKey);
    const hit = key ? idx.get((text(r.kind) || 'item') + ':' + key) : null;
    if (hit) hit.matchedBy = text(r.matched_by != null ? r.matched_by : r.matchedBy) || null;
  }
  return idx;
}

/**
 * The item name keys that have a size row still ON ezCater's menu (current published ids, or no
 * id column read at all, which can only mean the row came from a sync). An order line WITH a
 * size for such an item is decided by its size row, never by the item's name only row. PURE.
 */
export function liveSizedNames(links: any): Set<string> {
  const out = new Set<string>();
  for (const r of linkRowsOf(links)) {
    if ((text(r.kind) || 'item') !== 'item') continue;
    const key = text(r.ez_key) || text(r.ezKey);
    const cut = key.indexOf(SIZE_SEP);
    if (cut <= 0) continue;
    const ids = Array.isArray(r.ez_ids) ? r.ez_ids : r.ezIds;
    if (Array.isArray(ids) && !ids.length) continue;
    out.add(key.slice(0, cut));
  }
  return out;
}

/** True when an order line names a size: ezCater's size id or its size name. */
export const lineHasSize = (line: any): boolean => !!text(line?.ezSizeId) || !!text(line?.sizeName);

/**
 * Which decision a line gets when its published id landed on a synced row whose key the NAME
 * rules would not have found (a size of an item with several sizes, or a renamed item).
 *
 *   * our item code on their line is certain, and wins, exactly as today;
 *   * a SIZE ROW decides a sized line on its own (review round 4). An old name only row for a
 *     multi size item ("soup" matched to our Soup Small before the sync) must never decide a
 *     line whose id says Large, whoever saved that old row. No valid target on the size row
 *     means the line is not matched and prints by name, never a guess at the size;
 *   * a person's "no" on the synced row (cleared, Not on our menu) means not matched;
 *   * otherwise a PERSON's decision beats an automatic one: the synced row's manual match
 *     first, then a manual match the name rules found; then the synced row's automatic match;
 *     then whatever the name rules decided, which is exactly today's behaviour.
 *
 * A synced target that is no longer on our menu is never used. PURE.
 */
export function decideWithSyncedRow(d: any, link: any, kind: 'item' | 'option', ourIds: Set<string>): any {
  if (d && d.action === 'linked' && d.source === 'itemCode') return d;
  const target = kind === 'item' ? text(link?.menuItemId) : text(link?.optionId);
  const valid = !!target && (!ourIds.size || ourIds.has(target));
  const fromLink = () => ({
    action: 'linked',
    itemId: link.menuItemId != null && text(link.menuItemId) ? text(link.menuItemId) : null,
    optionId: kind === 'option' ? target : null,
    reason: 'on the ezCater menu we synced',
    source: text(link.source) || 'auto',
  });
  if (kind === 'item' && isSizeRowKey(link?.ezKey)) {
    return valid ? fromLink() : { action: 'none', reason: 'this ezCater size is not matched yet' };
  }
  if (personSaidNo(link)) return { action: 'none', reason: 'a person cleared this match' };
  if (valid && text(link.source) === 'manual') return fromLink();
  if (d && d.action === 'linked' && d.source === 'manual') return d;
  if (valid) return fromLink();
  return d;
}

/** seen_count as it stands on the rows we read, keyed 'kind:ez_key'. */
export function linkSeenCounts(links: any): Map<string, number> {
  const out = new Map<string, number>();
  const add = (row: any, fallbackKey: string | null) => {
    if (!row) return;
    const kind = text(row.kind) || 'item';
    const key = text(row.ez_key) || text(row.ezKey) || text(fallbackKey);
    if (!key) return;
    const n = Number(row.seen_count != null ? row.seen_count : row.seenCount);
    out.set(kind + ':' + key, Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
  };
  if (Array.isArray(links)) for (const row of links) add(row, null);
  else if (links instanceof Map) for (const [k, row] of links) add(row, k);
  else if (links && typeof links === 'object') for (const k of Object.keys(links)) add(links[k], k);
  return out;
}

export interface MatchPlan {
  /** The lines to write to order_queue.items, itemId filled in where known. */
  lines: any[];
  /** ezcater_item_links rows to INSERT (never update). snake_case, DB ready. */
  writes: any[];
  /** Existing rows this order used: { kind, ezKey, times, seenCount }. */
  bumps: { kind: string; ezKey: string; times: number; seenCount: number }[];
  /**
   * Bare sightings we can now answer: a row already on the table with no target
   * that nobody has touched, and an auto match for it today. Applied with a
   * where clause that re-checks all of that, so a person saving at the same
   * moment always wins.
   */
  upgrades: { kind: string; ezKey: string; menuItemId: string | null; optionId: string | null }[];
  /**
   * Published ezCater ids on this order that no synced row holds (see unseenMenuIds). Non empty
   * means ezCater republished the menu since our last sync, so the caller re-syncs it.
   */
  unseen: string[];
}

/**
 * Decide every line and every modifier on one order.
 *
 * Two passes, and the second one only runs when we actually hold the menu:
 *
 *   1. applyLinks: the venue's saved links, plus today's posItemId behaviour.
 *      This alone is the answer when the menu could not be read, because it is
 *      the one that never makes things worse than they are now.
 *
 *   2. autoLinkDecision, with the menu in hand, is then the single authority.
 *      Its rule order is the same (saved link beats posItemId beats one exact
 *      name), and it additionally checks both against the real menu: a link
 *      whose item is gone is not reused, and a posItemId naming nothing of ours
 *      is not trusted.
 *
 * A PARTLY READ MENU IS NOT A MENU. menuOk false means a page of menu_items or
 * modifier_groups failed, or the read was cut short at MENU_MAX_PAGES. What we
 * hold is then a piece of the venue's menu, and "no item of ours has that name"
 * is a claim we cannot make from a piece: it would auto link the wrong product
 * or, worse, write that wrong link down for every later order. So the saved
 * links are the whole answer and nothing is written at all.
 *
 * nowIso is an ARGUMENT, not a clock read, so the same input always gives the
 * same output and the tests can pin it.
 */
export function planLineMatches(input: {
  lines: any[];
  ourItems?: any[];
  ourGroups?: any[];
  links?: any;
  locationId: string;
  nowIso: string;
  /** false when what we hold is only part of the menu. Default true. */
  menuOk?: boolean;
}): MatchPlan {
  const lines = Array.isArray(input.lines) ? input.lines : [];
  const ourItems = Array.isArray(input.ourItems) ? input.ourItems : [];
  const ourGroups = Array.isArray(input.ourGroups) ? input.ourGroups : [];
  const links = input.links || [];
  const locationId = text(input.locationId);
  const nowIso = text(input.nowIso) || new Date(0).toISOString();
  const menuOk = input.menuOk !== false;

  // Our item codes, from whatever menu we hold.
  //
  // A PARTLY READ MENU IS STILL SAFE FOR CODES, and it is the one thing here
  // that is. Every other rule can be wrong on half a menu ("nothing of ours has
  // that name" is a claim about the half we did not read). A code either names a
  // row we are holding, which is certain, or it names nothing, which changes
  // nothing. So codes are used even when menuOk is false.
  const codes = indexItemCodes(ourItems);

  // Pass 1. Also the whole answer when there is no menu to check against, or
  // when what we read of it is only part.
  const applied = applyLinks(lines, links, codes);
  const haveItems = ourItems.length > 0;
  const haveGroups = ourGroups.length > 0;
  const idx = indexLinksWithMarks(links);
  const byId = indexLinkIds(links);
  const unseen = unseenMenuIds(lines, links);
  const sizedNames = liveSizedNames(links);

  /**
   * The synced row a line's published id lands on, when the NAME rules would not have found that
   * row themselves (a size of an item with several sizes, a renamed item). null otherwise, and
   * then the line goes exactly the way it always did.
   */
  const syncedRowFor = (src: any, kind: 'item' | 'option'): { key: string; link: any } | null => {
    const id = text(kind === 'item' ? src?.ezSizeId : src?.ezItemId);
    if (!id) return null;
    const key = byId.get(kind + ':' + id);
    if (!key) return null;
    if (linkKeyCandidates(src, kind).includes(key)) return null;
    const link = idx.get(kind + ':' + key);
    return link ? { key, link } : null;
  };

  /**
   * THE SIZE ROW A SIZED LINE IS DECIDED BY (review round 5). A line that names a size (ezSizeId
   * or sizeName) of an item that HAS size rows ('soup#small', 'soup#large') is never decided by
   * the item's name only row ('soup', perhaps a staff match to our Soup Small from before the
   * sync). Its published id finds the size row; an id we do not know yet (the first order after
   * every ezCater republish) finds it by name and size; when neither does, the line stays
   * unmatched and prints by name until the re-sync, never the wrong size.
   *
   *   { key, link }       the size row that decides the line
   *   { key: '', link: null }  the item has size rows but this line's size is not one we hold
   *   null                the item has no size rows (or the line names no size): the name rules
   *                       decide, exactly as before
   */
  const sizeRowFor = (src: any): { key: string; link: any } | null => {
    if (!lineHasSize(src)) return null;
    const id = text(src?.ezSizeId);
    const byIdKey = id ? byId.get('item:' + id) : null;
    const byIdLink = byIdKey ? idx.get('item:' + byIdKey) : null;
    if (byIdKey && byIdLink) return isSizeRowKey(byIdKey) ? { key: byIdKey, link: byIdLink } : null;
    const base = linkKeyCandidates(src, 'item').find((k) => sizedNames.has(k));
    if (!base) return null;
    const part = sizeKeyPart(src?.sizeName);
    const key = part ? base + SIZE_SEP + part : '';
    const link = key ? idx.get('item:' + key) : null;
    return link ? { key, link } : { key: '', link: null };
  };

  /** What a size row says for a line when there is no menu to check its target against. */
  const fromSizeRowOnly = (sized: { key: string; link: any }) => {
    const id = sized.link ? (text(sized.link.menuItemId) || null) : null;
    return { itemId: id, source: id ? (text(sized.link.source) || 'auto') : null };
  };

  if (!locationId || !menuOk || (!haveItems && !haveGroups)) {
    // Saved links only. A synced row a line's id lands on still counts, when it has a target and
    // the name pass found nothing: it is a saved decision like any other.
    const withIds = applied.map((appliedLine: any, i: number) => {
      const src = lines[i] || {};
      let out = appliedLine;
      const sized = sizeRowFor(src);
      const hit = sized ? null : syncedRowFor(src, 'item');
      const certain = appliedLine.match && (appliedLine.match.source === 'itemCode' || appliedLine.match.source === 'posItemId');
      if (sized && !certain) {
        // A size row decides a sized line on its own, even here: never the old name only row.
        const r = fromSizeRowOnly(sized);
        out = { ...out, itemId: r.itemId, match: { matched: !!r.itemId, source: r.source } };
      } else if (hit && !appliedLine.itemId && text(hit.link.menuItemId)) {
        out = { ...out, itemId: text(hit.link.menuItemId), match: { matched: true, source: hit.link.source || 'auto' } };
      }
      // Stamped so a later re-ask knows how this line was decided (carryMatchedItems).
      out = { ...out, match: { ...(out.match || { matched: !!out.itemId, source: null }), sizeKey: sized ? sized.key : null } };
      const srcMods = Array.isArray(src.mods) ? src.mods : [];
      const mods = (Array.isArray(out.mods) ? out.mods : []).map((m: any, j: number) => {
        const mh = syncedRowFor(srcMods[j] || {}, 'option');
        if (!mh || m.itemId || m.optionId || !(text(mh.link.optionId) || text(mh.link.menuItemId))) return m;
        return {
          ...m,
          itemId: text(mh.link.menuItemId) || null,
          optionId: text(mh.link.optionId) || null,
          match: { matched: true, source: mh.link.source || 'auto' },
        };
      });
      return { ...out, mods };
    });
    return { lines: withIds, writes: [], bumps: [], upgrades: [], unseen };
  }

  const ourItemIds = new Set<string>(ourItems.map((it: any) => text(it.id)).filter(Boolean));
  const ourOptionIds = new Set<string>();
  for (const g of ourGroups) for (const o of Array.isArray(g?.options) ? g.options : []) if (o && text(o.id)) ourOptionIds.add(text(o.id));
  const counts = linkSeenCounts(links);
  const times = new Map<string, number>();          // existing rows: how many lines used them
  const fresh = new Map<string, any>();             // rows to insert, deduped by key
  const fill = new Map<string, any>();              // bare sightings we can answer

  const sawExisting = (kind: string, key: string) => {
    const k = kind + ':' + key;
    times.set(k, (times.get(k) || 0) + 1);
  };

  const sawFresh = (kind: string, key: string, row: any) => {
    const k = kind + ':' + key;
    const prev = fresh.get(k);
    if (prev) { prev.seen_count += 1; return; }
    fresh.set(k, { ...row, seen_count: 1 });
  };

  /** A row that is still only a sighting: no target, and nobody has touched it. */
  const isBareSighting = (link: any) =>
    !!link && !link.menuItemId && !link.optionId && String(link.source || '') === 'auto';

  /**
   * A person cleared this name, or said it is Not on our menu: an automatic name match must not
   * put it back, on an order any more than on a sync (review round 4). The line prints by name.
   * Our item code on their line is certain and still wins.
   */
  const noOverPersonsNo = (d: any, src: any, kind: 'item' | 'option') => {
    if (!d || d.action !== 'linked' || d.source !== 'auto') return d;
    const hit = findLink(idx, src, kind);
    return hit && personSaidNo(hit.link) ? { action: 'none', reason: 'a person cleared this match' } : d;
  };

  // One key, one decision, one bookkeeping entry. kind switches which arm of
  // autoLinkDecision runs and which id column a new row fills.
  const record = (kind: 'item' | 'option', src: any, d: any) => {
    const key = buildLinkKey(src, kind);
    if (!key) return;                               // unnameable: never written
    const name = rawName(src);
    if (!name) return;                              // backstop for the check constraint

    // ezCater already carried our id, or our item code, on this line: there is
    // nothing for a person to decide and a row would only go stale. Today's
    // rule, kept, and now it covers the code the venue typed themselves.
    if (d.action === 'linked' && (d.source === 'posItemId' || d.source === 'itemCode')) return;

    // A target only when we are confident on our own: one exact name of ours,
    // no size clash, nothing else exact. Otherwise the row is a sighting and
    // the Back Office screen asks a person.
    const linked = d.action === 'linked' && d.source === 'auto';
    const menuItemId = linked && d.itemId != null ? String(d.itemId) : null;
    const optionId = linked && kind === 'option' && d.optionId != null ? String(d.optionId) : null;

    const hit = findLink(idx, src, kind);
    if (hit) {
      sawExisting(kind, hit.key);
      // The row was written the first time we saw this name, before the venue
      // had the product. Now we can answer it, so fill it in rather than leave
      // the screen asking forever about something we match on every order.
      if ((menuItemId || optionId) && isBareSighting(hit.link)) {
        fill.set(kind + ':' + hit.key, { kind, ezKey: hit.key, menuItemId, optionId });
      }
      return;
    }

    const group = kind === 'option' ? rawGroup(src) : '';
    sawFresh(kind, key, {
      location_id: locationId,
      kind,
      ez_key: key,
      ez_name: name,
      ez_group: group || null,
      menu_item_id: menuItemId,
      option_id: optionId,
      source: 'auto',
      // null is "seen, nobody has decided yet", which is what the screen lists.
      matched_by: (menuItemId || optionId) ? 'name' : null,
      last_seen_at: nowIso,
      updated_at: nowIso,
    });
  };

  const outLines = applied.map((appliedLine: any, i: number) => {
    const src = lines[i] || {};
    let itemId = appliedLine.itemId != null ? String(appliedLine.itemId) : null;
    let source = appliedLine.match ? appliedLine.match.source : null;
    const sized = sizeRowFor(src);

    if (haveItems) {
      // codes is passed in rather than rebuilt per line: one index for the
      // whole order, and the option arm cannot build one at all.
      let d = noOverPersonsNo(autoLinkDecision(src, ourItems, links, { kind: 'item', itemCodes: codes }), src, 'item');
      const synced = sized ? null : syncedRowFor(src, 'item');
      if (sized) {
        // A sized line of an item with size rows (review round 5): its size row decides, or
        // nothing does. No name only sighting is written or filled beside it.
        if (sized.link) {
          d = decideWithSyncedRow(d, sized.link, 'item', ourItemIds);
          sawExisting('item', sized.key);
        } else if (!(d && d.action === 'linked' && d.source === 'itemCode')) {
          d = { action: 'none', reason: 'this ezCater size is not synced yet' };
        }
      } else if (synced) {
        // The line's published id is on a synced row the name would not find. That row is the
        // one this line is counted on; no name only sighting is written beside it.
        d = decideWithSyncedRow(d, synced.link, 'item', ourItemIds);
        sawExisting('item', synced.key);
      } else if (!d.stale) {
        // A stale link (its item is gone, or archived today) is left completely
        // alone: not reused, not rewritten, not counted. Overwriting it would
        // throw away a person's decision the week a venue archives an item.
        record('item', src, d);
      }
      itemId = d.action === 'linked' && d.itemId != null ? String(d.itemId) : null;
      source = d.action === 'linked' ? (d.source || null) : null;
    } else if (sized && source !== 'itemCode' && source !== 'posItemId') {
      // Only our modifier groups were read: the size row still decides a sized line.
      const r = fromSizeRowOnly(sized);
      itemId = r.itemId;
      source = r.source;
    }

    const srcMods = Array.isArray(src.mods) ? src.mods : [];
    const mods = (Array.isArray(appliedLine.mods) ? appliedLine.mods : []).map((appliedMod: any, j: number) => {
      if (!haveGroups) return appliedMod;
      const srcMod = srcMods[j] || {};
      let d = noOverPersonsNo(autoLinkDecision(srcMod, ourGroups, links, { kind: 'option', itemCodes: codes }), srcMod, 'option');
      const synced = syncedRowFor(srcMod, 'option');
      if (synced) {
        d = decideWithSyncedRow(d, synced.link, 'option', ourOptionIds);
        sawExisting('option', synced.key);
      } else if (!d.stale) {
        record('option', srcMod, d);
      }
      // The option arm has no plain posItemId rule of its own (an id there that
      // is not one of our codes is not checked against our menu), so when it
      // cannot link, pass 1 stays the authority and whatever the line already
      // carried is kept. That is the one place options differ from lines, where
      // an id naming nothing of ours is dropped.
      if (d.action !== 'linked') return appliedMod;
      const mItemId = d.itemId != null ? String(d.itemId) : null;
      const mOptionId = d.optionId != null ? String(d.optionId) : null;
      return {
        ...appliedMod,
        itemId: mItemId,
        optionId: mOptionId,
        match: { matched: !!(mOptionId || mItemId), source: d.source || null },
      };
    });

    // sizeKey: the size row that decided this line ('' when the item has size rows but none for
    // this size, null when the name rules decided). A re-ask reads it (carryMatchedItems).
    return { ...appliedLine, itemId, mods, match: { matched: !!itemId, source, sizeKey: sized ? sized.key : null } };
  });

  const writes = Array.from(fresh.values()).slice(0, MAX_LINK_WRITES);
  const bumps = Array.from(times.entries()).slice(0, MAX_LINK_BUMPS).map(([k, n]) => {
    const cut = k.indexOf(':');
    const kind = k.slice(0, cut);
    const ezKey = k.slice(cut + 1);
    return { kind, ezKey, times: n, seenCount: (counts.get(k) || 0) + n };
  });
  const upgrades = Array.from(fill.values()).slice(0, MAX_LINK_BUMPS);

  return { lines: outLines, writes, bumps, upgrades, unseen };
}

// ────────────────────────────────────────────────────────────────────────────
// The database side. None of these throw. Ever.
// ────────────────────────────────────────────────────────────────────────────

export interface MatchInputs {
  links: any[];
  ourItems: any[];
  ourGroups: any[];
  /** false when the links table could not be read, so nothing may be written. */
  linksOk: boolean;
  /**
   * true only when we hold the WHOLE menu: every page of menu_items AND of
   * modifier_groups read, and neither cut short. false means saved links are
   * the whole answer and no new link may be written.
   */
  menuOk: boolean;
}

/** True once the budget is spent. No deadline means never. */
export function outOfTime(deadline?: number | null, nowMs?: number): boolean {
  if (deadline == null || !Number.isFinite(deadline)) return false;
  const now = Number.isFinite(nowMs as number) ? (nowMs as number) : Date.now();
  return now >= (deadline as number);
}

/**
 * Page through a table so a menu over 1000 rows is not silently truncated.
 *
 * `complete` is the one that matters to the caller: false means a page failed,
 * the budget ran out, or the read hit MENU_MAX_PAGES with a full page in hand,
 * so what came back is PART of the menu and cannot be reasoned about as if it
 * were all of it.
 */
async function readPaged(
  run: (from: number, to: number) => any,
  deadline?: number | null,
): Promise<{ rows: any[]; ok: boolean; complete: boolean; error: any }> {
  const rows: any[] = [];
  for (let page = 0; page < MENU_MAX_PAGES; page++) {
    if (outOfTime(deadline)) return { rows, ok: true, complete: false, error: null };
    const from = page * MENU_PAGE_SIZE;
    const { data, error } = await run(from, from + MENU_PAGE_SIZE - 1);
    if (error) return { rows, ok: false, complete: false, error };
    const batch = Array.isArray(data) ? data : [];
    rows.push(...batch);
    if (batch.length < MENU_PAGE_SIZE) return { rows, ok: true, complete: true, error: null };
  }
  return { rows, ok: true, complete: false, error: null };
}

// ────────────────────────────────────────────────────────────────────────────
// The venue's link rows, ALL of them
// ────────────────────────────────────────────────────────────────────────────

/** Link columns every version of the table has (20260917_OPS_ezcater_item_links.sql). */
export const LINK_COLUMNS = 'kind, ez_key, ez_name, ez_group, menu_item_id, option_id, source, matched_by, seen_count, last_seen_at';
/** Plus the columns "Sync ezCater menu" adds (20260918_OPS_ezcater_menu_sync.sql). */
export const LINK_COLUMNS_SYNC = LINK_COLUMNS + ', ez_ids, ez_prior_ids, ez_original_ids, ez_size_name, ez_category, ez_menu, synced_at';
/**
 * The sync columns of the FIRST version of 20260918_OPS_ezcater_menu_sync.sql, which had no
 * ez_prior_ids (review round 5). A database that ran only that version still has synced size
 * rows, and they must keep deciding sized lines, so ez_ids is read even when ez_prior_ids is not
 * there yet.
 */
export const LINK_COLUMNS_IDS = LINK_COLUMNS + ', ez_ids, ez_original_ids, ez_size_name, ez_category, ez_menu, synced_at';
/** Rows per page. PostgREST answers at most 1000 rows to one select. */
export const LINK_PAGE_SIZE = 1000;
/** Pages. 50,000 names at one venue is far past any real menu. */
export const LINK_MAX_PAGES = 50;

/** A read that failed because a column is not there yet (its migration is run by hand). */
export function isMissingColumn(err: any): boolean {
  if (!err) return false;
  const code = String(err.code || '');
  if (code === '42703' || code === 'PGRST204') return true;
  return /column .* does not exist|could not find the .* column/i.test(String(err.message || ''));
}

/**
 * EVERY link row of a venue, paged past PostgREST's 1000 row cap. A synced Potbelly shaped menu
 * alone is a few hundred rows, and a read that stopped at 1000 would make every row after it
 * look unsynced and every published id on it look unseen.
 *
 * synced: true when the sync columns came back (the 20260918 migration has run). Before that the
 * older columns are read instead, and the rows simply carry no ezCater ids.
 * complete: false when a page failed or the page limit was reached: what came back is PART of
 * the table and must not be reasoned about as all of it. Never throws.
 */
export async function readAllLinks(
  sb: any,
  locationId: string,
  opts: { deadline?: number | null; pageSize?: number; maxPages?: number } = {},
): Promise<{ rows: any[]; ok: boolean; complete: boolean; synced: boolean; idsRead: boolean; absent: boolean; error: any }> {
  const size = opts.pageSize || LINK_PAGE_SIZE;
  const maxPages = opts.maxPages || LINK_MAX_PAGES;
  const readWith = async (columns: string) => {
    const rows: any[] = [];
    for (let page = 0; page < maxPages; page++) {
      if (outOfTime(opts.deadline)) return { rows, ok: true, complete: false, error: null };
      const from = page * size;
      const { data, error } = await sb.from('ezcater_item_links').select(columns)
        .eq('location_id', locationId)
        .order('kind', { ascending: true }).order('ez_key', { ascending: true })
        .range(from, from + size - 1);
      if (error) return { rows, ok: false, complete: false, error };
      const batch = Array.isArray(data) ? data : [];
      rows.push(...batch);
      if (batch.length < size) return { rows, ok: true, complete: true, error: null };
    }
    return { rows, ok: true, complete: false, error: null };
  };
  try {
    // synced: every sync column is there (a sync may run). idsRead: the published ids came back,
    // so synced rows decide their lines, even on the first version of the migration.
    let r = await readWith(LINK_COLUMNS_SYNC);
    let synced = r.ok;
    let idsRead = r.ok;
    if (!r.ok && isMissingColumn(r.error)) {
      r = await readWith(LINK_COLUMNS_IDS);
      synced = false;
      idsRead = r.ok;
      if (!r.ok && isMissingColumn(r.error)) {
        r = await readWith(LINK_COLUMNS);
        idsRead = false;
      }
    }
    const code = String(r.error?.code || '');
    const absent = !r.ok && (code === '42P01' || code === 'PGRST205' || /does not exist|could not find the table/i.test(String(r.error?.message || '')));
    return { rows: r.rows, ok: r.ok, complete: r.complete, synced: synced && r.ok, idsRead: idsRead && r.ok, absent, error: r.error };
  } catch (e) {
    return { rows: [], ok: false, complete: false, synced: false, idsRead: false, absent: false, error: e };
  }
}

/** The menu_items columns the matcher needs. item_code is the optional one. */
export const MENU_ITEM_COLUMNS = 'id, name, menu_name, pricing, archived';
export const MENU_ITEM_COLUMNS_WITH_CODE = MENU_ITEM_COLUMNS + ', item_code';

/**
 * True when a read failed because menu_items.item_code is not there yet
 * (20260917_OPS_menu_item_code.sql is run by hand, so this window is real).
 *
 * Selecting a column that does not exist fails the WHOLE select, so without
 * this the matcher would read no menu at all and every ezCater line would come
 * in unmatched. Mirrors isMissingItemCodeColumn in src/lib/itemCode.js.
 */
export function isMissingItemCodeColumn(err: any): boolean {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || err.details || err.hint || '');
  if (!/item_code/i.test(msg)) return false;
  return code === 'PGRST204' || code === '42703' || /column/i.test(msg);
}

/**
 * The venue's saved links and its menu. Each read is guarded on its own, so a
 * missing links table still lets the menu match by name for THIS order, and an
 * unreadable menu still lets the saved links do their job.
 *
 * Returns empty lists rather than throwing. A caller cannot tell a read failure
 * from an empty venue except through linksOk / menuOk, and that is deliberate:
 * both mean "match with what you have".
 */
export async function readMatchInputs(
  sb: any,
  locationId: string,
  opts: { deadline?: number | null; skipLinks?: boolean } = {},
): Promise<MatchInputs> {
  const out: MatchInputs = { links: [], ourItems: [], ourGroups: [], linksOk: false, menuOk: false };
  if (!sb || !locationId) return out;
  const deadline = opts.deadline == null ? null : opts.deadline;

  // 1) Saved links, EVERY page of them (a synced menu is hundreds of rows, and
  // the old single select stopped at PostgREST's 1000). 42P01 (table missing,
  // the migration is run by hand) is the expected failure here and reads the
  // same as "no links saved yet". A read cut short keeps what it got for
  // matching, but writes nothing: a row we did not read may already exist.
  if (!opts.skipLinks) {
    const l = await readAllLinks(sb, locationId, { deadline });
    if (!l.ok) {
      const err: any = l.error || {};
      console.warn('[ezcater-match] no saved links (' + (err.code || 'error') + '):', err.message || String(err));
      out.links = l.rows;
    } else {
      out.links = l.rows;
      out.linksOk = l.complete;
      if (!l.complete) console.warn('[ezcater-match] saved links read incomplete, nothing will be written');
    }
  }

  // 2) The menu. BOTH tables have to come back whole. A partly read menu is
  // worse than no menu: "nothing of ours has that name" would be a lie told
  // about the half we did not see, and an auto link written from it is wrong
  // for every later order, silently.
  let itemsWhole = false;
  let groupsWhole = false;

  try {
    const readItems = (columns: string) => readPaged((from: number, to: number) => sb.from('menu_items')
      .select(columns)
      .eq('location_id', locationId).order('id', { ascending: true }).range(from, to), deadline);
    let items = await readItems(MENU_ITEM_COLUMNS_WITH_CODE);
    // The column is not there yet. Read the menu again without it rather than
    // lose the whole menu over an optional field: no codes simply means the
    // name rules do all the work, which is how this shipped.
    if (!items.ok && isMissingItemCodeColumn(items.error)) {
      console.warn('[ezcater-match] menu_items.item_code is not there yet, matching by name only');
      items = await readItems(MENU_ITEM_COLUMNS);
    }
    out.ourItems = menuItemsForMatch(items.rows);
    itemsWhole = items.ok && items.complete;
    if (!itemsWhole) console.warn('[ezcater-match] menu items read incomplete, matching only by saved links');
  } catch (e) {
    console.warn('[ezcater-match] menu items read threw:', e instanceof Error ? e.message : String(e));
  }

  try {
    const groups = await readPaged((from: number, to: number) => sb.from('modifier_groups')
      .select('id, name, options')
      .eq('location_id', locationId).order('id', { ascending: true }).range(from, to), deadline);
    out.ourGroups = modifierGroupsForMatch(groups.rows);
    groupsWhole = groups.ok && groups.complete;
    if (!groupsWhole) console.warn('[ezcater-match] modifier groups read incomplete, matching only by saved links');
  } catch (e) {
    console.warn('[ezcater-match] modifier groups read threw:', e instanceof Error ? e.message : String(e));
  }

  out.menuOk = itemsWhole && groupsWhole;
  return out;
}

/**
 * Persist what this order taught us.
 *
 *   writes  inserted with ON CONFLICT DO NOTHING (ignoreDuplicates). If a
 *           person saved a link for the same key while this order was in
 *           flight, THEIRS WINS and ours is dropped on the floor. The next
 *           order then uses theirs.
 *   bumps   seen_count and last_seen_at, by primary key, touching those two
 *           columns only, so a concurrent edit to menu_item_id or source is
 *           never overwritten by a counter update.
 *   upgrades a row that is still a bare sighting gets the target we can now
 *           prove. The where clause repeats every condition (no menu_item_id,
 *           no option_id, no matched_by, source 'auto'), so Postgres itself
 *           refuses the update if a person answered it a moment ago.
 *
 * seen_count is read then written, so two orders landing in the same instant
 * can lose one increment. It is a "how often does ezCater send this" counter on
 * a Back Office screen, never money and never routing, so a lost increment is
 * cheaper than an RPC that has to be deployed before this can work at all.
 *
 * Never throws. A failure here costs the NEXT order a rematch, nothing more.
 */
export async function saveLinkWrites(
  sb: any,
  locationId: string,
  writes: any[],
  bumps: { kind: string; ezKey: string; seenCount: number }[],
  nowIso: string,
  upgrades: { kind: string; ezKey: string; menuItemId: string | null; optionId: string | null }[] = [],
): Promise<{ inserted: number; bumped: number; filled: number }> {
  const done = { inserted: 0, bumped: 0, filled: 0 };
  if (!sb || !locationId) return done;

  try {
    const rows = (Array.isArray(writes) ? writes : []).filter((r) => r && r.ez_key && r.ez_name);
    if (rows.length) {
      const { error } = await sb.from('ezcater_item_links')
        .upsert(rows, { onConflict: 'location_id,kind,ez_key', ignoreDuplicates: true });
      if (error) console.warn('[ezcater-match] link insert failed:', error.message);
      else done.inserted = rows.length;
    }
  } catch (e) {
    console.warn('[ezcater-match] link insert threw:', e instanceof Error ? e.message : String(e));
  }

  try {
    const list = (Array.isArray(bumps) ? bumps : []).slice(0, MAX_LINK_BUMPS);
    const results = await Promise.all(list.map((b) => sb.from('ezcater_item_links')
      .update({ seen_count: b.seenCount, last_seen_at: nowIso, updated_at: nowIso })
      .eq('location_id', locationId).eq('kind', b.kind).eq('ez_key', b.ezKey)
      .then((r: any) => r, (e: any) => ({ error: e }))));
    for (const r of results) {
      if (r && r.error) console.warn('[ezcater-match] seen_count bump failed:', r.error.message || r.error);
      else done.bumped++;
    }
  } catch (e) {
    console.warn('[ezcater-match] seen_count bump threw:', e instanceof Error ? e.message : String(e));
  }

  try {
    const list = (Array.isArray(upgrades) ? upgrades : []).slice(0, MAX_LINK_BUMPS)
      .filter((u) => u && u.ezKey && (u.menuItemId || u.optionId));
    const results = await Promise.all(list.map((u) => sb.from('ezcater_item_links')
      .update({
        menu_item_id: u.menuItemId || null,
        option_id: u.optionId || null,
        matched_by: 'name',
        updated_at: nowIso,
      })
      .eq('location_id', locationId).eq('kind', u.kind).eq('ez_key', u.ezKey)
      // Still a bare sighting, or this update does nothing at all. A person who
      // answered it in the meantime keeps their answer.
      .eq('source', 'auto').is('menu_item_id', null).is('option_id', null).is('matched_by', null)
      .then((r: any) => r, (e: any) => ({ error: e }))));
    for (const r of results) {
      if (r && r.error) console.warn('[ezcater-match] sighting fill failed:', r.error.message || r.error);
      else done.filled++;
    }
  } catch (e) {
    console.warn('[ezcater-match] sighting fill threw:', e instanceof Error ? e.message : String(e));
  }

  return done;
}

/**
 * The whole job for one order_queue row, and the only function the webhook
 * calls. Reads, decides, saves, and returns a NEW row with itemId filled in and
 * customer.ezMatch stamped.
 *
 * ON ANY FAILURE IT RETURNS THE ROW IT WAS GIVEN, UNTOUCHED. No ezMatch stamp,
 * itemId exactly as the mapper left it, which is today's behaviour and a
 * working plain text ticket. Nothing here can stop an order reaching a kitchen.
 *
 * AND IT IS ON A CLOCK. budgetMs (default MATCH_BUDGET_MS) caps the whole job.
 * The deadline is checked between reads, and the job is raced against a timer
 * as well, so even a read that never comes back cannot delay the order: past
 * the budget the caller gets the mapper's row and writes it. Pass budgetMs 0 to
 * turn the clock off.
 */
export async function matchQueueRow(
  sb: any,
  locationId: string,
  row: any,
  opts: { nowIso?: string; budgetMs?: number } = {},
): Promise<{ row: any; matched: number; lines: number; inserted: number; bumped: number; ran: boolean; unseen: string[] }> {
  const lines = Array.isArray(row?.items) ? row.items : [];
  const bailed = { row, matched: 0, lines: lines.length, inserted: 0, bumped: 0, ran: false, unseen: [] as string[] };
  if (!sb || !locationId || !lines.length) return bailed;

  const budgetMs = Number.isFinite(opts.budgetMs as number) ? Number(opts.budgetMs) : MATCH_BUDGET_MS;
  const deadline = budgetMs > 0 ? Date.now() + budgetMs : null;
  // The clock. A hung read resolves nothing, so a deadline checked between
  // awaits is not enough on its own: the race below is what guarantees the
  // order goes through.
  let timer: any = null;
  const timedOut = Symbol('ezcater-match-timeout');

  try {
    const work = async () => {
      const nowIso = opts.nowIso || new Date().toISOString();
      const input = await readMatchInputs(sb, locationId, { deadline });

      // Both reads failed, so we know nothing: not the links, not the menu. Stamping
      // ezMatch here would tell a screen "we checked and matched none of it", which
      // is a different and worse thing than "we could not check". Hand back the
      // mapper's row untouched instead.
      if (!input.linksOk && !input.menuOk) {
        console.warn('[ezcater-match] neither links nor menu could be read, order continues unmatched');
        return bailed;
      }

      const plan = planLineMatches({
        lines,
        ourItems: input.ourItems,
        ourGroups: input.ourGroups,
        links: input.links,
        locationId,
        nowIso,
        menuOk: input.menuOk,
      });

      // Only write when the links table answered a read. If it did not, an insert
      // would fail too, and guessing at that is not worth a second error line.
      // And never spend more time writing than the order can afford to wait.
      let saved = { inserted: 0, bumped: 0, filled: 0 };
      if (input.linksOk && !outOfTime(deadline)) {
        saved = await saveLinkWrites(sb, locationId, plan.writes, plan.bumps, nowIso, plan.upgrades);
      } else if (input.linksOk) {
        console.warn('[ezcater-match] out of time before saving, this order still routes');
      }

      const next = withMatchedItems(row, plan.lines);
      const summary = next?.customer?.ezMatch || { lines: plan.lines.length, matched: 0 };
      return {
        row: next,
        matched: Number(summary.matched) || 0,
        lines: Number(summary.lines) || plan.lines.length,
        inserted: saved.inserted,
        bumped: saved.bumped,
        ran: true,
        // ezCater ids no synced row holds: ezCater republished, the caller re-syncs.
        unseen: Array.isArray(plan.unseen) ? plan.unseen : [],
      };
    };

    const onTime = deadline == null ? null : new Promise((resolve) => {
      timer = setTimeout(() => resolve(timedOut), Math.max(1, (deadline as number) - Date.now()));
    });
    const result: any = onTime ? await Promise.race([work(), onTime]) : await work();
    if (result === timedOut) {
      console.warn('[ezcater-match] matching took too long, order goes through unmatched');
      return bailed;
    }
    return result;
  } catch (e) {
    console.warn('[ezcater-match] matching skipped, order continues unmatched:',
      e instanceof Error ? e.message : String(e));
    return bailed;
  } finally {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  }
}
