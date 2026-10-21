/**
 * Suppliers (Purchasing > Suppliers): the router (multi site stock Drop 1, contract 3.4).
 *
 *   scope not loaded yet  the Loading line
 *   one site company      SuppliersSplit: today's screen, field for field and word for word
 *                         (src/lib/stock/oneSiteIdentitySuppliers.test.js proves it)
 *   a supplier open       SupplierPage (Details, Sites, Order rules, Items, Changes)
 *   otherwise             SupplierList: the one company list for the sites in the picker
 */

import { useEffect, useState } from 'react';
import { useStockScope } from '../StockScope';
import SuppliersSplit from './stock/suppliers/SuppliersSplit';
import SupplierList from './stock/suppliers/SupplierList';
import SupplierPage from './stock/suppliers/SupplierPage';

/**
 * Another screen asked for one supplier (an item's Suppliers tab, through go('suppliers', { open })):
 * it is taken once and opened, so a later visit starts on the list. Multi site companies only.
 */
function OpenOnArrival({ take, onOpen }) {
  useEffect(() => { const o = take?.('suppliers'); if (o?.id) onOpen(o); }, [take, onOpen]);
  return <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>;
}

export default function Suppliers({ siteId = null } = {}) {
  const sc = useStockScope();
  const [open, setOpen] = useState(null); // { id, tab }
  if (!sc.ready) return <div style={{ padding: 16, color: 'var(--t3)', fontSize: 13 }}>Loading…</div>;
  if (!sc.multi) return <SuppliersSplit siteId={siteId} />;
  if (!open && sc.peekOpen?.('suppliers')?.id) return <OpenOnArrival take={sc.takeOpen} onOpen={setOpen} />;
  if (open) return <SupplierPage supplierId={open.id} startTab={open.tab || 'sites'} onBack={() => setOpen(null)} />;
  return <SupplierList onOpen={(id, opts = {}) => setOpen({ id, ...opts })} />;
}
