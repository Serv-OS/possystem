// supabase/functions/_shared/ezcaterMenuSync.ts
//
// "SYNC ezCater MENU", the conservative version (18 Sep 2026, feat/ezcater-menu-sync-v1).
//
// Peter: items must be matched BEFORE any order, not after. The connected ezCater token can read
// the caterer's menus (proven live, read only, 18 Sep 2026):
//   menus(catererId)     -> nodes { id name startDate endDate }
//   menu(catererId, id)  -> categories { id name items { id name originalItemId sizes { id name
//                           serves status originalItemSizeId customizationTypes { id name
//                           selectionRangeStart selectionRangeEnd values { ... } } } } }
//
// WHAT A SYNC DOES, AND NOTHING MORE
//   1. reads the CURRENT menus (venue date, venue clock) of every caterer mapped to the venue
//   2. writes one ezcater_item_links row per item (one per SIZE when an item has several sizes,
//      one per option value when values are readable), each carrying its published ids (ez_ids)
//   3. auto links ONLY an EXACT name match to our menu (exactName below: case, accents, spaces
//      and punctuation folded, nothing else dropped); everything else is left for staff, who get
//      suggestions on the Item matching card
//   It never deletes a row, never changes a decision (a staff match, "Not on our menu", a staff
//   clear, or an earlier auto link) and never touches seen_count. Syncing twice writes no new row.
//
// THE ORDER TIME RULE (sizeRouteFor, used by ezcater-match-ingest.ts), kept deliberately simple.
// It matches on the line's SIZE id only (ezSizeId, which ezcater-map.ts takes from the order's
// menuItemSizeId), never on the line's item id. PROVEN on the live test order HKX77V (Claude,
// read only, 18 Sep 2026): its line carried ezSizeId 0226b68c-492c-5a38-b528-fd62a1c1e828, and
// the menu read has exactly that id as categories[0].items[1].sizes[0].id (size "Box", serves 1).
// The same line's item id (ezItemId 5f5b503b-...) was NEITHER the menu's item id (279b6bf4-...)
// NOR its originalItemId (b4d95922-...), so an order's item id can never be matched against a
// synced row.
//
//   EXACT MEANS EXACT AT ORDER TIME TOO (review round 2, 18 Sep 2026):
//   * a line whose published size id is on a synced row (a SIZE row or a single size PLAIN row)
//     resolves to that row's decision ONLY: a staff match, or an exact auto link written by a
//     sync (matched_by 'exact'). A row with no such decision leaves the line unmatched.
//   * a line with no size id whose name key finds a synced row is the same: that row decides.
//   * the order time name rule (autoLinkDecision, which drops size words to FIND candidates)
//     never decides a line on a synced row, and never fills or upgrades a synced row.
//   * ANY other sized line stays unmatched and prints by name: no guessed size, and no old name
//     match carried onto a sized line
//   * a line with no synced row at all (and no size) keeps the rules from before this file
//   * a failed or partial link read (not a proven missing table or column) matches NOTHING by
//     name: the order goes through exactly as ezCater sent it (ezcater-match-ingest.ts)
//
// Pure functions first (tested under node), then the database and ezCater side. The ezCater call
// is passed in (ask), so nothing here needs Deno globals.

import { buildLinkKey } from './ezcaterMatch.ts';

const s = (v: unknown): string => (v == null ? '' : String(v).trim());
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

// ── Keys ─────────────────────────────────────────────────────────────────────────────────────

/** The size part of a size row key: lower case words, nothing stripped (a size IS the point). */
export function sizeKeyPart(sizeName: unknown): string {
  const t = s(sizeName).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t || 'unnamed';
}

/**
 * The key of the row for ONE size of an item with several sizes: '<item key>|size:<size>'.
 * An item key never holds '|' (punctuation is stripped), so a size row can never collide with a
 * plain row, and a plain name lookup (findLink) can never land on one. '' when the item name
 * cannot be keyed.
 */
export function sizeRowKey(itemName: unknown, sizeName: unknown): string {
  const item = buildLinkKey({ name: s(itemName) }, 'item');
  return item ? `${item}|size:${sizeKeyPart(sizeName)}` : '';
}

// ── Exact names ──────────────────────────────────────────────────────────────────────────────

