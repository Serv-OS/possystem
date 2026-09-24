/**
 * db.js — Supabase data layer
 *
 * Each function wraps a Supabase query and returns { data, error }.
 * Called by store actions and React components.
 * When supabase is null (mock mode), returns { data: null, error }.
 *
 * All queries are scoped to a location_id for multi-tenancy.
 */

import { supabase, isMock, getLocationId, getActiveLocationSync, sendDeviceHeartbeat } from './supabase';
import { carryVerbatim, carryResendOnly, nameColumnsFor, remapPricingMenus, remapForPeer, propagatedFields, resendFields, isMasterRow, peerSuffixOf, RESEND_ONLY_FIELDS, fieldOf } from './shareCopy';
import { missingMasters, runBulkScope } from './bulkScope';
import { reportWriteRefused } from './deviceLink';
import { scheduleMenuTranslate } from './menuTranslateTrigger';
import { logActivity } from './activity';
import { VERSION } from './version';
import { getTodayStartFallback } from './locationTime';
import { isTrainingMode } from './trainingMode';
import { reportSave } from './saveHealth';
import { closedCheckRow } from './closedCheckRow';
import { describeMenuChange } from './menuDiff';
import { normaliseMenuRow } from './rowMapping';
import { money } from './currency';
import { categoryImageField, categoryPhotoUrl, checkPhotoFile, categoryPhotoPath, peerPhotoTargets, isMissingImageColumn } from './categoryPhoto';
import { itemCodeForSave, isMissingItemCodeColumn, isDuplicateItemCodeError } from './itemCode';
import { peerMenuPlan } from './menuMembership';
import { resolveSoldAlone } from './menuRules';
import { saveTableChecked, openOrdersFor, readFloorPlan } from './tablePlanDb';
import { saveSectionsChecked } from './sectionPlan';
import { mustChangeRow } from './rowWrites';
import { patchPendingCheck } from '../sync/DataSafe';

// ── Order number generation ──────────────────────────────────────────────────
// The order number is the order's IDENTITY: unique per location and unlimited.
// R1, R2, ... R1247 — it never wraps. The two-digit form staff call across a
// collection counter ("order 47") is a DISPLAY convenience only — see
// shortOrderRef below. Never store or match on the short form.
//
// Primary path: server-side SQL function next_order_number(p_location_id) — atomic
// via INSERT ON CONFLICT on the location_order_counters row. Returns 'R<n>'.
//
// Fallback path: a per-device counter persisted to localStorage, used only when
// the RPC is unreachable. It is monotonic, but it is NOT coordinated between
// devices: two tills minting while offline at the same location can still land
// on the same number, and the queue key is (location_id, ref), so the second
// order would upsert over the first. That cannot be fixed on the client, so
// every use is logged loudly rather than disguised.
let _localCounterMemo = null;
function _readLocalCounter() {
  if (_localCounterMemo != null) return _localCounterMemo;
  try {
    const v = parseInt(localStorage.getItem('rpos-order-counter-fallback') || '0', 10);
    _localCounterMemo = isNaN(v) ? 0 : v;
  } catch (e) { _localCounterMemo = 0; void e; }
  return _localCounterMemo;
}
function _bumpLocalCounter() {
  const cur = _readLocalCounter();
  // Monotonic. The old `(cur % 99) + 1` wrap is what made the number a reused
  // label instead of an identity — 185 closed checks share 99 refs because of it.
  const next = cur + 1;
  _localCounterMemo = next;
  try { localStorage.setItem('rpos-order-counter-fallback', String(next)); } catch (e) { void e; }
  console.error('[getNextOrderRef] MINTED LOCALLY (R' + next + ') — this number is unique to THIS device only. Another device at the same location can mint it too, and the second order would overwrite the first. Fix the next_order_number RPC / connectivity.');
  return next;
}

export const getNextOrderRef = async (locationId = null) => {
  if (!locationId || locationId === 'loc-demo') {
    try { locationId = await getLocationId(); } catch (e) { void e; }
  }
  // Primary path — server function. Atomic across all devices at the location.
  if (!isMock && supabase && locationId && locationId !== 'loc-demo') {
    try {
      const { data, error } = await supabase.rpc('next_order_number', {
        p_location_id: locationId,
      });
      if (!error && typeof data === 'string' && data.startsWith('R')) {
        return data;
      }
      if (error) {
        console.warn('[getNextOrderRef] RPC next_order_number failed:', error.message, '— using local fallback.');
      }
    } catch (e) {
      console.warn('[getNextOrderRef] RPC threw:', e?.message, '— using local fallback');
    }
  }
  // Fallback path — see the section header. Last resort only; _bumpLocalCounter logs.
  return 'R' + _bumpLocalCounter();
};

// Synchronous variant for callers that can't go async without major refactoring
// (recordClosedCheck, recordWalkInClosed, recordWalkInClosedCheck — called from
// React handlers that read store state immediately after, so awaiting inside them
// breaks the read-after-write timing). No DB call, so it ALWAYS takes the local
// fallback and always logs — every caller of this is a device-local number.
// Moving these callers to async getNextOrderRef is the real fix and is out of
// scope here.
// ── The lease ────────────────────────────────────────────────────────────────
// The synchronous callers (recordClosedCheck, walk-ins, MPOS, bar tabs) cannot await
// mid-handler — they read store state immediately after and an await breaks that
// read-after-write ordering. But minting locally is what let two tills at one venue
// land on the same number.
//
// So the device LEASES a contiguous block from the server up front and hands numbers
// out synchronously from it. One round trip per block instead of per order, and no two
// devices can ever be inside the same block — reserve_order_numbers bumps the shared
// counter by the block size under the same row lock next_order_number uses.
//
// The block is deliberately NOT persisted. A reload abandons whatever is left of it,
// which costs a few unused numbers and guarantees a device can never replay a block it
// already spent. Gaps in the sequence are free; collisions are not.
const LEASE_SIZE = 25;
const LEASE_REFILL_AT = 5;      // top up before it runs dry, so a busy service never stalls
let _leased = [];               // numbers still available to hand out
let _leaseInFlight = false;

async function _refillLease(locationId = null) {
  if (_leaseInFlight || isMock || !supabase) return;
  _leaseInFlight = true;
  try {
    if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
    if (!locationId || locationId === 'loc-demo') return;
    const { data, error } = await supabase.rpc('reserve_order_numbers', {
      p_location_id: locationId, p_count: LEASE_SIZE,
    });
    if (error || typeof data !== 'number') {
      console.warn('[orderRef] lease failed:', error?.message || 'unexpected reply', '— falling back to the local counter until it recovers.');
      return;
    }
    for (let i = 0; i < LEASE_SIZE; i++) _leased.push(data + i);
  } catch (e) {
    console.warn('[orderRef] lease threw:', e?.message || e);
  } finally {
    _leaseInFlight = false;
  }
}

/** Warm the first block at boot so the very first sale of the day is server-numbered. */
export function primeOrderRefLease(locationId = null) {
  return _refillLease(locationId);
}

export function getNextOrderRefLocal() {
  // Top up in the background before the block runs out. Not awaited: the whole point
  // of the lease is that this function stays synchronous.
  if (_leased.length <= LEASE_REFILL_AT) { void _refillLease(); }
  if (_leased.length) return 'R' + _leased.shift();
  // Nothing leased — genuinely offline, or the RPC is unreachable. _bumpLocalCounter
  // logs loudly; see the note above it for why this number is only unique to this device.
  return 'R' + _bumpLocalCounter();
}

/**
 * Display-only short form of an order ref: the last two digits of the numeric
 * part. 'R1247' → '47', 'R7' → '7'. This is the number staff call across a
 * collection counter; it is NOT an identity and must never be written or matched.
 *
 * Channel refs (HR-/OL-/CA-/TAB-…) and anything else unparseable come back
 * UNCHANGED — a wrong-but-long number is recoverable, a blank one at the counter
 * is not, so this never returns an empty string.
 */
export function shortOrderRef(ref) {
  if (typeof ref !== 'string') return ref;
  const m = /^R(\d+)$/.exec(ref);
  if (!m) return ref;
  return m[1].length > 2 ? m[1].slice(-2) : m[1];
}

// ── Menu ──────────────────────────────────────────────────────────────────────
export const fetchMenus = async (locationId = null) => {
  if (isMock) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No location') };
  return supabase.from('menus').select('*').eq('location_id', locationId).order('sort_order');
};

export const fetchMenuCategories = async (locationId = null) => {
  if (isMock) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No location') };
  // v5.5.950: deterministic tie-break. sort_order ties (legacy rows created with a
  // GLOBAL counter, or two siblings renumbered to 0 on different levels) let Postgres
  // return them in ANY order per query — the category tree visibly shuffled between
  // loads ("each time I upload the order moves around").
  return supabase.from('menu_categories').select('*').eq('location_id', locationId).order('sort_order').order('label').order('id');
};

// ── Menus ─────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS (21 Sep 2026, live): Push to POS wrote items and categories
// and NOT the menus they belong to. menu_categories.menu_id references
// menus(id), so at a venue whose menus row was never in the database EVERY
// category upsert died on
//   23503 ... violates foreign key constraint "menu_categories_menu_id_fkey"
// Huddersfield lost all four of its categories that way, from April until
// today: the tills were fine (they run from the push snapshot, which carries
// the categories) while the database had none, so menu boards, online ordering
// and the kiosk had nothing to show and nobody could see why.
//
// KEEP IN SYNC with _sbUpsertMenuNow in store/index.js (the CLAUDE.md
// two-paths gotcha): this is the PUSH's writer, that one is the editor's.
export const upsertMenu = async (menu, locationId = null) => {
  if (isMock) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No location') };
  const m = normaliseMenuRow(menu);
  if (!m?.id) return { data: null, error: null };
  const result = await supabase.from('menus').upsert({
    id: m.id,
    location_id: locationId,
    name: m.name || 'Menu',
    description: m.description || '',
    is_default: m.isDefault || false,
    is_active: m.isActive !== false,
    sort_order: m.sortOrder || 0,
    schedule: m.schedule ?? null,
    priority: m.priority ?? 0,
    scope: m.scope || 'local',
    org_id: m.orgId ?? m.org_id ?? null,
    updated_at: new Date().toISOString(),
  });
  reportSave('menu', result.error);
  return result;
};

/** Adyen-style self heal: is this the menu_id foreign key, and nothing else? */
const isMissingMenuRow = (error) =>
  String(error?.code || '') === '23503' && /menu_id|menu_categories_menu_id_fkey/i.test(String(error?.message || ''));

export const upsertMenuCategory = async (cat, locationId = null) => {
  if (isMock) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No location') };
  // v5.5.316: build a CLEAN snake_case row. Previously this spread `...cat`
  // (the camelCase store shape) alongside snake_case keys, so the payload
  // carried unknown columns (menuId, parentId, sortOrder, defaultCourse,
  // spacerSlots, accountingGroup, isSpecial) and PostgREST rejected the whole
  // upsert (PGRST204) — silently, since the only caller .catch()es it. The push
  // therefore never wrote categories to menu_categories, so kiosk/online (which
  // query that table directly) saw stale categories. Mirror sbUpsertCategory.
  const row = {
    id: cat.id,
    location_id: locationId,
    menu_id: cat.menuId ?? cat.menu_id ?? null,
    parent_id: cat.parentId ?? cat.parent_id ?? null,
    label: cat.label ?? cat.name ?? 'Category',
    icon: cat.icon ?? '🍽',
    color: cat.color ?? '#3b82f6',
    accounting_group: cat.accountingGroup ?? cat.accounting_group ?? '',
    sort_order: cat.sortOrder ?? cat.sort_order ?? 0,
    default_course: cat.defaultCourse ?? cat.default_course ?? 1,
    spacer_slots: cat.spacerSlots ?? cat.spacer_slots ?? [],
    is_special: cat.isSpecial ?? cat.is_special ?? false,
    // v5.7.33: tax profile assignment — CONDITIONAL (touched-fields discipline):
    // only written when the row carries the field, so a caller holding a
    // pre-profile row can never null a saved assignment. Mirror of
    // _sbUpsertCategoryNow in store/index.js — the CLAUDE.md two-paths gotcha.
    ...(cat.taxProfileId !== undefined || cat.tax_profile_id !== undefined
      ? { tax_profile_id: cat.taxProfileId ?? cat.tax_profile_id ?? null } : {}),
    // v5.8.65: category photo, ONLY when a real category photo URL is present, so a
    // Push from a stale tab can never wipe it. Mirror of _sbUpsertCategoryNow.
    ...categoryImageField(cat),
    updated_at: new Date().toISOString(),
  };
  let result = await supabase.from('menu_categories').upsert(row);
  // v5.8.65: the image column is missing (migration rolled back while this tab still
  // holds photo URLs): save the category without the photo instead of losing the edit.
  if (result.error && row.image && isMissingImageColumn(result.error)) {
    delete row.image;
    result = await supabase.from('menu_categories').upsert(row);
  }
  // v5.9.22: the menu this category names is not in the database, so the
  // foreign key refuses the whole row. Keep the CATEGORY rather than lose it
  // over the link: a category with no menu still shows on every surface, and a
  // lost one shows on none. Loud, because it means the menus row needs saving.
  if (result.error && row.menu_id && isMissingMenuRow(result.error)) {
    console.warn('[DB] category', row.id, 'names a menu that is not saved (', row.menu_id, ') — saving it without the menu link');
    result = await supabase.from('menu_categories').upsert({ ...row, menu_id: null });
  }
  reportSave('category', result.error);   // v5.5.951 — loud, not console-only
  if (!result.error) scheduleMenuTranslate(locationId);   // kiosk translations follow the English (v5.8.82)
  return result;
};


export const fetchMenuItems = async (locationId = null) => {
  if (isMock) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No location') };
  return supabase
    .from('menu_items')
    .select('*')
    .eq('location_id', locationId)
    .eq('archived', false)
    .order('sort_order');
};

