/**
 * stock/purchasing.js — purchase orders, receiving, and supplier invoices.
 *
 * Receiving a PO or posting an invoice writes PURCHASE_RECEIPT movements to the
 * ledger and updates each item's moving-average cost with a new effective-dated
 * item_cost_history row. House pattern: loc-demo guard, camelCase ↔ snake_case,
 * idempotent receipts.
 *
 * v5.11.79 (multi site stock plan, Phase 0, 11.5 item 3 and 4.9): a receive and an invoice are each
 * ONE database call (stock_receive, stock_post_invoice, 20261019b). The database locks the items in
 * id order, works the moving average out from the LOCKED on hand (a sale or a second device receiving
 * the same item can no longer give a wrong average), and writes the movement, the cost history (with
 * the supplier pack and the price paid per pack) and the cost together. Stock below zero or an
 * unknown cost takes the delivery price, never an average. A duplicate invoice number from the same
 * supplier is refused, and an invoice for an order already received is kept as paperwork.
 *
 * v5.11.82 (multi site stock Drop 0): the old browser receive and invoice paths are gone. They never
 * ran once 20261019b was in, and each wrote cost with no REVALUE. A database with neither call is
 * told it needs the update and nothing is written. An archived unit bridge or supplier price is not
 * used for a new receive or invoice, and the invoice scan sends the signed in session.
 */

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { convert } from './conversion.js';
import { fetchTaxRateMap } from './data.js';
import { fetchReceivingArea } from './areas.js';
import { purchaseNet } from '../tax.js';
import { cleanFnError, poTotals, unreceivableLines, receiveRefusalText, poReceiptLines, packLabel } from './purchasingRules.js';
import { isMissingFunctionError, invoiceOutcome } from './phase0Rules.js';
import { readAllPagesResult } from '../pagedRead.js';
import { NEEDS_UPDATE } from './saveRules.js';
import { liveOrAll } from './companyData.js';

const nowIso = () => new Date().toISOString();
async function ensureLoc(locationId) {
  if (!locationId || locationId === 'loc-demo') locationId = getActiveLocationSync();
  if (!locationId || locationId === 'loc-demo') locationId = await getLocationId().catch(() => null);
  if (!locationId || locationId === 'loc-demo') return null;
  return locationId;
}

/** Map of item id → { baseUnit, conversions, onHand, currentCost, costMethod } for a set of ids. */
async function itemMap(locationId, ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return {};
  const [{ data: items }, { data: convs }] = await Promise.all([
    supabase.from('inventory_items').select('id, name, base_unit, on_hand, current_cost, cost_method').eq('location_id', locationId).in('id', uniq),
    // v5.11.82 (Drop 0): an archived unit bridge is not used for a new receive or invoice
    liveOrAll((live) => {
      const q = supabase.from('inventory_item_conversions').select('*').eq('location_id', locationId).in('inventory_item_id', uniq);
      return live ? q.is('archived_at', null) : q;
    }),
  ]);
  const convByItem = {};
  (convs || []).forEach((c) => { (convByItem[c.inventory_item_id] ??= []).push({ fromQty: Number(c.from_qty), fromUnit: c.from_unit, toQty: Number(c.to_qty), toUnit: c.to_unit }); });
  const m = {};
  (items || []).forEach((it) => {
    m[it.id] = {
      name: it.name, baseUnit: it.base_unit, conversions: convByItem[it.id] || [],
      onHand: Number(it.on_hand) || 0, currentCost: it.current_cost == null ? 0 : Number(it.current_cost),
      costMethod: it.cost_method || 'MOVING_AVG',
    };
  });
  return m;
}

/**
 * Where a delivery lands (16 Oct 2026, stock areas): the caller's choice (the "Lands in" dropdown
 * on the receive panel and the invoice post), else the venue's receiving area, else null and the
 * database puts it in each item's own area. Null before the migration, so nothing changes.
 */
async function landingArea(locationId, chosen) {
  if (chosen) return chosen;
  const { data } = await fetchReceivingArea(locationId);
  return data || null;
}

