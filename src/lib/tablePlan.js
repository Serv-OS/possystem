// Table plan: who owns a table's DEFINITION, and how every merge honours an edit or a delete.
//
// Peter, 18 Sep 2026: "if you rename, delete them etc, on refresh they come back and names go
// back." The "tables must never be lost" rule (memory: feedback_tables_never_lost) made every
// merge keep any table the incoming data lacked and keep the RECEIVER's layout, so absence was
// always read as "lost", never as "deleted", and an old copy of a name could win over a new one.
//
// The rule this module enforces:
//
//   DEFINITION (id, label, x, y, w, h, shape, maxCovers, section, sortOrder) has ONE owner, the
//   saved plan (floor_tables, edited in Back Office). Every definition carries `defAt` (ms): the
//   time of the edit, or the time a successful plan read STARTED. The newer definition wins,
//   field by field, over any local copy. Unstamped (legacy) data falls back to the time of the
//   snapshot it came in, or to 0.
//
//   DELETE is an explicit marker: a tombstone { id: deletedAtMs }. A tombstone newer than a
//   table's definition removes it in every merge (config push, cached snapshot, cross-tab
//   broadcast, boot read). A successful, non-empty read of floor_tables is also a marker: it is
//   the PLAN VERSION as of the moment it started ({ readAt, ids }). A table that read did not
//   contain, and whose definition is not newer than it, is not re-added by a stale snapshot or a
//   stale tab.
//
//   ABSENCE ALONE NEVER REMOVES A TABLE: a failed read, an empty read, an empty or partial config,
//   a broadcast without the table, a wake from sleep. None of those are markers.
//
//   SESSION (open order, fired courses, covers) is never lost. A table that still holds a session
//   is never dropped, not even by a tombstone or a plan read: it is kept reachable, flagged
//   `planRemoved: true`, until its session closes. Back Office refuses the delete up front
//   (FloorPlanBuilder), so this is the backstop for a till that took an order while it missed
//   the delete.
//
// Pure (no store, no Supabase). localStorage helpers at the bottom are guarded so node tests run.

export const DEF_FIELDS = ['label', 'x', 'y', 'w', 'h', 'shape', 'maxCovers', 'section', 'sortOrder'];

// Keep a tombstone this long. Long enough for a till that sat in a drawer over a holiday.
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

const num = (v) => {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const d = Date.parse(v);
  return Number.isFinite(d) ? d : 0;
};

export const defAtOf = (t) => num(t?.defAt);
// editAt: when the definition was last EDITED (Back Office clock, or floor_tables.updated_at).
// A read stamps defAt (how fresh this copy is) but never editAt, so a tombstone is compared with
// a real edit time only: a till whose clock runs ahead cannot out-date a delete by reading early.
export const editAtOf = (t) => num(t?.editAt);

export const hasSession = (t) => !!t?.session;

// A tombstone removes a table unless the table was EDITED after the delete (re-created, or
// edited by another Back Office after it): the newer explicit edit wins.
export function isTombstoned(id, editAt, tombstones) {
  if (!id || !tombstones) return false;
  const at = num(tombstones[id]);
  return at > 0 && at >= num(editAt);
}

// Union of tombstone sets, newest time per id, expired ones pruned.
export function mergeTombstones(...sets) {
  const out = {};
  const floor = Date.now() - TOMBSTONE_TTL_MS;
  for (const s of sets) {
    if (!s || typeof s !== 'object') continue;
    for (const [id, v] of Object.entries(s)) {
      const at = num(v);
      if (!id || at <= 0 || at < floor) continue;
      if (!out[id] || at > out[id]) out[id] = at;
    }
  }
  return out;
}

// Rows from floor_table_tombstones -> { table_id: ms }
export function tombstonesFromRows(rows) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = r?.table_id ?? r?.tableId;
    const at = num(r?.deleted_at ?? r?.deletedAt);
    if (id && at > 0 && (!out[id] || at > out[id])) out[id] = at;
  }
  return out;
}

function pickDef(src) {
  const o = {};
  for (const f of DEF_FIELDS) if (f in src && src[f] !== undefined) o[f] = src[f];
  return o;
}

function markRemoved(t) {
  return t.planRemoved ? t : { ...t, planRemoved: true };
}
function clearRemoved(t) {
  if (!t.planRemoved) return t;
  const { planRemoved: _gone, ...rest } = t;
  return rest;
}

// A table that is not in the plan any more: dropped when it holds no session, kept reachable
// (flagged) when it does. `isOpen` lets a caller count a session it knows about elsewhere
// (active_sessions read at boot) that is not on the local row yet.
function retire(t, isOpen, dropped, keptOpen) {
  if (hasSession(t) || (isOpen && isOpen(t.id))) { keptOpen.push(t.id); return markRemoved(t); }
  dropped.push(t.id);
  return null;
}

