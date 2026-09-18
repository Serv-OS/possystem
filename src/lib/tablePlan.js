// Table plan: who owns a table's DEFINITION, and how every merge honours an edit or a delete.
//
// Peter, 18 Sep 2026: "if you rename, delete them etc, on refresh they come back and names go
// back." The "tables must never be lost" rule (memory: feedback_tables_never_lost) made every
// merge keep any table the incoming data lacked and keep the RECEIVER's layout, so absence was
// always read as "lost", never as "deleted", and an old copy of a name could win over a new one.
//
// THE RULES (review round two: no device clock decides anything)
//
//   DEFINITION (label, x, y, w, h, shape, maxCovers, section, sortOrder) has ONE owner, the saved
//   plan (floor_tables). Every copy of a definition carries two version marks:
//     srvAt  floor_tables.updated_at in ms, set by the DATABASE clock (migration 20260918b). The
//            only time that is compared across devices. 0 = unknown (old data, old code, or the
//            migration has not run yet).
//     _seq   the order in which THIS machine observed the copy (a counter kept in localStorage,
//            shared by the tabs on the machine). Never a clock: a till whose clock is hours out
//            still counts 1, 2, 3.
//   A copy with a server time always beats a copy without one ("an unstamped copy is older than
//   any server time"). Two stamped copies: the later server time wins. Two unstamped copies: the
//   one this machine observed later wins (a live push after the last plan read, a plan read after
//   the cached push it booted with).
//
//   DELETE is an explicit marker, a tombstone { at, srv, seq }:
//     srv tombstone   floor_table_tombstones.deleted_at, set by the database clock. It removes a
//                     copy only if deleted_at is LATER than the copy's srvAt, so re-creating an id
//                     (which stamps a newer updated_at) clears it. It always beats an unstamped copy.
//     local tombstone written by Back Office when the tombstone table is missing or unreachable,
//                     carried in Push to POS. `at` is only an identity, never compared with a
//                     server time. It removes an unstamped copy this machine observed BEFORE it
//                     learned of the delete, and a plan read that starts after it and still holds
//                     the row supersedes it (the row was re-created).
//
//   A SUCCESSFUL, NON-EMPTY plan read is the plan version { seq, ids, srvReadAt }. A table the read
//   lacks is retired only if this machine observed its copy before the read began (or, with server
//   times, if its srvAt is not after the read's server time). An incoming table (push, broadcast,
//   cache) the last read lacked is added only when it is newer than that read by the same rules;
//   an old-code push (no stamps) can add only what the database had at the last read.
//
//   ABSENCE ALONE NEVER REMOVES A TABLE: a failed read, an empty read, an empty or partial config,
//   a broadcast without the table, a wake from sleep. None of those are markers.
//
//   SESSION (open order) is never lost. A table that still holds an open session is never dropped:
//   it stays reachable, flagged `planRemoved: true`, until its order closes (sessionClosure's
//   isSessionClosed decides "closed", so a leftover closed row neither keeps a table nor blocks a
//   delete). An open session whose table is missing altogether (cold boot after a delete, a split
//   child check, another till's order on a deleted table) gets its table REBUILT (rebuildOrphans).
//
// Pure (no store, no Supabase). The localStorage helpers at the bottom are guarded so node tests run.

export const DEF_FIELDS = ['label', 'x', 'y', 'w', 'h', 'shape', 'maxCovers', 'section', 'sortOrder'];
// A definition travels as one unit: its fields plus its version marks (and, in Back Office, the
// compare-and-set base). A merge adopts all of it or none of it.
const VERSION_FIELDS = ['srvAt', 'srvIso', '_seq'];
// What the receiver keeps of its own table when it takes the sender's operational state.
export const KEEP_ON_BROADCAST = [...DEF_FIELDS, 'seats', 'area', ...VERSION_FIELDS, '_base', '_pending', '_isNew', 'locationId', 'planRemoved', 'rebuilt'];
// Flags that belong to the receiver's copy only: dropped from the sender's copy when the receiver lacks them.
const LOCAL_FLAGS = ['planRemoved', 'rebuilt', '_pending', '_isNew', '_base'];

const MAX_TOMBS = 500;
const MAX_LABELS = 1000;
const MAX_PUSHES = 30;

export const num = (v) => {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const d = Date.parse(v);
  return Number.isFinite(d) ? d : 0;
};

export const srvAtOf = (t) => num(t?.srvAt);
export const seqOf = (t) => num(t?._seq);

const noClosed = () => false;
// An open session: present and not cashed off (sessionClosure.isSessionClosed is passed in).
export const openSession = (t, isClosed = noClosed) => !!t?.session && !isClosed(t.id, t.session);

