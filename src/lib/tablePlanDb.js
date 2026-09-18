// Table plan database calls, written against a Supabase-shaped client passed in (db.js passes the
// real one, the tests pass an in-memory one that behaves like PostgREST with and without the
// 20260918b migration). See lib/tablePlan.js for the rules and db.js for the wrappers.

import { floorRowOf } from './tablePlan.js';

// ── The database guard against old code (migration 20260918b) ────────────────────────────────
// A BEFORE INSERT OR UPDATE trigger on floor_tables refuses a write to an id whose tombstone is
// newer than the row's last updated_at, so a Back Office tab or WebView still on the pre deploy
// bundle gets a refused save (which it already shows as a failed save) instead of silently
// putting a deleted table back on every till.
// The ONE way past it is the column flag recreate_deleted = true on the write. Only this client
// sends it, and only on the insert of a table a person has just added in this tab (_isNew,
// insert-only, so it can never overwrite anything). The trigger resets it to false before the row
// is stored, so no copy of a row read back can ever carry it into a later write.
export const RECREATE_COL = 'recreate_deleted';
export const TOMBSTONE_REFUSED = 'floor_table_deleted';
export const isTombstoneRefusal = (err) => !!err && String(err.message || '').includes(TOMBSTONE_REFUSED);
// Before 20260918b runs the column does not exist: PostgREST says PGRST204 (schema cache), Postgres
// says 42703. Then the insert is sent again without the flag (there is no guard to pass either).
const isMissingRecreateCol = (err) => !!err && (err.code === 'PGRST204' || err.code === '42703')
  && String(err.message || '').includes(RECREATE_COL);

export const BASE_COLS = [['label', 'label'], ['x', 'x'], ['y', 'y'], ['w', 'w'], ['h', 'h'], ['shape', 'shape'], ['maxCovers', 'max_covers'], ['section', 'section'], ['sortOrder', 'sort_order']];

/**
 * Back Office write of ONE table, compare-and-set, never a blind upsert.
 *   new table (table._isNew)   INSERT only: an id that already exists is refused, never overwritten
 *   existing table             UPDATE ... WHERE updated_at = the value this tab last read (after
 *                              20260918b), or WHERE every column still equals what this tab last
 *                              read (before it). Anything else changed or deleted it meanwhile.
 * Result: { ok, row } or { ok: false, conflict: 'changed' | 'deleted' | 'exists' | 'refused', error }.
 * A stale tab can therefore never put back an old name, a moved table, or a deleted table.
 */
export async function saveTableChecked(client, table, locationId) {
  if (!client) return { ok: false, error: new Error('No database') };
  if (!locationId) return { ok: false, error: new Error('No location') };
  if (!table?.id) return { ok: false, error: new Error('No table') };
  if (table.planRemoved || table.parentId) return { ok: false, conflict: 'deleted', error: new Error('This table is not on the plan any more') };
  if (table.locationId && table.locationId !== locationId) {
    return { ok: false, error: new Error(`refusing to move table ${table.id} from ${table.locationId} to ${locationId}`) };
  }
  const row = floorRowOf(table, locationId);
  if (table._isNew) {
    // A person added this table here: the explicit re-create signal (see RECREATE_COL above).
    let res = await client.from('floor_tables').insert({ ...row, [RECREATE_COL]: true }).select('*');
    if (res.error && isMissingRecreateCol(res.error)) res = await client.from('floor_tables').insert(row).select('*');
    if (res.error) {
      if (res.error.code === '23505') return { ok: false, conflict: 'exists', error: res.error };
      if (isTombstoneRefusal(res.error)) return { ok: false, conflict: 'deleted', error: res.error };
      return { ok: false, error: res.error };
    }
    return { ok: true, row: res.data?.[0] || null };
  }
  if (!table._base && !table.srvIso) return { ok: false, conflict: 'changed', error: new Error('No saved copy to compare with, reload the floor plan') };
  const { id: _id, location_id: _loc, ...patch } = row;
  let q = client.from('floor_tables').update(patch).eq('id', table.id).eq('location_id', locationId);
  if (table.srvIso) q = q.eq('updated_at', table.srvIso);
  else {
    for (const [k, col] of BASE_COLS) {
      const v = table._base[k];
      q = (v === null || v === undefined) ? q.is(col, null) : q.eq(col, v);
    }
  }
  const res = await q.select('*');
  if (res.error) {
    if (isTombstoneRefusal(res.error)) return { ok: false, conflict: 'deleted', error: res.error };
    return { ok: false, error: res.error };
  }
  if (res.data && res.data.length) return { ok: true, row: res.data[0] };
  // Nothing matched: find out why, in plain words for the toast.
  const probe = await client.from('floor_tables').select('*').eq('id', table.id).eq('location_id', locationId).maybeSingle();
  if (probe.error) return { ok: false, conflict: 'changed', error: probe.error };
  if (!probe.data) return { ok: false, conflict: 'deleted', error: new Error('deleted on another screen') };
  const same = table.srvIso
    ? String(probe.data.updated_at || '') === String(table.srvIso)
    : BASE_COLS.every(([k, col]) => (probe.data[col] ?? null) === (table._base[k] ?? null));
  return { ok: false, conflict: same ? 'refused' : 'changed', error: new Error(same ? 'the database refused the save' : 'changed on another screen') };
}

