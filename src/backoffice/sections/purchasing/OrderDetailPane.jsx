// purchasing/OrderDetailPane.jsx: one order of the company Orders list (multi site stock Drop 3,
// v5.11.96, contract 3.2). Everything acts on the order's own site (order.location_id): the lines,
// the approval with who raised it, Approve, Send back, Send anyway (head office, 30 minutes before the
// order by time), Cancel, Resend to supplier, and for a central kitchen order its transfer.

import { useEffect, useState } from 'react';
import { useStore } from '../../../store';
import { supabase } from '../../../lib/supabase';
import { useStockScope } from '../../StockScope';
import { stockApi } from '../../../lib/stock/stockApi';
import { dayWords, moneyWords } from '../../../lib/stock/purchasingRules';
import { orderStatusPill, approvalPill, sendBackToast, atWords, PILLS } from '../../../lib/stock/purchasingWords';
import { Sheet, Btn, Pill, TableWrap, Th, Td, ErrorLine, EmptyLine, useConfirm, ui } from '../stock/stockUi';
import { sendOrderEmail } from './orderActions';

export default function OrderDetailPane({ order, onChanged, onClose = null, tz = null }) {
  const sc = useStockScope();
  const showToast = useStore((s) => s.showToast);
  const [lines, setLines] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirm, dialog] = useConfirm();
  useEffect(() => {
    let on = true;
    if (!supabase || !order?.id) return undefined;
    supabase.from('po_lines').select('id, description, qty_packs, pack_qty, inner_qty, inner_unit, unit_price, qty_received, sort_order')
      .eq('location_id', order.location_id).eq('po_id', order.id).order('sort_order').limit(300)
      .then(({ data, error: e }) => { if (on) { setLines(data || []); setError(e || null); } });
    return () => { on = false; };
  }, [order?.id, order?.location_id]);
  if (!order) return null;
  const ap = order.approval || null;
  const editor = sc.canEditCompany('purchasing');
  const decide = async (decision) => {
    if (decision === 'cancel' && !(await confirm({ title: 'Cancel this order?', words: `${order.reference || 'This order'} for ${order.site_name || sc.siteName(order.location_id)} will not be sent.`, yes: 'Cancel order', danger: true }))) return;
    setBusy(true);
    const r = await stockApi.decideOrder(order.id, decision);
    if (r.error) { setBusy(false); showToast?.(r.error.message, 'error'); return; }
    if (r.data?.send) {
      const s = await sendOrderEmail(order.id, order.location_id);
      showToast?.(s.error ? `Approved. The email did not send: ${s.error.message}. It is tried again in 2 minutes, or open the order and press Send to supplier.` : 'Approved and sent to the supplier.', s.error ? 'error' : 'success');
    } else if (decision === 'send_back') showToast?.(sendBackToast(ap?.raised_by_name), 'success');
    else if (decision === 'cancel') showToast?.('Order cancelled.', 'success');
    setBusy(false);
    onChanged?.();
  };
  const resend = async () => {
    setBusy(true);
    const s = await sendOrderEmail(order.id, order.location_id);
    setBusy(false);
    showToast?.(s.error ? s.error.message : order.status === 'DRAFT' ? 'Sent to the supplier.' : 'Sent to the supplier again.', s.error ? 'error' : 'success');
    if (!s.error && order.status === 'DRAFT') onChanged?.();
  };
  const st = orderStatusPill(order.status);
  const apPill = ap ? approvalPill(ap.status) : null;
  const total = (Number(order.subtotal) || 0) + (Number(order.delivery_fee) || 0);
  return (
    <Sheet title={`${order.reference || 'Order'} · ${order.supplier_name || ''}`} sub={order.site_name || sc.siteName(order.location_id)} onClose={onClose || (() => onChanged?.(false))} width={640}
      footer={<>
        {ap?.status === 'waiting' && ap.can_decide && <Btn kind="primary" disabled={busy} onClick={() => decide('approve')}>Approve</Btn>}
        {ap?.status === 'waiting' && ap.can_decide && <Btn disabled={busy} onClick={() => decide('send_back')}>Send back</Btn>}
        {ap?.status === 'waiting' && editor && Number(ap.step) >= 2 && <Btn disabled={busy} onClick={() => decide('send_anyway')}>Send anyway</Btn>}
        {order.status === 'SENT' && !order.internal && <Btn disabled={busy} onClick={resend}>Resend to supplier</Btn>}
        {order.status === 'DRAFT' && !order.internal && ['approved', 'sent_anyway', 'sent_unapproved'].includes(ap?.status) && <Btn kind="primary" disabled={busy} onClick={resend}>Send to supplier</Btn>}
        {order.transfer_id && <Btn onClick={() => sc.go('stock-transfers', { open: { transferId: order.transfer_id } })}>Open the transfer</Btn>}
        <span style={{ marginLeft: 'auto' }} />
        {(order.status === 'DRAFT' || ap?.status === 'waiting') && <Btn kind="danger" disabled={busy} onClick={() => decide('cancel')}>Cancel order</Btn>}
      </>}>
      {dialog}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <Pill tone={st.tone}>{st.text}</Pill>
        {apPill && <Pill tone={apPill.tone}>{apPill.text}</Pill>}
        {order.internal && <Pill tone={PILLS.ourKitchen.tone}>{PILLS.ourKitchen.text}</Pill>}
        {order.expected_date && <span style={ui.sub}>Expected {dayWords(String(order.expected_date).slice(0, 10))}</span>}
      </div>
      {ap && (
        <div style={{ ...ui.sub, marginBottom: 12 }}>
          Raised by {ap.raised_by_name || 'a manager'}{ap.order_by_at ? `; order by ${atWords(ap.order_by_at, tz, { withDate: true })}` : ''}.
          {Number(ap.step) >= 1 ? ' Passed up to head office.' : ''}
        </div>
      )}
      <ErrorLine error={error} />
      {lines === null ? <EmptyLine>Loading…</EmptyLine> : !lines.length ? <EmptyLine>No lines.</EmptyLine> : (
        <TableWrap>
          <thead><tr><Th>Item</Th><Th right>Packs</Th><Th right>Received</Th><Th right>Price</Th><Th right>Line</Th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.id}>
                <Td>{l.description}</Td>
                <Td num>{Number(l.qty_packs)}</Td>
                <Td num grey>{Number(l.qty_received) || ''}</Td>
                <Td num>{moneyWords(l.unit_price)}</Td>
                <Td num>{moneyWords((Number(l.qty_packs) || 0) * (Number(l.unit_price) || 0))}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <div style={{ marginTop: 10, fontSize: 13, textAlign: 'right' }}>
        Goods {moneyWords(order.subtotal)}{Number(order.delivery_fee) > 0 ? ` + delivery ${moneyWords(order.delivery_fee)}` : ''} = <b>{moneyWords(total)}</b> ex VAT
      </div>
    </Sheet>
  );
}
