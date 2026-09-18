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
//   3. auto links ONLY an exact name match to our menu, never across a size clash; everything
//      else is left for staff, who get suggestions on the Item matching card
//   It never deletes a row, never changes a decision (a staff match, "Not on our menu", a staff
//   clear, or an earlier auto link) and never touches seen_count. Syncing twice writes no new row.
//
// THE ORDER TIME RULE (sizeRouteFor, used by ezcater-match-ingest.ts), kept deliberately simple:
//   * a line whose published size id is on a synced SIZE row resolves to that row's decision,
//     and only when the row HAS one (a staff match or an exact auto link)
//   * a line whose size id is on a synced single size (plain) row, or that carries no size at
//     all, resolves by its name exactly as it did before this file
//   * ANY other sized line stays unmatched and prints by name: no guessed size, and no old name
//     match carried onto a sized line
//
// Pure functions first (tested under node), then the database and ezCater side. The ezCater call
// is passed in (ask), so nothing here needs Deno globals.

import { autoLinkDecision, buildLinkKey, normaliseKeyName } from './ezcaterMatch.ts';

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
 * the option values and the menus were read without them.
 */
export async function readCatererMenus(
  ask: EzAsk, catererId: string, today: string,
  isSchemaError: (e: unknown) => boolean = looksLikeSchemaError,
): Promise<{ menus: any[]; optionsRead: boolean }> {
  const list = await ask('ServOsEzMenus', MENUS_QUERY, { catererId });
  const nodes = currentMenus(list?.menus?.nodes, today);
  const menus: any[] = [];
  let optionsRead = true;
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
  }
  return { menus, optionsRead };
}

// ── Flattening ───────────────────────────────────────────────────────────────────────────────

export interface MenuEntry {
  kind: 'item' | 'option';
  ezKey: string;
  ezName: string;
  ezGroup: string | null;
  /** Set only on a row for ONE size of an item with several sizes. */
  ezSizeName: string | null;
  ezCategory: string | null;
  /** Published ids: a size id for an item row, a value id for an option row. */
  ids: string[];
  /** A size row whose size name adds nothing its siblings do not: never auto linked. */
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
    prev.noAuto = prev.noAuto || e.noAuto;
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
            put({ kind: 'item', ezKey: key, ezName: name, ezGroup: null, ezSizeName: null, ezCategory: category,
              ids: sizes.length && s(sizes[0].id) ? [s(sizes[0].id)] : [], noAuto: false });
          }
        } else {
          // Two sizes whose full names key the same ("Serves 10" and "Serves 20" both lose their
          // size to the noise rule) cannot be told apart by name, so neither is auto linked.
          const full = sizes.map((z) => normaliseKeyName(`${name} ${s(z.name)}`));
          for (let i = 0; i < sizes.length; i++) {
            const z = sizes[i];
            const key = sizeRowKey(name, z.name);
            if (!key) continue;
            const clash = full.filter((f) => f === full[i]).length > 1;
            put({ kind: 'item', ezKey: key, ezName: name, ezGroup: null, ezSizeName: s(z.name) || 'unnamed',
              ezCategory: category, ids: s(z.id) ? [s(z.id)] : [], noAuto: clash });
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
                ezCategory: category, ids: s(v?.id) ? [s(v.id)] : [], noAuto: false });
            }
          }
        }
      }
    }
  }
  return Array.from(out.values());
}

// ── Exact name auto links ────────────────────────────────────────────────────────────────────

const NO_CODES = new Map();

/**
 * Our target for one synced row, or null. EXACT NAMES ONLY, never across a size clash.
 *   plain item  autoLinkDecision with no saved links and no codes: one exact name of ours and no
 *               size clash, which is the same rule an order line has always used
 *   size row    exactly one of our items whose KEY name (size word kept) equals '<item> <size>',
 *               and only when the size really is in that key (a size lost to the noise rule, or
 *               shared with a sibling, links nothing)
 *   option      autoLinkDecision's option arm, one exact option name, no size clash
 */
export function autoTargetFor(entry: MenuEntry, ourItems: any[], ourGroups: any[]):
  { menuItemId: string | null; optionId: string | null } | null {
  if (entry.kind === 'option') {
    if (!arr(ourGroups).length) return null;
    const d: any = autoLinkDecision({ name: entry.ezName, groupLabel: entry.ezGroup || '' }, ourGroups, [],
      { kind: 'option', itemCodes: NO_CODES });
    if (d.action !== 'linked' || d.source !== 'auto' || !d.optionId) return null;
    return { menuItemId: d.itemId != null ? String(d.itemId) : null, optionId: String(d.optionId) };
  }
  if (!arr(ourItems).length) return null;
  if (!entry.ezSizeName) {
    const d: any = autoLinkDecision({ name: entry.ezName }, ourItems, [], { kind: 'item', itemCodes: NO_CODES });
    if (d.action !== 'linked' || d.source !== 'auto' || d.itemId == null) return null;
    return { menuItemId: String(d.itemId), optionId: null };
  }
  if (entry.noAuto) return null;
  const want = normaliseKeyName(`${entry.ezName} ${entry.ezSizeName}`);
  if (!want || want === normaliseKeyName(entry.ezName)) return null;
  const hits = new Set<string>();
  for (const it of arr(ourItems)) {
    if (!it || it.id == null) continue;
    for (const n of [it.name, it.menuName]) {
      if (typeof n === 'string' && n.trim() && normaliseKeyName(n) === want) { hits.add(String(it.id)); break; }
    }
  }
  return hits.size === 1 ? { menuItemId: Array.from(hits)[0], optionId: null } : null;
}

// ── The plan ─────────────────────────────────────────────────────────────────────────────────