export const upsertMenuItem = async (item, locationId = null) => {
  if (isMock) return { data: null, error: null };
  // Always resolve real location — 'loc-demo' is the mock fallback, not a real location
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No location') };

  // Build pricing jsonb — preserve existing or derive from scalar price
  const pricing = item.pricing || { base: item.price || 0 };

  // RENAME CASCADE — when BO renames an item, it patches `menuName` (display).
  // The canonical `name` column previously held the original because `name`
  // here read item.name directly without falling through to menuName. Result:
  // menu_items.name went stale on every rename, breaking any report / query
  // that looks up by name. Now name + menu_name + receipt_name + kitchen_name
  // all cascade through the same chain so a rename updates them together.
  const _displayName = item.menuName || item.menu_name || item.name || 'Item';
  // v5.5.797: AUTO-MODIFIABLE SAFETY NET — a top-level product with modifier
  // groups attached must never be written as plain 'simple': the till
  // hard-skips the options screen for type='simple' (POSSurface needsModal),
  // so the attached groups would never show. Mirrors the store-side flip in
  // updateMenuItem/addMenuItem so both write paths agree.
  const _parentId = item.parentId !== undefined ? item.parentId : (item.parent_id !== undefined ? item.parent_id : null);
  const _assignedMods = item.assignedModifierGroups || item.assigned_modifier_groups || [];
  let _type = item.type || 'simple';
  if (_type === 'simple' && !_parentId && Array.isArray(_assignedMods) && _assignedMods.length > 0) _type = 'modifiable';
  const dbItem = {
    id:           item.id,
    location_id:  locationId,
    name:         _displayName,
    menu_name:    _displayName,
    receipt_name: item.receiptName || item.receipt_name || _displayName,
    kitchen_name: item.kitchenName || item.kitchen_name || _displayName,
    description:  item.description || '',
    type:         _type,
    cat:          item.cat         || null,
    cats:         item.cats        || [],
    parent_id:    _parentId,
    sort_order:   item.sortOrder   ?? item.sort_order   ?? 0,
    pricing,
    allergens:    item.allergens   || [],
    tags:         item.tags        || [],
    assigned_modifier_groups:    item.assignedModifierGroups    || item.assigned_modifier_groups    || [],
    assigned_instruction_groups: item.assignedInstructionGroups || item.assigned_instruction_groups || [],
    // v5.5.948: combined mod+instruction flow order (see lib/optionFlow.js). Only
    // written when the caller carries the field — an upsert from a path that never
    // loaded it must not null out a saved drag order.
    ...(item.optionGroupOrder !== undefined || item.option_group_order !== undefined
      ? { option_group_order: item.optionGroupOrder ?? item.option_group_order ?? null } : {}),
    visibility:   item.visibility  || { pos: true, kiosk: true, online: true },
    // A real choice is kept. When nobody chose: a sub item is NOT sold alone, every other type is
    // (lib/menuRules.js rule 6). This used to be "?? true", which switched Sold alone ON for
    // every new sub item on its next save. _type is passed so the rule sees the type we write.
    sold_alone:   resolveSoldAlone({ ...item, type: _type }),
    archived:     item.archived    ?? false,
    centre_id:    item.centreId    || item.centre_id    || null,
    tax_rate_id:  item.taxRateId   || item.tax_rate_id  || null,
    tax_overrides: item.taxOverrides || item.tax_overrides || {},
    // v5.7.33: tax profile override — CONDITIONAL (touched-fields discipline):
    // only written when the row carries the field. v5.7.33+ loaders stamp
    // taxProfileId on every item row, so normal saves round-trip the real DB
    // value; a caller holding a pre-profile row leaves the column alone.
    ...(item.taxProfileId !== undefined || item.tax_profile_id !== undefined
      ? { tax_profile_id: item.taxProfileId ?? item.tax_profile_id ?? null } : {}),
    // v5.8.100: the short code we give ezCater and other partners for this
    // product (menu_items.item_code, 20260917_OPS_menu_item_code.sql).
    // CONDITIONAL, the same touched-fields discipline as tax_profile_id: an
    // item loaded before the column existed carries no field, and a save from
    // that path must leave the column alone rather than null a venue's code.
    ...(item.itemCode !== undefined || item.item_code !== undefined
      ? { item_code: itemCodeForSave(item.itemCode ?? item.item_code) } : {}),
    image:        item.image || null,
    // v4.6.3: ownership / sharing fields (added by v4.6.0 schema migration)
    scope:           item.scope          || item.ownership_scope || 'local',
    org_id:          item.orgId          ?? item.org_id          ?? null,
    master_id:       item.masterId       ?? item.master_id       ?? null,
    lock_pricing:    item.lockPricing    ?? item.lock_pricing    ?? false,
    locked_fields:   item.lockedFields   ?? item.locked_fields   ?? [],
    updated_at:   new Date().toISOString(),
  };

  let result = await supabase.from('menu_items').upsert(dbItem, { onConflict: 'id' });

  // v5.8.100: NEVER LOSE A MENU SAVE OVER THE ITEM CODE. Two ways the code
  // alone can be refused, and both end the same way: write the item again
  // without it, so the name, price and everything else the person just typed is
  // saved. The code is the only thing lost, and the caller is told.
  //
  //   1. the column is not there yet (the migration is run by hand)
  //   2. another product at this venue already holds that code. The editor
  //      checks first, so this is the race, or a clash with an ARCHIVED product
  if (result.error && 'item_code' in dbItem
      && (isMissingItemCodeColumn(result.error) || isDuplicateItemCodeError(result.error))) {
    const duplicate = isDuplicateItemCodeError(result.error);
    const retry = { ...dbItem };
    delete retry.item_code;
    result = await supabase.from('menu_items').upsert(retry, { onConflict: 'id' });
    if (!result.error) result = { ...result, itemCodeRejected: duplicate ? 'duplicate' : 'missing-column' };
  }

  if (!result.error) scheduleMenuTranslate(locationId);   // kiosk translations follow the English (v5.8.82)
  reportSave('item', result.error);   // v5.5.951
  return result;
};

export const archiveMenuItem = async (id) => {
  if (isMock) return { data: null, error: null };
  // v5.5.279: location_id guard — never archive across tenants
  const locationId = getActiveLocationSync() || await getLocationId();
  return supabase.from('menu_items').update({ archived: true, updated_at: new Date().toISOString() }).eq('id', id).eq('location_id', locationId);
};

// v5.5.801: flip ONLY the archived flag. Never route an archive/restore through
// upsertMenuItem with a partial object — it builds a full row and defaults every
// missing field (name→'Item', pricing→{base:0}, cat/parent_id→null, mods→[]),
// wiping the item's real data.
export const setMenuItemArchived = async (id, archived) => {
  if (isMock) return { data: null, error: null };
  const locationId = getActiveLocationSync() || await getLocationId();
  return supabase.from('menu_items').update({ archived: !!archived, updated_at: new Date().toISOString() }).eq('id', id).eq('location_id', locationId);
};

// ── Modifier groups ───────────────────────────────────────────────────────────
// v5.5.834: modifier_groups was the ONLY table in the app written by raw fetch()
// instead of the authenticated Supabase client — and both writers sent the ANON
// KEY as the bearer token. 20260713f_rls_lock_modifier_group_writes.sql (13 Jul)
// gates every INSERT/UPDATE/DELETE on pos_can_access(location_id), which needs
// auth.uid(); the anon key produces no session, so auth.uid() is NULL and every
// write 403'd. SELECT survived (its policy is `true`), which is why groups looked
// saved and then "reverted" on refresh instead of erroring. Route both writes
// through the authenticated client like every other writer in this file.
export const upsertModifierGroup = async (group, locationId = null) => {
  if (isMock) return { data: null, error: null };
  // THE loc-demo TRAP: modifier_groups.location_id is `text NOT NULL default
  // 'loc-demo'`, so omitting it does NOT fail — the row silently lands on
  // 'loc-demo' and is invisible to every real venue. 'loc-demo' is also truthy,
  // so both checks below must test the literal as well as null/undefined/''.
  if (!locationId || locationId === 'loc-demo') locationId = getActiveLocationSync() || await getLocationId();
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No location') };
  // COLUMN NOTES (schema read from the live DB, 21 Jul 2026 — this table predates
  // the migrations folder so there is no CREATE TABLE in the repo to check):
  //   • There is NO `updated_at` column. Do not add one to this payload
  //     speculatively — PostgREST rejects the whole upsert with PGRST204.
  //   • The table carries BOTH `min`/`max` AND a legacy `min_select`/`max_select`
  //     pair. Only `min`/`max` are written here and only `min`/`max` are read by
  //     SyncBridge, which is the pre-existing behaviour — the `_select` pair is
  //     dead and is deliberately left untouched (tech debt, not a hotfix job).
  const row = {
    id:             group.id,
    location_id:    locationId,
    name:           group.name,
    min:            group.min ?? 0,
    max:            group.max ?? 1,
    selection_type: group.selectionType ?? group.selection_type ?? 'single',
    options:        group.options || [],
    sort_order:     group.sortOrder ?? group.sort_order ?? 0,
  };
  const result = await supabase.from('modifier_groups').upsert(row, { onConflict: 'id' });
  if (!result.error) scheduleMenuTranslate(locationId);   // kiosk translations follow the English (v5.8.82)
  reportSave('modifier group', result.error);   // v5.5.951
  return result;
};

export const deleteModifierGroup = async (id, locationId = null) => {
  if (isMock) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = getActiveLocationSync() || await getLocationId();
  // v5.5.834: refuse an unscoped delete. The old raw fetch filtered on id ALONE
  // (`?id=eq.<id>`) — a cross-tenant hazard the moment two venues share a group id.
  // Same loc-demo trap as the upsert: the literal must be rejected, not just null.
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No location') };
  const result = await supabase.from('modifier_groups').delete().eq('id', id).eq('location_id', locationId);
  if (result.error) console.error('[DB] modifier_groups delete failed:', result.error.message, 'group:', id);
  return result;
};

// ── Floor plan ────────────────────────────────────────────────────────────────
export const fetchFloorPlan = async (locationId = null) => {
  if (isMock) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No location') };
  const [tables, sections] = await Promise.all([
    supabase.from('floor_tables').select('*').eq('location_id', locationId).order('sort_order'),
    supabase.from('sections').select('*').eq('location_id', locationId).order('sort_order'),
  ]);
  return { data: { tables: tables.data, sections: sections.data }, error: tables.error || sections.error };
};

export const upsertFloorTable = async (table, locationId = null) => {
  if (isMock) return { data: null, error: null };
  // v5.9.4: a blind upsert can put back a deleted table or an old name. Back Office writes go
  // through saveFloorTableChecked (compare-and-set); this refuses a retired table outright.
  if (table?.planRemoved || table?.parentId) return { data: null, error: new Error('Refusing to write a table that is not on the plan') };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No location') };
  // v5.5.2: cross-location guard. Floor_tables PK is `id` alone, so an upsert with the same
  // id silently rewrites location_id — moving a row from Loc A to Loc B. This caused real data
  // corruption when the BO read tables for one location but its getLocationId() resolved to a
  // different location (see BackOfficeApp v5.5.2 fix). Belt + suspenders: a table object that
  // was hydrated from DB carries its source location_id (stamped in useSupabaseInit /
  // SyncBridge / applyConfigUpdate as table.locationId). If we're about to upsert that same id
  // to a DIFFERENT location, refuse. Pure in-memory check — runs on every drag mousemove
  // without hitting the DB.
  if (table.locationId && table.locationId !== locationId) {
    const msg = `[DB] floor_tables: refusing to move table ${table.id} from ${table.locationId} to ${locationId} — would corrupt the source location's plan. The BO is reading and writing different locations; check that BackOfficeApp respects the rpos-bo-location override.`;
    console.error(msg);
    return { data: null, error: new Error(msg) };
  }
  // v4.6.5 Bug 6: floor_tables columns are (id, location_id, label, x, y, w, h, shape,
  // max_covers, section, sort_order). Client state carries camelCase (maxCovers) plus
  // runtime-only fields (status, session, firedCourses, sentAt, reservation). PostgREST
  // rejects unknown columns, so every add/update was silently failing and the floor plan
  // never persisted (B8 was a pre-existing row). Pick only real columns and rename.
  const row = {
    id: table.id,
    location_id: locationId,
    label: table.label,
    x: table.x ?? 0,
    y: table.y ?? 0,
    w: table.w ?? 80,
    h: table.h ?? 80,
    shape: table.shape ?? 'rect',
    max_covers: table.max_covers ?? table.maxCovers ?? 4,
    section: table.section ?? null,
    sort_order: table.sort_order ?? table.sortOrder ?? 0,
  };
  const result = await supabase.from('floor_tables').upsert(row, { onConflict: 'id' });
  if (result.error) console.error('[DB] floor_tables upsert failed:', result.error.message, 'table:', table.id, 'location:', locationId);
  return result;
};

export const deleteFloorTable = async (id, locationId = null) => {
  if (isMock) return { data: null, error: null };
  // v5.5.2: scope deletes to the current location. Without this, a stray click on a leaked
  // cross-location table in the BO canvas could delete the row from the OTHER location's
  // floor plan. The cross-location render filter in FloorPlanBuilder should prevent this
  // from being reachable, but defense in depth.
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  let q = supabase.from('floor_tables').delete().eq('id', id);
  if (locationId && locationId !== 'loc-demo') q = q.eq('location_id', locationId);
  return q;
};

// ── Table plan (a delete is an explicit marker, edits are compare-and-set, see lib/tablePlan.js) ──
// floor_table_tombstones: 20260918_OPS_floor_table_tombstones.sql. floor_tables.updated_at, the
// server-set deleted_at and floor_plan_read(): 20260918b_OPS_floor_tables_server_time.sql. Until
// Peter runs them every helper here falls back (missing table, column or function reads as
// "not there yet") and the app keeps working on the machine's observation order instead.
const TOMBSTONE_ABSENT = ['42P01', 'PGRST205', 'PGRST202', 'PGRST204'];
const isAbsentTable = (err) => !!err && (TOMBSTONE_ABSENT.includes(err.code)
  || (/floor_table_tombstones/.test(String(err.message || '')) && /does not exist|schema cache/i.test(String(err.message || ''))));

const resolveLoc = async (locationId) => {
  if (!locationId || locationId === 'loc-demo') {
    try { locationId = getActiveLocationSync() || await getLocationId(); } catch { locationId = null; }
  }
  return (!locationId || locationId === 'loc-demo') ? null : locationId;
};

/**
 * The floor plan WITH its version: { tables, sections, srvReadAt }. srvReadAt is the highest
 * updated_at the read saw (floor_plan_read), 0 before migration 20260918b (plain select). It is
 * for diagnosis only: no table is ever removed or blocked by a server time (tablePlan.admits).
 * `tables` is null when the read failed: absence in a failed read never removes a table.
 * A missing floor_plan_read is retried after a while (tablePlanDb.readFloorPlan), never latched
 * for the life of the page.
 */
export const fetchFloorPlanVersioned = async (locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await resolveLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No location') };
  const sectionsP = Promise.resolve(supabase.from('sections').select('*').eq('location_id', locationId).order('sort_order'))
    .catch(e => ({ data: null, error: e }));
  const { tables, srvReadAt, error } = await readFloorPlan(supabase, locationId);
  const s = await sectionsP;
  return { data: { tables, sections: s.data || null, srvReadAt }, error: error || s.error || null };
};

export const fetchTableTombstones = async (locationId) => {
  if (isMock || !supabase || !locationId || locationId === 'loc-demo') return { data: null, error: null };
  // Newest first, capped. No date filter: that would compare with this device's clock.
  const res = await supabase.from('floor_table_tombstones')
    .select('table_id, deleted_at, label').eq('location_id', locationId)
    .order('deleted_at', { ascending: false }).limit(2000);
  if (res.error) return { data: null, error: res.error, missing: isAbsentTable(res.error) };
  return { data: res.data || [], error: null };
};

// Record a delete. deleted_at is NOT sent: the database sets it (the 20260918 trigger, on insert
// AND on the upsert of a repeat delete), and the value it chose is read back for this machine.
export const insertTableTombstone = async (locationId, tableId, label = null) => {
  if (isMock || !supabase || !locationId || locationId === 'loc-demo' || !tableId) return { error: null, row: null };
  const res = await supabase.from('floor_table_tombstones').upsert(
    { location_id: locationId, table_id: tableId, label },
    { onConflict: 'location_id,table_id' }).select('table_id, deleted_at');
  if (res.error && !isAbsentTable(res.error)) console.warn('[DB] floor_table_tombstones write failed:', res.error.message);
  return { error: res.error || null, missing: isAbsentTable(res.error), row: res.data?.[0] || null };
};

// Back Office compare-and-set write of one table (never a blind upsert). The rules and the
// queries live in lib/tablePlanDb.js (tested against an in-memory PostgREST double).
export const saveFloorTableChecked = async (table, locationId = null) => {
  if (isMock) return { ok: true, row: null };
  if (!supabase) return { ok: false, error: new Error('No database') };
  const loc = await resolveLoc(table?.locationId || locationId);
  return saveTableChecked(supabase, table, loc);
};

// Floor plan SECTIONS: the venue's whole list, checked (lib/sectionPlan.js saveSectionsChecked).
// Before migration 20260918c the write fails with reason 'migration' and nothing is pretended.
export const saveLocationSections = async (list, locationId, { base } = {}) => {
  if (isMock) return { ok: true, sections: list };
  if (!supabase) return { ok: false, reason: 'error', error: new Error('No database') };
  const loc = await resolveLoc(locationId);
  return saveSectionsChecked(supabase, loc, list, { base });
};

// Everything the Back Office delete guard must see (lib/tablePlanDb.js openOrdersFor).
export const fetchTableOpenOrders = async (locationId, tableId) => {
  if (isMock) return { dbRows: [], qrRows: [], failed: [] };
  return openOrdersFor(supabase, locationId, tableId);
};

// ── 86 list ───────────────────────────────────────────────────────────────────
export const fetch86List = async (locationId = null) => {
  if (isMock) return { data: null, error: null };
  // v5.5.143: same resolve-or-fail as toggle86DB. Without this a null
  // caller-arg returns 'loc-demo' rows (never matched the writes anyway).
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return { data: [], error: null };
  return supabase.from('eighty_six').select('item_id').eq('location_id', locationId);
};

export const toggle86DB = async (itemId, is86, locationId = null) => {
  if (isMock) return { data: null, error: null };
  // TRAINING MODE: never write a real 86 mark (would hide a live item for everyone).
  if (isTrainingMode()) return { data: null, error: null };
  // v5.5.143: ALWAYS resolve real locationId before writing. The schema has
  // `location_id text not null default 'loc-demo'`, so a null caller-arg
  // silently writes 'loc-demo' — fetch86List then filters by the real
  // location and finds nothing → "I 86'd it, refreshed, the 86 is gone".
  // This was the recurring data-loss bug.
  if (!locationId || locationId === 'loc-demo') {
    locationId = await getLocationId().catch(() => null);
  }
  if (!locationId || locationId === 'loc-demo') {
    try { locationId = JSON.parse(localStorage.getItem('rpos-device') || '{}').locationId || null; } catch {}
  }
  if (!locationId) {
    console.error('[toggle86DB] could not resolve locationId — write SKIPPED to avoid loc-demo bleed');
    return { data: null, error: new Error('No locationId') };
  }
  if (is86) {
    return supabase.from('eighty_six').delete().eq('location_id', locationId).eq('item_id', itemId);
  }
  return supabase.from('eighty_six').insert({ location_id: locationId, item_id: itemId });
};