/**
 * The EXACT form of a name, the only form an auto link compares: lower case, accents off, '&' read
 * as 'and', apostrophes dropped, every other run of punctuation or space one space. NOTHING else
 * is dropped: no size word, no container word (tray, pan, box), no "serves 10", no bracketed
 * part. The scorer and the order time name rules (normaliseItemName, normaliseKeyName) drop some
 * of those on purpose to FIND candidates; an auto link must not, because the dropped word is
 * exactly what tells "Sandwich Platter Large" from our "Sandwich Platter". So any size or
 * container word on one side that the other side does not have means the names differ, and
 * nothing is linked without a person.
 */
export function exactName(value: unknown): string {
  return s(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').replace(/['\u2018\u2019\u02bc`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Container words in their plural and "-ed" forms, folded to one word, used ONLY to tell whether a
 * single size item's size name repeats what its item name already says ("Boxed" and "Box").
 */
const CONTAINER_FOLD: Record<string, string> = Object.freeze({
  box: 'box', boxes: 'box', boxed: 'box',
  tray: 'tray', trays: 'tray',
  pan: 'pan', pans: 'pan',
  platter: 'platter', platters: 'platter',
  bag: 'bag', bags: 'bag', bagged: 'bag',
  bowl: 'bowl', bowls: 'bowl',
}) as Record<string, string>;
const foldWord = (w: string): string => CONTAINER_FOLD[w] || w;

/**
 * The full exact name of an item with ONE size (or none), the name an auto link compares.
 * The only size takes part exactly as a multi size item's sizes do: the full name is
 * '<item> <size>'. The one allowance: a size name whose every word the item name already says
 * adds nothing, so the full name is the item name. "Italian Boxed Lunch" with its only size
 * "Box" is "italian boxed lunch" (Box repeats Boxed); "Turkey Sandwich" with its only size "Box"
 * is "turkey sandwich box", and "Caesar Salad" with its only size "Large" is "caesar salad large".
 * '' when the item has no usable name.
 */
export function singleSizeExactName(itemName: unknown, sizeName: unknown): string {
  const item = exactName(itemName);
  if (!item) return '';
  const size = exactName(sizeName);
  if (!size) return item;
  const said = new Set(item.split(' ').map(foldWord));
  const adds = size.split(' ').some((w) => !said.has(foldWord(w)));
  return adds ? `${item} ${size}` : item;
}

// ── The ezCater side ─────────────────────────────────────────────────────────────────────────

/** ask(operationName, query, variables) -> the GraphQL `data`, or throws. */
export type EzAsk = (operationName: string, query: string, variables?: Record<string, unknown>) => Promise<any>;

export const MENUS_QUERY = `query ServOsEzMenus($catererId: UUID!) {
  menus(catererId: $catererId) { nodes { id name startDate endDate } }
}`;

const MENU_HEAD = 'query ServOsEzMenu($catererId: UUID!, $id: UUID!) { menu(catererId: $catererId, id: $id) {';

/** The whole menu, option values included. */
export const MENU_QUERY = `${MENU_HEAD}
  id name startDate endDate
  categories { id name items { id name originalItemId
    sizes { id name serves status originalItemSizeId
      customizationTypes { id name selectionRangeStart selectionRangeEnd values { id name } } } } }
} }`;

/**
 * The menu without option values. Used only when ezCater refuses the query above as a schema
 * error: GraphQL throws the WHOLE query away over one field it does not have, and the value
 * fields were never proven live. Items and sizes still sync; options then say so.
 */
export const MENU_QUERY_NO_OPTIONS = `${MENU_HEAD}
  id name startDate endDate
  categories { id name items { id name originalItemId
    sizes { id name serves status originalItemSizeId } } }
} }`;

/** 'YYYY-MM-DD' of an instant on the venue's clock (venue clock invariant). */
export function venueDate(nowMs: number, timeZone: string | null | undefined): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date(nowMs));
    const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
    const out = `${get('year')}-${get('month')}-${get('day')}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(out)) return out;
  } catch { /* an unknown zone: UTC below */ }
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Menus current on `today`: started (or no start) and not ended (or no end). PURE. */
export function currentMenus(nodes: any, today: string): any[] {
  const d = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  return arr(nodes).filter((m) => {
    if (!m || !s(m.id)) return false;
    const a = d(m.startDate);
    const b = d(m.endDate);
    if (a && a > today) return false;
    if (b && b < today) return false;
    return true;
  });
}