export function pickDef(src) {
  const o = {};
  for (const f of DEF_FIELDS) if (src && f in src && src[f] !== undefined) o[f] = src[f];
  return o;
}

function versionOf(src) {
  return { srvAt: srvAtOf(src), srvIso: src?.srvIso || null, _seq: seqOf(src) };
}

function markRemoved(t) { return t.planRemoved ? t : { ...t, planRemoved: true }; }
function clearRemoved(t) {
  if (!t.planRemoved && !t.rebuilt) return t;
  const { planRemoved: _gone, rebuilt: _r, ...rest } = t;
  return rest;
}
// Back Office edit flags belong to the tab that made the edit; a copy received from elsewhere
// never carries them (a till must not treat another tab's in-flight edit as its own).
function foreign(t) {
  if (!('_pending' in t) && !('_isNew' in t)) return t;
  const { _pending: _p, _isNew: _n, ...rest } = t;
  return rest;
}

// Take `src`'s definition (fields + version marks) onto `local`, keeping local's operational state.
function adoptDef(local, src) {
  const t = { ...local, ...pickDef(src), ...versionOf(src) };
  if (src._base) t._base = src._base;
  const loc = src.locationId ?? src.location_id;
  if (loc) t.locationId = loc;
  return t;
}

// Is `inc` a newer definition than `loc`? Server times first; unstamped loses to stamped; two
// unstamped copies by observation order on this machine. Ties keep the local copy. A Back Office
// edit whose write is still in flight is never replaced under the operator.
export function newerDef(inc, loc) {
  if (!inc) return false;
  if (!loc) return true;
  if (loc._pending) return false;
  const a = srvAtOf(inc), b = srvAtOf(loc);
  if (a || b) return a > b;
  return seqOf(inc) > seqOf(loc);
}

// ── Tombstones ───────────────────────────────────────────────────────────────────────────────

// Normalise one tombstone value (an object, or the plain number the first branch build wrote).
export function normTomb(v, seq = 0) {
  if (v == null) return null;
  if (typeof v === 'number' || typeof v === 'string') {
    const at = num(v);
    return at > 0 ? { at, srv: false, seq: num(seq) } : null;
  }
  if (typeof v !== 'object') return null;
  const at = num(v.at ?? v.deleted_at ?? v.deletedAt);
  if (at <= 0) return null;
  const out = { at, srv: !!v.srv, seq: num(v.seq) || num(seq) };
  if (v.label) out.label = String(v.label);
  return out;
}

// Which of two tombstones for one id stands: a server one over a local one, else the later `at`
// (for two server ones that is the database clock; for two local ones it is only a tie-break).
function laterTomb(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.srv !== b.srv) return a.srv ? a : b;
  return b.at > a.at ? b : a;
}

/**
 * Merge incoming tombstones into a set. `seq` is when this machine observed the incoming set (the
 * push's first observation, the read's start); a tombstone it already holds keeps its first seq.
 * `cleared` holds local tombstones a later plan read superseded: the same one never comes back.
 */
export function mergeTombs(base, incoming, { seq = 0, cleared = null } = {}) {
  const out = {};
  for (const [id, v] of Object.entries(base || {})) {
    const t = normTomb(v);
    if (id && t) out[id] = t;
  }
  if (incoming && typeof incoming === 'object') {
    for (const [id, v] of Object.entries(incoming)) {
      const t = normTomb(v, seq);
      if (!id || !t) continue;
      if (!t.srv && cleared && num(cleared[id]) === t.at) continue;
      const cur = out[id];
      if (cur && cur.at === t.at && cur.srv === t.srv) continue;      // already known: keep its seq
      const win = laterTomb(cur, t);
      if (win === t) out[id] = t;
    }
  }
  const keys = Object.keys(out);
  if (keys.length > MAX_TOMBS) {
    keys.sort((a, b) => out[b].seq - out[a].seq);
    for (const k of keys.slice(MAX_TOMBS)) delete out[k];
  }
  return out;
}

// Rows from floor_table_tombstones -> { table_id: { at, srv: true, seq, label } }
export function tombstonesFromRows(rows, seq = 0) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const id = r?.table_id ?? r?.tableId;
    const at = num(r?.deleted_at ?? r?.deletedAt);
    if (!id || at <= 0) continue;
    if (!out[id] || at > out[id].at) out[id] = { at, srv: true, seq: num(seq), ...(r.label ? { label: String(r.label) } : {}) };
  }
  return out;
}

