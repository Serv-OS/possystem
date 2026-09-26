// src/lib/rowWriteFence.js: database fence stage 1, fix round 2 (the zero row blocker).
//
// Row level security does not REFUSE an update or a delete of a row it hides. It changes
// nothing and answers success: no error, 0 rows. Once 20260919a has run, a till that lost its
// link (a "pair again" till, a till whose login changed) reads and writes nothing of bar_tabs and
// closed_checks, and after 20260919b nothing of active_sessions, order_queue, kds_tickets and
// print_jobs either. Before this file every one of those writes was counted as done: a bar tab
// closed and paid on such a till stayed open on every other till, a refund never reached the
// server, a settled table stayed on the floor. Proven on the harness (round 1 floor review).
//
// The rule, for every update and delete that must change a row:
//   1. Ask for the rows back (select after the write) and count them.
//   2. None changed: ask the server whether this device is still linked (device_status), in a
//      check that STARTS after the write answered.
//        - linked, and no re-link happened while the write was in flight: the row really is
//          gone (or already as asked, a closed tab stays closed). Done.
//        - linked, but a re-link landed while the write was in flight: the write may have run
//          before it. Send it once more (it changed nothing, so it cannot apply twice).
//        - not linked: PARK the write (OfflineQueue, status 'parked_link'), show the banner, and
//          send it again when the device is linked again (rpos-device-relinked, or the first
//          'linked' of a page after Pair again). Never lost, never sent twice.
//        - the check itself failed: keep the write and try again with the next replay.
//        - not a device (Back Office, a customer page) or the fence functions do not exist yet
//          (before 20260919a, FENCE STAGE 1 FALLBACK): today's behaviour, done.
//   3. A later write of a row that has a parked write waits behind it, so the row always ends
//      as its LAST write says (a refund's pending entry then its outcome, a bump then a recall).
//
// Pure: no Supabase, no window, no storage. The callers inject the client, the link check,
// the link epoch and the queue (lib/rowWrites.js wires the real ones; sync/OfflineQueue.js uses
// replayMustChangeItem for its own update and delete replays), so node:test drives every branch
// with a fake client.

import { isPermissionError, PARKED_LINK_STATUS } from './deviceFence.js';

/** The tables whose update or delete must change a row (fix round 2, BLOCKER). */
export const MUST_CHANGE_TABLES = Object.freeze(['bar_tabs', 'active_sessions', 'order_queue', 'closed_checks', 'kds_tickets', 'print_jobs']);

/** OfflineQueue status of a write parked until this device is linked again. */
export const PARKED_LINK = PARKED_LINK_STATUS;

/** The column in an active_sessions match that pins ONE occupation (session.seatedAt, write once). */
export const OCCUPATION_KEY = 'session->>seatedAt';

/** Why a write is parked. Both read as a refused write (lib/deviceFence.js isPermissionError). */
export const ZERO_ROWS_UNLINKED = 'row-level security: 0 rows changed while this device is not linked. Kept, sent again once it is linked.';
export const ZERO_ROWS_UNKNOWN = 'row-level security: 0 rows changed and the device link could not be checked. Kept, tried again.';

/** How many times one write is sent when a re-link keeps landing while it is in flight. */
export const MAX_WRITE_ATTEMPTS = 3;

// The columns that name ONE row, per table. They are what a select after the write returns and
// what "a later write of the same row" compares.
const ROW_KEYS = Object.freeze({
  bar_tabs: ['id'],
  order_queue: ['location_id', 'ref'],
  active_sessions: ['location_id', 'table_id'],
  closed_checks: ['id'],
  kds_tickets: ['id'],
  print_jobs: ['id'],
});

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The columns a select after the write returns: the table's own row key, never the payload. */
export function returningColumns(table, match = {}) {
  const cols = ROW_KEYS[table];
  if (cols) return cols.join(', ');
  const first = Object.keys(isPlainObject(match) ? match : {})[0];
  return first && !first.includes('->') ? first : 'id';
}

