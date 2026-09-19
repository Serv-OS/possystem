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
//   3. decides every AUTOMATIC row again from the whole menu (planMenuSync, review round 3): the
//      one exact name match of ours, or nothing. A changed or lost exact match is moved or
//      cleared. Everything else is left for staff, who get suggestions on the Item matching card.
//   It never deletes a row, never changes a staff decision (a staff match, "Not on our menu" or a
//   staff clear) and never touches seen_count. A staff decision whose ezCater name or size changed
//   since the staff saved it is shown to staff to look at again (decided_as, lookAgainOf), and
//   orders do not use it until they have.
//
// THE ORDER TIME RULE, once 20260919m has run (planSyncedLineMatches in ezcater-match-ingest.ts):
//   ORDERS ONLY USE MATCHES MADE BEFORE THE ORDER. A line matches only when its published SIZE id
//   (ezSizeId, which ezcater-map.ts takes from the order's menuItemSizeId) is on a synced row that
//   holds a trusted decision: a staff match, or an exact auto link a sync made (matched_by
//   'exact'). A customization likewise only by its published id on a synced option row. There is
//   NO name matching at order time at all: every other line, sized or not, prints by name and
//   writes no link. PROVEN on the live test order HKX77V (Claude, read only, 18 Sep 2026): its line
//   carried ezSizeId 0226b68c-492c-5a38-b528-fd62a1c1e828, and the menu read has exactly that id as
//   categories[0].items[1].sizes[0].id (size "Box", serves 1). The same line's item id (ezItemId
//   5f5b503b-...) was NEITHER the menu's item id (279b6bf4-...) NOR its originalItemId
//   (b4d95922-...), so an order's item id is never matched. Every HKX77V line carries a size id.
//   A customization's id (customizationId) has not been seen on a live order yet: if it is not the
//   menu's value id, no customization ever matches and every one prints by name, never a wrong one.
//   Before 20260919m runs the order time rules are exactly the ones on main.
//
// Pure functions first (tested under node), then the database and ezCater side. The ezCater call
// is passed in (ask), so nothing here needs Deno globals.

import { buildLinkKey } from './ezcaterMatch.ts';

const s = (v: unknown): string => (v == null ? '' : String(v).trim());
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

// ── Keys ─────────────────────────────────────────────────────────────────────────────────────

/** The size part of a size row key: lower case words, nothing stripped (a size IS the point). */
export function sizeKeyPart(sizeName: unknown): string {
  const t = s(sizeName).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
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
 * True when a single size item's only size says something its item name does not. "Box" adds
 * nothing to "Italian Boxed Lunch" (Box repeats Boxed); it does add to "Turkey Sandwich". A size
 * with no usable name adds nothing.
 */
export function sizeAddsWords(itemName: unknown, sizeName: unknown): boolean {
  const size = exactName(sizeName);
  if (!size) return false;
  const said = new Set(exactName(itemName).split(' ').filter(Boolean).map(foldWord));
  return size.split(' ').some((w) => !said.has(foldWord(w)));
}

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
  return sizeAddsWords(itemName, sizeName) ? `${item} ${exactName(sizeName)}` : item;
}

/** The parts of one row's (or one menu entry's) ezCater name, as the Item matching card shows them. */
export interface NameParts {
  kind: 'item' | 'option';
  name: string;
  /** The customization group (options only). */
  group?: string;
  /** The size of a SIZE row (one size of an item with several). */
  sizeName?: string;
  /** The one size of a single size item, on its plain row. */
  onlySize?: string;
}

/**
 * The FULL ezCater name of a row, readable: what a person sees, what decided_as stores, and (in
 * its exact form, fullExactOf) what "the name changed" compares.
 *   option     '<group>: <value>' (the value alone when there is no group)
 *   size row   '<item> <size>'
 *   plain row  '<item> <only size>' when that size says something the item name does not, else '<item>'
 */
export function fullNameOf(p: NameParts): string {
  const name = s(p?.name);
  if (p?.kind === 'option') {
    const group = s(p.group);
    return group ? `${group}: ${name}` : name;
  }
  if (s(p?.sizeName)) return `${name} ${s(p.sizeName)}`;
  if (s(p?.onlySize) && sizeAddsWords(name, p.onlySize)) return `${name} ${s(p.onlySize)}`;
  return name;
}