// Does this tombstone remove this copy of the table? (not used for plan reads, see applyPlanRead)
export function tombBeats(tomb, copy) {
  const t = normTomb(tomb);
  if (!t || !copy) return false;
  const s = srvAtOf(copy);
  if (t.srv && s > 0) return t.at > s;            // database clock against database clock
  if (!t.srv && s > 0) return false;              // a local mark cannot out-date a server time
  // Unstamped copy: removed unless this machine observed it at or after the moment it learned of
  // the delete (a plan read that started after it and still held the row, i.e. it was re-created).
  return !(t.seq > 0 && seqOf(copy) >= t.seq);
}

// ── Plan version (membership) ────────────────────────────────────────────────────────────────

/**
 * May an incoming table (push, broadcast, cache) that the store does not hold be added?
 *   no plan read yet            yes (nothing better to go on, the pre-existing behaviour)
 *   in the last plan read       yes (the database had it)
 *   server times on both sides  only if it is newer than that read
 *   otherwise                   only if this machine observed it after that read began
 * An old-code push carries neither mark (seq 0), so it can add only what the database had.
 */
export function admits(inc, plan) {
  if (!plan) return true;
  if (Array.isArray(plan.ids) && plan.ids.includes(inc.id)) return true;
  const s = srvAtOf(inc);
  if (s > 0 && num(plan.srvReadAt) > 0) return s > num(plan.srvReadAt);
  return seqOf(inc) > num(plan.seq);
}

// A table that is not in the plan any more: dropped when nothing is open on it, kept reachable
// (flagged) when it is.
function retire(t, open, dropped, keptOpen) {
  if (open) { keptOpen.push(t.id); return markRemoved(t); }
  dropped.push(t.id);
  return null;
}

/**
 * Merge incoming table DEFINITIONS into local tables (config push, cached snapshot, broadcast).
 *
 *   local      the store's tables (sessions live here and are never touched)
 *   incoming   tables from the other source, each with srvAt / _seq already set by the caller
 *   tombs      { id: tombstone }
 *   plan       { seq, ids, srvReadAt } from the last successful plan read, or null
 *   isOpen     optional (id) => bool, an open session known elsewhere (the sender's copy)
 *   isClosed   sessionClosure.isSessionClosed (or a test double)
 *
 * Local tables the incoming list lacks are ALWAYS kept (absence is not a delete).
 */
export function mergeDefinitions({ local, incoming, tombs = {}, plan = null, isOpen = null, isClosed = noClosed } = {}) {
  const loc = Array.isArray(local) ? local : [];
  if (!Array.isArray(incoming)) return applyTombstones(loc, tombs, { isOpen, isClosed });
  const inc = new Map();
  for (const t of incoming) if (t && t.id) inc.set(t.id, t);
  const dropped = [], keptOpen = [], added = [];
  let changed = false;
  const out = [];
  const opened = (t) => openSession(t, isClosed) || !!(isOpen && isOpen(t.id)) || hasOpenChild(loc, t.id, isClosed);
  for (const l of loc) {
    let t = l;
    const i = inc.get(l.id);
    if (i && newerDef(i, l)) {
      const next = adoptDef(l, i);
      if (DEF_FIELDS.some(k => next[k] !== l[k]) || srvAtOf(next) !== srvAtOf(l) || seqOf(next) !== seqOf(l)) { t = next; changed = true; }
      // A newer definition of a retired table (re-created, or restored by another tab) restores it.
      if (t.planRemoved && !i.planRemoved && !tombBeats(tombs[t.id], t)) { t = clearRemoved(t); changed = true; }
    }
    if (!t.parentId && tombBeats(tombs[t.id], t)) {
      const r = retire(t, opened(t), dropped, keptOpen);
      if (r !== t) changed = true;
      if (r) out.push(r);
      continue;
    }
    // A retired table whose order has closed goes now.
    if (t.planRemoved && !opened(t)) { dropped.push(t.id); changed = true; continue; }
    out.push(t);
  }
  const have = new Set(loc.map(t => t.id));
  for (const [id, i] of inc) {
    if (have.has(id)) continue;
    const open = openSession(i, isClosed);
    const blocked = (!i.parentId && tombBeats(tombs[id], i)) || (!i.parentId && !admits(i, plan)) || (i.planRemoved && !open);
    if (blocked) {
      // An incoming table that carries a live session is kept reachable, never silently lost.
      if (open) { out.push(markRemoved(foreign({ ...i }))); keptOpen.push(id); changed = true; }
      continue;
    }
    out.push({ status: 'available', session: null, firedCourses: [], sentAt: null, ...foreign(i) });
    added.push(id);
    changed = true;
  }
  return { tables: changed ? out : loc, dropped, keptOpen, added, changed };
}

function hasOpenChild(tables, id, isClosed) {
  return tables.some(t => t.parentId === id && openSession(t, isClosed));
}