/**
 * "Which row is this?" for ordering: the table plus the values of its row key columns, from the
 * match (or the payload of an upsert). null when a key column is missing (no ordering then).
 */
export function rowKeyOf(item) {
  const cols = item && ROW_KEYS[item.table];
  if (!cols) return null;
  const src = { ...(isPlainObject(item.payload) ? item.payload : {}), ...(isPlainObject(item.match) ? item.match : {}) };
  const vals = cols.map((c) => src[c]);
  if (vals.some((v) => v === undefined || v === null || v === '')) return null;
  return `${item.table}|${vals.map(String).join('|')}`;
}

/**
 * The match that pins one table occupation for an active_sessions delete that may be sent late:
 * a delete replayed minutes later must never remove a table that was seated again since (a new
 * party has a new seatedAt, INVARIANTS: write once per occupation). {} when there is no seatedAt
 * (then the delete keeps today's short replay window, OfflineQueue SESSION_DELETE_MAX_AGE_MS).
 */
export function occupationMatch(seatedAt) {
  if (seatedAt === undefined || seatedAt === null || seatedAt === '' || seatedAt === 0) return {};
  return { [OCCUPATION_KEY]: String(seatedAt) };
}

/** The seatedAt of a session, from the object or the JSON string SessionSync keeps (_lastSent). */
export function seatedAtOf(session) {
  let s = session;
  if (typeof s === 'string') {
    if (!s || s === 'cleared') return null;
    try { s = JSON.parse(s); } catch { return null; }
  }
  const v = isPlainObject(s) ? s.seatedAt : null;
  return v === undefined || v === null || v === '' || v === 0 ? null : v;
}

/**
 * The supabase-js query for one write: update or delete, eq filters from match, neq filters from
 * notMatch, an optional `in` list, and a select of the row key so the answer says how many rows
 * changed. The OfflineQueue item shape (type, table, payload, match, notMatch) is the same, so a
 * parked write replays through this very builder.
 */
export function buildWriteQuery(client, { table, type, payload, match = {}, notMatch = {}, inList = null, returning: cols = null } = {}, { returning } = {}) {
  let q = type === 'delete' ? client.from(table).delete() : client.from(table).update(payload);
  for (const [k, v] of Object.entries(isPlainObject(match) ? match : {})) q = q.eq(k, v);
  for (const [k, v] of Object.entries(isPlainObject(notMatch) ? notMatch : {})) q = q.neq(k, v);
  if (inList && inList.column && Array.isArray(inList.values)) q = q.in(inList.column, inList.values);
  return q.select(returning || cols || returningColumns(table, match));
}

/** Rows changed, from a { data, error } answer: a number, or null when the answer cannot say. */
export function rowsChanged(res) {
  if (!res || res.error) return null;
  if (Array.isArray(res.data)) return res.data.length;
  if (isPlainObject(res.data)) return 1;
  if (typeof res.count === 'number') return res.count;
  return null;
}

/**
 * After a write that changed nothing (or was refused), what now?
 *   linkState: 'bound' | 'unbound' | 'unsupported' | 'unknown' | 'not_device'
 *   relinkedSince: a device link call answered linked or relinked on this page after the write
 *                  was sent (lib/deviceLink.js getLinkEpoch moved)
 * Returns 'done' | 'retry' | 'park' | 'retry_later'.
 */
export function zeroRowDecision({ linkState, relinkedSince = false } = {}) {
  if (linkState === 'not_device' || linkState === 'unsupported') return 'done';
  if (linkState === 'bound') return relinkedSince ? 'retry' : 'done';
  if (linkState === 'unbound') return 'park';
  return 'retry_later';
}

/**
 * The OfflineQueue item for a write that must wait: 'park' waits for the link (status
 * 'parked_link', not retried until the device is linked again, never counted as a failure);
 * 'retry_later' is retried with the next replay and released on relink too.
 */
