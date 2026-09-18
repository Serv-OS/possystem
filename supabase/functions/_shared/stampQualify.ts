// supabase/functions/_shared/stampQualify.ts
//
// Which order lines earn a stamp on a stamp card. Used by loyalty-earn.
//
// THE RULE (Peter, 18 Sep 2026): loyalty is per COMPANY, not per site. A stamp card has
// company_id and no location, and one card per customer per programme per company, so a
// stamp earned at any site lands on the same card. The qualifying categories and items must
// follow the same rule.
//
// THE BUG THIS FIXES: stamp_card_programs.qualifying_category_ids / qualifying_item_ids hold
// ids, but menu_categories and menu_items are PER SITE, so "Hot Coffee" has a different id at
// every site. Matching by id alone meant a card set up while logged into one site only ever
// earned at that site; every other site silently gave no stamps.
//
// A line qualifies for a programme when ANY of these holds:
//   1. its item id or its category id is a saved id (exactly as before);
//   2. an ANCESTOR of its category is a saved id (a ticked parent covers its subcategories);
//   3. its item has the same normalised name as a saved qualifying item;
//   4. THE CATEGORY PATH RULE: the normalised PATH of a saved category (parent names down to
//      the category, e.g. "drinks / coffee") equals the path of the line's category or of one
//      of its ancestors. So ticking "Coffee" covers "Coffee / Hot Coffee" and "Coffee / Iced
//      Coffee" at every site, while "Drinks / Coffee" and "Retail / Coffee" (bags of beans)
//      stay apart. The Back Office picker applies the same rule (src/lib/stampCategoryGroups.js
//      pathCovers, parity test in src/lib/stampQualify.test.js).
//   5. legacy: an order line that sends a category LABEL instead of an id matches a saved
//      category with the same name (its parent is unknown, so only the name can be compared).
// A path is only used when every level of it resolved; a half known chain never matches by
// path (the id rules still apply), so a slow or failed lookup can only earn LESS, never wrongly.
//
// CARD PATH SAFETY: loyalty-earn runs on the till payment path. loadStampNameIndex never
// throws, is skipped entirely when every line already matches by saved id, and gives up after
// one overall deadline (2.5 s); when it returns null countQualifyingStamps is exactly the id
// match. No qualifying categories or items still means every line earns.
//
// Pure TypeScript with erasable types only, so node:test imports it directly
// (src/lib/stampQualify.test.js).

/** Trim, lower-case and collapse runs of whitespace. '' for anything that is not a name. */
export function normStampName(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Joins the levels of a category path key. A control character, so no name can contain it. */
export const PATH_SEP = '\u001f';

/** Deepest category chain followed. Menus are two or three levels; this only stops cycles. */
export const MAX_CATEGORY_DEPTH = 8;

/**
 * id -> label / parent for categories (menu_categories.label, parent_id) and id -> name for
 * items (menu_items.name).
 */
export type StampNameIndex = {
  catNames: Record<string, string>;
  catParents: Record<string, string | null>;
  itemNames: Record<string, string>;
};

type StampProgram = {
  qualifying_category_ids?: unknown;
  qualifying_item_ids?: unknown;
};

function idList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length > 0) : [];
}

function has(obj: Record<string, unknown> | undefined, key: string): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * The normalised path key (root name ... category name, joined by PATH_SEP) of a category id,
 * or null when the id, any ancestor, or any name is unknown, or the chain loops or is too deep.
 */
export function categoryPathKey(
  id: unknown,
  catNames: Record<string, string> | undefined,
  catParents: Record<string, string | null> | undefined,
): string | null {
  if (typeof id !== 'string' || !id) return null;
  const parts: string[] = [];
  const seen = new Set<string>();
  let cur: string | null = id;
  while (cur) {
    if (seen.has(cur) || seen.size >= MAX_CATEGORY_DEPTH) return null;
    seen.add(cur);
    if (!has(catNames, cur) || !has(catParents, cur)) return null;
    const n = normStampName(catNames![cur]);
    if (!n) return null;
    parts.unshift(n);
    const p = catParents![cur];
    cur = typeof p === 'string' && p ? p : null;
  }
  return parts.join(PATH_SEP);
}

/**
 * THE CATEGORY PATH RULE: a saved category covers a line's category when the paths are equal
 * or the saved path is an ancestor of the line's path. Identical in the Back Office.
 */
export function pathCovers(savedKey: string | null | undefined, lineKey: string | null | undefined): boolean {
  if (!savedKey || !lineKey) return false;
  return lineKey === savedKey || lineKey.startsWith(savedKey + PATH_SEP);
}