/**
 * Apply a SUCCESSFUL, NON-EMPTY read of floor_tables: the plan version.
 *
 *   rows       normalised rows (normaliseFloorRow), each with srvAt from updated_at when it exists
 *   srvReadAt  the database clock at the read (floor_plan_read), 0 before the migration
 *   readSeq    this machine's counter taken just BEFORE the read was sent
 *   mode       'full'        the read decides membership (boot, refresh, Back Office load)
 *              'upsertOnly'  add and update only, never retire (useSupabaseInit: it has no
 *                            sessions to check, so it must never drop a table)
 *
 * A table the read lacks is retired unless this machine observed it after the read began, or its
 * server time is after the read's server time. A tombstone against a row the read DID return wins
 * only if it is newer than the read (server: deleted_at later than the row's updated_at; local:
 * learned after the read began). A local tombstone the read outlived is returned in `cleared`.
 *
 * Returns null when the read is not usable (not an array, or empty): the caller must then change
 * NOTHING except apply tombstones.
 */
export function applyPlanRead({ local, rows, srvReadAt = 0, readSeq = 0, tombs = {}, isOpen = null, isClosed = noClosed, mode = 'full' } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const loc = Array.isArray(local) ? local : [];
  const byId = new Map(loc.map(t => [t.id, t]));
  const ids = [], dropped = [], keptOpen = [], added = [], cleared = {};
  const labels = {};
  const out = [];
  const opened = (t) => openSession(t, isClosed) || !!(isOpen && isOpen(t.id)) || hasOpenChild(loc, t.id, isClosed);
  for (const row of rows) {
    if (!row || !row.id) continue;
    ids.push(row.id);
    if (row.label != null) labels[row.id] = String(row.label);
    const r = { ...row, _seq: num(readSeq) };
    const l = byId.get(row.id);
    const keepLocal = !!l && (l._pending || seqOf(l) > num(readSeq) || srvAtOf(l) > srvAtOf(r));
    let t = l
      ? (keepLocal ? l : clearRemoved(adoptDef(l, r)))
      : { status: 'available', session: null, firedCourses: [], sentAt: null, ...r };
    const tomb = normTomb(tombs[row.id]);
    if (tomb) {
      const beaten = (tomb.srv && srvAtOf(r) > 0) ? tomb.at > srvAtOf(r) : tomb.seq > num(readSeq);
      if (beaten) {
        if (mode === 'upsertOnly') { if (l) out.push(l); continue; }
        const x = retire(t, opened(t), dropped, keptOpen);
        if (x) out.push(x);
        continue;
      }
      if (!tomb.srv) cleared[row.id] = tomb.at;
    }
    if (!l) added.push(row.id);
    out.push(t);
  }
  const inRead = new Set(ids);
  for (const l of loc) {
    if (inRead.has(l.id)) continue;
    if (mode === 'upsertOnly') { out.push(l); continue; }
    // Split child checks are never in floor_tables: they live while their order is open.
    if (l.parentId) { if (openSession(l, isClosed)) out.push(l); else dropped.push(l.id); continue; }
    // Observed after the read began (Back Office added it mid-read, a live push, a pending edit).
    const newer = l._pending || l._isNew || seqOf(l) > num(readSeq)
      || (srvAtOf(l) > 0 && num(srvReadAt) > 0 && srvAtOf(l) > num(srvReadAt));
    if (newer && !tombBeats(tombs[l.id], l)) { out.push(l); continue; }
    const x = retire(l, opened(l), dropped, keptOpen);
    if (x) out.push(x);
  }
  return { tables: out, plan: { seq: num(readSeq), ids, srvReadAt: num(srvReadAt) }, dropped, keptOpen, added, cleared, labels };
}

// Tombstones only (no incoming list): used when a read failed or came back empty.
export function applyTombstones(local, tombs, { isOpen = null, isClosed = noClosed } = {}) {
  const loc = Array.isArray(local) ? local : [];
  const dropped = [], keptOpen = [];
  const out = [];
  let changed = false;
  for (const t of loc) {
    if (!t.parentId && tombBeats(tombs?.[t.id], t)) {
      const open = openSession(t, isClosed) || !!(isOpen && isOpen(t.id)) || hasOpenChild(loc, t.id, isClosed);
      const r = retire(t, open, dropped, keptOpen);
      if (r !== t) changed = true;
      if (r) out.push(r);
    } else out.push(t);
  }
  return { tables: changed ? out : loc, dropped, keptOpen, added: [], changed };
}

// A retired table whose order has closed (and that has no open split child) can go now.
export function pruneClosedRemoved(tables, isClosed = noClosed) {
  if (!Array.isArray(tables)) return tables;
  const gone = tables.filter(t => t?.planRemoved && !openSession(t, isClosed) && !hasOpenChild(tables, t.id, isClosed));
  if (!gone.length) return tables;
  const ids = new Set(gone.map(t => t.id));
  return tables.filter(t => !ids.has(t.id));
}