// ── Purchase orders ───────────────────────────────────────────────────────────
const poFromRow = (r) => ({
  id: r.id, locationId: r.location_id, supplierId: r.supplier_id, reference: r.reference, status: r.status,
  expectedDate: r.expected_date, orderedAt: r.ordered_at, receivedAt: r.received_at,
  subtotal: r.subtotal == null ? null : Number(r.subtotal), tax: r.tax == null ? null : Number(r.tax),
  notes: r.notes, createdAt: r.created_at,
});
const poLineFromRow = (r) => ({
  id: r.id, poId: r.po_id, inventoryItemId: r.inventory_item_id, supplierProductId: r.supplier_product_id,
  description: r.description, qtyPacks: Number(r.qty_packs), packQty: Number(r.pack_qty), innerQty: Number(r.inner_qty),
  innerUnit: r.inner_unit, unitPrice: Number(r.unit_price), qtyReceived: Number(r.qty_received), sortOrder: r.sort_order,
  purchaseTaxRateId: r.purchase_tax_rate_id || null, lineTax: r.line_tax == null ? null : Number(r.line_tax),
});

export const fetchPurchaseOrders = async (locationId = null, limit = 100) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  const { data: pos, error } = await supabase.from('purchase_orders').select('*').eq('location_id', locationId).order('created_at', { ascending: false }).limit(limit);
  if (error) return { data: [], error };
  // v5.11.79 (stock plan 11.5 item 8): the lines of THESE orders only, in pages of 1,000. It read
  // every line the venue ever had in one request, so past 1,000 lines (about 3 weeks at 2 orders a
  // day of 25 lines) older orders showed with lines missing.
  const ids = (pos || []).map((r) => r.id);
  const linesRes = ids.length ? await readAllPagesResult('order lines', (first) => supabase.from('po_lines')
    .select('*', first ? { count: 'exact' } : undefined).eq('location_id', locationId).in('po_id', ids).order('po_id').order('sort_order').order('id'))
    : { data: [], error: null };
  if (linesRes.error) return { data: [], error: linesRes.error };
  const lines = linesRes.data;
  const linesByPo = {};
  (lines || []).forEach((l) => { (linesByPo[l.po_id] ??= []).push(poLineFromRow(l)); });
  return { data: (pos || []).map((r) => ({ ...poFromRow(r), lines: linesByPo[r.id] || [] })), error: null };
};

/** Create or update a PO header + replace its lines. Returns { data: po, error }. */
export const savePurchaseOrder = async (po, lines, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  // unit_price is NET (ex-VAT). VAT is metadata for the payable/return: per-line
  // line_tax = net line × rate; header tax = Σ line_tax; total payable = subtotal + tax.
  const ratesById = await fetchTaxRateMap(locationId);
  const keepLines = (lines || []).filter(l => l.inventoryItemId || l.description);
  // v5.11.64: the maths lives in purchasingRules.poTotals so the Manager app's server (which
  // writes the same two columns) and this file can never drift apart.
  const { lineTaxes, subtotal, tax } = poTotals(keepLines, ratesById);
  const row = {
    ...(po.id ? { id: po.id } : {}),
    location_id: locationId, supplier_id: po.supplierId || null, reference: po.reference || null,
    status: po.status || 'DRAFT', expected_date: po.expectedDate || null, notes: po.notes || null,
    subtotal, tax, updated_at: nowIso(),
  };
  const { data, error } = await supabase.from('purchase_orders').upsert(row).select().maybeSingle();
  if (error || !data) return { data: null, error: error || new Error('PO save failed') };
  await supabase.from('po_lines').delete().eq('location_id', locationId).eq('po_id', data.id);
  const lrows = keepLines.map((l, i) => ({
    location_id: locationId, po_id: data.id, inventory_item_id: l.inventoryItemId || null,
    supplier_product_id: l.supplierProductId || null, description: l.description || null,
    qty_packs: Number(l.qtyPacks) || 0, pack_qty: Number(l.packQty) || 1, inner_qty: Number(l.innerQty) || 1,
    inner_unit: l.innerUnit || 'each', unit_price: Number(l.unitPrice) || 0, qty_received: Number(l.qtyReceived) || 0,
    purchase_tax_rate_id: l.purchaseTaxRateId || null, line_tax: lineTaxes[i], sort_order: i,
  }));
  // v5.11.79: a line save that fails (a lock wait, a timeout) is said, never a header with no lines
  if (lrows.length) {
    const { error: lineErr } = await supabase.from('po_lines').insert(lrows);
    if (lineErr) return { data: null, error: new Error(`The order was saved but its lines were not: ${lineErr.message || lineErr}. Save again.`) };
  }
  return { data: poFromRow(data), error: null };
};

