// supabase/functions/_shared/stockPhone.js
//
// MULTI SITE STOCK, Phase 1b (v5.11.80): counting and waste on a phone (the Manager app). The
// phone is an anonymous paired device, so it works through manager-approve (device fence + staff
// PIN + audit, service role); this module holds the steps, with the service role client passed in,
// so node --test drives it with a stand in (stockPhone.test.js).
//
//   areas(sb, loc)                       the venue's live areas and its open phone counts
//   openCount(sb, loc, areaId, who)      an open count of one area (or the whole venue), reused today
//   sheet(sb, loc, countId, offset)      the items to count there, 500 a page, with what is counted
//   save(sb, loc, countId, entries)      entries saved as you go: each with the time it was counted
//   approve(sb, loc, countId, who)       the areas marked complete, then ONE database call
//   items(sb, loc, offset)               every live item, 500 a page (waste needs no count)
//   waste(sb, loc, body, who)            a stock item waste through stock_record_waste
//
// Counted time: the phone sends when each figure was typed. A figure saved late (a dropped signal)
// keeps that time, never later than now and never before the count started; a phone clock more than
// 10 minutes out is not trusted and the server time is used. The database stamps a changed figure
// itself (20261019b), so a recount is always "now".

export const PAGE = 500;
export const MAX_ENTRIES = 200;
export const CLOCK_SLACK_MS = 10 * 60 * 1000;

const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * When a figure was counted, as the server will store it. clientAt: the phone's time for the entry;
 * sentAt: the phone's clock when it sent the batch; now: the server's clock; startedAt: the count's
 * start. The phone's clock offset (sentAt vs now) corrects clientAt; an offset over 10 minutes means
 * the phone's clock is wrong, so now is used.
 */
export function countedAt({ clientAt, sentAt, now, startedAt }) {
  const n = new Date(now).getTime();
  const c = Date.parse(clientAt);
  const s = Date.parse(sentAt);
  if (!Number.isFinite(c) || !Number.isFinite(s)) return new Date(n).toISOString();
  const offset = n - s;
  if (Math.abs(offset) > CLOCK_SLACK_MS) return new Date(n).toISOString();
  let at = c + offset;
  const start = Date.parse(startedAt);
  if (Number.isFinite(start) && at < start) at = start;
  if (at > n) at = n;
  return new Date(at).toISOString();
}

/** Check and tidy a batch of entries: [{ item_id, qty_base, counted_at }]. Returns { ok, entries, error }. */
export function cleanEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) return { ok: false, error: 'nothing to save' };
  if (entries.length > MAX_ENTRIES) return { ok: false, error: `at most ${MAX_ENTRIES} figures at a time` };
  const byItem = new Map();
  for (const e of entries) {
    if (!e || !isUuid(e.item_id)) return { ok: false, error: 'a figure has no stock item' };
    const q = Number(e.qty_base);
    if (!Number.isFinite(q) || q < 0) return { ok: false, error: 'a figure must be a number, 0 or more' };
    if (e.area_id != null && !isUuid(e.area_id)) return { ok: false, error: 'a figure has an area that is not valid' };
    byItem.set(`${e.item_id}|${e.area_id || ''}`, { item_id: e.item_id, area_id: e.area_id || null, qty_base: Math.round(q * 10000) / 10000, counted_at: e.counted_at || null });
  }
  return { ok: true, entries: [...byItem.values()] };
}

export async function areas(sb, loc) {
  const [{ data: list, error }, { data: open }] = await Promise.all([
    sb.from('storage_areas').select('id, name, kind, sort_order').eq('location_id', loc).is('archived_at', null).order('sort_order').order('name').limit(200),
    sb.from('stock_counts').select('id, name, storage_area, started_at, started_by_name').eq('location_id', loc).eq('status', 'DRAFT')
      .like('name', 'Phone count%').order('started_at', { ascending: false }).limit(50),
  ]);
  if (error) return { error: 'could not read the areas' };
  return { areas: list || [], open: open || [] };
}

