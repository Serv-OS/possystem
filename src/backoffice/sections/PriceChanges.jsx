/**
 * PriceChanges: the Purchasing > Price changes router (multi site stock Drop 3, v5.11.96, contract
 * 3.2).
 *
 * A one site company gets today's screen (purchasing/PriceChangesSite.jsx, moved there whole). A
 * multi site company gets Supplier prices and Cost per unit (purchasing/PriceChangesCompany.jsx).
 * Loading while the scope loads.
 */

import { useStockScope } from '../StockScope';
import PriceChangesSite from './purchasing/PriceChangesSite';
import PriceChangesCompany from './purchasing/PriceChangesCompany';

export default function PriceChanges({ orgCtx = null, siteId = null } = {}) {
  const sc = useStockScope();
  if (!sc.ready) return <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>;
  if (!sc.multi) return <PriceChangesSite siteId={siteId} />;
  return <PriceChangesCompany orgCtx={orgCtx} />;
}