/** True when an error from ask() is GraphQL refusing a field (schema), not a network or auth fault. */
export function looksLikeSchemaError(e: any): boolean {
  const msg = String(e?.message || e || '');
  const code = String(e?.code || '');
  return code === 'GRAPHQL_VALIDATION_FAILED'
    || /cannot query field|unknown (field|argument|type)|validation/i.test(msg);
}

/**
 * One caterer's current menus, read whole. Throws when the menu list or a menu cannot be read,
 * so the caller knows the read was not complete. `optionsRead` is false when ezCater refused
 * the option values and the menus were read without them. `missing` counts current menus that
 * ezCater listed but then answered with no menu (null): that read is PARTIAL too, and the caller
 * must treat it exactly like a failed one.
 */
export async function readCatererMenus(
  ask: EzAsk, catererId: string, today: string,
  isSchemaError: (e: unknown) => boolean = looksLikeSchemaError,
): Promise<{ menus: any[]; optionsRead: boolean; missing: number }> {
  const list = await ask('ServOsEzMenus', MENUS_QUERY, { catererId });
  const nodes = currentMenus(list?.menus?.nodes, today);
  const menus: any[] = [];
  let optionsRead = true;
  let missing = 0;
  for (const node of nodes) {
    let data: any;
    if (optionsRead) {
      try {
        data = await ask('ServOsEzMenu', MENU_QUERY, { catererId, id: s(node.id) });
      } catch (e) {
        if (!isSchemaError(e)) throw e;
        optionsRead = false;
      }
    }
    if (!optionsRead) data = await ask('ServOsEzMenu', MENU_QUERY_NO_OPTIONS, { catererId, id: s(node.id) });
    if (data?.menu) menus.push(data.menu);
    else missing++;
  }
  return { menus, optionsRead, missing };
}

// ── Flattening ───────────────────────────────────────────────────────────────────────────────

export interface MenuEntry {
  kind: 'item' | 'option';
  ezKey: string;
  ezName: string;
  ezGroup: string | null;
  /** Set only on a row for ONE size of an item with several sizes. */
  ezSizeName: string | null;
  /**
   * The name of the ONE size of a single size item, on its plain row. A display value for staff
   * (ez_only_size), never part of the key: so nobody matches "Turkey Sandwich" without seeing it
   * is sold only as a Box.
   */
  ezOnlySize?: string | null;
  ezCategory: string | null;
  /** Published ids: a size id for an item row, a value id for an option row. */
  ids: string[];
  /**
   * The full EXACT name an auto link compares (exactName): '<item> <size>' for a size row,
   * singleSizeExactName for a plain row. '' links nothing.
   */
  exactName?: string;
  /**
   * Never auto linked: a size row whose full name a sibling shares, or a plain row the menus
   * describe two different ways (the same key with two different full names).
   */
  noAuto: boolean;
}

/**
 * Every row a sync writes, deduplicated by kind and key (ids unioned), in menu order. PURE.
 *   an item with 0 or 1 size  -> ONE plain row, keyed by name exactly as an order line is
 *   an item with 2+ sizes     -> one row PER SIZE, keyed sizeRowKey(item, size)
 *   every option value        -> one option row, keyed as an order customization is
 */