/**
 * Rebuild a reachable table for every OPEN session whose table is missing.
 *
 *   sessions   Map or object { tableId: session } from every source the caller has (active_sessions,
 *              rpos-session-backup, rpos-session-snapshot)
 *   labels     last known names (plan state), so the rebuilt table reads as it did
 *   tombs      tombstones (their label, if the database row carried one)
 *
 * A closed session (isClosed) is skipped, so a leftover row never rebuilds a table. A session whose
 * id already lives on another table (moved) is skipped. A split child check (`<parent>-<n>`) is
 * rebuilt as a child of its parent; a missing parent is rebuilt as an empty retired table so the
 * child stays reachable. Rebuilt tables are flagged planRemoved and placed in a row below the plan.
 */
export function rebuildOrphans(tables, sessions, { isClosed = noClosed, labels = {}, tombs = {} } = {}) {
  const list = Array.isArray(tables) ? tables : [];
  const entries = sessions instanceof Map ? [...sessions.entries()] : Object.entries(sessions || {});
  const have = new Set(list.map(t => t.id));
  const sessionHome = new Map();
  for (const t of list) if (t.session?.id) sessionHome.set(t.session.id, t.id);
  const open = entries.filter(([id, s]) => id && s && typeof s === 'object' && !have.has(id) && !isClosed(id, s)
    && !(s.id && sessionHome.has(s.id) && sessionHome.get(s.id) !== id));
  if (!open.length) return list;
  const openIds = new Set(open.map(([id]) => id));
  const childOf = (id) => {
    const m = /^(.+)-(\d+)$/.exec(id);
    if (!m) return null;
    const p = m[1];
    const known = have.has(p) || openIds.has(p) || labels[p] != null || tombs[p] != null;
    return known ? { parentId: p, n: m[2] } : null;
  };
  const out = [...list];
  let bottom = 0;
  for (const t of list) bottom = Math.max(bottom, num(t.y) + (num(t.h) || 80));
  let slot = 0;
  const place = () => ({ x: 8 + (slot % 8) * 96, y: bottom + 24 + Math.floor(slot++ / 8) * 96 });
  const nameOf = (id) => labels[id] ?? normTomb(tombs[id])?.label ?? null;
  const occupied = (s) => ({ status: 'occupied', session: s, firedCourses: s.firedCourses || [], sentAt: s.sentAt || null });
  const byId = () => new Map(out.map(t => [t.id, t]));
  // Parents / standalone tables first, then children.
  const standalone = open.filter(([id]) => !childOf(id));
  const children = open.filter(([id]) => childOf(id));
  for (const [id, s] of standalone) {
    out.push({ id, label: nameOf(id) || 'Removed table', ...place(), w: 80, h: 80, shape: 'rect', maxCovers: num(s.covers) || 4, section: null, planRemoved: true, rebuilt: true, ...occupied(s) });
  }
  for (const [id, s] of children) {
    const { parentId, n } = childOf(id);
    let parent = byId().get(parentId);
    if (!parent) {
      parent = { id: parentId, label: nameOf(parentId) || 'Removed table', ...place(), w: 80, h: 80, shape: 'rect', maxCovers: 4, section: null, planRemoved: true, rebuilt: true, status: 'available', session: null, firedCourses: [], sentAt: null };
      out.push(parent);
    }
    const { session: _s, childIds: _c, planRemoved: _p, rebuilt: _r, ...layout } = parent;
    out.push({ ...layout, id, label: nameOf(id) || `${parent.label}.${n}`, parentId, rebuilt: true, ...occupied(s), status: 'open' });
    const pi = out.findIndex(t => t.id === parentId);
    out[pi] = { ...out[pi], childIds: [...new Set([...(out[pi].childIds || []), id])] };
  }
  return out;
}

/**
 * Cross-tab broadcast merge (SyncBridge). Two steps:
 *   1. definitions and membership through mergeDefinitions; the sender's open sessions count as
 *      open, so a table this tab has as deleted but the sender holds an order on is KEPT
 *      (planRemoved) and gets that order in step 2, never discarded;
 *   2. sessions by the pre-existing rules (v4.5.3 stop-bleed, updatedAt tie-break, the active table
 *      is never touched), with the definition from step 1.
 */
