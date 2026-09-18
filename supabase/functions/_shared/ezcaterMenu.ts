// supabase/functions/_shared/ezcaterMenu.ts
//
// READING A CATERER'S MENU FROM ezCater, so every item, size and option is known BEFORE any
// order arrives (Peter, 18 Sep 2026: "we cant have it that we match products after an order has
// been placed").
//
// Proven live (read only, with Peter's yes, 18 Sep 2026): the connected token CAN read menus.
//   Query.menus(catererId: UUID!, first, after, ...) -> MenuBaseConnection { nodes { id name startDate endDate } }
//   Query.menu(catererId: UUID!, id: UUID!)          -> Menu
//   Menu { id name startDate endDate categories { id name originalCategoryId items { id name
//     originalItemId sizes { id name serves status originalItemSizeId customizationTypes { id
//     name originalCustomizationTypeId selectionRangeStart selectionRangeEnd values { ... } } } } } }
//
// THE ONE LESSON THIS FILE IS BUILT AROUND. GraphQL throws the WHOLE query away over one field it
// does not have, and still answers HTTP 200 (project_ezcater: the order query nearly shipped that
// way). CustomizationValue's fields were never proven, and we may not call the live API to find
// out. So the menu query is BUILT FROM ezCater's OWN SCHEMA at run time: __type introspection
// (documented and supported, "Using GraphQL") says which fields each level really has, and only
// those are asked for. A field that is not there is simply not asked for. Only when introspection
// itself is refused do we fall back to the fields that were proven live.
//
// The ezCater call is passed in (ask), so this file has no Deno globals and is tested under node.

/** ask(operationName, query, variables) -> the GraphQL `data`, or throws. */
export type EzAsk = (operationName: string, query: string, variables?: Record<string, unknown>) => Promise<any>;

// ── The levels of a menu, and the fields each one is asked for when it has them ─────────────────

/**
 * Walked from Menu down. `want` are leaf fields (asked for only when the schema has them AND
 * they are a scalar or an enum). `child` is the list field leading to the next level, the first
 * name the schema really has. Any field named original...Id is asked for too: that is where
 * ezCater keeps the id that survives a republish.
 */
export const MENU_LEVELS = Object.freeze([
  { level: 'menu', want: ['id', 'name', 'startDate', 'endDate'], child: ['categories'] },
  { level: 'category', want: ['id', 'name', 'originalCategoryId'], child: ['items'] },
  { level: 'item', want: ['id', 'name', 'originalItemId', 'status'], child: ['sizes'] },
  { level: 'size', want: ['id', 'name', 'status', 'originalItemSizeId'], child: ['customizationTypes'] },
  {
    level: 'customizationType',
    want: ['id', 'name', 'originalCustomizationTypeId', 'selectionRangeStart', 'selectionRangeEnd'],
    child: ['values', 'customizations', 'choices', 'options'],
  },
  { level: 'value', want: ['id', 'name', 'status'], child: [] },
]);

/** The fields proven live on 18 Sep 2026. Used only when introspection is refused. */
export const PROVEN_MENU_SELECTION = `{
      id name startDate endDate
      categories {
        id name originalCategoryId
        items {
          id name originalItemId
          sizes {
            id name status originalItemSizeId
            customizationTypes {
              id name originalCustomizationTypeId selectionRangeStart selectionRangeEnd
              values { id name }
            }
          }
        }
      }
    }`;

const ORIGINAL_ID = /^original[A-Za-z]*Id$/;

/** A __type field's type, unwrapped: the named type at the bottom and its kind. */
export function unwrapType(t: any): { name: string | null; kind: string | null; list: boolean } {
  let cur = t;
  let list = false;
  for (let i = 0; i < 8 && cur; i++) {
    if (cur.kind === 'LIST') list = true;
    if (cur.kind !== 'NON_NULL' && cur.kind !== 'LIST') return { name: cur.name ?? null, kind: cur.kind ?? null, list };
    cur = cur.ofType;
  }
  return { name: null, kind: null, list };
}