const idsOf = (v: unknown): string[] => arr(v).map((x) => s(x)).filter(Boolean);

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
  counts: { items: number; sizes: number; options: number; inserted: number; refreshed: number; autoLinked: number; toDecide: number };
}

/**
 * What a sync writes. PURE.
 * `complete` false (a caterer or a menu could not be read) keeps every id already on a row and
 * adds the new ones, so a partial read can never take a live id away. `menuOk` false (our own
 * menu was only partly read) writes no auto link at all: "nothing else of ours has that name"
 * is not a claim a partial menu can make.
 */
export function planMenuSync(input: {
  entries: MenuEntry[]; existing: any[]; ourItems: any[]; ourGroups: any[];
  locationId: string; nowIso: string; complete: boolean; menuOk: boolean;
}): SyncPlan {
  const byKey = new Map<string, any>();
  for (const r of arr(input.existing)) if (r && s(r.ez_key)) byKey.set((s(r.kind) || 'item') + ':' + s(r.ez_key), r);
  const plan: SyncPlan = {
    inserts: [], refreshes: [], fills: [],
    counts: { items: 0, sizes: 0, options: 0, inserted: 0, refreshed: 0, autoLinked: 0, toDecide: 0 },
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
        ez_size_name: e.ezSizeName, ez_category: e.ezCategory, ez_ids: e.ids,
        menu_item_id: target ? target.menuItemId : null, option_id: target ? target.optionId : null,
        source: 'auto', matched_by: target ? 'name' : null,
        seen_count: 0, last_seen_at: null, synced_at: input.nowIso, updated_at: input.nowIso,
      });
      if (target) plan.counts.autoLinked++; else plan.counts.toDecide++;
      continue;
    }
    const ids = input.complete ? e.ids : Array.from(new Set([...idsOf(prev.ez_ids), ...e.ids]));
    plan.refreshes.push({
      location_id: input.locationId, kind: e.kind, ez_key: e.ezKey,
      ez_name: s(prev.ez_name) || e.ezName,
      ez_size_name: e.ezSizeName, ez_category: e.ezCategory, ez_ids: ids, synced_at: input.nowIso,
    });
    if (isBare(prev) && target) {
      plan.fills.push({ kind: e.kind, ezKey: e.ezKey, menuItemId: target.menuItemId, optionId: target.optionId });
      plan.counts.autoLinked++;
    } else if (!s(prev.menu_item_id) && !s(prev.option_id) && s(prev.matched_by) !== 'ignored') {
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
  | { mode: 'size'; ezKey: string; itemId: string | null }
  | { mode: 'unmatched'; reason: string };

/**
 * How one order line may be matched. PURE. See the rule at the top of this file.
 *   plain      the old name rules decide, unchanged
 *   size       the synced size row decides: its target, or nothing when it has none
 *   unmatched  nothing decides; the line prints by name
 */
export function sizeRouteFor(line: any, idIdx: Map<string, any[]>): SizeRoute {
  const id = s(line?.ezSizeId);
  const rows = id ? idIdx.get(id) || [] : [];
  if (rows.length) {
    const sized = rows.filter((r) => s(r.ez_size_name ?? r.ezSizeName));
    if (!sized.length) return { mode: 'plain' };
    // The same id on a size row and a plain row, or on two size rows that disagree: stale data,
    // and a guess either way. Unmatched.
    if (sized.length !== rows.length) return { mode: 'unmatched', reason: 'id on a plain row and a size row' };
    const targets = new Set(sized.map((r) => s(r.menu_item_id ?? r.menuItemId)));
    if (targets.size !== 1) return { mode: 'unmatched', reason: 'size rows disagree' };
    const t = Array.from(targets)[0];
    return { mode: 'size', ezKey: s(sized[0].ez_key ?? sized[0].ezKey), itemId: t || null };
  }
  if (s(line?.sizeName)) return { mode: 'unmatched', reason: id ? 'size id not on the synced menu' : 'sized line with no id' };
  return { mode: 'plain' };
}

// ── The database ─────────────────────────────────────────────────────────────────────────────

export const LINK_PAGE_SIZE = 1000;
export const LINK_MAX_PAGES = 50;

/** The link columns the matcher and the sync read, with and without the sync columns. */
export const LINK_COLUMNS = 'kind, ez_key, ez_name, ez_group, menu_item_id, option_id, source, matched_by, seen_count';
export const LINK_COLUMNS_WITH_SYNC = LINK_COLUMNS + ', ez_ids, ez_size_name';

/** True when a read failed because the sync columns are not there yet (migration not run). */
export function isMissingSyncColumn(err: any): boolean {
  if (!err) return false;
  const code = String(err.code || '');
  const msg = String(err.message || err.details || '');
  if (!/ez_ids|ez_size_name|ez_category|synced_at/i.test(msg)) return false;
  return code === '42703' || code === 'PGRST204' || /column/i.test(msg);
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
  Promise<{ inserted: number; refreshed: number; filled: number; errors: string[] }> {
  const done = { inserted: 0, refreshed: 0, filled: 0, errors: [] as string[] };
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
      .update({ menu_item_id: f.menuItemId, option_id: f.optionId, matched_by: 'name', updated_at: nowIso })
      .eq('location_id', locationId).eq('kind', f.kind).eq('ez_key', f.ezKey)
      .eq('source', 'auto').is('menu_item_id', null).is('option_id', null).is('matched_by', null);
    if (error) done.errors.push('fill: ' + (error.message || error)); else done.filled++;
  }
  return done;
}

/**
 * The one sync per venue lock. ezcater_menu_sync_claim (migration 20260918e) is a single
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