// ── KDS ───────────────────────────────────────────────────────────────────────
export const fetchKDSTickets = async (locationId = null) => {
  if (isMock) return { data: null, error: null };
  // v5.5.186: self-resolve locationId — same pattern as fetchMenuItems etc.
  // Previously a null caller-arg passed null to .eq('location_id', null)
  // which returned 0 rows, so KDS tickets never loaded on boot.
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return { data: null, error: null };
  return supabase
    .from('kds_tickets')
    .select('*')
    .eq('location_id', locationId)
    .eq('status', 'pending')
    .order('sent_at', { ascending: true });
};

// v5.8.66: does kds_tickets.meta exist? null = not known yet, true = a write with it
// worked, false = PostgREST said the column is missing (migration not run). A false is
// re-tested after 10 minutes so a till that stays open picks the column up once Peter
// has run the migration, without a reload.
let _kdsMetaColumn = null;
let _kdsMetaMissingAt = 0;
const _isMissingMetaColumn = (error) => {
  const msg = `${error?.code || ''} ${error?.message || ''}`;
  const missing = /PGRST204|42703/.test(msg) && msg.includes('meta');
  if (missing) _kdsMetaMissingAt = Date.now();
  return missing;
};

export const insertKDSTicket = async (ticket, locationId = null) => {
  if (_kdsMetaColumn === false && Date.now() - _kdsMetaMissingAt > 10 * 60 * 1000) _kdsMetaColumn = null;
  if (isMock) return { data: null, error: null };
  // TRAINING MODE: don't fire a real kitchen ticket to the KDS / DB.
  if (isTrainingMode()) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No location') };
  // Map camelCase store ticket to snake_case DB columns
  const row = {
    id: ticket.id,
    location_id: locationId,
    table_label: ticket.table || ticket.tableLabel || '',
    table_id: ticket.tableId || null,
    server: ticket.server || null,
    covers: ticket.covers || 1,
    centre_id: ticket.centreId || null,
    items: ticket.items || [],
    status: 'pending',
    fired_courses: ticket.firedCourses || [0, 1],
    all_courses: ticket.allCourses || [],
    sent_at: ticket.sentAt ? new Date(ticket.sentAt).toISOString() : new Date().toISOString(),
  };
  // v5.8.66: order type, name, number and till name for the redesigned KDS.
  const withMeta = ticket.meta && _kdsMetaColumn !== false ? { ...row, meta: ticket.meta } : row;

  // v4.3 — durable send: if the network/Supabase fails, queue the write to
  // IndexedDB so it replays when the device comes back online. No lost tickets.
  const handleFailure = async (err) => {
    reportWriteRefused(err);   // fence stage 1: a refused kitchen ticket may mean a lost link (banner); it is queued below
    try {
      const { queueWrite } = await import('../sync/OfflineQueue');
      // v5.8.66: the queued copy carries meta ONLY once this session has seen the column
      // accept a write. The queue gives up after 5 failed replays, so a payload the
      // database cannot take (meta before the migration) would be a lost kitchen ticket.
      // Without meta the KDS still reads the row from table_label.
      await queueWrite({ type: 'upsert', table: 'kds_tickets', payload: _kdsMetaColumn === true ? withMeta : row, onConflict: 'id' });
      console.warn('[KDS] Send failed, queued for retry:', err?.message || err);
    } catch (qe) {
      console.error('[KDS] CRITICAL: send failed AND queueing failed:', qe?.message || qe);
    }
  };

  try {
    let res = await supabase.from('kds_tickets').insert(withMeta);
    if (withMeta !== row) {
      if (res?.error && _isMissingMetaColumn(res.error)) {
        _kdsMetaColumn = false;                       // migration not run yet: retry plain
        res = await supabase.from('kds_tickets').insert(row);
      } else if (!res?.error) {
        _kdsMetaColumn = true;
      }
    }
    if (res?.error) await handleFailure(res.error);
    return res;
  } catch (err) {
    await handleFailure(err);
    return { data: null, error: err };
  }
};

export const bumpKDSTicket = async (id) => {
  if (isMock) return { data: null, error: null };
  // v5.5.279: location_id guard on KDS ticket bump
  const locationId = getActiveLocationSync() || await getLocationId();
  // Fix round 2 (the zero row blocker): a bump that changes no row while this device is not
  // linked is kept and sent once it is linked again, never counted as done.
  const r = await mustChangeRow({
    table: 'kds_tickets', type: 'update', payload: { status: 'bumped', bumped_at: new Date().toISOString() },
    match: { id, location_id: locationId }, kind: 'kds_bump', label: 'Kitchen ticket bumped',
  });
  return { data: r.data || null, error: r.outcome === 'error' ? r.error : null, outcome: r.outcome };
};

// v4.6.20 — historical fetch for the KDS performance report. Returns both
// pending and bumped tickets so we can compute bump time (bumped_at - sent_at).
export const fetchKDSTicketsRange = async (locationId = null, fromDate, toDate, limit = 2000) => {
  if (isMock) return { data: null, error: null };
  let query = supabase
    .from('kds_tickets')
    .select('*')
    .eq('location_id', locationId)
    .order('sent_at', { ascending: false })
    .limit(limit);
  if (fromDate) query = query.gte('sent_at', fromDate.toISOString());
  if (toDate)   query = query.lte('sent_at', toDate.toISOString());
  const result = await query;
  if (result.data) {
    result.data = result.data.map(t => ({
      id: t.id,
      tableLabel: t.table_label,
      tableId: t.table_id,
      server: t.server,
      covers: t.covers,
      centreId: t.centre_id,
      items: t.items || [],
      status: t.status,
      firedCourses: t.fired_courses || [],
      sentAt:   t.sent_at   ? new Date(t.sent_at).getTime()   : null,
      bumpedAt: t.bumped_at ? new Date(t.bumped_at).getTime() : null,
    }));
  }
  return result;
};

// ── Closed checks ─────────────────────────────────────────────────────────────
export const insertClosedCheck = async (check, locationId = null) => {
  if (isMock) return { data: null, error: null };
  // TRAINING MODE: never persist a closed check. The store keeps it in-memory so
  // the receipt / "paid" UI still works; nothing reaches localStorage, the offline
  // queue, or Supabase. Single choke point for POS/MPOS/bar/walk-in closes.
  if (isTrainingMode()) return { data: null, error: null };
  // Always resolve real location — NEVER fall back to LOCATION_ID ('loc-demo')
  if (!locationId || locationId === 'loc-demo') {
    locationId = await getLocationId().catch(() => null);
  }
  if (!locationId || locationId === 'loc-demo') {
    // Last resort: read from paired device in localStorage
    try {
      const dev = JSON.parse(localStorage.getItem('rpos-device') || '{}');
      locationId = dev.locationId || null;
    } catch {}
  }
  if (!locationId) {
    console.error('[DB] insertClosedCheck: could not resolve locationId — check will be lost');
    return { data: null, error: new Error('No locationId') };
  }

  const row = closedCheckRow(check, locationId);

  // Use DataSafe triple-write: localStorage → Supabase (queued if offline)
  const { safeInsertClosedCheck } = await import('../sync/DataSafe.js');
  return safeInsertClosedCheck(check, row);
};

// Idempotent closed_check write for the terminal-job reconciler. Same training gate
// and locationId resolution as insertClosedCheck, but goes through the ON CONFLICT DO
// NOTHING upsert and RETURNS its { ok, queued, created } — `created` is the
// single-closer election result (see DataSafe.safeUpsertClosedCheck).
export const upsertClosedCheck = async (check, locationId = null) => {
  if (isMock) return { ok: false, queued: false, created: false };
  if (isTrainingMode()) return { ok: false, queued: false, created: false };
  if (!locationId || locationId === 'loc-demo') {
    locationId = await getLocationId().catch(() => null);
  }
  if (!locationId || locationId === 'loc-demo') {
    try {
      const dev = JSON.parse(localStorage.getItem('rpos-device') || '{}');
      locationId = dev.locationId || null;
    } catch {}
  }
  if (!locationId) {
    console.error('[DB] upsertClosedCheck: could not resolve locationId — check will be lost');
    return { ok: false, queued: false, created: false };
  }
  const row = closedCheckRow(check, locationId);
  const { safeUpsertClosedCheck } = await import('../sync/DataSafe.js');
  return safeUpsertClosedCheck(check, row);
};

/**
 * Persist a refund to closed_checks.refunds[] + status. Used by store.refundCheck
 * so refunds applied on one device propagate to every other device at the
 * location via the realtime UPDATE listener in lib/realtime.js.
 *
 * Returns { ok, error? }. Failures are logged but never thrown — the local
 * mutation has already happened so the UI stays responsive even if Supabase
 * is unreachable; the next refund / boot will re-sync.
 */
export const updateClosedCheckRefunds = async (checkId, refunds, status) => {
  if (isMock || !checkId) return { ok: false };
  try {
    // v5.5.279: location_id guard on refund updates
    const locationId = getActiveLocationSync() || await getLocationId();
    const patch = { refunds: refunds || [], status: status || 'paid' };
    // Fix round 2: a sale this till has not sent yet (DataSafe keeps it, for example while the
    // till is not linked) carries the refund too, so whichever lands first, the other agrees.
    try { patchPendingCheck(checkId, patch); } catch { /* the kept sale is best effort */ }
    // Fix round 2 (the zero row blocker): an update that changes no row while this till is not
    // linked (a refund on a "pair again" till) is kept and sent once it is linked again, in order
    // (the pending entry, then its outcome). It is never counted as done.
    const r = await mustChangeRow({
      table: 'closed_checks', type: 'update', payload: patch,
      match: { id: checkId, location_id: locationId }, kind: 'refund', label: `Refund on check ${checkId}`,
    });
    if (r.outcome === 'error') {
      console.warn('[DB] updateClosedCheckRefunds failed:', r.error?.message || r.error);
      return { ok: false, error: r.error };
    }
    if (r.outcome === 'parked' || r.outcome === 'queued') {
      console.warn('[DB] updateClosedCheckRefunds: kept on this till until it is linked again', checkId);
      return { ok: true, kept: true };
    }
    return { ok: true };
  } catch (e) {
    console.warn('[DB] updateClosedCheckRefunds error:', e?.message);
    return { ok: false, error: e };
  }
};

// How far back a till loads sales history at boot. The POS history panel offers
// Today / Week / 30 days, so the boot load has to cover the widest of those or the
// filter silently shows nothing.
//
// This is DELIBERATELY a server-side window, not a device one. Until v5.5.985 the boot
// query only ever asked for TODAY, and every till then merged whatever it happened to
// have accumulated in its own localStorage — never pruned. So a Sunmi that had been open
// for weeks showed weeks of history, while a freshly-opened browser at the same venue
// showed an empty list. Same venue, same day, different answers per device.
export const POS_HISTORY_DAYS = 30;

export function getPosHistorySince() {
  const d = new Date();
  d.setDate(d.getDate() - POS_HISTORY_DAYS);
  d.setHours(0, 0, 0, 0);
  return d;
}

export const fetchClosedChecks = async (locationId = null, limit = 500, sinceDate = null) => {
  if (isMock) return { data: null, error: null };
  // Callers that care pass their own window (the business-day boot path, MPOS history).
  // Everything else gets the full history window rather than just today — see above.
  const since = sinceDate || getPosHistorySince();
  const result = await supabase
    .from('closed_checks')
    .select('*')
    .eq('location_id', locationId)
    .gte('closed_at', since.toISOString())
    .order('closed_at', { ascending: false })
    .limit(limit);
  if (result.data) {
    result.data = result.data.map(c => ({
      id: c.id, ref: c.ref, server: c.server, covers: c.covers,
      staffId: c.staff_id,
      locationId: c.location_id,  // v5.5.279: MUST map for cross-location merge filter
      orderType: c.order_type, customer: c.customer,
      items: c.items || [], discounts: c.discounts || [],
      subtotal: c.subtotal, service: c.service, tip: c.tip, total: c.total,
      taxAmount: c.tax_amount,
      // v5.9.12: the stored tax lines, but ONLY for a check that charged added-on
      // (US) tax: refunds give back each line's own tax and reprints show what was
      // charged. Inclusive-VAT rows load exactly as before (no key at all).
      ...(c.tax_breakdown?.hasExclusiveTax ? { taxBreakdown: c.tax_breakdown } : {}),
      method: c.method,
      closedAt: c.closed_at ? new Date(c.closed_at).getTime() : null,
      // v5.5.845: MUST map seated_at → seatedAt. fetchClosedChecks is the BOOT loader
      // (SyncBridge + useSupabaseInit); without this, a table cashed off on another
      // device before this one booted/refreshed/woke has no seatedAt key, so
      // isSessionClosed can't tombstone it and the paid table climbs back onto the
      // floor — the exact bug the tombstone fixes, on the exact paths it exists for.
      // Epoch ms, matching the live session's seatedAt.
      seatedAt: c.seated_at ? new Date(c.seated_at).getTime() : null,
      status: c.status, refunds: c.refunds || [],
      tableId: c.table_id, tableLabel: c.table_label,
      giftCard: c.gift_card || null,
      stripePaymentIntentId: c.stripe_payment_intent_id || null,
      paymentIntents: c.payment_intents || null,  // v5.5.323: multi-card refund source
      processor: c.processor || 'stripe',         // refund routes by this
      loyalty: c.loyalty || null,
      source: c.source || 'pos', // v5.5.140: surface source for report filters (online / kiosk / qr / pos)
    }));
  }
  return result;
};

// For reports — fetch checks across any date range
export const fetchClosedChecksRange = async (locationId = null, fromDate, toDate, limit = 1000) => {
  if (isMock) return { data: null, error: null };
  let query = supabase
    .from('closed_checks')
    .select('*')
    .eq('location_id', locationId)
    .order('closed_at', { ascending: false })
    .limit(limit);
  if (fromDate) query = query.gte('closed_at', fromDate.toISOString());
  if (toDate)   query = query.lte('closed_at', toDate.toISOString());
  const result = await query;
  if (result.data) {
    result.data = result.data.map(c => ({
      id: c.id, ref: c.ref, server: c.server, covers: c.covers,
      staffId: c.staff_id,
      locationId: c.location_id,  // v5.5.279: MUST map for cross-location merge filter
      orderType: c.order_type, customer: c.customer,
      items: c.items || [], discounts: c.discounts || [],
      subtotal: c.subtotal, service: c.service, tip: c.tip, total: c.total,
      taxAmount: c.tax_amount,
      // v5.9.12: the stored tax lines, but ONLY for a check that charged added-on
      // (US) tax: refunds give back each line's own tax and reprints show what was
      // charged. Inclusive-VAT rows load exactly as before (no key at all).
      ...(c.tax_breakdown?.hasExclusiveTax ? { taxBreakdown: c.tax_breakdown } : {}),
      method: c.method,
      closedAt: c.closed_at ? new Date(c.closed_at).getTime() : null,
      // v5.5.845: MUST map seated_at → seatedAt. fetchClosedChecks is the BOOT loader
      // (SyncBridge + useSupabaseInit); without this, a table cashed off on another
      // device before this one booted/refreshed/woke has no seatedAt key, so
      // isSessionClosed can't tombstone it and the paid table climbs back onto the
      // floor — the exact bug the tombstone fixes, on the exact paths it exists for.
      // Epoch ms, matching the live session's seatedAt.
      seatedAt: c.seated_at ? new Date(c.seated_at).getTime() : null,
      status: c.status, refunds: c.refunds || [],
      tableId: c.table_id, tableLabel: c.table_label,
      giftCard: c.gift_card || null,
      stripePaymentIntentId: c.stripe_payment_intent_id || null,
      paymentIntents: c.payment_intents || null,  // v5.5.323: multi-card refund source
      processor: c.processor || 'stripe',         // refund routes by this
      loyalty: c.loyalty || null,
      source: c.source || 'pos', // v5.5.140: surface source for report filters (online / kiosk / qr / pos)
    }));
  }
  return result;
};

