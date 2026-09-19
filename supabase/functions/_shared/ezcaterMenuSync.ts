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
// EXACT BY CONSTRUCTION (review round 4). Every row a sync writes is keyed by the EXACT FULL NAME
// of one ezCater product, never by a folded name:
//   an item    'exact:' + exactName(item name + ' ' + its size)   (a multi size item's size, or a
//              single size item's only size; no size, the item name alone)
//   an option  'exact:' + exactName(group) + '|' + exactName(value)
// exactName folds only case, accents, apostrophes, '&' and spacing or punctuation. Nothing else is
// dropped: no tray, pan, box, serves, bracketed part or size word. So two ezCater products whose
// names differ by any word are two rows, with their own published ids and their own decision, and
// no decision can ever reach a product it was not made for. ("Caesar Salad" and "Caesar Salad
// (Serves 20)", "Sandwich Platter" and "Sandwich Platter Tray", "Bread: White" and "Bread Size:
// White" were one row each under the old folded keys.) A row's exact full name never changes, so
// its ids are only ever added to: a rename on ezCater is a NEW row.
//
// WHAT A SYNC DOES, AND NOTHING MORE
//   1. reads the CURRENT menus (venue date, venue clock) of every caterer mapped to the venue
//   2. writes one row per exact full name, carrying the ids ezCater published it under (ez_ids)
//   3. decides every AUTOMATIC row again from the whole of our menu: the one exact name match of
//      ours, or nothing (planMenuSync)
//   4. a NEW row gets the staff decision saved on the row ezCater's item had before the sync
//      existed (the old key rules), exactly as it was when the names are exactly the same, else
//      marked for staff to look again (lookAgainOf); orders do not use it until they have
//   It never deletes a row, never changes a staff decision, never touches seen_count, and never
//   writes a row saved before the sync: those stay as they were, readable, and orders never use
//   them once 20260919m has run.
//
// THE ORDER TIME RULE, once 20260919m has run (planSyncedLineMatches in ezcater-match-ingest.ts):
//   ORDERS ONLY USE MATCHES MADE BEFORE THE ORDER, AND ONLY FOR THE EXACT NAME THEY WERE MADE FOR.
//   A line matches only when exactName(its name + ' ' + its size name) IS a synced row's exact
//   full name, AND its published SIZE id (ezSizeId, which ezcater-map.ts takes from the order's
//   menuItemSizeId) is on that row, AND the row holds a trusted decision: a staff match, or an
//   exact auto link a sync made (matched_by 'exact'). A customization likewise, by its group and
//   value and its published id (customizationId). No guessing from a name: every other line
//   prints by name and writes no link. The name check also closes the window after ezCater renames
//   a size in place (same id, new name) before the next sync: the new name has no row yet.
//   PROVEN on the live test order HKX77V (Claude, read only, 18 Sep 2026): its line carried
//   ezSizeId 0226b68c-492c-5a38-b528-fd62a1c1e828, and the menu read has exactly that id as
//   categories[0].items[1].sizes[0].id (size "Box", serves 1). The same line's item id (ezItemId
//   5f5b503b-...) was NEITHER the menu's item id (279b6bf4-...) NOR its originalItemId
//   (b4d95922-...), so an order's item id is never matched. Every HKX77V line carries a size id.
//   A customization's id (customizationId) has not been seen on a live order yet: if it is not the
//   menu's value id, no customization ever matches and every one prints by name, never a wrong one.
//   Before 20260919m runs the order time rules are exactly the ones on main.
//
// Pure functions first (tested under node), then the database and ezCater side. The ezCater call
// is passed in (ask), so nothing here needs Deno globals.

import { linkKeyCandidates } from './ezcaterMatch.ts';

const s = (v: unknown): string => (v == null ? '' : String(v).trim());
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

// ── Exact names ──────────────────────────────────────────────────────────────────────────────

/**
 * The EXACT form of a name, the only form a synced row is keyed by and an auto link compares:
 * lower case, accents off, '&' read as 'and', apostrophes dropped, every other run of punctuation
 * or space one space. NOTHING else is dropped: no size word, no container word (tray, pan, box),
 * no "serves 10", no bracketed part. The scorer and the order time name rules before 20260919m
 * (normaliseItemName, normaliseKeyName) drop some of those on purpose to FIND candidates; a synced
 * row must not, because the dropped word is exactly what tells "Sandwich Platter Large" from our
 * "Sandwich Platter".
 */