/**
 * Merge incoming table DEFINITIONS into local tables.
 *
 * Used for everything that is NOT an authoritative read: a config push snapshot (live, cached,
 * or applied from the banner) and a cross-tab broadcast.
 *
 *   local       the store's tables (sessions live here and are never touched)
 *   incoming    tables from the other source
 *   tombstones  { id: ms }
 *   plan        { readAt, ids } from the last successful plan read, or null
 *   fallbackAt  the time an unstamped incoming definition is treated as (snapshot version), 0 if
 *               unknown (a broadcast)
 *   tie         who wins when both definitions carry the same time: 'incoming' for a snapshot
 *               (the pre-existing behaviour for unstamped data), 'local' for a broadcast
 *   isOpen      optional (id) => bool, a session known elsewhere
 *
 * Local tables the incoming list lacks are ALWAYS kept (absence is not a delete).
 */
export function mergeDefinitions({ local, incoming, tombstones = {}, plan = null, fallbackAt = 0, tie = 'local', isOpen = null } = {}) {
  const loc = Array.isArray(local) ? local : [];
  if (!Array.isArray(incoming)) {
    return { tables: applyTombstones(loc, tombstones, isOpen).tables, dropped: [], keptOpen: [], added: [], changed: false };
  }
  const inc = new Map();
  for (const t of incoming) if (t && t.id) inc.set(t.id, t);
  const dropped = [], keptOpen = [], added = [];
  let changed = false;
  const out = [];
  for (const l of loc) {
    let t = l;
    const i = inc.get(l.id);
    if (i) {
      const iAt = defAtOf(i) || num(fallbackAt);
      const lAt = defAtOf(l);
      const incomingWins = iAt > lAt || (iAt === lAt && tie === 'incoming');
      if (incomingWins) {
        const def = pickDef(i);
        const differs = Object.keys(def).some(k => l[k] !== def[k]) || iAt !== lAt;
        if (differs) {
          t = { ...l, ...def, defAt: iAt, editAt: Math.max(editAtOf(l), editAtOf(i)) };
          const iLoc = i.locationId ?? i.location_id;
          if (iLoc) t.locationId = iLoc;
          changed = true;
        }
        // A newer definition of a retired table (re-created after the delete) restores it.
        if (t.planRemoved && !isTombstoned(t.id, editAtOf(t), tombstones)) { t = clearRemoved(t); changed = true; }
      }
    }
    if (isTombstoned(t.id, editAtOf(t), tombstones)) {
      const r = retire(t, isOpen, dropped, keptOpen);
      if (r !== t) changed = true;
      if (r) out.push(r);
      continue;
    }
    // A retired table whose order has closed goes now.
    if (t.planRemoved && !hasSession(t) && !(isOpen && isOpen(t.id))) { dropped.push(t.id); changed = true; continue; }
    out.push(t);
  }
  const have = new Set(loc.map(t => t.id));
  for (const [id, i] of inc) {
    if (have.has(id)) continue;
    const iAt = defAtOf(i) || num(fallbackAt);
    const tomb = isTombstoned(id, editAtOf(i), tombstones);
    // Superseded: the last plan read did not contain it and it is not newer than that read.
    const superseded = !!(plan && num(plan.readAt) > 0 && Array.isArray(plan.ids)
      && !plan.ids.includes(id) && iAt <= num(plan.readAt));
    if (tomb || superseded) {
      // An incoming table that carries a live session is kept reachable, never silently lost.
      if (hasSession(i)) { out.push(markRemoved({ ...i, defAt: iAt })); keptOpen.push(id); changed = true; }
      continue;
    }
    out.push({ status: 'available', session: null, firedCourses: [], sentAt: null, ...i, defAt: iAt });
    added.push(id);
    changed = true;
  }
  return { tables: out, dropped, keptOpen, added, changed };
}

/**
 * Apply a SUCCESSFUL, NON-EMPTY read of floor_tables: the plan version as of `readAt` (the time
 * the read started, so an edit made while the read was in flight is newer and wins).
 *
 *   rows     normalised tables from the read (camelCase, each may carry defAt from updated_at)
 *   local    the store's tables
 *   isOpen   optional (id) => bool for sessions known elsewhere (active_sessions at boot)
 *
 * Returns null when the read is not usable (not an array, or empty): the caller must then change
 * NOTHING except apply tombstones. Absence in a failed or empty read never removes a table.
 */