// ── Config pushes ─────────────────────────────────────────────────────────────
export const insertConfigPush = async (push, locationId = null) => {
  if (isMock) return { data: null, error: null };
  // v5.5.143: same resolve-or-fail pattern as toggle86DB / insertClosedCheck.
  // A null/loc-demo locationId silently writes a config_push at 'loc-demo'
  // and the venue's POS devices, filtering by their real locationId,
  // never see it — push lost.
  if (!locationId || locationId === 'loc-demo') {
    locationId = await getLocationId().catch(() => null);
  }
  if (!locationId || locationId === 'loc-demo') {
    try { locationId = JSON.parse(localStorage.getItem('rpos-device') || '{}').locationId || null; } catch {}
  }
  if (!locationId) {
    console.error('[insertConfigPush] could not resolve locationId — push SKIPPED');
    return { data: null, error: new Error('No locationId') };
  }
  // v5.5.733: read the previous snapshot BEFORE inserting the new one, so we can diff and only post
  // an activity note when a price ACTUALLY changed — pushing to POS is not itself a price change.
  let prevSnapshot = null;
  try {
    const { data: prevRow } = await supabase
      .from('config_pushes').select('snapshot')
      .eq('location_id', locationId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    prevSnapshot = prevRow?.snapshot || null;
  } catch { /* no prior push / read blocked — treated as first push (silent) */ }

  const result = await supabase.from('config_pushes').insert({ ...push, location_id: locationId });
  if (result.error) console.error('[DB] config_pushes insert failed:', result.error.message);
  else {
    try {
      const evt = describeMenuChange(prevSnapshot, push?.snapshot, money);
      if (evt) logActivity(locationId, { kind: 'menu', severity: 'info', title: evt.title, body: evt.body });
    } catch { /* feed best-effort */ }
  }
  return result;
};

export const fetchLatestConfigPush = async (locationId = null) => {
  if (isMock) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return { data: null, error: null };
  return supabase
    .from('config_pushes')
    .select('*')
    .eq('location_id', locationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
};

// ── Staff ─────────────────────────────────────────────────────────────────────
export const fetchStaff = async (locationId = null) => {
  if (isMock) return { data: null, error: null };
  return supabase
    .from('staff_locations')
    .select('staff(*)')
    .eq('location_id', locationId);
};

// ── Devices ───────────────────────────────────────────────────────────────────
export const updateDeviceHeartbeat = async (deviceId) => {
  if (isMock) return { data: null, error: null };
  // Database fence stage 1 (contract A10): the server heartbeat reports last_seen, the build
  // and fence_v1. FENCE STAGE 1 FALLBACK: while device_heartbeat does not exist (20260919a1
  // not run) the old direct write below runs. Delete the fallback once 20260919b has run.
  const hb = await sendDeviceHeartbeat();
  if (hb && !hb.unsupported) return { data: hb, error: null };
  if (!hb) return { data: null, error: null };
  // v5.5.279: location_id guard on device heartbeat
  const locationId = getActiveLocationSync() || await getLocationId();
  // v5.5.870: report the running app version so Back Office → Network Status can flag a till that
  // is behind (a stale device silently breaking online printing/payments was invisible before).
  return supabase.from('devices').update({ status: 'online', last_seen: new Date().toISOString(), app_version: VERSION }).eq('id', deviceId).eq('location_id', locationId);
};

export const fetchDevices = async (locationId = null) => {
  if (isMock) return { data: null, error: null };
  return supabase.from('devices').select('*, device_profiles(*)').eq('location_id', locationId);
};

// ── Product images ─────────────────────────────────────────────────────────────
const BUCKET = 'product-images';

export const uploadProductImage = async (itemId, locationId, file) => {
  if (!supabase || isMock) return { url: null, error: new Error('Not connected') };
  // Deterministic path: location/item.ext — re-upload always replaces
  const ext = file.name.split('.').pop().toLowerCase().replace('jpeg', 'jpg');
  const path = `${locationId}/${itemId}.${ext}`;
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
    upsert: true,
    contentType: file.type,
    cacheControl: '3600',
  });
  if (upErr) return { url: null, error: upErr };
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  // Bust CDN cache with timestamp
  const url = `${data.publicUrl}?t=${Date.now()}`;
  return { url, error: null };
};

export const deleteProductImage = async (itemId, locationId) => {
  if (!supabase || isMock) return;
  // Try both jpg and webp/png
  const exts = ['jpg', 'png', 'webp', 'jpeg'];
  for (const ext of exts) {
    await supabase.storage.from(BUCKET).remove([`${locationId}/${itemId}.${ext}`]);
  }
};

// ── Category photos (v5.8.65) ─────────────────────────────────────────────────
// Path <loc>/categories/<catId>-<ts>.<ext>: the cat_photo storage fence (migration
// 20260914_OPS_category_photos.sql) lets only that venue's Back Office users write
// there. Every upload gets a NEW name and old files are never deleted: other venues
// that share the category and stale tabs may still point at the old URL.
export const uploadCategoryPhoto = async (catId, locationId, file) => {
  if (!supabase || isMock) return { url: null, error: new Error('Not connected') };
  const bad = checkPhotoFile(file);
  if (bad) return { url: null, error: new Error(bad === 'type' ? 'Unsupported photo type' : 'Photo is over 5MB') };
  const path = categoryPhotoPath(locationId, catId, file.type, Date.now());
  if (!path) return { url: null, error: new Error('No location') };
  const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, {
    upsert: false,
    contentType: file.type,
    cacheControl: '3600',
  });
  if (upErr) return { url: null, error: upErr };
  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  const url = categoryPhotoUrl({ image: data?.publicUrl });   // must match the database's URL shape check
  return { url, error: url ? null : new Error('Unexpected public URL shape') };
};

// The ONLY path that can clear menu_categories.image. Targeted update scoped to the
// venue with 0 row detection (same traps as the item photo save). When the category
// is shared, peers still on the previous photo (or with none) follow it.
export const saveCategoryImage = async (cat, locationId, nextUrl, prevUrl = null) => {
  if (!supabase || isMock) return { error: new Error('Not connected'), needsMigration: false, peersUpdated: 0, peersFailed: false };
  if (!cat?.id || !locationId || locationId === 'loc-demo') return { error: new Error('No location'), needsMigration: false, peersUpdated: 0, peersFailed: false };
  const now = new Date().toISOString();
  const { data, error: dbErr } = await supabase
    .from('menu_categories')
    .update({ image: nextUrl || null, updated_at: now })
    .eq('id', cat.id)
    .eq('location_id', locationId)
    .select('id');
  const err = dbErr || (!data?.length
    ? new Error('Category photo update matched 0 rows. RLS blocked it or the row belongs to another venue')
    : null);
  reportSave('category photo', err);
  if (err) return { error: err, needsMigration: isMissingImageColumn(dbErr), peersUpdated: 0, peersFailed: false };

  let peersUpdated = 0;
  let peersFailed = false;
  const masterId = cat.master_id ?? cat.masterId ?? null;
  if (masterId && (cat.scope || 'local') !== 'local') {
    try {
      const { data: peers, error: pErr } = await supabase
        .from('menu_categories').select('id,image').eq('master_id', masterId).neq('id', cat.id);
      if (pErr) throw pErr;
      const ids = peerPhotoTargets(peers, prevUrl, nextUrl);
      if (ids.length) {
        const { data: upd, error: uErr } = await supabase
          .from('menu_categories').update({ image: nextUrl || null, updated_at: now }).in('id', ids).select('id');
        if (uErr) throw uErr;
        peersUpdated = upd?.length || 0;
      }
    } catch (e) {
      // The photo IS saved at this venue. The caller tells the user the other venues were not.
      peersFailed = true;
      console.warn('[saveCategoryImage] shared venues not updated:', e?.message || e);
    }
  }
  return { error: null, needsMigration: false, peersUpdated, peersFailed };
};

// True once menu_categories.image exists (the 20260914 migration has run).
// Cached for the session once true; false in mock mode. ONLY a missing column counts as
// not ready: a network blip must not tell Peter the migration did not run, so any other
// error keeps the upload box (the upload itself then reports its own error).
let _categoryPhotosReady = null;
export const categoryPhotosReady = async () => {
  if (!supabase || isMock) return false;
  if (_categoryPhotosReady === true) return true;
  const { error } = await supabase.from('menu_categories').select('image').limit(1);
  if (!error) { _categoryPhotosReady = true; return true; }
  return !isMissingImageColumn(error);
};

// v3.9.0 — image field in upsert

// ── Quick Screen ───────────────────────────────────────────────────────────────
export const saveQuickScreenIds = async (ids, locationId = null) => {
  if (isMock) return;
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || locationId === 'loc-demo') return;
  await supabase.from('locations').update({ quick_screen_ids: ids }).eq('id', locationId);
};

export const loadQuickScreenIds = async (locationId = null) => {
  if (isMock) return [];
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || locationId === 'loc-demo') return [];
  const { data } = await supabase.from('locations').select('quick_screen_ids').eq('id', locationId).single();
  return data?.quick_screen_ids || [];
};

// ── Multi-location (v4.6.22) ──────────────────────────────────────────────────
// Returns every location the currently-authenticated user has access to.
// Prefers the new user_locations junction; falls back to user_profiles.location_id
// for pre-migration environments so nothing breaks if the SQL isn't run yet.
export const fetchAccessibleLocations = async () => {
  if (isMock) {
    return { data: [{ id: 'loc-demo', name: 'Demo Location', role: 'manager' }], error: null };
  }
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id;
  if (!userId) return { data: [], error: new Error('No authenticated user') };

  // v5.5.308: UNION the junction rows (user_locations) with the user's primary
  // location (user_profiles.location_id). Previously this returned ONLY the
  // junction rows when non-empty — so a user whose primary location wasn't in
  // user_locations would have the BO header show their primary while the
  // location switcher listed a different set (the junction). De-duped by id.
  const byId = new Map();

  const junction = await supabase
    .from('user_locations')
    .select('role, location_id, locations(id, name, timezone)')
    .eq('user_id', userId);
  if (!junction.error) {
    for (const r of (junction.data || [])) {
      if (r.locations) byId.set(r.locations.id, {
        id: r.locations.id, name: r.locations.name, timezone: r.locations.timezone, role: r.role,
      });
    }
  }

  // Always include the user's primary location from user_profiles, even if it
  // isn't in the junction table (legacy single-location setups, or a primary
  // pointed at a location with no matching user_locations row).
  const profile = await supabase
    .from('user_profiles')
    .select('location_id, locations(id, name, timezone)')
    .eq('id', userId)
    .single();
  if (profile.data?.locations && !byId.has(profile.data.locations.id)) {
    byId.set(profile.data.locations.id, {
      id: profile.data.locations.id,
      name: profile.data.locations.name,
      timezone: profile.data.locations.timezone,
      role: 'manager',
    });
  }

  return { data: Array.from(byId.values()), error: null };
};

// Fetch closed checks across multiple locations in parallel. Each row is tagged
// with its source locationId so the Location compare report can group by site.
export const fetchClosedChecksMultiRange = async (locationIds = [], fromDate, toDate, limit = 2000) => {
  if (!locationIds?.length) return { data: [], error: null };
  if (isMock) return { data: [], error: null };
  try {
    const results = await Promise.all(locationIds.map(id =>
      fetchClosedChecksRange(id, fromDate, toDate, limit).then(r => ({
        id,
        checks: (r.data || []).map(c => ({ ...c, locationId: id })),
      }))
    ));
    return { data: results.flatMap(r => r.checks), error: null };
  } catch (err) {
    return { data: [], error: err };
  }
};


// ──────────────────────────────────────────────────────────────────
// v4.7.0 — multi-location promote / demote helpers
//
// Model recap (Peter's rules, 26 Apr 2026):
//   - "shared" = item visible at every location in the org. Each location
//     holds its OWN copy of the row. Editing at location B only changes
//     that location's settings. master_id is the shared "family key" —
//     every linked row in the org has master_id = <original promoter's id>.
//   - "global" = same as shared, PLUS edits at any location propagate to
//     all sibling rows. Implemented in upsertMenuItem (propagate-on-edit).
//   - "local" = independent row, master_id null, org_id null.
//   - Demote shared/global → local: just clears the flags on this row.
//     Sibling rows at other locations stay where they are and become
//     independent local items at those locations.
// ──────────────────────────────────────────────────────────────────

/**
 * Resolve the current org and a list of all OTHER locations within it.
 * Returns { org_id, otherLocationIds: [] }.
 */
const getOrgPeerLocations = async (currentLocationId) => {
  if (isMock || !supabase) return { org_id: null, otherLocationIds: [] };
  const { data: thisLoc, error: e1 } = await supabase
    .from('locations').select('id, org_id').eq('id', currentLocationId).maybeSingle();
  if (e1 || !thisLoc?.org_id) return { org_id: null, otherLocationIds: [] };
  const { data: peers, error: e2 } = await supabase
    .from('locations').select('id').eq('org_id', thisLoc.org_id).neq('id', currentLocationId);
  if (e2) return { org_id: thisLoc.org_id, otherLocationIds: [] };
  return { org_id: thisLoc.org_id, otherLocationIds: (peers || []).map(p => p.id) };
};

/**
 * v5.5.877 (Bug 2) — Resolve the menu a shared category should join at a peer
 * location: the default-flagged menu, else the first menu by sort order, else
 * null. A menu-less location shows all categories regardless of membership, so
 * null is a safe fallback there.
 */
const resolvePeerDefaultMenu = async (peerLocId) => {
  if (isMock || !supabase || !peerLocId) return null;
  const { data: menus, error } = await supabase
    .from('menus').select('id, is_default, sort_order')
    .eq('location_id', peerLocId).order('sort_order', { ascending: true });
  if (error || !menus?.length) return null;
  const def = menus.find(m => m.is_default);
  return (def || menus[0]).id;
};

// v5.8.73 (Coffee Boy Barnsley, 15 Sep 2026): sharing to a venue with NO menu used to leave the
// shared categories on no menu (resolvePeerDefaultMenu gave null), so tills with a menu picked
// never showed them and Back Office showed them under every menu. Now the venue gets a menu,
// named like the menu the category came from (lib/menuMembership.js peerMenuPlan). One creation
// per venue at a time, so sharing several categories at once never makes duplicate menus.
const _peerMenuCreation = new Map();   // peerLocId -> Promise<menu id | null>
const ensurePeerMenu = async (peerLocId, sourceMenuId, orgId) => {
  if (isMock || !supabase || !peerLocId) return null;
  if (_peerMenuCreation.has(peerLocId)) return _peerMenuCreation.get(peerLocId);
  const run = (async () => {
    const { data: menus, error } = await supabase
      .from('menus').select('id, is_default, sort_order').eq('location_id', peerLocId);
    if (error) { console.warn('[ensurePeerMenu] menus read failed', error.message); return null; }
    let sourceName = '';
    if (!(menus || []).length && sourceMenuId) {
      const { data: src } = await supabase.from('menus').select('name').eq('id', sourceMenuId).maybeSingle();
      sourceName = src?.name || '';
    }
    const plan = peerMenuPlan(menus, sourceName);
    if (plan.useId) return plan.useId;
    const id = `menu-${Date.now()}-${String(peerLocId).slice(-8)}`;
    const { error: insErr } = await supabase.from('menus').insert({
      id, location_id: peerLocId, name: plan.create.name, description: '',
      is_default: true, is_active: true, sort_order: 0, schedule: null, priority: 0,
      scope: 'local', org_id: orgId ?? null, updated_at: new Date().toISOString(),
    });
    if (insErr) {
      reportSave('menu', insErr);
      return resolvePeerDefaultMenu(peerLocId);   // made by someone else meanwhile, or null
    }
    return id;
  })();
  _peerMenuCreation.set(peerLocId, run);
  try { return await run; } finally { _peerMenuCreation.delete(peerLocId); }
};

/**
 * v5.5.877 (Bug 3) — Copy a set of modifier groups, plus everything they
 * transitively reference (nested sub-groups via option.subGroupId, and the
 * sold-alone sub-items via option.itemId), from a source location to ONE peer
 * location. Deterministic, idempotent peer ids so re-running is a no-op.
 *
 * modifier_groups has no scope/master_id column, so the id
 * `<sourceGroupId>_<peerSuffix>` IS the cross-location link. Sold-alone
 * sub-items are real menu_items rows and reuse the item peer-id scheme
 * `<masterId>_<peerSuffix>`. Option name/price are denormalised into the option
 * so they copy verbatim; itemId only drives 86/stock, and rewriting it to the
 * peer sub-item keeps stock decrements working at the peer too.
 *
 * Cross-tenant safe: every SOURCE read is filtered by the source location_id
 * (see the db.js:279 hazard note — never fetch a group by bare id across venues).
 *
 * Returns Map(sourceGroupId -> peerGroupId) so the caller can repoint each peer
 * item's assigned_modifier_groups.
 */
/**
 * Per-venue ids translated by NAME for one peer venue (23 Sep 2026).
 *
 * A tax rate, a tax profile and a print centre are rows of the venue that owns
 * them; their ids mean nothing at another venue. The old copy either dropped
 * them (the product arrived with no tax) or carried the raw id (a sub-item
 * pointed at a rate the peer did not have). A peer's equivalent is found by
 * name (and rate, for a tax rate); when there is none the field is null and
 * the caller is told, rather than a foreign id being written.
 */
