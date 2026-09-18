// supabase/functions/_shared/ezcaterMenuSync.ts
//
// "SYNC ezCater MENU": every item, size and option on the venue's current ezCater menus is
// written to ezcater_item_links BEFORE any order, matched to our menu by name at sync time, so
// staff see what is matched, what needs a decision and what is not on our menu before a single
// order arrives. Orders then match themselves; anything new or unmatched still prints by name
// and never blocks an order.
//
// Peter, 18 Sep 2026: "we cant have it that we match products after an order has been placed
// that makes no sense someone would have to order the entire menu". He rejected pasting the
// menu and rejected relying on ezCater's menu team, and said yes to reading it through the API.
//
// THE ROWS
//   An item with ONE size is one row under its NAME KEY, exactly the key an order line by that
//   name lands on today (buildLinkKey, unchanged: the size key change of feat/ezcater-menu-upfront
//   broke live matching and is NOT reintroduced). An order line and the synced row are the same
//   row whichever way the line finds it.
//   An item with SEVERAL sizes gets one row PER SIZE, under '<name key>#<size>'. '#' never occurs
//   in a name key (keys are letters, digits and spaces), so these can never collide with a row
//   an order wrote by name. Only an order line's published id (menuItemSizeId) finds such a row;
//   a line without one falls back to the name exactly as before.
//   An option value is one row under its usual key, '<group>|<name>'. The same option on many
//   sizes is one row holding every published id it has.
//
// THE IDS
//   ez_ids           the PUBLISHED ids on ezCater's menu right now. These are what an order line
//                    carries, and they change on EVERY republish (ezCater, in writing).
//   ez_original_ids  the original...Id of each: very likely the ids that SURVIVE a republish.
//                    Likely, not proven, so they are only ever used to carry a saved match
//                    across, and a name match is the fallback.
//   ez_prior_ids     published ids the row held on EARLIER versions (added, never replaced,
//                    capped): an order placed on the previous version still lands on its size.
//   ez_ids empty on a row that has them before means it is no longer on ezCater's menu.
//
// CARRYING MATCHES ACROSS A REPUBLISH OR A RENAME (review round 4: narrowed)
//   A row's own decision always stands; a sync never overwrites a decision. A person's clear is
//   a decision too (source 'manual', no target), so nothing automatic matches over it. Only an
//   UNDECIDED row takes a decision carried by an original id, and only when that original is on
//   exactly one saved row and one thing in this read. Every write of a decision is guarded in
//   SQL to rows still undecided and never saved by a person, so a staff save landing in the same
//   moment always wins.
//
// AUTO MATCH AT SYNC TIME uses the existing rules (autoLinkDecision): one exact name and no size
// clash links; anything else only suggests. A size row is matched on "<item> <size>", so the
// size clash rule sees the size. Our menu must be read WHOLE, or nothing is auto linked.
//
// NOTHING HERE CAN DELAY OR REFUSE AN ORDER. The webhook runs a re-sync only after the order is
// written, in the background, and a failed sync changes nothing about any order.

import { autoLinkDecision, buildLinkKey, indexItemCodes } from './ezcaterMatch.ts';
import { menuSelectionFor, listMenus, readMenu, currentMenus, flattenMenu, venueDate } from './ezcaterMenu.ts';
import type { EzAsk } from './ezcaterMenu.ts';
import { readAllLinks, readMatchInputs, indexLinkIds, sizeKeyPart } from './ezcater-match-ingest.ts';
import { runWithBudget } from './budget.js';
import { readConnection, readCateringVenue } from './ezcaterIngest.ts';
import { ez } from './ezcater.ts';

/** Separates an item's name key from its size in a size row's key. Never in a name key. */
export const SIZE_KEY_SEP = '#';
/** A sync is re-run automatically once this old. */
export const MENU_SYNC_EVERY_MS = 23 * 60 * 60 * 1000;
/** An unseen published id re-syncs at most this often per venue. */
export const UNSEEN_RESYNC_MIN_MS = 15 * 60 * 1000;
/** A sync still marked running after this long is taken to have died. */
export const SYNC_STALE_RUNNING_MS = 5 * 60 * 1000;
/** Per ezCater call. */
export const EZ_MENU_CALL_TIMEOUT_MS = 20_000;
/** Concurrent row writes. */
const WRITE_CONCURRENCY = 10;
/** Rows per insert. */
const INSERT_BATCH = 200;

const t = (v: unknown): string => (v == null ? '' : String(v).trim());

/** A size's part of a size row key. Defined with the order side matcher so both use one rule. */
export { sizeKeyPart };

/** The row key of one ezCater size. PURE. '' when the item cannot be named. */
export function sizeRowKey(itemName: string, sizeName: string, sizeCount: number): string {
  const nameKey = buildLinkKey({ name: itemName }, 'item');
  if (!nameKey) return '';
  if (sizeCount > 1 && t(sizeName)) {
    const part = sizeKeyPart(sizeName);
    if (part) return nameKey + SIZE_KEY_SEP + part;
  }
  return nameKey;
}

export interface SyncEntity {
  kind: 'item' | 'option';
  key: string;
  name: string;
  group: string | null;
  sizeName: string | null;
  /** The ezCater size name as read, also for an item with ONE size (sizeName is then null). */
  sizeLabel?: string | null;
  category: string | null;
  menu: string | null;
  ids: string[];
  originals: string[];
}

/**
 * Every row a set of flattened menus makes, keyed 'kind:key', ids merged. PURE.
 * Two items (or two options) with the same key collapse into one row, which is exactly what an
 * order by that name would do.
 */