/** True when a field needs an argument we do not send (a required argument). */
function needsArgs(field: any): boolean {
  return (Array.isArray(field?.args) ? field.args : []).some((a: any) => a?.type?.kind === 'NON_NULL' && a?.defaultValue == null);
}

const LEAF_KINDS = new Set(['SCALAR', 'ENUM']);

/**
 * One level's selection from its __type answer: the wanted leaf fields it really has, every
 * original...Id leaf, and the child list field (its type name, so the walk can continue).
 * PURE. Returns null when the level has neither id nor name, because a row we cannot name or
 * address is not a row.
 */
export function pickLevelFields(typeInfo: any, level: { want: readonly string[]; child: readonly string[] }): {
  leaves: string[]; child: string | null; childType: string | null;
} | null {
  const fields = Array.isArray(typeInfo?.fields) ? typeInfo.fields : [];
  const byName = new Map<string, any>();
  for (const f of fields) if (f && f.name) byName.set(String(f.name), f);
  const isLeaf = (f: any) => {
    const u = unwrapType(f?.type);
    return !!u.kind && LEAF_KINDS.has(u.kind) && !needsArgs(f);
  };
  const leaves: string[] = [];
  for (const w of level.want) {
    const f = byName.get(w);
    if (f && isLeaf(f) && !leaves.includes(w)) leaves.push(w);
  }
  for (const f of fields) {
    const n = String(f?.name || '');
    if (ORIGINAL_ID.test(n) && isLeaf(f) && !leaves.includes(n)) leaves.push(n);
  }
  if (!leaves.includes('id') || !leaves.includes('name')) return null;
  let child: string | null = null;
  let childType: string | null = null;
  for (const c of level.child) {
    const f = byName.get(c);
    if (!f || needsArgs(f)) continue;
    const u = unwrapType(f.type);
    if (u.kind === 'OBJECT' && u.name) { child = c; childType = u.name; break; }
  }
  return { leaves, child, childType };
}

/**
 * The selection set for a Menu, built from the per level picks. PURE. A level whose pick is
 * missing ends the walk there: the menu is still read, just without that depth.
 */
export function buildMenuSelection(picks: Array<{ leaves: string[]; child: string | null } | null>): string {
  const render = (i: number): string => {
    const p = picks[i];
    if (!p) return '';
    const inner = p.child && picks[i + 1] ? ` ${p.child} ${render(i + 1)}` : '';
    return `{ ${p.leaves.join(' ')}${inner} }`;
  };
  return render(0);
}

const TYPE_QUERY = `query ServOsEzMenuType($name: String!) {
  __type(name: $name) {
    name kind
    fields {
      name
      args { name defaultValue type { kind name ofType { kind name } } }
      type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
    }
  }
}`;

/**
 * Ask ezCater's own schema what a Menu looks like, level by level. Returns the selection set to
 * use and how it was decided. Never throws: a refusal gives the proven selection instead.
 */
