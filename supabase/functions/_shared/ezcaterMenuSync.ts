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
//   ez_ids empty on a row that has them before means it is no longer on ezCater's menu.
//
// CARRYING MATCHES ACROSS A REPUBLISH OR A RENAME
//   For each synced row: a decision found through its original ids first, then its own key
//   (name). A PERSON's decision beats an automatic one; a person's decision already on the row
//   itself is never overwritten. Every write of a decision is guarded in SQL to rows that are
//   still undecided (or still automatic, for a person's decision carried over), so a staff save
//   landing in the same moment always wins.
//
// AUTO MATCH AT SYNC TIME uses the existing rules (autoLinkDecision): one exact name and no size
// clash links; anything else only suggests. A size row is matched on "<item> <size>", so the
// size clash rule sees the size. Our menu must be read WHOLE, or nothing is auto linked.
//
// NOTHING HERE CAN DELAY OR REFUSE AN ORDER. The webhook runs a re-sync only after the order is
// written, in the background, and a failed sync changes nothing about any order.

import { autoLinkDecision, buildLinkKey, normaliseKeyName, indexItemCodes } from './ezcaterMatch.ts';
import { menuSelectionFor, listMenus, readMenu, currentMenus, flattenMenu, venueDate } from './ezcaterMenu.ts';
import type { EzAsk } from './ezcaterMenu.ts';
import { readAllLinks, readMatchInputs } from './ezcater-match-ingest.ts';
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

