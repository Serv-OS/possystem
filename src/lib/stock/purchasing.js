/**
 * stock/purchasing.js — purchase orders, receiving, and supplier invoices.
 *
 * Receiving a PO or posting an invoice writes PURCHASE_RECEIPT movements to the
 * ledger (via post_stock_movement) and updates each item's moving-average cost
 * with a new effective-dated item_cost_history row. House pattern: loc-demo guard,
 * camelCase ↔ snake_case, idempotent receipts.
 */

import { supabase, isMock, getLocationId, getActiveLocationSync } from '../supabase';
import { convert } from './conversion.js';
import { movingAverageCost } from './costing.js';
import { postStockMovement, fetchTaxRateMap } from './data.js';
import { purchaseNet } from '../tax.js';

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
    supabase.from('inventory_items').select('id, base_unit, on_hand, current_cost, cost_method').eq('location_id', locationId).in('id', uniq),
    supabase.from('inventory_item_conversions').select('*').eq('location_id', locationId).in('inventory_item_id', uniq),
  ]);
  const convByItem = {};
  (convs || []).forEach((c) => { (convByItem[c.inventory_item_id] ??= []).push({ fromQty: Number(c.from_qty), fromUnit: c.from_unit, toQty: Number(c.to_qty), toUnit: c.to_unit }); });
  const m = {};
  (items || []).forEach((it) => {
    m[it.id] = {
      baseUnit: it.base_unit, conversions: convByItem[it.id] || [],
      onHand: Number(it.on_hand) || 0, currentCost: it.current_cost == null ? 0 : Number(it.current_cost),
      costMethod: it.cost_method || 'MOVING_AVG',
    };
  });
  return m;
}

/**
 * Apply one receipt to an item: post PURCHASE_RECEIPT (+qtyBase at unitCostPerBase)
 * and update moving-average cost. Idempotent on idemKey (skips cost update on dupe).
 */