export function syncEntities(flat: Array<{ sizes: any[]; values: any[] }>): Map<string, SyncEntity> {
  const out = new Map<string, SyncEntity>();
  const add = (e: Omit<SyncEntity, 'ids' | 'originals'>, id: string, original: string) => {
    const k = e.kind + ':' + e.key;
    let cur = out.get(k);
    if (!cur) { cur = { ...e, ids: [], originals: [] }; out.set(k, cur); }
    if (id && !cur.ids.includes(id)) cur.ids.push(id);
    if (original && !cur.originals.includes(original)) cur.originals.push(original);
  };
  for (const f of flat) {
    for (const z of f.sizes || []) {
      const key = sizeRowKey(z.itemName, z.sizeName, z.sizeCount);
      if (!key) continue;
      add({
        kind: 'item', key, name: z.itemName, group: null,
        sizeName: key.includes(SIZE_KEY_SEP) ? (t(z.sizeName) || null) : null,
        sizeLabel: t(z.sizeName) || null,
        category: t(z.category) || null, menu: t(z.menuName) || null,
      }, t(z.sizeId), t(z.sizeOriginalId));
    }
    for (const v of f.values || []) {
      const key = buildLinkKey({ name: v.name, groupLabel: v.group || '' }, 'option');
      if (!key) continue;
      add({
        kind: 'option', key, name: v.name, group: t(v.group) || null, sizeName: null,
        category: null, menu: t(v.menuName) || null,
      }, t(v.valueId), t(v.valueOriginalId));
    }
  }
  return out;
}

const idsOf = (row: any, snake: string): string[] => (Array.isArray(row?.[snake]) ? row[snake].map((x: any) => t(x)).filter(Boolean) : []);
const isManual = (row: any) => t(row?.source) === 'manual';
/**
 * A row somebody or something has decided. A PERSON's save is always a decision, including a
 * clear (items_save writes source 'manual' with no target): review round 4, a staff clear must
 * stick, so nothing automatic ever matches over it.
 */
const hasDecision = (row: any) => !!row && (!!t(row.menu_item_id) || !!t(row.option_id) || t(row.matched_by) === 'ignored' || isManual(row));
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Published ids a row keeps from earlier versions of ezCater's menu (ez_prior_ids). Review round
 * 4: an order placed on the previous version must still land on its size after a republish, so
 * ids are ADDED, never replaced. Newest first, capped: an option on many sizes holds one id per
 * size per version, and 200 keeps several versions of even a large menu.
 */
export const EZ_PRIOR_IDS_MAX = 200;