export function flattenMenus(menus: any): MenuEntry[] {
  const out = new Map<string, MenuEntry>();
  const put = (e: MenuEntry) => {
    const k = e.kind + ':' + e.ezKey;
    const prev = out.get(k);
    if (!prev) { out.set(k, { ...e, ids: Array.from(new Set(e.ids)) }); return; }
    for (const id of e.ids) if (!prev.ids.includes(id)) prev.ids.push(id);
    // One key, two different full names ("Sandwich Platter Tray" and "Sandwich Platter" key the
    // same): which one is ours is a guess, so neither is auto linked.
    prev.noAuto = prev.noAuto || e.noAuto || (prev.exactName || '') !== (e.exactName || '');
  };
  for (const menu of arr(menus)) {
    for (const cat of arr(menu?.categories)) {
      const category = s(cat?.name) || null;
      for (const item of arr(cat?.items)) {
        const name = s(item?.name);
        if (!name) continue;
        const sizes = arr(item?.sizes).filter((z) => z && (s(z.id) || s(z.name)));
        if (sizes.length <= 1) {
          const key = buildLinkKey({ name }, 'item');
          if (key) {
            // The only size is NOT thrown away: it is part of the exact name an auto link needs
            // (singleSizeExactName), so "Caesar Salad" sold only as "Large" is never our
            // "Caesar Salad Small", nor our plain "Caesar Salad".
            put({ kind: 'item', ezKey: key, ezName: name, ezGroup: null, ezSizeName: null, ezCategory: category,
              ezOnlySize: sizes.length === 1 ? (s(sizes[0].name) || null) : null,
              ids: sizes.length && s(sizes[0].id) ? [s(sizes[0].id)] : [],
              exactName: singleSizeExactName(name, sizes.length ? sizes[0].name : ''), noAuto: false });
          }
        } else {
          // Two sizes whose full exact names are the same cannot be told apart by name, so
          // neither is auto linked. A size with no usable name adds nothing, so it is not either.
          const item = exactName(name);
          const full = sizes.map((z) => (exactName(z.name) ? exactName(`${name} ${s(z.name)}`) : ''));
          for (let i = 0; i < sizes.length; i++) {
            const z = sizes[i];
            const key = sizeRowKey(name, z.name);
            if (!key) continue;
            const clash = !full[i] || full[i] === item || full.filter((f) => f === full[i]).length > 1;
            put({ kind: 'item', ezKey: key, ezName: name, ezGroup: null, ezSizeName: s(z.name) || 'unnamed',
              ezCategory: category, ids: s(z.id) ? [s(z.id)] : [], exactName: full[i], noAuto: clash });
          }
        }
        for (const z of sizes) {
          for (const t of arr(z?.customizationTypes)) {
            const group = s(t?.name);
            for (const v of arr(t?.values)) {
              const vName = s(v?.name);
              if (!vName) continue;
              const key = buildLinkKey({ name: vName, groupLabel: group }, 'option');
              if (!key) continue;
              put({ kind: 'option', ezKey: key, ezName: vName, ezGroup: group || null, ezSizeName: null,
                ezCategory: category, ids: s(v?.id) ? [s(v.id)] : [], exactName: exactName(vName), noAuto: false });
            }
          }
        }
      }
    }
  }
  return Array.from(out.values());
}

// ── Exact name auto links ────────────────────────────────────────────────────────────────────

/** The names one of ours can be known by: name, menuName, label. */
const ourNamesOf = (x: any): string[] => ['name', 'menuName', 'label']
  .map((k) => x?.[k]).filter((n) => typeof n === 'string' && n.trim()) as string[];

/** The full exact name of one entry: the one flattenMenus worked out, or built from its parts. */
export function entryExactName(entry: MenuEntry): string {
  if (typeof entry.exactName === 'string') return entry.exactName;
  if (entry.kind === 'option') return exactName(entry.ezName);
  return entry.ezSizeName ? exactName(`${entry.ezName} ${entry.ezSizeName}`) : exactName(entry.ezName);
}

/**
 * Our target for one synced row, or null. EXACT MEANS EXACT.
 *   item (plain or size)  exactly ONE of our items whose name (or menu name) has the SAME exact
 *                         name as the row's full name: item name plus its size, see
 *                         singleSizeExactName. Any size or container word on one side only
 *                         ("Large", "Small", "Tray", "Box") means different names, so no link.
 *   option                exactly ONE of our options, in any group, with the same exact name
 *   anything marked noAuto, or with no exact name, links nothing
 * The order time name rules (autoLinkDecision) are NOT used here: they compare names with the
 * size words dropped, which is right for suggestions and wrong for a link nobody checks.
 */
export function autoTargetFor(entry: MenuEntry, ourItems: any[], ourGroups: any[]):
  { menuItemId: string | null; optionId: string | null } | null {
  if (!entry || entry.noAuto) return null;
  const want = entryExactName(entry);
  if (!want) return null;
  if (entry.kind === 'option') {
    const hits = new Map<string, any>();
    for (const g of arr(ourGroups)) {
      for (const o of arr(g?.options)) {
        if (!o || o.id == null) continue;
        if (ourNamesOf(o).some((n) => exactName(n) === want)) hits.set(String(o.id), o);
      }
    }
    if (hits.size !== 1) return null;
    const [id, o] = Array.from(hits.entries())[0];
    return { menuItemId: o.itemId != null && s(o.itemId) ? String(o.itemId) : null, optionId: id };
  }
  const hits = new Set<string>();
  for (const it of arr(ourItems)) {
    if (!it || it.id == null) continue;
    if (ourNamesOf(it).some((n) => exactName(n) === want)) hits.add(String(it.id));
  }
  return hits.size === 1 ? { menuItemId: Array.from(hits)[0], optionId: null } : null;
}