/**
 * Everything the delete guard must see (FloorPlanBuilder). Each leg that fails is named in
 * `failed`, and the guard refuses the delete when any leg failed.
 *   active_sessions  the table AND its split child checks (id-n)
 *   order_queue      open QR tabs (customer jsonb, never bar_tabs), filtered to open tabs ON THE
 *                    SERVER (customer->>tab_open = true), newest first. A result that fills the
 *                    limit may have left an open tab out, so it refuses like a failed leg.
 */
export const QR_TAB_LIMIT = 500;
export async function openOrdersFor(client, locationId, tableId) {
  if (!client) return { dbRows: [], qrRows: [], failed: ['database'] };
  if (!locationId || locationId === 'loc-demo' || !tableId) return { dbRows: [], qrRows: [], failed: ['location'] };
  const failed = [];
  const safe = (p) => Promise.resolve(p).catch(e => ({ data: null, error: e }));
  const [own, kids, qr] = await Promise.all([
    safe(client.from('active_sessions').select('table_id, session').eq('location_id', locationId).eq('table_id', tableId)),
    safe(client.from('active_sessions').select('table_id, session').eq('location_id', locationId).like('table_id', `${tableId}-%`)),
    safe(client.from('order_queue').select('ref, status, customer').eq('location_id', locationId).eq('source', 'qr')
      .neq('status', 'collected').eq('customer->>tab_open', 'true')
      .order('created_at', { ascending: false }).limit(QR_TAB_LIMIT)),
  ]);
  if (own.error || !Array.isArray(own.data)) failed.push('open orders');
  if (kids.error || !Array.isArray(kids.data)) failed.push('split checks');
  if (qr.error || !Array.isArray(qr.data)) failed.push('QR tabs');
  else if (qr.data.length >= QR_TAB_LIMIT) failed.push(`QR tabs, more than ${QR_TAB_LIMIT - 1} open`);
  return { dbRows: [...(own.data || []), ...(kids.data || [])], qrRows: qr.data || [], failed };
}

// ── The versioned plan read ─────────────────────────────────────────────────────────────────
// floor_plan_read (migration 20260918b) returns the rows and `at`, the highest updated_at among
// them (a fact about this read, used for diagnosis only: no table is removed or blocked by a
// server time, see tablePlan.admits). Before the migration the function is missing and a plain
// select is used. A missing function is remembered for RETRY_MS only, then tried again, so a page
// that stays open while Peter runs the migration picks it up without a reload.
export const PLAN_RPC_RETRY_MS = 10 * 60 * 1000;
export const planRpcLatch = { until: 0 };
const isMissingFunction = (err) => !!err && (err.code === 'PGRST202' || err.code === '42883'
  || /floor_plan_read/.test(String(err.message || '')));

export async function readFloorPlan(client, locationId, { latch = planRpcLatch, now = () => Date.now() } = {}) {
  let tables = null, srvReadAt = 0, error = null;
  if (!(latch.until > now())) {
    try {
      const r = await client.rpc('floor_plan_read', { p_location_id: locationId });
      if (!r.error && r.data && Array.isArray(r.data.tables)) {
        tables = r.data.tables;
        srvReadAt = Number(r.data.at) || 0;
        latch.until = 0;
      } else if (r.error && isMissingFunction(r.error)) latch.until = now() + PLAN_RPC_RETRY_MS;
    } catch { /* fall back to the plain read */ }
  }
  if (!tables) {
    try {
      const t = await client.from('floor_tables').select('*').eq('location_id', locationId).order('sort_order');
      if (t.error) error = t.error;
      else tables = Array.isArray(t.data) ? t.data : null;
    } catch (e) { error = e; }
  }
  return { tables, srvReadAt, error };
}
