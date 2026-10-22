// src/backoffice/sections/produce/KitchenIngredients.jsx
//
// MULTI SITE STOCK Drop 3 (map 4.7, contract 3.4 and 4.4): the raw ingredients the day's plan needs at
// the central kitchen (stock_kitchen_ingredients: each recipe's lines scaled by Make, nested made items
// followed down, less the kitchen's own stock), with the kitchen's preferred supplier pack. "Order
// these" makes supplier orders AT THE KITCHEN exactly as the Order pad does: createOrdersFromBasket
// (DRAFT), then stock_po_submit for each order (approval limit, maximum, delivery fee), then po-send
// for each order the database says to send. Nothing moves a stock number until the goods arrive.

import { useEffect, useState } from 'react';
import { useStore } from '../../../store';
import { supabase } from '../../../lib/supabase';
import { stockApi } from '../../../lib/stock/stockApi';
import { createOrdersFromBasket, fnErrorText } from '../../../lib/stock/purchasing';
import { ingredientBasket, basketWords, q3 } from '../../../lib/stock/kitchenRules';
import { Btn, Notice, TableWrap, Th, Td, ErrorLine, EmptyLine, ui } from '../stock/stockUi';

const chunk = (list, n = 100) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

export default function KitchenIngredients({ kitchenId, day }) {
  const showToast = useStore((s) => s.showToast);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    stockApi.kitchenIngredients(kitchenId, day).then((r) => {
      if (!live) return;
      if (r.error) { setError(r.error); setRows([]); return; }
      setError(null);
      setRows(Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.rows) ? r.data.rows : []));
    });
    return () => { live = false; };
  }, [kitchenId, day]);

  const short = (rows || []).filter((r) => Number(r.short_base) > 0);

  const orderThese = async () => {
    if (!supabase) return;
    setBusy(true);
    // the kitchen's own supplier packs and VAT rates, for the order lines' pack and net price
    const spIds = [...new Set(short.map((r) => r.supplier_product_id).filter(Boolean))];
    const packsById = {};
    for (const ids of chunk(spIds)) {
      const { data } = await supabase.from('supplier_products')
        .select('id, pack_qty, inner_qty, inner_unit, pack_price, price_includes_tax, purchase_tax_rate_id').eq('location_id', kitchenId).in('id', ids);
      for (const sp of data || []) packsById[sp.id] = sp;
    }
    const { data: rates } = await supabase.from('tax_rates').select('id, rate').eq('location_id', kitchenId);
    const ratesById = Object.fromEntries((rates || []).map((t) => [t.id, Number(t.rate) || 0]));
    const { lines, skipped } = ingredientBasket(short, packsById, ratesById);
    if (!lines.length) { setBusy(false); showToast?.(skipped.length ? `No supplier pack for: ${skipped.join(', ')}. Add one under Suppliers.` : 'Nothing to order.', 'error'); return; }
    const { data, error: mkErr } = await createOrdersFromBasket(lines, 'DRAFT', kitchenId);
    if (mkErr) { setBusy(false); showToast?.(mkErr.message, 'error'); return; }
    let sent = 0; let waiting = 0; const failed = [];
    for (const poId of data?.poIds || []) {
      const sub = await stockApi.submitOrder(poId);
      if (sub.error) { failed.push(sub.error.message); continue; }
      if (sub.data?.needs_approval) { waiting++; continue; }
      if (sub.data?.internal) { sent++; continue; }
      const { data: res, error: sendErr } = await supabase.functions.invoke('po-send', { body: { po_id: poId, location_id: kitchenId } });
      if (!sendErr && res?.ok) sent++;
      else failed.push(await fnErrorText(res, sendErr, 'the email could not be sent'));
    }
    setBusy(false);
    const words = [`${sent} order${sent === 1 ? '' : 's'} sent`, waiting ? `${waiting} waiting for approval` : '', failed.length ? `${failed.length} not sent: ${failed.join(' ')}` : '', skipped.length ? `no supplier pack for ${skipped.join(', ')}` : '']
      .filter(Boolean).join('. ');
    showToast?.(`${words}.`, failed.length ? 'error' : 'success');
  };

  if (rows === null) return <div style={{ padding: 16, color: 'var(--t3)' }}>Loading…</div>;
  return (
    <div>
      <Notice tone="info">Raw ingredients for the plan, less the kitchen's stock. Order these makes supplier orders at the kitchen.</Notice>
      <ErrorLine error={error} />
      {!error && rows.length === 0 && <EmptyLine>Nothing to make, so no ingredients are needed.</EmptyLine>}
      {rows.length > 0 && (
        <>
          <TableWrap minWidth={620}>
            <thead><tr><Th>Ingredient</Th><Th right>Needed</Th><Th right>Kitchen holds</Th><Th right>Short</Th><Th right>Packs to order</Th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.inventory_item_id}>
                  <Td>{r.name}</Td><Td num>{q3(r.need_base)}</Td><Td num>{q3(r.on_hand)}</Td>
                  <Td num strong={Number(r.short_base) > 0}>{q3(r.short_base)}</Td>
                  <Td num grey={!r.supplier_product_id}>{r.supplier_product_id ? Math.ceil(Number(r.packs) || 0) : 'No supplier pack'}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <div style={{ ...ui.row, marginTop: 12 }}>
            <Btn kind="primary" disabled={busy || !short.length} onClick={orderThese}>{busy ? 'Ordering…' : 'Order these'}</Btn>
            <span style={ui.sub}>{short.length ? basketWords(short.filter((r) => r.supplier_id).map((r) => ({ supplierId: r.supplier_id }))) : 'The kitchen holds enough.'}</span>
          </div>
        </>
      )}
    </div>
  );
}