/** The exact form of fullNameOf. Two rows with the same one are the same product by name. */
export function fullExactOf(p: NameParts): string {
  return exactName(fullNameOf(p));
}

/** A stored ezcater_item_links row's name parts (snake_case, or camelCase). */
export function rowNameParts(row: any): NameParts {
  const kind: 'item' | 'option' = s(row?.kind) === 'option' ? 'option' : 'item';
  const key = s(row?.ez_key ?? row?.ezKey);
  const size = kind === 'item' ? s(row?.ez_size_name ?? row?.ezSizeName) : '';
  const sizeRow = !!size && key.includes('|size:');
  return {
    kind,
    name: s(row?.ez_name ?? row?.ezName),
    group: kind === 'option' ? s(row?.ez_group ?? row?.ezGroup) : '',
    sizeName: sizeRow ? size : '',
    onlySize: kind === 'item' && !sizeRow ? s(row?.ez_only_size ?? row?.ezOnlySize) : '',
  };
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
   * is sold only as a Box. It is part of the full name (fullNameOf) an auto link compares.
   */
  ezOnlySize?: string | null;
  ezCategory: string | null;
  /** Published ids: a size id for an item row, a value id for an option row. */
  ids: string[];
  /**
   * The full EXACT name an auto link compares: '<item> <size>' for a size row,
   * singleSizeExactName for a plain row, the value for an option (whose group is compared on its
   * own, autoTargetFor). '' links nothing.
   */
  exactName?: string;
  /**
   * Never auto linked: a size row whose full name a sibling shares, or a row the menus describe
   * two different ways (the same key with two different full names).
   */
  noAuto: boolean;
}

/** An entry's name parts. */
export function entryNameParts(e: MenuEntry): NameParts {
  return {
    kind: e.kind,
    name: s(e.ezName),
    group: e.kind === 'option' ? s(e.ezGroup) : '',
    sizeName: e.kind === 'item' ? s(e.ezSizeName) : '',
    onlySize: e.kind === 'item' && !s(e.ezSizeName) ? s(e.ezOnlySize) : '',
  };
}

/**
 * Every row a sync writes, deduplicated by kind and key (ids unioned), in menu order. PURE.
 *   an item with 0 or 1 size  -> ONE plain row, keyed by name exactly as an order line is
 *   an item with 2+ sizes     -> one row PER SIZE, keyed sizeRowKey(item, size)
 *   every option value        -> one option row, keyed as an order customization is
 * One key described two different ways (two current menus, or two names the key folds together,
 * "Sandwich Platter" and "Sandwich Platter Tray") is one row that is never auto linked; the row
 * shows the description whose full exact name sorts first, so it reads the same whatever order
 * ezCater lists the menus in.
 */
