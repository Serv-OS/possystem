// supabase/functions/_shared/stockPhone.js
//
// Counting and waste on a phone (the Manager app). v5.11.82, multi site stock Drop 0 (plan 4.23):
// re landed from Phase 1b with its fixes. The phone is an anonymous paired device, so it works
// through manager-approve (device fence + staff PIN + audit, service role); this module holds the
// steps, with the service role client passed in, so node --test drives it with a stand in
// (src/lib/stock/stockPhoneEdge.test.js).
//
//   areas(sb, loc)                          the venue's live areas and its open phone counts
//   openCount(sb, loc, areaId, who)         an open count of one area (or the whole venue), reused today
//   sheet(sb, loc, countId, offset)         the items to count there, 500 a page, with what is counted
//   save(sb, loc, countId, entries)         entries saved as you go: each with the time it was counted
//   approve(sb, loc, countId, who, pinner)  the areas marked complete, the opening costs, then ONE
//                                           database call; the PIN holder is stored on the count
//   items(sb, loc, offset)                  every live item, 500 a page (waste needs no count)
//   waste(sb, loc, body, who)               a stock item waste through stock_record_waste
//
// Counted time: the phone sends when each figure was typed. A figure saved late (a dropped signal)
// keeps that time, never later than now and never before the count started; a phone clock more than
// 10 minutes out is not trusted and the server time is used. A first figure is inserted with its
// time. A RECOUNT is two writes: the figure (the database stamps a changed figure with its own clock,
// 20261019b), then the time it was typed with the figure unchanged, which the database keeps for the
// service role. If that second write fails the line keeps the save time and the save says so.
//
// Drop 0 fixes:
//   * ONE line per count, item and area. 20261021a adds the unique index stock_count_lines_one_per_area
//     (count, item, coalesce(area, zero)), so two phones, or two overlapping sends, can never post a
//     variance twice. It is an expression index, so PostgREST onConflict cannot name it: save() reads
//     the line, updates it or inserts it, and when an insert meets 23505 (someone else inserted it
//     first) it reads the line again and updates it. That is the upsert.
//   * .in() lists are sent 100 ids at a time (a 500 item page of ids is too long for one request
//     address), and every read is paged past the 1,000 row cap.
//   * Archived packs are never offered (archived_at on item_packaging_formats comes with 20261021a;
//     before it the reads fall back to every pack, as today).
//   * The opening costs come from stock_opening_costs (20261021a); the approver's PIN holder is
//     written to stock_counts.approved_by_staff_id and approved_by_staff_name.

export const PAGE = 500;
export const MAX_ENTRIES = 200;
export const CLOCK_SLACK_MS = 10 * 60 * 1000;
export const ROW_CAP = 1000;
export const IN_CHUNK = 100;

/** Every row of a read, in pages of ROW_CAP (build() makes a fresh query, ordered). { data, error } */
export async function readAll(build, max = 20) {
  const out = [];
  for (let p = 0; p < max; p++) {
    const { data, error } = await build().range(p * ROW_CAP, p * ROW_CAP + ROW_CAP - 1);
    if (error) return { data: null, error };
    out.push(...(data || []));
    if (!data || data.length < ROW_CAP) return { data: out, error: null };
  }
  return { data: null, error: { message: 'too many rows' } };
}