export function parkedWriteItem(write, { reason = 'park', now = Date.now(), epoch = 0, match } = {}) {
  const later = reason === 'retry_later';
  const item = {
    type: write.type,
    table: write.table,
    match: match || write.replayMatch || write.match || {},
    ts: now,
    status: later ? 'retry_pending' : PARKED_LINK,
    attempts: later ? 1 : 0,
    lastError: later ? ZERO_ROWS_UNKNOWN : ZERO_ROWS_UNLINKED,
    lastFailedAt: now,
    firstFailedAt: now,
    zeroRows: true,
    linkEpoch: epoch,
  };
  if (write.type === 'update') item.payload = write.payload;
  if (isPlainObject(write.notMatch) && Object.keys(write.notMatch).length) item.notMatch = write.notMatch;
  if (write.kind) item.kind = write.kind;
  if (write.label) item.label = write.label;
  return item;
}

/** The plain queue item (status pending) for a write that waits behind a parked write. */
export function queuedWriteItem(write) {
  const item = { type: write.type, table: write.table, match: write.replayMatch || write.match || {} };
  if (write.type === 'update') item.payload = write.payload;
  if (isPlainObject(write.notMatch) && Object.keys(write.notMatch).length) item.notMatch = write.notMatch;
  if (write.kind) item.kind = write.kind;
  if (write.label) item.label = write.label;
  return item;
}

const safe = async (fn, fallback) => { try { return await fn(); } catch { return fallback; } };

/**
 * Send one write that must change a row, and keep it when it could not (the rule at the top).
 *
 * write: { table, type: 'update' | 'delete', payload, match, notMatch, replayMatch?, kind?, label?,
 *          parkable? }
 *   replayMatch  the match a parked copy uses (an active_sessions delete adds its occupation)
 *   parkable     false: never kept (a derived write, for example the QR floor summary, which a late
 *                replay would only make stale). The link is still checked, so the banner shows.
 * deps: { client, confirmLink, linkEpoch, park, parkedRowKeys, queueBehind, afterPark, now }
 *
 * Resolves { outcome, rows?, data?, error? }:
 *   'applied'  a row changed
 *   'gone'     nothing to change and the device is linked (or not a device): done
 *   'parked'   kept on this device, sent again once it is linked (or with the next replay)
 *   'queued'   an earlier write of this row is parked: this one waits behind it
 *   'unlinked' nothing changed, the device is not linked, and the write is not parkable
 *   'error'    the database refused it for another reason, or the client threw (the caller keeps
 *              its own error handling, as before)
 */
export async function runMustChangeWrite(write, deps = {}) {
  const { client, confirmLink, linkEpoch = () => 0, park, parkedRowKeys, queueBehind, afterPark, now = () => Date.now() } = deps;
  if (!client || !write || !write.table || (write.type !== 'update' && write.type !== 'delete')) {
    return { outcome: 'error', error: new Error('mustChangeRow: an update or delete with a table is needed') };
  }
  const parkable = write.parkable !== false;

  // A parked write of this row goes first: this one waits behind it, in order.
  const key = parkable ? rowKeyOf(write) : null;
  if (key && parkedRowKeys && queueBehind) {
    const keys = await safe(parkedRowKeys, null);
    if (keys && keys.has(key)) {
      const queued = await safe(async () => { await queueBehind(queuedWriteItem(write)); return true; }, false);
      if (queued) return { outcome: 'queued' };
    }
  }

  let refusedError = null;
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    const epoch = linkEpoch();
    let res;
    try { res = await buildWriteQuery(client, write); }
    catch (e) { return { outcome: 'error', error: e }; }
    const refused = !!(res && res.error && isPermissionError(res.error));
    if (res && res.error && !refused) return { outcome: 'error', error: res.error };
    const n = rowsChanged(res);
    if (!refused && (n === null || n > 0)) return { outcome: 'applied', rows: n, data: res ? res.data : null };
    refusedError = refused ? res.error : null;

    const linkState = confirmLink ? await safe(confirmLink, 'unknown') : 'not_device';
    const decision = zeroRowDecision({ linkState, relinkedSince: linkEpoch() !== epoch });
    if (decision === 'done') return refused ? { outcome: 'error', error: res.error } : { outcome: 'gone', rows: 0 };
    if (decision === 'retry' && attempt < MAX_WRITE_ATTEMPTS) continue;
    if (!parkable) return { outcome: 'unlinked', error: refusedError };
    const item = parkedWriteItem(write, { reason: decision === 'park' ? 'park' : 'retry_later', now: now(), epoch: linkEpoch() });
    try { await park(item); }
    catch (e) { return { outcome: 'error', error: e }; }
    try { if (afterPark) afterPark(item); } catch { /* the banner and re-link are best effort */ }
    return { outcome: 'parked', reason: item.status, error: refusedError };
  }
  return { outcome: 'error', error: refusedError || new Error('mustChangeRow: no answer') };
}