// ── The plan ─────────────────────────────────────────────────────────────────────────────────

const idsOf = (v: unknown): string[] => arr(v).map((x) => s(x)).filter(Boolean);

/** matched_by on an auto link a SYNC wrote by the exact rule. The order time name rule writes 'name'. */
export const EXACT_MATCHED_BY = 'exact';

/** A row a menu sync wrote or refreshed: it carries published ids or a synced_at stamp. */
export function isSyncedRow(row: any): boolean {
  if (!row) return false;
  return idsOf(row.ez_ids ?? row.ezIds).length > 0 || !!s(row.synced_at ?? row.syncedAt);
}

/**
 * The decision on a row that may route food without a person looking again, or null:
 *   a staff match (source 'manual' with a target), or
 *   an EXACT auto link (source 'auto', matched_by 'exact', written by a sync)
 * An auto link the order time name rule made (matched_by 'name') is NOT one: it was made with
 * size words dropped. "Not on our menu" and a staff clear have no target, so they are null too.
 */
export function trustedTarget(row: any): { menuItemId: string | null; optionId: string | null } | null {
  if (!row) return null;
  const menuItemId = s(row.menu_item_id ?? row.menuItemId) || null;
  const optionId = s(row.option_id ?? row.optionId) || null;
  if (!menuItemId && !optionId) return null;
  const source = s(row.source);
  if (source === 'manual') return { menuItemId, optionId };
  if (source === 'auto' && s(row.matched_by ?? row.matchedBy) === EXACT_MATCHED_BY) return { menuItemId, optionId };
  return null;
}

/** A row nobody has decided: no target, not silenced, not touched by a person. */
const isBare = (row: any) => !!row && !s(row.menu_item_id) && !s(row.option_id)
  && !s(row.matched_by) && s(row.source || 'auto') === 'auto';

export interface SyncPlan {
  /** New rows, written insert only (on conflict do nothing): a racing save or order wins. */
  inserts: any[];
  /** Existing rows: the ezCater facts only (ids, size, category, synced_at). Never a decision. */
  refreshes: any[];
  /** Existing undecided rows that now have an exact match: guarded update, a person wins. */
  fills: { kind: string; ezKey: string; menuItemId: string | null; optionId: string | null }[];
  /**
   * Existing rows holding an auto link the ORDER TIME name rule made (matched_by 'name') before
   * the row was synced. Exact means exact, so each is decided again by the exact rule: kept and
   * marked 'exact' when it is the exact match, otherwise replaced by the exact match or cleared
   * for staff. Guarded on the old values, so a person who saved first wins. Only with our whole
   * menu in hand (menuOk).
   */
  rechecks: { kind: string; ezKey: string; was: { menuItemId: string | null; optionId: string | null };
    menuItemId: string | null; optionId: string | null }[];
  counts: { items: number; sizes: number; options: number; inserted: number; refreshed: number; autoLinked: number; toDecide: number; rechecked: number };
}

/** Published ids kept per row, newest first. Only reached after this many republishes. */
export const MAX_IDS_PER_ROW = 200;

/**
 * What a sync writes. PURE.
 * IDS ARE ONLY EVER ADDED: every sync keeps the ids already on a row and puts the newly published
 * ones first, complete read or not. An order placed before the caterer republished carries the
 * OLD size id, and when ezCater later sends a change to that order it still carries that id; it
 * must still find its row. Published ids are UUIDs, so an old id cannot come back meaning
 * something else, and if one ever did sit on two rows, sizeRouteFor already answers unmatched
 * ("size rows disagree", "id on a plain row and a size row").
 * `complete` false (a caterer or a menu could not be read, or came back empty) is reported, and
 * a partial read can never take anything away because nothing is ever taken away.
 * `menuOk` false (our own menu was only partly read) writes no auto link at all: "nothing else of
 * ours has that name" is not a claim a partial menu can make.
 */
/** A plain row's single size name for display (ez_only_size); null on size and option rows. */
const onlySizeOf = (e: MenuEntry): string | null =>
  (e.kind === 'item' && !e.ezSizeName ? (s(e.ezOnlySize) || null) : null);