/** The category's own id and its known ancestors' ids, nearest first (bounded, loop safe). */
function selfAndAncestorIds(id: string, catParents: Record<string, string | null> | undefined): string[] {
  const out: string[] = [];
  let cur: string | null = id;
  while (cur && out.length < MAX_CATEGORY_DEPTH && !out.includes(cur)) {
    out.push(cur);
    const p: string | null | undefined = has(catParents, cur) ? catParents![cur] : null;
    cur = typeof p === 'string' && p ? p : null;
  }
  return out;
}

/**
 * True when the name lookup could change the count: some programme limits its categories or
 * items and some earnable line does NOT already match one of its saved ids directly. When every
 * line matches by saved id (a card used at the site it was saved at), there is nothing to look
 * up and the till pays no extra wait.
 */
export function stampLookupNeeded(programs: StampProgram[], items: any[]): boolean {
  if (!Array.isArray(programs) || !Array.isArray(items)) return false;
  for (const p of programs) {
    const qc = idList(p?.qualifying_category_ids);
    const qi = idList(p?.qualifying_item_ids);
    if (!qc.length && !qi.length) continue;
    for (const it of items) {
      if (!it || it.isComp || it.isGiftCard) continue;
      if (qi.length && it.id && qi.includes(it.id)) continue;
      if (qc.length && it.cat && qc.includes(it.cat)) continue;
      return true;
    }
  }
  return false;
}

/**
 * How many stamps one programme earns from an order's lines.
 * Comp and gift card lines never earn. qty defaults to 1.
 * @param items  loyalty-earn body.items ({ id, cat, qty, isComp, isGiftCard, ... })
 * @param prog   the stamp_card_programs row
 * @param index  names from loadStampNameIndex, or null (id match only, today's behaviour)
 */
export function countQualifyingStamps(items: any[], prog: StampProgram, index?: StampNameIndex | null): number {
  if (!Array.isArray(items)) return 0;
  const qualCats = idList(prog?.qualifying_category_ids);
  const qualItems = idList(prog?.qualifying_item_ids);
  const allQualify = qualCats.length === 0 && qualItems.length === 0;
  const qualCatSet = new Set(qualCats);

  // Paths and names of the saved qualifying ids (whichever site they were saved from).
  const savedPaths: string[] = [];
  const savedCatNames = new Set<string>();
  const qualItemNames = new Set<string>();
  if (index) {
    for (const id of qualCats) {
      const key = categoryPathKey(id, index.catNames, index.catParents);
      if (key) savedPaths.push(key);
      const n = normStampName(index.catNames?.[id]);
      if (n) savedCatNames.add(n);
    }
    for (const id of qualItems) {
      const n = normStampName(index.itemNames?.[id]);
      if (n) qualItemNames.add(n);
    }
  }

  let count = 0;
  for (const item of items) {
    if (!item || item.isComp || item.isGiftCard) continue;
    const qty = Number(item.qty) || 1;
    if (allQualify) { count += qty; continue; }

    // 1. Id match, exactly as before.
    if (qualItems.length > 0 && item.id && qualItems.includes(item.id)) { count += qty; continue; }
    if (qualCats.length > 0 && item.cat && qualCatSet.has(item.cat)) { count += qty; continue; }

    if (!index) continue;
    const cat = typeof item.cat === 'string' && item.cat ? item.cat : null;

    // 2. A ticked parent (by id) covers its subcategories.
    if (cat && qualCats.length > 0 && selfAndAncestorIds(cat, index.catParents).some((id) => qualCatSet.has(id))) {
      count += qty; continue;
    }

    // 3. Item name across the company.
    if (qualItemNames.size > 0 && item.id) {
      const n = normStampName(index.itemNames?.[item.id]);
      if (n && qualItemNames.has(n)) { count += qty; continue; }
    }

    if (!cat || qualCats.length === 0) continue;
    if (has(index.catNames, cat)) {
      // 4. The category path rule.
      const lineKey = categoryPathKey(cat, index.catNames, index.catParents);
      if (lineKey && savedPaths.some((k) => pathCovers(k, lineKey))) { count += qty; continue; }
    } else {
      // 5. Legacy: some older order paths send the category LABEL instead of its id.
      const n = normStampName(cat);
      if (n && savedCatNames.has(n)) { count += qty; continue; }
    }
  }
  return count;
}

