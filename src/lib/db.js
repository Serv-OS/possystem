/**
 * db.js — Supabase data layer
 *
 * Each function wraps a Supabase query and returns { data, error }.
 * Called by store actions and React components.
 * When supabase is null (mock mode), returns { data: null, error }.
 *
 * All queries are scoped to a location_id for multi-tenancy.
 */

import { supabase, isMock, getLocationId } from './supabase';
import { getTodayStartFallback } from './locationTime';

// ── Order number generation (v5.5.8) ─────────────────────────────────────────
// Replaces three pre-existing colliding ref generators (kiosk Date.now() % 1000,
// POS Math.random()*9000, in-memory ++_orderNum) with a single atomic per-location
// counter cycling R1-R99.
//
// Primary path: server-side SQL function next_order_number(p_location_id) — atomic
// via INSERT ON CONFLICT on the location_order_counters row. Returns 'R<n>'.
//
// Fallback path: if the function doesn't exist (migration not applied yet), or
// if there's no network, we use a per-tab in-memory counter seeded from
// localStorage. This is per-device only — two devices at the same location may
// briefly issue the same number until the migration is in place. Significantly
// better than the old generators (no random collisions, no second-of-millis
// collisions) but not as good as the DB path.
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
  const next = (cur % 99) + 1;
  _localCounterMemo = next;
  try { localStorage.setItem('rpos-order-counter-fallback', String(next)); } catch (e) { void e; }
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
        console.warn('[getNextOrderRef] RPC next_order_number failed:', error.message, '— using local fallback. Apply v5.5.8 migration to fix.');
      }
    } catch (e) {
      console.warn('[getNextOrderRef] RPC threw:', e?.message, '— using local fallback');
    }
  }
  // Fallback path — local counter, persisted to localStorage so it survives reloads.
  // Each device at the same location runs its own counter; collisions possible if
  // two devices both fire orders before the migration is applied. Acceptable
  // short-term as an upgrade from Date.now()%1000 / Math.random().
  return 'R' + _bumpLocalCounter();
};

// v5.5.8: synchronous variant for callers that can't go async without major
// refactoring (recordClosedCheck, recordWalkInClosed, recordWalkInClosedCheck —
// these are called from React handlers that read store state immediately after,
// so awaiting inside them breaks the read-after-write timing). Returns 'R<n>'
// from the local counter, persisted to localStorage. No DB call.
//
// Tradeoff: per-device counter, so two devices at the same location can briefly
// issue the same number while at the same point in their independent 1-99 cycles
// (~1% collision rate). For single-device shops this is identical to the atomic
// DB path. Multi-device shops should run the v5.5.8 migration AND we'll move POS
// callers to async getNextOrderRef in a follow-up commit.
//
// In any case this is dramatically better than what we replaced:
//   kiosk  Date.now() % 1000 → collides every 1 second
//   POS    Math.random()*9000 → birthday-paradox collisions at ~95 orders
export function getNextOrderRefLocal() {
  return 'R' + _bumpLocalCounter();
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
  return supabase.from('menu_categories').select('*').eq('location_id', locationId).order('sort_order');
};