/**
 * The same rule for one write of MANY rows by key (a batched delete of tables, the rounds of a QR
 * tab): `in` on inColumn. Keys that came back changed; the others are checked once against the
 * link and each is kept on its own (its own match, plus identityFor(key), for example the
 * occupation of a table), or counted as gone.
 *
 * batch: { table, type, payload?, match, inColumn, keys, identityFor?, kind?, label?, parkable? }
 * Resolves { outcome: 'applied' | 'parked' | 'unlinked' | 'error', changed, gone, parked, queued, error? }
 */
export async function runMustChangeMany(batch, deps = {}) {
  const { client, confirmLink, linkEpoch = () => 0, park, parkedRowKeys, queueBehind, afterPark, now = () => Date.now() } = deps;
  const { table, type, payload, match = {}, inColumn, identityFor, kind, label } = batch || {};
  const parkable = !batch || batch.parkable !== false;
  const out = { outcome: 'applied', changed: [], gone: [], parked: [], queued: [] };
  if (!client || !table || !inColumn || (type !== 'update' && type !== 'delete')) {
    return { ...out, outcome: 'error', error: new Error('mustChangeRows: an update or delete by key is needed') };
  }
  const keyWrite = (k) => ({
    table, type, payload, kind, label,
    match: { ...match, [inColumn]: k },
    replayMatch: { ...match, [inColumn]: k, ...(identityFor ? (identityFor(k) || {}) : {}) },
  });
  let pending = [...new Set((batch.keys || []).filter((k) => k !== undefined && k !== null && k !== '').map(String))];
  if (!pending.length) return out;

  // Rows with a parked write wait behind it.
  if (parkable && parkedRowKeys && queueBehind) {
    const keys = await safe(parkedRowKeys, null);
    if (keys && keys.size) {
      const behind = pending.filter((k) => keys.has(rowKeyOf(keyWrite(k))));
      for (const k of behind) {
        const ok = await safe(async () => { await queueBehind(queuedWriteItem(keyWrite(k))); return true; }, false);
        if (ok) out.queued.push(k);
      }
      pending = pending.filter((k) => !out.queued.includes(k));
    }
  }

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS && pending.length; attempt += 1) {
    const epoch = linkEpoch();
    let res;
    try {
      res = await buildWriteQuery(client, { table, type, payload, match, inList: { column: inColumn, values: pending } }, { returning: inColumn });
    } catch (e) { return { ...out, outcome: 'error', error: e }; }
    const refused = !!(res && res.error && isPermissionError(res.error));
    if (res && res.error && !refused) return { ...out, outcome: 'error', error: res.error };
    let got;
    if (refused) got = new Set();
    else if (Array.isArray(res && res.data)) got = new Set(res.data.map((r) => String(r && r[inColumn])));
    else got = new Set(pending);   // the answer cannot say: today's behaviour, counted as done
    for (const k of pending) if (got.has(k)) out.changed.push(k);
    const missing = pending.filter((k) => !got.has(k));
    if (!missing.length) break;

    const linkState = confirmLink ? await safe(confirmLink, 'unknown') : 'not_device';
    const decision = zeroRowDecision({ linkState, relinkedSince: linkEpoch() !== epoch });
    if (decision === 'done') {
      if (refused) return { ...out, outcome: 'error', error: res.error };
      out.gone.push(...missing);
      pending = [];
      break;
    }
    if (decision === 'retry' && attempt < MAX_WRITE_ATTEMPTS) { pending = missing; continue; }
    if (!parkable) return { ...out, outcome: 'unlinked', unlinked: missing };
    for (const k of missing) {
      const item = parkedWriteItem(keyWrite(k), { reason: decision === 'park' ? 'park' : 'retry_later', now: now(), epoch: linkEpoch() });
      try { await park(item); out.parked.push(k); }
      catch (e) { return { ...out, outcome: 'error', error: e }; }
    }
    try { if (afterPark) afterPark(); } catch { /* best effort */ }
    pending = [];
  }
  if (out.parked.length) out.outcome = 'parked';
  return out;
}