const _peerIdMapsMemo = new Map();   // `${source}|${peer}` → { at, maps }; 60 s, a bulk run reuses it
// Throws when any lookup fails: a failed answer is NEVER memoised and the
// caller skips that venue for this product rather than writing null tax.
const peerIdMapsFor = async (sourceLocId, peerLocId) => {
  const memoKey = `${sourceLocId}|${peerLocId}`;
  const hit = _peerIdMapsMemo.get(memoKey);
  if (hit && Date.now() - hit.at < 60_000) return hit.maps;
  const maps = await _peerIdMapsUncached(sourceLocId, peerLocId);
  _peerIdMapsMemo.set(memoKey, { at: Date.now(), maps });
  return maps;
};
const _peerIdMapsUncached = async (sourceLocId, peerLocId) => {
  const byName = (rows, key) => { const m = new Map(); for (const r of rows || []) { const k = key(r); if (k && !m.has(k)) m.set(k, r.id); } return m; };
  const results = await Promise.all([
    supabase.from('tax_rates').select('id,name,rate').eq('location_id', sourceLocId),
    supabase.from('tax_rates').select('id,name,rate').eq('location_id', peerLocId),
    supabase.from('tax_profiles').select('id,name').eq('location_id', sourceLocId),
    supabase.from('tax_profiles').select('id,name').eq('location_id', peerLocId),
    supabase.from('print_routing').select('centres').eq('location_id', sourceLocId).maybeSingle(),
    supabase.from('print_routing').select('centres').eq('location_id', peerLocId).maybeSingle(),
    supabase.from('menus').select('id,name').eq('location_id', sourceLocId),
    supabase.from('menus').select('id,name').eq('location_id', peerLocId),
  ]);
  const failed = results.find((r) => r && r.error);
  if (failed) throw new Error(`could not read the venue's tax, print or menu setup: ${failed.error.message || failed.error}`);
  const [srcRates, peerRates, srcProfiles, peerProfiles, srcRouting, peerRouting, srcMenus, peerMenus] = results;
  const rateKey = (r) => `${String(r.name || '').trim().toLowerCase()}|${Number(r.rate)}`;
  const nameKey = (r) => String(r.name || '').trim().toLowerCase();
  const srcRateById = new Map((srcRates.data || []).map((r) => [r.id, rateKey(r)]));
  const peerRateByKey = byName(peerRates.data, rateKey);
  const srcProfileById = new Map((srcProfiles.data || []).map((r) => [r.id, nameKey(r)]));
  const peerProfileByKey = byName(peerProfiles.data, nameKey);
  const centres = (row) => (Array.isArray(row?.data?.centres) ? row.data.centres : []);
  const srcCentreById = new Map(centres(srcRouting).map((c) => [c.id, nameKey(c)]));
  const peerCentreByKey = byName(centres(peerRouting), nameKey);
  const srcMenuById = new Map((srcMenus.data || []).map((r) => [r.id, nameKey(r)]));
  const peerMenuByKey = byName(peerMenus.data, nameKey);
  const srcNames = new Map([
    ...(srcRates.data || []).map((r) => [`tax_rate_id:${r.id}`, r.name]),
    ...(srcProfiles.data || []).map((r) => [`tax_profile_id:${r.id}`, r.name]),
    ...centres(srcRouting).map((c) => [`centre_id:${c.id}`, c.name]),
    ...(srcMenus.data || []).map((r) => [`pricing.menus:${r.id}`, r.name]),
  ]);
  return {
    taxRateIdFor: (id) => peerRateByKey.get(srcRateById.get(id)) || null,
    taxProfileIdFor: (id) => peerProfileByKey.get(srcProfileById.get(id)) || null,
    centreIdFor: (id) => peerCentreByKey.get(srcCentreById.get(id)) || null,
    menuIdFor: (id) => peerMenuByKey.get(srcMenuById.get(id)) || null,
    /** "tax_rate_id:<uuid>" → "tax rate 'VAT 20%'", for the operator. */
    nameOf: (u) => {
      const [field, id] = String(u).split(':');
      const label = { tax_rate_id: 'tax rate', tax_profile_id: 'tax profile', centre_id: 'print centre', 'pricing.menus': 'menu', 'tax_overrides.takeaway': 'takeaway tax rate', 'tax_overrides.delivery': 'delivery tax rate', 'tax_overrides.collection': 'collection tax rate', 'tax_overrides.dineIn': 'dine-in tax rate', 'tax_overrides.drive-thru': 'drive thru tax rate' }[field] || field;
      const n = srcNames.get(`${field}:${id}`) || srcNames.get(`tax_rate_id:${id}`);
      return n ? `${label} '${n}'` : `${label} ${id}`;
    },
  };
};

/** Short memos so a bulk re-send does not repeat the same work per product. */
const _memo60 = new Map();
const memo60 = async (key, fn) => {
  const hit = _memo60.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = await fn();
  _memo60.set(key, { at: Date.now(), value });
  return value;
};
export const clearShareMemos = () => { _memo60.clear(); _peerIdMapsMemo.clear(); };

/**
 * Where a category's copy lives at a venue: the bare master id at the venue
 * that OWNS it, `<master>_<suffix>` everywhere else. Addressing the owner with a
 * suffixed id created a duplicate category there (round-2 review, 23 Sep).
 */
const peerCatIdAt = (catMasterId, catMasterLocId, peerLocId) =>
  (catMasterLocId && peerLocId === catMasterLocId) ? catMasterId : `${catMasterId}_${peerSuffixOf(peerLocId)}`;

/** The master category row for any category row (itself when it is the master). */
const masterCategoryOf = async (catRow) => {
  if (!catRow) return null;
  if (!catRow.master_id || catRow.master_id === catRow.id) return catRow;
  const { data } = await supabase.from('menu_categories').select('*').eq('id', catRow.master_id).maybeSingle();
  return data || catRow;
};

const shareModifierGroupsToLocation = async (groupIds, sourceLocId, peerLocId, orgId, scope, mode = 'resend') => {
  const idMap = new Map();
  if (isMock || !supabase) return idMap;
  if (!Array.isArray(groupIds) || groupIds.length === 0 || !peerLocId || !sourceLocId) return idMap;
  const peerSuffix = peerLocId.slice(-8);
  const seenGroups = new Set();
  const seenItems = new Set();
  const unmappedSub = [];
  idMap.unmapped = unmappedSub;

  const srcSuffix = peerSuffixOf(sourceLocId);
  // A group or sub-item id that already ends with THIS venue's suffix is a copy;
  // its bare id is the master, held by the owning venue (round-3 review).
  const bareOf = (id) => (String(id).endsWith(`_${srcSuffix}`) ? String(id).slice(0, -(srcSuffix.length + 1)) : String(id));

  // Copy a sold-alone sub-item (menu_items row) to the peer. Returns peer item id.
  const copySubItem = async (itemId) => {
    if (!itemId) return null;
    const { data: si, error: siErr } = await supabase.from('menu_items').select('*')
      .eq('id', itemId).eq('location_id', sourceLocId).maybeSingle();
    if (siErr || !si) { if (siErr) console.warn('[shareModifierGroups] subitem fetch failed', itemId, siErr); return null; }
    const subMasterId = si.master_id || si.id;
    let peerItemId = `${subMasterId}_${peerSuffix}`;
    if (si.master_id && si.master_id !== si.id) {
      // We hold a copy: at the owning venue the row is the bare master id.
      const { data: subMaster } = await supabase.from('menu_items').select('id, location_id').eq('id', subMasterId).maybeSingle();
      if (subMaster && subMaster.location_id === peerLocId) peerItemId = subMasterId;
    }
    if (seenItems.has(peerItemId)) return peerItemId; // already copied this run
    seenItems.add(peerItemId);
    // A sub-item may itself carry modifier groups — copy those first so its
    // rewritten assigned_modifier_groups point at peer groups. Guarded by
    // seenGroups, so a group<->item cycle terminates.
    for (const ag of (Array.isArray(si.assigned_modifier_groups) ? si.assigned_modifier_groups : [])) {
      await copyGroup(typeof ag === 'string' ? ag : ag?.groupId);
    }
    // 23 Sep 2026: the whole sub-item, translated for this venue, instead of a
    // hand-built subset carrying the SOURCE venue's tax rate id. An existing copy
    // of a Shared product keeps its own price and image (resendFields).
    let subIds;
    try { subIds = await peerIdMapsFor(sourceLocId, peerLocId); }
    catch (e) { console.warn('[shareModifierGroups] venue setup unreadable, sub-item skipped', peerItemId, e?.message || e); return null; }
    const { data: existingSub, error: probeErr } = await supabase.from('menu_items').select('id').eq('id', peerItemId).maybeSingle();
    if (probeErr) { console.warn('[shareModifierGroups] could not check the peer sub-item, skipped', peerItemId, probeErr); return null; }
    const subScope = scope || 'shared';
    // An EDIT refreshes what follows an edit; a share/re-send writes what a
    // (re-)send may. Neither writes archived/scope/category onto an existing copy
    // from the edit path (round-2 review, 23 Sep).
    const allowed = new Set(mode === 'edit' && existingSub
      ? propagatedFields(subScope, { lockPricing: !!si.lock_pricing })
      : resendFields(subScope, { exists: !!existingSub, lockPricing: !!si.lock_pricing }));
    const pick = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => allowed.has(k)));
    const subPricing = remapPricingMenus(fieldOf(si, 'pricing'), subIds.menuIdFor).pricing;
    const peerSub = {
      ...pick({ ...carryVerbatim(si), ...nameColumnsFor(si), ...(subPricing !== undefined ? { pricing: subPricing } : {}) }),
      ...pick(remapForPeer(si, {
        catIdFor: () => null, parentIdFor: () => null,
        groupIdFor: (g) => idMap.get(g) || `${bareOf(g)}_${peerSuffix}`,
        taxRateIdFor: subIds.taxRateIdFor, taxProfileIdFor: subIds.taxProfileIdFor, centreIdFor: subIds.centreIdFor,
      }, ['assigned_modifier_groups', 'option_group_order', 'tax_rate_id', 'tax_profile_id', 'centre_id', 'tax_overrides']).fields),
      ...(mode === 'edit' && existingSub ? {} : pick(carryResendOnly(si))),
      id: peerItemId,
      location_id: peerLocId,
      type: si.type ?? 'subitem',
      ...(existingSub ? {} : { cat: null, cats: [], parent_id: null }),   // sub-items never render in a grid
      // The copy keeps the source's choice. With none, a sub item is not sold alone (rule 6).
      sold_alone: resolveSoldAlone({ sold_alone: si.sold_alone, type: si.type ?? 'subitem' }),
      ...(existingSub ? {} : { scope: subScope, org_id: orgId }),
      master_id: subMasterId,
      updated_at: new Date().toISOString(),
    };
    let { error: upErr } = await supabase.from('menu_items').upsert(peerSub, { onConflict: 'id' });
    if (upErr && peerSub.item_code && (isDuplicateItemCodeError(upErr) || isMissingItemCodeColumn(upErr))) {
      unmappedSub.push(`item code '${peerSub.item_code}' on ${si.name} (already used there)`);
      delete peerSub.item_code;
      ({ error: upErr } = await supabase.from('menu_items').upsert(peerSub, { onConflict: 'id' }));
    }
    if (upErr) { console.warn('[shareModifierGroups] peer subitem upsert failed', peerItemId, upErr); seenItems.delete(peerItemId); return null; }
    return peerItemId;
  };

  // Copy one group (recursing into nested sub-groups + option sub-items).
  const copyGroup = async (gid) => {
    if (!gid || seenGroups.has(gid)) return;
    seenGroups.add(gid);
    const { data: g, error: gErr } = await supabase.from('modifier_groups').select('*')
      .eq('id', gid).eq('location_id', sourceLocId).maybeSingle();
    if (gErr || !g) { if (gErr) console.warn('[shareModifierGroups] group fetch failed', gid, gErr); return; }
    const bareGid = bareOf(gid);
    let peerGid = `${bareGid}_${peerSuffix}`;
    if (bareGid !== gid) {
      // We hold a copy: the peer may be the owner, whose row is the bare id.
      const { data: ownerRow } = await supabase.from('modifier_groups').select('id').eq('id', bareGid).eq('location_id', peerLocId).maybeSingle();
      if (ownerRow) peerGid = bareGid;
    }
    idMap.set(gid, peerGid);
    const peerOptions = [];
    for (const opt of (Array.isArray(g.options) ? g.options : [])) {
      const peerOpt = { ...opt };
      if (opt?.subGroupId) {
        await copyGroup(opt.subGroupId);
        peerOpt.subGroupId = idMap.get(opt.subGroupId) || `${opt.subGroupId}_${peerSuffix}`;
      }
      if (opt?.itemId) {
        const peerItemId = await copySubItem(opt.itemId);
        // Never the SOURCE venue's id at the peer: with no copy, the option stands
        // on its own (name and price still travel) and the miss is reported.
        if (peerItemId) peerOpt.itemId = peerItemId; else { delete peerOpt.itemId; unmappedSub.push(`sub-item ${opt.name || opt.itemId}`); }
      }
      peerOptions.push(peerOpt);
    }
    const peerRow = {
      id: peerGid,
      location_id: peerLocId,
      name: g.name,
      min: g.min ?? 0,
      max: g.max ?? 1,
      selection_type: g.selection_type ?? 'single',
      options: peerOptions,
      sort_order: g.sort_order ?? 0,
      // NB: modifier_groups has NO updated_at column — including it → PGRST204.
    };
    const { error: upErr } = await supabase.from('modifier_groups').upsert(peerRow, { onConflict: 'id' });
    if (upErr) console.warn('[shareModifierGroups] peer group upsert failed', peerGid, upErr);
  };

  for (const gid of groupIds) await copyGroup(gid);
  return idMap;
};

/**
 * Promote a local item to shared (or global). Creates copies at every other
 * location in the org. Source row gets master_id = source.id; copies share
 * the same master_id. Each copy gets a deterministic id <masterId>_<locShort>.
 *
 * If the item is already shared/global, just changes scope on all linked rows.
 * If demoting (newScope = 'local'), only clears flags on the source row.
 */