export function flattenMenus(menus: any): MenuEntry[] {
  const out = new Map<string, MenuEntry>();
  const put = (e: MenuEntry) => {
    const k = e.kind + ':' + e.ezKey;
    const prev = out.get(k);
    if (!prev) { out.set(k, { ...e, ids: Array.from(new Set(e.ids)) }); return; }
    for (const id of e.ids) if (!prev.ids.includes(id)) prev.ids.push(id);
    const a = fullExactOf(entryNameParts(prev));
    const b = fullExactOf(entryNameParts(e));
    // One key, two different full names: which one is ours is a guess, so neither is auto linked.
    prev.noAuto = prev.noAuto || e.noAuto || a !== b || (prev.exactName || '') !== (e.exactName || '');
    if (b < a) {
      prev.ezName = e.ezName; prev.ezGroup = e.ezGroup; prev.ezSizeName = e.ezSizeName;
      prev.ezOnlySize = e.ezOnlySize; prev.ezCategory = e.ezCategory; prev.exactName = e.exactName;
    }
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
  return fullExactOf(entryNameParts(entry));
}

/**
 * Our target for one synced row, or null. EXACT MEANS EXACT.
 *   item (plain or size)  exactly ONE of our items whose name (or menu name) has the SAME exact
 *                         name as the row's full name: item name plus its size, see
 *                         singleSizeExactName. Any size or container word on one side only
 *                         ("Large", "Small", "Tray", "Box") means different names, so no link.
 *   option                exactly ONE of our options whose GROUP has the same exact name as the
 *                         ezCater customization group AND whose own name is the same exact name
 *                         as the value (review round 3): "Bread: White" is never our "White" in
 *                         the Cheese group. A value with no group links nothing.
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
    const wantGroup = exactName(entry.ezGroup);
    if (!wantGroup) return null;
    const hits = new Map<string, any>();
    for (const g of arr(ourGroups)) {
      if (!ourNamesOf(g).some((n) => exactName(n) === wantGroup)) continue;
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

// ── Decisions ────────────────────────────────────────────────────────────────────────────────

const idsOf = (v: unknown): string[] => arr(v).map((x) => s(x)).filter(Boolean);

/** matched_by on an auto link a SYNC wrote by the exact rule. The order time name rule wrote 'name'. */
export const EXACT_MATCHED_BY = 'exact';

/** A row a menu sync wrote or refreshed: it carries published ids or a synced_at stamp. */
export function isSyncedRow(row: any): boolean {
  if (!row) return false;
  return idsOf(row.ez_ids ?? row.ezIds).length > 0 || !!s(row.synced_at ?? row.syncedAt);
}

/**
 * The decision on a row that may route food at order time, or null:
 *   a staff match (source 'manual' with a target) whose ezCater name and size are still the ones
 *   the person saw when they saved it (lookAgainOf), or
 *   an EXACT auto link (source 'auto', matched_by 'exact', written by a sync)
 * An auto link the old order time name rule made (matched_by 'name') is NOT one: it was made with
 * size words dropped. A staff match whose name or size changed since is not one UNTIL staff look
 * at it again ("Still right" on the Item matching card): the decision itself is never changed, but
 * a "Caesar Salad" matched as Regular must not route the Large ezCater now sells under that name.
 * "Not on our menu" and a staff clear have no target, so they are null too.
 */
export function trustedTarget(row: any): { menuItemId: string | null; optionId: string | null } | null {
  if (!row) return null;
  const menuItemId = s(row.menu_item_id ?? row.menuItemId) || null;
  const optionId = s(row.option_id ?? row.optionId) || null;
  if (!menuItemId && !optionId) return null;
  const source = s(row.source);
  if (source === 'manual') return lookAgainOf(row).lookAgain ? null : { menuItemId, optionId };
  if (source === 'auto' && s(row.matched_by ?? row.matchedBy) === EXACT_MATCHED_BY) return { menuItemId, optionId };
  return null;
}

/** The decision columns of a row, exactly as read: what a guarded write compares. */
export interface Decision { menuItemId: string | null; optionId: string | null; matchedBy: string | null }
export function decisionOf(row: any): Decision {
  return {
    menuItemId: s(row?.menu_item_id ?? row?.menuItemId) || null,
    optionId: s(row?.option_id ?? row?.optionId) || null,
    matchedBy: s(row?.matched_by ?? row?.matchedBy) || null,
  };
}

const isStaffRow = (row: any) => s(row?.source) === 'manual';

/** A person's decision: a match, or "Not on our menu". A staff clear is not one. */
export function isStaffDecision(row: any): boolean {
  if (!isStaffRow(row)) return false;
  const d = decisionOf(row);
  return !!(d.menuItemId || d.optionId) || d.matchedBy === 'ignored';
}

/**
 * LOOK AGAIN (review round 3). A staff decision is never changed by a sync, but when the ezCater
 * name or size it was made for has changed since (decided_as, what the staff saw, against the
 * row's full name now), staff are asked to look at it again on the Item matching card, and until
 * they do, orders do not use it (trustedTarget): those lines print by name. A row with nothing
 * recorded (decided before 20260919m, until its first sync records it) is not flagged.
 */
export function lookAgainOf(row: any): { lookAgain: boolean; was: string | null; now: string } {
  const now = fullNameOf(rowNameParts(row));
  const saw = s(row?.decided_as ?? row?.decidedAs);
  if (!isStaffDecision(row) || !saw) return { lookAgain: false, was: saw || null, now };
  return { lookAgain: exactName(saw) !== exactName(now), was: saw, now };
}

// ── The plan ─────────────────────────────────────────────────────────────────────────────────

export interface SyncPlan {
  /** New rows, written insert only (on conflict do nothing): a racing save wins. */
  inserts: any[];
  /** Existing rows: the ezCater facts only (names, ids, size, category, synced_at). Never a decision. */
  refreshes: any[];
  /**
   * AUTOMATIC rows decided again (review round 3, every one, not only old name links): set to the
   * one exact match of ours, moved to it, or cleared. Guarded on the decision as read, so a person
   * who saved first wins. Written BEFORE the refresh, and a row whose write fails is not refreshed,
   * so new published ids never land on a row still holding an old decision.
   */
  redecides: { kind: string; ezKey: string; was: Decision; menuItemId: string | null; optionId: string | null; matchedBy: string | null }[];
  /**
   * Staff decisions with nothing recorded of what the staff saw (made before 20260919m): the name
   * the row showed before this sync, recorded BEFORE the refresh changes it. Guarded on the
   * decision as read and on decided_as still being empty.
   */
  baselines: { kind: string; ezKey: string; was: Decision; decidedAs: string }[];
  counts: {
    items: number; sizes: number; options: number; inserted: number; refreshed: number;
    autoLinked: number; toDecide: number; redecided: number; cleared: number; lookAgain: number;
  };
}

/** Published ids kept per row, newest first. Only reached after this many republishes. */
export const MAX_IDS_PER_ROW = 200;

/** A plain row's single size name for display (ez_only_size); null on size and option rows. */
const onlySizeOf = (e: MenuEntry): string | null =>
  (e.kind === 'item' && !e.ezSizeName ? (s(e.ezOnlySize) || null) : null);

/** A stored row as an entry, for rows this read did not cover. */
function storedEntry(row: any): MenuEntry {
  const p = rowNameParts(row);
  return {
    kind: p.kind, ezKey: s(row?.ez_key), ezName: p.name, ezGroup: p.kind === 'option' ? (p.group || null) : null,
    ezSizeName: p.sizeName || null, ezOnlySize: p.onlySize || null, ezCategory: null, ids: [],
    exactName: p.kind === 'option' ? exactName(p.name) : fullExactOf(p), noAuto: false,
  };
}

const sameDecision = (a: Decision, b: Decision) =>
  a.menuItemId === b.menuItemId && a.optionId === b.optionId && a.matchedBy === b.matchedBy;

/**
 * What a sync writes. PURE.
 *
 * IDS: every sync keeps the ids already on a row and puts the newly published ones first, so an
 * order placed before the caterer republished (same item, new ids) still finds its row when
 * ezCater later sends a change to it. The one exception: when the row's FULL name changed (a new
 * only size, a renamed item under the same key), the old ids were published for a different
 * product and are dropped, so an old "Caesar Salad Regular" order can never route to what the row
 * now holds for "Caesar Salad Large". A partial read never takes an id away otherwise.
 *
 * DECISIONS (review round 3):
 *   an automatic row covered by this read   decided again from the whole of our menu: the one
 *                                           exact match (kept, moved to, or set), else cleared
 *   an automatic row this read did not cover  (synced before) kept only when its stored name is
 *                                           still exactly one item of ours, the one it points
 *                                           at; otherwise cleared. Never moved or newly linked.
 *   a staff decision                        never touched; flagged for staff when its name or
 *                                           size changed since they saved it (lookAgainOf)
 * `menuOk` false (our own menu was only partly read) links nothing new; an exact link whose
 * ezCater name changed is still cleared, because what it was made for is gone.
 */
export function planMenuSync(input: {
  entries: MenuEntry[]; existing: any[]; ourItems: any[]; ourGroups: any[];
  locationId: string; nowIso: string; complete: boolean; menuOk: boolean;
}): SyncPlan {
  const kindOf = (r: any) => (s(r?.kind) === 'option' ? 'option' : 'item');
  const byKey = new Map<string, any>();
  for (const r of arr(input.existing)) if (r && s(r.ez_key)) byKey.set(kindOf(r) + ':' + s(r.ez_key), r);
  const plan: SyncPlan = {
    inserts: [], refreshes: [], redecides: [], baselines: [],
    counts: { items: 0, sizes: 0, options: 0, inserted: 0, refreshed: 0, autoLinked: 0, toDecide: 0, redecided: 0, cleared: 0, lookAgain: 0 },
  };
  const decide = (target: { menuItemId: string | null; optionId: string | null } | null): Decision => (target
    ? { menuItemId: target.menuItemId, optionId: target.optionId, matchedBy: EXACT_MATCHED_BY }
    : { menuItemId: null, optionId: null, matchedBy: null });
  const redecide = (e: { kind: string; ezKey: string }, was: Decision, next: Decision) => {
    plan.redecides.push({ kind: e.kind, ezKey: e.ezKey, was, ...next });
    if ((was.menuItemId || was.optionId) && !next.menuItemId && !next.optionId) plan.counts.cleared++;
  };
  const covered = new Set<string>();

  for (const e of arr(input.entries) as MenuEntry[]) {
    const k = e.kind + ':' + e.ezKey;
    if (covered.has(k)) continue;
    covered.add(k);
    if (e.kind === 'option') plan.counts.options++;
    else if (e.ezSizeName) plan.counts.sizes++;
    else plan.counts.items++;
    const target = input.menuOk ? autoTargetFor(e, input.ourItems, input.ourGroups) : null;
    const view = {
      ez_name: e.ezName, ez_group: e.kind === 'option' ? (e.ezGroup || null) : null,
      ez_size_name: e.ezSizeName, ez_only_size: onlySizeOf(e), ez_category: e.ezCategory,
    };
    const prev = byKey.get(k);
    if (!prev) {
      plan.inserts.push({
        location_id: input.locationId, kind: e.kind, ez_key: e.ezKey, ...view,
        ez_ids: Array.from(new Set(e.ids)).slice(0, MAX_IDS_PER_ROW),
        menu_item_id: target ? target.menuItemId : null, option_id: target ? target.optionId : null,
        source: 'auto', matched_by: target ? EXACT_MATCHED_BY : null,
        seen_count: 0, last_seen_at: null, synced_at: input.nowIso, updated_at: input.nowIso,
      });
      if (target) plan.counts.autoLinked++; else plan.counts.toDecide++;
      continue;
    }

    const nowExact = fullExactOf(entryNameParts(e));
    const wasExact = fullExactOf(rowNameParts(prev));
    const changed = nowExact !== wasExact;
    const ids = changed ? e.ids : [...e.ids, ...idsOf(prev.ez_ids)];
    // ONLY the ezCater fact columns. `source` is left out on purpose: the column defaults to
    // 'auto' (20260919m) so Postgres accepts the insert tuple ON CONFLICT DO UPDATE builds, and
    // DO UPDATE sets only the columns named here, so every row keeps its own source and decision.
    plan.refreshes.push({
      location_id: input.locationId, kind: e.kind, ez_key: e.ezKey, ...view,
      ez_ids: Array.from(new Set(ids)).slice(0, MAX_IDS_PER_ROW), synced_at: input.nowIso,
    });

    const was = decisionOf(prev);
    if (isStaffRow(prev)) {
      // A person decided (or cleared) this row: never changed here.
      if (isStaffDecision(prev)) {
        const saw = s(prev.decided_as);
        if (!saw) plan.baselines.push({ kind: e.kind, ezKey: e.ezKey, was, decidedAs: fullNameOf(rowNameParts(prev)) });
        if ((saw ? exactName(saw) : wasExact) !== nowExact) plan.counts.lookAgain++;
      } else {
        plan.counts.toDecide++;
      }
      continue;
    }

    // An automatic row: decided again.
    if (input.menuOk) {
      const next = decide(target);
      if (!sameDecision(was, next)) redecide(e, was, next);
      if (target) plan.counts.autoLinked++; else plan.counts.toDecide++;
      continue;
    }
    // Our menu was read only in part: nothing new is linked. An exact link whose ezCater name
    // changed has lost what it was made for, so it is cleared; the next whole read decides it.
    // Anything else waits (an old name link is never used at order time anyway).
    if ((was.menuItemId || was.optionId) && was.matchedBy === EXACT_MATCHED_BY && changed) {
      redecide(e, was, decide(null));
      plan.counts.toDecide++;
    } else if ((was.menuItemId || was.optionId) && was.matchedBy === EXACT_MATCHED_BY) {
      plan.counts.autoLinked++;
    } else {
      plan.counts.toDecide++;
    }
  }

  // Automatic rows this read did not cover (off the current menus, or a caterer that did not
  // answer): only synced rows, only with our whole menu. Kept while their stored name is still
  // exactly the one item of ours they point at (our item renamed or gone: cleared).
  if (input.menuOk) {
    for (const [k, prev] of byKey) {
      if (covered.has(k) || isStaffRow(prev) || !isSyncedRow(prev)) continue;
      const was = decisionOf(prev);
      if (!was.menuItemId && !was.optionId) continue;
      const target = was.matchedBy === EXACT_MATCHED_BY ? autoTargetFor(storedEntry(prev), input.ourItems, input.ourGroups) : null;
      const keep = !!target && target.menuItemId === was.menuItemId && target.optionId === was.optionId;
      if (!keep) redecide({ kind: kindOf(prev), ezKey: s(prev.ez_key) }, was, decide(null));
    }
  }

  plan.counts.inserted = plan.inserts.length;
  plan.counts.refreshed = plan.refreshes.length;
  plan.counts.redecided = plan.redecides.length;
  return plan;
}

// ── Order time ───────────────────────────────────────────────────────────────────────────────

/** Rows of one kind by published id. A row read before the migration has no ids and adds nothing. */
export function indexPublishedIds(links: any, kind: 'item' | 'option' = 'item'): Map<string, any[]> {
  const idx = new Map<string, any[]>();
  for (const r of arr(links)) {
    if (!r || (s(r.kind) || 'item') !== kind) continue;
    for (const id of idsOf(r.ez_ids ?? r.ezIds)) {
      const list = idx.get(id) || [];
      list.push(r);
      idx.set(id, list);
    }
  }
  return idx;
}

export type SizeRoute =
  | { mode: 'synced'; ezKey: string; itemId: string | null }
  | { mode: 'unmatched'; reason: string };

/**
 * How one order line is matched once 20260919m has run. PURE. There is no other way.
 *   synced     the synced row holding the line's published SIZE id decides: its trusted target
 *              (trustedTarget), or nothing when it has none (the line prints by name)
 *   unmatched  no size id, a size id on no synced row, or rows that disagree: prints by name
 * Never the line's name, never its item id, never a posItemId.
 */
export function sizeRouteFor(line: any, idIdx: Map<string, any[]>): SizeRoute {
  // The SIZE id only (the order's menuItemSizeId IS the menu's sizes.id, proven on HKX77V, see
  // the top of this file). Never line.ezItemId: an order's item id is not the menu's item id.
  const id = s(line?.ezSizeId);
  if (!id) return { mode: 'unmatched', reason: 'no size id' };
  const rows = idIdx.get(id) || [];
  if (!rows.length) return { mode: 'unmatched', reason: 'size id not on the synced menu' };
  const sized = rows.filter((r) => s(r.ez_size_name ?? r.ezSizeName));
  // The same id on a size row and a plain row: stale data, and a guess either way. Unmatched.
  if (sized.length && sized.length !== rows.length) return { mode: 'unmatched', reason: 'id on a plain row and a size row' };
  const targets = new Set(rows.map((r) => s(trustedTarget(r)?.menuItemId)));
  if (targets.size !== 1) return { mode: 'unmatched', reason: sized.length ? 'size rows disagree' : 'synced rows disagree' };
  const t = Array.from(targets)[0];
  return { mode: 'synced', ezKey: s(rows[0].ez_key ?? rows[0].ezKey), itemId: t || null };
}

export type OptionRoute =
  | { mode: 'synced'; ezKey: string; optionId: string | null; itemId: string | null }
  | { mode: 'unmatched'; reason: string };

/**
 * How one customization is matched once 20260919m has run. PURE. By its published id only
 * (ezItemId, which ezcater-map.ts takes from the order's customizationId) on a synced option row
 * with a trusted decision. Never its name or group.
 */
export function optionRouteFor(mod: any, optIdx: Map<string, any[]>): OptionRoute {
  const id = s(mod?.ezItemId);
  if (!id) return { mode: 'unmatched', reason: 'no customization id' };
  const rows = optIdx.get(id) || [];
  if (!rows.length) return { mode: 'unmatched', reason: 'customization id not on the synced menu' };
  const answers = new Set(rows.map((r) => {
    const t = trustedTarget(r);
    return (t?.optionId || '') + '|' + (t?.menuItemId || '');
  }));
  if (answers.size !== 1) return { mode: 'unmatched', reason: 'option rows disagree' };
  const t = trustedTarget(rows[0]);
  return { mode: 'synced', ezKey: s(rows[0].ez_key ?? rows[0].ezKey), optionId: t?.optionId || null, itemId: t?.menuItemId || null };
}

// ── The database ─────────────────────────────────────────────────────────────────────────────

export const LINK_PAGE_SIZE = 1000;
export const LINK_MAX_PAGES = 50;

/** The link columns the matcher and the sync read, with and without the sync columns. */
export const LINK_COLUMNS = 'kind, ez_key, ez_name, ez_group, menu_item_id, option_id, source, matched_by, seen_count';
export const LINK_COLUMNS_WITH_SYNC = LINK_COLUMNS + ', ez_ids, ez_size_name, ez_only_size, synced_at, decided_as';

/** True when a read failed because the sync columns are not there yet (migration not run). */
export function isMissingSyncColumn(err: any): boolean {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || '') + ' ' + String(err.details || '');
  if (!/ez_ids|ez_size_name|ez_only_size|ez_category|synced_at|decided_as/i.test(msg)) return false;
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
/** Single row updates in flight at once. */
export const UPDATE_BATCH = 8;

/** Where a guarded update repeats the decision it read: equal, or still empty. */
function guardDecision(q: any, was: Decision): any {
  let out = was.menuItemId ? q.eq('menu_item_id', was.menuItemId) : q.is('menu_item_id', null);
  out = was.optionId ? out.eq('option_id', was.optionId) : out.is('option_id', null);
  out = was.matchedBy ? out.eq('matched_by', was.matchedBy) : out.is('matched_by', null);
  return out;
}

async function inBatches<T>(list: T[], run: (x: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < list.length; i += UPDATE_BATCH) await Promise.all(list.slice(i, i + UPDATE_BATCH).map(run));
}

/**
 * Write a plan, in this order:
 *   1. baselines  what the staff saw, recorded before the refresh changes the names
 *   2. redecides  automatic rows decided again, before the refresh adds new published ids
 *   3. inserts    never overwrite (on conflict do nothing)
 *   4. refreshes  name only the ezCater fact columns, so a decision a person saves mid sync is
 *                 never touched. A row whose baseline or decision write FAILED is not refreshed:
 *                 its old names and ids stay with its old decision until the next sync.
 * Every guarded update repeats the decision it read, so a person who saved first wins.
 */
export async function writeSyncPlan(sb: any, locationId: string, plan: SyncPlan, nowIso: string):
  Promise<{ inserted: number; refreshed: number; redecided: number; baselined: number; errors: string[] }> {
  const done = { inserted: 0, refreshed: 0, redecided: 0, baselined: 0, errors: [] as string[] };
  const held = new Set<string>();
  const errText = (e: any) => String(e?.message || e);

  await inBatches(plan.baselines || [], async (b) => {
    const q = sb.from('ezcater_item_links').update({ decided_as: b.decidedAs })
      .eq('location_id', locationId).eq('kind', b.kind).eq('ez_key', b.ezKey)
      .eq('source', 'manual').is('decided_as', null);
    const { error } = await guardDecision(q, b.was);
    if (error) { done.errors.push('baseline: ' + errText(error)); held.add(b.kind + ':' + b.ezKey); } else done.baselined++;
  });
  await inBatches(plan.redecides || [], async (r) => {
    const q = sb.from('ezcater_item_links')
      .update({ menu_item_id: r.menuItemId, option_id: r.optionId, matched_by: r.matchedBy, updated_at: nowIso })
      .eq('location_id', locationId).eq('kind', r.kind).eq('ez_key', r.ezKey).eq('source', 'auto');
    const { error } = await guardDecision(q, r.was);
    if (error) { done.errors.push('decide: ' + errText(error)); held.add(r.kind + ':' + r.ezKey); } else done.redecided++;
  });
  for (let i = 0; i < plan.inserts.length; i += WRITE_CHUNK) {
    const chunk = plan.inserts.slice(i, i + WRITE_CHUNK);
    const { error } = await sb.from('ezcater_item_links')
      .upsert(chunk, { onConflict: 'location_id,kind,ez_key', ignoreDuplicates: true });
    if (error) done.errors.push('insert: ' + errText(error)); else done.inserted += chunk.length;
  }
  const refreshes = plan.refreshes.filter((r) => !held.has(r.kind + ':' + r.ez_key));
  for (let i = 0; i < refreshes.length; i += WRITE_CHUNK) {
    const chunk = refreshes.slice(i, i + WRITE_CHUNK);
    const { error } = await sb.from('ezcater_item_links')
      .upsert(chunk, { onConflict: 'location_id,kind,ez_key' });
    if (error) done.errors.push('refresh: ' + errText(error)); else done.refreshed += chunk.length;
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