/**
 * OfflineQueue's own replay of a queued update or delete, through the same rule. It never parks by
 * itself (the item is already in the queue); it says what the queue should do with the item:
 *   'applied' | 'gone'   done, remove it
 *   'park'               keep it until the device is linked again (not counted as a failure)
 *   'retry_later'        keep it and try with the next replay (counted as a refused attempt)
 *   'error'              the database refused it for another reason (today's failure path)
 */
export async function replayMustChangeItem(item, deps = {}) {
  const { client, confirmLink, linkEpoch = () => 0 } = deps;
  if (!client || !item || (item.type !== 'update' && item.type !== 'delete')) {
    return { outcome: 'error', error: new Error('replayMustChangeItem: an update or delete is needed') };
  }
  let refusedError = null;
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
    const epoch = linkEpoch();
    let res;
    try { res = await buildWriteQuery(client, item); }
    catch (e) { return { outcome: 'error', error: e }; }
    const refused = !!(res && res.error && isPermissionError(res.error));
    if (res && res.error && !refused) return { outcome: 'error', error: res.error };
    const n = rowsChanged(res);
    if (!refused && (n === null || n > 0)) return { outcome: 'applied', rows: n };
    refusedError = refused ? res.error : null;
    const linkState = confirmLink ? await safe(confirmLink, 'unknown') : 'not_device';
    const decision = zeroRowDecision({ linkState, relinkedSince: linkEpoch() !== epoch });
    if (decision === 'done') return refused ? { outcome: 'error', error: res.error } : { outcome: 'gone' };
    if (decision === 'retry' && attempt < MAX_WRITE_ATTEMPTS) continue;
    // epoch: the link epoch the decision was made at. If it moves before the queue has stored the
    // parked item, a relink may already have released the parked writes without it.
    return { outcome: decision === 'park' ? 'park' : 'retry_later', error: refusedError, epoch: linkEpoch() };
  }
  return { outcome: 'retry_later', error: refusedError, epoch: linkEpoch() };
}

/**
 * Row keys a NEW live write of the same row must queue behind (runMustChangeWrite parkedRowKeys):
 * a write parked for the link, and a 0 row write that is still waiting to go again (released on
 * relink but not replayed yet, or kept because the link could not be checked). Without the second
 * group a live write made in the second between a relink and the replay would land first, and the
 * older replayed write would then overwrite it (a recall undone by the bump before it).
 */
export function waitingRowKeys(items) {
  const out = new Set();
  for (const it of items || []) {
    if (!it || it.permanentFailure || it.status === 'dismissed' || it.status === 'failed_stale') continue;
    const waiting = it.status === PARKED_LINK
      || (it.zeroRows === true && (it.status === 'pending' || it.status === 'retry_pending'));
    if (!waiting) continue;
    const k = rowKeyOf(it);
    if (k) out.add(k);
  }
  return out;
}

/**
 * A delete kept while this device was not linked that can only ever remove its OWN row: a bar tab
 * by its id (minted once, never reused) or a table by its occupation (session->>seatedAt, write once
 * per party). OfflineQueue sends these whenever the device is linked again, however long that took,
 * instead of holding them back after 12 hours like other state writes: replayed late they cannot
 * bring anything back or remove anything newer, and a paid tab or table must not stay open for ever
 * because its till was paired again the next morning. Order refs are reused over time, so an
 * order_queue delete is NOT one of these.
 */
