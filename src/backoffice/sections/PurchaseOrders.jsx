/**
 * PurchaseOrders: the Purchasing > Orders router (multi site stock Drop 3, v5.11.96, contract 3.2).
 *
 * A one site company gets today's screen (purchasing/PurchaseOrdersSite.jsx, moved there whole).
 * A multi site company gets the company Orders list with the site column and the approvals waiting
 * on top (purchasing/OrdersCompany.jsx). Loading while the scope loads.
 */

import { useStockScope } from '../StockScope';
import PurchaseOrdersSite from './purchasing/PurchaseOrdersSite';
import OrdersCompany from './purchasing/OrdersCompany';

export default function PurchaseOrders({ orgCtx = null, siteId = null } = {}) {
  const sc = useStockScope();
  if (!sc.ready) return <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>;
  if (!sc.multi) return <PurchaseOrdersSite siteId={siteId} />;
  return <OrdersCompany orgCtx={orgCtx} />;
}