export function exactName(value: unknown): string {
  return s(value).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ').replace(/['\u2018\u2019\u02bc`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Every synced row's key starts with this. No key the rules before the sync build can (they hold only letters, digits, spaces and '|'). */
export const SYNC_KEY_PREFIX = 'exact:';

/**
 * The exact full name of an ezCater item as it is sold: the item name plus its size (a multi size
 * item's size, or a single size item's only size), through exactName. '' when the item has no
 * usable name. An order line is the same thing: its name plus its size name (lineIdentity).
 */
export function itemIdentity(itemName: unknown, sizeName: unknown): string {
  if (!exactName(itemName)) return '';
  return exactName(`${s(itemName)} ${s(sizeName)}`);
}

/**
 * The exact full name of an option: its group and its value, each through exactName, kept apart
 * by '|' (which exactName never leaves), so "Bread White: Roll" is never "Bread: White Roll".
 * '' when the value has no usable name.
 */
export function optionIdentity(group: unknown, value: unknown): string {
  const v = exactName(value);
  return v ? `${exactName(group)}|${v}` : '';
}

/** The key of the synced row for one exact full name. '' for no name. */
export function syncKeyOf(identity: string): string {
  return identity ? SYNC_KEY_PREFIX + identity : '';
}

/** True for a key a menu sync wrote. */
export function isSyncKey(key: unknown): boolean {
  const k = typeof key === 'string' ? key : '';
  return k.startsWith(SYNC_KEY_PREFIX) && k.length > SYNC_KEY_PREFIX.length;
}

/** The exact full name a synced row is keyed by, '' for any other row. */
export function identityOfKey(key: unknown): string {
  return isSyncKey(key) ? String(key).slice(SYNC_KEY_PREFIX.length) : '';
}

/** An order line's exact full name: its name plus its size name. What its synced row must be keyed by. */
export function lineIdentity(line: any): string {
  return itemIdentity(line?.name, line?.sizeName);
}

/** A customization's exact full name: its group and its value. */
export function modIdentity(mod: any): string {
  return optionIdentity(mod?.groupLabel ?? mod?.customizationTypeName, mod?.label ?? mod?.name);
}

/**
 * Container words in their plural and "-ed" forms, folded to one word, used ONLY to tell whether a
 * single size item's size name repeats what its item name already says ("Boxed" and "Box"), for
 * the AUTO LINK comparison. Never in a key.
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
 * The name a single size item AUTO LINKS by (never its key): '<item> <only size>', except that a
 * size name whose every word the item name already says adds nothing. "Italian Boxed Lunch" sold
 * only as "Box" auto links our "Italian Boxed Lunch" (Box repeats Boxed); "Turkey Sandwich" sold
 * only as "Box" auto links only our "Turkey Sandwich Box". '' when the item has no usable name.
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
  /** The size of one size of an item with several. */
  sizeName?: string;
  /** The one size of a single size item. */
  onlySize?: string;
}

/**
 * The FULL ezCater name of a row, readable: what a person sees and what decided_as stores. Its
 * exact form is the row's exact full name (identityOfParts), so nothing is left out:
 *   option     '<group>: <value>' (the value alone when there is no group)
 *   item       '<item> <size>' for a size of an item with several, '<item> <only size>' for a
 *              single size item, else '<item>'
 */
export function fullNameOf(p: NameParts): string {
  const name = s(p?.name);
  if (p?.kind === 'option') {
    const group = s(p.group);
    return group ? `${group}: ${name}` : name;
  }
  const size = s(p?.sizeName) || s(p?.onlySize);
  return size ? `${name} ${size}` : name;
}

/** The exact full name of a row's or an entry's parts: what its key is built from. */
export function identityOfParts(p: NameParts): string {
  if (p?.kind === 'option') return optionIdentity(p.group, p.name);
  return itemIdentity(p?.name, s(p?.sizeName) || s(p?.onlySize));
}

/**
 * The exact full name of a readable full name as fullNameOf writes it (decided_as, what a person
 * saw). An option's is split at its first ': ' into group and value.
 */
export function shownIdentity(kind: string, shown: unknown): string {
  const text = s(shown);
  if (kind !== 'option') return exactName(text);
  const at = text.indexOf(': ');
  return at >= 0 ? optionIdentity(text.slice(0, at), text.slice(at + 2)) : optionIdentity('', text);
}

/** A stored ezcater_item_links row's name parts (snake_case, or camelCase). */
export function rowNameParts(row: any): NameParts {
  const kind: 'item' | 'option' = s(row?.kind) === 'option' ? 'option' : 'item';
  const size = kind === 'item' ? s(row?.ez_size_name ?? row?.ezSizeName) : '';
  return {
    kind,
    name: s(row?.ez_name ?? row?.ezName),
    group: kind === 'option' ? s(row?.ez_group ?? row?.ezGroup) : '',
    sizeName: size,
    onlySize: kind === 'item' && !size ? s(row?.ez_only_size ?? row?.ezOnlySize) : '',
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
  /** 'exact:' + the exact full name (syncKeyOf). */
  ezKey: string;
  ezName: string;
  ezGroup: string | null;
  /** Set only on a row for ONE size of an item with several sizes. */
  ezSizeName: string | null;
  /**
   * The name of the ONE size of a single size item. Shown to staff (ez_only_size), so nobody
   * matches "Turkey Sandwich" without seeing it is sold only as a Box, and part of the row's
   * exact full name.
   */
  ezOnlySize?: string | null;
  ezCategory: string | null;
  /** Published ids: a size id for an item row, a value id for an option row. */
  ids: string[];
  /**
   * The name an AUTO LINK compares with ours: exactName('<item> <size>') for a size of an item
   * with several, singleSizeExactName for a single size item, the value for an option (whose
   * group is compared on its own, autoTargetFor). '' links nothing.
   */
  exactName?: string;
  /**
   * Never auto linked: the size with no name of an item with several (its name does not say which
   * size), or one exact full name the menus describe with two different auto link names.
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

/** What a flattened read found that has no row at all, for the sync message. */
export interface FlattenNotes {
  /**
   * Sizes of one item that ezCater names the same (two sizes both called "Large", or both with
   * no name): their exact full names are the same, so no name can say which one an order means.
   * They get NO row and no ids, and their lines print by name. '<item> (<size>)' each.
   */
  sameName: string[];
}

/** The display order of two descriptions of one exact full name, so a row reads the same whatever order ezCater lists the menus in. */
const displayKey = (e: MenuEntry) => [e.ezName, e.ezGroup || '', e.ezSizeName || '', e.ezOnlySize || ''].join('\u0000');

/**
 * Every row a sync writes, one per exact full name (ids unioned), in menu order, plus notes. PURE.
 *   an item with 0 or 1 size  -> ONE row, its exact full name the item plus its only size
 *   an item with 2+ sizes     -> one row PER SIZE, its exact full name the item plus that size
 *   every option value        -> one row per group and value
 * The same exact full name on two items or two menus (Potbelly lists "Bottled Water", sold as "1",
 * under two categories) is one product by name: one row, both ids. Two sizes of ONE item with the
 * same exact full name are not told apart by any name, so they get no row (FlattenNotes.sameName).
 */
export function flattenMenusWithNotes(menus: any): { entries: MenuEntry[]; notes: FlattenNotes } {
  const out = new Map<string, MenuEntry>();
  const notes: FlattenNotes = { sameName: [] };
  const put = (e: MenuEntry) => {
    const k = e.kind + ':' + e.ezKey;
    const prev = out.get(k);
    if (!prev) { out.set(k, { ...e, ids: Array.from(new Set(e.ids)) }); return; }
    for (const id of e.ids) if (!prev.ids.includes(id)) prev.ids.push(id);
    // One exact full name, two auto link names ("Italian Boxed Lunch" sold only as "Box", and an
    // "Italian Boxed Lunch Box" with no size): which of ours it is would be a guess.
    prev.noAuto = prev.noAuto || e.noAuto || (prev.exactName || '') !== (e.exactName || '');
    if (displayKey(e) < displayKey(prev)) {
      prev.ezName = e.ezName; prev.ezGroup = e.ezGroup; prev.ezSizeName = e.ezSizeName;
      prev.ezOnlySize = e.ezOnlySize; prev.ezCategory = e.ezCategory;
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
          const only = sizes.length ? s(sizes[0].name) : '';
          const identity = itemIdentity(name, only);
          if (identity) {
            put({ kind: 'item', ezKey: syncKeyOf(identity), ezName: name, ezGroup: null, ezSizeName: null, ezCategory: category,
              ezOnlySize: only || null,
              ids: sizes.length && s(sizes[0].id) ? [s(sizes[0].id)] : [],
              exactName: singleSizeExactName(name, only), noAuto: false });
          }
        } else {
          const identities = sizes.map((z) => itemIdentity(name, z.name));
          for (let i = 0; i < sizes.length; i++) {
            const z = sizes[i];
            const identity = identities[i];
            if (!identity) continue;
            if (identities.filter((x) => x === identity).length > 1) {
              notes.sameName.push(`${name} (${s(z.name) || 'no size name'})`);
              continue;
            }
            // A size with no name: its full name is the item name alone, which does not say which
            // size it is, so it is never auto linked (staff can still match it).
            put({ kind: 'item', ezKey: syncKeyOf(identity), ezName: name, ezGroup: null, ezSizeName: s(z.name) || null,
              ezCategory: category, ids: s(z.id) ? [s(z.id)] : [], exactName: identity, noAuto: !exactName(z.name) });
          }
        }
        for (const z of sizes) {
          for (const t of arr(z?.customizationTypes)) {
            const group = s(t?.name);
            for (const v of arr(t?.values)) {
              const vName = s(v?.name);
              const identity = optionIdentity(group, vName);
              if (!identity) continue;
              put({ kind: 'option', ezKey: syncKeyOf(identity), ezName: vName, ezGroup: group || null, ezSizeName: null,
                ezCategory: category, ids: s(v?.id) ? [s(v.id)] : [], exactName: exactName(vName), noAuto: false });
            }
          }
        }
      }
    }
  }
  return { entries: Array.from(out.values()), notes };
}

/** The rows a sync writes (flattenMenusWithNotes without the notes). PURE. */
export function flattenMenus(menus: any): MenuEntry[] {
  return flattenMenusWithNotes(menus).entries;
}

// ── Exact name auto links ────────────────────────────────────────────────────────────────────

/** The names one of ours can be known by: name, menuName, label. */
const ourNamesOf = (x: any): string[] => ['name', 'menuName', 'label']
  .map((k) => x?.[k]).filter((n) => typeof n === 'string' && n.trim()) as string[];

/** The auto link name of one entry: the one flattenMenus worked out, or built from its parts. */
export function entryExactName(entry: MenuEntry): string {
  if (typeof entry.exactName === 'string') return entry.exactName;
  if (entry.kind === 'option') return exactName(entry.ezName);
  if (s(entry.ezSizeName)) return itemIdentity(entry.ezName, entry.ezSizeName);
  return singleSizeExactName(entry.ezName, entry.ezOnlySize);
}

/**
 * Our target for one synced row, or null. EXACT MEANS EXACT.
 *   item (plain or size)  exactly ONE of our items whose name (or menu name) has the SAME exact
 *                         name as the row's auto link name: the item plus its size (see
 *                         singleSizeExactName). Any size or container word on one side only
 *                         ("Large", "Small", "Tray", "Box") means different names, so no link.
 *   option                exactly ONE of our options whose GROUP has the same exact name as the
 *                         ezCater customization group AND whose own name is the same exact name
 *                         as the value: "Bread: White" is never our "White" in the Cheese group.
 *                         A value with no group links nothing.
 *   anything marked noAuto, or with no exact name, links nothing
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

/** A row a menu sync wrote: keyed by an exact full name. Every other row was saved before the sync. */
export function isSyncedRow(row: any): boolean {
  return isSyncKey(row?.ez_key ?? row?.ezKey);
}

/**
 * The decision on a row that may route food at order time, or null:
 *   a staff match (source 'manual' with a target) made for this row's exact full name
 *   (lookAgainOf), or
 *   an EXACT auto link (source 'auto', matched_by 'exact', written by a sync)
 * An auto link the old order time name rule made (matched_by 'name') is NOT one. A staff decision
 * made for a different name (carried over from before the sync, or with nothing recorded) is not
 * one UNTIL staff look at it again ("Still right" on the Item matching card). "Not on our menu"
 * and a staff clear have no target, so they are null too.
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
 * LOOK AGAIN. A staff decision on a synced row is never changed by a sync, and a synced row's
 * exact full name never changes, so a decision needs a second look only when it was made for a
 * DIFFERENT name: one carried over from the row the item had before the sync ("Turkey Sandwich",
 * now sold as "Turkey Sandwich Box"), or one with nothing recorded of what the person saw. Until
 * staff look again ("Still right" or "Change"), orders do not use it (trustedTarget): those lines
 * print by name. decided_as is what the person saw (fullNameOf); its exact form is compared with
 * the row's key. Rows saved before the sync are never flagged: orders never use them.
 */
export function lookAgainOf(row: any): { lookAgain: boolean; was: string | null; now: string } {
  const now = fullNameOf(rowNameParts(row));
  const saw = s(row?.decided_as ?? row?.decidedAs);
  const key = row?.ez_key ?? row?.ezKey;
  if (!isStaffDecision(row) || !isSyncKey(key)) return { lookAgain: false, was: saw || null, now };
  if (!saw) return { lookAgain: true, was: null, now };
  const kind = s(row?.kind) === 'option' ? 'option' : 'item';
  return { lookAgain: shownIdentity(kind, saw) !== identityOfKey(key), was: saw, now };
}

// ── The plan ─────────────────────────────────────────────────────────────────────────────────

/** The ezCater facts of one synced row: names, ids, size, category, synced_at. Never a decision. */
export interface RowFacts {
  ez_name: string; ez_group: string | null; ez_size_name: string | null; ez_only_size: string | null;
  ez_category: string | null; ez_ids: string[]; synced_at: string;
}

export interface SyncPlan {
  /** New rows, written insert only (on conflict do nothing): a racing save wins. */
  inserts: any[];
  /** Existing rows: the ezCater facts only. Never a decision. */
  refreshes: any[];
  /**
   * AUTOMATIC rows decided again: set to the one exact match of ours, moved to it, or cleared.
   * Guarded on the decision as read, so a person who saved first wins. A row this read covered
   * carries its refreshed facts (ids included) IN THE SAME STATEMENT (`facts`), so a new target
   * can never sit next to ids from before; a row whose decision write fails is not refreshed.
   */
  redecides: { kind: string; ezKey: string; was: Decision; menuItemId: string | null; optionId: string | null; matchedBy: string | null; facts?: RowFacts }[];
  counts: {
    items: number; sizes: number; options: number; inserted: number; refreshed: number;
    autoLinked: number; toDecide: number; redecided: number; cleared: number; lookAgain: number;
    carried: number;
  };
}

/** Published ids kept per row, newest first. Only reached after this many republishes. */
export const MAX_IDS_PER_ROW = 200;

/** A synced row as an entry, for rows this read did not cover. */
function storedEntry(row: any): MenuEntry {
  const p = rowNameParts(row);
  const entry: MenuEntry = {
    kind: p.kind, ezKey: s(row?.ez_key), ezName: p.name, ezGroup: p.kind === 'option' ? (p.group || null) : null,
    ezSizeName: p.sizeName || null, ezOnlySize: p.onlySize || null, ezCategory: null, ids: [], noAuto: false,
  };
  entry.exactName = entryExactName(entry);
  return entry;
}

const sameDecision = (a: Decision, b: Decision) =>
  a.menuItemId === b.menuItemId && a.optionId === b.optionId && a.matchedBy === b.matchedBy;

/**
 * The keys the rules BEFORE the sync (ezcaterMatch.ts buildLinkKey, then its legacy form) could
 * have saved this product's staff decision under, the most specific first: for an item, its name
 * with its size ("Caesar Salad Large"), then its name alone, because an order line before the sync
 * was keyed by the line name, which carries no size.
 */
export function oldKeysOf(e: MenuEntry): string[] {
  const out: string[] = [];
  const add = (keys: string[]) => { for (const k of keys) if (k && !out.includes(k)) out.push(k); };
  if (e.kind === 'option') {
    add(linkKeyCandidates({ name: e.ezName, groupLabel: e.ezGroup || '' }, 'option'));
    return out;
  }
  const size = s(e.ezSizeName) || s(e.ezOnlySize);
  if (size) add(linkKeyCandidates({ name: `${e.ezName} ${size}` }, 'item'));
  add(linkKeyCandidates({ name: e.ezName }, 'item'));
  return out;
}

/**
 * The staff decision to CARRY OVER to a new synced row: the first staff decision (a match or "Not
 * on our menu") on a row saved before the sync under one of the product's old keys, with what that
 * row showed (decided_as). Kept exactly when that is the new row's exact full name; otherwise
 * lookAgainOf flags it and orders do not use it until staff look again. null when there is none.
 */
export function carryOverFor(e: MenuEntry, oldRows: Map<string, any>):
  { menuItemId: string | null; optionId: string | null; matchedBy: string | null; decidedAs: string } | null {
  for (const key of oldKeysOf(e)) {
    const old = oldRows.get(e.kind + ':' + key);
    if (!old || !isStaffDecision(old)) continue;
    const d = decisionOf(old);
    const decidedAs = (s(old.decided_as) || fullNameOf(rowNameParts(old))).slice(0, 500);
    if (!decidedAs) continue;
    return { menuItemId: d.menuItemId, optionId: e.kind === 'item' ? null : d.optionId, matchedBy: d.matchedBy, decidedAs };
  }
  return null;
}

/**
 * What a sync writes. PURE.
 *
 * ROWS: one per exact full name. A new name is inserted; an existing one is refreshed (display
 * names, category, ids: the new ones first, the old ones kept, because a row's exact full name
 * never changes, so every id on it was published for the same product).
 *
 * DECISIONS:
 *   a new row                              the staff decision carried over from before the sync
 *                                          (carryOverFor), else the one exact match of ours, else
 *                                          nothing
 *   an automatic row covered by this read  decided again from the whole of our menu: the one exact
 *                                          match (kept, moved to, or set), else cleared; the
 *                                          write carries the refreshed facts too
 *   an automatic row this read did not     kept only while its stored name is still exactly the
 *   cover (off the current menus)          one item of ours it points at; otherwise cleared.
 *                                          Never moved or newly linked.
 *   a staff decision                       never touched
 * `menuOk` false (our own menu was only partly read) links nothing new and decides nothing again.
 */
export function planMenuSync(input: {
  entries: MenuEntry[]; existing: any[]; ourItems: any[]; ourGroups: any[];
  locationId: string; nowIso: string; complete: boolean; menuOk: boolean;
}): SyncPlan {
  const kindOf = (r: any) => (s(r?.kind) === 'option' ? 'option' : 'item');
  const synced = new Map<string, any>();
  const old = new Map<string, any>();
  for (const r of arr(input.existing)) {
    if (!r || !s(r.ez_key)) continue;
    (isSyncKey(r.ez_key) ? synced : old).set(kindOf(r) + ':' + s(r.ez_key), r);
  }
  const plan: SyncPlan = {
    inserts: [], refreshes: [], redecides: [],
    counts: { items: 0, sizes: 0, options: 0, inserted: 0, refreshed: 0, autoLinked: 0, toDecide: 0, redecided: 0, cleared: 0, lookAgain: 0, carried: 0 },
  };
  const decide = (target: { menuItemId: string | null; optionId: string | null } | null): Decision => (target
    ? { menuItemId: target.menuItemId, optionId: target.optionId, matchedBy: EXACT_MATCHED_BY }
    : { menuItemId: null, optionId: null, matchedBy: null });
  const covered = new Set<string>();

  for (const e of arr(input.entries) as MenuEntry[]) {
    const k = e.kind + ':' + e.ezKey;
    if (!isSyncKey(e.ezKey) || covered.has(k)) continue;
    covered.add(k);
    if (e.kind === 'option') plan.counts.options++;
    else if (e.ezSizeName) plan.counts.sizes++;
    else plan.counts.items++;
    const target = input.menuOk ? autoTargetFor(e, input.ourItems, input.ourGroups) : null;
    const prev = synced.get(k);
    const facts: RowFacts = {
      ez_name: e.ezName, ez_group: e.kind === 'option' ? (e.ezGroup || null) : null,
      ez_size_name: e.kind === 'item' ? (e.ezSizeName || null) : null,
      ez_only_size: e.kind === 'item' && !e.ezSizeName ? (s(e.ezOnlySize) || null) : null,
      ez_category: e.ezCategory,
      ez_ids: Array.from(new Set([...e.ids, ...idsOf(prev?.ez_ids)])).slice(0, MAX_IDS_PER_ROW),
      synced_at: input.nowIso,
    };

    if (!prev) {
      const carried = carryOverFor(e, old);
      if (carried) {
        plan.inserts.push({
          location_id: input.locationId, kind: e.kind, ez_key: e.ezKey, ...facts,
          menu_item_id: carried.menuItemId, option_id: carried.optionId,
          source: 'manual', matched_by: carried.matchedBy, decided_as: carried.decidedAs,
          seen_count: 0, last_seen_at: null, updated_at: input.nowIso,
        });
        if (shownIdentity(e.kind, carried.decidedAs) === identityOfKey(e.ezKey)) plan.counts.carried++;
        else plan.counts.lookAgain++;
        continue;
      }
      plan.inserts.push({
        location_id: input.locationId, kind: e.kind, ez_key: e.ezKey, ...facts,
        menu_item_id: target ? target.menuItemId : null, option_id: target ? target.optionId : null,
        source: 'auto', matched_by: target ? EXACT_MATCHED_BY : null, decided_as: null,
        seen_count: 0, last_seen_at: null, updated_at: input.nowIso,
      });
      if (target) plan.counts.autoLinked++; else plan.counts.toDecide++;
      continue;
    }

    // ONLY the ezCater fact columns. `source` is left out on purpose: the column defaults to
    // 'auto' (20260919m) so Postgres accepts the insert tuple ON CONFLICT DO UPDATE builds, and
    // DO UPDATE sets only the columns named here, so every row keeps its own source and decision.
    plan.refreshes.push({ location_id: input.locationId, kind: e.kind, ez_key: e.ezKey, ...facts });

    const was = decisionOf(prev);
    if (isStaffRow(prev)) {
      // A person decided (or cleared) this row: never changed here.
      if (isStaffDecision(prev)) { if (lookAgainOf(prev).lookAgain) plan.counts.lookAgain++; }
      else plan.counts.toDecide++;
      continue;
    }
    // An automatic row, with our whole menu: decided again, its facts in the same write.
    if (input.menuOk) {
      const next = decide(target);
      if (!sameDecision(was, next)) {
        plan.redecides.push({ kind: e.kind, ezKey: e.ezKey, was, ...next, facts });
        if ((was.menuItemId || was.optionId) && !next.menuItemId && !next.optionId) plan.counts.cleared++;
      }
      if (target) plan.counts.autoLinked++; else plan.counts.toDecide++;
      continue;
    }
    // Our menu was read only in part: nothing is linked or moved; the next whole read decides.
    // (The row's exact full name cannot have changed: a renamed product is a new row.)
    if ((was.menuItemId || was.optionId) && was.matchedBy === EXACT_MATCHED_BY) plan.counts.autoLinked++;
    else plan.counts.toDecide++;
  }

  // Automatic synced rows this read did not cover (off the current menus, or a caterer that did
  // not answer): only with our whole menu. Kept while their stored name is still exactly the one
  // item of ours they point at (our item renamed or gone: cleared).
  if (input.menuOk) {
    for (const [k, prev] of synced) {
      if (covered.has(k) || isStaffRow(prev)) continue;
      const was = decisionOf(prev);
      if (!was.menuItemId && !was.optionId) continue;
      const target = was.matchedBy === EXACT_MATCHED_BY ? autoTargetFor(storedEntry(prev), input.ourItems, input.ourGroups) : null;
      const keep = !!target && target.menuItemId === was.menuItemId && target.optionId === was.optionId;
      if (!keep) {
        plan.redecides.push({ kind: kindOf(prev), ezKey: s(prev.ez_key), was, ...decide(null) });
        plan.counts.cleared++;
      }
    }
  }

  plan.counts.inserted = plan.inserts.length;
  plan.counts.refreshed = plan.refreshes.length;
  plan.counts.redecided = plan.redecides.length;
  return plan;
}

// ── Order time ───────────────────────────────────────────────────────────────────────────────

/** Synced rows of one kind by key. A row saved before the sync is never in it. */
export function indexSyncedRows(links: any, kind: 'item' | 'option' = 'item'): Map<string, any> {
  const idx = new Map<string, any>();
  for (const r of arr(links)) {
    if (!r || (s(r.kind) || 'item') !== kind) continue;
    const key = s(r.ez_key ?? r.ezKey);
    if (isSyncKey(key)) idx.set(key, r);
  }
  return idx;
}

export type SizeRoute =
  | { mode: 'synced'; ezKey: string; itemId: string | null }
  | { mode: 'unmatched'; reason: string };

/**
 * How one order line is matched once 20260919m has run. PURE. There is no other way.
 *   synced     the synced row keyed by the line's exact full name (its name plus its size name)
 *              holds the line's published SIZE id: its trusted target decides (trustedTarget), or
 *              nothing when it has none (the line prints by name)
 *   unmatched  no size id, no synced row with that exact name, or the id is not on that row
 * Never a folded name, never the line's item id, never a posItemId.
 */
export function sizeRouteFor(line: any, rows: Map<string, any>): SizeRoute {
  // The SIZE id only (the order's menuItemSizeId IS the menu's sizes.id, proven on HKX77V, see
  // the top of this file). Never line.ezItemId: an order's item id is not the menu's item id.
  const id = s(line?.ezSizeId);
  if (!id) return { mode: 'unmatched', reason: 'no size id' };
  const row = rows.get(syncKeyOf(lineIdentity(line)));
  if (!row) return { mode: 'unmatched', reason: 'no synced row with this exact name' };
  if (!idsOf(row.ez_ids ?? row.ezIds).includes(id)) return { mode: 'unmatched', reason: 'size id not on the row with this exact name' };
  return { mode: 'synced', ezKey: s(row.ez_key ?? row.ezKey), itemId: trustedTarget(row)?.menuItemId || null };
}

export type OptionRoute =
  | { mode: 'synced'; ezKey: string; optionId: string | null; itemId: string | null }
  | { mode: 'unmatched'; reason: string };

/**
 * How one customization is matched once 20260919m has run. PURE. Only on the synced option row
 * keyed by its exact group and value, when its published id (ezItemId, which ezcater-map.ts takes
 * from the order's customizationId) is on that row, by that row's trusted decision.
 */
export function optionRouteFor(mod: any, rows: Map<string, any>): OptionRoute {
  const id = s(mod?.ezItemId);
  if (!id) return { mode: 'unmatched', reason: 'no customization id' };
  const row = rows.get(syncKeyOf(modIdentity(mod)));
  if (!row) return { mode: 'unmatched', reason: 'no synced option with this exact name' };
  if (!idsOf(row.ez_ids ?? row.ezIds).includes(id)) return { mode: 'unmatched', reason: 'customization id not on the row with this exact name' };
  const t = trustedTarget(row);
  return { mode: 'synced', ezKey: s(row.ez_key ?? row.ezKey), optionId: t?.optionId || null, itemId: t?.menuItemId || null };
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
 *   1. redecides  automatic rows decided again. ONE guarded statement per row writes the new
 *                 decision AND, for a row this read covered, its refreshed facts (ids included),
 *                 so a moved match can never sit next to ids from before
 *   2. inserts    never overwrite (on conflict do nothing)
 *   3. refreshes  name only the ezCater fact columns, so a decision a person saves mid sync is
 *                 never touched. Skipped for a row whose decision write FAILED (its old facts stay
 *                 with its old decision until the next sync) and for a row step 1 already wrote.
 * Every guarded update repeats the decision it read, so a person who saved first wins (their row
 * then gets its facts from step 3).
 */
export async function writeSyncPlan(sb: any, locationId: string, plan: SyncPlan, nowIso: string):
  Promise<{ inserted: number; refreshed: number; redecided: number; errors: string[] }> {
  const done = { inserted: 0, refreshed: 0, redecided: 0, errors: [] as string[] };
  const held = new Set<string>();
  const wrote = new Set<string>();
  const errText = (e: any) => String(e?.message || e);

  await inBatches(plan.redecides || [], async (r) => {
    const k = r.kind + ':' + r.ezKey;
    const patch: Record<string, unknown> = {
      menu_item_id: r.menuItemId, option_id: r.optionId, matched_by: r.matchedBy, updated_at: nowIso,
      ...(r.facts || {}),
    };
    const q = sb.from('ezcater_item_links').update(patch)
      .eq('location_id', locationId).eq('kind', r.kind).eq('ez_key', r.ezKey).eq('source', 'auto');
    const { data, error } = await guardDecision(q, r.was).select('ez_key');
    if (error) { done.errors.push('decide: ' + errText(error)); held.add(k); return; }
    if (Array.isArray(data) && data.length) { done.redecided++; if (r.facts) wrote.add(k); }
  });
  for (let i = 0; i < plan.inserts.length; i += WRITE_CHUNK) {
    const chunk = plan.inserts.slice(i, i + WRITE_CHUNK);
    const { error } = await sb.from('ezcater_item_links')
      .upsert(chunk, { onConflict: 'location_id,kind,ez_key', ignoreDuplicates: true });
    if (error) done.errors.push('insert: ' + errText(error)); else done.inserted += chunk.length;
  }
  const refreshes = plan.refreshes.filter((r) => !held.has(r.kind + ':' + r.ez_key) && !wrote.has(r.kind + ':' + r.ez_key));
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

/**
 * Close a claim. Fenced on the claim id, so a sync that was taken over cannot overwrite the new
 * one. An 'ok' sync stamps last_ok_at with its OWN synced_at (`syncedAtIso`, the time every row
 * it wrote carries), so "a row whose synced_at is older than last_ok_at" is exactly "not on
 * ezCater's current menu at the last whole sync" (the Item matching card lists those apart).
 */
export async function finishSync(sb: any, locationId: string, claim: string, status: string, counts: any, error: string | null,
  syncedAtIso: string | null = null) {
  const nowIso = new Date().toISOString();
  const patch: Record<string, unknown> = { status, finished_at: nowIso, counts, error, updated_at: nowIso };
  if (status === 'ok') patch.last_ok_at = syncedAtIso || nowIso;
  await sb.from('ezcater_menu_syncs').update(patch).eq('location_id', locationId).eq('claim_id', claim);
}
