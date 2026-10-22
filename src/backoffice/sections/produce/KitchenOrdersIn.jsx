// src/backoffice/sections/produce/KitchenOrdersIn.jsx
//
// MULTI SITE STOCK Drop 3 (map 4.7, contract 3.4 and 4.4): every site's order placed with this central
// kitchen for one delivery day (stock_kitchen_orders_in, the one way kitchen staff read other sites'
// orders: only the orders placed with this kitchen, never the sites' other orders). Each order shows its
// lines, and its state: To pick, In transit (its transfer was sent), Received, Disputed.

import { useEffect, useState } from 'react';
import { stockApi } from '../../../lib/stock/stockApi';
import { ordersInStatus, q3 } from '../../../lib/stock/kitchenRules';
import { Pill, TableWrap, Th, Td, ErrorLine, EmptyLine, ui } from '../stock/stockUi';

const TONE = { 'To pick': 'warn', Picking: 'warn', 'In transit': 'blue', Received: 'good', Disputed: 'bad' };

export default function KitchenOrdersIn({ kitchenId, day }) {
  const [orders, setOrders] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let live = true;
    stockApi.kitchenOrdersIn(kitchenId, day).then((r) => {
      if (!live) return;
      if (r.error) { setError(r.error); setOrders([]); return; }
      setError(null);
      setOrders(Array.isArray(r.data) ? r.data : (Array.isArray(r.data?.rows) ? r.data.rows : []));
    });
    return () => { live = false; };
  }, [kitchenId, day]);

  if (orders === null) return <div style={{ padding: 16, color: 'var(--t3)' }}>Loading…</div>;
  return (
    <div>
      <div style={{ ...ui.sub, marginBottom: 10 }}>Only orders placed with this kitchen. Every site's order for a delivery day in one list.</div>
      <ErrorLine error={error} />
      {!error && orders.length === 0 && <EmptyLine>No site has ordered from this kitchen for this day.</EmptyLine>}
      {orders.map((o) => {
        const status = ordersInStatus(o);
        return (
          <div key={o.po_id} style={{ ...ui.card, marginBottom: 12 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
              <b style={{ color: 'var(--t1)' }}>{o.site_name || 'Site'}</b>
              {o.reference && <span style={ui.sub}>{o.reference}</span>}
              <Pill tone={TONE[status] || 'neutral'}>{status}</Pill>
            </div>
            <TableWrap minWidth={420}>
              <thead><tr><Th>Item</Th><Th>Pack</Th><Th right>Packs</Th></tr></thead>
              <tbody>
                {(o.lines || []).map((l) => (
                  <tr key={l.po_line_id}><Td>{l.name}</Td><Td grey>{l.pack_label || ''}</Td><Td num>{q3(l.qty_packs)}</Td></tr>
                ))}
              </tbody>
            </TableWrap>
          </div>
        );
      })}
    </div>
  );
}
