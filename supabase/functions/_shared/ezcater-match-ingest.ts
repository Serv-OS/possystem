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
  applyLinks, autoLinkDecision, buildLinkKey, findLink, indexItemCodes, indexLinks,
} from './ezcaterMatch.ts';
// The ezMatch stamp lives with the rest of the customer jsonb shape, in the
// mapper, not here.
import { withMatchedItems } from './ezcater-map.ts';
// The synced menu (feat/ezcater-menu-sync-v1): the published size id rule and the paged link read.
import {
  indexPublishedIds, sizeRouteFor, readAllLinks, isMissingSyncColumn, isMissingLinksTable,
  isSyncedRow, trustedTarget, LINK_COLUMNS, LINK_COLUMNS_WITH_SYNC,
} from './ezcaterMenuSync.ts';

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
  /**
   * true when the links were read WITH the menu sync columns (ez_ids, ez_size_name, synced_at),
   * i.e. migration 20260919m has run. Then EXACT MEANS EXACT at order time (see the top of
   * ezcaterMenuSync.ts): a line on a synced row (by its published size id, or by its name key)
   * takes only that row's trusted decision, and any other sized line stays unmatched. false or
   * absent is the behaviour before this change.
   */
  sizeIds?: boolean;
  /**
   * true when the link read FAILED or came back PARTIAL for any reason other than a proven
   * missing table or column. Then nothing is matched by name, for ANY line: every line comes back
   * exactly as ezCater sent it (it prints by name) and nothing is written.
   */
  linksFailed?: boolean;
}): MatchPlan {
  const lines = Array.isArray(input.lines) ? input.lines : [];
  if (input.linksFailed) {
    return { lines: lines.map((l: any) => ({ ...(l || {}) })), writes: [], bumps: [], upgrades: [] };
  }
  const ourItems = Array.isArray(input.ourItems) ? input.ourItems : [];
  const ourGroups = Array.isArray(input.ourGroups) ? input.ourGroups : [];
  const rawLinks: any[] = Array.isArray(input.links) ? input.links : [];
  const locationId = text(input.locationId);
  const nowIso = text(input.nowIso) || new Date(0).toISOString();
  const menuOk = input.menuOk !== false;

  // The synced rows, by 'kind:key' and by published id. Without the sync columns there are none
  // and every line is 'plain', as before.
  const syncedRows = input.sizeIds ? rawLinks.filter((r) => isSyncedRow(r)) : [];
  const syncedIdx = indexLinks(syncedRows);
  const syncedRaw = new Map<string, any>();
  for (const r of syncedRows) syncedRaw.set((text(r.kind) || 'item') + ':' + (text(r.ez_key) || text(r.ezKey)), r);
  // What the matchers see: a synced row keeps its target ONLY when it is a trusted decision
  // (a staff match, or an exact auto link from a sync). An old order time name link on a synced
  // row is not one, and must never route a line or look like a saved answer.
  const links = input.sizeIds
    ? rawLinks.map((r) => (isSyncedRow(r) && !trustedTarget(r)
      ? { ...r, menu_item_id: null, option_id: null, menuItemId: null, optionId: null } : r))
    : (input.links || []);

  // Per line: the old name rules ('plain'), a synced row ('synced'), or nothing ('unmatched').
  const idIdx = input.sizeIds ? indexPublishedIds(rawLinks) : null;
  const routes: any[] = lines.map((l: any) => {
    const r: any = idIdx ? sizeRouteFor(l, idIdx) : { mode: 'plain' };
    if (r.mode !== 'plain' || !syncedRows.length) return r;
    // No size id on a synced row, and no size on the line: its NAME key may still find a synced
    // row (an item ezCater sells with no size at all). That row decides, never the name rule.
    const hit = findLink(syncedIdx, l || {}, 'item');
    if (!hit) return r;
    const t = trustedTarget(syncedRaw.get('item:' + hit.key));
    return { mode: 'synced', ezKey: hit.key, itemId: t && t.menuItemId ? t.menuItemId : null };
  });
  /** A line the name rules may not decide: the synced row's answer, or no match at all. */
  const routed = (appliedLine: any, i: number, known: Set<string> | null) => {
    const r: any = routes[i];
    let itemId: string | null = r.mode === 'synced' && r.itemId ? String(r.itemId) : null;
    // A synced row pointing at an item that is gone (only checkable with the whole menu) routes nothing.
    if (itemId && known && known.size && !known.has(itemId)) itemId = null;
    return { ...appliedLine, itemId, match: { matched: !!itemId, source: itemId ? 'menuSync' : null } };
  };
  /**
   * A customization whose key finds a synced option row: that row's trusted decision only, or
   * nothing. null when no synced row holds it (the old rules decide).
   */
  const syncedMod = (appliedMod: any, srcMod: any): { mod: any; key: string } | null => {
    if (!syncedRows.length) return null;
    const hit = findLink(syncedIdx, srcMod || {}, 'option');
    if (!hit) return null;
    const t = trustedTarget(syncedRaw.get('option:' + hit.key));
    const itemId = t && t.menuItemId ? t.menuItemId : null;
    const optionId = t && t.optionId ? t.optionId : null;
    return {
      key: hit.key,
      mod: { ...appliedMod, itemId, optionId, match: { matched: !!(itemId || optionId), source: (itemId || optionId) ? 'menuSync' : null } },
    };
  };

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
  if (!locationId || !menuOk || (!haveItems && !haveGroups)) {
    const out = applied.map((l: any, i: number) => {
      const base = routes[i].mode === 'plain' ? l : routed(l, i, null);
      const srcMods = Array.isArray(lines[i]?.mods) ? lines[i].mods : [];
      const mods = (Array.isArray(base.mods) ? base.mods : []).map((m: any, j: number) => {
        const sm = syncedMod(m, srcMods[j]);
        return sm ? sm.mod : m;
      });
      return { ...base, mods };
    });
    return { lines: out, writes: [], bumps: [], upgrades: [] };
  }
  const knownIds = new Set<string>(ourItems.map((it: any) => String(it.id)));

  const idx = indexLinks(links);
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
      // A synced row is never filled or upgraded by the order time name rule. (Lines and
      // customizations on synced rows never get here; this is the backstop.)
      if (syncedRaw.has(kind + ':' + hit.key)) return;
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
    const route: any = routes[i];

    if (route.mode !== 'plain') {
      // On a synced row, or sized: never the name rules, never a name row written or filled
      // from this line. Only the row's seen count moves.
      const r = routed(appliedLine, i, haveItems ? knownIds : null);
      itemId = r.itemId;
      source = r.match.source;
      if (route.mode === 'synced' && route.ezKey) sawExisting('item', route.ezKey);
    } else if (haveItems) {
      // codes is passed in rather than rebuilt per line: one index for the
      // whole order, and the option arm cannot build one at all.
      const d = autoLinkDecision(src, ourItems, links, { kind: 'item', itemCodes: codes });
      itemId = d.action === 'linked' && d.itemId != null ? String(d.itemId) : null;
      source = d.action === 'linked' ? (d.source || null) : null;
      // A stale link (its item is gone, or archived today) is left completely
      // alone: not reused, not rewritten, not counted. Overwriting it would
      // throw away a person's decision the week a venue archives an item.
      if (!d.stale) record('item', src, d);
    }

    const srcMods = Array.isArray(src.mods) ? src.mods : [];
    const mods = (Array.isArray(appliedLine.mods) ? appliedLine.mods : []).map((appliedMod: any, j: number) => {
      const srcMod = srcMods[j] || {};
      const sm = syncedMod(appliedMod, srcMod);
      if (sm) { sawExisting('option', sm.key); return sm.mod; }
      if (!haveGroups) return appliedMod;
      const d = autoLinkDecision(srcMod, ourGroups, links, { kind: 'option', itemCodes: codes });
      if (!d.stale) record('option', srcMod, d);
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

    return { ...appliedLine, itemId, mods, match: { matched: !!itemId, source } };
  });

  const writes = Array.from(fresh.values()).slice(0, MAX_LINK_WRITES);
  const bumps = Array.from(times.entries()).slice(0, MAX_LINK_BUMPS).map(([k, n]) => {
    const cut = k.indexOf(':');
    const kind = k.slice(0, cut);
    const ezKey = k.slice(cut + 1);
    return { kind, ezKey, times: n, seenCount: (counts.get(k) || 0) + n };
  });
  const upgrades = Array.from(fill.values()).slice(0, MAX_LINK_BUMPS);

  return { lines: outLines, writes, bumps, upgrades };
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
  /**
   * false ONLY when the read proved the sync columns (or the links table) are not there, so the
   * rules before migration 20260919m apply. true when the links came with ez_ids and
   * ez_size_name, AND when the read failed for any other reason: then no sized line may be
   * matched by a name guess.
   */
  sizeIds?: boolean;
  /**
   * true when the link read failed or was cut short for any reason OTHER than a proven missing
   * links table (20260917 not run). Then NO line is matched by name and nothing is written:
   * a venue whose synced rows could not be read must not get a name guess on any line.
   */
  linksFailed?: boolean;
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
  opts: { deadline?: number | null } = {},
): Promise<MatchInputs> {
  // sizeIds starts TRUE: a sized line may fall back to the old name rules ONLY when the read
  // PROVED the sync columns (or the whole table) are not there. Any other failed read (a
  // timeout, a network fault, a permission error) leaves every sized line unmatched, printing
  // by name: a venue that HAS synced size rows must never get a name guess because one read
  // failed.
  const out: MatchInputs = { links: [], ourItems: [], ourGroups: [], linksOk: false, menuOk: false, sizeIds: true, linksFailed: true };
  if (!sb || !locationId) return out;
  const deadline = opts.deadline == null ? null : opts.deadline;

  // 1) Saved links. 42P01 (table missing, the migration is run by hand) is the
  // expected failure here and reads the same as "no links saved yet".
  //
  // PAGED (feat/ezcater-menu-sync-v1): a synced menu can pass PostgREST's 1000 row cap, and a
  // row cut off by the cap would read as "never seen". An incomplete read keeps the rows it got
  // but writes nothing (linksOk false), the same answer as a failed read.
  // The sync columns are asked for first; before 20260919m runs they are not there, and the
  // read is repeated without them (sizeIds false: the rules before this change).
  try {
    let res = await readAllLinks(sb, locationId, LINK_COLUMNS_WITH_SYNC, deadline);
    if (!res.ok && isMissingSyncColumn(res.error)) {
      out.sizeIds = false;
      res = await readAllLinks(sb, locationId, LINK_COLUMNS, deadline);
    } else if (!res.ok && isMissingLinksTable(res.error)) {
      out.sizeIds = false;
      // PROVEN: no links table, so no sync ever ran. The rules from before (name match, no writes).
      out.linksFailed = false;
    }
    if (!res.ok) {
      const error = res.error || {};
      console.warn('[ezcater-match] no saved links (' + (error.code || 'error') + '):', error.message);
    } else {
      out.links = res.rows;
      out.linksOk = res.complete;
      out.linksFailed = !res.complete;
      if (!res.complete) console.warn('[ezcater-match] saved links read incomplete, nothing will be matched or written');
    }
  } catch (e) {
    console.warn('[ezcater-match] links read threw:', e instanceof Error ? e.message : String(e));
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
): Promise<{ row: any; matched: number; lines: number; inserted: number; bumped: number; ran: boolean }> {
  const lines = Array.isArray(row?.items) ? row.items : [];
  const bailed = { row, matched: 0, lines: lines.length, inserted: 0, bumped: 0, ran: false };
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
      // The link read failed or was partial (and the table is not proven missing): no line may
      // be matched by name and nothing may be written. The order goes through as ezCater sent it.
      if (input.linksFailed) {
        console.warn('[ezcater-match] saved links not read whole, every line prints by name');
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
        sizeIds: input.sizeIds === true,
        linksFailed: input.linksFailed === true,
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