export const setMenuItemScope = async (item, newScope, _depth = 0) => {
  if (isMock) return { ok: true };
  if (!supabase) return { ok: false, error: 'no supabase' };
  if (!item?.id) return { ok: false, error: 'no item id' };
  if (!['local', 'shared', 'global'].includes(newScope)) return { ok: false, error: 'invalid scope' };

  const currentScope = item.scope || 'local';
  const sourceLocId = item.location_id || (await getLocationId());
  if (!sourceLocId) return { ok: false, error: 'no location id' };

  // ── VARIANT CHILD SHARED DIRECTLY → redirect to the parent (v5.5.877, Bug 1b) ──
  // Scope is a PRODUCT-level property. A variant child (a row with parent_id set)
  // must never be scoped on its own: the old code built its peer copy with
  // parent_id:null, so the child landed at peer locations as a standalone product
  // ("Small"/"Medium"/"Large" as separate items) instead of a size under the
  // master. Apply any scope change to the whole family via the parent — which
  // copies every child under the peer master. _depth bounds recursion in case of
  // corrupt multi-level parent_id data (the UI only ever nests one level).
  const _childParentId = item.parentId ?? item.parent_id ?? null;
  if (_childParentId && _depth < 4) {
    const { data: parentRow, error: pErr } = await supabase
      .from('menu_items').select('*')
      .eq('id', _childParentId).eq('location_id', sourceLocId).maybeSingle();
    if (pErr) { console.warn('[setMenuItemScope] parent fetch failed for child', item.id, pErr); return { ok: false, error: pErr }; }
    if (parentRow) return setMenuItemScope({ ...parentRow }, newScope, _depth + 1);
    // Parent missing (orphaned child) — fall through and treat as a standalone item.
  }

  // ── A COPY REDIRECTS TO ITS MASTER (23 Sep 2026) ──
  // Every peer id is <master>_<venue suffix>. Sharing from a copy would address
  // the owning venue with a suffixed id that does not exist there and create a
  // second product, second sizes, second groups. The master does the sharing.
  if (newScope !== 'local' && !isMasterRow(item) && _depth < 4) {
    const { data: masterRow, error: mErr } = await supabase.from('menu_items').select('*')
      .eq('id', item.master_id || item.masterId).maybeSingle();
    if (mErr) return { ok: false, error: mErr };
    if (masterRow?.archived) return { ok: false, error: 'the owning venue has retired this product; make your copy Local to keep it' };
    if (masterRow) return setMenuItemScope(masterRow, newScope, _depth + 1);
  }

  // ── DEMOTE → local ──
  if (newScope === 'local') {
    const { error } = await supabase.from('menu_items')
      .update({ scope: 'local', org_id: null, master_id: null, updated_at: new Date().toISOString() })
      .eq('id', item.id);
    if (error) { console.error('[setMenuItemScope] demote error:', error); return { ok: false, error }; }
    return { ok: true, action: 'demoted', affected: 1 };
  }

  // ── PROMOTE / RE-SCOPE among shared/global ──
  // We need: org_id, masterId (source's id if first time, item.master_id otherwise),
  // and the list of peer locations to copy to (only on FIRST promotion).
  const { org_id, otherLocationIds } = await getOrgPeerLocations(sourceLocId);
  if (!org_id) return { ok: false, error: 'this location is not in an org — cannot share' };

  const masterId = item.master_id || item.id;
  const isFirstPromotion = currentScope === 'local';

  // 1) Update the source row. Always.
  const sourcePatch = {
    scope: newScope,
    org_id,
    master_id: masterId,
    updated_at: new Date().toISOString(),
  };
  const { error: e1 } = await supabase.from('menu_items').update(sourcePatch).eq('id', item.id);
  if (e1) { console.error('[setMenuItemScope] source update error:', e1); return { ok: false, error: e1 }; }

  // v5.5.12: AUTO-PROMOTE CATEGORY FIRST so peer item rows can reference the
  // deterministic peer category IDs that get created here. The pre-v5.5.12 code
  // promoted the category AFTER copying items, which meant peer items were
  // created with cat=<source-loc-cat-id> — an ID that ONLY exists at the source
  // location. Result: shared item appeared at peer locations but with no
  // category, so it never showed up in the right category section.
  // Now: promote the category up front, then rewrite the cat field on each
  // peer item using the cat's master_id + peer location suffix.
  let categoryAction = null;
  // Map source-side category id → its master_id, so we know the deterministic
  // peer cat id is `<catMasterId>_<peerLocSuffix>`.
  const catMasterIdByCatId = new Map();
  const catMasterLocByMasterId = new Map();   // where each category master lives (owner-aware ids)
  if (newScope !== 'local' && item.cat) {
    try {
      const { data: catRow } = await supabase.from('menu_categories').select('*').eq('id', item.cat).maybeSingle();
      if (catRow) {
        // 23 Sep 2026: ALWAYS, not only while local. A category that is already
        // shared can be missing at a peer (Location 2 had none of Provo's Coffee);
        // setMenuCategoryScope now upserts every peer copy, so this recreates it.
        const wasLocal = (catRow.scope || 'local') === 'local';
        const catResult = wasLocal
          ? await setMenuCategoryScope(catRow, newScope)
          : await memo60(`cat:${catRow.id}|${catRow.scope}`, () => setMenuCategoryScope(catRow, catRow.scope));
        if (catResult.ok) { if (wasLocal) categoryAction = catResult.action; }
        else console.warn('[setMenuItemScope] cat auto-promote failed:', catResult.error);
        // Re-fetch to get fresh master_id (setMenuCategoryScope just wrote it)
        const { data: catFresh } = await supabase.from('menu_categories').select('master_id, id').eq('id', item.cat).maybeSingle();
        const catMasterId = catFresh?.master_id || catFresh?.id || catRow.id;
        catMasterIdByCatId.set(catRow.id, catMasterId);
        if (!catMasterLocByMasterId.has(catMasterId)) {
          const { data: cm } = await supabase.from('menu_categories').select('location_id').eq('id', catMasterId).maybeSingle();
          catMasterLocByMasterId.set(catMasterId, cm?.location_id || null);
        }
      }
    } catch (e) {
      console.warn('[setMenuItemScope] cat auto-promote threw:', e?.message || e);
    }
  }
  // Also handle item.cats[] (multi-category mapping) — promote each local one
  // so the peer cats[] array can be rewritten correctly.
  if (newScope !== 'local' && Array.isArray(item.cats) && item.cats.length > 0) {
    for (const catId of item.cats) {
      if (catMasterIdByCatId.has(catId)) continue;
      try {
        const { data: catRow } = await supabase.from('menu_categories').select('*').eq('id', catId).maybeSingle();
        if (!catRow) continue;
        // 23 Sep 2026: always, not only when local. A category that is already
        // shared may be missing at a peer (Location 2 had none of Provo's Coffee).
        if ((catRow.scope || 'local') === 'local') await setMenuCategoryScope(catRow, newScope);
        else await memo60(`cat:${catRow.id}|${catRow.scope}`, () => setMenuCategoryScope(catRow, catRow.scope));
        const { data: catFresh } = await supabase.from('menu_categories').select('master_id, id').eq('id', catId).maybeSingle();
        const catMasterId = catFresh?.master_id || catFresh?.id || catRow.id;
        catMasterIdByCatId.set(catRow.id, catMasterId);
        if (!catMasterLocByMasterId.has(catMasterId)) {
          const { data: cm } = await supabase.from('menu_categories').select('location_id').eq('id', catMasterId).maybeSingle();
          catMasterLocByMasterId.set(catMasterId, cm?.location_id || null);
        }
      } catch (e) {
        console.warn('[setMenuItemScope] cats[] auto-promote threw for', catId, ':', e?.message || e);
      }
    }
  }
  // Helper: peer cat id from a master-id given the peer location's suffix.
  // Translate a source-side cat id to the cat id at a given peer venue. The
  // venue that OWNS the category holds the bare master id (round-2 review).
  const peerCatForSourceCatAt = (sourceCatId, peerLocId) => {
    if (!sourceCatId) return null;
    const cmid = catMasterIdByCatId.get(sourceCatId);
    return cmid ? peerCatIdAt(cmid, catMasterLocByMasterId.get(cmid), peerLocId) : null;
  };
  const peerCatForSourceCat = (sourceCatId, peerLocSuffix) => peerCatForSourceCatAt(sourceCatId, otherLocationIds.find((l) => peerSuffixOf(l) === peerLocSuffix) || peerLocSuffix);

  let createdCount = 0;
  let createdVariants = 0;
  let updatedSiblings = 0;
  const unmappedAll = [];
  let skippedPeers = 0;

  // 23 Sep 2026: re-sharing (shared <-> global, or Global pressed again) used to
  // flip `scope` on the siblings and nothing else. Provo's Latte was Global while
  // Location 2's copy sat archived, pointing at a category that no longer existed
  // there, untouched since July. Every share now walks every peer and upserts the
  // WHOLE product: the copy is created when missing and refreshed when present.
  if (!isFirstPromotion) {
    const { error, count } = await supabase.from('menu_items')
      .update({ scope: newScope, updated_at: new Date().toISOString() }, { count: 'exact' })
      .eq('master_id', masterId)
      .neq('id', item.id);
    if (error) console.warn('[setMenuItemScope] sibling rescope error:', error);
    else updatedSiblings = count || 0;
  }
  {
    // v5.5.877 (Bug 1a): fetch variant children by parent_id ALWAYS — not only
    // when type==='variants'. Real Supabase data uses several parent types
    // (combo/pizza, or a parent whose type flip never persisted), and every read
    // surface groups children by parent_id, not the type string (App.jsx:6063).
    // The old `if (item.type === 'variants')` gate copied such a parent to peers
    // with NO children, so the operator then shared each size individually and
    // each became a standalone product (Bug 1b). Detecting by parent_id matches
    // the read model; the location_id filter keeps the fetch tenant-safe.
    let variants = [];
    {
      const { data: vData, error: vErr } = await supabase
        .from('menu_items')
        .select('*')
        .eq('parent_id', item.id)
        .eq('location_id', sourceLocId)
        .eq('archived', false);
      if (vErr) console.warn('[setMenuItemScope] variant fetch error:', vErr);
      else variants = vData || [];
    }

    // v5.5.877 (Bug 3): gather every modifier group referenced by the master AND
    // its variant children, so each peer location gets its own copy of the groups
    // (plus nested sub-groups and sold-alone option sub-items) and the peer item
    // rows can point at the peer-side group ids. assigned_modifier_groups is an
    // array of OBJECTS ({groupId, min?, max?}); tolerate legacy string entries.
    const collectGroupIds = (assigned) => (Array.isArray(assigned) ? assigned : [])
      .map(ag => (typeof ag === 'string' ? ag : ag?.groupId)).filter(Boolean);
    const parentAssigned = item.assignedModifierGroups ?? item.assigned_modifier_groups ?? [];
    const allGroupIds = [...new Set([
      ...collectGroupIds(parentAssigned),
      ...variants.flatMap(v => collectGroupIds(v.assigned_modifier_groups)),
    ])];

    // 2) First-time promotion: copy this item to every peer location.
    //    Build a deterministic id per peer so re-promoting later is idempotent.
    const baseRow = {
      // 23 Sep 2026: EVERYTHING the product is, not a hand-picked subset.
      // lib/shareCopy.js classifies every column; carryVerbatim reads the
      // EDITED value (camel wins) and nameColumnsFor derives the four name
      // columns exactly as upsertMenuItem does. No hand-written duplicates:
      // they re-imposed snake-first reads and sent stale names (round-2 review).
      ...carryVerbatim(item),
      ...nameColumnsFor(item),
      type: fieldOf(item, 'type') ?? 'simple',
      pricing: fieldOf(item, 'pricing') ?? { base: item.price ?? 0 },
      allergens: fieldOf(item, 'allergens') ?? [],
      // v5.8.95: carry Sold alone to the peer. Without it a first share inserted the peer row at
      // the column default false, which hides a normal product from online ordering and HubRise.
      sold_alone: resolveSoldAlone(item),
      // The shared metadata
      scope: newScope,
      org_id,
      master_id: masterId,
      updated_at: new Date().toISOString(),
    };
    for (const peerLocId of otherLocationIds) {
      const peerLocSuffix = peerLocId.slice(-8);
      const peerId = `${masterId}_${peerLocSuffix}`;
      // v5.5.12: rewrite cat / cats[] to peer-side IDs so the item shows up in
      // the right category section at each peer location.
      const peerCat = peerCatForSourceCat(item.cat, peerLocSuffix);
      const peerCats = Array.isArray(item.cats)
        ? item.cats.map(c => peerCatForSourceCat(c, peerLocSuffix)).filter(Boolean)
        : [];
      // v5.5.877 (Bug 3): copy the modifier groups to THIS peer and get a
      // source→peer group-id map, then repoint assigned_modifier_groups so the
      // peer item references groups that actually exist at the peer location.
      const modIdMap = await memo60(`groups:${allGroupIds.join(',')}|${peerLocId}|${newScope}|resend`, () => shareModifierGroupsToLocation(allGroupIds, sourceLocId, peerLocId, org_id, newScope, 'resend'));
      const rewriteAssigned = (assigned) => (Array.isArray(assigned) ? assigned : []).map(ag => {
        const gid = typeof ag === 'string' ? ag : ag?.groupId;
        if (!gid) return ag;
        const peerGid = modIdMap.get(gid) || `${gid}_${peerLocSuffix}`;
        return typeof ag === 'string' ? peerGid : { ...ag, groupId: peerGid };
      });
      let ids;
      try { ids = await peerIdMapsFor(sourceLocId, peerLocId); }
      catch (e) { console.warn('[setMenuItemScope] venue setup unreadable, peer skipped', peerLocId, e?.message || e); skippedPeers++; continue; }
      // 23 Sep 2026: an EXISTING copy of a Shared product keeps its own price,
      // category and image (that is what Shared promises); a Global copy and a
      // new row take everything. archived (restore only) and sort_order are
      // written here, on a deliberate share, never on an edit. A probe that
      // FAILS skips the peer: treating it as "new" clobbered overrides.
      const { data: existingPeer, error: probeErr } = await supabase.from('menu_items').select('id').eq('id', peerId).maybeSingle();
      if (probeErr) { console.warn('[setMenuItemScope] could not check the peer row, skipped', peerLocId, probeErr); skippedPeers++; continue; }
      const allowed = new Set(resendFields(newScope, { exists: !!existingPeer, lockPricing: !!(item.lockPricing ?? item.lock_pricing) }));
      // The category must resolve AND exist at the peer, or an existing copy keeps
      // the category it has (round-3 review: the repair path could strip it).
      if (existingPeer && item.cat) {
        let catOk = false;
        if (peerCat) { const { data: pc, error: pcErr } = await supabase.from('menu_categories').select('id').eq('id', peerCat).maybeSingle(); catOk = !pcErr && !!pc; }
        if (!catOk) { allowed.delete('cat'); allowed.delete('cats'); unmappedAll.push(`${peerLocId}|category (left as that venue has it)`); }
      }
      const pick = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => allowed.has(k)));
      const remapped = remapForPeer(item, {
        catIdFor: (c) => peerCatForSourceCatAt(c, peerLocId),
        groupIdFor: (g) => modIdMap.get(g) || `${g}_${peerLocSuffix}`,
        parentIdFor: () => null,
        taxRateIdFor: ids.taxRateIdFor, taxProfileIdFor: ids.taxProfileIdFor, centreIdFor: ids.centreIdFor,
      }, ['option_group_order', 'tax_rate_id', 'tax_profile_id', 'centre_id', 'tax_overrides']);
      const pm = remapPricingMenus(baseRow.pricing, ids.menuIdFor);
      const peerRow = {
        ...pick({ ...baseRow, pricing: pm.pricing }),
        ...pick({ cat: peerCat, cats: peerCats, assigned_modifier_groups: rewriteAssigned(parentAssigned) }),
        ...pick(remapped.fields),
        ...pick(carryResendOnly(item)),
        id: peerId,
        location_id: peerLocId,
        scope: newScope,
        org_id,
        master_id: masterId,
        updated_at: new Date().toISOString(),
      };
      for (const u of [...remapped.unmapped, ...pm.unmapped]) unmappedAll.push(`${peerLocId}|${ids.nameOf(u)}`);
      for (const u of (modIdMap.unmapped || [])) unmappedAll.push(`${peerLocId}|${u}`);
      let { error } = await supabase.from('menu_items').upsert(peerRow);
      if (error && peerRow.item_code && (isDuplicateItemCodeError(error) || isMissingItemCodeColumn(error))) {
        // The peer already uses this code on another product: everything else still travels.
        unmappedAll.push(`${peerLocId}|item code '${peerRow.item_code}' (already used there)`);
        delete peerRow.item_code;
        ({ error } = await supabase.from('menu_items').upsert(peerRow));
      }
      if (error) {
        console.warn('[setMenuItemScope] peer upsert failed for', peerLocId, error);
        skippedPeers++;
        continue; // skip variants for this peer if parent failed
      }
      createdCount++;

      // v5.5.12: replicate variant children. Each variant gets a deterministic
      // id per peer (variantMasterId + peerLocSuffix) and parent_id rewritten
      // to point at THIS peer's parent row.
      for (const v of variants) {
        const vMasterId = v.master_id || v.id;
        const peerVariantId = `${vMasterId}_${peerLocSuffix}`;
        // Variant's own cat: usually inherits parent, occasionally has its own.
        // If it has its own and it's promoted, rewrite. Otherwise inherit
        // peerCat from parent or null.
        const variantPeerCat = v.cat
          ? (peerCatForSourceCat(v.cat, peerLocSuffix) || peerCat || null)
          : null;
        const { data: existingVariant, error: vProbeErr } = await supabase.from('menu_items').select('id').eq('id', peerVariantId).maybeSingle();
        if (vProbeErr) { console.warn('[setMenuItemScope] could not check the peer size, skipped', peerVariantId, vProbeErr); continue; }
        // A size inherits its product's Lock pricing: the product's toggle, not the size's.
        const vAllowed = new Set(resendFields(newScope, { exists: !!existingVariant, lockPricing: !!(item.lockPricing ?? item.lock_pricing) }));
        const vPick = (obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => vAllowed.has(k)));
        const vRemapped = remapForPeer(v, {
          catIdFor: (c) => peerCatForSourceCatAt(c, peerLocId),
          groupIdFor: (g) => modIdMap.get(g) || `${g}_${peerLocSuffix}`,
          parentIdFor: () => null,
          taxRateIdFor: ids.taxRateIdFor, taxProfileIdFor: ids.taxProfileIdFor, centreIdFor: ids.centreIdFor,
        }, ['option_group_order', 'tax_rate_id', 'tax_profile_id', 'centre_id', 'tax_overrides']);
        const vpm = remapPricingMenus(fieldOf(v, 'pricing'), ids.menuIdFor);
        for (const u of [...vRemapped.unmapped, ...vpm.unmapped]) unmappedAll.push(`${peerLocId}|${ids.nameOf(u)} (size ${v.name})`);
        const peerVariantRow = {
          ...vPick({ ...carryVerbatim(v), ...nameColumnsFor(v), ...(vpm.pricing !== undefined ? { pricing: vpm.pricing } : {}) }),
          ...vPick(vRemapped.fields),
          ...vPick(carryResendOnly(v)),
          org_id,
          id: peerVariantId,
          location_id: peerLocId,
          type: v.type ?? 'simple',
          ...vPick({ cat: variantPeerCat, cats: [] }),
          sold_alone: resolveSoldAlone(v),   // never a per-venue override, so always written
          // v5.5.877 (Bug 3): variants can carry their own modifier groups — repoint them too.
          ...vPick({ assigned_modifier_groups: rewriteAssigned(v.assigned_modifier_groups) }),
          scope: newScope,
          master_id: vMasterId,
          parent_id: peerId,
          updated_at: new Date().toISOString(),
        };
        let { error: vErr2 } = await supabase.from('menu_items').upsert(peerVariantRow);
        if (vErr2 && peerVariantRow.item_code && (isDuplicateItemCodeError(vErr2) || isMissingItemCodeColumn(vErr2))) {
          unmappedAll.push(`${peerLocId}|item code '${peerVariantRow.item_code}' (already used there, size ${v.name})`);
          delete peerVariantRow.item_code;
          ({ error: vErr2 } = await supabase.from('menu_items').upsert(peerVariantRow));
        }
        if (vErr2) {
          console.warn('[setMenuItemScope] peer variant upsert failed for', peerLocId, v.id, vErr2);
        } else {
          createdVariants++;
        }
      }
    }

    // v5.5.12: also write scope+master_id onto SOURCE variants so they're
    // marked as shared too (matches the master_id pattern of the parent).
    // Without this, source variants stay scope='local' even after parent is
    // shared — breaking propagateGlobalEdit and confusing the BO list view.
    for (const v of variants) {
      const vMasterId = v.master_id || v.id;
      const { error: vsErr } = await supabase.from('menu_items')
        .update({ scope: newScope, org_id, master_id: vMasterId, updated_at: new Date().toISOString() })
        .eq('id', v.id);
      if (vsErr) console.warn('[setMenuItemScope] source variant scope update error for', v.id, vsErr);
    }
  }

  return { ok: true, partial: skippedPeers > 0, action: isFirstPromotion ? 'promoted' : 'rescoped', createdCount, createdVariants, updatedSiblings, categoryAction, unmapped: unmappedAll, skippedPeers };
};