export function isLateSafeParkedDelete(item) {
  if (!item || item.zeroRows !== true || item.type !== 'delete') return false;
  const m = isPlainObject(item.match) ? item.match : {};
  if (item.table === 'bar_tabs') return typeof m.id === 'string' && m.id.length > 0;
  if (item.table === 'active_sessions') return !!(m[OCCUPATION_KEY] && m.table_id && m.location_id);
  return false;
}

/**
 * OfflineQueue replay order inside ONE pass: once a write of a row did not land (kept for the
 * link, kept to try again, or refused), every later write of that row waits for the next pass, so
 * the row always ends as its LAST write says. replayItem outcome: 'done' lets the row go on.
 */
export function replayBlocksRow(outcome) {
  return outcome !== 'done';
}

/**
 * OfflineQueue replay order: a queued write of a row that has an OLDER parked write waits behind
 * it (the parked one is released, then both replay in queue order). Returns the set of queue ids
 * to hold back this pass.
 */
export function heldBehindParked(items) {
  const firstParked = new Map();
  for (const it of items || []) {
    if (!it || it.status !== PARKED_LINK) continue;
    const k = rowKeyOf(it);
    if (!k) continue;
    const prev = firstParked.get(k);
    if (prev === undefined || Number(it.id) < prev) firstParked.set(k, Number(it.id));
  }
  const held = new Set();
  if (!firstParked.size) return held;
  for (const it of items || []) {
    if (!it || it.status === PARKED_LINK || it.status === 'dismissed') continue;
    const k = rowKeyOf(it);
    if (k && firstParked.has(k) && Number(it.id) > firstParked.get(k)) held.add(it.id);
  }
  return held;
}

/** An OfflineQueue item parked for the link goes back to pending (keeps its time and order). */
export function parkedAgain(item, { now = Date.now() } = {}) {
  return {
    ...item,
    status: PARKED_LINK,
    lastError: ZERO_ROWS_UNLINKED,
    lastFailedAt: now,
    firstFailedAt: item.firstFailedAt || now,
    zeroRows: true,
  };
}

// ── A VOID closes an occupation that never had a seatedAt (v5.9.81) ──────────────────────────
// Leeds, 26 Sep 2026 (Peter: "it still reloads after voiding"): a QR floor session (session.source
// 'qr') has no seatedAt, only openedAt, so the void's tombstone carried seated_at null and matched
// nothing; the till's reconciler rebuilt the table every 15 s and put the order back. A void now
// stores the occupation's openedAt as its seated_at when there is no seatedAt, and ONLY a VOID is
// matched that way: a payment close of a QR table is never keyed on openedAt, because openedAt is
// recomputed from the open QR rounds and a still open sub tab could share it.
const isVoidCheck = (c) => !!c && (c.voided === true || c.status === 'void');
const ms = (v) => (v == null || v === '' ? 0 : typeof v === 'number' ? v : new Date(v).getTime() || 0);

/** The occupation key a VOID tombstone stores: seatedAt, else openedAt, else null. */
export function voidOccupationKey(session) {
  if (!isPlainObject(session)) return null;
  return ms(session.seatedAt) || ms(session.openedAt) || null;
}

/**
 * True when a close record ends THIS occupation. seatedAt sessions: any close with the same
 * seated_at (unchanged rule). A session with no seatedAt: only a VOID whose seated_at is the
 * session's openedAt.
 *   check    a closed check in any shape (store camelCase, database snake_case)
 */
export function checkClosesOccupation(tableId, session, check) {
  if (!tableId || !isPlainObject(session) || !check) return false;
  if ((check.tableId ?? check.table_id ?? null) !== tableId) return false;
  const key = ms(check.seatedAt ?? check.seated_at);
  if (!key) return false;
  const seated = ms(session.seatedAt);
  if (seated) return key === seated;
  const opened = ms(session.openedAt);
  return !!opened && key === opened && isVoidCheck(check);
}
