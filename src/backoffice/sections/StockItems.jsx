/**
 * Inventory > Stock items (multi site stock Drop 1): which screen a company sees.
 *
 *  - One site company (the scope says not multi): today's screen, unchanged, in
 *    stock/items/StockItemsSplit.jsx (the list on the left, the tabbed editor on the right).
 *  - Multi site company: the company list (stock/items/CompanyItemList.jsx: All sites, a group,
 *    or one site) and, once an item is opened, its page (stock/items/ItemPage.jsx).
 *
 * While the site scope is still loading the screen says Loading… (the scope answers within 6 s, or
 * falls back to one site, so a one site company always ends on today's screen).
 */

import { useEffect, useState } from 'react';
import { useStockScope } from '../StockScope';
import StockItemsSplit from './stock/items/StockItemsSplit';
import CompanyItemList from './stock/items/CompanyItemList';
import ItemPage from './stock/items/ItemPage';

/**
 * Another screen asked for one item (a supplier's Items tab, through go('stock-items', { open })):
 * it is taken once and opened, so a later visit starts on the list. Multi site companies only.
 */
function OpenOnArrival({ take, onOpen }) {
  useEffect(() => { const o = take?.('stock-items'); if (o?.itemId) onOpen(o); }, [take, onOpen]);
  return <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>;
}

export default function StockItems({ orgCtx = null, siteId = null }) {
  const sc = useStockScope();
  const [open, setOpen] = useState(null); // { itemId, tab, siteId }
  if (!sc.ready) return <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>;
  if (!sc.multi) return <StockItemsSplit orgCtx={orgCtx} siteId={siteId} />;
  if (!open && sc.peekOpen?.('stock-items')?.itemId) return <OpenOnArrival take={sc.takeOpen} onOpen={setOpen} />;
  if (open) return <ItemPage itemId={open.itemId} startTab={open.tab || 'sites'} focusSiteId={open.siteId || null} orgCtx={orgCtx} onBack={() => setOpen(null)} onOpenItem={(itemId, opts = {}) => setOpen({ itemId, ...opts })} />;
  return <CompanyItemList orgCtx={orgCtx} onOpen={(itemId, opts = {}) => setOpen({ itemId, ...opts })} />;
}