export async function openCount(sb, loc, areaId, who, now = new Date()) {
  const area = areaId && areaId !== 'all' ? areaId : null;
  if (area && !isUuid(area)) return { error: 'that area is not valid' };
  let areaName = 'whole venue';
  if (area) {
    const { data: a } = await sb.from('storage_areas').select('id, name').eq('location_id', loc).eq('id', area).maybeSingle();
    if (!a) return { error: 'that area is not at this venue' };
    areaName = a.name;
  }
  const since = new Date(now.getTime() - 18 * 3600 * 1000).toISOString();
  const key = area || 'all';
  const { data: existing } = await sb.from('stock_counts').select('id, name, started_at').eq('location_id', loc).eq('status', 'DRAFT')
    .eq('storage_area', key).like('name', 'Phone count%').gte('started_at', since).order('started_at', { ascending: false }).limit(1);
  if (existing && existing[0]) return { count: existing[0], reused: true };
  const { data: c, error } = await sb.from('stock_counts').insert({
    location_id: loc, name: `Phone count: ${areaName}`, count_type: area ? 'AREA' : 'FULL', status: 'DRAFT', storage_area: key,
    started_by_name: who || null,
  }).select('id, name, started_at').maybeSingle();
  if (error || !c) return { error: 'could not start the count' };
  if (area) {
    const { error: aErr } = await sb.from('stock_count_areas').insert({ location_id: loc, count_id: c.id, area_id: area, status: 'open' });
    if (aErr) return { error: 'the count started but its area did not save' };
  }
  return { count: c, reused: false };
}

async function countOf(sb, loc, countId) {
  if (!isUuid(countId)) return null;
  const { data } = await sb.from('stock_counts').select('id, status, storage_area, started_at, name').eq('location_id', loc).eq('id', countId).maybeSingle();
  return data || null;
}

export async function sheet(sb, loc, countId, offset = 0) {
  const c = await countOf(sb, loc, countId);
  if (!c) return { error: 'count not found for this location' };
  const area = c.storage_area && c.storage_area !== 'all' ? c.storage_area : null;
  let ids = null;
  if (area) {
    const { data: ia } = await sb.from('inventory_item_areas').select('inventory_item_id').eq('location_id', loc).eq('area_id', area)
      .order('inventory_item_id').range(offset, offset + PAGE - 1);
    ids = (ia || []).map((x) => x.inventory_item_id);
    if (!ids.length) return { count: c, items: [], more: false };
  }
  let q = sb.from('inventory_items').select('id, name, base_unit, sku, barcode, on_hand, company_ref').eq('location_id', loc).is('archived_at', null).eq('is_tracked', true);
  q = ids ? q.in('id', ids).order('name').order('id') : q.order('name').order('id').range(offset, offset + PAGE - 1);
  const { data: items, error } = await q;
  if (error) return { error: 'could not read the items' };
  const itemIds = (items || []).map((i) => i.id);
  const [{ data: packs }, { data: lines }] = await Promise.all([
    itemIds.length ? sb.from('item_packaging_formats').select('inventory_item_id, name, qty_in_base, is_count_default').eq('location_id', loc).in('inventory_item_id', itemIds).is('archived_at', null).limit(1000) : Promise.resolve({ data: [] }),
    itemIds.length ? sb.from('stock_count_lines').select('inventory_item_id, area_id, counted_qty, counted_at').eq('location_id', loc).eq('count_id', c.id).in('inventory_item_id', itemIds).limit(1000) : Promise.resolve({ data: [] }),
  ]);
  const packBy = {};
  for (const p of packs || []) if (p.is_count_default || !packBy[p.inventory_item_id]) packBy[p.inventory_item_id] = { name: p.name, qty: Number(p.qty_in_base) };
  const lineBy = {};
  for (const l of lines || []) if ((l.area_id || null) === area) lineBy[l.inventory_item_id] = l;
  return {
    count: c,
    more: (ids ? ids.length : (items || []).length) === PAGE,
    items: (items || []).map((i) => ({ id: i.id, name: i.name, base_unit: i.base_unit, sku: i.sku, barcode: i.barcode,
      count_pack: packBy[i.id] || null, counted_qty: lineBy[i.id]?.counted_qty ?? null, counted_at: lineBy[i.id]?.counted_at ?? null,
      head_office: !!i.company_ref })),
  };
}

/** Every live tracked item of the venue, 500 a page (for waste: no count is opened). */
export async function items(sb, loc, offset = 0) {
  const { data, error } = await sb.from('inventory_items').select('id, name, base_unit, sku, barcode, company_ref').eq('location_id', loc)
    .is('archived_at', null).eq('is_tracked', true).order('name').order('id').range(offset, offset + PAGE - 1);
  if (error) return { error: 'could not read the items' };
  const ids = (data || []).map((i) => i.id);
  const { data: packs } = ids.length
    ? await sb.from('item_packaging_formats').select('inventory_item_id, name, qty_in_base, is_count_default').eq('location_id', loc).in('inventory_item_id', ids).is('archived_at', null).limit(1000)
    : { data: [] };
  const packBy = {};
  for (const p of packs || []) if (p.is_count_default || !packBy[p.inventory_item_id]) packBy[p.inventory_item_id] = { name: p.name, qty: Number(p.qty_in_base) };
  return { more: (data || []).length === PAGE, items: (data || []).map((i) => ({ id: i.id, name: i.name, base_unit: i.base_unit, sku: i.sku, barcode: i.barcode, count_pack: packBy[i.id] || null, head_office: !!i.company_ref })) };
}