export async function menuSelectionFor(ask: EzAsk, log: (...a: unknown[]) => void = () => {}): Promise<{
  selection: string; source: 'schema' | 'proven'; levels: number; menusPaged: boolean; pageInfo: string | null;
}> {
  try {
    // The root type is usually called Query, but ask rather than assume.
    let rootName = 'Query';
    try {
      const r = await ask('ServOsEzRootType', 'query ServOsEzRootType { __schema { queryType { name } } }', {});
      if (r?.__schema?.queryType?.name) rootName = String(r.__schema.queryType.name);
    } catch { /* keep Query */ }
    const q = await ask('ServOsEzMenuType', TYPE_QUERY, { name: rootName });
    const qFields = Array.isArray(q?.__type?.fields) ? q.__type.fields : [];
    const menuField = qFields.find((f: any) => f?.name === 'menu');
    const menusField = qFields.find((f: any) => f?.name === 'menus');
    const menuType = unwrapType(menuField?.type).name;
    if (!menuType || !menusField) throw new Error('no menu or menus on Query');

    // Paging of the menus list: only when the connection really has pageInfo.
    let pageInfo: string | null = null;
    const connType = unwrapType(menusField.type).name;
    if (connType) {
      const c = await ask('ServOsEzMenuType', TYPE_QUERY, { name: connType });
      const cf = Array.isArray(c?.__type?.fields) ? c.__type.fields : [];
      const pi = cf.find((f: any) => f?.name === 'pageInfo');
      const piType = pi ? unwrapType(pi.type).name : null;
      if (piType) {
        const p = await ask('ServOsEzMenuType', TYPE_QUERY, { name: piType });
        const pf = new Set((Array.isArray(p?.__type?.fields) ? p.__type.fields : []).map((f: any) => f?.name));
        if (pf.has('hasNextPage') && pf.has('endCursor')) pageInfo = 'pageInfo { hasNextPage endCursor }';
      }
    }

    const picks: Array<{ leaves: string[]; child: string | null } | null> = [];
    let typeName: string | null = menuType;
    for (const level of MENU_LEVELS) {
      if (!typeName) break;
      const t = await ask('ServOsEzMenuType', TYPE_QUERY, { name: typeName });
      const pick = pickLevelFields(t?.__type, level);
      if (!pick) break;
      picks.push({ leaves: pick.leaves, child: pick.child });
      typeName = pick.child ? pick.childType : null;
    }
    // Without categories, items and sizes there is nothing to sync: use what was proven live.
    if (picks.length < 4) throw new Error(`the menu schema stopped at level ${picks.length}`);
    return { selection: buildMenuSelection(picks), source: 'schema', levels: picks.length, menusPaged: !!pageInfo, pageInfo };
  } catch (e) {
    log('menu schema could not be read, using the fields proven live:', e instanceof Error ? e.message : String(e));
    return { selection: PROVEN_MENU_SELECTION, source: 'proven', levels: 6, menusPaged: false, pageInfo: null };
  }
}