/**
 * AN EDIT TO A SHARED OR GLOBAL PRODUCT FOLLOWS TO EVERY VENUE (23 Sep 2026).
 *
 * The previous propagateGlobalEdit existed and nothing called it, so "Global"
 * was a label on a one-time copy: Cappucino was Global at Provo and Location 2
 * and a price change at one never reached the other.
 *
 * Global: every field follows. Shared: everything except what a venue may
 * override (pricing, category, image). Per-venue ids are translated for each
 * sibling's venue; a modifier group the sibling does not have yet is copied
 * there first. Never scope, org or master. Returns what happened.
 */
export const propagateScopedEdit = async (fullItem, changedKeys = null) => {
  if (isMock || !supabase || !fullItem?.id) return { ok: true, propagated: 0 };
  const scope = fullItem.scope || 'local';
  // OWNER ONLY. A copy's ids are the master's with a suffix; propagating from a
  // copy would build every id backwards and corrupt the master. Edits made at a
  // peer stay at that peer.
  if (!isMasterRow(fullItem)) return { ok: true, propagated: 0, skipped: 'not-master' };
  const sourceLocId = fullItem.location_id || fullItem.locationId || (await getLocationId());
  if (!sourceLocId) return { ok: true, propagated: 0 };
  // 12/17. A size takes Lock pricing from its PRODUCT; the size's own flag is never set.
  const parentSrc = fullItem.parentId || fullItem.parent_id || null;
  let parentRow = null;
  if (parentSrc) {
    const { data: pr, error: pErr } = await supabase.from('menu_items').select('id, master_id, lock_pricing, archived').eq('id', parentSrc).maybeSingle();
    if (pErr) return { ok: false, propagated: 0, error: pErr };
    parentRow = pr || null;
  }
  const lockPricing = !!(parentRow ? parentRow.lock_pricing : (fullItem.lockPricing ?? fullItem.lock_pricing));
  const fields = propagatedFields(scope, { lockPricing });
  if (!fields.length) return { ok: true, propagated: 0 };
  // 8. Archiving a Shared product is the venue's own decision; propagating from an
  // archived Shared source would detach every peer's sizes into live standalone rows.
  if (scope !== 'global' && fieldOf(fullItem, 'archived')) return { ok: true, propagated: 0, skipped: 'archived-source' };
  const masterId = fullItem.id;

  const { data: siblings, error: sErr } = await supabase.from('menu_items')
    .select('id, location_id').eq('master_id', masterId).neq('id', fullItem.id);
  if (sErr) { console.warn('[propagateScopedEdit] siblings:', sErr); return { ok: false, error: sErr }; }
  if (!siblings?.length) return { ok: true, propagated: 0 };

  const editFields = fields.filter((f) => f !== 'sort_order');   // archived follows for Global (propagatedFields), sort_order never
  const verbatim = { ...carryVerbatim(fullItem, editFields), ...nameColumnsFor(fullItem) };
  if (editFields.includes('archived')) { const ar = fieldOf(fullItem, 'archived'); if (ar !== undefined) verbatim.archived = !!ar; }
  for (const k of Object.keys(verbatim)) if (!editFields.includes(k)) delete verbatim[k];
  const rawGroups = fullItem.assignedModifierGroups ?? fullItem.assigned_modifier_groups;
  const groupIds = (Array.isArray(rawGroups) ? rawGroups : []).map((a) => (typeof a === 'string' ? a : a?.groupId)).filter(Boolean);
  const changed = new Set((changedKeys || []).map((k) => String(k).replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())));
  const groupsTouched = !changedKeys || changed.has('assigned_modifier_groups') || changed.has('option_group_order');
  const { org_id, otherLocationIds } = await memo60(`org:${sourceLocId}`, () => getOrgPeerLocations(sourceLocId));
  const venueNames = new Map();
  try { const { data: ls } = await supabase.from('locations').select('id,name').in('id', otherLocationIds); for (const l of ls || []) venueNames.set(String(l.id), l.name); } catch { /* names are a courtesy */ }

  // Categories: the peer copy must EXIST before its id is written. A shared
  // category missing at the peer is recreated (the Location 2 case); a LOCAL
  // category is promoted the way a share does; if that fails the category is
  // left as the peer has it rather than nulled.
  const catCache = new Map();
  const peerCatId = async (catId, peerLocId) => {
    if (!catId) return null;
    const key = `${catId}|${peerLocId}`;
    if (catCache.has(key)) return catCache.get(key);
    let answer = null;
    try {
      const { data: c } = await supabase.from('menu_categories').select('*').eq('id', catId).maybeSingle();
      if (c) {
        if ((c.scope || 'local') === 'local') await setMenuCategoryScope(c, scope);
        const master = await masterCategoryOf(c);
        const want = peerCatIdAt(master.id, master.location_id, peerLocId);
        const { data: there } = await supabase.from('menu_categories').select('id').eq('id', want).maybeSingle();
        if (!there) await memo60(`cat:${master.id}|${master.scope || scope}`, () => setMenuCategoryScope(master, master.scope || scope));
        const { data: again } = await supabase.from('menu_categories').select('id').eq('id', want).maybeSingle();
        answer = again ? want : null;
      }
    } catch (e) { console.warn('[propagateScopedEdit] category at peer:', e?.message || e); answer = null; }
    catCache.set(key, answer);
    return answer;
  };

  let propagated = 0; const unmapped = []; const failed = [];
  for (const sib of siblings) {
    if (!sib.location_id || sib.location_id === sourceLocId) continue;
    const venue = venueNames.get(String(sib.location_id)) || sib.location_id;
    const suffix = peerSuffixOf(sib.location_id);
    let ids;
    try { ids = await peerIdMapsFor(sourceLocId, sib.location_id); }
    catch (e) { failed.push({ id: sib.id, venue, error: e?.message || String(e) }); continue; }
    // Groups: only when the assignment changed, or a peer copy is missing.
    let modIdMap = new Map();
    if (groupIds.length && editFields.includes('assigned_modifier_groups')) {
      let missing = groupsTouched;
      if (!missing) {
        const { data: have } = await supabase.from('modifier_groups').select('id').in('id', groupIds.map((g) => `${g}_${suffix}`));
        missing = (have || []).length < groupIds.length;
      }
      if (missing) modIdMap = await shareModifierGroupsToLocation(groupIds, sourceLocId, sib.location_id, org_id, scope, 'edit');
    }
    const catIds = new Map(); let catUnknown = false;
    for (const c of [fullItem.cat, ...(Array.isArray(fullItem.cats) ? fullItem.cats : [])].filter(Boolean)) {
      if (!catIds.has(c)) { const v = await peerCatId(c, sib.location_id); catIds.set(c, v); if (!v) catUnknown = true; }
    }
    // 9/15. A size whose parent cannot be resolved keeps the parent the peer has.
    const parentPeer = parentRow ? `${parentRow.master_id || parentRow.id}_${suffix}` : null;
    const peerFields = editFields.filter((f) => f !== 'archived' && !(parentSrc && !parentRow && f === 'parent_id'));
    if (parentSrc && !parentRow) unmapped.push(`${venue}|parent (left as that venue has it)`);
    const remapped = remapForPeer(fullItem, {
      catIdFor: (c) => catIds.get(c) || null,
      groupIdFor: (g) => modIdMap.get(g) || (groupIds.includes(g) ? `${g}_${suffix}` : null),
      parentIdFor: () => parentPeer,
      taxRateIdFor: ids.taxRateIdFor, taxProfileIdFor: ids.taxProfileIdFor, centreIdFor: ids.centreIdFor,
    }, peerFields);
    if (catUnknown) { delete remapped.fields.cat; delete remapped.fields.cats; unmapped.push(`${venue}|category (left as that venue has it)`); }
    for (const u of (modIdMap.unmapped || [])) unmapped.push(`${venue}|${u}`);
    const pm = remapPricingMenus(verbatim.pricing, ids.menuIdFor);
    const patch = { ...verbatim, ...(verbatim.pricing !== undefined ? { pricing: pm.pricing } : {}), ...remapped.fields, updated_at: new Date().toISOString() };
    for (const u of [...remapped.unmapped, ...pm.unmapped]) unmapped.push(`${venue}|${ids.nameOf(u)}`);
    let { data: wrote, error } = await supabase.from('menu_items').update(patch).eq('id', sib.id).select('id');
    if (error && patch.item_code && (isDuplicateItemCodeError(error) || isMissingItemCodeColumn(error))) {
      unmapped.push(`${venue}|item code '${patch.item_code}' (already used there)`);
      delete patch.item_code;
      ({ data: wrote, error } = await supabase.from('menu_items').update(patch).eq('id', sib.id).select('id'));
    }
    // A refusal (RLS) answers with no error and no rows: that is a failure too.
    if (error || !wrote?.length) { failed.push({ id: sib.id, venue, error: error?.message || (error ? String(error) : 'the venue did not accept the change') }); continue; }
    propagated++;
  }
  return { ok: failed.length === 0, propagated, failed, unmapped, error: failed[0]?.error };
};

/**
 * A NEW VENUE GETS EVERY SHARED AND GLOBAL PRODUCT (23 Sep 2026).
 *
 * Peter: "if we add a new location these products hit that location also".
 * A venue is a peer the moment it exists, so every master in the organisation
 * that has no copy here yet is re-sent by its owner. Categories and modifier
 * groups come with it, exactly as a share does. Sequential, like the bulk strip.
 */
export const listSharedMastersMissingAt = async (locationId) => {
  if (isMock || !supabase || !locationId) return [];
  const { data: here } = await supabase.from('locations').select('org_id').eq('id', locationId).maybeSingle();
  if (!here?.org_id) return [];
  const { data: peers } = await supabase.from('locations').select('id').eq('org_id', here.org_id).neq('id', locationId);
  const peerIds = (peers || []).map((l) => l.id);
  if (!peerIds.length) return [];
  const { data: masters, error } = await supabase.from('menu_items').select('*')
    .in('location_id', peerIds).in('scope', ['shared', 'global']).is('parent_id', null).eq('archived', false).limit(2000);
  if (error) { console.warn('[listSharedMastersMissingAt]', error); return []; }
  const suffix = peerSuffixOf(locationId);
  const wantIds = (masters || []).map((m) => `${m.master_id || m.id}_${suffix}`);
  const present = [];
  for (let i = 0; i < wantIds.length; i += 200) {
    const { data } = await supabase.from('menu_items').select('id').in('id', wantIds.slice(i, i + 200));
    for (const r of data || []) present.push(r.id);
  }
  return missingMasters(masters, present, locationId);
};

export const pullSharedProductsTo = async (locationId, { onProgress, shouldStop } = {}) => {
  const targets = await listSharedMastersMissingAt(locationId);
  if (!targets.length) return { total: 0, done: 0, ok: [], failed: [], promoted: 0, rescoped: 0, demoted: 0, copies: 0, stopped: false };
  clearShareMemos();
  // Each master is re-sent by its OWNER (setMenuItemScope runs from the master row),
  // which copies it to every peer including this one.
  return runBulkScope({ targets, scope: null, setScope: (m) => setMenuItemScope(m, m.scope), onProgress, shouldStop });
};

/**
 * AN EDIT TO A MODIFIER GROUP FOLLOWS TO ITS COPIES AT OTHER VENUES (23 Sep 2026).
 *
 * A group copied by sharing lives at the peer as `<id>_<venue suffix>`. Its
 * name, min, max, selection type, order and every option (with nested groups
 * and sold-alone sub-items pointed at the peer's copies) are refreshed. A group
 * that was never shared has no copies and nothing happens. Runs from the
 * OWNING venue only: a copy's id already carries a suffix.
 */
export const propagateModifierGroupEdit = async (group) => {
  if (isMock || !supabase || !group?.id) return { ok: true, propagated: 0 };
  const sourceLocId = group.location_id || group.locationId || getActiveLocationSync() || (await getLocationId());
  if (!sourceLocId) return { ok: true, propagated: 0 };
  const { org_id, otherLocationIds } = await getOrgPeerLocations(sourceLocId);
  if (!org_id || !otherLocationIds.length) return { ok: true, propagated: 0 };
  // A copy of a group is `<id>_<suffix of THIS venue>`; only the owner propagates.
  if (new RegExp(`_${peerSuffixOf(sourceLocId)}$`).test(String(group.id))) return { ok: true, propagated: 0, skipped: 'not-master' };
  const peerIds = otherLocationIds.map((l) => `${group.id}_${peerSuffixOf(l)}`);
  const { data: copies, error } = await supabase.from('modifier_groups').select('id, location_id').in('id', peerIds);
  if (error) { console.warn('[propagateModifierGroupEdit] copies:', error); return { ok: false, error }; }
  // The sub-items copied with the group take a scope. Use the widest scope of any
  // source product carrying this group, so a Global product's sub-items stay Global.
  const { data: carriers } = await supabase.from('menu_items').select('scope, assigned_modifier_groups')
    .eq('location_id', sourceLocId).in('scope', ['shared', 'global']).limit(500);
  const usesGroup = (row) => (Array.isArray(row?.assigned_modifier_groups) ? row.assigned_modifier_groups : [])
    .some((a) => (typeof a === 'string' ? a : a?.groupId) === group.id);
  const scope = (carriers || []).some((r) => r.scope === 'global' && usesGroup(r)) ? 'global' : 'shared';
  let propagated = 0;
  for (const copy of copies || []) {
    // shareModifierGroupsToLocation upserts the group AND its nested groups and
    // sub-items at that venue with every option rule intact, which is exactly a refresh.
    const idMap = await shareModifierGroupsToLocation([group.id], sourceLocId, copy.location_id, org_id, scope, 'edit');
    if (idMap.has(group.id)) propagated++;
  }
  return { ok: true, propagated };
};



// ──────────────────────────────────────────────────────────────────
// v4.7.3 — Category promote/demote, mirrors setMenuItemScope.
// ──────────────────────────────────────────────────────────────────