export async function save(sb, loc, countId, rawEntries, { sentAt = null, now = new Date() } = {}) {
  const c = await countOf(sb, loc, countId);
  if (!c) return { error: 'count not found for this location' };
  if (c.status !== 'DRAFT') return { error: 'this count is approved already: start a new one' };
  const clean = cleanEntries(rawEntries);
  if (!clean.ok) return { error: clean.error };
  const area = c.storage_area && c.storage_area !== 'all' ? c.storage_area : null;
  const itemIds = [...new Set(clean.entries.map((e) => e.item_id))];
  const [{ data: items }, { data: lines }] = await Promise.all([
    sb.from('inventory_items').select('id, on_hand, current_cost').eq('location_id', loc).in('id', itemIds),
    sb.from('stock_count_lines').select('id, inventory_item_id, area_id, counted_qty').eq('location_id', loc).eq('count_id', c.id).in('inventory_item_id', itemIds),
  ]);
  const itemBy = Object.fromEntries((items || []).map((i) => [i.id, i]));
  if (clean.entries.some((e) => !itemBy[e.item_id])) return { error: 'a figure is for an item that is not at this venue' };
  let saved = 0;
  const inserts = [];
  for (const e of clean.entries) {
    const lineArea = e.area_id || area;
    const line = (lines || []).find((l) => l.inventory_item_id === e.item_id && (l.area_id || null) === lineArea);
    if (line) {
      if (Number(line.counted_qty) === e.qty_base) { saved++; continue; }
      const { error } = await sb.from('stock_count_lines').update({ counted_qty: e.qty_base }).eq('location_id', loc).eq('id', line.id);
      if (error) return { error: `could not save a figure: ${error.message}`, saved };
      saved++;
    } else {
      const it = itemBy[e.item_id];
      inserts.push({ location_id: loc, count_id: c.id, inventory_item_id: e.item_id, area_id: lineArea, counted_qty: e.qty_base,
        expected_qty: Number(it.on_hand) || 0, unit_cost: it.current_cost == null ? null : Number(it.current_cost),
        counted_at: countedAt({ clientAt: e.counted_at, sentAt: sentAt || new Date(now).toISOString(), now, startedAt: c.started_at }) });
    }
  }
  if (inserts.length) {
    const { data: ins, error } = await sb.from('stock_count_lines').insert(inserts).select('id');
    if (error || !ins || ins.length !== inserts.length) return { error: `could not save ${inserts.length} figures`, saved };
    saved += ins.length;
  }
  return { saved };
}

export async function approve(sb, loc, countId, who) {
  const c = await countOf(sb, loc, countId);
  if (!c) return { error: 'count not found for this location' };
  if (c.status === 'APPROVED') return { ok: true, duplicate: true };
  await sb.from('stock_count_areas').update({ status: 'complete', completed_by_name: who || null, completed_at: new Date().toISOString() })
    .eq('location_id', loc).eq('count_id', c.id).eq('status', 'open');
  const { data, error } = await sb.rpc('approve_stock_count', { p_count_id: c.id, p_approved_by_name: who || null, p_approval_note: 'Approved on the phone', p_costs: null, p_preview: false });
  if (error) return { error: `could not approve: ${error.message}` };
  return data || { ok: false, error: 'no answer' };
}

export async function waste(sb, loc, body, who) {
  const item = body?.item_id;
  if (!isUuid(item)) return { error: 'pick a stock item' };
  const qtyBase = Number(body?.qty_base);
  if (!(qtyBase > 0)) return { error: 'the amount wasted must be more than 0' };
  const { data, error } = await sb.rpc('stock_record_waste', {
    p_location_id: loc,
    p_event: { id: isUuid(body?.id) ? body.id : undefined, kind: 'item', inventory_item_id: item, qty: Number(body?.qty) || qtyBase,
      unit: String(body?.unit || 'base'), qty_base: qtyBase, reason: String(body?.reason || 'Other').slice(0, 60),
      note: body?.note ? String(body.note).slice(0, 300) : (who ? `Logged on the phone by ${who}` : null), source: 'manager' },
    p_lines: null,
  });
  if (error) return { error: `could not record the waste: ${error.message}` };
  return data || { ok: true };
}