export function planMenuSync(input: {
  entries: MenuEntry[]; existing: any[]; ourItems: any[]; ourGroups: any[];
  locationId: string; nowIso: string; complete: boolean; menuOk: boolean;
}): SyncPlan {
  const byKey = new Map<string, any>();
  for (const r of arr(input.existing)) if (r && s(r.ez_key)) byKey.set((s(r.kind) || 'item') + ':' + s(r.ez_key), r);
  const plan: SyncPlan = {
    inserts: [], refreshes: [], fills: [], rechecks: [],
    counts: { items: 0, sizes: 0, options: 0, inserted: 0, refreshed: 0, autoLinked: 0, toDecide: 0, rechecked: 0 },
  };
  for (const e of arr(input.entries) as MenuEntry[]) {
    if (e.kind === 'option') plan.counts.options++;
    else if (e.ezSizeName) plan.counts.sizes++;
    else plan.counts.items++;
    const target = input.menuOk ? autoTargetFor(e, input.ourItems, input.ourGroups) : null;
    const prev = byKey.get(e.kind + ':' + e.ezKey);
    if (!prev) {
      plan.inserts.push({
        location_id: input.locationId, kind: e.kind, ez_key: e.ezKey, ez_name: e.ezName,
        ez_group: e.kind === 'option' ? e.ezGroup : null,
        ez_size_name: e.ezSizeName, ez_only_size: onlySizeOf(e), ez_category: e.ezCategory, ez_ids: e.ids,
        menu_item_id: target ? target.menuItemId : null, option_id: target ? target.optionId : null,
        source: 'auto', matched_by: target ? EXACT_MATCHED_BY : null,
        seen_count: 0, last_seen_at: null, synced_at: input.nowIso, updated_at: input.nowIso,
      });
      if (target) plan.counts.autoLinked++; else plan.counts.toDecide++;
      continue;
    }
    const ids = Array.from(new Set([...e.ids, ...idsOf(prev.ez_ids)])).slice(0, MAX_IDS_PER_ROW);
    // ONLY the ezCater fact columns. `source` is left out on purpose: the column defaults to
    // 'auto' (20260919m) so Postgres accepts the insert tuple ON CONFLICT DO UPDATE builds, and
    // DO UPDATE sets only the columns named here, so every row keeps its own source.
    plan.refreshes.push({
      location_id: input.locationId, kind: e.kind, ez_key: e.ezKey,
      ez_name: s(prev.ez_name) || e.ezName,
      ez_size_name: e.ezSizeName, ez_only_size: onlySizeOf(e), ez_category: e.ezCategory, ez_ids: ids,
      synced_at: input.nowIso,
    });
    const prevItem = s(prev.menu_item_id) || null;
    const prevOption = s(prev.option_id) || null;
    const looseAuto = s(prev.source) === 'auto' && s(prev.matched_by) === 'name' && !!(prevItem || prevOption);
    if (isBare(prev) && target) {
      plan.fills.push({ kind: e.kind, ezKey: e.ezKey, menuItemId: target.menuItemId, optionId: target.optionId });
      plan.counts.autoLinked++;
    } else if (looseAuto && input.menuOk) {
      plan.rechecks.push({ kind: e.kind, ezKey: e.ezKey, was: { menuItemId: prevItem, optionId: prevOption },
        menuItemId: target ? target.menuItemId : null, optionId: target ? target.optionId : null });
      plan.counts.rechecked++;
      if (target) plan.counts.autoLinked++; else plan.counts.toDecide++;
    } else if (looseAuto) {
      // Our menu was read only in part: the loose link is left as it is, and order time does
      // not trust it (trustedTarget), so the line prints by name until a whole read decides it.
      plan.counts.toDecide++;
    } else if (!prevItem && !prevOption && s(prev.matched_by) !== 'ignored') {
      plan.counts.toDecide++;
    }
  }
  plan.counts.inserted = plan.inserts.length;
  plan.counts.refreshed = plan.refreshes.length;
  return plan;
}

// ── Order time ───────────────────────────────────────────────────────────────────────────────

/** Item rows by published id. A row read before the migration has no ids and adds nothing. */
export function indexPublishedIds(links: any): Map<string, any[]> {
  const idx = new Map<string, any[]>();
  for (const r of arr(links)) {
    if (!r || (s(r.kind) || 'item') !== 'item') continue;
    for (const id of idsOf(r.ez_ids ?? r.ezIds)) {
      const list = idx.get(id) || [];
      list.push(r);
      idx.set(id, list);
    }
  }
  return idx;
}

