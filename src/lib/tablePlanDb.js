// Table plan database calls, written against a Supabase-shaped client passed in (db.js passes the
// real one, the tests pass an in-memory one that behaves like PostgREST with and without the
// 20260918b migration). See lib/tablePlan.js for the rules and db.js for the wrappers.

import { floorRowOf } from './tablePlan.js';

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
    const res = await client.from('floor_tables').insert(row).select('*');
    if (res.error) {
      if (res.error.code === '23505') return { ok: false, conflict: 'exists', error: res.error };
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
  if (res.error) return { ok: false, error: res.error };
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
 *   order_queue      open QR tabs (customer jsonb, never bar_tabs)
 */
export async function openOrdersFor(client, locationId, tableId) {
  if (!client) return { dbRows: [], qrRows: [], failed: ['database'] };
  if (!locationId || locationId === 'loc-demo' || !tableId) return { dbRows: [], qrRows: [], failed: ['location'] };
  const failed = [];
  const safe = (p) => Promise.resolve(p).catch(e => ({ data: null, error: e }));
  const [own, kids, qr] = await Promise.all([
    safe(client.from('active_sessions').select('table_id, session').eq('location_id', locationId).eq('table_id', tableId)),
    safe(client.from('active_sessions').select('table_id, session').eq('location_id', locationId).like('table_id', `${tableId}-%`)),
    safe(client.from('order_queue').select('ref, status, customer').eq('location_id', locationId).eq('source', 'qr').neq('status', 'collected').limit(1000)),
  ]);
  if (own.error || !Array.isArray(own.data)) failed.push('open orders');
  if (kids.error || !Array.isArray(kids.data)) failed.push('split checks');
  if (qr.error || !Array.isArray(qr.data)) failed.push('QR tabs');
  return { dbRows: [...(own.data || []), ...(kids.data || [])], qrRows: qr.data || [], failed };
}