/**
 * Plain text for a failed edge function call. The Supabase client reports every non-2xx
 * answer as "Edge Function returned a non-2xx status code" and hides the body in
 * error.context; this reads the body and hands back one sentence a venue can act on.
 */
export const fnErrorText = async (res, error, fallback = 'send failed') => {
  let raw = res?.error || null;
  if (!raw && error?.context) {
    try { raw = (await error.context.json())?.error || null; } catch { raw = null; }
  }
  if (!raw) raw = error?.message || null;
  return cleanFnError(raw, fallback);
};

/**
 * Change when an order is due, on its own. v5.11.64: an order the pad has already sent
 * had every field locked, including the one date the venue needs to correct. This is a
 * one column update: it NEVER goes through savePurchaseOrder, which deletes and reinserts
 * po_lines and would orphan the receive idempotency keys.
 */
export const setPOExpectedDate = async (poId, ymd, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  const clean = /^\d{4}-\d{2}-\d{2}$/.test(String(ymd || '')) ? ymd : null;
  return supabase.from('purchase_orders').update({ expected_date: clean, updated_at: nowIso() })
    .eq('location_id', locationId).eq('id', poId);
};

export const setPOStatus = async (poId, status, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  const patch = { status, updated_at: nowIso() };
  if (status === 'SENT') patch.ordered_at = nowIso();
  return supabase.from('purchase_orders').update(patch).eq('location_id', locationId).eq('id', poId);
};

/**
 * Receive a PO into stock.
 *
 * receipts = null  → receive IN FULL, exactly the pre-v5.5.921 behaviour. The ops
 *                    goods-in flow (src/lib/ops/data.js) calls with no receipts and
 *                    must keep working unchanged.
 * receipts = [{ lineId, qtyPacks, unitPrice }]
 *                  → LINE-BY-LINE ACCEPT. qtyPacks is what actually arrived (0 = the
 *                    line was shorted entirely); unitPrice is the price on the delivery
 *                    note, which overrides the ordered price — this is where price
 *                    variance is captured, and where a manager-raised £0 PO finally
 *                    gets a real cost. Shorted lines spawn a BALANCE PO (status SENT)
 *                    for the remainder rather than leaving this one PARTIAL — the
 *                    Order Pad's on-order maths then stays correct with no extra state.
 *
 * INVARIANTS this function must never break:
 * - po_lines are UPDATED IN PLACE. savePurchaseOrder deletes+reinserts lines, which
 *   changes their ids — routing a receive through it would orphan the `po:<po>:<line>`
 *   idempotency keys and qty_received. Never call it from here.
 * - One receipt per line under the EXISTING key `po:<poId>:<lineId>`. A line receives
 *   once; retries dedupe server-side. Collect final qty+price BEFORE calling.
 * - The stock and cost of every line go in ONE database call (stock_receive) before any order
 *   line changes; a line left at £0 moves stock at the item's known cost and does NOT re-cost it
 *   (the database's rule since v5.11.79).
 */
/**
 * Can this order be received at all? The same line check receivePurchaseOrder runs, with no
 * write. v5.11.65: the Ops tablet's Accept to stock inserted its goods in record first and only
 * then learned the receive refused, leaving a 'pending' delivery with a temperature logged that was
 * never accepted or rejected, and another on every retry. Callers that write before receiving ask
 * here first.
 */