/** Most ids asked for per table level. The order's own ids come first, so it never loses them. */
export const MAX_IDS = 500;
/** Ids per request, so no request URL grows past what the gateway accepts. */
const CHUNK = 100;

/**
 * Look up the names (and category parents) of every category and item id the programmes and
 * the order refer to, on the Ops DB (menu_categories.id / menu_items.id are global keys).
 * Skipped (null, no queries) when stampLookupNeeded says nothing can change. NEVER throws: any
 * failure gives an empty or partial index and the caller falls back to the id match; one
 * overall deadline (timeoutMs) covers every query, and a late answer is ignored.
 * @param ops      Ops supabase client (service role)
 * @param programs active stamp_card_programs rows
 * @param items    loyalty-earn body.items
 */
export async function loadStampNameIndex(
  ops: any,
  programs: StampProgram[],
  items: any[],
  timeoutMs = 2500,
): Promise<StampNameIndex | null> {
  try {
    if (!ops || !Array.isArray(programs) || !Array.isArray(items)) return null;
    if (!stampLookupNeeded(programs, items)) return null;

    const savedCats: string[] = [];
    const savedItems: string[] = [];
    for (const p of programs) {
      savedCats.push(...idList(p?.qualifying_category_ids));
      savedItems.push(...idList(p?.qualifying_item_ids));
    }
    const needCats = savedCats.length > 0;
    const needItems = savedItems.length > 0;
    const orderCats: string[] = [];
    const orderItems: string[] = [];
    for (const it of items) {
      if (!it) continue;
      if (needCats && typeof it.cat === 'string' && it.cat) orderCats.push(it.cat);
      if (needItems && typeof it.id === 'string' && it.id) orderItems.push(it.id);
    }
    // The order's ids first, then the saved ones, so the cap can never drop the order's lines.
    const catIds = [...new Set([...orderCats, ...savedCats])].slice(0, MAX_IDS);
    const itemIds = [...new Set([...orderItems, ...savedItems])].slice(0, MAX_IDS);

    const index: StampNameIndex = { catNames: {}, catParents: {}, itemNames: {} };
    const endAt = Date.now() + Math.max(0, timeoutMs);
    let closed = false;

    // One query per chunk, all in parallel, each bounded by what is left of the deadline.
    const fetchRows = async (table: string, cols: string, ids: string[]): Promise<any[]> => {
      const chunks: string[][] = [];
      for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));
      const results = await Promise.all(chunks.map(async (chunk) => {
        try {
          const left = endAt - Date.now();
          if (left <= 0) return [];
          const res: any = await withDeadline(ops.from(table).select(cols).in('id', chunk), left);
          return res && !res.error && Array.isArray(res.data) ? res.data : [];
        } catch { return []; }
      }));
      return results.flat();
    };

    const work = async () => {
      const jobs: Promise<void>[] = [];
      if (needCats && catIds.length) {
        jobs.push((async () => {
          // Walk up the parents one level at a time until every chain reaches a top level.
          let ask = catIds;
          const asked = new Set<string>(ask);
          for (let depth = 0; depth < MAX_CATEGORY_DEPTH && ask.length && !closed; depth++) {
            const rows = await fetchRows('menu_categories', 'id, label, parent_id', ask);
            if (closed) return;
            const next: string[] = [];
            for (const r of rows) {
              if (!r || typeof r.id !== 'string' || typeof r.label !== 'string') continue;
              index.catNames[r.id] = r.label;
              const pid = typeof r.parent_id === 'string' && r.parent_id ? r.parent_id : null;
              index.catParents[r.id] = pid;
              if (pid && !asked.has(pid) && asked.size < MAX_IDS * 2) { asked.add(pid); next.push(pid); }
            }
            ask = next;
          }
        })());
      }
      if (needItems && itemIds.length) {
        jobs.push((async () => {
          const rows = await fetchRows('menu_items', 'id, name', itemIds);
          if (closed) return;
          for (const r of rows) if (r && typeof r.id === 'string' && typeof r.name === 'string') index.itemNames[r.id] = r.name;
        })());
      }
      await Promise.all(jobs);
    };

    await withDeadline(work().catch(() => {}), timeoutMs);
    closed = true;
    // A copy, so an answer that lands after the deadline can never change it mid earn.
    return {
      catNames: { ...index.catNames },
      catParents: { ...index.catParents },
      itemNames: { ...index.itemNames },
    };
  } catch {
    return null;
  }
}

function withDeadline<T>(p: PromiseLike<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([Promise.resolve(p), deadline]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}