/** The prior ids a row keeps when its current ids change to `next`. PURE. */
export function nextPriorIds(currentIds: string[], priorIds: string[], next: string[]): string[] {
  const keep = new Set(next);
  const out: string[] = [];
  for (const id of [...currentIds, ...priorIds]) {
    if (!id || keep.has(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= EZ_PRIOR_IDS_MAX) break;
  }
  return out;
}

export interface SyncPlan {
  inserts: any[];
  /** Menu facts on an existing row: ids, originals, size, category, menu. Never a decision. */
  facts: Array<{ kind: string; ezKey: string; patch: any }>;
  /**
   * A decision written onto a row, guarded in SQL: 'undecided' only onto a row still undecided;
   * 'asRead' (review round 5, an item shrinking to one size) only while the row's decision is
   * still exactly `expect`, the one this sync read, so a staff save in the same moment wins.
   */
  decisions: Array<{ kind: string; ezKey: string; guard: 'undecided' | 'asRead'; expect?: any; patch: any }>;
  counts: SyncCounts;
}

export interface SyncCounts {
  rows: number; items: number; sizes: number; options: number;
  inserted: number; updated: number; carried: number; autoMatched: number;
  matched: number; needsDecision: number; notOnOurMenu: number; ignored: number;
  offMenu: number;
}

/**
 * THE PLAN. PURE: what to insert, which menu facts to update, which decisions to write.
 *
 *   entities  syncEntities of every current menu read
 *   links     EVERY existing link row of the venue (readAllLinks), with the sync columns
 *   complete  true only when every caterer and every current menu was read. Only then may a row
 *             that is missing from the menu lose its ids ("no longer on ezCater").
 *   menuOk    true only when OUR menu was read whole. Only then is anything auto linked.
 */
export function planMenuSync(input: {
  entities: Map<string, SyncEntity>;
  links: any[];
  ourItems: any[];
  ourGroups: any[];
  menuOk: boolean;
  complete: boolean;
  locationId: string;
  nowIso: string;
}): SyncPlan {
  const { entities, locationId, nowIso } = input;
  const links = Array.isArray(input.links) ? input.links : [];
  const ourItems = Array.isArray(input.ourItems) ? input.ourItems : [];
  const ourGroups = Array.isArray(input.ourGroups) ? input.ourGroups : [];
  const codes = indexItemCodes(ourItems);

  const byKey = new Map<string, any>();
  for (const r of links) if (r && t(r.ez_key)) byKey.set((t(r.kind) || 'item') + ':' + t(r.ez_key), r);
  // original id -> every saved row that holds it, and how many rows of THIS read carry it. A
  // decision is carried by an original id only when both are exactly one (review round 4): an
  // original on two rows, or on two things on ezCater's menu, says nothing certain.
  const byOriginal = new Map<string, any[]>();
  for (const r of links) {
    for (const o of idsOf(r, 'ez_original_ids')) {
      const k = (t(r.kind) || 'item') + ':' + o;
      const list = byOriginal.get(k) || [];
      if (!list.includes(r)) list.push(r);
      byOriginal.set(k, list);
    }
  }
  const originalsInRead = new Map<string, number>();
  for (const e of entities.values()) {
    for (const o of e.originals) originalsInRead.set(e.kind + ':' + o, (originalsInRead.get(e.kind + ':' + o) || 0) + 1);
  }

  const counts: SyncCounts = {
    rows: entities.size, items: 0, sizes: 0, options: 0,
    inserted: 0, updated: 0, carried: 0, autoMatched: 0,
    matched: 0, needsDecision: 0, notOnOurMenu: 0, ignored: 0, offMenu: 0,
  };
  const itemNames = new Set<string>();
  const inserts: any[] = [];
  const facts: SyncPlan['facts'] = [];
  const decisions: SyncPlan['decisions'] = [];
  const claimedOriginals = new Set<string>();   // 'kind:original' now held by a synced row

  // Size rows still ON the menu (current published ids), by their item's name key. An item that
  // had several sizes and now has one is found through these (review round 5).
  const liveSizeRows = new Map<string, any[]>();
  for (const r of links) {
    if (!r || (t(r.kind) || 'item') !== 'item') continue;
    const k = t(r.ez_key);
    const cut = k.indexOf(SIZE_KEY_SEP);
    if (cut <= 0 || !idsOf(r, 'ez_ids').length) continue;
    const list = liveSizeRows.get(k.slice(0, cut)) || [];
    list.push(r);
    liveSizeRows.set(k.slice(0, cut), list);
  }

  for (const e of entities.values()) {
    if (e.kind === 'item') { counts.sizes += Math.max(1, e.ids.length); itemNames.add(buildLinkKey({ name: e.name }, 'item')); }
    else counts.options++;
    for (const o of e.originals) claimedOriginals.add(e.kind + ':' + o);

    const ex = byKey.get(e.kind + ':' + e.key) || null;
    let decision: any = null;          // the patch to write, if any
    let guard: 'undecided' | 'asRead' = 'undecided';
    let expect: any = null;
    let finalRow: any = ex ? { ...ex } : {};

    // 0) SHRINKING TO ONE SIZE (review round 5). The item had several sizes, so its old name only
    // row (say 'soup', a staff match to our Soup Small from before the sync) was hidden and its
    // size rows were the ones staff matched. Now it has ONE size and that size is keyed by the
    // name again. The hidden row's old target must not come back: the row takes the decision of
    // the one size's OWN row (the size row holding its original id, else the size row of the same
    // size name), or none, and is then matched afresh. Only while the name row is still hidden
    // (no current published ids) and its size rows are still on the menu, so it happens once.
    const liveSizes = e.kind === 'item' && !e.key.includes(SIZE_KEY_SEP) && ex && !idsOf(ex, 'ez_ids').length
      ? (liveSizeRows.get(e.key) || []) : [];
    const shrunk = liveSizes.length > 0;
    if (shrunk) {
      const byOrig = liveSizes.filter((r) => idsOf(r, 'ez_original_ids').some((o) => e.originals.includes(o)));
      let own: any = byOrig.length === 1 ? byOrig[0] : null;
      if (!own && byOrig.length === 0 && t(e.sizeLabel)) {
        own = liveSizes.find((r) => t(r.ez_key) === e.key + SIZE_KEY_SEP + sizeKeyPart(e.sizeLabel)) || null;
      }
      const next = own && hasDecision(own)
        ? { menu_item_id: t(own.menu_item_id) || null, option_id: null, source: isManual(own) ? 'manual' : 'auto', matched_by: t(own.matched_by) || null }
        : { menu_item_id: null, option_id: null, source: 'auto', matched_by: null };
      guard = 'asRead';
      expect = {
        menu_item_id: t(ex.menu_item_id) || null, option_id: t(ex.option_id) || null,
        source: t(ex.source) || null, matched_by: t(ex.matched_by) || null,
      };
      finalRow = { ...finalRow, ...next };
      if (own && hasDecision(own)) counts.carried++;
      const same = (Object.keys(next) as Array<keyof typeof next>).every((k) => (next[k] || null) === (expect[k] || null));
      if (!same) decision = next;
    }

    // 1) The row's OWN decision (by its key, its name) always stands: a sync never overwrites a
    // decision, a person's or an automatic one (review round 4). Only an UNDECIDED row may take
    // one carried from another row by an original id (a republish that renamed it), and only
    // when that original is on exactly one saved row and on exactly one thing in this read.
    if (!shrunk && !hasDecision(ex)) {
      let carried: any = null;
      for (const o of e.originals) {
        const k = e.kind + ':' + o;
        const holders = byOriginal.get(k) || [];
        if (holders.length !== 1 || (originalsInRead.get(k) || 0) !== 1) continue;
        const r = holders[0];
        if (r !== ex && hasDecision(r)) { carried = r; break; }
      }
      if (carried) {
        const target = !!(t(carried.menu_item_id) || t(carried.option_id));
        decision = {
          menu_item_id: t(carried.menu_item_id) || null,
          option_id: t(carried.option_id) || null,
          source: isManual(carried) ? 'manual' : 'auto',
          // A carried clear stays a clear (matched_by null); a carried match says it was carried.
          matched_by: t(carried.matched_by) || (target ? (isManual(carried) ? 'carried' : 'name') : null),
        };
        counts.carried++;
        finalRow = { ...finalRow, ...decision };
      }
    }

    // 2) No saved decision anywhere: the existing rules, against our WHOLE menu only.
    let autoAction: string | null = null;
    if (!hasDecision(finalRow) && input.menuOk) {
      const line = e.kind === 'item'
        ? { name: e.sizeName ? `${e.name} ${e.sizeName}` : e.name }
        : { name: e.name, groupLabel: e.group || '' };
      const d: any = e.kind === 'item'
        ? autoLinkDecision(line, ourItems, [], { kind: 'item', itemCodes: codes })
        : autoLinkDecision(line, ourGroups, [], { kind: 'option', itemCodes: codes });
      autoAction = d.action;
      if (d.action === 'linked' && d.source === 'auto') {
        const menuItemId = d.itemId != null ? t(d.itemId) || null : null;
        const optionId = e.kind === 'option' && d.optionId != null ? t(d.optionId) || null : null;
        if (menuItemId || optionId) {
          decision = { menu_item_id: menuItemId, option_id: optionId, source: 'auto', matched_by: 'name' };
          counts.autoMatched++;
          finalRow = { ...finalRow, ...decision };
        }
      }
    }

    // Counts, in the three words the screen uses.
    if (t(finalRow.menu_item_id) || t(finalRow.option_id)) counts.matched++;
    else if (t(finalRow.matched_by) === 'ignored') { counts.ignored++; counts.notOnOurMenu++; }
    else if (autoAction === 'none') counts.notOnOurMenu++;
    else counts.needsDecision++;

    const priorIds = ex ? nextPriorIds(idsOf(ex, 'ez_ids'), idsOf(ex, 'ez_prior_ids'), e.ids) : [];
    const menuFacts = {
      ez_ids: e.ids,
      ez_prior_ids: priorIds,
      ez_original_ids: e.originals,
      ez_size_name: e.sizeName,
      ez_category: e.category,
      ez_menu: e.menu,
    };
    if (!ex) {
      inserts.push({
        location_id: locationId,
        kind: e.kind,
        ez_key: e.key,
        ez_name: e.name,
        ez_group: e.kind === 'option' ? e.group : null,
        ...menuFacts,
        menu_item_id: decision ? decision.menu_item_id : null,
        option_id: decision ? decision.option_id : null,
        source: decision ? decision.source : 'auto',
        matched_by: decision ? decision.matched_by : null,
        seen_count: 0,
        last_seen_at: null,
        synced_at: nowIso,
        updated_at: nowIso,
      });
      counts.inserted++;
      continue;
    }
    const changed = !sameList(idsOf(ex, 'ez_ids'), e.ids) || !sameList(idsOf(ex, 'ez_prior_ids'), priorIds)
      || !sameList(idsOf(ex, 'ez_original_ids'), e.originals)
      || t(ex.ez_size_name) !== t(e.sizeName) || t(ex.ez_category) !== t(e.category) || t(ex.ez_menu) !== t(e.menu)
      || !t(ex.synced_at);
    if (changed) {
      facts.push({ kind: e.kind, ezKey: e.key, patch: { ...menuFacts, synced_at: nowIso, updated_at: nowIso } });
      counts.updated++;
    }
    if (decision) {
      decisions.push(guard === 'asRead'
        ? { kind: e.kind, ezKey: e.key, guard, expect, patch: { ...decision, updated_at: nowIso } }
        : { kind: e.kind, ezKey: e.key, guard, patch: { ...decision, updated_at: nowIso } });
    }
  }
  counts.items = itemNames.size;

  // Rows no longer on ezCater's menu: they have no CURRENT published id (the screen says "no
  // longer on the ezCater menu"), their ids move to ez_prior_ids so an order placed on the old
  // version still lands here, and they lose the originals another row now holds. Only after a
  // COMPLETE read: a caterer or menu we could not read says nothing about what is on it.
  // An old name only row of an item that now has several sizes ends up here too: the screen
  // hides it as replaced by its size rows (ezcaterItemRows.js replacedBySizes), and it can never
  // decide a line whose id lands on a size row (decideWithSyncedRow).
  if (input.complete) {
    for (const r of links) {
      const kind = t(r.kind) || 'item';
      if (entities.has(kind + ':' + t(r.ez_key))) continue;
      const ids = idsOf(r, 'ez_ids');
      const originals = idsOf(r, 'ez_original_ids');
      const kept = originals.filter((o) => !claimedOriginals.has(kind + ':' + o));
      if (!ids.length && kept.length === originals.length) continue;
      const prior = nextPriorIds(ids, idsOf(r, 'ez_prior_ids'), []);
      facts.push({ kind, ezKey: t(r.ez_key), patch: { ez_ids: [], ez_prior_ids: prior, ez_original_ids: kept, updated_at: nowIso } });
      if (ids.length) counts.offMenu++;
    }
  }

  return { inserts, facts, decisions, counts };
}

// ── The database side ───────────────────────────────────────────────────────────────────────

/** Run fn over items, at most `n` at a time. */
async function inPool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => { while (i < items.length) { const x = items[i++]; await fn(x); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/** Apply a plan. Never throws; returns how many writes failed. */
export async function applyMenuSync(sb: any, locationId: string, plan: SyncPlan, log: (...a: unknown[]) => void = () => {}): Promise<{ failed: number }> {
  let failed = 0;
  for (let i = 0; i < plan.inserts.length; i += INSERT_BATCH) {
    const batch = plan.inserts.slice(i, i + INSERT_BATCH);
    try {
      // ON CONFLICT DO NOTHING: an order that wrote the same key in the meantime keeps its row,
      // and the next sync adds the ids to it.
      const { error } = await sb.from('ezcater_item_links').upsert(batch, { onConflict: 'location_id,kind,ez_key', ignoreDuplicates: true });
      if (error) { failed += batch.length; log('insert failed:', error.message); }
    } catch (e) { failed += batch.length; log('insert threw:', e instanceof Error ? e.message : String(e)); }
  }
  await inPool(plan.facts, WRITE_CONCURRENCY, async (f) => {
    try {
      const { error } = await sb.from('ezcater_item_links').update(f.patch)
        .eq('location_id', locationId).eq('kind', f.kind).eq('ez_key', f.ezKey);
      if (error) { failed++; log('update failed:', f.ezKey, error.message); }
    } catch (e) { failed++; log('update threw:', e instanceof Error ? e.message : String(e)); }
  });
  await inPool(plan.decisions, WRITE_CONCURRENCY, async (d) => {
    try {
      let q = sb.from('ezcater_item_links').update(d.patch)
        .eq('location_id', locationId).eq('kind', d.kind).eq('ez_key', d.ezKey);
      // The guard lives in SQL, so a person saving in the same moment always wins: only a row
      // with no target, not silenced, and never saved by a person (a clear is source 'manual').
      // 'asRead': only while the row's decision is exactly the one the plan read.
      if (d.guard === 'asRead' && d.expect) {
        for (const c of ['menu_item_id', 'option_id', 'source', 'matched_by']) {
          const want = d.expect[c];
          q = want == null ? q.is(c, null) : q.eq(c, want);
        }
      } else {
        q = q.is('menu_item_id', null).is('option_id', null).is('matched_by', null).eq('source', 'auto');
      }
      const { error } = await q;
      if (error) { failed++; log('decision failed:', d.ezKey, error.message); }
    } catch (e) { failed++; log('decision threw:', e instanceof Error ? e.message : String(e)); }
  });
  return { failed };
}

// ── Sync state (ezcater_menu_syncs) ─────────────────────────────────────────────────────────

const STATE_COLUMNS = 'location_id, status, reason, last_attempt_at, last_synced_at, counts, menus, error, unresolved_ids';

/** The venue's sync state, or null (never synced, or the table is not there yet). Never throws. */
export async function readSyncState(sb: any, locationId: string): Promise<any | null> {
  try {
    const { data, error } = await sb.from('ezcater_menu_syncs').select(STATE_COLUMNS).eq('location_id', locationId).maybeSingle();
    if (error) return null;
    return data || null;
  } catch { return null; }
}

/** True while a sync marked running is younger than SYNC_STALE_RUNNING_MS. PURE. */
export function isRunning(state: any, nowMs: number): boolean {
  const last = Date.parse(t(state?.last_attempt_at));
  return state?.status === 'running' && Number.isFinite(last) && nowMs - last < SYNC_STALE_RUNNING_MS;
}

/**
 * ONE SYNC PER VENUE, claimed atomically (review round 4). Read the state, then claim it with a
 * conditional write that only succeeds if nobody changed it in between:
 *   no row yet    INSERT; a second claimant hits the primary key and loses
 *   a row         UPDATE ... WHERE last_attempt_at and status are what we read; a second claimant
 *                 matches no row (the first one moved last_attempt_at) and loses
 * Never throws. absent: the table is not there yet (its migration is run by hand).
 */
export async function claimSyncLock(sb: any, locationId: string, reason: string, nowIso: string, nowMs: number): Promise<{
  claimed: boolean; absent?: boolean; running?: boolean; error?: string;
}> {
  try {
    const { data: cur, error } = await sb.from('ezcater_menu_syncs').select(STATE_COLUMNS).eq('location_id', locationId).maybeSingle();
    if (error) {
      const code = String(error.code || '');
      const absent = code === '42P01' || code === 'PGRST205' || code === '42703' || /does not exist|could not find/i.test(String(error.message || ''));
      return { claimed: false, absent, error: String(error.message || code || 'could not read the sync state') };
    }
    if (isRunning(cur, nowMs)) return { claimed: false, running: true };
    const running = { status: 'running', reason, last_attempt_at: nowIso, updated_at: nowIso };
    if (!cur) {
      const { error: e2 } = await sb.from('ezcater_menu_syncs').insert({ location_id: locationId, ...running });
      if (!e2) return { claimed: true };
      return String(e2.code || '') === '23505' ? { claimed: false, running: true } : { claimed: false, error: String(e2.message || e2.code) };
    }
    let q = sb.from('ezcater_menu_syncs').update(running).eq('location_id', locationId);
    q = cur.last_attempt_at == null ? q.is('last_attempt_at', null) : q.eq('last_attempt_at', cur.last_attempt_at);
    q = cur.status == null ? q.is('status', null) : q.eq('status', cur.status);
    const { data, error: e3 } = await q.select('location_id');
    if (e3) return { claimed: false, error: String(e3.message || e3.code) };
    return Array.isArray(data) && data.length === 1 ? { claimed: true } : { claimed: false, running: true };
  } catch (e) {
    return { claimed: false, error: e instanceof Error ? e.message : String(e) };
  }
}

async function writeSyncState(sb: any, row: any): Promise<void> {
  try { await sb.from('ezcater_menu_syncs').upsert(row, { onConflict: 'location_id' }); } catch { /* best effort */ }
}

/** The ezCater caller for one connection: named operations, the Apollo headers, a timeout. */
export function askFor(conn: any): EzAsk {
  return async (op, query, variables = {}) => {
    const ac = new AbortController();
    const timer = setTimeout(() => { try { ac.abort(); } catch { /* noop */ } }, EZ_MENU_CALL_TIMEOUT_MS);
    try { return await ez<any>(conn.api_token, op, query, variables, conn.api_url ?? null, ac.signal); }
    finally { clearTimeout(timer); }
  };
}

export interface SyncResult {
  ok: boolean;
  enabled: boolean;
  error?: string;
  skipped?: string;
  complete?: boolean;
  menuOk?: boolean;
  menus?: string[];
  counts?: SyncCounts;
  failedWrites?: number;
  errors?: string[];
  syncedAt?: string;
}

const MIGRATION = '20260918_OPS_ezcater_menu_sync.sql';
/** Written on the sync state when the hourly run's time budget cut a venue off. */
export const BUDGET_CUT_ERROR = 'The hourly menu sync ran out of time before this venue finished. Nothing was changed; it will be tried again.';

/**
 * Release a lock THIS sync claimed (status 'running', claimed at claimedAtIso) when the hourly
 * budget cut it off (review round 5). Conditional on both, so it can never release a lock a later
 * sync (staff, or a re-sync after an order) claimed since. Never throws.
 */
export async function releaseSyncLock(sb: any, locationId: string, claimedAtIso: string, message: string = BUDGET_CUT_ERROR): Promise<boolean> {
  try {
    const { data, error } = await sb.from('ezcater_menu_syncs')
      .update({ status: 'error', error: message.slice(0, 1000), updated_at: new Date().toISOString() })
      .eq('location_id', locationId).eq('status', 'running').eq('last_attempt_at', claimedAtIso)
      .select('location_id');
    return !error && Array.isArray(data) && data.length > 0;
  } catch { return false; }
}

/**
 * Sync one venue: every current menu of every caterer mapped to it. Never throws.
 *
 *   askFactory  builds the ezCater caller for a connection (tests pass a fake; default askFor)
 *   reason      'staff' | 'daily' | 'republish', written on the sync state
 */
export async function syncVenueMenus(sb: any, platform: any, locationId: string, opts: {
  askFactory?: (conn: any) => EzAsk;
  nowIso?: string;
  nowMs?: number;
  reason?: string;
  log?: (...a: unknown[]) => void;
  /** Published ids an order carried that no row held (resyncForUnseen). */
  unseen?: string[];
  /** The sync state read before this sync, for the unresolved ids already remembered. */
  priorState?: any;
  /**
   * Wall clock (Date.now() ms) past which this sync gives up before writing anything and
   * releases its lock (the hourly run's budget, review round 5). None means no limit.
   */
  deadlineMs?: number | null;
} = {}): Promise<SyncResult> {
  const log = opts.log || (() => {});
  const nowMs = Number.isFinite(opts.nowMs as number) ? (opts.nowMs as number) : Date.now();
  const nowIso = opts.nowIso || new Date(nowMs).toISOString();
  const reason = opts.reason || 'staff';
  const errors: string[] = [];

  let claimed = false;
  try {
    // 1) One sync at a time per venue, claimed atomically BEFORE anything is read.
    const claim = await claimSyncLock(sb, locationId, reason, nowIso, nowMs);
    if (claim.running) return { ok: false, enabled: true, skipped: 'running', error: 'A menu sync is already running. Try again in a minute.' };
    claimed = claim.claimed;
    if (!claimed && !claim.absent) return { ok: false, enabled: true, error: `Could not start the menu sync: ${claim.error || 'unknown'}` };
    const giveUp = async (res: SyncResult): Promise<SyncResult> => {
      if (claimed) await writeSyncState(sb, { location_id: locationId, status: 'error', reason, last_attempt_at: nowIso, error: t(res.error).slice(0, 1000), updated_at: nowIso });
      return res;
    };

    // 2) The table, with the sync columns. Before the migration there is nothing to write to.
    const links = await readAllLinks(sb, locationId);
    if (links.absent) return giveUp({ ok: false, enabled: false, error: 'Item matching is not switched on yet.' });
    if (!links.ok) return giveUp({ ok: false, enabled: true, error: 'Could not read the saved matches. Nothing was changed.' });
    if (!links.synced || !claimed) return giveUp({ ok: false, enabled: false, error: `Menu sync needs ${MIGRATION} to be run first.` });
    if (!links.complete) return giveUp({ ok: false, enabled: true, error: 'Could not read every saved match. Nothing was changed.' });

    // 3) The caterers mapped to this venue, each through ITS OWN connection only.
    const { data: cats } = await sb.from('ezcater_caterers')
      .select('caterer_uuid, connection_id, active').eq('location_id', locationId);
    const mine = (cats || []).filter((c: any) => c && t(c.caterer_uuid) && c.active !== false);
    if (!mine.length) {
      const msg = 'No ezCater caterer is linked to this venue yet.';
      await writeSyncState(sb, { location_id: locationId, status: 'error', reason, last_attempt_at: nowIso, error: msg, updated_at: nowIso });
      return { ok: false, enabled: true, error: msg };
    }

    let timeZone = 'Europe/London';
    try { timeZone = (await readCateringVenue(sb, platform, locationId)).timeZone || timeZone; } catch { /* default */ }
    const today = venueDate(nowMs, timeZone);

    const flat: Array<{ sizes: any[]; values: any[] }> = [];
    const menuNames: string[] = [];
    let complete = true;
    let anyRead = false;
    for (const c of mine) {
      const conn = c.connection_id ? await readConnection(sb, c.connection_id) : null;
      if (!conn?.api_token) { complete = false; errors.push(`caterer ${c.caterer_uuid}: not connected`); continue; }
      const ask = (opts.askFactory || askFor)(conn);
      try {
        const sel = await menuSelectionFor(ask, log);
        const all = await listMenus(ask, t(c.caterer_uuid), sel.pageInfo);
        const current = currentMenus(all, today);
        if (!current.length) {
          // Nothing current is not proof that nothing is on sale (a date on the wrong clock
          // would say the same), so it clears nothing.
          complete = false;
          errors.push(`caterer ${c.caterer_uuid}: no current menu on ${today} (${all.length} menus in all)`);
        }
        for (const m of current) {
          try {
            const menu = await readMenu(ask, t(c.caterer_uuid), t(m.id), sel.selection);
            if (!menu) { complete = false; errors.push(`menu ${m.name || m.id}: empty answer`); continue; }
            flat.push(flattenMenu(menu));
            menuNames.push(t(menu.name) || t(m.name) || t(m.id));
            anyRead = true;
          } catch (e) {
            complete = false;
            errors.push(`menu ${m.name || m.id}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } catch (e) {
        complete = false;
        errors.push(`caterer ${c.caterer_uuid}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!anyRead) {
      const msg = errors.length ? `Could not read the ezCater menu: ${errors[0]}` : 'Could not read the ezCater menu.';
      await writeSyncState(sb, { location_id: locationId, status: 'error', reason, last_attempt_at: nowIso, error: msg.slice(0, 1000), updated_at: nowIso });
      return { ok: false, enabled: true, error: msg, errors };
    }

    // Out of time (the hourly budget): stop before writing and release the lock now, so the
    // venue is not blocked for SYNC_STALE_RUNNING_MS by a sync nobody is waiting for.
    const outOfBudget = () => opts.deadlineMs != null && Number.isFinite(opts.deadlineMs) && Date.now() >= (opts.deadlineMs as number);
    if (outOfBudget()) return giveUp({ ok: false, enabled: true, error: BUDGET_CUT_ERROR });

    // 4) Our menu, whole or not at all for auto matching.
    const ours = await readMatchInputs(sb, locationId, { skipLinks: true });
    if (outOfBudget()) return giveUp({ ok: false, enabled: true, error: BUDGET_CUT_ERROR });

    // 5) Plan and write.
    const entities = syncEntities(flat);
    const plan = planMenuSync({
      entities, links: links.rows, ourItems: ours.ourItems, ourGroups: ours.ourGroups,
      menuOk: ours.menuOk, complete, locationId, nowIso,
    });
    const applied = await applyMenuSync(sb, locationId, plan, (...a) => log('[menu sync]', ...a));

    const status = applied.failed ? 'partial' : (complete ? 'ok' : 'partial');
    // Published ids an order carried that this sync still could not find: remembered, so the
    // next order carrying them does not re-sync again (review round 4, resyncForUnseen). Only
    // after a COMPLETE read (review round 5): an id missing from a caterer or menu we could not
    // read says nothing, so it is not given up on; ids remembered earlier are kept.
    const known = new Set<string>();
    for (const e of entities.values()) for (const id of e.ids) known.add(e.kind + ':' + id);
    for (const k of indexLinkIds(links.rows).keys()) known.add(k);
    const unresolved = nextUnresolved(opts.priorState?.unresolved_ids ?? null, complete ? (opts.unseen || []) : [], known, nowMs, nowIso);
    await writeSyncState(sb, {
      location_id: locationId, status, reason, last_attempt_at: nowIso, last_synced_at: nowIso,
      counts: { ...plan.counts, menuOk: ours.menuOk, complete, failedWrites: applied.failed },
      menus: menuNames, error: errors.length ? errors.join('; ').slice(0, 1000) : null,
      unresolved_ids: unresolved, updated_at: nowIso,
    });
    log('synced', locationId, menuNames.join(', '), JSON.stringify(plan.counts));
    return {
      ok: true, enabled: true, complete, menuOk: ours.menuOk, menus: menuNames, counts: plan.counts,
      failedWrites: applied.failed, errors, syncedAt: nowIso,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (claimed) await writeSyncState(sb, { location_id: locationId, status: 'error', reason, last_attempt_at: nowIso, error: msg.slice(0, 1000), updated_at: nowIso });
    return { ok: false, enabled: true, error: `The menu sync failed: ${msg}`, errors };
  }
}

/** How long a published id a re-sync could not find is left alone before it may re-sync again. */
export const UNRESOLVED_BACKOFF_MS = MENU_SYNC_EVERY_MS;
/** Unresolved ids remembered per venue. */
export const UNRESOLVED_MAX = 500;

/** The remembered unresolved ids still inside their back off: id -> when first given up on. PURE. */
export function liveUnresolved(stored: any, nowMs: number): Map<string, string> {
  const out = new Map<string, string>();
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
  for (const [id, at] of Object.entries(stored)) {
    const ms = Date.parse(t(at));
    if (t(id) && Number.isFinite(ms) && nowMs - ms < UNRESOLVED_BACKOFF_MS) out.set(t(id), t(at));
  }
  return out;
}

/**
 * The unresolved ids to remember after a sync: the ones still live from before plus the ones
 * this sync was asked to find, minus every id a row now holds (known is 'kind:id'). PURE.
 */
export function nextUnresolved(stored: any, unseen: string[], known: Set<string>, nowMs: number, nowIso: string): Record<string, string> {
  const isKnown = (id: string) => known.has('item:' + id) || known.has('option:' + id);
  const live = liveUnresolved(stored, nowMs);
  for (const id of Array.isArray(unseen) ? unseen : []) if (t(id) && !live.has(t(id))) live.set(t(id), nowIso);
  const out: Record<string, string> = {};
  let n = 0;
  for (const [id, at] of live) {
    if (isKnown(id)) continue;
    out[id] = at;
    if (++n >= UNRESOLVED_MAX) break;
  }
  return out;
}

/**
 * An order carried published ids no synced row holds: ezCater republished. Re-sync, at most once
 * per UNSEEN_RESYNC_MIN_MS per venue, and never again for ids an earlier re-sync already looked
 * for and could not find (an order on a menu that is not current, an option the schema would not
 * let us read): those wait for the daily sync (review round 4). Called AFTER the order is
 * written. Never throws.
 */
export async function resyncForUnseen(sb: any, platform: any, locationId: string, unseen: string[], opts: {
  askFactory?: (conn: any) => EzAsk; nowMs?: number; log?: (...a: unknown[]) => void;
} = {}): Promise<SyncResult | { ok: false; enabled: true; skipped: string }> {
  if (!Array.isArray(unseen) || !unseen.length) return { ok: false, enabled: true, skipped: 'nothing unseen' };
  const nowMs = Number.isFinite(opts.nowMs as number) ? (opts.nowMs as number) : Date.now();
  const state = await readSyncState(sb, locationId);
  const tried = liveUnresolved(state?.unresolved_ids, nowMs);
  const fresh = unseen.map((x) => t(x)).filter((x) => x && !tried.has(x));
  if (!fresh.length) return { ok: false, enabled: true, skipped: 'looked for already' };
  const last = Date.parse(t(state?.last_attempt_at));
  if (Number.isFinite(last) && nowMs - last < UNSEEN_RESYNC_MIN_MS) return { ok: false, enabled: true, skipped: 'synced recently' };
  return syncVenueMenus(sb, platform, locationId, { ...opts, nowMs, reason: 'republish', unseen: fresh, priorState: state });
}

/** True when a venue is due its daily sync. PURE. */
export function syncDue(state: any, nowMs: number): boolean {
  if (!state) return true;
  if (isRunning(state, nowMs)) return false;
  const synced = Date.parse(t(state.last_synced_at));
  const tried = Date.parse(t(state.last_attempt_at));
  if (Number.isFinite(tried) && nowMs - tried < 60 * 60 * 1000 && !(Number.isFinite(synced) && synced >= tried)) {
    return false;   // a failed attempt in the last hour: wait before trying again
  }
  return !Number.isFinite(synced) || nowMs - synced >= MENU_SYNC_EVERY_MS;
}

/** The whole hourly run, inside the edge function's wall clock (150 s) with room to answer. */
export const DUE_SYNC_BUDGET_MS = 100_000;
/** Venues synced side by side in the hourly run. */
export const DUE_SYNC_CONCURRENCY = 3;

/**
 * The due venues in FAIR order (review round 4): the one waiting longest first (never tried, then
 * oldest last attempt), so a venue that keeps failing, or a long list, can never starve the
 * venues behind it. PURE.
 */
export function dueVenuesInOrder(venues: string[], states: Map<string, any>, nowMs: number): string[] {
  const at = (id: string) => { const n = Date.parse(t(states.get(id)?.last_attempt_at)); return Number.isFinite(n) ? n : -Infinity; };
  return venues.filter((id) => syncDue(states.get(id) || null, nowMs))
    .sort((a, b) => (at(a) - at(b)) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The daily re-sync: every venue with a mapped caterer whose last sync is a day old, longest
 * waiting first, a few side by side, inside one time budget (_shared/budget.js). A venue the
 * budget did not reach is still due, and first in line next hour. Runs from pg_cron (hourly)
 * through ezcater-connect 'menu_sync_due'. Never throws.
 */
export async function syncDueVenues(sb: any, platform: any, opts: {
  askFactory?: (conn: any) => EzAsk; nowMs?: number; maxVenues?: number; budgetMs?: number; concurrency?: number;
  log?: (...a: unknown[]) => void;
} = {}): Promise<Array<{ locationId: string; ok: boolean; error?: string; skipped?: boolean }>> {
  const nowMs = Number.isFinite(opts.nowMs as number) ? (opts.nowMs as number) : Date.now();
  const log = opts.log || (() => {});
  try {
    const { data } = await sb.from('ezcater_caterers').select('location_id, active').not('location_id', 'is', null).limit(1000);
    const venues = [...new Set((data || []).filter((c: any) => c && c.active !== false && t(c.location_id)).map((c: any) => t(c.location_id)))] as string[];
    if (!venues.length) return [];
    const states = new Map<string, any>();
    const { data: rows, error } = await sb.from('ezcater_menu_syncs').select(STATE_COLUMNS).in('location_id', venues);
    if (error) { log('daily sync: could not read the sync states:', error.message); return []; }
    for (const r of rows || []) if (r && t(r.location_id)) states.set(t(r.location_id), r);
    const due = dueVenuesInOrder(venues, states, nowMs).slice(0, opts.maxVenues || 20);
    const nowIso = new Date(nowMs).toISOString();
    const budgetMs = opts.budgetMs ?? DUE_SYNC_BUDGET_MS;
    const deadlineMs = Date.now() + budgetMs;
    const results = await runWithBudget(due, (locationId: string) => syncVenueMenus(sb, platform, locationId, {
      askFactory: opts.askFactory, nowMs, nowIso, reason: 'daily', log, priorState: states.get(locationId) || null, deadlineMs,
    }), { concurrency: opts.concurrency || DUE_SYNC_CONCURRENCY, budgetMs });
    // A venue the budget cut off mid sync still holds its lock: release it (review round 5), only
    // where the lock is still the one this run claimed. A venue never reached claimed nothing.
    await Promise.all(due.map((locationId: string, i: number) => (results[i] && (results[i] as any).skipped
      ? releaseSyncLock(sb, locationId, nowIso) : Promise.resolve(false))));
    return due.map((locationId: string, i: number) => {
      const r: any = results[i];
      if (r?.ok) return { locationId, ok: !!r.value?.ok, ...(r.value?.error ? { error: r.value.error } : {}) };
      return { locationId, ok: false, error: r?.error || 'not run', ...(r?.skipped ? { skipped: true } : {}) };
    });
  } catch (e) {
    log('daily sync failed:', e instanceof Error ? e.message : String(e));
    return [];
  }
}

/** The sync state as the Back Office card shows it. */
export function publicSyncState(state: any): any {
  if (!state) return null;
  return {
    status: state.status ?? null,
    reason: state.reason ?? null,
    last_attempt_at: state.last_attempt_at ?? null,
    last_synced_at: state.last_synced_at ?? null,
    counts: state.counts ?? null,
    menus: Array.isArray(state.menus) ? state.menus : [],
    error: state.error ?? null,
  };
}
