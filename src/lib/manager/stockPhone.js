// src/lib/manager/stockPhone.js
//
// MULTI SITE STOCK, Phase 1b (v5.11.80): counting and waste on the phone, the client side.
//   * Every figure is kept on the phone first (an outbox in localStorage, per count) with the time it
//     was typed, then sent in batches; a dropped signal loses nothing and the figure keeps its own
//     time (the server checks the phone's clock: _shared/stockPhone.js countedAt).
//   * A barcode (scanner, camera or typed) finds the item by barcode, then by SKU: the company
//     barcode is the same at every site.
// PURE apart from the storage passed in, so node --test drives it (stockPhone.test.js).

export const BATCH = 200;

const memoryStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
const safeStore = (store) => store || (typeof localStorage !== 'undefined' ? localStorage : memoryStore());
const key = (countId) => `mgr-count-outbox:${countId}`;

function read(store, countId) {
  try { const v = JSON.parse(safeStore(store).getItem(key(countId)) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function write(store, countId, list) {
  try { if (list.length) safeStore(store).setItem(key(countId), JSON.stringify(list)); else safeStore(store).removeItem(key(countId)); } catch { /* private mode: kept in memory by the caller */ }
}

/** Keep a figure on the phone. The newest figure for an item replaces an unsent older one. */
export function queueEntry(countId, entry, { store = null, now = () => new Date() } = {}) {
  const list = read(store, countId).filter((e) => !(e.item_id === entry.item_id && (e.area_id || null) === (entry.area_id || null)));
  list.push({ item_id: entry.item_id, area_id: entry.area_id || null, qty_base: Number(entry.qty_base), counted_at: entry.counted_at || now().toISOString() });
  write(store, countId, list);
  return list.length;
}

export const pendingEntries = (countId, { store = null } = {}) => read(store, countId);

/**
 * Send what waits, BATCH at a time, oldest first. send(entries, sentAtIso) resolves { ok, error }.
 * Sent figures leave the outbox; a failure keeps the rest for next time. Returns { sent, left, error }.
 */
export async function flushEntries(countId, send, { store = null, now = () => new Date() } = {}) {
  let list = read(store, countId);
  let sent = 0;
  while (list.length) {
    const batch = list.slice(0, BATCH);
    let r;
    try { r = await send(batch, now().toISOString()); } catch (e) { r = { ok: false, error: e?.message || 'offline' }; }
    if (!r || r.ok === false || r.error) return { sent, left: list.length, error: (r && r.error) || 'not saved' };
    // a figure typed again while the batch was in flight stays (it is newer)
    const fresh = read(store, countId);
    const sentKeys = new Set(batch.map((e) => `${e.item_id}|${e.area_id || ''}|${e.counted_at}`));
    list = fresh.filter((e) => !sentKeys.has(`${e.item_id}|${e.area_id || ''}|${e.counted_at}`));
    write(store, countId, list);
    sent += batch.length;
  }
  return { sent, left: 0, error: null };
}

/** The item a scanned or typed code points at: barcode first, then SKU (case does not matter). */
export function findByCode(items, code) {
  const c = String(code || '').trim();
  if (!c) return null;
  const list = items || [];
  return list.find((i) => i.barcode && String(i.barcode).trim() === c)
    || list.find((i) => i.sku && String(i.sku).trim().toLowerCase() === c.toLowerCase())
    || null;
}

/** A typed figure to base units: in the count pack when the item has one and `inPacks`. */
export function toBaseQty(typed, item, inPacks = true) {
  const v = Number(String(typed ?? '').replace(',', '.'));
  if (!Number.isFinite(v) || v < 0 || String(typed ?? '').trim() === '') return null;
  const per = inPacks && item?.count_pack?.qty > 0 ? Number(item.count_pack.qty) : 1;
  return Math.round(v * per * 10000) / 10000;
}

/** "3 Case (18 l)" or "500 g" for a figure in base units. */
export function qtyWords(base, item) {
  if (base == null) return '';
  const unit = item?.base_unit || '';
  const pack = item?.count_pack;
  if (pack && pack.qty > 0) {
    const n = Math.round((Number(base) / pack.qty) * 100) / 100;
    return `${n} ${pack.name} (${Math.round(Number(base) * 1000) / 1000} ${unit})`.trim();
  }
  return `${Math.round(Number(base) * 1000) / 1000} ${unit}`.trim();
}