export const upsertMenuCategory = async (cat, locationId = null) => {
  if (isMock) return { data: null, error: null };
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId();
  if (!locationId || locationId === 'loc-demo') return { data: null, error: new Error('No location') };
  const result = await supabase.from('menu_categories').upsert({
    ...cat,
    location_id: locationId,
    parent_id: cat.parentId ?? cat.parent_id ?? null,
    menu_id: cat.menuId ?? cat.menu_id ?? null,
    sort_order: cat.sortOrder ?? cat.sort_order ?? 0,
    default_course: cat.defaultCourse ?? cat.default_course ?? 1,
    spacer_slots: cat.spacerSlots ?? cat.spacer_slots ?? [],
    updated_at: new Date().toISOString(),
  });
  if (result.error) console.error('[DB] menu_categories upsert failed:', result.error.message);
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
  const dbItem = {
    id:           item.id,
    location_id:  locationId,
    name:         _displayName,
    menu_name:    _displayName,
    receipt_name: item.receiptName || item.receipt_name || _displayName,
    kitchen_name: item.kitchenName || item.kitchen_name || _displayName,
    description:  item.description || '',
    type:         item.type        || 'simple',
    cat:          item.cat         || null,
    cats:         item.cats        || [],
    parent_id:    item.parentId !== undefined ? item.parentId : (item.parent_id !== undefined ? item.parent_id : null),
    sort_order:   item.sortOrder   ?? item.sort_order   ?? 0,
    pricing,
    allergens:    item.allergens   || [],
    assigned_modifier_groups:    item.assignedModifierGroups    || item.assigned_modifier_groups    || [],
    assigned_instruction_groups: item.assignedInstructionGroups || item.assigned_instruction_groups || [],
    visibility:   item.visibility  || { pos: true, kiosk: true, online: true },
    sold_alone:   item.soldAlone   ?? item.sold_alone   ?? true,
    archived:     item.archived    ?? false,
    centre_id:    item.centreId    || item.centre_id    || null,
    tax_rate_id:  item.taxRateId   || item.tax_rate_id  || null,
    tax_overrides: item.taxOverrides || item.tax_overrides || {},
    image:        item.image || null,
    // v4.6.3: ownership / sharing fields (added by v4.6.0 schema migration)
    scope:           item.scope          || item.ownership_scope || 'local',
    org_id:          item.orgId          ?? item.org_id          ?? null,
    master_id:       item.masterId       ?? item.master_id       ?? null,
    lock_pricing:    item.lockPricing    ?? item.lock_pricing    ?? false,
    locked_fields:   item.lockedFields   ?? item.locked_fields   ?? [],
    updated_at:   new Date().toISOString(),
  };

  const result = await supabase.from('menu_items').upsert(dbItem, { onConflict: 'id' });
  if (result.error) console.error('[DB] menu_items upsert failed:', result.error.message, 'item:', item.id);
  return result;
};

export const archiveMenuItem = async (id) => {
  if (isMock) return { data: null, error: null };
  return supabase.from('menu_items').update({ archived: true, updated_at: new Date().toISOString() }).eq('id', id);
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

export const insertKDSTicket = async (ticket, locationId = null) => {
  if (isMock) return { data: null, error: null };
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

  // v4.3 — durable send: if the network/Supabase fails, queue the write to
  // IndexedDB so it replays when the device comes back online. No lost tickets.
  const handleFailure = async (err) => {
    try {
      const { queueWrite } = await import('../sync/OfflineQueue');
      await queueWrite({ type: 'upsert', table: 'kds_tickets', payload: row, onConflict: 'id' });
      console.warn('[KDS] Send failed, queued for retry:', err?.message || err);
    } catch (qe) {
      console.error('[KDS] CRITICAL: send failed AND queueing failed:', qe?.message || qe);
    }
  };

  try {
    const res = await supabase.from('kds_tickets').insert(row);
    if (res?.error) await handleFailure(res.error);
    return res;
  } catch (err) {
    await handleFailure(err);
    return { data: null, error: err };
  }
};

export const bumpKDSTicket = async (id) => {
  if (isMock) return { data: null, error: null };
  return supabase.from('kds_tickets').update({ status: 'bumped', bumped_at: new Date().toISOString() }).eq('id', id);
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

  const row = {
    id:           check.id,
    location_id:  locationId,
    ref:          check.ref,
    server:       check.server,
    staff_id:     check.staffId   || null,   // v4.6.19 — FK to staff_members.id
    covers:       check.covers,
    order_type:   check.orderType,
    customer:     check.customer,
    items:        check.items,
    discounts:    check.discounts,
    subtotal:     check.subtotal,
    service:      check.service,
    tip:          check.tip,
    tax_amount:   check.taxAmount != null ? check.taxAmount : null,  // v4.6.19 — stored explicitly
    total:        check.total,
    method:       check.method,
    drawer_id:    check.drawerId || null,   // v4.6.37
    shift_id:     check.shiftId  || null,   // v4.6.37
    closed_at:    check.closedAt ? new Date(check.closedAt).toISOString() : new Date().toISOString(),
    status:       check.status || 'paid',
    refunds:      check.refunds || [],
    table_id:     check.tableId || null,
    table_label:  check.tableLabel || null,
    gift_card:    check.giftCard || null,   // v5.5.217: gift card reversal on refund
    loyalty:      check.loyalty  || null,   // v5.5.218: loyalty points summary (earn/redeem)
  };

  // Use DataSafe triple-write: localStorage → Supabase (queued if offline)
  const { safeInsertClosedCheck } = await import('../sync/DataSafe.js');
  return safeInsertClosedCheck(check, row);
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
    const { error } = await supabase
      .from('closed_checks')
      .update({ refunds: refunds || [], status: status || 'paid' })
      .eq('id', checkId);
    if (error) {
      console.warn('[DB] updateClosedCheckRefunds failed:', error.message);
      return { ok: false, error };
    }
    return { ok: true };
  } catch (e) {
    console.warn('[DB] updateClosedCheckRefunds error:', e?.message);
    return { ok: false, error: e };
  }
};