export const checkReceivable = async (poId, locationId = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  const { data: lines } = await supabase.from('po_lines').select('*').eq('location_id', locationId).eq('po_id', poId);
  if (!lines?.length) return { error: new Error('No lines') };
  const map = await itemMap(locationId, lines.map(l => l.inventory_item_id));
  const { bad } = unreceivableLines(lines, map);
  return { error: bad.length ? new Error(receiveRefusalText(bad)) : null };
};

export const receivePurchaseOrder = async (poId, locationId = null, receipts = null, { areaId = null } = {}) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  // 16 Oct 2026: the area the delivery lands in (the panel's choice, else the receiving area).
  const landIn = await landingArea(locationId, areaId);
  const [{ data: lines }, { data: poRow }] = await Promise.all([
    supabase.from('po_lines').select('*').eq('location_id', locationId).eq('po_id', poId),
    supabase.from('purchase_orders').select('*').eq('location_id', locationId).eq('id', poId).maybeSingle(),
  ]);
  if (!lines?.length) return { error: new Error('No lines') };
  const byLine = receipts ? Object.fromEntries(receipts.map(r => [String(r.lineId), r])) : null;
  const map = await itemMap(locationId, lines.map(l => l.inventory_item_id));
  // v5.5.923 — REFUSE rather than silently swallow. The loop below skips any line whose item
  // is missing or whose unit conversion fails; on a line-by-line accept that meant what staff
  // TYPED was discarded without a word, the header totals excluded the line, the shortfall
  // never reached the balance PO — and RECEIVED is terminal, so the stock could never be
  // posted afterwards. A receive that cannot represent every line must not half-happen.
  // v5.11.65: the FULL receive (the Ops tablet's Accept to stock) ran none of this. A line whose
  // item was missing or whose unit would not convert was skipped in silence and the order still
  // went RECEIVED, so 40 kg of beef and 14 l of milk on one demo order never entered stock and,
  // RECEIVED being final, never could. The same check now guards every path (one copy in
  // purchasingRules.unreceivableLines; checkReceivable runs it before the Ops tablet writes anything).
  {
    const { bad } = unreceivableLines(lines, map);
    if (bad.length) return { error: new Error(receiveRefusalText(bad)) };
  }
  // v5.11.79: every line's stock and cost in ONE database call, before any order line is touched
  // (all or nothing; a retry posts nothing twice: the keys stay po:<order>:<line>).
  {
    const perPackOf = {};
    for (const l of lines) {
      const item = map[l.inventory_item_id];
      if (!item) continue;
      try { perPackOf[l.id] = convert(Number(l.pack_qty) * Number(l.inner_qty), l.inner_unit, item.baseUnit, { itemConversions: item.conversions }); } catch { /* checked above */ }
    }
    const rpcLines = poReceiptLines(poId, lines, { byLine, perPackOf }).map((r) => ({
      key: r.key, item_id: r.item_id, qty_base: r.qty_base, unit_cost: r.unit_cost,
      supplier_product_id: r.supplier_product_id, pack_price: r.pack_price, pack_label: r.pack_label,
    }));
    if (rpcLines.length) {
      const { data: res, error: rpcErr } = await supabase.rpc('stock_receive', {
        p_location_id: locationId, p_source_type: 'purchase_order', p_source_id: String(poId), p_lines: rpcLines,
        p_area_id: landIn || null, p_notes: null,
      });
      if (!rpcErr && res?.ok === false) return { error: new Error(res?.error || 'The receive was refused. Nothing was received.') };
      if (rpcErr && isMissingFunctionError(rpcErr)) return { error: new Error(`Nothing was received. ${NEEDS_UPDATE}`) };
      if (rpcErr) return { error: new Error(`Nothing was received: ${rpcErr.message || rpcErr}`) };
    }
    // nothing to bring in (every line shorted): only the order lines change
  }
  const ratesById = receipts ? await fetchTaxRateMap(locationId) : null;
  const shorted = [];
  let acceptedSubtotal = 0, acceptedTax = 0;
  for (const l of lines) {
    const item = map[l.inventory_item_id];
    if (!item) continue;
    const r = byLine ? byLine[String(l.id)] : null;
    const ordered = Number(l.qty_packs);
    // Full receive: everything outstanding. Line receive: exactly what staff counted in.
    const accepted = byLine ? Math.max(0, Number(r?.qtyPacks ?? 0)) : (ordered - Number(l.qty_received));
    const price = byLine && r?.unitPrice != null && r.unitPrice !== '' ? Number(r.unitPrice) : Number(l.unit_price);
    let baseContentPerPack;
    try { baseContentPerPack = convert(Number(l.pack_qty) * Number(l.inner_qty), l.inner_unit, item.baseUnit, { itemConversions: item.conversions }); }
    catch { continue; }
    if (!(baseContentPerPack > 0)) continue;
    if (byLine) {
      const rate = Number(ratesById[l.purchase_tax_rate_id] || 0);
      const netLine = accepted * price;
      const lineTax = Math.round(netLine * rate * 100) / 100;
      acceptedSubtotal += netLine; acceptedTax += lineTax;
      await supabase.from('po_lines').update({ qty_received: accepted, unit_price: price, line_tax: lineTax })
        .eq('location_id', locationId).eq('id', l.id);
      if (accepted < ordered) {
        shorted.push({
          inventoryItemId: l.inventory_item_id, supplierProductId: l.supplier_product_id,
          description: l.description, qtyPacks: ordered - accepted, packQty: Number(l.pack_qty),
          innerQty: Number(l.inner_qty), innerUnit: l.inner_unit, unitPrice: price,
          purchaseTaxRateId: l.purchase_tax_rate_id || null,
        });
      }
    } else {
      await supabase.from('po_lines').update({ qty_received: ordered }).eq('location_id', locationId).eq('id', l.id);
    }
  }
  const patch = { status: 'RECEIVED', received_at: nowIso(), updated_at: nowIso() };
  if (byLine) { patch.subtotal = Math.round(acceptedSubtotal * 100) / 100; patch.tax = Math.round(acceptedTax * 100) / 100; }
  await supabase.from('purchase_orders').update(patch).eq('location_id', locationId).eq('id', poId);
  // Balance PO for whatever the supplier shorted — born SENT so it counts as on-order.
  let balancePoId = null;
  if (shorted.length && poRow) {
    const { data: bal } = await savePurchaseOrder({
      supplierId: poRow.supplier_id, status: 'SENT',
      reference: `${poRow.reference || 'PO'} balance`, expectedDate: null,
      notes: `Balance of shorted lines from ${poRow.reference || poId}`,
    }, shorted, locationId);
    balancePoId = bal?.id || null;
  }
  return { error: null, data: { balancePoId, shortedCount: shorted.length } };
};