export const setMenuCategoryScope = async (cat, newScope, _visited = new Set()) => {
  if (isMock) return { ok: true };
  if (!supabase) return { ok: false, error: 'no supabase' };
  if (!cat?.id) return { ok: false, error: 'no cat id' };
  if (!['local', 'shared', 'global'].includes(newScope)) return { ok: false, error: 'invalid scope' };

  const currentScope = cat.scope || 'local';
  // A COPY redirects to its master (round-2 review, 23 Sep): every peer id is
  // <master>_<suffix>, and the owner's own row is the bare master id. Sharing
  // from a copy addressed the owner with a suffixed id and created a duplicate.
  if (newScope !== 'local' && !isMasterRow(cat)) {
    const master = await masterCategoryOf(cat);
    if (master && master.id !== cat.id) return setMenuCategoryScope(master, newScope, _visited);
  }
  const sourceLocId = cat.location_id || (await getLocationId());
  if (!sourceLocId) return { ok: false, error: 'no location id' };

  if (newScope === 'local') {
    const { error } = await supabase.from('menu_categories')
      .update({ scope: 'local', org_id: null, master_id: null, updated_at: new Date().toISOString() })
      .eq('id', cat.id);
    if (error) { console.error('[setMenuCategoryScope] demote error:', error); return { ok: false, error }; }
    return { ok: true, action: 'demoted', affected: 1 };
  }

  const { org_id, otherLocationIds } = await getOrgPeerLocations(sourceLocId);
  if (!org_id) return { ok: false, error: 'this location is not in an org — cannot share' };

  const masterId = cat.master_id || cat.id;
  const isFirstPromotion = currentScope === 'local';

  const sourcePatch = { scope: newScope, org_id, master_id: masterId, updated_at: new Date().toISOString() };
  const { error: e1 } = await supabase.from('menu_categories').update(sourcePatch).eq('id', cat.id);
  if (e1) { console.error('[setMenuCategoryScope] source update error:', e1); return { ok: false, error: e1 }; }

  let createdCount = 0;
  let updatedSiblings = 0;

  // 23 Sep 2026: re-sharing used to flip scope on sibling categories and stop.
  // Location 2 had 7 shared products pointing at a category that did not exist
  // there. The peer loop below now runs every time: upsert creates what is
  // missing and refreshes what is there (a peer's own photo is still kept).
  if (!isFirstPromotion) {
    const { error, count } = await supabase.from('menu_categories')
      .update({ scope: newScope, updated_at: new Date().toISOString() }, { count: 'exact' })
      .eq('master_id', masterId)
      .neq('id', cat.id);
    if (error) console.warn('[setMenuCategoryScope] sibling rescope error:', error);
    else updatedSiblings = count || 0;
  }
  {
    _visited.add(cat.id);
    // v5.5.877 (Bug 2, hierarchy): if this is a SUB-category, promote its parent
    // first so the peer sub-category can nest under the peer parent instead of
    // being flattened to a root. Bounded by _visited — category trees are acyclic,
    // and this also guards against corrupt self-referential data.
    let parentMasterId = null;
    let parentMasterLocId = null;
    const srcParentId = cat.parent_id ?? cat.parentId ?? null;
    if (srcParentId && !_visited.has(srcParentId)) {
      try {
        const { data: parentCat } = await supabase.from('menu_categories').select('*')
          .eq('id', srcParentId).eq('location_id', sourceLocId).maybeSingle();
        if (parentCat) {
          // 23 Sep 2026: always, so a missing peer PARENT is recreated before the
          // sub category is written pointing at it.
          await setMenuCategoryScope(parentCat, (parentCat.scope || 'local') === 'local' ? newScope : parentCat.scope, _visited);
          const { data: pFresh } = await supabase.from('menu_categories')
            .select('master_id, id').eq('id', srcParentId).maybeSingle();
          parentMasterId = pFresh?.master_id || pFresh?.id || parentCat.id;
          const pm = await masterCategoryOf({ id: srcParentId, master_id: parentMasterId });
          parentMasterLocId = pm?.location_id || null;
        }
      } catch (e) { console.warn('[setMenuCategoryScope] parent promote threw:', e?.message || e); }
    }

    // The menu the category comes from (a sub category with none uses its parent's), used to
    // name the menu a venue with no menu gets.
    let sourceMenuId = cat.menu_id ?? cat.menuId ?? null;
    if (!sourceMenuId && srcParentId) {
      try {
        const { data: p } = await supabase.from('menu_categories').select('menu_id').eq('id', srcParentId).maybeSingle();
        sourceMenuId = p?.menu_id || null;
      } catch { sourceMenuId = null; }
    }

    const baseRow = {
      label: cat.label,
      icon: cat.icon ?? null,
      color: cat.color ?? null,
      accounting_group: cat.accounting_group ?? cat.accountingGroup ?? '',
      sort_order: cat.sort_order ?? cat.sortOrder ?? 0,
      is_special: cat.is_special ?? cat.isSpecial ?? false,
      default_course: cat.default_course ?? cat.defaultCourse ?? 1,
      spacer_slots: cat.spacer_slots ?? cat.spacerSlots ?? [],
      scope: newScope,
      org_id,
      master_id: masterId,
      lock_pricing: cat.lock_pricing ?? cat.lockPricing ?? false,
      // v5.8.65: the photo is shared with the category (decision 4). Only when the
      // source row has one, so a pre-migration row never sends an unknown column.
      ...categoryImageField(cat),
      updated_at: new Date().toISOString(),
    };
    for (const peerLocId of otherLocationIds) {
      if (peerLocId === sourceLocId) continue;   // the owner's own row is the master; never a suffixed copy
      const peerSuffix = peerLocId.slice(-8);
      const peerId = `${masterId}_${peerSuffix}`;
      // v5.5.877 (Bug 2): give the peer category real MENU MEMBERSHIP. The old
      // code wrote menu_id:null with NO menu_category_links row, so on every
      // surface that pins a menu (POS/Bar/Kiosk/Online/Catering) the peer category
      // — and therefore the shared item inside it — was invisible; it only showed
      // on MPOS (its null-menu escape hatch) or when no menu was pinned. Attach the
      // peer category to the peer location's default menu (or its first menu) via
      // BOTH menu_id and a link row: read paths accept either, so writing both is
      // robust to convention drift. parent_id is rewritten to the peer parent so
      // sub-categories stay nested rather than flattening to roots.
      // v5.8.73: a venue with no menu gets one (ensurePeerMenu), never a category on no menu.
      const peerMenuId = await ensurePeerMenu(peerLocId, sourceMenuId, org_id);
      const peerParentId = parentMasterId ? peerCatIdAt(parentMasterId, parentMasterLocId, peerLocId) : null;
      const peerRow = { ...baseRow, id: peerId, location_id: peerLocId, menu_id: peerMenuId, parent_id: peerParentId };
      // v5.8.65: sharing again (local, then shared) reuses the same peer ids. A peer venue
      // that added its OWN photo meanwhile keeps it: the photo is only sent to a peer row
      // that has none (same rule as peerPhotoTargets). If the check fails, leave it alone.
      // 23 Sep 2026: a peer category that already exists keeps its own photo,
      // its menu, its parent when the source has none, and (Shared) its order.
      // Only a missing one is created and linked to a menu.
      const { data: existingPeer, error: exErr } = await supabase
        .from('menu_categories').select('id,image,menu_id,parent_id,sort_order').eq('id', peerId).maybeSingle();
      if (exErr) { console.warn('[setMenuCategoryScope] could not check the peer category, skipped', peerLocId, exErr); continue; }
      if (existingPeer) {
        if (categoryPhotoUrl(existingPeer)) delete peerRow.image;
        if (existingPeer.menu_id) peerRow.menu_id = existingPeer.menu_id;
        if (!peerParentId && existingPeer.parent_id) peerRow.parent_id = existingPeer.parent_id;
        if (newScope !== 'global' && existingPeer.sort_order != null) peerRow.sort_order = existingPeer.sort_order;
      }
      const { error } = await supabase.from('menu_categories').upsert(peerRow);
      if (error) { console.warn('[setMenuCategoryScope] peer upsert failed for', peerLocId, error); continue; }
      createdCount++;
      if (peerMenuId && !(existingPeer && existingPeer.menu_id)) {
        const linkRes = await linkCategoryToMenu(peerMenuId, peerId, baseRow.sort_order ?? 0);
        if (!linkRes?.ok) console.warn('[setMenuCategoryScope] peer menu link failed for', peerLocId, linkRes?.error);
      }
    }
  }

  return { ok: true, action: isFirstPromotion ? 'promoted' : 'rescoped', createdCount, updatedSiblings };
};


// ──────────────────────────────────────────────────────────────────
// v4.7.4 — Category ↔ Menu join helpers
//
// menu_categories.menu_id is kept as the legacy "primary menu" pointer
// (unchanged when a cat is created via the existing flow). The new
// menu_category_links table (added by v4.6.0 migration) holds
// additional menu memberships, enabling one category to appear in
// many menus without duplication.
//
// At read time, a cat is considered "in menu M" if either:
//   - cat.menu_id === M, OR
//   - a row exists in menu_category_links with (menu_id=M, category_id=cat.id)
// ──────────────────────────────────────────────────────────────────

export const fetchMenuCategoryLinks = async (locationId = null) => {
  if (isMock) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || !supabase) return { data: [], error: null };
  // Pull all link rows whose menu belongs to this location. menu_category_links
  // doesn't have a location_id column, so we join via menus.
  const { data: locMenus, error: e1 } = await supabase
    .from('menus').select('id').eq('location_id', locationId);
  if (e1) return { data: [], error: e1 };
  if (!locMenus?.length) return { data: [], error: null };
  const menuIds = locMenus.map(m => m.id);
  return await supabase
    .from('menu_category_links')
    .select('menu_id, category_id, sort_order')
    .in('menu_id', menuIds);
};

export const linkCategoryToMenu = async (menuId, categoryId, sortOrder = 0) => {
  if (isMock) return { ok: true };
  if (!supabase) return { ok: false, error: 'no supabase' };
  if (!menuId || !categoryId) return { ok: false, error: 'menuId and categoryId required' };
  const { error } = await supabase
    .from('menu_category_links')
    .upsert({ menu_id: menuId, category_id: categoryId, sort_order: sortOrder }, { onConflict: 'menu_id,category_id' });
  if (error) { console.error('[linkCategoryToMenu]', error); return { ok: false, error }; }
  return { ok: true };
};

export const unlinkCategoryFromMenu = async (menuId, categoryId) => {
  if (isMock) return { ok: true };
  if (!supabase) return { ok: false, error: 'no supabase' };
  if (!menuId || !categoryId) return { ok: false, error: 'menuId and categoryId required' };
  const { error } = await supabase
    .from('menu_category_links')
    .delete()
    .eq('menu_id', menuId)
    .eq('category_id', categoryId);
  if (error) { console.error('[unlinkCategoryFromMenu]', error); return { ok: false, error }; }
  return { ok: true };
};

// ── Discounts ─────────────────────────────────────────────────────────────────

export const fetchDiscounts = async (locationId = null) => {
  if (isMock) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No location') };
  return supabase
    .from('discounts')
    .select('*')
    .eq('location_id', locationId)
    .order('sort_order');
};

export const fetchActiveDiscounts = async (locationId = null) => {
  if (isMock) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No location') };
  return supabase
    .from('discounts')
    .select('*')
    .eq('location_id', locationId)
    .eq('active', true)
    .order('sort_order');
};

export const upsertDiscount = async (discount, locationId = null) => {
  if (isMock) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No location') };
  const dbRow = {
    id:               discount.id,
    location_id:      locationId,
    name:             discount.name || 'Discount',
    type:             discount.type || 'percent',
    value:            discount.value ?? 0,
    scope:            discount.scope || 'global',
    category_ids:     discount.categoryIds || discount.category_ids || [],
    requires_manager: discount.requiresManager ?? discount.requires_manager ?? false,
    active:           discount.active ?? true,
    sort_order:       discount.sortOrder ?? discount.sort_order ?? 0,
    updated_at:       new Date().toISOString(),
  };
  const result = await supabase.from('discounts').upsert(dbRow, { onConflict: 'id' });
  if (result.error) console.error('[DB] discounts upsert failed:', result.error.message);
  return result;
};

export const deleteDiscount = async (id) => {
  if (isMock) return { data: null, error: null };
  // v5.5.279: location_id guard — never delete across tenants
  const locationId = getActiveLocationSync() || await getLocationId();
  return supabase.from('discounts').delete().eq('id', id).eq('location_id', locationId);
};

// ── Auto-discount rules ──────────────────────────────────────────────────────

export const fetchDiscountRules = async (locationId = null) => {
  if (isMock) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No location') };
  return supabase
    .from('discount_rules')
    .select('*')
    .eq('location_id', locationId)
    .order('priority', { ascending: false });
};

export const fetchActiveDiscountRules = async (locationId = null) => {
  if (isMock) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No location') };
  return supabase
    .from('discount_rules')
    .select('*')
    .eq('location_id', locationId)
    .eq('active', true)
    .order('priority', { ascending: false });
};

export const upsertDiscountRule = async (rule, locationId = null) => {
  if (isMock) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No location') };
  const dbRow = {
    id:                   rule.id,
    location_id:          locationId,
    name:                 rule.name || 'Auto discount',
    active:               rule.active ?? true,
    trigger_type:         rule.triggerType || rule.trigger_type || 'buy_x',
    trigger_category_ids: rule.triggerCategoryIds || rule.trigger_category_ids || [],
    trigger_qty:          rule.triggerQty ?? rule.trigger_qty ?? 2,
    reward_type:          rule.rewardType || rule.reward_type || 'percent',
    reward_value:         rule.rewardValue ?? rule.reward_value ?? 0,
    reward_qty:           rule.rewardQty ?? rule.reward_qty ?? 1,
    reward_category_ids:  rule.rewardCategoryIds || rule.reward_category_ids || [],
    channels:             rule.channels || { pos: true, online: true, qr: true, kiosk: true },
    trigger_groups:       rule.triggerGroups || rule.trigger_groups || null,
    schedule:             rule.schedule || null,
    priority:             rule.priority ?? 0,
    sort_order:           rule.sortOrder ?? rule.sort_order ?? 0,
    updated_at:           new Date().toISOString(),
  };
  const result = await supabase.from('discount_rules').upsert(dbRow, { onConflict: 'id' });
  if (result.error) console.error('[DB] discount_rules upsert failed:', result.error.message);
  return result;
};

export const deleteDiscountRule = async (id) => {
  if (isMock) return { data: null, error: null };
  // v5.5.279: location_id guard — never delete across tenants
  const locationId = getActiveLocationSync() || await getLocationId();
  return supabase.from('discount_rules').delete().eq('id', id).eq('location_id', locationId);
};

// ── Stock levels (v5.5.239) ──────────────────────────────────────────────────
// Cross-device stock tracking. Replaces in-memory-only dailyCounts with a
// Supabase-backed source of truth synced via Realtime.

export const fetchStockLevels = async (locationId = null) => {
  if (isMock) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return { data: [], error: null };
  return supabase.from('stock_levels').select('item_id, par, remaining').eq('location_id', locationId);
};

export const upsertStockLevel = async (itemId, par, remaining = null, locationId = null) => {
  if (isMock) return { data: null, error: null };
  // TRAINING MODE: don't overwrite real daily stock counts / par levels.
  if (isTrainingMode()) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') {
    console.error('[upsertStockLevel] could not resolve locationId');
    return { data: null, error: new Error('No locationId') };
  }
  return supabase.from('stock_levels').upsert({
    location_id: locationId,
    item_id: itemId,
    par: par,
    remaining: remaining ?? par,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'location_id,item_id' });
};

export const deleteStockLevel = async (itemId, locationId = null) => {
  if (isMock) return { data: null, error: null };
  // TRAINING MODE: don't delete real stock-level tracking.
  if (isTrainingMode()) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No locationId') };
  return supabase.from('stock_levels').delete().eq('location_id', locationId).eq('item_id', itemId);
};

export const decrementStockRPC = async (itemId, qty = 1, locationId = null) => {
  if (isMock) return { data: { tracked: false }, error: null };
  // TRAINING MODE: never move real stock. Covers POS, kiosk and online paths.
  if (isTrainingMode()) return { data: { tracked: false }, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return { data: { tracked: false }, error: null };
  return supabase.rpc('decrement_stock', { p_location_id: locationId, p_item_id: itemId, p_qty: qty });
};

export const restoreStockRPC = async (itemId, qty = 1, locationId = null) => {
  if (isMock) return { data: { tracked: false }, error: null };
  // TRAINING MODE: nothing was decremented, so don't touch real stock.
  if (isTrainingMode()) return { data: { tracked: false }, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return { data: { tracked: false }, error: null };
  return supabase.rpc('restore_stock', { p_location_id: locationId, p_item_id: itemId, p_qty: qty });
};