export function mergeBroadcastTables(localTables, incomingTables, activeId, { tombs = {}, plan = null, isClosed = noClosed, warn = null } = {}) {
  if (!Array.isArray(incomingTables)) return localTables;
  const local = Array.isArray(localTables) ? localTables : [];
  const byId = new Map(incomingTables.filter(t => t && t.id).map(t => [t.id, t]));
  const defs = mergeDefinitions({
    local, incoming: incomingTables, tombs, plan, isClosed,
    isOpen: (id) => openSession(byId.get(id), isClosed),
  });
  const localIds = new Set(local.map(t => t.id));
  const merged = [];
  for (const def of defs.tables) {
    if (!localIds.has(def.id)) { merged.push(def); continue; }
    const localT = def;
    if (localT.id === activeId) { merged.push(localT); continue; }
    const incoming = byId.get(localT.id);
    if (!incoming) { merged.push(localT); continue; }
    // v4.5.3 STOP-BLEED: never let incoming overwrite local with FEWER items, or destroy a session
    // the local operator is building (26 Apr 2026 cross-tab race).
    const localItems = localT.session?.items?.length || 0;
    const incomingItems = incoming.session?.items?.length || 0;
    if (localT.session && (!incoming.session || incomingItems < localItems)) {
      warn?.(localT, localItems, incomingItems);
      merged.push(localT); continue;
    }
    // v4.5.3 timestamp tie-break: a newer local session wins.
    if (localT.session?.updatedAt && incoming.session?.updatedAt && localT.session.updatedAt > incoming.session.updatedAt) {
      merged.push(localT); continue;
    }
    // Operational state from the sender, definition (and plan flags) from step 1.
    const m = { ...incoming };
    for (const f of KEEP_ON_BROADCAST) { if (f in localT) m[f] = localT[f]; else if (LOCAL_FLAGS.includes(f)) delete m[f]; }
    merged.push(m);
  }
  return merged;
}

/**
 * The tables a config push brings (live, cached at boot, or from the update banner).
 *   v2 push (this code, tables built from a fresh plan read in Back Office): each table carries its
 *     srvAt, and every copy is as new as the push's first observation on this machine.
 *   old-code push, or a v2 push whose read failed: no marks at all (seq 0), so it can rename or
 *     add nothing that a plan read on this till has already decided.
 */
export function pushCopies(snap, pushSeq) {
  const v2 = num(snap?.tablePlan?.v) >= 2 && snap.tablePlan.fromRead !== false;
  const snapLoc = snap?.locationId || null;
  return (Array.isArray(snap?.tables) ? snap.tables : []).filter(t => t && t.id).map(st => ({
    ...pickDef(st),
    id: st.id,
    locationId: st.locationId ?? st.location_id ?? snapLoc,
    srvAt: v2 ? num(st.srvAt) : 0,
    srvIso: v2 ? (st.srvIso || null) : null,
    _seq: v2 ? num(pushSeq) : 0,
  }));
}

export function applyPushTables(local, snap, { tombs = {}, plan = null, pushSeq = 0, cleared = null, isClosed = noClosed } = {}) {
  const nextTombs = mergeTombs(tombs, snap?.tableTombstones, { seq: pushSeq, cleared });
  if (!Array.isArray(snap?.tables)) {
    const r = applyTombstones(local, nextTombs, { isClosed });
    return { ...r, tombs: nextTombs };
  }
  const r = mergeDefinitions({ local, incoming: pushCopies(snap, pushSeq), tombs: nextTombs, plan, isClosed });
  return { ...r, tombs: nextTombs };
}

/**
 * The boot table list (SyncBridge), computed from the store AT APPLY TIME.
 *   floorRows  normalised rows of a successful read, or null / [] when it failed or was empty
 *   sessions   { tableId: session } from active_sessions, rpos-session-backup, rpos-session-snapshot
 *              (database first); closed ones are ignored
 * A table in the plan gets its session from `sessions`, else keeps the one in memory (v4.5.0). A
 * failed read changes no definition, but sessions still attach and orphans are still rebuilt, so
 * an offline boot mid order shows every order.
 */
export function bootTables({ local, floorRows, srvReadAt = 0, readSeq = 0, tombs = {}, sessions = {}, isClosed = noClosed, labels = {} } = {}) {
  const sess = sessions instanceof Map ? Object.fromEntries(sessions) : (sessions || {});
  const openIn = (id) => !!sess[id] && !isClosed(id, sess[id]);
  const read = applyPlanRead({ local, rows: floorRows, srvReadAt, readSeq, tombs, isOpen: openIn, isClosed, mode: 'full' });
  const base = read ? read.tables : applyTombstones(local, tombs, { isOpen: openIn, isClosed }).tables;
  const attached = base.map(t => {
    const fromMap = openIn(t.id) ? sess[t.id] : null;
    const session = fromMap || t.session || null;
    return {
      ...t,
      status: session ? (t.parentId ? 'open' : 'occupied') : 'available',
      session,
      firedCourses: session?.firedCourses || t.firedCourses || [],
      sentAt: session?.sentAt || t.sentAt || null,
    };
  });
  const allLabels = { ...labels, ...(read?.labels || {}) };
  const rebuilt = rebuildOrphans(attached, sess, { isClosed, labels: allLabels, tombs });
  return { tables: pruneClosedRemoved(rebuilt, isClosed), read };
}