/**
 * Create purchase orders from an order-pad basket, split by supplier (one PO per
 * supplier). lines: [{ supplierId, inventoryItemId, description, qtyPacks, packQty,
 * innerQty, innerUnit, unitPrice }]. Returns { data: { created }, error }.
 * opts.expectedDateBySupplier: { [supplierId]: 'YYYY-MM-DD' } — the delivery date each
 * order is born with (v5.11.64: before this every pad order had no expected date at all).
 */
export const createOrdersFromBasket = async (lines, status = 'DRAFT', locationId = null, { expectedDateBySupplier = null } = {}) => {
  if (isMock || !supabase) return { data: { created: 0 }, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const bySupplier = {};
  for (const l of lines) {
    if (!l.supplierId || !(Number(l.qtyPacks) > 0)) continue;
    (bySupplier[l.supplierId] ??= []).push(l);
  }
  let created = 0;
  const poIds = [];   // v5.5.922: callers need the ids to send each order on to its supplier
  const supplierIds = [];
  for (const [supplierId, group] of Object.entries(bySupplier)) {
    const expectedDate = expectedDateBySupplier?.[supplierId] || null;
    const { data: po, error } = await savePurchaseOrder({ supplierId, status, expectedDate }, group, locationId);
    if (!error) { created++; if (po?.id) { poIds.push(po.id); supplierIds.push(supplierId); } }
  }
  return { data: { created, poIds, supplierIds }, error: null };
};

/**
 * Attach a supplier invoice image to a PO — record only, NEVER a stock posting.
 * The PO receive is the single stock writer for PO-linked deliveries; the standalone
 * Invoices scan→post flow posts its own `inv:` receipts and using both for one delivery
 * double-counts the stock. This writes supplier_invoices { po_id, status: 'REVIEW' } so
 * the paperwork lives on the order without touching the ledger.
 */
export const attachInvoiceToPO = async (poId, file, { supplierId = null, total = null } = {}, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  if (!file) return { data: null, error: new Error('No file') };
  const ext = (file.name?.split('.').pop() || 'jpg').toLowerCase().replace('jpeg', 'jpg');
  const safeExt = ['jpg', 'png', 'webp', 'pdf'].includes(ext) ? ext : 'jpg';
  const path = `${locationId}/po/${poId}/${Date.now()}.${safeExt}`;
  const { error: upErr } = await supabase.storage.from('invoice-scans').upload(path, file, {
    upsert: false, contentType: file.type || 'image/jpeg', cacheControl: '3600',
  });
  if (upErr) return { data: null, error: upErr };
  const { data, error } = await supabase.from('supplier_invoices').insert({
    location_id: locationId, po_id: poId, supplier_id: supplierId,
    image_path: path, status: 'REVIEW', total: total == null ? null : Number(total),
  }).select().maybeSingle();
  return { data, error };
};

/** Invoices already attached to a PO (paperwork listing on the PO screen). */
export const fetchPOInvoices = async (poId, locationId = null) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  const { data, error } = await supabase.from('supplier_invoices').select('id,image_path,total,status,created_at')
    .eq('location_id', locationId).eq('po_id', poId).order('created_at', { ascending: false });
  return { data: data || [], error };
};