async function applyReceipt(locationId, item, itemId, recvBase, unitCostPerBase, sourceType, sourceId, idemKey) {
  if (!(recvBase > 0)) return;
  // v5.5.726: a ZERO/missing unit cost must NOT re-cost the item. A manager-raised PO (or any
  // un-priced line) has no price until the invoice — zeroing current_cost corrupts COGS
  // (LAST_COST → 0) or dilutes the moving average toward 0. Value the movement at the item's KNOWN
  // current cost so stock valuation stays sensible, move the stock in, but leave current_cost alone;
  // the invoice / receiving price fills the real cost later.
  const priced = unitCostPerBase > 0;
  const movementCost = priced ? unitCostPerBase : (Number(item.currentCost) || 0);
  const res = await postStockMovement({
    inventoryItemId: itemId, qtyBase: recvBase, unitCost: movementCost, movementType: 'PURCHASE_RECEIPT',
    sourceType, sourceId, idempotencyKey: idemKey,
  }, locationId);
  if (res?.data?.duplicate) return; // already received — don't re-cost
  if (!priced) { item.onHand += recvBase; return; }   // stock in, cost untouched
  const newAvg = item.costMethod === 'LAST_COST'
    ? unitCostPerBase
    : movingAverageCost({ onHandQty: item.onHand, currentAvg: item.currentCost, receivedQty: recvBase, receivedUnitCost: unitCostPerBase });
  await supabase.from('item_cost_history').update({ effective_to: nowIso() })
    .eq('location_id', locationId).eq('inventory_item_id', itemId).is('effective_to', null);
  await supabase.from('item_cost_history').insert({
    location_id: locationId, inventory_item_id: itemId, base_unit_cost: newAvg, source: 'INVOICE', effective_from: nowIso(),
  });
  await supabase.from('inventory_items').update({ current_cost: newAvg, updated_at: nowIso() })
    .eq('location_id', locationId).eq('id', itemId);
  // keep the local snapshot current in case the same item appears twice in one receipt
  item.onHand += recvBase; item.currentCost = newAvg;
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
  const [{ data: pos, error }, { data: lines }] = await Promise.all([
    supabase.from('purchase_orders').select('*').eq('location_id', locationId).order('created_at', { ascending: false }).limit(limit),
    supabase.from('po_lines').select('*').eq('location_id', locationId).order('sort_order'),
  ]);
  if (error) return { data: [], error };
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
  const lineTaxes = keepLines.map((l) => {
    const net = (Number(l.qtyPacks) || 0) * (Number(l.unitPrice) || 0);
    const rate = Number(ratesById[l.purchaseTaxRateId] || 0);
    return Math.round(net * rate * 100) / 100;
  });
  const subtotal = keepLines.reduce((s, l) => s + (Number(l.qtyPacks) || 0) * (Number(l.unitPrice) || 0), 0);
  const tax = Math.round(lineTaxes.reduce((s, t) => s + t, 0) * 100) / 100;
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
  if (lrows.length) await supabase.from('po_lines').insert(lrows);
  return { data: poFromRow(data), error: null };
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
 * - One shared itemMap for the whole loop: applyReceipt mutates its item snapshot so
 *   the same item on two lines moving-averages correctly.
 * - The zero-price guard in applyReceipt stays: a line left at £0 moves stock at the
 *   item's known cost and does NOT re-cost it.
 */
export const receivePurchaseOrder = async (poId, locationId = null, receipts = null) => {
  if (isMock || !supabase) return { error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { error: new Error('No locationId') };
  const [{ data: lines }, { data: poRow }] = await Promise.all([
    supabase.from('po_lines').select('*').eq('location_id', locationId).eq('po_id', poId),
    supabase.from('purchase_orders').select('*').eq('location_id', locationId).eq('id', poId).maybeSingle(),
  ]);
  if (!lines?.length) return { error: new Error('No lines') };
  const byLine = receipts ? Object.fromEntries(receipts.map(r => [String(r.lineId), r])) : null;
  const map = await itemMap(locationId, lines.map(l => l.inventory_item_id));
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
    if (accepted > 0) {
      const recvBase = accepted * baseContentPerPack;
      const unitCostPerBase = price / baseContentPerPack;
      await applyReceipt(locationId, item, l.inventory_item_id, recvBase, unitCostPerBase, 'purchase_order', poId, `po:${poId}:${l.id}`);
    }
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
 */
export const createOrdersFromBasket = async (lines, status = 'DRAFT', locationId = null) => {
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
    const { data: po, error } = await savePurchaseOrder({ supplierId, status }, group, locationId);
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
    .eq('location_id', locationId).order('created_at', { ascending: false }).limit(limit);
  return { data: (data || []).map(invFromRow), error };
};

/** Send an invoice image to the Claude-vision OCR endpoint. Returns parsed JSON. */
export const scanInvoice = async (imageBase64, mediaType) => {
  try {
    const res = await fetch('/api/stock-invoice-scan', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: imageBase64, media_type: mediaType || 'image/jpeg' }),
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
export const postInvoice = async (header, lines, locationId = null) => {
  if (isMock || !supabase) return { data: null, error: null };
  locationId = await ensureLoc(locationId);
  if (!locationId) return { data: null, error: new Error('No locationId') };
  const { data: inv, error } = await supabase.from('supplier_invoices').insert({
    location_id: locationId, supplier_id: header.supplierId || null, invoice_number: header.invoiceNumber || null,
    invoice_date: header.invoiceDate || null, status: 'POSTED', ocr_confidence: header.ocrConfidence ?? null,
    subtotal: header.subtotal ?? null, tax: header.tax ?? null, total: header.total ?? null,
    raw_json: header.rawJson || null, image_path: header.imagePath || null, posted_at: nowIso(),
  }).select().maybeSingle();
  if (error || !inv) return { data: null, error: error || new Error('Invoice save failed') };

  const ratesById = await fetchTaxRateMap(locationId);
  const map = await itemMap(locationId, lines.map(l => l.matchedItemId));
  const lineRows = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const rate = Number(ratesById[l.purchaseTaxRateId] || 0);
    // Resolve the NET line total ONCE here: strip VAT only when the line is flagged inc-VAT.
    // Everything stored/costed downstream (line_total, unit cost, moving avg) is then NET.
    const raw = l.lineTotal != null ? Number(l.lineTotal) : (Number(l.qty) * Number(l.unitPrice));
    const netLine = purchaseNet(raw, l.priceIncludesTax === true, rate) ?? 0;
    const lineTax = Math.round(netLine * rate * 100) / 100;
    lineRows.push({
      location_id: locationId, invoice_id: inv.id, matched_item_id: l.matchedItemId || null,
      description: l.description || null, qty: Number(l.qty) || 0, unit: l.unit || 'each',
      unit_price: Number(l.unitPrice) || 0, line_total: Math.round(netLine * 100) / 100,
      purchase_tax_rate_id: l.purchaseTaxRateId || null, line_tax: lineTax,
      flags: l.flags || [], sort_order: i,
    });
    const item = map[l.matchedItemId];
    if (!item || !(Number(l.qty) > 0)) continue;
    let qtyBase;
    try { qtyBase = convert(Number(l.qty), l.unit || item.baseUnit, item.baseUnit, { itemConversions: item.conversions }); }
    catch { continue; }
    if (!(qtyBase > 0)) continue;
    const unitCostPerBase = netLine / qtyBase;
    await applyReceipt(locationId, item, l.matchedItemId, qtyBase, unitCostPerBase, 'supplier_invoice', inv.id, `inv:${inv.id}:${l.matchedItemId}:${i}`);
  }
  if (lineRows.length) await supabase.from('supplier_invoice_lines').insert(lineRows);
  return { data: invFromRow(inv), error: null };
};