// ── Back Office ─────────────────────────────────────────────────────────────────────────────

/**
 * Back Office delete guard. Every check must have RUN: a check that could not run refuses.
 *   table        the table being deleted
 *   tables       the Back Office store (split children live there as `<id>-<n>` with parentId)
 *   dbRows       active_sessions rows for the table and its children (both reads), or null
 *   qrRows       open QR tabs from order_queue (customer jsonb), or null
 *   failed       names of the checks that could not run
 */
export function deleteRefusalReason(table, { tables = [], dbRows = [], qrRows = [], failed = [], isClosed = noClosed } = {}) {
  const name = String(table?.label || 'This table').trim() || 'This table';
  const shown = /^\d/.test(name) ? `Table ${name}` : name;   // "4" reads as "Table 4", "T4" stays
  const isMine = (tid) => tid === table?.id || String(tid || '').startsWith(`${table?.id}-`);
  if (openSession(table, isClosed)) return `${shown} has an open order, close or move it first`;
  if ((tables || []).some(t => t.parentId === table?.id && openSession(t, isClosed))) return `${shown} has an open split check, close or move it first`;
  for (const r of dbRows || []) {
    if (!r || !isMine(r.table_id) || !r.session) continue;
    if (isClosed(r.table_id, r.session)) continue;
    return r.table_id === table.id ? `${shown} has an open order on a till, close or move it first` : `${shown} has an open split check on a till, close or move it first`;
  }
  const label = String(table?.label || '').trim().toLowerCase();
  for (const o of qrRows || []) {
    const c = o?.customer || {};
    if (c.tab_open !== true || c.tab_closed) continue;
    const tid = String(c.tableId ?? c.table_id ?? '').trim();
    if (tid && (tid === table?.id || (label && tid.toLowerCase() === label))) return `${shown} has an open QR tab, close it first`;
  }
  if (failed && failed.length) return `Could not check ${shown} for open orders (${failed.join(', ')}), so it was not deleted. Try again`;
  return null;
}

// floor_tables row (snake) -> store table definition (camel), stamped with its version marks and,
// for Back Office compare-and-set, the base it was read as.
export function normaliseFloorRow(t, { locationId = null, readSeq = 0 } = {}) {
  const def = {
    label: t.label,
    x: t.x, y: t.y, w: t.w, h: t.h,
    shape: t.shape,
    maxCovers: t.max_covers ?? t.maxCovers ?? 4,
    section: t.section ?? null,
    sortOrder: t.sort_order ?? t.sortOrder ?? 0,
  };
  const srvIso = t.updated_at || t.srvIso || null;
  return {
    id: t.id,
    ...def,
    locationId: t.location_id ?? t.locationId ?? locationId,
    srvAt: num(t.updated_at) || num(t.srvAt) || 0,
    srvIso: srvIso ? String(srvIso) : null,
    _seq: num(readSeq),
    _base: { ...def },
  };
}

// The row a Back Office write sends (floor_tables columns only).
export function floorRowOf(table, locationId) {
  return {
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
}

// Why a Back Office write of this table must not go out at all (before any request).
export function writeRefusal(table, tombs = {}) {
  if (!table) return 'missing';
  if (table.planRemoved) return 'removed';
  if (table.parentId) return 'child';
  const tomb = normTomb(tombs[table.id]);
  if (tomb && (table._isNew ? false : tombBeats(tomb, table))) return 'deleted';
  if (!table._isNew && !table._base) return 'no-base';
  return null;
}

// ── Local persistence (shared by every tab on the machine) ─────────────────────────────────
const KEY = 'rpos-table-plan';
const SEQ_KEY = 'rpos-table-plan-seq';
let memSeq = 0;
const mem = {};   // used when localStorage is unavailable, so the rules still hold in this page

function ls() {
  try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; }
}

// This machine's observation counter. Monotonic, never a clock. Shared by tabs through
// localStorage; if storage fails it still increases within this page.
export function nextSeq() {
  const s = ls();
  let v = memSeq;
  try { v = Math.max(v, num(s?.getItem(SEQ_KEY))); } catch { /* storage blocked */ }
  v += 1;
  memSeq = v;
  try { s?.setItem(SEQ_KEY, String(v)); } catch { /* storage blocked */ }
  return v;
}