export const fetchClosedChecks = async (locationId = null, limit = 500, sinceDate = null) => {
  if (isMock) return { data: null, error: null };
  // Use provided date or fall back to today's start (will be refined by locationTime once config loads)
  const since = sinceDate || getTodayStartFallback();
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
      orderType: c.order_type, customer: c.customer,
      items: c.items || [], discounts: c.discounts || [],
      subtotal: c.subtotal, service: c.service, tip: c.tip, total: c.total,
      taxAmount: c.tax_amount,
      method: c.method,
      closedAt: c.closed_at ? new Date(c.closed_at).getTime() : null,
      status: c.status, refunds: c.refunds || [],
      tableId: c.table_id, tableLabel: c.table_label,
      giftCard: c.gift_card || null,
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
      orderType: c.order_type, customer: c.customer,
      items: c.items || [], discounts: c.discounts || [],
      subtotal: c.subtotal, service: c.service, tip: c.tip, total: c.total,
      taxAmount: c.tax_amount,
      method: c.method,
      closedAt: c.closed_at ? new Date(c.closed_at).getTime() : null,
      status: c.status, refunds: c.refunds || [],
      tableId: c.table_id, tableLabel: c.table_label,
      giftCard: c.gift_card || null,
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
  const result = await supabase.from('config_pushes').insert({ ...push, location_id: locationId });
  if (result.error) console.error('[DB] config_pushes insert failed:', result.error.message);
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
  return supabase.from('devices').update({ status: 'online', last_seen: new Date().toISOString() }).eq('id', deviceId);
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

  // Try the junction table first (v4.6.22+)
  const junction = await supabase
    .from('user_locations')
    .select('role, location_id, locations(id, name, timezone)')
    .eq('user_id', userId);

  if (!junction.error && junction.data?.length) {
    return {
      data: junction.data
        .filter(r => r.locations)
        .map(r => ({
          id: r.locations.id,
          name: r.locations.name,
          timezone: r.locations.timezone,
          role: r.role,
        })),
      error: null,
    };
  }

  // Fallback for pre-v4.6.22 schemas OR users not yet seeded: read single
  // location from user_profiles.
  const profile = await supabase
    .from('user_profiles')
    .select('location_id, locations(id, name, timezone)')
    .eq('id', userId)
    .single();

  if (profile.data?.locations) {
    return {
      data: [{
        id: profile.data.locations.id,
        name: profile.data.locations.name,
        timezone: profile.data.locations.timezone,
        role: 'manager',
      }],
      error: null,
    };
  }
  return { data: [], error: null };
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
 * Promote a local item to shared (or global). Creates copies at every other
 * location in the org. Source row gets master_id = source.id; copies share
 * the same master_id. Each copy gets a deterministic id <masterId>_<locShort>.
 *
 * If the item is already shared/global, just changes scope on all linked rows.
 * If demoting (newScope = 'local'), only clears flags on the source row.
 */
export const setMenuItemScope = async (item, newScope) => {
  if (isMock) return { ok: true };
  if (!supabase) return { ok: false, error: 'no supabase' };
  if (!item?.id) return { ok: false, error: 'no item id' };
  if (!['local', 'shared', 'global'].includes(newScope)) return { ok: false, error: 'invalid scope' };

  const currentScope = item.scope || 'local';
  const sourceLocId = item.location_id || (await getLocationId());
  if (!sourceLocId) return { ok: false, error: 'no location id' };

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
  if (newScope !== 'local' && item.cat) {
    try {
      const { data: catRow } = await supabase.from('menu_categories').select('*').eq('id', item.cat).maybeSingle();
      if (catRow) {
        if ((catRow.scope || 'local') === 'local') {
          const catResult = await setMenuCategoryScope(catRow, newScope);
          if (catResult.ok) categoryAction = catResult.action;
          else console.warn('[setMenuItemScope] cat auto-promote failed:', catResult.error);
        }
        // Re-fetch to get fresh master_id (setMenuCategoryScope just wrote it)
        const { data: catFresh } = await supabase.from('menu_categories').select('master_id, id').eq('id', item.cat).maybeSingle();
        const catMasterId = catFresh?.master_id || catFresh?.id || catRow.id;
        catMasterIdByCatId.set(catRow.id, catMasterId);
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
        if ((catRow.scope || 'local') === 'local') {
          await setMenuCategoryScope(catRow, newScope);
        }
        const { data: catFresh } = await supabase.from('menu_categories').select('master_id, id').eq('id', catId).maybeSingle();
        const catMasterId = catFresh?.master_id || catFresh?.id || catRow.id;
        catMasterIdByCatId.set(catRow.id, catMasterId);
      } catch (e) {
        console.warn('[setMenuItemScope] cats[] auto-promote threw for', catId, ':', e?.message || e);
      }
    }
  }
  // Helper: peer cat id from a master-id given the peer location's suffix.
  const peerCatIdFor = (catMasterId, peerLocSuffix) => `${catMasterId}_${peerLocSuffix}`;
  // Translate a source-side cat id to the peer-side cat id at a given peer location.
  const peerCatForSourceCat = (sourceCatId, peerLocSuffix) => {
    if (!sourceCatId) return null;
    const cmid = catMasterIdByCatId.get(sourceCatId);
    return cmid ? peerCatIdFor(cmid, peerLocSuffix) : null;
  };

  let createdCount = 0;
  let createdVariants = 0;
  let updatedSiblings = 0;

  if (isFirstPromotion) {
    // v5.5.12: also fetch variant children (rows with parent_id = item.id) so
    // we can replicate them at each peer location with rewritten parent_id.
    // Without this, parent items of type='variants' got copied without any
    // children, leaving an unselectable parent at the peer location.
    let variants = [];
    if (item.type === 'variants') {
      const { data: vData, error: vErr } = await supabase
        .from('menu_items')
        .select('*')
        .eq('parent_id', item.id)
        .eq('archived', false);
      if (vErr) {
        console.warn('[setMenuItemScope] variant fetch error:', vErr);
      } else {
        variants = vData || [];
      }
    }

    // 2) First-time promotion: copy this item to every peer location.
    //    Build a deterministic id per peer so re-promoting later is idempotent.
    const baseRow = {
      // Take the relevant editable fields from the source item
      name: item.name,
      menu_name: item.menu_name ?? item.menuName ?? null,
      receipt_name: item.receipt_name ?? item.receiptName ?? null,
      kitchen_name: item.kitchen_name ?? item.kitchenName ?? null,
      description: item.description ?? null,
      type: item.type ?? 'simple',
      pricing: item.pricing ?? { base: item.price ?? 0 },
      // v4.7.1 fix: 'price' column does NOT exist on menu_items — only 'pricing' jsonb.
      // Including it caused PGRST204 "column not found" error which silently failed every promote.
      allergens: item.allergens ?? [],
      assigned_modifier_groups: item.assignedModifierGroups ?? item.assigned_modifier_groups ?? [],
      sort_order: item.sortOrder ?? item.sort_order ?? 999,
      image: item.image ?? null,
      // The shared metadata
      scope: newScope,
      org_id,
      master_id: masterId,
      lock_pricing: item.lockPricing ?? item.lock_pricing ?? false,
      locked_fields: item.lockedFields ?? item.locked_fields ?? [],
      // Parent items have no parent
      parent_id: null,
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
      const peerRow = {
        ...baseRow,
        id: peerId,
        location_id: peerLocId,
        cat: peerCat,
        cats: peerCats,
      };
      const { error } = await supabase.from('menu_items').upsert(peerRow);
      if (error) {
        console.warn('[setMenuItemScope] peer upsert failed for', peerLocId, error);
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
        const peerVariantRow = {
          id: peerVariantId,
          location_id: peerLocId,
          name: v.name,
          menu_name: v.menu_name ?? null,
          receipt_name: v.receipt_name ?? null,
          kitchen_name: v.kitchen_name ?? null,
          description: v.description ?? null,
          type: v.type ?? 'simple',
          cat: variantPeerCat,
          cats: [],
          pricing: v.pricing ?? { base: 0 },
          allergens: v.allergens ?? [],
          assigned_modifier_groups: v.assigned_modifier_groups ?? [],
          sort_order: v.sort_order ?? 999,
          image: v.image ?? null,
          scope: newScope,
          org_id,
          master_id: vMasterId,
          parent_id: peerId,
          lock_pricing: v.lock_pricing ?? false,
          locked_fields: v.locked_fields ?? [],
          updated_at: new Date().toISOString(),
        };
        const { error: vErr2 } = await supabase.from('menu_items').upsert(peerVariantRow);
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
  } else {
    // 3) Re-scoping (shared ↔ global): just update scope on all sibling rows.
    const { error, count } = await supabase.from('menu_items')
      .update({ scope: newScope, updated_at: new Date().toISOString() }, { count: 'exact' })
      .eq('master_id', masterId)
      .neq('id', item.id);
    if (error) console.warn('[setMenuItemScope] sibling rescope error:', error);
    else updatedSiblings = count || 0;
  }

  return { ok: true, action: isFirstPromotion ? 'promoted' : 'rescoped', createdCount, createdVariants, updatedSiblings, categoryAction };
};

/**
 * When upsertMenuItem runs and the item has scope='global', call this to
 * propagate the same payload to every sibling row in the org. Excludes id
 * and location_id so each row stays bound to its own location.
 */
export const propagateGlobalEdit = async (item, payload) => {
  if (isMock || !supabase) return { ok: true, propagated: 0 };
  if ((item.scope || 'local') !== 'global') return { ok: true, propagated: 0 };
  const masterId = item.master_id || item.id;
  if (!masterId) return { ok: true, propagated: 0 };

  // Strip identity / location-specific fields from the payload before propagating.
  const safe = { ...payload };
  delete safe.id;
  delete safe.location_id;
  delete safe.created_at;
  // Don't overwrite scope/org_id/master_id during propagate — those are
  // managed by setMenuItemScope.
  delete safe.scope;
  delete safe.org_id;
  delete safe.master_id;
  safe.updated_at = new Date().toISOString();

  const { error, count } = await supabase.from('menu_items')
    .update(safe, { count: 'exact' })
    .eq('master_id', masterId)
    .neq('id', item.id);

  if (error) {
    console.warn('[propagateGlobalEdit] update error:', error);
    return { ok: false, error };
  }
  return { ok: true, propagated: count || 0 };
};


// ──────────────────────────────────────────────────────────────────
// v4.7.3 — Category promote/demote, mirrors setMenuItemScope.
// ──────────────────────────────────────────────────────────────────

export const setMenuCategoryScope = async (cat, newScope) => {
  if (isMock) return { ok: true };
  if (!supabase) return { ok: false, error: 'no supabase' };
  if (!cat?.id) return { ok: false, error: 'no cat id' };
  if (!['local', 'shared', 'global'].includes(newScope)) return { ok: false, error: 'invalid scope' };

  const currentScope = cat.scope || 'local';
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

  if (isFirstPromotion) {
    const baseRow = {
      label: cat.label,
      icon: cat.icon ?? null,
      color: cat.color ?? null,
      accounting_group: cat.accounting_group ?? cat.accountingGroup ?? '',
      sort_order: cat.sort_order ?? cat.sortOrder ?? 0,
      is_special: cat.is_special ?? cat.isSpecial ?? false,
      default_course: cat.default_course ?? cat.defaultCourse ?? 1,
      spacer_slots: cat.spacer_slots ?? cat.spacerSlots ?? [],
      parent_id: null,
      menu_id: null,
      scope: newScope,
      org_id,
      master_id: masterId,
      lock_pricing: cat.lock_pricing ?? cat.lockPricing ?? false,
      updated_at: new Date().toISOString(),
    };
    for (const peerLocId of otherLocationIds) {
      const peerId = `${masterId}_${peerLocId.slice(-8)}`;
      const peerRow = { ...baseRow, id: peerId, location_id: peerLocId };
      const { error } = await supabase.from('menu_categories').upsert(peerRow);
      if (error) console.warn('[setMenuCategoryScope] peer upsert failed for', peerLocId, error);
      else createdCount++;
    }
  } else {
    const { error, count } = await supabase.from('menu_categories')
      .update({ scope: newScope, updated_at: new Date().toISOString() }, { count: 'exact' })
      .eq('master_id', masterId)
      .neq('id', cat.id);
    if (error) console.warn('[setMenuCategoryScope] sibling rescope error:', error);
    else updatedSiblings = count || 0;
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
  return supabase.from('discounts').delete().eq('id', id);
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
  return supabase.from('discount_rules').delete().eq('id', id);
};