/** A size's part of a size row key: its key form, else a plain fold (a size can be only noise). */
export function sizeKeyPart(size: unknown): string {
  const k = normaliseKeyName(size);
  if (k) return k;
  return String(size == null ? '' : size).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

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
const hasDecision = (row: any) => !!row && (!!t(row.menu_item_id) || !!t(row.option_id) || t(row.matched_by) === 'ignored');
const isManual = (row: any) => t(row?.source) === 'manual';
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export interface SyncPlan {
  inserts: any[];
  /** Menu facts on an existing row: ids, originals, size, category, menu. Never a decision. */
  facts: Array<{ kind: string; ezKey: string; patch: any }>;
  /** A decision written onto a row. guard 'undecided': only while it has none; 'auto': only while automatic. */
  decisions: Array<{ kind: string; ezKey: string; guard: 'undecided' | 'auto'; patch: any }>;
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
  // original id -> the row that holds it now. The row most recently synced wins a tie.
  const byOriginal = new Map<string, any>();
  const syncedMs = (r: any) => { const n = Date.parse(t(r?.synced_at)); return Number.isFinite(n) ? n : 0; };
  for (const r of links) {
    for (const o of idsOf(r, 'ez_original_ids')) {
      const k = (t(r.kind) || 'item') + ':' + o;
      const prev = byOriginal.get(k);
      if (!prev || syncedMs(r) > syncedMs(prev)) byOriginal.set(k, r);
    }
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

  for (const e of entities.values()) {
    if (e.kind === 'item') { counts.sizes += Math.max(1, e.ids.length); itemNames.add(buildLinkKey({ name: e.name }, 'item')); }
    else counts.options++;
    for (const o of e.originals) claimedOriginals.add(e.kind + ':' + o);

    const ex = byKey.get(e.kind + ':' + e.key) || null;
    // 1) A saved decision: through an original id first, then the row's own key (its name).
    let viaOriginal: any = null;
    for (const o of e.originals) {
      const r = byOriginal.get(e.kind + ':' + o);
      if (r && hasDecision(r)) { viaOriginal = r; break; }
    }
    const cands = [viaOriginal, hasDecision(ex) ? ex : null].filter(Boolean) as any[];
    const pick = cands.find(isManual) || cands[0] || null;

    let decision: any = null;          // the patch to write, if any
    let guard: 'undecided' | 'auto' = 'undecided';
    let finalRow: any = ex ? { ...ex } : {};
    if (pick && pick !== ex) {
      // Carried from another row (a republish that renamed it, or a size that became its own
      // row). Onto this row only while it is undecided, or automatic and the carried one is a
      // person's: a person's decision already on this row is never overwritten.
      const can = !hasDecision(ex) || (!isManual(ex) && isManual(pick));
      if (can) {
        decision = {
          menu_item_id: t(pick.menu_item_id) || null,
          option_id: t(pick.option_id) || null,
          source: isManual(pick) ? 'manual' : 'auto',
          matched_by: t(pick.matched_by) || (isManual(pick) ? 'carried' : 'name'),
        };
        guard = hasDecision(ex) ? 'auto' : 'undecided';
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
          guard = 'undecided';
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

    const menuFacts = {
      ez_ids: e.ids,
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
    const changed = !sameList(idsOf(ex, 'ez_ids'), e.ids) || !sameList(idsOf(ex, 'ez_original_ids'), e.originals)
      || t(ex.ez_size_name) !== t(e.sizeName) || t(ex.ez_category) !== t(e.category) || t(ex.ez_menu) !== t(e.menu)
      || !t(ex.synced_at);
    if (changed) {
      facts.push({ kind: e.kind, ezKey: e.key, patch: { ...menuFacts, synced_at: nowIso, updated_at: nowIso } });
      counts.updated++;
    }
    if (decision) decisions.push({ kind: e.kind, ezKey: e.key, guard, patch: { ...decision, updated_at: nowIso } });
  }
  counts.items = itemNames.size;

  // Rows no longer on ezCater's menu: they lose their published ids (an order cannot land on them
  // by id) and the originals another row now holds. Only after a COMPLETE read: a caterer or menu
  // we could not read says nothing about what is on it.
  if (input.complete) {
    for (const r of links) {
      const kind = t(r.kind) || 'item';
      if (entities.has(kind + ':' + t(r.ez_key))) continue;
      const ids = idsOf(r, 'ez_ids');
      const originals = idsOf(r, 'ez_original_ids');
      const kept = originals.filter((o) => !claimedOriginals.has(kind + ':' + o));
      if (!ids.length && kept.length === originals.length) continue;
      facts.push({ kind, ezKey: t(r.ez_key), patch: { ez_ids: [], ez_original_ids: kept, updated_at: nowIso } });
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
      // The guard lives in SQL, so a person saving in the same moment always wins.
      if (d.guard === 'undecided') q = q.is('menu_item_id', null).is('option_id', null).is('matched_by', null);
      else q = q.eq('source', 'auto');
      const { error } = await q;
      if (error) { failed++; log('decision failed:', d.ezKey, error.message); }
    } catch (e) { failed++; log('decision threw:', e instanceof Error ? e.message : String(e)); }
  });
  return { failed };
}

// ── Sync state (ezcater_menu_syncs) ─────────────────────────────────────────────────────────

const STATE_COLUMNS = 'location_id, status, reason, last_attempt_at, last_synced_at, counts, menus, error';

/** The venue's sync state, or null (never synced, or the table is not there yet). Never throws. */
export async function readSyncState(sb: any, locationId: string): Promise<any | null> {
  try {
    const { data, error } = await sb.from('ezcater_menu_syncs').select(STATE_COLUMNS).eq('location_id', locationId).maybeSingle();
    if (error) return null;
    return data || null;
  } catch { return null; }
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
} = {}): Promise<SyncResult> {
  const log = opts.log || (() => {});
  const nowMs = Number.isFinite(opts.nowMs as number) ? (opts.nowMs as number) : Date.now();
  const nowIso = opts.nowIso || new Date(nowMs).toISOString();
  const reason = opts.reason || 'staff';
  const errors: string[] = [];

  try {
    // 1) The table, with the sync columns. Before the migration there is nothing to write to.
    const links = await readAllLinks(sb, locationId);
    if (links.absent) return { ok: false, enabled: false, error: 'Item matching is not switched on yet.' };
    if (!links.ok) return { ok: false, enabled: true, error: 'Could not read the saved matches. Nothing was changed.' };
    if (!links.synced) return { ok: false, enabled: false, error: `Menu sync needs ${MIGRATION} to be run first.` };
    if (!links.complete) return { ok: false, enabled: true, error: 'Could not read every saved match. Nothing was changed.' };

    // 2) One sync at a time per venue.
    const state = await readSyncState(sb, locationId);
    const lastAttempt = Date.parse(t(state?.last_attempt_at));
    if (state?.status === 'running' && Number.isFinite(lastAttempt) && nowMs - lastAttempt < SYNC_STALE_RUNNING_MS) {
      return { ok: false, enabled: true, skipped: 'running', error: 'A menu sync is already running. Try again in a minute.' };
    }
    await writeSyncState(sb, { location_id: locationId, status: 'running', reason, last_attempt_at: nowIso, updated_at: nowIso });

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

    // 4) Our menu, whole or not at all for auto matching.
    const ours = await readMatchInputs(sb, locationId, { skipLinks: true });

    // 5) Plan and write.
    const entities = syncEntities(flat);
    const plan = planMenuSync({
      entities, links: links.rows, ourItems: ours.ourItems, ourGroups: ours.ourGroups,
      menuOk: ours.menuOk, complete, locationId, nowIso,
    });
    const applied = await applyMenuSync(sb, locationId, plan, (...a) => log('[menu sync]', ...a));

    const status = applied.failed ? 'partial' : (complete ? 'ok' : 'partial');
    await writeSyncState(sb, {
      location_id: locationId, status, reason, last_attempt_at: nowIso, last_synced_at: nowIso,
      counts: { ...plan.counts, menuOk: ours.menuOk, complete, failedWrites: applied.failed },
      menus: menuNames, error: errors.length ? errors.join('; ').slice(0, 1000) : null, updated_at: nowIso,
    });
    log('synced', locationId, menuNames.join(', '), JSON.stringify(plan.counts));
    return {
      ok: true, enabled: true, complete, menuOk: ours.menuOk, menus: menuNames, counts: plan.counts,
      failedWrites: applied.failed, errors, syncedAt: nowIso,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await writeSyncState(sb, { location_id: locationId, status: 'error', reason, last_attempt_at: nowIso, error: msg.slice(0, 1000), updated_at: nowIso });
    return { ok: false, enabled: true, error: `The menu sync failed: ${msg}`, errors };
  }
}

/**
 * An order carried published ids no synced row holds: ezCater republished. Re-sync, at most once
 * per UNSEEN_RESYNC_MIN_MS per venue. Called AFTER the order is written. Never throws.
 */
export async function resyncForUnseen(sb: any, platform: any, locationId: string, unseen: string[], opts: {
  askFactory?: (conn: any) => EzAsk; nowMs?: number; log?: (...a: unknown[]) => void;
} = {}): Promise<SyncResult | { ok: false; enabled: true; skipped: string }> {
  if (!Array.isArray(unseen) || !unseen.length) return { ok: false, enabled: true, skipped: 'nothing unseen' };
  const nowMs = Number.isFinite(opts.nowMs as number) ? (opts.nowMs as number) : Date.now();
  const state = await readSyncState(sb, locationId);
  const last = Date.parse(t(state?.last_attempt_at));
  if (Number.isFinite(last) && nowMs - last < UNSEEN_RESYNC_MIN_MS) return { ok: false, enabled: true, skipped: 'synced recently' };
  return syncVenueMenus(sb, platform, locationId, { ...opts, nowMs, reason: 'republish' });
}

/** True when a venue is due its daily sync. PURE. */
export function syncDue(state: any, nowMs: number): boolean {
  if (!state) return true;
  const synced = Date.parse(t(state.last_synced_at));
  const tried = Date.parse(t(state.last_attempt_at));
  if (Number.isFinite(tried) && nowMs - tried < 60 * 60 * 1000 && !(Number.isFinite(synced) && synced >= tried)) {
    return false;   // a failed attempt in the last hour: wait before trying again
  }
  return !Number.isFinite(synced) || nowMs - synced >= MENU_SYNC_EVERY_MS;
}

/**
 * The daily re-sync: every venue with a mapped caterer whose last sync is a day old. Runs from
 * pg_cron (hourly) through ezcater-connect 'menu_sync_due'. Never throws.
 */
export async function syncDueVenues(sb: any, platform: any, opts: {
  askFactory?: (conn: any) => EzAsk; nowMs?: number; maxVenues?: number; log?: (...a: unknown[]) => void;
} = {}): Promise<Array<{ locationId: string; ok: boolean; error?: string }>> {
  const nowMs = Number.isFinite(opts.nowMs as number) ? (opts.nowMs as number) : Date.now();
  const out: Array<{ locationId: string; ok: boolean; error?: string }> = [];
  try {
    const { data } = await sb.from('ezcater_caterers').select('location_id, active').not('location_id', 'is', null).limit(1000);
    const venues = [...new Set((data || []).filter((c: any) => c && c.active !== false && t(c.location_id)).map((c: any) => t(c.location_id)))];
    for (const locationId of venues) {
      if (out.length >= (opts.maxVenues || 10)) break;
      const state = await readSyncState(sb, locationId);
      if (!syncDue(state, nowMs)) continue;
      const r = await syncVenueMenus(sb, platform, locationId, { ...opts, nowMs, reason: 'daily' });
      out.push({ locationId, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
    }
  } catch (e) {
    (opts.log || (() => {}))('daily sync failed:', e instanceof Error ? e.message : String(e));
  }
  return out;
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