// ── Invoices (scan → review → post) ───────────────────────────────────────────
const invFromRow = (r) => ({
  id: r.id, locationId: r.location_id, supplierId: r.supplier_id, invoiceNumber: r.invoice_number,
  invoiceDate: r.invoice_date, status: r.status, subtotal: r.subtotal, tax: r.tax, total: r.total,
  ocrConfidence: r.ocr_confidence, postedAt: r.posted_at, createdAt: r.created_at,
});

export const fetchInvoices = async (locationId = null, limit = 100) => {
  if (isMock || !supabase) return { data: [], error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: [], error: null };
  const { data, error } = await supabase.from('supplier_invoices').select('*')
    .eq('location_id', locationId)
    // v5.5.923: PO-attached paperwork rows (status REVIEW, no lines/total) belong on the PO
    // screen, not in the posted-invoices history — and absolutely not one click from Xero.
    .eq('status', 'POSTED').order('created_at', { ascending: false }).limit(limit);
  return { data: (data || []).map(invFromRow), error };
};

/**
 * Send an invoice image to the Claude-vision OCR endpoint. Returns parsed JSON.
 * v5.11.82 (multi site stock Drop 0): the endpoint checks who is asking. The call sends this
 * session's access token (Authorization: Bearer) and the venue it scans for; the server refuses a
 * request with no sign in, and a venue the login does not reach.
 */