export function applyPlanRead({ local, rows, readAt, tombstones = {}, isOpen = null } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const at = num(readAt) || Date.now();
  const loc = Array.isArray(local) ? local : [];
  const byId = new Map(loc.map(t => [t.id, t]));
  const ids = [];
  const dropped = [], keptOpen = [], added = [];
  const out = [];
  for (const row of rows) {
    if (!row || !row.id) continue;
    ids.push(row.id);
    const rAt = defAtOf(row) || at;
    const l = byId.get(row.id);
    let t;
    if (l) {
      // Newer definition wins, field by field. The read wins ties: it is the owner.
      t = defAtOf(l) > rAt
        ? l
        : clearRemoved({ ...l, ...pickDef(row), defAt: rAt, editAt: Math.max(editAtOf(l), editAtOf(row)), locationId: row.locationId ?? l.locationId });
    } else {
      t = { status: 'available', session: null, firedCourses: [], sentAt: null, ...row, defAt: rAt };
      added.push(row.id);
    }
    if (isTombstoned(t.id, editAtOf(t), tombstones)) {
      const r = retire(t, isOpen, dropped, keptOpen);
      if (r) out.push(r);
      continue;
    }
    out.push(t);
  }
  const inRead = new Set(ids);
  for (const l of loc) {
    if (inRead.has(l.id)) continue;
    // Created (or edited) after the read started, e.g. Back Office added it mid-read: keep.
    if (defAtOf(l) > at && !isTombstoned(l.id, editAtOf(l), tombstones)) { out.push(l); continue; }
    // Not in the plan version: gone, unless a session still lives on it.
    const r = retire(l, isOpen, dropped, keptOpen);
    if (r) out.push(r);
  }
  return { tables: out, plan: { readAt: at, ids }, dropped, keptOpen, added };
}

// Tombstones only (no incoming list): used when a read failed or came back empty.
export function applyTombstones(local, tombstones, isOpen = null) {
  const loc = Array.isArray(local) ? local : [];
  const dropped = [], keptOpen = [];
  const out = [];
  let changed = false;
  for (const t of loc) {
    if (isTombstoned(t.id, editAtOf(t), tombstones)) {
      const r = retire(t, isOpen, dropped, keptOpen);
      if (r !== t) changed = true;
      if (r) out.push(r);
    } else out.push(t);
  }
  return { tables: changed ? out : loc, dropped, keptOpen, changed };
}

// A retired table whose session has closed: it can go now.
export function pruneClosedRemoved(tables) {
  if (!Array.isArray(tables) || !tables.some(t => t?.planRemoved && !hasSession(t))) return tables;
  return tables.filter(t => !(t?.planRemoved && !hasSession(t)));
}

// Back Office delete guard. A table with an open order (on this browser or in active_sessions)
// is refused in plain words; so is a delete whose order check could not run.
export function deleteRefusalReason(table, { dbSession = null, checkFailed = false } = {}) {
  const name = String(table?.label || 'This table').trim() || 'This table';
  const shown = /^\d/.test(name) ? `Table ${name}` : name;   // "4" reads as "Table 4", "T4" stays
  if (hasSession(table) || dbSession) return `${shown} has an open order, close or move it first`;
  if (checkFailed) return `Could not check ${shown} for an open order, so it was not deleted. Try again`;
  return null;
}

// Floor_tables row (snake) -> store table definition (camel), stamped.
export function normaliseFloorRow(t, { locationId = null, readAt = 0 } = {}) {
  return {
    ...t,
    id: t.id,
    label: t.label,
    x: t.x, y: t.y, w: t.w, h: t.h,
    shape: t.shape,
    maxCovers: t.max_covers ?? t.maxCovers ?? 4,
    section: t.section ?? t.section_id ?? null,
    sortOrder: t.sort_order ?? t.sortOrder ?? 0,
    locationId: t.location_id ?? t.locationId ?? locationId,
    defAt: num(t.updated_at) || num(t.defAt) || num(readAt),
    editAt: num(t.updated_at) || num(t.editAt) || 0,
  };
}

// ── Local persistence (per location, shared by every tab on the machine) ─────────────────────
const KEY = 'rpos-table-plan';

function ls() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

function readAll() {
  const s = ls();
  if (!s) return {};
  try { const v = JSON.parse(s.getItem(KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

function writeAll(all) {
  const s = ls();
  if (!s) return;
  try { s.setItem(KEY, JSON.stringify(all)); } catch { /* quota: best effort */ }
}

export function loadPlanState(locationId) {
  if (!locationId) return { plan: null, tombstones: {} };
  const e = readAll()[locationId] || {};
  const plan = e.plan && num(e.plan.readAt) > 0 && Array.isArray(e.plan.ids) ? e.plan : null;
  return { plan, tombstones: mergeTombstones(e.tombstones) };
}

export function savePlanState(locationId, { plan, tombstones } = {}) {
  if (!locationId) return;
  const all = readAll();
  const cur = all[locationId] || {};
  const next = { ...cur };
  if (plan && num(plan.readAt) >= num(cur.plan?.readAt)) next.plan = { readAt: num(plan.readAt), ids: [...plan.ids] };
  if (tombstones) next.tombstones = mergeTombstones(cur.tombstones, tombstones);
  all[locationId] = next;
  writeAll(all);
}

export function recordTombstone(locationId, tableId, at = Date.now()) {
  if (!locationId || !tableId) return;
  savePlanState(locationId, { tombstones: { [tableId]: at } });
}

// A delete that the database refused: take the local tombstone back, or the restored table
// would be removed again by the next merge.
export function forgetTombstone(locationId, tableId) {
  if (!locationId || !tableId) return;
  const all = readAll();
  const cur = all[locationId];
  if (!cur?.tombstones?.[tableId]) return;
  const t = { ...cur.tombstones };
  delete t[tableId];
  all[locationId] = { ...cur, tombstones: t };
  writeAll(all);
}