export type SizeRoute =
  | { mode: 'plain' }
  | { mode: 'synced'; ezKey: string; itemId: string | null }
  | { mode: 'unmatched'; reason: string };

/**
 * How one order line may be matched. PURE. See the rule at the top of this file.
 *   plain      no synced row holds this line's size id and the line has no size: the caller
 *              decides (a key lookup on synced rows first, then the old name rules)
 *   synced     a synced row (size or plain) holds the id and decides: its TRUSTED target
 *              (trustedTarget), or nothing when it has none
 *   unmatched  nothing decides; the line prints by name
 */
export function sizeRouteFor(line: any, idIdx: Map<string, any[]>): SizeRoute {
  // The SIZE id only (the order's menuItemSizeId IS the menu's sizes.id, proven on HKX77V, see
  // the top of this file). Never line.ezItemId: an order's item id is not the menu's item id.
  const id = s(line?.ezSizeId);
  const rows = id ? idIdx.get(id) || [] : [];
  if (rows.length) {
    const sized = rows.filter((r) => s(r.ez_size_name ?? r.ezSizeName));
    // The same id on a size row and a plain row: stale data, and a guess either way. Unmatched.
    if (sized.length && sized.length !== rows.length) return { mode: 'unmatched', reason: 'id on a plain row and a size row' };
    const targets = new Set(rows.map((r) => s(trustedTarget(r)?.menuItemId)));
    if (targets.size !== 1) return { mode: 'unmatched', reason: sized.length ? 'size rows disagree' : 'synced rows disagree' };
    const t = Array.from(targets)[0];
    return { mode: 'synced', ezKey: s(rows[0].ez_key ?? rows[0].ezKey), itemId: t || null };
  }
  if (s(line?.sizeName)) return { mode: 'unmatched', reason: id ? 'size id not on the synced menu' : 'sized line with no id' };
  return { mode: 'plain' };
}

// ── The database ─────────────────────────────────────────────────────────────────────────────

export const LINK_PAGE_SIZE = 1000;
export const LINK_MAX_PAGES = 50;

/** The link columns the matcher and the sync read, with and without the sync columns. */
export const LINK_COLUMNS = 'kind, ez_key, ez_name, ez_group, menu_item_id, option_id, source, matched_by, seen_count';
export const LINK_COLUMNS_WITH_SYNC = LINK_COLUMNS + ', ez_ids, ez_size_name, synced_at';

/** True when a read failed because the sync columns are not there yet (migration not run). */
export function isMissingSyncColumn(err: any): boolean {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || '') + ' ' + String(err.details || '');
  if (!/ez_ids|ez_size_name|ez_only_size|ez_category|synced_at/i.test(msg)) return false;
  // Proven only by Postgres' undefined column code, PostgREST's schema cache code, or its words.
  return code === '42703' || code === 'PGRST204'
    || /column\b.*\b(does not exist|could not find)|could not find the .*column/i.test(msg);
}

/**
 * True when a read failed because ezcater_item_links itself is not there (20260917 not run):
 * Postgres 42P01 or PostgREST PGRST205, naming that table. No table means no sync ever ran.
 */
export function isMissingLinksTable(err: any): boolean {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || '') + ' ' + String(err.details || '');
  if (!/ezcater_item_links/i.test(msg)) return false;
  return code === '42P01' || code === 'PGRST205'
    || /relation .*does not exist|could not find the table/i.test(msg);
}

/**
 * Every link row of one venue, PAGED: PostgREST caps a select at 1000 rows, and a venue with a
 * big synced menu passes that. `complete` is false when a page failed or the page cap was hit.
 */
export async function readAllLinks(
  sb: any, locationId: string, columns: string, deadline: number | null = null,
): Promise<{ rows: any[]; ok: boolean; complete: boolean; error: any }> {
  const rows: any[] = [];
  for (let page = 0; page < LINK_MAX_PAGES; page++) {
    if (deadline != null && Date.now() >= deadline) return { rows, ok: true, complete: false, error: null };
    const from = page * LINK_PAGE_SIZE;
    const { data, error } = await sb.from('ezcater_item_links').select(columns)
      .eq('location_id', locationId)
      .order('kind', { ascending: true }).order('ez_key', { ascending: true })
      .range(from, from + LINK_PAGE_SIZE - 1);
    if (error) return { rows, ok: false, complete: false, error };
    const batch = Array.isArray(data) ? data : [];
    rows.push(...batch);
    if (batch.length < LINK_PAGE_SIZE) return { rows, ok: true, complete: true, error: null };
  }
  return { rows, ok: true, complete: false, error: null };
}