// ── Which menus are current ──────────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' of an instant on a venue's clock. */
export function venueDate(nowMs: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(nowMs));
    const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
    const s = `${get('year')}-${get('month')}-${get('day')}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  } catch { /* an unknown zone: UTC below */ }
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * The menus that are current on `today` (the venue's date): started (no startDate, or on or
 * before today) and not ended (no endDate, or on or after today). Dates are compared as
 * calendar dates, so a date or a date time both work. PURE.
 */
export function currentMenus(nodes: any[], today: string): any[] {
  const d = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);
  return (Array.isArray(nodes) ? nodes : []).filter((m) => {
    if (!m || !m.id) return false;
    const s = d(m.startDate);
    const e = d(m.endDate);
    if (s && s > today) return false;
    if (e && e < today) return false;
    return true;
  });
}

/** Every menu of one caterer, paging when the connection supports it. Throws on a failed call. */
export async function listMenus(ask: EzAsk, catererId: string, pageInfo: string | null, maxPages = 20): Promise<any[]> {
  const out: any[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const query = pageInfo
      ? `query ServOsEzMenus($catererId: UUID!, $after: String) { menus(catererId: $catererId, first: 50, after: $after) { nodes { id name startDate endDate } ${pageInfo} } }`
      : `query ServOsEzMenus($catererId: UUID!) { menus(catererId: $catererId) { nodes { id name startDate endDate } } }`;
    const vars: Record<string, unknown> = { catererId };
    if (pageInfo) vars.after = after;
    const data = await ask('ServOsEzMenus', query, vars);
    const conn = data?.menus || {};
    for (const n of Array.isArray(conn.nodes) ? conn.nodes : []) if (n) out.push(n);
    if (!pageInfo || !conn.pageInfo?.hasNextPage || !conn.pageInfo?.endCursor) break;
    after = String(conn.pageInfo.endCursor);
  }
  return out;
}

/** One whole menu. Throws on a failed call. */
export async function readMenu(ask: EzAsk, catererId: string, menuId: string, selection: string): Promise<any | null> {
  const query = `query ServOsEzMenu($catererId: UUID!, $id: UUID!) { menu(catererId: $catererId, id: $id) ${selection} }`;
  const data = await ask('ServOsEzMenu', query, { catererId, id: menuId });
  return data?.menu ?? null;
}

// ── Flattening a menu into the things an order line can name ─────────────────────────────────

const s = (v: unknown): string => (v == null ? '' : String(v).trim());
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** The original id on an object: the named one first, else any original...Id it carries. */
export function originalIdOf(o: any, named: string): string {
  if (!o || typeof o !== 'object') return '';
  const direct = s(o[named]);
  if (direct) return direct;
  for (const k of Object.keys(o)) {
    if (ORIGINAL_ID.test(k) && k !== 'originalCategoryId' && k !== 'originalItemId' && k !== 'originalCustomizationTypeId') {
      const v = s(o[k]);
      if (v) return v;
    }
  }
  return '';
}

/** The option values of one customization type, whatever the schema called the list. */
function valuesOf(t: any): any[] {
  for (const k of ['values', 'customizations', 'choices', 'options']) if (Array.isArray(t?.[k])) return t[k];
  return [];
}

export interface MenuSize {
  kind: 'item';
  menuId: string; menuName: string; category: string;
  itemName: string; itemId: string; itemOriginalId: string;
  sizeName: string; sizeId: string; sizeOriginalId: string;
  /** How many sizes this item has on this menu. More than one makes each size its own row. */
  sizeCount: number;
}

export interface MenuValue {
  kind: 'option';
  menuId: string; menuName: string;
  group: string; name: string; valueId: string; valueOriginalId: string;
  groupOriginalId: string; selection: string | null;
}

/**
 * Every sellable size and every option value on one menu, in menu order. PURE. Rows with no
 * name are dropped (nothing to match or show), and so are sizes with no id (nothing an order can
 * point at). An item with no sizes at all still becomes one row, with no ids, so it can be
 * matched by name.
 */
export function flattenMenu(menu: any): { sizes: MenuSize[]; values: MenuValue[] } {
  const sizes: MenuSize[] = [];
  const values: MenuValue[] = [];
  if (!menu) return { sizes, values };
  const menuId = s(menu.id);
  const menuName = s(menu.name);
  for (const cat of arr(menu.categories)) {
    const category = s(cat?.name);
    for (const item of arr(cat?.items)) {
      const itemName = s(item?.name);
      if (!itemName) continue;
      const itemSizes = arr(item?.sizes).filter((z) => z && (s(z.id) || s(z.name)));
      const base = { kind: 'item' as const, menuId, menuName, category, itemName, itemId: s(item?.id), itemOriginalId: s(item?.originalItemId) };
      if (!itemSizes.length) {
        sizes.push({ ...base, sizeName: '', sizeId: '', sizeOriginalId: '', sizeCount: 0 });
        continue;
      }
      for (const z of itemSizes) {
        sizes.push({ ...base, sizeName: s(z.name), sizeId: s(z.id), sizeOriginalId: originalIdOf(z, 'originalItemSizeId'), sizeCount: itemSizes.length });
        for (const t of arr(z?.customizationTypes)) {
          const group = s(t?.name);
          const lo = t?.selectionRangeStart;
          const hi = t?.selectionRangeEnd;
          const selection = lo != null || hi != null ? `${lo ?? 0}-${hi ?? ''}` : null;
          for (const v of valuesOf(t)) {
            const name = s(v?.name);
            if (!name) continue;
            values.push({
              kind: 'option', menuId, menuName, group, name,
              valueId: s(v?.id), valueOriginalId: originalIdOf(v, 'originalCustomizationId'),
              groupOriginalId: s(t?.originalCustomizationTypeId), selection,
            });
          }
        }
      }
    }
  }
  return { sizes, values };
}