function readAll() {
  const s = ls();
  if (!s) return mem;
  try { const v = JSON.parse(s.getItem(KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

function writeAll(all) {
  const s = ls();
  if (!s) { Object.assign(mem, all); return; }
  try { s.setItem(KEY, JSON.stringify(all)); } catch { /* quota: best effort */ }
}

function validPlan(p) {
  return p && Array.isArray(p.ids) && (num(p.seq) > 0 || num(p.srvReadAt) > 0) ? { seq: num(p.seq), ids: p.ids, srvReadAt: num(p.srvReadAt) } : null;
}

export function loadPlanState(locationId) {
  const empty = { plan: null, tombs: {}, cleared: {}, pushes: {}, labels: {} };
  if (!locationId) return empty;
  const e = readAll()[locationId] || {};
  return {
    plan: validPlan(e.plan),
    tombs: mergeTombs(e.tombs, e.tombstones),    // `tombstones` = the first branch build's key
    cleared: e.cleared && typeof e.cleared === 'object' ? e.cleared : {},
    pushes: e.pushes && typeof e.pushes === 'object' ? e.pushes : {},
    labels: e.labels && typeof e.labels === 'object' ? e.labels : {},
  };
}

/**
 * Save plan state. A plan is kept only if it is at least as new (by seq) as the saved one, so a
 * slower tab cannot put an older read back. Tombstones and labels merge; cleared tombstones are
 * removed from the set and remembered.
 */
export function savePlanState(locationId, { plan, tombs, cleared, labels } = {}) {
  if (!locationId) return;
  const all = readAll();
  const cur = all[locationId] || {};
  const next = { ...cur };
  delete next.tombstones;
  const curPlan = validPlan(cur.plan);
  const p = validPlan(plan);
  if (p && (!curPlan || p.seq >= curPlan.seq)) next.plan = p;
  const clr = { ...(cur.cleared || {}), ...(cleared || {}) };
  let t = mergeTombs(mergeTombs(cur.tombs, cur.tombstones), tombs, { cleared: clr });
  for (const [id, at] of Object.entries(cleared || {})) {
    if (t[id] && !t[id].srv && t[id].at === num(at)) delete t[id];
  }
  next.tombs = t;
  const ck = Object.keys(clr);
  if (ck.length > MAX_TOMBS) for (const k of ck.slice(0, ck.length - MAX_TOMBS)) delete clr[k];
  next.cleared = clr;
  if (labels) {
    const l = { ...(cur.labels || {}), ...labels };
    const lk = Object.keys(l);
    if (lk.length > MAX_LABELS) for (const k of lk.slice(0, lk.length - MAX_LABELS)) delete l[k];
    next.labels = l;
  }
  all[locationId] = next;
  writeAll(all);
}

// The seq at which this machine FIRST observed a push version (recorded on first sight). Every
// later application of the same push (cache at boot, banner, refetch) reuses it, so an old push
// never looks newer than a plan read made after it arrived.
export function pushSeqFor(locationId, version) {
  const v = version == null ? '' : String(version);
  if (!locationId || !v) return 0;
  const all = readAll();
  const cur = all[locationId] || {};
  const pushes = { ...(cur.pushes || {}) };
  if (num(pushes[v]) > 0) return num(pushes[v]);
  const seq = nextSeq();
  pushes[v] = seq;
  const keys = Object.keys(pushes);
  if (keys.length > MAX_PUSHES) {
    keys.sort((a, b) => pushes[a] - pushes[b]);
    for (const k of keys.slice(0, keys.length - MAX_PUSHES)) delete pushes[k];
  }
  const fresh = readAll();
  fresh[locationId] = { ...(fresh[locationId] || cur), pushes };
  writeAll(fresh);
  return seq;
}

export function recordTombstone(locationId, tableId, { at, srv = false, label = null, seq = 0 } = {}) {
  if (!locationId || !tableId || !(num(at) > 0)) return;
  savePlanState(locationId, { tombs: { [tableId]: { at: num(at), srv, seq: num(seq) || nextSeq(), ...(label ? { label } : {}) } } });
}

// A delete that the database REFUSED (the row provably still exists): take the local tombstone
// back, or the restored table would be removed again by the next merge. Never call this on a
// network error: the row may well be gone.
export function forgetTombstone(locationId, tableId) {
  if (!locationId || !tableId) return;
  const all = readAll();
  const cur = all[locationId];
  const t = cur?.tombs?.[tableId] || cur?.tombstones?.[tableId];
  if (!t) return;
  const tombs = { ...(cur.tombs || {}) };
  delete tombs[tableId];
  const legacy = { ...(cur.tombstones || {}) };
  delete legacy[tableId];
  all[locationId] = { ...cur, tombs, tombstones: legacy };
  writeAll(all);
}

// For tests: forget the in-page fallbacks.
export function _resetForTests() { memSeq = 0; for (const k of Object.keys(mem)) delete mem[k]; }