export const scanInvoice = async (imageBase64, mediaType, locationId = null) => {
  try {
    const loc = await ensureLoc(locationId).catch(() => null);
    let token = null;
    if (!isMock && supabase) {
      try { token = (await supabase.auth.getSession())?.data?.session?.access_token || null; } catch { token = null; }
    }
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch('/api/stock-invoice-scan', {
      method: 'POST', headers,
      body: JSON.stringify({ image: imageBase64, media_type: mediaType || 'image/jpeg', location_id: loc || null }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) return { error: j.error || `Scan failed (${res.status})` };
    return { data: j };
  } catch (e) { return { error: e.message }; }
};

/**
 * Post a reviewed invoice: write the invoice + lines, and for each matched line
 * post a PURCHASE_RECEIPT + update cost. lines: [{matchedItemId, description, qty,
 * unit, unitPrice, lineTotal, flags}]. Returns { data: invoice, error }.
 */
export const postInvoice = async (header, lines, locationId = null, { areaId = null } = {}) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const landIn = await landingArea(locationId, areaId);
  // v5.11.79: the invoice, its lines and its receipts in ONE database call (stock_post_invoice).
  {
    const ratesById = await fetchTaxRateMap(locationId);
    const map = await itemMap(locationId, lines.map(l => l.matchedItemId));
    const matchedIds = [...new Set(lines.map(l => l.matchedItemId).filter(Boolean))];
    // the supplier pack each matched line was bought in (preferred first), for the price paid report
    const spByItem = {};
    if (header.supplierId && matchedIds.length) {
      // v5.11.82 (Drop 0): never an archived supplier price
      const { data: sps } = await liveOrAll((live) => {
        let q = supabase.from('supplier_products').select('id, inventory_item_id, pack_qty, inner_qty, inner_unit, is_preferred')
          .eq('location_id', locationId).eq('supplier_id', header.supplierId).in('inventory_item_id', matchedIds);
        if (live) q = q.is('archived_at', null);
        return q.order('is_preferred', { ascending: false }).order('created_at').order('id');
      });
      (sps || []).forEach((sp) => { if (!spByItem[sp.inventory_item_id]) spByItem[sp.inventory_item_id] = sp; });
    }
    const rpcLines = [];
    const receipts = [];
    lines.forEach((l, i) => {
      const rate = Number(ratesById[l.purchaseTaxRateId] || 0);
      const raw = l.lineTotal != null ? Number(l.lineTotal) : (Number(l.qty) * Number(l.unitPrice));
      const netLine = purchaseNet(raw, l.priceIncludesTax === true, rate) ?? 0;
      const sp = l.matchedItemId ? spByItem[l.matchedItemId] : null;
      rpcLines.push({
        matched_item_id: l.matchedItemId || null, description: l.description || null, qty: Number(l.qty) || 0, unit: l.unit || 'each',
        unit_price: Number(l.unitPrice) || 0, line_total: Math.round(netLine * 100) / 100, purchase_tax_rate_id: l.purchaseTaxRateId || null,
        line_tax: Math.round(netLine * rate * 100) / 100, flags: l.flags || [], supplier_product_id: sp?.id || null,
      });
      const item = map[l.matchedItemId];
      if (!item || !(Number(l.qty) > 0)) return;
      let qtyBase;
      try { qtyBase = convert(Number(l.qty), l.unit || item.baseUnit, item.baseUnit, { itemConversions: item.conversions }); } catch { return; }
      if (!(qtyBase > 0)) return;
      receipts.push({
        line_index: i, item_id: l.matchedItemId, qty_base: qtyBase, unit_cost: netLine > 0 ? netLine / qtyBase : 0,
        supplier_product_id: sp?.id || null, pack_price: Number(l.qty) > 0 && netLine > 0 ? Math.round((netLine / Number(l.qty)) * 10000) / 10000 : null,
        pack_label: (sp ? packLabel(sp) : null) || l.unit || null,
      });
    });
    const { data: res, error: rpcErr } = await supabase.rpc('stock_post_invoice', {
      p_location_id: locationId,
      p_invoice: {
        // v5.11.79: the screen's own id for this invoice (made once per scan): a retry is answered
        // duplicate, so an invoice with no number never posts twice
        client_id: header.clientId || null,
        supplier_id: header.supplierId || null, invoice_number: header.invoiceNumber || null, invoice_date: header.invoiceDate || null,
        ocr_confidence: header.ocrConfidence ?? null, subtotal: header.subtotal ?? null, tax: header.tax ?? null, total: header.total ?? null,
        raw_json: header.rawJson || null, image_path: header.imagePath || null, po_id: header.poId || null,
      },
      p_lines: rpcLines, p_receipts: receipts, p_area_id: landIn || null,
    });
    if (rpcErr && isMissingFunctionError(rpcErr)) return { data: null, error: new Error(`Nothing was posted. ${NEEDS_UPDATE}`) };
    const outcome = invoiceOutcome(res, rpcErr, receipts.length);
    if (!outcome.ok) return { data: null, error: new Error(outcome.text), code: outcome.code || null };
    return { data: res?.invoice_id ? { id: res.invoice_id } : null, error: null, stock: res?.stock !== false, text: outcome.text };
  }
};