/** Split a list into pieces of `size` (the last may be shorter). */
export function chunks(list, size = IN_CHUNK) {
  const out = [];
  const arr = Array.isArray(list) ? list : [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/**
 * Every row for a list of ids, IN_CHUNK ids a request, each request paged past the row cap.
 * build(chunk) makes a fresh query (ordered) for those ids. { data, error }
 */
export async function readIn(ids, build) {
  const uniq = [...new Set((ids || []).filter((x) => x != null))];
  const out = [];
  for (const part of chunks(uniq)) {
    const r = await readAll(() => build(part));
    if (r.error) return { data: null, error: r.error };
    out.push(...(r.data || []));
  }
  return { data: out, error: null };
}

// A Drop 0 column (archived_at on packs, bridges and supplier prices; the PIN holder columns) is
// not there yet: PostgREST 42703 or its words, naming that column.
export function isMissingNewColumn(error) {
  if (!error) return false;
  const code = String(error.code || '');
  const msg = String(error.message || error || '');
  return (code === '42703' || /does not exist|could not find/i.test(msg))
    && /archived_at|approved_by_staff_id|approved_by_staff_name/.test(msg);
}

/**
 * A read that leaves out archived rows (live = true), or every row when the archived_at column is
 * not there yet (before 20261021a): the same rows as before the migration, never an error.
 * run(live) returns { data, error } or throws (pagedRows throws). Used by manager-approve and
 * manager-snapshot too, so one rule decides what "live" means on the phone.
 */
export async function liveOrAll(run) {
  try {
    const r = await run(true);
    if (r && r.error && isMissingNewColumn(r.error)) return await run(false);
    return r;
  } catch (e) {
    if (isMissingNewColumn(e)) return await run(false);
    throw e;
  }
}

/** The archived filter on a query, or the query as it is (liveOrAll's second try). */
export const liveFilter = (q, live) => (live ? q.is('archived_at', null) : q);

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

/** Check and tidy a batch of entries: [{ item_id, area_id?, qty_base, counted_at }]. Returns { ok, entries, error }. */
export function cleanEntries(entries) {
  if (!Array.isArray(entries) || !entries.length) return { ok: false, error: 'nothing to save' };
  if (entries.length > MAX_ENTRIES) return { ok: false, error: `at most ${MAX_ENTRIES} figures at a time` };
  const byItem = new Map();
  for (const e of entries) {
    if (!e || !isUuid(e.item_id)) return { ok: false, error: 'a figure has no stock item' };
    const q = Number(e.qty_base);
    if (e.qty_base == null || e.qty_base === '' || !Number.isFinite(q) || q < 0) return { ok: false, error: 'a figure must be a number, 0 or more' };
    if (e.area_id != null && !isUuid(e.area_id)) return { ok: false, error: 'a figure has an area that is not valid' };
    byItem.set(`${e.item_id}|${e.area_id || ''}`, { item_id: e.item_id, area_id: e.area_id || null, qty_base: Math.round(q * 10000) / 10000, counted_at: e.counted_at || null });
  }
  return { ok: true, entries: [...byItem.values()] };
}

// The count pack of each item: the count default, else the first live pack.
function packsByItem(packs) {
  const packBy = {};
  for (const p of packs || []) if (p.is_count_default || !packBy[p.inventory_item_id]) packBy[p.inventory_item_id] = { name: p.name, qty: Number(p.qty_in_base) };
  return packBy;
}

function readPacks(sb, loc, itemIds) {
  if (!itemIds.length) return Promise.resolve({ data: [], error: null });
  return liveOrAll((live) => readIn(itemIds, (part) => liveFilter(sb.from('item_packaging_formats')
    .select('id, inventory_item_id, name, qty_in_base, is_count_default').eq('location_id', loc).in('inventory_item_id', part), live).order('id')));
}

const byNameThenId = (a, b) => (String(a.name || '').localeCompare(String(b.name || '')) || String(a.id).localeCompare(String(b.id)));

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
  let items;
  let more;
  if (area) {
    const { data: ia, error: iaErr } = await sb.from('inventory_item_areas').select('inventory_item_id').eq('location_id', loc).eq('area_id', area)
      .order('inventory_item_id').range(offset, offset + PAGE - 1);
    if (iaErr) return { error: 'could not read the items in this area' };
    const ids = (ia || []).map((x) => x.inventory_item_id);
    if (!ids.length) return { count: c, items: [], more: false };
    more = ids.length === PAGE;
    const r = await readIn(ids, (part) => sb.from('inventory_items').select('id, name, base_unit, sku, barcode, on_hand')
      .eq('location_id', loc).is('archived_at', null).eq('is_tracked', true).in('id', part).order('id'));
    if (r.error) return { error: 'could not read the items' };
    items = (r.data || []).sort(byNameThenId);
  } else {
    const { data, error } = await sb.from('inventory_items').select('id, name, base_unit, sku, barcode, on_hand')
      .eq('location_id', loc).is('archived_at', null).eq('is_tracked', true).order('name').order('id').range(offset, offset + PAGE - 1);
    if (error) return { error: 'could not read the items' };
    items = data || [];
    more = items.length === PAGE;
  }
  const itemIds = items.map((i) => i.id);
  const [{ data: packs, error: pErr }, { data: lines, error: lErr }] = await Promise.all([
    readPacks(sb, loc, itemIds),
    itemIds.length
      ? readIn(itemIds, (part) => sb.from('stock_count_lines').select('id, inventory_item_id, area_id, counted_qty, counted_at').eq('location_id', loc).eq('count_id', c.id).in('inventory_item_id', part).order('id'))
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (pErr || lErr) return { error: 'could not read the packs or the figures saved so far' };
  const packBy = packsByItem(packs);
  const lineBy = {};
  for (const l of lines || []) if ((l.area_id || null) === area) lineBy[l.inventory_item_id] = l;
  return {
    count: c,
    more,
    items: items.map((i) => ({ id: i.id, name: i.name, base_unit: i.base_unit, sku: i.sku, barcode: i.barcode,
      count_pack: packBy[i.id] || null, counted_qty: lineBy[i.id]?.counted_qty ?? null, counted_at: lineBy[i.id]?.counted_at ?? null })),
  };
}

/** Every live tracked item of the venue, 500 a page (for waste: no count is opened). */
export async function items(sb, loc, offset = 0) {
  const { data, error } = await sb.from('inventory_items').select('id, name, base_unit, sku, barcode').eq('location_id', loc)
    .is('archived_at', null).eq('is_tracked', true).order('name').order('id').range(offset, offset + PAGE - 1);
  if (error) return { error: 'could not read the items' };
  const ids = (data || []).map((i) => i.id);
  const { data: packs, error: pErr } = await readPacks(sb, loc, ids);
  if (pErr) return { error: 'could not read the packs' };
  const packBy = packsByItem(packs);
  return { more: (data || []).length === PAGE, items: (data || []).map((i) => ({ id: i.id, name: i.name, base_unit: i.base_unit, sku: i.sku, barcode: i.barcode, count_pack: packBy[i.id] || null })) };
}

const isUniqueClash = (error) => !!error && (String(error.code || '') === '23505' || /duplicate key value/i.test(String(error.message || '')));
const lineKey = (itemId, areaId) => `${itemId}|${areaId || ''}`;

// A recount: the figure, then the time it was typed (the database keeps that time for the service
// role only while the figure is unchanged). Returns null or the words of what went wrong.
async function rewriteLine(sb, loc, line, e, at) {
  const { error } = await sb.from('stock_count_lines').update({ counted_qty: e.qty_base }).eq('location_id', loc).eq('id', line.id);
  if (error) return { fatal: `could not save a figure: ${error.message}` };
  const { error: tErr } = await sb.from('stock_count_lines').update({ counted_at: at }).eq('location_id', loc).eq('id', line.id);
  if (tErr) return { late: `a figure saved, but not the time it was counted (it reads as now): ${tErr.message}` };
  return null;
}

// The one line for this count, item and area (read again after an insert met the unique index).
async function lineOf(sb, loc, countId, itemId, areaId) {
  let q = sb.from('stock_count_lines').select('id, inventory_item_id, area_id, counted_qty').eq('location_id', loc).eq('count_id', countId).eq('inventory_item_id', itemId);
  q = areaId ? q.eq('area_id', areaId) : q.is('area_id', null);
  const { data } = await q.order('id').limit(1);
  return Array.isArray(data) ? data[0] || null : data || null;
}

export async function save(sb, loc, countId, rawEntries, { sentAt = null, now = new Date() } = {}) {
  const c = await countOf(sb, loc, countId);
  if (!c) return { error: 'count not found for this location' };
  if (c.status !== 'DRAFT') return { error: 'this count is approved already: start a new one' };
  const clean = cleanEntries(rawEntries);
  if (!clean.ok) return { error: clean.error };
  const area = c.storage_area && c.storage_area !== 'all' ? c.storage_area : null;
  const itemIds = [...new Set(clean.entries.map((e) => e.item_id))];
  const [{ data: itemRows, error: iErr }, { data: lines, error: lErr }] = await Promise.all([
    readIn(itemIds, (part) => sb.from('inventory_items').select('id, on_hand, current_cost').eq('location_id', loc).in('id', part).order('id')),
    readIn(itemIds, (part) => sb.from('stock_count_lines').select('id, inventory_item_id, area_id, counted_qty').eq('location_id', loc).eq('count_id', c.id).in('inventory_item_id', part).order('id')),
  ]);
  if (iErr) return { error: 'could not read the items' };
  if (lErr) return { error: 'could not read the figures saved so far' };
  const itemBy = Object.fromEntries((itemRows || []).map((i) => [i.id, i]));
  if (clean.entries.some((e) => !itemBy[e.item_id])) return { error: 'a figure is for an item that is not at this venue' };
  const lineBy = new Map();
  for (const l of lines || []) if (!lineBy.has(lineKey(l.inventory_item_id, l.area_id))) lineBy.set(lineKey(l.inventory_item_id, l.area_id), l);
  let saved = 0;
  const inserts = [];
  const sent = sentAt || new Date(now).toISOString();
  for (const e of clean.entries) {
    const lineArea = e.area_id || area;
    const at = countedAt({ clientAt: e.counted_at, sentAt: sent, now, startedAt: c.started_at });
    const line = lineBy.get(lineKey(e.item_id, lineArea));
    if (line) {
      if (Number(line.counted_qty) === e.qty_base) { saved++; continue; }
      const bad = await rewriteLine(sb, loc, line, e, at);
      if (bad?.fatal) return { error: bad.fatal, saved };
      if (bad?.late) return { error: bad.late, saved: saved + 1 };
      saved++;
    } else {
      const it = itemBy[e.item_id];
      inserts.push({ e, at, row: { location_id: loc, count_id: c.id, inventory_item_id: e.item_id, area_id: lineArea, counted_qty: e.qty_base,
        expected_qty: Number(it.on_hand) || 0, unit_cost: it.current_cost == null ? null : Number(it.current_cost), counted_at: at } });
    }
  }
  if (inserts.length) {
    const { data: ins, error } = await sb.from('stock_count_lines').insert(inserts.map((x) => x.row)).select('id');
    if (!error) return ins && ins.length === inserts.length ? { saved: saved + ins.length } : { error: `could not save ${inserts.length} figures`, saved };
    if (!isUniqueClash(error)) return { error: `could not save ${inserts.length} figures`, saved };
    // Another phone or an overlapping send put in some of these lines first (the batch is all or
    // nothing, so none of ours went in): one at a time, and a line that is there already is updated.
    for (const x of inserts) {
      const { error: oneErr } = await sb.from('stock_count_lines').insert(x.row).select('id');
      if (!oneErr) { saved++; continue; }
      if (!isUniqueClash(oneErr)) return { error: `could not save a figure: ${oneErr.message}`, saved };
      const there = await lineOf(sb, loc, c.id, x.row.inventory_item_id, x.row.area_id);
      if (!there) return { error: 'could not save a figure: try again', saved };
      if (Number(there.counted_qty) === x.e.qty_base) { saved++; continue; }
      const bad = await rewriteLine(sb, loc, there, x.e, x.at);
      if (bad?.fatal) return { error: bad.fatal, saved };
      if (bad?.late) return { error: bad.late, saved: saved + 1 };
      saved++;
    }
  }
  return { saved };
}

/**
 * Approve on the phone. pinner: the staff member whose manager PIN approved it ({ id, name }),
 * written to the count as the PIN holder once approve_stock_count has said yes.
 */
export async function approve(sb, loc, countId, who, pinner = null) {
  const c = await countOf(sb, loc, countId);
  if (!c) return { error: 'count not found for this location' };
  if (c.status === 'APPROVED') return { ok: true, duplicate: true };
  await sb.from('stock_count_areas').update({ status: 'complete', completed_by_name: who || null, completed_at: new Date().toISOString() })
    .eq('location_id', loc).eq('count_id', c.id).eq('status', 'open');
  // an opening count is costed on the server (the site's price, else the company's average cost):
  // the phone has no place to type a cost. Before 20261021a the call is not there and nothing is sent.
  const { data: costs, error: cErr } = await sb.rpc('stock_opening_costs', { p_count_id: c.id });
  const given = !cErr && costs && typeof costs === 'object' ? Object.entries(costs).filter(([k, v]) => isUuid(k) && Number(v) > 0) : [];
  const pCosts = given.length ? Object.fromEntries(given.map(([k, v]) => [k, Number(v)])) : null;
  const { data, error } = await sb.rpc('approve_stock_count', { p_count_id: c.id, p_approved_by_name: who || null, p_approval_note: 'Approved on the phone', p_costs: pCosts, p_preview: false });
  if (error) return { error: `could not approve: ${error.message}` };
  if (data && data.code === 'needs_cost') {
    const names = (data.needs_cost || []).map((x) => x.name).filter(Boolean).slice(0, 5).join(', ');
    return { ...data, error: `${names || 'Some items'} ${data.needs_cost?.length === 1 ? 'has' : 'have'} no cost here yet (no price, and no other site has a cost). Add a supplier price in Back Office, or approve this count there with a cost.` };
  }
  const out = data || { ok: false, error: 'no answer' };
  if (out.ok === false || out.duplicate) return out;
  // The PIN holder (20261021a columns). The approval stands whatever happens here; the audit row
  // names the same person.
  let pinHolderSaved = false;
  if (pinner && (pinner.id || pinner.name)) {
    const { error: pErr } = await sb.from('stock_counts').update({
      approved_by_staff_id: isUuid(pinner.id) ? pinner.id : null, approved_by_staff_name: pinner.name || who || null,
    }).eq('location_id', loc).eq('id', c.id);
    pinHolderSaved = !pErr;
  }
  return { ...out, approved_by_pin: pinner?.name || who || null, pin_holder_saved: pinHolderSaved };
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