/** Rows written per request. */
export const WRITE_CHUNK = 500;

/**
 * Write a plan. Inserts never overwrite (on conflict do nothing). Refreshes name only the ezCater
 * fact columns, so a decision a person saves mid sync is never touched. Fills repeat every
 * condition of an undecided row in their where clause, so a person who answered it first wins.
 */
export async function writeSyncPlan(sb: any, locationId: string, plan: SyncPlan, nowIso: string):
  Promise<{ inserted: number; refreshed: number; filled: number; rechecked: number; errors: string[] }> {
  const done = { inserted: 0, refreshed: 0, filled: 0, rechecked: 0, errors: [] as string[] };
  for (let i = 0; i < plan.inserts.length; i += WRITE_CHUNK) {
    const chunk = plan.inserts.slice(i, i + WRITE_CHUNK);
    const { error } = await sb.from('ezcater_item_links')
      .upsert(chunk, { onConflict: 'location_id,kind,ez_key', ignoreDuplicates: true });
    if (error) done.errors.push('insert: ' + (error.message || error)); else done.inserted += chunk.length;
  }
  for (let i = 0; i < plan.refreshes.length; i += WRITE_CHUNK) {
    const chunk = plan.refreshes.slice(i, i + WRITE_CHUNK);
    const { error } = await sb.from('ezcater_item_links')
      .upsert(chunk, { onConflict: 'location_id,kind,ez_key' });
    if (error) done.errors.push('refresh: ' + (error.message || error)); else done.refreshed += chunk.length;
  }
  for (const f of plan.fills) {
    const { error } = await sb.from('ezcater_item_links')
      .update({ menu_item_id: f.menuItemId, option_id: f.optionId, matched_by: EXACT_MATCHED_BY, updated_at: nowIso })
      .eq('location_id', locationId).eq('kind', f.kind).eq('ez_key', f.ezKey)
      .eq('source', 'auto').is('menu_item_id', null).is('option_id', null).is('matched_by', null);
    if (error) done.errors.push('fill: ' + (error.message || error)); else done.filled++;
  }
  for (const r of plan.rechecks || []) {
    const linked = !!(r.menuItemId || r.optionId);
    let q = sb.from('ezcater_item_links')
      .update({ menu_item_id: r.menuItemId, option_id: r.optionId, matched_by: linked ? EXACT_MATCHED_BY : null, updated_at: nowIso })
      .eq('location_id', locationId).eq('kind', r.kind).eq('ez_key', r.ezKey)
      .eq('source', 'auto').eq('matched_by', 'name');
    // Still exactly the loose link we read, or nothing changes: a person who saved first wins.
    q = r.was.menuItemId ? q.eq('menu_item_id', r.was.menuItemId) : q.is('menu_item_id', null);
    q = r.was.optionId ? q.eq('option_id', r.was.optionId) : q.is('option_id', null);
    const { error } = await q;
    if (error) done.errors.push('recheck: ' + (error.message || error)); else done.rechecked++;
  }
  return done;
}

/**
 * The one sync per venue lock. ezcater_menu_sync_claim (migration 20260919m) is a single
 * conditional upsert: it returns a claim id, or null when another sync of this venue is running
 * and started less than `staleSeconds` ago. Returns { claim: null, error } when the function is
 * not there (the migration has not been run).
 */
export async function claimSync(sb: any, locationId: string, reason: string, staleSeconds = 600):
  Promise<{ claim: string | null; error: any }> {
  const { data, error } = await sb.rpc('ezcater_menu_sync_claim', {
    p_location_id: locationId, p_reason: reason, p_stale_seconds: staleSeconds,
  });
  if (error) return { claim: null, error };
  return { claim: data ? String(data) : null, error: null };
}

/** Close a claim. Fenced on the claim id, so a sync that was taken over cannot overwrite the new one. */
export async function finishSync(sb: any, locationId: string, claim: string, status: string, counts: any, error: string | null) {
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = { status, finished_at: nowIso, counts, error, updated_at: nowIso };
  if (status === 'ok') patch.last_ok_at = nowIso;
  await sb.from('ezcater_menu_syncs').update(patch).eq('location_id', locationId).eq('claim_id', claim);
}
