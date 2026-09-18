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
// NOW: a line qualifies when it matches a saved id (exactly as before), OR when its category
// (or the item itself) has the same NORMALISED NAME as any saved qualifying id. Names are
// resolved on Ops at earn time, so cards saved with one site's ids earn at every site with no
// re-save, including sites and menus added after the card was saved.
//
// CARD PATH SAFETY: loyalty-earn runs on the till payment path. loadStampNameIndex never
// throws and gives up after a short timeout; when it returns null, countQualifyingStamps is
// exactly today's id match. No qualifying categories or items still means every line earns.
//
// Pure TypeScript with erasable types only, so node:test imports it directly
// (src/lib/stampQualify.test.js).

/** Trim, lower-case and collapse runs of whitespace. '' for anything that is not a name. */
export function normStampName(s: unknown): string {
  if (typeof s !== 'string') return '';
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** id -> display name, for categories (menu_categories.label) and items (menu_items.name). */
export type StampNameIndex = {
  catNames: Record<string, string>;
  itemNames: Record<string, string>;
};

type StampProgram = {
  qualifying_category_ids?: unknown;
  qualifying_item_ids?: unknown;
};

function idList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length > 0) : [];
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

  // Names of the saved qualifying ids (whichever site they were saved from).
  const qualCatNames = new Set<string>();
  const qualItemNames = new Set<string>();
  if (index) {
    for (const id of qualCats) {
      const n = normStampName(index.catNames?.[id]);
      if (n) qualCatNames.add(n);
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
    if (qualCats.length > 0 && item.cat && qualCats.includes(item.cat)) { count += qty; continue; }

    // 2. Name match across the company.
    if (!index) continue;
    if (qualItemNames.size > 0 && item.id) {
      const n = normStampName(index.itemNames?.[item.id]);
      if (n && qualItemNames.has(n)) { count += qty; continue; }
    }
    if (qualCatNames.size > 0 && item.cat) {
      // The line carries its site's category id. An unknown id is tried as a name, because
      // some older order paths send the category label instead of its id.
      const known = index.catNames?.[item.cat];
      const n = normStampName(known !== undefined ? known : item.cat);
      if (n && qualCatNames.has(n)) { count += qty; continue; }
    }
  }
  return count;
}

const MAX_IDS = 500;

function withDeadline<T>(p: PromiseLike<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([Promise.resolve(p), deadline]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/**
 * Look up the names of every category and item id the programmes and the order refer to,
 * on the Ops DB (menu_categories.id / menu_items.id are global primary keys).
 * Only queries what some programme needs. NEVER throws: any failure or a slow answer gives
 * null (or an empty half), and the caller falls back to the id match.
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
    const catIds = new Set<string>();
    const itemIds = new Set<string>();
    let needCats = false;
    let needItems = false;
    for (const p of programs) {
      const qc = idList(p?.qualifying_category_ids);
      const qi = idList(p?.qualifying_item_ids);
      if (qc.length) { needCats = true; qc.forEach((id) => catIds.add(id)); }
      if (qi.length) { needItems = true; qi.forEach((id) => itemIds.add(id)); }
    }
    if (!needCats && !needItems) return null;
    for (const it of items) {
      if (!it) continue;
      if (needCats && typeof it.cat === 'string' && it.cat) catIds.add(it.cat);
      if (needItems && typeof it.id === 'string' && it.id) itemIds.add(it.id);
    }

    const index: StampNameIndex = { catNames: {}, itemNames: {} };
    const jobs: Promise<void>[] = [];
    if (needCats && catIds.size) {
      jobs.push((async () => {
        try {
          const res: any = await withDeadline(
            ops.from('menu_categories').select('id, label').in('id', [...catIds].slice(0, MAX_IDS)),
            timeoutMs,
          );
          if (!res || res.error || !Array.isArray(res.data)) return;
          for (const r of res.data) if (r && r.id && typeof r.label === 'string') index.catNames[r.id] = r.label;
        } catch { /* id match only */ }
      })());
    }
    if (needItems && itemIds.size) {
      jobs.push((async () => {
        try {
          const res: any = await withDeadline(
            ops.from('menu_items').select('id, name').in('id', [...itemIds].slice(0, MAX_IDS)),
            timeoutMs,
          );
          if (!res || res.error || !Array.isArray(res.data)) return;
          for (const r of res.data) if (r && r.id && typeof r.name === 'string') index.itemNames[r.id] = r.name;
        } catch { /* id match only */ }
      })());
    }
    await Promise.all(jobs);
    return index;
  } catch {
    return null;
  }
}
